// Copyright 2026 by Moshix
/**
 * Sound CPU, ROM gp2-1.4b ($E000-$FFFF): every routine of the chip.
 *
 * The sound CPU is a small sequencer for the 8-voice 15XX WSG. The main
 * CPU asks for sound n by writing to $0040+n (main $6040+n); once a frame
 * the IRQ copies a shadow of the voice registers ($0080) into the WSG and
 * plays every requested sound one step (reference/gaplus-sound.asm).
 *
 * CYCLE-EXACT. Unlike most of the port, this module counts the 6809's
 * cycles: every instruction charges its MAME cycle count to the sound CPU
 * (`s.charge(n)`, with the instructions quoted), and the code yields SYNC
 * right before every instruction whose timing another CPU can observe:
 *
 *   - every access to $0040-$007F (the request and active bytes, which
 *     the main CPU also reads and writes: `INC $6056`, `LDA $6040`,
 *     the clear loops at main $D8D2/$DF19);
 *   - every write to an IRQ latch and every ANDCC (the scheduler reads
 *     them at vblank);
 *   - any store once the clock is past the next vblank (frameDue: the
 *     boot's long checksum and clear stretches).
 *
 * The scheduler (src/game/scheduler.js) runs the CPUs in MAME's 256-cycle
 * slices, main then sub then sound, and resumes a thread only while its
 * clock is inside the slice; so each of these instructions happens in the
 * same slice, relative to the main CPU's accesses, as on the board. The
 * rest of the work (the voice shadow, the channel blocks at $0100-$03FF,
 * the WSG registers) is private to this CPU and runs between the yields.
 * The counts are checked against the oracle's core instruction by
 * instruction in test/oracle/sound-gp2_1.test.mjs.
 *
 * JUMP TABLES. `envelope_ops` ($E29F) and `stream_ops` ($E376) are read
 * from ROM and dispatched through SOUND_AT, as `jmp [a,y]` does. Their
 * targets are fragments that end in a jump back into the caller's code,
 * so they share a small continuation protocol (see {@link ENV_WRITE} and
 * {@link STREAM_NEXT}).
 *
 * NON-LOCAL EXIT. `op_end` ($E3BF) ends a sound with `PULS X,U / RTS`,
 * which drops next_note's saved U and returns straight from play_sound to
 * irq_sound. The port returns an `end` flag up the call chain instead.
 * If a sound's stream were to end while play_sound is still building its
 * channel blocks (the `JSR next_note` at $E26B), the same RTS would pop
 * the X that play_sound pushed and jump into RAM; no stream in the ROM
 * does that, and the port throws there rather than invent a behaviour.
 */

import { SOUND, SOUND_AT, soundAt } from './routines.js';
import { soundWord } from '../romdata.js';
import { disp8 } from '../m6809ops.js';
import { call } from '../call.js';
import { SYNC, idle, frameDue } from '../scheduler.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {import('../../machine/machine.js').CpuView} CpuView */
/** @typedef {Generator<unknown, unknown, unknown>} Thread */

/** $0040 snd_request: main writes non-zero to request sound n. */
const SND_REQUEST = 0x0040;
/** $0060 snd_active: sound n has been started (its blocks built). */
const SND_ACTIVE = 0x0060;
/** $0080 wsg_shadow: vol, freq lo, freq mid, freq hi|wave per voice. */
const WSG_SHADOW = 0x0080;
/** $00A0 snd_tempo: tempo per sound (length multiplier). */
const SND_TEMPO = 0x00a0;
/** $00C0 snd_current: the sound being played. */
const SND_CURRENT = 0x00c0;
/** $00C1 snd_voice: the WSG voice being played. */
const SND_VOICE = 0x00c1;
/** $00C2 snd_irq_done: set to 1 at the end of every IRQ. */
const SND_IRQ_DONE = 0x00c2;
/** $00C3 snd_temp: scratch byte. */
const SND_TEMP = 0x00c3;
/** $0380 snd_rom_error: 1 = the ROM checksum failed. */
const SND_ROM_ERROR = 0x0380;

/** $E3D5 sound_voice: first WSG voice of each sound. */
const SOUND_VOICE = 0xe3d5;
/** $E3EF tempo_init: 32 tempo bytes copied to $00A0 at boot. */
const TEMPO_INIT = 0xe3ef;
/** $E409 sound_channels: channel block address of each sound. */
const SOUND_CHANNELS = 0xe409;
/** $E43D sound_headers: header of each sound. */
const SOUND_HEADERS = 0xe43d;
/** $E5D2 envelopes: pointer to each volume envelope. */
const ENVELOPES = 0xe5d2;
/** $E6D2 freq_tables: pointer to each frequency table. */
const FREQ_TABLES = 0xe6d2;
/** $E29F envelope_ops: jump table of envelope commands $10-$16. */
const ENVELOPE_OPS = 0xe29f;
/** $E376 stream_ops: jump table of stream commands $F0-$F7. */
const STREAM_OPS = 0xe376;

/**
 * Sounds that are retriggered rather than held: a request clears the
 * request and active bytes (restart), and the sound then runs on from
 * its active byte until op_end ($E08A, $E0EA, $E11D-$E171). All others
 * play while the request byte stays set.
 */
const RETRIGGERED = new Set([1, 7, 10, 11, 12, 13, 14]);

/** Number of sounds the IRQ polls ($0040-$0059). */
const SOUND_COUNT = 26;

// --------------------------------------------------------- continuations

/**
 * Envelope-op continuation: `BRA write_shadow` with A = the level.
 * @type {0}
 */
export const ENV_WRITE = 0;
/** Envelope-op continuation: `BRA $E2DA` (INC $A,X, then write). @type {1} */
export const ENV_INC_WRITE = 1;
/** Envelope-op continuation: `BRA envelope_step` (read again). @type {2} */
export const ENV_STEP = 2;

/**
 * What an envelope op returns: where play_voice continues, and A.
 * @typedef {{ cont: 0|1|2, a: number }} EnvResult
 */

/** Stream-op continuation: `STU ,X / JMP $E30B` (next stream byte). @type {0} */
export const STREAM_NEXT = 0;
/** Stream-op continuation: op_end ran; return to irq_sound. @type {1} */
export const STREAM_END = 1;

/**
 * What a stream op returns: where next_note continues, and U.
 * @typedef {{ cont: 0|1, u: number }} StreamResult
 */

// ------------------------------------------------------------- helpers

/**
 * `CLR <addr` on the sound CPU: read-modify-write (the MC6809E reads
 * the operand first), then store 0.
 * @param {CpuView} s @param {number} addr
 */
function clr(s, addr) {
  s.peek(addr);
  s.poke(addr, 0);
}

// ----------------------------------------------------------- reset_sound

/**
 * Power-on of the sound CPU (released by the main CPU's SRESET write).
 * Masks the IRQ latch, waits for the main CPU's $11 in $0040, checksums
 * $E000-$FFFF ($0380 = 1 on a non-zero sum), answers $22 in $0040,
 * clears $0000-$02FF (which clears the $22 again ~700 cycles later: the
 * main CPU must have seen it by then), copies the tempo bytes to $00A0,
 * enables the IRQ and idles in `BRA *` forever.
 *
 * Every poll pass of the $11 wait is 14 cycles and yields, so the $22
 * appears on the same cycle as on the board.
 * @see gaplus-sound.asm $E000
 * @param {Machine} m
 * @returns {Thread}
 */
export function* reset_sound(m) {
  const s = m.sound;
  // A is whatever it was before the reset: only the address matters.
  let a = 0;
  // $E000: sta $6000 -- IRQ latch off
  yield SYNC;
  s.poke(0x6000, a);
  s.charge(5);
  // $E003: lda <$40 / sta $3000 / cmpa #$11 / bne $E003 -- 14 cycles a
  // pass; the main CPU's $11 is seen by the first pass after it lands.
  for (;;) {
    yield SYNC;
    a = s.peek(SND_REQUEST);
    s.poke(0x3000, a); // watchdog
    s.charge(4 + 5 + 2 + 3);
    if (a === 0x11) break;
  }
  // $E00C: clra / ldx #$E000
  a = 0;
  s.charge(2 + 3);
  // $E010: sta $3000 / adda ,x+ / cmpx #$0000 / bne $E010 -- the byte sum
  // of the whole ROM (8192 passes of 18 cycles). Only the watchdog sees
  // it, so it runs as one stretch of charged time.
  for (let x = 0xe000; x <= 0xffff; x += 1) {
    s.poke(0x3000, a);
    a = (a + s.read(x)) & 0xff;
  }
  s.charge(8192 * (5 + 6 + 4 + 3));
  // $E01A: cmpa #$00 / beq $E020 / lda #$01
  s.charge(2 + 3);
  if (a !== 0) { a = 1; s.charge(2); }
  // $E020: sta $0380 -- ROM error flag (after the long checksum stretch:
  // a timing point, or the store would land frames early)
  yield SYNC;
  s.poke(SND_ROM_ERROR, a);
  s.charge(5);
  // $E023: lda #$22 / sta <$40 -- the handshake answer
  s.charge(2);
  yield SYNC;
  s.poke(SND_REQUEST, 0x22);
  s.charge(4);
  // $E027: ldx #$0000 / ldd #$0000
  s.charge(3 + 3);
  // $E02D: ldy $3000 / std ,x++ / cmpx #$0300 / bcs $E02D -- 22 cycles
  // a pass. LDY reads $3000 and $3001: two watchdog kicks. The STDs that
  // reach $0040-$007F are visible to the main CPU (its $22 wait at $E0D2
  // polls $6040), so each of those is timed.
  for (let x = 0; x < 0x300; x += 2) {
    s.charge(7);
    if ((x >= 0x40 && x < 0x80) || frameDue()) yield SYNC;
    s.peek16(0x3000);
    s.poke16(x, 0);
    s.charge(8 + 4 + 3);
  }
  // $E038: ldx #$E3EF / ldu #$00A0, then 16 x (ldd ,x++ / std ,u++ /
  // cmpx #$E40F / bcs $E03E): the tempo table (32 bytes).
  s.charge(3 + 3);
  for (let i = 0; i < 0x20; i += 2) {
    s.charge(8); // ldd ,x++
    if (frameDue()) yield SYNC;
    s.poke16(SND_TEMPO + i, s.read16(TEMPO_INIT + i));
    s.charge(8 + 4 + 3);
  }
  // The last word loaded was $E40D-$E40E: A = $04 afterwards.
  a = s.read(TEMPO_INIT + 0x1e);
  // $E047: lds #$0400 -- the stack (no RAM effect in the port)
  s.charge(4);
  // $E04B: andcc #$EF -- IRQs unmasked (the latch is still off)
  yield SYNC;
  s.cli();
  s.charge(3);
  // $E04D: sta $4000 -- IRQ latch on
  yield SYNC;
  s.poke(0x4000, a);
  s.charge(5);
  // $E050: sta $2007 -- watchdog
  s.poke(0x2007, a);
  s.charge(5);
  // $E053: bra * -- idle_forever; all further work is irq_sound's. The
  // loop is 3 cycles a pass, which decides the IRQ's entry latency.
  for (;;) yield idle(3);
}

// ------------------------------------------------------------ irq_sound

/**
 * The sound CPU's vblank IRQ ($E055): acknowledge, kick the watchdog,
 * copy the voice shadow to the WSG and clear it, then run every
 * requested sound (0-25, later ones win the voices they share), set
 * $00C2 and re-enable the IRQ latch. The IRQ entry (19 cycles) is
 * charged by the scheduler; the RTI (15) here.
 * @see gaplus-sound.asm $E055
 * @param {Machine} m
 * @returns {Thread}
 */
export function* irq_sound(m) {
  const s = m.sound;
  // $E055: sta $6000 -- acknowledge (A is the interrupted code's)
  yield SYNC;
  s.poke(0x6000, 0);
  s.charge(5);
  // $E058: sta $3000 -- watchdog
  s.poke(0x3000, 0);
  s.charge(5);
  // $E05B: ldx #$0080 / ldu #$0003; per voice: ldd ,x++ / std ,u++ /
  // ldd ,x++ / std ,u / leau 6,u / cmpu #$0043 / bne -- the shadow's
  // four bytes go to WSG registers 8v+3 .. 8v+6.
  s.charge(3 + 3);
  for (let v = 0; v < 8; v += 1) {
    const src = WSG_SHADOW + 4 * v;
    const dst = 8 * v + 3;
    s.poke16(dst, s.peek16(src));
    s.poke16(dst + 2, s.peek16(src + 2));
    s.charge(8 + 8 + 8 + 5 + 5 + 5 + 3);
  }
  // $E071: ldx #$0080; clr ,x+ / cmpx #$00A0 / bne -- clear the shadow
  s.charge(3);
  for (let i = 0; i < 0x20; i += 1) {
    clr(s, WSG_SHADOW + i);
    s.charge(8 + 4 + 3);
  }
  for (let n = 0; n < SOUND_COUNT; n += 1) {
    // lda <$40+n / beq
    yield SYNC;
    const req = s.peek(SND_REQUEST + n);
    s.charge(4 + 3);
    let play;
    if (RETRIGGERED.has(n)) {
      if (req !== 0) {
        // clr <$40+n / clr <$60+n / bra -- restart the sound
        yield SYNC;
        clr(s, SND_REQUEST + n);
        s.charge(6);
        yield SYNC;
        clr(s, SND_ACTIVE + n);
        s.charge(6 + 3);
        play = true;
      } else {
        // lda <$60+n / beq -- still running from an earlier request?
        yield SYNC;
        play = s.peek(SND_ACTIVE + n) !== 0;
        s.charge(4 + 3);
      }
    } else if (req !== 0) {
      play = true;
    } else {
      // clr <$60+n -- not requested: restart from the top next time
      yield SYNC;
      clr(s, SND_ACTIVE + n);
      s.charge(6);
      play = false;
    }
    if (play) {
      // lda #n / sta <$C0 / jsr play_sound
      s.charge(2);
      s.poke(SND_CURRENT, n);
      s.charge(4 + 8);
      yield* call(SOUND.play_sound, m, {});
      // bra past the clr (held sounds only; retriggered ones fall through)
      if (!RETRIGGERED.has(n)) s.charge(3);
    }
  }
  // $E22B irq_sound_done: lda #$01 / sta <$C2 / sta $4000 / rti
  s.charge(2);
  s.poke(SND_IRQ_DONE, 1);
  s.charge(4);
  yield SYNC;
  s.poke(0x4000, 1);
  s.charge(5 + 15);
}

// ----------------------------------------------------------- play_sound

/**
 * Run sound $00C0 for one frame. $00C1 = its first WSG voice; X = its
 * channel blocks (17 bytes per voice). On the first frame ($0060+n
 * clear) the blocks are built from the sound's header: per voice a
 * note stream pointer (whose first two bytes are the waveform and the
 * envelope) and a frequency table number, until $11. Then every voice
 * plays one frame (play_voice).
 * @see gaplus-sound.asm $E233
 * @param {Machine} m
 * @returns {Thread}
 */
export function* play_sound(m) {
  const s = m.sound;
  // $E233: ldx #sound_voice / ldb <$C0 / lda b,x / sta <$C1
  let b = s.peek(SND_CURRENT);
  s.poke(SND_VOICE, s.read(disp8(SOUND_VOICE, b)));
  s.charge(3 + 4 + 5 + 4);
  // $E23C: ldx #sound_channels / aslb / ldx b,x -- B is an 8-bit shift,
  // and b,x a signed offset
  b = (b << 1) & 0xff;
  let x = s.read16(disp8(SOUND_CHANNELS, b));
  // $E242: ldu #$0060 / lsrb / lda b,u / bne play_voice
  b >>= 1;
  s.charge(3 + 2 + 6 + 3 + 2);
  const active = disp8(SND_ACTIVE, b);
  yield SYNC;
  const first = s.peek(active) === 0;
  s.charge(5 + 3);
  if (first) {
    // $E24A: inc b,u -- the sound has started
    yield SYNC;
    s.poke(active, (s.peek(active) + 1) & 0xff);
    s.charge(7);
    // $E24C: ldu #sound_headers / aslb / ldu b,u / pshs x
    b = (b << 1) & 0xff;
    let u = s.read16(disp8(SOUND_HEADERS, b));
    s.charge(3 + 2 + 6 + 7);
    const blocks = x;
    for (;;) {
      // $E254: ldd ,u++ / cmpa #$11 / beq $E27B
      const d = s.read16(u);
      u = (u + 2) & 0xffff;
      s.charge(8 + 2 + 3);
      if (d >> 8 === 0x11) {
        // $E27B: sta -1,x / puls x -- the last block's +$10 = $11
        s.poke((x - 1) & 0xffff, 0x11);
        s.charge(5 + 7);
        break;
      }
      // $E25A: std ,x / ldy ,x -- the note stream pointer
      s.poke16(x, d);
      const y = s.peek16(x);
      // $E25F: lda ,u+ / asla / sta 2,x -- frequency table number x 2
      const t = (s.read(u) << 1) & 0xff;
      u = (u + 1) & 0xffff;
      s.poke((x + 2) & 0xffff, t);
      // $E264: ldd ,y++ / std 3,x / sty ,x -- waveform and envelope
      s.poke16((x + 3) & 0xffff, s.read16(y));
      s.poke16(x, (y + 2) & 0xffff);
      s.charge(5 + 6 + 6 + 2 + 5 + 8 + 6 + 6 + 8);
      // $E26B: jsr next_note
      const r = /** @type {{ end?: boolean }} */ (
        yield* call(SOUND.next_note, m, { x }));
      if (r.end) {
        // The ROM's RTS would pop the X pushed at $E252 as a return
        // address and run RAM as code. No stream in the ROM gets here.
        throw new Error('sound CPU: op_end while building channel '
          + `blocks (sound ${s.peek(SND_CURRENT)}): RTS into RAM`);
      }
      // $E26E: leax $C,x / ldd #0 / std ,x++ / std ,x++ / sta ,x+ --
      // loop counters +C..+F and +$10 cleared; X = the next block
      x = (x + 0x0c) & 0xffff;
      s.poke16(x, 0);
      s.poke16((x + 2) & 0xffff, 0);
      s.poke((x + 4) & 0xffff, 0);
      x = (x + 5) & 0xffff;
      s.charge(5 + 3 + 8 + 8 + 6 + 3);
    }
    x = blocks;
  }
  yield* call(SOUND.play_voice, m, { x });
}

/**
 * Play every voice of the current sound for one frame, from block X
 * and voice $00C1 on: step the volume envelope, write volume and
 * frequency to the shadow (write_shadow), count down the note and fetch
 * the next one. Returns (RTS) after the block whose +$10 is $11, or
 * early when a stream ends (op_end).
 * @see gaplus-sound.asm $E27F
 * @param {Machine} m
 * @param {{ x: number }} regs X = the voice's channel block
 * @returns {Thread}
 */
export function* play_voice(m, { x }) {
  const s = m.sound;
  for (;;) {
    // $E27F: lda 5,x / cmpa #$F0 / beq $E2DA -- resting?
    let a = s.peek((x + 5) & 0xffff);
    s.charge(5 + 2 + 3);
    /** @type {EnvResult} */
    let r = { cont: ENV_INC_WRITE, a };
    if (a !== 0xf0) r = envelope_step(m, { x });
    const out = /** @type {{ end: boolean }} */ (
      yield* call(SOUND.write_shadow, m, { x, a: r.a, inc: r.cont === ENV_INC_WRITE }));
    if (out.end) return; // op_end: back to irq_sound
    // $E2F9: lda $10,x / cmpa #$11 / bne $E301 / rts
    a = s.peek((x + 0x10) & 0xffff);
    s.charge(5 + 2 + 3);
    if (a === 0x11) { s.charge(5); return; }
    // $E301: inc <$C1 / leax $11,x / jmp play_voice
    s.poke(SND_VOICE, (s.peek(SND_VOICE) + 1) & 0xff);
    x = (x + 0x11) & 0xffff;
    s.charge(6 + 5 + 4);
  }
}

/**
 * One step of the volume envelope of block X: the byte at position +A
 * of envelope +4 is a level (< $10: play it and advance) or a command
 * $10-$16, dispatched through envelope_ops on its low nibble.
 * @see gaplus-sound.asm $E285
 * @param {Machine} m
 * @param {{ x: number }} regs
 * @returns {EnvResult} where play_voice continues, with A
 */
export function envelope_step(m, { x }) {
  const s = m.sound;
  for (;;) {
    // $E285: ldu #envelopes / lda 4,x / asla / ldu a,u / ldb $A,x /
    // lda b,u / cmpa #$10 / bcs $E2DA
    const a0 = (s.peek((x + 4) & 0xffff) << 1) & 0xff;
    const u0 = s.read16(disp8(ENVELOPES, a0));
    const b = s.peek((x + 0x0a) & 0xffff);
    let a = s.read(disp8(u0, b));
    s.charge(3 + 5 + 2 + 6 + 5 + 5 + 2 + 3);
    if (a < 0x10) return { cont: ENV_INC_WRITE, a };
    // $E295: leau b,u / anda #$0F / ldy #envelope_ops / jmp [a,y]
    const u = disp8(u0, b);
    a &= 0x0f;
    s.charge(5 + 2 + 4 + 7);
    const op = soundAt(s.read16(disp8(ENVELOPE_OPS, a)));
    const r = /** @type {EnvResult} */ (op(m, { x, u }));
    if (r.cont !== ENV_STEP) return r;
  }
}

/**
 * Envelope byte $16 n: hold. With the hold counter +B at $FF (fresh) it
 * loads (previous byte - 1); otherwise it counts +B down, and when +B
 * reaches n + 1 it sets +B to $FF and moves on. The value that goes on
 * to write_shadow is the counter, as the ROM has it.
 * @see gaplus-sound.asm $E2A7
 * @param {Machine} m
 * @param {{ x: number, u: number }} regs U = the envelope's $16 byte
 * @returns {EnvResult}
 */
export function env_op_hold(m, { x, u }) {
  const s = m.sound;
  // $E2A7: lda $B,x / cmpa #$FF / beq $E2C1
  let a = s.peek((x + 0x0b) & 0xffff);
  s.charge(5 + 2 + 3);
  if (a === 0xff) {
    // $E2C1: lda -1,u / deca / sta $B,x / bra write_shadow
    a = (s.read((u - 1) & 0xffff) - 1) & 0xff;
    s.poke((x + 0x0b) & 0xffff, a);
    s.charge(5 + 2 + 5 + 3);
    return { cont: ENV_WRITE, a };
  }
  // $E2AD: ldb 1,u / incb / stb <$C3 / cmpa <$C3 / bne $E2BC
  const t = (s.read((u + 1) & 0xffff) + 1) & 0xff;
  s.poke(SND_TEMP, t);
  s.charge(5 + 2 + 4 + 4 + 3);
  if (a === s.peek(SND_TEMP)) {
    // $E2B6: ldb #$FF / stb $B,x / bra $E2DA
    s.poke((x + 0x0b) & 0xffff, 0xff);
    s.charge(2 + 5 + 3);
    return { cont: ENV_INC_WRITE, a };
  }
  // $E2BC: deca / sta $B,x / bra write_shadow
  a = (a - 1) & 0xff;
  s.poke((x + 0x0b) & 0xffff, a);
  s.charge(2 + 5 + 3);
  return { cont: ENV_WRITE, a };
}

/**
 * Envelope byte $14: restart the envelope from its first level.
 * @see gaplus-sound.asm $E2C8
 * @param {Machine} m
 * @param {{ x: number }} regs
 * @returns {EnvResult}
 */
export function env_op_loop(m, { x }) {
  const s = m.sound;
  // $E2C8: clr $A,x / bra envelope_step
  clr(s, (x + 0x0a) & 0xffff);
  s.charge(7 + 3);
  return { cont: ENV_STEP, a: 0 };
}

/**
 * Envelope byte $10: keep the previous level (end of the envelope).
 * @see gaplus-sound.asm $E2CC
 * @param {Machine} m
 * @param {{ u: number }} regs
 * @returns {EnvResult}
 */
export function env_op_keep(m, { u }) {
  const s = m.sound;
  // $E2CC: lda -1,u / bra write_shadow
  const a = s.read((u - 1) & 0xffff);
  s.charge(5 + 3);
  return { cont: ENV_WRITE, a };
}

/**
 * Envelope byte $12: the previous level, but no more than the note time
 * left (+9), so the note decays as it ends.
 * @see gaplus-sound.asm $E2D0
 * @param {Machine} m
 * @param {{ x: number, u: number }} regs
 * @returns {EnvResult}
 */
export function env_op_limit(m, { x, u }) {
  const s = m.sound;
  // $E2D0: lda -1,u / cmpa 9,x / bls write_shadow (unsigned)
  let a = s.read((u - 1) & 0xffff);
  const left = s.peek((x + 9) & 0xffff);
  s.charge(5 + 5 + 3);
  if (a > left) {
    // $E2D6: lda 9,x / bra write_shadow
    a = s.peek((x + 9) & 0xffff);
    s.charge(5 + 3);
  }
  return { cont: ENV_WRITE, a };
}

/**
 * Store the voice's volume and frequency into the shadow at $0080 +
 * 4 x voice ($00C1), after `INC $A,X` when entered at $E2DA (`inc`),
 * count the note down and fetch the next one when it runs out.
 * @see gaplus-sound.asm $E2DC
 * @param {Machine} m
 * @param {{ x: number, a: number, inc?: boolean }} regs A = the volume;
 *   `inc` = entered at $E2DA
 * @returns {Thread} returns `{ end }`: op_end ran in next_note
 */
export function* write_shadow(m, { x, a, inc = false }) {
  const s = m.sound;
  if (inc) {
    // $E2DA: inc $A,x -- the envelope position
    const p = (x + 0x0a) & 0xffff;
    s.poke(p, (s.peek(p) + 1) & 0xff);
    s.charge(7);
  }
  // $E2DC: sta 5,x / ldu #$0080 / ldb <$C1 / aslb / aslb / leau b,u
  s.poke((x + 5) & 0xffff, a);
  const b = (s.peek(SND_VOICE) << 2) & 0xff;
  const u = disp8(WSG_SHADOW, b);
  // $E2E7: ldd 5,x / sta ,u / stb 3,u / ldd 7,x / sta 2,u / stb 1,u
  const d5 = s.peek16((x + 5) & 0xffff);
  s.poke(u, d5 >> 8);
  s.poke((u + 3) & 0xffff, d5 & 0xff);
  const d7 = s.peek16((x + 7) & 0xffff);
  s.poke((u + 2) & 0xffff, d7 >> 8);
  s.poke((u + 1) & 0xffff, d7 & 0xff);
  s.charge(5 + 3 + 4 + 2 + 2 + 5 + 6 + 4 + 5 + 6 + 5 + 5);
  // $E2F3: dec 9,x / bne $E2F9 / bsr next_note
  const p9 = (x + 9) & 0xffff;
  const left = (s.peek(p9) - 1) & 0xff;
  s.poke(p9, left);
  s.charge(7 + 3);
  if (left === 0) {
    s.charge(7);
    const r = /** @type {{ end?: boolean }} */ (
      yield* call(SOUND.next_note, m, { x }));
    if (r.end) return { end: true };
  }
  return { end: false };
}

// ------------------------------------------------------------ next_note

/**
 * Fetch the next event of voice X's note stream (pointer at +0/1):
 *   $00-$BF  note: high nibble = pitch in the frequency table (+2),
 *            low nibble = octave (shift right); then a length byte,
 *            times the sound's tempo ($00A0+n, MUL) -> +9;
 *   $Cx      rest ($F0 in +5), then a length byte;
 *   $F0-$FF  command through stream_ops (op_end ends the sound).
 * @see gaplus-sound.asm $E309
 * @param {Machine} m
 * @param {{ x: number }} regs
 * @returns {Thread} returns `{ end }`: true when op_end ran (the ROM's
 *   non-local return to irq_sound)
 */
export function* next_note(m, { x }) {
  const s = m.sound;
  // $E309: pshs u
  s.charge(7);
  for (;;) {
    // $E30B: lda [,x] / cmpa #$F0 / bcc stream_command
    let a = s.read(s.peek16(x));
    s.charge(7 + 2 + 3);
    if (a >= 0xf0) {
      const r = /** @type {StreamResult} */ (
        yield* call(SOUND.stream_command, m, { x, a }));
      if (r.cont === STREAM_END) return { end: true };
      // $E3BA: stu ,x / jmp $E30B
      s.poke16(x, r.u);
      s.charge(5 + 4);
      continue;
    }
    // $E311: anda #$F0 / cmpa #$C0 / beq $E349
    a &= 0xf0;
    s.charge(2 + 2 + 3);
    if (a === 0xc0) {
      // $E349: lda #$F0 / sta 5,x -- a rest
      s.poke((x + 5) & 0xffff, 0xf0);
      s.charge(2 + 5);
    } else {
      // $E317: clr 5,x / ldu #freq_tables / ldb 2,x / ldu b,u
      clr(s, (x + 5) & 0xffff);
      let u = s.read16(disp8(FREQ_TABLES, s.peek((x + 2) & 0xffff)));
      // $E320: lsra x3 / sta <$C3 / lsra / adda <$C3 / leau a,u --
      // pitch x 3 (pitch x 2 + pitch)
      a >>= 3;
      s.poke(SND_TEMP, a);
      a = ((a >> 1) + s.peek(SND_TEMP)) & 0xff;
      u = disp8(u, a);
      s.charge(7 + 3 + 5 + 6 + 2 + 2 + 2 + 4 + 2 + 4 + 5);
      // $E32A: ldd ,u / std 6,x / lda 2,u / sta 8,x -- the 3 bytes
      s.poke16((x + 6) & 0xffff, s.read16(u));
      s.poke((x + 8) & 0xffff, s.read((u + 2) & 0xffff));
      // $E332: lda [,x] / anda #$0F / beq $E341 -- octave shifts
      let n = s.read(s.peek16(x)) & 0x0f;
      s.charge(5 + 6 + 5 + 5 + 7 + 2 + 3);
      // $E338: lsr 6,x / ror 7,x / ror 8,x / deca / bne -- 24-bit >> 1
      while (n !== 0) {
        const p6 = (x + 6) & 0xffff;
        const p7 = (x + 7) & 0xffff;
        const p8 = (x + 8) & 0xffff;
        const v6 = s.peek(p6);
        s.poke(p6, v6 >> 1);
        const v7 = s.peek(p7);
        s.poke(p7, ((v6 & 1) << 7) | (v7 >> 1));
        const v8 = s.peek(p8);
        s.poke(p8, ((v7 & 1) << 7) | (v8 >> 1));
        n -= 1;
        s.charge(7 + 7 + 7 + 2 + 3);
      }
      // $E341: lda 3,x / ora 6,x / sta 6,x / bra $E34D -- the waveform
      const p6 = (x + 6) & 0xffff;
      s.poke(p6, s.peek((x + 3) & 0xffff) | s.peek(p6));
      s.charge(5 + 5 + 5 + 3);
    }
    // $E34D: ldu ,x / ldy #$00A0 / ldb <$C0 / lda b,y / ldb 1,u / mul /
    // stb 9,x -- note length x tempo (low byte)
    let u = s.peek16(x);
    const tempo = s.peek(disp8(SND_TEMPO, s.peek(SND_CURRENT)));
    const len = s.read((u + 1) & 0xffff);
    s.poke((x + 9) & 0xffff, (tempo * len) & 0xff);
    // $E35C: leau 2,u / stu ,x / clr $A,x / lda #$FF / sta $B,x
    u = (u + 2) & 0xffff;
    s.poke16(x, u);
    clr(s, (x + 0x0a) & 0xffff);
    s.poke((x + 0x0b) & 0xffff, 0xff);
    // $E366: puls u / rts
    s.charge(5 + 4 + 4 + 5 + 5 + 11 + 5 + 5 + 5 + 7 + 2 + 5 + 7 + 5);
    return { end: false };
  }
}

/**
 * Stream byte $F0-$FF: dispatch its low nibble through stream_ops, with
 * U = the stream pointer and B = the byte after the command.
 * @see gaplus-sound.asm $E369
 * @param {Machine} m
 * @param {{ x: number, a: number }} regs A = the command byte
 * @returns {Thread} returns a {@link StreamResult}
 */
export function* stream_command(m, { x, a }) {
  const s = m.sound;
  // $E369: ldu ,x / ldb 1,u / ldy #stream_ops / anda #$0F / asla /
  // jmp [a,y]
  const u = s.peek16(x);
  const b = s.read((u + 1) & 0xffff);
  const i = ((a & 0x0f) << 1) & 0xff;
  s.charge(5 + 5 + 4 + 2 + 2 + 7);
  const op = soundAt(s.read16(disp8(STREAM_OPS, i)));
  return yield* call(op, m, { x, u, b });
}

/**
 * $F7 addr: jump to addr.
 * @see gaplus-sound.asm $E386
 * @param {Machine} m @param {{ u: number }} regs
 * @returns {StreamResult}
 */
export function op_jump(m, { u }) {
  const s = m.sound;
  // $E386: ldu 1,u / bra $E3BA
  const t = s.read16((u + 1) & 0xffff);
  s.charge(6 + 3);
  return { cont: STREAM_NEXT, u: t };
}

/**
 * $F1 n: set the waveform bits (+3).
 * @see gaplus-sound.asm $E38A
 * @param {Machine} m @param {{ x: number, u: number, b: number }} regs
 * @returns {StreamResult}
 */
export function op_wave(m, { x, u, b }) {
  const s = m.sound;
  // $E38A: stb 3,x / bra $E394; $E394: leau 2,u / bra $E3BA
  s.poke((x + 3) & 0xffff, b);
  s.charge(5 + 3 + 5 + 3);
  return { cont: STREAM_NEXT, u: (u + 2) & 0xffff };
}

/**
 * $F2 n: set the volume envelope (+4).
 * @see gaplus-sound.asm $E38E
 * @param {Machine} m @param {{ x: number, u: number, b: number }} regs
 * @returns {StreamResult}
 */
export function op_envelope(m, { x, u, b }) {
  const s = m.sound;
  // $E38E: stb 4,x / bra $E394; $E394: leau 2,u / bra $E3BA
  s.poke((x + 4) & 0xffff, b);
  s.charge(5 + 3 + 5 + 3);
  return { cont: STREAM_NEXT, u: (u + 2) & 0xffff };
}

/**
 * $F4 n: set the flag at +D (which makes op_loop_c pass through).
 * @see gaplus-sound.asm $E392
 * @param {Machine} m @param {{ x: number, u: number, b: number }} regs
 * @returns {StreamResult}
 */
export function op_set_d(m, { x, u, b }) {
  const s = m.sound;
  // $E392: stb $D,x; $E394: leau 2,u / bra $E3BA
  s.poke((x + 0x0d) & 0xffff, b);
  s.charge(5 + 5 + 3);
  return { cont: STREAM_NEXT, u: (u + 2) & 0xffff };
}

/**
 * The shared tail of the loop ops: $E3B4 `ldu 2,u` (take the jump) or
 * $E3B8 `leau 4,u` (skip the address), then $E3BA.
 * @param {CpuView} s @param {number} u @param {boolean} jump
 * @returns {StreamResult}
 */
function loopTail(s, u, jump) {
  if (jump) {
    // $E3B4: ldu 2,u / bra $E3BA
    const t = s.read16((u + 2) & 0xffff);
    s.charge(6 + 3);
    return { cont: STREAM_NEXT, u: t };
  }
  // $E3B8: leau 4,u
  s.charge(5);
  return { cont: STREAM_NEXT, u: (u + 4) & 0xffff };
}

/**
 * $F3 n, addr: jump to addr until the counter +C reaches n; passes
 * straight through while +D is set. The counter is not reset.
 * @see gaplus-sound.asm $E398
 * @param {Machine} m @param {{ x: number, u: number, b: number }} regs
 * @returns {StreamResult}
 */
export function op_loop_c(m, { x, u, b }) {
  const s = m.sound;
  // $E398: lda $D,x / bne $E3B8
  s.charge(5 + 3);
  if (s.peek((x + 0x0d) & 0xffff) !== 0) return loopTail(s, u, false);
  // $E39C: inc $C,x / cmpb $C,x / beq $E3B8 / bra $E3B4
  const p = (x + 0x0c) & 0xffff;
  const c = (s.peek(p) + 1) & 0xff;
  s.poke(p, c);
  s.charge(7 + 5 + 3);
  if (b === c) return loopTail(s, u, false);
  s.charge(3);
  return loopTail(s, u, true);
}

/**
 * $F6 n, addr: when the counter +F reaches n, clear it and jump to
 * addr; otherwise go on.
 * @see gaplus-sound.asm $E3A4
 * @param {Machine} m @param {{ x: number, u: number, b: number }} regs
 * @returns {StreamResult}
 */
export function op_loop_f(m, { x, u, b }) {
  const s = m.sound;
  // $E3A4: inc $F,x / cmpb $F,x / bne $E3B8
  const p = (x + 0x0f) & 0xffff;
  const c = (s.peek(p) + 1) & 0xff;
  s.poke(p, c);
  s.charge(7 + 5 + 3);
  if (b !== c) return loopTail(s, u, false);
  // $E3AA: clr $F,x / bra $E3B4
  clr(s, p);
  s.charge(7 + 3);
  return loopTail(s, u, true);
}

/**
 * $F5 n, addr: when the counter +E reaches n, jump to addr (the counter
 * is not cleared); otherwise go on.
 * @see gaplus-sound.asm $E3AE
 * @param {Machine} m @param {{ x: number, u: number, b: number }} regs
 * @returns {StreamResult}
 */
export function op_loop_e(m, { x, u, b }) {
  const s = m.sound;
  // $E3AE: inc $E,x / cmpb $E,x / bne $E3B8 (else fall into $E3B4)
  const p = (x + 0x0e) & 0xffff;
  const c = (s.peek(p) + 1) & 0xff;
  s.poke(p, c);
  s.charge(7 + 5 + 3);
  return loopTail(s, u, b === c);
}

/**
 * $F0: end of the sound. Clear its request byte (sound $16, the coin
 * sound, counts coins and is decremented instead) and its active byte,
 * then return straight to irq_sound (`PULS X,U / RTS`).
 * @see gaplus-sound.asm $E3BF
 * @param {Machine} m
 * @returns {Thread} returns {@link StreamResult} with cont STREAM_END
 */
export function* op_end(m) {
  const s = m.sound;
  // $E3BF: ldx #$0040 / ldb <$C0 / abx / cmpb #$16 / beq $E3CD
  const n = s.peek(SND_CURRENT);
  const x = (SND_REQUEST + n) & 0xffff;
  s.charge(3 + 4 + 3 + 2 + 3);
  yield SYNC;
  if (n === 0x16) {
    // $E3CD: dec ,x
    s.poke(x, (s.peek(x) - 1) & 0xff);
    s.charge(6);
  } else {
    // $E3C9: clr ,x / bra $E3CF
    clr(s, x);
    s.charge(6 + 3);
  }
  // $E3CF: clr $20,x / puls x,u / rts
  yield SYNC;
  clr(s, (x + 0x20) & 0xffff);
  s.charge(7 + 9 + 5);
  return { cont: STREAM_END, u: 0 };
}

// ---------------------------------------------------------- registration

Object.assign(SOUND, {
  reset_sound, irq_sound, play_sound, play_voice, envelope_step,
  env_op_hold, env_op_loop, env_op_keep, env_op_limit, write_shadow,
  next_note, stream_command, op_jump, op_wave, op_envelope, op_set_d,
  op_loop_c, op_loop_f, op_loop_e, op_end,
});

Object.assign(SOUND_AT, {
  0xe000: reset_sound,
  0xe055: irq_sound,
  0xe233: play_sound,
  0xe27f: play_voice,
  0xe285: envelope_step,
  0xe2a7: env_op_hold,
  0xe2c8: env_op_loop,
  0xe2cc: env_op_keep,
  0xe2d0: env_op_limit,
  0xe2dc: write_shadow,
  0xe309: next_note,
  0xe369: stream_command,
  0xe386: op_jump,
  0xe38a: op_wave,
  0xe38e: op_envelope,
  0xe392: op_set_d,
  0xe398: op_loop_c,
  0xe3a4: op_loop_f,
  0xe3ae: op_loop_e,
  0xe3bf: op_end,
});

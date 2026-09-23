// Copyright 2026 by Moshix
/**
 * The main CPU's vblank IRQ handler and the helpers it calls, in ROM
 * gp2-3b.8c:
 *
 *   $C000  irq_main          the handler (a generator, see below)
 *   $C0AB  irq_copy_sprites  (part of irq_main) main sprites -> slots 40-63
 *   $C163  round_select      Round Advance DIP loop (never leaves while on)
 *   $C1B9  coin_jammed       COIN JAMMED hang
 *   $D07A  irq_timers        play clock, 1UP/2UP blink colours
 *   $D0C6  update_play_clock BCD clock $09F8-$09FB
 *   $D107  update_p1_time    player-1 time $09FC-$09FE
 *   $DF19  sound_all_off     clear every sound request
 *   $DF27  sound_demo_gate   clear the sound requests the DIP says to
 *   $DF5D  clear_sprite_shadows / $DF65 clear_sprite_shadows_all
 *
 * THE HANDLER IS A GENERATOR because it waits for the sub CPU: at the end
 * of every frame (and on the coin-during-demo path) it polls frame_sync
 * ($10AF) until the sub CPU's handler has stored $11, then answers $22.
 * It polls $10AF for $11 with src/game/timing.js poll() (a pollAgain
 * marker per failed pass). round_select and
 * coin_jammed are loops the handler does not leave by itself; they yield
 * BUSY once per pass. Everything the handler does before and after is
 * run atomically (the 6809 has IRQs masked; nothing but the other CPUs
 * can interleave), except for a SYNC before the accesses the other CPUs
 * see (the IRQ latch, attract_flag, the $1E31 clears the sub's sprite copy
 * reads, the coin sound) -- integration, round 3.
 *
 * CYCLES. Every routine here charges (Machine.charge) the cycles of the
 * instructions it executes: the handler from $C000 (the 19-cycle IRQ
 * entry is not included), callees their own from their first instruction
 * to their RTS inclusive. Failed iterations of the frame_sync poll are
 * charged by timing.js poll() (the scheduler needs the loop's phase; the
 * tests refund them as waiting); the final, successful one here. So after a
 * normal frame m.charged[0] has grown by the handler's work including the
 * RTI (15 cycles).
 *
 * EXITS. Normally the handler returns (RTI: the scheduler clears CC.I).
 * Two paths leave through a JMP, recorded with requestJump() (see
 * gp2_3b_state.js): `lbne service_mode` ($C016 -> $B6F6) and, on a coin
 * during the demo, `jmp attract_loop` ($C0A8 -> $C417). Both leave the
 * interrupted foreground's stack behind and keep CC.I set (no RTI); the
 * code jumped to clears it itself (attract_loop's ANDCC #$EF).
 *
 * @see reference/gaplus-main.asm $C000-$C1D5, $D07A-$D14F, $DF19-$DFAD
 */

import { MAIN } from './routines.js';
import { call } from '../call.js';
import { add8, daa } from '../m6809ops.js';
import { mainRom } from '../romdata.js';
import { BUSY, busy, requestJump } from './gp2_3b_state.js';
import { poll, SYNC } from '../timing.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/** $B6F6 service_mode (gp2-4), where `lbne` at $C016 goes. */
export const SERVICE_MODE = 0xb6f6;
/** $C417 attract_loop, where the coin-during-demo path goes. */
export const ATTRACT_LOOP = 0xc417;

/**
 * Wait for the sub CPU at frame_sync, then release it.
 *
 *   $C158: lda <$AF / cmpa #$11 / bne $C158 / lda #$22 / sta <$AF
 *
 * (the same loop is at $C067 on the coin-during-demo path). One failed
 * pass is 9 cycles of waiting, not charged; the pass that sees $11 is.
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
function* frameSync(m) {
  // $C158: lda <$AF (4) / cmpa #$11 (2) / bne $C158 (3) -- a poll loop
  // (integration: src/game/timing.js poll keeps the loop's phase)
  yield* poll(m, 0x10af, (v) => v === 0x11, [4, 2, 3]); // frame_sync
  // the pass that saw $11 (bne not taken), lda #$22 2; sta <$AF 4 is
  // polled by the sub CPU: a timing point
  m.charge(9); m.charge(2);
  yield SYNC;
  m.poke(0x10af, 0x22);
  m.charge(4);
}

/**
 * $C000 irq_main: the main CPU's vblank IRQ handler (see the file header
 * for how it yields and exits).
 *
 *  1. Watchdog, IRQ latch off; operator_stats ($FCDF); in attract mode
 *     sound_demo_gate.
 *  2. Service switch (58XX $6814 bit 3) -> service_mode, for good.
 *  3. 56XX credits: both BCD nibbles >= $A (`subd #$0A0A / lbcc`: only
 *     when the TENS nibble is >= $A and, if it is exactly $A, the units
 *     nibble is too) -> coin_jammed, for good.
 *  4. Round Advance DIP (58XX $6813 bit 3) -> round_select, which comes
 *     back here once the switch is off.
 *  5. IRQ latch on again (CC.I still masks it until RTI); irq_timers;
 *     flip flag to the hardware ($1F7F); for each occupied formation
 *     slot n (formation_flags $1860+n bit 0, n = 0..$2C) clear $1E31+2n.
 *  6. A credit added (56XX nibble 2): coin sound (INC $6056), ack. In
 *     attract mode: rendezvous with the sub, reset the game state, jump
 *     to attract_loop.
 *  7. Sprite copy, starfield direction, frame counter, rendezvous, RTI.
 * @see gaplus-main.asm $C000
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* irq_main(m) {
  // (Integration, round 3: every access at its instruction's start --
  // the charges follow the accesses -- and a SYNC before the latch and
  // the shared-RAM accesses, so the slice ends where the board's does
  // and the 56XX/58XX run lands before the right read.)
  // $C000: lda $7C00 (watchdog) / sta $7C00 (IRQ off) / jsr $FCDF
  const w = m.peek(0x7c00);
  m.charge(5);
  yield SYNC;
  m.poke(0x7c00, w);
  m.charge(5); m.charge(8);
  yield* call(MAIN.operator_stats, m, {});
  // $C009: lda attract_flag / beq $C011 / jsr sound_demo_gate
  yield SYNC;
  const attract = m.peek(0x09f4);
  m.charge(5); m.charge(3);
  if (attract !== 0) {
    m.charge(8);
    yield* sound_demo_gate(m);
  }
  // $C011: lda $6814 / anda #$08 / lbne service_mode
  const svc = m.peek(0x6814);
  m.charge(5); m.charge(2);
  if (svc & 0x08) {
    m.charge(6);
    requestJump(m, SERVICE_MODE);
    return;
  }
  m.charge(5); // lbne not taken
  // $C01A: ldd $6800 / anda #$0F / andb #$0F / subd #$0A0A / lbcc
  // coin_jammed. A 16-bit compare: (tens << 8 | units) >= $0A0A.
  const tens = m.peek(0x6800) & 0x0f;
  const units = m.peek(0x6801) & 0x0f;
  m.charge(6); m.charge(2); m.charge(2); m.charge(4);
  if (((tens << 8) | units) >= 0x0a0a) {
    m.charge(6); // lbcc taken
    yield* coin_jammed(m);
    return; // never reached: coin_jammed does not return
  }
  m.charge(5); // lbcc not taken
  // $C028: lda $6813 / anda #$08 / lbne round_select
  const rnd = m.peek(0x6813);
  m.charge(5); m.charge(2);
  if (rnd & 0x08) {
    m.charge(6);
    yield* round_select(m);
    yield* irqMainNormal(m, 0x20);
    return;
  }
  m.charge(5);
  yield* irqMainNormal(m, 0);
}

/**
 * $C031 irq_main_normal: the rest of irq_main (also where round_select
 * jumps back to).
 * @param {Machine} m
 * @param {number} a register A, stored to the IRQ latch
 * @returns {Generator<symbol, void, unknown>}
 */
function* irqMainNormal(m, a) {
  // $C031: sta $7400 (IRQ latch on) / jsr irq_timers. A is 0 (from the
  // `anda #$08` at $C02B), or $20 when round_select jumps back here.
  m.poke(0x7400, a);
  m.charge(5); m.charge(8);
  irq_timers(m);
  // $C037: lda <$2C / sta $1F7F -- flip flag to the hardware
  const flip = m.peek(0x102c);
  m.charge(4);
  m.poke(0x1f7f, flip);
  m.charge(5);

  // $C03C: ldx #$1860 / ldb #$FE, then per slot: addb #2 / lda ,x+ /
  // cmpx #$188D / beq / anda #1 / beq (loop) / ldu #$1E31 / clr b,u.
  // B counts 2 per slot as an 8-bit register, and `clr b,u` uses it as a
  // SIGNED offset: slots 64+ would clear below $1E31 (only 45 exist).
  m.charge(3); m.charge(2);
  let b = 0xfe;
  for (let x = 0x1860; ;) {
    b = (b + 2) & 0xff;
    m.charge(2); // addb #2
    const a = m.peek(x);
    x += 1;
    m.charge(6); m.charge(4); m.charge(3);
    if (x === 0x188d) break;
    m.charge(2); m.charge(3);
    if (a & 0x01) {
      // $C04E: ldu #$1E31 / clr b,u / bra $C041 -- the sub CPU's sprite
      // copy reads $1E00-$1EE1 meanwhile: a timing point
      m.charge(3);
      const ea = (0x1e31 + ((b ^ 0x80) - 0x80)) & 0xffff;
      yield SYNC;
      m.peek(ea);
      m.poke(ea, 0);
      m.charge(7); m.charge(3);
    }
  }

  // $C055: lda $6802 / anda #$0F / beq irq_copy_sprites
  const coins = m.peek(0x6802) & 0x0f;
  m.charge(5); m.charge(2); m.charge(3);
  if (coins !== 0) {
    // $C05C: inc snd_request+22 (the coin sound counts; the sound CPU
    // reads and decrements it) / clr $6802
    yield SYNC;
    m.poke(0x6056, (m.peek(0x6056) + 1) & 0xff);
    m.charge(7);
    m.peek(0x6802);
    m.poke(0x6802, 0);
    m.charge(7);
    // $C062: lda attract_flag / beq irq_copy_sprites
    yield SYNC;
    const demo = m.peek(0x09f4);
    m.charge(5); m.charge(3);
    if (demo !== 0) {
      yield* coinDuringDemo(m);
      return;
    }
  }
  yield* irq_copy_sprites(m);
}

/**
 * $C0AB irq_copy_sprites: the tail of irq_main, reached by branches from
 * $C05A/$C065: sprite copy, starfield direction, frame counter, the
 * frame_sync rendezvous (a poll loop, timing.js) and the RTI.
 * @see gaplus-main.asm $C0AB
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* irq_copy_sprites(m) {
  copySprites(m);
  starfield(m);
  frameCount(m);
  yield* frameSync(m);
  m.charge(15); // $C162: rti (entire state)
}

/**
 * $C067: a coin arrived during the demo. Wait for the sub CPU's frame,
 * reset the game state, silence, release the sub and jump to
 * attract_loop (the interrupted foreground is abandoned).
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
function* coinDuringDemo(m) {
  // $C067: lda <$AF / cmpa #$11 / bne $C067 -- as frameSync, but the
  // $22 is written only after the clean-up.
  yield* poll(m, 0x10af, (v) => v === 0x11, [4, 2, 3]);
  m.charge(9);
  // $C06D: clr <$DA / <$D9 / $1111 / <$E9 / <$CF / <$D0 / $6051 / $6071 /
  // $1118 / $1116 / $1117 / <$30 / <$7A / <$2F / $1E01 / $1F17 / $1F19 /
  // $1F1B / $1F1D (each CLR reads first; all RAM, so unobservable)
  const cleared = [
    [0x10da, 6], [0x10d9, 6], [0x1111, 7], [0x10e9, 6], [0x10cf, 6],
    [0x10d0, 6], [0x6051, 7], [0x6071, 7], [0x1118, 7], [0x1116, 7],
    [0x1117, 7], [0x1030, 6], [0x107a, 6], [0x102f, 6], [0x1e01, 7],
    [0x1f17, 7], [0x1f19, 7], [0x1f1b, 7], [0x1f1d, 7],
  ];
  // (integration, round 3: the sub and sound CPUs read these -- a SYNC
  // before each; CLR reads first; charges after the access)
  for (const [addr, cyc] of cleared) {
    yield SYNC;
    m.peek(addr);
    m.poke(addr, 0);
    m.charge(cyc);
  }
  // $C09E: jsr clear_sprite_shadows / jsr sound_demo_gate. Their SYNC /
  // BUSY points are timing points for the other CPUs here too.
  m.charge(8);
  yield* clear_sprite_shadows(m);
  m.charge(8);
  yield* sound_demo_gate(m);
  // $C0A4: lda #$22 / sta <$AF (the sub polls it) / jmp attract_loop
  m.charge(2);
  yield SYNC;
  m.poke(0x10af, 0x22);
  m.charge(4); m.charge(4);
  requestJump(m, ATTRACT_LOOP);
}

/**
 * $C0AB irq_copy_sprites: copy the main CPU's sprites -- shadow entries
 * $0EE2-$0F33 (+$0800 Y/X, +$1000 flags) whose flag byte 1 has bit 7 set
 * -- into the sprite registers from slot 40 ($0FD0) up, mirrored when the
 * screen is flipped; then zero the slots left up to $1000.
 * @see gaplus-main.asm $C0AB
 * @param {Machine} m
 */
function copySprites(m) {
  let u = 0x0ee2;
  let x = 0x0fd0;
  m.charge(3); m.charge(3);
  // $C0B1: cmpu #$0F34 / beq $C111
  for (;;) {
    m.charge(5); m.charge(3);
    if (u === 0x0f34) break;
    // $C0B7: lda $1001,u / anda #$80 / bne $C0C3
    m.charge(8); m.charge(2); m.charge(3);
    if ((m.peek(u + 0x1001) & 0x80) === 0) {
      m.charge(5); m.charge(3); // leau 2,u / bra
      u += 2;
      continue;
    }
    // $C0C3: lda <$2C / beq $C0F8
    m.charge(4); m.charge(3);
    if (m.peek(0x102c) !== 0) {
      // Flipped: Y = ($E0, or $D0 for a 2-tall sprite) - y, X = ~(x -
      // $1A0) as a 9-bit value (bit 8 in the flag byte's bit 0).
      let a = 0xe0;
      const fl = m.peek(u + 0x1000);
      m.poke(x + 0x1000, fl);
      m.charge(2); m.charge(8); m.charge(8); m.charge(2); m.charge(3);
      if (fl & 0x20) {
        a = 0xd0;
        m.charge(2);
      }
      a = (a - m.peek(u + 0x0800)) & 0xff; // suba $0800,u
      m.poke(x + 0x0800, a);
      // $C0DF: lda $1001,u / anda #1 / ldb $0801,u / subd #$01A0 /
      // coma / comb / stb $0801,x / sta $1001,x
      const hi = m.peek(u + 0x1001) & 0x01;
      const lo = m.peek(u + 0x0801);
      const d = ~(((hi << 8) | lo) - 0x1a0) & 0xffff;
      m.poke(x + 0x0801, d & 0xff);
      m.poke(x + 0x1001, d >> 8);
      for (const c of [8, 8, 8, 2, 8, 4, 2, 2, 8, 8, 3]) m.charge(c);
    } else {
      // $C0F8: ldd $1000,u / std $1000,x / ldd $0800,u / std $0800,x
      m.poke16(x + 0x1000, m.peek16(u + 0x1000));
      m.poke16(x + 0x0800, m.peek16(u + 0x0800));
      m.charge(9); m.charge(9); m.charge(9); m.charge(9);
    }
    // $C108: ldd ,u++ / std ,x++ / cmpx #$1000 / bne $C0B1
    m.poke16(x, m.peek16(u));
    u += 2;
    x += 2;
    m.charge(8); m.charge(8); m.charge(4); m.charge(3);
    if (x === 0x1000) break;
  }
  // $C111: cmpx #$1000 / beq / ldd #0 / std $1000,x / std $0800,x /
  // std ,x++ / bra
  for (;;) {
    m.charge(4); m.charge(3);
    if (x === 0x1000) break;
    m.poke16(x + 0x1000, 0);
    m.poke16(x + 0x0800, 0);
    m.poke16(x, 0);
    x += 2;
    m.charge(3); m.charge(9); m.charge(9); m.charge(8); m.charge(3);
  }
}

/**
 * $C125 irq_starfield: on even frames scroll code $87, on odd frames $86
 * or $80 by $1170 (bit 0 set: leave it; bit 1: $80) -> $A001.
 * @param {Machine} m
 */
function starfield(m) {
  // $C125: lda <$16 / anda #1 / bne $C132
  m.charge(4); m.charge(2); m.charge(3);
  if ((m.peek(0x1016) & 0x01) === 0) {
    m.poke(0xa001, 0x87);
    m.charge(2); m.charge(5); m.charge(3);
    return;
  }
  // $C132: lda $1170 / anda #1 / bne irq_frame_count
  m.charge(5); m.charge(2); m.charge(3);
  if (m.peek(0x1170) & 0x01) return;
  // $C139: lda $1170 / anda #2 / bne $C147
  m.charge(5); m.charge(2); m.charge(3);
  if (m.peek(0x1170) & 0x02) {
    m.poke(0xa001, 0x80);
    m.charge(2); m.charge(5);
  } else {
    m.poke(0xa001, 0x86);
    m.charge(2); m.charge(5); m.charge(3);
  }
}

/**
 * $C14C irq_frame_count: frame_counter $1016 + 1; on its wrap frame_hi
 * $1015 + 1, saturating at $FF.
 * @param {Machine} m
 */
function frameCount(m) {
  const f = (m.peek(0x1016) + 1) & 0xff;
  m.poke(0x1016, f);
  m.charge(6); m.charge(3);
  if (f !== 0) return;
  m.charge(4); m.charge(2); m.charge(3);
  const h = m.peek(0x1015);
  if (h === 0xff) return;
  m.poke(0x1015, h + 1);
  m.charge(6);
}

/**
 * $C163 round_select: the Round Advance DIP is on. Show the start stage
 * stage_p1 ($1106) + 0, as two BCD digits, at tiles $0390 (units) and
 * $03B0 (tens); P1 up (56XX $6804 bit 0) advances it once per press. The
 * loop runs inside the IRQ handler until the DIP is off, then blanks the
 * two tiles and goes on with irq_main_normal. Yields BUSY at the top of
 * every pass ($C163) and of every pass of the stick-release wait ($C1A2):
 * the IRQs this loop swallows are lost, as on the board.
 *
 * The digits are computed by counting stage_p1 up in BCD (`adda #1 /
 * daa`, B times, B = 0 meaning none), so stage 100+ wraps as BCD does.
 * Only the watchdog is kicked by `ldb $7C00` (B is then reloaded).
 * @see gaplus-main.asm $C163
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* round_select(m) {
  // $C163 (units) and $C179 (tens): clra / ldb $7C00 / ldb $1106 / beq /
  // { adda #1 / daa / decb / bne }
  const bcd = () => {
    m.peek(0x7c00);
    let b = m.peek(0x1106);
    let a = 0;
    m.charge(2); m.charge(5); m.charge(5); m.charge(3);
    while (b !== 0) {
      const s = add8(a, 1);
      a = daa(s.v, s.cc).v;
      b = (b - 1) & 0xff;
      m.charge(2); m.charge(2); m.charge(2); m.charge(3);
    }
    return a;
  };
  for (;;) {
    yield BUSY;
    // anda #$0F / ora #$30 / sta $0390
    m.poke(0x0390, (bcd() & 0x0f) | 0x30);
    m.charge(2); m.charge(2); m.charge(5);
    // lsra x4 / ora #$30 / sta $03B0
    m.poke(0x03b0, (bcd() >> 4) | 0x30);
    for (const c of [2, 2, 2, 2, 2, 5]) m.charge(c);
    // $C191: lda $6813 / anda #8 / beq $C1AE (DIP off: done)
    m.charge(5); m.charge(2); m.charge(3);
    if ((m.peek(0x6813) & 0x08) === 0) {
      // $C1AE: lda #$20 / sta $03B0 / sta $0390 / jmp irq_main_normal
      m.poke(0x03b0, 0x20);
      m.poke(0x0390, 0x20);
      m.charge(2); m.charge(5); m.charge(5); m.charge(4);
      return;
    }
    // $C198: lda $6804 / anda #1 / beq round_select
    m.charge(5); m.charge(2); m.charge(3);
    if (m.peek(0x6804) & 0x01) {
      // $C19F: inc $1106, then wait for the stick to be released:
      // lda $7C00 / lda $6804 / anda #1 / bne $C1A2 / bra round_select
      m.poke(0x1106, (m.peek(0x1106) + 1) & 0xff);
      m.charge(7);
      for (;;) {
        yield BUSY;
        m.peek(0x7c00);
        m.charge(5); m.charge(5); m.charge(2); m.charge(3);
        if ((m.peek(0x6804) & 0x01) === 0) break;
      }
      m.charge(3);
    }
  }
}

/**
 * $C1B9 coin_jammed: the 56XX reported an impossible credit count.
 * Print "COIN JAMMED" at the top ($0022 up, string stored reversed at
 * $C1CA) and loop there for ever, kicking the watchdog each pass. Never
 * returns (the IRQ handler never ends; the board is dead until reset).
 * Yields BUSY at the top of every pass.
 * @see gaplus-main.asm $C1B9
 * @param {Machine} m
 * @returns {Generator<symbol, never, unknown>}
 */
export function* coin_jammed(m) {
  for (;;) {
    yield BUSY;
    // $C1B9: lda $7C00 / ldx #$0022 / ldu #$C1CA
    m.peek(0x7c00);
    m.charge(5); m.charge(3); m.charge(3);
    // $C1C2: lda ,u+ / beq coin_jammed / sta ,x+ / bra
    for (let u = 0xc1ca, x = 0x0022; ; u += 1, x += 1) {
      const a = mainRom(u);
      m.charge(6); m.charge(3);
      if (a === 0) break;
      m.poke(x, a);
      m.charge(6); m.charge(3);
    }
  }
}

/**
 * $D07A irq_timers: advance the play clock; outside attract mode also the
 * player-1 time. Then the 1UP/2UP colours on the top row:
 *
 *  - frame_counter bit 4 set (or attract mode with the P2 score blank at
 *    $03E6): attributes $07C0-$07DF = 1, then either $07C5-$07C7 = $3F
 *    and $07E4-$07EA = $3F (one player) or $07E4-$07EA = 0 (two);
 *  - bit 4 clear: the current player's label ($07D8-$07DA for P1,
 *    $07C5-$07C7 for P2) = $3F, then the same as above;
 *  - attract mode otherwise: $07C0-$07DF = 1 and $07E0-$07FF = 0.
 * @see gaplus-main.asm $D07A
 * @param {Machine} m
 */
export function irq_timers(m) {
  // $D07A: jsr update_play_clock / lda attract_flag / lbne $D133
  m.charge(8);
  update_play_clock(m);
  m.charge(5); m.charge(5);
  let x;
  let a;
  let b;
  if (m.peek(0x09f4) !== 0) {
    // $D133: lda $03E6 / suba #$20 / lbeq $D08D
    m.charge(1); m.charge(5); m.charge(2); m.charge(5);
    if (m.peek(0x03e6) !== 0x20) {
      // $D13C: 32 x 1 from $07C0, then 32 x 0 (sta ,x+ / decb / bne)
      m.charge(3); m.charge(3);
      for (let i = 0; i < 0x20; i += 1) {
        m.poke(0x07c0 + i, 1);
        m.charge(6); m.charge(2); m.charge(3);
      }
      m.charge(3);
      for (let i = 0; i < 0x20; i += 1) {
        m.poke(0x07e0 + i, 0);
        m.charge(6); m.charge(2); m.charge(3);
      }
      m.charge(5);
      return;
    }
    m.charge(1);
    x = 0x07c0; a = 0x01; b = 0x20;
    m.charge(3); m.charge(3);
  } else {
    // $D084: jsr update_p1_time / lda <$16 / anda #$10 / beq $D0B6
    m.charge(8);
    update_p1_time(m);
    m.charge(4); m.charge(2); m.charge(3);
    if (m.peek(0x1016) & 0x10) {
      x = 0x07c0; a = 0x01; b = 0x20; // $D08D: ldx #$07C0 / ldd #$0120
      m.charge(3); m.charge(3);
    } else {
      // $D0B6: ldx #$07C5 / lda #$3F / ldb <$2D / bne / ldx #$07D8 /
      // ldb #3 / bra $D093
      x = 0x07c5; a = 0x3f;
      m.charge(3); m.charge(2); m.charge(4); m.charge(3);
      if (m.peek(0x102d) === 0) {
        x = 0x07d8;
        m.charge(3);
      }
      b = 3;
      m.charge(2); m.charge(3);
    }
  }
  // $D093: sta ,x+ / decb / bne (B = 0 would run 256 times; never here)
  do {
    m.poke(x, a);
    x += 1;
    b = (b - 1) & 0xff;
    m.charge(6); m.charge(2); m.charge(3);
  } while (b !== 0);
  // $D098: lda <$2E / bne $D0B2
  m.charge(4); m.charge(3);
  if (m.peek(0x102e) === 0) {
    // $D09C: lda #$3F / sta $07C5 / $07C6 / $07C7
    a = 0x3f;
    m.poke(0x07c5, a);
    m.poke(0x07c6, a);
    m.poke(0x07c7, a);
    m.charge(2); m.charge(5); m.charge(5); m.charge(5);
  } else {
    a = 0x00; // $D0B2: lda #0 / bra $D0A7
    m.charge(2); m.charge(3);
  }
  // $D0A7: ldx #$07E4 / ldb #7 / sta ,x+ / decb / bne / rts
  m.charge(3); m.charge(2);
  for (let i = 0; i < 7; i += 1) {
    m.poke(0x07e4 + i, a);
    m.charge(6); m.charge(2); m.charge(3);
  }
  m.charge(5);
}

/**
 * $D0C6 update_play_clock: the BCD play clock, one frame per call:
 * $09F8 frames (wraps at $60), $09F9 seconds ($60), $09FA minutes ($60),
 * $09FB hours ($18). Each digit is `adda #1 / daa`, so a non-BCD value
 * is carried the way DAA does it.
 * @see gaplus-main.asm $D0C6
 * @param {Machine} m
 */
export function update_play_clock(m) {
  const digits = [[0x09f8, 0x60], [0x09f9, 0x60], [0x09fa, 0x60],
    [0x09fb, 0x18]];
  for (const [addr, wrap] of digits) {
    // lda / adda #1 / daa / sta / suba #wrap / bne rts / clr
    const s = add8(m.peek(addr), 1);
    const v = daa(s.v, s.cc).v;
    m.poke(addr, v);
    for (const c of [5, 2, 2, 5, 2, 3]) m.charge(c);
    if (v !== wrap) break;
    m.peek(addr);
    m.poke(addr, 0);
    m.charge(7);
  }
  m.charge(5); // rts
}

/**
 * $D107 update_p1_time: while player 1 plays, count $09FC frames (binary,
 * wraps at 60), $09FD seconds (60), $09FE minutes (no limit).
 * @see gaplus-main.asm $D107
 * @param {Machine} m
 */
export function update_p1_time(m) {
  // $D107: lda <$2D / bne rts
  m.charge(4); m.charge(3);
  if (m.peek(0x102d) === 0) {
    for (const addr of [0x09fc, 0x09fd]) {
      // lda / adda #1 / sta / suba #$3C / bne rts / clr
      const v = (m.peek(addr) + 1) & 0xff;
      m.poke(addr, v);
      m.charge(5); m.charge(2); m.charge(5); m.charge(2); m.charge(3);
      if (v !== 0x3c) {
        m.charge(5);
        return;
      }
      m.poke(addr, 0);
      m.charge(7);
    }
    // $D129: lda $09FE / adda #1 / sta $09FE / bra rts
    m.poke(0x09fe, (m.peek(0x09fe) + 1) & 0xff);
    m.charge(5); m.charge(2); m.charge(5); m.charge(3);
  }
  m.charge(5);
}

/**
 * Clear the sound request and state bytes from X up to (not including)
 * `end`: `clr $20,x / clr ,x+ / cmpx #end / bne` (22 cycles a byte),
 * yielding SYNC before each store.
 * @param {Machine} m @param {number} x @param {number} end
 * @returns {Generator<symbol, number, unknown>} X at the end
 */
function* clearSounds(m, x, end) {
  do {
    yield* busy(m, 0);
    m.poke(x + 0x20, 0);
    m.charge(7);
    yield* busy(m, 0);
    m.poke(x, 0);
    x += 1;
    m.charge(8); m.charge(4); m.charge(3);
  } while (x !== end);
  return x;
}

/**
 * $DF19 sound_all_off: clear every sound request $6040-$605F and its
 * state byte $6060-$607F (each pair state first, then request). Called
 * only from foreground code, where the sound CPU's IRQ handler reads the
 * same bytes concurrently: it yields SYNC before each store (charged time
 * = the cycle that instruction starts).
 * @see gaplus-main.asm $DF19
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* sound_all_off(m) {
  m.charge(3); // ldx #$6040
  yield* clearSounds(m, 0x6040, 0x6060);
  m.charge(5);
}

/**
 * $DF27 sound_demo_gate: clear sound requests (and their state bytes)
 * according to the demo-sounds DIP (58XX $6817 bit 3):
 *
 *  - bit set: every sound except $16 (the coin sound $6056);
 *  - bit clear: only $00-$10, $12-$15 and $18, i.e. $11, $16, $17 and
 *    $19-$1F keep playing (the ROM skips them with LEAX; $18 is cleared
 *    by the final `clr $20,x / clr ,x` with X = $6058).
 * Yields SYNC before each store (the sound CPU's IRQ reads these bytes);
 * irq_main runs it through.
 * @see gaplus-main.asm $DF27
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* sound_demo_gate(m) {
  // $DF27: ldx #$6040 / lda $6817 / anda #8 / bne $DF4F
  m.charge(3);
  yield* busy(m, 0);
  const dip = m.peek(0x6817);
  m.charge(5); m.charge(2); m.charge(3);
  if (dip & 0x08) {
    // $DF4F: $6040-$6055, leax 1,x, then sound_all_off's loop from $6057
    yield* clearSounds(m, 0x6040, 0x6056);
    m.charge(5); m.charge(3);
    yield* clearSounds(m, 0x6057, 0x6060);
    m.charge(5);
    return;
  }
  // $DF31: $6040-$6050 / leax 1 / $6052-$6055 / leax 2 / $6058
  yield* clearSounds(m, 0x6040, 0x6051);
  m.charge(5);
  yield* clearSounds(m, 0x6052, 0x6056);
  m.charge(5);
  yield* busy(m, 0);
  m.poke(0x6078, 0);
  m.charge(7);
  yield* busy(m, 0);
  m.poke(0x6058, 0);
  m.charge(6); m.charge(5);
}

/**
 * Body of $DF6B, shared by clear_sprite_shadows and _all: clear the flag
 * bytes (`clr ,x++`) from X to $1F17, $1F1F-$1F26 and $1F2D-$1F34, then
 * the Y/X words (`std ,u++`) from U to $1716, $171E-$1725 and
 * $172C-$1735, and finally $172E = $0800. Yields BUSY before every write
 * (it is also called from busy foreground code, start_game_1p).
 * @param {Machine} m @param {number} x @param {number} u
 * @returns {Generator<symbol, void, unknown>}
 */
function* clearShadows(m, x, u) {
  for (const [from, end] of [[x, 0x1f17], [0x1f1f, 0x1f27],
    [0x1f2d, 0x1f35]]) {
    for (let p = from; p !== end; p += 2) {
      yield* busy(m, 0);
      m.poke(p, 0);
      m.charge(9); m.charge(4); m.charge(3); // clr ,x++ / cmpx / bne
    }
    m.charge(3); // ldx (or ldd #0 after the third run)
  }
  for (const [from, end] of [[u, 0x1716], [0x171e, 0x1726],
    [0x172c, 0x1736]]) {
    for (let p = from; p !== end; p += 2) {
      yield* busy(m, 0);
      m.poke16(p, 0);
      m.charge(8); m.charge(5); m.charge(3); // std ,u++ / cmpu / bne
    }
    m.charge(3); // ldu (or ldd #$0800 after the third run)
  }
  yield* busy(m, 0);
  m.poke16(0x172e, 0x0800);
  m.charge(6); m.charge(5); // std $172E / rts
}

/**
 * $DF5D clear_sprite_shadows: take every sprite shadow entry but the
 * player's (entry 0) out of use: flags from $1E03 and positions from
 * $1602 (see clearShadows for the ranges).
 * @see gaplus-main.asm $DF5D
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* clear_sprite_shadows(m) {
  m.charge(3); m.charge(3); m.charge(3); // ldx #$1E03 / ldu #$1602 / bra
  yield* clearShadows(m, 0x1e03, 0x1602);
}

/**
 * $DF65 clear_sprite_shadows_all: the same including the player (flags
 * from $1E01, positions from $1600).
 * @see gaplus-main.asm $DF65
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* clear_sprite_shadows_all(m) {
  m.charge(3); m.charge(3); // ldx #$1E01 / ldu #$1600
  yield* clearShadows(m, 0x1e01, 0x1600);
}

/** Every routine of this file by entry address. */
export const ROUTINES = {
  0xc000: irq_main,
  0xc0ab: irq_copy_sprites,
  0xc163: round_select,
  0xc1b9: coin_jammed,
  0xd07a: irq_timers,
  0xd0c6: update_play_clock,
  0xd107: update_p1_time,
  0xdf19: sound_all_off,
  0xdf27: sound_demo_gate,
  0xdf5d: clear_sprite_shadows,
  0xdf65: clear_sprite_shadows_all,
};

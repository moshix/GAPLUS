// Copyright 2026 by Moshix
/**
 * gp2-4.8d ($A000-$BFFF), part 2 of 2: the service (test) mode and its
 * helpers, $B6F6-$BE77.
 *
 * service_mode is entered by a jump, from reset_main ($E1CF) when the
 * service switch is on at boot and from the main IRQ handler ($C016)
 * when it is switched on later. It re-initialises like reset (sub and
 * sound CPUs held, main IRQ off for good), then:
 *
 *   $B709  delay_65536 (31.1 frames)
 *   $B73C  RAM test $0000-$1FFF: 15 passes, pattern = ROM word at
 *          $E000+addr plus $000B, $111C, ... $EEF9 (~204 frames)
 *   $B771  screen cleared ($00/$20 words), $0400-$1FFF zeroed; the
 *          result digit '1'-'5' ('5' = good) goes to $0326
 *   $B7A2  if good: the same test on $6040-$63FF, '0' at $0326
 *   $B7F4  56XX/58XX self-test commands, delay_65536 x 2, results at
 *          $02E6; 62XX check
 *   $B85F  ROM checksums of $A000, $C000, $E000 (result at $0306)
 *   $B8B5  sub and sound CPUs released; $11/$22 handshakes; their ROM
 *          check results
 *   $B8E8  56XX mode 1 / 58XX mode 4, the switches into boot_switches,
 *          "RAM OK ROM OK" when every result is '0'
 *   $B970  the DIP-switch screen, then service_loop, which redraws it
 *          ~8 times a frame and runs the sound test / cross hatch; the
 *          service switch off jumps to reset_main.
 *
 * Everything runs with the main IRQ off, so the port counts the 6809's
 * cycles (gp2_4_clock.js) and yields at every frame boundary, before
 * the next access. Instruction cycles are the oracle's (MAME's table),
 * quoted as `(n)` after each instruction; every loop total was checked
 * against the oracle (test/oracle/main-gp2_4-svc.test.mjs).
 *
 * ROM quirks reproduced: the sound-RAM and 56XX/58XX error paths load
 * the error digit into B (`LDD #$2031`..`#$2036`) but store A = $20 (a
 * blank), so those errors never show and count as passed in the "RAM
 * OK" check ($B926 masks with $0F, and $20 & $0F = 0).
 *
 * @see reference/gaplus-main.asm $B6F6-$BE77
 */

import { disp8 } from '../m6809ops.js';
import { requestJump } from './jump.js';
import { CYCLES_PER_FRAME } from '../../machine/machine.js';
import {
  Clock, SPIN, sync, advanceTo, freeClock, runFree,
} from './gp2_4_clock.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/** `LEAX n,X` etc.: 16-bit wrap. @param {number} v @param {number} d */
const add16 = (v, d) => (v + d) & 0xffff;

/**
 * Cycles of one delay_65536 from its first instruction to the end of its
 * RTS: PSHS D (7) + LDD #0 (3) + 65,536 x [LDY WATCHDOG (7) INCA (2)
 * BNE (3)] + 256 x [INCB (2) BNE (3)] + PULS D (7) + RTS (5). The call
 * instruction (JSR 8, LBSR 9) is the caller's.
 */
export const DELAY_CYCLES = 787734;

/**
 * The handshakes after the release of the sub and sound CPUs ($B8B5).
 *
 * On the oracle (MAME's scheduler) the sub and sound CPUs restart at the
 * main CPU's time right after `STA SRESET_OFF` (the start of $B8B8,
 * "T0"), and store their `$22` a fixed number of their own cycles later
 * (their reset code and ROM checksums): WRITE_SOUND / WRITE_SUB below,
 * measured from T0 to the start of the storing instruction (the same on
 * every path measured but power-on, which is 2 cycles earlier and
 * changes nothing). The main CPU sees the store only from the next time
 * slice on: MAME runs the CPUs one after the other in slices (main first)
 * that start at vblank, at the I/O timer (vblank + 76.8 cycles) and every
 * 256 cycles after it. So the poll loop ends at the first poll that
 * STARTS at or after the end of the slice holding the store (checked on
 * the oracle for the power-on and IRQ entries and eight error paths,
 * whose releases fall at different points of the slices).
 */
export const HANDSHAKE = Object.freeze({
  /** reset_sound's `$22` store, cycles after T0. */
  WRITE_SOUND: 147496,
  /** reset_sub's `$22` store, cycles after T0. */
  WRITE_SUB: 319552,
});

/** MAME's slices: 256 cycles from the I/O timer at vblank + 76.8. */
const SLICE = 256;
/** The I/O chips' timer, cycles after vblank. */
const IO_TIMER = 76.8;

/**
 * End of the scheduler slice holding in-frame cycle `w` (see HANDSHAKE):
 * slices are [0, 76.8), then 256 cycles each from 76.8, the last one cut
 * at the next vblank (FRAME).
 * @param {number} w cycle since vblank
 * @returns {number} the next slice boundary after w (may be fractional)
 */
export function sliceEnd(w) {
  if (w < IO_TIMER) return IO_TIMER;
  return Math.min(IO_TIMER + SLICE * (Math.floor((w - IO_TIMER) / SLICE) + 1),
    CYCLES_PER_FRAME);
}

// ------------------------------------------------------------ helpers

/**
 * A store at the clock's current time: sync, write, spend `cyc`.
 * @param {Machine} m @param {Clock} c @param {number} addr
 * @param {number} v @param {number} cyc
 * @returns {Generator<unknown, void, unknown>}
 */
function* st(m, c, addr, v, cyc) {
  yield* sync(c);
  m.poke(addr, v);
  c.t += cyc;
}

/**
 * A load at the clock's current time (I/O and RAM both: the value must
 * be the one of the right frame).
 * @param {Machine} m @param {Clock} c @param {number} addr
 * @param {number} cyc
 * @returns {Generator<unknown, number, unknown>}
 */
function* ld(m, c, addr, cyc) {
  yield* sync(c);
  const v = m.peek(addr);
  c.t += cyc;
  return v;
}

/**
 * delay_65536 on a clock: the watchdog reads (two per `LDY`) and the
 * time. Nothing else is observable, so the frames are yielded at the
 * caller's next access.
 * @param {Machine} m @param {Clock} c
 */
function delayOn(m, c) {
  for (let i = 0; i < 0x10000; i += 1) m.peek16(0x7c00);
  c.t += DELAY_CYCLES;
}

/**
 * delay_65536 ($BE25): busy wait of 787,734 cycles (31.08 frames) with
 * 65,536 `LDY WATCHDOG` (two watchdog reads each); D is preserved (PSHS
 * D / PULS D), nothing else changes. The time is burned on the main
 * foreground clock (src/game/clock.js); the caller burns its own JSR (8)
 * / LBSR (9).
 * @see gaplus-main.asm $BE25
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
export function* delay_65536(m) {
  const c = new Clock(m);
  delayOn(m, c);
  yield* sync(c);
}

/**
 * fill_tilemap_00_20 on a clock ($B77C, entered by BSR/JSR: the call's
 * cycles are the caller's).
 * @param {Machine} m @param {Clock} c
 * @returns {Generator<unknown, number, unknown>} X = $0400
 */
function* fillTilemapOn(m, c) {
  c.t += 3 + 3; // ldx #0 (3) / ldu #$0020 (3)
  for (let x = 0; x !== 0x400; x += 2) {
    m.peek16(0x7c00); // ldy WATCHDOG (7)
    c.t += 7;
    yield* sync(c);
    m.poke16(x, 0x0020); // stu ,x++ (8)
    c.t += 8 + 4 + 3; // cmpx #$0400 (4) / bne (3)
  }
  c.t += 5; // rts
  return 0x0400;
}

/**
 * fill_tilemap_00_20 ($B77C): fill $0000-$03FF with the word $0020 (tile
 * code $00 at even, $20 at odd addresses), one watchdog read (`LDY
 * WATCHDOG`, two bytes) per word. Returns X = $0400, where the service
 * mode's zero fill continues.
 * @see gaplus-main.asm $B77C
 * @param {Machine} m
 * @returns {{ x: number }}
 */
export function fill_tilemap_00_20(m) {
  return { x: runFree(fillTilemapOn(m, freeClock(m))) };
}

/**
 * print_string on a clock ($BA2F; the call's cycles are the caller's).
 * @param {Machine} m @param {Clock} c @param {number} x @param {number} u
 * @returns {Generator<unknown, number, unknown>} X past the terminator
 */
function* printOn(m, c, x, u) {
  for (;;) {
    yield* sync(c);
    const a = m.read(x); // lda ,x+ (6)
    x = add16(x, 1);
    c.t += 6 + 3; // bne (3)
    if (a === 0) { c.t += 5; return x; } // rts
    yield* sync(c);
    m.poke(u, a); // sta ,u (4)
    u = add16(u, -0x20);
    c.t += 4 + 5 + 3; // leau -$20,u (5) / bra (3)
  }
}

/**
 * print_string ($BA2F): print the zero-terminated string at X to the
 * tile address U going right (U -= $20 per character).
 * @see gaplus-main.asm $BA2F
 * @param {Machine} m
 * @param {{ x: number, u: number }} regs
 * @returns {{ x: number, u: number }} X past the terminator, U past the
 *   last character
 */
export function print_string(m, { x, u }) {
  // U is recomputed here: the string's length times -$20.
  const x1 = runFree(printOn(m, freeClock(m), x, u));
  return { x: x1, u: add16(u, -0x20 * (x1 - x - 1)) };
}

/**
 * sub_BE1D on a clock: 16 x `STX ,U++`.
 * @param {Machine} m @param {Clock} c @param {number} x @param {number} u
 * @returns {Generator<unknown, number, unknown>} U
 */
function* be1dOn(m, c, x, u) {
  c.t += 2; // lda #$10
  for (let a = 0x10; a > 0; a -= 1) {
    yield* sync(c);
    m.poke16(u, x); // stx ,u++ (8)
    u = add16(u, 2);
    c.t += 8 + 2 + 3; // deca (2) / bne (3)
  }
  c.t += 5; // rts
  return u;
}

/**
 * sub_BE15 on a clock: $6564 x 16 then $6766 x 16 (falls into sub_BE1D).
 * @param {Machine} m @param {Clock} c @param {number} u
 * @returns {Generator<unknown, number, unknown>} U
 */
function* be15On(m, c, u) {
  c.t += 3 + 7; // ldx #$6564 (3) / bsr sub_BE1D (7)
  u = yield* be1dOn(m, c, 0x6564, u);
  c.t += 3; // ldx #$6766
  return yield* be1dOn(m, c, 0x6766, u);
}

/**
 * draw_test_grid on a clock ($BE01): the cross hatch over $0000-$03FF.
 * @param {Machine} m @param {Clock} c
 * @returns {Generator<unknown, number, unknown>} U = $0400
 */
function* gridOn(m, c) {
  c.t += 3 + 7; // ldu #0 (3) / bsr sub_BE15 (7)
  let u = yield* be15On(m, c, 0);
  c.t += 2; // ldb #$0E
  for (let b = 0x0e; b > 0; b -= 1) {
    c.t += 3 + 7; // ldx #$6567 / bsr sub_BE1D
    u = yield* be1dOn(m, c, 0x6567, u);
    c.t += 3 + 7; // ldx #$6466 / bsr sub_BE1D
    u = yield* be1dOn(m, c, 0x6466, u);
    c.t += 2 + 3; // decb / bne
  }
  // Falls through into sub_BE15, whose sub_BE1D's RTS returns.
  return yield* be15On(m, c, u);
}

/**
 * sub_BE1D ($BE1D): store the word X 16 times from U up (`STX ,U++`).
 * @see gaplus-main.asm $BE1D
 * @param {Machine} m
 * @param {{ x: number, u: number }} regs
 * @returns {{ a: number, u: number }} A = 0 (the DECA count)
 */
export function sub_BE1D(m, { x, u }) {
  return { a: 0, u: runFree(be1dOn(m, freeClock(m), x, u)) };
}

/**
 * sub_BE15 ($BE15): 16 x $6564 then 16 x $6766 from U up: one row pair
 * of the cross hatch (tiles $64-$67).
 * @see gaplus-main.asm $BE15
 * @param {Machine} m
 * @param {{ u: number }} regs
 * @returns {{ a: number, x: number, u: number }}
 */
export function sub_BE15(m, { u }) {
  return { a: 0, x: 0x6766, u: runFree(be15On(m, freeClock(m), u)) };
}

/**
 * draw_test_grid ($BE01): the cross-hatch test pattern over the whole
 * tilemap $0000-$03FF (codes only; attributes untouched).
 * @see gaplus-main.asm $BE01
 * @param {Machine} m
 * @returns {{ a: number, b: number, x: number, u: number }}
 */
export function draw_test_grid(m) {
  return { a: 0, b: 0, x: 0x6766, u: runFree(gridOn(m, freeClock(m))) };
}

// ------------------------------------------------------------ easter egg

/**
 * easter_egg on a clock ($BE37, after the caller's JSR). Never returns.
 * @param {Machine} m @param {Clock} c
 * @returns {Generator<unknown, never, unknown>}
 */
function* easterOn(m, c) {
  c.t += 3 + 3; // ldu #0 (3) / ldd #$2020 (3)
  for (let u = 0; u !== 0x400; u += 2) {
    m.peek16(0x7c00); // ldy WATCHDOG (7)
    c.t += 7;
    yield* sync(c);
    m.poke16(u, 0x2020); // std ,u++ (8)
    c.t += 8 + 5 + 3; // cmpu #$0400 (5) / bne (3)
  }
  c.t += 3 + 3; // ldu #$0040 / ldx #easter_egg_bitmap
  // $BE4F: one bitmap byte per 8 tiles; a set bit (tested as bit 7
  // before ASLA) stores the WORD $3020 at U -- '0' at U and a blank at
  // U+1, which the next bit's word may overwrite -- and U advances by 1.
  let u = 0x40;
  let x = 0xbe78;
  for (;;) {
    let a = m.read(x); // lda ,x (4)
    c.t += 4 + 2; // ldb #$08 (2)
    for (let b = 8; b > 0; b -= 1) {
      m.peek16(0x7c00); // ldy WATCHDOG (7)
      c.t += 7 + 2 + 3; // cmpa #$80 (2) / bcs (3)
      if (a >= 0x80) {
        c.t += 4; // ldy #$3020 (4)
        yield* sync(c);
        m.poke16(u, 0x3020); // sty ,u (6)
        c.t += 6;
      }
      u = add16(u, 1);
      c.t += 5 + 5 + 3; // leau 1,u (5) / cmpu #$03C0 (5) / beq (3)
      if (u === 0x3c0) {
        // lBE72: ldy WATCHDOG (7) / bra (3) forever: the machine hangs
        // here (kicking the watchdog) until it is switched off. The
        // port burns 2,534 passes (25,340 cycles) at a time.
        for (;;) {
          for (let i = 0; i < 2534; i += 1) m.peek16(0x7c00);
          c.t += 25340;
          yield* sync(c);
        }
      }
      a = (a << 1) & 0xff; // asla (2)
      c.t += 2 + 2 + 3; // decb (2) / bne (3)
    }
    x = add16(x, 1);
    c.t += 5 + 3; // leax 1,x (5) / bra (3)
  }
}

/**
 * easter_egg ($BE37): the hidden screen of the service mode (sound test
 * on $09 with the stick up-left, or $19 with it left, with start 1 and
 * fire held: $6801 & $0272 & $0252 = '9' and $6803 = 5): blanks the
 * tilemap and draws the bitmap $BE78 as '0' tiles, then hangs in a
 * watchdog-kicking loop for good.
 *
 * The time is burned on the main foreground clock (the caller burns
 * its JSR).
 * @see gaplus-main.asm $BE37
 * @param {Machine} m
 * @returns {Generator<unknown, never, unknown>}
 */
export function* easter_egg(m) {
  yield* easterOn(m, new Clock(m));
}

// ------------------------------------------------------ the test itself

/**
 * One RAM test pass pair ($B73C / $B7A5): write every word of [lo, hi)
 * with (ROM word at addr + rom) + D, then read it all back.
 * @param {Machine} m @param {Clock} c
 * @param {number} lo @param {number} hi @param {number} rom ROM offset
 *   (`LDX -$2000,U` / `LDX $7FC0,U`)
 * @param {number} d0 D at entry (the first pattern offset)
 * @returns {Generator<unknown, { u: number, x: number, d: number,
 *   ok: boolean }, unknown>} U after the failing word (ok false) or
 *   hi (all passes good); X the last expected value; D the pattern
 */
function* ramTest(m, c, lo, hi, rom, d0) {
  let d = d0;
  let x = 0;
  for (;;) {
    c.t += 3; // ldu #lo
    for (let u = lo; u !== hi; u += 2) {
      m.peek16(0x7c00); // ldy WATCHDOG (7)
      // ldx -$2000,u (9) / leax d,x (8): the pattern is ROM + D
      x = (m.read16(add16(u, rom)) + d) & 0xffff;
      c.t += 7 + 9 + 8;
      yield* sync(c);
      m.poke16(u, x); // stx ,u++ (8)
      c.t += 8 + 5 + 3; // cmpu (5) / bne (3)
    }
    c.t += 3; // ldu #lo
    for (let u = lo; u !== hi;) {
      m.peek16(0x7c00);
      x = (m.read16(add16(u, rom)) + d) & 0xffff;
      c.t += 7 + 9 + 8;
      yield* sync(c);
      const got = m.peek16(u); // cmpx ,u++ (9)
      u += 2;
      c.t += 9 + 3; // bne (3)
      if (got !== x) return { u, x, d, ok: false };
      c.t += 5 + 3; // cmpu / bne
    }
    // addd #$1111 (4) / bcs (3): until D overflows
    d += 0x1111;
    c.t += 4 + 3;
    if (d > 0xffff) return { u: hi, x, d: d & 0xffff, ok: true };
    c.t += 3; // bra
  }
}

/**
 * Busy-poll a byte another CPU sets to $22 ($B8C0 / $B8D5: `LDA addr
 * (5) / LDY WATCHDOG (7) / CMPA #$22 (2) / BNE (3)`, 17 cycles a poll,
 * the first starting at `first`, absolute on the clock `c`). The clock
 * jumps to the poll that sees $22 on the oracle (HANDSHAKE; the first
 * poll starting at or after `poll`), then, if
 * the other CPU's port has not written $22 yet, `yield SPIN` until it
 * has.
 * @param {Machine} m @param {Clock} c @param {number} addr
 * @param {number} first absolute start of the first poll
 * @param {number} poll absolute start of the poll that sees the $22
 * @returns {Generator<unknown, void, unknown>}
 */
function* handshake(m, c, addr, first, poll) {
  const polls = Math.max(0, Math.ceil((poll - first) / 17));
  // Every earlier poll read addr (plain RAM, no effect) and kicked the
  // watchdog twice; the kicks are repeated.
  for (let i = 0; i < polls; i += 1) m.peek16(0x7c00);
  yield* advanceTo(c, first + polls * 17);
  while (m.peek(addr) !== 0x22) {
    m.peek16(0x7c00);
    yield SPIN;
  }
  m.peek16(0x7c00);
  c.t += 17;
}

/**
 * The poll (absolute on `c`) that first sees another CPU's store made
 * at absolute time `w`: the first of first + 17k that starts at or after
 * the end of the slice holding the store.
 * @param {number} t0 cycle since vblank at which `c` started
 * @param {number} first @param {number} w
 * @returns {number}
 */
function pollAfter(t0, first, w) {
  const inFrame = (t0 + w) % CYCLES_PER_FRAME;
  const end = w - inFrame + sliceEnd(inFrame);
  return first + 17 * Math.max(0, Math.ceil((end - first) / 17));
}

/**
 * The service mode from $B6F6 to the end of the first DIP screen, then
 * the loop. See the file header.
 * @param {Machine} m @param {Clock} c @param {number} a A at entry (the
 *   value the latch stores write)
 * @returns {Generator<unknown, unknown, unknown>}
 */
function* serviceOn(m, c, a) {
  m.sei(); // $B6F6: orcc #$10 (3)
  c.t += 3;
  yield* st(m, c, 0x8c00, a, 5); // SRESET_ON
  yield* st(m, c, 0x9400, a, 5); // FRESET_OFF
  yield* st(m, c, 0x7c00, a, 5); // IRQ_OFF_MAIN
  c.t += 2 + 6 + 4; // lda #$10 / tfr a,dp (6) / lds #$1600 (4)
  c.t += 9; // lbsr delay_65536
  delayOn(m, c);
  c.t += 3; // ldd #$0000
  yield* st(m, c, 0xa000, 0, 5); // STARFIELD
  yield* st(m, c, 0x1f7f, 0, 5); // FLIP_SCREEN
  yield* st(m, c, 0x6808, 0, 5); // 56XX command
  yield* st(m, c, 0x6818, 0, 5); // 58XX command
  c.t += 2; // ldb #$04
  // $B71D: 62XX bytes 8-15 = 4, 5, ... $0B (stb (5) / incb (2))
  for (let b = 4; b <= 0x0b; b += 1) {
    yield* st(m, c, 0x6820 + b + 4, b, 5);
    if (b < 0x0b) c.t += 2;
  }

  // $B73C: RAM test of $0000-$1FFF; the pattern source $E000+ is ROM.
  // D is still $000B from the INCB chain above (A = 0, B = $0B), so the
  // offsets are $000B, $111C, ... $EEF9: 15 passes, not 16 (the sixteenth
  // ADDD overflows).
  let r = yield* ramTest(m, c, 0x0000, 0x2000, 0xe000, 0x000b);
  let u = r.u;
  if (!r.ok) { u = add16(u, -2); c.t += 5; } // lB76F: leau -2,u
  // lB771: tfr u,d (6) / lsra x3 (2 each) / adda #$31 (2): '1'-'5'
  let acc = (((u >> 8) >> 3) + 0x31) & 0xff;
  c.t += 6 + 6 + 2;
  c.t += 7; // bsr fill_tilemap_00_20
  let x = yield* fillTilemapOn(m, c);
  c.t += 3 + 3; // bra lB78E / ldu #$0000
  for (; x !== 0x2000; x += 2) {
    m.peek16(0x7c00); // ldy WATCHDOG (7)
    c.t += 7;
    yield* sync(c);
    m.poke16(x, 0x0000); // stu ,x++ (8)
    c.t += 8 + 4 + 3; // cmpx #$2000 / bne
  }
  c.t += 2; // cmpa #$35
  if (acc === 0x35) {
    c.t += 5 + 3; // lbne (not taken) / ldd #$0000
    // $B7A5: the sound RAM $6040-$63FF, pattern ROM $E000+ ($7FC0,U)
    r = yield* ramTest(m, c, 0x6040, 0x6400, 0x7fc0, 0x0000); // 16 passes
    if (r.ok) {
      acc = 0x30; // lB7F2: lda #$30
      c.t += 2;
    } else {
      // lB7D8: tfr x,d (6) / eora -2,u (5) / beq (3): which byte is bad
      const hiBad = (((r.x >> 8) ^ m.peek(add16(r.u, -2))) & 0xff);
      c.t += 6 + 5 + 3;
      let code;
      if (hiBad !== 0) {
        c.t += 2 + 3; // cmpa #$10 / bcc
        code = hiBad >= 0x10 ? 0x2035 : 0x2036;
      } else {
        // lB7E7: eorb -1,u (5) / cmpb #$10 (2) / bcs (3)
        const loBad = ((r.x & 0xff) ^ m.peek(add16(r.u, -1))) & 0xff;
        c.t += 5 + 2 + 3;
        code = loBad < 0x10 ? 0x2036 : 0x2035;
      }
      // ROM quirk: the code is in B, but $B7F4 stores A = $20.
      acc = code >> 8;
      c.t += 3 + 3; // ldd #code / bra lB7F4
    }
  } else {
    c.t += 6; // lbne lB7F4 taken
  }

  // lB7F4: the result digit, then the 56XX/58XX self-test commands
  yield* st(m, c, 0x0326, acc, 5);
  c.t += 3 + 3 + 3; // ldd #$080F / ldu #$6808 / ldx #$6818
  yield* st(m, c, 0x6808, 0x08, 6); // sta ,u+
  c.t += 2; // lda #$05
  yield* st(m, c, 0x6818, 0x05, 6); // sta ,x+
  c.t += 9; // lbsr delay_65536
  delayOn(m, c);
  // lB809: stb ,u+ (6) / stb ,x+ (6) / cmpu #$6810 (5) / bne (3)
  for (let i = 9; i < 0x10; i += 1) {
    yield* st(m, c, 0x6800 + i, 0x0f, 6);
    yield* st(m, c, 0x6810 + i, 0x0f, 6 + 5 + 3);
  }
  c.t += 9; // lbsr delay_65536
  delayOn(m, c);
  // $B816: ldd IO56XX (6): $6800 then $6801
  yield* sync(c);
  let hiN = m.peek(0x6800) & 0x0f;
  let loN = m.peek(0x6801) & 0x0f;
  c.t += 6 + 2 + 2 + 5 + 3; // anda / andb / cmpd #$0609 / beq
  if (hiN !== 0x06 || loN !== 0x09) {
    acc = 0x20; // $B823: ldd #$2031 -- quirk: A = $20 is stored
    c.t += 3 + 3;
  } else {
    // lB828: ldd IO58XX (6)
    yield* sync(c);
    hiN = m.peek(0x6810) & 0x0f;
    loN = m.peek(0x6811) & 0x0f;
    c.t += 6 + 2 + 2 + 5 + 3;
    if (hiN !== 0x0f || loN !== 0x0f) {
      acc = 0x20; // $B835: ldd #$2032
      c.t += 3 + 3;
    } else {
      // lB83A: the 62XX reads F, E, 1 at $6821-$6823
      let good = false;
      if (((yield* ld(m, c, 0x6821, 5)) & 0x0f) === 0x0f) {
        c.t += 2 + 2 + 3;
        if (((yield* ld(m, c, 0x6822, 5)) & 0x0f) === 0x0e) {
          c.t += 2 + 2 + 3;
          good = ((yield* ld(m, c, 0x6823, 5)) & 0x0f) === 0x01;
          c.t += 2 + 2 + 3;
        } else {
          c.t += 2 + 2 + 3;
        }
      } else {
        c.t += 2 + 2 + 3;
      }
      if (good) {
        acc = 0x30; // lB85A: lda #$30
        c.t += 2;
      } else {
        acc = 0x20; // lB855: ldd #$2033
        c.t += 3 + 3;
      }
    }
  }
  yield* st(m, c, 0x02e6, acc, 5); // lB85C

  // $B85F: ROM checksums, one byte sum per 8 KB (`adda ,u+ (6) / ldy
  // WATCHDOG (7) / cmpu (5) / bne (3)`); each must be 0. A $A000 error
  // shows '3', $C000 '2', $E000 '1'.
  c.t += 3 + 3; // ldd #0 / ldu #$A000
  let digit = 0x30;
  const ends = [0xc000, 0xe000, 0x10000];
  const errs = [0x33, 0x32, 0x31];
  let base = 0xa000;
  for (let k = 0; k < 3; k += 1) {
    if (k > 0) c.t += 3; // ldd #0
    let sum = 0;
    for (let p = base; p < ends[k]; p += 1) {
      sum += m.read(p);
      m.peek16(0x7c00);
    }
    c.t += 21 * 0x2000 + 2 + 3; // loop / cmpa #0 (2) / bne (3)
    base = ends[k];
    if ((sum & 0xff) !== 0) { digit = errs[k]; break; }
  }
  c.t += 2; // lda #digit
  yield* st(m, c, 0x0306, digit, 5);
  // bra lB8B5 (3), except after the $E000 error (falls through)
  if (digit !== 0x31) c.t += 3;

  // lB8B5: release the sub and sound CPUs, $11 to both handshakes
  const rel = c.abs;
  yield* st(m, c, 0x8400, digit, 5); // SRESET_OFF
  const t0 = rel + 5; // T0: the other CPUs restart here
  c.t += 2; // lda #$11
  yield* st(m, c, 0x6040, 0x11, 5); // snd_request
  yield* st(m, c, 0x0800, 0x11, 5); // sub_handshake
  // $B8C0: wait for the sound CPU's $22
  let first = c.abs;
  yield* handshake(m, c, 0x6040, first,
    pollAfter(c.frame0, first, t0 + HANDSHAKE.WRITE_SOUND));
  // $B8CB: lda snd_rom_error (5) / beq (3) / lda #$37 / sta $0306
  if ((yield* ld(m, c, 0x6380, 5 + 3)) !== 0) {
    c.t += 2;
    yield* st(m, c, 0x0306, 0x37, 5);
  }
  // $B8D5: wait for the sub CPU's $22
  first = c.abs;
  yield* handshake(m, c, 0x0800, first,
    pollAfter(c.frame0, first, t0 + HANDSHAKE.WRITE_SUB));
  // $B8E0: lda sub_rom_error (5) / beq (3) / sta $0306 (5)
  const subErr = yield* ld(m, c, 0x0801, 5 + 3);
  if (subErr !== 0) yield* st(m, c, 0x0306, subErr, 5);

  // $B8E8: $0000 to $7820-$782F (main IRQ off latch, 16 writes)
  c.t += 3 + 3; // ldd #0 / ldx #$7820
  for (let p = 0x7820; p !== 0x7830; p += 2) {
    yield* sync(c);
    m.poke16(p, 0); // std ,x++ (8)
    c.t += 8 + 4 + 3; // cmpx / bne
  }
  yield* st(m, c, 0x6808, 0, 5);
  yield* st(m, c, 0x6818, 0, 5);
  c.t += 9; // lbsr delay_65536
  delayOn(m, c);
  c.t += 3; // ldd #$0104
  yield* st(m, c, 0x6808, 0x01, 5); // 56XX mode 1 (switches)
  yield* st(m, c, 0x6818, 0x04, 5); // 58XX mode 4 (DIPs)
  c.t += 9; // lbsr delay_65536
  delayOn(m, c);
  // $B90A: the four switch nibbles into boot_switches $1006-$1009
  c.t += 3 + 3; // ldu #$6800 / ldx #$1006
  for (let i = 0; i < 4; i += 1) {
    const v = (yield* ld(m, c, 0x6800 + i, 6 + 2)) & 0x0f;
    yield* st(m, c, 0x1006 + i, v, 6 + 5 + 3);
  }
  yield* st(m, c, 0x100a, 0, 6); // clr <var_100A (the sound number)
  c.t += 2; // lda #$30
  yield* st(m, c, 0x0272, 0x30, 5);
  yield* st(m, c, 0x0252, 0x30, 5);
  // $B926: all three results '0' (or blank, see the quirk)?
  let all = yield* ld(m, c, 0x0326, 5);
  all |= yield* ld(m, c, 0x0306, 5);
  all |= yield* ld(m, c, 0x02e6, 5);
  c.t += 2 + 3; // anda #$0F / bne
  if ((all & 0x0f) === 0) {
    // $B933: "RAM OK" / "ROM OK" over the result digits
    c.t += 2;
    yield* st(m, c, 0x02e6, 0x20, 5);
    c.t += 3;
    yield* st(m, c, 0x0322, 0x52, 5); // R
    yield* st(m, c, 0x0302, 0x41, 5); // A
    c.t += 2;
    yield* st(m, c, 0x02e2, 0x4d, 5); // M
    yield* st(m, c, 0x02e4, 0x4d, 5);
    c.t += 3;
    yield* st(m, c, 0x0324, 0x52, 5); // R
    yield* st(m, c, 0x0304, 0x4f, 5); // O
    c.t += 3;
    yield* st(m, c, 0x0326, 0x49, 5); // I
    yield* st(m, c, 0x0306, 0x4f, 5); // O
    c.t += 3;
    for (const p of [0x02a2, 0x02a4, 0x02a6]) yield* st(m, c, p, 0x4f, 5);
    for (const p of [0x0282, 0x0284, 0x0286]) yield* st(m, c, p, 0x4b, 5);
  }
  return yield* dipLoop(m, c);
}

/**
 * lB970 (the DIP screen) and service_loop, forever: each service_loop
 * pass ends by jumping back to lB970, until the service switch is off,
 * which jumps to reset_main ($E000).
 * @param {Machine} m @param {Clock} c
 * @returns {Generator<unknown, unknown, unknown>}
 */
function* dipLoop(m, c) {
  for (;;) {
    yield* dipScreen(m, c);
    c.t += 5; // lbra service_loop
    const out = yield* loopPass(m, c);
    if (out === 'reset') {
      // $BDA8: jmp reset_main (4) -- a non-local jump: the foreground
      // driver starts reset_main (which reloads S) in our place.
      c.t += 4;
      yield* sync(c);
      requestJump(m, 0xe000);
      return;
    }
  }
}

/**
 * lB970-$BA2C: easter egg check, then the DIP settings screen, also
 * storing them in RAM like the boot does (coinage, lives, rank,
 * cabinet, bonus).
 * @param {Machine} m @param {Clock} c
 * @returns {Generator<unknown, void, unknown>}
 */
function* dipScreen(m, c) {
  // lB970: lda $6801 (5) / anda #$0F (2) / ora $0272 (5) / anda $0252
  // (5) / suba #$39 (2) / bne (3)
  let a = (yield* ld(m, c, 0x6801, 5 + 2)) & 0x0f;
  a |= yield* ld(m, c, 0x0272, 5);
  a &= yield* ld(m, c, 0x0252, 5 + 2 + 3);
  if (a === 0x39) {
    const b = (yield* ld(m, c, 0x6803, 5 + 2 + 2 + 3)) & 0x0f;
    if (b === 0x05) {
      c.t += 8; // jsr easter_egg
      yield* easterOn(m, c);
    }
  }
  // lB98B: coin A setting ($6811 & 3) -> text and coinage_a
  a = yield* ld(m, c, 0x6811, 5);
  m.peek16(0x7c00); // ldy WATCHDOG (7)
  c.t += 7 + 2 + 2 + 3 + 6 + 3 + 9; // anda/asla/ldx/ldx a,x/ldu/lbsr
  let x = m.read16(disp8(0xba3b, (a & 3) << 1));
  x = yield* printOn(m, c, x, 0x0328);
  c.t += 5; // ldd ,x (5)
  yield* st(m, c, 0x1025, m.read(x), 0); // std <coinage_a (5)
  yield* st(m, c, 0x1026, m.read(add16(x, 1)), 5);
  // $B9A4: coin B ($6817 & 3)
  a = yield* ld(m, c, 0x6817, 5);
  c.t += 2 + 2 + 3 + 6 + 3 + 7; // anda/asla/ldx/ldx a,x/ldu/bsr
  x = m.read16(disp8(0xba9b, (a & 3) << 1));
  x = yield* printOn(m, c, x, 0x032a);
  c.t += 5;
  yield* st(m, c, 0x1027, m.read(x), 0); // std <coinage_b
  yield* st(m, c, 0x1028, m.read(add16(x, 1)), 5);
  c.t += 3 + 3 + 7; // ldx #"MYSHIP" / ldu / bsr
  yield* printOn(m, c, 0xbafb, 0x032c);
  // $B9C0: lives ($6811 >> 2 & 3) via dat_BB02 (3, 2, 4, 5)
  a = yield* ld(m, c, 0x6811, 5);
  c.t += 2 + 2 + 2 + 3 + 5; // lsra x2 / anda / ldx / lda a,x
  a = m.read(disp8(0xbb02, (a >> 2) & 3));
  yield* st(m, c, 0x1000, a, 4); // sta <lives_setting
  c.t += 2; // ora #$30
  yield* st(m, c, 0x024c, a | 0x30, 5);
  c.t += 3 + 3 + 7; // ldx #"RANK" / ldu / bsr
  yield* printOn(m, c, 0xbb06, 0x032e);
  // $B9DB: difficulty ($6814 & 7), shown as a digit and kept
  a = (yield* ld(m, c, 0x6814, 5 + 2 + 2)) & 0x07;
  yield* st(m, c, 0x028e, a | 0x30, 5);
  c.t += 2 + 3 + 5; // anda #7 / ldx #dat_BB0B / lda a,x
  yield* st(m, c, 0x1004, m.read(disp8(0xbb0b, a)), 4); // <difficulty
  // $B9EE: cabinet from the 62XX ($6820 bit 2): TABLE / UPRIGHT
  c.t += 3 + 3; // ldu #$0330 / ldx #"TABLE"
  a = (yield* ld(m, c, 0x6820, 5 + 2 + 3)) & 0x04;
  x = 0xbb1c;
  if (a !== 0) { x = 0xbb13; c.t += 3; } // "UPRIGHT"
  yield* st(m, c, 0x1005, a, 4); // sta <cabinet
  c.t += 7; // bsr print_string
  yield* printOn(m, c, x, 0x0330);
  c.t += 3 + 3 + 7; // ldu #$0332 / ldx #"SOUND" / bsr
  yield* printOn(m, c, 0xbb25, 0x0332);
  // $BA0A: bonus ($6812 & 7): three lines, then 3 setting bytes
  a = yield* ld(m, c, 0x6812, 5);
  c.t += 2 + 2 + 3 + 6 + 3 + 7; // anda/asla/ldx/ldx a,x/ldu/bsr
  x = m.read16(disp8(0xbb2b, (a & 7) << 1));
  x = yield* printOn(m, c, x, 0x0334);
  c.t += 3 + 7;
  x = yield* printOn(m, c, x, 0x0336);
  c.t += 3 + 7;
  x = yield* printOn(m, c, x, 0x0338);
  c.t += 8; // ldd ,x++ (8)
  yield* st(m, c, 0x1001, m.read(x), 0); // std <bonus_first
  yield* st(m, c, 0x1002, m.read(add16(x, 1)), 5);
  c.t += 4; // lda ,x
  yield* st(m, c, 0x1003, m.read(add16(x, 2)), 4); // sta <bonus_every
}

/**
 * One service_loop pass ($BD7B), up to its jump back to lB970 (or to
 * reset_main).
 * @param {Machine} m @param {Clock} c
 * @returns {Generator<unknown, 'b970' | 'reset', unknown>}
 */
function* loopPass(m, c) {
  // $BD7B: lda IO56XX (5) / anda #$08 (2) / beq (3)
  if (((yield* ld(m, c, 0x6800, 5 + 2 + 3)) & 0x08) !== 0) {
    c.t += 7; // bsr draw_test_grid
    yield* gridOn(m, c);
    c.t += 3 + 8; // ldd #0 / jsr delay_65536
    delayOn(m, c);
    // lBD8A: ldy WATCHDOG (7) / lda IO56XX (5) / anda (2) / beq (3)
    for (;;) {
      m.peek16(0x7c00);
      c.t += 7;
      const v = yield* ld(m, c, 0x6800, 5 + 2 + 3);
      if ((v & 0x08) !== 0) break;
    }
    c.t += 8; // jsr fill_tilemap_00_20
    yield* fillTilemapOn(m, c);
    c.t += 3 + 8; // ldd #0 / jsr delay_65536
    delayOn(m, c);
    c.t += 4; // jmp lB970
    return 'b970';
  }
  // lBDA1: lda $6814 (5) / anda #$08 (2) / bne (3)
  if (((yield* ld(m, c, 0x6814, 5 + 2 + 3)) & 0x08) === 0) return 'reset';
  // lBDAB: compare the nibbles of $6800-$6803 with boot_switches; a
  // change to a non-zero value steps the sound number (nibbles 0-2 only)
  // and plays it: INC snd_request+n, CLR the one before.
  c.t += 3 + 3; // ldu #$6800 / ldx #$1006
  let u = 0x6800;
  let x = 0x1006;
  for (;;) {
    let a = yield* ld(m, c, u, 6); // lda ,u+ (6)
    u += 1;
    c.t += 5; // cmpu #$6805
    if (u === 0x6805) { c.t += 6; return 'b970'; } // lbeq lB970 taken
    c.t += 5 + 2 + 3; // lbeq (not taken) / anda #$0F / bne
    a &= 0x0f;
    if (a === 0) {
      yield* st(m, c, x, 0, 6 + 3); // sta ,x+ (6) / bra (3)
      x += 1;
      continue;
    }
    // lBDC3: cmpa ,x+ (6) / beq (3)
    const old = yield* ld(m, c, x, 6 + 3);
    x += 1;
    if (a === old) continue;
    yield* st(m, c, x - 1, a, 5 + 5 + 3); // sta -1,x / cmpu #$6804 / beq
    if (u !== 0x6804) {
      // $BDCF: inc <$0A / lda / anda #$1F / sta: the next sound, 0-$1F
      let sel = ((yield* ld(m, c, 0x100a, 0)) + 1) & 0xff;
      yield* st(m, c, 0x100a, sel, 6);
      sel = (yield* ld(m, c, 0x100a, 4 + 2)) & 0x1f;
      yield* st(m, c, 0x100a, sel, 4);
      // $BDD7: the number as two hex digits (units at $0252, the tens
      // digit 0/1 at $0272)
      let digitLo = ((yield* ld(m, c, 0x100a, 4 + 2 + 2 + 2 + 3)) & 0x0f)
        | 0x30;
      if (digitLo >= 0x3a) { digitLo = (digitLo + 7) & 0xff; c.t += 2; }
      yield* st(m, c, 0x0252, digitLo, 5 + 2); // sta $0252 / ldb #$30
      const tens = (yield* ld(m, c, 0x100a, 4 + 2 + 3)) & 0x10;
      if (tens !== 0) c.t += 2; // ldb #$31
      yield* st(m, c, 0x0272, tens !== 0 ? 0x31 : 0x30, 5);
    }
    // lBDF3: lda #$60 (2) / ldb <$0A (4) / addb #$40 (2) / exg d,y (8)
    const n = yield* ld(m, c, 0x100a, 0);
    c.t += 2 + 4 + 2 + 8;
    const y = 0x6000 | ((n + 0x40) & 0xff);
    // inc ,y (6) / clr -1,y (7): one request on, the previous one off
    const req = yield* ld(m, c, y, 0);
    yield* st(m, c, y, (req + 1) & 0xff, 6);
    yield* ld(m, c, add16(y, -1), 0); // clr reads first
    yield* st(m, c, add16(y, -1), 0, 7 + 3); // + bra lBDB1 (3)
  }
}

/**
 * service_mode ($B6F6): the whole test mode. Entered by a jump
 * (reset_main $E1CF, irq_main $C016) with S reloaded; the caller has
 * burned the cycles up to $B6F6 on the main foreground clock
 * (src/game/clock.js), which the service mode keeps counting on. Never
 * returns: it ends with the non-local `JMP reset_main` ($BDA8), made with
 * requestJump (src/game/main/jump.js), when the service switch is off.
 *
 * `a` is the value the three latch stores at entry write (the board
 * ignores it).
 * @see gaplus-main.asm $B6F6
 * @param {Machine} m
 * @param {{ a?: number }} [regs]
 * @returns {Generator<unknown, unknown, unknown>}
 */
export function* service_mode(m, { a = 0 } = {}) {
  return yield* serviceOn(m, new Clock(m), a & 0xff);
}

/**
 * service_loop ($BD7B): one pass of the service mode's input loop, then
 * the DIP screen and the loop again, for as long as the service switch
 * is on (reached only by `LBRA` from the service mode; exported for the
 * registry and tests). Burns on the main foreground clock; leaves by
 * requestJump(m, $E000).
 * @see gaplus-main.asm $BD7B
 * @param {Machine} m
 * @returns {Generator<unknown, unknown, unknown>}
 */
export function* service_loop(m) {
  const c = new Clock(m);
  const out = yield* loopPass(m, c);
  if (out === 'reset') {
    c.t += 4; // jmp reset_main
    yield* sync(c);
    requestJump(m, 0xe000);
    return;
  }
  return yield* dipLoop(m, c);
}

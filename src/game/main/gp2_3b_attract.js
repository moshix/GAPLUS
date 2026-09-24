// Copyright 2026 by Moshix
/**
 * Boot-to-attract and the attract mode in main CPU ROM gp2-3b.8c
 * ($C296-$CCCF):
 *
 *   $C296  game_init        56XX coin mode, header, 62XX init (CWAIs),
 *                           high-score table, starfield -> attract_loop
 *   $C417  attract_loop     the busy attract loop (one pass per iteration)
 *   $C467  draw_credit      "CREDIT nn" on the bottom row
 *   $C492  attract_demo     phase 1: demo game at stage 0
 *   $C49F  attract_demo2    phase 3: demo game at stage 2, dual fighter
 *   $C4DA  push_start_1p    push-start screen, 1P only
 *   $C639  print_string_r   string at U from tile X, going right
 *   $C670  push_start_2p    push-start screen, 1 or 2 players
 *   $C811  clear_game_vars  / $C854 clear_playfield
 *   $C866  attract_phase0   title screen; $117A picks sub_C909 / sub_C91B
 *                           / sub_C952 / sub_C9AE (the logo animation)
 *   $CAA9  attract_phase2   TOP 5 table
 *
 * BUSY CONTEXT. attract_loop never waits: it goes round and round while
 * the vblank IRQ interrupts it wherever it happens to be (2-3 passes a
 * frame; attract_timer $1029 counts them). So everything a pass runs is a
 * generator that charges the cycles of every instruction (Machine.charge)
 * and yields BUSY right before every write and every read of the I/O
 * chips or of the IRQ-written frame counter, with m.charged[0] then equal
 * to the cycle at which that instruction starts. The scheduler takes the
 * IRQ at the first such point at or after vblank (gp2_3b_state.js).
 *
 * JUMPS. The pass routines return `{ a }` (register A, which the next
 * pass stores to the IRQ latch with `sta $7400`) when the 6809 jumps back
 * to attract_loop; when it jumps to start_game_1p/2p ($CCD0/$CDFF) they
 * call requestJump() and return, and attract_loop returns too.
 *
 * @see reference/gaplus-main.asm $C296-$CCCF
 */

import { mainAt } from './routines.js';
import { call } from '../call.js';
import { disp8 } from '../m6809ops.js';
import { ioRead, ioStore } from '../timing.js';
import {
  BUSY, SYNC, requestJump, pendingJump,
} from './gp2_3b_state.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {Generator<unknown, { a: number } | undefined, unknown>} Pass */

/** $C417 attract_loop. */
export const ATTRACT_LOOP = 0xc417;
/** $CCD0 start_game_1p. */
export const START_GAME_1P = 0xccd0;
/** $CDFF start_game_2p. */
export const START_GAME_2P = 0xcdff;

// ------------------------------------------------------------ bus helpers

/**
 * A store in busy code: yield BUSY (the instruction starts now), write,
 * then charge the instruction.
 * @param {Machine} m @param {number} addr @param {number} v
 * @param {number} cyc the instruction's cycles
 * @returns {Generator<symbol, void, unknown>}
 */
function* st(m, addr, v, cyc) {
  yield BUSY;
  m.poke(addr & 0xffff, v & 0xff);
  m.charge(cyc);
}

/**
 * A 16-bit store (STD/STX/STU: high byte first).
 * @param {Machine} m @param {number} addr @param {number} v
 * @param {number} cyc
 * @returns {Generator<symbol, void, unknown>}
 */
function* st16(m, addr, v, cyc) {
  yield BUSY;
  m.poke16(addr & 0xffff, v & 0xffff);
  m.charge(cyc);
}

/**
 * CLR on memory: the 6809 reads the operand first, then writes 0.
 * @param {Machine} m @param {number} addr @param {number} cyc
 * @returns {Generator<symbol, void, unknown>}
 */
function* clr(m, addr, cyc) {
  yield BUSY;
  m.peek(addr & 0xffff);
  m.poke(addr & 0xffff, 0);
  m.charge(cyc);
}

/**
 * INC on memory.
 * @param {Machine} m @param {number} addr @param {number} cyc
 * @returns {Generator<symbol, number, unknown>} the new value
 */
function* inc(m, addr, cyc) {
  yield BUSY;
  const v = (m.peek(addr) + 1) & 0xff;
  m.poke(addr, v);
  m.charge(cyc);
  return v;
}

/**
 * A read of the I/O chips or of IRQ-written RAM.
 * @param {Machine} m @param {number} addr @param {number} cyc
 * @returns {Generator<symbol, number, unknown>}
 */
function* rd(m, addr, cyc) {
  yield BUSY;
  const v = m.peek(addr);
  m.charge(cyc);
  return v;
}

/**
 * Print a zero-terminated string going right on screen (`lda ,u+ / beq /
 * sta ,x / leax -$20,x / bra`: 18 cycles a character, 9 for the end).
 * @param {Machine} m @param {number} x @param {number} u
 * @returns {Generator<symbol, { x: number, u: number }, unknown>}
 */
function* printRight(m, x, u) {
  for (;;) {
    const a = m.peek(u);
    u = (u + 1) & 0xffff;
    m.charge(6); m.charge(3);
    if (a === 0) return { x, u };
    yield* st(m, x, a, 4);
    x = (x - 0x20) & 0xffff;
    m.charge(5); m.charge(3);
  }
}

// ---------------------------------------------------------------- game_init

/**
 * $C296 game_init: after the boot (jumped to from $E1DB). 56XX to coin
 * mode (4), the tilemap $0000-$03FF to spaces (kicking the watchdog twice
 * a word with `ldy $7C00`), the "1UP HIGH SCORE 2UP" header (attribute 1)
 * and "00 50000 00"; then init_62xx ($C2FC): IRQ latch on, CLI, and the
 * 62XX set-up in modes 1, 2, 0, 3 with five CWAIs between steps (and a poll
 * of 62XX bytes 1 / 2 for $F). Then the high-score table from
 * hiscore_init_table ($C399), high score $005000, starfield on, start
 * presses discarded (56XX nibble 3 cleared until it reads 0), and on to
 * attract_loop (requestJump).
 *
 * Yields: undefined at each of the five CWAIs and once per failed pass of
 * the two 62XX polls; BUSY before each write once IRQs are enabled.
 * @see gaplus-main.asm $C296
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
export function* game_init(m) {
  // Before the IRQ is enabled nothing can interrupt this code, but it
  // runs ~35,000 cycles from late in a frame: every write yields SYNC
  // first (charged time = the cycle its instruction starts), so each one
  // lands in the frame it does on the board (the lockstep samples RAM at
  // every vblank).
  // $C296: lda #4 / sta $6808
  m.charge(2);
  yield SYNC;
  m.poke(0x6808, 0x04);
  m.charge(5); m.charge(3); m.charge(3); // + ldx #0 / ldd #$2020
  // $C2A1: ldy $7C00 (reads $7C00 and $7C01: two kicks) / std ,x++ /
  // cmpx #$0400 / bne
  for (let x = 0; x < 0x400; x += 2) {
    m.peek16(0x7c00);
    m.charge(7);
    yield SYNC;
    m.poke16(x, 0x2020);
    m.charge(8); m.charge(4); m.charge(3);
  }
  // $C2AC: ldx #$03C5 / ldu #str_header / ldb #1; loop: lda ,u+ / beq /
  // stb $0400,x / sta ,x+ / bra (the text is stored reversed)
  m.charge(3); m.charge(3); m.charge(2);
  let a = 0;
  for (let x = 0x03c5, u = 0xc2d0; ; x += 1, u += 1) {
    a = m.peek(u);
    m.charge(6); m.charge(3);
    if (a === 0) break;
    yield SYNC;
    m.poke(x + 0x400, 0x01);
    m.charge(8);
    yield SYNC;
    m.poke(x, a);
    m.charge(6); m.charge(3);
  }
  // $C2C0: ldx #$03E4 / ldu #str_header_scores; lda ,u+ / beq / sta ,x+
  m.charge(3); m.charge(3);
  for (let x = 0x03e4, u = 0xc2e7; ; x += 1, u += 1) {
    a = m.peek(u);
    m.charge(6); m.charge(3);
    if (a === 0) break;
    yield SYNC;
    m.poke(x, a);
    m.charge(6); m.charge(3);
  }
  m.charge(3); // $C2CE: bra init_62xx

  // $C2FC init_62xx: sta $7400 (A = 0, the string end) / andcc #$EF
  yield* st(m, 0x7400, a, 5);
  m.charge(3);
  m.cli();
  if (pendingJump(m) !== null) return;
  // $C301: ldx #$6828 / clr ,x+ / lda #$0F / sta ,x+ / clr ,x+ x4 /
  // ldb #5 / stb ,x+ / sta ,x
  m.charge(3);
  yield* clr(m, 0x6828, 8);
  m.charge(2);
  // sta ,x+ to the bang trigger: its write is the 6th cycle (index 5).
  yield BUSY;
  ioStore(m, 0x6829, 0x0f, 5);
  m.charge(6);
  for (let x = 0x682a; x <= 0x682d; x += 1) yield* clr(m, x, 8);
  m.charge(2);
  yield* st(m, 0x682e, 0x05, 6);
  yield* st(m, 0x682f, 0x0f, 4);
  m.charge(16);
  yield; // $C318: cwai #$EF
  // $C31A: lda #1 / sta $6828 / cwai
  m.charge(2);
  yield* st(m, 0x6828, 0x01, 5);
  m.charge(16);
  yield; // $C31F: cwai #$EF
  yield* poll62(m, 0x6821);
  // $C32A: ldx #$6828 / clr ,x+ / lda #$0F / sta ,x+ / clr ,x+ x2 /
  // ldb #1 / stb ,x+ / sta ,x+ / clr ,x+ / sta ,x
  m.charge(3);
  yield* clr(m, 0x6828, 8);
  m.charge(2);
  // sta ,x+ to the bang trigger: its write is the 6th cycle (index 5).
  yield BUSY;
  ioStore(m, 0x6829, 0x0f, 5);
  m.charge(6);
  yield* clr(m, 0x682a, 8);
  yield* clr(m, 0x682b, 8);
  m.charge(2);
  yield* st(m, 0x682c, 0x01, 6);
  yield* st(m, 0x682d, 0x0f, 6);
  yield* clr(m, 0x682e, 8);
  yield* st(m, 0x682f, 0x0f, 4);
  m.charge(16);
  yield; // $C341: cwai #$EF
  // $C343: lda #2 / sta $6828 / cwai
  m.charge(2);
  yield* st(m, 0x6828, 0x02, 5);
  m.charge(16);
  yield; // $C348: cwai #$EF
  yield* poll62(m, 0x6822);
  // $C353: clr $6828 / cwai
  yield* clr(m, 0x6828, 7);
  m.charge(16);
  yield; // $C356: cwai #$EF
  // $C358: lda #3 / sta $6828
  m.charge(2);
  yield* st(m, 0x6828, 0x03, 5);

  // $C35D: ldy #hiscore_init_table; ldx ,y++ / beq / ldu ,y++, then
  // lda ,u+ / beq (next entry) / sta ,x+ / bra
  m.charge(4);
  for (let y = 0xc399; ; y += 4) {
    const x0 = m.peek16(y);
    m.charge(8); m.charge(3);
    if (x0 === 0) break;
    let u = m.peek16(y + 2);
    m.charge(8);
    for (let x = x0; ; x += 1, u += 1) {
      const c = m.peek(u);
      m.charge(6); m.charge(3);
      if (c === 0) break;
      yield* st(m, x, c, 6);
      m.charge(3);
    }
  }
  // $C36F: high score $005000; $1170 = 0; starfield control
  m.charge(2);
  yield* st(m, 0x09b7, 0x05, 5);
  yield* clr(m, 0x1170, 7);
  for (const [addr, v] of [[0xa000, 0xff], [0xa001, 0x87], [0xa003, 0x06],
    [0xa002, 0x85]]) {
    m.charge(2);
    yield* st(m, addr, v, 5);
  }
  // $C38B: lda $6803 / anda #$0F / lbeq attract_loop / clr $6803 / bra
  for (;;) {
    const c = (yield* rd(m, 0x6803, 5)) & 0x0f;
    m.charge(2);
    if (c === 0) {
      m.charge(6);
      requestJump(m, ATTRACT_LOOP);
      return;
    }
    m.charge(5);
    yield* clr(m, 0x6803, 7);
    m.charge(3);
  }
}

/**
 * $C321 / $C34A: wait until 62XX byte `addr` reads $F in its low nibble
 * (`lda / anda #$0F / cmpa #$0F / bne`, 12 cycles a pass). Yields once
 * per failed pass; only the pass that gets through is charged.
 * @param {Machine} m @param {number} addr
 * @returns {Generator<unknown, void, unknown>}
 */
function* poll62(m, addr) {
  while ((m.peek(addr) & 0x0f) !== 0x0f) yield;
  m.charge(5); m.charge(2); m.charge(2); m.charge(3);
}

// ------------------------------------------------------------- attract_loop

/**
 * $C417 attract_loop: the attract mode's main loop, for ever (until a
 * pass jumps to start_game_1p/2p, or an IRQ requests a jump). Entered by
 * a jump from game_init, the IRQ (coin during the demo), the demo's end
 * and game over.
 * @see gaplus-main.asm $C417
 * @param {Machine} m
 * @param {{ a?: number }} [regs] A on entry (stored to the IRQ latch by
 *   `sta $7400`; its value has no effect on the hardware)
 * @returns {Generator<unknown, void, unknown>}
 */
export function* attract_loop(m, regs = {}) {
  let a = regs.a ?? 0;
  for (;;) {
    const r = yield* attract_pass(m, { a });
    if (r === undefined || pendingJump(m) !== null) return;
    a = r.a;
  }
}

/**
 * One pass of attract_loop ($C417 up to its next `jmp attract_loop`):
 * IRQ latch on and CLI; draw_credit; with credits (56XX tens nibble, or
 * units 1 / 2+) or a start pressed (56XX nibble 3) go to the push-start
 * screen; otherwise attract_timer $1029 += $20 (keeping bits 5-7; on its
 * wrap attract_step $102A + 1, and on that wrap attract_phase $102B + 1)
 * and run phase attract_phase & 3 through attract_phases ($C45F).
 * @see gaplus-main.asm $C417
 * @param {Machine} m
 * @param {{ a: number }} regs A on entry
 * @returns {Pass} `{ a }` to go round again, undefined after a jump
 */
export function* attract_pass(m, { a }) {
  // $C417: sta $7400 / andcc #$EF / jsr draw_credit
  yield* st(m, 0x7400, a, 5);
  m.charge(3);
  m.cli();
  if (pendingJump(m) !== null) return undefined;
  m.charge(8);
  yield* draw_credit(m);
  // $C41F: ldd $6800 / anda #$0F / lbne push_start_2p / andb #$0F / beq
  // / decb / lbeq push_start_1p / jmp push_start_2p
  yield BUSY;
  const tens = m.peek(0x6800) & 0x0f;
  const units = ioRead(m, 0x6801, 5) & 0x0f; // LDD's second byte
  m.charge(6); m.charge(2);
  /** @type {Function} */
  let next;
  if (tens !== 0) {
    m.charge(6);
    next = push_start_2p;
  } else {
    m.charge(5); m.charge(2); m.charge(3);
    if (units !== 0) {
      m.charge(2);
      if (units === 1) {
        m.charge(6);
        next = push_start_1p;
      } else {
        m.charge(5); m.charge(4);
        next = push_start_2p;
      }
    } else {
      // $C434: lda $6803 / anda #$0F / lbne push_start_1p
      const s = (yield* rd(m, 0x6803, 5)) & 0x0f;
      m.charge(2);
      if (s !== 0) {
        m.charge(6);
        next = push_start_1p;
      } else {
        m.charge(5);
        // $C43D: lda $1029 / adda #$20 / anda #$E0 / sta $1029 / bne
        const t = (m.peek(0x1029) + 0x20) & 0xe0;
        m.charge(5); m.charge(2); m.charge(2);
        yield* st(m, 0x1029, t, 5);
        m.charge(3);
        if (t === 0) {
          // $C449: inc $102A / lda $102A / bne / inc $102B
          yield* inc(m, 0x102a, 7);
          const step = m.peek(0x102a);
          m.charge(5); m.charge(3);
          if (step === 0) yield* inc(m, 0x102b, 7);
        }
        // $C454: lda $102B / anda #3 / asla / ldx #attract_phases /
        // jmp [a,x] (a,x: signed offset; A <= 6 here)
        const ph = ((m.peek(0x102b) & 0x03) << 1) & 0xff;
        m.charge(5); m.charge(2); m.charge(2); m.charge(3); m.charge(7);
        const target = m.peek16(disp8(0xc45f, ph));
        const out = yield* call(mainAt(target), m, {});
        return /** @type {{ a: number } | undefined} */ (out);
      }
    }
  }
  const out = yield* call(next, m, {});
  return /** @type {{ a: number } | undefined} */ (out);
}

/**
 * $C467 draw_credit: "CREDIT" (stored reversed at $C48B) at $0038-$003D,
 * then the 56XX BCD credits: units at $0035, tens at $0036 (a space when
 * zero: `ora #$20 / cmpa #$20 / beq / ora #$10`).
 * @see gaplus-main.asm $C467
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* draw_credit(m) {
  // ldx #$0038 / ldu #str_credit; lda ,u+ / beq / sta ,x+ / bra
  m.charge(3); m.charge(3);
  let x = 0x0038;
  for (let u = 0xc48b; ; u += 1) {
    const c = m.peek(u);
    m.charge(6); m.charge(3);
    if (c === 0) break;
    yield* st(m, x, c, 6);
    x += 1;
    m.charge(3);
  }
  // $C475: ldd $6800 / andb #$0F / orb #$30 / stb -9,x
  yield BUSY;
  let a = m.peek(0x6800);
  const b = (ioRead(m, 0x6801, 5) & 0x0f) | 0x30; // LDD's second byte
  m.charge(6); m.charge(2); m.charge(2);
  yield* st(m, x - 9, b, 5);
  // anda #$0F / ora #$20 / cmpa #$20 / beq / ora #$10 / sta -8,x / rts
  a = (a & 0x0f) | 0x20;
  m.charge(2); m.charge(2); m.charge(2); m.charge(3);
  if (a !== 0x20) {
    a |= 0x10;
    m.charge(2);
  }
  yield* st(m, x - 8, a, 5);
  m.charge(5);
}

/**
 * $C492 attract_demo: attract phase 1: demo game from stage 0 without
 * the dual fighter: stage_p1 = 0, dual_fighter = 0, attract_flag = 1,
 * jmp start_game_1p.
 * @see gaplus-main.asm $C492
 * @param {Machine} m
 * @returns {Pass}
 */
export function* attract_demo(m) {
  yield* clr(m, 0x1106, 7);
  yield* clr(m, 0x10db, 6);
  return yield* demoStart(m);
}

/**
 * $C497: attract_flag = 1 / jmp start_game_1p.
 * @param {Machine} m
 * @returns {Pass}
 */
function* demoStart(m) {
  m.charge(2);
  yield* st(m, 0x09f4, 0x01, 5);
  m.charge(4);
  requestJump(m, START_GAME_1P);
  return undefined;
}

/**
 * $C49F attract_demo2: attract phase 3: demo game at stage index 2 with
 * the dual fighter: stage_p1 = 2, six shadow entries $0EC2-$0ECD = $F025
 * (flags $0081), dual_fighter = 1, $1171 = 0, then as attract_demo.
 * @see gaplus-main.asm $C49F
 * @param {Machine} m
 * @returns {Pass}
 */
export function* attract_demo2(m) {
  m.charge(2);
  yield* st(m, 0x1106, 0x02, 5);
  // ldx #$0EC2 / ldu #$F025 / ldd #$0081
  m.charge(3); m.charge(3); m.charge(3);
  for (let x = 0x0ec2; x < 0x0ece; x += 2) {
    yield* st16(m, x + 0x1000, 0x0081, 9); // std $1000,x
    yield* st16(m, x, 0xf025, 8); // stu ,x++
  }
  m.charge(2);
  yield* st(m, 0x10db, 0x01, 4);
  yield* clr(m, 0x1171, 7);
  m.charge(3);
  return yield* demoStart(m);
}

/**
 * $C4DA push_start_1p: one credit. Leave attract (attract_flag = 0); if
 * the screen is not blank at $039B/$036B clear the playfield; clear the
 * game variables; draw the push-start screen and wait for a start: 1P
 * start (56XX nibble 3 bit 0) -> start_game_1p, bit 1 -> start_game_2p,
 * else back to attract_loop.
 * @see gaplus-main.asm $C4DA
 * @param {Machine} m
 * @returns {Pass}
 */
export function* push_start_1p(m) {
  yield* clr(m, 0x09f4, 7);
  yield* blankCheck(m);
  // $C4ED: ldy #$C714 / ldu #$C692 / ldb #$10
  m.charge(4); m.charge(3); m.charge(2);
  return yield* pushStartBody(m, 0x10, null, 0xc692);
}

/**
 * $C4DD / $C673: lda $039B / ora $036B / cmpa #$20 / beq / jsr
 * clear_playfield; then jsr clear_game_vars.
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
function* blankCheck(m) {
  const t = m.peek(0x039b) | m.peek(0x036b);
  m.charge(5); m.charge(5); m.charge(2); m.charge(3);
  if (t !== 0x20) {
    m.charge(8);
    yield* clear_playfield(m);
  }
  m.charge(8);
  yield* clear_game_vars(m);
}

/**
 * $C4F6-$C636, the push-start screen proper (shared by both screens).
 * @param {Machine} m
 * @param {number} b the string counter B ($10 .. 0, step 2)
 * @param {number | null} x0 X for the first string (push_start_2p enters
 *   at $C4F8 with X set), or null to load it from dat_C714
 * @param {number} u the string list
 * @returns {Pass}
 */
function* pushStartBody(m, b, x0, u) {
  // $C4F6: ldx b,y (dat_C714 + B) -- then each string going right, its
  // attribute copied from the tile one row down: lda ,u+ / beq / sta ,x /
  // lda $0420,x / sta $0400,x / leax -$20,x / bra
  let x = x0;
  for (;;) {
    if (x === null) {
      x = m.peek16(disp8(0xc714, b));
      m.charge(6);
    }
    for (;;) {
      const c = m.peek(u);
      u = (u + 1) & 0xffff;
      m.charge(6); m.charge(3);
      if (c === 0) break;
      yield* st(m, x, c, 4);
      const at = m.peek((x + 0x420) & 0xffff);
      m.charge(8);
      yield* st(m, x + 0x400, at, 8);
      x = (x - 0x20) & 0xffff;
      m.charge(5); m.charge(3);
    }
    // $C50B: subb #2 / bcs $C511 / bra $C4F6
    const borrow = b < 2;
    b = (b - 2) & 0xff;
    m.charge(2); m.charge(3);
    if (borrow) break;
    m.charge(3);
    x = null;
  }
  // $C511: ldd #0 / std score_p1 / clr +2 / std score_p2 / clr +2
  m.charge(3);
  yield* st16(m, 0x09b0, 0, 6);
  yield* clr(m, 0x09b2, 7);
  yield* st16(m, 0x09b3, 0, 6);
  yield* clr(m, 0x09b5, 7);
  // $C520: lda #$20 / sta $03E6-$03EB, $03F8-$03FD (the two scores)
  m.charge(2);
  for (const t of [0x3e6, 0x3e7, 0x3e8, 0x3e9, 0x3ea, 0x3eb, 0x3f8, 0x3f9,
    0x3fa, 0x3fb, 0x3fc, 0x3fd]) yield* st(m, t, 0x20, 5);
  yield* clr(m, 0x1170, 7);
  for (const [addr, v] of [[0xa001, 0x86], [0xa003, 0x06], [0xa002, 0x85]]) {
    m.charge(2);
    yield* st(m, addr, v, 5);
  }
  // $C558: ldy #$C714 / ldu #$C726 / ldb #$10; ldx b,y / leax $0420,x /
  // lda ,u+ / sta ,x / subb #2 / bcc: the attributes of the row below
  // each string (read by the copy above on the next pass)
  m.charge(4); m.charge(3); m.charge(2);
  u = 0xc726;
  b = 0x10;
  for (;;) {
    const xx = (m.peek16(disp8(0xc714, b)) + 0x420) & 0xffff;
    const c = m.peek(u);
    u += 1;
    m.charge(6); m.charge(8); m.charge(6);
    yield* st(m, xx, c, 4);
    const borrow = b < 2;
    b = (b - 2) & 0xff;
    m.charge(2); m.charge(3);
    if (borrow) break;
  }
  // $C56F: ldd bonus_first / ora #$30 / sta $01AF / orb #$30 / stb $01B2
  const d1 = m.peek(0x1001);
  const d2 = m.peek(0x1002);
  m.charge(6); m.charge(2);
  yield* st(m, 0x01af, d1 | 0x30, 5);
  m.charge(2);
  yield* st(m, 0x01b2, d2 | 0x30, 5);
  // $C57C: ldb bonus_second / lsrb x4 / cmpb #0 / beq / orb #$30 /
  // stb $01D2 / ldb #$0C / stb $05D2
  const hi = m.peek(0x1002) >> 4;
  m.charge(5); m.charge(8); m.charge(2); m.charge(3);
  if (hi !== 0) {
    m.charge(2);
    yield* st(m, 0x01d2, hi | 0x30, 5);
    m.charge(2);
    yield* st(m, 0x05d2, 0x0c, 5);
  }
  // $C591: blank two lines of 22 tiles from $038D and $0390 (tile $20,
  // attribute 0): sta ,x / clr $0400,x / sta ,u / clr $0400,u / leax
  // -$20,x / leau -$20,u / decb / bne
  m.charge(3); m.charge(3); m.charge(2); m.charge(2);
  for (let i = 0, p = 0x038d, q = 0x0390; i < 0x16; i += 1) {
    yield* st(m, p, 0x20, 4);
    yield* clr(m, p + 0x400, 10);
    yield* st(m, q, 0x20, 4);
    yield* clr(m, q + 0x400, 10);
    p -= 0x20;
    q -= 0x20;
    m.charge(5); m.charge(5); m.charge(2); m.charge(3);
  }
  // $C5B0: the copyright lines
  m.charge(3); m.charge(3); m.charge(8);
  yield* print_string_r(m, { x: 0x0318, u: 0xc7df });
  m.charge(3); m.charge(3); m.charge(7);
  yield* print_string_r(m, { x: 0x031a, u: 0xc7ef });
  // $C5C1: the namco logo with attribute 1
  m.charge(3); m.charge(3);
  x = 0x031c;
  u = 0xc803;
  for (;;) {
    const c = m.peek(u);
    u += 1;
    m.charge(6); m.charge(3);
    if (c === 0) break;
    yield* st(m, x, c, 4);
    m.charge(2);
    yield* st(m, x + 0x400, 0x01, 8);
    x = (x - 0x20) & 0xffff;
    m.charge(5); m.charge(3);
  }
  // $C5D8: lda $04C2 / beq / ldy #$C645: for each column pointer U (an
  // ATTRIBUTE address $04C0-$04C8) write the 30 spaces of dat_C659 with
  // `sta -$0400,u / clr ,u / leau $20,u`. 30 rows run past the tilemap:
  // the last 2 spaces land on attributes $0440-$0468 and the CLRs on work
  // RAM $0840-$0868 (ROM bug, reproduced).
  const flag = m.peek(0x04c2);
  m.charge(5); m.charge(3);
  if (flag !== 0) {
    m.charge(4);
    for (let y = 0xc645; ; y += 2) {
      let uu = m.peek16(y);
      m.charge(8); m.charge(3);
      if (uu === 0) break;
      m.charge(3);
      for (let s = 0xc659; ; s += 1) {
        const c = m.peek(s);
        m.charge(6); m.charge(3);
        if (c === 0) break;
        yield* st(m, uu - 0x400, c, 8);
        yield* clr(m, uu, 6);
        uu = (uu + 0x20) & 0xffff;
        m.charge(5); m.charge(3);
      }
    }
  }
  // $C5F7: flags of shadow entries 1-9 cleared
  for (let p = 0x1e03; p <= 0x1e13; p += 2) yield* clr(m, p, 7);
  // $C612: lda $6807 / ora $6805 / anda #8 / bne: no start button held
  // -> clr $6809 (starts may take credits) / lda #1 / sta $680A
  const s7 = yield* rd(m, 0x6807, 5);
  const s5 = yield* rd(m, 0x6805, 5);
  m.charge(2); m.charge(3);
  if (((s7 | s5) & 0x08) === 0) {
    yield* clr(m, 0x6809, 7);
    m.charge(2);
    yield* st(m, 0x680a, 0x01, 5);
  }
  // $C624: lda $6803 / anda #1 / lbne start_game_1p
  const c1 = (yield* rd(m, 0x6803, 5)) & 0x01;
  m.charge(2);
  if (c1 !== 0) {
    m.charge(6);
    requestJump(m, START_GAME_1P);
    return undefined;
  }
  // $C62D: lda $6803 / anda #2 / lbne start_game_2p / jmp attract_loop
  m.charge(5);
  const c2 = (yield* rd(m, 0x6803, 5)) & 0x02;
  m.charge(2);
  if (c2 !== 0) {
    m.charge(6);
    requestJump(m, START_GAME_2P);
    return undefined;
  }
  m.charge(5); m.charge(4);
  return { a: 0 };
}

/**
 * $C639 print_string_r: the zero-terminated string at U from tile X
 * going right on screen (X - $20 per character); attributes untouched.
 * @see gaplus-main.asm $C639
 * @param {Machine} m
 * @param {{ x: number, u: number }} regs
 * @returns {Generator<symbol, { a: number, x: number, u: number },
 *   unknown>} registers at the RTS
 */
export function* print_string_r(m, { x, u }) {
  const r = yield* printRight(m, x, u);
  m.charge(5);
  return { a: 0, x: r.x, u: r.u };
}

/**
 * $C670 push_start_2p: two or more credits: as push_start_1p, with the
 * "1 OR 2 PLAYERS" strings (dat_C72F), entering the shared code at $C4F8
 * with X = $0326.
 * @see gaplus-main.asm $C670
 * @param {Machine} m
 * @returns {Pass}
 */
export function* push_start_2p(m) {
  yield* clr(m, 0x09f4, 7);
  yield* blankCheck(m);
  // $C683: ldb #$10 / ldx #$0326 / ldu #$C72F / ldy #$C714 / jmp $C4F8
  m.charge(2); m.charge(3); m.charge(3); m.charge(4); m.charge(4);
  return yield* pushStartBody(m, 0x10, 0x0326, 0xc72f);
}

/**
 * $C811 clear_game_vars: clear 22 game variables ($115A, $1132-$1136,
 * $113A-$113E, $1142-$1146, $115B-$115D, $1108, $115F, stage_p1).
 * @see gaplus-main.asm $C811
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* clear_game_vars(m) {
  for (const a of [0x115a, 0x1132, 0x1133, 0x1134, 0x1135, 0x1136, 0x113a,
    0x113b, 0x113c, 0x113d, 0x113e, 0x1142, 0x1143, 0x1144, 0x1145,
    0x1146, 0x115b, 0x115c, 0x115d, 0x1108, 0x115f, 0x1106]) {
    yield* clr(m, a, 7);
  }
  m.charge(5);
}

/**
 * $C854 clear_playfield: tiles $0040-$03BF = $20 with attribute 0 (the
 * attribute is stored first: `stb $0400,x / sta ,x+`).
 * @see gaplus-main.asm $C854
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* clear_playfield(m) {
  m.charge(3); m.charge(3);
  for (let x = 0x0040; x < 0x03c0; x += 1) {
    yield* st(m, x + 0x400, 0x00, 8);
    yield* st(m, x, 0x20, 6);
    m.charge(4); m.charge(3);
  }
  m.charge(5);
}

/**
 * Copy (tile, attribute) words from dat_AE8C to the columns listed at `y`
 * (`ldu ,y++ / beq`, then `ldd ,x++ / beq / sta ,u / stb $0400,u / leau
 * $20,u / bra`); with `blank`, store $20/0 instead (`lda #$20 / clrb`).
 * @param {Machine} m @param {number} y @param {boolean} blank
 * @returns {Generator<symbol, number, unknown>} A at the end (0)
 */
function* logoColumns(m, y, blank) {
  let x = 0xae8c;
  let a = 0;
  for (;; y += 2) {
    let u = m.peek16(y);
    m.charge(8); m.charge(3);
    if (u === 0) return a;
    for (;;) {
      const d = m.peek16(x);
      x += 2;
      a = d >> 8;
      m.charge(8); m.charge(3);
      if (d === 0) break;
      let b = d & 0xff;
      if (blank) {
        a = 0x20;
        b = 0;
        m.charge(2); m.charge(2);
      }
      yield* st(m, u, a, 4);
      yield* st(m, u + 0x400, b, 8);
      u = (u + 0x20) & 0xffff;
      m.charge(5); m.charge(3);
    }
  }
}

/**
 * Nine sprites into shadow entries 1-9 ($0E02-$0E13): positions from
 * $C9DA/$CB6A (`std $0800,y`), flags $4080 (`std $1000,y`), codes from
 * $C9D1/$CB61 with colour $10 (`std ,y++`).
 * @param {Machine} m @param {number} xs position list @param {number} us
 * @returns {Generator<symbol, void, unknown>}
 */
function* logoSprites(m, xs, us) {
  m.charge(4); m.charge(3); m.charge(3);
  for (let y = 0x0e02; ; y += 2, xs += 2, us += 1) {
    const d = m.peek16(xs);
    m.charge(8); m.charge(3);
    if (d === 0) return;
    yield* st16(m, y + 0x800, d, 9);
    m.charge(3);
    yield* st16(m, y + 0x1000, 0x4080, 9);
    const c = m.peek(us);
    m.charge(6); m.charge(2);
    yield* st16(m, y, (c << 8) | 0x10, 8);
    m.charge(3);
  }
}

/**
 * $C866 attract_phase0: the title screen. Starfield, attract_flag = 1,
 * blank 9 tiles from $028D; unless attract_step is $FF: the GAPLUS logo
 * (logoColumns), nine sprites, the copyright lines and the namco logo,
 * then the logo animation step $117A through tbl_C9C9 (sub_C909 ..
 * sub_C9AE). With attract_step = $FF (the last pass before the next
 * phase): erase the logo, take entries 1-16 out of use, $117A = 0.
 * @see gaplus-main.asm $C866
 * @param {Machine} m
 * @returns {Pass}
 */
export function* attract_phase0(m) {
  m.charge(2);
  yield* st(m, 0xa003, 0x06, 5);
  m.charge(2);
  yield* st(m, 0xa002, 0x85, 5);
  m.charge(2);
  yield* st(m, 0x09f4, 0x01, 5);
  // $C875: ldx #$028D / ldb #9; lda #$20 / sta ,x / leax -$20 / decb /
  // bne
  m.charge(3); m.charge(2);
  for (let i = 0, x = 0x028d; i < 9; i += 1, x -= 0x20) {
    m.charge(2);
    yield* st(m, x, 0x20, 4);
    m.charge(5); m.charge(2); m.charge(3);
  }
  // $C884: lda <$2A / cmpa #$FF / lbeq $CA56
  const step = m.peek(0x102a);
  m.charge(4); m.charge(2);
  if (step === 0xff) {
    // lbeq / ldx #dat_AE8C / ldy #dat_C9EE
    m.charge(6); m.charge(3); m.charge(4);
    yield* logoColumns(m, 0xc9ee, true);
    // $CA73: clear flags of entries 1-16, $117A = 0, jmp attract_loop
    for (let p = 0x1e03; p <= 0x1e21; p += 2) yield* clr(m, p, 7);
    yield* clr(m, 0x117a, 7);
    m.charge(4);
    return { a: 0 };
  }
  m.charge(5); m.charge(3); m.charge(4);
  yield* logoColumns(m, 0xc9ee, false);
  yield* logoSprites(m, 0xc9da, 0xc9d1);
  m.charge(3); m.charge(3);
  yield* printRight(m, 0x0318, 0xca04);
  m.charge(3); m.charge(3);
  yield* printRight(m, 0x031a, 0xca14);
  // $C8E9: the namco logo, attribute 1
  m.charge(3); m.charge(3);
  let x = 0x031c;
  for (let u = 0xca28; ; u += 1) {
    const c = m.peek(u);
    m.charge(6); m.charge(3);
    if (c === 0) break;
    yield* st(m, x, c, 4);
    m.charge(2);
    yield* st(m, x + 0x400, 0x01, 8);
    x = (x - 0x20) & 0xffff;
    m.charge(5); m.charge(3);
  }
  // $C900: ldx #tbl_C9C9 / lda $117A / asla / jmp [a,x] (signed offset)
  const i = (m.peek(0x117a) << 1) & 0xff;
  m.charge(3); m.charge(5); m.charge(2); m.charge(7);
  const target = m.peek16(disp8(0xc9c9, i));
  const out = yield* call(mainAt(target), m, {});
  return /** @type {{ a: number } | undefined} */ (out);
}

/**
 * $C909 sub_C909: logo animation step 0: sprite entry 10 ($1614) at
 * $7420, flags $4080; $117A + 1; on to sub_C9AE.
 * @see gaplus-main.asm $C909
 * @param {Machine} m
 * @returns {Pass}
 */
export function* sub_C909(m) {
  m.charge(3);
  yield* st16(m, 0x1614, 0x7420, 6);
  m.charge(3);
  yield* st16(m, 0x1e14, 0x4080, 6);
  yield* inc(m, 0x117a, 7);
  m.charge(4);
  return yield* sub_C9AE(m);
}

/**
 * $C91B sub_C91B: logo animation step 1: move entry 10 ($1615 + 1); when
 * it reaches $FF, entries 10-14 at $74FF with flags $4080 and $117A + 1.
 * Then sub_C9AE.
 * @see gaplus-main.asm $C91B
 * @param {Machine} m
 * @returns {Pass}
 */
export function* sub_C91B(m) {
  const v = (m.peek(0x1615) + 1) & 0xff;
  m.charge(5); m.charge(2);
  yield* st(m, 0x1615, v, 5);
  m.charge(2);
  if (v !== 0xff) {
    m.charge(6);
    return yield* sub_C9AE(m);
  }
  m.charge(5); m.charge(3);
  for (let p = 0x1614; p <= 0x161c; p += 2) yield* st16(m, p, 0x74ff, 6);
  m.charge(3);
  for (let p = 0x1e14; p <= 0x1e1c; p += 2) yield* st16(m, p, 0x4080, 6);
  yield* inc(m, 0x117a, 7);
  m.charge(3);
  return yield* sub_C9AE(m);
}

/**
 * $C952 sub_C952: logo animation step 2: spread entries 10-14 apart
 * ($1614/$1616 - 1, $1619 - 2, $1617/$161B - 1, $161A/$161C = $161C + 1);
 * when $161C reaches $A8, $117A + 1 and set up entries 15 and 16 ($2E00
 * and $7E3F sprites, flags $0080). Then sub_C9AE.
 * @see gaplus-main.asm $C952
 * @param {Machine} m
 * @returns {Pass}
 */
export function* sub_C952(m) {
  // `adda #$FF` / `adda #$FE`: 8-bit adds, i.e. - 1 / - 2
  let v = (m.peek(0x1614) + 0xff) & 0xff;
  m.charge(5); m.charge(2);
  yield* st(m, 0x1614, v, 5);
  yield* st(m, 0x1616, v, 5);
  v = (m.peek(0x1619) + 0xfe) & 0xff;
  m.charge(5); m.charge(2);
  yield* st(m, 0x1619, v, 5);
  v = (m.peek(0x1617) + 0xff) & 0xff;
  m.charge(5); m.charge(2);
  yield* st(m, 0x1617, v, 5);
  yield* st(m, 0x161b, v, 5);
  v = (m.peek(0x161c) + 1) & 0xff;
  m.charge(5); m.charge(2);
  yield* st(m, 0x161a, v, 5);
  yield* st(m, 0x161c, v, 5);
  m.charge(2); m.charge(3);
  if (v !== 0xa8) return yield* sub_C9AE(m);
  yield* inc(m, 0x117a, 7);
  m.charge(3);
  yield* st16(m, 0x0e1e, 0x2e00, 6);
  let d = (m.peek(0x1618) << 8) | m.peek(0x1617);
  m.charge(5); m.charge(5);
  yield* st16(m, 0x161e, d, 6);
  m.charge(3);
  yield* st16(m, 0x1e1e, 0x0080, 6);
  m.charge(3);
  yield* st16(m, 0x0e20, 0x7e3f, 6);
  d = (m.peek(0x1618) << 8) | m.peek(0x1615);
  m.charge(5); m.charge(5);
  yield* st16(m, 0x1620, d, 6);
  m.charge(3);
  yield* st16(m, 0x1e20, 0x0080, 6);
  m.charge(3);
  return yield* sub_C9AE(m);
}

/**
 * $C9AE sub_C9AE: logo animation, every pass: the sprite code/colour of
 * entries 10-14 ($0E14-$0E1C) from dat_CA36 indexed by frame_counter &
 * $1E; jmp attract_loop.
 * @see gaplus-main.asm $C9AE
 * @param {Machine} m
 * @returns {Pass}
 */
export function* sub_C9AE(m) {
  const f = (yield* rd(m, 0x1016, 4)) & 0x1e;
  const d = m.peek16(0xca36 + f);
  m.charge(2); m.charge(3); m.charge(6);
  for (let p = 0x0e14; p <= 0x0e1c; p += 2) yield* st16(m, p, d, 6);
  m.charge(4);
  return { a: d >> 8 };
}

/**
 * $CAA9 attract_phase2: the TOP 5 table. Unless attract_step is $FF:
 * headings and ranks (dat_CB97), scores (8 tiles each from $0900) and
 * names (14 tiles from $0950), a blank run of 10 tiles, attribute-2
 * columns, the logo and its sprites. With attract_step = $FF: erase it
 * all again (lCC65).
 *
 * ROM bug, reproduced: the blank run at $CB00 uses X as the name loop
 * left it, i.e. the table's end marker $0000, so it writes $20 to $0000
 * and then to ROM ($FFE0 ...), and attribute 2 to $0400 and then into
 * the tile codes $03E0, $03C0, ..., $02E0.
 * @see gaplus-main.asm $CAA9
 * @param {Machine} m
 * @returns {Pass}
 */
export function* attract_phase2(m) {
  m.charge(2);
  yield* st(m, 0xa003, 0x06, 5);
  m.charge(2);
  yield* st(m, 0xa002, 0x85, 5);
  const step = m.peek(0x102a);
  m.charge(4); m.charge(2);
  if (step === 0xff) {
    m.charge(6);
    return yield* phase2Erase(m);
  }
  // $CABB: (tile, string) pairs until 0: text going right
  m.charge(5); m.charge(4);
  for (let y = 0xcb97; ; y += 4) {
    const x = m.peek16(y);
    m.charge(8); m.charge(3);
    if (x === 0) break;
    const u = m.peek16(y + 2);
    m.charge(8);
    yield* printRight(m, x, u);
  }
  // $CAD0 / $CAE8: (tile, RAM) pairs: 8 score tiles, then 14 name tiles
  let x = 0;
  for (const [tbl, n] of [[0xcbb9, 8], [0xcbcf, 14]]) {
    m.charge(4);
    for (let y = tbl; ; y += 4) {
      x = m.peek16(y);
      m.charge(2); m.charge(8); m.charge(3);
      if (x === 0) break;
      let u = m.peek16(y + 2);
      m.charge(8);
      for (let i = 0; i < n; i += 1) {
        const c = m.peek(u);
        u += 1;
        m.charge(6);
        yield* st(m, x, c, 4);
        x = (x - 0x20) & 0xffff;
        m.charge(5); m.charge(2); m.charge(3);
      }
      m.charge(3);
    }
  }
  // $CB00: ldb #$0A; lda #$20 / sta ,x / lda #2 / sta $0400,x / leax
  // -$20,x / decb / bne -- X is 0 here (see the ROM bug above)
  m.charge(2);
  for (let i = 0; i < 10; i += 1) {
    m.charge(2);
    yield* st(m, x, 0x20, 4);
    m.charge(2);
    yield* st(m, x + 0x400, 0x02, 8);
    x = (x - 0x20) & 0xffff;
    m.charge(5); m.charge(2); m.charge(3);
  }
  // $CB12: columns of 27 attributes = A from dat_CBE5
  yield* attrColumns(m, 0x02);
  m.charge(3); m.charge(4);
  yield* logoColumns(m, 0xcb7e, false);
  yield* logoSprites(m, 0xcb6a, 0xcb61);
  m.charge(4); // $CB94: jmp attract_loop
  return { a: 0 };
}

/**
 * $CB12 / $CC9E: ldx #dat_CBE5; ldu ,x++ / beq / ldd #$0v1B; then
 * `sta ,u / leau -$20,u / decb / bne` 27 times.
 * @param {Machine} m @param {number} a the value stored
 * @returns {Generator<symbol, void, unknown>}
 */
function* attrColumns(m, a) {
  m.charge(3);
  for (let x = 0xcbe5; ; x += 2) {
    let u = m.peek16(x);
    m.charge(8); m.charge(3);
    if (u === 0) return;
    m.charge(3);
    for (let b = 0x1b; b > 0; b -= 1) {
      yield* st(m, u, a, 4);
      u = (u - 0x20) & 0xffff;
      m.charge(5); m.charge(2); m.charge(3);
    }
    m.charge(3);
  }
}

/**
 * lCC65: attract_phase2 with attract_step = $FF: blank the TOP 5 text
 * (30 tiles per line, attribute 0), the logo, the attribute columns,
 * entries 1-9 out of use; jmp attract_loop.
 * @param {Machine} m
 * @returns {Pass}
 */
function* phase2Erase(m) {
  // $CC65: ldy #dat_CB97; ldx ,y / beq / leay 4,y / ldu #dat_CC49;
  // lda ,u+ / beq / sta ,x / clr $0400,x / leax -$20,x / bra
  m.charge(4);
  for (let y = 0xcb97; ; y += 4) {
    let x = m.peek16(y);
    m.charge(5); m.charge(3);
    if (x === 0) break;
    m.charge(5); m.charge(3);
    for (let u = 0xcc49; ; u += 1) {
      const c = m.peek(u);
      m.charge(6); m.charge(3);
      if (c === 0) break;
      yield* st(m, x, c, 4);
      yield* clr(m, x + 0x400, 10);
      x = (x - 0x20) & 0xffff;
      m.charge(5); m.charge(3);
    }
  }
  m.charge(3); m.charge(4);
  yield* logoColumns(m, 0xcb7e, true);
  yield* attrColumns(m, 0x00);
  for (let p = 0x1e03; p <= 0x1e13; p += 2) yield* clr(m, p, 7);
  m.charge(4);
  return { a: 0 };
}

/** Every routine of this file by entry address. */
export const ROUTINES = {
  0xc296: game_init,
  0xc417: attract_loop,
  0xc467: draw_credit,
  0xc492: attract_demo,
  0xc49f: attract_demo2,
  0xc4da: push_start_1p,
  0xc639: print_string_r,
  0xc670: push_start_2p,
  0xc811: clear_game_vars,
  0xc854: clear_playfield,
  0xc866: attract_phase0,
  0xc909: sub_C909,
  0xc91b: sub_C91B,
  0xc952: sub_C952,
  0xc9ae: sub_C9AE,
  0xcaa9: attract_phase2,
};


// Copyright 2026 by Moshix
/**
 * Main CPU $E21A-$EA20: the challenging-stage results screen (game mode
 * 8, task_results) and its texts: "EARNINGS", the 100/200-point hit
 * counts, the TOTAL, the bonus line of the stage ("BONUS", "GAPLUS",
 * "DOUBLE", "TRIPLE", "GOOD", "LUCKY", "BYEBYE", "EXTEND" COMPLETED) and
 * the GRAND TOTAL, which is then paid out into the score 10 points per
 * add_score call.
 *
 * STRUCTURE. task_results jumps through results_steps with results_step
 * ($1160) as index. Every step is a task: it ends with the shared tail
 * lE857 (`INC <$30 / JMP task_dispatch`), which the port performs and
 * then returns. The pay-out tail lE68E -> lE3B5 counts $116A up to 0;
 * when it wraps it clears the screen, advances the stage, waits one
 * vblank (`CWAI #$EF`, the only frame yield in this range) and goes back
 * to game mode 0 -- or, in the demo, to lD029 (attract restart, gp2-3b).
 *
 * TIMING. Every routine charges (m.charge) the exact MAME 6809 cycles of
 * each instruction it executes, from its entry through its RTS or final
 * `JMP task_dispatch`; a JSR/BSR is charged by the caller, the callee
 * charges itself. Discipline: an instruction's memory accesses happen
 * when everything before it is charged, then the instruction is charged,
 * so m.charged[0] at an access is the cycle its instruction starts.
 * Before every access to RAM another CPU uses (isRacy: here the sub
 * CPU's $09F4, $1016, $102F, $107A, $115B, $1162-$1164, the sound
 * requests $6040-$607F, and whatever a store through a pointer hits) the
 * routine yields SYNC. So every routine except print_string_attr is a
 * generator.
 *
 * RAM (tentative names): $1160 results_step, $1161 blink phase, $1162
 * hit count to draw, $1163 BCD hits x100, $1164 counter, $1166 stage
 * bonus kind (from $1171/$1172 per player), $1167 BCD temp, $1169 BCD
 * earnings (hundreds), $116A pay-out timer, $116B BCD hits x200, $115B
 * step delay.
 *
 * @see reference/gaplus-main.asm $E21A-$EA20
 */

import { MAIN, mainAt } from './routines.js';
import { call } from '../call.js';
import { add8, daa, disp8 } from '../m6809ops.js';
import { SYNC, isRacy } from './gp2_2b_state.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {Generator<unknown, unknown, unknown>} Gen */

/** results_steps ($E223): six step pointers. */
const RESULTS_STEPS = 0xe223;
/** tbl_E4E5: bonus-line printers, by $1166 & 7. */
const TBL_E4E5 = 0xe4e5;
/** tbl_E65F: pay-out entries, by $1166 & 7. */
const TBL_E65F = 0xe65f;
/** dat_A000: per bonus kind, a list of tile addresses (one per hit). */
const DAT_A000 = 0xa000;
/** dat_E4CA: per bonus kind, a tile that is $20 when there is no bonus. */
const DAT_E4CA = 0xe4ca;

/**
 * Does an access to `a` race with another CPU (RAM the sub CPU uses, the
 * sound CPU's request/active flags)? Also used for stores through a
 * pointer, whose address is only known at run time.
 */
const racy = isRacy;

// ------------------------------------------------------------ helpers

/**
 * A load (LDA/LDB/ORA/ADDA/CMPA ... from memory) of `n` cycles.
 * @param {Machine} m @param {number} a @param {number} n
 * @returns {Generator<unknown, number, unknown>}
 */
function* ld(m, a, n) {
  if (racy(a)) yield SYNC;
  const v = m.peek(a);
  m.charge(n);
  return v;
}

/**
 * A store (STA/STB) of `n` cycles.
 * @param {Machine} m @param {number} a @param {number} v @param {number} n
 * @returns {Generator<unknown, void, unknown>}
 */
function* st(m, a, v, n) {
  if (racy(a)) yield SYNC;
  m.poke(a, v & 0xff);
  m.charge(n);
}

/**
 * STD/LDD pair of a 16-bit copy (6 + 6 cycles, both extended).
 * @param {Machine} m @param {number} dst @param {number} src
 */
function copy16(m, dst, src) {
  const d = m.peek16(src); // ldd src
  m.charge(6);
  m.poke16(dst, d); // std dst: both bytes at the instruction's start
  m.charge(6);
}

/**
 * A read-modify-write on memory (INC/DEC/CLR/LSR: the 6809 reads first).
 * @param {Machine} m @param {number} a @param {(v: number) => number} f
 * @param {number} n cycles
 * @returns {Generator<unknown, number, unknown>} the new value
 */
function* rmw(m, a, f, n) {
  if (racy(a)) yield SYNC;
  const v = f(m.peek(a)) & 0xff;
  m.poke(a, v);
  m.charge(n);
  return v;
}

/** @param {number} v */
const plus1 = (v) => v + 1;
/** @param {number} v */
const minus1 = (v) => v - 1;
const zero = () => 0;
/** @param {number} v */
const half = (v) => v >> 1;

/**
 * `ADDA x / DAA`: BCD add (the add sets C and H afresh; DAA uses them).
 * @param {number} a @param {number} b @returns {number}
 */
function bcdAdd(a, b) {
  const r = add8(a, b);
  return daa(r.v, r.cc).v;
}

/**
 * `LSR addr` four times (7 cycles each): the high BCD digit.
 * @param {Machine} m @param {number} a @returns {Gen}
 */
function* lsr4(m, a) {
  for (let i = 0; i < 4; i += 1) yield* rmw(m, a, half, 7);
}

/**
 * lE857: `INC <main_task / JMP task_dispatch` (6 + 4) -- the end of
 * every step.
 * @param {Machine} m @returns {Gen}
 */
function* lE857(m) {
  yield* rmw(m, 0x1030, plus1, 6); // main_task
  m.charge(4);
}

/**
 * `LDA $1166 / ANDA #$07 / ASLA / LDX #tbl / LDX A,X` (5+2+2+3+6): the
 * word of `tbl` for the current bonus kind (tables are ROM).
 * @param {Machine} m @param {number} tbl @returns {number}
 */
function kindWord(m, tbl) {
  const a = (m.peek(0x1166) & 0x07) << 1;
  m.charge(5); m.charge(2); m.charge(2); m.charge(3); m.charge(6);
  return m.read16('main', tbl + a);
}

/**
 * `JSR bcd_hi_to_char` / `JSR bcd_lo_to_char` (8, then the callee).
 * @param {Machine} m @param {string} name @param {number} a
 * @returns {Generator<unknown, number, unknown>} A = tile code
 */
function* bcdChar(m, name, a) {
  m.charge(8);
  const r = /** @type {{ a: number }} */ (
    yield* call(MAIN[name], m, { a }));
  return r.a;
}

/**
 * `LDX #x / LDU #u / LDB #b|CLRB / JSR print_string_attr`
 * (3 + 3 + 2 + 8, then the routine).
 * @param {Machine} m @param {number} x @param {number} u @param {number} b
 */
function print(m, x, u, b) {
  m.charge(3); m.charge(3); m.charge(2); m.charge(8);
  print_string_attr(m, { x, u, b });
}

// -------------------------------------------------------------- tasks

/**
 * $E21A task_results: mode 8 task, `JMP [results_steps + 2*$1160]`
 * (`LDX # / LDA $1160 / ASLA / JMP [A,X]`: 8-bit shift, signed offset).
 * @see gaplus-main.asm $E21A
 * @param {Machine} m @returns {Gen}
 */
export function* task_results(m) {
  m.charge(3);
  const a = (m.peek(0x1160) << 1) & 0xff; // results_step
  m.charge(5); m.charge(2); m.charge(7);
  const target = m.read16('main', disp8(RESULTS_STEPS, a));
  return yield* call(mainAt(target), m, {});
}

/**
 * $E22F sub_E22F: results step 0 -- reset the counters, $1162 = $1164
 * (hits to draw), print EARNINGS / 100 X / 200 X / TOTAL and two ship
 * icons. After $115B wraps to 0 go to step 1 with the bonus kind of the
 * current player ($1171 / $1172) in $1166.
 * @see gaplus-main.asm $E22F
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E22F(m) {
  for (const a of [0x09a4, 0x1161, 0x1163, 0x1169, 0x116a, 0x116b]) {
    yield* rmw(m, a, zero, 7); // clr
  }
  const a = yield* ld(m, 0x1164, 5);
  yield* st(m, 0x1162, a, 5);
  print(m, 0x02f0, 0xe86c, 0x0c);
  print(m, 0x02f2, 0xe87e, 0x00);
  print(m, 0x02f4, 0xe890, 0x00);
  print(m, 0x02f6, 0xe8a2, 0x00);
  // $E270: ldd #$600A / sta $0312 / stb $0712 / incb / sta / stb
  m.charge(3);
  yield* st(m, 0x0312, 0x60, 5);
  yield* st(m, 0x0712, 0x0a, 5 + 2);
  yield* st(m, 0x0314, 0x60, 5);
  yield* st(m, 0x0714, 0x0b, 5);
  // $E280: inc $115B / lbne lE857
  if ((yield* rmw(m, 0x115b, plus1, 7)) !== 0) {
    m.charge(6);
  } else {
    m.charge(5);
    yield* rmw(m, 0x1160, plus1, 7); // results_step
    // $E28A: lda $1171 / ldb <cur_player / beq / lda $1172 / sta $1166
    let k = yield* ld(m, 0x1171, 5);
    const p = yield* ld(m, 0x102d, 4);
    m.charge(3);
    if (p !== 0) k = yield* ld(m, 0x1172, 5);
    yield* st(m, 0x1166, k, 5 + 4); // + jmp lE857
  }
  yield* lE857(m);
}

/**
 * $E29A sub_E29A: results step 1 -- every other frame count one hit
 * ($1164 down): sound $17 while counting, sub_E3FF draws it; at the last
 * hit sound $0A; when $1164 goes below 0, step 2.
 * @see gaplus-main.asm $E29A
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E29A(m) {
  // $E29A: inc $1161 / lda $1161 / anda #$01 / lbne lE857
  yield* rmw(m, 0x1161, plus1, 7);
  const odd = ((yield* ld(m, 0x1161, 5)) & 0x01) !== 0;
  m.charge(2);
  if (odd) {
    m.charge(6);
  } else {
    m.charge(5);
    // $E2A6: dec $1164 / lda $1164 / cmpa #$FF / beq lE2CA
    yield* rmw(m, 0x1164, minus1, 7);
    const c = yield* ld(m, 0x1164, 5);
    m.charge(2); m.charge(3);
    if (c === 0xff) {
      yield* rmw(m, 0x1160, plus1, 7); // lE2CA: results_step
      m.charge(4);
    } else {
      m.charge(2);
      yield* st(m, 0x6057, 0x01, 5); // snd_request+23
      m.charge(8);
      yield* sub_E3FF(m);
      if ((yield* ld(m, 0x1164, 5)) !== 0) {
        m.charge(6);
      } else {
        m.charge(5);
        yield* rmw(m, 0x6057, zero, 7 + 2);
        yield* st(m, 0x604a, 0x01, 5 + 4); // snd_request+10
      }
    }
  }
  yield* lE857(m);
}

/**
 * $E2D0 sub_E2D0: results step 2 -- draw the $1162 remaining hit markers
 * (tile $60) at the addresses of the bonus kind's list, then print the
 * bonus line (sub_E4DA) and go to step 3; with no bonus line (the tile of
 * dat_E4CA is a space) go to sub_E332.
 * @see gaplus-main.asm $E2D0
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E2D0(m) {
  let x = kindWord(m, DAT_A000);
  m.charge(2); // clra
  let b = yield* ld(m, 0x1162, 5);
  for (;;) {
    // $E2DF: decb / cmpb #$FF / beq lE318
    b = (b - 1) & 0xff;
    m.charge(2); m.charge(2); m.charge(3);
    if (b === 0xff) break;
    // aslb / bcc / coma / lda #$01 / ldx d,x / rorb: D = 2 * B (16 bits;
    // the carry of aslb becomes A = 1), and rorb puts B back exactly.
    m.charge(2 + 3 + (b & 0x80 ? 2 + 2 : 0));
    const p = m.read16('main', (x + (b << 1)) & 0xffff);
    for (const c of [9, 2, 4, 3]) m.charge(c); // ldx d,x / rorb / cmpx / bcc
    if (p < 0x1000) {
      m.charge(2);
      yield* st(m, p, 0x60, 4 + 2);
      yield* st(m, (p + 0x0400) & 0xffff, 0x0a, 8);
    } else {
      // $E30A: sta -$1000,x / sta -$0C00,x / bra lE2FC
      m.charge(2);
      yield* st(m, (p - 0x1000) & 0xffff, 0x60, 8 + 2);
      yield* st(m, (p - 0x0c00) & 0xffff, 0x0b, 8 + 3);
    }
    // $E2FC: reload X, clra, bra
    x = kindWord(m, DAT_A000);
    m.charge(2); m.charge(3);
  }
  // $E318: ldx dat_E4CA[a] / lda ,x / cmpa #$20 / beq sub_E332
  const t = kindWord(m, DAT_E4CA);
  const c = yield* ld(m, t, 4);
  m.charge(2); m.charge(3);
  if (c === 0x20) return yield* sub_E332(m);
  m.charge(8);
  yield* sub_E4DA(m);
  yield* rmw(m, 0x1160, plus1, 7 + 4); // results_step, jmp lE857
  yield* lE857(m);
  return undefined;
}

/**
 * $E332 sub_E332: results step 5 (also reached from sub_E2D0 when there
 * is no bonus): stay on step 5 until $115B wraps, then $116A = $FF and
 * pay out the total (lE791).
 * @see gaplus-main.asm $E332
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E332(m) {
  m.charge(2);
  yield* st(m, 0x1160, 0x05, 5); // results_step
  if ((yield* rmw(m, 0x115b, plus1, 7)) !== 0) {
    m.charge(6);
    yield* lE857(m);
    return undefined;
  }
  m.charge(5); m.charge(2);
  yield* st(m, 0x116a, 0xff, 5 + 4); // + jmp lE791
  return yield* lE791(m);
}

/**
 * $E346 sub_E346: results step 3 -- the bonus line is on screen until
 * $116A wraps (then step 4). For kinds 1 and 4 it waits for the fire
 * button (sound $08 until pressed) and cycles a digit at $017A from
 * dat_EA19 / dat_EA11 with the frame counter; every 4th frame the
 * attribute bit of the line at $071E blinks.
 * @see gaplus-main.asm $E346
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E346(m) {
  const w = yield* rmw(m, 0x116a, plus1, 7);
  m.charge(3);
  if (w === 0) {
    yield* rmw(m, 0x1160, plus1, 7 + 4); // lE3A7: results_step
    yield* lE857(m);
    return;
  }
  // $E34B: lda $1166 / anda #$07 / suba #$01 / beq / suba #$03 / bne
  const kind = (yield* ld(m, 0x1166, 5)) & 0x07;
  m.charge(2 + 2 + 3 + (kind === 1 ? 0 : 2 + 3));
  if (kind === 1 || kind === 4) {
    // $E358: lda entry_fire_latch / bne lE38B
    const latch = yield* ld(m, 0x09a4, 5);
    m.charge(3);
    if (latch === 0) {
      m.charge(2);
      yield* st(m, 0x6048, 0x01, 5); // snd_request+8
      // $E362: lda $6805 / ora $6807 / anda #$02 / beq -- either fire
      let f = yield* ld(m, 0x6805, 5);
      f |= yield* ld(m, 0x6807, 5);
      m.charge(2); m.charge(3);
      if ((f & 0x02) !== 0) {
        yield* rmw(m, 0x09a4, plus1, 7);
        yield* rmw(m, 0x6048, zero, 7);
        yield* rmw(m, 0x6068, zero, 7); // snd_active+8
      }
      // $E375: ldu #dat_EA19 / lda $1166 / suba #$04 / beq / ldu
      // #dat_EA11 -- note: the whole byte, not $1166 & 7
      m.charge(3);
      const four = (yield* ld(m, 0x1166, 5)) === 0x04;
      m.charge(2 + 3 + (four ? 0 : 3));
      const u = four ? 0xea19 : 0xea11;
      // $E382: lda <frame_counter / anda #$07 / lda a,u / sta $017A
      const fc = yield* ld(m, 0x1016, 4);
      m.charge(2); m.charge(5);
      yield* st(m, 0x017a, m.read('main', u + (fc & 0x07)), 5);
    }
  }
  // $E38B: lda $116A / anda #$03 / bne lE3A4
  const w2 = yield* ld(m, 0x116a, 5);
  m.charge(2); m.charge(3);
  if ((w2 & 0x03) === 0) {
    // $E392: ldb #$12 / ldu #$071E / lda ,u / inca / anda #$01, then
    // store A at 18 cells going right (leau -$20,u / decb / bne)
    m.charge(2); m.charge(3);
    let u = 0x071e;
    const a = ((yield* ld(m, u, 4)) + 1) & 0x01;
    m.charge(2); m.charge(2);
    for (let b = 0x12; b !== 0; b -= 1) {
      yield* st(m, u, a, 4 + 5 + 2 + 3);
      u = (u - 0x20) & 0xffff;
    }
  }
  m.charge(4); // jmp lE857
  yield* lE857(m);
}

/**
 * $E3AD sub_E3AD: results step 4 -- with $116A = 0 pay out the bonus
 * (lE654, by kind); otherwise count $116A up (lE3B5).
 * @see gaplus-main.asm $E3AD
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E3AD(m) {
  const w = yield* ld(m, 0x116a, 5);
  m.charge(3);
  if (w === 0) {
    m.charge(4);
    return yield* lE654(m);
  }
  return yield* lE3B5(m);
}

/**
 * lE3B5 (inside sub_E3AD, also the end of every pay-out): `INC $116A`;
 * until it wraps just end the task. When it wraps: blank the playfield
 * $0040-$03BF (attributes 0), advance the player's stage ($1106/$1107)
 * and stage counter ($1171/$1172), reset the step, wait for the vblank,
 * request sound 5 and restart the scheduler in mode 0 -- or, in the
 * demo, jump to lD029 (gp2-3b: back to attract).
 * @param {Machine} m @returns {Gen}
 */
function* lE3B5(m) {
  if ((yield* rmw(m, 0x116a, plus1, 7)) !== 0) {
    m.charge(6);
    yield* lE857(m);
    return undefined;
  }
  m.charge(5); m.charge(3); m.charge(2);
  // $E3C1: clr $0400,x / sta ,x+ / cmpx #$03C0 / bne (10+6+4+3)
  for (let x = 0x0040; x !== 0x03c0; x += 1) {
    yield* rmw(m, x + 0x0400, zero, 10);
    yield* st(m, x, 0x20, 6 + 4 + 3);
  }
  // $E3CC: lda <cur_player / beq / inc $1107 / bra | inc $1106
  const p2 = (yield* ld(m, 0x102d, 4)) !== 0;
  m.charge(3);
  yield* rmw(m, p2 ? 0x1107 : 0x1106, plus1, p2 ? 7 + 3 : 7);
  // $E3D8: lda <cur_player / bne / inc $1171 / bra | inc $1172
  const q2 = (yield* ld(m, 0x102d, 4)) !== 0;
  m.charge(3);
  yield* rmw(m, q2 ? 0x1172 : 0x1171, plus1, q2 ? 7 : 7 + 3);
  yield* rmw(m, 0x1162, zero, 7);
  yield* rmw(m, 0x1160, zero, 7); // results_step
  // $E3EA: cwai #$EF -- wait for vblank
  m.charge(16);
  yield;
  yield* rmw(m, 0x6045, plus1, 7); // snd_request+5
  yield* rmw(m, 0x102f, zero, 6); // game_mode
  yield* rmw(m, 0x1030, zero, 6); // main_task
  yield* rmw(m, 0x107a, zero, 6); // sub_task
  // $E3F5: lda attract_flag / lbne lD029 / jmp task_dispatch
  if ((yield* ld(m, 0x09f4, 5)) !== 0) {
    m.charge(6);
    return yield* call(mainAt(0xd029), m, {});
  }
  m.charge(5); m.charge(4);
  return undefined;
}

/**
 * $E3FF sub_E3FF: count one hit on the results screen: blank its marker
 * (tile list entry $1164 of the bonus kind); a marker below $1000 is a
 * 100-point hit (hits x100 $1163 and earnings $1169 + 1, BCD), one at or
 * above it a 200-point hit (earnings + 2, hits x200 $116B + 1); the
 * earnings' hundreds carry into $0176 (and $0174).
 * @see gaplus-main.asm $E3FF
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E3FF(m) {
  const list = kindWord(m, DAT_A000);
  m.charge(2); // clra
  // $E40B: ldb $1164 / aslb / rola / ldx d,x -- 16-bit 2 * $1164
  const n = yield* ld(m, 0x1164, 5);
  m.charge(2); m.charge(2);
  const x = m.read16('main', (list + (n << 1)) & 0xffff);
  m.charge(9); m.charge(4); m.charge(3); // ldx d,x / cmpx / bcc
  if (x < 0x1000) {
    m.charge(2);
    yield* st(m, x, 0x20, 4);
    yield* rmw(m, (x + 0x0400) & 0xffff, zero, 10);
    let a = bcdAdd(yield* ld(m, 0x1163, 5), 1);
    m.charge(2); m.charge(2);
    yield* st(m, 0x1163, a, 5);
    a = yield* bcdChar(m, 'bcd_hi_to_char', a);
    yield* st(m, 0x01f2, a, 5);
    yield* st(m, 0x0152, a, 5);
    a = yield* bcdChar(m, 'bcd_lo_to_char', yield* ld(m, 0x1163, 5));
    yield* st(m, 0x01d2, a, 5);
    yield* st(m, 0x0132, a, 5);
    a = bcdAdd(yield* ld(m, 0x1169, 5), 1);
    m.charge(2); m.charge(2);
    yield* st(m, 0x1169, a, 5);
    a = yield* bcdChar(m, 'bcd_hi_to_char', a);
    yield* st(m, 0x0156, a, 5);
    a = yield* bcdChar(m, 'bcd_lo_to_char', yield* ld(m, 0x1169, 5));
    yield* st(m, 0x0136, a, 5);
    // $E455: lda $1169 / bne rts / lda $0176 / adda #1 / ora #$30 / sta
    const e = yield* ld(m, 0x1169, 5);
    m.charge(3);
    if (e === 0) {
      a = (((yield* ld(m, 0x0176, 5)) + 1) & 0xff) | 0x30;
      m.charge(2); m.charge(2);
      yield* st(m, 0x0176, a, 5);
    }
    m.charge(5); // rts
    return;
  }
  // lE465: lda #$20 / sta -$1000,x / clr -$0C00,x
  m.charge(2);
  yield* st(m, (x - 0x1000) & 0xffff, 0x20, 8);
  yield* rmw(m, (x - 0x0c00) & 0xffff, zero, 10);
  let a = bcdAdd(yield* ld(m, 0x1169, 5), 2);
  m.charge(2); m.charge(2);
  yield* st(m, 0x1169, a, 5);
  a = yield* bcdChar(m, 'bcd_hi_to_char', a);
  yield* st(m, 0x0154, a, 5);
  yield* st(m, 0x0156, a, 5);
  a = yield* bcdChar(m, 'bcd_lo_to_char', yield* ld(m, 0x1169, 5));
  yield* st(m, 0x0134, a, 5);
  yield* st(m, 0x0136, a, 5);
  // $E48D: lda $0134 / ora $0154 / anda #$0F / bne lE4A4
  let t = yield* ld(m, 0x0134, 5);
  t |= yield* ld(m, 0x0154, 5);
  m.charge(2); m.charge(3);
  if ((t & 0x0f) === 0) {
    a = (((yield* ld(m, 0x0176, 5)) + 1) & 0xff) | 0x30;
    m.charge(2); m.charge(2);
    yield* st(m, 0x0176, a, 5);
    yield* st(m, 0x0174, a, 5);
  }
  a = bcdAdd(yield* ld(m, 0x116b, 5), 1);
  m.charge(2); m.charge(2);
  yield* st(m, 0x116b, a, 5);
  a = yield* bcdChar(m, 'bcd_hi_to_char', a);
  yield* st(m, 0x01f4, a, 5);
  a = yield* bcdChar(m, 'bcd_lo_to_char', yield* ld(m, 0x116b, 5));
  yield* st(m, 0x01d4, a, 5);
  // $E4BC: lda $0174 / cmpa #$32 / beq -> sta #$31 at $0214
  const h = yield* ld(m, 0x0174, 5);
  m.charge(2); m.charge(3);
  if (h === 0x32) {
    m.charge(2);
    yield* st(m, 0x0214, 0x31, 5);
  }
  m.charge(5); // rts
}

/**
 * $E4DA sub_E4DA: print the bonus line of kind $1166 & 7 through
 * tbl_E4E5 (`JMP [A,X]`, 7; the entry's RTS returns to our caller).
 * @see gaplus-main.asm $E4DA
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E4DA(m) {
  const a = (m.peek(0x1166) & 0x07) << 1;
  m.charge(5); m.charge(2); m.charge(2); m.charge(3); m.charge(7);
  const t = m.read16('main', TBL_E4E5 + a);
  return yield* call(mainAt(t), m, {});
}

/**
 * $E4F5 sub_E4F5: kind 0, `"BONUS" COMPLETED` / `BONUS POINTS 10000`.
 * @see gaplus-main.asm $E4F5
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E4F5(m) {
  print(m, 0x0318, 0xe8b4, 0x0c);
  print(m, 0x031a, 0xe8c7, 0x0c);
  m.charge(5);
}

/**
 * $E50C sub_E50C: kinds 1 and 4, `"GAPLUS" COMPLETED` (kind 4: `" GOOD "
 * COMPLETED`) / `BONUS POINTS 00000` / `PUSH FIRING BUTTON`.
 * @see gaplus-main.asm $E50C
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E50C(m) {
  m.charge(3); m.charge(3);
  const four = ((yield* ld(m, 0x1166, 5)) & 0x07) === 0x04;
  m.charge(2 + 2 + 3 + (four ? 3 : 0) + 2 + 8);
  print_string_attr(m, { x: 0x0318, u: four ? 0xe94c : 0xe8da, b: 0x0c });
  print(m, 0x031a, 0xe8ed, 0x0c);
  print(m, 0x031e, 0xe9fe, 0x01);
  m.charge(5);
}

/**
 * $E53A sub_E53A: kind 2, `"DOUBLE" COMPLETED`; the bonus is the
 * earnings again (digits $0136/$0156/$0176 copied to $013A-$017A).
 * @see gaplus-main.asm $E53A
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E53A(m) {
  print(m, 0x0318, 0xe900, 0x0c);
  print(m, 0x031a, 0xe913, 0x0c);
  for (const d of [0x0136, 0x0156, 0x0176]) {
    yield* st(m, d + 4, yield* ld(m, d, 5), 5);
  }
  m.charge(5);
}

/**
 * $E563 sub_E563: kind 3, `"TRIPLE" COMPLETED`; the bonus is twice the
 * earnings, doubled digit by digit in BCD through $1164 / $1167.
 * @see gaplus-main.asm $E563
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E563(m) {
  print(m, 0x0318, 0xe926, 0x0c);
  print(m, 0x031a, 0xe939, 0x0c);
  // $E579: units: $1164 = d, then d + d (BCD)
  let a = (yield* ld(m, 0x0136, 5)) & 0x0f;
  m.charge(2);
  yield* st(m, 0x1164, a, 5);
  a = bcdAdd(a, yield* ld(m, 0x1164, 5));
  m.charge(2);
  yield* st(m, 0x1164, a, 5);
  m.charge(2); m.charge(2);
  yield* st(m, 0x013a, (a & 0x0f) | 0x30, 5);
  yield* lsr4(m, 0x1164); // the carry digit
  // $E59B / $E5C1: tens, hundreds: d + d + carry
  for (const [src, dst] of [[0x0156, 0x015a], [0x0176, 0x017a]]) {
    a = (yield* ld(m, src, 5)) & 0x0f;
    m.charge(2);
    yield* st(m, 0x1167, a, 5);
    a = bcdAdd(a, yield* ld(m, 0x1167, 5));
    m.charge(2);
    a = bcdAdd(a, yield* ld(m, 0x1164, 5));
    m.charge(2);
    yield* st(m, 0x1164, a, 5);
    m.charge(2); m.charge(2);
    yield* st(m, dst, (a & 0x0f) | 0x30, 5);
    if (dst === 0x015a) yield* lsr4(m, 0x1164);
  }
  m.charge(5);
}

/**
 * $E5F3 sub_E5F3: kind 5, `"LUCKY" COMPLETED` / `ONE COMPONENT ADDED`,
 * and a component sprite in shadow entry $0F2C/$172C/$1F2C (code
 * $27/$03, or $30/$04 when $1F27 is set).
 * @see gaplus-main.asm $E5F3
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E5F3(m) {
  print(m, 0x0338, 0xe972, 0x0c);
  const f = yield* ld(m, 0x1f27, 5);
  // bne / ldd #$2703 / bra | ldd #$3004
  m.charge(3 + 3 + (f === 0 ? 3 : 0));
  m.poke16(0x0f2c, f === 0 ? 0x2703 : 0x3004);
  m.charge(6); m.charge(3);
  m.poke16(0x172c, 0x0058);
  m.charge(6); m.charge(3);
  m.poke16(0x1f2c, 0x4081);
  m.charge(6);
  print(m, 0x033a, 0xe986, 0x0c);
  m.charge(5);
}

/**
 * $E626 sub_E626: kind 6, `"BYEBYE" COMPLETED` / `ONE COMPONENT
 * DROPPED`.
 * @see gaplus-main.asm $E626
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E626(m) {
  print(m, 0x0358, 0xe99a, 0x0c);
  print(m, 0x035a, 0xe9af, 0x0c);
  m.charge(5);
}

/**
 * $E63D sub_E63D: kind 7, `"EXTEND" COMPLETED` / ` YOU GET A SHIP`.
 * @see gaplus-main.asm $E63D
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E63D(m) {
  print(m, 0x0318, 0xe9c5, 0x0c);
  print(m, 0x031a, 0xe9d8, 0x0c);
  m.charge(5);
}

/**
 * lE654: the pay-out entry of kind $1166 & 7 through tbl_E65F
 * (`JMP [A,X]`).
 * @param {Machine} m @returns {Gen}
 */
function* lE654(m) {
  const a = (m.peek(0x1166) & 0x07) << 1;
  m.charge(5); m.charge(2); m.charge(2); m.charge(3); m.charge(7);
  const t = m.read16('main', TBL_E65F + a);
  return yield* call(mainAt(t), m, {});
}

/** Print ` GRAND TOTAL    00` at $031C. @param {Machine} m */
function printGrandTotal(m) {
  print(m, 0x031c, 0xe9eb, 0x00);
}

/**
 * $E66F sub_E66F: kind 0 pay-out: grand total = earnings + 10000
 * (hundreds digit + 1), then lE68E.
 * @see gaplus-main.asm $E66F
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E66F(m) {
  printGrandTotal(m);
  // $E679: lda $0176 / inca / ora #$30 / sta $017C
  const a = (((yield* ld(m, 0x0176, 5)) + 1) & 0xff) | 0x30;
  m.charge(2); m.charge(2);
  yield* st(m, 0x017c, a, 5);
  yield* st(m, 0x015c, yield* ld(m, 0x0156, 5), 5);
  yield* st(m, 0x013c, yield* ld(m, 0x0136, 5), 5);
  return yield* lE68E(m);
}

/**
 * lE68E: pay out the grand total digits $017C / $015C / $013C into the
 * score: 100 x (add_score 1) per hundreds digit, 10 x per tens digit,
 * the units digit once each -- then lE3B5.
 * @param {Machine} m @returns {Gen}
 */
function* lE68E(m) {
  // Each loop re-reads its counter from RAM (dec $1162 / bne).
  for (const [tile, n] of [[0x017c, 0x64], [0x015c, 0x0a]]) {
    const d = (yield* ld(m, tile, 5)) & 0x0f;
    m.charge(2); m.charge(3);
    if (d !== 0) {
      yield* st(m, 0x1162, d, 5);
      let left;
      do {
        m.charge(2);
        yield* st(m, 0x1164, n, 5 + 7); // + bsr
        yield* sub_E6C8(m);
        left = yield* rmw(m, 0x1162, minus1, 7);
        m.charge(3);
      } while (left !== 0);
    }
  }
  // $E6BA: ldb $013C / andb #$0F / beq lE6D3 / stb $1164 / bsr / bra
  const d = (yield* ld(m, 0x013c, 5)) & 0x0f;
  m.charge(2); m.charge(3);
  if (d !== 0) {
    yield* st(m, 0x1164, d, 5 + 7);
    yield* sub_E6C8(m);
    m.charge(3);
  }
  // $E6D3: jmp lE3B5
  m.charge(4);
  return yield* lE3B5(m);
}

/**
 * $E6C8 sub_E6C8: `add_score(1)` (10 points) $1164 times.
 *
 *   $E6C8: lda #$01 / jsr add_score / dec $1164 / bne $E6C8 / rts
 *
 * @see gaplus-main.asm $E6C8
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E6C8(m) {
  let left;
  do {
    m.charge(2); m.charge(8);
    yield* call(MAIN.add_score, m, { a: 0x01 });
    left = yield* rmw(m, 0x1164, minus1, 7);
    m.charge(3);
  } while (left !== 0);
  m.charge(5);
}

/**
 * $E6D6 sub_E6D6: kinds 1 and 4 pay-out: grand total = earnings with
 * the button digit ($017A & 7) added to the hundreds, then lE68E.
 * @see gaplus-main.asm $E6D6
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E6D6(m) {
  printGrandTotal(m);
  // $E6E0: lda $017A / anda #$07 / adda $0176 / ora #$30 / sta $017C
  let a = (yield* ld(m, 0x017a, 5)) & 0x07;
  m.charge(2);
  a = ((a + (yield* ld(m, 0x0176, 5))) & 0xff) | 0x30;
  m.charge(2);
  yield* st(m, 0x017c, a, 5);
  yield* st(m, 0x015c, yield* ld(m, 0x0156, 5), 5);
  yield* st(m, 0x013c, yield* ld(m, 0x0136, 5), 5);
  m.charge(4); // jmp lE68E
  return yield* lE68E(m);
}

/**
 * $E6FC sub_E6FC: kind 2 pay-out: grand total = earnings + bonus.
 * @see gaplus-main.asm $E6FC
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E6FC(m) {
  printGrandTotal(m);
  return yield* lE706(m);
}

/**
 * lE706: grand total ($013C/$015C/$017C) = earnings ($0136/$0156/$0176)
 * + bonus ($013A/$015A/$017A), digit by digit in BCD with the carry in
 * $1164; then lE68E.
 * @param {Machine} m @returns {Gen}
 */
function* lE706(m) {
  // units: lda $0136 / anda / sta $1164 / lda $013A / anda / adda $1164
  let a = (yield* ld(m, 0x0136, 5)) & 0x0f;
  m.charge(2);
  yield* st(m, 0x1164, a, 5);
  a = (yield* ld(m, 0x013a, 5)) & 0x0f;
  m.charge(2);
  a = bcdAdd(a, yield* ld(m, 0x1164, 5));
  m.charge(2);
  yield* st(m, 0x1164, a, 5);
  m.charge(2); m.charge(2);
  yield* st(m, 0x013c, (a & 0x0f) | 0x30, 5);
  yield* lsr4(m, 0x1164);
  for (const [e, bn, g] of [[0x0156, 0x015a, 0x015c],
    [0x0176, 0x017a, 0x017c]]) {
    // lda e / anda / sta $1167 / lda bn / anda / adda $1167 / daa /
    // adda $1164 / daa / sta $1164 / anda / ora / sta g
    a = (yield* ld(m, e, 5)) & 0x0f;
    m.charge(2);
    yield* st(m, 0x1167, a, 5);
    a = (yield* ld(m, bn, 5)) & 0x0f;
    m.charge(2);
    a = bcdAdd(a, yield* ld(m, 0x1167, 5));
    m.charge(2);
    a = bcdAdd(a, yield* ld(m, 0x1164, 5));
    m.charge(2);
    yield* st(m, 0x1164, a, 5);
    m.charge(2); m.charge(2);
    yield* st(m, g, (a & 0x0f) | 0x30, 5);
    if (g === 0x015c) yield* lsr4(m, 0x1164);
  }
  m.charge(4); // jmp lE68E
  return yield* lE68E(m);
}

/**
 * $E77A sub_E77A: kind 3 pay-out, the same as sub_E6FC.
 * @see gaplus-main.asm $E77A
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E77A(m) {
  printGrandTotal(m);
  m.charge(4); // jmp lE706
  return yield* lE706(m);
}

/**
 * lE787: print the grand total line, then lE791.
 * @param {Machine} m @returns {Gen}
 */
function* lE787(m) {
  printGrandTotal(m);
  return yield* lE791(m);
}

/**
 * lE791: grand total = earnings (no bonus), then lE68E.
 * @param {Machine} m @returns {Gen}
 */
function* lE791(m) {
  for (const d of [0x0136, 0x0156, 0x0176]) {
    yield* st(m, d + 6, yield* ld(m, d, 5), 5);
  }
  m.charge(4); // jmp lE68E
  return yield* lE68E(m);
}

/**
 * $E7A6 sub_E7A6: kind 5 pay-out: move the component sprite (shadow
 * $0F2C/$172C/$1F2C) up one step a frame (sound 6) until its Y reaches
 * $CB (or $BB for the $27 code), then copy it to entry $0F28 (or $0F26)
 * and park it; once there, lE787.
 * @see gaplus-main.asm $E7A6
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E7A6(m) {
  // $E7A6: lda $0F2C / cmpa #$27 / beq lE7DF
  const alt = (yield* ld(m, 0x0f2c, 5)) === 0x27;
  m.charge(2); m.charge(3); m.charge(2);
  const y = alt ? 0xbb : 0xcb;
  const dst = alt ? 0x0f26 : 0x0f28;
  // lda #y / cmpa $172C / lbeq lE787
  if ((yield* ld(m, 0x172c, 5)) === y) {
    m.charge(6);
    return yield* lE787(m);
  }
  m.charge(5); m.charge(2);
  yield* st(m, 0x6046, 0x01, 5); // snd_request+6
  yield* rmw(m, 0x172c, plus1, 7 + 2);
  // lda #y / cmpa $172C / lbne lE857
  if ((yield* ld(m, 0x172c, 5)) === y) {
    m.charge(5);
    copy16(m, dst, 0x0f2c);
    copy16(m, dst + 0x0800, 0x172c);
    copy16(m, dst + 0x1000, 0x1f2c);
    yield* rmw(m, 0x1f2d, zero, 7 + 4);
  } else {
    m.charge(6);
  }
  yield* lE857(m);
  return undefined;
}

/**
 * $E811 sub_E811: kind 6 pay-out: count down the dropped component's
 * timer ($1728 when $1F29 is set, else $1726) with sound 6; when it runs
 * out clear its flag; with no component ($1F27 = 0), lE787.
 * @see gaplus-main.asm $E811
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E811(m) {
  if ((yield* ld(m, 0x1f27, 5)) === 0) {
    m.charge(6);
    return yield* lE787(m);
  }
  m.charge(5);
  const f = yield* ld(m, 0x1f29, 5);
  m.charge(3);
  // dec $1728 / bne lE833 / clr $1F29 / jmp lE787, or the same with
  // $1726 and $1F27
  const [cnt, flag] = f !== 0 ? [0x1728, 0x1f29] : [0x1726, 0x1f27];
  const left = yield* rmw(m, cnt, minus1, 7);
  m.charge(3);
  if (left === 0) {
    yield* rmw(m, flag, zero, 7 + 4);
    return yield* lE787(m);
  }
  // lE833: lda #$01 / sta snd_request+6 / jmp lE857
  m.charge(2);
  yield* st(m, 0x6046, 0x01, 5 + 4);
  yield* lE857(m);
  return undefined;
}

/**
 * $E83B sub_E83B: kind 7 pay-out: one more life for the current player
 * (sub_FB9E redraws the reserve; sound $15 counted up), then lE787.
 * @see gaplus-main.asm $E83B
 * @param {Machine} m @returns {Gen}
 */
export function* sub_E83B(m) {
  const p2 = (yield* ld(m, 0x102d, 4)) !== 0;
  m.charge(3);
  yield* rmw(m, p2 ? 0x1105 : 0x1104, plus1, 7); // lives_p2 / lives_p1
  m.charge(8);
  yield* call(MAIN.sub_FB9E, m, {});
  yield* rmw(m, 0x6055, plus1, 7 + 4); // snd_request+21, jmp lE787
  return yield* lE787(m);
}

/**
 * $E85C print_string_attr: print the zero-terminated string at U from
 * tile address X going right (X -= $20 per character), writing
 * attribute B to each cell. Only called with tile-RAM targets and ROM
 * strings from this range, so it never touches racy RAM: plain.
 *
 *   $E85C: lda ,u+ / beq rts / sta ,x / stb $0400,x / leax -$20,x / bra
 *
 * @see gaplus-main.asm $E85C
 * @param {Machine} m
 * @param {{ x: number, u: number, b: number }} regs
 * @returns {{ a: number, x: number, u: number, zf: boolean }} A = 0, X
 *   past the last cell, U past the terminator
 */
export function print_string_attr(m, { x, u, b }) {
  let px = x & 0xffff;
  let pu = u & 0xffff;
  for (;;) {
    const a = m.read('main', pu); // lda ,u+ (6) / beq (3)
    pu = (pu + 1) & 0xffff;
    m.charge(6); m.charge(3);
    if (a === 0) break;
    m.poke(px, a); // sta ,x
    m.charge(4);
    m.poke((px + 0x0400) & 0xffff, b); // stb $0400,x
    m.charge(8); m.charge(5); m.charge(3); // + leax -$20,x / bra
    px = (px - 0x20) & 0xffff;
  }
  m.charge(5); // rts
  return { a: 0, x: px, u: pu, zf: true };
}

/** Routine name -> function, registered in MAIN by gp2_2b.js. */
export const ROUTINES = {
  task_results, sub_E22F, sub_E29A, sub_E2D0, sub_E332, sub_E346,
  sub_E3AD, sub_E3FF, sub_E4DA, sub_E4F5, sub_E50C, sub_E53A, sub_E563,
  sub_E5F3, sub_E626, sub_E63D, sub_E66F, sub_E6C8, sub_E6D6, sub_E6FC,
  sub_E77A, sub_E7A6, sub_E811, sub_E83B, print_string_attr,
};

/** Address -> function, registered in MAIN_AT by gp2_2b.js. */
export const AT = {
  0xe21a: task_results, 0xe22f: sub_E22F, 0xe29a: sub_E29A,
  0xe2d0: sub_E2D0, 0xe332: sub_E332, 0xe346: sub_E346, 0xe3ad: sub_E3AD,
  0xe3ff: sub_E3FF, 0xe4da: sub_E4DA, 0xe4f5: sub_E4F5, 0xe50c: sub_E50C,
  0xe53a: sub_E53A, 0xe563: sub_E563, 0xe5f3: sub_E5F3, 0xe626: sub_E626,
  0xe63d: sub_E63D, 0xe66f: sub_E66F, 0xe6c8: sub_E6C8, 0xe6d6: sub_E6D6,
  0xe6fc: sub_E6FC, 0xe77a: sub_E77A, 0xe7a6: sub_E7A6, 0xe811: sub_E811,
  0xe83b: sub_E83B, 0xe85c: print_string_attr,
};

// Copyright 2026 by Moshix
/**
 * Main CPU $F5C4-$FA7C: the hit-effect sprites (task_spawn_effect,
 * task_animate_effects and the effect_steps table), the player-explosion
 * sequence (sub_F6DD and the eight steps of tbl_F6FC, which end in the
 * lose-a-life path $D9CF of gp2-3b), the shadow-sprite colour cycling
 * (sub_F8DA) and the shot-vs-object collision task (sub_F921).
 *
 * Effect slots: $110C-$110E hold a step counter per slot (0 = free); the
 * sprite shadow entries are $0E8C/$0E8E/$0E90 (+$0800 Y/X, +$1000
 * attribute/flags). A spawn request is $1108 (count) with its position
 * in $1109/$110A and flags in $110B.
 *
 * TIMING. Every routine charges (m.charge) the MAME cycles of each 6809
 * instruction it executes, from its entry through its RTS or its final
 * JMP (task_dispatch, $D9CF); the JSR [A,X] / JMP [A,X] into a step is
 * charged by the caller. An instruction's cycles are charged AFTER its
 * memory accesses, so m.charged[0] at an access is the cycle at which
 * the instruction starts, and the code yields SYNC right before every
 * instruction that touches RAM (all of it is work RAM the sub CPU sees
 * too). So every routine is a generator. The tests compare the totals
 * and every write's cycle with the ROM's.
 *
 * NOT PORTED: $F924-$F9CF disassembles as an older version of the
 * collision task, but `JMP $F9D5` at $F921 skips it and nothing else
 * reaches it (no coverage hit in ~78,000 frames, no pointer to it).
 *
 * @see reference/gaplus-main.asm $F5C4-$FA7C
 */

import { mainAt } from './routines.js';
import { call } from '../call.js';
import { mainRom } from '../romdata.js';
import { disp8, add8, sub8, adc8, sbc8, inc8, dec8 } from '../m6809ops.js';
import { SYNC } from './gp2_2b_state.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/**
 * A timed 8-bit load: SYNC, read at the instruction's start, then charge
 * the instruction.
 * @param {Machine} m @param {number} a @param {number} cyc
 * @returns {Generator<unknown, number, unknown>}
 */
function* ld8(m, a, cyc) {
  yield SYNC;
  const v = m.peek(a & 0xffff);
  m.charge(cyc);
  return v;
}

/**
 * A timed 16-bit load (LDD: high byte first).
 * @param {Machine} m @param {number} a @param {number} cyc
 * @returns {Generator<unknown, number, unknown>}
 */
function* ld16(m, a, cyc) {
  yield SYNC;
  const v = m.peek16(a & 0xffff);
  m.charge(cyc);
  return v;
}

/**
 * A timed 8-bit store.
 * @param {Machine} m @param {number} a @param {number} v @param {number} cyc
 * @returns {Generator<unknown, void, unknown>}
 */
function* st8(m, a, v, cyc) {
  yield SYNC;
  m.poke(a & 0xffff, v & 0xff);
  m.charge(cyc);
}

/**
 * A timed 16-bit store (STD/STX: high byte first).
 * @param {Machine} m @param {number} a @param {number} v @param {number} cyc
 * @returns {Generator<unknown, void, unknown>}
 */
function* st16(m, a, v, cyc) {
  yield SYNC;
  m.poke16(a & 0xffff, v & 0xffff);
  m.charge(cyc);
}

/**
 * A timed read-modify-write (INC, DEC, CLR: the 6809 reads first).
 * @param {Machine} m @param {number} a @param {(v: number) => number} f
 * @param {number} cyc
 * @returns {Generator<unknown, number, unknown>} the value written
 */
function* rmw(m, a, f, cyc) {
  yield SYNC;
  const v = f(m.peek(a & 0xffff)) & 0xff;
  m.poke(a & 0xffff, v);
  m.charge(cyc);
  return v;
}

/** @param {number} v */
const incF = (v) => inc8(v).v;
/** @param {number} v */
const decF = (v) => dec8(v).v;
/** CLR: the operand is read, 0 written. */
const clrF = () => 0;

/**
 * lF5F5 / lF8D5 / lF918 / lF9D0: `INC <main_task (6) / JMP task_dispatch
 * (4)` -- the end of every task here.
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>}
 */
function* taskEnd(m) {
  yield* rmw(m, 0x1030, incF, 6); // main_task
  m.charge(4);
  return undefined;
}

/**
 * $F5C4 task_spawn_effect: when a spawn is requested ($1108 > 0), take
 * one request and start an effect in the first free slot of $110C-$110E
 * (step 1), with the requested position ($1109/$110A -> +$0800) and
 * flags ($40, $110B -> +$1000). If all three slots are busy the request
 * is dropped (the DEC has already happened).
 * @see gaplus-main.asm $F5C4
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* task_spawn_effect(m) {
  // $F5C4: lda $1108 (5) / beq lF5F5 (3)
  const n = yield* ld8(m, 0x1108, 5);
  m.charge(3);
  if (n !== 0) {
    // $F5C9: dec $1108 (7) / ldb #$FE (2) / ldx #$110C (3)
    yield* rmw(m, 0x1108, decF, 7);
    m.charge(2); m.charge(3);
    let b = 0xfe;
    for (let x = 0x110c; ; x += 1) {
      // $F5D1: addb #$02 (2) / cmpx #$110F (4) / beq lF5F5 (3)
      b = (b + 2) & 0xff;
      m.charge(2); m.charge(4); m.charge(3);
      if (x === 0x110f) break;
      // $F5D8: lda ,x+ (6) / bne $F5D1 (3)
      const a = yield* ld8(m, x, 6);
      m.charge(3);
      if (a !== 0) continue;
      // $F5DC: lda #$01 (2) / sta -$1,x (5) -- the slot starts at step 1
      m.charge(2);
      yield* st8(m, x, 0x01, 5);
      // $F5E0: ldx #$0E8C (3) / leax b,x (5) -- B = 0, 2, 4: signed,
      // positive
      m.charge(3); m.charge(5);
      const e = disp8(0x0e8c, b);
      // $F5E5: ldd $1109 (6) / std $0800,x (9)
      const d = yield* ld16(m, 0x1109, 6);
      yield* st16(m, e + 0x0800, d, 9);
      // $F5EC: lda #$40 (2) / ldb $110B (5) / std $1000,x (9)
      m.charge(2);
      const f = yield* ld8(m, 0x110b, 5);
      yield* st16(m, e + 0x1000, 0x4000 | f, 9);
      break;
    }
  }
  return yield* taskEnd(m);
}

/**
 * $F5FA task_animate_effects: for each busy effect slot ($110C, $110D,
 * $110E; shadow entries $0E8C, $0E8E, $0E90) increment its step and run
 * effect_steps[old step] with U = the entry.
 *
 *   $F5FA: lda $110C / beq / inc $110C / ldu #$0E8C / asla /
 *          ldx #effect_steps / jsr [a,x]
 *
 * A holds the step read BEFORE the INC, doubled by an 8-bit ASLA, and the
 * A,X offset is signed. Entry 0 (sub_F673, only reachable with a step of
 * $80) leaves the task without returning to it: it does the task's own
 * `INC <$30 / JMP task_dispatch`, skipping the later slots.
 * @see gaplus-main.asm $F5FA
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* task_animate_effects(m) {
  for (let i = 0; i < 3; i += 1) {
    const slot = 0x110c + i;
    // lda $110C+i (5) / beq (3)
    const a = yield* ld8(m, slot, 5);
    m.charge(3);
    if (a === 0) continue;
    // inc (7) / ldu # (3) / asla (2) / ldx #effect_steps (3) /
    // jsr [a,x] (11)
    yield* rmw(m, slot, incF, 7);
    m.charge(3); m.charge(2); m.charge(3); m.charge(11);
    const u = 0x0e8c + 2 * i;
    const target = m.read16('main', disp8(0xf62f, (a << 1) & 0xff));
    const r = /** @type {{ exit?: boolean } | undefined} */ (
      yield* call(mainAt(target), m, { u }));
    // sub_F673 jumped to task_dispatch itself (after its INC <$30)
    if (r !== undefined && r !== null && r.exit === true) return undefined;
    // $F62D: bra lF5F5 (3) after the third slot's JSR
    if (i === 2) m.charge(3);
  }
  return yield* taskEnd(m);
}

/**
 * $F673 sub_F673 (effect_steps[0]): `BRA lF5F5` -- does the calling
 * task's `INC <$30 / JMP task_dispatch` from inside the JSR (the return
 * address is left on the stack, which the next CWAI's LDS discards).
 * The port returns `{ exit: true }` so task_animate_effects returns at
 * once.
 * @see gaplus-main.asm $F673
 * @param {Machine} m
 * @param {{ u?: number }} [_regs]
 * @returns {Generator<unknown, { exit: boolean }, unknown>}
 */
export function* sub_F673(m, _regs = {}) {
  m.charge(3); // bra lF5F5
  yield* taskEnd(m);
  return { exit: true };
}

/**
 * `LDD #code / STD ,U / RTS`: the body of effect steps 1, 9 and 24.
 * @param {Machine} m @param {number} u @param {number} d
 * @returns {Generator<unknown, undefined, unknown>}
 */
function* setCode(m, u, d) {
  m.charge(3); // ldd #
  yield* st16(m, u, d, 5); // std ,u
  m.charge(5); // rts
  return undefined;
}

/**
 * $F675 sub_F675 (effect step 1): sprite code/colour $68,$32 at ,U.
 * @see gaplus-main.asm $F675
 * @param {Machine} m @param {{ u: number }} regs
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F675(m, { u }) {
  return yield* setCode(m, u, 0x6832);
}

/**
 * $F67B sub_F67B (most effect steps): `INC $1,U` -- the colour byte.
 * @see gaplus-main.asm $F67B
 * @param {Machine} m @param {{ u: number }} regs
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F67B(m, { u }) {
  yield* rmw(m, u + 1, incF, 7); // inc $1,u
  m.charge(5); // rts
  return undefined;
}

/**
 * $F67E sub_F67E (effect step 9): code/colour $69,$32 at ,U.
 * @see gaplus-main.asm $F67E
 * @param {Machine} m @param {{ u: number }} regs
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F67E(m, { u }) {
  return yield* setCode(m, u, 0x6932);
}

/**
 * $F684 sub_F684 (effect step 17): code $60,$32 at ,U, then the sprite
 * becomes double size: Y -= 8, X -= 8 (+ 8 when flipped) with the X
 * carry/borrow going into the X high bit at $1001,U, and flags $68 at
 * $1000,U.
 * @see gaplus-main.asm $F684
 * @param {Machine} m @param {{ u: number }} regs
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F684(m, { u }) {
  // $F684: ldd #$6032 (3) / std ,u (5) / lda <$2C (4) / beq (3)
  m.charge(3);
  yield* st16(m, u, 0x6032, 5);
  const flip = yield* ld8(m, 0x102c, 4); // flip_screen
  m.charge(3);
  const pos = u + 0x0800;
  // ldd $0800,u (9)
  const d = yield* ld16(m, pos, 9);
  let b;
  if (flip !== 0) {
    // $F691: suba #$08 (2) / addb #$08 (2) / std $0800,u (9) /
    // ldb $1001,u (8) / adcb #$00 (2) / bra (3) -- the carry of the
    // ADDB (STD and LDB leave C alone)
    const ra = sub8(d >> 8, 0x08);
    const rb = add8(d & 0xff, 0x08);
    m.charge(2); m.charge(2);
    yield* st16(m, pos, (ra.v << 8) | rb.v, 9);
    b = adc8(yield* ld8(m, u + 0x1001, 8), 0x00, rb.cc).v;
    m.charge(2); m.charge(3);
  } else {
    // $F6A5: suba #$08 / subb #$08 / std / ldb $1001,u / sbcb #$00 --
    // the borrow of the SUBB
    const ra = sub8(d >> 8, 0x08);
    const rb = sub8(d & 0xff, 0x08);
    m.charge(2); m.charge(2);
    yield* st16(m, pos, (ra.v << 8) | rb.v, 9);
    b = sbc8(yield* ld8(m, u + 0x1001, 8), 0x00, rb.cc).v;
    m.charge(2);
  }
  // $F6B3: lda #$68 (2) / std $1000,u (9) / rts (5)
  m.charge(2);
  yield* st16(m, u + 0x1000, 0x6800 | b, 9);
  m.charge(5);
  return undefined;
}

/**
 * $F6BA sub_F6BA (effect step 24): code/colour $64,$32 at ,U.
 * @see gaplus-main.asm $F6BA
 * @param {Machine} m @param {{ u: number }} regs
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F6BA(m, { u }) {
  return yield* setCode(m, u, 0x6432);
}

/**
 * $F6C0 sub_F6C0 (effect step 32): `CLR $1001,U` -- the sprite is no
 * longer in use.
 * @see gaplus-main.asm $F6C0
 * @param {Machine} m @param {{ u: number }} regs
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F6C0(m, { u }) {
  yield* rmw(m, u + 0x1001, clrF, 10); // clr $1001,u
  m.charge(5); // rts
  return undefined;
}

/**
 * $F6C5 sub_F6C5 (effect step 33): free the slot that owns U ($0E8C ->
 * $110C, $0E8E -> $110D, anything else -> $110E).
 * @see gaplus-main.asm $F6C5
 * @param {Machine} m @param {{ u: number }} regs
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F6C5(m, { u }) {
  // cmpu #$0E8C (5) / beq (3) [/ cmpu #$0E8E (5) / beq (3)] /
  // clr (7) / rts (5)
  let slot = 0x110c;
  m.charge(5); m.charge(3);
  if (u !== 0x0e8c) {
    m.charge(5); m.charge(3);
    slot = u === 0x0e8e ? 0x110d : 0x110e;
  }
  yield* rmw(m, slot, clrF, 7);
  m.charge(5);
  return undefined;
}

/**
 * $F6DD sub_F6DD: the player's explosion. While $110F is set: $80 to
 * $112A and $101A, and every 8th frame (frame_counter & 7 == 0) one step
 * of tbl_F6FC indexed by $1110. The last step ends with the life-lost
 * path in gp2-3b ($D9CF), which the port tail-calls.
 * @see gaplus-main.asm $F6DD
 * @param {Machine} m
 * @returns {Generator<unknown, unknown, unknown>}
 */
export function* sub_F6DD(m) {
  // $F6DD: lda $110F (5) / lbeq lF8D5 (6 taken, 5 not)
  if ((yield* ld8(m, 0x110f, 5)) === 0) {
    m.charge(6);
    return yield* taskEnd(m);
  }
  m.charge(5);
  // $F6E4: lda #$80 (2) / sta $112A (5) / sta <$1A (4)
  m.charge(2);
  yield* st8(m, 0x112a, 0x80, 5);
  yield* st8(m, 0x101a, 0x80, 4);
  // $F6EB: lda <$16 (4) / anda #$07 (2) / lbne lF8D5
  const fc = yield* ld8(m, 0x1016, 4); // frame_counter
  m.charge(2);
  if ((fc & 0x07) !== 0) {
    m.charge(6);
    return yield* taskEnd(m);
  }
  m.charge(5);
  // $F6F3: lda $1110 (5) / ldx #tbl_F6FC (3) / asla (2) / jmp [a,x] (7)
  // -- signed offset
  const a = ((yield* ld8(m, 0x1110, 5)) << 1) & 0xff;
  m.charge(3); m.charge(2); m.charge(7);
  const target = m.read16('main', disp8(0xf6fc, a));
  return yield* call(mainAt(target), m, {});
}

/**
 * The end of every tbl_F6FC step: `INC $1110 (7) / JMP lF8D5 (4)` (next
 * step), then the task's `INC <$30 / JMP task_dispatch`.
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>}
 */
function* nextStep(m) {
  yield* rmw(m, 0x1110, incF, 7);
  m.charge(4);
  return yield* taskEnd(m);
}

/**
 * $F70C sub_F70C (explosion step 0): the explosion sprite at shadow
 * entry $0F32 ($8E,$26) centred 8 pixels off the player (X +/- 8 with
 * the carry into the X high bit from $1E01, by flip), the player's
 * sprite and state cleared ($1E01, $1E8B, $1021, $1177, $1114, and
 * $1018/$1F2D when $1F2D b7), the six flags $1EC3-$1ECD cleared.
 * @see gaplus-main.asm $F70C
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F70C(m) {
  // $F70C: lda #$01 (2) / sta <$D9 (4) / sta <$E9 (4) / ldd #$8E26 (3) /
  // std $0F32 (6) / lda <$2C (4) / beq (3)
  m.charge(2);
  yield* st8(m, 0x10d9, 0x01, 4);
  yield* st8(m, 0x10e9, 0x01, 4);
  m.charge(3);
  yield* st16(m, 0x0f32, 0x8e26, 6);
  const flip = yield* ld8(m, 0x102c, 4); // flip_screen
  m.charge(3);
  // lda $1601 (5) / adda|suba #$08 (2) / sta $1733 (5) / ldb $1E01 (5) /
  // adcb|sbcb #$00 (2) [/ bra (3)] -- the carry of the ADDA/SUBA
  const x = yield* ld8(m, 0x1601, 5); // player_x
  const r = flip !== 0 ? add8(x, 0x08) : sub8(x, 0x08);
  m.charge(2);
  yield* st8(m, 0x1733, r.v, 5);
  const hb = yield* ld8(m, 0x1e01, 5);
  const b = flip !== 0 ? adc8(hb, 0x00, r.cc).v : sbc8(hb, 0x00, r.cc).v;
  m.charge(flip !== 0 ? 2 + 3 : 2);
  // $F738: lda #$08 (2) / std $1F32 (6)
  m.charge(2);
  yield* st16(m, 0x1f32, 0x0800 | b, 6);
  // $F73D: lda $1600 (5) / sta $1732 (5) -- player_y
  const y = yield* ld8(m, 0x1600, 5);
  yield* st8(m, 0x1732, y, 5);
  // clr $1E01 (7) / clr $1E8B (7) / clr <$21 (6) / clr $1177 (7) /
  // clr $1114 (7)
  yield* rmw(m, 0x1e01, clrF, 7);
  yield* rmw(m, 0x1e8b, clrF, 7);
  yield* rmw(m, 0x1021, clrF, 6);
  yield* rmw(m, 0x1177, clrF, 7);
  yield* rmw(m, 0x1114, clrF, 7);
  // $F751: lda $1F2D (5) / anda #$80 (2) / beq (3) / clr <$18 (6) /
  // clr $1F2D (7)
  const f = yield* ld8(m, 0x1f2d, 5);
  m.charge(2); m.charge(3);
  if ((f & 0x80) !== 0) {
    yield* rmw(m, 0x1018, clrF, 6);
    yield* rmw(m, 0x1f2d, clrF, 7);
  }
  // $F75D: ldx #$1EC3 (3) / lda #$06 (2) / clr ,x++ (9) / deca (2) /
  // bne (3)
  m.charge(3); m.charge(2);
  for (let a = 0x1ec3; a < 0x1ecf; a += 2) {
    yield* rmw(m, a, clrF, 9);
    m.charge(2); m.charge(3);
  }
  return yield* nextStep(m);
}

/**
 * `LDD #d / STD $0F16 / STD $0F18 / STD $0F1A / STD $0F1C` then
 * `LDA #a / STA $1F16 ... $1F1C` (CLRA when a = 0): the four captured-
 * ship shadow entries. Shared by sub_F76D and sub_F824.
 * @param {Machine} m @param {number} d @param {number} a
 * @returns {Generator<unknown, void, unknown>}
 */
function* setFour(m, d, a) {
  m.charge(3); // ldd #
  for (let p = 0x0f16; p <= 0x0f1c; p += 2) yield* st16(m, p, d, 6);
  m.charge(2); // clra / lda #
  for (let p = 0x1f16; p <= 0x1f1c; p += 2) yield* st8(m, p, a, 5);
}

/**
 * $F76D sub_F76D (explosion step 1): in game mode 5, when
 * (score_p1 | score_p1+1) == 1 and formation_flags+42 b0 and $1F15 b7
 * are set: flag $1178/$1179 and park the four $0F16 entries. Then the
 * explosion grows to two sprites ($0F30 and $0F32, 16 pixels apart).
 * @see gaplus-main.asm $F76D
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F76D(m) {
  // Each test: load(s), then anda/suba #n (2) and a branch (3).
  let ok = false;
  // $F76D: lda <$2F (4) / suba #$05 / bne
  if ((yield* ld8(m, 0x102f, 4)) === 0x05) {
    m.charge(2); m.charge(3);
    // $F773: lda $09B0 (5) / ora $09B1 (5) / suba #$01 / bne
    const s0 = yield* ld8(m, 0x09b0, 5);
    const s1 = yield* ld8(m, 0x09b1, 5);
    m.charge(2); m.charge(3);
    if ((s0 | s1) === 0x01) {
      // $F77D: lda $188A (5) / anda #$01 / beq
      const ff = yield* ld8(m, 0x188a, 5);
      m.charge(2); m.charge(3);
      if ((ff & 0x01) !== 0) {
        // $F784: lda $1F15 (5) / anda #$80 / beq
        const g = yield* ld8(m, 0x1f15, 5);
        m.charge(2); m.charge(3);
        ok = (g & 0x80) !== 0;
      }
    }
  } else {
    m.charge(2); m.charge(3);
  }
  if (ok) {
    // $F78B: lda #$01 (2) / sta $1178 (5) / sta $1179 (5) / lda #$A8 (2) /
    // sta <$D4 (4)
    m.charge(2);
    yield* st8(m, 0x1178, 0x01, 5);
    yield* st8(m, 0x1179, 0x01, 5);
    m.charge(2);
    yield* st8(m, 0x10d4, 0xa8, 4);
    // $F797: ldd #$7F3F / std x4 / clra / sta $1F16.. x4
    yield* setFour(m, 0x7f3f, 0x00);
  }
  // lF7B3: lda #$AE (2) / sta $0F32 (5)
  m.charge(2);
  yield* st8(m, 0x0f32, 0xae, 5);
  // $F7B8: lda $1732 (5) / suba #$08 (2) / sta $1732 (5)
  const y = yield* ld8(m, 0x1732, 5);
  m.charge(2);
  yield* st8(m, 0x1732, sub8(y, 0x08).v, 5);
  // $F7C0: ldd #$9E26 (3) / std $0F30 (6)
  m.charge(3);
  yield* st16(m, 0x0f30, 0x9e26, 6);
  // $F7C6: ldd $1732 (6) / adda #$10 (2) / std $1730 (6)
  const d = yield* ld16(m, 0x1732, 6);
  m.charge(2);
  yield* st16(m, 0x1730, ((((d >> 8) + 0x10) & 0xff) << 8) | (d & 0xff), 6);
  // $F7CE: ldd $1F32 (6) / std $1F30 (6)
  const f = yield* ld16(m, 0x1f32, 6);
  yield* st16(m, 0x1f30, f, 6);
  return yield* nextStep(m);
}

/**
 * `LDA #a / STA $0F30 / LDA #b / STA $0F32`, then the next step: the
 * body of explosion steps 2 and 3.
 * @param {Machine} m @param {number} a @param {number} b
 * @returns {Generator<unknown, undefined, unknown>}
 */
function* twoCodes(m, a, b) {
  m.charge(2);
  yield* st8(m, 0x0f30, a, 5);
  m.charge(2);
  yield* st8(m, 0x0f32, b, 5);
  return yield* nextStep(m);
}

/**
 * $F7DA sub_F7DA (explosion step 2): codes $CE/$DE.
 * @see gaplus-main.asm $F7DA
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F7DA(m) {
  return yield* twoCodes(m, 0xce, 0xde);
}

/**
 * $F7EA sub_F7EA (explosion step 3): codes $EE/$FE.
 * @see gaplus-main.asm $F7EA
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F7EA(m) {
  return yield* twoCodes(m, 0xee, 0xfe);
}

/**
 * $F7FA sub_F7FA (explosion step 4): back to one sprite ($1F31 cleared),
 * code $58,$27 at $0F32, flags $68.
 * @see gaplus-main.asm $F7FA
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F7FA(m) {
  // clr $1F31 (7) / ldd #$5827 (3) / std $0F32 (6) / lda #$68 (2) /
  // sta $1F32 (5)
  yield* rmw(m, 0x1f31, clrF, 7);
  m.charge(3);
  yield* st16(m, 0x0f32, 0x5827, 6);
  m.charge(2);
  yield* st8(m, 0x1f32, 0x68, 5);
  return yield* nextStep(m);
}

/**
 * $F80E sub_F80E (explosion step 5): code $5C at $0F32.
 * @see gaplus-main.asm $F80E
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F80E(m) {
  m.charge(2); // ldb #$5C
  yield* st8(m, 0x0f32, 0x5c, 5);
  return yield* nextStep(m);
}

/**
 * $F819 sub_F819 (explosion step 6): $F8 at $0F30 (a countdown to 0).
 * @see gaplus-main.asm $F819
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F819(m) {
  m.charge(2); // lda #$F8
  yield* st8(m, 0x0f30, 0xf8, 5);
  return yield* nextStep(m);
}

/**
 * $F824 sub_F824 (explosion step 7): counts $0F30 up to 0 (from at least
 * $F8) with $1F33 cleared; then, unless in game mode 4, ends the
 * explosion: resets the player's sprite ($0E00, $1600 = $78,$48, $1E00),
 * the captured ships ($0F16..: parked if the current player still has
 * one, $1178/$1179, else the default $26,$04 / $40), sets $1023/$1024 =
 * $FF in mode 5 and clears $1111/$10E9/$10D9, and goes to the life-lost
 * path $D9CF (gp2-3b) instead of back to the dispatcher.
 * @see gaplus-main.asm $F824
 * @param {Machine} m
 * @returns {Generator<unknown, unknown, unknown>}
 */
export function* sub_F824(m) {
  // $F824: lda $0F30 (5) / cmpa #$F7 (2) / bcc lF830 (3) /
  // lda #$F8 (2) / sta $0F30 (5)
  const c = yield* ld8(m, 0x0f30, 5);
  m.charge(2); m.charge(3);
  if (c < 0xf7) {
    m.charge(2);
    yield* st8(m, 0x0f30, 0xf8, 5);
  }
  // lF830: clr $1F33 (7) / inc $0F30 (7) / lbne lF8D5
  yield* rmw(m, 0x1f33, clrF, 7);
  if ((yield* rmw(m, 0x0f30, incF, 7)) !== 0) {
    m.charge(6);
    return yield* taskEnd(m);
  }
  m.charge(5);
  // $F83A: lda <$2F (4) / cmpa #$04 (2) / lbeq lF8D5
  const mode = yield* ld8(m, 0x102f, 4);
  m.charge(2);
  if (mode === 0x04) {
    m.charge(6);
    return yield* taskEnd(m);
  }
  m.charge(5);
  // clr $1110 / clr $1F33 / clr $110F (7 each)
  yield* rmw(m, 0x1110, clrF, 7);
  yield* rmw(m, 0x1f33, clrF, 7);
  yield* rmw(m, 0x110f, clrF, 7);
  // $F84B: lda <$2E (4) / beq lF85A (3) / lda <$2D (4) / bne lF85A (3) /
  // lda $1179 (5) / beq lF884 (3) / bra lF85F (3);
  // lF85A: lda $1178 (5) / beq lF884 (3)
  let flag;
  const two = yield* ld8(m, 0x102e, 4); // two_players
  m.charge(3);
  let useP2 = false;
  if (two !== 0) {
    const cur = yield* ld8(m, 0x102d, 4); // cur_player
    m.charge(3);
    useP2 = cur === 0;
  }
  if (useP2) {
    flag = yield* ld8(m, 0x1179, 5);
    m.charge(3);
    if (flag !== 0) m.charge(3); // bra lF85F
  } else {
    flag = yield* ld8(m, 0x1178, 5);
    m.charge(3);
  }
  let d;
  if (flag !== 0) {
    // lF85F: the four entries parked, lda #$A8 (2) / sta <$D4 (4) /
    // ldd #$7E3F (3) / bra lF8A8 (3)
    yield* setFour(m, 0x7f3f, 0x00);
    m.charge(2);
    yield* st8(m, 0x10d4, 0xa8, 4);
    m.charge(3); m.charge(3);
    d = 0x7e3f;
  } else {
    // lF884: $26,$04 / $40, lda #$A6 (2) / sta <$D4 (4) / ldd #$2E00 (3)
    yield* setFour(m, 0x2604, 0x40);
    m.charge(2);
    yield* st8(m, 0x10d4, 0xa6, 4);
    m.charge(3);
    d = 0x2e00;
  }
  // lF8A8: std $0E00 (6) / ldd #$7848 (3) / std $1600 (6) /
  // ldd #$0000 (3) / std $1E00 (6)
  yield* st16(m, 0x0e00, d, 6);
  m.charge(3);
  yield* st16(m, 0x1600, 0x7848, 6);
  m.charge(3);
  yield* st16(m, 0x1e00, 0x0000, 6);
  // $F8B7: lda <$2F (4) / cmpa #$05 (2) / bne lF8CB (3) / lda <$2D (4) /
  // bne (3) / lda #$FF (2) / sta <$23 (4) / bra (3) | sta <$24 (4)
  const mode2 = yield* ld8(m, 0x102f, 4);
  m.charge(2); m.charge(3);
  if (mode2 === 0x05) {
    const cur = yield* ld8(m, 0x102d, 4);
    m.charge(3); m.charge(2);
    if (cur === 0) {
      yield* st8(m, 0x1023, 0xff, 4);
      m.charge(3);
    } else {
      yield* st8(m, 0x1024, 0xff, 4);
    }
  }
  // lF8CB: clr $1111 (7) / clr <$E9 (6) / clr <$D9 (6) / jmp lD9CF (4)
  yield* rmw(m, 0x1111, clrF, 7);
  yield* rmw(m, 0x10e9, clrF, 6);
  yield* rmw(m, 0x10d9, clrF, 6);
  m.charge(4);
  return yield* call(mainAt(0xd9cf), m, {});
}

/**
 * $F8DA sub_F8DA: every 4th frame (frame_counter & 3 == 0) move the 16
 * shadow entries $0EA2-$0EC0 one code down ($0EA2 not $2F/$3E), up
 * ($0EA2 = $3E), or not at all ($0EA2 = $2F) -- decided by the first
 * entry alone; and give the seven entries $0ECE-$0EDA whose code is >=
 * $4F the blinking code dat_F91D[(frame_counter & $0F) >> 2]. Every one
 * of the seven is stored back, changed or not.
 * @see gaplus-main.asm $F8DA
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F8DA(m) {
  // $F8DA: lda <$16 (4) / anda #$03 (2) / lbne lF918 (6 taken, 5 not)
  const fc = yield* ld8(m, 0x1016, 4);
  m.charge(2);
  if ((fc & 0x03) !== 0) {
    m.charge(6);
    return yield* taskEnd(m);
  }
  m.charge(5);
  // $F8E2: ldb #$10 (2) / ldx #$0EA2 (3) / lda ,x (4) / cmpa #$2F (2) /
  // beq lF8FD (3) [/ cmpa #$3E (2) / beq lF8F8 (3)]
  m.charge(2); m.charge(3);
  const first = yield* ld8(m, 0x0ea2, 4);
  m.charge(2); m.charge(3);
  if (first !== 0x2f) {
    m.charge(2); m.charge(3);
    const up = first === 0x3e;
    // dec|inc ,x++ (9) / decb (2) / bne (3), 16 times
    for (let x = 0x0ea2; x < 0x0ec2; x += 2) {
      yield* rmw(m, x, up ? incF : decF, 9);
      m.charge(2); m.charge(3);
    }
    // $F8F6: bra lF8FD (3) after the DEC loop only
    if (!up) m.charge(3);
  }
  // lF8FD: ldb #$07 (2) / ldx #$0ECE (3)
  m.charge(2); m.charge(3);
  for (let x = 0x0ece; x < 0x0edc; x += 2) {
    // lF902: lda ,x++ (7) / cmpa #$4F (2) / bcs lF913 (3)
    let a = yield* ld8(m, x, 7);
    m.charge(2); m.charge(3);
    if (a >= 0x4f) {
      // lda <$16 (4) / anda #$0F (2) / lsra (2) / lsra (2) /
      // ldu #dat_F91D (3) / lda a,u (5, ROM)
      const f = yield* ld8(m, 0x1016, 4);
      m.charge(2); m.charge(2); m.charge(2); m.charge(3);
      a = mainRom(0xf91d + ((f & 0x0f) >> 2));
      m.charge(5);
    }
    // lF913: sta -$2,x (5) / decb (2) / bne (3)
    yield* st8(m, x, a, 5);
    m.charge(2); m.charge(3);
  }
  // lF918: inc <$30 / jmp task_dispatch
  return yield* taskEnd(m);
}

/**
 * `LDB $1001,r (8) / LDA $0801,r (8) / LSRB (2) / RORA (2)`: the 9-bit X
 * of a shadow entry at `e` (X low at $0801,e, bit 8 in b0 of $1001,e),
 * halved.
 * @param {Machine} m @param {number} e
 * @returns {Generator<unknown, number, unknown>}
 */
function* halfX(m, e) {
  const b = yield* ld8(m, e + 0x1001, 8);
  const a = yield* ld8(m, e + 0x0801, 8);
  m.charge(2); m.charge(2);
  return ((b & 0x01) << 7) | (a >> 1);
}

/**
 * $F921 sub_F921: `JMP lF9D5` -- the collision test between the six
 * objects at $0EC2-$0ECC and the seven at $0ECE-$0EDA (shots?), unless
 * $101A is set. The first hit (a box of +/-3 in X/2 and +/-6 in Y)
 * requests an effect there ($1108++, position $1109, flags $110B), frees
 * the $0ECE-side entry, plays sound $0B and removes the hit object from
 * its list by shifting the entries after it down one place (the last
 * one, $0ECC, is freed). At most one hit per frame.
 * @see gaplus-main.asm $F921
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* sub_F921(m) {
  // $F921: jmp lF9D5 (4); lF9D5: lda <$1A (4) / lbne lF9D0
  m.charge(4);
  if ((yield* ld8(m, 0x101a, 4)) !== 0) {
    m.charge(6);
    return yield* taskEnd(m);
  }
  m.charge(5);
  // $F9DB: ldu #$0EC0 (3)
  m.charge(3);
  for (let u = 0x0ec2; ; u += 2) {
    // lF9DE: leau $2,u (5) / cmpu #$0ECE (5) / lbeq lF9D0
    m.charge(5); m.charge(5);
    if (u === 0x0ece) {
      m.charge(6);
      return yield* taskEnd(m);
    }
    m.charge(5);
    // ldb $1001,u (8) / andb #$80 (2) / beq lF9DE (3)
    const fu = yield* ld8(m, u + 0x1001, 8);
    m.charge(2); m.charge(3);
    if ((fu & 0x80) === 0) continue;
    // $F9F0: X/2 +3 -> <$C9, -6 -> <$C8 (8-bit wrap); Y +6 -> <$C7,
    // -$0C -> <$C6 (adda/suba 2, sta direct 4, lda $0800,u 8)
    let a = add8(yield* halfX(m, u), 0x03).v;
    m.charge(2);
    yield* st8(m, 0x10c9, a, 4);
    a = sub8(a, 0x06).v;
    m.charge(2);
    yield* st8(m, 0x10c8, a, 4);
    a = add8(yield* ld8(m, u + 0x0800, 8), 0x06).v;
    m.charge(2);
    yield* st8(m, 0x10c7, a, 4);
    a = sub8(a, 0x0c).v;
    m.charge(2);
    yield* st8(m, 0x10c6, a, 4);
    // $FA0E: ldx #$0ECC (3)
    m.charge(3);
    for (let x = 0x0ece; ; x += 2) {
      // lFA11: leax $2,x (5) / cmpx #$0EDC (4) / lbeq lF9DE
      m.charge(5); m.charge(4);
      if (x === 0x0edc) {
        m.charge(6);
        break;
      }
      m.charge(5);
      // lda $1001,x (8) / anda #$80 (2) / beq lFA11 (3)
      const fx = yield* ld8(m, x + 0x1001, 8);
      m.charge(2); m.charge(3);
      if ((fx & 0x80) === 0) continue;
      // the X/2 box: cmpa <$C8 (4) / bcs (3) / cmpa <$C9 (4) / bcc (3)
      // -- unsigned: bcs = below, bcc = at or above
      const hx = yield* halfX(m, x);
      const lo = yield* ld8(m, 0x10c8, 4);
      m.charge(3);
      if (hx < lo) continue;
      const hi = yield* ld8(m, 0x10c9, 4);
      m.charge(3);
      if (hx >= hi) continue;
      // lda $0800,x (8) / cmpa <$C6 (4) / bcs (3) / cmpa <$C7 (4) / bcc
      const y = yield* ld8(m, x + 0x0800, 8);
      const ylo = yield* ld8(m, 0x10c6, 4);
      m.charge(3);
      if (y < ylo) continue;
      const yhi = yield* ld8(m, 0x10c7, 4);
      m.charge(3);
      if (y >= yhi) continue;
      // $FA40: inc $1108 (7) / ldd $0800,u (9) / std $1109 (6) /
      // lda $1001,u (8) / sta $110B (5) / clr $1001,x (10) /
      // lda #$01 (2) / sta $604B (5)
      yield* rmw(m, 0x1108, incF, 7);
      const pos = yield* ld16(m, u + 0x0800, 9);
      yield* st16(m, 0x1109, pos, 6);
      const fl = yield* ld8(m, u + 0x1001, 8);
      yield* st8(m, 0x110b, fl, 5);
      yield* rmw(m, x + 0x1001, clrF, 10);
      m.charge(2);
      yield* st8(m, 0x604b, 0x01, 5); // snd_request+11
      // lFA5A: cmpu #$0ECC (5) / beq lFA76 (3) -- shift the list down:
      // ldd $1002,u (9) / std $1000,u (9) / ldd $0802,u (9) /
      // std $0800,u (9) / ldd $2,u (6) / std ,u++ (8) / bra (3)
      let v = u;
      for (;;) {
        m.charge(5); m.charge(3);
        if (v === 0x0ecc) break;
        yield* st16(m, v + 0x1000, yield* ld16(m, v + 0x1002, 9), 9);
        yield* st16(m, v + 0x0800, yield* ld16(m, v + 0x0802, 9), 9);
        yield* st16(m, v, yield* ld16(m, v + 2, 6), 8);
        v += 2;
        m.charge(3);
      }
      // lFA76: clr $1001,u (10) / jmp lF9D0 (4)
      yield* rmw(m, v + 0x1001, clrF, 10);
      m.charge(4);
      return yield* taskEnd(m);
    }
  }
}

/** Routine name -> function, registered in MAIN by gp2_2b.js. */
export const ROUTINES = {
  task_spawn_effect, task_animate_effects,
  sub_F673, sub_F675, sub_F67B, sub_F67E, sub_F684, sub_F6BA, sub_F6C0,
  sub_F6C5, sub_F6DD, sub_F70C, sub_F76D, sub_F7DA, sub_F7EA, sub_F7FA,
  sub_F80E, sub_F819, sub_F824, sub_F8DA, sub_F921,
};

/** Address -> function, registered in MAIN_AT by gp2_2b.js. */
export const AT = {
  0xf5c4: task_spawn_effect, 0xf5fa: task_animate_effects,
  // effect_steps ($F62F)
  0xf673: sub_F673, 0xf675: sub_F675, 0xf67b: sub_F67B, 0xf67e: sub_F67E,
  0xf684: sub_F684, 0xf6ba: sub_F6BA, 0xf6c0: sub_F6C0, 0xf6c5: sub_F6C5,
  0xf6dd: sub_F6DD,
  // tbl_F6FC
  0xf70c: sub_F70C, 0xf76d: sub_F76D, 0xf7da: sub_F7DA, 0xf7ea: sub_F7EA,
  0xf7fa: sub_F7FA, 0xf80e: sub_F80E, 0xf819: sub_F819, 0xf824: sub_F824,
  0xf8da: sub_F8DA, 0xf921: sub_F921,
};

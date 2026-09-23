// Copyright 2026 by Moshix
/**
 * gp2-8.11d, sub CPU: the formation mover (task $B014 and its helpers
 * $B0D4, $B163, $B20D, $B242), the formation-attack counter $B385 and the
 * mode-0 task task_formation_init $BF58.
 *
 * The formation has 44 slots. formation_flags ($1860 + i) holds one flag
 * byte per slot: b0 occupied, b1 "moving" (the mover skips others), b4
 * "arrived", b5 "flying a path segment", b6 "done", b7 "sprite set up".
 * $B014 visits every moving slot once per frame; for each it points a set
 * of direct-page variables at that slot's data (the "slot pointers"
 * $1084-$10CB), then steps its path.
 *
 * Slot pointers set by $B031 for slot i (A = i, B = 2i):
 *   $1084 -> $0E30+2i  sprite code/colour     $10A0 -> $1630+2i  Y
 *   $10A2 -> $1631+2i  X                      $10A4 -> $1E30+2i  flags
 *   $10A6 -> $1E31+2i  flags (b0 = X bit 8)   $1088 -> $1920+2i  Y frac
 *   $108A -> $1921+2i  X frac                 $108C -> $1800+2i  path ptr
 *   $1090 -> $1890+i   step counter           $10AD -> $18C0+i   speed
 *   $10CB -> $18F0+i   last command byte      $1099 -> $19E0+i   speed 2
 *   $1092 -> $1980+i   heading                $108E -> $1B00+2i  target Y
 *   $1094 -> $1B01+2i  target X
 *
 * TIMING. Every routine is a generator that charges the 6809's cycles
 * (`c(n)`, the instructions quoted, MAME / oracle-core counts) and
 * yields SYNC right before each instruction that touches shared RAM
 * (gp2_8_util.js `timed`), so the scheduler places each access at its
 * cycle. A routine charges its own RTS (or its task's final
 * `jmp task_dispatch_sub`, 4); the caller charges the JSR / BSR.
 */

import { mul, add8, sub8, adc8, sbc8, disp8 } from '../m6809ops.js';
import {
  inc, dec, ldInd, stInd, ldInd16, stInd16, add16w, SYNC, syncAt,
  CWAI_CYCLES,
} from './gp2_8_util.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {Generator<unknown, void, unknown>} Thread */

/** formation_ptr ($1086): the slot being worked on, +1. */
const FORMATION_PTR = 0x1086;

/**
 * Formation mover task (mode 3/4/5/6/7 lists). Walks formation_flags
 * from formation_ptr; for every slot with b1 set it loads the slot
 * pointers, sets the sprite up the first time (b7), then either steps
 * the path ($B0D4, b5 clear) or homes in on the formation position
 * ($B242, b5 set and b4 clear). When the walk reaches $188D it rewinds
 * formation_ptr to $1860, sets $1096 = $FF and ends the task.
 * @see gaplus-sub.asm $B014
 * @param {Machine} m
 * @returns {Thread}
 */
export function* sub_B014(m) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  for (;;) {
    // $B014: ldx <formation_ptr (5)
    yield SYNC;
    let x = s.peek16(FORMATION_PTR);
    c(5);
    let a;
    for (;;) {
      // $B016: lda ,x+ (6) / inc <$96 (6) / anda #$02 / bne (2 + 3)
      yield* syncAt(x);
      a = s.peek(x);
      x = (x + 1) & 0xffff;
      c(6);
      yield SYNC;
      inc(s, 0x1096);
      c(6 + 2 + 3);
      if (a & 0x02) break;
      // cmpx #$188D / bne (4 + 3)
      c(4 + 3);
      if (x === 0x188d) {
        // $B023: ldx #$1860 (3) / stx <formation_ptr (5)
        c(3);
        yield SYNC;
        s.poke16(FORMATION_PTR, 0x1860);
        c(5);
        // lda #$FF (2) / sta <$96 (4)
        c(2);
        yield SYNC;
        s.poke(0x1096, 0xff);
        c(4);
        // inc <sub_task (6) / jmp task_dispatch_sub (4)
        yield SYNC;
        inc(s, 0x107a);
        c(6 + 4);
        return;
      }
    }
    // $B031: stx <formation_ptr (5) / lda <$96 (4) / ldb <$96 (4)
    yield SYNC;
    s.poke16(FORMATION_PTR, x);
    c(5);
    yield SYNC;
    const ia = s.peek(0x1096);
    c(4);
    yield SYNC;
    const ib = (s.peek(0x1096) << 1) & 0xff; // aslb: 8-bit
    c(4);
    // The `leax a,x` / `leax b,x` offsets are signed (disp8).
    // aslb (2) / ldx #$0E30 (3) / leax b,x (5) / stx <$84 (5)
    let p = disp8(0x0e30, ib);
    c(2 + 3 + 5);
    yield SYNC;
    s.poke16(0x1084, p);
    c(5);
    // leax $0800,x (8) / stx <$A0 (5)
    p = add16w(p, 0x0800);
    c(8);
    yield SYNC;
    s.poke16(0x10a0, p);
    c(5);
    // leax 1,x (5) / stx <$A2 (5)
    p = add16w(p, 1);
    c(5);
    yield SYNC;
    s.poke16(0x10a2, p);
    c(5);
    // leax $07FF,x (8) / stx <$A4 (5)
    p = add16w(p, 0x07ff);
    c(8);
    yield SYNC;
    s.poke16(0x10a4, p);
    c(5);
    // leax 1,x (5) / stx <$A6 (5)
    p = add16w(p, 1);
    c(5);
    yield SYNC;
    s.poke16(0x10a6, p);
    c(5);
    // ldx #$1920 / leax b,x (3 + 5) / stx <$88 (5)
    p = disp8(0x1920, ib);
    c(3 + 5);
    yield SYNC;
    s.poke16(0x1088, p);
    c(5);
    // leax 1,x (5) / stx <$8A (5)
    c(5);
    yield SYNC;
    s.poke16(0x108a, add16w(p, 1));
    c(5);
    // Then the same `ldx #n / leax r,x (3 + 5) / stx <v (5)` for each:
    /** @type {Array<[number, number, number]>} [dp var, base, index] */
    const rest = [[0x108c, 0x1800, ib], [0x1090, 0x1890, ia],
      [0x10ad, 0x18c0, ia], [0x10cb, 0x18f0, ia], [0x1099, 0x19e0, ia],
      [0x1092, 0x1980, ia], [0x108e, 0x1b00, ib]];
    for (const [v, base, i] of rest) {
      c(3 + 5);
      yield SYNC;
      s.poke16(v, disp8(base, i));
      c(5);
    }
    // leax 1,x (5) / stx <$94 (5)
    c(5);
    yield SYNC;
    s.poke16(0x1094, add16w(disp8(0x1b00, ib), 1));
    c(5);
    // $B093: ldx <formation_ptr (5) / lda -1,x (5) / anda #$80 / bne
    yield SYNC;
    x = s.peek16(FORMATION_PTR);
    c(5);
    let f = (x - 1) & 0xffff;
    yield* syncAt(f);
    a = s.peek(f);
    c(5 + 2 + 3);
    if ((a & 0x80) === 0) {
      // First visit: lda -1,x (5) / adda #$80 (2) / sta -1,x (5)
      yield* syncAt(f);
      a = (s.peek(f) + 0x80) & 0xff;
      c(5 + 2);
      yield* syncAt(f);
      s.poke(f, a);
      c(5);
      // ldx #$1B00 (3) / ldx b,x (6) / stx [$10A0] (10)
      c(3);
      const t = disp8(0x1b00, ib);
      yield* syncAt(t, t + 1);
      const tx = s.peek16(t);
      c(6);
      yield SYNC;
      stInd16(s, 0x10a0, tx);
      c(10);
      // lda #$80 (2) / sta [$10A6] (9)
      c(2);
      yield SYNC;
      stInd(s, 0x10a6, 0x80);
      c(9);
    }
    // $B0B0: ldx <formation_ptr (5) / lda -1,x (5) / anda #$40 (2)
    yield SYNC;
    x = s.peek16(FORMATION_PTR);
    c(5);
    f = (x - 1) & 0xffff;
    yield* syncAt(f);
    a = s.peek(f);
    c(5 + 2);
    // lbne sub_B014 (6 taken, 5 not)
    if (a & 0x40) { c(6); continue; }
    c(5);
    // lda -1,x (5) / anda #$20 (2) / bne (3)
    yield* syncAt(f);
    a = s.peek(f);
    c(5 + 2 + 3);
    if ((a & 0x20) === 0) {
      // jsr sub_B0D4 (8) / jmp sub_B014 (4)
      c(8);
      yield* sub_B0D4(m);
      c(4);
      continue;
    }
    // $B0C6: lda -1,x (5) / anda #$10 (2) / lbne sub_B014 (6 / 5)
    yield* syncAt(f);
    a = s.peek(f);
    c(5 + 2);
    if (a & 0x10) { c(6); continue; }
    c(5);
    // jsr sub_B242 (8) / jmp sub_B014 (4)
    c(8);
    yield* sub_B242(m);
    c(4);
  }
}

/**
 * Step one slot along its path. The step counter [$1090] counts down by
 * the speed [$10AD]; while it lasts the sprite moves ($B163 / $B20D).
 * When it runs out the remaining part of the step is moved, the counter
 * reloads with $28 and the path pointer [$108C] advances to the next
 * command byte: $F0 ends the path (slot flag := 1, and for the slot at
 * $188A the next flag too), $FF / $FE (the latter also clears the sprite
 * X and its bit 8) load a new heading and jump to a new path address,
 * anything else is a heading the loop takes again at once
 * (`jmp sub_B0D4`).
 * @see gaplus-sub.asm $B0D4
 * @param {Machine} m
 * @returns {Thread}
 */
export function* sub_B0D4(m) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  for (;;) {
    // $B0D4: lda [$1090] (9) / cmpa [$10AD] (9) / bcs (3)
    yield SYNC;
    let a = ldInd(s, 0x1090);
    c(9);
    yield SYNC;
    const cs = a < ldInd(s, 0x10ad);
    c(9 + 3);
    if (!cs) {
      // suba [$10AD] (9) / sta [$1090] (9)
      yield SYNC;
      a = (a - ldInd(s, 0x10ad)) & 0xff;
      c(9);
      yield SYNC;
      stInd(s, 0x1090, a);
      c(9);
      // lda [$10AD] (9) / sta <$98 (4)
      yield SYNC;
      a = ldInd(s, 0x10ad);
      c(9);
      yield SYNC;
      s.poke(0x1098, a);
      c(4);
      // lda [$1099] (9) / sta [$10AD] (9)
      yield SYNC;
      a = ldInd(s, 0x1099);
      c(9);
      yield SYNC;
      stInd(s, 0x10ad, a);
      c(9);
      // jsr sub_B163 (8) / jsr sub_B20D (8) / rts (5)
      c(8);
      const x = (yield* sub_B163(m)).x;
      c(8);
      yield* sub_B20D(m, { x });
      c(5);
      return;
    }
    // $B0FB: lda [$10AD] (9) / suba [$1090] (9) / sta [$10AD] (9)
    yield SYNC;
    a = ldInd(s, 0x10ad);
    c(9);
    yield SYNC;
    a = (a - ldInd(s, 0x1090)) & 0xff;
    c(9);
    yield SYNC;
    stInd(s, 0x10ad, a);
    c(9);
    // lda [$1090] (9) / beq (3)
    yield SYNC;
    a = ldInd(s, 0x1090);
    c(9 + 3);
    if (a !== 0) {
      // sta <$98 (4) / bsr sub_B163 (7)
      yield SYNC;
      s.poke(0x1098, a);
      c(4 + 7);
      yield* sub_B163(m);
    }
    // $B111: lda #$28 (2) / sta [$1090] (9)
    c(2);
    yield SYNC;
    stInd(s, 0x1090, 0x28);
    c(9);
    // ldx [$108C] (10) / leax 1,x (5) / stx [$108C] (10)
    yield SYNC;
    let x = add16w(ldInd16(s, 0x108c), 1);
    c(10 + 5);
    yield SYNC;
    stInd16(s, 0x108c, x);
    c(10);
    // lda ,x (4) / cmpa #$F0 / beq (2 + 3)
    yield* syncAt(x);
    a = s.peek(x);
    c(4 + 2 + 3);
    if (a === 0xf0) {
      // $B155: lda #1 (2) / ldx <formation_ptr (5) / cmpx #$188B /
      // bne (4 + 3) / [sta ,x (4)] / sta -1,x (5) / rts (5)
      c(2);
      yield SYNC;
      const fp = s.peek16(FORMATION_PTR);
      c(5 + 4 + 3);
      if (fp === 0x188b) {
        yield* syncAt(fp);
        s.poke(fp, 1);
        c(4);
      }
      yield* syncAt(fp - 1);
      s.poke((fp - 1) & 0xffff, 1);
      c(5 + 5);
      return;
    }
    // adda #1 / beq (2 + 3): $FF; adda #1 / bne (2 + 3): not $FE
    c(2 + 3);
    if (a !== 0xff) {
      c(2 + 3);
      if (a !== 0xfe) {
        c(4); // $B152: jmp sub_B0D4
        continue;
      }
      // $B12F: lda [$10A6] (9) / anda #$FE (2) / sta [$10A6] (9) /
      // clr [$10A2] (11)
      yield SYNC;
      a = ldInd(s, 0x10a6) & 0xfe;
      c(9 + 2);
      yield SYNC;
      stInd(s, 0x10a6, a);
      c(9);
      yield SYNC;
      ldInd(s, 0x10a2); // clr reads first
      stInd(s, 0x10a2, 0);
      c(11);
    }
    // $B13D: lda -1,x (5) / sta [$1092] (9)
    yield* syncAt(x - 1);
    a = s.peek((x - 1) & 0xffff);
    c(5);
    yield SYNC;
    stInd(s, 0x1092, a);
    c(9);
    // ldx 1,x (6) / stx [$108C] (10)
    yield* syncAt(x + 1, x + 2);
    x = s.peek16((x + 1) & 0xffff);
    c(6);
    yield SYNC;
    stInd16(s, 0x108c, x);
    c(10);
    // ldx <formation_ptr (5) / lda -1,x (5) / ora #$20 (2) /
    // sta -1,x (5) / rts (5)
    yield SYNC;
    const f = (s.peek16(FORMATION_PTR) - 1) & 0xffff;
    c(5);
    yield* syncAt(f);
    a = s.peek(f) | 0x20;
    c(5 + 2);
    yield* syncAt(f);
    s.poke(f, a);
    c(5 + 5);
    return;
  }
}

/**
 * Move one slot's sprite by <$98 units along a heading. The heading is
 * [$1092] while the slot flies free (b5 set), else the byte at the path
 * pointer. dat_AAFF + 4 * heading gives (dy, dx) and direction bits;
 * <$98 is first turned into ceil(n / 8) (at least 1), then each of dy,
 * dx is multiplied by it into 16-bit fractions ($109C:$109E,
 * $109D:$109F) that are added to or subtracted from the position with
 * carries (the X carry toggles the X bit 8 in [$10A6]).
 * @see gaplus-sub.asm $B163
 * @param {Machine} m
 * @returns {Generator<unknown, { x: number }, unknown>} X = the dat_AAFF
 *   entry (for $B20D)
 */
export function* sub_B163(m) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // $B163: lda [$1092] (9) / ldx <formation_ptr (5) / ldb -1,x (5) /
  // andb #$20 / bne (2 + 3)
  yield SYNC;
  let a = ldInd(s, 0x1092);
  c(9);
  yield SYNC;
  const fp = s.peek16(FORMATION_PTR);
  c(5);
  yield* syncAt(fp - 1);
  const free = (s.peek((fp - 1) & 0xffff) & 0x20) !== 0;
  c(5 + 2 + 3);
  if (!free) {
    // ldx [$108C] (10) / lda ,x (4)
    yield SYNC;
    const p = ldInd16(s, 0x108c);
    c(10);
    yield* syncAt(p);
    a = s.peek(p);
    c(4);
  }
  // $B175: ldb #4 (2) / mul (11) / ldx #dat_AAFF (3) / leax d,x (8)
  const x = (0xaaff + a * 4) & 0xffff;
  c(2 + 11 + 3 + 8);
  // ldd 1,x (6) / std <$9E (5)
  yield* syncAt(x + 1, x + 2);
  const dd = s.peek16((x + 1) & 0xffff);
  c(6);
  yield SYNC;
  s.poke16(0x109e, dd);
  c(5);
  // lda <$98 (4) / clrb (2)
  yield SYNC;
  a = s.peek(0x1098);
  c(4 + 2);
  // $B184: incb / suba #8 / bcs / bne (2 + 2 + 3 + 3): B = ceil(A / 8),
  // at least 1
  let b = 0;
  for (;;) {
    b = (b + 1) & 0xff;
    const r = sub8(a, 8);
    a = r.v;
    c(2 + 2 + 3);
    if (r.cf) break;
    c(3);
    if (a === 0) break;
  }
  // stb <$98 (4) / lda <$9E (4) / mul (11) / sta <$9C (4) / stb <$9E (4)
  yield SYNC;
  s.poke(0x1098, b);
  c(4);
  yield SYNC;
  let p = mul(s.peek(0x109e), b);
  c(4 + 11);
  yield SYNC;
  s.poke(0x109c, p.a);
  c(4);
  yield SYNC;
  s.poke(0x109e, p.b);
  c(4);
  // ldb <$98 (4) / lda <$9F (4) / mul (11) / sta <$9D (4) / stb <$9F (4)
  yield SYNC;
  b = s.peek(0x1098);
  c(4);
  yield SYNC;
  p = mul(s.peek(0x109f), b);
  c(4 + 11);
  yield SYNC;
  s.poke(0x109d, p.a);
  c(4);
  yield SYNC;
  s.poke(0x109f, p.b);
  c(4);
  // $B19D: lda ,x (4) / anda #$80 / bne (2 + 3)
  yield* syncAt(x);
  const up = (s.peek(x) & 0x80) !== 0;
  c(4 + 2 + 3);
  // ldd [$1088] (10): B = the byte after the Y fraction (the X fraction),
  // which the X part below uses.
  yield SYNC;
  const d = ldInd16(s, 0x1088);
  c(10);
  b = d & 0xff;
  if (!up) {
    // adda <$9E (4) / sta [$1088] (9) / lda [$10A0] (9) / adca <$9C (4) /
    // sta [$10A0] (9) / bra (3)
    yield SYNC;
    const r = add8(d >> 8, s.peek(0x109e));
    c(4);
    yield SYNC;
    stInd(s, 0x1088, r.v);
    c(9);
    yield SYNC;
    const y = ldInd(s, 0x10a0);
    c(9);
    yield SYNC;
    const r2 = adc8(y, s.peek(0x109c), r.cc); // carry from the adda
    c(4);
    yield SYNC;
    stInd(s, 0x10a0, r2.v);
    c(9 + 3);
  } else {
    // $B1B9: the same with suba / sbca (no bra)
    yield SYNC;
    const r = sub8(d >> 8, s.peek(0x109e));
    c(4);
    yield SYNC;
    stInd(s, 0x1088, r.v);
    c(9);
    yield SYNC;
    const y = ldInd(s, 0x10a0);
    c(9);
    yield SYNC;
    const r2 = sbc8(y, s.peek(0x109c), r.cc);
    c(4);
    yield SYNC;
    stInd(s, 0x10a0, r2.v);
    c(9);
  }
  // $B1CD: lda ,x (4) / anda #$08 / bne (2 + 3)
  yield* syncAt(x);
  const left = (s.peek(x) & 0x08) !== 0;
  c(4 + 2 + 3);
  // addb / subb <$9F (4) / stb [$108A] (9) / ldb [$10A2] (9) /
  // adcb / sbcb <$9D (4) / stb [$10A2] (9) / bcc (3)
  yield SYNC;
  const r = left ? sub8(b, s.peek(0x109f)) : add8(b, s.peek(0x109f));
  c(4);
  yield SYNC;
  stInd(s, 0x108a, r.v);
  c(9);
  yield SYNC;
  const xx = ldInd(s, 0x10a2);
  c(9);
  yield SYNC;
  const r2 = left ? sbc8(xx, s.peek(0x109d), r.cc)
    : adc8(xx, s.peek(0x109d), r.cc);
  c(4);
  yield SYNC;
  stInd(s, 0x10a2, r2.v);
  c(9 + 3);
  if (r2.cf) {
    // ldb [$10A6] (9) / orb #1 or andb #$FE (2) / stb [$10A6] (9): the X
    // bit 8
    yield SYNC;
    const v = ldInd(s, 0x10a6);
    c(9 + 2);
    yield SYNC;
    stInd(s, 0x10a6, left ? v & 0xfe : v | 0x01);
    c(9);
  }
  c(5); // rts
  return { x };
}

/**
 * Set the slot's sprite picture from byte 3 of the heading entry X: the
 * low nibble into the low nibble of the code [$1084], the whole byte to
 * [$10CB], bits 4-5 as the flip bits of [$10A4] (its bit 6 kept).
 * @see gaplus-sub.asm $B20D
 * @param {Machine} m
 * @param {{ x: number }} regs X = dat_AAFF entry from $B163
 * @returns {Thread}
 */
export function* sub_B20D(m, { x }) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  const x3 = (x + 3) & 0xffff;
  // lda [$1084] (9) / anda #$F0 (2) / sta [$1084] (9)
  yield SYNC;
  let a = ldInd(s, 0x1084) & 0xf0;
  c(9 + 2);
  yield SYNC;
  stInd(s, 0x1084, a);
  c(9);
  // lda 3,x (5) / sta [$10CB] (9)
  yield* syncAt(x3);
  a = s.peek(x3);
  c(5);
  yield SYNC;
  stInd(s, 0x10cb, a);
  c(9);
  // anda #$0F (2) / ora [$1084] (9) / sta [$1084] (9)
  c(2);
  yield SYNC;
  a = (a & 0x0f) | ldInd(s, 0x1084);
  c(9);
  yield SYNC;
  stInd(s, 0x1084, a);
  c(9);
  // ldb [$10A4] (9) / andb #$40 (2)
  yield SYNC;
  let b = ldInd(s, 0x10a4) & 0x40;
  c(9 + 2);
  // lda 3,x (5) / anda #$30 (2) / lsra x 4 (8) / sta [$10A4] (9)
  yield* syncAt(x3);
  a = (s.peek(x3) & 0x30) >> 4;
  c(5 + 2 + 8);
  yield SYNC;
  stInd(s, 0x10a4, a);
  c(9);
  // orb [$10A4] (9) / stb [$10A4] (9) / rts (5)
  yield SYNC;
  b |= ldInd(s, 0x10a4);
  c(9);
  yield SYNC;
  stInd(s, 0x10a4, b);
  c(9 + 5);
}

/**
 * Home a slot on its formation position [$108E]/[$1094]. Within 4 units
 * on both axes it arrives: position := target and flag b4, unless
 * $112A is 0 and $10F8 non-zero, in which case the slot is sent off
 * again (b5 cleared, $084D := 1, a per-slot counter at slot+$39F
 * counts; every fourth time, while $1021 is 0 and $1020 is set, its
 * path becomes $DD44 once). Otherwise the heading [$1092] turns towards
 * the target: the octant's table (dat_A9D6 / A96A / AA39 / AA9C) gives
 * the wanted heading from the halved distances, and the heading moves
 * to it at once when within <$A8 (speed / 4), else by <$A9 (speed / 8);
 * then the sprite moves ($B163, $B20D).
 * @see gaplus-sub.asm $B242
 * @param {Machine} m
 * @returns {Thread}
 */
export function* sub_B242(m) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // $B242: ldd [$108E] (10) / suba #4 (2) / cmpa [$10A0] (9) / bcc (3)
  yield SYNC;
  const t = ldInd16(s, 0x108e);
  c(10 + 2);
  let a = ((t >> 8) - 4) & 0xff;
  let b = t & 0xff;
  let near = false;
  yield SYNC;
  let far = a >= ldInd(s, 0x10a0);
  c(9 + 3);
  if (!far) {
    // adda #8 (2) / cmpa [$10A0] (9) / bcs (3)
    a = (a + 8) & 0xff;
    c(2);
    yield SYNC;
    far = a < ldInd(s, 0x10a0);
    c(9 + 3);
  }
  if (!far) {
    // subb #4 (2) / cmpb [$10A2] (9) / bcc (3)
    b = (b - 4) & 0xff;
    c(2);
    yield SYNC;
    far = b >= ldInd(s, 0x10a2);
    c(9 + 3);
  }
  if (!far) {
    // addb #8 (2) / cmpb [$10A2] (9) / bcs (3)
    b = (b + 8) & 0xff;
    c(2);
    yield SYNC;
    near = b >= ldInd(s, 0x10a2);
    c(9 + 3);
  }
  if (near) {
    // lda $112A (5) / bne (3) / lda <$F8 (4) / bne (3)
    yield SYNC;
    let arrive = s.peek(0x112a) !== 0;
    c(5 + 3);
    if (!arrive) {
      yield SYNC;
      arrive = s.peek(0x10f8) === 0;
      c(4 + 3);
    }
    if (arrive) {
      // $B26F: ldd [$108E] (10) / std [$10A0] (10) / lda #$10 (2) /
      // ldx <formation_ptr (5) / ora -1,x (5) / sta -1,x (5) / rts (5)
      yield SYNC;
      const d = ldInd16(s, 0x108e);
      c(10);
      yield SYNC;
      stInd16(s, 0x10a0, d);
      c(10 + 2);
      yield SYNC;
      const f = (s.peek16(FORMATION_PTR) - 1) & 0xffff;
      c(5);
      yield* syncAt(f);
      a = 0x10 | s.peek(f);
      c(5);
      yield* syncAt(f);
      s.poke(f, a);
      c(5 + 5);
      return;
    }
    // $B280: ldx <formation_ptr (5) / lda -1,x (5) / anda #$DF (2) /
    // sta -1,x (5)
    yield SYNC;
    const fp = s.peek16(FORMATION_PTR);
    c(5);
    const f = (fp - 1) & 0xffff;
    yield* syncAt(f);
    a = s.peek(f) & 0xdf;
    c(5 + 2);
    yield* syncAt(f);
    s.poke(f, a);
    c(5);
    // lda #1 (2) / sta $084D (5)
    c(2);
    yield SYNC;
    s.poke(0x084d, 1);
    c(5);
    // inc $039F,x (10) / lda $039F,x (8) / anda #3 / beq (2 + 3)
    const k = (fp + 0x039f) & 0xffff;
    yield* syncAt(k);
    inc(s, k);
    c(10);
    yield* syncAt(k);
    a = s.peek(k) & 0x03;
    c(8 + 2 + 3);
    if (a !== 0) {
      // lda <$11 (4) / sta [$1099] (9) / rts (5)
      yield SYNC;
      a = s.peek(0x1011);
      c(4);
      yield SYNC;
      stInd(s, 0x1099, a);
      c(9 + 5);
      return;
    }
    // $B2A0: lda <$21 (4) / bne (3) / lda <$20 (4) / beq (3)
    yield SYNC;
    let go = s.peek(0x1021) === 0;
    c(4 + 3);
    if (go) {
      yield SYNC;
      go = s.peek(0x1020) !== 0;
      c(4 + 3);
    }
    if (go) {
      // ldd #$DD44 (3) / std [$108C] (10) / sta <$21 (4) (A = $DD)
      c(3);
      yield SYNC;
      stInd16(s, 0x108c, 0xdd44);
      c(10);
      yield SYNC;
      s.poke(0x1021, 0xdd);
      c(4);
    }
    // $B2B1: lda #$40 (2) / sta [$1099] (9) / rts (5)
    c(2);
    yield SYNC;
    stInd(s, 0x1099, 0x40);
    c(9 + 5);
    return;
  }
  // $B2B8: lda [$1099] (9) / sta [$10AD] (9) / lsra / lsra (4) /
  // sta <$A8 (4) / lsra (2) / sta <$A9 (4)
  yield SYNC;
  a = ldInd(s, 0x1099);
  c(9);
  yield SYNC;
  stInd(s, 0x10ad, a);
  c(9 + 4);
  a >>= 2;
  yield SYNC;
  s.poke(0x10a8, a);
  c(4 + 2);
  a >>= 1;
  yield SYNC;
  s.poke(0x10a9, a);
  c(4);
  // ldd [$10A0] (10) / cmpa [$108E] (9) / bcs (3)
  yield SYNC;
  let d = ldInd16(s, 0x10a0);
  c(10);
  yield SYNC;
  const below = (d >> 8) < ldInd(s, 0x108e);
  c(9 + 3);
  let tbl;
  // cmpb [$1094] (9) / bcs (3)
  yield SYNC;
  const leftOf = (d & 0xff) < ldInd(s, 0x1094);
  c(9 + 3);
  if (!below && !leftOf) {
    // ldd [$10A0] (10) / subd [$108E] (11) / ldx #dat_A9D6 (3) / bra (3)
    yield SYNC;
    d = ldInd16(s, 0x10a0);
    c(10);
    yield SYNC;
    d = (d - ldInd16(s, 0x108e)) & 0xffff;
    c(11 + 3 + 3);
    tbl = 0xa9d6;
  } else if (!below) {
    // $B2FF: lda [$10A0] (9) / suba [$108E] (9) / ldb [$108E] (9) /
    // subb [$10A2] (9) / ldx #dat_AA39 (3) / bra (3)
    yield SYNC;
    a = ldInd(s, 0x10a0);
    c(9);
    yield SYNC;
    a = (a - ldInd(s, 0x108e)) & 0xff;
    c(9);
    yield SYNC;
    b = ldInd(s, 0x108e);
    c(9);
    yield SYNC;
    b = (b - ldInd(s, 0x10a2)) & 0xff;
    c(9 + 3 + 3);
    d = (a << 8) | b;
    tbl = 0xaa39;
  } else if (!leftOf) {
    // $B2EA: lda [$108E] / suba [$10A0] / ldb [$10A2] / subb [$1094]
    // (9 each) / ldx #dat_A96A (3) / bra (3)
    yield SYNC;
    a = ldInd(s, 0x108e);
    c(9);
    yield SYNC;
    a = (a - ldInd(s, 0x10a0)) & 0xff;
    c(9);
    yield SYNC;
    b = ldInd(s, 0x10a2);
    c(9);
    yield SYNC;
    b = (b - ldInd(s, 0x1094)) & 0xff;
    c(9 + 3 + 3);
    d = (a << 8) | b;
    tbl = 0xa96a;
  } else {
    // $B314: ldd [$108E] (10) / subd [$10A0] (11) / ldx #dat_AA9C (3)
    yield SYNC;
    d = ldInd16(s, 0x108e);
    c(10);
    yield SYNC;
    d = (d - ldInd16(s, 0x10a0)) & 0xffff;
    c(11 + 3);
    tbl = 0xaa9c;
  }
  // $B31F: lsra / anda #$FE / lsrb / andb #$FE (8); cmpa #$10 / bcs (5)
  // [lda #$10 (2)]; cmpb #$10 / bcs (5) [ldb #$10 (2)]; lsrb (2)
  a = ((d >> 8) >> 1) & 0xfe;
  b = ((d & 0xff) >> 1) & 0xfe;
  c(8 + 5);
  if (a >= 0x10) { a = 0x10; c(2); }
  c(5);
  if (b >= 0x10) { b = 0x10; c(2); }
  b >>= 1;
  c(2);
  // ldx a,x (6) / lda b,x (5) / sta <$AA (4) -- A indexes words (row),
  // B bytes (column); both offsets signed
  const ra = disp8(tbl, a);
  yield* syncAt(ra, ra + 1);
  const row = s.peek16(ra);
  c(6);
  const rb = disp8(row, b);
  yield* syncAt(rb);
  a = s.peek(rb);
  c(5);
  yield SYNC;
  s.poke(0x10aa, a);
  c(4);
  // cmpa [$1092] (9) / bcs (3)
  yield SYNC;
  const lower = a < ldInd(s, 0x1092);
  c(9 + 3);
  if (!lower) {
    // $B33E: lda <$AA (4) / suba [$1092] (9) / cmpa <$A8 (4) / bcc (3)
    yield SYNC;
    a = s.peek(0x10aa);
    c(4);
    yield SYNC;
    a = (a - ldInd(s, 0x1092)) & 0xff;
    c(9);
    yield SYNC;
    const big = a >= s.peek(0x10a8);
    c(4 + 3);
    if (!big) {
      // lda <$AA (4) / sta [$1092] (9) / bra (3)
      yield SYNC;
      a = s.peek(0x10aa);
      c(4);
      yield SYNC;
      stInd(s, 0x1092, a);
      c(9 + 3);
    } else {
      // $B350: lda [$1092] (9) / adda <$A9 (4) / sta [$1092] (9) /
      // bra (3)
      yield SYNC;
      a = ldInd(s, 0x1092);
      c(9);
      yield SYNC;
      a = (a + s.peek(0x10a9)) & 0xff;
      c(4);
      yield SYNC;
      stInd(s, 0x1092, a);
      c(9 + 3);
    }
  } else {
    // $B35C: lda [$1092] (9) / suba <$AA (4) / cmpa <$A8 (4) / bcc (3)
    yield SYNC;
    a = ldInd(s, 0x1092);
    c(9);
    yield SYNC;
    a = (a - s.peek(0x10aa)) & 0xff;
    c(4);
    yield SYNC;
    const big = a >= s.peek(0x10a8);
    c(4 + 3);
    if (!big) {
      // lda <$AA (4) / sta [$1092] (9) / bra (3)
      yield SYNC;
      a = s.peek(0x10aa);
      c(4);
      yield SYNC;
      stInd(s, 0x1092, a);
      c(9 + 3);
    } else {
      // $B36E: lda [$1092] (9) / suba <$A9 (4) / sta [$1092] (9)
      yield SYNC;
      a = ldInd(s, 0x1092);
      c(9);
      yield SYNC;
      a = (a - s.peek(0x10a9)) & 0xff;
      c(4);
      yield SYNC;
      stInd(s, 0x1092, a);
      c(9);
    }
  }
  // $B378: lda [$10AD] (9) / sta <$98 (4) / jsr sub_B163 (8) /
  // jsr sub_B20D (8) / rts (5)
  yield SYNC;
  a = ldInd(s, 0x10ad);
  c(9);
  yield SYNC;
  s.poke(0x1098, a);
  c(4 + 8);
  const x = (yield* sub_B163(m)).x;
  c(8);
  yield* sub_B20D(m, { x });
  c(5);
}

/**
 * Formation attack timer (mode 5 task). Unless $10D6 is set (then
 * $112A := 0): every 64th frame of $1128, $1129 counts up (held at
 * $1F); its range 0-7 / 8-$17 / $18-$1F / $20 picks a count from
 * $1036-$1039, and if at least that many slots have b1 (moving) set,
 * $112A := $55 (formation attack allowed), else $112A := 0.
 * @see gaplus-sub.asm $B385
 * @param {Machine} m
 * @returns {Thread}
 */
export function* sub_B385(m) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // $B385: lda <$D6 (4) / bne (3)
  yield SYNC;
  let busy = s.peek(0x10d6) !== 0;
  c(4 + 3);
  let allow = false;
  if (!busy) {
    // inc $1128 (7) / lda $1128 (5) / anda #$3F / bne (2 + 3)
    yield SYNC;
    inc(s, 0x1128);
    c(7);
    yield SYNC;
    const t = s.peek(0x1128) & 0x3f;
    c(5 + 2 + 3);
    if (t !== 0) {
      yield* endTask(m);
      return;
    }
    // clrb (2) / inc $1129 (7) / lda $1129 (5)
    let b = 0;
    c(2);
    yield SYNC;
    inc(s, 0x1129);
    c(7);
    yield SYNC;
    const a = s.peek(0x1129);
    c(5);
    // cmpa #$08 / bcs (5) [incb (2) / cmpa #$18 / bcs (5) [incb /
    // cmpa #$20 / bcs [incb / dec $1129 (7)]]]
    c(5);
    if (a >= 0x08) {
      b += 1;
      c(2 + 5);
      if (a >= 0x18) {
        b += 1;
        c(2 + 5);
        if (a >= 0x20) {
          b += 1;
          c(2);
          yield SYNC;
          dec(s, 0x1129);
          c(7);
        }
      }
    }
    // $B3AC: ldx #$1036 (3) / ldb b,x (5) / ldx #$1860 (3)
    c(3);
    yield SYNC;
    b = s.peek(0x1036 + b);
    c(5 + 3);
    // $B3B4: lda ,x+ (6) / cmpx #$188C / beq (4 + 3) / anda #2 / beq
    // (2 + 3) / decb / bne (2 + 3); B counts down (8-bit, 0 = 256)
    let x = 0x1860;
    for (;;) {
      yield* syncAt(x);
      const f = s.peek(x);
      x = (x + 1) & 0xffff;
      c(6 + 4 + 3);
      if (x === 0x188c) { busy = true; break; }
      c(2 + 3);
      if ((f & 0x02) === 0) continue;
      b = (b - 1) & 0xff;
      c(2 + 3);
      if (b !== 0) continue;
      allow = true;
      break;
    }
  }
  if (allow) {
    // lda #$55 (2) / sta $112A (5) / bra (3)
    c(2);
    yield SYNC;
    s.poke(0x112a, 0x55);
    c(5 + 3);
  } else {
    // $B3C9: clr $112A (7)
    yield SYNC;
    s.poke(0x112a, 0);
    c(7);
  }
  yield* endTask(m);
}

/**
 * `inc <sub_task (6) / jmp task_dispatch_sub (4)`, the end of a task.
 * @param {Machine} m
 * @returns {Thread}
 */
export function* endTask(m) {
  yield SYNC;
  inc(m.sub, 0x107a);
  m.sub.charge(6); m.sub.charge(4);
}

/**
 * Mode 0 task: mark the 44 formation slots occupied (1), path table
 * pointer $1082 := $ADCF, clear sprite $0E88, park $1688, reset the
 * object timers ($10AC, $1122, $111A, $1018; $111B := 1), then wait for
 * the next frame (`cwai`) and restart the task list (sub_task := 0).
 * @see gaplus-sub.asm $BF58
 * @param {Machine} m
 * @returns {Thread}
 */
export function* task_formation_init(m) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // ldx #$1860 / lda #1 / ldb #$2C (3 + 2 + 2); 44 x (sta ,x+ (6) /
  // decb / bne (2 + 3))
  c(3 + 2 + 2);
  for (let i = 0; i < 0x2c; i += 1) {
    yield SYNC;
    s.poke(0x1860 + i, 1);
    c(6 + 2 + 3);
  }
  // ldd #$ADCF (3) / std <$82 (5)
  c(3);
  yield SYNC;
  s.poke16(0x1082, 0xadcf);
  c(5);
  // clr $0E88 / clr $0E89 (7 each)
  for (const a of [0x0e88, 0x0e89]) {
    yield SYNC;
    s.poke(a, 0);
    c(7);
  }
  // ldd #$28A8 (3) / std $1688 (6)
  c(3);
  yield SYNC;
  s.poke16(0x1688, 0x28a8);
  c(6);
  // clr <$AC (6) / clr $1122 (7) / clr $111A (7) / clr <$18 (6)
  for (const [a, n] of [[0x10ac, 6], [0x1122, 7], [0x111a, 7],
    [0x1018, 6]]) {
    yield SYNC;
    s.poke(a, 0);
    c(n);
  }
  // lda #1 (2) / sta $111B (5)
  c(2);
  yield SYNC;
  s.poke(0x111b, 1);
  c(5);
  // $BF84: cwai #$EF -- wait for vblank
  c(CWAI_CYCLES);
  yield;
  // clr <sub_task (6) / jmp task_dispatch_sub (4)
  yield SYNC;
  s.poke(0x107a, 0);
  c(6 + 4);
}

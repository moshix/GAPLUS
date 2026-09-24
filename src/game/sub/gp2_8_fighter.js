// Copyright 2026 by Moshix
/**
 * gp2-8.11d, sub CPU: the power-up / capture effects around the player's
 * ship (mode 5 task $B3D1 and the handlers of its table tbl_B3E6).
 *
 * $10CF is the effect-active flag and $1070 the effect number; $B3D1
 * runs handler $1070 of tbl_B3E6: 0 = $B5A1 (the six sprites of $0E92
 * rising from the ship), 1 = $B3F2 (a timed sequence driven by $10D0),
 * 2-5 = $B860 (one-shot setups: shot speed, the $19E0 table, ...).
 *
 * TIMING as in gp2_8_formation.js: cycles charged per instruction,
 * SYNC before every shared-RAM access.
 */

import { disp8 } from '../m6809ops.js';
import { call } from '../call.js';
import { inc, dec, SYNC, syncAt } from './gp2_8_util.js';
import { endTask } from './gp2_8_formation.js';
import { subAt } from './routines.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {Generator<unknown, void, unknown>} Thread */

/**
 * Effect task (mode 5). When $10CF is set, $101A := $FF and the handler
 * tbl_B3E6[$1070] runs with A = $1070 * 2 (8-bit `asla`; `jmp [a,x]`
 * with a signed offset); the handler ends the task. Otherwise the task
 * just ends.
 * @see gaplus-sub.asm $B3D1
 * @param {Machine} m
 * @returns {Generator<unknown, unknown, unknown>}
 */
export function* sub_B3D1(m) {
  const s = m.sub;
  // lda <$CF (4) / beq (3)
  yield SYNC;
  const on = s.peek(0x10cf) !== 0;
  s.charge(4); s.charge(3);
  if (!on) {
    yield* endTask(m);
    return undefined;
  }
  // lda #$FF (2) / sta <$1A (4) / lda <$70 (4) / asla (2) /
  // ldx #tbl_B3E6 (3) / jmp [a,x] (7) -- the table is ROM data
  s.charge(2);
  yield SYNC;
  s.poke(0x101a, 0xff);
  s.charge(4);
  yield SYNC;
  const a = (s.peek(0x1070) << 1) & 0xff;
  s.charge(4); s.charge(2); s.charge(3);
  const p = disp8(0xb3e6, a);
  yield* syncAt(p, p + 1);
  const target = s.peek16(p);
  s.charge(7);
  return yield* call(subAt(target), m, { a });
}

/**
 * Effect 1: a sequence stepped by $10D0 once a frame. $0852 := 1,
 * $10D9 := $10E9 := 0, animate the six sprites ($B461), then by $10D0:
 * 0 spread six sprites along the ship ($1693+2k, X from player_x - $10,
 * flags $40); 1 start ($10D6 := $1E93 := $81); $11/$21/.../$51 switch on
 * $1E95/97/99/9B/9D; $61 plain step; other values below $80 move the
 * sprites down (bit 8 into their flag byte on a borrow); with b7 set,
 * $90-$D0 switch the same bytes off again, $E0 ends the effect (clears
 * $10CF, $10D6, $10D0, $1E93, $0852, $0872, $1111, $1E8B) and others
 * move the sprites up. Every step except 0 then sets the sprites' Y to
 * player_y and counts $106B up to 600, where $10D0 := $80.
 * @see gaplus-sub.asm $B3F2
 * @param {Machine} m
 * @returns {Thread}
 */
export function* sub_B3F2(m) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // lda #1 (2) / sta $0852 (5) / clr <$D9 (6) / clr <$E9 (6)
  c(2);
  yield SYNC;
  s.poke(0x0852, 1);
  c(5);
  yield SYNC;
  s.poke(0x10d9, 0);
  c(6);
  yield SYNC;
  s.poke(0x10e9, 0);
  c(6);
  // bsr sub_B461 (7)
  c(7);
  yield* sub_B461(m);
  // lda <$D0 (4) / anda #$80 / bne (2 + 3)
  yield SYNC;
  const neg = (s.peek(0x10d0) & 0x80) !== 0;
  c(4); c(2); c(3);
  // The compare chains: lda <$D0 (4) again, then `cmpa #n (2) / lbeq`
  // (6 taken, 5 not; the first lbeq has no cmpa, the b7 chain starts
  // with anda #$7F (2)), closed by a jmp (4) to the default.
  yield SYNC;
  const d0 = s.peek(0x10d0);
  c(4);
  /** Which case the chain picked: the value matched, or -1. */
  let hit = -1;
  if (!neg) {
    if (d0 === 0) { c(6); hit = 0; } else {
      c(5);
      for (const v of [0x61, 0x01, 0x11, 0x21, 0x31, 0x41, 0x51]) {
        c(2);
        if (d0 === v) { c(6); hit = v; break; }
        c(5);
      }
      if (hit < 0) c(4);
    }
  } else {
    const a = d0 & 0x7f;
    c(2);
    for (const v of [0x10, 0x20, 0x30, 0x40, 0x50, 0x60]) {
      c(2);
      if (a === v) { c(6); hit = v; break; }
      c(5);
    }
    if (hit < 0) c(4);
  }
  if (!neg && hit === 0) {
    // $B4B3: inc <$D0 (6) / ldx #$1693 (3) / lda #$40 (2) /
    // ldb player_x (5) / subb #$10 (2)
    yield SYNC;
    inc(s, 0x10d0);
    c(6); c(3); c(2);
    yield SYNC;
    let b = (s.peek(0x1601) - 0x10) & 0xff;
    c(5); c(2);
    // sta $07FF,x (8) / stb ,x++ (7) / addb #$10 / cmpx / bne (2 + 4 + 3)
    for (let x = 0x1693; x !== 0x169f; x += 2) {
      yield SYNC;
      s.poke(x + 0x07ff, 0x40);
      c(8);
      yield SYNC;
      s.poke(x, b);
      c(7);
      b = (b + 0x10) & 0xff;
      c(2); c(4); c(3);
    }
    // jmp lB543 (4)
    c(4);
    yield* endTask(m);
    return;
  }
  if (!neg && hit === 0x61) {
    // lbeq lB522: nothing else
  } else if (!neg && hit === 0x01) {
    // $B4CF: inc <$D0 (6) / lda #$81 (2) / sta <$D6 (4) / sta $1E93 (5) /
    // jmp (4)
    yield SYNC;
    inc(s, 0x10d0);
    c(6); c(2);
    yield SYNC;
    s.poke(0x10d6, 0x81);
    c(4);
    yield SYNC;
    s.poke(0x1e93, 0x81);
    c(5); c(4);
  } else if (!neg && hit > 0) {
    // $B4F5-$B519: inc <$D0 (6) / lda #$81 (2) / sta $1E95.. (5) /
    // bra (3)
    yield SYNC;
    inc(s, 0x10d0);
    c(6); c(2);
    yield SYNC;
    s.poke(0x1e95 + ((hit >> 4) - 1) * 2, 0x81);
    c(5); c(3);
  } else if (!neg) {
    // $B4DB: inc <$D0 (6) / ldx #$1693 (3); per sprite: lda ,x (4) /
    // suba #1 / bcc (2 + 3) [ldb #$80 (2) / stb $0800,x (8)] /
    // sta ,x++ (7) / cmpx / bne (4 + 3); bra (3)
    yield SYNC;
    inc(s, 0x10d0);
    c(6); c(3);
    for (let x = 0x1693; x !== 0x169f; x += 2) {
      yield SYNC;
      const v = s.peek(x);
      c(4); c(2); c(3);
      if (v === 0) {
        c(2);
        yield SYNC;
        s.poke(x + 0x0800, 0x80);
        c(8);
      }
      yield SYNC;
      s.poke(x, (v - 1) & 0xff);
      c(7); c(4); c(3);
    }
    c(3);
  } else if (hit === 0x60) {
    // $B56E: clr <$CF / <$D6 / <$D0 (6 each), clr $1E93 / $0852 /
    // $0872 / $1111 / $1E8B (7 each), jmp (4)
    for (const a of [0x10cf, 0x10d6, 0x10d0]) {
      yield SYNC;
      s.poke(a, 0);
      c(6);
    }
    for (const a of [0x1e93, 0x0852, 0x0872, 0x1111, 0x1e8b]) {
      yield SYNC;
      s.poke(a, 0);
      c(7);
    }
    c(4);
  } else if (hit > 0) {
    // $B548-$B566: inc <$D0 (6) / clr $1E9D-.. (7) / bra (3) for $10,
    // $20; jmp (4) for $30-$50
    yield SYNC;
    inc(s, 0x10d0);
    c(6);
    yield SYNC;
    s.poke(0x1e9d - ((hit >> 4) - 1) * 2, 0);
    c(7 + (hit <= 0x20 ? 3 : 4));
  } else {
    // $B586: inc <$D0 (6) / ldx #$1693 (3); per sprite: lda ,x (4) /
    // adda #1 / bcc (2 + 3) [ldb #$81 (2) / stb $0800,x (8)] /
    // sta ,x++ (7) / cmpx / bne (4 + 3); jmp (4)
    yield SYNC;
    inc(s, 0x10d0);
    c(6); c(3);
    for (let x = 0x1693; x !== 0x169f; x += 2) {
      yield SYNC;
      const v = s.peek(x);
      c(4); c(2); c(3);
      if (v === 0xff) {
        c(2);
        yield SYNC;
        s.poke(x + 0x0800, 0x81);
        c(8);
      }
      yield SYNC;
      s.poke(x, (v + 1) & 0xff);
      c(7); c(4); c(3);
    }
    c(4);
  }
  // $B522: ldx #$1692 (3) / lda player_y (5); sta ,x++ (7) / cmpx /
  // bne (4 + 3) x 6
  c(3);
  yield SYNC;
  const py = s.peek(0x1600);
  c(5);
  for (let x = 0x1692; x !== 0x169e; x += 2) {
    yield SYNC;
    s.poke(x, py);
    c(7); c(4); c(3);
  }
  // ldd <$6B (5) / addd #1 (4) / cmpd #$0258 (5) / bne (3)
  yield SYNC;
  let d = (s.peek16(0x106b) + 1) & 0xffff;
  c(5); c(4); c(5); c(3);
  if (d === 0x0258) {
    // lda #$80 (2) / sta <$D0 (4) / ldd #0 (3)
    c(2);
    yield SYNC;
    s.poke(0x10d0, 0x80);
    c(4); c(3);
    d = 0;
  }
  // std <$6B (5)
  yield SYNC;
  s.poke16(0x106b, d);
  c(5);
  yield* endTask(m);
}

/**
 * Animate the six effect sprites $0E92-$0E9D: on even frames copy six
 * code/colour words from dat_B483, frame (frame_counter & $0C) / 4.
 * @see gaplus-sub.asm $B461
 * @param {Machine} m
 * @returns {Thread}
 */
export function* sub_B461(m) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // ldx #$0E92 (3) / lda <frame_counter (4) / anda #1 / beq (2 + 3)
  c(3);
  yield SYNC;
  const odd = (s.peek(0x1016) & 0x01) !== 0;
  c(4); c(2); c(3);
  if (odd) { c(5); return; }
  // ldu #dat_B483 (3) / lda <frame_counter (4) / anda #$0C / lsra /
  // lsra / ldb #$0C (2 + 2 + 2 + 2) / mul (11) / leau d,u (8)
  c(3);
  yield SYNC;
  let u = 0xb483 + ((s.peek(0x1016) & 0x0c) >> 2) * 12;
  c(4); c(8); c(11); c(8);
  // $B479: ldd ,u++ (8) / std ,x++ (8) / cmpx #$0E9E / bne (4 + 3)
  for (let x = 0x0e92; x !== 0x0e9e; x += 2) {
    yield* syncAt(u, u + 1);
    const d = s.peek16(u);
    u = (u + 2) & 0xffff;
    c(8);
    yield SYNC;
    s.poke16(x, d);
    c(8); c(4); c(3);
  }
  c(5); // rts
}

/**
 * Effect 0: six sprites ($1692-$16A1) placed at player_y - 8 with flags
 * $20, $0851 := 1. On frames with frame_counter & 3 = 2 ($10DA := 2):
 * while $10D0 < $17 it loads the next picture list (dat_B653[$10D0]:
 * (code, colour, X, flags) quadruples ended by $FF) into $0E92+; at $17
 * it animates the codes ($0E93+2k: +1 each, or all := $2A once they
 * reach $2F). Every frame $1069 counts to 480, which ends the effect
 * (dual_fighter, $1EC3-$1ECD, $1E93-$1EA1, $10CF, $10D0, $0851, $0871,
 * $1E8B cleared, $10D9 := 1, $10DA - 1).
 * @see gaplus-sub.asm $B5A1
 * @param {Machine} m
 * @returns {Thread}
 */
export function* sub_B5A1(m) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // clr <$D9 (6) / ldx #$1692 (3) / lda player_y (5) / suba #8 /
  // ldb #$20 (2 + 2)
  yield SYNC;
  s.poke(0x10d9, 0);
  c(6); c(3);
  yield SYNC;
  const y = (s.peek(0x1600) - 8) & 0xff;
  c(5); c(2); c(2);
  // stb $0800,x (8) / sta ,x++ (7) / cmpx / bne (4 + 3)
  for (let x = 0x1692; x !== 0x16a2; x += 2) {
    yield SYNC;
    s.poke(x + 0x0800, 0x20);
    c(8);
    yield SYNC;
    s.poke(x, y);
    c(7); c(4); c(3);
  }
  // lda #1 (2) / sta $0851 (5)
  c(2);
  yield SYNC;
  s.poke(0x0851, 1);
  c(5);
  // lda <frame_counter (4) / anda #3 / cmpa #2 / bne (2 + 2 + 3)
  yield SYNC;
  const ph = s.peek(0x1016) & 0x03;
  c(4); c(2); c(2); c(3);
  if (ph === 2) {
    // sta <$DA (4) / lda <$D0 (4) / cmpa #$17 / beq (2 + 3)
    yield SYNC;
    s.poke(0x10da, 2);
    c(4);
    yield SYNC;
    const a = s.peek(0x10d0);
    c(4); c(2); c(3);
    if (a === 0x17) {
      // $B636: ldx #$0E93 (3) / ldb #$2A (2) / lda ,x (4) / cmpa #$2F /
      // beq (2 + 3)
      c(3); c(2);
      yield SYNC;
      const all = s.peek(0x0e93) === 0x2f;
      c(4); c(2); c(3);
      for (let x = 0x0e93; x !== 0x0ea1; x += 2) {
        yield SYNC;
        if (all) {
          s.poke(x, 0x2a);
          c(7); c(4); c(3); // stb ,x++ / cmpx / bne
        } else {
          inc(s, x);
          c(9); c(4); c(3); // inc ,x++ / cmpx / bne
        }
      }
      c(3); // bra lB5F0
    } else {
      // inc <$D0 (6) / asla (2) / ldx #dat_B653 (3) / ldx a,x (6) /
      // ldu #$0E92 (3)
      yield SYNC;
      inc(s, 0x10d0);
      c(6); c(2); c(3);
      const p = disp8(0xb653, (a << 1) & 0xff);
      yield* syncAt(p, p + 1);
      let x = s.peek16(p);
      c(6); c(3);
      let u = 0x0e92;
      for (;;) {
        // $B5D8: ldd ,x++ (8) / cmpa #$FF / beq (2 + 3)
        yield* syncAt(x, x + 1);
        let d = s.peek16(x);
        x = (x + 2) & 0xffff;
        c(8); c(2); c(3);
        if ((d >> 8) === 0xff) break;
        // sta ,u (4) / stb 1,u (5) / ldd ,x++ (8) / sta $0801,u (8) /
        // stb $1001,u (8) / leau 2,u (5) / bra (3)
        yield* syncAt(u);
        s.poke(u, d >> 8);
        c(4);
        yield* syncAt(u + 1);
        s.poke((u + 1) & 0xffff, d & 0xff);
        c(5);
        yield* syncAt(x, x + 1);
        d = s.peek16(x);
        x = (x + 2) & 0xffff;
        c(8);
        yield* syncAt(u + 0x0801);
        s.poke((u + 0x0801) & 0xffff, d >> 8);
        c(8);
        yield* syncAt(u + 0x1001);
        s.poke((u + 0x1001) & 0xffff, d & 0xff);
        c(8); c(5); c(3);
        u = (u + 2) & 0xffff;
      }
    }
  }
  // $B5F0: ldd <$69 (5) / addd #1 (4) / cmpd #$01E0 (5) / bne (3)
  yield SYNC;
  let d = (s.peek16(0x1069) + 1) & 0xffff;
  c(5); c(4); c(5); c(3);
  if (d === 0x01e0) {
    // clr <dual_fighter (6); clr $1EC3 ... $1ECD (7 each)
    yield SYNC;
    s.poke(0x10db, 0);
    c(6);
    for (let a = 0x1ec3; a <= 0x1ecd; a += 2) {
      yield SYNC;
      s.poke(a, 0);
      c(7);
    }
    // lda #1 (2) / sta <$D9 (4) / ldx #$1E93 (3); clr ,x++ (9) / cmpx /
    // bne (4 + 3) x 8
    c(2);
    yield SYNC;
    s.poke(0x10d9, 1);
    c(4); c(3);
    for (let x = 0x1e93; x !== 0x1ea3; x += 2) {
      yield SYNC;
      s.poke(x, 0);
      c(9); c(4); c(3);
    }
    // clr <$CF / clr <$D0 / dec <$DA (6 each); clr $0851 / $0871 /
    // $1E8B (7 each); ldd #0 (3)
    for (const a of [0x10cf, 0x10d0]) {
      yield SYNC;
      s.poke(a, 0);
      c(6);
    }
    yield SYNC;
    dec(s, 0x10da);
    c(6);
    for (const a of [0x0851, 0x0871, 0x1e8b]) {
      yield SYNC;
      s.poke(a, 0);
      c(7);
    }
    c(3);
    d = 0;
  }
  // $B62F: std <$69 (5)
  yield SYNC;
  s.poke16(0x1069, d);
  c(5);
  yield* endTask(m);
}

/**
 * Effects 2-5 (A = 2 * effect = 4, 6, 8 or 10): clear $10D9, $1111,
 * $10E9, $10CF, then
 *   A = 6:  $1010 = $1011 = $10 and $19E0-$1A0C := $10; on stages $1E
 *           and $2D also the per-player flag $1178/$1179, $10D4 := $A8
 *           and the sprites $0E00, $0F16-$0F1D set up;
 *   A = 8:  $1114 := $32;   A = 10: $1177 := 1;
 *   other:  $0853 := 1, player_step := 3, player_speed := 1, four
 *           sprite codes $3E at $0EA2, $1100/$1101 := $0C/$1A, shot
 *           speed + 1 up to 7;
 * and in every case $1E8B := 0.
 * @see gaplus-sub.asm $B860
 * @param {Machine} m
 * @param {{ a: number }} regs A from $B3D1
 * @returns {Thread}
 */
export function* sub_B860(m, { a }) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // clr <$D9 (6) / clr $1111 (7) / clr <$E9 (6) / clr <$CF (6)
  for (const [p, n] of [[0x10d9, 6], [0x1111, 7], [0x10e9, 6],
    [0x10cf, 6]]) {
    yield SYNC;
    s.poke(p, 0);
    c(n);
  }
  // suba #6 / beq (2 + 3) / suba #2 / lbeq (2 + 6|5) / suba #2 /
  // lbeq (2 + 6|5)
  c(2); c(3);
  if (a === 6) {
    // $B8AC: lda #$10 (2) / sta <$10 (4) / sta <$11 (4) /
    // ldx #$19E0 (3); sta ,x+ (6) / cmpx / bne (4 + 3) x 45
    c(2);
    yield SYNC;
    s.poke(0x1010, 0x10);
    c(4);
    yield SYNC;
    s.poke(0x1011, 0x10);
    c(4); c(3);
    for (let x = 0x19e0; x !== 0x1a0d; x += 1) {
      yield SYNC;
      s.poke(x, 0x10);
      c(6); c(4); c(3);
    }
    // lda <stage (4) / cmpa #$1E / beq (2 + 3) / cmpa #$2D / beq (2 + 3)
    yield SYNC;
    const st = s.peek(0x1035);
    c(4); c(2); c(3);
    let special = st === 0x1e;
    if (!special) {
      c(2); c(3);
      special = st === 0x2d;
    }
    if (!special) {
      c(3); // bra lB8A4
    } else {
      // $B8C8: lda <cur_player (4) / beq (3) / lda #1 (2) /
      // sta $1179 (5) / bra (3)  or  lda #1 (2) / sta $1178 (5)
      yield SYNC;
      const p2 = s.peek(0x102d) !== 0;
      c(4); c(3); c(2);
      yield SYNC;
      s.poke(p2 ? 0x1179 : 0x1178, 1);
      c(5 + (p2 ? 3 : 0));
      // lda #$A8 (2) / sta <$D4 (4)
      c(2);
      yield SYNC;
      s.poke(0x10d4, 0xa8);
      c(4);
      // ldd #$7E3F (3) / std $0E00 (6) / ldd #$7F3F (3) /
      // std $0F16, $0F18, $0F1A, $0F1C (6 each)
      c(3);
      yield SYNC;
      s.poke16(0x0e00, 0x7e3f);
      c(6); c(3);
      for (let x = 0x0f16; x <= 0x0f1c; x += 2) {
        yield SYNC;
        s.poke16(x, 0x7f3f);
        c(6);
      }
      // clra (2) / sta $1F16, $1F18, $1F1A, $1F1C (5 each) / bra (3)
      c(2);
      for (let x = 0x1f16; x <= 0x1f1c; x += 2) {
        yield SYNC;
        s.poke(x, 0);
        c(5);
      }
      c(3);
    }
  } else if (a === 8) {
    // lbeq taken (2 + 6) / lda #$32 (2) / sta $1114 (5) / bra (3)
    c(2); c(6); c(2);
    yield SYNC;
    s.poke(0x1114, 0x32);
    c(5); c(3);
  } else if (a === 10) {
    // (2 + 5) then (2 + 6) / lda #1 (2) / sta $1177 (5) / bra (3)
    c(2); c(5); c(2); c(6); c(2);
    yield SYNC;
    s.poke(0x1177, 1);
    c(5); c(3);
  } else {
    // both lbeq not taken (2 + 5 + 2 + 5); lda #1 (2) / sta $0853 (5)
    c(2); c(5); c(2); c(5); c(2);
    yield SYNC;
    s.poke(0x0853, 1);
    c(5);
    // lda #3 (2) / sta <player_step (4) / lda #1 (2) /
    // sta <player_speed (4)
    c(2);
    yield SYNC;
    s.poke(0x10d1, 3);
    c(4); c(2);
    yield SYNC;
    s.poke(0x1032, 1);
    c(4);
    // ldx #$0EA2 / lda #$3E / ldb #4 (3 + 2 + 2); sta ,x++ (7) / decb /
    // bne (2 + 3) x 4
    c(3); c(2); c(2);
    for (let x = 0x0ea2; x !== 0x0eaa; x += 2) {
      yield SYNC;
      s.poke(x, 0x3e);
      c(7); c(2); c(3);
    }
    // lda #$0C (2) / sta $1100 (5) / lda #$1A (2) / sta $1101 (5)
    c(2);
    yield SYNC;
    s.poke(0x1100, 0x0c);
    c(5); c(2);
    yield SYNC;
    s.poke(0x1101, 0x1a);
    c(5);
    // lda <shot_speed (4) / cmpa #7 / beq (2 + 3) [inc <shot_speed (6)]
    yield SYNC;
    const ss = s.peek(0x10d2);
    c(4); c(2); c(3);
    if (ss !== 7) {
      yield SYNC;
      inc(s, 0x10d2);
      c(6);
    }
  }
  // $B8A4: clr $1E8B (7)
  yield SYNC;
  s.poke(0x1e8b, 0);
  c(7);
  yield* endTask(m);
}

// Copyright 2026 by Moshix
/**
 * Sub CPU, ROM gp2-6.11b, $E5AA-$EBEB (registered by gp2_6.js).
 * Task convention and yields: see gp2_6.js and gp2_6_state.js.
 *
 * Mode-5 (normal play) tasks: the formation leader / boss capture
 * sequence ($E5AA-$E6F8), the tractor-beam style capture checks against
 * the player ($E729-$EA4B, dispatched by $10DA) and the formation refill
 * ($EA4C).
 *
 * CYCLE-EXACT (the contract of gp2_6_state.js): every instruction charges
 * its 6809 cycles, every access to shared memory goes through rd / rd16 /
 * wr / wr16 / rmw, which yield SYNC first, so the sub's charged time at
 * each SYNC and each write is the cycle at which the ROM starts that
 * instruction. Cycle counts are MAME's (the oracle core's); comments
 * give them as `~n`. Every task charges up to and including its final
 * `JMP task_dispatch_sub`. All routines are generators.
 */

import { subAt } from './routines.js';
import { call } from '../call.js';
import { disp8 } from '../m6809ops.js';
import {
  BUSY, rd, rd16, wr, wr16, rmw, INC, DEC, CLR,
} from './gp2_6_state.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {import('../../machine/machine.js').CpuView} CpuView */
/** @typedef {Generator<unknown, void, unknown>} Task */

// -------------------------------------------------------------- helpers

/**
 * The common tail `INC <$7A (~6) / JMP task_dispatch_sub (~4)`.
 * @param {CpuView} s @returns {Task}
 */
function* nextTask(s) {
  yield* rmw(s, 0x107a, INC, 6); // sub_task
  s.charge(4);
}

/**
 * `lda hi / ldb lo / lsra / rorb`: the 9-bit coordinate hi:lo halved
 * into 8 bits (bit 0 of hi becomes bit 7).
 * @param {number} hi @param {number} lo @returns {number}
 */
const half9 = (hi, lo) => ((hi & 1) << 7) | ((lo & 0xff) >> 1);

// ------------------------------------------------- formation leader

/**
 * sub_E5AA ($E5AA): if formation slot 42 ($188A) has bit 0 set, copy
 * it (= 1) into slot 43 ($188B); next task. Also reached from sub_E5B8.
 * @see gaplus-sub.asm $E5AA
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E5AA(m) {
  const s = m.sub;
  yield* e5aa(s);
  yield* nextTask(s);
}

/**
 * $E5AA body up to lE62F: `lda $188A ~5 / anda #$01 ~2 / lbeq ~5/6 /
 * sta $188B ~5 / bra ~3`.
 * @param {CpuView} s @returns {Task}
 */
function* e5aa(s) {
  const a = (yield* rd(s, 0x188a, 5)) & 0x01;
  s.charge(2);
  if (a === 0) { s.charge(6); return; }
  s.charge(5);
  yield* wr(s, 0x188b, a, 5);
  s.charge(3);
}

/**
 * sub_E5B8 ($E5B8): countdown $112C; when it runs out, point $112D at
 * $188C, then step the pair of formation slots 42/43 ($188A/$188B)
 * through their states (alternating on $112B bit 0), set up the sprite
 * at $0E84-$0E8B / $0F2C, or flag $10CE / $1018; next task.
 * @see gaplus-sub.asm $E5B8
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E5B8(m) {
  const s = m.sub;
  // $E5B8: lda $112C ~5 / beq ~3 / dec $112C ~7 / bra ~3
  const t = yield* rd(s, 0x112c, 5);
  s.charge(3);
  if (t !== 0) {
    yield* rmw(s, 0x112c, DEC, 7);
    s.charge(3);
    yield* nextTask(s);
    return;
  }
  // $E5C2: ldd #$188C ~3 / std $112D ~6
  s.charge(3);
  yield* wr16(s, 0x112d, 0x188c, 6);
  // $E5C8: lda $110F ~5 / bne sub_E5AA ~3
  const g = yield* rd(s, 0x110f, 5);
  s.charge(3);
  if (g !== 0) {
    yield* e5aa(s);
    yield* nextTask(s);
    return;
  }
  // $E5CD: ldd $188A ~6 / anda #$01 ~2 / beq ~3 -- B keeps $188B
  const d = yield* rd16(s, 0x188a, 6);
  const a0 = (d >> 8) & 0x01;
  const b0 = d & 0xff;
  s.charge(2); s.charge(3);
  if (a0 === 0) { yield* nextTask(s); return; }
  // $E5D4: lda $112B ~5 / anda #$01 ~2 / bne $E60B ~3
  const k = yield* rd(s, 0x112b, 5);
  s.charge(2); s.charge(3);
  if ((k & 0x01) === 0) {
    // $E5DB: inc $112B ~7 / ldd #$188B ~3 / std $112D ~6
    yield* rmw(s, 0x112b, INC, 7);
    s.charge(3);
    yield* wr16(s, 0x112d, 0x188b, 6);
    // $E5E4: lda $188B ~5 / sta $188A ~5 / anda #$02 ~2 / beq ~3
    const f = yield* rd(s, 0x188b, 5);
    yield* wr(s, 0x188a, f, 5);
    s.charge(2); s.charge(3);
    if ((f & 0x02) !== 0) {
      // $E5EE: lda $110B ~5 / sta $1E85 ~5
      const v = yield* rd(s, 0x110b, 5);
      yield* wr(s, 0x1e85, v, 5);
    }
    // $E5F4: lda #$20 ~2 / sta $112C ~5 / lda <$6E ~4 / ldx #$E608 ~3 /
    // lda a,x ~5 (signed offset, a ROM table)
    s.charge(2);
    yield* wr(s, 0x112c, 0x20, 5);
    const st = yield* rd(s, 0x106e, 4);
    s.charge(3);
    const v = yield* rd(s, disp8(0xe608, st), 5);
    // $E600: sta $0E85 ~5 / sta $0E2D ~5 / bra ~3
    yield* wr(s, 0x0e85, v, 5);
    yield* wr(s, 0x0e2d, v, 5); // sprite_shadow_1+45
    s.charge(3);
    yield* nextTask(s);
    return;
  }
  // $E60B: andb #$02 ~2 / beq $E634 ~3
  s.charge(2); s.charge(3);
  if ((b0 & 0x02) === 0) {
    // $E634: ldd #$0101 ~3 / std $188A ~6 / bra ~3
    s.charge(3);
    yield* wr16(s, 0x188a, 0x0101, 6);
    s.charge(3);
    yield* nextTask(s);
    return;
  }
  // $E60F: ldb #$01 ~2 / std $188A ~6 -- A is still 1 from the anda
  s.charge(2);
  yield* wr16(s, 0x188a, 0x0101, 6);
  // $E614: lda $0E86 ~5 / anda #$20 ~2 / bne $E63C ~3
  const e = yield* rd(s, 0x0e86, 5);
  s.charge(2); s.charge(3);
  if ((e & 0x20) === 0) {
    // $E61B: clra ~2 / sta $0E8A ~5 / ldd $1686 ~6 / std $168A ~6 /
    // ldd $1E86 ~6 / std $1E8A ~6 / lda #$01 ~2 / sta <$CE ~4
    s.charge(2);
    yield* wr(s, 0x0e8a, 0, 5);
    yield* wr16(s, 0x168a, yield* rd16(s, 0x1686, 6), 6);
    yield* wr16(s, 0x1e8a, yield* rd16(s, 0x1e86, 6), 6);
    s.charge(2);
    yield* wr(s, 0x10ce, 0x01, 4);
  } else {
    // $E63C: copy the sprite at $0E86 to slot $0F2C (three banks, ldd
    // ~6 / std ~6 each), then lda #$18 ~2 / sta <$18 ~4 / bra ~3
    yield* wr16(s, 0x0f2c, yield* rd16(s, 0x0e86, 6), 6);
    yield* wr16(s, 0x172c, yield* rd16(s, 0x1686, 6), 6);
    yield* wr16(s, 0x1f2c, yield* rd16(s, 0x1e86, 6), 6);
    s.charge(2);
    yield* wr(s, 0x1018, 0x18, 4);
    s.charge(3);
  }
  yield* nextTask(s);
}

/**
 * sub_E654 ($E654): the capture sequence driven by $10CE (0 idle, 1
 * steer, 2 and 3 latch the target Y): in state 1 animate the sprite at
 * $0E8A/$1E8A from the table at $E6F9 (index $10CD, step 2, wraps at
 * $30), move the player's Y ($1600) one step toward $168A, advance the
 * player's 9-bit X ($1601/$1E01, capped at $149 when bit 8 is set), and
 * move $168B/$1E8B one step toward X - 5, flagging $0850; next task.
 * @see gaplus-sub.asm $E654
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E654(m) {
  const s = m.sub;
  // $E654: lda <$CE ~4 / beq $E6CE ~3
  const ce = yield* rd(s, 0x10ce, 4);
  s.charge(3);
  if (ce === 0) { yield* nextTask(s); return; }
  // $E658: cmpa #$02 ~2 / lbeq $E6E9 ~5/6 / cmpa #$03 ~2 / lbeq ~5/6
  s.charge(2 + (ce === 0x02 ? 6 : 5));
  if (ce !== 0x02) s.charge(2 + (ce === 0x03 ? 6 : 5));
  if (ce === 0x02 || ce === 0x03) {
    if (ce === 0x02) {
      // $E6E9: inc <$CE ~6 / lda #$01 ~2 / sta <$CF ~4
      yield* rmw(s, 0x10ce, INC, 6);
      s.charge(2);
      yield* wr(s, 0x10cf, 0x01, 4);
    }
    // $E6EF: ldd $1600 ~6 / subb #$05 ~2 / sta $168A ~5 / bra ~3 -- the
    // SUBB is dead: A (player_y) is what gets stored.
    const d = yield* rd16(s, 0x1600, 6);
    s.charge(2);
    yield* wr(s, 0x168a, d >> 8, 5);
    s.charge(3);
    yield* nextTask(s);
    return;
  }
  // $E664: ldx #$E6F9 ~3 / lda <$CD ~4 / ldd a,x ~6 / sta $0E8A ~5 /
  // stb $1E8A ~5
  s.charge(3);
  const cd = yield* rd(s, 0x10cd, 4);
  const d = yield* rd16(s, disp8(0xe6f9, cd), 6);
  yield* wr(s, 0x0e8a, d >> 8, 5);
  yield* wr(s, 0x1e8a, d & 0xff, 5);
  // $E671: lda <$CD ~4 / adda #$02 ~2 / cmpa #$30 ~2 / bne ~3 / clra ~2 /
  // sta <$CD ~4
  let n = ((yield* rd(s, 0x10cd, 4)) + 2) & 0xff;
  s.charge(2); s.charge(2); s.charge(3);
  if (n === 0x30) { n = 0; s.charge(2); }
  yield* wr(s, 0x10cd, n, 4);
  // $E67C: lda $1600 ~5 / sta <$1A ~4 / sta <$D9 ~4 / sta $1111 ~5 /
  // sta <$E9 ~4
  const y = yield* rd(s, 0x1600, 5); // player_y
  yield* wr(s, 0x101a, y, 4);
  yield* wr(s, 0x10d9, y, 4);
  yield* wr(s, 0x1111, y, 5);
  yield* wr(s, 0x10e9, y, 4);
  // $E688: cmpa $168A ~5 / bcs inc ~3 / beq ~3 / dec $1600 ~7 / bra ~3
  const ty = yield* rd(s, 0x168a, 5);
  s.charge(3);
  if (y < ty) {
    yield* rmw(s, 0x1600, INC, 7);
  } else {
    s.charge(3);
    if (y !== ty) {
      yield* rmw(s, 0x1600, DEC, 7);
      s.charge(3);
    }
  }
  // $E697: lda $1601 ~5 / adda #$01 ~2 / bcc ~3 / inc $1E01 ~7
  const x0 = yield* rd(s, 0x1601, 5); // player_x
  const x = (x0 + 1) & 0xff;
  s.charge(2); s.charge(3);
  if (x0 === 0xff) yield* rmw(s, 0x1e01, INC, 7);
  // $E6A1: ldb $1E01 ~5 / andb #$01 ~2 / beq store ~3 / cmpa #$49 ~2 /
  // bcc skip ~3 / sta $1601 ~5
  const h = yield* rd(s, 0x1e01, 5);
  s.charge(2); s.charge(3);
  let store = (h & 0x01) === 0;
  if (!store) { s.charge(2 + 3); store = x < 0x49; }
  if (store) yield* wr(s, 0x1601, x, 5);
  // $E6AF: lda $1E01 ~5 / cmpa $1E8B ~5 / bne $E6C1 ~3 / lda $1601 ~5 /
  // suba #$05 ~2 / cmpa $168B ~5 / beq $E6D3 ~3
  const hx = yield* rd(s, 0x1e01, 5);
  const tx = yield* rd(s, 0x1e8b, 5);
  s.charge(3);
  let arrived = false;
  if (hx === tx) {
    const t = ((yield* rd(s, 0x1601, 5)) - 0x05) & 0xff;
    s.charge(2);
    const c = yield* rd(s, 0x168b, 5);
    s.charge(3);
    arrived = t === c;
  }
  if (!arrived) {
    // $E6C1: lda #$01 ~2 / sta $0850 ~5 / inc $168B ~7 / bne ~3 /
    // inc $1E8B ~7
    s.charge(2);
    yield* wr(s, 0x0850, 0x01, 5);
    const v = yield* rmw(s, 0x168b, INC, 7);
    s.charge(3);
    if (v === 0) yield* rmw(s, 0x1e8b, INC, 7);
  } else {
    // $E6D3: clr $0850 ~7 / clr $0870 ~7 / lda $1E8A ~5 / cmpa #$40 ~2 /
    // bne ~3 / lda $0E8A ~5 / bne ~3 / inc <$CE ~6 / bra ~3 -- state + 1
    // once the sprite animation is back at its first frame
    yield* rmw(s, 0x0850, CLR, 7);
    yield* rmw(s, 0x0870, CLR, 7);
    const f = yield* rd(s, 0x1e8a, 5);
    s.charge(2); s.charge(3);
    if (f === 0x40) {
      const g = yield* rd(s, 0x0e8a, 5);
      s.charge(3);
      if (g === 0) {
        yield* rmw(s, 0x10ce, INC, 6);
        s.charge(3);
      }
    }
  }
  yield* nextTask(s);
}

// ------------------------------------------------------ capture checks

/**
 * The common body of $E787-$E7DF / $E854-$E8AC: formation slot at X is
 * caught (bit 6 set), and its animation nibble in $0E30+2n steps by the
 * direction in $1E30+2n (0: frame - 1, past 0 -> frame 1, direction 2;
 * 2: frame + 1, at $C -> frame 0, direction 1; else: frame $B,
 * direction 0).
 * @param {CpuView} s
 * @param {number} u $1630+2n
 * @returns {Task}
 */
function* animateCaught(s, u) {
  const lo = (u - 0x0800) & 0xffff; // -$0800,u: the $0E30 bank
  const hi = (u + 0x0800) & 0xffff; // $0800,u: the $1E30 bank
  // $E787: lda $0800,u ~8 / beq $E7A0 ~3 / cmpa #$02 ~2 / beq $E7BB ~3
  const dir = yield* rd(s, hi, 8);
  s.charge(3);
  let a;
  if (dir === 0) {
    // $E7A0: lda -$800,u ~8 / ldb -$800,u ~8 / andb #$F0 ~2 /
    // stb -$800,u ~8 / anda #$0F ~2 / suba #$01 ~2 / cmpa #$FF ~2 /
    // bne $E7D8 ~3 / ldd #$0102 ~3 / bra ~3 / stb $0800,u ~8
    const v = yield* rd(s, lo, 8);
    const w = yield* rd(s, lo, 8);
    s.charge(2);
    yield* wr(s, lo, w & 0xf0, 8);
    s.charge(2); s.charge(2); s.charge(2); s.charge(3);
    a = ((v & 0x0f) - 1) & 0xff;
    if (a === 0xff) {
      a = 0x01;
      s.charge(3); s.charge(3);
      yield* wr(s, hi, 0x02, 8);
    }
  } else {
    s.charge(2); s.charge(3);
    if (dir === 0x02) {
      // $E7BB: the same with anda #$0F / adda #$01 / cmpa #$0C / bne /
      // ldd #$0001 ~3 (falls into the stb $0800,u)
      const v = yield* rd(s, lo, 8);
      const w = yield* rd(s, lo, 8);
      s.charge(2);
      yield* wr(s, lo, w & 0xf0, 8);
      s.charge(2); s.charge(2); s.charge(2); s.charge(3);
      a = ((v & 0x0f) + 1) & 0xff;
      if (a === 0x0c) {
        a = 0x00;
        s.charge(3);
        yield* wr(s, hi, 0x01, 8);
      }
    } else {
      // $E791: lda -$800,u ~8 / anda #$F0 ~2 / sta -$800,u ~8 /
      // ldd #$0B00 ~3 / bra ~3 / stb $0800,u ~8
      const v = yield* rd(s, lo, 8);
      s.charge(2);
      yield* wr(s, lo, v & 0xf0, 8);
      s.charge(3); s.charge(3);
      a = 0x0b;
      yield* wr(s, hi, 0x00, 8);
    }
  }
  // $E7D8: ora -$800,u ~8 / sta -$800,u ~8
  const o = yield* rd(s, lo, 8);
  yield* wr(s, lo, a | o, 8);
}

/**
 * sub_E729 ($E729): when $10D6 is set, the window between the player's
 * X - $10 (<$D7) and $1693/$1E93 (<$D8, both halved 9-bit values) and
 * within Y +-5 of the player catches every formation slot ($1860-$1889)
 * with bit 1 set: bit 6 set, animation stepped, Y pinned to the player's.
 * Bit 6 is cleared first on every candidate. Next task.
 * @see gaplus-sub.asm $E729
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E729(m) {
  const s = m.sub;
  // $E729: lda <$D6 ~4 / lbeq $E7E8 ~5/6
  const on = yield* rd(s, 0x10d6, 4);
  s.charge(on === 0 ? 6 : 5);
  if (on === 0) { yield* nextTask(s); return; }
  // $E72F: lda $1E01 ~5 / ldb $1601 ~5 / subb #$10 ~2 / lsra ~2 /
  // rorb ~2 / stb <$D7 ~4 -- the SUBB's borrow is lost: LSRA overwrites
  // C before the RORB
  const h = yield* rd(s, 0x1e01, 5);
  const l = yield* rd(s, 0x1601, 5);
  s.charge(2); s.charge(2); s.charge(2);
  yield* wr(s, 0x10d7, half9(h, (l - 0x10) & 0xff), 4);
  // $E73B: lda $1E93 ~5 / ldb $1693 ~5 / lsra / rorb / stb <$D8 ~4
  const h2 = yield* rd(s, 0x1e93, 5);
  const l2 = yield* rd(s, 0x1693, 5);
  s.charge(2); s.charge(2);
  yield* wr(s, 0x10d8, half9(h2, l2), 4);
  // $E745: ldx #$185F ~3 / ldu #$162E ~3
  s.charge(3); s.charge(3);
  let x = 0x185f;
  let u = 0x162e;
  for (;;) {
    // $E74B: leau 2,u ~5 / leax 1,x ~5 / lda ,x ~4 / cmpx #$188A ~4 /
    // lbeq ~5/6 / anda #$02 ~2 / beq ~3
    s.charge(5); s.charge(5);
    u += 2;
    x += 1;
    const f = yield* rd(s, x, 4);
    s.charge(4);
    if (x === 0x188a) { s.charge(6); break; }
    s.charge(5); s.charge(2); s.charge(3);
    if ((f & 0x02) === 0) continue;
    // $E75C: lda ,x ~4 / anda #$BF ~2 / sta ,x ~4
    const f2 = yield* rd(s, x, 4);
    s.charge(2);
    yield* wr(s, x, f2 & 0xbf, 4);
    // $E762: lda $1600 ~5 / adda #$05 ~2 / cmpa ,u ~4 / bcs ~3 /
    // suba #$0A ~2 / cmpa ,u ~4 / bcc ~3 -- unsigned, on wrapped sums
    const a = ((yield* rd(s, 0x1600, 5)) + 0x05) & 0xff;
    s.charge(2);
    const c1 = yield* rd(s, u, 4);
    s.charge(3);
    if (a < c1) continue;
    s.charge(2);
    const c2 = yield* rd(s, u, 4);
    s.charge(3);
    if (((a - 0x0a) & 0xff) >= c2) continue;
    // $E771: lda 1,u ~5 / ldb $0801,u ~8 / lsrb ~2 / rora ~2 /
    // cmpa <$D8 ~4 / bcs ~3 / cmpa <$D7 ~4 / bcc ~3
    const lo8 = yield* rd(s, u + 1, 5);
    const hib = yield* rd(s, u + 0x0801, 8);
    s.charge(2); s.charge(2);
    const hx = half9(hib, lo8);
    const d8 = yield* rd(s, 0x10d8, 4);
    s.charge(3);
    if (hx < d8) continue;
    const d7 = yield* rd(s, 0x10d7, 4);
    s.charge(3);
    if (hx >= d7) continue;
    // $E781: lda #$40 ~2 / ora ,x ~4 / sta ,x ~4
    s.charge(2);
    const o = yield* rd(s, x, 4);
    yield* wr(s, x, 0x40 | o, 4);
    yield* animateCaught(s, u);
    // $E7E0: lda $1600 ~5 / sta ,u ~4 / jmp $E74B ~4
    const py = yield* rd(s, 0x1600, 5);
    yield* wr(s, u, py, 4);
    s.charge(4);
  }
  yield* nextTask(s);
}

/**
 * sub_E7ED ($E7ED): the capture sub-state machine: jump through
 * tbl_E7F5[$10DA] (sub_E8B0, sub_E8D7, sub_E7FF, sub_E934, sub_E9E8).
 * @see gaplus-sub.asm $E7ED
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E7ED(m) {
  const s = m.sub;
  // $E7ED: ldx #$E7F5 ~3 / lda <$DA ~4 / asla ~2 / jmp [a,x] ~7 (the
  // table is ROM: $E7F5 +- 128)
  s.charge(3);
  const a = ((yield* rd(s, 0x10da, 4)) << 1) & 0xff;
  s.charge(2); s.charge(7);
  yield* call(subAt(s.read16(disp8(0xe7f5, a))), m);
}

/**
 * sub_E7FF ($E7FF): state 2: <$D7 = halved $1693/$1E93, <$D8 moved 3
 * down unless that goes below $70; every formation slot with bit 1 set
 * within Y +8/-7 of the player and inside the X window is caught (Y
 * pinned to the player's, bit 6 set, animation stepped). Next task.
 * @see gaplus-sub.asm $E7FF
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E7FF(m) {
  const s = m.sub;
  // $E7FF: lda $1E93 ~5 / ldb $1693 ~5 / lsra / rorb / stb <$D7 ~4
  const h = yield* rd(s, 0x1e93, 5);
  const l = yield* rd(s, 0x1693, 5);
  s.charge(2); s.charge(2);
  yield* wr(s, 0x10d7, half9(h, l), 4);
  // $E809: lda <$D8 ~4 / suba #$03 ~2 / cmpa #$70 ~2 / bcs ~3 /
  // sta <$D8 ~4
  const d8 = ((yield* rd(s, 0x10d8, 4)) - 0x03) & 0xff;
  s.charge(2); s.charge(2); s.charge(3);
  if (d8 >= 0x70) yield* wr(s, 0x10d8, d8, 4);
  // $E813: ldx #$185F ~3 / ldu #$162E ~3
  s.charge(3); s.charge(3);
  let x = 0x185f;
  let u = 0x162e;
  for (;;) {
    // $E819: leau 2,u / leax 1,x / lda ,x / cmpx #$188A / lbeq /
    // anda #$02 / beq (as $E74B)
    s.charge(5); s.charge(5);
    u += 2;
    x += 1;
    const f = yield* rd(s, x, 4);
    s.charge(4);
    if (x === 0x188a) { s.charge(6); break; }
    s.charge(5); s.charge(2); s.charge(3);
    if ((f & 0x02) === 0) continue;
    // $E82A: lda $1600 ~5 / adda #$08 ~2 / cmpa ,u ~4 / bcs ~3 /
    // suba #$0F ~2 / cmpa ,u ~4 / bcc ~3
    const a = ((yield* rd(s, 0x1600, 5)) + 0x08) & 0xff;
    s.charge(2);
    const c1 = yield* rd(s, u, 4);
    s.charge(3);
    if (a < c1) continue;
    s.charge(2);
    const c2 = yield* rd(s, u, 4);
    s.charge(3);
    if (((a - 0x0f) & 0xff) >= c2) continue;
    // $E839: lda 1,u / ldb $0801,u / lsrb / rora / cmpa <$D8 / bcs /
    // cmpa <$D7 / bcc (as $E771)
    const lo8 = yield* rd(s, u + 1, 5);
    const hib = yield* rd(s, u + 0x0801, 8);
    s.charge(2); s.charge(2);
    const hx = half9(hib, lo8);
    const e8 = yield* rd(s, 0x10d8, 4);
    s.charge(3);
    if (hx < e8) continue;
    const d7 = yield* rd(s, 0x10d7, 4);
    s.charge(3);
    if (hx >= d7) continue;
    // $E849: lda $1600 ~5 / sta ,u ~4 / lda #$40 ~2 / ora ,x ~4 /
    // sta ,x ~4
    const py = yield* rd(s, 0x1600, 5);
    yield* wr(s, u, py, 4);
    s.charge(2);
    const o = yield* rd(s, x, 4);
    yield* wr(s, x, 0x40 | o, 4);
    yield* animateCaught(s, u);
    // $E8AD: jmp $E819 ~4
    s.charge(4);
  }
  yield* nextTask(s);
}

/**
 * sub_E8B0 ($E8B0): state 0: <$D8 = $1E93 >> 1. ROM bug reproduced: the
 * `lsra / rorb` pair halves the 9-bit $1E93:$1693, but the code then
 * stores A (`sta <$D8`), i.e. just bit 8 shifted out -- always 0 when
 * $1E93 is 0 or 1. Next task.
 * @see gaplus-sub.asm $E8B0
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E8B0(m) {
  const s = m.sub;
  // lda $1E93 ~5 / ldb $1693 ~5 (read, then only rotated) / lsra ~2 /
  // rorb ~2 / sta <$D8 ~4
  const a = yield* rd(s, 0x1e93, 5);
  yield* rd(s, 0x1693, 5);
  s.charge(2); s.charge(2);
  yield* wr(s, 0x10d8, a >> 1, 4);
  yield* nextTask(s);
}

/**
 * sub_E8D7 ($E8D7): state 1: every caught formation slot (bit 6) gets
 * flag 1 and its sprite ($0E30+2n, frame nibble cleared, in the three
 * banks) copied to the next of the six slots at $0EC2-$0ECD; once those
 * are full, further caught slots just lose bit 6. Then $10DA += 2.
 * @see gaplus-sub.asm $E8D7
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E8D7(m) {
  const s = m.sub;
  // $E8D7: ldy #$0EC2 ~4 / ldx #$185F ~3 / ldb #$FE ~2
  s.charge(4); s.charge(3); s.charge(2);
  let y = 0x0ec2;
  let x = 0x185f;
  let b = 0xfe;
  for (;;) {
    // $E8E0: leax 1,x ~5 / addb #$02 ~2 / lda ,x ~4 / cmpx #$188A ~4 /
    // beq ~3 / anda #$40 ~2 / beq ~3
    s.charge(5); s.charge(2);
    x += 1;
    b = (b + 2) & 0xff;
    const f = yield* rd(s, x, 4);
    s.charge(4); s.charge(3);
    if (x === 0x188a) break;
    s.charge(2); s.charge(3);
    if ((f & 0x40) === 0) continue;
    // $E8EF: cmpy #$0ECE ~5 / beq $E92C ~3
    s.charge(5); s.charge(3);
    if (y === 0x0ece) {
      // $E92C: lda #$BF ~2 / anda ,x ~4 / sta ,x ~4 / bra ~3
      s.charge(2);
      const o = yield* rd(s, x, 4);
      yield* wr(s, x, 0xbf & o, 4);
      s.charge(3);
      continue;
    }
    // $E8F5: lda #$01 ~2 / sta ,x ~4 / ldu #$0E30 ~3 / leau b,u ~5
    s.charge(2);
    yield* wr(s, x, 0x01, 4);
    s.charge(3); s.charge(5);
    let u = disp8(0x0e30, b);
    // $E8FE: clr $1000,y ~10 / lda $0800,u ~8 / sta $0800,y ~8 /
    // lda ,u+ ~6 / anda #$F0 ~2 / sta ,y+ ~6
    yield* rmw(s, y + 0x1000, CLR, 10);
    yield* wr(s, y + 0x0800, yield* rd(s, u + 0x0800, 8), 8);
    const v = yield* rd(s, u, 6);
    u += 1;
    s.charge(2);
    yield* wr(s, y, v & 0xf0, 6);
    y += 1;
    // $E910: the second byte in all three banks (~8 each, ,u+/,y+ ~6)
    yield* wr(s, y + 0x1000, yield* rd(s, u + 0x1000, 8), 8);
    yield* wr(s, y + 0x0800, yield* rd(s, u + 0x0800, 8), 8);
    yield* wr(s, y, yield* rd(s, u, 6), 6);
    y += 1;
    // $E924: bra $E8E0 ~3
    s.charge(3);
  }
  // $E926: inc <$DA ~6 / inc <$DA ~6 / bra $E8BA ~3
  yield* rmw(s, 0x10da, INC, 6);
  yield* rmw(s, 0x10da, INC, 6);
  s.charge(3);
  yield* nextTask(s);
}

/**
 * Y offsets from the player of the six captured sprites, $E943-$E9CD.
 */
const E934_OFFSETS = [0x10, 0xf0, 0x20, 0xe0, 0x30, 0xd0];

/**
 * sub_E934 ($E934): state 3: move each of the six captured sprites
 * ($16C2+2n, in use while $1EC3+2n bit 7 is set, stopping at the first
 * free one) one step toward the player's Y + offset; when none had to
 * move, $10DA + 1. Next task.
 * @see gaplus-sub.asm $E934
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E934(m) {
  const s = m.sub;
  // $E934: ldb #$06 ~2 / ldx #$16C2 ~3
  s.charge(2); s.charge(3);
  let b = 6;
  for (let k = 0; k < 6; k += 1) {
    const x = 0x16c2 + 2 * k;
    // lda $0801,x ~8 / anda #$80 ~2 / beq $E9DD (~3; the first is an
    // lbeq ~5/6)
    const f = yield* rd(s, x + 0x0801, 8);
    s.charge(2);
    const free = (f & 0x80) === 0;
    s.charge(k === 0 ? (free ? 6 : 5) : 3);
    if (free) break;
    // lda $1600 ~5 / adda #off ~2 / cmpa ,x++ ~7 / beq ~3 / bcs ~3, then
    // inc -2,x ~7 + decb ~2 (either order) + bra ~3, or decb ~2 +
    // dec -2,x ~7
    const a = ((yield* rd(s, 0x1600, 5)) + E934_OFFSETS[k]) & 0xff;
    s.charge(2);
    const v = yield* rd(s, x, 7);
    s.charge(3);
    if (a === v) continue;
    s.charge(3);
    b -= 1;
    if (a < v) {
      s.charge(2);
      yield* rmw(s, x, DEC, 7);
    } else {
      // $E99F / $E9D5 (offsets $E0 and $D0) do decb before the inc
      if (k === 3 || k === 5) s.charge(2);
      yield* rmw(s, x, INC, 7);
      if (!(k === 3 || k === 5)) s.charge(2);
      s.charge(3);
    }
  }
  // $E9DD: cmpb #$06 ~2 / lbne $E8BA ~5/6 / inc <$DA ~6 / jmp $E8BA ~4
  s.charge(2 + (b !== 6 ? 6 : 5));
  if (b === 6) {
    yield* rmw(s, 0x10da, INC, 6);
    s.charge(4);
  }
  yield* nextTask(s);
}

/**
 * sub_E9E8 ($E9E8): state 4: <$1A = $30; each captured sprite in use
 * ($1EC3+2n bit 7) moves in X: while bit 0 is clear, $16C3+2n + 1 until
 * it carries (then bit 0 set); after that, + 1 until it equals the
 * player's X ($1601). When nothing moved: states and $10D9/$1111/$10E9
 * cleared, and dual_fighter ($10DB) = 1 if one of the first five
 * sprites is still in use. Next task.
 * @see gaplus-sub.asm $E9E8
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E9E8(m) {
  const s = m.sub;
  // $E9E8: ldx #$16C1 ~3 / clrb ~2 / lda #$30 ~2 / sta <$1A ~4
  s.charge(3); s.charge(2); s.charge(2);
  yield* wr(s, 0x101a, 0x30, 4);
  let b = 0;
  let x = 0x16c1;
  for (;;) {
    // $E9F0: leax 2,x ~5 / cmpx #$16CF ~4 / beq ~3
    s.charge(5); s.charge(4); s.charge(3);
    x += 2;
    if (x === 0x16cf) break;
    // $E9F7: lda $0800,x ~8 / anda #$80 ~2 / beq ~3
    const f = yield* rd(s, x + 0x0800, 8);
    s.charge(2); s.charge(3);
    if ((f & 0x80) === 0) continue;
    // $E9FF: lda $0800,x ~8 / anda #$01 ~2 / bne $EA1E ~3
    const g = yield* rd(s, x + 0x0800, 8);
    s.charge(2); s.charge(3);
    if ((g & 0x01) === 0) {
      // $EA07: incb ~2 / lda ,x ~4 / adda #$01 ~2 / sta ,x ~4 /
      // lbcc ~5/6 / lda $0800,x ~8 / ora #$01 ~2 / sta $0800,x ~8 /
      // bra ~3
      s.charge(2);
      b += 1;
      const v = yield* rd(s, x, 4);
      s.charge(2);
      yield* wr(s, x, (v + 1) & 0xff, 4);
      if (v !== 0xff) { s.charge(6); continue; }
      s.charge(5);
      const h = yield* rd(s, x + 0x0800, 8);
      s.charge(2);
      yield* wr(s, x + 0x0800, h | 0x01, 8);
      s.charge(3);
    } else {
      // $EA1E: lda ,x ~4 / cmpa $1601 ~5 / beq ~3 / inc ,x ~6 /
      // incb ~2 / bra ~3
      const v = yield* rd(s, x, 4);
      const p = yield* rd(s, 0x1601, 5);
      s.charge(3);
      if (v === p) continue;
      yield* rmw(s, x, INC, 6);
      s.charge(2); s.charge(3);
      b += 1;
    }
  }
  // $EA2A: cmpb #$00 ~2 / bne $EA49 ~3
  s.charge(2); s.charge(3);
  if (b === 0) {
    // $EA2E: clr <$DA ~6 / clr <$D9 ~6 / clr $1111 ~7 / clr <$E9 ~6
    yield* rmw(s, 0x10da, CLR, 6);
    yield* rmw(s, 0x10d9, CLR, 6);
    yield* rmw(s, 0x1111, CLR, 7);
    yield* rmw(s, 0x10e9, CLR, 6);
    // $EA37: ldx #$1EC3 ~3 / ldb #$06 ~2, then lda ,x++ ~7 / decb ~2 /
    // beq ~3 / anda #$80 ~2 / beq ~3 -- the DECB comes before the test,
    // so only the first five of the six entries are tested (the sixth
    // is read, then ignored); lda #$01 ~2 / sta <$DB ~4
    s.charge(3); s.charge(2);
    for (let n = 6, p = 0x1ec3; ; p += 2) {
      const a = yield* rd(s, p, 7);
      n -= 1;
      s.charge(2); s.charge(3);
      if (n === 0) break;
      s.charge(2); s.charge(3);
      if ((a & 0x80) !== 0) {
        s.charge(2);
        yield* wr(s, 0x10db, 0x01, 4); // dual_fighter
        break;
      }
    }
  }
  // $EA49: jmp $E8BA ~4
  s.charge(4);
  yield* nextTask(s);
}

// --------------------------------------------------- formation refill

/**
 * sub_EA4C ($EA4C): on even frames, while a refill is due ($10F8 with
 * $1071 > 0, or already running: $10FC), fly a sprite in ($0F1E, path
 * from dat_EB2C[stage & 7][$1071], animated from dat_F0C1 by $10FC);
 * at step $17 arm 4 placements ($10FD); at step $18, every 4th call,
 * put one enemy into the first empty formation slot (bit 0) from
 * frame_counter & $3F mod $27 on (flag $82, position from dat_EB2C,
 * target from dat_EB8C at $1800+2n); after the 4th: refill over,
 * $1071 - 1. Next task.
 *
 * When no formation slot is empty the ROM's slot search (`clrb / bra
 * $EACA` at $EB29) spins forever, and only the main CPU can end it by
 * changing $1860-$1889. The port runs that loop pass by pass exactly as
 * the ROM (every pass charged, every read SYNC'd, so the scheduler
 * interleaves it with the main CPU as MAME does) and yields BUSY after
 * each fruitless pass that started at slot 0: a timing point (the pass
 * was charged), and a hook for tests to free a slot.
 * @see gaplus-sub.asm $EA4C
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EA4C(m) {
  const s = m.sub;
  // $EA4C: lda <$16 ~4 / anda #$01 ~2 / lbne $EAA9 ~5/6 -- odd frames
  const fr = yield* rd(s, 0x1016, 4);
  s.charge(2);
  if ((fr & 0x01) !== 0) { s.charge(6); yield* nextTask(s); return; }
  s.charge(5);
  // $EA54: lda <$FC ~4 / bne $EA64 ~3
  const fc0 = yield* rd(s, 0x10fc, 4);
  s.charge(3);
  if (fc0 === 0) {
    // $EA58: lda <$F8 ~4 / lbeq ~5/6 / lda <$71 ~4 / lbeq ~5/6
    const f8 = yield* rd(s, 0x10f8, 4);
    if (f8 === 0) { s.charge(6); yield* nextTask(s); return; }
    s.charge(5);
    const n71 = yield* rd(s, 0x1071, 4);
    if (n71 === 0) { s.charge(6); yield* nextTask(s); return; }
    s.charge(5);
  }
  // $EA64: lda <$FC ~4 / beq $EA73 ~3
  const fc = yield* rd(s, 0x10fc, 4);
  s.charge(3);
  if (fc === 0) {
    // $EA73: lda #$01 ~2 / sta $084C ~5 / lda <$35 ~4 / anda #$07 ~2 /
    // asla ~2 / ldx #$EB2C ~3 / ldx a,x ~6 / lda <$71 ~4 / asla ~2 /
    // ldd a,x ~6 / std $171E ~6 / ldd #$4080 ~3 / std $1F1E ~6 /
    // ldd #$4010 ~3
    s.charge(2);
    yield* wr(s, 0x084c, 0x01, 5);
    const st = ((yield* rd(s, 0x1035, 4)) & 0x07) << 1; // stage
    s.charge(2); s.charge(2); s.charge(3);
    const path = yield* rd16(s, disp8(0xeb2c, st), 6);
    const i = ((yield* rd(s, 0x1071, 4)) << 1) & 0xff;
    s.charge(2);
    yield* wr16(s, 0x171e, yield* rd16(s, disp8(path, i), 6), 6);
    s.charge(3);
    yield* wr16(s, 0x1f1e, 0x4080, 6);
    s.charge(3);
    yield* flyIn(s, 0x4010);
    return;
  }
  // $EA68: asla ~2 / cmpa #$2E ~2 / beq $EAAE ~3
  const a = (fc << 1) & 0xff;
  s.charge(2); s.charge(2); s.charge(3);
  if (a === 0x2e) {
    // $EAAE: inc <$FC ~6 / lda #$04 ~2 / sta <$FD ~4 / bra ~3
    yield* rmw(s, 0x10fc, INC, 6);
    s.charge(2);
    yield* wr(s, 0x10fd, 0x04, 4);
    s.charge(3);
    yield* nextTask(s);
    return;
  }
  // $EA6D: cmpa #$30 ~2 / beq $EAB6 ~3
  s.charge(2); s.charge(3);
  if (a !== 0x30) {
    // $EA71: bra ~3 / $EA9B: ldx #$F0C1 ~3 / suba #$02 ~2 / ldd a,x ~6 /
    // bne $EA93 ~3 / clr $1F1F ~7 / bra ~3
    s.charge(3); s.charge(3); s.charge(2);
    const d = yield* rd16(s, disp8(0xf0c1, (a - 2) & 0xff), 6);
    s.charge(3);
    if (d === 0) {
      yield* rmw(s, 0x1f1f, CLR, 7);
      s.charge(3);
    }
    yield* flyIn(s, d);
    return;
  }
  // $EAB6: inc <$FF ~6 / lda <$FF ~4 / cmpa #$04 ~2 / bne ~3
  yield* rmw(s, 0x10ff, INC, 6);
  const ff = yield* rd(s, 0x10ff, 4);
  s.charge(2); s.charge(3);
  if (ff !== 0x04) { yield* nextTask(s); return; }
  // $EABE: clr <$FF ~6 / ldb <$16 ~4 / andb #$3F ~2 / cmpb #$27 ~2 /
  // bcs ~3 / subb #$27 ~2
  yield* rmw(s, 0x10ff, CLR, 6);
  let b = (yield* rd(s, 0x1016, 4)) & 0x3f;
  s.charge(2); s.charge(2); s.charge(3);
  if (b >= 0x27) { b -= 0x27; s.charge(2); }
  for (;;) {
    // $EACA: ldx #$1860 ~3 / ldu #$1630 ~3 / leax b,x ~5 / aslb ~2 /
    // leau b,u ~5
    s.charge(3); s.charge(3); s.charge(5); s.charge(2); s.charge(5);
    let x = disp8(0x1860, b);
    let u = disp8(0x1630, (b << 1) & 0xff);
    for (;;) {
      // $EAD5: lda ,x ~4 / anda #$01 ~2 / beq $EB20 ~3
      const f = yield* rd(s, x, 4);
      s.charge(2); s.charge(3);
      if ((f & 0x01) !== 0) {
        yield* placeEnemy(s, x, u);
        return;
      }
      // $EB20: leau 2,u ~5 / leax 1,x ~5 / cmpx #$188A ~4 / bne ~3
      s.charge(5); s.charge(5); s.charge(4); s.charge(3);
      u = (u + 2) & 0xffff;
      x = (x + 1) & 0xffff;
      if (x === 0x188a) break;
    }
    // $EB29: clrb ~2 / bra $EACA ~3 -- search again from slot 0. A pass
    // that already started at slot 0 found nothing: the loop now spins
    // until the main CPU frees a slot (see the JSDoc).
    s.charge(2); s.charge(3);
    if (b === 0) yield BUSY;
    b = 0;
  }
}

/**
 * $EA93: `std $0F1E ~6 / inc <$FC ~6 / jmp $EAA9 ~4`, then the task's
 * `inc <$7A / jmp task_dispatch_sub`.
 * @param {CpuView} s @param {number} d @returns {Task}
 */
function* flyIn(s, d) {
  yield* wr16(s, 0x0f1e, d, 6);
  yield* rmw(s, 0x10fc, INC, 6);
  s.charge(4);
  yield* nextTask(s);
}

/**
 * $EADB-$EB1D: put an enemy into the empty formation slot at `x`
 * (`u` = $1630 + 2n), then count down the placements; task ends.
 * @param {CpuView} s @param {number} x @param {number} u @returns {Task}
 */
function* placeEnemy(s, x, u) {
  // $EADB: lda #$82 ~2 / sta ,x ~4
  s.charge(2);
  yield* wr(s, x, 0x82, 4);
  // $EADF: lda <$35 ~4 / anda #$07 ~2 / asla ~2 / ldy #$EB8C ~4 /
  // ldy a,y ~7 / lda <$71 ~4 / asla ~2 / ldd a,y ~6 /
  // std $01D0,u ~9 -- the target, at $1800+2n
  const st = ((yield* rd(s, 0x1035, 4)) & 0x07) << 1; // stage
  s.charge(2); s.charge(2); s.charge(4);
  const tgt = yield* rd16(s, disp8(0xeb8c, st), 7);
  const i = ((yield* rd(s, 0x1071, 4)) << 1) & 0xff;
  s.charge(2);
  const d1 = yield* rd16(s, disp8(tgt, i), 6);
  yield* wr16(s, (u + 0x01d0) & 0xffff, d1, 9);
  // $EAF4: the same from dat_EB2C: the position, std ,u ~5
  const st2 = ((yield* rd(s, 0x1035, 4)) & 0x07) << 1;
  s.charge(2); s.charge(2); s.charge(4);
  const pos = yield* rd16(s, disp8(0xeb2c, st2), 7);
  const i2 = ((yield* rd(s, 0x1071, 4)) << 1) & 0xff;
  s.charge(2);
  const d2 = yield* rd16(s, disp8(pos, i2), 6);
  yield* wr16(s, u, d2, 5);
  // $EB07: lda #$80 ~2 / sta $0801,u ~8
  s.charge(2);
  yield* wr(s, (u + 0x0801) & 0xffff, 0x80, 8);
  // $EB0D: dec <$FD ~6 / bne ~3 / clr <$F8 ~6 / clr <$FC ~6 /
  // lda <$71 ~4 / lbeq ~5/6 / dec <$71 ~6 / jmp $EAA9 ~4
  const left = yield* rmw(s, 0x10fd, DEC, 6);
  s.charge(3);
  if (left === 0) {
    yield* rmw(s, 0x10f8, CLR, 6);
    yield* rmw(s, 0x10fc, CLR, 6);
    const n = yield* rd(s, 0x1071, 4);
    if (n === 0) {
      s.charge(6);
    } else {
      s.charge(5);
      yield* rmw(s, 0x1071, DEC, 6);
      s.charge(4);
    }
  }
  yield* nextTask(s);
}

/**
 * Every routine of this file by entry address, for gp2_6.js to register
 * into SUB / SUB_AT.
 * @type {Record<number, Function>}
 */
export const ROUTINES = {
  0xe5aa: sub_E5AA,
  0xe5b8: sub_E5B8,
  0xe654: sub_E654,
  0xe729: sub_E729,
  0xe7ed: sub_E7ED,
  0xe7ff: sub_E7FF,
  0xe8b0: sub_E8B0,
  0xe8d7: sub_E8D7,
  0xe934: sub_E934,
  0xe9e8: sub_E9E8,
  0xea4c: sub_EA4C,
};

// Copyright 2026 by Moshix
/**
 * Sub CPU, ROM gp2-6.11b, $F5A5-$FA2D (registered by gp2_6.js).
 * Task convention and yields: see gp2_6.js and gp2_6_state.js; timing
 * (cycles charged, SYNC before shared accesses): gp2_6_state.js.
 *
 *   sub_F5A5  mode 4 task: stage-entry sprite sequence, then next mode
 *             (CWAIs once at the end of the sequence)
 *   sub_F60B  mode 5 task: the same kind of sequence, driven by the
 *             score-parity check, dispatching through tbl_F62B to
 *   sub_F6C7 / sub_F6D9 / sub_F72C / sub_F75D / sub_F79D
 *   sub_F844  modes 3-5 task: formation members at Y $A0/$C0 launch a
 *             shot sprite (once per member, flags at $1A10)
 *   sub_F8C9  shot velocity from the table picked by stage and Y
 *
 * Every routine is a generator and charges each instruction's cycles
 * (the counts are quoted as `~n` after the instructions); the tasks'
 * closing `jmp task_dispatch_sub` (4) is charged too.
 */

import { subAt } from './routines.js';
import { call } from '../call.js';
import { disp8 } from '../m6809ops.js';
import { rd, rd16, wr, wr16, rmw, INC, CLR } from './gp2_6_state.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {import('../../machine/machine.js').CpuView} CpuView */
/** @typedef {Generator<unknown, void, unknown>} Task */

/**
 * lF6D4 / lF5F9 / lF884: `inc <$7A` ~6 / `jmp task_dispatch_sub` ~4.
 * @param {CpuView} s @returns {Task}
 */
function* nextTask(s) {
  yield* rmw(s, 0x107a, INC, 6); // sub_task
  s.charge(4);
}

/**
 * The score-parity bit: `lda score_p1+1` ~5 / `eora score_p2+1` ~5 /
 * `anda #$01` ~2.
 * @param {CpuView} s @returns {Generator<unknown, number, unknown>}
 */
function* parity(s) {
  const a = yield* rd(s, 0x09b1, 5);
  const b = yield* rd(s, 0x09b4, 5);
  s.charge(2);
  return (a ^ b) & 0x01;
}

/**
 * lF5BC / lF653: store D into sprite slot $0F1E/$0F20, copy $1B54/$1B56
 * into the $171E/$1720 bank, `inc <$18`; then the `jmp` (~4) to the
 * next-task tail and the tail itself.
 * @param {CpuView} s @param {number} d @returns {Task}
 */
function* setEntrySprites(s, d) {
  yield* wr16(s, 0x0f1e, d, 6);
  yield* wr16(s, 0x0f20, d, 6);
  yield* wr16(s, 0x171e, yield* rd16(s, 0x1b54, 6), 6);
  yield* wr16(s, 0x1720, yield* rd16(s, 0x1b56, 6), 6);
  yield* rmw(s, 0x1018, INC, 6);
  s.charge(4); // jmp lF5F9 / jmp lF6D4
  yield* nextTask(s);
}

// ------------------------------------------------------------ sub_F5A5

/**
 * sub_F5A5 ($F5A5), mode 4 task. Step counter $1018: 0 puts the two
 * sprites at $0F1E/$0F20 up ($4010, attributes $4080); each later step
 * takes the next word of dat_F0C1 (A = 2*step - 2, signed offset) until a
 * $0000 word ends the sequence (sprites' $1F1F/$1F21 cleared, formation
 * flags $188A (and $188B if $106F) = 0, $1854/$1856 = $C000). When
 * 2*step is $2E (8-bit) it waits one frame (CWAI), clears frame_counter
 * and $1018, and moves to the next game mode.
 * @see gaplus-sub.asm $F5A5
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_F5A5(m) {
  const s = m.sub;
  let a = yield* rd(s, 0x1018, 4); // lda <$18
  s.charge(3); // beq lF5B0
  if (a === 0) {
    // lF5B0: ldd #$4080 ~3 / std $1F1E / std $1F20 / ldd #$4010 ~3
    s.charge(3);
    yield* wr16(s, 0x1f1e, 0x4080, 6);
    yield* wr16(s, 0x1f20, 0x4080, 6);
    s.charge(3);
    yield* setEntrySprites(s, 0x4010);
    return;
  }
  a = (a << 1) & 0xff; // $F5A9: asla (8-bit)
  s.charge(2); s.charge(2); s.charge(3); // asla / cmpa #$2E / beq lF5FE
  if (a === 0x2e) {
    // lF5FE: cwai #$EF -- wait for vblank
    s.charge(16);
    yield;
    yield* rmw(s, 0x1016, CLR, 6); // frame_counter
    yield* rmw(s, 0x1018, CLR, 6);
    yield* rmw(s, 0x102f, INC, 6); // game_mode
    yield* rmw(s, 0x107a, CLR, 6); // sub_task
    s.charge(4); // jmp task_dispatch_sub
    return;
  }
  // bra lF5D3 ~3 / ldx #$F0C1 ~3 / suba #$02 ~2 / ldd a,x (signed) ~6 /
  // bne lF5BC ~3
  s.charge(3); s.charge(3); s.charge(2);
  const d = yield* rd16(s, disp8(0xf0c1, (a - 2) & 0xff), 6);
  s.charge(3);
  if (d !== 0) {
    yield* setEntrySprites(s, d);
    return;
  }
  yield* rmw(s, 0x1f1f, CLR, 7);
  yield* rmw(s, 0x1f21, CLR, 7);
  yield* rmw(s, 0x1018, INC, 6);
  s.charge(2); // ldb #$00
  yield* wr(s, 0x188a, 0, 5); // formation_flags+42
  const f = yield* rd(s, 0x106f, 4);
  s.charge(3); // beq lF5F0
  if (f !== 0) yield* wr(s, 0x188b, 0, 5);
  s.charge(3); // ldd #$C000
  yield* wr16(s, 0x1854, 0xc000, 6);
  yield* wr16(s, 0x1856, 0xc000, 6);
  yield* nextTask(s);
}

// ------------------------------------------------------------ sub_F60B

/**
 * sub_F60B ($F60B), mode 5 task. With step $1018 = 0 it waits for the
 * score parity to differ from $1017, then (both formation flags $188A /
 * $188B bit 0 set) starts the same sprite sequence as sub_F5A5, or else
 * re-latches the parity. Steps below $17 walk dat_F0C1; the $0000 end
 * counts the used sprites at $1F27/$1F29 ($1074) and sets up the next
 * phase. Steps $17 and up (2*step - $2E) go through tbl_F62B.
 * @see gaplus-sub.asm $F60B
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_F60B(m) {
  const s = m.sub;
  let a = yield* rd(s, 0x1018, 4); // lda <$18
  s.charge(3); // bne lF61F
  if (a === 0) {
    // $F60F: parity equal to <$17: nothing to do this frame
    const p = yield* parity(s);
    const l = yield* rd(s, 0x1017, 4); // cmpa <$17
    if (p === l) {
      s.charge(6); // lbeq lF6D4 (taken)
      yield* nextTask(s);
      return;
    }
    s.charge(5);
    a = yield* rd(s, 0x1018, 4); // $F61D: lda <$18
  }
  s.charge(3); // lF61F: beq lF63B
  if (a === 0) {
    // lF63B: lda $188A / anda $188B / anda #$01 / lbeq lF6B9
    const f1 = yield* rd(s, 0x188a, 5);
    const f2 = yield* rd(s, 0x188b, 5);
    s.charge(2);
    if ((f1 & f2 & 0x01) === 0) {
      s.charge(6);
      // lF6B9: re-latch the parity, step 0, bra lF6D4
      const p = yield* parity(s);
      yield* wr(s, 0x1017, p, 4);
      yield* rmw(s, 0x1018, CLR, 6);
      s.charge(3);
      yield* nextTask(s);
      return;
    }
    s.charge(5); s.charge(3); // lbeq not taken / ldd #$4080
    yield* wr16(s, 0x1f1e, 0x4080, 6);
    yield* wr16(s, 0x1f20, 0x4080, 6);
    s.charge(3); // ldd #$4010
    yield* setEntrySprites(s, 0x4010);
    return;
  }
  // $F621: asla ~2 / suba #$2E ~2 / bcs lF66A ~3
  const a2 = (a << 1) & 0xff;
  s.charge(2); s.charge(2); s.charge(3);
  if (a2 < 0x2e) {
    // lF66A: lda <$18 / asla / ldx #$F0C1 / suba #$02 / ldd a,x (signed)
    const a3 = ((yield* rd(s, 0x1018, 4)) << 1) & 0xff;
    s.charge(2); s.charge(3); s.charge(2);
    const d = yield* rd16(s, disp8(0xf0c1, (a3 - 2) & 0xff), 6);
    s.charge(3); // bne lF653
    if (d !== 0) {
      yield* setEntrySprites(s, d);
      return;
    }
    yield* wr(s, 0x1a0b, yield* rd(s, 0x1a0a, 5), 5);
    yield* rmw(s, 0x1f1f, CLR, 7);
    yield* rmw(s, 0x1f21, CLR, 7);
    yield* rmw(s, 0x1018, INC, 6);
    // $F684: count the in-use slots from $1F27 on: ldb ,x++ / cmpx
    // #$1F2D / beq / andb #$80 / beq / inca -- the exit test comes
    // before the bit test, so $1F2B is read but never counted.
    s.charge(3); s.charge(2); // ldx #$1F27 / clra
    let x = 0x1f27;
    let n = 0;
    for (;;) {
      const b = yield* rd(s, x, 7);
      x += 2;
      s.charge(4); s.charge(3); // cmpx / beq
      if (x === 0x1f2d) break;
      s.charge(2); s.charge(3); // andb / beq
      if ((b & 0x80) === 0) break;
      n = (n + 1) & 0xff;
      s.charge(2); s.charge(3); // inca / bra
    }
    yield* wr(s, 0x1074, n, 4);
    s.charge(2); s.charge(3); // asla / ldx #$F635
    const w = yield* rd16(s, disp8(0xf635, (n << 1) & 0xff), 6);
    yield* wr16(s, 0x0e86, w, 6);
    s.charge(2);
    yield* wr(s, 0x1e86, 0x40, 5);
    s.charge(2);
    yield* wr(s, 0x188a, 0x02, 5); // formation_flags+42
    yield* wr(s, 0x188b, 0x02, 5); // formation_flags+43
    s.charge(3);
    yield* wr16(s, 0x1854, 0xa573, 6);
    yield* wr16(s, 0x1856, 0xa573, 6);
    s.charge(3); // bra lF6D4
    yield* nextTask(s);
    return;
  }
  // $F626: ldx #$F62B ~3 / jmp [a,x] ~7 -- a is a signed offset
  s.charge(3); s.charge(7);
  const target = s.read16(disp8(0xf62b, (a2 - 0x2e) & 0xff));
  yield* call(subAt(target), m);
}

/**
 * sub_F6C7 ($F6C7), tbl_F62B[0]: sprite $0E86 = dat_F635[$1074], clear
 * the animation index $101D.
 * @see gaplus-sub.asm $F6C7
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_F6C7(m) {
  const s = m.sub;
  const a = ((yield* rd(s, 0x1074, 4)) << 1) & 0xff;
  s.charge(2); s.charge(3); // asla / ldx #$F635
  yield* wr16(s, 0x0e86, yield* rd16(s, disp8(0xf635, a), 6), 6);
  yield* rmw(s, 0x101d, CLR, 6);
  yield* nextTask(s);
}

/**
 * sub_F6D9 ($F6D9), tbl_F62B[1]: animate sprite $0F2C through the
 * 24-frame table dat_F7AE[$1074] (index $101D), move it down one pixel
 * ($172D/$1F2D, 9 bits); at Y $158/$159 end the step with the sprite
 * code from dat_F635 and attributes $40.
 * @see gaplus-sub.asm $F6D9
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_F6D9(m) {
  const s = m.sub;
  s.charge(2); // lda #$01
  yield* wr(s, 0x0850, 0x01, 5);
  // $F6DE: lda <$74 / asla / ldx #$F7AE / ldx a,x / lda <$1D / asla /
  // ldd a,x -- both offsets signed
  const i74 = yield* rd(s, 0x1074, 4);
  s.charge(2); s.charge(3);
  const tbl = yield* rd16(s, disp8(0xf7ae, (i74 << 1) & 0xff), 6);
  const i1d = yield* rd(s, 0x101d, 4);
  s.charge(2);
  const d = yield* rd16(s, disp8(tbl, (i1d << 1) & 0xff), 6);
  yield* wr(s, 0x0f2c, d >> 8, 5);
  yield* wr(s, 0x1f2c, d & 0xff, 5);
  let a = ((yield* rd(s, 0x101d, 4)) + 1) & 0xff;
  s.charge(2); s.charge(2); s.charge(3); // inca / cmpa #$18 / bne
  if (a === 0x18) { a = 0; s.charge(2); }
  yield* wr(s, 0x101d, a, 4);
  // $F6FB: lda $172D / adda #$01 / sta / bcc -- carry into $1F2D
  const y = yield* rd(s, 0x172d, 5);
  s.charge(2);
  yield* wr(s, 0x172d, (y + 1) & 0xff, 5);
  s.charge(3);
  if (y === 0xff) yield* rmw(s, 0x1f2d, INC, 7);
  const h = yield* rd(s, 0x1f2d, 5);
  s.charge(2); s.charge(3);
  if ((h & 0x01) === 0) { yield* nextTask(s); return; }
  const l = yield* rd(s, 0x172d, 5);
  s.charge(2); s.charge(2); s.charge(3);
  if ((l & 0xfe) !== 0x58) { yield* nextTask(s); return; }
  yield* rmw(s, 0x1018, INC, 6);
  const a2 = ((yield* rd(s, 0x1074, 4)) << 1) & 0xff;
  s.charge(2); s.charge(3);
  yield* wr16(s, 0x0f2c, yield* rd16(s, disp8(0xf635, a2), 6), 6);
  s.charge(2);
  yield* wr(s, 0x1f2c, 0x40, 5);
  s.charge(3); // bra lF6D4
  yield* nextTask(s);
}

/**
 * sub_F72C ($F72C), tbl_F62B[2]: step $172C until it reaches
 * dat_F7A5[$1074], then copy the sprite $0F2C (all three banks) into the
 * slot dat_F7A8[$1074] and clear $1F2D.
 * @see gaplus-sub.asm $F72C
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_F72C(m) {
  const s = m.sub;
  const b = yield* rd(s, 0x1074, 4);
  s.charge(3); // ldx #$F7A5
  const a = ((yield* rd(s, 0x172c, 5)) + 1) & 0xff;
  s.charge(2); // inca
  yield* wr(s, 0x172c, a, 5);
  // $F738: cmpa b,x (X = $F7A5, signed B) ~5 / bne ~3
  const t = yield* rd(s, disp8(0xf7a5, b), 5);
  s.charge(3);
  if (a !== t) { yield* nextTask(s); return; }
  yield* rmw(s, 0x1018, INC, 6);
  // $F73E: ldx #$F7A8 / aslb / ldx b,x
  s.charge(3); s.charge(2);
  const x = yield* rd16(s, disp8(0xf7a8, (b << 1) & 0xff), 6);
  yield* wr16(s, x, yield* rd16(s, 0x0f2c, 6), 5);
  yield* wr16(s, (x + 0x0800) & 0xffff, yield* rd16(s, 0x172c, 6), 9);
  yield* wr16(s, (x + 0x1000) & 0xffff, yield* rd16(s, 0x1f2c, 6), 9);
  yield* rmw(s, 0x1f2d, CLR, 7);
  s.charge(4); // jmp lF6D4
  yield* nextTask(s);
}

/**
 * sub_F75D ($F75D), tbl_F62B[3]: if all three sprites $1F27/$1F29/$1F2B
 * have bit 0 set, mark the first free slot of $1F17-$1F1F (bit 7 clear;
 * the last one is taken unchecked) $81, clear the three, set sound
 * $0855 and give the current player a life. Then re-latch the score
 * parity in $1017. Falls into sub_F79D.
 * @see gaplus-sub.asm $F75D
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_F75D(m) {
  const s = m.sub;
  yield* rmw(s, 0x1018, INC, 6);
  // $F75F: ldx #$1F27 / lda ,x++ / anda ,x++ / anda ,x / anda #$01 / beq
  s.charge(3);
  const a1 = yield* rd(s, 0x1f27, 7);
  const a2 = yield* rd(s, 0x1f29, 7);
  const a3 = yield* rd(s, 0x1f2b, 4);
  s.charge(2); s.charge(3);
  if ((a1 & a2 & a3 & 0x01) !== 0) {
    s.charge(3); // ldx #$1F17
    let x = 0x1f17;
    for (;;) {
      // $F76F: lda ,x++ / cmpx #$1F21 / beq lF77E / anda #$80 / bne
      const a = yield* rd(s, x, 7);
      x += 2;
      s.charge(4); s.charge(3);
      if (x === 0x1f21) break;
      s.charge(2); s.charge(3);
      if ((a & 0x80) === 0) {
        s.charge(2); // lda #$81
        yield* wr(s, x - 2, 0x81, 5);
        break;
      }
    }
    yield* rmw(s, 0x1f27, CLR, 7);
    yield* rmw(s, 0x1f29, CLR, 7);
    yield* rmw(s, 0x1f2b, CLR, 7);
    s.charge(2);
    yield* wr(s, 0x0855, 0x01, 5);
    const p = yield* rd(s, 0x102d, 4); // cur_player
    s.charge(3); // beq lF7A0
    if (p === 0) {
      yield* rmw(s, 0x1104, INC, 7); // lives_p1
      s.charge(3); // bra lF793
    } else {
      yield* rmw(s, 0x1105, INC, 7); // lives_p2
    }
  }
  // lF793
  yield* wr(s, 0x1017, yield* parity(s), 4);
  yield* sub_F79D(m);
}

/**
 * sub_F79D ($F79D), tbl_F62B[4]: `jmp lF6D4`, nothing but the next task.
 * @see gaplus-sub.asm $F79D
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_F79D(m) {
  m.sub.charge(4);
  yield* nextTask(m.sub);
}

// ------------------------------------------------------------ sub_F844

/**
 * sub_F844 ($F844), task of modes 3-5 (not in attract, nor in mode 3 of
 * stage 0). Scans formation_flags $1860-$1889 for members with bit 1
 * whose position ($1631+2n: bit 0 of $1E31+2n clear, Y byte $1631+2n)
 * is $A0 or $C0; the first found launches, once (flag $1A10+n), a shot
 * sprite in the first free slot from $0ECE up to [$1064], with velocity
 * from sub_F8C9. When no member qualifies, all flags $1A10-$1A51 clear.
 * @see gaplus-sub.asm $F844
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_F844(m) {
  const s = m.sub;
  const af = yield* rd(s, 0x09f4, 5); // attract_flag
  if (af !== 0) { s.charge(6); yield* nextTask(s); return; }
  s.charge(5);
  const st = yield* rd(s, 0x1035, 4); // stage
  s.charge(3);
  if (st === 0) {
    const gm = yield* rd(s, 0x102f, 4); // game_mode
    s.charge(2);
    if (gm === 0x03) { s.charge(6); yield* nextTask(s); return; }
    s.charge(5);
  }
  s.charge(3); s.charge(2); // ldx #$185F / ldb #$FE
  let x = 0x185f;
  let b = 0xfe;
  let u = 0;
  for (;;) {
    x += 1;
    s.charge(5); s.charge(4); s.charge(3); // leax / cmpx / beq
    if (x === 0x188a) {
      // lF889: ldu #$1A10 / ldb #$42 / clr ,u+ / decb / bne
      s.charge(3); s.charge(2);
      for (let i = 0; i < 0x42; i += 1) {
        yield* rmw(s, 0x1a10 + i, CLR, 8);
        s.charge(2); s.charge(3);
      }
      s.charge(3); // bra lF884
      yield* nextTask(s);
      return;
    }
    b = (b + 2) & 0xff;
    s.charge(2);
    const f = yield* rd(s, x, 4);
    s.charge(2); s.charge(3);
    if ((f & 0x02) === 0) continue;
    u = disp8(0x1631, b); // ldu #$1631 / leau b,u (signed)
    s.charge(3); s.charge(5);
    const h = yield* rd(s, (u + 0x0800) & 0xffff, 8);
    s.charge(2); s.charge(3);
    if ((h & 0x01) !== 0) continue;
    const y = yield* rd(s, u, 4);
    s.charge(2); s.charge(3);
    if (y === 0xa0) break;
    s.charge(2); s.charge(3);
    if (y === 0xc0) break;
    s.charge(3); // bra lF85C
  }
  // lF895: leax ,u ~4 / ldu #$1A10 ~3 / lsrb ~2 / lda b,u ~5 / bne ~3
  x = u;
  s.charge(4); s.charge(3); s.charge(2);
  const fl = disp8(0x1a10, b >> 1);
  const done = yield* rd(s, fl, 5);
  s.charge(3);
  if (done !== 0) { yield* nextTask(s); return; }
  yield* rmw(s, fl, INC, 7);
  s.charge(3); // ldu #$0ECC
  u = 0x0ecc;
  for (;;) {
    // lF8A4: leau 2,u / cmpu <$64 / beq -- no free slot
    u = (u + 2) & 0xffff;
    s.charge(5);
    const end = yield* rd16(s, 0x1064, 7);
    s.charge(3);
    if (u === end) { yield* nextTask(s); return; }
    const k = yield* rd(s, (u + 0x1001) & 0xffff, 8);
    s.charge(2); s.charge(3);
    if ((k & 0x80) === 0) break;
  }
  s.charge(3); // ldd #$4E00
  yield* wr16(s, u, 0x4e00, 5);
  // $F8B8: ldd -1,x -- the byte before the member's Y, then its Y
  const yx = yield* rd16(s, (x - 1) & 0xffff, 6);
  yield* wr16(s, (u + 0x0800) & 0xffff, yx, 9);
  s.charge(3); // ldd #$0080
  yield* wr16(s, (u + 0x1000) & 0xffff, 0x0080, 9);
  s.charge(7); // bsr sub_F8C9
  yield* sub_F8C9(m, { u });
  s.charge(3); // bra lF884
  yield* nextTask(s);
}

/**
 * sub_F8C9 ($F8C9): the shot's velocity. B = min((Y + $50 - player_y)
 * low byte / 8, 20) with Y = [$0800,U]; the table is picked by X
 * [$0801,U] (< $A0, < $D0, else) and by the stage (stage 6, or
 * stage & 7 != 6: F932/F95C/F986; else F986/F9B0/F9DA); the word
 * table[B] goes to [$0C92,U]. Charges from its first instruction to the
 * RTS inclusive. No register output is consumed.
 * @see gaplus-sub.asm $F8C9
 * @param {Machine} m
 * @param {{ u: number }} regs
 * @returns {Task}
 */
export function* sub_F8C9(m, { u }) {
  const s = m.sub;
  // $F8C9: clra ~2 / ldb $0800,u ~8 / addd #$0050 ~4 / exg d,y ~8 /
  // clra ~2 / ldb player_y ~5 / coma ~2 / comb ~2 / addd #1 ~4 /
  // leay d,y ~8 / exg d,y ~8 / exg a,b ~8 -- A = low byte of
  // (Y + $50 - player_y)
  s.charge(2);
  const yv = (yield* rd(s, (u + 0x0800) & 0xffff, 8)) + 0x50;
  s.charge(4); s.charge(8); s.charge(2);
  let a = (yv - (yield* rd(s, 0x1600, 5))) & 0xff; // player_y
  for (const c of [2, 2, 4, 8, 8, 8, 2]) s.charge(c); // ... / clrb
  // lF8E3: suba #8 ~2 / bcs ~3 / incb ~2 / cmpb #$14 ~2 / bne ~3
  let b = 0;
  for (;;) {
    s.charge(2); s.charge(3);
    if (a < 8) break;
    a -= 8;
    b += 1;
    s.charge(2); s.charge(2); s.charge(3);
    if (b === 0x14) break;
  }
  const stage = yield* rd(s, 0x1035, 4);
  s.charge(2); s.charge(3); // cmpa #$06 / beq
  let alt = false;
  if (stage !== 0x06) {
    s.charge(2); s.charge(2); s.charge(3); // anda #$07 / cmpa #$06 / beq
    alt = (stage & 0x07) === 0x06;
  }
  const tabs = alt ? [0xf986, 0xf9b0, 0xf9da] : [0xf932, 0xf95c, 0xf986];
  s.charge(4); // ldy #first
  const xb = yield* rd(s, (u + 0x0801) & 0xffff, 8);
  s.charge(2); s.charge(3); // cmpa #$A0 / bcs
  let y = tabs[0];
  if (xb >= 0xa0) {
    s.charge(4); s.charge(2); s.charge(3); // ldy / cmpa #$D0 / bcs
    y = tabs[1];
    if (xb >= 0xd0) {
      s.charge(4); // ldy
      y = tabs[2];
      if (alt) s.charge(3); // bra lF910
    }
  }
  // lF910: aslb ~2 / ldd b,y ~6 / std $0C92,u ~9 / rts ~5
  s.charge(2);
  const w = yield* rd16(s, disp8(y, (b << 1) & 0xff), 6);
  yield* wr16(s, (u + 0x0c92) & 0xffff, w, 9);
  s.charge(5);
}

/**
 * Every routine of this file by entry address, for gp2_6.js to register
 * into SUB / SUB_AT.
 * @type {Record<number, Function>}
 */
export const ROUTINES = {
  0xf5a5: sub_F5A5,
  0xf60b: sub_F60B,
  0xf6c7: sub_F6C7,
  0xf6d9: sub_F6D9,
  0xf72c: sub_F72C,
  0xf75d: sub_F75D,
  0xf79d: sub_F79D,
  0xf844: sub_F844,
  0xf8c9: sub_F8C9,
};

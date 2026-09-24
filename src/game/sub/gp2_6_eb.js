// Copyright 2026 by Moshix
/**
 * Sub CPU, ROM gp2-6.11b, $EBEC-$F5A4 (registered by gp2_6.js).
 * Task convention and yields: see gp2_6.js and gp2_6_state.js.
 *
 *   sub_EBEC  mode 3 task: an escort sprite ($0F1E slot) flies in, then
 *             its wing sprites are placed from per-stage tables; when the
 *             formation is complete, game_mode + 1 (after one CWAI)
 *   sub_F0ED  reset $18C0-$18EB / $19E0-$1A0B and $184C-$1857
 *   sub_F116  mode 3 task: the same for the $0F20 slot (the counters
 *             $1116-$1118 are sub_EBEC's: this one never advances them)
 *
 * CYCLE-EXACT (gp2_6_state.js): every instruction charges its cycles, and
 * every instruction touching shared memory goes through rd/rd16/wr/
 * wr16/rmw, which yield SYNC first; each access happens with exactly
 * the cycles of the instructions before it charged. The `~n` comments
 * are the instructions' cycles. A task's count ends with its
 * `jmp task_dispatch_sub` (4).
 */

import { disp8, disp16 } from '../m6809ops.js';
import {
  rd, rd16, wr, wr16, rmw, INC, CLR,
} from './gp2_6_state.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {import('../../machine/machine.js').CpuView} CpuView */
/** @typedef {Generator<symbol|undefined, number, unknown>} NumGen */

/**
 * The per-stage table choice shared by both tasks: `a3` for stage 3,
 * `a8` for stage 8, `aList` when the stage is in the zero-terminated byte
 * list at `list`, else the word at `byLevel` indexed by $1103 * 2.
 *
 * Two instruction sequences do this, with different timing:
 * `wing` false ($EC03/$F129): ldx #a3 / lda <stage / cmpa #3 / beq /
 * ldx #a8 / cmpa #8 / beq / ldx #aList / ldu #list, loop lda ,u+ / beq /
 * cmpa <stage / beq (found) / bra; then ldx #byLevel / lda $1103 / asla /
 * ldx a,x. `wing` true ($EC94/$F1B3): the same with Y and B (ldy is 4
 * cycles), the loop `ldb ,y+ / beq / cmpb <stage / bne`, a match loads
 * `ldy #aList / bra`, and the fallback ends `ldy b,y` (7).
 * @param {CpuView} s @param {boolean} wing @param {number} a3
 * @param {number} a8 @param {number} aList @param {number} list
 * @param {number} byLevel
 * @returns {NumGen}
 */
function* stageTable(s, wing, a3, a8, aList, list, byLevel) {
  const ld = wing ? 4 : 3; // ldy # 4 / ldx # 3
  s.charge(ld); // ld #a3
  const stage = yield* rd(s, 0x1035, 4); // lda/ldb <stage
  s.charge(2); s.charge(3); // cmp #$03 / beq
  if (stage === 0x03) return a3;
  s.charge(ld + 2 + 3); // ld #a8 / cmp #$08 / beq
  if (stage === 0x08) return a8;
  s.charge(wing ? 4 : 3 + 3); // (ldx #aList) / ldu #list | ldy #list
  for (let u = list; ; u = (u + 1) & 0xffff) {
    const v = yield* rd(s, u, 6); // lda ,u+ / ldb ,y+
    s.charge(3); // beq
    if (v === 0) break;
    const st = yield* rd(s, 0x1035, 4); // cmp <stage
    s.charge(3); // beq / bne
    if (v === st) {
      if (wing) { s.charge(4); s.charge(3); } // ldy #aList / bra
      return aList;
    }
    if (!wing) s.charge(3); // bra
  }
  s.charge(ld); // ld #byLevel
  const lvl = yield* rd(s, 0x1103, 5);
  s.charge(2); // asl
  // ldx a,x (6) / ldy b,y (7): signed offset, a stray index can land
  // in RAM
  return yield* rd16(s, disp8(byLevel, (lvl << 1) & 0xff), wing ? 7 : 6);
}

/**
 * The start position ($EC2C / $F152): lda $1118 / asla / ldb player_x /
 * cmpb #$10 / bcs / cmpb #$F0 / bcc / ldd a,x -- near an edge
 * `ldd a,x / subb #$20 / bra`.
 * @param {CpuView} s @param {number} x
 * @returns {NumGen}
 */
function* startPos(s, x) {
  const a = ((yield* rd(s, 0x1118, 5)) << 1) & 0xff;
  s.charge(2); // asla
  const px = yield* rd(s, 0x1601, 5); // player_x
  s.charge(2); s.charge(3); // cmpb #$10 / bcs
  let edge = px < 0x10;
  if (!edge) {
    s.charge(2); s.charge(3); // cmpb #$F0 / bcc
    edge = px >= 0xf0;
  }
  let d = yield* rd16(s, disp8(x, a), 6); // ldd a,x
  if (edge) {
    d = (d & 0xff00) | ((d - 0x20) & 0xff);
    s.charge(2); s.charge(3); // subb #$20 / bra
  }
  return d;
}

/**
 * The wing sprite write-out ($ECC3 / $F1E2): ldb $1118 / aslb /
 * ldy b,y / ldd a,y / std $01D0,u / lda #$82 / sta ,x / ldd pos /
 * std ,u / lda #$80 / sta $0801,u.
 * @param {CpuView} s @param {number} t table @param {number} a
 * @param {number} u @param {number} x @param {number} pos $171E / $1720
 * @returns {Generator<symbol|undefined, void, unknown>}
 */
function* placeWing(s, t, a, u, x, pos) {
  const b = ((yield* rd(s, 0x1118, 5)) << 1) & 0xff;
  s.charge(2); // aslb
  const y = yield* rd16(s, disp8(t, b), 7); // ldy b,y
  const d = yield* rd16(s, disp8(y, a), 6); // ldd a,y
  yield* wr16(s, disp16(u, 0x01d0), d, 9); // std $01D0,u
  s.charge(2); // lda #$82
  yield* wr(s, x, 0x82, 4); // sta ,x
  const p = yield* rd16(s, pos, 6); // ldd $171E / $1720
  yield* wr16(s, u, p, 5); // std ,u
  s.charge(2); // lda #$80
  yield* wr(s, disp16(u, 0x0801), 0x80, 8); // sta $0801,u
}

/**
 * The frame filter ($EC6B / $F189): lda <$16 / anda #$0F / beq go /
 * cmpa #$0A / beq go / cmpa #$05 / bne out.
 * @param {CpuView} s @returns {Generator<symbol, boolean, unknown>}
 */
function* everyFifth(s) {
  const f = (yield* rd(s, 0x1016, 4)) & 0x0f; // frame_counter
  s.charge(2); s.charge(3); // anda / beq
  if (f === 0x00) return true;
  s.charge(2); s.charge(3); // cmpa #$0A / beq
  if (f === 0x0a) return true;
  s.charge(2); s.charge(3); // cmpa #$05 / bne
  return f === 0x05;
}

/**
 * sub_F0ED ($F0ED): fill $18C0-$18EB and $19E0-$1A0B (interleaved, 44
 * bytes each) with <$10, then $184C-$1853 with the words $C0E9 and
 * $1854-$1857 with $C000. No caller uses the registers it leaves.
 * Charges its cycles through the RTS (the caller charges its LBSR).
 * @see gaplus-sub.asm $F0ED
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* sub_F0ED(m) {
  const s = m.sub;
  s.charge(3); s.charge(3); // ldu #$19E0 / ldx #$18C0
  const a = yield* rd(s, 0x1010, 4); // lda <$10
  // $F0F5: sta ,x+ / sta ,u+ / cmpx #$18EC / bne
  for (let i = 0; i < 0x2c; i += 1) {
    yield* wr(s, 0x18c0 + i, a, 6);
    yield* wr(s, 0x19e0 + i, a, 6);
    s.charge(4); s.charge(3);
  }
  s.charge(3); s.charge(3); // ldd #$C0E9 / ldx #$184C
  // $F104: std ,x++ / cmpx / bne
  for (let x = 0x184c; x !== 0x1854; x += 2) {
    yield* wr16(s, x, 0xc0e9, 8);
    s.charge(4); s.charge(3);
  }
  s.charge(3); // ldd #$C000
  for (let x = 0x1854; x !== 0x1858; x += 2) {
    yield* wr16(s, x, 0xc000, 8);
    s.charge(4); s.charge(3);
  }
  s.charge(5); // rts
}

/**
 * sub_EBEC ($EBEC): mode 3 task (list entry 3). $1116 is a step counter:
 * at 0 the sprite at slot $0F1E gets its start position from a stage
 * table ($20 lower on screen if player_x is outside $10-$EF); from 1 on
 * its code/colour comes from dat_F0C1 (a zero entry clears $1F1F; step
 * 1 also sets $084C); at step $17 (A = $2E) the wing sprites are placed
 * from the stage tables, one every 5 frames, $1117 counting sprites and
 * $1118 groups; group 6 done and the formation settled -> clear the
 * counters, sub_F0ED, CWAI, game_mode + 1, sub_task = 0.
 * A generator (the CWAI at $ED16 is one bare yield).
 * @see gaplus-sub.asm $EBEC
 * @param {Machine} m
 * @returns {Generator<symbol|undefined, void, unknown>}
 */
export function* sub_EBEC(m) {
  const s = m.sub;
  let a = yield* rd(s, 0x1116, 5); // lda $1116
  s.charge(3); // beq
  /** @type {number} */
  let d;
  if (a === 0) {
    // $EC03: the start position table for this stage
    const x = yield* stageTable(s, false, 0xefc5, 0xf019, 0xf06d, 0xebfc,
      0xed1f);
    d = yield* startPos(s, x);
    // $EC3D
    yield* wr16(s, 0x171e, d, 6);
    s.charge(3); // ldd #$4080
    yield* wr16(s, 0x1f1e, 0x4080, 6);
    s.charge(3); // ldd #$4010
    d = 0x4010;
  } else {
    a = (a << 1) & 0xff; // asla
    s.charge(2); s.charge(2); s.charge(3); // asla / cmpa #$02 / beq
    if (a === 0x02) {
      s.charge(2); // $EC58: ldb #$01
      yield* wr(s, 0x084c, 0x01, 5); // stb $084C
    } else {
      s.charge(2); s.charge(3); // cmpa #$2E / beq
      if (a === 0x2e) {
        yield* wings(m);
        return;
      }
      s.charge(3); // bra $EC5D
    }
    // $EC5D: ldx #$F0C1 / suba #$02 / ldd a,x / bne $EC49 / clr $1F1F
    s.charge(3); s.charge(2);
    d = yield* rd16(s, disp8(0xf0c1, (a - 2) & 0xff), 6);
    s.charge(3); // bne
    if (d === 0) {
      yield* rmw(s, 0x1f1f, CLR, 7);
      s.charge(3); // bra
    }
  }
  // $EC49: std $0F1E / inc $1116 / jmp $ECDF
  yield* wr16(s, 0x0f1e, d, 6);
  yield* rmw(s, 0x1116, INC, 7);
  s.charge(4); // jmp $ECDF
  yield* nextTask(s);
}

/**
 * $ECDF / $F1FE: inc <sub_task / jmp task_dispatch_sub.
 * @param {CpuView} s @returns {Generator<symbol, void, unknown>}
 */
function* nextTask(s) {
  yield* rmw(s, 0x107a, INC, 6);
  s.charge(4); // jmp task_dispatch_sub
}

/**
 * sub_EBEC from $EC6B (step $17): place one wing sprite every 5 frames.
 * @param {Machine} m
 * @returns {Generator<symbol|undefined, void, unknown>}
 */
function* wings(m) {
  const s = m.sub;
  if (yield* everyFifth(s)) {
    // $EC79: ldu #$ED7F / ldb $1118 / aslb / ldu b,u / lda $1117 / asla /
    // ldu a,u / beq $ECE4
    s.charge(3);
    const b = ((yield* rd(s, 0x1118, 5)) << 1) & 0xff;
    s.charge(2);
    const t = yield* rd16(s, disp8(0xed7f, b), 6);
    const a = ((yield* rd(s, 0x1117, 5)) << 1) & 0xff;
    s.charge(2);
    const u = yield* rd16(s, disp8(t, a), 6);
    s.charge(3); // beq
    if (u !== 0) {
      yield* rmw(s, 0x1117, INC, 7);
      // $EC8D: ldx #$EDD1 / ldx b,x / ldx a,x -- the formation flag byte
      s.charge(3);
      const xt = yield* rd16(s, disp8(0xedd1, b), 6);
      const x = yield* rd16(s, disp8(xt, a), 6);
      const tt = yield* stageTable(s, true, 0xefd3, 0xf027, 0xf07b, 0xebfc,
        0xee15);
      // $ECC3 (A still the $1117 * 2 read before the inc)
      yield* placeWing(s, tt, a, u, x, 0x171e);
    } else {
      // $ECE4: lda $1118 / cmpa #$06 / beq $ED00
      const g = yield* rd(s, 0x1118, 5);
      s.charge(2); s.charge(3);
      if (g !== 0x06) {
        // group done; the next one once $186E and $186F both have bit 0
        const f = yield* rd(s, 0x186e, 5);
        const f2 = yield* rd(s, 0x186f, 5); // anda $186F
        s.charge(2); s.charge(3); // anda #$01 / beq
        if ((f & f2 & 0x01) !== 0) {
          yield* rmw(s, 0x1118, INC, 7);
          yield* rmw(s, 0x1116, CLR, 7);
          yield* rmw(s, 0x1117, CLR, 7);
          s.charge(3); // bra $ECDF
        }
      } else {
        // $ED00: lda $186E / ora $186F / anda #$02 / bne $ECDF
        const f = yield* rd(s, 0x186e, 5);
        const f2 = yield* rd(s, 0x186f, 5);
        s.charge(2); s.charge(3);
        if (((f | f2) & 0x02) === 0) {
          // all groups placed and neither flag has bit 1: next mode
          yield* rmw(s, 0x1118, CLR, 7);
          yield* rmw(s, 0x1117, CLR, 7);
          yield* rmw(s, 0x1116, CLR, 7);
          s.charge(9); // $ED13: lbsr sub_F0ED
          yield* sub_F0ED(m);
          // $ED16: cwai #$EF -- wait for vblank
          s.charge(16);
          yield;
          yield* rmw(s, 0x102f, INC, 6); // inc <game_mode
          yield* rmw(s, 0x107a, CLR, 6); // clr <sub_task
          s.charge(4); // jmp task_dispatch_sub (no inc of sub_task)
          return;
        }
      }
    }
  }
  yield* nextTask(s);
}

/**
 * sub_F116 ($F116): mode 3 task (list entry 2), the $0F20-slot twin of
 * sub_EBEC's first steps, reading the same counters $1116-$1118 but never
 * changing them (and without step 1's $084C, the INC $1117 or the
 * end-of-formation branch; it also refuses $1118 >= 7).
 * @see gaplus-sub.asm $F116
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* sub_F116(m) {
  const s = m.sub;
  let a = yield* rd(s, 0x1116, 5);
  s.charge(3); // beq
  /** @type {number} */
  let d;
  if (a === 0) {
    // $F129
    const x = yield* stageTable(s, false, 0xf4a9, 0xf4fd, 0xf551, 0xf122,
      0xf203);
    d = yield* startPos(s, x);
    // $F163
    yield* wr16(s, 0x1720, d, 6);
    s.charge(3);
    yield* wr16(s, 0x1f20, 0x4080, 6);
    s.charge(3);
    d = 0x4010;
  } else {
    a = (a << 1) & 0xff; // asla
    s.charge(2); s.charge(2); s.charge(3); // asla / cmpa #$2E / beq
    if (a === 0x2e) {
      yield* placeF116(s);
      yield* nextTask(s); // $F1FE
      return;
    }
    // $F120: bra / $F17B: ldx #$F0C1 / suba #$02 / ldd a,x / bne /
    // clr $1F21 / bra
    s.charge(3); s.charge(3); s.charge(2);
    d = yield* rd16(s, disp8(0xf0c1, (a - 2) & 0xff), 6);
    s.charge(3);
    if (d === 0) {
      yield* rmw(s, 0x1f21, CLR, 7);
      s.charge(3);
    }
  }
  // $F16F: std $0F20 / jmp $F1FE
  yield* wr16(s, 0x0f20, d, 6);
  s.charge(4);
  yield* nextTask(s);
}

/**
 * sub_F116 from $F189: one wing sprite every 5 frames.
 * @param {CpuView} s
 * @returns {Generator<symbol, void, unknown>}
 */
function* placeF116(s) {
  if (!(yield* everyFifth(s))) return;
  // $F197: ldu #$F263 / ldb $1118 / cmpb #$07 / bcc $F1FE (unsigned)
  s.charge(3);
  let b = yield* rd(s, 0x1118, 5);
  s.charge(2); s.charge(3);
  if (b >= 0x07) return;
  b = (b << 1) & 0xff;
  s.charge(2); // aslb
  const t = yield* rd16(s, disp8(0xf263, b), 6);
  const a = ((yield* rd(s, 0x1117, 5)) << 1) & 0xff;
  s.charge(2);
  const u = yield* rd16(s, disp8(t, a), 6);
  s.charge(3); // beq
  if (u === 0) return;
  s.charge(3); // ldx #$F2B5
  const xt = yield* rd16(s, disp8(0xf2b5, b), 6);
  const x = yield* rd16(s, disp8(xt, a), 6);
  const tt = yield* stageTable(s, true, 0xf4b7, 0xf50b, 0xf55f, 0xf122,
    0xf2f9);
  yield* placeWing(s, tt, a, u, x, 0x1720); // $F1E2
}

/**
 * Every routine of this file by entry address, for gp2_6.js to register
 * into SUB / SUB_AT.
 * @type {Record<number, Function>}
 */
export const ROUTINES = {
  0xebec: sub_EBEC,
  0xf0ed: sub_F0ED,
  0xf116: sub_F116,
};

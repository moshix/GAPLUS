// Copyright 2026 by Moshix
/**
 * Sub CPU, ROM gp2-6.11b, $FA2E-$FFFF (registered by gp2_6.js).
 * Task convention and yields: see gp2_6.js and gp2_6_state.js. Every
 * routine here is a task that ends in `inc <$7A / jmp task_dispatch_sub`
 * (returning), except the fall-through entries sub_FBB0-sub_FBB3 and
 * sub_FCA6-sub_FCA9, which are the tails of sub_FB77 / sub_FC6D reached
 * through their jump tables and take B and U from them.
 *
 * Cycle-exact (gp2_6_state.js): every instruction charges its cycles, and
 * every one that touches RAM yields SYNC first (through rd/wr/rmw), so
 * all routines are generators. A task's cost includes its final
 * `JMP task_dispatch_sub` (4 cycles).
 */

import { subAt } from './routines.js';
import { add16, disp8 } from '../m6809ops.js';
import { call } from '../call.js';
import { rd, rd16, wr, wr16, rmw, INC, DEC, CLR } from './gp2_6_state.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {import('../../machine/machine.js').CpuView} CpuView */
/** @typedef {Generator<symbol, void, unknown>} Task */

/**
 * The common task tail: `inc <$7A` (6) / `jmp task_dispatch_sub` (4).
 * @param {CpuView} s @returns {Task}
 */
function* next(s) {
  yield* rmw(s, 0x107a, INC, 6); // sub_task
  s.charge(4);
}

// --------------------------------------------------------------- FA2E

/**
 * sub_FA2E ($FA2E): moves the seven objects in shadow slots $0ECE-$0EDA
 * (in use when bit 7 of $1E01+n is set). X (9 bits: $1601+n and bit 0
 * of $1E01+n) advances by 2 or 3 depending on the frame parity until it
 * reaches $160 (then the slot is freed: `clr $1001,u`); Y ($1600+n)
 * moves by the signed 8.8 speed at $1B60+n/$1B61+n with $1B70+n as the
 * fraction. Then, while $1114 is 1-$32, every fifth call flips the
 * objects' sprite codes (or, for code $4710, frees the slot and counts
 * $1114 down).
 * @see gaplus-sub.asm $FA2E
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_FA2E(m) {
  const s = m.sub;
  s.charge(3); // ldu #$0ECC
  let u = 0x0ecc;
  for (;;) {
    // $FA31: leau 2,u (5) / cmpu #$0EDC (5) / beq (3)
    u += 2;
    s.charge(5); s.charge(5); s.charge(3);
    if (u === 0x0edc) break;
    // $FA39: lda $1001,u (8) / anda #$80 / beq -- slot unused
    const f = yield* rd(s, u + 0x1001, 8);
    s.charge(2); s.charge(3);
    if ((f & 0x80) === 0) continue;
    // $FA41: lda $0801,u / ldb $1001,u / lsrb / rora / suba #$B0 / bcs
    // -- the 9-bit X halved: below $B0 (X < $160) it keeps moving
    const lo = yield* rd(s, u + 0x0801, 8);
    const hi = yield* rd(s, u + 0x1001, 8);
    s.charge(2); s.charge(2); s.charge(2); s.charge(3);
    const half = ((hi & 1) << 7) | (lo >> 1);
    if (half >= 0xb0) {
      // $FA4F: clr $1001,u (10) / bra (3) -- off the edge: free
      yield* rmw(s, u + 0x1001, CLR, 10);
      s.charge(3);
    } else {
      // $FA55: lda $0801,u / ldb <$16 / andb #$01 / bne / adda #$02 /
      // bra, or adda #$03 on odd frames
      const x = yield* rd(s, u + 0x0801, 8);
      const fc = yield* rd(s, 0x1016, 4); // frame_counter
      s.charge(2); s.charge(3);
      const sum = x + ((fc & 0x01) === 0 ? 2 : 3);
      s.charge((fc & 0x01) === 0 ? 2 + 3 : 2);
      // $FA65: sta $0801,u / bcc / inc $1001,u
      yield* wr(s, u + 0x0801, sum, 8);
      s.charge(3);
      if (sum > 0xff) yield* rmw(s, u + 0x1001, INC, 10);
    }
    // $FA6F: lda $0C92,u / anda #$80 / bne -- the speed's sign
    const sp = yield* rd(s, u + 0x0c92, 8);
    s.charge(2); s.charge(3);
    if ((sp & 0x80) === 0) {
      // $FA77: fraction += speed lo; Y += speed hi + carry (adca)
      const fr = yield* rd(s, u + 0x0ca2, 8);
      const f2 = fr + (yield* rd(s, u + 0x0c93, 8));
      yield* wr(s, u + 0x0ca2, f2, 8);
      const y = yield* rd(s, u + 0x0800, 8);
      const y2 = y + (yield* rd(s, u + 0x0c92, 8)) + (f2 >> 8);
      yield* wr(s, u + 0x0800, y2, 8);
      s.charge(3); // bra
    } else {
      // $FA91: fraction -= speed lo; Y = Y - speed hi - borrow (sbca),
      // then adda #$80 -- the speed's sign bit is taken back out
      const fr = yield* rd(s, u + 0x0ca2, 8);
      const f2 = fr - (yield* rd(s, u + 0x0c93, 8));
      yield* wr(s, u + 0x0ca2, f2, 8);
      const y = yield* rd(s, u + 0x0800, 8);
      const y2 = y - (yield* rd(s, u + 0x0c92, 8)) - (f2 < 0 ? 1 : 0);
      s.charge(2); // adda #$80
      yield* wr(s, u + 0x0800, y2 + 0x80, 8);
      s.charge(3); // bra
    }
  }
  // $FAAD: lda $1114 / beq / cmpa #$33 / bcc -- only while 1..$32
  const n = yield* rd(s, 0x1114, 5);
  s.charge(3);
  if (n !== 0) {
    s.charge(2); s.charge(3);
    if (n < 0x33) {
      // $FAB6: inc $1115 / lda $1115 / cmpa #$05 / bne
      yield* rmw(s, 0x1115, INC, 7);
      const c = yield* rd(s, 0x1115, 5);
      s.charge(2); s.charge(3);
      if (c === 0x05) {
        yield* rmw(s, 0x1115, CLR, 7);
        s.charge(3); // ldx #$0ECC
        let x = 0x0ecc;
        for (;;) {
          // $FAC6: leax 2,x (5) / cmpx #$0EDC (4) / beq (3)
          x += 2;
          s.charge(5); s.charge(4); s.charge(3);
          if (x === 0x0edc) break;
          const f = yield* rd(s, x + 0x1001, 8);
          s.charge(2); s.charge(3);
          if ((f & 0x80) === 0) continue;
          // $FAD5: ldd ,x / cmpd #$4710 / beq $FAF2
          const d = yield* rd16(s, x, 5);
          s.charge(5); s.charge(3);
          if (d === 0x4710) {
            // $FAF2: clr $1000,x / clr $1001,x / std ,x ($4E00) /
            // dec $1114 / bra
            yield* rmw(s, x + 0x1000, CLR, 10);
            yield* rmw(s, x + 0x1001, CLR, 10);
            s.charge(3);
            yield* wr16(s, x, 0x4e00, 5);
            yield* rmw(s, 0x1114, DEC, 7);
            s.charge(3);
          } else {
            // $FADD: std ,x ($4010), then the code byte is overwritten
            // with $40 | (frame_counter & 7), and $1000,x = $40
            s.charge(3);
            yield* wr16(s, x, 0x4010, 5);
            const fc = yield* rd(s, 0x1016, 4); // frame_counter
            s.charge(2); s.charge(2);
            yield* wr(s, x, (fc & 0x07) | 0x40, 4);
            s.charge(2);
            yield* wr(s, x + 0x1000, 0x40, 8);
            s.charge(3);
          }
        }
      }
    }
  }
  yield* next(s);
}

// --------------------------------------------------------------- FB09

/**
 * sub_FB09 ($FB09): when $10BF is set (and then cleared), refreshes the
 * 21 formation sprite slots $0E02-$0E2A from the formation flag pairs
 * $1860-$1889: both bytes 0 -> size $A0 and shown; low bits of the first
 * byte clear -> size 0 and shown; of the second clear -> Y ($1602+n)
 * += $10, size 0 and shown; otherwise the slot is hidden (`clr $1001,x`).
 * The size byte ($1E02+n) is only written when it changes.
 * @see gaplus-sub.asm $FB09
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_FB09(m) {
  const s = m.sub;
  const f = yield* rd(s, 0x10bf, 4);
  s.charge(3);
  if (f !== 0) {
    yield* rmw(s, 0x10bf, CLR, 6);
    s.charge(3); s.charge(3); // ldx #$0E02 / ldu #formation_flags
    let x = 0x0e02; // sprite_shadow_1+2
    let u = 0x1860;
    for (;;) {
      // $FB15: ldd ,u / beq / anda #$03 / beq / andb #$03 / beq
      const d = yield* rd16(s, u, 5);
      s.charge(3);
      let b = -1;
      if (d === 0) {
        s.charge(2); s.charge(3); // $FB34: ldb #$A0 / bra
        b = 0xa0;
      } else {
        s.charge(2); s.charge(3);
        if (((d >> 8) & 0x03) === 0) {
          s.charge(2); s.charge(3); // $FB38: clrb / bra
          b = 0;
        } else {
          s.charge(2); s.charge(3);
          if ((d & 0x03) === 0) {
            // $FB3B: ldb $0800,x / addb #$10 / stb $0800,x / clrb
            const y = yield* rd(s, x + 0x0800, 8);
            s.charge(2);
            yield* wr(s, x + 0x0800, y + 0x10, 8);
            s.charge(2);
            b = 0;
          } else {
            yield* rmw(s, x + 0x1001, CLR, 10); // $FB21
          }
        }
      }
      if (b >= 0) {
        // $FB46: lda #$80 / sta $1001,x / cmpb $1000,x / beq /
        // stb $1000,x / bra
        s.charge(2);
        yield* wr(s, x + 0x1001, 0x80, 8);
        const old = yield* rd(s, x + 0x1000, 8);
        s.charge(3);
        if (old !== b) {
          yield* wr(s, x + 0x1000, b, 8);
          s.charge(3);
        }
      }
      // $FB25: leax 2,x / leau 2,u / cmpu #$188A / bne
      x += 2;
      u += 2;
      s.charge(5); s.charge(5); s.charge(5); s.charge(3);
      if (u === 0x188a) break;
    }
  }
  yield* next(s);
}

// --------------------------------------------------------------- FB58

/**
 * sub_FB58 ($FB58): show ($80) or hide (0) the two sprites whose flag
 * bytes are $1E2D and $1E2F, from the low bits of formation_flags+42
 * and +43 ($188A/$188B): shown only when those bits are clear.
 * @see gaplus-sub.asm $FB58
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_FB58(m) {
  const s = m.sub;
  for (const [src, dst] of [[0x188a, 0x1e2d], [0x188b, 0x1e2f]]) {
    // lda src / ldb #$80 / anda #$03 / beq / clrb / stb dst
    const a = yield* rd(s, src, 5);
    s.charge(2); s.charge(2); s.charge(3);
    const show = (a & 0x03) === 0;
    if (!show) s.charge(2);
    yield* wr(s, dst, show ? 0x80 : 0, 5);
  }
  yield* next(s);
}

// ------------------------------------------------ FB77 and its tails

/**
 * The shared head of sub_FB77 / sub_FC6D: the three stop flags, the
 * 16-bit timer, the 64-frame tick, the lost index and the table jump.
 * Returns true when the task ended (next task done).
 * @param {Machine} m @param {number} cnt $10B0 / $10B5
 * @param {number} mode $10B4 / $10B9 @param {number} u $104A / $1042
 * @param {number} table tbl_FBA8 / tbl_FC9E @param {Function} tail3
 *   the B = 3 entry (sub_FBB0 / sub_FCA6)
 * @returns {Task}
 */
function* launchHead(m, cnt, mode, u, table, tail3) {
  const s = m.sub;
  // lda $112A / bne / lda <$FE / bne / lda <$13 / bne
  for (const [a, c] of [[0x112a, 5], [0x10fe, 4], [0x1013, 4]]) {
    const v = yield* rd(s, a, c);
    s.charge(3);
    if (v !== 0) { yield* next(s); return; }
  }
  // inc timer lo / bne / inc timer hi -- a 16-bit count, big-endian
  if ((yield* rmw(s, cnt + 2, INC, 6)) === 0) {
    s.charge(3);
    yield* rmw(s, cnt + 1, INC, 6);
  } else {
    s.charge(3);
  }
  // lda <$16 / anda #$3F / bne
  const fc = yield* rd(s, 0x1016, 4); // frame_counter
  s.charge(2); s.charge(3);
  if ((fc & 0x3f) !== 0) { yield* next(s); return; }
  yield* rmw(s, cnt, INC, 6);
  // lda cnt / anda #$60 / ldb #$04 / 4 x (lsra / decb / bne): B ends 0;
  // the shifted A is then lost to the lda of the mode byte
  yield* rd(s, cnt, 4);
  s.charge(2 + 2 + 4 * (2 + 2 + 3) + 3);
  const a = yield* rd(s, mode, 4);
  s.charge(3);
  if (a !== 0) { yield* tail3(m, { b: 0, u }); return; }
  // ldx #table / jmp [a,x] -- A is 0 here
  s.charge(3); s.charge(7);
  yield* call(subAt(s.read16(disp8(table, (a << 1) & 0xff))), m,
    { b: 0, u });
}

/**
 * sub_FB77 ($FB77): unless $112A, $10FE or $1013 is set, counts the
 * 16-bit timer $10B1:$10B2 up; every 64th frame it bumps $10B0 and goes
 * on through tbl_FBA8. ROM quirk, reproduced: `lda <$B4` overwrites the
 * index computed from $10B0 (bits 5-6), so the table jump always takes
 * entry 0 (sub_FBB3, B = 0) and a non-zero $10B4 means sub_FBB0 (B = 3):
 * the threshold is $104A or $1050, never $104C/$104E.
 * @see gaplus-sub.asm $FB77
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_FB77(m) {
  yield* launchHead(m, 0x10b0, 0x10b4, 0x104a, 0xfba8, sub_FBB0);
}

/**
 * sub_FBB0 ($FBB0): `incb`, falls into sub_FBB1.
 * @see gaplus-sub.asm $FBB0
 * @param {Machine} m @param {{ b: number, u: number }} r
 * @returns {Task}
 */
export function* sub_FBB0(m, r) {
  m.sub.charge(2);
  yield* sub_FBB1(m, { b: (r.b + 1) & 0xff, u: r.u });
}

/**
 * sub_FBB1 ($FBB1): `incb`, falls into sub_FBB2.
 * @see gaplus-sub.asm $FBB1
 * @param {Machine} m @param {{ b: number, u: number }} r
 * @returns {Task}
 */
export function* sub_FBB1(m, r) {
  m.sub.charge(2);
  yield* sub_FBB2(m, { b: (r.b + 1) & 0xff, u: r.u });
}

/**
 * sub_FBB2 ($FBB2): `incb`, falls into sub_FBB3.
 * @see gaplus-sub.asm $FBB2
 * @param {Machine} m @param {{ b: number, u: number }} r
 * @returns {Task}
 */
export function* sub_FBB2(m, r) {
  m.sub.charge(2);
  yield* sub_FBB3(m, { b: (r.b + 1) & 0xff, u: r.u });
}

/**
 * The shared tail of sub_FBB3 / sub_FCA9 (they differ in their tables,
 * wrap, and the $084D write).
 * @param {Machine} m @param {{ b: number, u: number }} r
 * @param {object} t
 * @param {number} t.timer $10B1 / $10B6
 * @param {number} t.index $10B3 / $10B8
 * @param {number} t.wrap $14 / $12
 * @param {number} t.flags dat_FC09 / dat_FCFF
 * @param {number} t.paths dat_FC59 / dat_FD47
 * @param {number} t.dest dat_FC31 / dat_FD23
 * @param {boolean} t.incSound inc $084D (FBB3) or stb $084D (FCA9)
 * @returns {Task}
 */
function* launchTail(m, r, t) {
  const s = m.sub;
  // aslb / leau b,u (signed) / ldd timer / cmpd ,u / bcs
  s.charge(2); s.charge(5);
  const u = disp8(r.u, (r.b << 1) & 0xff);
  const tm = yield* rd16(s, t.timer, 5);
  const lim = yield* rd16(s, u, 7);
  s.charge(3);
  if (tm < lim) { yield* next(s); return; }
  yield* rmw(s, t.timer, CLR, 6);
  yield* rmw(s, t.timer + 1, CLR, 6);
  let a = yield* rd(s, t.index, 4);
  s.charge(2); s.charge(3);
  if (a >= t.wrap) {
    yield* rmw(s, t.index, CLR, 6);
    s.charge(2);
    a = 0;
  }
  // ldx #flags / asla / ldb [a,x] / andb #$03 / bne
  s.charge(3); s.charge(2);
  a = (a << 1) & 0xff;
  /** @param {number} i @returns {number} flag address of entry i/2 */
  const flag = (i) => s.read16(disp8(t.flags, i));
  let fl = yield* rd(s, flag(a), 8);
  s.charge(2); s.charge(3);
  if ((fl & 0x03) !== 0) {
    // clra, then scan the entries for a free one
    s.charge(2);
    a = 0;
    for (;;) {
      fl = yield* rd(s, flag(a), 8);
      s.charge(2); s.charge(3);
      if ((fl & 0x03) === 0) break;
      a = (a + 2) & 0xff;
      s.charge(2); s.charge(2); s.charge(3);
      if (a === t.wrap * 2) {
        s.charge(3); // bra to the tail
        yield* next(s);
        return;
      }
    }
  }
  // ldb #$02 / stb [a,x]
  s.charge(2);
  yield* wr(s, flag(a), 0x02, 8);
  // ldx #paths / lsra / ldb a,x / ldu #$1052 / ldu b,u
  s.charge(3); s.charge(2);
  const b = yield* rd(s, disp8(t.paths, a >> 1), 5);
  s.charge(3);
  let ptr = yield* rd16(s, disp8(0x1052, b), 6);
  // ldb <$20 / beq / ldu #dat_DD44
  const b20 = yield* rd(s, 0x1020, 4);
  s.charge(3);
  if (b20 !== 0) { ptr = 0xdd44; s.charge(3); }
  // ldx #dest / asla / stu [a,x]
  s.charge(3); s.charge(2);
  yield* wr16(s, s.read16(disp8(t.dest, a)), ptr, 9);
  if (t.incSound) yield* rmw(s, 0x084d, INC, 7);
  else yield* wr(s, 0x084d, b20, 5); // ROM quirk: stb, B = $1020
  yield* rmw(s, t.index, INC, 6);
  yield* next(s);
}

/**
 * sub_FBB3 ($FBB3): the tail of sub_FB77. If the timer $10B1:$10B2 has
 * reached the word at U + 2B, restart it and launch the next of the 20
 * formation positions listed at dat_FC09 (index $10B3, wrapping at $14)
 * whose flag has its low bits clear, searching from the start when the
 * current one is busy: flag := 2, and the matching word of dat_FC31
 * gets the path pointer $1052/$1054 (dat_FC59), or dat_DD44 when $1020
 * is set; $084D is bumped (a sound trigger).
 * @see gaplus-sub.asm $FBB3
 * @param {Machine} m @param {{ b: number, u: number }} r B and U
 * @returns {Task}
 */
export function* sub_FBB3(m, r) {
  yield* launchTail(m, r, {
    timer: 0x10b1, index: 0x10b3, wrap: 0x14, flags: 0xfc09,
    paths: 0xfc59, dest: 0xfc31, incSound: true,
  });
}

// ------------------------------------------------ FC6D and its tails

/**
 * sub_FC6D ($FC6D): the twin of sub_FB77 for the second group
 * ($10B5-$10B9, thresholds from $1042, table tbl_FC9E). Same quirk: the
 * table jump always takes entry 0 (sub_FCA9, B = 0), a non-zero $10B9
 * sub_FCA6 (B = 3).
 * @see gaplus-sub.asm $FC6D
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_FC6D(m) {
  yield* launchHead(m, 0x10b5, 0x10b9, 0x1042, 0xfc9e, sub_FCA6);
}

/**
 * sub_FCA6 ($FCA6): `incb`, falls into sub_FCA7.
 * @see gaplus-sub.asm $FCA6
 * @param {Machine} m @param {{ b: number, u: number }} r
 * @returns {Task}
 */
export function* sub_FCA6(m, r) {
  m.sub.charge(2);
  yield* sub_FCA7(m, { b: (r.b + 1) & 0xff, u: r.u });
}

/**
 * sub_FCA7 ($FCA7): `incb`, falls into sub_FCA8.
 * @see gaplus-sub.asm $FCA7
 * @param {Machine} m @param {{ b: number, u: number }} r
 * @returns {Task}
 */
export function* sub_FCA7(m, r) {
  m.sub.charge(2);
  yield* sub_FCA8(m, { b: (r.b + 1) & 0xff, u: r.u });
}

/**
 * sub_FCA8 ($FCA8): `incb`, falls into sub_FCA9.
 * @see gaplus-sub.asm $FCA8
 * @param {Machine} m @param {{ b: number, u: number }} r
 * @returns {Task}
 */
export function* sub_FCA8(m, r) {
  m.sub.charge(2);
  yield* sub_FCA9(m, { b: (r.b + 1) & 0xff, u: r.u });
}

/**
 * sub_FCA9 ($FCA9): the tail of sub_FC6D, as sub_FBB3 for the 18
 * positions of dat_FCFF (index $10B8, wrapping at $12), the pointers
 * $1056/$1058 (dat_FD47) into dat_FD23. ROM quirk: where sub_FBB3 does
 * `inc $084D`, this one does `stb $084D` with B = $1020 (usually 0).
 * @see gaplus-sub.asm $FCA9
 * @param {Machine} m @param {{ b: number, u: number }} r B and U
 * @returns {Task}
 */
export function* sub_FCA9(m, r) {
  yield* launchTail(m, r, {
    timer: 0x10b6, index: 0x10b8, wrap: 0x12, flags: 0xfcff,
    paths: 0xfd47, dest: 0xfd23, incSound: false,
  });
}

// --------------------------------------------------------------- FD59

/**
 * sub_FD59 ($FD59): unless $112A, $10FE or $1013 is set, counts the
 * 16-bit timer $10BA:$10BB up and counts in $10BC the formation flags
 * $1860-$188A with bit 0 clear. When the timer reaches the threshold at
 * $103A + 0/2/4/6 (fewer such flags -> later entries), picks group
 * $10BD+1 (mod 4) of dat_FDE9 and launches each of its 3 positions
 * whose flag's low bits are clear (flag := 2, $084D := 2, path pointer
 * from dat_FE19 or dat_DD44 when $1020 is set into the dat_FE01 word).
 * The first position being busy skips the whole group. The timer then
 * restarts. $10BC is always cleared at the end.
 * @see gaplus-sub.asm $FD59
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_FD59(m) {
  const s = m.sub;
  // $FD59: lda $112A / lbne (5 not taken, 6 taken)
  let stop = (yield* rd(s, 0x112a, 5)) !== 0;
  s.charge(stop ? 6 : 5);
  for (const a of [0x10fe, 0x1013]) {
    if (stop) break;
    stop = (yield* rd(s, a, 4)) !== 0;
    s.charge(3);
  }
  if (!stop) {
    if ((yield* rmw(s, 0x10bb, INC, 6)) === 0) {
      s.charge(3);
      yield* rmw(s, 0x10ba, INC, 6);
    } else {
      s.charge(3);
    }
    // $FD6E: lda ,x+ / cmpx #$188C / beq -- the byte at $188B is read
    // but the loop ends before testing it
    s.charge(3); // ldx #formation_flags
    let x = 0x1860;
    for (;;) {
      const a = yield* rd(s, x, 6);
      x += 1;
      s.charge(4); s.charge(3);
      if (x === 0x188c) break;
      s.charge(2); s.charge(3);
      if ((a & 0x01) === 0) {
        yield* rmw(s, 0x10bc, INC, 6);
        s.charge(3);
      }
    }
    // $FD80: clrb / lda <$BC / cmpa #$1E,#$14,#$0A: B = 0/2/4/6
    s.charge(2);
    const c = yield* rd(s, 0x10bc, 4);
    let b = 0;
    for (const lim of [0x1e, 0x14, 0x0a]) {
      s.charge(2); s.charge(3);
      if (c >= lim) break;
      s.charge(2);
      b += 2;
    }
    // $FD95: ldu <$BA / ldx #$103A / cmpu b,x / bcs
    const t = yield* rd16(s, 0x10ba, 5);
    s.charge(3);
    const lim = yield* rd16(s, disp8(0x103a, b), 8);
    s.charge(3);
    if (t >= lim) {
      yield* rmw(s, 0x10bd, INC, 6);
      s.charge(3); s.charge(3); // ldx #dat_FDE9 / ldu #dat_FE01
      // $FDA7: (($BD & 3) << 1) * 3 via mul: 0, 6, 12 or 18
      const g = yield* rd(s, 0x10bd, 4);
      for (const c of [2, 2, 2, 11, 5, 5, 2]) s.charge(c);
      const off = ((g & 0x03) << 1) * 3;
      let px = disp8(0xfde9, off);
      let pu = disp8(0xfe01, off);
      // $FDB5: lda [,x] / anda #$03 / bne $FDDE
      const f0 = yield* rd(s, s.read16(px), 7);
      s.charge(2); s.charge(3);
      if ((f0 & 0x03) === 0) {
        for (let n = 3; n > 0; n -= 1) {
          // $FDBB: lda [,x] / anda #$03 / bne -- this one busy
          const f = s.read16(px);
          const v = yield* rd(s, f, 7);
          s.charge(2); s.charge(3);
          if ((v & 0x03) === 0) {
            // $FDC1: lda #$02 / sta [,x] / sta $084D / ldy $18,u /
            // lda <$20 / beq / ldy #dat_DD44 / sty [,u]
            s.charge(2);
            yield* wr(s, f, 0x02, 7);
            yield* wr(s, 0x084d, 0x02, 5);
            let y = yield* rd16(s, pu + 0x18, 7);
            const k = yield* rd(s, 0x1020, 4);
            s.charge(3);
            if (k !== 0) { y = 0xdd44; s.charge(4); }
            yield* wr16(s, s.read16(pu), y, 9);
          }
          // $FDD7: leax 2,x / leau 2,u / decb / bne
          px += 2;
          pu += 2;
          s.charge(5); s.charge(5); s.charge(2); s.charge(3);
        }
      }
      yield* rmw(s, 0x10ba, CLR, 6); // $FDDE
      yield* rmw(s, 0x10bb, CLR, 6);
    }
  }
  yield* rmw(s, 0x10bc, CLR, 6); // $FDE2
  yield* next(s);
}

// --------------------------------------------------------------- FE31

/**
 * sub_FE31 ($FE31): every 64th frame counts $10C0 and at set counts
 * (stage type $1070 = 1: 1 and 7, with $10C1 bumped and $10C0 reset at
 * 7; otherwise 2 and $0C, reset at $0C) or whenever $10F8 is set,
 * starts the object at formation_flags+42 ($188A) if it is idle: its
 * flag gets bit 1, the next one ($188B) bit 1 unless bit 0 is set, and
 * $084E the flag (a sound trigger). $10C1 or $10FE stop the counting.
 * @see gaplus-sub.asm $FE31
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_FE31(m) {
  const s = m.sub;
  // 0: the task ends ($FE55), 1: launch ($FE5E), 2: $FE5A then launch
  let go = 0;
  const f8 = yield* rd(s, 0x10f8, 4);
  s.charge(3);
  if (f8 !== 0) {
    go = 1;
  } else {
    let skip = false;
    for (const a of [0x10c1, 0x10fe]) {
      skip = (yield* rd(s, a, 4)) !== 0;
      s.charge(3);
      if (skip) break;
    }
    if (!skip) {
      const fc = yield* rd(s, 0x1016, 4); // frame_counter
      s.charge(2); s.charge(3);
      skip = (fc & 0x3f) !== 0;
    }
    if (!skip) {
      yield* rmw(s, 0x10c0, INC, 6);
      const st = yield* rd(s, 0x1070, 4);
      s.charge(2); s.charge(3);
      // $FE4B (stage type 1): 1 and 7; $FE76 (others): 2 and $0C
      const [first, reset] = st === 0x01 ? [0x01, 0x07] : [0x02, 0x0c];
      const c = yield* rd(s, 0x10c0, 4);
      s.charge(2); s.charge(3);
      if (c === first) {
        go = 1;
      } else {
        s.charge(2); s.charge(3);
        if (c === reset) go = 2;
        else if (st !== 0x01) s.charge(3); // $FE80: bra
      }
    }
  }
  if (go === 2) {
    yield* rmw(s, 0x10c1, INC, 6); // $FE5A
    yield* rmw(s, 0x10c0, CLR, 6);
  }
  if (go !== 0) {
    // $FE5E: lda $188A / bne / ldd $188A / ora #$02 / andb #$01 / bne /
    // orb #$02 / std $188A / sta $084E / bra
    const a0 = yield* rd(s, 0x188a, 5);
    s.charge(3);
    if (a0 === 0) {
      const d = yield* rd16(s, 0x188a, 6);
      s.charge(2); s.charge(2); s.charge(3);
      const a = ((d >> 8) | 0x02) & 0xff;
      let b = d & 0x01;
      if (b === 0) { b |= 0x02; s.charge(2); }
      yield* wr16(s, 0x188a, (a << 8) | b, 6);
      yield* wr(s, 0x084e, a, 5);
      s.charge(3);
    }
  }
  yield* next(s);
}

// --------------------------------------------------------------- FE82

/**
 * sub_FE82 ($FE82): an animation run once $101E is non-zero, or started
 * when the scores are "round" (1P: score_p1 = score_p1+1; 2P: both
 * scores equal): each call shows the next word of dat_F0C1 (index
 * $101E) as sprite $0F12, with flags $4080, and moves it by $0403 on
 * $1712; a zero word restarts the table at 1, and the carry out of the
 * $1712 add ends it for good ($1176 = done).
 *
 * ROM quirk, reproduced: when the animation is started, A still holds
 * the score byte just compared (score_p1, or score_p1+2 in 2P), not
 * $101E, so the first frame indexes dat_F0C1 with that byte (`asla /
 * ldd a,x`, a signed offset); a zero word there jumps back to $FE82.
 * @see gaplus-sub.asm $FE82
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_FE82(m) {
  const s = m.sub;
  for (;;) {
    const done = yield* rd(s, 0x1176, 5);
    s.charge(3);
    if (done !== 0) break;
    let a = yield* rd(s, 0x101e, 4);
    s.charge(3);
    if (a === 0) {
      s.charge(3); // ldd #$0040
      yield* wr16(s, 0x1712, 0x0040, 6);
      const two = yield* rd(s, 0x102e, 4); // two_players
      s.charge(3);
      const pairs = two === 0 ? [[0x09b0, 0x09b1]]
        : [[0x09b0, 0x09b3], [0x09b1, 0x09b4], [0x09b2, 0x09b5]];
      let same = true;
      for (const [p, q] of pairs) {
        // lda p / cmpa q / bne $FEE7
        a = yield* rd(s, p, 5);
        const b = yield* rd(s, q, 5);
        s.charge(3);
        if (a !== b) { same = false; break; }
      }
      if (!same) break;
      yield* rmw(s, 0x101e, INC, 6);
      if (two !== 0) s.charge(3); // $FEAF: bra
    }
    // $FEBB: ldx #dat_F0C1 / asla / ldd a,x / bne $FEC9
    s.charge(3); s.charge(2);
    const d = yield* rd16(s, disp8(0xf0c1, (a << 1) & 0xff), 6);
    s.charge(3);
    if (d === 0) {
      // $FEC3: lda #$01 / sta <$1E / bra sub_FE82
      s.charge(2);
      yield* wr(s, 0x101e, 0x01, 4);
      s.charge(3);
      continue;
    }
    yield* rmw(s, 0x101e, INC, 6); // $FEC9
    yield* wr16(s, 0x0f12, d, 6);
    s.charge(3);
    yield* wr16(s, 0x1f12, 0x4080, 6);
    // $FED4: ldd #$0403 / addd $1712 / std $1712 / bcc
    s.charge(3);
    const r = add16(0x0403, yield* rd16(s, 0x1712, 7));
    yield* wr16(s, 0x1712, r.v, 6);
    s.charge(3);
    if (r.cf) {
      yield* rmw(s, 0x101e, CLR, 6);
      yield* rmw(s, 0x1f13, CLR, 7);
      yield* rmw(s, 0x1176, INC, 7);
    }
    break;
  }
  yield* next(s);
}

/**
 * Every routine of this file by entry address, for gp2_6.js to register
 * into SUB / SUB_AT.
 * @type {Record<number, Function>}
 */
export const ROUTINES = {
  0xfa2e: sub_FA2E,
  0xfb09: sub_FB09,
  0xfb58: sub_FB58,
  0xfb77: sub_FB77,
  0xfbb0: sub_FBB0,
  0xfbb1: sub_FBB1,
  0xfbb2: sub_FBB2,
  0xfbb3: sub_FBB3,
  0xfc6d: sub_FC6D,
  0xfca6: sub_FCA6,
  0xfca7: sub_FCA7,
  0xfca8: sub_FCA8,
  0xfca9: sub_FCA9,
  0xfd59: sub_FD59,
  0xfe31: sub_FE31,
  0xfe82: sub_FE82,
};

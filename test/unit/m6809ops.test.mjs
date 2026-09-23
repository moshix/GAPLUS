// Copyright 2026 by Moshix
// Unit tests for src/game/m6809ops.js.
//
// Two independent checks:
//  1. against a straightforward reference model written here from the
//     datasheet definitions (signed/unsigned range tests instead of MAME's
//     bit tricks), exhaustively for every 8-bit operation;
//  2. against the oracle's CPU core (test/m6809/m6809.mjs) by executing
//     the real instruction, when that core is present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../../src/game/m6809ops.js';

const { CC_C, CC_V, CC_Z, CC_N, CC_H, CC_I, CC_F, CC_E } = ops;

// ------------------------------------------------------------ reference

/** Signed byte. */
const sb = (v) => (v & 0x80 ? v - 256 : v);
/** Signed word. */
const sw = (v) => (v & 0x8000 ? v - 65536 : v);

/**
 * Build a CC byte: keep the bits of `cc` not in `mask`, set the given ones.
 * @param {number} cc @param {number} mask
 * @param {{c?: boolean, v?: boolean, z?: boolean, n?: boolean, h?: boolean}} f
 */
function mk(cc, mask, f) {
  let r = cc & ~mask;
  if ((mask & CC_C) && f.c) r |= CC_C;
  if ((mask & CC_V) && f.v) r |= CC_V;
  if ((mask & CC_Z) && f.z) r |= CC_Z;
  if ((mask & CC_N) && f.n) r |= CC_N;
  if ((mask & CC_H) && f.h) r |= CC_H;
  return r & 0xff;
}

const NZVC = CC_N | CC_Z | CC_V | CC_C;

/** Reference ADD/ADC: carries from the arithmetic, V from the signed sum. */
function refAdd(a, b, cin, cc) {
  const u = a + b + cin;
  const s = sb(a) + sb(b) + cin;
  const r = u & 0xff;
  return { v: r, cc: mk(cc, NZVC | CC_H, {
    c: u > 255, v: s < -128 || s > 127, z: r === 0, n: r >= 128,
    h: (a & 15) + (b & 15) + cin > 15,
  }) };
}

/** Reference SUB/SBC/CMP: borrow from unsigned, V from signed. */
function refSub(a, b, cin, cc) {
  const u = a - b - cin;
  const s = sb(a) - sb(b) - cin;
  const r = u & 0xff;
  return { v: r, cc: mk(cc, NZVC, {
    c: u < 0, v: s < -128 || s > 127, z: r === 0, n: r >= 128,
  }) };
}

/** Reference 16-bit ADD/SUB. */
function ref16(a, b, sub, cc) {
  const u = sub ? a - b : a + b;
  const s = sub ? sw(a) - sw(b) : sw(a) + sw(b);
  const r = u & 0xffff;
  return { v: r, cc: mk(cc, NZVC, {
    c: sub ? u < 0 : u > 0xffff, v: s < -32768 || s > 32767,
    z: r === 0, n: r >= 0x8000,
  }) };
}

/** N and Z from a byte, other bits of `mask` from `f`. */
const nz = (r, cc, mask, f = {}) => mk(cc, mask, { ...f, z: r === 0, n: r >= 128 });

/**
 * Reference unary ops, one per mnemonic, from the datasheet tables.
 * @type {Record<string, (v: number, cc: number) => {v: number, cc: number}>}
 */
const REF_UNARY = {
  neg: (v, cc) => {
    const r = (256 - v) & 0xff;
    return { v: r, cc: nz(r, cc, NZVC, { c: v !== 0, v: v === 0x80 }) };
  },
  com: (v, cc) => {
    const r = v ^ 0xff;
    return { v: r, cc: nz(r, cc, NZVC, { c: true, v: false }) };
  },
  lsr: (v, cc) => {
    const r = v >>> 1;
    return { v: r, cc: nz(r, cc, CC_N | CC_Z | CC_C, { c: (v & 1) === 1 }) };
  },
  asr: (v, cc) => {
    const r = ((sb(v) >> 1) & 0xff);
    return { v: r, cc: nz(r, cc, CC_N | CC_Z | CC_C, { c: (v & 1) === 1 }) };
  },
  asl: (v, cc) => {
    const r = (v * 2) & 0xff;
    // V: the sign changed, i.e. bit 7 ^ bit 6 of the operand.
    return { v: r, cc: nz(r, cc, NZVC, { c: v >= 128, v: (v >= 128) !== (r >= 128) }) };
  },
  rol: (v, cc) => {
    const r = ((v * 2) | (cc & CC_C)) & 0xff;
    return { v: r, cc: nz(r, cc, NZVC, { c: v >= 128, v: (v >= 128) !== ((v & 0x40) !== 0) }) };
  },
  ror: (v, cc) => {
    const r = (v >>> 1) | ((cc & CC_C) ? 0x80 : 0);
    return { v: r, cc: nz(r, cc, CC_N | CC_Z | CC_C, { c: (v & 1) === 1 }) };
  },
  inc: (v, cc) => {
    const r = (v + 1) & 0xff;
    return { v: r, cc: nz(r, cc, CC_N | CC_Z | CC_V, { v: v === 0x7f }) };
  },
  dec: (v, cc) => {
    const r = (v + 255) & 0xff;
    return { v: r, cc: nz(r, cc, CC_N | CC_Z | CC_V, { v: v === 0x80 }) };
  },
  tst: (v, cc) => ({ v, cc: nz(v, cc, CC_N | CC_Z | CC_V, { v: false }) }),
  clr: (_v, cc) => ({ v: 0, cc: mk(cc, NZVC, { z: true }) }),
};

/**
 * Reference DAA, from the datasheet's correction rule written as ranges:
 * low correction when H or the low digit is not decimal; high correction
 * when C or the value is above $99. C is set if the high correction
 * applies with a carry out, and never cleared.
 */
function refDaa(a, cc) {
  let corr = 0;
  if ((cc & CC_H) || (a & 0x0f) > 9) corr += 0x06;
  if ((cc & CC_C) || a > 0x99) corr += 0x60;
  const t = a + corr;
  const r = t & 0xff;
  return { v: r, cc: nz(r, cc, CC_N | CC_Z | CC_V | CC_C,
    { v: false, c: (cc & CC_C) !== 0 || t > 0xff }) };
}

/** The CC inputs worth covering: every combination of H/N/Z/V/C + I. */
const CCS = [];
for (let i = 0; i < 32; i += 1) {
  CCS.push(((i & 1) ? CC_C : 0) | ((i & 2) ? CC_V : 0) | ((i & 4) ? CC_Z : 0)
    | ((i & 8) ? CC_N : 0) | ((i & 16) ? CC_H : 0) | CC_I);
}
CCS.push(0xff, CC_E | CC_F);

/** Compare one result and give a useful message. */
function same(got, want, what) {
  if (got.v !== want.v || got.cc !== want.cc) {
    assert.fail(`${what}: got v=$${got.v.toString(16)} cc=$${got.cc.toString(16)}`
      + ` want v=$${want.v.toString(16)} cc=$${want.cc.toString(16)}`);
  }
}

// ------------------------------------------------ exhaustive vs reference

test('add8/adc8: every a, b, carry-in (and CC bits preserved)', () => {
  for (const cc of [0, CC_C, CC_I | CC_F | CC_E, 0xff]) {
    for (let a = 0; a < 256; a += 1) {
      for (let b = 0; b < 256; b += 1) {
        same(ops.add8(a, b, cc), refAdd(a, b, 0, cc), `add8 ${a} ${b} ${cc}`);
        same(ops.adc8(a, b, cc), refAdd(a, b, cc & 1, cc), `adc8 ${a} ${b} ${cc}`);
      }
    }
  }
});

test('sub8/sbc8/cmp8: every a, b, borrow-in; H untouched', () => {
  for (const cc of [0, CC_C, CC_H, CC_H | CC_C | CC_I, 0xff]) {
    for (let a = 0; a < 256; a += 1) {
      for (let b = 0; b < 256; b += 1) {
        const want = refSub(a, b, 0, cc);
        same(ops.sub8(a, b, cc), want, `sub8 ${a} ${b} ${cc}`);
        same(ops.cmp8(a, b, cc), want, `cmp8 ${a} ${b} ${cc}`);
        same(ops.sbc8(a, b, cc), refSub(a, b, cc & 1, cc), `sbc8 ${a} ${b} ${cc}`);
      }
    }
  }
});

test('unary ops: every operand under every flag combination', () => {
  const impl = {
    neg: ops.neg8, com: ops.com8, lsr: ops.lsr8, asr: ops.asr8,
    asl: ops.asl8, rol: ops.rol8, ror: ops.ror8, inc: ops.inc8,
    dec: ops.dec8, tst: ops.tst8, clr: (_v, cc) => ops.clr8(cc),
  };
  for (const [name, ref] of Object.entries(REF_UNARY)) {
    for (const cc of CCS) {
      for (let v = 0; v < 256; v += 1) {
        same(impl[name](v, cc), ref(v, cc), `${name} ${v} cc=${cc}`);
      }
    }
  }
  assert.equal(ops.lsl8, ops.asl8);
});

test('logic ops: and/or/eor/bit clear V, keep C', () => {
  for (const cc of [0, CC_C | CC_V, 0xff]) {
    for (let a = 0; a < 256; a += 1) {
      for (let b = 0; b < 256; b += 17) {
        const m = CC_N | CC_Z | CC_V;
        same(ops.and8(a, b, cc), { v: a & b, cc: nz(a & b, cc, m) }, 'and');
        same(ops.bit8(a, b, cc), { v: a & b, cc: nz(a & b, cc, m) }, 'bit');
        same(ops.or8(a, b, cc), { v: a | b, cc: nz(a | b, cc, m) }, 'or');
        same(ops.eor8(a, b, cc), { v: a ^ b, cc: nz(a ^ b, cc, m) }, 'eor');
      }
    }
  }
});

test('daa: every A under every H/C combination', () => {
  for (const cc of CCS) {
    for (let a = 0; a < 256; a += 1) same(ops.daa(a, cc), refDaa(a, cc), `daa ${a} ${cc}`);
  }
});

test('daa: BCD addition of every pair of 2-digit numbers', () => {
  for (let x = 0; x < 100; x += 1) {
    for (let y = 0; y < 100; y += 1) {
      const bx = ((x / 10) | 0) * 16 + (x % 10);
      const by = ((y / 10) | 0) * 16 + (y % 10);
      for (const cin of [0, 1]) {
        const s = ops.adc8(bx, by, cin);
        const d = ops.daa(s.v, s.cc);
        const sum = x + y + cin;
        const want = (((sum % 100) / 10) | 0) * 16 + (sum % 10);
        assert.equal(d.v, want, `${x}+${y}+${cin}`);
        assert.equal(d.cf, sum >= 100, `carry ${x}+${y}+${cin}`);
      }
    }
  }
});

test('mul: every A, B', () => {
  for (let a = 0; a < 256; a += 1) {
    for (let b = 0; b < 256; b += 1) {
      const r = ops.mul(a, b, CC_N | CC_V | CC_H);
      const d = a * b;
      assert.equal(r.v, d);
      assert.equal(r.a, d >> 8);
      assert.equal(r.b, d & 0xff);
      const cc = (CC_N | CC_V | CC_H) | (d === 0 ? CC_Z : 0) | ((d & 0x80) ? CC_C : 0);
      assert.equal(r.cc, cc, `mul ${a} ${b}`);
    }
  }
});

test('sex: every B; V untouched', () => {
  for (const cc of [0, CC_V | CC_C]) {
    for (let b = 0; b < 256; b += 1) {
      const r = ops.sex(b, cc);
      const d = sb(b) & 0xffff;
      assert.equal(r.v, d);
      assert.equal(r.a, d >> 8);
      assert.equal(r.b, b);
      assert.equal(r.cc, mk(cc, CC_N | CC_Z, { z: d === 0, n: d >= 0x8000 }));
    }
  }
});

test('16-bit add/sub/cmp: edges and a dense pseudo-random sample', () => {
  const edges = [0, 1, 2, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0x8001,
    0xfffe, 0xffff, 0x1234, 0xedcb];
  const pairs = [];
  for (const a of edges) for (const b of edges) pairs.push([a, b]);
  let s = 0x1234567;
  for (let i = 0; i < 200000; i += 1) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    pairs.push([s & 0xffff, (s >>> 16) & 0xffff]);
  }
  for (const cc of [0, CC_H | CC_I, 0xff]) {
    for (const [a, b] of pairs) {
      same(ops.add16(a, b, cc), ref16(a, b, false, cc), `add16 ${a} ${b}`);
      same(ops.sub16(a, b, cc), ref16(a, b, true, cc), `sub16 ${a} ${b}`);
      same(ops.cmp16(a, b, cc), ref16(a, b, true, cc), `cmp16 ${a} ${b}`);
    }
  }
});

test('nzv8/nzv16/leaXY', () => {
  assert.deepEqual([ops.nzv8(0, 0xff).cc, ops.nzv8(0x80, CC_C).cc],
    [0xff & ~CC_N & ~CC_V, CC_N | CC_C]);
  assert.equal(ops.nzv16(0x8000).cc, CC_N);
  assert.equal(ops.nzv16(0x10000).cc, CC_Z, 'masked to 16 bits');
  assert.equal(ops.leaXY(0x10000, CC_N).cc, CC_N | CC_Z);
  assert.equal(ops.leaXY(5, CC_Z | CC_C).cc, CC_C);
});

test('sign extension, displacements, abx, word helpers', () => {
  assert.equal(ops.s8(0x7f), 127);
  assert.equal(ops.s8(0x80), -128);
  assert.equal(ops.s8(0x1ff), -1);
  assert.equal(ops.s16(0x8000), -32768);
  assert.equal(ops.disp8(0x1000, 0xfd), 0x0ffd);
  assert.equal(ops.disp8(0xffff, 0x01), 0x0000);
  assert.equal(ops.disp8(0x0000, 0x80), 0xff80);
  assert.equal(ops.disp16(0xff00, 0x0200), 0x0100);
  assert.equal(ops.abx(0xfff0, 0xff), 0x00ef, 'B is unsigned');
  assert.equal(ops.dOf(0x12, 0x34), 0x1234);
  assert.equal(ops.hi(0x1234), 0x12);
  assert.equal(ops.lo(0x1234), 0x34);
});

test('ccOf and the boolean flags agree with the CC byte', () => {
  const cc = ops.ccOf({ cf: true, zf: true, hf: true }, CC_I | CC_V);
  assert.equal(cc, CC_I | CC_C | CC_Z | CC_H);
  const r = ops.add8(0x7f, 1);
  assert.deepEqual([r.cf, r.zf, r.nf, r.vf, r.hf], [false, false, true, true, true]);
});

test('cond: every branch condition over every NZVC combination', () => {
  for (let f = 0; f < 16; f += 1) {
    const cc = f; // C=1 V=2 Z=4 N=8 are the low four bits
    const C = !!(f & 1); const V = !!(f & 2); const Z = !!(f & 4); const N = !!(f & 8);
    const want = {
      ra: true, rn: false, hi: !(C || Z), ls: C || Z, cc: !C, hs: !C,
      cs: C, lo: C, ne: !Z, eq: Z, vc: !V, vs: V, pl: !N, mi: N,
      ge: !(N !== V), lt: N !== V, gt: !(Z || (N !== V)), le: Z || (N !== V),
    };
    for (const [k, w] of Object.entries(want)) assert.equal(ops.cond(cc, k), w, `${k} ${f}`);
  }
  assert.throws(() => ops.cond(0, 'xx'));
});

// ---------------------------------------------- against the oracle's core

/** @type {typeof import('../m6809/m6809.mjs').M6809 | null} */
let M6809 = null;
try {
  ({ M6809 } = await import('../m6809/m6809.mjs'));
} catch {
  M6809 = null;
}

/**
 * Run one instruction on the core.
 * @param {number[]} bytes @param {{a?: number, b?: number, x?: number, cc: number}} regs
 */
function makeRunner() {
  const mem = new Uint8Array(0x10000);
  const cpu = new M6809({ read: (a) => mem[a], write: (a, v) => { mem[a] = v; } });
  return (bytes, regs) => {
    mem.set(bytes, 0x1000);
    cpu.setState({ a: 0, b: 0, x: 0, ...regs, pc: 0x1000, s: 0x8000 });
    cpu.step();
    return cpu;
  };
}

test('against the CPU core: 8-bit register ops, exhaustive', { skip: M6809 === null }, () => {
  const run = makeRunner();
  // [opcode, helper(a, b, cc)] for immediate-mode ops on A
  const binary = [
    [0x8b, (a, b, cc) => ops.add8(a, b, cc)], [0x89, ops.adc8],
    [0x80, (a, b, cc) => ops.sub8(a, b, cc)], [0x82, ops.sbc8],
    [0x84, (a, b, cc) => ops.and8(a, b, cc)], [0x8a, (a, b, cc) => ops.or8(a, b, cc)],
    [0x88, (a, b, cc) => ops.eor8(a, b, cc)],
  ];
  for (const [op, fn] of binary) {
    for (const cc of [CC_I | CC_F, CC_I | CC_F | CC_C | CC_H]) {
      for (let a = 0; a < 256; a += 1) {
        for (let b = 0; b < 256; b += 1) {
          const c = run([op, b], { a, cc });
          const r = fn(a, b, cc);
          if (c.a !== r.v || c.cc !== r.cc) {
            assert.fail(`op $${op.toString(16)} a=${a} b=${b} cc=${cc}: core `
              + `${c.a}/${c.cc} port ${r.v}/${r.cc}`);
          }
        }
      }
    }
  }
  // compare-type ops leave A alone
  for (const [op, fn] of [[0x81, ops.cmp8], [0x85, ops.bit8]]) {
    for (let a = 0; a < 256; a += 1) {
      for (let b = 0; b < 256; b += 1) {
        const c = run([op, b], { a, cc: CC_I | CC_H });
        assert.equal(c.cc, fn(a, b, CC_I | CC_H).cc);
        assert.equal(c.a, a);
      }
    }
  }
});

test('against the CPU core: unary ops on A, DAA, MUL, SEX, ABX', { skip: M6809 === null }, () => {
  const run = makeRunner();
  const unary = [
    [0x40, ops.neg8], [0x43, ops.com8], [0x44, ops.lsr8], [0x46, ops.ror8],
    [0x47, ops.asr8], [0x48, ops.asl8], [0x49, ops.rol8], [0x4a, ops.dec8],
    [0x4c, ops.inc8], [0x4d, ops.tst8], [0x4f, (_v, cc) => ops.clr8(cc)],
    [0x19, ops.daa],
  ];
  for (const [op, fn] of unary) {
    for (const cc of CCS) {
      for (let a = 0; a < 256; a += 1) {
        const c = run([op], { a, cc });
        const r = fn(a, cc);
        if (c.a !== r.v || c.cc !== r.cc) {
          assert.fail(`op $${op.toString(16)} a=${a} cc=${cc}: core `
            + `${c.a}/${c.cc} port ${r.v}/${r.cc}`);
        }
      }
    }
  }
  for (let a = 0; a < 256; a += 1) {
    for (let b = 0; b < 256; b += 1) {
      const c = run([0x3d], { a, b, cc: CC_I | CC_N });
      const r = ops.mul(a, b, CC_I | CC_N);
      assert.equal(c.a, r.a);
      assert.equal(c.b, r.b);
      assert.equal(c.cc, r.cc);
    }
  }
  for (let b = 0; b < 256; b += 1) {
    const c = run([0x1d], { a: 0x5a, b, cc: CC_V | CC_C });
    const r = ops.sex(b, CC_V | CC_C);
    assert.deepEqual([c.a, c.b, c.cc], [r.a, r.b, r.cc]);
    const x = run([0x3a], { b, x: 0xff80, cc: 0 });
    assert.equal(x.x, ops.abx(0xff80, b));
  }
});

test('against the CPU core: ADDD/SUBD/CMPX', { skip: M6809 === null }, () => {
  const run = makeRunner();
  let s = 0x2468ace;
  for (let i = 0; i < 100000; i += 1) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const d = s & 0xffff;
    const m = (s >>> 16) & 0xffff;
    const cc = (i & 1) ? 0xff & ~CC_E : CC_I;
    const hiM = m >> 8; const loM = m & 0xff;
    let c = run([0xc3, hiM, loM], { a: d >> 8, b: d & 0xff, cc });
    let r = ops.add16(d, m, cc);
    assert.deepEqual([(c.a << 8) | c.b, c.cc], [r.v, r.cc], `addd ${d} ${m}`);
    c = run([0x83, hiM, loM], { a: d >> 8, b: d & 0xff, cc });
    r = ops.sub16(d, m, cc);
    assert.deepEqual([(c.a << 8) | c.b, c.cc], [r.v, r.cc], `subd ${d} ${m}`);
    c = run([0x8c, hiM, loM], { x: d, cc });
    r = ops.cmp16(d, m, cc);
    assert.deepEqual([c.x, c.cc], [d, r.cc], `cmpx ${d} ${m}`);
  }
});

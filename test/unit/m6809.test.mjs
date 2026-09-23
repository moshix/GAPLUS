// Copyright 2026 by Moshix
/**
 * Unit tests for the MC6809 core (test/m6809/m6809.mjs).
 *
 * The core is the oracle every later comparison rests on, so these tests
 * check it against models written independently of it:
 *  - arithmetic and shift flags exhaustively against reference formulas
 *    (signed ranges for V, nibble sums for H) rather than MAME's XOR trick;
 *  - cycle counts of every opcode on every page against the table in
 *    opcodes.mjs (datasheet figures + MAME for the undocumented ones);
 *  - all 256 indexed postbytes against a reference EA model;
 *  - DAA against the datasheet's correction table, for all 1024 inputs;
 *  - interrupt entry/exit, CWAI and SYNC, NMI arming;
 *  - MAME's undocumented opcodes;
 *  - a hand-assembled program run to completion with a per-instruction
 *    cycle cross-check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  M6809, CC_C, CC_V, CC_Z, CC_N, CC_I, CC_H, CC_F, CC_E,
  IRQ_LINE, FIRQ_LINE, NMI_LINE,
} from '../m6809/m6809.mjs';
import {
  PAGE1, PAGE2, PAGE3, INDEXED_EXTRA, MODE_LEN,
} from '../m6809/opcodes.mjs';
import {
  expectedCycles, branchTaken, stackBytes,
} from '../m6809/cyclemodel.mjs';

/**
 * @typedef {object} Rig
 * @property {M6809} cpu
 * @property {Uint8Array} mem
 * @property {{op: string, addr: number, value: number}[]} log bus log
 */

/**
 * A CPU over flat 64K RAM with `program` at `org`. PC = org, S = $8000,
 * U = $7000, CC = 0 (interrupts unmasked but no line asserted).
 * @param {number[]} program
 * @param {{org?: number, regs?: object, log?: boolean}} [o]
 * @returns {Rig}
 */
function rig(program, o = {}) {
  const org = o.org ?? 0x1000;
  const mem = new Uint8Array(0x10000);
  mem.set(program, org);
  /** @type {{op: string, addr: number, value: number}[]} */
  const log = [];
  const logging = o.log === true;
  const cpu = new M6809({
    read: (a) => {
      if (logging) log.push({ op: 'r', addr: a, value: mem[a] });
      return mem[a];
    },
    write: (a, v) => {
      if (logging) log.push({ op: 'w', addr: a, value: v });
      mem[a] = v;
    },
  });
  cpu.pc = org;
  cpu.s = 0x8000;
  cpu.u = 0x7000;
  cpu.cc = 0;
  if (o.regs) cpu.setState(o.regs);
  return { cpu, mem, log };
}

/** Run one instruction with the given registers; return the rig. */
function run1(/** @type {number[]} */ program, /** @type {object} */ regs) {
  const r = rig(program, { regs });
  r.cpu.step();
  return r;
}

const s8 = (/** @type {number} */ v) => (v << 24) >> 24;
const s16 = (/** @type {number} */ v) => (v << 16) >> 16;

// ------------------------------------------------------ reference models

/**
 * 8-bit add/sub reference: H from the nibble sum, V from signed range,
 * C from the unsigned range. Returns the new CC and result.
 * @param {boolean} sub @param {number} a @param {number} m
 * @param {number} c @param {number} cc0
 */
function refArith8(sub, a, m, c, cc0) {
  const u = sub ? a - m - c : a + m + c;
  const sv = sub ? s8(a) - s8(m) - c : s8(a) + s8(m) + c;
  const r = u & 0xff;
  let cc = cc0 & ~(CC_N | CC_Z | CC_V | CC_C);
  if (!sub) {
    cc &= ~CC_H;
    if ((a & 0xf) + (m & 0xf) + c > 0xf) cc |= CC_H;
  }
  if (r & 0x80) cc |= CC_N;
  if (r === 0) cc |= CC_Z;
  if (sv < -128 || sv > 127) cc |= CC_V;
  if (u < 0 || u > 0xff) cc |= CC_C;
  return { r, cc };
}

/** 16-bit add/sub reference. */
function refArith16(/** @type {boolean} */ sub, /** @type {number} */ a,
  /** @type {number} */ m, /** @type {number} */ cc0) {
  const u = sub ? a - m : a + m;
  const sv = sub ? s16(a) - s16(m) : s16(a) + s16(m);
  const r = u & 0xffff;
  let cc = cc0 & ~(CC_N | CC_Z | CC_V | CC_C);
  if (r & 0x8000) cc |= CC_N;
  if (r === 0) cc |= CC_Z;
  if (sv < -32768 || sv > 32767) cc |= CC_V;
  if (u < 0 || u > 0xffff) cc |= CC_C;
  return { r, cc };
}

/**
 * Unary ops per the programming manual (plus MAME's choice to leave H
 * alone on ASL).
 * @param {string} name @param {number} m @param {number} cc0
 */
function refUnary(name, m, cc0) {
  const c = cc0 & CC_C;
  let cc = cc0;
  let r;
  const setNZ = () => {
    cc &= ~(CC_N | CC_Z);
    if (r & 0x80) cc |= CC_N;
    if (r === 0) cc |= CC_Z;
  };
  const setC = (/** @type {boolean} */ b) => {
    cc = b ? cc | CC_C : cc & ~CC_C;
  };
  const setV = (/** @type {boolean} */ b) => {
    cc = b ? cc | CC_V : cc & ~CC_V;
  };
  switch (name) {
    case 'NEG': r = (256 - m) & 0xff; setC(m !== 0); setV(m === 0x80); break;
    case 'COM': r = ~m & 0xff; setC(true); setV(false); break;
    case 'LSR': r = m >> 1; setC((m & 1) !== 0); break;
    case 'ROR': r = (m >> 1) | (c << 7); setC((m & 1) !== 0); break;
    case 'ASR': r = (m >> 1) | (m & 0x80); setC((m & 1) !== 0); break;
    case 'ASL':
      r = (m << 1) & 0xff; setC(m >= 0x80);
      setV(((m >> 7) ^ (m >> 6)) & 1 ? true : false); break;
    case 'ROL':
      r = ((m << 1) | c) & 0xff; setC(m >= 0x80);
      setV(((m >> 7) ^ (m >> 6)) & 1 ? true : false); break;
    case 'DEC': r = (m + 255) & 0xff; setV(m === 0x80); break;
    case 'INC': r = (m + 1) & 0xff; setV(m === 0x7f); break;
    case 'TST': r = m; setV(false); break;
    case 'CLR': r = 0; setV(false); setC(false); break;
    default: throw new Error(name);
  }
  setNZ();
  return { r, cc };
}

/**
 * DAA from the datasheet's correction-factor table.
 * @param {number} a @param {number} cc0
 */
function refDaa(a, cc0) {
  const hi = a >> 4;
  const lo = a & 0xf;
  const h = (cc0 & CC_H) !== 0;
  const c = (cc0 & CC_C) !== 0;
  let corr = 0;
  if (h || lo > 9) corr |= 0x06;
  if (c || hi > 9 || (hi > 8 && lo > 9)) corr |= 0x60;
  const t = a + corr;
  const r = t & 0xff;
  let cc = cc0 & ~(CC_N | CC_Z | CC_V);
  if (r & 0x80) cc |= CC_N;
  if (r === 0) cc |= CC_Z;
  if (c || t > 0xff) cc |= CC_C;
  return { r, cc };
}

// ---------------------------------------------------------------- basics

test('reset: DP=0, I and F set, PC from $FFFE, 4 cycles', () => {
  const { cpu, mem } = rig([]);
  mem[0xfffe] = 0xe0; mem[0xffff] = 0x12;
  cpu.dp = 0x55; cpu.cc = 0x0f; cpu.a = 0x77;
  const c = cpu.reset();
  assert.equal(c, 4);
  assert.equal(cpu.pc, 0xe012);
  assert.equal(cpu.dp, 0);
  assert.equal(cpu.cc, 0x0f | CC_I | CC_F);
  assert.equal(cpu.a, 0x77, 'other registers keep their value');
  assert.equal(cpu.cycles, 4);
});

test('D is A:B', () => {
  const { cpu } = rig([]);
  cpu.d = 0x1234;
  assert.equal(cpu.a, 0x12);
  assert.equal(cpu.b, 0x34);
  cpu.a = 0xab;
  assert.equal(cpu.d, 0xab34);
});

test('getState / setState round trip', () => {
  const { cpu } = rig([0x12]);
  cpu.setState({
    a: 1, b: 2, x: 3, y: 4, u: 5, s: 6, pc: 0x1000, dp: 7, cc: 0x55,
    irqLine: true, firqLine: false, ldsEncountered: true,
  });
  const st = cpu.getState();
  const { cpu: cpu2 } = rig([0x12]);
  cpu2.setState(st);
  assert.deepEqual(cpu2.getState(), st);
  assert.equal(st.cc, 0x55);
  assert.equal(st.irqLine, true);
});

test('trace hook sees every instruction and only instructions', () => {
  // NOP; NOP; then an IRQ is taken (not traced)
  const { cpu, mem } = rig([0x12, 0x12, 0x12]);
  mem[0xfff8] = 0x10; mem[0xfff9] = 0x02;
  /** @type {number[]} */
  const pcs = [];
  cpu.trace = (pc) => { pcs.push(pc); };
  cpu.step(); cpu.step();
  cpu.setIrq(1);
  cpu.step();                                  // interrupt entry
  cpu.step();                                  // NOP at $1002
  assert.deepEqual(pcs, [0x1000, 0x1001, 0x1002]);
});

// --------------------------------------------------------- cycle tables

/**
 * Build a program for one opcode with benign operands and run it one step.
 * Returns [cycles, expected] or null when the entry is not testable this
 * way (page prefixes).
 * @param {number} prefix 0, $10 or $11
 * @param {number} op
 */
function cycleCase(prefix, op) {
  const table = prefix === 0 ? PAGE1 : prefix === 0x10 ? PAGE2 : PAGE3;
  const info = table[op];
  if (info === null || info.mode === 'page') return null;
  const bytes = prefix ? [prefix, op] : [op];
  switch (info.mode) {
    case 'idx': bytes.push(0x84); break;               // ,X
    case 'dir': bytes.push(0x20); break;
    case 'ext': bytes.push(0x20, 0x00); break;
    case 'imm16': bytes.push(0x00, 0x00); break;
    case 'rr': bytes.push(0x12); break;               // X,Y
    default:
      for (let i = 0; i < MODE_LEN[info.mode]; i += 1) bytes.push(0);
  }
  const regs = { x: 0x3000, y: 0x3100 };
  const { cpu } = rig(bytes, { regs });
  let expected = info.cycles;
  if (info.name === 'CWAI' || info.name === 'SYNC') {
    // an IRQ already pending: CWAI #$00 unmasks and takes it at once,
    // SYNC sees the (masked) line and resumes after one cycle
    cpu.cc = CC_I | CC_F;
    cpu.setIrq(1);
  }
  if (info.mode === 'rel16' && prefix === 0x10 &&
      branchTaken(op & 0x0f, cpu.cc)) expected += 1;
  const got = cpu.step();
  return { got, expected, name: info.name };
}

test('cycle counts: every page 1/2/3 opcode matches the table', () => {
  const bad = [];
  let n = 0;
  for (const prefix of [0, 0x10, 0x11]) {
    for (let op = 0; op < 256; op += 1) {
      const r = cycleCase(prefix, op);
      if (r === null) continue;
      n += 1;
      if (r.got !== r.expected) {
        bad.push(`${prefix ? prefix.toString(16) : ''}` +
          `${op.toString(16).padStart(2, '0')} ${r.name}: ` +
          `got ${r.got}, want ${r.expected}`);
      }
    }
  }
  assert.deepEqual(bad, []);
  // 254 page 1 + 48 page 2 + 18 page 3 opcodes
  assert.equal(n, 320);
});

test('cycle counts: long branches take +1 only when taken', () => {
  for (let n = 0; n < 16; n += 1) {
    for (let cc = 0; cc < 16; cc += 1) {
      const { cpu } = rig([0x10, 0x20 + n, 0x00, 0x10], { regs: { cc } });
      const taken = branchTaken(n, cc);
      assert.equal(cpu.step(), taken ? 6 : 5);
      assert.equal(cpu.pc, taken ? 0x1014 : 0x1004);
      // short branch: 3 cycles either way
      const r = rig([0x20 + n, 0x10], { regs: { cc } });
      assert.equal(r.cpu.step(), 3);
      assert.equal(r.cpu.pc, taken ? 0x1012 : 0x1002);
    }
  }
  // LBRA/LBSR on page 1 are unconditional
  assert.equal(run1([0x16, 0xff, 0xfd], {}).cpu.pc, 0x1000);
  const lbsr = run1([0x17, 0x01, 0x00], {});
  assert.equal(lbsr.cpu.pc, 0x1103);
  assert.equal(lbsr.cpu.s, 0x7ffe);
  assert.equal(lbsr.mem[0x7ffe] << 8 | lbsr.mem[0x7fff], 0x1003);
});

test('cycle counts: PSHS/PULS/PSHU/PULU cost 5 + one per byte', () => {
  for (let pb = 0; pb < 256; pb += 1) {
    for (const op of [0x34, 0x35, 0x36, 0x37]) {
      const { cpu } = rig([op, pb]);
      assert.equal(cpu.step(), 5 + stackBytes(pb), `op ${op} pb ${pb}`);
    }
  }
});

// ------------------------------------------------------- indexed modes

/**
 * Reference indexed-mode model (MAME semantics for undefined postbytes).
 * @param {number} pb @param {Record<string, number>} r registers
 *   (mutated for auto inc/dec) @param {number} pcAfterPb PC after postbyte
 * @param {(a: number) => number} read
 * @returns {{ea: number, len: number}} len = operand bytes after postbyte
 */
function refIndexed(pb, r, pcAfterPb, read) {
  const name = ['x', 'y', 'u', 's'][(pb >> 5) & 3];
  if (!(pb & 0x80)) {
    const off = pb & 0x10 ? (pb & 0x1f) - 32 : pb & 0x1f;
    return { ea: (r[name] + off) & 0xffff, len: 0 };
  }
  let ea = 0;
  let len = 0;
  const b1 = read(pcAfterPb);
  const w = read(pcAfterPb) << 8 | read((pcAfterPb + 1) & 0xffff);
  switch (pb & 0x0f) {
    case 0: ea = r[name]; r[name] = (r[name] + 1) & 0xffff; break;
    case 1: ea = r[name]; r[name] = (r[name] + 2) & 0xffff; break;
    case 2: r[name] = (r[name] - 1) & 0xffff; ea = r[name]; break;
    case 3: r[name] = (r[name] - 2) & 0xffff; ea = r[name]; break;
    case 4: ea = r[name]; break;
    case 5: ea = r[name] + s8(r.b); break;
    case 6: ea = r[name] + s8(r.a); break;
    case 8: ea = r[name] + s8(b1); len = 1; break;
    case 9: ea = r[name] + w; len = 2; break;
    case 11: ea = r[name] + (r.a << 8 | r.b); break;
    case 12: ea = pcAfterPb + 1 + s8(b1); len = 1; break;
    case 13: ea = pcAfterPb + 2 + w; len = 2; break;
    case 15: ea = w; len = 2; break;
    default: ea = 0; break;           // x7 xA xE: MAME gives $0000
  }
  ea &= 0xffff;
  if (pb & 0x10) ea = read(ea) << 8 | read((ea + 1) & 0xffff);
  return { ea, len };
}

test('indexed: all 256 postbytes -- EA, side effects, length, cycles', () => {
  const operandSets = [[0x12, 0x34], [0xfe, 0x80], [0x80, 0x01]];
  const regSets = [
    { a: 0xf0, b: 0x05, x: 0x1234, y: 0x2345, u: 0x3456, s: 0x4567 },
    { a: 0x10, b: 0xf3, x: 0xfffe, y: 0x0001, u: 0x8000, s: 0x7fff },
  ];
  for (let pb = 0; pb < 256; pb += 1) {
    for (const ops of operandSets) {
      for (const regs of regSets) {
        // LDA indexed; memory filled with an address-dependent pattern
        const { cpu, mem } = rig([]);
        for (let a = 0; a < 0x10000; a += 1) {
          mem[a] = (a ^ (a >> 8) ^ 0x5a) & 0xff;
        }
        mem.set([0xa6, pb, ...ops], 0x1000);
        cpu.setState(regs);
        /** @type {Record<string, number>} */
        const ref = { ...regs };
        const read = (/** @type {number} */ a) => mem[a];
        const { ea, len } = refIndexed(pb, ref, 0x1002, read);
        const want = mem[ea];
        const cyc = cpu.step();
        const tag = `pb=${pb.toString(16)} ops=${ops} x=${regs.x}`;
        assert.equal(cpu.a, want, tag + ' value');
        assert.equal(cpu.pc, 0x1002 + len, tag + ' length');
        for (const k of ['x', 'y', 'u', 's']) {
          assert.equal(cpu[/** @type {'x'} */ (k)], ref[k], tag + ' ' + k);
        }
        assert.equal(cyc, 4 + INDEXED_EXTRA[pb], tag + ' cycles');
      }
    }
  }
});

test('indexed: documented extra cycles match the datasheet', () => {
  // datasheet "+~" column, relative to ,R
  const doc = {
    0x84: 0, 0x80: 2, 0x81: 3, 0x82: 2, 0x83: 3, 0x85: 1, 0x86: 1,
    0x88: 1, 0x89: 4, 0x8b: 4, 0x8c: 1, 0x8d: 5, 0x94: 3, 0x91: 6,
    0x93: 6, 0x95: 4, 0x96: 4, 0x98: 4, 0x99: 7, 0x9b: 7, 0x9c: 4,
    0x9d: 8, 0x9f: 5, 0x00: 1, 0x1f: 1,
  };
  for (const [pb, extra] of Object.entries(doc)) {
    assert.equal(INDEXED_EXTRA[Number(pb)], extra, `postbyte ${pb}`);
  }
});

test('indexed: CMPX ,X++ compares the incremented X (as MAME)', () => {
  const r = rig([0xac, 0x81]);
  r.cpu.x = 0x2000;
  r.mem[0x2000] = 0x20; r.mem[0x2001] = 0x02;
  r.cpu.step();
  assert.equal(r.cpu.x, 0x2002);
  assert.ok(r.cpu.cc & CC_Z, 'new X ($2002) equals the word at old X');
});

test('addressing: direct uses DP, extended, immediate, stores', () => {
  // LDA <$34 with DP=$12; STA $2000; LDB #$80; STB [$3000]
  const { cpu, mem } = rig([
    0x96, 0x34, 0xb7, 0x20, 0x00, 0xc6, 0x80, 0xe7, 0x9f, 0x30, 0x00,
  ]);
  cpu.dp = 0x12;
  mem[0x1234] = 0x5a;
  mem[0x3000] = 0x40; mem[0x3001] = 0x10;
  assert.equal(cpu.step(), 4);
  assert.equal(cpu.a, 0x5a);
  assert.equal(cpu.step(), 5);
  assert.equal(mem[0x2000], 0x5a);
  assert.equal(cpu.step(), 2);
  assert.equal(cpu.b, 0x80);
  assert.equal(cpu.cc & (CC_N | CC_Z | CC_V), CC_N);
  assert.equal(cpu.step(), 4 + 5);
  assert.equal(mem[0x4010], 0x80);
});

test('16-bit loads and stores, STD/LDD/LDU/STU/LDY/STY/LDS/STS', () => {
  const { cpu, mem } = rig([
    0xcc, 0x12, 0x34,             // LDD #$1234
    0xfd, 0x20, 0x00,             // STD $2000
    0xce, 0x80, 0x00,             // LDU #$8000   (N set)
    0xff, 0x20, 0x02,             // STU $2002
    0x10, 0x8e, 0x00, 0x00,       // LDY #$0000   (Z set)
    0x10, 0xbf, 0x20, 0x04,       // STY $2004
    0x10, 0xce, 0x55, 0xaa,       // LDS #$55AA
    0x10, 0xff, 0x20, 0x06,       // STS $2006
    0xdc, 0x02,                   // LDD <$02 -> $2002 with DP=$20
  ]);
  cpu.dp = 0x20;
  const cyc = [3, 6, 3, 6, 4, 7, 4, 7, 5];
  for (const c of cyc) assert.equal(cpu.step(), c);
  assert.deepEqual([...mem.subarray(0x2000, 0x2008)],
    [0x12, 0x34, 0x80, 0x00, 0x00, 0x00, 0x55, 0xaa]);
  assert.equal(cpu.d, 0x8000);
  assert.equal(cpu.cc & (CC_N | CC_Z | CC_V), CC_N);
  assert.equal(cpu.s, 0x55aa);
  assert.equal(cpu.ldsEncountered, true);
});

// --------------------------------------------------------------- flags

test('ADDA/ADCA/SUBA/SBCA/CMPA: exhaustive against the reference', () => {
  const ops = [
    { op: 0x8b, sub: false, carry: false, store: true },   // ADDA
    { op: 0x89, sub: false, carry: true, store: true },    // ADCA
    { op: 0x80, sub: true, carry: false, store: true },    // SUBA
    { op: 0x82, sub: true, carry: true, store: true },     // SBCA
    { op: 0x81, sub: true, carry: false, store: false },   // CMPA
  ];
  const { cpu, mem } = rig([0, 0]);
  for (const o of ops) {
    mem[0x1000] = o.op;
    for (let a = 0; a < 256; a += 1) {
      for (let m = 0; m < 256; m += 1) {
        mem[0x1001] = m;
        for (const cc0 of [0x00, 0xff & ~(CC_I | CC_F)]) {
          cpu.pc = 0x1000; cpu.a = a; cpu.cc = cc0 | CC_I | CC_F;
          cpu.step();
          const c = o.carry ? cc0 & CC_C : 0;
          const ref = refArith8(o.sub, a, m, c, cc0 | CC_I | CC_F);
          if (cpu.cc !== ref.cc || cpu.a !== (o.store ? ref.r : a)) {
            assert.fail(`op ${o.op.toString(16)} a=${a} m=${m} ` +
              `cc0=${cc0}: got a=${cpu.a} cc=${cpu.cc.toString(16)} ` +
              `want a=${ref.r} cc=${ref.cc.toString(16)}`);
          }
        }
      }
    }
  }
});

test('B-side ALU ops use B and the same flags', () => {
  const r = run1([0xcb, 0x01], { b: 0x7f });        // ADDB #1
  assert.equal(r.cpu.b, 0x80);
  assert.equal(r.cpu.cc, CC_N | CC_V | CC_H);
  const s = run1([0xc0, 0x01], { b: 0x00 });        // SUBB #1
  assert.equal(s.cpu.b, 0xff);
  assert.equal(s.cpu.cc, CC_N | CC_C);
  const t = run1([0xc9, 0x00], { b: 0xff, cc: CC_C }); // ADCB #0
  assert.equal(t.cpu.b, 0x00);
  assert.equal(t.cpu.cc, CC_Z | CC_C | CC_H);
  const u = run1([0xc2, 0x00], { b: 0x80, cc: CC_C }); // SBCB #0
  assert.equal(u.cpu.b, 0x7f);
  assert.equal(u.cpu.cc, CC_V);
});

test('AND/OR/EOR/BIT/LD clear V, set N/Z, keep C', () => {
  const cases = [
    [0x84, 0xf0, 0x0f, 0x00, CC_Z],        // ANDA
    [0x8a, 0x80, 0x01, 0x81, CC_N],        // ORA
    [0x88, 0xff, 0xff, 0x00, CC_Z],        // EORA
    [0x85, 0x80, 0x80, 0x80, CC_N],        // BITA (A unchanged)
    [0x86, 0x00, 0x7f, 0x7f, 0],           // LDA
  ];
  for (const [op, a, m, want, flags] of cases) {
    const r = run1([op, m], { a, cc: CC_V | CC_C });
    assert.equal(r.cpu.a, want, `op ${op}`);
    assert.equal(r.cpu.cc, flags | CC_C, `op ${op} flags`);
  }
});

test('ADDD/SUBD/CMPX/CMPD/CMPY/CMPU/CMPS against the reference', () => {
  const vals = [0, 1, 0x7fff, 0x8000, 0x8001, 0xffff, 0x1234, 0xfedc];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 16; };
  for (let i = 0; i < 400; i += 1) vals.push(rnd());
  /** @type {[number[], string, boolean, boolean][]} */
  const ops = [
    [[0xc3], 'd', false, true], [[0x83], 'd', true, true],
    [[0x8c], 'x', true, false], [[0x10, 0x83], 'd', true, false],
    [[0x10, 0x8c], 'y', true, false], [[0x11, 0x83], 'u', true, false],
    [[0x11, 0x8c], 's', true, false],
  ];
  for (const [code, reg, sub, store] of ops) {
    for (let i = 0; i < vals.length; i += 7) {
      for (let j = 0; j < vals.length; j += 3) {
        const a = vals[i];
        const m = vals[j];
        const r = run1([...code, m >> 8, m & 0xff], { cc: CC_H });
        r.cpu[/** @type {'x'} */ (reg)] = a;
        r.cpu.pc = 0x1000; r.cpu.cc = CC_H; r.cpu.cycles = 0;
        r.cpu.step();
        const ref = refArith16(sub, a, m, CC_H);
        assert.equal(r.cpu.cc, ref.cc, `${code} ${a} ${m}`);
        assert.equal(r.cpu[/** @type {'x'} */ (reg)], store ? ref.r : a);
      }
    }
  }
});

test('unary ops on A, B and memory: exhaustive against the reference', () => {
  /** @type {[string, number][]} */
  const ops = [
    ['NEG', 0x0], ['COM', 0x3], ['LSR', 0x4], ['ROR', 0x6], ['ASR', 0x7],
    ['ASL', 0x8], ['ROL', 0x9], ['DEC', 0xa], ['INC', 0xc], ['TST', 0xd],
    ['CLR', 0xf],
  ];
  const { cpu, mem } = rig([]);
  for (const [name, n] of ops) {
    for (let m = 0; m < 256; m += 1) {
      for (const cc0 of [0x00, 0x2f]) {
        const ref = refUnary(name, m, cc0);
        // inherent A, inherent B, direct, indexed, extended
        for (const [code, where] of /** @type {[number[], string][]} */ ([
          [[0x40 | n], 'a'], [[0x50 | n], 'b'], [[0x00 | n, 0x80], 'm'],
          [[0x60 | n, 0x84], 'm'], [[0x70 | n, 0x20, 0x80], 'm'],
        ])) {
          mem.set(code, 0x1000);
          cpu.pc = 0x1000; cpu.cc = cc0; cpu.dp = 0x20; cpu.x = 0x2080;
          cpu.a = where === 'a' ? m : 0x11;
          cpu.b = where === 'b' ? m : 0x22;
          mem[0x2080] = m;
          cpu.step();
          const got = where === 'a' ? cpu.a : where === 'b' ? cpu.b
            : mem[0x2080];
          if (got !== ref.r || cpu.cc !== ref.cc) {
            assert.fail(`${name} ${code} m=${m} cc0=${cc0}: got ${got}` +
              ` cc=${cpu.cc.toString(16)} want ${ref.r} ` +
              `cc=${ref.cc.toString(16)}`);
          }
        }
      }
    }
  }
});

test('RMW memory ops read, idle, write; CLR really reads first', () => {
  const r = rig([0x7f, 0x20, 0x00], { log: true });  // CLR $2000
  r.mem[0x2000] = 0x99;
  r.log.length = 0;
  assert.equal(r.cpu.step(), 7);
  const data = r.log.filter((e) => e.addr === 0x2000);
  assert.deepEqual(data.map((e) => e.op), ['r', 'w']);
  assert.equal(r.mem[0x2000], 0);
  // bus cycle index of each access: fetch 0,1,2; dead 3; read 4;
  // dead 5; write 6
  /** @type {number[]} */
  const at = [];
  const t = rig([0x7c, 0x20, 0x00]);                  // INC $2000
  const bus = t.cpu.bus;
  const rd = bus.read;
  const wr = bus.write;
  bus.read = (a) => { at.push(t.cpu.cyc); return rd(a); };
  bus.write = (a, v) => { at.push(t.cpu.cyc); wr(a, v); };
  t.cpu.step();
  assert.deepEqual(at, [0, 1, 2, 4, 6]);
});

test('DAA: all 1024 (A, H, C, N/Z/V) inputs against the datasheet', () => {
  for (let a = 0; a < 256; a += 1) {
    for (const cc0 of [0, CC_H, CC_C, CC_H | CC_C, CC_N | CC_Z | CC_V,
      CC_H | CC_V, CC_C | CC_Z, 0x2f]) {
      const r = run1([0x19], { a, cc: cc0 });
      const ref = refDaa(a, cc0);
      assert.equal(r.cpu.a, ref.r, `a=${a} cc=${cc0}`);
      assert.equal(r.cpu.cc, ref.cc, `a=${a} cc=${cc0} flags`);
    }
  }
  // BCD sanity: $19 + $28 = $47
  const r = rig([0x86, 0x19, 0x8b, 0x28, 0x19]);
  r.cpu.step(); r.cpu.step(); r.cpu.step();
  assert.equal(r.cpu.a, 0x47);
  // $99 + $01 = $00 carry
  const q = rig([0x86, 0x99, 0x8b, 0x01, 0x19]);
  q.cpu.step(); q.cpu.step(); q.cpu.step();
  assert.equal(q.cpu.a, 0x00);
  assert.ok(q.cpu.cc & CC_C);
});

test('MUL: exhaustive; Z from D, C = bit 7 of D, 11 cycles', () => {
  const { cpu, mem } = rig([0x3d]);
  for (let a = 0; a < 256; a += 1) {
    for (let b = 0; b < 256; b += 1) {
      cpu.pc = 0x1000; cpu.a = a; cpu.b = b; cpu.cc = CC_N | CC_V;
      assert.equal(cpu.step(), 11);
      const d = a * b;
      const cc = CC_N | CC_V | (d === 0 ? CC_Z : 0) | ((d >> 7) & 1);
      if (cpu.d !== d || cpu.cc !== cc) assert.fail(`${a}*${b}`);
    }
  }
  assert.equal(mem[0x1000], 0x3d);
});

test('SEX: sign-extends B, N/Z from D, V untouched (MAME)', () => {
  for (let b = 0; b < 256; b += 1) {
    const r = run1([0x1d], { b, a: 0x55, cc: CC_V | CC_C });
    assert.equal(r.cpu.a, b & 0x80 ? 0xff : 0);
    assert.equal(r.cpu.b, b);
    const cc = CC_V | CC_C | (b & 0x80 ? CC_N : 0) | (b === 0 ? CC_Z : 0);
    assert.equal(r.cpu.cc, cc);
  }
});

test('ABX adds B unsigned, no flags; LEA flags', () => {
  const r = run1([0x3a], { x: 0xfff0, b: 0x20, cc: 0 });
  assert.equal(r.cpu.x, 0x0010);
  assert.equal(r.cpu.cc, 0);
  // LEAX -1,X from 1 -> 0 sets Z; LEAY ,Y+ gives old Y; LEAS/LEAU no flags
  const l = rig([0x30, 0x1f, 0x31, 0xa0, 0x32, 0x7f, 0x33, 0x5f]);
  l.cpu.setState({ x: 1, y: 0x1234, cc: 0 });
  assert.equal(l.cpu.step(), 5);
  assert.equal(l.cpu.x, 0);
  assert.equal(l.cpu.cc, CC_Z);
  assert.equal(l.cpu.step(), 6);
  assert.equal(l.cpu.y, 0x1234, 'LEAY ,Y+ loads the old Y');
  assert.equal(l.cpu.cc, 0);
  l.cpu.s = 1; l.cpu.cc = 0;
  l.cpu.step();
  assert.equal(l.cpu.s, 0);
  assert.equal(l.cpu.cc, 0, 'LEAS leaves Z alone');
  assert.equal(l.cpu.ldsEncountered, true);
  l.cpu.u = 1;
  l.cpu.step();
  assert.equal(l.cpu.u, 0);
  assert.equal(l.cpu.cc, 0);
});

test('ORCC/ANDCC and their cycle counts', () => {
  const r = rig([0x1a, 0x50, 0x1c, 0xaf]);
  assert.equal(r.cpu.step(), 3);
  assert.equal(r.cpu.cc, 0x50);
  assert.equal(r.cpu.step(), 3);
  assert.equal(r.cpu.cc, 0x00);
});

// ------------------------------------------------------ branches, calls

test('branches: all 16 conditions over all 16 NZVC combinations', () => {
  for (let n = 0; n < 16; n += 1) {
    for (let cc = 0; cc < 16; cc += 1) {
      const r = run1([0x20 + n, 0x7e], { cc });
      const want = branchTaken(n, cc) ? 0x1080 : 0x1002;
      assert.equal(r.cpu.pc, want, `B${n} cc=${cc}`);
    }
  }
  // backwards
  assert.equal(run1([0x20, 0xfe], {}).cpu.pc, 0x1000);
});

test('BSR/JSR/RTS: stack contents and cycles', () => {
  const r = rig([0x8d, 0x10]);                        // BSR +$10
  r.mem.set([0xbd, 0x30, 0x00], 0x1012);              // JSR $3000
  r.mem.set([0xad, 0x84], 0x3000);                    // JSR ,X
  r.mem[0x4000] = 0x39;                               // RTS
  r.mem[0x3002] = 0x39;
  r.mem[0x1015] = 0x39;
  r.cpu.x = 0x4000;
  assert.equal(r.cpu.step(), 7);
  assert.equal(r.cpu.pc, 0x1012);
  assert.equal(r.cpu.s, 0x7ffe);
  assert.deepEqual([r.mem[0x7ffe], r.mem[0x7fff]], [0x10, 0x02]);
  assert.equal(r.cpu.step(), 8);
  assert.equal(r.cpu.pc, 0x3000);
  assert.equal(r.cpu.step(), 7);
  assert.equal(r.cpu.pc, 0x4000);
  assert.equal(r.cpu.s, 0x7ffa);
  assert.equal(r.cpu.step(), 5);
  assert.equal(r.cpu.pc, 0x3002);
  assert.equal(r.cpu.step(), 5);
  assert.equal(r.cpu.pc, 0x1015);
  assert.equal(r.cpu.step(), 5);
  assert.equal(r.cpu.pc, 0x1002);
  assert.equal(r.cpu.s, 0x8000);
  // JSR direct
  const d = rig([0x9d, 0x40]);
  d.cpu.dp = 0x20;
  assert.equal(d.cpu.step(), 7);
  assert.equal(d.cpu.pc, 0x2040);
  // JMP direct / extended / indexed
  assert.equal(run1([0x0e, 0x40], { dp: 0x20 }).cpu.pc, 0x2040);
  assert.equal(rig([0x0e, 0x40]).cpu.step(), 3);
  assert.equal(rig([0x7e, 0x40, 0x00]).cpu.step(), 4);
  assert.equal(rig([0x6e, 0x84]).cpu.step(), 3);
});

// -------------------------------------------------------------- stack

test('PSHS/PULS every mask: layout, U swap, restore', () => {
  for (let pb = 0; pb < 256; pb += 1) {
    const { cpu, mem } = rig([0x34, pb, 0x35, pb]);
    const regs = {
      cc: 0x0f, a: 0x11, b: 0x22, dp: 0x33, x: 0x4455, y: 0x6677,
      u: 0x8899,
    };
    cpu.setState(regs);
    cpu.step();
    // expected push order, from high address to low
    const bytes = [];
    if (pb & 0x80) bytes.push(0x02, 0x10);                 // PC = $1002
    if (pb & 0x40) bytes.push(0x99, 0x88);
    if (pb & 0x20) bytes.push(0x77, 0x66);
    if (pb & 0x10) bytes.push(0x55, 0x44);
    if (pb & 0x08) bytes.push(0x33);
    if (pb & 0x04) bytes.push(0x22);
    if (pb & 0x02) bytes.push(0x11);
    if (pb & 0x01) bytes.push(0x0f);
    assert.equal(cpu.s, 0x8000 - bytes.length);
    for (let i = 0; i < bytes.length; i += 1) {
      assert.equal(mem[0x7fff - i], bytes[i], `pb=${pb} byte ${i}`);
    }
    // clobber and pull back (PULS PC would jump to $1002 -- fine)
    cpu.setState({ cc: 0, a: 0, b: 0, dp: 0, x: 0, y: 0, u: 0 });
    cpu.pc = 0x1002;
    cpu.step();
    const st = cpu.getState();
    if (pb & 0x01) assert.equal(st.cc, 0x0f);
    if (pb & 0x02) assert.equal(st.a, 0x11);
    if (pb & 0x04) assert.equal(st.b, 0x22);
    if (pb & 0x08) assert.equal(st.dp, 0x33);
    if (pb & 0x10) assert.equal(st.x, 0x4455);
    if (pb & 0x20) assert.equal(st.y, 0x6677);
    if (pb & 0x40) assert.equal(st.u, 0x8899);
    if (pb & 0x80) assert.equal(st.pc, 0x1002);
    assert.equal(st.s, 0x8000);
  }
});

test('PSHU/PULU use U and push/pull S in the U slot', () => {
  const { cpu, mem } = rig([0x36, 0x44, 0x37, 0x44]);   // PSHU S,B
  cpu.s = 0xabcd; cpu.b = 0x5a;
  cpu.step();
  assert.equal(cpu.u, 0x7000 - 3);
  assert.deepEqual([...mem.subarray(0x6ffd, 0x7000)], [0x5a, 0xab, 0xcd]);
  cpu.s = 0; cpu.b = 0;
  cpu.step();
  assert.equal(cpu.s, 0xabcd);
  assert.equal(cpu.b, 0x5a);
  assert.equal(cpu.u, 0x7000);
});

test('push reads the stack pointer first; pull reads one past the end', () => {
  const r = rig([0x34, 0x02, 0x35, 0x02], { log: true });
  r.log.length = 0;
  r.cpu.step();
  // postbyte fetch, then a read at S, then the write
  assert.deepEqual(r.log.map((e) => `${e.op}${e.addr.toString(16)}`),
    ['r1000', 'r1001', 'r8000', 'w7fff']);
  r.log.length = 0;
  r.cpu.step();
  assert.deepEqual(r.log.map((e) => `${e.op}${e.addr.toString(16)}`),
    ['r1002', 'r1003', 'r7fff', 'r8000']);
});

// ------------------------------------------------------------ EXG / TFR

const NAMES = ['d', 'x', 'y', 'u', 's', 'pc', '', '', 'a', 'b', 'cc', 'dp'];

/**
 * Reference for MAME's TFR/EXG register reads.
 * @param {Record<string, number>} r @param {number} n
 * @param {boolean} ccdpBoth CC/DP appear in both bytes (else $FF high)
 */
function refRead(r, n, ccdpBoth) {
  const name = NAMES[n] ?? '';
  if (name === '') return 0xffff;
  if (n < 8) return r[name];
  if (n >= 10 && ccdpBoth) return r[name] * 0x101;
  return 0xff00 | r[name];
}

/** @param {Record<string, number>} r @param {number} n @param {number} v */
function refWrite(r, n, v) {
  const name = NAMES[n] ?? '';
  if (name === '') return;
  if (name === 'd') { r.a = v >> 8; r.b = v & 0xff; return; }
  r[name] = n < 8 ? v : v & 0xff;
}

test('TFR and EXG: all 256 postbytes against the reference', () => {
  const base = {
    a: 0x12, b: 0x34, x: 0x5678, y: 0x9abc, u: 0xdef0, s: 0x2468,
    dp: 0x9d, cc: 0x5a,
  };
  for (let p = 0; p < 256; p += 1) {
    for (const op of [0x1f, 0x1e]) {
      const r = run1([op, p], base);
      /** @type {Record<string, number>} */
      const ref = { ...base, pc: 0x1002, d: 0x1234 };
      if (op === 0x1f) {
        refWrite(ref, p & 15, refRead(ref, p >> 4, true));
      } else {
        const first8 = (p & 0x80) !== 0;
        const r1 = refRead(ref, p >> 4, first8);
        const r2 = refRead(ref, p & 15, first8);
        refWrite(ref, p & 15, r1);
        ref.d = ref.a << 8 | ref.b;
        refWrite(ref, p >> 4, r2);
      }
      const st = r.cpu.getState();
      for (const k of ['a', 'b', 'x', 'y', 'u', 's', 'dp', 'cc', 'pc']) {
        assert.equal(st[/** @type {'a'} */ (k)], ref[k],
          `${op === 0x1f ? 'TFR' : 'EXG'} ${p.toString(16)} ${k}`);
      }
    }
  }
});

test('TFR/EXG mixed sizes: hand-picked MAME behaviours', () => {
  assert.equal(run1([0x1f, 0x81], { a: 0x12 }).cpu.x, 0xff12);   // A->X
  assert.equal(run1([0x1f, 0x18], { x: 0x1234 }).cpu.a, 0x34);   // X->A
  assert.equal(run1([0x1f, 0xa0], { cc: 0x5a }).cpu.d, 0x5a5a);  // CC->D
  assert.equal(run1([0x1f, 0x61], {}).cpu.x, 0xffff);            // inv->X
  // EXG X,CC (16-bit first): X gets $FF:CC, CC gets X low
  const e = run1([0x1e, 0x1a], { x: 0x1234, cc: 0x5a });
  assert.equal(e.cpu.x, 0xff5a);
  assert.equal(e.cpu.cc, 0x34);
  // EXG CC,X (8-bit first): X gets CC:CC
  const f = run1([0x1e, 0xa1], { x: 0x1234, cc: 0x5a });
  assert.equal(f.cpu.x, 0x5a5a);
  assert.equal(f.cpu.cc, 0x34);
  // EXG A,B swap and cycle counts
  const g = rig([0x1e, 0x89, 0x1f, 0x12]);
  g.cpu.setState({ a: 1, b: 2 });
  assert.equal(g.cpu.step(), 8);
  assert.deepEqual([g.cpu.a, g.cpu.b], [2, 1]);
  assert.equal(g.cpu.step(), 6);
  // TFR X,PC jumps; TFR x,S arms NMI but EXG x,S does not (MAME)
  assert.equal(run1([0x1f, 0x15], { x: 0x4321 }).cpu.pc, 0x4321);
  assert.equal(run1([0x1f, 0x14], {}).cpu.ldsEncountered, true);
  assert.equal(run1([0x1e, 0x14], {}).cpu.ldsEncountered, false);
});

// ----------------------------------------------------------- interrupts

/** Rig with the three hardware vectors pointing at distinct handlers. */
function irqRig(/** @type {number[]} */ program) {
  const r = rig(program);
  const vec = (/** @type {number} */ at, /** @type {number} */ to) => {
    r.mem[at] = to >> 8; r.mem[at + 1] = to & 0xff;
  };
  vec(0xfff8, 0x2000);   // IRQ
  vec(0xfff6, 0x3000);   // FIRQ
  vec(0xfffc, 0x4000);   // NMI
  vec(0xfffa, 0x5000);   // SWI
  vec(0xfff4, 0x5200);   // SWI2
  vec(0xfff2, 0x5300);   // SWI3
  r.mem[0x2000] = 0x3b;  // RTI in every handler
  r.mem[0x3000] = 0x3b;
  r.mem[0x4000] = 0x3b;
  return r;
}

test('IRQ: 19 cycles, entire state, E and I set, RTI 15 cycles', () => {
  const r = irqRig([0x12, 0x12]);
  /** @type {number[]} */
  const acks = [];
  r.cpu.bus.ack = (line) => { acks.push(line); };
  r.cpu.setState({ a: 1, b: 2, dp: 3, x: 0x0405, y: 0x0607, u: 0x0809 });
  r.cpu.cc = CC_N;
  r.cpu.setIrq(true);
  assert.equal(r.cpu.step(), 19);
  assert.equal(r.cpu.pc, 0x2000);
  assert.equal(r.cpu.cc, CC_N | CC_E | CC_I);
  assert.equal(r.cpu.s, 0x8000 - 12);
  assert.deepEqual([...r.mem.subarray(0x7ff4, 0x8000)], [
    CC_N | CC_E, 1, 2, 3, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x10, 0x00,
  ]);
  assert.deepEqual(acks, [IRQ_LINE]);
  // masked now: RTI restores CC (I clear) and the IRQ is taken again
  assert.equal(r.cpu.step(), 15);
  assert.equal(r.cpu.pc, 0x1000);
  assert.equal(r.cpu.cc, CC_N | CC_E);
  r.cpu.setIrq(false);
  assert.equal(r.cpu.step(), 2);
  assert.equal(r.cpu.pc, 0x1001);
});

test('FIRQ: 10 cycles, PC+CC only, E clear, I+F set; RTI 6', () => {
  const r = irqRig([0x12]);
  r.cpu.cc = CC_E | CC_C;
  r.cpu.setFirq(1);
  assert.equal(r.cpu.step(), 10);
  assert.equal(r.cpu.pc, 0x3000);
  assert.equal(r.cpu.cc, CC_C | CC_I | CC_F);
  assert.equal(r.cpu.s, 0x7ffd);
  assert.deepEqual([...r.mem.subarray(0x7ffd, 0x8000)], [CC_C, 0x10, 0x00]);
  r.cpu.setFirq(0);
  assert.equal(r.cpu.step(), 6);
  assert.equal(r.cpu.pc, 0x1000);
  assert.equal(r.cpu.cc, CC_C);
});

test('masking and priority: NMI > FIRQ > IRQ; I and F mask', () => {
  const r = irqRig([0x12, 0x12, 0x12]);
  r.cpu.cc = CC_I | CC_F;
  r.cpu.setIrq(1); r.cpu.setFirq(1);
  assert.equal(r.cpu.step(), 2, 'both masked: NOP runs');
  r.cpu.cc = CC_F;                       // IRQ unmasked only
  r.cpu.step();
  assert.equal(r.cpu.pc, 0x2000);
  r.cpu.pc = 0x1000; r.cpu.cc = 0;       // both unmasked: FIRQ wins
  r.cpu.step();
  assert.equal(r.cpu.pc, 0x3000);
  r.cpu.pc = 0x1000; r.cpu.cc = 0;
  r.cpu.ldsEncountered = true;
  r.cpu.nmi();
  r.cpu.step();
  assert.equal(r.cpu.pc, 0x4000, 'NMI wins');
  assert.equal(r.cpu.cc, CC_E | CC_I | CC_F);
});

test('NMI: edge triggered, ignored until S is loaded', () => {
  const r = irqRig([0x12, 0x10, 0xce, 0x80, 0x00, 0x12, 0x12]);
  /** @type {number[]} */
  const acks = [];
  r.cpu.bus.ack = (line) => { acks.push(line); };
  r.cpu.nmi();
  assert.equal(r.cpu.step(), 2, 'not armed: NOP');
  assert.equal(r.cpu.step(), 4, 'LDS #$8000 arms NMI');
  r.cpu.setNmi(1);                        // rising edge latches
  assert.equal(r.cpu.step(), 19);
  assert.equal(r.cpu.pc, 0x4000);
  assert.deepEqual(acks, [NMI_LINE]);
  r.cpu.step();                           // RTI
  assert.equal(r.cpu.pc, 0x1005);
  assert.equal(r.cpu.step(), 2, 'line still high: no new edge');
  r.cpu.setNmi(0); r.cpu.setNmi(1);
  r.cpu.step();
  assert.equal(r.cpu.pc, 0x4000, 'new edge');
  // reset disarms
  r.mem[0xfffe] = 0x10; r.mem[0xffff] = 0x00;
  r.cpu.reset();
  r.cpu.nmi();
  assert.equal(r.cpu.step(), 2);
});

test('SWI/SWI2/SWI3: 19/20/20 cycles, E set, only SWI masks I and F', () => {
  const r = irqRig([0x3f]);
  r.cpu.cc = 0;
  assert.equal(r.cpu.step(), 19);
  assert.equal(r.cpu.pc, 0x5000);
  assert.equal(r.cpu.cc, CC_E | CC_I | CC_F);
  assert.equal(r.mem[0x7ff4], CC_E);
  for (const [p, vec] of [[0x10, 0x5200], [0x11, 0x5300]]) {
    const q = irqRig([p, 0x3f]);
    q.cpu.cc = CC_C;
    assert.equal(q.cpu.step(), 20);
    assert.equal(q.cpu.pc, vec);
    assert.equal(q.cpu.cc, CC_C | CC_E);
    assert.equal(q.mem[0x7ff4], CC_C | CC_E);
    assert.equal(q.mem[0x7ffe] << 8 | q.mem[0x7fff], 0x1002);
  }
});

test('CWAI: stacks at once, waits, then vectors in 4 cycles', () => {
  const r = irqRig([0x3c, 0xef, 0x12]);   // CWAI #$EF (clear I)
  r.cpu.cc = CC_I | CC_F | CC_C;
  assert.equal(r.cpu.step(), 16);
  assert.equal(r.cpu.s, 0x8000 - 12);
  assert.equal(r.mem[0x7ff4], CC_E | CC_F | CC_C, 'stacked CC has E');
  assert.equal(r.cpu.step(), 1, 'idle');
  assert.equal(r.cpu.run(1000), 1000, 'run() burns the budget');
  r.cpu.setFirq(1);                       // still masked by F
  assert.equal(r.cpu.step(), 1);
  r.cpu.setIrq(1);
  assert.equal(r.cpu.step(), 4);
  assert.equal(r.cpu.pc, 0x2000);
  assert.equal(r.cpu.cc, CC_E | CC_F | CC_C | CC_I);
  assert.equal(r.cpu.s, 0x8000 - 12, 'nothing stacked twice');
  r.cpu.setIrq(0); r.cpu.setFirq(0);
  assert.equal(r.cpu.step(), 15, 'RTI pulls the entire state');
  assert.equal(r.cpu.pc, 0x1002);
});

test('CWAI + FIRQ stacks the entire state (E=1) and sets I and F', () => {
  const r = irqRig([0x3c, 0x00]);
  r.cpu.setFirq(1);
  r.cpu.cc = CC_I | CC_F;
  assert.equal(r.cpu.step(), 20, 'pending at once: 16 + 4');
  assert.equal(r.cpu.pc, 0x3000);
  assert.equal(r.cpu.cc, CC_E | CC_I | CC_F);
  assert.equal(r.cpu.s, 0x8000 - 12);
});

test('SYNC: waits for any line; masked line resumes, unmasked is taken', () => {
  const r = irqRig([0x13, 0x12, 0x13, 0x12]);
  r.cpu.cc = CC_I | CC_F;
  assert.equal(r.cpu.step(), 2);
  assert.equal(r.cpu.step(), 1);
  assert.equal(r.cpu.run(500), 500);
  r.cpu.setIrq(1);                         // masked
  assert.equal(r.cpu.step(), 1, 'the cycle after the line is seen');
  assert.equal(r.cpu.step(), 2, 'continues with the NOP');
  assert.equal(r.cpu.pc, 0x1002);
  r.cpu.setIrq(0);
  r.cpu.cc = 0;
  assert.equal(r.cpu.step(), 2);          // SYNC again
  r.cpu.setIrq(1);                         // unmasked
  assert.equal(r.cpu.run(3), 1 + 19, 'wake cycle, then the IRQ entry');
  assert.equal(r.cpu.pc, 0x2000);
  assert.equal(r.mem[0x7ffe] << 8 | r.mem[0x7fff], 0x1003,
    'stacked PC is after SYNC');
});

test('run(): overshoots by at most one instruction and counts cycles', () => {
  const r = rig(new Array(64).fill(0x12));
  assert.equal(r.cpu.run(9), 10);
  assert.equal(r.cpu.cycles, 10);
  assert.equal(r.cpu.pc, 0x1005);
});

// ----------------------------------------------------- undocumented ops

test('undocumented aliases and MAME oddities', () => {
  // $01 = NEG direct, $41 = NEGA, $05 = LSR direct, $1B = NOP
  assert.equal(run1([0x41], { a: 1 }).cpu.a, 0xff);
  assert.equal(run1([0x55], { b: 3 }).cpu.b, 1);
  assert.equal(rig([0x1b]).cpu.step(), 2);
  // XNC: COM when C set, NEG when clear
  assert.equal(run1([0x42], { a: 0x0f, cc: CC_C }).cpu.a, 0xf0);
  assert.equal(run1([0x42], { a: 0x0f, cc: 0 }).cpu.a, 0xf1);
  // XDEC: C = (operand != 0)
  const xd = run1([0x4b], { a: 0, cc: 0 });
  assert.equal(xd.cpu.a, 0xff);
  assert.equal(xd.cpu.cc, CC_N);
  assert.equal(run1([0x4b], { a: 5, cc: 0 }).cpu.cc & CC_C, CC_C);
  // XCLR: clears N/Z/V, sets Z, keeps C
  const xc = run1([0x5e], { b: 0x80, cc: CC_C | CC_N });
  assert.equal(xc.cpu.b, 0);
  assert.equal(xc.cpu.cc, CC_C | CC_Z);
  // X18: CC = ((CC & [PC]) << 1) | (Z >> 1), PC += 1, 2 cycles
  const x18 = rig([0x18, 0x0f]);
  x18.cpu.cc = CC_Z | CC_C | CC_H;
  assert.equal(x18.cpu.step(), 2);
  assert.equal(x18.cpu.pc, 0x1001);
  assert.equal(x18.cpu.cc, ((CC_Z | CC_C) << 1) | CC_V);
  // XANDCC: 4 cycles
  const xa = rig([0x38, 0x0f]);
  xa.cpu.cc = 0xff;
  assert.equal(xa.cpu.step(), 4);
  assert.equal(xa.cpu.cc, 0x0f);
});

test('XSTA/XSTX immediate: flags from the register; XSTX writes PC', () => {
  const a = rig([0x87, 0x55]);
  a.cpu.a = 0x80; a.cpu.cc = CC_V;
  assert.equal(a.cpu.step(), 2);
  assert.equal(a.cpu.pc, 0x1002);
  assert.equal(a.cpu.cc, CC_N);
  assert.equal(a.mem[0x1001], 0x55, 'nothing stored');
  const x = rig([0x8f, 0x11, 0x22]);
  x.cpu.x = 0xab00;
  assert.equal(x.cpu.step(), 3);
  assert.equal(x.cpu.pc, 0x1003);
  assert.equal(x.mem[0x1002], 0x00, 'low byte of X over the 2nd operand');
  assert.equal(x.cpu.cc, CC_N);
  const y = rig([0x10, 0x8f, 0x11, 0x22]);
  y.cpu.y = 0x0034;
  assert.equal(y.cpu.step(), 4);
  assert.equal(y.mem[0x1003], 0x34);
});

test('XADDD/XADDU set flags like ADD but store nothing', () => {
  const r = rig([0x10, 0xc3, 0x00, 0x01, 0x11, 0xc3, 0x80, 0x00]);
  r.cpu.d = 0xffff; r.cpu.u = 0x8000;
  assert.equal(r.cpu.step(), 5);
  assert.equal(r.cpu.d, 0xffff);
  assert.equal(r.cpu.cc, CC_Z | CC_C);
  assert.equal(r.cpu.step(), 5);
  assert.equal(r.cpu.u, 0x8000);
  assert.equal(r.cpu.cc, CC_Z | CC_V | CC_C);
});

test('XRES/XSWI2/XFIRQ push everything without setting E', () => {
  for (const [code, vec, cyc] of [
    [[0x3e], 0xfffe, 19], [[0x10, 0x3e], 0xfff4, 20],
    [[0x11, 0x3e], 0xfff6, 20],
  ]) {
    const r = rig(/** @type {number[]} */ (code));
    r.mem[/** @type {number} */ (vec)] = 0x60;
    r.mem[/** @type {number} */ (vec) + 1] = 0x00;
    r.cpu.cc = CC_C;
    assert.equal(r.cpu.step(), cyc);
    assert.equal(r.cpu.pc, 0x6000);
    assert.equal(r.cpu.cc, CC_C);
    assert.equal(r.mem[0x7ff4], CC_C, 'stacked CC without E');
  }
});

test('page 2/3: undefined byte is skipped and the NEXT byte runs', () => {
  // $10 $01 $86 $42: MAME drops $10 $01 and executes LDA #$42 in the
  // same step (2 + 2 cycles)
  const r = rig([0x10, 0x01, 0x86, 0x42]);
  /** @type {number[]} */
  const seen = [];
  r.cpu.onUndocumented = (_pc, op) => { seen.push(op); };
  assert.equal(r.cpu.step(), 4);
  assert.equal(r.cpu.a, 0x42);
  assert.equal(r.cpu.pc, 0x1004);
  assert.deepEqual(seen, [0x1001]);
  // chained prefixes keep the first page: $10 $11 $8E = LDY #
  const q = rig([0x10, 0x11, 0x8e, 0x12, 0x34]);
  assert.equal(q.cpu.step(), 5);
  assert.equal(q.cpu.y, 0x1234);
  // $11 $10 $83 = CMPU #
  const u = rig([0x11, 0x10, 0x83, 0x70, 0x00]);
  u.cpu.step();
  assert.ok(u.cpu.cc & CC_Z);
  // XLBRA ($10 $20) always branches, 6 cycles
  const b = rig([0x10, 0x20, 0x00, 0x10]);
  b.cpu.cc = 0x0f;
  assert.equal(b.cpu.step(), 6);
  assert.equal(b.cpu.pc, 0x1014);
});

test('free-run ($14/$15/$CD): one fetch per cycle until reset', () => {
  for (const op of [0x14, 0x15, 0xcd]) {
    const r = rig([op, 0x86, 0x42]);
    r.mem[0xfffe] = 0x10; r.mem[0xffff] = 0x01;
    assert.equal(r.cpu.step(), 1);
    assert.equal(r.cpu.step(), 1);
    assert.equal(r.cpu.step(), 1);
    assert.equal(r.cpu.pc, 0x1003);
    assert.equal(r.cpu.a, 0, 'nothing executes');
    r.cpu.reset();
    r.cpu.step();
    assert.equal(r.cpu.a, 0x42, 'reset leaves free-run mode');
  }
});

test('onUndocumented reports every undocumented opcode, only those', () => {
  /** @type {number[]} */
  const seen = [];
  for (let op = 0; op < 256; op += 1) {
    if (op === 0x10 || op === 0x11) continue;
    const r = rig([op, 0x84, 0x00, 0x00]);
    r.cpu.onUndocumented = (_pc, o) => { seen.push(o); };
    r.cpu.cc = CC_I | CC_F;
    r.cpu.setIrq(1);                        // lets SYNC/CWAI finish
    r.cpu.step();
  }
  const want = PAGE1.flatMap((e, op) => (e !== null && e.undoc ? [op] : []));
  assert.deepEqual(seen, want);
  assert.ok(want.includes(0x01) && want.includes(0x3e) && !want.includes(0x12));
});

// ----------------------------------------------------- whole programs

/**
 * Step until PC reaches `stop`, checking every instruction's cycle count
 * against the table-driven model. Returns total cycles.
 * @param {Rig} r @param {number} stop @param {number} [limit]
 */
function runChecked(r, stop, limit = 1e6) {
  let total = 0;
  const read = (/** @type {number} */ a) => r.mem[a];
  for (let n = 0; r.cpu.pc !== stop; n += 1) {
    if (n >= limit) assert.fail('program did not finish');
    const want = expectedCycles(read, r.cpu.pc, r.cpu);
    const pc = r.cpu.pc;
    const got = r.cpu.step();
    if (want !== null && got !== want) {
      assert.fail(`at ${pc.toString(16)}: ${got} cycles, model ${want}`);
    }
    total += got;
  }
  return total;
}

test('program: bubble sort, BCD sum and 16-bit Fibonacci run to the end', () => {
  // Hand-assembled; addresses on the left.
  const prog = [
    // 1000 sort 8 bytes at $2000 ascending (bubble sort)
    0x10, 0xce, 0x80, 0x00,   // 1000 LDS   #$8000
    0xc6, 0x07,               // 1004 LDB   #7          passes
    0x34, 0x04,               // 1006 PSHS  B    outer:
    0x8e, 0x20, 0x00,         // 1008 LDX   #$2000
    0xa6, 0x84,               // 100B LDA   ,X   inner:
    0xa1, 0x01,               // 100D CMPA  1,X
    0x23, 0x06,               // 100F BLS   $1017
    0xe6, 0x01,               // 1011 LDB   1,X
    0xa7, 0x01,               // 1013 STA   1,X
    0xe7, 0x84,               // 1015 STB   ,X
    0x30, 0x01,               // 1017 LEAX  1,X
    0x8c, 0x20, 0x07,         // 1019 CMPX  #$2007
    0x26, 0xed,               // 101C BNE   $100B
    0x35, 0x04,               // 101E PULS  B
    0x5a,                     // 1020 DECB
    0x26, 0xe3,               // 1021 BNE   $1006
    // 1023 BCD-sum the 4 bytes at $2010 into A (with carry count in B)
    0x8e, 0x20, 0x10,         // 1023 LDX   #$2010
    0x4f,                     // 1026 CLRA
    0x5f,                     // 1027 CLRB
    0xab, 0x80,               // 1028 ADDA  ,X+  loop:
    0x19,                     // 102A DAA
    0xc9, 0x00,               // 102B ADCB  #0
    0x8c, 0x20, 0x14,         // 102D CMPX  #$2014
    0x26, 0xf6,               // 1030 BNE   $1028
    0xfd, 0x20, 0x20,         // 1032 STD   $2020
    // 1035 Fibonacci: 24 terms of 16-bit words at $2100 via BSR/RTS
    0xce, 0x21, 0x00,         // 1035 LDU   #$2100
    0xcc, 0x00, 0x01,         // 1038 LDD   #1
    0xed, 0xc1,               // 103B STD   ,U++
    0xed, 0xc1,               // 103D STD   ,U++
    0x86, 0x16,               // 103F LDA   #22
    0x34, 0x02,               // 1041 PSHS  A    loop:
    0x8d, 0x0a,               // 1043 BSR   $104F
    0x35, 0x02,               // 1045 PULS  A
    0x4a,                     // 1047 DECA
    0x26, 0xf7,               // 1048 BNE   $1041
    0x7e, 0x10, 0x60,         // 104A JMP   $1060   (done)
    0x12, 0x12,               // 104D NOP NOP
    // 104F next term: D = [-4,U] + [-2,U]; store; U += 2
    0xec, 0x5c,               // 104F LDD   -4,U
    0xe3, 0x5e,               // 1051 ADDD  -2,U
    0xed, 0xc1,               // 1053 STD   ,U++
    0x39,                     // 1055 RTS
  ];
  const r = rig(prog);
  const data = [0x42, 0x07, 0xff, 0x00, 0x99, 0x10, 0x80, 0x07];
  r.mem.set(data, 0x2000);
  r.mem.set([0x99, 0x45, 0x01, 0x38], 0x2010);
  const total = runChecked(r, 0x1060);
  assert.deepEqual([...r.mem.subarray(0x2000, 0x2008)],
    [...data].sort((x, y) => x - y));
  // 99 + 45 + 01 + 38 = 183 -> A=$83, one decimal carry
  assert.deepEqual([r.mem[0x2020], r.mem[0x2021]], [0x83, 0x01]);
  const fib = [1, 1];
  while (fib.length < 24) fib.push(fib[fib.length - 1] + fib[fib.length - 2]);
  for (let i = 0; i < 24; i += 1) {
    const w = r.mem[0x2100 + 2 * i] << 8 | r.mem[0x2101 + 2 * i];
    assert.equal(w, fib[i] & 0xffff, `fib ${i}`);
  }
  assert.equal(r.cpu.s, 0x8000);
  assert.ok(total > 1000);
});

test('speed: at least a few million cycles per second', () => {
  // a tight countdown loop: LDX #$FFFF / LEAX -1,X / BNE
  const r = rig([0x8e, 0xff, 0xff, 0x30, 0x1f, 0x26, 0xfc, 0x20, 0xfe]);
  const t0 = performance.now();
  const cyc = r.cpu.run(3_000_000);
  const ms = performance.now() - t0;
  assert.ok(cyc >= 3_000_000);
  // generous floor so a loaded machine does not flake
  assert.ok(ms < 3000, `${ms} ms for 3M cycles`);
});

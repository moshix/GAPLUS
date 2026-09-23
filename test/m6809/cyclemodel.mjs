// Copyright 2026 by Moshix
/**
 * Test support: predict how many cycles the next instruction will take,
 * from the static opcode table (opcodes.mjs) plus the few run-time facts
 * that change the count (branch taken, E flag seen by RTI, register
 * lists). It shares no code with the CPU core, which counts its cycles bus
 * access by bus access, so agreement between the two over real programs
 * (the unit tests and the Gaplus ROM smoke test) is an independent check.
 */

import { PAGE1, PAGE2, PAGE3, INDEXED_EXTRA } from './opcodes.mjs';

/**
 * Motorola branch conditions, written from the programming manual's
 * boolean definitions.
 * @param {number} n low nibble of the branch opcode
 * @param {number} cc condition codes
 * @returns {boolean}
 */
export function branchTaken(n, cc) {
  const c = (cc & 1) !== 0;
  const v = (cc & 2) !== 0;
  const z = (cc & 4) !== 0;
  const neg = (cc & 8) !== 0;
  const t = [
    true, false, !(c || z), c || z, !c, c, !z, z,
    !v, v, !neg, neg, neg === v, neg !== v, !z && neg === v, z || neg !== v,
  ];
  return t[n];
}

/**
 * Bytes moved by a push/pull postbyte.
 * @param {number} pb
 * @returns {number}
 */
export function stackBytes(pb) {
  let n = 0;
  for (let bit = 0; bit < 8; bit += 1) {
    if (pb & (1 << bit)) n += bit >= 4 ? 2 : 1;
  }
  return n;
}

/**
 * @typedef {object} Regs
 * @property {number} cc @property {number} s
 */

/**
 * Cycles the instruction at `pc` will take, or null when the count
 * depends on the outside world (SYNC, CWAI, the free-run opcodes, page
 * 2/3 fall-through).
 * @param {(addr: number) => number} read
 * @param {number} pc
 * @param {Regs} regs
 * @returns {number|null}
 */
export function expectedCycles(read, pc, regs) {
  let p = pc;
  const next = () => { const v = read(p & 0xffff); p += 1; return v; };
  let op = next();
  let info = PAGE1[op];
  let extra = 0;
  let paged = false;
  if (info !== null && info.mode === 'page') {
    const table = op === 0x10 ? PAGE2 : PAGE3;
    op = next();
    // every additional prefix byte is one more fetch cycle
    while (op === 0x10 || op === 0x11) { op = next(); extra += 1; }
    info = table[op];
    paged = true;
  }
  if (info === null) return null;
  switch (info.name) {
    case 'SYNC': case 'CWAI': case 'XHCF': return null;
    case 'RTI': return (read(regs.s) & 0x80) ? 15 : 6;
    default: break;
  }
  let cyc = info.cycles + extra;
  switch (info.mode) {
    case 'idx': cyc += INDEXED_EXTRA[read(p & 0xffff)]; break;
    case 'pshs': case 'puls': case 'pshu': case 'pulu':
      cyc += stackBytes(read(p & 0xffff));
      break;
    case 'rel16':
      // long conditional branches cost one more cycle when taken
      if (paged && branchTaken(op & 0x0f, regs.cc)) cyc += 1;
      break;
    default: break;
  }
  return cyc;
}

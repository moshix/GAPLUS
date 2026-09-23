// Copyright 2026 by Moshix
/**
 * MC6809 disassembler: a library for the listing/flow tools and a CLI.
 *
 * Syntax follows MAME's 6x09dasm.cpp (Motorola style, upper case, `$` hex,
 * mnemonic padded to 7 columns), e.g.
 *   LDA    <$12        direct
 *   LDX    #$1234      immediate
 *   JSR    [$FFFE]     extended indirect
 *   LEAX   $5,Y        5-bit offset (MAME prints these without padding)
 *   LDA    $05,Y       8-bit offset
 *   STB    $E123,PCR   PC-relative, shown as the absolute address
 *   PSHS   U,Y,X,DP,D  register lists in MAME's order, A+B shown as D
 *
 * Decoding follows the CPU core (test/m6809/m6809.mjs), which follows
 * MAME's m6809 execution core. Where MAME's own disassembler disagrees with
 * MAME's core the core wins, because flow analysis must follow what runs:
 *  - "$10 xx" / "$11 xx" with xx not a page 2/3 opcode is shown as
 *    `FCB $10,$xx` (2 bytes) -- the core consumes both bytes and runs the
 *    NEXT byte as an opcode;
 *  - extra prefixes keep the first page ($10 $11 $8E is LDY #);
 *  - indexed postbytes that are undefined on the 6809 are shown as the
 *    core executes them: x7/xA/xE as `inv,R` (EA = $0000) and $8F-style as
 *    `$nnnn,inv` (an absolute address); the MAME disassembler prints 6309
 *    E/F/W forms there.
 *
 * CLI:
 *   node tools/m6809dis.mjs [--dp HH] [--from AAAA] [--to AAAA]
 *                           file@AAAA [file@AAAA ...]
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  PAGE1, PAGE2, PAGE3, TFR_REGS,
} from '../test/m6809/opcodes.mjs';

/** Index register names by postbyte bits 5-6. */
const IREGS = ['X', 'Y', 'U', 'S'];

/** @param {number} v @param {number} [w] @returns {string} */
export const hex = (v, w = 2) =>
  '$' + v.toString(16).toUpperCase().padStart(w, '0');

/**
 * @typedef {'jump'|'branch'|'call'|'return'|'other'} Kind
 */

/**
 * @typedef {object} Instr
 * @property {number} addr      address of the first byte
 * @property {string} text      e.g. "LDA    <$12"
 * @property {number} len       bytes consumed
 * @property {number[]} bytes   the instruction bytes
 * @property {number|null} target  static jump/branch/call destination
 * @property {Kind} kind        control-flow class
 * @property {boolean} cond     conditional branch
 * @property {boolean} undoc    undocumented opcode or postbyte
 * @property {number|null} ref  absolute memory operand (extended, direct
 *   when a DP is given, PC-relative, or the pointer of [n16])
 */

/**
 * @typedef {object} DisOptions
 * @property {number=} dp  direct page, to resolve `<$nn` into `ref`/`target`
 */

/**
 * Decode an indexed postbyte (the postbyte has already been read).
 * @param {number} pb postbyte
 * @param {() => number} next reads the next operand byte
 * @param {() => number} where current address (after bytes read so far)
 * @returns {{text: string, ea: number|null, undoc: boolean}} ea is the
 *   static effective address when known (PC-relative or [n16] pointer)
 */
function indexed(pb, next, where) {
  const reg = IREGS[(pb >> 5) & 3];
  if ((pb & 0x80) === 0) {
    const off = ((pb & 0x1f) ^ 0x10) - 0x10;
    const t = (off < 0 ? '-' : '') + '$' +
      Math.abs(off).toString(16).toUpperCase() + ',' + reg;
    return { text: t, ea: null, undoc: false };
  }
  const ind = (pb & 0x10) !== 0;
  let t;
  /** @type {number|null} */
  let ea = null;
  let undoc = false;
  switch (pb & 0x0f) {
    case 0x0: t = `,${reg}+`; undoc = ind; break;
    case 0x1: t = `,${reg}++`; break;
    case 0x2: t = `,-${reg}`; undoc = ind; break;
    case 0x3: t = `,--${reg}`; break;
    case 0x4: t = `,${reg}`; break;
    case 0x5: t = `B,${reg}`; break;
    case 0x6: t = `A,${reg}`; break;
    case 0x8: {
      const off = (next() << 24) >> 24;
      t = (off < 0 ? '-' : '') + hex(Math.abs(off)) + ',' + reg;
      break;
    }
    case 0x9: {
      const off = ((next() << 8 | next()) << 16) >> 16;
      t = (off < 0 ? '-' : '') + hex(Math.abs(off), 4) + ',' + reg;
      break;
    }
    case 0xb: t = `D,${reg}`; break;
    case 0xc: {
      const off = (next() << 24) >> 24;
      ea = (where() + off) & 0xffff;
      t = hex(ea, 4) + ',PCR';
      break;
    }
    case 0xd: {
      const off = next() << 8 | next();
      ea = (where() + off) & 0xffff;
      t = hex(ea, 4) + ',PCR';
      break;
    }
    case 0xf: {
      const a = next() << 8 | next();
      if (ind) {
        t = hex(a, 4);
        ea = a;
      } else {
        t = hex(a, 4) + ',inv';
        ea = a;
        undoc = true;
      }
      break;
    }
    default: // x7, xA, xE
      t = `inv,${reg}`;
      undoc = true;
      break;
  }
  return { text: ind ? `[${t}]` : t, ea, undoc };
}

/**
 * PSHS/PSHU register list, MAME order (PC first).
 * @param {number} pb @param {string} other "U" for PSHS, "S" for PSHU
 * @returns {string}
 */
function pushList(pb, other) {
  const r = [];
  if (pb & 0x80) r.push('PC');
  if (pb & 0x40) r.push(other);
  if (pb & 0x20) r.push('Y');
  if (pb & 0x10) r.push('X');
  if (pb & 0x08) r.push('DP');
  if (pb & 0x04) r.push(pb & 0x02 ? 'D' : 'B');
  else if (pb & 0x02) r.push('A');
  if (pb & 0x01) r.push('CC');
  return r.join(',');
}

/**
 * PULS/PULU register list, MAME order (CC first).
 * @param {number} pb @param {string} other
 * @returns {string}
 */
function pullList(pb, other) {
  const r = [];
  if (pb & 0x01) r.push('CC');
  if (pb & 0x02) r.push(pb & 0x04 ? 'D' : 'A');
  else if (pb & 0x04) r.push('B');
  if (pb & 0x08) r.push('DP');
  if (pb & 0x10) r.push('X');
  if (pb & 0x20) r.push('Y');
  if (pb & 0x40) r.push(other);
  if (pb & 0x80) r.push('PC');
  return r.join(',');
}

/**
 * Disassemble one instruction.
 * @param {(addr: number) => number} read byte reader
 * @param {number} addr
 * @param {DisOptions} [opts]
 * @returns {Instr}
 */
export function disasm(read, addr, opts = {}) {
  let p = addr;
  const next = () => { const v = read(p & 0xffff) & 0xff; p += 1; return v; };
  const where = () => p & 0xffff;
  /** @type {Instr} */
  const out = {
    addr, text: '', len: 0, bytes: [], target: null, kind: 'other',
    cond: false, undoc: false, ref: null,
  };

  let op = next();
  let info = PAGE1[op];
  if (info !== null && info.mode === 'page') {
    const table = op === 0x10 ? PAGE2 : PAGE3;
    op = next();
    // Further prefixes keep the first page; give up after a silly run.
    for (let n = 0; (op === 0x10 || op === 0x11) && n < 8; n += 1) op = next();
    info = op === 0x10 || op === 0x11 ? null : table[op];
    if (info === null) {
      const b = [];
      for (let a = addr; a < p; a += 1) b.push(hex(read(a & 0xffff) & 0xff));
      out.text = 'FCB'.padEnd(7) + b.join(',');
      out.undoc = true;
      return finish(out, p, read);
    }
  }
  if (info === null) throw new Error('opcode table hole'); // not reachable
  out.undoc = info.undoc;
  out.kind = info.flow;
  out.cond = info.flow === 'branch';

  let ops = '';
  switch (info.mode) {
    case 'inh':
    case 'page':
      break;
    case 'imm8': ops = '#' + hex(next()); break;
    case 'imm16': ops = '#' + hex(next() << 8 | next(), 4); break;
    case 'dir': {
      const n = next();
      ops = '<' + hex(n);
      if (opts.dp !== undefined) out.ref = ((opts.dp & 0xff) << 8) | n;
      break;
    }
    case 'ext': {
      const a = next() << 8 | next();
      // MAME: '>' forces extended when the address would fit direct page 0
      ops = ((a & 0xff00) === 0 ? '>' : '') + hex(a, 4);
      out.ref = a;
      break;
    }
    case 'idx': {
      const x = indexed(next(), next, where);
      ops = x.text;
      if (x.undoc) out.undoc = true;
      out.ref = x.ea;
      // A PC-relative jump is statically known; an indirect one is not.
      if (x.ea !== null && ops.endsWith(',PCR')) out.target = x.ea;
      break;
    }
    case 'rel8': {
      const off = (next() << 24) >> 24;
      out.target = (p + off) & 0xffff;
      ops = hex(out.target, 4);
      break;
    }
    case 'rel16': {
      const off = next() << 8 | next();
      out.target = (p + off) & 0xffff;
      ops = hex(out.target, 4);
      break;
    }
    case 'rr': {
      const pb = next();
      ops = TFR_REGS[pb >> 4] + ',' + TFR_REGS[pb & 15];
      // Writing PC makes TFR/EXG a computed jump.
      if ((pb & 15) === 5 || (info.name === 'EXG' && (pb >> 4) === 5)) {
        out.kind = 'jump';
      }
      break;
    }
    case 'pshs': ops = pushList(next(), 'U'); break;
    case 'pshu': ops = pushList(next(), 'S'); break;
    case 'puls':
    case 'pulu': {
      const pb = next();
      ops = pullList(pb, info.mode === 'puls' ? 'U' : 'S');
      if (pb & 0x80) out.kind = 'return';
      break;
    }
    default:
      throw new Error(`unknown mode ${info.mode}`);
  }

  // Direct/extended JMP/JSR targets are the effective address itself.
  if ((info.name === 'JMP' || info.name === 'JSR') &&
      (info.mode === 'ext' || info.mode === 'dir')) {
    out.target = out.ref;
  }
  if (info.name === 'BRN' || info.name === 'LBRN') out.target = null;

  out.text = ops === '' ? info.name : info.name.padEnd(7) + ops;
  return finish(out, p, read);
}

/**
 * @param {Instr} out @param {number} p @param {(a: number) => number} read
 * @returns {Instr}
 */
function finish(out, p, read) {
  out.len = p - out.addr;
  for (let a = out.addr; a < p; a += 1) out.bytes.push(read(a & 0xffff) & 0xff);
  return out;
}

/**
 * Linear sweep from `from` (inclusive) to `to` (exclusive).
 * @param {(addr: number) => number} read
 * @param {number} from @param {number} to
 * @param {DisOptions} [opts]
 * @returns {Generator<Instr>}
 */
export function* disasmRange(read, from, to, opts = {}) {
  for (let a = from; a < to;) {
    const ins = disasm(read, a, opts);
    yield ins;
    a += ins.len;
  }
}

/**
 * One listing line: "E000: 10 CE 0B FF     LDS    #$0BFF", cut to 79
 * columns.
 * @param {Instr} ins
 * @returns {string}
 */
export function formatLine(ins) {
  const b = ins.bytes.map((v) => v.toString(16).toUpperCase().padStart(2, '0'));
  const line = ins.addr.toString(16).toUpperCase().padStart(4, '0') + ': ' +
    b.join(' ').padEnd(15) + ' ' + ins.text;
  return line.length > 79 ? line.slice(0, 79) : line;
}

/** @param {string} s @returns {number} */
function parseHex(s) {
  const v = Number.parseInt(s.replace(/^\$|^0x/i, ''), 16);
  if (!Number.isFinite(v)) throw new Error(`bad hex number: ${s}`);
  return v;
}

/**
 * CLI entry point.
 * @param {string[]} argv
 * @returns {void}
 */
function main(argv) {
  const mem = new Uint8Array(0x10000);
  let from = -1;
  let to = -1;
  let lo = 0x10000;
  let hi = 0;
  /** @type {DisOptions} */
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from') from = parseHex(argv[++i] ?? '');
    else if (arg === '--to') to = parseHex(argv[++i] ?? '');
    else if (arg === '--dp') opts.dp = parseHex(argv[++i] ?? '');
    else if (arg === '-h' || arg === '--help') {
      console.log('usage: node tools/m6809dis.mjs [--dp HH] [--from AAAA]');
      console.log('         [--to AAAA] file@AAAA [file@AAAA ...]');
      return;
    } else {
      const at = arg.lastIndexOf('@');
      if (at < 0) throw new Error(`expected file@address, got ${arg}`);
      const base = parseHex(arg.slice(at + 1));
      const data = readFileSync(arg.slice(0, at));
      mem.set(data.subarray(0, 0x10000 - base), base);
      lo = Math.min(lo, base);
      hi = Math.max(hi, Math.min(0x10000, base + data.length));
    }
  }
  if (hi === 0) {
    console.error('no input files (try --help)');
    process.exitCode = 1;
    return;
  }
  const read = (/** @type {number} */ a) => mem[a];
  for (const ins of disasmRange(read, from < 0 ? lo : from,
    to < 0 ? hi : to, opts)) {
    console.log(formatLine(ins));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}

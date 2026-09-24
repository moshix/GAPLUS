// Copyright 2026 by Moshix
/**
 * MC6809 opcode table shared by the disassembler (tools/m6809dis.mjs), the
 * unit tests, and -- for the "undocumented opcode" hook only -- the CPU core.
 *
 * The core does NOT take its cycle counts from here. It counts every bus
 * cycle as it performs it, transcribed from MAME's microcode
 * (reference/mame/m6809/m6809.lst + base6x09.lst). The `cycles` column below
 * is written down independently, from the Motorola datasheet for documented
 * opcodes and from the same MAME microcode for undocumented ones, so that the
 * unit test comparing the two is a genuine cross-check.
 *
 * Cycle conventions (all in E-clock cycles, i.e. MAME's m6809 cycles):
 *  - `idx` entries give the count for the ",R" postbyte ($84); other
 *    postbytes add INDEXED_EXTRA[postbyte] (which can be negative for the
 *    undefined postbytes, see there).
 *  - Conditional long branches give the not-taken count; taken costs +1.
 *    Short branches (Bcc) are 3 cycles either way.
 *  - PSHS/PULS/PSHU/PULU give the count for an empty register list; each
 *    byte pushed or pulled adds one cycle (PC/U/S/X/Y are two bytes).
 *  - RTI gives the E=0 figure (6); with E=1 it is 15.
 *  - SYNC gives 3: MAME charges opcode fetch + one dummy cycle + one cycle
 *    after the interrupt line is seen. The datasheet quotes ">= 4"; MAME is
 *    the reference for this project.
 *  - CWAI gives 20: the time when an interrupt is already pending (no wait).
 *  - Mnemonics of undocumented opcodes follow MAME's 6x09dasm (XNC, XDEC,
 *    XCLR, XHCF, X18, XANDCC, XRES, XST*, XADD*, XSWI2, XFIRQ, XLBRA).
 */

/**
 * @typedef {'inh'|'imm8'|'imm16'|'dir'|'idx'|'ext'|'rel8'|'rel16'|'rr'|
 *   'pshs'|'puls'|'pshu'|'pulu'|'page'} Mode
 */

/** @typedef {'jump'|'branch'|'call'|'return'|'other'} Flow */

/**
 * @typedef {object} OpInfo
 * @property {string} name     mnemonic, MAME 6x09dasm spelling
 * @property {Mode} mode       addressing mode / operand format
 * @property {number} cycles   see the conventions above
 * @property {boolean} undoc   not in the Motorola documentation
 * @property {Flow} flow       static control-flow class (TFR/EXG/PULS
 *                             only become jumps/returns for some operands)
 */

/** Operand bytes that follow the opcode, per mode (idx is variable). */
export const MODE_LEN = Object.freeze({
  inh: 0, imm8: 1, imm16: 2, dir: 1, idx: 1, ext: 2, rel8: 1, rel16: 2,
  rr: 1, pshs: 1, puls: 1, pshu: 1, pulu: 1, page: 0,
});

/** @type {(OpInfo|null)[]} unprefixed opcodes */
export const PAGE1 = new Array(256).fill(null);
/** @type {(OpInfo|null)[]} opcodes after a $10 prefix */
export const PAGE2 = new Array(256).fill(null);
/** @type {(OpInfo|null)[]} opcodes after a $11 prefix */
export const PAGE3 = new Array(256).fill(null);

const JUMPS = new Set(['JMP', 'BRA', 'LBRA', 'XLBRA']);
const CALLS = new Set([
  'JSR', 'BSR', 'LBSR', 'SWI', 'SWI2', 'SWI3', 'XSWI2', 'XFIRQ', 'XRES',
]);
const RETURNS = new Set(['RTS', 'RTI']);

/**
 * Classify a mnemonic for flow analysis.
 * @param {string} name @param {Mode} mode @returns {Flow}
 */
function flowOf(name, mode) {
  if (JUMPS.has(name)) return 'jump';
  if (CALLS.has(name)) return 'call';
  if (RETURNS.has(name)) return 'return';
  // Every other relative-addressed opcode is a conditional branch, except
  // BRN/LBRN which never branch.
  if ((mode === 'rel8' || mode === 'rel16') && name !== 'BRN' &&
      name !== 'LBRN') return 'branch';
  return 'other';
}

/**
 * @param {(OpInfo|null)[]} page @param {number} op @param {string} name
 * @param {Mode} mode @param {number} cycles @param {boolean} [undoc]
 */
function def(page, op, name, mode, cycles, undoc = false) {
  page[op] = Object.freeze({
    name, mode, cycles, undoc, flow: flowOf(name, mode),
  });
}

// ---------------------------------------------------------------- page 1

// $00-$0F direct, $40 A, $50 B, $60 indexed, $70 extended: the
// read-modify-write column. Entries marked * are MAME's undocumented aliases
// ($01 = NEG, $05 = LSR) and oddities (XNC, XDEC; XCLR only on A/B).
const RMW = [
  ['NEG', 0], ['NEG', 1], ['XNC', 1], ['COM', 0], ['LSR', 0], ['LSR', 1],
  ['ROR', 0], ['ASR', 0], ['ASL', 0], ['ROL', 0], ['DEC', 0], ['XDEC', 1],
  ['INC', 0], ['TST', 0], ['JMP', 0], ['CLR', 0],
];
for (let n = 0; n < 16; n += 1) {
  const [name, u] = /** @type {[string, number]} */ (RMW[n]);
  const jmp = name === 'JMP';
  def(PAGE1, 0x00 + n, name, 'dir', jmp ? 3 : 6, u === 1);
  def(PAGE1, 0x60 + n, name, 'idx', jmp ? 3 : 6, u === 1);
  def(PAGE1, 0x70 + n, name, 'ext', jmp ? 4 : 7, u === 1);
  if (jmp) {
    // $4E/$5E are "XCLRA/XCLRB": CLR that leaves C alone.
    def(PAGE1, 0x4e, 'XCLRA', 'inh', 2, true);
    def(PAGE1, 0x5e, 'XCLRB', 'inh', 2, true);
  } else {
    def(PAGE1, 0x40 + n, name + 'A', 'inh', 2, u === 1);
    def(PAGE1, 0x50 + n, name + 'B', 'inh', 2, u === 1);
  }
}

def(PAGE1, 0x10, 'PAGE2', 'page', 1);
def(PAGE1, 0x11, 'PAGE3', 'page', 1);
def(PAGE1, 0x12, 'NOP', 'inh', 2);
def(PAGE1, 0x13, 'SYNC', 'inh', 3);
// $14/$15/$CD: "halt and catch fire" -- the CPU free-runs the address bus
// (one fetch per cycle, PC incrementing) until reset.
def(PAGE1, 0x14, 'XHCF', 'inh', 1, true);
def(PAGE1, 0x15, 'XHCF', 'inh', 1, true);
def(PAGE1, 0x16, 'LBRA', 'rel16', 5);
def(PAGE1, 0x17, 'LBSR', 'rel16', 9);
def(PAGE1, 0x18, 'X18', 'inh', 2, true);
def(PAGE1, 0x19, 'DAA', 'inh', 2);
def(PAGE1, 0x1a, 'ORCC', 'imm8', 3);
def(PAGE1, 0x1b, 'NOP', 'inh', 2, true);
def(PAGE1, 0x1c, 'ANDCC', 'imm8', 3);
def(PAGE1, 0x1d, 'SEX', 'inh', 2);
def(PAGE1, 0x1e, 'EXG', 'rr', 8);
def(PAGE1, 0x1f, 'TFR', 'rr', 6);

const BRANCHES = [
  'BRA', 'BRN', 'BHI', 'BLS', 'BCC', 'BCS', 'BNE', 'BEQ',
  'BVC', 'BVS', 'BPL', 'BMI', 'BGE', 'BLT', 'BGT', 'BLE',
];
for (let n = 0; n < 16; n += 1) {
  def(PAGE1, 0x20 + n, BRANCHES[n], 'rel8', 3);
  // Page 2 long branches. $10 $20 is not in the datasheet but MAME runs it
  // as an always-taken long branch (6 cycles); it is recorded as 5 + taken.
  def(PAGE2, 0x20 + n, n === 0 ? 'XLBRA' : 'L' + BRANCHES[n], 'rel16', 5,
    n === 0);
}

def(PAGE1, 0x30, 'LEAX', 'idx', 4);
def(PAGE1, 0x31, 'LEAY', 'idx', 4);
def(PAGE1, 0x32, 'LEAS', 'idx', 4);
def(PAGE1, 0x33, 'LEAU', 'idx', 4);
def(PAGE1, 0x34, 'PSHS', 'pshs', 5);
def(PAGE1, 0x35, 'PULS', 'puls', 5);
def(PAGE1, 0x36, 'PSHU', 'pshu', 5);
def(PAGE1, 0x37, 'PULU', 'pulu', 5);
def(PAGE1, 0x38, 'XANDCC', 'imm8', 4, true);
def(PAGE1, 0x39, 'RTS', 'inh', 5);
def(PAGE1, 0x3a, 'ABX', 'inh', 3);
def(PAGE1, 0x3b, 'RTI', 'inh', 6);
def(PAGE1, 0x3c, 'CWAI', 'imm8', 20);
def(PAGE1, 0x3d, 'MUL', 'inh', 11);
def(PAGE1, 0x3e, 'XRES', 'inh', 19, true);
def(PAGE1, 0x3f, 'SWI', 'inh', 19);

// $80-$FF: the accumulator/16-bit column. Low nibble selects the operation,
// bits 4-5 the mode (imm, dir, idx, ext), bit 6 the register (A or B side).
const MODES = /** @type {Mode[]} */ (['imm8', 'dir', 'idx', 'ext']);
/** Cycles of an 8-bit ALU op per mode (imm, dir, idx, ext). */
const C8 = [2, 4, 4, 5];
/** SUBD/ADDD/CMPX: imm, dir, idx, ext. */
const C16ALU = [4, 6, 6, 7];
/** 16-bit load/store: imm, dir, idx, ext. */
const C16LD = [3, 5, 5, 6];

for (let m = 0; m < 4; m += 1) {
  const mode = MODES[m];
  for (const side of [0, 1]) {
    const base = (side ? 0xc0 : 0x80) + m * 0x10;
    const r = side ? 'B' : 'A';
    def(PAGE1, base + 0x0, 'SUB' + r, mode, C8[m]);
    def(PAGE1, base + 0x1, 'CMP' + r, mode, C8[m]);
    def(PAGE1, base + 0x2, 'SBC' + r, mode, C8[m]);
    def(PAGE1, base + 0x4, 'AND' + r, mode, C8[m]);
    def(PAGE1, base + 0x5, 'BIT' + r, mode, C8[m]);
    def(PAGE1, base + 0x6, 'LD' + r, mode, C8[m]);
    if (m === 0) def(PAGE1, base + 0x7, 'XST' + r, 'imm8', 2, true);
    else def(PAGE1, base + 0x7, 'ST' + r, mode, C8[m]);
    def(PAGE1, base + 0x8, 'EOR' + r, mode, C8[m]);
    def(PAGE1, base + 0x9, 'ADC' + r, mode, C8[m]);
    def(PAGE1, base + 0xa, 'OR' + r, mode, C8[m]);
    def(PAGE1, base + 0xb, 'ADD' + r, mode, C8[m]);
  }
  const m16 = /** @type {Mode} */ (m === 0 ? 'imm16' : mode);
  const a = 0x80 + m * 0x10;
  const b = 0xc0 + m * 0x10;
  def(PAGE1, a + 0x3, 'SUBD', m16, C16ALU[m]);
  def(PAGE1, b + 0x3, 'ADDD', m16, C16ALU[m]);
  def(PAGE1, a + 0xc, 'CMPX', m16, C16ALU[m]);
  def(PAGE1, b + 0xc, 'LDD', m16, C16LD[m]);
  def(PAGE1, a + 0xe, 'LDX', m16, C16LD[m]);
  def(PAGE1, b + 0xe, 'LDU', m16, C16LD[m]);
  if (m === 0) {
    def(PAGE1, 0x8d, 'BSR', 'rel8', 7);
    def(PAGE1, 0xcd, 'XHCF', 'inh', 1, true);
    def(PAGE1, 0x8f, 'XSTX', 'imm16', 3, true);
    def(PAGE1, 0xcf, 'XSTU', 'imm16', 3, true);
  } else {
    def(PAGE1, a + 0xd, 'JSR', mode, [0, 7, 7, 8][m]);
    def(PAGE1, b + 0xd, 'STD', mode, C16LD[m]);
    def(PAGE1, a + 0xf, 'STX', mode, C16LD[m]);
    def(PAGE1, b + 0xf, 'STU', mode, C16LD[m]);
  }
}

// ------------------------------------------------------------ pages 2, 3

// A second prefix byte keeps the page selected by the first ($10 $11 $8E is
// LDY #), so $10/$11 appear inside both pages as 'page' entries.
for (const page of [PAGE2, PAGE3]) {
  def(page, 0x10, 'PAGE2', 'page', 1);
  def(page, 0x11, 'PAGE3', 'page', 1);
  // Undocumented "store immediate" forms exist on both pages.
  def(page, 0x87, 'XSTA', 'imm8', 3, true);
  def(page, 0xc7, 'XSTB', 'imm8', 3, true);
}

def(PAGE2, 0x3e, 'XSWI2', 'inh', 20, true);
def(PAGE2, 0x3f, 'SWI2', 'inh', 20);
def(PAGE3, 0x3e, 'XFIRQ', 'inh', 20, true);
def(PAGE3, 0x3f, 'SWI3', 'inh', 20);

/** Page 2/3 16-bit compares: imm, dir, idx, ext (one more than page 1). */
const C16CMP = [5, 7, 7, 8];
/** Page 2 16-bit load/store: one more than page 1. */
const C16LD2 = [4, 6, 6, 7];
for (let m = 0; m < 4; m += 1) {
  const mode = /** @type {Mode} */ (m === 0 ? 'imm16' : MODES[m]);
  const o = m * 0x10;
  def(PAGE2, 0x83 + o, 'CMPD', mode, C16CMP[m]);
  def(PAGE2, 0x8c + o, 'CMPY', mode, C16CMP[m]);
  def(PAGE2, 0x8e + o, 'LDY', mode, C16LD2[m]);
  def(PAGE2, 0xce + o, 'LDS', mode, C16LD2[m]);
  // XADDD/XADDU: add that only sets flags (like a CMP that adds).
  def(PAGE2, 0xc3 + o, 'XADDD', mode, C16CMP[m], true);
  def(PAGE3, 0x83 + o, 'CMPU', mode, C16CMP[m]);
  def(PAGE3, 0x8c + o, 'CMPS', mode, C16CMP[m]);
  def(PAGE3, 0xc3 + o, 'XADDU', mode, C16CMP[m], true);
  if (m === 0) {
    def(PAGE2, 0x8f, 'XSTY', 'imm16', 4, true);
    def(PAGE2, 0xcf, 'XSTS', 'imm16', 4, true);
    def(PAGE3, 0x8f, 'XSTX', 'imm16', 4, true);
    def(PAGE3, 0xcf, 'XSTU', 'imm16', 4, true);
  } else {
    def(PAGE2, 0x8f + o, 'STY', mode, C16LD2[m]);
    def(PAGE2, 0xcf + o, 'STS', mode, C16LD2[m]);
  }
}

/**
 * Extra cycles an indexed postbyte adds over ",R" ($84), as charged by
 * MAME. Documented values match the datasheet. Undefined postbytes:
 *  - x7/xA/xE (non-indirect $87,$8A,$8E and their register variants):
 *    MAME computes EA = $0000 and spends only the postbyte fetch, one
 *    cycle LESS than ",R" -- hence -1 (+3 when indirect).
 *  - $8F-style (bit 4 clear, low nibble F): absolute 16-bit address,
 *    +2 (the indirect form $9F is the documented "[n16]", +5).
 *  - [,R+] and [,-R] (illegal per the datasheet) are executed anyway:
 *    the single-step cost plus 3 for the indirection (+5).
 * @type {Int8Array}
 */
export const INDEXED_EXTRA = new Int8Array(256);
{
  /** Extra per low nibble, non-indirect. */
  const lo = [2, 3, 2, 3, 0, 1, 1, -1, 1, 4, -1, 4, 1, 5, -1, 2];
  for (let pb = 0; pb < 256; pb += 1) {
    if ((pb & 0x80) === 0) INDEXED_EXTRA[pb] = 1;          // 5-bit offset
    else INDEXED_EXTRA[pb] = lo[pb & 0x0f] + ((pb & 0x10) ? 3 : 0);
  }
}

/**
 * Nonzero for undocumented page-1 opcodes. The core consults this (only
 * when an `onUndocumented` hook is installed) to report them.
 */
export const UNDOC1 = Uint8Array.from(PAGE1, (e) => (e && e.undoc ? 1 : 0));
/**
 * Page 2 opcodes that are undocumented; 2 marks bytes that are not opcodes
 * at all (MAME drops the prefix and the byte and dispatches the next byte).
 */
export const UNDOC2 = Uint8Array.from(PAGE2,
  (e) => (e === null ? 2 : e.undoc ? 1 : 0));
/** As UNDOC2 for page 3. */
export const UNDOC3 = Uint8Array.from(PAGE3,
  (e) => (e === null ? 2 : e.undoc ? 1 : 0));

/**
 * Transfer/exchange register names by nibble, MAME spelling ("inv" for the
 * undefined codes, which read as $FFFF and ignore writes).
 */
export const TFR_REGS = Object.freeze([
  'D', 'X', 'Y', 'U', 'S', 'PC', 'inv', 'inv',
  'A', 'B', 'CC', 'DP', 'inv', 'inv', 'inv', 'inv',
]);

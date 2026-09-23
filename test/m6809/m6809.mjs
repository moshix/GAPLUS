// Copyright 2026 by Moshix
/**
 * Cycle-exact MC6809 CPU core -- the execution engine of the Gaplus test
 * oracle (three of these run the real ROMs on the emulated board).
 *
 * Reference: MAME's m6809 core (reference/mame/m6809/m6809.lst,
 * base6x09.lst, m6809inl.h, m6809.cpp). MAME describes each instruction as
 * microcode where every memory access -- real or dummy -- costs exactly one
 * E cycle. This core transcribes that microcode opcode by opcode:
 *
 *  - rd()/wr()/fetch() perform a bus access and count one cycle;
 *  - MAME's dummy cycles (`dummy_read_opcode_arg`, `dummy_vma`, `eat`) are
 *    counted with `this.cyc += n` WITHOUT touching the bus. On the real
 *    board those cycles read PC+n or $FFFF, both ROM, so skipping them has
 *    no observable effect and saves a callback per cycle;
 *  - reads that MAME performs through the real data path ARE performed, even
 *    when the value is thrown away: CLR's read of its operand, the read of
 *    the stack pointer's target before PSHS/PSHU, and the read after the
 *    last byte of every pull (PULS/PULU/RTS/RTI). An I/O device mapped
 *    there sees the same accesses as under MAME.
 *
 * So step() returns exactly the number of cycles MAME charges, and the
 * cycles are also exact *within* an instruction: while a bus callback runs,
 * `cpu.cyc` is the index (0-based) of that access inside the current step,
 * so `cpu.cycles + cpu.cyc` is its absolute cycle number.
 *
 * Where MAME and the Motorola documentation disagree, MAME wins (this is an
 * oracle for MAME's behaviour of the game) and the spot is commented.
 * Undocumented opcodes behave exactly as in MAME (XNC, XDEC, XCLR, X18,
 * XANDCC, XRES, XST*, XADD*, XSWI2, XFIRQ, the "halt and catch fire" free
 * run, the page-1 aliases, and the page-2/3 fall-through).
 *
 * Granularity: one step() is one MAME `execute_one()` -- one instruction, or
 * one interrupt entry, or one idle slice of SYNC/CWAI. MAME can suspend an
 * instruction half way when its timeslice ends; this core always completes
 * it. Interrupt lines are only sampled between steps, which is also where
 * MAME samples them.
 */

import { UNDOC1, UNDOC2, UNDOC3 } from './opcodes.mjs';

/** Carry. */
export const CC_C = 0x01;
/** Overflow. */
export const CC_V = 0x02;
/** Zero. */
export const CC_Z = 0x04;
/** Negative. */
export const CC_N = 0x08;
/** IRQ mask. */
export const CC_I = 0x10;
/** Half carry. */
export const CC_H = 0x20;
/** FIRQ mask. */
export const CC_F = 0x40;
/** Entire state on stack. */
export const CC_E = 0x80;

/** Line numbers passed to the bus `ack` callback (MAME numbering). */
export const IRQ_LINE = 0;
export const FIRQ_LINE = 1;
export const NMI_LINE = 2;

export const VECTOR_SWI3 = 0xfff2;
export const VECTOR_SWI2 = 0xfff4;
export const VECTOR_FIRQ = 0xfff6;
export const VECTOR_IRQ = 0xfff8;
export const VECTOR_SWI = 0xfffa;
export const VECTOR_NMI = 0xfffc;
export const VECTOR_RESET = 0xfffe;

/** Not waiting. */
const WAIT_NONE = 0;
/** Inside SYNC, waiting for any interrupt line (masked or not). */
const WAIT_SYNC = 1;
/** Inside CWAI, state already stacked, waiting for an unmasked interrupt. */
const WAIT_CWAI = 2;

/** Push/pull masks MAME calls entire_state / partial_state registers. */
const ENTIRE = 0xff;
const PARTIAL = 0x81;

/**
 * @typedef {object} Bus
 * @property {(addr: number) => number} read   memory read, returns 0..255
 * @property {(addr: number, value: number) => void} write memory write
 * @property {((line: number) => void)=} ack   optional: called when the CPU
 *   takes an interrupt (IRQ_LINE / FIRQ_LINE / NMI_LINE), at the point MAME
 *   calls standard_irq_callback -- lets a board model HOLD_LINE
 */

/**
 * @typedef {object} CpuState
 * @property {number} a @property {number} b @property {number} x
 * @property {number} y @property {number} u @property {number} s
 * @property {number} pc @property {number} ppc @property {number} dp
 * @property {number} cc @property {boolean} nmiLine
 * @property {boolean} nmiAsserted @property {boolean} firqLine
 * @property {boolean} irqLine @property {boolean} ldsEncountered
 * @property {number} wait @property {boolean} freeRun
 * @property {number} cycles
 */

/** Sign-extend a byte. @param {number} v @returns {number} */
const s8 = (v) => (v << 24) >> 24;

export class M6809 {
  /** @param {Bus} bus */
  constructor(bus) {
    /** @type {Bus} */
    this.bus = bus;
    // MAME's device_start zeroes every register; reset() then only touches
    // DP, CC (I and F) and PC.
    this.a = 0; this.b = 0;
    this.x = 0; this.y = 0; this.u = 0; this.s = 0;
    this.pc = 0; this.dp = 0; this.cc = 0;
    /** PC of the instruction being (or last) executed. */
    this.ppc = 0;
    this.nmiLine = false;
    /** An NMI edge was latched and will be taken at the next boundary. */
    this.nmiAsserted = false;
    this.firqLine = false;
    this.irqLine = false;
    /** NMI is ignored until S has been loaded once (LDS/LEAS/TFR x,S). */
    this.ldsEncountered = false;
    /** WAIT_NONE, WAIT_SYNC or WAIT_CWAI. */
    this.wait = WAIT_NONE;
    /** Set by the $14/$15/$CD "halt and catch fire" opcodes until reset. */
    this.freeRun = false;
    /** Cycles spent so far in the current step. */
    this.cyc = 0;
    /** Total cycles since construction. */
    this.cycles = 0;
    /**
     * Optional per-instruction hook, called with (pc, cpu) before the
     * opcode fetch. Not called for interrupt entries or idle waits.
     * @type {((pc: number, cpu: M6809) => void)|null}
     */
    this.trace = null;
    /**
     * Optional hook, called with (pc, opcode) whenever an undocumented
     * opcode executes; page 2/3 opcodes are reported as $10xx / $11xx.
     * @type {((pc: number, opcode: number) => void)|null}
     */
    this.onUndocumented = null;
  }

  // ---------------------------------------------------------------- registers

  get d() { return (this.a << 8) | this.b; }
  set d(v) { this.a = (v >> 8) & 0xff; this.b = v & 0xff; }

  /** @returns {CpuState} */
  getState() {
    return {
      a: this.a, b: this.b, x: this.x, y: this.y, u: this.u, s: this.s,
      pc: this.pc, ppc: this.ppc, dp: this.dp, cc: this.cc,
      nmiLine: this.nmiLine, nmiAsserted: this.nmiAsserted,
      firqLine: this.firqLine, irqLine: this.irqLine,
      ldsEncountered: this.ldsEncountered, wait: this.wait,
      freeRun: this.freeRun, cycles: this.cycles,
    };
  }

  /**
   * Restore a snapshot (fields that are absent are left alone).
   * @param {Partial<CpuState>} st
   * @returns {void}
   */
  setState(st) {
    for (const k of ['a', 'b', 'dp', 'cc']) {
      const v = st[/** @type {'a'} */ (k)];
      if (v !== undefined) this[/** @type {'a'} */ (k)] = v & 0xff;
    }
    for (const k of ['x', 'y', 'u', 's', 'pc', 'ppc']) {
      const v = st[/** @type {'x'} */ (k)];
      if (v !== undefined) this[/** @type {'x'} */ (k)] = v & 0xffff;
    }
    if (st.nmiLine !== undefined) this.nmiLine = st.nmiLine;
    if (st.nmiAsserted !== undefined) this.nmiAsserted = st.nmiAsserted;
    if (st.firqLine !== undefined) this.firqLine = st.firqLine;
    if (st.irqLine !== undefined) this.irqLine = st.irqLine;
    if (st.ldsEncountered !== undefined) {
      this.ldsEncountered = st.ldsEncountered;
    }
    if (st.wait !== undefined) this.wait = st.wait;
    if (st.freeRun !== undefined) this.freeRun = st.freeRun;
    if (st.cycles !== undefined) this.cycles = st.cycles;
  }

  // --------------------------------------------------------- reset and lines

  /**
   * RESET: as MAME's device_reset followed by the vector fetch it queues
   * (one dead cycle, two vector reads, one dead cycle). Only DP, the I/F
   * masks and PC change; everything else keeps its value.
   * @returns {number} cycles consumed (4)
   */
  reset() {
    this.nmiAsserted = false;
    this.ldsEncountered = false;
    this.freeRun = false;
    this.wait = WAIT_NONE;
    this.dp = 0;
    this.cc |= CC_I | CC_F;
    this.cyc = 0;
    this.vector(VECTOR_RESET);
    this.cycles += this.cyc;
    return this.cyc;
  }

  /** IRQ is level triggered. @param {boolean|number} level @returns {void} */
  setIrq(level) { this.irqLine = !!level; }

  /** FIRQ is level triggered. @param {boolean|number} level @returns {void} */
  setFirq(level) { this.firqLine = !!level; }

  /**
   * Drive the NMI line. NMI is edge triggered: a low-to-high transition
   * latches a request, but only once S has been loaded since reset
   * (MAME's m_lds_encountered).
   * @param {boolean|number} level
   * @returns {void}
   */
  setNmi(level) {
    const on = !!level;
    if (on && !this.nmiLine && this.ldsEncountered) this.nmiAsserted = true;
    this.nmiLine = on;
  }

  /** Pulse NMI (one edge). @returns {void} */
  nmi() { this.setNmi(true); this.setNmi(false); }

  // ------------------------------------------------------------ bus helpers

  /** @param {number} addr @returns {number} */
  rd(addr) {
    const v = this.bus.read(addr) & 0xff;
    this.cyc += 1;
    return v;
  }

  /** @param {number} addr @param {number} v @returns {void} */
  wr(addr, v) {
    this.bus.write(addr, v & 0xff);
    this.cyc += 1;
  }

  /** Big-endian 16-bit read. @param {number} addr @returns {number} */
  rd16(addr) {
    const hi = this.rd(addr);
    return (hi << 8) | this.rd((addr + 1) & 0xffff);
  }

  /** @param {number} addr @param {number} v @returns {void} */
  wr16(addr, v) {
    this.wr(addr, v >> 8);
    this.wr((addr + 1) & 0xffff, v);
  }

  /** Read the byte at PC and advance. @returns {number} */
  fetch() {
    const v = this.bus.read(this.pc) & 0xff;
    this.pc = (this.pc + 1) & 0xffff;
    this.cyc += 1;
    return v;
  }

  /** @returns {number} */
  fetch16() {
    const hi = this.fetch();
    return (hi << 8) | this.fetch();
  }

  // ----------------------------------------------------- addressing modes

  /** MAME DIRECT: operand fetch + one dead cycle. @returns {number} EA */
  direct() {
    const ea = (this.dp << 8) | this.fetch();
    this.cyc += 1;
    return ea;
  }

  /** MAME EXTENDED: two operand fetches + one dead cycle. @returns {number} */
  extended() {
    const ea = this.fetch16();
    this.cyc += 1;
    return ea;
  }

  /** Index register selected by postbyte bits 5-6. @param {number} r */
  ireg(r) {
    return r === 0 ? this.x : r === 1 ? this.y : r === 2 ? this.u : this.s;
  }

  /** @param {number} r @param {number} v @returns {void} */
  setIreg(r, v) {
    v &= 0xffff;
    if (r === 0) this.x = v;
    else if (r === 1) this.y = v;
    else if (r === 2) this.u = v;
    else this.s = v;
  }

  /**
   * MAME INDEXED. The cycle comments give MAME's dummy accesses; the
   * postbyte fetch is one more cycle in every case.
   * @returns {number} effective address
   */
  indexed() {
    const pb = this.fetch();
    const r = (pb >> 5) & 3;
    let ea;
    if ((pb & 0x80) === 0) {
      // n5,R: signed 5-bit offset (bit 4 is the sign). 1 dummy read + 1 VMA.
      ea = this.ireg(r) + (((pb & 0x1f) ^ 0x10) - 0x10);
      this.cyc += 2;
      return ea & 0xffff;
    }
    switch (pb & 0x0f) {
      case 0x0: // ,R+   dummy read + 2 VMA
        ea = this.ireg(r); this.setIreg(r, ea + 1); this.cyc += 3; break;
      case 0x1: // ,R++  dummy read + 3 VMA
        ea = this.ireg(r); this.setIreg(r, ea + 2); this.cyc += 4; break;
      case 0x2: // ,-R
        ea = (this.ireg(r) - 1) & 0xffff; this.setIreg(r, ea);
        this.cyc += 3; break;
      case 0x3: // ,--R
        ea = (this.ireg(r) - 2) & 0xffff; this.setIreg(r, ea);
        this.cyc += 4; break;
      case 0x4: // ,R    dummy read
        ea = this.ireg(r); this.cyc += 1; break;
      case 0x5: // B,R   dummy read + VMA
        ea = this.ireg(r) + s8(this.b); this.cyc += 2; break;
      case 0x6: // A,R
        ea = this.ireg(r) + s8(this.a); this.cyc += 2; break;
      case 0x8: // n8,R  offset fetch + dummy read
        ea = this.ireg(r) + s8(this.fetch()); this.cyc += 1; break;
      case 0x9: // n16,R offset fetch x2 + 3 VMA
        ea = this.ireg(r) + this.fetch16(); this.cyc += 3; break;
      case 0xb: // D,R   2 dummy reads + 3 VMA
        ea = this.ireg(r) + this.d; this.cyc += 5; break;
      case 0xc: { // n8,PCR: PC after the offset byte + offset, 1 VMA
        const off = s8(this.fetch());
        ea = this.pc + off; this.cyc += 1; break;
      }
      case 0xd: { // n16,PCR: 4 VMA
        const off = this.fetch16();
        ea = this.pc + off; this.cyc += 4; break;
      }
      case 0xf: // n16 (documented only as [n16]); 1 VMA
        ea = this.fetch16(); this.cyc += 1; break;
      default:
        // $x7, $xA, $xE: undefined on the 6809. MAME yields EA = $0000
        // with no further cycles (these are 6309 E/F/W modes).
        ea = 0; break;
    }
    ea &= 0xffff;
    if (pb & 0x10) {
      // Indirect: two reads of the pointer + 1 VMA. MAME honours bit 4 for
      // every mode, including the datasheet-illegal [,R+] and [,-R].
      ea = this.rd16(ea);
      this.cyc += 1;
    }
    return ea;
  }

  /**
   * Effective address for the $80-$FF column: bits 4-5 = 1 dir, 2 idx,
   * 3 ext.
   * @param {number} op
   * @returns {number}
   */
  eaOf(op) {
    const m = op & 0x30;
    if (m === 0x10) return this.direct();
    if (m === 0x20) return this.indexed();
    return this.extended();
  }

  /** 8-bit operand: immediate or memory. @param {number} op */
  operand8(op) {
    return (op & 0x30) === 0 ? this.fetch() : this.rd(this.eaOf(op));
  }

  /** 16-bit operand: immediate or memory. @param {number} op */
  operand16(op) {
    return (op & 0x30) === 0 ? this.fetch16() : this.rd16(this.eaOf(op));
  }

  // --------------------------------------------------------------- flags
  //
  // These follow MAME's set_flags(): with r the full-width result,
  //   H = bit 4 of (a ^ b ^ r)                    (carry into bit 4)
  //   V = top bit of (a ^ b ^ r ^ (r >> 1))       (carry-in ^ carry-out)
  //   C = bit 8 (or 16) of r.
  // Keeping r to 9 (17) bits is enough: bit 8 of r is what (r >> 1)
  // contributes to bit 7.

  /** @param {number} a @param {number} m @param {number} c @returns {number} */
  sub8(a, m, c) {
    const r = (a - m - c) & 0x1ff;
    let cc = this.cc & ~(CC_N | CC_Z | CC_V | CC_C);
    cc |= (r & 0x80) >> 4;
    if ((r & 0xff) === 0) cc |= CC_Z;
    cc |= ((a ^ m ^ r ^ (r >> 1)) & 0x80) >> 6;
    cc |= r >> 8;
    this.cc = cc;
    return r & 0xff;
  }

  /** @param {number} a @param {number} m @param {number} c @returns {number} */
  add8(a, m, c) {
    const r = a + m + c;
    let cc = this.cc & ~(CC_H | CC_N | CC_Z | CC_V | CC_C);
    cc |= ((a ^ m ^ r) & 0x10) << 1;
    cc |= (r & 0x80) >> 4;
    if ((r & 0xff) === 0) cc |= CC_Z;
    cc |= ((a ^ m ^ r ^ (r >> 1)) & 0x80) >> 6;
    cc |= r >> 8;
    this.cc = cc;
    return r & 0xff;
  }

  /** @param {number} a @param {number} m @returns {number} */
  sub16(a, m) {
    const r = (a - m) & 0x1ffff;
    let cc = this.cc & ~(CC_N | CC_Z | CC_V | CC_C);
    cc |= (r & 0x8000) >> 12;
    if ((r & 0xffff) === 0) cc |= CC_Z;
    cc |= ((a ^ m ^ r ^ (r >> 1)) & 0x8000) >> 14;
    cc |= r >> 16;
    this.cc = cc;
    return r & 0xffff;
  }

  /** @param {number} a @param {number} m @returns {number} */
  add16(a, m) {
    const r = a + m;
    let cc = this.cc & ~(CC_N | CC_Z | CC_V | CC_C);
    cc |= (r & 0x8000) >> 12;
    if ((r & 0xffff) === 0) cc |= CC_Z;
    cc |= ((a ^ m ^ r ^ (r >> 1)) & 0x8000) >> 14;
    cc |= r >> 16;
    this.cc = cc;
    return r & 0xffff;
  }

  /** N, Z from an 8-bit value, V cleared (LD/ST/AND/OR/EOR/BIT/TST). */
  nzv8(/** @type {number} */ v) {
    let cc = this.cc & ~(CC_N | CC_Z | CC_V);
    cc |= (v & 0x80) >> 4;
    if (v === 0) cc |= CC_Z;
    this.cc = cc;
    return v;
  }

  /** N, Z from a 16-bit value, V cleared. @param {number} v */
  nzv16(v) {
    let cc = this.cc & ~(CC_N | CC_Z | CC_V);
    cc |= (v & 0x8000) >> 12;
    if (v === 0) cc |= CC_Z;
    this.cc = cc;
    return v;
  }

  /** N, Z from an 8-bit value, V and C untouched. @param {number} v */
  nz8(v) {
    let cc = this.cc & ~(CC_N | CC_Z);
    cc |= (v & 0x80) >> 4;
    if (v === 0) cc |= CC_Z;
    this.cc = cc;
    return v;
  }

  /**
   * The unary read-modify-write operations (low nibble of $00-$7F),
   * excluding TST/JMP/CLR which have their own cycle shapes.
   * @param {number} n low nibble of the opcode
   * @param {number} v operand
   * @returns {number} result
   */
  unary(n, v) {
    switch (n) {
      case 0x0: case 0x1: // NEG
        return this.sub8(0, v, 0);
      case 0x2: // XNC: COM if C set, else NEG
        return (this.cc & CC_C) ? this.unary(0x3, v) : this.sub8(0, v, 0);
      case 0x3: // COM: V=0, C=1
        this.cc = (this.cc & ~CC_V) | CC_C;
        return this.nz8(~v & 0xff);
      case 0x4: case 0x5: // LSR
        this.cc = (this.cc & ~CC_C) | (v & 1);
        return this.nz8(v >> 1);
      case 0x6: { // ROR: old C into bit 7, bit 0 into C
        const r = (v >> 1) | ((this.cc & CC_C) << 7);
        this.cc = (this.cc & ~CC_C) | (v & 1);
        return this.nz8(r);
      }
      case 0x7: // ASR
        this.cc = (this.cc & ~CC_C) | (v & 1);
        return this.nz8((v >> 1) | (v & 0x80));
      case 0x8: // ASL: set_flags(NZVC, v, v, v << 1); H untouched
        return this.shl(v, 0);
      case 0x9: // ROL: set_flags(NZV, v, v, v << 1 | C), C from bit 7
        return this.shl(v, this.cc & CC_C);
      case 0xa: // DEC: set_flags(NZV, v, 1, v - 1), C untouched
        return this.decinc(v, (v - 1) & 0x1ff);
      case 0xb: // XDEC: C = (operand != 0), then as DEC
        this.cc = (this.cc & ~CC_C) | (v !== 0 ? CC_C : 0);
        return this.decinc(v, (v - 1) & 0x1ff);
      case 0xc: // INC
        return this.decinc(v, v + 1);
      default:
        throw new Error(`unary: bad nibble ${n}`);
    }
  }

  /**
   * ASL/ROL: shift left with `cin` into bit 0. MAME's set_flags(v, v, r)
   * makes V = bit 7 of (r ^ r >> 1), i.e. old bit 7 ^ old bit 6.
   * @param {number} v @param {number} cin
   * @returns {number}
   */
  shl(v, cin) {
    const r = (v << 1) | cin;
    let cc = this.cc & ~(CC_N | CC_Z | CC_V | CC_C);
    cc |= (r & 0x80) >> 4;
    if ((r & 0xff) === 0) cc |= CC_Z;
    cc |= ((r ^ (r >> 1)) & 0x80) >> 6;
    cc |= r >> 8;
    this.cc = cc;
    return r & 0xff;
  }

  /**
   * DEC/INC flags: N, Z, V from set_flags(NZV, v, 1, r); C untouched.
   * @param {number} v @param {number} r 9-bit result
   * @returns {number}
   */
  decinc(v, r) {
    let cc = this.cc & ~(CC_N | CC_Z | CC_V);
    cc |= (r & 0x80) >> 4;
    if ((r & 0xff) === 0) cc |= CC_Z;
    cc |= ((v ^ 1 ^ r ^ (r >> 1)) & 0x80) >> 6;
    this.cc = cc;
    return r & 0xff;
  }

  /**
   * DAA, as MAME's m6809inl.h: add $06 when the low nibble is > 9 or H is
   * set, add $60 when the high nibble is > 9, or > 8 with a low nibble
   * > 9, or C is set. C is only ever set (never cleared); V is cleared
   * (the datasheet calls V undefined).
   * @returns {void}
   */
  daa() {
    const a = this.a;
    const msn = a & 0xf0;
    const lsn = a & 0x0f;
    let cf = 0;
    if (lsn > 0x09 || (this.cc & CC_H)) cf |= 0x06;
    if (msn > 0x80 && lsn > 0x09) cf |= 0x60;
    if (msn > 0x90 || (this.cc & CC_C)) cf |= 0x60;
    const t = a + cf;
    this.cc &= ~CC_V;
    if (t & 0x100) this.cc |= CC_C;
    this.a = this.nz8(t & 0xff);
  }

  /**
   * Branch condition for the low nibble of a Bcc / LBcc opcode.
   * @param {number} n
   * @returns {boolean}
   */
  cond(n) {
    const cc = this.cc;
    // N and V moved to bit 0 so the signed conditions can compare them.
    const nxv = ((cc >> 3) ^ (cc >> 1)) & 1;
    switch (n) {
      case 0x0: return true;                          // BRA
      case 0x1: return false;                         // BRN
      case 0x2: return (cc & (CC_Z | CC_C)) === 0;    // BHI
      case 0x3: return (cc & (CC_Z | CC_C)) !== 0;    // BLS
      case 0x4: return (cc & CC_C) === 0;             // BCC
      case 0x5: return (cc & CC_C) !== 0;             // BCS
      case 0x6: return (cc & CC_Z) === 0;             // BNE
      case 0x7: return (cc & CC_Z) !== 0;             // BEQ
      case 0x8: return (cc & CC_V) === 0;             // BVC
      case 0x9: return (cc & CC_V) !== 0;             // BVS
      case 0xa: return (cc & CC_N) === 0;             // BPL
      case 0xb: return (cc & CC_N) !== 0;             // BMI
      case 0xc: return nxv === 0;                     // BGE
      case 0xd: return nxv !== 0;                     // BLT
      case 0xe: return nxv === 0 && (cc & CC_Z) === 0; // BGT
      default: return nxv !== 0 || (cc & CC_Z) !== 0; // BLE
    }
  }

  // ------------------------------------------------------------ registers
  //                                                    (EXG / TFR operands)

  /**
   * MAME read_tfr_exg_816_register: 8-bit sources widen with $FF in the
   * high byte, except CC and DP which appear in both halves; undefined
   * codes read $FFFF.
   * @param {number} n register nibble
   * @returns {number}
   */
  rd816(n) {
    switch (n & 0x0f) {
      case 0: return this.d;
      case 1: return this.x;
      case 2: return this.y;
      case 3: return this.u;
      case 4: return this.s;
      case 5: return this.pc;
      case 8: return 0xff00 | this.a;
      case 9: return 0xff00 | this.b;
      case 10: return (this.cc << 8) | this.cc;
      case 11: return (this.dp << 8) | this.dp;
      default: return 0xffff;
    }
  }

  /**
   * MAME read_exg_168_register (EXG whose first register is 16-bit): like
   * rd816 but CC and DP widen with $FF like A and B.
   * @param {number} n
   * @returns {number}
   */
  rd168(n) {
    switch (n & 0x0f) {
      case 10: return 0xff00 | this.cc;
      case 11: return 0xff00 | this.dp;
      default: return this.rd816(n);
    }
  }

  /**
   * Write a TFR/EXG destination; 8-bit registers take the low byte,
   * undefined codes ignore the write.
   * @param {number} n @param {number} v
   * @returns {void}
   */
  wrReg(n, v) {
    switch (n & 0x0f) {
      case 0: this.d = v; break;
      case 1: this.x = v; break;
      case 2: this.y = v; break;
      case 3: this.u = v; break;
      case 4: this.s = v; break;
      case 5: this.pc = v; break;
      case 8: this.a = v & 0xff; break;
      case 9: this.b = v & 0xff; break;
      case 10: this.cc = v & 0xff; break;
      case 11: this.dp = v & 0xff; break;
      default: break;
    }
  }

  /**
   * EXG. MAME picks the read flavour from bit 7 of the postbyte (is the
   * FIRST register 8-bit?), reads both registers, then writes the second
   * register first. Note: unlike TFR x,S, EXG x,S does not arm NMI.
   * @param {number} p postbyte
   * @returns {void}
   */
  exg(p) {
    let r1, r2;
    if (p & 0x80) {
      r1 = this.rd816(p >> 4);
      r2 = this.rd816(p);
    } else {
      r1 = this.rd168(p >> 4);
      r2 = this.rd168(p);
    }
    this.wrReg(p, r1);
    this.wrReg(p >> 4, r2);
  }

  /** TFR; a transfer into S arms NMI. @param {number} p @returns {void} */
  tfr(p) {
    this.wrReg(p, this.rd816(p >> 4));
    if ((p & 0x0f) === 4) this.ldsEncountered = true;
  }

  // ---------------------------------------------------------------- stack

  /**
   * MAME PUSH_REGISTERS: PC, U/S, Y, X, DP, B, A, CC (high address first),
   * one cycle per byte.
   * @param {number} mask postbyte / register mask
   * @param {boolean} useU push on U (PSHU) instead of S
   * @returns {void}
   */
  push(mask, useU) {
    let sp = useU ? this.u : this.s;
    if (mask & 0x80) {
      sp = (sp - 1) & 0xffff; this.wr(sp, this.pc);
      sp = (sp - 1) & 0xffff; this.wr(sp, this.pc >> 8);
    }
    if (mask & 0x40) {
      // "the other stack": PSHS pushes U, PSHU pushes S
      const o = useU ? this.s : this.u;
      sp = (sp - 1) & 0xffff; this.wr(sp, o);
      sp = (sp - 1) & 0xffff; this.wr(sp, o >> 8);
    }
    if (mask & 0x20) {
      sp = (sp - 1) & 0xffff; this.wr(sp, this.y);
      sp = (sp - 1) & 0xffff; this.wr(sp, this.y >> 8);
    }
    if (mask & 0x10) {
      sp = (sp - 1) & 0xffff; this.wr(sp, this.x);
      sp = (sp - 1) & 0xffff; this.wr(sp, this.x >> 8);
    }
    if (mask & 0x08) { sp = (sp - 1) & 0xffff; this.wr(sp, this.dp); }
    if (mask & 0x04) { sp = (sp - 1) & 0xffff; this.wr(sp, this.b); }
    if (mask & 0x02) { sp = (sp - 1) & 0xffff; this.wr(sp, this.a); }
    if (mask & 0x01) { sp = (sp - 1) & 0xffff; this.wr(sp, this.cc); }
    if (useU) this.u = sp; else this.s = sp;
  }

  /**
   * MAME PULL_REGISTERS: CC, A, B, DP, X, Y, U/S, PC, then one more read
   * at the final stack address (a real bus read in MAME, kept here).
   * @param {number} mask @param {boolean} useU
   * @returns {void}
   */
  pull(mask, useU) {
    let sp = useU ? this.u : this.s;
    if (mask & 0x01) { this.cc = this.rd(sp); sp = (sp + 1) & 0xffff; }
    if (mask & 0x02) { this.a = this.rd(sp); sp = (sp + 1) & 0xffff; }
    if (mask & 0x04) { this.b = this.rd(sp); sp = (sp + 1) & 0xffff; }
    if (mask & 0x08) { this.dp = this.rd(sp); sp = (sp + 1) & 0xffff; }
    if (mask & 0x10) { this.x = this.rd16(sp); sp = (sp + 2) & 0xffff; }
    if (mask & 0x20) { this.y = this.rd16(sp); sp = (sp + 2) & 0xffff; }
    if (mask & 0x40) {
      const v = this.rd16(sp);
      sp = (sp + 2) & 0xffff;
      if (useU) this.s = v; else this.u = v;
    }
    if (mask & 0x80) { this.pc = this.rd16(sp); sp = (sp + 2) & 0xffff; }
    this.rd(sp);
    if (useU) this.u = sp; else this.s = sp;
  }

  /** Push PC on S and jump (MAME GOTO_SUBROUTINE). @param {number} ea */
  jsr(ea) {
    this.s = (this.s - 1) & 0xffff; this.wr(this.s, this.pc);
    this.s = (this.s - 1) & 0xffff; this.wr(this.s, this.pc >> 8);
    this.pc = ea;
  }

  // ----------------------------------------------------------- interrupts

  /**
   * MAME INTERRUPT_VECTOR: dead cycle, vector high, vector low, dead cycle.
   * @param {number} addr
   * @returns {void}
   */
  vector(addr) {
    this.cyc += 1;
    this.pc = this.rd16(addr);
    this.cyc += 1;
  }

  /** @param {number} line @returns {void} */
  ack(line) {
    if (typeof this.bus.ack === 'function') this.bus.ack(line);
  }

  /**
   * The interrupt MAME's get_pending_interrupt() would take now.
   * @returns {number} vector address, or 0
   */
  pendingVector() {
    if (this.nmiAsserted) return VECTOR_NMI;
    if (this.firqLine && (this.cc & CC_F) === 0) return VECTOR_FIRQ;
    if (this.irqLine && (this.cc & CC_I) === 0) return VECTOR_IRQ;
    return 0;
  }

  /**
   * Hardware interrupt entry (MAME NMI / FIRQ / IRQ labels): two dummy
   * opcode reads and a dead cycle, stack, mask, vector. 19 cycles for NMI
   * and IRQ (12 bytes stacked), 10 for FIRQ (PC and CC only, E clear).
   * @param {number} v vector address
   * @returns {void}
   */
  interrupt(v) {
    if (v === VECTOR_NMI) this.nmiAsserted = false;
    this.cyc += 3;
    if (v === VECTOR_FIRQ) {
      this.cc &= ~CC_E;
      this.push(PARTIAL, false);
      this.cc |= CC_I | CC_F;
      this.ack(FIRQ_LINE);
    } else {
      this.cc |= CC_E;
      this.push(ENTIRE, false);
      if (v === VECTOR_NMI) {
        this.cc |= CC_I | CC_F;
        this.ack(NMI_LINE);
      } else {
        this.cc |= CC_I;
        this.ack(IRQ_LINE);
      }
    }
    this.vector(v);
  }

  /**
   * Leave CWAI through vector v: the state is already stacked, so only
   * the masks are set and the vector fetched (4 cycles). FIRQ taken this
   * way has stacked the entire state (E=1), as on the real chip.
   * @param {number} v
   * @returns {void}
   */
  cwaiWake(v) {
    this.wait = WAIT_NONE;
    if (v === VECTOR_NMI) this.nmiAsserted = false;
    this.cc |= CC_I | (v !== VECTOR_IRQ ? CC_F : 0);
    this.ack(v === VECTOR_NMI ? NMI_LINE
      : v === VECTOR_FIRQ ? FIRQ_LINE : IRQ_LINE);
    this.vector(v);
  }

  /**
   * SWI, SWI2, SWI3 and the undocumented XSWI2 / XFIRQ / XRES, which push
   * the entire state WITHOUT setting E and mask nothing.
   * @param {number} v vector @param {boolean} setE
   * @param {boolean} maskIF set I and F after stacking (SWI only)
   * @returns {void}
   */
  softInt(v, setE, maskIF) {
    if (setE) this.cc |= CC_E;
    this.cyc += 2;                 // dummy opcode read + dead cycle
    this.push(ENTIRE, false);
    if (maskIF) this.cc |= CC_I | CC_F;
    this.vector(v);
  }

  /**
   * True when a SYNC/CWAI wait would end at the next step.
   * @returns {boolean}
   */
  canWake() {
    if (this.wait === WAIT_SYNC) {
      // SYNC resumes on any line, even a masked one (MAME / datasheet).
      return this.nmiAsserted || this.firqLine || this.irqLine;
    }
    return this.pendingVector() !== 0;
  }

  // ------------------------------------------------------------ execution

  /**
   * Execute one instruction, take one interrupt, or idle one cycle inside
   * SYNC/CWAI.
   * @returns {number} cycles consumed
   */
  step() {
    this.cyc = 0;
    if (this.wait !== WAIT_NONE) {
      if (this.wait === WAIT_SYNC) {
        // One cycle either way: idle, or MAME's eat(1) after the line is
        // seen. The interrupt itself (if unmasked) is the next step.
        if (this.canWake()) this.wait = WAIT_NONE;
        this.cyc = 1;
      } else {
        const v = this.pendingVector();
        if (v !== 0) this.cwaiWake(v);
        else this.cyc = 1;
      }
    } else {
      const v = this.pendingVector();
      if (v !== 0) {
        this.interrupt(v);
      } else {
        this.ppc = this.pc;
        if (this.trace !== null) this.trace(this.pc, this);
        this.exec();
      }
    }
    this.cycles += this.cyc;
    return this.cyc;
  }

  /**
   * Run for at least `cycles` cycles (the last instruction may overshoot).
   * A CPU parked in SYNC/CWAI with nothing to wake it burns the rest of the
   * budget at once, as MAME's eat_remaining() does.
   * @param {number} cycles
   * @returns {number} cycles actually consumed
   */
  run(cycles) {
    let done = 0;
    while (done < cycles) {
      if (this.wait !== WAIT_NONE && !this.canWake()) {
        const idle = cycles - done;
        this.cycles += idle;
        done += idle;
        break;
      }
      done += this.step();
    }
    return done;
  }

  /**
   * TST/JMP/CLR and the unary RMW ops on memory ($0x, $6x, $7x).
   * RMW is read, compute, dead cycle, write -- 3 cycles after the EA.
   * @param {number} n low nibble @param {number} ea
   * @returns {void}
   */
  memOp(n, ea) {
    switch (n) {
      case 0xd: // TST: read + 2 dead cycles
        this.nzv8(this.rd(ea));
        this.cyc += 2;
        return;
      case 0xe: // JMP
        this.pc = ea;
        return;
      case 0xf: // CLR: MAME really reads the operand before writing 0
        this.rd(ea);
        this.cc = (this.cc & ~(CC_N | CC_Z | CC_V | CC_C)) | CC_Z;
        this.cyc += 1;
        this.wr(ea, 0);
        return;
      default: {
        const r = this.unary(n, this.rd(ea));
        this.cyc += 1;
        this.wr(ea, r);
      }
    }
  }

  /**
   * The unary ops on A or B ($4x, $5x): 2 cycles each.
   * @param {number} n low nibble @param {number} v register value
   * @returns {number} new register value
   */
  regOp(n, v) {
    this.cyc += 1;
    switch (n) {
      case 0xd: this.nzv8(v); return v;                          // TST
      case 0xe: // XCLR: like CLR but C is left alone
        this.cc = (this.cc & ~(CC_N | CC_Z | CC_V)) | CC_Z;
        return 0;
      case 0xf:
        this.cc = (this.cc & ~(CC_N | CC_Z | CC_V | CC_C)) | CC_Z;
        return 0;
      default: return this.unary(n, v);
    }
  }

  /**
   * Undocumented 16-bit "store immediate" (XSTX #, XSTU #, ...): MAME
   * fetches the first operand byte, then WRITES the register's low byte
   * over the second operand byte (at PC) and steps past it.
   * @param {number} v register value
   * @returns {void}
   */
  xst16(v) {
    this.fetch();
    this.wr(this.pc, v);
    this.pc = (this.pc + 1) & 0xffff;
    this.nzv16(v);
  }

  /**
   * The $80-$FF column: low nibble = operation, bits 4-5 = mode, bit 6 =
   * A side / B side. The operand is always evaluated before the register
   * is read, because indexing may change it (CMPX ,X++ compares the
   * incremented X, as in MAME).
   * @param {number} op
   * @returns {void}
   */
  alu(op) {
    switch (op & 0x4f) {
      case 0x00: { const m = this.operand8(op); this.a = this.sub8(this.a, m, 0); return; }
      case 0x40: { const m = this.operand8(op); this.b = this.sub8(this.b, m, 0); return; }
      case 0x01: { const m = this.operand8(op); this.sub8(this.a, m, 0); return; }
      case 0x41: { const m = this.operand8(op); this.sub8(this.b, m, 0); return; }
      case 0x02: {
        const m = this.operand8(op);
        this.a = this.sub8(this.a, m, this.cc & CC_C);
        return;
      }
      case 0x42: {
        const m = this.operand8(op);
        this.b = this.sub8(this.b, m, this.cc & CC_C);
        return;
      }
      case 0x03: { // SUBD: 2 reads + dead cycle
        const m = this.operand16(op);
        this.d = this.sub16(this.d, m);
        this.cyc += 1;
        return;
      }
      case 0x43: { // ADDD
        const m = this.operand16(op);
        this.d = this.add16(this.d, m);
        this.cyc += 1;
        return;
      }
      case 0x04: { const m = this.operand8(op); this.a = this.nzv8(this.a & m); return; }
      case 0x44: { const m = this.operand8(op); this.b = this.nzv8(this.b & m); return; }
      case 0x05: { const m = this.operand8(op); this.nzv8(this.a & m); return; }
      case 0x45: { const m = this.operand8(op); this.nzv8(this.b & m); return; }
      case 0x06: this.a = this.nzv8(this.operand8(op)); return;
      case 0x46: this.b = this.nzv8(this.operand8(op)); return;
      case 0x07:
      case 0x47: {
        if ((op & 0x30) === 0) {
          // XSTA # / XSTB #: fetch (and ignore) the byte, flags from reg.
          this.fetch();
          this.nzv8(op & 0x40 ? this.b : this.a);
        } else {
          const ea = this.eaOf(op);
          this.wr(ea, this.nzv8(op & 0x40 ? this.b : this.a));
        }
        return;
      }
      case 0x08: { const m = this.operand8(op); this.a = this.nzv8(this.a ^ m); return; }
      case 0x48: { const m = this.operand8(op); this.b = this.nzv8(this.b ^ m); return; }
      case 0x09: {
        const m = this.operand8(op);
        this.a = this.add8(this.a, m, this.cc & CC_C);
        return;
      }
      case 0x49: {
        const m = this.operand8(op);
        this.b = this.add8(this.b, m, this.cc & CC_C);
        return;
      }
      case 0x0a: { const m = this.operand8(op); this.a = this.nzv8(this.a | m); return; }
      case 0x4a: { const m = this.operand8(op); this.b = this.nzv8(this.b | m); return; }
      case 0x0b: { const m = this.operand8(op); this.a = this.add8(this.a, m, 0); return; }
      case 0x4b: { const m = this.operand8(op); this.b = this.add8(this.b, m, 0); return; }
      case 0x0c: { // CMPX
        const m = this.operand16(op);
        this.sub16(this.x, m);
        this.cyc += 1;
        return;
      }
      case 0x4c: this.d = this.nzv16(this.operand16(op)); return;   // LDD
      case 0x0d: {
        if ((op & 0x30) === 0) { // BSR: offset + 3 dead cycles + 2 pushes
          const off = s8(this.fetch());
          const ea = (this.pc + off) & 0xffff;
          this.cyc += 3;
          this.jsr(ea);
        } else { // JSR: EA + dummy read + dead cycle + 2 pushes
          const ea = this.eaOf(op);
          this.cyc += 2;
          this.jsr(ea);
        }
        return;
      }
      case 0x4d: { // STD ($CD itself is free-run, handled in exec)
        const ea = this.eaOf(op);
        const d = this.d;
        this.wr16(ea, d);
        this.nzv16(d);
        return;
      }
      case 0x0e: this.x = this.nzv16(this.operand16(op)); return;   // LDX
      case 0x4e: this.u = this.nzv16(this.operand16(op)); return;   // LDU
      case 0x0f:
      case 0x4f: {
        const isU = (op & 0x40) !== 0;
        if ((op & 0x30) === 0) {
          this.xst16(isU ? this.u : this.x);
        } else {
          const ea = this.eaOf(op);
          const v = isU ? this.u : this.x;
          this.wr16(ea, v);
          this.nzv16(v);
        }
        return;
      }
      default:
        throw new Error(`alu: unreachable opcode ${op}`);
    }
  }

  /**
   * Fetch and execute one instruction. The loop only repeats for a page
   * 2/3 prefix followed by a byte that is not a page 2/3 opcode: MAME then
   * jumps to DISPATCH01, which fetches ANOTHER opcode byte, so "$10 xx yy"
   * with an undefined xx executes yy (in the same step, with no interrupt
   * check in between). MAME's own disassembler instead shows "$10 xx" as
   * xx; the core is what counts here.
   * @returns {void}
   */
  exec() {
    for (;;) {
      const op = this.fetch();
      // "Halt and catch fire": every step is one discarded fetch.
      if (this.freeRun) return;
      if (this.onUndocumented !== null && UNDOC1[op] !== 0) {
        this.onUndocumented(this.ppc, op);
      }
      switch (op) {
        case 0x00: case 0x01: case 0x02: case 0x03:
        case 0x04: case 0x05: case 0x06: case 0x07:
        case 0x08: case 0x09: case 0x0a: case 0x0b:
        case 0x0c: case 0x0d: case 0x0e: case 0x0f:
          this.memOp(op & 0x0f, this.direct());
          return;
        case 0x10:
          if (this.page2()) continue;
          return;
        case 0x11:
          if (this.page3()) continue;
          return;
        case 0x12: case 0x1b: // NOP (and its undocumented twin)
          this.cyc += 1;
          return;
        case 0x13: // SYNC: dummy read, then wait for any interrupt line
          this.cyc += 1;
          if (this.nmiAsserted || this.firqLine || this.irqLine) {
            this.cyc += 1;
          } else {
            this.wait = WAIT_SYNC;
          }
          return;
        case 0x14: case 0x15: case 0xcd:
          this.freeRun = true;
          return;
        case 0x16: { // LBRA: 2 offset bytes + dead + taken-dead cycle
          const off = this.fetch16();
          this.cyc += 2;
          this.pc = (this.pc + off) & 0xffff;
          return;
        }
        case 0x17: { // LBSR: 2 offset bytes + 4 dead + 2 pushes
          const off = this.fetch16();
          const ea = (this.pc + off) & 0xffff;
          this.cyc += 4;
          this.jsr(ea);
          return;
        }
        case 0x18: {
          // X18: reads the byte at PC WITHOUT consuming it, then
          // CC = ((CC & byte) << 1) | (Z ? V : 0) -- MAME's formula.
          const m = this.rd(this.pc);
          this.cc = (((this.cc & m) << 1) & 0xff) | ((this.cc & CC_Z) >> 1);
          return;
        }
        case 0x19:
          this.daa();
          this.cyc += 1;
          return;
        case 0x1a: // ORCC: operand + dummy read
          this.cc |= this.fetch();
          this.cyc += 1;
          return;
        case 0x1c: // ANDCC
          this.cc &= this.fetch();
          this.cyc += 1;
          return;
        case 0x1d: { // SEX: N and Z from the 16-bit result, V untouched
          const b = this.b;
          this.a = b & 0x80 ? 0xff : 0x00;
          let cc = this.cc & ~(CC_N | CC_Z);
          cc |= (b & 0x80) >> 4;
          if (b === 0) cc |= CC_Z;
          this.cc = cc;
          this.cyc += 1;
          return;
        }
        case 0x1e:
          this.exg(this.fetch());
          this.cyc += 6;
          return;
        case 0x1f:
          this.tfr(this.fetch());
          this.cyc += 4;
          return;
        case 0x20: case 0x21: case 0x22: case 0x23:
        case 0x24: case 0x25: case 0x26: case 0x27:
        case 0x28: case 0x29: case 0x2a: case 0x2b:
        case 0x2c: case 0x2d: case 0x2e: case 0x2f: {
          const off = s8(this.fetch());
          this.cyc += 1;
          if (this.cond(op & 0x0f)) this.pc = (this.pc + off) & 0xffff;
          return;
        }
        case 0x30: case 0x31: { // LEAX/LEAY: Z only
          const ea = this.indexed();
          if (op === 0x30) this.x = ea; else this.y = ea;
          this.cc = (this.cc & ~CC_Z) | (ea === 0 ? CC_Z : 0);
          this.cyc += 1;
          return;
        }
        case 0x32: // LEAS: no flags, arms NMI
          this.s = this.indexed();
          this.ldsEncountered = true;
          this.cyc += 1;
          return;
        case 0x33:
          this.u = this.indexed();
          this.cyc += 1;
          return;
        case 0x34: case 0x36: {
          // PSHS/PSHU: postbyte, 2 dead cycles, a real read at the stack
          // pointer, then one cycle per byte.
          const m = this.fetch();
          this.cyc += 2;
          this.rd(op === 0x34 ? this.s : this.u);
          this.push(m, op === 0x36);
          return;
        }
        case 0x35: case 0x37: {
          const m = this.fetch();
          this.cyc += 2;
          this.pull(m, op === 0x37);
          return;
        }
        case 0x38: // XANDCC: one extra cycle, then ANDCC
          this.cyc += 1;
          this.cc &= this.fetch();
          this.cyc += 1;
          return;
        case 0x39: // RTS = dummy read + PULS PC
          this.cyc += 1;
          this.pull(0x80, false);
          return;
        case 0x3a:
          this.x = (this.x + this.b) & 0xffff;
          this.cyc += 2;
          return;
        case 0x3b: // RTI: pull CC, then the rest depending on E
          this.cyc += 1;
          this.cc = this.rd(this.s);
          this.s = (this.s + 1) & 0xffff;
          this.pull((this.cc & CC_E ? ENTIRE : PARTIAL) & ~1, false);
          return;
        case 0x3c: { // CWAI: AND CC, stack everything, wait
          this.cc &= this.fetch();
          this.cyc += 2;
          this.cc |= CC_E;
          this.push(ENTIRE, false);
          const v = this.pendingVector();
          if (v !== 0) this.cwaiWake(v);
          else this.wait = WAIT_CWAI;
          return;
        }
        case 0x3d: { // MUL: Z from D, C = bit 7 of D; 11 cycles
          const r = this.a * this.b;
          this.a = r >> 8;
          this.b = r & 0xff;
          let cc = this.cc & ~(CC_Z | CC_C);
          if (r === 0) cc |= CC_Z;
          if (r & 0x80) cc |= CC_C;
          this.cc = cc;
          this.cyc += 10;
          return;
        }
        case 0x3e: // XRES: stack everything (E untouched), vector $FFFE
          this.softInt(VECTOR_RESET, false, false);
          return;
        case 0x3f:
          this.softInt(VECTOR_SWI, true, true);
          return;
        case 0x40: case 0x41: case 0x42: case 0x43:
        case 0x44: case 0x45: case 0x46: case 0x47:
        case 0x48: case 0x49: case 0x4a: case 0x4b:
        case 0x4c: case 0x4d: case 0x4e: case 0x4f:
          this.a = this.regOp(op & 0x0f, this.a);
          return;
        case 0x50: case 0x51: case 0x52: case 0x53:
        case 0x54: case 0x55: case 0x56: case 0x57:
        case 0x58: case 0x59: case 0x5a: case 0x5b:
        case 0x5c: case 0x5d: case 0x5e: case 0x5f:
          this.b = this.regOp(op & 0x0f, this.b);
          return;
        case 0x60: case 0x61: case 0x62: case 0x63:
        case 0x64: case 0x65: case 0x66: case 0x67:
        case 0x68: case 0x69: case 0x6a: case 0x6b:
        case 0x6c: case 0x6d: case 0x6e: case 0x6f:
          this.memOp(op & 0x0f, this.indexed());
          return;
        case 0x70: case 0x71: case 0x72: case 0x73:
        case 0x74: case 0x75: case 0x76: case 0x77:
        case 0x78: case 0x79: case 0x7a: case 0x7b:
        case 0x7c: case 0x7d: case 0x7e: case 0x7f:
          this.memOp(op & 0x0f, this.extended());
          return;
        default:
          this.alu(op);
          return;
      }
    }
  }

  /**
   * Fetch the next opcode byte after a prefix; further $10/$11 bytes keep
   * the page chosen by the first prefix (MAME DISPATCH10/11 loop to
   * themselves). The guard only matters if all 64K read as prefixes.
   * @returns {number}
   */
  fetchPaged() {
    let op = this.fetch();
    for (let n = 0; (op === 0x10 || op === 0x11) && n < 0x10000; n += 1) {
      op = this.fetch();
    }
    return op;
  }

  /**
   * Page 2 ($10 prefix). Cycle counts include the prefix fetch.
   * @returns {boolean} true if the byte was not a page 2 opcode and the
   *   caller must fetch and run a page 1 opcode (MAME DISPATCH01)
   */
  page2() {
    const op = this.fetchPaged();
    if (this.onUndocumented !== null && UNDOC2[op] !== 0) {
      this.onUndocumented(this.ppc, 0x1000 | op);
    }
    switch (op) {
      case 0x20: case 0x21: case 0x22: case 0x23:
      case 0x24: case 0x25: case 0x26: case 0x27:
      case 0x28: case 0x29: case 0x2a: case 0x2b:
      case 0x2c: case 0x2d: case 0x2e: case 0x2f: {
        // LBcc: one more dead cycle when taken ($10 $20 = always taken)
        const off = this.fetch16();
        this.cyc += 1;
        if (this.cond(op & 0x0f)) {
          this.pc = (this.pc + off) & 0xffff;
          this.cyc += 1;
        }
        return false;
      }
      case 0x3e: this.softInt(VECTOR_SWI2, false, false); return false;
      case 0x3f: this.softInt(VECTOR_SWI2, true, false); return false;
      case 0x83: case 0x93: case 0xa3: case 0xb3: { // CMPD
        const m = this.operand16(op);
        this.sub16(this.d, m);
        this.cyc += 1;
        return false;
      }
      case 0x8c: case 0x9c: case 0xac: case 0xbc: { // CMPY
        const m = this.operand16(op);
        this.sub16(this.y, m);
        this.cyc += 1;
        return false;
      }
      case 0xc3: case 0xd3: case 0xe3: case 0xf3: { // XADDD: flags only
        const m = this.operand16(op);
        this.add16(this.d, m);
        this.cyc += 1;
        return false;
      }
      case 0x8e: case 0x9e: case 0xae: case 0xbe: // LDY
        this.y = this.nzv16(this.operand16(op));
        return false;
      case 0xce: case 0xde: case 0xee: case 0xfe: // LDS arms NMI
        this.s = this.nzv16(this.operand16(op));
        this.ldsEncountered = true;
        return false;
      case 0x9f: case 0xaf: case 0xbf: { // STY
        const ea = this.eaOf(op);
        this.wr16(ea, this.y);
        this.nzv16(this.y);
        return false;
      }
      case 0xdf: case 0xef: case 0xff: { // STS
        const ea = this.eaOf(op);
        this.wr16(ea, this.s);
        this.nzv16(this.s);
        return false;
      }
      case 0x87: this.fetch(); this.nzv8(this.a); return false;  // XSTA #
      case 0xc7: this.fetch(); this.nzv8(this.b); return false;  // XSTB #
      case 0x8f: this.xst16(this.y); return false;               // XSTY #
      case 0xcf: this.xst16(this.s); return false;               // XSTS #
      default: return true;
    }
  }

  /**
   * Page 3 ($11 prefix).
   * @returns {boolean} as page2()
   */
  page3() {
    const op = this.fetchPaged();
    if (this.onUndocumented !== null && UNDOC3[op] !== 0) {
      this.onUndocumented(this.ppc, 0x1100 | op);
    }
    switch (op) {
      case 0x3e: this.softInt(VECTOR_FIRQ, false, false); return false;
      case 0x3f: this.softInt(VECTOR_SWI3, true, false); return false;
      case 0x83: case 0x93: case 0xa3: case 0xb3: { // CMPU
        const m = this.operand16(op);
        this.sub16(this.u, m);
        this.cyc += 1;
        return false;
      }
      case 0x8c: case 0x9c: case 0xac: case 0xbc: { // CMPS
        const m = this.operand16(op);
        this.sub16(this.s, m);
        this.cyc += 1;
        return false;
      }
      case 0xc3: case 0xd3: case 0xe3: case 0xf3: { // XADDU: flags only
        const m = this.operand16(op);
        this.add16(this.u, m);
        this.cyc += 1;
        return false;
      }
      case 0x87: this.fetch(); this.nzv8(this.a); return false;  // XSTA #
      case 0xc7: this.fetch(); this.nzv8(this.b); return false;  // XSTB #
      case 0x8f: this.xst16(this.x); return false;               // XSTX #
      case 0xcf: this.xst16(this.u); return false;               // XSTU #
      default: return true;
    }
  }
}

export default M6809;

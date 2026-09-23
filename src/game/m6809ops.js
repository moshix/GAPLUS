// Copyright 2026 by Moshix
/**
 * Exact MC6809 arithmetic for the port, for the places where the original
 * leans on a flag, on BCD or on a carry threaded from one instruction into
 * the next: score addition (`adda` / `daa`), 16-bit compares feeding a
 * signed branch, `rola` chains, `mul` for table indexing, and so on.
 *
 * Semantics are MAME's (reference/mame/m6809/base6x09.lst and
 * m6809inl.h `set_flags`, `daa`, `mul`), which is what the oracle runs:
 *
 *   H  = carry from bit 3 to 4 (8-bit ADD/ADC only; SUB/CMP leave H)
 *   N  = top bit of the result
 *   Z  = result == 0 (8 or 16 bits)
 *   V  = carry into the top bit XOR carry out of it
 *   C  = carry (add) or borrow (sub) out of the top bit
 *
 * Every function is pure. It takes the operands and the current CC byte
 * (for carry-in / H, and so that untouched bits survive) and returns a
 * {@link AluResult}: the result `v`, the new full CC byte `cc`, and the
 * flags as booleans `cf zf nf vf hf` -- the same names the calling
 * convention uses (docs/porting-guide.md section 4).
 *
 * test/unit/m6809ops.test.mjs checks the 8-bit operations exhaustively
 * against an independent reference model (and against the oracle's CPU
 * core), and the 16-bit ones on dense samples.
 */

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
/** Entire state stacked. */
export const CC_E = 0x80;

/**
 * @typedef {object} AluResult
 * @property {number} v   result (8 or 16 bits)
 * @property {number} cc  complete new CC byte
 * @property {boolean} cf carry
 * @property {boolean} zf zero
 * @property {boolean} nf negative
 * @property {boolean} vf overflow
 * @property {boolean} hf half carry
 */

/**
 * @param {number} v @param {number} cc @returns {AluResult}
 */
const res = (v, cc) => ({
  v,
  cc,
  cf: (cc & CC_C) !== 0,
  zf: (cc & CC_Z) !== 0,
  nf: (cc & CC_N) !== 0,
  vf: (cc & CC_V) !== 0,
  hf: (cc & CC_H) !== 0,
});

/**
 * Build a CC byte from booleans (for tests and for seeding a chain from a
 * routine's flag inputs).
 * @param {{ cf?: boolean, zf?: boolean, nf?: boolean, vf?: boolean, hf?: boolean }} f
 * @param {number} [base] bits to keep (I, F, E)
 * @returns {number}
 */
export function ccOf(f, base = 0) {
  let cc = base & ~(CC_C | CC_V | CC_Z | CC_N | CC_H);
  if (f.cf) cc |= CC_C;
  if (f.vf) cc |= CC_V;
  if (f.zf) cc |= CC_Z;
  if (f.nf) cc |= CC_N;
  if (f.hf) cc |= CC_H;
  return cc & 0xff;
}

// ----------------------------------------------------- sign extension

/** Signed value of a byte (-128..127). @param {number} v @returns {number} */
export const s8 = (v) => ((v & 0xff) ^ 0x80) - 0x80;

/** Signed value of a word (-32768..32767). @param {number} v @returns {number} */
export const s16 = (v) => ((v & 0xffff) ^ 0x8000) - 0x8000;

/**
 * Effective address of an 8-bit signed offset (`lda -3,x`, `bra`):
 * base + sign-extended d, wrapped to 16 bits.
 * @param {number} base @param {number} d offset byte
 * @returns {number}
 */
export const disp8 = (base, d) => (base + s8(d)) & 0xffff;

/**
 * Effective address of a 16-bit offset (`ldd $1234,x`, `lbra`): wraps.
 * @param {number} base @param {number} d @returns {number}
 */
export const disp16 = (base, d) => (base + d) & 0xffff;

/**
 * `abx`: X + B (unsigned), no flags.
 * @param {number} x @param {number} b @returns {number}
 */
export const abx = (x, b) => (x + (b & 0xff)) & 0xffff;

// ------------------------------------------------------ flag helpers

const NZVC = CC_N | CC_Z | CC_V | CC_C;

/**
 * MAME set_flags for an 8-bit add/sub: `r` is the full-width result
 * (a + b + c, or a - b - c as a C int). V = bit 7 of a^b^r^(r>>1): the
 * carry into bit 7 XOR the carry out of it.
 * @param {number} cc @param {number} a @param {number} b @param {number} r
 * @param {boolean} h also compute H
 * @returns {AluResult}
 */
function flags8(cc, a, b, r, h) {
  let c = cc & ~(NZVC | (h ? CC_H : 0));
  if (h && ((a ^ b ^ r) & 0x10)) c |= CC_H;
  if (r & 0x80) c |= CC_N;
  if ((r & 0xff) === 0) c |= CC_Z;
  if ((a ^ b ^ r ^ (r >> 1)) & 0x80) c |= CC_V;
  if (r & 0x100) c |= CC_C;
  return res(r & 0xff, c & 0xff);
}

/** 16-bit version of {@link flags8} (no H). */
function flags16(
  /** @type {number} */ cc, /** @type {number} */ a,
  /** @type {number} */ b, /** @type {number} */ r,
) {
  let c = cc & ~NZVC;
  if (r & 0x8000) c |= CC_N;
  if ((r & 0xffff) === 0) c |= CC_Z;
  if ((a ^ b ^ r ^ (r >> 1)) & 0x8000) c |= CC_V;
  if (r & 0x10000) c |= CC_C;
  return res(r & 0xffff, c & 0xff);
}

/**
 * N and Z from an 8-bit value, V cleared, C kept: LD, ST, TST, AND, OR,
 * EOR, BIT all leave exactly these flags.
 * @param {number} v @param {number} [cc] @returns {AluResult}
 */
export function nzv8(v, cc = 0) {
  const x = v & 0xff;
  let c = cc & ~(CC_N | CC_Z | CC_V);
  if (x & 0x80) c |= CC_N;
  if (x === 0) c |= CC_Z;
  return res(x, c & 0xff);
}

/**
 * N and Z from a 16-bit value, V cleared: LDD/LDX/LDY/LDU/LDS, STD...
 * @param {number} v @param {number} [cc] @returns {AluResult}
 */
export function nzv16(v, cc = 0) {
  const x = v & 0xffff;
  let c = cc & ~(CC_N | CC_Z | CC_V);
  if (x & 0x8000) c |= CC_N;
  if (x === 0) c |= CC_Z;
  return res(x, c & 0xff);
}

/** N and Z only (V, C untouched). @param {number} v @param {number} cc */
function nz8(v, cc) {
  let c = cc & ~(CC_N | CC_Z);
  if (v & 0x80) c |= CC_N;
  if ((v & 0xff) === 0) c |= CC_Z;
  return res(v & 0xff, c & 0xff);
}

// ------------------------------------------------------ 8-bit ALU

/** `adda`/`addb`: H N Z V C. @param {number} a @param {number} b @param {number} [cc] */
export const add8 = (a, b, cc = 0) => flags8(cc, a & 0xff, b & 0xff, (a & 0xff) + (b & 0xff), true);

/** `adca`/`adcb`: A + B + C. @param {number} a @param {number} b @param {number} cc */
export const adc8 = (a, b, cc) =>
  flags8(cc, a & 0xff, b & 0xff, (a & 0xff) + (b & 0xff) + (cc & CC_C), true);

/**
 * `suba`/`subb`: N Z V C (C = borrow). H is left alone, as in MAME.
 * @param {number} a @param {number} b @param {number} [cc]
 */
export const sub8 = (a, b, cc = 0) => flags8(cc, a & 0xff, b & 0xff, (a & 0xff) - (b & 0xff), false);

/** `sbca`/`sbcb`: A - B - C. @param {number} a @param {number} b @param {number} cc */
export const sbc8 = (a, b, cc) =>
  flags8(cc, a & 0xff, b & 0xff, (a & 0xff) - (b & 0xff) - (cc & CC_C), false);

/**
 * `cmpa`/`cmpb`: flags of A - B. `v` is the (discarded) difference; the
 * register is unchanged.
 * @param {number} a @param {number} b @param {number} [cc]
 */
export const cmp8 = (a, b, cc = 0) => sub8(a, b, cc);

/**
 * `neg`: 0 - v. C = (v != 0), V = (v == $80).
 * @param {number} v @param {number} [cc]
 */
export const neg8 = (v, cc = 0) => flags8(cc, 0, v & 0xff, -(v & 0xff), false);

/**
 * `com`: ~v; N Z, V = 0, C = 1.
 * @param {number} v @param {number} [cc]
 */
export const com8 = (v, cc = 0) => nz8(~v & 0xff, ((cc & ~CC_V) | CC_C) & 0xff);

/**
 * `inc`: N Z V (V when $7F -> $80), C untouched.
 * @param {number} v @param {number} [cc]
 */
export function inc8(v, cc = 0) {
  const x = v & 0xff;
  const r = flags8(cc, x, 1, x + 1, false);
  // flags8 set C from bit 8; INC must leave C as it was.
  return res(r.v, (r.cc & ~CC_C) | (cc & CC_C));
}

/**
 * `dec`: N Z V (V when $80 -> $7F), C untouched.
 * @param {number} v @param {number} [cc]
 */
export function dec8(v, cc = 0) {
  const x = v & 0xff;
  // MAME: set_flags(CC_NZV, v, 1, v - 1).
  const r = flags8(cc, x, 1, x - 1, false);
  return res(r.v, (r.cc & ~CC_C) | (cc & CC_C));
}

/** `tst`: N Z, V = 0, C untouched. @param {number} v @param {number} [cc] */
export const tst8 = (v, cc = 0) => nzv8(v, cc);

/**
 * `clr`: result 0, N=0 Z=1 V=0 C=0. (Remember CLR of a memory byte READS
 * it first on the 6809E; see the porting guide.)
 * @param {number} [cc]
 */
export const clr8 = (cc = 0) => res(0, ((cc & ~NZVC) | CC_Z) & 0xff);

/** `anda`/`andb` (and `bita` for the flags). @param {number} a @param {number} b @param {number} [cc] */
export const and8 = (a, b, cc = 0) => nzv8(a & b, cc);
/** `ora`/`orb`. @param {number} a @param {number} b @param {number} [cc] */
export const or8 = (a, b, cc = 0) => nzv8(a | b, cc);
/** `eora`/`eorb`. @param {number} a @param {number} b @param {number} [cc] */
export const eor8 = (a, b, cc = 0) => nzv8(a ^ b, cc);
/** `bita`/`bitb`: flags of A & B, A unchanged. @param {number} a @param {number} b @param {number} [cc] */
export const bit8 = (a, b, cc = 0) => nzv8(a & b, cc);

// ------------------------------------------------------ shifts, rotates

/**
 * `lsr`: 0 -> b7 ... b0 -> C. N = 0, Z; V untouched.
 * @param {number} v @param {number} [cc]
 */
export function lsr8(v, cc = 0) {
  const x = v & 0xff;
  return nz8(x >> 1, (cc & ~CC_C) | (x & 1));
}

/**
 * `asr`: b7 kept, b0 -> C. N Z; V untouched.
 * @param {number} v @param {number} [cc]
 */
export function asr8(v, cc = 0) {
  const x = v & 0xff;
  return nz8((x >> 1) | (x & 0x80), (cc & ~CC_C) | (x & 1));
}

/**
 * `asl`/`lsl`: b7 -> C, 0 -> b0. V = b7 ^ b6 (of the operand).
 * @param {number} v @param {number} [cc]
 */
export function asl8(v, cc = 0) {
  const x = v & 0xff;
  // MAME: set_flags(CC_NZVC, v, v, v << 1): V = bit 7 of (r ^ r >> 1).
  return flags8(cc, x, x, x << 1, false);
}

/** Alias: `lsl` is the same opcode as `asl`. */
export const lsl8 = asl8;

/**
 * `rol`: C -> b0, b7 -> C. V = b7 ^ b6 (of the operand).
 * @param {number} v @param {number} cc
 */
export function rol8(v, cc) {
  const x = v & 0xff;
  return flags8(cc, x, x, (x << 1) | (cc & CC_C), false);
}

/**
 * `ror`: C -> b7, b0 -> C. N Z; V untouched.
 * @param {number} v @param {number} cc
 */
export function ror8(v, cc) {
  const x = v & 0xff;
  return nz8((x >> 1) | ((cc & CC_C) << 7), (cc & ~CC_C) | (x & 1));
}

// ------------------------------------------------------ BCD, MUL, SEX

/**
 * `daa` after `adda`/`adca` (MAME m6809inl.h): add $06 if the low nibble
 * is > 9 or H is set; add $60 if C is set or A > $99 (MAME's "msn > 9, or
 * msn > 8 with lsn > 9"). C is only ever SET (a carry from the add
 * survives); V is cleared; N and Z from the result; H untouched.
 * @param {number} a @param {number} cc CC left by the add
 * @returns {AluResult}
 */
export function daa(a, cc) {
  const x = a & 0xff;
  const msn = x & 0xf0;
  const lsn = x & 0x0f;
  let cf = 0;
  if (lsn > 0x09 || (cc & CC_H)) cf |= 0x06;
  if (msn > 0x80 && lsn > 0x09) cf |= 0x60;
  if (msn > 0x90 || (cc & CC_C)) cf |= 0x60;
  const t = x + cf;
  let c = cc & ~CC_V;
  if (t & 0x100) c |= CC_C;
  return nz8(t & 0xff, c & 0xff);
}

/**
 * `mul`: D = A * B (unsigned). Z from D; C = bit 7 of the result (B),
 * so that `adca #0` after it rounds. N, V, H untouched.
 * @param {number} a @param {number} b @param {number} [cc]
 * @returns {AluResult & { a: number, b: number }}
 */
export function mul(a, b, cc = 0) {
  const d = (a & 0xff) * (b & 0xff);
  let c = cc & ~(CC_Z | CC_C);
  if (d === 0) c |= CC_Z;
  if (d & 0x80) c |= CC_C;
  return { ...res(d, c & 0xff), a: d >> 8, b: d & 0xff };
}

/**
 * `sex`: D = B sign-extended. N Z from D; V untouched (MAME).
 * @param {number} b @param {number} [cc]
 * @returns {AluResult & { a: number, b: number }}
 */
export function sex(b, cc = 0) {
  const lo = b & 0xff;
  const d = lo & 0x80 ? 0xff00 | lo : lo;
  let c = cc & ~(CC_N | CC_Z);
  if (d & 0x8000) c |= CC_N;
  if (d === 0) c |= CC_Z;
  return { ...res(d, c & 0xff), a: d >> 8, b: lo };
}

// ------------------------------------------------------ 16-bit ALU

/** `addd`: N Z V C (no H). @param {number} d @param {number} m @param {number} [cc] */
export const add16 = (d, m, cc = 0) =>
  flags16(cc, d & 0xffff, m & 0xffff, (d & 0xffff) + (m & 0xffff));

/** `subd`: N Z V C. @param {number} d @param {number} m @param {number} [cc] */
export const sub16 = (d, m, cc = 0) =>
  flags16(cc, d & 0xffff, m & 0xffff, (d & 0xffff) - (m & 0xffff));

/**
 * `cmpd`/`cmpx`/`cmpy`/`cmpu`/`cmps`: flags of R - M; `v` is the
 * difference, the register is unchanged.
 * @param {number} r @param {number} m @param {number} [cc]
 */
export const cmp16 = (r, m, cc = 0) => sub16(r, m, cc);

/**
 * `leax`/`leay`: Z from the new value, nothing else. (`leau`/`leas` set
 * no flags at all.)
 * @param {number} ea @param {number} [cc] @returns {AluResult}
 */
export function leaXY(ea, cc = 0) {
  const v = ea & 0xffff;
  return res(v, ((cc & ~CC_Z) | (v === 0 ? CC_Z : 0)) & 0xff);
}

// ------------------------------------------------------ word helpers

/** A:B -> D. @param {number} a @param {number} b @returns {number} */
export const dOf = (a, b) => ((a & 0xff) << 8) | (b & 0xff);
/** High byte (A) of D. @param {number} d @returns {number} */
export const hi = (d) => (d >> 8) & 0xff;
/** Low byte (B) of D. @param {number} d @returns {number} */
export const lo = (d) => d & 0xff;

// ------------------------------------------------------ branches

/**
 * Branch conditions, by mnemonic suffix, from a CC byte:
 * `cond(cc, 'hi')` is true when `bhi` would branch.
 * @param {number} cc
 * @param {'ra'|'rn'|'hi'|'ls'|'cc'|'hs'|'cs'|'lo'|'ne'|'eq'|'vc'|'vs'|
 *   'pl'|'mi'|'ge'|'lt'|'gt'|'le'} c
 * @returns {boolean}
 */
export function cond(cc, c) {
  const C = (cc & CC_C) !== 0;
  const Z = (cc & CC_Z) !== 0;
  const N = (cc & CC_N) !== 0;
  const V = (cc & CC_V) !== 0;
  switch (c) {
    case 'ra': return true;
    case 'rn': return false;
    case 'hi': return !C && !Z;          // unsigned >
    case 'ls': return C || Z;            // unsigned <=
    case 'cc': case 'hs': return !C;     // unsigned >=
    case 'cs': case 'lo': return C;      // unsigned <
    case 'ne': return !Z;
    case 'eq': return Z;
    case 'vc': return !V;
    case 'vs': return V;
    case 'pl': return !N;
    case 'mi': return N;
    case 'ge': return N === V;           // signed >=
    case 'lt': return N !== V;           // signed <
    case 'gt': return N === V && !Z;     // signed >
    case 'le': return N !== V || Z;      // signed <=
    default: throw new Error(`unknown condition ${String(c)}`);
  }
}

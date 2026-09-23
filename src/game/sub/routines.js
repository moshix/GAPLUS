// Copyright 2026 by Moshix
/**
 * The sub CPU's routine tables (ROMs gp2-8 $A000, gp2-7 $C000, gp2-6 $E000).
 * A leaf module with no imports, so every module of this CPU can register
 * into it and call through it no matter which order the modules load in.
 * @see docs/porting-guide.md section 3
 */

/**
 * Routine name (the label in reference/gaplus-sub.asm) -> function.
 * @type {Record<string, Function>}
 */
export const SUB = {};

/**
 * CPU address -> function, for everything reached indirectly: jump
 * tables (`jmp [a,x]`), pointers held in RAM or ROM data, vectors.
 * @type {Record<number, Function>}
 */
export const SUB_AT = {};

/**
 * Look up a routine by address, failing loudly when the port lacks it.
 * @param {number} addr
 * @returns {Function}
 */
export function subAt(addr) {
  const fn = SUB_AT[addr & 0xffff];
  if (fn === undefined) {
    const hex = (addr & 0xffff).toString(16).toUpperCase().padStart(4, '0');
    throw new Error(`sub CPU: no routine registered at $${hex}`);
  }
  return fn;
}

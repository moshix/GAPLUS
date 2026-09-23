// Copyright 2026 by Moshix
/**
 * The sound CPU's routine tables (ROM gp2-1 $E000).
 * A leaf module with no imports, so every module of this CPU can register
 * into it and call through it no matter which order the modules load in.
 * @see docs/porting-guide.md section 3
 */

/**
 * Routine name (the label in reference/gaplus-sound.asm) -> function.
 * @type {Record<string, Function>}
 */
export const SOUND = {};

/**
 * CPU address -> function, for everything reached indirectly: jump
 * tables (`jmp [a,x]`), pointers held in RAM or ROM data, vectors.
 * @type {Record<number, Function>}
 */
export const SOUND_AT = {};

/**
 * Look up a routine by address, failing loudly when the port lacks it.
 * @param {number} addr
 * @returns {Function}
 */
export function soundAt(addr) {
  const fn = SOUND_AT[addr & 0xffff];
  if (fn === undefined) {
    const hex = (addr & 0xffff).toString(16).toUpperCase().padStart(4, '0');
    throw new Error(`sound CPU: no routine registered at $${hex}`);
  }
  return fn;
}

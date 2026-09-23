// Copyright 2026 by Moshix
/**
 * MAME pen numbers -> indirect colours, for the few places that deal in raw
 * pens rather than (colour code, pixel) pairs: the background fill
 * (bitmap.fill(0) in screen_update) and the starfield, which writes pen
 * numbers straight into the bitmap (starfield_render).
 *
 *   pens 0x000-0x0FF  char colour * 4 + pixel    -> CHAR_LUT
 *   pens 0x100-0x2FF  sprite colour * 8 + pixel  -> SPRITE_LUT
 */
import { CHAR_LUT, SPRITE_LUT, SPRITE_PEN_BASE, PEN_COUNT } from './palette.js';

/**
 * The indirect colour (0-255) a pen shows as.
 * @param {number} pen 0 to PEN_COUNT - 1
 * @returns {number}
 */
export function penIndirect(pen) {
  if (pen < 0 || pen >= PEN_COUNT) throw new RangeError(`pen ${pen} out of range`);
  return pen < SPRITE_PEN_BASE ? CHAR_LUT[pen] : SPRITE_LUT[pen - SPRITE_PEN_BASE];
}

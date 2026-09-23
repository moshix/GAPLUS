// Copyright 2026 by Moshix
/**
 * favicon.png: the player's fighter, straight from the sprite ROM and colour
 * PROMs (via the generated src/video tables), scaled 2x to 32x32 with a
 * transparent background. Generated, never drawn by hand:
 *
 *   node tools/gen-favicon.mjs [code] [colour]
 *
 * Defaults: sprite $2E in colour 0, the fighter as the game draws it
 * during play (sprite registers at $0F80-$0F81 on the real ROM).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './romset.mjs';
import { SPRITE_PIXELS } from '../src/video/gfxdata.js';
import { PALETTE, SPRITE_LUT, SPRITE_TRANSPARENT } from '../src/video/palette.js';
import { encodePng } from './png.mjs';

/**
 * The 16x16 sprite as the player sees it, RGBA with transparent pixels.
 * @param {number} code 0-383 @param {number} colour 0-63
 * @returns {Uint8Array}
 */
export function faviconPixels(code, colour) {
  const px = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      // Sprites are stored as the monitor scans them; the cabinet's monitor
      // is turned 90 degrees (ROT90: player x = 15 - raster y, player y =
      // raster x), so the player's view is a quarter turn of that.
      const pen = SPRITE_PIXELS[code * 256 + (15 - x) * 16 + y];
      // Sprite colours have 8 pens each (3 bits per pixel).
      const idx = SPRITE_LUT[colour * 8 + pen];
      if (idx === SPRITE_TRANSPARENT) continue; // alpha stays 0
      const [r, g, b] = PALETTE[idx];
      px.set([r, g, b, 255], (y * 16 + x) * 4);
    }
  }
  return px;
}

function main() {
  const [code = 0x2e, colour = 0] = process.argv.slice(2).map(Number);
  const out = process.env.FAVICON_OUT ?? join(ROOT, 'favicon.png');
  writeFileSync(out, encodePng(faviconPixels(code, colour), 16, 16, 2));
  console.log(`${out}: sprite ${code}, colour ${colour}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

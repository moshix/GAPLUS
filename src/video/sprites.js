// Copyright 2026 by Moshix
/**
 * The 64 hardware sprites: gaplus_base_state::draw_sprites()
 * (reference/mame/namco/gaplus_v.cpp), register for register.
 *
 * The sprite registers are the top $80 bytes of each of the three 2 KB work
 * RAM banks (main CPU addresses; the sub CPU sees the same RAM). Sprite n
 * (0-63) uses the byte pair at +2n in each block:
 *
 *   $0F80+2n  code bits 0-7          $0F81+2n  bits 0-5 colour (0-63)
 *   $1780+2n  Y: raster line          $1781+2n  X bits 0-7
 *             = ((248 - v - 16*sizey) & 0xff) - 32
 *   $1F80+2n  bit 0 flip X            $1F81+2n  bit 0 X bit 8
 *             bit 1 flip Y                      bit 1 1 = sprite off
 *             bit 3 double width (X)
 *             bit 5 double height (Y)
 *             bit 6 code bit 8
 *             bit 7 "duplicate": all quarters of a double sprite use the
 *                   same code instead of code+0..3
 *
 * Raster X = X - 71 (bits 0-8). Flip screen toggles each sprite's flip bits
 * only; MAME does NOT mirror sprite positions, so the game must do that
 * itself in cocktail mode.
 *
 * MAME's own caveat (gaplus.cpp TODO): "Is the sprite generator the same as
 * Phozon? This isn't clear yet." The driver is flagged
 * MACHINE_IMPERFECT_GRAPHICS.
 */
import { SPRITE_PIXELS, SPRITE_COUNT } from './gfxdata.js';
import { SPRITE_LUT, SPRITE_TRANSPARENT } from './palette.js';
import { RASTER_WIDTH, RASTER_HEIGHT } from './tiles.js';

/** Main-CPU addresses of the three sprite register blocks. */
export const SPRITE_RAM1 = 0x0f80;
export const SPRITE_RAM2 = 0x1780;
export const SPRITE_RAM3 = 0x1f80;
/** Number of sprite register pairs. */
export const SPRITE_SLOTS = 64;

/**
 * gfx_offs[][] of draw_sprites(): the sub-sprite codes of a double-size
 * sprite, [row][col] in raster space.
 */
const GFX_OFFS = [[0, 1], [2, 3]];

/**
 * @typedef {object} SpriteAttrs
 * @property {boolean} enabled
 * @property {number} code 0-511 (bit 8 from $1F80 bit 6)
 * @property {number} color 0-63
 * @property {number} sx raster X of the left edge
 * @property {number} sy raster Y of the top edge (after the wrap)
 * @property {number} flipx @property {number} flipy
 * @property {number} sizex @property {number} sizey 0 = 16 px, 1 = 32 px
 * @property {boolean} duplicate
 */

/**
 * Decode sprite n's registers exactly as draw_sprites() does, before the
 * flip-screen toggle.
 * @param {Uint8Array} mem main CPU address space
 * @param {number} n 0-63
 * @returns {SpriteAttrs}
 */
export function spriteAttrs(mem, n) {
  const offs = 2 * n;
  const r1 = SPRITE_RAM1 + offs;
  const r2 = SPRITE_RAM2 + offs;
  const r3 = SPRITE_RAM3 + offs;
  const sizey = (mem[r3] >> 5) & 1;
  let sy = 256 - mem[r2] - 8;
  // A double-height sprite grows upwards from its nominal line, and the
  // 8-bit line counter wraps: "sy = (sy & 0xff) - 32; // fix wraparound".
  // Lines 224-255 land at -32..-1, hidden above the raster.
  sy -= 16 * sizey;
  sy = (sy & 0xff) - 32;
  return {
    enabled: (mem[r3 + 1] & 2) === 0,
    code: mem[r1] | ((mem[r3] & 0x40) << 2),
    color: mem[r1 + 1] & 0x3f,
    sx: mem[r2 + 1] + 0x100 * (mem[r3 + 1] & 1) - 71,
    sy,
    flipx: mem[r3] & 1,
    flipy: (mem[r3] >> 1) & 1,
    sizex: (mem[r3] >> 3) & 1,
    sizey,
    duplicate: (mem[r3] & 0x80) !== 0,
  };
}

/**
 * draw_sprites(): all 64 sprites in register order, so a later sprite covers
 * an earlier one.
 * @param {Uint8Array} out raster, one indirect colour per pixel
 * @param {Uint8Array} mem main CPU address space
 * @param {number} flipScreen 0 or 1
 */
export function drawSprites(out, mem, flipScreen) {
  for (let n = 0; n < SPRITE_SLOTS; n += 1) {
    const s = spriteAttrs(mem, n);
    if (!s.enabled) continue;
    let { flipx, flipy } = s;
    if (flipScreen) {
      flipx ^= 1;
      flipy ^= 1;
    }
    const lut = s.color * 8;
    for (let y = 0; y <= s.sizey; y += 1) {
      for (let x = 0; x <= s.sizex; x += 1) {
        // When a double sprite is flipped its quarters trade places too:
        // gfx_offs[y ^ (sizey * flipy)][x ^ (sizex * flipx)]. MAME's
        // gfx_element draw wraps the code modulo the element count (384),
        // so codes 384-511 show sprites 0-127.
        const quarter = s.duplicate ? 0 : GFX_OFFS[y ^ (s.sizey * flipy)][x ^ (s.sizex * flipx)];
        const code = (s.code + quarter) % SPRITE_COUNT;
        drawSprite16(out, code * 256, lut, flipx, flipy, s.sx + 16 * x, s.sy + 16 * y);
      }
    }
  }
}

/**
 * One 16x16 transmask draw, clipped to the raster. A pixel is skipped when
 * its looked-up colour is 0xFF (transpen_mask(gfx(1), color, 0xff)).
 * @param {Uint8Array} out @param {number} base SPRITE_PIXELS index of the sprite
 * @param {number} lut SPRITE_LUT index of pen 0 @param {number} flipx
 * @param {number} flipy @param {number} dx left @param {number} dy top
 */
function drawSprite16(out, base, lut, flipx, flipy, dx, dy) {
  if (dx >= RASTER_WIDTH || dy >= RASTER_HEIGHT || dx <= -16 || dy <= -16) return;
  const x0 = dx < 0 ? -dx : 0;
  const x1 = dx + 16 > RASTER_WIDTH ? RASTER_WIDTH - dx : 16;
  const y0 = dy < 0 ? -dy : 0;
  const y1 = dy + 16 > RASTER_HEIGHT ? RASTER_HEIGHT - dy : 16;
  for (let py = y0; py < y1; py += 1) {
    const srcRow = base + (flipy ? 15 - py : py) * 16;
    const dstRow = (dy + py) * RASTER_WIDTH + dx;
    for (let px = x0; px < x1; px += 1) {
      const ind = SPRITE_LUT[lut + SPRITE_PIXELS[srcRow + (flipx ? 15 - px : px)]];
      if (ind !== SPRITE_TRANSPARENT) out[dstRow + px] = ind;
    }
  }
}

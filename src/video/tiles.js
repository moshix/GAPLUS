// Copyright 2026 by Moshix
/**
 * The 36 x 28 character layer: MAME's tilemap_scan, get_tile_info and the
 * two category passes of screen_update (reference/mame/namco/gaplus_v.cpp).
 *
 * Memory (main CPU addresses, shared with the sub CPU):
 *   $0000-$03FF  tile codes, bits 0-7 of the character number
 *   $0400-$07FF  attributes:  bit 7   character number bit 8
 *                             bit 6   category: 1 = drawn over sprites
 *                             bits 0-5 colour code (0-63)
 *
 * Everything here is in RASTER space (the monitor's 288 x 224 landscape
 * scan); see renderer.js for the rotation into the player's view.
 */
import { TILE_PIXELS } from './gfxdata.js';
import { CHAR_LUT, CHAR_TRANSPARENT } from './palette.js';

/** Raster frame size (MAME set_size(36*8, 28*8)). */
export const RASTER_WIDTH = 288;
export const RASTER_HEIGHT = 224;

/** Tilemap geometry: 36 columns x 28 rows of 8x8 cells, in raster space. */
export const TILEMAP_COLS = 36;
export const TILEMAP_ROWS = 28;

/** Main-CPU address of tile RAM ("videoram" share, first half). */
export const VIDEO_RAM = 0x0000;
/** Main-CPU address of the attribute half of the same RAM. */
export const COLOR_RAM = 0x0400;

/**
 * tilemap_scan() (gaplus_v.cpp, identical to Galaga's): which video RAM
 * offset a raster tilemap cell reads. The RAM is a 32x32 map; the 36x28
 * screen is carved out of it. Columns 2-33 are the 32x28 playfield (offsets
 * $040-$3BF, 32 cells per raster row). Columns 0-1 and 34-35 are the strips
 * at the player's top and bottom: their col-2 goes negative or past 31, sets
 * bit 5, and they borrow the unused ends of the map, $3C0-$3FF (player's
 * top two rows) and $000-$03F (bottom two rows), each 32 bytes of which only
 * offsets 2-29 are on screen.
 *
 * @param {number} col raster column 0-35 (the player's row, top to bottom)
 * @param {number} row raster row 0-27 (the player's column, right to left)
 * @returns {number} offset 0-0x3FF into tile RAM / attribute RAM
 */
export function tilemapScan(col, row) {
  const r = row + 2;
  const c = col - 2;
  // (c & 0x1f) in JS matches C for c = -2 / -1 (two's complement), giving
  // 30 / 31, i.e. the strips at $3C0 and $3E0.
  if (c & 0x20) return r + ((c & 0x1f) << 5);
  return c + (r << 5);
}

/**
 * The same mapping in the player's (portrait) coordinates.
 * @param {number} x player's column, 0 (left) - 27 (right)
 * @param {number} y player's row, 0 (top) - 35 (bottom)
 * @returns {number} offset 0-0x3FF
 */
export function playerCellOffset(x, y) {
  return tilemapScan(y, TILEMAP_ROWS - 1 - x);
}

/** tilemapScan() for every raster cell, index row * 36 + col. */
export const TILEMAP_OFFSET = (() => {
  const t = new Uint16Array(TILEMAP_COLS * TILEMAP_ROWS);
  for (let row = 0; row < TILEMAP_ROWS; row += 1) {
    for (let col = 0; col < TILEMAP_COLS; col += 1) t[row * TILEMAP_COLS + col] = tilemapScan(col, row);
  }
  return t;
})();

/**
 * get_tile_info(): the tile at a RAM offset.
 * @param {Uint8Array} mem main CPU address space
 * @param {number} offs 0-0x3FF
 * @returns {{code: number, color: number, category: number}}
 */
export function tileInfo(mem, offs) {
  const attr = mem[COLOR_RAM + offs];
  return {
    code: mem[VIDEO_RAM + offs] + ((attr & 0x80) << 1),
    color: attr & 0x3f,
    category: (attr & 0x40) >> 6,
  };
}

/**
 * One pass of m_bg_tilemap->draw(screen, bitmap, cliprect, category, 0):
 * only tiles of that category, and only their non-transparent pixels.
 *
 * Transparency is per looked-up colour: video_start() calls
 * configure_groups(gfx(0), 0xff) with the tile's colour as its group, so a
 * pixel whose CHAR_LUT entry is 0xFF is see-through (pixel value alone
 * decides nothing).
 *
 * Flip screen: flip_screen_set() flips every tilemap in X and Y. The layer
 * is exactly screen-sized, so cell (c, r) is shown at (35-c, 27-r) with its
 * pixels mirrored on both axes. (Unlike Galaga there is no mirrored
 * character bank; get_tile_info passes no flip flags.)
 *
 * @param {Uint8Array} out raster, one indirect colour per pixel
 * @param {Uint8Array} mem main CPU address space
 * @param {number} category 0 = below sprites, 1 = above
 * @param {number} flip 0 or 1
 */
export function drawTilemap(out, mem, category, flip) {
  for (let row = 0; row < TILEMAP_ROWS; row += 1) {
    for (let col = 0; col < TILEMAP_COLS; col += 1) {
      const offs = TILEMAP_OFFSET[row * TILEMAP_COLS + col];
      const attr = mem[COLOR_RAM + offs];
      if (((attr >> 6) & 1) !== category) continue;
      // Code bit 8 = attr bit 7: the high-nibble half of the character ROM.
      const base = (mem[VIDEO_RAM + offs] + ((attr & 0x80) << 1)) * 64;
      const lut = (attr & 0x3f) * 4;
      const cellX = (flip ? TILEMAP_COLS - 1 - col : col) * 8;
      const cellY = (flip ? TILEMAP_ROWS - 1 - row : row) * 8;
      for (let py = 0; py < 8; py += 1) {
        const srcRow = base + (flip ? 7 - py : py) * 8;
        const dstRow = (cellY + py) * RASTER_WIDTH + cellX;
        for (let px = 0; px < 8; px += 1) {
          const ind = CHAR_LUT[lut + TILE_PIXELS[srcRow + (flip ? 7 - px : px)]];
          if (ind !== CHAR_TRANSPARENT) out[dstRow + px] = ind;
        }
      }
    }
  }
}

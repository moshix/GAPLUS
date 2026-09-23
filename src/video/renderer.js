// Copyright 2026 by Moshix
/**
 * Turns the Gaplus board's video memory into pixels, the way MAME's
 * gaplus_base_state::screen_update() does (reference/mame/namco/gaplus_v.cpp).
 *
 * INPUT. A 64 KB Uint8Array at the MAIN CPU's addresses (Machine.mem style)
 * plus a small state object -- nothing else, so the port's RAM and the
 * oracle's RAM render through the same code:
 *
 *   $0000-$03FF  tile codes          $0400-$07FF  tile attributes
 *   $0F80-$0FFF  sprite code/colour  $1780-$17FF  sprite Y / X
 *   $1F80-$1FFF  sprite flip/size/X8/enable
 *   $1F7F bit 0  flip screen ("flip screen control is embedded in RAM")
 *   state.starControl  the last values written to $A000-$A003 (write-only
 *                      registers, not readable from memory)
 *
 * COORDINATES. The monitor is mounted on its side (ROT90). The frame is
 * composed in RASTER space -- the monitor's native 288 x 224 landscape
 * scan -- and only the finished frame is rotated into the player's
 * 224 x 288 portrait view:
 *
 *     playerX = 223 - rasterY        rasterY in [0, 223]
 *     playerY = rasterX              rasterX in [0, 287]
 *
 * Working in raster space keeps every constant, flip bit and wraparound
 * rule a literal copy of MAME's code.
 *
 * LAYERS, back to front (screen_update):
 *   1. fill with pen 0 (char colour 0 pen 0 -> indirect 0xFF, black)
 *   2. the starfield (starfield.js)
 *   3. tiles of category 0 (attribute bit 6 clear)
 *   4. 64 sprites, in register order
 *   5. tiles of category 1 ("I don't know if this feature is used by
 *      Gaplus, but it's shown in the schematics" -- MAME)
 *
 * The composed frame holds MAME indirect colour indices (0-255); a table
 * turns them into RGBA during the rotation pass. MAME flags the driver
 * MACHINE_IMPERFECT_GRAPHICS; the known gap is the starfield (see
 * starfield.js).
 */
import { PALETTE } from './palette.js';
import { penIndirect } from './pens.js';
import { RASTER_WIDTH, RASTER_HEIGHT, drawTilemap } from './tiles.js';
import { drawSprites } from './sprites.js';
import { Starfield } from './starfield.js';

export { RASTER_WIDTH, RASTER_HEIGHT, TILEMAP_COLS, TILEMAP_ROWS, tilemapScan, playerCellOffset }
  from './tiles.js';

/** The player's view, after ROT90. */
export const SCREEN_WIDTH = 224;
export const SCREEN_HEIGHT = 288;

/** Main-CPU address of the flip-screen byte (bit 0). */
export const FLIP_SCREEN_ADDR = 0x1f7f;

/** Indirect colour of the background fill: bitmap.fill(0) is pen 0. */
export const BACKGROUND = penIndirect(0);

/** @param {readonly number[]} rgb @returns {number} little-endian RGBA as a Uint32 */
const rgba = (rgb) => ((255 << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]) >>> 0;

/** Indirect colour -> RGBA (for a little-endian Uint32 view of ImageData). */
export const COLOR_RGBA = Uint32Array.from(PALETTE, rgba);

/**
 * @typedef {object} VideoState
 * @property {ArrayLike<number>} [starControl] $A000-$A003 as last written
 * @property {number} [flip] override the flip bit (default: RAM $1F7F bit 0)
 */

export class Renderer {
  /** The player's 224 x 288 view as packed RGBA, ready for putImageData. */
  pixels = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);

  /**
   * The composed frame in raster space (288 x 224), one indirect colour
   * index per pixel. Exposed so tests and the oracle can compare frames
   * without going through RGB.
   */
  raster = new Uint8Array(RASTER_WIDTH * RASTER_HEIGHT);

  starfield = new Starfield(RASTER_WIDTH, RASTER_HEIGHT);

  /** Star control values used when render()/vblank() get none. */
  starControl = new Uint8Array(4);

  /** Flip bit as of the last render(). */
  flipScreen = 0;

  /**
   * Render one frame (screen_update).
   * @param {Uint8Array} mem main CPU address space, 64 KB
   * @param {VideoState} [state]
   */
  render(mem, state = {}) {
    if (state.starControl) this.starControl.set(Array.from(state.starControl).slice(0, 4));
    // flip_screen_set(m_spriteram[0x1f7f - 0x800] & 1)
    this.flipScreen = (state.flip ?? mem[FLIP_SCREEN_ADDR]) & 1;
    this.raster.fill(BACKGROUND);
    this.starfield.draw(this.raster, this.starControl);
    drawTilemap(this.raster, mem, 0, this.flipScreen);
    drawSprites(this.raster, mem, this.flipScreen);
    drawTilemap(this.raster, mem, 1, this.flipScreen);
    this.rotate();
  }

  /**
   * End of vertical blank (screen_vblank(0)): advance the starfield. Call
   * once per frame after render().
   * @param {ArrayLike<number>} [starControl] $A000-$A003 as last written
   */
  vblank(starControl) {
    if (starControl) this.starControl.set(Array.from(starControl).slice(0, 4));
    this.starfield.vblank(this.starControl);
  }

  /** ROT90: raster (x, y) -> player (223 - y, x), through the colour table. */
  rotate() {
    const src = this.raster;
    const dst = this.pixels;
    for (let ry = 0; ry < RASTER_HEIGHT; ry += 1) {
      const px = SCREEN_WIDTH - 1 - ry;
      let s = ry * RASTER_WIDTH;
      for (let rx = 0; rx < RASTER_WIDTH; rx += 1) {
        dst[rx * SCREEN_WIDTH + px] = COLOR_RGBA[src[s]];
        s += 1;
      }
    }
  }
}

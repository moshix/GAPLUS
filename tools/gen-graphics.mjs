// Copyright 2026 by Moshix
/**
 * Emit src/video/gfxdata.js and src/video/palette.js from the Gaplus ROM set,
 * and draw reference sheets into assets/ so a human can check them.
 *
 * Nothing here is transcribed: the graphics are decoded from gp2-5.8s (chars)
 * and gp2-11/10/12/9 (sprites) with MAME's own gfx_layout structs
 * (reference/mame/namco/gaplus.cpp, charlayout / spritelayout), after the same
 * nibble unpacking MAME's driver_init() does (tools/romset.mjs loadGaplus),
 * and the colours are computed from the PROMs by a transcription of
 * gaplus_base_state::gaplus_palette() (gaplus_v.cpp).
 *
 * ORIENTATION. Bitmaps are emitted in RASTER orientation -- the way MAME's
 * gfxdecode holds them and the way the video hardware scans them, i.e. the
 * monitor's native 288x224 landscape frame. The renderer composes the frame
 * in raster space exactly like MAME's screen_update() and rotates the
 * finished frame once (ROT90) into the player's 224x288 view. The PNG sheets
 * below, by contrast, are drawn rotated so they look like what the player
 * sees.
 *
 * Usage: node tools/gen-graphics.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadGaplus, ROOT } from './romset.mjs';
import { encodePng } from './png.mjs';

/**
 * MAME's RGN_FRAC(num, den): a fraction of the region, in bits.
 * @typedef {{frac: [number, number]}} RgnFrac
 */

/**
 * A MAME gfx_layout. All offsets are in BITS, as in MAME. `total` and any
 * plane offset may be an RgnFrac, resolved against the region size.
 * @typedef {{width: number, height: number, total: RgnFrac | number,
 *   planes: Array<RgnFrac | number>, xoffset: number[], yoffset: number[],
 *   increment: number}} GfxLayout
 */

/** @param {number} num @param {number} den @returns {RgnFrac} */
const RGN_FRAC = (num, den) => ({ frac: [num, den] });

/**
 * MAME's STEPn(start, step) macros.
 * @param {number} n @param {number} start @param {number} step_ @returns {number[]}
 */
export const step = (n, start, step_) => Array.from({ length: n }, (_, i) => start + i * step_);

/**
 * charlayout (gaplus.cpp): 8x8, RGN_FRAC(1,1), 2 planes at bit offsets 4
 * and 6. Each byte carries TWO horizontally adjacent pixels in its low
 * nibble (plane 0 in bits 3/2, plane 1 in bits 1/0 -- MAME numbers bits
 * MSB first). A character is 32 bytes: x pairs 0-1, 2-3, 4-5, 6-7 come from
 * byte groups 16, 24, 0 and 8, one byte per row. The high nibbles are
 * reached through the second half of the region that driver_init() fills
 * with rom >> 4, so codes 256-511 are the high-nibble character set.
 * @type {GfxLayout}
 */
export const CHAR_LAYOUT = {
  width: 8,
  height: 8,
  total: RGN_FRAC(1, 1),
  planes: [4, 6],
  xoffset: [16 * 8, 16 * 8 + 1, 24 * 8, 24 * 8 + 1, 0, 1, 8 * 8, 8 * 8 + 1],
  yoffset: step(8, 0, 8),
  increment: 32 * 8,
};

/**
 * spritelayout (gaplus.cpp): 16x16, RGN_FRAC(1,2), 3 planes. Plane 0 (the
 * MSB) comes from the second half of the region (11M, unpacked by
 * driver_init), planes 1 and 2 from the high and low nibble of each byte of
 * the first half (11P, 11N, 11R). Four 4-pixel column strips at bytes 0, 8,
 * 16, 24; rows 8-15 are 32 bytes further on.
 * @type {GfxLayout}
 */
export const SPRITE_LAYOUT = {
  width: 16,
  height: 16,
  total: RGN_FRAC(1, 2),
  planes: [RGN_FRAC(1, 2), 0, 4],
  xoffset: [...step(4, 0, 1), ...step(4, 8 * 8, 1), ...step(4, 16 * 8, 1), ...step(4, 24 * 8, 1)],
  yoffset: [...step(8, 0, 8), ...step(8, 32 * 8, 8)],
  increment: 64 * 8,
};

/**
 * Decode a ROM region with a gfx_layout, the way MAME's gfx_element does:
 * bits are numbered MSB first within each byte, and plane 0 (the first entry
 * of `planes`) supplies the MOST significant bit of the pixel value.
 * RGN_FRAC values resolve as in MAME: total = regionBits / increment *
 * num / den, and a fractional plane offset = regionBits * num / den.
 * @param {Uint8Array} rom
 * @param {GfxLayout} layout
 * @returns {{count: number, pixels: Uint8Array}} pixel (x, y) of element n
 *   at n*w*h + y*w + x
 */
export function decodeGfx(rom, layout) {
  const { width, height, planes, xoffset, yoffset, increment } = layout;
  const bits = rom.length * 8;
  const resolve = (/** @type {RgnFrac | number} */ v) => (typeof v === 'number'
    ? v : (bits * v.frac[0]) / v.frac[1]);
  const count = typeof layout.total === 'number'
    ? layout.total
    : ((bits / increment) * layout.total.frac[0]) / layout.total.frac[1];
  const planeOffs = planes.map(resolve);
  const out = new Uint8Array(count * width * height);
  const bit = (/** @type {number} */ b) => (rom[b >> 3] >> (7 - (b & 7))) & 1;
  for (let n = 0; n < count; n += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let v = 0;
        for (let p = 0; p < planeOffs.length; p += 1) {
          const b = n * increment + planeOffs[p] + yoffset[y] + xoffset[x];
          v |= bit(b) << (planeOffs.length - 1 - p);
        }
        out[(n * height + y) * width + x] = v;
      }
    }
  }
  return { count, pixels: out };
}

/**
 * gaplus_base_state::gaplus_palette() (gaplus_v.cpp), step for step.
 *
 * Indirect colours 0-255: each of the three 256 x 4-bit PROMs drives one
 * gun through a 2.2k/1k/470/220 ohm ladder, which MAME models with fixed
 * weights 0x0e/0x1f/0x43/0x8f (bit 0 .. bit 3).
 *
 * Pens (what gfx elements draw): chars are gfx(0), colorbase 0, 64 colours x
 * 4 pens; the char lookup PROM (7-6S) selects indirect 0xF0 + low nibble.
 * Sprites are gfx(1), colorbase 64*4 = 0x100, 64 colours x 8 pens; the two
 * 512 x 4-bit sprite lookup PROMs give the low (6-6P) and high (5-6N) nibble
 * of the indirect colour.
 *
 * @param {Uint8Array} proms the 2 KB "proms" region
 * @returns {{rgb: number[][], charLut: number[], spriteLut: number[]}}
 */
export function gaplusPalette(proms) {
  const weight = (/** @type {number} */ v) => 0x0e * (v & 1) + 0x1f * ((v >> 1) & 1)
    + 0x43 * ((v >> 2) & 1) + 0x8f * ((v >> 3) & 1);
  const rgb = [];
  for (let i = 0; i < 256; i += 1) {
    rgb.push([weight(proms[i]), weight(proms[i + 0x100]), weight(proms[i + 0x200])]);
  }
  // color_prom += 0x300: characters use colours 0xf0-0xff.
  const charLut = [];
  for (let i = 0; i < 64 * 4; i += 1) charLut.push(0xf0 + (proms[0x300 + i] & 0x0f));
  // sprites: (color_prom[0] & 0x0f) + ((color_prom[0x200] & 0x0f) << 4),
  // with color_prom continuing from 0x400 after the 256 char entries.
  const spriteLut = [];
  for (let i = 0; i < 64 * 8; i += 1) {
    spriteLut.push((proms[0x400 + i] & 0x0f) + ((proms[0x600 + i] & 0x0f) << 4));
  }
  return { rgb, charLut, spriteLut };
}

/**
 * Pack pixels of `bpp` bits (2 or 4), low pixel in the low bits, and base64.
 * @param {Uint8Array} pixels @param {number} bpp
 * @returns {string}
 */
export function packBase64(pixels, bpp) {
  const per = 8 / bpp;
  const packed = new Uint8Array(Math.ceil(pixels.length / per));
  const mask = (1 << bpp) - 1;
  for (let i = 0; i < pixels.length; i += 1) {
    packed[(i / per) | 0] |= (pixels[i] & mask) << ((i % per) * bpp);
  }
  return Buffer.from(packed).toString('base64');
}

/** @param {string} b64 @param {number} [width] @returns {string} */
function wrapBase64(b64, width = 96) {
  /** @type {string[]} */
  const lines = [];
  for (let i = 0; i < b64.length; i += width) lines.push(`  '${b64.slice(i, i + width)}'`);
  return lines.join('\n  + ');
}

/** @param {ArrayLike<number>} values @param {number} perLine @returns {string} */
function numberRows(values, perLine) {
  /** @type {string[]} */
  const rows = [];
  for (let i = 0; i < values.length; i += perLine) {
    rows.push(`  ${Array.from(values).slice(i, i + perLine)
      .map((v) => `0x${v.toString(16).padStart(2, '0')}`).join(', ')},`);
  }
  return rows.join('\n');
}

// The unpacker emitted into gfxdata.js. It works in both the browser (atob)
// and Node (Buffer) so the tests can import the same module.
const UNPACK = `/**
 * Undo the packing: \`bpp\`-bit pixels, low pixel in the low bits.
 * @param {string} b64 @param {number} length pixels @param {number} bpp
 * @returns {Uint8Array}
 */
function unpack(b64, length, bpp) {
  const binary = typeof atob === 'function'
    ? atob(b64)
    : Buffer.from(b64, 'base64').toString('binary');
  const per = 8 / bpp;
  const mask = (1 << bpp) - 1;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (binary.charCodeAt((i / per) | 0) >> ((i % per) * bpp)) & mask;
  }
  return out;
}`;

// Emitted into every generated file: they are overwritten wholesale, so a
// notice added to them by hand would not survive the next regeneration.
const PROVENANCE = `// Copyright 2026 by Moshix
/**
 * GENERATED FILE -- do not edit by hand.
 * Run \`node tools/gen-graphics.mjs\` to regenerate.
 *`;

/**
 * Draw a grid of decoded elements, rotated into the player's view (ROT90:
 * raster (x, y) of a WxH element lands at player (H-1-y, x)).
 * @param {Uint8Array} pixels
 * @param {number} size element edge (square elements)
 * @param {number[]} codes elements to draw, row by row
 * @param {number} perRow
 * @param {(pen: number) => number} colour packed RGBA, or 0 for transparent
 * @returns {{rgba: Uint32Array, width: number, height: number}}
 */
function sheet(pixels, size, codes, perRow, colour) {
  const cell = size + 1;
  const width = perRow * cell + 1;
  const height = Math.ceil(codes.length / perRow) * cell + 1;
  const rgba = new Uint32Array(width * height).fill(0xff402020); // grid lines
  codes.forEach((code, i) => {
    const ox = (i % perRow) * cell + 1;
    const oy = Math.floor(i / perRow) * cell + 1;
    for (let py = 0; py < size; py += 1) {
      for (let px = 0; px < size; px += 1) {
        // Player pixel (px, py) comes from raster pixel (py, size-1-px).
        const pen = pixels[(code * size + (size - 1 - px)) * size + py];
        const c = colour(pen);
        rgba[(oy + py) * width + ox + px] = c === 0 ? 0xff000000 : c;
      }
    }
  });
  return { rgba, width, height };
}

/**
 * Stack sheets in a grid with a gap.
 * @param {Array<{rgba: Uint32Array, width: number, height: number}>} blocks
 * @param {number} across
 * @returns {{rgba: Uint32Array, width: number, height: number}}
 */
function tileBlocks(blocks, across) {
  const bw = blocks[0].width + 4;
  const bh = blocks[0].height + 4;
  const width = across * bw;
  const height = Math.ceil(blocks.length / across) * bh;
  const rgba = new Uint32Array(width * height).fill(0xff808080);
  blocks.forEach((b, i) => {
    const ox = (i % across) * bw + 2;
    const oy = Math.floor(i / across) * bh + 2;
    for (let y = 0; y < b.height; y += 1) {
      rgba.set(b.rgba.subarray(y * b.width, (y + 1) * b.width), (oy + y) * width + ox);
    }
  });
  return { rgba, width, height };
}

/** @param {readonly number[]} rgb @returns {number} little-endian RGBA */
const pack = (rgb) => ((255 << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0]) >>> 0;

/** Sprite colour codes drawn on assets/sprites.png (all 7 pens in use). */
const SHEET_SPRITE_COLOURS = [0, 1, 2, 5, 8, 11, 14, 15];

function main() {
  const rom = loadGaplus();

  // ---- graphics --------------------------------------------------------
  const tiles = decodeGfx(rom.gfx1, CHAR_LAYOUT);
  const sprites = decodeGfx(rom.gfx2, SPRITE_LAYOUT);

  writeFileSync(join(ROOT, 'src/video/gfxdata.js'), `${PROVENANCE}
 * Decoded from the MAME \`gaplus\` ROM set with MAME's charlayout and
 * spritelayout (gaplus.cpp) after driver_init()'s nibble unpacking. The
 * artwork is Namco's, from the 1984 board.
 *
 * Bitmaps are in RASTER orientation (the monitor's native landscape scan, as
 * MAME holds them), NOT rotated for the player: the renderer rotates the
 * whole finished frame once. See tools/gen-graphics.mjs.
 */

/**
 * Number of 8x8 characters: RGN_FRAC(1,1) of the 16 KB gfx1 region at 32
 * bytes each. 0-255 are the low nibbles of gp2-5.8s, 256-511 the high
 * nibbles; bit 8 of the code is bit 7 of the tile's attribute byte.
 */
export const TILE_COUNT = ${tiles.count};
export const TILE_SIZE = 8;

/**
 * Number of 16x16 sprites: RGN_FRAC(1,2) of the 48 KB gfx2 region at 64
 * bytes each. 0-127 gp2-11.11p, 128-255 gp2-10.11n, 256-383 gp2-12.11r
 * (planes 1-2); plane 0 from gp2-9.11m high nibbles (0-127), low nibbles
 * (128-255), and zero (256-383).
 */
export const SPRITE_COUNT = ${sprites.count};
export const SPRITE_SIZE = 16;

/** 2-bit pens, 4 per byte. */
const TILES_PACKED =
${wrapBase64(packBase64(tiles.pixels, 2))};

/** 3-bit pens stored in 4-bit nibbles, 2 per byte. */
const SPRITES_PACKED =
${wrapBase64(packBase64(sprites.pixels, 4))};

/**
 * All characters as one flat array of 2-bit pens (0-3) in raster
 * orientation: pixel (x, y) of character n is at \`n * 64 + y * 8 + x\`, where
 * x runs along the monitor's scan line (the player's screen Y, downwards)
 * and y across scan lines (the player's screen X, right to left).
 * @type {Uint8Array}
 */
export const TILE_PIXELS = unpack(TILES_PACKED, TILE_COUNT * 64, 2);

/**
 * All sprites as one flat array of 3-bit pens (0-7) in raster orientation:
 * pixel (x, y) of sprite n is at \`n * 256 + y * 16 + x\`.
 * @type {Uint8Array}
 */
export const SPRITE_PIXELS = unpack(SPRITES_PACKED, SPRITE_COUNT * 256, 4);

${UNPACK}
`);

  // ---- colours ---------------------------------------------------------
  const pal = gaplusPalette(rom.proms);
  const h2 = (/** @type {number} */ v) => v.toString(16).padStart(2, '0');
  const rgbRows = pal.rgb.map((c, i) => `  [${c.map((v) => String(v).padStart(3, ' ')).join(', ')}], `
    + `// 0x${h2(i)} R ${rom.proms[i] & 15} G ${rom.proms[0x100 + i] & 15} B ${rom.proms[0x200 + i] & 15}`)
    .join('\n');

  writeFileSync(join(ROOT, 'src/video/palette.js'), `${PROVENANCE}
 * Colours computed from the Gaplus colour PROMs (gp2-3.1p red, gp2-1.1n
 * green, gp2-2.2n blue, gp2-7.6s char lookup, gp2-6.6p + gp2-5.6n sprite
 * lookup) by gaplus_base_state::gaplus_palette() in MAME's gaplus_v.cpp.
 *
 * MAME's colour model is two-level ("indirect"). A PEN is what a gfx
 * element draws: 0x000-0x0FF are the 64 char colours x 4 pens, 0x100-0x2FF
 * the 64 sprite colours x 8 pens (the starfield also writes pens in this
 * range). Each pen looks up an INDIRECT COLOUR 0-255, which is an RGB value.
 */

/**
 * Indirect colours 0-255: each 4-bit PROM value through the
 * 2.2k/1k/470/220 ohm ladder, weights 0x0e/0x1f/0x43/0x8f. Comments give
 * the three PROM nibbles.
 * @type {ReadonlyArray<readonly [number, number, number]>}
 */
export const PALETTE = Object.freeze(/** @type {Array<[number, number, number]>} */ ([
${rgbRows}
]).map((c) => Object.freeze(c)));

/** Pen number of sprite colour 0, pen 0 (gfx(1) colorbase = 64 * 4). */
export const SPRITE_PEN_BASE = 0x100;
/** Total pens: 64 * 4 + 64 * 8. */
export const PEN_COUNT = 0x300;

/**
 * Character colour lookup: CHAR_LUT[colour * 4 + pen] is the indirect
 * colour (0xF0-0xFF) of pen \`pen\` of a character in colour code \`colour\`
 * (0-63). Also the indirect colour of pens 0x000-0x0FF.
 * @type {Uint8Array}
 */
export const CHAR_LUT = Uint8Array.from([
${numberRows(pal.charLut, 16)}
]);

/**
 * Sprite colour lookup: SPRITE_LUT[colour * 8 + pen] is the indirect colour
 * (low nibble from 6P, high nibble from 6N) of pen \`pen\` of a sprite in
 * colour code \`colour\` (0-63). Also the indirect colour of pens
 * 0x100-0x2FF (index pen - SPRITE_PEN_BASE).
 * @type {Uint8Array}
 */
export const SPRITE_LUT = Uint8Array.from([
${numberRows(pal.spriteLut, 16)}
]);

/**
 * Transparency is decided by the LOOKED-UP colour, not the pen number: a
 * character pixel is see-through where CHAR_LUT gives 0xFF
 * (configure_groups(gfx(0), 0xff) in video_start), a sprite pixel where
 * SPRITE_LUT gives 0xFF (transpen_mask(gfx(1), color, 0xff) in
 * draw_sprites).
 */
export const CHAR_TRANSPARENT = 0xff;
export const SPRITE_TRANSPARENT = 0xff;
`);

  // ---- reference sheets ------------------------------------------------
  mkdirSync(join(ROOT, 'assets'), { recursive: true });
  const rgbaOf = pal.rgb.map(pack);

  // Characters: all 512 with a debug ramp so every pen is visible (the real
  // char colours mostly show pens 1 and 3 or 2 and 3 only): pen 0 black,
  // 1 cyan, 2 orange, 3 white. 32 per row: row pairs 0-7 low nibble set,
  // 8-15 high nibble set.
  const ramp = [0, pack([0, 200, 255]), pack([255, 150, 0]), pack([255, 255, 255])];
  const tileSheet = sheet(tiles.pixels, 8, step(tiles.count, 0, 1), 32, (pen) => ramp[pen]);
  writeFileSync(join(ROOT, 'assets/tiles.png'), encodePng(tileSheet.rgba, tileSheet.width, tileSheet.height, 3));

  // Sprites: all 384 in each of a few colour codes, 16 per row per block.
  const blocks = SHEET_SPRITE_COLOURS.map((c) => sheet(sprites.pixels, 16, step(sprites.count, 0, 1), 16, (pen) => {
    const ind = pal.spriteLut[c * 8 + pen];
    return ind === 0xff ? 0 : rgbaOf[ind];
  }));
  const all = tileBlocks(blocks, 4);
  writeFileSync(join(ROOT, 'assets/sprites.png'), encodePng(all.rgba, all.width, all.height, 1));
  // A single large block in colour 0 for close inspection.
  writeFileSync(join(ROOT, 'assets/sprites-c0.png'), encodePng(blocks[0].rgba, blocks[0].width, blocks[0].height, 2));

  // Palette sheet.
  // Rows: 16 of indirect colours (each 4 cells wide), a gap, 4 of char pens
  // (64 per row), a gap, 8 of sprite pens. Transparent lookups are grey.
  const pw = 64;
  const rowsOfIndirect = 16;
  const png = new Uint32Array(pw * (rowsOfIndirect + 1 + 4 + 1 + 8)).fill(0xff808080);
  for (let i = 0; i < 256; i += 1) {
    for (let k = 0; k < 4; k += 1) png[(i >> 4) * pw + (i & 15) * 4 + k] = rgbaOf[i];
  }
  const lutColour = (/** @type {number} */ ind) => (ind === 0xff ? 0xff404040 : rgbaOf[ind]);
  pal.charLut.forEach((ind, i) => { png[(rowsOfIndirect + 1 + (i >> 6)) * pw + (i & 63)] = lutColour(ind); });
  pal.spriteLut.forEach((ind, i) => {
    png[(rowsOfIndirect + 1 + 4 + 1 + (i >> 6)) * pw + (i & 63)] = lutColour(ind);
  });
  const ph = png.length / pw;
  writeFileSync(join(ROOT, 'assets/palette.png'), encodePng(png, pw, ph, 8));

  console.log('wrote src/video/gfxdata.js ', tiles.count, 'chars,', sprites.count, 'sprites');
  console.log('wrote src/video/palette.js ', pal.rgb.length, 'colours');
  console.log('wrote assets/tiles.png, sprites.png, sprites-c0.png, palette.png');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

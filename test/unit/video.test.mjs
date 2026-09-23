// Copyright 2026 by Moshix
/**
 * Tests for the video layer: the ROM loader, the graphics decode, the
 * palette, the tilemap address mapping, the sprite rules, the starfield and
 * the renderer as a whole.
 *
 * Where a test pins a number it comes from MAME's source
 * (reference/mame/namco/gaplus*.cpp) or from an independent re-derivation
 * from the raw chips, not from running the code under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadGaplus, readChips, readZip, crc32, CHIPS, ARCHIVE } from '../../tools/romset.mjs';
import { decodeGfx, gaplusPalette, CHAR_LAYOUT, SPRITE_LAYOUT } from '../../tools/gen-graphics.mjs';
import { blankMemory, putText, putSprite, charCode } from '../../tools/render-sheet.mjs';
import { TILE_PIXELS, TILE_COUNT, SPRITE_PIXELS, SPRITE_COUNT } from '../../src/video/gfxdata.js';
import { PALETTE, CHAR_LUT, SPRITE_LUT } from '../../src/video/palette.js';
import { penIndirect } from '../../src/video/pens.js';
import { tileInfo } from '../../src/video/tiles.js';
import { spriteAttrs, SPRITE_RAM3 } from '../../src/video/sprites.js';
import { Starfield, starMotion, MAX_STARS, STAR_PEN_BASE } from '../../src/video/starfield.js';
import {
  Renderer, SCREEN_WIDTH, SCREEN_HEIGHT, RASTER_WIDTH, RASTER_HEIGHT, BACKGROUND,
  COLOR_RGBA, tilemapScan, playerCellOffset,
} from '../../src/video/renderer.js';

const rom = loadGaplus();

// ---------------------------------------------------------------- romset

test('romset: crc32 is the standard CRC-32', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

// The zip is optional (the loose files in roms/ are enough), so the
// zip-path check only runs when the archive is present.
test('romset: every chip verifies, loose files equal the zip', {
  skip: existsSync(ARCHIVE) ? false : 'gaplus.zip not present',
}, () => {
  assert.equal(rom.chips.size, CHIPS.length);
  const zip = readZip(ARCHIVE);
  for (const chip of CHIPS) {
    assert.deepEqual(rom.chips.get(chip.name), zip.get(chip.name), chip.name);
  }
  // Zip-only path (no loose directory) gives the same chips.
  const fromZip = readChips({ romDir: join(tmpdir(), 'gaplus-no-such-dir') });
  assert.equal(fromZip.size, CHIPS.length);
});

test('romset: a corrupted chip throws naming the file and both CRCs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gaplus-roms-'));
  try {
    // Copy every good chip so the loader never needs the zip fallback,
    // then corrupt one of them.
    for (const chip of CHIPS) {
      writeFileSync(join(dir, chip.name), rom.chips.get(chip.name));
    }
    const bad = Uint8Array.from(rom.chips.get('gp2-5.8s'));
    bad[0] ^= 1;
    writeFileSync(join(dir, 'gp2-5.8s'), bad);
    assert.throws(() => readChips({ romDir: dir }), /gp2-5\.8s.*CRC32 [0-9a-f]{8}, expected f3d19987/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('romset: 64 KB CPU views put ROM where MAME maps it', () => {
  for (const cpu of ['main', 'sub', 'sound']) assert.equal(rom[cpu].length, 0x10000);
  assert.deepEqual(rom.main.subarray(0xa000, 0xc000), rom.chips.get('gp2-4.8d'));
  assert.deepEqual(rom.main.subarray(0xe000), rom.chips.get('gp2-2b.8b'));
  assert.deepEqual(rom.sub.subarray(0xc000, 0xe000), rom.chips.get('gp2-7.11c'));
  assert.deepEqual(rom.sound.subarray(0xe000), rom.chips.get('gp2-1.4b'));
  assert.ok(rom.main.subarray(0, 0xa000).every((b) => b === 0));
  assert.ok(rom.sound.subarray(0, 0xe000).every((b) => b === 0));
  // 6809 reset vectors point into each CPU's ROM.
  const vec = (/** @type {Uint8Array} */ m) => (m[0xfffe] << 8) | m[0xffff];
  assert.ok(vec(rom.main) >= 0xa000);
  assert.ok(vec(rom.sub) >= 0xa000);
  assert.ok(vec(rom.sound) >= 0xe000);
});

test('romset: driver_init nibble unpacking of gfx1 and gfx2', () => {
  const chars = rom.chips.get('gp2-5.8s');
  const m11 = rom.chips.get('gp2-9.11m');
  for (let i = 0; i < 0x2000; i += 97) {
    assert.equal(rom.gfx1[i + 0x2000], chars[i] >> 4);
    assert.equal(rom.gfx2[0x8000 + i], (m11[i] << 4) & 0xff);
  }
  assert.ok(rom.gfx2.subarray(0xa000).every((b) => b === 0));
});

// ---------------------------------------------------------------- graphics

test('gfx: generated gfxdata.js equals a fresh decode of the ROM', () => {
  const tiles = decodeGfx(rom.gfx1, CHAR_LAYOUT);
  const sprites = decodeGfx(rom.gfx2, SPRITE_LAYOUT);
  assert.equal(tiles.count, 512);
  assert.equal(sprites.count, 384);
  assert.equal(TILE_COUNT, 512);
  assert.equal(SPRITE_COUNT, 384);
  assert.deepEqual(TILE_PIXELS, tiles.pixels);
  assert.deepEqual(SPRITE_PIXELS, sprites.pixels);
});

test('gfx: chars match an independent reading of gp2-5.8s', () => {
  // Byte group per x pair: x 0-1 from +16, 2-3 from +24, 4-5 from +0,
  // 6-7 from +8. In the low nibble, the left pixel is bits 3 (plane 0)
  // and 1 (plane 1), the right pixel bits 2 and 0. Chars 256+ use the
  // high nibble.
  const raw = rom.chips.get('gp2-5.8s');
  const group = [16, 24, 0, 8];
  for (let n = 0; n < 512; n += 1) {
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        let b = raw[(n & 255) * 32 + group[x >> 1] + y];
        if (n >= 256) b >>= 4;
        const r = x & 1;
        const pen = (((b >> (3 - r)) & 1) << 1) | ((b >> (1 - r)) & 1);
        assert.equal(TILE_PIXELS[n * 64 + y * 8 + x], pen, `char ${n} (${x},${y})`);
      }
    }
  }
});

test('gfx: sprites match an independent reading of the four chips', () => {
  const lo = [rom.chips.get('gp2-11.11p'), rom.chips.get('gp2-10.11n'), rom.chips.get('gp2-12.11r')];
  const m11 = rom.chips.get('gp2-9.11m');
  for (let n = 0; n < 384; n += 7) {
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        const off = (x >> 2) * 8 + (y & 7) + (y >> 3) * 32;
        const k = x & 3;
        const b = lo[n >> 7][(n & 127) * 64 + off];
        // Plane 0 (MSB): 11M high nibble for 0-127, low nibble for 128-255,
        // nothing for 256-383.
        let p0 = 0;
        if (n < 128) p0 = (m11[n * 64 + off] >> (7 - k)) & 1;
        else if (n < 256) p0 = (m11[(n - 128) * 64 + off] >> (3 - k)) & 1;
        const pen = (p0 << 2) | (((b >> (7 - k)) & 1) << 1) | ((b >> (3 - k)) & 1);
        assert.equal(SPRITE_PIXELS[n * 256 + y * 16 + x], pen, `sprite ${n} (${x},${y})`);
      }
    }
  }
});

/**
 * A char in the player's orientation as text, '#' for any non-zero pen.
 * @param {number} code @returns {string[]}
 */
function glyph(code) {
  const rows = [];
  for (let py = 0; py < 8; py += 1) {
    let s = '';
    // Player (px, py) is raster (py, 7 - px): ROT90.
    for (let px = 0; px < 8; px += 1) s += TILE_PIXELS[code * 64 + (7 - px) * 8 + py] ? '#' : '.';
    rows.push(s);
  }
  return rows;
}

test('gfx: the font is ASCII-ordered and legible', () => {
  assert.deepEqual(glyph(charCode('0')), [
    '...###..',
    '..#..##.',
    '.##...##',
    '.##...##',
    '.##...##',
    '..##..#.',
    '...###..',
    '........',
  ]);
  assert.deepEqual(glyph(charCode('1')), [
    '....##..',
    '...###..',
    '....##..',
    '....##..',
    '....##..',
    '....##..',
    '..######',
    '........',
  ]);
  assert.deepEqual(glyph(charCode('L')), [
    '..###...',
    '..###...',
    '..###...',
    '..###...',
    '..###...',
    '..###...',
    '..######',
    '........',
  ]);
  assert.ok(glyph(0x20).every((r) => r === '........'), 'space is blank');
  // Digits and letters are all distinct and non-empty.
  const seen = new Set();
  for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const g = glyph(charCode(ch)).join('/');
    assert.ok(g.includes('#'), ch);
    assert.ok(!seen.has(g), `${ch} duplicates another glyph`);
    seen.add(g);
  }
});

// ---------------------------------------------------------------- palette

test('palette: generated palette.js equals gaplus_palette() of the PROMs', () => {
  const p = gaplusPalette(rom.proms);
  assert.deepEqual(PALETTE.map((c) => [...c]), p.rgb);
  assert.deepEqual([...CHAR_LUT], p.charLut);
  assert.deepEqual([...SPRITE_LUT], p.spriteLut);
});

test('palette: resistor weights and ranges', () => {
  // PROM nibble 0xF -> 0x0e + 0x1f + 0x43 + 0x8f = 255; nibble 0 -> 0.
  for (let i = 0; i < 256; i += 1) {
    const r = rom.proms[i] & 15;
    const expect = 0x0e * (r & 1) + 0x1f * ((r >> 1) & 1) + 0x43 * ((r >> 2) & 1) + 0x8f * (r >> 3);
    assert.equal(PALETTE[i][0], expect);
  }
  assert.equal(CHAR_LUT.length, 256);
  assert.equal(SPRITE_LUT.length, 512);
  assert.ok(CHAR_LUT.every((v) => v >= 0xf0), 'chars only reach 0xF0-0xFF');
  // Sprite pen 0 is transparent in every colour.
  for (let c = 0; c < 64; c += 1) assert.equal(SPRITE_LUT[c * 8], 0xff, `sprite colour ${c}`);
});

test('palette: the background (pen 0) is black, and the palette is varied', () => {
  assert.equal(BACKGROUND, 0xff);
  assert.deepEqual([...PALETTE[BACKGROUND]], [0, 0, 0]);
  assert.equal(COLOR_RGBA[BACKGROUND], 0xff000000);
  const distinct = new Set(PALETTE.map((c) => c.join(',')));
  assert.ok(distinct.size >= 64, `only ${distinct.size} distinct colours`);
  // Char colour 0 shows white text on pens 1 and 3 (the score colour).
  assert.deepEqual([...PALETTE[CHAR_LUT[1]]], [241, 241, 241]);
});

// ---------------------------------------------------------------- tilemap

test('tilemap: top two rows come from $03C0-$03FF, right to left', () => {
  assert.equal(playerCellOffset(0, 0), 0x3dd);
  assert.equal(playerCellOffset(27, 0), 0x3c2);
  assert.equal(playerCellOffset(0, 1), 0x3fd);
  assert.equal(playerCellOffset(27, 1), 0x3e2);
});

test('tilemap: playfield is $040-$3BF, columns 32 bytes apart', () => {
  assert.equal(playerCellOffset(0, 2), 0x3a0);
  assert.equal(playerCellOffset(27, 2), 0x040);
  assert.equal(playerCellOffset(0, 33), 0x3bf);
  assert.equal(playerCellOffset(27, 33), 0x05f);
  assert.equal(playerCellOffset(5, 10) - playerCellOffset(6, 10), 0x20);
  assert.equal(playerCellOffset(5, 11) - playerCellOffset(5, 10), 1);
});

test('tilemap: bottom two rows come from $0000-$003F', () => {
  assert.equal(playerCellOffset(0, 34), 0x01d);
  assert.equal(playerCellOffset(27, 34), 0x002);
  assert.equal(playerCellOffset(0, 35), 0x03d);
  assert.equal(playerCellOffset(27, 35), 0x022);
});

test('tilemap: raster tilemap_scan corners, 1008 distinct cells', () => {
  assert.equal(tilemapScan(0, 0), 0x3c2);
  assert.equal(tilemapScan(35, 27), 0x03d);
  assert.equal(tilemapScan(2, 0), 0x040);
  const seen = new Set();
  for (let y = 0; y < 36; y += 1) for (let x = 0; x < 28; x += 1) seen.add(playerCellOffset(x, y));
  assert.equal(seen.size, 36 * 28);
  for (const hidden of [0x000, 0x001, 0x01e, 0x01f, 0x3c0, 0x3c1, 0x3de, 0x3df, 0x3e0, 0x3ff]) {
    assert.ok(!seen.has(hidden), `offset ${hidden.toString(16)} should be off screen`);
  }
});

test('tilemap: attribute bit 7 is code bit 8, bit 6 the category', () => {
  const mem = new Uint8Array(0x10000);
  mem[0x123] = 0x41;
  mem[0x523] = 0xc5;
  assert.deepEqual(tileInfo(mem, 0x123), { code: 0x141, color: 5, category: 1 });
});

// ------------------------------------------------------------- rendering

/**
 * The player's-view pixel (x, y) of a rendered frame, as an indirect colour.
 * @param {Renderer} r @param {number} x @param {number} y @returns {number}
 */
function at(r, x, y) {
  // ROT90 inverse: player (x, y) is raster (y, 223 - x).
  return r.raster[(RASTER_HEIGHT - 1 - x) * RASTER_WIDTH + y];
}

test('render: text lands in the right player cell, black elsewhere', () => {
  const mem = blankMemory();
  putText(mem, 5, 10, '1', 0);
  const r = new Renderer();
  r.render(mem);
  // Glyph '1' in player cell (5, 10): bottom row "..######".
  for (let px = 0; px < 8; px += 1) {
    const ind = at(r, 5 * 8 + px, 10 * 8 + 6);
    assert.equal(ind, px < 2 ? BACKGROUND : CHAR_LUT[3], `px ${px}`);
  }
  // The RGBA view agrees with the raster through ROT90.
  assert.equal(r.pixels[(10 * 8 + 6) * SCREEN_WIDTH + 5 * 8 + 4], COLOR_RGBA[CHAR_LUT[3]]);
  let lit = 0;
  for (const v of r.raster) if (v !== BACKGROUND) lit += 1;
  assert.equal(lit, 19, 'only the 19 pixels of the glyph are lit');
});

test('render: flip screen mirrors the tilemap on both axes', () => {
  const mem = blankMemory();
  putText(mem, 0, 0, '1', 0);
  const a = new Renderer();
  a.render(mem);
  mem[0x1f7f] = 1;
  const b = new Renderer();
  b.render(mem);
  assert.equal(b.flipScreen, 1);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      assert.equal(at(b, 223 - x, 287 - y), at(a, x, y), `(${x},${y})`);
    }
  }
});

/**
 * Render one sprite and return the non-background raster pixels.
 * @param {Parameters<typeof putSprite>[2]} s @param {number} [flip]
 * @returns {Map<number, number>} raster index -> indirect colour
 */
function spritePixels(s, flip = 0) {
  const mem = blankMemory();
  putSprite(mem, 0, s);
  mem[0x1f7f] = flip;
  const r = new Renderer();
  r.render(mem);
  const out = new Map();
  r.raster.forEach((v, i) => { if (v !== BACKGROUND) out.set(i, v); });
  return out;
}

test('sprites: register decode matches draw_sprites()', () => {
  const mem = blankMemory();
  mem[0x0f80 + 6] = 0x12;
  mem[0x0f81 + 6] = 0xc7;       // colour keeps bits 0-5
  mem[0x1780 + 6] = 0x40;       // Y
  mem[0x1781 + 6] = 0x30;       // X low
  mem[0x1f80 + 6] = 0x6b;       // code b8, sizey, sizex, flipy, flipx
  mem[0x1f81 + 6] = 0x01;       // X bit 8, enabled
  const s = spriteAttrs(mem, 3);
  assert.equal(s.enabled, true);
  assert.equal(s.code, 0x112);
  assert.equal(s.color, 7);
  assert.equal(s.sx, 0x130 - 71);
  // sy = ((256 - 0x40 - 8 - 16) & 0xff) - 32
  assert.equal(s.sy, ((256 - 0x40 - 8 - 16) & 0xff) - 32);
  assert.deepEqual([s.flipx, s.flipy, s.sizex, s.sizey, s.duplicate], [1, 1, 1, 1, false]);
  mem[SPRITE_RAM3 + 7] = 0x02;
  assert.equal(spriteAttrs(mem, 3).enabled, false);
});

test('sprites: position round-trips and disabled sprites are not drawn', () => {
  const px = spritePixels({ code: 0x2e, color: 0, x: 100, y: 120 });
  assert.ok(px.size > 20);
  // Every lit pixel lies within the 16x16 box at player (100, 120).
  for (const i of px.keys()) {
    const rx = i % RASTER_WIDTH;
    const ry = (i / RASTER_WIDTH) | 0;
    const x = RASTER_HEIGHT - 1 - ry;
    assert.ok(x >= 100 && x < 116 && rx >= 120 && rx < 136, `pixel at (${x},${rx})`);
  }
  const mem = blankMemory();
  putSprite(mem, 0, { code: 0x2e, color: 0, x: 100, y: 120 });
  mem[SPRITE_RAM3 + 1] |= 2;
  const r = new Renderer();
  r.render(mem);
  assert.ok(r.raster.every((v) => v === BACKGROUND));
});

test('sprites: flip X mirrors along the raster line', () => {
  const plain = spritePixels({ code: 0x10, color: 0, x: 100, y: 120 });
  const flipped = spritePixels({ code: 0x10, color: 0, x: 100, y: 120, flipx: 1 });
  const rx0 = 120; // raster X of the left edge = player y
  assert.equal(flipped.size, plain.size);
  for (const [i, v] of plain) {
    const ry = (i / RASTER_WIDTH) | 0;
    const rx = i % RASTER_WIDTH;
    assert.equal(flipped.get(ry * RASTER_WIDTH + (2 * rx0 + 15 - rx)), v);
  }
});

test('sprites: flip screen only toggles the flip bits (no repositioning)', () => {
  const a = spritePixels({ code: 0x10, color: 0, x: 100, y: 120, flipx: 1, flipy: 1 });
  const b = spritePixels({ code: 0x10, color: 0, x: 100, y: 120 }, 1);
  assert.deepEqual([...b], [...a]);
});

test('sprites: double size uses code+0..3 and swaps quarters when flipped', () => {
  // Quarter layout gfx_offs[y][x] in raster space: [[0,1],[2,3]].
  const big = spritePixels({ code: 0x60, color: 0, x: 100, y: 120, sizex: 1, sizey: 1 });
  const q = (/** @type {number} */ code) => spritePixels({ code, color: 0, x: 100, y: 120 });
  // Raster origin of the big sprite: sx = 120, top = 223 - 100 - 31 = 92.
  const top = 92;
  const shift = (/** @type {Map<number, number>} */ m, /** @type {number} */ dx, /** @type {number} */ dy) => {
    const out = new Map();
    // q() draws at raster (120, 223 - 100 - 15 = 108); move to (120+dx, 92+dy).
    for (const [i, v] of m) out.set(i + (top + dy - 108) * RASTER_WIDTH + dx, v);
    return out;
  };
  const expect = new Map([
    ...shift(q(0x60), 0, 0), ...shift(q(0x61), 16, 0),
    ...shift(q(0x62), 0, 16), ...shift(q(0x63), 16, 16),
  ]);
  assert.deepEqual(new Map([...big].sort()), new Map([...expect].sort()));
  // flipx swaps the X quarters: code 0x61 is drawn (mirrored) at the left.
  const flipped = spritePixels({ code: 0x60, color: 0, x: 100, y: 120, sizex: 1, sizey: 1, flipx: 1 });
  const leftQuarter = spritePixels({ code: 0x61, color: 0, x: 100 + 16, y: 120, flipx: 1 });
  for (const [i, v] of leftQuarter) assert.equal(flipped.get(i), v);
  // Duplicate: all quarters are the base code.
  const dup = spritePixels({ code: 0x60, color: 0, x: 100, y: 120, sizex: 1, duplicate: 1 });
  const base = spritePixels({ code: 0x60, color: 0, x: 100, y: 120 });
  for (const [i, v] of base) {
    assert.equal(dup.get(i), v);
    assert.equal(dup.get(i + 16), v);
  }
});

test('sprites: codes past 383 wrap modulo the element count', () => {
  const a = spritePixels({ code: 0x10, color: 0, x: 100, y: 120 });
  const b = spritePixels({ code: 384 + 0x10, color: 0, x: 100, y: 120 });
  assert.deepEqual(b, a);
});

test('priority: category 0 tiles under sprites, category 1 over', () => {
  const run = (/** @type {number} */ attr) => {
    const mem = blankMemory();
    // A solid glyph cell under a sprite; the digit '0' has lit pixels.
    putText(mem, 12, 15, '0', attr);
    putSprite(mem, 0, { code: 0x2e, color: 0, x: 12 * 8 - 4, y: 15 * 8 - 4 });
    const r = new Renderer();
    r.render(mem);
    return r;
  };
  const under = run(0);
  const over = run(0x40);
  // Find a pixel lit by both the glyph and the sprite: its colour decides.
  let checked = 0;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const px = 12 * 8 + x;
      const py = 15 * 8 + y;
      const glyphOn = TILE_PIXELS[charCode('0') * 64 + (7 - x) * 8 + y] !== 0;
      if (!glyphOn) continue;
      const vOver = at(over, px, py);
      assert.equal(vOver, CHAR_LUT[3], 'category 1 text is always on top');
      const vUnder = at(under, px, py);
      if (vUnder !== CHAR_LUT[3]) checked += 1; // a sprite pixel covered it
    }
  }
  assert.ok(checked > 0, 'the sprite covers some category 0 text');
});

// ------------------------------------------------------------- starfield

test('starfield: generation is deterministic and within MAME limits', () => {
  const a = new Starfield();
  const b = new Starfield();
  assert.deepEqual([a.x, a.y, a.pen, a.set], [b.x, b.y, b.pen, b.set]);
  // MAME's generator (with its C int32 overflow) yields exactly 105 stars;
  // an independent re-implementation by the reviewer agrees on all 105.
  assert.equal(a.total, 105);
  assert.ok(a.total <= MAX_STARS);
  for (let i = 0; i < a.total; i += 1) {
    assert.equal(a.set[i], i % 3, 'sets are dealt 0, 1, 2 in turn');
    assert.ok(a.x[i] >= 16 && a.x[i] < 272);
    assert.ok(a.y[i] >= 0 && a.y[i] < 224);
    // Pen = set base + (-5..1 or 1..7), never the base itself.
    const d = a.pen[i] - STAR_PEN_BASE[a.set[i]];
    assert.ok(d >= -5 && d <= 7 && d !== 0, `star ${i} offset ${d}`);
    assert.equal(a.color[i], penIndirect(a.pen[i]));
  }
});

test('starfield: off draws nothing and does not move, but counts frames', () => {
  const s = new Starfield();
  const out = new Uint8Array(288 * 224).fill(7);
  s.draw(out, [0, 0x85, 0x85, 0x85]);
  assert.ok(out.every((v) => v === 7));
  const x0 = [...s.x];
  s.vblank([0, 0x85, 0x85, 0x85]);
  assert.deepEqual(s.x, x0);
  assert.equal(s.framecount, 1);
});

test('starfield: motion codes and wrap', () => {
  assert.deepEqual(starMotion(0x87), [0, 0]);
  assert.deepEqual(starMotion(0x06), [2, 0]);
  assert.deepEqual(starMotion(0x81), [-3, 0]);
  assert.deepEqual(starMotion(0x9f), [0, 3]);
  assert.deepEqual(starMotion(0x12), [0, 0]);
  const s = new Starfield();
  const x0 = [...s.x];
  const y0 = [...s.y];
  // Plane 0 moves +1 X, plane 1 -3 X, plane 2 +3 Y; 300 frames wrap all.
  const ctl = [1, 0x85, 0x81, 0x9f];
  for (let f = 0; f < 300; f += 1) s.vblank(ctl);
  for (let i = 0; i < s.total; i += 1) {
    const set = s.set[i];
    const wrapX = (/** @type {number} */ v) => ((((v - 16) % 256) + 256) % 256) + 16;
    const wrapY = (/** @type {number} */ v) => ((v % 224) + 224) % 224;
    if (set === 0) assert.equal(s.x[i], wrapX(x0[i] + 300));
    if (set === 1) assert.equal(s.x[i], wrapX(x0[i] - 900));
    if (set === 2) assert.equal(s.y[i], wrapY(y0[i] + 900));
  }
});

test('starfield: plane 1 blinks unless control[2] is 0x85', () => {
  const count = (/** @type {number[]} */ ctl, /** @type {number} */ frame) => {
    const s = new Starfield();
    s.framecount = frame;
    const out = new Uint8Array(288 * 224);
    s.draw(out, ctl);
    let n = 0;
    for (const v of out) if (v) n += 1;
    return n;
  };
  const steady = count([1, 0x87, 0x85, 0x87], 0);
  const lit = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((f) => count([1, 0x87, 0x87, 0x87], f));
  assert.ok(lit.every((n) => n < steady), 'some plane 1 stars hidden');
  assert.ok(new Set(lit).size > 1, 'which ones changes from frame to frame');
});

test('render: starfield control drives the frame, stars sit behind tiles', () => {
  const mem = blankMemory();
  const r = new Renderer();
  r.render(mem, { starControl: [1, 0x87, 0x85, 0x87] });
  let stars = 0;
  for (const v of r.raster) if (v !== BACKGROUND) stars += 1;
  assert.ok(stars > 20, `${stars} star pixels`);
  r.render(mem, { starControl: [0, 0x87, 0x85, 0x87] });
  assert.ok(r.raster.every((v) => v === BACKGROUND));
});

test('render: a full busy frame renders in under 8 ms', () => {
  const mem = blankMemory();
  for (let i = 0; i < 0x400; i += 1) {
    mem[i] = (i * 7) & 0xff;
    mem[0x400 + i] = i & 0xff;
  }
  for (let n = 0; n < 64; n += 1) {
    putSprite(mem, n, { code: n * 5, color: n & 15, x: (n * 13) % 200, y: (n * 29) % 270, sizex: n & 1, sizey: (n >> 1) & 1 });
  }
  const r = new Renderer();
  const ctl = [1, 0x85, 0x06, 0x81];
  for (let i = 0; i < 20; i += 1) { r.render(mem, { starControl: ctl }); r.vblank(); }
  const t0 = performance.now();
  const frames = 60;
  for (let i = 0; i < frames; i += 1) { r.render(mem, { starControl: ctl }); r.vblank(); }
  const ms = (performance.now() - t0) / frames;
  assert.ok(ms < 8, `${ms.toFixed(2)} ms per frame`);
  assert.equal(r.pixels.length, SCREEN_WIDTH * SCREEN_HEIGHT);
});

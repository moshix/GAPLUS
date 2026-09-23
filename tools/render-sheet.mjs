// Copyright 2026 by Moshix
/**
 * Render a synthetic test screen through src/video/renderer.js and save it as
 * assets/render-test.png, to check layout, orientation and colours by eye.
 *
 * Memory is filled the way the game does it -- tile codes at $0000, tile
 * attributes at $0400, sprite registers at $0F80/$1780/$1F80 -- and nothing
 * else, so what comes out is what the renderer would show for the real
 * program.
 *
 * Gaplus's font (checked on assets/tiles.png) is ASCII-ordered: codes
 * 0x30-0x39 are the digits, 0x41-0x5A the letters A-Z, 0x20 a blank;
 * 0x2A-0x2E spell the "namco" logo. Codes 0x80-0xFF repeat the set.
 *
 * Usage: node tools/render-sheet.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ROOT } from './romset.mjs';
import { encodePng } from './png.mjs';
import { Renderer, SCREEN_WIDTH, SCREEN_HEIGHT, playerCellOffset } from '../src/video/renderer.js';
import { SPRITE_RAM1, SPRITE_RAM2, SPRITE_RAM3 } from '../src/video/sprites.js';

/** Blank character. */
export const SPACE = 0x20;

/**
 * Gaplus tile code of an ASCII character (digits, A-Z, space, - . / ?).
 * @param {string} ch @returns {number}
 */
export function charCode(ch) {
  if (/[0-9A-Z]/.test(ch)) return ch.charCodeAt(0);
  return SPACE;
}

/**
 * Write text left to right at the player's cell (x, y).
 * @param {Uint8Array} mem main CPU address space
 * @param {number} x player column 0-27 @param {number} y player row 0-35
 * @param {string} text @param {number} attr attribute byte (colour 0-63,
 *   bit 6 over sprites, bit 7 code bit 8)
 */
export function putText(mem, x, y, text, attr) {
  for (let i = 0; i < text.length; i += 1) {
    const offs = playerCellOffset(x + i, y);
    mem[offs] = charCode(text[i]);
    mem[0x400 + offs] = attr;
  }
}

/**
 * A blank 64 KB main-CPU memory with the tilemap cleared and every sprite
 * switched off ($1F81+2n bit 1).
 * @returns {Uint8Array}
 */
export function blankMemory() {
  const mem = new Uint8Array(0x10000);
  mem.fill(SPACE, 0, 0x400);
  for (let n = 0; n < 64; n += 1) mem[SPRITE_RAM3 + 2 * n + 1] = 0x02;
  return mem;
}

/**
 * Program sprite register n so that the sprite's top-left corner lands at
 * the player's pixel (x, y). Inverts draw_sprites():
 *   raster sx = player y  =>  X (9 bits) = y + 71
 *   raster top = 223 - x - (height - 1)
 *   top = ((248 - v - 16*sizey) & 0xff) - 32  =>  v = (216 - 16*sizey - top) & 0xff
 * @param {Uint8Array} mem
 * @param {number} n sprite 0-63
 * @param {{code: number, color: number, x: number, y: number,
 *   flipx?: number, flipy?: number, sizex?: number, sizey?: number,
 *   duplicate?: number}} s
 */
export function putSprite(mem, n, s) {
  const o = 2 * n;
  const sizex = s.sizex ?? 0;
  const sizey = s.sizey ?? 0;
  const sx = s.y + 71;
  const top = 223 - s.x - (16 * (sizey + 1) - 1);
  mem[SPRITE_RAM1 + o] = s.code & 0xff;
  mem[SPRITE_RAM1 + o + 1] = s.color;
  mem[SPRITE_RAM2 + o] = (216 - 16 * sizey - top) & 0xff;
  mem[SPRITE_RAM2 + o + 1] = sx & 0xff;
  mem[SPRITE_RAM3 + o] = (s.flipx ?? 0) | ((s.flipy ?? 0) << 1) | (sizex << 3)
    | (sizey << 5) | (((s.code >> 8) & 1) << 6) | ((s.duplicate ?? 0) << 7);
  mem[SPRITE_RAM3 + o + 1] = (sx >> 8) & 1;
}

function main() {
  const mem = blankMemory();
  // Top two rows ($03C0-$03FF).
  putText(mem, 3, 0, '1UP', 1);
  putText(mem, 9, 0, 'HIGH SCORE', 1);
  putText(mem, 1, 1, '00', 0);
  putText(mem, 11, 1, '20000', 0);
  // Playfield.
  putText(mem, 11, 12, 'GAPLUS', 2);
  putText(mem, 0, 2, 'TOP LEFT', 3);
  putText(mem, 19, 33, 'BOT RIGHT', 3);
  putText(mem, 4, 20, 'OVER SPRITES', 0x40 | 12);
  // Bottom two rows ($0000-$003F).
  putText(mem, 0, 35, 'CREDIT 0', 0);
  putText(mem, 27, 34, 'Z', 3);

  // Sprites in the player's coordinates.
  putSprite(mem, 0, { code: 0x2e, color: 0, x: 104, y: 256 });                   // fighter
  putSprite(mem, 1, { code: 0x10, color: 0, x: 40, y: 64 });
  putSprite(mem, 2, { code: 0x20, color: 1, x: 64, y: 64 });
  putSprite(mem, 3, { code: 0x60, color: 2, x: 88, y: 64 });
  putSprite(mem, 4, { code: 0x80, color: 5, x: 112, y: 64 });
  putSprite(mem, 5, { code: 0x2e, color: 0, x: 140, y: 64, flipy: 1 });         // fighter, flipped
  putSprite(mem, 6, { code: 0x60, color: 8, x: 150, y: 150, sizex: 1, sizey: 1 }); // double size
  putSprite(mem, 7, { code: 0x2e, color: 0, x: 0, y: 272 });                     // bottom-left corner
  putSprite(mem, 8, { code: 0x2e, color: 0, x: 208, y: 0 });                     // top-right corner
  putSprite(mem, 9, { code: 0x40, color: 11, x: 40, y: 150, sizey: 1, duplicate: 1 });
  putSprite(mem, 10, { code: 0x10, color: 14, x: 60, y: 152 });                  // under the text

  // Stars on, all three planes scrolling at different speeds; run a few
  // frames so the motion code is exercised.
  const starControl = [0x01, 0x85, 0x06, 0x81];
  const r = new Renderer();
  for (let i = 0; i < 4; i += 1) {
    r.render(mem, { starControl });
    r.vblank(starControl);
  }
  r.render(mem, { starControl });

  mkdirSync(join(ROOT, 'assets'), { recursive: true });
  writeFileSync(join(ROOT, 'assets/render-test.png'), encodePng(r.pixels, SCREEN_WIDTH, SCREEN_HEIGHT, 2));
  console.log('wrote assets/render-test.png');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

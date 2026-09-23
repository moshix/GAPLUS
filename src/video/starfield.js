// Copyright 2026 by Moshix
/**
 * The Gaplus starfield, ported from MAME's gaplus_v.cpp (starfield_init,
 * starfield_render, screen_vblank).
 *
 * ACCURACY. MAME says so plainly: "TODO: The starfield is wrong"
 * (gaplus.cpp), and starfield_init() notes "this comes from the Galaxian
 * hardware, Gaplus is probably different". The real CUS26 is not
 * understood; the star colours are "a guess based on comparison with PCB
 * video output", the second-layer blinking is "based on a guess from the
 * video output of the PCB", and the schematics show four lines from the
 * 58XX to the 26XX whose function is unknown. This module reproduces MAME's
 * model exactly, no more. It is DISPLAY ONLY: the stars never feed back into
 * the game, so nothing in RAM depends on them and lockstep cannot check them.
 *
 * CONTROL. The main CPU writes four registers at $A000-$A003 (write-only;
 * MAME maps $A000-$A7FF with offset & 3, and reads there return ROM):
 *   $A000  bit 0: 1 = starfield on (off: nothing drawn, nothing moves)
 *   $A001  plane (set) 0 motion code
 *   $A002  plane 1 motion code
 *   $A003  plane 2 motion code
 * Motion codes MAME knows (anything else stands still), in raster space:
 *   0x87 still; 0x85/0x86 +1 X; 0x06 +2 X; 0x80 -1 X; 0x82 -2 X; 0x81 -3 X;
 *   0x9F +3 Y; 0xAF -3 Y.
 * Raster +X is the player's screen DOWN, raster +Y the player's LEFT.
 *
 * TIMING. MAME draws the frame (screen_update), then at the falling edge of
 * vblank (screen_vblank(0)) bumps the frame counter and moves the stars.
 * Call draw() for a frame, then vblank() once, with the control values as
 * they stand at that moment.
 *
 * Everything is in RASTER space (288 x 224); the renderer rotates the
 * finished frame.
 */
import { penIndirect } from './pens.js';

/** m_stars[] capacity (gaplus.h MAX_STARS). */
export const MAX_STARS = 250;
/** STARFIELD_CLIPPING_X: stars live in raster X 16..271. */
export const STARFIELD_CLIPPING_X = 16;

/** SPEED_1..3 of gaplus_v.cpp ("bigger = faster"). */
const SPEED_1 = 1;
const SPEED_2 = 2;
const SPEED_3 = 3;

/**
 * Pen bases per star set: case 0: 0x250, case 1: 0x230, case 2: 0x210 --
 * "A guess based on comparison with PCB video output". These pens fall in
 * the sprite range, i.e. sprite colours 42, 38 and 34.
 */
export const STAR_PEN_BASE = Object.freeze([0x250, 0x230, 0x210]);

/**
 * One step of the motion switch in screen_vblank.
 * @param {number} code the plane's control byte
 * @returns {[number, number]} [dx, dy] in raster pixels
 */
export function starMotion(code) {
  switch (code) {
    case 0x87: return [0, 0];          // stand still
    case 0x85:
    case 0x86: return [SPEED_1, 0];    // "scroll down (speed 1)"
    case 0x06: return [SPEED_2, 0];    // "scroll down (speed 2)"
    case 0x80: return [-SPEED_1, 0];   // "scroll up (speed 1)"
    case 0x82: return [-SPEED_2, 0];   // "scroll up (speed 2)"
    case 0x81: return [-SPEED_3, 0];   // "scroll up (speed 3)"
    case 0x9f: return [0, SPEED_3];    // "scroll left (speed 3)"
    case 0xaf: return [0, -SPEED_3];   // "scroll right (speed 3)"
    default: return [0, 0];
  }
}

export class Starfield {
  /**
   * @param {number} [width] raster width (m_screen->width())
   * @param {number} [height] raster height
   */
  constructor(width = 288, height = 224) {
    this.width = width;
    this.height = height;
    /** @type {number[]} */ this.x = [];
    /** @type {number[]} */ this.y = [];
    /** Pen of each star (MAME m_stars[i].col). @type {number[]} */ this.pen = [];
    /** Indirect colour of each star's pen. @type {number[]} */ this.color = [];
    /** Set (plane) 0-2 of each star. @type {number[]} */ this.set = [];
    this.total = 0;
    this.framecount = 0;
    this.init();
  }

  /**
   * starfield_init(): lay the stars out with a Galaxian-style 18-bit LFSR
   * clocked once per pixel over the 256 x 224 star window, right to left.
   *
   * The C code keeps the register in a plain signed `int` and never masks
   * it, so the bits above 17 are old LFSR output shifted up, bit 31 wraps
   * into the sign, and `(~(generator >> 8)) % 7 + 1` is computed on a
   * signed value: C's `%` truncates toward zero, so when the register is
   * non-negative the result is -6..0 and the colour offset comes out -5..1.
   * Zero is skipped (`if (color && ...)`), NEGATIVE offsets are kept -- the
   * star then shows a lower pen of the neighbouring sprite colour. JS's
   * 32-bit `<<`, `>>`, `~` and `%` behave exactly like C's int operators
   * here, so the transliteration is literal.
   */
  init() {
    let generator = 0;
    let set = 0;
    this.x.length = 0;
    this.y.length = 0;
    this.pen.length = 0;
    this.color.length = 0;
    this.set.length = 0;
    this.total = 0;
    this.framecount = 0;
    for (let y = 0; y < this.height; y += 1) {
      for (let x = this.width - STARFIELD_CLIPPING_X * 2 - 1; x >= 0; x -= 1) {
        generator = (generator << 1) | 0;
        const bit1 = (~generator >> 17) & 1;
        const bit2 = (generator >> 5) & 1;
        if (bit1 ^ bit2) generator |= 1;

        // BIT(~generator, 16) && (generator & 0xff) == 0xff
        if (((~generator >> 16) & 1) && (generator & 0xff) === 0xff) {
          const color = ((~(generator >> 8)) % 7) + 1;
          const colorBase = STAR_PEN_BASE[set];
          if (color && this.total < MAX_STARS) {
            this.x.push(x + STARFIELD_CLIPPING_X);
            this.y.push(y);
            this.pen.push(colorBase + color);
            this.color.push(penIndirect(colorBase + color));
            this.set.push(set);
            set += 1;
            if (set === 3) set = 0;
            this.total += 1;
          }
        }
      }
    }
  }

  /**
   * starfield_render(): plot every star. A star is one pixel; it overwrites
   * whatever is there (the black fill).
   *
   * Blink rule for plane 1 ("Some stars in the second layer will flash
   * erratically when changing their movements ... a guess"): unless
   * control[2] is 0x85, even-numbered stars of set 1 skip frames according
   * to bits 1-3 of (framecount + i).
   *
   * @param {Uint8Array} out raster, one indirect colour per pixel
   * @param {ArrayLike<number>} control $A000-$A003
   */
  draw(out, control) {
    if ((control[0] & 1) === 0) return;
    const { width, height } = this;
    for (let i = 0; i < this.total; i += 1) {
      const x = this.x[i];
      const y = this.y[i];
      if (this.set[i] === 1 && control[2] !== 0x85 && i % 2 === 0) {
        const v = this.framecount + i;
        const bit = (v >> 3) & 1 ? 1 : 2;
        if ((v >> bit) & 1) continue;
      }
      if (x >= 0 && x < width && y >= 0 && y < height) out[y * width + x] = this.color[i];
    }
  }

  /**
   * screen_vblank(0), the falling edge: count the frame, then (if on) move
   * each star by its plane's motion code and wrap it into the window
   * X 16..271, Y 0..223.
   * @param {ArrayLike<number>} control $A000-$A003
   */
  vblank(control) {
    this.framecount += 1;
    if ((control[0] & 1) === 0) return;
    const { width, height } = this;
    const span = width - STARFIELD_CLIPPING_X * 2;
    for (let i = 0; i < this.total; i += 1) {
      const [dx, dy] = starMotion(control[this.set[i] + 1]);
      let x = this.x[i] + dx;
      let y = this.y[i] + dy;
      if (x < STARFIELD_CLIPPING_X) x = span + x;
      if (x >= width - STARFIELD_CLIPPING_X) x -= span;
      if (y < 0) y = height + y;
      if (y >= height) y -= height;
      this.x[i] = x;
      this.y[i] = y;
    }
  }
}

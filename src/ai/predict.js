// Copyright 2026 by Moshix
/**
 * Motion, forwards: where an object will be in t frames, how sure we are,
 * and how the fighter moves under a given stick -- the latter exactly as
 * task_move_player ($CF4F) does it, limits and all.
 */

import { DIRS, V_TOP_LO, V_BOTTOM_LO } from './constants.js';

/** @typedef {import('./world.js').Obj} Obj */
/** @typedef {import('./world.js').World} World */

/**
 * Measured acceleration is trusted for this many frames, then the object
 * is assumed to keep the speed it has reached: a diver's path curves, but
 * not for ever in the same direction.
 */
const ACC_FRAMES = 8;
/** Acceleration beyond this (px/frame^2) is measurement noise. */
const ACC_MAX = 0.35;

/**
 * Predicted position of `o` after `t` frames.
 * @param {Obj} o @param {number} t
 * @param {Float64Array | number[]} out [h, v] written here
 */
export function predict(o, t, out) {
  if (o.exact || o.age < 2 * 4) {
    out[0] = o.h + o.vh * t;
    out[1] = o.v + o.vv * t;
    return;
  }
  // Speed grows by a per frame for ACC_FRAMES frames, then stays:
  // displacement = v t + a (t' t - t'^2 / 2), t' = min(t, ACC_FRAMES).
  const ta = Math.min(t, ACC_FRAMES);
  const k = ta * t - (ta * ta) / 2;
  const ah = Math.max(-ACC_MAX, Math.min(ACC_MAX, o.ah));
  const av = Math.max(-ACC_MAX, Math.min(ACC_MAX, o.av));
  out[0] = o.h + o.vh * t + ah * k;
  out[1] = o.v + o.vv * t + av * k;
}

/**
 * How far off the prediction may be after `t` frames, in pixels: nothing
 * for a computed track, more for a young measurement than an old one.
 * @param {Obj} o @param {number} t @returns {number}
 */
export function margin(o, t) {
  if (o.exact) return 1 + 0.03 * t;
  if (o.age < 2) return Math.min(10, 2 + 0.5 * t);
  if (o.age < 8) return Math.min(10, 1.5 + 0.25 * t);
  return Math.min(8, 1 + 0.14 * t);
}

/**
 * The fighter's position, mutable, for simulating the stick.
 * @typedef {object} Ship
 * @property {number} h @property {number} v
 */

/**
 * One frame of task_move_player: horizontal first (right before left,
 * $CF64-$CF71), then -- unless $1111 locks it -- vertical (up before down).
 * Horizontal is 8-bit, limited by player_xmin/xmax; vertical is 9-bit and
 * stops when its LOW byte is $C8 (up) or $49 (down).
 * @param {Ship} s mutated
 * @param {number} dir index into DIRS
 * @param {World} w for the speeds and limits
 */
export function stepShip(s, dir, w) {
  const [dh, dv] = DIRS[dir];
  if (dh > 0) {
    if (s.h < w.hMax) s.h = (s.h + w.hStep) & 0xff;
  } else if (dh < 0) {
    if (s.h >= w.hMin) s.h = (s.h - w.hStep) & 0xff;
  }
  if (w.vLocked) return;
  if (dv < 0) {
    if ((s.v & 0xff) !== V_TOP_LO) s.v = (s.v - w.vStep) & 0x1ff;
  } else if (dv > 0) {
    if ((s.v & 0xff) !== V_BOTTOM_LO) s.v = (s.v + w.vStep) & 0x1ff;
  }
}

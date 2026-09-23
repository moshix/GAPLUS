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
 * A measured turn is trusted for this many frames, then the object is
 * assumed to fly straight on: a diver's path is a string of arcs, and the
 * next one may bend the other way. Measured on recorded games, flying a
 * diver on at its current speed and turn rate halves the median error of
 * a straight-line (or constant-acceleration) guess at 8-16 frames.
 */
const TURN_FRAMES = 12;
/** Turn rates beyond this (radians per frame) are measurement noise. */
const TURN_MAX = 0.3;
/** Measured tracks younger than this have no turn rate yet. */
const TURN_AGE = 8;

/**
 * Predicted position of `o` after `t` frames.
 * @param {Obj} o @param {number} t
 * @param {Float64Array | number[]} out [h, v] written here
 */
export function predict(o, t, out) {
  if (o.exact || o.age < TURN_AGE || o.turn === 0) {
    out[0] = o.h + o.vh * t;
    out[1] = o.v + o.vv * t;
    return;
  }
  // Fly on at the measured speed, turning by w a frame for TURN_FRAMES
  // frames. The measured velocity is the mean over the last 4 frames, so
  // its heading is the one of 1.5 frames ago; frame k's step is taken at
  // heading th0 + w (k + 1.5). The sum of k steps along an arc is a
  // geometric series: s * e^{i a} * (1 - e^{i w n}) / (1 - e^{i w}),
  // written out in sines and cosines.
  const w = Math.max(-TURN_MAX, Math.min(TURN_MAX, o.turn));
  const s = o.speed;
  const a = Math.atan2(o.vv, o.vh) + w * 2.5;   // heading of step 1
  const n = Math.min(t, TURN_FRAMES);
  // Sum over k = 0..n-1 of e^{i(a + w k)}.
  const half = Math.sin(w / 2);
  const ratio = Math.abs(half) < 1e-6 ? n : Math.sin((w * n) / 2) / half;
  const mid = a + (w * (n - 1)) / 2;
  let h = o.h + s * ratio * Math.cos(mid);
  let v = o.v + s * ratio * Math.sin(mid);
  if (t > n) {
    // Straight on at the last heading.
    const last = a + w * (n - 1);
    h += s * (t - n) * Math.cos(last);
    v += s * (t - n) * Math.sin(last);
  }
  out[0] = h;
  out[1] = v;
}

/**
 * How far off the prediction may be after `t` frames, in pixels: nothing
 * much for a computed track; for a measured one, about the 80th
 * percentile of the error measured on recorded games (8 px at 8 frames,
 * 13 at 12), more while the track is young.
 * @param {Obj} o @param {number} t @returns {number}
 */
export function margin(o, t) {
  if (o.exact) return 1 + 0.03 * t;
  if (o.age < TURN_AGE) return Math.min(20, 3 + 0.8 * t);
  return Math.min(18, 1.5 + 0.45 * t + 0.03 * t * t);
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

// Copyright 2026 by Moshix
/**
 * Shooting: where it is worth standing, and whether a shot fired now hits.
 *
 * A shot appears at the fighter's position on the frame the press is
 * seen, and climbs shot_speed (6) pixels every frame from then on
 * (task_player_fire $D19E, task_move_shots $D1E4); task_shot_hits tests
 * it the same frame against every formation member and object. Only two
 * shots may be in flight, and a shot takes up to 44 frames to leave the
 * screen, so a shot that misses costs a lot: fire only at something the
 * shot will meet.
 */

import { SHOT_HORIZON, SHOT_HIT_V, SHOT_EXIT_V, SHOT_TOLERANCE } from './constants.js';
import { predict } from './predict.js';
import { KIND } from './world.js';

/** @typedef {import('./world.js').World} World */
/** @typedef {import('./world.js').Obj} Obj */

/** How much each kind of target is worth aiming at. */
const WEIGHT = Object.freeze({
  [KIND.ESHOT]: 0,
  [KIND.DIVER]: 1.6,     // shooting a diver also removes a threat
  [KIND.OBJECT]: 1.2,
  [KIND.FORMATION]: 1,
  [KIND.OTHER]: 0.5,
});

/**
 * Fill `aim` (256 entries, one per horizontal position) with the value of
 * standing there: for each target, where it will be by the time the
 * fighter has walked under it (from where it is, to row fromV) and a shot
 * has climbed to it. Normalised to 0-1. Without `aim`, only the total is
 * computed: how much there is to shoot at from that row.
 * @param {Float64Array | null} aim
 * @param {World} w
 * @param {number} fromV the row the fighter will shoot from
 * @param {boolean} [broad] add the broad hill (challenging stages: in
 *   normal play it lured the fighter towards far targets and cost ships)
 * @returns {number} the summed value of every target reachable
 */
export function buildAimMap(aim, w, fromV, broad = false) {
  aim?.fill(0);
  const p = [0, 0];
  let top = 0;
  let mass = 0;
  const rise = Math.abs(fromV - w.v) / w.vStep;
  for (const o of w.targets) {
    const weight = WEIGHT[o.kind] ?? 0;
    if (weight === 0) continue;
    // Walk, then climb; both estimates, refined by a second pass with
    // the target's predicted column.
    const climb = Math.max(0, fromV - o.v) / w.shotSpeed;
    let t = Math.max(rise, Math.abs(o.h - w.h) / w.hStep) + climb;
    predict(o, Math.min(t, 60), p);
    t = Math.max(rise, Math.abs(p[0] - w.h) / w.hStep) + climb;
    predict(o, Math.min(t, 60), p);
    // It must still be above the shot's start by then.
    if (p[1] >= fromV || p[1] < 0) continue;
    // Nearer targets first: they are better predicted and quicker to hit.
    const value = weight / (1 + t / 40);
    mass += value;
    if (aim === null) continue;
    const c = Math.round(p[0]);
    for (let d = -5; d <= 5; d += 1) {
      const x = c + d;
      if (x < 0 || x > 255) continue;
      // In normal play, flat within 2 px of the column: a dead zone, so
      // lining up a shot does not twitch the fighter back and forth over a
      // pixel or two. A challenging stage keeps the sharp peak (hits).
      aim[x] += value * (broad ? 1 - Math.abs(d) / 6 : Math.min(1, (6 - Math.abs(d)) / 4));
      if (aim[x] > top) top = aim[x];
    }
  }
  if (aim !== null && top > 0 && !broad) {
    for (let x = 0; x < 256; x += 1) aim[x] /= top;
  } else if (aim !== null && top > 0) {
    // Add a broad, low hill under the sharp peaks, so that from far away
    // there is still a slope towards them.
    const wide = smooth(aim, WIDE);
    let peak = 0;
    for (let x = 0; x < 256; x += 1) peak = Math.max(peak, wide[x]);
    for (let x = 0; x < 256; x += 1) {
      aim[x] = (1 - WIDE_SHARE) * (aim[x] / top) + WIDE_SHARE * (wide[x] / peak);
    }
  }
  return mass;
}

/** Radius of the broad hill, pixels, and its share of the aim value. */
const WIDE = 48;
const WIDE_SHARE = 0.3;

/**
 * Triangular smoothing of radius r.
 * @param {Float64Array} a @param {number} r @returns {Float64Array}
 */
function smooth(a, r) {
  const out = new Float64Array(256);
  for (let x = 0; x < 256; x += 1) {
    if (a[x] === 0) continue;
    for (let d = -r; d <= r; d += 1) {
      const y = x + d;
      if (y >= 0 && y < 256) out[y] += a[x] * (1 - Math.abs(d) / (r + 1));
    }
  }
  return out;
}

/**
 * Would a shot fired now hit something? The shot starts at (h, v) on the
 * first frame and climbs from there; task_shot_hits tests a target
 * whose h - shot h is in [boxLo, boxHi) and whose v is within 10 of the
 * shot's, on the same side of v = $100.
 * @param {World} w
 * @param {number} h the fighter's position on the press frame
 * @param {number} v
 * @param {number} [tol] aim error allowed inside each side of the box
 * @param {number} [lead] frames before the press is acted on
 * @returns {{target: Obj | null, frame: number}}
 */
export function shotHits(w, h, v, tol = SHOT_TOLERANCE, lead = 0) {
  const p = [0, 0];
  let best = null;
  let bestFrame = Infinity;
  for (const o of w.targets) {
    if ((WEIGHT[o.kind] ?? 0) === 0 || o.v > v + SHOT_HIT_V) continue;
    for (let t = 1; t <= SHOT_HORIZON && t < bestFrame; t += 1) {
      // The press frame places the shot and task_move_shots climbs it at
      // once, so on frame t it is t steps up.
      const sv = v - w.shotSpeed * t;
      if (sv < SHOT_EXIT_V) break;
      predict(o, t + lead, p);
      const dh = p[0] - h;
      if (dh < w.boxLo + tol || dh >= w.boxHi - tol) continue;
      if (Math.abs(p[1] - sv) >= SHOT_HIT_V - tol) continue;
      // The box compares low bytes, with the shot's v bit 8 required to
      // match the target's (formation members: bit 8 clear).
      if ((Math.round(p[1]) >> 8) !== (sv >> 8)) continue;
      best = o;
      bestFrame = t;
      break;
    }
  }
  return { target: best, frame: bestFrame };
}

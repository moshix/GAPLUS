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
 * fighter has walked under it and a shot has climbed to it. Normalised to
 * 0-1.
 * @param {Float64Array} aim
 * @param {World} w
 * @param {number} fromV the row the fighter will shoot from
 */
export function buildAimMap(aim, w, fromV) {
  aim.fill(0);
  const p = [0, 0];
  let top = 0;
  for (const o of w.targets) {
    const weight = WEIGHT[o.kind] ?? 0;
    if (weight === 0 || o.v >= fromV) continue;
    // Walk, then climb; both estimates, refined by a second pass with
    // the target's predicted column.
    const climb = (fromV - o.v) / w.shotSpeed;
    let t = Math.abs(o.h - w.h) / w.hStep + climb;
    predict(o, Math.min(t, 60), p);
    t = Math.abs(p[0] - w.h) / w.hStep + climb;
    predict(o, Math.min(t, 60), p);
    if (p[1] >= fromV || p[1] < 0) continue;
    // Nearer targets first: they are better predicted and quicker to hit.
    const value = weight / (1 + t / 40);
    const c = Math.round(p[0]);
    for (let d = -5; d <= 5; d += 1) {
      const x = c + d;
      if (x < 0 || x > 255) continue;
      aim[x] += value * (1 - Math.abs(d) / 6);
      if (aim[x] > top) top = aim[x];
    }
  }
  if (top > 0) for (let x = 0; x < 256; x += 1) aim[x] /= top;
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

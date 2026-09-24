// Copyright 2026 by Moshix
/**
 * Where to move: a search over stick plans.
 *
 * The fighter is slow (2 px a frame sideways, 1 up or down) and threats
 * are fast, so a decision is only as good as the frames it looks ahead.
 * Every frame, every plan of the form "push d1 for k frames, then d2 until
 * the horizon" (9 x 9 directions, a handful of k) is walked through the
 * fighter's real step logic (predict.js stepShip), and checked against the
 * predicted track of every threat that could come within reach.
 *
 * A plan is judged, in this order:
 *  1. how many frames it survives -- a frame of life outweighs anything
 *     else. Two times are counted: until a threat's box, widened by the
 *     whole uncertainty of its predicted track, covers the fighter, and
 *     until its box widened only a little does;
 *  2. how close it passes to threats (a near miss predicted is a hit
 *     half the time: the tracks are measured, not known);
 *  3. where it ends up: under something worth shooting (the aim map), at
 *     the home row, away from the side walls;
 *  4. whether it keeps the direction already taken: changing costs a
 *     little, turning round soon after the last change costs more, and a
 *     vertical move must earn its start (no flicker; see planCosts).
 * The first direction of the best plan is what the stick does this frame;
 * next frame the search runs again from where the fighter really is.
 */

import { DIRS, HORIZON, HIT_H, HIT_V2 } from './constants.js';
import { predict, margin, stepShip } from './predict.js';

/** @typedef {import('./world.js').World} World */
/** @typedef {import('./world.js').Obj} Obj */

/** Most threats considered in one frame (the hit check scans 79). */
const MAX_THREATS = 80;
/** Switch points tried for the first segment, frames. */
const SWITCH_AT = Object.freeze([1, 3, 6, 10, 16]);
/** A pass closer than this (beyond the hit box and margin) costs. */
const CLEARANCE = 12;
/** Results of test() other than a clearance cost. */
export const SURE = -2;
export const POSSIBLE = -1;
/** The fraction of the margin that makes a hit "sure". */
const SURE_FRACTION = 0.35;
/** Score per frame before a sure hit, and before a possible one. */
const W_SURE = 70;
const W_SAFE = 50;
/** Weight of the clearance cost against one frame of survival (120). */
const W_PROX = 30;
/** Weight of the end position's value. */
const W_AIM = 12;
const W_HOME = 25;
const W_WALL = 14;
/** Pixels either side of the home row that count as on it. */
const HOME_BAND = 8;
/** The position's worth is sampled every this many frames of a plan: every
 * frame, or a 5 px wide aim peak is missed between samples at 3 px/frame. */
const VALUE_EVERY = 1;
/**
 * Commitment (no flicker). A plan whose first move differs from the stick
 * as it is pays W_SWITCH (W_START from a standstill); one that turns an
 * axis round (left <-> right, up <-> down) pays W_REVERSE more while the
 * last change is younger than HOLD frames, a third of it after; one that
 * starts a vertical move pays W_VERTICAL. All are far below a frame of
 * survival (120), so a threat that demands a turn always gets it; they
 * only stop the fighter trading directions over small differences.
 */
const W_SWITCH = 4;
const W_START = 3;
const W_REVERSE = 20;
const W_VERTICAL = 3;
const HOLD = 12;
/** Share of the commitment costs kept in a challenging stage. */
const CHALLENGE_COMMIT = 0.3;

/**
 * The stick as it is: the direction sent last frame, frames since it last
 * changed, and the last non-zero sign of each axis.
 * @typedef {object} Steer
 * @property {number} dir @property {number} since
 * @property {number} signH @property {number} signV
 */

/** A fighter at rest with no history. @type {Steer} */
export const STILL = Object.freeze({ dir: 0, since: HOLD, signH: 0, signV: 0 });

/**
 * The cost of changing the stick from `from` to `to`.
 * @param {number} from @param {number} to DIRS indices
 * @param {number} signH @param {number} signV last non-zero sign of each
 *   axis before the change
 * @param {boolean} early the last change was less than HOLD frames ago
 * @returns {number}
 */
export function changeCost(from, to, signH, signV, early) {
  if (from === to) return 0;
  const [ch, cv] = DIRS[from];
  const [dh, dv] = DIRS[to];
  const turn = early ? W_REVERSE : W_REVERSE / 3;
  let cost = from === 0 ? W_START : W_SWITCH;
  if (dh !== 0 && signH !== 0 && dh !== signH) cost += turn;
  if (dv !== 0 && signV !== 0 && dv !== signV) cost += turn;
  if (dv !== 0 && cv === 0) cost += W_VERTICAL;
  // Stopping one axis while the other carries on is a lesser change.
  if (dh === ch && dh !== 0) cost *= 0.6;
  return cost;
}

/**
 * The commitment cost of every plan, given the stick as it is: its first
 * change (from the stick to d1) and its second (d1 to d2, early if it
 * comes within HOLD frames). Charging the second one too matters: with
 * only the first, "wait a frame, then go" always looked cheaper than
 * "go", and the fighter waited for ever.
 * @param {Steer} steer @param {Plan[]} plans @param {Float64Array} out
 */
export function planCosts(steer, plans, out) {
  for (let i = 0; i < plans.length; i += 1) {
    const { d1, k, d2 } = plans[i];
    let cost = changeCost(steer.dir, d1, steer.signH, steer.signV, steer.since < HOLD);
    if (d2 !== d1) {
      const [h1, v1] = DIRS[d1];
      cost += changeCost(d1, d2, h1 !== 0 ? h1 : steer.signH, v1 !== 0 ? v1 : steer.signV,
        k < HOLD);
    }
    out[i] = cost;
  }
}
/** Room from the side walls wanted, pixels. */
const WALL_ROOM = 20;
/** No tie-break offsets. */
const NO_BIAS = new Float64Array(DIRS.length);

/**
 * @typedef {object} Plan
 * @property {number} d1 first direction
 * @property {number} k  frames of d1
 * @property {number} d2 direction afterwards
 */

/** Every plan: (d1, k, d2), with the d1 == d2 duplicates removed. */
function makePlans() {
  /** @type {Plan[]} */
  const plans = [];
  for (let d1 = 0; d1 < DIRS.length; d1 += 1) {
    plans.push({ d1, k: HORIZON, d2: d1 });
    for (const k of SWITCH_AT) {
      for (let d2 = 0; d2 < DIRS.length; d2 += 1) {
        if (d2 !== d1) plans.push({ d1, k, d2 });
      }
    }
  }
  return plans;
}

/**
 * The result of a search.
 * @typedef {object} Move
 * @property {number} dir     stick direction for this frame (DIRS index)
 * @property {number} tDeath  first frame the best plan is hit (HORIZON + 1:
 *                            never, within the horizon)
 * @property {number} h       where the best plan puts the fighter after
 *                            this frame's move
 * @property {number} v
 */

export class Planner {
  /** @param {number} [horizon] */
  constructor(horizon = HORIZON) {
    this.horizon = horizon;
    this.plans = makePlans();
    const n = MAX_THREATS * (horizon + 1);
    // Threat j's predicted position and uncertainty at frame t, at
    // [j * (horizon + 1) + t].
    this.th = new Float64Array(n);
    this.tv = new Float64Array(n);
    this.tm = new Float64Array(n);
    this.count = 0;
    /** Scratch. */
    this.pos = new Float64Array(2);
    /** Commitment cost per plan, this frame. */
    this.costs = new Float64Array(this.plans.length);
    /** Diagnostics. */
    this.lastScore = 0;
  }

  /**
   * Predict every threat that could reach the fighter within the horizon.
   * @param {World} w
   * @param {Obj[]} threats
   */
  prepare(w, threats) {
    const H = this.horizon;
    const p = this.pos;
    let n = 0;
    for (const o of threats) {
      if (n >= MAX_THREATS) break;
      const base = n * (H + 1);
      let reachable = false;
      for (let t = 0; t <= H; t += 1) {
        predict(o, t, p);
        const m = margin(o, t);
        this.th[base + t] = p[0];
        this.tv[base + t] = p[1];
        this.tm[base + t] = m;
        // Could the fighter be there by then? It covers hStep and vStep
        // pixels a frame; the extra is the clearance zone.
        if (!reachable
            && Math.abs(p[0] - w.h) < w.hStep * t + HIT_H + m + CLEARANCE
            && Math.abs(p[1] - w.v) < w.vStep * t + 2 * HIT_V2 + m + CLEARANCE) {
          reachable = true;
        }
      }
      if (reachable) n += 1;
    }
    this.count = n;
  }

  /**
   * Choose the stick direction.
   * @param {World} w
   * @param {number[]} queued directions already sent but not yet acted on,
   *   oldest first (they move the fighter before any plan does)
   * @param {(h: number, v: number) => number} value worth of ending at
   *   (h, v), 0-1 (the aim map and the home row)
   * @param {Steer} [steer] the stick as it is (commitment costs)
   * @param {ArrayLike<number>} [bias] per first direction, a small score
   *   offset (the benchmark's seeded tie-breaks; none by default)
   * @returns {Move}
   */
  choose(w, queued, value, steer = STILL, bias = NO_BIAS) {
    planCosts(steer, this.plans, this.costs);
    // In a challenging stage every hit counts and nothing can hit back:
    // commitment gives way to chasing (in full it cost a third of the
    // hits).
    if (w.challenge) for (let i = 0; i < this.costs.length; i += 1) this.costs[i] *= CHALLENGE_COMMIT;
    const H = this.horizon;
    const ship = { h: w.h, v: w.v };
    let best = -Infinity;
    /** @type {Move} */
    const move = { dir: 0, tDeath: H + 1, h: w.h, v: w.v };
    for (let pi = 0; pi < this.plans.length; pi += 1) {
      const plan = this.plans[pi];
      ship.h = w.h;
      ship.v = w.v;
      // First frame a threat's widened box covers the fighter (possibly
      // hit), and first frame its tight box does (surely hit, as far as
      // the prediction goes).
      let tSafe = H + 1;
      let tSure = H + 1;
      let prox = 0;
      let firstH = w.h;
      let firstV = w.v;
      let worth = 0;
      for (let t = 1; t <= H; t += 1) {
        const q = t - 1 - queued.length;
        const dir = q < 0 ? queued[t - 1] : (q < plan.k ? plan.d1 : plan.d2);
        stepShip(ship, dir, w);
        if (q === 0) { firstH = ship.h; firstV = ship.v; }
        // The position's worth is sampled along the way, so getting there
        // sooner is worth more than dawdling and getting there at the end.
        if (t % VALUE_EVERY === 0) {
          worth += W_AIM * value(ship.h, ship.v) + W_HOME * homeValue(ship.v, w)
            - W_WALL * wallCost(ship.h, w);
        }
        if (!w.danger) continue;
        const hit = this.test(ship, t);
        if (hit === SURE) {
          tSure = t;
          if (tSafe > H) tSafe = t;
          break;
        }
        if (hit === POSSIBLE) {
          if (tSafe > H) tSafe = t;
          prox += 1 / (1 + t / 8);
          continue;
        }
        // Nearer frames matter more: they are better predicted and
        // cannot be undone.
        prox += hit / (1 + t / 8);
      }
      // Both times count: a plan that is surely hit is worse than one that
      // may be, but a possible hit soon is worse than a sure one late (the
      // search runs again every frame, from better information).
      let score = W_SURE * tSure + W_SAFE * tSafe - prox * W_PROX;
      // Doomed plans stop sampling at the hit; the survivors' worth is the
      // mean of their samples.
      if (tSure > H) score += (tSafe > H ? 1 : 0.5) * worth / Math.floor(H / VALUE_EVERY);
      // Keep going the way it was going: a change must earn its place.
      score -= this.costs[pi];
      score += bias[plan.d1];
      if (score > best) {
        best = score;
        move.dir = plan.d1;
        move.tDeath = tSafe;
        move.h = firstH;
        move.v = firstV;
      }
    }
    this.lastScore = best;
    return move;
  }

  /**
   * How long holding `dir` for the whole horizon stays clear: the first
   * frame a threat's widened box covers the fighter (horizon + 1: never).
   * The minimum-hold rule (autoplay.js) asks this of the direction it is
   * holding before overruling the search.
   * @param {World} w @param {number[]} queued @param {number} dir
   * @returns {number}
   */
  survives(w, queued, dir) {
    const H = this.horizon;
    if (!w.danger) return H + 1;
    const ship = { h: w.h, v: w.v };
    for (let t = 1; t <= H; t += 1) {
      stepShip(ship, t - 1 < queued.length ? queued[t - 1] : dir, w);
      if (this.test(ship, t) < 0) return t;
    }
    return H + 1;
  }

  /**
   * The fighter at `ship` on frame t: SURE if some threat's box, widened
   * by a fraction of its margin, covers it; POSSIBLE if the box widened by
   * the whole margin does; else the clearance cost (0: nothing near).
   * @param {{h: number, v: number}} ship @param {number} t @returns {number}
   */
  test(ship, t) {
    const H1 = this.horizon + 1;
    let cost = 0;
    let possible = false;
    for (let j = 0; j < this.count; j += 1) {
      const k = j * H1 + t;
      const m = this.tm[k];
      const dh = Math.abs(this.th[k] - ship.h) - HIT_H;
      const dv = Math.abs(this.tv[k] - ship.v) - 2 * HIT_V2;
      const ms = Math.max(1, SURE_FRACTION * m);
      if (dh < ms && dv < ms) return SURE;
      if (dh < m && dv < m) { possible = true; continue; }
      const gap = Math.max(dh, dv) - m;
      if (gap < CLEARANCE) cost += (CLEARANCE - gap) / CLEARANCE;
    }
    return possible ? POSSIBLE : cost;
  }
}

/**
 * 1 at the home row (give or take HOME_BAND), falling off linearly over
 * 48 pixels beyond.
 * @param {number} v @param {World} w @returns {number}
 */
function homeValue(v, w) {
  const home = w.vHome ?? v;
  // Flat within HOME_BAND of the row: no tiny vertical corrections.
  return 1 - Math.min(1, Math.max(0, Math.abs(v - home) - HOME_BAND) / 48);
}

/**
 * 0 away from the walls, up to 1 against one: at a wall the fighter can
 * only get away in one direction.
 * @param {number} h @param {World} w @returns {number}
 */
function wallCost(h, w) {
  const left = h - w.hMin;
  const right = w.hMax - h;
  return Math.max(0, (WALL_ROOM - Math.min(left, right)) / WALL_ROOM);
}

// Copyright 2026 by Moshix
/**
 * Cycle accounting for the busy loops of gp2-4.8d (the service mode,
 * delay_65536, the easter egg), which run with the main IRQ off and burn
 * real time.
 *
 * The main foreground has ONE cycle clock per machine, the shared
 * src/game/clock.js: `burn(m, n)` adds n cycles (and charges them to the
 * main CPU) and yields once per frame boundary passed; `clockOf(m).t` is
 * the cycle since vblank where the next instruction starts. The rule:
 * burn the cycles up to the START of the next instruction with an
 * observable effect, then perform it (the oracle's core finishes an
 * instruction that straddles a frame boundary, so an instruction belongs
 * to the frame in which it starts).
 *
 * A `Clock` here collects the cycles of the instructions executed since
 * the last access in `t` and burns them at the next access (`sync`).
 * `abs` counts every cycle seen, for waits measured from an earlier
 * instruction (the handshakes), and `frame0` is where in the frame the
 * clock started. A free clock never burns: the same clocked code then
 * runs as a plain routine (the exported non-generator wrappers).
 *
 * @see docs/porting-guide.md section 6.3 (busy loops)
 */

import { burn, clockOf, SPIN } from '../clock.js';

export { SPIN };

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/** Cycles of one routine's instructions, burned at its accesses. */
export class Clock {
  /**
   * @param {Machine} m
   * @param {boolean} [free] never burn (plain, non-waiting use)
   */
  constructor(m, free = false) {
    /** The machine whose foreground clock is burned. */
    this.m = m;
    /** Never burn. */
    this.free = free;
    /** Cycles executed since the last burn. */
    this.t = 0;
    /** Cycles burned so far. */
    this.burned = 0;
    /** Cycle since vblank at which this clock started. */
    this.frame0 = free ? 0 : clockOf(m).t;
  }

  /** Every cycle counted since the clock was made. */
  get abs() { return this.burned + this.t; }
}

/**
 * A clock that never yields (plain use of clocked code).
 * @param {Machine} m
 * @returns {Clock}
 */
export const freeClock = (m) => new Clock(m, true);

/**
 * Burn the collected cycles on the machine's foreground clock (yielding
 * at frame boundaries) before an observable access.
 * @param {Clock} c
 * @returns {Generator<unknown, void, unknown>}
 */
export function* sync(c) {
  const n = c.t;
  if (n === 0) return;
  c.t = 0;
  c.burned += n;
  if (!c.free) yield* burn(c.m, n);
}

/**
 * Advance the clock to `abs` cycles after it was made, burning on the
 * way; no-op if it is already there or later.
 * @param {Clock} c @param {number} abs
 * @returns {Generator<unknown, void, unknown>}
 */
export function* advanceTo(c, abs) {
  if (c.abs < abs) c.t += abs - c.abs;
  yield* sync(c);
}

/**
 * Run a free-clock generator (which cannot wait) to its end.
 * @template T
 * @param {Generator<unknown, T, unknown>} g
 * @returns {T}
 */
export function runFree(g) {
  const r = g.next();
  if (!r.done) throw new Error('gp2_4: a free-clock routine yielded');
  return r.value;
}

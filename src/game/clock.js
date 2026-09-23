// Copyright 2026 by Moshix
/**
 * The main CPU's foreground cycle clock, shared by every busy foreground
 * routine of the main CPU (the boot in gp2-2b, delay_65536 and the
 * service mode in gp2-4). Moved here from gp2_2b_state.js at main-E's
 * request (docs/requests/main-E.md 1); that file re-exports it.
 *
 * The boot (reset_main, $E000) runs with the main IRQ off and burns real
 * time: RAM clears with a watchdog read per word, and delay_65536 ($BE25,
 * 787,734 cycles = 31.08 frames) between I/O chip commands. The port has
 * to spend the same number of frames there, and every write must land in
 * the same frame as on the board. So the foreground keeps a cycle clock
 * `t`: main-CPU cycles since the current frame's vblank. burn(m, n)
 * advances it and yields (a plain `yield`: "the frame ended", which the
 * scheduler treats as a wait for the next vblank) once for every frame
 * boundary crossed. An instruction belongs to the frame in which it
 * STARTS (the oracle's core runs whole instructions), so callers burn the
 * cycles up to the start of the instruction that writes, then write.
 *
 * THE SCHEDULER. burn() also charges the cycles to the main CPU
 * (`m.charge`), so the scheduler (scheduler.js) knows when in the frame
 * each boot write happens -- the SRESET release at frame 96, cycle
 * 17,095, starts the sub and sound CPUs then, not at the frame's start.
 * It charges up to the boundary, yields, and charges the rest after, so
 * the scheduler's clock and this one cross the frame together (a plain
 * `yield` there costs nothing more: the CPU is already at the vblank).
 * setClock() re-aligns the scheduler's main CPU clock too, through the
 * setter the scheduler registers with {@link bindClock}.
 * @see docs/porting-guide.md section 6.3
 */

/** @typedef {import('../machine/machine.js').Machine} Machine */

/** Main-CPU cycles per video frame (1.536 MHz / 60.606 Hz). */
export const FRAME_CYCLES = 25344;

/**
 * Yield marker: "busy-waiting on another CPU's foreground" (the same
 * registered symbol as scheduler.js SPIN).
 */
export const SPIN = Symbol.for('gaplus.SPIN');

/**
 * @typedef {object} FgClock
 * @property {number} t cycles since the current frame began (vblank)
 * @property {number} frames frames the clock has yielded in total
 */

/** @type {WeakMap<Machine, FgClock>} */
const CLOCKS = new WeakMap();

/**
 * The main foreground's cycle clock for this machine (created at 0).
 * @param {Machine} m
 * @returns {FgClock}
 */
export function clockOf(m) {
  let c = CLOCKS.get(m);
  if (c === undefined) {
    c = { t: 0, frames: 0 };
    CLOCKS.set(m, c);
  }
  return c;
}

/**
 * Set the clock: after a wait whose end the port cannot time (a poll of
 * another CPU, a CWAI), the clock is re-synchronised to the cycle at
 * which the oracle's main CPU leaves the wait (measured, see callers).
 * @param {Machine} m
 * @param {number} t cycles since vblank
 */
export function setClock(m, t) {
  clockOf(m).t = t;
  BOUND.get(m)?.(t);
}

/** @type {WeakMap<Machine, (t: number) => void>} */
const BOUND = new WeakMap();

/**
 * The scheduler registers how to set its main CPU clock to `t` cycles
 * after the current frame's vblank (setClock calls it).
 * @param {Machine} m @param {(t: number) => void} set
 */
export function bindClock(m, set) {
  BOUND.set(m, set);
}

/**
 * Spend `cycles` main-CPU cycles: advance the clock and yield once per
 * frame boundary passed. Call it with the cycles up to the START of the
 * next instruction that has an observable effect, then perform it.
 * @param {Machine} m
 * @param {number} cycles
 * @returns {Generator<undefined, void, unknown>}
 */
export function* burn(m, cycles) {
  const c = clockOf(m);
  let left = cycles;
  // Charge to each frame boundary, then yield there.
  while (c.t + left >= FRAME_CYCLES) {
    const step = FRAME_CYCLES - c.t;
    m.charge(step);
    left -= step;
    c.t = 0;
    c.frames += 1;
    yield;
  }
  m.charge(left);
  c.t += left;
}

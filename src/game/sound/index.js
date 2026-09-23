// Copyright 2026 by Moshix
/**
 * The sound CPU as the scheduler drives it: imports every chip module of
 * the CPU (so every routine is registered) and exports its entry points.
 * @see docs/porting-guide.md section 2
 */

import './gp2_1.js';
import { SOUND } from './routines.js';

/** @typedef {import('../scheduler.js').CpuEntries} CpuEntries */

/**
 * reset_sound ($E000) and irq_sound ($E055), looked up when called.
 * @type {CpuEntries}
 */
export const soundCpu = {
  reset: (m) => /** @type {Generator<unknown, unknown, unknown>} */ (
    SOUND.reset_sound(m)),
  irq: (m) => SOUND.irq_sound(m),
};

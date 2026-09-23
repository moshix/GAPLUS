// Copyright 2026 by Moshix
/**
 * The sub CPU as the scheduler drives it: loads every chip module of the
 * CPU (gp2-8 $A000, gp2-7 $C000, gp2-6 $E000), so every routine is
 * registered in SUB / SUB_AT, and exports its entry points. Missing or
 * broken chip modules are reported in `chipReport` (see main/index.js).
 * @see docs/porting-guide.md section 2
 */

import { SUB } from './routines.js';
import { loadChips } from '../chips.js';

/** @typedef {import('../scheduler.js').CpuEntries} CpuEntries */

/** Chip modules missing or broken (porting in progress). */
export const chipReport = await loadChips([
  () => import('./gp2_8.js'),
  () => import('./gp2_7.js'),
  () => import('./gp2_6.js'),
], ['gp2_8.js', 'gp2_7.js', 'gp2_6.js']);

/**
 * reset_sub ($E000, a generator) and irq_sub ($E061), or null while
 * they are not ported.
 * @type {CpuEntries}
 */
export const subCpu = {
  get reset() {
    const f = SUB.reset_sub;
    return f === undefined ? null
      : (m) => /** @type {Generator<unknown, unknown, unknown>} */ (f(m));
  },
  get irq() {
    const f = SUB.irq_sub;
    return f === undefined ? null : (m) => f(m);
  },
};

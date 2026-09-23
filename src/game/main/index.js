// Copyright 2026 by Moshix
/**
 * The main CPU as the scheduler drives it: loads every chip module of the
 * CPU (gp2-4 $A000, gp2-3b $C000, gp2-2b $E000), so every routine is
 * registered in MAIN / MAIN_AT, and exports its entry points.
 *
 * During the porting phase a chip module may not exist yet (or not load),
 * so the modules are loaded with dynamic imports that report such files
 * in `chipReport` instead of failing (src/game/chips.js).
 * The entry points are then null, and whoever builds the scheduler
 * decides (src/game/port.js: "not ported"; tests: the fallback bridge).
 * @see docs/porting-guide.md section 2
 */

import { MAIN, mainAt } from './routines.js';
import { loadChips } from '../chips.js';
import { isGenerator } from '../call.js';
import { setClock } from '../clock.js';
import { takeJump, pendingJump } from './jump.js';
import { RESET_CYCLES, NO_RTI } from '../scheduler.js';

/** @typedef {import('../scheduler.js').CpuEntries} CpuEntries */

/** Chip modules missing or broken (porting in progress). */
export const chipReport = await loadChips([
  () => import('./gp2_4.js'),
  () => import('./gp2_3b.js'),
  () => import('./gp2_2b.js'),
], ['gp2_4.js', 'gp2_3b.js', 'gp2_2b.js']);

/**
 * A routine started as the foreground: generators as they are; a plain
 * function runs now and is then an empty generator (its end must be a
 * non-local jump, which the driver picks up).
 * @param {unknown} r what calling the routine returned
 * @returns {Generator<unknown, unknown, unknown>}
 */
function asThread(r) {
  if (isGenerator(r)) return r;
  return (function* ended() { return r; })();
}

/**
 * The main CPU's foreground driver, from the reset vector.
 *
 * It runs reset_main ($E000) and follows the ROM's non-local jumps
 * (src/game/main/jump.js): whenever it gets control back -- after the
 * foreground yields or returns, and when the scheduler resumes it after
 * an IRQ handler -- a pending jump target replaces the running foreground
 * (`.return()` on the old generator, `mainAt(target)` started in its
 * place, at once, as the 6809 jumps without waiting). The foreground
 * cycle clock (src/game/clock.js) starts at the reset vector fetch's 4
 * cycles, as reset_main expects (main-E: POWER_ON_CYCLE).
 * @see gaplus-main.asm $E000
 * @param {import('../../machine/machine.js').Machine} m
 * @returns {Generator<unknown, never, unknown>}
 */
export function* mainForeground(m) {
  setClock(m, RESET_CYCLES);
  const reset = MAIN.reset_main;
  if (reset === undefined) throw new Error('main CPU: reset_main not ported');
  let g = asThread(reset(m));
  for (;;) {
    const j = takeJump(m);
    if (j !== null) {
      g.return(undefined);
      g = asThread(mainAt(j)(m));
      continue;
    }
    const r = g.next();
    if (pendingJump(m) !== null) continue;
    if (r.done) {
      throw new Error('main CPU: foreground returned without a jump');
    }
    yield r.value;
  }
}

/**
 * irq_main ($C000). When it leaves through a jump ($C016 service_mode,
 * $C0A8 attract_loop: requestJump) there is no RTI: CC.I stays set
 * (NO_RTI) until the code jumped to clears it, and the driver
 * (mainForeground) starts that code.
 * @see gaplus-main.asm $C000
 * @param {import('../../machine/machine.js').Machine} m
 * @returns {Generator<unknown, unknown, unknown>}
 */
export function* mainIrq(m) {
  const r = MAIN.irq_main(m);
  if (isGenerator(r)) yield* r;
  return pendingJump(m) !== null ? NO_RTI : undefined;
}

/**
 * The main CPU's entry points: the foreground driver (reset_main and
 * the non-local jumps) and irq_main ($C000); null while not ported.
 * @type {CpuEntries}
 */
export const mainCpu = {
  get reset() {
    return MAIN.reset_main === undefined ? null : mainForeground;
  },
  get irq() {
    return MAIN.irq_main === undefined ? null : mainIrq;
  },
};

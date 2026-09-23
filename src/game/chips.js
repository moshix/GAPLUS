// Copyright 2026 by Moshix
/**
 * Loading a CPU's chip modules while some are still being written.
 *
 * src/game/{main,sub}/index.js import their chip modules through this, so
 * the port runs (and the lockstep test can bridge the rest) before every
 * chip exists. A missing file is tolerated and reported, and so is a
 * module that fails to load (a syntax error, a throw at import time).
 */

/**
 * Is `err` a "module not found" from Node or a browser?
 * @param {unknown} err @returns {boolean}
 */
export function isMissingModule(err) {
  if (!(err instanceof Error)) return false;
  const code = /** @type {{ code?: unknown }} */ (err).code;
  if (code === 'ERR_MODULE_NOT_FOUND') return true;
  // Browsers: "Failed to fetch dynamically imported module" (Chrome),
  // "error loading dynamically imported module" (Firefox), "Importing
  // a module script failed" (Safari).
  return /dynamically imported module|Importing a module script failed/i
    .test(err.message);
}

/**
 * What loading a CPU's chip modules gave.
 * @typedef {object} ChipReport
 * @property {string[]} missing files that do not exist yet
 * @property {Array<{ file: string, error: string }>} broken files that
 *   exist but failed to load (their routines are then not registered)
 */

/**
 * Import each module. A missing file is expected while porting; a module
 * that fails to load is reported too (not rethrown), so one porter's
 * half-written file cannot stop the others' work from running: the
 * lockstep tool prints `broken`, and the browser engine refuses to start
 * with it (src/game/port.js).
 * @param {Array<() => Promise<unknown>>} loaders
 * @param {string[]} names file name of each, for the report
 * @returns {Promise<ChipReport>}
 */
export async function loadChips(loaders, names) {
  /** @type {ChipReport} */
  const report = { missing: [], broken: [] };
  for (let i = 0; i < loaders.length; i += 1) {
    try {
      await loaders[i]();
    } catch (err) {
      if (isMissingModule(err)) report.missing.push(names[i]);
      else {
        const msg = err instanceof Error ? err.message : String(err);
        report.broken.push({ file: names[i], error: msg });
      }
    }
  }
  return report;
}

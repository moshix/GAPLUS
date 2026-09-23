// Copyright 2026 by Moshix
/**
 * Which JavaScript function implements each ROM routine of the main and
 * sub CPUs, for the listing cross-references (tools/gen-listing.mjs,
 * docs/disassembly-notes.md section 3).
 *
 * The port registers every routine in MAIN/MAIN_AT (SUB/SUB_AT) under the
 * name the listing had when it was ported (`sub_B0D4`, `lD9CF`, ...).
 * Later annotation passes rename listing labels, but never the JS
 * functions, so the listing prints the JS name wherever the two differ.
 *
 * For each CPU this loads the chip modules (through the CPU's index.js,
 * or each `gp2_*.js` if that fails), then walks `*_AT`:
 *
 *  - jsName: the key of the function in MAIN/SUB (the registry name other
 *    modules call it by), else the function's own name;
 *  - file: the source file whose text defines a function of that name
 *    (`function name(` / `function* name(`). If several files define one,
 *    the file whose module namespace exports that exact function object
 *    wins.
 *
 * The sound CPU is left out on purpose (being ported; its listing does
 * not depend on the JS yet).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** CPUs with JS cross-references, and their registry names. */
export const JS_CPUS = /** @type {const} */ ({
  main: { byName: 'MAIN', byAddr: 'MAIN_AT' },
  sub: { byName: 'SUB', byAddr: 'SUB_AT' },
});

/**
 * @typedef {object} JsRoutine
 * @property {string} jsName registry / export name
 * @property {string} file repository-relative path of the defining file
 */

/**
 * Collect address -> {jsName, file} for one CPU.
 * @param {'main'|'sub'} cpu
 * @returns {Promise<Map<number, JsRoutine>>}
 */
export async function loadJsRoutines(cpu) {
  const dir = join(ROOT, 'src', 'game', cpu);
  /** @type {Map<number, JsRoutine>} */
  const out = new Map();
  if (!existsSync(join(dir, 'routines.js'))) return out;
  const files = readdirSync(dir).filter((f) => /^gp2_.*\.js$/.test(f)).sort();
  // Registration: index.js loads every chip module (and tolerates missing
  // ones); if it cannot even be imported, load the chip files directly.
  try {
    await import(pathToFileURL(join(dir, 'index.js')).href);
  } catch {
    for (const f of files) {
      try { await import(pathToFileURL(join(dir, f)).href); } catch { /* skip */ }
    }
  }
  const reg = await import(pathToFileURL(join(dir, 'routines.js')).href);
  const names = JS_CPUS[cpu];
  /** @type {Record<string, Function>} */
  const byName = reg[names.byName];
  /** @type {Record<number, Function>} */
  const byAddr = reg[names.byAddr];

  // Source text and namespace of every gp2_* file (the namespace only to
  // break ties between files that define functions of the same name).
  /** @type {Array<{file: string, src: string, ns: Record<string, unknown>}>} */
  const mods = [];
  for (const f of files) {
    /** @type {Record<string, unknown>} */
    let ns = {};
    try { ns = await import(pathToFileURL(join(dir, f)).href); } catch { /* none */ }
    mods.push({ file: `src/game/${cpu}/${f}`, src: readFileSync(join(dir, f), 'utf8'), ns });
  }
  /**
   * A definition of `name`: `function name(`, `function* name(` or
   * `const name =` (routines built by a factory, e.g. setPicture()).
   * @param {string} name @returns {RegExp}
   */
  const defRe = (name) => new RegExp('(^|\\n)\\s*(export\\s+)?(async\\s+)?' +
    `(function\\s*\\*?\\s*${name}\\s*\\(|const\\s+${name}\\s*=)`);

  for (const [k, fn] of Object.entries(byAddr)) {
    if (typeof fn !== 'function') continue;
    const addr = Number(k);
    const keys = Object.keys(byName).filter((n) => byName[n] === fn);
    const jsName = keys.includes(fn.name) ? fn.name : keys[0] ?? fn.name;
    let cands = mods.filter((mm) => defRe(fn.name).test(mm.src));
    if (!cands.length) cands = mods.filter((mm) => defRe(jsName).test(mm.src));
    if (cands.length > 1) {
      const exact = cands.filter((mm) => Object.values(mm.ns).includes(fn));
      if (exact.length) cands = exact;
    }
    out.set(addr, { jsName, file: cands[0]?.file ?? '' });
  }
  return out;
}

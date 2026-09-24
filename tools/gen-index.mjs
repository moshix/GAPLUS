// Copyright 2026 by Moshix
/**
 * Regenerate the module lists inside index.html.
 *
 * The page rewrites every module URL with a per-load token so the browser
 * cannot serve a stale copy. An import map can only do that for module URLs it
 * lists by name, so the lists have to be complete -- hence generating them
 * from what is actually on disk rather than maintaining them by hand.
 *
 *   MODULES  every .js file under src/, relative to src/ -- including the
 *            MC6809 board emulator in src/emu/ that the ROM engine runs
 *
 * Usage: node tools/gen-index.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every file under `dir` with the extension, relative to `base`, sorted.
 * @param {string} dir @param {string} ext @param {string} base
 * @returns {string[]}
 */
function listFiles(dir, ext, base) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, ext, base));
    else if (entry.endsWith(ext)) out.push(relative(base, full).split('\\').join('/'));
  }
  return out.sort();
}

/** @param {string} [dir] @returns {string[]} src/ modules, relative to src/ */
export function listModules(dir = join(ROOT, 'src')) {
  return listFiles(dir, '.js', join(ROOT, 'src'));
}

/**
 * Replace the lines between `    /* NAME:BEGIN *\/` and `    /* NAME:END *\/`.
 * @param {string} html @param {string} name @param {string[]} paths
 * @returns {string}
 */
export function fillBlock(html, name, paths) {
  const start = `    /* ${name}:BEGIN */`;
  const end = `    /* ${name}:END */`;
  const begin = html.indexOf(start);
  const finish = html.indexOf(end);
  if (begin < 0 || finish < 0) throw new Error(`index.html is missing the ${name} markers`);
  const list = paths.map((p) => `      '${p}',\n`).join('');
  return `${html.slice(0, begin + start.length)}\n${list}${html.slice(finish)}`;
}

function main() {
  const path = join(ROOT, 'index.html');
  let html = readFileSync(path, 'utf8');
  const modules = listModules();
  html = fillBlock(html, 'MODULES', modules);
  writeFileSync(path, html);
  console.log(`index.html: ${modules.length} modules`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

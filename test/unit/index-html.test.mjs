// Copyright 2026 by Moshix
/**
 * index.html: the cache-busting import map must list every module the page
 * can load, and the markup must have a control for every action and engine.
 *
 * index.html mints a token per load and rewrites each module URL to carry
 * it, so the whole graph is refetched rather than served stale. An import map
 * can only do that for URLs it names, so a module missing from the list
 * silently loses its cache busting -- the page still works, the console is
 * clean, and yesterday's code runs. Two lists: MODULES (src/) and ORACLE
 * (test/m6809/, which the ROM engine loads).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listModules, listOracleModules } from '../../tools/gen-index.mjs';
import { ACTIONS } from '../../src/input/bindings.js';
import { ENGINE_KINDS } from '../../src/engine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');

/**
 * The paths a marker block of index.html lists.
 * @param {string} name MODULES or ORACLE @returns {string[]}
 */
function listed(name) {
  const start = `/* ${name}:BEGIN */`;
  const end = `/* ${name}:END */`;
  const begin = HTML.indexOf(start);
  const finish = HTML.indexOf(end);
  assert.ok(begin >= 0 && finish > begin, `index.html is missing the ${name} markers`);
  const block = HTML.slice(begin + start.length, finish);
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

for (const [name, onDisk, base] of /** @type {const} */ ([
  ['MODULES', listModules(), 'src'],
  ['ORACLE', listOracleModules(), '.'],
])) {
  test(`index.html ${name} lists exactly the modules on disk`, () => {
    const list = listed(name);
    const missing = onDisk.filter((p) => !list.includes(p));
    const stale = list.filter((p) => !onDisk.includes(p));
    assert.deepEqual(missing, [], 'run `node tools/gen-index.mjs` -- these are not listed');
    assert.deepEqual(stale, [], 'run `node tools/gen-index.mjs` -- these no longer exist');
  });

  test(`index.html ${name} is sorted, unique and resolvable`, () => {
    const list = listed(name);
    assert.deepEqual(list, [...list].sort(), 'gen-index.mjs emits them sorted');
    assert.equal(new Set(list).size, list.length, 'a duplicate would shadow itself in the map');
    for (const path of list) {
      assert.doesNotThrow(() => readFileSync(join(ROOT, base, path)),
        `index.html points at ${base}/${path}, which cannot be read`);
    }
  });
}

test('the ROM engine\'s board is in the ORACLE list', () => {
  assert.ok(listed('ORACLE').includes('test/m6809/board.mjs'));
});

test('every input action has a row in the remap dialog', () => {
  for (const action of ACTIONS) {
    assert.match(HTML, new RegExp(`<tr data-action="${action}">`), `no remap row for ${action}`);
  }
});

test('the chooser offers every engine, JavaScript marked in progress', () => {
  for (const kind of ENGINE_KINDS) {
    assert.match(HTML, new RegExp(`data-engine="${kind}"`), `no chooser option for ${kind}`);
  }
  const port = HTML.slice(HTML.indexOf('class="option" data-engine="port"'));
  assert.match(port.slice(0, 400), /in progress/);
  assert.match(port.slice(0, 400), /AI/, 'the JavaScript option mentions the AI');
});

test('the AI control starts disabled (JavaScript version only)', () => {
  const m = HTML.match(/<button[^>]*id="set-ai"[^>]*>/);
  assert.ok(m, 'no #set-ai button');
  assert.match(m[0], /disabled/);
  assert.match(m[0], /JavaScript version only/);
});

test('favicon.png exists and index.html links it', () => {
  assert.match(HTML, /<link rel="icon" type="image\/png" href="favicon.png">/);
  const png = readFileSync(join(ROOT, 'favicon.png'));
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47], 'PNG signature');
});

test('the key legend is short: move, fire, coin, start only', () => {
  const m = HTML.match(/<div id="hint">([\s\S]*?)<\/div>/);
  assert.ok(m, 'no #hint legend');
  const text = m[1].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, 'x').replace(/\s+/g, ' ').trim();
  assert.ok(text.length <= 48, `legend is ${text.length} characters: ${text}`);
  for (const word of ['move', 'fire', 'coin', 'start']) assert.match(text, new RegExp(word));
  // The rest lives on the settings buttons and in the "?" panel.
  for (const word of ['pause', 'sound', 'zoom', 'test', 'AI', 'joystick', 'engine']) {
    assert.doesNotMatch(text, new RegExp(word), `${word} belongs on a button or in help`);
  }
});

test('the "?" help panel lists every key', () => {
  const m = HTML.match(/<div id="help" hidden>([\s\S]*?)<\/div>/);
  assert.ok(m, 'no hidden #help panel');
  for (const key of ['space', '5', '6', '1', '2', 'P', 'M', '+', 'E', 'A', 'F2', '9', 'G', '?']) {
    assert.ok(m[1].includes(`<kbd>${key}</kbd>`), `help does not list ${key}`);
  }
  assert.match(HTML, /id="set-help"/);
});

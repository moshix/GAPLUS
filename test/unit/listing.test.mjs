// Copyright 2026 by Moshix
/**
 * Tests for the listing generator (tools/gen-listing.mjs) and the listings
 * it writes to reference/: every ROM byte appears exactly once, the bytes
 * and the FCB/FDB operands and the instruction mnemonics agree with the
 * ROM, the vectors land on labels, nothing is wider than 79 columns, the
 * output is deterministic and the files on disk are up to date. Also unit
 * checks of the annotation/coverage loaders and the text helpers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAll, CPUS, ROM_LO, MAX_COL, REF, decodeText, wrapText, canonRam,
  loadAnnotations, loadCoverage, looksLikeStrings,
} from '../../tools/gen-listing.mjs';
import { loadGaplus } from '../../tools/romset.mjs';
import { disasm } from '../../tools/m6809dis.mjs';

const roms = loadGaplus();
const built = buildAll();

/** @param {string} cpu @returns {string} */
const listingOf = (cpu) => /** @type {string} */ (built.files.get(join(REF, `gaplus-${cpu}.asm`)));

/** @type {Record<string, Record<string, number>>} */
const symbols = JSON.parse(/** @type {string} */ (built.files.get(join(REF, 'symbols.json'))));

/**
 * One listing line that carries ROM bytes.
 * @typedef {{addr: number, bytes: number[], op: string, arg: string, line: string}} Row
 */

/**
 * Parse the address/bytes/instruction lines of a listing.
 * @param {string} text @returns {Row[]}
 */
function rows(text) {
  /** @type {Row[]} */
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^([0-9A-F]{4}): ((?:[0-9A-F]{2} )*[0-9A-F]{2})  +(\S+)(?: +([^;]*?))?\s*(?:;.*)?$/.exec(line);
    if (!m) continue;
    out.push({
      addr: Number.parseInt(m[1], 16),
      bytes: m[2].split(' ').map((b) => Number.parseInt(b, 16)),
      op: m[3],
      arg: (m[4] ?? '').trim(),
      line,
    });
  }
  return out;
}

for (const cpu of CPUS) {
  const text = listingOf(cpu);
  const mem = roms[cpu];
  const lo = ROM_LO[cpu];
  const list = rows(text);

  test(`${cpu}: every ROM byte appears exactly once, equal to the ROM`, () => {
    const seen = new Uint8Array(0x10000);
    for (const r of list) {
      r.bytes.forEach((b, i) => {
        const a = r.addr + i;
        assert.ok(a >= lo && a <= 0xffff, `${r.line}: outside the ROM`);
        assert.equal(seen[a], 0, `$${a.toString(16)} listed twice`);
        seen[a] = 1;
        assert.equal(b, mem[a], `$${a.toString(16)}: listing ${b} vs ROM ${mem[a]}`);
      });
    }
    for (let a = lo; a <= 0xffff; a += 1) assert.equal(seen[a], 1, `$${a.toString(16)} missing`);
  });

  test(`${cpu}: FCB/FDB operands and mnemonics assemble to the bytes`, () => {
    const labels = symbols[cpu];
    /** @param {string} s @returns {number} */
    const value = (s) => {
      if (/^\$[0-9A-F]+$/.test(s)) return Number.parseInt(s.slice(1), 16);
      assert.ok(s in labels, `unknown label ${s}`);
      return labels[s];
    };
    for (const r of list) {
      if (r.op === 'FCB') {
        // Undocumented $10/$11 prefix pairs are listed as FCB code too.
        assert.deepEqual(r.arg.split(',').map(value), r.bytes, r.line);
      } else if (r.op === 'FDB') {
        const words = r.arg.split(',').map(value);
        const want = [];
        for (let i = 0; i < r.bytes.length; i += 2) want.push(r.bytes[i] << 8 | r.bytes[i + 1]);
        assert.deepEqual(words, want, r.line);
      } else {
        const ins = disasm((a) => mem[a], r.addr);
        assert.equal(ins.len, r.bytes.length, r.line);
        assert.equal(r.op, ins.text.split(/\s+/)[0], r.line);
      }
    }
  });

  test(`${cpu}: vectors land on labels`, () => {
    const names = new Set(text.split('\n').filter((l) => /^[A-Za-z_]\w*:$/.test(l)).map((l) => l.slice(0, -1)));
    for (let v = 0xfff2; v < 0x10000; v += 2) {
      const tgt = mem[v] << 8 | mem[v + 1];
      if (tgt < lo || tgt >= 0xfff0) continue; // $FFFF = unused vector
      const name = Object.entries(symbols[cpu]).find(([, a]) => a === tgt);
      assert.ok(name, `vector $${v.toString(16)} -> $${tgt.toString(16)} has no label`);
      assert.ok(names.has(name[0]), `label ${name[0]} not printed`);
    }
  });

  test(`${cpu}: no line is wider than ${MAX_COL} columns`, () => {
    text.split('\n').forEach((l, i) => {
      assert.ok(l.length <= MAX_COL, `line ${i + 1} is ${l.length} wide: ${l}`);
    });
  });

  test(`${cpu}: listing on disk is up to date`, () => {
    const path = join(REF, `gaplus-${cpu}.asm`);
    assert.ok(existsSync(path), 'run node tools/gen-listing.mjs');
    assert.equal(readFileSync(path, 'utf8'), text, 'stale: run node tools/gen-listing.mjs');
  });
}

test('output is deterministic', () => {
  const again = buildAll();
  for (const [path, text] of built.files) assert.equal(again.files.get(path), text, path);
});

test('symbols.json: shape and known entries', () => {
  for (const k of ['main', 'sub', 'sound', 'ram', 'io']) assert.equal(typeof symbols[k], 'object', k);
  assert.equal(symbols.main.reset_main, 0xe000);
  assert.equal(symbols.main.irq_main, 0xc000);
  assert.equal(symbols.sub.irq_sub, 0xe061);
  assert.equal(symbols.sound.irq_sound, 0xe055);
  assert.equal(symbols.ram.game_mode, 0x102f);
  assert.equal(symbols.ram.snd_request, 0x6040, 'sound RAM is named at main addresses');
  assert.equal(symbols.io.IO56XX, 0x6800);
  assert.equal(symbols.io.WATCHDOG, 0x7c00);
  const disk = join(REF, 'symbols.json');
  assert.equal(readFileSync(disk, 'utf8'), built.files.get(disk), 'symbols.json is stale');
});

test('the main state machine and sound tables were found', () => {
  const main = listingOf('main');
  assert.match(main, /^tasks_mode5:$/m);
  assert.match(main, /^FEC0: FE D4 +FDB {4}tasks_mode0 /m);
  const sub = listingOf('sub');
  assert.match(sub, /^sub_mode_task_lists:$/m);
  assert.ok(built.stats.main.tables >= 20);
  assert.ok(built.stats.sound.code > 900);
});

test('decodeText maps the game font', () => {
  assert.equal(decodeText([0x47, 0x41, 0x4d, 0x45, 0x20, 0x4f, 0x56, 0x45, 0x52]), 'GAME OVER');
  assert.equal(decodeText([0x31, 0x3b, 0x5b, 0x3f, 0xc1]), '1-.?A');
  assert.equal(decodeText([0x7f]), '{7F}');
});

test('looksLikeStrings accepts zero-terminated text only', () => {
  const buf = [0x50, 0x41, 0x52, 0x00, 0x31, 0x32, 0x00, 0x05, 0x00];
  const rd = (/** @type {number} */ a) => buf[a];
  assert.equal(looksLikeStrings(rd, 0, 7), true);
  assert.equal(looksLikeStrings(rd, 0, 9), false, '$05 is not text');
  assert.equal(looksLikeStrings(rd, 0, 6), false, 'no terminator');
});

test('wrapText keeps words within the width', () => {
  const parts = wrapText('one two three four five six', 9);
  assert.deepEqual(parts, ['one two', 'three', 'four five', 'six']);
  for (const p of wrapText('x'.repeat(30), 8)) assert.ok(p.length <= 8);
});

test('canonRam maps sound RAM to main addresses', () => {
  assert.equal(canonRam('sound', 0x0040), 0x6040);
  assert.equal(canonRam('sound', 0x2000), 0x2000);
  assert.equal(canonRam('main', 0x1016), 0x1016);
});

test('annotation and coverage loaders read their documented formats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gaplus-listing-'));
  writeFileSync(join(dir, 'sub.json'), JSON.stringify({
    default_dp: '10',
    labels: { E000: 'boot', E061: { name: 'irq', doc: ['x'], entry: true, dp: '10' } },
    comments: { E000: 'hello' },
    data: [{ addr: 'F000', end: 'F00F', type: 'bytes', name: 'tbl' }],
    tables: { F100: { count: 3 } },
    ram: { 1016: { name: 'frames', size: 1 } },
  }));
  const ann = loadAnnotations('sub', dir);
  assert.equal(ann.defaultDp, 0x10);
  assert.equal(ann.labels.get(0xe000)?.name, 'boot');
  assert.equal(ann.labels.get(0xe061)?.entry, true);
  assert.equal(ann.labels.get(0xf000)?.name, 'tbl');
  assert.deepEqual([ann.data[0].lo, ann.data[0].hi], [0xf000, 0xf010]);
  assert.equal(ann.tables.get(0xf100)?.count, 3);
  assert.equal(ann.ram.get(0x1016)?.name, 'frames');

  writeFileSync(join(dir, 'main.json'), JSON.stringify({ executed: ['C000', 49153], dp: { C000: '10' } }));
  const cov = loadCoverage('main', dir);
  assert.deepEqual(cov.addrs, [0xc000, 0xc001]);
  assert.equal(cov.dp.get(0xc000), 0x10);
  writeFileSync(join(dir, 'sound.json'), JSON.stringify(['E000']));
  assert.deepEqual(loadCoverage('sound', dir).addrs, [0xe000]);
  assert.deepEqual(loadCoverage('sub', join(dir, 'none')).addrs, []);
});

test('coverage roots add code the static trace missed', () => {
  // $D04C in the main ROM is code nothing reaches statically.
  const dir = mkdtempSync(join(tmpdir(), 'gaplus-cov-'));
  writeFileSync(join(dir, 'main.json'), JSON.stringify({ executed: ['D04C'] }));
  const withCov = buildAll({ covDir: dir });
  const t = withCov.results.main.trace;
  assert.ok(t.ins.has(0xd04c), 'coverage address traced');
  assert.ok(t.coverageOnly.has(0xd04c));
  assert.ok(withCov.stats.main.code > built.stats.main.code);
  assert.match(/** @type {string} */ (withCov.files.get(join(REF, 'gaplus-main.asm'))),
    /Found by the coverage input only/);
});

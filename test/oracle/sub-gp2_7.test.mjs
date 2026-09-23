// Copyright 2026 by Moshix
/**
 * ROM gp2-7.11c (sub CPU $C000-$DFFF) holds no code, only the enemy
 * flight-path streams. These tests pin down that claim and the stream
 * format of src/game/sub/gp2_7_paths.js against the ROM bytes, the
 * listing's symbols, the oracle's coverage file, and every ROM operand and
 * table that points into the chip. The runtime check (which instruction
 * reads which byte on the real ROM) is sub-gp2_7-trace.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../tools/romset.mjs';
import { subRom, subWord, mainWord } from '../../src/game/romdata.js';
import { SUB_AT } from '../../src/game/sub/routines.js';
import {
  GP2_7_START, STREAMS_END, COPYRIGHT, COPYRIGHT_LEN, CHECKSUM,
  HEADING_MAX, HEADING_TABLE, decodeStream, gp2_7Streams, gp2_7ByteKinds,
} from '../../src/game/sub/gp2_7.js';

/** @param {number} v @returns {string} */
const hex = (v) => `$${v.toString(16).toUpperCase().padStart(4, '0')}`;
const inChip = (/** @type {number} */ a) => a >= 0xc000 && a < 0xe000;

const streams = gp2_7Streams();
const starts = new Set(streams.map((s) => s.start));
const kinds = gp2_7ByteKinds();

/** @param {string} rel @returns {Record<string, unknown>} */
function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}

test('no routine: coverage, listing and registries agree', async (t) => {
  // Every sub chip module registers into SUB_AT; none may claim an address
  // in this chip. Load the CPU's index.js once it exists, else each chip
  // module (gp2_6.js, gp2_7.js, gp2_8.js). A module another porter is
  // still writing may not load yet: that is reported, not failed here.
  const dir = join(ROOT, 'src/game/sub');
  const files = readdirSync(dir);
  const mods = files.includes('index.js') ? ['index.js']
    : files.filter((n) => /^gp2_\d\.js$/.test(n));
  for (const f of mods) {
    try {
      await import(join(dir, f));
    } catch (e) {
      t.diagnostic(`${f} not loadable yet: ${String(e).slice(0, 50)}`);
    }
  }
  for (const k of Object.keys(SUB_AT)) {
    assert.ok(!inChip(Number(k)), `SUB_AT has ${hex(Number(k))}`);
  }
  const cov = readJson('reference/coverage/sub.json');
  const exec = (cov.exec ?? cov.executed).map(
    (/** @type {number|string} */ a) => (typeof a === 'string'
      ? parseInt(a, 16) : a));
  assert.deepEqual(exec.filter(inChip), [], 'instructions ran in $C000+');
  // The listing labels in the chip are data labels only.
  const sym = readJson('reference/symbols.json');
  const labels = Object.entries(sym.sub).filter(([, a]) => inChip(a));
  for (const [name] of labels) {
    // Data labels only: generated dat_, the named path streams (path_XXXX)
    // and the second copyright string.
    assert.match(name, /^(dat_|checksum_|path_|str_)/, `code label ${name}`);
  }
});

test('46 streams tile $C000-$DEFA exactly', () => {
  assert.equal(streams.length, 46);
  assert.equal(streams[0].start, GP2_7_START);
  for (let i = 1; i < streams.length; i += 1) {
    assert.equal(streams[i].start, streams[i - 1].cmd + 3);
  }
  assert.equal(streams[streams.length - 1].cmd + 3, STREAMS_END);
  const ops = { end: 0, jump: 0, jumpClear: 0 };
  for (const s of streams) ops[s.op] += 1;
  assert.deepEqual(ops, { end: 15, jump: 15, jumpClear: 16 });
});

test('headings index dat_AAFF, which has exactly $B4 entries', () => {
  let max = 0;
  for (const s of streams) {
    assert.ok(s.headings.length > 0, `empty stream ${hex(s.start)}`);
    for (const h of s.headings) max = Math.max(max, h);
  }
  assert.equal(max, HEADING_MAX);
  // heading_table (dat_AAFF) ends where the listing's next table,
  // formation_path (dat_ADCF), starts.
  const sym = readJson('reference/symbols.json');
  assert.equal(sym.sub.heading_table, HEADING_TABLE);
  assert.equal(HEADING_TABLE + 4 * (HEADING_MAX + 1), sym.sub.formation_path);
});

test('end records point back at their own stream', () => {
  for (const s of streams.filter((x) => x.op === 'end')) {
    assert.equal(s.word, s.start, `back-pointer at ${hex(s.cmd + 1)}`);
  }
});

test('jump targets are stream starts (or one gp2-8 stream)', () => {
  for (const s of streams.filter((x) => x.op !== 'end')) {
    if (inChip(s.word)) {
      assert.ok(starts.has(s.word), `${hex(s.cmd)} -> ${hex(s.word)}`);
      continue;
    }
    // Only $C0E6 leaves the chip: FF A4 4B, into gp2-8's path data. That
    // stream shares its first 151 headings with $C000 and ends at $A570
    // with F0 A4 4B (its own back-pointer).
    assert.equal(s.cmd, 0xc0e6);
    assert.equal(s.word, 0xa44b);
    const a = decodeStream(s.word);
    assert.equal(a.op, 'end');
    assert.equal(a.cmd, 0xa570);
    assert.equal(a.word, 0xa44b);
    assert.deepEqual(a.headings.slice(0, 151), s.headings.slice(0, 151));
    assert.notEqual(a.headings[151], s.headings[151]);
    assert.ok(a.headings.every((h) => h <= HEADING_MAX));
  }
});

test('copyright, fill and checksum', () => {
  let text = '';
  for (let i = 0; i < COPYRIGHT_LEN; i += 1) {
    text += String.fromCharCode(subRom(COPYRIGHT + i));
  }
  assert.equal(text, '1984 NAMCO ALL RIGHTS RESERVED');
  for (let a = COPYRIGHT + COPYRIGHT_LEN; a < 0xe000; a += 1) {
    if (a !== CHECKSUM) assert.equal(subRom(a), 0xff, hex(a));
  }
  assert.equal(subRom(CHECKSUM), 0xb7);
  // reset_sub $E02B: adda ,x+ over the chip must end with A = 0.
  let sum = 0;
  for (let a = 0xc000; a < 0xe000; a += 1) sum += subRom(a);
  assert.equal(sum & 0xff, 0);
});

test('bytes the coverage saw read are headings, commands, targets', () => {
  const cov = readJson('reference/coverage/sub.json');
  const read = cov.dataRead.filter(inChip);
  assert.ok(read.length > 4000, `only ${read.length} bytes read`);
  for (const a of read) {
    const k = kinds[a - GP2_7_START];
    assert.ok(k === 'heading' || k === 'cmd' || k === 'target',
      `${hex(a)} is ${k}`);
  }
  // Nothing reads a back-pointer, the text or the fill.
  const idle = kinds.filter((k) => k === 'backptr' || k === 'text').length;
  assert.equal(idle, 15 * 2 + COPYRIGHT_LEN);
});

/**
 * Every place a ROM holds a pointer into the chip that was checked by
 * hand in the listings, as [cpu, operand/entry address, count].
 * @type {Array<['sub'|'main', number, number, string]>}
 */
const POINTERS = [
  ['sub', 0xe01b, 1, 'reset_sub cmpx #$C000 (checksum end)'],
  ['sub', 0xf10c, 1, 'sub_F0ED ldd #$C000 -> $1854-$1857'],
  ['sub', 0xf5f1, 1, 'sub_F5A5 ldd #$C000 -> $1854/$1856'],
  ['sub', 0xf0ff, 1, 'sub_F0ED ldd #$C0E9 -> $184C-$1853'],
  ['sub', 0xb2a9, 1, 'sub_B242 ldd #$DD44 -> [$108C]'],
  ['sub', 0xbe08, 1, 'sub_BD56 ldd #$DADC -> $09D0,u'],
  ['sub', 0xbe47, 1, 'sub_BD56 ldd #$DADC -> $09D0,u'],
  ['sub', 0xfbe8, 1, 'sub_FBB3 ldu #$DD44'],
  ['sub', 0xfcde, 1, 'sub_FCA9 ldu #$DD44'],
  ['sub', 0xfdd2, 1, 'sub_FD59 ldy #$DD44'],
  ['sub', 0xbebd, 8, 'dat_BEBD: per stage & 7 ($D936)'],
  ['sub', 0xbecd, 8, 'dat_BECD: per stage & 7 ($DA09)'],
  ['sub', 0xfe19, 12, 'dat_FE01+$18: sub_FD59 ldy $18,u'],
  ['main', 0xb2d8, 1, 'main ldd #$C000 -> $1854'],
  ['main', 0xf266, 32, 'dat_F266: load_stage_params -> $1052-$1059'],
];

test('every hand-checked ROM pointer into the chip is a stream start', () => {
  let n = 0;
  for (const [cpu, at, count, what] of POINTERS) {
    for (let i = 0; i < count; i += 1) {
      const w = cpu === 'sub' ? subWord(at + 2 * i) : mainWord(at + 2 * i);
      assert.ok(starts.has(w), `${what}: ${hex(w)} at ${hex(at + 2 * i)}`);
      n += 1;
    }
  }
  assert.equal(n, 71);
});

test('decodeStream agrees with the walk, also mid-stream', () => {
  // Each stream decodes the same from its start as in the linear walk.
  for (const s of streams) assert.deepEqual(decodeStream(s.start), s);
  // Entered mid-stream (the stepper never does, but a pointer could), the
  // decoder just sees a shorter stream with the same end.
  const s = streams[3];
  const mid = decodeStream(s.start + 5);
  assert.equal(mid.cmd, s.cmd);
  assert.deepEqual(mid.headings, s.headings.slice(5));
});

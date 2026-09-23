// Copyright 2026 by Moshix
// Unit tests for the port's shared game infrastructure: romdata.js (and
// its freshness against the ROM set), the routine registries, call().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  romByte, romWord, mainRom, subRom, soundRom, mainWord, subWord,
  soundWord, ROM_BASE, isRom, isData,
} from '../../src/game/romdata.js';
import { MAIN, MAIN_AT, mainAt } from '../../src/game/main/routines.js';
import { SUB, SUB_AT, subAt } from '../../src/game/sub/routines.js';
import { SOUND, SOUND_AT, soundAt } from '../../src/game/sound/routines.js';
import { call, isGenerator } from '../../src/game/call.js';
import { loadGaplus } from '../../tools/romset.mjs';
import { buildRomdataSource, OUT } from '../../tools/gen-romdata.mjs';

const ROMS = loadGaplus();

test('romdata.js is up to date (node tools/gen-romdata.mjs)', () => {
  assert.equal(readFileSync(OUT, 'utf8'), buildRomdataSource(ROMS));
});

test('romdata: every ROM byte at its CPU address', () => {
  assert.deepEqual({ ...ROM_BASE }, { main: 0xa000, sub: 0xa000, sound: 0xe000 });
  for (const cpu of ['main', 'sub', 'sound']) {
    for (let a = ROM_BASE[cpu]; a <= 0xffff; a += 1) {
      if (romByte(cpu, a) !== ROMS[cpu][a]) assert.fail(`${cpu} $${a.toString(16)}`);
    }
    assert.equal(isRom(cpu, ROM_BASE[cpu]), true);
    assert.equal(isRom(cpu, ROM_BASE[cpu] - 1), false);
    assert.equal(isData(cpu, 0xffff), true, 'bring-up: all bytes are data');
    assert.throws(() => romByte(cpu, ROM_BASE[cpu] - 1), /not ROM/);
  }
  assert.equal(mainRom(0xe000), 0x1a); // ORCC #$10
  assert.equal(subRom(0xe006), 0x10);  // LDS #$1D80
  assert.equal(soundRom(0xe047), 0x10); // LDS #$0400
});

test('romdata: words are big-endian; wrapping past $FFFF throws', () => {
  assert.equal(romWord('main', 0xfffe), 0xe000);
  assert.equal(mainWord(0xfff8), 0xc000);
  assert.equal(subWord(0xfffe), 0xe000);
  assert.equal(soundWord(0xfff8), 0xe055);
  assert.throws(() => romWord('main', 0xffff), /not ROM/);
});

test('romdata: a data mask makes code bytes throw', async () => {
  // Build a variant with only main $A000 marked as data and load it.
  const mask = new Uint8Array(0x6000 / 8);
  mask[0] = 1;
  const src = buildRomdataSource(ROMS, { main: mask });
  const url = `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
  const r = await import(url);
  assert.equal(r.romByte('main', 0xa000), ROMS.main[0xa000]);
  assert.throws(() => r.romByte('main', 0xa001), /code, not data/);
  assert.equal(r.isData('main', 0xa001), false);
  assert.equal(r.romByte('sub', 0xa001), ROMS.sub[0xa001], 'no mask = all data');
});

test('registries: by name and address; a missing address throws', () => {
  for (const [NAMES, AT, at, cpu] of [[MAIN, MAIN_AT, mainAt, 'main'],
    [SUB, SUB_AT, subAt, 'sub'], [SOUND, SOUND_AT, soundAt, 'sound']]) {
    const f = () => 42;
    Object.assign(NAMES, { sub_FFF0: f });
    Object.assign(AT, { 0xfff0: f });
    assert.equal(at(0xfff0), f);
    assert.equal(NAMES.sub_FFF0(), 42);
    assert.throws(() => at(0xfff1),
      new RegExp(`^Error: ${cpu} CPU: no routine registered at \\$FFF1$`));
    delete NAMES.sub_FFF0;
    delete AT[0xfff0];
  }
});

test('call(): plain functions and generators alike', () => {
  const plain = (m, r) => ({ a: r.a + 1 });
  function* waits(m, r) {
    yield;
    yield 'x';
    return { a: r.a + 2 };
  }
  function* fg() {
    const p = yield* call(plain, null, { a: 1 });
    const g = yield* call(waits, null, { a: 1 });
    return [p.a, g.a];
  }
  const it = fg();
  const seen = [];
  let s = it.next();
  while (!s.done) { seen.push(s.value); s = it.next(); }
  assert.deepEqual(seen, [undefined, 'x']);
  assert.deepEqual(s.value, [2, 3]);
  assert.equal(isGenerator(waits()), true);
  assert.equal(isGenerator(plain(null, { a: 0 })), false);
  assert.equal(isGenerator(null), false);
});

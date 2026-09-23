// Copyright 2026 by Moshix
/**
 * The page's pure parts, in plain Node: the shared ROM layout and the
 * browser ROM loader, the engine interface (ROM engine on the real oracle
 * board, the port placeholder, the engine choice), the switch helpers, the
 * 8-way bindings, the input mux, the chooser's selection stepping and the
 * favicon. The DOM layer is covered by test/browser/smoke.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadGaplus, readChips, CHIPS as ROMSET_CHIPS } from '../../tools/romset.mjs';
import { CHIPS, crc32, layoutGaplus, verifyChip } from '../../src/dev/romlayout.js';
import { fetchRoms, RomFetchError } from '../../src/dev/romfetch.js';
import {
  createEngine, parseEngineKind, engineKindFrom, loadEngineChoice, saveEngineChoice,
  copyInputs, PortEngine, EmulatedEngine, ENGINE_KEY, ROM_LABEL, romHelp,
} from '../../src/engine.js';
import { createInputState, inputPorts } from '../../src/machine/namcoio.js';
import {
  setSwitch, releaseAll, testSwitch, setTestSwitch, SWITCH_NAMES,
} from '../../src/input/switches.js';
import {
  ACTIONS, MACHINE_INPUT, DEFAULT_BINDINGS, activeActions, normalizeBindings, assignBinding,
} from '../../src/input/bindings.js';
import { InputMux } from '../../src/input/mux.js';
import { stepIndex } from '../../src/ui/chooser.js';
import { faviconPixels } from '../../tools/gen-favicon.mjs';
import { encodePng } from '../../tools/png.mjs';

const ROM_DIR = join(ROOT, 'roms');
const HAVE_ROMS = CHIPS.every((c) => existsSync(join(ROM_DIR, c.name)));
const needRoms = { skip: HAVE_ROMS ? false : 'roms/ not present' };

/**
 * A fetch() that serves files from the project root, like the static
 * server does; `drop` names files to answer 404 for.
 * @param {Set<string>} [drop]
 * @returns {import('../../src/dev/romfetch.js').FetchLike}
 */
function diskFetch(drop = new Set()) {
  return async (url) => {
    const name = url.split('/').pop() ?? '';
    const path = join(ROOT, url);
    if (drop.has(name) || !existsSync(path)) {
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const buf = readFileSync(path);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
    };
  };
}

// ------------------------------------------------------------ ROM layout

test('romset.mjs re-exports the shared chip table', () => {
  assert.equal(ROMSET_CHIPS, CHIPS);
  assert.equal(CHIPS.length, 20);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('verifyChip rejects a wrong size and a wrong CRC', () => {
  const chip = CHIPS[0];
  assert.throws(() => verifyChip(chip, new Uint8Array(3), 'x'), /3 bytes, expected 8192/);
  assert.throws(() => verifyChip(chip, new Uint8Array(chip.size), 'x'), /CRC32/);
});

test('browser loader lays the chips out exactly as romset.mjs', needRoms, async () => {
  const fromDisk = loadGaplus();
  const fetched = await fetchRoms({ fetch: diskFetch() });
  for (const key of ['main', 'sub', 'sound', 'gfx1', 'gfx2', 'proms', 'wave', 'pal']) {
    assert.deepEqual(fetched[key], fromDisk[key], key);
  }
  assert.deepEqual(layoutGaplus(readChips()).main, fromDisk.main);
});

test('browser loader names the missing chips', async () => {
  const drop = new Set(['gp2-4.8d', 'gp2-1.4b']);
  await assert.rejects(fetchRoms({ fetch: diskFetch(drop), base: 'roms/' }), (err) => {
    assert.ok(err instanceof RomFetchError);
    if (HAVE_ROMS) assert.deepEqual(err.missing, ['gp2-1.4b', 'gp2-4.8d']);
    assert.match(err.message, /not found under roms\//);
    return true;
  });
  // A network error counts as missing too.
  const broken = async () => { throw new Error('offline'); };
  await assert.rejects(fetchRoms({ fetch: broken }), (err) => {
    assert.ok(err instanceof RomFetchError);
    assert.equal(err.missing.length, CHIPS.length);
    return true;
  });
});

// --------------------------------------------------------------- engines

test('engine names: URL, aliases, stored choice', () => {
  assert.equal(parseEngineKind('rom'), 'rom');
  assert.equal(parseEngineKind('ROM'), 'rom');
  assert.equal(parseEngineKind('emulated'), 'rom');
  assert.equal(parseEngineKind('port'), 'port');
  assert.equal(parseEngineKind('js'), 'port');
  assert.equal(parseEngineKind('mame'), null);
  assert.equal(engineKindFrom('?engine=port&frames=3'), 'port');
  assert.equal(engineKindFrom('?frames=3'), null, 'no engine named: show the chooser');

  /** @type {Map<string, string>} */
  const map = new Map();
  const store = {
    getItem: (/** @type {string} */ k) => map.get(k) ?? null,
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => { map.set(k, v); },
  };
  assert.equal(loadEngineChoice(store), 'rom', 'default');
  assert.equal(saveEngineChoice(store, 'port'), true);
  assert.equal(map.get(ENGINE_KEY), 'port');
  assert.equal(loadEngineChoice(store), 'port');
  map.set(ENGINE_KEY, 'garbage');
  assert.equal(loadEngineChoice(store), 'rom');

  // Storage that throws (privacy mode) or is missing never breaks the page.
  const hostile = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
  };
  assert.equal(loadEngineChoice(hostile), 'rom');
  assert.equal(saveEngineChoice(hostile, 'rom'), false);
  assert.equal(loadEngineChoice(null), 'rom');
  assert.equal(saveEngineChoice(null, 'rom'), false);
});

test('copyInputs copies every switch and DIP in place', () => {
  const from = createInputState();
  const to = createInputState();
  const p1 = to.p1;
  setSwitch(from, 'up', true);
  setSwitch(from, 'coin1', true);
  setSwitch(from, 'fire1', true);
  setTestSwitch(from, true);
  copyInputs(from, to);
  assert.equal(to.p1, p1, 'nested objects are kept (the I/O chips hold them)');
  assert.deepEqual(inputPorts(to), inputPorts(from));
});

test('port engine: not ready yet, takes the AI, says so', async () => {
  const engine = await createEngine('port');
  assert.ok(engine instanceof PortEngine);
  assert.equal(engine.ready, false);
  assert.match(engine.why, /port not ready yet/);
  assert.match(engine.why, /ROM version/);
  assert.equal(engine.supportsAi, true);
  assert.equal(engine.mem.length, 0x10000);
  assert.equal(engine.soundRegs().length, 0x40);
  engine.runFrame(createInputState());
});

test('ROM engine without ROMs: not ready, with directions', async () => {
  const engine = await createEngine('rom', { fetch: diskFetch(new Set(['gp2-5.8s'])) });
  assert.ok(engine instanceof EmulatedEngine);
  assert.equal(engine.ready, false);
  assert.match(engine.why, /roms\//);
  assert.match(engine.why, /http\.server/);
  assert.equal(engine.supportsAi, false);
  assert.equal(engine.mem.length, 0x10000, 'draws blank memory');
  engine.runFrame(createInputState());
  assert.match(romHelp(new Error('boom')), /boom/);
});

test('ROM engine runs the real program on the oracle board', needRoms, async () => {
  const engine = await createEngine('rom', { fetch: diskFetch() });
  assert.ok(engine instanceof EmulatedEngine);
  assert.equal(engine.ready, true, engine.why);
  assert.equal(engine.label, ROM_LABEL);
  assert.equal(engine.supportsAi, false, 'the AI never drives the ROM');
  /** @type {number[]} */
  const bangs = [];
  engine.onBang = (cycle) => bangs.push(cycle);

  const inputs = createInputState();
  for (let f = 0; f < 600; f += 1) engine.runFrame(inputs);
  // Attract mode: the tilemap is not blank, the starfield is on.
  const tiles = new Set(engine.mem.subarray(0, 0x400));
  assert.ok(tiles.size > 5, `tilemap has ${tiles.size} distinct codes`);
  assert.equal(engine.soundRegs().length, 0x40);

  // Inputs reach the board: a coin and a start begin a game.
  const frame = (/** @type {number} */ n) => { for (let i = 0; i < n; i += 1) engine.runFrame(inputs); };
  setSwitch(inputs, 'coin1', true); frame(4);
  setSwitch(inputs, 'coin1', false); frame(60);
  setSwitch(inputs, 'start1', true); frame(4);
  setSwitch(inputs, 'start1', false);
  // The "PARSEC 1" intro runs first; the fighter appears ~7 s later.
  frame(600);
  // The player's fighter (sprite code $2E, colour 0) is on screen.
  let fighter = false;
  for (let n = 0; n < 64; n += 1) {
    const on = (engine.mem[0x1f81 + 2 * n] & 2) === 0;
    if (on && engine.mem[0x0f80 + 2 * n] === 0x2e) fighter = true;
  }
  assert.ok(fighter, 'no fighter sprite after coin + start');
  assert.equal(engine.soundEnable(), true, '15XX on while the game runs');

  // reset(): power-on again, RAM cleared.
  engine.reset();
  assert.equal(engine.mem.subarray(0, 0x2000).every((v) => v === 0), true);
});

test('BoardAdapter: a coin makes the 15XX register image audible', needRoms, async () => {
  const engine = await createEngine('rom', { fetch: diskFetch() });
  assert.ok(engine instanceof EmulatedEngine && engine.adapter !== null);
  const inputs = createInputState();
  /** Voices with a non-zero volume (low nibble of byte +3) in the image. */
  const voices = () => {
    const regs = engine.soundRegs();
    let n = 0;
    for (let v = 3; v < 0x40; v += 8) if ((regs[v] & 0x0f) !== 0) n += 1;
    return n;
  };
  for (let f = 0; f < 600; f += 1) engine.runFrame(inputs);
  // The attract mode is silent until its demo game (~frame 2570).
  assert.equal(voices(), 0);
  assert.equal(engine.soundEnable(), true, 'SRESET released: the 15XX is on');
  setSwitch(inputs, 'coin1', true);
  let loudest = 0;
  for (let f = 0; f < 60; f += 1) {
    if (f === 4) setSwitch(inputs, 'coin1', false);
    engine.runFrame(inputs);
    loudest = Math.max(loudest, voices());
  }
  assert.ok(loudest > 0, 'the coin chime never reached the register image');
  // It is the board's own 15XX image, read at $6000-$603F.
  assert.equal(engine.soundRegs().buffer, engine.mem.buffer);
});

// ---------------------------------------------------------------- inputs

test('setSwitch drives the namcoio ports (active low)', () => {
  const inp = createInputState();
  for (const name of SWITCH_NAMES) setSwitch(inp, name, true);
  const p = inputPorts(inp);
  // All four directions held cancel out (PORT_8WAY contradictions).
  assert.equal(p.P1, 0x0f);
  assert.equal(p.COINS, 0x0f & ~0x0b);
  assert.equal(p.BUTTONS, 0x00);
  releaseAll(inp);
  assert.deepEqual(inputPorts(inp), inputPorts(createInputState()));
  setSwitch(inp, 'up', true);
  setSwitch(inp, 'left', true);
  assert.equal(inputPorts(inp).P1, 0x0f & ~0x09, 'up-left: diagonal on an 8-way stick');
  assert.throws(() => setSwitch(inp, 'fire', true), /unknown switch/);
});

test('test switch is the service-mode DIP (SW2:1)', () => {
  const inp = createInputState();
  assert.equal(testSwitch(inp), false);
  setTestSwitch(inp, true);
  assert.equal(testSwitch(inp), true);
  assert.equal(inp.dips.DSWB_HIGH, 0x07);
  setTestSwitch(inp, false);
  assert.equal(inp.dips.DSWB_HIGH, 0x0f);
});

test('bindings: 8-way stick, every machine input is a real switch', () => {
  for (const dir of ['up', 'down', 'left', 'right']) assert.ok(ACTIONS.includes(dir));
  for (const action of ACTIONS) {
    const name = MACHINE_INPUT[action];
    if (name !== undefined) assert.ok(SWITCH_NAMES.includes(name), `${action} -> ${name}`);
  }
  assert.equal(MACHINE_INPUT.pause, undefined, 'pause is a host action');
  const b = normalizeBindings(undefined);
  const rest = { axes: [0, 0], buttons: new Array(16).fill(0) };
  const upLeft = { axes: [-1, -1], buttons: new Array(16).fill(0) };
  assert.deepEqual([...activeActions(b, upLeft, rest)].sort(), ['left', 'up']);
  const dpadDown = { axes: [0, 0], buttons: rest.buttons.map((_, i) => (i === 13 ? 1 : 0)) };
  assert.deepEqual([...activeActions(b, dpadDown, rest)], ['down']);
  // A profile saved without up/down gets the defaults for them.
  const old = normalizeBindings({ left: [{ type: 'button', index: 4 }] });
  assert.deepEqual(old.up, [...DEFAULT_BINDINGS.up]);
  assert.deepEqual(old.left, [{ type: 'button', index: 4 }]);
  // Assigning swaps a clash rather than dropping a binding.
  const swapped = assignBinding(b, 'up', { type: 'axis', index: 1, dir: 1 });
  assert.deepEqual(swapped.up, [{ type: 'axis', index: 1, dir: 1 }]);
  assert.deepEqual(swapped.down, [{ type: 'axis', index: 1, dir: -1 }]);
});

test('mux: a switch held by keyboard survives the pad letting go', () => {
  /** @type {Array<[string, boolean]>} */
  const log = [];
  const mux = new InputMux((name, down) => log.push([name, down]));
  mux.set('keyboard', 'up', true);
  mux.setAll('gamepad', ['up', 'fire1']);
  mux.setAll('gamepad', []);
  assert.deepEqual(log, [['up', true], ['fire1', true], ['fire1', false]]);
});

// ---------------------------------------------------------------- the rest

test('chooser selection wraps both ways', () => {
  assert.equal(stepIndex(0, 2, 1), 1);
  assert.equal(stepIndex(1, 2, 1), 0);
  assert.equal(stepIndex(0, 2, -1), 1);
  assert.equal(stepIndex(0, 0, 1), 0);
});

test('favicon.png is up to date (tools/gen-favicon.mjs)', () => {
  const want = encodePng(faviconPixels(0x2e, 0), 16, 16, 2);
  const have = readFileSync(join(ROOT, 'favicon.png'));
  assert.ok(Buffer.from(want).equals(have), 'run `node tools/gen-favicon.mjs`');
  // The fighter is drawn, the corners are transparent.
  const px = faviconPixels(0x2e, 0);
  assert.equal(px[3], 0);
  assert.ok(px.some((v, i) => i % 4 === 3 && v === 255));
});

// Copyright 2026 by Moshix
/**
 * Oracle tests for gp2_3b_start.js: game start (busy code: every write
 * timed to the cycle), the start-tune CWAI loop, the demo input and its
 * end, and the small play tasks. Same method as main-gp2_3b.test.mjs:
 * identical seeded-random RAM on the oracle and the port, then RAM,
 * I/O chips, writes (in order), cycles charged, the CWAIs (count and
 * cycle at each) and the exit must match. The port's SYNC points
 * (reported as 'busy') have no oracle counterpart; their cycle stamps
 * are checked through the timed writes (every write is timed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../src/game/main/gp2_3b.js';
import { mainAt } from '../../src/game/main/routines.js';
import { takeJump } from '../../src/game/main/gp2_3b_state.js';
import {
  makePair, romRun, portRun, writeLog, same, ri, romWrites, portWrites,
} from './main-gp2_3b.util.mjs';

/**
 * A well-mixed PRNG (mulberry32) for the setups: the harness's rnd
 * starts almost identically for neighbouring seeds (xorshift's first
 * outputs), which would leave branches untested.
 * @param {number} seed @returns {() => number} 0..1
 */
function mulberry(seed) {
  let s = (seed * 0x9e3779b1) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {object} CaseOpts
 * @property {(i: number, side: { mem: Uint8Array }) => void} [tick]
 *   applied at each CWAI on both sides (what the vblank IRQ would do)
 * @property {boolean} [timed] compare the write cycle stamps too
 *   (default true)
 */

/**
 * Run the routine at `addr` on both sides and compare everything.
 * @param {number} addr @param {number} seed
 * @param {(m: object, rnd: () => number) => void} [setup]
 * @param {CaseOpts} [o]
 */
function runCase(addr, seed, setup, o = {}) {
  const rnd = mulberry(seed ^ addr);
  const { board, m } = makePair(seed, (mm) => setup?.(mm, rnd));
  let k = 0;
  const rom = romRun(board, addr, {
    stops: [0xfeb5, 0xfeb0, 0xc417],
    log: true,
    onEvent: (e, b) => { o.tick?.(k, b); k += 1; },
  });
  const log = writeLog(m);
  let j = 0;
  const port = portRun(mainAt(addr)(m, {}), m, {
    onEvent: (e, mm) => {
      if (e.kind === 'cwai') { o.tick?.(j, mm); j += 1; }
    },
  });
  const what = `$${addr.toString(16)} seed ${seed}`;
  const waits = port.events.filter((e) => e.kind !== 'busy');
  assert.deepEqual(waits.map((e) => [e.kind, e.cycles]),
    rom.events.map((e) => [e.kind, e.cycles]), `${what}: CWAIs`);
  // Every write is timed: all code here syncs before shared accesses.
  const timed = o.timed ?? true;
  assert.deepEqual(portWrites(log, timed),
    romWrites(rom.writes, { timed }), `${what}: writes`);
  same(board, m, what);
  assert.equal(m.charged[0], rom.cycles, `${what}: cycles`);
  assert.equal(takeJump(m) ?? 0xfeb5, rom.pc, `${what}: exit`);
  return { rom, port };
}

/** Frame tick for the start tune: frame counter + 1, tune over at n. */
const tuneTick = (n) => (i, side) => {
  side.mem[0x1016] = (side.mem[0x1016] + 1) & 0xff;
  if (i + 1 >= n) side.mem[0x6040] = 0;
};

/**
 * Random game-start state.
 * @param {object} m @param {() => number} rnd
 */
function startSetup(m, rnd) {
  m.poke(0x09f4, rnd() < 0.5 ? 0 : 1);
  m.poke(0x102c, rnd() < 0.5 ? 0 : 1);
  m.poke(0x1000, rnd() < 0.1 ? ri(rnd, 256) : ri(rnd, 6));
  if (rnd() < 0.5) m.poke(0x1179, 0);
  if (rnd() < 0.5) m.poke(0x1178, 0);
  if (rnd() < 0.3) m.poke(0x1106, 2);
  if (rnd() < 0.3) m.poke(0x171e, 0x78);
  if (rnd() < 0.3) m.poke(0x1720, 0x78);
  if (rnd() < 0.2) { m.poke(0x1723, 0x46); m.poke(0x1f23, 0x01); }
  m.io.n56.ram[3] = ri(rnd, 16);
}

test('start_game_1p / start_game_2p / lCDA1: timed writes, tune wait',
  () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const n = 1 + (seed % 7);
      for (const addr of [0xccd0, 0xcdff, 0xcda1]) {
        runCase(addr, seed, startSetup, { tick: tuneTick(n), timed: true });
      }
    }
  });

test('task_count_fighters / sub_D8F8', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    runCase(0xcf14, seed, (m, rnd) => {
      for (let x = 0x1ec3; x < 0x1ecf; x += 2) {
        m.poke(x, rnd() < 0.5 ? 0 : 0x80);
      }
      if (rnd() < 0.5) m.poke(0x09f4, 0);
    });
    runCase(0xd8f8, seed, (m, rnd) => {
      m.poke(0x10dc, rnd() < 0.8 ? ri(rnd, 7) : ri(rnd, 256));
    });
  }
});

/**
 * Player movement state.
 * @param {object} m @param {() => number} rnd
 */
function moveSetup(m, rnd) {
  if (rnd() < 0.7) m.poke(0x10d9, 0);
  m.poke(0x09f4, rnd() < 0.3 ? 1 : 0);
  if (rnd() < 0.5) m.poke(0x102c, 0);
  if (rnd() < 0.6) m.poke(0x1111, 0);
  if (rnd() < 0.5) m.poke(0x10db, 0);
  m.io.n56.ram[4] = ri(rnd, 16);
  m.io.n56.ram[6] = ri(rnd, 16);
  if (rnd() < 0.2) m.poke(0x1601, rnd() < 0.5 ? 0xc8 : 0x49);
  if (rnd() < 0.3) m.poke(0x1032, ri(rnd, 3));
  // Demo script: a timer about to run out, sometimes at the end marker.
  if (rnd() < 0.5) m.poke(0x09f0, 1);
  if (rnd() < 0.3) {
    const p = m.peek16(0x09f2);
    m.poke((p + 0x100) & 0xffff, 0xf0);
  }
}

test('task_move_player / demo_input / lD029', () => {
  for (let seed = 1; seed <= 400; seed += 1) {
    runCase(0xcf4f, seed, moveSetup);
  }
  for (let seed = 1; seed <= 100; seed += 1) {
    runCase(0xd000, seed, moveSetup);
    runCase(0xd029, seed);
  }
});

test('task_end_frame / task_next_mode: one CWAI each', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const { rom } = runCase(0xd150, seed, undefined, { tick: tuneTick(1) });
    assert.equal(rom.events.length, 1);
    runCase(0xd15b, seed, undefined, { tick: tuneTick(1) });
  }
});

test('task_player_fire', () => {
  for (let seed = 1; seed <= 400; seed += 1) {
    runCase(0xd168, seed, (m, rnd) => {
      m.poke(0x09f4, rnd() < 0.3 ? 1 : 0);
      if (rnd() < 0.7) m.poke(0x10e9, 0);
      if (rnd() < 0.5) m.poke(0x102c, 0);
      if (rnd() < 0.5) m.poke(0x1019, 0);
      if (rnd() < 0.5) m.poke(0x09f5, 0);
      m.io.n56.ram[5] = ri(rnd, 16);
      m.io.n56.ram[7] = ri(rnd, 16);
      m.poke16(0x10d3, rnd() < 0.5 ? 0x0ea6 : 0x0ea8);
      for (let x = 0x0ea2; x < 0x0eaa; x += 2) {
        m.poke(x + 0x1001, rnd() < 0.5 ? 0 : 0x80);
      }
      if (rnd() < 0.5) m.poke(0x0ea2, 0x2f);
      if (rnd() < 0.5) m.poke(0x0f16, 0x26);
    });
  }
});

test('task_move_shots / sub_D223 / sub_D8B0', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    runCase(0xd1d0, seed, (m, rnd) => {
      if (rnd() < 0.5) m.poke(0x1177, 0);
      m.poke(0x10d2, ri(rnd, 16));
    });
    runCase(0xd223, seed, (m, rnd) => {
      if (rnd() < 0.3) m.poke(0x10db, 0);
      m.poke(0x10dc, rnd() < 0.8 ? ri(rnd, 7) : ri(rnd, 256));
    });
    runCase(0xd8b0, seed, (m, rnd) => {
      if (rnd() < 0.5) m.poke(0x10fe, 0);
      for (let i = 0; i < 0x40; i += 1) {
        if (rnd() < 0.6) m.poke(0x0840 + i, 0);
      }
    });
  }
});

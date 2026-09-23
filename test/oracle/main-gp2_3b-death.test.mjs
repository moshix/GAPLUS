// Copyright 2026 by Moshix
/**
 * Oracle tests for gp2_3b_death.js: task_player_hit_check ($D915) and the
 * death / next player / game over web behind it, the entries other chips
 * jump to (lD9CF, lDA87, lDBE2, lDC0B), sub_DC1C and sub_DEC1.
 *
 * Each case runs the ROM from the entry on the oracle until it reaches
 * task_dispatch ($FEB5), attract_loop ($C417) or $CDA1 (start_game_1p),
 * and the port generator to its end, from identical seeded-random RAM
 * with the branch variables forced. CWAIs are frames (no-op ticks). RAM,
 * I/O chips, write order, cycles at every CWAI and at the end, and the
 * exit must match. load_stage_params ($F4A5) and load_formation_sprites
 * ($B656) are ROM-backed stubs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../src/game/main/gp2_3b.js';
import { MAIN, MAIN_AT, mainAt } from '../../src/game/main/routines.js';
import { takeJump } from '../../src/game/main/gp2_3b_state.js';
import {
  makePair, romRun, portRun, romStub, writeLog, same, ri, romWrites,
  portWrites,
} from './main-gp2_3b.util.mjs';

for (const [name, addr] of [['load_stage_params', 0xf4a5],
  ['load_formation_sprites', 0xb656]]) {
  MAIN[name] = romStub(addr);
  MAIN_AT[addr] = MAIN[name];
}

/** @typedef {import('../../src/machine/machine.js').Machine} Machine */

/**
 * Run `entry` on both sides and compare everything.
 * @param {number} entry
 * @param {number} seed
 * @param {(m: Machine, rnd: () => number) => void} setup
 * @returns {{ exit: number, cwais: number }}
 */
function flowCase(entry, seed, setup) {
  const { board, m } = makePair(seed, setup);
  const rom = romRun(board, entry, {
    stops: [0xfeb5, 0xc417, 0xcda1], log: true,
  });
  const log = writeLog(m);
  const port = portRun(mainAt(entry)(m), m);
  const what = `$${entry.toString(16)} seed ${seed}`;
  assert.ok(port.done, `${what}: port ended`);
  const cw = port.events.filter((e) => e.kind === 'cwai');
  assert.deepEqual(cw.map((e) => e.cycles),
    rom.events.map((e) => e.cycles), `${what}: CWAIs (cycles)`);
  // Timed writes: each at the cycle its instruction starts. The writes
  // of sound_demo_gate ($DF27-$DF5C, a plain function without sync
  // points) are compared untimed.
  const ours = romWrites(rom.writes, { timed: true });
  const pcs = rom.writes.filter(([, a, , pc]) => pc >= 0xc000
    && pc <= 0xdfff && (a < 0x15e2 || a >= 0x1600)).map((w) => w[3]);
  // (with the demo-sounds bit set it ends in sound_all_off's loop at
  // $DF1C: those writes belong to it too)
  let inGate = false;
  const plain = pcs.map((pc) => {
    if (pc >= 0xdf27 && pc < 0xdf5d) inGate = true;
    else if (pc < 0xdf19 || pc >= 0xdf27) inGate = false;
    return inGate;
  });
  const strip = (w, i) => (plain[i] ? [w[1], w[2]] : w);
  assert.deepEqual(portWrites(log, true).map(strip), ours.map(strip),
    `${what}: timed writes`);
  same(board, m, what);
  assert.equal(takeJump(m) ?? 0xfeb5, rom.pc, `${what}: exit`);
  assert.equal(m.charged[0], rom.cycles, `${what}: cycles`);
  return { exit: rom.pc, cwais: cw.length };
}

/** @param {() => number} rnd @param {number} p */
const chance = (rnd, p) => rnd() < p;

/**
 * Game state for the death web: players, lives, stages, scores, modes.
 * @param {Machine} m @param {() => number} rnd
 */
function players(m, rnd) {
  m.poke(0x102e, chance(rnd, 0.6) ? 1 : 0); // two_players
  m.poke(0x102d, chance(rnd, 0.5) ? 1 : 0); // cur_player
  const lives = () => [0, 1, 2, 3, 5, 7][ri(rnd, 6)];
  m.poke(0x1104, lives());
  m.poke(0x1105, lives());
  m.poke(0x1000, chance(rnd, 0.4) ? m.peek(0x1105) : 3);
  m.poke(0x1005, chance(rnd, 0.5) ? 0 : 1); // cabinet
  if (chance(rnd, 0.5)) m.poke(0x1107, 0);
  if (chance(rnd, 0.5)) {
    m.poke(0x09b3, 0); m.poke(0x09b4, 0); m.poke(0x09b5, 0);
  }
  if (chance(rnd, 0.5)) m.poke(0x112f, 3);
  if (chance(rnd, 0.5)) m.poke(0x1130, 3);
  if (chance(rnd, 0.5)) m.poke(0x102f, 3);
  if (chance(rnd, 0.6)) m.poke(0x1180, 0);
  if (chance(rnd, 0.6)) m.poke(0x117f, 0);
  // Stages small enough for load_stage_params' tables.
  m.poke(0x1106, ri(rnd, 40));
  m.poke(0x1107, chance(rnd, 0.5) ? 0 : ri(rnd, 40));
}

/**
 * Hit-check state: flags off unless forced, box targets near the ship.
 * @param {Machine} m @param {() => number} rnd
 */
function hitState(m, rnd) {
  m.poke(0x09f4, chance(rnd, 0.1) ? 1 : 0);
  m.poke(0x10fe, 0);
  m.poke(0x101a, chance(rnd, 0.1) ? ri(rnd, 256) : 0);
  m.poke(0x110f, chance(rnd, 0.1) ? 1 : 0);
  // Mostly entries out of use; a few near the player.
  for (let x = 0x0ece; x < 0x0f14; x += 2) {
    if (chance(rnd, 0.7)) m.poke(x + 0x1001, m.peek(x + 0x1001) & 0x7f);
  }
  for (let x = 0x0e30; x < 0x0e88; x += 2) {
    if (chance(rnd, 0.7)) m.poke(x + 0x1001, m.peek(x + 0x1001) & 0x7f);
  }
  const n = ri(rnd, 3);
  for (let i = 0; i < n; i += 1) {
    const x = chance(rnd, 0.5) ? 0x0ece + 2 * ri(rnd, 35)
      : 0x0e30 + 2 * ri(rnd, 44);
    const px = (m.peek(0x1e01) & 1) * 256 + m.peek(0x1601);
    const ex = (px + ri(rnd, 17) - 8) & 0x1ff;
    m.poke(x + 0x1001, 0x80 | (ex >> 8) | (m.peek(x + 0x1001) & 0x7e));
    m.poke(x + 0x0801, ex & 0xff);
    m.poke(x + 0x0800, (m.peek(0x1600) + ri(rnd, 17) - 8) & 0xff);
  }
}

test('task_player_hit_check: hit tests', () => {
  const exits = new Set();
  for (let seed = 1; seed <= 400; seed += 1) {
    flowCase(0xd915, seed, (m, rnd) => {
      hitState(m, rnd);
      players(m, rnd);
    });
    exits.add(seed);
  }
});

test('task_player_hit_check: the death sequence and player changes', () => {
  const exits = new Map();
  for (let seed = 1000; seed < 1600; seed += 1) {
    const r = flowCase(0xd915, seed, (m, rnd) => {
      hitState(m, rnd);
      m.poke(0x09f4, 0);
      m.poke(0x10fe, 1);
      m.poke(0x6054, chance(rnd, 0.2) ? 1 : 0);
      players(m, rnd);
    });
    exits.set(r.exit, (exits.get(r.exit) ?? 0) + 1);
  }
  assert.ok(exits.get(0xc417) > 0, 'game over reached');
  assert.ok(exits.get(0xcda1) > 0, 'P2 first start reached');
  assert.ok(exits.get(0xfeb5) > 0, 'dispatch reached');
});

test('lD9CF: fighter reset and life lost (256-frame game over)', () => {
  let long = 0;
  for (let seed = 2000; seed < 2300; seed += 1) {
    const r = flowCase(0xd9cf, seed, players);
    if (r.cwais === 256) long += 1;
  }
  assert.ok(long > 0, 'the 256-frame game-over waits ran');
});

test('lDA87: game over to attract', () => {
  for (let seed = 3000; seed < 3010; seed += 1) {
    const r = flowCase(0xda87, seed, (m, rnd) => {
      m.io.n58.ram[7] = ri(rnd, 16);
    });
    assert.equal(r.exit, 0xc417);
  }
});

test('lDBE2 / lDC0B: after the name entry', () => {
  for (let seed = 4000; seed < 4100; seed += 1) {
    const setup = (m, rnd) => {
      players(m, rnd);
      m.poke(0x09fd, chance(rnd, 0.2) ? 0 : 1 + ri(rnd, 59));
      m.poke(0x09fe, ri(rnd, 30));
    };
    flowCase(0xdbe2, seed, setup);
    flowCase(0xdc0b, seed, setup);
  }
});

test('sub_DEC1: game time histogram', () => {
  for (let t = 0; t < 40; t += 1) {
    for (const s of [0, 1]) {
      const { board, m } = makePair(t, (mm) => {
        mm.poke(0x09fd, s);
        mm.poke(0x09fe, t);
      });
      const rom = romRun(board, 0xdec1);
      assert.ok(portRun(mainAt(0xdec1)(m), m).done);
      same(board, m, `sub_DEC1 ${t}`);
      assert.equal(m.charged[0], rom.cycles);
    }
  }
});

test('lD9CF: one-player game (lives left, mode 3 restart, game over)', () => {
  for (let seed = 5000; seed < 5060; seed += 1) {
    flowCase(0xd9cf, seed, (m, rnd) => {
      players(m, rnd);
      m.poke(0x102e, 0);
      m.poke(0x1104, [1, 2, 3, 6][seed % 4]);
      m.poke(0x102f, chance(rnd, 0.5) ? 3 : 5);
    });
  }
});

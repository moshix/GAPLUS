// Copyright 2026 by Moshix
/**
 * Oracle tests for the sub CPU's gp2-6.11b $EBEC-$F5A4
 * (src/game/sub/gp2_6_eb.js): sub_EBEC, sub_F0ED, sub_F116, each run on
 * the ROM and on the port from the same seeded states. Besides RAM, each
 * case checks the timing contract (kit sameTiming): total cycles, the
 * cycle of every write and of every shared access (the port's SYNCs),
 * and the cycle of the CWAI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pair, randomize, same, rng, romTask, portTask, sameTiming,
} from './sub-gp2_6-kit.test.mjs';
import '../../src/game/sub/gp2_6.js';
import { SUB_AT } from '../../src/game/sub/routines.js';

/**
 * A state for the two formation tasks: random RAM, then the counters and
 * inputs they branch on, mostly in range so the table walks are real.
 * @param {ReturnType<typeof pair>} p @param {number} seed
 */
function setup(p, seed) {
  const r = rng(seed);
  randomize(p.board, p.m, seed);
  const { poke } = p;
  if (r.chance(0.9)) {
    poke(0x1116, r.pick([0, 0, 1, 2, 3, 0x0a, 0x16, 0x17, 0x17, 0x17,
      0x97, 0x18, r.byte()]));
  }
  if (r.chance(0.9)) poke(0x1117, r.pick([0, 1, 2, 3, 4, 5, r.int(8)]));
  if (r.chance(0.9)) poke(0x1118, r.pick([0, 1, 2, 3, 4, 5, 6, 6, 7, 8]));
  if (r.chance(0.9)) {
    poke(0x1035, r.pick([3, 8, 0x12, 0x1c, 0x26, 0x30, 0x3a, 0x44, 0,
      1, 2, 5, 9, 0x13, r.byte()]));
  }
  if (r.chance(0.9)) poke(0x1103, r.int(6));
  if (r.chance(0.5)) {
    poke(0x1601, r.pick([0x0f, 0x10, 0xef, 0xf0, 0, 0xff, 0x80]));
  }
  if (r.chance(0.8)) {
    poke(0x1016, (r.byte() & 0xf0) | r.pick([0, 5, 0x0a, 1, 0x0f]));
  }
  if (r.chance(0.5)) poke(0x186e, r.pick([0, 1, 2, 3]));
  if (r.chance(0.5)) poke(0x186f, r.pick([0, 1, 2, 3]));
}

/**
 * romTask, recording every PC the oracle's sub core runs (coverage).
 * @param {import('../m6809/board.mjs').Board} board @param {number} addr
 * @param {object} [opts]
 */
function romRun(board, addr, opts = {}) {
  const c = board.cpus[1];
  const step = c.step.bind(c);
  c.step = () => {
    PCS.add(c.pc);
    return step();
  };
  try {
    return romTask(board, addr, opts);
  } finally {
    }
}

/** @param {{ mem: Uint8Array }} o @param {number} n */
const tick = (o, n) => { o.mem[0x1016] = (o.mem[0x1016] + 1 + n) & 0xff; };

/**
 * Run one task on both sides and compare.
 * @param {number} addr @param {number} cases @param {number} seed0
 */
function taskTest(addr, cases, seed0) {
  const p = pair();
  let ticked = 0;
  for (let i = 0; i < cases; i += 1) {
    setup(p, seed0 + i);
    const rom = romRun(p.board, addr, { tick });
    const port = portTask(SUB_AT[addr], p.m, { tick });
    assert.equal(port.ticks, rom.ticks, `ticks, case ${i}`);
    ticked += rom.ticks;
    same(p.board, p.m, `$${addr.toString(16)} case ${i}`);
    sameTiming(rom, port, `$${addr.toString(16)} case ${i}`);
  }
  return ticked;
}

/** Sub PCs the oracle executed in taskTest runs. @type {Set<number>} */
const PCS = new Set();

/**
 * Every branch target / fall-through of the routines, which the random
 * states must reach.
 */
const MUST = {
  0xebec: [0xebf1, 0xebfa, 0xec03, 0xec0c, 0xec13, 0xec1d, 0xec23, 0xec2c,
    0xec3b, 0xec52, 0xec58, 0xec5d, 0xec66, 0xec6b, 0xec71, 0xec75,
    0xec79, 0xec8a, 0xec9e, 0xeca6, 0xecae, 0xecb2, 0xecb8, 0xecc3,
    0xece4, 0xeceb, 0xecf5, 0xed00, 0xed0a, 0xed18],
  0xf116: [0xf11b, 0xf120, 0xf129, 0xf132, 0xf139, 0xf143, 0xf149,
    0xf152, 0xf161, 0xf175, 0xf17b, 0xf184, 0xf189, 0xf18f, 0xf193,
    0xf197, 0xf1a1, 0xf1ac, 0xf1bd, 0xf1c5, 0xf1cd, 0xf1d1, 0xf1d7,
    0xf1e2],
};

/** @param {number} addr */
function covered(addr) {
  const miss = MUST[addr].filter((a) => !PCS.has(a))
    .map((a) => a.toString(16));
  assert.deepEqual(miss, [], 'branches never taken');
}

test('sub_F0ED fills the formation tables', () => {
  const p = pair();
  for (let i = 0; i < 20; i += 1) {
    randomize(p.board, p.m, 500 + i);
    const rom = romRun(p.board, 0xf0ed, { rts: true });
    const port = portTask(SUB_AT[0xf0ed], p.m);
    same(p.board, p.m, `sub_F0ED ${i}`);
    sameTiming(rom, port, `sub_F0ED ${i}`);
  }
});

test('sub_EBEC matches the ROM, CWAI included', () => {
  const ticked = taskTest(0xebec, 3000, 1000);
  covered(0xebec);
  assert.ok(ticked > 0, 'the end-of-formation CWAI path was hit');
});

test('sub_EBEC end of formation: one CWAI, game_mode + 1', () => {
  const p = pair();
  randomize(p.board, p.m, 77);
  const vals = [[0x1116, 0x17], [0x1117, 3], [0x1118, 6], [0x1035, 0x12],
    [0x1016, 0x10], [0x186e, 0x01], [0x186f, 0x01]];
  for (const [a, v] of vals) p.poke(a, v);
  // group 6, sprite 3: the $ED7F table ends (U = 0) there
  const rom = romRun(p.board, 0xebec, { tick });
  const port = portTask(SUB_AT[0xebec], p.m, { tick });
  assert.equal(rom.ticks, 1);
  assert.equal(port.ticks, 1);
  same(p.board, p.m, 'end of formation');
  sameTiming(rom, port, 'end of formation');
});

test('sub_F116 matches the ROM', () => {
  assert.equal(taskTest(0xf116, 3000, 9000), 0);
  covered(0xf116);
});

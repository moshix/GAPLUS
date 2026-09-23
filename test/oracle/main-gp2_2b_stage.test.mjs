// Copyright 2026 by Moshix
/**
 * Oracle tests for main CPU $EA21-$ECA3 and $F4A5-$F5C3
 * (src/game/main/gp2_2b_stage.js): the stage event tasks and
 * load_stage_params. Each case runs the ROM routine on the oracle and the
 * port from the same seeded-random RAM, then requires identical RAM,
 * latches (starfield!) and I/O state, the same number of CWAIs / yields,
 * the same cycles and timed writes with a SYNC before every racy access
 * (sameTiming), and for load_stage_params the same registers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installStubs, pair, runRom, runPort, same, sameTiming, rng,
} from './main-gp2_2b_harness.mjs';
import { mainAt } from '../../src/game/main/routines.js';

installStubs();

/** Stand-in for the vblank IRQ at a CWAI: the same change in both. */
const tickB = (b) => { b.mem[0x1016] = (b.mem[0x1016] + 1) & 0xff; };
const tickM = (m) => { m.mem[0x1016] = (m.mem[0x1016] + 1) & 0xff; };

/**
 * Run the task at `addr` on both sides from the same state.
 * @param {number} addr @param {number} seed
 * @param {(poke: (a: number, v: number) => void) => void} setup
 * @param {string} what
 */
function checkTask(addr, seed, setup, what) {
  const { board, m } = pair(seed, setup);
  const r = runRom(board, addr, {}, { onCwai: tickB });
  assert.equal(r.pc, 0xfeb5, `${what}: ROM ends at task_dispatch`);
  const p = runPort(mainAt(addr), m, {}, { onYield: tickM });
  same(board, m, what);
  sameTiming(r, p, what);
  assert.equal(p.yields, r.cwai, `${what}: frames waited`);
}

const EVENT1 = [0x03, 0x08, 0x12, 0x1c, 0x26, 0x30, 0x3a, 0x44];
const EVENT5 = [0x0d, 0x17, 0x21, 0x2b, 0x35, 0x3f];

test('sub_EA21: challenging marks, every count edge', () => {
  let seed = 1;
  for (const cnt of [0, 1, 2, 0x10, 0x28, 0xa4, 0xa5, 0xa6, 0xff]) {
    for (const player of [0, 1]) {
      for (let pat = 0; pat < 8; pat += 1) {
        seed += 1;
        checkTask(0xea21, seed, (poke) => {
          poke(0x1164, cnt);
          poke(0x102d, player);
          poke(player ? 0x1172 : 0x1171, pat | (seed & 0xf8));
        }, `EA21 cnt=${cnt} p=${player} pat=${pat}`);
      }
    }
  }
});

test('sub_EA89: parked shadow entries', () => {
  for (let seed = 100; seed < 130; seed += 1) {
    checkTask(0xea89, seed, (poke) => {
      const r = rng(seed);
      for (let x = 0x16ce; x < 0x1716; x += 2) {
        const k = r() % 4;
        poke(x, [0xdf, 0xe0, 0xff, r() & 0xff][k]);
      }
    }, `EA89 ${seed}`);
  }
});

test('task_stage_events: every stage, every step, compare edges', () => {
  let seed = 1000;
  // non-event stages take the CWAI path at once
  for (const st of [0, 1, 2, 4, 0x13, 0x3b, 0x80, 0xff]) {
    seed += 1;
    checkTask(0xeaa4, seed, (poke) => { poke(0x1035, st); },
      `events stage ${st}`);
  }
  const limits = [0x3c, 0x78, 0xb4];
  for (const st of EVENT1) {
    for (let step = 0; step < 9; step += 1) {
      const lim = limits[step] ?? 0x10;
      for (const cnt of [lim - 1, lim - 2, lim, 0xff, 0]) {
        for (const flip of [0, 1]) {
          seed += 1;
          checkTask(0xeaa4, seed, (poke) => {
            poke(0x1035, st);
            poke(0x116e, step);
            poke(0x116f, cnt & 0xff);
            poke(0x102c, flip);
          }, `events st=${st} step=${step} cnt=${cnt} flip=${flip}`);
        }
      }
    }
  }
});

test('sub_EB66: $1010 == $10, every stage, every step, edges', () => {
  let seed = 5000;
  for (const st of [0, 1, 0x0d, 0x3f]) {
    seed += 1;
    checkTask(0xeb66, seed, (poke) => {
      poke(0x1010, 0x10);
      poke(0x1035, st);
      poke(0x116e, seed % 9);
    }, `EB66 $10 st=${st}`);
  }
  for (const st of [0, 1, 0x0c, 0x0e, 0x40, 0xff]) {
    seed += 1;
    checkTask(0xeb66, seed, (poke) => {
      poke(0x1010, 0x11);
      poke(0x1035, st);
    }, `EB66 none st=${st}`);
  }
  const limits = [0, 0x32, 0x64, 0x96, 0xc8, 0xfa, 0x00, 0x00, 0];
  for (const st of EVENT5) {
    for (let step = 0; step < 9; step += 1) {
      const lim = limits[step];
      for (const cnt of [lim - 1, lim - 2, lim, 0x80]) {
        for (const flip of [0, 1]) {
          seed += 1;
          checkTask(0xeb66, seed, (poke) => {
            if ((seed & 0xff) === 0x10) poke(0x1010, 0x0f);
            poke(0x1035, st);
            poke(0x116e, step);
            poke(0x116f, cnt & 0xff);
            poke(0x102c, flip);
          }, `EB66 st=${st} step=${step} cnt=${cnt} flip=${flip}`);
        }
      }
    }
  }
});

test('event steps entered directly (table entries)', () => {
  const steps = [0xead5, 0xeb01, 0xeb06, 0xeb2b, 0xeb5b, 0xeb9b, 0xeba9,
    0xebd5, 0xebec, 0xec0e, 0xec3a, 0xec71, 0xec7e];
  let seed = 9000;
  for (const a of steps) {
    for (const cnt of [0x3b, 0x77, 0xb3, 0x31, 0x63, 0x95, 0xc7, 0xf9,
      0xff, 0x10]) {
      for (const flip of [0, 1]) {
        seed += 1;
        checkTask(a, seed, (poke) => {
          poke(0x116f, cnt);
          poke(0x102c, flip);
        }, `step $${a.toString(16)} cnt=${cnt} flip=${flip}`);
      }
    }
  }
});

test('load_stage_params: every difficulty and stage, registers', () => {
  let seed = 20000;
  const stages = [];
  for (let s = 0; s < 0x3c; s += 1) stages.push(s);
  stages.push(0x3c, 0x3d, 0x59, 0x5a, 0x77, 0x78, 0x80, 0xc3, 0xff);
  for (let diff = 0; diff < 8; diff += 1) {
    for (const st of stages) {
      seed += 1;
      const { board, m } = pair(seed, (poke) => {
        poke(0x1004, diff);
        poke(0x1035, st);
        const k = seed % 4;
        poke(0x1070, k === 0 ? 0 : seed & 0xff);
        poke(0x10db, k === 1 ? 0 : 1 + (seed & 0x7f));
        poke(0x1ec3, (seed & 2) ? 0x80 : 0x7f);
        if (k === 2) poke(0x1070, 0);
      });
      const r = runRom(board, 0xf4a5, {});
      const p = runPort(mainAt(0xf4a5), m, {});
      const what = `F4A5 diff=${diff} stage=${st}`;
      same(board, m, what);
      sameTiming(r, p, what);
      for (const k of ['a', 'b', 'x', 'y', 'u']) {
        assert.equal(p.out[k], r[k], `${what}: ${k}`);
      }
    }
  }
  // random (out-of-range) difficulties read other ROM words as pointers
  for (let i = 0; i < 60; i += 1) {
    seed += 1;
    const { board, m } = pair(seed);
    const r = runRom(board, 0xf4a5, {});
    const p = runPort(mainAt(0xf4a5), m, {});
    same(board, m, `F4A5 random ${seed}`);
    sameTiming(r, p, `F4A5 random ${seed}`);
  }
});

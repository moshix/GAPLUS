// Copyright 2026 by Moshix
/**
 * Oracle tests for main CPU $F5C4-$FA7C (src/game/main/gp2_2b_fx.js):
 * effects, the player explosion, colour cycling and shot collisions.
 * Every routine runs on the real ROM (oracle) and on the port from the
 * same seeded-random RAM plus a setup per branch; RAM, latches and I/O
 * chips must match, and so must the timing: the total cycles, every
 * write at the cycle its instruction starts, and a SYNC at every racy
 * access (sameTiming). Tasks run until they jump to task_dispatch ($FEB5);
 * the explosion's last step until it jumps into gp2-3b at $D9CF (the
 * port's call there is replaced by a recorder).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installStubs, pair, ORACLE, runRom, runPort, same, rng, TASK_DISPATCH, hex4,
  sameTiming,
} from './main-gp2_2b_harness.mjs';
import { MAIN_AT, mainAt } from '../../src/game/main/routines.js';
import { SENTINEL } from '../helpers/oracle.mjs';

installStubs();

/** Calls of the port's jump into $D9CF (life lost) since the last reset. */
let d9cf = 0;
MAIN_AT[0xd9cf] = () => { d9cf += 1; };

/**
 * Run the ROM task at `addr` and the port's, from the same state.
 * @param {number} addr
 * @param {number} seed
 * @param {(poke: (a: number, v: number) => void, r: () => number) => void}
 *   [setup]
 * @param {object} [regs]
 * @returns {number} where the ROM stopped
 */
function check(addr, seed, setup, regs = {}) {
  const r = rng(seed * 7919 + 13);
  const { board, m } = pair(seed, setup ? (p) => setup(p, r) : undefined);
  const rom = runRom(board, addr, regs, { stopAt: [TASK_DISPATCH, 0xd9cf] });
  d9cf = 0;
  const port = runPort(mainAt(addr), m, regs);
  const what = `$${hex4(addr)} seed ${seed}`;
  assert.equal(port.yields, rom.cwai, `${what}: waits`);
  assert.equal(d9cf, rom.pc === 0xd9cf ? 1 : 0, `${what}: jmp $D9CF`);
  same(board, m, what);
  sameTiming(rom, port, what);
  return rom.pc;
}

test('task_spawn_effect $F5C4: requests and slot choice', () => {
  for (let seed = 1; seed <= 48; seed += 1) {
    check(0xf5c4, seed, (p, r) => {
      p(0x1108, [0, 1, 5, 0xff][seed & 3]);
      for (let i = 0; i < 3; i += 1) {
        p(0x110c + i, ((seed >> (2 + i)) & 1) ? r() & 0xff | 1 : 0);
      }
    });
  }
});

test('task_animate_effects $F5FA: every effect step, flip, $80', () => {
  const pc = new Set();
  for (let seed = 1; seed <= 200; seed += 1) {
    pc.add(check(0xf5fa, seed, (p, r) => {
      for (let i = 0; i < 3; i += 1) {
        const k = r() % 40;
        // 0 = free, 1..33 = the table, 34+ = step $80 (entry 0)
        p(0x110c + i, k === 0 ? 0 : k <= 33 ? k : (k < 37 ? 0x80 : 0));
      }
      p(0x102c, r() & 1); // flip_screen
    }));
  }
  assert.ok(pc.has(TASK_DISPATCH));
});

test('effect_steps: each handler called directly with U', () => {
  const us = [0x0e8c, 0x0e8e, 0x0e90, 0x0e92];
  for (let seed = 1; seed <= 80; seed += 1) {
    for (const addr of [0xf675, 0xf67b, 0xf67e, 0xf684, 0xf6ba, 0xf6c0,
      0xf6c5]) {
      const u = us[seed & 3];
      const { board, m } = pair(seed, (p) => {
        p(0x102c, (seed >> 2) & 1);
      });
      const rom = runRom(board, addr, { u });
      assert.equal(rom.pc, SENTINEL);
      const port = runPort(mainAt(addr), m, { u });
      const what = `$${hex4(addr)} u $${hex4(u)} seed ${seed}`;
      same(board, m, what);
      sameTiming(rom, port, what);
    }
    // entry 0: jumps to task_dispatch itself
    const { board, m } = pair(seed);
    const rom = runRom(board, 0xf673, { u: 0x0e8c });
    assert.equal(rom.pc, TASK_DISPATCH);
    const port = runPort(mainAt(0xf673), m, { u: 0x0e8c });
    assert.equal(/** @type {{ exit: boolean }} */ (port.out).exit, true);
    same(board, m, `$F673 seed ${seed}`);
    sameTiming(rom, port, `$F673 seed ${seed}`);
  }
});

test('sub_F6DD $F6DD: gate, frame phase, all eight steps', () => {
  for (let seed = 1; seed <= 400; seed += 1) {
    check(0xf6dd, seed, (p, r) => {
      p(0x110f, seed % 9 === 0 ? 0 : 1);
      p(0x1016, seed % 5 === 0 ? (r() & 0xff) | 1 : (r() & 0xf8));
      const step = seed % 8;
      p(0x1110, step);
      p(0x102c, r() & 1);
      if (step === 1) {
        // sub_F76D's condition, each part true most of the time
        p(0x102f, r() % 4 === 0 ? r() & 7 : 5);
        p(0x09b0, r() % 3 === 0 ? r() & 0xff : 0);
        p(0x09b1, r() % 3 === 0 ? r() & 0xff : 1);
        p(0x188a, r() & 0xff);
        p(0x1f15, r() & 0xff);
      }
      if (step === 7) {
        p(0x0f30, [0x10, 0xf6, 0xf7, 0xfe, 0xff, 0xff, 0xff][r() % 7]);
        p(0x102f, [4, 5, 5, 3][r() % 4]);
        p(0x102e, r() & 1);
        p(0x102d, r() & 1);
        p(0x1178, r() % 3 === 0 ? 0 : 1);
        p(0x1179, r() % 3 === 0 ? 0 : 1);
      }
    });
  }
});

test('sub_F824 reaches $D9CF in both', () => {
  let hits = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    const pc = check(0xf824, seed, (p, r) => {
      p(0x0f30, 0xff);
      p(0x102f, seed & 1 ? 5 : 2);
      p(0x102e, r() & 1);
      p(0x102d, r() & 1);
      p(0x1178, r() & 1);
      p(0x1179, r() & 1);
    });
    if (pc === 0xd9cf) hits += 1;
  }
  assert.equal(hits, 40);
});

test('sub_F8DA $F8DA: frame phase, up/down/still, blink codes', () => {
  for (let seed = 1; seed <= 120; seed += 1) {
    check(0xf8da, seed, (p, r) => {
      p(0x1016, seed % 4 === 1 ? r() & 0xff : r() & 0xfc);
      p(0x0ea2, [0x2f, 0x3e, r() & 0xff][seed % 3]);
      for (let x = 0x0ece; x < 0x0edc; x += 2) {
        p(x, r() & 1 ? 0x4e + (r() & 3) : r() & 0xff);
      }
    });
  }
});

test('sub_F921 $F921: gate, misses, hits at the box edges', () => {
  let hits = 0;
  for (let seed = 1; seed <= 600; seed += 1) {
    check(0xf921, seed, (p, r) => {
      p(0x101a, seed % 10 === 0 ? 1 : 0);
      p(0x604b, 0); // snd_request+11: set by a hit
      /** @type {Array<[number, number, number]>} [lo, hiBit, y] */
      const objs = [];
      for (let u = 0x0ec2; u < 0x0ece; u += 2) {
        const f = r() % 3 === 0 ? r() & 0x7f : 0x80 | (r() & 0x7f);
        p(u + 0x1001, f);
        const lo = r() & 0xff;
        const y = r() & 0xff;
        p(u + 0x0801, lo);
        p(u + 0x0800, y);
        objs.push([lo, f & 1, y]);
      }
      for (let x = 0x0ece; x < 0x0edc; x += 2) {
        p(x + 0x1001, r() % 3 === 0 ? r() & 0x7f : 0x80 | (r() & 0x7f));
        if (r() % 2 === 0) {
          // near one object: X/2 within -4..+4, Y within -7..+7
          const [lo, hb, y] = objs[r() % objs.length];
          const hx = ((hb << 7) | (lo >> 1)) + (r() % 9) - 4;
          const nx = (hx << 1) | (r() & 1);
          p(x + 0x0801, nx & 0xff);
          p(x + 0x1001, 0x80 | (r() & 0x7e) | ((nx >> 8) & 1));
          p(x + 0x0800, (y + (r() % 15) - 7) & 0xff);
        }
      }
    });
    if (ORACLE.mem[0x604b] === 1) hits += 1;
  }
  assert.ok(hits > 50, `only ${hits} hits`);
});

// Copyright 2026 by Moshix
/**
 * Oracle tests for the sub CPU's gp2-6.11b tasks at $FA2E-$FFFF
 * (src/game/sub/gp2_6_fa.js): each task is run on the oracle's sub CPU
 * (to its jump to task_dispatch_sub) and on the port from the same
 * seeded-random RAM, with setups that steer every branch; RAM must match,
 * and so must the timing (sameTiming: total cycles, the cycle of every
 * write and of every SYNC, i.e. every shared-memory access).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pair, randomize, same, rng, romTask, portTask, sameTiming,
} from './sub-gp2_6-kit.test.mjs';
import '../../src/game/sub/gp2_6.js';
import { SUB_AT } from '../../src/game/sub/routines.js';

/**
 * Run `addr` on both sides `n` times from random RAM plus `setup`.
 * @param {number} addr @param {number} n @param {number} seed
 * @param {(r: ReturnType<typeof rng>, poke: (a: number, v: number)
 *   => void, poke16: (a: number, v: number) => void) => void} setup
 * @param {{ b?: number, u?: number }} [regs]
 */
function check(addr, n, seed, setup, regs) {
  const { board, m, poke, poke16 } = pair();
  const r = rng(seed);
  for (let i = 0; i < n; i += 1) {
    randomize(board, m, seed * 1000 + i);
    setup(r, poke, poke16);
    const rom = romTask(board, addr, { regs });
    const port = portTask(SUB_AT[addr], m, { regs });
    assert.equal(port.ticks, rom.ticks, `$${addr.toString(16)} #${i}`);
    same(board, m, `$${addr.toString(16)} #${i}`);
    sameTiming(rom, port, `$${addr.toString(16)} #${i}`);
  }
}

test('every routine of $FA2E-$FFFF is registered', () => {
  for (const a of [0xfa2e, 0xfb09, 0xfb58, 0xfb77, 0xfbb0, 0xfbb1,
    0xfbb2, 0xfbb3, 0xfc6d, 0xfca6, 0xfca7, 0xfca8, 0xfca9, 0xfd59,
    0xfe31, 0xfe82]) {
    assert.equal(typeof SUB_AT[a], 'function', a.toString(16));
  }
});

test('sub_FA2E moves the seven objects and flips their codes', () => {
  check(0xfa2e, 300, 1, (r, poke, poke16) => {
    for (let u = 0x0ece; u < 0x0edc; u += 2) {
      poke(u + 0x1001, r.chance(0.7) ? 0x80 | r.int(2) : r.byte() & 0x7f);
      poke(u + 0x0801, r.pick([0x5e, 0x5f, 0xfd, 0xfe, 0xff, r.byte()]));
      if (r.chance(0.4)) poke16(u, 0x4710);
    }
    poke(0x1114, r.pick([0, 1, 5, 0x32, 0x33, 0x80, r.byte()]));
    poke(0x1115, r.pick([4, 4, 3, r.byte()]));
  });
});

test('sub_FB09 refreshes the formation sprites', () => {
  check(0xfb09, 200, 2, (r, poke) => {
    poke(0x10bf, r.chance(0.85) ? 1 + r.int(255) : 0);
    for (let u = 0x1860; u < 0x188a; u += 1) {
      poke(u, r.pick([0, 0, 1, 2, 3, 4, 0x80, r.byte()]));
    }
    for (let x = 0x0e02; x < 0x0e2c; x += 2) {
      if (r.chance(0.5)) poke(x + 0x1000, r.pick([0, 0xa0]));
    }
  });
});

test('sub_FB58 shows or hides two sprites', () => {
  check(0xfb58, 60, 3, (r, poke) => {
    poke(0x188a, r.pick([0, 4, r.byte()]));
    poke(0x188b, r.pick([0, 4, r.byte()]));
  });
});

/**
 * Setup shared by sub_FB77 / sub_FC6D and their tails.
 * @param {number} base first counter ($10B0 or $10B5)
 * @param {number} limit index wrap ($14 or $12)
 */
function launcherSetup(base, limit) {
  return (/** @type {ReturnType<typeof rng>} */ r,
    /** @type {(a: number, v: number) => void} */ poke,
    /** @type {(a: number, v: number) => void} */ poke16) => {
    poke(0x112a, r.chance(0.1) ? 1 : 0);
    poke(0x10fe, r.chance(0.1) ? 1 : 0);
    poke(0x1013, r.chance(0.1) ? 1 : 0);
    poke(0x1016, r.chance(0.7) ? r.int(4) << 6 : r.byte());
    poke16(base + 1, r.pick([0x00ff, 0xffff, r.int(0x10000)]));
    poke(base + 4, r.chance(0.5) ? 0 : r.byte());
    poke(base + 3, r.pick([0, limit - 1, limit, r.int(limit), r.byte()]));
    poke(0x1020, r.chance(0.3) ? r.byte() : 0);
    // thresholds: often below the timer so a position is launched
    for (let a = 0x1042; a < 0x1052; a += 2) {
      poke16(a, r.chance(0.7) ? r.int(0x100) : r.int(0x10000));
    }
    // the formation flags the tables point at: mostly busy, some free
    const busy = r.next();
    for (let a = 0x1860; a < 0x1890; a += 1) {
      poke(a, r.chance(busy) ? 1 + r.int(3) : r.byte() & 0xfc);
    }
  };
}

test('sub_FB77 and tails FBB0-FBB3 launch formation positions', () => {
  check(0xfb77, 500, 4, launcherSetup(0x10b0, 0x14));
  for (const [a, b] of [[0xfbb0, 0], [0xfbb1, 0], [0xfbb2, 0],
    [0xfbb3, 0], [0xfbb3, 2], [0xfbb3, 0x81]]) {
    check(a, 80, a + b, launcherSetup(0x10b0, 0x14), { b, u: 0x104a });
  }
});

test('sub_FC6D and tails FCA6-FCA9 launch formation positions', () => {
  check(0xfc6d, 500, 5, launcherSetup(0x10b5, 0x12));
  for (const [a, b] of [[0xfca6, 0], [0xfca7, 0], [0xfca8, 0],
    [0xfca9, 0], [0xfca9, 3], [0xfca9, 0xfe]]) {
    check(a, 80, a + b, launcherSetup(0x10b5, 0x12), { b, u: 0x1042 });
  }
});

test('sub_FD59 launches groups of three', () => {
  check(0xfd59, 500, 6, (r, poke, poke16) => {
    poke(0x112a, r.chance(0.1) ? 1 : 0);
    poke(0x10fe, r.chance(0.1) ? 1 : 0);
    poke(0x1013, r.chance(0.1) ? 1 : 0);
    poke16(0x10ba, r.pick([0x00ff, 0xffff, r.int(0x200)]));
    poke(0x10bc, r.int(8));
    poke(0x1020, r.chance(0.3) ? r.byte() : 0);
    for (let a = 0x103a; a < 0x1042; a += 2) poke16(a, r.int(0x200));
    const clear = r.pick([0, 0.05, 0.3, r.next()]);
    for (let a = 0x1860; a < 0x188c; a += 1) {
      poke(a, r.chance(clear) ? r.byte() & 0xfc : 1 + r.int(3));
    }
  });
});

test('sub_FE31 starts the $188A object', () => {
  check(0xfe31, 600, 7, (r, poke) => {
    poke(0x10f8, r.chance(0.15) ? 1 : 0);
    poke(0x10c1, r.chance(0.15) ? 1 : 0);
    poke(0x10fe, r.chance(0.1) ? 1 : 0);
    poke(0x1016, r.chance(0.8) ? r.int(4) << 6 : r.byte());
    poke(0x1070, r.pick([1, 1, 0, 2, r.byte()]));
    poke(0x10c0, r.pick([0, 1, 6, 0x0b, r.byte()]));
    poke(0x188a, r.chance(0.7) ? 0 : r.byte());
    poke(0x188b, r.pick([0, 1, 2, 3, r.byte()]));
  });
});

test('sub_FE82 runs the score animation', () => {
  check(0xfe82, 600, 8, (r, poke, poke16) => {
    poke(0x1176, r.chance(0.1) ? 1 : 0);
    poke(0x101e, r.chance(0.5) ? 0 : r.pick([1, 0x22, 0x23, r.byte()]));
    poke(0x102e, r.int(2));
    const v = r.byte();
    for (const a of [0x09b0, 0x09b1, 0x09b2, 0x09b3, 0x09b4, 0x09b5]) {
      poke(a, r.chance(0.8) ? v : r.byte());
    }
    poke16(0x1712, r.chance(0.3) ? 0xfc00 + r.int(0x400) : r.int(0x10000));
  });
});

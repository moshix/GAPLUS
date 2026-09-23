// Copyright 2026 by Moshix
/**
 * Oracle tests for the sub CPU's gp2-6.11b routines $F5A5-$FA2D
 * (src/game/sub/gp2_6_f5.js): the ROM task and the port task run from the
 * same seeded-random RAM, with targeted values that reach every branch,
 * and must leave identical RAM, IRQ mask and CWAI tick counts, and meet
 * the timing contract (sameTiming: total cycles, the cycle of every
 * SYNC = every shared access, every write and every CWAI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pair, randomize, same, rng, romTask, portTask, sameTiming,
} from './sub-gp2_6-kit.test.mjs';
import '../../src/game/sub/gp2_6.js';
import { SUB_AT } from '../../src/game/sub/routines.js';

/** @typedef {ReturnType<typeof rng>} Rng */
/** @typedef {(a: number, v: number) => void} Poke */

/**
 * The same tick on either side: what the IRQ changes during a CWAI is
 * stood in for by a new frame_counter and main-CPU state byte.
 * @param {{ mem: Uint8Array }} o @param {number} n
 */
const tick = (o, n) => { o.mem[0x1016] = (0x5a + n * 7) & 0xff; };

/**
 * Run task `addr` from `count` random states, each tweaked by `setup`,
 * on the oracle and the port, and compare.
 * @param {number} addr @param {number} seed @param {number} count
 * @param {(poke: Poke, r: Rng, i: number) => void} setup
 * @returns {number[]} tick counts seen (for coverage assertions)
 */
function checkTask(addr, seed, count, setup) {
  const { board, m, poke } = pair();
  const r = rng(seed);
  const fn = SUB_AT[addr];
  assert.equal(typeof fn, 'function', `$${addr.toString(16)} registered`);
  /** @type {number[]} */
  const ticks = [];
  for (let i = 0; i < count; i += 1) {
    randomize(board, m, seed * 1000 + i);
    setup(poke, r, i);
    const what = `$${addr.toString(16).toUpperCase()} #${i}`;
    const z = romTask(board, addr, { tick });
    const p = portTask(fn, m, { tick });
    same(board, m, what);
    assert.equal(p.ticks, z.ticks, `${what}: ticks`);
    sameTiming(z, p, what);
    ticks.push(z.ticks);
  }
  return ticks;
}

test('sub_F5A5 sprite sequence, end and mode change (CWAI)', () => {
  const steps = [0, 0x17, 0x97, 22, 1, 5, 21, 0x40, 0x41, 0x60, 0x80];
  const ticks = checkTask(0xf5a5, 1, 300, (poke, r, i) => {
    poke(0x1018, i < 150 ? steps[i % steps.length] : r.byte());
    poke(0x106f, r.chance(0.5) ? 0 : r.byte());
  });
  assert.ok(ticks.includes(1) && ticks.includes(0));
});

test('sub_F60B parity wait, sequence and tbl_F62B dispatch', () => {
  // Steps that stay inside dat_F0C1 or tbl_F62B (asla is 8-bit, so
  // $80-$9B mirror $00-$1B).
  const safe = [];
  for (let v = 0; v <= 0x1b; v += 1) safe.push(v, v | 0x80);
  checkTask(0xf60b, 2, 600, (poke, r, i) => {
    const step = i < 200 ? 0 : i < 260 ? 22 : r.pick(safe);
    poke(0x1018, step);
    const p = (r.byte() ^ r.byte()) & 1;
    poke(0x09b1, r.byte());
    poke(0x09b4, r.byte());
    poke(0x1017, r.chance(0.3) ? r.byte() : p);
    if (r.chance(0.5)) { poke(0x188a, 0x01); poke(0x188b, 0x03); }
    if (r.chance(0.5)) poke(0x1074, r.int(3));
    // F6D9 / F72C thresholds
    poke(0x172d, r.pick([0x57, 0x58, 0x59, 0xff, r.byte()]));
    if (r.chance(0.5)) poke(0x172c, r.pick([0xb7, 0xca, 0xd7, r.byte()]));
    if (r.chance(0.3)) poke(0x101d, 0x17);
    // F75D: all three sprites with bit 0, sometimes
    if (r.chance(0.5)) {
      for (const a of [0x1f27, 0x1f29, 0x1f2b]) poke(a, r.byte() | 1);
    }
    if (r.chance(0.5)) {
      for (let a = 0x1f17; a < 0x1f21; a += 2) {
        poke(a, r.chance(0.7) ? 0x80 | r.byte() : r.byte() & 0x7f);
      }
    }
    poke(0x102d, r.chance(0.5) ? 0 : r.byte());
  });
});

test('tbl_F62B targets directly', () => {
  for (const [k, addr] of [0xf6c7, 0xf6d9, 0xf72c, 0xf75d, 0xf79d]
    .entries()) {
    checkTask(addr, 10 + k, 200, (poke, r) => {
      if (r.chance(0.7)) poke(0x1074, r.int(3));
      poke(0x172d, r.pick([0x57, 0x58, 0x59, 0xff, r.byte()]));
      poke(0x172c, r.pick([0xb7, 0xca, 0xd7, r.byte()]));
      if (r.chance(0.3)) poke(0x101d, 0x17);
      if (r.chance(0.5)) {
        for (const a of [0x1f27, 0x1f29, 0x1f2b]) poke(a, r.byte() | 1);
      }
      if (r.chance(0.5)) {
        for (let a = 0x1f17; a < 0x1f21; a += 2) {
          poke(a, r.chance(0.8) ? 0x80 | r.byte() : r.byte() & 0x7f);
        }
      }
      poke(0x102d, r.chance(0.5) ? 0 : r.byte());
    });
  }
});

test('sub_F844 shot launch', () => {
  checkTask(0xf844, 3, 600, (poke, r, i) => {
    poke(0x09f4, i < 20 ? r.byte() : 0);
    poke(0x1035, r.chance(0.3) ? 0 : r.byte());
    poke(0x102f, r.chance(0.3) ? 3 : r.byte());
    const hit = r.chance(0.8);
    for (let n = 0; n < 42; n += 1) {
      poke(0x1860 + n, r.chance(0.2) ? r.byte() | 2 : r.byte() & ~2);
      if (hit && r.chance(0.3)) {
        poke(0x1631 + 2 * n, r.pick([0xa0, 0xc0]));
        poke(0x1e31 + 2 * n, r.byte() & 0xfe);
      }
      if (r.chance(0.6)) poke(0x1a10 + n, 0);
    }
    if (r.chance(0.8)) {
      const end = 0x0ece + 2 * r.int(40);
      poke(0x1064, end >> 8);
      poke(0x1065, end & 0xff);
      for (let a = 0x0ece; a < end; a += 2) {
        poke(a + 0x1001, r.chance(0.7) ? 0x80 | r.byte() : r.byte());
      }
    }
  });
});

test('sub_F8C9 shot velocity (every table)', () => {
  const { board, m, poke } = pair();
  const r = rng(4);
  for (let i = 0; i < 1500; i += 1) {
    randomize(board, m, 4000 + i, [[0x0800, 0x2000]]);
    const u = r.chance(0.8) ? 0x0ece + 2 * r.int(40) : r.int(0x1000);
    poke(0x1035, r.pick([6, 14, 22, 0, 1, 7, r.byte()]));
    poke(0x1600, r.byte());
    poke((u + 0x0801) & 0xffff, r.pick([0x9f, 0xa0, 0xcf, 0xd0, r.byte()]));
    const what = `sub_F8C9 #${i} u=$${u.toString(16)}`;
    const z = romTask(board, 0xf8c9, { rts: true, regs: { u } });
    const p = portTask(SUB_AT[0xf8c9], m, { regs: { u } });
    same(board, m, what);
    sameTiming(z, p, what);
  }
});

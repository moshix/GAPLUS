// Copyright 2026 by Moshix
/**
 * Oracle tests of src/game/sub/gp2_6_stage.js ($E18A-$E5A9): each task
 * runs on the oracle's sub CPU (romTask, to task_dispatch_sub) and on the
 * port from the same seeded-random RAM, with the branch-deciding
 * variables forced into every case; RAM must match byte for byte, and
 * the timing too (cycles, every write's cycle, the SYNC stamps).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pair, randomize, same, rng, romTask, portTask, sameTiming,
} from './sub-gp2_6-kit.test.mjs';
import '../../src/game/sub/gp2_6.js';
import { SUB_AT } from '../../src/game/sub/routines.js';

/**
 * Run task `addr` on both sides from the state `setup` builds, `n` times.
 * @param {number} addr @param {number} n @param {number} seed
 * @param {(r: ReturnType<typeof rng>, poke: (a: number, v: number) => void,
 *   poke16: (a: number, v: number) => void, i: number) => void} setup
 */
function taskCases(addr, n, seed, setup) {
  const { board, m, poke, poke16 } = pair();
  const r = rng(seed);
  for (let i = 0; i < n; i += 1) {
    randomize(board, m, seed * 1000 + i);
    setup(r, poke, poke16, i);
    const rom = romTask(board, addr);
    const port = portTask(SUB_AT[addr], m);
    const what = `$${addr.toString(16)} #${i}`;
    assert.equal(port.ticks, rom.ticks, `${what} ticks`);
    same(board, m, what);
    sameTiming(rom, port, what);
  }
}

/** A formation state: flags with bit 4/bit 0 mixed, codes near table. */
const CODES = [0x00, 0x21, 0x25, 0x2b, 0x10, 0x0b, 0x05, 0x01, 0x02,
  0x99, 0x2c, 0x11, 0xff];

/**
 * @param {ReturnType<typeof rng>} r
 * @param {(a: number, v: number) => void} poke
 */
function formation(r, poke) {
  for (let i = 0; i < 44; i += 1) {
    poke(0x1860 + i, r.chance(0.6) ? r.byte() | 0x10 : r.byte() & ~0x10);
    poke(0x18f0 + i, r.chance(0.8) ? r.pick(CODES) : r.byte());
  }
}

test('task_stage_setup $E18A: first pass (template copy)', () => {
  taskCases(0xe18a, 60, 1, (r, poke) => {
    poke(0x1081, 0);
    poke(0x106e, r.int(3));
    poke(0x1070, r.chance(0.7) ? r.int(6) : r.byte());
  });
});

test('task_stage_setup $E18A: second pass (formation layout)', () => {
  taskCases(0xe18a, 60, 2, (r, poke) => {
    poke(0x1081, r.chance(0.5) ? 1 : r.byte() | 1);
    // Stages 0-2 are real; others index further into the ROM tables.
    poke(0x106e, r.chance(0.7) ? r.int(3) : r.int(0x40));
  });
});

test('sub_E341 $E341: every frame & 7 target, $10AC, $10F8', () => {
  taskCases(0xe341, 200, 3, (r, poke, poke16, i) => {
    poke(0x10ac, i % 4 === 0 ? 0 : r.byte() | 1);
    poke(0x10f8, r.chance(0.5) ? 0 : r.byte());
    poke(0x1016, i & 0xff);
    poke(0x106e, r.chance(0.8) ? r.int(3) : r.byte());
    poke(0x1070, r.chance(0.8) ? r.int(6) : r.byte());
    // $1082: the path pointer -- the real path, or RAM we control.
    if (r.chance(0.5)) poke16(0x1082, 0xadcf + 4 * r.int(40));
    else poke16(0x1082, 0x1c00);
    if (r.chance(0.3)) poke(0x1c04, 0xff);
    formation(r, poke);
  });
});

test('sub_E369 $E369 (both $10AC exits)', () => {
  taskCases(0xe369, 120, 4, (r, poke, poke16, i) => {
    poke(0x10ac, i & 1 ? 0 : r.byte() | 1);
    poke(0x1016, r.byte());
    poke(0x106e, r.chance(0.8) ? r.int(3) : r.byte());
    poke16(0x1082, r.chance(0.5) ? 0xadcf : 0x1c00);
    formation(r, poke);
  });
});

test('sub_E3DA $E3DA: add/sub on both axes, carries, path end', () => {
  taskCases(0xe3da, 300, 5, (r, poke, poke16, i) => {
    poke16(0x1082, 0x1c00);
    poke(0x1c00, r.byte());
    poke(0x1c01, r.byte());
    poke(0x1c02, r.byte());
    poke(0x1c03, i & 3);
    poke(0x1c04, i % 5 === 0 ? 0xff : r.byte());
    formation(r, poke);
  });
});

test('sub_E4BD $E4BD and sub_E4B5 $E4B5', () => {
  taskCases(0xe4bd, 60, 6, (r, poke) => formation(r, poke));
  taskCases(0xe4b5, 60, 7, (r, poke) => formation(r, poke));
});

test('scan_formation $E51C (subroutine)', () => {
  const { board, m, poke } = pair();
  const r = rng(8);
  for (let i = 0; i < 200; i += 1) {
    randomize(board, m, 8000 + i);
    formation(r, poke);
    const rom = romTask(board, 0xe51c, { rts: true });
    const port = portTask(SUB_AT[0xe51c], m);
    same(board, m, `scan_formation #${i}`);
    sameTiming(rom, port, `scan_formation #${i}`);
  }
});

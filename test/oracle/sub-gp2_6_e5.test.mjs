// Copyright 2026 by Moshix
/**
 * Oracle tests of src/game/sub/gp2_6_e5.js ($E5AA-$EBEB): each task runs
 * on the oracle's sub CPU (romTask, to task_dispatch_sub) and on the port
 * (portTask) from identical seeded-random RAM with targeted values for
 * every branch; RAM, the sub IRQ latch, the tick counts and the timing
 * contract (sameTiming: total cycles, the cycle of every shared access =
 * the port's SYNC stamps, every write with its cycle) must match.
 * A last test checks that the oracle runs executed every instruction of
 * the range (branch coverage by construction).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  pair, randomize, same, rng, romTask, portTask, sameTiming,
} from './sub-gp2_6-kit.test.mjs';
import { ROOT } from '../../tools/romset.mjs';
import '../../src/game/sub/gp2_6.js';
import { SUB_AT } from '../../src/game/sub/routines.js';

/** Instruction addresses the oracle executed (sub CPU). */
const executed = new Set();

/**
 * Record every PC the oracle's sub core executes (the kit's probe owns
 * the core's trace hook, so this wraps step() instead).
 * @param {import('../m6809/board.mjs').Board} board
 */
function cover(board) {
  const c = board.cpus[1];
  const step = c.step.bind(c);
  c.step = () => { executed.add(c.pc); return step(); };
}

/**
 * @typedef {(a: number, v: number) => void} Poke
 * @typedef {ReturnType<typeof rng>} Rng
 */

/**
 * Run task `addr` on both sides `n` times from random states shaped by
 * `setup`, comparing after each run.
 * @param {number} addr @param {number} n @param {number} seed
 * @param {(r: Rng, poke: Poke, peek: (a: number) => number) => void}
 *   setup
 * @param {{ tick?: (o: { mem: Uint8Array }, n: number) => void }} [opts]
 */
function check(addr, n, seed, setup, opts = {}) {
  const { board, m, poke } = pair();
  cover(board);
  const r = rng(seed);
  const name = `$${addr.toString(16).toUpperCase()}`;
  for (let i = 0; i < n; i += 1) {
    randomize(board, m, seed * 7919 + i);
    setup(r, poke, (a) => m.mem[a]);
    const ro = romTask(board, addr, { tick: opts.tick });
    const po = portTask(SUB_AT[addr], m, { tick: opts.tick });
    same(board, m, `${name} #${i}`);
    assert.equal(po.ticks, ro.ticks, `${name} #${i}: ticks`);
    sameTiming(ro, po, `${name} #${i}`);
  }
}

/** Small value sets that sit on the branch edges. */
const edge = (/** @type {Rng} */ r, /** @type {number[]} */ vals) =>
  (r.chance(0.8) ? r.pick(vals) : r.byte());

test('sub_E5AA: slot 42 -> 43', () => {
  check(0xe5aa, 60, 1, (r, poke) => {
    poke(0x188a, r.byte());
  });
});

test('sub_E5B8: countdown and slot 42/43 states', () => {
  check(0xe5b8, 600, 2, (r, poke) => {
    poke(0x112c, r.chance(0.8) ? 0 : r.byte());
    poke(0x110f, r.chance(0.8) ? 0 : r.byte());
    poke(0x188a, r.chance(0.8) ? (r.byte() | 1) : r.byte());
    poke(0x112b, r.byte());
    poke(0x188b, r.byte());
    poke(0x0e86, r.byte());
    poke(0x106e, r.chance(0.8) ? r.int(3) : r.byte());
  });
});

test('sub_E654: capture steering states', () => {
  check(0xe654, 1500, 3, (r, poke, peek) => {
    poke(0x10ce, edge(r, [0, 1, 1, 1, 2, 3]));
    poke(0x10cd, r.chance(0.8) ? r.pick([0, 0, r.int(0x18) * 2]) : r.byte());
    const y = r.byte();
    poke(0x1600, y);
    poke(0x168a, r.chance(0.5) ? (y + r.int(3) - 1) & 0xff : r.byte());
    poke(0x1601, edge(r, [0xff, 0x47, 0x48, 0x49, 0x50, 0x10]));
    poke(0x1e01, r.int(4));
    if (r.chance(0.5)) poke(0x1e8b, peek(0x1e01) + (r.chance(0.3) ? 1 : 0));
    if (r.chance(0.5)) {
      const x = r.chance(0.5) ? peek(0x1601) : (peek(0x1601) + 1) & 0xff;
      poke(0x168b, (x - 5 + (r.chance(0.3) ? 1 : 0)) & 0xff);
    }
    if (r.chance(0.2)) poke(0x168b, 0xff);
    poke(0x1e8a, edge(r, [0x40, 0x41]));
    poke(0x0e8a, edge(r, [0, 1]));
  });
});

/**
 * Formation slots and their sprites near the player, so the capture
 * windows hit and miss by one.
 * @param {Rng} r @param {Poke} poke @param {number} dy half window
 */
function capture(r, poke, dy) {
  const y = r.byte();
  poke(0x1600, y);
  poke(0x1601, r.byte());
  poke(0x1e01, r.int(2));
  poke(0x1693, r.byte());
  poke(0x1e93, r.int(2));
  poke(0x10d6, r.chance(0.9) ? 1 : 0);
  poke(0x10d8, r.chance(0.5) ? r.int(0x40) : r.byte());
  for (let k = 0; k < 42; k += 1) {
    poke(0x1860 + k, r.chance(0.7) ? r.byte() | 2 : r.byte());
    poke(0x1630 + 2 * k, (y + r.int(2 * dy + 5) - dy - 2) & 0xff);
    poke(0x1631 + 2 * k, r.byte());
    poke(0x1e31 + 2 * k, r.int(2));
    poke(0x1e30 + 2 * k, edge(r, [0, 0, 2, 2, 1]));
    poke(0x0e30 + 2 * k, (r.byte() & 0xf0) | edge(r, [0, 0x0b, 5]));
  }
}

test('sub_E729: capture window, every slot', () => {
  check(0xe729, 300, 4, (r, poke) => {
    capture(r, poke, 7);
    // a wide X window so the animation paths are reached
    if (r.chance(0.5)) { poke(0x1e01, 1); poke(0x1601, 0xff); }
    if (r.chance(0.5)) { poke(0x1e93, 0); poke(0x1693, r.int(8)); }
  });
});

test('sub_E7FF: capture window with <$D8 creeping down', () => {
  check(0xe7ff, 300, 5, (r, poke) => {
    capture(r, poke, 9);
    poke(0x10d8, edge(r, [0x72, 0x73, 0x74, 0x75, 0x02, 0x80]));
    if (r.chance(0.5)) { poke(0x1e93, 1); poke(0x1693, 0xff); }
  });
});

test('sub_E7ED: dispatch on $10DA, all five states', () => {
  check(0xe7ed, 400, 6, (r, poke) => {
    capture(r, poke, 9);
    poke(0x10da, r.int(5));
    for (let k = 0; k < 6; k += 1) {
      poke(0x1ec3 + 2 * k, r.chance(0.8) ? r.byte() | 0x80 : r.byte());
    }
  });
});

test('sub_E8B0: stores the high half (ROM bug)', () => {
  check(0xe8b0, 50, 7, (r, poke) => { poke(0x1e93, r.byte()); });
});

test('sub_E8D7: caught slots to the six sprite slots', () => {
  check(0xe8d7, 300, 8, (r, poke) => {
    const p = r.next() * 0.4;
    for (let k = 0; k < 42; k += 1) {
      poke(0x1860 + k, r.chance(p) ? r.byte() | 0x40 : r.byte() & 0xbf);
    }
  });
});

test('sub_E934: captured sprites home in on the player', () => {
  check(0xe934, 800, 9, (r, poke) => {
    const y = r.byte();
    poke(0x1600, y);
    const offs = [0x10, 0xf0, 0x20, 0xe0, 0x30, 0xd0];
    const stopAt = r.chance(0.5) ? 6 : r.int(6);
    const exact = r.chance(0.3);
    for (let k = 0; k < 6; k += 1) {
      poke(0x1ec3 + 2 * k, k < stopAt ? r.byte() | 0x80 : r.byte() & 0x7f);
      const t = (y + offs[k]) & 0xff;
      poke(0x16c2 + 2 * k, exact ? t : (t + r.int(3) - 1) & 0xff);
    }
  });
});

test('sub_E9E8: captured sprites leave in X', () => {
  check(0xe9e8, 800, 10, (r, poke) => {
    const x = r.byte();
    poke(0x1601, x);
    const quiet = r.chance(0.4);
    for (let k = 0; k < 6; k += 1) {
      const f = r.byte();
      poke(0x1ec3 + 2 * k, quiet ? (r.chance(0.5) ? f & 0x7f : f | 0x81)
        : f);
      poke(0x16c3 + 2 * k, quiet ? x : edge(r, [0xff, x, 0xfe]));
    }
  });
});

test('sub_EA4C: formation refill', () => {
  check(0xea4c, 1500, 11, (r, poke) => {
    poke(0x1016, r.byte());
    poke(0x10fc, edge(r, [0, 0, 1, 5, 0x16, 0x17, 0x18, 0x18, 0x18]));
    poke(0x10f8, edge(r, [0, 1]));
    poke(0x1071, edge(r, [0, 1, 2, 4]));
    poke(0x10ff, edge(r, [3, 3, 0, 2]));
    poke(0x10fd, edge(r, [1, 1, 2]));
    const p = r.chance(0.3) ? 0.05 : 0.5;
    for (let k = 0; k < 42; k += 1) {
      poke(0x1860 + k, r.chance(p) ? r.byte() | 1 : r.byte() & 0xfe);
    }
    poke(0x1860 + r.int(42), r.byte() | 1); // never a full formation
  });
});

test('sub_EA4C: full formation spins until a slot frees up', () => {
  const { board, m, poke } = pair();
  cover(board);
  randomize(board, m, 12);
  poke(0x1016, 0x10);
  poke(0x10fc, 0x18);
  poke(0x10ff, 3);
  poke(0x10fd, 1);
  for (let k = 0; k < 42; k += 1) poke(0x1860 + k, 0x82);
  // Oracle: run to the `clrb` after the first (failed) search from
  // frame_counter & $3F = $10, then one failed pass from slot 0, free a
  // slot as the main CPU would, and continue from there.
  const r1 = romTask(board, 0xea4c, { stop: [0xeb29] });
  assert.equal(r1.pc, 0xeb29);
  // (romTask stops before executing a stop PC, so the failed pass from
  // slot 0 is run as clrb / bra to $EACA, then $EACA with B = 0 to $EB29.)
  const r2a = romTask(board, 0xeb29, { stop: [0xeaca] });
  const r2b = romTask(board, 0xeaca, { stop: [0xeb29], regs: { b: 0 } });
  assert.equal(r2b.pc, 0xeb29); // still spinning
  const r2 = {
    cycles: r2a.cycles + r2b.cycles,
    times: [...r2a.times, ...r2b.times.map((t) => t + r2a.cycles)],
    writes: [...r2a.writes, ...r2b.writes],
  };
  assert.deepEqual(r2.writes, []);
  board.mem[0x1870] = 0x01;
  const r3 = romTask(board, 0xeb29);
  // The three runs as one timeline.
  const at1 = r1.cycles;
  const at2 = r1.cycles + r2.cycles;
  /** @param {number[]} t @param {number} o */
  const sh = (t, o) => t.map((v) => v + o);
  const rom = {
    cycles: at2 + r3.cycles,
    times: [...r1.times, ...sh(r2.times, at1), ...sh(r3.times, at2)],
    writes: [...r1.writes, ...r2.writes.map(([t, a, v]) => [t + at1, a, v]),
      ...r3.writes.map(([t, a, v]) => [t + at2, a, v])],
    waits: [],
  };
  // Port: one BUSY per fruitless pass from slot 0 (the first pass
  // started at $10 and yields nothing); free the slot at the first.
  const po = portTask(SUB_AT[0xea4c], m, {
    tick: (o, n) => { if (n === 0) o.mem[0x1870] = 0x01; },
  });
  assert.equal(po.ticks, 1);
  same(board, m, 'full formation');
  sameTiming(/** @type {import('./sub-gp2_6-kit.test.mjs').Timing} */ (
    /** @type {unknown} */ (rom)), po, 'full formation');
});

test('every instruction of $E5AA-$EBEB ran on the oracle', () => {
  const asm = readFileSync(join(ROOT, 'reference/gaplus-sub.asm'), 'utf8');
  const missing = [];
  for (const line of asm.split('\n')) {
    const k = /^([0-9A-F]{4}): (?:[0-9A-F]{2} )+\s+([A-Z]+)/.exec(line);
    if (!k || k[2] === 'FCB' || k[2] === 'FDB') continue;
    const a = parseInt(k[1], 16);
    if (a < 0xe5aa || a > 0xebeb) continue;
    if (!executed.has(a)) missing.push(k[1]);
  }
  assert.deepEqual(missing, []);
});

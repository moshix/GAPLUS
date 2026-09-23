// Copyright 2026 by Moshix
/**
 * Oracle tests for main CPU $E21A-$EA20 (src/game/main/gp2_2b_results.js):
 * the challenging-stage results screen. Every case runs the ROM on the
 * oracle and the port on a Machine from the same seeded-random RAM plus a
 * per-case setup that steers the branches, and requires identical RAM,
 * latches and I/O state, and as many port yields as ROM CWAIs.
 * Routines outside the range are ROM-backed stubs (harness).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installStubs, pair, runRom, runPort, same, withStubs, romStub, rng,
  TASK_DISPATCH, hex4, sameTiming,
} from './main-gp2_2b_harness.mjs';
import { mainAt } from '../../src/game/main/routines.js';
import { SENTINEL } from '../helpers/oracle.mjs';

installStubs();

/** lD029 (gp2-3b, the demo's end) must not run here: record it. */
const LD029 = 0xd029;

/**
 * Run the task at `addr` on both sides and compare.
 * @param {number} seed
 * @param {number} addr
 * @param {(poke: (a: number, v: number) => void) => void} setup
 * @param {string} what
 */
function checkTask(seed, addr, setup, what) {
  const { board, m } = pair(seed, setup);
  const tickB = () => { board.mem[0x1016] = (board.mem[0x1016] + 1) & 0xff; };
  const tickM = () => { m.mem[0x1016] = (m.mem[0x1016] + 1) & 0xff; };
  const rom = runRom(board, addr, {}, {
    stopAt: [TASK_DISPATCH, LD029], onCwai: tickB,
  });
  let jumped = false;
  const port = withStubs({
    sub_FB9E: romStub(0xfb9e),
    lD029: () => { jumped = true; },
  }, () => runPort(mainAt(addr), m, {}, { onYield: tickM }));
  same(board, m, what);
  sameTiming(rom, port, what);
  assert.equal(port.yields, rom.cwai, `${what}: yields`);
  assert.equal(jumped, rom.pc === LD029, `${what}: lD029`);
  assert.ok(rom.pc === TASK_DISPATCH || rom.pc === LD029,
    `${what}: ROM stopped at $${hex4(rom.pc)}`);
}

/**
 * A random setup for the results screen: step, kind, counters at their
 * edges, digits mostly '0'-'9'.
 * @param {number} seed
 * @param {number} step results_step
 * @returns {(poke: (a: number, v: number) => void) => void}
 */
function scene(seed, step) {
  const r = rng(seed * 7919 + step);
  const pick = (/** @type {number[]} */ a) => a[r() % a.length];
  return (poke) => {
    poke(0x1160, step);
    poke(0x1166, r() % 4 === 0 ? r() & 0xff : r() & 7);
    poke(0x1171, r() & 7);
    poke(0x1172, r() & 7);
    poke(0x102d, r() & 1);
    poke(0x115b, pick([0xff, 0xfe, r() & 0xff]));
    poke(0x116a, pick([0xff, 0x00, 0xfe, 0x01, r() & 0xff]));
    poke(0x1164, pick([0x00, 0x01, 0x02, r() & 0x1f, r() & 0xff]));
    poke(0x1162, pick([0x00, 0x01, r() & 0x1f, r() & 0xff]));
    poke(0x1161, r() & 0xff);
    poke(0x09f4, pick([0, 0, 1]));
    poke(0x09a4, pick([0, 0, r() & 0xff]));
    poke(0x0f2c, pick([0x27, 0x30, r() & 0xff]));
    poke(0x172c, pick([0xca, 0xba, 0xcb, 0xbb, r() & 0xff]));
    poke(0x1f27, pick([0, r() & 0xff]));
    poke(0x1f29, pick([0, r() & 0xff]));
    poke(0x1726, pick([1, 2, r() & 0xff]));
    poke(0x1728, pick([1, 2, r() & 0xff]));
    poke(0x1163, r() & 0xff);
    poke(0x1169, pick([0x99, 0x98, r() & 0xff]));
    poke(0x116b, r() & 0xff);
    poke(0x115f, pick([0, 1])); // add_score's skip flag
    // score digits on screen: mostly decimal tiles
    for (const a of [0x0134, 0x0136, 0x013a, 0x0154, 0x0156, 0x015a,
      0x0174, 0x0176, 0x017a]) {
      poke(a, r() % 5 === 0 ? r() & 0xff : 0x30 + (r() % 10));
    }
    // The tile sub_E2D0 tests for "no bonus" ($20)
    if (r() & 1) {
      for (const a of [0x00ea, 0x00aa, 0x0088, 0x0068, 0x006b, 0x00cb,
        0x00ab]) poke(a, 0x20);
    }
  };
}

test('task_results: every step, random scenes', () => {
  for (let step = 0; step < 6; step += 1) {
    for (let s = 1; s <= 40; s += 1) {
      checkTask(s * 10 + step, 0xe21a, scene(s, step), `step ${step} #${s}`);
    }
  }
});

test('pay-out entries sub_E66F..sub_E83B by kind (lE654)', () => {
  for (let kind = 0; kind < 8; kind += 1) {
    for (let s = 1; s <= 12; s += 1) {
      const base = scene(s + 100, 4);
      checkTask(s + 500 + kind, 0xe3ad, (poke) => {
        base(poke);
        poke(0x1166, kind);
        poke(0x116a, 0); // go to lE654
      }, `kind ${kind} #${s}`);
    }
  }
});

test('lE3B5 wrap: stage advance, CWAI, mode 0 or lD029', () => {
  for (let s = 1; s <= 16; s += 1) {
    checkTask(s + 700, 0xe3ad, (poke) => {
      scene(s + 300, 4)(poke);
      poke(0x116a, 0xff);
      poke(0x09f4, s & 1);
      poke(0x102d, (s >> 1) & 1);
    }, `wrap #${s}`);
  }
});

test('sub_E2D0: marker lists incl. $1000+ entries, bonus or none', () => {
  for (let s = 1; s <= 40; s += 1) {
    checkTask(s + 900, 0xe2d0, (poke) => {
      scene(s + 400, 2)(poke);
      poke(0x1162, s % 3 === 0 ? (s * 37) & 0xff : s % 12);
    }, `E2D0 #${s}`);
  }
});

test('sub_E3FF, sub_E4DA, sub_E6C8: subroutines', () => {
  for (let s = 1; s <= 60; s += 1) {
    for (const addr of [0xe3ff, 0xe4da, 0xe6c8]) {
      const set = scene(s + 1100, 1);
      const { board, m } = pair(s + 1000 + addr, (poke) => {
        set(poke);
        if (addr === 0xe6c8) poke(0x1164, 1 + (s % 4));
      });
      const rom = runRom(board, addr, {}, { stopAt: [] });
      assert.equal(rom.pc, SENTINEL);
      const port = runPort(mainAt(addr), m, {});
      same(board, m, `$${hex4(addr)} #${s}`);
      sameTiming(rom, port, `$${hex4(addr)} #${s}`);
    }
  }
});

test('print_string_attr: registers out', () => {
  const strings = [0xe86c, 0xe87e, 0xe8b4, 0xe9fe, 0xe9eb, 0xea11];
  for (let s = 0; s < 24; s += 1) {
    const regs = {
      x: [0x02f0, 0x031c, 0x0010, 0x03fe][s % 4],
      u: strings[s % strings.length], b: (s * 29) & 0xff,
    };
    const { board, m } = pair(s + 1300);
    const rom = runRom(board, 0xe85c, regs, { stopAt: [] });
    const port = runPort(mainAt(0xe85c), m, regs);
    const out = /** @type {{ a: number, x: number, u: number,
      zf: boolean }} */ (port.out);
    same(board, m, `print #${s}`);
    sameTiming(rom, port, `print #${s}`);
    assert.deepEqual([out.a, out.x, out.u, out.zf],
      [rom.a, rom.x, rom.u, rom.zf], `print #${s}: registers`);
  }
});

test('sub_E3FF: 200-point markers ($1000+), hundreds carry, $0214', () => {
  for (let s = 1; s <= 48; s += 1) {
    const { board, m } = pair(s + 1500, (poke) => {
      scene(s + 1600, 1)(poke);
      poke(0x1166, s & 7);
      poke(0x1164, 56 + (s % 32));
      poke(0x1169, [0x98, 0x99, 0x48, 0x97][s % 4]);
      poke(0x0176, [0x31, 0x30, 0x39][s % 3]);
      poke(0x0174, 0x31);
    });
    const rom = runRom(board, 0xe3ff, {}, { stopAt: [] });
    assert.equal(rom.pc, SENTINEL);
    const port = runPort(mainAt(0xe3ff), m, {});
    same(board, m, `E3FF 200 #${s}`);
    sameTiming(rom, port, `E3FF 200 #${s}`);
  }
});

test('sub_E346: fire button pressed (56XX $6805/$6807 bit 1)', () => {
  for (let s = 1; s <= 16; s += 1) {
    const { board, m } = pair(s + 1700, (poke) => {
      scene(s + 1800, 3)(poke);
      poke(0x1166, s & 1 ? 1 : 4);
      poke(0x09a4, 0);
      poke(0x116a, s & 2 ? 0x03 : 0x10);
    });
    // Same nibble in both chips' RAM (read back as $F0 | nibble).
    const io = s & 4 ? 0x6805 : 0x6807;
    m.poke(io, s & 8 ? 0x02 : 0x0d);
    board.machine.poke(io, s & 8 ? 0x02 : 0x0d);
    const rom = runRom(board, 0xe346, {}, {});
    assert.equal(rom.pc, TASK_DISPATCH);
    const port = runPort(mainAt(0xe346), m, {});
    same(board, m, `E346 fire #${s}`);
    sameTiming(rom, port, `E346 fire #${s}`);
  }
});

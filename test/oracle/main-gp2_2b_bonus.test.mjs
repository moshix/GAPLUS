// Copyright 2026 by Moshix
/**
 * Oracle tests for main CPU $FA7D-$FEAF (src/game/main/gp2_2b_bonus.js):
 * task_bonus_life and its steps, sub_FB9E, sub_FBB1, sub_FC1F, sub_FC33,
 * operator_stats and sub_FE18. Each runs as ROM on the oracle and as the
 * port from the same seeded state; RAM, latches, I/O state, yields and
 * consumed registers must match.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installStubs, pair, runRom, runPort, same, sameTiming, withStubs, rng,
  TASK_DISPATCH, hex4, LABEL,
} from './main-gp2_2b_harness.mjs';
import { mainAt } from '../../src/game/main/routines.js';
import { mainRom } from '../../src/game/romdata.js';

installStubs();

/** The eight dsw_bonus rows ($E1B2): first, second, every. */
const BONUS = [0xe1b2, 0xe1b5, 0xe1b8, 0xe1bb, 0xe1be, 0xe1c1, 0xe1c4,
  0xe1c7].map((p) => [mainRom(p), mainRom(p + 1), mainRom(p + 2)]);

/**
 * @typedef {object} CaseOpts
 * @property {(poke: (a: number, v: number) => void,
 *   r: () => number) => void} [setup] RAM setup (both machines)
 * @property {Array<[number, number]>} [io] I/O nibbles to write on both
 * @property {object} [regs]
 * @property {number[]} [stopAt] more ROM stop addresses
 * @property {number} [spin] passes of the $FC71 loop before it ends
 * @property {number} [spinEnd] value $107A takes then (0 or $1B)
 * @property {string[]} [out] consumed output registers to compare
 * @property {boolean} [irq] runs inside irq_main: no SYNCs, so compare
 *   the cycles and timed writes only
 */

/**
 * Run the ROM routine and the port routine at `addr` from the same
 * state and compare everything.
 * @param {number} addr @param {number} seed @param {CaseOpts} [o]
 * @returns {{ rom: import('./main-gp2_2b_harness.mjs').RomRun,
 *   port: { out: unknown, yields: number } }}
 */
function check(addr, seed, o = {}) {
  const r = rng(seed * 7919 + addr);
  const { board, m } = pair(seed, o.setup ? (p) => o.setup?.(p, r) : undefined);
  for (const [a, v] of o.io ?? []) {
    m.poke(a, v);
    board.machine.poke(a, v);
  }
  let passes = 0;
  port0.yields = 0;
  const spin = o.spin ?? 0;
  const rom = runRom(board, addr, o.regs ?? {}, {
    stopAt: [TASK_DISPATCH, ...(o.stopAt ?? [])],
    stopWhen: (b) => {
      if (b.cpus[0].pc === 0xfc71) {
        passes += 1;
        if (spin > 0 && passes > spin) b.mem[0x107a] = o.spinEnd ?? 0;
      }
      return false;
    },
  });
  const port = runPort(mainAt(addr), m, o.regs ?? {}, {
    onYield: () => {
      if (port0.yields + 1 >= spin) m.mem[0x107a] = o.spinEnd ?? 0;
      port0.yields += 1;
    },
  });
  const what = `$${hex4(addr)} seed ${seed}`;
  same(board, m, what);
  if (o.irq) {
    assert.equal(port.cycles, rom.cycles, `${what}: cycles`);
    assert.deepEqual(port.trace.writes, rom.writes, `${what}: timed writes`);
    assert.deepEqual(port.syncs, [], `${what}: SYNC in the IRQ`);
  } else {
    sameTiming(rom, port, what);
  }
  const romSpins = Math.max(0, passes - 1);
  assert.equal(port0.yields, romSpins, `${what}: SPIN yields`);
  port0.yields = 0;
  for (const k of o.out ?? []) {
    assert.equal(port.out?.[k], /** @type {any} */ (rom)[k], `${what}: ${k}`);
  }
  return { rom, port };
}
/** Yield counter shared with check()'s onYield. */
const port0 = { yields: 0 };

test('task_bonus_life: every step, both players, every DIP row', () => {
  let n = 0;
  for (let seed = 1; seed <= 400; seed += 1) {
    const row = BONUS[seed % 8];
    const p2 = (seed >> 3) & 1;
    const step = (seed >> 4) & 3;
    check(0xfa7d, seed, {
      setup: (poke, r) => {
        poke(0x102d, p2);
        poke(0x1124, p2 ? r() & 0xff : step);
        poke(0x1125, p2 ? step : r() & 0xff);
        poke(0x1001, row[0]); poke(0x1002, row[1]); poke(0x1003, row[2]);
        const s = p2 ? 0x09b3 : 0x09b0;
        const k = r() % 4;
        // score+1 around the threshold of this step
        const thr = step === 0 ? row[0] : step === 1 ? row[1] : r() & 0xff;
        poke(s + 1, k === 3 ? r() & 0xff : (thr + k - 1) & 0xff);
        poke(s + 2, r() % 3 === 0 ? r() & 0xff : r() & 0x03);
        const nx = p2 ? 0x117d : 0x117b;
        if (r() & 1) poke(nx, r() & 0x03);
        if (r() & 1) poke(nx + 1, 0x90 + (r() & 0x0f));
        if (r() & 1) poke(0x1003, 0x99);
        // the extra-ship flags
        for (const f of [0x1f17, 0x1f19, 0x1f1b, 0x1f1d]) {
          poke(f, r() & 1 ? 0x80 | r() : r() & 0x7f);
        }
      },
    });
    n += 1;
  }
  assert.equal(n, 400);
});

test('sub_FB9E: flags, registers', () => {
  for (let seed = 1; seed <= 64; seed += 1) {
    check(0xfb9e, seed, {
      setup: (poke) => {
        for (let i = 0; i < 5; i += 1) {
          poke(0x1f17 + 2 * i, ((seed >> i) & 1) ? 0x80 : 0x00);
        }
      },
      out: ['a', 'x'],
    });
  }
});

test('sub_FBB1: timer, READY, blank', () => {
  const timers = [0, 1, 2, 0x61, 0xd1, 0x60, 0xd0];
  for (let seed = 1; seed <= 200; seed += 1) {
    check(0xfbb1, seed, {
      setup: (poke, r) => {
        poke(0x1016, seed % 5 === 0 ? 8 * (r() & 0x1f) : r() & 0xff);
        poke(0x102d, seed & 1);
        const t = seed % 9 < 7 ? timers[seed % 9] : r() & 0xff;
        poke(seed & 1 ? 0x1024 : 0x1023, t);
        poke(0x1e01, r() & 0xff);
      },
    });
  }
});

test('sub_FC1F: both strings and random ROM', () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const x = seed === 1 ? 0xfc07 : seed === 2 ? 0xfc13
      : 0xa000 + ((seed * 977) & 0x3fff);
    check(0xfc1f, seed, { regs: { x }, out: ['a', 'b', 'x', 'u'] });
  }
});

test('sub_FC33: game-over check, spin on the sub, TOP 5 copy', () => {
  let da87 = 0;
  const marker = () => { da87 += 1; };
  // $DA87 (gp2-3b), whatever the listing calls it today
  const da87Name = Object.keys(LABEL).find((k) => LABEL[k] === 0xda87);
  assert.ok(da87Name);
  withStubs({ [/** @type {string} */ (da87Name)]: marker }, () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const lives = seed % 7 === 0;
      const spin = seed % 5;
      const before = da87;
      const { rom } = check(0xfc33, seed, {
        setup: (poke, r) => {
          poke(0x1104, lives ? r() & 0xff : r() & 0xf0);
          poke(0x1105, lives ? 0x01 : r() & 0xf0);
          const busy = (r() | 1) === 0x1b ? 0x1d : r() | 1;
          poke(0x107a, spin === 0 ? ((seed >> 3) & 1 ? 0x1b : 0) : busy);
          poke(0x102f, seed & 2 ? 9 : r() & 0x0f);
        },
        io: [[0x6802, seed % 4 === 0 ? 1 : 0],
          [0x6800, (seed >> 2) & 1], [0x6801, (seed >> 5) & 1 ? 3 : 0],
          [0x6805, (seed >> 3) & 1 ? 8 : 2], [0x6807, (seed >> 4) & 1 ? 8 : 0]],
        stopAt: [0xda87],
        spin,
        spinEnd: (seed >> 6) & 1 ? 0x1b : 0,
      });
      assert.equal(da87 - before, rom.pc === 0xda87 ? 1 : 0,
        `seed ${seed}: lDA87`);
    }
  });
  assert.ok(da87 > 20);
});

test('operator_stats: SW1:6, fire, idle column blank', () => {
  for (let seed = 1; seed <= 120; seed += 1) {
    check(0xfcdf, seed, {
      setup: (poke, r) => {
        poke(0x1016, seed % 3 === 0 ? 0 : r() & 0xff);
        poke(0x09ff, seed % 6 === 0 ? 7 : r() & 0xff);
      },
      io: [[0x6816, seed & 1 ? 0x04 : seed & 0x0b],
        [0x6805, seed & 2 ? 0x02 : (seed >> 2) & 0x0d]],
      irq: true,
    });
  }
});

test('sub_FE18: bonus ship spawn and touch', () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    check(0xfe18, seed, {
      setup: (poke, r) => {
        const mode = seed % 3;
        poke(0x102d, (seed >> 2) & 1);
        if (mode === 0) {
          // out: player somewhere around the ship
          poke(0x1f15, 0x80 | r());
          const y = r() & 0xff;
          const x = r() & 0xff;
          poke(0x1714, y);
          poke(0x1715, x);
          poke(0x1600, (y + (r() % 20) - 10) & 0xff);
          poke(0x1601, (x + (r() % 12) - 6) & 0xff);
        } else {
          poke(0x1f15, r() & 0x7f);
          poke(0x1175, seed % 11 === 0 ? 1 : 0);
          // 0, 1 or 2 occupied formation slots
          for (let i = 0x1860; i <= 0x188a; i += 1) poke(i, r() & 0xfe);
          const k = (seed >> 3) % 3;
          const i = (r() & 0x1f);
          if (k >= 1) poke(0x1860 + (mode === 1 ? i : r() % 43), 1);
          if (k === 2) poke(0x1860 + ((i + 3) & 0x1f), 0x81);
          const st = r() & 0x3f;
          poke(0x1035, st);
          poke(0x09b0, mode === 1 ? (i - st) & 0xff : r() & 0xff);
        }
      },
    });
  }
});

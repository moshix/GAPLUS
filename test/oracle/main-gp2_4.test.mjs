// Copyright 2026 by Moshix
/**
 * Differential tests for main CPU $A000-$BFFF (src/game/main/gp2_4*.js),
 * part 1: mode 9 (TOP 5 check, screen, name entry), load_formation_
 * sprites and the plain service-mode helpers. Each routine runs on the
 * oracle (the real ROM) and in the port from identical seeded-random
 * RAM and I/O state; RAM, latches, I/O chips, the frames waited (CWAI)
 * and where control went must match. The service mode itself is tested
 * frame by frame in main-gp2_4-svc.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callRoutine } from '../helpers/oracle.mjs';
import { mainRom, romWord } from '../../src/game/romdata.js';
import { MAIN, MAIN_AT, mainAt } from '../../src/game/main/routines.js';
import {
  board, runRom, runPort, fresh, same, installStubs, jumps, rng, hex,
  TASK_DISPATCH,
} from './main-gp2_4-lib.test.mjs';
import { clockOf, setClock } from '../../src/game/clock.js';

installStubs();

/** Where a mode-9 task can leave to. */
const EXITS = [TASK_DISPATCH, 0xdbe2, 0xdc0b];

/**
 * Run the mode-9 task ($AFBE) on both sides and compare.
 * @param {import('../../src/machine/machine.js').Machine} m
 * @param {string} what
 * @returns {import('./main-gp2_4-lib.test.mjs').RomRun}
 */
function cmpTask(m, what) {
  const o = runRom(board, 0xafbe, {}, { stops: EXITS });
  const p = runPort(mainAt(0xafbe), m);
  same(m, what);
  assert.equal(p.yields, o.cwai, `${what}: frames waited`);
  if (o.pc === TASK_DISPATCH) {
    assert.deepEqual(jumps, [], `${what}: no jump`);
  } else {
    assert.deepEqual(jumps, [o.pc], `${what}: jumped to $${hex(o.pc)}`);
  }
  return o;
}

/** Union of the ROM PCs executed by a group of cases. */
function coverage() {
  const all = new Set();
  return {
    add: (/** @type {Set<number>} */ s) => { for (const p of s) all.add(p); },
    has: (/** @type {number} */ pc) => all.has(pc),
  };
}

// ---------------------------------------------------------------- mode 9

test('registration: every routine and jump-table target', () => {
  for (const a of [0xafbe, 0xafcd, 0xb304, 0xb49f, 0xb656, 0xb6f6, 0xb77c,
    0xba2f, 0xbd7b, 0xbe01, 0xbe15, 0xbe1d, 0xbe25, 0xbe37]) {
    assert.equal(typeof MAIN_AT[a], 'function', `$${hex(a)}`);
  }
  // hiscore_steps ($AFC7) and tasks_mode9[0] ($FFCA)
  for (let i = 0; i < 3; i += 1) {
    assert.equal(typeof MAIN_AT[romWord('main', 0xafc7 + 2 * i)], 'function');
  }
  assert.equal(MAIN_AT[romWord('main', 0xffca)], MAIN.task_hiscore_entry);
});

test('hiscore_check: rank 1-5, ties, below the table, both players', () => {
  const cov = coverage();
  for (let seed = 1; seed <= 240; seed += 1) {
    const r = rng(seed);
    const m = fresh(seed, (mm) => {
      mm.poke(0x11ff, 0); // hiscore_step 0
      mm.poke(0x102d, r() & 1); // cur_player
      // Digits from a 2- or 3-letter alphabet so comparisons go deep.
      const alpha = r() & 1 ? [0x30, 0x31] : [0x20, 0x30, 0x39];
      const digit = () => alpha[r() % alpha.length];
      for (let e = 0; e < 5; e += 1) {
        for (let i = 0; i < 8; i += 1) mm.poke(0x0900 + e * 16 + i, digit());
      }
      const y = mm.peek(0x102d) ? 0x03eb : 0x03fd;
      const tie = r() % 6;
      for (let i = 0; i < 8; i += 1) {
        // Sometimes exactly equal to an entry (a tie)
        const v = tie < 5 && r() % 3 === 0
          ? mm.peek(0x0900 + tie * 16 + i) : digit();
        mm.poke(y - i, v);
      }
    });
    const o = cmpTask(m, `seed ${seed}`);
    cov.add(o.pcs);
  }
  // every rank and the "not in the TOP 5" exit were exercised
  for (const pc of [0xb529, 0xb53c, 0xb54f, 0xb562, 0xb575, 0xb526,
    0xb618, 0xb62a, 0xb63c, 0xb603]) {
    assert.ok(cov.has(pc), `path $${hex(pc)} covered`);
  }
});

test('hiscore_draw_screen: the TOP 5 screen with the new row', () => {
  for (let seed = 300; seed < 340; seed += 1) {
    const r = rng(seed);
    const m = fresh(seed, (mm) => {
      mm.poke(0x11ff, 1);
      const k = r() % 6;
      mm.poke16(0x09a2, k < 5 ? 0x024f + 3 * k : 0x0200 + (r() & 0x1ff));
    });
    cmpTask(m, `seed ${seed}`);
  }
});

/**
 * Random name-entry state: cursor in any field, timers, alphabet index,
 * inputs (the 56XX nibbles are poked directly), flip, fire latch.
 * @param {() => number} r
 */
function nameEntrySetup(r) {
  /** @param {import('../../src/machine/machine.js').Machine} mm */
  return (mm) => {
    mm.poke(0x11ff, 2);
    const row = 0x024f + 3 * (r() % 5);
    mm.poke16(0x09a2, (row - 0x20 * (r() % 17)) & 0xffff);
    mm.poke16(0x09a0, 0x0200 + (r() & 0x1ff));
    mm.poke(0x1016, r() % 5 === 0 ? 0 : r() & 0xff); // frame_counter
    const t = r() % 4;
    mm.poke(0x09a5, t === 0 ? 1 : t === 1 ? 0xff : r() & 0xff);
    mm.poke(0x116c, r() % 5 === 0 ? 0 : r() % 30);
    mm.poke(0x116d, r() % 3 === 0 ? 0 : r() % 9);
    mm.poke16(0x09a7, r() & 1 ? 0x6043 : 0x6044);
    mm.poke(0x09a4, r() & 1);
    mm.poke(0x102c, r() % 3 === 0 ? 1 : 0); // flip_screen
    mm.poke(0x102d, r() & 1);
    for (let i = 4; i < 8; i += 1) mm.poke(0x6800 + i, r() & 0x0f);
    // Now and then the first TOP 5 row holds a secret name.
    if (r() % 4 === 0) {
      let u = 0x024f;
      for (let x = 0xb146; mainRom(x) !== 0; x += 1) {
        mm.poke(u, mainRom(x));
        u -= 0x20;
      }
    }
  };
}

test('hiscore_enter_name: stick, fire, fields, timer, finish', () => {
  const cov = coverage();
  for (let seed = 1000; seed < 1600; seed += 1) {
    const m = fresh(seed, nameEntrySetup(rng(seed)));
    const o = cmpTask(m, `seed ${seed}`);
    cov.add(o.pcs);
  }
  for (const pc of [0xb345, 0xb34a, 0xb36f, 0xb374, 0xb38b, 0xb3a2, 0xb393,
    0xb399, 0xb3d0, 0xb407, 0xb3a8, 0xb3df, 0xb461, 0xb47d, 0xb482, 0xb496,
    0xb212, 0xb225, 0xb22b, 0xb25f, 0xb2ee, 0xb2f9]) {
    assert.ok(cov.has(pc), `path $${hex(pc)} covered`);
  }
});

test('hiscore_enter_name: the "JNIWAR" name hangs on the staff screen', () => {
  for (let seed = 1700; seed < 1706; seed += 1) {
    const m = fresh(seed, (mm) => {
      nameEntrySetup(rng(seed))(mm);
      mm.poke(0x1016, 0); // frame_counter 0 ...
      mm.poke(0x09a5, 1); // ... and the timer runs out now
      let u = 0x024f;
      for (let x = 0xb155; mainRom(x) !== 0; x += 1) {
        mm.poke(u, mainRom(x));
        u -= 0x20;
      }
    });
    // ROM: stop when the endless loop comes round to $B241 again.
    runRom(board, 0xafbe, {}, {
      stops: EXITS, stopIf: (pc, n) => pc === 0xb241 && n === 2,
    });
    assert.equal(board.cpus[0].pc, 0xb241);
    const g = mainAt(0xafbe)(m, {});
    const s = g.next();
    assert.equal(s.done, false, 'the port keeps looping');
    same(m, `seed ${seed}`);
    // ... and keeps writing the same screen every frame
    g.next();
    same(m, `seed ${seed}, next pass`);
  }
});

test('task_hiscore_entry: hiscore_step 3+ jumps through ROM words', () => {
  // Only 0-2 occur; the dispatch reads the word after the table like
  // the 6809 would, and fails loudly if nothing is registered there.
  const m = fresh(1, (mm) => mm.poke(0x11ff, 3));
  assert.throws(() => runPort(mainAt(0xafbe), m), /no routine registered/);
});

// ------------------------------------------------ load_formation_sprites

test('load_formation_sprites: the three formations', () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    const m = fresh(seed, (mm) => mm.poke(0x106e, seed % 3));
    callRoutine(board, 'main', 0xb656);
    runPort(mainAt(0xb656), m);
    same(m, `formation ${seed % 3}`);
  }
});

// ---------------------------------------------------- service helpers

test('print_string: strings from ROM and RAM, returned X and U', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const r = rng(seed);
    const src = seed & 1 ? 0xb0bf : 0x1100 + (r() & 0xff);
    const u = 0x0200 + (r() & 0x1ff);
    const m = fresh(seed, (mm) => {
      if (src < 0xa000) {
        const n = r() % 20;
        for (let i = 0; i < n; i += 1) mm.poke(src + i, 1 + (r() % 255));
        mm.poke(src + n, 0);
      }
    });
    const o = callRoutine(board, 'main', 0xba2f, { x: src, u });
    const p = runPort(mainAt(0xba2f), m, { x: src, u }).out;
    same(m, `seed ${seed}`);
    assert.deepEqual(p, { x: o.x, u: o.u });
  }
});

test('fill_tilemap_00_20, draw_test_grid, sub_BE15, sub_BE1D', () => {
  let m = fresh(5);
  let o = callRoutine(board, 'main', 0xb77c);
  /** @param {number} a @param {object} [r] */
  const out = (a, r = {}) => /** @type {Record<string, number>} */ (
    runPort(mainAt(a), m, r).out);
  let p = out(0xb77c);
  same(m, 'fill_tilemap_00_20');
  assert.equal(p.x, o.x);

  m = fresh(6);
  o = callRoutine(board, 'main', 0xbe01);
  p = out(0xbe01);
  same(m, 'draw_test_grid');
  assert.deepEqual(p, { a: o.a, b: o.b, x: o.x, u: o.u });

  for (let seed = 7; seed < 17; seed += 1) {
    const r = rng(seed);
    const u = (r() & 0x7fe);
    const x = r() & 0xffff;
    m = fresh(seed);
    o = callRoutine(board, 'main', 0xbe15, { u });
    p = out(0xbe15, { u });
    same(m, 'sub_BE15');
    assert.deepEqual(p, { a: o.a, x: o.x, u: o.u });
    m = fresh(seed);
    o = callRoutine(board, 'main', 0xbe1d, { u, x });
    p = out(0xbe1d, { u, x });
    same(m, 'sub_BE1D');
    assert.deepEqual(p, { a: o.a, u: o.u });
  }
});

test('delay_65536: 787,734 cycles, D kept, frames yielded', () => {
  const m = fresh(9);
  const o = callRoutine(board, 'main', 0xbe25, { d: 0x1234 });
  assert.equal(o.cycles, 787734);
  assert.equal(o.d, 0x1234);
  setClock(m, 20000);
  const p = runPort(mainAt(0xbe25), m);
  same(m, 'delay_65536');
  assert.equal(m.charged[0], 787734);
  // 20,000 + 787,734 cycles: 31 frame boundaries crossed
  assert.equal(p.yields, Math.floor((20000 + 787734) / 25344));
  assert.equal(clockOf(m).t, (20000 + 787734) % 25344);
});

test('easter_egg: the bitmap, then the endless watchdog loop', () => {
  const m = fresh(11);
  /** @type {Array<[number, number, number]>} */
  const ow = [];
  const o = runRom(board, 0xbe37, {}, { stops: [0xbe72], writes: ow });
  // The port: every write stamped with the cycles burned before it
  // (the clock burns up to the start of each writing instruction).
  /** @type {Array<[number, number, number]>} */
  const pw = [];
  const w = m.busWrite.bind(m);
  m.busWrite = (cpu, a, v) => { pw.push([m.charged[0], a, v]); w(cpu, a, v); };
  const g = mainAt(0xbe37)(m, {});
  // Into the hang loop: it burns 25,340 cycles per step.
  while (m.charged[0] < o.cycles + 3 * 25340) g.next();
  same(m, 'easter_egg');
  assert.deepEqual(pw, ow, 'every write at the same cycle');
});

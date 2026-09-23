// Copyright 2026 by Moshix
/**
 * Oracle tests for main CPU ROM gp2-3b.8c $C296-$CCCF
 * (src/game/main/gp2_3b_attract.js): game_init, attract_loop and every
 * routine a pass of it runs.
 *
 * The pass code is busy-loop code, so besides RAM, latches and I/O chips
 * the TIMED write sequences must match: every write the ROM makes, with
 * the cycle at which its instruction starts, against the port's writes
 * with the cycles it had charged when it wrote. The exit (back to
 * attract_loop with register A, or a jump to start_game_1p/2p) and the
 * total cycles must match too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../src/game/main/gp2_3b.js';
import { mainAt } from '../../src/game/main/routines.js';
import { takeJump } from '../../src/game/main/gp2_3b_state.js';
import { attract_pass } from '../../src/game/main/gp2_3b_attract.js';
import {
  makePair, romRun, portRun, writeLog, same, ri, romWrites, portWrites,
} from './main-gp2_3b.util.mjs';
import { makeOracle, loadState } from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';

const EXITS = [0xc417, 0xccd0, 0xcdff];

/**
 * Random attract-mode state that reaches every branch of a pass.
 * @param {import('../../src/machine/machine.js').Machine} m
 * @param {() => number} rnd
 * @param {{ credits?: boolean }} [o]
 */
function attractState(m, rnd, o = {}) {
  const n56 = m.io.n56.ram;
  for (let i = 0; i < 16; i += 1) n56[i] = ri(rnd, 16);
  const credits = o.credits ?? rnd() < 0.4;
  if (credits) {
    n56[0] = rnd() < 0.3 ? 1 + ri(rnd, 9) : 0;
    n56[1] = ri(rnd, 4);
  } else {
    n56[0] = 0;
    n56[1] = 0;
  }
  n56[3] = rnd() < 0.6 ? 0 : ri(rnd, 16);
  if (rnd() < 0.5) n56[5] &= 7;
  if (rnd() < 0.5) n56[7] &= 7;
  if (rnd() < 0.3) m.poke(0x102a, 0xff);
  if (rnd() < 0.3) m.poke(0x1029, 0xe0);
  m.poke(0x117a, ri(rnd, 4));
  if (rnd() < 0.3) m.poke(0x1615, 0xfe);
  if (rnd() < 0.3) m.poke(0x161c, 0xa7);
  if (rnd() < 0.5) m.poke(0x04c2, 0);
  if (rnd() < 0.5) {
    m.poke(0x039b, 0x20);
    m.poke(0x036b, 0x20);
  }
  if (rnd() < 0.3) m.poke(0x1002, m.peek(0x1002) & 0x0f);
}

/**
 * Run ROM `entry` until it jumps to one of EXITS, and the port's `fn`;
 * compare everything.
 * @param {number} seed @param {number} entry
 * @param {(m: object) => unknown} fn the port side
 * @param {(m: object, rnd: () => number) => void} [setup]
 * @param {object} [regs]
 */
function exitCase(seed, entry, fn, setup, regs = {}) {
  const { board, m } = makePair(seed, (mm, rnd) => {
    attractState(mm, rnd);
    setup?.(mm, rnd);
  });
  const rom = romRun(board, entry, { regs, stops: EXITS, log: true });
  const log = writeLog(m);
  const port = portRun(fn(m), m);
  const what = `$${entry.toString(16)} seed ${seed}`;
  assert.ok(port.done, `${what}: done`);
  assert.deepEqual(portWrites(log, true),
    romWrites(rom.writes, { timed: true }), `${what}: timed writes`);
  same(board, m, what);
  assert.equal(m.charged[0], rom.cycles, `${what}: cycles`);
  const jump = takeJump(m);
  if (rom.pc === 0xc417) {
    assert.equal(jump, null, `${what}: no jump`);
    const out = /** @type {{ a: number }} */ (port.value);
    assert.equal(out.a, rom.regs.a, `${what}: A`);
  } else {
    assert.equal(jump, rom.pc, `${what}: jump`);
  }
  return rom;
}

test('attract_loop: one pass, every phase and push-start path', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 400; seed += 1) {
    const a = seed & 0xff;
    const rom = exitCase(seed, 0xc417, (m) => attract_pass(m, { a }),
      undefined, { a });
    seen.add(rom.pc);
  }
  assert.equal(seen.size, 3, 'all three exits');
});

test('attract phases and push-start screens entered directly', () => {
  for (const entry of [0xc492, 0xc49f, 0xc4da, 0xc670, 0xc866, 0xc909,
    0xc91b, 0xc952, 0xc9ae, 0xcaa9]) {
    for (let seed = 1; seed <= 40; seed += 1) {
      exitCase(seed * 7 + entry, entry, (m) => mainAt(entry)(m, {}));
    }
  }
});

test('attract_loop: three passes in a row', () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    const { board, m } = makePair(seed, (mm, rnd) => {
      attractState(mm, rnd, { credits: false });
      mm.io.n56.ram[3] = 0;
    });
    const rom = romRun(board, 0xc417, {
      regs: { a: 5 }, stops: [0xccd0, 0xcdff], marks: [0xc417],
      maxEvents: 3, log: true,
    });
    const log = writeLog(m);
    const g = mainAt(0xc417)(m, { a: 5 });
    // Stop once the 4th pass has stored to $7400 (the oracle stops at
    // that instruction; the latch store changes no RAM).
    let passes = 0;
    for (;;) {
      const r = g.next();
      if (r.done) break;
      passes = log.filter(([, addr]) => addr === 0x7400).length;
      if (passes > 3) break;
    }
    const what = `3 passes seed ${seed}`;
    const pw = portWrites(log, true);
    // The 4th pass's `sta $7400` starts where the oracle stopped.
    if (passes > 3) {
      const last = /** @type {number[]} */ (pw.pop());
      assert.equal(last[0], rom.cycles, `${what}: cycles`);
    } else {
      assert.equal(m.charged[0], rom.cycles, `${what}: cycles`);
      assert.equal(takeJump(m), rom.pc);
    }
    assert.deepEqual(pw, romWrites(rom.writes, { timed: true }), what);
    same(board, m, what);
  }
});

test('game_init: header, 62XX init (CWAIs), high scores, to attract', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const { board, m } = makePair(seed, (mm, rnd) => {
      mm.io.n56.ram[3] = rnd() < 0.5 ? 0 : 1 + ri(rnd, 15);
    });
    const rom = romRun(board, 0xc296, {
      stops: [0xc417], log: true,
      polls: [[0xc321, 0x6821], [0xc34a, 0x6822]].map(([pc, io]) => ({
        pc, end: pc + 9, cost: 12,
        busy: (b) => (b.machine.io.read(io) & 0x0f) !== 0x0f,
      })),
    });
    const log = writeLog(m);
    const port = portRun(mainAt(0xc296)(m), m);
    const what = `game_init seed ${seed}`;
    const waits = port.events.filter((e) => e.kind !== 'busy');
    assert.deepEqual(waits.map((e) => e.cycles),
      rom.events.map((e) => e.cycles), `${what}: waits`);
    assert.equal(rom.events.filter((e) => e.kind === 'cwai').length, 5);
    // Timed: before the IRQ is enabled every write is a SYNC point, so
    // each lands in the frame it does on the board (see the next test).
    assert.deepEqual(portWrites(log, true),
      romWrites(rom.writes, { timed: true }), what);
    same(board, m, what);
    assert.equal(m.charged[0], rom.cycles, `${what}: cycles`);
    assert.equal(takeJump(m), 0xc417);
  }
});

test('game_init on the board: the header appears in the ROM\'s frame', () => {
  // Boot the real board to game_init and note, for every main-CPU write
  // game_init makes before its first CWAI, the frame it lands in. The
  // port, started at the same cycle of the same frame, must put each
  // write (SYNC points at the charged cycle) in the same frame.
  const b = makeOracle();
  b.runUntil((bb) => bb.frame >= 230, 400);
  let entry = null;
  /** @type {Array<[number, number, number]>} */
  const romFrames = [];
  b.onExec = (n, pc) => {
    if (n !== 0) return;
    if (pc === 0xc296 && entry === null) {
      entry = { frame: b.frame, cycle: b.frameCycle() };
    }
  };
  b.onWrite = (n, a, v) => {
    const pc = b.cpus[0].ppc;
    if (n === 0 && entry !== null && pc >= 0xc296 && pc < 0xc318) {
      romFrames.push([b.frame, a, v]);
    }
  };
  b.runUntil(() => romFrames.some(([, a]) => a === 0x682f), 20);
  b.onExec = null;
  b.onWrite = null;
  assert.ok(entry !== null, 'game_init reached');
  const hdr = romFrames.find(([, a]) => a === 0x03c5);
  assert.ok(hdr[0] > entry.frame, 'the ROM draws the header a frame on');
  // The port from the same RAM: frame of each write from its SYNC time.
  const m = new Machine();
  loadState(m, b, { latches: true });
  const log = writeLog(m);
  const g = mainAt(0xc296)(m);
  while (!log.some(([, a]) => a === 0x682f)) g.next();
  const portFrames = log.filter(([, a]) => a !== 0x7400).map(([t, a, v]) =>
    [entry.frame + Math.floor((entry.cycle + t) / 25344), a, v]);
  assert.deepEqual(portFrames,
    romFrames.filter(([, a]) => a !== 0x7400));
});

test('helpers: draw_credit, print_string_r, clear_game_vars, '
  + 'clear_playfield', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    for (const [entry, regs] of [[0xc467, {}], [0xc811, {}], [0xc854, {}],
      [0xc639, { x: 0x0318, u: 0xc7df }], [0xc639, { x: 0x031a,
        u: 0xc6d2 }]]) {
      const { board, m } = makePair(seed, attractState);
      const rom = romRun(board, entry, { regs, log: true });
      const log = writeLog(m);
      const port = portRun(mainAt(entry)(m, regs), m);
      const what = `$${entry.toString(16)} seed ${seed}`;
      assert.ok(port.done);
      assert.deepEqual(portWrites(log, true),
        romWrites(rom.writes, { timed: true }), what);
      same(board, m, what);
      assert.equal(m.charged[0], rom.cycles, `${what}: cycles`);
      if (entry === 0xc639) {
        const out = /** @type {{ x: number, u: number }} */ (port.value);
        assert.equal(out.x, rom.regs.x);
        assert.equal(out.u, rom.regs.u);
      }
    }
  }
});

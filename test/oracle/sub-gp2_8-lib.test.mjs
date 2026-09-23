// Copyright 2026 by Moshix
/**
 * Shared helpers for the gp2-8.11d oracle tests (sub-gp2_8*.test.mjs).
 * This file defines no tests of its own beyond a smoke test of the task
 * runner; the others import it.
 *
 *   pair()                     an oracle board and a port Machine with
 *                              identical RAM
 *   runRom(board, addr, regs)  run a sub-CPU routine or task on the
 *                              oracle until its RTS or its
 *                              `jmp task_dispatch_sub`, resuming after
 *                              each CWAI (counted)
 *   runPort(fn, m, regs)       the same for a port routine (generator
 *                              yields counted)
 *   capturePlay()              real entry states of the chip's routines,
 *                              recorded during a scripted game
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeOracle, loadState, diffRam, randomPlayer, SENTINEL,
} from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';
import { GP2_8_ROUTINES } from '../../src/game/sub/gp2_8.js';
import { timed, SYNC } from '../../src/game/sub/gp2_8_util.js';

export { GP2_8_ROUTINES };

/** @typedef {import('../m6809/board.mjs').Board} Board */

/** task_dispatch_sub: where every task of the sub CPU ends. */
export const DISPATCH = 0xe0ec;
/** Sub stack top (reset_sub's LDS). */
const TOP = 0x1d80;

/**
 * The tasks of this chip (entered by `jmp [b,u]` from the dispatcher with
 * S at the stack top, not by JSR): runRom pushes no return address for
 * them, so a CWAI stacks exactly where it does in the game.
 */
export const TASKS = new Set([0xb014, 0xb385, 0xb3d1, 0xb3f2, 0xb5a1,
  0xb860, 0xb90e, 0xb92b, 0xbb50, 0xbb96, 0xbcf3, 0xbee5, 0xbf58]);

/**
 * A board and a Machine with the same RAM.
 * @returns {{ board: Board, m: Machine }}
 */
export function pair() {
  const board = makeOracle();
  const m = new Machine();
  loadState(m, board);
  return { board, m };
}

/**
 * Write a byte into both RAMs (main-CPU addresses).
 * @param {{ board: Board, m: Machine }} p @param {number} a @param {number} v
 */
export function poke2(p, a, v) {
  p.board.mem[a] = v & 0xff;
  p.m.mem[a] = v & 0xff;
}

/**
 * Put an 8 KB snapshot of $0000-$1FFF into both.
 * @param {{ board: Board, m: Machine }} p @param {Uint8Array} ram
 */
export function setRam(p, ram) {
  p.board.mem.set(ram, 0);
  p.m.mem.set(ram, 0);
}

/**
 * Run a sub-CPU ROM routine from `addr` on the oracle (only the sub CPU
 * steps) until it returns to the pushed sentinel or jumps to
 * task_dispatch_sub. A CWAI is resumed at once (as if the IRQ had run
 * and returned) and counted. Also returns the cycles from entry to the
 * RTS / final JMP inclusive, and `times`: the cycle (from entry) at
 * which each instruction that touched a timed address (gp2_8_util.js
 * `timed`: shared RAM, not the stack) began -- where the port must
 * yield SYNC with exactly that many cycles charged.
 * @param {Board} board @param {number} addr
 * @param {{a?: number, b?: number, x?: number, y?: number, u?: number}}
 *   [regs]
 * @returns {{ a: number, b: number, x: number, y: number, u: number,
 *   cwai: number, dispatched: boolean, cycles: number, times: number[] }}
 */
export function runRom(board, addr, regs = {}) {
  const c = board.cpus[1];
  c.setState({
    a: regs.a ?? 0, b: regs.b ?? 0, x: regs.x ?? 0, y: regs.y ?? 0,
    u: regs.u ?? 0, dp: 0x10, cc: 0x50, pc: addr, s: TOP, wait: 0,
  });
  c.irqLine = false;
  if (!TASKS.has(addr)) {
    // JSR pushes the return address: low byte at S-1, high at S-2.
    board.mem[TOP - 2] = SENTINEL >> 8;
    board.mem[TOP - 1] = SENTINEL & 0xff;
    c.s = TOP - 2;
  }
  let cwai = 0;
  let cycles = 0;
  let start = 0;
  let marked = -1;
  /** @type {number[]} */
  const times = [];
  const mach = board.machine;
  const proto = Object.getPrototypeOf(mach);
  /** @param {number} n @param {number} a */
  const mark = (n, a) => {
    if (n === 1 && timed(a) && marked !== start) {
      times.push(start);
      marked = start;
    }
  };
  mach.busRead = function busRead(/** @type {number} */ n,
    /** @type {number} */ a) {
    mark(n, a);
    return proto.busRead.call(this, n, a);
  };
  mach.busWrite = function busWrite(/** @type {number} */ n,
    /** @type {number} */ a, /** @type {number} */ v) {
    mark(n, a);
    proto.busWrite.call(this, n, a, v);
  };
  const save = board.syncOnLatch;
  board.syncOnLatch = false;
  try {
    for (;;) {
      if (c.pc === SENTINEL && c.s === TOP) break;
      if (c.pc === DISPATCH) break;
      start = cycles;
      cycles += c.step();
      if (c.wait !== 0) {
        // CWAI stacked the entire state (12 bytes) with PC after it:
        // "take the IRQ and RTI" = drop the frame and go on.
        cwai += 1;
        c.wait = 0;
        c.s = (c.s + 12) & 0xffff;
      }
      if (cycles > 20_000_000) {
        throw new Error(`$${addr.toString(16)} runs away at `
          + `$${c.pc.toString(16)}`);
      }
    }
  } finally {
    board.syncOnLatch = save;
    delete mach.busRead;
    delete mach.busWrite;
  }
  return {
    a: c.a, b: c.b, x: c.x, y: c.y, u: c.u, cwai, cycles, times,
    dispatched: c.pc === DISPATCH,
  };
}

/**
 * Run a port routine to its end: count the frames it waits (plain
 * `yield`), stamp the sub's charged cycles at every SYNC, total them.
 * @param {Function} fn @param {Machine} m @param {object} [regs]
 * @returns {{ out: unknown, yields: number, cycles: number,
 *   times: number[] }}
 */
export function runPort(fn, m, regs = {}) {
  const c0 = m.charged[1];
  const r = fn(m, regs);
  if (!(r && typeof r === 'object' && typeof r.next === 'function')) {
    return { out: r, yields: 0, cycles: m.charged[1] - c0, times: [] };
  }
  let yields = 0;
  /** @type {number[]} */
  const times = [];
  for (;;) {
    const n = r.next();
    if (n.done) {
      return { out: n.value, yields, cycles: m.charged[1] - c0, times };
    }
    if (n.value === SYNC) times.push(m.charged[1] - c0);
    else if (n.value === undefined) yields += 1;
    else throw new Error(`unexpected yield ${String(n.value)}`);
  }
}

/**
 * Assert identical RAM (stacks exempt) and the sub IRQ mask.
 * @param {{ board: Board, m: Machine }} p @param {string} what
 */
export function same(p, what) {
  const d = diffRam(p.board, p.m);
  assert.deepEqual(d, [], `${what}: RAM differs\n${d.join('\n')}`);
  assert.equal(p.m.irqMask[1], p.board.machine.irqMask[1],
    `${what}: sub IRQ mask`);
}

/**
 * Run ROM and port from the same state, compare RAM, CWAI/yield count,
 * the cycle of every timed access (SYNC stamps) and the total cycles.
 * @param {{ board: Board, m: Machine }} p @param {number} addr
 * @param {{a?: number, b?: number, x?: number, y?: number, u?: number}}
 *   regs @param {string} what
 * @returns {{ rom: ReturnType<typeof runRom>, port: unknown }}
 */
export function check(p, addr, regs, what) {
  const rom = runRom(p.board, addr, regs);
  const port = runPort(GP2_8_ROUTINES[addr], p.m, regs);
  same(p, what);
  assert.equal(port.yields, rom.cwai, `${what}: frames waited`);
  assert.deepEqual(port.times, rom.times, `${what}: timed accesses`);
  assert.equal(port.cycles, rom.cycles, `${what}: cycles`);
  return { rom, port: port.out };
}

/** @param {number} seed @returns {() => number} 32-bit values */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/**
 * @typedef {object} Capture
 * @property {number} pc entry address
 * @property {number} frame
 * @property {{a: number, b: number, x: number, y: number, u: number}} regs
 * @property {Uint8Array} ram $0000-$1FFF at entry
 */

/** @type {Capture[] | null} */
let CAPTURES = null;

/**
 * Entry states of gp2-8 routines seen during a scripted game: coin,
 * start, random play, and after the first death a Round Advance to
 * PARSEC 3 (the challenging stage), as tools/coverage.mjs does. Up to
 * `perEntry` states per entry address, spread over the session.
 * @param {number} [frames] @param {number} [perEntry]
 * @returns {Capture[]}
 */
export function capturePlay(frames = 7000, perEntry = 40) {
  if (CAPTURES) return CAPTURES;
  const b = makeOracle();
  b.tap('coin1', 300);
  b.tap('start1', 360);
  const rp = randomPlayer(4, { from: 370 });
  let at = Infinity;
  const steps = 2;
  b.inputScript = (f, bb) => {
    if (at === Infinity && f > 400 && bb.mem[0x102f] === 0
      && bb.mem[0x1104] === 2) at = f;
    const end = at + 20 + steps * 20;
    if (f === at) bb.setDip('roundAdvance', 0);
    const k = f - at - 10;
    if (k >= 0 && k < steps * 20 && k % 20 === 0) bb.setInput('up', true);
    if (k >= 0 && k < steps * 20 && k % 20 === 8) bb.setInput('up', false);
    if (f === end) bb.setDip('roundAdvance', 8);
    if (f < at || f > end) rp(f, bb);
  };
  /** @type {Record<number, number>} */
  const hits = {};
  /** @type {Record<number, number>} */
  const kept = {};
  /** @type {Capture[]} */
  const out = [];
  b.onExec = (n, pc, c) => {
    if (n !== 1 || GP2_8_ROUTINES[pc] === undefined) return;
    const h = hits[pc] ?? 0;
    hits[pc] = h + 1;
    // The first few, then a thinning sample (powers of two, every 211th)
    const take = h < 6 || (h & (h - 1)) === 0 || h % 211 === 0;
    if (!take || (kept[pc] ?? 0) >= perEntry) return;
    kept[pc] = (kept[pc] ?? 0) + 1;
    out.push({
      pc, frame: b.frame,
      regs: { a: c.a, b: c.b, x: c.x, y: c.y, u: c.u },
      ram: b.mem.slice(0, 0x2000),
    });
  };
  b.runFrames(frames);
  b.onExec = null;
  CAPTURES = out;
  return out;
}

test('runRom stops at the dispatcher and counts a CWAI', () => {
  const p = pair();
  // task_formation_init ($BF58) CWAIs once, then jmp task_dispatch_sub
  const r = runRom(p.board, 0xbf58);
  assert.equal(r.dispatched, true);
  assert.equal(r.cwai, 1);
});

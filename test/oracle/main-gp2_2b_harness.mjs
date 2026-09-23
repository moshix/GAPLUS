// Copyright 2026 by Moshix
/**
 * Shared test harness for the main CPU $E000-$FFFF port (gp2_2b*.js):
 * seeded state pairs, ROM-backed stubs for the other chips, a ROM runner
 * that stops at task_dispatch and steps over CWAI, and a port runner that
 * counts yields. Used by test/oracle/main-gp2_2b*.test.mjs. It defines no
 * tests itself.
 *
 * ISOLATION. Only gp2_2b.js is imported, so routines of gp2-4 and gp2-3b
 * are missing from MAIN/MAIN_AT. installStubs() fills every such label
 * with a stub that copies the port's RAM and latches into a scratch
 * board, runs the ORIGINAL routine there until its RTS (or until it jumps
 * to task_dispatch), and copies everything back. The stubs are exact by
 * construction, so these tests check $E000-$FFFF alone.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeOracle, loadState, diffRam, fillRandom, SENTINEL, DEFAULT_DP,
} from '../helpers/oracle.mjs';
import { ROOT } from '../../tools/romset.mjs';
import { CC_I, CC_F } from '../m6809/m6809.mjs';
import { Machine } from '../../src/machine/machine.js';
import '../../src/game/main/gp2_2b.js';
import { MAIN, MAIN_AT } from '../../src/game/main/routines.js';

/** @typedef {import('../m6809/board.mjs').Board} Board */

/** The one oracle board the tests share (state is reloaded every time). */
export const ORACLE = makeOracle();

/** main S top ($E00F LDS #$1600). */
const TOP = 0x1600;

/** $FEB5 task_dispatch: a task "returns" by jumping here. */
export const TASK_DISPATCH = 0xfeb5;

/**
 * @typedef {object} RomRun
 * @property {number} a @property {number} b @property {number} d
 * @property {number} x @property {number} y @property {number} u
 * @property {number} cc
 * @property {boolean} cf @property {boolean} zf @property {boolean} nf
 * @property {boolean} vf
 * @property {number} pc   where it stopped (SENTINEL after an RTS)
 * @property {number} cwai CWAIs stepped over
 * @property {number} cycles from entry to the stop, the CWAIs included
 *   (16 each: what the core charges for the instruction), the wake-up not
 * @property {Array<[number, number, number]>} writes the main CPU's
 *   writes outside the stack as [cycle the instruction started, address,
 *   value], in order
 */

/** The main stack, [lo, hi): pushes are not compared. */
const STACK = [0x15e2, 0x1600];

/** @param {number} a main-CPU address @returns {boolean} */
const isStack = (a) => a >= STACK[0] && a < STACK[1];

/**
 * Run a ROM routine of the main CPU on `board` until it returns (RTS to
 * the sentinel), or until PC reaches one of `stopAt` (default: only
 * task_dispatch). Every CWAI is stepped over: `onCwai(board)` stands in
 * for the IRQ handler, then the stacked state is pulled back (as RTI
 * would). Only the main CPU runs; the frame clock is frozen. Every write
 * is logged with the cycle at which its instruction started.
 * @param {Board} board
 * @param {number} addr
 * @param {{a?: number, b?: number, d?: number, x?: number, y?: number,
 *   u?: number, cc?: number}} [regs]
 * @param {{ stopAt?: number[], onCwai?: (b: Board) => void,
 *   maxCycles?: number, stopWhen?: (b: Board) => boolean }} [opts]
 * @returns {RomRun}
 */
export function runRom(board, addr, regs = {}, opts = {}) {
  const c = board.cpus[0];
  const stopAt = new Set(opts.stopAt ?? [TASK_DISPATCH]);
  const maxCycles = opts.maxCycles ?? 5_000_000;
  c.setState({
    a: regs.a ?? 0, b: regs.b ?? 0, x: regs.x ?? 0, y: regs.y ?? 0,
    u: regs.u ?? 0, dp: DEFAULT_DP[0], cc: (regs.cc ?? 0) | CC_I | CC_F,
    pc: addr, s: TOP, wait: 0,
  });
  if (regs.d !== undefined) c.d = regs.d;
  const line = c.irqLine;
  c.irqLine = false;
  board.machine.poke16(TOP - 2, SENTINEL);
  c.s = TOP - 2;
  let cycles = 0;
  let cwai = 0;
  /** @type {Array<[number, number, number]>} */
  const writes = [];
  const saveWrite = board.onWrite;
  board.onWrite = (n, a, v) => {
    if (n === 0 && !isStack(a & 0xffff)) writes.push([cycles, a & 0xffff, v]);
    saveWrite?.(n, a, v);
  };
  const save = board.syncOnLatch;
  board.syncOnLatch = false;
  try {
    for (;;) {
      if (c.pc === SENTINEL && c.s === TOP) break;
      if (stopAt.has(c.pc) && cycles > 0) break;
      if (opts.stopWhen?.(board)) break;
      cycles += c.step();
      if (c.wait !== 0) {
        // CWAI: the entire state is stacked. Let the "IRQ" happen, then
        // pull it all back as RTI would (not counted: the scheduler
        // charges the wake-up).
        cwai += 1;
        opts.onCwai?.(board);
        c.wait = 0;
        c.pull(0xff, false);
      }
      if (cycles > maxCycles) {
        throw new Error(`ROM $${hex4(addr)} ran ${cycles} cycles `
          + `(pc $${hex4(c.pc)})`);
      }
    }
  } finally {
    board.onWrite = saveWrite;
    board.syncOnLatch = save;
    const q = board.syncQueue;
    board.syncQueue = [];
    for (const f of q) f();
    c.irqLine = line;
  }
  const cc = c.cc;
  return {
    a: c.a, b: c.b, d: c.d, x: c.x, y: c.y, u: c.u, cc,
    cf: (cc & 1) !== 0, vf: (cc & 2) !== 0, zf: (cc & 4) !== 0,
    nf: (cc & 8) !== 0, pc: c.pc, cwai, cycles, writes,
  };
}

/**
 * Is `v` a generator object?
 * @param {unknown} v @returns {v is Generator<unknown, unknown, unknown>}
 */
export function isGen(v) {
  return v !== null && typeof v === 'object'
    && typeof (/** @type {{ next?: unknown }} */ (v)).next === 'function';
}

// ------------------------------------------------------------ timing

/** scheduler.js SYNC: "charged up to here; what follows may race". */
export const SYNC = Symbol.for('gaplus.sync');

export { RACY, isRacy } from '../../src/game/main/gp2_2b_state.js';
import { isRacy } from '../../src/game/main/gp2_2b_state.js';

/**
 * @typedef {object} PortTrace
 * @property {Array<[number, number, number]>} writes [charged, addr, v]
 *   of every main-CPU write outside the stack (stub writes included,
 *   stamped with the stub's own cycles)
 * @property {Array<[number, number]>} racy [charged, addr] of every racy
 *   RAM access made by ported code (not by stubs)
 */

/** @type {WeakMap<Machine, PortTrace>} */
const TRACES = new WeakMap();

/**
 * Start logging the port's main-CPU accesses on `m` (idempotent). The
 * stamp of an access is m.charged[0] when it happens: ported code
 * charges each instruction after performing it, so that is the cycle
 * the instruction started.
 * @param {Machine} m @returns {PortTrace}
 */
export function traceOf(m) {
  let t = TRACES.get(m);
  if (t !== undefined) return t;
  const tr = { writes: [], racy: [] };
  t = tr;
  TRACES.set(m, tr);
  const w = m.busWrite.bind(m);
  const r = m.busRead.bind(m);
  m.busWrite = (cpu, a, v) => {
    const addr = a & 0xffff;
    if (cpu === 0) {
      if (!isStack(addr)) tr.writes.push([m.charged[0], addr, v & 0xff]);
      if (isRacy(addr)) tr.racy.push([m.charged[0], addr]);
    }
    w(cpu, a, v);
  };
  m.busRead = (cpu, a) => {
    if (cpu === 0 && isRacy(a & 0xffff)) tr.racy.push([m.charged[0], a & 0xffff]);
    return r(cpu, a);
  };
  return tr;
}

/**
 * @typedef {object} PortRun
 * @property {unknown} out what the routine returned
 * @property {number} yields frame yields (CWAI, polls: everything but
 *   SYNC)
 * @property {number[]} syncs m.charged[0] at each `yield SYNC`
 * @property {number} cycles cycles charged during the run
 * @property {PortTrace} trace writes and racy accesses of this run
 */

/**
 * Run a port routine to completion, tracing it. A generator is resumed
 * until it returns; SYNC yields are recorded (their stamp) and resumed at
 * once; at every other yield `onYield(m, value)` runs (the same stand-in
 * for the IRQ as runRom's onCwai). `maxYields` guards endless loops.
 * @param {Function} fn
 * @param {Machine} m
 * @param {object} [regs]
 * @param {{ onYield?: (m: Machine, v: unknown) => void,
 *   maxYields?: number }} [opts]
 * @returns {PortRun}
 */
export function runPort(fn, m, regs = {}, opts = {}) {
  const tr = traceOf(m);
  const w0 = tr.writes.length;
  const r0 = tr.racy.length;
  const c0 = m.charged[0];
  /** @type {number[]} */
  const syncs = [];
  const done = (/** @type {unknown} */ out, /** @type {number} */ yields) => ({
    out, yields, syncs, cycles: m.charged[0] - c0,
    trace: {
      writes: tr.writes.slice(w0).map(([t, a, v]) => [t - c0, a, v]),
      racy: tr.racy.slice(r0).map(([t, a]) => [t - c0, a]),
    },
  });
  const r = fn(m, regs);
  if (!isGen(r)) return done(r, 0);
  let yields = 0;
  const max = opts.maxYields ?? 100_000;
  for (let n = 0; ; n += 1) {
    const s = r.next();
    if (s.done) return done(s.value, yields);
    if (n > max) throw new Error(`port routine yielded ${max} times`);
    if (s.value === SYNC) {
      syncs.push(m.charged[0] - c0);
      continue;
    }
    yields += 1;
    opts.onYield?.(m, s.value);
  }
}

/**
 * Require exact timing: the same total cycles as the ROM, the same writes
 * in the same order at the same instruction-start cycles, and a SYNC at
 * the stamp of every racy access the ported code made.
 * @param {RomRun} rom @param {PortRun} port @param {string} what
 */
export function sameTiming(rom, port, what) {
  assert.equal(port.cycles, rom.cycles, `${what}: cycles`);
  assert.deepEqual(port.trace.writes, rom.writes, `${what}: timed writes`);
  const syncs = new Set(port.syncs);
  const unsynced = port.trace.racy.filter(([t]) => !syncs.has(t))
    .map(([t, a]) => `$${hex4(a)}@${t}`);
  assert.deepEqual(unsynced, [], `${what}: racy access without SYNC`);
}

// ------------------------------------------------------------- state

/** @param {number} seed @returns {() => number} 32-bit random numbers */
export function rng(seed) {
  let s = (seed >>> 0) || 0x2545f491;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

/**
 * A fresh port Machine and the shared oracle with the same seeded random
 * RAM and the same latches and I/O chip state (a fresh chip set).
 * `setup(poke)` then pokes the same bytes into both.
 * @param {number} seed
 * @param {(poke: (addr: number, v: number) => void) => void} [setup]
 * @returns {{ board: Board, m: Machine }}
 */
export function pair(seed, setup) {
  const m = new Machine();
  fillRandom(m, seed);
  if (setup) setup((addr, v) => { m.mem[addr] = v & 0xff; });
  const board = ORACLE;
  loadState(board, m, { latches: true });
  return { board, m };
}

/**
 * Poke the same byte into both (RAM only, no side effects).
 * @param {Board} board @param {Machine} m @param {number} addr
 * @param {number} v
 */
export function both(board, m, addr, v) {
  board.mem[addr] = v & 0xff;
  m.mem[addr] = v & 0xff;
}

/**
 * Require identical RAM (stacks excluded), latches and I/O chip state.
 * @param {Board} board @param {Machine} m @param {string} what
 */
export function same(board, m, what) {
  assert.deepEqual(diffRam(board, m), [], `${what}: RAM differs`);
  const b = board.machine;
  assert.deepEqual(m.irqMask, b.irqMask, `${what}: IRQ masks`);
  assert.equal(m.sreset, b.sreset, `${what}: SRESET`);
  assert.deepEqual([...m.starCtrl], [...b.starCtrl], `${what}: starfield`);
  assert.deepEqual(m.io.getState(), b.io.getState(), `${what}: I/O chips`);
}

// ------------------------------------------------------------- stubs

/** Scratch boards for the ROM-backed stubs, one per nesting depth. */
/** @type {Board[]} */
const SCRATCH = [];
let depth = 0;

/**
 * A plain stub for the ROM routine at `addr`: runs it on a scratch board
 * with the port's RAM and latches until its RTS (or a jump to
 * task_dispatch) and copies the result back; it charges the routine's
 * cycles and logs its writes at their cycles. Throws on a CWAI (use a
 * test-specific stub for routines that wait).
 * @param {number} addr
 * @returns {(m: Machine, regs?: object) => RomRun}
 */
export function romStub(addr) {
  return (m, regs = {}) => {
    SCRATCH[depth] ??= makeOracle();
    const sb = SCRATCH[depth];
    loadState(sb, m, { latches: true });
    depth += 1;
    try {
      const r = runRom(sb, addr, regs, {
        onCwai: () => { throw new Error(`stub $${hex4(addr)} waits`); },
      });
      loadState(m, sb, { latches: true });
      // Its writes, at its own cycles, and its time: exactly what a
      // ported routine would have logged and charged.
      const tr = TRACES.get(m);
      if (tr) for (const [t, a, v] of r.writes) tr.writes.push([m.charged[0] + t, a, v]);
      m.charge(r.cycles);
      return r;
    } finally {
      depth -= 1;
    }
  };
}

const SYMBOL_FILE = JSON.parse(readFileSync(join(ROOT,
  'reference/symbols.json'), 'utf8'));

/**
 * Main-CPU label -> address, plus each routine's JS name (symbols.json
 * `js`) where the listing label was renamed after porting, so tests can
 * keep using the names the port registers (e.g. lDA87 = game_over_to_attract).
 * @type {Record<string, number>}
 */
const SYMBOLS = { ...SYMBOL_FILE.main };
for (const [a, r] of Object.entries(SYMBOL_FILE.js?.main ?? {})) {
  if (SYMBOLS[r.jsName] === undefined) SYMBOLS[r.jsName] = parseInt(a, 16);
}

/** Main-CPU label name -> address (reference/symbols.json). */
export const LABEL = Object.freeze({ ...SYMBOLS });

/**
 * Register a ROM-backed stub for every main-CPU label below $E000 that
 * no loaded module registered (by name in MAIN, by address in MAIN_AT).
 * Returns the names stubbed, so a test can restore or override them.
 * @returns {string[]}
 */
export function installStubs() {
  /** @type {string[]} */
  const done = [];
  for (const [name, addr] of Object.entries(SYMBOLS)) {
    if (addr >= 0xe000) continue;
    const stub = romStub(addr);
    if (MAIN[name] === undefined) { MAIN[name] = stub; done.push(name); }
    if (MAIN_AT[addr] === undefined) MAIN_AT[addr] = stub;
  }
  return done;
}

/**
 * Run `fn` with MAIN[name] (and MAIN_AT at its address) replaced.
 * @template T
 * @param {Record<string, Function>} repl name -> function
 * @param {() => T} fn
 * @returns {T}
 */
export function withStubs(repl, fn) {
  /** @type {Array<[string, Function | undefined, number, Function | undefined]>} */
  const saved = [];
  for (const [name, f] of Object.entries(repl)) {
    const addr = SYMBOLS[name];
    saved.push([name, MAIN[name], addr, MAIN_AT[addr]]);
    MAIN[name] = f;
    if (addr !== undefined) MAIN_AT[addr] = f;
  }
  try {
    return fn();
  } finally {
    for (const [name, f, addr, g] of saved) {
      if (f === undefined) delete MAIN[name]; else MAIN[name] = f;
      if (addr !== undefined) {
        if (g === undefined) delete MAIN_AT[addr]; else MAIN_AT[addr] = g;
      }
    }
  }
}

/** @param {number} v */
export const hex4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');
/** @param {number} v */
export const hex2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');

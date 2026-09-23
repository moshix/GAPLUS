// Copyright 2026 by Moshix
/**
 * Helpers for testing the port against the original ROMs running on the
 * emulated board (test/m6809/board.mjs). Node only (loads the ROM set).
 *
 *   makeOracle(opts)                a Board loaded with the real ROMs
 *   callRoutine(board, cpu, addr, regs, opts)
 *                                   run ONE ROM routine on one CPU until it
 *                                   returns; registers + cycle count back
 *   saveState(owner) / loadState(dst, src, opts)
 *                                   copy RAM (and optionally latches)
 *                                   between a board, a port Machine or a
 *                                   saved snapshot
 *   diffRam(expected, actual, opts) differing bytes outside the stacks,
 *                                   named from reference/symbols.json
 *   fillRandom(owner, seed, ranges) seeded pseudo-random RAM contents
 *   makeRng(seed) / randomPlayer(seed, opts)
 *                                   deterministic random numbers / a
 *                                   joystick-and-fire input script
 *
 * The typical routine test: build an oracle and a port Machine, give both
 * the same RAM (fillRandom on the Machine, then loadState(board, m)), call
 * the ROM routine here and the JS routine on the port with the same inputs,
 * and require diffRam(board, m) to be empty and the returned registers to
 * match.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Board, CPU_NAME } from '../m6809/board.mjs';
import { CC_I, CC_F } from '../m6809/m6809.mjs';
import { RAM_REGIONS, STACKS } from '../../src/machine/machine.js';
import { loadGaplus, ROOT } from '../../tools/romset.mjs';

export { RAM_REGIONS };

/** @typedef {import('../m6809/board.mjs').BoardOptions} BoardOptions */
/** @typedef {import('../../src/machine/machine.js').Machine} Machine */

/** Loaded once: the ROMs never change during a run. */
/** @type {ReturnType<typeof loadGaplus> | null} */
let ROMS = null;

/** The verified ROM set (cached). */
export const roms = () => (ROMS ??= loadGaplus());

/**
 * A board running the real ROMs, at power-on.
 * @param {Partial<BoardOptions>} [opts] quantum, powerOn, watchdog, ...
 * @returns {Board}
 */
export function makeOracle(opts = {}) {
  return new Board({ ...opts, roms: roms() });
}

// --------------------------------------------------------------- stacks

/**
 * The S stacks in main-CPU addresses, [lo, hi) -- exempt from RAM
 * comparisons (docs/porting-guide.md section 5.3, machine.js STACKS).
 * @type {ReadonlyArray<readonly [number, number]>}
 */
export const STACK_RANGES = Object.freeze([
  Object.freeze([STACKS.main.mainLow, STACKS.main.mainTop]),
  Object.freeze([STACKS.sub.mainLow, STACKS.sub.mainTop]),
  Object.freeze([STACKS.sound.mainLow, STACKS.sound.mainTop]),
]);

/** Initial S of each CPU (the ROMs' LDS). */
const STACK_TOP = [STACKS.main.top, STACKS.sub.top, STACKS.sound.top];

/** DP each CPU runs with ([ROM]: main/sub TFR A,DP with $10; sound 0). */
export const DEFAULT_DP = Object.freeze([0x10, 0x10, 0x00]);

/**
 * Return address callRoutine pushes. $4000 is unmapped for main and sub
 * and write-only (IRQ enable) for sound: never code.
 */
export const SENTINEL = 0x4000;

// ------------------------------------------------------------ callRoutine

/**
 * @typedef {object} RoutineRegs  6809 registers in (all optional)
 * @property {number} [a] @property {number} [b] @property {number} [d]
 * @property {number} [x] @property {number} [y] @property {number} [u]
 * @property {number} [dp] @property {number} [cc]
 */

/**
 * @typedef {object} RoutineResult
 * @property {number} a @property {number} b @property {number} d
 * @property {number} x @property {number} y @property {number} u
 * @property {number} s @property {number} dp @property {number} cc
 * @property {boolean} cf @property {boolean} zf @property {boolean} nf
 * @property {boolean} vf @property {boolean} hf
 * @property {number} cycles   cycles from entry to the RTS (inclusive)
 * @property {number} stackLow lowest S reached (main-CPU address space
 *   for sound: add $6000)
 */

/**
 * Call one subroutine of the original ROM on one CPU and run it until it
 * returns: registers set from `regs` (DP defaults to the CPU's, CC.I and
 * CC.F forced on so no interrupt is taken), S = the CPU's stack top (or
 * `opts.stack`), the sentinel return address pushed, and only that CPU
 * single-stepped (the others and the frame clock are frozen) until PC is
 * the sentinel with S back where it was. Latch writes take effect at once.
 *
 * @param {Board} board
 * @param {'main'|'sub'|'sound'|0|1|2} cpu
 * @param {number} addr entry point
 * @param {RoutineRegs} [regs]
 * @param {{ maxCycles?: number, stack?: number }} [opts]
 * @returns {RoutineResult}
 */
export function callRoutine(board, cpu, addr, regs = {}, opts = {}) {
  const n = typeof cpu === 'number' ? cpu : CPU_NAME.indexOf(cpu);
  if (n < 0 || n > 2) throw new Error(`unknown CPU ${String(cpu)}`);
  const c = board.cpus[n];
  const maxCycles = opts.maxCycles ?? 5_000_000;
  const top = opts.stack ?? STACK_TOP[n];
  const savedLine = c.irqLine;
  c.setState({
    a: regs.a ?? c.a, b: regs.b ?? c.b,
    x: regs.x ?? c.x, y: regs.y ?? c.y, u: regs.u ?? c.u,
    dp: regs.dp ?? DEFAULT_DP[n],
    cc: (regs.cc ?? 0) | CC_I | CC_F,
    pc: addr, s: top, wait: 0,
  });
  if (regs.d !== undefined) c.d = regs.d;
  c.irqLine = false;
  // JSR pushes the return address low byte first (at S-1), then high.
  const view = board.machine.cpuView(CPU_NAME[n]);
  view.poke16((top - 2) & 0xffff, SENTINEL);
  c.s = (top - 2) & 0xffff;
  let cycles = 0;
  let stackLow = c.s;
  const saveAbort = board.syncOnLatch;
  board.syncOnLatch = false;
  try {
    while (!(c.pc === SENTINEL && c.s === top)) {
      cycles += c.step();
      if (c.s < stackLow) stackLow = c.s;
      if (c.wait !== 0) {
        throw new Error(`routine $${hex4(addr)} waits (CWAI/SYNC) at `
          + `$${hex4(c.ppc)}`);
      }
      if (cycles > maxCycles) {
        throw new Error(`routine $${hex4(addr)} did not return within `
          + `${maxCycles} cycles (pc=$${hex4(c.pc)})`);
      }
    }
  } finally {
    board.syncOnLatch = saveAbort;
    // Latch writes (SRESET) take effect now; nothing else runs.
    const q = board.syncQueue;
    board.syncQueue = [];
    for (const f of q) f();
    c.irqLine = savedLine || c.irqLine;
  }
  const cc = c.cc;
  return {
    a: c.a, b: c.b, d: c.d, x: c.x, y: c.y, u: c.u, s: c.s, dp: c.dp, cc,
    cf: (cc & 1) !== 0, vf: (cc & 2) !== 0, zf: (cc & 4) !== 0,
    nf: (cc & 8) !== 0, hf: (cc & 0x20) !== 0,
    cycles,
    stackLow,
  };
}

// --------------------------------------------------------- state copies

/**
 * Anything holding RAM at main-CPU addresses: a Board, a Machine or a
 * saved snapshot.
 * @typedef {{ mem: Uint8Array }} RamOwner
 */

/**
 * @typedef {object} SavedState
 * @property {Uint8Array} mem 64 KB, RAM regions filled
 * @property {import('../../src/machine/machine.js').MachineState} machine
 */

/** @param {object} o @returns {Machine | null} */
function machineOf(o) {
  const x = /** @type {{ machine?: Machine }} */ (o).machine;
  return x && typeof x.getState === 'function' ? x : null;
}

/**
 * Snapshot of an owner's RAM and machine latches.
 * @param {RamOwner} src @returns {SavedState}
 */
export function saveState(src) {
  const m = machineOf(src);
  if (!m) throw new Error('saveState needs a Board or a Machine');
  return { mem: src.mem.slice(), machine: m.getState() };
}

/**
 * Copy RAM from `src` into `dst` (Board, Machine or saved state). With
 * `{ latches: true }` also the Machine state that is not RAM: IRQ masks,
 * SRESET, star control, the I/O chips (not the CPUs' IRQ lines).
 * @param {RamOwner} dst @param {RamOwner} src
 * @param {{ latches?: boolean }} [opts]
 */
export function loadState(dst, src, opts = {}) {
  for (const r of RAM_REGIONS) {
    dst.mem.set(src.mem.subarray(r.start, r.end), r.start);
  }
  if (!opts.latches) return;
  const dm = machineOf(dst);
  const sm = /** @type {Partial<SavedState>} */ (src).machine
    && !machineOf(src) ? /** @type {SavedState} */ (src).machine
    : machineOf(src)?.getState();
  if (!dm || !sm) throw new Error('loadState latches: need machines');
  dm.irqMask = [...sm.irqMask];
  dm.sreset = sm.sreset;
  dm.starCtrl.set(sm.starCtrl);
  dm.io.setState(sm.io);
}

// ------------------------------------------------------------ RAM names

/** @type {Array<[number, string]> | null} */
let NAMES = null;

/** Sorted [addr, name] of the RAM labels in reference/symbols.json. */
function names() {
  if (NAMES) return NAMES;
  const file = join(ROOT, 'reference/symbols.json');
  NAMES = [];
  if (existsSync(file)) {
    const sym = JSON.parse(readFileSync(file, 'utf8'));
    for (const [n, v] of Object.entries(sym.ram ?? {})) {
      const addr = typeof v === 'number' ? v : v.addr;
      if (typeof addr === 'number') NAMES.push([addr, n]);
    }
    NAMES.sort((a, b) => a[0] - b[0]);
  }
  return NAMES;
}

/**
 * Nearest RAM label at or below `addr` (within $FF), e.g. "game_mode+$01".
 * @param {number} addr @returns {string}
 */
export function nameOf(addr) {
  /** @type {[number, string] | null} */
  let best = null;
  for (const e of names()) { if (e[0] <= addr) best = e; else break; }
  if (best === null || addr - best[0] > 0xff) return '';
  const off = addr - best[0];
  return off ? `${best[1]}+$${off.toString(16).toUpperCase()}` : best[1];
}

// ---------------------------------------------------------------- diffs

/**
 * @typedef {object} RamDiff
 * @property {number} addr main-CPU address
 * @property {number} expected @property {number} actual
 */

/**
 * @typedef {object} DiffOptions
 * @property {ReadonlyArray<readonly [number, number]>} [exempt] ranges
 *   [lo, hi) not compared; default STACK_RANGES
 * @property {ReadonlyArray<readonly [number, number]>} [ignore] more
 *   ranges on top of `exempt`
 * @property {number} [limit] stop after this many (default 40)
 */

/**
 * Every differing RAM byte outside the exempt ranges.
 * @param {RamOwner} expected usually the oracle
 * @param {RamOwner} actual usually the port
 * @param {DiffOptions} [opts]
 * @returns {RamDiff[]}
 */
export function diffRamRaw(expected, actual, opts = {}) {
  const limit = opts.limit ?? 40;
  const skip = [...(opts.exempt ?? STACK_RANGES), ...(opts.ignore ?? [])];
  const e = expected.mem;
  const a = actual.mem;
  /** @type {RamDiff[]} */
  const out = [];
  for (const r of RAM_REGIONS) {
    for (let i = r.start; i < r.end; i += 1) {
      if (e[i] === a[i]) continue;
      if (skip.some(([lo, hi]) => i >= lo && i < hi)) continue;
      out.push({ addr: i, expected: e[i], actual: a[i] });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * Differences as readable lines ("$1030 sub_task oracle=$01 port=$03"),
 * so `assert.deepEqual(diffRam(board, m), [])` prints something useful.
 * @param {RamOwner} expected @param {RamOwner} actual
 * @param {DiffOptions} [opts]
 * @returns {string[]}
 */
export function diffRam(expected, actual, opts = {}) {
  return diffRamRaw(expected, actual, opts).map((d) => {
    const n = nameOf(d.addr);
    return `$${hex4(d.addr)}${n ? ` ${n}` : ''} oracle=$${hex2(d.expected)}`
      + ` port=$${hex2(d.actual)}`;
  });
}

// --------------------------------------------------------------- random

/**
 * xorshift32: a small deterministic generator (never returns 0 state).
 * @param {number} seed @returns {() => number} next 32-bit unsigned value
 */
export function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

/**
 * Fill RAM with seeded random bytes: all RAM_REGIONS by default, or the
 * given [lo, hi) ranges (main-CPU addresses).
 * @param {RamOwner} owner @param {number} seed
 * @param {ReadonlyArray<readonly [number, number]>} [ranges]
 */
export function fillRandom(owner, seed, ranges) {
  const rng = makeRng(seed);
  const list = ranges ?? RAM_REGIONS.map((r) => [r.start, r.end]);
  for (const [lo, hi] of list) {
    for (let a = lo; a < hi; a += 1) owner.mem[a] = rng() & 0xff;
  }
}

/**
 * An input script for Board.inputScript: from frame `from` on, a random
 * 8-way stick direction (or centre) held for 4-40 frames at a time, and
 * the fire button tapped at random. Deterministic for a seed.
 * @param {number} seed
 * @param {{ from?: number, to?: number, fireRate?: number }} [opts]
 * @returns {(frame: number, board: { setInput: (n: string, d: boolean)
 *   => void }) => void}
 */
export function randomPlayer(seed, opts = {}) {
  const rng = makeRng(seed);
  const from = opts.from ?? 0;
  const to = opts.to ?? Infinity;
  const fireRate = opts.fireRate ?? 0.25;
  let hold = 0;
  let fireHeld = 0;
  let fireRest = 0;
  const dirs = ['up', 'down', 'left', 'right'];
  return (frame, board) => {
    if (frame < from) return;
    if (frame >= to) {
      for (const d of dirs) board.setInput(d, false);
      board.setInput('fire1', false);
      return;
    }
    if (hold <= 0) {
      // 0-7 = the 8 directions, 8 = centre
      const k = rng() % 9;
      const v = [[1, 0, 0, 0], [1, 0, 0, 1], [0, 0, 0, 1], [0, 1, 0, 1],
        [0, 1, 0, 0], [0, 1, 1, 0], [0, 0, 1, 0], [1, 0, 1, 0],
        [0, 0, 0, 0]][k];
      dirs.forEach((d, i) => board.setInput(d, v[i] === 1));
      hold = 4 + (rng() % 37);
    }
    hold -= 1;
    // Fire: pressed for 2 frames, then released for at least 2 (the
    // 56XX reports an edge only on a released -> pressed change).
    if (fireHeld > 0) {
      fireHeld -= 1;
      if (fireHeld === 0) { board.setInput('fire1', false); fireRest = 2; }
    } else if (fireRest > 0) {
      fireRest -= 1;
    } else if ((rng() % 1000) / 1000 < fireRate) {
      board.setInput('fire1', true);
      fireHeld = 2;
    }
  };
}

/** @param {number} v */
const hex2 = (v) => v.toString(16).toUpperCase().padStart(2, '0');
/** @param {number} v */
const hex4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');

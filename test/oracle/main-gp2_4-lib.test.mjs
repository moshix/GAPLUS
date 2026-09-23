// Copyright 2026 by Moshix
/**
 * Test library for the main CPU $A000-$BFFF port (gp2_4*.js): a ROM
 * runner that steps over CWAI and stops at chosen addresses, a port
 * runner that counts yields, and oracle-backed stubs for the routines of
 * other chips. It defines no tests (the file name only follows the
 * ownership pattern of docs/porting-phase.md).
 *
 * ISOLATION. Only gp2_4.js is imported; every routine of another chip
 * that gp2-4 calls is replaced by a stub (installStubs): sound_all_off
 * and clear_sprite_shadows run the real ROM on a scratch board over the
 * port's RAM; the jumps into gp2-3b ($DBE2, $DC0B) only record that
 * they happened. The busy routines burn on the shared foreground clock
 * (src/game/clock.js), which also charges the Machine (`m.charged[0]`).
 */
import assert from 'node:assert/strict';
import {
  makeOracle, loadState, diffRam, fillRandom, callRoutine, SENTINEL,
} from '../helpers/oracle.mjs';
import { CC_I, CC_F } from '../m6809/m6809.mjs';
import { Machine } from '../../src/machine/machine.js';
import '../../src/game/main/gp2_4.js';
import { MAIN_AT } from '../../src/game/main/routines.js';

/** @typedef {import('../m6809/board.mjs').Board} Board */

/** The oracle board of the routine tests (RAM reloaded every time). */
export const board = makeOracle();

/** Scratch board for the stubs of other chips' routines. */
const scratch = makeOracle();

/** Main S top. */
const TOP = 0x1600;

/** $FEB5 task_dispatch: a task "returns" by jumping here. */
export const TASK_DISPATCH = 0xfeb5;

/**
 * @typedef {object} RomRun
 * @property {number} pc where it stopped (SENTINEL after an RTS)
 * @property {number} cwai CWAIs stepped over
 * @property {number} cycles
 * @property {Set<number>} pcs every PC executed
 * @property {number} a @property {number} b @property {number} x
 * @property {number} y @property {number} u @property {number} cc
 */

/**
 * Run a main-CPU ROM routine on `b` until it returns to the sentinel, or
 * PC reaches one of `stops` (or `stopIf(pc, n)` is true, n = arrivals at
 * that pc so far). Each CWAI is stepped over: `onCwai(b)` stands in for
 * the IRQ, then the stacked state is pulled back as RTI would. Only the
 * main CPU runs.
 * @param {Board} b
 * @param {number} addr
 * @param {{a?: number, b?: number, d?: number, x?: number, y?: number,
 *   u?: number}} [regs]
 * @param {{ stops?: number[], stopIf?: (pc: number, n: number) => boolean,
 *   onCwai?: (b: Board) => void, maxCycles?: number,
 *   writes?: Array<[number, number, number]> }} [opts] `writes` collects
 *   the main CPU's writes
 * @returns {RomRun}
 */
export function runRom(b, addr, regs = {}, opts = {}) {
  const c = b.cpus[0];
  const stops = new Set(opts.stops ?? [TASK_DISPATCH]);
  const maxCycles = opts.maxCycles ?? 20_000_000;
  c.setState({
    a: regs.a ?? 0, b: regs.b ?? 0, x: regs.x ?? 0, y: regs.y ?? 0,
    u: regs.u ?? 0, dp: 0x10, cc: CC_I | CC_F, pc: addr, s: TOP, wait: 0,
  });
  if (regs.d !== undefined) c.d = regs.d;
  c.irqLine = false;
  b.machine.poke16(TOP - 2, SENTINEL);
  c.s = TOP - 2;
  const saveSync = b.syncOnLatch;
  b.syncOnLatch = false;
  /** @type {Map<number, number>} */
  const arrivals = new Map();
  const saveWrite = b.onWrite;
  if (opts.writes) {
    const list = opts.writes;
    // [cycles from entry at the writing instruction's start, addr, v]
    b.onWrite = (n, a, v) => { if (n === 0) list.push([cycles, a, v]); };
  }
  const pcs = new Set();
  let cycles = 0;
  let cwai = 0;
  try {
    for (;;) {
      const pc = c.pc;
      if (pc === SENTINEL && c.s === TOP) break;
      if (stops.has(pc)) break;
      const n = (arrivals.get(pc) ?? 0) + 1;
      arrivals.set(pc, n);
      if (opts.stopIf?.(pc, n)) break;
      pcs.add(pc);
      cycles += c.step();
      if (c.wait !== 0) {
        cwai += 1;
        opts.onCwai?.(b);
        rti(b);
      }
      if (cycles > maxCycles) throw new Error(`runaway at $${hex(c.pc)}`);
    }
  } finally {
    b.onWrite = saveWrite;
    b.syncOnLatch = saveSync;
    const q = b.syncQueue;
    b.syncQueue = [];
    for (const f of q) f();
  }
  return {
    pc: c.pc, cwai, cycles, pcs,
    a: c.a, b: c.b, x: c.x, y: c.y, u: c.u, cc: c.cc,
  };
}

/**
 * Leave a CWAI as the IRQ's RTI would: pull CC, A, B, DP, X, Y, U, PC.
 * @param {Board} b
 */
function rti(b) {
  const c = b.cpus[0];
  let s = c.s;
  const rd = () => { const v = b.peek(s, 0); s = (s + 1) & 0xffff; return v; };
  const rd16 = () => (rd() << 8) | rd();
  c.cc = rd(); c.a = rd(); c.b = rd(); c.dp = rd();
  c.x = rd16(); c.y = rd16(); c.u = rd16(); c.pc = rd16();
  c.s = s;
  c.wait = 0;
}

/**
 * Run a port routine (plain or generator), calling `onYield(value)` at
 * every yield.
 * @param {Function} fn
 * @param {Machine} m
 * @param {object} [regs]
 * @param {(v: unknown) => void} [onYield]
 * @param {number} [maxYields]
 * @returns {{ out: unknown, yields: number, values: unknown[] }}
 */
export function runPort(fn, m, regs = {}, onYield = () => {},
  maxYields = 100000) {
  const r = fn(m, regs);
  if (!(r && typeof r.next === 'function')) {
    return { out: r, yields: 0, values: [] };
  }
  let yields = 0;
  /** @type {unknown[]} */
  const values = [];
  for (;;) {
    const s = r.next();
    if (s.done) return { out: s.value, yields, values };
    yields += 1;
    values.push(s.value);
    onYield(s.value);
    if (yields > maxYields) throw new Error('port never finished');
  }
}

/**
 * Stub for a routine of another chip: run the ROM routine on the scratch
 * board over the port's RAM and latches, copy everything back.
 * @param {number} addr
 * @returns {(m: Machine, regs?: object) => object}
 */
function oracleStub(addr) {
  return (m, regs = {}) => {
    loadState(scratch, m, { latches: true });
    const o = callRoutine(scratch, 'main', addr, regs);
    loadState(m, scratch, { latches: true });
    return { a: o.a, b: o.b, x: o.x, u: o.u };
  };
}

/** Addresses the recording stubs saw, in order. */
export const jumps = /** @type {number[]} */ ([]);

/**
 * A jump target of another chip: record it and return (the port's
 * caller then returns too, as its ROM code would have jumped away).
 * @param {number} addr
 */
function recordStub(addr) {
  return () => { jumps.push(addr); };
}

/** Install the stubs for other chips' routines (idempotent). */
export function installStubs() {
  MAIN_AT[0xdf19] = oracleStub(0xdf19); // sound_all_off
  MAIN_AT[0xdf5d] = oracleStub(0xdf5d); // clear_sprite_shadows
  for (const a of [0xdbe2, 0xdc0b]) MAIN_AT[a] = recordStub(a);
}

/**
 * A port Machine and the oracle with the same seeded-random RAM and the
 * same latches / I/O chip state.
 * @param {number} seed
 * @param {(m: Machine) => void} [setup] runs on the port machine before
 *   the copy to the oracle
 * @returns {Machine}
 */
export function fresh(seed, setup) {
  const m = new Machine();
  fillRandom(m, seed);
  setup?.(m);
  loadState(board, m, { latches: true });
  jumps.length = 0;
  return m;
}

/**
 * Assert identical RAM (minus the stacks) and latches.
 * @param {Machine} m @param {string} what
 */
export function same(m, what) {
  assert.deepEqual(diffRam(board, m), [], what);
  assert.deepEqual(m.irqMask, board.machine.irqMask, `${what}: irq masks`);
  assert.equal(m.sreset, board.machine.sreset, `${what}: sreset`);
  assert.deepEqual(m.io.getState(), board.machine.io.getState(),
    `${what}: I/O chips`);
}

/** Seeded small PRNG for test setups. @param {number} seed */
export function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

/** @param {number} v */
export const hex = (v) => v.toString(16).toUpperCase().padStart(4, '0');

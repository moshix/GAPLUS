// Copyright 2026 by Moshix
/**
 * Shared harness for the sub CPU gp2-6.11b oracle tests
 * (test/oracle/sub-gp2_6*.test.mjs). It has a single self-test of its own;
 * the other files import its helpers:
 *
 *   pair()                      an oracle board and a port Machine
 *   randomize(board, m, seed)   identical seeded-random RAM in both
 *   same(board, m, what)        assert RAM equal (stacks exempt) + latch
 *   rng(seed)                   small seeded PRNG (int, byte, chance, pick)
 *   romTask(board, addr, opts)  run a ROM *task* on the oracle's sub CPU
 *                               until it jumps to task_dispatch_sub
 *                               ($E0EC), ticking at each CWAI
 *   portTask(fn, m, opts)       run a port task/routine, ticking at each
 *                               yield; returns the tick count
 *   romStub(addr)               a port-side stand-in for a routine of
 *                               ANOTHER chip: the real ROM on a scratch
 *                               board over the port's RAM
 *
 * Tasks end in `JMP task_dispatch_sub`, not RTS, so they cannot go
 * through callRoutine; romTask single-steps the sub CPU until PC = $E0EC
 * instead. A CWAI inside a task counts one tick: the harness applies the
 * test's `tick(owner)` (standing in for whatever the IRQ would change),
 * then resumes the CPU as the RTI would. The port side applies the same
 * tick at each yield, and the tick counts must match.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeOracle, callRoutine, loadState, diffRam, fillRandom,
} from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';
import { call } from '../../src/game/call.js';

/** Sub CPU number on the board. */
export const SUB_CPU = 1;
/** task_dispatch_sub: where every task ends. */
export const DISPATCH = 0xe0ec;
/** The sub CPU's stack top ($E006 lds #$1D80). */
const SUB_STACK = 0x1d80;
/** CC.E, set by CWAI in the stacked CC. */
const CC_E = 0x80;

/** @typedef {import('../m6809/board.mjs').Board} Board */
/** @typedef {{ mem: Uint8Array }} RamOwner */

// -------------------------------------------------------------- basics

/**
 * mulberry32 with a few conveniences.
 * @param {number} seed
 */
export function rng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** @param {number} n */ int: (n) => Math.floor(next() * n),
    byte: () => Math.floor(next() * 256),
    /** @template T @param {T[]} a @returns {T} */
    pick: (a) => a[Math.floor(next() * a.length)],
    /** @param {number} p */ chance: (p) => next() < p,
  };
}

/** An oracle board and a port Machine, plus a poke into both. */
export function pair() {
  const board = makeOracle();
  const m = new Machine();
  /** @param {number} a @param {number} v */
  const poke = (a, v) => { board.poke(a, v & 0xff); m.mem[a] = v & 0xff; };
  /** @param {number} a @param {number} v */
  const poke16 = (a, v) => { poke(a, v >> 8); poke(a + 1, v); };
  return { board, m, poke, poke16 };
}

/**
 * Same seeded-random RAM in both (all RAM, or the given ranges), and the
 * sub IRQ mask latch equal.
 * @param {Board} board @param {Machine} m @param {number} seed
 * @param {ReadonlyArray<readonly [number, number]>} [ranges]
 */
export function randomize(board, m, seed, ranges) {
  fillRandom(m, seed, ranges);
  loadState(board, m);
  board.machine.irqMask[SUB_CPU] = m.irqMask[SUB_CPU];
}

/**
 * Assert that RAM (stacks exempt) and the sub IRQ mask latch match.
 * @param {Board} board @param {Machine} m @param {string} what
 */
export function same(board, m, what) {
  const d = diffRam(board, m);
  assert.deepEqual(d, [], `${what}: RAM differs\n${d.join('\n')}`);
  assert.equal(m.irqMask[SUB_CPU], board.machine.irqMask[SUB_CPU],
    `${what}: sub IRQ mask`);
}

// ------------------------------------------------------- running tasks

/**
 * @typedef {object} RomTaskOptions
 * @property {(owner: RamOwner, n: number) => void} [tick] applied at each
 *   CWAI (n = 0, 1, ...), before the CPU resumes
 * @property {{ a?: number, b?: number, x?: number, y?: number,
 *   u?: number }} [regs] registers on entry
 * @property {ReadonlyArray<number>} [stop] PCs that end the run
 *   (default [$E0EC])
 * @property {number} [maxCycles] default 2,000,000
 * @property {number} [maxTicks] default 1,000
 */

/**
 * @typedef {object} Timing  what the timing contract compares
 * @property {number} cycles total cycles, entry to exit (the exit jump
 *   or RTS included; CWAI wake-ups and failed polls excluded)
 * @property {number[]} times the cycle (since entry) at which each
 *   instruction touching shared memory starts: the port's SYNC stamps
 * @property {Array<[number, number, number]>} writes [cycle, addr,
 *   value] of every write outside the stack
 * @property {number[]} waits the cycle of each CWAI (after it)
 */

/**
 * The stack, private to the sub CPU (machine.js STACKS $1D74-$1D7F), and
 * $1D80 just above it: the core's RTS makes a dummy read at S there (the
 * address is never data, only the `lds #$1D80` stack top).
 */
const inStack = (/** @type {number} */ a) => a >= 0x1d74 && a <= 0x1d80;

/**
 * Can another CPU or the scheduler see an access to `a` (sub address)?
 * The same rule as src/game/sub/gp2_6_state.js `shared`, stack excluded.
 * @param {number} a @returns {boolean}
 */
export const timedAddr = (a) => !inStack(a)
  && (a < 0x2000 || (a >= 0x6000 && a < 0x7000));

/**
 * Instrument the oracle's sub core: returns a probe whose `cycles`
 * the caller advances and which collects times/writes; `done()` removes
 * the hooks.
 * @param {Board} board
 */
export function probe(board) {
  const c = board.cpus[SUB_CPU];
  const mach = board.machine;
  const proto = Object.getPrototypeOf(mach);
  const p = {
    cycles: 0,
    start: 0,
    lastMark: -1,
    /** @type {number[]} */ times: [],
    /** @type {Array<[number, number, number]>} */ writes: [],
    /** @type {number[]} */ waits: [],
    done: () => {
      delete mach.busRead;
      delete mach.busWrite;
      c.trace = null;
    },
  };
  c.trace = () => { p.start = p.cycles; };
  /** @param {number} a */
  const mark = (a) => {
    if (timedAddr(a) && p.lastMark !== p.start) {
      p.times.push(p.start);
      p.lastMark = p.start;
    }
  };
  mach.busRead = function busRead(/** @type {number} */ n,
    /** @type {number} */ a) {
    if (n === SUB_CPU) mark(a & 0xffff);
    return proto.busRead.call(this, n, a);
  };
  mach.busWrite = function busWrite(/** @type {number} */ n,
    /** @type {number} */ a, /** @type {number} */ v) {
    if (n === SUB_CPU) {
      mark(a & 0xffff);
      if (!inStack(a & 0xffff)) p.writes.push([p.start, a & 0xffff, v & 0xff]);
    }
    proto.busWrite.call(this, n, a, v);
  };
  return p;
}

/**
 * Run a ROM task on the oracle's sub CPU from `addr` until PC reaches one
 * of `stop` (task_dispatch_sub by default), or, with `rts`, until the
 * routine returns (a subroutine: the sentinel return address is pushed).
 * @param {Board} board @param {number} addr
 * @param {RomTaskOptions & { rts?: boolean }} [opts]
 * @returns {Timing & { ticks: number, pc: number, a: number,
 *   b: number, x: number, y: number, u: number, cf: boolean,
 *   zf: boolean, nf: boolean, vf: boolean }}
 */
export function romTask(board, addr, opts = {}) {
  const c = board.cpus[SUB_CPU];
  const SENT = 0x4000;
  const stop = new Set(opts.rts ? [SENT] : (opts.stop ?? [DISPATCH]));
  const maxCycles = opts.maxCycles ?? 2_000_000;
  const maxTicks = opts.maxTicks ?? 1000;
  const r = opts.regs ?? {};
  c.setState({
    a: r.a ?? 0, b: r.b ?? 0, x: r.x ?? 0, y: r.y ?? 0, u: r.u ?? 0,
    dp: 0x10, cc: 0x50, pc: addr, s: SUB_STACK, wait: 0,
  });
  if (opts.rts) {
    board.mem[SUB_STACK - 2] = SENT >> 8;
    board.mem[SUB_STACK - 1] = SENT & 0xff;
    c.s = SUB_STACK - 2;
  }
  const savedLine = c.irqLine;
  c.irqLine = false;
  const saveAbort = board.syncOnLatch;
  board.syncOnLatch = false;
  let ticks = 0;
  const p = probe(board);
  try {
    while (!stop.has(c.pc) || c.wait !== 0) {
      p.cycles += c.step();
      if (c.wait !== 0) {
        // CWAI: everything is stacked and the CPU sleeps. Stand in for
        // the IRQ, then do what the handler's RTI does: pull the 12
        // bytes back (the registers themselves are unchanged).
        if (ticks >= maxTicks) throw new Error('romTask: too many ticks');
        p.waits.push(p.cycles);
        opts.tick?.(board, ticks);
        ticks += 1;
        c.cc &= ~CC_E;
        c.s = (c.s + 12) & 0xffff;
        c.wait = 0;
      }
      if (p.cycles > maxCycles) {
        throw new Error(`romTask $${addr.toString(16)}: no end `
          + `(pc=$${c.pc.toString(16)})`);
      }
    }
  } finally {
    p.done();
    board.syncOnLatch = saveAbort;
    const q = board.syncQueue;
    board.syncQueue = [];
    for (const f of q) f();
    c.irqLine = savedLine;
  }
  const cc = c.cc;
  return {
    ticks, cycles: p.cycles, times: p.times, writes: p.writes,
    waits: p.waits,
    pc: c.pc, a: c.a, b: c.b, x: c.x, y: c.y, u: c.u,
    cf: (cc & 1) !== 0, vf: (cc & 2) !== 0, zf: (cc & 4) !== 0,
    nf: (cc & 8) !== 0,
  };
}

/** Yield marker of the timing contract (gp2_6_state.js SYNC). */
const SYNC = Symbol.for('gaplus.sync');

/**
 * Run a port routine (plain function or generator) to completion,
 * applying `tick(m, n)` at each wait (every yield but SYNC), and record
 * its timing: cycles charged, the charged time at each SYNC, every write
 * with the charged time when it happened, the time of each bare yield.
 * @param {Function} fn @param {Machine} m
 * @param {{ regs?: object, tick?: (owner: RamOwner, n: number) => void,
 *   maxTicks?: number }} [opts]
 * @returns {Timing & { ticks: number, out: unknown, yields: unknown[] }}
 */
export function portTask(fn, m, opts = {}) {
  const maxTicks = opts.maxTicks ?? 1000;
  const c0 = m.charged[SUB_CPU];
  const now = () => m.charged[SUB_CPU] - c0;
  /** @type {Array<[number, number, number]>} */
  const writes = [];
  const bw = m.busWrite;
  m.busWrite = (cpu, a, v) => {
    if (cpu === SUB_CPU && !inStack(a & 0xffff)) {
      writes.push([now(), a & 0xffff, v & 0xff]);
    }
    bw.call(m, cpu, a, v);
  };
  /** @type {unknown[]} */
  const yields = [];
  /** @type {number[]} */
  const times = [];
  /** @type {number[]} */
  const waits = [];
  let ticks = 0;
  try {
    const g = call(fn, m, opts.regs ?? {});
    for (;;) {
      const r = g.next();
      if (r.done) {
        return {
          ticks, out: r.value, yields, cycles: now(), times, writes, waits,
        };
      }
      if (r.value === SYNC) {
        if (times[times.length - 1] !== now()) times.push(now());
        continue;
      }
      yields.push(r.value);
      if (r.value === undefined) waits.push(now());
      if (ticks >= maxTicks) throw new Error('portTask: too many ticks');
      opts.tick?.(m, ticks);
      ticks += 1;
    }
  } finally {
    m.busWrite = bw;
  }
}

/**
 * The timing contract: same cycles, same SYNC stamps (= the ROM's shared
 * accesses), same writes at the same cycles, same CWAI times.
 * @param {Timing} rom @param {Timing} port @param {string} what
 */
export function sameTiming(rom, port, what) {
  assert.deepEqual(port.writes, rom.writes, `${what}: timed writes`);
  assert.deepEqual(port.times, rom.times, `${what}: SYNC stamps`);
  assert.deepEqual(port.waits, rom.waits, `${what}: CWAI cycles`);
  assert.equal(port.cycles, rom.cycles, `${what}: cycles`);
}

/**
 * Call a ROM subroutine (ends in RTS) on the oracle's sub CPU.
 * @param {Board} board @param {number} addr @param {object} [regs]
 */
export const romCall = (board, addr, regs = {}) =>
  callRoutine(board, 'sub', addr, regs);

// ------------------------------------------------------------- stubs

/** @type {Board | null} */
let scratch = null;

/**
 * A stand-in for a routine of another chip (not ported, or not this
 * module's to test): the real ROM routine run on a scratch board over a
 * copy of the port's RAM, which is then copied back. `kind` 'task' runs
 * to task_dispatch_sub (a generator: yields at each CWAI), 'sub' to the
 * RTS (returns the registers).
 * @param {number} addr @param {'task'|'sub'} [kind]
 * @returns {Function}
 */
export function romStub(addr, kind = 'task') {
  if (kind === 'sub') {
    return (/** @type {Machine} */ m, /** @type {object} */ regs = {}) => {
      scratch ??= makeOracle();
      loadState(scratch, m);
      const out = romCall(scratch, addr, regs);
      loadState(m, scratch);
      m.sub.charge(out.cycles);
      return out;
    };
  }
  // A task that CWAIs must yield to the port's caller in between, so the
  // ROM run is split at each CWAI: run to the CWAI, copy RAM out, yield,
  // copy RAM in, continue.
  return function* stub(/** @type {Machine} */ m) {
    scratch ??= makeOracle();
    const b = scratch;
    loadState(b, m);
    const c = b.cpus[SUB_CPU];
    c.setState({ dp: 0x10, cc: 0x50, pc: addr, s: SUB_STACK, wait: 0 });
    let guard = 0;
    while (c.pc !== DISPATCH || c.wait !== 0) {
      m.sub.charge(c.step());
      if (c.wait !== 0) {
        loadState(m, b);
        yield;
        loadState(b, m);
        c.cc &= ~CC_E;
        c.s = (c.s + 12) & 0xffff;
        c.wait = 0;
      }
      guard += 1;
      if (guard > 5_000_000) throw new Error(`stub $${addr.toString(16)}`);
    }
    loadState(m, b);
  };
}

// --------------------------------------------------------- self-test

test('kit: romTask stops at task_dispatch_sub and counts CWAIs', () => {
  const { board } = pair();
  // task_end_frame_sub: CWAI, lds, clr <$7A, jmp $E0EC -- one tick
  board.poke(0x107a, 5);
  let seen = -1;
  const r = romTask(board, 0xe17f, {
    tick: (o, n) => { seen = n; o.mem[0x107a] = 9; },
  });
  assert.equal(r.ticks, 1);
  assert.equal(seen, 0);
  assert.equal(board.mem[0x107a], 0);
});

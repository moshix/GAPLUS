// Copyright 2026 by Moshix
/**
 * Shared harness for the oracle tests of main CPU ROM gp2-3b.8c
 * ($C000-$DFFF, src/game/main/gp2_3b*.js). Not a test file itself.
 *
 *   makePair(seed, setup)   a port Machine with seeded-random RAM (after
 *                           `setup(m, rnd)`), and the oracle board loaded
 *                           with the same RAM and latches (I/O chips too)
 *   romRun(board, entry, o) step the ROM on the oracle's main CPU from
 *                           `entry` until it returns, reaches a stop PC,
 *                           or ... (see RomRunOptions); CWAIs, poll loops
 *                           and busy-loop marks call back into the test
 *   portRun(gen, m, o)      drive a port generator the same way
 *   romStub(addr)           a port-side stand-in for a routine of another
 *                           chip: runs the real ROM routine on a scratch
 *                           board over the port's RAM
 *   writeLog(m)             record the port's main-CPU writes with the
 *                           cycles charged so far
 *
 * CYCLES. The port charges (Machine.charge) the cycles of the 6809
 * instructions a routine executes; romRun counts the oracle's cycles the
 * same way (interrupt entry excluded, a CWAI's own 16 cycles included,
 * the failed iterations of a declared poll loop excluded). So each event
 * carries the cycle count at which it happened on both sides and the
 * tests compare them.
 */
import assert from 'node:assert/strict';
import {
  makeOracle, loadState, diffRam, fillRandom, SENTINEL,
} from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';
import {
  BUSY, RENDEZVOUS, SYNC,
} from '../../src/game/main/gp2_3b_state.js';

/** @typedef {import('../m6809/board.mjs').Board} Board */

/** The one oracle board the tests of a file share. */
export const ORACLE = makeOracle();

/** Main CPU stack top ($E00F / $D152 LDS #$1600). */
export const STACK = 0x1600;

/**
 * A port Machine and the oracle, with identical seeded-random RAM.
 * @param {number} seed
 * @param {(m: Machine, rnd: () => number) => void} [setup] adjust the
 *   port's RAM / I/O chips before they are copied to the oracle
 * @returns {{ board: Board, m: Machine, rnd: () => number }}
 */
export function makePair(seed, setup) {
  const m = new Machine();
  fillRandom(m, seed);
  // mulberry32: xorshift seeded with neighbouring seeds gives nearly
  // the same first outputs, which made `rnd() < p` setups take the same
  // branch for every seed.
  let st = (Math.imul(seed, 0x9e3779b1) ^ 0x5a5a5a5a) >>> 0;
  const rnd = () => {
    st = (st + 0x6d2b79f5) >>> 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  setup?.(m, rnd);
  loadState(ORACLE, m, { latches: true });
  // The board keeps its own copy of each CPU's IRQ state.
  ORACLE.cpus[0].irqLine = false;
  return { board: ORACLE, m, rnd };
}

/** Random integer 0..n-1. @param {() => number} rnd @param {number} n */
export const ri = (rnd, n) => Math.floor(rnd() * n);

/**
 * RAM, the main IRQ mask, the star control latches and the I/O chips of
 * the two sides must match.
 * @param {{ mem: Uint8Array, machine: Machine }} board
 * @param {Machine} m
 * @param {string} what
 */
export function same(board, m, what) {
  assert.deepEqual(diffRam(board, m), [], `${what}: RAM differs`);
  const bm = board.machine;
  assert.equal(m.irqMask[0], bm.irqMask[0], `${what}: main IRQ mask`);
  assert.deepEqual([...m.starCtrl], [...bm.starCtrl], `${what}: stars`);
  assert.deepEqual(m.io.getState(), bm.io.getState(), `${what}: I/O`);
}

// ---------------------------------------------------------------- oracle

/**
 * A poll loop the ROM spins in until something outside it changes.
 * @typedef {object} PollLoop
 * @property {number} pc     first instruction of the loop
 * @property {number} end    first address after the loop
 * @property {(b: Board) => boolean} busy  true while it would go round
 *   again (evaluated with PC at `pc`); an event is reported, the test's
 *   onEvent changes the state, and the pass runs
 * @property {number} cost   cycles of one failed pass (not counted: the
 *   port charges only the pass that gets through)
 * @property {string} [kind] event kind reported (default 'poll')
 */

/**
 * @typedef {object} RomEvent
 * @property {string} kind  'cwai' | 'poll' | 'mark' | ...
 * @property {number} pc
 * @property {number} cycles  counted cycles when it happened
 */

/**
 * @typedef {object} RomRunOptions
 * @property {object} [regs]  registers at entry (a b d x y u)
 * @property {'rts'|'rti'} [frame] what the entry is: a subroutine
 *   ('rts', the default: returns to the sentinel) or an interrupt handler
 *   ('rti': an entire-state frame is stacked with PC = the sentinel)
 * @property {number[]} [stops] PCs that end the run (checked before
 *   executing, never at the entry itself)
 * @property {PollLoop[]} [polls]
 * @property {number[]} [marks] PCs reported as 'mark' events (busy-loop
 *   progress points) before they execute
 * @property {(ev: RomEvent, b: Board) => void} [onEvent] called at each
 *   event; the test changes state there (a "frame")
 * @property {boolean} [log] record every main-CPU write (see
 *   RomRunResult.writes)
 * @property {number} [maxCycles] default 20,000,000
 * @property {number} [maxEvents] stop after this many events
 */

/**
 * @typedef {object} RomRunResult
 * @property {number} pc   where it ended (SENTINEL after RTS/RTI)
 * @property {object} regs the CPU registers at the end
 * @property {number} cycles counted cycles
 * @property {RomEvent[]} events
 * @property {Array<[number, number, number, number]>} writes (with
 *   `log`): [cycles at the start of the writing instruction, addr,
 *   value, PC of that instruction]
 */

/**
 * Step the oracle's main CPU from `entry` (see RomRunOptions). Only the
 * main CPU runs; the frame clock and the other CPUs are frozen, IRQs are
 * never taken (CC.I and CC.F set at entry).
 * @param {Board} board @param {number} entry @param {RomRunOptions} [o]
 * @returns {RomRunResult}
 */
export function romRun(board, entry, o = {}) {
  const c = board.cpus[0];
  const stops = new Set(o.stops ?? []);
  const marks = new Set(o.marks ?? []);
  const polls = o.polls ?? [];
  const maxCycles = o.maxCycles ?? 20_000_000;
  const r = o.regs ?? {};
  c.setState({
    a: r.a ?? 0, b: r.b ?? 0, x: r.x ?? 0, y: r.y ?? 0, u: r.u ?? 0,
    dp: 0x10, cc: 0x50, pc: entry, s: STACK, wait: 0,
  });
  if (r.d !== undefined) c.d = r.d;
  c.irqLine = false;
  const view = board.machine;
  if ((o.frame ?? 'rts') === 'rts') {
    c.s = STACK - 2;
    board.poke(STACK - 2, SENTINEL >> 8);
    board.poke(STACK - 1, SENTINEL & 0xff);
  } else {
    // Entire state as IRQ entry stacks it: CC (E set), A, B, DP, X, Y, U,
    // PC -- RTI pulls it back and "returns" to the sentinel.
    const bytes = [0xd0, 0, 0, 0x10, 0, 0, 0, 0, 0, 0, SENTINEL >> 8, 0];
    c.s = STACK - 12;
    bytes.forEach((v, i) => board.poke(STACK - 12 + i, v));
  }
  /** @type {RomEvent[]} */
  const events = [];
  /** @type {Array<[number, number, number, number]>} */
  const writes = [];
  let cycles = 0;
  let start = 0;
  const saveW = board.onWrite;
  const saveSync = board.syncOnLatch;
  board.syncOnLatch = false;
  if (o.log) {
    board.onWrite = (n, a, v) => {
      if (n === 0) writes.push([start, a, v, c.ppc]);
    };
  }
  const event = (kind, pc) => {
    const ev = { kind, pc, cycles };
    events.push(ev);
    o.onEvent?.(ev, board);
  };
  let first = true;
  /** @type {PollLoop | null} */
  let pending = null;
  try {
    for (;;) {
      const pc = c.pc;
      if (pc === SENTINEL && c.s === STACK) break;
      if (!first && stops.has(pc)) break;
      if (!first && marks.has(pc)) event('mark', pc);
      // A poll loop: back at its head after an event means the pass
      // after the event failed (waiting: not counted).
      if (pending !== null) {
        if (pc === pending.pc) cycles -= pending.cost;
        if (pc < pending.pc || pc >= pending.end) pending = null;
      }
      const poll = polls.find((p) => p.pc === pc && p.busy(board));
      if (poll) {
        event(poll.kind ?? 'poll', pc);
        pending = poll;
      }
      if (o.maxEvents !== undefined && events.length >= o.maxEvents) break;
      first = false;
      start = cycles;
      cycles += c.step();
      if (c.wait !== 0) {
        // CWAI: the state is stacked; "take the IRQ" = the test's frame,
        // then RTI back (pull the entire state; its cycles belong to the
        // IRQ handler, not counted).
        event('cwai', c.ppc);
        c.wait = 0;
        rti(c, view);
      }
      if (cycles > maxCycles) {
        throw new Error(`romRun $${hex4(entry)}: no end within ${maxCycles}`
          + ` cycles (pc $${hex4(c.pc)})`);
      }
    }
  } finally {
    board.onWrite = saveW;
    board.syncOnLatch = saveSync;
    const q = board.syncQueue;
    board.syncQueue = [];
    for (const f of q) f();
  }
  return {
    pc: c.pc,
    regs: { a: c.a, b: c.b, d: c.d, x: c.x, y: c.y, u: c.u, cc: c.cc },
    cycles, events, writes,
  };
}

/**
 * Pull CC, A, B, DP, X, Y, U, PC from S (what RTI does with E set).
 * @param {import('../m6809/m6809.mjs').M6809} c @param {Machine} view
 */
function rti(c, view) {
  let s = c.s;
  const b = () => { const v = view.peek(s); s = (s + 1) & 0xffff; return v; };
  c.cc = b(); c.a = b(); c.b = b(); c.dp = b();
  c.x = (b() << 8) | b(); c.y = (b() << 8) | b(); c.u = (b() << 8) | b();
  c.pc = (b() << 8) | b();
  c.s = s;
}

// ------------------------------------------------------------------ port

/**
 * @typedef {object} PortEvent
 * @property {string} kind 'cwai' | 'busy' | 'rendezvous' | 'other'
 * @property {number} cycles m.charged[0] when it happened
 */

/**
 * Drive a port generator (or run a plain function) to the end, calling
 * `onEvent` at each yield.
 * @param {unknown} it a generator object (or a plain return value)
 * @param {Machine} m
 * @param {{ onEvent?: (ev: PortEvent, m: Machine) => void,
 *   maxEvents?: number, syncs?: boolean }} [o]
 * @returns {{ value: unknown, events: PortEvent[], done: boolean }}
 */
export function portRun(it, m, o = {}) {
  /** @type {PortEvent[]} */
  const events = [];
  const g = /** @type {Generator<unknown, unknown, unknown>} */ (it);
  if (!g || typeof g.next !== 'function') {
    return { value: it, events, done: true };
  }
  for (;;) {
    if (o.maxEvents !== undefined && events.length >= o.maxEvents) {
      return { value: undefined, events, done: false };
    }
    const r = g.next();
    if (r.done) return { value: r.value, events, done: true };
    // SYNC (busy() points) and BUSY (loops) are both reported as
    // 'busy': the tests compare them with the oracle's marks.
    // (integration, round 3) a poll loop's failed pass (src/game/timing.js
    // poll: pollAgain marker) is the rendezvous; with `syncs: false` the
    // SYNC timing points of the IRQ handler are not events.
    const isPoll = r.value !== null && typeof r.value === 'object'
      && 'poll' in /** @type {object} */ (r.value);
    if (r.value === SYNC && o.syncs === false) continue;
    const kind = r.value === undefined ? 'cwai'
      : r.value === BUSY || r.value === SYNC ? 'busy'
        : r.value === RENDEZVOUS || isPoll ? 'rendezvous' : 'other';
    // A failed poll pass is charged before its marker: the event is at
    // the start of that pass, as the oracle's poll marks are.
    // (integration, round 3)
    // Waiting is not part of a routine's cost in these tests (the oracle
    // side is released at its first poll): the failed pass is refunded.
    if (isPoll) m.charged[0] -= /** @type {{ period: number }} */ (r.value).period;
    const ev = { kind, cycles: m.charged[0] };
    events.push(ev);
    o.onEvent?.(ev, m);
  }
}

/**
 * Record the port's main-CPU writes as [cycles charged, addr, value].
 * @param {Machine} m @returns {Array<[number, number, number]>}
 */
export function writeLog(m) {
  /** @type {Array<[number, number, number]>} */
  const log = [];
  const orig = m.busWrite.bind(m);
  m.busWrite = (cpu, a, v) => {
    if (cpu === 0) log.push([m.charged[0], a & 0xffff, v & 0xff]);
    orig(cpu, a, v);
  };
  return log;
}

// ----------------------------------------------------------------- stubs

/** Scratch boards for romStub, one per nesting depth. @type {Board[]} */
const SCRATCH = [];
let depth = 0;

/**
 * A stand-in for a routine of ANOTHER chip: the real ROM routine run on a
 * scratch board over the port's RAM and I/O state, which is then copied
 * back. It charges the routine's cycles (entry to RTS) to the port, as
 * the ported routine will. Exact by construction, so each chip's tests
 * depend only on that chip.
 * @param {number} addr
 * @returns {(m: Machine, regs?: object) => object}
 */
export function romStub(addr) {
  return (m, regs = {}) => {
    if (!SCRATCH[depth]) SCRATCH[depth] = makeOracle();
    const sb = SCRATCH[depth];
    loadState(sb, m, { latches: true });
    depth += 1;
    try {
      const r = romRun(sb, addr, { regs });
      loadState(m, sb, { latches: true });
      m.charge(r.cycles);
      return r.regs;
    } finally {
      depth -= 1;
    }
  };
}

/** @param {number} v */
export const hex4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');

/**
 * The oracle's writes made by instructions in [lo, hi] and outside the
 * stack, as [addr, value] (or [cycles, addr, value] with `timed`), to
 * compare with writeLog(m) of the port.
 * @param {Array<[number, number, number, number]>} writes
 * @param {{ lo?: number, hi?: number, timed?: boolean }} [o]
 * @returns {number[][]}
 */
export function romWrites(writes, o = {}) {
  const lo = o.lo ?? 0xc000;
  const hi = o.hi ?? 0xdfff;
  return writes
    .filter(([, a, , pc]) => pc >= lo && pc <= hi
      && (a < STACK - 0x1e || a >= STACK))
    .map(([t, a, v]) => (o.timed ? [t, a, v] : [a, v]));
}

/**
 * The port's logged writes as [addr, value] (or all three with `timed`).
 * @param {Array<[number, number, number]>} log
 * @param {boolean} [timed]
 * @returns {number[][]}
 */
export function portWrites(log, timed = false) {
  return log.map(([t, a, v]) => (timed ? [t, a, v] : [a, v]));
}

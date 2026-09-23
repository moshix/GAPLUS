// Copyright 2026 by Moshix
/**
 * The sound CPU's port (src/game/sound/gp2_1.js) against the ROM.
 *
 *  - registration: every routine, the vectors and every jump-table
 *    target are in SOUND_AT;
 *  - reset_sound from random RAM: same RAM, same cycles, the $22
 *    handshake and every timed store at the same cycle;
 *  - irq_sound on real traffic: RAM snapshots taken at vblank during
 *    attract mode and a played game on the full board; each one is run
 *    through the ROM's IRQ on a solo core and through the port's;
 *  - every sound 0-25 played from its request to its end (or 900
 *    frames), frame by frame;
 *  - the timing contract: the port yields SYNC right before every
 *    instruction that touches $0040-$007F or an IRQ latch, with exactly
 *    the cycle (since the IRQ entry began) at which the ROM starts that
 *    instruction; the handler's total cycles match too.
 *
 * Solo IRQ on the oracle: the sound core idles at $E053 (BRA *) with
 * S = $0400 and CC.I clear; its IRQ line is raised and the core stepped
 * until it is back at $E053 with the handler done (the entry is 19
 * cycles, charged by the scheduler in the port).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeOracle, diffRam, fillRandom, makeRng, randomPlayer, loadState,
} from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';
import '../../src/game/sound/index.js';
import { SOUND_AT, soundAt } from '../../src/game/sound/routines.js';
import { soundWord } from '../../src/game/romdata.js';
import { SYNC, IRQ_ENTRY_CYCLES } from '../../src/game/scheduler.js';

/** @typedef {import('../m6809/board.mjs').Board} Board */

const IDLE_PC = 0xe053;
const SOUND = 2;

/** Sound-CPU addresses whose accesses another CPU (or the scheduler) sees. */
const timed = (/** @type {number} */ a) => (a >= 0x40 && a < 0x80)
  || (a >= 0x4000 && a < 0x8000);

/**
 * One solo IRQ of the ROM on `board`'s sound core, from the idle loop.
 * Returns the cycles (from the start of the IRQ entry to the RTI's end)
 * and the cycle at which every timed instruction began.
 * @param {Board} board
 * @returns {{ cycles: number, times: number[] }}
 */
function romIrq(board) {
  const c = board.cpus[SOUND];
  c.setState({ pc: IDLE_PC, s: 0x0400, cc: 0, wait: 0, irqLine: true });
  board.machine.sreset = false;
  let cycles = 0;
  let start = 0;
  /** @type {number[]} */
  const times = [];
  let lastMark = -1;
  const mach = board.machine;
  const proto = Object.getPrototypeOf(mach);
  // Note the start cycle of each instruction; a timed access marks it.
  c.trace = () => { start = cycles; };
  /** @param {number} a */
  const mark = (a) => {
    if (timed(a) && lastMark !== start) { times.push(start); lastMark = start; }
  };
  mach.busRead = function busRead(n, a) {
    if (n === SOUND) mark(a);
    return proto.busRead.call(this, n, a);
  };
  mach.busWrite = function busWrite(n, a, v) {
    if (n === SOUND) mark(a);
    proto.busWrite.call(this, n, a, v);
  };
  try {
    let entered = false;
    for (let i = 0; i < 200000; i += 1) {
      cycles += c.step();
      if (!entered) { entered = true; c.irqLine = false; continue; }
      if (c.pc === IDLE_PC && c.s === 0x0400) {
        return { cycles, times };
      }
    }
  } finally {
    delete mach.busRead;
    delete mach.busWrite;
    c.trace = null;
  }
  throw new Error('ROM sound IRQ did not return');
}

/**
 * Drive a port generator to its end, recording the sound CPU's charged
 * cycles at every SYNC.
 * @param {Machine} m @param {Generator<unknown, unknown, unknown>} g
 * @param {number} base cycles to add to every time (the IRQ entry)
 * @returns {{ cycles: number, times: number[] }}
 */
function drain(m, g, base) {
  const c0 = m.charged[SOUND];
  /** @type {number[]} */
  const times = [];
  for (let r = g.next(); !r.done; r = g.next()) {
    if (r.value === SYNC) times.push(base + m.charged[SOUND] - c0);
    else throw new Error(`unexpected yield ${String(r.value)}`);
  }
  return { cycles: base + m.charged[SOUND] - c0, times };
}

/**
 * The port's IRQ on `m`.
 * @param {Machine} m @returns {{ cycles: number, times: number[] }}
 */
function portIrq(m) {
  return drain(m, /** @type {Generator<unknown, unknown, unknown>} */ (
    soundAt(0xe055)(m)), IRQ_ENTRY_CYCLES);
}

/**
 * Oracle board and port machine with the same RAM.
 * @param {{ mem: Uint8Array }} src
 * @returns {{ board: Board, m: Machine }}
 */
function pairFrom(src) {
  const board = makeOracle();
  const m = new Machine();
  loadState(board, src);
  loadState(m, src);
  return { board, m };
}

/**
 * Run one IRQ on both sides and compare everything.
 * @param {Board} board @param {Machine} m @param {string} what
 */
function sameIrq(board, m, what) {
  const rom = romIrq(board);
  const port = portIrq(m);
  assert.deepEqual(diffRam(board, m), [], `${what}: RAM`);
  assert.deepEqual(port.times, rom.times, `${what}: timed accesses`);
  assert.equal(port.cycles, rom.cycles, `${what}: cycles`);
}

// ------------------------------------------------------------------ tests

test('registration: routines, vectors and jump-table targets', () => {
  const entries = [0xe000, 0xe055, 0xe233, 0xe27f, 0xe285, 0xe2dc, 0xe309,
    0xe369];
  for (const a of entries) assert.ok(SOUND_AT[a], `$${a.toString(16)}`);
  assert.equal(SOUND_AT[soundWord(0xfffe)], SOUND_AT[0xe000]);
  assert.equal(SOUND_AT[soundWord(0xfff8)], SOUND_AT[0xe055]);
  for (let i = 0; i < 4; i += 1) {
    const t = soundWord(0xe29f + 2 * i);
    assert.ok(SOUND_AT[t], `envelope_ops[${i}] $${t.toString(16)}`);
  }
  for (let i = 0; i < 8; i += 1) {
    const t = soundWord(0xe376 + 2 * i);
    assert.ok(SOUND_AT[t], `stream_ops[${i}] $${t.toString(16)}`);
  }
});

test('reset_sound: random RAM, handshake $11 -> idle, same RAM and timing', () => {
  for (let seed = 1; seed <= 3; seed += 1) {
    const m = new Machine();
    fillRandom(m, seed);
    m.sound.poke(0x40, 0x11);
    const board = makeOracle();
    loadState(board, m);
    board.machine.sreset = false;
    // ROM: from the reset vector to the idle loop.
    const c = board.cpus[SOUND];
    c.setState({ cc: 0x50, wait: 0, irqLine: false });
    c.reset(); // the vector fetch: charged by the scheduler in the port
    let cycles = 0;
    /** @type {number[]} */
    const stores = [];
    let start = 0;
    c.trace = () => { start = cycles; };
    board.onWrite = (n, a) => { if (n === SOUND && timed(a)) stores.push(start); };
    while (c.pc !== IDLE_PC) cycles += c.step();
    board.onWrite = null;
    c.trace = null;
    // Port: to the idle marker.
    const g = soundAt(0xe000)(m);
    const c0 = m.charged[SOUND];
    /** @type {number[]} */
    const syncs = [];
    for (;;) {
      const r = g.next();
      assert.equal(r.done, false);
      if (r.value === SYNC) { syncs.push(m.charged[SOUND] - c0); continue; }
      assert.deepEqual(r.value, { idle: 3 }, 'ends in BRA * (3 cycles)');
      break;
    }
    assert.deepEqual(diffRam(board, m), [], `seed ${seed}`);
    assert.equal(m.charged[SOUND] - c0, cycles, 'cycles to the idle loop');
    // Every timed store (latches, $22, the clear of $0040-$007F) is at a
    // SYNC with the same cycle; the poll's reads add SYNCs of their own.
    for (const t of stores) assert.ok(syncs.includes(t), `store at ${t}`);
    assert.equal(m.soundRam[0x380], 0, 'ROM checksum is good');
  }
});

/**
 * RAM snapshots of the full board at vblank: attract mode, a coin, a
 * played game (seeded random stick and fire).
 * @param {number} frames @param {number} every
 * @returns {Uint8Array[]}
 */
function realSnapshots(frames, every) {
  const board = makeOracle();
  board.tap('coin1', 1100);
  board.tap('start1', 1300);
  const player = randomPlayer(5, { from: 1400 });
  board.inputScript = (f, b) => player(f, b);
  /** @type {Uint8Array[]} */
  const out = [];
  for (let f = 0; f < frames; f += 1) {
    board.runFrame();
    if (f >= 250 && f % every === 0) out.push(board.mem.slice());
  }
  return out;
}

test('irq_sound: real traffic (attract, coin, played game)', () => {
  const snaps = realSnapshots(5200, 13);
  assert.ok(snaps.length > 300);
  let busy = 0;
  for (const [i, mem] of snaps.entries()) {
    const { board, m } = pairFrom({ mem });
    sameIrq(board, m, `snapshot ${i}`);
    if (m.peek(0x6040) || m.peek(0x6041)) busy += 1;
  }
  assert.ok(busy > 0, 'some sounds were playing');
});

test('every sound 0-25 from request to end, frame by frame', () => {
  // A quiet post-boot state: attract mode just started, then silence.
  const boot = makeOracle();
  boot.runFrames(260);
  const base = boot.mem.slice();
  for (let i = 0x6040; i < 0x6080; i += 1) base[i] = 0;
  for (let n = 0; n < 26; n += 1) {
    const { board, m } = pairFrom({ mem: base });
    board.poke(0x6040 + n, 1);
    m.mem[0x6040 + n] = 1;
    let f = 0;
    for (; f < 900; f += 1) {
      sameIrq(board, m, `sound ${n} frame ${f}`);
      if (m.mem[0x6040 + n] === 0 && m.mem[0x6060 + n] === 0) break;
    }
  }
});

test('irq_sound: random requests on real states', () => {
  const snaps = realSnapshots(1600, 97);
  const rng = makeRng(77);
  for (const [i, mem] of snaps.entries()) {
    const { board, m } = pairFrom({ mem });
    // Request a random handful, then run 40 frames.
    for (let k = 0; k < 4; k += 1) {
      const n = rng() % 26;
      const v = 1 + (rng() % 2);
      board.poke(0x6040 + n, v);
      m.mem[0x6040 + n] = v;
    }
    for (let f = 0; f < 40; f += 1) sameIrq(board, m, `state ${i} f ${f}`);
  }
});

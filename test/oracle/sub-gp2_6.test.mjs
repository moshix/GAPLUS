// Copyright 2026 by Moshix
/**
 * Oracle tests of src/game/sub/gp2_6.js: reset_sub (boot handshake,
 * ROM checksums, the frames it burns), irq_sub (sprite copy, the
 * frame_sync rendezvous), task_dispatch_sub / task_end_frame_sub, and the
 * registration of every gp2-6.11b routine reached through a table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Board } from '../m6809/board.mjs';
import { roms, makeOracle, loadState } from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';
import {
  pair, randomize, same, rng, romTask, portTask, sameTiming, probe,
  timedAddr, SUB_CPU,
} from './sub-gp2_6-kit.test.mjs';
import {
  reset_sub, irq_sub, task_dispatch_sub, SPIN, RENDEZVOUS, SYNC,
} from '../../src/game/sub/gp2_6.js';
import { SUB_AT } from '../../src/game/sub/routines.js';
import { romWord } from '../../src/game/romdata.js';

const hex = (/** @type {number} */ v) => v.toString(16).toUpperCase();

// ------------------------------------------------------------ registry

/** Every jump table of the chip: [address, entries]. */
const TABLES = [[0xe359, 8], [0xe7f5, 5], [0xf62b, 5], [0xfba8, 4],
  [0xfc9e, 4]];

test('every gp2-6 task-list entry is registered', () => {
  for (let mode = 0; mode < 10; mode += 1) {
    const list = romWord('sub', 0xe0f9 + 2 * mode);
    // Each list ends with task_end_frame_sub ($E17F), or at the next list
    // (mode 0 ends in task_formation_init's own CWAI).
    const next = mode < 9 ? romWord('sub', 0xe0fb + 2 * mode) : 0xe17f;
    for (let p = list; p < next; p += 2) {
      const t = romWord('sub', p);
      if (t < 0xe000) continue; // another chip's task
      assert.equal(typeof SUB_AT[t], 'function', `mode ${mode}: $${hex(t)}`);
      if (t === 0xe17f) break;
    }
  }
  assert.equal(typeof SUB_AT[0xe000], 'function');
  assert.equal(typeof SUB_AT[0xe061], 'function');
  assert.equal(romWord('sub', 0xfffe), 0xe000);
  assert.equal(romWord('sub', 0xfff8), 0xe061);
});

test('every gp2-6 jump-table target is registered', () => {
  for (const [t, n] of TABLES) {
    for (let i = 0; i < n; i += 1) {
      const a = romWord('sub', t + 2 * i);
      assert.equal(typeof SUB_AT[a], 'function', `$${hex(t)}[${i}] $${hex(a)}`);
    }
  }
});

// --------------------------------------------------------------- reset

/**
 * The ROM's boot on the full board, from power-on until the ANDCC at
 * $E05C has run: every write and every shared access of the sub CPU,
 * stamped with the cycle its instruction starts, relative to the start
 * of the last (successful) poll of $0800 at $E00A. The ANDCC is a timed
 * point too (the port SYNCs before it).
 * @param {Board} board
 */
function oracleBoot(board) {
  const abs = () => board.frame * 25344 + board.frameCycle();
  const mach = board.machine;
  const proto = Object.getPrototypeOf(mach);
  let start = 0;
  let base = -1;
  let poll = 0;
  let done = false;
  /** @type {Array<[number, number, number]>} */
  const writes = [];
  /** @type {number[]} */
  const times = [];
  const mark = (/** @type {number} */ a) => {
    if (base < 0 || done || !timedAddr(a)) return;
    if (times[times.length - 1] !== start - base) times.push(start - base);
  };
  board.onExec = (n, pc) => {
    if (n !== SUB_CPU || done) return;
    start = abs();
    if (pc === 0xe00a) poll = start;
    if (pc === 0xe011 && base < 0) {
      base = poll;
      times.push(0); // the successful poll's read of $0800
    }
    if (pc === 0xe05c) times.push(start - base);
    if (pc === 0xe05e) done = true;
  };
  mach.busRead = function busRead(/** @type {number} */ n,
    /** @type {number} */ a) {
    if (n === SUB_CPU) mark(a & 0xffff);
    return proto.busRead.call(this, n, a);
  };
  mach.busWrite = function busWrite(/** @type {number} */ n,
    /** @type {number} */ a, /** @type {number} */ v) {
    if (n === SUB_CPU && base >= 0 && !done) {
      mark(a & 0xffff);
      writes.push([start - base, a & 0xffff, v & 0xff]);
    }
    proto.busWrite.call(this, n, a, v);
  };
  try {
    let guard = 0;
    while (!done && guard < 200) { board.runFrame(); guard += 1; }
  } finally {
    delete mach.busRead;
    delete mach.busWrite;
    board.onExec = null;
  }
  return { writes, times, frame: board.frame };
}

/**
 * The port's reset_sub up to its ANDCC (the onCli hook), the $11 posted
 * at the first SPIN: its writes and SYNC stamps relative to the charged
 * time of the successful poll (failed polls are not charged).
 * @param {(m: Machine) => void} [patch]
 */
function portBoot(patch) {
  const m = new Machine();
  patch?.(m);
  /** @type {Array<[number, number, number]>} */
  const writes = [];
  /** @type {number[]} */
  const times = [];
  let base = -1;
  const rel = () => m.charged[SUB_CPU] - base;
  const bw = m.busWrite;
  m.busWrite = (cpu, a, v) => {
    if (cpu === SUB_CPU) writes.push([rel(), a & 0xffff, v & 0xff]);
    bw.call(m, cpu, a, v);
  };
  const stop = new Error('cli');
  m.hooks.onCli = () => { throw stop; };
  const g = reset_sub(m);
  let spins = 0;
  try {
    for (;;) {
      const r = g.next();
      assert.equal(r.done, false);
      if (r.value === SPIN) {
        spins += 1;
        m.mem[0x0800] = 0x11; // the main CPU's handshake
      } else {
        assert.equal(r.value, SYNC, 'only SYNC / SPIN at boot');
        if (base < 0) base = m.charged[SUB_CPU];
        if (times[times.length - 1] !== rel()) times.push(rel());
      }
    }
  } catch (e) {
    if (e !== stop) throw e;
  }
  return { writes, times, spins, m };
}

test('reset_sub: every write and shared access at the ROM\'s cycle', () => {
  const board = new Board({ roms: roms() });
  const rom = oracleBoot(board);
  const port = portBoot();
  assert.equal(port.spins, 1);
  assert.deepEqual(port.writes, rom.writes, 'timed writes');
  assert.deepEqual(port.times, rom.times, 'SYNC stamps');
  // 1 + 1 + 256 writes: $0801, $0800, and the $6001 latch ($500F is
  // unmapped in the port's view too, but still a bus write)
  assert.equal(port.writes.length, 2 + 512);
  // 13 frames of checksums: the $22 lands in frame 109 on the board
  const t22 = port.writes.find(([, a]) => a === 0x0800)?.[0] ?? 0;
  assert.equal(Math.floor((96 * 25344 + 17119 + t22) / 25344), 109);
  assert.equal(port.m.irqMask[SUB_CPU], 1);
});

test('reset_sub: bad ROM sums leave 6/5/4 in $0801 at the ROM\'s cycles', () => {
  // One $FF fill byte in each chip ($BFA9, $DF51, $FFC7) changed.
  const cases = [[0xbfa9], [0xdf51], [0xffc7], [0xbfa9, 0xffc7],
    [0xbfa9, 0xdf51, 0xffc7]];
  for (const addrs of cases) {
    const r = roms();
    const sub = r.sub.slice();
    for (const a of addrs) sub[a] = 0x12;
    const board = new Board({ roms: { ...r, sub } });
    const rom = oracleBoot(board);
    const port = portBoot((m) => {
      const read = m.sub.read.bind(m.sub);
      m.sub.read = (a) => (addrs.includes(a & 0xffff) ? 0x12 : read(a));
    });
    const what = addrs.map(hex).join(',');
    assert.deepEqual(port.writes, rom.writes, what);
    assert.deepEqual(port.times, rom.times, what);
    assert.ok(port.writes.some(([, a, v]) => a === 0x0801 && v >= 0x34));
  }
});

// ----------------------------------------------------------------- IRQ

/**
 * Run irq_sub on the oracle's sub CPU from $E061 to its RTI, calling tick
 * at each failed poll of frame_sync (the `bne $E0E2`). Failed passes (9
 * cycles each) are waiting and not counted, as in the port; the RTI
 * (15 cycles, entire state) is added at the end.
 * @param {Board} board
 * @param {(o: { mem: Uint8Array }, n: number) => void} tick
 */
function romIrq(board, tick) {
  const c = board.cpus[SUB_CPU];
  c.setState({ a: 0, dp: 0x10, cc: 0x50, pc: 0xe061, s: 0x1d74, wait: 0 });
  const save = board.syncOnLatch;
  board.syncOnLatch = false;
  const p = probe(board);
  let ticks = 0;
  try {
    while (c.pc !== 0xe0eb) {
      p.cycles += c.step();
      // back at $E0E2 from the bne at $E0E6: one failed poll
      if (c.pc === 0xe0e2 && c.ppc === 0xe0e6) {
        p.cycles -= 4 + 2 + 3;
        tick(board, ticks);
        ticks += 1;
      }
      if (p.cycles > 1_000_000) throw new Error('irq_sub runaway');
    }
  } finally {
    p.done();
    board.syncOnLatch = save;
    const q = board.syncQueue;
    board.syncQueue = [];
    for (const f of q) f();
  }
  return {
    ticks, cycles: p.cycles + 15, times: p.times, writes: p.writes,
    waits: [],
  };
}

test('irq_sub: sprite copy (flip on/off), parking, rendezvous, timing', () => {
  const { board, m, poke } = pair();
  const r = rng(11);
  for (let i = 0; i < 300; i += 1) {
    randomize(board, m, 11000 + i);
    // In-use density from none to all, so the copy ends both by running
    // out of shadows ($0EE2) and by filling slot 39 ($0FD0).
    const p = [0, 0.05, 0.3, 0.6, 1][i % 5];
    for (let u = 0x0e00; u < 0x0ee2; u += 2) {
      const f = r.byte();
      poke(u + 0x1001, r.chance(p) ? f | 0x80 : f & 0x7f);
    }
    poke(0x102c, i & 1 ? 0 : r.byte() | 1);
    poke(0x10af, r.chance(0.5) ? 0x22 : r.byte());
    // the main IRQ answers after k failed polls (k = 0: already there
    // cannot happen, the handler writes $11 first)
    const k = r.int(4);
    /** @param {{ mem: Uint8Array }} o @param {number} n */
    const tick = (o, n) => { if (n === k) o.mem[0x10af] = 0x22; };
    m.irqMask[SUB_CPU] = 1;
    board.machine.irqMask[SUB_CPU] = 1;
    const rom = romIrq(board, tick);
    const port = portTask(irq_sub, m, { tick });
    const what = `irq_sub #${i}`;
    assert.equal(port.ticks, rom.ticks, `${what} ticks`);
    assert.equal(rom.ticks, k + 1);
    assert.ok(port.yields.every((y) => y === RENDEZVOUS));
    same(board, m, what);
    sameTiming(rom, port, what);
    assert.equal(m.irqMask[SUB_CPU], 1, 'IRQ back on');
  }
});

test('irq_sub: $10AF = $11 at the board\'s cycle, real frames', () => {
  // Real states (attract with the demo, 40 frames apart): the board's
  // handler, from its first instruction at $E061 to the start of the
  // `sta <$AF` at $E0E0, against the port's stamp of that store.
  const board = makeOracle();
  board.runFrames(300);
  for (let k = 0; k < 40; k += 1) {
    board.runFrames(39);
    const m = new Machine();
    loadState(m, board);
    let t0 = -1;
    let t1 = -1;
    board.onExec = (n, pc) => {
      if (n !== SUB_CPU) return;
      if (pc === 0xe061 && t0 < 0) t0 = board.frameCycle();
      if (pc === 0xe0e0 && t1 < 0) t1 = board.frameCycle();
    };
    board.runFrame();
    board.onExec = null;
    const port = portTask(irq_sub, m, {
      tick: (o) => { o.mem[0x10af] = 0x22; },
    });
    const w = port.writes.find(([, a, v]) => a === 0x10af && v === 0x11);
    assert.ok(t0 >= 0 && t1 > t0, `frame ${board.frame}: handler ran`);
    assert.equal(w?.[0], t1 - t0, `frame ${board.frame}: $E0E0`);
  }
});

test('irq_sub: 125 lost frames at boot are 125+ RENDEZVOUS yields', () => {
  const m = new Machine();
  const t = portTask(irq_sub, m, {
    tick: (o, n) => { if (n === 999) o.mem[0x10af] = 0x22; },
    maxTicks: 2000,
  });
  assert.equal(t.ticks, 1000);
});

// ---------------------------------------------------------- dispatcher

test('task_end_frame_sub: one frame, then sub_task = 0', () => {
  const { board, m, poke } = pair();
  for (let i = 0; i < 20; i += 1) {
    randomize(board, m, 12000 + i);
    poke(0x107a, i * 13);
    const tick = (/** @type {{ mem: Uint8Array }} */ o) => { o.mem[0x107a] = 0x55; };
    const rom = romTask(board, 0xe17f, { tick });
    const port = portTask(SUB_AT[0xe17f], m, { tick });
    assert.equal(rom.ticks, 1);
    assert.equal(port.ticks, 1);
    same(board, m, `task_end_frame_sub #${i}`);
    sameTiming(rom, port, `task_end_frame_sub #${i}`);
  }
});

test('task_dispatch_sub: modes 1 and 2 to the CWAI, SYNC at each task', () => {
  const { board, m, poke } = pair();
  const r = rng(13);
  const c = board.cpus[SUB_CPU];
  for (let i = 0; i < 200; i += 1) {
    randomize(board, m, 13000 + i);
    poke(0x102f, 1 + (i & 1));
    poke(0x107a, 0);
    poke(0x1081, 0); // mode 2: task_stage_setup's first pass
    poke(0x106e, r.int(3));
    // ROM: from $E0EC to the CWAI of task_end_frame_sub, every task
    // entry (the instruction after `jmp [b,u]`) a timed point too.
    c.setState({ dp: 0x10, cc: 0x40, pc: 0xe0ec, s: 0x1d80, wait: 0 });
    c.irqLine = false;
    const save = board.syncOnLatch;
    board.syncOnLatch = false;
    const p = probe(board);
    try {
      while (c.wait === 0) {
        p.cycles += c.step();
        if (c.ppc === 0xe0f7 && p.times[p.times.length - 1] !== p.cycles) {
          p.times.push(p.cycles);
          p.lastMark = p.cycles;
        }
        if (p.cycles > 2_000_000) throw new Error('no CWAI');
      }
    } finally {
      p.done();
      board.syncOnLatch = save;
    }
    // Port: the loop up to its first bare yield (that CWAI).
    const c0 = m.charged[SUB_CPU];
    /** @type {number[]} */
    const times = [];
    /** @type {Array<[number, number, number]>} */
    const writes = [];
    const bw = m.busWrite;
    m.busWrite = (cpu, a, v) => {
      if (cpu === SUB_CPU && !(a >= 0x1d74 && a <= 0x1d80)) {
        writes.push([m.charged[SUB_CPU] - c0, a & 0xffff, v & 0xff]);
      }
      bw.call(m, cpu, a, v);
    };
    const g = task_dispatch_sub(m);
    try {
      for (;;) {
        const y = g.next();
        if (y.value === undefined) break;
        assert.equal(y.value, SYNC);
        const t = m.charged[SUB_CPU] - c0;
        if (times[times.length - 1] !== t) times.push(t);
      }
    } finally {
      m.busWrite = bw;
    }
    const what = `dispatch #${i} mode ${m.mem[0x102f]}`;
    same(board, m, what);
    assert.deepEqual(writes, p.writes, `${what}: writes`);
    assert.deepEqual(times, p.times, `${what}: SYNC stamps`);
    assert.equal(m.charged[SUB_CPU] - c0, p.cycles, `${what}: cycles`);
  }
});

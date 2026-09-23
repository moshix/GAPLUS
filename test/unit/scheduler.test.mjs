// Copyright 2026 by Moshix
/**
 * src/game/scheduler.js with synthetic CPUs: the yield vocabulary, the
 * clock, interrupts, SRESET and the watchdog. The whole scheduler against
 * the real ROM is test/oracle/lockstep.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machine } from '../../src/machine/machine.js';
import {
  Scheduler, SPIN, SYNC, BUSY, RENDEZVOUS, NO_RTI, idle, CpuHang,
  FRAME_TICKS, TICKS_PER_CYCLE, IRQ_ENTRY_CYCLES, CWAI_WAKE_CYCLES,
  RESET_CYCLES, taskAddresses,
} from '../../src/game/scheduler.js';

/** @typedef {import('../../src/game/scheduler.js').CpuEntries} CpuEntries */
/** @typedef {Generator<unknown, unknown, unknown>} Thread */

/** A CPU that idles forever (no IRQ handler needed). @type {CpuEntries} */
const IDLE_CPU = { reset: function* sleep() { for (;;) yield; }, irq: null };

/**
 * A scheduler whose main CPU runs `main`; sub and sound idle.
 * @param {CpuEntries} main @param {CpuEntries} [sub]
 * @param {CpuEntries} [sound]
 */
function make(main, sub = IDLE_CPU, sound = IDLE_CPU) {
  const m = new Machine();
  const s = new Scheduler(m, { main, sub, sound });
  return { m, s };
}

/** Cycles since the current frame's vblank, now. @param {Scheduler} s */
const cyc = (s) => s.frameCycle();

test('registered yield symbols are the porters\' ones', () => {
  assert.equal(SPIN, Symbol.for('gaplus.SPIN'));
  assert.equal(BUSY, Symbol.for('gaplus.busy'));
  assert.equal(RENDEZVOUS, Symbol.for('gaplus.rendezvous'));
  assert.equal(SYNC, Symbol.for('gaplus.sync'));
  assert.equal(NO_RTI, Symbol.for('gaplus.noRti'));
  assert.equal(idle(3), idle(3));
  assert.deepEqual(idle(7), { idle: 7 });
});

test('plain yield: one frame per yield; charges move the CPU clock', () => {
  /** @type {Array<[number, number]>} frame, cycle */
  const seen = [];
  const { s } = make({
    reset: function* fg(m) {
      for (;;) {
        seen.push([s.frame, cyc(s)]);
        m.charge(1000);
        yield SYNC;
        seen.push([s.frame, cyc(s)]);
        yield;
      }
    },
    irq: null,
  });
  s.runFrames(3);
  // Power-on: the reset vector fetch (4 cycles); the SYNC resumes 1000
  // cycles later (within the same slice run, frame 0); plain yields wake
  // at each vblank.
  assert.deepEqual(seen.slice(0, 4), [[0, RESET_CYCLES], [0, RESET_CYCLES + 1000],
    [1, 0], [1, 1000]]);
});

test('SPIN re-polls once per slice until another CPU writes', () => {
  let polls = 0;
  const { m, s } = make({
    reset: function* fg(mm) {
      mm.poke(0x8400, 0); // SRESET off: the sub starts
      while (mm.peek(0x0800) !== 0x22) { polls += 1; yield SPIN; }
      mm.poke(0x0801, s.frame);
      for (;;) yield;
    },
    irq: null,
  }, {
    reset: function* sub(mm) {
      mm.sub.charge(3000); // the sub answers 3000 cycles after it starts
      yield SYNC;
      mm.sub.poke(0x0800, 0x22);
      for (;;) yield;
    },
    irq: null,
  });
  s.runFrame();
  assert.equal(m.mem[0x0800], 0x22);
  assert.equal(m.mem[0x0801], 0);
  // one poll per 256-cycle slice (the first slice is cut short by the
  // 5-cycle writes, so a few more)
  assert.ok(polls >= 3000 / 256 && polls <= 3000 / 256 + 4, `polls ${polls}`);
});

test('BUSY: a timing point after a charge, a poll without one', () => {
  let passes = 0;
  const { s } = make({
    reset: function* fg(m) {
      for (;;) { m.charge(100); passes += 1; yield BUSY; }
    },
    irq: null,
  });
  s.runFrame();
  // 100 cycles a pass: the frame holds 25,344 / 100 passes.
  assert.equal(passes, Math.ceil(25344 / 100));
  let polls = 0;
  const b = make({ reset: function* fg() { for (;;) { polls += 1; yield BUSY; } }, irq: null });
  b.s.runFrame();
  assert.ok(polls < 25344 / 256 + 4, `a free BUSY polls per slice (${polls})`);
});

test('IRQ: taken at vblank, entry 19 cycles; out of CWAI 4 cycles', () => {
  /** @type {number[]} */
  const starts = [];
  const irq = function* handler(/** @type {Machine} */ m) {
    starts.push(cyc(s));
    m.poke(0x7c00, 0); // acknowledge (mask off)
    m.charge(500);
    yield SYNC;
    m.poke(0x7400, 0); // mask on again
  };
  const { s } = make({
    reset: function* fg(m) {
      m.poke(0x7400, 0); // IRQ mask on
      m.cli();
      // Frame 0: a busy loop (charged); from frame 1 on: CWAI.
      for (let i = 0; i < 300; i += 1) { m.charge(100); yield SYNC; }
      for (;;) yield;
    },
    irq,
  });
  s.runFrames(3);
  // Frame 1 interrupts the busy loop: at the end of the chunk that runs
  // across the vblank (whole 100-cycle chunks from cycle 4), + 19.
  const firstChunkEnd = (Math.ceil((25344 - 4) / 100) * 100 + 4) - 25344;
  assert.equal(starts[0], firstChunkEnd + IRQ_ENTRY_CYCLES);
  // Frame 2 wakes the CWAI: 4 cycles.
  assert.equal(starts[1], CWAI_WAKE_CYCLES);
});

test('idle(p): the IRQ enters on a pass boundary, as BRA * does', () => {
  /** @type {number[]} */
  const starts = [];
  const { s } = make(IDLE_CPU, IDLE_CPU, IDLE_CPU);
  const m = s.m;
  const sound = /** @type {import('../../src/game/scheduler.js').JsAgent} */ (
    s.agents[2]);
  sound.entries = {
    reset: function* fg(mm) {
      mm.sound.charge(10);
      yield SYNC;
      mm.sound.poke(0x4000, 0); // sound IRQ mask on
      mm.sound.cli();
      for (;;) yield idle(3);
    },
    irq: function* h(mm) { starts.push(cyc(s)); mm.sound.poke(0x6000, 0); mm.sound.poke(0x4000, 0); },
  };
  // SRESET off at cycle 0 of frame 0: the sound starts at 4 cycles.
  m.poke(0x8400, 0);
  s.applySreset(false, 0);
  s.runFrames(2);
  // Its loop began at 4 + 10 + 5 (the STA $4000) ... passes of 3 cycles
  // from there; the vblank finds it mid-pass and the entry waits for the
  // pass to end.
  const loop0 = 4 + 10;
  const phase = (25344 - loop0) % 3;
  assert.equal(starts[0], phase === 0 ? IRQ_ENTRY_CYCLES : 3 - phase + IRQ_ENTRY_CYCLES);
});

test('NO_RTI leaves CC.I set; a normal return clears it', () => {
  let noRti = true;
  const { m, s } = make({
    reset: function* fg(mm) { mm.poke(0x7400, 0); mm.cli(); for (;;) yield; },
    irq: function* h(mm) {
      mm.poke(0x7c00, 0);
      mm.poke(0x7400, 0);
      return noRti ? NO_RTI : undefined;
    },
  });
  s.runFrames(2);
  assert.equal(m.iMask[0], true, 'jumped out: I still set');
  m.iMask[0] = false;
  noRti = false;
  s.runFrame();
  assert.equal(m.iMask[0], false, 'RTI: I clear');
});

test('SRESET: sub and sound start where the STA $8400 ends', () => {
  let subStart = -1;
  const { s } = make({
    reset: function* fg(m) {
      m.charge(12000);
      yield SYNC;
      m.poke(0x8400, 0);
      for (;;) yield;
    },
    irq: null,
  }, {
    reset: function* sub() { subStart = cyc(s); for (;;) yield; },
    irq: null,
  });
  s.runFrame();
  // main: 4 (vector) + 12000, then the 5-cycle STA; the sub's vector
  // fetch, 4 cycles more.
  assert.equal(subStart, 4 + 12000 + 5 + 4);
});

test('a hung CPU is parked; a stuck one (no time passing) throws', () => {
  const { s } = make({
    reset: function* fg() { yield; throw new CpuHang('$1234'); },
    irq: null,
  });
  s.runFrames(3);
  const a = /** @type {import('../../src/game/scheduler.js').JsAgent} */ (s.agents[0]);
  assert.match(a.hung, /\$1234/);
  const b = make({ reset: function* fg() { for (;;) yield SYNC; }, irq: null });
  assert.throws(() => b.s.runFrame(), /without time passing/);
});

test('the watchdog fires 3 s after the last kick and restarts the CPUs', () => {
  let starts = 0;
  const { m, s } = make({
    reset: function* fg(mm) {
      starts += 1;
      mm.peek(0x7800); // one kick, then never again
      for (;;) yield;
    },
    irq: null,
  });
  s.runFrames(200);
  assert.equal(s.watchdogResets, 1);
  assert.equal(starts, 2);
  assert.equal(m.sreset, false, 'every CPU runs after a watchdog reset');
});

test('taskAddresses: two-level task lists up to the end-frame task', () => {
  // mode table at $1000: two lists at $1010 and $1020
  const rom = new Map([[0x1000, 0x1010], [0x1002, 0x1020],
    [0x1010, 0xa000], [0x1012, 0xa100], [0x1014, 0xd150], [0x1016, 0xbbbb],
    [0x1020, 0xa100], [0x1022, 0xd150]]);
  const word = (/** @type {number} */ a) => rom.get(a) ?? 0;
  assert.deepEqual(taskAddresses(word, 0x1000, 2, 0xd150),
    [0xa000, 0xa100, 0xd150]);
});

test('frame boundaries: runFrame stops just before the next vblank', () => {
  const { s } = make(IDLE_CPU);
  s.runFrames(5);
  assert.equal(s.frame, 5);
  assert.equal(s.t, 5 * FRAME_TICKS);
  assert.equal(FRAME_TICKS, 25344 * TICKS_PER_CYCLE);
});

// Copyright 2026 by Moshix
/**
 * Differential test of the service mode (main $B6F6-$BE77,
 * src/game/main/gp2_4_svc.js), frame by frame, as a hybrid:
 *
 *   - the oracle boots the whole board (all three CPUs, I/O chips); the
 *     main CPU's arrival at $B6F6 is caught mid-frame and the RAM,
 *     latches and I/O chips at that instant become the port's;
 *   - the port runs only the service_mode generator, on a test
 *     foreground clock started at the oracle's cycle of arrival;
 *   - every write of the sub and sound CPUs is recorded with its frame
 *     and cycle and replayed into the port: at the end of its frame, or,
 *     while the port busy-waits on a handshake (`yield SPIN`), up to the
 *     port's clock;
 *   - after every frame the RAM (minus stacks), the IRQ masks, SRESET and
 *     the I/O chips must be identical.
 *
 * Two entries are covered: the service switch on at power-on (reset_main
 * $E1CF jumps to $B6F6 in frame 171) and switched on during attract (the
 * IRQ handler's $C016 jump). Each run goes through the RAM tests, chip
 * checks, ROM checksums, the release and handshakes, the DIP screen and
 * the service loop, then exercises the loop: the service coin (cross
 * hatch), sound-test inputs, and the switch off (jump to reset_main).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOracle, diffRam } from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';
import { MAIN_AT } from '../../src/game/main/routines.js';
import { SPIN } from '../../src/game/main/gp2_4_clock.js';
import { installStubs } from './main-gp2_4-lib.test.mjs';
import { clockOf, setClock } from '../../src/game/clock.js';
import { takeJump } from '../../src/game/main/jump.js';

installStubs();

/**
 * @typedef {object} Write
 * @property {number} frame @property {number} cyc
 * @property {number} cpu @property {number} addr @property {number} v
 */

/**
 * Run a board until the main CPU starts $B6F6, and set up the port there.
 * @param {(b: import('../m6809/board.mjs').Board) => void} prepare
 *   before the first frame
 * @param {number} maxFrames
 * @param {(mm: Machine) => void} [fault] patches both machines' buses
 *   the same way (a stuck RAM bit, a wrong chip answer)
 */
function catchEntry(prepare, maxFrames, fault = () => {}) {
  const b = makeOracle();
  prepare(b);
  /** @type {Write[]} */
  const writes = [];
  /** @type {Array<[number, number, number, number]>} */
  const mainWrites = [];
  /**
   * @type {null | { state: object, cyc: number, a: number,
   *   frame: number }}
   */
  let entry = null;
  b.onExec = (n, pc, core) => {
    if (n !== 0 || pc !== 0xb6f6 || entry !== null) return;
    entry = {
      state: b.machine.getState(), cyc: b.frameCycle(), a: core.a,
      frame: b.frame,
    };
    fault(b.machine); // from the entry on, on both sides
    b.onWrite = (cpu, addr, v) => {
      if (cpu !== 0) {
        writes.push({ frame: b.frame, cyc: b.frameCycle(), cpu, addr, v });
      } else if (addr < 0x15e2 || addr >= 0x1600) {
        // The main CPU's own writes (not its stack, exempt anyway),
        // stamped with the cycle at which the writing instruction
        // started (frameCycle() is mid-instruction).
        mainWrites.push([b.frame, b.frameCycle() - b.cpus[0].cyc, addr, v]);
      }
    };
  };
  for (let i = 0; i < maxFrames && entry === null; i += 1) b.runFrame();
  b.onExec = null;
  assert.ok(entry, 'service mode reached');
  const m = new Machine();
  fault(m);
  m.setState(/** @type {import('../../src/machine/machine.js').MachineState} */
    (entry.state));
  // The outside world (DIPs, switches) is not machine state.
  m.io.inputs.dips = { ...b.machine.io.inputs.dips };
  m.io.inputs.in2 = b.machine.io.inputs.in2;
  return { b, m, writes, mainWrites, entry };
}

/**
 * The lock-step of one run.
 * @param {ReturnType<typeof catchEntry>} run
 * @param {Array<[number, (x: { b: import('../m6809/board.mjs').Board,
 *   m: Machine }) => void]>} script inputs to apply before frame N
 *   (relative to the entry frame)
 * @param {number} frames how many frames after the entry to compare
 * @param {boolean} lazyIo I/O run at cycle 76 as on the oracle
 * @param {boolean} exactAfterRelease compare the writes after $B8B5 too
 * @returns {{ jumpFrame: number }}
 */
function lockstep(run, script, frames, lazyIo, exactAfterRelease) {
  const { b, m, writes, entry } = run;
  setClock(m, entry.cyc);
  const fgClock = clockOf(m);
  // The port's main-CPU writes with the port clock: its Clock burns up to
  // the start of every writing instruction first, so fgClock.t is that
  // instruction's start cycle.
  /** @type {Array<[number, number, number, number]>} */
  const portWrites = [];
  // The I/O chips' run: at vblank + 76.8 cycles on the oracle, which
  // delivers it before the first main-CPU access to $6800-$681F in cycle
  // index 76 or later. With `lazyIo` the harness does the same on the
  // port (the access taken 4 cycles into the instruction, as for LDA
  // extended); otherwise at the start of the frame, as the port's
  // scheduler does.
  let ioPending = false;
  /** @param {number} cpu @param {number} addr */
  const ioCatchUp = (cpu, addr) => {
    if (ioPending && cpu === 0 && addr >= 0x6800 && addr < 0x6820
      && fgClock.t + 4 >= 76) {
      ioPending = false;
      m.ioUpdate();
    }
  };
  const busRead = m.busRead.bind(m);
  m.busRead = (cpu, addr) => {
    ioCatchUp(cpu, addr);
    return busRead(cpu, addr);
  };
  const busWrite = m.busWrite.bind(m);
  m.busWrite = (cpu, addr, v) => {
    ioCatchUp(cpu, addr);
    if (cpu === 0 && (addr < 0x15e2 || addr >= 0x1600)) {
      portWrites.push(
        [entry.frame + fgClock.frames, fgClock.t, addr, v & 0xff]);
    }
    busWrite(cpu, addr, v);
  };
  let next = 0; // index of the first write not yet replayed
  /** @param {number} frame @param {number} cyc */
  const replay = (frame, cyc) => {
    while (next < writes.length) {
      const w = writes[next];
      if (w.frame > frame || (w.frame === frame && w.cyc > cyc)) break;
      (w.cpu === 1 ? m.sub : m.sound).poke(w.addr, w.v);
      next += 1;
    }
  };
  // The port's generator ends with requestJump(m, $E000).
  const gen = MAIN_AT[0xb6f6](m, { a: entry.a });
  let frame = entry.frame;
  let jumpFrame = -1;
  let spins = 0;
  /** Resume the port until its frame ends (or it jumps away). */
  const portFrame = () => {
    for (;;) {
      const s = gen.next();
      if (s.done) {
        assert.equal(takeJump(m), 0xe000, 'JMP reset_main');
        jumpFrame = frame;
        return;
      }
      if (s.value === SPIN) {
        spins += 1;
        replay(frame, fgClock.t);
        if (spins > 100) throw new Error('handshake never seen');
        continue;
      }
      return;
    }
  };
  portFrame();
  replay(frame, Infinity);
  check(b, m, `frame ${frame}`);
  for (let k = 1; k <= frames && jumpFrame < 0; k += 1) {
    for (const [at, fn] of script) if (at === k) fn({ b, m });
    b.runFrame();
    frame += 1;
    m.vblank();
    if (lazyIo) ioPending = true; else m.ioUpdate();
    portFrame();
    if (ioPending) { ioPending = false; m.ioUpdate(); }
    replay(frame, Infinity);
    if (jumpFrame < 0) check(b, m, `frame ${frame} (entry + ${k})`);
  }
  // Every write of the port's main CPU, in the oracle's order and frame;
  // up to the release of the sub and sound CPUs ($B8B5 STA $8400), also
  // at the oracle's exact cycle. After it, two things the port does not
  // model shift the cycles (not the frames) a little: when the sub's
  // $22 becomes visible depends on the oracle's 256-cycle slice phase
  // (one 17-cycle poll either way), and the port's I/O chips update at
  // the start of the frame, the oracle's at cycle 77, so a busy poll of
  // an input can end up to one pass earlier.
  assert.ok(run.mainWrites.length >= portWrites.length);
  let exact = true;
  for (let i = 0; i < portWrites.length && exact !== null; i += 1) {
    const [pf, pt, pa, pv] = portWrites[i];
    const [of, ot, oa, ov] = run.mainWrites[i];
    if (pf !== of || (exact && pt !== ot) || pa !== oa || pv !== ov) {
      assert.fail(`main write #${i}: port $${pa.toString(16)}=${pv} at `
        + `${pf}:${pt}, oracle $${oa.toString(16)}=${ov} at ${of}:${ot}`);
    }
    // Without cycle exactness after the release, the RAM per frame is
    // what is compared from there on.
    if (pa === 0x8400 && !exactAfterRelease) exact = null;
  }
  assert.ok(portWrites.some((w) => w[2] === 0x8400), 'released');
  return { jumpFrame };
}

/**
 * @param {import('../m6809/board.mjs').Board} b @param {Machine} m
 * @param {string} what
 */
function check(b, m, what) {
  assert.deepEqual(diffRam(b, m), [], what);
  assert.deepEqual(m.irqMask, b.machine.irqMask, `${what}: irq masks`);
  assert.equal(m.sreset, b.machine.sreset, `${what}: sreset`);
  assert.deepEqual(m.io.getState(), b.machine.io.getState(),
    `${what}: I/O chips`);
}

/** @typedef {{ b: import('../m6809/board.mjs').Board, m: Machine }} Pair */

/**
 * Press on both sides.
 * @param {string} name @param {boolean} down
 */
const press = (name, down) => (/** @type {Pair} */ x) => {
  x.b.setInput(name, down);
  x.m.setInput(name, down);
};

/**
 * Set the service switch on both sides.
 * @param {number} v DIP port value ($8 off, $0 on)
 */
const service = (v) => (/** @type {Pair} */ x) => {
  x.b.setDip('serviceMode', v);
  x.m.setDip('serviceMode', v);
};

/**
 * The loop part of the script, from frame `s` after the entry: the
 * service coin starts the cross hatch, which stays until the coin is
 * pressed AGAIN (the ROM waits at $BD8A for bit 3 of $6800 to come back
 * after the delay); then sound-test presses (each change of a switch
 * nibble plays a sound, nibbles 0-2 also step the number) and the
 * service switch off.
 * @param {number} s
 * @returns {Array<[number, (x: { b: import('../m6809/board.mjs').Board,
 *   m: Machine }) => void]>}
 */
function loopScript(s) {
  return [
    [s, press('service', true)],
    [s + 8, press('service', false)],
    [s + 60, press('service', true)],
    [s + 64, press('service', false)],
    [s + 140, press('right', true)],
    [s + 144, press('right', false)],
    [s + 148, press('fire1', true)],
    [s + 152, press('fire1', false)],
    [s + 156, press('left', true)],
    [s + 160, press('start1', true)],
    [s + 164, press('left', false)],
    [s + 166, press('start1', false)],
    [s + 168, press('coin1', true)],
    [s + 170, press('coin1', false)],
    [s + 180, service(0x08)],
  ];
}

test('service mode from power-on: every frame to the jump to reset_main',
  () => {
    const run = catchEntry((b) => b.setDip('serviceMode', 0), 400);
    assert.equal(run.entry.frame, 171);
    // The service loop starts 421 frames after the entry (frame 592).
    const { jumpFrame } = lockstep(run, loopScript(430), 700, true, true);
    // The oracle is in reset_main by the end of that frame.
    const pc = run.b.cpus[0].pc;
    assert.ok(pc >= 0xe000 && pc < 0xe200, `oracle at $${pc.toString(16)}`);
    assert.ok(jumpFrame > 0);
  });

test('service mode switched on in attract (IRQ path $C016)', () => {
  const run = catchEntry((b) => {
    b.inputScript = (frame, bb) => {
      if (frame === 300) bb.setDip('serviceMode', 0);
    };
  }, 400);
  assert.ok(run.entry.frame >= 300);
  const { jumpFrame } = lockstep(run, loopScript(430), 700, true, true);
  assert.ok(jumpFrame > 0);
});

/**
 * A fault on both machines: `fn(cpu, addr, v)` may change a written
 * value.
 * @param {(cpu: number, addr: number, v: number) => number} fn
 * @returns {(mm: Machine) => void}
 */
const writeFault = (fn) => (mm) => {
  const w = mm.busWrite.bind(mm);
  mm.busWrite = (cpu, addr, v) => w(cpu, addr, fn(cpu, addr & 0xffff, v));
};

/**
 * A fault on both machines: `fn(addr, v)` may change a main-CPU read.
 * @param {(addr: number, v: number) => number} fn
 * @returns {(mm: Machine) => void}
 */
const readFault = (fn) => (mm) => {
  const r = mm.busRead.bind(mm);
  mm.busRead = (cpu, addr) => {
    const v = r(cpu, addr);
    return cpu === 0 ? fn(addr & 0xffff, v) : v;
  };
};

/** The error paths, each up to the service loop. */
const FAULTS = /** @type {Array<[string, (mm: Machine) => void]>} */ ([
  ['RAM bit stuck at 0 ($1234 b0): "3", no sound RAM test',
    writeFault((c, a, v) => (c === 0 && a === 0x1234 ? v & 0xfe : v))],
  ['sound RAM high byte ($6100 b4): blank at $0326 (quirk)',
    writeFault((c, a, v) => (c === 0 && a === 0x6100 ? v & 0xef : v))],
  ['sound RAM high byte ($6100 b0)',
    writeFault((c, a, v) => (c === 0 && a === 0x6100 ? v & 0xfe : v))],
  ['sound RAM low byte ($6101 b0)',
    writeFault((c, a, v) => (c === 0 && a === 0x6101 ? v & 0xfe : v))],
  ['sound RAM low byte ($6101 b5)',
    writeFault((c, a, v) => (c === 0 && a === 0x6101 ? v & 0xdf : v))],
  ['56XX answers wrong ($6801)',
    readFault((a, v) => (a === 0x6801 ? v ^ 1 : v))],
  ['58XX answers wrong ($6811)',
    readFault((a, v) => (a === 0x6811 ? v ^ 2 : v))],
  ['62XX answers wrong ($6821, $6822, $6823)',
    readFault((a, v) => (a >= 0x6821 && a <= 0x6823 ? v ^ 4 : v))],
  ['sub and sound ROM errors reported',
    writeFault((c, a, v) => ((c === 2 && a === 0x0380) ? 1
      : (c === 1 && a === 0x0801) ? 0x35 : v))],
]);

for (const [name, fault] of FAULTS) {
  test(`service mode error path: ${name}`, () => {
    const run = catchEntry((b) => b.setDip('serviceMode', 0), 400, fault);
    lockstep(run, [], 440, true, true);
  });
}

test('service mode: the easter egg from the sound test', () => {
  const run = catchEntry((b) => b.setDip('serviceMode', 0), 400);
  /** @type {Array<[number, (x: { b: import('../m6809/board.mjs').Board,
   *   m: Machine }) => void]>} */
  const script = [];
  // 8 presses of right: sound 8; up+left together is the 9th change
  // ($6801 = 9) and the sound number shows "09"; then start 1 + fire.
  for (let i = 0; i < 8; i += 1) {
    script.push([430 + 6 * i, press('right', true)]);
    script.push([433 + 6 * i, press('right', false)]);
  }
  script.push([480, (x) => { press('up', true)(x); press('left', true)(x); }]);
  script.push([484, (x) => {
    press('start1', true)(x);
    press('fire1', true)(x);
  }]);
  const { jumpFrame } = lockstep(run, script, 520, true, true);
  assert.equal(jumpFrame, -1);
  const pc = run.b.cpus[0].pc;
  assert.ok(pc >= 0xbe72 && pc < 0xbe78,
    `oracle hangs at $${pc.toString(16)}`);
  assert.equal(run.m.mem[0x0040], 0x20, 'bitmap drawn');
});


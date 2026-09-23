// Copyright 2026 by Moshix
/**
 * Oracle tests for main CPU $E000-$E219 and $FEB0-$FFCF
 * (src/game/main/gp2_2b_boot.js, gp2_2b_tasks.js) and the registration
 * of the whole $E000-$FFFF range (gp2_2b.js).
 *
 * BOOT. The power-on run is compared FRAME BY FRAME with the oracle
 * board: the port's reset_main generator is resumed until it yields (one
 * frame), RAM, latches and I/O chips are compared with the oracle's state
 * at the same vblank, then the port gets its vblank and I/O chip run.
 * delay_65536 (gp2-4) is replaced by a stub that follows the contract of
 * gp2_2b_state.js (65,536 watchdog reads, DELAY_65536_CYCLES on the
 * shared clock). The handshake wait depends on the sub and sound CPUs,
 * so the run is checked in two parts: power-on to the first poll of
 * $6040, and $E0E8 (the oracle stopped there mid-frame) to the jump to
 * game_init, with the other CPUs' RAM copied into the port every frame
 * and only the main CPU's writes compared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORACLE, installStubs, pair, runRom, runPort, same, withStubs, romStub,
  hex4, sameTiming, SYNC,
} from './main-gp2_2b_harness.mjs';
import { makeOracle, loadState, diffRam } from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';
import { MAIN, MAIN_AT, mainAt } from '../../src/game/main/routines.js';
import { mainWord } from '../../src/game/romdata.js';
import {
  SPIN, burn, clockOf, setClock, FRAME_CYCLES,
} from '../../src/game/main/gp2_2b_state.js';
import {
  POWER_ON_CYCLE, HANDSHAKE_DONE_CYCLE, DELAY_65536_CYCLES,
  boot_after_handshake,
} from '../../src/game/main/gp2_2b_boot.js';
import {
  taskTarget, allTaskAddresses, MODE_TASK_LISTS,
} from '../../src/game/main/gp2_2b_tasks.js';
import { requestJump, takeJump } from '../../src/game/main/gp2_3b_state.js';

installStubs();

/**
 * delay_65536 ($BE25) as the shared-clock contract wants it: the 65,536
 * `ldy $7C00` watchdog reads, then the routine's cycles on the clock.
 * @param {Machine} m
 */
function* delayStub(m) {
  for (let i = 0; i < 65536; i += 1) m.peek16(0x7c00);
  yield* burn(m, DELAY_65536_CYCLES);
}

/** Marker a stubbed never-returning target returns. */
const REACHED = Symbol('reached');

/** @typedef {import('../m6809/board.mjs').Board} Board */

/**
 * Latches and chips of a board or machine, for per-frame comparison.
 * @param {Machine} mm
 */
function latches(mm) {
  return {
    irqMask: [...mm.irqMask], sreset: mm.sreset,
    star: [...mm.starCtrl], io: mm.io.getState(),
  };
}

test('boot: power-on to the handshake, frame by frame', () => {
  // The oracle's state at the end of every frame up to the handshake.
  const b = makeOracle();
  /** @type {{ mem: Uint8Array, l: ReturnType<typeof latches> }[]} */
  const frames = [];
  for (let f = 0; f < 96; f += 1) {
    b.runFrame();
    frames.push({ mem: b.mem.slice(), l: latches(b.machine) });
  }
  // Stop the oracle where its main CPU first polls $6040 ($E0D2, frame
  // 96 cycle 17,112, measured).
  b.advanceTo(b.frame * FRAME_CYCLES * 5 + 17112 * 5);
  assert.equal(b.cpus[0].pc, 0xe0d2, 'oracle at the first $6040 poll');

  const m = new Machine();
  setClock(m, POWER_ON_CYCLE);
  withStubs({ delay_65536: delayStub }, () => {
    const gen = MAIN.reset_main(m);
    /** @type {number[]} */
    const syncs = [];
    // The next yield that is not a SYNC (SYNC stamps are collected).
    const next = () => {
      for (;;) {
        const r = gen.next();
        if (r.value !== SYNC) return r;
        syncs.push(m.charged[0]);
      }
    };
    for (let f = 0; f < 96; f += 1) {
      const s = next();
      assert.equal(s.done, false);
      assert.equal(s.value, undefined, `frame ${f}: a frame yield`);
      const want = frames[f];
      assert.deepEqual(diffRam({ mem: want.mem }, m), [], `frame ${f}: RAM`);
      assert.deepEqual(latches(m), want.l, `frame ${f}: latches`);
      m.vblank();
      m.ioUpdate();
    }
    const s = next();
    assert.equal(s.value, SPIN, 'frame 96: spins on the sound CPU');
    assert.equal(clockOf(m).t, 17112, 'clock at the first poll');
    // Cycles charged since $E000 (entered at cycle 4 of frame 0), and
    // the SYNCs before the $6040 and $0800 stores ($E0CC, $E0CF).
    const at = (/** @type {number} */ c) => 96 * FRAME_CYCLES + c - 4;
    assert.equal(m.charged[0], at(17112), 'cycles to $E0D2');
    assert.deepEqual(syncs, [at(17102), at(17107)], 'SYNC stamps');
    assert.deepEqual(diffRam(b, m), [], 'frame 96 at $E0D2: RAM');
    assert.deepEqual(latches(m), latches(b.machine), 'at $E0D2: latches');
    // The port keeps spinning while nothing answers, then passes both
    // polls once the other CPUs have written $22.
    assert.equal(next().value, SPIN);
    m.mem[0x6040] = 0x22;
    assert.equal(next().value, SPIN, 'now waits on the sub CPU');
    m.mem[0x0800] = 0x22;
    // ... and runs on to the next delay (a frame yield).
    const before = clockOf(m).frames;
    assert.equal(next().value, undefined);
    assert.equal(clockOf(m).frames, before + 1);
    gen.return(undefined);
  });
});

test('boot: $E0E8 to game_init, frame by frame', () => {
  const b = makeOracle();
  b.runFrames(109);
  b.advanceTo(b.frame * FRAME_CYCLES * 5 + HANDSHAKE_DONE_CYCLE * 5);
  assert.equal(b.cpus[0].pc, 0xe0e8, 'oracle leaves the handshake here');
  // The main CPU's writes on the oracle, per frame.
  /** @type {Set<number>} */
  let oracleWrites = new Set();
  b.onWrite = (n, addr) => { if (n === 0) oracleWrites.add(addr); };

  const m = new Machine();
  loadState(m, b, { latches: true });
  setClock(m, HANDSHAKE_DONE_CYCLE);
  const charged0 = m.charged[0];
  /** @type {Set<number>} */
  let portWrites = new Set();
  const busWrite = m.busWrite.bind(m);
  m.busWrite = (cpu, addr, v) => {
    if (cpu === 0) portWrites.add(addr & 0xffff);
    busWrite(cpu, addr, v);
  };
  let reached = -1;
  let frames = 0;
  const gameInit = () => { reached = frames; return REACHED; };
  const service = () => { throw new Error('service mode reached'); };
  withStubs({
    delay_65536: delayStub, game_init: gameInit, service_mode: service,
  }, () => {
    const gen = boot_after_handshake(m);
    for (;;) {
      const s = gen.next();
      if (s.value === SYNC) continue;
      if (s.done) {
        assert.equal(s.value, REACHED);
        break;
      }
      assert.equal(s.value, undefined);
      frames += 1;
      b.runFrame();
      // Every byte either CPU's main code wrote this frame must agree.
      const addrs = [...new Set([...oracleWrites, ...portWrites])]
        .filter((a) => (a < 0x2000 || (a >= 0x6000 && a < 0x6400))
          && !(a >= 0x15e2 && a < 0x1600)); // the main stack
      for (const a of addrs) {
        assert.equal(m.mem[a], b.mem[a],
          `frame ${b.frame - 1}: $${hex4(a)} written by main`);
      }
      assert.deepEqual(latches(m).irqMask[0], b.machine.irqMask[0]);
      assert.deepEqual(m.io.getState(), b.machine.io.getState(),
        `frame ${b.frame - 1}: I/O chips`);
      oracleWrites = new Set();
      portWrites = new Set();
      // The sub and sound CPUs' work (and the vblank): take the oracle's.
      loadState(m, b);
      m.vblank();
      m.ioUpdate();
    }
  });
  b.onWrite = null;
  // game_init is entered in frame 233 at cycle 23,323 (measured).
  assert.equal(109 + reached, 233, 'frame of jmp game_init');
  assert.equal(clockOf(m).t, 23319 + 4, 'cycle of $C296');
  // Every cycle from $E0E8 to $C296 charged, delays included.
  assert.equal(m.charged[0] - charged0,
    124 * FRAME_CYCLES + 23323 - HANDSHAKE_DONE_CYCLE, 'cycles charged');
  // What was written after the last frame boundary, too.
  assert.equal(m.peek16(0x1025), b.mem[0x1025] << 8 | b.mem[0x1026]);
});

/**
 * Run the port and the ROM from $E0E8 on the same state with a given DIP
 * setting, until service_mode or game_init; compare the decoded DIPs.
 * The ROM is stepped alone (callRoutine-style, frame clock frozen), so
 * the I/O chips are run by hand at each of its delays: both sides get an
 * I/O update where the port yields.
 * @param {(mm: Machine) => void} dips
 * @param {number} seed
 */
function dipCase(dips, seed) {
  const { board, m } = pair(seed, (poke) => {
    poke(0x0800, 0x22);
    poke(0x6040, 0x22);
  });
  dips(m);
  // The shared oracle keeps its inputs from earlier tests: copy them all.
  Object.assign(board.machine.inputs.dips, m.inputs.dips);
  board.machine.inputs.in2 = m.inputs.in2;
  let where = '';
  const gameInit = () => { where = 'game_init'; return REACHED; };
  const service = () => { where = 'service_mode'; return REACHED; };
  // ROM: the same delays, but the chips run once per delay on both sides
  // (the chip mode written before a delay is what the next read sees).
  const res = runRom(board, 0xe0e8, {}, {
    stopAt: [0xb6f6, 0xc296],
    stopWhen: (bb) => {
      if (bb.cpus[0].pc === 0xbe25) {
        bb.machine.io.vblank();
        bb.machine.io.update();
      }
      return false;
    },
  });
  withStubs({
    delay_65536: function* delay(mm) {
      mm.io.vblank();
      mm.io.update();
      yield* burn(mm, DELAY_65536_CYCLES);
    },
    game_init: gameInit, service_mode: service,
  }, () => {
    runPort(boot_after_handshake, m, {}, { maxYields: 1000 });
  });
  assert.equal(where, res.pc === 0xb6f6 ? 'service_mode' : 'game_init');
  same(board, m, `DIPs seed ${seed}`);
  return where;
}

test('boot: DIP decoding and the service switch, every setting', () => {
  const seen = new Set();
  let seed = 100;
  for (let coinA = 0; coinA < 4; coinA += 1) {
    for (let lives = 0; lives < 4; lives += 1) {
      dipCase((mm) => {
        mm.setDip('coinA', coinA);
        mm.setDip('lives', lives << 2);
        mm.setDip('coinB', 3 - coinA);
      }, seed += 1);
    }
  }
  for (let v = 0; v < 8; v += 1) {
    dipCase((mm) => {
      mm.setDip('bonus', v);
      mm.setDip('difficulty', 7 - v);
    }, seed += 1);
  }
  for (const svc of [0, 8]) {
    for (const cab of [0x00, 0x0f]) {
      seen.add(dipCase((mm) => {
        mm.setDip('serviceMode', svc);
        mm.inputs.in2 = cab;
      }, seed += 1));
    }
  }
  assert.deepEqual([...seen].sort(), ['game_init', 'service_mode']);
});

/**
 * A chip-check failure: the I/O read of `addr` is corrupted on both
 * sides; the ROM hangs at $E0C5, the port spins there, RAM identical.
 * @param {number} addr @param {number} bad
 */
function chipFail(addr, bad) {
  const b = makeOracle();
  const m = new Machine();
  for (const mm of [b.machine, m]) {
    const read = mm.io.read.bind(mm.io);
    mm.io.read = (a) => ((a & 0xffff) === addr ? bad : read(a));
  }
  // ROM alone from power-on, chips run at each delay as above.
  const res = runRom(b, 0xe000, {}, {
    stopAt: [0xe0c5, 0xe0c7],
    stopWhen: (bb) => {
      if (bb.cpus[0].pc === 0xbe25) {
        bb.machine.io.vblank();
        bb.machine.io.update();
      }
      return false;
    },
    maxCycles: 10_000_000,
  });
  let yields = 0;
  withStubs({
    delay_65536: function* delay(mm) {
      mm.io.vblank();
      mm.io.update();
      yield* burn(mm, DELAY_65536_CYCLES);
    },
  }, () => {
    const gen = MAIN.reset_main(m);
    // 3 delays = 93 frames; then it must spin one yield per frame.
    for (; yields < 200; yields += 1) gen.next();
  });
  assert.equal(res.pc, 0xe0c5, `chip error for $${hex4(addr)}`);
  assert.deepEqual(diffRam(b, m), [], `chip error $${hex4(addr)}: RAM`);
  return res.d;
}

test('boot: the three chip-check failures hang at $E0C5', () => {
  assert.equal(chipFail(0x6801, 0xf8), 0x2031);
  assert.equal(chipFail(0x6810, 0xfe), 0x2032);
  assert.equal(chipFail(0x6821, 0xf0), 0x2033);
  assert.equal(chipFail(0x6822, 0xff), 0x2033);
  assert.equal(chipFail(0x6823, 0xf0), 0x2033);
});

test('program_coinage, sub_E20A, fill_16_words vs ROM', () => {
  for (let seed = 1; seed <= 4; seed += 1) {
    const { board, m } = pair(seed);
    const r = runRom(board, 0xe1de, {}, {
      stopWhen: (bb) => {
        if (bb.cpus[0].pc === 0xbe25) {
          bb.machine.io.vblank();
          bb.machine.io.update();
        }
        return false;
      },
    });
    const port = withStubs({
      delay_65536: function* delay(mm) {
        mm.io.vblank();
        mm.io.update();
        yield* burn(mm, DELAY_65536_CYCLES);
      },
    }, () => runPort(MAIN.program_coinage, m));
    same(board, m, `program_coinage ${seed}`);
    sameTiming(r, port, `program_coinage ${seed}`);
    assert.equal(/** @type {{ u: number }} */ (port.out).u, r.u);
  }
  for (let seed = 5; seed <= 8; seed += 1) {
    const u = 0x0400 + (seed * 0x47);
    const { board, m } = pair(seed);
    const r = runRom(board, 0xe20a, { u });
    const p = runPort(MAIN.sub_E20A, m, { u });
    same(board, m, `sub_E20A ${seed}`);
    sameTiming(r, p, `sub_E20A ${seed}`);
    assert.equal(/** @type {{ u: number }} */ (p.out).u, r.u);
    const x = (seed * 0x1357) & 0xffff;
    const r2 = runRom(board, 0xe212, { x, u });
    const p2 = runPort(MAIN.fill_16_words, m, { x, u });
    same(board, m, `fill_16_words ${seed}`);
    sameTiming(r2, p2, `fill_16_words ${seed}`);
    const o = /** @type {{ u: number, a: number, x: number }} */ (p2.out);
    assert.deepEqual([o.u, o.a, o.x], [r2.u, r2.a, r2.x]);
  }
});

test('timing: a wrong cycle count or a missing SYNC is caught', () => {
  const { board, m } = pair(11);
  const r = runRom(board, 0xe212, { x: 0x2020, u: 0x0200 });
  const p = runPort(MAIN.fill_16_words, m, { x: 0x2020, u: 0x0200 });
  sameTiming(r, p, 'fill_16_words');
  const bad = { ...p, cycles: p.cycles + 1 };
  assert.throws(() => sameTiming(r, bad, 'bad'), /cycles/);
  const shifted = {
    ...p,
    trace: { ...p.trace, writes: p.trace.writes.map(([t, a, v], i) =>
      [i === 3 ? t + 1 : t, a, v]) },
  };
  assert.throws(() => sameTiming(r, shifted, 'bad'), /timed writes/);
  const unsynced = { ...p, trace: { ...p.trace, racy: [[5, 0x102f]] } };
  assert.throws(() => sameTiming(r, unsynced, 'bad'), /without SYNC/);
});

// ------------------------------------------------------------- tasks

test('task_dispatch: the jump target for every mode and task', () => {
  const { m } = pair(1);
  for (let mode = 0; mode < 0x100; mode += 1) {
    for (const task of [0, 1, 5, 0x21, 0x3f, 0x40, 0x7f, 0x80, 0xff]) {
      m.mem[0x102f] = mode;
      m.mem[0x1030] = task;
      // $FEB5: ldu #$FEC0 / ldd <$2F / asla / ldu a,u / aslb / jmp [b,u]
      const b = ORACLE;
      b.mem.set(m.mem.subarray(0x1000, 0x1100), 0x1000);
      const c = b.cpus[0];
      c.setState({ pc: 0xfeb5, dp: 0x10, s: 0x1600, cc: 0x50, wait: 0 });
      for (let i = 0; i < 6; i += 1) c.step();
      assert.equal(taskTarget(m), c.pc, `mode ${mode} task ${task}`);
    }
  }
});

test('task_dispatch: runs the list in order and yields at the end', () => {
  const { m } = pair(3, (poke) => {
    poke(0x102f, 6);
    poke(0x1030, 0);
  });
  /** @type {number[]} */
  const ran = [];
  const list = mainWord(MODE_TASK_LISTS + 12);
  // Stand-ins for mode 6's eight tasks: record, INC <$30, return; the
  // last (task_end_frame, $D150) yields once and clears <$30 as it does.
  const saved = new Map();
  for (let i = 0; i < 8; i += 1) {
    const addr = mainWord(list + 2 * i);
    saved.set(addr, MAIN_AT[addr]);
    MAIN_AT[addr] = i === 7
      ? function* endFrame(mm) {
        ran.push(addr);
        yield;
        mm.poke(0x1030, 0);
      }
      : (mm) => {
        ran.push(addr);
        mm.poke(0x1030, mm.peek(0x1030) + 1);
      };
  }
  try {
    const gen = MAIN.task_dispatch(m);
    // The next non-SYNC yield.
    const next = () => {
      for (;;) {
        const r = gen.next();
        if (r.value !== SYNC) return r;
      }
    };
    assert.equal(next().done, false);
    assert.equal(ran.length, 8);
    next();
    assert.equal(ran.length, 16, 'restarts the list after the CWAI');
    assert.deepEqual(ran.slice(0, 8), ran.slice(8));
    // A task requesting a non-local jump ends the dispatcher at once.
    requestJump(m, 0xc417);
    const s = next();
    assert.equal(s.done, true);
    assert.equal(takeJump(m), 0xc417);
  } finally {
    for (const [a, f] of saved) MAIN_AT[a] = f;
  }
});

test('task_dispatch_sync: $33 to the sub CPU, then dispatch', () => {
  const { board, m } = pair(4, (poke) => {
    poke(0x102f, 9);
    poke(0x1030, 0);
  });
  runRom(board, 0xfeb0, {}, { stopAt: [0xafbe] });
  const saved = MAIN_AT[0xafbe];
  MAIN_AT[0xafbe] = (mm) => { requestJump(mm, 0x1234); };
  try {
    const r = runPort(MAIN.task_dispatch_sync, m);
    assert.equal(r.yields, 0);
    assert.equal(takeJump(m), 0x1234);
  } finally {
    MAIN_AT[0xafbe] = saved;
  }
  same(board, m, 'task_dispatch_sync');
});

test('task_dispatch / _sync: 25 cycles, SYNC before $102F and the task',
  () => {
    for (let seed = 20; seed < 60; seed += 1) {
      const mode = seed % 10;
      const { board, m } = pair(seed, (poke) => {
        poke(0x102f, mode);
        poke(0x1030, seed % 3);
      });
      const target = taskTarget(m);
      const sync = seed % 2 === 0;
      const r = runRom(board, sync ? 0xfeb0 : 0xfeb5, {}, { stopAt: [target] });
      const saved = MAIN_AT[target];
      MAIN_AT[target] = (mm) => { requestJump(mm, 0x1234); };
      try {
        const p = runPort(sync ? MAIN.task_dispatch_sync
          : MAIN.task_dispatch, m);
        sameTiming(r, p, `dispatch seed ${seed}`);
        assert.deepEqual(p.syncs, sync ? [2, 10, 32] : [3, 25]);
        assert.equal(takeJump(m), 0x1234);
      } finally {
        MAIN_AT[target] = saved;
      }
      same(board, m, `dispatch seed ${seed}`);
    }
  });

// ------------------------------------------------------ registration

test('registration: every $E000-$FFFF task and vector is in MAIN_AT', () => {
  const tasks = allTaskAddresses();
  assert.equal(tasks.length, 29, 'distinct tasks in the ten lists');
  for (const a of tasks.filter((t) => t >= 0xe000)) {
    assert.equal(typeof MAIN_AT[a], 'function', `task $${hex4(a)}`);
  }
  assert.equal(mainAt(mainWord(0xfffe)), MAIN.reset_main);
  for (const a of [0xe000, 0xe0c5, 0xe0c7, 0xe1ca, 0xe1de, 0xe20a,
    0xe212, 0xfeb0, 0xfeb5]) {
    assert.equal(typeof MAIN_AT[a], 'function', `$${hex4(a)}`);
  }
});

test('stubs: a ROM-backed stub is exact', () => {
  const { board, m } = pair(9);
  const r = runRom(board, 0xc287, { a: 0x4b });
  const s = romStub(0xc287)(m, { a: 0x4b });
  assert.equal(s.a, r.a);
  same(board, m, 'stub');
});

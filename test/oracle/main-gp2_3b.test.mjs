// Copyright 2026 by Moshix
/**
 * Oracle tests for main CPU ROM gp2-3b.8c: the IRQ handler and its
 * helpers (gp2_3b_irq.js) and scoring (gp2_3b_score.js).
 *
 * Every routine runs twice from identical, seeded-random RAM and I/O
 * chip state: the real ROM on the oracle's main CPU (romRun) and the
 * port on a Machine. RAM (stacks excluded), the IRQ mask, the starfield
 * latches and the I/O chips must match, and so must the order of the
 * writes, the cycles charged, the yields (RENDEZVOUS at the frame_sync
 * poll, BUSY in round_select / coin_jammed) and the exit taken.
 * operator_stats ($FCDF, gp2-2b) is replaced by a ROM-backed stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../src/game/main/gp2_3b.js';
import { MAIN, MAIN_AT, mainAt } from '../../src/game/main/routines.js';
import { takeJump } from '../../src/game/main/gp2_3b_state.js';
import {
  makePair, romRun, portRun, romStub, writeLog, same, ri, romWrites,
  portWrites, ORACLE,
} from './main-gp2_3b.util.mjs';
import {
  makeOracle, loadState, randomPlayer,
} from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';

MAIN.operator_stats = romStub(0xfcdf);
MAIN_AT[0xfcdf] = MAIN.operator_stats;

/**
 * Random I/O chip nibbles for the IRQ handler: 56XX credits / credits
 * added / stick / buttons, 58XX DIP nibbles.
 * @param {import('../../src/machine/machine.js').Machine} m
 * @param {() => number} rnd
 * @param {object} o forced values
 */
function randomIo(m, rnd, o = {}) {
  const n56 = m.io.n56.ram;
  const n58 = m.io.n58.ram;
  for (let i = 0; i < 16; i += 1) {
    n56[i] = ri(rnd, 16);
    n58[i] = ri(rnd, 16);
  }
  // Credits: mostly plausible BCD, sometimes jammed values.
  n56[0] = o.tens ?? (rnd() < 0.1 ? 10 + ri(rnd, 6) : ri(rnd, 10));
  n56[1] = o.units ?? ri(rnd, 16);
  n56[2] = o.added ?? (rnd() < 0.5 ? 0 : ri(rnd, 16));
  n58[4] = o.service ? 0x08 | ri(rnd, 8) : ri(rnd, 8); // bit 3 service
  n58[3] = o.round ? 0x08 | ri(rnd, 8) : ri(rnd, 8); // bit 3 rnd adv
}

/** Oracle events -> the port's names. @param {{kind: string}} e */
const kindOf = (e) => (e.kind === 'mark' ? 'busy' : e.kind);

/**
 * Run irq_main on both sides from the same state and compare.
 * @param {number} seed
 * @param {object} io randomIo forced values
 * @param {(i: number, side: object, io: object) => void} [tick] per event
 * @param {number} [maxEvents]
 * @param {(m: object) => void} [setup] final RAM adjustments
 */
function irqCase(seed, io = {}, tick, maxEvents, setup) {
  const { board, m } = makePair(seed, (mm, rnd) => {
    randomIo(mm, rnd, io);
    if (rnd() < 0.5) mm.poke(0x09f4, rnd() < 0.5 ? 0 : 1);
    if (rnd() < 0.3) mm.poke(0x1016, 0xff);
    if (rnd() < 0.3) mm.poke(0x1015, 0xff);
    if (rnd() < 0.5) mm.poke(0x102c, 0);
    if (rnd() < 0.3) mm.poke(0x10af, 0x11);
    setup?.(mm);
  });
  const sync = (side) => { side.mem[0x10af] = 0x11; };
  const ev = (i, side, chips) => {
    tick?.(i, side, chips);
  };
  let n = 0;
  const rom = romRun(board, 0xc000, {
    frame: 'rti',
    stops: [0xb6f6, 0xc417],
    marks: [0xc163, 0xc1a2, 0xc1b9],
    polls: [0xc158, 0xc067].map((pc) => ({
      pc, end: pc + 6, cost: 9, kind: 'rendezvous',
      busy: (b) => b.peek(0x10af) !== 0x11,
    })),
    maxEvents,
    log: true,
    onEvent: (e, b) => {
      if (e.kind === 'rendezvous') sync(b);
      ev(n, b, b.machine.io);
      n += 1;
    },
  });
  const log = writeLog(m);
  let k = 0;
  const port = portRun(mainAt(0xc000)(m), m, {
    maxEvents,
    syncs: false,
    onEvent: (e, mm) => {
      if (e.kind === 'rendezvous') sync(mm);
      ev(k, mm, mm.io);
      k += 1;
    },
  });
  const what = `irq_main seed ${seed}`;
  assert.deepEqual(port.events.map((e) => e.kind),
    rom.events.map(kindOf), `${what}: yields`);
  assert.deepEqual(port.events.map((e) => e.cycles),
    rom.events.map((e) => e.cycles), `${what}: cycles at the yields`);
  assert.deepEqual(portWrites(log), romWrites(rom.writes),
    `${what}: writes`);
  same(board, m, what);
  const jump = takeJump(m);
  if (port.done) {
    assert.equal(jump ?? 0x4000, rom.pc, `${what}: exit`);
    assert.equal(m.charged[0], rom.cycles, `${what}: cycles`);
  }
  return { rom, port };
}

test('irq_main: normal frames (sprite copy, timers, flip, coins)', () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    irqCase(seed, { tens: seed % 10, service: false, round: false });
  }
});

test('irq_main: service switch -> service_mode', () => {
  for (let seed = 400; seed < 420; seed += 1) {
    const { rom } = irqCase(seed, { service: true });
    assert.equal(rom.pc, 0xb6f6);
  }
});

test('irq_main: coin during the demo -> attract_loop', () => {
  let seen = 0;
  for (let seed = 500; seed < 600; seed += 1) {
    const { rom } = irqCase(seed, { tens: 0, added: 1 + (seed % 15),
      round: false }, undefined, undefined, (mm) => {
      mm.poke(0x09f4, 1);
      mm.io.n58.ram[4] &= 7;
    });
    if (rom.pc === 0xc417) seen += 1;
  }
  assert.ok(seen > 10, 'the coin path ran');
});

test('irq_main: coin jammed hangs, kicking the watchdog', () => {
  for (let seed = 700; seed < 720; seed += 1) {
    const { rom, port } = irqCase(seed, { tens: 10 + (seed % 6),
      units: 15, service: false }, undefined, 5);
    assert.equal(port.done, false);
    assert.equal(rom.events.length, 5);
  }
});

test('irq_main: Round Advance loop until the DIP is off', () => {
  for (let seed = 800; seed < 860; seed += 1) {
    // Pass i: stick up on even passes of some seeds, DIP off at pass 7.
    irqCase(seed, { tens: 0, service: false, round: true }, (i, side, io) => {
      const n56 = io.n56.ram;
      n56[4] = (i + seed) % 3 === 0 ? n56[4] | 1 : n56[4] & ~1;
      if (i >= 7) io.n58.ram[3] &= ~0x08;
    });
  }
});

/**
 * Run a plain helper on both sides and compare RAM, writes and cycles.
 * @param {number} addr @param {number} seed
 * @param {(m: object, rnd: () => number) => void} [setup]
 * @param {object} [regs]
 * @param {boolean} [stamps] compare write cycle stamps too
 */
function plainCase(addr, seed, setup, regs = {}, stamps = false) {
  const { board, m } = makePair(seed, setup);
  const rom = romRun(board, addr, { regs, log: true });
  const log = writeLog(m);
  const port = portRun(mainAt(addr)(m, regs), m);
  const what = `$${addr.toString(16)} seed ${seed}`;
  assert.ok(port.done, `${what}: returned`);
  assert.deepEqual(portWrites(log, stamps),
    romWrites(rom.writes, { timed: stamps }), `${what}: writes`);
  same(board, m, what);
  assert.equal(m.charged[0], rom.cycles, `${what}: cycles`);
  return { rom, port };
}

test('irq_timers / update_play_clock / update_p1_time', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    plainCase(0xd07a, seed, (m, rnd) => {
      if (rnd() < 0.5) m.poke(0x09f4, rnd() < 0.5 ? 0 : 1);
      if (rnd() < 0.3) m.poke(0x03e6, 0x20);
      if (rnd() < 0.5) m.poke(0x102d, 0);
      if (rnd() < 0.5) m.poke(0x102e, 0);
      // Clock digits near their wrap points.
      if (rnd() < 0.6) m.poke(0x09f8, 0x59);
      if (rnd() < 0.6) m.poke(0x09f9, 0x59);
      if (rnd() < 0.6) m.poke(0x09fa, 0x59);
      if (rnd() < 0.6) m.poke(0x09fb, 0x23);
      if (rnd() < 0.6) m.poke(0x09fc, 0x3b);
      if (rnd() < 0.6) m.poke(0x09fd, 0x3b);
    });
  }
});

test('sound_all_off / sound_demo_gate', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    plainCase(0xdf19, seed, undefined, {}, true);
    plainCase(0xdf27, seed, (m, rnd) => {
      m.io.n58.ram[7] = ri(rnd, 16);
    }, {}, true);
  }
});

test('clear_sprite_shadows(_all): writes timed for busy callers', () => {
  for (let seed = 1; seed <= 5; seed += 1) {
    plainCase(0xdf5d, seed, undefined, {}, true);
    plainCase(0xdf65, seed, undefined, {}, true);
  }
});

test('add_score / update_hiscore / bcd digits', () => {
  for (let seed = 1; seed <= 400; seed += 1) {
    const r = seed % 4;
    const a = [0x01, 0x50, 0x99, (seed * 37) & 0xff][r];
    const { rom } = plainCase(0xc1d6, seed, (m, rnd) => {
      if (rnd() < 0.8) m.poke(0x115f, 0);
      m.poke(0x102d, rnd() < 0.5 ? 0 : (rnd() < 0.8 ? 1 : ri(rnd, 256)));
      // Scores and high score: BCD, often equal in the top bytes.
      const bcd = () => ri(rnd, 10) * 16 + ri(rnd, 10);
      for (let i = 0; i < 6; i += 1) m.poke(0x09b0 + i, bcd());
      const hs = [bcd(), bcd(), bcd()];
      if (rnd() < 0.5) {
        const base = m.peek(0x102d) ? 0x09b3 : 0x09b0;
        hs[0] = m.peek(base + 2);
        if (rnd() < 0.6) hs[1] = m.peek(base + 1);
        if (rnd() < 0.4) hs[2] = m.peek(base);
      }
      hs.forEach((v, i) => m.poke(0x09b6 + i, v));
      // Small scores exercise the leading-zero skips.
      if (rnd() < 0.4) m.poke(0x09b2, 0);
      if (rnd() < 0.3) m.poke(0x09b1, 0);
      if (rnd() < 0.4) m.poke(0x09b5, 0);
      if (rnd() < 0.3) m.poke(0x09b4, 0);
    }, { a });
    void rom;
  }
  for (let a = 0; a < 256; a += 1) {
    for (const addr of [0xc287, 0xc28b]) {
      const { board, m } = makePair(a);
      const rom = romRun(board, addr, { regs: { a } });
      const out = mainAt(addr)(m, { a });
      assert.equal(out.a, rom.regs.a, `$${addr.toString(16)} A=${a}`);
      assert.equal(m.charged[0], rom.cycles);
    }
  }
});

test('irq_main on real states: attract, coin, a game', () => {
  // A second board plays; every 7th frame its state (at the vblank, before
  // the IRQ) is handed to both the port and the comparison board.
  const src = makeOracle();
  src.tap('coin1', 700);
  src.tap('start1', 760);
  src.inputScript = randomPlayer(7, { from: 800 });
  let checked = 0;
  for (let f = 0; f < 2400; f += 1) {
    src.runFrame();
    if (f < 245 || f % 7 !== 0) continue;
    const m = new Machine();
    loadState(m, src, { latches: true });
    const board = ORACLE;
    loadState(board, m, { latches: true });
    board.cpus[0].irqLine = false;
    const sync = (side) => { side.mem[0x10af] = 0x11; };
    const rom = romRun(board, 0xc000, {
      frame: 'rti', stops: [0xb6f6, 0xc417],
      polls: [0xc158, 0xc067].map((pc) => ({
        pc, end: pc + 6, cost: 9, kind: 'rendezvous',
        busy: (b) => b.peek(0x10af) !== 0x11,
      })),
      onEvent: (e, b) => sync(b),
    });
    const port = portRun(mainAt(0xc000)(m), m, {
      syncs: false,
      onEvent: (e, mm) => sync(mm),
    });
    assert.deepEqual(port.events.map((e) => e.cycles),
      rom.events.map((e) => e.cycles), `frame ${f}: yields`);
    same(board, m, `frame ${f}`);
    assert.equal(m.charged[0], rom.cycles, `frame ${f}: cycles`);
    assert.equal(takeJump(m) ?? 0x4000, rom.pc, `frame ${f}: exit`);
    checked += 1;
  }
  assert.ok(checked > 250);
});

// Copyright 2026 by Moshix
/**
 * Oracle tests for main CPU $D28A-$D8AF (src/game/main/gp2_3b_hit.js):
 * shots vs the formation and objects (sub_D28A, sub_D431), formation
 * bookkeeping (sub_D588), task_stage_clear and task_stage_start.
 *
 * Each routine runs from identical seeded-random RAM on the oracle
 * (romRun: until `jmp task_dispatch`, CWAIs and the $D434 race read
 * reported as events) and on the port. RAM, latches, the order of the
 * writes, the cycles at every yield and in total, and the exit must
 * match. load_stage_params ($F4A5, gp2-2b) is a ROM-backed stub.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../src/game/main/gp2_3b.js';
import { MAIN, MAIN_AT, mainAt } from '../../src/game/main/routines.js';
import {
  makePair, romRun, portRun, romStub, writeLog, same, ri, romWrites,
  portWrites,
} from './main-gp2_3b.util.mjs';

MAIN.load_stage_params = romStub(0xf4a5);

/*
 * add_score (gp2_3b_score.js) is a plain routine that charges its cycles
 * in groups, so its writes carry no exact stamps: they are compared
 * untimed. The wrapper records which port writes it made.
 */
const addScore = MAIN.add_score;
/** @type {{ log: unknown[], spans: number[][] }} */
const AS = { log: [], spans: [] };
MAIN.add_score = (m, regs) => {
  const from = AS.log.length;
  const r = addScore(m, regs);
  AS.spans.push([from, AS.log.length]);
  return r;
};

/**
 * Split writes into (outside add_score, timed) and (add_score, untimed).
 * @param {number[][]} w @param {(i: number, e: number[]) => boolean} inAs
 */
function splitAs(w, inAs) {
  return [w.filter((e, i) => !inAs(i, e)),
    w.filter((e, i) => inAs(i, e)).map(([, a, v]) => [a, v])];
}
MAIN_AT[0xf4a5] = MAIN.load_stage_params;

/** Oracle event kinds -> the port's. @param {{kind: string}} e */
const kindOf = (e) => (e.kind === 'mark' ? 'busy' : e.kind);

/**
 * Run a task (or routine) on both sides and compare everything.
 * @param {number} addr @param {number} seed
 * @param {(m: object, rnd: () => number) => void} setup
 * @param {object} [regs]
 * @returns {object} the oracle run
 */
function taskCase(addr, seed, setup, regs = {}) {
  // makePair's generator starts nearly the same for close seeds: skip
  // its first outputs so the scenarios really vary with the seed.
  const { board, m } = makePair(seed, (mm, rnd) => {
    for (let i = 0; i < 4; i += 1) rnd();
    setup(mm, rnd);
  });
  const rom = romRun(board, addr, {
    regs, stops: [0xfeb5], marks: [0xd434], log: true,
    maxCycles: 2_000_000,
  });
  const log = writeLog(m);
  AS.log = log;
  AS.spans = [];
  const port = portRun(mainAt(addr)(m, regs), m);
  const what = `$${addr.toString(16)} seed ${seed}`;
  assert.ok(port.done, `${what}: returned`);
  // CWAIs: same count, same cycles. SYNC points ('busy') are checked
  // through the timed writes, and the $D434 race read by its stamp.
  const cw = (/** @type {{kind: string}[]} */ ev) =>
    ev.filter((e) => e.kind === 'cwai');
  assert.deepEqual(cw(port.events).map((e) => e.cycles),
    cw(rom.events).map((e) => e.cycles), `${what}: CWAIs`);
  const syncs = new Set(port.events.filter((e) => e.kind === 'busy')
    .map((e) => e.cycles));
  for (const e of rom.events.filter((ev) => ev.kind === 'mark')) {
    assert.ok(syncs.has(e.cycles), `${what}: SYNC at $D434 (${e.cycles})`);
  }
  const inSpan = (/** @type {number} */ i) =>
    AS.spans.some(([lo, hi]) => i >= lo && i < hi);
  const pw = splitAs(portWrites(log, true), (i) => inSpan(i));
  const rw = romWrites(rom.writes.filter(([, , , pc]) => pc < 0xc1d6
    || pc > 0xc295), { timed: true });
  const rs = romWrites(rom.writes.filter(([, , , pc]) => pc >= 0xc1d6
    && pc <= 0xc295));
  assert.deepEqual(pw[0], rw, `${what}: timed writes`);
  assert.deepEqual(pw[1], rs, `${what}: add_score writes`);
  same(board, m, what);
  assert.equal(m.charged[0], rom.cycles, `${what}: cycles`);
  return rom;
}

/**
 * A shot/formation scene: shots at $1EA3-$1EA7 with positions, hit-box
 * parameters, formation slots and targets near the shots, objects.
 * @param {object} m @param {() => number} rnd
 */
function scene(m, rnd) {
  const pick = (/** @type {number[]} */ a) => a[ri(rnd, a.length)];
  if (rnd() < 0.5) m.poke(0x1131, rnd() < 0.5 ? 0 : 1 + ri(rnd, 3));
  if (rnd() < 0.3) m.poke(0x1016, rnd() < 0.5 ? 0 : 0x80);
  m.poke(0x1100, 6);
  m.poke(0x1101, 0x0c);
  m.poke(0x10dd, rnd() < 0.7 ? pick([0, 0x10, 0x20]) : ri(rnd, 256));
  m.poke(0x10de, rnd() < 0.7 ? pick([0, 0x10, 0x30]) : ri(rnd, 256));
  m.poke(0x115f, rnd() < 0.7 ? 0 : 1);
  m.poke(0x1066, rnd() < 0.8 ? ri(rnd, 14) : ri(rnd, 256));
  m.poke(0x1112, rnd() < 0.8 ? pick([1, 2, 4, 8, 0x10, 0x20, 0x40])
    : ri(rnd, 256));
  m.poke16(0x112d, rnd() < 0.8 ? 0x188d : 0x1861 + ri(rnd, 0x2c));
  const shots = [];
  for (let i = 0; i < 3; i += 1) {
    const on = rnd() < 0.6;
    const bit = rnd() < 0.7 ? 0 : 1;
    m.poke(0x1ea3 + 2 * i, (on ? 0x80 : 0) | (ri(rnd, 0x40) << 1) | bit);
    const y = rnd() < 0.9 ? 0x20 + ri(rnd, 0x90) : ri(rnd, 256);
    const x = rnd() < 0.9 ? 0x20 + ri(rnd, 0xb0) : ri(rnd, 256);
    m.poke(0x16a2 + 2 * i, y);
    m.poke(0x16a3 + 2 * i, x);
    shots.push([y, x, bit]);
  }
  const near = () => {
    const [y, x, bit] = pick(shots);
    return [(y + 0x10 + ri(rnd, 0x08)) & 0xff, (x - 4 + ri(rnd, 8)) & 0xff,
      bit];
  };
  for (let n = 0; n < 0x2d; n += 1) {
    m.poke(0x1860 + n, rnd() < 0.8
      ? pick([0x00, 0x02, 0xc2, 0x01, 0x03, 0x00, 0x02]) : ri(rnd, 256));
    if (rnd() < 0.3) {
      const [y, x, bit] = near();
      m.poke(0x1b00 + 2 * n, y);
      m.poke(0x1b01 + 2 * n, x);
      m.poke(0x1630 + 2 * n, y);
      m.poke(0x1631 + 2 * n, x);
      m.poke(0x1e31 + 2 * n, (rnd() < 0.8 ? 0x80 : 0) | bit);
    }
  }
  for (let o = 0x0ee2; o < 0x0f14; o += 2) {
    if (rnd() < 0.15) {
      const [y, x, bit] = near();
      m.poke(o + 0x0800, y);
      m.poke(o + 0x0801, x);
      m.poke(o + 0x1001, (rnd() < 0.8 ? 0x80 : 0) | bit);
      if (rnd() < 0.5) m.poke(o, pick([0x3c, 0x3d, 0x40]));
    } else if (rnd() < 0.7) {
      m.poke(o + 0x1001, m.peek(o + 0x1001) & 0x7f);
    }
  }
  m.poke(0x106e, ri(rnd, 256));
  // sub_D431's score sprite slots $0ECE-$0EDA
  for (let o = 0x0ece; o < 0x0edc; o += 2) {
    m.poke(o + 0x1001, rnd() < 0.5 ? 0x80 : 0);
  }
  if (rnd() < 0.5) m.poke(0x1075, 0xff);
  if (rnd() < 0.5) m.poke(0x1102, 0xff);
  // add_score: keep the score within BCD
  for (let i = 0; i < 9; i += 1) m.poke(0x09b0 + i, 0);
}

test('sub_D28A: shots vs objects and the formation, scoring', () => {
  let marks = 0;
  for (let seed = 1; seed <= 600; seed += 1) {
    const rom = taskCase(0xd28a, seed, scene);
    marks += rom.events.length;
  }
  assert.ok(marks > 50, `hits seen: ${marks}`);
});

test('sub_D431: hit record and score sprite', () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    let u = 0;
    taskCase(0xd431, seed, (m, rnd) => {
      u = rnd() < 0.5 ? 0x1b00 + 2 * ri(rnd, 0x2d) : 0x1630 + 2 * ri(rnd,
        0x2d);
      m.poke(0x10c5, rnd() < 0.5 ? 0 : 1);
      if (rnd() < 0.7) m.poke(0x1075, 0xff);
      if (rnd() < 0.7) m.poke(0x1102, 0xff);
      for (let o = 0x0ece; o < 0x0edc; o += 2) {
        m.poke(o + 0x1001, rnd() < 0.6 ? 0x80 : 0);
      }
      if (rnd() < 0.5) m.poke(u + 1, ri(rnd, 256));
    }, { get u() { return u; } });
  }
});

test('sub_D588: formation counts, next mode, <$F8 copy', () => {
  for (let seed = 1; seed <= 400; seed += 1) {
    taskCase(0xd588, seed, (m, rnd) => {
      const empty = rnd() < 0.4;
      for (let n = 0; n < 0x2d; n += 1) {
        m.poke(0x1860 + n, empty ? (rnd() < 0.9 ? 0x01 : 0x03)
          : ri(rnd, 256));
      }
      // Exactly one slot left (<$20 = 1).
      if (rnd() < 0.2) {
        for (let n = 0; n < 0x2c; n += 1) m.poke(0x1860 + n, 0x01);
        m.poke(0x1860 + ri(rnd, 0x2c), 0x02);
      }
      if (rnd() < 0.5) m.poke(0x10f8, 0);
      if (rnd() < 0.5) m.poke(0x1067, 0);
      if (rnd() < 0.6) m.poke(0x10d6, 0);
      if (rnd() < 0.6) m.poke(0x10da, 0);
      if (rnd() < 0.5) m.poke(0x1165, 0xff);
      if (rnd() < 0.6) m.poke(0x1123, 0);
      if (rnd() < 0.6) m.poke(0x1f27, 0);
      if (rnd() < 0.6) {
        for (const a of [0x1f2d, 0x1e87, 0x1e8b]) m.poke(a, 0);
      }
      m.poke(0x1015, ri(rnd, 12));
    });
  }
});

test('task_stage_clear', () => {
  for (let seed = 1; seed <= 150; seed += 1) {
    taskCase(0xd676, seed, (m, rnd) => {
      m.poke(0x102d, rnd() < 0.5 ? 0 : 1);
      if (rnd() < 0.5) {
        const st = m.peek(0x102d) ? 0x1107 : 0x1106;
        m.poke(st, (2 + 5 * ri(rnd, 51) - 1) & 0xff);
      }
    });
  }
});

test('task_stage_start: PARSEC, CHALLENGING STAGE, wrap of $100A', () => {
  for (let seed = 1; seed <= 400; seed += 1) {
    taskCase(0xd71b, seed, (m, rnd) => {
      m.poke(0x102c, rnd() < 0.5 ? 0 : 1);
      m.poke(0x102d, rnd() < 0.5 ? 0 : 1);
      m.poke(0x09f4, rnd() < 0.5 ? 0 : 1);
      const st = m.peek(0x102d) ? 0x1107 : 0x1106;
      const r = rnd();
      if (r < 0.3) m.poke(st, 2 + 5 * ri(rnd, 16));
      else if (r < 0.6) m.poke(st, ri(rnd, 60));
      if (rnd() < 0.5) m.poke(0x100a, 0xff);
    });
  }
});

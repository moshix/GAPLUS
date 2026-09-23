// Copyright 2026 by Moshix
/**
 * Whole-chip test of gp2-6.11b: RAM states captured from the real ROM
 * running on the oracle board (attract mode with its demo game, and a
 * played 1P game), each replayed for one frame of the sub CPU's
 * foreground -- the end of task_end_frame_sub, then task_dispatch_sub
 * through every task of the list until the next CWAI -- on the oracle's
 * sub CPU and on the port. RAM must match after every replayed frame.
 *
 * Tasks of the other two sub chips ($A000-$DFFF) run as ROM stubs over
 * the port's RAM (romStub), so this file depends on gp2-6 alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOracle, randomPlayer } from '../helpers/oracle.mjs';
import {
  pair, same, romStub, SUB_CPU,
} from './sub-gp2_6-kit.test.mjs';
import { task_dispatch_sub } from '../../src/game/sub/gp2_6.js';
import { SUB_AT } from '../../src/game/sub/routines.js';
import { romWord } from '../../src/game/romdata.js';
import { loadState } from '../helpers/oracle.mjs';

/** Stub every other-chip task of the ten lists (not ported here). */
for (let mode = 0; mode < 10; mode += 1) {
  const list = romWord('sub', 0xe0f9 + 2 * mode);
  for (let i = 0; i < 24; i += 1) {
    const t = romWord('sub', list + 2 * i);
    if (t < 0xe000 && SUB_AT[t] === undefined) SUB_AT[t] = romStub(t);
    if (t === 0xe17f) break;
  }
}

/**
 * RAM snapshots at frame boundaries where the sub CPU sleeps in the CWAI
 * of task_end_frame_sub (stacked PC $E181), with the game_mode then.
 * @param {(b: import('../m6809/board.mjs').Board) => void} setup
 * @param {number} from @param {number} to @param {number} every
 */
function capture(setup, from, to, every) {
  const board = makeOracle();
  setup(board);
  board.runFrames(from);
  /** @type {Array<{ frame: number, mem: Uint8Array }>} */
  const out = [];
  for (let f = from; f < to; f += 1) {
    board.runFrame();
    if (f % every !== 0) continue;
    const c = board.cpus[SUB_CPU];
    if (c.wait === 0) continue;
    // CWAI stacked 12 bytes: CC A B DP X Y U PC, PC at S+10
    const pc = (board.mem[c.s + 10] << 8) | board.mem[c.s + 11];
    if (pc !== 0xe181) continue;
    out.push({ frame: f, mem: board.mem.slice() });
  }
  return out;
}

/**
 * Replay one foreground frame from `snap` on both sides.
 * @param {ReturnType<typeof pair>} p @param {{ mem: Uint8Array }} snap
 */
function replay(p, snap) {
  const { board, m } = p;
  loadState(board, snap);
  loadState(m, snap);
  board.machine.irqMask[SUB_CPU] = 1;
  m.irqMask[SUB_CPU] = 1;
  // Oracle: from $E181 (lds / clr <$7A / jmp $E0EC) to the next CWAI.
  const c = board.cpus[SUB_CPU];
  c.setState({ dp: 0x10, cc: 0x40, pc: 0xe181, s: 0x1d80, wait: 0 });
  c.irqLine = false;
  const save = board.syncOnLatch;
  board.syncOnLatch = false;
  let n = 0;
  let cycles = 0;
  while (c.wait === 0) {
    cycles += c.step();
    n += 1;
    if (n > 2_000_000) throw new Error('no CWAI');
  }
  board.syncOnLatch = save;
  const q = board.syncQueue;
  board.syncQueue = [];
  for (const f of q) f();
  const cwaiAt = c.ppc;
  // Port: the rest of task_end_frame_sub, then the task loop, stopped at
  // its first yield (the next CWAI).
  function* frame() {
    m.sub.charge(4); // lds #$1D80
    m.sub.peek(0x107a);
    m.sub.poke(0x107a, 0);
    m.sub.charge(6 + 4); // clr <$7A / jmp $E0EC
    yield* task_dispatch_sub(m);
  }
  const c0 = m.charged[SUB_CPU];
  const g = frame();
  let r = g.next();
  while (!r.done && r.value !== undefined) r = g.next(); // SYNCs
  assert.equal(r.done, false);
  assert.equal(r.value, undefined, 'a CWAI (bare yield)');
  assert.equal(m.charged[SUB_CPU] - c0, cycles, 'cycles to the CWAI');
  return cwaiAt;
}

/**
 * @param {string} name
 * @param {Array<{ frame: number, mem: Uint8Array }>} snaps
 */
function run(name, snaps) {
  const p = pair();
  /** @type {Map<number, number>} */
  const modes = new Map();
  for (const s of snaps) {
    replay(p, s);
    same(p.board, p.m, `${name} frame ${s.frame} mode ${s.mem[0x102f]}`);
    modes.set(s.mem[0x102f], (modes.get(s.mem[0x102f]) ?? 0) + 1);
  }
  return modes;
}

test('attract mode + demo game: one sub frame from each captured state', () => {
  const snaps = capture(() => {}, 230, 7000, 3);
  assert.ok(snaps.length > 1000, `${snaps.length} states`);
  const modes = run("attract", snaps);
  // The demo game goes through the stage modes.
  for (const k of [1, 3, 5]) assert.ok(modes.has(k), `mode ${k} seen`);
});

test('a played 1P game: one sub frame from each captured state', () => {
  const snaps = capture((b) => {
    b.tap('coin1', 300);
    b.tap('start1', 360);
    b.inputScript = randomPlayer(21, { from: 400 });
  }, 380, 6000, 2);
  assert.ok(snaps.length > 1000, `${snaps.length} states`);
  const modes = run("game", snaps);
  for (const k of [2, 3, 4, 5, 6]) assert.ok(modes.has(k), `mode ${k} seen`);
});

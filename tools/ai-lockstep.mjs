// Copyright 2026 by Moshix
/**
 * The self-playing AI's games in lockstep: the port and the real ROM (the
 * oracle board) side by side, fed the same switches, compared byte for
 * byte (RAM and latches) after every frame, as test/oracle/lockstep.test
 * does for random input -- but for the long games the AI plays, deep into
 * the PARSECs random input never reaches.
 *
 *   node tools/ai-lockstep.mjs [--runs=12] [--first=0] [--cap=60000]
 *        [--save=DIR] [--log=FILE] [--replay=FILE]
 *
 * Run n is tools/ai-bench.mjs's run n (AI seed n + 1, n * 7 idle frames
 * at the first fighter). The AI reads the port's RAM, which equals the
 * ROM's as long as the run is clean. Each run stops at the first
 * differing frame, at a throw of either side, at game over, or at the
 * frame cap, and prints one line. `--save=DIR` writes the oracle's
 * state every 5,000 frames of a clean run (DIR/run<n>-f<frame>.json),
 * for tests that start deep in a game; `--log=FILE` writes run --first's
 * switch changes per frame (JSON), and `--replay=FILE` plays such a log
 * instead of the AI (the AI is still being tuned: a log keeps a game).
 *
 * Everything printed stays within 79 columns.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePortPair, describe } from '../test/helpers/lockstep.mjs';
import { AutoPlayer } from '../src/ai/autoplay.js';
import { copyInputs } from '../src/engine.js';
import {
  ATTRACT_FLAG, GAME_MODE, STAGE_P1,
} from '../src/ai/constants.js';

const args = process.argv.slice(2);
/** @param {string} k @param {number} d */
const num = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? Number(a.split('=')[1]) : d;
};
/** @param {string} k */
const str = (k) => args.find((x) => x.startsWith(`--${k}=`))?.split('=')[1];
const runs = num('runs', 12);
const first = num('first', 0);
const cap = num('cap', 60000);
const save = str('save');
const log = str('log');
const replay = str('replay');
/** Idle frames per run number (tools/ai-bench.mjs IDLE_STEP). */
const IDLE_STEP = 7;
/** The switches the AI closes (the log's columns). */
const SWITCHES = ['coin1', 'start1', 'up', 'down', 'left', 'right', 'fire1'];

/**
 * A switch log's player: sets the switches of frame f.
 * @param {Array<[number, number]>} changes [frame, mask] pairs
 * @param {import('../src/game/port.js').Port} port
 * @returns {(f: number) => void}
 */
function logPlayer(changes, port) {
  let i = 0;
  return (f) => {
    while (i < changes.length && changes[i][0] <= f) {
      const mask = changes[i][1];
      SWITCHES.forEach((name, k) => {
        port.setInput(name, (mask & (1 << k)) !== 0);
      });
      i += 1;
    }
  };
}

/**
 * The switch state as a bit mask, in SWITCHES order.
 * @param {import('../src/machine/namcoio.js').InputState} s
 * @returns {number}
 */
function switchMask(s) {
  const on = [s.coin1, s.start1, s.p1.up, s.p1.down, s.p1.left,
    s.p1.right, s.fire1];
  return on.reduce((m, v, i) => (v ? m | (1 << i) : m), 0);
}

/**
 * One AI game in lockstep.
 * @param {number} run
 * @param {Array<[number, number]>} changes filled with [frame, switch
 *   mask] at every change of the AI's switches
 * @returns {string} the result line
 */
function lockstepRun(run, changes) {
  const pair = makePortPair();
  const { board, port } = pair;
  const ai = new AutoPlayer({
    peek: (a) => port.mem[a & 0xffff],
    setInput: (name, down) => port.setInput(name, down),
  }, { startIdle: run * IDLE_STEP, seed: run + 1 });
  const played = replay
    ? logPlayer(JSON.parse(readFileSync(replay, 'utf8')).changes, port)
    : null;
  let lastMask = -1;
  let started = false;
  let parsec = 0;
  for (let f = 0; f < cap; f += 1) {
    if (played) played(f); else ai.step();
    copyInputs(port.inputs, board.inputs);
    const mask = switchMask(port.inputs);
    if (mask !== lastMask) { changes.push([f, mask]); lastMask = mask; }
    let d;
    try {
      d = pair.step();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `run ${run}: frame ${f} PARSEC ${parsec}: port threw: ${msg}`;
    }
    if (d.length) {
      return [`run ${run}: frame ${f} PARSEC ${parsec}: ${d.length} differ`,
        ...describe(d).slice(0, 6).map((l) => `  ${l}`)].join('\n');
    }
    const mode = board.mem[GAME_MODE];
    const attract = board.mem[ATTRACT_FLAG] !== 0;
    if (!started && !attract && mode !== 0) started = true;
    if (started && mode >= 1 && mode <= 8) {
      parsec = Math.max(parsec, board.mem[STAGE_P1] + 1);
    }
    if (started && attract) {
      return `run ${run}: clean to game over, frame ${f}, PARSEC ${parsec}`;
    }
    if (save && f > 0 && f % 5000 === 0) {
      mkdirSync(save, { recursive: true });
      const file = join(save, `run${run}-f${f + 1}.json`);
      writeFileSync(file, JSON.stringify({
        run, frame: f + 1, parsec, state: board.getState(),
      }));
    }
  }
  return `run ${run}: clean for ${cap} frames, PARSEC ${parsec}`;
}

for (let n = first; n < first + runs; n += 1) {
  /** @type {Array<[number, number]>} */
  const changes = [];
  console.log(lockstepRun(n, changes));
  if (log && n === first) {
    writeFileSync(log, `${JSON.stringify({ run: n, SWITCHES, changes })}\n`);
  }
}

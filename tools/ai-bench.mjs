// Copyright 2026 by Moshix
/**
 * Measure how well the self-playing AI plays the JavaScript port.
 *
 * The AI inserts a coin and presses start whenever no game is running, so
 * a benchmark is just the port, the AI and a frame loop -- no browser. The
 * port is built the way src/engine.js builds it (`new Port()` from
 * src/game/port.js); the AI reads its RAM and closes its switches, and
 * nothing else touches it.
 *
 * WHERE THE VARIETY COMES FROM. Gaplus has no random number generator:
 * its "randomness" is the frame counter (cleared at every stage start),
 * the stage and a score digit, so the same player replays the same game.
 * Run n therefore gives the AI seed n + 1 -- small seeded tie-breaks in
 * its stick choice -- and has it stand still for n * IDLE_STEP frames when
 * its first fighter appears. Run n is always the same game.
 *
 * Usage:
 *   node tools/ai-bench.mjs                 10 games
 *   node tools/ai-bench.mjs --runs=20 --verbose
 *   node tools/ai-bench.mjs --cap=200000    frame cap per game
 *   node tools/ai-bench.mjs --first=5       start at run 5
 *   node tools/ai-bench.mjs --json
 *
 * Everything printed stays within 79 columns.
 */

import { Port } from '../src/game/port.js';
import { AutoPlayer } from '../src/ai/autoplay.js';
import {
  ATTRACT_FLAG, GAME_MODE, LIVES_P1, STAGE_P1, SCORE_P1, PLAYER_EXPLODING,
  PLAYER_H, LETHAL_RANGES, ESHOT_FIRST, ESHOT_COUNT, DIVER_FIRST,
  FORMATION_SLOTS, OBJECT_FIRST, OBJECT_LAST, HIT_H, HIT_V2,
} from '../src/ai/constants.js';
import { entryV, entryInUse } from '../src/ai/world.js';

/** Frames per second of the board: 1.536 MHz / 25344 cycles. */
const FPS = 1536000 / 25344;
/** Give up on a game after this many frames (~55 minutes). */
const DEFAULT_FRAME_CAP = 200000;
/** Idle frames per run number (see WHERE THE VARIETY COMES FROM). */
const IDLE_STEP = 7;
/** Frames to wait for the first game to start before calling it stuck. */
const START_TIMEOUT = 3000;

/**
 * Player 1's score: 3 BCD bytes at $09B0, least significant first, in
 * hundreds of points: $82 shows as "8200" (the screen's last two digits
 * are fixed zeros; an enemy is 100 or 200, results_hits100/200).
 * @param {(a: number) => number} peek @returns {number}
 */
export function readScore(peek) {
  let s = 0;
  for (let i = 2; i >= 0; i -= 1) {
    const b = peek(SCORE_P1 + i);
    s = s * 100 + (b >> 4) * 10 + (b & 15);
  }
  return s * 100;
}

/**
 * What hit the fighter: the lethal entry inside its box on the frame the
 * explosion starts (task_player_hit_check's own test, $D95E).
 * @param {(a: number) => number} peek @returns {string}
 */
export function causeOfDeath(peek) {
  const h = peek(PLAYER_H);
  const v2 = entryV(peek, 0) >> 1;
  for (const [first, last] of LETHAL_RANGES) {
    for (let i = first; i <= last; i += 1) {
      if (!entryInUse(peek, i)) continue;
      const dh = peek(0x1600 + 2 * i) - h;
      const dv = (entryV(peek, i) >> 1) - v2;
      if (dh < -HIT_H || dh >= HIT_H || dv < -HIT_V2 || dv >= HIT_V2) continue;
      if (i >= ESHOT_FIRST && i < ESHOT_FIRST + ESHOT_COUNT) return 'shot';
      if (i >= DIVER_FIRST && i < DIVER_FIRST + FORMATION_SLOTS) return 'enemy';
      if (i >= OBJECT_FIRST && i <= OBJECT_LAST) return 'object';
      return 'other';
    }
  }
  return 'unknown';
}

/**
 * @typedef {object} GameResult
 * @property {number} frames     frames from the start press to game over
 * @property {number} parsec     highest PARSEC reached (1-based)
 * @property {number} score
 * @property {number} deaths     ships lost
 * @property {number[]} deathParsec PARSEC of each loss
 * @property {Record<string, number>} causes what the losses ran into
 * @property {number} shots      fire presses the AI made
 * @property {boolean} capped    stopped by the frame cap
 * @property {string} error      the port's exception, if it threw
 * @property {number} aiMs       mean AI time per frame, milliseconds
 */

/**
 * Play one game on a fresh port, from power-on to game over.
 * @param {number} run the run number (sets the idle frames)
 * @param {number} frameCap
 * @returns {GameResult}
 */
export function playOneGame(run, frameCap) {
  const port = new Port();
  const peek = (/** @type {number} */ a) => port.mem[a];
  const ai = new AutoPlayer({
    peek,
    setInput: (name, down) => port.setInput(name, down),
  }, { startIdle: run * IDLE_STEP, seed: run + 1 });
  /** @type {GameResult} */
  const r = {
    frames: 0, parsec: 0, score: 0, deaths: 0, deathParsec: [], causes: {},
    shots: 0, capped: false, error: '', aiMs: 0,
  };
  let started = false;
  let lives = -1;
  let wasExploding = false;
  let aiTime = 0;
  let frame = 0;
  for (; frame < frameCap + START_TIMEOUT; frame += 1) {
    const t0 = performance.now();
    ai.step();
    aiTime += performance.now() - t0;
    try {
      port.runFrame();
    } catch (err) {
      r.error = `frame ${frame}: ${err instanceof Error ? err.message : err}`;
      break;
    }
    const attract = peek(ATTRACT_FLAG) !== 0;
    if (!started) {
      if (!attract && peek(GAME_MODE) !== 0) started = true;
      else if (frame > START_TIMEOUT) { r.error = 'the game never started'; break; }
      continue;
    }
    if (attract) break;               // game over, back to attract mode
    r.frames += 1;
    if (r.frames > frameCap) { r.capped = true; break; }
    const mode = peek(GAME_MODE);
    if (mode >= 1 && mode <= 8) r.parsec = Math.max(r.parsec, peek(STAGE_P1) + 1);
    const exploding = peek(PLAYER_EXPLODING) !== 0;
    if (exploding && !wasExploding) {
      const cause = causeOfDeath(peek);
      r.causes[cause] = (r.causes[cause] ?? 0) + 1;
    }
    wasExploding = exploding;
    // A loss takes one off lives_p1; a bonus ship adds one.
    const l = peek(LIVES_P1);
    if (lives >= 0 && l === ((lives - 1) & 0xff)) {
      r.deaths += 1;
      r.deathParsec.push(peek(STAGE_P1) + 1);
    }
    lives = l;
    r.score = Math.max(r.score, readScore(peek));
  }
  r.shots = ai.telemetry.shots;
  r.aiMs = aiTime / Math.max(1, frame);
  return r;
}

/** @param {number[]} v @returns {number} */
const mean = (v) => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);

/** @param {string[]} argv @param {string} name @param {string} fallback */
function option(argv, name, fallback) {
  for (const a of argv) if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  return fallback;
}

/** @param {number} n @param {number} [d] @returns {string} */
const fmt = (n, d = 1) => n.toFixed(d);

async function main() {
  const argv = process.argv.slice(2);
  const runs = Number.parseInt(option(argv, 'runs', '10'), 10);
  const first = Number.parseInt(option(argv, 'first', '0'), 10);
  const cap = Number.parseInt(option(argv, 'cap', String(DEFAULT_FRAME_CAP)), 10);
  const verbose = argv.includes('--verbose');
  const asJson = argv.includes('--json');
  if (!Number.isFinite(runs) || runs < 1) {
    console.error('--runs needs a positive integer');
    process.exitCode = 1;
    return;
  }
  const results = [];
  for (let i = first; i < first + runs; i += 1) {
    const t0 = Date.now();
    const r = playOneGame(i, cap);
    results.push({ run: i, ms: Date.now() - t0, ...r });
    if (r.error !== '') {
      console.error(`run ${i}: ${r.error}`.slice(0, 79));
      process.exitCode = 1;
    }
    if (verbose && !asJson) {
      // "run  3 P 12 score 123450 lost 3 at 5,9,12  61s"
      const line = `run ${String(i).padStart(3)}  parsec ${String(r.parsec).padStart(3)}`
        + `  score ${String(r.score).padStart(7)}  lost ${r.deaths}`
        + ` at ${r.deathParsec.join(',')}${r.capped ? ' [cap]' : ''}`
        + `  ${Math.round((Date.now() - t0) / 1000)}s`;
      console.log(line.slice(0, 79));
    }
  }
  if (asJson) {
    console.log(JSON.stringify({ runs, cap, results }, null, 2));
    return;
  }
  const n = results.length;
  const parsecs = results.map((r) => r.parsec);
  const deaths = results.reduce((a, r) => a + r.deaths, 0);
  const stages = results.reduce((a, r) => a + r.parsec, 0);
  /** @type {Record<string, number>} */
  const causes = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r.causes)) causes[k] = (causes[k] ?? 0) + v;
  }
  const minutes = mean(results.map((r) => r.frames)) / FPS / 60;
  console.log(`AI benchmark: ${n} games on the port, cap ${cap} frames`);
  console.log(`  score        mean ${Math.round(mean(results.map((r) => r.score)))}`
    + `  best ${Math.max(...results.map((r) => r.score))}`);
  console.log(`  parsec       mean ${fmt(mean(parsecs))}  worst ${Math.min(...parsecs)}`
    + `  best ${Math.max(...parsecs)}`);
  console.log(`  play time    mean ${fmt(minutes)} min`);
  console.log(`  ships lost   ${fmt(deaths / Math.max(1, stages), 2)} per parsec`
    + ` (${deaths} in ${stages} parsecs)`);
  const causeText = Object.entries(causes).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`  hit by       ${causeText || 'nothing'}`.slice(0, 79));
  console.log(`  AI cost      ${fmt(mean(results.map((r) => r.aiMs)), 3)} ms/frame`);
  const capped = results.filter((r) => r.capped).length;
  if (capped > 0) console.log(`  ${capped} game(s) hit the frame cap`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();

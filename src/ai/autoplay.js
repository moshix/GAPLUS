// Copyright 2026 by Moshix
/**
 * The self-playing AI for the JavaScript port of Gaplus.
 *
 * It is a *controller*, not a cheat: it reads the game's state from RAM,
 * but its only outputs are the switches a human has -- the 8-way stick and
 * fire, plus coin and start to begin a game. It cannot move the fighter
 * faster than task_move_player does, cannot fire faster than
 * task_player_fire allows (a fresh press, a free shot slot), and dies to
 * exactly the same hit box.
 *
 * WHAT IT IS TRYING TO DO: stay alive first, score second.
 *
 *  - Everything that kills is a sprite entry the hit check scans; its
 *    motion is measured frame to frame (enemy shots are computed), and a
 *    search over stick plans picks the move that survives longest, passes
 *    furthest from danger, and ends under something worth shooting.
 *    @see ./evade.js
 *  - A shot is fired only when, simulated forward, it meets a target.
 *    @see ./aim.js
 *  - The hit check runs only in game modes 3 and 5; in a challenging
 *    stage (mode 7) nothing can hit the fighter, so it only hunts.
 *  - The input latency is measured, not assumed (see calibrate()): it
 *    depends on where the host samples the game.
 *
 * Like Galaga's AI, it inserts a coin and presses start whenever no game
 * is running, so turning it on in attract mode starts a game.
 */

import { WorldReader } from './world.js';
import { Planner } from './evade.js';
import { buildAimMap, shotHits } from './aim.js';
import { stepShip } from './predict.js';
import {
  V_TOP, V_BOTTOM, DIRS, MODE_CHALLENGE, SHOT_TOLERANCE,
} from './constants.js';

/** @typedef {'up'|'down'|'left'|'right'|'fire1'|'coin1'|'start1'} SwitchName */

/**
 * What the AI needs from a machine: RAM reads and the player's switches.
 * @typedef {object} Controllable
 * @property {(addr: number) => number} peek
 * @property {(name: SwitchName, down: boolean) => void} setInput
 */

/** Every switch the AI may touch. */
export const AI_SWITCHES = Object.freeze(/** @type {SwitchName[]} */ (
  ['up', 'down', 'left', 'right', 'fire1', 'coin1', 'start1']));

/** Input latencies the calibration considers, frames of pending input. */
const MAX_DELAY = 2;
/** Directions remembered; must exceed MAX_DELAY. */
const HISTORY = 6;
/** Coin/start pulse: held this many frames out of every COIN_CYCLE. */
const COIN_HOLD = 4;
const COIN_CYCLE = 20;
/**
 * The row the fighter rests on in normal play: near the bottom, farthest
 * from the formation and with the most time to see a diver coming -- but
 * not on it: from PARSEC 4 on, divers sweep along the bottom row at 4 px a
 * frame, and a fighter there (1 px a frame vertically) cannot climb out
 * of their way in time.
 */
const HOME_PLAY = V_BOTTOM - 17;
/** In a challenging stage nothing can hit it: rest high, near the
 * enemies' paths, so shots arrive sooner. */
const HOME_CHALLENGE = V_TOP + 24;
/** When both shot slots are free, a shot within this much of a hit is
 * worth taking (negative: a wider box than the real one). */
const LOOSE_TOLERANCE = -4;
/** Size of the seeded tie-breaks, in plan score (100 = a frame of life). */
const BIAS = 2;

export class AutoPlayer {
  /**
   * @param {Controllable} machine
   * @param {{autoStart?: boolean, delay?: number, startIdle?: number,
   *   seed?: number}} [options]
   *   autoStart (default true): insert a coin and press start whenever no
   *   game is running. delay: fix the input latency instead of measuring
   *   it. startIdle: frames to stand still at the start of each game (the
   *   benchmark uses it to play different games: the ROM's randomness is
   *   the frame counter, so the same inputs replay the same game).
   *   seed: non-zero adds seeded tie-breaks (under one pixel's worth of
   *   plan score) to the stick choice, so that each seed plays a
   *   slightly different -- but reproducible -- game. The ROM mixes only
   *   the frame counter, the stage and a score digit into its choices,
   *   so a deterministic player replays the same game every time.
   */
  constructor(machine, options = {}) {
    this.m = machine;
    this.autoStart = options.autoStart ?? true;
    this.startIdle = options.startIdle ?? 0;
    /** xorshift32 state; 0 = no tie-breaks. */
    this.rng = (options.seed ?? 0) >>> 0;
    this.bias = new Float64Array(DIRS.length);
    this.reader = new WorldReader();
    this.planner = new Planner();
    this.aim = new Float64Array(256);
    /** Directions sent, most recent first. */
    this.sent = new Int8Array(HISTORY);
    /** Pending inputs when the frame runs (0: acted on in that frame). */
    this.delay = options.delay ?? 0;
    this.calibrating = options.delay === undefined;
    this.delayVotes = new Int32Array(MAX_DELAY + 1);
    /** The fighter as last seen; h < 0: not in play. */
    this.last = { h: -1, v: 0 };
    this.lastDir = 0;
    this.coinPhase = 0;
    /** Frames of play in the current game so far (for startIdle). */
    this.gameFrames = 0;
    /** The last world read, for hosts and tests. @type {import('./world.js').World | null} */
    this.world = null;
    /** Diagnostics, readable from the console. */
    this.telemetry = { mode: 'idle', threats: 0, tDeath: 0, shots: 0 };
  }

  /**
   * Open every switch. Called at the top of every frame, so no input can
   * stick on an early return, and by the host when it takes back control.
   */
  release() {
    for (const name of AI_SWITCHES) this.m.setInput(name, false);
  }

  /** Forget everything tied to the current fighter. */
  reset() {
    this.sent.fill(0);
    this.lastDir = 0;
    this.last.h = -1;
    this.reader.reset();
  }

  /** One frame of play, before the machine runs it. */
  step() {
    this.release();
    const peek = (/** @type {number} */ a) => this.m.peek(a);
    const w = this.reader.read(peek);
    this.world = w;
    if (w.attract) {
      this.gameFrames = 0;
      this.reset();
      this.telemetry.mode = 'idle';
      if (this.autoStart) this.pulse('coin1');
      return;
    }
    // Credited but not started: the main CPU sits in attract_loop's push
    // start screen with game_mode and main_task both 0. A start press at
    // a stage start (the same values) is ignored by the game.
    if (w.mode === 0 && w.task === 0 && this.autoStart) this.pulse('start1');
    else this.coinPhase = 0;
    // startIdle counts frames of real play (modes 3-5), where it changes
    // the game; idling at the start screen would change nothing.
    if (w.live && w.danger) this.gameFrames += 1;
    if (!w.live || (w.danger && this.gameFrames <= this.startIdle)) {
      // Exploding, frozen by the capture, between stages, or waiting:
      // nothing to steer.
      this.reset();
      this.telemetry.mode = 'wait';
      return;
    }
    this.calibrate(w);
    const queued = [];
    for (let i = this.delay - 1; i >= 0; i -= 1) queued.push(this.sent[i]);

    w.vHome = w.mode === MODE_CHALLENGE ? HOME_CHALLENGE : HOME_PLAY;
    buildAimMap(this.aim, w, Math.min(w.v, HOME_PLAY));
    if (w.danger) this.planner.prepare(w, w.threats);
    else this.planner.count = 0;
    const aim = this.aim;
    if (this.rng !== 0) {
      for (let d = 0; d < DIRS.length; d += 1) this.bias[d] = BIAS * (this.random() - 0.5);
    }
    const move = this.planner.choose(w, queued,
      (h) => aim[Math.max(0, Math.min(255, Math.round(h)))], this.lastDir, this.bias);
    this.send(move.dir);
    this.fire(w, move.h, move.v);

    this.telemetry.mode = move.tDeath <= this.planner.horizon ? 'dodge' : 'play';
    this.telemetry.threats = this.planner.count;
    this.telemetry.tDeath = move.tDeath;
  }

  /**
   * Press fire, but only at something. A shot needs a fresh press
   * (fire_held is 0 only after a frame with the button up), a free slot,
   * and the fire task not locked out; it appears where the fighter is on
   * the press frame, `delay` frames from now.
   * @param {import('./world.js').World} w
   * @param {number} h @param {number} v the fighter on the press frame
   */
  fire(w, h, v) {
    if (w.fireLocked || w.fireHeld !== 0 || w.shotsFree === 0) return;
    // Predictions are made from now; the shot starts `delay` frames later.
    let r = shotHits(w, h, v, SHOT_TOLERANCE, this.delay);
    if (r.target === null && w.shotsFree >= 2) {
      r = shotHits(w, h, v, LOOSE_TOLERANCE, this.delay);
    }
    if (r.target === null) return;
    this.m.setInput('fire1', true);
    this.telemetry.shots += 1;
  }

  /**
   * Measure the input latency instead of assuming it: which of the
   * directions sent 1, 2 or 3 frames ago, pushed through the real step
   * logic, explains the fighter's last move? When some latencies do and
   * others do not, the ones that do get a vote.
   * @param {import('./world.js').World} w
   */
  calibrate(w) {
    if (this.calibrating && this.last.h >= 0) {
      const hit = [];
      let agree = 0;
      for (let d = 0; d <= MAX_DELAY; d += 1) {
        const s = { h: this.last.h, v: this.last.v };
        stepShip(s, this.sent[d], w);
        hit.push(s.h === w.h && s.v === w.v);
        if (hit[d]) agree += 1;
      }
      if (agree > 0 && agree <= MAX_DELAY) {
        for (let d = 0; d <= MAX_DELAY; d += 1) if (hit[d]) this.delayVotes[d] += 1;
      }
      let best = this.delay;
      for (let d = 0; d <= MAX_DELAY; d += 1) {
        if (this.delayVotes[d] > this.delayVotes[best]) best = d;
      }
      this.delay = best;
    }
    this.last.h = w.h;
    this.last.v = w.v;
  }

  /**
   * Close the stick's switches for `dir` and remember it.
   * @param {number} dir index into DIRS
   */
  send(dir) {
    const [dh, dv] = DIRS[dir];
    if (dh < 0) this.m.setInput('left', true);
    else if (dh > 0) this.m.setInput('right', true);
    if (dv < 0) this.m.setInput('up', true);
    else if (dv > 0) this.m.setInput('down', true);
    this.sent.copyWithin(1, 0, HISTORY - 1);
    this.sent[0] = dir;
    if (dir !== 0) this.lastDir = dir;
  }

  /**
   * The seeded tie-break generator (xorshift32), 0 <= x < 1.
   * @returns {number}
   */
  random() {
    let x = this.rng;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.rng = x;
    return x / 0x100000000;
  }

  /**
   * Coin or start, in pulses: the 56XX counts presses, not levels.
   * @param {SwitchName} name
   */
  pulse(name) {
    this.coinPhase = (this.coinPhase + 1) % COIN_CYCLE;
    if (this.coinPhase < COIN_HOLD) this.m.setInput(name, true);
  }
}

export default AutoPlayer;

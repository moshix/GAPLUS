// Copyright 2026 by Moshix
/**
 * The only part of the AI that reads the machine: RAM -> a picture of the
 * game. It only ever calls `peek(addr)`; it has no way to write.
 *
 * Positions come from the sprite shadow (see constants.js for the
 * layout). Velocities do not exist in RAM for most objects -- the sub CPU
 * flies divers along paths it keeps to itself -- so they are measured: the
 * reader remembers every entry's position from the previous frame and the
 * one before, and the difference is the velocity (and the difference of
 * differences the acceleration). The one exception is the enemy shot,
 * whose sideways speed is in RAM ($1B60+2j) and whose fall is fixed, so
 * its track is exact.
 */

import {
  ATTRACT_FLAG, GAME_MODE, MAIN_TASK, FRAME_COUNTER, LIVES_P1, STAGE_P1,
  PLAYER_H, PLAYER_V, PLAYER_VHI, PLAYER_FROZEN, PLAYER_VLOCK, FIRE_LOCK,
  PLAYER_EXPLODING, PLAYER_DYING, PLAYER_STEP, PLAYER_SPEED,
  PLAYER_HMIN, PLAYER_HMAX, SHOT_FIRST, SHOT_SLOTS_END, SHOT_SPEED,
  FIRE_HELD, SHOT_BOX_R, SHOT_BOX_W, FIGHTER_OFFSETS, FORMATION_FLAGS,
  FORMATION_SLOTS, FORMATION_POS, DIVER_FIRST, ESHOT_FIRST, ESHOT_COUNT,
  ESHOT_VEL, ESHOT_VY, OBJECT_FIRST, OBJECT_LAST, LETHAL_RANGES, ENTRIES,
  MODE_CHALLENGE, HIT_SKIP,
} from './constants.js';

/** @typedef {(addr: number) => number} Peek */

/** What kind of thing an object is. */
export const KIND = Object.freeze({
  ESHOT: 0, DIVER: 1, OBJECT: 2, FORMATION: 3, OTHER: 4,
});

/**
 * One object on screen, with its measured motion.
 * @typedef {object} Obj
 * @property {number} id     sprite entry (0-153), or 0x100 + formation slot
 * @property {number} kind   KIND.*
 * @property {number} h      horizontal position
 * @property {number} v      9-bit vertical position (down is +)
 * @property {number} vh     horizontal speed, pixels per frame
 * @property {number} vv     vertical speed
 * @property {number} ah     horizontal acceleration (0 when unknown)
 * @property {number} av     vertical acceleration
 * @property {number} age    frames this entry has been tracked (0: new)
 * @property {boolean} exact the track is computed, not measured
 */

/**
 * The game as the AI sees it on one frame.
 * @typedef {object} World
 * @property {boolean} attract   attract mode (no credit, no game)
 * @property {number} mode       game_mode
 * @property {number} task       main_task
 * @property {number} frame      frame_counter
 * @property {boolean} live      a fighter is in play and may move
 * @property {boolean} challenge a challenging stage
 * @property {boolean} danger    the hit check runs this frame: modes 3
 *                               and 5 only ($FF36, $FF7C), 4 counted too
 *                               because it hands over to 5 at once
 * @property {boolean} hitSkip   the hit check is off ($101A)
 * @property {number} h          fighter horizontal
 * @property {number} v          fighter vertical (9-bit)
 * @property {number} hStep      horizontal pixels per frame
 * @property {number} vStep      vertical pixels per frame
 * @property {number} hMin       a left move is taken while h >= hMin
 * @property {number} hMax       a right move is taken while h < hMax
 * @property {boolean} vLocked   vertical moves are ignored
 * @property {boolean} fireLocked the fire task is off
 * @property {number} fireHeld   fire_held: 0 when a press would fire
 * @property {number} shotsFree  free shot slots
 * @property {number} shotSpeed  pixels a shot climbs per frame
 * @property {number} boxLo      shot box: target h - shot h >= boxLo
 * @property {number} boxHi      ... and < boxHi
 * @property {number} lives
 * @property {number} stage      0-based
 * @property {Obj[]} threats     everything that kills on contact
 * @property {Obj[]} targets     everything a shot can destroy
 * @property {number} [vHome]    the row the fighter wants to rest on (set
 *                               by the player, not read from RAM)
 */

/**
 * Read one sprite shadow entry's 9-bit vertical position.
 * @param {Peek} peek @param {number} i @returns {number}
 */
export function entryV(peek, i) {
  return peek(0x1601 + 2 * i) | ((peek(0x1e01 + 2 * i) & 1) << 8);
}

/** @param {Peek} peek @param {number} i @returns {boolean} */
export function entryInUse(peek, i) {
  return (peek(0x1e01 + 2 * i) & 0x80) !== 0;
}

/** A jump bigger than this between frames is a new object, not motion. */
const TELEPORT = 24;
/** Positions remembered per object (a power of two). */
const HIST = 16;
/** Velocity is measured over up to this many frames: divers move by
 * fractions of a pixel, so one frame's difference alternates 1, 2, 1... */
const VSPAN = 4;

/** Keeps the per-entry history and turns RAM into a World each frame. */
export class WorldReader {
  constructor() {
    // Per tracked id (0-153 sprite entries, 256+k formation slots): a
    // ring of the last HIST positions.
    const n = 0x100 + FORMATION_SLOTS;
    this.hh = new Float64Array(n * HIST);
    this.vh = new Float64Array(n * HIST);
    /** Frames tracked without a break; 0: new this frame. */
    this.age = new Int32Array(n);
    /** Tick of the last update, to spot entries that vanished. */
    this.seen = new Int32Array(n).fill(-2);
    this.tick = 0;
  }

  /** Forget all history (new fighter, new game). */
  reset() {
    this.seen.fill(-2);
  }

  /**
   * Position of `id` `back` frames ago (0: this frame).
   * @param {number} id @param {number} back @returns {[number, number]}
   */
  past(id, back) {
    const k = id * HIST + ((this.tick - back) & (HIST - 1));
    return [this.hh[k], this.vh[k]];
  }

  /**
   * Record an object's position and measure its motion from its history.
   * Velocity is the mean over the last VSPAN frames; acceleration is the
   * change between the last two such spans (0 until there are two).
   * @param {number} id @param {number} kind @param {number} h @param {number} v
   * @returns {Obj}
   */
  track(id, kind, h, v) {
    let age = this.seen[id] === this.tick - 1 ? this.age[id] + 1 : 0;
    if (age > 0) {
      const [h1, v1] = this.past(id, 1);
      if (Math.abs(wrapH(h - h1)) > TELEPORT || Math.abs(v - v1) > TELEPORT) age = 0;
    }
    const k = id * HIST + (this.tick & (HIST - 1));
    this.hh[k] = h;
    this.vh[k] = v;
    this.age[id] = age;
    this.seen[id] = this.tick;
    let vh = 0; let vv = 0; let ah = 0; let av = 0;
    if (age > 0) {
      const n = Math.min(age, VSPAN);
      const [hn, vn] = this.past(id, n);
      vh = wrapH(h - hn) / n;
      vv = (v - vn) / n;
      if (age >= 2 * VSPAN) {
        const [h2, v2] = this.past(id, 2 * VSPAN);
        ah = (vh - wrapH(hn - h2) / VSPAN) / VSPAN;
        av = (vv - (vn - v2) / VSPAN) / VSPAN;
      }
    }
    return { id, kind, h, v, vh, vv, ah, av, age, exact: false };
  }

  /**
   * Read the whole world.
   * @param {Peek} peek
   * @returns {World}
   */
  read(peek) {
    this.tick += 1;
    const mode = peek(GAME_MODE);
    const attract = peek(ATTRACT_FLAG) !== 0;
    const exploding = peek(PLAYER_EXPLODING) !== 0 || peek(PLAYER_DYING) !== 0;
    const frozen = peek(PLAYER_FROZEN) !== 0;
    // The fighter's sprite entry is in use only while it is on screen.
    const onScreen = (peek(PLAYER_VHI) & 0x80) !== 0;
    const live = !attract && !exploding && !frozen && onScreen
      && mode <= 7 && mode !== 6;
    const boxR = (peek(SHOT_BOX_R) + peek(FIGHTER_OFFSETS)) & 0xff;
    const boxW = (peek(SHOT_BOX_W) + peek(FIGHTER_OFFSETS + 1)) & 0xff;
    const slotsEnd = (peek(SHOT_SLOTS_END) << 8) | peek(SHOT_SLOTS_END + 1);
    let shotsFree = 0;
    for (let a = 0x0e00 + 2 * SHOT_FIRST; a < slotsEnd && a < 0x0eaa; a += 2) {
      if ((peek(a + 0x1001) & 0x80) === 0) shotsFree += 1;
    }
    /** @type {World} */
    const w = {
      attract,
      mode,
      task: peek(MAIN_TASK),
      frame: peek(FRAME_COUNTER),
      live,
      challenge: mode === MODE_CHALLENGE,
      danger: mode >= 3 && mode <= 5 && peek(HIT_SKIP) === 0,
      hitSkip: peek(HIT_SKIP) !== 0,
      h: peek(PLAYER_H),
      v: entryV(peek, 0),
      hStep: peek(PLAYER_STEP) || 2,
      vStep: peek(PLAYER_SPEED) || 1,
      hMin: peek(PLAYER_HMIN),
      hMax: peek(PLAYER_HMAX),
      vLocked: peek(PLAYER_VLOCK) !== 0,
      fireLocked: peek(FIRE_LOCK) !== 0,
      fireHeld: peek(FIRE_HELD),
      shotsFree,
      shotSpeed: peek(SHOT_SPEED) || 6,
      // task_shot_hits: box [shot + R - W, shot + R); R, W as signed bytes.
      boxLo: signed(boxR) - boxW,
      boxHi: signed(boxR),
      lives: peek(LIVES_P1),
      stage: peek(STAGE_P1),
      threats: [],
      targets: [],
    };
    this.collect(peek, w);
    return w;
  }

  /**
   * Fill the threat and target lists.
   * @param {Peek} peek @param {World} w
   */
  collect(peek, w) {
    // Lethal sprite entries: exactly the two ranges the hit check scans.
    for (const [first, last] of LETHAL_RANGES) {
      for (let i = first; i <= last; i += 1) {
        if (!entryInUse(peek, i)) continue;
        const h = peek(0x1600 + 2 * i);
        const v = entryV(peek, i);
        let kind = KIND.OTHER;
        if (i >= ESHOT_FIRST && i < ESHOT_FIRST + ESHOT_COUNT) kind = KIND.ESHOT;
        else if (i >= DIVER_FIRST && i < DIVER_FIRST + FORMATION_SLOTS) kind = KIND.DIVER;
        else if (i >= OBJECT_FIRST && i <= OBJECT_LAST) kind = KIND.OBJECT;
        const o = this.track(i, kind, h, v);
        if (kind === KIND.ESHOT) exactShot(peek, o, i - ESHOT_FIRST);
        w.threats.push(o);
        // Divers and objects can be shot as well (task_shot_hits).
        if (kind === KIND.OBJECT) w.targets.push(o);
      }
    }
    // Shootable formation members (task_shot_hits $D2DD): b0 clear. A
    // member out of the formation (b1) is its flying sprite, already
    // tracked as a threat above -- reuse that record.
    for (let k = 0; k < FORMATION_SLOTS; k += 1) {
      const f = peek(FORMATION_FLAGS + k);
      if ((f & 1) !== 0) continue;
      if ((f & 2) !== 0) {
        const i = DIVER_FIRST + k;
        if (!entryInUse(peek, i)) continue;
        const o = w.threats.find((t) => t.id === i);
        if (o !== undefined) w.targets.push(o);
      } else {
        const h = peek(FORMATION_POS + 2 * k);
        const v = peek(FORMATION_POS + 2 * k + 1);
        w.targets.push(this.track(0x100 + k, KIND.FORMATION, h, v));
      }
    }
  }
}

/**
 * An enemy shot's track is in RAM: sideways speed $1B60+2j (bit 7: left)
 * plus $1B61+2j/256, down 2 and 3 on alternate frames (sub $FA2E).
 * @param {Peek} peek @param {Obj} o @param {number} j shot index 0-6
 */
function exactShot(peek, o, j) {
  const hi = peek(ESHOT_VEL + 2 * j);
  const speed = (hi & 0x7f) + peek(ESHOT_VEL + 2 * j + 1) / 256;
  o.vh = (hi & 0x80) !== 0 ? -speed : speed;
  o.vv = ESHOT_VY;
  o.ah = 0;
  o.av = 0;
  o.exact = true;
}

/** @param {number} d a horizontal difference @returns {number} the short way */
function wrapH(d) {
  if (d > 128) return d - 256;
  if (d < -128) return d + 256;
  return d;
}

/** @param {number} b @returns {number} a byte as signed */
function signed(b) {
  return b >= 0x80 ? b - 0x100 : b;
}

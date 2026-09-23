// Copyright 2026 by Moshix
/**
 * The real ROM, read by read: runs the oracle board through attract mode
 * (title, demo game, challenging-stage demo) and random-input games, and
 * watches every data read the sub CPU makes in $C000-$DFFF. Each read must
 * come from one of the path stepper's four instructions and land on the
 * kind of byte that instruction expects under the format decoded by
 * src/game/sub/gp2_7_paths.js:
 *
 *   $B121  lda ,x       (advance)       a heading or a command byte
 *   $B173  lda ,x       (sub_B163)      a heading
 *   $B13D  lda -1,x     (jump)          the heading just before FF/FE
 *   $B143  ldx 1,x      (jump)          the target word after FF/FE
 *
 * plus the boot checksum at $E02B, which reads every byte once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOracle, randomPlayer } from '../helpers/oracle.mjs';
import {
  GP2_7_START, PATH_JUMP, PATH_JUMP_CLR, gp2_7Streams, gp2_7ByteKinds,
} from '../../src/game/sub/gp2_7.js';
import { subRom } from '../../src/game/romdata.js';

/** @param {number} v @returns {string} */
const hex = (v) => `$${v.toString(16).toUpperCase().padStart(4, '0')}`;

const kinds = gp2_7ByteKinds();
const streams = gp2_7Streams();
/** Stream index of every byte of the chip's path area. */
const owner = new Int16Array(0x2000).fill(-1);
streams.forEach((s, i) => {
  for (let a = s.start; a < s.cmd + 3; a += 1) owner[a - GP2_7_START] = i;
});

/** @param {number} a @returns {string} */
const kindAt = (a) => kinds[a - GP2_7_START];

/**
 * Is a read by instruction `pc` at `a` what the format predicts?
 * @param {number} pc @param {number} a @returns {boolean}
 */
function expected(pc, a) {
  const k = kindAt(a);
  switch (pc) {
    case 0xb121: return k === 'heading' || k === 'cmd';
    case 0xb173: return k === 'heading';
    case 0xb13d: {
      // lda -1,x with X on the FF/FE byte.
      const c = subRom(a + 1);
      return k === 'heading' && kindAt(a + 1) === 'cmd'
        && (c === PATH_JUMP || c === PATH_JUMP_CLR);
    }
    // ldx 1,x reads the high byte at X+1, then the low byte at X+2.
    case 0xb143: return k === 'target';
    default: return false;
  }
}

/**
 * @typedef {object} Session
 * @property {string} name
 * @property {number} frames
 * @property {(b: import('../m6809/board.mjs').Board) => void} setup
 */

/** @typedef {import('../m6809/board.mjs').Board} Board */

/**
 * Coin + start at 300/360, then random play from 370 (seed).
 * @param {Board} b @param {number} seed
 */
function playGame(b, seed) {
  b.tap('coin1', 300);
  b.tap('start1', 360);
  b.inputScript = randomPlayer(seed, { from: 370 });
}

/**
 * Round Advance, as tools/coverage.mjs does it: the DIP on at frame `at`
 * (or the first frame `when` holds), `steps` presses of P1 up 20 frames
 * apart, the DIP off again; the random player is paused meanwhile.
 * @param {Board} b
 * @param {number | ((f: number, b: Board) => boolean)} when
 * @param {number} steps
 */
function roundAdvance(b, when, steps) {
  const prev = b.inputScript;
  let at = typeof when === 'number' ? when : Infinity;
  b.inputScript = (f, bb) => {
    if (at === Infinity && typeof when === 'function' && when(f, bb)) at = f;
    const end = at + 20 + steps * 20;
    if (f === at) bb.setDip('roundAdvance', 0);
    const k = f - at - 10;
    if (k >= 0 && k < steps * 20 && k % 20 === 0) bb.setInput('up', true);
    if (k >= 0 && k < steps * 20 && k % 20 === 8) bb.setInput('up', false);
    if (f === end) bb.setDip('roundAdvance', 8);
    if (f < at || f > end) prev?.(f, bb);
  };
}

/** @type {Session[]} */
const SESSIONS = [
  { name: 'attract with both demos', frames: 6800, setup() {} },
  ...[1, 2, 3].map((seed) => ({
    name: `1P random game, seed ${seed}`,
    frames: 5000,
    /** @param {import('../m6809/board.mjs').Board} b */
    setup(b) { playGame(b, seed); },
  })),
  {
    // The captured-fighter and challenging-stage streams ($D936, $DA09,
    // $DB50, $DC0E, $DD44, $DE08) are stepped here.
    name: 'PARSEC 3 (challenging stage) after the first death',
    frames: 7000,
    setup(b) {
      playGame(b, 4);
      roundAdvance(b, (f, bb) => f > 400 && bb.mem[0x102f] === 0
        && bb.mem[0x1104] === 2, 2);                // game_mode, lives_p1
    },
  },
  {
    name: 'round advance to PARSEC 11, harder DIPs',
    frames: 8000,
    setup(b) {
      b.setDip('difficulty', 0);
      b.setDip('lives', 0);
      b.setDip('bonus', 0);
      playGame(b, 41);
      roundAdvance(b, 460, 10);
    },
  },
  // Later stages: the stage is poked on the first frame of mode 0 after
  // START, before the stage start reads it. (Stage 2, the first
  // challenging stage, is avoided: entered that way it runs from a stale
  // formation_ptr, the ROM quirk of docs/oracle-notes.md section 8.)
  ...[3, 4, 8, 16, 40].map((stage) => ({
    name: `1P game from stage index ${stage}`,
    frames: 2000,
    /** @param {import('../m6809/board.mjs').Board} b */
    setup(b) {
      b.tap('coin1', 300);
      b.tap('start1', 360);
      const player = randomPlayer(stage, { from: 370 });
      let poked = false;
      b.inputScript = (f, bb) => {
        player(f, bb);
        if (!poked && f > 365 && bb.mem[0x102f] === 0) { // game_mode
          bb.mem[0x1106] = stage;                        // stage_p1
          bb.mem[0x1035] = stage;                        // stage
          poked = true;
        }
      };
    },
  })),
];

/**
 * Run one session with a read hook on the sub core.
 * @param {Session} s
 * @returns {{ bad: string[], visited: Set<number>, reads: Map<number, number>,
 *   checksum: number }}
 */
function run(s) {
  const b = makeOracle();
  const cpu = b.cpus[1];
  const proto = Object.getPrototypeOf(cpu);
  /** @type {string[]} */
  const bad = [];
  const visited = new Set();
  /** Reads per reader PC. @type {Map<number, number>} */
  const reads = new Map();
  let checksum = 0;
  // Shadow the core's data-path read (as Board.enableCoverage does): it
  // sees operand and pointer reads, never opcode fetches.
  /** @param {number} addr @returns {number} */
  cpu.rd = function rd(addr) {
    if (addr >= 0xc000 && addr < 0xe000) {
      const pc = this.ppc;
      if (pc === 0xe02b) {
        checksum += 1;
      } else {
        reads.set(pc, (reads.get(pc) ?? 0) + 1);
        if (!expected(pc, addr) && bad.length < 10) {
          bad.push(`${hex(pc)} read ${hex(addr)} (${kindAt(addr)})`);
        }
        if (pc === 0xb173) visited.add(owner[addr - GP2_7_START]);
      }
    }
    return proto.rd.call(this, addr);
  };
  s.setup(b);
  b.runFrames(s.frames);
  return { bad, visited, reads, checksum };
}

const all = new Set();
for (const s of SESSIONS) {
  test(`ROM reads of the paths match the format: ${s.name}`, (t) => {
    const r = run(s);
    assert.deepEqual(r.bad, []);
    // The boot checksum reads the whole chip once.
    assert.equal(r.checksum, 0x2000);
    // Only the stepper reads the chip, and it does read it (a session
    // whose paths all end in F0 never takes the jump reads).
    const pcs = [...r.reads.keys()];
    assert.ok(pcs.includes(0xb121) && pcs.includes(0xb173));
    for (const pc of pcs) {
      assert.ok([0xb121, 0xb13d, 0xb143, 0xb173].includes(pc), hex(pc));
    }
    // Every jump reads its heading once and the target word's two bytes.
    assert.equal(r.reads.get(0xb143) ?? 0, 2 * (r.reads.get(0xb13d) ?? 0));
    for (const i of r.visited) all.add(i);
    t.diagnostic(`${r.visited.size} streams stepped`);
    if (s === SESSIONS[SESSIONS.length - 1]) {
      const miss = streams.filter((_, i) => !all.has(i))
        .map((x) => hex(x.start));
      t.diagnostic(`${all.size} of ${streams.length} streams stepped; never:`);
      // 12 addresses of 6 characters per line: within 79 columns.
      for (let i = 0; i < miss.length; i += 12) {
        t.diagnostic(`  ${miss.slice(i, i + 12).join(' ')}`);
      }
    }
  });
}

test('the sessions step through most streams', () => {
  // Measured: the sessions above step through 32 of the 46 streams (the
  // board is deterministic, so this only changes with the sessions). The
  // rest are attack waves the random player does not live to see; all 46
  // are stepped by the ROM in sub-gp2_7-stepper.test.mjs.
  assert.ok(all.size >= 32, `only ${all.size} streams`);
});

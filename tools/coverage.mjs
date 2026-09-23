// Copyright 2026 by Moshix
/**
 * Code coverage of the real ROMs, measured on the oracle board.
 *
 *   node tools/coverage.mjs [--quick] [--out=DIR]
 *
 * Runs a set of scripted sessions (long attract, several random-input
 * games that die and lose all lives, a two-player cocktail game, the
 * challenging stage and a later stage reached through the Round Advance
 * DIP switch, a high-score name entry, the service/test mode and the
 * operator-statistics DIP) and writes, per CPU,
 *
 *   reference/coverage/{main,sub,sound}.json
 *     { "cpu": "main", "exec": [...], "dataRead": [...] }
 *
 * `exec` = sorted addresses where an instruction started; `dataRead` =
 * sorted ROM addresses read as data (operands through the data path,
 * pointers, vectors -- never opcode or operand fetches), EXCEPT the reads
 * made by the loops that sweep a whole ROM (checksums, the service-mode
 * RAM test that uses $E000-$FFFF as its pattern), which would mark every
 * byte; those instructions are listed in `ignoredReaders`. `dp` maps
 * the executed addresses whose DP differs from the CPU's usual one
 * (main/sub $10, sound $00) to that DP -- the boot code before TFR A,DP
 * -- as { "E000": "00" }; addresses seen with two DPs are left out. The
 * listing generator (tools/gen-listing.mjs) consumes these.
 *
 * It also prints what the sessions measured along the way: the lowest S
 * of each CPU (the stack extents of docs/porting-guide.md 5.3) and the
 * IRQ handler timing per CPU (docs/oracle-notes.md). `--quick` runs every
 * session ten times shorter (a smoke test of the tool itself).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeOracle, randomPlayer } from '../test/helpers/oracle.mjs';
import { CPU_NAME } from '../test/m6809/board.mjs';
import { ROOT } from './romset.mjs';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const outArg = args.find((a) => a.startsWith('--out='));
const OUT = outArg ? outArg.slice(6) : join(ROOT, 'reference/coverage');
/** Session length scale. @param {number} n */
const len = (n) => (quick ? Math.ceil(n / 10) : n);

/** RAM addresses the scripts look at (reference/symbols.json names). */
const GAME_MODE = 0x102f;
const LIVES_P1 = 0x1104;
const SCORE_P1 = 0x09b0;

/** @typedef {import('../test/m6809/board.mjs').Board} Board */

/**
 * Instructions whose data reads sweep a whole ROM ([ROM], listings):
 * main $B743/$B758 (service RAM test, pattern = $E000-$FFFF via -$2000,U),
 * $B865/$B878/$B88B (service ROM checksum of $A000-$FFFF); sub
 * $E018/$E02B/$E03E and sound $E013 (boot checksums, ADDA ,X+).
 * The sound-RAM test at main $B7AC/$B7C1 reads only $E000-$E3BF and is
 * kept.
 */
const IGNORED_READERS = [
  [0xb743, 0xb758, 0xb865, 0xb878, 0xb88b],
  [0xe018, 0xe02b, 0xe03e],
  [0xe013],
];

/**
 * @typedef {object} Session
 * @property {string} name
 * @property {number} frames
 * @property {(b: Board) => void} setup  DIPs, taps, scripts before frame 0
 */

/**
 * Coin + start at power-on + 300/360, then random play (seed).
 * @param {Board} b @param {number} seed @param {number} [from]
 */
function playGame(b, seed, from = 300) {
  b.tap('coin1', from);
  b.tap('start1', from + 60);
  b.inputScript = randomPlayer(seed, { from: from + 70 });
}

/**
 * Round Advance: with the DIP on, the main IRQ loops in round_select
 * ($C163) and each P1 "up" adds one to stage_p1; switching it off
 * resumes. Done after the game has started (game start clears the stage).
 * `when` picks the first frame (a number, or a predicate checked each
 * frame). The random player is paused meanwhile.
 *
 * ROM quirk: advancing straight to a challenging stage as the FIRST stage
 * after power-on corrupts RAM -- the sub's mode-7 code walks
 * formation_ptr ($1086), which only mode 2 ($E1F2) initialises, and ORs
 * $80 into $1000-$10FF. So the challenging-stage session advances after
 * the first life is lost instead.
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
    // One press every 20 frames from at + 10: exactly `steps` presses.
    const k = f - at - 10;
    if (k >= 0 && k < steps * 20 && k % 20 === 0) bb.setInput('up', true);
    if (k >= 0 && k < steps * 20 && k % 20 === 8) bb.setInput('up', false);
    if (f === end) bb.setDip('roundAdvance', 8);
    if (f < at || f > end) prev?.(f, bb);
  };
}

/** @type {Session[]} */
const SESSIONS = [
  {
    name: 'attract (power-on, self test, title, demos)',
    frames: len(20000),
    setup() {},
  },
  ...[1, 2, 3].map((seed) => ({
    name: `1P game, random play seed ${seed}, to game over`,
    frames: len(7000),
    /** @param {Board} b */
    setup(b) { playGame(b, seed); },
  })),
  {
    name: 'coin during the demo, 2P cocktail game',
    frames: len(9000),
    /** @param {Board} b */
    setup(b) {
      b.inputs.in2 = 0x0b;              // IN2 b2 = 0: cocktail cabinet
      b.tap('coin1', 1300);             // during the attract demo
      b.tap('coin2', 1330);
      b.tap('start2', 1400);
      const p1 = randomPlayer(21, { from: 1410 });
      const p2 = randomPlayer(22, { from: 1410 });
      b.inputScript = (f, bb) => {
        p1(f, bb);
        // Player 2's stick and button mirror a second random stream.
        const saved = { ...bb.inputs.p1 };
        const fire = bb.inputs.fire1;
        p2(f, bb);
        Object.assign(bb.inputs.p2, bb.inputs.p1);
        bb.inputs.fire2 = bb.inputs.fire1;
        Object.assign(bb.inputs.p1, saved);
        bb.inputs.fire1 = fire;
      };
    },
  },
  {
    name: 'PARSEC 3 (challenging stage) after the first death',
    frames: len(7000),
    /** @param {Board} b */
    setup(b) {
      playGame(b, 4);
      roundAdvance(b, (f, bb) => f > 400 && bb.mem[GAME_MODE] === 0
        && bb.mem[LIVES_P1] === 2, 2);
    },
  },
  {
    name: 'round advance to PARSEC 11, harder DIPs, 5 lives',
    frames: len(8000),
    /** @param {Board} b */
    setup(b) {
      b.setDip('difficulty', 0);
      b.setDip('lives', 0);
      b.setDip('bonus', 0);
      playGame(b, 41);
      roundAdvance(b, 460, 10);
    },
  },
  {
    name: 'high score: score and lives poked, name entry',
    frames: len(6000),
    /** @param {Board} b */
    setup(b) {
      playGame(b, 4);
      const prev = b.inputScript;
      b.inputScript = (f, bb) => {
        // A poke of the score during play (the only way random input
        // reaches the TOP 5; BCD, least significant byte first), then
        // lives = 1 (the jump in score awards bonus lives). The random
        // stick and fire then drive the name entry.
        if (f === 1300) bb.mem.set([0x00, 0x60, 0x00], SCORE_P1);
        if (f === 1310) bb.mem[LIVES_P1] = 1;
        prev?.(f, bb);
      };
    },
  },
  {
    name: 'service / test mode (DIP SW2:1), inputs exercised',
    frames: len(4000),
    /** @param {Board} b */
    setup(b) {
      b.setDip('serviceMode', 0);
      const names = ['up', 'down', 'left', 'right', 'fire1', 'fire2',
        'start1', 'start2', 'coin1', 'coin2', 'service'];
      for (let i = 0; i < 60; i += 1) {
        b.tap(names[i % names.length], 400 + i * 50, 6);
      }
      b.inputScript = (f, bb) => { if (f === 3600) bb.setDip('serviceMode', 8); };
    },
  },
  {
    name: 'operator stats (SW1:6), demo sounds off, coinage 2C/1C',
    frames: len(4000),
    /** @param {Board} b */
    setup(b) {
      b.setDip('sw1_6', 0);
      b.setDip('demoSounds', 0);
      b.setDip('coinA', 1);
      b.setDip('coinB', 2);
      b.tap('coin1', 1300); b.tap('coin1', 1320);
      b.tap('coin2', 1340); b.tap('service', 1360);
      b.tap('start1', 1420);
      b.inputScript = randomPlayer(61, { from: 1430 });
    },
  },
];

/** Per address: 0, $100 | DP, or $FFFF (several DPs); see Board.coverage. */
const exec = [0, 1, 2].map(() => new Uint16Array(0x10000));
const data = [0, 1, 2].map(() => new Uint8Array(0x10000));
const stackLow = [0xffff, 0xffff, 0xffff];
const t0 = Date.now();
for (const s of SESSIONS) {
  const b = makeOracle();
  b.enableCoverage({ ignoreReaders: IGNORED_READERS });
  b.trackStack = true;
  s.setup(b);
  const t = Date.now();
  b.runFrames(s.frames);
  for (let n = 0; n < 3; n += 1) {
    const cov = /** @type {NonNullable<Board['coverage']>} */ (b.coverage);
    for (let a = 0; a < 0x10000; a += 1) {
      // Merge the DP-tagged execution maps (0 = not run, $FFFF = mixed).
      const o = exec[n][a];
      const v = cov.exec[n][a];
      if (v !== 0 && o !== v) exec[n][a] = o === 0 ? v : 0xffff;
      data[n][a] |= cov.data[n][a];
    }
    stackLow[n] = Math.min(stackLow[n], b.stackLow[n]);
  }
  console.log(`${s.name}`);
  console.log(`  ${s.frames} frames in ${Date.now() - t} ms; mode `
    + `${b.mem[GAME_MODE]}, S low ${b.stackLow.map(hex4).join(' ')}`
    + `${b.watchdogResets ? `, WATCHDOG x${b.watchdogResets}` : ''}`
    + `${b.runawayCount ? `, RUNAWAY x${b.runawayCount}` : ''}`);
  for (let n = 0; n < 3; n += 1) {
    const st = b.irqStats[n];
    const span = st.count === 0 ? 'none'
      : `start ${st.startMin}-${st.startMax} end ${st.endMin}-${st.endMax}`;
    console.log(`  ${CPU_NAME[n].padEnd(5)} irq n=${st.count} ${span} `
      + `over ${st.overruns} lost ${st.lost} odd ${st.abnormal}`);
  }
}

mkdirSync(OUT, { recursive: true });
for (let n = 0; n < 3; n += 1) {
  const list = (/** @type {Uint8Array|Uint16Array} */ m) => {
    const out = [];
    for (let a = 0; a < 0x10000; a += 1) if (m[a]) out.push(a);
    return out;
  };
  const doc = {
    cpu: CPU_NAME[n],
    exec: list(exec[n]),
    dataRead: list(data[n]),
    ignoredReaders: IGNORED_READERS[n],
    /** @type {Record<string, string>} */
    dp: {},
  };
  const usual = n === 2 ? 0x00 : 0x10;
  for (let a = 0; a < 0x10000; a += 1) {
    const v = exec[n][a];
    if (v !== 0 && v !== 0xffff && (v & 0xff) !== usual) {
      doc.dp[a.toString(16).toUpperCase().padStart(4, '0')] =
        (v & 0xff).toString(16).toUpperCase().padStart(2, '0');
    }
  }
  const file = join(OUT, `${CPU_NAME[n]}.json`);
  writeFileSync(file, `${JSON.stringify(doc)}\n`);
  console.log(`${relative(ROOT, file)}: ${doc.exec.length} instructions, `
    + `${doc.dataRead.length} data bytes`);
}
console.log(`lowest S: ${stackLow.map(hex4).join(' ')} `
  + `(${((Date.now() - t0) / 1000).toFixed(1)} s)`);

/** @param {number} v */
function hex4(v) { return `$${v.toString(16).toUpperCase().padStart(4, '0')}`; }

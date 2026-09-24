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
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeOracle } from '../test/helpers/oracle.mjs';
import {
  SESSIONS as SCENARIOS, playGame, newFacts, observe, RAM,
} from '../test/helpers/scenarios.mjs';
import { CPU_NAME } from '../src/emu/board.js';
import { ROOT } from './romset.mjs';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const outArg = args.find((a) => a.startsWith('--out='));
const OUT = outArg ? outArg.slice(6) : join(ROOT, 'reference/coverage');
/** Session length scale. @param {number} n */
const len = (n) => (quick ? Math.ceil(n / 10) : n);

/** @typedef {import('../src/emu/board.js').Board} Board */

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
 * A coverage session: test/helpers/scenarios.mjs's Session, whose goal
 * is optional here (attract and the random games have none).
 * @typedef {object} CovSession
 * @property {string} name
 * @property {number} frames
 * @property {(b: Board) => void} setup  DIPs, taps, scripts before frame 0
 * @property {(f: number, mem: Uint8Array) => void} [pokes]
 * @property {(facts: import('../test/helpers/scenarios.mjs').Facts,
 *   b: Board) => string} [goal]
 */

/**
 * Long attract, three random 1P games to game over, then the sessions
 * of the lockstep scenario test (test/helpers/scenarios.mjs: a 2P
 * cocktail game, the challenging stage, Round Advance to PARSEC 11, a
 * TOP 5 name entry, the service mode, the operator-stats DIP).
 * @type {CovSession[]}
 */
const SESSIONS = [
  {
    name: 'attract (power-on, self test, title, demos)',
    frames: 20000,
    setup() {},
  },
  ...[1, 2, 3].map((seed) => ({
    name: `1P game, random play seed ${seed}, to game over`,
    frames: 7000,
    /** @param {Board} b */
    setup(b) { playGame(b, seed); },
  })),
  SCENARIOS.cocktail2P,
  SCENARIOS.challenging,
  SCENARIOS.parsec11,
  SCENARIOS.hiscore,
  SCENARIOS.service,
  SCENARIOS.operatorStats,
  {
    // Random play dies in PARSEC 1-2: the stage clears, later stages and
    // the challenging stage's full count come from an AI game's inputs
    // (test/oracle/lockstep-ai.test.mjs replays the same log).
    name: 'AI game (tools/ai-lockstep.mjs run 0 log) to PARSEC 9',
    frames: 20000,
    /** @param {Board} b */
    setup(b) {
      const log = JSON.parse(readFileSync(
        join(ROOT, 'test/oracle/data/ai-run0.json'), 'utf8'));
      let next = 0;
      b.inputScript = (f, bb) => {
        while (next < log.changes.length && log.changes[next][0] <= f) {
          const mask = log.changes[next][1];
          /** @type {string[]} */
          const names = log.SWITCHES;
          names.forEach((n, k) => bb.setInput(n, (mask & (1 << k)) !== 0));
          next += 1;
        }
      };
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
  const facts = newFacts();
  const frames = len(s.frames);
  for (let i = 0; i < frames; i += 1) {
    // The pokes go in before the frame's inputs, as in the scenario
    // test (which runs the board's input handling itself).
    s.pokes?.(b.frame, b.mem);
    b.runFrame();
    observe(facts, b);
  }
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
  const miss = quick || !s.goal ? '' : s.goal(facts, b);
  if (miss) console.log(`  NOT REACHED: ${miss}`);
  console.log(`  ${frames} frames in ${Date.now() - t} ms; mode `
    + `${b.mem[RAM.GAME_MODE]}, S low ${b.stackLow.map(hex4).join(' ')}`
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

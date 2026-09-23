// Copyright 2026 by Moshix
/**
 * Run the real ROM (the oracle board) and the JavaScript port side by
 * side from power-on and report where they first disagree -- the
 * diagnosis tool behind test/oracle/lockstep.test.mjs.
 *
 *   node tools/lockstep-run.mjs FRAMES [options] [name@F[-G]] ...
 *
 *   --resync[=N]   copy the ROM's RAM into the port once a difference has
 *                  lasted N frames (default 3); report the runs
 *   --play=SEED    coin at 1500, start at 1600, then a seeded random
 *                  stick and fire button (the same inputs on both sides)
 *   --bridge       run what is not ported on M6809 cores (development
 *                  only, test/helpers/bridge.mjs) and list what ran as ROM
 *   --timing       IRQ handler start/end cycles, ROM vs port, for the
 *                  frames shown
 *   --show=N       differing frames to print (default 5), 8 lines each
 *   --all          do not stop at the first difference
 *   name@F[-G]     hold a switch from frame F to G (default F+4), e.g.
 *                  coin@1200 start@1300 left@2000-2040
 *
 * Every line printed stays within 79 columns.
 */
import { makePortPair, SLOW_STATE } from '../test/helpers/lockstep.mjs';
import { randomPlayer, nameOf } from '../test/helpers/oracle.mjs';
import { portStatus } from '../src/game/port.js';
import { chipReport as mainReport } from '../src/game/main/index.js';
import { chipReport as subReport } from '../src/game/sub/index.js';

const WIDTH = 79;

/** Print one line, cut to the console width. @param {string} s */
const out = (s) => console.log(s.length > WIDTH ? `${s.slice(0, WIDTH - 1)}~` : s);

/**
 * Print words wrapped to the console width.
 * @param {string} head @param {string[]} words
 */
function wrap(head, words) {
  let line = head;
  for (const w of words) {
    if (line.length + 1 + w.length > WIDTH) {
      out(line);
      line = `  ${w}`;
    } else {
      line = line.length ? `${line} ${w}` : w;
    }
  }
  if (line.trim().length) out(line);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  out('usage: node tools/lockstep-run.mjs FRAMES [--resync[=N]]');
  out('         [--play=SEED] [--bridge] [--timing] [--show=N] [--all]');
  out('         [name@F[-G] ...]');
  process.exit(args.length === 0 ? 1 : 0);
}
const frames = Number(args[0]);
/** @param {string} name */
const opt = (name) => args.find((a) => a === name || a.startsWith(`${name}=`));
const resyncArg = opt('--resync');
const resyncAfter = resyncArg === undefined ? undefined
  : Number(resyncArg.split('=')[1] ?? 3);
const playArg = opt('--play');
const bridge = args.includes('--bridge');
const timing = args.includes('--timing');
const all = args.includes('--all') || resyncAfter !== undefined;
const show = Number(opt('--show')?.split('=')[1] ?? 5);

/** @type {Array<[string, number, number]>} switch, from, to */
const holds = [];
for (const a of args) {
  const m = a.match(/^(\w+)@(\d+)(?:-(\d+))?$/);
  if (!m) continue;
  const name = m[1] === 'coin' ? 'coin1' : m[1] === 'start' ? 'start1'
    : m[1] === 'fire' ? 'fire1' : m[1];
  const from = Number(m[2]);
  holds.push([name, from, m[3] ? Number(m[3]) : from + 4]);
}
/** @type {null | ((f: number, b: { setInput: (n: string, d: boolean) => void }) => void)} */
let player = null;
if (playArg) {
  holds.push(['coin1', 1500, 1504], ['start1', 1600, 1604]);
  player = randomPlayer(Number(playArg.split('=')[1] ?? 1) || 1, { from: 1700 });
}

// ------------------------------------------------------------- the run

const status = portStatus();
if (!status.ready) wrap('port:', status.problems);
for (const [cpu, rep] of /** @type {const} */ ([['main', mainReport],
  ['sub', subReport]])) {
  for (const b of rep.broken) out(`${cpu}: ${b.file} does not load: ${b.error}`);
}
let pair;
try {
  pair = makePortPair({ bridge });
} catch (e) {
  out(`cannot start the port: ${e instanceof Error ? e.message : e}`);
  out('(try --bridge to run the missing CPUs on M6809 cores)');
  process.exit(1);
}

/** @type {Array<[number, number, boolean, number]>} frame, cpu, start, cyc */
const irqs = [];
if (timing) {
  pair.board.logIrqs = true;
  const s = pair.port.scheduler;
  s.onIrq = (n, start, tick) => {
    irqs.push([s.frame, n, start, (tick - s.frameStartT) / 5]);
  };
}

/**
 * The first cycle ranges of the IRQ handlers in `frame`, ROM vs port.
 * @param {number} frame
 */
function printTiming(frame) {
  for (const n of [0, 1, 2]) {
    const rom = pair.board.irqLog.find((r) => r.frame === frame && r.cpu === n);
    const ev = irqs.filter((e) => e[0] === frame && e[1] === n);
    const s = ev.find((e) => e[2]);
    const e = ev.find((x) => !x[2]);
    const r = rom ? `${rom.start}-${rom.end}` : '-';
    const p = s && e ? `${s[3]}-${e[3]}` : s ? `${s[3]}-` : '-';
    out(`  irq ${['main ', 'sub  ', 'sound'][n]} rom ${r.padEnd(14)} port ${p}`);
  }
}

const inSlow = (/** @type {number} */ a) => SLOW_STATE.some(([lo, hi]) => a >= lo && a < hi);
let shown = 0;
let run = 0;
let bad = 0;
/** @type {number[]} */
const runs = [];
let resyncs = 0;
let slowBad = 0;
let done = 0;
/** @type {number | null} */
let firstFrameSeen = null;
for (let f = 0; f < frames; f += 1) {
  for (const [name, from, to] of holds) {
    if (f === from) pair.press(name, true);
    if (f === to) pair.press(name, false);
  }
  if (player) player(f, { setInput: (n, d) => pair.press(n, d) });
  let diff;
  try {
    diff = pair.step();
  } catch (e) {
    const st = e instanceof Error ? (e.stack ?? e.message) : String(e);
    out(`frame ${f}: the port threw:`);
    for (const l of st.split('\n').slice(0, 6)) out(`  ${l.trim()}`);
    break;
  }
  done += 1;
  if (diff.length === 0) {
    if (run > 0) runs.push(run);
    run = 0;
    continue;
  }
  bad += 1;
  run += 1;
  firstFrameSeen ??= f;
  if (diff.some((d) => inSlow(d.addr))) slowBad += 1;
  // With --resync, show the first difference, then only those that
  // outlive the resyncs (a logic bug, not a race).
  const notable = resyncAfter === undefined ? true
    : bad === 1 || run === resyncAfter + 3;
  if (notable && shown < show) {
    shown += 1;
    const tag = run > 1 ? ` (for ${run} frames)` : '';
    out(`frame ${f}: ${diff.length}${diff.length >= 64 ? '+' : ''} bytes`
      + ` differ${tag}`);
    for (const d of diff.slice(0, 8)) {
      const n = nameOf(d.addr);
      out(`  $${hex(d.addr, 4)} ${n.padEnd(22)} rom=$${hex(d.expected, 2)}`
        + ` port=$${hex(d.actual, 2)}`);
    }
    if (timing) printTiming(f);
  }
  if (!all) break;
  if (resyncAfter !== undefined && run >= resyncAfter) {
    pair.resync();
    resyncs += 1;
  }
}
if (run > 0) runs.push(run);

// ------------------------------------------------------------- summary

out(`${done} frames compared, ${bad} with differences`
  + (firstFrameSeen === null ? '' : `, first at ${firstFrameSeen}`));
if (resyncAfter !== undefined) {
  const long = runs.filter((r) => r > 1).length;
  out(`runs: ${runs.length}, longer than 1 frame: ${long}, longest `
    + `${Math.max(0, ...runs)}`);
  out(`resyncs: ${resyncs}; frames with slow state differing: ${slowBad}`);
}
if (bridge) {
  const b = pair.bridged();
  for (const c of b.cores) {
    wrap(`${['main', 'sub', 'sound'][c.cpu]} CPU bridged whole, ${c.routines.length}`
      + ' routines ran as ROM:', c.routines);
  }
  if (b.cores.length === 0) out('no CPU bridged whole');
  out(`routine stand-ins installed: ${b.installed}, called: ${b.standIns.length}`);
  wrap('', b.standIns.map(([k, v]) => `${k}x${v}`));
}

/** @param {number} v @param {number} w */
function hex(v, w) {
  return v.toString(16).toUpperCase().padStart(w, '0');
}

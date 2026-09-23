// Copyright 2026 by Moshix
/**
 * Lock-step: two machines stepped frame by frame with identical inputs and
 * compared byte for byte after every frame -- the original ROM on the
 * oracle board (the reference) against a candidate. The candidate will be
 * the JavaScript port (a Machine driven by the port's scheduler); until
 * that exists it is a second oracle board restored from a snapshot of the
 * first, which proves the board is deterministic and that snapshots are
 * complete.
 *
 * SAMPLING POINT. The oracle's runFrame() stops exactly at the next
 * vblank instant, before the IRQs are raised: all three handlers of the
 * frame have finished long before (they end by cycle ~11,000 of 25,344;
 * docs/oracle-notes.md), and the RAM is what MAME's screen update draws.
 * The port's stepFrame() must end at the same point.
 *
 * Every RAM region of the board (RAM_REGIONS: tiles, the three work RAMs,
 * the 15XX registers and the sound RAM) is compared; the S stacks are
 * exempt unless `exempt: []` is passed.
 */
import { makeOracle, diffRamRaw, nameOf, STACK_RANGES, loadState } from './oracle.mjs';
import { Port } from '../../src/game/port.js';
import { mainCpu } from '../../src/game/main/index.js';
import { subCpu } from '../../src/game/sub/index.js';
import { soundCpu } from '../../src/game/sound/index.js';
import { CoreAgent, installRoutineBridge, coreRoutinesRun } from './bridge.mjs';

/** @typedef {import('../m6809/board.mjs').Board} Board */
/** @typedef {import('./oracle.mjs').RamDiff} RamDiff */

/**
 * One side of the comparison.
 * @typedef {object} Side
 * @property {string} name
 * @property {Uint8Array} mem RAM at main-CPU addresses (Machine.mem layout)
 * @property {(input: string, down: boolean) => void} setInput
 * @property {(dip: string, value: number) => void} setDip
 * @property {() => void} stepFrame run one frame, to the sampling point
 * @property {() => number} frame frames completed
 */

/**
 * A board as a lockstep side.
 * @param {Board} board @param {string} [name] @returns {Side}
 */
export function boardSide(board, name = 'oracle') {
  return {
    name,
    mem: board.mem,
    setInput: (input, down) => board.setInput(input, down),
    setDip: (dip, v) => board.setDip(dip, v),
    stepFrame: () => board.runFrame(),
    frame: () => board.frame,
  };
}

/**
 * Per-frame input script shared by both sides: called before each frame
 * with the frame number and a `press(name, down)` that reaches both.
 * @typedef {(frame: number, press: (name: string, down: boolean) => void)
 *   => void} LockstepScript
 */

/**
 * @typedef {object} LockstepReport
 * @property {number} frames          frames compared
 * @property {number} diffFrames      frames with any difference
 * @property {number} longestRun      longest run of consecutive differing frames
 * @property {number | null} firstFrame first differing frame (reference
 *   frame number after the step), or null
 * @property {RamDiff[]} firstDiff    the differences of that frame
 * @property {string[]} firstLines    the same, readable
 */

/**
 * @typedef {object} Pair
 * @property {Side} ref @property {Side} cand
 * @property {(name: string, down: boolean) => void} press same input to both
 * @property {() => RamDiff[]} step one frame each, then the differences
 * @property {(frames: number, opts?: { script?: LockstepScript,
 *   stopAtFirst?: boolean }) => LockstepReport} run
 */

/**
 * Pair two sides.
 * @param {Side} ref the reference (the oracle)
 * @param {Side} cand the candidate (the port, or a second oracle)
 * @param {{ exempt?: ReadonlyArray<readonly [number, number]>,
 *   ignore?: ReadonlyArray<readonly [number, number]> }} [opts]
 * @returns {Pair}
 */
export function makePair(ref, cand, opts = {}) {
  const exempt = opts.exempt ?? STACK_RANGES;
  const diffOpts = { exempt, ignore: opts.ignore ?? [], limit: 64 };
  /** @param {string} name @param {boolean} down */
  const press = (name, down) => {
    ref.setInput(name, down);
    cand.setInput(name, down);
  };
  const step = () => {
    ref.stepFrame();
    cand.stepFrame();
    return diffRamRaw(ref, cand, diffOpts);
  };
  return {
    ref,
    cand,
    press,
    step,
    run(frames, runOpts = {}) {
      /** @type {LockstepReport} */
      const rep = {
        frames: 0, diffFrames: 0, longestRun: 0,
        firstFrame: null, firstDiff: [], firstLines: [],
      };
      let run = 0;
      for (let i = 0; i < frames; i += 1) {
        runOpts.script?.(ref.frame(), press);
        const d = step();
        rep.frames += 1;
        if (d.length === 0) { run = 0; continue; }
        rep.diffFrames += 1;
        run += 1;
        rep.longestRun = Math.max(rep.longestRun, run);
        if (rep.firstFrame === null) {
          rep.firstFrame = ref.frame();
          rep.firstDiff = d;
          rep.firstLines = describe(d, ref.name, cand.name);
          if (runOpts.stopAtFirst) break;
        }
      }
      return rep;
    },
  };
}

/**
 * Readable difference lines ("$1029 attract_timer oracle=$20 port=$40").
 * @param {RamDiff[]} diffs @param {string} [a] @param {string} [b]
 * @returns {string[]}
 */
export function describe(diffs, a = 'oracle', b = 'port') {
  const h = (/** @type {number} */ v, /** @type {number} */ w) =>
    v.toString(16).toUpperCase().padStart(w, '0');
  return diffs.map((d) => {
    const n = nameOf(d.addr);
    return `$${h(d.addr, 4)}${n ? ` ${n}` : ''} ${a}=$${h(d.expected, 2)}`
      + ` ${b}=$${h(d.actual, 2)}`;
  });
}

/**
 * Oracle against oracle: run a reference board (MAME scheduling) to frame
 * `at` with `script`, snapshot it, restore the snapshot into a fresh
 * board built with `candOpts` (the same options by default), and run both
 * in lockstep for `frames` more frames. With identical options the report
 * must be clean (determinism + complete snapshots); with a different
 * quantum it shows which state depends on the CPU interleave.
 * @param {{ at?: number, frames?: number, script?: LockstepScript,
 *   refOpts?: object, candOpts?: object, stopAtFirst?: boolean }} [opts]
 * @returns {LockstepReport & { ref: Board, cand: Board }}
 */
export function oracleVsOracle(opts = {}) {
  const refOpts = opts.refOpts ?? {};
  const ref = makeOracle(refOpts);
  const script = opts.script;
  /** @param {string} name @param {boolean} down */
  const pressRef = (name, down) => ref.setInput(name, down);
  for (let f = ref.frame; f < (opts.at ?? 0); f = ref.frame) {
    script?.(f, pressRef);
    ref.runFrame();
  }
  const cand = makeOracle(opts.candOpts ?? refOpts);
  cand.setState(ref.getState());
  const pair = makePair(boardSide(ref, 'oracle'), boardSide(cand, 'copy'));
  const rep = pair.run(opts.frames ?? 1000, {
    script, stopAtFirst: opts.stopAtFirst,
  });
  return { ...rep, ref, cand };
}

// ------------------------------------------------------------ the port

/**
 * The JavaScript port as a lockstep side.
 * @param {Port} port @param {string} [name] @returns {Side}
 */
export function portSide(port, name = 'port') {
  return {
    name,
    mem: port.mem,
    setInput: (input, down) => port.setInput(input, down),
    setDip: (dip, v) => port.setDip(dip, v),
    stepFrame: () => port.runFrame(),
    frame: () => port.frame,
  };
}

/**
 * State that resync copies only once it has differed for
 * SLOW_RESYNC_AFTER frames: the TOP 5 table, the scores and the high
 * score ($0900-$09B9), lives and stages of both players ($1104-$1107).
 * They change only as the result of game logic, so a lasting difference
 * is a bug that must not be copied away.
 * @type {ReadonlyArray<readonly [number, number]>}
 */
export const SLOW_STATE = Object.freeze([
  Object.freeze([0x0900, 0x09ba]), Object.freeze([0x1104, 0x1108]),
]);

/** Frames slow state may differ before resync copies it too. */
export const SLOW_RESYNC_AFTER = 30;

/**
 * @typedef {object} PortPairOptions
 * @property {boolean} [bridge] run what is not ported on M6809 cores
 *   (test/helpers/bridge.mjs): whole CPUs whose entry points are missing,
 *   and stand-ins for missing routines
 * @property {number[]} [cores] CPUs to run on cores even if ported
 *   (0 main, 1 sub, 2 sound): checks the scheduler's slice engine, and
 *   one CPU's port against the other two as ROM
 * @property {import('../../src/game/scheduler.js').CostTable} [costs]
 * @property {number} [quantum]
 */

/**
 * @typedef {object} PortRunReport
 * @property {number} frames frames run
 * @property {number} diffFrames frames with any difference
 * @property {number} longestRun longest run of differing frames
 * @property {number[]} runs length of every run of differing frames
 * @property {number} resyncs RAM copies made
 * @property {number | null} firstFrame first differing frame, or null
 * @property {string[]} firstLines its differences, readable
 * @property {string | null} threw the port's exception, if it threw
 * @property {number | null} threwAt the frame it threw in
 */

/**
 * The oracle (the real ROM) and the port, both at power-on.
 * @param {PortPairOptions} [opts]
 */
export function makePortPair(opts = {}) {
  const board = makeOracle({ quantum: opts.quantum });
  /** @type {ReturnType<typeof installRoutineBridge> | null} */
  let routines = null;
  /** @type {Array<CoreAgent | undefined>} */
  const agents = [];
  if (opts.bridge) {
    routines = installRoutineBridge();
    [mainCpu, subCpu, soundCpu].forEach((cpu, n) => {
      if (cpu.reset === null || cpu.irq === null) agents[n] = new CoreAgent(n);
    });
  }
  for (const n of opts.cores ?? []) agents[n] = new CoreAgent(n);
  const port = new Port({ agents, costs: opts.costs, quantum: opts.quantum });
  const ref = boardSide(board, 'oracle');
  const cand = portSide(port, 'port');
  const diffOpts = { exempt: STACK_RANGES, limit: 64 };
  let slowFrames = 0;
  /** @param {RamDiff[]} d */
  const slowDiff = (d) => d.some((x) => SLOW_STATE.some(
    ([lo, hi]) => x.addr >= lo && x.addr < hi));
  const pair = {
    board,
    port,
    /** CPUs running on cores (bridged whole). */
    coreCpus: agents.map((a, n) => (a ? n : -1)).filter((n) => n >= 0),
    /** The routine stand-ins (bridge only). */
    routines,
    /** @param {string} name @param {boolean} down */
    press(name, down) {
      ref.setInput(name, down);
      cand.setInput(name, down);
    },
    /** @param {string} name @param {number} v */
    setDip(name, v) {
      ref.setDip(name, v);
      cand.setDip(name, v);
    },
    /** One frame on each side; the differences. @returns {RamDiff[]} */
    step() {
      board.runFrame();
      port.runFrame();
      const d = diffRamRaw(board, port, diffOpts);
      slowFrames = slowDiff(d) ? slowFrames + 1 : 0;
      return d;
    },
    /**
     * Copy the oracle's RAM into the port (not the latches: they could
     * catch the oracle between an acknowledge and its re-enable). Slow
     * state is kept until it has differed SLOW_RESYNC_AFTER frames.
     */
    resync() {
      const keep = SLOW_STATE.map(([lo, hi]) => port.mem.slice(lo, hi));
      loadState(port, board);
      if (slowFrames < SLOW_RESYNC_AFTER) {
        SLOW_STATE.forEach(([lo], i) => port.mem.set(keep[i], lo));
      }
    },
    /**
     * Run frames, optionally resyncing a difference that lasted `after`
     * frames. Stops at the first difference with `stopAtFirst`, and when
     * the port throws (recorded in the report).
     * @param {number} frames
     * @param {{ script?: LockstepScript, resyncAfter?: number,
     *   stopAtFirst?: boolean }} [o]
     * @returns {PortRunReport}
     */
    run(frames, o = {}) {
      /** @type {PortRunReport} */
      const rep = {
        frames: 0, diffFrames: 0, longestRun: 0, runs: [], resyncs: 0,
        firstFrame: null, firstLines: [], threw: null, threwAt: null,
      };
      let run = 0;
      for (let i = 0; i < frames; i += 1) {
        const f = board.frame;
        o.script?.(f, pair.press);
        /** @type {RamDiff[]} */
        let d;
        try {
          d = pair.step();
        } catch (e) {
          rep.threw = e instanceof Error ? (e.stack ?? e.message) : String(e);
          rep.threwAt = f;
          break;
        }
        rep.frames += 1;
        if (d.length === 0) {
          if (run > 0) rep.runs.push(run);
          run = 0;
          continue;
        }
        rep.diffFrames += 1;
        run += 1;
        rep.longestRun = Math.max(rep.longestRun, run);
        if (rep.firstFrame === null) {
          rep.firstFrame = f;
          rep.firstLines = describe(d, 'oracle', 'port');
          if (o.stopAtFirst) break;
        }
        if (o.resyncAfter !== undefined && run >= o.resyncAfter) {
          pair.resync();
          rep.resyncs += 1;
        }
      }
      if (run > 0) rep.runs.push(run);
      return rep;
    },
    /**
     * What ran as ROM: listing routines executed by whole-CPU cores, and
     * routine stand-ins with their call counts.
     * @returns {{ cores: Array<{ cpu: number, routines: string[] }>,
     *   standIns: Array<[string, number]>, installed: number }}
     */
    bridged() {
      const cores = agents.flatMap((a, n) => (a
        ? [{ cpu: n, routines: coreRoutinesRun(a) }] : []));
      const standIns = routines ? [...routines.calls.entries()]
        .sort((x, y) => y[1] - x[1]) : [];
      return { cores, standIns, installed: routines?.installed.size ?? 0 };
    },
  };
  return pair;
}

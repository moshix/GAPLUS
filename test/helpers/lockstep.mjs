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
import { makeOracle, diffRamRaw, nameOf, STACK_RANGES } from './oracle.mjs';

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

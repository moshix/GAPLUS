// Copyright 2026 by Moshix
/**
 * What the page runs, behind one small interface, so the front end
 * (src/main.js) does not care whether the game is the JavaScript port or
 * the real ROM on emulated 6809s:
 *
 *   engine.kind            'rom' | 'port'
 *   engine.label           badge text shown above the screen
 *   engine.supportsAi      the self-playing AI can drive it (the port
 *                          only: the AI reads the port's state)
 *   engine.ready           false while the engine cannot run (see .why)
 *   engine.why             human-readable reason when not ready
 *   engine.runFrame(input) one 1/60.606 s frame; `input` is the page's
 *                          InputState (src/machine/namcoio.js), copied in
 *                          before the frame runs
 *   engine.mem             64 KB main-CPU address space (the renderer's
 *                          input: tiles, sprites, flip bit)
 *   engine.starControl     $A000-$A003 as last written
 *   engine.soundRegs()     the 64 15XX register bytes ($6000-$603F)
 *   engine.soundEnable()   15XX output on (SRESET released)
 *   engine.onBang          set by the host: called with the CPU cycle
 *                          inside the frame when the game fires the
 *                          explosion sample ($6829 >= $0F)
 *   engine.reset()         power-on reset (used by the test switch, whose
 *                          DIP the ROM reads only at boot)
 *
 * Two engines, chosen on the page's start screen (src/ui/chooser.js) or
 * with `?engine=rom|port`:
 *
 *  - `rom` ("ROM"): the test oracle's board, test/m6809/board.mjs --
 *    three MC6809 cores running the original program, fetched from roms/
 *    by src/dev/romfetch.js. The original, not the port, and the page
 *    says so on screen.
 *  - `port` ("JavaScript"): the port, src/game/port.js (the ported
 *    routines on src/game/scheduler.js). It says "port not ready yet"
 *    while a CPU's entry points are missing or a chip module does not
 *    load, and stops (not ready, with the reason) if the port throws.
 *
 * The oracle board's own API lives in docs/oracle-notes.md; everything
 * this file assumes about it is in {@link BoardAdapter}, so an API change
 * there is a change here only.
 */

import { Machine } from './machine/machine.js';
import { fetchRoms, RomFetchError } from './dev/romfetch.js';

/** @typedef {import('./machine/namcoio.js').InputState} InputState */

/** Badge text of each engine. */
export const ROM_LABEL = 'ROM · original program on emulated 6809s';
export const PORT_LABEL = 'JavaScript · routine-by-routine port';

/** Main-CPU address of the 15XX registers, and their count. */
const WSG_BASE = 0x6000;
const WSG_REGS = 0x40;

/** @typedef {'rom'|'port'} EngineKind */

/** Every engine kind, in the chooser's order. @type {readonly EngineKind[]} */
export const ENGINE_KINDS = Object.freeze(/** @type {EngineKind[]} */ (['rom', 'port']));

/**
 * Parse an engine name: `rom` / `port`, plus the aliases `emulated` and
 * `js` / `javascript`. Anything else is null.
 * @param {string | null | undefined} name
 * @returns {EngineKind | null}
 */
export function parseEngineKind(name) {
  const v = String(name ?? '').trim().toLowerCase();
  if (v === 'rom' || v === 'emulated') return 'rom';
  if (v === 'port' || v === 'js' || v === 'javascript') return 'port';
  return null;
}

/**
 * The engine the URL asks for (`?engine=rom|port`), or null when it does
 * not say, in which case the page shows the chooser.
 * @param {string} search location.search
 * @returns {EngineKind | null}
 */
export function engineKindFrom(search) {
  return parseEngineKind(new URLSearchParams(search).get('engine'));
}

/** localStorage key of the last engine chosen. */
export const ENGINE_KEY = 'gaplus.engine.v1';

/**
 * The engine chosen last time, to preselect in the chooser; 'rom' when
 * nothing (valid) is stored or storage is unavailable.
 * @param {Pick<Storage, 'getItem'> | null | undefined} storage
 * @returns {EngineKind}
 */
export function loadEngineChoice(storage) {
  try {
    return parseEngineKind(storage?.getItem(ENGINE_KEY)) ?? 'rom';
  } catch {
    return 'rom';
  }
}

/**
 * Remember the engine chosen. Storage may be missing or throw (privacy
 * modes, full quota); the choice then lasts for this page only.
 * @param {Pick<Storage, 'setItem'> | null | undefined} storage
 * @param {EngineKind} kind
 * @returns {boolean} whether it was stored
 */
export function saveEngineChoice(storage, kind) {
  try {
    if (!storage) return false;
    storage.setItem(ENGINE_KEY, kind);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the page's input state into another one in place (the board keeps
 * its own object, which its I/O chips hold a reference to).
 * @param {InputState} from @param {InputState} to
 */
export function copyInputs(from, to) {
  if (from === to) return;
  to.coin1 = from.coin1;
  to.coin2 = from.coin2;
  to.service = from.service;
  to.start1 = from.start1;
  to.start2 = from.start2;
  to.fire1 = from.fire1;
  to.fire2 = from.fire2;
  Object.assign(to.p1, from.p1);
  Object.assign(to.p2, from.p2);
  Object.assign(to.dips, from.dips);
  to.in2 = from.in2;
}

// ----------------------------------------------------------------- rom

/**
 * Everything the page needs from test/m6809/board.mjs, in one place.
 *
 * Used (test/m6809/board.mjs): `new Board({ roms })`, `runFrame()`,
 * `powerOn()`, `board.mem` (64 KB, main-CPU addresses), `board.inputs`
 * (the live InputState its I/O chips sample), `board.starCtrl`,
 * `board.soundEnable`, `board.wsgRegs` ($6000-$603F) and the
 * `board.onBang(cycle)` hook. The fallbacks below keep the page working
 * if a detail moves (e.g. only `board.machine` has it).
 */
/**
 * The parts of the board's Machine the adapter falls back on.
 * @typedef {object} MachineLike
 * @property {Uint8Array} [mem]
 * @property {ArrayLike<number>} [starCtrl]
 * @property {boolean} [soundEnable]
 * @property {boolean} [sreset]
 * @property {{inputs?: InputState, onBang?: (() => void) | undefined}} [io]
 */
/**
 * What the adapter uses of a Board (all but runFrame optional).
 * @typedef {MachineLike & {
 *   runFrame: () => void,
 *   wsgRegs?: Uint8Array,
 *   inputs?: InputState,
 *   onBang?: ((cycle: number) => void) | null,
 *   setBangHandler?: (fn: (cycle: number) => void) => void,
 *   setInputs?: (input: InputState) => void,
 *   powerOn?: () => void,
 *   machine?: MachineLike,
 * }} BoardLike
 */

export class BoardAdapter {
  /** @param {BoardLike} board a Board instance */
  constructor(board) {
    /** @type {BoardLike} */
    this.board = board;
    /** @type {((cycle: number) => void) | null} */
    this.onBang = null;
    this.hookBang();
  }

  /** The board's Machine-like object (latches, I/O chips). @returns {MachineLike} */
  get machine() { return this.board.machine ?? this.board; }

  /** @returns {Uint8Array} */
  get mem() { return this.board.mem ?? this.machine.mem ?? new Uint8Array(0x10000); }

  /** @returns {ArrayLike<number>} */
  get starControl() { return this.board.starCtrl ?? this.machine.starCtrl ?? [0, 0, 0, 0]; }

  /** The input state the board's I/O chips sample. @returns {InputState|undefined} */
  get inputs() { return this.board.inputs ?? this.machine.io?.inputs; }

  /** Route the 62XX explosion trigger to {@link onBang}. */
  hookBang() {
    /** @param {number} [cycle] */
    const fire = (cycle) => this.onBang?.(cycle ?? 0);
    const io = this.machine.io;
    if (typeof this.board.setBangHandler === 'function') this.board.setBangHandler(fire);
    else if ('onBang' in this.board) this.board.onBang = fire;
    else if (io !== undefined) io.onBang = fire;
  }

  /** @param {InputState} input */
  runFrame(input) {
    if (typeof this.board.setInputs === 'function') this.board.setInputs(input);
    else {
      const inputs = this.inputs;
      if (inputs !== undefined) copyInputs(input, inputs);
    }
    this.board.runFrame();
  }

  /** @returns {ArrayLike<number>} */
  soundRegs() {
    return this.board.wsgRegs ?? this.mem.subarray(WSG_BASE, WSG_BASE + WSG_REGS);
  }

  /** @returns {boolean} */
  soundEnable() {
    if (typeof this.board.soundEnable === 'boolean') return this.board.soundEnable;
    const m = this.machine;
    if (typeof m.soundEnable === 'boolean') return m.soundEnable;
    if (typeof m.sreset === 'boolean') return !m.sreset;
    return true;
  }
}

/** The original program (the real ROM) on the oracle's three 6809 cores. */
export class EmulatedEngine {
  /** @param {BoardAdapter | null} adapter @param {string} [why] */
  constructor(adapter, why = '') {
    this.kind = /** @type {EngineKind} */ ('rom');
    this.label = ROM_LABEL;
    /** The AI reads the port's state; it never drives the ROM. */
    this.supportsAi = false;
    this.adapter = adapter;
    this.ready = adapter !== null;
    this.why = why;
    /** @type {((cycle: number) => void) | null} */
    this.onBang = null;
    /** Kept for {@link reset}. @type {import('./dev/romlayout.js').GaplusRoms | null} */
    this.roms = null;
    /** @type {(new (opts: {roms: unknown}) => BoardLike) | null} */
    this.BoardClass = null;
    this.wireBang();
  }

  /**
   * Fetch the ROMs and build the board. Never throws: a failure gives an
   * engine that is not ready and says why.
   * @param {{romBase?: string, fetch?: import('./dev/romfetch.js').FetchLike,
   *   boardUrl?: string}} [opts]
   * @returns {Promise<EmulatedEngine>}
   */
  static async create(opts = {}) {
    let roms;
    try {
      roms = await fetchRoms({ base: opts.romBase, fetch: opts.fetch });
    } catch (err) {
      return new EmulatedEngine(null, romHelp(err));
    }
    let BoardClass;
    try {
      // Resolved against this module, so the page and the tests agree.
      const url = opts.boardUrl ?? new URL('../test/m6809/board.mjs', import.meta.url).href;
      const mod = await import(url);
      BoardClass = mod.Board ?? mod.default;
      if (typeof BoardClass !== 'function') throw new Error('board.mjs exports no Board');
    } catch (err) {
      return new EmulatedEngine(null,
        `The oracle board (test/m6809/board.mjs) could not be loaded: ${messageOf(err)}`);
    }
    try {
      const engine = new EmulatedEngine(new BoardAdapter(new BoardClass({ roms })));
      engine.roms = roms;
      engine.BoardClass = BoardClass;
      return engine;
    } catch (err) {
      return new EmulatedEngine(null, `The oracle board failed to start: ${messageOf(err)}`);
    }
  }

  /** Forward the board's bang to whatever the host set as onBang. */
  wireBang() {
    if (this.adapter !== null) this.adapter.onBang = (cycle) => this.onBang?.(cycle);
  }

  get mem() { return this.adapter === null ? BLANK : this.adapter.mem; }

  get starControl() { return this.adapter === null ? NO_STARS : this.adapter.starControl; }

  /** @param {InputState} input */
  runFrame(input) { this.adapter?.runFrame(input); }

  soundRegs() { return this.adapter === null ? BLANK.subarray(0, WSG_REGS) : this.adapter.soundRegs(); }

  soundEnable() { return this.adapter !== null && this.adapter.soundEnable(); }

  /** Power-on reset: RAM, latches and CPUs from scratch; inputs are kept. */
  reset() {
    if (this.adapter === null) return;
    if (typeof this.adapter.board.powerOn === 'function') {
      this.adapter.board.powerOn();
      return;
    }
    if (this.roms === null || this.BoardClass === null) return;
    this.adapter = new BoardAdapter(new this.BoardClass({ roms: this.roms }));
    this.wireBang();
  }
}

// ---------------------------------------------------------------- port

/**
 * @typedef {object} PortLike what the engine uses of src/game/port.js
 * @property {Uint8Array} mem @property {Uint8Array} starCtrl
 * @property {Uint8Array} wsgRegs @property {boolean} soundEnable
 * @property {InputState} inputs
 * @property {null | ((cycle: number) => void)} onBang
 * @property {() => void} runFrame @property {() => void} powerOn
 */

/**
 * The JavaScript port (src/game/port.js): the ported routines of the
 * three CPUs on the port's scheduler. Ready when every CPU's entry points
 * are ported and every chip module loads (`portStatus()`); otherwise it
 * owns a blank Machine and says what is missing. If the port throws while
 * running (a porting bug), it stops, is no longer ready and says why.
 */
export class PortEngine {
  /**
   * @param {PortLike | null} [port] the running port, or null
   * @param {string} [why] why there is none
   */
  constructor(port = null, why = 'port not ready yet — play the ROM version') {
    this.kind = /** @type {EngineKind} */ ('port');
    this.label = PORT_LABEL;
    this.supportsAi = true;
    /** The self-playing AI's switch; the AI itself is still to be built. */
    this.aiEnabled = false;
    /** @type {PortLike | null} */
    this.port = port;
    /** A blank board to draw while there is no port. */
    this.machine = new Machine();
    this.ready = port !== null;
    this.why = port !== null ? '' : why;
    /** @type {((cycle: number) => void) | null} */
    this.onBang = null;
    if (port !== null) port.onBang = (cycle) => this.onBang?.(cycle);
    this.machine.io.onBang = () => this.onBang?.(0);
  }

  /**
   * Load the port and power it on. Never throws: a port that cannot run
   * gives an engine that is not ready and says why.
   * @returns {Promise<PortEngine>}
   */
  static async create() {
    try {
      const mod = await import('./game/port.js');
      const status = mod.portStatus();
      if (!status.ready) {
        return new PortEngine(null, 'port not ready yet ('
          + `${status.problems[0]}) — play the ROM version`);
      }
      return new PortEngine(new mod.Port());
    } catch (err) {
      return new PortEngine(null,
        `port not ready yet (${messageOf(err)}) — play the ROM version`);
    }
  }

  get mem() { return this.port?.mem ?? this.machine.mem; }

  get starControl() { return this.port?.starCtrl ?? this.machine.starCtrl; }

  /** @param {InputState} input */
  runFrame(input) {
    const port = this.port;
    if (port === null || !this.ready) {
      copyInputs(input, this.machine.io.inputs);
      return;
    }
    copyInputs(input, port.inputs);
    try {
      port.runFrame();
    } catch (err) {
      // A porting bug: stop here rather than run on from broken state.
      this.ready = false;
      this.why = `port stopped: ${messageOf(err)} — play the ROM version`;
    }
  }

  soundRegs() {
    return this.port?.wsgRegs ?? this.machine.mem.subarray(WSG_BASE, WSG_BASE + WSG_REGS);
  }

  soundEnable() { return this.port?.soundEnable ?? this.machine.soundEnable; }

  /** Power-on reset: RAM, latches and CPUs from scratch; inputs are kept. */
  reset() {
    if (this.port === null) { this.machine.reset(); return; }
    this.port.powerOn();
    this.ready = true;
    this.why = '';
  }
}

/**
 * Build the engine of the given kind. Never throws; check `.ready`.
 * @param {EngineKind} kind
 * @param {Parameters<typeof EmulatedEngine.create>[0]} [opts]
 * @returns {Promise<EmulatedEngine | PortEngine>}
 */
export async function createEngine(kind, opts = {}) {
  if (kind === 'port') return PortEngine.create();
  return EmulatedEngine.create(opts);
}

// ------------------------------------------------------------- helpers

/** What an engine that is not ready draws: all zero. */
const BLANK = new Uint8Array(0x10000);
const NO_STARS = new Uint8Array(4);

/** @param {unknown} err @returns {string} */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The on-screen explanation when the ROMs cannot be had.
 * @param {unknown} err @returns {string}
 */
export function romHelp(err) {
  if (err instanceof RomFetchError) {
    return `${err.message}. The ROM version runs the original program: put the `
      + '20 files of the MAME "gaplus" set in roms/ and serve the project root '
      + '(python3.11 -m http.server 8000).';
  }
  return `The ROM set in roms/ is not usable: ${messageOf(err)}`;
}

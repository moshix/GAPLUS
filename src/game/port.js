// Copyright 2026 by Moshix
/**
 * The JavaScript port as one object: a Machine, the three CPUs' ported
 * code and the scheduler, behind the same front-end API as the oracle's
 * Board (src/emu/board.js), so src/engine.js drives either the same
 * way and lockstep tests treat them alike:
 *
 *   port.runFrame()        one frame: vblank, handlers, foregrounds, up to
 *                          the next vblank instant (Board.runFrame's stop)
 *   port.mem               all RAM at main-CPU addresses (renderer input)
 *   port.starCtrl          $A000-$A003 as last written
 *   port.wsgRegs           the 15XX registers ($6000-$603F)
 *   port.soundEnable       15XX output on (SRESET released)
 *   port.onBang(cycle)     the 62XX explosion trigger (set by the host)
 *   port.inputs            the live InputState the I/O chips sample
 *   port.setInput / setDip / powerOn / frame / machine
 *
 * A CPU whose entry points are not ported (src/game/<cpu>/index.js gives
 * null) cannot run: the constructor throws, unless the caller supplies an
 * agent for it (`agents`; tests use test/helpers/bridge.mjs). The browser
 * never does: {@link portStatus} says whether the port can run at all.
 */

import { Machine } from '../machine/machine.js';
import { Scheduler } from './scheduler.js';
import { mainCpu, chipReport as mainReport } from './main/index.js';
import { subCpu, chipReport as subReport } from './sub/index.js';
import { soundCpu } from './sound/index.js';

/** @typedef {import('./scheduler.js').Agent} Agent */
/** @typedef {import('../machine/namcoio.js').InputState} InputState */

/**
 * Can the port run on its own (no bridge)? Lists what is missing: CPU
 * entry points not ported, chip modules missing or failing to load.
 * @returns {{ ready: boolean, problems: string[] }}
 */
export function portStatus() {
  /** @type {string[]} */
  const problems = [];
  for (const [name, cpu] of /** @type {const} */ ([['main', mainCpu],
    ['sub', subCpu], ['sound', soundCpu]])) {
    if (cpu.reset === null) problems.push(`${name}: reset not ported`);
    if (cpu.irq === null) problems.push(`${name}: IRQ not ported`);
  }
  for (const [name, rep] of /** @type {const} */ ([['main', mainReport],
    ['sub', subReport]])) {
    for (const f of rep.missing) problems.push(`${name}: ${f} missing`);
    for (const b of rep.broken) {
      problems.push(`${name}: ${b.file} fails to load (${b.error})`);
    }
  }
  return { ready: problems.length === 0, problems };
}

/**
 * @typedef {object} PortOptions
 * @property {Array<Agent | null | undefined>} [agents] per CPU, an agent
 *   instead of the ported code (tests: the fallback bridge)
 * @property {number} [quantum] slice length in cycles (default 256)
 */

export class Port {
  /** @param {PortOptions} [opts] */
  constructor(opts = {}) {
    /** The board as the ported code sees it. */
    this.machine = new Machine();
    /** All RAM in main-CPU addresses. */
    this.mem = this.machine.mem;
    /** The 15XX register image ($6000-$603F). */
    this.wsgRegs = this.mem.subarray(0x6000, 0x6040);
    /**
     * The 62XX explosion trigger, with the cycle within the frame.
     * @type {null | ((cycle: number) => void)}
     */
    this.onBang = null;
    /** Bang triggers during the frame just run. */
    this.bangs = 0;
    this.machine.io.onBang = () => {
      this.bangs += 1;
      // The cycle of the write itself, as the ROM engine reports it.
      this.onBang?.(this.scheduler.accessCycle());
    };
    for (const [n, cpu] of /** @type {const} */ ([[0, mainCpu],
      [1, subCpu], [2, soundCpu]])) {
      if (opts.agents?.[n]) continue;
      if (cpu.reset === null || cpu.irq === null) {
        throw new Error(`${['main', 'sub', 'sound'][n]} CPU is not ported `
          + '(entry points missing)');
      }
    }
    /** The scheduler (powers the board on). */
    this.scheduler = new Scheduler(this.machine,
      { main: mainCpu, sub: subCpu, sound: soundCpu },
      { agents: opts.agents, quantum: opts.quantum });
  }

  /** Frames completed. */
  get frame() { return this.scheduler.frame; }

  /** @returns {Uint8Array} $A000-$A003 as last written */
  get starCtrl() { return this.machine.starCtrl; }

  /** @returns {boolean} 15XX output on (SRESET released) */
  get soundEnable() { return this.machine.soundEnable; }

  /** @returns {InputState} the live input state */
  get inputs() { return this.machine.io.inputs; }

  /** Watchdog firings (never on a good run). */
  get watchdogResets() { return this.scheduler.watchdogResets; }

  /** One frame, to the next vblank instant. */
  runFrame() {
    this.bangs = 0;
    this.scheduler.runFrame();
  }

  /** @param {number} n */
  runFrames(n) {
    for (let i = 0; i < n; i += 1) this.runFrame();
  }

  /** Power-on: RAM, latches, CPUs from scratch; inputs are kept. */
  powerOn() { this.scheduler.powerOn(); }

  /**
   * Press or release a switch (Machine.setInput names).
   * @param {string} name @param {boolean} down
   */
  setInput(name, down) { this.machine.setInput(name, down); }

  /** @param {string} name DIP field @param {number} value */
  setDip(name, value) {
    this.machine.setDip(/** @type {'lives'} */ (name), value);
  }
}

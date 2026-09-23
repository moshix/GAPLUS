// Copyright 2026 by Moshix
/**
 * The fallback bridge: runs ROM routines that are not ported yet on an
 * MC6809 core (test/m6809/m6809.mjs) against the PORT's Machine memory,
 * so the lockstep harness can run the port from power-on while the chip
 * porters are still at work, and report how much of it is still ROM.
 *
 * DEVELOPMENT ONLY. It lives under test/ (the core and the ROM images
 * never ship to the browser) and is used only when a test or tool asks
 * for it explicitly (test/helpers/lockstep.mjs `bridge: true`,
 * tools/lockstep-run.mjs --bridge). Nothing in src/ depends on it:
 * src/game/port.js refuses to start a CPU whose entry points are
 * missing unless the caller passes an agent for it.
 *
 * Two levels:
 *
 *  - {@link CoreAgent}: a whole CPU on a core, for a CPU whose entry
 *    points (reset / IRQ) are not ported. It is a scheduler agent
 *    (src/game/scheduler.js), stepping the core exactly as the oracle's
 *    Board.execute does, with the same slices, IRQ lines, I/O-run
 *    catch-up and slice aborts, so a fully bridged board matches the
 *    oracle cycle for cycle.
 *
 *  - {@link installRoutineBridge}: every routine of the listings (the
 *    `; name  ($XXXX)` headers) that is missing from MAIN/SUB/SOUND and
 *    their `*_AT` tables gets a stand-in that runs the ROM routine on a
 *    scratch core over the port's RAM until it returns (RTS to the
 *    pushed return address; a task that jumps back to its dispatcher,
 *    main $FEB5 / sub $E0EC, counts as returning). It returns every
 *    register and flag. Its cycles are charged to the CPU (main: through
 *    the foreground clock, src/game/clock.js burn(), when the caller
 *    runs it as a generator; the stand-in is both a result object and a
 *    generator, so plain and `yield* call(...)` callers both work).
 *    A routine that waits (CWAI/SYNC) or runs away cannot be bridged
 *    this way and throws.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { M6809, CC_I, CC_F } from '../m6809/m6809.mjs';
import { roms, DEFAULT_DP } from './oracle.mjs';
import { ROOT } from '../../tools/romset.mjs';
import { STACKS } from '../../src/machine/machine.js';
import { TICKS_PER_CYCLE } from '../../src/game/scheduler.js';
import { burn } from '../../src/game/clock.js';
import { MAIN, MAIN_AT } from '../../src/game/main/routines.js';
import { SUB, SUB_AT } from '../../src/game/sub/routines.js';
import { SOUND, SOUND_AT } from '../../src/game/sound/routines.js';

/** @typedef {import('../../src/game/scheduler.js').Scheduler} Scheduler */
/** @typedef {import('../../src/machine/machine.js').Machine} Machine */

/** CPU names by number. */
const NAMES = /** @type {const} */ (['main', 'sub', 'sound']);
/** First address of each CPU's ROM. */
const ROM_START = [0xa000, 0xa000, 0xe000];

/** The core images (64 KB address spaces) by CPU number. */
function images() {
  const r = roms();
  return [r.main, r.sub, r.sound];
}

// ------------------------------------------------------------ CoreAgent

/**
 * A whole CPU on an M6809 core, as a scheduler agent.
 */
export class CoreAgent {
  /** @param {number} n CPU number */
  constructor(n) {
    this.n = n;
    this.local = 0;
    this.running = false;
    /** @type {Scheduler | null} */
    this.sched = null;
    /** Tick at which the current instruction began. */
    this.stepT = 0;
    /** Instruction addresses executed (coverage for the report). */
    this.exec = new Uint8Array(0x10000);
    const rom = images()[n];
    const start = ROM_START[n];
    this.core = new M6809({
      read: (a) => {
        if (a >= start) return rom[a];
        const s = this.s;
        if (n === 0 && a >= 0x6800 && a < 0x6820) s.ioCatchUp(this.now());
        return s.m.busRead(n, a);
      },
      write: (a, v) => {
        const s = this.s;
        if (n === 0 && a >= 0x6800 && a < 0x6820) s.ioCatchUp(this.now());
        s.m.busWrite(n, a, v);
        // A mask-off write drops the line at once (MAME CLEAR_LINE).
        if (!s.m.irqLine[n]) this.core.irqLine = false;
      },
    });
    const exec = this.exec;
    this.core.trace = (pc) => { exec[pc] = 1; };
  }

  /** @param {Scheduler} s */
  attach(s) { this.sched = s; }

  /** @returns {Scheduler} */
  get s() {
    if (this.sched === null) throw new Error('agent not attached');
    return this.sched;
  }

  /** @param {number} t */
  start(t) {
    const c = this.core;
    c.irqLine = false;
    this.running = true;
    this.local = t + c.reset() * TICKS_PER_CYCLE;
  }

  hold() { this.running = false; }

  /** The vblank: the core's line follows the Machine's. */
  vblank() { this.core.irqLine = this.s.m.irqLine[this.n]; }

  /** @returns {number} the tick of the bus access in progress */
  now() { return this.stepT + this.core.cyc * TICKS_PER_CYCLE; }

  /** @returns {string} */
  describe() {
    return `${NAMES[this.n]} core pc=$${this.core.pc.toString(16)}`;
  }

  /**
   * Run whole instructions until at least `target` (Board.execute).
   * @param {number} target
   */
  runTo(target) {
    const s = this.s;
    const m = s.m;
    const c = this.core;
    const n = this.n;
    const cycles = Math.floor((target - this.local) / TICKS_PER_CYCLE);
    const base = this.local;
    let done = 0;
    s.current = n;
    try {
      while (done < cycles) {
        c.irqLine = m.irqLine[n];
        if (c.wait !== 0 && !c.canWake()) {
          c.cycles += cycles - done;
          done = cycles;
          break;
        }
        this.stepT = base + done * TICKS_PER_CYCLE;
        done += c.step();
        m.iMask[n] = (c.cc & CC_I) !== 0;
        if (c.pc < ROM_START[n]) {
          throw new Error(`${NAMES[n]} core ran away to $${c.pc.toString(16)}`);
        }
        if (s.abort) break;
      }
    } finally {
      s.current = -1;
    }
    this.local = base + done * TICKS_PER_CYCLE;
  }
}

// ------------------------------------------------------ routine bridge

/**
 * @typedef {object} ListingRoutine
 * @property {string} name @property {number} addr
 */

/** @type {Map<string, ListingRoutine[]>} */
const LISTED = new Map();

/**
 * The routines of a CPU's listing: its `; name  ($XXXX)` headers.
 * @param {'main'|'sub'|'sound'} cpu @returns {ListingRoutine[]}
 */
export function listedRoutines(cpu) {
  let list = LISTED.get(cpu);
  if (list) return list;
  const text = readFileSync(join(ROOT, `reference/gaplus-${cpu}.asm`), 'utf8');
  list = [];
  for (const m of text.matchAll(/^; (\w+)\s+\(\$([0-9A-F]{4})\)\s*$/gm)) {
    list.push({ name: m[1], addr: parseInt(m[2], 16) });
  }
  LISTED.set(cpu, list);
  return list;
}

/** Registries by CPU number. */
const REG = [[MAIN, MAIN_AT], [SUB, SUB_AT], [SOUND, SOUND_AT]];

/** Where a task's `JMP <dispatcher>` counts as its return. */
const DISPATCHER = [0xfeb5, 0xe0ec, -1];

/** Return address the stand-ins push ($4000: never code). */
const SENTINEL = 0x4000;

/**
 * @typedef {object} BridgeReport
 * @property {Map<string, number>} installed name -> address, per CPU
 *   prefixed ("main:sub_C2FC")
 * @property {Map<string, number>} calls stand-in name -> calls made
 * @property {() => void} uninstall remove the stand-ins again
 */

/**
 * Fill the registries with stand-ins for every listed routine that is
 * not ported (see the file header).
 * @param {{ cpus?: Array<'main'|'sub'|'sound'> }} [opts]
 * @returns {BridgeReport}
 */
export function installRoutineBridge(opts = {}) {
  /** @type {Map<string, number>} */
  const installed = new Map();
  /** @type {Map<string, number>} */
  const calls = new Map();
  /** @type {Array<() => void>} */
  const undo = [];
  const cpus = opts.cpus ?? ['main', 'sub', 'sound'];
  for (const cpu of cpus) {
    const n = NAMES.indexOf(cpu);
    const [byName, byAddr] = REG[n];
    for (const r of listedRoutines(cpu)) {
      if (byAddr[r.addr] !== undefined || byName[r.name] !== undefined) continue;
      const key = `${cpu}:${r.name}`;
      const fn = standIn(n, r.addr, key, calls);
      byAddr[r.addr] = fn;
      byName[r.name] = fn;
      installed.set(key, r.addr);
      undo.push(() => {
        if (byAddr[r.addr] === fn) delete byAddr[r.addr];
        if (byName[r.name] === fn) delete byName[r.name];
      });
    }
  }
  return {
    installed,
    calls,
    uninstall: () => { for (const u of undo) u(); },
  };
}

/**
 * A stand-in for one ROM routine (what installRoutineBridge registers),
 * for tests and tools.
 * @param {'main'|'sub'|'sound'} cpu @param {number} addr
 * @returns {Function}
 */
export function bridgeRoutine(cpu, addr) {
  return standIn(NAMES.indexOf(cpu), addr, `${cpu}:$${addr.toString(16)}`,
    new Map());
}

/** One scratch core per CPU, rebound to the machine at each call. */
const SCRATCH = /** @type {Array<{ core: M6809, m: Machine | null }>} */ ([]);

/**
 * The scratch core of CPU n, reading ROM from the image and everything
 * else through the port Machine's bus for that CPU.
 * @param {number} n @param {Machine} m
 */
function scratch(n, m) {
  let e = SCRATCH[n];
  if (e === undefined) {
    const rom = images()[n];
    const start = ROM_START[n];
    /** @type {{ core: M6809, m: Machine | null }} */
    const entry = { core: /** @type {M6809} */ (/** @type {unknown} */ (null)), m: null };
    entry.core = new M6809({
      read: (a) => (a >= start ? rom[a]
        : /** @type {Machine} */ (entry.m).busRead(n, a)),
      write: (a, v) => /** @type {Machine} */ (entry.m).busWrite(n, a, v),
    });
    SCRATCH[n] = entry;
    e = entry;
  }
  e.m = m;
  return e.core;
}

/**
 * The stand-in for ROM routine `addr` of CPU n.
 * @param {number} n @param {number} addr @param {string} key
 * @param {Map<string, number>} calls
 * @returns {Function}
 */
function standIn(n, addr, key, calls) {
  const top = [STACKS.main.top, STACKS.sub.top, STACKS.sound.top][n];
  const hex = addr.toString(16).toUpperCase().padStart(4, '0');
  /**
   * @param {Machine} m
   * @param {{ a?: number, b?: number, d?: number, x?: number, y?: number,
   *   u?: number, cc?: number, pc?: number }} [regs]
   */
  return function bridged(m, regs = {}) {
    calls.set(key, (calls.get(key) ?? 0) + 1);
    const c = scratch(n, m);
    c.setState({
      a: regs.a ?? 0, b: regs.b ?? 0, x: regs.x ?? 0, y: regs.y ?? 0,
      u: regs.u ?? 0, dp: DEFAULT_DP[n], cc: (regs.cc ?? 0) | CC_I | CC_F,
      pc: addr, s: top, wait: 0, irqLine: false,
    });
    if (regs.d !== undefined) c.d = regs.d;
    // The return address: the caller's inline-data pointer, or the
    // sentinel. JSR pushes the low byte at S-1, then the high byte.
    const ret = regs.pc ?? SENTINEL;
    const view = m.cpuView(NAMES[n]);
    view.poke((top - 1) & 0xffff, ret & 0xff);
    view.poke((top - 2) & 0xffff, ret >> 8);
    c.s = (top - 2) & 0xffff;
    let cycles = 0;
    for (;;) {
      if (c.s === top || (c.pc === DISPATCHER[n] && c.pc !== addr)) break;
      cycles += c.step();
      if (c.wait !== 0) {
        throw new Error(`bridge ${key} ($${hex}) waits (CWAI/SYNC) at `
          + `$${c.ppc.toString(16)}: port it`);
      }
      if (cycles > 5_000_000) {
        throw new Error(`bridge ${key} ($${hex}) did not return`);
      }
    }
    const cc = c.cc;
    const result = {
      a: c.a, b: c.b, d: c.d, x: c.x, y: c.y, u: c.u, cc, pc: c.pc,
      cf: (cc & 1) !== 0, vf: (cc & 2) !== 0, zf: (cc & 4) !== 0,
      nf: (cc & 8) !== 0, hf: (cc & 0x20) !== 0, cycles,
    };
    if (n !== 0) {
      view.charge(cycles);
      return result;
    }
    // Main: a result that is also a generator burning the cycles on the
    // foreground clock, for `yield* call(...)` callers.
    const g = (function* spend() {
      yield* burn(m, cycles);
      return result;
    })();
    return Object.assign(g, result);
  };
}

// -------------------------------------------------------------- report

/**
 * Listing routines whose entry a CoreAgent executed (what really ran as
 * ROM on a bridged CPU), as "name" strings.
 * @param {CoreAgent} agent @returns {string[]}
 */
export function coreRoutinesRun(agent) {
  const cpu = NAMES[agent.n];
  return listedRoutines(cpu).filter((r) => agent.exec[r.addr]).map((r) => r.name);
}

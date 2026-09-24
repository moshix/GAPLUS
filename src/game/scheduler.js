// Copyright 2026 by Moshix
/**
 * Runs the three ported CPUs, frame by frame, the way the board does.
 *
 * On the board three MC6809Es run in parallel on shared RAM; MAME (and
 * the oracle, src/emu/board.js) interleaves them in time slices of
 * at most 256 cycles, cut at every timer, running main, then sub, then
 * sound to the end of each slice. The programs race through shared RAM
 * (docs/oracle-notes.md section 3), so the port keeps the same model:
 *
 *   THE CLOCK. Every CPU has a local time in ticks (1/5 cycle, like the
 *   oracle, so the I/O run at vblank + 76.8 cycles is exact). A frame is
 *   25,344 cycles from one vblank to the next; slices are cut at the
 *   vblank, at the 56XX/58XX run, and every `quantum` cycles.
 *
 *   AGENTS. Each CPU is driven by an agent that runs it "to the end of
 *   the slice". The shipping agent, {@link JsAgent}, resumes the CPU's
 *   JavaScript threads (the foreground generator and, while one runs,
 *   the IRQ handler) while the CPU's local time is inside the slice. A
 *   JS chunk (the code between two yields) is atomic: it happens at the
 *   CPU time where it starts, and afterwards the local time moves on by
 *   what the chunk cost (below). Tests and tools may pass other agents
 *   (test/helpers/bridge.mjs runs a CPU whose routines are not ported
 *   yet on an M6809 core); this file never imports them.
 *
 *   WHAT A CHUNK COSTS. (1) The cycles the code charged (`m.charge`,
 *   `m.sub.charge`, `m.sound.charge`): ported code counts the 6809's
 *   cycles instruction by instruction, checked against the oracle's
 *   core in its tests (every chip; the boot's clock, src/game/clock.js,
 *   charges too). One `charge()` call per instruction: each call marks
 *   an instruction boundary, which is where an IRQ can enter a chunk
 *   that runs across the vblank, and where an emulated core would stop
 *   at a slice's end (both decide the slice grid, hence the races).
 *   (2) Nothing else: a chunk that charged nothing takes no time.
 *
 *   So the order in which two CPUs' chunks run, and hence who wins a
 *   race through shared RAM, follows their clocks, with MAME's main ->
 *   sub -> sound order inside a slice. It is exact when the code follows
 *   src/game/timing.js: the full port matches the oracle byte for byte
 *   over 20,000 frames of attract and of played games
 *   (test/oracle/lockstep.test.mjs, lockstep-scenarios.test.mjs).
 *
 * YIELD VOCABULARY (for ported code)
 *
 *   yield            the CPU waits for the next frame: CWAI #$EF, or a
 *                    loop that only an IRQ (or a frame's time) ends. The
 *                    thread sleeps until the next vblank; if the IRQ is
 *                    taken then, the handler runs first (CWAI wake-up,
 *                    4 cycles).
 *   yield SYNC       "I charged time, and what follows may be seen by
 *                    another CPU": resumed once the CPU's clock is inside
 *                    a slice again. Code that charges exact cycles yields
 *                    SYNC right before each shared-RAM access (and any
 *                    access once {@link frameDue}).
 *   yield pollAgain(c...)  a failed, charged pass of a poll loop whose
 *                    instructions take c... cycles (the read first): the
 *                    loop keeps its phase, the next read happens where
 *                    the 6809's does (src/game/timing.js poll()).
 *   yield BUSY       as SYNC (busy loops charge each pass).
 *   yield SPIN       a poll loop waiting for another CPU, re-read once
 *   yield RENDEZVOUS per slice at the slice's start (the phase is lost:
 *                    only the main boot's handshakes still use them, and
 *                    their end is re-aligned with setClock).
 *   yield idle(p)    the CPU loops forever without effect in a loop of
 *                    p cycles (the sound CPU's BRA * at $E053). The
 *                    thread is never resumed; the clock runs on in steps
 *                    of p, so an IRQ enters exactly where the 6809 would.
 *   return NO_RTI    (IRQ handler) it left through a jump, not RTI.
 *
 * SPIN, RENDEZVOUS, BUSY, SYNC and NO_RTI are registered symbols
 * (`Symbol.for('gaplus.SPIN')`, `'gaplus.rendezvous'`, `'gaplus.busy'`,
 * `'gaplus.sync'`, `'gaplus.noRti'`), so chip modules may define them
 * without importing this file.
 *
 * INTERRUPTS. At vblank the Machine raises the lines of the CPUs whose
 * mask latch is set (m.vblank()). A JsAgent takes the IRQ at the first
 * point where its thread is suspended and CC.I is clear (m.iMask):
 * the handler generator (or plain function) runs as the CPU's top
 * thread; its return is the RTI (CC.I clear again). A foreground that
 * calls m.cli() with an IRQ pending gets it at its next yield. A handler
 * that runs past the next vblank with its mask off loses that vblank,
 * as on the board (there is no pending latch).
 *
 * THE 56XX/58XX RUN. MAME runs the I/O chips 76.8 cycles after vblank.
 * The port does the same: the run is delivered before the first main-CPU
 * access to the chips at or after that instant (the ported main CPU's
 * charged cycles give that time), else at the end of that slice, exactly
 * as the oracle's Board does.
 *
 * BOOT, RESETS, WATCHDOG. Power-on starts the main CPU; the sub and
 * sound CPUs stay held until the main CPU releases SRESET ($8400), then
 * restart from their reset vectors where that STA ends (MAME's
 * synchronize point), applied when the slice ends. A write that changes
 * an IRQ line or SRESET ends the writer's slice there, as in MAME, and
 * the CPUs after it run only up to the writer's time. The watchdog (3 s
 * after the last kick) soft-resets the board as MAME does; on a good run
 * it never fires.
 *
 * WHAT THE PORT CANNOT FOLLOW. The ported code keeps no CPU registers
 * and writes no stack frames, return addresses or pushes, so the S
 * stacks are not compared (machine.js STACKS). If the sub CPU writes
 * into the main CPU's stack, the ROM's next RTI may pop a return address
 * the port does not have (Round Advance straight into a challenging
 * stage: docs/oracle-notes.md section 8). The main CPU's next RTI then
 * throws {@link RomQuirk} instead of silently going on.
 */

import {
  CPU, CYCLES_PER_FRAME, CPU_CLOCK, STACKS,
} from '../machine/machine.js';
import { isGenerator } from './call.js';
import { bindClock } from './clock.js';

/** @typedef {import('../machine/machine.js').Machine} Machine */
/** @typedef {Generator<unknown, unknown, unknown>} Thread */

export { CYCLES_PER_FRAME };

/**
 * Yielded by a poll loop that waits for another CPU's foreground (the
 * $11/$22 boot handshakes). A registered symbol: the porters' modules
 * use `Symbol.for('gaplus.SPIN')` without importing this file.
 */
export const SPIN = Symbol.for('gaplus.SPIN');

/**
 * Yielded by an IRQ handler polling the other CPU's handler (the
 * frame_sync $10AF rendezvous of irq_main / irq_sub). Same handling as
 * SPIN.
 */
export const RENDEZVOUS = Symbol.for('gaplus.rendezvous');

/**
 * Yielded by busy foreground code (main-C's attract loop and stores,
 * sub-E's sub_EA4C, coin_jammed): a timing point, handled like SYNC.
 * The loops charge each pass, so time passes and an IRQ can be taken
 * there.
 */
export const BUSY = Symbol.for('gaplus.busy');

/**
 * Yielded after charging time, right before an access another CPU can
 * see: resumed as soon as the CPU's clock is inside a slice again.
 */
export const SYNC = Symbol.for('gaplus.sync');

/**
 * Returned by an IRQ handler that left through a jump instead of RTI
 * (main $C016 -> service_mode, $C0A8 -> attract_loop): CC.I stays set
 * until the code jumped to clears it.
 */
export const NO_RTI = Symbol.for('gaplus.noRti');

/**
 * What `idle(p)` yields: the thread loops forever in `period` cycles.
 * @typedef {Readonly<{ idle: number }>} IdleMark
 */

/** @type {Map<number, IdleMark>} */
const IDLE_MARKS = new Map();

/**
 * The marker a thread yields when it spins forever without effect
 * (`BRA *`) in a loop of `period` cycles.
 * @param {number} period cycles per pass (>= 1)
 * @returns {IdleMark}
 */
export function idle(period) {
  let mk = IDLE_MARKS.get(period);
  if (mk === undefined) {
    if (!(period >= 1)) throw new Error(`idle period ${period}`);
    mk = Object.freeze({ idle: period });
    IDLE_MARKS.set(period, mk);
  }
  return mk;
}

/**
 * Thrown where the ROM leaves the program in a way a routine port cannot
 * follow (see "What the port cannot follow" in the file header). The
 * RAM is still the ROM's up to that point.
 */
export class RomQuirk extends Error {
  /** @param {string} what */
  constructor(what) {
    super(what);
    this.name = 'RomQuirk';
  }
}

/**
 * Thrown by ported code where the 6809 would loop forever. The scheduler
 * parks that thread (the CPU keeps taking interrupts, as a real one
 * spinning in place would). Throw it only after the writes the endless
 * loop settles into.
 */
export class CpuHang extends Error {
  /** @param {string} where */
  constructor(where) {
    super(`CPU loops forever at ${where}`);
    this.name = 'CpuHang';
  }
}

/** Sub-cycle time: 5 ticks per cycle (76.8 cycles = 384 ticks). */
export const TICKS_PER_CYCLE = 5;
/** A frame in ticks. */
export const FRAME_TICKS = CYCLES_PER_FRAME * TICKS_PER_CYCLE;
/** The 56XX/58XX run: 50 us = 76.8 cycles after vblank. */
export const IO_DELAY_TICKS = 384;
/** MAME's maximum quantum for gaplus: 1/6000 s = 256 cycles. */
export const QUANTUM = 256;
/** MAME watchdog: 3 s after the last kick. */
export const WATCHDOG_CYCLES = 3 * CPU_CLOCK;
/** The reset-vector fetch (MAME 6809: 4 cycles). */
export const RESET_CYCLES = 4;
/** IRQ entry from running code: 12 bytes stacked (MAME: 19 cycles). */
export const IRQ_ENTRY_CYCLES = 19;
/** IRQ taken out of CWAI: state already stacked, vector fetch only. */
export const CWAI_WAKE_CYCLES = 4;

/**
 * `STA` extended, 5 cycles: every IRQ-latch and SRESET write in the ROMs
 * ($7400/$7C00, $6080/$6081, $4000/$6000, $8x00).
 */
const LATCH_STA_CYCLES = 5;

/**
 * Cycle of an extended-addressing instruction's first data access (the
 * 5th: opcode, address high, low, dead cycle): the default of
 * `Machine.ioDataCycle`.
 */
export const IO_ACCESS_CYCLE = 4;

/** CPU names by number. */
const NAMES = /** @type {const} */ (['main', 'sub', 'sound']);

/**
 * The entry points a ported CPU provides (src/game/<cpu>/index.js).
 * @typedef {object} CpuEntries
 * @property {((m: Machine) => Thread) | null} reset  foreground from
 *   the reset vector (a generator)
 * @property {((m: Machine) => (Thread | unknown)) | null} irq  the IRQ
 *   handler (a generator or a plain function)
 */

/**
 * What the scheduler needs of an agent (one per CPU).
 * @typedef {object} Agent
 * @property {number} local  the CPU's local time, in ticks
 * @property {boolean} running  false while held by SRESET
 * @property {(s: Scheduler) => void} attach
 * @property {(t: number) => void} start  (re)start from the reset vector
 *   at tick t (the vector fetch comes on top)
 * @property {() => void} hold  SRESET: stop
 * @property {(target: number) => void} runTo  run while local < target
 *   (instruction or chunk granularity; may overshoot)
 * @property {() => void} vblank  the frame's vblank instant
 * @property {() => string} describe  short state for error messages
 * @property {() => number} now  the CPU's current tick while it runs
 */

/**
 * What `pollAgain(...)` yields.
 * @typedef {Readonly<{ poll: readonly number[], period: number }>} PollMark
 */

/** @type {Map<string, PollMark>} */
const POLL_MARKS = new Map();

/**
 * The marker a poll loop yields after a failed pass, having charged that
 * pass: its instructions' cycles in order, the one that reads first
 * (`LDA <$AF / CMPA #$11 / BNE` = pollAgain(4, 2, 3)). The scheduler then
 * keeps the loop's phase: the next read happens where the 6809's would,
 * and the slice ends where its core would stop. src/game/timing.js
 * `poll()` is the whole loop.
 * @param {...number} cycles
 * @returns {PollMark}
 */
export function pollAgain(...cycles) {
  const key = cycles.join(',');
  let mk = POLL_MARKS.get(key);
  if (mk === undefined) {
    const period = cycles.reduce((x, y) => x + y, 0);
    if (!(period >= 1)) throw new Error(`poll loop of ${period} cycles`);
    mk = Object.freeze({ poll: Object.freeze([...cycles]), period });
    POLL_MARKS.set(key, mk);
  }
  return mk;
}

/** @param {unknown} v @returns {v is PollMark} */
function isPoll(v) {
  return v !== null && typeof v === 'object'
    && Array.isArray((/** @type {{ poll?: unknown }} */ (v)).poll);
}

/**
 * Is `v` an idle marker? @param {unknown} v @returns {v is IdleMark}
 */
function isIdle(v) {
  return v !== null && typeof v === 'object'
    && typeof (/** @type {{ idle?: unknown }} */ (v)).idle === 'number';
}

/** A foreground that does nothing, forever (a parked, hung CPU). */
function* parked() { for (;;) yield; }

/**
 * The ported CPU running a chunk right now (any scheduler), for
 * {@link frameDue}.
 * @type {JsAgent | null}
 */
let RUNNING = null;

/**
 * Is the running ported CPU's clock at or past the next vblank? Its chunk
 * has then run into the next frame, and an access there must wait for
 * the vblank (the lockstep samples RAM at every vblank, and the other
 * CPUs' IRQ handlers run first): shared predicates of "must SYNC before
 * this access" answer true then. False outside the scheduler (routine
 * tests).
 * @returns {boolean}
 */
export function frameDue() {
  return RUNNING !== null && RUNNING.now() >= RUNNING.s.nextVblankT;
}

/**
 * The running ported CPU's cycle since the current frame's vblank, or
 * NaN outside the scheduler (routine tests). A poll loop's passes that
 * the scheduler skips (see pollAgain) still take time: code that keeps
 * its own clock of the frame re-reads it here after the loop.
 * @returns {number}
 */
export function cpuFrameCycle() {
  if (RUNNING === null) return NaN;
  return (RUNNING.now() - RUNNING.s.frameStartT) / TICKS_PER_CYCLE;
}

/** Consecutive zero-cost chunks that count as a JavaScript hang. */
const STUCK_LIMIT = 1_000_000;

/** Foreground wait states of a {@link JsAgent}. */
const RUN = 0;
const FRAME = 1;
const SPINNING = 2;
const IDLE = 3;
const POLL = 4;

/**
 * Drives one CPU's ported JavaScript: its foreground generator and its
 * IRQ handler, on the scheduler's clock. See the file header.
 */
export class JsAgent {
  /**
   * @param {number} n CPU number
   * @param {CpuEntries} entries
   */
  constructor(n, entries) {
    /** CPU number. */
    this.n = n;
    /** @type {CpuEntries} */
    this.entries = entries;
    this.local = 0;
    this.running = false;
    /** @type {Thread | null} the foreground */
    this.fg = null;
    /** @type {Thread | null} the IRQ handler running now, if any */
    this.handler = null;
    /** Foreground wait state (RUN, FRAME, SPINNING, IDLE, POLL). */
    this.wait = RUN;
    /** The IRQ handler's own wait state (RUN, FRAME, SPINNING, POLL). */
    this.hwait = RUN;
    /** Loop period of an IDLE foreground, in cycles. */
    this.period = 1;
    /** The foreground was woken from a CWAI-like wait this frame. */
    this.woke = false;
    /** Why the foreground is parked, if it hung (CpuHang). */
    this.hung = '';
    /** @type {Scheduler | null} */
    this.sched = null;
    /** Local time and charged cycles when the running chunk began. */
    this.chunkStart = 0;
    this.chunkCharged = 0;
    /** Instruction boundaries (ticks) of the running foreground chunk. @type {number[]} */
    this.bounds = [];
    /** Record `bounds` now (a foreground chunk is running). */
    this.recording = false;
    /** The last chunk was the foreground's (rewindToVblank may use it). */
    this.straddle = false;
    /** Foreground time owed after the running IRQ handler (ticks). */
    this.owed = 0;
    /** Poll loops of the foreground and of the handler. @type {PollState | null} */
    this.fgPoll = null;
    /** @type {PollState | null} */
    this.hPoll = null;
    /** Where the last runTo would have stopped an emulated core (ticks). */
    this.stopAt = NaN;
    /** The whole-cycle target of the running runTo (ticks). */
    this.runTarget = 0;
  }

  /** @param {Scheduler} s */
  attach(s) { this.sched = s; }

  /**
   * The CPU's time inside the running chunk: where the chunk started
   * plus what it has charged so far (a latch write in the middle of a
   * long charged stretch happens at its own cycle).
   * @returns {number}
   */
  now() {
    const m = this.s.m;
    return this.chunkStart
      + (m.charged[this.n] - this.chunkCharged) * TICKS_PER_CYCLE;
  }

  /** @returns {Scheduler} */
  get s() {
    if (this.sched === null) throw new Error('agent not attached');
    return this.sched;
  }

  /** @param {number} t */
  start(t) {
    const reset = this.entries.reset;
    if (reset === null) {
      throw new Error(`${NAMES[this.n]} CPU: reset routine not ported`);
    }
    this.fg = reset(this.s.m);
    if (!isGenerator(this.fg)) {
      throw new Error(`${NAMES[this.n]} CPU: reset must be a generator`);
    }
    this.handler = null;
    this.wait = RUN;
    this.hwait = RUN;
    this.woke = false;
    this.owed = 0;
    this.straddle = false;
    // A restart forgets the old run: its hang, poll loops and chunk.
    this.hung = '';
    this.fgPoll = null;
    this.hPoll = null;
    this.period = 1;
    this.bounds.length = 0;
    this.running = true;
    this.local = t + RESET_CYCLES * TICKS_PER_CYCLE;
  }

  hold() {
    this.running = false;
    this.fg = null;
    this.handler = null;
  }

  vblank() {
    // A thread waiting for the next frame wakes; if the IRQ is taken
    // now, it wakes out of a CWAI (vector fetch only).
    if (this.wait === FRAME) { this.wait = RUN; this.woke = true; }
    if (this.hwait === FRAME) this.hwait = RUN;
  }

  /** @returns {string} */
  describe() {
    const w = ['run', 'frame', 'spin', 'idle', 'poll'][this.wait];
    return `${NAMES[this.n]} js ${this.handler ? 'irq' : 'fg'} ${w}`;
  }

  /**
   * Take the IRQ: stack (or wake from CWAI), mask, start the handler.
   */
  takeIrq() {
    const m = this.s.m;
    const irq = this.entries.irq;
    if (irq === null) {
      throw new Error(`${NAMES[this.n]} CPU: IRQ handler not ported`);
    }
    m.enterIrq(this.n);
    this.rewindToVblank();
    this.s.onIrq?.(this.n, true, this.local);
    const entry = this.woke ? CWAI_WAKE_CYCLES : IRQ_ENTRY_CYCLES;
    this.woke = false;
    this.local += entry * TICKS_PER_CYCLE;
    const before = m.charged[this.n];
    const r = irq(m);
    if (isGenerator(r)) {
      this.handler = r;
      this.hwait = RUN;
      return;
    }
    // A plain function: the whole handler ran now. RTI (unless NO_RTI).
    this.local += (m.charged[this.n] - before) * TICKS_PER_CYCLE;
    if (r !== NO_RTI) this.rti();
    this.s.onIrq?.(this.n, false, this.local);
    if (r !== NO_RTI) this.local += this.owed;
    this.owed = 0;
  }

  /**
   * The 6809 takes an IRQ at the first instruction boundary after the
   * line rises. A ported foreground chunk is atomic, so when the last one
   * ran across the vblank the IRQ would start at its end, up to a whole
   * chunk late. Its instruction boundaries are known, though: every
   * `charge()` call ends one (recorded in `bounds`). So the handler
   * starts at the first boundary at or after the vblank, and the rest of
   * the chunk's time is owed to the foreground, paid when the handler
   * returns. (The chunk's accesses after that boundary already happened;
   * ported code SYNCs before every access another CPU can see, so none of
   * those are timed.)
   */
  rewindToVblank() {
    const v = this.s.frameStartT;
    if (this.wait === POLL && this.fgPoll) {
      // In a poll loop the clock is already on an instruction boundary
      // (where the core stopped); the rest of the pass is owed.
      const p = this.fgPoll;
      if (p.next > this.local) {
        this.owed += p.next - this.local;
      } else {
        this.local = p.next;
      }
      return;
    }
    if (!this.straddle || this.chunkStart >= v || this.local <= v) return;
    this.straddle = false;
    for (const b of this.bounds) {
      if (b >= v) {
        if (b < this.local) {
          this.owed += this.local - b;
          this.local = b;
        }
        return;
      }
    }
  }

  /**
   * RTI: the stacked CC had I clear (the IRQ was taken with it so). The
   * main CPU's RTI pops the frame its IRQ (or CWAI) stacked; if the sub
   * CPU wrote into that stack meanwhile, the ROM goes where the port
   * cannot follow (see the file header).
   */
  rti() {
    const s = this.s;
    const hit = s.stackHit;
    if (this.n === CPU.MAIN && hit !== null) {
      throw new RomQuirk(`main CPU RTI at frame ${s.frame} after the sub `
        + `CPU wrote $${hit.addr.toString(16).toUpperCase()} in its `
        + `stack (frame ${hit.frame}): the ROM returns to a clobbered `
        + 'address here (docs/oracle-notes.md section 8)');
    }
    s.m.iMask[this.n] = false;
  }

  /**
   * The poll state of the running thread (foreground or handler).
   * @param {boolean} inIrq @returns {PollState | null}
   */
  pollOf(inIrq) { return inIrq ? this.hPoll : this.fgPoll; }

  /**
   * Run while the CPU's clock is before `target` (a whole cycle). Leaves
   * `stopAt`: where an emulated core would have stopped -- the first
   * instruction boundary at or after the target -- which the scheduler
   * uses to end the slice as MAME does. The clock itself may be later: a
   * ported chunk is atomic.
   * @param {number} target
   */
  runTo(target) {
    const s = this.s;
    const m = s.m;
    const n = this.n;
    // Zero-cost chunks in a row: a thread that yields without charging
    // time and without waiting would loop here forever.
    let stuck = 0;
    // A poll failed during this call: memory this CPU can see does not
    // change again before the slice ends (the CPUs before it in the
    // slice have run, the ones after have not), so later passes of the
    // loop in this slice would fail too.
    let polled = false;
    // The loop ended because the last chunk ran to or past the target.
    let ranPast = false;
    this.runTarget = target;
    while (this.local < target && !s.abort) {
      if (stuck > STUCK_LIMIT) {
        throw new Error(`${NAMES[n]} CPU: ${STUCK_LIMIT} chunks without `
          + 'time passing (a loop that charges nothing per pass?)');
      }
      if (this.handler === null && m.irqPending(n)
          && (this.wait !== FRAME)) {
        this.takeIrq();
        continue;
      }
      const inIrq = this.handler !== null;
      const t = inIrq ? this.handler : this.fg;
      ranPast = false;
      if (t === null) { this.local = target; break; }
      const w = inIrq ? this.hwait : this.wait;
      if (w === FRAME) { this.local = target; break; }
      if (w === IDLE) {
        // BRA *: whole passes up to the slice end (the last may
        // overshoot, as the core's instruction does).
        const per = this.period * TICKS_PER_CYCLE;
        this.local += Math.ceil((target - this.local) / per) * per;
        break;
      }
      if (w === POLL) {
        const p = /** @type {PollState} */ (this.pollOf(inIrq));
        const per = p.period * TICKS_PER_CYCLE;
        if (p.next < target && !polled) {
          // The next pass reads inside this slice: resume there.
          this.local = p.next;
          if (inIrq) this.hwait = RUN; else this.wait = RUN;
        } else {
          // Skip the passes that start before the target; the core
          // stops at the first instruction boundary at or after it.
          if (p.next < target) p.next += Math.ceil((target - p.next) / per) * per;
          this.local = pollStop(p, target);
          break;
        }
      }
      const before = m.charged[n];
      this.chunkStart = this.local;
      this.chunkCharged = before;
      // Every chunk records its instruction boundaries (stopAt; and for
      // the foreground, rewindToVblank).
      this.bounds.length = 0;
      this.recording = true;
      this.straddle = !inIrq;
      /** @type {IteratorResult<unknown, unknown>} */
      let r;
      s.current = n;
      RUNNING = this;
      try {
        r = t.next();
      } catch (e) {
        if (!(e instanceof CpuHang) || inIrq) throw e;
        this.fg = parked();
        this.hung = e.message;
        continue;
      } finally {
        s.current = -1;
        RUNNING = null;
        this.recording = false;
      }
      const spent = (m.charged[n] - before) * TICKS_PER_CYCLE;
      this.local += spent;
      stuck = spent > 0 ? 0 : stuck + 1;
      ranPast = this.local >= target;
      const v = r.value;
      if (r.done) {
        if (!inIrq) {
          throw new Error(`${NAMES[n]} CPU: foreground returned`);
        }
        // RTI, unless the handler left through a jump (NO_RTI): then
        // CC.I stays set until the code jumped to clears it.
        this.handler = null;
        this.hPoll = null;
        if (r.value !== NO_RTI) this.rti();
        s.onIrq?.(n, false, this.local);
        // The interrupted foreground's time after the IRQ's entry point
        // (the rest of its chunk, or of its poll loop's pass) -- unless
        // the handler jumped away: that foreground is abandoned.
        if (r.value === NO_RTI) {
          this.wait = RUN;
          this.fgPoll = null;
        } else {
          this.local += this.owed;
        }
        this.owed = 0;
        if (this.wait === POLL && this.fgPoll) this.fgPoll.next = this.local;
        continue;
      }
      let ws = RUN;
      if (v === undefined) ws = FRAME;
      else if (v === SPIN || v === RENDEZVOUS) ws = SPINNING;
      // BUSY is a timing point, like SYNC: every busy loop charges its
      // passes (a chunk may also begin with it, before its first store).
      else if (v === BUSY) ws = RUN;
      else if (isIdle(v)) {
        if (inIrq) throw new Error(`${NAMES[n]} CPU: idle inside IRQ`);
        ws = IDLE;
        this.period = v.idle;
      } else if (isPoll(v)) {
        // A failed pass of a poll loop, charged: the clock is at the
        // start of the next pass's read.
        ws = POLL;
        polled = true;
        const p = { loop: v.poll, period: v.period, next: this.local };
        if (inIrq) this.hPoll = p; else this.fgPoll = p;
      }
      if (inIrq) this.hwait = ws; else this.wait = ws;
      // A poll that failed: nothing changes before the other CPUs run.
      if (ws === SPINNING) {
        if (this.local < target) { this.local = target; ranPast = false; }
        break;
      }
    }
    this.stopAt = this.local;
    // A chunk that ran past the target: the core stops at its first
    // instruction boundary at or after the target.
    if (ranPast) {
      for (const bd of this.bounds) {
        if (bd >= target) { this.stopAt = Math.min(bd, this.local); break; }
      }
    }
  }
}

/**
 * A poll loop's state: its instructions' cycles (the read first), their
 * sum, and the tick at which the next pass's read starts.
 * @typedef {{ loop: readonly number[], period: number, next: number }}
 *   PollState
 */

/**
 * Where an emulated core running the poll loop stops: the first
 * instruction boundary at or after `target`, within the pass that ends
 * where the next read starts.
 * @param {PollState} p @param {number} target @returns {number}
 */
function pollStop(p, target) {
  let t = p.next - p.period * TICKS_PER_CYCLE;
  if (t >= target) return t;
  for (const c of p.loop) {
    t += c * TICKS_PER_CYCLE;
    if (t >= target) return t;
  }
  return p.next;
}

/**
 * @typedef {object} SchedulerOptions
 * @property {Array<Agent | null | undefined>} [agents]  per CPU: an
 *   agent to use instead of a JsAgent (tests: the fallback bridge)
 * @property {number} [quantum] slice length in cycles (default 256)
 */

export class Scheduler {
  /**
   * @param {Machine} m
   * @param {{ main: CpuEntries, sub: CpuEntries, sound: CpuEntries }} cpus
   * @param {SchedulerOptions} [opts]
   */
  constructor(m, cpus, opts = {}) {
    this.m = m;
    /** @type {Agent[]} */
    this.agents = [0, 1, 2].map((n) => opts.agents?.[n]
      ?? new JsAgent(n, cpus[NAMES[n]]));
    for (const a of this.agents) a.attach(this);
    this.quantum = opts.quantum ?? QUANTUM;
    /**
     * The first sub-CPU write into the main CPU's stack since power-on
     * (see the file header), or null.
     * @type {{ addr: number, frame: number } | null}
     */
    this.stackHit = null;
    this.watchIo(m);
    this.watchCharges(m);
    /** CPU running a chunk now (-1 between chunks). */
    this.current = -1;
    /**
     * Instrumentation (tools): an IRQ handler of a ported CPU started
     * (true) or ended (false) at `tick`.
     * @type {null | ((cpu: number, start: boolean, tick: number) => void)}
     */
    this.onIrq = null;
    /** A line-changing write ended the writer's slice. */
    this.abort = false;
    /** Where it ended it (NaN: at the writer's local time). */
    this.abortAt = NaN;
    /**
     * Start of a ported main CPU instruction that got the I/O run early,
     * from a chunk past its slice (NaN: none pending; see timeslice).
     */
    this.cutAt = NaN;
    /**
     * SRESET changes waiting for the end of the slice, with the writer's
     * time. @type {Array<{ held: boolean, at: number }>}
     */
    this.sresetQueue = [];
    m.hooks.onSreset = (held) => {
      this.lineWrite();
      this.sresetQueue.push({ held, at: this.abortAt });
    };
    m.hooks.onIrqMask = (_cpu, on) => { if (!on) this.lineWrite(); };
    m.hooks.onWatchdog = () => this.kick();
    // The main foreground's cycle clock (clock.js) re-aligns this one.
    const main = this.agents[0];
    if (main instanceof JsAgent) {
      bindClock(m, (t) => { main.local = this.frameStartT + t * TICKS_PER_CYCLE; });
    }
    this.powerOn();
  }

  /** Power-on: RAM and latches cleared, the main CPU starts. */
  powerOn() {
    this.m.reset();
    /** Base time (ticks). */
    this.t = 0;
    /** Next vblank (none at t = 0: the first is one frame in). */
    this.nextVblankT = FRAME_TICKS;
    /** Pending 56XX/58XX run, or Infinity. */
    this.ioAt = Infinity;
    /** Slice cut at the I/O run's instant (kept when it ran early). */
    this.ioCut = Infinity;
    /** The current frame's vblank tick. */
    this.frameStartT = 0;
    this.frame = 0;
    this.wd = { armed: false, lastKickT: 0, resets: 0 };
    this.sresetQueue = [];
    this.abort = false;
    this.cutAt = NaN;
    this.stackHit = null;
    this.agents[0].start(0);
    this.agents[1].hold();
    this.agents[2].hold();
    this.agents[1].local = 0;
    this.agents[2].local = 0;
  }

  /**
   * A write that changes an IRQ line or SRESET: MAME ends the writer's
   * slice after that instruction (`abortAt`). A ported writer reports
   * its time at the START of the STA (it charges up to there, then
   * writes), and every such write in the ROMs is `STA extended`, 5
   * cycles. An emulated core is mid-instruction: its time after the
   * instruction is known once it stops (NaN until timeslice fills it).
   */
  lineWrite() {
    const js = this.current >= 0 && this.agents[this.current] instanceof JsAgent;
    this.abort = true;
    this.abortAt = js ? this.now() + LATCH_STA_CYCLES * TICKS_PER_CYCLE : NaN;
  }

  /** The current tick of the CPU running now, else the base time. */
  now() {
    return this.current >= 0 ? this.agents[this.current].now() : this.t;
  }

  /** Watchdog kick (main $7800-$7FFF read, sound $2000-$3FFF). */
  kick() {
    this.wd.armed = true;
    this.wd.lastKickT = this.now();
  }

  /**
   * An emulated main CPU's access to $6800-$681F at tick `tick`: deliver
   * a pending I/O run first if the access is past its instant (the
   * oracle's Board.ioCatchUp).
   * @param {number} tick
   * @param {boolean} [keepCut] keep the slice cut at the run's instant
   */
  ioCatchUp(tick, keepCut = false) {
    if (this.ioAt !== Infinity && tick + TICKS_PER_CYCLE > this.ioAt) {
      // Delivered early: the timer is gone, and so is its slice cut
      // (MAME: the timer is removed). `keepCut`: the access is a ported
      // CPU's, in an atomic chunk that ran past the slice's end, where
      // the board's core would have stopped at the cut first.
      this.ioAt = Infinity;
      if (!keepCut) this.ioCut = Infinity;
      this.m.ioUpdate();
    }
  }

  /**
   * Deliver the 56XX/58XX run lazily, as the oracle does: before the
   * first main-CPU access to $6800-$681F at or after its instant (MAME
   * runs the chips at vblank + 76.8 cycles, in the middle of whatever
   * instruction is running), else at the end of that slice. A ported
   * main CPU's time at an access is the start of its instruction (the
   * code charges up to there, then accesses); the access itself comes
   * `m.ioDataCycle` cycles later: IO_ACCESS_CYCLE (4) for extended
   * addressing, which most chip accesses use, or what ported code that
   * reaches the chips through an index register set for that
   * instruction (src/game/timing.js ioRead / ioStore). An emulated core (test
   * bridge) reports its exact bus cycle itself.
   *
   * Also notes the sub CPU's writes into the main CPU's stack
   * (`stackHit`, see the file header).
   * @param {Machine} m
   */
  watchIo(m) {
    const read = m.busRead;
    const write = m.busWrite;
    const self = this;
    /** @param {number} cpu @param {number} a */
    const check = (cpu, a) => {
      if (cpu !== CPU.MAIN || a < 0x6800 || a >= 0x6820 || self.ioAt === Infinity) return;
      const agent = self.current >= 0 ? self.agents[self.current] : null;
      if (agent instanceof JsAgent) {
        // The board's core makes this access in the current slice only
        // if the instruction starts before the slice's end; then the
        // delivery also removes the slice cut, else the core stops at
        // the cut first (and the run happens there).
        // (A line write earlier in the chunk has ended the slice at the
        // writer's time already.)
        const start = agent.now();
        const end = self.abort && !Number.isNaN(self.abortAt)
          ? Math.min(agent.runTarget, self.abortAt) : agent.runTarget;
        const later = !(start < end);
        if (self.ioAt !== Infinity && later) self.cutAt = start;
        self.ioCatchUp(start + m.ioDataCycle * TICKS_PER_CYCLE, later);
      }
    };
    const { mainLow, mainTop } = STACKS.main;
    /** @param {number} cpu @param {number} a @returns {number} */
    m.busRead = function busRead(cpu, a) {
      check(cpu, a & 0xffff);
      return read.call(this, cpu, a);
    };
    /** @param {number} cpu @param {number} a @param {number} v */
    m.busWrite = function busWrite(cpu, a, v) {
      const at = a & 0xffff;
      check(cpu, at);
      if (cpu === CPU.SUB && self.stackHit === null && at >= mainLow
          && at < mainTop) {
        self.stackHit = { addr: at, frame: self.frame };
      }
      write.call(this, cpu, a, v);
    };
  }

  /**
   * Note every `charge()` of a running ported foreground chunk as an
   * instruction boundary (JsAgent.rewindToVblank).
   * @param {Machine} m
   */
  watchCharges(m) {
    for (const view of [m, m.sub, m.sound]) {
      const charge = view.charge;
      const agent = this.agents[view.cpuNo];
      if (!(agent instanceof JsAgent)) continue;
      /** @param {number} cycles */
      view.charge = function recorded(cycles) {
        charge.call(this, cycles);
        if (agent.recording) agent.bounds.push(agent.now());
      };
    }
  }

  /** The vblank instant: IRQ lines, the I/O run armed, agents told. */
  vblank() {
    const m = this.m;
    this.frameStartT = this.t;
    m.vblank();
    if (m.io.pending.n56 || m.io.pending.n58) {
      this.ioCut = this.t + IO_DELAY_TICKS;
      this.ioAt = this.ioCut;
    }
    for (const a of this.agents) if (a.running) a.vblank();
  }

  /**
   * One slice up to `limit`: main, then sub, then sound, each from its
   * own local time. A line-changing write ends the slice at the writer's
   * time for the CPUs after it (MAME device_scheduler::timeslice).
   * @param {number} limit @returns {number} where the slice ended
   */
  timeslice(limit) {
    let target = limit;
    for (let n = 0; n < 3; n += 1) {
      const a = this.agents[n];
      if (target - a.local < TICKS_PER_CYCLE) continue;
      if (!a.running) {
        a.local += Math.floor((target - a.local) / TICKS_PER_CYCLE)
          * TICKS_PER_CYCLE;
        // "if the new local time is less than our target, move the
        // target up" (MAME): a CPU that stops on a whole cycle before a
        // fractional target (the I/O run's) ends the slice there.
        if (a.local < target) target = Math.max(a.local, this.t);
        continue;
      }
      this.abort = false;
      this.abortAt = NaN;
      // Whole cycles only: a CPU runs at least as many cycles as fit
      // before the target (the last instruction or chunk may overshoot),
      // exactly as the oracle's cores do when the slice ends at the I/O
      // run's fractional instant.
      a.runTo(a.local + Math.floor((target - a.local) / TICKS_PER_CYCLE)
        * TICKS_PER_CYCLE);
      // The CPUs after this one run only up to where it stopped: the
      // writer's time after a line write, or a whole cycle short of a
      // fractional target (device_scheduler::timeslice).
      // The I/O access that a ported main CPU made early (in a chunk that
      // ran past its slice) happens on the board in the slice that
      // reaches its instruction: the run's slice cut goes then.
      if (n === 0 && !Number.isNaN(this.cutAt)) {
        const wt = a instanceof JsAgent ? a.runTarget : a.local;
        const end = this.abort && !Number.isNaN(this.abortAt)
          ? Math.min(wt, this.abortAt) : wt;
        if (this.cutAt < end) { this.ioCut = Infinity; this.cutAt = NaN; }
      }
      const stop = a instanceof JsAgent && !Number.isNaN(a.stopAt)
        ? a.stopAt : a.local;
      const at = this.abort && !Number.isNaN(this.abortAt) ? this.abortAt
        : stop;
      if (at < target) target = Math.max(at, this.t);
      for (const e of this.sresetQueue) if (Number.isNaN(e.at)) e.at = a.local;
      this.abort = false;
    }
    return target;
  }

  /**
   * Run the board up to tick `target`; vblanks and I/O runs fire on the
   * way. Stopping exactly at a vblank leaves it for the next call.
   * @param {number} target
   */
  advanceTo(target) {
    const m = this.m;
    while (this.t < target) {
      if (this.t === this.nextVblankT) {
        this.vblank();
        this.nextVblankT += FRAME_TICKS;
      }
      if (this.ioAt <= this.t) { this.ioAt = Infinity; m.ioUpdate(); }
      if (this.ioCut <= this.t) { this.ioCut = Infinity; this.cutAt = NaN; }
      // The I/O timer cuts the slices where it is due (the oracle's
      // Board.advanceTo).

      const limit = Math.min(this.t + this.quantum * TICKS_PER_CYCLE,
        this.nextVblankT, this.ioAt, this.ioCut, target);
      this.t = this.timeslice(limit);
      // MAME's synchronize point: SRESET reaches the sub and sound CPUs.
      if (this.sresetQueue.length > 0) {
        const q = this.sresetQueue;
        this.sresetQueue = [];
        for (const e of q) this.applySreset(e.held, e.at);
      }
      if (this.wd.armed && this.t - this.wd.lastKickT
          > WATCHDOG_CYCLES * TICKS_PER_CYCLE) {
        this.watchdogFired();
      }
    }
    this.frame = Math.floor(this.t / FRAME_TICKS);
  }

  /**
   * SRESET reaching the sub and sound CPUs: holding stops them;
   * releasing restarts them from their reset vectors, at the writer's
   * time (MAME aborts the writer's slice there; the oracle's CPUs are
   * whole-instruction, so the writer's time is where its write began).
   * @param {boolean} held @param {number} at the write's tick
   */
  applySreset(held, at) {
    for (const n of [CPU.SUB, CPU.SOUND]) {
      const a = this.agents[n];
      if (held) a.hold();
      else if (!a.running) a.start(Math.max(a.local, at));
    }
  }

  /** MAME watchdog_fired(): every CPU restarts; RAM is kept. */
  watchdogFired() {
    this.wd.resets += 1;
    this.wd.armed = false;
    this.m.machineReset();
    this.m.sreset = false;
    this.stackHit = null;
    for (const a of this.agents) a.start(this.t);
  }

  /** Times the watchdog fired (never, on a good run). */
  get watchdogResets() { return this.wd.resets; }

  /**
   * One frame: this frame's vblank (IRQs, I/O run) and everything up to
   * the next vblank instant, where the oracle's runFrame() also stops.
   */
  runFrame() {
    this.advanceTo((this.frame + 1) * FRAME_TICKS);
  }

  /** @param {number} n */
  runFrames(n) {
    for (let i = 0; i < n; i += 1) this.runFrame();
  }

  /** Cycles since the current frame's vblank (for hooks). */
  frameCycle() {
    return (this.now() - this.frameStartT) / TICKS_PER_CYCLE;
  }

  /**
   * The frame cycle of the I/O-chip access being made now: a ported
   * CPU's time is the start of its instruction, so its data cycle
   * (`m.ioDataCycle`) comes on top; an emulated core's time is the
   * access itself.
   * @returns {number}
   */
  accessCycle() {
    const js = this.current >= 0
      && this.agents[this.current] instanceof JsAgent;
    return this.frameCycle() + (js ? this.m.ioDataCycle : 0);
  }
}

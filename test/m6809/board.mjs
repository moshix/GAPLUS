// Copyright 2026 by Moshix
/**
 * The Gaplus board with three MC6809E cores running the real ROMs: the
 * *oracle*. Tests run the original machine code here and compare what it
 * does to memory against the JavaScript port, byte for byte. The early
 * "emulated preview" page drives it in the browser too, so this module
 * (and everything it imports) has no Node dependencies: the ROM images are
 * passed in (`new Board({ roms })`, `roms` as tools/romset.mjs
 * `loadGaplus()` returns them; test/helpers/oracle.mjs `makeOracle()` does
 * that in Node).
 *
 * WHAT IS SHARED WITH THE PORT. The memory map, the latches and the custom
 * I/O chips are src/machine/machine.js (`Machine`) and namcoio.js -- the
 * same code the port runs -- so `board.mem` has exactly the port's layout
 * (all RAM in main-CPU addresses, sound RAM at $6000) and a lockstep test
 * compares the two arrays directly. Only the program ROMs are served here
 * (from the images passed in, not from src/game/romdata.js, whose code-byte
 * guard would trip on instruction fetches).
 *
 * TIMING MODEL (MAME gaplus.cpp / gapluso machine config; see
 * docs/hardware.md sections 2 and 4, docs/oracle-notes.md):
 *
 *  - Each CPU runs at 1.536 MHz; a frame is exactly 25,344 cycles.
 *  - Time is kept in TICKS of 1/5 cycle, so that the I/O chips' run
 *    50 us = 76.8 cycles after vblank is an exact integer (384 ticks).
 *  - Frame k (k = 0, 1, ...) is [k * 25344, (k + 1) * 25344) cycles. Its
 *    first instant is the vblank of MAME's zero-length vblank (none at
 *    t = 0: MAME's first vblank is one frame after power-on). At vblank,
 *    in MAME's order: main IRQ asserted if its mask is set, the 56XX/58XX
 *    runs armed unless FRESET holds them, sub IRQ, sound IRQ. The lines
 *    are LEVEL and stay up until the handler writes its disable latch.
 *  - After runFrame() the board stands exactly at the next vblank instant,
 *    before the IRQs are raised: that is the RAM MAME's screen update
 *    draws, and the point lockstep compares.
 *
 * SCHEDULING is MAME's device_scheduler::timeslice(), transcribed:
 *
 *  - The base time advances in slices of at most QUANTUM cycles (MAME:
 *    set_maximum_quantum(1/6000 s) = 256 cycles; a constructor option here),
 *    cut short at every timer (vblank, the +76.8-cycle I/O run).
 *  - Within a slice the CPUs run in config order main, sub, sound, each
 *    from its own local time up to the slice end. A CPU in reset "eats" its
 *    cycles (its local time advances, nothing executes).
 *  - Writes that make MAME call set_input_line() -- main $7800-$7FFF (IRQ
 *    off/ack), main $8000-$8FFF (SRESET), sub $6000-$6FFF with A0 = 0,
 *    sound $6000-$7FFF -- queue a "synchronize" timer, which aborts the
 *    writer's slice after the current instruction. The CPUs after it in
 *    the slice then run only up to the writer's time ("if the new local
 *    time is less than our target, move the target up"), and the queued
 *    line change (SRESET on the sub and sound CPUs) is applied at that
 *    instant.
 *  - One difference remains: MAME's 6809 can pause in the middle of an
 *    instruction when its slice runs out; this core always completes the
 *    instruction, and the overshoot is carried (the CPU starts the next
 *    slice later). Bus accesses therefore land at most one instruction
 *    late relative to another CPU's slice boundary.
 *
 * POWER-ON (option `powerOn`): 'mame' (default) starts all three CPUs at
 * t = 0 as MAME does; main's second instruction `STA $8C00` (SRESET on)
 * then stops the sub and sound CPUs after they have run the same dozen
 * cycles. 'held' starts the sub and sound CPUs in reset instead (FBNeo-like;
 * the RAM result is the same, the CPUs' leftover registers are not).
 *
 * WATCHDOG. MAME's default WATCHDOG_TIMER: armed by the first kick (main
 * reads of $7800-$7FFF, sound accesses to $2000-$3FFF), fires 3 s after
 * the last kick and soft-resets the machine. `watchdogResets` counts
 * firings; on this board a firing is a bug.
 */

import { M6809, CC_I, CC_F } from './m6809.mjs';
import { Machine, CPU, CYCLES_PER_FRAME, CPU_CLOCK } from '../../src/machine/machine.js';

/** @typedef {import('../../src/machine/machine.js').MachineState} MachineState */
/** @typedef {import('./m6809.mjs').CpuState} CpuState */
/** @typedef {import('../../src/machine/namcoio.js').InputState} InputState */

/** Sub-cycle time resolution: 5 ticks per CPU cycle (76.8 cycles = 384). */
export const TICKS_PER_CYCLE = 5;
/** A frame in ticks. */
export const FRAME_TICKS = CYCLES_PER_FRAME * TICKS_PER_CYCLE;
/** 50 us after vblank the 56XX/58XX run: 76.8 cycles = 384 ticks. */
export const IO_DELAY_TICKS = 384;
/** MAME's maximum quantum for gaplus: 1/6000 s = 256 CPU cycles. */
export const MAME_QUANTUM = 256;
/** MAME watchdog: 3 seconds after the last kick. */
export const WATCHDOG_CYCLES = 3 * CPU_CLOCK;

/** First address of each CPU's program ROM. */
const ROM_START = [0xa000, 0xa000, 0xe000];

/** The CPU names, by number. */
export const CPU_NAME = Object.freeze(['main', 'sub', 'sound']);

/**
 * Handler timing record: `start` and `end` in CPU cycles from the vblank
 * that raised the IRQ (end > 25344 = the handler overran into the next
 * frame).
 * @typedef {object} IrqRecord
 * @property {number} frame   the frame the vblank opened
 * @property {number} cpu     0 main, 1 sub, 2 sound
 * @property {number} start   cycle the interrupt entry began
 * @property {number} end     cycle the RTI (or non-local exit) completed
 */

/**
 * Min/max statistics per CPU over every handler run.
 * @typedef {object} IrqStats
 * @property {number} count
 * @property {number} startMin @property {number} startMax
 * @property {number} endMin @property {number} endMax
 * @property {number} overruns  handlers that ended after the next vblank
 * @property {number} lost      vblanks that found the CPU running with its
 *   IRQ mask off (after it had first enabled it)
 * @property {number} abnormal  handlers left other than by RTI to the
 *   interrupted PC (e.g. a jump out of the handler into the game start)
 * @property {number} nested    interrupts taken inside a handler (cannot
 *   happen while CC.I is set; counted as a sanity check)
 */

/**
 * @typedef {object} BoardOptions
 * @property {{ main: Uint8Array, sub: Uint8Array, sound: Uint8Array }} roms
 *   64 KB program images (tools/romset.mjs loadGaplus())
 * @property {number} [quantum]  slice length in cycles (default 256, MAME)
 * @property {'mame'|'held'} [powerOn]  see the file header
 * @property {boolean} [syncOnLatch]  abort the slice on line-changing
 *   writes, as MAME does (default true)
 * @property {'reset'|'count'} [watchdog]  on firing: soft reset (MAME,
 *   default) or only count
 */

/**
 * @typedef {object} BoardState
 * @property {CpuState[]} cpus
 * @property {MachineState} machine
 * @property {InputState} inputs
 * @property {number} t @property {number[]} local
 * @property {number} nextVblankT @property {number} ioAt
 * @property {boolean[]} inReset @property {number} frame
 * @property {number} frameStartT
 * @property {{ armed: boolean, lastKickT: number, resets: number }} wd
 * @property {{ inIrq: boolean[], exitS: number[], exitPc: number[],
 *   startT: number[], vblankT: number[], everEnabled: boolean[] }} irq
 */

export class Board {
  /** @param {BoardOptions} opts */
  constructor(opts) {
    if (!opts || !opts.roms) throw new Error('Board needs { roms }');
    const { roms } = opts;
    /** Program images by CPU number (64 KB each, indexed by address). */
    this.rom = [roms.main, roms.sub, roms.sound];
    /** Slice length in cycles. */
    this.quantum = opts.quantum ?? MAME_QUANTUM;
    /** Abort slices on line-changing writes (MAME synchronize). */
    this.syncOnLatch = opts.syncOnLatch ?? true;
    /** @type {'reset'|'count'} */
    this.watchdogMode = opts.watchdog ?? 'reset';
    /** @type {'mame'|'held'} */
    this.powerOnMode = opts.powerOn ?? 'mame';

    /** The port's Machine: RAM, latches, I/O chips (shared code). */
    this.machine = new Machine();
    /** All RAM in main-CPU addresses; the renderer and lockstep read it. */
    this.mem = this.machine.mem;
    /** The 15XX register image ($6000-$603F; sound CPU $0000-$003F). */
    this.wsgRegs = this.mem.subarray(0x6000, 0x6040);

    // ------------------------------------------------ hooks and outputs
    /**
     * Per-instruction hook (slow): (cpu number, pc, core) before each
     * instruction executes. Assign through the property.
     * @type {null | ((n: number, pc: number, cpu: M6809) => void)}
     */
    this._onExec = null;
    /**
     * Called on every 15XX register write (main $6000-$603F or sound
     * $0000-$003F) with (reg, value, cycle within the frame).
     * @type {null | ((reg: number, value: number, cycle: number) => void)}
     */
    this.onWsgWrite = null;
    /** Record this frame's 15XX writes into `wsgWrites`. */
    this.recordSound = false;
    /** [cycle within frame, reg, value] of the frame just run. @type {number[][]} */
    this.wsgWrites = [];
    /**
     * The 62XX "bang" (explosion sample) trigger: main write of >= $0F to
     * $6829. Called with the cycle within the frame.
     * @type {null | ((cycle: number) => void)}
     */
    this.onBang = null;
    /** Bang triggers during the frame just run. */
    this.bangs = 0;
    /** Called with (cpu, addr, value) on every CPU write. @type {null | ((n: number, a: number, v: number) => void)} */
    this.onWrite = null;
    /**
     * Per-frame input script: called at the start of every runFrame() with
     * (frame, board), before that frame's vblank.
     * @type {null | ((frame: number, board: Board) => void)}
     */
    this.inputScript = null;
    /** Scheduled input changes: frame -> [name, down][]. @type {Map<number, Array<[string, boolean]>>} */
    this.inputEvents = new Map();

    /** Keep every handler's timing in `irqLog`. */
    this.logIrqs = false;
    /** @type {IrqRecord[]} */
    this.irqLog = [];
    /** @type {IrqStats[]} */
    this.irqStats = [0, 1, 2].map(() => newStats());
    /** Last completed handler per CPU. @type {(IrqRecord|null)[]} */
    this.lastIrq = [null, null, null];

    /**
     * Coverage maps (null until enableCoverage()), indexed by address:
     * exec = 0 never executed, $100 | DP when always executed with that
     * DP, $FFFF with more than one DP; data = 1 read as data.
     * @type {null | { exec: Uint16Array[], data: Uint8Array[] }}
     */
    this.coverage = null;

    /** Lowest S seen per CPU, sampled after every instruction when stack tracking is on. */
    this.stackLow = [0xffff, 0xffff, 0xffff];
    /** Track `stackLow` (costs a little per instruction). */
    this.trackStack = false;
    /**
     * PCs outside ROM (a runaway; never on a good run): the first 16 as
     * { cpu, pc, frame, from } and a total count.
     * @type {Array<{ cpu: number, pc: number, frame: number, from: number }>}
     */
    this.runaways = [];
    this.runawayCount = 0;
    /** Throw on a runaway instead of recording it. */
    this.strictPc = false;

    this.machine.hooks.onWsgWrite = (reg, v) => this.wsgWritten(reg, v);
    this.machine.hooks.onWatchdog = () => this.kick();
    this.machine.io.onBang = () => {
      this.bangs += 1;
      this.onBang?.(this.frameCycle());
    };

    // ---------------------------------------------------------- the CPUs
    /** @type {M6809[]} */
    this.cpus = [0, 1, 2].map((n) => this.makeCpu(n));

    this.powerOn();
  }

  /**
   * One core wired to this board's bus. ROM reads are served from the
   * image; everything else goes through the Machine's decode for that CPU.
   * @param {number} n @returns {M6809}
   */
  makeCpu(n) {
    const rom = this.rom[n];
    const romStart = ROM_START[n];
    const m = this.machine;
    if (n !== 0) {
      return new M6809({
        read: (a) => (a >= romStart ? rom[a] : m.busRead(n, a)),
        write: (a, v) => this.write(n, a, v),
        ack: () => this.irqTaken(n),
      });
    }
    // Main: an access to the 56XX/58XX may be the first one past the
    // I/O run's deadline (see ioCatchUp).
    return new M6809({
      read: (a) => {
        if (a >= romStart) return rom[a];
        if (a >= 0x6800 && a < 0x6820 && this.ioAt !== Infinity) this.ioCatchUp();
        return m.busRead(0, a);
      },
      write: (a, v) => this.write(0, a, v),
      ack: () => this.irqTaken(0),
    });
  }

  /**
   * MAME's 6809 stops in the MIDDLE of an instruction when its slice ends
   * at the namcoio_run timer (vblank + 76.8 cycles), the timer's
   * customio_run() writes the chips' nibbles, and the instruction resumes.
   * A CPU whose local time is whole cycles executes cycle index i before
   * the timer iff i + 1 <= deadline, i.e. i <= vblank + 75. This core
   * completes instructions, so the run is delivered lazily instead: before
   * a main-CPU access to $6800-$681F whose cycle index is past that point
   * (e.g. `LDD $6800` at $C01A, which reads at cycles 79/80 after the IRQ
   * entry, straddling the deadline when the IRQ latency is 0 or 1), the
   * pending run happens first. Otherwise it happens at the slice end.
   */
  ioCatchUp() {
    if (this.cur !== 0) return;
    const t = this.stepT + this.cpus[0].cyc * TICKS_PER_CYCLE;
    if (t + TICKS_PER_CYCLE > this.ioAt) {
      this.ioAt = Infinity;
      this.machine.ioUpdate();
    }
  }

  /** Power-on: RAM, latches and CPUs from scratch; inputs are kept. */
  powerOn() {
    const inputs = this.machine.io.inputs;
    const onBang = this.machine.io.onBang;
    this.machine.reset();
    this.machine.io.inputs = inputs;
    this.machine.io.onBang = onBang;
    for (const c of this.cpus) {
      c.setState({ a: 0, b: 0, x: 0, y: 0, u: 0, s: 0, dp: 0, cc: 0,
        irqLine: false, firqLine: false, nmiLine: false, cycles: 0 });
    }
    /** Base time (MAME basetime), in ticks. */
    this.t = 0;
    /** Each CPU's local time, in ticks (always whole cycles). */
    this.local = [0, 0, 0];
    /** CPUs held by SRESET (sub and sound only). */
    this.inReset = [false, false, false];
    if (this.powerOnMode === 'held') {
      this.inReset = [false, true, true];
      this.machine.sreset = true;
    } else {
      // MAME: the RESET lines are clear at power-on; sound is enabled
      // until main's STA $8C00.
      this.machine.sreset = false;
    }
    // The reset vector fetch: 4 cycles on each running CPU.
    for (let n = 0; n < 3; n += 1) {
      if (!this.inReset[n]) this.local[n] = this.cpus[n].reset() * TICKS_PER_CYCLE;
    }
    /** Time of the next vblank (none at t = 0). */
    this.nextVblankT = FRAME_TICKS;
    /** Time of the armed 56XX/58XX run, or Infinity. */
    this.ioAt = Infinity;
    /** Frames completed (= vblanks reached). */
    this.frame = 0;
    /** Time the current frame began (its vblank). */
    this.frameStartT = 0;
    /** Line changes waiting for the end of the slice (MAME synchronize). @type {Array<() => void>} */
    this.syncQueue = [];
    this.abort = false;
    /** CPU executing now (-1 between slices) and the tick its step began. */
    this.cur = -1;
    this.stepT = 0;
    this.wd = { armed: false, lastKickT: 0, resets: 0 };
    this.irq = {
      inIrq: [false, false, false],
      exitS: [0, 0, 0],
      exitPc: [0, 0, 0],
      startT: [0, 0, 0],
      vblankT: [0, 0, 0],
      everEnabled: [false, false, false],
    };
  }

  // -------------------------------------------------------------- access

  /** @returns {Machine['starCtrl']} $A000-$A003 as last written */
  get starCtrl() { return this.machine.starCtrl; }

  /** @returns {boolean} 15XX output enabled (SRESET off) */
  get soundEnable() { return this.machine.soundEnable; }

  /** Times the watchdog fired. */
  get watchdogResets() { return this.wd.resets; }

  /** Absolute cycle of the base time. */
  get cycle() { return this.t / TICKS_PER_CYCLE; }

  /** @returns {InputState} the live input state */
  get inputs() { return this.machine.io.inputs; }

  /** @param {null | ((n: number, pc: number, cpu: M6809) => void)} fn */
  set onExec(fn) {
    this._onExec = fn;
    this.installTrace();
  }

  get onExec() { return this._onExec; }

  /**
   * Side-effect-free read of RAM/ROM as `cpu` sees it (no I/O or latch
   * side effects: I/O and latch addresses read as the Machine's state).
   * @param {number} addr @param {number} [cpu] @returns {number}
   */
  peek(addr, cpu = 0) {
    const a = addr & 0xffff;
    if (a >= ROM_START[cpu]) return this.rom[cpu][a];
    if (cpu === 2) return a < 0x400 ? this.mem[0x6000 + a] : 0;
    if (a < 0x2000) return this.mem[a];
    if (cpu === 0 && a >= 0x6000 && a < 0x6400) return this.mem[a];
    return 0;
  }

  /** Write RAM directly (main-CPU addresses, no side effects). @param {number} addr @param {number} v */
  poke(addr, v) { this.mem[addr & 0xffff] = v & 0xff; }

  // ------------------------------------------------------------- the bus

  /**
   * A CPU write: the Machine decodes it; then the MAME scheduling side
   * effects of line-changing latches.
   * @param {number} n @param {number} a @param {number} v
   */
  write(n, a, v) {
    if (this.onWrite !== null) this.onWrite(n, a, v);
    const m = this.machine;
    // A command write past the I/O deadline lands after the run (M1).
    if (n === 0 && a >= 0x6800 && a < 0x6820 && this.ioAt !== Infinity) {
      this.ioCatchUp();
    }
    m.busWrite(n, a, v);
    let sync = false;
    if (n === 0) {
      if (a >= 0x7800 && a < 0x8000) {
        // irq_1_ctrl_w, A11 = 1: mask off and CLEAR_LINE on main itself.
        this.cpus[0].irqLine = false;
        sync = true;
      } else if (a >= 0x8000 && a < 0x9000) {
        // sreset_w: set_input_line(RESET) on sub and sound, every write.
        const held = (a & 0x800) !== 0;
        this.syncQueue.push(() => this.setSubReset(held));
        sync = true;
      }
    } else if (n === 1) {
      if (a >= 0x6000 && a < 0x7000 && (a & 1) === 0) {
        this.cpus[1].irqLine = false;   // irq_2_ctrl_w, A0 = 0
        sync = true;
      }
    } else if (a >= 0x6000 && a < 0x8000) {
      // irq_3_ctrl_w: A13 = 1 ($6000-$7FFF) is mask off + CLEAR_LINE.
      this.cpus[2].irqLine = false;
      sync = true;
    }
    if (sync && this.syncOnLatch) this.abort = true;
  }

  /**
   * SRESET reaching the sub and sound CPUs (MAME: at the synchronize
   * point). Asserting suspends them; releasing resets them (device_reset,
   * then the reset-vector fetch, 4 cycles) and lets them run.
   * @param {boolean} held
   */
  setSubReset(held) {
    for (const n of [1, 2]) {
      if (held) {
        this.inReset[n] = true;
      } else if (this.inReset[n]) {
        this.inReset[n] = false;
        // The CPU "ate" time while suspended; it restarts at the base
        // time plus the vector fetch.
        this.local[n] = Math.max(this.local[n], this.t)
          + this.cpus[n].reset() * TICKS_PER_CYCLE;
        this.irq.inIrq[n] = false;
      }
    }
  }

  /** The current tick of the CPU executing now, or the base time. */
  now() {
    return this.cur < 0 ? this.t
      : this.stepT + this.cpus[this.cur].cyc * TICKS_PER_CYCLE;
  }

  /** Cycles since the current frame's vblank. */
  frameCycle() { return (this.now() - this.frameStartT) / TICKS_PER_CYCLE; }

  /** @param {number} reg @param {number} v */
  wsgWritten(reg, v) {
    if (this.onWsgWrite === null && !this.recordSound) return;
    const c = this.frameCycle();
    if (this.recordSound) this.wsgWrites.push([c, reg, v]);
    this.onWsgWrite?.(reg, v, c);
  }

  /** Watchdog kick (main $7800-$7FFF read, sound $2000-$3FFF access). */
  kick() {
    this.wd.armed = true;
    this.wd.lastKickT = this.now();
  }

  // ------------------------------------------------------- interrupts

  /**
   * The core is taking an interrupt (called after it stacked the state).
   * Remember where the handler's RTI will return to, and when it began.
   * @param {number} n
   */
  irqTaken(n) {
    const st = this.irq;
    if (st.inIrq[n]) { this.irqStats[n].nested += 1; return; }
    const cpu = this.cpus[n];
    st.inIrq[n] = true;
    st.exitS[n] = (cpu.s + 12) & 0xffff;
    // The stacked PC (bytes 10-11 of the frame) = where RTI returns.
    st.exitPc[n] = (this.peek(cpu.s + 10, n) << 8) | this.peek(cpu.s + 11, n);
    st.startT[n] = this.stepT;
    st.vblankT[n] = this.frameStartT;
  }

  /**
   * The handler has left: CC.I is clear again, or the CPU sleeps in CWAI.
   * @param {number} n @param {number} endT tick after the last instruction
   */
  irqDone(n, endT) {
    const st = this.irq;
    st.inIrq[n] = false;
    const base = st.vblankT[n];
    /** @type {IrqRecord} */
    const rec = {
      frame: base / FRAME_TICKS,
      cpu: n,
      start: (st.startT[n] - base) / TICKS_PER_CYCLE,
      end: (endT - base) / TICKS_PER_CYCLE,
    };
    const s = this.irqStats[n];
    s.count += 1;
    s.startMin = Math.min(s.startMin, rec.start);
    s.startMax = Math.max(s.startMax, rec.start);
    s.endMin = Math.min(s.endMin, rec.end);
    s.endMax = Math.max(s.endMax, rec.end);
    if (rec.end > CYCLES_PER_FRAME) s.overruns += 1;
    if (this.cpus[n].pc !== st.exitPc[n]) s.abnormal += 1;
    this.lastIrq[n] = rec;
    if (this.logIrqs) this.irqLog.push(rec);
  }

  /** The vblank instant (gapluso_state::vblank_irq). */
  vblank() {
    const m = this.machine;
    this.frameStartT = this.t;
    const running = [true, !this.inReset[1], !this.inReset[2]];
    for (let n = 0; n < 3; n += 1) {
      if (m.irqMask[n]) this.irq.everEnabled[n] = true;
      else if (running[n] && this.irq.everEnabled[n]) this.irqStats[n].lost += 1;
    }
    m.vblank();
    for (let n = 0; n < 3; n += 1) if (m.irqLine[n]) this.cpus[n].irqLine = true;
    if (m.io.pending.n56 || m.io.pending.n58) this.ioAt = this.t + IO_DELAY_TICKS;
  }

  // ----------------------------------------------------------- the run

  /**
   * Run CPU n for at least `cycles` cycles (instruction granularity), or
   * until it makes a line-changing write.
   * @param {number} n @param {number} cycles @returns {number} cycles run
   */
  execute(n, cycles) {
    const cpu = this.cpus[n];
    const base = this.local[n];
    const irq = this.irq;
    const track = this.trackStack;
    const romStart = ROM_START[n];
    this.cur = n;
    this.abort = false;
    let done = 0;
    while (done < cycles) {
      // Parked in CWAI/SYNC with nothing to wake it: eat the slice
      // (MAME's eat_remaining()).
      if (cpu.wait !== 0 && !cpu.canWake()) {
        cpu.cycles += cycles - done;
        done = cycles;
        break;
      }
      this.stepT = base + done * TICKS_PER_CYCLE;
      done += cpu.step();
      // The handler is over once the CPU is back to running with IRQs
      // unmasked (RTI restored CC.I = 0, or a non-local exit's ANDCC) or
      // waits in CWAI (which clears CC.I).
      if (irq.inIrq[n] && ((cpu.cc & CC_I) === 0 || cpu.wait !== 0)) {
        this.irqDone(n, base + done * TICKS_PER_CYCLE);
      }
      // S only means something once the program has loaded it (LDS).
      if (track && cpu.s < this.stackLow[n] && cpu.ldsEncountered) {
        this.stackLow[n] = cpu.s;
      }
      // Invariant: code runs from ROM. The core skips MAME's dummy reads
      // at PC+n (harmless only while PC is in ROM), and a PC outside ROM
      // is a runaway the oracle must report, not model.
      if (cpu.pc < romStart) this.runaway(n, cpu.pc);
      if (this.abort) break;
    }
    this.cur = -1;
    return done;
  }

  /**
   * A CPU's PC left ROM. Recorded in `runaways` (first 16); with
   * `strictPc` it throws.
   * @param {number} n @param {number} pc
   */
  runaway(n, pc) {
    const rec = { cpu: n, pc, frame: this.frame, from: this.cpus[n].ppc };
    this.runawayCount += 1;
    if (this.runaways.length < 16) this.runaways.push(rec);
    if (this.strictPc) {
      throw new Error(`${CPU_NAME[n]} PC left ROM: $${pc.toString(16)} `
        + `(from $${rec.from.toString(16)}, frame ${rec.frame})`);
    }
  }

  /**
   * One MAME timeslice ending at `limit` (ticks). Returns the time the
   * slice actually ended (earlier if a CPU aborted it).
   * @param {number} limit @returns {number}
   */
  timeslice(limit) {
    let target = limit;
    for (let n = 0; n < 3; n += 1) {
      const local = this.local[n];
      if (target - local < TICKS_PER_CYCLE) continue;
      const cycles = Math.floor((target - local) / TICKS_PER_CYCLE);
      const ran = this.inReset[n] ? cycles : this.execute(n, cycles);
      const now = local + ran * TICKS_PER_CYCLE;
      this.local[n] = now;
      // "if the new local time is less than our target, move the target
      // up, but not before the base" (device_scheduler::timeslice)
      if (now < target) target = Math.max(now, this.t);
    }
    return target;
  }

  /**
   * Run the board up to absolute tick `target`, firing vblanks and I/O
   * runs on the way. Stopping exactly at a vblank leaves it unfired (it
   * fires when the run resumes), so frame boundaries are "just before
   * vblank".
   * @param {number} target
   */
  advanceTo(target) {
    while (this.t < target) {
      if (this.t === this.nextVblankT) {
        this.vblank();
        this.nextVblankT += FRAME_TICKS;
      }
      if (this.ioAt <= this.t) {
        this.ioAt = Infinity;
        this.machine.ioUpdate();
      }
      const limit = Math.min(this.t + this.quantum * TICKS_PER_CYCLE,
        this.nextVblankT, this.ioAt, target);
      this.t = this.timeslice(limit);
      // The synchronize timers: queued line changes happen now.
      if (this.syncQueue.length > 0) {
        const q = this.syncQueue;
        this.syncQueue = [];
        for (const f of q) f();
      }
      if (this.wd.armed
        && this.t - this.wd.lastKickT > WATCHDOG_CYCLES * TICKS_PER_CYCLE) {
        this.watchdogFired();
      }
    }
    this.frame = Math.floor(this.t / FRAME_TICKS);
  }

  /**
   * MAME watchdog_fired(): schedule_soft_reset(). Every device resets: the
   * three CPUs restart from their vectors (sub/sound released, as at
   * power-on), machine_reset clears VINTON, the 56XX/58XX reset. RAM is
   * kept. (Approximate: this must never happen on a good run.)
   */
  watchdogFired() {
    this.wd.resets += 1;
    this.wd.armed = false;
    if (this.watchdogMode !== 'reset') return;
    this.machine.machineReset();
    for (let n = 0; n < 3; n += 1) {
      this.inReset[n] = false;
      this.cpus[n].irqLine = false;
      this.local[n] = this.t + this.cpus[n].reset() * TICKS_PER_CYCLE;
      this.irq.inIrq[n] = false;
    }
  }

  /**
   * Run one frame: apply this frame's scripted inputs, fire its vblank
   * (except at power-on) and run to the next vblank instant.
   */
  runFrame() {
    this.applyInputs(this.frame);
    this.wsgWrites = [];
    this.bangs = 0;
    this.advanceTo((this.frame + 1) * FRAME_TICKS);
  }

  /** @param {number} n */
  runFrames(n) {
    for (let i = 0; i < n; i += 1) this.runFrame();
  }

  /**
   * Run frames until `pred(board)` holds at a frame boundary.
   * @param {(b: Board) => boolean} pred @param {number} maxFrames
   * @returns {number} frames run
   */
  runUntil(pred, maxFrames) {
    for (let i = 0; i < maxFrames; i += 1) {
      if (pred(this)) return i;
      this.runFrame();
    }
    if (pred(this)) return maxFrames;
    throw new Error(`condition not reached in ${maxFrames} frames`);
  }

  // ------------------------------------------------------------- inputs

  /**
   * Press or release a switch (Machine.setInput names: coin1 coin2
   * service start1 start2 fire1 fire2 up down left right p2up ...).
   * @param {string} name @param {boolean} down
   */
  setInput(name, down) { this.machine.setInput(name, down); }

  /** @param {string} name @param {number} value DIP field port value */
  setDip(name, value) {
    this.machine.setDip(/** @type {'lives'} */ (name), value);
  }

  /**
   * Schedule an input change at the start of frame `frame`.
   * @param {number} frame @param {string} name @param {boolean} down
   */
  at(frame, name, down) {
    const list = this.inputEvents.get(frame) ?? [];
    list.push([name, down]);
    this.inputEvents.set(frame, list);
  }

  /**
   * Press `name` at frame `frame` and release it `hold` frames later.
   * @param {string} name @param {number} frame @param {number} [hold]
   */
  tap(name, frame, hold = 4) {
    this.at(frame, name, true);
    this.at(frame + hold, name, false);
  }

  /** @param {number} frame */
  applyInputs(frame) {
    const list = this.inputEvents.get(frame);
    if (list) {
      for (const [name, down] of list) this.setInput(name, down);
      this.inputEvents.delete(frame);
    }
    this.inputScript?.(frame, this);
  }

  // ----------------------------------------------------- instrumentation

  /**
   * Start collecting code coverage: instruction start addresses executed
   * and ROM addresses read as data (operand reads, pointers, vectors --
   * not opcode/operand fetches), per CPU. `ignoreReaders[n]` lists
   * instruction addresses whose data reads are not recorded (the ROM
   * checksum and RAM-test loops read every byte of ROM, which says
   * nothing about what is data).
   * @param {{ ignoreReaders?: ReadonlyArray<ReadonlyArray<number>> }} [opts]
   */
  enableCoverage(opts = {}) {
    if (!this.coverage) {
      this.coverage = {
        exec: [0, 1, 2].map(() => new Uint16Array(0x10000)),
        data: [0, 1, 2].map(() => new Uint8Array(0x10000)),
      };
    }
    const cov = this.coverage;
    this.cpus.forEach((cpu, n) => {
      const data = cov.data[n];
      const romStart = ROM_START[n];
      const proto = Object.getPrototypeOf(cpu);
      const ignore = new Set(opts.ignoreReaders?.[n] ?? []);
      // rd() is the core's data-path read (fetch() is the opcode/operand
      // path), so shadowing it on the instance sees exactly the data reads.
      /** @param {number} addr @returns {number} */
      cpu.rd = function rd(addr) {
        if (addr >= romStart && !ignore.has(this.ppc)) data[addr] = 1;
        return proto.rd.call(this, addr);
      };
    });
    this.installTrace();
  }

  /** Wire the cores' trace hooks for onExec and/or coverage. */
  installTrace() {
    const cov = this.coverage;
    this.cpus.forEach((cpu, n) => {
      const exec = cov ? cov.exec[n] : null;
      const fn = this._onExec;
      if (!exec && !fn) { cpu.trace = null; return; }
      cpu.trace = (pc, c) => {
        if (exec) {
          const v = 0x100 | c.dp;
          const o = exec[pc];
          if (o !== v) exec[pc] = o === 0 ? v : 0xffff;
        }
        if (fn) fn(n, pc, c);
      };
    });
  }

  /**
   * Coverage as sorted address lists.
   * @param {number} n CPU
   * @returns {{ exec: number[], dataRead: number[], dp: Map<number, number> }}
   */
  coverageOf(n) {
    if (!this.coverage) throw new Error('coverage not enabled');
    const list = (/** @type {Uint8Array|Uint16Array} */ map) => {
      const out = [];
      for (let a = 0; a < 0x10000; a += 1) if (map[a]) out.push(a);
      return out;
    };
    /** @type {Map<number, number>} DP of each executed address (single DP only) */
    const dp = new Map();
    const exec = this.coverage.exec[n];
    for (let a = 0; a < 0x10000; a += 1) {
      if (exec[a] !== 0 && exec[a] !== 0xffff) dp.set(a, exec[a] & 0xff);
    }
    return { exec: list(exec), dataRead: list(this.coverage.data[n]), dp };
  }

  // ----------------------------------------------------------- snapshots

  /** @returns {BoardState} */
  getState() {
    if (this.cur >= 0 || this.syncQueue.length > 0) {
      throw new Error('getState() only between slices');
    }
    return {
      cpus: this.cpus.map((c) => c.getState()),
      machine: this.machine.getState(),
      inputs: structuredClone(this.machine.io.inputs),
      t: this.t,
      local: [...this.local],
      nextVblankT: this.nextVblankT,
      ioAt: this.ioAt,
      inReset: [...this.inReset],
      frame: this.frame,
      frameStartT: this.frameStartT,
      wd: { ...this.wd },
      irq: {
        inIrq: [...this.irq.inIrq],
        exitS: [...this.irq.exitS],
        exitPc: [...this.irq.exitPc],
        startT: [...this.irq.startT],
        vblankT: [...this.irq.vblankT],
        everEnabled: [...this.irq.everEnabled],
      },
    };
  }

  /** @param {BoardState} s */
  setState(s) {
    s.cpus.forEach((c, n) => this.cpus[n].setState(c));
    this.machine.setState(s.machine);
    const inp = this.machine.io.inputs;
    Object.assign(inp, structuredClone(s.inputs));
    this.t = s.t;
    this.local = [...s.local];
    this.nextVblankT = s.nextVblankT;
    this.ioAt = s.ioAt;
    this.inReset = [...s.inReset];
    this.frame = s.frame;
    this.frameStartT = s.frameStartT;
    this.wd = { ...s.wd };
    this.irq = {
      inIrq: [...s.irq.inIrq],
      exitS: [...s.irq.exitS],
      exitPc: [...s.irq.exitPc],
      startT: [...s.irq.startT],
      vblankT: [...s.irq.vblankT],
      everEnabled: [...s.irq.everEnabled],
    };
    this.syncQueue = [];
    this.abort = false;
    this.cur = -1;
  }
}

/** @returns {IrqStats} */
function newStats() {
  return {
    count: 0,
    startMin: Infinity,
    startMax: -Infinity,
    endMin: Infinity,
    endMax: -Infinity,
    overruns: 0,
    lost: 0,
    abnormal: 0,
    nested: 0,
  };
}

export { CPU, CYCLES_PER_FRAME, CC_I, CC_F };

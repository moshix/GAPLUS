// Copyright 2026 by Moshix
/**
 * The Gaplus board, as far as the ported game code can observe it.
 *
 * The port keeps the original memory layout instead of inventing an object
 * model: game state lives at the addresses the 1984 code used, so the
 * differential test against the three-6809 oracle is a byte-for-byte
 * comparison, and any line of the listings can be read against the port.
 * docs/hardware.md section 3 is the memory map implemented here.
 *
 * DESIGN DECISIONS
 *
 * 1. One 64 KB array in MAIN-CPU address space. `mem[a]` is the byte the
 *    main CPU sees at RAM address `a`:
 *
 *      $0000-$07FF  tile RAM            (main + sub, same addresses)
 *      $0800-$1FFF  work + sprite RAM   (main + sub, same addresses)
 *      $6000-$603F  15XX sound registers (sound CPU $0000-$003F)
 *      $6040-$63FF  RAM shared with sound (sound CPU $0040-$03FF)
 *
 *    Everything else in `mem` stays 0 (ROM is read from romdata.js, I/O
 *    lives in its devices). A lockstep test therefore compares the oracle's
 *    9 KB of RAM with `mem` through {@link RAM_REGIONS} and nothing else;
 *    the oracle only has to express its sound RAM at $6000 + offset.
 *
 * 2. Per-CPU access goes through CPU views with one interface:
 *
 *      m.peek / m.poke / m.peek16 / m.poke16      main CPU (the Machine)
 *      m.sub.peek(a) ...                          sub CPU address space
 *      m.sound.peek(a) ...                        sound CPU address space
 *      m.cpuView('main'|'sub'|'sound')            the same three objects
 *
 *    Each view decodes addresses as that CPU's bus does, including the
 *    side effects of I/O and latch addresses, so ported code uses the
 *    addresses of its own listing verbatim: sound code writes
 *    `m.sound.poke(0x0040, v)` (lands in mem[$6040]); sub code writes
 *    `m.sub.poke(0x6080, 0)` (sub IRQ off, not the 15XX). `m.main` is the
 *    Machine itself.
 *
 * 3. Pointers that may point into ROM are followed with
 *    `m.read(cpu, addr)` / `m.read16(cpu, addr)` (views: `read(addr)`),
 *    which resolve to that CPU's ROM when addr is in its ROM window
 *    (main/sub >= $A000, sound >= $E000). `peek` does the same (it is
 *    exactly what the CPU would read); `read` is the name to use when the
 *    intent is "table or pointer that may be ROM".
 *
 * 4. 16-bit accesses are big-endian (6809): `peek16(a)` = mem[a] << 8 |
 *    mem[a+1]; `poke16` writes the high byte first, as STD/STX do.
 *
 * 5. Address-decoded latches are machine state (read by the scheduler and
 *    the renderer, written only through poke): `irqMask[cpu]`,
 *    `irqLine[cpu]`, `sreset` (sub + sound held in reset; `soundEnable`
 *    is its complement), `io.inReset` (FRESET), `starCtrl[0..3]`
 *    ($A000-$A003), `watchdogKicks`. The latch data comes from ADDRESS
 *    bits (A11 main, A0 sub, A13 sound), never from the data bus.
 *
 * 6. The machine never imports game code. The scheduler installs `hooks`
 *    to hear about latch changes (and to run a pending IRQ when a CPU
 *    clears its I mask).
 *
 * No browser or Node dependencies: this module is shared by the page and
 * the tests.
 */

import { romByte } from '../game/romdata.js';
import { GaplusIo, createInputState, setDip } from './namcoio.js';

/** @typedef {import('../game/romdata.js').Cpu} Cpu */
/** @typedef {import('./namcoio.js').InputState} InputState */
/** @typedef {import('./namcoio.js').GaplusIoState} GaplusIoState */

/** CPU numbers (index of the per-CPU latch arrays). */
export const CPU = Object.freeze({ MAIN: 0, SUB: 1, SOUND: 2 });

/** CPU names by number. @type {readonly Cpu[]} */
export const CPU_NAMES = Object.freeze(['main', 'sub', 'sound']);

/** 24.576 MHz / 16. */
export const CPU_CLOCK = 1536000;
/**
 * Frames per second: 1,536,000 / 25,344 = 60.6060606... Hz, the hardware
 * rate (24.576 MHz / 4 / (384 x 264)) and exactly what the oracle runs.
 * MAME's literal `set_refresh_hz(60.606060)` is 6e-7 Hz slower (0.00025
 * cycles per frame); src/audio/wsg15xx.js FRAME_RATE is the same
 * hardware value, computed from the master clock.
 */
export const FRAME_RATE = CPU_CLOCK / 25344;
/** CPU cycles per frame, as the oracle runs it (docs/hardware.md s. 2). */
export const CYCLES_PER_FRAME = 25344;

/** Sound CPU address $0000 is main CPU address $6000 (1 KB shared). */
export const SOUND_RAM_BASE = 0x6000;
/** Size of the main/sound shared window. */
export const SOUND_RAM_SIZE = 0x400;

/**
 * Every byte of RAM on the board, in main-CPU addresses. This is what a
 * lockstep or routine test compares (minus the stacks).
 * @type {ReadonlyArray<Readonly<{ name: string, start: number, end: number }>>}
 */
export const RAM_REGIONS = Object.freeze([
  Object.freeze({ name: 'tiles', start: 0x0000, end: 0x0800 }),
  Object.freeze({ name: 'ram3M', start: 0x0800, end: 0x1000 }),
  Object.freeze({ name: 'ram3K', start: 0x1000, end: 0x1800 }),
  Object.freeze({ name: 'ram3L', start: 0x1800, end: 0x2000 }),
  Object.freeze({ name: 'wsg', start: 0x6000, end: 0x6040 }),
  Object.freeze({ name: 'sndram', start: 0x6040, end: 0x6400 }),
]);

/**
 * The S stacks, which RAM comparisons exempt (docs/porting-guide.md s. 5).
 * `top` is the initial S from the ROMs' LDS instructions ([ROM]: main
 * $E00F/$B705/$D152 `LDS #$1600`, sub $E006/$E181 `LDS #$1D80`, sound
 * $E047 `LDS #$0400`); S grows down from it. `low` is the lowest S seen:
 * measured on the oracle board (test/m6809/board.mjs, tools/coverage.mjs)
 * over ~78,000 frames: 20,000 of attract, random-input 1P and 2P games to
 * game over, the challenging stage, PARSEC 11, a high-score entry, the
 * service mode and the operator-stats DIP. Main reaches $15E2 when the
 * vblank IRQ (12 bytes) lands inside $D07A's call chain at game start
 * (an earlier 16,000-frame measurement had $15E4); the service mode only
 * reaches $15FA. The stack occupies [low, top). `mainTop`/`mainLow`
 * are the same addresses in main-CPU space, i.e. indices into `mem`.
 * No code path executed PSHU/PULU, so U is never a stack.
 */
export const STACKS = Object.freeze({
  main: Object.freeze({ top: 0x1600, low: 0x15e2, mainTop: 0x1600, mainLow: 0x15e2 }),
  sub: Object.freeze({ top: 0x1d80, low: 0x1d74, mainTop: 0x1d80, mainLow: 0x1d74 }),
  sound: Object.freeze({ top: 0x0400, low: 0x03ec, mainTop: 0x6400, mainLow: 0x63ec }),
});

/**
 * Sound CPU address -> index in `mem`, or -1 when it is not shared RAM.
 * @param {number} addr @returns {number}
 */
export function soundToMain(addr) {
  const a = addr & 0xffff;
  return a < SOUND_RAM_SIZE ? SOUND_RAM_BASE + a : -1;
}

/**
 * Main CPU address -> sound CPU address, or -1 outside $6000-$63FF.
 * @param {number} addr @returns {number}
 */
export function mainToSound(addr) {
  const a = addr & 0xffff;
  return a >= SOUND_RAM_BASE && a < SOUND_RAM_BASE + SOUND_RAM_SIZE
    ? a - SOUND_RAM_BASE : -1;
}

/**
 * Hooks the scheduler (or audio/video side) installs. All optional.
 * @typedef {object} MachineHooks
 * @property {(cpu: number, on: boolean) => void} [onIrqMask]
 *   an IRQ mask latch was written (every write, not only changes)
 * @property {(cpu: number) => void} [onCli]
 *   a CPU cleared its CC.I (ANDCC #$EF): a pending IRQ may be taken now
 * @property {(held: boolean) => void} [onSreset]
 *   SRESET changed: sub + sound enter (true) or leave (false) reset
 * @property {(held: boolean) => void} [onFreset]  FRESET written
 * @property {(reg: number, value: number) => void} [onWsgWrite]
 *   15XX register $00-$3F written (by main or sound)
 * @property {(reg: number, value: number) => void} [onStarCtrl]
 *   starfield control register 0-3 written
 * @property {(cpu: number) => void} [onWatchdog]  watchdog kicked
 */

/**
 * Snapshot of the whole board as the port sees it.
 * @typedef {object} MachineState
 * @property {Uint8Array} mem
 * @property {number[]} irqMask
 * @property {boolean[]} irqLine
 * @property {boolean[]} iMask
 * @property {boolean} sreset
 * @property {number[]} starCtrl
 * @property {number} watchdogKicks
 * @property {number} writes
 * @property {number[]} charged
 * @property {GaplusIoState} io
 */

/**
 * The same interface for each CPU's address space. The main CPU's view is
 * the Machine itself; `m.sub` and `m.sound` are instances of this class.
 */
export class CpuView {
  /**
   * @param {Machine} machine @param {number} cpu {@link CPU}
   */
  constructor(machine, cpu) {
    /** The board. */
    this.machine = machine;
    /** CPU number ({@link CPU}). */
    this.cpuNo = cpu;
    /** CPU name, as romdata.js and the registries use it. */
    this.cpu = CPU_NAMES[cpu];
  }

  /** CPU read with side effects. @param {number} addr @returns {number} */
  peek(addr) { return this.machine.busRead(this.cpuNo, addr); }

  /** CPU write with side effects. @param {number} addr @param {number} v */
  poke(addr, v) { this.machine.busWrite(this.cpuNo, addr, v); }

  /** Big-endian word (LDD/LDX). @param {number} addr @returns {number} */
  peek16(addr) {
    return (this.peek(addr) << 8) | this.peek((addr + 1) & 0xffff);
  }

  /** Big-endian word, high byte written first (STD/STX). @param {number} addr @param {number} v */
  poke16(addr, v) {
    this.poke(addr, (v >> 8) & 0xff);
    this.poke((addr + 1) & 0xffff, v & 0xff);
  }

  /** Read through a pointer that may be ROM. @param {number} addr @returns {number} */
  read(addr) { return this.machine.busRead(this.cpuNo, addr); }

  /** Big-endian word through a pointer that may be ROM. @param {number} addr @returns {number} */
  read16(addr) { return this.peek16(addr); }

  /**
   * Store `v` into `n` bytes upwards from `addr` (a `sta ,x+` loop).
   * @param {number} addr @param {number} v @param {number} n
   */
  fill(addr, v, n) {
    for (let i = 0; i < n; i += 1) this.poke((addr + i) & 0xffff, v);
  }

  /**
   * Copy `n` bytes upwards, byte by byte (a `lda ,x+ / sta ,u+` loop), so
   * an overlapping copy smears exactly as on the CPU. The source may be
   * ROM. Word-wise copies (`ldd ,x++ / std ,u++`) are the same for
   * non-overlapping ranges.
   * @param {number} dst @param {number} src @param {number} n
   */
  copy(dst, src, n) {
    for (let i = 0; i < n; i += 1) {
      this.poke((dst + i) & 0xffff, this.read((src + i) & 0xffff));
    }
  }

  /** `ORCC #$10`: mask IRQs on this CPU. */
  sei() { this.machine.iMask[this.cpuNo] = true; }

  /**
   * `ANDCC #$EF`: unmask IRQs. If vblank asserted this CPU's line, the
   * scheduler's `onCli` hook takes the interrupt right here, as the 6809
   * does after the ANDCC.
   */
  cli() {
    this.machine.iMask[this.cpuNo] = false;
    this.machine.hooks.onCli?.(this.cpuNo);
  }

  /** Charge measured CPU time to this CPU. @param {number} cycles */
  charge(cycles) { this.machine.charged[this.cpuNo] += cycles; }
}

export class Machine extends CpuView {
  constructor() {
    // A CpuView whose machine is itself: `m.peek` is the main CPU's read.
    super(/** @type {Machine} */ (/** @type {unknown} */ (null)), CPU.MAIN);
    this.machine = this;

    /** All RAM, in main-CPU addresses (see the file header). */
    this.mem = new Uint8Array(0x10000);
    /** Tile codes $0000-$03FF and attributes $0400-$07FF. */
    this.videoRam = this.mem.subarray(0x0000, 0x0800);
    /** Work RAM with the sprite registers, $0800-$1FFF. */
    this.workRam = this.mem.subarray(0x0800, 0x2000);
    /** The 1 KB shared with the sound CPU; index = sound CPU address. */
    this.soundRam = this.mem.subarray(SOUND_RAM_BASE, SOUND_RAM_BASE + SOUND_RAM_SIZE);

    /** The main CPU's view (this object). */
    this.main = this;
    /** The sub CPU's view. */
    this.sub = new CpuView(this, CPU.SUB);
    /** The sound CPU's view. */
    this.sound = new CpuView(this, CPU.SOUND);

    /** The three custom I/O chips and the input state they sample. */
    this.io = new GaplusIo(createInputState());

    /** @type {MachineHooks} */
    this.hooks = {};

    this.initLatches();
  }

  /** Latches and counters at power-on. */
  initLatches() {
    /**
     * IRQ mask latches (MAME main/sub/sub2_irq_mask), 0 at power-on. The
     * IRQ line is asserted at vblank only while the mask is 1; there is no
     * pending latch, so a vblank with the mask at 0 is lost.
     */
    this.irqMask = [0, 0, 0];
    /** IRQ input lines: level, asserted at vblank, cleared by mask-off. */
    this.irqLine = [false, false, false];
    /** CC.I of each CPU; a 6809 comes out of reset with I = 1. */
    this.iMask = [true, true, true];
    /**
     * SRESET: true while the sub and sound CPUs are held in reset (and the
     * 15XX is muted). MAME lets them run from power-on until the main
     * CPU's second instruction (`STA $8C00`) stops them; starting with
     * them held is equivalent (docs/hardware.md s. 4.5).
     */
    this.sreset = true;
    /** Starfield control $A000-$A003 (`reg[addr & 3]`). */
    this.starCtrl = new Uint8Array(4);
    /** Watchdog kicks (main reads $7800-$7FFF, sound $2000-$3FFF). */
    this.watchdogKicks = 0;
    /** Writes performed, for the scheduler's "did anything happen". */
    this.writes = 0;
    /** CPU time charged by long routines, per CPU (see charge()). */
    this.charged = [0, 0, 0];
  }

  /** 15XX output enable: the complement of SRESET. @returns {boolean} */
  get soundEnable() { return !this.sreset; }

  /** The live input state (coins, starts, sticks, DIPs). @returns {InputState} */
  get inputs() { return this.io.inputs; }

  /**
   * The view of one CPU.
   * @param {Cpu|number} cpu name, or number ({@link CPU}) @returns {CpuView}
   */
  cpuView(cpu) {
    if (cpu === 'main' || cpu === CPU.MAIN) return this;
    if (cpu === 'sub' || cpu === CPU.SUB) return this.sub;
    if (cpu === 'sound' || cpu === CPU.SOUND) return this.sound;
    throw new Error(`unknown CPU ${String(cpu)}`);
  }

  /**
   * Read through a pointer that may point into ROM, as `cpu` would.
   * (On the Machine this takes the CPU; on a view, `read(addr)`.) The
   * CPU is a name or a {@link CPU} number; anything else throws (a
   * numeric id used to fall through to the sound CPU's map).
   * @param {Cpu|number} cpu @param {number} [addr] @returns {number}
   */
  // @ts-ignore -- deliberately differs from CpuView.read(addr)
  read(cpu, addr) {
    if (addr === undefined) return this.busRead(CPU.MAIN, /** @type {number} */ (/** @type {unknown} */ (cpu)));
    return this.cpuView(cpu).peek(addr);
  }

  /**
   * Big-endian word through a pointer that may be ROM.
   * @param {Cpu|number} cpu @param {number} [addr] @returns {number}
   */
  // @ts-ignore -- deliberately differs from CpuView.read16(addr)
  read16(cpu, addr) {
    if (addr === undefined) return this.peek16(/** @type {number} */ (/** @type {unknown} */ (cpu)));
    const v = this.cpuView(cpu);
    return (v.peek(addr) << 8) | v.peek((addr + 1) & 0xffff);
  }

  // ------------------------------------------------------------ the buses

  /**
   * One CPU read, decoded as that CPU's address map does it.
   * Unmapped addresses read $00 (MAME's unmap value).
   * @param {number} cpu @param {number} addr @returns {number}
   */
  busRead(cpu, addr) {
    const a = addr & 0xffff;
    if (cpu === CPU.MAIN) {
      if (a < 0x2000) return this.mem[a];
      if (a >= 0xa000) return romByte('main', a);
      if (a >= 0x6000 && a < 0x6400) return this.mem[a];
      if (a >= 0x6800 && a < 0x6830) return this.io.read(a);
      if (a >= 0x7800 && a < 0x8000) { this.kickWatchdog(cpu); return 0; }
      return 0;
    }
    if (cpu === CPU.SUB) {
      if (a < 0x2000) return this.mem[a];
      if (a >= 0xa000) return romByte('sub', a);
      return 0;
    }
    if (a < SOUND_RAM_SIZE) return this.mem[SOUND_RAM_BASE + a];
    if (a >= 0xe000) return romByte('sound', a);
    if (a >= 0x2000 && a < 0x4000) { this.kickWatchdog(cpu); return 0; }
    return 0;
  }

  /**
   * One CPU write, decoded as that CPU's address map does it, with every
   * latch side effect. Writes to ROM and unmapped space are ignored.
   * @param {number} cpu @param {number} addr @param {number} value
   */
  busWrite(cpu, addr, value) {
    const a = addr & 0xffff;
    const v = value & 0xff;
    this.writes += 1;
    if (cpu === CPU.MAIN) {
      if (a < 0x2000) { this.mem[a] = v; return; }
      if (a >= 0x6000 && a < 0x6400) { this.writeSoundRam(a - SOUND_RAM_BASE, v); return; }
      if (a >= 0x6800 && a < 0x6830) { this.io.write(a, v); return; }
      // $7000-$7FFF irq_1_ctrl_w: A11 = 0 ($7000-$77FF) enables.
      if (a >= 0x7000 && a < 0x8000) { this.setIrqMask(CPU.MAIN, (a & 0x800) === 0); return; }
      // $8000-$8FFF sreset_w: A11 = 0 releases sub + sound (and unmutes).
      if (a >= 0x8000 && a < 0x9000) { this.setSreset((a & 0x800) !== 0); return; }
      // $9000-$9FFF freset_w: A11 = 0 releases the 56XX/58XX.
      if (a >= 0x9000 && a < 0xa000) { this.setFreset((a & 0x800) !== 0); return; }
      // $A000-$A7FF starfield_control_w: reg[offset & 3].
      if (a >= 0xa000 && a < 0xa800) {
        this.starCtrl[a & 3] = v;
        this.hooks.onStarCtrl?.(a & 3, v);
      }
      return;
    }
    if (cpu === CPU.SUB) {
      if (a < 0x2000) { this.mem[a] = v; return; }
      // $6000-$6FFF irq_2_ctrl_w: A0 = 1 enables, A0 = 0 disables.
      if (a >= 0x6000 && a < 0x7000) this.setIrqMask(CPU.SUB, (a & 1) === 1);
      // $500F (written 256 times at boot) is unmapped in MAME.
      return;
    }
    if (a < SOUND_RAM_SIZE) { this.writeSoundRam(a, v); return; }
    if (a >= 0x2000 && a < 0x4000) { this.kickWatchdog(cpu); return; }
    // $4000-$7FFF irq_3_ctrl_w: A13 = 0 ($4000-$5FFF) enables.
    if (a >= 0x4000 && a < 0x8000) this.setIrqMask(CPU.SOUND, (a & 0x2000) === 0);
  }

  /**
   * The 1 KB shared by main ($6000) and sound ($0000). Offsets $00-$3F are
   * the 15XX registers (readable as written).
   * @param {number} off 0-$3FF @param {number} v
   */
  writeSoundRam(off, v) {
    this.mem[SOUND_RAM_BASE + off] = v;
    if (off < 0x40) this.hooks.onWsgWrite?.(off, v);
  }

  // ------------------------------------------------------------ latches

  /**
   * Write an IRQ mask latch. Turning a mask off also clears that CPU's
   * IRQ line (the acknowledge); turning it on never asserts the line.
   * @param {number} cpu @param {boolean} on
   */
  setIrqMask(cpu, on) {
    this.irqMask[cpu] = on ? 1 : 0;
    if (!on) this.irqLine[cpu] = false;
    this.hooks.onIrqMask?.(cpu, on);
  }

  /**
   * SRESET. A change of the line resets the sub and sound 6809s (MAME
   * resets a CPU when RESET is released; device_reset sets CC.I and
   * CC.F), so neither can take an IRQ until its code runs ANDCC.
   * @param {boolean} held
   */
  setSreset(held) {
    const was = this.sreset;
    this.sreset = held;
    if (was !== held) {
      this.iMask[CPU.SUB] = true;
      this.iMask[CPU.SOUND] = true;
      this.hooks.onSreset?.(held);
    }
  }

  /**
   * FRESET. Every write re-drives the chips' reset line; asserting it
   * again re-initialises the coin counters again (MAME does the same).
   * @param {boolean} held
   */
  setFreset(held) {
    this.io.setReset(held);
    this.hooks.onFreset?.(held);
  }

  /** @param {number} cpu */
  kickWatchdog(cpu) {
    this.watchdogKicks += 1;
    this.hooks.onWatchdog?.(cpu);
  }

  /** @returns {boolean} whether the sub and sound CPUs are running */
  get subsRunning() { return !this.sreset; }

  /**
   * Is an IRQ ready to be taken by `cpu` now? (line asserted, CC.I clear,
   * and for sub/sound: not held in reset)
   * @param {number} cpu @returns {boolean}
   */
  irqPending(cpu) {
    if (cpu !== CPU.MAIN && this.sreset) return false;
    return this.irqLine[cpu] && !this.iMask[cpu];
  }

  /**
   * Mark that `cpu` has taken its IRQ: the 6809 sets CC.I on entry (and
   * RTI restores the stacked CC). The line stays asserted until the
   * handler writes the mask-off latch.
   * @param {number} cpu
   */
  enterIrq(cpu) { this.iMask[cpu] = true; }

  /**
   * The vblank instant, in MAME's order (`gapluso_state::vblank_irq`):
   * assert main's IRQ if its mask is set, arm the I/O chip runs, then the
   * sub's and the sound CPU's IRQs. The renderer draws from RAM *before*
   * this, and the host calls {@link ioUpdate} 50 us (76.8 cycles) later.
   */
  vblank() {
    if (this.irqMask[CPU.MAIN]) this.irqLine[CPU.MAIN] = true;
    this.io.vblank();
    if (this.irqMask[CPU.SUB]) this.irqLine[CPU.SUB] = true;
    if (this.irqMask[CPU.SOUND]) this.irqLine[CPU.SOUND] = true;
  }

  /** 50 us after vblank: the 56XX/58XX frame runs. */
  ioUpdate() { this.io.update(); }

  // ------------------------------------------------------------- inputs

  /**
   * Press or release a switch. Names: coin1 coin2 service start1 start2
   * fire1 fire2 up down left right p2up p2down p2left p2right.
   * @param {string} name @param {boolean} down
   */
  setInput(name, down) {
    const inp = this.io.inputs;
    const dirs = ['up', 'down', 'left', 'right'];
    if (dirs.includes(name)) {
      inp.p1[/** @type {'up'} */ (name)] = down;
    } else if (name.startsWith('p2') && dirs.includes(name.slice(2))) {
      inp.p2[/** @type {'up'} */ (name.slice(2))] = down;
    } else if (['coin1', 'coin2', 'service', 'start1', 'start2', 'fire1',
      'fire2'].includes(name)) {
      inp[/** @type {'coin1'} */ (name)] = down;
    } else {
      throw new Error(`unknown input ${name}`);
    }
  }

  /**
   * Set a DIP field (see namcoio.js DIP_FIELDS), by port value.
   * @param {keyof typeof import('./namcoio.js').DIP_FIELDS} name
   * @param {number} value
   */
  setDip(name, value) { setDip(this.io.inputs, name, value); }

  // ------------------------------------------------------------- resets

  /**
   * Power-on: all RAM, latches and I/O chip state cleared. The input
   * state (including DIPs) is kept: it is the outside world.
   */
  reset() {
    this.mem.fill(0);
    const inputs = this.io.inputs;
    const onBang = this.io.onBang;
    this.io = new GaplusIo(inputs, { onBang });
    this.initLatches();
  }

  /**
   * Machine (soft/watchdog) reset, MAME `machine_reset` plus the devices:
   * VINTON (sub IRQ mask) and the sub IRQ line are cleared, the other
   * masks are not; the 56XX/58XX nibble RAM is cleared; every CPU comes
   * out of reset with CC.I set. RAM is untouched.
   */
  machineReset() {
    this.irqMask[CPU.SUB] = 0;
    this.irqLine[CPU.SUB] = false;
    this.iMask = [true, true, true];
    this.io.machineReset();
  }

  // ----------------------------------------------------------- snapshots

  /** @returns {MachineState} */
  getState() {
    return {
      mem: this.mem.slice(),
      irqMask: [...this.irqMask],
      irqLine: [...this.irqLine],
      iMask: [...this.iMask],
      sreset: this.sreset,
      starCtrl: Array.from(this.starCtrl),
      watchdogKicks: this.watchdogKicks,
      writes: this.writes,
      charged: [...this.charged],
      io: this.io.getState(),
    };
  }

  /** @param {MachineState} s */
  setState(s) {
    this.mem.set(s.mem);
    this.irqMask = [...s.irqMask];
    this.irqLine = [...s.irqLine];
    this.iMask = [...s.iMask];
    this.sreset = s.sreset;
    this.starCtrl.set(s.starCtrl);
    this.watchdogKicks = s.watchdogKicks;
    this.writes = s.writes;
    this.charged = [...s.charged];
    this.io.setState(s.io);
  }
}

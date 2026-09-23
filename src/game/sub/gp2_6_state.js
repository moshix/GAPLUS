// Copyright 2026 by Moshix
/**
 * Values the sub CPU's gp2-6.11b code yields to the scheduler, and the
 * timed bus access every routine of the chip goes through.
 *
 * The markers are registered symbols (`Symbol.for('gaplus.SPIN')`,
 * `'gaplus.busy'`, `'gaplus.rendezvous'`, `'gaplus.sync'`), the same
 * values src/game/scheduler.js exports, so this chip does not import
 * the scheduler. See docs/modules/sub-E.md for how it treats each one.
 *
 *   yield            (undefined) CWAI #$EF: wait for the next vblank IRQ
 *   yield SYNC       a timing point: the charged cycles so far are the
 *                    start of the next instruction, which touches shared
 *                    memory (below)
 *   yield SPIN       the boot foreground polls $0800 for the main CPU's
 *                    $11: resolves within the frame, when main writes it
 *   yield BUSY       after each charged, fruitless pass of sub_EA4C's
 *                    slot search (no free formation slot: only the main
 *                    CPU can end it; IRQs are enabled there)
 *   yield RENDEZVOUS irq_sub polls frame_sync ($10AF) for the main IRQ
 *                    handler's $22: run the main handler, then resume
 *
 * The symbol keys match the main CPU porters' (gp2_2b_state.js SPIN,
 * gp2_3b_state.js BUSY and RENDEZVOUS), so all three are one value.
 */

/** Foreground poll on another CPU's foreground (boot handshake). */
export const SPIN = Symbol.for('gaplus.SPIN');

/** IRQ handler poll on the main CPU's IRQ handler (frame_sync $10AF). */
export const RENDEZVOUS = Symbol.for('gaplus.rendezvous');

/** Foreground busy loop that only another CPU can end. */
export const BUSY = Symbol.for('gaplus.busy');

// ------------------------------------------------------ timed bus access

/**
 * Timed bus access for the sub CPU's gp2-6.11b code.
 *
 * THE CONTRACT (the whole chip). Every instruction charges its 6809
 * cycles to the sub CPU (`m.sub.charge`, MAME's counts as the oracle's
 * core has them), and every instruction that touches memory another CPU
 * or the scheduler can see -- RAM $0000-$1FFF (all of it is shared with
 * the main CPU) or the IRQ latch $6000-$6FFF -- is preceded by
 * `yield SYNC`, with the cycles of everything before it already charged.
 * The instruction's own cycles are charged after its access. So at each
 * SYNC the sub's charged time is exactly the cycle at which the ROM
 * starts that instruction, and the scheduler (src/game/scheduler.js)
 * orders the access against the main CPU's the way MAME's 256-cycle
 * slices do. ROM reads (tables, the pointers that land in ROM) are not
 * observable and do not SYNC. The stack is private and not modelled.
 *
 * The helpers below do "SYNC if observable, access, charge" for one
 * instruction; code that is not an access charges with `s.charge(n)`.
 * Tested against the oracle's core instruction by instruction
 * (test/oracle/sub-gp2_6-kit.test.mjs `sameTiming`).
 *
 *   const a = yield* rd(s, 0x10ac, 4);      // $E341: lda <$AC
 *   yield* wr(s, 0x0849, 1, 5);             // sta $0849
 *   yield* rmw(s, 0x107a, inc8v, 6);        // inc <$7A
 */

/** Scheduler timing point (the registered symbol of scheduler.js). */
export const SYNC = Symbol.for('gaplus.sync');

/** @typedef {import('../../machine/machine.js').CpuView} CpuView */

/**
 * Can another CPU (or the scheduler) observe an access to `a`?
 * @param {number} a sub-CPU address @returns {boolean}
 */
export const shared = (a) => {
  const x = a & 0xffff;
  return x < 0x2000 || (x >= 0x6000 && x < 0x7000);
};

/**
 * One-byte load (`lda`, `ldb`, `cmpa`, `adda`, `anda`, `tst`...).
 * @param {CpuView} s @param {number} a @param {number} cyc
 * @returns {Generator<symbol, number, unknown>}
 */
export function* rd(s, a, cyc) {
  if (shared(a)) yield SYNC;
  const v = s.read(a & 0xffff);
  s.charge(cyc);
  return v;
}

/**
 * Two-byte load (`ldd`, `ldx`, `ldu`, `cmpx`, `addd`...), big-endian.
 * @param {CpuView} s @param {number} a @param {number} cyc
 * @returns {Generator<symbol, number, unknown>}
 */
export function* rd16(s, a, cyc) {
  if (shared(a) || shared(a + 1)) yield SYNC;
  const v = s.read16(a & 0xffff);
  s.charge(cyc);
  return v;
}

/**
 * One-byte store (`sta`, `stb`).
 * @param {CpuView} s @param {number} a @param {number} v @param {number} cyc
 * @returns {Generator<symbol, void, unknown>}
 */
export function* wr(s, a, v, cyc) {
  if (shared(a)) yield SYNC;
  s.poke(a & 0xffff, v & 0xff);
  s.charge(cyc);
}

/**
 * Two-byte store (`std`, `stx`, `stu`, `sty`): high byte first.
 * @param {CpuView} s @param {number} a @param {number} v @param {number} cyc
 * @returns {Generator<symbol, void, unknown>}
 */
export function* wr16(s, a, v, cyc) {
  if (shared(a) || shared(a + 1)) yield SYNC;
  s.poke16(a & 0xffff, v & 0xffff);
  s.charge(cyc);
}

/**
 * Read-modify-write on memory (`inc`, `dec`, `clr`, `com`, `neg`, `asl`,
 * ...): the MC6809E reads first, then writes f(old). Returns the new
 * value.
 * @param {CpuView} s @param {number} a @param {(v: number) => number} f
 * @param {number} cyc
 * @returns {Generator<symbol, number, unknown>}
 */
export function* rmw(s, a, f, cyc) {
  if (shared(a)) yield SYNC;
  const v = f(s.peek(a & 0xffff)) & 0xff;
  s.poke(a & 0xffff, v);
  s.charge(cyc);
  return v;
}

/** `inc`: old + 1. @param {number} v @returns {number} */
export const INC = (v) => (v + 1) & 0xff;
/** `dec`: old - 1. @param {number} v @returns {number} */
export const DEC = (v) => (v - 1) & 0xff;
/** `clr`: 0 (after the read). @returns {number} */
export const CLR = () => 0;

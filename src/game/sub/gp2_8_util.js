// Copyright 2026 by Moshix
/**
 * Small helpers private to the gp2-8.11d module (sub CPU $A000-$BFFF).
 * Every address is a sub-CPU address; `s` is always `m.sub`.
 */

/** @typedef {import('../../machine/machine.js').CpuView} CpuView */

/** `sub_task` ($107A): the sub scheduler's task index. */
export const SUB_TASK = 0x107a;

/**
 * `inc addr`: read, add one (8-bit wrap), write back.
 * @param {CpuView} s @param {number} addr @returns {number} the new value
 */
export function inc(s, addr) {
  const v = (s.peek(addr) + 1) & 0xff;
  s.poke(addr, v);
  return v;
}

/**
 * `dec addr`: read, subtract one (8-bit wrap), write back.
 * @param {CpuView} s @param {number} addr @returns {number} the new value
 */
export function dec(s, addr) {
  const v = (s.peek(addr) - 1) & 0xff;
  s.poke(addr, v);
  return v;
}

/**
 * `inc <sub_task` -- the end of every task, before its
 * `jmp task_dispatch_sub`. In the port the task then returns and the
 * dispatcher ($E0EC) dispatches again from game_mode / sub_task.
 * @param {CpuView} s
 */
export function nextTask(s) {
  inc(s, SUB_TASK);
}

/**
 * The byte a `[$nnnn]` operand addresses: the pointer at `ptr` is read
 * again on every access, exactly as the 6809 does (a store through one
 * pointer may change another).
 * @param {CpuView} s @param {number} ptr @returns {number}
 */
export function ldInd(s, ptr) {
  return s.peek(s.peek16(ptr));
}

/**
 * `sta [$nnnn]`.
 * @param {CpuView} s @param {number} ptr @param {number} v
 */
export function stInd(s, ptr, v) {
  s.poke(s.peek16(ptr), v);
}

/**
 * `ldd [$nnnn]`.
 * @param {CpuView} s @param {number} ptr @returns {number}
 */
export function ldInd16(s, ptr) {
  return s.peek16(s.peek16(ptr));
}

/**
 * `std [$nnnn]` / `stx [$nnnn]`.
 * @param {CpuView} s @param {number} ptr @param {number} v
 */
export function stInd16(s, ptr, v) {
  s.poke16(s.peek16(ptr), v);
}

/**
 * A 16-bit `leax n,x` / `cmpx` style address sum.
 * @param {number} a @param {number} b @returns {number}
 */
export const add16w = (a, b) => (a + b) & 0xffff;

// ------------------------------------------------------------- timing

/**
 * The scheduler's "timing point" marker (src/game/scheduler.js SYNC, a
 * registered symbol so this chip need not import the scheduler): yielded
 * after charging the cycles up to an instruction whose memory access
 * the main CPU (or the sub IRQ) can see, right before that access.
 */
export const SYNC = Symbol.for('gaplus.sync');

/**
 * Cycles of `cwai #$EF` on the MC6809 up to the wait (opcode, operand,
 * the AND, 12 bytes stacked; the oracle's core and MAME: 16). The wake-up
 * (4) is charged by the scheduler.
 */
export const CWAI_CYCLES = 16;

/**
 * Is a sub-CPU access to `addr` visible to another CPU? All of shared
 * RAM $0000-$1FFF except the sub's own stack ($1D74-$1D7F, exempt, see
 * docs/porting-guide.md 5.3) and $1D80 (the byte above it, which only
 * the dummy read that ends a PULS / RTS touches; nothing lives there),
 * and the IRQ latch $6000-$6FFF. ROM and unmapped space are private. Ported code yields SYNC before every
 * instruction that touches such an address; the oracle tests stamp the
 * same instructions.
 * @param {number} addr @returns {boolean}
 */
export function timed(addr) {
  const a = addr & 0xffff;
  if (a < 0x2000) return a < 0x1d74 || a > 0x1d80;
  return a >= 0x6000 && a < 0x7000;
}

/**
 * `yield* syncAt(a)`: SYNC when the instruction's (computed) address
 * is timed; several addresses of one instruction: any of them.
 * @param {...number} addrs
 * @returns {Generator<symbol, void, unknown>}
 */
export function* syncAt(...addrs) {
  for (const a of addrs) {
    if (timed(a)) { yield SYNC; return; }
  }
}

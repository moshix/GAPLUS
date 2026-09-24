// Copyright 2026 by Moshix
/**
 * Timing conventions shared by every ported CPU (docs/porting-guide.md
 * section 6): which accesses another CPU can see, and the helpers that
 * put them at the cycle the 6809 makes them.
 *
 * THE CONTRACT (src/game/scheduler.js runs it):
 *
 *   1. Charge every instruction's MAME cycles, after its accesses
 *      (`m.charge`, `m.sub.charge`, `m.sound.charge`): at an access the
 *      CPU's charged total is the cycle its instruction starts. JSR/BSR
 *      are charged by the caller, RTS by the routine; a CWAI charges 16
 *      and then does a plain `yield` (the wake-up is the scheduler's).
 *   2. `yield SYNC` right before every instruction whose access is
 *      {@link timed}: the scheduler then runs it at that cycle, in the
 *      right 256-cycle slice relative to the other CPUs.
 *   3. A loop that waits for another CPU is {@link poll}: after each
 *      failed pass it charges the pass and yields `pollAgain(...)` with
 *      the loop's instruction cycles, so the scheduler keeps the loop's
 *      phase (the next read happens where the 6809's would).
 *
 * The older markers still work (SPIN / RENDEZVOUS / uncharged BUSY: a
 * poll re-read once per slice, at the slice's start), but only (3) is
 * cycle-exact.
 */

import { SYNC, pollAgain, frameDue, IO_ACCESS_CYCLE } from './scheduler.js';
import { STACKS } from '../machine/machine.js';

export { SYNC, pollAgain, frameDue };

/** @typedef {import('../machine/machine.js').CpuView} CpuView */
/** @typedef {'main'|'sub'|'sound'} Cpu */

const MAIN_S = STACKS.main;
const SUB_S = STACKS.sub;

/**
 * A ported main-CPU read of the 56XX/58XX ($6800-$681F) whose access
 * does not come on the 5th cycle of the instruction as an extended
 * read's does: through an index register (`$CF67: LDA ,U` reads on
 * cycle index 3, `$B910: LDA ,U+` on 5), or the second byte of a
 * 16-bit read (`$C01A: LDD $6800` reads $6801 on 5). The scheduler is
 * told the cycle (`dataCycle`, counted from 0 at the instruction's first
 * cycle, as src/emu/m6809.js `cyc` counts it) to deliver the chips'
 * vblank run exactly (scheduler.js watchIo).
 * @param {CpuView} view the main CPU (the Machine)
 * @param {number} addr @param {number} dataCycle
 * @returns {number} the byte read
 */
export function ioRead(view, addr, dataCycle) {
  const m = view.machine;
  m.ioDataCycle = dataCycle;
  try {
    return view.peek(addr);
  } finally {
    m.ioDataCycle = IO_ACCESS_CYCLE;
  }
}

/**
 * A ported main-CPU write to the I/O chips whose data cycle is not the
 * extended-addressing default (4): `STA ,U+` to the 56XX/58XX (cycle 5,
 * for the vblank run as in {@link ioRead}), or the 62XX bang trigger
 * $6829 by `STA ,X+` (5) or `INC $6829` (6), so that the host hears the
 * bang at the cycle the ROM engine reports (Port.onBang).
 * @param {CpuView} view the main CPU (the Machine)
 * @param {number} addr @param {number} v
 * @param {number} dataCycle the write's cycle within the instruction
 */
export function ioStore(view, addr, v, dataCycle) {
  const m = view.machine;
  m.ioDataCycle = dataCycle;
  try {
    view.poke(addr, v);
  } finally {
    m.ioDataCycle = IO_ACCESS_CYCLE;
  }
}

/**
 * Can another CPU (or the scheduler) see this access, so that its cycle
 * matters?
 *
 *   main   $0000-$1FFF (shared with the sub; not its stack, STACKS.main
 *          [low, top) = $15E2-$15FF), $6000-$63FF (shared with the
 *          sound CPU), $7000-$8FFF (the IRQ-mask and SRESET latches)
 *   sub    $0000-$1FFF (not its stack STACKS.sub = $1D70-$1D7F, nor
 *          $1D80, the byte PULS/RTS dummy-read), $6000-$6FFF (its IRQ
 *          latch)
 *   sound  $0040-$007F (the request and active bytes the main CPU
 *          reads and writes; the rest of its RAM only the main CPU's
 *          service-mode RAM test touches), $4000-$7FFF (its IRQ latch)
 *
 * The 56XX/58XX ($6800-$682F) are not SYNC points: the scheduler delivers
 * their run at the right cycle from the charged time alone.
 * @param {Cpu} cpu @param {number} addr
 * @returns {boolean}
 */
export function timed(cpu, addr) {
  const a = addr & 0xffff;
  if (cpu === 'main') {
    return (a < 0x2000 && (a < MAIN_S.low || a >= MAIN_S.top))
      || (a >= 0x6000 && a < 0x6400) || (a >= 0x7000 && a < 0x9000);
  }
  if (cpu === 'sub') {
    return (a < 0x2000 && (a < SUB_S.low || a > SUB_S.top))
      || (a >= 0x6000 && a < 0x7000);
  }
  return (a >= 0x40 && a < 0x80) || (a >= 0x4000 && a < 0x8000);
}

/**
 * `yield* at(view, addr)` right before an instruction that accesses
 * `addr` (a pointer operand): a SYNC when the access is timed, or when
 * the chunk has run past the next vblank (frameDue: the access belongs
 * to the next frame).
 * @param {CpuView} view @param {number} addr
 * @returns {Generator<symbol, void, unknown>}
 */
export function* at(view, addr) {
  if (timed(view.cpu, addr) || frameDue()) yield SYNC;
}

/**
 * A poll loop: read `addr` until `done(value)`, then return the value.
 * `loop` are the loop's instructions' cycles in order, the read first
 * (`$C158: lda <$AF (4) / cmpa #$11 (2) / bne (3)` = [4, 2, 3]). Each
 * failed pass is charged (and `each`, for other side effects of a pass
 * such as a watchdog read, runs); the pass that succeeds is not: the
 * caller charges it, as it knows the branch not taken.
 * @param {CpuView} view the CPU's view
 * @param {number} addr the address read
 * @param {(v: number) => boolean} done
 * @param {readonly number[]} loop
 * @param {(() => void) | null} [each] other accesses of one pass
 * @returns {Generator<unknown, number, unknown>}
 */
export function* poll(view, addr, done, loop, each = null) {
  const mark = pollAgain(...loop);
  for (;;) {
    yield SYNC;
    const v = view.peek(addr);
    each?.();
    if (done(v)) return v;
    view.charge(mark.period);
    yield mark;
  }
}

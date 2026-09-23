// Copyright 2026 by Moshix
/**
 * Per-machine bookkeeping for main CPU ROM gp2-3b.8c ($C000-$DFFF): what
 * the 6809 keeps in its program counter and stack, and the port cannot.
 *
 * NON-LOCAL JUMPS. Much of this ROM ends in a JMP that abandons the
 * current call chain: the IRQ handler's `lbne service_mode` ($C016) and
 * `jmp attract_loop` ($C0A8), the demo's end (`jmp attract_loop` at
 * $D049, reached from a task), the game-over and player-change paths
 * (`jmp attract_loop` $DAE7, `jmp lCDA1` $DB8E into start_game_1p), and
 * start_game_1p's `jmp task_dispatch_sync` ($CF11). A JS routine cannot
 * jump out of its callers, so it records the target here with
 * requestJump() and returns. The foreground driver (the integration
 * agent's main/index.js) checks takeJump() after the foreground
 * generator yields or returns, and after every IRQ handler; when a jump is
 * pending it calls `.return()` on the running foreground generator and
 * starts `mainAt(target)` in its place -- the 6809 simply left its old
 * stack behind.
 *
 * The one jump that is NOT recorded is the ordinary end of a task,
 * `inc <$30 / jmp task_dispatch` (or `clr <$30 / jmp task_dispatch`): the
 * task just returns, and the dispatcher loop (main-E, $FEB5) reads
 * game_mode/main_task again. That is exactly what the 6809 does.
 *
 * YIELD MARKERS (the vocabulary of src/game/scheduler.js). Foreground
 * generators of this ROM yield:
 *   undefined   at a CWAI #$EF (wait for the next vblank IRQ);
 *   SYNC        after charging (Machine.charge) the exact cycles run so
 *               far, right before a RAM/I-O access in code the vblank IRQ
 *               can interrupt (attract_loop and what it runs, the start
 *               of start_game_1p): "the CPU has got this far" (busy());
 * and the IRQ handler (a generator too) yields
 *   RENDEZVOUS  at its frame_sync poll ($C158, $C067) while $10AF is not
 *               $11: resume it after the sub CPU's handler has stored $11;
 *   BUSY        in the loops it never leaves by itself (round_select,
 *               coin_jammed).
 * The symbols are registered with Symbol.for() so the scheduler can use
 * the same values without importing this file.
 *
 * Kept in a WeakMap rather than on the Machine so no framework file
 * changes. @see docs/modules/main-C.md
 */

/**
 * @typedef {import('../../machine/machine.js').Machine} Machine
 * @typedef {{ jump: number | null }} MainCState
 */

/** Busy-loop progress marker (see the file header). */
export const BUSY = Symbol.for('gaplus.busy');

/**
 * "Charged time; what follows may be seen by another CPU" (scheduler.js
 * SYNC): see busy().
 */
export const SYNC = Symbol.for('gaplus.sync');

/** IRQ handler waiting for the sub CPU at frame_sync $10AF. */
export const RENDEZVOUS = Symbol.for('gaplus.rendezvous');

/** $FEB5 task_dispatch: a task that jumps here simply returns. */
export const TASK_DISPATCH = 0xfeb5;

/*
 * The jump state now lives in the shared ./jump.js
 * (docs/requests/main-E.md 3); re-exported here for existing importers.
 */
export { mainCState, requestJump, takeJump, pendingJump } from './jump.js';

/**
 * Charge `cycles` main-CPU cycles, then yield SYNC: in foreground code
 * the vblank IRQ can interrupt, call it with the cycles up to the START
 * of the next instruction that writes (or reads I/O or IRQ-written RAM),
 * then perform that access. The scheduler takes the vblank IRQ at this
 * point if the charged time has reached it: the oracle core, like the
 * 6809, takes an interrupt only between instructions, so an instruction
 * belongs to the frame it starts in. (The name is historical: it yields
 * SYNC, not BUSY.)
 * @param {Machine} m
 * @param {number} cycles
 * @returns {Generator<symbol, void, unknown>}
 */
export function* busy(m, cycles) {
  m.charge(cycles);
  yield SYNC;
}

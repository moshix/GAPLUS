// Copyright 2026 by Moshix
/**
 * Non-local jumps of the main CPU: moved here from gp2_3b_state.js at
 * main-E's request (docs/requests/main-E.md 3), which re-exports them.
 *
 * Much of the main ROM ends in a JMP that abandons the current call
 * chain: the IRQ handler's `lbne service_mode` ($C016) and `jmp
 * attract_loop` ($C0A8), the demo's end (`jmp attract_loop` $D049), the
 * game-over and player-change paths ($DAE7, $DB8E), start_game_1p's `jmp
 * task_dispatch_sync` ($CF11). A JS routine cannot jump out of its
 * callers, so it records the target with requestJump() and returns. The
 * foreground driver (main/index.js) checks takeJump() whenever it gets
 * control back (after the foreground yields or returns, and after every
 * IRQ handler); with a jump pending it calls `.return()` on the running
 * foreground generator and starts `mainAt(target)` in its place -- the
 * 6809 simply left its old stack behind.
 *
 * The ordinary end of a task, `inc <$30 / jmp task_dispatch`, is not a
 * jump here: the task returns and the dispatcher ($FEB5) loops.
 * Kept in a WeakMap rather than on the Machine, so no framework file
 * changes.
 */

/**
 * @typedef {import('../../machine/machine.js').Machine} Machine
 * @typedef {{ jump: number | null }} MainCState
 */

/** @type {WeakMap<Machine, MainCState>} */
const STATE = new WeakMap();

/**
 * This machine's state record (created on first use).
 * @param {Machine} m
 * @returns {MainCState}
 */
export function mainCState(m) {
  let s = STATE.get(m);
  if (s === undefined) {
    s = { jump: null };
    STATE.set(m, s);
  }
  return s;
}

/**
 * Record a JMP that abandons the call chain.
 * @param {Machine} m
 * @param {number} addr main-CPU address the 6809 continues at
 */
export function requestJump(m, addr) {
  mainCState(m).jump = addr & 0xffff;
}

/**
 * The pending jump target, cleared; null when none.
 * @param {Machine} m
 * @returns {number | null}
 */
export function takeJump(m) {
  const s = mainCState(m);
  const j = s.jump;
  s.jump = null;
  return j;
}

/**
 * The pending jump target without clearing it; null when none.
 * @param {Machine} m
 * @returns {number | null}
 */
export function pendingJump(m) {
  return mainCState(m).jump;
}

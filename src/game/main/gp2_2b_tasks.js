// Copyright 2026 by Moshix
/**
 * Main CPU $FEB0-$FFCF: the game-mode task scheduler (`task_dispatch`)
 * and the ten task lists it walks.
 *
 * HOW THE 6809 DOES IT. `game_mode` ($102F) picks a list from
 * mode_task_lists ($FEC0), `main_task` ($1030) an entry in it; the task
 * is entered by `JMP [B,U]`, does its work, and ends with
 * `INC <$30 / JMP task_dispatch` (or jumps back without the INC, or
 * changes $102F). The last entry of every list, task_end_frame ($D150,
 * gp2-3b), is `CWAI #$EF / LDS #$1600 / CLR <$30 / JMP task_dispatch`:
 * it sleeps until the vblank IRQ has run, throws the stack away and
 * starts the list again. So every frame runs the current list once, from
 * the top.
 *
 * IN THE PORT. task_dispatch is a generator that loops forever: one pass
 * of its loop is one `JMP [B,U]`. A task "jumping back to task_dispatch"
 * is a task that returns; a task that waits (task_end_frame's CWAI, the
 * CWAIs in task_results and task_stage_events) is a generator and yields
 * there, once per frame. Because the 6809 reloads S after each CWAI, no
 * JS local of a task may survive the yield, and none does: the
 * dispatcher re-reads $102F/$1030 on every pass.
 *
 * TIMING. The dispatcher charges its own 25 cycles ($FEB5-$FEBE, the
 * JMP [B,U] included); each task charges its instructions from its entry
 * through its final JMP task_dispatch. It yields SYNC before reading
 * $102F/$1030 (the sub CPU reads and writes them) and again right before
 * each task starts, so the scheduler interleaves the main CPU's tasks
 * with the sub CPU's as the board does.
 *
 * NON-LOCAL JUMPS. A task that leaves the scheduler for good (the demo's
 * end: `lbne lD029` at $E3F8 -> `jmp attract_loop`) records the target
 * with gp2-3b's requestJump() and returns. task_dispatch then returns
 * too, at once, so the foreground driver sees the pending jump and starts
 * the target in place of the abandoned chain, as the 6809 did.
 *
 * @see reference/gaplus-main.asm $FEB0-$FFCF
 */

import { mainAt } from './routines.js';
import { call } from '../call.js';
import { mainWord } from '../romdata.js';
import { disp8 } from '../m6809ops.js';
// The pending non-local jump of gp2-3b's convention (requestJump /
// takeJump, see gp2_3b_state.js): shared state, not a routine. Imported
// directly until it moves to a shared file (docs/requests/main-E.md).
import { pendingJump } from './jump.js';
import { SYNC } from './gp2_2b_state.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/** $FEC0: the table of task-list pointers, one per game mode 0-9. */
export const MODE_TASK_LISTS = 0xfec0;

/**
 * The address task_dispatch jumps to for the current game_mode and
 * main_task, exactly as `JMP [B,U]` computes it.
 *
 *   $FEB5: ldu #$FEC0 / ldd <$2F / asla / ldu a,u / aslb / jmp [b,u]
 *
 * ASLA/ASLB are 8-bit shifts and the A,U / B,U offsets are signed: a
 * mode >= $40 or a task index >= $40 would index backwards, as on the
 * CPU (never happens in play; kept exact anyway).
 * @param {Machine} m
 * @returns {number} the task's entry address
 */
export function taskTarget(m) {
  const a = (m.peek(0x102f) << 1) & 0xff; // game_mode
  const b = (m.peek(0x1030) << 1) & 0xff; // main_task
  // ldu a,u / jmp [b,u]: both pointers may be anywhere (m.read16)
  const list = m.read16('main', disp8(MODE_TASK_LISTS, a));
  return m.read16('main', disp8(list, b));
}

/**
 * $FEB5 task_dispatch: the main CPU's game-mode scheduler. Runs the task
 * at mode_task_lists[game_mode][main_task] ($102F, $1030), again and
 * again. Tasks come from all three main ROMs, so they are
 * looked up in MAIN_AT and called with call() (plain or generator).
 * @see gaplus-main.asm $FEB5
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>} returns only when a
 *   task requested a non-local jump
 */
export function* task_dispatch(m) {
  for (;;) {
    // $FEB5: ldu #$FEC0 (3)
    m.charge(3);
    // $FEB8: ldd <$2F reads game_mode and main_task, which the sub CPU
    // reads and writes too: a timing point
    yield SYNC;
    const target = taskTarget(m);
    // ldd 5, asla 2, ldu a,u 6, aslb 2, jmp [b,u] 7
    m.charge(5); m.charge(2); m.charge(6); m.charge(2); m.charge(7);
    // Let the other CPUs catch up before the task runs: the tasks of the
    // main and sub CPUs interleave on the board.
    yield SYNC;
    yield* call(mainAt(target), m, {});
    // The task jumped out of the scheduler: let the driver take it.
    if (pendingJump(m) !== null) return undefined;
  }
}

/**
 * $FEB0 task_dispatch_sync: entered once per game start (from $CF0A and
 * $CF11): tell the sub CPU that the game starts (sub_handshake $0800 =
 * $33), then fall into task_dispatch.
 * @see gaplus-main.asm $FEB0
 * @param {Machine} m
 * @returns {Generator<unknown, undefined, unknown>}
 */
export function* task_dispatch_sync(m) {
  // $FEB0: lda #$33 / sta $0800 -- the sub CPU polls $0800
  m.charge(2);
  yield SYNC;
  m.poke(0x0800, 0x33);
  m.charge(5);
  return yield* task_dispatch(m);
}

/**
 * Every task address in the ten lists, read from ROM (for the
 * registration test and the documentation; the dispatcher itself reads
 * the table at run time).
 * @returns {number[]} distinct addresses, in list order
 */
export function allTaskAddresses() {
  /** @type {number[]} */
  const out = [];
  // Lists are consecutive: mode n's list ends where mode n+1's begins;
  // mode 9's ends at str_copyright ($FFD0).
  const lists = [];
  for (let i = 0; i < 10; i += 1) lists.push(mainWord(MODE_TASK_LISTS + 2 * i));
  lists.push(0xffd0);
  for (let i = 0; i < 10; i += 1) {
    for (let p = lists[i]; p < lists[i + 1]; p += 2) {
      const t = mainWord(p);
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

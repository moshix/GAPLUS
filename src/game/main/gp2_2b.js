// Copyright 2026 by Moshix
/**
 * Main CPU ROM gp2-2b.8b, $E000-$FFFF: the reset and boot code, the
 * challenging-stage results, the stage events, the stage parameters,
 * effects, bonus lives, the operator statistics and the game-mode task
 * scheduler. Importing this module registers every routine of the range
 * in MAIN and, since almost all of them are reached through jump tables,
 * in MAIN_AT.
 *
 *   gp2_2b_state.js   the foreground cycle clock (burn) and SPIN
 *   gp2_2b_boot.js    $E000-$E219  reset_main, chip check, handshake,
 *                                  DIP decoding, coinage
 *   gp2_2b_results.js $E21A-$EA20  challenging-stage results (mode 8)
 *   gp2_2b_stage.js   $EA21-$ECA3  stage events, $F4A5-$F5C3 stage params
 *   gp2_2b_fx.js      $F5C4-$FA7C  effects and the tasks in that range
 *   gp2_2b_bonus.js   $FA7D-$FEAF  bonus lives, operator stats, tasks
 *   gp2_2b_tasks.js   $FEB0-$FFCF  task_dispatch and the task lists
 *
 * @see docs/modules/main-E.md
 * @see reference/gaplus-main.asm $E000-$FFFF
 */

import { MAIN, MAIN_AT } from './routines.js';
import { burn } from './gp2_2b_state.js';
import {
  reset_main, boot_chip_error, boot_handshake, boot_check_service,
  program_coinage, sub_E20A, fill_16_words,
} from './gp2_2b_boot.js';
import { task_dispatch, task_dispatch_sync } from './gp2_2b_tasks.js';
import * as results from './gp2_2b_results.js';
import * as stage from './gp2_2b_stage.js';
import * as fx from './gp2_2b_fx.js';
import * as bonus from './gp2_2b_bonus.js';

Object.assign(MAIN, {
  reset_main, boot_chip_error, boot_handshake, boot_check_service,
  program_coinage, sub_E20A, fill_16_words,
  task_dispatch, task_dispatch_sync,
  // Not a routine: the shared foreground clock, for delay_65536 ($BE25,
  // gp2-4) until it moves to a shared file (docs/requests/main-E.md).
  fg_burn: burn,
});

Object.assign(MAIN_AT, {
  // RESET vector ($FFFE) and $BDA8 JMP reset_main.
  0xe000: reset_main,
  0xe0c5: boot_chip_error, 0xe0c7: boot_handshake,
  0xe1ca: boot_check_service, 0xe1de: program_coinage,
  0xe20a: sub_E20A, 0xe212: fill_16_words,
  // Jumped to from 40 places in all three ROMs.
  0xfeb0: task_dispatch_sync, 0xfeb5: task_dispatch,
});

// The helper modules export their routines as ROUTINES (name -> fn) and
// AT (address -> fn).
for (const h of [results, stage, fx, bonus]) {
  Object.assign(MAIN, h.ROUTINES);
  Object.assign(MAIN_AT, h.AT);
}

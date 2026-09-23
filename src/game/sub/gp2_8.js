// Copyright 2026 by Moshix
/**
 * Sub CPU, ROM gp2-8.11d ($A000-$BFFF): formation movement, the power-up
 * effects around the player's ship, the four bouncing objects and the
 * challenging-stage bonus objects. $A000-$B013 and the tables between
 * the routines are data (read through the sub view / romdata.js).
 *
 * Every routine whose entry is in this chip is registered in SUB and
 * SUB_AT here (all of them are reachable through jump tables: the mode
 * task lists at $E10D-$E17D, tbl_B3E6, object_states, tbl_BEDD).
 *
 * Tasks (entered from task_dispatch_sub $E0EC, ending in
 * `inc <sub_task / jmp task_dispatch_sub`) do the INC and return; the
 * dispatcher then dispatches again. The two tasks that CWAI
 * (task_formation_init, sub_BB96) yield once there (plain `yield`,
 * after charging the CWAI's 16 cycles).
 *
 * TIMING. Every routine is a generator that charges the 6809's exact
 * cycles (`m.sub.charge`) and yields SYNC (Symbol.for('gaplus.sync'))
 * right before each instruction touching shared RAM (all of
 * $0000-$1FFF but the sub stack; gp2_8_util.js `timed`). A routine
 * charges its RTS or its task's final JMP; the caller its JSR / BSR.
 * test/oracle/sub-gp2_8.test.mjs checks the SYNC stamps and totals
 * against the oracle's core instruction by instruction.
 *
 *   gp2_8_formation.js  $B014 $B0D4 $B163 $B20D $B242 $B385 $BF58
 *   gp2_8_fighter.js    $B3D1 $B3F2 $B461 $B5A1 $B860
 *   gp2_8_objects.js    $B90E $B92B $B930 $B936-$BA8E $BB50
 *   gp2_8_bonus.js      $BB96 $BCF3 $BD18 $BD20 $BD56 $BE4F $BE6C $BEE5
 */

import { SUB, SUB_AT } from './routines.js';
import {
  sub_B014, sub_B0D4, sub_B163, sub_B20D, sub_B242, sub_B385,
  task_formation_init,
} from './gp2_8_formation.js';
import {
  sub_B3D1, sub_B3F2, sub_B461, sub_B5A1, sub_B860,
} from './gp2_8_fighter.js';
import {
  task_animate_objects, sub_B92B, object_state_call, object_spawn_random,
  sub_B96B, sub_B973, sub_B97B, sub_B983, sub_B99D, sub_B9A5, sub_B9AD,
  sub_B9B5, sub_B9BD, sub_B9E2, sub_B9F0, sub_BA18, sub_BA8E, sub_BB50,
} from './gp2_8_objects.js';
import {
  sub_BB96, sub_BCF3, sub_BD18, sub_BD20, sub_BD56, sub_BE4F, sub_BE6C,
  sub_BEE5,
} from './gp2_8_bonus.js';

export { TO_DISPATCH } from './gp2_8_objects.js';

/**
 * Entry address -> routine, for every routine of gp2-8.11d.
 * @type {Record<number, Function>}
 */
export const GP2_8_ROUTINES = {
  0xb014: sub_B014,
  0xb0d4: sub_B0D4,
  0xb163: sub_B163,
  0xb20d: sub_B20D,
  0xb242: sub_B242,
  0xb385: sub_B385,
  0xb3d1: sub_B3D1,
  0xb3f2: sub_B3F2,
  0xb461: sub_B461,
  0xb5a1: sub_B5A1,
  0xb860: sub_B860,
  0xb90e: task_animate_objects,
  0xb92b: sub_B92B,
  0xb930: object_state_call,
  0xb936: object_spawn_random,
  0xb96b: sub_B96B,
  0xb973: sub_B973,
  0xb97b: sub_B97B,
  0xb983: sub_B983,
  0xb99d: sub_B99D,
  0xb9a5: sub_B9A5,
  0xb9ad: sub_B9AD,
  0xb9b5: sub_B9B5,
  0xb9bd: sub_B9BD,
  0xb9e2: sub_B9E2,
  0xb9f0: sub_B9F0,
  0xba18: sub_BA18,
  0xba8e: sub_BA8E,
  0xbb50: sub_BB50,
  0xbb96: sub_BB96,
  0xbcf3: sub_BCF3,
  0xbd18: sub_BD18,
  0xbd20: sub_BD20,
  0xbd56: sub_BD56,
  0xbe4f: sub_BE4F,
  0xbe6c: sub_BE6C,
  0xbee5: sub_BEE5,
  0xbf58: task_formation_init,
};

Object.assign(SUB, {
  sub_B014, sub_B0D4, sub_B163, sub_B20D, sub_B242, sub_B385,
  sub_B3D1, sub_B3F2, sub_B461, sub_B5A1, sub_B860,
  task_animate_objects, sub_B92B, object_state_call, object_spawn_random,
  sub_B96B, sub_B973, sub_B97B, sub_B983, sub_B99D, sub_B9A5, sub_B9AD,
  sub_B9B5, sub_B9BD, sub_B9E2, sub_B9F0, sub_BA18, sub_BA8E, sub_BB50,
  sub_BB96, sub_BCF3, sub_BD18, sub_BD20, sub_BD56, sub_BE4F, sub_BE6C,
  sub_BEE5, task_formation_init,
});
Object.assign(SUB_AT, GP2_8_ROUTINES);

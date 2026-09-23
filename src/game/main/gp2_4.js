// Copyright 2026 by Moshix
/**
 * Main CPU $A000-$BFFF (ROM chip gp2-4.8d). Importing this module
 * registers every routine whose entry is in the range, in MAIN by name
 * and in MAIN_AT by address (all of them: the mode-9 task and its step
 * table are reached through jump tables, the service mode by jumps).
 *
 *   gp2_4_hiscore.js  mode 9: TOP 5 check, screen, name entry;
 *                     load_formation_sprites              $AFBE-$B6F5
 *   gp2_4_svc.js      service mode, its loop and helpers,
 *                     delay_65536, easter egg             $B6F6-$BE77
 *   gp2_4_clock.js    the cycle clock of the busy loops
 *
 * $A000-$AFBD is data (tile patterns, stage and demo data, the demo
 * input scripts, attract texts); $BE78-$BFFF the easter-egg bitmap,
 * fill and the checksum byte.
 * @see reference/gaplus-main.asm $A000-$BFFF, docs/modules/main-A.md
 */

import { MAIN, MAIN_AT } from './routines.js';
import {
  task_hiscore_entry, hiscore_check, hiscore_draw_screen,
  hiscore_enter_name, load_formation_sprites,
} from './gp2_4_hiscore.js';
import {
  service_mode, fill_tilemap_00_20, print_string, service_loop,
  draw_test_grid, sub_BE15, sub_BE1D, delay_65536, easter_egg,
} from './gp2_4_svc.js';

Object.assign(MAIN, {
  task_hiscore_entry, hiscore_draw_screen, hiscore_enter_name,
  hiscore_check, load_formation_sprites, service_mode,
  fill_tilemap_00_20, print_string, service_loop, draw_test_grid,
  sub_BE15, sub_BE1D, delay_65536, easter_egg,
});

Object.assign(MAIN_AT, {
  0xafbe: task_hiscore_entry, // tasks_mode9[0] ($FFCA)
  0xafcd: hiscore_draw_screen, // hiscore_steps[1] ($AFC9)
  0xb304: hiscore_enter_name, // hiscore_steps[2] ($AFCB)
  0xb49f: hiscore_check, // hiscore_steps[0] ($AFC7)
  0xb656: load_formation_sprites,
  0xb6f6: service_mode, // jumped to from $C016 and $E1CF
  0xb77c: fill_tilemap_00_20,
  0xba2f: print_string,
  0xbd7b: service_loop,
  0xbe01: draw_test_grid,
  0xbe15: sub_BE15,
  0xbe1d: sub_BE1D,
  0xbe25: delay_65536,
  0xbe37: easter_egg,
});

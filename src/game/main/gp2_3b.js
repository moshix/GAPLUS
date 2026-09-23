// Copyright 2026 by Moshix
/**
 * Main CPU ROM gp2-3b.8c, $C000-$DFFF: the vblank IRQ handler, scoring,
 * boot-to-attract (game_init), the attract loop and push-start screens,
 * game start, and most of the per-frame play tasks. Importing this module
 * registers every routine whose entry address is in the range in MAIN
 * (by listing label) and MAIN_AT (by address).
 *
 *   gp2_3b_state.js    jump requests, BUSY / RENDEZVOUS markers, busy()
 *   gp2_3b_irq.js      $C000-$C1D5, $D07A-$D14F, $DF19-$DFAD: irq_main
 *                      and its helpers, sound clears, sprite shadow clears
 *   gp2_3b_score.js    $C1D6-$C295: add_score, update_hiscore, BCD digits
 *   gp2_3b_attract.js  $C296-$CCCF: game_init, attract_loop and phases,
 *                      push-start screens
 *   gp2_3b_start.js    $CCD0-$D079, $D150-$D282, $D8B0-$D914, $DFD0:
 *                      game start, player movement and fire, demo input,
 *                      task_end_frame and other small tasks
 *   gp2_3b_hit.js      $D28A-$D8AF: shot/enemy hits, stage clear and start
 *   gp2_3b_death.js    $D915-$DF18: player hit check, death, next player,
 *                      game over
 *
 * Also entered from other chips in the middle of routines (so they are
 * registered by address too): lD029 (demo end, from $E3F8), lD9CF (from
 * $F8D2), lDA87 (from $FC7D/$FC9F), lDBE2 (from $B301), lDC0B (from
 * $B2F6).
 *
 * @see docs/modules/main-C.md
 * @see reference/gaplus-main.asm $C000-$DFFF
 */

import { MAIN, MAIN_AT } from './routines.js';
import { ROUTINES as IRQ } from './gp2_3b_irq.js';
import { ROUTINES as SCORE } from './gp2_3b_score.js';
import { ROUTINES as ATTRACT } from './gp2_3b_attract.js';
import { ROUTINES as START } from './gp2_3b_start.js';
import { ROUTINES as HIT } from './gp2_3b_hit.js';
import { ROUTINES as DEATH } from './gp2_3b_death.js';

/**
 * Every routine of the chip by entry address.
 * @type {Record<number, Function>}
 */
export const GP2_3B = { ...IRQ, ...SCORE, ...ATTRACT, ...START, ...HIT,
  ...DEATH };

for (const [addr, fn] of Object.entries(GP2_3B)) {
  const a = Number(addr);
  if (a < 0xc000 || a > 0xdfff) {
    throw new Error(`gp2_3b: ${fn.name} at $${a.toString(16)} is not in `
      + '$C000-$DFFF');
  }
  MAIN[fn.name] = fn;
  MAIN_AT[a] = fn;
}

# main-C: main CPU ROM gp2-3b.8c ($C000-$DFFF)

Copyright 2026 by Moshix

`src/game/main/gp2_3b.js` registers every routine whose entry address is
in $C000-$DFFF (MAIN by listing label, MAIN_AT by address). Tests:
`test/oracle/main-gp2_3b*.test.mjs` (harness:
`test/oracle/main-gp2_3b.util.mjs`).

## Files

| file | range | what |
|------|-------|------|
| `gp2_3b.js` | | registration of the helper files' `ROUTINES` |
| `gp2_3b_state.js` | | yield markers, `busy()`, re-exports `jump.js` |
| `gp2_3b_irq.js` | $C000-$C1D5, $D07A-$D14F, $DF19-$DFAD | vblank IRQ handler and helpers |
| `gp2_3b_score.js` | $C1D6-$C295 | scores |
| `gp2_3b_attract.js` | $C296-$CCCF | game_init, attract loop, push-start |
| `gp2_3b_start.js` | $CCD0-$D079, $D150-$D282, $D8B0-$D914, $DFD0 | game start, player tasks |
| `gp2_3b_hit.js` | $D28A-$D8AF | shot hits, stage clear/start |
| `gp2_3b_death.js` | $D915-$DF18 | player hit, death, next player, game over |

## Routines (57 registered)

* irq: irq_main $C000 (IRQ handler), irq_copy_sprites $C0AB (its tail),
  round_select $C163, coin_jammed $C1B9, irq_timers $D07A (clock and
  1UP/2UP blink), update_play_clock $D0C6, update_p1_time $D107,
  sound_all_off $DF19, sound_demo_gate $DF27, clear_sprite_shadows $DF5D,
  clear_sprite_shadows_all $DF65.
* score: add_score $C1D6, update_hiscore $C253, bcd_hi_to_char $C287,
  bcd_lo_to_char $C28B (plain functions, never yield).
* attract: game_init $C296 (62XX init, header, high-score table),
  attract_loop $C417 (+ exported attract_pass: one pass), draw_credit
  $C467, attract_demo $C492, attract_demo2 $C49F, push_start_1p $C4DA,
  print_string_r $C639, push_start_2p $C670, clear_game_vars $C811,
  clear_playfield $C854, attract_phase0 $C866 (title), sub_C909/C91B/
  C952/C9AE (title logo animation steps), attract_phase2 $CAA9 (TOP 5).
* start: start_game_1p $CCD0, start_game_2p $CDFF, lCDA1 $CDA1 (next
  turn), task_count_fighters $CF14, task_move_player $CF4F, demo_input
  $D000, lD029 $D029 (demo end), task_end_frame $D150, task_next_mode
  $D15B, task_player_fire $D168, task_move_shots $D1D0, sub_D223 (dual
  fighter shots), sub_D8B0 (sound queue $0840), sub_D8F8 (fighter
  offsets).
* hit: sub_D28A (shots vs enemies and objects), sub_D431 (enemy hit:
  score, bonus sprite), sub_D588 (formation count, stage end),
  task_stage_clear $D676, task_stage_start $D71B.
* death: task_player_hit_check $D915 (and the death / next player /
  game over web $D915-$DEC0), lD9CF, lDA87, lDBE2, lDC0B, sub_DC1C
  (print string with attribute), sub_DEC1 (game-time histogram).

## What the scheduler needs to know

**IRQ handler.** `MAIN_AT[0xc000]` = `irq_main(m)`, a generator.

* Call it at the vblank IRQ entry (after `m.vblank()` and
  `m.ioUpdate()`); the 19-cycle entry is not charged by it.
* It yields `RENDEZVOUS` (`Symbol.for('gaplus.rendezvous')`) at the
  frame_sync poll ($C158, and $C067 on the coin path) while
  `$10AF != $11`: resume it after the sub CPU's handler ($E061) has
  stored $11. It then stores $22 (releasing the sub, which waits at
  $E0E2) and returns = RTI.
* It yields `BUSY` (after charging) in the two loops it never leaves by
  itself: `round_select` ($C163, Round Advance DIP on: loops until the
  DIP is off, vblanks meanwhile are lost as on the board) and
  `coin_jammed` ($C1B9, never ends).
* Cycles: it charges (`m.charge`) exactly what the 6809 executes, from
  $C000 to the RTI inclusive (15), including operator_stats' own charge
  if gp2-2b charges; failed passes of the $10AF poll are not charged.
* Non-local exits, recorded with `requestJump` (`src/game/main/jump.js`):
  - `$C016 lbne service_mode` -> $B6F6 (58XX $6814 bit 3);
  - `$C0A8 jmp attract_loop` -> $C417: a coin (56XX nibble 2) during the
    demo. The handler has already re-enabled the IRQ latch ($7400 at
    $C031), waited for the sub ($C067), cleared the game state, called
    clear_sprite_shadows and sound_demo_gate, and stored $22.
  In both, the 6809 does not RTI: CC.I stays set until the code jumped
  to clears it (attract_loop's `ANDCC #$EF` is its second instruction).
  The scheduler currently clears `iMask` when the handler returns; that
  is 5 cycles early, harmless (no IRQ can be pending then).

**Foreground entry points** (all generators, run through `call()`):

| addr | routine | entered from | ends |
|------|---------|--------------|------|
| $C296 | game_init | boot $E1DB | jump $C417 |
| $C417 | attract_loop | $C0A8, $D049, $DAE7, game_init | jumps $CCD0 / $CDFF |
| $CCD0 / $CDFF | start_game_1p / _2p | attract | jump $FEB0 |
| $CDA1 | lCDA1 (start_game_1p's second half) | $DB8E | jump $FEB0 |
| $D029 | lD029 (demo end) | $E3F8 | jump $C417 |
| $D9CF, $DA87, $DBE2, $DC0B | death / game-over web | $F8D2, $FC7D/$FC9F, $B301, $B2F6 | task_dispatch or jumps |

Every task in $C000-$DFFF ends like the 6809 (`inc <$30 / jmp
task_dispatch` = return), or with a recorded jump (`$C417`, `$CDA1`,
`$FEB0`), which task_dispatch (gp2-2b) checks with `pendingJump` and
returns on; the driver (`main/index.js`) then takes it.

**Yields in the foreground:** plain `yield` at every CWAI #$EF; `SYNC`
(`busy()`) or `BUSY` after charging, right before every instruction that
writes RAM or I/O or reads RAM $0800-$1FFF or I/O, in every foreground
routine of the chip: attract passes, game_init (also before the IRQ is
enabled: its ~35,000 cycles span a frame boundary, and the header must
land in frame 234 as on the board), start_game, every task body,
sound_all_off, sound_demo_gate and the sprite-shadow clears.
`m.charged[0]` at the yield is the cycle at which that instruction
starts, so the scheduler orders each access against the sub CPU's.
Exceptions: add_score / update_hiscore / bcd_* are plain (main-E calls
them plain), and irq_main runs the helpers it calls atomically.

**Cycles everywhere.** Every routine of this chip charges exactly the
cycles of the 6809 instructions it executes (MAME timings, as the
oracle core counts them): its own instructions from entry through its
RTS / final JMP, JSR/BSR included, callees charge themselves; a CWAI
is charged (16) before its yield. The tests check every charge against
the oracle's count.

## Quirks reproduced on purpose

* $C01A coin-jam test is a 16-bit `subd #$0A0A / lbcc`: it fires for a
  tens nibble >= $B, or tens = $A with units >= $A.
* $C041 formation loop: `lda ,x+` then `cmpx #$188D`: the last slot
  ($188C) is read but never tested, so its $1E31+2n byte is never cleared.
* $DF27 sound_demo_gate: with the demo-sounds DIP bit clear the ROM
  keeps sounds $11, $16, $17 and $19-$1F (LEAX skips), not just $16.
* $C031 stores A to the IRQ latch: 0 normally, $20 after round_select.
* attract_phase2 $CB00: the 10-tile blank loop runs with X = $0000 (the
  table's end marker): $20 to $0000 and on down through $FFE0 (ROM,
  ignored), attribute 2 into $0400 and tile codes $03E0, $03C0, ...
* push_start_1p $C5D8 (only when $04C2 != 0): the blanking runs past the
  tilemap; `clr ,u` hits work RAM $0840-$0868.
* start_game $CE6A: the fly-in RORB/ROLA use carries left by earlier
  compares; $CD78 with lives_setting 0 writes 255 markers from $1F17.
* demo_input $D01A: bit 7 of demo_stick is the carry of `cmpa #$F0`.
* sub_D28A: a formation hit does not clear the shot (`leax -2,x` at
  $D423 re-tests it), so one shot can hit several enemies; $1076 is
  stored, not OR-ed; <$66 (boss bonus index) runs past dat_D3A1 into
  code; the formation scan ends only at X = word $112D.
* task_stage_start: erasing the PARSEC digits stores to $FFF0.
* $DA87 game over: clears $102A-$11FF (frame_sync, main_task included)
  but only the low two bytes of each score; $DE9A `lda <$2F` is dead;
  $DC36 is an unreached CWAI; game over waits exactly 256 frames; a
  player with 0 lives gets $FF reserve markers capped to 4; sub_DEC1
  can count into $09E0, past stats_counters.
* update_hiscore copies the score only from the first byte that differs
  (the higher bytes being equal); drawNumber leaves leading-zero tiles
  untouched (it does not blank them).

## Open questions

* The scheduler takes the IRQ's `return` as RTI (clears CC.I) also on
  the two jump exits; see above (docs/requests/main-C.md).
* attract_loop takes `regs.a` (default 0) only for the value `sta $7400`
  writes on its first pass; a driver starting it through a jump cannot
  pass the ROM's A (latch value only, no effect).
* The 62XX poll loops in game_init ($C321, $C34A) never fail with the
  current I/O model; their wait path is ported but unexercised.
* `jmp [a,x]` through tbl_C9C9 with $117A > 3 (never in play) would jump
  into data; the port reads the table the same way but it is untested.

## Tests

`node --test test/oracle/main-gp2_3b*.test.mjs`: 36 tests, thousands of
seeded states plus real board states for irq_main; the attract, start,
hit and death parts were traced to execute every instruction of their
ranges.

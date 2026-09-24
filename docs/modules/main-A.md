# main-A: main CPU $A000-$BFFF (ROM gp2-4.8d)

Copyright 2026 by Moshix

## What is in the chip

| range | contents |
|-------|----------|
| $A000-$AFBD | data only (tile patterns, stage/demo data, demo input scripts, attract texts) |
| $AFBE-$B655 | game mode 9: TOP 5 check, the entry screen, name entry |
| $B656-$B6F5 | `load_formation_sprites` and its table |
| $B6F6-$BE77 | the service (test) mode and its helpers, `delay_65536`, the easter egg |
| $BE78-$BFFF | easter-egg bitmap, fill, checksum byte |

## Files

| file | what |
|------|------|
| `src/game/main/gp2_4.js` | registers all 14 routines in `MAIN` and `MAIN_AT` |
| `src/game/main/gp2_4_hiscore.js` | mode 9 and `load_formation_sprites` |
| `src/game/main/gp2_4_svc.js` | service mode, its loop and helpers |
| `src/game/main/gp2_4_clock.js` | cycle accounting on the shared clock (`src/game/clock.js`) |
| `test/oracle/main-gp2_4.test.mjs` | routine tests (mode 9, helpers, delay, easter egg) |
| `test/oracle/main-gp2_4-svc.test.mjs` | the service mode, frame by frame, 12 runs |
| `test/oracle/main-gp2_4.lib.mjs` | ROM runner (CWAI stepping, stops), stubs (no tests) |

## Routines

| addr | name | kind | one line |
|------|------|------|----------|
| $AFBE | `task_hiscore_entry` | gen | mode 9 task 0: dispatch on `hiscore_step` ($11FF) through `hiscore_steps` |
| $B49F | `hiscore_check` | gen | rank the score (tile digits) against the 5 entries, shift and insert; not ranked -> end of mode 9 |
| $AFCD | `hiscore_draw_screen` | gen | the TOP 5 screen, placeholder row, attributes; timer 5 |
| $B304 | `hiscore_enter_name` | gen | one frame of name entry: stick cycles characters (8-frame repeat), fire accepts, timer; finishing stores the table and returns to mode 5 via $DBE2/$DC0B (gp2-3b), one CWAI |
| $B656 | `load_formation_sprites` | plain | copy 9 words of the formation (`$106E`) into sprite shadow runs |
| $B6F6 | `service_mode` | gen | the whole test mode (see below); never returns, `requestJump($E000)` at the end |
| $B77C | `fill_tilemap_00_20` | plain | $0000-$03FF = $0020 words, watchdog per word |
| $BA2F | `print_string` | plain | zero-terminated string at X to tiles from U going right |
| $BD7B | `service_loop` | gen | service loop pass, then DIP screen + loop until the switch is off |
| $BE01 | `draw_test_grid` | plain | the cross hatch over the tilemap |
| $BE15 | `sub_BE15` | plain | one row pair of the cross hatch |
| $BE1D | `sub_BE1D` | plain | `STX ,U++` x 16 |
| $BE25 | `delay_65536` | gen | 787,734 cycles on the shared clock, 65,536 watchdog reads |
| $BE37 | `easter_egg` | gen | blank screen, bitmap as '0' tiles, hang (watchdog loop) |

Tasks follow the dispatcher convention (`INC <main_task` then return;
task_dispatch loops). The `JNIWAR` secret name makes
`hiscore_enter_name` loop forever on the staff message (a charged busy
loop with a SYNC before each store; the IRQ keeps running). All of mode 9
and `load_formation_sprites` follow the timing contract (porting-guide
6.4); test/oracle/main-gp2_4.test.mjs checks total cycles, every write
and timed access at the ROM's cycle, and a SYNC before each.

## The service mode and time

It runs with the main IRQ off, so every instruction's cycles are counted
(`Clock` in gp2_4_clock.js burns them on `src/game/clock.js` before each
access). Frame by frame from entry (power-on: frame 171; IRQ path: any):
delay 31 frames, RAM test ~204 frames, chip tests 2 x 31, checksums,
release at +346, handshakes (+352/+359), DIP screen at +421, then the
loop. The test compares **every main-CPU write at the oracle's exact
frame and cycle** (255,688 in the power-on run) for the power-on and
IRQ entries, nine fault-injected error paths and the easter egg, with
the I/O run delivered at cycle 76 as on the oracle (see request 2 for
the scheduler).

The sub/sound handshakes are modelled, not guessed: those CPUs store
`$22` at fixed times after the release (147,496 / 319,552 cycles after
$B8B8), and the main CPU sees the store from the next MAME slice
boundary (vblank + 76.8 + 256k) -- which is why the exit poll moves by
up to 15 polls between entries. `HANDSHAKE`, `sliceEnd` in gp2_4_svc.js.

## ROM quirks reproduced

* **Hidden error codes.** The sound-RAM and 56XX/58XX/62XX error paths
  load the error digit into B (`LDD #$2031`..`#$2036`) but store A =
  $20: the error shows as a blank and passes the "RAM OK / ROM OK" check
  ($B926 masks with $0F). Only the $0000-$1FFF RAM test ('1'-'4'), the
  ROM checksums ('1'-'3') and the sub/sound ROM results ('7', sub's
  digit) are visible.
* **15 RAM-test passes.** D enters the test as $000B (left over from the
  62XX INCB chain), so the 16th `ADDD #$1111` overflows a pass early.
* **Cross hatch needs a second press.** The service coin starts it; it
  stays until the coin is pressed again (not "until released").
* **The easter egg and `JNIWAR` hang for good** (watchdog kicked).
* `CLR -1,Y` of the sound test clears `$603F` (WSG register) for sound 0.
* The mode-9 alphabet wrap reads the byte 2 before each alphabet
  (`$B416`, `$B435`, `$B443`): the index of its terminator.
* `hiscore_check` for rank 5 leaves `entry_rank` untouched;
  `hiscore_check` adds 2 to `main_task` (skipping `sub_FC33`).

## Open questions

* `task_hiscore_entry` with `hiscore_step` >= 3 would jump through ROM
  words after the table; never happens, the port fails loudly.
* `$1E01` ($00 while entering, $81 after) and `$1854` = $C000: meaning
  unknown.

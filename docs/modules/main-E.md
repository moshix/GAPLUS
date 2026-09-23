# main-E: main CPU ROM gp2-2b.8b ($E000-$FFFF)

Copyright 2026 by Moshix

`src/game/main/gp2_2b.js` registers everything in the range (MAIN by
name, MAIN_AT by address). Tests: `test/oracle/main-gp2_2b*.test.mjs`
(38 tests, shared harness `main-gp2_2b_harness.mjs`; every routine runs
on the oracle and the port from the same seeded state and must leave
identical RAM, latches, starfield and I/O chips, the same consumed
registers, and yield exactly as often as the ROM executes CWAI or polls).

| file | range | contents |
|------|-------|----------|
| `gp2_2b_state.js` | - | foreground cycle clock (`clockOf`, `setClock`, `burn`), `SPIN` |
| `gp2_2b_boot.js` | $E000-$E219 | `reset_main`, `boot_chip_error`, `boot_handshake`, `boot_after_handshake` ($E0E8), `boot_check_service`, `program_coinage`, `sub_E20A`, `fill_16_words` |
| `gp2_2b_results.js` | $E21A-$EA20 | mode 8: `task_results` + 6 steps, bonus lines `sub_E4DA`/tbl_E4E5, pay-outs tbl_E65F, `sub_E3FF`, `sub_E6C8`, `print_string_attr` (25 routines) |
| `gp2_2b_stage.js` | $EA21-$ECA3, $F4A5-$F5C3 | `sub_EA21`, `sub_EA89`, `task_stage_events` + tbl_EABA, `sub_EB66` + tbl_EB82, `sub_EB01`, `load_stage_params` (18) |
| `gp2_2b_fx.js` | $F5C4-$FA7C | `task_spawn_effect`, `task_animate_effects` + effect_steps, player explosion `sub_F6DD` + tbl_F6FC, `sub_F8DA`, `sub_F921` (21) |
| `gp2_2b_bonus.js` | $FA7D-$FEAF | `task_bonus_life` + bonus_steps_p1/p2, `sub_FB9E`, `sub_FBB1`, `sub_FC1F`, `sub_FC33`, `operator_stats` (IRQ), `sub_FE18` (14) |
| `gp2_2b_tasks.js` | $FEB0-$FFCF | `task_dispatch`, `task_dispatch_sync`, `taskTarget` |

Not ported (unreachable, documented in the files): $E5DC-$E5F2 and
$F924-$F9CF (skipped by `JMP $F9D5`). The RAM/ROM tests and the service
mode live in gp2-4 ($B6F6-$BE77, main-A), not in this ROM.

## What the integration agent needs

**Power-on.** `setClock(m, POWER_ON_CYCLE)` (4: the reset vector fetch),
then run `MAIN.reset_main(m)` (= `MAIN_AT[0xE000]`) as the main
foreground generator. A watchdog reset does the same after
`m.machineReset()`. The boot yields:

* plain `yield` = the frame ended (vblank). The generator keeps a cycle
  clock and yields once per 25,344 cycles, before the first write of the
  new frame (oracle-checked frame by frame, power-on to game_init).
  Call `m.vblank()` / `m.ioUpdate()` between frames as usual: the chip
  checks read the 56XX/58XX after their runs.
* `SPIN` (`Symbol.for('gaplus.SPIN')`) in the handshake at $E0D2/$E0DD
  (and in sub_FC33's wait on the sub CPU's `$107A` at $FC71): re-run the
  other CPUs' foregrounds and resume within the frame. After the
  handshake the clock is re-set to cycle 7,274 (measured: frame 109).
* It ends by tail-calling `MAIN.game_init` (frame 233, clock 23,323) or
  `MAIN.service_mode` (service switch); neither returns.

Measured timeline: $E000 f0 c4; first delay $E037 f3 c10,555; SRESET
released $E0C7 f96 c17,095; $E0E8 f109 c7,274; `jmp game_init` f233
c23,319.

**delay_65536 ($BE25, main-A)** must burn 787,734 cycles on the same
clock (`MAIN.fg_burn`), see `docs/requests/main-E.md`.

**Task dispatch ($FEB5).** `task_dispatch(m)` is a generator that loops
forever: each pass computes `mode_task_lists[$102F][$1030]` exactly as
`LDU A,U / JMP [B,U]` (8-bit ASL, signed offsets), looks the target up
in MAIN_AT and runs it with `call()`. A task that ends `INC <$30 / JMP
task_dispatch` does the INC and returns. The restart after the CWAI of
task_end_frame ($D150: `CWAI / LDS #$1600 / CLR <$30 / JMP $FEB5`) is
just that task yielding once, clearing $1030 and returning: the loop
re-reads the state, and no JS local survives the yield, which is what
reloading S means. The main foreground enters it via
`task_dispatch_sync` ($FEB0, from start_game $CF0A/$CF11, writes $33 to
$0800). It returns only when a task has requested a non-local jump
(gp2-3b `requestJump`, e.g. the demo end `lD029` -> attract_loop): the
driver then takes the jump.

## Timing (round 2)

* Every routine charges the exact MAME 6809 cycles of what it executes
  (`m.charge`; the boot through `burn()` of src/game/clock.js), from its
  entry through its RTS / final `JMP task_dispatch`; JSR/BSR charged by
  the caller; a CWAI charges 16 before its yield. Each instruction is
  charged after its accesses, so `m.charged[0]` at an access is the
  cycle its instruction starts.
* `yield SYNC` (`Symbol.for('gaplus.sync')`) right before every access
  to RAM another CPU touches: `RACY` in gp2_2b_state.js (what the sub CPU
  read or wrote in 12,000 oracle frames, plus $6040-$607F). task_dispatch
  charges its 25 cycles, SYNCs before `ldd <$2F` and again before each
  task. operator_stats (inside irq_main) charges but never yields.
* Almost every routine is now a generator (callers use `call()`):
  load_stage_params, sub_FB9E, all tasks and steps.
* Tests: `sameTiming()` in every case: total cycles equal to the ROM's,
  every write at the same instruction-start cycle, a SYNC at the stamp of
  every racy access; a deliberately wrong count fails (checked in each
  file). The boot checks the cycles charged to $E0D2 and $C296 and the
  SYNC stamps at $E0CC/$E0CF.
* `lockstep-run 4000 --timing`: first difference at frame 252
  (`attract_timer`: the sub IRQ handler ends at 5,175 instead of 5,233,
  sub CPU charges). With `--resync --play=1`: 139 of 4,000 frames differ,
  longest run 5, nothing outlives a resync.

## Quirks reproduced on purpose

* $FB63: with bonus DIP row 1 (every = 0) player 2's path stores
  bonus_second instead of 3 in `$1125`; the next `task_bonus_life`
  indexes bonus_steps_p2 out of range and jumps through code (the port's
  `mainAt` throws there; the board crashes). 2P games on that DIP only.
* $EC9F `BRN $EC59` never branches. `task_stage_events` on a stage
  without events waits a frame and moves to the next mode.
* $E375 compares the whole `$1166` with 4 where the check before uses
  `$1166 & 7`. load_stage_params uses the old `$1011` in its third
  lookup and has signed table indexes. `task_spawn_effect` loses a
  request when all three slots are busy. `sub_F921` takes one hit a
  frame. effect step $80 does its task's `INC <$30 / JMP task_dispatch`
  from inside a JSR (the port returns `{ exit: true }`).

## Open questions

* Jumps into gp2-3b need `MAIN_AT` entries `$D029`, `$D9CF`, `$DA87`.
* The clock and the jump state should become shared files (requests).

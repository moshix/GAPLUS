# sub-E: sub CPU ROM gp2-6.11b ($E000-$FFFF)

Copyright 2026 by Moshix

The chip holds the sub CPU's reset code, its vblank IRQ handler (the
sprite copy and the `frame_sync` rendezvous), the task scheduler with its
ten per-mode task lists, and about 40 tasks for the formation, the
capture beam, the fly-ins, enemy shots and the bonus objects. The chip is
self-contained: no routine calls into $A000-$DFFF (only the task lists
point there).

## Files

| file | range | contents |
|------|-------|----------|
| `src/game/sub/gp2_6.js` | $E000-$E17F | reset, IRQ, dispatcher, end of frame; registers the whole chip |
| `src/game/sub/gp2_6_state.js` | - | yield markers `SYNC`, `SPIN`, `BUSY`, `RENDEZVOUS`; the timed bus helpers `rd` `rd16` `wr` `wr16` `rmw` |
| `src/game/sub/gp2_6_stage.js` | $E18A-$E5A9 | stage setup, formation sprites |
| `src/game/sub/gp2_6_e5.js` | $E5AA-$EBEB | capture beam, formation refill |
| `src/game/sub/gp2_6_eb.js` | $EBEC-$F5A4 | escort fly-ins |
| `src/game/sub/gp2_6_f5.js` | $F5A5-$FA2D | entry sequence, bonus sequence, enemy shots |
| `src/game/sub/gp2_6_fa.js` | $FA2E-$FFFF | bonus objects, formation launches, score animation |
| `test/oracle/sub-gp2_6-kit.test.mjs` | - | shared harness (romTask, portTask, romStub, ...) |
| `test/oracle/sub-gp2_6*.test.mjs` | - | one test file per source file, plus `-frames` |

Each helper exports `ROUTINES` (address -> function); gp2_6.js puts all
of them into `SUB` and `SUB_AT`. Every task-list entry and jump-table
target of the chip is in `SUB_AT` (tested).

## Conventions

* **Task** = the code a task-list entry points at, up to its
  `JMP task_dispatch_sub`. The port's task does that work and returns;
  the return is the jump. `task_dispatch_sub` is a `for (;;)` loop.
  (Same convention as sub-A's gp2_8.js.)
* **Cycle-exact.** Every routine is a generator that charges its 6809
  cycles (`m.sub.charge`, the oracle core's counts) and yields `SYNC`
  right before every instruction that touches RAM $0000-$1FFF or the IRQ
  latch $6000-$6FFF, with everything before it charged: the charged time
  at a SYNC is the cycle at which the ROM starts that instruction. The
  instruction's own cycles are charged after its access (helpers `rd`,
  `wr`, `rmw`... in gp2_6_state.js). ROM reads do not SYNC. A task's
  cycles run from its first instruction to its final `JMP
  task_dispatch_sub` inclusive; a subroutine's to its RTS (the caller
  charges the JSR/BSR).
* A **CWAI** inside the foreground charges its 16 cycles, then one bare
  `yield` (the wake-up's 4 cycles are the scheduler's). Tasks with a
  CWAI: `task_end_frame_sub` ($E17F), `sub_EBEC` ($ED16), `sub_F5A5`
  ($F5FE), `sub_F60B` (through its table).
* **Polls.** A failed poll pass is waiting, not charged (the $11 poll at
  boot, `frame_sync` in the IRQ); the pass that succeeds is. Exception:
  sub_EA4C's endless slot search charges every pass and yields `BUSY`
  after each fruitless one from slot 0 (a timing point: the main CPU can
  free a slot at the right cycle).
* Markers (`Symbol.for` keys shared with the scheduler and the main-CPU
  porters): `SYNC` = `'gaplus.sync'`, `SPIN` = `'gaplus.SPIN'`, `BUSY` =
  `'gaplus.busy'`, `RENDEZVOUS` = `'gaplus.rendezvous'`.

## Routines

| addr | name | what |
|------|------|------|
| $E000 | reset_sub | boot: $11/$22 handshake, ROM checksums, IRQ on, task loop |
| $E061 | irq_sub | ack, sprite copy (flip-aware), park unused slots, rendezvous |
| $E0EC | task_dispatch_sub | `sub_mode_task_lists[game_mode][sub_task]` forever |
| $E17F | task_end_frame_sub | CWAI, clear sub_task |
| $E18A | task_stage_setup | mode 2: sprite template, then formation layout, mode + 1 |
| $E341 | sub_E341 | formation tiles; dispatch on frame_counter & 7 |
| $E369 | sub_E369 | formation sprite codes for this frame |
| $E3DA | sub_E3DA | move the formation along its path, slot positions $1602 |
| $E4B5 | sub_E4B5 | scan_formation, next task |
| $E4BD | sub_E4BD | slot positions at $1B00 |
| $E51C | scan_formation | (subroutine) formation codes -> sprite flags/colours |
| $E5AA | sub_E5AA | $188A/$188B bookkeeping |
| $E5B8 | sub_E5B8 | capture-beam timer and start |
| $E654 | sub_E654 | capture: steer the ship |
| $E729 | sub_E729 | capture: window test over the formation |
| $E7ED | sub_E7ED | capture sub-state dispatch (tbl_E7F5) |
| $E7FF, $E8B0, $E8D7, $E934, $E9E8 | sub_E7FF ... | capture sub-states 0-4 |
| $EA4C | sub_EA4C | formation refill (generator: BUSY, below) |
| $EBEC | sub_EBEC | escort fly-in A (CWAI at $ED16, then mode + 1) |
| $F0ED | sub_F0ED | (subroutine) reset formation rows |
| $F116 | sub_F116 | escort fly-in B |
| $F5A5 | sub_F5A5 | stage entry sequence (CWAI at $F5FE, then mode + 1) |
| $F60B | sub_F60B | bonus sequence, tbl_F62B -> $F6C7 $F6D9 $F72C $F75D $F79D |
| $F844 | sub_F844 | enemy shots |
| $F8C9 | sub_F8C9 | (subroutine) shot velocity |
| $FA2E | sub_FA2E | move the bonus objects |
| $FB09 | sub_FB09 | refresh formation sprites when $10BF |
| $FB58 | sub_FB58 | show/hide flags from $188A/$188B |
| $FB77 | sub_FB77 | launch group 1 (tbl_FBA8 -> $FBB0-$FBB3) |
| $FC6D | sub_FC6D | launch group 2 (tbl_FC9E -> $FCA6-$FCA9) |
| $FD59 | sub_FD59 | launch trios |
| $FE31 | sub_FE31 | start the $188A object |
| $FE82 | sub_FE82 | score animation (dat_F0C1) |

Names proposed for these and for ~40 RAM bytes:
`reference/annotations/proposed/sub-E.json`.

## For the scheduler (integration agent)

**Boot entry.** `reset_sub(m)` from the RESET vector (the scheduler adds
the 4-cycle vector fetch). It charges 15 cycles, then polls $0800: `SYNC`
before each read, `SPIN` after a failed one (not charged). After the $11
it charges the three checksum loops in lumps (3 x 106,501 cycles, ROM
only, no SYNC) and SYNCs before each write that follows, so the scheduler
spends the 13 frames there by itself: `$0801` is cleared in frame 96,
`$22` and the 256 `$6001` latch writes land in frame 109, at the board's
cycles (tested write by write, relative to the successful poll). Then
`SYNC` / `m.sub.cli()` (ANDCC at $E05C) and the task loop. No bare yield
at boot.

**Foreground.** `task_dispatch_sub` SYNCs before its reads of game_mode
and sub_task and once more right before every task (whatever chip the
task is in). A bare yield is a CWAI with CC.I cleared: resume after the
next sub IRQ handler. At every vblank after boot the sub foreground
sleeps in a CWAI ($E181 ~70%, $BF86 ~30%, rarely $ED18, $F600, $BC8F;
16,000 frames measured), so no task is ever interrupted in the middle.

**IRQ handler.** `irq_sub(m)` is a generator charging from $E061 to its
RTI (15 cycles; the 19-cycle entry, 4 out of CWAI, is the scheduler's).
The acknowledge `$6080` and the final `$6081` are latch writes at the
start of their `STA` (the scheduler adds its 5 cycles). The `$10AF = $11`
store at $E0E0 is SYNC'd at the board's cycle (tested on 40 real frames;
~4,830 after the entry in attract), then `RENDEZVOUS` per failed poll.
The 125 lost frames at boot (the first sub IRQ at frame 110, main's IRQ
only from 235) are 125 frames of `RENDEZVOUS`.

## Tests

`node --test test/oracle/sub-gp2_6*.test.mjs` (all pass, ~8 s):

* per routine: seeded-random RAM plus a setup per branch; the ROM runs
  on the oracle's sub CPU (tasks to $E0EC with `romTask`, subroutines to
  their RTS) and the port from the same state. Compared (`sameTiming`):
  RAM, the sub IRQ latch, the total cycles, every write with the cycle
  its instruction starts, the SYNC stamps (= the start of every ROM
  instruction touching shared memory), the CWAI cycles and tick counts.
  A deliberately wrong cycle count fails them (checked for every file).
  e5/eb also require every code instruction of their range to have run.
* `reset_sub`: writes and SYNC stamps against the full board from
  power-on, with good ROMs and each checksum broken.
* `irq_sub`: 300 random shadow buffers, flip on/off, 0-3 failed polls;
  the $E0E0 store against 40 real frames of the board.
* `task_dispatch_sub`: modes 1 and 2 from random states to the CWAI,
  task entries as timing points.
* `-frames`: ~3,500 RAM states captured at vblank from attract and a
  played 1P game; from each, one sub foreground frame ($E181 -> the task
  loop -> the next CWAI) on both sides: RAM and cycles (the other chips'
  tasks as ROM stubs).

## Lockstep (tools/lockstep-run.mjs)

| run | before | after |
|-----|--------|-------|
| `4000 --timing` | first difference frame 252 | frame 252 (below) |
| `4000 --resync --play=1` | 2,446 frames differ, longest run 261 | 139, longest 5 |
| `12000 --resync --play=1` | - | 274 differ, longest run 5 |

Frame 252 (`attract_timer $1029`, one extra attract pass) is no longer
the sub: its handler writes $11 at 4,830 as on the board, but the port's
slice grid differs (port slices at 4,121 + 256k, board at 76.8 + 256k:
the I/O run's cut disappears when it is delivered early, and the main
handler starts 9-25 cycles late), so main sees the $11 at 4,889 instead
of 4,941 and both handlers end ~55 cycles early.

## ROM quirks reproduced on purpose

* `sub_E8B0` stores A (`sta <$D8` = $1E93 >> 1) where its siblings store
  the halved 9-bit value in B: likely a ROM bug.
* `sub_EA4C`: with no free formation slot the search loops forever
  (`clrb / bra $EACA` at $EB29); ported as BUSY yields.
* `$E6EF`: `ldd $1600 / subb #$05 / sta $168A` discards the SUBB.
* `$E72F`: the borrow of `subb #$10` is lost (LSRA overwrites C).
* `sub_E9E8` ($EA37): DECB before the test, so 5 of 6 entries are tested.
* `sub_FB77` / `sub_FC6D`: the index from `anda #$60 / lsra x4` is
  overwritten by `lda <$B4` / `<$B9`, so the table always takes entry 0
  or 3; the thresholds at U+2/U+4 are dead.
* `sub_FCA9` does `stb $084D` where `sub_FBB3` does `inc $084D`.
* `sub_FE82`: the first animation frame indexes dat_F0C1 with the score
  byte just compared, not $101E.
* `sub_FD59`: reads $188B but exits before testing it.
* `sub_F60B`: `asla` is 8-bit, so steps $80-$9B act as $00-$1B; steps
  from $1C jump through data past tbl_F62B (a crash on the board, a
  throw in `subAt` in the port).
* `sub_F75D` never tests slot $1F1F; `sub_F844`'s free-slot search stops
  only on an exact match with $1064.
* `sub_F116` never advances $1116-$1118 (sub_EBEC does).
* `task_stage_setup` and `sub_E369` index their stage tables with a signed
  `a,x` offset from `$106E * 2`: values above 2 read further into the ROM
  (reproduced, tested).

## Open questions

* `$500F` (256 writes at boot): unmapped in MAME, purpose unknown.
* The meaning of most RAM in $1080-$11FF is inferred from the code only
  (proposed names above).

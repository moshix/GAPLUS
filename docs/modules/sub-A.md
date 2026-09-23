# sub-A: ROM gp2-8.11d (sub CPU $A000-$BFFF)

Copyright 2026 by Moshix

## What is in the chip

| range         | contents                                                |
|---------------|---------------------------------------------------------|
| $A000-$B013   | data: movement tables (dat_A96A/A9D6/AA39/AA9C heading-to-target octants, dat_AAFF heading table: 4 bytes per heading = sign bits (b7 Y, b3 X), dy, dx, picture/flip), path data |
| $B014-$BF8A   | 38 routines (below), with their small tables in between |
| $BF8B-$BFFF   | copyright text, $FF fill, checksum byte $BFEF           |

All 38 routines are reached through jump tables (the mode task lists
$E10D-$E17D, tbl_B3E6, object_states $BB22, tbl_BEDD) or calls, and all
are registered in `SUB` and `SUB_AT`.

## Files

| file | what |
|------|------|
| `src/game/sub/gp2_8.js` | registers everything; `GP2_8_ROUTINES` (address -> fn) |
| `src/game/sub/gp2_8_formation.js` | formation mover and helpers, attack timer, mode-0 init |
| `src/game/sub/gp2_8_fighter.js` | power-up effects around the ship ($B3D1 and tbl_B3E6) |
| `src/game/sub/gp2_8_objects.js` | the four objects and their launcher |
| `src/game/sub/gp2_8_bonus.js` | challenging-stage sequencer, bonus objects, colour cycler |
| `src/game/sub/gp2_8_util.js` | `inc`/`dec`/`nextTask`, `[$nnnn]` indirect helpers |
| `test/oracle/sub-gp2_8.test.mjs` | the differential tests (22) |
| `test/oracle/sub-gp2_8-lib.test.mjs` | test helpers: `runRom` (until RTS or `jmp task_dispatch_sub`, CWAIs counted), `capturePlay` (real entry states from a scripted game) |

## Conventions

Tasks follow the sub-wide convention of `gp2_6.js`: a task does its work
up to `inc <sub_task` and returns (= `jmp task_dispatch_sub`). The two
tasks that `cwai` (`task_formation_init`, `sub_BB96`) are generators with
one bare `yield` there. Handlers reached through a table take the
registers the ROM passes: object states `{ u, y }`, bonus states
`{ x, u }`, tbl_B3E6 handlers `{ a }`; `sub_B163` returns `{ x }` (the
heading entry `sub_B20D` needs). Every `[$nnnn]` operand re-reads its
pointer at each access, as the CPU does.

## Timing (round 2)

Every routine is a generator that charges the MC6809's exact cycles
(`m.sub.charge`, instructions quoted next to the counts) and yields
`SYNC` right before every instruction that touches shared RAM
(`timed` in gp2_8_util.js: $0000-$1FFF except the sub stack
$1D74-$1D80, plus the $6000-$6FFF latch). Pointer operands (`,x`,
`[$1090]`, U/Y of the object handlers) SYNC when their computed address
is timed (`syncAt`). A routine charges its RTS, or its task's final
`jmp task_dispatch_sub` (4); callers charge JSR (8) / BSR (7); the
table jumps (`jmp [a,x]`, 7) are charged by the dispatching routine.
A CWAI charges 16 cycles, then a plain `yield`; the wake-up (4) and the
IRQ are the scheduler's.

Tests compare, for every call: RAM, frames waited, the total cycles
(entry to RTS / final JMP) and the list of SYNC stamps against the
cycle at which the oracle's core starts each instruction touching a
timed address. A test sabotages one charge (+1 cycle) and drops one
SYNC and requires both to be caught.

## Routines

| addr | name | what |
|------|------|------|
| $B014 | sub_B014 | task: formation mover, every moving slot once a frame |
| $B0D4 | sub_B0D4 | step a slot along its path (commands $F0/$FF/$FE) |
| $B163 | sub_B163 | move a sprite n units along a heading (MUL fractions) |
| $B20D | sub_B20D | picture and flip bits from the heading entry |
| $B242 | sub_B242 | home on the formation position, or arrive |
| $B385 | sub_B385 | task: formation-attack timer ($112A := $55 / 0) |
| $B3D1 | sub_B3D1 | task: run power-up effect $1070 (tbl_B3E6) |
| $B3F2 | sub_B3F2 | effect 1: sequence stepped by $10D0 |
| $B461 | sub_B461 | animate the six effect sprites (dat_B483) |
| $B5A1 | sub_B5A1 | effect 0: rising sprites, picture lists dat_B653 |
| $B860 | sub_B860 | effects 2-5: one-shot setups (A = 2 * effect) |
| $B90E | task_animate_objects | task: the four objects' state machines |
| $B92B | sub_B92B | task tail / object state 0 (leaves the loop) |
| $B930 | object_state_call | `jmp [a,x]` into object_states |
| $B936 | object_spawn_random | state 1: noise position from the sub's own code |
| $B96B-$B9B5 | sub_B96B ... sub_B9B5 | states 2-9: picture words (+ move at 5) |
| $B9BD | sub_B9BD | state 10: blink, explode if its flag lacks b7 |
| $B9E2 | sub_B9E2 | state 11: pick 12 or 13 by player_y |
| $B9F0 | sub_B9F0 | state 12: move down/right, explode on player_y |
| $BA18 | sub_BA18 | state 13: move up/right |
| $BA8E | sub_BA8E | state 14: fragments fly apart, then cleared |
| $BB50 | sub_BB50 | task: launch objects every $2D frames |
| $BB96 | sub_BB96 | task (generator): challenging-stage sequencer |
| $BCF3 | sub_BCF3 | task: the five bonus objects |
| $BD18 | sub_BD18 | `jmp [a,y]` into tbl_BEDD (state - 1) |
| $BD20 | sub_BD20 | bonus state 1: launch |
| $BD56 | sub_BD56 | bonus state 2: fly; back to the start and next pass |
| $BE4F | sub_BE4F | bonus state 3: hold at the start point |
| $BE6C | sub_BE6C | bonus state 4: free flag := 1 |
| $BEE5 | sub_BEE5 | task: bonus colour cycle (dat_BF27 / dat_BF40) |
| $BF58 | task_formation_init | mode-0 task (generator): slots, pointers, CWAI |

## ROM quirks reproduced on purpose

* **Noise table is signed.** `object_spawn_random` does `ldx #$E000 /
  lda a,x` with A = frame_counter: the offset is signed, so counters
  $80-$FF read $DF80-$DFFF (gp2-7's $FF fill, clamped to $60, and $B7 at
  $DFEF), not $E080-$E0FF. The docs said "$E000 + frame_counter". The
  read goes through `subRom` (romdata.js) as code-as-data; request 1 in
  `docs/requests/sub-A.md` asks for $E000-$E07F to be whitelisted.
* **Object state $80** (never produced by the game) maps to handler 0
  (`asla` drops b7) = $B92B, which `jmp`s to the dispatcher from inside
  the object loop, leaving `pshs u` + the BSR return (4 bytes) on the sub
  stack until the next `lds`. The port returns `TO_DISPATCH` and the loop
  stops; the stack is exempt.
* `sub_B983` adds $0808 to the position as one 16-bit value: X's carry
  goes into Y.
* `sub_BB96` $17 searches dat_BCB4 for the stage with no end marker; for
  a stage not in the list it runs on through memory (ported as is).
* Unbounded scans kept exact: `sub_B014` / `sub_B385` from a
  formation_ptr past the table wrap through the address space, which is
  how the Round Advance corruption of docs/oracle-notes.md section 8
  comes about (mode 7 runs $B014 from a stale formation_ptr).
* Table indexes are 8-bit shifts with signed `a,x` offsets throughout
  (`disp8`), even where the game never goes out of range.

## Testing

`node --test test/oracle/sub-gp2_8*.test.mjs` (~4 s): real entry states
(a 7,000-frame scripted game with a Round Advance into the challenging
stage, up to 40 states per routine) replayed and run on for 60 frames;
perturbed copies for the arrival / $DD44 / path-command branches; seeded
random states and multi-frame simulations for the code the recorded
game never runs (object states, effects $B3F2/$B5A1/$B860, all 256
noise values). Every instruction of $B014-$BF8A is executed by the ROM
side of these tests (checked by instrumenting the core).

## Open questions

* The meaning of the effects ($1070 = 0..5) and objects in game terms
  (power-ups? the "captured" ships?) - names in the proposed annotation
  file are tentative.

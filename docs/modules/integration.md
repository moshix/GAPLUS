# Integration: sound CPU, scheduler, port, lockstep

Copyright 2026 by Moshix

## Files

| file | what |
|------|------|
| `src/game/sound/gp2_1.js` | every routine of gp2-1.4b, cycle-exact |
| `src/game/sound/index.js`, `main/index.js`, `sub/index.js` | load the chip modules, export each CPU's entry points (main: the foreground driver with the non-local jumps, `mainIrq` with `NO_RTI`) |
| `src/game/chips.js` | chip loading that reports missing / broken modules |
| `src/game/clock.js` | the main foreground cycle clock (moved from gp2-2b) |
| `src/game/main/jump.js` | requestJump / takeJump / pendingJump (moved from gp2-3b) |
| `src/game/scheduler.js` | the frame: slices, clocks, IRQs, I/O run, SRESET, watchdog |
| `src/game/port.js` | `Port`: Machine + scheduler, the Board's front-end API |
| `src/engine.js` (`PortEngine`) | the page's "JavaScript" engine |
| `test/helpers/bridge.mjs` | test-only fallback bridge (M6809 cores) |
| `test/helpers/lockstep.mjs` | `makePortPair`, resync, SLOW_STATE |
| `tools/lockstep-run.mjs` | first divergence, runs, timing, bridged list |

## Sound CPU (gp2-1.4b)

18 routines plus the 12 jump-table fragments (`envelope_ops`,
`stream_ops`). Every instruction charges its MAME cycles; the code
yields SYNC right before each access to $0040-$007F (requests and
active flags, which the main CPU reads and writes) and each IRQ-latch
write / ANDCC. Tests (`test/oracle/sound-gp2_1.test.mjs`): reset from
random RAM; the IRQ on ~390 real snapshots (attract, coin, a played
game); every sound 0-25 from request to end; random requests. Each
compares RAM, the total cycles (19-cycle entry to RTI) and the cycle of
every timed access. ROM quirks kept: `op_end` returns straight to
`irq_sound` (PULS X,U / RTS); from inside `play_sound`'s block set-up it
would RTS into RAM (no stream does it; the port throws there);
`env_op_hold` passes its counter on as the volume.

## Scheduler

MAME's model, transcribed from src/emu/board.js: ticks of 1/5
cycle, slices of 256 cycles cut at vblank and at the I/O run, main then
sub then sound per slice, a line-changing write (IRQ mask off, SRESET)
ends the writer's slice at its time. Each CPU is an agent; `JsAgent`
runs the ported generators while the CPU's clock is inside the slice.
A chunk (code between two yields) is atomic at its start time; the
clock then advances by what it charged. Hence the race model: who wins
a race through shared RAM follows the CPUs' clocks, exactly as in MAME,
as long as the code charges its cycles and yields SYNC before accesses
another CPU can see. The I/O run is delivered lazily at vblank + 76.8
cycles (before the first main access to $6800-$681F past it). SRESET
releases the sub and sound where the `STA $8400` ends. IRQ entry 19
cycles, from a CWAI 4, from `idle(p)` on the loop's pass boundary.

Measured (test/oracle/lockstep.test.mjs, lockstep-scenarios.test.mjs,
tools/lockstep-run.mjs), every frame compared, no resync:

| run | round 2 | round 3 |
|-----|---------|---------|
| `lockstep-run 20000 --timing` (attract) | first difference frame 252 | 0 of 20,000 differ |
| `20000 --play=1`, `=2`, `=3` | 12,000 `--resync`: 274 differ | 0 of 20,000 each |
| coin on the title, 2P cocktail, challenging stage, Round Advance to PARSEC 11, operator stats, service mode, TOP 5 entry | - | 0 differ |

IRQ handler start/end cycles are identical to the board's in every frame
checked (`--timing`).

## Round 3: what made it exact

Scheduler (src/game/scheduler.js):

* The I/O run's slice cut goes away exactly when the board's core would
  make the early access: a ported chunk that runs past its slice keeps
  the cut until the main CPU's clock reaches that instruction.
* A slice ends where a CPU stops: a whole cycle short of a fractional
  target pulls it (MAME), using the ported chunk's instruction
  boundaries (one `charge()` per instruction) as the core's stop point.
* An IRQ due in the middle of a foreground chunk starts at its first
  instruction boundary after the vblank; the rest of the chunk is paid
  after the RTI (dropped when the handler jumps away, NO_RTI).
* Poll loops keep their phase (`pollAgain`, src/game/timing.js `poll`).
* `frameDue()`: an access by a chunk already past the next vblank must
  wait for it. BUSY is a timing point like SYNC.

Edits in the porters' files (the timing contract, porting-guide 6.4):

* All main and sub modules: grouped `charge(a + b)` split into one call
  per instruction (mechanical, literal sums only).
* main gp2-3b `irq_main`: accesses before their charges, SYNC at the
  IRQ latch, attract_flag, the `$1E31` clears (read by the sub's sprite
  copy), the coin sound, the coin-during-demo clears and `$22`;
  `frame_sync` polls through `poll()`. Its test driver refunds waiting.
* main gp2-2b: `RACY` + main_task `$1030` (the sub clears it on a mode
  change); SYNC before every `inc/clr <$30`; `isRacy` also true when
  `frameDue()`; the `$FC71` poll through `pollAgain`.
* main gp2-3b hit: SYNC before its `main_task` writes.
* main gp2-4 `Clock.sync()`: a SYNC after burning (the service mode's
  sound test); its test drivers skip SYNC.
* sub gp2-6: the `$0800` and `frame_sync` polls through `poll()`; test
  kit refunds waiting.
* sound gp2-1 (mine): SYNC before the store after the checksum stretch.

## Fallback bridge (test only)

`CoreAgent` runs a whole CPU whose entry points are missing on an
M6809 core (exactly as the Board). `installRoutineBridge()` fills the
registries with stand-ins for missing listing routines (run the ROM
routine on a scratch core over the port's RAM). Only `makePortPair({
bridge: true })` / `lockstep-run --bridge` use it; `lockstep-run` lists
what ran as ROM. Today nothing needs it: 0 stand-ins, no CPU bridged.

## Open

* Nothing left from the port plan.

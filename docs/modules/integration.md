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

MAME's model, transcribed from test/m6809/board.mjs: ticks of 1/5
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

Measured (test/oracle/lockstep.test.mjs, tools/lockstep-run.mjs):

* every CPU on a core under this scheduler = the oracle, 4,000 frames
  (boot, attract, coin, start, a played game);
* ported sound, main and sub on cores = the oracle, 4,000 frames;
* full port = the oracle for frames 0-232; then main/sub timing blips
  (docs/requests/integration.md 1-3). 12,000 played frames with resync:
  9,365 differ today, 1,678 with task-boundary SYNCs.

## Fallback bridge (test only)

`CoreAgent` runs a whole CPU whose entry points are missing on an
M6809 core (exactly as the Board). `installRoutineBridge()` fills the
registries with stand-ins for missing listing routines (run the ROM
routine on a scratch core over the port's RAM). Only `makePortPair({
bridge: true })` / `lockstep-run --bridge` use it; `lockstep-run` lists
what ran as ROM. Today nothing needs it: 0 stand-ins, no CPU bridged.

## Open

* The `costs` table of the scheduler is supported but not shipped
  (exact charges were chosen instead).
* The engine keeps the "in progress" tag until the played-game
  lockstep (`todo` tests) passes.

# Oracle notes: the emulated Gaplus board

Copyright 2026 by Moshix

The oracle is the real Gaplus ROM set running on three MC6809 cores
(`src/emu/m6809.js`) wired to the port's own memory map, latches and
I/O chips (`src/machine/machine.js`, `namcoio.js`). Tests compare the port
against it byte for byte; the "emulated preview" page runs it in the
browser. This file describes the board, its timing model and what was
measured on it. `docs/hardware.md` is the hardware reference;
`docs/porting-guide.md` the port's contract.

| file | what |
|------|------|
| `src/emu/board.js` | `Board`: three cores, MAME's scheduler, IRQs, I/O timing, watchdog, snapshots, hooks, coverage (browser-safe: no Node imports) |
| `test/helpers/oracle.mjs` | Node side: `makeOracle`, `callRoutine`, `saveState`/`loadState`, `diffRam`, `fillRandom`, `makeRng`, `randomPlayer` |
| `test/helpers/lockstep.mjs` | frame lockstep harness (`makePair`, `boardSide`, `oracleVsOracle`) |
| `test/oracle/board.test.mjs` | boot, attract frame, determinism, snapshots, coins, `callRoutine`, stacks, IRQ timing, exact I/O timing, runaways |
| `tools/shoot.mjs` | screenshots of the real ROM through `src/video/renderer.js` |
| `tools/coverage.mjs` | long scripted sessions, writes `reference/coverage/*.json` |

## 1. Board API

```js
import { Board } from './src/emu/board.js';
const board = new Board({ roms });  // roms = tools/romset.mjs loadGaplus()
// Node: import { makeOracle } from './test/helpers/oracle.mjs'
```

Constructor options: `roms` (required: `{ main, sub, sound }`, 64 KB
address-space images), `quantum` (slice length in cycles, default 256 =
MAME), `powerOn` (`'mame'` default, or `'held'`), `syncOnLatch` (default
true), `watchdog` (`'reset'` default, or `'count'`).

**Running.** `runFrame()`, `runFrames(n)`, `runUntil(pred, maxFrames)`,
`advanceTo(tick)` (ticks = cycles x 5, for mid-frame stops). `frame` =
frames completed. After `runFrame()` the board stands exactly at the next
vblank instant, before the IRQs are raised: the RAM MAME's screen update
draws, and the lockstep sampling point. `cycle` is the absolute cycle.

**State for the front end** (read after each `runFrame()`):

| property | meaning |
|----------|---------|
| `mem` | all RAM at main-CPU addresses (`Machine.mem` layout); pass to `Renderer.render(mem, { starControl })` |
| `starCtrl` / `machine.starCtrl` | `$A000-$A003` as last written; call `renderer.vblank(starCtrl)` after rendering each frame (stars move at vblank end) |
| `wsgRegs` | the 15XX register image (`mem[$6000-$603F]`) |
| `soundEnable` | 15XX output on (SRESET off) |
| `recordSound` + `wsgWrites` | when true, `[cycleInFrame, reg, value]` of every 15XX write of the frame just run |
| `onWsgWrite(reg, value, cycle)` | the same as a callback |
| `onBang(cycle)` / `bangs` | 62XX explosion trigger (main write >= `$0F` to `$6829`) and the count in the frame just run |
| `machine` | the `Machine` (latches `irqMask`, `sreset`, `io`, ...) |

**Inputs.** `setInput(name, down)` (Machine names: `coin1 coin2 service
start1 start2 fire1 fire2 up down left right p2up ...`), `setDip(field,
value)` (namcoio.js `DIP_FIELDS`), `inputs` (the live `InputState`,
e.g. `inputs.in2 = 0x0b` for a cocktail cabinet), `at(frame, name,
down)`, `tap(name, frame, hold = 4)`, `inputScript = (frame, board) =>
...` (called at the start of every frame, before its vblank).

**Instrumentation.** `onExec = (n, pc, core) => ...` before every
instruction (slow); `onWrite = (n, addr, value) => ...`;
`enableCoverage({ ignoreReaders })` + `coverageOf(n)`; `trackStack` +
`stackLow[n]`; `logIrqs` + `irqLog`, `irqStats[n]`, `lastIrq[n]` (section
5); `runaways` / `runawayCount` / `strictPc` (a PC outside ROM);
`watchdogResets`; `peek(addr, cpu)` / `poke(addr, v)` without side
effects; `frameCycle()` inside a hook.

**Snapshots.** `getState()` / `setState(s)` between frames: the three
cores, the Machine (RAM, latches, I/O chips), the inputs, the scheduler
(base time, each CPU's local time, pending I/O run, reset lines), watchdog
and IRQ tracking. A board restored into a fresh one runs identically
(tested over 1,500 frames of play).

**`callRoutine(board, cpu, addr, regs, opts)`** (oracle.mjs) runs one ROM
routine on one CPU: registers from `regs` (`a b d x y u dp cc`; DP
defaults to the CPU's, CC.I/F forced on), S = the CPU's stack top (or
`opts.stack`), return address `SENTINEL = $4000` pushed, only that CPU
stepped until PC = sentinel with S restored. Returns every register, the
flags (`cf zf nf vf hf`), `cycles` and `stackLow`. Throws on CWAI/SYNC or
after `opts.maxCycles` (5,000,000). Latch writes (SRESET) apply at once.

## 2. Timing model

MAME `gapluso` (docs/hardware.md sections 2 and 4), transcribed:

* **Clock and frame.** 1.536 MHz per CPU, exactly 25,344 cycles per frame
  (MAME's 60.606060 Hz literal would add 0.00025 cycle per frame). Time is
  kept in ticks of 1/5 cycle so the I/O run at 76.8 cycles is an integer.
* **The frame instant.** Frame k starts at its vblank (none at t = 0; the
  first IRQ comes one frame after power-on). In MAME's order: main IRQ
  line asserted if its mask is set, the 56XX/58XX runs armed unless FRESET
  holds them, sub IRQ, sound IRQ. Lines are level and stay up until the
  handler writes its disable latch; a vblank that finds the mask off is
  lost (no latch).
* **I/O chip run at exactly vblank + 76.8 cycles.** MAME's 6809 stops in
  the middle of an instruction at the timer, so an access in cycle index
  vblank + 76 or later sees the run's results. This core completes
  instructions, so `Board.ioCatchUp` delivers the run lazily: before the
  first main-CPU access to `$6800-$681F` past the deadline (read or
  write), else at the slice end. This matters for `LDD $6800` at `$C01A`
  (cycles 79/80 after the IRQ entry): with an IRQ latency of 0-1 cycles
  it straddles the deadline (review M1; tested with a synthetic ROM).
* **Scheduling** = `device_scheduler::timeslice()`: slices of at most
  `quantum` cycles, cut at every timer (vblank, I/O run); within a slice
  main, then sub, then sound run from their own local time to the slice
  end; a CPU held in reset eats its cycles. Writes that make MAME call
  `set_input_line()` -- main `$7800-$7FFF` (IRQ off) and `$8000-$8FFF`
  (SRESET), sub `$6000-$6FFF` with A0 = 0, sound `$6000-$7FFF` -- abort
  the writer's slice after the instruction; the CPUs after it then run
  only up to the writer's time, and the queued line change (SRESET)
  happens there.
* **Power-on** (`'mame'`): all three CPUs start at t = 0. Main's second
  instruction `STA $8C00` (cycle 12) stops the sub and sound CPUs after
  their first instructions (sub `ORCC`/`LDA`/`TFR`; sound `STA $6000`,
  which is itself a line-changing write and ends its slice). They restart from their vectors (CC.I,
  CC.F set, other registers kept) when main writes `$8400` (frame 96).
  `'held'` starts them in reset: RAM and timing identical (tested).
* **Watchdog**: armed by the first kick (main reads `$7800-$7FFF`, sound
  `$2000-$3FFF`), fires 3 s = 4,608,000 cycles after the last kick
  (MAME soft reset: CPUs, VINTON, 56XX/58XX). Never fired in any run.
* **PC invariant**: every step checks PC >= the CPU's ROM start; the core
  skips MAME's dummy reads at PC+n, which is only invisible from ROM. No
  runaway in ~78,000 frames of sessions.
* **Remaining difference from MAME**: at a slice boundary this core
  finishes the current instruction and carries the overshoot; MAME pauses
  mid-instruction. A bus access in the overshoot therefore happens before,
  not after, the other CPUs' part of that slice. The board is exact to the
  cycle within a CPU and to one instruction between CPUs. There is no MAME
  trace to compare with; the port matches **this** oracle.

## 3. The interleave choice and its effect

Default quantum 256 = MAME's `set_maximum_quantum(1/6000 s)`. All values
from 1 to 1,000 boot: the `$11`/`$22` handshakes work, attract begins at
frame 240 every time (the hardware agent's ~600-cycle limit concerns the
sound CPU clearing `$0040` ~700 cycles after its `$22`; the main CPU sees
it either way). `powerOn: 'held'` and `syncOnLatch: false` give RAM
identical to the default over 3,000 frames.

But the programs **do** race through shared RAM, so the quantum changes
the RAM. Measured against the default (same inputs):

| where | what differs | how |
|-------|--------------|-----|
| attract, from frame ~252 | `attract_timer $1029`, then the demo timing | `attract_loop` (`$C417`) is a busy foreground loop adding `$20` per pass (3 passes a frame, 2 on some); the passes left in a frame depend on when the main IRQ handler ends, which is its rendezvous with the sub handler (`frame_sync $10AF`, `$C158`) and so quantized by the slices |
| gameplay | enemy/sprite positions (`$1600-$17FF`, `$1860-$19FF`), `$1109/$110A`, then score | the main foreground copies positions the sub updates in the same part of the frame (e.g. `$D434 LDD ,U / STD $1109` at cycle ~9,750); which value it reads depends on who ran first in that slice |

Quantum 128 vs 256, one game (seed 11): 75 of 2,882 frames differ, one run
of 75 frames, then identical again; quantum 255/257/512: identical.
Quantum 1 (the closest to truly parallel hardware) vs 256, seeds 1, 2, 3
and 5: divergence within a few hundred frames that persists (1,273-3,490
differing frames per game of 2,800-5,000 frames, score included). The port therefore has to
reproduce the MAME slice order where these races occur (the Galaga port
had the same class of race, see galaga-method.md section 10), and
lockstep needs a resync strategy.

## 4. Boot and frames to attract

| frame (cycle) | event |
|---------------|-------|
| 0 (12) | main `STA $8C00`: sub + sound into reset |
| 1-95 | boot: tile RAM cleared to spaces (screen black), I/O chip checks with `delay_65536` (787,734 cycles = 31.1 frames each) between commands |
| 96 (17,095) | `$E0C7 STA $8400`: sub and sound start; `$11` handshakes |
| 102 | sound idles in `BRA *` at `$E053` |
| 103 / 110 | first sound / sub IRQ |
| 109 | main passes the `$22` handshakes, sub enters its dispatcher |
| 110-235 | the sub's first IRQ handler waits in `$E0E2` for main's `$22` (3,171,945 cycles): 125 sub vblanks lost, by design |
| 171 | FRESET pulse (`$E1DE`); 233 56XX coin mode |
| 235 | first main IRQ |
| **240** | `attract_loop`, `attract_flag $09F4 = 1`, title (pinned by the test) |

Attract cycle (no coins): title 240-~1000, demo game ~1000-3700 with
"GAME OVER", TOP 5 table ~3800-4900, challenging-stage demo ~5000-6700,
then again.

## 5. IRQ handler timing

`irqStats[n]` / `irqLog`: start = cycle (from vblank) the interrupt entry
began, end = cycle the handler finished (CC.I clear again after RTI, a
non-local exit's ANDCC, or CWAI). Steady state (attract 20,000 frames and
three 7,000-frame games, frames after boot and start):

| CPU | start | end: min / median / 99% / max | notes |
|-----|-------|-------------------------------|-------|
| main | 0-8 | 4,918 / 5,230 / 5,746 / 5,746 | ends at the `frame_sync` rendezvous with the sub |
| sub | 0 | 4,917 / 5,230 / 5,744 / 5,745 | waits at `$E0E2` for main's `$22`, ends 1 cycle before main |
| sound | 0-2 | 1,225 / 1,226 (attract) to 2,442 (play) / 6,431 / 8,243 | depends on the sounds playing |

Start latency = the instruction running at vblank (CWAI wakes at once).
No handler overruns a frame in normal play and no IRQ is lost after boot.
Exceptions, all genuine ROM behaviour: the boot rendezvous (sub, above);
a coin or start during attract leaves the main handler through a jump
(`$C062` path, counted in `abnormal`, ends ~10,600); the Round Advance DIP
loops inside the main IRQ (`round_select $C163`) while it is on (IRQs
lost meanwhile); the service mode (`$C016 LBNE $B6F6`) never returns
from its first IRQ. The main handler's first I/O reads (IRQ latency 0):
`$6816` at cycle 41 (`$FCDF`), `$6805` at ~50 only with SW1:6 on,
`$6814` at 67, `$6800/$6801` at 79/80, `$6802` later -- hence "ioUpdate
right after vblank" for the port (porting-guide section 6.1).

## 6. The random number question

Gaplus has **no PRNG routine**: no RAM seed is stepped by shifts/EORs
anywhere (the only EORs compare score parity and RAM-test patterns). What
it uses instead:

* `frame_counter $1016`, `INC` by the main IRQ at `$C14C` (with `frame_hi
  $1015` saturating), cleared at game and stage starts (`$D15D`, sub
  `$F600`, `$EB44`). Both CPUs index tables and pick behaviours with it:
  sub `$E34E` (`& 7`, dispatch), `$E373`/`$E3B0` (mixed into tables),
  `$EAC0` (mod 39), `$BA91`; main `$C9AE`, `$F908`, `$FE54`.
* **The sub's ROM as noise**: `object_spawn_random $B936` reads
  `$E000 + frame_counter` for a position. The offset (`LDA A,X`) is
  signed: frame_counter $00-$7F reads its own reset code at
  $E000-$E07F, $80-$FF reads $DF80-$DFFF (gp2-7's $FF fill and the
  checksum byte $B7 at $DFEF).
* Score parity: sub `$F60B`/`$F6B9` (`score_p1+1 EOR score_p2+1 & 1`).
* Player timing and position (inputs), which change when things happen
  and therefore the frame counter values seen.

None of these depends on cycle timing by itself: the frame counter moves
once per frame, and the game logic runs per frame. **No idle-loop
counter feeds gameplay.** The one busy-loop counter is `attract_timer
$1029` (section 3), which only schedules attract phases. What does make
gameplay timing-dependent is the main/sub race of section 3 (a copied
position), not an RNG. So the port needs no R-register-style replay
hook; it needs the frame counter and the race order right.

## 7. Stack extents

Measured with `trackStack` over all coverage sessions (~78,000 frames)
and 128 games of 6,000-12,000 frames with Round Advance to every PARSEC
from 1 to 64 (random play after the advance):

| CPU | S top | lowest S | exempt (`mem`) |
|-----|-------|----------|----------------|
| main | `$1600` | `$15E2` | `$15E2-$15FF` |
| sub | `$1D80` | `$1D70` | `$1D70-$1D7F` |
| sound | `$0400` | `$03EB` | `$63EB-$63FF` |

The sub reaches `$1D70` from PARSEC 3 on (an IRQ frame 4 bytes deeper
than anything stage 1 does; the coverage sessions only reached `$1D74`,
so PARSEC 31 showed false lockstep differences at `$1D70-$1D72`). The
sound CPU reached `$03EB` once (PARSEC 33). No variable lives in either
new byte range (listings, symbols.json).

Main's `$15E2` (2 below the earlier table's `$15E4`) is the vblank IRQ's
12 bytes landing inside `$D07A`'s call chain at game start; every write
at `$15E2-$15E7` was checked to be a push. The service mode only reaches
`$15FA`. `machine.js STACKS` and porting-guide section 5.3 are updated;
`test/oracle/board.test.mjs` checks a game reaches exactly `$15E2`.

## 8. ROM quirks found on the way

* **Round Advance straight into a challenging stage runs the main CPU
  in video RAM.** With the DIP on before the first stage, advancing to
  PARSEC 3, 8 or 13 (stage index 2, 7, 12) goes mode 0 -> 7 without
  mode 2, which is where the sub initialises `formation_ptr $1086`
  (`$E1F2`). The sub's formation mover (`$B014`) then walks from the
  stale pointer ($0000) through all of RAM, counting every byte in
  `$1096` and treating each one with b1 set as a formation slot: it
  adds `$80` to it (`$B09B`) and points its slot variables (`$1084`-
  `$10CB`) and their stores at addresses derived from the count. Three
  frames into mode 7 (frame 1018 of the scenario) those stores zero
  `$15FA-$15FF`: Y, U and PC of the frame the main CPU's `CWAI` at
  `$D150` has stacked. The next vblank's `irq_main` ends with `RTI` to
  `$0000`: the main CPU executes the tile RAM (`$20` = `BRA +$20`, a
  `LEAY`, `NEG <$00` = `NEG $1000` 464 times with DP = `$10`) up to a
  `SWI` (`$3F`) in the attribute RAM at `$07C6`, which vectors to
  `irq_main` again (a second clock and frame-counter tick in frame
  1019). From then on every `RTI` pops PC `$07C7` with I clear while the
  IRQ line is up, so the main CPU only ever runs `irq_main`: its task
  lists are dead, `game_mode` reads `$87` (the walk's `+$80`), and the
  walk, reaching the main stack, reads and modifies return addresses and
  stale frames there. Emulation-independent (the ROM on the board does
  it at any quantum). **The port cannot follow**: it keeps no registers
  and writes no stack frames or return addresses, which the walk reads
  and the `RTI` pops. The scheduler detects the case (a sub-CPU write
  into `$15E2-$15FF`, then the main CPU's `RTI`) and throws `RomQuirk`
  in frame 1019, the frame the ROM leaves the program; up to there the
  port equals the ROM (`test/oracle/lockstep-scenarios.test.mjs`, "RA
  straight to PARSEC 3/8/13"). After one normal stage Round Advance
  works; the browser has no Round Advance control.
* `challenging_stages $D860` holds 0-based indexes 2, 7, 12, ... (PARSEC
  3, 8, 13): the listing comment said 3, 8, 13 (fixed in the annotation).
* All TOP 5 entries are 50,000 at power-on, so a name entry needs more.
* A score jump crossing several bonus thresholds awards a life per frame
  until caught up (seen when poking the score).

## 9. Coverage and screenshots

`node tools/coverage.mjs` (~25 s) runs: 20,000 frames of attract; three
random-input 1P games to game over; a coin during the demo and a 2P
cocktail game; the challenging stage (Round Advance after the first
death); PARSEC 11 with harder DIPs; a high-score name entry (score and
lives poked); the service mode with every input; the operator-stats DIP
with 2C/1C coinage. It writes `reference/coverage/{main,sub,sound}.json`
= `{ cpu, exec, dataRead, ignoredReaders, dp }` (4,308 / 2,358 / 431
instructions; 4,100 / 9,028 / 4,058 data bytes). `dataRead` leaves out the
whole-ROM checksum and RAM-test loops (`ignoredReaders`); `dp` lists the
boot instructions that run before `TFR A,DP`. `tools/gen-listing.mjs`
reads it (it now accepts `exec` as well as `executed`); the static trace
had already found every executed instruction.

`tools/shoot.mjs` (options `--coin@F --start@F --play=SEED --dip=F:V[@F]
--round=N@F --poke=ADDR:V@F --hold=NAME@F-G --every=N`) produced
`screenshots/rom-*.png`: boot (black while the chip checks run), the
service-mode test screen, title, demo, TOP 5, challenging-stage demo,
push-start screen, a game, PARSEC 11, the challenging stage and its
EARNINGS screen, game over, a TOP 5 name entry. All look like the real
game; no renderer or board problem was found.

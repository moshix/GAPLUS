# Port review: scheduler, game modules, engine, front end, tests

Copyright 2026 by Moshix

Reviewer: senior code review, 2026-09-23. Read-only: no source file was
changed. Repro scripts live in the session scratchpad (`latches.mjs`,
`reach.mjs`, `ra2.mjs`, `p11.mjs`, `p31.mjs`, `quirk.mjs`, `dips.mjs`,
`poweron.mjs`, `speed.mjs`). Their essential code is quoted below so the
findings can be re-checked.

Other agents were changing files during the review: `test/m6809/*` was
moved to `src/emu/`, `gp2_4_hiscore.js` is getting cycle charges and
`romdata.js` its ROM data mask. Every finding below was re-checked
against the files as they were at the end of the review.

Test run: `npm test` -> **518 tests, 518 pass, 0 fail, 0 skipped**,
141 s wall time.

## Summary

| severity | count |
|----------|-------|
| critical | 0     |
| major    | 4     |
| minor    | 12    |
| style    | 8     |

The port matches the ROM in the situations the tests drive. I also
checked situations no test drives, and it still matched: PARSEC 11,
PARSEC 31 (once the stack exemption is fixed, m1) and PARSEC 56, bonus
rows 1-6, difficulties 1/3/5/6, lives 2/4, coinage 3C1C/1C2C, upright 2P
games, a power-on after play, and all latches over 6,000 frames. The
problems:

* one documented ROM quirk the port does **not** reproduce (M1);
* test scenarios that do not reach what their titles claim, so the
  coverage numbers are too high (M2, M4);
* in the browser, failures are silent (M3).

---

## Major

### M1. Round Advance straight into a challenging stage: the port leaves the ROM at frame 1019, then throws

*Where:* the sub's mode-7 code walking a stale `formation_ptr`
(`docs/oracle-notes.md` section 8; `docs/modules/sub-A.md`, "Unbounded
scans kept exact ... which is how the Round Advance corruption ... comes
about"). The notes say "the port must reproduce it". No lockstep test
covers it: the scenario test's Round Advance comes after the first
death, when a normal stage has already set `formation_ptr`.

*Evidence* (`quirk.mjs`: `makePortPair()`, coin at 300, start at 360,
`randomPlayer(41)`, Round Advance DIP on at 700, 2 presses of up, inputs
copied board -> port each frame as in `lockstep-scenarios.test.mjs`):

```
1016 mode 7 port mode 7
frame 1019 15 diffs
$09F8 clock_frames oracle=$86 port=$05
$1016 frame_counter oracle=$D5 port=$D4
$1096 formation_slot oracle=$19 port=$39
$16A3 formation_x+$1A oracle=$87 port=$81
...
threw at 1052 sub ROM $BCF3 is code, not data
```

The same happens with 7 presses (PARSEC 8, first diff at 1119, throw at
1151). With 12 presses (PARSEC 13) the diff comes at 1219, with no
throw; after that 4,781 of 6,000 frames differ. The oracle shows the
documented `+$80` corruption (`$86` = `$05 + $81`). The port does not,
and it also falls one frame behind (`frame_counter`). The throw comes
from the new ROM data mask (`romdata.js:1375-1377`): on this path the
ROM reads code as data on purpose, so the mask turns a documented quirk
into a crash.

*Fix:* add this case as a lockstep scenario. Trace `sub_B014`/`$B09B`
from the frame-1016 state, oracle against port (`sub-gp2_8-lib`
already has a replay kit). Whitelist the code-as-data reads this path
makes, or have the mask report them without throwing. Browser impact
today is nil: the page has no Round Advance control.

### M2. "Round Advance to PARSEC 11" never advances; the coverage numbers are too high

*Where:* `test/oracle/lockstep-scenarios.test.mjs:119-127` and the same
session in `tools/coverage.mjs:162-172` (`roundAdvance(b, 460, 10)`).

*Evidence* (`reach.mjs`/`ra.mjs`: the test's setup on a bare board,
stage = `$1035`, stage_p1 = `$1106`):

```
parsec11 modes 0,1,2,3,4,5,6,9  stage 1        <- PARSEC 2, not 11
RA at 460 max stage index 0
RA at 700 max stage index 10                   <- what was intended
RA at 850 max stage index 10
RA at 950 max stage index 0
```

At frame 460 the first "PLAYER 1" screen is still up (mode 0 runs from
frame 360 to 1001), and Round Advance only works in a later window.
So this lockstep has never run PARSEC 3-11. The coverage JSONs
(`reference/coverage/*.json`, cited in `machine.js` for STACKS and in
the docs) come from the same broken session. As a measure of what the
sessions reach: they execute 4,308 of 5,660 listed main instructions
(76%), 2,358 of 3,194 sub (74%) and 431 of 452 sound. The sub-gp2_7
trace test prints "32 of 46 streams stepped".

With the press moved to frame 700 (`p11.mjs`), the port matches: PARSEC
11 over 8,000 frames with 0 differing frames, and PARSEC 56 over 6,000
frames with 0 differing frames. PARSEC 31 matches too once m1 is fixed.

*Fix:* start the Round Advance at 700 (or when `$1035`'s "PARSEC" text
appears) in both files. Put the session helpers in one shared module
(see m11), then regenerate the coverage JSONs.

### M3. In the browser, a crash freezes the screen with no message and a stuck tone

*Where:* `src/main.js:300-319` (`stepFrame`), `src/main.js:259-293`
(`tick`), `src/engine.js:381-395`, `src/audio/mixer.js:30-36, 163-171`.

1. **The port throws.** `PortEngine.runFrame` catches the error and sets
   `ready = false` and `why`. After that, `stepFrame` returns early on
   `!engine.ready`, and nothing calls `showStatus(engine.why)`, which
   only `setEngine` does. The last frame stays on screen,
   `canvas.dataset.ready` stays `"true"`, and `sound.update()` is never
   called again. The mixer's documented jitter rule then applies: "if a
   frame is late it keeps playing with the registers held". So whatever
   tone was sounding plays forever. The engine header promises "stops
   (not ready, with the reason)"; the page never shows that reason.
2. **Anything else throws.** Examples: `ai.step()` (`src/ai/hook.js:65`
   has no guard, and the AI is new code), the renderer, or the sound
   engine. The exception escapes `tick` before
   `requestAnimationFrame(this.tick)` is queued again. The loop stops for
   good, with no message, and sound stays on held registers.

*Fix:* in `stepFrame`, when `engine.ready` goes from true to false,
call `showStatus(engine.why, 'play the ROM version', ...)`, set
`dataset.ready`, and `sound.setSoundEnable(false)`. Wrap the body of
`tick` in `try/finally` so the next frame is always queued, and turn an
exception into the same stop-with-message path. Wrap `ai.step()` so a
failing AI switches itself off instead of stopping the game. Add a
frontend unit test: an engine whose `runFrame` throws must lead to a
visible status and a silent sound engine.

### M4. Lockstep scenarios check only that RAM is equal: not that the scenario happened, and not the latches

*Where:* `test/oracle/lockstep-scenarios.test.mjs` (only the TOP 5 test
checks that its situation happened) and `test/helpers/lockstep.mjs:282-288`
(`diffRamRaw` over `RAM_REGIONS` only).

* A scenario that silently does nothing still passes, as M2 shows. The
  others do reach their goal today (`reach.mjs`). The cocktail test
  reaches `cur_player` 0/1 and flip 0/1. The challenging test reaches
  mode 7/8 with stage index 3. But nothing asserts it, so any change to
  the scripts or DIP handling can empty a scenario without a failing
  test.
* The whole-game lockstep never compares `starCtrl` (the starfield
  drawn on screen), `irqMask`, `sreset`/`soundEnable`, the 56XX/58XX
  state (`io.getState()`), `bangs` or the watchdog count. The routine
  tests do compare them (`main-gp2_3b.util.mjs:85-87`,
  `main-gp2_2b_harness.mjs:311-314`). `latches.mjs` shows they match
  today (6,000 frames of attract and play: only the bang cycle differs,
  m3), but a regression would go unnoticed.

*Fix:* have each scenario assert its goal: flip seen 0 and 1,
`cur_player` 1 seen, modes 7 and 8 seen, `$1035 >= 10` seen,
`$09F4`/service screen seen. Add the latches and `bangs` to
`pair.step()`'s comparison.

---

## Minor

### m1. The sub stack reaches `$1D70` at PARSEC 31, below `STACKS.sub.low` = `$1D74`: false lockstep diffs

*Where:* `src/machine/machine.js:125-129` (STACKS); `src/game/timing.js:59`
(the same range, hard-coded).
*Evidence* (`p11.mjs 700 41 6000 30`): first diff at frame 1620,
`$1D70-$1D72 oracle=$C0,$08,$01 port=0`, then 4,380 frames differ.
The bytes are an IRQ frame stacked 4 bytes deeper than measured.
Excluding `$1D60-$1D7F` (`p31.mjs`): **0 differing frames**. On a bare
board the lowest non-zero byte below `$1D74` is `$1D70`.
*Fix:* lower `sub.low`, or better, have the oracle track `stackLow` per
CPU (`board.js:224` already can) and exempt `[stackLow, top)` as
measured on the run itself. Derive `timed()` from STACKS instead of
repeating the literal.

### m2. `watchIo` assumes every I/O access uses extended addressing (+4 cycles); the ROM also uses indexed accesses

*Where:* `src/game/scheduler.js:211-212, 867-877, 899`. The comment says
"every access to the chips is extended addressing". The listing says
otherwise: `$B90A LDU #$6800 / $B910 LDA ,U+` (service mode),
`$BDAB`, `$B7FA`/`$E067` (`LDU #$6808`), `$CF5A`/`$CF61` (stick reads
in play) and `$D171`/`$D178` (fire reads in play). Indexed accesses make
their data access on a different cycle than +4.
The error only matters within about one cycle of vblank + 76.8 with the
IRQ off (boot, service mode). Lockstep of the service mode passes, so
no divergence is shown. But the comment is wrong, and the mechanism is
not exact.
*Fix:* let the ported access state its data cycle (e.g.
`ld(m, c, addr, cycles, dataCycle)`), or correct the comment and
document the bound.

### m3. The port reports the 62XX bang 5-6 cycles earlier than the ROM engine

*Where:* `src/game/port.js:81-84` and `scheduler.js:1072-1074`
(`frameCycle()` returns the start of the instruction).
*Evidence* (`latches.mjs`): frame 234, bang at cycle 10249 on the board
and 10244 on the port. Frame 236: 5001 against 4996. Frame 2558: 11145
against 11139. Frame 3152: 11875 against 11869. That is less than one
48 kHz sample (32 cycles), so nobody can hear it, but the two engines
disagree.
*Fix:* add the STA's data cycle (+4) in `Port`'s `onBang`.

### m4. `JsAgent.describe()` prints "undefined" for a CPU in a poll loop; a stale error text

`scheduler.js:446`: `['run', 'frame', 'spin', 'idle'][this.wait]` has
no entry for `POLL` (= 4). `scheduler.js:561-562`: "a poll loop that
yields BUSY but not SPIN?". BUSY now counts as SYNC, and poll loops
yield `pollAgain`.

### m5. `start()` and `powerOn()` leave some agent state behind

`JsAgent.start` (`scheduler.js:410-429`) does not clear `hung`,
`fgPoll`, `hPoll`, `period` or `bounds`, and `Scheduler.powerOn`
(`:800-821`) does not clear `cutAt`. Nothing breaks today
(`poweron.mjs`: power-on after 1,537 or 1,800 frames of play, then
3,000 frames against a fresh board, 0 diffs). But after a watchdog
reset or F2, `hung` still names the old hang in `describe`/tools.

### m6. Service-mode code hard-codes the scheduler's slice grid and other CPUs' timings

`src/game/main/gp2_4_svc.js:80-103, 441-468`: `HANDSHAKE.WRITE_SOUND`
= 147,496 and `WRITE_SUB` = 319,552 (measured on the oracle), plus
`sliceEnd()` with `SLICE = 256` and a cut at 76.8. The ported code
works out the race itself instead of letting the scheduler run it.
`new Port({ quantum })` with anything other than 256 (the option
exists, `port.js:62`) would silently change the service-mode
handshake. So would a frame with no pending I/O run, which has no 76.8
cut.
*Fix:* take the quantum from the scheduler, or poll with `pollAgain`
like the other handshakes. At the least, throw when
`quantum !== 256`.

### m7. `chips.js` still tolerates missing modules, and misnames one

All chips are ported. A missing or broken chip now only shows up as
"port not ready" in the browser. `isMissingModule`
(`src/game/chips.js:15-24`) also treats a chip whose own import is
missing (the same `ERR_MODULE_NOT_FOUND`) as "missing" instead of
"broken".
*Fix:* compare the missing specifier with the chip's own URL, or drop
the tolerance now that porting is done. Keep a unit test that
`portStatus().ready` is true.

### m8. The watchdog is approximate on both sides, and its test is weak

Both `Scheduler.watchdogFired` and `Board.watchdogFired` call
themselves approximate. `test/unit/scheduler.test.mjs:255-269` only
checks that the watchdog fired once within 200 frames. It does not
check the exact tick (3 s = 181.8 frames after the last kick). No
lockstep ever sees a reset.
*Fix:* pin the firing frame and cycle. Add a lockstep that stops the
kicks (e.g. poke a hang) on both sides.

### m9. `call()` / `isGenerator()` still detect generators by duck typing (phase 1 m6)

`src/game/call.js:20-40`: unchanged since phase 1. A routine that
returns any iterator is consumed with `yield*`.
*Fix:* `Object.prototype.toString.call(r) === '[object Generator]'`.

### m10. A test library named `*.test.mjs`

`test/oracle/main-gp2_4-lib.test.mjs` defines no tests. `node --test`
still runs it as a test file, and on import it builds two oracle boards
(`board`, `scratch`). Two `import`s come after code (lines 25-26).
*Fix:* rename it `main-gp2_4.lib.mjs` (as `main-gp2_3b.util.mjs` does)
and move the imports to the top.

### m11. Scenario helpers are copied between the coverage tool and the test

`playGame` and `roundAdvance` exist twice (`tools/coverage.mjs:99-113`
and `lockstep-scenarios.test.mjs:30-56`), and the M2 bug is in both
copies.
*Fix:* move them into `test/helpers/scenarios.mjs` and use it from both.

### m12. Situations that match but are not tested

`dips.mjs` ran in lockstep with 0 differing frames each: bonus 1-6
(1P and 2P), difficulty 1/3/5/6, lives 2/4, coinage 0/2/3, and upright
(non-cocktail) 2P games alternating `cur_player` 0/1. None of these is
a test.
*Fix:* add a table-driven lockstep test with one short (3,000-frame)
game per DIP value. It takes about 6 s each, or run them in parallel.
Let the new AI (`src/ai/`) drive one long lockstep. Random input dies
in stage 1-2, so later stages and the 14 path streams never stepped in
play are only reached with Round Advance.

---

## Style / project rules

### s1. `node --test` output over 79 columns: 58 lines (19 in phase 1)

Worst: 110 columns ("ROM reads of the paths match the format: PARSEC 3
(challenging sta..."), then 99, 98, 98 (service-mode error paths), 94
(chooser), 91 (`wsg15xx`). Keep titles under about 60 characters.

### s2. `any`

`test/oracle/main-gp2_2b_bonus.test.mjs:84`: `/** @type {any} */ (rom)`.
Nothing in `src/` (the phase-1 `gamepad.js` finding is fixed).

### s3. Source lines over 79 columns in the reviewed files

`src/main.js` 28, `src/engine.js` 22, `src/game/m6809ops.js` 12,
`src/game/scheduler.js` 8 (two of them are mid-sentence reflow damage:
`:33` "(both decide the slice grid, hence the races). (2) Otherwise..."
and `:102` "...The watchdog (3 s after the last kick) soft-"),
`gp2_1.js` 2, and one each in `call.js`, `gp2_8_util.js`,
`main/routines.js`, `gp2_2b_tasks.js` and `gp2_2b_bonus.js`.

### s4. Dead code in the shipped scheduler

The marker cost table (`CostTable`, `JsAgent.cost`'s marker branch,
`fgMark`/`hMark`, `costs` options in `Port` and `Scheduler`) has no
users: 0 numeric `yield`s in `src/game`. `ioAtVblank` has no users.
`taskAddresses` is used only by its own unit test. That is about 70
lines of `scheduler.js` (1,075 lines) that never run. Move them to
`tools/` or delete them.

### s5. Stale comments

* `src/engine.js:342`: "the AI itself is still to be built".
* `src/game/main/gp2_2b_bonus.js:11`: "`yield SPIN` per failed pass"
  (the code yields `pollAgain(4, 3, 2, 3)` at `:539`).
* `docs/modules/integration.md` "Open" still lists the `costs` table
  as "supported but not shipped".

### s6. Oversized files

`gp2_3b_hit.js` 1,247 lines, `romdata.js` 1,217+, `gp2_3b_attract.js`
1,153, `gp2_8_formation.js` 1,109, `scheduler.js` 1,075 (JsAgent and
Scheduler could each have a file), `main.js` 713 (Game, input wiring,
layout and `?frames` in one file).

### s7. `Game.manualZoom` is not declared in the constructor

`src/main.js:426, 671, 680` assign it on the fly. Declare it with JSDoc
next to `zoom`.

### s8. `romHelp` says `python3.11 -m http.server`

`src/engine.js:442`; `package.json` `serve` uses `python3`.

---

## Verified correct (no action)

* **Determinism across power-on:** `Port.powerOn()` after 1,537 or
  1,800 frames of play, then 3,000 frames against a fresh board: 0
  diffs. Module state (`clock.js`, `jump.js`) is reset or
  re-established by `mainForeground`.
* **Latches over 6,000 frames** of attract plus a played game (seed 1):
  `starCtrl`, `irqMask`, `sreset` and `io.getState()` are equal every
  frame. There were no watchdog resets on either side.
* **Speed:** the port runs at 0.61 ms per frame (worst 1.8 ms) and the
  ROM on the emulated board at 0.48 ms per frame. Both are far under the
  16.5 ms frame budget. The heap stays around 33 MB.
* **Import map / cache busting** (`index.html:222-348`): the
  `import.meta.url`-relative `emu/board.js` URL and the chip modules'
  dynamic imports go through the map, and `index-html.test.mjs` keeps
  the list in step with the disk.
* **Copyright header:** present on every `.js`/`.mjs` in `src/`,
  `test/` and `tools/`.
* **Scenario input handling** (`lockstep-scenarios.test.mjs:65-84`):
  taps are applied once (`applyInputs` deletes them and `inputScript`
  is nulled around `pair.step()`), and the port gets the same switches
  through `copyInputs`.

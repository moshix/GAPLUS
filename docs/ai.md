# The self-playing AI

Copyright 2026 by Moshix

`src/ai/` is a *controller*, not a cheat. It reads the game's state from
RAM, but its only outputs are the switches a human has: the 8-way stick
and fire (plus coin and start, to begin a game when none is running). It
cannot move the fighter faster than `task_move_player` does, cannot fire
faster than `task_player_fire` allows (a fresh press and a free shot
slot), and dies to exactly the same hit box. Press `A`.

It exists **only for the JavaScript port**. On the ROM engine the control
is disabled, the key does nothing, and the hook hands the page's own
inputs to the board untouched (`src/ai/hook.js aiAllowed`; tested in
`test/unit/ai-hook.test.mjs` and the browser smoke test).

    src/ai/autoplay.js   arbitration: stick, fire, coin/start, latency
    src/ai/world.js      the only file that reads the machine: RAM -> world
    src/ai/predict.js    motion forwards: threats' tracks, the fighter's steps
    src/ai/evade.js      the plan search: survive, keep clear, stand well
    src/ai/aim.js        where to stand to shoot, and whether a shot hits
    src/ai/constants.js  addresses, hit boxes, speeds -- each traced to ROM
    src/ai/hook.js       the page's per-frame hook (port engine only)
    tools/ai-bench.mjs   play N games headlessly and report how it did

The AI needs only `peek(addr)` and `setInput(name, down)`. It is never
given a way to write memory; a unit test runs it on the port and checks
every byte of RAM is unchanged by each of its steps, and another checks
that no file under `src/ai/` contains a memory write.

## How it is wired in

`src/main.js` calls one hook before every frame
(`autoplayInputs(engine, ai, pageInputs, aiInputs)`). While the AI is on
and the engine is the port, the hook copies the page's input state (DIPs,
service switch, player 2) into the AI's own `InputState`, lets the AI open
every switch it owns and close the ones it wants, and the frame runs on
that state -- the same path a human's switches take through the 56XX.
Otherwise the frame runs on the page's inputs and the AI never runs.
`src/engine.js` and `src/game/**` are untouched.

Like Galaga's AI, it inserts a coin and presses start whenever no game is
running, so turning it on in attract mode starts a game. It presses start
only after a coin of its own: before attract mode begins, the boot also
has attract_flag, game_mode and main_task at 0, and start presses there
delayed the game by some 900 frames. At game over it does nothing during
the name entry, which times out, and then coins up again.

## How it plays

* **Only modes 3 and 5 can kill.** `task_player_hit_check` ($D915) is in
  the task lists of game modes 3 and 5 only (table entries $FF36, $FF7C).
  It kills the fighter when any in-use sprite entry of $0ECE-$0F12 (enemy
  shots and the main CPU's objects) or $0E30-$0E86 (formation members out
  flying) is within h - H in [-6, +6) and v/2 - V/2 in [-3, +3). In a
  challenging stage (mode 7) nothing can hit the fighter, so it only
  hunts.
* **Threats are measured, except enemy shots.** Divers and objects are
  flown by the sub CPU along paths the AI does not replay, so their motion
  is measured: velocity over the last 4 frames, and the turn rate between
  that and the 4 before. They are flown on at that speed, turning at that
  rate for up to 12 frames, then straight. On recorded games this halves
  the median error of a straight-line guess (3.6 px at 8 frames, 7.4 at
  12), but the tail is long (the 90th percentile is 14 px at 8 frames,
  28 at 12: a diver's path is a string of arcs), so every track carries a
  margin that grows with time. Enemy shots are exact: their sideways
  speed is in RAM ($1B60+2j, signed magnitude with a fraction byte) and
  they fall 2 and 3 pixels on alternate frames (sub $FA2E).
* **Danger is a span of frames.** Every frame, 369 stick plans -- push d1
  for k frames, then d2, for 9 x 9 directions and k in 1, 3, 6, 10, 16 --
  are walked 30 frames ahead through the fighter's real step logic
  (2 px sideways, 1 up/down, the limits and the low-byte compare of
  $CF4F) against every threat that could come within reach. A plan is
  scored by two times: when a threat's box widened by its whole margin
  covers the fighter ("possible"), and when its box widened by a third of
  it does ("sure"). A frame of life outweighs anything else; then passing
  wide of threats; then where the plan spends its time (under targets,
  near the home row, off the walls, sampled every frame); then
  commitment.
* **Commitment, not flicker.** Four rules, each measured:
  - *Switching costs.* Every change of stick direction in a plan costs a
    little (4 from a move, 3 from a standstill); turning an axis round
    costs 20 more within 12 frames of the last change (a third of that
    later), so diagonal-to-straight beats a hard reversal; starting a
    vertical move costs 3. Both changes of a plan (stick to d1, d1 to d2)
    are charged -- charging only the first made "wait a frame, then go"
    always cheaper than "go", and the fighter waited for ever. All are
    far below a frame of survival (120).
  - *Minimum hold.* A direction, or a standstill, is kept for 8 frames
    whatever the search prefers, unless holding it runs into a threat
    within 20 frames (`Planner.survives`); then the search's choice goes
    out at once. The fighter moves in strokes.
  - *Dead zones.* The aim peak is flat within 2 px of a target's column
    (normal play), and the home row is flat within 8 px: no twitching
    over a pixel or two, no tiny vertical corrections.
  - *Challenging stages* keep 30% of the costs and no hold: nothing can
    hit there, and full commitment cost a third of the hits.
  Direction changes fell from 10.3 a second (no commitment) to 6.5
  (switching costs) to 3.6 (all four), reversals from 9.7 to 1.8 to
  0.9, and fewer ships were lost at each step, not more.
* **Not on the bottom row.** From PARSEC 4 on, divers sweep along the
  bottom row at 4 px a frame; a fighter there climbs out of their way at
  1 px a frame and is trapped, the more so in a corner. The home row is
  17 px above the bottom. This, with the two-time scoring above, took
  the benchmark from a mean of 59 parsecs to over 170.
* **Fire only at something.** A shot appears where the fighter is on the
  press frame and climbs 6 px a frame, tested each frame against the
  targets' predicted positions with the game's own shot box
  (`task_shot_hits`: h within [$1100 - $1101, $1100) plus the captured
  fighters' offsets, v within 10, same side of v = $100). Only 2 shots can
  fly, and a miss ties one up for up to 44 frames, so a shot is fired when
  it will hit -- or, with both slots free, when it will nearly hit.
  Formation members are targets at their home position ($1B00+2k),
  flying ones at their sprite entry, objects too.
* **The aim map** values each column by the targets that will be there
  when the fighter has walked under them and a shot has climbed to them,
  with a broad low hill under the peaks so there is a slope from afar.
* **Challenging stages.** Each pattern flies through a different part of
  the screen; the fighter rests on whichever of five rows has the most to
  shoot at, discounted by the time to get there.
* **The latency is measured.** Which of the directions sent 0, 1 or 2
  frames ago explains the fighter's last move? On the port it is 0 (the
  stick is sampled in the frame it is set); the AI adapts if the host
  changes that.

Gaplus has no random number generator -- its "randomness" is the frame
counter (cleared at every stage start), the stage and a score digit -- so
a deterministic player replays the same game every time. The AI is
deterministic; `new AutoPlayer(machine, { seed })` adds seeded tie-breaks
(under a pixel's worth of plan score) so the benchmark plays different
games, and run n is always the same game.

## RAM it reads

Main-CPU addresses. Sprite shadow entry i: code $0E00+2i, h $1600+2i,
v low byte $1601+2i, flags $1E00+2i / $1E01+2i (bit 7 in use, bit 0 v
bit 8). The monitor is rotated: the listing's "player_y" $1600 is the
horizontal position h, "player_x" $1601 the vertical v (down is +).

| address | name | used for |
|---|---|---|
| $09F4 | attract_flag | 1: attract mode, insert a coin |
| $102F / $1030 | game_mode / main_task | 0/0 with no attract: press start; modes 3, 5 kill; 7 challenging |
| $1016 | frame_counter | (diagnostics) |
| $1104 / $1106 | lives_p1 / stage_p1 | ships left, stage (benchmark) |
| $09B0-$09B2 | score_p1 | BCD in hundreds (benchmark) |
| $1600 / $1601 / $1E01 | player h / v / v bit 8 and in use | the fighter |
| $10D9 / $1111 / $10E9 | player_frozen / v lock / fire lock | set by the capture sequence |
| $110F / $10FE | player_exploding / player_dying | the fighter is being lost |
| $101A | hit check off | no danger while set |
| $10D1 / $1032 | player_step / player_speed | px per frame sideways / vertically |
| $1078 / $1079 | player_xmin / player_xmax | horizontal limits |
| $10D2 / $10D3 | shot_speed / shot_slots_end | shots: speed, number of slots |
| $1019 | fire_held | 0: the next press fires |
| $1EA3, $1EA5, $1EA7 | shot slots' in-use flags | free slots |
| $1100 / $1101 / $10DD / $10DE | shot box and fighter offsets | the shot hit box |
| $1860 + k | formation_flags | b0 empty, b1 out flying |
| $1B00 + 2k | formation home positions | targets at home |
| $1630 + 2k (entry $18 + k) | flying formation members | threats and targets |
| $0ECE-$0EDA (entries $67-$6D) | enemy shots | threats |
| $1B60 + 2j | enemy shot sideways speed | exact shot tracks |
| $0EE2-$0F12 (entries $71-$89) | the main CPU's objects | threats and targets |
| $1162 | results_hits_left | challenging-stage hits (benchmark scripts) |

## How well it plays

`node tools/ai-bench.mjs` plays complete games headlessly on the port
(`new Port()` from `src/game/port.js`, as `src/engine.js` builds it), with
run n using seed n + 1. Numbers below: 12 games, capped at 400,000 frames
(110 minutes of play) each.

| 12 games | first version | + turn model, margins | final |
|---|---:|---:|---:|
| games reaching the 400,000-frame cap | 0 | 2 | **12** |
| PARSEC reached, mean (worst) | 45 (4) | 59 (4) | **168 (145)** |
| ships lost per parsec | 0.15 | 0.12 | **0.042** |
| ships lost per 100,000 frames | 6.37 | 4.95 | **1.75** |
| score, mean | 345,442 | 467,517 | **1,330,000** |

The final column is the current AI except that its challenging-stage
commitment was cut afterwards (mode 7 cannot kill, so survival is
unaffected). All 12 of its games were still going when the benchmark
stopped them; 84 ships were lost in 2,010 parsecs: 45 to divers, 23 to
enemy shots, 15 to something that had already vanished from the sprite
table on the frame of the hit (almost certainly a diver), 1 to an object.
Before the commitment costs, the same AI changed direction 10.3 times a
second and reversed 9.7 times; with the switching costs 6.5 and 1.8.

Since then the minimum hold and the dead zones were added. The port
now fails beyond about PARSEC 18 (below), so they were measured on 12
games capped at 38,000 frames:

| 12 games, 38,000 frames | switching costs | + hold, dead zones |
|---|---:|---:|
| direction changes / s | 5.9 (30k cap) | **3.6** |
| reversals / s | 1.2 (30k cap) | **0.9** |
| ships lost per parsec | 0.026 | **0.017** |
| PARSEC reached, mean | 13.0 (30k cap) | **14.8** |

The price is in challenging stages: 26 hits a stage instead of 34.
Letting them keep 12% of the costs instead of 30% wins the hits back
(32) but brings the jitter back to 4.3 changes and 1.3 reversals a
second over a whole game (`CHALLENGE_COMMIT` in `evade.js`).

Per challenging stage (PARSECs 3, 8, 13, 18; 10 seeds, 40 stages) it
scores 26 hits on average (34 before the minimum hold and the higher
costs), by the game's own counter ($1162).

It costs about 0.3 ms of the 16.5 ms frame. The same AI driven through
the page's own hook in headless Chrome (20,000 frames) played the same
way: no ship lost, PARSEC 7, input latency measured as 0.

**The port currently throws in long games.** A re-run of the final AI
on the port as of 2026-09-23 19:10 stopped 11 of 12 games early with
`sub ROM $xxxx is code, not data` (the new code/data mask in
`src/game/romdata.js`; e.g. frame 46,520 of run 5, PARSEC 20, from
`rd16` in `src/game/sub/gp2_6_state.js` reading $F0ED; others at
$F0EF-$F12B and $BEE5, the latter from `sub_BD56` in a challenging
stage). Up to those frames the AI had lost 0-7 ships in 20-147 parsecs.
`tools/ai-bench.mjs` reports such a failure as `run n: frame f: error`.

### Tried and dropped

* **Straight-line or constant-acceleration diver tracks.** Measured
  against recorded games, both are about twice as far off as the turning
  model beyond 8 frames.
* **Resting on the bottom row** (the first version): 7 games in 12 lost a
  ship at PARSEC 4, one lost all three.
* **A fixed row in challenging stages.** The top row scored 0 in PARSEC 3
  (its enemies sweep low), the bottom row fewer in PARSEC 13.
* **Looser firing in challenging stages** (near misses with one slot
  free) and a tighter aim: no better than noise.
* **A broad aim hill in normal play** (a gentle slope towards far
  targets): it lured the fighter across the screen, and the mean parsec
  of the 12-game benchmark fell from 171 to 141. It is kept for
  challenging stages only.
* **Stronger commitment** (switch 5, start 4): 3.2 changes a second, but
  slower progress and more ships lost. **A flat-topped aim peak** (a
  dead zone of +-3 px) made the stop-and-go faster, not slower.
* **Rollouts on the real game.** Simulating the port itself a few dozen
  frames ahead under candidate stick sequences would make every track
  exact. It cannot be done from outside the port today: the three CPUs'
  ported code runs as suspended JavaScript generators, which cannot be
  copied, and the scheduler has no getState/setState (only Machine and
  the I/O chips do). A second port fed the same inputs stays in step
  but can only go forward. It needs the scheduler to snapshot its
  CPUs (e.g. only at frame boundaries, where each CPU waits at a known
  point), which is work in `src/game/`, not in the AI.

### Open questions

* Divers are the main cause of lost ships. Replaying the sub CPU's path
  stepper (`sub_B0D4`, the heading streams of gp2-7, docs/modules/sub-C.md)
  on a private copy of each diver's slot, as Galaga's AI does, would make
  their tracks exact without rollouts of the whole game.
* The Phalanx capture and the power-ups are not sought out; the AI just
  shoots whatever is worth shooting.
* All numbers are for player 1 on an upright cabinet.

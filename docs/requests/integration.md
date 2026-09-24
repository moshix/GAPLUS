# Requests from integration (scheduler, port, sound CPU, lockstep)

Copyright 2026 by Moshix

**Round 3: items 1-3 are superseded.** The port now matches the ROM on
every frame (20,000 frames of attract and of three played games, plus
the scenario sessions); see docs/modules/integration.md for the changes
made to the scheduler and, under the timing contract (porting-guide
section 6.4), to the chip modules. Open: main gp2-4's high-score code
should charge its cycles like the rest (not raced today). Round 2 text
follows for the record.

Measured with `node tools/lockstep-run.mjs` and
`test/oracle/lockstep.test.mjs`. What is exact today: every CPU emulated
by the port's scheduler = the oracle (3,000 frames, a played game); the
ported sound CPU with main and sub emulated = the oracle (4,000 frames,
a played game); the full port = the oracle for frames 0-232 (power-on,
boot, handshakes). Everything after that is main/sub timing, below.

## 1. Dispatchers: yield SYNC before every task (main-E, sub-E)

`task_dispatch` ($FEB5, gp2_2b_tasks.js) and `task_dispatch_sub` ($E0EC,
gp2_6.js) run all of a frame's tasks as ONE atomic chunk, so every write
of the main CPU's tasks lands before (or after) all of the sub's, at the
chunk's start time. On the board they interleave (the $0849 -> $6049
sound flag, $111B, the $D434 position copy are such races). One line
each, before the `yield* call(...)` of the task:

```js
yield SYNC; // Symbol.for('gaplus.sync'): let the other CPU catch up
```

Measured with that change (scratch experiment, 12,000 frames, coin,
start, seeded play, resync after 3): differing frames 9,365 -> 1,678,
runs longer than 5 frames 88 -> 17, longest 5,346 -> 480. Your routine
tests will see one more yield per task.

## 2. Charge the 6809's cycles everywhere (sub-A, sub-E, main-E)

A chunk costs what it charges (`m.charge`, `m.sub.charge`); uncharged
code takes no time, so its writes happen too early. main-C (gp2-3b) and
the sound CPU charge every instruction and are exact; the sub CPU
charges nothing, main-E only through the boot clock. Examples:

* `irq_sub` writes `frame_sync $10AF = $11` at cycle 4 (ROM: 5,023),
  so the main handler passes the rendezvous early and `attract_timer
  $1029` gets an extra pass at frame 252. Please charge the sprite copy
  and `yield SYNC` right before the store at $E0E0.
* The sub's tasks all run at the handler's end (4,633) instead of from
  ~5,500 on; the main's reach $D8B0 at ~6,840 instead of ~10,500.

Check the counts like test/oracle/sound-gp2_1.test.mjs does: callRoutine
returns the ROM's `cycles`; compare with the port's charged total, and
the charged time at each SYNC with the cycle the ROM starts that
instruction.

## 3. Long charged stretches must SYNC at frame boundaries (main-C)

`game_init` ($C296) clears the tilemap and draws the header in one chunk
of 35,567 charged cycles starting at frame 233, cycle 0: the header is
written in frame 233 (port) instead of frame 234, cycle ~8,603 (ROM).
A `yield SYNC` before the header loops (or `busy()` every few hundred
cycles) puts the writes in the right frame. Rule: in foreground code
that charges more than what is left of the frame, yield before writes.

## 4. romdata mask: code read as data (lead)

`reset_sound` checksums all of $E000-$FFFF (`ADDA ,X+` at $E013); when
the code/data mask is switched on, whitelist it with main-A's and sub-A's
ranges (docs/requests/main-A.md 1, sub-A.md 1).

## 5. Porting guide, section 6 (lead)

The yield vocabulary is now (src/game/scheduler.js header): plain
`yield` = next frame / CWAI; `SPIN` / `RENDEZVOUS` = poll another CPU,
re-polled once per slice; `BUSY` = after `m.charge` a timing point,
without a charge a poll; `SYNC` = timing point after charging; a number
= progress marker; `idle(p)` = `BRA *` forever; a handler returns
`NO_RTI` when it left through a jump. The I/O chips run at vblank + 76.8
cycles, delivered before the first main access past that instant (main-A
request 2, done), not "right after vblank" as section 6.1 says. The main
foreground clock is src/game/clock.js (burn() now also charges); jumps
are src/game/main/jump.js.

## 6. Done (from other requests)

* main-E 1 and 3: src/game/clock.js and src/game/main/jump.js, with
  re-exports kept in gp2_2b_state.js / gp2_3b_state.js.
* main-E 2, sub-E 2: `SPIN`, `BUSY`, `RENDEZVOUS` are the registered
  symbols.
* sub-C 2, sub-E 3: sub/index.js loads gp2_6/7/8 and exports reset_sub /
  irq_sub.
* main-C 1: an IRQ exit through a jump leaves CC.I set (NO_RTI, from
  main/index.js `mainIrq`). main-C 2: burn() charges.
* main-A 2: lazy I/O run. main-A 3: the sound thread yields SYNC before
  each store of its $0000-$02FF clear that reaches $0040-$007F, so the
  main polls the $22 before the clear, at the exact cycle.

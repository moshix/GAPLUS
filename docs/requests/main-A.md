# Requests from main-A (main CPU gp2-4.8d, $A000-$BFFF)

Copyright 2026 by Moshix

## 1. romdata.js / tools/gen-listing.mjs: code read as data (lead)

When the code/data mask of `romdata.js` is switched on, these reads of
**code** bytes must stay allowed (whitelist them with a comment):

| reader | reads | why |
|--------|-------|-----|
| `$B743` / `$B758` (service RAM test, `LDX -$2000,U`) | main **$E000-$FFFF** | pattern source for $0000-$1FFF |
| `$B7AC` / `$B7C1` (`LDX $7FC0,U`) | main **$E000-$E3BF** | pattern source for $6040-$63FF |
| `$B865` / `$B878` / `$B88B` (`ADDA ,U+`) | main **$A000-$FFFF** | ROM checksums |

The port reads them with `m.read16` / `m.read` (src/game/main/
gp2_4_svc.js `ramTest`, `serviceOn`).

## 2. Scheduler: I/O run timing in busy polls (integration)

The service loop ($BD7B) polls the 56XX with the main IRQ off. On the
oracle the chips' run lands at vblank + 76.8 cycles (delivered before the
first main access to $6800-$681F in cycle 76 or later); the port's
scheduler runs `m.ioUpdate()` at the start of the frame. Then the port
reacts to an input one service-loop pass (~3,200 cycles) early -- the
same frame, so RAM per frame still matches (tested), but not the cycle.
If the scheduler wants it exact, it can defer `ioUpdate()` while the main
foreground runs until the first main I/O access with `clockOf(m).t + 4
>= 76` (test/oracle/main-gp2_4-svc.test.mjs does exactly this, `lazyIo`,
and gets every main write at the oracle's cycle).

## 3. Handshakes after the service mode's release (integration)

After `STA $8400` at $B8B5 the service mode polls `$6040` and `$0800`
for the sound and sub CPUs' `$22`. It advances its clock to the poll at
which the oracle sees the value (`HANDSHAKE` in gp2_4_svc.js: the other
CPU's store at T0 + 147,496 / 319,552 cycles, visible from the next
MAME slice boundary, vblank + 76.8 + 256k), then `yield SPIN`
(`Symbol.for('gaplus.SPIN')`, clock.js) until the port's sub/sound
thread has written it. Note that reset_sound clears `$0000-$02FF`
(main $6040 included) ~700 cycles after its `$22`: the sound foreground
must not run past that clear before the main thread has polled, or the
main thread spins forever. Suggest the scheduler resumes a SPINning main
thread right after the other thread's `$22` write (e.g. the sound thread
yields SPIN after writing it).

## 4. Nothing needed from other porters

gp2-4 calls `sound_all_off` ($DF19), `clear_sprite_shadows` ($DF5D)
(gp2-2b) and tail-calls `$DBE2` / `$DC0B` (gp2-3b, registered by
main-C) through `mainAt`; all exist. `JMP reset_main` ($BDA8) uses
`requestJump` (src/game/main/jump.js). `delay_65536` burns on the shared
clock as main-E asked (docs/requests/main-E.md 1).

## 5. Proposed names

`reference/annotations/proposed/main-A.json`: labels in the high-score
and service code, three RAM names ($09A0, $116C, $116D), and two doc
corrections (service_loop's cross hatch needs a second press of the
service coin; the RAM test runs 15 passes, not 16).

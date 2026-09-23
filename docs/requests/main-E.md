# Requests from main-E (main CPU gp2-2b.8b, $E000-$FFFF)

Copyright 2026 by Moshix

## 1. A shared foreground cycle clock (lead; main-A)

The boot burns real time with the main IRQ off, and the lock-step needs
every boot write in the right frame. `src/game/main/gp2_2b_state.js`
has a per-machine cycle clock (`clockOf`, `setClock`, `burn`): `burn(m,
n)` adds n main-CPU cycles and yields once per frame boundary passed
(25,344 cycles; an instruction belongs to the frame it starts in).

* **Lead:** please move `FRAME_CYCLES`, `clockOf`, `setClock`, `burn`
  (and `SPIN`, below) to a shared file, e.g. `src/game/clock.js`, so
  every busy foreground routine of the main CPU uses the same clock.
  Until then `gp2_2b.js` registers `MAIN.fg_burn = burn` as a bridge.
* **main-A, delay_65536 ($BE25):** it is called seven times by the boot
  and needs this contract to keep the boot frame-exact:

  ```js
  export function* delay_65536(m) {
    // $BE2A: ldy $7C00 ... -- 65,536 passes, two watchdog reads each
    for (let i = 0; i < 65536; i += 1) m.peek16(0x7c00);
    // PSHS 7 + LDD 3 + 65536 x 12 + 256 x 5 + PULS 7 + RTS 5
    yield* MAIN.fg_burn(m, 787734); // DELAY_65536_CYCLES
  }
  ```

  (the caller charges its own JSR/LBSR; D is preserved, nothing else
  changes). The tests in `test/oracle/main-gp2_2b.test.mjs` stub it this
  way and match the oracle frame by frame from power-on to game_init.

## 2. SPIN (integration)

The handshake polls ($E0D2 `$6040`, $E0DD `$0800`) yield
`Symbol.for('gaplus.SPIN')` (exported as `SPIN` from gp2_2b_state.js).
Please make `scheduler.js`'s `SPIN` that same registered symbol (or
re-export ours) so a spin is recognised.

## 3. Non-local jump state (lead; main-C)

`task_dispatch` must stop as soon as a task has requested a non-local
jump (gp2-3b's `requestJump`), or it would run the next task first. It
imports `pendingJump` directly from `./gp2_3b_state.js` (state, not a
routine). Please move `requestJump`/`takeJump`/`pendingJump` to a shared
file (e.g. `src/game/main/jump.js`) and I will switch the import.

## 4. MAIN_AT entries other chips must register (main-C, main-A)

Jumps from $E000-$FFFF into the middle of other chips' code, looked up
with `mainAt()`:

| from | to | owner |
|------|----|-------|
| $E3F8 `lbne lD029` (demo end in task_results) | `$D029` | main-C |
| $F8D2 `jmp lD9CF` (sub_F824, life lost) | `$D9CF` | main-C |
| $FC7D / $FC9F `lbne/lbeq lDA87` (sub_FC33) | `$DA87` | main-C |

Plain calls through `MAIN` (must never yield): `add_score`,
`bcd_hi_to_char`, `bcd_lo_to_char` (main-C, return `{ a }`),
`delay_65536` (main-A, generator, see 1), `service_mode`, `game_init`
(tail calls from the boot, generators allowed).

## 5. index.html (lead)

`test/unit` "index.html MODULES lists exactly the modules on disk"
fails because new modules exist (gp2_2b*.js among them): please run
`node tools/gen-index.mjs` when merging.

## 6. Proposed names

`reference/annotations/proposed/main-E.json`: 38 routine labels and 32
RAM names worked out while porting $E000-$FFFF.

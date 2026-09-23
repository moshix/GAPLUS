# Porting phase — coordination rules for parallel porters

Copyright 2026 by Moshix

Several agents port the ROM at the same time, one per ROM chip, plus one
integration agent. Read, in order: `docs/PLAN.md` (owner's rules),
`docs/porting-guide.md` (the contract), `docs/oracle-notes.md` (the board,
timing, races), `docs/disassembly-notes.md`, `docs/hardware.md` (as needed),
and the listing for your CPU: `reference/gaplus-{main,sub,sound}.asm`
(bytes are truth; comments are a first pass and may be wrong).

## Ownership

| agent        | owns (create/edit freely)                                   |
|--------------|-------------------------------------------------------------|
| main-A       | `src/game/main/gp2_4*.js`, `test/oracle/main-gp2_4*.test.mjs` |
| main-C       | `src/game/main/gp2_3b*.js`, `test/oracle/main-gp2_3b*.test.mjs` |
| main-E       | `src/game/main/gp2_2b*.js`, `test/oracle/main-gp2_2b*.test.mjs` |
| sub-A        | `src/game/sub/gp2_8*.js`, `test/oracle/sub-gp2_8*.test.mjs` |
| sub-C        | `src/game/sub/gp2_7*.js`, `test/oracle/sub-gp2_7*.test.mjs` |
| sub-E        | `src/game/sub/gp2_6*.js`, `test/oracle/sub-gp2_6*.test.mjs` |
| integration  | `src/game/scheduler.js`, `src/game/{main,sub,sound}/index.js`, `src/game/sound/**`, `src/game/port.js`, the `port` engine in `src/engine.js`, `test/helpers/lockstep.mjs` (port side), `test/oracle/lockstep.test.mjs`, `test/oracle/sound-*.test.mjs`, `tools/lockstep-run.mjs` |

Everything else is shared and **read-only** during this phase
(`src/machine/**`, `src/game/{call,m6809ops,romdata}.js`, the
`routines.js` registries, `test/m6809/**`, `test/helpers/oracle.mjs`,
`reference/*.asm`, `reference/annotations/*.json`). If you need a change
there (a bug, a missing helper), put a precise request in
`docs/requests/<your-agent>.md` and work around it locally; the lead merges
requests between rounds. Helpers you need that aren't in m6809ops.js go in a
private file inside your own module (e.g. `gp2_4_util.js`).

## Naming and annotations

* Routine names: use the listing's label if it has one, else `sub_XXXX`.
  Don't rename listing labels. If you work out what an unnamed routine or
  RAM variable is, record it in `reference/annotations/proposed/<agent>.json`
  (same format as `reference/annotations/<cpu>.json`: labels, comments,
  ram) — the lead merges these into the listing later. Your JS may use the
  proposed name in JSDoc and comments, but the export name stays the
  listing's (so other modules can find it).
* Register every routine in `MAIN`/`MAIN_AT` (or `SUB`/`SUB_AT`) by
  side-effect import, as the guide says. Anything reachable through a jump
  table **must** be in `*_AT`.
* Call routines of other chips only through the registries. They may not
  exist yet — that's fine; your tests stub them by running the real ROM
  routine on a scratch board, or by pre-computing their effect with
  `callRoutine` (see Galaga's oracle tests for the pattern).

## Done means

* Every routine whose entry address is in your chip is ported (coverage
  file `reference/coverage/<cpu>.json` tells you what really runs; code
  never executed still gets ported but can be tested more lightly).
* Each routine has an oracle test that runs the ROM routine and the JS
  routine from the same seeded-random states covering its branches, and
  requires `diffRam` to be empty and the consumed output registers to
  match. Poll loops / generators: the number of yields equals the number of
  frames the ROM waits.
* `node --test test/oracle/<your files>` passes, and the full `node --test`
  isn't broken by you.
* A short `docs/modules/<agent>.md`: what's in the chip, routine list with
  one line each, quirks and ROM bugs reproduced on purpose, open questions.

Work in batches and keep your tests passing as you go, so partial progress
is usable if you run out of room. Report back with what's done, what's not,
and any request files you wrote.

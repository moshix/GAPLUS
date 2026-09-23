# Gaplus (Namco 1984) in JavaScript — project plan and contract

Copyright 2026 by Moshix

Every agent working on this project reads this file first.

## Goal

A routine-by-routine JavaScript port of Namco's **Gaplus (GP2 rev. B)**,
using the same method as the Galaga port in `../galaga` (read
`../galaga/README.md` and `../galaga/docs/porting-guide.md`):

* It is **not** an emulator. Each routine of the three 6809 programs is
  rewritten as a JS function that does the same thing to the same memory.
* Game state lives at the **original addresses** (`Machine.mem`), so a test
  can run the real ROM on an emulated board next to the port and require
  every byte of RAM to match, frame for frame.
* The emulated board (three MC6809 cores, shared RAM, custom I/O chips) lives
  under `test/` only and never ships to the browser. It is the *oracle*.
* Graphics, palette and sound waveforms are generated from the PROMs/ROMs by
  scripts in `tools/`, never typed in by hand.

## ROM set

MAME set `gaplus` — "Gaplus (GP2 rev. B)". Files are the loose chips in
`roms/` (the unpacked `gaplus.zip`; the zip itself is optional and only
used as a fallback if present). CRC32s:

| file        | size | crc32    | role                               |
|-------------|------|----------|------------------------------------|
| gp2-4.8d    | 8K   | e525d75d | main 6809 $A000-$BFFF              |
| gp2-3b.8c   | 8K   | d77840a4 | main 6809 $C000-$DFFF              |
| gp2-2b.8b   | 8K   | b3cb90db | main 6809 $E000-$FFFF              |
| gp2-8.11d   | 8K   | 42b9fd7c | sub 6809 $A000-$BFFF               |
| gp2-7.11c   | 8K   | 0621f7df | sub 6809 $C000-$DFFF               |
| gp2-6.11b   | 8K   | 75b18652 | sub 6809 $E000-$FFFF               |
| gp2-1.4b    | 8K   | ed8aa206 | sound 6809 $E000-$FFFF             |
| gp2-5.8s    | 8K   | f3d19987 | characters                         |
| gp2-9.11m   | 8K   | e6a9ae67 | sprites                            |
| gp2-11.11p  | 8K   | 57740ff9 | sprites                            |
| gp2-10.11n  | 8K   | 6cd8ce11 | sprites                            |
| gp2-12.11r  | 8K   | 7316a1f1 | sprites                            |
| gp2-3.1p    | 256  | a5091352 | red palette PROM                   |
| gp2-1.1n    | 256  | 8bc8022a | green palette PROM                 |
| gp2-2.2n    | 256  | 8dabc20b | blue palette PROM                  |
| gp2-7.6s    | 256  | 2faa3e09 | char color lookup                  |
| gp2-6.6p    | 512  | 6f99c2da | sprite color lookup (lo)           |
| gp2-5.6n    | 512  | c7d31657 | sprite color lookup (hi)           |
| gp2-4.3f    | 256  | 2d9fbdd8 | sound WSG waveforms                |
| pal10l8.8n  | 44   | 08e5b2fe | PAL (address decode, not needed)   |

(Roles above are provisional; `docs/hardware.md` is authoritative once
written.)

## Layout (mirrors ../galaga)

```
src/machine/   the board as the game code sees it: memory map, latches,
               56xx/58xx I/O chip behaviour
src/game/      main/ sub/ sound/ -- one module per ROM chip, plus the
               per-frame scheduler
src/video/     tilemap, sprites, starfield, palette (generated from PROMs)
src/audio/     WSG synthesis (+ samples if the board uses them)
src/input/     keyboard / gamepad mux and remapping dialog
test/m6809/    the MC6809 core and the three-CPU board running the real ROM
test/oracle/   routine-by-routine and lockstep comparisons against the ROM
test/unit/     unit tests
test/browser/  headless Chrome smoke test (CDP over WebSocket, no deps)
tools/         disassembler, listing generator, graphics/sound generators
reference/     MAME / FBNeo sources, web notes, generated listings
docs/          this plan, hardware.md, porting-guide.md, notes
```

## Rules for all code (from the owner — mandatory)

* First line of every source file: `// Copyright 2026 by Moshix`.
* Plain ES modules, **no npm dependencies**, no build step. Node >= 20.
  Headless Chrome is driven through the DevTools protocol using Node's
  built-in `WebSocket`, with `/Applications/Google Chrome.app`.
* **Explain complex logic with comments.** Quote the 6809 instruction when the
  JS is non-obvious (`// $E123: rora -- carry into bit 7`).
* No TypeScript `any` (including in JSDoc) without explicit permission.
* **Format only the lines you touch**, never reformat whole files.
* **Always test after making changes; write tests if they don't exist.**
  `node --test` must pass before a piece of work is reported done.
* Anything printed to a text console must stay within **79 columns**.
* Don't commit to git or publish anything; the owner does that.

# jrok.com "Gaplus Hi-Score Save" page (summary)

Source: https://www.jrok.com/sohs/gap_shs.html (fetched 2026-09-23; raw
HTML saved as `jrok-gaplus.html`). Linked download:
`https://www.jrok.com/sohs/roms/gap-hsav.zip` (modified program ROMs, not
fetched — not needed; our set is the unmodified MAME `gaplus`).

The page is a hardware-mod page, not a gameplay guide. It contains **no
scoring tables or stage structure**. Everything it does say:

## Facts useful for the port

* **High-score table persistence mod.** The mod replaces a RAM chip with a
  battery-backed DS1220AB (or M48Z02) 2K x 8 SRAM, so the high-score table
  lives in one of the board's 2 KB RAMs. On the Namco PCB the chip is at
  location **L10**. (The board has four 2 KB RAMs visible to the CPUs:
  tile RAM $0000-$07FF and work RAM $0800-$0FFF, $1000-$17FF,
  $1800-$1FFF — see `docs/hardware.md`. The page does not say which
  address range L10 decodes to.)
* **All three main-CPU ROMs are patched** by the mod (8D, 8C, 8B =
  `gp2-4.8d`, `gp2-3b.8c`, `gp2-2b.8b`), i.e. the high-score init /
  checksum logic lives in main CPU code spread over all three ROMs.
* **Default high scores are 10,000 points** in the original game (the mod
  lowers them to 5,000 and keeps the table across power-off).
* **Demo-mode quirk:** "if the default high-scores are set to zero, then
  the demo mode actually clocks up points" — i.e. the attract-mode demo
  play scores points into the live score and can enter the high-score
  table; Namco hid it by seeding the table at 10,000. Useful as a
  verification check: in attract mode the score counters are updated
  by the demo, and the port must reproduce that bit-exactly.
* Board: "quite a compact multi-layered board".
* Galaga 3 is described as "the Midway license of Gaplus" (MAME: galaga3*
  sets; Midway = "Version 1" PCB with different chip positions).

## Supplementary gameplay facts (other sources, for orientation only)

From Wikipedia (https://en.wikipedia.org/wiki/Gaplus), not authoritative
for behaviour — the ROM is:

* Levels are called "Parsecs".
* Challenging stages: the goal is to juggle enemies by hitting them as
  many times as possible; hits spell words, completed words give bonuses.
* Power-ups: tractor beam (capture enemies), large drill / multi-kill,
  enemy slowdown, shot nullification, ship parts (complete ship = extra
  life). Extra lives also at score thresholds (DIP-selectable, see
  `docs/hardware.md`).
* The player ship moves left/right **and vertically** (unlike Galaga).
* Released April 1984 (JP), September 1984 (NA). Board shared with Phozon.

From the MAME driver notes (`reference/mame/namco/gaplus.cpp`):

* Easter egg: enter service mode, hold P1 start + P1 fire, move joystick
  left until the sound number reaches 19 -> "(c) 1984 NAMCO" appears.
* Round Advance DIP: turn it on before a level starts, push the joystick
  up to pick a later level, then turn it off again.

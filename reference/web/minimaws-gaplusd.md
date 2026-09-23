# minimaws: gaplusd and gaplus (summary)

Fetched 2026-09-23 from

* https://arcade.vastheman.com/minimaws/machine/gaplusd
* https://arcade.vastheman.com/minimaws/machine/gaplus

Raw HTML saved alongside (`minimaws-gaplusd.html`, `minimaws-gaplus.html`).
The RPC endpoints the pages use (`rpc/flags/<set>`, `rpc/slots/<set>`,
`rpc/bios/<set>`) were queried too; results are below.

**What the pages do NOT contain:** this minimaws instance does not show ROM
lists, clocks, screen parameters, input ports or DIP switches for these
machines (only the device list and status flags). All of those details are
taken from the MAME source in `reference/mame/namco/` instead and are
documented in `docs/hardware.md`.

## gaplusd — "Gaplus (GP2 rev D, alternate hardware)"

| field           | value                                  |
|-----------------|----------------------------------------|
| short name      | gaplusd                                |
| year            | 1984                                   |
| manufacturer    | Namco                                  |
| parent          | gaplus — "Gaplus (GP2 rev. B)"         |
| source file     | namco/gaplus.cpp                       |
| is device       | No                                     |
| runnable        | Yes                                    |
| imperfect       | sound, graphics                        |
| rpc/flags       | sound: imperfect, graphics: imperfect  |
| rpc/slots       | none                                   |
| rpc/bios        | none                                   |

Devices referenced:

| short name  | description         | source file                      |
|-------------|---------------------|----------------------------------|
| namco62     | Namco 62xx          | namco/namco62.cpp                |
| namco56     | Namco 56xx I/O      | namco/namcoio.cpp                |
| namco58     | Namco 58xx I/O      | namco/namcoio.cpp                |
| namco_15xx  | Namco 15xx          | devices/sound/namco.cpp          |
| mb8843      | Fujitsu MB8843      | devices/cpu/mb88xx/mb88xx.cpp    |
| gfxdecode   | gfxdecode           | emu/drawgfx.cpp                  |
| watchdog    | Watchdog Timer      | devices/machine/watchdog.cpp     |
| mc6809e     | Motorola MC6809E    | devices/cpu/m6809/m6809.cpp      |
| samples     | Samples             | devices/sound/samples.cpp        |
| palette     | palette             | emu/emupal.cpp                   |
| screen      | Video Screen        | emu/screen.cpp                   |
| speaker     | Speaker             | emu/speaker.cpp                  |

Note: the mb8843 is the 62XX's internal MCU; MAME configures it with
`set_disable()`, i.e. it never runs (see `namco62.cpp`).

## gaplus — "Gaplus (GP2 rev. B)"  (our set)

Same device list and flags as gaplusd (parent set). Clones listed:

| short name | description                              | year | maker            |
|------------|------------------------------------------|------|------------------|
| galaga3    | Galaga 3 (GP3 rev. D)                    | 1984 | Namco            |
| galaga3a   | Galaga 3 (GP3 rev. C)                    | 1984 | Namco            |
| galaga3b   | Galaga 3 (GP3)                           | 1984 | Namco            |
| galaga3c   | Galaga 3 (set 4)                         | 1984 | Namco            |
| galaga3m   | Galaga 3 (set 5)                         | 1984 | Namco            |
| gaplusa    | Gaplus (GP2)                             | 1984 | Namco            |
| gaplusd    | Gaplus (GP2 rev D, alternate hardware)   | 1984 | Namco            |
| gapluse    | Gaplus (GP7)                             | 1984 | Namco            |
| gaplust    | Gaplus (Tecfri PCB)                      | 1992 | bootleg (Tecfri) |

## Supplement from the MAME source (not on the page)

For convenience, the facts minimaws would normally list, from
`gaplus.cpp` at MAME master commit ef35f64b:

* CPUs: 3 x MC6809E @ 24.576 MHz / 16 = 1.536 MHz (maincpu, sub, sub2).
* Screen: raster, 288 x 224 visible (36 x 28 tiles), 60.606060 Hz,
  ROT90, vblank time 0.
* Sound: Namco 15XX @ 24.576 MHz / 1024 = 24 kHz, 8 voices, mono;
  Samples device, 1 channel, sample set `gaplus` with `bang`.
* Other: Namco 56XX + 58XX I/O (gaplus: 56XX at $6800, 58XX at $6810;
  gaplusd swaps them), Namco 62XX (MB8843, disabled), watchdog.
* DIP switches / inputs: see `docs/hardware.md` section "Inputs & DIPs".

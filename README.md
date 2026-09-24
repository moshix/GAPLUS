# Gaplus (1984), rewritten in JavaScript

Copyright 2026 by Moshix

This will be Namco's Gaplus running in a browser, rewritten routine by
routine in plain JavaScript and checked byte for byte against the original
program. It's the third one of these, after [Galaxian](../galaxian) and
[Galaga](../galaga), and it uses the same method (`docs/PLAN.md`,
`docs/galaga-method.md`).

**Where it stands today: the port isn't playable yet.** The hardware side
is done (memory map, custom I/O chips, video, the 15XX sound chip), and so
is the test oracle: three emulated MC6809 CPUs running the real ROM. The
game routines themselves (`src/game/`) are still being ported. Until they
land, the page can run the *original program* on that oracle, which is the
real game but not the port.

## Running it

```sh
python3.11 -m http.server 8000
```

Run it from the project root, then open <http://localhost:8000>. There's
no build step and nothing to install. `python3 tools/serve.py` does the
same with caching turned off, which is handier while editing.

The ROM version needs the MAME `gaplus` set (GP2 rev. B, 20 files, listed
in `docs/PLAN.md`) in `roms/`. The page fetches those files and checks
every CRC. They're never shipped and `roms/` is git-ignored. Without them
the page tells you which files are missing.

### ROM or JavaScript

Each time the page opens, it asks what to run:

* **ROM**: the original program on emulated 6809s (the test oracle,
  `src/emu/board.js`). A badge above the screen says so, so it can't
  be mistaken for the port.
* **JavaScript**: the routine-by-routine port. It's marked *in progress*,
  and for now picking it shows "port not ready yet" with a button that
  switches to the ROM version.

Arrows and Enter, a gamepad, or a click all work. The page remembers
your last choice and selects it next time. E (or the settings bar)
switches engines later, and the game restarts when you do.
`?engine=rom` or `?engine=port` in the URL skips the question.

### Keys

| Key | What it does |
|-----|--------------|
| ← ↑ ↓ → | move (Gaplus has an 8-way stick) |
| Space | fire |
| 5 / 6 | coin (slot 1 / slot 2) |
| 1 / 2 | 1 or 2 player start |
| P | pause |
| M | sound on/off |
| F2 or 9 | test switch (the service-mode DIP; the board restarts) |
| A | self-playing AI (**JavaScript version only**) |
| E | choose the engine (ROM / JavaScript) |
| + / − | zoom |
| G | set up a joystick or gamepad |

Under the screen, one short line shows the keys you need to play (move,
fire, coin, start). Everything else is on the settings buttons, each
labelled with its key, and "?" opens the full list. Browsers only allow
sound after a click or a key press, so the page says "click / press a
key to start sound" until you do one of those. Gaplus's attract mode is
silent until its demo game, about 40 s in. Insert a coin to hear
something straight away.

### The self-playing AI

Press A (or the AI button) on the JavaScript engine and the computer
plays. If no game is running it inserts a coin and presses start. It
reads the game's state from RAM and only closes the switches a player
has: the 8-way stick and fire. It never writes memory. It drives only
the JavaScript port. In ROM mode its control is greyed out ("JavaScript
version only") and A does nothing.

Each frame it predicts every threat 30 frames ahead. Enemy shots are
computed exactly from RAM; divers fly on at their measured speed and
turn rate. It then tries 369 stick plans through the fighter's real
movement code. It keeps the plan that survives longest, passes widest
of danger and ends under something worth shooting. It fires only when a
simulated shot meets a target. Changing direction costs a little, so it
commits to a direction instead of flickering. In challenging stages,
where nothing can hit it, it hunts. `docs/ai.md` has the details and the
RAM it reads.

```sh
node tools/ai-bench.mjs --runs=10 --verbose   # headless games on the port
```

On 12 games capped at 400,000 frames (110 minutes) each, every game was
still going at the cap. They averaged PARSEC 168 (worst 145) and a score
of 1,330,000, and lost 0.042 ships per parsec. The AI then averaged 34 hits
per challenging stage. Since then a minimum hold per direction and dead
zones have halved the jitter, to 3.6 direction changes and 0.9 reversals
a second. They lost fewer ships, not more: 0.017 per parsec in 12 games
of 38,000 frames. The cost is challenging-stage hits, now 26 a stage.

Any USB stick or pad works. Press G and move the control you want for
each action. The defaults are the left stick or d-pad to move, button 0
to fire, Select for coin, Start for start and button 3 for pause.

For headless runs, `?frames=N` runs N frames as fast as it can, shows the
last one and stops (`&coin=F&start=G` taps coin and start at those
frames). `canvas.dataset.frame` counts frames, and `globalThis.gaplus` is
the game object.

## How it works

The method is the same as Galaga's. Each routine of the three 6809
programs becomes a JS function that does the same thing to the same
memory. Game state lives at the original addresses. Under `test/`, the
real ROM runs on emulated hardware next to the port, and the tests require
every byte of RAM to match, frame by frame. Graphics, palette and sound
waveforms are generated from the ROMs by the scripts in `tools/`.

## Tests

```sh
node --test test/unit/*.test.mjs     # unit tests (npm run test:unit)
npm run test:browser                 # headless Chrome smoke test
```

The browser test starts a static server and drives
`/Applications/Google Chrome.app` headless through the DevTools protocol,
using Node's built-in WebSocket (Node 22+, no puppeteer). It covers:

* a 600-frame fast run
* the chooser: ROM preselected, arrow keys, Enter
* coin, start and 10 s of play at 60.6 fps, with the AI control
  disabled in ROM mode
* the chooser reopened with E and closed with Escape
* on the port, A turns the AI on and it coins up and starts a game
* the port's "not ready yet" screen and its switch to the ROM version
* sound after coin + start: audible register images reach the
  AudioWorklet, and the worklet reports non-silent output
* layout at 480 px and 1280 px: the key legend stays on one line and
  "?" opens the help

It fails on any console error. Screenshots go to `screenshots/`.

After adding a module under `src/`, run `node tools/gen-index.mjs` so the
cache-busting import map in `index.html` lists it (a unit test checks
this). `node tools/gen-favicon.mjs` regenerates `favicon.png` from the
fighter sprite.

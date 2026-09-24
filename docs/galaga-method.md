# The Galaga method: engineering reference for the Gaplus port

Copyright 2026 by Moshix

This document takes apart `../galaga` (the Galaga port: three Z80s,
routine-by-routine JavaScript, and a differential oracle) so the same
approach can be rebuilt for Gaplus (three MC6809Es). All paths are relative
to `/Users/moshe/galaga` unless they start with `gaplus/`. Nothing in
`../galaga` was changed while writing it.

Gaplus hardware facts quoted here come from
`gaplus/reference/mame/namco/gaplus.cpp`, `gaplus_v.cpp`, `gaplus_m.cpp` and
`gaplus/reference/mame/sound/namco.cpp`. They are provisional until
`docs/hardware.md` exists.

---

## 0. The method in ten lines

1. **Keep the original memory map.** All game state lives in one flat 64 KB
   `Uint8Array` (`Machine.mem`) at the ROM's own addresses. There are no
   objects like `Enemy` or `Player`.
2. **One JS function per ROM routine.** It is named after the routine's
   label in a generated listing and does the same writes in the same order.
3. **Cross-module calls go through per-CPU registries** (`MAIN`, `MAIN_AT`),
   never through direct imports, so modules can be written in parallel.
4. **Foreground code is a generator**; it `yield`s where the CPU spins
   waiting. Interrupt handlers are plain functions, or generators that
   yield progress markers.
5. **One fixed order per frame** (`Scheduler.stepFrame`) replaces the three
   CPUs running in parallel. The order is measured against the oracle.
6. **The oracle** (`test/`) is a cycle-counted emulation of the real board
   running the real ROM. It never ships to the browser.
7. **Routine tests:** seeded random RAM goes into both sides, the ROM
   routine runs on the oracle and the JS routine on the port, then
   `diffRam()` must be `[]`.
8. **Lockstep test:** both sides run from power-on, and all RAM is compared
   after every frame. Values that depend on timing (the Z80 `R` register)
   are recorded from the oracle and replayed into the port.
9. **All data is generated** from the ROM zip by `tools/`: graphics,
   palette, waveforms, and the program ROMs' data bytes. None of it is typed
   in by hand.
10. **No dependencies, no build step.** The code is plain ES modules. Node's
    `node:test` and `node:zlib` are the whole toolchain.

---

## 1. Repository layout (galaga)

| Path | What | Ships? |
|------|------|--------|
| `src/machine/machine.js` | board as the game sees it | yes |
| `src/machine/namco51.js` | 51XX I/O chip, HLE | yes |
| `src/machine/mb88.js`, `namco54.js` | MB88 core + 54XX (noise) | yes |
| `src/game/scheduler.js` | per-frame CPU sequencing | yes |
| `src/game/call.js` | generator-agnostic call helper | yes |
| `src/game/io.js` | 06XX bus, whole transfers at once | yes |
| `src/game/romdata.js` | GENERATED data bytes of program ROMs | yes |
| `src/game/z80ops.js` | exact Z80 ALU/flag helpers | yes |
| `src/game/{main,sub,sound}/` | one module per ROM chip + `routines.js`, `index.js` | yes |
| `src/video/` | renderer, starfield, GENERATED tiles/sprites/palette | yes |
| `src/audio/` | WSG, mixer, worklet, resampler, 54XX voice/filter | yes |
| `src/input/` | keyboard/gamepad mux, bindings, remap dialog | yes |
| `src/ai/` | self-playing AI (not needed for Gaplus at first) | yes |
| `src/main.js`, `index.html`, `favicon.png` | page | yes |
| `test/z80/` | Z80 core + `GalagaBoard` (the oracle) | no |
| `test/mcu/` | 06XX timing model, 51XX/54XX LLE wrappers | no |
| `test/helpers/` | `oracle.mjs`, `lockstep.mjs` | no |
| `test/oracle/` | per-ROM-chip differential tests + lockstep | no |
| `test/unit/` | video, WSG, mixer, z80ops, index.html, input, AI | no |
| `tools/` | disassembler, listing, generators, screenshots | no |
| `reference/` | generated `.asm` + `symbols.json`, MAME sources | no |

Galaga's `.gitignore` excludes the whole `test/` tree ("kept local"),
`galaga.rom` and `reference/neiderm/`. For Gaplus, the owner decides.

---

## 2. Runtime architecture

### 2.1 `src/machine/machine.js`: the board as the game code sees it

* `mem = new Uint8Array(0x10000)`: the address in the listing is the index.
  ROM space stays zero, because ROM data comes from `romdata.js`.
  `video`, `ram1..3` are `subarray` views that the renderer and
  `diffRam` read.
* **`peek(addr)`** is a CPU read with its I/O semantics: DIP switches at
  `$6800-$6807`, the 06XX control/data registers, 0 for undecoded space.
* **`poke(addr, v)`** is a CPU write with side effects. It increments
  `writes`, the scheduler's "did anything happen" counter. RAM chips are
  written only where they are decoded. WSG registers (low nibble) call
  `hooks.onWsgWrite`. The LS259 latch goes through `writeMisc`, which
  raises `hooks.onIrqEnable` and `hooks.onRunLatch`. The watchdog, 06XX
  control and 06XX data all have hooks too.
* **`read(cpu, addr)` / `read16`** read through a pointer that may point
  into that CPU's ROM (`< $4000` goes to `romByte(cpu, a)`) or into RAM.
  Use it whenever a pointer stored in RAM is followed.
* `peek16`/`poke16` are **little-endian** (Z80).
* `ldir(dst, src, n, cpu)` copies byte by byte, so overlapping copies
  smear exactly as on the Z80. `fill(addr, v, n)` implements `rst $18`.
* Latches: `misc[8]` holds Q0 main IRQ enable, Q1 sub IRQ enable, Q2 sound
  NMI disable and Q3 sub/sound run. `videoLatch[8]` holds the starfield
  control and flip.
* Interrupt state: `iff[3]` (IFF1 per CPU) and `irqLine[2]`, which is level
  triggered. Writing 0 to a latch enable drops the line.
* **`di(cpu)` / `ei(cpu)`**. `ei` sets IFF and calls `hooks.onIrqEnable`,
  so a pending vblank IRQ runs **inside the `ei()` call**, just as the Z80
  takes it after the next instruction.
* **`readR`** (defaults to `nextR()`, a 7-bit xorshift) is the Z80 refresh
  register, used by the RNG at `$1000`. The lockstep test replaces it with
  replayed oracle values (section 3.4).
* **`charge(cycles)` / `charged`**: CPU time charged by the few routines
  long enough for it to matter (section 2.6).
* `hacks = { fastFire: false }`: deliberate departures, off in tests.
* `setInput(name, down)` for active-low switch ports, and `reset()`.
* The machine never imports game code; the scheduler installs `hooks`.

### 2.2 Registries: `src/game/<cpu>/routines.js` and `index.js`

```js
// routines.js: a leaf module with no imports
export const MAIN = {};     // label  -> function
export const MAIN_AT = {};  // address -> function (task tables, jp (hl))
export function mainAt(addr) { /* throws if missing */ }
```

Each ROM-chip module registers everything it defines when it loads:

```js
Object.assign(MAIN, { f_0827, f_0828, c_sctrl_sprite_ram_clr, ... });
Object.assign(MAIN_AT, { 0x0827: f_0827, 0x0828: f_0828, ... });
```

It calls other modules as `MAIN.c_1234(m, { hl })`, so a routine that
doesn't exist yet fails only when it is called. `index.js` imports every
chip module and exports the `CpuPorts` the scheduler drives:

```js
export const mainCpu = {
  reset: (m) => MAIN.main_reset(m),      // generator: foreground thread
  irq:   (m) => MAIN.main_irq_steps(m),  // generator with slot markers
};
export const soundCpu = { reset: ..., nmi: (m) => SOUND.sound_nmi(m) };
```

A module that grows too large splits into helper files (`gg1_1_irq.js`,
`gg1_1_flow.js`, and so on). The file named after the chip still registers
the whole range.

### 2.3 Calling convention (`docs/porting-guide.md` sections 3-4)

* Routine names are the listing labels exactly. A routine without a label
  is `sub_XXXX` (upper-case hex). JSDoc gives `@see galaga-main.asm $XXXX`.
* The signature is `(m, regs)`. `regs` holds the registers the routine
  reads before writing them (`{ a, bc, de, hl, ix, iy }`).
* The routine returns the registers and flags **any caller consumes**, for
  example `{ a, hl, cf, zf }`. Check the callers in the listing.
* Write every byte the CPU writes, in the same order, including
  temporaries. **Only the stacks are exempt**, because pushes and pops
  become JS locals.
* Arithmetic stays exact: `& 0xff` wraps, carries that flow into the next
  instruction are kept, `daa` is exact, and a flag left over from an
  earlier instruction is reproduced deliberately, with a comment.
* Every non-obvious line quotes the instruction:
  `// $0245: c = ((f & $1C) ^ rrca(...)) & $18`.

### 2.4 `src/game/call.js`

```js
export function* call(fn, ...args) {
  const r = fn(...args);
  if (r && typeof r.next === 'function'
      && typeof r[Symbol.iterator] === 'function') return yield* r;
  return r;
}
```

Foreground code uses `yield* call(MAIN.x, m, regs)` whenever it can't know
whether the callee waits (is a generator). **Reusable verbatim.**

### 2.5 `src/game/romdata.js` (GENERATED by `tools/gen-listing.mjs`)

* It holds the program ROMs as base64, **with code bytes zeroed**, plus a
  base64 bitmap that marks which bytes are data.
* `romByte(cpu, addr)` **throws** on a code byte, because reading one is
  always a porting mistake. `romWord` is little-endian. The helpers are
  `mainRom`, `subRom` and `soundRom`.
* Tables are read **at their ROM addresses** and never copied into
  hand-made arrays. RAM holds ROM pointers (flight paths, strings), so the
  addresses must be real.
* **Code read as data:** `READ_AS_DATA` in `gen-listing.mjs` lists
  code ranges that the game also reads as data, and exports them anyway.
  Examples: the RNG reads `$0100-$01FF` (task-manager code) as noise; a
  bomber-timer table overruns into `$0935-$0B0E`; and on stage 256 the wave
  builder reads `$2896-$2ACD`.

### 2.6 `src/game/scheduler.js`: one frame, in order

On the board the three CPUs run in parallel. The port replaces that with one
fixed order per frame of 1/60.606 s, chosen to follow the hardware's
timeline. A port frame runs from `FRAME_LINE = 160` of one board frame to
line 160 of the next, which is also where lockstep samples the oracle.

```
stepFrame():
  soundNmi()            line 192   sound CPU NMI (if running, not masked)
  preForeground()       line 160..224: main foreground work carried over
                        from earlier frames (fgDebt)
  vblank                line 224   raise IRQ lines whose latch enable is
                        set; onVblank() (51XX samples inputs)
  handlers to RENDEZVOUS, in irqOrder [SUB, MAIN]
  phases after the rendezvous, as [cpu, run-until-slot] pairs:
     [MAIN, 9] [SUB, 3] [MAIN, 12] [SUB, inf] [MAIN, inf]
  mainTail (last frame's overrunning main handler) finishes
  runForeground()       every CPU's foreground until it waits
  soundNmi()            line 64 of the next board frame
```

**Yield vocabulary** (symbols exported by `scheduler.js`):

| Yield | Meaning |
|-------|---------|
| `yield` | wait for the next frame (the condition can only change in an IRQ, or the loop burns real time) |
| `yield SPIN` | busy-wait on **another CPU's foreground** (boot handshakes). Spinning threads are re-polled up to 64 rounds while `m.writes` keeps changing |
| `yield HALT` | Z80 `halt`. It differs from `yield` only while carried-over work is still owed: `halt` wakes one interrupt after that work finishes |
| `yield BUSY` | "I just `charge()`d time": resume at once if it fits in the frame, otherwise after the frames it spills into |
| `yield RENDEZVOUS` | IRQ handler only, once: the main and sub CPUs each copy half the sprite buffer, then wait for each other |
| `yield <number>` | IRQ handler progress marker: "about to run task slot N" |

**Interrupt handling.** `tryIrq(cpu)` runs only when `irqLine && iff &&
!inHandler && running`. It clears `iff` on entry and `leaveIrq` sets it
again, because every Galaga handler ends `ei; ret`. `hooks.onIrqEnable`
calls `tryIrq`, so `m.ei()` or a latch write can take a pending IRQ in the
middle of foreground code.

**Interleaving two handlers by slot.** The main and sub handlers are task
managers. Before each task they yield the slot number, and
`runUntil(cpu, t, before)` resumes a handler until it reaches a slot
`>= before`. The `phases` table (`mainSplit = 9`, `mainLate = 12`,
`SUB_MOTION_SLOT = 2`) was chosen by running `tools/lockstep-run.mjs` with
`--split=` and `--late=` and keeping the values with the fewest
differences. There is also a load rule: once main has charged more than
`SUB_OVERLAP_CYCLES` (8000), its remaining tasks run after the sub CPU's.

**IRQ skipping (a long handler).** Frame costs are modelled only where they
matter:

* `CYCLES_PER_FRAME = 50688` (384 x 264 / 2). `MAIN_IRQ_BASE_CYCLES =
  13000` is the measured handler overhead besides explicit charges.
* A heavy routine calls `m.charge(N)` with N measured on the oracle (for
  example `PLAYFLD_CLR_CYCLES = 39384` or `STG_INIT_ENV_CYCLES = 18296`).
* In `runUntil`, if `MAIN_IRQ_BASE_CYCLES + m.charged > CYCLES_PER_FRAME`,
  the handler has run past the next vblank. The rest of the generator is
  parked in `mainTail`. The next vblank finds the latch enable clear (the
  handler clears `$6820` at entry and sets it at exit), so **that IRQ is
  lost**, and the tail finishes after the next frame's sub handler.
* Foreground budget: `runForeground` gives main
  `POST_SLOT_CYCLES - MAIN_IRQ_BASE_CYCLES - irqCharged` cycles. Work
  charged beyond that becomes `fgDebt`, and the main foreground is held back
  for as many frames as the real Z80 would be busy. The work itself has
  already happened; only what follows it is delayed. This fixed game-over
  arriving two frames early.

**Other mechanisms.**

* `CpuHang`: thrown where the Z80 would loop forever (for example the
  stage-0 wave builder). It is thrown only after the writes the endless
  loop would settle into. The scheduler parks that foreground; interrupts
  keep running.
* `powerOn()` starts only the main CPU. Latch Q3 (`setSubsRunning`) starts
  or stops the sub and sound foregrounds from their reset vectors.
* A foreground that *returns* throws. On this board it never should.
* **Non-local jumps out of a handler** (`f_0977` jumps from the IRQ into
  the RAM test, and the sub's `rst $00`) set a flag in a per-machine
  `WeakMap` (`gg1_1_state.js`). The handler returns early. The foreground
  driver (`main_reset`) calls `.return()` on the running game-flow
  generator and starts the new entry point.

**Timed busy loops** (`src/game/main/gg1_4_post.js`). The RAM and ROM tests
burn real time with interrupts off. The generator keeps a Z80 cycle clock
`clk.t` that adds up the quoted T-states of each loop, and `sync(clk)`
yields once for every `FRAME_CYCLES` passed, **before** the next observable
write. Totals are checked against the oracle (tile RAM test 5,899,960
cycles). There is also a realignment rule: while main runs alone, frames
are FRAME_LINE-aligned; once the other CPUs run, they are vblank-aligned.
Simpler waits use "yield N frames, measured on the oracle", with a comment
saying so.

### 2.7 `src/game/io.js` (Galaga only)

The 06XX moves one byte per NMI. The port performs the whole transfer when
the command is issued (`IoBus.transfer(0x71, 0x99b5, 3)`), then does
the NMI's tail work (the fighter-hit explosion trigger). **Gaplus has no
06XX.** Its 56XX and 58XX are memory-mapped at `$6800-$681F` (see
section 9).

---

## 3. The oracle (`test/`)

### 3.1 `test/z80/machine.mjs`: `GalagaBoard`

* Three `Z80` cores (`test/z80/z80.mjs`: cycle-counted, exact flags
  including X/Y and MEMPTR, R counted per M1). Each CPU sees its own ROM at
  `$0000-$3FFF` and shares the RAM arrays. The sub and sound CPUs start in
  reset (`inReset`).
* Timing is MAME's `set_raw(MASTER/3, 384, 0, 288, 264, 0, 224)`: 192 CPU
  cycles per line, `CYCLES_PER_FRAME = 50688`, vblank at line 224
  (`VBLANK_CYCLE = 43008`), sound NMI at lines 64 and 192.
* **Interleaving:** `runTo(until)` runs slices of `QUANTUM = 128` cycles
  (MAME's maximum for Galaga is 512). Within each slice it runs main, then
  sub, then sound, each until its own `cpuTime[n]` reaches the slice end
  (instruction granularity). Slices also end at the next 06XX timer event.
  After each slice it steps the MCUs (`run(cycles)`), fires due 06XX
  events, and calls the optional `observe(board)` callback, which can stop
  the run.
* **Frame events:** `frameEvents()` returns `[line, action]` pairs:
  51XX vblank low at line 0, sound NMI at 64 and 192, and `vblankStart()`
  at 224, which asserts main/sub IRQs if the latch is enabled and counts
  the watchdog. `advanceTo(absCycle)` fires them in order and **can stop
  anywhere, mid-frame included**. That is what lets lockstep sample at
  line 160.
* `applyMiscLatch()` wires Q0-Q3: masks, clears lines, resets sub/sound on
  release, and resets the MCUs.
* The `Namco06` class is an exact port of `namco06.cpp` (timer, read
  stretch, chip selects, NMI). The 51XX/54XX are MB88 LLE on the real
  firmware (`test/mcu/`), or `NullChip`.
* Debug hooks: `onWrite(cpu, a, v)`, `onWsgWrite`, and
  `onExec(n, pc, cpu)` after every instruction (slow). The last is used to
  record R and watch code.
* Helpers: `runFrame()`, `runUntil(pred, maxFrames)`, `setInput`,
  side-effect-free `peek`, and `poke`.

### 3.2 `test/helpers/oracle.mjs`

* `makeOracle(chips?)` builds a board with the ROMs from
  `tools/romset.mjs`, loaded once and cached. `loadChips()` attaches the
  51XX/54XX LLE if `test/mcu/` exists.
* **`callRoutine(board, cpu, addr, regs, {maxCycles, stack})`** sets the
  registers, `pc = addr` and `sp = TEST_STACK ($90A0)`, turns interrupts
  off (`iff1 = iff2 = 0`), pushes the sentinel `$3FFF`, and single-steps
  **only that CPU** until `pc === SENTINEL && sp === startSp`. It returns
  the registers plus `cycles`. The other CPUs are frozen.
* `RAM_REGIONS` (video, ram1, ram2, ram3) and `STACK_RANGES`
  (`$9030-$90FF`, `$9AE0-$9AFF`, `$8AE0-$8AFF`) are excluded from diffs.
* `loadState(dst, src)` copies RAM between any two owners (board or port).
* **`diffRam(expected, actual, {limit, ignore})`** returns lines like
  `"$9201 b8_9201_game_state oracle=$01 port=$03"`. Names come from
  `reference/symbols.json` (`nameOf` gives the nearest label, with `+$off`).

### 3.3 Routine-test patterns (`test/oracle/*.test.mjs`)

These are worth copying wholesale. `main-gg1_2.test.mjs` is the best
template.

* `state(seed, setup)` fills the port's RAM from a seeded xorshift, applies
  the test's setup, `loadState`s it into the oracle, and copies the DIP
  switches. **Test many seeds and every branch, not the happy path.**
* `runOracle(addr, regs, {loops, tick, before, after})` steps the oracle
  itself. A `tick` stands in for what the IRQ would change (for example
  `TICK_FRAME` increments `$92A0`) and is applied each time the Z80 takes
  the **backward jump of a listed poll loop**. `runPort` drives the port's
  generator and applies the same tick at each `yield`. **The tick counts
  must match**: this tests *how many frames a routine waits*.
* `oracleStub(addr)` replaces a routine from *another* module during the
  test with "run the real ROM routine on a scratch board over the port's
  RAM". Each module's tests then depend only on that module, which is what
  made parallel porting work. `withStubs(fn)` swaps them in and out of
  `MAIN`.
* A registration test checks that every routine is in `MAIN` and
  `MAIN_AT`, and that every task-table entry and every jump-table target
  (read from ROM with `romWord`) has a registered function.
* Coverage: `GG1_2_COVERAGE=1` lists listing addresses the oracle never
  executed, printed 12 per line to stay within 79 columns.
* **Trace test** (`sound-gg1_7-trace.test.mjs`): run the full board
  (5000 frames, coin, start). At each sound NMI instant, found via
  `observe` at `NMI_CYCLES`, snapshot RAM and WSG and run the ROM NMI on a
  solo oracle and the port NMI, then compare. This tests against *real*
  traffic without the scheduler.
* **Exhaustive edge test** (`stage0.test.mjs`): all 256 stages x 4 ranks.
  The ROM's hang (`maxCycles` exceeded) must match the port's `CpuHang`,
  and RAM must be identical either way. RNG values are captured on the
  oracle by wrapping `z.step` and replayed by stubbing `MAIN.c_1000`.

### 3.4 Lockstep (`test/helpers/lockstep.mjs`, `test/oracle/lockstep.test.mjs`)

* `makePair()` builds an oracle with the chips plus a port `Machine`
  (with `IoBus` and the HLE `Namco51`) and a `Scheduler`. It calls
  `powerOn()` and advances the oracle to `SAMPLE_LINE * 192`.
* **Sampling point.** Port frame k is compared with the oracle at line
  `FRAME_LINE` (160) of frame k+1. By then both vblank handlers have
  finished (the sub's runs until about line 103), and the next sound NMI
  (192) hasn't happened. `step()` advances the oracle one frame, runs
  `sched.stepFrame()`, and returns `diffRam`.
* **R recording and replay.** `board.onExec` pushes `cpu.a` whenever main
  executes the instruction *after* `ld a,r` (pc `$1001` or `$100D`), and
  `m.readR` shifts from that queue. When the queue is empty (after a
  resync) it falls back to `nextR()` and counts `rMisses`.
* **Resync.** After 3 consecutive differing frames, the ROM's RAM is copied
  into the port. Latches are not copied, because that could catch the
  oracle mid-handler with an enable clear. The R queue is cleared.
  `SLOW_STATE` (score digits, lives, stage, credits, TOP 5) is copied only
  after 30 frames of difference, so a one-shot logic bug can't be copied
  away.
* Test tiers:
  * **strict:** 2300 frames from power-on through the self test into
    attract, with 10 or fewer differing frames, none lasting more than 5.
  * **resync:** 8000 frames of attract.
  * **played:** 12000 frames. Coin at frame 1500, start at 1600, then a
    seeded LCG joystick and fire. The longest run of differences must be
    5 frames or less, and under 5% of frames may differ.
* A race costs a blip that heals. A logic bug re-diverges right after every
  resync and shows up as a long run.

### 3.5 `tools/lockstep-run.mjs`

```
node tools/lockstep-run.mjs FRAMES [coin@F] [start@F] [left@F-G] \
     [--order=sub,main] [--split=N] [--late=N] [--show=N] [--resync] \
     [--play=SEED]
```

It prints the first N differing frames (8 diff lines each), then run-length
statistics and R fallbacks. This is the diagnosis tool and the way to tune
scheduler constants. When the port throws, it prints the frame and a
four-line stack.

---

## 4. Video

| File | Written or generated | Content |
|------|----------------------|---------|
| `src/video/renderer.js` | written | port of `screen_update_galaga` |
| `src/video/starfield.js` | written | 05XX LFSR state machine |
| `src/video/resnet.js` | written | MAME `compute_resistor_weights` + `combine_weights` |
| `src/video/tiles.js` | GENERATED | 8x8 chars |
| `src/video/sprites.js` | GENERATED | 16x16 sprites |
| `src/video/palette.js` | GENERATED | RGB tables, LUTs, transparent pens |
| `assets/*.png` | GENERATED | sheets for checking by eye |

* **The renderer reads only video RAM, sprite registers and the latch.** It
  never reads port internals, so the *oracle's* RAM renders through the
  same code (`tools/shoot.mjs`).
* Composition happens in **raster space** (the monitor's native 288x224
  landscape). The finished frame is rotated once (ROT90) into 224x288:
  `playerX = 223 - rasterY`, `playerY = rasterX`. Every MAME constant can
  then be copied literally.
* `raster` is a `Uint8Array` of **indirect colour indices**, which tests
  can compare. `pixels` is a `Uint32Array` of RGBA that shares its buffer
  with the page's `ImageData`, so presenting a frame copies nothing.
* Layers: black fill, then stars, then 64 sprites (a later sprite covers an
  earlier one), then the 36x28 tilemap (with `CHAR_TRANSPARENT`).
  `tilemapScan(col,row)` is MAME's 32x32-to-36x28 mapper.
* The flip-screen and double-size sprite rules (`GFX_OFFS`, the `sy` wrap)
  are copied from MAME. A full frame renders in under 8 ms (unit test).
* Generated module format (`tiles.js`, `sprites.js`): a
  `// GENERATED ... do not edit` header, `*_COUNT` and `*_SIZE` exports,
  and a base64 string of **2-bit pens packed 4 per byte**. It unpacks to
  a flat `Uint8Array` where pixel (x, y) of element n is at
  `n*w*h + y*w + x`, in raster orientation. `unpack` works in both the
  browser (`atob`) and Node (`Buffer`).
* `palette.js` exports `PALETTE` (32 RGB triples, each commented with its
  PROM byte), `STAR_PALETTE` (64), `STAR_COLOR_BASE`, `CHAR_LUT`,
  `SPRITE_LUT`, `CHAR_TRANSPARENT = 0x1f` and `SPRITE_TRANSPARENT = 0x0f`.
* `tools/gen-graphics.mjs` defines `GfxLayout` objects that transcribe
  MAME's `gfx_layout` (bit offsets, `STEPn` helper). `decodeGfx(rom,
  layout)` numbers bits MSB-first, with plane 0 as the MSB, exactly like
  MAME. It also packs base64, writes the three modules, and draws PNG
  sheets (`assets/tiles.png`, `sprites.png`, `sprites-c1.png`,
  `palette.png`), rotated for the eye.
* Unit tests (`test/unit/video.test.mjs`) check that emitted modules equal
  a fresh decode of the ROM, the palette against the resistor math, the
  LUTs against the PROMs, the tilemap corners, starfield period and hits,
  the sprite flip and size rules, and render time.

---

## 5. Audio

| File | Role | Generic Namco? |
|------|------|----------------|
| `src/audio/wsg.js` | 3-voice WSG: `decodeWsg(regs)`, `wsgSample`, `wsgTick`, `renderWsg`, clock math copied from `device_clock_changed` | **pattern** (15XX differs) |
| `src/audio/waveforms.js` | GENERATED 8x32 4-bit waves from the sound PROM | regenerate |
| `src/audio/resample.js` | `BoxResampler`: area-averaging from 192 kHz to device rate | **verbatim** |
| `src/audio/mixer.js` | `GalagaMixer`: jitter queue of per-frame register images, 54XX events | **mostly** |
| `src/audio/wsg-worklet.js` | `AudioWorkletProcessor` wrapping the mixer; `frame` and `pause` messages | **verbatim** (rename) |
| `src/audio/sound.js` | `SoundEngine`: AudioContext, worklet or main-thread fallback, mute and pause ramp, register snapshot capture | **mostly** |
| `src/audio/n54*.js`, `mcu54rom.js` | 54XX noise (MB88 firmware + filter) | Galaga only |

How the Galaga pipeline works:

* The sound CPU port writes WSG registers through `m.poke`. `SoundEngine`
  hooks `onWsgWrite` and snapshots all 32 registers each time the
  **last-written register of an update** (`$0F`) arrives. That gives one
  image per NMI, two per frame.
* Each frame, `update(m)` posts `{a, b, n54}` (transferable buffers) to the
  worklet. The mixer plays image A for stream samples 0-1535 and image B
  for 1536-3167 of the 3168-sample frame (192 kHz).
* Jitter handling: the mixer primes to `targetFrames = 2`. A late frame
  holds the last registers (no click). A queue longer than `maxFrames = 6`
  drops old frames but keeps their final state. Pause empties the queue
  and re-primes.
* MAME exactness: a voice at volume 0 is skipped **and its counter holds**,
  `MIX_RES = 128 * voices`, and the route gain comes from the driver.
  `wsg.test.mjs` checks stream samples against a MAME transliteration and
  that `waveforms.js` is up to date.

**What is generic for the Gaplus 15XX** (`namco.cpp` `namco_15xx_device`,
`namco_audio_device<8,false>`):

* Same phase-accumulator core: `waveform_r` uses the low nibble minus 8,
  `waveform_position = (counter >> fracbits) & 31`, and the voice is
  skipped when volume is 0. Change `MIX_RES = 128 * 8`.
* Clock: `24.576 MHz / 1024 = 24 kHz`, doubled 3 times to 192 kHz, so
  `fracbits = 18`. The wave PROM is `gp2-4.3f`.
* Register map: 8 voices x 8 bytes at 15XX offsets `$00-$3F` (main CPU
  `$6000-$603F`, sound CPU `$0000-$003F`). Per voice: `+3` volume (low
  nibble), `+4`, `+5`, and the low nibble of `+6` hold the 20-bit
  frequency, and the high nibble of `+6` (bits 4-6) is the waveform.
  **`+2` is a write event**: it sets the counter's integer bits
  (`counter = (counter & fracmask) | (data & 0x1f) << fracbits`). Register
  snapshots therefore can't reproduce it; the mixer would need write
  events. Check whether Gaplus ever writes `+2`.
* `$6040-$63FF` (sound `$0040-$03FF`) is plain shared RAM. The register
  bytes are readable (`namco_15xx_r`), so **include `$6000-$63FF` in the
  compared RAM**.
* `sound_enable_w` is driven by the SRESET latch (`$8000` versus `$8800`):
  no output while the sub CPUs are held in reset.
* **The explosion** is a *sample* in MAME (`"bang"`, started when
  customio_3 offset 9 is written with a value of `$0F` or more,
  `gaplus_m.cpp`). The sample is not in the ROM set. Decide on a
  substitute and document it as a departure.
* The sound CPU gets **one IRQ per frame** (vblank), not two NMIs. That
  suggests one register image per frame, which simplifies the mixer.
  Measure when in the frame the writes land.

---

## 6. Input and UI

* `src/main.js` (`Game`):
  * Fixed-step clock: real time accumulates and whole frames of
    `1000/FRAME_RATE` ms run. At most `MAX_CATCHUP_FRAMES = 4`; beyond that
    the backlog is dropped.
  * `stepFrame()` does AI or gamepad input, then `scheduler.stepFrame()`,
    then `renderer.render(video, ram1, ram2, ram3, videoLatch)` (every
    frame, so the starfield advances), then `sound.update(machine)`.
  * `present()` calls `putImageData` and sets `canvas.dataset.frame`, so a
    headless browser can see progress.
  * Pause (P or the pad, edge-detected in the rAF loop so the pad can
    unpause) is kept separate from `hidden` (tab visibility).
    `applyFrozen()` handles sound, the hint text and the accumulator reset.
  * Zoom (+/-, 1-6) sets the `--zoom` CSS variable; the canvas stays at
    224x288 with `image-rendering: pixelated`.
  * Keys: arrows, Space, 5/6 coin, 1/2 start, A (AI), G (remap), P, M, F
    (fast-fire hack, stored in `localStorage`), +/-. Any keydown calls
    `sound.start()`, which is the user gesture that unlocks audio.
  * On window blur, the mux is reset and the ports return to `$FF`.
  * URL warm-up: `?frames=N&coin&start&ai&coinAt=F` steps frames
    synchronously for headless screenshots. `globalThis.galaga` exposes the
    game.
  * `VERSION` constant: keep it in step with `package.json`.
* `src/input/mux.js` (`InputMux`): each source (keyboard, gamepad) holds a
  set of switch names. A switch is closed if **any** source holds it.
  Only real changes reach `machine.setInput`. **Reusable verbatim.**
* `src/input/bindings.js`: `ACTIONS`, `MACHINE_INPUT` (action to switch),
  `EDGE_ACTIONS` (pause), hysteresis deadzones 0.5/0.35, **deviation from
  a sampled rest pose** (cheap sticks and triggers resting at -1),
  `DEFAULT_BINDINGS` (several candidates per action), per-device profiles
  in `localStorage` (`galaga.gamepad.v1`), and a `safeStorage` wrapper.
  All pure functions. **Reusable. Add `up` and `down`**: Gaplus has an
  8-way stick.
* `src/input/capture.js`: `detectBinding` ranks controls by movement since
  the prompt appeared. `CAPTURE_THRESHOLD = 0.6`, `HOLD_FRAMES = 3`.
  **Verbatim.**
* `src/input/gamepad.js` (`GamepadInput`): polled once per rAF, with an
  injected `navigator` so it can be tested. **Verbatim.**
* `src/input/remapui.js`: a thin DOM layer over a native `<dialog id="remap">`
  whose rows come from `tr[data-action]` in `index.html`. **Verbatim.**
  Add rows for up and down.
* `index.html`:
  * Inline CSS: dark theme, `#settings` toggle buttons with `aria-pressed`
    that mirror the keys, `#ai-hint` glow (respects
    `prefers-reduced-motion`), `#version` fixed in the corner.
  * **Cache busting:** an inline script mints a token per load and builds
    an **import map** that rewrites every module URL listed between
    `/* MODULES:BEGIN */` and `/* MODULES:END */`. The entry point is
    `import(\`./src/main.js?v=${token}\`)`.
* `tools/gen-index.mjs` regenerates that module list from `src/`.
  `test/unit/index-html.test.mjs` checks that the list equals the files on
  disk, is sorted and unique, and that every entry resolves. **Run
  `gen-index` after adding any module.**
* `favicon.png` comes from `tools/gen-favicon.mjs`: sprite 6 in colour 9,
  taken from the generated tables and scaled 2x. It is generated, never
  drawn.
* `tools/serve.py` is a `ThreadingHTTPServer` with
  `Cache-Control: no-store` that logs only non-2xx responses.
  `npm run serve` uses a plain `http.server` instead.

---

## 7. Tools

| Tool | What it does | For Gaplus |
|------|--------------|------------|
| `romset.mjs` | reads a ZIP with **no dependencies**: scans back for the EOCD, walks the central directory, takes data offsets from the local header, handles stored (method 0) and deflate (`inflateRawSync`), checks sizes. `loadGalaga()` groups chips by board wiring | keep `readRomset` verbatim; write `loadGaplus()` (file names and CRCs from PLAN.md; also allow `roms/` loose files) |
| `png.mjs` | minimal RGBA PNG encoder (CRC table + `deflateSync`, integer scale) | verbatim |
| `z80dis.mjs` | table-free Z80 disassembler (x/y/z/p/q decoding). Returns `{addr,len,text,bytes,target,flow,cond,ref}` | rewrite as `m6809dis.mjs` with the **same Instr shape** (MAME `6x09dasm.cpp` is in `gaplus/reference`) |
| `neiderm.mjs` | parses Neidermeier's ASxxxx source into items with operand-free *patterns* | none (no commented Gaplus source known) |
| `gen-listing.mjs` | aligns source items to rev. B bytes with a running delta, traces code, writes `.asm`, `symbols.json` and `romdata.js` | rewrite (see below) |
| `gen-graphics.mjs` | ROM/PROM to `tiles.js`, `sprites.js`, `palette.js` + PNG sheets | adapt the layouts and palette |
| `gen-sound.mjs` | PROM to `waveforms.js`; `54xx.bin` to `mcu54rom.js` | keep the waveform half |
| `gen-favicon.mjs` | favicon from sprite tables | adapt code/colour and 3bpp |
| `gen-index.mjs` | module list in `index.html` | verbatim |
| `render-sheet.mjs` | synthetic screen (text + sprites) through the renderer, to `assets/render-test.png` | adapt the font codes |
| `shoot.mjs` | runs the **original ROM** on the oracle and renders its RAM with the port's renderer: `node tools/shoot.mjs out.png 1500 coin@1200 start@1300 scale=2` | verbatim idea; swap the board |
| `lockstep-run.mjs` | section 3.5 | verbatim idea |
| `mb88dis.mjs` | MB88 disassembler (51XX/54XX) | not needed |
| `ai-bench.mjs` | plays N games headless on the oracle or the port | later |

**Listing format** (`reference/galaga-main.asm`):

```
;; RST_10()                         <- ";;" notes from the source
rst_HLplusA:                        <- label (+ "; galagao $XXXX" if moved)
0010: 85                      add  a,l
0002: 32 00 71                ld   ($7100),a        ; [$7100: 06xx ...]
0005: C3 C4 02                jp   $02C4            ; -> CPU0_RESET {jp ...}
0100: 14 06 14 0C ...         .db   $14,$06,...     ; "text" comment
000F: FF                      .db   $FF  ; [rev B]
```

The columns are `ADDR: bytes (padded to 24) text (padded to 22) ; note`.
Notes can show `-> label` for a jump target, `[RAMNAME: comment]` for an
absolute operand, `{symbolic source}`, and `[rev B]` for bytes with no
source counterpart. Data runs are grouped 8 per line. Unplaced source items
are listed at the end.

**`symbols.json`**: `{ main: {label: {rev_b, galagao, file}}, sub, sound,
ram: {name: {addr, comment}} }`. `diffRam` names bytes from `ram`.

**Code versus data**: every placed instruction is traced through
fall-through and jump/call targets. Tracing stops at unconditional
`ret`/`jp`/`jr`/`jp (hl)`/`halt`/`rst`. Anything untraced is `.db`. The
trace mask becomes `romdata.js`'s data bitmap, minus `READ_AS_DATA`.

**For Gaplus** there is no reconstructed source, so `gen-listing` must:
trace from the 6809 vectors (`$FFFE` reset, `$FFF8` IRQ, `$FFF6` FIRQ,
`$FFFC` NMI, `$FFFA`/`$FFF4`/`$FFF2` SWI) of each CPU; take **manual seed
lists** for indirect targets (`jmp [,x]`, jump tables and task tables),
kept in a hand-edited `tools/gaplus-seeds.mjs` or `reference/*.json`; and
merge **human names and comments** from a sidecar file, with the bytes
still generated. `symbols.json` keeps the same shape, so `diffRam` works
unchanged.

---

## 8. Tests and npm scripts

```json
"test":        "node --test \"test/unit/*.test.mjs\" \"test/oracle/*.test.mjs\"",
"test:unit":   "node --test \"test/unit/*.test.mjs\"",
"test:oracle": "node --test \"test/oracle/*.test.mjs\"",
"listing":     "node tools/gen-listing.mjs",
"gen":         "gen-listing && gen-graphics && gen-sound && gen-favicon && gen-index",
"serve":       "python3 -m http.server 8000 --bind 127.0.0.1"
```

* Around 320 tests. `test/oracle/<rom-chip>.test.mjs` exists per chip,
  plus `lockstep.test.mjs`, `stage0.test.mjs` and the sound trace test.
* Unit tests cover:
  * CPU cores against the manual: `z80.test.mjs`. `z80ops.test.mjs`
    checks ALU helpers **exhaustively against the core**.
  * Generated-file freshness: `video` and `wsg`.
  * Pure-module behaviour: mux, bindings, mixer, resampler, starfield.
  * Worklet registration, by loading `wsg-worklet.js` with a fake
    `registerProcessor`.
  * The `index.html` module list.
* HLE versus LLE: `namco51-hle.test.mjs` runs the JS 51XX and the MB88
  firmware side by side over randomized sessions.
* **No headless browser test exists in galaga.** Only hooks were prepared:
  `canvas.dataset.frame`, `globalThis.galaga`, `?frames=`. The Gaplus plan
  requires `test/browser/` (Chrome via CDP over Node's built-in
  `WebSocket`); that is new work.
* `tools/shoot.mjs` gives screenshots of the real ROM
  (`screenshots/rom-1-attract.png`). `shoot-port.mjs` is referenced in a
  comment but doesn't exist; it would be worth writing for Gaplus.

---

## 9. Reuse matrix for Gaplus

### Reusable nearly verbatim

| File | Change |
|------|--------|
| `src/game/call.js` | nothing |
| `src/game/*/routines.js` | names only (`MAIN`/`SUB`/`SOUND` still fit) |
| `src/game/*/index.js` | `irq` for all three CPUs, no `nmi` |
| `src/input/mux.js`, `capture.js`, `gamepad.js`, `remapui.js` | storage key prefix `gaplus.` |
| `src/input/bindings.js` | add `up` and `down` actions and defaults (axis 1, buttons 12/13) |
| `src/audio/resample.js` | nothing |
| `src/audio/wsg-worklet.js` | processor name and mixer class |
| `tools/png.mjs`, `tools/gen-index.mjs`, `tools/serve.py` | banner text |
| `tools/romset.mjs` `readRomset()` | the loader function and the chip table |
| `test/helpers/oracle.mjs` | `callRoutine` for 6809 (sentinel via `rts`, S stack), region list, stack ranges |
| `test/helpers/lockstep.mjs`, `tools/lockstep-run.mjs` | sample line, replay PCs, `SLOW_STATE` addresses, input names |
| `test/unit/index-html.test.mjs` | nothing |
| `index.html` | title, key hints, remap rows (up and down), drop fast-fire |
| `src/main.js` | `KEY_MAP` (up/down, button 1), drop `IoBus`/51XX, hack list, global name |
| `src/video/renderer.js` structure | see below; `tilemapScan` and `rotate()` are identical |
| `tools/gen-graphics.mjs` `decodeGfx`, packing, sheets | layouts, ROM names, 3bpp sprites |

### Must be rewritten for the 6809 or Gaplus hardware

| Area | Why and what |
|------|--------------|
| `src/emu/m6809.js` | new cycle-counted MC6809E core. Exact CC flags (E F H I N Z V C), `cwai`/`sync`, IRQ/FIRQ/NMI stacking, `D` = `A:B`, DP, indexed and indirect modes, MAME cycle counts (`reference/mame/m6809/`). Unit-test it against the manual |
| `src/emu/board.js` | `GaplusBoard`, below |
| `src/machine/machine.js` | new memory map. **Big-endian** `peek16`/`poke16`/`read16` (high byte written first). ROM is at the **top** (`read(cpu,a)`: main/sub `a >= $A000`, sound `a >= $E000`). IRQ control **by address bit**, not data. Watchdog on *read* |
| `src/game/m6809ops.js` | replaces `z80ops.js`: add/adc (H flag), sub/sbc/cmp, `daa` (6809 semantics), `mul`, `neg`, `com`, `asl`/`asr`/`lsr`/`rol`/`ror`, `sex`, 16-bit `addd`/`subd`/`cmpx` flags. Test it exhaustively against the core |
| `src/game/scheduler.js` | keep the vocabulary (`SPIN`/`HALT`/`BUSY`/`CpuHang`, SPIN rounds, `fgDebt`, `mainTail`). Rewrite the timeline: **one vblank IRQ for all three CPUs**, no sound NMIs, the I/O chips run 50 us after vblank. Re-measure every constant. A `RENDEZVOUS` and slot phases only if Gaplus has the same shape |
| `src/game/io.js` | delete. Add `src/machine/namcoio.js` (56XX/58XX HLE from `namcoio.cpp`) plus the preliminary customio_3/62XX behaviour from `gaplus_m.cpp`. As hardware models, they can be **shared by the oracle and the port**, the way galaga's `test/mcu/namco54.mjs` re-exports `src/` |
| `src/audio/wsg.js` | becomes 15XX: 8 voices, new register layout, `+2` write event, 24 kHz clock, `MIX_RES = 1024`, sound enable |
| `src/audio/mixer.js`, `sound.js` | one image per frame (or a write-event list); no 54XX; a decision on the `bang` sample |
| `src/video/palette.js` + generator | Gaplus uses fixed weights `0x0e,0x1f,0x43,0x8f` (2.2k/1k/470/220) over 3 x 256 PROMs, not resnet. Chars: `0xf0 + (lut & 0x0f)`. Sprites: `lo | hi<<4` from the two 512-byte PROMs |
| `src/video/sprites.js` | **3bpp** (`RGN_FRAC(1,2)` plane plus 0 and 4). Change the packing (e.g. 4 bits per pixel) |
| `src/video/renderer.js` details | sprite registers at `+$780` in `$0800/$1000/$1800` (`$0F80`/`$1780`/`$1F80`). Code bit 8 = `ram3 & 0x40`. `sx = x + 256*(ram3+1 & 1) - 71`, `sy = 256 - y - 8`. Size bits 3 (x) and 5 (y). `0x80` duplicate. Enable = `(ram3+1 & 2) == 0`. Char code bit 8 from attr bit 7. Two tilemap passes by category (attr bit 6: sprites between). Flip from **RAM `$1F7F` bit 0** |
| `src/video/starfield.js` | Gaplus CUS26: three planes, control at `$A000-$A003`. MAME's model is marked **"The starfield is wrong"**, so treat it as display-only. It never touches RAM, so lockstep can't check it |
| `tools/gen-listing.mjs`, `m6809dis.mjs` | vector-driven trace, seed lists, sidecar names |
| routine modules | everything under `src/game/{main,sub,sound}/` |
| `namco51.js`, `mb88.js`, `namco54.js`, `n54*.js`, `mcu54rom.js`, `test/mcu/*`, `mb88dis.mjs` | drop (no MB88 MCUs on Gaplus) |

### Gaplus board in brief (from MAME `gaplus.cpp`)

| Item | Value |
|------|-------|
| CPUs | 3x MC6809E at 24.576 MHz/16 = **1.536 MHz** |
| Frame | 60.606 Hz, so **25,344 CPU cycles per frame** (MAME uses `set_refresh_hz`, not `set_raw`; line timing must be established) |
| Main map | `$0000-$07FF` tile RAM, `$0800-$1FFF` shared RAM (sprite regs in the top `$80` of each 2 KB bank), `$6000-$63FF` 15XX, `$6800-$680F` I/O 1, `$6810-$681F` I/O 2, `$6820-$682F` customio_3, `$7000-$7FFF` W IRQ enable (A11 = 0 enables), `$7800-$7FFF` R watchdog, `$8000`/`$8800` W sub+sound release/hold + sound enable, `$9000`/`$9800` W I/O chips release/hold, `$A000-$A003` W starfield, `$A000-$FFFF` ROM |
| Sub map | same RAM; `$6000-$6FFF` W IRQ enable = A0 (`$6001` on, `$6080` off, `$6081` on); ROM `$A000-$FFFF` |
| Sound map | `$0000-$03FF` 15XX; `$2000-$3FFF` watchdog; `$4000-$7FFF` W IRQ enable (A13 = 0 enables); ROM `$E000-$FFFF` |
| IRQs | vblank asserts all three (level); cleared by the disable write. MAME `set_maximum_quantum(1/6000 s)`, about 256 cycles |
| Inputs | 8-way stick, 1 button, start 1/2, coin 1/2, service; DIPs through the 58XX; cabinet and test through customio_3 |

---

## 10. Lessons and gotchas, with likely Gaplus analogues

| Galaga lesson | Where recorded | Gaplus analogue |
|---------------|----------------|-----------------|
| **RNG reads the Z80 `R` register**, a count of instructions. The browser uses `nextR()`; the tests replay the oracle's values | `machine.js readR`, `lockstep.mjs` | **The 6809 has no R register.** How Gaplus gets randomness is **unknown yet**. Look for: (a) a pure software PRNG in RAM, which is deterministic and needs no replay; (b) a counter bumped in a **foreground idle loop** while it waits for vblank, which is cycle-dependent like R; (c) reads of I/O or watchdog values; (d) the frame counter. For (b) or (c), apply the same fix: `m.readX()` hook, record at the reading PC via `onExec`, replay in lockstep, plain PRNG in the browser |
| **Code read as data** (the RNG noise table is the task manager's code; tables overrun into code) | `gen-listing.mjs READ_AS_DATA` | expect the same. Any `romByte` throw during testing is a lead: add the range with a comment |
| **CPU races after the rendezvous**: whether an enemy launched this frame moves this frame depends on a 19-cycle margin | README, `scheduler.js` phases | three CPUs again. Expect a residual 2-3% of frames with a one-frame blip; tune the order with `lockstep-run` |
| **Order at the rendezvous**: the sprite copy must see last frame's positions (sub must not move first) | `RENDEZVOUS` | find where Gaplus copies sprite registers. The layout at `+$780` suggests Galaga-like double buffering |
| **Handler longer than a frame loses the next IRQ** (playfield clear from inside the handler): game over was 2 frames early until modelled | `charge()`, `mainTail`, `fgDebt` | MAME 6809 IRQs are level-triggered and cleared by the disable write. The same loss happens if the handler keeps IRQs disabled past vblank. At 25,344 cycles per frame and a slow 6809, **long handlers are likelier**. Measure with `callRoutine(...).cycles` |
| **Busy loops must yield once per frame the CPU spends in them**, measured, with the clock synced before each write | `gg1_4_post.js` | the 6809 POST and RAM tests. The note says `gaplus` *skips* the Namco RAM test and uses I/O chip 1 in coin mode. Use 6809 cycle counts |
| **Cross-CPU boot handshakes** need `yield SPIN` | `gg1_5.js`, `gg1_7.js` | same pattern (checksum handshakes through shared RAM) |
| **Jumps out of an IRQ handler** (to the RAM test, `rst $00`) | `gg1_1_state.js` WeakMap | 6809 code may `lds #...` / `jmp` out of a handler; same driver trick |
| **Endless loops in ROM** (stage 256): throw `CpuHang` after the settled writes | `stage0.test.mjs` | same |
| **Faithful bugs**: an enemy clone copies state into ROM (no effect), and the port does the same on purpose | README | preserve every bug and comment it |
| **Oracle sampled mid-handler** gives short benign diffs; resync only after 3 frames | `lockstep-run.mjs` | pick the sample point where all three handlers and the namcoio run have finished |
| **Latches aren't resynced** (they could catch an enable mid-handler) | `lockstep.mjs resync` | same for the IRQ masks, SRESET/FRESET and the I/O chip state |
| **Stacks aren't compared** | `STACK_RANGES` | 6809 S (and any U stacks) live in shared RAM. Find the `lds`/`ldu` values, and exclude those ranges plus the test stack |
| **The browser cache serves stale modules** | `index.html`, `serve.py` | reuse both, and the test |
| **Gamepads rest off-centre**; triggers rest at -1 | `bindings.js` | reuse; add vertical axes |
| **Audio needs a user gesture**; gamepad input doesn't count | `gamepad.js`, `main.js` | same |
| **The renderer is shared with the oracle**, so a screenshot of the real ROM validates the renderer | `shoot.mjs` | same, as early as possible |
| **Timing constants are measured, never guessed**, with the number and method in the comment | everywhere | same |

6809-specific traps to plan for:

* `clr mem` and other read-modify-write instructions perform a **read
  first** on the MC6809E, and reads can have side effects (the watchdog at
  `$7800`, possibly I/O chips).
* IRQ enable is decoded from **address lines** (A11, A0, A13), so a write
  to `$7400` or `$7C00` is still decoded (MAME notes that A10 is ignored).
  Startup writes to `$7820-$782F` hit the IRQ range, not I/O.
* `RTI` restores CC from the stack. A handler that edits the stacked CC
  changes the returned I flag, so don't hard-code the Z80 "ei on return"
  in `leaveIrq` without checking.
* `cwai` stacks the whole state *before* the interrupt arrives. `sync`
  waits for an edge. Map both to `HALT` or `yield` deliberately.
* The DP register makes `lda <$12` mean `$DP12`. The port always writes
  full addresses; the listing should show them resolved.
* `pshs`/`puls` of registers used as temporaries touch the stack only,
  which is exempt. Pushes of PC or CC from `jsr`/`swi` are also exempt.
* Big-endian words everywhere: ROM pointers and tables must be read with
  `romWord` as **high byte first**.

---

## 11. Suggested bring-up order (as galaga's history implies)

1. `tools/romset.mjs` with `loadGaplus()` (check CRCs), `png.mjs`.
2. `m6809` core, then its unit tests, then `m6809dis.mjs`.
3. `GaplusBoard` (memory map, IRQ latches, namcoio, 15XX RAM, frame
   events). Boot the real ROM and watch the watchdog stay quiet.
4. Graphics generators, renderer and `tools/shoot.mjs`. Screenshots of the
   real ROM confirm the board and the renderer together.
5. `gen-listing.mjs` (trace plus seeds), `romdata.js`, `symbols.json`.
6. `docs/hardware.md`, `docs/porting-guide.md` (Gaplus edition: 6809
   calling convention `{a, b, d, x, y, u}` in, `{..., cf, zf, nf, vf}`
   out).
7. `machine.js`, `m6809ops.js`, scheduler skeleton, registries, lockstep
   harness. **Build the lockstep test before most of the routines**, so
   the first diverging frame is always known.
8. Port the chips in parallel with `oracleStub` tests. Then tune the
   scheduler order with `lockstep-run`.
9. Audio (15XX), the page, input, the headless Chrome smoke test.

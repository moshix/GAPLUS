# Porting guide: how the Gaplus ROMs become JavaScript

Copyright 2026 by Moshix

This is the contract every module of the port follows. It exists so several
people (or agents) can port different parts of the three 6809 programs at
once and the parts still fit. Read `docs/PLAN.md` (the rules),
`docs/hardware.md` (the board) and `docs/galaga-method.md` (why it is done
this way) first.

## 0. The goal

The browser game is the 1984 program **re-implemented routine by routine
in JavaScript**, not emulated. Every routine of the three MC6809 programs
gets a JS function that does the same thing to the same memory. Game state
lives at the addresses the original used, in `Machine.mem`
(`src/machine/machine.js`), so a test can run the real ROM on the emulated
board (`test/m6809/`) next to the port and require that **every byte of RAM
matches**.

Fidelity is the whole point. "Plays about the same" is a failure. The bar
is "the RAM is identical after 10,000 frames".

## 1. Sources of truth, in order

1. **`reference/gaplus-main.asm`, `gaplus-sub.asm`, `gaplus-sound.asm`**:
   listings generated from the ROMs by the listing tool (another agent is
   writing it). Every byte in them is real. Labels and comments come from a
   hand-edited sidecar file, merged into the listing. **The bytes win over
   any comment.** If a comment and the code disagree, the code is right.
2. **`reference/symbols.json`**: every label with its address per CPU
   (`main`, `sub`, `sound`) and every named RAM variable (`ram`), in the
   same shape as Galaga's, so `diffRam` names bytes the same way.
3. **`docs/hardware.md`**: the board (memory maps, latches, I/O chips,
   timing). Where it says **[ROM]**, it was checked against the code.
4. `reference/mame/namco/gaplus*.cpp`, `namcoio.cpp`: the hardware as
   MAME models it. MAME is the reference the oracle reproduces.
5. `tools/m6809dis.mjs`: until the listings exist, disassemble a range
   with `node tools/m6809dis.mjs --dp 10 --from C000 --to C0FF
   roms/gp2-3b.8c@C000`. Beware: a linear sweep also "decodes" data.

## 2. Where code lives

Three CPUs, seven program ROMs. One module per ROM chip. A routine
belongs to the chip that holds its **entry address**.

| CPU   | ROM chip   | range         | module                        |
|-------|------------|---------------|-------------------------------|
| main  | gp2-4.8d   | `$A000-$BFFF` | `src/game/main/gp2_4.js`      |
| main  | gp2-3b.8c  | `$C000-$DFFF` | `src/game/main/gp2_3b.js`     |
| main  | gp2-2b.8b  | `$E000-$FFFF` | `src/game/main/gp2_2b.js`     |
| sub   | gp2-8.11d  | `$A000-$BFFF` | `src/game/sub/gp2_8.js`       |
| sub   | gp2-7.11c  | `$C000-$DFFF` | `src/game/sub/gp2_7.js`       |
| sub   | gp2-6.11b  | `$E000-$FFFF` | `src/game/sub/gp2_6.js`       |
| sound | gp2-1.4b   | `$E000-$FFFF` | `src/game/sound/gp2_1.js`     |

A module that grows too large splits into helper files named
`gp2_3b_<topic>.js` (e.g. `gp2_3b_irq.js`). The file named in the table
still registers everything in its range. Each CPU also has `index.js`,
which imports every chip module of that CPU and exports the entry points
the scheduler drives (reset foreground, IRQ handler).

Shared infrastructure (don't reimplement any of it):

| file                          | what                                       |
|-------------------------------|--------------------------------------------|
| `src/machine/machine.js`      | memory, CPU views, latches, IRQ lines      |
| `src/machine/namcoio.js`      | 56XX / 58XX / 62XX (shared with the oracle)|
| `src/game/romdata.js`         | ROM bytes at ROM addresses (GENERATED)     |
| `src/game/m6809ops.js`        | exact 6809 ALU and flag helpers            |
| `src/game/call.js`            | `call()` for generator-agnostic calls      |
| `src/game/*/routines.js`      | the registries (below)                     |

## 3. Names, registries, renames

### 3.1 Names

* **A routine's JS name is its label in the listing**, exactly.
* Until the annotated listing gives it a name, a routine is **`sub_XXXX`**:
  its entry address in **upper-case hex**, four digits (`sub_C2FC`). A
  routine reached by `jmp` rather than `jsr` (a state of a state machine,
  a jump-table target) uses the same form. The address is the routine's
  identity. The name is only a label for it.
* JSDoc on every routine: `@see gaplus-main.asm $C2FC`, what it does, its
  register inputs and outputs, and any RAM it relies on.
* RAM addresses in code are written as hex literals with the
  `symbols.json` name in a comment when one exists:
  `m.poke(0x102f, 0) // game_state`.

### 3.2 Registries

Each CPU has a leaf module with no imports:

```js
// src/game/main/routines.js (also sub/routines.js, sound/routines.js)
export const MAIN = {};     // name    -> function
export const MAIN_AT = {};  // address -> function
export function mainAt(addr) { /* throws if missing */ }
```

(`SUB`, `SUB_AT`, `subAt`; `SOUND`, `SOUND_AT`, `soundAt`.) Each chip module
registers everything it defines when it loads:

```js
import { MAIN, MAIN_AT } from './routines.js';
Object.assign(MAIN, { sub_C2FC, sub_D07A });
Object.assign(MAIN_AT, { 0xc2fc: sub_C2FC, 0xd07a: sub_D07A });
```

It calls routines in other modules only through the registry:
`MAIN.sub_D07A(m, { x })`. It never imports another chip module
directly. That way modules can be written in parallel, and a routine that
doesn't exist yet fails only when it is called, not when the file is
imported.

**`*_AT` must contain every routine reached indirectly**: through a jump
table (`jmp [b,u]` at main `$FEBE`, sub `$E0F7`), a pointer held in RAM or
ROM data, or a vector. Dispatchers look the address up there, the way the
6809 would, reading the table from ROM with `romWord` (big-endian):

```js
// $FEB5: ldu #$FEC0 / ldd <$2F / asla / ldu a,u / aslb / jmp [b,u]
const state = m.peek(0x102f);
const sub = m.peek(0x1030);
// a,u and b,u are SIGNED 8-bit offsets; asla/aslb are 8-bit shifts
const table = m.read16('main', disp8(0xfec0, state << 1));
yield* call(mainAt(m.read16('main', disp8(table, sub << 1))), m, {});
```

(`disp8` from `m6809ops.js` sign-extends the offset. When the index is
always small this changes nothing, but keep it: the port must also be
exact in the cases that never happen.)

### 3.3 Renames

The annotated listing gives routines names over time. A rename is always
done **by one agent in one sweep**, never piecemeal:

1. The name goes into the listing sidecar; regenerate the listing and
   `symbols.json`.
2. Replace the identifier everywhere, whole-word:
   `grep -rlw sub_C2FC src test | xargs sed -i '' 's/\bsub_C2FC\b/init_62xx/g'`
   (the function, its registry keys, every `MAIN.sub_C2FC` call).
3. `node --test` must pass.

Tests look routines up **by address** (`mainAt(0xc2fc)`) and so survive
renames. The `@see ... $C2FC` JSDoc keeps the address searchable. No
aliases: at any time a routine has exactly one name.

## 4. Calling convention

* Every routine takes the machine first: **`(m, regs)`**. `m` is always
  the `Machine`, whichever CPU the routine belongs to (see section 5 for
  how each CPU reaches memory).
* **Register inputs arrive as one object** holding the 6809 registers the
  routine **reads before writing**: `{ a, b, d, x, y, u }`.
  * Use `d` when the routine treats A:B as one 16-bit value (`addd`,
    `std`, `cmpd`, `ldx d,...`), and `a`/`b` when it uses the halves. If
    it uses both, pass both and keep them consistent (`d === a << 8 | b`,
    see `dOf`/`hi`/`lo` in `m6809ops.js`).
  * `dp` is never passed: DP is fixed per CPU (section 5.4).
  * `cc` (the whole byte) only when the routine reads a flag it did not
    set (a carry passed in from the caller, e.g. `rola` first thing). Pass
    it as `cf` if only the carry matters.
* **Register and flag outputs are returned as one object** with what
  **any caller consumes afterwards**: `return { a, x, cf, zf }`. The flags
  are `cf` (carry), `zf` (zero), `nf` (negative), `vf` (overflow), plus
  `hf` (half carry) or `cc` (the full byte) in the rare case a caller
  needs them. Read the callers in the listing to see what they use, and
  return everything any of them reads. If nothing is consumed, return
  nothing. A comment names the instruction that produced each returned
  flag when it is not the last one.
* Registers that the routine saves and restores (`pshs x,y / ... / puls
  x,y,pc`) are not outputs: the caller's JS locals are unchanged anyway.
* **Inline arguments** (`jsr sub_XXXX` followed by data bytes that the
  callee reads through the return address, `ldx ,s` ... `stx ,s`): pass
  the address of the data as `{ pc }`. The routine returns `{ pc }`, the
  address where the caller resumes, and the caller continues at that
  (known) address.
* **Non-local exits** (a routine that discards its return address with
  `leas 2,s` / `puls` and jumps elsewhere, or `lds #...; jmp ...`): the
  routine sets a flag in a per-machine `WeakMap` in a `*_state.js` helper
  of its module and returns. The foreground driver calls `.return()` on
  the running generator and starts the new entry point. Galaga's
  `gg1_1_state.js` is the model. Example: the main IRQ handler's
  `lbne $B6F6` at `$C016` jumps into the service-mode reset, which
  reloads S.
* Internal helpers private to one module may use any signature.

Use `m6809ops.js` for anything flag-exact:

```js
// (illustrative addresses)
import { add8, daa, rol8, cmp16, cond } from '../m6809ops.js';
// $D123: adda $1002 / daa / sta $1002 -- BCD score digit
let r = add8(a, m.peek(0x1002));
r = daa(r.v, r.cc);
m.poke(0x1002, r.v);
// $D130: rol <$40 -- the carry from the daa goes into bit 0
const t = rol8(m.peek(0x1040), r.cc);
m.poke(0x1040, t.v);
// $D140: cmpx #$1860 / bge $D150 -- signed compare
if (cond(cmp16(x, 0x1860).cc, 'ge')) { /* ... */ }
```

Each helper takes the current CC byte (for the carry in, H, and the bits
it leaves alone) and returns `{ v, cc, cf, zf, nf, vf, hf }`.

## 5. Memory

### 5.1 One array, main-CPU addresses, three views

All RAM is `m.mem`, a 64 KB array **in main-CPU address space**:

| `mem` index     | RAM                   | main          | sub           | sound          |
|-----------------|-----------------------|---------------|---------------|----------------|
| `$0000-$07FF`   | tile codes/attributes | `$0000-$07FF` | `$0000-$07FF` | -              |
| `$0800-$1FFF`   | work + sprite RAM     | `$0800-$1FFF` | `$0800-$1FFF` | -              |
| `$6000-$603F`   | 15XX sound registers  | `$6000-$603F` | -             | `$0000-$003F`  |
| `$6040-$63FF`   | main/sound shared RAM | `$6040-$63FF` | -             | `$0040-$03FF`  |

Each CPU reaches memory through **its own view**, using the addresses of
its own listing:

| CPU   | read / write                  | 16-bit (big-endian)             |
|-------|-------------------------------|---------------------------------|
| main  | `m.peek(a)`, `m.poke(a, v)`   | `m.peek16(a)`, `m.poke16(a, v)` |
| sub   | `m.sub.peek(a)`, `m.sub.poke` | `m.sub.peek16`, `m.sub.poke16`  |
| sound | `m.sound.peek(a)`, `m.sound.poke` | `m.sound.peek16`, `m.sound.poke16` |

Start a sub or sound routine with `const s = m.sub;` (or `m.sound`) and use
`s.peek`/`s.poke` throughout. **Never use the main view from sound code**:
sound `$0040` is `mem[$6040]`, while main `$0040` is tile RAM. Never
use it from sub code either: sub `$6080` is the sub's IRQ latch, while
main `$6080` is sound RAM. Each view decodes addresses exactly as that
CPU's bus does, with every side effect (docs/hardware.md section 3).

Each view also has `read(a)` / `read16(a)` (a pointer that may point into
ROM), `fill(a, v, n)`, `copy(dst, src, n)` (byte by byte, so overlapping
copies smear as on the CPU), `sei()` / `cli()` and `charge(cycles)`. On
the Machine itself, `m.read(cpu, a)` and `m.read16(cpu, a)` do the same
for any CPU (`cpu` is `'main' | 'sub' | 'sound'`).

### 5.2 Rules

* **Write every byte the CPU writes, in the same order**, including
  temporaries, scratch variables and **writes to I/O, latch and unmapped
  addresses**. The boot's `$0000` stores to `$7820-$782F` disable the main
  IRQ; the sub's 256 writes to `$500F` do nothing but still count. RAM is
  compared byte for byte, and latches are compared too.
* **16-bit stores are big-endian, high byte first**: `std $1234` is
  `m.poke16(0x1234, d)` and writes A to `$1234`, then B to `$1235`. Loads
  (`ldd`, `ldx`) are `peek16`.
* **Read-modify-write instructions read first** on the MC6809E: `clr`,
  `inc`, `dec`, `com`, `neg`, `asl`, `lsr`, `rol`, `ror`, `asr` and `tst` on
  memory all read their operand. The read matters only where reading has an
  effect: main `$7800-$7FFF` and sound `$2000-$3FFF` (the watchdog). So
  `clr $7C00` is `m.peek(0x7c00); m.poke(0x7c00, 0);`. `lda $7C00` in the
  IRQ handler is a real watchdog kick: port it as `m.peek(0x7c00)`.
* **Keep 6809 arithmetic exact**: 8-bit results wrap (`& 0xff`) and 16-bit
  ones too (`& 0xffff`). Indexed offsets are signed (`disp8`), and
  `abx` adds B unsigned. `daa` follows MAME, a carry is threaded into the
  next instruction, and a flag left over from an earlier instruction is
  reproduced on purpose, with a comment saying so.
* **ROM data is read at its ROM address** through `romdata.js`
  (`mainRom`, `subRom`, `soundRom`, `mainWord`, ...; words big-endian), or
  through `read(cpu, a)` when a pointer may be ROM or RAM. Never copy a
  table into a JS array by hand. RAM holds ROM pointers, so the addresses
  must be real. For now every ROM byte is readable. Once the listing has
  separated code from data, reading a code byte throws. Code that the game
  also reads as data (checksums, noise) must then be whitelisted in the
  listing tool, with a comment.
* **I/O chips are memory**: the game code pokes commands and peeks
  results at `$6800-$682F` exactly as the ROM does
  (`m.poke(0x6808, 4)`, `m.peek(0x6800) & 0x0f`). The chips' once-per-frame
  run is the scheduler's job (`m.vblank()`, then `m.ioUpdate()` 50 us
  later). Game code never calls them.

### 5.3 The stacks are exempt

The port has no stack: `pshs`/`puls`, `jsr`/`bsr`/`rts`, interrupt entry,
`rti` and `cwai` all become JS locals and calls. **Only the S stacks are
exempt** from RAM comparison. Their locations come from the ROMs' `LDS`
instructions. The lowest S was measured on the oracle board
(`tools/coverage.mjs`, `board.trackStack`) over ~78,000 frames: 20,000
of attract, 1P and 2P games to game over, the challenging stage, PARSEC
11, a high-score entry, the service mode and the operator-stats DIP
(docs/oracle-notes.md):

| CPU   | `LDS` (ROM)                     | S top   | lowest S | exempt (`mem`)  |
|-------|---------------------------------|---------|----------|-----------------|
| main  | `$E00F`, `$B705`, `$D152`       | `$1600` | `$15E2`  | `$15E2-$15FF`   |
| sub   | `$E006`, `$E181`                | `$1D80` | `$1D74`  | `$1D74-$1D7F`   |
| sound | `$E047`                         | `$0400` | `$03EC`  | `$63EC-$63FF`   |

(`STACKS` in `machine.js`; `test/oracle/board.test.mjs` checks them.
Main reaches `$15E2` when the vblank IRQ lands inside `$D07A`'s calls at
game start; an earlier, shorter measurement had `$15E4`. Widen a range only after checking the listing that no
variable lives there.) **No code path executes `pshu`/`pulu`**, so U is
only ever a pointer, and every store through U is a real RAM write that
must be ported. Any byte below "lowest S" that the port does not write is
a bug, not stack.

### 5.4 The direct page

`lda <$2F` means `$DP2F`. DP is fixed per CPU, so the port always writes
the full address:

| CPU   | DP    | `tfr a,dp` at [ROM]       | `<$2F` is |
|-------|-------|---------------------------|-----------|
| main  | `$10` | `$E00D`, `$B703`          | `$102F`   |
| sub   | `$10` | `$E004`                   | `$102F`   |
| sound | `$00` | never set (reset value)   | `$002F`   |

Main and sub use the **same** direct page in shared RAM: the sub reads
the main's state variables at `$102F` and `$1030`. If a routine is ever
found that changes DP, stop and flag it: this table then needs a new row.

## 6. Interrupts, CWAI, generators

### 6.1 The frame

One vblank IRQ per frame for all three CPUs, at the same instant (MAME
order: main line, arm the I/O runs, sub line, sound line). The line is
level-triggered and is raised only if that CPU's mask latch is set. It
stays up until the handler writes the mask-off latch. There is no pending
latch: a vblank that finds the mask off is lost. The I/O chips run 50 us
(76.8 cycles) after vblank. A frame is 25,344 cycles of each CPU.

| CPU   | handler | acknowledge (entry)                 | re-enable (end)        |
|-------|---------|-------------------------------------|------------------------|
| main  | `$C000` | `lda $7C00` (watchdog) / `sta $7C00` | `sta $7400` at `$C031` |
| sub   | `$E061` | `sta $6080`                         | `sta $6081` / `rti` at `$E0E8` |
| sound | `$E055` | `sta $6000` / `sta $3000` (watchdog) | `sta $4000`           |

The scheduler (`src/game/scheduler.js`, written separately) owns the
order in which the three CPUs' work runs within the port's frame, and
calls `m.vblank()` / `m.ioUpdate()`. It hooks `m.hooks.onCli` so that an
`andcc #$EF` in foreground code (`m.cli()`) takes a pending IRQ right
there, as the 6809 does.

**Where `m.ioUpdate()` goes.** Call it right after `m.vblank()` and
**before** the main IRQ handler runs. In MAME the 56XX/58XX run lands at
cycle 76.8 of the handler; the handler's I/O reads that can see a change
are `ldd $6800` at `$C01A` (cycles 79-80) and `lda $6802` at `$C055`
(later), both after the run, so "update first" reproduces MAME. Calling it
after the (atomic) ported handler would credit every coin one frame late
(`$6056`, the credit display). The reads before cycle 77 are 58XX DIP
nibbles that never change during play. **Known exception**: with SW1:6 ON
the operator-stats path reads `$6805` at `$FCE8` around cycle 50, before
the run; the port either accepts that divergence or runs the update from
inside the handler between `$C011` and `$C01A`. (The oracle delivers the
run at the exact cycle: `Board.ioCatchUp`.)

**Measured timing** (oracle, docs/oracle-notes.md): every handler starts
within 8 cycles of vblank; main and sub end together at their
`frame_sync` rendezvous (`$C158` / `$E0E2`), cycle 4,918-5,746 (main
~10,600 on the frame a coin or start leaves attract); sound 1,225-8,243.
The rendezvous cycle depends on the CPU interleave. In attract mode the
foreground `attract_loop` (`$C417`) is a busy loop adding `$20` to
`attract_timer` (`$1029`) per pass (2-3 passes a frame), so attract
timing depends on it. In play, the main foreground copies positions the
sub is updating in the same part of the frame (e.g. `$D434`), a race whose
outcome follows MAME's slice order. See docs/oracle-notes.md section 3.

### 6.2 Interrupt handlers

* **Handlers and the routines they call are plain functions** that run to
  completion, or generators that `yield` only progress markers, if the
  scheduler needs to interleave two handlers (as Galaga's slot numbers).
* The 6809 sets CC.I on IRQ entry and `rti` restores the stacked CC. A
  handler that changes the **stacked** CC (to return with different
  flags or with IRQs masked) must say so explicitly. Check `rti` paths,
  and never assume "IRQs enabled on return".
* Porting the acknowledge and re-enable writes is not optional: they are
  latch writes (section 5.2), and the scheduler reads the masks.

### 6.3 Foreground code is a generator

* **The foreground (reset) thread of each CPU is a generator.** Where the
  6809 waits for something only an interrupt can change, the port
  `yield`s once per iteration:

  ```js
  // $E0C7: lda $6040 / ldy $7C00 / cmpa #$22 / bne $E0C7
  // (ldy reads $7C00 and $7C01: two watchdog kicks per pass)
  while (m.peek(0x6040) !== 0x22) { m.peek16(0x7c00); yield SPIN; }
  ```

  Use `yield SPIN` (from `scheduler.js`) instead of a bare `yield` when the
  loop waits on **another CPU's foreground** (the `$11`/`$22` boot
  handshakes through `$0800` and `$6040`), so that the wait resolves
  within the frame. Note that the loop above still performs its watchdog
  read each time around.
* **`cwai #$EF` waits for the next IRQ**: the 6809 stacks its entire state,
  clears I and sleeps, the handler runs, and `rti` resumes after the
  `cwai`. In the port that is exactly one `yield`, at the point of the
  `cwai`, with a comment: `// $C318: cwai #$EF -- wait for vblank`.
* **The main loops restart after every frame.** Main `$D150` is
  `cwai #$EF / lds #$1600 / clr <$30 / jmp $FEB5`, and sub `$E17F` is
  `cwai #$EF / lds #$1D80 / jmp $E0EC`. After each IRQ, the foreground
  throws its stack away and dispatches again from the state variables
  (`<$2F`/`<$30`, sub `<$2F`/`<$7A`) through two-level jump tables. So the
  dispatcher is a loop: `for (;;) { yield; /* $D152 ... dispatch */ }`.
  No JS local may survive the `cwai`, because the 6809's registers don't.
* **The sound CPU has no foreground work**: after initialisation it runs
  `bra *` at `$E053` forever, and everything happens in its IRQ handler.
  Its foreground generator ends in `for (;;) yield;`.
* **Calling a routine from foreground code**: if it might wait (anywhere
  down its call tree), it must be a generator called with `yield*`. When
  calling a routine owned by another module, always use the helper, which
  works whether or not the callee is a generator:

  ```js
  import { call } from '../call.js';
  const out = yield* call(MAIN.sub_C2FC, m, { a });
  ```
* `orcc #$10` / `andcc #$EF` in foreground code: `m.sei()` / `m.cli()`
  (sub and sound: `m.sub.cli()`, ...). `cli()` can run a pending IRQ
  handler before it returns, as on the 6809.
* `sync` is not used on the paths inspected. If you find one, stop and
  flag it.
* **Busy loops that burn time** without waiting on anything (delays,
  checksum loops, the boot's RAM clear with its watchdog reads) must
  `yield` once for every 25,344 cycles the real CPU spends in them. Count
  the cycles from the MAME cycle table (the oracle's `callRoutine` returns
  `cycles`), keep a running cycle clock, and yield **before** the next
  observable write that falls in a new frame. Comment the numbers.
* Long interrupt handlers: if a handler can run past the next vblank with
  its mask still off, that vblank is lost. Measure the handler's cycles on
  the oracle and report it to the scheduler with `m.charge(cycles)`
  (`m.sub.charge`, ...), with the measurement in a comment.

## 7. The custom chips, from the game's side

* `$6800-$680F` is the **56XX** (coins, credits, sticks, buttons). The
  game uses modes 8 (boot check), 1 (switches), 2 (coinage) and **4 (coin
  mode, all of gameplay)**. In mode 4, nibbles 0-1 are credits in BCD, 2
  and 3 are the add/sub handshakes (the CPU clears them), 4 and 6 are the
  sticks, 5 and 7 are the buttons (held and edge bits), and the CPU writes
  0 to nibble 9 to let the start buttons take credits.
* `$6810-$681F` is the **58XX** (DIP switches), modes 5 (boot check) and
  4. `$6811` b2-3 lives, `$6814` b3 service mode, and so on
  (hardware.md section 5.3).
* `$6820-$682F` is the **62XX** as MAME fakes it: 8-bit RAM, fixed reads
  at offsets 1-3 depending on `$6828`, and a write of `$0F` or more to
  `$6829` starts the explosion sample. The port just performs the writes.
* All reads return `$F0 | nibble` on the 56XX/58XX: the ROM masks with
  `anda #$0F` where it cares, and so must the port. It must not "clean
  up" the value where the ROM doesn't.

## 8. Testing

Every chip module ships tests in `test/oracle/<cpu>-<chip>.test.mjs`
(e.g. `main-gp2_3b.test.mjs`). They run the real ROM routine on the oracle
and the JS routine on the port from the same state, and compare:

```js
import { makeOracle, callRoutine, loadState, diffRam } from '../helpers/oracle.mjs';
import { Machine } from '../../src/machine/machine.js';
import '../../src/game/main/index.js';          // registers every routine
import { mainAt } from '../../src/game/main/routines.js';

const board = makeOracle();
const m = new Machine();
// ... identical seeded state in both (loadState(board, m))
// (callRoutine's exact shape is set by test/helpers/oracle.mjs)
const regs = callRoutine(board, 'main', 0xd07a, { x: 0x1860, a: 5 });
const out = mainAt(0xd07a)(m, { x: 0x1860, a: 5 });
assert.deepEqual(diffRam(board, m), []);        // RAM minus the stacks
assert.equal(out.a, regs.a);
```

* **Many states, every branch**: seeded random RAM plus a setup per
  branch. A test that only covers the happy path proves little.
* Compare what the routine returns (registers, flags) against the
  oracle's registers after the `rts`, for every output in the contract.
* Compare **latches and I/O chip state** too when the routine touches
  them: `m.irqMask`, `m.sreset`, `m.io.getState()` against the oracle's.
* **Generators**: step the oracle with a `tick` that stands in for what
  the IRQ would change, applied at each backward jump of the listed poll
  loop (or each `cwai`). Apply the same tick at each `yield` of the port.
  **The tick counts must match**: the test checks *how many frames a
  routine waits*.
* **Isolation**: replace routines from *other* modules with
  `oracleStub(addr)` (run the real ROM routine on a scratch board over the
  port's RAM), so each module's tests depend only on that module.
* A **registration test** per CPU: every routine in `*_AT`, and every
  jump-table target (read from ROM with `romWord`) registered.
* The lockstep test (all RAM after every frame, from power-on) is the
  final judge. A routine test passing is necessary, not sufficient.
* Pure helpers get unit tests in `test/unit/`. `node --test` must pass
  before any work is reported done.

## 9. Style

* First line of every source file: `// Copyright 2026 by Moshix`. JSDoc on
  every export.
* **Explain complex logic with comments.** Quote the 6809 instruction
  whenever the JS is not obvious:
  `// $C04A: anda #$01 / beq $C041 -- only odd entries`.
* No TypeScript `any` in JSDoc. Plain ES modules, no dependencies, no build
  step. Node >= 20 for the tests.
* Format only the lines you touch.
* Anything printed to a console stays within **79 columns**.
* **Preserve every bug** of the original, and comment it as deliberate.

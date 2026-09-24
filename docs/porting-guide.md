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
board (`src/emu/`) next to the port and require that **every byte of RAM
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
  must be real. Reading a code byte (an instruction byte in the listing
  trace) throws. Code the game genuinely reads as data is whitelisted,
  with its reader and reason, in `tools/gen-romdata.mjs` `READ_AS_DATA`
  (the sub noise at $DF80-$E07F, the boss bonus overrun, ...). The
  whole-ROM loops (checksums, the service RAM test's pattern) are
  `SWEEPS`: their port wraps each read in `romSweep(cpu, fn)`. Oracle
  tests that run routines from random RAM may call `allowCodeReads(true)`;
  the port never does.
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
11, a high-score entry, the service mode and the operator-stats DIP,
then over 128 games with Round Advance to every PARSEC from 1 to 64
(docs/oracle-notes.md section 7):

| CPU   | `LDS` (ROM)                     | S top   | lowest S | exempt (`mem`)  |
|-------|---------------------------------|---------|----------|-----------------|
| main  | `$E00F`, `$B705`, `$D152`       | `$1600` | `$15E2`  | `$15E2-$15FF`   |
| sub   | `$E006`, `$E181`                | `$1D80` | `$1D70`  | `$1D70-$1D7F`   |
| sound | `$E047`                         | `$0400` | `$03EB`  | `$63EB-$63FF`   |

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

The scheduler (`src/game/scheduler.js`) owns the order in which the three
CPUs' work runs, and calls `m.vblank()` / `m.ioUpdate()`. It runs MAME's
model: slices of at most 256 cycles, cut at the vblank and at the I/O
run, main then sub then sound within each slice, a line-changing write
(an IRQ mask off, SRESET) ending the writer's slice (see its header and
section 6.4). A ported CPU's code runs in *chunks* (the code between two
yields); a chunk is atomic and happens at the CPU time where it starts.

**The 56XX/58XX run** lands at vblank + 76.8 cycles, as in MAME: the
scheduler delivers it before the first main-CPU access to `$6800-$681F`
at or after that instant (the charged cycles give the time of the
instruction; its access is 4 cycles in for extended addressing), else
at the end of that slice. Code does nothing for it: it just charges its
cycles (6.4), except where the access is not an extended instruction's
5th cycle: `LDA ,U` (cycle index 3), `,U+`/`,X+` (5), the second byte
of `LDD`/`STD` (5), `CLR` (6). Those use `timing.js` `ioRead` /
`ioStore`, which state the cycle; the 62XX bang trigger (`$6829`) does
too, so the port reports it at the ROM engine's cycle. Handlers read
`$6816` at cycle 41,
`$6805` at ~50 (SW1:6 on), `$6814` at 67, `$6800/$6801` at 79/80.

**Measured timing** (oracle, docs/oracle-notes.md): every handler starts
within 8 cycles of vblank; main and sub end together at their
`frame_sync` rendezvous (`$C158` / `$E0E2`), cycle 4,918-5,746 (main
~10,600 on the frame a coin or start leaves attract); sound 1,225-8,243.
In attract mode the foreground `attract_loop` (`$C417`) is a busy loop
adding `$20` to `attract_timer` (`$1029`) per pass (2-3 passes a
frame); in play, the main foreground copies positions the sub is
updating (`$D434`). Both are races through shared RAM whose outcome
follows the slices: section 6.4 is what makes the port win them as the
board does.

### 6.2 Interrupt handlers

* **Handlers are generators** (or plain functions when they neither
  poll nor touch RAM another CPU uses during the handler). They charge
  every instruction and yield SYNC before shared accesses like any code
  (6.4); the main and sub handlers meet at `frame_sync` with
  `poll()`. The IRQ entry (19 cycles, 4 from a CWAI) is the scheduler's;
  the RTI (15, entire state) is the handler's.
* The 6809 sets CC.I on IRQ entry and `rti` restores the stacked CC. A
  handler that leaves through a jump instead of `rti` (main `$C016`,
  `$C0A8`) records it with `requestJump` (src/game/main/jump.js) and
  returns; main/index.js then returns `NO_RTI` to the scheduler, so CC.I
  stays set until the code jumped to clears it.
* Porting the acknowledge and re-enable writes is not optional: they are
  latch writes (section 5.2), and the scheduler reads the masks.

### 6.3 Foreground code is a generator

* **The foreground (reset) thread of each CPU is a generator.**
* **`cwai #$EF` waits for the next IRQ**: charge its 16 cycles, then one
  plain `yield`, with a comment: `// $C318: cwai #$EF -- wait for vblank`.
  The wake-up and the handler are the scheduler's; the generator resumes
  after the RTI.
* **Waiting for another CPU is a poll loop**: `poll()` from
  src/game/timing.js, with the loop's instruction cycles, the read first:

  ```js
  // $E0E2: lda <$AF (4) / cmpa #$22 (2) / bne $E0E2 (3)
  yield* poll(s, 0x10af, (v) => v === 0x22, [4, 2, 3]);
  s.charge(4); s.charge(2); s.charge(3); // the pass that saw it
  ```

  Each failed pass is charged and yields `pollAgain(4, 2, 3)`, so the
  scheduler keeps the loop's phase and the exit is at the 6809's cycle.
  (`SPIN` / `RENDEZVOUS` still work but re-poll only at slice starts.)
* **The main loops restart after every frame.** Main `$D150` is
  `cwai #$EF / lds #$1600 / clr <$30 / jmp $FEB5`, and sub `$E17F` is
  `cwai #$EF / lds #$1D80 / jmp $E0EC`. The dispatchers are loops that
  SYNC before reading `<$2F`/`<$30` and before each task; a task's
  `inc <$30 / jmp dispatch` is the INC (timed: the sub may clear
  `main_task`) and a return. No JS local may survive the `cwai`.
* **The sound CPU has no foreground work**: `bra *` at `$E053` forever is
  `for (;;) yield idle(3);` -- the IRQ then enters on the loop's pass
  boundary, exactly.
* **Calling a routine from foreground code**: generators with `yield*`;
  across modules always `yield* call(MAIN.sub_C2FC, m, { a })`, which
  works whether or not the callee is a generator.
* `orcc #$10` / `andcc #$EF`: `m.sei()` / `m.cli()` (`m.sub.cli()`, ...).
  A pending IRQ is taken at the next yield.
* **Busy loops that burn time** (delays, checksums, clears): charge each
  pass; they need no other yield unless they store (6.4). The main
  boot's clock (src/game/clock.js `burn`) charges and yields at frame
  boundaries.
* Non-local jumps of the main CPU: src/game/main/jump.js; the driver in
  src/game/main/index.js starts the target at once.

### 6.4 The timing contract (src/game/timing.js)

The port reproduces the board's races only if every CPU's clock is exact
and every visible access happens at its cycle. So all ported code:

1. **Charges every instruction** with its MAME cycles, **one `charge()`
   call per instruction**, *after* the instruction's accesses: at an
   access the charged total is the cycle its instruction starts. JSR/BSR
   are charged by the caller, RTS by the routine, a table jump by the
   dispatching code. (Each call is an instruction boundary: where an IRQ
   enters a chunk that runs across the vblank, and where a core would
   stop at a slice's end. `m.charge(8 + 3)` hides one; write
   `m.charge(8); m.charge(3);`.)
2. **Yields SYNC right before every instruction whose access is timed**:
   `timed(cpu, addr)` -- main `$0000-$1FFF` (not its stack),
   `$6000-$63FF`, `$7000-$8FFF`; sub `$0000-$1FFF` (not `$1D74-$1D80`),
   `$6000-$6FFF`; sound `$0040-$007F`, `$4000-$7FFF` -- and before *any*
   access once `frameDue()` (the chunk has run past the next vblank: that
   access belongs to the next frame). `yield* at(view, addr)` does both
   for a computed address. A chip may use a narrower measured set (main
   gp2-2b `RACY`), at its own risk: `$1030` was missing from it and cost
   a divergence at frame 6,216.
3. **Waits with `poll()`** (6.3).

Checked by: each chip's tests (total cycles, the cycle of every write and
of every SYNC against the oracle's instruction starts) and lockstep:
`node tools/lockstep-run.mjs 20000 [--play=SEED] [--timing]` (IRQ
start/end cycles, ROM vs port) and test/oracle/lockstep*.test.mjs.

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

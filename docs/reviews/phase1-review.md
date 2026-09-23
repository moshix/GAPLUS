# Phase 1 review: CPU core, machine, I/O chips, video, 15XX, game infra

Copyright 2026 by Moshix

Reviewer: senior code review (emulation + JavaScript), 2026-09-23.
Reference: `reference/mame/**` (m6809 microcode, namcoio.cpp, gaplus*.cpp,
namco.cpp, watchdog.cpp). Scratch repro scripts live in the session
scratchpad (`gfxcheck.mjs`, `irqtiming.mjs`, `readtrap.mjs`); their
essential code is quoted below so the findings can be re-checked.

Test run: `node --test test/unit/*.test.mjs` -> 182 tests, **181 pass,
0 fail, 1 skipped** (`romset: every chip verifies, loose files equal the
zip` -- `gaplus.zip` is not in the project root although PLAN.md says it
is).

## Summary

| severity | count |
|----------|-------|
| critical | 0     |
| major    | 2     |
| minor    | 6     |
| style    | 4     |

No defect was found that breaks MAME fidelity of the delivered modules
as such. Both majors are about **when the 56XX/58XX frame run happens
relative to the main IRQ handler**, which is where the oracle and the
port can silently leave MAME. Everything else is small.

---

## Major

### M1. I/O-chip run delivered at instruction granularity; the main IRQ handler's `LDD $6800` straddles the 76.8-cycle point

*Where:* `src/machine/namcoio.js:41-45` (the contract "The oracle
schedules the run at the first instruction boundary at or after vblank +
76.8"), implemented by the oracle board (`test/m6809/board.mjs` header,
"Bus accesses therefore land at most one instruction late").

*What is wrong:* MAME's 6809 is **cycle-granular**, not
instruction-granular. `m6809make.py` turns every `@` line of the
microcode into `if (m_icount <= 0) { push_state(n); return; }`, so the
CPU stops in the middle of an instruction when its slice ends at the
`namcoio_run` timer (vblank + 50 us), the timer's `customio_run()` writes
nibbles 0-7, and the instruction then resumes and reads the NEW values.
The oracle runs the whole instruction first when it started before the
deadline, so its reads see the OLD values.

*Evidence:* measured with the core on the real ROM (`irqtiming.mjs`:
main ROM at $A000-$FFFF, PC in a `BRA *` loop, IRQ raised at an
instruction boundary, every I/O read timestamped with
`cpu.cycles + cpu.cyc`; default DIPs, `$09F4` = 0):

```
$6816 read at cycle 41 (0-based) after IRQ     FCDF LDA $6816
$6814 read at cycle 67                          C011 LDA $6814
$6800 read at cycle 79                          C01A LDD $6800
$6801 read at cycle 80                          (LDD opcode fetched at 75)
```

With IRQ latency L (cycles left of the instruction running at vblank)
of 0 or 1, the `LDD $6800` starts at cycle 75 or 76, before 76.8.
MAME: the run lands after cycle 76/77, the reads at 79+L/80+L see this
frame's credit nibbles. Oracle: `LDD` completes first, reads last frame's.
For L >= 2 both agree. Today the consequence is benign (C01A only does
`SUBD #$0A0A / LBCC $C1B9`, a >= 100-credit sanity check), but the
mechanism is general: any 56XX/58XX access, or any `$6808`/`$6809`
command write, within one instruction of vblank + 76.8 is resolved
differently from MAME.

*Suggested fix (board, not this module):* deliver the armed run lazily.
The core already exposes the absolute cycle of each bus access inside the
callback (`cpu.cycles + cpu.cyc`). Before servicing any access to
`$6800-$681F` (any CPU) whose absolute time is at or past the run time,
call `machine.ioUpdate()` first; also run it at the end of the slice as
now. Use MAME's threshold: the CPU executes `floor(76.8 + phase)` whole
cycles before the timer fires, so compare on the cycle index, not on the
instruction start. Then update the comment at `namcoio.js:41-45`.

### M2. Port side: where `ioUpdate()` sits relative to the main IRQ handler decides whether coins are credited in the same frame as MAME

*Where:* `src/machine/namcoio.js:28-31` ("The browser port ... may call
both back to back at the point of its frame that stands for '50 us
after vblank'"), `src/machine/machine.js:483-497`,
`docs/porting-guide.md` section 5.2/6.1 ("the scheduler ... calls
`m.vblank()` / `m.ioUpdate()`").

*What is wrong:* the contract leaves the placement open, but only one
placement reproduces MAME. From the timings in M1, the main handler's
56XX reads are `$6805` at ~cycle 50 (only when SW1:6 is ON, path $FCE8),
`$6800/$6801` at 79-80 and `$6802` at `$C055` (well after 77). If the
port's scheduler calls `ioUpdate()` **after** the (atomic) main handler,
the handler's `$C055 LDA $6802 / INC $6056 / CLR $6802` sees a coin one
frame later than MAME does, so `$6056` and the credit display diverge
from the oracle on every coin frame.

*Suggested fix:* document in `porting-guide.md` and in the
`namcoio.js` header that the port must call `m.ioUpdate()` right after
`m.vblank()` and **before** running the main IRQ handler. With factory
DIPs this matches MAME for every I/O read the handler makes (the reads
before cycle 77 are 58XX DIP nibbles that do not change). The one
exception is SW1:6 ON (`$FCE8 LDA $6805`, read before the run in MAME);
either note it as a known divergence or have the ported handler take a
callback that runs the I/O update between `$C011` and `$C01A`. Add a
lockstep test with a coin inserted on a frame boundary.

---

## Minor

### m1. `Machine.read(cpu, addr)` with the exported numeric CPU id silently reads the SOUND CPU's map

*Where:* `src/machine/machine.js:332-336`.
`this.busRead(CPU_NAMES.indexOf(cpu), addr)`: `CPU_NAMES.indexOf(1)` is
-1, and `busRead(-1, ...)` falls through to the sound decode.
`read16(CPU.SUB, a)` throws instead (it goes through `cpuView`).

*Repro (`readtrap.mjs`):*

```js
m.mem[0x0040] = 0x11; m.mem[0x6040] = 0x22;
m.read('sub', 0x40)    // 0x11
m.read(CPU.SUB, 0x40)  // 0x22  <- sound CPU $0040
m.read16(CPU.SUB, 0x40) // throws "unknown CPU 1"
```

*Fix:* resolve the CPU with `cpuView(cpu)` (throws on anything unknown)
or accept both names and numbers explicitly; add a test.

### m2. SRESET release leaves the sub/sound CC.I as it was

*Where:* `src/machine/machine.js:440-444` (`setSreset`) and
`irqPending` (470-473). MAME resets the 6809 when RESET is released
(`device_reset`: `m_cc |= CC_I | CC_F`), so right after `$8400` the
sub and sound CPUs cannot take an IRQ until they `ANDCC`. The Machine
keeps the old `iMask`, so `irqPending(SUB)` can be true immediately.

*Repro:* `m.sub.cli(); m.poke(0x8c00,0); m.poke(0x8400,0);
m.sub.poke(0x6001,0); m.vblank(); m.irqPending(CPU.SUB)` -> `true`.

*Fix:* in `setSreset`, when the line changes, set
`iMask[SUB] = iMask[SOUND] = true` (as `machineReset` already does for
all three). Harmless today (the reset code starts with `ORCC #$10`) but
a scheduler that polls `irqPending` between release and the first
ported instruction would take a phantom IRQ.

### m3. Starfield test does not pin MAME's result

*Where:* `test/unit/video.test.mjs:467-482` asserts `total > 50 &&
total <= MAX_STARS`. MAME's `starfield_init` yields exactly **105**
stars; an independent C-int transliteration (`gfxcheck.mjs`) matches
`Starfield` on all 105 (x, y, pen, set) with 0 mismatches. A regression
that dropped or re-ordered stars would still pass.
*Fix:* assert `total === 105` and compare against an independent
transliteration (or a hash of the star list).

### m4. Core skips dummy bus cycles on the assumption that PC is in ROM

*Where:* `test/m6809/m6809.mjs:12-15`. The rationale ("those cycles read
PC+n or $FFFF, both ROM") is true while every CPU executes from ROM,
which holds for Gaplus. If a CPU ever runs away into RAM/I/O (the case
an oracle is supposed to catch), MAME's `dummy_read_opcode_arg` at PC
would hit e.g. `$7800-$7FFF` (main watchdog) and the core would not.
*Fix:* state the assumption as an invariant and let the board assert it
(e.g. a trace hook that flags `pc < romStart`), so a divergence is
reported rather than silently modelled differently.

### m5. Two `FRAME_RATE` exports with different values

`src/machine/machine.js:81` = 60.60606 (MAME's literal);
`src/audio/wsg15xx.js:85` = 24.576 MHz / 4 / (384 x 264) = 60.6060606...
Same name, different numbers; the audio one is also not MAME's (MAME
uses `set_refresh_hz(60.606060)`, i.e. 3168.00003 samples per frame).
The drift is negligible, but rename one (e.g. `HW_FRAME_RATE`) or
import one from the other.

### m6. `call()` / `isGenerator()` detect generators by duck typing

*Where:* `src/game/call.js:20-26, 34-40`. Any plain routine that returns
an iterator (`arr.values()`, a `Map` iterator) is consumed with
`yield*` instead of being returned. Unlikely in 6809 ports, but silent.
*Fix:* `Object.prototype.toString.call(r) === '[object Generator]'`.

---

## Style / project rules

### s1. `node --test` output exceeds 79 columns

19 lines of the unit-test run are 80-96 columns wide (rule: console
output <= 79). Worst: `video.test.mjs:41` skip line (96),
`wsg15xx.test.mjs:254` (91), `wsg15xx.test.mjs:363` (89),
`video.test.mjs:400`, `video.test.mjs:230` (84). Node adds `"✔ "` plus
` (12.345678ms)`, so titles should stay under ~60 characters.

### s2. `any` in JSDoc

`src/input/gamepad.js` (~lines 54, 94, 108: `ArrayLike<any>`,
`{any[]}`) violates "no `any` without permission". Not in the reviewed
list but in `src/`.

### s3. `@ts-ignore` overloads on `Machine.read` / `read16`

`src/machine/machine.js:332, 342`: the Machine's `read(cpu, addr)`
deliberately differs from `CpuView.read(addr)`. Combined with m1 this is
an easy trap; a separate name (`readAs(cpu, addr)`) removes both the
ignore and the ambiguity.

### s4. `gaplus.zip` missing

PLAN.md says the zip is in the project root; it is not, so the romset
integrity test is skipped on this machine.

---

## Verified correct (no action)

Checked line by line against MAME, with independent repro where noted:

* **MC6809 core** (`test/m6809/m6809.mjs`, `opcodes.mjs`): every opcode
  on pages 1-3 against `m6809.lst`/`base6x09.lst` -- flags (`set_flags`
  XOR form, H only on ADD/ADC, NEG/DEC/INC/ASL/ROL V, DAA incl. "C only
  set", MUL Z/C, SEX V untouched, XNC/XDEC/XCLR, X18), cycle counts
  (including LBcc +1, PSH/PUL per byte, RTI 6/15, CWAI 20, SYNC 3,
  EXG 8, TFR 6), all 256 indexed postbytes (undefined x7/xA/xE -> EA 0
  with no extra cycle, indirect honoured on every mode), EXG 816/168
  read flavours and write order, TFR/LDS/LEAS arming NMI (EXG and PULU
  not), NMI edge latch gated by `m_lds_encountered`, IRQ/FIRQ/NMI entry
  (19/10/19, ack after stacking), CWAI stacking before the wait and
  `CC_F` only for non-IRQ, SYNC resuming on masked lines, page 2/3
  prefix chaining and fall-through to DISPATCH01, free-run. Bus-visible
  reads MAME performs through the data path (CLR's read, PSHS/PSHU's
  read at S/U, the read after every pull, XST16's write at PC) are all
  performed.
* **56XX/58XX** (`namcoio.js`): modes 0/1/2/4/7/8/9 and 0/1/2/3/4/5, LFSR
  boot check incl. tap order and the gaplus kludge, `handle_coins`
  (assignment not sum, negative `credit_add`, C truncating `/` and `%`,
  no cap, handshake nibbles, button held/edge nibbles), FRESET semantics,
  `device_reset` pulse, never-reset edge detectors, gapluso's crossed
  run gating and 56XX-before-58XX order, 62XX read overrides and the
  bang trigger. Input bit layout and DIP defaults match the `gapluso`
  ports.
* **Machine** (`machine.js`): all three maps, A11/A0/A13 latch decode
  (offset-relative bits equal absolute bits for these bases), watchdog
  read/write ranges and `space.unmap()` = 0, unmapped reads 0, VINTON
  cleared by machine reset only, vblank order.
* **Video**: `gfxcheck.mjs` decodes gfx1/gfx2 straight from MAME's
  `gfx_layout` bit offsets after `driver_init`'s nibble unpacking:
  0 / 32,768 char pixels and 0 / 98,304 sprite pixels differ;
  PALETTE, CHAR_LUT (256), SPRITE_LUT (512) 0 mismatches; pen 0 ->
  indirect $FF -> black. Tilemap scan, flip (logical->memory flip plus
  mirrored tiles), category passes with $FF transparency, sprite
  decode/wrap/flip-screen/duplicate/`code % 384`, starfield init (105
  stars, signed `%`), motion, wrap and blink all match `gaplus_v.cpp`.
* **15XX** (`wsg15xx.js`): register decode incl. same-value early return
  and the +2 counter write, 18 fraction bits, volume-0 voices hold,
  `sound_enable` gating stops output and counters; waveform table equals
  the low nibbles of `gp2-4.3f`.
* **m6809ops.js**, **romdata.js**: flag helpers equal MAME's
  `set_flags`/`daa`/`mul`; ROM bytes are checked against the chips by
  `game-infra.test.mjs`.

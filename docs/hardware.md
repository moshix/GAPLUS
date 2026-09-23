# Gaplus hardware reference

Copyright 2026 by Moshix

Authoritative hardware description for the Gaplus port: what the oracle
board under `test/m6809/` must emulate, and what `src/machine/` must model.
Where MAME and FBNeo disagree, **MAME is the reference** unless noted.

## 0. Sources

| what                         | local copy                                   |
|------------------------------|----------------------------------------------|
| MAME driver (master ef35f64b)| `reference/mame/namco/gaplus.cpp`, `.h`      |
| MAME video                   | `reference/mame/namco/gaplus_v.cpp`          |
| MAME 62XX glue + sample hook | `reference/mame/namco/gaplus_m.cpp`          |
| MAME 56XX/58XX/59XX          | `reference/mame/namco/namcoio.cpp`, `.h`     |
| MAME 62XX stub               | `reference/mame/namco/namco62.cpp`, `.h`     |
| MAME 15XX WSG                | `reference/mame/sound/namco.cpp`, `.h`       |
| MAME samples device          | `reference/mame/sound/samples.cpp`, `.h`     |
| MAME watchdog                | `reference/mame/machine/watchdog.cpp`, `.h`  |
| MAME MC6809 core             | `reference/mame/m6809/` (see section 11)     |
| FBNeo driver (master 4006b5e)| `reference/fbneo/d_gaplus.cpp`               |
| FBNeo helpers                | `reference/fbneo/namcoio.*`, `namco_snd.*`   |
| web notes                    | `reference/web/*.md` (+ raw HTML)            |

Everything marked **[ROM]** below was confirmed by reading the actual
6809 code in `roms/` (hand disassembly of the reset/IRQ paths).

---

## 1. ROM set identification

All 20 files in `roms/` match MAME set **`gaplus` — "Gaplus (GP2 rev. B)"**
exactly (CRC32 checked; SHA1s are listed in `gaplus.cpp`). FBNeo's
`gaplus` set is the same. MAME runs this set on the **`gapluso`** machine
config with the **`gapluso`** input ports (`GAME( 1984, gaplus, 0,
gapluso, gapluso, gapluso_state, ...)`), which matters: see sections 5
and 8.

ROM loading (MAME regions):

| region  | file        | load addr | notes                                   |
|---------|-------------|-----------|-----------------------------------------|
| maincpu | gp2-4.8d    | $A000     |                                         |
| maincpu | gp2-3b.8c   | $C000     |                                         |
| maincpu | gp2-2b.8b   | $E000     | vectors at $FFF0-$FFFF                  |
| sub     | gp2-8.11d   | $A000     |                                         |
| sub     | gp2-7.11c   | $C000     | identical in every set                  |
| sub     | gp2-6.11b   | $E000     |                                         |
| sub2    | gp2-1.4b    | $E000     | sound CPU, identical in every set       |
| gfx1    | gp2-5.8s    | $0000     | chars; $2000-$3FFF = copy >> 4          |
| gfx2    | gp2-11.11p  | $0000     | sprites planes 1/2                      |
| gfx2    | gp2-10.11n  | $2000     | sprites planes 1/2                      |
| gfx2    | gp2-12.11r  | $4000     | sprites planes 1/2                      |
| gfx2    | gp2-9.11m   | $6000     | sprites plane 0; $8000 = copy << 4      |
| gfx2    | (fill 0)    | $A000     | "optional ROM, not used"                |
| proms   | gp2-3.1p    | $000      | red (4 bits)                            |
| proms   | gp2-1.1n    | $100      | green (4 bits)                          |
| proms   | gp2-2.2n    | $200      | blue (4 bits)                           |
| proms   | gp2-7.6s    | $300      | char colour lookup (low 4 bits)         |
| proms   | gp2-6.6p    | $400      | sprite lookup, low nibble               |
| proms   | gp2-5.6n    | $600      | sprite lookup, high nibble              |
| namco   | gp2-4.3f    | $000      | WSG waveforms (low 4 bits)              |
| plds    | pal10l8.8n  | —         | sub CPU address decoder, not emulated   |

Vectors **[ROM]**: main RESET $E000, IRQ/FIRQ/NMI/SWI all $C000; sub RESET
$E000, others $E061; sound RESET $E000, IRQ $E055 (FIRQ/NMI/SWI = $FFFF,
never used). Only IRQ is used on all three CPUs.

### Related sets (differences from `gaplus`)

| set      | name                          | differs from gaplus in                                       |
|----------|-------------------------------|--------------------------------------------------------------|
| gaplusa  | Gaplus (GP2)                  | only `gp2-2.8b` (61f6cc65) — older $E000 ROM                  |
| gaplusd  | Gaplus (GP2 rev D, alt. hw)   | main 4b/3c/2d, sub 8b/6b; **56XX and 58XX swapped** ($6800 = 58XX with coins/joysticks, $6810 = 56XX with DIPs) |
| gapluse  | Gaplus (GP7)                  | main gp7_4/3/2, sub gp7_8/gp7_6; `gaplus` machine config     |
| galaga3  | Galaga 3 (GP3 rev. D)         | main gp3-4c/3c/2d, sub gp3-8b/6b, **chars gp3-5.8s**, **sprite PROMs gp3-6.6p/gp3-5.6n**; `gaplus` config (lamp outputs, service on edge connector) |
| galaga3a | Galaga 3 (GP3 rev. C)         | as galaga3 but `gp3-2c.8b`                                   |
| galaga3b | Galaga 3 (GP3)                | older GP3 program ROMs                                       |
| galaga3c/m | Galaga 3 sets 4/5 (Midway PCB) | Midway PCB, different bonus-life DIP tables               |
| gaplust  | Tecfri bootleg (1992)         | mixed Galaga 3/Gaplus code                                   |

`gaplus`, `gaplusa`, `gaplusd` use `gapluso_state`/`gaplusd_state`
(service mode on DIP SW2:1, no lamp outputs); all `galaga3*`, `gapluse`
and `gaplust` use `gaplus_state` (service switch on the 62XX input,
lamps/coin counters on 56XX outputs). MAME notes that only `gaplus` and
`gaplusd` stop on a custom I/O check failure, skip the Namco RAM test,
and use the first I/O chip in "coin" mode.

---

## 2. Board, clocks and frame timing

| item                 | value                                               |
|----------------------|-----------------------------------------------------|
| master crystal       | 24.576 MHz                                          |
| CPUs                 | 3 x MC6809E, each 24.576 MHz / 16 = **1.536 MHz**    |
| MAME CPU type        | `MC6809E` (clock divider 1: one cycle per input clock) |
| WSG (15XX)           | 24.576 MHz / 1024 = **24 000 Hz** sample clock       |
| screen (MAME)        | 288 x 224 (36 x 28 tiles), ROT90                    |
| refresh (MAME)       | `set_refresh_hz(60.606060)`, `set_vblank_time(0)`   |
| cycles per frame     | 1 536 000 / 60.60606 = **25 344** per CPU            |
| MAME quantum         | `set_maximum_quantum(attotime::from_hz(6000))` = 256 CPU cycles |
| 62XX (MB8843)        | 24.576 MHz / 12, "totally made up"; disabled in MAME |

Derived (not in the MAME source, but consistent with it): pixel clock
24.576 / 4 = 6.144 MHz, 384 clocks/line, 264 lines/frame → 60.606 Hz,
96 CPU cycles per scanline, 264 x 96 = 25 344. MAME does **not** model
scanlines for this game: the screen has no raw timing, and vblank has
zero length, so all per-frame events happen at one instant per frame.

Exact MAME frame period: 1e18 / 60.606060 as = 16.500000165 ms, i.e.
25 344.00025 CPU cycles. The 0.00025-cycle excess means MAME's vblank
slides by one CPU cycle every ~4000 frames. **The oracle uses exactly
25 344 cycles per frame.** FBNeo uses `(INT32)(1536000 / 60.606061)` =
25 343 cycles per frame.

---

## 3. Memory maps

Address decode is by the 34XX custom (main and sound) and a PAL (sub).
MAME maps are exact ranges; the tables below are what MAME implements,
with the hardware decode (from the driver comment) noted where it implies
mirrors that MAME does not implement. **Unmapped reads return $00 in
MAME** (address-map default unmap value 0); unmapped writes are ignored.

### 3.1 Shared memory overview

| memory                 | main CPU       | sub CPU        | sound CPU      | size   |
|------------------------|----------------|----------------|----------------|--------|
| tile RAM (9J)          | $0000-$07FF    | $0000-$07FF    | —              | 2 KB   |
| work RAM 3M (+sprites) | $0800-$0FFF    | $0800-$0FFF    | —              | 2 KB   |
| work RAM 3K (+sprites) | $1000-$17FF    | $1000-$17FF    | —              | 2 KB   |
| work RAM 3L (+sprites) | $1800-$1FFF    | $1800-$1FFF    | —              | 2 KB   |
| 15XX regs + sound RAM  | $6000-$63FF    | —              | $0000-$03FF    | 1 KB   |

Main and sub share $0000-$1FFF byte for byte (same 8 KB). Main
$6000-$63FF and sound $0000-$03FF are the same 1 KB: offsets $000-$03F are
the 15XX sound registers (read back as written), $040-$3FF plain RAM.

### 3.2 Main CPU (maincpu)

| address       | R/W | function                                                      |
|---------------|-----|---------------------------------------------------------------|
| $0000-$03FF   | R/W | tile codes (tilemap RAM, shared with sub)                     |
| $0400-$07FF   | R/W | tile attributes: b7 = code bit 8, b6 = priority, b5-0 = colour|
| $0800-$1FFF   | R/W | work RAM shared with sub; sprite regs at $0F80-$0FFF, $1780-$17FF, $1F80-$1FFF; flip at $1F7F b0 |
| $2000-$5FFF   |  —  | unmapped (reads $00)                                          |
| $6000-$603F   | R/W | 15XX sound registers (section 7)                              |
| $6040-$63FF   | R/W | RAM shared with sound CPU                                     |
| $6400-$67FF   |  —  | unmapped (hw decode `01100-xxxxxxxxxx` would mirror $6000)    |
| $6800-$680F   | R/W | I/O chip #1 = **56XX** (4-bit; reads $F0 \| nibble)          |
| $6810-$681F   | R/W | I/O chip #2 = **58XX** (4-bit; reads $F0 \| nibble)          |
| $6820-$682F   | R/W | I/O chip #3 = **62XX** (MAME: 8-bit RAM with read overrides)  |
| $6830-$6FFF   |  —  | unmapped (hw decode `01101-----xxxxxx` mirrors I/O)           |
| $7000-$77FF   |  W  | **main IRQ enable** (any data)                                |
| $7800-$7FFF   |  W  | **main IRQ disable + clear** (any data)                       |
| $7000-$77FF   |  R  | unmapped ($00)                                                |
| $7800-$7FFF   |  R  | **watchdog reset** (returns $00)                              |
| $8000-$87FF   |  W  | **SRESET off**: sub + sound CPUs run, 15XX sound enabled      |
| $8800-$8FFF   |  W  | **SRESET on**: sub + sound CPUs held in reset, sound muted    |
| $9000-$97FF   |  W  | **FRESET off**: I/O chips run                                 |
| $9800-$9FFF   |  W  | **FRESET on**: I/O chips held in reset                        |
| $A000-$A7FF   |  W  | starfield control, `reg[addr & 3]` (mirrors every 4 bytes)    |
| $A000-$FFFF   |  R  | program ROM                                                   |
| $A800-$FFFF   |  W  | ignored                                                       |

The latches take their data from **address bit A11**, not the data bus:

```c
// gaplus.cpp (offset is relative to the start of each range)
irq_1_ctrl_w: bit = !BIT(offset, 11); main_irq_mask = bit;
              if (!bit) maincpu->set_input_line(0, CLEAR_LINE);
sreset_w:     bit = !BIT(offset, 11);
              sub, sub2 RESET line = bit ? CLEAR : ASSERT;
              namco_15xx->sound_enable_w(bit);
freset_w:     bit = !BIT(offset, 11);
              58xx/56xx reset line = bit ? CLEAR : ASSERT;
```

Addresses the program actually uses **[ROM]**: $7400 (IRQ on), $7C00
(IRQ off and watchdog read), $8400/$8C00 (SRESET off/on), $9400/$9C00
(FRESET off/on), $A000-$A003. At boot it writes $0000 to $7820-$782F
(lands in IRQ-disable; harmless).

### 3.3 Sub CPU (sub)

| address       | R/W | function                                                    |
|---------------|-----|-------------------------------------------------------------|
| $0000-$07FF   | R/W | tilemap RAM (shared with main)                              |
| $0800-$1FFF   | R/W | work/sprite RAM (shared with main)                          |
| $6000-$6FFF   |  W  | **VINTON**: sub IRQ enable = A0 (odd address on, even off; off also clears the line) |
| $A000-$FFFF   |  R  | program ROM                                                 |
| everything else | — | unmapped (reads $00)                                        |

```c
irq_2_ctrl_w: bit = offset & 1; sub_irq_mask = bit;
              if (!bit) subcpu->set_input_line(0, CLEAR_LINE);
```

Uses **[ROM]**: $6001 once at boot (enable), $6080 (off/ack, first
instruction of the IRQ handler), $6081 (on, end of the handler). At boot
it also writes $500F 256 times (unmapped in MAME, meaning unknown).

### 3.4 Sound CPU (sub2)

| address       | R/W | function                                                    |
|---------------|-----|-------------------------------------------------------------|
| $0000-$003F   | R/W | 15XX sound registers                                        |
| $0040-$03FF   | R/W | RAM shared with main ($6040-$63FF)                          |
| $2000-$3FFF   | R/W | watchdog reset (read returns $00)                           |
| $4000-$5FFF   |  W  | sound IRQ enable                                            |
| $6000-$7FFF   |  W  | sound IRQ disable + clear                                   |
| $E000-$FFFF   |  R  | program ROM                                                 |
| everything else | — | unmapped (reads $00; hw decode `11-x...` would mirror ROM at $C000) |

```c
irq_3_ctrl_w: bit = !BIT(offset, 13); sub2_irq_mask = bit;
              if (!bit) subcpu2->set_input_line(0, CLEAR_LINE);
```

Uses **[ROM]**: $6000 (off/ack, IRQ handler entry), $4000 (on), $3000
(watchdog), $2007 once at boot. After init the sound CPU runs
`BRA *` at $E053 forever; all sound work happens in the IRQ handler.

### 3.5 Watchdog

One MAME `WATCHDOG_TIMER` with default configuration, kicked by main
reads of $7800-$7FFF and by sound reads/writes of $2000-$3FFF. With no
time or vblank count configured, MAME's watchdog is armed on the first
kick and then fires if not kicked for **3 seconds** (full machine reset).
The oracle may treat it as never firing; if it fires, that is a bug.

---

## 4. Interrupts and the frame

### 4.1 Sources

Only the 6809 **IRQ** line (input line 0) is used, on all three CPUs. No
NMI, no FIRQ. The line is **level**, asserted at vblank if the CPU's mask
latch is set, and stays asserted until that CPU writes its disable latch.
There is **no pending latch**: if the mask is 0 at the vblank instant,
that frame's interrupt is lost.

```c
// gapluso_state::vblank_irq(int state) -- called at vblank start
if (!state) return;
if (m_main_irq_mask) maincpu->set_input_line(0, ASSERT_LINE);
if (!namco58xx->read_reset_line()) namcoio1_run_timer->adjust(50us); // runs 56XX
if (!namco56xx->read_reset_line()) namcoio0_run_timer->adjust(50us); // runs 58XX
if (m_sub_irq_mask)  subcpu->set_input_line(0, ASSERT_LINE);
if (m_sub2_irq_mask) subcpu2->set_input_line(0, ASSERT_LINE);
```

(`gapluso` cross-wires which chip's reset gates which chip's run; since
both share FRESET this is equivalent to "run each chip unless in reset".)

Acknowledge pattern **[ROM]**:

| CPU   | handler | first action                 | re-enable at end |
|-------|---------|------------------------------|------------------|
| main  | $C000   | `LDA $7C00` (watchdog), `STA $7C00` (clear+mask off) | `STA $7400` at $C031 |
| sub   | $E061   | `STA $6080` (clear+mask off) | `STA $6081` at $E0E8 |
| sound | $E055   | `STA $6000` (clear+mask off), `STA $3000` (watchdog) | `STA $4000` |

The main program also uses **CWAI #$EF** (e.g. $C318, the 62XX init
sequence at $C2FC-$C35D) to wait for the vblank IRQ, so the core must
implement CWAI exactly (state pushed before the wait).

### 4.2 Mask state at reset

`machine_reset` clears only `sub_irq_mask` (VINTON) and the sub IRQ line.
Main and sound masks start at 0 (power-on) and are **not** changed by a
soft reset. Asserting SRESET does not touch any mask. All three CPUs
enter reset with CC.I = CC.F = 1, DP = 0.

### 4.3 The per-frame instant (MAME order)

The screen has vblank length 0, so MAME's `vblank_begin` and `vblank_end`
run back to back at t = n x 16.5 ms (n = 1, 2, ...; the first IRQ comes
one full frame after power-on). In order:

1. **Screen update**: the frame is drawn from RAM as it is now (tilemap,
   sprite RAM, flip bit, star positions and `starfield_framecount` from
   the previous update).
2. `screen_vblank(1)`: nothing. `vblank_irq(1)`: assert IRQs per masks
   (above); schedule each non-reset I/O chip's `customio_run()` for
   **t + 50 µs = 76.8 CPU cycles** later.
3. `vblank_end` → `screen_vblank(0)`: `starfield_framecount++`, then if
   starfield enabled, move stars (section 6.6). `vblank_irq(0)` returns.
4. At t + 50 µs: 58XX and 56XX `customio_run()` — they read the command
   in nibble 8 and write their results into nibbles 0-7.

So the game's IRQ handler sees last frame's I/O results unless it runs
longer than ~77 cycles before reading $6800-$681F.

### 4.4 CPU interleaving in MAME

* Devices execute in config order: **maincpu, sub, sub2**. (The 62XX's
  MB8843 is disabled and never runs.)
* Timeslice ≤ 1/6000 s = **256 cycles**. Slices end early at every timer
  (vblank, the +50 µs I/O timers) and whenever a CPU's action forces a
  sync (e.g. `set_input_line` on another CPU: RESET via $8000/$8800).
* Within a slice, main runs its whole slice first, then sub, then sound.
  So sub and sound "lag" main by up to one slice when talking through
  shared RAM. A CPU may overrun the slice end by the rest of its current
  instruction; MAME carries the overrun (the next slice is shorter).
* `perfect_quantum` is **not** used.
* Result: 99 slices of 256 cycles per frame (25 344 / 256 = 99 exactly),
  plus the splits caused by timers.

FBNeo instead runs 264 slices per frame (one per scanline, ~96 cycles),
main then sub then sound, and raises IRQs/I/O runs after the last slice.

### 4.5 Boot sequence **[ROM]** (useful for oracle tests)

Main, from RESET $E000:

```
E000 ORCC #$10        ; I=1
E002 STA $8C00        ; SRESET on: hold sub + sound in reset, mute
E005 STA $9400        ; FRESET off: I/O chips running
E008 STA $7C00        ; main IRQ off
E00B LDA #$10 / TFR A,DP ; DP = $10 (sub also uses DP = $10)
E00F LDS #$1600
E013 LDD #$01FF / STD $6808 ; 56XX cmd 1, arg F
E019 CLR $6818        ; 58XX cmd 0
E01C..E027 fill $0000-$03FF with $00,$20 pairs
E029..E035 clear $0400-$1FFF, reading $7C00 (watchdog) each word
E03D STA $A000 (0)   ; starfield off;  E040 STB $1F7F (0) ; no flip
E043..E063 $6828..$682F = 4,5,6,...,$0B    ; 62XX
E065..E07F $6808 = 8 (56XX boot check), $6818 = 5 (58XX boot check),
           $6809-$680F = $F, $6819-$681F = $F, waiting a frame between
E084 check $6800-$6801 == 6,9  (56XX: sum of 7 x $F = $69)
E096 check $6810-$6811 == F,F  (58XX mode 5, see 5.3)
E0A6 check $6821 == F, $6822 == E, $6823 == 1  (62XX, see 5.4)
E0C4 STA $8400        ; SRESET off: sub + sound start from their RESET
E0C7 $11 -> $6040 and $0800; wait for $22 in both (sound, sub handshake)
E0E8 $0000 -> $7820-$782F
E0F5 56XX cmd 0, 58XX cmd 0; wait; 56XX cmd 1, 58XX cmd 4 (DIPs)
E10B copy $6800-$6803 (switches) to $1006-$1009, decode DIPs
E1DE STA $9C00 / wait / STA $9400 ; pulse FRESET (resets coin state)
E1E7 $6809-$680C = coinage, $6808 = 2 (56XX coinage init)
...  $C296: $6808 = 4 (56XX coin mode, used from here on)
```

Sub, from $E000: `ORCC #$10`, DP=$10, `LDS #$1D80`, spin until
$0800 == $11, checksum its ROMs (errors to $0801), write $22 to $0800,
`STA $6001` (IRQ on), write $500F x256, `ANDCC #$EF`, `JMP $E0EC`.

Sound, from $E000: `STA $6000` (IRQ off), spin reading $0040 and writing
$3000 until $0040 == $11, checksum $E000-$FFFF (error → $0380), write
$22 to $0040, clear $0000-$02FF (**including $0040 and the 15XX
registers**), copy $E3EF-$E40E to $00A0, `LDS #$0400`, `ANDCC #$EF`,
`STA $4000` (IRQ on), `STA $2007`, `BRA *`.

Timing hazard: the sound CPU writes $22 to $0040 and then clears $0040
again ~700 cycles later (32 words into its clear loop). The main CPU's
wait loop (`LDA $6040; LDY $7C00; CMPA #$22; BNE`, 17 cycles) must see the
$22 within that window. Any interleave finer than ~600 cycles works.

**Sub/sound at power-on.** MAME does **not** hold sub and sound in reset
at power-on; they start executing at t = 0 and are put into reset by the
main's `STA $8C00` (cycle ~3-8). They are harmless during those cycles
(sub reads $0800, sound writes $6000/$3000). FBNeo starts the sub in
reset and the sound CPU running. The oracle should hold both in reset
from power-on (equivalent result, simpler), or model MAME exactly when
comparing against MAME traces.

---

## 5. Custom I/O chips

All three are 4-bit Fujitsu MB88xx MCUs behind the 16XX interface.
Each occupies 16 nibbles; **nibble 8 is the command/mode**, 9-15 are
arguments written by the CPU, 0-7 are results written by the chip. MAME
does not run the MCU code: it runs a C function once per frame (50 µs
after vblank) that acts on the mode in nibble 8.

| address     | chip (gaplus) | inputs (MAME in_cb 0..3)            | outputs        |
|-------------|---------------|-------------------------------------|----------------|
| $6800-$680F | **56XX**      | COINS, P1, P2, BUTTONS              | none in `gapluso` (lamps only in `gaplus_state`) |
| $6810-$681F | **58XX**      | DSWA_HIGH, DSWB_LOW, DSWB_HIGH, DSWA_LOW | none      |
| $6820-$682F | **62XX**      | IN2 (cabinet, service)              | explosion noise (sample) |

### 5.1 CPU access (56XX / 58XX)

```c
read(offset):  return 0xf0 | m_ram[offset];   // 4-bit RAM, high nibble 1s
write(offset): m_ram[offset] = data & 0x0f;
```

Reset: `device_reset` (machine reset) zeroes all 16 nibbles and pulses
the reset line. `set_reset_line(ASSERT)` (FRESET on) does **not** touch
the RAM; it resets `credits = 0`, `coins[0..1] = 0`,
`coins_per_cred[0..1] = 1`, `creds_per_coin[0..1] = 1`. While the reset
line is asserted, `customio_run()` is skipped at vblank. `lastcoins` and
`lastbuttons` (edge detectors) are initialised to 0 at power-on and never
reset.

All input ports are active low; the chip stores the **inverted** value
(`~port & 0x0f`), so 1 = pressed / switch on.

### 5.2 56XX modes used by Gaplus

Sequence **[ROM]**: 8 (boot check) → 0 → 1 (read switches) → [FRESET
pulse] → 2 (coinage) → **4 (coin mode, all gameplay)**. The MAME note says
gaplus uses the first I/O chip in "coin" mode.

```c
case 0: break;                                   // nop
case 1: ram[0] = ~COINS; ram[1] = ~P1;           // read switches
        ram[2] = ~P2;    ram[3] = ~BUTTONS;
        out0(ram[9]); out1(ram[10]);             // lamps (gaplus_state only)
case 2: coins_per_cred[0] = ram[9];  creds_per_coin[0] = ram[10];
        coins_per_cred[1] = ram[11]; creds_per_coin[1] = ram[12];
case 4: handle_coins(0);
case 8: sum = ram[9] + ... + ram[15]; ram[0] = sum >> 4; ram[1] = sum & 15;
```

`handle_coins(swap = 0)`, run once per frame in mode 4:

```c
val = ~COINS; toggled = val ^ lastcoins; lastcoins = val;
if (val & toggled & 1) {                  // coin 1 rising edge
    coins[0]++;
    if (coins[0] >= (coins_per_cred[0] & 7)) {
        credit_add = creds_per_coin[0] - (coins_per_cred[0] >> 3);
        coins[0] -= coins_per_cred[0] & 7;
    } else if (coins_per_cred[0] & 8) credit_add = 1;
}
if (val & toggled & 2) { ...same with index 1... }   // coin 2
if (val & toggled & 8) credit_add = 1;               // service coin
val = ~BUTTONS; toggled = val ^ lastbuttons; lastbuttons = val;
if (ram[9] == 0) {                        // game allows starting
    if (val & toggled & 4) { if (credits >= 1) credit_sub = 1; }
    else if (val & toggled & 8) { if (credits >= 2) credit_sub = 2; }
}
credits += credit_add - credit_sub;
ram[0] = credits / 10; ram[1] = credits % 10;      // BCD
if (credit_add) ram[2] = credit_add;   // CPU clears these (handshake)
if (credit_sub) ram[3] = credit_sub;
ram[4] = ~P1;
ram[5] = ((val & 5) << 1) | (val & toggled & 5);
ram[6] = ~P2;
ram[7] = (val & 0x0a) | ((val & toggled & 0x0a) >> 1);
```

Note: no credit cap; a later coin overwrites `credit_add` (not summed).

Resulting nibble layout in coin mode (1 = active):

| nibble | bit 3          | bit 2          | bit 1         | bit 0          |
|--------|----------------|----------------|---------------|----------------|
| $6800  | credits tens (BCD)| | | |
| $6801  | credits units (BCD)                                         | | | |
| $6802  | credits just added (CPU clears; main $C055 reads, INC $6056, CLR) | | | |
| $6803  | credits just used by start (CPU clears)                     | | | |
| $6804  | P1 left        | P1 down        | P1 right      | P1 up          |
| $6805  | start 1 held   | start 1 edge   | P1 fire held  | P1 fire edge   |
| $6806  | P2 left        | P2 down        | P2 right      | P2 up          |
| $6807  | start 2 held   | start 2 edge   | P2 fire held  | P2 fire edge   |
| $6809  | written by CPU: 0 = start buttons may take credits           | | | |

"edge" = pressed this run but not the previous run of mode 4.

### 5.3 58XX modes used by Gaplus

Sequence **[ROM]**: 0 → 5 (boot check) → 0 → **4 (read DIPs)**.

```c
case 4: // read dip switches: pin 13 selects half, ignored by the ports here
    ram[0] = ram[1] = ~DSWA_HIGH;  ram[2] = ram[3] = ~DSWB_LOW;
    ram[4] = ram[5] = ~DSWB_HIGH;  ram[6] = ram[7] = ~DSWA_LOW;
case 5: // boot check: XORs controlled by a 7-bit LFSR
    #define NEXT(n) ((((n) & 1) ? (n) ^ 0x90 : (n)) >> 1)
    n = (ram[9] * 16 + ram[10]) & 0x7f;
    seed = 0x22; for (i = 0; i < n; i++) seed = NEXT(seed);
    for (i = 1; i < 8; i++) {
        n = 0; rng = seed;
        if (rng & 1) n ^= ~ram[11]; rng = NEXT(rng); seed = rng;
        if (rng & 1) n ^= ~ram[10]; rng = NEXT(rng);
        if (rng & 1) n ^= ~ram[9];  rng = NEXT(rng);
        if (rng & 1) n ^= ~ram[15]; rng = NEXT(rng);
        if (rng & 1) n ^= ~ram[14]; rng = NEXT(rng);
        if (rng & 1) n ^= ~ram[13]; rng = NEXT(rng);
        if (rng & 1) n ^= ~ram[12];
        ram[i] = ~n & 15;
    }
    ram[0] = 0; if (ram[9] == 0xf) ram[0] = 0xf;   // "kludge for gaplus"
```

Gaplus writes 9-15 = F and expects $6810,$6811 = F,F. The chip also
implements modes 1, 2, 3 (`handle_coins(2)`) which Gaplus does not use on
this chip.

DIP usage by the program **[ROM]**: $6811 b0-1 coin A, b2-3 lives;
$6817 b0-1 coin B; $6812 b0-2 bonus life; $6814 b0-2 difficulty, b3
service mode (checked every IRQ at $C011); $6813 b3 round advance;
$6816 b2 (SW1:6, "unused" per MAME) is tested at $FCDF; $6816 b3 demo
sounds.

### 5.4 62XX at $6820-$682F

The 62XX (MB8843 with a dumped 2 KB ROM, `62xx.bin`) is **not emulated**
by MAME. Instead `gaplus_m.cpp` treats $6820-$682F as 16 bytes of plain
8-bit RAM with these read overrides (`mode` = byte at $6828, 8 bits):

```c
customio_3_w(offset, data):
    if (offset == 9 && data >= 0x0f) samples->start(0, 0);  // "bang"
    ram[offset] = data;
customio_3_r(offset):
    0: return IN2;                         // cabinet + service, 4 bits
    1: return mode == 2 ? ram[1] : 0x0f;
    2: return mode == 2 ? 0x0f   : 0x0e;
    3: return mode == 2 ? ram[3] : 0x01;
    default: return ram[offset];           // full 8 bits as written
```

Program use **[ROM]**: boot writes $6828-$682F = 4..$0B and checks
$6821/2/3 = F/E/1. The init at $C2FC then runs: mode 1 (with $6829 =
$0F → MAME plays "bang"), CWAI, wait $6821 == F; mode 2 (again $6829 =
$0F), CWAI, wait $6822 == F; mode 0; CWAI; mode 3. A static scan found
no other write of $6829; explosion triggering during play is unverified
and must be checked with the oracle's write log. $6820 b2 = cabinet
(read at $E159).

---

## 6. Video

### 6.1 Tilemap (36 x 28, 8x8 chars)

Unrotated MAME bitmap is 288 x 224 (col 0-35 left→right, row 0-27
top→bottom); the monitor is ROT90 (clockwise), giving 224 x 288 portrait.

```c
// tilemap_scan(col, row) -> tile index 0..0x3ff
row += 2; col -= 2;
if (col & 0x20) return row + ((col & 0x1f) << 5);   // cols 0,1,34,35
return col + (row << 5);
```

In portrait terms (R = screen row 0-35 from top, X = column 0-27 from
left; R = col, X = 27 - row):

| portrait rows | tile index                          | range       |
|---------------|-------------------------------------|-------------|
| R = 0, 1      | $3DD - X + $20·R                    | $3C2-$3FD   |
| R = 2..33     | (R - 2) + $20·(29 - X)              | $040-$3BF   |
| R = 34, 35    | $01D - X + $20·(R - 34)             | $002-$03D   |

(1008 indices used; $000,$001,$01E,$01F,$020,$021,$03E,$03F, and the
matching ends of $3C0-$3FF are off-screen.) Tile info:

```c
attr  = videoram[i + 0x400];
code  = videoram[i] + ((attr & 0x80) << 1);   // 0..511
color = attr & 0x3f;                          // 64 colour groups
category (priority) = (attr & 0x40) >> 6;     // 1 = above sprites
```

Tile pixels are transparent where the looked-up **palette index is $FF**
(`configure_groups(gfx0, 0xff)`), not where the pen is 0.

### 6.2 Character decode (gfx1)

```c
static const gfx_layout charlayout = {
    8,8, RGN_FRAC(1,1) /* 512 */, 2,
    { 4, 6 },
    { 16*8, 16*8+1, 24*8, 24*8+1, 0, 1, 8*8, 8*8+1 },
    { 0*8, 1*8, 2*8, 3*8, 4*8, 5*8, 6*8, 7*8 },
    32*8 };
// driver_init: gfx1[0x2000 + i] = gfx1[i] >> 4   (i < 0x2000)
```

MAME bit offset k means bit (7 - k) of the byte; plane 0 is the pixel
MSB. So for char c, pixel (x, y), with ROM = `gp2-5.8s`:

```
byte = ROM[(c & 255) * 32 + [16, 24, 0, 8][x >> 1] + y]
if (c >= 256) byte >>= 4             // chars 256-511 use the high nibble
k = x & 1
pixel = ((byte >> (3 - k)) & 1) << 1 | ((byte >> (1 - k)) & 1)
```

### 6.3 Sprite decode (gfx2)

```c
static const gfx_layout spritelayout = {
    16,16, RGN_FRAC(1,2) /* 384 */, 3,
    { RGN_FRAC(1,2), 0, 4 },
    { 0,1,2,3, 8*8,8*8+1,8*8+2,8*8+3,
      16*8,16*8+1,16*8+2,16*8+3, 24*8,24*8+1,24*8+2,24*8+3 },
    { 0*8,1*8,2*8,3*8,4*8,5*8,6*8,7*8, 32*8,33*8,...,39*8 },
    64*8 };
// driver_init: gfx2[0x8000 + i] = gfx2[0x6000 + i] << 4 (i < 0x2000)
// gfx2 = 11p | 10n | 12r | 9m | 9m<<4 | zeros
```

For sprite c (0..383), pixel (x, y):

```
off = c * 64 + (x >> 2) * 8 + (y & 7) + (y >> 3) * 32   // 0..0x5fff
k   = x & 3
lo  = [11p,10n,12r concatenated][off]
p1  = (lo >> (7 - k)) & 1        // plane 1 (middle bit)
p2  = (lo >> (3 - k)) & 1        // plane 2 (LSB)
p0  = c < 128 ? (9m[off] >> (7 - k)) & 1          // high nibble
    : c < 256 ? (9m[off - 0x2000] >> (3 - k)) & 1 // low nibble
    : 0                                           // unused ROM
pixel = p0 << 2 | p1 << 1 | p2                    // 0..7
```

Sprite codes above 383 wrap (MAME `code %= elements()`).

### 6.4 Sprite RAM (64 sprites, n = 0..63)

| address        | bits    | meaning                                       |
|----------------|---------|-----------------------------------------------|
| $0F80 + 2n     | 7-0     | code bits 0-7                                 |
| $0F81 + 2n     | 5-0     | colour (64 groups x 8 pens)                   |
| $1780 + 2n     | 7-0     | Y                                             |
| $1781 + 2n     | 7-0     | X bits 0-7                                    |
| $1F80 + 2n     | 0       | flip X                                        |
|                | 1       | flip Y                                        |
|                | 3       | size X (2 tiles wide)                         |
|                | 5       | size Y (2 tiles tall)                         |
|                | 6       | code bit 8                                    |
|                | 7       | "duplicate": all quadrants use the same code  |
| $1F81 + 2n     | 0       | X bit 8                                       |
|                | 1       | **1 = sprite disabled**                       |
| $1F7F          | 0       | flip screen (tilemap + all sprite flips)      |

MAME draw (unrotated 288 x 224 coordinates):

```c
sprite = code | (attr & 0x40) << 2;
sx = X + 0x100 * (xmsb & 1) - 71;
sy = 256 - Y - 8;  sy -= 16 * sizey;  sy = (sy & 0xff) - 32;
if (flip_screen) { flipx ^= 1; flipy ^= 1; }   // positions NOT mirrored
for (y = 0; y <= sizey; y++) for (x = 0; x <= sizex; x++)
    draw(sprite + (dup ? 0 : gfx_offs[y ^ (sizey*flipy)][x ^ (sizex*flipx)]),
         color, flipx, flipy, sx + 16*x, sy + 16*y);   // gfx_offs = {{0,1},{2,3}}
```

Sprites draw in order n = 0..63, so **higher n is on top**. Pixels whose
looked-up palette index is $FF are transparent. Clipped to the screen.
Portrait (ROT90) coordinates: px = 223 - uy, py = ux.

### 6.5 Palette

```c
// 256 colours; for each of R (gp2-3.1p), G (gp2-1.1n), B (gp2-2.2n):
v = 0x0e*b0 + 0x1f*b1 + 0x43*b2 + 0x8f*b3;  // 2.2k, 1k, 470, 220 ohm
// char pens (64 x 4):   pal[0xf0 | (gp2-7.6s[i] & 0x0f)]
// sprite pens (64 x 8): pal[(gp2-6.6p[i] & 0x0f) | (gp2-5.6n[i] & 0x0f) << 4]
```

Total 768 pens: $000-$0FF chars, $100-$2FF sprites. Palette $FF is black
and doubles as the transparency marker. Screen background is pen 0 =
char colour 0 pen 0 → palette $FF → black.

### 6.6 Starfield (MAME software approximation)

MAME's own TODO says "The starfield is wrong": the real CUS26 is not
understood, so MAME uses a Galaxian-style LFSR to place stars once and
scrolls them. The port should reproduce **this** algorithm bit-exactly
(it is what MAME shows) and treat it as cosmetic.

Control registers (main writes $A000-$A003):

| reg   | meaning                                        |
|-------|------------------------------------------------|
| $A000 | bit 0: starfield on                            |
| $A001 | motion of star set 0                           |
| $A002 | motion of star set 1                           |
| $A003 | motion of star set 2                           |

Init (`starfield_init`, at video start, with **C int32 semantics**:
`generator` overflows and goes negative, `%` truncates toward zero):

```c
generator = 0; set = 0; total = 0;
for (y = 0; y < 224; y++)
  for (x = 255; x >= 0; x--) {              // width - 2*16 - 1
    generator <<= 1;                         // int32 wraparound
    bit1 = (~generator >> 17) & 1;
    bit2 = (generator >> 5) & 1;
    if (bit1 ^ bit2) generator |= 1;
    if (((~generator >> 16) & 1) && (generator & 0xff) == 0xff) {
      color = (~(generator >> 8)) % 7 + 1;   // -5..7 (negative ~ gives <=0)
      base = set == 0 ? 0x250 : set == 1 ? 0x230 : 0x210;
      if (color && total < 250) {
        star[total] = { x: x + 16, y: y, col: base + color, set: set };
        set = (set + 1) % 3; total++;
      }
    }
  }
```

This yields **105 stars** (checked by simulation). Colours -5..-1 occur
because of the signed arithmetic; they select sprite-lookup entries
($10B-$10F etc.), several of which are black (invisible stars).
`col` is a pen number in the sprite range: RGB =
`pal[lookup_sprite[col - 0x100]]`.

Per frame, at vblank end (after the frame was drawn):

```c
starfield_framecount++;                    // always
if (!(ctrl[0] & 1)) return;
for each star:
  switch (ctrl[set + 1]) {
    case 0x87: break;                      // stand still
    case 0x85: case 0x86: x += 1; break;   // "scroll down" speed 1
    case 0x06: x += 2; break;
    case 0x80: x -= 1; break;              // "scroll up"
    case 0x82: x -= 2; break;
    case 0x81: x -= 3; break;
    case 0x9f: y += 3; break;              // "scroll left" (portrait)
    case 0xaf: y -= 3; break;              // "scroll right"
    default: break;                        // anything else: no motion
  }
  if (x < 16)   x += 256;   if (x >= 272) x -= 256;
  if (y < 0)    y += 224;   if (y >= 224) y -= 224;
```

Render (before tiles), only if `ctrl[0] & 1`:

```c
for (i = 0; i < total; i++) {
  if (star[i].set == 1 && ctrl[2] != 0x85 && (i % 2) == 0) {
    bit = BIT(framecount + i, 3) ? 1 : 2;
    if (BIT(framecount + i, bit)) continue;   // flicker (PCB video guess)
  }
  bitmap[y][x] = star.col;                    // unrotated coordinates
}
```

Positions are floats in MAME but only ever move by integers. Unrotated
x is portrait y (stars live in portrait rows 16-271); unrotated y maps
to portrait x = 223 - y.

### 6.7 Screen composition (MAME)

```c
flip_screen_set(ram[0x1f7f] & 1);   // flips tilemap; sprite flips toggled
bitmap.fill(0);                     // pen 0 -> black
starfield_render();
tilemap.draw(category 0);           // low-priority tiles, opaque pixels only
draw_sprites();
tilemap.draw(category 1);           // attr bit 6 tiles over sprites
```

---

## 7. Sound

### 7.1 Namco 15XX WSG

8 voices, mono, waveform PROM `gp2-4.3f` (8 waves x 32 4-bit samples,
low nibble). Registers at sound $0000-$003F / main $6000-$603F; voice
`ch` = 0..7 uses `ch*8 + r`:

| r | function                                                        |
|---|-----------------------------------------------------------------|
| 0,1 | stored only                                                    |
| 2 | sets counter integer part: `counter = (counter & frac_mask) \| (data & 0x1f) << 18` (DAC trick; not expected in Gaplus) |
| 3 | volume = data & 0x0f                                             |
| 4 | frequency bits 0-7                                               |
| 5 | frequency bits 8-15                                              |
| 6 | bits 0-3 = frequency bits 16-19, bits 4-6 = waveform select      |
| 7 | stored only                                                      |

Reads return the stored byte. A write with the same value is ignored.

Synthesis (MAME, 192 kHz internal = 24 kHz x 8, 18 fraction bits):

```
per 192 kHz tick, for each voice with volume != 0:
    pos = (counter >> 18) & 31
    out += ((prom[wave * 32 + pos] & 0x0f) - 8) * volume / 1024
    counter += frequency                     // 20-bit
```

Equivalent at the native 24 kHz: `acc += freq; pos = (acc >> 15) & 31`.
Tone frequency = freq x 24000 / 2^20 Hz. Voices with volume 0 do not
advance their counter (MAME detail). Output is silent while
`sound_enable` is 0 (SRESET on). Registers and shared RAM start at 0.

### 7.2 Samples

MAME sample set **`gaplus`** containing **`bang`** (`bang.wav`, not in
the ROM zip; part of MAME's separate samples pack), 1 channel, mixed at
0.80. Triggered by a main CPU write to **$6829 with data ≥ $0F**
(`samples->start(0, 0)`: channel 0, no loop, restarts if playing). It
stands in for the 62XX explosion/noise generator. FBNeo does the same
(`BurnSamplePlay(0)`, gain 0.25).

---

## 8. Inputs and DIP switches (`gapluso` ports, used by `gaplus`)

All active low. "Reads as" = value the CPU sees in the chip nibble
(inverted, 1 = pressed / DIP ON).

| port      | chip / nibble        | b3          | b2        | b1          | b0          |
|-----------|----------------------|-------------|-----------|-------------|-------------|
| COINS     | 56XX in0             | service coin| unused    | coin 2      | coin 1      |
| P1        | 56XX in1 → $6804     | left        | down      | right       | up          |
| P2        | 56XX in2 → $6806     | left        | down      | right       | up (cocktail)|
| BUTTONS   | 56XX in3             | start 2     | start 1   | P2 fire     | P1 fire     |
| IN2       | 62XX → $6820 (direct, not inverted) | unknown (1) | cabinet 1=upright | unused (1) | unused (1) |

Joysticks are 8-way. IN2 default reads $0F.

DIP switches (factory default = all OFF = port value $0F each):

| port      | chip nibble | bits | switch  | setting (port value)                              | default |
|-----------|-------------|------|---------|---------------------------------------------------|---------|
| DSWA_HIGH | $6810/11    | 1-0  | SW1:3,4 | Coin A: 0=3C1C 1=2C1C **3=1C1C** 2=1C2C             | 1C1C    |
|           |             | 3-2  | SW1:1,2 | Lives: 8=2 **C=3** 4=4 0=5                         | 3       |
| DSWB_LOW  | $6812/13    | 2-0  | SW2:6-8 | Bonus: 0=30k,70k,every 70k; 1=30k,100k,e100k; 2=30k,100k,e200k; 3=50k,100k,e100k; 4=50k,100k,e200k; **7=50k,150k,e150k**; 5=50k,150k,e300k; 6=50k,150k | 50k/150k/e150k |
|           |             | 3    | SW2:5   | Round Advance: **8=off** 0=on                       | off     |
| DSWB_HIGH | $6814/15    | 2-0  | SW2:2-4 | Difficulty: **7=0 standard** 6=1 easiest 5..0 = 2..7 hardest | 0 |
|           |             | 3    | SW2:1   | **Service mode** (gapluso): 8=off 0=on               | off     |
| DSWA_LOW  | $6816/17    | 1-0  | SW1:7,8 | Coin B: 0=3C1C 1=2C1C **3=1C1C** 2=1C2C             | 1C1C    |
|           |             | 2    | SW1:6   | "unused" (but read by the game at $FCDF)           | off     |
|           |             | 3    | SW1:5   | Demo sounds: 0=off **8=on**                         | on      |

(`gaplus_state` sets instead use SW2:1 as "Unknown" and take service
mode from IN2 bit 3.)

---

## 9. MAME vs FBNeo differences

| topic                    | MAME                                          | FBNeo                                        |
|--------------------------|-----------------------------------------------|----------------------------------------------|
| cycles / frame           | 25 344.00025 (time-based)                     | 25 343                                       |
| interleave               | ≤256-cycle slices + timer splits              | 264 slices (per line)                        |
| IRQ time                 | frame boundary (vblank start, 0-length vblank)| after the last of 264 slices                 |
| I/O chip run             | 50 µs after IRQ                               | immediately with the IRQ                     |
| sound CPU IRQ            | gated by `sub2_irq_mask`                      | **bug**: gated by `sub_irq_mask`             |
| sub/sound at power-on    | both running until main writes $8C00          | sub in reset, sound running                  |
| SRESET                   | reset line held (CPU suspended)               | `M6809Reset()` on entry, CPU idled while set |
| sound watchdog read      | $2000-$3FFF                                   | $6800-$6FFF (write $2000-$3FFF)              |
| stars                    | limit 250, skips `color == 0` → 105 stars     | limit 120, `color` already has base added so never 0 → **111 stars**, set rotation diverges after the first colour-0 star |
| star frame counter       | int, incremented at vblank end                | UINT8, incremented at frame start            |
| sprite codes ≥ 384       | wrap (`code % 384`)                           | read zeroed buffer (transparent)             |
| tile transparency        | palette index $FF                             | pen 0 (`GenericTilemapSetTransparent(0,0)`)  |
| samples gain             | 0.80                                          | 0.25                                         |
| $6820 read offset 0      | IN2 port                                      | DIP "E" (same bits)                          |
| namcoio                  | —                                             | port of MAME's, same modes/kludge            |

---

## 10. Frame-exact timing notes for the oracle and the port

* **Frame = 25 344 cycles per CPU.** One IRQ per frame per CPU (if
  enabled), all at the same instant; I/O chips update 76.8 cycles later.
* **The oracle** should interleave finely (e.g. per instruction,
  earliest-local-time CPU first, or slices of ≤ 96 cycles). The game's
  shared-RAM handshakes ($11/$22 boot handshake, main↔sub per-frame
  flags) must not depend on MAME's 256-cycle quantum. Record per-frame
  RAM snapshots at the vblank instant (before IRQs are raised).
  **Measured (docs/oracle-notes.md section 3):** the handshakes work at
  any quantum from 1 to 1,000, but the RAM does depend on it (the attract
  loop's pass count and main/sub races in play), so the oracle keeps
  MAME's 256-cycle slices and the port matches that oracle.
* **The port** is routine-based and cannot reproduce sub-frame
  interleaving; comparisons against the oracle happen at frame
  boundaries. Anything the three CPUs exchange mid-frame (e.g. sub
  reading main's flags) needs the oracle to show that the result does
  not depend on interleave; flag cases where it does.
* The I/O chip results the IRQ handler reads are from the previous
  frame's run (unless the handler is still running 77 cycles in).
* Lost IRQs: if a handler has not re-enabled its mask by the next
  vblank, that frame's IRQ is dropped (no latch). Watch for this in
  heavy frames on the main CPU.
* CWAI is used by main during the 62XX init; SYNC is not used on the
  paths inspected.
* Watchdog: 3 s after the first kick in MAME; ignore in the oracle but
  flag if any CPU stops kicking for > 180 frames.
* Screen render happens **before** the star update and I/O runs of the
  same instant: the frame shown uses RAM at vblank.

## 11. MC6809 core sources (for the cycle-accurate core)

`reference/mame/m6809/`: `m6809.cpp`, `m6809.h`, `m6809inl.h`,
`m6809.lst` (6809 opcode dispatch), `base6x09.lst` (shared addressing
modes and ops, the old `base6x09.ops`), `m6809make.py` (turns the .lst
files into the generated `.hxx` MAME compiles; MAME no longer has
`.ops` files), `6x09dasm.cpp/.h` (disassembler). The HD6309/Konami
files there were fetched by another task and are not needed.
MAME's `MC6809E` = divider 1, IRQ level-triggered, NMI edge-triggered
and disarmed until the first write to S.

## 12. Open questions

* Real CUS26 starfield algorithm (MAME's is a guess).
* Real 62XX behaviour (explosion noise; MAME's `bang` sample trigger on
  $6829 ≥ $0F only fires in the init sequence per static scan).
* What SW1:6 (read at $FCDF) does in rev. B.
* Meaning of sub CPU writes to $500F and sound CPU write to $2007.

# Gaplus disassembly notes

Copyright 2026 by Moshix

How the annotated listings in `reference/` are made, how to read and
extend them, and what the first annotation pass found in the three
program ROMs. Gaplus has no surviving commented source, so the listings
are generated from the ROM bytes plus hand-written annotation files.

## 1. Files

| file | what |
|------|------|
| `tools/gen-listing.mjs` | the generator (no dependencies) |
| `reference/gaplus-main.asm` | main CPU, $A000-$FFFF (generated) |
| `reference/gaplus-sub.asm` | sub CPU, $A000-$FFFF (generated) |
| `reference/gaplus-sound.asm` | sound CPU, $E000-$FFFF (generated) |
| `reference/symbols.json` | labels, RAM and I/O names (generated) |
| `reference/annotations/{main,sub,sound}.json` | the human knowledge: names, comments, seeds, data formats, RAM names |
| `reference/coverage/<cpu>.json` | optional: addresses the oracle saw execute |
| `test/unit/listing.test.mjs` | checks the listings against the ROMs |

```
node tools/gen-listing.mjs            # write the four generated files
node tools/gen-listing.mjs --check    # exit 1 if any is stale
node tools/gen-listing.mjs --tables   # also print the dispatch tables found
node --test test/unit/listing.test.mjs
```

Never edit the `.asm` files: edit the annotations and regenerate. The
unit test fails when a listing on disk is stale.

## 2. How the listings are produced

1. **Load** the 64 KB address-space images with `loadGaplus()`
   (`tools/romset.mjs`) and the annotation and coverage files.
2. **Trace** (recursive descent, `trace()`): roots are the six used
   vectors of each CPU ($FFF2-$FFFE; $FFFF entries are skipped), labels
   marked `"entry": true`, `code_ptrs` data ranges, and later the
   coverage addresses. Each path is decoded with `disasm()` from
   `tools/m6809dis.mjs` and followed through fall-through, branches and
   calls; it stops at RTS/RTI/PULS PC, unconditional jumps, annotated
   data, the vectors, or an address already decoded. An instruction that
   would overlap another one or data is not decoded (a *conflict*;
   there are none today).
3. **Direct page.** RESET starts with DP = 0, other roots with the
   annotation's `default_dp` (main/sub $10, sound $00). `LDA #n` /
   `TFR A,DP` (also via B, D) sets DP, `PSHS DP` / `PULS DP` is tracked as
   a stack, `EXG` or an unknown source makes it unknown. DP flows into
   branch and call targets. `"dp": {"addr": "HH"}` forces it. A second DP
   seen at the same address is flagged `[DP differs on another path]`
   (only reset_main, re-entered from the service mode).
4. **Computed jumps.** While tracing, the tool remembers constants loaded
   into A, B, X, Y, U (`LDx #n`, `LEAx n,PCR`), values fetched from a
   constant base (`LDX A,Y` with Y known), and AND masks on A/B scaled
   by later shifts. It recognises:
   * `JMP/JSR [A,X]` (any accumulator, X/Y/U) with a constant base: a
     table of code pointers;
   * `JMP/JSR ,X` or `TFR X,PC` where X came from `LDX A,Y`: the same;
   * `JMP [B,U]` where U came from `LDU A,U`: a two-level table (a table
     of pointers to code-pointer tables) - the main and sub game-mode
     schedulers;
   * `JMP [$nnnn]` through a pointer in ROM.
5. **Table size** (`sizeTables()`): an annotation count wins; otherwise
   the table ends at the first of: the AND-mask bound; the next traced
   code byte, data range or other table; the lowest address any entry
   points to above the table (code usually follows it); an entry that is
   not a plausible code address (outside the ROM, into the middle of an
   instruction or into data, or an undocumented opcode). Only entries
   inside the final extent are followed; the tool traces, sizes the
   tables, follows new entries and repeats until nothing changes. All
   44 tables found were reviewed by hand (`--tables` lists them).
6. **Coverage.** After the static trace settles, coverage addresses are
   traced too; what only they reach is marked "Found by the coverage
   input only" in the routine header.
7. **Render** every byte from the ROM start to $FFFF exactly once:
   instructions; annotated data ranges; dispatch tables as `FDB label`;
   the vectors; and the rest as `FCB`, 8 per line. Loose bytes after a
   label that something references are plain data; runs that start
   without any label are `[unreached]`; runs of 16+ `$FF` (or of `$00`
   where nothing refers) are `[fill $FF x n]`. Referenced data that is a
   run of zero-terminated game-text strings is shown as strings
   automatically.

## 3. Listing format

```
;------------------------------------------------------------------------------
; add_score  ($C1D6)
; <doc lines from the annotations>
; Called from: $D419 sub_D28A, $E6CA sub_E6C8
;------------------------------------------------------------------------------
add_score:
C1D6: F6 11 5F        LDB    $115F
C1DE: D6 2D           LDB    <cur_player     ; [$102D]
E002: B7 8C 00        STA    SRESET_ON       ; hold sub + sound CPUs in reset
                                             ; [$8C00]

; Referenced from: $C35D game_init
dat_C3C3:
;   "   50000"
C3C3: 20 20 20 35 30 30 30 30  FCB    $20,$20,$20,$35,$30,$30,$30,$30
```

* Columns: `ADDR: ` bytes (15 wide for code, 24 for data) instruction
  (MAME `6x09dasm` syntax, mnemonic padded to 7) `; comment` from column
  45. Every line is at most 79 columns; long comments continue on `;`
  lines at column 45, block comments are wrapped.
* Operands are shown with names: branch/call targets as labels; direct,
  extended, PC-relative and extended-indirect memory operands as RAM or
  hardware names (`IO56XX+$08`, `WSG+$1C`, `snd_request+22`); 16-bit
  index offsets only when they are video/sprite RAM (`TILE_ATTR,X`);
  `LDX/LDY/LDU/LDS #n` when n is a ROM label, a named RAM address or a
  video/I/O address. `LDD #n` is never named (it is a value, and the main
  CPU stores sub-CPU ROM pointers with it). The numeric address is kept
  in the comment as `[$nnnn]`, followed by a description for I/O
  registers. Direct-page operands always show the resolved address.
* Latches decoded by address lines show their name only
  (`IRQ_OFF_MAIN`, `WATCHDOG`, `SRESET_ON`, sub `IRQ_ON_SUB` for odd
  $6xxx and `IRQ_OFF_SUB` for even), with the real address in brackets.
  Reads of $7800-$7FFF are `WATCHDOG`, writes `IRQ_OFF_MAIN`.
* Notes: `[table name]` on a computed jump, `[indirect]` on a computed
  jump the tool could not resolve, `[undocumented]`, `[unreached]`,
  `[fill ...]`, `[DP differs on another path]`.
* Routine headers (a bar, name, doc, cross-references) precede vectors,
  call targets, table entries, seeds and documented labels. They list
  `Vector:`, `Called from:` (address and containing routine),
  `Jumped to from:` and `Table entry at:`. Data labels list
  `Referenced from:`.
* Labels: annotation names; otherwise `sub_XXXX` (routine), `lXXXX`
  (branch target), `tbl_XXXX` (dispatch table), `dat_XXXX` (referenced
  data), `<vector>_<cpu>` for vector targets. The top of each listing has
  `EQU` lines for every hardware and RAM symbol it uses.

## 4. Annotation files (`reference/annotations/<cpu>.json`)

All addresses are hex strings without `$` (`"E000"`), in the CPU's own
address space. Every key is optional.

```json
{
  "default_dp": "10",
  "header": ["lines for the top of the listing"],
  "labels": {
    "C1D6": "add_score",
    "E000": {"name": "reset_main", "doc": ["routine header text"],
             "entry": true, "dp": "00"}
  },
  "comments": {"E002": "comment on this instruction or data line"},
  "blocks":   {"E013": ["comment lines printed before this line"]},
  "dp":       {"C000": "10"},
  "noreturn": ["F123"],
  "inline":   {"F456": 2},
  "tables":   {"FEC0": {"count": 10, "sub": [12, 15, 14]}, "C45F": 4},
  "data": [
    {"addr": "C399", "len": 42, "type": "ptrs", "per": 2,
     "name": "hiscore_init_table", "comment": "tile address, string"},
    {"addr": "C1CA", "end": "C1D5", "type": "strings", "term": "00",
     "reverse": true}
  ],
  "ram": {"102F": {"name": "game_mode", "size": 1, "comment": "..."}}
}
```

* `labels`: a string is just a name. `doc` lines go into the header,
  `entry: true` makes the address a trace root (with `dp`, else
  `default_dp`).
* `noreturn`: calls to these addresses do not come back (the trace stops
  after the JSR). `inline`: calls to the routine are followed by N bytes
  of inline arguments that the trace skips. (Neither is needed yet.)
* `tables`: pin a dispatch table's entry count (and for a two-level
  table, the sub-table counts), overriding the heuristics.
* `data.type`: `bytes` (FCB, `per` per line, default 8), `words` (FDB
  numbers, default 4 per line), `ptrs` (FDB with ROM labels; the data
  they point to gets `dat_` labels), `code_ptrs` (like `ptrs`, and every
  entry is traced as code with the region's `dp`), `text` (FCB with the
  decoded text above it), `strings` (`head` header bytes, then text up to
  and including the `term` byte, repeated; `reverse: true` for strings
  stored right to left). The range is `addr` + `len` or `addr`..`end`
  inclusive; `name`/`doc` label its start. Data ranges are never traced
  as code.
* `ram`: names for RAM. Main and sub share $0000-$1FFF; the sound CPU's
  $0000-$03FF is main $6000-$63FF, so sound-file entries are converted to
  main addresses in `symbols.json` (and shown in sound addresses in the
  sound listing). The same address may appear in several files only
  with the same name. `size` > 1 lets `name+n` cover the following bytes.

## 5. Coverage input (`reference/coverage/<cpu>.json`)

Produced later by the oracle board. Either a plain JSON array of
executed instruction addresses, or an object:

```json
{
  "cpu": "main",
  "source": "free text: how it was recorded",
  "executed": ["C000", "C003", 49158],
  "dp": {"D04C": "10"}
}
```

Addresses are the first byte of each executed instruction (numbers or
hex strings), in any order, duplicates allowed. `dp` optionally gives the
DP register seen at an address (else `default_dp`). Only addresses the
static trace missed matter; listing every executed PC is fine. The
generator traces from each one after the static pass; the header of each
new routine says "Found by the coverage input only". A coverage address
that lands inside a decoded instruction or inside annotated data shows up
as a conflict (`--tables` prints them): that means an annotation is wrong.

## 6. `symbols.json`

```json
{
  "main":  {"label": 57344, ...},
  "sub":   {...}, "sound": {...},
  "ram":   {"game_mode": 4143, ...},
  "io":    {"IO56XX": 26624, "sub:IRQ_ON_SUB": 24577, ...},
  "ram_comments": {"game_mode": "..."}
}
```

Numbers are addresses. `ram` and `io` are main-CPU addresses; `io` keys
prefixed `sub:` / `sound:` are in that CPU's space. Every label in a
listing (including `sub_`, `l`, `tbl_`, `dat_`) is in its CPU's table.

## 7. Game text encoding

The character ROM (gp2-5.8s, see `assets/tiles.png`) is ASCII-ordered
for the common characters, so most strings are readable ASCII in the
ROM: $20 space, $30-$39 digits, $41-$5A letters. Punctuation has its own
codes: $3B `-`, $3C `x` (multiply), $3D `=`, $3E `/`, $3F `?`, $5B `.`,
$28 copyright, $68/$69 open/close double quotes, $6A/$6B single quotes,
$29-$2F the "namco" logo, $5C-$5F part of a logo, $60-$62 ship/ball
icons, $64-$67 frame corners. Codes $80-$FF repeat the set; tile codes
256-511 (attribute bit 7) are graphics.

Strings are zero-terminated. Most are printed going right on the
screen, which is *decreasing* tile addresses in the playfield
(`LEAX -$20,X` per character, e.g. `print_string`, `print_string_attr`).
On the top and bottom two rows tile addresses run the other way, so
text printed there with `STA ,X+` is stored reversed in the ROM ("TIDERC"
= CREDIT, "DEMMAJ NIOC" = COIN JAMMED); those ranges are annotated
`reverse: true` and shown readable. "1984 NAMCO ALL RIGHTS RESERVED"
appears, never printed, at main $DFAE and $FFD0 and sub $BF8B.

## 8. ROM maps

Code/data split from the static trace (code bytes / data bytes):
main 13945 / 10631 (742 unreached), sub 7723 / 16853 (353 unreached),
sound 957 / 7235.

### Main CPU ($A000-$FFFF)

| range | contents |
|-------|----------|
| $A000-$AFBD | data: tile-position patterns ($A000, 8 patterns), stage/demo data, the demo input scripts ($AADA, $ACBC), attract texts |
| $AFBE-$B6B9 | high score check and name entry (mode 9), its screens and strings |
| $B6F6-$BE77 | service mode: RAM/ROM/chip tests, DIP display, sound test, easter egg; `delay_65536` at $BE25 |
| $BE78-$BFFF | easter egg bitmap, fill, checksum byte $BFEF |
| $C000-$C1D5 | `irq_main`, round select, coin jammed |
| $C1D6-$C295 | scoring: `add_score`, `update_hiscore`, BCD digit helpers |
| $C296-$C466 | `game_init` (62XX init, header, high score table), `attract_loop` |
| $C467-$CCCF | attract phases and push-start screens, their texts |
| $CCD0-$D079 | game start, `task_move_player`, demo input |
| $D07A-$DFFF | IRQ timers, the common play tasks (fire, shots, ...), stage start, player death / next player / game over flow ($DB00-$DEFF), sound helpers, sprite shadow clearing, checksum byte $DFFF |
| $E000-$E222 | `reset_main`, DIP tables, coinage |
| $E223-$EA88 | challenging-stage results and bonus texts ($E86C-$EA20) |
| $EA89-$ECA3 | stage event tasks |
| $ECA4-$F4A4 | data: stage parameter tables used by `load_stage_params` |
| $F4A5-$FEAF | `load_stage_params`, effects, bonus life, operator stats and other tasks |
| $FEB0-$FFCF | `task_dispatch` and the ten mode task lists |
| $FFD0-$FFFF | copyright text, checksum byte $FFEF, vectors |

### Sub CPU ($A000-$FFFF)

| range | contents |
|-------|----------|
| $A000-$B013 | data: enemy flight paths and movement tables |
| $B014-$BF8A | enemy movement, object state machines (`task_animate_objects`) and other tasks |
| $BF8B-$DFFF | copyright text, then about 8 KB of path/formation data |
| $E000-$E17E | `reset_sub`, `irq_sub`, `task_dispatch_sub`, mode task lists |
| $E17F-$FEEB | tasks and their tables (stage setup, formation, attacks) |
| $FEEC-$FFFF | data, checksum byte $FFEF, vectors |

### Sound CPU ($E000-$FFFF)

| range | contents |
|-------|----------|
| $E000-$E054 | `reset_sound` |
| $E055-$E232 | `irq_sound` (shadow to WSG, 26 request slots) |
| $E233-$E3D4 | `play_sound`, envelopes, `next_note`, stream commands |
| $E3D5-$E6D7 | per-sound tables: first voice, tempo, channel block, header; headers; envelopes; frequency table pointers |
| $E6D8-$FFEE | frequency tables and note streams |
| $FFEF-$FFFF | checksum byte, vectors (only RESET and IRQ used) |

## 9. What the code does (first pass)

### Boot and handshakes

Main (`reset_main`, $E000): SRESET on, FRESET off, IRQ off, DP $10,
S $1600; 56XX command 1 / 58XX command 0; clear tilemap and RAM; 62XX
bytes 8-15 = 4..$0B; custom-chip self-check (56XX mode 8 = $69, 58XX
mode 5 = F,F, 62XX = F,E,1; failure hangs at $E0C5 with an error code in
D); release SRESET; `$11` to $6040 and $0800, wait for `$22` from sound
and sub (their ROM checksums done); read switches and DIPs, decode them;
service switch -> `service_mode`; FRESET pulse and coinage (56XX mode 2);
`game_init`: 56XX mode 4 for good, header texts, IRQ on, 62XX init
(modes 1, 2, 0, 3 separated by CWAI), high score table, starfield on,
then `attract_loop`. Waits between chip commands use `delay_65536`.

Sub (`reset_sub`): DP $10, S $1D80, wait for `$11` in $0800, checksum
its three ROMs ('6'/'5'/'4' in $0801 on error), `$22`, then 256 x
(`STA $6001`, `STA $500F`), interrupts on, scheduler.

Sound (`reset_sound`): IRQ latch off, wait for `$11` in $0040,
checksum ($0380 = 1 on error), `$22`, clear $0000-$02FF, tempo table to
$00A0, S $0400, IRQ on, `BRA *`.

### Per-frame structure

All three CPUs run from the vblank IRQ.

* **Main IRQ** (`irq_main`): watchdog + acknowledge; operator stats
  (SW1:6 + P1 fire held: play clock and counters on screen); demo
  sound gate; service switch -> service mode; coin-jam check; round
  select DIP; IRQ latch re-enabled early; play clock and blink; flip
  flag; coin arrival (sound request $16 is a counter; during the demo
  it restarts attract from inside the IRQ); **sprite copy** of the main's
  shadow entries into sprite slots 40-63; starfield direction; frame
  counter $1016 (+ $1015); **rendezvous**: wait for `frame_sync` ($10AF)
  = $11 from the sub, answer $22, RTI.
* **Sub IRQ** (`irq_sub`): acknowledge; **sprite copy** of shadow
  $0E00-$0EE1 into slots 1-39 (entry 0 is the player); `frame_sync` =
  $11 and wait for $22. The two IRQ handlers therefore meet every frame.
* **Sound IRQ** (`irq_sound`): shadow -> WSG, then each requested sound
  one step.

### Foreground: the game-mode schedulers

Both main and sub run a cooperative per-frame scheduler: `game_mode`
($102F, shared) selects a task list, `main_task` ($1030) / `sub_task`
($107A) index it (`task_dispatch` $FEB5, `task_dispatch_sub` $E0EC).
Each task does its work and `INC`s the index and jumps back to the
dispatcher; the last task of every list (`task_end_frame`,
`task_end_frame_sub`) does `CWAI #$EF`, resets the stack and restarts
the list next frame. Tasks switch modes by writing $102F (both CPUs do).
Modes (tentative names except where noted): 0 stage start ("PARSEC nn",
`task_stage_start`), 1-4 stage entry phases, 5 normal play (longest
lists; a new ship after death returns here), 6 stage clear
(`task_stage_clear`: next stage, back to mode 0), 7 challenging stage (set by `task_stage_start` for stages 3, 8, 13, ...),
8 challenging-stage results, 9 game over / high score entry.

Outside the scheduler the main CPU runs `attract_loop` ($C417): credit
display, push-start screens (`push_start_1p`/`_2p`, start via 56XX
nibble 3), and attract phases 0-3 selected by `attract_phase`; phases 1
and 3 start a demo game (`attract_flag` $09F4 = 1) whose joystick and
fire come from a recorded input script (`demo_input`).

### I/O chips

Coins, credits and starts are counted by the 56XX in coin mode (mode 4):
the game reads the BCD credit count ($6800/$6801), "credits added"
($6802, cleared by the IRQ) and "credits used" ($6803, a start press).
Joystick nibbles $6804/$6806 and fire/start $6805/$6807 (bit 1 fire,
bit 3 start) are read by `task_move_player` and `task_player_fire`
(P2's on a cocktail cabinet, `flip_screen` $102C). DIPs are read once at
boot (and in the service mode) from the 58XX in mode 4; the IRQ re-reads
the service switch ($6814 b3) and round advance ($6813 b3); the demo
sounds bit ($6817 b3, the same nibble as $6816) and SW1:6 ($6816 b2)
are read live.

### Randomness (no RNG routine)

There is **no pseudo-random number generator** and nothing
cycle-dependent like the Z80 `R` register. Randomness comes from
`frame_counter` ($1016), incremented once per frame by the main IRQ and
cleared at stage starts (`task_next_mode` $D15B, sub $F600): tasks use
`frame_counter & mask` directly (sub $B9BD, $BA8E, $E34E, $EAC0, ...),
the sub CPU indexes **its own code** at $E000 + frame_counter as a noise
table (`object_spawn_random` $B936, like Galaga's RNG reading its task
manager), and the main CPU mixes the stage number and a score digit
(`LDA <stage / ADDA score_p1` at $FE41). Everything is deterministic
given the frame sequence, so the port needs no replay hook - but see the
open question on when the sub reads $1016 relative to the main IRQ's
increment.

### Scores

Scores are 3 BCD bytes, least significant first (`score_p1` $09B0,
`score_p2` $09B3); the high score is most significant first ($09B6).
`add_score` adds A (BCD tens of points) with DAA carries, calls
`update_hiscore`, and redraws the digits as tiles through
`bcd_hi_to_char`/`bcd_lo_to_char` (digit + $30; A-F above 9). The high
score table at $0900 stores the 8 score digits as tile codes, the names
at $0950. `task_bonus_life` compares score bytes with the DIP bonus
settings ($1001-$1003).

### Text printing

`print_string` ($BA2F: X string, U tile address), `print_string_r`
($C639: U string, X tile), `print_string_attr` ($E85C: also writes
attribute B) and many inlined copies of the same loop. Tables of
(tile address, string pointer) pairs ending in 0 (e.g.
`hiscore_init_table` $C399, $B070, $B164) drive multi-line screens.

### Sprites

Sprites are built in three shadow banks with the sprite RAM layout
(`sprite_shadow_1` $0E00 code/colour, +$0800 Y/X, +$1000 flags; 154
entries to $0F33). Bit 7 of an entry's flag byte means "in use". The sub
IRQ copies in-use entries 0-112 to sprite slots 1-39, the main IRQ
entries 113-153 to slots 40-63, both mirroring Y ($E0/$D0 - y) and X
($1A0 - x, complemented) when the screen is flipped; leftover slots are
parked off screen. Slot 0 is never written by either.

### Sound driver

The main CPU is the only one that can reach the sound RAM. It requests
sound n (0-25) by writing 1 to `snd_request+n` ($6040+n; `INC` for the
coin sound $16, which the driver counts down). Each sound owns a range
of WSG voices (`sound_voice`), a channel block in RAM (17 bytes per
voice, `sound_channels`) and a header of (note stream, frequency table)
pairs. `play_sound` steps each voice once per frame: a volume envelope
(levels then an op byte $10/$12/$14/$16), and a note stream of notes
(pitch nibble + octave shift, length x tempo), rests ($Cx) and commands
$F0-$F7 (end, waveform, envelope, loops, jump). Results go to the voice
shadow $0080 (vol, freq lo, mid, hi|wave), which the next IRQ copies into
WSG registers 3-6 of each voice. Sounds 1, 7 and $0A-$0E are retriggered
by a new request; the others play while requested. `sound_all_off`
($DF19) clears every request.

## 10. RAM map (named so far)

Main-CPU addresses. Main and sub share $0000-$1FFF.

| address | name | notes |
|---------|------|-------|
| $0000-$07FF | TILE_RAM / TILE_ATTR | tilemap |
| $0800 | sub_handshake | $11/$22 boot handshake, $33 at game start |
| $0801 | sub_rom_error | '4'-'6' |
| $0900-$094F | hiscore_table | 5 x 16, 8 score digits as tiles |
| $0950-$099F | hiscore_names | 5 x 16, 14 characters |
| $09A2-$09A8 | entry_* | name entry cursor, timer, rank, music request pointer |
| $09B0 / $09B3 | score_p1 / score_p2 | 3 BCD bytes, low first |
| $09B6 | hiscore | 3 BCD bytes, high first |
| $09D6-$09DF | stats_counters | bookkeeping |
| $09F0-$09F5 | demo_* , attract_flag | demo input script state; $09F4 = attract |
| $09F8-$09FB | clock_* | BCD play clock (frames, s, min, h) |
| $09FC-$09FE | p1_time | |
| $0E00-$0F33 | sprite_shadow_1 | + $0800 / + $1000 banks |
| $0F80-$0FFF, $1780-$17FF, $1F80-$1FFF | SPRITE_RAM_1..3 | hardware sprites |
| $1000-$1005 | lives_setting, bonus_*, difficulty, cabinet | from the DIPs |
| $1006-$1009 | boot_switches | |
| $1015 / $1016 | frame_hi / frame_counter | the randomness source |
| $1025-$1028 | coinage_a / coinage_b | |
| $1029-$102B | attract_timer/step/phase | |
| $102C-$102E | flip_screen, cur_player, two_players | |
| $102F / $1030 / $107A | game_mode / main_task / sub_task | schedulers |
| $1035 | stage | effective stage (< 60) |
| $10AF | frame_sync | IRQ rendezvous |
| $1104-$1107 | lives_p1/p2, stage_p1/p2 | |
| $1600 / $1601 | player_y / player_x | shadow entry 0 |
| $1600 (down) | main stack (S = $1600) | |
| $1860-$188C | formation_flags | b0 occupied |
| $1D80 (down) | sub stack | |
| $6040-$605F | snd_request | sound $0040 |
| $6060-$607F | snd_active | sound $0060 |
| $6080-$609F | wsg_shadow | sound $0080 |
| $60A0-$60BF | snd_tempo | sound $00A0 |
| $60C0-$60C3 | snd_current, snd_voice, snd_irq_done, snd_temp | |
| $6100-$63xx | sound channel blocks | 17 bytes per voice |
| $6380 | snd_rom_error | sound $0380 |
| $0400 (down) | sound stack (sound S = $0400 = main $6400) | |

## 11. Open questions

* **Modes 1-4**: what exactly distinguishes them (entry waves?). The
  sub's mode 2 task ends by moving to mode 3. Needs the oracle's
  `game_mode` trace.
* **Sub reading `frame_counter`**: the main IRQ increments $1016 near its
  end, after the sub IRQ may already have started its tasks. Whether a
  sub task sees the old or new value can depend on interleaving; check
  with the oracle before relying on frame order in the port.
* **Unreached code** that disassembles cleanly: main $D04C-$D079,
  $E5DC-$E5F2, $F924-$F9CF (skipped by `JMP $F9D5` at $F921). Dead
  code, or reached through pointers held in RAM?
  The coverage input will tell.
* **Sprite slot 0** is never written by either IRQ copy; is it used?
* **$0C00-$0C03**, **$1E31+2n** cleared in the IRQ, many sub RAM
  variables ($1080-$10FF), and the enemy path data format in the sub ROM
  are not yet understood.
* **Sound numbers**: which of the 26 sounds is which effect (request
  sites are in the listing as `snd_request+n`); sound 0 is the start
  tune, 3/4 the high-score music, $16 the coin sound, $15 is requested
  on extra lives and shots use 1 and 7.
* The sub CPU's 256 writes to **$500F** and the sound CPU's write to
  **$2007** (a watchdog kick with an odd address) at boot.
* SW1:6 is not "unused": it enables the operator stats display.

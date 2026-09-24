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
| `tools/js-routines.mjs` | finds the JS function (name, file) of every routine the port registers (the generator adds the sound CPU's registry, `SOUND`/`SOUND_AT`) |
| `reference/gaplus-main.asm` | main CPU, $A000-$FFFF (generated) |
| `reference/gaplus-sub.asm` | sub CPU, $A000-$FFFF (generated) |
| `reference/gaplus-sound.asm` | sound CPU, $E000-$FFFF (generated) |
| `reference/symbols.json` | labels, RAM and I/O names (generated) |
| `reference/annotations/{main,sub,sound}.json` | the human knowledge: names, comments, seeds, data formats, RAM names |
| `reference/annotations/proposed/*.json` | names proposed by the porters (merged into main/sub.json on 2026-09-23; kept for reference) |
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
  call targets, table entries, seeds, documented labels and every
  address the JS port implements. They list
  `Vector:`, `Called from:` (address and containing routine),
  `Jumped to from:` and `Table entry at:`. Data labels list
  `Referenced from:` (address and the routine containing it, or for a
  reference from inside a data region such as a pointer table the
  nearest data label before it).
* **JS cross-reference.** A routine the port registers in `MAIN_AT` /
  `SUB_AT` has, right under its name, the file that implements it, and
  its JS name when that differs from the label:

  ```
  ; formation_path_step  ($B0D4) ; JS: sub_B0D4
  ; -> src/game/sub/gp2_8_formation.js
  ```

  The porters exported every routine under the listing label it had
  when they ported it (`sub_B0D4`, `lD9CF`, ...), and other modules and
  the tests call it by that name, so **labels may be renamed but JS
  functions are not**: search the JS for the name after `JS:`.
  `tools/js-routines.mjs` finds them by importing `src/game/{main,sub,
  sound}/index.js` (else each `gp2_*.js`) and walking `MAIN_AT`/
  `SUB_AT`/`SOUND_AT`: the name is the function's key in `MAIN`/`SUB`/
  `SOUND`, the file the one whose source defines a function (or
  `const`) of that name. The listings therefore change when the port
  adds or drops a routine (`--check` reports them stale). All 20 sound
  routines are in `src/game/sound/gp2_1.js`; only `env_op_ramp` has a
  different JS name (`env_op_hold`).
* **Quirks.** ROM bugs and odd behaviour the port reproduces on purpose
  are marked `BUG:` (a mistake in the ROM: wrong register stored,
  overrun, lost result) or `QUIRK:` (surprising but harmless or
  deliberate) in a line comment at the instruction, or in the routine
  header when it spans several places. Section 12 indexes them.
* Labels: annotation names; otherwise `sub_XXXX` (routine), `lXXXX`
  (branch target), `tbl_XXXX` (dispatch table), `dat_XXXX` (referenced
  data), `<vector>_<cpu>` for vector targets. Every label is unique within
  its listing (tested). Named data tables document their format in the
  label's doc: `path_XXXX` (sub flight-path streams, format in
  docs/modules/sub-C.md), `heading_table` (sub $AAFF), `formation_path`
  (sub $ADCF), `demo_script_1/2` (main $AADA/$ACBC), the stage parameter
  tables `stage_*` (main $EE84-$F496), the string tables
  (`hiscore_screen_text`, `str_*`, `alphabet_*`). The top of each listing has
  `EQU` lines for every hardware and RAM symbol it uses, with the
  listing's own annotation comment when it has one (else the shared
  one).
* **Sound data** (the `sounds` annotation, section 4) is decoded rather
  than dumped: `hdr_<sound>` headers (one `FDB <stream>` + `FCB table`
  per voice, `$11` end), note streams `<sound>_v<k>` (the first header
  voice that points there; jump and loop targets inside streams are
  `lXXXX`), envelopes `env_0`..`env_30` with the decoded levels,
  frequency tables `freq_low` / `freq_a440` / `freq_high` with each
  note's pitch in Hz, and `unused_XXXX` for streams no header points
  to. In a stream, `waveform w, envelope e` is the stream's first two
  bytes; consecutive notes are packed four to a line as `pitch:length`
  (`C6:4` = C6 for 4 x tempo frames, `-:6` a rest); commands get one
  line each (`waveform`, `envelope`, `repeat from X: n passes (+C)`,
  `to X every n passes (+F)`, `to X on pass n only (+E)`, `jump X`,
  `end`). The irq_sound slot of sound n is `slot_<sound>`.

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
* `sounds` (sound.json only): where the sound driver's tables are and
  what each sound is:

  ```json
  "sounds": {
    "headers": "E43D", "voices": "E3D5", "tempo": "E3EF",
    "channels": "E409", "envelopes": "E5D2", "env_count": 31,
    "freq_tables": "E6D2", "freq_count": 3,
    "freq_names": ["freq_low", "freq_a440", "freq_high"],
    "retriggered": [1, 7, 10, 11, 12, 13, 14],
    "orphans": ["F0FE"],
    "names": [{"name": "start_tune", "doc": ["what it is, who asks"]}]
  }
  ```

  `soundData()` in the generator walks the headers (one per entry of
  `names`), every stream they point to and every jump/loop target, the
  envelopes and the frequency tables; `orphans` are streams to decode
  that nothing points to. Each header's doc gets a generated line with
  its WSG voices, tempo, channel blocks and held/retriggered. A walk
  that lands inside an item decoded by another walk stops the generator
  (the data would be ambiguous).
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
  "ram_comments": {"game_mode": "..."},
  "js": {"sub": {"B0D4": {"label": "formation_path_step",
                          "jsName": "sub_B0D4",
                          "file": "src/game/sub/gp2_8_formation.js"}},
         "main": {...}}
}
```

Numbers are addresses. `ram` and `io` are main-CPU addresses; `io` keys
prefixed `sub:` / `sound:` are in that CPU's space. Every label in a
listing (including `sub_`, `l`, `tbl_`, `dat_`) is in its CPU's table.
`js` maps each main/sub routine address the port implements (hex) to
its listing label, the JS function name and file; tests that look a
routine up by its JS name can use it (the main-E harness adds the JS
names to its label table this way).

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
main 13945 / 10631 (742 unreached), sub 7723 / 16853 (308 unreached),
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
| $A000-$B013 | data: flight-path streams (`path_A44B`, `path_A573`...), homing octant tables `home_octants_*`, `heading_table` ($AAFF, 180 x 4 bytes), `formation_path` ($ADCF) |
| $B014-$BF8A | enemy movement, object state machines (`task_animate_objects`) and other tasks |
| $BF8B-$BFFF | copyright text, $FF fill, checksum byte |
| $C000-$DFFF | no code: 46 flight-path streams `path_C000`...`path_DE08` (format: docs/modules/sub-C.md), a second copyright string, checksum byte $DFEF |
| $E000-$E17E | `reset_sub`, `irq_sub`, `task_dispatch_sub`, mode task lists |
| $E17F-$FEEB | tasks and their tables (stage setup, formation, attacks) |
| $FEEC-$FFFF | data, checksum byte $FFEF, vectors |

### Sound CPU ($E000-$FFFF)

| range | contents |
|-------|----------|
| $E000-$E054 | `reset_sound` |
| $E055-$E232 | `irq_sound` (shadow to WSG, 26 request slots `slot_*`) |
| $E233-$E3D4 | `play_sound`, `play_voice`, envelope ops, `write_shadow`, `next_note`, stream commands, `op_end` |
| $E3D5-$E470 | per-sound tables: `sound_voice`, `tempo_init`, `sound_channels`, `sound_headers` |
| $E471-$E5D1 | the 26 headers `hdr_*` |
| $E5D2-$E6D1 | `envelopes` (31 pointers) and the envelopes `env_*` |
| $E6D2-$E746 | `freq_tables`: `freq_low`, `freq_a440`, `freq_high` (12 notes + an unused $00 each) |
| $E747-$FA3D | note streams (`<sound>_v<k>`); $F0FE-$F23B five streams no header uses (`unused_*`) |
| $FA3E-$FA5B | "1984 NAMCO ALL RIGHTS RESERVED" (`copyright_text`) |
| $FA5C-$FFEE | $FF fill |
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
(`task_stage_clear`: next stage, back to mode 0), 7 challenging stage
(set by `task_stage_start` for the 0-based stage indexes 2, 7, 12, ...
in `challenging_stages`, i.e. PARSEC 3, 8, 13, ...),
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
manager; `LDA A,X` is a **signed** offset, so frame_counter $80-$FF reads
$DF80-$DFFF, gp2-7's $FF fill and its checksum byte, not $E080-$E0FF), and the main CPU mixes the stage number and a score digit
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

Ported as `src/game/sound/gp2_1.js` (cycle-exact, docs/modules/
integration.md); every routine header in `gaplus-sound.asm` names it.

**Requests.** Only the main CPU reaches the sound RAM (main $6000-$63FF
= sound $0000-$03FF). It requests sound n (0-25) by writing 1 to
`snd_request+n` ($6040+n); the coin sound $16 is `INC`ed per credit
and counted down by `op_end`, so it plays once per coin. The sub CPU
writes the same pattern into a queue at $0840+n, which the main task
`task_sound_queue` ($D8B0) forwards (1 per non-zero byte, queue
cleared) unless `player_dying`, when it clears every request except $14
and $16. `sound_all_off` ($DF19) clears all requests and active flags,
`sound_demo_gate` ($DF27) the ones the demo may not play.

**Held and retriggered.** Sounds 1, 7 and $0A-$0E are retriggered:
`irq_sound` consumes the request, clears `snd_active+n` and restarts
the sound, which then runs on while `snd_active+n` is set. All others
are held: they play while `snd_request+n` is set, which stays set until
the stream ends (`op_end` clears it); a held sound requested every
frame (8, 9, $10, $11, $18) therefore restarts each time it ends. The
main CPU stops a held sound early by clearing both bytes (e.g. $E36F,
$C07A). QUIRK (sub side): the sub's `CLR $0850/$0870` ($E6D3), `CLR
$0851/$0871` ($B623) and `CLR $0852/$0872` ($B577) only cancel a
request not yet forwarded (and nothing ever writes the queue's
$0860-$087F), so those sounds play to the end of their streams.

**Per frame** (`irq_sound`): the voice shadow `wsg_shadow` ($0080, per
voice: volume, freq bits 0-7, 8-15, 16-19 | waveform << 4) goes to WSG
registers 8v+3..8v+6 and is cleared; then sounds 0-25 in order each run
one frame (`play_sound`); a later sound overwrites the shadow of a
voice it shares with an earlier one, so it wins; `snd_irq_done` = 1
(never read).

**A sound** owns WSG voices `sound_voice[n]` + k, a 17-byte channel
block per voice at `sound_channels[n]` (`snd_blocks`, $0100-$0352;
layout in the `play_sound` header) and a header `hdr_<name>`: per voice
a note stream pointer and a frequency table number, $11 ends. On the
first frame `play_sound` builds the blocks and fetches each voice's
first note; each frame `play_voice` steps every voice's volume envelope
and note stream and writes the shadow (`write_shadow`).

**Note streams.** Two bytes first: waveform (bits 4-6) and envelope.
Then events: a note `$pn len` (p = entry 0-11, A..G#, of the voice's
frequency table; n = octave shift right; `len` x the sound's tempo
`snd_tempo+n` = frames, low byte of the MUL), a rest `$Cx len`, or a
command: $F0 end (`op_end`: clear the request, count the coin down,
clear `snd_active+n`, return straight to `irq_sound`), $F1 w waveform,
$F2 e envelope, $F3 n addr repeat (jump back until counter +C = n),
$F4 n set +D (makes $F3 pass; unused), $F5 n addr (jump on pass n of
+E only), $F6 n addr (jump every n passes of +F, cleared), $F7 addr
jump. The listing decodes every stream (`C6:4`, `-:6`, section 3).

**Envelopes** (`env_0`..`env_30`): levels 0-$F, one a frame, restarted
by every note; then $10 sustain the last level, $12 sustain but no
louder than the frames left in the note (fade at its end), $14 repeat,
$16 n ramp: down one step a frame from the previous level to n
(`env_op_ramp`, JS `env_op_hold`).

**Frequency tables:** `freq_a440` is equal temperament at A = 440 Hz
(A7 = 3520 Hz at shift 0; tone = freq x 24000 / 2^20 Hz); `freq_low`
and `freq_high` are the same scale 12 cents flat and sharp, used by
doubled voices for a chorus effect.

**The 26 sounds.** Found from the request sites in the main and sub
listings and by logging every write to $6040-$6059 and the queue with
the game mode while the port ran the attract mode, a coin-and-start
game with a random player, and the challenging stage (Round Advance);
"frames" is the length of one play from a single request (the port's
`irq_sound` run alone). Blocks = `sound_channels[n]`.

| n | name | what requests it | voices | tempo | frames |
|---|------|------------------|--------|-------|--------|
| 0 | start_tune | game start ($CE17, the main waits at $CE7F); demo start | 0-7 | 2 | 384 |
| 1 | shot | fighter shot ($D1B5); R | 0-3 | 1 | 18 |
| 2 | challenge_tune | stage clear before a challenging stage ($D6E3) | 1-6 | 1 | 144 |
| 3 | entry_tune_1st | TOP 5 name entry, rank 1 ($B52F) | 0-6 | 3 | 576 |
| 4 | entry_tune | TOP 5 name entry, ranks 2-5 | 0-6 | 1 | 960 |
| 5 | stage_tune | "PARSEC nn" stage start: after the start tune, stage clear, ship lost, results | 1-6 | 2 | 108 |
| 6 | payout_tune | challenging-stage results pay-out (payout_lucky/byebye) | 0-5 | 7 | 280 |
| 7 | shot_upgraded | shot of the upgraded fighter ($0EA2 not $2F, $D1BB); R | 0-3 | 1 | 31 |
| 8 | button_wait | results: every frame until fire is pressed ($E35F) | 4-7 | 5 | 20 |
| 9 | formation_hum | sub: every frame while the formation is assembled ($E34B) | 4-7 | 2 | 168 |
| $0A | hit_challenge | hit in a challenging stage ($D3F1), last results hit; R | 4-7 | 3 | 39 |
| $0B | hit | enemy hit ($D3F8), captured ship shot ($FA57); R | 5-7 | 2 | 28 |
| $0C | flyin | sub: enemy flying into the formation; R | 5 | 1 | 87 |
| $0D | dive | sub: enemies launched to attack; R | 5 | 1 | 104 |
| $0E | special_object | sub: the object at formation slot 42 starts; R | 4-5 | 1 | 89 |
| $0F | object_spawn | sub: object_spawn_random | 2-5 | 1 | 120 |
| $10 | capture | sub: task_capture_steer, bonus_seq_fall (every frame) | 2-3 | 4 | 120 |
| $11 | effect_rise | sub: power-up effect 0 (effect_rising) | 2-3 | 5 | 120 |
| $12 | effect_spread | sub: power-up effect 1 (effect_sequence) | 1-3 | 5 | 120 |
| $13 | powerup | sub: fighter upgrade, effects 2-5 (effect_setup) | 2-3 | 1 | 72 |
| $14 | player_explode | the fighter explodes ($DA0B) | 0-7 | 3 | 540 |
| $15 | extra_ship | bonus life, pay-out extend, bonus ship caught, sub $F789 | 0-3 | 6 | 72 |
| $16 | coin | each credit (irq_main $C05C, a count) | 0-3 | 2 | 74 |
| $17 | count_tick | results: one hit counted ($E2B2) | 0-3 | 1 | 4 |
| $18 | star_warp | starfield event, mode 1 ($EAD7, 60 frames) and mode 5 ($EBA0) | 3-7 | 4 | 960 |
| $19 | bonus_ship | the bonus ship appears ($FE6A) | 4-7 | 1 | 35 |

R = retriggered. Five streams at $F0FE-$F23B (a five-voice piece,
waveform 2/5, `unused_*`) are never played: no header points to them.

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
| $0840-$087F | (sound queue) | the sub CPU's requests, $0840+n = sound n; forwarded by task_sound_queue |
| $6000-$603F | WSG | 15XX registers, 8 per voice (sound $0000) |
| $6040-$605F | snd_request | sound $0040: sound n requested (1; $16 a coin count); +0 boot handshake |
| $6060-$607F | snd_active | sound $0060: sound n started (blocks built) |
| $6080-$609F | wsg_shadow | sound $0080: vol, freq lo, mid, hi\|wave per voice; to the WSG each IRQ |
| $60A0-$60BF | snd_tempo | sound $00A0: frames per note-length unit (tempo_init) |
| $60C0 / $60C1 | snd_current / snd_voice | sound and WSG voice being played |
| $60C2 / $60C3 | snd_irq_done / snd_temp | 1 after every IRQ (never read) / scratch (pitch x 2, ramp end) |
| $6100-$6352 | snd_blocks | channel blocks, 17 bytes per voice (layout: play_sound) |
| $6380 | snd_rom_error | sound $0380 |
| $0400 (down) | sound stack (sound S = $0400 = main $6400) | |

Named from the port (docs/modules/*.md; each name has a one-line
meaning in the annotation files, the listings' `EQU` lines and
`symbols.json` `ram_comments`):

| address | names | what |
|---------|-------|------|
| $09A0, $116C-$116D | entry_blank_ptr, entry_char_index, entry_repeat | name entry |
| $09FF | stats_blank_count | operator stats |
| $100A | stage_text_timer | also the service-mode sound-test number |
| $1017-$101E | score_parity, seq_step, bonus_anim_idx, score_anim_step | sub bonus / score sequences |
| $1023-$1024, $10AB, $112A | ready_timer_p1/p2, ready_timer, ready_active | READY message ($112A = $55 also allows formation attacks) |
| $1036-$1059 | stage_params | load_stage_params: attack counts, launch thresholds, dive paths |
| $1066, $1112-$1113, $1131 | boss_bonus_idx, boss_chain, hit_points, boss_chain_timer | boss hit chain |
| $1071, $10F8-$10FF | refill_left, refill_* | formation refill |
| $1074, $1114-$1118, $1176 | bonus_slots_used, bonus_obj_*, escort_step, wing_*, score_anim_done | sub sequences |
| $1076, $10C2-$10CA | shots_to_clear, shot_ptr, slot_index, hit_diving, hitbox, hit_xhi | task_shot_hits |
| $1081-$1082, $10AC, $10BF, $1688-$1689 | stage_setup_pass, formation_path_ptr, formation_started, formation_sprites_dirty, formation_y/x | the formation block |
| $1096, $111D-$1120, $1132-$113E, $115A | formation_slot, object_state, bonus_state, bonus_free, challenge_step | sub objects and challenging stage |
| $10B0-$10BD, $10C0-$10C1 | group1_*, group2_count, trio_*, obj188A_* | sub launch timers |
| $10CD-$10DA | capture_* | capture beam |
| $10D9-$10DE | player_frozen, fighter_count, fighter_offsets | fighter |
| $10FE, $110F-$1110 | player_dying, player_exploding, explosion_step | death |
| $1108-$110E | effect_request, effect_pos, effect_flags, effect_step | effects |
| $112D, $1165 | formation_end, clear_delay | stage end |
| $112F-$1130, $117F-$1180, $1C30, $1C60 | p1/p2_saved_mode, p1/p2_out_flag, p1/p2_saved_formation | two-player turns |
| $115B, $1161-$116B, $1171-$1172 | results_*, bonus_kind_p1/p2 | challenging-stage results |
| $116E-$1170, $117A | event_step, event_timer, star_dir_flags, logo_anim_step | starfield events, title logo |
| $1124-$1125, $1175, $117B-$117E | bonus_step_p1/p2, bonus_ship_out, next_bonus_p1/p2 | bonus lives, bonus ship |
| $1A10-$1A51 | shot_fired_flags | enemy shots |

Aliases (names proposed twice): $1170 star_dir_flags = event_star_mode,
$110F player_exploding = player_hit, $10C6 hitbox = hit_box, $100A
stage_text_timer = var_100A; sub $FA2E task_move_enemy_shots (proposed
task_move_bonus_objects: it moves the enemy shots $0ECE-$0EDA).

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
* **$0C00-$0C03** (written only by the dead code at $D04C), **$1E31+2n**
  cleared in the IRQ, and the game meaning of several sub RAM variables
  and power-up effects (names in $1080-$11FF are inferred from the code).
  The path stream format is understood (docs/modules/sub-C.md).
* **Sound numbers** are identified (section 9, sound driver). Still
  vague in game terms: $0E `special_object` (the object at formation
  slot 42), $0F `object_spawn`, $10 `capture` and the power-up effects
  $11-$13, named after the sub routines that request them.
* The sub CPU's 256 writes to **$500F** at boot. (The sound CPU's
  write to $2007 is just a watchdog kick: any $2000-$3FFF access kicks
  it.)
* SW1:6 is not "unused": it enables the operator stats display.

## 12. Quirk index

ROM bugs and quirks the port reproduces on purpose (details: the
routine headers and line comments of the listings, docs/modules/*.md,
docs/oracle-notes.md section 8). B = `BUG:`, Q = `QUIRK:`.

### Main CPU

| addr | kind | what |
|------|------|------|
| $B71B / $B73C | Q | RAM test runs 15 passes, not 16 (D enters as $000B) |
| $B7E2, $B823, $B835, $B855 | B | error digit loaded in B, A = $20 stored: errors show blank and pass $B926 |
| $B22B | Q | the name JNIWAR shows the staff text and hangs |
| $B304 | Q | alphabet wrap reads the byte 2 before each alphabet ($B416, $B435, $B443) |
| $B49F | Q | rank 5 leaves entry_rank; main_task += 2 skips task_game_over_check |
| $BD7B | Q | cross hatch ends only on a second service-coin press |
| $BE37 | Q | easter egg hangs for good |
| $C01A | Q | 16-bit coin-jam compare (tens >= $B, or $A with units >= $A) |
| $C031 | Q | A to the IRQ latch: $20 after round_select |
| $C045 | B | last formation slot $188C read but never tested |
| $C253 | Q | update_hiscore copies from the first differing byte |
| $C4DA ($C5D8) | B | blanking runs past the tilemap into $0840-$0868 |
| $CAA9 ($CB00) | B | blank loop with X = $0000 |
| $CCD0 ($CE6A, $CD78) | Q | fly-in uses stale carries; 255 markers with lives_setting 0 |
| $D000 ($D01A) | Q | demo_stick bit 7 = carry of CMPA #$F0 |
| $D28A, $D423 | Q | a formation hit does not use up the shot; shots_to_clear stored not OR-ed; boss_bonus_idx runs past its table |
| $D71B | Q | PARSEC digit erase stores to $FFF0 |
| $D915, $DA87, $DE9A, $DC36 | Q | game over: 256 frames, partial score clear, dead load, unreached CWAI |
| $DEC1 | Q | 25+ minutes counted into $09E0 |
| $DF27 ($DF3B) | Q | demo-sounds gate keeps $11, $16, $17, $19-$1F |
| $E375 | B | whole $1166 compared with 4 |
| $EC9F | Q | BRN never branches |
| $F4A5 | Q | third lookup uses the old $1011; signed indexes |
| $F5C4 | Q | effect request lost when all slots are busy |
| $F673 | Q | leaves the task from inside a JSR |
| $F921 | Q | one hit a frame; $F924-$F9CF dead |
| $FB65 | B | STA for STB: P2 bonus step corrupt with bonus_every 0 (crash) |

### Sound CPU

| addr | kind | what |
|------|------|------|
| $E050, $E02D | Q | watchdog kicked at $2007; `LDY $3000` kicks it twice |
| $E233 ($E252) | Q | `op_end` during the block set-up would RTS into RAM (no stream does it) |
| $E2A7 | Q | the "hold" op $16 n is a ramp: the counter is played as the volume; n >= previous - 1 would wrap to $F |
| $E309 ($E359) | Q | note frames = low byte of length x tempo; pitch $D/$E past the table (no stream) |
| $E369 | Q | commands $F8-$FF would jump through code (no stream) |
| $E398 | Q | the $F3 counter +C is never reset (no voice has two $F3) |
| $E3BF | Q | `op_end` returns straight to irq_sound (PULS X,U / RTS); the first voice to reach $F0 ends the whole sound |
| $E3EF | Q | the tempo copy is 32 bytes: 6 bytes of sound_channels |
| $E409 | Q | sounds sharing channel blocks garble each other when they overlap |
| $E6FC, $E721, $E746; $E941, $E947, $ED9D, $F5ED | Q | unused pad bytes; dead $F0 after $F7 jumps |
| $F0FE-$F23B | Q | five note streams no header uses |
| sub $E6D3, $B623, $B577 | Q | the sub's CLRs of queued requests cannot stop a sound already playing |

### Sub CPU

| addr | kind | what |
|------|------|------|
| $B014, $B385, $B09B | Q | unbounded scans from formation_ptr: Round Advance corruption |
| $B173 | Q | headings not range-checked (none >= $B4 in the data) |
| $B92B | Q | object state $80 leaves the loop with 4 bytes on the stack |
| $B93B | Q | noise read is signed: $DF80-$E07F |
| $B98C | Q | 16-bit add: X carry into Y |
| $BB96 | Q | dat_BCB4 search without an end marker |
| $E18A, $E369 | Q | signed stage-table index from $106E * 2 |
| $E1F2 | Q | formation_ptr set only in mode 2 (Round Advance) |
| $E6F2 | Q | dead SUBB |
| $E737 | Q | borrow of SUBB #$10 lost |
| $E8B8 | B | stores A instead of the halved B |
| $EA3E | Q | DECB first: 5 of 6 entries tested |
| $EB29 | Q | endless search with no free slot |
| $F116 | Q | never advances $1116-$1118 |
| $F621 | Q | 8-bit ASLA: steps $1C+ jump through data |
| $F75D | Q | slot $1F1F never tested |
| $F8A6 | Q | free-slot search stops only on an exact match |
| $FB9F, $FC95 | Q | launch table index overwritten: entries 0/3 only |
| $FCE6 | Q | STB where the twin does INC $084D |
| $FD59 | Q | reads $188B, exits before testing it |
| $FEBE | Q | first animation frame indexed by a score byte |
| path $F0 records | Q | back-pointers after $F0 are never read |

# sub-C: ROM gp2-7.11c (sub CPU $C000-$DFFF)

Copyright 2026 by Moshix

## What is in the chip

**No code.** No instruction starts anywhere in $C000-$DFFF: the listing's
static trace finds none, `reference/coverage/sub.json` (~78,000 frames)
executed none, and the only listing labels in the range are `dat_` and
`checksum_` labels. There is therefore **nothing to port**:
`src/game/sub/gp2_7.js` registers nothing in `SUB`/`SUB_AT` and exists so
`index.js` can import every chip module alike. The chip is:

| range         | contents                                                |
|---------------|---------------------------------------------------------|
| $C000-$DEFA   | 46 enemy flight-path streams, back to back              |
| $DEFB-$DF18   | "1984 NAMCO ALL RIGHTS RESERVED" (30 bytes, never read) |
| $DF19-$DFFF   | $FF fill, except `checksum_C000` = $B7 at $DFEF         |

The byte sum of the whole chip is 0 mod 256 (`reset_sub` checks it with
`adda ,x+` at $E02B; '5' in $0801 on failure).

## Files

| file | what |
|------|------|
| `src/game/sub/gp2_7.js` | the chip module: no routines, re-exports the decoder |
| `src/game/sub/gp2_7_paths.js` | constants of the format, `decodeStream(addr)`, `gp2_7Streams()`, `gp2_7ByteKinds()` (tests, tools, docs; the port itself reads with `subRom`) |
| `test/oracle/sub-gp2_7.test.mjs` | static: no code (coverage, symbols, registries), tiling, heading range, back-pointers, jump targets, text/fill/checksum, coverage reads, 71 hand-checked ROM pointers |
| `test/oracle/sub-gp2_7-trace.test.mjs` | the real ROM over 11 sessions (attract, games, challenging stage, PARSEC 11, poked stages): every sub read in the chip comes from the stepper and hits the byte kind the format predicts |
| `test/oracle/sub-gp2_7-stepper.test.mjs` | the ROM stepper `sub_B0D4` called once per byte on all 46 streams (and gp2-8's $A44B) from seeded random states; pointer, heading entry, held heading, flags checked after each call |

## The path stream format

A stream is a run of **heading bytes** closed by a 3-byte **command**:

```
hh hh hh ... hh  F0 ss ss     end
hh hh hh ... hh  FF tt tt     jump
hh hh hh ... hh  FE tt tt     jump, clearing axis 2
```

The stepper lives in gp2-8 (sub-A's `sub_B0D4` / `sub_B163` /
`sub_B20D`). Each enemy object has a path pointer, a word in $1800+
reached through `[$108C]`; the pointer addresses the heading being
flown. When the object's step counter `[$1090]` runs out, the stepper
advances ($B117: `ldx [$108C] / leax 1,x / stx [$108C] / lda ,x`) and
tests the new byte ($B123: `cmpa #$F0 / beq`, `adda #1 / beq`,
`adda #1 / bne`):

* **Heading** (any byte other than $F0/$FE/$FF; in the data always
  $00-$B3): an index into `dat_AAFF` ($AAFF-$ADCE, 180 entries of 4
  bytes, gp2-8). `sub_B163` reads the heading at `,x` ($B173), multiplies
  by 4 and uses the entry (below). The first byte of a stream is flown
  first: a pointer is initialised to the stream start, not before it.
* **$F0 end** ($B155): the pointer stays on the $F0; the object's slot
  flag (`formation_ptr - 1`) becomes 1; slot $188B also sets $188B
  (`cmpx #$188B / bne` at $B159). The two bytes after $F0 are a
  **back-pointer to the stream's own first byte** (15 of 15 streams).
  No code reads them (coverage and the trace test agree). They look like
  a leftover of Namco's tool chain; the port just never reads them.
* **$FF jump** ($B13D-$B151): the heading before the command
  (`lda -1,x`) is saved in `[$1092]`, the word after it (`ldx 1,x`)
  becomes the path pointer, and bit 5 of the slot flag is set. With bit 5
  set the object no longer runs the stepper but `sub_B242`, which flies
  it home to its formation slot using the held heading; the jump target
  is where its next flight starts.
* **$FE jump** ($B12F-$B139): the same, after clearing bit 0 of
  `[$10A6]` and the byte `[$10A2]`, i.e. axis 2 of the position (below)
  is reset to 0. Most $FE jumps point at their own stream: the enemy
  loops the same path, re-entering from the edge.

A stream may also jump to *another* stream's start; no jump and none of
the 71 checked pointers targets the middle of a stream. $C000 is the only stream
that leaves the chip: `FF A4 4B` jumps to gp2-8's stream at $A44B, which
shares its first 151 headings with $C000 and ends `F0 A4 4B` at $A570.
gp2-8's own streams ($A573...) jump back here to $C442 and $CAC1.

### Heading entry (`dat_AAFF`, 4 bytes, in gp2-8)

| byte | used at | meaning |
|------|---------|---------|
| 0 | $B19D, $B1CD | b7: subtract (else add) on axis 1; b3: subtract on axis 2 |
| 1-2 | $B17D `ldd 1,x` | speed on axis 1 and axis 2, each multiplied (`mul`) by `[$1098]`/8 rounded up, at least 1 |
| 3 | $B217, $B22D | sprite: low nibble into `[$1084]` (frame), bits 4-5 into `[$10A4]` (flip), whole byte to `[$10CB]` |

Axis 1 is `[$1088]` (fraction) with carry into `[$10A0]`; axis 2 is
`[$108A]` (fraction) with carry into `[$10A2]` and a ninth bit in bit 0
of `[$10A6]`.

## Who loads the pointers

Everything that points into the chip, checked by
`sub-gp2_7.test.mjs` (`POINTERS`) or listed from the ROM scan:

| where | what |
|-------|------|
| sub $F0ED | $C0E9 into $184C-$1853, $C000 into $1854-$1857 (stage set-up) |
| sub $F5A5, main $B2D7 | $C000 into $1854/$1856 |
| sub $B2A8 (`sub_B242`) | $DD44 into `[$108C]` when <$20 is set and <$21 is clear |
| sub $FBB3, $FCA9, $FD59 | $DD44 in place of the `$1052` pointer when <$20 is set |
| sub $BD20 / $BD56 | `dat_BEAD` ($DB50 or gp2-6's $FEEC), `dat_BEBD` ($D936), `dat_BECD` ($DA09), $DADC: stored at $09D0,U (captured fighter) |
| sub `dat_FE01+$18` ($FE19) | 12 pointers used by `sub_FD59` (`ldy $18,u`) |
| sub `dat_EB8C`, `dat_EE15`, `dat_EFD3`, `dat_F000`, `dat_F027`, `dat_F07B`, `dat_F2F9` | per-stage entry-wave tables of `sub_EBEC` / `sub_F116` (gp2-6), mixed with other bytes |
| main `dat_F266` | `load_stage_params`: 8 records of 4 pointers, copied to $1052-$1059 (the dive paths) |

Note that `dat_BEAD` also holds $FEEC: gp2-6's data at $FEEC-$FFA8 is
a path stream in the same format (186 headings, `F0 FE EC`).

## The 46 streams

`n` = number of headings; `to` = jump target; "loops" = jumps to its own
start. Generated from the ROM with `gp2_7Streams()`.

| start | cmd | n | op | to | referenced from |
|-------|-----|---|----|----|-----------------|
| $C000 | $C0E6 | 230 | FF | $A44B | $F10B, $F5F0, main $B2D7 |
| $C0E9 | $C1AD | 196 | FE | $C0E9 | $F0FE, dat_FE01, loops |
| $C1B0 | $C2A8 | 248 | FE | $C3A6 | dat_FE01 |
| $C2AB | $C3A3 | 248 | FE | $C3A6 | dat_FE01 |
| $C3A6 | $C43F | 153 | FE | $C3A6 | main dat_F266, jump $C2A8, jump $C3A3, loops |
| $C442 | $C4D8 | 150 | FE | $C442 | dat_A573, jump $C97A, jump $D056, jump $D5AA, jump $D665, jump $D6C8, jump $D783, loops |
| $C4DB | $C5AE | 211 | FE | $C4DB | main dat_F266, loops |
| $C5B1 | $C67C | 203 | FE | $C5B1 | main dat_F266, loops |
| $C67F | $C79E | 287 | FE | $C67F | main dat_F266, loops |
| $C7A1 | $C899 | 248 | FE | $CAC1 | dat_FE01 |
| $C89C | $C97A | 222 | FF | $C442 | dat_EB8C |
| $C97D | $CA38 | 187 | FE | $C97D | dat_FE01, loops |
| $CA3B | $CABE | 131 | FE | $CA3B | main dat_F266, loops |
| $CAC1 | $CB57 | 150 | FE | $CAC1 | dat_A573, jump $C899, jump $CF0A, jump $CFEB, jump $D22C, loops |
| $CB5A | $CC29 | 207 | FE | $CB5A | main dat_F266, loops |
| $CC2C | $CCF7 | 203 | FE | $CC2C | main dat_F266, loops |
| $CCFA | $CE0F | 277 | FE | $CCFA | main dat_F266, loops |
| $CE12 | $CF0A | 248 | FE | $CAC1 | dat_FE01 |
| $CF0D | $CFEB | 222 | FF | $CAC1 | dat_EB8C |
| $CFEE | $D056 | 104 | FF | $C442 | dat_EB8C, dat_EE15 |
| $D059 | $D0E2 | 137 | F0 | - | dat_EE15 |
| $D0E5 | $D144 | 95 | FF | $D0E5 | dat_EE15, loops |
| $D147 | $D1C1 | 122 | F0 | - | dat_EE15 |
| $D1C4 | $D22C | 104 | FF | $CAC1 | dat_EB8C, dat_F2F9 |
| $D22F | $D2B8 | 137 | F0 | - | dat_F2F9 |
| $D2BB | $D31A | 95 | FF | $D2BB | dat_F2F9, loops |
| $D31D | $D397 | 122 | F0 | - | dat_F2F9 |
| $D39A | $D40C | 114 | FF | $D39A | dat_EE15, loops |
| $D40F | $D494 | 133 | F0 | - | dat_EE15 |
| $D497 | $D4D3 | 60 | FF | $D497 | dat_EE15, loops |
| $D4D6 | $D547 | 113 | F0 | - | dat_EE15, dat_EFD3, dat_F027, dat_F07B |
| $D54A | $D5AA | 96 | FF | $C442 | dat_EB8C |
| $D5AD | $D665 | 184 | FF | $C442 | dat_EB8C |
| $D668 | $D6C8 | 96 | FF | $C442 | dat_EB8C |
| $D6CB | $D783 | 184 | FF | $C442 | dat_EB8C |
| $D786 | $D7F8 | 114 | FF | $D786 | dat_F2F9, loops |
| $D7FB | $D880 | 133 | F0 | - | dat_F2F9 |
| $D883 | $D8BF | 60 | FF | $D883 | dat_F2F9, loops |
| $D8C2 | $D933 | 113 | F0 | - | dat_F2F9 |
| $D936 | $DA06 | 208 | F0 | - | dat_BEBD |
| $DA09 | $DAD9 | 208 | F0 | - | dat_BECD |
| $DADC | $DB4D | 113 | F0 | - | $BE07, $BE46 |
| $DB50 | $DC0B | 187 | F0 | - | dat_BEAD |
| $DC0E | $DD41 | 307 | F0 | - | dat_F000, dat_F027, dat_F07B |
| $DD44 | $DE05 | 193 | F0 | - | $B2A8, dat_EFD3, dat_F027, dat_F07B, $FBE7, $FCDD, $FDD0 |
| $DE08 | $DEF8 | 240 | F0 | - | dat_EFD3, dat_F000, dat_F027, dat_F07B |

Roles, tentative (inferred from the tables that point at each stream):
$C000-$D056 are dive paths (`dat_F266` per stage, `dat_FE01`,
`dat_EB8C`), most looping on themselves; $D059-$D8C2 are mostly entry
waves (`dat_EE15`, `dat_F2F9`), alternating a looping stream and one that
ends, except $D1C4 and $D54A-$D6CB (`dat_EB8C`), which jump on to the
dive loops $CAC1/$C442; $D936-$DE08 are the challenging-stage and
captured-fighter paths, all ending in $F0.

## Coverage

The trace test steps 32 of the 46 streams in its sessions. The other 14
($C3A6 $C442 $C5B1 $C67F $C89C $CA3B $CAC1 $CC2C $CCFA $CF0D $D54A
$D5AD $D6CB $DADC) are never flown by the random player but are walked
by the ROM stepper in `sub-gp2_7-stepper.test.mjs`.

## Quirks

* The $F0 back-pointers (30 bytes) are dead data.
* Headings $B4-$EF and $F1-$FD would index past `dat_AAFF` into
  `dat_ADCF` and beyond (the stepper does not range-check); no stream
  contains one.
* The copyright string is a second copy (also at sub $BF8B, main $DFAE,
  $FFD0); nothing prints it.

## Open questions

* What $1020/$1021 mean (they switch the dive path to $DD44).
* Exact meaning of the per-stage tables of gp2-6 that hold most of the
  stream pointers (sub-E's module documents their layout).

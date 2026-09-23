# Requests from sub-A (gp2-8.11d, sub $A000-$BFFF)

Copyright 2026 by Moshix

## 1. romdata.js / tools/gen-listing.mjs: whitelist the sub noise table

`object_spawn_random` ($B936) reads the sub CPU's own code as noise:

```
B936: LDX #$E000 / LDA <frame_counter / LDA A,X
```

`A,X` is a **signed** offset, so frame_counter $00-$7F reads
**$E000-$E07F** (reset_sub and irq_sub: code) and $80-$FF reads
$DF80-$DFFF (gp2-7's $FF fill and its checksum byte $DFEF = $B7: data
already). The port reads it with `subRom(disp8(0xe000, fc))`
(src/game/sub/gp2_8_objects.js). When romdata's code/data mask is
switched on, sub **$E000-$E07F** must be marked readable (code read as
data), or this read throws. Please add it to the listing tool's
whitelist with a comment pointing at $B936.

Also, the oracle-notes (section 6) and disassembly-notes ("Randomness")
say `$E000 + frame_counter`; it is `$E000 + (signed) frame_counter`,
i.e. $DF80-$E07F. The listing comment at $B936 is fine for the clamp
but could say so too (proposed annotation in
`reference/annotations/proposed/sub-A.json`).

## 2. For integration / sub-E: the timing conventions gp2-8 uses

(Round 2, docs/requests/integration.md 2.) So that the chips agree:

* A task charges its final `jmp task_dispatch_sub` (4 cycles); the
  dispatcher charges its own $E0EC code before calling the task.
* `cwai #$EF` charges 16 cycles (oracle core / MAME, opcode + operand +
  12 bytes stacked) and then does a plain `yield`; the wake-up (4) is
  the scheduler's.
* "Timed" (SYNC before the instruction) = any access to $0000-$1FFF
  except $1D74-$1D80 (the stack and the byte the PULS/RTS dummy read
  touches), and $6000-$6FFF. It might be worth one shared predicate.

## 3. Nothing else

No shared file needed changing. Tasks follow the sub-E convention
(src/game/sub/gp2_6.js header): return = `jmp task_dispatch_sub`, the
two CWAI tasks (`task_formation_init` $BF58, `sub_BB96` $BB96) are
generators with one bare `yield`.

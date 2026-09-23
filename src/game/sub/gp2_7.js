// Copyright 2026 by Moshix
/**
 * Sub CPU ROM gp2-7.11c, $C000-$DFFF.
 *
 * This chip holds **no code**: no instruction starts in it (the listing's
 * static trace and reference/coverage/sub.json agree, and
 * test/oracle/sub-gp2_7.test.mjs checks both), so nothing is registered
 * in SUB / SUB_AT. It is all data:
 *
 * | range         | contents                                          |
 * |---------------|---------------------------------------------------|
 * | $C000-$DEFA   | 46 enemy flight-path streams (gp2_7_paths.js)     |
 * | $DEFB-$DF18   | "1984 NAMCO ALL RIGHTS RESERVED" (never read)     |
 * | $DF19-$DFFF   | $FF fill, `checksum_C000` = $B7 at $DFEF          |
 *
 * The streams are read only by the path stepper of gp2-8 ($B121, $B13D,
 * $B143, $B173) through the per-object pointer `[$108C]`; the pointers
 * are loaded by code in gp2-6/gp2-8 and by the main CPU's
 * `load_stage_params` (main $F266 -> $1052-$1059). Ported routines read
 * the bytes with `subRom(addr)` at those addresses. The only other reader
 * is the boot checksum in `reset_sub` ($E02B: adda ,x+ over the chip).
 *
 * The format and every table referencing the chip are documented in
 * docs/modules/sub-C.md.
 * @see gaplus-sub.asm $C000-$DFFF
 */
import { SUB, SUB_AT } from './routines.js';

export {
  GP2_7_START, STREAMS_END, COPYRIGHT, COPYRIGHT_LEN, CHECKSUM, PATH_END,
  PATH_JUMP, PATH_JUMP_CLR, HEADING_MAX, HEADING_TABLE, decodeStream,
  gp2_7Streams, gp2_7ByteKinds,
} from './gp2_7_paths.js';

// Nothing to register: the chip has no routine entry points. The empty
// registration keeps the shape every chip module has, so index.js can
// import this file like the others.
Object.assign(SUB, {});
Object.assign(SUB_AT, {});

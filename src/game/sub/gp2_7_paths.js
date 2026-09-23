// Copyright 2026 by Moshix
/**
 * The flight-path streams of ROM gp2-7.11c (sub CPU $C000-$DFFF).
 *
 * The chip holds no code: $C000-$DEFA is 46 back-to-back path streams,
 * then the copyright text, $FF fill and the checksum byte. The streams are
 * interpreted by the path stepper in gp2-8 (`sub_B0D4` / `sub_B163`,
 * reads at $B121, $B13D, $B143, $B173), through the object's path pointer
 * `[$108C]` (one word per object at $1800+). This file only *decodes* the
 * format (for tests, tools and docs/modules/sub-C.md); the game port reads
 * the bytes where the 6809 did, through `subRom`, never through a copy.
 *
 * Stream format (bytes win over this comment, see the tests):
 *
 *   hh hh hh ...        headings $00-$B3: index into dat_AAFF ($AAFF, 180
 *                       entries of 4 bytes), one heading per step
 *   F0 ss ss            end: the stepper stops ($B155: object slot flag
 *                       = 1); `ss ss` is a back-pointer to the stream's
 *                       own first byte that no code reads
 *   FF tt tt            jump: the byte before is saved to [$1092] ($B13D),
 *                       the path pointer becomes `tt tt` ($B143) and the
 *                       slot flag gets bit 5 (fly home to the formation)
 *   FE tt tt            the same, after clearing bit 0 of [$10A6] and
 *                       [$10A2] ($B12F-$B139)
 *
 * The stepper tests `cmpa #$F0` then `adda #1` / `adda #1`, so every other
 * byte, $F1-$FD included, is a heading; none of $B4-$FD occurs in a stream.
 * @see gaplus-sub.asm $B117-$B162 (the stepper), $C000-$DFFF (the data)
 */
import { subRom } from '../romdata.js';

/** First byte of the chip. */
export const GP2_7_START = 0xc000;
/** One past the last path byte: the copyright text starts here. */
export const STREAMS_END = 0xdefb;
/** "1984 NAMCO ALL RIGHTS RESERVED", 30 bytes, never read. */
export const COPYRIGHT = 0xdefb;
/** Length of the copyright text. */
export const COPYRIGHT_LEN = 30;
/** `checksum_C000`: makes the byte sum of $C000-$DFFF zero. */
export const CHECKSUM = 0xdfef;

/** $B123: cmpa #$F0 -- end of path. */
export const PATH_END = 0xf0;
/** $B127: adda #$01 / beq -- jump (A was $FF). */
export const PATH_JUMP = 0xff;
/** $B12B: adda #$01 / bne -- jump that also clears two flags (A = $FE). */
export const PATH_JUMP_CLR = 0xfe;
/** Highest heading dat_AAFF ($AAFF-$ADCE, 4 bytes each) has an entry for. */
export const HEADING_MAX = 0xb3;
/** dat_AAFF: 4 bytes per heading, read at $B17D (`ldd 1,x`). */
export const HEADING_TABLE = 0xaaff;

/**
 * @typedef {object} PathStream
 * @property {number} start   address of the first heading
 * @property {number} cmd     address of the terminating command byte
 * @property {'end'|'jump'|'jumpClear'} op  PATH_END / _JUMP / _JUMP_CLR
 * @property {number} word    the word after the command: the jump target,
 *                            or (for 'end') the unread back-pointer
 * @property {number[]} headings  the heading bytes, in order
 */

/**
 * Decode one stream from `start` to its command byte, reading the sub
 * ROM at its CPU addresses. Works for gp2-8 streams too ($A44B, ...).
 * @param {number} start first byte of the stream
 * @returns {PathStream}
 */
export function decodeStream(start) {
  const headings = [];
  let a = start;
  for (;;) {
    const v = subRom(a);
    if (v === PATH_END || v === PATH_JUMP || v === PATH_JUMP_CLR) {
      // $B143: ldx 1,x -- big-endian word right after the command byte
      const word = (subRom(a + 1) << 8) | subRom(a + 2);
      /** @type {PathStream['op']} */
      const op = v === PATH_END ? 'end'
        : v === PATH_JUMP ? 'jump' : 'jumpClear';
      return { start, cmd: a, op, word, headings };
    }
    headings.push(v);
    a += 1;
    // A stream that ran off the ROM would be a decoding error.
    if (a > 0xfffd) throw new Error(`path at $${hex4(start)} never ends`);
  }
}

/**
 * Every stream of the chip, in ROM order: a linear walk from $C000 that
 * starts the next stream right after each 3-byte command.
 * @returns {PathStream[]}
 */
export function gp2_7Streams() {
  const out = [];
  let a = GP2_7_START;
  while (a < STREAMS_END) {
    const s = decodeStream(a);
    out.push(s);
    a = s.cmd + 3;
  }
  return out;
}

/**
 * @typedef {'heading'|'cmd'|'target'|'backptr'|'text'|'fill'|'checksum'}
 *   ByteKind
 */

/**
 * What each byte of $C000-$DFFF is, index = address - $C000.
 * @returns {ByteKind[]}
 */
export function gp2_7ByteKinds() {
  /** @type {ByteKind[]} */
  const kind = new Array(0x2000).fill('fill');
  for (const s of gp2_7Streams()) {
    for (let a = s.start; a < s.cmd; a += 1) kind[a - GP2_7_START] = 'heading';
    kind[s.cmd - GP2_7_START] = 'cmd';
    const w = s.op === 'end' ? 'backptr' : 'target';
    kind[s.cmd + 1 - GP2_7_START] = w;
    kind[s.cmd + 2 - GP2_7_START] = w;
  }
  for (let i = 0; i < COPYRIGHT_LEN; i += 1) {
    kind[COPYRIGHT + i - GP2_7_START] = 'text';
  }
  kind[CHECKSUM - GP2_7_START] = 'checksum';
  return kind;
}

/** @param {number} v @returns {string} */
function hex4(v) {
  return v.toString(16).toUpperCase().padStart(4, '0');
}

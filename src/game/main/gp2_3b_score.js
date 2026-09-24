// Copyright 2026 by Moshix
/**
 * Scoring in main CPU ROM gp2-3b.8c ($C1D6-$C295): add_score,
 * update_hiscore and the two BCD-digit-to-tile helpers.
 *
 * Scores are 3 BCD bytes, least significant first (score_p1 $09B0,
 * score_p2 $09B3); the high score $09B6-$09B8 is most significant first.
 * Both are drawn by the same code (lC204): six digit tiles going left
 * from the tile pointer Y (Y+5 is the most significant digit), leading
 * zero digits left untouched (not blanked).
 *
 * add_score and update_hiscore never wait, but they are generators: they
 * charge every instruction and yield SYNC before each access to shared
 * RAM (the scores, the tiles; src/game/timing.js), so that an IRQ in
 * the middle of a call lands between the right writes (an AI game hit
 * it: the vblank between add_score's score update and its redraw, frame
 * 19,806 of tools/ai-lockstep.mjs run 0). The BCD digit helpers touch
 * no memory and stay plain.
 * @see reference/gaplus-main.asm $C1D6-$C295
 */

import { add8, adc8, daa } from '../m6809ops.js';
import { mainWord } from '../romdata.js';
import { SYNC } from '../timing.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {Generator<symbol, void, unknown>} Gen */

/**
 * $C287 bcd_hi_to_char: A = the tile code of A's high nibble (four LSRAs,
 * then falls into bcd_lo_to_char).
 * @see gaplus-main.asm $C287
 * @param {Machine} m
 * @param {{ a: number }} regs
 * @returns {{ a: number }}
 */
export function bcd_hi_to_char(m, { a }) {
  m.charge(2); m.charge(2); m.charge(2); m.charge(2);
  return bcd_lo_to_char(m, { a: (a & 0xff) >> 4 });
}

/**
 * $C28B bcd_lo_to_char: A = the tile code of A's low nibble: $30-$39 for
 * 0-9, and $41-$46 ('A'-'F') above (`adda #$30 / cmpa #$3A / bcs / adda
 * #7`; the font is ASCII-ordered).
 * @see gaplus-main.asm $C28B
 * @param {Machine} m
 * @param {{ a: number }} regs
 * @returns {{ a: number }}
 */
export function bcd_lo_to_char(m, { a }) {
  let v = (a & 0x0f) + 0x30;
  m.charge(2); m.charge(2); m.charge(2); m.charge(3);
  if (v >= 0x3a) {
    v += 7;
    m.charge(2);
  }
  m.charge(5);
  return { a: v };
}

/**
 * lC204-lC24E: draw the 3-byte BCD number at X (least significant byte
 * first) as up to six digit tiles at Y+5 (most significant) .. Y,
 * starting at the first non-zero digit (at least one digit: Y+0). Ends
 * with the routine's RTS (charged).
 * @param {Machine} m @param {number} x @param {number} y
 * @returns {Gen}
 */
function* drawNumber(m, x, y) {
  // The skip tests: lda n,x (5, 4 for ,x) / anda #$F0 (or #$0F) (2) /
  // bne (3), then `bra $C247` if all zero.
  const digits = [
    [2, true, 5], [2, false, 4], [1, true, 3], [1, false, 2],
    [0, true, 1], [0, false, 0],
  ];
  let first = 5;
  for (; first > 0; first -= 1) {
    const [off, high] = digits[5 - first];
    yield SYNC;
    const v = m.peek(x + off);
    m.charge(off === 0 ? 4 + 2 + 3 : 5 + 2 + 3);
    if ((high ? v & 0xf0 : v & 0x0f) !== 0) break;
  }
  if (first === 0) m.charge(3); // $C222: bra $C247
  for (let i = 5 - first; i < 6; i += 1) {
    const [off, high, dst] = digits[i];
    // lda n,x (5, 4 for ,x) / lbsr (9) / sta n,y (5, 4 for ,y)
    yield SYNC;
    const v = m.peek(x + off);
    m.charge((off === 0 ? 4 : 5) + 9);
    const t = high ? bcd_hi_to_char(m, { a: v }) : bcd_lo_to_char(m, { a: v });
    yield SYNC;
    m.poke(y + dst, t.a);
    m.charge(dst === 0 ? 4 : 5);
  }
  m.charge(5); // $C24E: rts
}

/**
 * $C1D6 add_score: unless $115F is set, add A (BCD, tens of points) to
 * the current player's score (`adda ,x / daa`, then two `adca #0 / daa`
 * carries), update the high score (update_hiscore) and redraw the score
 * at the player's tiles (score_tile_ptrs $C24F: P1 $03F8, P2 $03E6).
 * @see gaplus-main.asm $C1D6
 * @param {Machine} m
 * @param {{ a: number }} regs A = points
 * @returns {Gen}
 */
export function* add_score(m, { a }) {
  // $C1D6: ldb $115F (5) / bne rts (3)
  yield SYNC;
  const skip = m.peek(0x115f);
  m.charge(5); m.charge(3);
  if (skip !== 0) {
    m.charge(5);
    return;
  }
  // $C1DB: ldx #score_p1 (3) / ldb <cur_player (4) / beq (3) /
  // ldx #score_p2 (3)
  let x = 0x09b0;
  m.charge(3);
  yield SYNC;
  const cp = m.peek(0x102d);
  m.charge(4); m.charge(3);
  if (cp !== 0) {
    x = 0x09b3;
    m.charge(3);
  }
  // adda ,x (4) / daa (2) / sta ,x (4) -- then the carry is threaded
  // through two `lda n,x (5) / adca #0 (2) / daa (2) / sta n,x (5)`:
  // DAA only ever sets C.
  yield SYNC;
  let r = add8(a, m.peek(x));
  m.charge(4);
  r = daa(r.v, r.cc);
  m.charge(2);
  yield SYNC;
  m.poke(x, r.v);
  m.charge(4);
  for (const off of [1, 2]) {
    yield SYNC;
    r = adc8(m.peek(x + off), 0, r.cc);
    m.charge(5);
    r = daa(r.v, r.cc);
    m.charge(2); m.charge(2);
    yield SYNC;
    m.poke(x + off, r.v);
    m.charge(5);
  }
  // $C1F8: bsr update_hiscore (7)
  m.charge(7);
  yield* update_hiscore(m, { x });
  // $C1FA: ldy #score_tile_ptrs (4) / lda <cur_player (4) / asla (2) /
  // ldy a,y (7) (a signed offset: cur_player >= $40 would index back)
  m.charge(4);
  yield SYNC;
  const off = (m.peek(0x102d) << 1) & 0xff;
  m.charge(4); m.charge(2);
  const y = mainWord((0xc24f + ((off ^ 0x80) - 0x80)) & 0xffff);
  m.charge(7);
  yield* drawNumber(m, x, y);
}

/**
 * $C253 update_hiscore: if the score at X (3 BCD bytes, least significant
 * first) is greater than the high score $09B6-$09B8 (most significant
 * first), copy it -- only from the first byte that differs downwards, the
 * higher ones being equal already -- and redraw the high score at $03EF
 * (the drawing code and RTS are add_score's, lC204).
 * @see gaplus-main.asm $C253
 * @param {Machine} m
 * @param {{ x: number }} regs
 * @returns {Gen}
 */
export function* update_hiscore(m, { x }) {
  // $C253: lda 2,x (5) / cmpa $09B6 (5) / bcs rts (3) / beq $C271 (3)
  yield SYNC;
  const s2 = m.peek(x + 2);
  m.charge(5);
  yield SYNC;
  const h0 = m.peek(0x09b6);
  m.charge(5); m.charge(3);
  let from;
  if (s2 < h0) {
    m.charge(5);
    return;
  }
  m.charge(3); // beq
  if (s2 > h0) {
    from = 0; // falls into $C25C
  } else {
    // $C271: lda 1,x (5) / cmpa $09B7 (5) / bcs rts (3) / beq $C27C (3)
    // / bra $C261 (3)
    yield SYNC;
    const s1 = m.peek(x + 1);
    m.charge(5);
    yield SYNC;
    const h1 = m.peek(0x09b7);
    m.charge(5); m.charge(3);
    if (s1 < h1) {
      m.charge(5);
      return;
    }
    m.charge(3); // beq
    if (s1 > h1) {
      from = 1;
      m.charge(3);
    } else {
      // $C27C: lda ,x (4) / cmpa $09B8 (5) / bcs rts (3) / beq rts (3)
      // / bra $C266 (3)
      yield SYNC;
      const s0 = m.peek(x);
      m.charge(4);
      yield SYNC;
      const h2 = m.peek(0x09b8);
      m.charge(5); m.charge(3);
      if (s0 < h2) {
        m.charge(5);
        return;
      }
      m.charge(3); // beq
      if (s0 === h2) {
        m.charge(5);
        return;
      }
      from = 2;
      m.charge(3);
    }
  }
  if (from === 0) {
    // $C25C: lda 2,x (5) / sta $09B6 (5)
    yield SYNC;
    const v = m.peek(x + 2);
    m.charge(5);
    yield SYNC;
    m.poke(0x09b6, v);
    m.charge(5);
  }
  if (from <= 1) {
    // $C261: lda 1,x (5) / sta $09B7 (5)
    yield SYNC;
    const v = m.peek(x + 1);
    m.charge(5);
    yield SYNC;
    m.poke(0x09b7, v);
    m.charge(5);
  }
  // $C266: lda ,x (4) / sta $09B8 (5) / ldy #$03EF (4) / bra $C204 (3)
  yield SYNC;
  const v = m.peek(x);
  m.charge(4);
  yield SYNC;
  m.poke(0x09b8, v);
  m.charge(5); m.charge(4); m.charge(3);
  yield* drawNumber(m, x, 0x03ef);
}

/** Every routine of this file by entry address. */
export const ROUTINES = {
  0xc1d6: add_score,
  0xc253: update_hiscore,
  0xc287: bcd_hi_to_char,
  0xc28b: bcd_lo_to_char,
};

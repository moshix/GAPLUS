// Copyright 2026 by Moshix
/**
 * gp2-4.8d ($A000-$BFFF), part 1 of 2: game mode 9, the TOP 5 check and
 * the name entry (task_hiscore_entry and its three steps), and
 * load_formation_sprites.
 *
 * TASK CONVENTION. The mode-9 task list is run by task_dispatch ($FEB5,
 * gp2_2b). A task ends with `INC <main_task / JMP task_dispatch`; in the
 * port the task performs the INC and RETURNS, and the dispatcher loops
 * (it re-reads game_mode/main_task as the 6809 does). Tasks here are
 * generators because some paths reach a `CWAI #$EF` (one `yield`).
 *
 * The screen: scores are 8 tile codes, names 14; tile addresses decrease
 * by $20 per column going right (print direction). The table itself
 * (hiscore_table $0900, 16 bytes per entry; hiscore_names $0950) holds
 * the same tile codes.
 *
 * @see reference/gaplus-main.asm $AFBE-$B6F5
 */

import { call } from '../call.js';
import { mainAt } from './routines.js';
import { disp8 } from '../m6809ops.js';
import { fill_tilemap_00_20 } from './gp2_4_svc.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/**
 * `LEAX -$20,X` and friends: 16-bit wrap.
 * @param {number} v @param {number} d
 */
const add16 = (v, d) => (v + d) & 0xffff;

/**
 * `INC <main_task` ($1030), the common end of a task before
 * `JMP task_dispatch`.
 * @param {Machine} m
 */
function incMainTask(m) {
  m.poke(0x1030, (m.peek(0x1030) + 1) & 0xff); // main_task
}

/**
 * task_hiscore_entry ($AFBE): mode 9 task 0. Dispatches on hiscore_step
 * ($11FF) through the hiscore_steps table ($AFC7): 0 hiscore_check,
 * 1 hiscore_draw_screen, 2 hiscore_enter_name.
 * @see gaplus-main.asm $AFBE
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
export function* task_hiscore_entry(m) {
  // $AFBE: lda hiscore_step / asla / ldx #$AFC7 / jmp [a,x]
  // (asla is an 8-bit shift; a,x is a signed offset)
  const a = (m.peek(0x11ff) << 1) & 0xff;
  const target = m.read16(disp8(0xafc7, a));
  yield* call(mainAt(target), m, {});
}

/**
 * Copy the player's score digits (8 tile codes read from Y going down
 * in address, `LDA ,X / LEAX -1,X`) into a table entry at U.
 * @param {Machine} m @param {number} y first digit's tile @param {number} u
 */
function copyScore(m, y, u) {
  let x = y;
  for (let b = 8; b > 0; b -= 1) {
    m.poke(u, m.peek(x));
    u = add16(u, 1);
    x = add16(x, -1);
  }
}

/**
 * Move TOP 5 entry n-1 down to entry n: the 8 score bytes at X (from
 * X-$10) and the 14 name bytes at U (from U-$10).
 * @param {Machine} m @param {number} x @param {number} u
 */
function shiftEntry(m, x, u) {
  // $B59C: lda -$10,x / sta ,x+ (8x), then lda -$10,u / sta ,u+ (14x)
  for (let b = 8; b > 0; b -= 1) {
    m.poke(x, m.peek(add16(x, -0x10)));
    x = add16(x, 1);
  }
  for (let b = 0x0e; b > 0; b -= 1) {
    m.poke(u, m.peek(add16(u, -0x10)));
    u = add16(u, 1);
  }
}

/**
 * hiscore_check ($B49F): hiscore_step 0. Compare the player's score
 * (tile codes at $03FD for P1 or $03EB for P2) with the 5 entries of
 * hiscore_table, first to last; the first entry the score is >= to is
 * its rank k. Entries k..3 move down one, the score is stored at k,
 * entry_cursor = $024F + 3k (the name row on the entry screen),
 * entry_music_ptr = snd_request+3 ($6043) for 1st, +4 otherwise. Then
 * hiscore_step 1 and main_task += 2 (skipping to task_end_frame).
 *
 * Rank 5 (k = 4) only overwrites the last score and leaves entry_rank
 * alone; ranks 1-4 count entry_rank down to 0 while shifting. A score
 * below all five goes straight to the end of mode 9 (lB2AE).
 * @see gaplus-main.asm $B49F
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
export function* hiscore_check(m) {
  yield* call(mainAt(0xdf19), m, {}); // $B49F: jsr sound_all_off
  // $B4A2: ldy #$03FD / lda <cur_player / beq / ldy #$03EB
  const y = m.peek(0x102d) === 0 ? 0x03fd : 0x03eb;

  // $B4AE-$B524: five unrolled compare loops. `cmpa ,u / bcs next /
  // bne found`: lower digit -> try the next entry, higher -> rank found,
  // 8 equal digits also count as found (a tie goes above).
  let rank = 5;
  for (let k = 0; k < 5 && rank === 5; k += 1) {
    let x = y;
    let u = 0x0900 + k * 0x10;
    let lower = false;
    for (let b = 8; b > 0; b -= 1) {
      const a = m.peek(x);
      const t = m.peek(u);
      if (a < t) { lower = true; break; }
      if (a !== t) break;
      u = add16(u, 1);
      x = add16(x, -1);
    }
    if (!lower) rank = k;
  }
  if (rank === 5) {
    // $B526: jmp lB2AE -- not in the TOP 5
    yield* hiscore_leave(m);
    return;
  }

  // $B529/$B53C/...: std entry_cursor / std entry_music_ptr / sta entry_rank
  m.poke16(0x09a2, 0x024f + rank * 3); // entry_cursor
  m.poke16(0x09a7, rank === 0 ? 0x6043 : 0x6044); // entry_music_ptr
  if (rank === 4) {
    // $B581: the last entry is simply replaced (no entry_rank store)
    copyScore(m, y, 0x0940);
  } else {
    m.poke(0x09a6, 4 - rank); // entry_rank
    // $B594..: shift entries 3->4, 2->3, ... down to rank->rank+1. Each
    // step `DEC entry_rank` and stops at 0; the last step (0->1) ends
    // with `CLR entry_rank` instead of a DEC.
    let dst = 0x0940;
    for (;;) {
      shiftEntry(m, dst, dst + 0x50);
      if (dst === 0x0910) {
        m.poke(0x09a6, 0); // $B603: clr entry_rank
        break;
      }
      const r = (m.peek(0x09a6) - 1) & 0xff;
      m.poke(0x09a6, r); // dec entry_rank
      if (r === 0) break;
      dst -= 0x10;
    }
    copyScore(m, y, dst - 0x10);
  }
  // $B64C: inc hiscore_step / inc <main_task / inc <main_task
  m.poke(0x11ff, (m.peek(0x11ff) + 1) & 0xff);
  incMainTask(m);
  incMainTask(m);
}

/**
 * Print zero-terminated strings from a table of (tile address, string)
 * pairs ended by a zero address ($AFDD / $B24E loops). `ldx ,y++ / beq`
 * ends on a zero address.
 * @param {Machine} m @param {number} y table
 * @param {boolean} swap true: (string, tile) pairs as in dat_B164
 * @param {boolean} clearAttr also `CLR $0400,U` per character
 */
function printTable(m, y, swap, clearAttr) {
  for (;;) {
    const first = m.read16(y);
    y = add16(y, 2);
    if (first === 0) return;
    const second = m.read16(y);
    y = add16(y, 2);
    let src = swap ? first : second;
    let dst = swap ? second : first;
    for (;;) {
      const a = m.read(src);
      src = add16(src, 1);
      if (a === 0) break;
      m.poke(dst, a);
      if (clearAttr) m.poke(add16(dst, 0x400), 0);
      dst = add16(dst, -0x20);
    }
  }
}

/**
 * Fixed-length rows from a (tile address, source) table ($AFF2 / $B00A):
 * `ldb #n / ldx ,y++ / beq / ldu ,y++` then n x `lda ,u+ / sta ,x /
 * leax -$20,x`.
 * @param {Machine} m @param {number} y @param {number} n
 */
function drawRows(m, y, n) {
  for (;;) {
    let x = m.read16(y);
    y = add16(y, 2);
    if (x === 0) return;
    let u = m.read16(y);
    y = add16(y, 2);
    for (let b = n; b > 0; b -= 1) {
      m.poke(x, m.read(u));
      u = add16(u, 1);
      x = add16(x, -0x20);
    }
  }
}

/**
 * The reverse ($B266 / $B27E): read n tile codes from the screen (U,
 * going right) back into the table (X, going up).
 * @param {Machine} m @param {number} y @param {number} n
 */
function readRows(m, y, n) {
  for (;;) {
    let u = m.read16(y);
    y = add16(y, 2);
    if (u === 0) return;
    let x = m.read16(y);
    y = add16(y, 2);
    for (let b = n; b > 0; b -= 1) {
      m.poke(x, m.peek(u));
      x = add16(x, 1);
      u = add16(u, -0x20);
    }
  }
}

/**
 * `STA ,X / LEAX -$20,X` n times: a column of attribute bytes.
 * @param {Machine} m @param {number} x @param {number} v @param {number} n
 */
function attrColumn(m, x, v, n) {
  for (let b = n; b > 0; b -= 1) {
    m.poke(x, v);
    x = add16(x, -0x20);
  }
}

/**
 * hiscore_draw_screen ($AFCD): hiscore_step 1. Clears the sprite
 * shadows, parks the player sprite ($1600 = $7848), draws the TOP 5
 * screen (titles dat_B070, the scores and names from the table), the
 * "AAAAAA  00  AA" placeholder in the new entry's row (attribute $3F),
 * attribute 1 on 11 cells below the cursor and 2 on the two side
 * columns; entry_timer = 5, hiscore_step 2, next task.
 * @see gaplus-main.asm $AFCD
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
export function* hiscore_draw_screen(m) {
  yield* call(mainAt(0xdf5d), m, {}); // jsr clear_sprite_shadows
  m.poke16(0x1600, 0x7848); // player_y / player_x
  m.poke(0x1e01, 0); // clr $1E01
  printTable(m, 0xb070, false, false); // $AFD9: headings, ranks
  drawRows(m, 0xb092, 8); // $AFEE: scores
  drawRows(m, 0xb0a8, 0x0e); // $B006: names
  // $B01E: the placeholder name row, with attribute $3F
  let u = 0xb138;
  let x = m.peek16(0x09a2); // entry_cursor
  for (let b = 0x0e; b > 0; b -= 1) {
    m.poke(x, m.read(u));
    u = add16(u, 1);
    m.poke(add16(x, 0x400), 0x3f);
    x = add16(x, -0x20);
  }
  // $B036: 11 attribute bytes of 1 going DOWN the screen (leax $20,x)
  x = m.peek16(0x09a2);
  for (let b = 0x0b; b > 0; b -= 1) {
    m.poke(add16(x, 0x400), 0x01);
    x = add16(x, 0x20);
  }
  attrColumn(m, 0x078a, 0x02, 0x1b); // $B047: ldd #$021B
  attrColumn(m, 0x078d, 0x02, 0x1b); // $B055
  m.poke(0x09a5, 0x05); // entry_timer
  m.poke(0x11ff, (m.peek(0x11ff) + 1) & 0xff); // inc hiscore_step
  incMainTask(m);
}

/**
 * Compare the zero-terminated ROM string at X with the tiles from $024F
 * going right ($B212 / $B22B loops). `lda ,x+ / cmpa ,u / bne /
 * leau -$20,u / lda ,x / bne`.
 * @param {Machine} m @param {number} x
 * @returns {boolean} the whole string matched
 */
function nameIs(m, x) {
  let u = 0x024f;
  for (;;) {
    const a = m.read(x);
    x = add16(x, 1);
    if (a !== m.peek(u)) return false;
    u = add16(u, -0x20);
    if (m.read(x) === 0) return true;
  }
}

/**
 * lB212: the name entry is over (timer ran out). Two secret names are
 * checked on the first TOP 5 row: "JHIMYJ  00  OO" (dat_B146) sets
 * lives_setting to 8; "JNIWAR  28  OO" (dat_B155) blanks the screen
 * and shows the staff message (dat_B164) forever -- the ROM never
 * leaves that loop (only the watchdog read at $B241 keeps it alive).
 * Otherwise (and after the first secret), lB25F.
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
function* hiscore_finish(m) {
  if (nameIs(m, 0xb146)) {
    m.poke(0x1000, 0x08); // $B225: sta <lives_setting
  } else if (nameIs(m, 0xb155)) {
    // $B23E: jsr fill_tilemap_00_20, then the endless loop $B241
    fill_tilemap_00_20(m);
    for (;;) {
      m.peek(0x7c00); // $B241: ldb WATCHDOG
      printTable(m, 0xb164, true, true);
      // Every pass writes the same bytes; the vblank IRQ keeps running
      // in between, so the port repeats the pass once per frame.
      yield;
    }
  }
  // lB25F
  yield* call(mainAt(0xdf19), m, {}); // jsr sound_all_off
  readRows(m, 0xb092, 8); // $B262: scores back into the table
  readRows(m, 0xb0a8, 0x0e); // $B27A: names
  // $B292: blank the rows of the TOP 5 screen: ldx ,y / beq / leay 4,y
  // then the string dat_B11C (spaces) with the attribute cleared
  let y = 0xb070;
  for (;;) {
    let x = m.read16(y);
    if (x === 0) break;
    y = add16(y, 4);
    let u = 0xb11c;
    for (;;) {
      const a = m.read(u);
      u = add16(u, 1);
      if (a === 0) break;
      m.poke(x, a);
      m.poke(add16(x, 0x400), 0);
      x = add16(x, -0x20);
    }
  }
  yield* hiscore_leave(m);
}

/**
 * lB2AE: end of mode 9. Resets hiscore_step, marks the 42 formation
 * slots occupied, clears the two attribute columns, $1854 = $C000,
 * silences everything, $1E01 = $81, waits one frame and goes back to
 * mode 5 task 6 through the next-player code of gp2-3b ($DC0B for
 * player 2, $DBE2 for player 1, both inside task_player_hit_check's
 * flow; they end with `JMP task_dispatch`), called as a tail call.
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
function* hiscore_leave(m) {
  m.poke(0x11ff, 0); // clr hiscore_step
  m.fill(0x1860, 0x01, 0x2a); // $B2B1: formation_flags
  attrColumn(m, 0x078a, 0x00, 0x1b); // $B2BD: clr ,x (x27)
  attrColumn(m, 0x078d, 0x00, 0x1b); // $B2CA
  m.poke16(0x1854, 0xc000); // $B2D7
  m.poke(0x188a, 0); // clr formation_flags+42
  yield* call(mainAt(0xdf19), m, {}); // jsr sound_all_off
  m.poke(0x1e01, 0x81);
  yield; // $B2E8: cwai #$EF -- wait for vblank
  const p2 = m.peek(0x102d) !== 0; // lda <cur_player
  m.poke(0x102f, 0x05); // game_mode
  m.poke(0x1030, 0x06); // main_task
  yield* call(mainAt(p2 ? 0xdc0b : 0xdbe2), m, {});
}

/**
 * hiscore_enter_name ($B304): hiscore_step 2, once per frame. The
 * character under entry_cursor cycles with the stick through the
 * alphabet of the column's field (letters dat_B418 in the name, digits
 * dat_B437 in the age, "ABO ?" dat_B445 in the blood type; the name
 * field is 6 wide, the others 2, with 2-cell gaps the cursor skips with
 * -$40), repeating every 8 frames ($116D) while held. Fire (edge,
 * entry_fire_latch) accepts a character. On frames where frame_counter
 * is 0 entry_timer counts down; the cursor moving past the last field
 * (below $00A0) ticks it up instead, blanking 3 cells at [$09A0]. When
 * it reaches 0 the entry is finished (lB212). Requests the entry music
 * ([entry_music_ptr] = 1) every frame.
 * @see gaplus-main.asm $B304
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
export function* hiscore_enter_name(m) {
  // The two `JMP hiscore_enter_name` ($B390, $B3A5) restart from the top.
  for (;;) {
    let u = m.peek16(0x09a2); // entry_cursor
    m.poke(add16(u, 0x400), 0); // $B307: clr $0400,u
    if (m.peek(0x1016) === 0) { // $B30B: lda <frame_counter / lbeq
      // lB496: dec entry_timer / lbeq lB212
      const t = (m.peek(0x09a5) - 1) & 0xff;
      m.poke(0x09a5, t);
      if (t === 0) { yield* hiscore_finish(m); return; }
      incMainTask(m);
      return;
    }
    // $B311: ldd entry_cursor / andb #$F0 / cmpd ... (unsigned lbcs)
    const d = m.peek16(0x09a2) & 0xfff0;
    let x;
    if (d < 0x00a0) {
      // lB482: ldu $09A0 / clr -$20,u / clr ,u / clr $20,u
      u = m.peek16(0x09a0);
      m.poke(add16(u, -0x20), 0);
      m.poke(u, 0);
      m.poke(add16(u, 0x20), 0);
      const t = (m.peek(0x09a5) + 1) & 0xff; // inc entry_timer
      m.poke(0x09a5, t);
      if (t === 0) { yield* hiscore_finish(m); return; }
      incMainTask(m);
      return;
    } else if (d < 0x0120) {
      x = 0xb445; // lB3A8: blood type
      fieldStep(m, d, 0x00a0);
    } else if (d < 0x01a0) {
      x = 0xb437; // lB3DF: age digits
      fieldStep(m, d, 0x0120);
    } else {
      x = 0xb418; // $B32E: name letters
    }

    // lB331
    m.poke(m.peek16(0x09a7), 0x01); // sta [entry_music_ptr]
    const flip = m.peek(0x102c) !== 0;
    let a = m.peek(0x6804); // $B337: P1 stick (read even when flipped)
    if (flip) a = m.peek(0x6806);
    if ((a & 0x02) !== 0) {
      if (m.peek(0x116d) !== 0) { decRepeat(m); break; } // lB393
      m.poke(0x116d, 0x08);
      // $B34F: lda $116C / inc $116C / lda a,x -- the OLD value indexes
      const i = m.peek(0x116c);
      m.poke(0x116c, (i + 1) & 0xff);
      a = m.read(disp8(x, i));
      if (a === 0) { m.poke(0x116c, 0); continue; } // lB3A2: restart
      m.poke(m.peek16(0x09a2), a);
      break; // jmp lB44B
    }
    // lB361: the stick is read again
    a = m.peek(0x6804);
    if (flip) a = m.peek(0x6806);
    if ((a & 0x08) !== 0) {
      if (m.peek(0x116d) !== 0) { decRepeat(m); break; }
      m.poke(0x116d, 0x08);
      // $B379: dec $116C / lda $116C / lda a,x
      const i = (m.peek(0x116c) - 1) & 0xff;
      m.poke(0x116c, i);
      a = m.read(disp8(x, i));
      if (a === 0) {
        // lB38B: lda -2,x / sta $116C -- wrap around. The byte 2 before
        // each alphabet is the index of its terminator ($B416 = $1C for
        // the letters, $B435 = $0B the digits, $B443 = $05 "ABO ?"), so
        // the next step left lands on the last character.
        m.poke(0x116c, m.read(add16(x, -2)));
        continue; // jmp hiscore_enter_name
      }
      m.poke(m.peek16(0x09a2), a);
      break;
    }
    // lB399: lda $116D / lbeq lB44B / bra lB393
    if (m.peek(0x116d) !== 0) decRepeat(m);
    break;
  }

  // lB44B: fire accepts the character and moves the cursor right
  let u = m.peek16(0x09a2);
  let a = m.peek(0x6805);
  if (m.peek(0x102c) !== 0) a = m.peek(0x6807);
  if ((a & 0x02) !== 0) {
    if (m.peek(0x09a4) === 0) { // entry_fire_latch
      m.poke(0x09a4, 0x01); // inc (it was 0)
      m.poke(add16(u, 0x400), 0x01);
      u = add16(u, -0x20);
      m.poke16(0x09a2, u);
      m.poke(0x116c, 0);
      m.poke(0x09a5, 0x05); // entry_timer
    }
  } else {
    m.poke(0x09a4, 0); // lB47D: clr entry_fire_latch
  }
  incMainTask(m); // lB478
}

/**
 * lB393: `DEC $116D` (the auto-repeat delay).
 * @param {Machine} m
 */
function decRepeat(m) {
  m.poke(0x116d, (m.peek(0x116d) - 1) & 0xff);
}

/**
 * lB3A8 / lB3DF: within a 2-cell field the cursor stays on the four
 * cells base..base+$30; anywhere else (the gap after the field) it jumps
 * 2 cells right (`leau -$40,u`) and the alphabet index restarts.
 * @param {Machine} m @param {number} d entry_cursor & $FFF0
 * @param {number} base $00A0 or $0120
 */
function fieldStep(m, d, base) {
  // cmpd #base+$30 / +$20 / +$10 / base, each lbeq lB331
  if (d === base + 0x30 || d === base + 0x20 || d === base + 0x10
      || d === base) return;
  m.poke16(0x09a2, add16(m.peek16(0x09a2), -0x40));
  m.poke(0x116c, 0);
}

/**
 * load_formation_sprites ($B656): copy the formation's sprite codes into
 * the first shadow entries: the table dat_B6BA indexed by $106E points
 * at 9 words; each of the first 8 fills a run of shadow words
 * ($0E02-$0E15, -$0E1F, -$0E27, -$0E2B; $0E30-$0E57, -$0E6B, -$0E7B,
 * -$0E83), the 9th goes to $0E84.
 * @see gaplus-main.asm $B656
 * @param {Machine} m
 */
export function load_formation_sprites(m) {
  // $B656: ldx #$B6BA / lda <$6E / asla / ldx a,x (signed offset)
  let x = m.read16(disp8(0xb6ba, (m.peek(0x106e) << 1) & 0xff));
  let u = 0x0e02;
  // Each run is `ldd ,x++` then do { std ,u++ } while (u != end).
  for (const end of [0x0e16, 0x0e20, 0x0e28, 0x0e2c, -1,
    0x0e58, 0x0e6c, 0x0e7c, 0x0e84]) {
    if (end === -1) { u = 0x0e30; continue; } // $B689: ldu #$0E30
    const d = m.read16(x);
    x = add16(x, 2);
    do {
      m.poke16(u, d);
      u = add16(u, 2);
    } while (u !== end);
  }
  m.poke16(0x0e84, m.read16(x)); // $B6B4: ldd ,x++ / std $0E84
}

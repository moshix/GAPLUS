// Copyright 2026 by Moshix
/**
 * gp2-4.8d ($A000-$BFFF), part 1 of 2: game mode 9, the TOP 5 check and
 * the name entry (task_hiscore_entry and its three steps), and
 * load_formation_sprites.
 *
 * TASK CONVENTION. The mode-9 task list is run by task_dispatch ($FEB5,
 * gp2_2b). A task ends with `INC <main_task / JMP task_dispatch`; in the
 * port the task performs the INC, charges the JMP and RETURNS, and the
 * dispatcher loops (it re-reads game_mode/main_task as the 6809 does).
 * Tasks here are generators: they yield SYNC before shared accesses, and
 * the end of mode 9 reaches a `CWAI #$EF` (16 cycles, then one `yield`).
 *
 * TIMING (docs/porting-guide.md section 6.4). Every instruction is
 * charged with its MAME cycles, one `m.charge()` per instruction, after
 * its accesses; JSR/JMP are charged by the code that executes them. The
 * helpers rd / rd16 / wr / wr16 / rmw below are one instruction each:
 * `at()` (SYNC when the access is timed -- nearly everything here is
 * tile or work RAM below $2000 -- or when the chunk has run past the
 * vblank), the access, the charge. Cycles are quoted `(n)` in comments.
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
import { at } from '../timing.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {Generator<unknown, void, unknown>} Gen */

/**
 * `LEAX -$20,X` and friends: 16-bit wrap.
 * @param {number} v @param {number} d
 */
const add16 = (v, d) => (v + d) & 0xffff;

/**
 * One reading instruction of `cyc` cycles (LDA, CMPA, LDB...): SYNC if
 * needed, read, charge.
 * @param {Machine} m @param {number} addr @param {number} cyc
 * @returns {Generator<unknown, number, unknown>}
 */
function* rd(m, addr, cyc) {
  yield* at(m, addr);
  const v = m.peek(addr & 0xffff);
  m.charge(cyc);
  return v;
}

/**
 * One 16-bit load (LDD/LDX/LDU/LDY, high byte first).
 * @param {Machine} m @param {number} addr @param {number} cyc
 * @returns {Generator<unknown, number, unknown>}
 */
function* rd16(m, addr, cyc) {
  yield* at(m, addr);
  const v = m.peek16(addr & 0xffff);
  m.charge(cyc);
  return v;
}

/**
 * One storing instruction (STA/STB, or CLR on memory with v = 0).
 * @param {Machine} m @param {number} addr @param {number} v
 * @param {number} cyc
 * @returns {Gen}
 */
function* wr(m, addr, v, cyc) {
  yield* at(m, addr);
  m.poke(addr & 0xffff, v & 0xff);
  m.charge(cyc);
}

/**
 * One 16-bit store (STD/STX/STU, high byte first).
 * @param {Machine} m @param {number} addr @param {number} v
 * @param {number} cyc
 * @returns {Gen}
 */
function* wr16(m, addr, v, cyc) {
  yield* at(m, addr);
  m.poke16(addr & 0xffff, v & 0xffff);
  m.charge(cyc);
}

/**
 * A read-modify-write (INC/DEC on memory): one instruction, one SYNC.
 * @param {Machine} m @param {number} addr @param {number} d +1 or -1
 * @param {number} cyc
 * @returns {Generator<unknown, number, unknown>} the value written
 */
function* rmw(m, addr, d, cyc) {
  yield* at(m, addr);
  const v = (m.peek(addr & 0xffff) + d) & 0xff;
  m.poke(addr & 0xffff, v);
  m.charge(cyc);
  return v;
}

/**
 * `INC <main_task (6) / JMP task_dispatch (4)` ($1030), the common end
 * of a task.
 * @param {Machine} m
 * @returns {Gen}
 */
function* nextTask(m) {
  yield* rmw(m, 0x1030, 1, 6);
  m.charge(4); // jmp task_dispatch
}

/**
 * task_hiscore_entry ($AFBE): mode 9 task 0. Dispatches on hiscore_step
 * ($11FF) through the hiscore_steps table ($AFC7): 0 hiscore_check,
 * 1 hiscore_draw_screen, 2 hiscore_enter_name.
 * @see gaplus-main.asm $AFBE
 * @param {Machine} m
 * @returns {Gen}
 */
export function* task_hiscore_entry(m) {
  // $AFBE: lda hiscore_step (5) / asla (2) / ldx #$AFC7 (3) /
  // jmp [a,x] (7) (asla is an 8-bit shift; a,x is a signed offset)
  const a = ((yield* rd(m, 0x11ff, 5)) << 1) & 0xff;
  m.charge(2);
  m.charge(3);
  const target = yield* rd16(m, disp8(0xafc7, a), 7);
  yield* call(mainAt(target), m, {});
}

/**
 * Copy the player's score digits (8 tile codes read from Y going down
 * in address) into a table entry at U: `ldb #8 (2) / tfr y,x (6) /
 * ldu #u (3)`, then 8 x `lda ,x (4) / sta ,u+ (6) / leax -1,x (5) /
 * decb (2) / bne (3)`.
 * @param {Machine} m @param {number} y first digit's tile @param {number} u
 * @returns {Gen}
 */
function* copyScore(m, y, u) {
  m.charge(2);
  m.charge(6);
  m.charge(3);
  let x = y;
  for (let b = 8; b > 0; b -= 1) {
    const a = yield* rd(m, x, 4);
    yield* wr(m, u, a, 6);
    u = add16(u, 1);
    m.charge(5);
    x = add16(x, -1);
    m.charge(2);
    m.charge(3);
  }
}

/**
 * Move TOP 5 entry n-1 down to entry n: `ldx #x (3) / ldu #u (3) /
 * ldb #8 (2)`, 8 x `lda -$10,x (5) / sta ,x+ (6) / decb (2) / bne (3)`,
 * `ldb #$0E (2)`, 14 x the same on U.
 * @param {Machine} m @param {number} x @param {number} u
 * @returns {Gen}
 */
function* shiftEntry(m, x, u) {
  m.charge(3);
  m.charge(3);
  m.charge(2);
  for (let b = 8; b > 0; b -= 1) {
    const a = yield* rd(m, add16(x, -0x10), 5);
    yield* wr(m, x, a, 6);
    x = add16(x, 1);
    m.charge(2);
    m.charge(3);
  }
  m.charge(2);
  for (let b = 0x0e; b > 0; b -= 1) {
    const a = yield* rd(m, add16(u, -0x10), 5);
    yield* wr(m, u, a, 6);
    u = add16(u, 1);
    m.charge(2);
    m.charge(3);
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
 * @returns {Gen}
 */
export function* hiscore_check(m) {
  m.charge(8); // $B49F: jsr sound_all_off
  yield* call(mainAt(0xdf19), m, {});
  // $B4A2: ldy #$03FD (4) / lda <cur_player (4) / beq (3) /
  // ldy #$03EB (4)
  m.charge(4);
  let y = 0x03fd;
  const p = yield* rd(m, 0x102d, 4);
  m.charge(3);
  if (p !== 0) { y = 0x03eb; m.charge(4); }

  // $B4AE-$B524: five unrolled compare loops. `tfr y,x (6) / ldu #e (3)
  // / ldb #8 (2)`, then `lda ,x (4) / cmpa ,u (4) / bcs next (3) /
  // bne found (3) / leau 1,u (5) / leax -1,x (5) / decb (2) / bne (3)`:
  // lower digit -> try the next entry, higher -> rank found, 8 equal
  // digits (`bra found` (3)) also count as found (a tie goes above).
  let rank = 5;
  for (let k = 0; k < 5 && rank === 5; k += 1) {
    m.charge(6);
    m.charge(3);
    m.charge(2);
    let x = y;
    let u = 0x0900 + k * 0x10;
    let lower = false;
    for (let b = 8; ; b -= 1) {
      const a = yield* rd(m, x, 4);
      const t = yield* rd(m, u, 4);
      m.charge(3); // bcs
      if (a < t) { lower = true; break; }
      m.charge(3); // bne
      if (a !== t) break;
      m.charge(5);
      u = add16(u, 1);
      m.charge(5);
      x = add16(x, -1);
      m.charge(2); // decb
      m.charge(3); // bne
      if (b === 1) { m.charge(3); break; } // bra found
    }
    if (!lower) rank = k;
  }
  if (rank === 5) {
    m.charge(4); // $B526: jmp lB2AE -- not in the TOP 5
    yield* hiscore_leave(m);
    return;
  }

  // $B529/$B53C/...: ldd (3) / std entry_cursor (6) / ldd (3) /
  // std entry_music_ptr (6)
  m.charge(3);
  yield* wr16(m, 0x09a2, 0x024f + rank * 3, 6); // entry_cursor
  m.charge(3);
  yield* wr16(m, 0x09a7, rank === 0 ? 0x6043 : 0x6044, 6);
  if (rank === 4) {
    // $B581: the last entry is simply replaced (no entry_rank store)
    yield* copyScore(m, y, 0x0940);
    m.charge(4); // jmp lB64C
  } else {
    m.charge(2); // lda #n
    yield* wr(m, 0x09a6, 4 - rank, 5); // sta entry_rank
    m.charge(3); // bra lB594
    // $B594..: shift entries 3->4, 2->3, ... down to rank->rank+1. Each
    // step `DEC entry_rank (7) / BEQ (3)` and stops at 0; the last step
    // (0->1) ends with `CLR entry_rank` (7) instead. The score then
    // goes into the freed entry (`bra lB64C` (3), except lB63C which
    // falls through).
    let dst = 0x0940;
    for (;;) {
      yield* shiftEntry(m, dst, dst + 0x50);
      if (dst === 0x0910) {
        yield* wr(m, 0x09a6, 0, 7); // $B603: clr entry_rank
        break;
      }
      const r = yield* rmw(m, 0x09a6, -1, 7); // dec entry_rank
      m.charge(3); // beq
      if (r === 0) break;
      dst -= 0x10;
    }
    yield* copyScore(m, y, dst - 0x10);
    if (dst !== 0x0920) m.charge(3); // bra lB64C
  }
  // $B64C: inc hiscore_step (7) / inc <main_task (6) x2 / jmp (4)
  yield* rmw(m, 0x11ff, 1, 7);
  yield* rmw(m, 0x1030, 1, 6);
  yield* nextTask(m);
}

/**
 * The $AFDD loop: print zero-terminated strings from a table of (tile
 * address, string) pairs ended by a zero address: `ldx ,y++ (8) / beq
 * (3) / ldu ,y++ (8)`, then `lda ,u+ (6) / beq (3) / sta ,x (4) /
 * leax -$20,x (5) / bra (3)`.
 * @param {Machine} m @param {number} y table
 * @returns {Gen}
 */
function* printTable(m, y) {
  for (;;) {
    let dst = yield* rd16(m, y, 8);
    y = add16(y, 2);
    m.charge(3);
    if (dst === 0) return;
    let src = yield* rd16(m, y, 8);
    y = add16(y, 2);
    for (;;) {
      const a = yield* rd(m, src, 6);
      src = add16(src, 1);
      m.charge(3);
      if (a === 0) break;
      yield* wr(m, dst, a, 4);
      m.charge(5);
      dst = add16(dst, -0x20);
      m.charge(3);
    }
  }
}

/**
 * Fixed-length rows from a (tile address, source) table ($AFF2 / $B00A):
 * `ldb #n (2) / ldx ,y++ (8) / beq (3) / ldu ,y++ (8)` then n x
 * `lda ,u+ (6) / sta ,x (4) / leax -$20,x (5) / decb (2) / bne (3)`,
 * `bra (3)`.
 * @param {Machine} m @param {number} y @param {number} n
 * @returns {Gen}
 */
function* drawRows(m, y, n) {
  for (;;) {
    m.charge(2);
    let x = yield* rd16(m, y, 8);
    y = add16(y, 2);
    m.charge(3);
    if (x === 0) return;
    let u = yield* rd16(m, y, 8);
    y = add16(y, 2);
    for (let b = n; b > 0; b -= 1) {
      const a = yield* rd(m, u, 6);
      u = add16(u, 1);
      yield* wr(m, x, a, 4);
      m.charge(5);
      x = add16(x, -0x20);
      m.charge(2);
      m.charge(3);
    }
    m.charge(3);
  }
}

/**
 * The reverse ($B266 / $B27E): read n tile codes from the screen (U,
 * going right) back into the table (X, going up): `ldu ,y++ (8) / beq
 * (3) / ldx ,y++ (8) / ldb #n (2)`, n x `lda ,u (4) / sta ,x+ (6) /
 * leau -$20,u (5) / decb (2) / bne (3)`, `bra (3)`.
 * @param {Machine} m @param {number} y @param {number} n
 * @returns {Gen}
 */
function* readRows(m, y, n) {
  for (;;) {
    let u = yield* rd16(m, y, 8);
    y = add16(y, 2);
    m.charge(3);
    if (u === 0) return;
    let x = yield* rd16(m, y, 8);
    y = add16(y, 2);
    m.charge(2);
    for (let b = n; b > 0; b -= 1) {
      const a = yield* rd(m, u, 4);
      yield* wr(m, x, a, 6);
      x = add16(x, 1);
      m.charge(5);
      u = add16(u, -0x20);
      m.charge(2);
      m.charge(3);
    }
    m.charge(3);
  }
}

/**
 * A column of 27 attribute bytes: `ldx #x (3)`, then the setup (`ldd
 * #$021B` (3) or `lda #$1B` (2)), then 27 x `sta ,x (4)` or `clr ,x (6)`
 * / `leax -$20,x (5) / decb|deca (2) / bne (3)`.
 * @param {Machine} m @param {number} x @param {number} v
 * @param {number} setup cycles of the count load
 * @param {number} st cycles of the store
 * @returns {Gen}
 */
function* attrColumn(m, x, v, setup, st) {
  m.charge(3);
  m.charge(setup);
  for (let b = 0x1b; b > 0; b -= 1) {
    yield* wr(m, x, v, st);
    m.charge(5);
    x = add16(x, -0x20);
    m.charge(2);
    m.charge(3);
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
 * @returns {Gen}
 */
export function* hiscore_draw_screen(m) {
  m.charge(8); // jsr clear_sprite_shadows
  yield* call(mainAt(0xdf5d), m, {});
  m.charge(3); // ldd #$7848
  yield* wr16(m, 0x1600, 0x7848, 6); // player_y / player_x
  yield* wr(m, 0x1e01, 0, 7); // clr $1E01
  m.charge(4); // $AFD9: ldy #$B070
  yield* printTable(m, 0xb070); // headings, ranks
  m.charge(4); // $AFEE: ldy #$B092
  yield* drawRows(m, 0xb092, 8); // scores
  m.charge(4); // $B006: ldy #$B0A8
  yield* drawRows(m, 0xb0a8, 0x0e); // names
  // $B01E: the placeholder name row, with attribute $3F: ldu #$B138 (3)
  // / ldx entry_cursor (6) / ldb #$0E (2), 14 x `lda ,u+ (6) / sta ,x
  // (4) / lda #$3F (2) / sta $0400,x (8) / leax -$20,x (5) / decb (2) /
  // bne (3)`
  m.charge(3);
  let u = 0xb138;
  let x = yield* rd16(m, 0x09a2, 6);
  m.charge(2);
  for (let b = 0x0e; b > 0; b -= 1) {
    const a = yield* rd(m, u, 6);
    u = add16(u, 1);
    yield* wr(m, x, a, 4);
    m.charge(2);
    yield* wr(m, add16(x, 0x400), 0x3f, 8);
    m.charge(5);
    x = add16(x, -0x20);
    m.charge(2);
    m.charge(3);
  }
  // $B036: 11 attribute bytes of 1 going DOWN the screen: ldx (6) /
  // ldb #$0B (2), 11 x `lda #1 (2) / sta $0400,x (8) / leax $20,x (5) /
  // decb (2) / bne (3)`
  x = yield* rd16(m, 0x09a2, 6);
  m.charge(2);
  for (let b = 0x0b; b > 0; b -= 1) {
    m.charge(2);
    yield* wr(m, add16(x, 0x400), 0x01, 8);
    m.charge(5);
    x = add16(x, 0x20);
    m.charge(2);
    m.charge(3);
  }
  yield* attrColumn(m, 0x078a, 0x02, 3, 4); // $B047: ldd #$021B
  yield* attrColumn(m, 0x078d, 0x02, 3, 4); // $B055
  m.charge(2); // lda #5
  yield* wr(m, 0x09a5, 0x05, 5); // entry_timer
  yield* rmw(m, 0x11ff, 1, 7); // inc hiscore_step
  yield* nextTask(m);
}

/**
 * Compare the zero-terminated ROM string at X with the tiles from $024F
 * going right ($B212 / $B22B loops): `ldx #s (3) / ldu #$024F (3)`,
 * then `lda ,x+ (6) / cmpa ,u (4) / bne (3) / leau -$20,u (5) /
 * lda ,x (4) / bne (3)`.
 * @param {Machine} m @param {number} x
 * @returns {Generator<unknown, boolean, unknown>} the whole string matched
 */
function* nameIs(m, x) {
  m.charge(3);
  m.charge(3);
  let u = 0x024f;
  for (;;) {
    const a = yield* rd(m, x, 6);
    x = add16(x, 1);
    const t = yield* rd(m, u, 4);
    m.charge(3);
    if (a !== t) return false;
    m.charge(5);
    u = add16(u, -0x20);
    const n = yield* rd(m, x, 4);
    m.charge(3);
    if (n === 0) return true;
  }
}

/**
 * fill_tilemap_00_20 ($B77C, gp2_4_svc.js) as called from the name
 * entry, where the IRQ is on: the same stores, charged per instruction
 * for the scheduler (gp2_4_svc.js times it on the service mode's burn
 * clock instead). `ldx #0 (3) / ldu #$0020 (3)`, 512 x `ldy WATCHDOG
 * (7) / stu ,x++ (8) / cmpx #$0400 (4) / bne (3)`, `rts (5)`.
 * @param {Machine} m
 * @returns {Gen}
 */
function* fillTilemap(m) {
  m.charge(3);
  m.charge(3);
  for (let x = 0; x !== 0x400; x += 2) {
    yield* rd16(m, 0x7c00, 7); // the watchdog read
    yield* wr16(m, x, 0x0020, 8);
    m.charge(4);
    m.charge(3);
  }
  m.charge(5);
}

/**
 * lB212: the name entry is over (timer ran out). Two secret names are
 * checked on the first TOP 5 row: "JHIMYJ  00  OO" (dat_B146) sets
 * lives_setting to 8; "JNIWAR  28  OO" (dat_B155) blanks the screen
 * and shows the staff message (dat_B164) forever -- the ROM never
 * leaves that loop (only the watchdog read at $B241 keeps it alive).
 * Otherwise (and after the first secret), lB25F.
 * @param {Machine} m
 * @returns {Gen}
 */
function* hiscore_finish(m) {
  if (yield* nameIs(m, 0xb146)) {
    m.charge(2); // lda #8
    yield* wr(m, 0x1000, 0x08, 4); // $B227: sta <lives_setting
    m.charge(3); // bra lB25F
  } else if (yield* nameIs(m, 0xb155)) {
    m.charge(8); // $B23E: jsr fill_tilemap_00_20
    yield* fillTilemap(m);
    // $B241: the endless loop. The vblank IRQ keeps running in between
    // (the scheduler enters it at an instruction boundary, as ever).
    for (;;) {
      yield* rd(m, 0x7c00, 5); // $B241: ldb WATCHDOG
      m.charge(4); // ldy #$B164
      let y = 0xb164;
      // lB248: ldx ,y++ (8) / beq $B241 (3) / ldu ,y++ (8); lB24E:
      // lda ,x+ (6) / beq lB25D (3) / sta ,u (4) / clr $0400,u (10) /
      // leau -$20,u (5) / bra (3); lB25D: bra lB248 (3). The table is
      // (string, tile address) pairs.
      for (;;) {
        let x = yield* rd16(m, y, 8);
        y = add16(y, 2);
        m.charge(3);
        if (x === 0) break;
        let u = yield* rd16(m, y, 8);
        y = add16(y, 2);
        for (;;) {
          const a = yield* rd(m, x, 6);
          x = add16(x, 1);
          m.charge(3);
          if (a === 0) break;
          yield* wr(m, u, a, 4);
          yield* wr(m, add16(u, 0x400), 0, 10);
          m.charge(5);
          u = add16(u, -0x20);
          m.charge(3);
        }
        m.charge(3); // lB25D: bra lB248
      }
    }
  }
  // lB25F
  m.charge(8); // jsr sound_all_off
  yield* call(mainAt(0xdf19), m, {});
  m.charge(4); // $B262: ldy #$B092
  yield* readRows(m, 0xb092, 8); // scores back into the table
  m.charge(4); // $B27A: ldy #$B0A8
  yield* readRows(m, 0xb0a8, 0x0e); // names
  // $B292: blank the rows of the TOP 5 screen: ldy #$B070 (4); lB296:
  // ldx ,y (5) / beq (3) / leay 4,y (5) / ldu #$B11C (3), then the
  // spaces with the attribute cleared: lda ,u+ (6) / beq lB296 (3) /
  // sta ,x (4) / clr $0400,x (10) / leax -$20,x (5) / bra (3)
  m.charge(4);
  let y = 0xb070;
  for (;;) {
    let x = yield* rd16(m, y, 5);
    m.charge(3);
    if (x === 0) break;
    m.charge(5);
    y = add16(y, 4);
    m.charge(3);
    let u = 0xb11c;
    for (;;) {
      const a = yield* rd(m, u, 6);
      u = add16(u, 1);
      m.charge(3);
      if (a === 0) break;
      yield* wr(m, x, a, 4);
      yield* wr(m, add16(x, 0x400), 0, 10);
      m.charge(5);
      x = add16(x, -0x20);
      m.charge(3);
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
 * @returns {Gen}
 */
function* hiscore_leave(m) {
  yield* wr(m, 0x11ff, 0, 7); // clr hiscore_step
  // $B2B1: ldx #$1860 (3) / lda #1 (2) / ldb #$2A (2), 42 x
  // `sta ,x+ (6) / decb (2) / bne (3)` -- formation_flags
  m.charge(3);
  m.charge(2);
  m.charge(2);
  for (let i = 0; i < 0x2a; i += 1) {
    yield* wr(m, 0x1860 + i, 0x01, 6);
    m.charge(2);
    m.charge(3);
  }
  yield* attrColumn(m, 0x078a, 0x00, 2, 6); // $B2BD: clr ,x (x27)
  yield* attrColumn(m, 0x078d, 0x00, 2, 6); // $B2CA
  m.charge(3); // $B2D7: ldd #$C000
  yield* wr16(m, 0x1854, 0xc000, 6);
  yield* wr(m, 0x188a, 0, 7); // clr formation_flags+42
  m.charge(8); // jsr sound_all_off
  yield* call(mainAt(0xdf19), m, {});
  m.charge(2); // lda #$81
  yield* wr(m, 0x1e01, 0x81, 5);
  m.charge(16);
  yield; // $B2E8: cwai #$EF -- wait for vblank
  // lda <cur_player (4) / beq (3) / lda #5 (2) / sta <game_mode (4) /
  // lda #6 (2) / sta <main_task (4) / jmp (4)
  const p2 = (yield* rd(m, 0x102d, 4)) !== 0;
  m.charge(3);
  m.charge(2);
  yield* wr(m, 0x102f, 0x05, 4); // game_mode
  m.charge(2);
  yield* wr(m, 0x1030, 0x06, 4); // main_task
  m.charge(4);
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
 * @returns {Gen}
 */
export function* hiscore_enter_name(m) {
  // The two `JMP hiscore_enter_name` ($B390, $B3A5) restart from the top.
  for (;;) {
    // $B304: ldu entry_cursor (6) / clr $0400,u (10) /
    // lda <frame_counter (4) / lbeq lB496 (5, 6 taken)
    const u = yield* rd16(m, 0x09a2, 6);
    yield* wr(m, add16(u, 0x400), 0, 10);
    if ((yield* rd(m, 0x1016, 4)) === 0) {
      m.charge(6);
      // lB496: dec entry_timer (7) / lbeq lB212 (5/6) / bra lB478 (3)
      const t = yield* rmw(m, 0x09a5, -1, 7);
      if (t === 0) { m.charge(6); yield* hiscore_finish(m); return; }
      m.charge(5);
      m.charge(3);
      yield* nextTask(m);
      return;
    }
    m.charge(5);
    // $B311: ldd entry_cursor (6) / andb #$F0 (2), then `cmpd #n (5) /
    // lbcs (5, 6 taken)` for $00A0, $0120, $01A0 (unsigned)
    const d = (yield* rd16(m, 0x09a2, 6)) & 0xfff0;
    m.charge(2);
    let x;
    m.charge(5);
    if (d < 0x00a0) {
      m.charge(6);
      // lB482: ldu $09A0 (6) / clr -$20,u (7) / clr ,u (6) /
      // clr $20,u (7) / inc entry_timer (7) / lbeq (5/6) / bra (3)
      const v = yield* rd16(m, 0x09a0, 6);
      yield* wr(m, add16(v, -0x20), 0, 7);
      yield* wr(m, v, 0, 6);
      yield* wr(m, add16(v, 0x20), 0, 7);
      const t = yield* rmw(m, 0x09a5, 1, 7);
      if (t === 0) { m.charge(6); yield* hiscore_finish(m); return; }
      m.charge(5);
      m.charge(3);
      yield* nextTask(m);
      return;
    }
    m.charge(5);
    m.charge(5);
    if (d < 0x0120) {
      m.charge(6);
      x = 0xb445; // lB3A8: blood type
      yield* fieldStep(m, 0x00a0);
    } else {
      m.charge(5);
      m.charge(5);
      if (d < 0x01a0) {
        m.charge(6);
        x = 0xb437; // lB3DF: age digits
        yield* fieldStep(m, 0x0120);
      } else {
        m.charge(5);
        x = 0xb418; // $B32E: name letters
        m.charge(3);
      }
    }

    // lB331 entry_step_char: lda #1 (2) / sta [entry_music_ptr] (9)
    m.charge(2);
    yield* at(m, 0x09a7);
    m.poke(m.peek16(0x09a7), 0x01);
    m.charge(9);
    // $B337: lda $6804 (5) / ldb <flip_screen (4) / beq (3) /
    // lda $6806 (5) / anda #$02 (2) / beq lB361 (3)
    if (((yield* stick(m)) & 0x02) !== 0) {
      // lda $116D (5) / bne lB393 (3)
      if ((yield* rd(m, 0x116d, 5)) !== 0) {
        m.charge(3);
        yield* decRepeat(m);
        break;
      }
      m.charge(3);
      m.charge(2); // lda #8
      yield* wr(m, 0x116d, 0x08, 5);
      // $B34F: lda $116C (5) / inc $116C (7) / lda a,x (5) / beq (3) --
      // the OLD value indexes
      const i = yield* rd(m, 0x116c, 5);
      yield* rmw(m, 0x116c, 1, 7);
      const a = yield* rd(m, disp8(x, i), 5);
      m.charge(3);
      if (a === 0) {
        // lB3A2: clr $116C (7) / jmp hiscore_enter_name (4): restart
        yield* wr(m, 0x116c, 0, 7);
        m.charge(4);
        continue;
      }
      // ldu entry_cursor (6) / sta ,u (4) / jmp entry_fire (4)
      yield* wr(m, yield* rd16(m, 0x09a2, 6), a, 4);
      m.charge(4);
      break;
    }
    // lB361: the stick is read again, same instructions, bit 3
    if (((yield* stick(m)) & 0x08) !== 0) {
      if ((yield* rd(m, 0x116d, 5)) !== 0) {
        m.charge(3);
        yield* decRepeat(m);
        break;
      }
      m.charge(3);
      m.charge(2);
      yield* wr(m, 0x116d, 0x08, 5);
      // $B379: dec $116C (7) / lda $116C (5) / lda a,x (5) / beq (3)
      yield* rmw(m, 0x116c, -1, 7);
      const i = yield* rd(m, 0x116c, 5);
      const a = yield* rd(m, disp8(x, i), 5);
      m.charge(3);
      if (a === 0) {
        // lB38B: lda -2,x (5) / sta $116C (5) / jmp (4) -- wrap around.
        // The byte 2 before each alphabet is the index of its
        // terminator ($B416 = $1C for the letters, $B435 = $0B the
        // digits, $B443 = $05 "ABO ?"), so the next step left lands on
        // the last character.
        const w = yield* rd(m, add16(x, -2), 5);
        yield* wr(m, 0x116c, w, 5);
        m.charge(4);
        continue; // jmp hiscore_enter_name
      }
      yield* wr(m, yield* rd16(m, 0x09a2, 6), a, 4);
      m.charge(4);
      break;
    }
    // lB399: lda $116D (5) / lbeq entry_fire (5/6) / bra lB393 (3)
    if ((yield* rd(m, 0x116d, 5)) !== 0) {
      m.charge(5);
      m.charge(3);
      yield* decRepeat(m);
    } else {
      m.charge(6);
    }
    break;
  }

  // entry_fire ($B44B): fire accepts the character and moves the cursor
  // right. ldu entry_cursor (6) / lda $6805 (5) / ldb <flip_screen (4) /
  // beq (3) / lda $6807 (5) / anda #$02 (2) / beq lB47D (3)
  let u = yield* rd16(m, 0x09a2, 6);
  let a = yield* rd(m, 0x6805, 5);
  const flip = yield* rd(m, 0x102c, 4);
  m.charge(3);
  if (flip !== 0) a = yield* rd(m, 0x6807, 5);
  m.charge(2);
  m.charge(3);
  if ((a & 0x02) !== 0) {
    // lda entry_fire_latch (5) / bne lB478 (3)
    const latch = yield* rd(m, 0x09a4, 5);
    m.charge(3);
    if (latch === 0) {
      // inc latch (7) / lda #1 (2) / sta $0400,u (8) / leau -$20,u (5)
      // / stu entry_cursor (6) / clr $116C (7) / lda #5 (2) /
      // sta entry_timer (5)
      yield* rmw(m, 0x09a4, 1, 7);
      m.charge(2);
      yield* wr(m, add16(u, 0x400), 0x01, 8);
      m.charge(5);
      u = add16(u, -0x20);
      yield* wr16(m, 0x09a2, u, 6);
      yield* wr(m, 0x116c, 0, 7);
      m.charge(2);
      yield* wr(m, 0x09a5, 0x05, 5); // entry_timer
    }
  } else {
    yield* wr(m, 0x09a4, 0, 7); // lB47D: clr entry_fire_latch
    m.charge(3); // bra lB478
  }
  yield* nextTask(m); // lB478
}

/**
 * The stick read of $B337 / $B361: `lda $6804 (5) / ldb <flip_screen
 * (4) / beq (3) / lda $6806 (5)` (the P1 stick is read even when the
 * screen is flipped), then `anda #n (2) / beq (3)` charged here too.
 * @param {Machine} m
 * @returns {Generator<unknown, number, unknown>} the stick byte
 */
function* stick(m) {
  let a = yield* rd(m, 0x6804, 5);
  const flip = yield* rd(m, 0x102c, 4);
  m.charge(3);
  if (flip !== 0) a = yield* rd(m, 0x6806, 5);
  m.charge(2);
  m.charge(3);
  return a;
}

/**
 * lB393: `DEC $116D (7) / JMP entry_fire (4)` (the auto-repeat delay).
 * @param {Machine} m
 * @returns {Gen}
 */
function* decRepeat(m) {
  yield* rmw(m, 0x116d, -1, 7);
  m.charge(4);
}

/**
 * lB3A8 / lB3DF: within a 2-cell field the cursor stays on the four
 * cells base..base+$30; anywhere else (the gap after the field) it jumps
 * 2 cells right (`leau -$40,u`) and the alphabet index restarts.
 * `ldx #alphabet (3) / ldd entry_cursor (6) / andb #$F0 (2)`, then
 * `cmpd #n (5) / lbeq entry_step_char (5, 6 taken)` for base+$30, +$20,
 * +$10, base; else `ldu (6) / leau -$40,u (5) / stu (6) / clr $116C (7)
 * / jmp entry_step_char (4)`.
 * @param {Machine} m
 * @param {number} base $00A0 or $0120
 * @returns {Gen}
 */
function* fieldStep(m, base) {
  m.charge(3);
  const d = (yield* rd16(m, 0x09a2, 6)) & 0xfff0;
  m.charge(2);
  for (const c of [base + 0x30, base + 0x20, base + 0x10, base]) {
    m.charge(5);
    if (d === c) { m.charge(6); return; }
    m.charge(5);
  }
  const u = yield* rd16(m, 0x09a2, 6);
  m.charge(5);
  yield* wr16(m, 0x09a2, add16(u, -0x40), 6);
  yield* wr(m, 0x116c, 0, 7);
  m.charge(4);
}

/**
 * load_formation_sprites ($B656): copy the formation's sprite codes into
 * the first shadow entries: the table dat_B6BA indexed by $106E points
 * at 9 words; each of the first 8 fills a run of shadow words
 * ($0E02-$0E15, -$0E1F, -$0E27, -$0E2B; $0E30-$0E57, -$0E6B, -$0E7B,
 * -$0E83), the 9th goes to $0E84.
 * @see gaplus-main.asm $B656
 * @param {Machine} m
 * @returns {Gen}
 */
export function* load_formation_sprites(m) {
  // $B656: ldx #$B6BA (3) / lda <$6E (4) / asla (2) / ldx a,x (6)
  // (signed offset) / ldu #$0E02 (3)
  m.charge(3);
  const a = ((yield* rd(m, 0x106e, 4)) << 1) & 0xff;
  m.charge(2);
  let x = yield* rd16(m, disp8(0xb6ba, a), 6);
  m.charge(3);
  let u = 0x0e02;
  // Each run is `ldd ,x++ (8)` then do { std ,u++ (8) / cmpu #end (5) /
  // bne (3) } while (u != end).
  for (const end of [0x0e16, 0x0e20, 0x0e28, 0x0e2c, -1,
    0x0e58, 0x0e6c, 0x0e7c, 0x0e84]) {
    if (end === -1) { u = 0x0e30; m.charge(3); continue; } // ldu #$0E30
    const d = yield* rd16(m, x, 8);
    x = add16(x, 2);
    do {
      yield* wr16(m, u, d, 8);
      u = add16(u, 2);
      m.charge(5);
      m.charge(3);
    } while (u !== end);
  }
  // $B6B4: ldd ,x++ (8) / std $0E84 (6) / rts (5)
  yield* wr16(m, 0x0e84, yield* rd16(m, x, 8), 6);
  m.charge(5);
}

// Copyright 2026 by Moshix
/**
 * Registration test for main CPU ROM gp2-3b.8c ($C000-$DFFF): every
 * routine the listing names in the range, every jump-table entry that
 * points into it, and every address other chips jump to must be in
 * MAIN_AT, under the listing's label in MAIN.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import '../../src/game/main/gp2_3b.js';
import { MAIN, MAIN_AT } from '../../src/game/main/routines.js';
import { mainWord } from '../../src/game/romdata.js';
import { ROOT } from '../../tools/romset.mjs';

const inChip = (a) => a >= 0xc000 && a <= 0xdfff;

test('gp2-3b: the task lists, attract_phases and tbl_C9C9', () => {
  const targets = new Set();
  // mode_task_lists $FEC0: 10 lists, each ending at task_end_frame or
  // task_next_mode (the last entry of mode 0).
  for (let mode = 0; mode < 10; mode += 1) {
    const list = mainWord(0xfec0 + mode * 2);
    for (let i = 0; i < 32; i += 1) {
      const t = mainWord(list + i * 2);
      if (inChip(t)) targets.add(t);
      if (t === 0xd150 || t === 0xd15b) break;
    }
  }
  for (let i = 0; i < 4; i += 1) {
    targets.add(mainWord(0xc45f + i * 2)); // attract_phases
    targets.add(mainWord(0xc9c9 + i * 2)); // tbl_C9C9
  }
  for (const t of targets) {
    assert.equal(typeof MAIN_AT[t], 'function',
      `$${t.toString(16)} registered`);
  }
});

test('gp2-3b: entries jumped to from other chips and within', () => {
  // $E3F8, $F8D2, $FC7D/$FC9F, $B301, $B2F6 (other chips); $DB8E
  // (death -> start_game_1p), $E1DB (reset -> game_init), $C0A8 etc.
  for (const a of [0xd029, 0xd9cf, 0xda87, 0xdbe2, 0xdc0b, 0xcda1,
    0xc296, 0xc417, 0xccd0, 0xcdff, 0xc000]) {
    assert.equal(typeof MAIN_AT[a], 'function', `$${a.toString(16)}`);
  }
});

test('gp2-3b: every named routine of the listing, by its label', () => {
  const sym = JSON.parse(readFileSync(join(ROOT, 'reference/symbols.json'),
    'utf8')).main;
  const text = readFileSync(join(ROOT, 'reference/gaplus-main.asm'),
    'utf8');
  // Routine headers: "; name  ($XXXX)" in the chip's range, with
  // " ; JS: jsName" when the listing label was renamed after porting.
  const re = /^; ([A-Za-z_][A-Za-z0-9_]*) {2}\(\$([0-9A-F]{4})\)(?: ; JS: ([A-Za-z_][A-Za-z0-9_]*))?$/gm;
  for (const mm of text.matchAll(re)) {
    const addr = parseInt(mm[2], 16);
    if (!inChip(addr)) continue;
    const js = mm[3] ?? mm[1];
    assert.equal(sym[mm[1]], addr);
    assert.equal(MAIN[js], MAIN_AT[addr], `${js} ($${mm[2]})`);
    assert.equal(typeof MAIN_AT[addr], 'function', `${js}`);
  }
});

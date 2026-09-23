// Copyright 2026 by Moshix
/**
 * Every path stream of gp2-7, stepped by the real ROM stepper.
 *
 * Gameplay reaches only part of the 46 streams (sub-gp2_7-trace.test.mjs),
 * so here one object is walked through each stream by calling gp2-8's
 * `sub_B0D4` ($B0D4) on the oracle's sub CPU, once per path byte, and
 * after every call the object's state is compared with what the format of
 * src/game/sub/gp2_7_paths.js predicts: the path pointer, the heading
 * table entry the object took, the saved heading and flags of a jump, the
 * slot flag of an end. The per-object pointers in the direct page are
 * aimed at scratch RAM, which is filled with seeded random bytes so each
 * stream runs from a different state.
 *
 * sub_B0D4 is sub-A's routine; this test uses only the ROM's copy of it,
 * as a reference reader of this chip's data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOracle, callRoutine, fillRandom } from '../helpers/oracle.mjs';
import {
  HEADING_TABLE, decodeStream, gp2_7Streams,
} from '../../src/game/sub/gp2_7.js';
import { subRom } from '../../src/game/romdata.js';

/** @param {number} v @returns {string} */
const hex = (v) => `$${v.toString(16).toUpperCase().padStart(4, '0')}`;

// Where the direct-page pointers of the current object are aimed (see the
// B014 set-up at $B03E-$B091). Only the path pointer is a fixed slot.
const PATH = 0x1800;   // [$108C] -> the object's path pointer (word)
const FLAG = 0x1860;   // formation_ptr - 1: the object's slot flag byte
const TIMER = 0x1a30;  // [$1090] step counter
const SPEED = 0x1a70;  // [$10AD]
const HELD = 0x1a32;   // [$1092] heading saved by a jump
const SPRITE = 0x1a72; // [$10CB] byte 3 of the heading's table entry
const XHI = 0x1a66;    // [$10A6] (bit 0 cleared by FE)
const XLO = 0x1a62;    // [$10A2] (cleared by FE)

/**
 * Aim every pointer B0D4/B163/B20D use into scratch RAM.
 * @param {import('../m6809/board.mjs').Board} b
 * @param {number} slot formation_ptr value (FLAG + 1 normally)
 */
function setPointers(b, slot) {
  /** @type {Array<[number, number]>} [direct-page cell, target] */
  const ptrs = [
    [0x1084, 0x1a74], [0x1086, slot], [0x1088, 0x1a10], [0x108a, 0x1a11],
    [0x108c, PATH], [0x108e, 0x1a20], [0x1090, TIMER], [0x1092, HELD],
    [0x1094, 0x1a40], [0x1099, 0x1a50], [0x10a0, 0x1a60], [0x10a2, XLO],
    [0x10a4, 0x1a64], [0x10a6, XHI], [0x10ad, SPEED], [0x10cb, SPRITE],
  ];
  for (const [at, v] of ptrs) {
    b.mem[at] = v >> 8;
    b.mem[at + 1] = v & 0xff;
  }
}

/**
 * Walk one stream from its start to its command byte.
 * @param {import('../m6809/board.mjs').Board} b
 * @param {number} start
 * @param {number} seed
 */
function walk(b, start, seed) {
  const s = decodeStream(start);
  fillRandom(b, seed, [[0x1a00, 0x1b00], [0x1098, 0x1099],
    [0x109c, 0x10a0]]);
  setPointers(b, FLAG + 1);
  let p = start;
  for (;;) {
    // Force an advance on this call: B0D4 compares [$1090] with [$10AD]
    // ($B0D8: cmpa / bcs $B0FB); 0 < 1 takes the advance path, which
    // reloads [$1090] with $28 and reads the next path byte ($B121).
    b.mem[TIMER] = 0;
    b.mem[SPEED] = 1;
    b.mem[FLAG] = 0;
    b.mem[PATH] = p >> 8;
    b.mem[PATH + 1] = p & 0xff;
    const xhi = b.mem[XHI];
    callRoutine(b, 'sub', 0xb0d4);
    const ptr = (b.mem[PATH] << 8) | b.mem[PATH + 1];
    const at = `stream ${hex(start)} at ${hex(p + 1)}`;
    if (p + 1 < s.cmd) {
      // A heading: the pointer moved onto it and B20D stored byte 3 of
      // its dat_AAFF entry ($B217: lda 3,x / sta [$10CB]).
      const h = subRom(p + 1);
      assert.equal(ptr, p + 1, at);
      assert.equal(b.mem[SPRITE], subRom(HEADING_TABLE + 4 * h + 3), at);
      assert.equal(b.mem[FLAG], 0, at);
      p += 1;
      continue;
    }
    if (s.op === 'end') {
      // $B155: the pointer rests on the F0; the slot flag becomes 1.
      assert.equal(ptr, s.cmd, at);
      assert.equal(b.mem[FLAG], 1, at);
    } else {
      // $B13D-$B14F: last heading saved, pointer = target, flag bit 5.
      assert.equal(ptr, s.word, at);
      assert.equal(b.mem[HELD], subRom(s.cmd - 1), at);
      assert.equal(b.mem[FLAG], 0x20, at);
      if (s.op === 'jumpClear') {
        assert.equal(b.mem[XHI], xhi & 0xfe, at);
        assert.equal(b.mem[XLO], 0, at);
      } else {
        assert.equal(b.mem[XHI], xhi, at);
      }
    }
    return s;
  }
}

test('the ROM stepper walks every stream as decoded', () => {
  const b = makeOracle();
  let steps = 0;
  gp2_7Streams().forEach((s, i) => {
    const out = walk(b, s.start, 1000 + i);
    steps += out.headings.length;
  });
  // gp2-8's stream at $A44B, the one target outside this chip.
  steps += walk(b, 0xa44b, 77).headings.length;
  assert.ok(steps > 7000, `${steps} steps`);
});

test('an end in the last slot marks both flag bytes ($B159)', () => {
  const b = makeOracle();
  // $B157: ldx formation_ptr / cmpx #$188B / bne -- slot $188B also
  // sets ,X, i.e. $188B as well as $188A.
  const s = gp2_7Streams().find((x) => x.op === 'end');
  assert.ok(s);
  b.mem[0x188b] = 0;
  fillRandom(b, 5, [[0x1a00, 0x1b00]]);
  setPointers(b, 0x188b);
  b.mem[TIMER] = 0;
  b.mem[SPEED] = 1;
  b.mem[0x188a] = 0;
  const p = s.cmd - 1;
  b.mem[PATH] = p >> 8;
  b.mem[PATH + 1] = p & 0xff;
  callRoutine(b, 'sub', 0xb0d4);
  assert.equal(b.mem[0x188a], 1);
  assert.equal(b.mem[0x188b], 1);
});

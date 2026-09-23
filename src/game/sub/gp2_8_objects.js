// Copyright 2026 by Moshix
/**
 * gp2-8.11d, sub CPU: the four "objects" (sprites $0EE2, $0EEC, $0EF6,
 * $0F00, five sprite entries each) with their state bytes $111D-$1120,
 * run by task_animate_objects through the state table object_states
 * ($BB22), and their launcher task $BB50.
 *
 * States (the byte at Y): 0 idle, 1 spawn at a noise position, 2-9 set
 * a picture and advance, 10 wait / blink, 11 pick a side, 12/13 move
 * diagonally towards the player's row, 14 explode (fragments fly apart).
 * State handlers take U = the object's sprite entry and Y = its state
 * byte (X = object_states on entry, which none of them reads).
 *
 * TIMING as in gp2_8_formation.js: cycles charged per instruction,
 * SYNC before every shared-RAM access (U and Y are pointers, so their
 * accesses SYNC through syncAt).
 */

import { disp8 } from '../m6809ops.js';
import { subRom } from '../romdata.js';
import { call } from '../call.js';
import { inc, dec, SYNC, syncAt } from './gp2_8_util.js';
import { endTask } from './gp2_8_formation.js';
import { subAt } from './routines.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {import('../../machine/machine.js').CpuView} CpuView */
/** @typedef {Generator<unknown, void, unknown>} Thread */
/** @typedef {{ u: number, y: number }} ObjRegs */

/**
 * Returned by a state handler that left through `jmp task_dispatch_sub`
 * (state $80 -> handler 0 = $B92B): the 6809 abandons the object loop
 * (its PSHS U and return address stay on the stack) with sub_task
 * already incremented.
 */
export const TO_DISPATCH = Symbol('sub jmp task_dispatch_sub');

/**
 * Object task (mode 5): for each of the four objects with a non-zero
 * state byte, run its state handler (object_state_call) with U = its
 * sprite entry (object_sprites, ROM) and Y = the state byte; then end
 * the task (falls into $B92B).
 * @see gaplus-sub.asm $B90E
 * @param {Machine} m
 * @returns {Thread}
 */
export function* task_animate_objects(m) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // ldy #$111D (4) / ldu #object_sprites (3)
  c(4 + 3);
  let u = 0xbb1a;
  for (let y = 0x111d; y !== 0x1121; y += 1) {
    // $B915: lda ,y (4) / beq (3)
    yield SYNC;
    const a = s.peek(y);
    c(4 + 3);
    if (a !== 0) {
      // pshs u (7) / ldu ,u (5, ROM) / bsr object_state_call (7)
      yield* syncAt(u, u + 1);
      const obj = s.peek16(u);
      c(7 + 5 + 7);
      const r = yield* object_state_call(m, { a, u: obj, y });
      if (r === TO_DISPATCH) return;
      c(7); // puls u
    }
    // leay 1,y / leau 2,u (5 + 5) / cmpy #$1121 (5) / bne (3)
    u += 2;
    c(5 + 5 + 5 + 3);
  }
  yield* sub_B92B(m);
}

/**
 * `inc <sub_task / jmp task_dispatch_sub`: the tail of
 * task_animate_objects, and state 0 of object_states (reached only by
 * a state byte of $80, since `asla` drops bit 7 -- then it leaves the
 * object loop, see TO_DISPATCH).
 * @see gaplus-sub.asm $B92B
 * @param {Machine} m
 * @returns {Generator<unknown, symbol, unknown>} TO_DISPATCH
 */
export function* sub_B92B(m) {
  yield* endTask(m);
  return TO_DISPATCH;
}

/**
 * Jump to object_states[A]: `asla (2) / ldx #object_states (3) /
 * jmp [a,x] (7)` (8-bit shift, signed offset).
 * @see gaplus-sub.asm $B930
 * @param {Machine} m
 * @param {{ a: number, u: number, y: number }} regs
 * @returns {Generator<unknown, unknown, unknown>} TO_DISPATCH when the
 *   handler left the loop
 */
export function* object_state_call(m, { a, u, y }) {
  const p = disp8(0xbb22, (a << 1) & 0xff);
  yield* syncAt(p, p + 1);
  const target = m.sub.peek16(p);
  m.sub.charge(2); m.sub.charge(3); m.sub.charge(7);
  return yield* call(subAt(target), m, { u, y });
}

/**
 * State 1: place the object at a pseudo-random position. There is no
 * RNG: Y comes from the sub's own code used as a noise table. ROM quirk:
 * `lda a,x` with X = $E000 and A = frame_counter takes A as a SIGNED
 * offset, so frame_counter $00-$7F reads $E000-$E07F (reset_sub, code)
 * and $80-$FF reads $DF80-$DFFF (the $FF fill at the end of gp2-7, and
 * its checksum byte $B7 at $DFEF). The byte is clamped: below $20 ->
 * $90, $D0 and up -> $60. X := frame_counter | $B0, picture $4806,
 * flags $6880, state + 1, $084F := 1.
 *
 * The read goes through romdata.js (subRom) on purpose: it is code read
 * as data, so $E000-$E07F must stay readable when romdata's code/data
 * mask is switched on (docs/requests/sub-A.md).
 * @see gaplus-sub.asm $B936
 * @param {Machine} m
 * @param {ObjRegs} regs
 * @returns {Thread}
 */
export function* object_spawn_random(m, { u, y }) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // ldx #$E000 (3) / lda <frame_counter (4)
  c(3);
  yield SYNC;
  const fc = s.peek(0x1016);
  c(4);
  // lda a,x (5) -- signed offset; cmpa #$20 / bcc (2 + 3)
  let a = subRom(disp8(0xe000, fc));
  c(5 + 2 + 3);
  if (a < 0x20) {
    a = 0x90;
    c(2 + 3); // lda #$90 / bra
  } else {
    c(2 + 3); // cmpa #$D0 / bcs
    if (a >= 0xd0) { a = 0x60; c(2); }
  }
  // $B94B: sta $0800,u (8) / lda <frame_counter (4) / ora #$B0 (2) /
  // sta $0801,u (8)
  yield* syncAt(u + 0x0800);
  s.poke((u + 0x0800) & 0xffff, a);
  c(8);
  yield SYNC;
  a = s.peek(0x1016) | 0xb0;
  c(4 + 2);
  yield* syncAt(u + 0x0801);
  s.poke((u + 0x0801) & 0xffff, a);
  c(8);
  // ldd #$4806 (3) / std ,u (5) / ldd #$6880 (3) / std $1000,u (9)
  c(3);
  yield* syncAt(u, u + 1);
  s.poke16(u, 0x4806);
  c(5 + 3);
  yield* syncAt(u + 0x1000, u + 0x1001);
  s.poke16((u + 0x1000) & 0xffff, 0x6880);
  c(9);
  // inc ,y (6) / lda #1 (2) / sta $084F (5) / rts (5)
  yield* syncAt(y);
  inc(s, y);
  c(6 + 2);
  yield SYNC;
  s.poke(0x084f, 1);
  c(5 + 5);
}

/**
 * States 2-4 and 6-9: `ldd #word (3) / std ,u (5) / inc ,y (6) /
 * rts (5)`.
 * @param {number} word code/colour
 * @returns {(m: Machine, regs: ObjRegs) => Thread}
 */
function setPicture(word) {
  return function* picture(m, { u, y }) {
    const s = m.sub;
    s.charge(3);
    yield* syncAt(u, u + 1);
    s.poke16(u, word);
    s.charge(5);
    yield* syncAt(y);
    inc(s, y);
    s.charge(6); s.charge(5);
  };
}

/**
 * State 2: picture $4C07, next state.
 * @see gaplus-sub.asm $B96B
 * @type {(m: Machine, regs: ObjRegs) => Thread}
 */
export const sub_B96B = setPicture(0x4c07);
/**
 * State 3: picture $4C06, next state.
 * @see gaplus-sub.asm $B973
 * @type {(m: Machine, regs: ObjRegs) => Thread}
 */
export const sub_B973 = setPicture(0x4c06);
/**
 * State 4: picture $4807, next state.
 * @see gaplus-sub.asm $B97B
 * @type {(m: Machine, regs: ObjRegs) => Thread}
 */
export const sub_B97B = setPicture(0x4807);
/**
 * State 6: picture $5506, next state.
 * @see gaplus-sub.asm $B99D
 * @type {(m: Machine, regs: ObjRegs) => Thread}
 */
export const sub_B99D = setPicture(0x5506);
/**
 * State 7: picture $5606, next state.
 * @see gaplus-sub.asm $B9A5
 * @type {(m: Machine, regs: ObjRegs) => Thread}
 */
export const sub_B9A5 = setPicture(0x5606);
/**
 * State 8: picture $5706, next state.
 * @see gaplus-sub.asm $B9AD
 * @type {(m: Machine, regs: ObjRegs) => Thread}
 */
export const sub_B9AD = setPicture(0x5706);
/**
 * State 9: picture $500A, next state.
 * @see gaplus-sub.asm $B9B5
 * @type {(m: Machine, regs: ObjRegs) => Thread}
 */
export const sub_B9B5 = setPicture(0x500a);

/**
 * State 5: picture $5406, position + ($08, $08) (one 16-bit add over Y
 * and X: X's carry goes into Y, Y's is lost), flags $4080, next state.
 * @see gaplus-sub.asm $B983
 * @param {Machine} m
 * @param {ObjRegs} regs
 * @returns {Thread}
 */
export function* sub_B983(m, { u, y }) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // ldd #$5406 (3) / std ,u (5)
  c(3);
  yield* syncAt(u, u + 1);
  s.poke16(u, 0x5406);
  c(5);
  // ldd $0800,u (9) / addd #$0808 (4) / std $0800,u (9)
  const p = (u + 0x0800) & 0xffff;
  yield* syncAt(p, p + 1);
  const d = (s.peek16(p) + 0x0808) & 0xffff;
  c(9 + 4);
  yield* syncAt(p, p + 1);
  s.poke16(p, d);
  c(9);
  // ldd #$4080 (3) / std $1000,u (9) / inc ,y (6) / rts (5)
  c(3);
  yield* syncAt(u + 0x1000, u + 0x1001);
  s.poke16((u + 0x1000) & 0xffff, 0x4080);
  c(9);
  yield* syncAt(y);
  inc(s, y);
  c(6 + 5);
}

/**
 * State 10: blink ($B9C5 part, shared with $BA3E), next state every
 * 64th frame.
 * @see gaplus-sub.asm $B9BD
 * @param {Machine} m
 * @param {ObjRegs} regs
 * @returns {Thread}
 */
export function* sub_B9BD(m, { u, y }) {
  const s = m.sub;
  // lda <frame_counter (4) / anda #$3F / bne (2 + 3) [inc ,y (6)]
  yield SYNC;
  const t = s.peek(0x1016) & 0x3f;
  s.charge(4); s.charge(2); s.charge(3);
  if (t === 0) {
    yield* syncAt(y);
    inc(s, y);
    s.charge(6);
  }
  yield* blinkB9C5(s, u, y);
}

/**
 * $B9C5: picture from dat_BB40[frame_counter & 3]; if the object's
 * flag byte (U + $1001) lacks b7 it gets $80 and the object explodes
 * ($BA52). Ends in the RTS (or $BA52's).
 * @param {CpuView} s @param {number} u @param {number} y
 * @returns {Thread}
 */
function* blinkB9C5(s, u, y) {
  // lda <frame_counter (4) / anda #3 / asla (2 + 2) / ldx #dat_BB40 (3) /
  // ldd a,x (6, ROM) / std ,u (5)
  yield SYNC;
  const i = (s.peek(0x1016) & 0x03) << 1;
  s.charge(4); s.charge(2); s.charge(2); s.charge(3); s.charge(6);
  yield* syncAt(u, u + 1);
  s.poke16(u, s.peek16(0xbb40 + i));
  s.charge(5);
  // lda $1001,u (8) / anda #$80 / bne (2 + 3)
  const f = (u + 0x1001) & 0xffff;
  yield* syncAt(f);
  const set = (s.peek(f) & 0x80) !== 0;
  s.charge(8); s.charge(2); s.charge(3);
  if (set) { s.charge(5); return; }
  // ldb #$80 (2) / stb $1001,u (8) / bra lBA52 (3)
  s.charge(2);
  yield* syncAt(f);
  s.poke(f, 0x80);
  s.charge(8); s.charge(3);
  yield* explodeBA52(s, u, y);
}

/**
 * State 11: next state 12 if the object is above the player's row
 * (Y < player_y), else 13.
 * @see gaplus-sub.asm $B9E2
 * @param {Machine} m
 * @param {ObjRegs} regs
 * @returns {Thread}
 */
export function* sub_B9E2(m, { u, y }) {
  const s = m.sub;
  // lda $0800,u (8) / cmpa player_y (5) / bcs (3) [inc ,y (6)] /
  // inc ,y (6) / rts (5)
  yield* syncAt(u + 0x0800);
  const a = s.peek((u + 0x0800) & 0xffff);
  s.charge(8);
  yield SYNC;
  const below = a >= s.peek(0x1600);
  s.charge(5); s.charge(3);
  if (below) {
    yield* syncAt(y);
    inc(s, y);
    s.charge(6);
  }
  yield* syncAt(y);
  inc(s, y);
  s.charge(6); s.charge(5);
}

/**
 * State 12: two steps down towards player_y (it explodes on reaching
 * it), X + 3; past X bit 8 the flag byte counts up and it explodes;
 * else $BA3E.
 * @see gaplus-sub.asm $B9F0
 * @param {Machine} m
 * @param {ObjRegs} regs
 * @returns {Thread}
 */
export function* sub_B9F0(m, { u, y }) {
  yield* moveDiagonal(m.sub, u, y, 1, 3);
}

/**
 * State 13: as state 12 but moving up (Y - 1 twice) and X + 2.
 * @see gaplus-sub.asm $BA18
 * @param {Machine} m
 * @param {ObjRegs} regs
 * @returns {Thread}
 */
export function* sub_BA18(m, { u, y }) {
  yield* moveDiagonal(m.sub, u, y, -1, 2);
}

/**
 * The shared body of states 12 and 13 ($B9F0 / $BA18).
 * @param {CpuView} s @param {number} u @param {number} y
 * @param {number} dy +1 (`adda #1`) or -1 (`suba #1`)
 * @param {number} dx 3 or 2
 * @returns {Thread}
 */
function* moveDiagonal(s, u, y, dy, dx) {
  const py = (u + 0x0800) & 0xffff;
  // ldb #2 (2) / lda $0800,u (8)
  s.charge(2);
  yield* syncAt(py);
  let a = s.peek(py);
  s.charge(8);
  // $B9F6: cmpa player_y (5) / beq (3) / adda|suba #1 / decb / bne
  // (2 + 2 + 3), twice
  for (let b = 2; b !== 0; b -= 1) {
    yield SYNC;
    const hit = a === s.peek(0x1600);
    s.charge(5); s.charge(3);
    if (hit) {
      yield* explodeBA52(s, u, y);
      return;
    }
    a = (a + dy) & 0xff;
    s.charge(2); s.charge(2); s.charge(3);
  }
  // sta $0800,u (8) / lda $0801,u (8) / adda #n (2) / sta $0801,u (8) /
  // bcc (3)
  yield* syncAt(py);
  s.poke(py, a);
  s.charge(8);
  const px = (u + 0x0801) & 0xffff;
  yield* syncAt(px);
  const x = s.peek(px) + dx;
  s.charge(8); s.charge(2);
  yield* syncAt(px);
  s.poke(px, x & 0xff);
  s.charge(8); s.charge(3);
  if (x > 0xff) {
    // inc $1001,u (10) / bra lBA52 (3)
    yield* syncAt(u + 0x1001);
    inc(s, (u + 0x1001) & 0xffff);
    s.charge(10); s.charge(3);
    yield* explodeBA52(s, u, y);
    return;
  }
  // $B9F0's bcc goes to lBA16: bra lBA3E (3); $BA18's straight there
  if (dy > 0) s.charge(3);
  // $BA3E: ldb $1001,u (8) / lda $0801,u (8) / lsrb / rora /
  // suba #$50 / bcc (2 + 2 + 2 + 3) / jmp (4): 9-bit X / 2 below $50
  // -> gone ($BB03), else blink ($B9C5)
  yield* syncAt(u + 0x1001);
  const b = s.peek((u + 0x1001) & 0xffff);
  s.charge(8);
  yield* syncAt(px);
  const x9 = (s.peek(px) >> 1) | ((b & 1) << 7);
  s.charge(8); s.charge(2); s.charge(2); s.charge(2); s.charge(3); s.charge(4);
  if (x9 < 0x50) yield* clearBB03(s, u, y);
  else yield* blinkB9C5(s, u, y);
}

/**
 * $BA52: explode -- copy the flags and position into the four fragment
 * entries (U+2..U+9), fragments' picture $530A, the object's flag byte
 * := 0, state := $0E. Ends in the RTS.
 * @param {CpuView} s @param {number} u @param {number} y
 * @returns {Thread}
 */
function* explodeBA52(s, u, y) {
  for (const bank of [0x1000, 0x0800]) {
    // ldd bank,u (9) / std bank+2 .. bank+8,u (9 each)
    const src = (u + bank) & 0xffff;
    yield* syncAt(src, src + 1);
    const d = s.peek16(src);
    s.charge(9);
    for (let k = 2; k <= 8; k += 2) {
      const p = (u + bank + k) & 0xffff;
      yield* syncAt(p, p + 1);
      s.poke16(p, d);
      s.charge(9);
    }
  }
  // ldd #$530A (3) / std 2,u .. 8,u (6 each)
  s.charge(3);
  for (let k = 2; k <= 8; k += 2) {
    const p = (u + k) & 0xffff;
    yield* syncAt(p, p + 1);
    s.poke16(p, 0x530a);
    s.charge(6);
  }
  // clr $1001,u (10) / lda #$0E (2) / sta ,y (4) / rts (5)
  const f = (u + 0x1001) & 0xffff;
  yield* syncAt(f);
  s.peek(f);
  s.poke(f, 0);
  s.charge(10); s.charge(2);
  yield* syncAt(y);
  s.poke(y, 0x0e);
  s.charge(4); s.charge(5);
}

/**
 * $BB03: the object is gone: clear the flag bytes of it and its
 * fragments (10 each) and its state (6). Ends in the RTS.
 * @param {CpuView} s @param {number} u @param {number} y
 * @returns {Thread}
 */
function* clearBB03(s, u, y) {
  for (let k = 1; k <= 9; k += 2) {
    const p = (u + 0x1000 + k) & 0xffff;
    yield* syncAt(p);
    s.poke(p, 0);
    s.charge(10);
  }
  yield* syncAt(y);
  s.poke(y, 0);
  s.charge(6); s.charge(5);
}

/**
 * State 14: the four fragments fly apart (Y - 2, - 1, + 1, + 2; X + 3
 * with the carry into their flag bytes), picture dat_BB48[frame & 3];
 * when the first fragment's 9-bit X / 2 leaves $50-$B7 the object is
 * cleared ($BB03).
 * @see gaplus-sub.asm $BA8E
 * @param {Machine} m
 * @param {ObjRegs} regs
 * @returns {Thread}
 */
export function* sub_BA8E(m, { u, y }) {
  const s = m.sub;
  // ldx #dat_BB48 (3) / lda <frame_counter (4) / anda #3 / asla (4) /
  // ldd a,x (6, ROM) / std 2,u .. 8,u (6 each)
  s.charge(3);
  yield SYNC;
  const d = s.peek16(0xbb48 + ((s.peek(0x1016) & 0x03) << 1));
  s.charge(4); s.charge(4); s.charge(6);
  for (let k = 2; k <= 8; k += 2) {
    const p = (u + k) & 0xffff;
    yield* syncAt(p, p + 1);
    s.poke16(p, d);
    s.charge(6);
  }
  // $BAA0: lda / adda #$FE, #$FF, #$01, #$02 / sta on the four Y bytes
  // (8 + 2 + 8 each)
  const dys = [0xfe, 0xff, 0x01, 0x02];
  for (let i = 0; i < 4; i += 1) {
    const p = (u + 0x0802 + 2 * i) & 0xffff;
    yield* syncAt(p);
    const v = (s.peek(p) + dys[i]) & 0xff;
    s.charge(8); s.charge(2);
    yield* syncAt(p);
    s.poke(p, v);
    s.charge(8);
  }
  // $BAC8: lda $0803,u (8) / adda #3 (2) / sta $0803,5,7,9,u (8 each) /
  // bcc (3) [inc $1003,5,7,9,u (10 each)]
  const p3 = (u + 0x0803) & 0xffff;
  yield* syncAt(p3);
  const x = s.peek(p3) + 3;
  s.charge(8); s.charge(2);
  for (let k = 3; k <= 9; k += 2) {
    const p = (u + 0x0800 + k) & 0xffff;
    yield* syncAt(p);
    s.poke(p, x & 0xff);
    s.charge(8);
  }
  s.charge(3);
  if (x > 0xff) {
    for (let k = 3; k <= 9; k += 2) {
      const p = (u + 0x1000 + k) & 0xffff;
      yield* syncAt(p);
      inc(s, p);
      s.charge(10);
    }
  }
  // $BAF0: ldb $1003,u (8) / lda $0803,u (8) / lsrb / rora /
  // suba #$50 / bcs (2 + 2 + 2 + 3) / suba #$68 / bcc (2 + 3) / rts (5)
  const f3 = (u + 0x1003) & 0xffff;
  yield* syncAt(f3);
  const b = s.peek(f3);
  s.charge(8);
  yield* syncAt(p3);
  const x9 = (s.peek(p3) >> 1) | ((b & 1) << 7);
  s.charge(8); s.charge(2); s.charge(2); s.charge(2); s.charge(3);
  if (x9 < 0x50) { yield* clearBB03(s, u, y); return; }
  s.charge(2); s.charge(3);
  if (x9 - 0x50 >= 0x68) { yield* clearBB03(s, u, y); return; }
  s.charge(5);
}

/**
 * Object launcher task (mode 5). While $1122 is set: when $1119 = $111A
 * (all launched) $1123 counts up once it is non-zero; else every $2D
 * frames ($111B counts down) $1123 := 1 and the object
 * dat_BB8E[$111A & 3] is started (state 1) if idle, then $111A + 1.
 * @see gaplus-sub.asm $BB50
 * @param {Machine} m
 * @returns {Thread}
 */
export function* sub_BB50(m) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // lda $1122 (5) / beq (3)
  yield SYNC;
  const on = s.peek(0x1122) !== 0;
  c(5 + 3);
  if (on) {
    // lda $1119 (5) / cmpa $111A (5) / beq (3)
    yield SYNC;
    const a = s.peek(0x1119);
    c(5);
    yield SYNC;
    const all = a === s.peek(0x111a);
    c(5 + 3);
    if (all) {
      // $BB84: lda $1123 (5) / beq (3) / inc $1123 (7) / bra (3)
      yield SYNC;
      const t = s.peek(0x1123);
      c(5 + 3);
      if (t !== 0) {
        yield SYNC;
        inc(s, 0x1123);
        c(7 + 3);
      }
    } else {
      // dec $111B (7) / bne (3)
      yield SYNC;
      const t = dec(s, 0x111b);
      c(7 + 3);
      if (t === 0) {
        // lda #1 (2) / sta $1123 (5) / lda #$2D (2) / sta $111B (5)
        c(2);
        yield SYNC;
        s.poke(0x1123, 1);
        c(5 + 2);
        yield SYNC;
        s.poke(0x111b, 0x2d);
        c(5);
        // ldx #dat_BB8E (3) / lda $111A (5) / anda #3 / asla (4) /
        // ldb [a,x] (8) / bne (3) -- the state byte's address from ROM
        c(3);
        yield SYNC;
        const i = (s.peek(0x111a) & 0x03) << 1;
        c(5 + 4);
        const p = s.peek16(0xbb8e + i);
        yield* syncAt(p);
        const b = s.peek(p);
        c(8 + 3);
        if (b === 0) {
          // incb (2) / stb [a,x] (8) / inc $111A (7)
          c(2);
          yield* syncAt(p);
          s.poke(p, 1);
          c(8);
          yield SYNC;
          inc(s, 0x111a);
          c(7);
        }
      }
    }
  }
  yield* endTask(m);
}

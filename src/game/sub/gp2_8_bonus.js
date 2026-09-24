// Copyright 2026 by Moshix
/**
 * gp2-8.11d, sub CPU: the challenging-stage (mode 7) tasks: the stage
 * sequencer $BB96, the five bonus objects $BCF3 (state bytes
 * $1132-$1136, handlers tbl_BEDD: $BD20 launch, $BD56 fly, $BE4F hold,
 * $BE6C done) and the colour cycler $BEE5.
 *
 * Bonus object k (0-4): state $1132+k, "free" flag $113A+k, sprite
 * entry U = $0E30+2k (+$800 position, +$1000 flags), counters at
 * U+$31A / U+$31B ($114A+2k / $114B+2k), path pointer U+$9D0
 * ($1800+2k), speed X+$8A6 ($19E0+k), status X+$726 ($1860+k: the
 * formation flag of slot k).
 *
 * TIMING as in gp2_8_formation.js: cycles charged per instruction,
 * SYNC before every shared-RAM access.
 */

import { add8, daa, disp8 } from '../m6809ops.js';
import { call } from '../call.js';
import { inc, dec, SYNC, syncAt, CWAI_CYCLES } from './gp2_8_util.js';
import { endTask } from './gp2_8_formation.js';
import { subAt } from './routines.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {import('../../machine/machine.js').CpuView} CpuView */
/** @typedef {Generator<unknown, void, unknown>} Thread */
/** @typedef {{ x: number, u: number }} BonusRegs */

/**
 * Challenging-stage sequencer (mode 7), stepped by $115A:
 *   0      set up: $115F := 1, $113A-$113E := 1, sprite $0F1E/$171E/
 *          $1F1E (position from dat_BCA4[stage & 7]);
 *   1-$16  $0F1E := word dat_F0C1[$115A - 1] (if 0, also $1F1F := 0);
 *   $17    pick the wave size $115C from the stage's list (dat_BCB4 /
 *          dat_BCC0) and wave $115B;
 *   $18    every 8th frame ($115D) release one more bonus object
 *          (INC of its state byte through dat_BCE7), $115C times;
 *   $19    once all five are free again: clear the objects; after the
 *          third wave wait for the next frame (`cwai`) and end the
 *          stage (game_mode + 1, both task indexes 0), else next wave.
 * Values 1-$16 and the rest are told apart by 2 * $115A (8-bit `asla`).
 * @see gaplus-sub.asm $BB96
 * @param {Machine} m
 * @returns {Thread}
 */
export function* sub_BB96(m) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // lda $115A (5) / beq (3)
  yield SYNC;
  let a = s.peek(0x115a);
  c(5); c(3);
  if (a === 0) {
    // $BBAC: lda #1 (2) / sta $115F (5) / lda #1 (2) /
    // sta $113A-$113E (5 each)
    c(2);
    yield SYNC;
    s.poke(0x115f, 1);
    c(5); c(2);
    for (let x = 0x113a; x <= 0x113e; x += 1) {
      yield SYNC;
      s.poke(x, 1);
      c(5);
    }
    // lda <stage (4) / anda #7 / asla (4) / ldx #dat_BCA4 (3) /
    // ldd a,x (6) / std $171E (6)
    yield SYNC;
    const i = (s.peek(0x1035) & 0x07) << 1;
    c(4); c(4); c(3); c(6);
    yield SYNC;
    s.poke16(0x171e, s.peek16(0xbca4 + i));
    c(6);
    // ldd #$4080 (3) / std $1F1E (6) / ldd #$4010 (3)
    c(3);
    yield SYNC;
    s.poke16(0x1f1e, 0x4080);
    c(6); c(3);
    yield* setSprite(s, 0x4010);
    c(4); // jmp lBC35
    yield* endTask(m);
    return;
  }
  // asla (2) / cmpa #$2E / beq (2 + 3) / cmpa #$30 / beq (2 + 3) /
  // cmpa #$32 / lbeq (2 + 6|5) / bra lBBE1 (3)
  a = (a << 1) & 0xff;
  c(2); c(2); c(3);
  if (a === 0x2e) {
    // $BBEF: ldx #dat_BCB4 (3) / clrb (2) / lda <stage (4); then
    // cmpa ,x+ (6) / beq (3) [incb (2) / bra (3)] -- no end marker: the
    // search runs on through memory until some byte matches
    c(3); c(2);
    yield SYNC;
    const st = s.peek(0x1035);
    c(4);
    let x = 0xbcb4;
    let b = 0;
    for (;;) {
      yield* syncAt(x);
      const v = s.peek(x);
      x = (x + 1) & 0xffff;
      c(6); c(3);
      if (v === st) break;
      b = (b + 1) & 0xff;
      c(2); c(3);
    }
    // $BBFC: ldx #dat_BCC0 (3) / aslb (2) / ldx b,x (6)
    const p = disp8(0xbcc0, (b << 1) & 0xff);
    c(3); c(2);
    yield* syncAt(p, p + 1);
    x = s.peek16(p);
    c(6);
    // lda $115B (5) / inc $115B (7) / lda a,x (5) / sta $115C (5)
    yield SYNC;
    const w = s.peek(0x115b);
    c(5);
    yield SYNC;
    inc(s, 0x115b);
    c(7);
    const q = disp8(x, w); // signed
    yield* syncAt(q);
    const n = s.peek(q);
    c(5);
    yield SYNC;
    s.poke(0x115c, n);
    c(5);
    // inc $115A (7) / jmp lBC35 (4)
    yield SYNC;
    inc(s, 0x115a);
    c(7); c(4);
    yield* endTask(m);
    return;
  }
  c(2); c(3);
  if (a === 0x30) {
    // $BC13: lda $115C (5) / beq (3)
    yield SYNC;
    const n = s.peek(0x115c);
    c(5); c(3);
    if (n !== 0) {
      // inc $115D (7) / lda $115D (5) / anda #7 / bne (2 + 3)
      yield SYNC;
      inc(s, 0x115d);
      c(7);
      yield SYNC;
      const t = s.peek(0x115d) & 0x07;
      c(5); c(2); c(3);
      if (t === 0) {
        // lda $115C (5) / asla (2) / ldx #dat_BCE7 (3) / inc [a,x] (10)
        yield SYNC;
        const i = (s.peek(0x115c) << 1) & 0xff;
        c(5); c(2); c(3);
        const pp = disp8(0xbce7, i);
        yield* syncAt(pp, pp + 1);
        const p = s.peek16(pp);
        // (the pointer is ROM; the byte it names is RAM)
        yield* syncAt(p);
        inc(s, p);
        c(10);
        // dec $115C (7) / bne (3) [inc $115A (7) / bra (3)]
        yield SYNC;
        const left = dec(s, 0x115c);
        c(7); c(3);
        if (left === 0) {
          yield SYNC;
          inc(s, 0x115a);
          c(7); c(3);
        }
      }
    }
    yield* endTask(m);
    return;
  }
  c(2);
  if (a === 0x32) {
    c(6);
    // $BC3A: lda $113A (5) / anda $113B .. $113E (5 each) / anda #1 /
    // beq (2 + 3)
    let all = 0xff;
    for (let x = 0x113a; x <= 0x113e; x += 1) {
      yield SYNC;
      all &= s.peek(x);
      c(5);
    }
    c(2); c(3);
    if ((all & 0x01) !== 0) {
      // clr $115A, $1132-$1136, $113A-$113E, $1142-$1146 (7 each)
      const list = [0x115a];
      for (let x = 0x1132; x <= 0x1136; x += 1) list.push(x);
      for (let x = 0x113a; x <= 0x113e; x += 1) list.push(x);
      for (let x = 0x1142; x <= 0x1146; x += 1) list.push(x);
      for (const x of list) {
        yield SYNC;
        s.poke(x, 0);
        c(7);
      }
      // lda $115B (5) / cmpa #3 / bne (2 + 3)
      yield SYNC;
      const w = s.peek(0x115b);
      c(5); c(2); c(3);
      if (w === 3) {
        // clr $115B / $115C / $115D (7 each)
        for (const x of [0x115b, 0x115c, 0x115d]) {
          yield SYNC;
          s.poke(x, 0);
          c(7);
        }
        // $BC8D: cwai #$EF -- wait for vblank
        c(CWAI_CYCLES);
        yield;
        // clr $1108 / clr $115F (7 each) / inc <game_mode (6) /
        // clr <main_task (6) / clr <sub_task (6) / jmp (4)
        for (const x of [0x1108, 0x115f]) {
          yield SYNC;
          s.poke(x, 0);
          c(7);
        }
        yield SYNC;
        inc(s, 0x102f);
        c(6);
        yield SYNC;
        s.poke(0x1030, 0);
        c(6);
        yield SYNC;
        s.poke(0x107a, 0);
        c(6); c(4);
        return;
      }
      // $BC9E: clr $115D (7) / jmp lBC35 (4)
      yield SYNC;
      s.poke(0x115d, 0);
      c(7); c(4);
    }
    yield* endTask(m);
    return;
  }
  // lbeq not taken (5) / bra lBBE1 (3)
  c(5); c(3);
  // $BBE1: ldx #dat_F0C1 (3) / suba #2 (2) / ldd a,x (6) / bne (3)
  const p = disp8(0xf0c1, (a - 2) & 0xff);
  c(3); c(2);
  yield* syncAt(p, p + 1);
  const d = s.peek16(p);
  c(6); c(3);
  if (d === 0) {
    // clr $1F1F (7) / bra (3)
    yield SYNC;
    s.poke(0x1f1f, 0);
    c(7); c(3);
  }
  yield* setSprite(s, d);
  c(4); // jmp lBC35
  yield* endTask(m);
}

/**
 * $BBD8: `std $0F1E (6) / inc $115A (7)` (the caller then ends the task).
 * @param {CpuView} s @param {number} d
 * @returns {Thread}
 */
function* setSprite(s, d) {
  yield SYNC;
  s.poke16(0x0f1e, d);
  s.charge(6);
  yield SYNC;
  inc(s, 0x115a);
  s.charge(7);
}

/**
 * Bonus object task (mode 7): run the handler of every bonus object
 * whose state byte ($1132-$1136) is non-zero, with X = its free flag
 * ($113A+k) and U = its sprite entry ($0E30+2k).
 * @see gaplus-sub.asm $BCF3
 * @param {Machine} m
 * @returns {Thread}
 */
export function* sub_BCF3(m) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // ldu #$0E30 (3) / ldx #$113A (3) / ldy #$1132 (4)
  c(3); c(3); c(4);
  let u = 0x0e30;
  let x = 0x113a;
  for (let y = 0x1132; y !== 0x1137; y += 1) {
    // $BCFD: lda ,y (4) / beq (3)
    yield SYNC;
    const a = s.peek(y);
    c(4); c(3);
    if (a !== 0) {
      // pshs y (7) / bsr sub_BD18 (7) / puls y (7)
      c(7); c(7);
      yield* sub_BD18(m, { a, x, u });
      c(7);
    }
    // leau 2,u / leax 1,x / leay 1,y (5 each) / cmpy #$1137 (5) /
    // bne (3)
    u += 2;
    x += 1;
    c(5); c(5); c(5); c(5); c(3);
  }
  yield* endTask(m);
}

/**
 * Jump to tbl_BEDD[state - 1]: `ldy #tbl_BEDD (4) / deca / asla (4) /
 * jmp [a,y] (7)` (8-bit, signed offset).
 * @see gaplus-sub.asm $BD18
 * @param {Machine} m
 * @param {{ a: number, x: number, u: number }} regs
 * @returns {Generator<unknown, unknown, unknown>}
 */
export function* sub_BD18(m, { a, x, u }) {
  const p = disp8(0xbedd, ((a - 1) << 1) & 0xff);
  yield* syncAt(p, p + 1);
  const target = m.sub.peek16(p);
  m.sub.charge(4); m.sub.charge(4); m.sub.charge(7);
  return yield* call(subAt(target), m, { x, u });
}

/**
 * State 1, launch: free flag := 0, status $82, picture $500B, position
 * from $171E, flags $80, path dat_BEAD[stage & 7], speed $28, state 2,
 * counter U+$31A := 0.
 * @see gaplus-sub.asm $BD20
 * @param {Machine} m
 * @param {BonusRegs} regs
 * @returns {Thread}
 */
export function* sub_BD20(m, { x, u }) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // clr ,x (6) / lda #$82 (2) / sta $0726,x (8)
  yield* syncAt(x);
  s.poke(x, 0);
  c(6); c(2);
  yield* syncAt(x + 0x0726);
  s.poke((x + 0x0726) & 0xffff, 0x82);
  c(8);
  // ldd #$500B (3) / std ,u (5)
  c(3);
  yield* syncAt(u, u + 1);
  s.poke16(u, 0x500b);
  c(5);
  // ldd $171E (6) / std $0800,u (9)
  yield SYNC;
  const d = s.peek16(0x171e);
  c(6);
  yield* syncAt(u + 0x0800, u + 0x0801);
  s.poke16((u + 0x0800) & 0xffff, d);
  c(9);
  // lda #$80 (2) / sta $1001,u (8)
  c(2);
  yield* syncAt(u + 0x1001);
  s.poke((u + 0x1001) & 0xffff, 0x80);
  c(8);
  // lda <stage (4) / anda #7 / asla (4) / ldy #dat_BEAD (4) /
  // ldd a,y (6) / std $09D0,u (9)
  yield SYNC;
  const i = (s.peek(0x1035) & 0x07) << 1;
  c(4); c(4); c(4); c(6);
  yield* syncAt(u + 0x09d0, u + 0x09d1);
  s.poke16((u + 0x09d0) & 0xffff, s.peek16(0xbead + i));
  c(9);
  // lda #$28 (2) / sta $08A6,x (8) / inc -8,x (7) / clr $031A,u (10) /
  // rts (5)
  c(2);
  yield* syncAt(x + 0x08a6);
  s.poke((x + 0x08a6) & 0xffff, 0x28);
  c(8);
  yield* syncAt(x - 8);
  inc(s, (x - 8) & 0xffff);
  c(7);
  yield* syncAt(u + 0x031a);
  s.poke((u + 0x031a) & 0xffff, 0);
  c(10); c(5);
}

/**
 * State 2, flying. Off the bottom (Y >= $E0) or X / 2 >= $B0, or below
 * $20 while the status b0 is clear and the flags have b0 or b7: done
 * (status 1, flags 0, state 4). Otherwise, once the status b0 is set
 * (the path ended): back to the start point $1109/$110B, status $82,
 * U+$31B := 1, $1162 + 1 (BCD), $1164 + 1, state 3, U+$31A + 1,
 * $084A + 1; flags b0 from the side of the screen; next path
 * dat_BEBD / dat_BECD[stage & 7] (odd / even pass) and speed
 * dat_BE71[pass], which at $98 also switches the path to $DADC.
 * @see gaplus-sub.asm $BD56
 * @param {Machine} m
 * @param {BonusRegs} regs
 * @returns {Thread}
 */
export function* sub_BD56(m, { x, u }) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  const st = (x + 0x0726) & 0xffff;
  const fl = (u + 0x1001) & 0xffff;
  const px = (u + 0x0801) & 0xffff;
  // lda $0800,u (8) / cmpa #$E0 / bcs (2 + 3)
  yield* syncAt(u + 0x0800);
  let done = s.peek((u + 0x0800) & 0xffff) >= 0xe0;
  c(8); c(2); c(3);
  let chk = false;
  if (!done) {
    // $BD7F: lda $0801,u (8) / ldb $1001,u (8) / lsrb / rora (4) /
    // cmpa #$B0 / bcc (2 + 3) / cmpa #$20 / bcs (2 + 3): 9-bit X / 2
    yield* syncAt(px);
    const lo = s.peek(px);
    c(8);
    yield* syncAt(fl);
    const x9 = (lo >> 1) | ((s.peek(fl) & 1) << 7);
    c(8); c(4); c(2); c(3);
    if (x9 >= 0xb0) done = true;
    else {
      c(2); c(3);
      if (x9 < 0x20) {
        // $BD6D: lda $0726,x (8) / anda #1 / bne (2 + 3) /
        // lda $1001,u (8) / anda #$81 / beq (2 + 3) / bra lBD5E (3)
        yield* syncAt(st);
        const ended = (s.peek(st) & 0x01) !== 0;
        c(8); c(2); c(3);
        if (!ended) {
          yield* syncAt(fl);
          const f = s.peek(fl) & 0x81;
          c(8); c(2); c(3);
          if (f !== 0) { c(3); done = true; }
        }
      }
    }
  }
  if (done) {
    // $BD5E: lda #1 (2) / sta $0726,x (8) / clr $1001,u (10) /
    // inc -8,x (7) / inc -8,x (7) / rts (5)
    c(2);
    yield* syncAt(st);
    s.poke(st, 1);
    c(8);
    yield* syncAt(fl);
    s.poke(fl, 0);
    c(10);
    for (let k = 0; k < 2; k += 1) {
      yield* syncAt(x - 8);
      inc(s, (x - 8) & 0xffff);
      c(7);
    }
    c(5);
    return;
  }
  // $BD91: lda $0726,x (8) / anda #1 / beq (2 + 3) [rts (5)]
  yield* syncAt(st);
  chk = (s.peek(st) & 0x01) !== 0;
  c(8); c(2); c(3);
  if (!chk) { c(5); return; }
  // ldd $1109 (6) / std $0800,u (9) / lda $110B (5) / sta $1001,u (8)
  yield SYNC;
  const d = s.peek16(0x1109);
  c(6);
  yield* syncAt(u + 0x0800, u + 0x0801);
  s.poke16((u + 0x0800) & 0xffff, d);
  c(9);
  yield SYNC;
  let a = s.peek(0x110b);
  c(5);
  yield* syncAt(fl);
  s.poke(fl, a);
  c(8);
  // lda #$82 (2) / sta $0726,x (8) / lda #1 (2) / sta $031B,u (8)
  c(2);
  yield* syncAt(st);
  s.poke(st, 0x82);
  c(8); c(2);
  yield* syncAt(u + 0x031b);
  s.poke((u + 0x031b) & 0xffff, 1);
  c(8);
  // lda $1162 (5) / adda #1 / daa (2 + 2) / sta $1162 (5)
  yield SYNC;
  const r = add8(s.peek(0x1162), 1);
  c(5); c(2); c(2);
  yield SYNC;
  s.poke(0x1162, daa(r.v, r.cc).v);
  c(5);
  // inc $1164 (7) / inc -8,x (7) / inc $031A,u (10) / inc $084A (7)
  yield SYNC;
  inc(s, 0x1164);
  c(7);
  yield* syncAt(x - 8);
  inc(s, (x - 8) & 0xffff);
  c(7);
  const pass = (u + 0x031a) & 0xffff;
  yield* syncAt(pass);
  inc(s, pass);
  c(10);
  yield SYNC;
  inc(s, 0x084a);
  c(7);
  // lda $031A,u (8) / anda #1 / beq (2 + 3)
  yield* syncAt(pass);
  const odd = (s.peek(pass) & 0x01) !== 0;
  c(8); c(2); c(3);
  // $BDD0 / $BE0F: lda $0801,u (8) / ldb $1001,u (8) / lsrb / rora (4) /
  // ldb #$80 (2) / cmpa #$80 / bcs (2 + 3) [ldb #$81 (2)] /
  // stb $1001,u (8)
  yield* syncAt(px);
  const lo = s.peek(px);
  c(8);
  yield* syncAt(fl);
  const x9 = (lo >> 1) | ((s.peek(fl) & 1) << 7);
  c(8); c(4); c(2); c(2); c(3);
  if (x9 >= 0x80) c(2);
  yield* syncAt(fl);
  s.poke(fl, x9 >= 0x80 ? 0x81 : 0x80);
  c(8);
  // lda <stage (4) / anda #7 / asla (4) / ldy #dat_BEBD|BECD (4) /
  // ldd a,y (6) / std $09D0,u (9)
  yield SYNC;
  const i = (s.peek(0x1035) & 0x07) << 1;
  c(4); c(4); c(4); c(6);
  const path = (u + 0x09d0) & 0xffff;
  yield* syncAt(path, path + 1);
  s.poke16(path, s.peek16((odd ? 0xbebd : 0xbecd) + i));
  c(9);
  // ldy #dat_BE71 (4) / lda $031A,u (8) / lda a,y (5, signed) /
  // sta $08A6,x (8) / cmpa #$98 / bne (2 + 3)
  c(4);
  yield* syncAt(pass);
  const n = s.peek(pass);
  c(8);
  const q = disp8(0xbe71, n);
  yield* syncAt(q);
  a = s.peek(q);
  c(5);
  yield* syncAt(x + 0x08a6);
  s.poke((x + 0x08a6) & 0xffff, a);
  c(8); c(2); c(3);
  if (a === 0x98) {
    // ldd #$DADC (3) / std $09D0,u (9)
    c(3);
    yield* syncAt(path, path + 1);
    s.poke16(path, 0xdadc);
    c(9);
  }
  // odd: rts (5); even: bra (3) / rts (5)
  c(odd ? 5 : 3 + 5);
}

/**
 * State 3, hold at the start point $1109/$110B (status $82) for
 * U+$31B frames, then back to state 2.
 * @see gaplus-sub.asm $BE4F
 * @param {Machine} m
 * @param {BonusRegs} regs
 * @returns {Thread}
 */
export function* sub_BE4F(m, { x, u }) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // lda #$82 (2) / sta $0726,x (8)
  c(2);
  yield* syncAt(x + 0x0726);
  s.poke((x + 0x0726) & 0xffff, 0x82);
  c(8);
  // ldd $1109 (6) / std $0800,u (9) / lda $110B (5) / sta $1001,u (8)
  yield SYNC;
  const d = s.peek16(0x1109);
  c(6);
  yield* syncAt(u + 0x0800, u + 0x0801);
  s.poke16((u + 0x0800) & 0xffff, d);
  c(9);
  yield SYNC;
  const a = s.peek(0x110b);
  c(5);
  yield* syncAt(u + 0x1001);
  s.poke((u + 0x1001) & 0xffff, a);
  c(8);
  // dec $031B,u (10) / bne (3) [dec -8,x (7)] / rts (5)
  yield* syncAt(u + 0x031b);
  const left = dec(s, (u + 0x031b) & 0xffff);
  c(10); c(3);
  if (left === 0) {
    yield* syncAt(x - 8);
    dec(s, (x - 8) & 0xffff);
    c(7);
  }
  c(5);
}

/**
 * State 4, done: free flag := 1. `lda #1 (2) / sta ,x (4) / rts (5)`.
 * @see gaplus-sub.asm $BE6C
 * @param {Machine} m
 * @param {{ x: number }} regs
 * @returns {Thread}
 */
export function* sub_BE6C(m, { x }) {
  m.sub.charge(2);
  yield* syncAt(x);
  m.sub.poke(x, 1);
  m.sub.charge(4); m.sub.charge(5);
}

/**
 * Colour cycler (mode 7): for each of the nine entries $114A-$1158
 * (step 2) that is non-zero, sprite $0E30+2k gets code
 * dat_BF27[$115E] and flags dat_BF40[$115E]; then $115E steps through
 * dat_BF27 and wraps at its 0 terminator.
 * @see gaplus-sub.asm $BEE5
 * @param {Machine} m
 * @returns {Thread}
 */
export function* sub_BEE5(m) {
  const s = m.sub;
  /** @param {number} n */
  const c = (n) => s.charge(n);
  // ldx #$1148 (3) / ldu #$0E2E (3)
  c(3); c(3);
  let x = 0x1148;
  let u = 0x0e2e;
  for (;;) {
    // $BEEB: leau 2,u / leax 2,x (5 + 5) / cmpx #$115A / beq (4 + 3)
    u += 2;
    x += 2;
    c(5); c(5); c(4); c(3);
    if (x === 0x115a) break;
    // lda ,x (4) / beq (3)
    yield SYNC;
    const on = s.peek(x) !== 0;
    c(4); c(3);
    if (!on) continue;
    // ldy #dat_BF27 (4) / lda $115E (5) / lda a,y (5) / sta ,u (4)
    c(4);
    yield SYNC;
    let q = disp8(0xbf27, s.peek(0x115e));
    c(5);
    yield* syncAt(q);
    let a = s.peek(q);
    c(5);
    yield SYNC;
    s.poke(u, a);
    c(4);
    // ldy #dat_BF40 (4) / lda $115E (5) / lda a,y (5) /
    // sta $1000,u (8) / bra (3)
    c(4);
    yield SYNC;
    q = disp8(0xbf40, s.peek(0x115e));
    c(5);
    yield* syncAt(q);
    a = s.peek(q);
    c(5);
    yield SYNC;
    s.poke(u + 0x1000, a);
    c(8); c(3);
  }
  // $BF12: inc $115E (7) / ldx #dat_BF27 (3) / lda $115E (5) /
  // lda a,x (5) / bne (3) [clr $115E (7)]
  yield SYNC;
  inc(s, 0x115e);
  c(7); c(3);
  yield SYNC;
  const q = disp8(0xbf27, s.peek(0x115e));
  c(5);
  yield* syncAt(q);
  const a = s.peek(q);
  c(5); c(3);
  if (a === 0) {
    yield SYNC;
    s.poke(0x115e, 0);
    c(7);
  }
  yield* endTask(m);
}

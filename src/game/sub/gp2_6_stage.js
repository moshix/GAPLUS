// Copyright 2026 by Moshix
/**
 * Sub CPU, ROM gp2-6.11b, $E18A-$E5A9 (registered by gp2_6.js): the
 * mode 2 stage setup and the mode 3-5 formation sprite tasks.
 *
 *   task_stage_setup  $E18A  mode 2: build the stage's sprites/formation
 *   sub_E341          $E341  formation tiles + dispatch on frame & 7
 *   sub_E369          $E369  formation sprite codes for this frame
 *   sub_E3DA          $E3DA  move the formation along its path, lay out
 *   sub_E4B5          $E4B5  scan_formation, next task
 *   sub_E4BD          $E4BD  formation slot positions at $1B00
 *   scan_formation    $E51C  (subroutine) formation state -> sprites
 *
 * Task convention: see gp2_6.js. Timing: every routine is a generator
 * that charges its instructions' cycles and yields SYNC before each
 * access to shared memory (gp2_6_state.js). A task's cycles run from its
 * first instruction to its final jump to task_dispatch_sub inclusive;
 * scan_formation's from its first instruction to its RTS (the JSR is
 * charged by the caller). None of these tasks waits.
 */

import { subAt } from './routines.js';
import { disp8, add8, adc8, sub8, sbc8 } from '../m6809ops.js';
import { rd, rd16, wr, wr16, rmw, INC, CLR } from './gp2_6_state.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {import('../../machine/machine.js').CpuView} CpuView */
/** @typedef {Generator<symbol, void, unknown>} Task */

/**
 * `lda <$nn / asla / ldX #table / ldX a,X`: the stage-indexed pointer
 * lookups (asla is 8-bit, a,X a SIGNED offset). Charges the lda (4) and
 * the asla (2); the caller charges the ldX # and the indexed load.
 * @param {CpuView} s @param {number} table @param {number} idxAddr
 * @returns {Generator<symbol, number, unknown>} the address of the word
 */
function* tableSlot(s, table, idxAddr) {
  const a = yield* rd(s, idxAddr, 4);
  s.charge(2);
  return disp8(table, (a << 1) & 0xff);
}

// ----------------------------------------------------- task_stage_setup

/**
 * task_stage_setup ($E18A): mode 2 task, two passes. First pass ($1081
 * = 0): copy the stage's sprite template (dat_E2C3[stage $106E]) into the
 * shadow buffers at $0E84 (+$1000 banks, list ended by $FFFF), set the
 * colour of $0E87/$0E8B from dat_E2E7[$1070], $1081 = 1, next task.
 * Second pass: clear $1E30-$1E87, lay out the formation's shadow sprites,
 * reset formation state ($1860.., formation_ptr $1086, $1096, $1890..,
 * $18C0../$19E0.. from $100F), write the sprite codes (dat_E293) and
 * positions (dat_E2A5) for the stage, clear $10FA, game_mode + 1,
 * $1081 = sub_task = 0.
 * @see gaplus-sub.asm $E18A
 * @param {Machine} m
 * @returns {Task}
 */
export function* task_stage_setup(m) {
  const s = m.sub;
  // $E18A: lda <$81 / bne $E1C6
  const pass = yield* rd(s, 0x1081, 4);
  s.charge(3);
  if (pass === 0) {
    // $E18E: ldu #$E2C3 (3) / lda <$6E / asla / ldu a,u (6)
    s.charge(3);
    let u = yield* rd16(s, yield* tableSlot(s, 0xe2c3, 0x106e), 6);
    // $E196: ldx #$0E84 (3) / ldd ,u (5) / std $0E2C (6)
    s.charge(3);
    let x = 0x0e84;
    yield* wr16(s, 0x0e2c, yield* rd16(s, u, 5), 6); // sprite_shadow_1+44
    for (;;) {
      // $E19E: ldd ,u++ (8) / cmpd #$FFFF (5) / beq $E1B2 (3)
      const w1 = yield* rd16(s, u, 8);
      u = (u + 2) & 0xffff;
      s.charge(5); s.charge(3);
      if (w1 === 0xffff) break;
      // std ,x++ (8) / ldd ,u++ (8) / std ,x (5) / leax $0FFE,x (8) /
      // bra (3) -- pairs of words, the next pair $1000 higher (the next
      // sprite RAM bank)
      yield* wr16(s, x, w1, 8);
      x = (x + 2) & 0xffff;
      const w2 = yield* rd16(s, u, 8);
      u = (u + 2) & 0xffff;
      yield* wr16(s, x, w2, 5);
      x = (x + 0x0ffe) & 0xffff;
      s.charge(8); s.charge(3);
    }
    // $E1B2: ldx #$E2E7 (3) / lda <$70 (4) / lda a,x (5, signed) /
    // sta $0E87 / sta $0E8B
    s.charge(3);
    const i = yield* rd(s, 0x1070, 4);
    const c = yield* rd(s, disp8(0xe2e7, i), 5);
    yield* wr(s, 0x0e87, c, 5);
    yield* wr(s, 0x0e8b, c, 5);
    yield* rmw(s, 0x1081, INC, 6);
    yield* rmw(s, 0x107a, INC, 6); // sub_task
    s.charge(5); // $E1C3: lbra task_dispatch_sub
    return;
  }

  // $E1C6: ldx #$1E30 / ldd #0, then std ,x++ / cmpx #$1E88 / bne
  s.charge(3); s.charge(3);
  let x = 0x1e30;
  for (; x !== 0x1e88; x += 2) {
    yield* wr16(s, x, 0, 8);
    s.charge(4); s.charge(3);
  }
  // $E1D3: lda #$40 / sta $1E86
  s.charge(2);
  yield* wr(s, 0x1e86, 0x40, 5);
  // $E1D8: $1E02-$1E2B = $6080, then $0080, $4080
  s.charge(3); s.charge(3);
  for (x = 0x1e02; x !== 0x1e2c; x += 2) {
    yield* wr16(s, x, 0x6080, 8);
    s.charge(4); s.charge(3);
  }
  s.charge(3);
  yield* wr16(s, x, 0x0080, 8);
  s.charge(3);
  yield* wr16(s, x + 2, 0x4080, 8);
  // $E1EF: ldx #$1860 / stx <$86 -- formation_ptr = formation_flags
  s.charge(3);
  yield* wr16(s, 0x1086, 0x1860, 5);
  s.charge(2);
  yield* wr(s, 0x1096, 0xff, 4);
  // $E1F8: ldx #$1890 / lda #$28 / sta ,x+ / cmpx #$18BC / bne
  s.charge(3); s.charge(2);
  for (x = 0x1890; x !== 0x18bc; x += 1) {
    yield* wr(s, x, 0x28, 6);
    s.charge(4); s.charge(3);
  }
  // $E204: ldu #$19E0 / ldx #$18C0 / lda <$0F, then $18C0-$18EB and
  // $19E0-$1A0B get it, interleaved
  s.charge(3); s.charge(3);
  const f = yield* rd(s, 0x100f, 4);
  let u = 0x19e0;
  for (x = 0x18c0; x !== 0x18ec; x += 1) {
    yield* wr(s, x, f, 6);
    yield* wr(s, u, f, 6);
    u += 1;
    s.charge(4); s.charge(3);
  }
  // $E215: sprite codes from dat_E293[stage]: 10, 5, 4, 2 slots
  {
    const slot = yield* tableSlot(s, 0xe293, 0x106e);
    s.charge(3); // ldx #$E293
    const p = yield* rd16(s, slot, 6);
    s.charge(3); // ldu #$0E03
    u = 0x0e03; // sprite_shadow_1+3
    const runs = [[0, 10], [1, 5], [2, 4], [3, 2]];
    for (const [off, n] of runs) {
      // lda ,x (4) or lda n,x (5) / ldb #n (2), then sta ,u++ (7) /
      // decb (2) / bne (3)
      const a = yield* rd(s, (p + off) & 0xffff, off === 0 ? 4 : 5);
      s.charge(2);
      for (let b = n; b > 0; b -= 1) {
        yield* wr(s, u, a, 7);
        u = (u + 2) & 0xffff;
        s.charge(2); s.charge(3);
      }
    }
  }
  // $E244: ldx #$1860, then lda ,x+ (6) / cmpx #$188D (4) / beq (3) /
  // anda #$01 (2) / bne (3) / clr -1,x (7) / bra (3): formation entries
  // without bit 0 are cleared
  s.charge(3);
  x = 0x1860;
  for (;;) {
    const a = yield* rd(s, x, 6);
    x += 1;
    s.charge(4); s.charge(3);
    if (x === 0x188d) break;
    s.charge(2); s.charge(3);
    if ((a & 0x01) === 0) {
      yield* rmw(s, x - 1, CLR, 7);
      s.charge(3);
    }
  }
  // $E256: positions from dat_E2A5[stage]: 4 words, each repeated up to
  // $0E58, $0E6C, $0E7C, $0E84 (ldd ,u++ 8; std ,x++ 8 / cmpx 4 / bne 3)
  {
    const slot = yield* tableSlot(s, 0xe2a5, 0x106e);
    s.charge(3); // ldu #$E2A5
    u = yield* rd16(s, slot, 6);
    x = 0x0e30; // sprite_shadow_1+48
    let first = true;
    for (const end of [0x0e58, 0x0e6c, 0x0e7c, 0x0e84]) {
      const d = yield* rd16(s, u, 8);
      u = (u + 2) & 0xffff;
      if (first) { s.charge(3); first = false; } // $E260: ldx #$0E30
      for (; x !== end; x += 2) {
        yield* wr16(s, x, d, 8);
        s.charge(4); s.charge(3);
      }
    }
  }
  // $E285: ldd #0 / std <$FA / inc <$2F / clr <$81 / clr <$7A / jmp
  s.charge(3);
  yield* wr16(s, 0x10fa, 0, 5);
  yield* rmw(s, 0x102f, INC, 6); // game_mode
  yield* rmw(s, 0x1081, CLR, 6);
  yield* rmw(s, 0x107a, CLR, 6); // sub_task
  s.charge(4);
}

// ------------------------------------------------------------- sub_E341

/**
 * sub_E341 ($E341): mode 3-5 task. While $10AC is 0 (the formation not
 * started) go to sub_E369. Otherwise set $0849 = 1 unless $10F8, and
 * jump through tbl_E359[frame_counter & 7] (sub_E3DA, sub_E4BD,
 * sub_E369, sub_E4B5).
 * @see gaplus-sub.asm $E341
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E341(m) {
  const s = m.sub;
  // $E341: lda <$AC / beq sub_E369
  const started = yield* rd(s, 0x10ac, 4);
  s.charge(3);
  if (started === 0) { yield* sub_E369(m); return; }
  // $E345: lda <$F8 / bne $E34E / lda #$01 / sta $0849
  const f8 = yield* rd(s, 0x10f8, 4);
  s.charge(3);
  if (f8 === 0) {
    s.charge(2);
    yield* wr(s, 0x0849, 0x01, 5);
  }
  // $E34E: lda <$16 / anda #$07 / asla / ldy #$E359 / jmp [a,y]
  const fc = yield* rd(s, 0x1016, 4); // frame_counter
  s.charge(2); s.charge(2); s.charge(4);
  const target = yield* rd16(s, 0xe359 + ((fc & 0x07) << 1), 7);
  const r = subAt(target)(m);
  if (r !== undefined) yield* /** @type {Task} */ (r);
}

// ------------------------------------------------------------- sub_E369

/**
 * sub_E369 ($E369): write this frame's formation sprite codes into the
 * shadow buffer ($0E02-$0E2B: 10, 5, 4 and 2 slots from dat_E2ED[stage]
 * + (frame_counter & $18) / 2; $0E2C from dat_E323; $0E2E from
 * dat_E3CE[$1070]), clearing $1E89 on the way; then sub_E3DA if $10AC
 * is still 0, else sub_E4B5.
 * @see gaplus-sub.asm $E369
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E369(m) {
  const s = m.sub;
  // $E369: lda <$6E / asla / ldy #$E2ED (4) / ldy a,y (7)
  const slot = yield* tableSlot(s, 0xe2ed, 0x106e);
  s.charge(4);
  let y = yield* rd16(s, slot, 7);
  // $E373: lda <$16 / anda #$18 / lsra / leay a,y (5)
  const fc = yield* rd(s, 0x1016, 4); // frame_counter
  s.charge(2); s.charge(2); s.charge(5);
  y = disp8(y, (fc & 0x18) >> 1);
  // $E37A: lda ,y (4) / ldu #$0E02 (3); four runs of sta ,u++ (7) /
  // cmpu #end (5) / bne (3), each run's byte from lda n,y (5)
  let u = 0x0e02; // sprite_shadow_1+2
  const ends = [0x0e16, 0x0e20, 0x0e28, 0x0e2c];
  for (let i = 0; i < 4; i += 1) {
    const a = yield* rd(s, (y + i) & 0xffff, i === 0 ? 4 : 5);
    if (i === 0) s.charge(3);
    // $E39D: clr $1E89 sits between `lda $3,y` and the last loop
    if (i === 3) yield* rmw(s, 0x1e89, CLR, 7);
    for (; u !== ends[i]; u += 2) {
      yield* wr(s, u, a, 7);
      s.charge(5); s.charge(3);
    }
  }
  // $E3A8: ldx #$E323 (3) / lda <$6E / asla / ldx a,x (6) / lda <$16 /
  // anda #$38 / lsra x3 / lda a,x (5) / sta $0E2C (5)
  s.charge(3);
  const x = yield* rd16(s, yield* tableSlot(s, 0xe323, 0x106e), 6);
  const fc2 = yield* rd(s, 0x1016, 4);
  s.charge(2); s.charge(2); s.charge(2); s.charge(2);
  const code = yield* rd(s, disp8(x, (fc2 & 0x38) >> 3), 5);
  yield* wr(s, 0x0e2c, code, 5);
  // $E3BC: ldx #$E3CE (3) / lda <$70 / asla / ldd a,x (6) / std $0E2E
  s.charge(3);
  const d = yield* rd16(s, yield* tableSlot(s, 0xe3ce, 0x1070), 6);
  yield* wr16(s, 0x0e2e, d, 6);
  // $E3C7: lda <$AC / beq sub_E3DA / jmp sub_E4B5 (4)
  const started = yield* rd(s, 0x10ac, 4);
  s.charge(3);
  if (started === 0) {
    yield* sub_E3DA(m);
  } else {
    s.charge(4);
    yield* sub_E4B5(m);
  }
}

// ------------------------------------------------------------- sub_E3DA

/**
 * One axis of the formation's 16-bit position (hi byte `hiAddr` in the
 * $16xx bank, fraction `loAddr` in $0Exx), stepped by the path byte at
 * `stepAddr` and the high part already stored in $1E88:
 *
 *   add:  lda step / adda lo / sta lo / lda $1E88 / adca hi / sta hi
 *   sub:  lda lo / suba step / sta lo / lda hi / sbca $1E88 / sta hi
 *
 * (all 5 cycles; the carry of the first ALU op feeds the second).
 * @param {CpuView} s @param {boolean} add @param {number} stepAddr
 * @param {number} loAddr @param {number} hiAddr
 * @returns {Generator<symbol, void, unknown>}
 */
function* axis(s, add, stepAddr, loAddr, hiAddr) {
  if (add) {
    const st = yield* rd(s, stepAddr, 5);
    const lo = add8(st, yield* rd(s, loAddr, 5));
    yield* wr(s, loAddr, lo.v, 5);
    const h1 = yield* rd(s, 0x1e88, 5);
    const h = adc8(h1, yield* rd(s, hiAddr, 5), lo.cc);
    yield* wr(s, hiAddr, h.v, 5);
    s.charge(3); // bra
  } else {
    const l0 = yield* rd(s, loAddr, 5);
    const lo = sub8(l0, yield* rd(s, stepAddr, 5));
    yield* wr(s, loAddr, lo.v, 5);
    const h0 = yield* rd(s, hiAddr, 5);
    const h = sbc8(h0, yield* rd(s, 0x1e88, 5), lo.cc);
    yield* wr(s, hiAddr, h.v, 5);
  }
}

/**
 * sub_E3DA ($E3DA): $10AC = $55; advance the formation's 16-bit position
 * ($1688:$0E88 Y, $1689:$0E89 X) by the path step at formation path
 * pointer $1082 (4 bytes: hi nibbles | lo nibbles, dy, dx, direction
 * bits), restarting the path at dat_ADCF (position $28A8) when the next
 * step is $FF; set $10BF = 1, lay out the formation slot positions at
 * $1602-$1631 from the new position, then sub_E4B5.
 * @see gaplus-sub.asm $E3DA
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E3DA(m) {
  const s = m.sub;
  s.charge(2); // lda #$55
  yield* wr(s, 0x10ac, 0x55, 4);
  let u = yield* rd16(s, 0x1082, 5);
  // $E3E0: ldb ,u / lsrb x4 / stb $1E88 -- the high part of the Y step
  const b0 = yield* rd(s, u, 4);
  s.charge(2 * 4);
  yield* wr(s, 0x1e88, b0 >> 4, 5);
  // $E3E9: lda $3,u / anda #$01 / bne $E402 -- bit 0 set: subtract
  const dir = yield* rd(s, (u + 3) & 0xffff, 5);
  s.charge(2); s.charge(3);
  yield* axis(s, (dir & 0x01) === 0, (u + 1) & 0xffff, 0x0e88, 0x1688);
  // $E413: ldb ,u / andb #$0F / stb $1E88 -- the high part of the X step
  const b1 = yield* rd(s, u, 4);
  s.charge(2);
  yield* wr(s, 0x1e88, b1 & 0x0f, 5);
  // $E41A: lda $3,u / anda #$02 / beq $E433 -- bit 1 SET adds (where
  // bit 0 set subtracts)
  const dir2 = yield* rd(s, (u + 3) & 0xffff, 5);
  s.charge(2); s.charge(3);
  yield* axis(s, (dir2 & 0x02) !== 0, (u + 2) & 0xffff, 0x0e89, 0x1689);
  // $E444: leau $4,u (5) / lda ,u (4) / cmpa #$FF (2) / bne $E45B (3)
  s.charge(5);
  u = (u + 4) & 0xffff;
  const nxt = yield* rd(s, u, 4);
  s.charge(2); s.charge(3);
  if (nxt === 0xff) {
    s.charge(3);
    yield* wr16(s, 0x0e88, 0x0000, 6);
    s.charge(3);
    yield* wr16(s, 0x1688, 0x28a8, 6);
    s.charge(3);
    u = 0xadcf; // dat_ADCF: the path's first step
  }
  yield* wr16(s, 0x1082, u, 5);
  s.charge(2);
  yield* wr(s, 0x10bf, 0x01, 4);
  // $E461: the slot positions. Each row: D = ($1688) (ldd 6) with B
  // lowered by the row's offset (subb 2) and A raised (adda 2), then
  // std ,u++ (8) / adda #step (2) / cmpu #end (5) / bne (3).
  s.charge(3); // ldu #$1602
  let p = 0x1602;
  /** @type {Array<[number, number, number]>} [B minus, A plus, end] */
  const rows = [
    [0x00, 0x00, 0x160c],
    [0x10, 0x00, 0x1616],
    [0x20, 0x00, 0x1620],
    [0x30, 0x10, 0x1628],
  ];
  for (const [bm, ap, end] of rows) {
    const d = yield* rd16(s, 0x1688, 6);
    if (bm) s.charge(2);
    if (ap) s.charge(2);
    let a = ((d >> 8) + ap) & 0xff;
    const b = ((d & 0xff) - bm) & 0xff;
    while (p !== end) {
      yield* wr16(s, p, (a << 8) | b, 8);
      p += 2;
      a = (a + 0x20) & 0xff;
      s.charge(2); s.charge(5); s.charge(3);
    }
  }
  // $E4A0: ldd $1688 / subb #$40 / adda #$28 / std ,u++ / adda #$30 /
  // std ,u++ / suba #$10 / std ,u++ / subb #$10 / std ,u
  const d = yield* rd16(s, 0x1688, 6);
  s.charge(2); s.charge(2);
  let a = ((d >> 8) + 0x28) & 0xff;
  let b = ((d & 0xff) - 0x40) & 0xff;
  yield* wr16(s, p, (a << 8) | b, 8);
  s.charge(2);
  a = (a + 0x30) & 0xff;
  yield* wr16(s, p + 2, (a << 8) | b, 8);
  s.charge(2);
  a = (a - 0x10) & 0xff;
  yield* wr16(s, p + 4, (a << 8) | b, 8);
  s.charge(2);
  b = (b - 0x10) & 0xff;
  yield* wr16(s, p + 6, (a << 8) | b, 5);
  // falls into sub_E4B5
  yield* sub_E4B5(m);
}

// ------------------------------------------------------------- sub_E4B5

/**
 * sub_E4B5 ($E4B5): jsr scan_formation, then the next task.
 * @see gaplus-sub.asm $E4B5
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E4B5(m) {
  m.sub.charge(8); // jsr
  yield* scan_formation(m);
  yield* rmw(m.sub, 0x107a, INC, 6); // sub_task
  m.sub.charge(4); // jmp task_dispatch_sub
}

// ------------------------------------------------------------- sub_E4BD

/**
 * sub_E4BD ($E4BD): lay out the formation slot positions at $1B00-$1B5F
 * from the formation position $1688 (rows of 10, 10, 10, 8 and 6 slots,
 * $10 apart), then sub_E4B5.
 * @see gaplus-sub.asm $E4BD
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_E4BD(m) {
  const s = m.sub;
  s.charge(3); // ldu #$1B00
  let p = 0x1b00;
  /** @type {Array<[number, number, number]>} [B minus, A plus, end] */
  const rows = [
    [0x00, 0x00, 0x1b14],
    [0x10, 0x00, 0x1b28],
    [0x20, 0x00, 0x1b3c],
    [0x30, 0x10, 0x1b4c],
  ];
  for (const [bm, ap, end] of rows) {
    const d = yield* rd16(s, 0x1688, 6);
    if (bm) s.charge(2);
    if (ap) s.charge(2);
    let a = ((d >> 8) + ap) & 0xff;
    const b = ((d & 0xff) - bm) & 0xff;
    while (p !== end) {
      yield* wr16(s, p, (a << 8) | b, 8);
      p += 2;
      a = (a + 0x10) & 0xff;
      s.charge(2); s.charge(5); s.charge(3);
    }
  }
  // $E4FC: ldd $1688 / subb #$40 / adda #$28 / std ,u++ / adda #$10 /
  // std ,u++ / adda #$20 / std ,u++ / adda #$10 / std ,u++ / suba #$20 /
  // std ,u++ / subb #$10 / std ,u
  const d = yield* rd16(s, 0x1688, 6);
  s.charge(2); s.charge(2);
  let a = ((d >> 8) + 0x28) & 0xff;
  let b = ((d & 0xff) - 0x40) & 0xff;
  yield* wr16(s, p, (a << 8) | b, 8);
  p += 2;
  for (const k of [0x10, 0x20, 0x10, -0x20]) {
    s.charge(2);
    a = (a + k) & 0xff;
    yield* wr16(s, p, (a << 8) | b, 8);
    p += 2;
  }
  s.charge(2);
  b = (b - 0x10) & 0xff;
  yield* wr16(s, p, (a << 8) | b, 5);
  // $E519: jmp sub_E4B5
  s.charge(4);
  yield* sub_E4B5(m);
}

// -------------------------------------------------------- scan_formation

/**
 * scan_formation ($E51C, subroutine): for each of the 44 formation
 * entries $1860-$188B with bit 4 set: copy its slot position ($1B00 + 2n)
 * to $1630 + 2n, then step its sprite code $18F0+n through the sequence
 * dat_E591 ($21 -> $22 -> ... -> $2B -> $10 -> $0B -> ... -> $00). A
 * code not in the table, or reaching 0, clears the code, the entry and
 * $1E31 + 2n; otherwise the new code goes into the sprite's flags ($1E30
 * + 2n: bit 6 kept, bits 4-5 of the code as bits 0-1) and colour ($0E30
 * + 2n: high nibble kept, low nibble of the code). No outputs.
 * @see gaplus-sub.asm $E51C
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* scan_formation(m) {
  const s = m.sub;
  s.charge(3); s.charge(2); // ldx #$1860 / ldb #$FE
  let x = 0x1860; // formation_flags
  let b = 0xfe;
  for (;;) {
    // $E521: addb #$02 (2) / lda ,x+ (6) / cmpx #$188D (4) / beq (3) /
    // anda #$10 (2) / beq $E521 (3)
    s.charge(2);
    b = (b + 2) & 0xff;
    const f = yield* rd(s, x, 6);
    x += 1;
    s.charge(4); s.charge(3);
    if (x === 0x188d) { s.charge(5); return; } // rts
    s.charge(2); s.charge(3);
    if ((f & 0x10) === 0) continue;
    // $E52E: ldu #$1B00 / ldy b,u / ldu #$1630 / sty b,u (B signed)
    s.charge(3);
    const pos = yield* rd16(s, disp8(0x1b00, b), 7);
    s.charge(3);
    yield* wr16(s, disp8(0x1630, b), pos, 7);
    // $E53A: lda $008F,x / bne $E550 -- x is one past the entry, so the
    // code is at $18F0 + n
    const code = yield* rd(s, x + 0x8f, 8);
    s.charge(3);
    if (code !== 0) {
      // $E550: ldu #$E591, then cmpu #$E5A9 (5) / beq (3) / cmpa ,u+ (6)
      // / bne (3) until the code is found; lda ,u (4) / beq (3) takes
      // the byte after it
      s.charge(3);
      let u = 0xe591;
      let next = 0;
      for (;;) {
        s.charge(5); s.charge(3);
        if (u === 0xe5a9) break;
        const t = yield* rd(s, u, 6);
        u += 1;
        s.charge(3);
        if (t === code) {
          next = yield* rd(s, u, 4);
          s.charge(3);
          break;
        }
      }
      if (next !== 0) {
        yield* wr(s, x + 0x8f, next, 8);
        // $E565: ldu #$1E30 / lda #$40 / anda b,u / sta b,u / lda $8F,x
        // / anda #$30 / lsra x4 / ora b,u / sta b,u
        s.charge(3); s.charge(2);
        const fl = disp8(0x1e30, b);
        const k1 = 0x40 & (yield* rd(s, fl, 5));
        yield* wr(s, fl, k1, 5);
        const c1 = yield* rd(s, x + 0x8f, 8);
        s.charge(2 + 2 * 4);
        const k2 = ((c1 & 0x30) >> 4) | (yield* rd(s, fl, 5));
        yield* wr(s, fl, k2, 5);
        // $E57C: ldu #$0E30 / lda #$F0 / anda b,u / sta b,u / lda $8F,x
        // / anda #$0F / ora b,u / sta b,u / bra $E521
        s.charge(3); s.charge(2);
        const co = disp8(0x0e30, b);
        const k3 = 0xf0 & (yield* rd(s, co, 5));
        yield* wr(s, co, k3, 5);
        const c2 = yield* rd(s, x + 0x8f, 8);
        s.charge(2);
        const k4 = (c2 & 0x0f) | (yield* rd(s, co, 5));
        yield* wr(s, co, k4, 5);
        s.charge(3);
        continue;
      }
      // $E54A: clr $8F,x / bra $E540 -- not found, or the end of the list
      yield* rmw(s, x + 0x8f, CLR, 10);
      s.charge(3);
    }
    // $E540: clr -1,x / ldu #$1E31 / clr b,u / bra $E521
    yield* rmw(s, x - 1, CLR, 7);
    s.charge(3);
    yield* rmw(s, disp8(0x1e31, b), CLR, 7);
    s.charge(3);
  }
}

/**
 * Every routine of this file by entry address, for gp2_6.js to register
 * into SUB / SUB_AT.
 * @type {Record<number, Function>}
 */
export const ROUTINES = {
  0xe18a: task_stage_setup,
  0xe341: sub_E341,
  0xe369: sub_E369,
  0xe3da: sub_E3DA,
  0xe4b5: sub_E4B5,
  0xe4bd: sub_E4BD,
  0xe51c: scan_formation,
};

// Copyright 2026 by Moshix
/**
 * Main CPU ROM gp2-3b.8c: game start and the small per-frame play tasks.
 *
 *   $CCD0  start_game_1p / $CDFF start_game_2p (and the re-entry lCDA1
 *          that the player-change code jumps to from $DB8E)
 *   $CF14  task_count_fighters   $CF4F task_move_player
 *   $D000  demo_input            $D029 lD029 (end of the demo)
 *   $D150  task_end_frame        $D15B task_next_mode
 *   $D168  task_player_fire (with its continuation at $DFD0)
 *   $D1D0  task_move_shots       $D223 sub_D223 (dual fighter shots)
 *   $D8B0  sub_D8B0 (sound requests)  $D8F8 sub_D8F8
 *
 * TASKS end with `inc <main_task / jmp task_dispatch`: the port charges
 * those instructions and returns, and the dispatcher (gp2-2b) goes on.
 * They run concurrently with the sub CPU's tasks, so every one is a
 * generator with a busy() point (SYNC) before each access to shared
 * RAM or I/O, at the cycle that instruction starts.
 *
 * GAME START is entered from the busy attract loop (or right after an
 * IRQ, lCDA1), so the vblank IRQ can land anywhere in it before its
 * first CWAI. It therefore passes a busy() point (SYNC) before every
 * write and every read of I/O or of the frame counter, with every
 * earlier instruction charged (gp2_3b_state.js). It ends in
 * `jmp task_dispatch_sync` ($FEB0, gp2-2b), which never returns:
 * requestJump().
 *
 * Every routine charges its own cycles (Machine.charge), callees' not
 * included. @see reference/gaplus-main.asm $CCD0-$D282, $D8B0-$D914,
 * $DFD0-$DFF0
 */

import { MAIN } from './routines.js';
import { call } from '../call.js';
import { disp8 } from '../m6809ops.js';
import { busy, requestJump } from './gp2_3b_state.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/** $FEB0 task_dispatch_sync (gp2-2b), where game start ends. */
export const TASK_DISPATCH_SYNC = 0xfeb0;
/** $C417 attract_loop, where the demo ends. */
export const ATTRACT_LOOP = 0xc417;

/**
 * A store in synchronised code: busy() (everything before it is
 * charged; yields SYNC), write, then charge the instruction.
 * @param {Machine} m @param {number} addr @param {number} v
 * @param {number} cyc cycles of the storing instruction
 * @returns {Generator<symbol, void, unknown>}
 */
function* st(m, addr, v, cyc) {
  yield* busy(m, 0);
  m.poke(addr & 0xffff, v & 0xff);
  m.charge(cyc);
}

/**
 * A read of shared RAM or I/O: busy(), read, charge the instruction.
 * @param {Machine} m @param {number} addr @param {number} cyc
 * @returns {Generator<symbol, number, unknown>}
 */
function* rd(m, addr, cyc) {
  yield* busy(m, 0);
  const v = m.peek(addr & 0xffff);
  m.charge(cyc);
  return v;
}

/**
 * A 16-bit read (LDD/LDX/LDU, high byte first) of shared RAM.
 * @param {Machine} m @param {number} addr @param {number} cyc
 * @returns {Generator<symbol, number, unknown>}
 */
function* rd16(m, addr, cyc) {
  yield* busy(m, 0);
  const v = m.peek16(addr & 0xffff);
  m.charge(cyc);
  return v;
}

/**
 * A read-modify-write (INC/DEC/CLR on memory): one busy() point, since
 * the read and the write are the same instruction.
 * @param {Machine} m @param {number} addr
 * @param {(v: number) => number} f new value from the old
 * @param {number} cyc
 * @returns {Generator<symbol, number, unknown>} the value written
 */
function* rmw(m, addr, f, cyc) {
  yield* busy(m, 0);
  const v = f(m.peek(addr & 0xffff)) & 0xff;
  m.poke(addr & 0xffff, v);
  m.charge(cyc);
  return v;
}

/** @param {number} v @returns {number} */
const inc = (v) => v + 1;
/** @returns {number} */
const zero = () => 0;

/**
 * A 16-bit store (STD/STX/STU, high byte first) in synchronised code.
 * @param {Machine} m @param {number} addr @param {number} v
 * @param {number} cyc
 * @returns {Generator<symbol, void, unknown>}
 */
function* st16(m, addr, v, cyc) {
  yield* busy(m, 0);
  m.poke16(addr & 0xffff, v & 0xffff);
  m.charge(cyc);
}

// ------------------------------------------------------------ game start

/**
 * $CCD0 start_game_1p: one player (also the demo). lives_p1 = the lives
 * setting, then the common start with two_players = 0.
 * @see gaplus-main.asm $CCD0
 * @param {Machine} m
 * @returns {Generator<symbol | undefined, void, unknown>}
 */
export function* start_game_1p(m) {
  // $CCD0: lda lives_setting / sta lives_p1 / clra
  m.charge(5);
  yield* st(m, 0x1104, m.peek(0x1000), 5);
  m.charge(2);
  yield* startCommon(m, 0);
}

/**
 * $CDFF start_game_2p: both players get the lives setting, then the
 * common start (`jmp $CCD7`) with two_players = 1.
 * @see gaplus-main.asm $CDFF
 * @param {Machine} m
 * @returns {Generator<symbol | undefined, void, unknown>}
 */
export function* start_game_2p(m) {
  m.charge(5);
  const l = m.peek(0x1000);
  yield* st(m, 0x1104, l, 5);
  yield* st(m, 0x1105, l, 5);
  m.charge(2); m.charge(4); // lda #1 / jmp $CCD7
  yield* startCommon(m, 1);
}

/**
 * $CCD7-$CDA0: two_players = A; clear both scores and their tiles, the
 * playfield ($0000-$03BF tiles $20, attributes 0) and per-game variables;
 * reserve-ship sprites $0F16-$0F1D / $1716-$171D / $1F16-$1F1C and the
 * lives markers $1F17+2n (lives - 1 of them, `decb` 8-bit: lives 0 gives
 * 255); five shot slots $0EA2-$0EAB = $2F00 (flags 0); $1100/$1101 =
 * 6/12; then lCDA1.
 * @param {Machine} m @param {number} a
 * @returns {Generator<symbol | undefined, void, unknown>}
 */
function* startCommon(m, a) {
  yield* st(m, 0x102e, a, 5); // $CCD7: sta two_players
  yield* st(m, 0x1124, 0, 7); // clr (the read is RAM: unobservable)
  yield* st(m, 0x1125, 0, 7);
  m.charge(3); // ldd #0
  yield* st16(m, 0x09b0, 0, 6);
  yield* st(m, 0x09b2, 0, 7);
  yield* st16(m, 0x09b3, 0, 6);
  yield* st(m, 0x09b5, 0, 7);
  m.charge(2); // lda #$20
  for (const t of [0x3e6, 0x3e7, 0x3e8, 0x3e9, 0x3ea, 0x3eb, 0x3f8, 0x3f9,
    0x3fa, 0x3fb, 0x3fc, 0x3fd]) {
    yield* st(m, t, 0x20, 5);
  }
  // $CD15: ldx #0 / ldd #$2000 / { stb $0400,x / sta ,x+ / cmpx #$03C0 /
  // bne }
  m.charge(3); m.charge(3);
  for (let x = 0; x !== 0x3c0; x += 1) {
    yield* st(m, 0x0400 + x, 0, 8);
    yield* st(m, x, 0x20, 6);
    m.charge(4); m.charge(3);
  }
  for (const v of [0x117f, 0x1180, 0x1171, 0x1172, 0x1164, 0x1160, 0x1178,
    0x1179]) {
    yield* st(m, v, 0, 7);
  }
  m.charge(3); // ldd #$2604
  for (const v of [0x0f16, 0x0f18, 0x0f1a, 0x0f1c]) {
    yield* st16(m, v, 0x2604, 6);
  }
  // $CD4D: ldx #$CE0D / 4 x { ldd ,x++ / std $1716+2n }
  m.charge(3);
  for (let i = 0; i < 4; i += 1) {
    m.charge(8);
    yield* st16(m, 0x1716 + 2 * i, m.peek16(0xce0d + 2 * i), 6);
  }
  m.charge(2); // lda #$40
  for (const v of [0x1f16, 0x1f18, 0x1f1a, 0x1f1c]) {
    yield* st(m, v, 0x40, 5);
  }
  // $CD72: ldb lives_setting / stb $101C / decb / beq / ldx #$1F17 /
  // lda #$81 / { sta ,x++ / decb / bne }
  let b = m.peek(0x1000);
  m.charge(5);
  yield* st(m, 0x101c, b, 5);
  b = (b - 1) & 0xff;
  m.charge(2); m.charge(3);
  if (b !== 0) {
    m.charge(3); m.charge(2);
    let x = 0x1f17;
    do {
      yield* st(m, x, 0x81, 7);
      x = (x + 2) & 0xffff;
      b = (b - 1) & 0xff;
      m.charge(2); m.charge(3);
    } while (b !== 0);
  }
  // $CD85: ldx #$2F00 / ldu #$0EA2 / ldd #5 / { sta $1000,u (A = 0) /
  // stx ,u++ / decb / bne }
  m.charge(3); m.charge(3); m.charge(3);
  for (let u = 0x0ea2; u !== 0x0eac; u += 2) {
    yield* st(m, u + 0x1000, 0, 8);
    yield* st16(m, u, 0x2f00, 8);
    m.charge(2); m.charge(3);
  }
  m.charge(2);
  yield* st(m, 0x1100, 0x06, 5);
  m.charge(2);
  yield* st(m, 0x1101, 0x0c, 5);
  yield* lCDA1(m);
}

/**
 * $CDA1 lCDA1: the part of game start that is also the start of a
 * player's turn in a 2-player game (jumped to from $DB8E): outside the
 * demo clear the sprite shadows; starfield for the cabinet orientation
 * (flip_screen: $1170 = 2 and reversed scroll); player speeds; shot
 * slots end ($0EA6, or $0EA8 with $1179 set); the start tune (sound 0)
 * with the reserve ships flying in -- one step every even frame, CWAI
 * per frame, until the tune ends ($6040 = 0; each frame also clears the
 * 56XX "credits used" nibble and writes $F to nibble 9) --; sound 5;
 * the player's ship; clear $0840-$085F; the demo input script ($AADA, or
 * $ACBC when stage_p1 is 2); game variables; then task_dispatch_sync
 * (the demo keeps dual_fighter, a game clears it).
 * @see gaplus-main.asm $CDA1
 * @param {Machine} m
 * @returns {Generator<symbol | undefined, void, unknown>}
 */
export function* lCDA1(m) {
  // $CDA1: lda attract_flag / bne / jsr clear_sprite_shadows
  m.charge(5); m.charge(3);
  if (m.peek(0x09f4) === 0) {
    m.charge(8);
    yield* call(MAIN.clear_sprite_shadows, m, {});
  }
  // $CDA9: lda flip_screen / bne $CDC7
  m.charge(5); m.charge(3);
  if (m.peek(0x102c) === 0) {
    yield* st(m, 0x1170, 0, 7);
    for (const [addr, v] of [[0xa000, 0xff], [0xa001, 0x87],
      [0xa003, 0x06], [0xa002, 0x85]]) {
      m.charge(2);
      yield* st(m, addr, v, 5);
    }
    m.charge(3);
  } else {
    for (const [addr, v] of [[0x1170, 0x02], [0xa000, 0xff],
      [0xa001, 0x87], [0xa003, 0x00], [0xa002, 0x81]]) {
      m.charge(2);
      yield* st(m, addr, v, 5);
    }
  }
  // $CDE0: player_step 2, player_speed 1, shot_speed 6
  for (const [addr, v] of [[0x10d1, 2], [0x1032, 1], [0x10d2, 6]]) {
    m.charge(2);
    yield* st(m, addr, v, 5);
  }
  // $CDEF: ldx #$0EA6 / lda $1179 / beq / ldx #$0EA8 / stx $10D3 / bra
  let x = 0x0ea6;
  m.charge(3); m.charge(5); m.charge(3);
  if (m.peek(0x1179) !== 0) {
    x = 0x0ea8;
    m.charge(3);
  }
  yield* st16(m, 0x10d3, x, 6);
  m.charge(3); m.charge(2);
  // $CE15: sound 0 (the start tune), the three flying-in ships
  yield* st(m, 0x6040, 0x01, 5);
  for (const [addr, v] of [[0x0f1e, 0x2703], [0x0f20, 0x3004],
    [0x0f22, 0x3703], [0x171e, 0xf84b], [0x1720, 0xf848],
    [0x1722, 0x7800]]) {
    m.charge(3);
    yield* st16(m, addr, v, 6);
  }
  m.charge(3);
  yield* st16(m, 0x1f1e, 0x4081, 6);
  yield* st16(m, 0x1f20, 0x4081, 6);
  m.charge(3);
  yield* st16(m, 0x1f22, 0x4080, 6);

  for (;;) {
    // $CE4D: lda frame_counter / anda #1 / bne $CE7F
    yield* busy(m, 0);
    const f = m.peek(0x1016);
    m.charge(5); m.charge(2); m.charge(3);
    if ((f & 0x01) === 0) yield* flyIn(m);
    // $CE7F: lda snd_request / beq $CE90
    yield* busy(m, 0);
    const s = m.peek(0x6040);
    m.charge(5); m.charge(3);
    if (s === 0) break;
    m.charge(16); // $CE84: cwai #$EF -- wait for vblank
    yield;
    // $CE86: clr $6803 (reads the 56XX first) / ldb #$0F / stb $6809
    yield* busy(m, 0);
    m.peek(0x6803);
    m.poke(0x6803, 0);
    m.charge(7); m.charge(2);
    yield* st(m, 0x6809, 0x0f, 5);
    m.charge(3);
  }
  yield* startTail(m);
}

/**
 * $CE54-$CE7C: one step of the flying-in ships: $171E counts down and
 * $1720 up to $78; then the 9-bit value in $1F23 bit 0 : $1723 is
 * advanced by one unless it is $A3 (a rotate pair, see below).
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
function* flyIn(m) {
  // $CE54: lda $171E / cmpa #$78 / beq / deca / sta $171E
  const a1 = m.peek(0x171e);
  m.charge(5); m.charge(2); m.charge(3);
  if (a1 !== 0x78) {
    m.charge(2);
    yield* st(m, 0x171e, a1 - 1, 5);
  }
  // $CE5F: lda $1720 / cmpa #$78 / beq / inca / sta $1720. The carry of
  // this CMPA (A < $78) is still there at the RORB below: neither INCA,
  // STA, LDA nor LDB touches C.
  const a2 = m.peek(0x1720);
  const c0 = a2 < 0x78 ? 1 : 0;
  m.charge(5); m.charge(2); m.charge(3);
  if (a2 !== 0x78) {
    m.charge(2);
    yield* st(m, 0x1720, a2 + 1, 5);
  }
  // $CE6A: lda $1723 / ldb $1F23 / rorb / rora / cmpa #$A3 / beq
  let a = m.peek(0x1723);
  let b = m.peek(0x1f23);
  const c1 = b & 1;
  b = (c0 << 7) | (b >> 1);
  a = (c1 << 7) | (a >> 1);
  m.charge(5); m.charge(5); m.charge(2); m.charge(2); m.charge(2); m.charge(3);
  if (a === 0xa3) return;
  // $CE76: inca / rola / rolb -- ROLA takes the carry of CMPA #$A3
  // (A < $A3), not the bit RORA shifted out: INCA leaves C alone.
  const cA = a < 0xa3 ? 1 : 0;
  a = (a + 1) & 0xff;
  const c3 = a >> 7;
  a = ((a << 1) | cA) & 0xff;
  b = ((b << 1) | c3) & 0xff;
  m.charge(2); m.charge(2); m.charge(2);
  yield* st(m, 0x1723, a, 5);
  yield* st(m, 0x1f23, b, 5);
}

/**
 * $CE90-$CF13: after the start tune.
 * @param {Machine} m
 * @returns {Generator<symbol | undefined, void, unknown>}
 */
function* startTail(m) {
  m.charge(2);
  yield* st(m, 0x6045, 0x01, 5); // sound 5
  yield* st(m, 0x1f1f, 0, 7);
  yield* st(m, 0x1f21, 0, 7);
  yield* st(m, 0x1f23, 0, 7);
  // $CE9E: lda $1178 / beq / ldd #$7E3F / bra (else ldd #$2E00)
  let d = 0x2e00;
  m.charge(5); m.charge(3);
  if (m.peek(0x1178) !== 0) {
    d = 0x7e3f;
    m.charge(3); m.charge(3);
  } else {
    m.charge(3);
  }
  yield* st16(m, 0x0e00, d, 6);
  m.charge(3);
  yield* st16(m, 0x1600, 0x7848, 6); // player_y / player_x
  m.charge(3);
  yield* st16(m, 0x1e00, 0x0081, 6);
  // $CEBA: ldb #$20 / ldx #$0840 / { clr ,x+ / decb / bne }
  m.charge(2); m.charge(3);
  for (let x = 0x0840; x < 0x0860; x += 1) {
    yield* st(m, x, 0, 8);
    m.charge(2); m.charge(3);
  }
  // $CEC4: ldx #$AADA / lda stage_p1 / suba #2 / bne / ldx #$ACBC
  let x = 0xaada;
  m.charge(3); m.charge(5); m.charge(2); m.charge(3);
  if (m.peek(0x1106) === 0x02) {
    x = 0xacbc;
    m.charge(3);
  }
  // $CED1: lda $0100,x / sta demo_timer / lda ,x / lsra / sta
  // demo_stick / leax 1,x / stx demo_ptr (the script: durations at
  // +$100, stick<<1 | fire bytes)
  m.charge(8);
  yield* st(m, 0x09f0, m.peek(x + 0x100), 5);
  m.charge(4); m.charge(2);
  yield* st(m, 0x09f1, m.peek(x) >> 1, 5);
  m.charge(5);
  yield* st16(m, 0x09f2, x + 1, 6);
  yield* st(m, 0x10da, 0, 7);
  yield* st(m, 0x10d0, 0, 7);
  m.charge(3);
  yield* st16(m, 0x1069, 0, 6);
  for (const v of [0x1177, 0x110f, 0x1110, 0x10e9, 0x1111, 0x10d9]) {
    yield* st(m, v, 0, 7);
  }
  m.charge(3);
  yield* st16(m, 0x0c00, 0x0a00, 6);
  // $CF07: lda attract_flag / lbne task_dispatch_sync / clr dual_fighter
  // / jmp task_dispatch_sync
  m.charge(5);
  if (m.peek(0x09f4) !== 0) {
    m.charge(6);
  } else {
    m.charge(5);
    yield* st(m, 0x10db, 0, 7);
    m.charge(4);
  }
  requestJump(m, TASK_DISPATCH_SYNC);
}

// ----------------------------------------------------------------- tasks
//
// Every task below runs while the sub CPU runs its own tasks on the same
// RAM, so each instruction that writes RAM or I/O, or reads RAM
// $0800-$1FFF, sound RAM or I/O, is preceded by a busy() point (rd, rd16,
// st, st16, rmw) at which m.charged[0] is the cycle it starts.

/**
 * $CF14 task_count_fighters: count the in-use entries among the flag
 * bytes $1EC3, $1EC5, ... $1ECD (the dual-fighter sprites) into $10DC,
 * and set the player's movement limits player_xmin/xmax ($1078/$1079)
 * from the table at $CF41 by that count (xmin 4 lower in the demo).
 * @see gaplus-main.asm $CF14
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* task_count_fighters(m) {
  let b = 0;
  m.charge(3); m.charge(2);
  for (let x = 0x1ec3; ; x += 2) {
    m.charge(4); m.charge(3); // cmpx #$1ECF / beq
    if (x === 0x1ecf) break;
    const f = yield* rd(m, x, 7); // lda ,x++
    m.charge(2); m.charge(3); // anda #$80 / beq
    if (f & 0x80) {
      b = (b + 1) & 0xff;
      m.charge(2); m.charge(3);
    }
  }
  // $CF27: stb <$DC / aslb / ldx #$CF41 / ldd b,x (ROM) / std <$78
  yield* st(m, 0x10dc, b, 4);
  m.charge(2); m.charge(3); m.charge(6);
  yield* st16(m, 0x1078, m.peek16(disp8(0xcf41, (b << 1) & 0xff)), 5);
  // $CF31: lda attract_flag / beq / lda <$78 / suba #4 / sta <$78
  const af = yield* rd(m, 0x09f4, 5);
  m.charge(3);
  if (af !== 0) {
    const v = yield* rd(m, 0x1078, 4);
    m.charge(2);
    yield* st(m, 0x1078, v - 4, 4);
  }
  yield* rmw(m, 0x1030, inc, 6); // $CF3C: inc <main_task / jmp
  m.charge(4);
}

/**
 * $CF4F task_move_player: unless $10D9 is set, move the player's ship
 * from a stick: the 56XX P1 nibble $6804 (P2's $6806 when the screen is
 * flipped), or in the demo the scripted stick (demo_input). Bit 1 moves
 * player_y ($1600) up by player_step to player_xmax, bit 3 down to
 * player_xmin (the listing's "x" names are the screen's); unless $1111
 * is set, bit 0 / bit 2 move player_x ($1601) by player_speed, stopping
 * at $C8 / $49, with the carry going into $1E01 (bit 8 of X). Then with
 * the dual fighter the five wing sprites follow at +$10/+$20/+$30 and
 * -$30/-$40/-$50, and their flag bytes $1EC3-$1ECD get $1E01's X bit.
 * @see gaplus-main.asm $CF4F
 * @param {Machine} m
 * @returns {Generator<symbol | undefined, void, unknown>}
 */
export function* task_move_player(m) {
  // $CF4F: lda <$D9 / bne $CFC2
  const d9 = yield* rd(m, 0x10d9, 4);
  m.charge(3);
  if (d9 === 0) {
    // $CF53: lda attract_flag / lbne demo_input
    const af = yield* rd(m, 0x09f4, 5);
    if (af !== 0) {
      m.charge(6);
      const u = yield* demoInput(m);
      if (u === null) {
        yield* lD029(m);
        return;
      }
      yield* moveShip(m, u);
    } else {
      // $CF5A: ldu #$6804 / ldb <$2C / beq / ldu #$6806
      let u = 0x6804;
      m.charge(5); m.charge(3);
      const fl = yield* rd(m, 0x102c, 4);
      m.charge(3);
      if (fl !== 0) {
        u = 0x6806;
        m.charge(3);
      }
      yield* moveShip(m, u);
    }
  }
  yield* wingFollow(m);
}

/**
 * $CF64-$CFBF: move the ship by the stick byte at U (see
 * task_move_player). Falls into $CFC2.
 * @param {Machine} m @param {number} u
 * @returns {Generator<symbol, void, unknown>}
 */
function* moveShip(m, u) {
  // $CF64: ldb player_y / lda ,u / anda #2 / bne $CF99
  let b = yield* rd(m, 0x1600, 5);
  const s1 = yield* rd(m, u, 4);
  m.charge(2); m.charge(3);
  if (s1 & 0x02) {
    // $CF99: cmpb <$79 / bcc $CF73 / addb <$D1 / stb player_y / bra
    const hi = yield* rd(m, 0x1079, 4);
    m.charge(3);
    if (b < hi) {
      const step = yield* rd(m, 0x10d1, 4);
      yield* st(m, 0x1600, b + step, 5);
      m.charge(3);
    }
  } else {
    // $CF6D: lda ,u / anda #8 / bne $CF8E
    const s2 = yield* rd(m, u, 4);
    m.charge(2); m.charge(3);
    if (s2 & 0x08) {
      // $CF8E: cmpb <$78 / bcs $CF73 / subb <$D1 / stb player_y / bra
      const lo = yield* rd(m, 0x1078, 4);
      m.charge(3);
      if (b >= lo) {
        const step = yield* rd(m, 0x10d1, 4);
        yield* st(m, 0x1600, b - step, 5);
        m.charge(3);
      }
    }
  }
  // $CF73: lda $1111 / bne $CFC2
  const lock = yield* rd(m, 0x1111, 5);
  m.charge(3);
  if (lock !== 0) return;
  // $CF78: ldb player_x / lda ,u / anda #1 / bne $CFA4
  b = yield* rd(m, 0x1601, 5);
  const s3 = yield* rd(m, u, 4);
  m.charge(2); m.charge(3);
  if (s3 & 0x01) {
    // $CFA4: cmpb #$C8 / beq / subb <$32 / stb player_x / bcc /
    // dec $1E01 / bra
    m.charge(2); m.charge(3);
    if (b === 0xc8) return;
    const sp = yield* rd(m, 0x1032, 4);
    const r = b - sp;
    yield* st(m, 0x1601, r, 5);
    m.charge(3);
    if (r < 0) {
      yield* rmw(m, 0x1e01, (v) => v - 1, 7);
      m.charge(3);
    }
    return;
  }
  // $CF81: lda ,u / anda #4 / bne $CFB4 / bra $CFC2
  const s4 = yield* rd(m, u, 4);
  m.charge(2); m.charge(3);
  if ((s4 & 0x04) === 0) {
    m.charge(3);
    return;
  }
  // $CFB4: cmpb #$49 / beq / addb <$32 / stb player_x / bcc / inc $1E01
  m.charge(2); m.charge(3);
  if (b === 0x49) return;
  const sp = yield* rd(m, 0x1032, 4);
  const r = b + sp;
  yield* st(m, 0x1601, r, 5);
  m.charge(3);
  if (r > 0xff) yield* rmw(m, 0x1e01, inc, 7);
}

/**
 * $CFC2-$CFFE, then $CF89 (inc <main_task / jmp task_dispatch).
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
function* wingFollow(m) {
  // $CFC2: lda <dual_fighter / beq $CF89
  const df = yield* rd(m, 0x10db, 4);
  m.charge(3);
  if (df !== 0) {
    // $CFC6: ldd player_y, then adda/suba and std to the wing entries
    const d = yield* rd16(m, 0x1600, 6);
    let a = d >> 8;
    const b = d & 0xff;
    for (const [delta, addr] of [[0x10, 0x16c2], [0x10, 0x16c6],
      [0x10, 0x16ca], [-0x40, 0x16c4], [-0x10, 0x16c8], [-0x10, 0x16cc]]) {
      a = (a + delta) & 0xff;
      m.charge(2);
      yield* st16(m, addr, (a << 8) | b, 6);
    }
    // $CFE7: ldx #$1EC3 / { ldb $1E01 / andb #$7F / lda ,x / anda #$80 /
    // sta ,x / orb ,x / stb ,x++ / cmpx #$1ECF / bne } / bra $CF89
    m.charge(3);
    for (let x = 0x1ec3; x !== 0x1ecf; x += 2) {
      const xb = (yield* rd(m, 0x1e01, 5)) & 0x7f;
      m.charge(2);
      const f = (yield* rd(m, x, 4)) & 0x80;
      m.charge(2);
      yield* st(m, x, f, 4);
      const o = yield* rd(m, x, 4);
      yield* st(m, x, xb | o, 7);
      m.charge(4); m.charge(3);
    }
    m.charge(3);
  }
  yield* rmw(m, 0x1030, inc, 6); // $CF89: inc <main_task / jmp
  m.charge(4);
}

/**
 * $D000 demo_input as the port uses it: step the demo script. Returns
 * the stick byte's address ($09F1, where the ROM continues at lCF64), or
 * null when the script ended (duration byte $F0: the ROM goes to lD029).
 * @param {Machine} m
 * @returns {Generator<symbol, number | null, unknown>}
 */
function* demoInput(m) {
  // $D000: dec demo_timer / bne $D023
  const t = yield* rmw(m, 0x09f0, (v) => v - 1, 7);
  m.charge(3);
  if (t === 0) {
    // $D005: ldu demo_ptr / lda $0100,u / sta demo_timer / cmpa #$F0 /
    // beq lD029
    let u = yield* rd16(m, 0x09f2, 6);
    const d = yield* rd(m, u + 0x100, 8);
    yield* st(m, 0x09f0, d, 5);
    m.charge(2); m.charge(3);
    if (d === 0xf0) return null;
    // $D013: lda ,u / ldb ,u+ / stu demo_ptr / rora / sta demo_stick /
    // andb #1 / stb demo_fire. RORA shifts in the carry of CMPA #$F0
    // (duration < $F0), so bit 7 of the stick byte is that carry.
    const s = yield* rd(m, u, 4);
    const sb = yield* rd(m, u, 6);
    u = (u + 1) & 0xffff;
    yield* st16(m, 0x09f2, u, 6);
    m.charge(2);
    yield* st(m, 0x09f1, (d < 0xf0 ? 0x80 : 0) | (s >> 1), 5);
    m.charge(2);
    yield* st(m, 0x09f5, sb & 0x01, 5);
  }
  m.charge(3); m.charge(4); // $D023: ldu #demo_stick / jmp $CF64
  return 0x09f1;
}

/**
 * $D000 demo_input: the demo's stick. Entered only by task_move_player's
 * `lbne` ($CF56), and continues in it (lCF64), so as an entry point it
 * runs the rest of task_move_player: it steps the recorded script
 * ($09F0 duration, $09F2 pointer; bytes are stick << 1 | fire, the
 * durations $100 further on) and moves the ship by it; at the end
 * marker ($F0) it stops the demo (lD029).
 * @see gaplus-main.asm $D000
 * @param {Machine} m
 * @returns {Generator<symbol | undefined, void, unknown>}
 */
export function* demo_input(m) {
  const u = yield* demoInput(m);
  if (u === null) {
    yield* lD029(m);
    return;
  }
  yield* moveShip(m, u);
  yield* wingFollow(m);
}

/**
 * $D029 lD029: end of the demo (also jumped to from $E3F8, gp2-2b):
 * attract timer $1029/$102A = $E0/$FF, clear the sprite shadows and all
 * sounds, the player and reserve-ship flags, the schedulers ($1030,
 * $107A, $102F), and go back to attract_loop (requestJump: the stack is
 * abandoned).
 * @see gaplus-main.asm $D029
 * @param {Machine} m
 * @returns {Generator<symbol | undefined, void, unknown>}
 */
export function* lD029(m) {
  m.charge(3);
  yield* st16(m, 0x1029, 0xe0ff, 5);
  m.charge(8);
  yield* call(MAIN.clear_sprite_shadows, m, {});
  m.charge(8);
  yield* call(MAIN.sound_all_off, m, {});
  for (const v of [0x1e01, 0x1f17, 0x1f19, 0x1f1b, 0x1f1d]) {
    yield* rmw(m, v, zero, 7);
  }
  for (const v of [0x1030, 0x107a, 0x102f]) {
    yield* rmw(m, v, zero, 6);
  }
  m.charge(4);
  requestJump(m, ATTRACT_LOOP);
}

/**
 * $D150 task_end_frame: the last task of every list. CWAI (wait for the
 * vblank IRQ), reset the stack, main_task = 0 and back to the dispatcher,
 * which starts the list again.
 * @see gaplus-main.asm $D150
 * @param {Machine} m
 * @returns {Generator<symbol | undefined, void, unknown>}
 */
export function* task_end_frame(m) {
  m.charge(16); // $D150: cwai #$EF -- wait for vblank
  yield;
  m.charge(4); // lds #$1600
  yield* rmw(m, 0x1030, zero, 6); // clr <main_task / jmp task_dispatch
  m.charge(4);
}

/**
 * $D15B task_next_mode: end of mode 0: clear $10C1 and frame_counter,
 * wait for the next frame, game_mode + 1, main_task = 0.
 * @see gaplus-main.asm $D15B
 * @param {Machine} m
 * @returns {Generator<symbol | undefined, void, unknown>}
 */
export function* task_next_mode(m) {
  yield* rmw(m, 0x10c1, zero, 6);
  yield* rmw(m, 0x1016, zero, 6);
  m.charge(16); // cwai #$EF -- wait for vblank
  yield;
  yield* rmw(m, 0x102f, inc, 6);
  yield* rmw(m, 0x1030, zero, 6);
  m.charge(4);
}

/**
 * $D168 task_player_fire: on a fire-button press (56XX nibble 5 bit 1,
 * P2's nibble 7 when flipped; fire_held $1019 makes it an edge), or the
 * demo script's fire ($09F5), and unless $10E9 blocks it: put a shot in
 * the first free slot of $0EA2.. before shot_slots_end ($10D3) at the
 * player's position with $1E01's flags, request the shot sound (1, or 7
 * when $0EA2 is not the single-shot code $2F), set $1E01 bit 7 and the
 * player's sprite code at $0E00 ($2E00 when $0F16 is $26, else $7E3F).
 * @see gaplus-main.asm $D168
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* task_player_fire(m) {
  // $D168: lda attract_flag / bne $D1C6
  const af = yield* rd(m, 0x09f4, 5);
  m.charge(3);
  let fire = false;
  if (af !== 0) {
    // $D1C6: lda demo_fire / beq $D1C1 / clr demo_fire / bra $D18D
    const df = yield* rd(m, 0x09f5, 5);
    m.charge(3);
    if (df !== 0) {
      yield* rmw(m, 0x09f5, zero, 7);
      m.charge(3);
      fire = true;
    }
  } else {
    // $D16D: lda <$E9 / bne $D1C1
    const e9 = yield* rd(m, 0x10e9, 4);
    m.charge(3);
    if (e9 === 0) {
      // $D171: ldu #$6805 / lda <$2C / beq / ldu #$6807
      let u = 0x6805;
      m.charge(3);
      const fl = yield* rd(m, 0x102c, 4);
      m.charge(3);
      if (fl !== 0) {
        u = 0x6807;
        m.charge(3);
      }
      // $D17B: lda <fire_held / beq $D187
      const held = yield* rd(m, 0x1019, 4);
      m.charge(3);
      if (held !== 0) {
        // lda ,u / anda #2 / sta <fire_held / bra $D1C1
        const v = yield* rd(m, u, 4);
        m.charge(2);
        yield* st(m, 0x1019, v & 0x02, 4);
        m.charge(3);
      } else {
        // $D187: lda ,u / anda #2 / beq $D1C1
        const v = yield* rd(m, u, 4);
        m.charge(2); m.charge(3);
        fire = (v & 0x02) !== 0;
      }
    }
  }
  if (fire) yield* fireShot(m);
  yield* rmw(m, 0x1030, inc, 6); // $D1C1: inc <main_task / jmp
  m.charge(4);
}

/**
 * $D18D-$D1BE and $DFD0-$DFEE: find a free shot slot and fire.
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
function* fireShot(m) {
  // $D18D: ldx #$0EA0 / { leax 2,x / cmpx <$D3 / beq $D1C1 /
  // lda $1001,x / anda #$80 / bne }
  let x = 0x0ea0;
  m.charge(3);
  for (;;) {
    x = (x + 2) & 0xffff;
    m.charge(5);
    const end = yield* rd16(m, 0x10d3, 6);
    m.charge(3);
    if (x === end) return;
    const f = yield* rd(m, x + 0x1001, 8);
    m.charge(2); m.charge(3);
    if ((f & 0x80) === 0) break;
  }
  // $D19E: ldd player_y / std $0800,x / lda $1E01 / sta $1001,x /
  // inc <fire_held
  const d = yield* rd16(m, 0x1600, 6);
  yield* st16(m, x + 0x0800, d, 9);
  const fl = yield* rd(m, 0x1e01, 5);
  yield* st(m, x + 0x1001, fl, 8);
  yield* rmw(m, 0x1019, inc, 6);
  // $D1AE: lda $0EA2 / cmpa #$2F / bne / inc $6041 / bra (else nop /
  // inc $6047)
  const code = yield* rd(m, 0x0ea2, 5);
  m.charge(2); m.charge(3);
  if (code === 0x2f) {
    yield* rmw(m, 0x6041, inc, 7);
    m.charge(3);
  } else {
    m.charge(2);
    yield* rmw(m, 0x6047, inc, 7);
  }
  // $D1BE: jmp $DFD0 / lda $1E01 / ora #$80 / sta $1E01 / lda $0F16 /
  // suba #$26 / beq / ldd #$7E3F (else #$2E00) / std $0E00 / jmp $D1C1
  m.charge(4);
  const v = yield* rd(m, 0x1e01, 5);
  m.charge(2);
  yield* st(m, 0x1e01, v | 0x80, 5);
  const r = yield* rd(m, 0x0f16, 5);
  m.charge(2); m.charge(3); m.charge(3);
  yield* st16(m, 0x0e00, r === 0x26 ? 0x2e00 : 0x7e3f, 6);
  m.charge(4);
}

/**
 * $D1D0 task_move_shots: move every active shot ($16A3-$16C1 odd
 * entries' Y, active when $0800,x bit 7) up by shot_speed; one that
 * leaves the top (borrow) gets $0800,x = $80. Then clear $0800,x of
 * those with bit 0 clear and Y < $40. With $1177 set, the two shot
 * slots follow the player's Y.
 * @see gaplus-main.asm $D1D0
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* task_move_shots(m) {
  m.charge(3);
  for (let x = 0x16a3; ; x += 2) {
    m.charge(5); m.charge(4); m.charge(3); // leax 2,x / cmpx #$16C3 / beq
    if (x === 0x16c3) break;
    const f = yield* rd(m, x + 0x800, 8); // lda $0800,x
    m.charge(2); m.charge(3); // anda #$80 / beq
    if ((f & 0x80) === 0) continue;
    // lda ,x / suba <$D2 / sta ,x / bcc / lda #$80 / sta $0800,x / bra
    const y = yield* rd(m, x, 4);
    const s = yield* rd(m, 0x10d2, 4);
    yield* st(m, x, y - s, 4);
    m.charge(3);
    if (y < s) {
      m.charge(2);
      yield* st(m, x + 0x800, 0x80, 8);
      m.charge(3);
    }
  }
  m.charge(3);
  for (let x = 0x16a3; ; x += 2) {
    m.charge(5); m.charge(4); m.charge(3);
    if (x === 0x16c3) break;
    // lda $0800,x / anda #1 / bne / lda ,x / cmpa #$40 / bcc /
    // clr $0800,x / bra
    const f = yield* rd(m, x + 0x800, 8);
    m.charge(2); m.charge(3);
    if (f & 0x01) continue;
    const y = yield* rd(m, x, 4);
    m.charge(2); m.charge(3);
    if (y >= 0x40) continue;
    yield* rmw(m, x + 0x800, zero, 10);
    m.charge(3);
  }
  // $D210: lda $1177 / beq / lda player_y / sta $16A2 / sta $16A4
  const f = yield* rd(m, 0x1177, 5);
  m.charge(3);
  if (f !== 0) {
    const y = yield* rd(m, 0x1600, 5);
    yield* st(m, 0x16a2, y, 5);
    yield* st(m, 0x16a4, y, 5);
  }
  yield* rmw(m, 0x1030, inc, 6);
  m.charge(4);
}

/**
 * $D223 sub_D223: with the dual fighter, clear the flag bytes $1EAB-
 * $1EC1, then for each active shot in slots $0EA2/$0EA4 make $10DC
 * copies of it from $0EAA up (U runs on across both slots), the n-th
 * copy's Y offset by dat_D283[n] (B counts down from $10DC; `adda b,x`
 * is a signed offset).
 * @see gaplus-main.asm $D223
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* sub_D223(m) {
  const df = yield* rd(m, 0x10db, 4);
  m.charge(3);
  if (df !== 0) {
    m.charge(3);
    for (let x = 0x1eab; x !== 0x1ec3; x += 2) {
      yield* rmw(m, x, zero, 9); // clr ,x++
      m.charge(4); m.charge(3);
    }
    let u = 0x0eaa;
    m.charge(3); m.charge(4);
    for (let y = 0x0ea2; ; y += 2) {
      m.charge(5); m.charge(5); m.charge(3); // leay 2,y / cmpy #$0EA6 / beq
      if (y === 0x0ea6) break;
      const f = yield* rd(m, y + 0x1001, 8);
      m.charge(2); m.charge(3);
      if ((f & 0x80) === 0) continue;
      let b = yield* rd(m, 0x10dc, 4);
      m.charge(3);
      if (b === 0) continue;
      do {
        const w = (o) => (u + o) & 0xffff;
        yield* st(m, w(0x1001), yield* rd(m, y + 0x1001, 8), 8);
        yield* st(m, w(0x1000), yield* rd(m, y + 0x1000, 8), 8);
        yield* st(m, w(0x0801), yield* rd(m, y + 0x0801, 8), 8);
        // lda $0800,y / ldx #$D283 / adda b,x (ROM) / sta $0800,u
        let a = yield* rd(m, y + 0x0800, 8);
        m.charge(3);
        a += m.peek(disp8(0xd283, b));
        m.charge(5);
        yield* st(m, w(0x0800), a, 8);
        yield* st(m, w(1), yield* rd(m, y + 1, 5), 5);
        yield* st(m, u, yield* rd(m, y, 4), 7);
        u = (u + 2) & 0xffff;
        b = (b - 1) & 0xff;
        m.charge(2); m.charge(3);
      } while (b !== 0);
      m.charge(3); // bra $D238
    }
  }
  yield* rmw(m, 0x1030, inc, 6); // $D27E: inc <$30 / lbra
  m.charge(5);
}

/**
 * $D8B0 sub_D8B0: unless $10FE is set, pass on sound requests queued in
 * $0840-$087F: each non-zero byte is cleared and its request $6040+n set
 * to 1. With $10FE set, clear every request and state byte $6040-$607F
 * except $6054/$6074 (sound $14) and $6056/$6076 (the coin sound).
 * @see gaplus-main.asm $D8B0
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* sub_D8B0(m) {
  const fe = yield* rd(m, 0x10fe, 4);
  m.charge(3);
  if (fe === 0) {
    m.charge(3); m.charge(3); m.charge(2);
    for (let i = 0; i < 0x40; i += 1) {
      // lda ,x+ / bne $D8CA / lda ,u+ (else clr -1,x / lda #1 /
      // sta ,u+ / bra) / decb / bne
      const q = yield* rd(m, 0x0840 + i, 6);
      m.charge(3);
      if (q !== 0) {
        yield* rmw(m, 0x0840 + i, zero, 7);
        m.charge(2);
        yield* st(m, 0x6040 + i, 1, 6);
        m.charge(3);
      } else {
        yield* rd(m, 0x6040 + i, 6);
      }
      m.charge(2); m.charge(3);
    }
  } else {
    m.charge(3); m.charge(2);
    for (let x = 0x6040; x !== 0x6080; x += 1) {
      // cmpx #$6054 / #$6074 / #$6056 / #$6076 (each 4 + beq 3)
      const skip = [0x6054, 0x6074, 0x6056, 0x6076].indexOf(x);
      m.charge(7 * (skip < 0 ? 4 : skip + 1));
      if (skip < 0) yield* st(m, x, 0, 4);
      m.charge(5); m.charge(4); m.charge(3); // leax 1,x / cmpx #$6080 / bne
    }
  }
  yield* rmw(m, 0x1030, inc, 6);
  m.charge(4);
}

/**
 * $D8F8 sub_D8F8: $10DD/$10DE = the word at dat_D907 + 2 x $10DC (the
 * formation's offsets for the number of fighters; `ldd a,x` signed).
 * @see gaplus-main.asm $D8F8
 * @param {Machine} m
 * @returns {Generator<symbol, void, unknown>}
 */
export function* sub_D8F8(m) {
  const n = yield* rd(m, 0x10dc, 4);
  m.charge(2); m.charge(3); m.charge(6); // asla / ldx #$D907 / ldd a,x (ROM)
  yield* st16(m, 0x10dd, m.peek16(disp8(0xd907, (n << 1) & 0xff)), 5);
  yield* rmw(m, 0x1030, inc, 6);
  m.charge(5);
}

/**
 * Every routine of this file by entry address (registered by gp2_3b.js).
 * @type {Record<number, Function>}
 */
export const ROUTINES = {
  0xccd0: start_game_1p,
  0xcdff: start_game_2p,
  0xcda1: lCDA1,
  0xcf14: task_count_fighters,
  0xcf4f: task_move_player,
  0xd000: demo_input,
  0xd029: lD029,
  0xd150: task_end_frame,
  0xd15b: task_next_mode,
  0xd168: task_player_fire,
  0xd1d0: task_move_shots,
  0xd223: sub_D223,
  0xd8b0: sub_D8B0,
  0xd8f8: sub_D8F8,
};

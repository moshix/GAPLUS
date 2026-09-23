// Copyright 2026 by Moshix
/**
 * Main CPU ROM gp2-3b.8c, $D915-$DF18: the player hit check and the web
 * of blocks behind it -- the player's death, the "PLAYER n / GAME OVER"
 * messages, the switch between players in a two-player game (saving and
 * restoring each player's formation), game over and the return to
 * attract mode.
 *
 *   $D915  task_player_hit_check  mode 3/5 task: the hit test itself
 *   $D9CF  lD9CF      (from $F8D2) reset the fighter, lose a life
 *   $DA87  lDA87      (from $FC7D/$FC9F, and $DA63) game over: clear
 *                     everything, back to attract_loop
 *   $DBE2  lDBE2      (from $B301) after the name entry, P1: "1" ...
 *   $DC0B  lDC0B      (from $B2F6) ... P2: "2", then the death sequence
 *   $DC1C  sub_DC1C   print a string with attribute B, going right
 *   $DEC1  sub_DEC1   count the P1 game time into a histogram
 *
 * FLOW. The 6809 code is one tangle of JMPs between labelled blocks.
 * The port keeps the blocks and the jumps: `flow()` is a generator that
 * runs block after block, each case of its switch being one block of the
 * listing and each `pc = ...; continue` one JMP/branch between blocks.
 * Blocks end in one of three ways:
 *   - `jmp task_dispatch` ($FEB5): return (the dispatcher loop goes on);
 *   - `jmp attract_loop` ($DAE7) / `jmp lCDA1` ($DB8E, into
 *     start_game_1p): requestJump() and return (see gp2_3b_state.js);
 *   - CWAI #$EF: charged (16 cycles), then a plain `yield`.
 *
 * CYCLES AND SYNC POINTS. Every instruction is charged with
 * Machine.charge, in program order (callees charge their own). Right
 * before every instruction that writes RAM or I/O, or reads RAM
 * $0800-$1FFF, sound RAM or I/O, the code yields SYNC (busy(m, 0)) with
 * m.charged[0] = the cycle that instruction starts, so the scheduler can
 * order the access against the sub CPU. The small helpers rd / wr / wr16
 * / clr below do exactly "sync, access, charge".
 * @see reference/gaplus-main.asm $D915-$DF18
 */

import { MAIN } from './routines.js';
import { call } from '../call.js';
import { add8, daa } from '../m6809ops.js';
import { busy, requestJump } from './gp2_3b_state.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {Generator<unknown, void, unknown>} Gen */

/** $C417 attract_loop. */
const ATTRACT_LOOP = 0xc417;
/** $CDA1 inside start_game_1p (the second player's first start). */
const START_P2 = 0xcda1;

/**
 * Does a read of `addr` need a sync point (shared RAM or I/O)?
 * @param {number} addr @returns {boolean}
 */
const shared = (addr) => (addr >= 0x0800 && addr < 0x2000)
  || (addr >= 0x6000 && addr < 0x6830);

/**
 * One reading instruction of `cyc` cycles: sync if shared, read, charge.
 * @param {Machine} m @param {number} addr @param {number} cyc
 * @returns {Generator<unknown, number, unknown>}
 */
function* rd(m, addr, cyc) {
  if (shared(addr)) yield* busy(m, 0);
  const v = m.peek(addr);
  m.charge(cyc);
  return v;
}

/**
 * A 16-bit read (LDD): sync if shared, read, charge.
 * @param {Machine} m @param {number} addr @param {number} cyc
 * @returns {Generator<unknown, number, unknown>}
 */
function* rd16(m, addr, cyc) {
  if (shared(addr)) yield* busy(m, 0);
  const v = m.peek16(addr);
  m.charge(cyc);
  return v;
}

/**
 * One writing instruction: sync, write, charge.
 * @param {Machine} m @param {number} addr @param {number} v
 * @param {number} cyc @returns {Gen}
 */
function* wr(m, addr, v, cyc) {
  yield* busy(m, 0);
  m.poke(addr, v);
  m.charge(cyc);
}

/**
 * STD: sync, write the word (high byte first), charge.
 * @param {Machine} m @param {number} addr @param {number} v
 * @param {number} cyc @returns {Gen}
 */
function* wr16(m, addr, v, cyc) {
  yield* busy(m, 0);
  m.poke16(addr, v);
  m.charge(cyc);
}

/**
 * CLR (read-modify-write; the read of RAM is harmless): sync, write 0.
 * @param {Machine} m @param {number} addr @param {number} cyc
 * @returns {Gen}
 */
function* clr(m, addr, cyc) {
  yield* busy(m, 0);
  m.poke(addr, 0);
  m.charge(cyc);
}

/**
 * INC / DEC of memory: sync, read, write, charge.
 * @param {Machine} m @param {number} addr @param {number} d +1 / -1
 * @param {number} cyc
 * @returns {Generator<unknown, number, unknown>} the new value
 */
function* rmw(m, addr, d, cyc) {
  yield* busy(m, 0);
  const v = (m.peek(addr) + d) & 0xff;
  m.poke(addr, v);
  m.charge(cyc);
  return v;
}

/**
 * CLR of each [address, cycles] in turn.
 * @param {Machine} m @param {Array<[number, number]>} list
 * @returns {Gen}
 */
function* clrAll(m, list) {
  for (const [addr, cyc] of list) yield* clr(m, addr, cyc);
}

/**
 * $DC1C sub_DC1C: print the zero-terminated string at U from tile X going
 * right (X -= $20 per character), each character's attribute = B.
 * @see gaplus-main.asm $DC1C
 * @param {Machine} m
 * @param {{ x: number, u: number, b: number }} regs
 * @returns {Generator<unknown, { x: number, u: number, a: number },
 *   unknown>}
 */
export function* sub_DC1C(m, { x, u, b }) {
  for (;;) {
    // lda ,u+ (the strings are in ROM) / beq rts
    const a = m.read('main', u);
    u = (u + 1) & 0xffff;
    m.charge(6); m.charge(3);
    if (a === 0) {
      m.charge(5);
      return { x, u, a };
    }
    // sta ,x / stb $0400,x / leax -$20,x / bra
    yield* wr(m, x, a, 4);
    yield* wr(m, (x + 0x400) & 0xffff, b, 8);
    x = (x - 0x20) & 0xffff;
    m.charge(5); m.charge(3);
  }
}

/**
 * $DEC1 sub_DEC1: if player 1 has played at least a second this game
 * ($09FD), add one (BCD) to the stats counter $09D6+i for his time in
 * minutes ($09FE): i = 0..6 for 0..6 minutes, 7 for 7-9, 8 for 10-14, 9
 * for 15-24, 10 ($09E0, one past stats_counters) for 25 and more. Then
 * clear the P1 time.
 * @see gaplus-main.asm $DEC1
 * @param {Machine} m
 * @returns {Gen}
 */
export function* sub_DEC1(m) {
  // lda $09FD / beq rts
  const s = yield* rd(m, 0x09fd, 5);
  m.charge(3);
  if (s !== 0) {
    // ldx #$09D6 / lda $09FE, then `suba #n / bcs $DF08 / leax 1,x`
    m.charge(3);
    let a = yield* rd(m, 0x09fe, 5);
    let x = 0x09d6;
    for (const n of [1, 1, 1, 1, 1, 1, 1, 3, 5, 10]) {
      m.charge(2); m.charge(3);
      if (a < n) break;
      a -= n;
      x += 1;
      m.charge(5);
    }
    // $DF08: lda ,x / adda #1 / daa / sta ,x / clr $09FE / $09FD / $09FC
    const r = add8(yield* rd(m, x, 4), 1);
    m.charge(2); m.charge(2);
    yield* wr(m, x, daa(r.v, r.cc).v, 4);
    yield* clrAll(m, [[0x09fe, 7], [0x09fd, 7], [0x09fc, 7]]);
  }
  m.charge(5);
}

/**
 * One hit test ($D95E-$D97A and $D9A2-$D9BE): the entry at X (flag byte
 * $1001,x bit 0 = X bit 8, $0801,x X low, $0800,x Y) inside the box
 * $10C6-$10C9? `lsrb / rora` turns the 9-bit X into X/2.
 * @param {Machine} m @param {number} x
 * @returns {Generator<unknown, boolean, unknown>}
 */
function* inBox(m, x) {
  const b = yield* rd(m, x + 0x1001, 8);
  const lo = yield* rd(m, x + 0x0801, 8);
  const a = (lo >> 1) | ((b & 1) << 7);
  m.charge(2); m.charge(2);
  // cmpa <$C8 / bcs / cmpa <$C9 / bcc
  const xmin = yield* rd(m, 0x10c8, 4);
  m.charge(3);
  if (a < xmin) return false;
  const xmax = yield* rd(m, 0x10c9, 4);
  m.charge(3);
  if (a >= xmax) return false;
  // lda $0800,x / cmpa <$C6 / bcs / cmpa <$C7 / bcc
  const y = yield* rd(m, x + 0x0800, 8);
  const ymin = yield* rd(m, 0x10c6, 4);
  m.charge(3);
  if (y < ymin) return false;
  const ymax = yield* rd(m, 0x10c7, 4);
  m.charge(3);
  return y < ymax;
}

/**
 * The hit: `inc $6829` (62XX: explosion sample) / `inc $682A` /
 * `lda #1 / sta $110F`.
 * @param {Machine} m @returns {Gen}
 */
function* hit(m) {
  yield* rmw(m, 0x6829, 1, 7);
  yield* rmw(m, 0x682a, 1, 7);
  m.charge(2);
  yield* wr(m, 0x110f, 1, 5);
}

/**
 * Save the formation's occupied bits: `ldx #$1860 / ldu #dst`, then 23 x
 * `ldd ,x++ / anda #1 / andb #1 / std ,u++ / cmpx #$188E / bne`
 * ($1860-$188D, bit 0 only).
 * @param {Machine} m @param {number} dst @returns {Gen}
 */
function* saveFormation(m, dst) {
  m.charge(3); m.charge(3);
  for (let i = 0; i < 0x2e; i += 2) {
    const d = (yield* rd16(m, 0x1860 + i, 8)) & 0x0101;
    m.charge(2); m.charge(2);
    yield* wr16(m, dst + i, d, 8);
    m.charge(4); m.charge(3);
  }
}

/**
 * Restore it: `ldx #$1860 / ldu #src`, 23 x `ldd ,u++ / std ,x++ / cmpx
 * #$188E / bne`.
 * @param {Machine} m @param {number} src @returns {Gen}
 */
function* restoreFormation(m, src) {
  m.charge(3); m.charge(3);
  for (let i = 0; i < 0x2e; i += 2) {
    const d = yield* rd16(m, src + i, 8);
    yield* wr16(m, 0x1860 + i, d, 8);
    m.charge(4); m.charge(3);
  }
}

/**
 * `lda $112B / sta dst / lda $0E85 / sta dst+1`: the other per-player
 * bytes saved with the formation.
 * @param {Machine} m @param {number} dst @returns {Gen}
 */
function* saveExtra(m, dst) {
  yield* wr(m, dst, yield* rd(m, 0x112b, 5), 5);
  yield* wr(m, dst + 1, yield* rd(m, 0x0e85, 5), 5);
}

/**
 * `lda src / sta $112B / lda src+1 / sta $0E85 / sta $0E2D`.
 * @param {Machine} m @param {number} src @returns {Gen}
 */
function* restoreExtra(m, src) {
  yield* wr(m, 0x112b, yield* rd(m, src, 5), 5);
  const a = yield* rd(m, src + 1, 5);
  yield* wr(m, 0x0e85, a, 5);
  yield* wr(m, 0x0e2d, a, 5);
}

/**
 * Put the reserve-ship markers up: `lda #4 / ldx #$1F17 / {clr ,x++ /
 * deca / bne}`, then B = lives - 1 (`decb / lbeq target`); unless that
 * is 0, at most 4 (`cmpb #5 / bcs / ldb #4`; lives 0 gives $FF -> 4)
 * entries `$81` from $1F17 (`sta ,x++ / decb / bne`).
 * @param {Machine} m @param {number} lives address of the lives count
 * @returns {Generator<unknown, boolean, unknown>} true when lives - 1
 *   was 0 (the lbeq was taken)
 */
function* reserveShips(m, lives) {
  m.charge(2); m.charge(3);
  for (let i = 0; i < 4; i += 1) {
    yield* clr(m, 0x1f17 + i * 2, 9);
    m.charge(2); m.charge(3);
  }
  // ldb lives / decb / lbeq
  let b = ((yield* rd(m, lives, 5)) - 1) & 0xff;
  m.charge(2);
  if (b === 0) {
    m.charge(6);
    return true;
  }
  m.charge(5); m.charge(2); m.charge(3);
  if (b >= 5) {
    b = 4;
    m.charge(2);
  }
  m.charge(2); m.charge(3); // lda #$81 / ldx #$1F17
  for (let i = 0; i < b; i += 1) {
    yield* wr(m, 0x1f17 + i * 2, 0x81, 7);
    m.charge(2); m.charge(3);
  }
  return false;
}

/**
 * The flip-dependent starfield of $DC50: not flipped $1170 = 0 and
 * $A001-$A003 = $87,$85,$06; flipped $1170 = 2 and $87,$81,$00.
 * @param {Machine} m @returns {Gen}
 */
function* starfield(m) {
  const flip = yield* rd(m, 0x102c, 4); // lda <$2C / bne
  m.charge(3);
  if (flip === 0) {
    yield* clr(m, 0x1170, 7);
  } else {
    m.charge(2);
    yield* wr(m, 0x1170, 2, 5);
  }
  const [a1, a3, a2] = flip === 0 ? [0x87, 0x06, 0x85] : [0x87, 0x00, 0x81];
  m.charge(2);
  yield* wr(m, 0xa001, a1, 5);
  m.charge(2);
  yield* wr(m, 0xa003, a3, 5);
  m.charge(2);
  yield* wr(m, 0xa002, a2, 5);
  if (flip === 0) m.charge(3); // bra $DC7C
}

/**
 * $DD5C-$DD86 (and its copy $DE45-$DE6F): the formation sprites at
 * $1854-$1859 = $A44B, $10F8/$10FC cleared, silence, sprite shadows
 * cleared, a frame, then $10AC = 0, $0E88 = 0, $1688 = $28A8 and
 * $1082 = $ADCF, before `jmp $DC38`.
 * @param {Machine} m @returns {Gen}
 */
function* newFormation(m) {
  m.charge(3);
  yield* wr16(m, 0x1854, 0xa44b, 6);
  yield* wr16(m, 0x1856, 0xa44b, 6);
  yield* wr16(m, 0x1858, 0xa44b, 6);
  yield* clrAll(m, [[0x10f8, 6], [0x10fc, 6]]);
  m.charge(8);
  yield* call(MAIN.sound_all_off, m, {});
  m.charge(8);
  yield* call(MAIN.clear_sprite_shadows, m, {});
  m.charge(16);
  yield; // cwai #$EF
  yield* clr(m, 0x10ac, 6);
  m.charge(3);
  yield* wr16(m, 0x0e88, 0, 6);
  m.charge(3);
  yield* wr16(m, 0x1688, 0x28a8, 6);
  m.charge(3);
  yield* wr16(m, 0x1082, 0xadcf, 5);
  m.charge(4);
}

/**
 * $DCEA (and its copy $DDD3): silence, clear the sprite shadows and
 * $10F8/$10FC/$1116-$1118, a frame, then the stage-clear sound 5 (INC),
 * $1E01 = $81 and mode 0 from its first task.
 * @param {Machine} m @returns {Gen}
 */
function* restartStage(m) {
  m.charge(8);
  yield* call(MAIN.sound_all_off, m, {});
  m.charge(8);
  yield* call(MAIN.clear_sprite_shadows, m, {});
  yield* clrAll(m, [[0x10f8, 6], [0x10fc, 6], [0x1118, 7], [0x1117, 7],
    [0x1116, 7]]);
  m.charge(16);
  yield; // cwai #$EF
  yield* rmw(m, 0x6045, 1, 7);
  m.charge(2);
  yield* wr(m, 0x1e01, 0x81, 5);
  yield* clrAll(m, [[0x102f, 6], [0x107a, 6], [0x1030, 6]]);
  m.charge(4); // jmp task_dispatch
}

/**
 * The block web from $D915 to $DEC0, entered at `start`.
 * @param {Machine} m
 * @param {number} start a block address
 * @returns {Gen}
 */
function* flow(m, start) {
  let pc = start;
  for (;;) {
    switch (pc) {
      case 0xd915: {
        // lda attract_flag / lbne $D9FC; lda <$FE / lbne $DA16;
        // lda <$1A / lbne $D9FA; lda $110F / lbne $D9FC
        if ((yield* rd(m, 0x09f4, 5)) !== 0) {
          m.charge(6); pc = 0xd9fc; continue;
        }
        m.charge(5);
        if ((yield* rd(m, 0x10fe, 4)) !== 0) {
          m.charge(6); pc = 0xda16; continue;
        }
        m.charge(5);
        if ((yield* rd(m, 0x101a, 4)) !== 0) {
          m.charge(6); pc = 0xd9fa; continue;
        }
        m.charge(5);
        if ((yield* rd(m, 0x110f, 5)) !== 0) {
          m.charge(6); pc = 0xd9fc; continue;
        }
        m.charge(5);
        // $D92F: ldb $1E01 / lda $1601 / lsrb / rora -- player X / 2
        // (bit 8 in $1E01 bit 0); box X/2 + 3 .. -3, Y + 6 .. -6 (8-bit)
        const hi = yield* rd(m, 0x1e01, 5);
        const x2 = ((yield* rd(m, 0x1601, 5)) >> 1) | ((hi & 1) << 7);
        m.charge(2); m.charge(2); m.charge(2);
        yield* wr(m, 0x10c9, (x2 + 3) & 0xff, 4);
        m.charge(2);
        yield* wr(m, 0x10c8, (x2 - 3) & 0xff, 4);
        const y = yield* rd(m, 0x1600, 5);
        m.charge(2);
        yield* wr(m, 0x10c7, (y + 6) & 0xff, 4);
        m.charge(2);
        yield* wr(m, 0x10c6, (y - 6) & 0xff, 4);
        m.charge(3);
        // $D94D: enemy shots and enemies $0ECE-$0F12 (leax 2,x first)
        let hitShot = false;
        for (let x = 0x0ece; ; x += 2) {
          m.charge(5); m.charge(4);
          if (x === 0x0f14) { m.charge(6); break; }
          m.charge(5);
          const f = yield* rd(m, x + 0x1001, 8);
          m.charge(2); m.charge(3);
          if ((f & 0x80) === 0) continue;
          if (!(yield* inBox(m, x))) continue;
          yield* hit(m);
          m.charge(3); // bra $D9FC
          hitShot = true;
          break;
        }
        if (hitShot) { pc = 0xd9fc; continue; }
        // $D989: ldu #$185F / ldx #$0E2E; entries $0E30-$0E86, U the
        // matching formation slot $1860+
        m.charge(3); m.charge(3);
        let u = 0x185f;
        for (let x = 0x0e30; ; x += 2) {
          u += 1;
          m.charge(5); m.charge(5); m.charge(4);
          if (x === 0x0e88) { m.charge(6); break; }
          m.charge(5);
          const f = yield* rd(m, x + 0x1001, 8);
          m.charge(2); m.charge(3);
          if ((f & 0x80) === 0) continue;
          if (!(yield* inBox(m, x))) continue;
          yield* hit(m);
          yield* wr(m, u, 1, 4); // sta ,u -- mark the formation slot
          m.charge(3);
          break;
        }
        pc = 0xd9fc;
        continue;
      }
      case 0xd9cf:
        // player_step 2, player_speed 1, shot_speed 6, no dual fighter,
        // shots $0EA2-$0EA9 = $2F00, $1100/$1101 = 6/$0C, jmp $DAEA
        m.charge(2);
        yield* wr(m, 0x10d1, 2, 4);
        m.charge(2);
        yield* wr(m, 0x1032, 1, 4);
        m.charge(2);
        yield* wr(m, 0x10d2, 6, 4);
        yield* clr(m, 0x10db, 6);
        yield* clr(m, 0x1e8b, 7);
        m.charge(3); m.charge(3);
        for (let x = 0x0ea2; x !== 0x0eaa; x += 2) {
          yield* wr16(m, x, 0x2f00, 8);
          m.charge(4); m.charge(3);
        }
        m.charge(2);
        yield* wr(m, 0x1100, 6, 5);
        m.charge(2);
        yield* wr(m, 0x1101, 0x0c, 5);
        m.charge(4);
        pc = 0xdaea;
        continue;
      case 0xd9fa:
        yield* rmw(m, 0x101a, -1, 6); // dec <$1A, then $D9FC
      // falls through
      case 0xd9fc:
        // inc <main_task / jmp task_dispatch
        yield* rmw(m, 0x1030, 1, 6);
        m.charge(4);
        return;
      case 0xda01:
        // The player is hit for good: $1F21, $1E01 cleared; $10FE,
        // snd_request+20 (death sound), $10E9, $10D9 = 1; no dual.
        yield* clr(m, 0x1f21, 7);
        yield* clr(m, 0x1e01, 7);
        m.charge(2);
        yield* wr(m, 0x10fe, 1, 4);
        yield* wr(m, 0x6054, 1, 5);
        yield* wr(m, 0x10e9, 1, 4);
        yield* wr(m, 0x10d9, 1, 4);
        yield* clr(m, 0x10db, 6);
        m.charge(3);
        pc = 0xd9fa;
        continue;
      case 0xda16:
        // While the death sound plays ($6054): "PLAYER" and "GAME OVER"
        // (the latter in attribute 1).
        if ((yield* rd(m, 0x6054, 5)) === 0) {
          m.charge(3); pc = 0xda57; continue;
        }
        m.charge(3); m.charge(3); m.charge(3); m.charge(2); m.charge(8);
        yield* sub_DC1C(m, { x: 0x02ce, u: 0xda33, b: 0x0c });
        m.charge(3); m.charge(3); m.charge(2); m.charge(8);
        yield* sub_DC1C(m, { x: 0x02d0, u: 0xda3d, b: 0x01 });
        m.charge(3);
        pc = 0xd9fc;
        continue;
      case 0xda57: {
        // Sound over: $10FE, $10E9, $10D9 = 0, dual_fighter = 1 (A)
        m.charge(2);
        yield* clrAll(m, [[0x10fe, 6], [0x10e9, 6], [0x10d9, 6]]);
        yield* wr(m, 0x10db, 1, 4);
        const two = yield* rd(m, 0x102e, 4);
        m.charge(3);
        if (two === 0) { pc = 0xda87; continue; }
        // Two players: blank both message lines
        m.charge(3); m.charge(3); m.charge(2); m.charge(8);
        yield* sub_DC1C(m, { x: 0x02ce, u: 0xda4a, b: 0 });
        m.charge(3); m.charge(3); m.charge(2); m.charge(8);
        yield* sub_DC1C(m, { x: 0x02d0, u: 0xda4a, b: 0 });
        if ((yield* rd(m, 0x1104, 5)) !== 0) {
          m.charge(6); pc = 0xdb9d; continue;
        }
        m.charge(5);
        if ((yield* rd(m, 0x1105, 5)) !== 0) {
          m.charge(6); pc = 0xdb04; continue;
        }
        m.charge(5);
        pc = 0xda87;
        continue;
      }
      case 0xda87: {
        // Game over for good: blank the message lines, clear
        // $102A-$11FF, $1800-$1BFF, the sprite shadows ($0E00-$0F25 and
        // $0F2C-$0FFF, with their $1600/$1E00 banks) and both scores'
        // low two bytes, gate the sounds, wait a frame, attract mode.
        m.charge(3); m.charge(3); m.charge(2); m.charge(8);
        yield* sub_DC1C(m, { x: 0x02ce, u: 0xda4a, b: 0 });
        m.charge(3); m.charge(3); m.charge(2); m.charge(8);
        yield* sub_DC1C(m, { x: 0x02d0, u: 0xda4a, b: 0 });
        m.charge(3); m.charge(3);
        for (let x = 0x102a; x !== 0x1200; x += 2) {
          yield* wr16(m, x, 0, 8);
          m.charge(4); m.charge(3);
        }
        m.charge(3);
        for (let x = 0x1800; x !== 0x1c00; x += 2) {
          yield* wr16(m, x, 0, 8);
          m.charge(4); m.charge(3);
        }
        for (const [from, end] of [[0x0e00, 0x0f26], [0x0f2c, 0x1000]]) {
          m.charge(3);
          for (let x = from; x !== end; x += 2) {
            yield* wr16(m, x + 0x0800, 0, 9);
            yield* wr16(m, x + 0x1000, 0, 9);
            yield* wr16(m, x, 0, 8);
            m.charge(4); m.charge(3);
          }
        }
        // std score_p1 / std score_p2: only bytes 0-1 of each (the high
        // BCD byte stays: the next game start clears it anyway)
        yield* wr16(m, 0x09b0, 0, 6);
        yield* wr16(m, 0x09b3, 0, 6);
        m.charge(8);
        yield* call(MAIN.sound_demo_gate, m, {});
        m.charge(16);
        yield; // $DADF: cwai #$EF
        yield* clrAll(m, [[0x102f, 6], [0x1030, 6], [0x107a, 6]]);
        m.charge(4);
        requestJump(m, ATTRACT_LOOP);
        return;
      }
      case 0xdaea: {
        // Lose a life. 1P: $DBC6. 2P: dec the current player's lives;
        // on to the other player if he has any.
        if ((yield* rd(m, 0x102e, 4)) === 0) {
          m.charge(6); pc = 0xdbc6; continue;
        }
        m.charge(5);
        if ((yield* rd(m, 0x102d, 4)) !== 0) {
          m.charge(6); pc = 0xdb91; continue;
        }
        m.charge(5);
        const l = yield* rmw(m, 0x1104, -1, 7);
        if (l === 0) { m.charge(6); pc = 0xdbcd; continue; }
        m.charge(5);
        if ((yield* rd(m, 0x1105, 5)) === 0) {
          m.charge(6); pc = 0xde73; continue;
        }
        m.charge(5);
        pc = 0xdb04;
        continue;
      }
      case 0xdb04:
        // Switch to player 2 (flip the screen on a cocktail cabinet)
        m.charge(2);
        yield* wr(m, 0x102d, 1, 4);
        {
          const cab = yield* rd(m, 0x1005, 4);
          m.charge(3);
          if (cab === 0) {
            m.charge(2);
            yield* wr(m, 0x102c, 1, 4);
          }
        }
      // falls through
      case 0xdb10: {
        if (yield* reserveShips(m, 0x1105)) { pc = 0xdd8a; continue; }
        // P2's very first turn (full lives, stage 0, score 0): set him
        // up like a fresh game start (jmp lCDA1 in start_game_1p).
        const ls = yield* rd(m, 0x1000, 4);
        if (ls !== (yield* rd(m, 0x1105, 5))) {
          m.charge(6); pc = 0xdd8a; continue;
        }
        m.charge(5);
        if ((yield* rd(m, 0x1107, 5)) !== 0) {
          m.charge(6); pc = 0xdd8a; continue;
        }
        m.charge(5);
        const sc = (yield* rd(m, 0x09b3, 5)) | (yield* rd(m, 0x09b4, 5))
          | (yield* rd(m, 0x09b5, 5));
        if (sc !== 0) { m.charge(6); pc = 0xdd8a; continue; }
        m.charge(5); m.charge(8);
        yield* call(MAIN.sound_all_off, m, {});
        m.charge(8);
        yield* call(MAIN.clear_sprite_shadows_all, m, {});
        yield* saveFormation(m, 0x1c30);
        yield* saveExtra(m, 0x1c5d);
        yield* wr(m, 0x112f, yield* rd(m, 0x102f, 4), 5);
        m.charge(16);
        yield; // $DB79: cwai #$EF
        yield* clrAll(m, [[0x10f8, 6], [0x10fc, 6], [0x1118, 7],
          [0x1117, 7], [0x1116, 7], [0x102f, 6], [0x1030, 6],
          [0x107a, 6]]);
        m.charge(4);
        requestJump(m, START_P2);
        return;
      }
      case 0xdb91: {
        // P2 loses a life; to P1 if he has any.
        const l = yield* rmw(m, 0x1105, -1, 7);
        m.charge(3);
        if (l === 0) { pc = 0xdbf6; continue; }
        if ((yield* rd(m, 0x1104, 5)) === 0) {
          m.charge(6); pc = 0xde9a; continue;
        }
        m.charge(5);
        pc = 0xdb9d;
        continue;
      }
      case 0xdb9d:
        // Switch to (or stay with) player 1, unflipped
        yield* clr(m, 0x102d, 6);
        yield* clr(m, 0x102c, 6);
        if (!(yield* reserveShips(m, 0x1104))) m.charge(4); // jmp $DC9B
        pc = 0xdc9b;
        continue;
      case 0xdbc6: {
        const l = yield* rmw(m, 0x1104, -1, 7);
        m.charge(3);
        if (l !== 0) { m.charge(3); pc = 0xdb9d; continue; }
        pc = 0xdbcd;
        continue;
      }
      case 0xdbcd:
        // Game over (P1): 256 frames (cwai, then clra / {inca / beq /
        // cwai / bra} 255 times), then mode 9 (high score).
        m.charge(16);
        yield;
        m.charge(2);
        for (let a = 1; a < 0x100; a += 1) {
          m.charge(2); m.charge(3); m.charge(16);
          yield;
          m.charge(3);
        }
        m.charge(2); m.charge(3);
        pc = 0xdbd7;
        continue;
      case 0xdbd7:
        // lda #9 / sta <game_mode / clr <$30 / clr <$7A / jmp dispatch
        m.charge(2);
        yield* wr(m, 0x102f, 9, 4);
        yield* clrAll(m, [[0x1030, 6], [0x107a, 6]]);
        m.charge(4);
        return;
      case 0xdbe2:
        // After P1's name entry: "1" at $018E (colour $0C), $1071 = 1,
        // count the game time, then the death of $DA01.
        m.charge(2);
        yield* wr(m, 0x018e, 0x31, 5);
        m.charge(2);
        yield* wr(m, 0x058e, 0x0c, 5);
        m.charge(2);
        yield* wr(m, 0x1071, 1, 4);
        m.charge(8);
        yield* sub_DEC1(m);
        m.charge(4);
        pc = 0xda01;
        continue;
      case 0xdbf6:
        // Game over (P2): {inca / beq / cwai / bra} 255 times, cwai
        m.charge(2);
        for (let a = 1; a < 0x100; a += 1) {
          m.charge(2); m.charge(3); m.charge(16);
          yield;
          m.charge(3);
        }
        m.charge(2); m.charge(3); m.charge(16);
        yield; // $DBFE: cwai #$EF
        pc = 0xdbd7; // $DC00-$DC08 repeat $DBD7-$DBDF
        continue;
      case 0xdc0b:
        // After P2's name entry: "2" at $018E, $1071 = 1, the death
        // (no game-time count: that is player 1's only)
        m.charge(2);
        yield* wr(m, 0x018e, 0x32, 5);
        m.charge(2);
        yield* wr(m, 0x058e, 0x0c, 5);
        m.charge(2);
        yield* wr(m, 0x1071, 1, 4);
        m.charge(4);
        pc = 0xda01;
        continue;
      case 0xdc2c:
        // 1P: mode 3 restarts through $DCEA; else $DC38. ($DC36-$DC37
        // hold `cwai #$EF`, skipped by the `bra` at $DC34: unreached.)
        if ((yield* rd(m, 0x102f, 4)) === 3) {
          m.charge(2); m.charge(6); pc = 0xdcea; continue;
        }
        m.charge(2); m.charge(5); m.charge(3);
        pc = 0xdc38;
        continue;
      case 0xdc38: {
        // New ship: in 2P reload the current player's stage parameters
        // and formation sprites, starfield, then mode 5 next frame.
        yield* clr(m, 0x10f8, 6);
        const two = yield* rd(m, 0x102e, 4);
        m.charge(3);
        if (two !== 0) {
          let b = yield* rd(m, 0x1106, 5);
          const a = yield* rd(m, 0x102d, 4);
          m.charge(3);
          if (a !== 0) b = yield* rd(m, 0x1107, 5);
          yield* wr(m, 0x1035, b, 4);
          m.charge(8);
          yield* call(MAIN.load_stage_params, m, { a, b });
          m.charge(8);
          yield* call(MAIN.load_formation_sprites, m, {});
        }
        yield* starfield(m);
        yield* wr(m, 0x111a, yield* rd(m, 0x1119, 5), 5);
        yield* clrAll(m, [[0x1071, 6], [0x1018, 6], [0x1f2d, 7]]);
        m.charge(16);
        yield; // $DC89: cwai #$EF
        m.charge(2);
        yield* wr(m, 0x102f, 5, 4);
        yield* clrAll(m, [[0x107a, 6], [0x1030, 6]]);
        m.charge(2);
        yield* wr(m, 0x1e01, 0x81, 5);
        m.charge(4);
        return;
      }
      case 0xdc9b:
        if ((yield* rd(m, 0x102e, 4)) === 0) {
          m.charge(6); pc = 0xdc2c; continue;
        }
        m.charge(5);
        // 2P, to player 1: remember the mode (for P2) in $1130
        yield* wr(m, 0x1130, yield* rd(m, 0x102f, 4), 5);
        if ((yield* rd(m, 0x112f, 5)) !== 3) {
          m.charge(2); m.charge(3); pc = 0xdd10; continue;
        }
        m.charge(2); m.charge(3);
        yield* saveFormation(m, 0x1c60);
        yield* saveExtra(m, 0x1c8d);
        yield* restoreFormation(m, 0x1c30);
        yield* restoreExtra(m, 0x1c5d);
        pc = 0xdcea;
        continue;
      case 0xdcea:
        yield* restartStage(m);
        return;
      case 0xdd10:
        if ((yield* rd(m, 0x1180, 5)) !== 0) {
          m.charge(6); pc = 0xdc38; continue;
        }
        m.charge(5);
        if ((yield* rd(m, 0x1105, 5)) === 0) {
          m.charge(3);
          yield* rmw(m, 0x1180, 1, 7);
        } else {
          m.charge(3);
        }
        yield* saveFormation(m, 0x1c60);
        yield* saveExtra(m, 0x1c8d);
        yield* restoreFormation(m, 0x1c30);
        yield* restoreExtra(m, 0x1c5d);
        yield* newFormation(m);
        pc = 0xdc38;
        continue;
      case 0xdd8a:
        // To player 2 (or staying with him): keep the mode in $112F
        yield* wr(m, 0x112f, yield* rd(m, 0x102f, 4), 5);
        if ((yield* rd(m, 0x1130, 5)) !== 3) {
          m.charge(2); m.charge(3); pc = 0xddf9; continue;
        }
        m.charge(2); m.charge(3);
        yield* saveFormation(m, 0x1c30);
        yield* saveExtra(m, 0x1c5d);
        yield* restoreFormation(m, 0x1c60);
        yield* restoreExtra(m, 0x1c8d);
        yield* restartStage(m); // $DDD3-$DDF6 repeat $DCEA-$DD0D
        return;
      case 0xddf9:
        if ((yield* rd(m, 0x117f, 5)) !== 0) {
          m.charge(6); pc = 0xdc38; continue;
        }
        m.charge(5);
        if ((yield* rd(m, 0x1104, 5)) === 0) {
          m.charge(3);
          yield* rmw(m, 0x117f, 1, 7);
        } else {
          m.charge(3);
        }
        yield* saveFormation(m, 0x1c30);
        yield* saveExtra(m, 0x1c5d);
        yield* restoreFormation(m, 0x1c60);
        yield* restoreExtra(m, 0x1c8d);
        yield* newFormation(m);
        pc = 0xdc38;
        continue;
      case 0xde73:
        // P1 died, P2 has no lives: keep P1's formation, stay with P1
        yield* wr(m, 0x112f, yield* rd(m, 0x102f, 4), 5);
        yield* saveFormation(m, 0x1c30);
        yield* saveExtra(m, 0x1c5d);
        m.charge(4);
        pc = 0xdb9d;
        continue;
      case 0xde9a:
        // P2 died, P1 has no lives. `lda <$2F` is overwritten at once
        // by `lda $1130` (dead load, kept for its cycles).
        yield* rd(m, 0x102f, 4);
        yield* rd(m, 0x1130, 5);
        yield* saveFormation(m, 0x1c60);
        yield* saveExtra(m, 0x1c8d);
        m.charge(4);
        pc = 0xdb10;
        continue;
      default:
        throw new Error(`gp2_3b_death: no block at $${pc.toString(16)}`);
    }
  }
}

/**
 * $D915 task_player_hit_check (modes 3 and 5): outside attract mode,
 * unless the player is already dying ($10FE: the death sequence runs
 * from here too), invulnerable ($101A counts down) or hit ($110F), test
 * the box around the ship ($10C6-$10C9) against the in-use sprite
 * shadow entries $0ECE-$0F12 (enemy shots) and $0E30-$0E86 (enemies,
 * whose formation slot $1860+n is then set to 1). A hit starts the
 * explosion (62XX $6829/$682A) and sets $110F. With $10FE set it drives
 * the death: messages while the death sound $6054 plays, then the next
 * player, a new ship, or game over. See `flow` for the blocks.
 * @see gaplus-main.asm $D915
 * @param {Machine} m
 * @returns {Gen}
 */
export function* task_player_hit_check(m) {
  yield* flow(m, 0xd915);
}

/**
 * $D9CF lD9CF (jumped to from $F8D2): reset the fighter (speeds, no dual
 * fighter, shots $0EA2-$0EA9, $1100/$1101) and lose a life ($DAEA).
 * @see gaplus-main.asm $D9CF
 * @param {Machine} m
 * @returns {Gen}
 */
export function* lD9CF(m) {
  yield* flow(m, 0xd9cf);
}

/**
 * $DA87 lDA87 (from $FC7D/$FC9F): the end of a game -- clear the game
 * RAM and sprites, wait a frame, back to attract_loop.
 * @see gaplus-main.asm $DA87
 * @param {Machine} m
 * @returns {Gen}
 */
export function* lDA87(m) {
  yield* flow(m, 0xda87);
}

/**
 * $DBE2 lDBE2 (from $B301, after player 1's high-score entry).
 * @see gaplus-main.asm $DBE2
 * @param {Machine} m
 * @returns {Gen}
 */
export function* lDBE2(m) {
  yield* flow(m, 0xdbe2);
}

/**
 * $DC0B lDC0B (from $B2F6, after player 2's high-score entry).
 * @see gaplus-main.asm $DC0B
 * @param {Machine} m
 * @returns {Gen}
 */
export function* lDC0B(m) {
  yield* flow(m, 0xdc0b);
}

/** Every routine of this file by entry address. */
export const ROUTINES = {
  0xd915: task_player_hit_check,
  0xd9cf: lD9CF,
  0xda87: lDA87,
  0xdbe2: lDBE2,
  0xdc0b: lDC0B,
  0xdc1c: sub_DC1C,
  0xdec1: sub_DEC1,
};

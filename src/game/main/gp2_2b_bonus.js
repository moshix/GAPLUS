// Copyright 2026 by Moshix
/**
 * Main CPU $FA7D-$FEAF: the bonus-life task and its step routines, the
 * extra-ship sprite flag (sub_FB9E), the READY blink of sub_FBB1, the
 * game-over check with the TOP 5 copy (sub_FC33), the operator statistics
 * shown from the IRQ (operator_stats) and the bonus-ship task sub_FE18.
 *
 * TASKS. Every task here ends with `INC <main_task / JMP task_dispatch`
 * (sub_FB0F, lFC02, lFC62, lFE6D): the port performs the INC and returns
 * to the dispatcher. sub_FC33 spins on the sub CPU's task index ($107A)
 * at $FC71 (`yield SPIN` per failed pass) and can leave the scheduler
 * through `lbne/lbeq lDA87` (gp2-3b), a tail call.
 *
 * TIMING. Every routine charges (m.charge) the MAME 6809 cycles of each
 * instruction it executes, from its entry through its RTS or its final
 * `JMP task_dispatch`; a JSR/BSR is charged by the caller, the callee
 * charges itself. Accesses happen while m.charged[0] is the cycle the
 * instruction starts: charge everything before an instruction, perform
 * its accesses, then charge it. Just before an instruction that touches
 * RAM another CPU uses (the scores $09B0-$09B1/$09B4, $1016, $102F,
 * $1035, $107A, $10AB, $112A, $1600-$1601, the formation $1860-$188C,
 * $1E01, $1F1F, the sound flags $6040-$607F) foreground code yields SYNC
 * so the scheduler can let the other CPUs catch up to that cycle. Hence
 * almost every routine is a generator; sub_FB9E too (it reads $1F1F),
 * so its callers use `yield* call(MAIN.sub_FB9E, m, {})`. operator_stats
 * runs inside irq_main: it charges exactly but never yields.
 *
 * Cycle counts used below (MAME): LDA/LDB imm 2, dir 4, ext 5, indexed
 * 4+ea; STA dir 4, ext 5; LDD imm 3, STD ext 6; LDX/LDU imm 3, LDY imm
 * 4, LDU/LDX ,Y++ 8; INC/DEC/CLR dir 6, ext 7, ,X 6, $0400,U 10; SUBD
 * ext 7; CMPX imm 4; LEAU/LEAX -$20 5; Bcc 3; LBcc 5 (6 taken); JMP ext
 * 4, JMP [A,X] 7; JSR ext 8, BSR 7, RTS 5. ea: ,X+ 2, ,X++ 3, A,X 1,
 * -2,X 1, ,U 0.
 *
 * ROM QUIRK (reproduced): at $FB63 the P2 path of the "every = 0" bonus
 * setting does `LDB #$03 / STA $1125` -- it stores A (bonus_second), not
 * B, into P2's step index, where P1's path ($FAD4) stores 3. The next
 * task_bonus_life then indexes bonus_steps_p2 with bonus_second x 2 and
 * jumps through a word of code (no routine there: mainAt throws). Only
 * with the DIP bonus setting 1 (5, 15, none) in a 2-player game.
 *
 * @see reference/gaplus-main.asm $FA7D-$FEAF
 */

import { MAIN, mainAt } from './routines.js';
import { call } from '../call.js';
import { mainWord } from '../romdata.js';
import { add8, daa, dec8, sub16, disp8 } from '../m6809ops.js';
import { SPIN, SYNC } from './gp2_2b_state.js';
import { pollAgain } from '../timing.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/**
 * `INC <main_task / JMP task_dispatch` ($1030; 6 + 4 cycles): the common
 * end of a task.
 * @param {Machine} m
 */
function* endTask(m) {
  // (integration, round 3) the sub CPU may clear main_task: timed
  yield SYNC;
  m.poke(0x1030, (m.peek(0x1030) + 1) & 0xff); // main_task
  m.charge(6); m.charge(4);
}

/**
 * `INC addr` (extended, 7 cycles) on RAM: read, then write.
 * @param {Machine} m @param {number} addr
 */
function inc(m, addr) {
  m.poke(addr, (m.peek(addr) + 1) & 0xff);
  m.charge(7);
}

/**
 * `ADDA #$01 / DAA`: one BCD increment (not charged).
 * @param {number} a
 * @returns {{ v: number, cf: boolean }}
 */
function bcdInc(a) {
  const r = add8(a, 1);
  return daa(r.v, r.cc);
}

/**
 * `LDA #$01 / STA $6055` (2 + 5): request sound $15, the extra ship.
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
function* sound15(m) {
  m.charge(2);
  yield SYNC;
  m.poke(0x6055, 0x01); // snd_request+21
  m.charge(5);
}

/**
 * $FA7D task_bonus_life: extra-ship check of the current player. Jumps
 * through bonus_steps_p1 ($FA8C, index $1124) or bonus_steps_p2 ($FB1D,
 * index $1125).
 *
 *   $FA7D: lda <$2D / lbne lFB14 / ldx #$FA8C / lda $1124 / asla /
 *   jmp [a,x]
 *
 * ASLA is 8-bit and A,X signed, as on the CPU (see the file header for
 * the index the ROM bug produces).
 * @see gaplus-main.asm $FA7D
 * @param {Machine} m
 * @returns {Generator<unknown, unknown, unknown>}
 */
export function* task_bonus_life(m) {
  const p2 = m.peek(0x102d) !== 0; // cur_player
  // lda 4, lbne 5 / 6 taken, ldx # 3
  m.charge(4 + (p2 ? 6 : 5) + 3);
  const table = p2 ? 0xfb1d : 0xfa8c;
  const idx = (m.peek(p2 ? 0x1125 : 0x1124) << 1) & 0xff;
  m.charge(5); m.charge(2);
  const target = m.read16('main', disp8(table, idx));
  m.charge(7); // jmp [a,x]
  return yield* call(mainAt(target), m, {});
}

/**
 * Step 0 for either player: score+1 (BCD x 10,000) >= bonus_first.
 *
 *   lda score+1 / cmpa <$01 / bcs sub_FB0F / lda #$01 / sta $6055 /
 *   inc lives / inc step / jsr-bsr sub_FB9E / bra sub_FB0F
 *
 * @param {Machine} m @param {boolean} p2
 * @returns {Generator<unknown, void, unknown>}
 */
function* firstBonus(m, p2) {
  yield SYNC;
  const s = m.peek(p2 ? 0x09b4 : 0x09b1);
  m.charge(5);
  const ok = s >= m.peek(0x1001); // bonus_first
  m.charge(4); m.charge(3);
  if (ok) {
    yield* sound15(m);
    inc(m, p2 ? 0x1105 : 0x1104);
    inc(m, p2 ? 0x1125 : 0x1124);
    m.charge(p2 ? 7 : 8); // P1 jsr, P2 bsr
    yield* sub_FB9E(m);
    m.charge(3); // bra
  }
  yield* sub_FB0F(m);
}

/**
 * First bonus of P1 (step 0).
 * @see gaplus-main.asm $FA94
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
export function* sub_FA94(m) {
  yield* firstBonus(m, false);
}

/**
 * Step 1: score+1 >= bonus_second. Then the next threshold ($117B-$117C
 * for P1, $117D-$117E for P2) = bonus_second plus `bonus_every` in BCD,
 * high byte 0. With bonus_every = 0 the step index becomes 3 (no more
 * bonuses) and the add loop runs 3 times (B = 3) -- for P2 through the
 * $FB65 bug.
 * @param {Machine} m
 * @param {boolean} p2
 * @returns {Generator<unknown, void, unknown>}
 */
function* secondBonus(m, p2) {
  const step = p2 ? 0x1125 : 0x1124;
  const next = p2 ? 0x117d : 0x117b;
  // lda score+1 / cmpa <$02 / bcs sub_FB0F
  yield SYNC;
  const s = m.peek(p2 ? 0x09b4 : 0x09b1);
  m.charge(5);
  const ok = s >= m.peek(0x1002);
  m.charge(4); m.charge(3);
  if (ok) {
    yield* sound15(m);
    inc(m, p2 ? 0x1105 : 0x1104);
    inc(m, step);
    // lda <$02 / ldb <$03 / beq
    let a = m.peek(0x1002);
    m.charge(4);
    let b = m.peek(0x1003);
    m.charge(4); m.charge(3);
    if (b === 0) {
      b = 3;
      m.charge(2);
      // P1 $FAD4: ldb #$03 / stb $1124
      // P2 $FB63: ldb #$03 / sta $1125 -- ROM bug: stores A, kept
      m.poke(step, p2 ? a : b);
      m.charge(5); m.charge(3);
    }
    // adda #$01 / daa / decb / bne -- b times, 9 cycles a pass
    do {
      a = bcdInc(a).v;
      b = (b - 1) & 0xff;
      m.charge(9);
    } while (b !== 0);
    // sta next+1 / clr next
    m.poke(next + 1, a);
    m.charge(5);
    m.peek(next);
    m.poke(next, 0);
    m.charge(7);
    m.charge(p2 ? 7 : 8); // P2 bsr, P1 jsr
    yield* sub_FB9E(m);
    m.charge(3); // bra
  }
  yield* sub_FB0F(m);
}

/**
 * Second bonus of P1 (step 1).
 * @see gaplus-main.asm $FAAB
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
export function* sub_FAAB(m) {
  yield* secondBonus(m, false);
}

/**
 * Step 2, every further bonus: the score's top two bytes (hi, mid as a
 * 16-bit number) >= the next threshold; then the threshold += bonus_every
 * in BCD, the carry of the low byte going into the high byte.
 *
 *   lda score+2 / ldb score+1 / subd next / bcs sub_FB0F
 *   ... lda next+1 / ldb <$03
 *   l: adda #$01 / daa / bcs c / m: decb / bne l / sta next+1
 *   c: lda next / adda #$01 / daa / sta next / clra / bra m
 *
 * P1 ends `jsr sub_FB9E / bra sub_FB0F`, P2 `bsr sub_FB9E / jmp
 * sub_FB0F`.
 * @param {Machine} m
 * @param {boolean} p2
 * @returns {Generator<unknown, void, unknown>}
 */
function* everyBonus(m, p2) {
  const score = p2 ? 0x09b4 : 0x09b1;
  const next = p2 ? 0x117d : 0x117b;
  const hi = m.peek(score + 1); // score+2 is not shared
  m.charge(5);
  yield SYNC;
  const lo = m.peek(score);
  m.charge(5);
  const lt = sub16((hi << 8) | lo, m.peek16(next)).cf;
  m.charge(7); m.charge(3);
  if (!lt) {
    yield* sound15(m);
    inc(m, p2 ? 0x1105 : 0x1104);
    let a = m.peek(next + 1);
    m.charge(5);
    let b = m.peek(0x1003);
    m.charge(4);
    do {
      const r = bcdInc(a);
      a = r.v;
      m.charge(2); m.charge(2); m.charge(3); // adda, daa, bcs
      if (r.cf) {
        const h = bcdInc(m.peek(next)).v;
        m.charge(5); m.charge(2); m.charge(2);
        m.poke(next, h);
        m.charge(5); m.charge(2); m.charge(3); // sta, clra, bra
        a = 0;
      }
      // decb / bne -- B = 0 means 256 passes
      b = (b - 1) & 0xff;
      m.charge(2); m.charge(3);
    } while (b !== 0);
    m.poke(next + 1, a);
    m.charge(5);
    m.charge(p2 ? 7 : 8);
    yield* sub_FB9E(m);
    m.charge(p2 ? 4 : 3); // P2 jmp, P1 bra
  }
  yield* sub_FB0F(m);
}

/**
 * Further bonuses of P1 (step 2).
 * @see gaplus-main.asm $FADB
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
export function* sub_FADB(m) {
  yield* everyBonus(m, false);
}

/**
 * The end of every task in this range: `INC <$30 / JMP task_dispatch`.
 * Also step 3 of both bonus tables (no more bonuses).
 * @see gaplus-main.asm $FB0F
 * @param {Machine} m
 */
export function* sub_FB0F(m) {
  yield* endTask(m);
}

/**
 * First bonus of P2 (step 0).
 * @see gaplus-main.asm $FB25
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
export function* sub_FB25(m) {
  yield* firstBonus(m, true);
}

/**
 * Second bonus of P2 (step 1; see the $FB65 bug in the file header).
 * @see gaplus-main.asm $FB3B
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
export function* sub_FB3B(m) {
  yield* secondBonus(m, true);
}

/**
 * Further bonuses of P2 (step 2).
 * @see gaplus-main.asm $FB6A
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
export function* sub_FB6A(m) {
  yield* everyBonus(m, true);
}

/**
 * Flag an extra ship: the first of $1F17, $1F19, $1F1B whose bit 7 is
 * clear gets $81. $1F1D is never tested ($1F1F is read, but the loop
 * ends on the CMPX first). A generator: the read of $1F1F (sub-CPU RAM)
 * yields SYNC.
 *
 *   ldx #$1F17 / l: lda ,x++ / cmpx #$1F21 / beq rts / anda #$80 /
 *   bne l / lda #$81 / sta -2,x / rts
 *
 * @see gaplus-main.asm $FB9E
 * @param {Machine} m
 * @returns {Generator<unknown, { a: number, x: number }, unknown>}
 */
export function* sub_FB9E(m) {
  let x = 0x1f17;
  m.charge(3);
  for (;;) {
    if (x === 0x1f1f) yield SYNC;
    let a = m.peek(x);
    x += 2;
    m.charge(7); m.charge(4); m.charge(3); // lda ,x++ / cmpx / beq
    if (x === 0x1f21) {
      m.charge(5);
      return { a, x };
    }
    a &= 0x80;
    m.charge(2); m.charge(3); // anda / bne
    if (a === 0) {
      m.charge(2);
      m.poke(x - 2, 0x81);
      m.charge(5); m.charge(5);
      return { a: 0x81, x };
    }
  }
}

/**
 * Task (modes 3, 5, 7): every frame whose frame_counter & 7 != 0, count
 * the current player's timer ($1023 P1 / $1024 P2, via $10AB) down; at
 * $60 blank the message line, at $D0 print "READY" if $1E01 b7 is set;
 * $112A = 1 while counting, 0 at the end.
 * @see gaplus-main.asm $FBB1
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
export function* sub_FBB1(m) {
  // $FBB1: lda <$16 / anda #$07 / beq lFC02
  yield SYNC;
  const fc = m.peek(0x1016);
  m.charge(4); m.charge(2); m.charge(3);
  if ((fc & 0x07) !== 0) {
    const p2 = m.peek(0x102d) !== 0;
    m.charge(4); m.charge(3);
    const t0 = m.peek(p2 ? 0x1024 : 0x1023);
    m.charge(4);
    yield SYNC;
    m.poke(0x10ab, t0);
    m.charge(4 + (p2 ? 0 : 3)); // sta <$AB (P1: bra)
    // lFBC5: lda <$AB / beq lFBF4 / dec <$AB / beq lFBF1
    yield SYNC;
    const a0 = m.peek(0x10ab);
    m.charge(4); m.charge(3);
    if (a0 !== 0) {
      yield SYNC;
      const t = dec8(m.peek(0x10ab)).v;
      m.poke(0x10ab, t);
      m.charge(6); m.charge(3);
      let clear = t === 0;
      if (!clear) {
        m.charge(2);
        yield SYNC;
        m.poke(0x112a, 0x01);
        m.charge(5);
        yield SYNC;
        const a = m.peek(0x10ab);
        m.charge(4); m.charge(2); m.charge(3); // lda / cmpa #$60 / beq
        if (a === 0x60) {
          m.charge(3); m.charge(7); // ldx # / bsr
          sub_FC1F(m, { x: 0xfc13 }); // 12 spaces
          m.charge(3);
        } else {
          m.charge(2); m.charge(3); // cmpa #$D0 / bne
          if (a === 0xd0) {
            yield SYNC;
            const f = m.peek(0x1e01);
            m.charge(5); m.charge(2); m.charge(3);
            if ((f & 0x80) === 0) {
              clear = true;
            } else {
              m.charge(3); m.charge(7);
              sub_FC1F(m, { x: 0xfc07 }); // "   READY    "
              m.charge(3);
            }
          }
        }
      }
      if (clear) {
        // lFBF1: clr $112A
        yield SYNC;
        m.peek(0x112a);
        m.poke(0x112a, 0);
        m.charge(7);
      }
    }
    // lFBF4: store the timer back for the current player
    m.charge(4); m.charge(3);
    yield SYNC;
    const v = m.peek(0x10ab);
    m.charge(4);
    m.poke(p2 ? 0x1024 : 0x1023, v);
    m.charge(4 + (p2 ? 0 : 3)); // sta (P1: bra)
  }
  yield* endTask(m);
}

/**
 * Print 12 characters from X at tile $02B2 going right, attribute 0.
 *
 *   ldu #$02B2 / ldb #$0C / l: lda ,x+ / sta ,u / clr $0400,u /
 *   leau -$20,u / decb / bne l / rts
 *
 * @see gaplus-main.asm $FC1F
 * @param {Machine} m
 * @param {{ x: number }} regs
 * @returns {{ a: number, b: number, x: number, u: number }}
 */
export function sub_FC1F(m, { x }) {
  let u = 0x02b2;
  let a = 0;
  let p = x;
  m.charge(3); m.charge(2);
  for (let b = 0; b < 12; b += 1) {
    a = m.read('main', p);
    p = (p + 1) & 0xffff;
    m.charge(6);
    m.poke(u, a);
    m.charge(4);
    m.peek(u + 0x400); // clr reads first
    m.poke(u + 0x400, 0);
    m.charge(10); m.charge(5); m.charge(2); m.charge(3);
    u = (u - 0x20) & 0xffff;
  }
  m.charge(5);
  return { a, b: 0, x: p, u };
}

/**
 * Task (modes 5 and 9): game-over check. While either player has lives,
 * or no credits, or a credit was just added, or start is pressed... it
 * just returns. Otherwise ($FC67): starfield control, wait for the sub
 * CPU's task index to be 0 or $1B, then in mode 9 copy the TOP 5 table
 * from the screen into $0900 (scores, 8 each) and $0950 (names, 14
 * each), and in any case go on at lDA87 (gp2-3b).
 * @see gaplus-main.asm $FC33
 * @param {Machine} m
 * @returns {Generator<unknown, unknown, unknown>}
 */
export function* sub_FC33(m) {
  // $FC33: lda $1104 / ora $1105 / anda #$0F / bne lFC62
  const l1 = m.peek(0x1104);
  m.charge(5);
  const l2 = m.peek(0x1105);
  m.charge(5); m.charge(2); m.charge(3);
  if (((l1 | l2) & 0x0f) === 0) {
    // $FC3D: lda $6802 / anda #$0F / lbne lFC67 -- credits added
    let go = (m.peek(0x6802) & 0x0f) !== 0;
    m.charge(5 + 2 + (go ? 6 : 5));
    if (go) return yield* gameOver(m);
    // $FC46: lda $6800 / ora $6801 / anda #$0F / beq lFC62
    const c1 = m.peek(0x6800);
    m.charge(5);
    const c2 = m.peek(0x6801);
    m.charge(5); m.charge(2); m.charge(3);
    if (((c1 | c2) & 0x0f) !== 0) {
      // start 1 or start 2 held -> lFC67
      go = (m.peek(0x6805) & 0x08) !== 0;
      m.charge(5 + 2 + (go ? 6 : 5));
      if (go) return yield* gameOver(m);
      go = (m.peek(0x6807) & 0x08) !== 0;
      m.charge(5 + 2 + (go ? 6 : 5));
      if (go) return yield* gameOver(m);
    }
  }
  // lFC62: inc <$30 / jmp task_dispatch
  yield* endTask(m);
  return undefined;
}

/**
 * $FC67-$FCB1: the rest of sub_FC33.
 * @param {Machine} m
 * @returns {Generator<unknown, unknown, unknown>}
 */
function* gameOver(m) {
  m.charge(2);
  m.poke(0xa003, 0x06);
  m.charge(5); m.charge(2);
  m.poke(0xa002, 0x85);
  m.charge(5);
  // $FC71: lda <$7A / beq / suba #$1B / bne $FC71 -- the sub CPU moves
  // its task index; wait until it is 0 or $1B. Each pass is 12 cycles
  // (4 + 3 + 2 + 3), charged before the SPIN of a failed pass.
  for (;;) {
    yield SYNC;
    const a = m.peek(0x107a); // sub_task
    m.charge(a === 0 ? 4 + 3 : 12);
    if (a === 0 || a === 0x1b) break;
    // a failed pass, charged: the loop's phase (integration, round 3)
    yield pollAgain(4, 3, 2, 3);
  }
  // $FC79: lda <$2F / cmpa #$09 / lbne lDA87
  yield SYNC;
  const mode = m.peek(0x102f);
  m.charge(4 + 2 + (mode === 0x09 ? 5 : 6));
  if (mode === 0x09) {
    // $FC81: ldy #$FCB3 -- (tile address, RAM address) pairs, 8 bytes
    // each, then $FC99: ldy #$FCC9 -- 14 bytes each; a 0 tile address
    // ends each list (the first by beq, the second by lbeq lDA87)
    m.charge(4);
    for (const [list, n] of [[0xfcb3, 8], [0xfcc9, 14]]) {
      if (n === 14) m.charge(4); // ldy #$FCC9
      for (let y = list; ; y += 4) {
        let u = mainWord(y);
        m.charge(8);
        if (u === 0) {
          m.charge(n === 8 ? 3 : 6); // beq / lbeq taken
          break;
        }
        m.charge(n === 8 ? 3 : 5);
        let x = mainWord(y + 2);
        m.charge(8); m.charge(2);
        for (let b = 0; b < n; b += 1) {
          const v = m.peek(u);
          m.charge(4);
          m.poke(x, v);
          m.charge(6); m.charge(5); m.charge(2); m.charge(3);
          x = (x + 1) & 0xffff;
          u = (u - 0x20) & 0xffff;
        }
        m.charge(3); // bra
      }
    }
  }
  return yield* call(mainAt(0xda87), m, {});
}

/**
 * Called by every main IRQ: with SW1:6 on ($6816 b2) and P1 fire held
 * ($6805 b1), print the BCD play clock ($09FA-$09FB) and the counters
 * $09D6-$09E0 on screen; with SW1:6 on and fire released, every 256
 * frames (frame_counter 0) count $09FF and every 8th time blank the
 * column $007A-$037A and put spaces at $031C-$037C. Charges exactly and
 * never yields (it runs inside irq_main).
 * @see gaplus-main.asm $FCDF
 * @param {Machine} m
 * @returns {{ a: number }}
 */
export function operator_stats(m) {
  // $FCDF: lda $6816 / anda #$04 / lbeq lFDEA (rts)
  const sw = m.peek(0x6816) & 0x04;
  m.charge(5 + 2 + (sw === 0 ? 6 : 5));
  if (sw === 0) {
    m.charge(5);
    return { a: 0 };
  }
  // $FCE8: lda $6805 / anda #$02 / lbeq lFDEB
  const fire = m.peek(0x6805) & 0x02;
  m.charge(5 + 2 + (fire === 0 ? 6 : 5));
  if (fire === 0) return statsIdle(m);
  /**
   * lda src / jsr bcd_hi_to_char / sta hi / lda src / jsr
   * bcd_lo_to_char / sta lo (5 + 8 + 5 each half)
   * @param {number} src @param {number} hi @param {number} lo
   */
  const digits = (src, hi, lo) => {
    for (const [name, dst] of [['bcd_hi_to_char', hi], ['bcd_lo_to_char', lo]]) {
      const v = m.peek(src);
      m.charge(5); m.charge(8);
      const c = bcdChar(m, /** @type {string} */ (name), v);
      m.poke(/** @type {number} */ (dst), c);
      m.charge(5);
    }
  };
  /** `lda #$5B / sta t`: a '.' @param {number} t */
  const dot = (t) => {
    m.charge(2);
    m.poke(t, 0x5b);
    m.charge(5);
  };
  digits(0x09fb, 0x0374, 0x0354); // clock_hours
  digits(0x09fa, 0x0334, 0x0314); // clock_minutes
  dot(0x02f4);
  digits(0x09d6, 0x02d4, 0x02b4);
  digits(0x09d7, 0x0294, 0x0274);
  digits(0x09d8, 0x0254, 0x0234);
  dot(0x0214);
  digits(0x09d9, 0x01f4, 0x01d4);
  digits(0x09da, 0x01b4, 0x0194);
  digits(0x09db, 0x0174, 0x0154);
  dot(0x0134);
  digits(0x09dc, 0x0114, 0x00f4);
  digits(0x09dd, 0x00d4, 0x00b4);
  digits(0x09de, 0x0094, 0x0074);
  digits(0x09df, 0x0376, 0x0356);
  digits(0x09e0, 0x0336, 0x0316);
  m.charge(5); // rts
  return { a: m.peek(0x0316) };
}

/**
 * bcd_hi_to_char / bcd_lo_to_char ($C287/$C28B, gp2-3b): A -> tile code.
 * They charge themselves.
 * @param {Machine} m @param {string} name @param {number} a
 * @returns {number}
 */
function bcdChar(m, name, a) {
  const r = /** @type {{ a: number }} */ (MAIN[name](m, { a }));
  return r.a & 0xff;
}

/**
 * $FDEB: operator stats on, fire released.
 * @param {Machine} m
 * @returns {{ a: number }}
 */
function statsIdle(m) {
  // lda <$16 / bne rts
  const fc = m.peek(0x1016);
  m.charge(4); m.charge(3);
  if (fc !== 0) {
    m.charge(5);
    return { a: fc };
  }
  // inc $09FF / lda $09FF / anda #$07 / bne rts
  inc(m, 0x09ff);
  const a = m.peek(0x09ff) & 0x07;
  m.charge(5); m.charge(2); m.charge(3);
  if (a !== 0) {
    m.charge(5);
    return { a };
  }
  // ldx #$037A / lda #$20 / l: clr ,x / cmpx #$007A / beq / leax -$20,x /
  // bra l
  m.charge(3); m.charge(2);
  for (let x = 0x037a; ; x -= 0x20) {
    m.peek(x); // clr reads first
    m.poke(x, 0);
    m.charge(6); m.charge(4); m.charge(3);
    if (x === 0x007a) break;
    m.charge(5); m.charge(3);
  }
  for (const t of [0x037c, 0x035c, 0x033c, 0x031c]) {
    m.poke(t, 0x20);
    m.charge(5);
  }
  m.charge(3); m.charge(5); // bra lFDEA / rts
  return { a: 0x20 };
}

/**
 * Task (mode 5): the bonus ship. When exactly one formation slot
 * ($1860-$188A, bit 0) is occupied and the slot picked by (stage +
 * score_p1) & $1F is occupied, and none is out yet ($1175 = 0), put the
 * bonus sprite in shadow slot $0F14 (sound $19). While it is out
 * ($1F15 b7), a player touching it (a box of +-8 in Y, +-4 in X) removes
 * it and wins a ship (sound $15, a life, sub_FB9E).
 * @see gaplus-main.asm $FE18
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
export function* sub_FE18(m) {
  // $FE18: lda $1F15 / anda #$80 / bne lFE72
  const out = (m.peek(0x1f15) & 0x80) !== 0;
  m.charge(5); m.charge(2); m.charge(3);
  if (out) {
    yield* touch(m);
  } else {
    // lda $1175 / bne lFE6D
    const busy = m.peek(0x1175) !== 0;
    m.charge(5); m.charge(3);
    if (!busy) yield* spawn(m);
  }
  yield* endTask(m);
}

/**
 * $FE24-$FE6A: count the occupied formation slots (stops at a second),
 * and spawn the bonus ship.
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
function* spawn(m) {
  // ldx #$1860 / clrb / l: lda ,x+ / cmpx #$188B / beq / anda #$01 /
  // beq l / incb / cmpb #$01 / bne lFE6D / bra l
  // (the byte at $188A is read, but the loop ends on the CMPX first)
  m.charge(3); m.charge(2);
  let b = 0;
  for (let x = 0x1860; ;) {
    yield SYNC;
    const a = m.peek(x);
    x += 1;
    m.charge(6); m.charge(4); m.charge(3);
    if (x === 0x188b) break;
    m.charge(2); m.charge(3);
    if ((a & 0x01) !== 0) {
      b += 1;
      m.charge(2); m.charge(2); m.charge(3);
      if (b !== 1) return;
      m.charge(3);
    }
  }
  // lFE3A: cmpb #$01 / bne lFE6D
  m.charge(2); m.charge(3);
  if (b !== 1) return;
  // ldx #$1860 / lda <$35 / adda $09B0 / anda #$1F / lda a,x (A <= $1F)
  m.charge(3);
  yield SYNC;
  const st = m.peek(0x1035);
  m.charge(4);
  yield SYNC;
  const i = (st + m.peek(0x09b0)) & 0x1f;
  m.charge(5); m.charge(2);
  yield SYNC;
  const f = m.peek(0x1860 + i);
  m.charge(5); m.charge(2); m.charge(3);
  if ((f & 0x01) === 0) return;
  m.charge(3);
  m.poke16(0x0f14, 0x0c1a);
  m.charge(6);
  // lda <$16 / anda #$AF / ora #$20 / ldb #$D0 / std $1714
  yield SYNC;
  const fc = m.peek(0x1016);
  m.charge(4); m.charge(2); m.charge(2); m.charge(2);
  m.poke16(0x1714, (((fc & 0xaf) | 0x20) << 8) | 0xd0);
  m.charge(6); m.charge(3);
  m.poke16(0x1f14, 0x4080);
  m.charge(6);
  inc(m, 0x1175);
  m.charge(2);
  yield SYNC;
  m.poke(0x6059, 0x01); // snd_request+25
  m.charge(5);
}

/**
 * $FE72-$FEAE: does the player touch the bonus ship?
 *
 *   lda $1600 / adda #$08 / cmpa $1714 / bcs out / suba #$10 /
 *   cmpa $1714 / bcc out -- the same with $1601, +4/-8, $1715
 *
 * The additions wrap in 8 bits, as on the CPU.
 * @param {Machine} m
 * @returns {Generator<unknown, void, unknown>}
 */
function* touch(m) {
  yield SYNC;
  let a = (m.peek(0x1600) + 0x08) & 0xff;
  m.charge(5); m.charge(2);
  let lt = a < m.peek(0x1714);
  m.charge(5); m.charge(3);
  if (lt) return;
  a = (a - 0x10) & 0xff;
  m.charge(2);
  lt = a < m.peek(0x1714);
  m.charge(5); m.charge(3);
  if (!lt) return;
  yield SYNC;
  a = (m.peek(0x1601) + 0x04) & 0xff;
  m.charge(5); m.charge(2);
  lt = a < m.peek(0x1715);
  m.charge(5); m.charge(3);
  if (lt) return;
  a = (a - 0x08) & 0xff;
  m.charge(2);
  lt = a < m.peek(0x1715);
  m.charge(5); m.charge(3);
  if (!lt) return;
  m.peek(0x1f15);
  m.poke(0x1f15, 0);
  m.charge(7);
  yield* sound15(m);
  const p2 = m.peek(0x102d) !== 0;
  m.charge(4); m.charge(3);
  inc(m, p2 ? 0x1105 : 0x1104);
  m.charge(8);
  yield* sub_FB9E(m);
  m.charge(3);
}

/** Routine name -> function, registered in MAIN by gp2_2b.js. */
export const ROUTINES = {
  task_bonus_life, sub_FA94, sub_FAAB, sub_FADB, sub_FB0F, sub_FB25,
  sub_FB3B, sub_FB6A, sub_FB9E, sub_FBB1, sub_FC1F, sub_FC33,
  operator_stats, sub_FE18,
};

/** Address -> function, registered in MAIN_AT by gp2_2b.js. */
export const AT = {
  0xfa7d: task_bonus_life, 0xfa94: sub_FA94, 0xfaab: sub_FAAB,
  0xfadb: sub_FADB, 0xfb0f: sub_FB0F, 0xfb25: sub_FB25, 0xfb3b: sub_FB3B,
  0xfb6a: sub_FB6A, 0xfb9e: sub_FB9E, 0xfbb1: sub_FBB1, 0xfc1f: sub_FC1F,
  0xfc33: sub_FC33, 0xfcdf: operator_stats, 0xfe18: sub_FE18,
};

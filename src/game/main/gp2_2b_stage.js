// Copyright 2026 by Moshix
/**
 * Main CPU $EA21-$ECA3 and $F4A5-$F5C3: the per-stage tasks of the play
 * modes and the stage parameter loader.
 *
 *   sub_EA21           mode 7 task: draw the challenging-stage marks
 *   sub_EA89           clear flag bytes of shadow entries parked at Y>=$E0
 *   task_stage_events  mode 1 task: starfield effects on event stages, and
 *                      the move to mode 2 (CWAI, INC game_mode)
 *   sub_EB66           mode 5 task: starfield effects on other stages
 *   load_stage_params  stage tables -> $1036-$1071, $100F-$1012, $19E0...
 *
 * The event steps are one task each, entered through tbl_EABA / tbl_EB82
 * by `JMP [A,X]` with A = step ($116E) * 2; they count frames in $116F
 * and change the starfield control latches ($A001-$A003). Most end in
 * sub_EB01 (`INC <$30 / JMP task_dispatch`): in the port they return.
 *
 * TIMING. Every routine charges (m.charge) the MAME 6809 cycles of each
 * instruction it executes, from its entry through its RTS or its final
 * `JMP task_dispatch` (a JSR is charged by the caller). An instruction is
 * charged AFTER its accesses, so m.charged[0] at an access is the cycle
 * its instruction starts. Before every instruction that touches RAM the
 * sub or sound CPU also uses (isRacy), the routine does `yield SYNC`
 * so the scheduler can interleave the CPUs there; every routine is
 * therefore a generator (callers use call()). A CWAI charges its 16
 * cycles, then yields for the frame.
 *
 * @see reference/gaplus-main.asm $EA21-$ECA3, $F4A5-$F5C3
 */

import { mainAt } from './routines.js';
import { call } from '../call.js';
import { disp8, mul } from '../m6809ops.js';
import { SYNC, isRacy } from './gp2_2b_state.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {Generator<unknown, void, unknown>} Task */

/** RAM another CPU accesses (gp2_2b_state.js RACY). */
const racy = isRacy;

/**
 * `yield SYNC` if the access at `a` (computed at run time) may race.
 * @param {number} a @returns {Generator<unknown, void, unknown>}
 */
function* syncAt(a) {
  if (racy(a & 0xffff)) yield SYNC;
}

/**
 * Read through a computed pointer (ROM or RAM), synchronised when racy.
 * @param {Machine} m @param {number} a
 * @returns {Generator<unknown, number, unknown>}
 */
function* rd(m, a) {
  yield* syncAt(a);
  return m.read('main', a & 0xffff);
}

/**
 * Write through a computed pointer, synchronised when racy.
 * @param {Machine} m @param {number} a @param {number} v
 * @returns {Generator<unknown, void, unknown>}
 */
function* wr(m, a, v) {
  yield* syncAt(a);
  m.poke(a & 0xffff, v);
}

/** @param {Machine} m @param {number} n cycles of the instruction(s) */
const ch = (m, n) => m.charge(n);

/**
 * `INC addr` on RAM (read, then write) -- not charged.
 * @param {Machine} m @param {number} addr @returns {number} the new value
 */
function inc(m, addr) {
  const v = (m.peek(addr) + 1) & 0xff;
  m.poke(addr, v);
  return v;
}

/**
 * `CLR addr`: read-modify-write, the read comes first -- not charged.
 * @param {Machine} m @param {number} addr
 */
function clr(m, addr) {
  m.peek(addr);
  m.poke(addr, 0);
}

/**
 * `INC <$30 / JMP task_dispatch` (6 + 4 cycles).
 * @param {Machine} m
 */
function* nextTask(m) {
  // (integration, round 3) the sub CPU may clear main_task: timed
  yield SYNC;
  inc(m, 0x1030);
  ch(m, 6 + 4);
}

/**
 * $EA21 sub_EA21: mode 7 task. Takes the current player's challenging
 * pattern number ($1171 P1 / $1172 P2) into $1166 and, if $1164 (count,
 * clamped to $A5) is not 0, draws that many marks of the pattern
 * (dat_A000[pattern] is a list of tile addresses; entries 0..B-1 get tile
 * $60, from the last down; an entry >= $1000 means entry-$1000 with
 * attribute $0B at entry-$0C00, else attribute $0A at entry+$400).
 * @see gaplus-main.asm $EA21
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EA21(m) {
  // $EA21: lda $1171 / ldb <$2D / beq / lda $1172 / sta $1166
  let a = m.peek(0x1171);
  ch(m, 5);
  const p2 = m.peek(0x102d) !== 0; // cur_player
  ch(m, 4 + 3);
  if (p2) {
    a = m.peek(0x1172);
    ch(m, 5);
  }
  m.poke(0x1166, a);
  ch(m, 5);
  // $EA2E: lda $1164 / beq lEA84
  yield SYNC;
  a = m.peek(0x1164);
  ch(m, 5 + 3);
  if (a !== 0) {
    // $EA33: lda $1166 / anda #7 / asla / ldx #dat_A000 / ldx a,x / clra
    const base = () => m.read16('main', 0xa000 + ((m.peek(0x1166) & 7) << 1));
    let x = base();
    ch(m, 5 + 2 + 2 + 3 + 6 + 2);
    // $EA3F: ldb $1164 / cmpb #$A5 / bcs / ldb #$A5 / stb $1164
    yield SYNC;
    let b = m.peek(0x1164);
    ch(m, 5 + 2 + 3);
    if (b >= 0xa5) {
      b = 0xa5;
      ch(m, 2);
      yield SYNC;
      m.poke(0x1164, b);
      ch(m, 5);
    }
    for (;;) {
      // $EA4B: decb / cmpb #$FF / beq lEA84
      b = (b - 1) & 0xff;
      ch(m, 2 + 2 + 3);
      if (b === 0xff) break;
      // $EA50: aslb / bcc / coma / lda #$01 -- D = B * 2 (9 bits)
      ch(m, 2 + 3 + ((b & 0x80) ? 2 + 2 : 0));
      // $EA56: ldx d,x / rorb (B restored: C was 1 exactly when it
      // shifted out a 1) / cmpx #$1000 / bcc $EA76
      const e = m.read16('main', (x + (b << 1)) & 0xffff);
      ch(m, 9 + 2 + 4 + 3);
      if (e >= 0x1000) {
        // $EA76: lda #$60 / sta -$1000,x / lda #$0B / sta -$0C00,x / bra
        ch(m, 2);
        yield* wr(m, e - 0x1000, 0x60);
        ch(m, 8 + 2);
        yield* wr(m, e - 0x0c00, 0x0b);
        ch(m, 8 + 3);
      } else {
        // $EA5E: lda #$60 / sta ,x / lda #$0A / sta $0400,x
        ch(m, 2);
        yield* wr(m, e, 0x60);
        ch(m, 4 + 2);
        yield* wr(m, e + 0x0400, 0x0a);
        ch(m, 8);
      }
      // $EA68: lda $1166 / anda #7 / asla / ldx #dat_A000 / ldx a,x /
      // clra / bra $EA4B
      x = base();
      ch(m, 5 + 2 + 2 + 3 + 6 + 2 + 3);
    }
  }
  yield* nextTask(m); // $EA84
}

/**
 * $EA89 sub_EA89: task of modes 0-6. For each of the 37 sprite shadow
 * entries $16CE-$1714 (step 2) whose Y byte is >= $E0 (parked off
 * screen), clear the matching flag byte at +$0801.
 * @see gaplus-main.asm $EA89
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EA89(m) {
  ch(m, 3); // ldx #$16CC
  // $EA8C: leax 2,x / cmpx #$1716 / beq / lda ,x / cmpa #$E0 / bcs /
  // clr $0801,x / bra
  for (let x = 0x16ce; ; x += 2) {
    ch(m, 5 + 4 + 3);
    if (x === 0x1716) break;
    const v = yield* rd(m, x);
    ch(m, 4 + 2 + 3);
    if (v >= 0xe0) {
      yield* syncAt(x + 0x0801);
      clr(m, x + 0x0801);
      ch(m, 10 + 3);
    }
  }
  yield* nextTask(m); // $EA9F
}

/**
 * Search the zero-terminated stage list at `p` for stage ($1035):
 * `lda ,x+ / beq(long) / cmpa <$35 / bne`. A stage 0 never matches.
 * @param {Machine} m @param {number} p
 * @param {number} endCycles cycles of the end-of-list branch (not taken
 *   / taken): LBEQ 5/6 at $EAA9, BEQ 3/3 at $EB73
 * @returns {Generator<unknown, boolean, unknown>}
 */
function* inList(m, p, endCycles) {
  for (;;) {
    const a = yield* rd(m, p);
    p = (p + 1) & 0xffff;
    ch(m, 6);
    if (a === 0) {
      ch(m, endCycles === 5 ? 6 : 3);
      return false;
    }
    ch(m, endCycles);
    yield SYNC;
    const st = m.peek(0x1035); // cmpa <$35
    ch(m, 4 + 3);
    if (a === st) return true;
  }
}

/**
 * Jump through a step table: `lda $116E / asla / ldx #tbl / jmp [a,x]`
 * (A,X signed), 5 + 2 + 3 + 7 cycles.
 * @param {Machine} m @param {number} tbl @returns {Task}
 */
function* stepJump(m, tbl) {
  const t = m.read16('main', disp8(tbl, (m.peek(0x116e) << 1) & 0xff));
  ch(m, 5 + 2 + 3 + 7);
  yield* call(mainAt(t), m, {});
}

/**
 * $EAA4 task_stage_events: mode 1 task. On the stages listed at $EACC
 * run event step $116E (tbl_EABA); on every other stage go straight to
 * lEB53: wait for the next frame, then advance to the next game mode.
 * @see gaplus-main.asm $EAA4
 * @param {Machine} m
 * @returns {Task}
 */
export function* task_stage_events(m) {
  ch(m, 3); // ldx #$EACC
  if (!(yield* inList(m, 0xeacc, 5))) {
    yield* lEB53(m); // $EAA9: lbeq lEB53
    return;
  }
  yield* stepJump(m, 0xeaba);
}

/**
 * $EB53: the end of the mode-1 events. `CWAI #$EF`, then next game mode,
 * both task indexes 0, and on into sub_EB5B.
 * @param {Machine} m
 * @returns {Task}
 */
function* lEB53(m) {
  // $EB53: cwai #$EF -- wait for vblank
  ch(m, 16);
  yield;
  yield SYNC;
  inc(m, 0x102f); // inc <$2F game_mode
  ch(m, 6);
  yield SYNC;
  clr(m, 0x107a); // clr <$7A sub_task
  ch(m, 6);
  clr(m, 0x1030); // clr <$30 main_task
  ch(m, 6);
  yield* sub_EB5B(m);
}

/**
 * $EB5B sub_EB5B: clear the event step $116E, its frame count $116F and
 * $107C, and jump to task_dispatch without advancing the task index.
 * Also tbl_EABA steps 3-8 (never reached: the mode-1 events stop at 2).
 * @see gaplus-main.asm $EB5B
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EB5B(m) {
  clr(m, 0x116e);
  ch(m, 7);
  clr(m, 0x116f);
  ch(m, 7);
  clr(m, 0x107c);
  ch(m, 6 + 4); // clr <$7C / jmp task_dispatch
}

/**
 * $EB01 sub_EB01: `INC <$30 / JMP task_dispatch`, the common end of the
 * event steps (also tbl_EB82 step 8: the mode-5 events are over).
 * @see gaplus-main.asm $EB01
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EB01(m) {
  yield* nextTask(m);
}

/**
 * An event step's frame count: `inc $116F / lda $116F / cmpa #n` and
 * the branch to sub_EB01 when not reached (BNE 3 or LBNE 5/6).
 * @param {Machine} m @param {number} n
 * @param {boolean} long LBNE rather than BNE
 * @returns {boolean} count reached
 */
function countTo(m, n, long) {
  inc(m, 0x116f);
  const hit = m.peek(0x116f) === n;
  ch(m, 7 + 5 + 2 + (long ? (hit ? 5 : 6) : 3));
  return hit;
}

/**
 * `lda <$2C / bne` (flip_screen, racy): 4 + 3 cycles.
 * @param {Machine} m @returns {Generator<unknown, boolean, unknown>}
 */
function* flipped(m) {
  yield SYNC;
  const f = m.peek(0x102c) !== 0;
  ch(m, 4 + 3);
  return f;
}

/**
 * `lda #v / sta addr` (2 + 5) to a starfield latch.
 * @param {Machine} m @param {number} addr @param {number} v
 */
function star(m, addr, v) {
  ch(m, 2);
  m.poke(addr, v);
  ch(m, 5);
}

/**
 * $EAD5 sub_EAD5: mode-1 event step 0. Request sound 24 every frame; at
 * frame $3C set $1170 (2, or 0 when flipped), starfield $87/$87, next
 * step.
 * @see gaplus-main.asm $EAD5
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EAD5(m) {
  ch(m, 2);
  yield SYNC;
  m.poke(0x6058, 0x01); // snd_request+24
  ch(m, 5);
  if (countTo(m, 0x3c, false)) {
    if (yield* flipped(m)) {
      clr(m, 0x1170); // $EAFC: clr $1170 / bra
      ch(m, 7 + 3);
    } else {
      ch(m, 2);
      m.poke(0x1170, 0x02);
      ch(m, 5);
    }
    star(m, 0xa003, 0x87);
    star(m, 0xa002, 0x87);
    inc(m, 0x116e);
    ch(m, 7 + 3); // inc $116E / bra sub_EB01
  }
  yield* nextTask(m);
}

/**
 * $EB06 sub_EB06: mode-1 event step 1: at frame $78 starfield $80/$80
 * ($86/$86 flipped), next step.
 * @see gaplus-main.asm $EB06
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EB06(m) {
  if (countTo(m, 0x78, false)) {
    const f = yield* flipped(m);
    // lda #v / sta $A003 / sta $A002 (flipped: + bra $EB1C)
    const v = f ? 0x86 : 0x80;
    star(m, 0xa003, v);
    m.poke(0xa002, v);
    ch(m, 5 + (f ? 3 : 0));
    inc(m, 0x116e);
    ch(m, 7 + 3); // $EB1C: inc $116E / bra sub_EB01
  }
  yield* nextTask(m);
}

/**
 * $EB2B sub_EB2B: mode-1 event step 2: at frame $B4 starfield $81/$82
 * ($86/$85 flipped), frame_counter = 7, then lEB53 (wait a frame, next
 * game mode).
 * @see gaplus-main.asm $EB2B
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EB2B(m) {
  if (!countTo(m, 0xb4, false)) {
    yield* nextTask(m);
    return;
  }
  const f = yield* flipped(m);
  // $EB39: lda #$81 / sta $A003 / inca / sta $A002 (flipped: $86, deca,
  // bra $EB42)
  star(m, 0xa003, f ? 0x86 : 0x81);
  ch(m, 2);
  m.poke(0xa002, f ? 0x85 : 0x82);
  ch(m, 5 + (f ? 3 : 0));
  // $EB42: lda #$07 / sta <$16 / bra lEB53
  ch(m, 2);
  yield SYNC;
  m.poke(0x1016, 0x07); // frame_counter
  ch(m, 4 + 3);
  yield* lEB53(m);
}

/**
 * $EB66 sub_EB66: mode 5 task. When $1010 is $10, lEC8B (set the
 * starfield for it and $1170 = 1); otherwise on the stages listed at
 * $EB94 run event step $116E (tbl_EB82).
 * @see gaplus-main.asm $EB66
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EB66(m) {
  // $EB66: lda <$10 / suba #$10 / lbeq lEC8B
  yield SYNC;
  const is10 = m.peek(0x1010) === 0x10;
  ch(m, 4 + 2 + (is10 ? 6 : 5));
  if (is10) {
    // $EC8B
    ch(m, 2);
    m.poke(0x1170, 0x01);
    ch(m, 5);
    star(m, 0xa001, 0xaf);
    star(m, 0xa003, 0xaf);
    star(m, 0xa002, 0x9f);
    // $EC9F: brn $EC59 -- "branch never": a disabled jump to the step
    // advance; falls through to jmp sub_EB01. Deliberately kept inert.
    ch(m, 3 + 4);
    yield* nextTask(m);
    return;
  }
  ch(m, 3); // ldx #$EB94
  if (!(yield* inList(m, 0xeb94, 3))) {
    yield* nextTask(m); // $EB73: beq sub_EB01
    return;
  }
  yield* stepJump(m, 0xeb82);
}

/**
 * $EB9B sub_EB9B: mode-5 event step 0: $1170 = 1, sound 24, next step.
 * @see gaplus-main.asm $EB9B
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EB9B(m) {
  ch(m, 2);
  m.poke(0x1170, 0x01);
  ch(m, 5);
  yield SYNC;
  m.poke(0x6058, 0x01); // snd_request+24
  ch(m, 5);
  inc(m, 0x116e);
  ch(m, 7 + 4); // inc $116E / jmp sub_EB01
  yield* nextTask(m);
}

/**
 * The common tail `inc $116E / jmp sub_EB01` (7 + 4) plus sub_EB01.
 * @param {Machine} m
 */
function nextStep(m) {
  inc(m, 0x116e);
  ch(m, 7 + 4);
  yield* nextTask(m);
}

/**
 * $EBA9 sub_EBA9: mode-5 step 1: at frame $32 starfield $87/$86
 * ($87/$80 flipped), next step.
 * @see gaplus-main.asm $EBA9
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EBA9(m) {
  if (!countTo(m, 0x32, true)) { yield* nextTask(m); return; }
  const f = yield* flipped(m);
  star(m, 0xa003, 0x87);
  star(m, 0xa002, f ? 0x80 : 0x86);
  if (f) ch(m, 3); // $EBD3: bra $EBC3
  nextStep(m);
}

/**
 * $EBD5 sub_EBD5: mode-5 step 2: at frame $64 starfield reg 2 = $87,
 * next step.
 * @see gaplus-main.asm $EBD5
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EBD5(m) {
  if (!countTo(m, 0x64, true)) { yield* nextTask(m); return; }
  star(m, 0xa002, 0x87);
  nextStep(m);
}

/**
 * $EBEC sub_EBEC: mode-5 step 3: at frame $96 starfield reg 2 = $80
 * ($86 flipped), next step.
 * @see gaplus-main.asm $EBEC
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EBEC(m) {
  if (!countTo(m, 0x96, true)) { yield* nextTask(m); return; }
  const f = yield* flipped(m);
  star(m, 0xa002, f ? 0x86 : 0x80);
  if (f) ch(m, 3); // $EC0C: bra $EC01
  nextStep(m);
}

/**
 * $EC0E sub_EC0E: mode-5 step 4: at frame $C8 starfield $80/$81
 * ($86/$85 flipped), next step.
 * @see gaplus-main.asm $EC0E
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EC0E(m) {
  if (!countTo(m, 0xc8, true)) { yield* nextTask(m); return; }
  const f = yield* flipped(m);
  star(m, 0xa003, f ? 0x86 : 0x80);
  star(m, 0xa002, f ? 0x85 : 0x81);
  if (f) ch(m, 3); // $EC38: bra $EC28
  nextStep(m);
}

/**
 * $EC3A sub_EC3A: mode-5 step 5: at frame $FA $1170 = 2 and starfield
 * $81/$82 (flipped: $1170 = 0, $85/$84), next step, frame count 0.
 * @see gaplus-main.asm $EC3A
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EC3A(m) {
  if (!countTo(m, 0xfa, true)) { yield* nextTask(m); return; }
  const f = yield* flipped(m);
  if (f) {
    clr(m, 0x1170);
    ch(m, 7);
    star(m, 0xa003, 0x85);
    star(m, 0xa002, 0x84);
    ch(m, 3); // $EC6F: bra $EC59
  } else {
    ch(m, 2);
    m.poke(0x1170, 0x02);
    ch(m, 5);
    star(m, 0xa003, 0x81);
    star(m, 0xa002, 0x82);
  }
  // $EC59: inc $116E / clr $116F / jmp sub_EB01
  inc(m, 0x116e);
  ch(m, 7);
  clr(m, 0x116f);
  ch(m, 7 + 4);
  yield* nextTask(m);
}

/**
 * $EC71 sub_EC71: mode-5 step 6: wait until $116F wraps to 0 (256
 * frames), next step.
 * @see gaplus-main.asm $EC71
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EC71(m) {
  // $EC71: inc $116F / lbne sub_EB01 (Z from the INC)
  const z = inc(m, 0x116f) === 0;
  ch(m, 7 + (z ? 5 : 6));
  if (z) nextStep(m); else yield* nextTask(m);
}

/**
 * $EC7E sub_EC7E: mode-5 step 7: the same 256-frame wait as sub_EC71.
 * @see gaplus-main.asm $EC7E
 * @param {Machine} m
 * @returns {Task}
 */
export function* sub_EC7E(m) {
  yield* sub_EC71(m);
}

/**
 * Copy `n` bytes from `src` (a table that ROM data indexes, so it may
 * point anywhere) to `dst`: `lda ,u+ / sta ,y+ / decb / bne`, 17 cycles
 * a byte; the store starts 6 cycles in.
 * @param {Machine} m @param {number} dst @param {number} src
 * @param {number} n
 * @returns {Generator<unknown, void, unknown>}
 */
function* copyBytes(m, dst, src, n) {
  for (let i = 0; i < n; i += 1) {
    const v = yield* rd(m, src + i);
    ch(m, 6);
    yield* wr(m, dst + i, v);
    ch(m, 6 + 2 + 3);
  }
}

/**
 * `lda ,x+` then a store of it: 6 + (4 direct / 5 extended).
 * @param {Machine} m @param {number} x @param {number} dst
 * @returns {Generator<unknown, void, unknown>}
 */
function* moveByte(m, x, dst) {
  const v = yield* rd(m, x);
  ch(m, 6);
  yield* wr(m, dst, v);
  ch(m, dst >= 0x1100 ? 5 : 4);
}

/**
 * $F4A5 load_stage_params: reduce stage ($1035) below 60 by steps of 30,
 * then from the tables indexed by difficulty ($1004) and stage:
 * $1036-$1039 (4 bytes of dat_EE84), $103A-$1041 (dat_EEA4),
 * $1042-$1049 and $104A-$1051 (dat_EEC4), $1064 (word of dat_EFC4),
 * $105A, $111C, $1119, $106F, $106E, $1070, $1012, $1071, $1102, $1103,
 * $1052-$1059 (dat_F266), $100F-$1011 (via dat_F496, +1 at difficulty
 * >= 5), and $1011's value into $19E0-$1A0C. Finally clears $106F when
 * $1070 is 0 and the dual fighter is on with $1EC3 bit 7 set.
 * @see gaplus-main.asm $F4A5
 * @param {Machine} m
 * @returns {Generator<unknown, { a: number, b: number, x: number,
 *   y: number, u: number }, unknown>} (no caller uses the registers;
 *   returned as the CPU leaves them)
 */
export function* load_stage_params(m) {
  // $F4A5: lda <$35 / (cmpa #$3C / bcs / suba #$1E / bra)*
  yield SYNC;
  let a = m.peek(0x1035);
  ch(m, 4);
  while (a >= 0x3c) {
    a -= 0x1e;
    ch(m, 2 + 3 + 2 + 3);
  }
  ch(m, 2 + 3);
  yield SYNC;
  m.poke(0x1035, a); // $F4AF: sta <$35
  ch(m, 4);
  const stage = a;
  // $F4B1: lda <$04 / asla / ldx #dat_F486 / ldx a,x -- signed offset
  let x = m.read16('main', disp8(0xf486, (m.peek(0x1004) << 1) & 0xff));
  ch(m, 4 + 2 + 3 + 6);
  // $F4B9: lda <$35 / lda a,x (stage < $3C: positive) / ldb #8 / mul /
  // ldx #dat_EFD2 / leax d,x
  yield SYNC;
  ch(m, 4);
  a = yield* rd(m, disp8(x, stage));
  ch(m, 5 + 2 + 11 + 3 + 8);
  x = (0xefd2 + mul(a, 8).v) & 0xffff;
  // Four table copies: ldu #tbl / lda ,x+ / ldb #k / mul / leau d,u /
  // ldb #n / ldy #dst, then n bytes.
  const copies = [[0xee84, 4, 0x1036], [0xeea4, 8, 0x103a],
    [0xeec4, 8, 0x1042], [0xeec4, 8, 0x104a]];
  for (const [tbl, k, dst] of copies) {
    ch(m, 3);
    a = yield* rd(m, x);
    x = (x + 1) & 0xffff;
    ch(m, 6 + 2 + 11 + 8 + 2 + 4);
    yield* copyBytes(m, dst, (tbl + mul(a, k).v) & 0xffff, k);
  }
  // $F521: ldu #dat_EFC4 / lda ,x+ / asla / ldd a,u / std <$64
  ch(m, 3);
  a = yield* rd(m, x);
  x = (x + 1) & 0xffff;
  ch(m, 6 + 2);
  const pa = disp8(0xefc4, (a << 1) & 0xff);
  yield* syncAt(pa);
  if (racy(pa + 1)) yield SYNC;
  const w = m.read16('main', pa);
  ch(m, 6);
  yield SYNC;
  m.poke16(0x1064, w);
  ch(m, 5);
  // $F52B: lda ,x+ / sta <$5A, $111C, $1119
  for (const dst of [0x105a, 0x111c, 0x1119]) {
    yield* moveByte(m, x, dst);
    x = (x + 1) & 0xffff;
  }
  // $F539: ldx #dat_F2A6 / lda <$35 / ldb #8 / mul / leax d,x
  ch(m, 3);
  yield SYNC;
  ch(m, 4 + 2 + 11 + 8);
  x = (0xf2a6 + stage * 8) & 0xffff;
  for (const dst of [0x106f, 0x106e, 0x1070, 0x1012, 0x1071, 0x1102,
    0x1103]) {
    yield* moveByte(m, x, dst);
    x = (x + 1) & 0xffff;
  }
  // $F561: lda ,x+ / ldx #dat_F266 / ldb #8 / mul / leax d,x / ldb #8 /
  // ldu #$1052, then 8 bytes (lda ,x+ / sta ,u+ / decb / bne)
  a = yield* rd(m, x);
  ch(m, 6 + 3 + 2 + 11 + 8 + 2 + 3);
  yield* copyBytes(m, 0x1052, (0xf266 + mul(a, 8).v) & 0xffff, 8);
  // $F577: clr <$11 / ldb <$04 / cmpb #$05 / bcs / ldb #$01 / stb <$11
  clr(m, 0x1011);
  ch(m, 6);
  const hard = m.peek(0x1004) >= 0x05;
  ch(m, 4 + 2 + 3);
  if (hard) {
    ch(m, 2);
    m.poke(0x1011, 0x01);
    ch(m, 4);
  }
  // $F583: ldx #dat_F1B2 / lda <$35 / ldb #3 / mul / leax d,x; then for
  // $100F, $1010, $1011: lda ,x+ / adda <$11 / ldu #dat_F496 (first
  // only) / lda a,u (signed) / sta <dst. The third add still uses the old
  // $1011: it is stored after.
  ch(m, 3);
  yield SYNC;
  ch(m, 4 + 2 + 11 + 8);
  const d3 = mul(stage, 3);
  x = (0xf1b2 + d3.v) & 0xffff;
  const dsts = [0x100f, 0x1010, 0x1011];
  for (let i = 0; i < 3; i += 1) {
    const b = yield* rd(m, x);
    x = (x + 1) & 0xffff;
    ch(m, 6);
    const idx = (b + m.peek(0x1011)) & 0xff;
    ch(m, 4 + (i === 0 ? 3 : 0));
    a = yield* rd(m, disp8(0xf496, idx));
    ch(m, 5);
    yield* wr(m, dsts[i], a);
    ch(m, 4);
  }
  // $F5A8: ldx #$19E0 / (sta ,x+ / cmpx #$1A0D / bne)*
  ch(m, 3);
  for (let p = 0x19e0; p < 0x1a0d; p += 1) {
    yield* wr(m, p, a);
    ch(m, 6 + 4 + 3);
  }
  // $F5B2: lda <$70 / bne / lda <$DB / beq / lda $1EC3 / anda #$80 /
  // beq / clr <$6F / rts
  yield SYNC;
  a = m.peek(0x1070);
  ch(m, 4 + 3);
  if (a === 0) {
    yield SYNC;
    a = m.peek(0x10db); // dual_fighter
    ch(m, 4 + 3);
    if (a !== 0) {
      yield SYNC;
      a = m.peek(0x1ec3) & 0x80;
      ch(m, 5 + 2 + 3);
      if (a !== 0) {
        yield SYNC;
        clr(m, 0x106f);
        ch(m, 6);
      }
    }
  }
  ch(m, 5); // rts
  return { a, b: d3.v & 0xff, x: 0x1a0d, y: 0x1052, u: 0xf496 };
}

/** Routine name -> function, registered in MAIN by gp2_2b.js. */
export const ROUTINES = {
  sub_EA21, sub_EA89, task_stage_events, sub_EAD5, sub_EB01, sub_EB06,
  sub_EB2B, sub_EB5B, sub_EB66, sub_EB9B, sub_EBA9, sub_EBD5, sub_EBEC,
  sub_EC0E, sub_EC3A, sub_EC71, sub_EC7E, load_stage_params,
};

/** Address -> function, registered in MAIN_AT by gp2_2b.js. */
export const AT = {
  // mode task lists ($FEC0) and tbl_EABA / tbl_EB82 entries
  0xea21: sub_EA21, 0xea89: sub_EA89, 0xeaa4: task_stage_events,
  0xead5: sub_EAD5, 0xeb01: sub_EB01, 0xeb06: sub_EB06, 0xeb2b: sub_EB2B,
  0xeb5b: sub_EB5B, 0xeb66: sub_EB66, 0xeb9b: sub_EB9B, 0xeba9: sub_EBA9,
  0xebd5: sub_EBD5, 0xebec: sub_EBEC, 0xec0e: sub_EC0E, 0xec3a: sub_EC3A,
  0xec71: sub_EC71, 0xec7e: sub_EC7E,
  // called by JSR from $D823 and $DC4A
  0xf4a5: load_stage_params,
};

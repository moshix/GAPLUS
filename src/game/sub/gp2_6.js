// Copyright 2026 by Moshix
/**
 * Sub CPU, ROM gp2-6.11b ($E000-$FFFF): reset, IRQ handler, the task
 * scheduler and the tasks of the sub's per-mode task lists.
 *
 * This file holds the CPU's skeleton and registers every routine of the
 * chip into SUB / SUB_AT; the tasks themselves live in helper files by
 * address range, each exporting a `ROUTINES` map (address -> function):
 *
 *   gp2_6.js        $E000-$E17F reset_sub, irq_sub, task_dispatch_sub,
 *                   task_end_frame_sub
 *   gp2_6_stage.js  $E18A-$E5A9 stage setup, formation sprites
 *   gp2_6_e5.js     $E5AA-$EBEB
 *   gp2_6_eb.js     $EBEC-$F5A4
 *   gp2_6_f5.js     $F5A5-$FA2D
 *   gp2_6_fa.js     $FA2E-$FFFF
 *
 * Task convention (the whole sub CPU): a task is the code a task list
 * entry points at, up to its `JMP task_dispatch_sub`. The port's task is
 * a function `(m) => void` (a generator if it can CWAI) that does exactly
 * that work and returns; returning *is* the `JMP task_dispatch_sub`, and
 * task_dispatch_sub loops. Whatever a task leaves on the 6809 stack when
 * it jumps back is thrown away by the next `lds #$1D80`, and the port has
 * no stack, so the loop is exact.
 *
 * Yields: see gp2_6_state.js (bare yield = next frame, SYNC, SPIN, BUSY,
 * RENDEZVOUS). Timing: every routine charges its 6809 cycles and SYNCs
 * before each shared access (the contract in gp2_6_state.js).
 * What the scheduler must do: docs/modules/sub-E.md.
 */

import { SUB, SUB_AT, subAt } from './routines.js';
import { call } from '../call.js';
import { poll } from '../timing.js';
import { disp8 } from '../m6809ops.js';
import {
  SPIN, RENDEZVOUS, BUSY, SYNC, rd, rd16, wr, wr16, rmw, CLR,
} from './gp2_6_state.js';
import { ROUTINES as STAGE } from './gp2_6_stage.js';
import { ROUTINES as E5 } from './gp2_6_e5.js';
import { ROUTINES as EB } from './gp2_6_eb.js';
import { ROUTINES as F5 } from './gp2_6_f5.js';
import { ROUTINES as FA } from './gp2_6_fa.js';

export { SPIN, RENDEZVOUS, BUSY, SYNC };

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {import('../../machine/machine.js').CpuView} CpuView */

// ---------------------------------------------------------------- reset

/**
 * reset_sub ($E000): the sub CPU's foreground from the RESET vector.
 * Waits for the main CPU's $11 in sub_handshake ($0800), checksums its
 * three ROMs (a bad one leaves '6'/'5'/'4' in sub_rom_error $0801),
 * answers $22, writes IRQ_ON_SUB ($6001) and the unmapped $500F 256
 * times, unmasks IRQs and runs task_dispatch_sub for good.
 *
 * Timing: charges every instruction from $E000 (the 4-cycle vector fetch
 * is the scheduler's). The $11 poll is src/game/timing.js poll(): SYNC
 * before each read of $0800, a failed pass charged and marked with its
 * loop cycles (the scheduler keeps its phase); the pass that sees $11 is
 * charged here. The checksum loops touch only ROM:
 * 3 x 8,192 x 13 cycles charged in three lumps, so the scheduler spends
 * the 13 frames there, and the writes that follow ($0801 on a bad sum,
 * $22, the IRQ latch) are SYNC'd at their own cycles. Never returns.
 * @see gaplus-sub.asm $E000
 * @param {Machine} m
 * @returns {Generator<symbol|undefined, void, void>}
 */
export function* reset_sub(m) {
  const s = m.sub;
  // $E000: orcc #$10 (3) / lda #$10 (2) / tfr a,dp (6) / lds #$1D80 (4)
  s.sei();
  s.charge(3); s.charge(2); s.charge(6); s.charge(4);
  // $E00A: lda $0800 (5) / cmpa #$11 (2) / bne $E00A (3)
  // (integration, round 3: an exact poll loop, src/game/timing.js)
  yield* poll(s, 0x0800, (v) => v === 0x11, [5, 2, 3]); // sub_handshake
  s.charge(5); s.charge(2); s.charge(3);
  // $E011: clra (2) / clr $0801 (7, reads first)
  s.charge(2);
  yield* rmw(s, 0x0801, CLR, 7); // sub_rom_error
  // $E015: ldx #$A000 (3), then per ROM: the sum loop (13 cycles a byte:
  // adda ,x+ 6 / cmpx # 4 / bne 3), cmpa #0 (2) / beq (3), and on a bad
  // sum lda #'n' (2) / sta $0801 (5). Between ROMs: ldd #$0000 (3),
  // which also clears A for the next sum.
  s.charge(3);
  const roms = [[0xa000, 0xc000, 0x36], [0xc000, 0xe000, 0x35],
    [0xe000, 0x0000, 0x34]];
  for (let i = 0; i < roms.length; i += 1) {
    const [from, to, code] = roms[i];
    if (i > 0) s.charge(3);
    const sum = romSum(s, from, to);
    s.charge(((to - from) & 0xffff) * 13 + 2 + 3);
    if (sum !== 0) {
      s.charge(2);
      yield* wr(s, 0x0801, code, 5); // sub_rom_error
    }
  }
  // $E04E: lda #$22 (2) / sta $0800 (5) -- the handshake answer
  s.charge(2);
  yield* wr(s, 0x0800, 0x22, 5); // sub_handshake
  // $E053: sta $6001 (5) / sta $500F (5) / decb (2) / bne (3) -- B is 0
  // from the ldd #$0000, so 256 passes; $500F is unmapped (no SYNC)
  for (let b = 256; b > 0; b -= 1) {
    yield* wr(s, 0x6001, 0x22, 5); // IRQ_ON_SUB (odd address: mask on)
    s.poke(0x500f, 0x22); // unmapped in MAME, still a bus write
    s.charge(5); s.charge(2); s.charge(3);
  }
  // $E05C: andcc #$EF (3) -- the scheduler takes a pending IRQ at the
  // next yield after this
  yield SYNC;
  s.cli();
  s.charge(3);
  // $E05E: jmp task_dispatch_sub (4)
  s.charge(4);
  yield* task_dispatch_sub(m);
}

/**
 * Byte sum (mod 256) of the sub ROM from `from` up to, not including,
 * `to` (0 = $10000): the `adda ,x+ / cmpx #to / bne` loops at $E018,
 * $E02B and $E03E. The ROM is read through the sub's bus like the CPU
 * does; its cycles are charged by the caller.
 * @param {CpuView} s @param {number} from @param {number} to
 * @returns {number}
 */
function romSum(s, from, to) {
  let a = 0;
  let x = from;
  do {
    a = (a + s.read(x)) & 0xff;
    x = (x + 1) & 0xffff;
  } while (x !== to);
  return a;
}

// ------------------------------------------------------------------ IRQ

/**
 * irq_sub ($E061): the sub CPU's vblank IRQ handler.
 *
 * Acknowledges (IRQ_OFF_SUB $6080), copies the sub's sprites from the
 * shadow buffers $0E00-$0EE1 (+$0800 bank $1600, +$1000 bank $1E00; bit 7
 * of the $1E01+n byte = in use) into sprite RAM slots 1-39 ($0F82-$0FCF
 * and the $1782/$1F82 banks), mirrored when flip_screen ($102C) is set,
 * parks the unused slots at $F000, then posts $11 in frame_sync ($10AF)
 * and waits for the main CPU's IRQ handler to answer $22, and re-enables
 * its IRQ ($6081) before the RTI.
 *
 * Timing: charges every instruction from $E061 to the RTI (15 cycles,
 * the entire state is pulled); the 19-cycle entry (4 from a CWAI) is the
 * scheduler's. Every shared access is SYNC'd (gp2_6_state.js). The poll of
 * $10AF is src/game/timing.js poll() (failed passes charged and marked,
 * so the scheduler keeps the loop's phase); the pass that sees $22 is
 * charged here. RTI restores CC.I = 0: the sub is
 * only ever interrupted in a CWAI or after its ANDCC.
 * @see gaplus-sub.asm $E061
 * @param {Machine} m
 * @returns {Generator<symbol, void, void>}
 */
export function* irq_sub(m) {
  const s = m.sub;
  // $E061: sta $6080 -- acknowledge; A holds whatever the interrupted
  // code had, and the latch ignores the data, so the value is moot.
  yield* wr(s, 0x6080, 0, 5);
  s.charge(3); s.charge(3); // ldu #$0E00 / ldx #$0F82
  let u = 0x0e00; // sprite_shadow_1
  let x = 0x0f82; // SPRITE_RAM_1+2 (slot 1)
  for (;;) {
    // $E06A: cmpu #$0EE2 (5) / beq irq_sub_disable_rest (3)
    s.charge(5); s.charge(3);
    if (u === 0x0ee2) break;
    // $E070: lda $1001,u (8) / anda #$80 (2) / bne (3); not in use:
    // leau 2,u (5) / bra (3)
    const used = yield* rd(s, u + 0x1001, 8);
    s.charge(2); s.charge(3);
    if ((used & 0x80) === 0) { s.charge(5 + 3); u += 2; continue; }
    const flip = yield* rd(s, 0x102c, 4); // flip_screen
    s.charge(3);
    if (flip !== 0) {
      // $E080: Y mirrored around $E0 (or $D0 for a double-height sprite,
      // flag bit 5); the size/flag byte is copied as is.
      s.charge(2); // lda #$E0
      let a = 0xe0;
      const b = yield* rd(s, u + 0x1000, 8);
      yield* wr(s, x + 0x1000, b, 8);
      s.charge(2); s.charge(3); // andb #$20 / beq
      if ((b & 0x20) !== 0) { s.charge(2); a = 0xd0; }
      a = (a - (yield* rd(s, u + 0x0800, 8))) & 0xff;
      yield* wr(s, x + 0x0800, a, 8);
      // $E098: lda $1001,u / anda #$01 / ldb $0801,u / subd #$01A0 /
      // coma / comb -- the 9-bit X becomes ~(X - $1A0), 16 bits wide
      const hi9 = (yield* rd(s, u + 0x1001, 8)) & 0x01;
      s.charge(2);
      const lo8 = yield* rd(s, u + 0x0801, 8);
      s.charge(4); s.charge(2); s.charge(2);
      const d = ~(((hi9 << 8) | lo8) - 0x01a0) & 0xffff;
      yield* wr(s, x + 0x0801, d & 0xff, 8); // stb $0801,x
      yield* wr(s, x + 0x1001, d >> 8, 8); // sta $1001,x
      s.charge(3); // bra $E0C1
    } else {
      // $E0B1: ldd $1000,u / std $1000,x / ldd $0800,u / std $0800,x
      yield* wr16(s, x + 0x1000, yield* rd16(s, u + 0x1000, 9), 9);
      yield* wr16(s, x + 0x0800, yield* rd16(s, u + 0x0800, 9), 9);
    }
    // $E0C1: ldd ,u++ (8) / std ,x++ (8) / cmpx #$0FD0 (4) / bne (3)
    yield* wr16(s, x, yield* rd16(s, u, 8), 8);
    u += 2;
    x += 2;
    s.charge(4); s.charge(3);
    if (x === 0x0fd0) break;
  }
  // $E0CA irq_sub_disable_rest: cmpx #$0FD0 (4) / beq (3); the slots
  // left get $F000 in all banks: ldd #$F000 (3) / std $1000,x (9) /
  // std $0800,x (9) / std ,x++ (8) / bra (3)
  for (;;) {
    s.charge(4); s.charge(3);
    if (x === 0x0fd0) break;
    s.charge(3);
    yield* wr16(s, x + 0x1000, 0xf000, 9);
    yield* wr16(s, x + 0x0800, 0xf000, 9);
    yield* wr16(s, x, 0xf000, 8);
    x += 2;
    s.charge(3);
  }
  // $E0DE irq_sub_sync: lda #$11 (2) / sta <$AF (4), then
  // $E0E2: lda <$AF (4) / cmpa #$22 (2) / bne $E0E2 (3)
  s.charge(2);
  yield* wr(s, 0x10af, 0x11, 4); // frame_sync
  // (integration, round 3: an exact poll loop, src/game/timing.js)
  yield* poll(s, 0x10af, (v) => v === 0x22, [4, 2, 3]);
  s.charge(4); s.charge(2); s.charge(3);
  // $E0E8: sta $6081 (A = $22) -- IRQ on again; rti (15: entire state)
  yield* wr(s, 0x6081, 0x22, 5);
  s.charge(15);
}

// ------------------------------------------------------------ scheduler

/**
 * task_dispatch_sub ($E0EC): the sub CPU's task loop. Runs
 * sub_mode_task_lists[game_mode][sub_task] ($E0F9, game_mode $102F,
 * sub_task $107A) over and over; each task returns where the ROM jumps
 * back here, and the lists end with task_end_frame_sub, which waits for
 * the next frame. Never returns.
 *
 * Timing: charges its 28 cycles per dispatch; SYNC before the reads of
 * game_mode and sub_task (the main CPU writes game_mode) and once more
 * right before each task starts (the lead's request: every task begins
 * at a timing point, whatever chip it is in).
 * @see gaplus-sub.asm $E0EC
 * @param {Machine} m
 * @returns {Generator<symbol|undefined, void, void>}
 */
export function* task_dispatch_sub(m) {
  const s = m.sub;
  for (;;) {
    // $E0EC: ldu #$E0F9 (3) / lda <$2F (4) / ldb <$7A (4) / asla (2) /
    // ldu a,u (6) / aslb (2) / jmp [b,u] (7) -- asla/aslb are 8-bit and
    // a,u / b,u signed offsets
    s.charge(3);
    const a = ((yield* rd(s, 0x102f, 4)) << 1) & 0xff; // game_mode
    const b = ((yield* rd(s, 0x107a, 4)) << 1) & 0xff; // sub_task
    s.charge(2);
    const list = yield* rd16(s, disp8(0xe0f9, a), 6);
    s.charge(2);
    const task = yield* rd16(s, disp8(list, b), 7);
    yield SYNC;
    yield* call(subAt(task), m);
  }
}

/**
 * task_end_frame_sub ($E17F): the last task of every list. CWAI for the
 * next vblank IRQ (one bare yield; the IRQ handler runs there), throw the
 * stack away, clear sub_task ($107A) so the list restarts.
 * @see gaplus-sub.asm $E17F
 * @param {Machine} m
 * @returns {Generator<symbol|undefined, void, void>}
 */
export function* task_end_frame_sub(m) {
  const s = m.sub;
  // $E17F: cwai #$EF (16) -- wait for vblank (CC.I cleared, state
  // stacked); the 4-cycle wake-up is the scheduler's
  s.charge(16);
  yield;
  // $E181: lds #$1D80 (4) / clr <$7A (6, reads first) / jmp $E0EC (4)
  s.charge(4);
  yield* rmw(s, 0x107a, CLR, 6); // sub_task
  s.charge(4);
}

// --------------------------------------------------------- registration

/** The routines defined in this file, by entry address. */
const CORE = {
  0xe000: reset_sub,
  0xe061: irq_sub,
  0xe0ec: task_dispatch_sub,
  0xe17f: task_end_frame_sub,
};

for (const table of [CORE, STAGE, E5, EB, F5, FA]) {
  for (const [addr, fn] of Object.entries(table)) {
    SUB[fn.name] = fn;
    SUB_AT[Number(addr)] = fn;
  }
}

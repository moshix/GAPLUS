// Copyright 2026 by Moshix
/**
 * Main CPU $E000-$E219: the power-on / watchdog reset (`reset_main`), the
 * custom I/O chip self-check, the boot handshake with the sub and sound
 * CPUs, the DIP switch decoding and the coinage programming.
 *
 * TIMING. The main IRQ is off for the whole boot, which burns real time
 * (RAM clears with a watchdog read per word, seven calls of delay_65536).
 * Every stretch between observable actions is charged to the foreground
 * cycle clock (gp2_2b_state.js burn()), which yields once per frame, so
 * each write lands in the same frame as on the board. The cycle counts in
 * the comments are MAME's 6809 timings and were checked against the
 * oracle's power-on run (test/oracle/main-gp2_2b_boot.test.mjs):
 *
 *   $E000  frame   0, cycle     4   (reset vector fetch before it)
 *   $E037  frame   3, cycle 10,555  first delay_65536
 *   $E0C7  frame  96, cycle 17,095  SRESET released
 *   $E0E8  frame 109, cycle  7,274  both handshakes seen (sub/sound time)
 *   $E1DB  frame 233, cycle 23,319  jmp game_init
 *
 * @see reference/gaplus-main.asm $E000-$E219
 */

import { MAIN } from './routines.js';
import { call } from '../call.js';
import { mainWord, mainRom } from '../romdata.js';
import { SPIN, burn, setClock, FRAME_CYCLES } from '../clock.js';
import { SYNC } from './gp2_2b_state.js';

/** @typedef {import('../../machine/machine.js').Machine} Machine */

/**
 * Cycle of frame 0 at which the main CPU executes $E000 after power-on
 * (MAME's reset: 4 cycles for the vector fetch). The power-on driver sets
 * the clock to this before starting reset_main.
 */
export const POWER_ON_CYCLE = 4;

/**
 * Cycle (of frame 109 on the oracle) at which the main CPU leaves the
 * sub-CPU handshake loop and executes $E0E8. It depends on how long the
 * sub and sound CPUs take for their ROM checksums, which the port cannot
 * time from here, so the clock is re-synchronised to it after the wait.
 */
export const HANDSHAKE_DONE_CYCLE = 7274;

/**
 * Cycles delay_65536 ($BE25) takes from its first instruction through
 * its RTS: PSHS D 7, LDD 3, 65,536 x (LDY 7 + INCA 2 + BNE 3), 256 x
 * (INCB 2 + BNE 3), PULS D 7, RTS 5. The caller's JSR (8) or LBSR (9) is
 * charged by the caller. Measured: 787,734 (oracle-notes.md section 4).
 */
export const DELAY_65536_CYCLES = 787734;

/**
 * JSR delay_65536 from boot code: the call's own cycles are charged here,
 * the delay's by the routine itself (see gp2_2b_state.js and
 * docs/requests/main-E.md: delay_65536 must burn DELAY_65536_CYCLES on
 * the shared clock).
 * @param {Machine} m
 * @param {number} callCycles 8 for JSR extended, 9 for LBSR
 * @returns {Generator<unknown, void, unknown>}
 */
function* delay(m, callCycles) {
  yield* burn(m, callCycles);
  yield* call(MAIN.delay_65536, m, {});
}

/**
 * $E000 reset_main: power-on / watchdog reset, and the target of the
 * service mode's exit ($BDA8 JMP reset_main). Holds the sub and sound
 * CPUs in reset, clears the tilemap and RAM, checks the three custom I/O
 * chips, releases the other CPUs and waits for their checksums, decodes
 * the DIP switches and goes to the service mode or to game_init. Never
 * returns.
 *
 * The caller sets the foreground clock first (POWER_ON_CYCLE at power-on;
 * from the service mode it simply continues).
 * @see gaplus-main.asm $E000
 * @param {Machine} m
 * @returns {Generator<unknown, unknown, unknown>}
 */
export function* reset_main(m) {
  // $E000: orcc #$10 -- DP is still 0 here on the power-on path, but no
  // direct-page access happens before the tfr a,dp.
  m.sei();
  yield* burn(m, 3);
  // $E002: sta $8C00 / sta $9400 / sta $7C00 -- latches decoded by
  // address; the value (A at reset) does not matter.
  m.poke(0x8c00, 0);
  yield* burn(m, 5);
  m.poke(0x9400, 0);
  yield* burn(m, 5);
  m.poke(0x7c00, 0);
  // sta 5, lda #$10 2, tfr a,dp 6, lds #$1600 4, ldd #$01FF 3
  yield* burn(m, 5 + 2 + 6 + 4 + 3);
  // $E016: std $6808 -- 56XX command 1 (switches), arg 9 = F
  m.poke16(0x6808, 0x01ff);
  yield* burn(m, 6);
  // $E019: clr $6818 -- read-modify-write: reads the 58XX first
  m.peek(0x6818);
  m.poke(0x6818, 0);
  // clr 7, ldx #0 3, ldu #$0020 3
  yield* burn(m, 7 + 3 + 3);

  // $E022: stu ,x++ / cmpx #$0400 / bne -- tilemap = $00,$20 pairs.
  // 15 cycles per word; each store lands in the frame it starts in.
  for (let x = 0x0000; x !== 0x0400; x += 2) {
    m.poke16(x, 0x0020);
    yield* burn(m, 15);
  }
  // $E029: ldu #$0000
  yield* burn(m, 3);
  // $E02C: ldy $7C00 / stu ,x++ / cmpx #$2000 / bne -- clear $0400-$1FFF.
  // LDY reads $7C00 and $7C01: two watchdog kicks per word. 22 cycles
  // per word; the store starts 7 cycles into the iteration.
  for (let x = 0x0400; x !== 0x2000; x += 2) {
    m.peek16(0x7c00);
    yield* burn(m, 7);
    m.poke16(x, 0x0000);
    yield* burn(m, 15);
  }
  // $E037: jsr delay_65536 -- wait for the chips
  yield* delay(m, 8);
  // $E03A: ldd #$0000 / sta $A000 / stb $1F7F
  yield* burn(m, 3);
  m.poke(0xa000, 0x00); // starfield off
  yield* burn(m, 5);
  m.poke(0x1f7f, 0x00); // no flip
  // stb 5, ldb #$04 2
  yield* burn(m, 5 + 2);

  // $E045: stb $6828..$682F with B = 4, 5, ..., $0B (incb between):
  // 62XX bytes 8-15. 7 cycles per byte (stb 5 + incb 2).
  for (let i = 0; i < 8; i += 1) {
    m.poke(0x6828 + i, 4 + i);
    yield* burn(m, i < 7 ? 7 : 5);
  }

  // $E064: ldd #$080F / ldu #$6808 / ldx #$6818 / sta ,u+ / lda #$05 /
  // sta ,x+ -- 56XX mode 8 and 58XX mode 5 (the self-check)
  yield* burn(m, 3 + 3 + 3);
  m.poke(0x6808, 0x08);
  yield* burn(m, 6 + 2);
  m.poke(0x6818, 0x05);
  yield* burn(m, 6);
  // $E073: lbsr delay_65536
  yield* delay(m, 9);
  // $E076: stb ,u+ / stb ,x+ / cmpu #$6810 / bne -- args 9-15 = F on
  // both chips, interleaved. 20 cycles per pass.
  for (let i = 0; i < 7; i += 1) {
    m.poke(0x6809 + i, 0x0f);
    yield* burn(m, 6);
    m.poke(0x6819 + i, 0x0f);
    yield* burn(m, 14);
  }
  // $E080: lbsr delay_65536
  yield* delay(m, 9);

  // $E083: ldd $6800 / anda #$0F / andb #$0F / cmpd #$0609 / beq
  // -- 56XX mode 8: the sum of args 9-15 (7 x F = $69) as two nibbles.
  // (ldd reads $6800 then $6801.)
  let hi = m.peek(0x6800) & 0x0f;
  let lo = m.peek(0x6801) & 0x0f;
  // ldd 6, anda 2, andb 2, cmpd 5, beq 3
  yield* burn(m, 18);
  if (hi !== 0x06 || lo !== 0x09) {
    // $E090: ldd #$2031 / bra boot_chip_error -- error '1': 56XX
    yield* burn(m, 3 + 3);
    return yield* boot_chip_error(m, { d: 0x2031 });
  }
  // $E095: ldd $6810 ... cmpd #$0F0F -- 58XX mode 5 gives F,F
  hi = m.peek(0x6810) & 0x0f;
  lo = m.peek(0x6811) & 0x0f;
  yield* burn(m, 18);
  if (hi !== 0x0f || lo !== 0x0f) {
    // $E0A2: ldd #$2032 / bra boot_chip_error -- error '2': 58XX
    yield* burn(m, 3 + 3);
    return yield* boot_chip_error(m, { d: 0x2032 });
  }
  // $E0A7: 62XX bytes 1, 2, 3 must read F, E, 1 (each: lda 5 / anda 2 /
  // cmpa 2 / bne-beq 3). The first mismatch goes to $E0C2.
  const want = [0x0f, 0x0e, 0x01];
  for (let i = 0; i < 3; i += 1) {
    const v = m.peek(0x6821 + i) & 0x0f;
    yield* burn(m, 12);
    if (v !== want[i]) {
      // $E0C2: ldd #$2033 -- error '3': 62XX
      yield* burn(m, 3);
      return yield* boot_chip_error(m, { d: 0x2033 });
    }
  }
  return yield* boot_handshake(m);
}

/**
 * $E0C5 boot_chip_error: `bra *` -- an I/O chip failed its check. The
 * error code ('1' 56XX, '2' 58XX, '3' 62XX in B, $20 in A) stays in D and
 * nothing is drawn; the watchdog (armed by the RAM clear's reads) resets
 * the board 3 s after the last kick. The port spins on the clock, one
 * yield per frame, forever; the watchdog reset is the scheduler's.
 * @see gaplus-main.asm $E0C5
 * @param {Machine} m
 * @param {{ d?: number }} [_regs] the error code (not observable)
 * @returns {Generator<unknown, never, unknown>}
 */
export function* boot_chip_error(m, _regs = {}) {
  // $E0C5: bra * (3 cycles a pass; whole frames at a time)
  for (;;) yield* burn(m, FRAME_CYCLES);
}

/**
 * $E0C7 boot_handshake: release the sub and sound CPUs, write $11 to
 * the sound CPU's $0040 ($6040) and the sub CPU's $0800, and wait for
 * both to answer $22 (their ROM checksums are done). The waits poll RAM
 * that the other CPUs' FOREGROUND writes, so they `yield SPIN`; the
 * clock is re-synchronised at the end (HANDSHAKE_DONE_CYCLE). Then the
 * switch/DIP reading and the rest of the boot.
 * @see gaplus-main.asm $E0C7
 * @param {Machine} m
 * @returns {Generator<unknown, unknown, unknown>}
 */
export function* boot_handshake(m) {
  // $E0C7: sta $8400 -- SRESET off: the sub and sound CPUs start
  m.poke(0x8400, 0);
  // sta 5, lda #$11 2
  yield* burn(m, 5 + 2);
  // $E0CC: sta $6040 / sta $0800 -- the sound and sub CPUs, running
  // now, poll these: timing points
  yield SYNC;
  m.poke(0x6040, 0x11);
  yield* burn(m, 5);
  yield SYNC;
  m.poke(0x0800, 0x11);
  yield* burn(m, 5);
  // $E0D2: lda $6040 / ldy $7C00 / cmpa #$22 / bne $E0D2
  // (ldy reads $7C00 and $7C01: two watchdog kicks per pass)
  for (;;) {
    const a = m.peek(0x6040);
    m.peek16(0x7c00);
    if (a === 0x22) break;
    yield SPIN;
  }
  // $E0DD: lda $0800 / ldy $7C00 / cmpa #$22 / bne $E0DD
  for (;;) {
    const a = m.peek(0x0800);
    m.peek16(0x7c00);
    if (a === 0x22) break;
    yield SPIN;
  }
  // Where the oracle's main CPU is now depends on the other CPUs.
  setClock(m, HANDSHAKE_DONE_CYCLE);
  return yield* boot_after_handshake(m);
}

/**
 * $E0E8-$E173: the boot after the handshake (no label in the listing;
 * exported so the tests can start here). Writes $0000 over $7820-$782F
 * (the IRQ-off latch: harmless), puts both chips in mode 0, then the 56XX
 * in mode 1 (switches) and the 58XX in mode 4 (DIPs), copies the four
 * switch nibbles to $1006-$1009 and decodes the DIP switches into
 * coinage ($1025-$1028), lives ($1000), difficulty ($1004), cabinet
 * ($1005) and the bonus-life settings ($1001-$1003). Continues at
 * boot_check_service.
 * @see gaplus-main.asm $E0E8
 * @param {Machine} m
 * @returns {Generator<unknown, unknown, unknown>}
 */
export function* boot_after_handshake(m) {
  // ldd #$0000 3, ldx #$7820 3
  yield* burn(m, 3 + 3);
  // $E0EE: std ,x++ / cmpx #$7830 / bne -- 15 cycles a pass; every
  // byte written is an IRQ-off latch write
  for (let x = 0x7820; x !== 0x7830; x += 2) {
    m.poke16(x, 0x0000);
    yield* burn(m, 15);
  }
  // $E0F5: sta $6808 / sta $6818 -- both chips command 0 (A = 0)
  m.poke(0x6808, 0x00);
  yield* burn(m, 5);
  m.poke(0x6818, 0x00);
  // sta 5, deca 2 (A = $FF, unused: the delay saves D and E0FF reloads)
  yield* burn(m, 5 + 2);
  // $E0FC: jsr delay_65536
  yield* delay(m, 8);
  // $E0FF: ldd #$0104 / sta $6808 / stb $6818 -- 56XX mode 1, 58XX mode 4
  yield* burn(m, 3);
  m.poke(0x6808, 0x01);
  yield* burn(m, 5);
  m.poke(0x6818, 0x04);
  yield* burn(m, 5);
  // $E108: jsr delay_65536
  yield* delay(m, 8);
  // ldu #$6800 3, ldx #$1006 3
  yield* burn(m, 3 + 3);
  // $E111: lda ,u+ / anda #$0F / sta ,x+ / cmpu #$6804 / bne -- the
  // switch nibbles to boot_switches $1006-$1009 (22 cycles a pass; the
  // store starts 8 cycles in)
  for (let i = 0; i < 4; i += 1) {
    const v = m.peek(0x6800 + i) & 0x0f;
    yield* burn(m, 8);
    m.poke(0x1006 + i, v);
    yield* burn(m, 14);
  }

  // $E11D: lda $6811 / ldy $7C00 / anda #$03 / asla / ldx #$E176 /
  // ldx a,x / ldd ,x / std <$25 -- coin A (coins, credits)
  let a = m.peek(0x6811);
  yield* burn(m, 5);
  m.peek16(0x7c00);
  // ldy 7, anda 2, asla 2, ldx # 3, ldx a,x 6, ldd ,x 5
  yield* burn(m, 7 + 2 + 2 + 3 + 6 + 5);
  // (a & 3) << 1 is at most 6: the signed a,x offset is never negative
  let p = mainWord(0xe176 + ((a & 0x03) << 1));
  m.poke16(0x1025, mainWord(p)); // coinage_a
  yield* burn(m, 5);
  // $E130: lda $6817 / anda #$03 / asla / ldx #$E186 / ldx a,x / ldd ,x /
  // std <$27 -- coin B
  a = m.peek(0x6817);
  yield* burn(m, 5 + 2 + 2 + 3 + 6 + 5);
  p = mainWord(0xe186 + ((a & 0x03) << 1));
  m.poke16(0x1027, mainWord(p)); // coinage_b
  yield* burn(m, 5);
  // $E13F: lda $6811 / lsra / lsra / anda #$03 / ldx #$E196 / lda a,x /
  // sta <$00 -- lives
  a = m.peek(0x6811);
  yield* burn(m, 5 + 2 + 2 + 2 + 3 + 5);
  m.poke(0x1000, mainRom(0xe196 + ((a >> 2) & 0x03))); // lives_setting
  yield* burn(m, 4);
  // $E14D: lda $6814 / anda #$07 / ldx #$E19A / lda a,x / sta <$04
  a = m.peek(0x6814);
  yield* burn(m, 5 + 2 + 3 + 5);
  m.poke(0x1004, mainRom(0xe19a + (a & 0x07))); // difficulty
  yield* burn(m, 4);
  // $E159: lda $6820 / anda #$04 / sta <$05 -- cabinet (62XX IN2)
  a = m.peek(0x6820);
  yield* burn(m, 5 + 2);
  m.poke(0x1005, a & 0x04); // cabinet
  yield* burn(m, 4);
  // $E160: lda $6812 / anda #$07 / asla / ldx #$E1A2 / ldx a,x /
  // ldd ,x++ / std <$01 / lda ,x / sta <$03 -- bonus life
  a = m.peek(0x6812);
  yield* burn(m, 5 + 2 + 2 + 3 + 6 + 8);
  p = mainWord(0xe1a2 + ((a & 0x07) << 1));
  m.poke16(0x1001, mainWord(p)); // bonus_first, bonus_second
  yield* burn(m, 5 + 4);
  m.poke(0x1003, mainRom(p + 2)); // bonus_every
  // sta 4, $E173: jmp boot_check_service 4
  yield* burn(m, 4 + 4);
  return yield* boot_check_service(m);
}

/**
 * $E1CA boot_check_service: with the service switch on ($6814 b3) go to
 * the service mode ($B6F6, gp2-4); otherwise program the coinage, wait
 * once more and go to game_init ($C296, gp2-3b). Never returns.
 * @see gaplus-main.asm $E1CA
 * @param {Machine} m
 * @returns {Generator<unknown, unknown, unknown>}
 */
export function* boot_check_service(m) {
  // $E1CA: lda $6814 / anda #$08 / lbne service_mode
  const a = m.peek(0x6814);
  if ((a & 0x08) !== 0) {
    // lda 5, anda 2, lbne taken 6
    yield* burn(m, 5 + 2 + 6);
    return yield* call(MAIN.service_mode, m, {});
  }
  // lda 5, anda 2, lbne not taken 5, $E1D3: bsr program_coinage 7
  yield* burn(m, 5 + 2 + 5 + 7);
  yield* program_coinage(m);
  // rts 5 (charged by program_coinage), $E1D5: ldd #$0000 3
  yield* burn(m, 3);
  // $E1D8: jsr delay_65536
  yield* delay(m, 8);
  // $E1DB: jmp game_init (4 cycles)
  yield* burn(m, 4);
  return yield* call(MAIN.game_init, m, {});
}

/**
 * $E1DE program_coinage: pulse FRESET (the 56XX coin counters restart),
 * write the coinage from $1025-$1028 to 56XX args 9-12 and run mode 2,
 * then fill the whole tilemap $0000-$03FF with spaces ($2020 words):
 * sub_E20A twice 16 words, then 14 x 2 x 16 words, then it falls into
 * sub_E20A again. Returns with U = $0400.
 * @see gaplus-main.asm $E1DE
 * @param {Machine} m
 * @returns {Generator<unknown, { u: number, a: number, b: number },
 *   unknown>}
 */
export function* program_coinage(m) {
  // $E1DE: sta $9C00 -- FRESET on: resets the 56XX coin counters
  m.poke(0x9c00, 0);
  yield* burn(m, 5);
  // $E1E1: jsr delay_65536
  yield* delay(m, 8);
  // $E1E4: sta $9400 -- FRESET off
  m.poke(0x9400, 0);
  // sta 5, ldd <$25 5
  yield* burn(m, 5 + 5);
  // $E1E9: std $6809 / ldd <$27 / std $680B -- coinage to 56XX args 9-12
  m.poke16(0x6809, m.peek16(0x1025));
  yield* burn(m, 6 + 5);
  m.poke16(0x680b, m.peek16(0x1027));
  // std 6, lda #$02 2
  yield* burn(m, 6 + 2);
  // $E1F3: sta $6808 -- 56XX mode 2 (set coinage)
  m.poke(0x6808, 0x02);
  yield* burn(m, 5);
  // $E1F6: ldu #$0000 (3) / bsr sub_E20A (7) / ldb #$0E (2). The fill
  // is 7,268 cycles, stamped store by store like the rest.
  yield* burn(m, 3 + 7);
  let u = (yield* sub_E20A(m, { u: 0x0000 })).u;
  yield* burn(m, 2);
  let b = 0x0e;
  // $E1FD: ldx #$2020 / bsr fill_16_words (x2) / decb / bne $E1FD
  do {
    yield* burn(m, 3 + 7);
    u = (yield* fill_16_words(m, { x: 0x2020, u })).u;
    yield* burn(m, 3 + 7);
    u = (yield* fill_16_words(m, { x: 0x2020, u })).u;
    b -= 1;
    yield* burn(m, 2 + 3);
  } while (b !== 0);
  // falls into sub_E20A, whose fill_16_words' RTS returns to $E1D5
  u = (yield* sub_E20A(m, { u })).u;
  return { u, a: 0, b: 0 };
}

/**
 * $E20A sub_E20A: store $2020 at U++ 32 times (two fill_16_words).
 * @see gaplus-main.asm $E20A
 * @param {Machine} m
 * @param {{ u: number }} regs
 * @returns {Generator<unknown, { u: number, a: number, x: number },
 *   unknown>} U past the last word; 443 cycles (the final RTS included)
 */
export function* sub_E20A(m, { u }) {
  // $E20A: ldx #$2020 (3) / bsr fill_16_words (7)
  yield* burn(m, 3 + 7);
  const r = yield* fill_16_words(m, { x: 0x2020, u });
  // $E20F: ldx #$2020 (3), then falls into fill_16_words
  yield* burn(m, 3);
  return yield* fill_16_words(m, { x: 0x2020, u: r.u });
}

/**
 * $E212 fill_16_words: store X at ,U++ sixteen times.
 *
 *   $E212: lda #$10 / stx ,u++ / deca / bne $E214 / rts
 *
 * Charges 2 + 16 x 13 + 5 = 215 cycles on the boot clock.
 * @see gaplus-main.asm $E212
 * @param {Machine} m
 * @param {{ x: number, u: number }} regs
 * @returns {Generator<unknown, { u: number, a: number, x: number },
 *   unknown>} U += 32, A = 0
 */
export function* fill_16_words(m, { x, u }) {
  yield* burn(m, 2);
  let p = u;
  for (let i = 0; i < 16; i += 1) {
    // stx ,u++ 8 / deca 2 / bne 3
    m.poke16(p, x);
    p = (p + 2) & 0xffff;
    yield* burn(m, 8 + 2 + 3);
  }
  yield* burn(m, 5);
  return { u: p, a: 0, x };
}

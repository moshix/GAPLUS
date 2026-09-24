// Copyright 2026 by Moshix
/**
 * Main CPU ROM gp2-3b.8c, $D28A-$D8AF: the player's shots against the
 * formation and the enemy shots/objects, the stage-progress checks, and
 * the stage clear / stage start tasks.
 *
 *   $D28A  sub_D28A          shots vs formation and objects, scoring
 *   $D431  sub_D431          a hit: record it, spawn the score sprite
 *   $D588  sub_D588          count the formation, trigger mode changes
 *   $D676  task_stage_clear  mode 6: next stage, back to mode 0
 *   $D71B  task_stage_start  mode 0: PARSEC nn / CHALLENGING STAGE
 *
 * All five are tasks (or called from one) run by task_dispatch ($FEB5,
 * gp2-2b): they end with `inc <$30 / jmp task_dispatch` (or clear $30),
 * which in the port is a plain return. They are generators: the CWAIs
 * yield (plain `yield`).
 *
 * TIMING. The sub CPU works on the same RAM in the same part of the
 * frame (e.g. sub_D431's `ldd ,u` at $D434 reads an enemy position the
 * sub is moving; task_stage_start's clears race sub stores). So every
 * instruction that writes RAM or I/O, or reads RAM $0800-$1FFF or I/O,
 * is preceded by `yield* s()` (busy(m, 0): yield SYNC), with
 * m.charged[0] = the cycle the instruction starts at; the instruction's
 * own cycles are charged after its accesses. The PSHS/PULS of
 * $D534/$D572 touch only the (private) stack and are not synced; ROM
 * table reads and tile-RAM reads need none either.
 * @see reference/gaplus-main.asm $D28A-$D8AF
 */

import { MAIN } from './routines.js';
import { call } from '../call.js';
import { disp8 } from '../m6809ops.js';
import { busy } from './gp2_3b_state.js';
import { SYNC } from '../timing.js';
import { romSweep } from '../romdata.js';

/**
 * A read of the formation scan's pointer X ($D2E6 `lda ,x+`, `lda -1,x`
 * at $D2F1 / $D35A). The scan ends when X equals formation_end ($112D);
 * when that changes under it (from $188D to $188C at the start of play,
 * while X is at $188D), the ROM's scan runs on through all 64 KB, about
 * 280 frames, reading the ROMs as data too: a whole-ROM sweep
 * (romdata.js romSweep). It also reads the three CPUs' stacks, which
 * the port does not hold (machine.js STACKS), so from there the port
 * can differ from the ROM (docs/oracle-notes.md section 8).
 * @param {Machine} m @param {number} addr @returns {number}
 */
const scanRead = (m, addr) => romSweep('main', () => m.peek(addr & 0xffff));

/** @typedef {import('../../machine/machine.js').Machine} Machine */
/** @typedef {Generator<unknown, void, unknown>} Gen */

/**
 * `inc` of a RAM byte (8-bit wrap); returns the new value.
 * @param {Machine} m @param {number} a @returns {number}
 */
function inc(m, a) {
  const v = (m.peek(a) + 1) & 0xff;
  m.poke(a, v);
  return v;
}

/**
 * The inlined string printer: `lda ,u+ / beq / sta ,x / leax -$20,x /
 * bra` (21 cycles a character, 9 for the terminator). Going right on
 * screen is decreasing tile addresses. Returns X after the string.
 * @param {Machine} m @param {number} x tile address @param {number} u
 * @returns {Generator<unknown, number, unknown>}
 */
function* printR(m, x, u) {
  for (;;) {
    const a = m.read('main', u); // ROM string
    u += 1;
    m.charge(6); m.charge(3);
    if (a === 0) return x;
    yield* busy(m, 0);
    m.poke(x, a);
    x = (x - 0x20) & 0xffff;
    m.charge(4); m.charge(5); m.charge(3);
  }
}

/**
 * $D28A sub_D28A: the player's shots. Count down $1131; every 128 frames
 * clear $1F2F. Then for each shot slot whose flag ($1EA3/$1EA5/$1EA7,
 * bit 7) is set, build a hit box from its position ($16A2...):
 * $10C6 = y + $1100 + $10DD, $10C7 = max(0, max(0, $10C6 - $1101) -
 * $10DE) (each step clamps at 0), $10C8 = x + 10 ($FF on a carry),
 * $10C9 = x + 10 - $14 (clamped at 0 only without the carry) and $10CA =
 * the shot's flag bit 0 (bit 8 of X).
 *
 *  - lD534: the objects $0EE2-$0F12 (flag bit 7, same bit 0) inside the
 *    box: remember it in $100B, take it out of use (unless $106E bit 0
 *    and its code is $3C/$3D), and clear the shot's flag.
 *  - else lD2DD: the formation slots n ($1860+n, until X reaches the
 *    word at $112D) with bit 0 clear: bit 1 clear -> position at
 *    $1B00+2n, only for shots with bit 0 clear; bit 1 set -> the live
 *    sprite at $1630+2n (flag $1E31+2n bit 7, same bit 0). Inside the
 *    box: points (by slot type), flag = 1, sound $0B (or $0A with
 *    $115F), sub_D431, add_score 10 x $1113 times, and the same shot is
 *    tested again (it is not cleared: it goes on through the formation).
 *    A $C2 slot (the boss) scores 10, 20, 40, 80 ... (doubling up to
 *    64 while $1131 counts down) and shows a bonus sprite at $0F2E.
 *
 * Finally lD301 clears the shots flagged in $1076 and ends the task.
 * @see gaplus-main.asm $D28A
 * @param {Machine} m
 * @returns {Gen}
 */
export function* sub_D28A(m) {
  const ch = (/** @type {number} */ n) => m.charge(n);
  const s = () => busy(m, 0);
  // $D28A: lda $1131 / beq / dec $1131
  yield* s();
  const t = m.peek(0x1131);
  ch(5); ch(3);
  if (t !== 0) {
    yield* s();
    m.poke(0x1131, (m.peek(0x1131) - 1) & 0xff);
    ch(7);
  }
  // $D292: lda <$16 / anda #$7F / bne / clr $1F2F
  yield* s();
  const f = m.peek(0x1016);
  ch(4); ch(2); ch(3);
  if ((f & 0x7f) === 0) {
    yield* s();
    m.poke(0x1f2f, 0);
    ch(7);
  }
  // $D29B: ldx #$1EA3 / stx <$C2
  ch(3);
  yield* s();
  m.poke16(0x10c2, 0x1ea3);
  ch(5);

  let x = 0;
  let u = 0;
  let a = 0;
  let b = 0;
  let lbl = 0xd2a0;
  for (;;) {
    switch (lbl) {
      case 0xd2a0: // ldx <$C2
        yield* s();
        x = m.peek16(0x10c2);
        ch(5);
        lbl = 0xd2a2;
        break;

      case 0xd2a2: { // next shot with flag bit 7
        ch(4); ch(3); // cmpx #$1EA9 / beq $D301
        if (x === 0x1ea9) { lbl = 0xd301; break; }
        yield* s();
        a = m.peek(x);
        x = (x + 2) & 0xffff;
        ch(7); ch(2); ch(3); // lda ,x++ / anda #$80 / beq
        if ((a & 0x80) === 0) break;
        yield* s();
        m.poke16(0x10c2, x);
        ch(5);
        // $D2AF: ldd -$0803,x -- the shot's Y/X in the $1600 bank
        yield* s();
        const d = m.peek16((x - 0x803) & 0xffff);
        a = d >> 8;
        b = d & 0xff;
        ch(9);
        // adda $1100 / adda <$DD / sta <$C6
        yield* s();
        a = (a + m.peek(0x1100)) & 0xff;
        ch(5);
        yield* s();
        a = (a + m.peek(0x10dd)) & 0xff;
        ch(4);
        yield* s();
        m.poke(0x10c6, a);
        ch(4);
        // suba $1101 / bcc / clra, then suba <$DE / bcc / clra
        for (const [src, cyc] of [[0x1101, 5], [0x10de, 4]]) {
          yield* s();
          const r = a - m.peek(src);
          ch(cyc + 3);
          if (r < 0) { a = 0; ch(2); } else a = r;
        }
        yield* s();
        m.poke(0x10c7, a);
        ch(4);
        // addb #$0A / bcs $D2F9
        const sum = b + 0x0a;
        ch(2); ch(3);
        if (sum > 0xff) {
          // $D2F9: lda #$FF / sta <$C8 / subb #$14 / bra -- no clamp
          ch(2);
          yield* s();
          m.poke(0x10c8, 0xff);
          b = (sum - 0x14) & 0xff;
          ch(4); ch(2); ch(3);
        } else {
          b = sum;
          yield* s();
          m.poke(0x10c8, b);
          const r = b - 0x14;
          ch(4); ch(2); ch(3);
          if (r < 0) { b = 0; ch(2); } else b = r;
        }
        // $D2D2: stb <$C9 / lda -2,x / anda #1 / sta <$CA / jmp $D534
        yield* s();
        m.poke(0x10c9, b);
        ch(4);
        yield* s();
        a = m.peek((x - 2) & 0xffff) & 0x01;
        ch(5); ch(2);
        yield* s();
        m.poke(0x10ca, a);
        ch(4); ch(4);
        lbl = 0xd534;
        break;
      }

      case 0xd534: { // pshs u,x: the objects $0EE2-$0F12
        ch(9); ch(3);
        let o = 0x0ee0;
        let hit = false;
        for (;;) {
          o += 2;
          ch(5); ch(4); ch(3);
          if (o === 0x0f14) break;
          yield* s();
          let v = m.peek(o + 0x1001);
          ch(8); ch(2); ch(3);
          if ((v & 0x80) === 0) continue;
          yield* s();
          v = m.peek(o + 0x1001) & 0x01;
          ch(8); ch(2);
          yield* s();
          const ca = m.peek(0x10ca);
          ch(4); ch(3);
          if (v !== ca) continue;
          yield* s();
          const d = m.peek16(o + 0x0800);
          const oy = d >> 8;
          const ox = d & 0xff;
          ch(9);
          // cmpb <$C8 / bcc, cmpb <$C9 / bcs, cmpa <$C6 / bcc,
          // cmpa <$C7 / bcs: outside the box -> next object
          yield* s();
          const c8 = m.peek(0x10c8);
          ch(4); ch(3);
          if (ox >= c8) continue;
          yield* s();
          const c9 = m.peek(0x10c9);
          ch(4); ch(3);
          if (ox < c9) continue;
          yield* s();
          const c6 = m.peek(0x10c6);
          ch(4); ch(3);
          if (oy >= c6) continue;
          yield* s();
          const c7 = m.peek(0x10c7);
          ch(4); ch(3);
          if (oy < c7) continue;
          // stx <$0B / lda <$6E / anda #1 / bne $D57E
          yield* s();
          m.poke16(0x100b, o);
          ch(5);
          yield* s();
          const e = m.peek(0x106e);
          ch(4); ch(2); ch(3);
          let keep = false;
          if (e & 0x01) {
            // $D57E: lda ,x / anda #$FE / cmpa #$3C / beq $D572
            yield* s();
            const code = m.peek(o);
            ch(4); ch(2); ch(2); ch(3);
            if ((code & 0xfe) === 0x3c) keep = true;
            else ch(3);
          }
          if (!keep) {
            yield* s();
            m.poke(o + 0x1001, 0); // $D56E: clr $1001,x
            ch(10);
          }
          hit = true;
          break;
        }
        ch(9); // puls x,u
        if (hit) {
          // $D574: clr -2,x (the shot's flag) / jmp $D2A2
          yield* s();
          m.poke((x - 2) & 0xffff, 0);
          ch(7); ch(4);
          lbl = 0xd2a2;
        } else {
          ch(4); // jmp $D2DD
          lbl = 0xd2dd;
        }
        break;
      }

      case 0xd2dd: // ldx #$1860 / lda #$FF / sta <$C4
        x = 0x1860;
        ch(3); ch(2);
        yield* s();
        m.poke(0x10c4, 0xff);
        ch(4);
        lbl = 0xd2e4;
        break;

      case 0xd2e4: { // next formation slot with bit 0 clear
        yield* s();
        inc(m, 0x10c4);
        ch(6);
        yield* s();
        a = scanRead(m, x);
        x = (x + 1) & 0xffff;
        ch(6);
        // cmpx $112D / beq $D2A0
        yield* s();
        const end = m.peek16(0x112d);
        ch(7); ch(3);
        if (x === end) { lbl = 0xd2a0; break; }
        ch(2); ch(3); // anda #1 / bne $D2E4
        if (a & 0x01) break;
        // lda -1,x / anda #2 / beq $D31A / bra $D32C
        yield* s();
        const v = scanRead(m, x - 1);
        ch(5); ch(2); ch(3);
        if ((v & 0x02) === 0) {
          lbl = 0xd31a;
        } else {
          ch(3);
          lbl = 0xd32c;
        }
        break;
      }

      case 0xd31a: { // a slot in formation: position at $1B00 + 2n
        yield* s();
        const ca = m.peek(0x10ca);
        ch(4); ch(3); // lda <$CA / bne $D2E4
        if (ca !== 0) { lbl = 0xd2e4; break; }
        // lda <$C4 / asla / ldu #$1B00 / leau a,u (signed) / ldd ,u /
        // clr <$C5 / bra $D34A
        yield* s();
        u = disp8(0x1b00, (m.peek(0x10c4) << 1) & 0xff);
        ch(4); ch(2); ch(3); ch(5);
        yield* s();
        const d = m.peek16(u);
        a = d >> 8;
        b = d & 0xff;
        ch(5);
        yield* s();
        m.poke(0x10c5, 0);
        ch(6); ch(3);
        lbl = 0xd34a;
        break;
      }

      case 0xd32c: { // a diving enemy: its sprite at $1630 + 2n
        yield* s();
        u = disp8(0x1630, (m.peek(0x10c4) << 1) & 0xff);
        ch(4); ch(2); ch(3); ch(5);
        yield* s();
        let v = m.peek(u + 0x0801);
        ch(8); ch(2); ch(3);
        if ((v & 0x80) === 0) { lbl = 0xd2e4; break; }
        yield* s();
        v = m.peek(u + 0x0801) & 0x01;
        ch(8); ch(2);
        yield* s();
        const ca = m.peek(0x10ca);
        ch(4); ch(3);
        if (v !== ca) { lbl = 0xd2e4; break; }
        yield* s();
        m.poke(0x10c5, v);
        ch(4);
        yield* s();
        const d = m.peek16(u);
        a = d >> 8;
        b = d & 0xff;
        ch(5);
        lbl = 0xd34a;
        break;
      }

      case 0xd34a: { // inside the hit box?
        yield* s();
        const c8 = m.peek(0x10c8);
        ch(4); ch(3);
        if (b >= c8) { lbl = 0xd2e4; break; }
        yield* s();
        const c9 = m.peek(0x10c9);
        ch(4); ch(3);
        if (b < c9) { lbl = 0xd2e4; break; }
        yield* s();
        const c6 = m.peek(0x10c6);
        ch(4); ch(3);
        if (a >= c6) { lbl = 0xd2e4; break; }
        yield* s();
        const c7 = m.peek(0x10c7);
        ch(4); ch(3);
        if (a < c7) { lbl = 0xd2e4; break; }
        // lda -1,x / cmpa #$C2 / bne $D3B9
        yield* s();
        a = scanRead(m, x - 1);
        ch(5); ch(2); ch(3);
        if (a === 0xc2) yield* hitBoss(m, u);
        else yield* hitOther(m, x, a);
        yield* hitScore(m, u, x);
        // $D421: ldx <$C2 / leax -2,x / stx <$C2 / lda $115F /
        // lbeq $D2A2 (the same shot again) / jmp $D301
        yield* s();
        x = (m.peek16(0x10c2) - 2) & 0xffff;
        ch(5); ch(5);
        yield* s();
        m.poke16(0x10c2, x);
        ch(5);
        yield* s();
        const sc = m.peek(0x115f);
        ch(5);
        if (sc === 0) {
          ch(6);
          lbl = 0xd2a2;
        } else {
          ch(5); ch(4);
          lbl = 0xd301;
        }
        break;
      }

      case 0xd301: { // clear the shots that hit (bits of $1076); done
        yield* s();
        let v = m.peek(0x1076);
        ch(4); ch(2); ch(3);
        if (v & 0x01) {
          yield* s();
          m.poke(0x1ea3, 0);
          ch(7);
        }
        yield* s();
        v = m.peek(0x1076);
        ch(4); ch(2); ch(3);
        if (v & 0x02) {
          yield* s();
          m.poke(0x1ea5, 0);
          ch(7);
        }
        yield* s();
        m.poke(0x1076, 0);
        ch(6);
        yield* s();
        yield SYNC; // main_task: the sub CPU may clear it
        inc(m, 0x1030); // main_task
        ch(6); ch(4);
        return;
      }

      default:
        throw new Error(`sub_D28A: bad label ${lbl}`);
    }
  }
}

/**
 * $D360-$D39F: the boss ($C2) was hit. Unless $1131 is still counting,
 * restart the chain ($1112 = 1, $1066 = 0); then $1131 = $20, double
 * $1112 (up to $40) into $1113, and put the bonus sprite: code/colour
 * from dat_D3A1[$1066] (indexed on past the table as $1066 grows) at
 * $0F2E, Y + $10 and X of the boss at $172E, flags $60 / boss byte 1 at
 * $1F2E.
 * @param {Machine} m @param {number} u the boss's position
 * @returns {Gen}
 */
function* hitBoss(m, u) {
  const ch = (/** @type {number} */ n) => m.charge(n);
  const s = () => busy(m, 0);
  yield* s();
  const t = m.peek(0x1131);
  ch(5); ch(3); // lda $1131 / bne $D36C
  if (t === 0) {
    ch(2);
    yield* s();
    m.poke(0x1112, 1);
    ch(5);
    yield* s();
    m.poke(0x1066, 0);
    ch(6);
  }
  ch(2);
  yield* s();
  m.poke(0x1131, 0x20);
  ch(5);
  yield* s();
  let a = m.peek(0x1112);
  ch(5); ch(2); ch(3); // lda $1112 / cmpa #$40 / beq $D37E
  if (a !== 0x40) {
    yield* s();
    m.poke(0x1112, (m.peek(0x1112) << 1) & 0xff); // asl $1112
    ch(7);
    yield* s();
    a = m.peek(0x1112);
    ch(5);
  }
  yield* s();
  m.poke(0x1113, a);
  ch(5); ch(4);
  // ldy #$D3A1 / lda <$66 / asla / ldd a,y (signed; ROM) / std $0F2E
  yield* s();
  const i = (m.peek(0x1066) << 1) & 0xff;
  ch(4); ch(2);
  const w = m.read16('main', disp8(0xd3a1, i));
  ch(6);
  yield* s();
  m.poke16(0x0f2e, w);
  ch(6);
  yield* s();
  inc(m, 0x1066);
  ch(6);
  // ldd ,u / adda #$10 / std $172E / ldd $0800,u / lda #$60 / std $1F2E
  yield* s();
  const d = m.peek16(u);
  ch(5); ch(2);
  yield* s();
  m.poke16(0x172e, (((d >> 8) + 0x10) & 0xff) << 8 | (d & 0xff));
  ch(6);
  yield* s();
  const fl = m.peek16(u + 0x0800);
  ch(9); ch(2);
  yield* s();
  m.poke16(0x1f2e, 0x6000 | (fl & 0xff));
  ch(6); ch(3);
}

/**
 * $D3B9-$D3E8: any other slot was hit. Bit 1 of its flag set (a diving
 * enemy): $1113 = 1, 2, 3 or 4 by the slot's row (X < $1875, $187F,
 * $1887); otherwise $1113 = 1. $1112 = 1, $1066 = 0 either way.
 * @param {Machine} m @param {number} x formation pointer (slot + 1)
 * @param {number} a the slot's flag byte
 * @returns {Gen}
 */
function* hitOther(m, x, a) {
  const ch = (/** @type {number} */ n) => m.charge(n);
  const s = () => busy(m, 0);
  ch(2); ch(3); // anda #2 / beq $D3E0
  // $D3E0: lda #1 / sta $1112 / sta $1113 / clr <$66, or
  // $D3BD: deca / sta $1113 / sta $1112 / clr <$66 (the other order)
  const order = (a & 0x02) === 0 ? [0x1112, 0x1113] : [0x1113, 0x1112];
  ch(2);
  for (const addr of order) {
    yield* s();
    m.poke(addr, 1);
    ch(5);
  }
  yield* s();
  m.poke(0x1066, 0);
  ch(6);
  if ((a & 0x02) === 0) return;
  for (const lim of [0x1875, 0x187f, 0x1887]) {
    ch(4); ch(3); // cmpx #lim / bcs $D3EA
    if (x < lim) return;
    yield* s();
    inc(m, 0x1113);
    ch(7);
  }
  ch(3); // bra $D3EA
}

/**
 * $D3EA-$D420: the hit sound ($604A with $115F, else $604B), the slot's
 * flag = 1, $1076 = the shot's bit (1 for the $1EA3 shot, 2 for the
 * others), sub_D431, clear the diving enemy's flag byte ($0801,U) if
 * <$C5, then add_score(1) $1113 times.
 * @param {Machine} m @param {number} u the enemy's position
 * @param {number} x formation pointer (slot + 1)
 * @returns {Gen}
 */
function* hitScore(m, u, x) {
  const ch = (/** @type {number} */ n) => m.charge(n);
  const s = () => busy(m, 0);
  yield* s();
  const sc = m.peek(0x115f);
  ch(5); ch(3); // lda $115F / beq $D3F6
  ch(2);
  yield* s();
  m.poke(sc !== 0 ? 0x604a : 0x604b, 1);
  ch(sc !== 0 ? 5 + 3 : 5);
  // $D3FB: sta -1,x (A = 1) / clra / ldx <$C2 / cmpx #$1EA5 / bne /
  // ora #1 / bra -- or ora #2 -- / sta <$76 (not OR'ed with the old
  // value: a second hit in the same pass replaces it)
  yield* s();
  m.poke((x - 1) & 0xffff, 1);
  ch(5); ch(2);
  yield* s();
  const p = m.peek16(0x10c2);
  ch(5); ch(4); ch(3);
  const a = p === 0x1ea5 ? 1 : 2;
  ch(p === 0x1ea5 ? 2 + 3 : 2);
  yield* s();
  m.poke(0x1076, a);
  ch(4); ch(7); // sta <$76 / bsr sub_D431
  yield* sub_D431(m, { u });
  yield* s();
  const c5 = m.peek(0x10c5);
  ch(4); ch(3); // lda <$C5 / beq
  if (c5 !== 0) {
    yield* s();
    m.poke(u + 0x0801, 0);
    ch(10);
  }
  // $D417: lda #1 / jsr add_score / dec $1113 / bne $D417
  let n;
  do {
    ch(2); ch(8);
    yield* call(MAIN.add_score, m, { a: 1 });
    yield* s();
    n = (m.peek(0x1113) - 1) & 0xff;
    m.poke(0x1113, n);
    ch(7); ch(3);
  } while (n !== 0);
}

/**
 * $D431 sub_D431: an enemy at U was hit. Count it ($1108), note its
 * position ($1109-$110A) and type ($110B = $80 | <$C5). If $1102 & $1075
 * is non-zero, put a score sprite ($4F) in the first free object slot of
 * $0ECE-$0EDA: the enemy's position, flags $00/<its X bit 8> (or
 * $00,$80 for a formation enemy), and at $0C92,X a speed word from one
 * of three tables (by the enemy's X: < $A0, < $D0, above) indexed by
 * (y + $50 - player_y) / 8, at most $14.
 *
 * The `ldd ,u` at $D434 is the known race with the sub CPU, which moves
 * that enemy at about the same time: like every access here it is
 * preceded by a SYNC yield.
 * @see gaplus-main.asm $D431
 * @param {Machine} m
 * @param {{ u: number }} regs U = the enemy's position (Y, X)
 * @returns {Gen}
 */
export function* sub_D431(m, { u }) {
  const ch = (/** @type {number} */ n) => m.charge(n);
  const s = () => busy(m, 0);
  yield* s();
  inc(m, 0x1108);
  ch(7);
  yield* s(); // $D434: the race read
  let d = m.peek16(u);
  ch(5);
  yield* s();
  m.poke16(0x1109, d);
  ch(6); ch(2);
  yield* s();
  const a = 0x80 | m.peek(0x10c5);
  ch(4);
  yield* s();
  m.poke(0x110b, a);
  ch(5);
  // lda $1102 / anda <$75 / beq rts
  yield* s();
  const k = m.peek(0x1102);
  ch(5);
  yield* s();
  const k2 = m.peek(0x1075);
  ch(4); ch(3);
  if ((k & k2) === 0) {
    ch(5);
    return;
  }
  let x = 0x0ecc;
  ch(3);
  for (;;) {
    x += 2;
    ch(5); ch(4); ch(3); // leax 2,x / cmpx #$0EDC / beq rts
    if (x === 0x0edc) {
      ch(5);
      return;
    }
    yield* s();
    const v = m.peek(x + 0x1001);
    ch(8); ch(2); ch(3); // lda $1001,x / anda #$80 / bne
    if ((v & 0x80) === 0) break;
  }
  // ldd #$4F00 / std ,x / ldd ,u / std $0800,x / lda <$C5 / beq $D4B1
  ch(3);
  yield* s();
  m.poke16(x, 0x4f00);
  ch(5);
  yield* s();
  d = m.peek16(u);
  ch(5);
  yield* s();
  m.poke16(x + 0x0800, d);
  ch(9);
  yield* s();
  const c5 = m.peek(0x10c5);
  ch(4); ch(3);
  if (c5 !== 0) {
    // ldd $0800,u / lda #0: flags 0 and the enemy's X bit 8 byte
    yield* s();
    d = m.peek16(u + 0x0800) & 0xff;
    ch(9); ch(2);
  } else {
    d = 0x0080; // $D4B1: ldd #$0080 / bra
    ch(3); ch(3);
  }
  yield* s();
  m.poke16(x + 0x1000, d); // $D46E: std $1000,x
  ch(9); ch(2);
  // clra / ldb ,u / addd #$50 / exg d,y / clra / ldb player_y / coma /
  // comb / addd #1 / leay d,y / exg d,y / exg a,b / clrb:
  // A = low byte of (y + $50 - player_y), B = 0
  yield* s();
  const ey = m.peek(u);
  ch(4); ch(4); ch(8); ch(2);
  yield* s();
  const py = m.peek(0x1600);
  ch(5); ch(2); ch(2); ch(4); ch(8); ch(8); ch(8); ch(2);
  let ra = (ey + 0x50 - py) & 0xff;
  let rb = 0;
  // $D48A: suba #8 / bcs / incb / cmpb #$14 / bne
  for (;;) {
    const r = ra - 8;
    ra = r & 0xff;
    ch(2); ch(3);
    if (r < 0) break;
    rb += 1;
    ch(2); ch(2); ch(3);
    if (rb === 0x14) break;
  }
  // $D493: ldy #$D4B6 / lda 1,u / cmpa #$A0 / bcs / ldy #$D4E0 /
  // cmpa #$D0 / bcs / ldy #$D50A
  let y = 0xd4b6;
  ch(4);
  yield* s();
  const ex = m.peek(u + 1);
  ch(5); ch(2); ch(3);
  if (ex >= 0xa0) {
    y = 0xd4e0;
    ch(4); ch(2); ch(3);
    if (ex >= 0xd0) {
      y = 0xd50a;
      ch(4);
    }
  }
  // $D4A9: aslb / ldd b,y (ROM) / std $0C92,x / rts
  const w = m.read16('main', disp8(y, (rb << 1) & 0xff));
  ch(2); ch(6);
  yield* s();
  m.poke16((x + 0x0c92) & 0xffff, w);
  ch(9); ch(5);
}

/**
 * $D588 sub_D588: formation bookkeeping, once a frame in mode 5.
 *
 *  - <$F8 set: first (once, <$67 = 0) copy <$11 into $19E1+n for every
 *    slot n with bit 0 set ($19E1-$1A0B), then go on as below.
 *  - Count the slots $1860-$188B with bit 0 clear (B) and those with
 *    bit 1 set (<$14). <$20 = 1 if B = 1; <$F8 = 1 if B < <$5A; $1122 = 1
 *    if B < $111C; <$75 = 1 if B < <$12.
 *  - B = 0 and <$D6, <$DA clear: count $1165 up; when it wraps, and
 *    $1123 clear and the objects at $1F27/$1F29/$1F2B not all in use
 *    and none of $1F2D, $1E87, $1E8B in use: wait a frame, next mode
 *    (game_mode + 1), clear $1F1F, <$18, <$F8, both task indexes.
 *  - Otherwise: <$0D = $0ECE + 2 * $1064[0-3 by B: >= 30, 20, 10, less]
 *    and <$13 = 1 if $1036[0-3 by frame_hi: < 2, 6, 8, more] < <$14.
 * @see gaplus-main.asm $D588
 * @param {Machine} m
 * @returns {Gen}
 */
export function* sub_D588(m) {
  const ch = (/** @type {number} */ n) => m.charge(n);
  const s = () => busy(m, 0);
  yield* s();
  const f8 = m.peek(0x10f8);
  ch(4); // lda <$F8 / lbne $D64F
  if (f8 !== 0) {
    ch(6);
    // $D64F: lda <$67 / bne $D671
    yield* s();
    const done = m.peek(0x1067);
    ch(4); ch(3);
    if (done === 0) {
      let u = 0x1860;
      let x = 0x19e0;
      ch(3); ch(3);
      yield* s();
      const a = m.peek(0x1011);
      ch(4);
      for (;;) {
        u += 1;
        x += 1;
        ch(5); ch(5); ch(4); ch(3); // leau / leax / cmpx #$1A0C / beq
        if (x === 0x1a0c) break;
        yield* s();
        const v = m.peek(u);
        ch(4); ch(2); ch(3); // ldb ,u / andb #1 / beq
        if ((v & 0x01) === 0) continue;
        yield* s();
        m.poke(x, a);
        ch(4); ch(4); ch(3); // sta ,x / cmpx #$1A0B / bne
        if (x === 0x1a0b) break;
      }
    }
    yield* s();
    inc(m, 0x1067);
    ch(6); ch(4); // inc <$67 / jmp $D58E
  } else {
    ch(5);
  }
  // $D58E: clr <$20 / ldx #$1860 / clrb / clr <$14
  yield* s();
  m.poke(0x1020, 0);
  ch(6); ch(3); ch(2);
  yield* s();
  m.poke(0x1014, 0);
  ch(6);
  let b = 0;
  for (let x = 0x1860; x !== 0x188c;) {
    yield* s();
    let v = m.peek(x);
    ch(4); ch(2); ch(3); // lda ,x / anda #1 / bne
    if ((v & 0x01) === 0) {
      b = (b + 1) & 0xff;
      ch(2);
    }
    yield* s();
    v = m.peek(x);
    x += 1;
    ch(6); ch(2); ch(3); // lda ,x+ / anda #2 / beq
    if (v & 0x02) {
      yield* s();
      inc(m, 0x1014);
      ch(6);
    }
    ch(4); ch(3); // cmpx #$188C / bne
  }
  ch(2); ch(3); // cmpb #1 / bne
  if (b === 1) {
    ch(2);
    yield* s();
    m.poke(0x1020, 1);
    ch(4);
  }
  for (const [lim, cyc, dst, sc] of [[0x105a, 4, 0x10f8, 4],
    [0x111c, 5, 0x1122, 5], [0x1012, 4, 0x1075, 4]]) {
    yield* s();
    const l = m.peek(lim);
    ch(cyc + 3); // cmpb lim / bcc
    if (b < l) {
      ch(2);
      yield* s();
      m.poke(dst, 1);
      ch(sc);
    }
  }
  /** One `lda`-style test: sync, read, charge. @param {number} addr
   * @param {number} cyc @returns {Generator<unknown, number, unknown>} */
  const rd = function* rd(addr, cyc) {
    yield* s();
    const v = m.peek(addr);
    ch(cyc);
    return v;
  };
  let next = false;
  ch(2); ch(3); // cmpb #0 / bne $D60E
  if (b === 0) {
    next = yield* (function* tests() {
      if ((yield* rd(0x10d6, 4 + 3)) !== 0) return false;
      if ((yield* rd(0x10da, 4 + 3)) !== 0) return false;
      yield* s();
      const c = inc(m, 0x1165);
      ch(7); ch(3); // inc $1165 / bne
      if (c !== 0) return false;
      if ((yield* rd(0x1123, 5 + 3)) !== 0) return false;
      let v = yield* rd(0x1f27, 5);
      v &= yield* rd(0x1f29, 5);
      v &= yield* rd(0x1f2b, 5 + 2 + 3);
      if (v & 0x80) return false;
      v = yield* rd(0x1f2d, 5);
      v |= yield* rd(0x1e87, 5);
      v |= yield* rd(0x1e8b, 5 + 2 + 3);
      return (v & 0x80) === 0;
    })();
  }
  if (next) {
    ch(16); // $D5FC: cwai #$EF
    yield;
    for (const [addr, cyc] of [[0x1f1f, 7], [0x1018, 6], [0x10f8, 6],
      [0x107a, 6], [0x1030, 6]]) {
      if (addr === 0x1f1f) {
        yield* s();
        inc(m, 0x102f); // inc <$2F: game_mode
        ch(6);
      }
      yield* s();
      m.poke(addr, 0);
      ch(cyc);
    }
    ch(4);
    return;
  }
  // $D60E: clra / cmpb #$1E / bcc / inca / cmpb #$14 / ... #$0A / inca
  let a = 0;
  ch(2); ch(2); ch(3);
  if (b < 0x1e) {
    a = 1;
    ch(2); ch(2); ch(3);
    if (b < 0x14) {
      a = 2;
      ch(2); ch(2); ch(3);
      if (b < 0x0a) {
        a = 3;
        ch(2);
      }
    }
  }
  // $D61E: ldx #$1064 / lda a,x / asla / ldx #$0ECE / leax a,x (signed) /
  // stx <$0D
  ch(3);
  a = (yield* rd(0x1064 + a, 5)) << 1 & 0xff;
  ch(2); ch(3); ch(5);
  yield* s();
  m.poke16(0x100d, disp8(0x0ece, a));
  ch(5); ch(2);
  // clrb / lda <$15 / cmpa #2 / bcs / incb / cmpa #6 / ... #8 / incb
  const h = yield* rd(0x1015, 4 + 2 + 3);
  b = 0;
  if (h >= 2) {
    b = 1;
    ch(2); ch(2); ch(3);
    if (h >= 6) {
      b = 2;
      ch(2); ch(2); ch(3);
      if (h >= 8) {
        b = 3;
        ch(2);
      }
    }
  }
  // $D63D: clr <$13 / ldx #$1036 / lda b,x / cmpa <$14 / bcc / inc <$13
  yield* s();
  m.poke(0x1013, 0);
  ch(6); ch(3);
  const lv = yield* rd(0x1036 + b, 5);
  const c14 = yield* rd(0x1014, 4 + 3);
  if (lv < c14) {
    yield* s();
    inc(m, 0x1013);
    ch(6);
  }
  yield* s();
  yield SYNC; // main_task: the sub CPU may clear it
  inc(m, 0x1030);
  ch(6); ch(4);
}

/**
 * $D676 task_stage_clear: mode 6. Every formation slot = 2, clear the
 * enemy positions $1602-$162F (both banks) and the flags $1E31-$1E85
 * (even bytes), all sounds off, $1E8B = 0; wait a frame; the current
 * player's stage + 1; sound 2 if the new stage is in dat_D6E8 (51
 * stages: 2, 7, 12, ...: the challenging stages), else sound 5 (both by
 * INC); then clear $1F1F, <$67 and go to mode 0 (both task indexes 0).
 * @see gaplus-main.asm $D676
 * @param {Machine} m
 * @returns {Gen}
 */
export function* task_stage_clear(m) {
  const ch = (/** @type {number} */ n) => m.charge(n);
  const s = () => busy(m, 0);
  ch(3); ch(2);
  for (let x = 0x1860; x !== 0x188c; x += 1) {
    yield* s();
    m.poke(x, 0x02);
    ch(6); ch(4); ch(3);
  }
  ch(3); ch(3);
  for (let x = 0x1602; x !== 0x1630; x += 2) {
    yield* s();
    m.poke16(x + 0x0800, 0);
    ch(9);
    yield* s();
    m.poke16(x, 0);
    ch(8); ch(4); ch(3);
  }
  ch(3);
  for (let x = 0x1e31; x !== 0x1e87; x += 2) {
    yield* s();
    m.poke(x, 0);
    ch(9); ch(4); ch(3);
  }
  ch(8); // jsr sound_all_off
  yield* call(MAIN.sound_all_off, m, {});
  yield* s();
  m.poke(0x1e8b, 0);
  ch(7); ch(16); // clr $1E8B / cwai #$EF
  yield;
  // lda <$2D / beq: inc stage_p2 or stage_p1, then look it up
  yield* s();
  const p2 = m.peek(0x102d) !== 0;
  ch(4); ch(3);
  const st = p2 ? 0x1107 : 0x1106;
  yield* s();
  inc(m, st);
  ch(7);
  yield* s();
  const a = m.peek(st);
  ch(5); ch(2); ch(3);
  let found = false;
  for (let i = 0; i < 0x33; i += 1) {
    ch(6); ch(3); // cmpa ,x+ (ROM) / beq
    if (a === m.read('main', 0xd6e8 + i)) {
      found = true;
      break;
    }
    ch(2); ch(3); // decb / bne
  }
  yield* s();
  if (found) {
    inc(m, 0x6042); // $D6E3: inc snd_request+2 / bra
    ch(7); ch(3);
  } else {
    inc(m, 0x6045);
    // P2's path branches to $D6D5 (bra); P1's falls into it
    ch(p2 ? 7 + 3 : 7);
  }
  for (const [addr, cyc] of [[0x1f1f, 7], [0x1067, 6], [0x102f, 6],
    [0x107a, 6], [0x1030, 6]]) {
    yield* s();
    m.poke(addr, 0);
    ch(cyc);
  }
  ch(4);
}

/**
 * $D71B task_stage_start: mode 0's stage set-up.
 *
 *  - Starfield: not flipped $1170 = 0, $116E = 0, $A003 = 6, $A002 =
 *    $85; flipped $1170 = 2, $A003 = 0, $A002 = $81.
 *  - Clear $10B0-$10BF, <$21, $1128, $1129. stage ($1035) = the player's
 *    stage, reduced by 30 while >= 60.
 *  - Attract mode: GAME OVER at $028D (colour 1).
 *  - A challenging stage (challenging_stages $D860, 16 entries):
 *    CHALLENGING STAGE at $0310; else PARSEC and the player's stage
 *    number (mod 99, + 1; tens digit only from 10) at $0290.
 *  - var_100A + 1; when it wraps to 0 the text is erased again (18
 *    blanks; the digit writes land 2 and 3 tiles on, the last below
 *    $0000 for PARSEC: $FFF0, unmapped) and: normal stage: load the
 *    stage parameters (load_stage_params, $F4A5), next task; challenging
 *    stage: wait a frame, mode 7, clear $1164 and both task indexes.
 *  - Otherwise (the usual case: the task runs every frame until the
 *    counter wraps): clear a set of per-stage variables, $112D = $188D,
 *    wait a frame, restart the mode-0 list (main_task = 0).
 * @see gaplus-main.asm $D71B
 * @param {Machine} m
 * @returns {Gen}
 */
export function* task_stage_start(m) {
  const ch = (/** @type {number} */ n) => m.charge(n);
  const s = () => busy(m, 0);
  /** A store: sync, write, charge. @param {number} addr @param {number} v
   * @param {number} cyc @returns {Gen} */
  const st = function* st(addr, v, cyc) {
    yield* s();
    m.poke(addr & 0xffff, v);
    ch(cyc);
  };
  yield* s();
  const flip = m.peek(0x102c);
  ch(4); ch(3); // lda <$2C / bne $D731
  if (flip === 0) {
    yield* st(0x1170, 0, 7);
    yield* st(0x116e, 0, 7 + 2);
    yield* st(0xa003, 0x06, 5 + 2);
    yield* st(0xa002, 0x85, 5 + 3);
  } else {
    ch(2);
    yield* st(0x1170, 0x02, 5 + 2);
    yield* st(0xa003, 0x00, 5 + 2);
    yield* st(0xa002, 0x81, 5);
  }
  // $D740: ldu #$10B0 / ldd #0 / std ,u++ / cmpu #$10C0 / bne
  ch(3); ch(3);
  for (let u = 0x10b0; u !== 0x10c0; u += 2) {
    yield* s();
    m.poke16(u, 0);
    ch(8); ch(5); ch(3);
  }
  yield* st(0x1021, 0, 6);
  yield* st(0x1128, 0, 7);
  yield* st(0x1129, 0, 7);
  // ldb stage_p1 / lda <$2D / beq / ldb stage_p2
  yield* s();
  let b = m.peek(0x1106);
  ch(5);
  yield* s();
  const p2 = m.peek(0x102d) !== 0;
  ch(4); ch(3);
  if (p2) {
    yield* s();
    b = m.peek(0x1107);
    ch(5);
  }
  // $D760: cmpb #$3C / bcs / subb #$1E / bra
  ch(2); ch(3);
  while (b >= 0x3c) {
    b -= 0x1e;
    ch(2); ch(3); ch(2); ch(3);
  }
  yield* st(0x1035, b, 4); // stb <$35: stage
  yield* s();
  const attract = m.peek(0x09f4);
  ch(5); ch(3); // lda attract_flag / beq $D787
  if (attract !== 0) {
    // GAME OVER: 9 characters, colour 1
    ch(3); ch(3); ch(2);
    let u = 0x028d;
    for (let i = 0; i < 9; i += 1) {
      ch(6);
      yield* st(u, m.read('main', 0xd857 + i), 4 + 2);
      yield* st(u + 0x0400, 0x01, 8);
      u -= 0x20;
      ch(5); ch(2); ch(3);
    }
  }
  // $D787: lda #$10 / ldb <$35 / ldx #$D860 / cmpb ,x+ / lbeq / deca / bne
  ch(2);
  yield* s();
  b = m.peek(0x1035);
  ch(4); ch(3);
  let chal = false;
  for (let i = 0; i < 0x10; i += 1) {
    ch(6);
    if (b === m.read('main', 0xd860 + i)) {
      ch(6);
      chal = true;
      break;
    }
    ch(5); ch(2); ch(3);
  }
  if (chal) {
    // $D870: CHALLENGING STAGE at $0310
    ch(3); ch(3);
    yield* printR(m, 0x0310, 0xd845);
    yield* s();
    const c = inc(m, 0x100a);
    ch(6); // inc <$0A / lbne $D7D7
    if (c !== 0) {
      ch(6);
      yield* stageVars(m);
      return;
    }
    ch(5); ch(3); ch(3);
    const x = yield* printR(m, 0x0330, 0xd832);
    ch(2);
    yield* st(x - 0x40, 0x20, 5);
    yield* st(x - 0x60, 0x20, 5 + 16);
    yield; // $D8A0: cwai #$EF
    ch(2);
    yield* st(0x102f, 0x07, 4);
    yield* st(0x1164, 0, 7);
    yield* st(0x1030, 0, 6);
    yield* st(0x107a, 0, 6 + 4);
    return;
  }
  // $D797: PARSEC at $0290
  ch(3); ch(3);
  let x = yield* printR(m, 0x0290, 0xd82b);
  // $D7A8: the player's stage (unreduced), mod 99, + 1
  yield* s();
  let a = m.peek(0x1106);
  ch(5);
  yield* s();
  const q = m.peek(0x102d);
  ch(4); ch(3);
  if (q !== 0) {
    yield* s();
    a = m.peek(0x1107);
    ch(5);
  }
  ch(2); ch(3); // cmpa #$63 / bcs
  while (a >= 0x63) {
    a -= 0x63;
    ch(2); ch(3); ch(2); ch(3);
  }
  // clrb / inca / cmpa #$0A / bcs $D7CE
  a += 1;
  b = 0;
  ch(2); ch(2); ch(2); ch(3);
  if (a >= 0x0a) {
    // $D7C0: suba #$0A / bcs / incb / bra -- then adda #$0A
    for (;;) {
      const r = a - 0x0a;
      a = r & 0xff;
      ch(2); ch(3);
      if (r < 0) break;
      b += 1;
      ch(2); ch(3);
    }
    a = (a + 0x0a) & 0xff;
    ch(2); ch(2);
    yield* st(x - 0x40, (b + 0x30) & 0xff, 5);
  }
  ch(2);
  yield* st(x - 0x60, (a + 0x30) & 0xff, 5); // adda #$30 / sta -$60,x
  yield* s();
  const c = inc(m, 0x100a);
  ch(6); ch(3); // inc <$0A / beq $D80A
  if (c !== 0) {
    yield* stageVars(m);
    return;
  }
  // $D80A: erase, load the stage, next task
  ch(3); ch(3);
  x = yield* printR(m, 0x0290, 0xd832);
  ch(2);
  yield* st(x - 0x40, 0x20, 5);
  yield* st(x - 0x60, 0x20, 5 + 8);
  yield* call(MAIN.load_stage_params, m, {});
  yield* s();
  yield SYNC; // main_task: the sub CPU may clear it
  inc(m, 0x1030);
  ch(6); ch(4);
}

/**
 * $D7D7: clear the per-stage variables, $112D = $188D (end of the
 * formation scan), wait a frame, main_task = 0.
 * @param {Machine} m
 * @returns {Gen}
 */
function* stageVars(m) {
  for (const [addr, cyc] of [[0x1118, 7], [0x1117, 7], [0x1116, 7],
    [0x10c1, 6], [0x10c0, 6], [0x10ce, 6], [0x1175, 7], [0x1176, 7],
    [0x1075, 6], [0x111a, 7], [0x111b, 7], [0x1123, 7], [0x1129, 7],
    [0x112b, 7]]) {
    yield* busy(m, 0);
    m.poke(addr, 0);
    m.charge(cyc);
  }
  m.charge(3);
  yield* busy(m, 0);
  m.poke16(0x112d, 0x188d);
  m.charge(6); m.charge(16);
  yield; // $D803: cwai #$EF
  yield* busy(m, 0);
  yield SYNC; // main_task: the sub CPU may clear it
  m.poke(0x1030, 0);
  m.charge(6); m.charge(4);
}

/** Every routine of this file by entry address. */
export const ROUTINES = {
  0xd28a: sub_D28A,
  0xd431: sub_D431,
  0xd588: sub_D588,
  0xd676: task_stage_clear,
  0xd71b: task_stage_start,
};

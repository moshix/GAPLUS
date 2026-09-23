// Copyright 2026 by Moshix
// The oracle board (test/m6809/board.mjs) running the real Gaplus ROMs:
// boot, attract, coins, determinism, snapshots, callRoutine, stack
// extents, IRQ timing records, and the exact-cycle I/O chip run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeOracle, callRoutine, loadState, saveState, diffRam, fillRandom,
  randomPlayer, STACK_RANGES,
} from '../helpers/oracle.mjs';
import { oracleVsOracle } from '../helpers/lockstep.mjs';
import { Board, CYCLES_PER_FRAME } from '../m6809/board.mjs';
import { Machine } from '../../src/machine/machine.js';

/** RAM addresses (reference/symbols.json). */
const SUB_HANDSHAKE = 0x0800;
const SUB_ROM_ERROR = 0x0801;
const SND_ROM_ERROR = 0x6380;
const ATTRACT_FLAG = 0x09f4;
const GAME_MODE = 0x102f;
const LIVES_P1 = 0x1104;
const COIN_SOUND = 0x6056;       // snd_request+22, INC'd by the main IRQ

/**
 * Frame at which attract mode begins (attract_flag $09F4 = 1, set by
 * attract_phase0 at $C870) with MAME scheduling (256-cycle quantum,
 * power-on as MAME). Pinned: any timing change in the board moves it.
 */
const ATTRACT_FRAME = 240;

test('boot: custom chip checks pass, sub/sound handshakes', () => {
  const b = makeOracle();
  const seen = new Set();
  b.onExec = (n, pc) => { if (n === 0) seen.add(pc); };
  b.runFrames(300);
  b.onExec = null;
  assert.ok(seen.has(0xe0c7), 'reached boot_handshake (SRESET off)');
  assert.ok(!seen.has(0xe0c5), 'never in boot_chip_error');
  assert.equal(b.mem[SUB_HANDSHAKE], 0x22, 'sub checksum done');
  assert.equal(b.mem[SUB_ROM_ERROR], 0, 'sub ROMs OK');
  assert.equal(b.mem[SND_ROM_ERROR], 0, 'sound ROM OK');
  assert.deepEqual(b.inReset, [false, false, false]);
  assert.deepEqual(b.machine.irqMask, [1, 1, 1]);
  assert.equal(b.watchdogResets, 0);
  assert.equal(b.runawayCount, 0);
});

test(`attract mode begins at frame ${ATTRACT_FRAME}`, () => {
  const b = makeOracle();
  const at = b.runUntil((x) => x.mem[ATTRACT_FLAG] === 1, 400);
  assert.equal(at, ATTRACT_FRAME);
  // Held power-on (FBNeo style) reaches the same point.
  const h = makeOracle({ powerOn: 'held' });
  assert.equal(h.runUntil((x) => x.mem[ATTRACT_FLAG] === 1, 400), at);
});

test('determinism: two runs identical at frame 3000', () => {
  const a = makeOracle();
  const b = makeOracle();
  a.runFrames(3000);
  b.runFrames(3000);
  assert.deepEqual(diffRam(a, b, { exempt: [] }), []);
  assert.deepEqual(a.cpus.map((c) => c.getState()),
    b.cpus.map((c) => c.getState()));
  assert.equal(a.cycle, 3000 * CYCLES_PER_FRAME);
  assert.equal(a.cpus[2].cycles, b.cpus[2].cycles);
});

test('snapshot/restore: lockstep from a snapshot', () => {
  // Coin + start + random play, snapshot mid-game, 1500 frames each side.
  const rp = randomPlayer(5, { from: 470 });
  /** @type {import('../helpers/lockstep.mjs').LockstepScript} */
  const script = (f, press) => {
    if (f === 400) press('coin1', true);
    if (f === 404) press('coin1', false);
    if (f === 460) press('start1', true);
    if (f === 464) press('start1', false);
    rp(f, { setInput: press });
  };
  const r = oracleVsOracle({ at: 1200, frames: 1500, script, refOpts: {} });
  assert.equal(r.diffFrames, 0, r.firstLines.join('\n'));
  assert.deepEqual(diffRam(r.ref, r.cand, { exempt: [] }), []);
  assert.deepEqual(r.ref.cpus.map((c) => c.getState()),
    r.cand.cpus.map((c) => c.getState()));
  assert.equal(r.ref.mem[GAME_MODE] !== 0 || r.ref.mem[ATTRACT_FLAG] === 0,
    true, 'the snapshot was taken in a game');
});

test('coin -> credit -> start -> game begins', () => {
  const b = makeOracle();
  b.tap('coin1', 400);
  b.runFrames(430);
  assert.equal(b.machine.io.read(0x6801) & 0x0f, 1, '56XX credits = 1');
  assert.equal(b.mem[0x0035], 0x31, "'1' after CREDIT on the screen");
  assert.equal(b.mem[COIN_SOUND], 1, 'coin sound requested');
  b.tap('start1', 440);
  const at = b.runUntil((x) => x.mem[GAME_MODE] === 3, 1000);
  assert.ok(at > 400 && at < 800, `play began after ${at} frames`);
  assert.equal(b.machine.io.read(0x6801) & 0x0f, 0, 'credit used');
  assert.equal(b.mem[ATTRACT_FLAG], 0);
  assert.equal(b.mem[LIVES_P1], 3);
});

test('callRoutine: $BE1D and $BE25, exact cycles', () => {
  const b = makeOracle();
  // $BE1D: lda #$10 / stx ,u++ / deca / bne / rts
  //   2 + 16 x (8 + 2 + 3) + 5 = 215 cycles
  const r = callRoutine(b, 'main', 0xbe1d, { x: 0x1234, u: 0x0100 });
  assert.equal(r.cycles, 215);
  assert.equal(r.u, 0x0120);
  assert.equal(r.a, 0);
  assert.equal(r.zf, true);
  for (let i = 0; i < 32; i += 2) {
    assert.deepEqual([b.mem[0x100 + i], b.mem[0x101 + i]], [0x12, 0x34]);
  }
  // $BE25 delay_65536: pshs d (7) / ldd #0 (3) / 65536 x (ldy $7C00 7,
  // inca 2, bne 3) / 256 x (incb 2, bne 3) / puls d (7) / rts (5)
  const kicks = b.machine.watchdogKicks;
  const d = callRoutine(b, 0, 0xbe25, { d: 0xabcd });
  assert.equal(d.cycles, 7 + 3 + 65536 * 12 + 256 * 5 + 7 + 5);
  assert.equal(d.d, 0xabcd, 'D preserved');
  assert.equal(b.machine.watchdogKicks - kicks, 131072, 'LDY reads twice');
  assert.ok(d.stackLow >= STACK_RANGES[0][0]);
  // Runaway guard.
  assert.throws(() => callRoutine(b, 'main', 0xbe2a, {}, { maxCycles: 1000 }),
    /did not return/);
});

test('loadState/saveState/fillRandom: board <-> Machine', () => {
  const b = makeOracle();
  const m = new Machine();
  fillRandom(m, 1234);
  loadState(b, m);
  assert.deepEqual(diffRam(b, m, { exempt: [] }), []);
  const saved = saveState(b);
  b.mem[0x1000] ^= 0xff;
  b.mem[0x6100] ^= 0xff;
  const d = diffRam(saved, b);
  assert.equal(d.length, 2);
  assert.match(d[0], /^\$1000 \S* ?oracle=\$[0-9A-F]{2} port=\$[0-9A-F]{2}$/);
  // Stacks are exempt by default.
  b.mem[0x15f0] ^= 0xff;
  assert.equal(diffRam(saved, b).length, 2);
  assert.equal(diffRam(saved, b, { exempt: [] }).length, 3);
  loadState(b, saved);
  assert.deepEqual(diffRam(saved, b, { exempt: [] }), []);
});

test('stacks stay inside the exempt ranges', () => {
  const b = makeOracle();
  b.trackStack = true;
  b.tap('coin1', 300);
  b.tap('start1', 360);
  b.inputScript = randomPlayer(1, { from: 370 });
  b.runFrames(3000);
  STACK_RANGES.forEach(([lo], n) => {
    const low = n === 2 ? b.stackLow[n] + 0x6000 : b.stackLow[n];
    assert.ok(low >= lo, `cpu ${n}: S reached $${low.toString(16)}`);
  });
  // The game path that sets the main CPU's record ($15E2) is covered.
  assert.equal(b.stackLow[0], STACK_RANGES[0][0]);
  assert.equal(b.watchdogResets, 0);
  assert.equal(b.runawayCount, 0);
});

test('IRQ handlers start by cycle 8, end within the frame', () => {
  const b = makeOracle();
  b.logIrqs = true;
  b.runFrames(1000);
  const late = b.irqLog.filter((r) => r.frame >= 300);
  for (let n = 0; n < 3; n += 1) {
    const mine = late.filter((r) => r.cpu === n);
    assert.equal(mine.length, 700, `cpu ${n}: one handler per frame`);
    assert.ok(mine.every((r) => r.start >= 0 && r.start <= 8));
    assert.ok(mine.every((r) => r.end < CYCLES_PER_FRAME));
  }
  assert.equal(b.irqStats[0].lost, 0);
  assert.equal(b.irqStats[2].lost, 0);
});

// ------------------------------------------------ synthetic ROM programs

/**
 * A board whose main CPU runs `code` at $E000 (IRQ vector -> $E100
 * `handler`), sub and sound held in reset.
 * @param {number[]} code @param {number[]} handler
 */
function synthetic(code, handler) {
  const main = new Uint8Array(0x10000);
  main.set(code, 0xe000);
  main.set(handler, 0xe100);
  main.set([0xe1, 0x00], 0xfff8);            // IRQ
  main.set([0xe0, 0x00], 0xfffe);            // RESET
  const idle = new Uint8Array(0x10000);
  idle.set([0x20, 0xfe], 0xe000);            // BRA *
  idle.set([0xe0, 0x00], 0xfffe);
  return new Board({ roms: { main, sub: idle, sound: idle }, powerOn: 'held' });
}

/** Main program: 56XX mode 1, FRESET off, IRQ on, CWAI, BRA *. */
const SETUP = [
  0x10, 0xce, 0x16, 0x00,   // lds  #$1600
  0x86, 0x01,               // lda  #1
  0xb7, 0x68, 0x08,         // sta  $6808    56XX mode 1: ram[0] = ~COINS
  0xb7, 0x90, 0x00,         // sta  $9000    FRESET off
  0xb7, 0x70, 0x00,         // sta  $7000    main IRQ on
  0x3c, 0xef,               // cwai #$EF
  0x20, 0xfe,               // bra  *
];

/**
 * IRQ handler: the CWAI wake takes 4 cycles (vector fetch), then `pad`
 * cycles of BRN/NOP, then `lda $6800` reads at its 5th cycle, so the read
 * is at cycle index 4 + pad + 4 after vblank. The value lands in $0100.
 * @param {number} pad
 */
function handler(pad) {
  const out = [];
  let left = pad;
  if (left % 2) { out.push(0x21, 0x00); left -= 3; }   // brn (3 cycles)
  for (; left > 0; left -= 2) out.push(0x12);          // nop (2 cycles)
  out.push(0xb6, 0x68, 0x00, 0xb7, 0x01, 0x00, 0x20, 0xfe);
  return out;
}

test('I/O run lands at vblank + 76.8 cycles, mid-instruction', () => {
  for (const [pad, expect] of [[66, 0xf0], [67, 0xf0], [68, 0xf1], [69, 0xf1]]) {
    const b = synthetic(SETUP, handler(pad));
    b.setInput('coin1', true);
    b.runFrames(2);
    const at = 4 + pad + 4;
    assert.equal(b.mem[0x0100], expect,
      `read at cycle ${at}: ${expect === 0xf1 ? 'after' : 'before'} the run`);
    assert.equal(b.runawayCount, 0);
  }
});

test('runaway: a PC outside ROM is reported or throws', () => {
  const code = [0x7e, 0x01, 0x00];                  // jmp $0100 (RAM)
  const b = synthetic(code, []);
  b.runFrames(1);
  assert.ok(b.runawayCount > 0);
  assert.deepEqual([b.runaways[0].cpu, b.runaways[0].pc, b.runaways[0].from],
    [0, 0x0100, 0xe000]);
  const s = synthetic(code, []);
  s.strictPc = true;
  assert.throws(() => s.runFrames(1), /PC left ROM: \$100/);
});

test('power-on: sub/sound run until main STA $8C00', () => {
  const b = makeOracle();
  // Before any frame: all three CPUs are running from their vectors.
  assert.deepEqual(b.inReset, [false, false, false]);
  const pcs = [];
  b.onExec = (n, pc) => { if (n > 0 && pcs.length < 40) pcs.push([n, pc]); };
  b.runFrames(1);
  // Sub and sound executed their first instructions, then were stopped.
  assert.ok(pcs.some(([n, pc]) => n === 1 && pc === 0xe000));
  assert.ok(pcs.some(([n, pc]) => n === 2 && pc === 0xe000));
  assert.ok(pcs.every(([, pc]) => pc < 0xe010), 'only a few instructions');
  assert.deepEqual(b.inReset, [false, true, true]);
});

test('board.mjs import graph has no Node modules (browser use)', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const seen = new Set();
  /** @param {string} file */
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /from 'node:|require\(/, file);
    for (const m of src.matchAll(/^import [^;]*? from '(\.[^']+)'/gm)) {
      walk(join(dirname(file), m[1]));
    }
  };
  walk(join(dirname(fileURLToPath(import.meta.url)), '../m6809/board.mjs'));
  assert.ok(seen.size >= 5, [...seen].join(' '));
});

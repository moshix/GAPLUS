// Copyright 2026 by Moshix
// Unit tests for src/machine/namcoio.js: the 56XX / 58XX / 62XX models,
// checked against MAME's namcoio.cpp / gaplus_m.cpp behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GaplusIo, Namco56xx, Namco58xx, Namco62, createInputState, inputPorts,
  setDip, stickPort, DEFAULT_DIPS, IO_RUN_DELAY_CYCLES,
} from '../../src/machine/namcoio.js';

/** A chip set with a fresh input state. */
function fresh() {
  const inp = createInputState();
  const io = new GaplusIo(inp);
  return { inp, io };
}

/** One frame of I/O: vblank, then the run 50 us later. */
function frame(io) {
  io.vblank();
  io.update();
}

/** 56XX nibble n as the CPU reads it, low 4 bits. */
const n56 = (io, n) => io.read(0x6800 + n) & 0x0f;
const n58 = (io, n) => io.read(0x6810 + n) & 0x0f;

/** Program the 56XX into coin mode with the given coinage. */
function coinMode(io, coinsPerCred = 1, credsPerCoin = 1,
  coinsPerCred2 = 1, credsPerCoin2 = 1) {
  io.write(0x6809, coinsPerCred);
  io.write(0x680a, credsPerCoin);
  io.write(0x680b, coinsPerCred2);
  io.write(0x680c, credsPerCoin2);
  io.write(0x6808, 2);
  frame(io);
  io.write(0x6809, 0); // "start buttons may take credits"
  io.write(0x6808, 4);
}

test('run delay is 50 us of the 1.536 MHz clock', () => {
  assert.equal(IO_RUN_DELAY_CYCLES, 76.8);
});

test('CPU access: 4-bit RAM reads back as $F0 | nibble', () => {
  const { io } = fresh();
  io.write(0x6808, 0xa7);
  assert.equal(io.n56.ram[8], 0x07);
  assert.equal(io.read(0x6808), 0xf7);
  io.write(0x681f, 0x3c);
  assert.equal(io.read(0x681f), 0xfc);
  // Offsets are taken from the low 6 bits of the address.
  assert.equal(io.read(0x0f), 0xf0);
  assert.equal(io.read(0x1f), 0xfc);
});

test('power-on state matches MAME (reset pulse at device_reset)', () => {
  const { io } = fresh();
  for (const c of [io.n56, io.n58]) {
    assert.deepEqual(Array.from(c.ram), new Array(16).fill(0));
    assert.equal(c.reset, 0);
    assert.equal(c.credits, 0);
    assert.deepEqual(c.coinsPerCred, [1, 1]);
    assert.deepEqual(c.credsPerCoin, [1, 1]);
    assert.equal(c.lastcoins, 0);
    assert.equal(c.lastbuttons, 0);
  }
  assert.deepEqual(Array.from(io.n62.ram), new Array(16).fill(0));
});

test('input ports: defaults, active low, DIP defaults $F', () => {
  const inp = createInputState();
  assert.deepEqual(inputPorts(inp), {
    COINS: 0xf, P1: 0xf, P2: 0xf, BUTTONS: 0xf,
    DSWA_HIGH: 0xf, DSWA_LOW: 0xf, DSWB_LOW: 0xf, DSWB_HIGH: 0xf, IN2: 0xf,
  });
  assert.deepEqual({ ...inp.dips }, { ...DEFAULT_DIPS });
  inp.coin1 = true;
  inp.service = true;
  inp.fire1 = true;
  inp.start2 = true;
  const p = inputPorts(inp);
  assert.equal(p.COINS, 0x6); // b0 and b3 low
  assert.equal(p.BUTTONS, 0x6); // b0 (fire 1) and b3 (start 2) low
});

test('joystick: bit order and 8-way contradictory cancel', () => {
  const s = { up: false, right: false, down: false, left: false };
  assert.equal(stickPort({ ...s, up: true }), 0xe);
  assert.equal(stickPort({ ...s, right: true }), 0xd);
  assert.equal(stickPort({ ...s, down: true }), 0xb);
  assert.equal(stickPort({ ...s, left: true }), 0x7);
  assert.equal(stickPort({ ...s, up: true, left: true }), 0x6);
  // up+down cancels both; the horizontal part survives
  assert.equal(stickPort({ ...s, up: true, down: true, right: true }), 0xd);
  assert.equal(stickPort({ up: true, down: true, left: true, right: true }), 0xf);
});

test('setDip writes the field into its port', () => {
  const inp = createInputState();
  setDip(inp, 'lives', 0x8);      // 2 lives
  assert.equal(inp.dips.DSWA_HIGH, 0xb);
  setDip(inp, 'coinA', 0x1);      // 2C1C
  assert.equal(inp.dips.DSWA_HIGH, 0x9);
  setDip(inp, 'serviceMode', 0);  // on
  assert.equal(inp.dips.DSWB_HIGH, 0x7);
  setDip(inp, 'difficulty', 0);   // hardest
  assert.equal(inp.dips.DSWB_HIGH, 0x0);
});

test('56XX mode 8: boot check sums nibbles 9-15 (7 x F = $69)', () => {
  const { io } = fresh();
  io.write(0x6808, 8);
  for (let i = 9; i < 16; i += 1) io.write(0x6800 + i, 0xf);
  frame(io);
  assert.equal(io.read(0x6800), 0xf6);
  assert.equal(io.read(0x6801), 0xf9);
  // phozon's arguments (MAME comment): 1..7 -> $1C
  for (let i = 9; i < 16; i += 1) io.write(0x6800 + i, i - 8);
  frame(io);
  assert.equal(n56(io, 0), 1);
  assert.equal(n56(io, 1), 0xc);
});

/**
 * 58XX mode 5 against the cases MAME lists in namcoio.cpp.
 * @param {number[]} args nibbles 9-15
 */
function bootCheck58(args) {
  const { io } = fresh();
  io.write(0x6818, 5);
  args.forEach((v, i) => io.write(0x6819 + i, v));
  frame(io);
  return Array.from(io.n58.ram.slice(0, 8));
}

test('58XX mode 5: the LFSR boot check reproduces MAME\'s cases', () => {
  // gaplus: 9-15 = f f f f f f f, expects 0-1 = f f (0 by the kludge)
  const g = bootCheck58([0xf, 0xf, 0xf, 0xf, 0xf, 0xf, 0xf]);
  assert.equal(g[0], 0xf);
  assert.equal(g[1], 0xf);
  // mappy: 9-15 = 3 6 5 f a c e, expects 1-7 = 8 4 6 e d 9 d
  assert.deepEqual(bootCheck58([3, 6, 5, 0xf, 0xa, 0xc, 0xe]).slice(1),
    [8, 4, 6, 0xe, 0xd, 9, 0xd]);
  // grobda: 9-15 = 2 3 4 5 6 7 8, expects 2 = f and 6 = c
  const gr = bootCheck58([2, 3, 4, 5, 6, 7, 8]);
  assert.equal(gr[2], 0xf);
  assert.equal(gr[6], 0xc);
  // phozon: 9-15 = 0 1 2 3 4 5 6, expects 0-7 = 0 2 3 4 5 6 c a
  assert.deepEqual(bootCheck58([0, 1, 2, 3, 4, 5, 6]),
    [0, 2, 3, 4, 5, 6, 0xc, 0xa]);
});

test('58XX mode 4: DIP switches, both halves, 1 = switch ON', () => {
  const { io, inp } = fresh();
  io.write(0x6818, 4);
  frame(io);
  // factory settings: every switch off
  assert.deepEqual(Array.from(io.n58.ram.slice(0, 8)), [0, 0, 0, 0, 0, 0, 0, 0]);
  setDip(inp, 'lives', 0x8);       // DSWA_HIGH = $B -> reads 4
  setDip(inp, 'bonus', 0x3);       // DSWB_LOW  = $B -> reads 4
  setDip(inp, 'difficulty', 0x5);  // DSWB_HIGH = $D -> reads 2
  setDip(inp, 'demoSounds', 0);    // DSWA_LOW  = $7 -> reads 8
  frame(io);
  assert.deepEqual(Array.from(io.n58.ram.slice(0, 8)), [4, 4, 4, 4, 2, 2, 8, 8]);
  // what the game tests: $6811 b2-3 lives, $6814 b3 service mode
  assert.equal(n58(io, 1) & 0x0c, 0x04);
  setDip(inp, 'serviceMode', 0);
  frame(io);
  assert.equal(n58(io, 4) & 0x08, 0x08);
});

test('56XX mode 1: switches inverted into nibbles 0-3', () => {
  const { io, inp } = fresh();
  io.write(0x6808, 1);
  frame(io);
  assert.deepEqual(Array.from(io.n56.ram.slice(0, 4)), [0, 0, 0, 0]);
  inp.coin2 = true;
  inp.p1.left = true;
  inp.p2.down = true;
  inp.start1 = true;
  frame(io);
  assert.deepEqual(Array.from(io.n56.ram.slice(0, 4)), [2, 8, 4, 4]);
});

test('58XX mode 1: switches into nibbles 4-7', () => {
  const { io, inp } = fresh();
  setDip(inp, 'coinB', 0);
  io.write(0x6818, 1);
  frame(io);
  assert.deepEqual(Array.from(io.n58.ram.slice(4, 8)), [0, 0, 0, 3]);
});

test('coin mode: 1 coin 1 credit, edge-triggered, BCD out', () => {
  const { io, inp } = fresh();
  coinMode(io);
  frame(io);
  assert.equal(io.n56.credits, 0);
  inp.coin1 = true;
  frame(io);
  assert.equal(io.n56.credits, 1);
  assert.equal(n56(io, 1), 1);
  assert.equal(n56(io, 2), 1, 'credit-add handshake nibble');
  // Holding the switch is not another coin.
  io.write(0x6802, 0); // the CPU clears the handshake
  frame(io);
  assert.equal(io.n56.credits, 1);
  assert.equal(n56(io, 2), 0, 'not rewritten without a new credit');
  inp.coin1 = false;
  frame(io);
  for (let i = 0; i < 11; i += 1) {
    inp.coin1 = true; frame(io);
    inp.coin1 = false; frame(io);
  }
  assert.equal(io.n56.credits, 12);
  assert.equal(n56(io, 0), 1);
  assert.equal(n56(io, 1), 2);
});

test('coin mode: 2C1C on chute 1; chute 2 has its own table', () => {
  const { io, inp } = fresh();
  coinMode(io, 2, 1, 3, 2);
  const pulse = (k) => { inp[k] = true; frame(io); inp[k] = false; frame(io); };
  pulse('coin1');
  assert.equal(io.n56.credits, 0);
  assert.equal(io.n56.coins[0], 1);
  pulse('coin1');
  assert.equal(io.n56.credits, 1);
  assert.equal(io.n56.coins[0], 0);
  pulse('coin2');
  pulse('coin2');
  assert.equal(io.n56.credits, 1);
  pulse('coin2');
  assert.equal(io.n56.credits, 3, '3 coins give 2 credits');
});

test('coin mode: bit 3 of coins-per-credit pays a credit up front', () => {
  // coinsPerCred = $A (2 coins, bit 3), credsPerCoin = 3:
  // coin 1 -> +1 (the bit-3 credit); coin 2 -> +3 - 1 = +2.
  const { io, inp } = fresh();
  coinMode(io, 0xa, 3);
  const pulse = () => { inp.coin1 = true; frame(io); inp.coin1 = false; frame(io); };
  pulse();
  assert.equal(io.n56.credits, 1);
  pulse();
  assert.equal(io.n56.credits, 3);
});

test('coin mode: C int semantics for a negative credit add', () => {
  // coinsPerCred = 9 (1 coin, bit 3), credsPerCoin = 0: 0 - 1 = -1.
  const { io, inp } = fresh();
  coinMode(io, 9, 0);
  inp.coin1 = true;
  frame(io);
  assert.equal(io.n56.credits, -1);
  assert.equal(n56(io, 0), 0);          // -1 / 10 truncates to 0
  assert.equal(n56(io, 1), 0xf);        // -1 % 10 = -1 -> $F
  assert.equal(n56(io, 2), 0xf);        // creditAdd -1 -> $F
});

test('coin mode: two coins on one run -- the last one wins', () => {
  const { io, inp } = fresh();
  coinMode(io, 1, 1, 1, 2);
  inp.coin1 = true;
  inp.coin2 = true;
  frame(io);
  assert.equal(io.n56.credits, 2, 'coin 2 assigns creditAdd = 2');
  inp.service = true;
  inp.coin1 = false;
  inp.coin2 = false;
  frame(io);
  assert.equal(io.n56.credits, 3, 'service coin adds one');
});

test('coin mode: start buttons take credits only while nibble 9 is 0', () => {
  const { io, inp } = fresh();
  coinMode(io);
  const pulse = (k) => { inp[k] = true; frame(io); inp[k] = false; frame(io); };
  pulse('start1');
  assert.equal(io.n56.credits, 0, 'no credit, no deduction');
  pulse('coin1');
  pulse('start2');
  assert.equal(io.n56.credits, 1, 'start 2 needs two credits');
  io.write(0x6809, 1); // the game says "not now"
  pulse('start1');
  assert.equal(io.n56.credits, 1);
  io.write(0x6809, 0);
  inp.start1 = true;
  frame(io);
  assert.equal(io.n56.credits, 0);
  assert.equal(n56(io, 3), 1, 'credit-sub handshake');
  inp.start1 = false;
  frame(io);
  pulse('coin1');
  pulse('coin1');
  pulse('coin1');
  // both starts pressed on one run: start 1 wins
  inp.start1 = true;
  inp.start2 = true;
  frame(io);
  assert.equal(io.n56.credits, 2);
  inp.start1 = false;
  inp.start2 = false;
  frame(io);
  inp.start2 = true;
  frame(io);
  assert.equal(io.n56.credits, 0);
  assert.equal(n56(io, 3), 2);
});

test('coin mode: button nibbles give held and edge bits', () => {
  const { io, inp } = fresh();
  coinMode(io);
  frame(io);
  assert.equal(n56(io, 5), 0);
  assert.equal(n56(io, 7), 0);
  inp.fire1 = true;
  frame(io);
  assert.equal(n56(io, 5), 0b0011, 'fire 1 held + edge');
  frame(io);
  assert.equal(n56(io, 5), 0b0010, 'fire 1 held only');
  inp.fire1 = false;
  inp.fire2 = true;
  inp.start2 = true;
  io.write(0x6809, 1); // keep the credits out of it
  frame(io);
  assert.equal(n56(io, 5), 0);
  assert.equal(n56(io, 7), 0b1111, 'fire 2 and start 2, held + edge');
  frame(io);
  assert.equal(n56(io, 7), 0b1010);
  inp.start1 = true;
  frame(io);
  assert.equal(n56(io, 5), 0b1100, 'start 1 held + edge');
});

test('coin mode: joysticks in nibbles 4 and 6', () => {
  const { io, inp } = fresh();
  coinMode(io);
  inp.p1.up = true;
  inp.p1.right = true;
  inp.p2.left = true;
  frame(io);
  assert.equal(n56(io, 4), 0b0011);
  assert.equal(n56(io, 6), 0b1000);
});

test('coin mode: 100 credits overflow the tens nibble (no cap)', () => {
  const { io, inp } = fresh();
  coinMode(io, 1, 10);
  for (let i = 0; i < 10; i += 1) {
    inp.coin1 = true; frame(io);
    inp.coin1 = false; frame(io);
  }
  assert.equal(io.n56.credits, 100);
  assert.equal(n56(io, 0), 0xa);
  assert.equal(n56(io, 1), 0);
});

test('58XX mode 3: coin handling with swapped credit nibbles', () => {
  const { io, inp } = fresh();
  io.write(0x6818, 3);
  frame(io);
  // The 58XX's in0 is DSWA_HIGH on Gaplus, so a DIP switch turning on
  // (bit 0 low) is what looks like coin 1 to this chip.
  setDip(inp, 'coinA', 0x2);
  frame(io);
  // credits (1) BCD in nibbles 2/3, credit-add in nibble 0
  assert.equal(n58(io, 2), 0);
  assert.equal(n58(io, 3), 1);
  assert.equal(n58(io, 0), 1);
  assert.equal(n58(io, 1), 0);
  // nibble 4 is in1 (DSWB_LOW), not swapped
  assert.equal(n58(io, 4), 0);
});

test('unknown modes do nothing', () => {
  const { io } = fresh();
  io.write(0x6808, 0xe);
  io.write(0x6818, 0xe);
  frame(io);
  assert.deepEqual(Array.from(io.n56.ram.slice(0, 8)), new Array(8).fill(0));
  assert.deepEqual(Array.from(io.n58.ram.slice(0, 8)), new Array(8).fill(0));
});

test('FRESET: no run while held; resets coin logic only', () => {
  const { io, inp } = fresh();
  coinMode(io);
  inp.coin1 = true;
  frame(io);
  assert.equal(io.n56.credits, 1);
  io.setReset(true);
  assert.equal(io.inReset, true);
  assert.equal(io.n56.credits, 0);
  assert.equal(n56(io, 1), 1, 'nibble RAM untouched');
  inp.coin1 = false;
  frame(io);
  inp.coin1 = true;
  frame(io);
  assert.equal(io.n56.credits, 0, 'no run while in reset');
  io.setReset(false);
  frame(io);
  // lastcoins was last updated before the reset (coin held) -> no edge
  assert.equal(io.n56.credits, 0);
  // The coin tables were reset to 1/1 but nibble 8 still says mode 4.
  inp.coin1 = false; frame(io);
  inp.coin1 = true; frame(io);
  assert.equal(io.n56.credits, 1);
});

test('FRESET: the run is armed at vblank, not at update', () => {
  const { io } = fresh();
  io.write(0x6808, 8);
  io.write(0x6809, 5);
  io.setReset(true);
  io.vblank();
  io.setReset(false);
  io.update();
  assert.equal(n56(io, 1), 0, 'held at vblank: not armed');
  io.vblank();
  io.setReset(true);
  io.update();
  assert.equal(n56(io, 1), 5, 'armed at vblank: runs even if reset since');
  io.update();
  assert.equal(io.pending.n56, false, 'a run happens once per vblank');
});

test('machine reset clears nibble RAM, keeps the edge detectors', () => {
  const { io, inp } = fresh();
  coinMode(io);
  inp.coin1 = true;
  frame(io);
  io.write(0x6810, 7);
  io.n62.write(4, 0x55);
  io.machineReset();
  assert.deepEqual(Array.from(io.n56.ram), new Array(16).fill(0));
  assert.equal(io.n58.ram[0], 0);
  assert.equal(io.n56.credits, 0);
  assert.equal(io.n62.ram[4], 0x55, '62XX share is not reset');
  io.write(0x6808, 4);
  frame(io);
  assert.equal(io.n56.credits, 0, 'held coin: no new edge');
});

test('machine reset while FRESET is held keeps the line held', () => {
  const { io } = fresh();
  io.setReset(true);
  io.machineReset();
  assert.equal(io.inReset, true);
});

test('62XX: fixed reads by mode, plain RAM elsewhere, IN2 at 0', () => {
  const { io, inp } = fresh();
  // Gaplus boot: $6828..$682F = 4..$0B, then checks $6821/2/3 = F/E/1.
  for (let i = 0; i < 8; i += 1) io.write(0x6828 + i, 4 + i);
  assert.equal(io.read(0x6821), 0x0f);
  assert.equal(io.read(0x6822), 0x0e);
  assert.equal(io.read(0x6823), 0x01);
  assert.equal(io.read(0x6828), 0x04);
  assert.equal(io.read(0x682f), 0x0b);
  assert.equal(io.read(0x6820), 0x0f, 'IN2 default: upright');
  inp.in2 = 0x0b; // cocktail
  assert.equal(io.read(0x6820), 0x0b);
  io.write(0x6821, 0x33);
  io.write(0x6823, 0x44);
  io.write(0x6828, 2); // mode 2: 1 and 3 read RAM, 2 reads $F
  assert.equal(io.read(0x6821), 0x33);
  assert.equal(io.read(0x6822), 0x0f);
  assert.equal(io.read(0x6823), 0x44);
  io.write(0x6825, 0xa5);
  assert.equal(io.read(0x6825), 0xa5, '8 bits wide');
});

test('62XX: a write of $0F or more to offset 9 triggers the bang', () => {
  let bangs = 0;
  const io = new GaplusIo(createInputState(), { onBang: () => { bangs += 1; } });
  io.write(0x6829, 0x0e);
  assert.equal(bangs, 0);
  io.write(0x6829, 0x0f);
  io.write(0x6829, 0xff);
  io.write(0x6828, 0x0f);
  assert.equal(bangs, 2);
  assert.equal(io.bangs, 2);
  const lone = new Namco62(() => 0xf);
  lone.write(9, 0x20); // no callback installed: no throw
  assert.equal(lone.read(9), 0x20);
});

test('chips work standalone with their own port callbacks', () => {
  const c56 = new Namco56xx([() => 0xe, () => 0xd, () => 0xb, () => 0x7]);
  c56.write(8, 1);
  c56.run();
  assert.deepEqual(Array.from(c56.ram.slice(0, 4)), [1, 2, 4, 8]);
  const outs = [];
  const c58 = new Namco58xx([() => 0xf, () => 0xf, () => 0xf, () => 0xf],
    [(v) => outs.push(['a', v]), (v) => outs.push(['b', v])]);
  c58.write(8, 4);
  c58.run();
  assert.deepEqual(outs, [['a', 0], ['a', 1]], 'pin 13 low then high');
});

test('the Gaplus boot sequence on the chips (docs/hardware.md 4.5)', () => {
  const { io, inp } = fresh();
  // E013: STD $6808 (#$01FF), E019: CLR $6818
  io.write(0x6808, 0x01);
  io.write(0x6809, 0xff);
  io.write(0x6818, 0);
  frame(io);
  // E065..: $6808 = 8, $6818 = 5, 9-15 = F on both
  io.write(0x6808, 8);
  io.write(0x6818, 5);
  for (let i = 9; i < 16; i += 1) {
    io.write(0x6800 + i, 0xf);
    io.write(0x6810 + i, 0xf);
  }
  frame(io);
  assert.equal(n56(io, 0), 6);
  assert.equal(n56(io, 1), 9);
  assert.equal(n58(io, 0), 0xf);
  assert.equal(n58(io, 1), 0xf);
  // E0F5: 56XX 0, 58XX 0; then 56XX 1, 58XX 4
  io.write(0x6808, 0);
  io.write(0x6818, 0);
  frame(io);
  io.write(0x6808, 1);
  io.write(0x6818, 4);
  frame(io);
  assert.deepEqual(Array.from(io.n56.ram.slice(0, 4)), [0, 0, 0, 0]);
  // E1DE: pulse FRESET; coinage; coin mode
  io.setReset(true);
  frame(io);
  io.setReset(false);
  coinMode(io);
  inp.coin1 = true;
  frame(io);
  assert.equal(n56(io, 1), 1);
});

test('snapshots: getState/setState round-trip through JSON', () => {
  const a = fresh();
  coinMode(a.io, 2, 1);
  a.inp.coin1 = true;
  frame(a.io);
  a.io.n62.write(3, 0x99);
  a.io.vblank(); // leave runs armed
  const snap = JSON.parse(JSON.stringify(a.io.getState()));
  const b = fresh();
  b.io.setState(snap);
  assert.deepEqual(b.io.getState(), a.io.getState());
  // Same future: release the coin, insert another.
  for (const s of [a, b]) {
    s.io.update();
    s.inp.coin1 = false;
    frame(s.io);
    s.inp.coin1 = true;
    frame(s.io);
  }
  assert.deepEqual(b.io.getState(), a.io.getState());
  assert.equal(a.io.n56.credits, 1);
  // The snapshot is a copy, not a view.
  snap.n56.ram[0] = 9;
  assert.notEqual(b.io.n56.ram[0], 9);
});

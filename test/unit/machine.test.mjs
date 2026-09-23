// Copyright 2026 by Moshix
// Unit tests for src/machine/machine.js: the memory model, the three CPU
// views, the address-decoded latches, and the I/O chips as mapped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Machine, CPU, CPU_NAMES, RAM_REGIONS, STACKS, SOUND_RAM_BASE,
  soundToMain, mainToSound, CYCLES_PER_FRAME,
} from '../../src/machine/machine.js';
import { loadGaplus } from '../../tools/romset.mjs';

const ROMS = loadGaplus();

test('RAM regions: 9 KB, main-CPU addresses, no overlap', () => {
  let total = 0;
  let last = -1;
  for (const r of RAM_REGIONS) {
    assert.ok(r.start > last);
    total += r.end - r.start;
    last = r.end - 1;
  }
  assert.equal(total, 0x2000 + 0x400);
  assert.equal(CYCLES_PER_FRAME, 25344);
  assert.deepEqual(CPU_NAMES, ['main', 'sub', 'sound']);
});

test('stack tops come from the ROMs\' LDS instructions', () => {
  // $10 $CE hh ll = LDS #$hhll
  const lds = (img, at) => {
    assert.deepEqual([img[at], img[at + 1]], [0x10, 0xce], `LDS at ${at.toString(16)}`);
    return (img[at + 2] << 8) | img[at + 3];
  };
  assert.equal(lds(ROMS.main, 0xe00f), STACKS.main.top);
  assert.equal(lds(ROMS.main, 0xb705), STACKS.main.top);
  assert.equal(lds(ROMS.main, 0xd152), STACKS.main.top);
  assert.equal(lds(ROMS.sub, 0xe006), STACKS.sub.top);
  assert.equal(lds(ROMS.sub, 0xe181), STACKS.sub.top);
  assert.equal(lds(ROMS.sound, 0xe047), STACKS.sound.top);
  assert.equal(STACKS.sound.mainTop, SOUND_RAM_BASE + STACKS.sound.top);
});

test('main and sub share $0000-$1FFF byte for byte', () => {
  const m = new Machine();
  m.poke(0x0000, 0x11);
  m.sub.poke(0x1fff, 0x22);
  assert.equal(m.sub.peek(0x0000), 0x11);
  assert.equal(m.peek(0x1fff), 0x22);
  assert.equal(m.mem[0x1fff], 0x22);
  assert.equal(m.videoRam[0], 0x11);
  assert.equal(m.workRam[0x17ff], 0x22);
});

test('sound $0000-$03FF is main $6000-$63FF', () => {
  const m = new Machine();
  m.sound.poke(0x0040, 0x11);
  assert.equal(m.mem[0x6040], 0x11);
  assert.equal(m.peek(0x6040), 0x11);
  m.poke(0x63ff, 0x33);
  assert.equal(m.sound.peek(0x03ff), 0x33);
  assert.equal(m.soundRam[0x3ff], 0x33);
  assert.equal(soundToMain(0x0040), 0x6040);
  assert.equal(soundToMain(0x0400), -1);
  assert.equal(mainToSound(0x6040), 0x0040);
  assert.equal(mainToSound(0x6400), -1);
  // The sound CPU does not see tile RAM, the sub does not see sound RAM.
  m.poke(0x0040, 0x55);
  assert.equal(m.sound.peek(0x0040), 0x11);
  assert.equal(m.sub.peek(0x6040), 0);
});

test('15XX registers: readable; writes from both CPUs hooked', () => {
  const m = new Machine();
  const log = [];
  m.hooks.onWsgWrite = (r, v) => log.push([r, v]);
  m.poke(0x6003, 0x0f);
  m.sound.poke(0x003f, 0x70);
  m.sound.poke(0x0040, 0x01); // plain RAM: no hook
  assert.deepEqual(log, [[0x03, 0x0f], [0x3f, 0x70]]);
  assert.equal(m.sound.peek(0x0003), 0x0f);
  assert.equal(m.peek(0x603f), 0x70);
});

test('unmapped reads are $00, unmapped writes and ROM writes ignored', () => {
  const m = new Machine();
  for (const a of [0x2000, 0x5fff, 0x6400, 0x67ff, 0x6830, 0x6fff, 0x7000, 0x77ff]) {
    m.mem[a] = 0x99;
    assert.equal(m.peek(a), 0, `main $${a.toString(16)}`);
  }
  for (const a of [0x2000, 0x500f, 0x6000, 0x6800, 0x9fff]) {
    assert.equal(m.sub.peek(a), 0, `sub $${a.toString(16)}`);
  }
  for (const a of [0x0400, 0x1fff, 0x4000, 0x8000, 0xdfff]) {
    assert.equal(m.sound.peek(a), 0, `sound $${a.toString(16)}`);
  }
  const before = m.mem.slice();
  m.poke(0xe000, 0x12);
  m.poke(0xa800, 0x12);
  m.sub.poke(0x500f, 0x12);
  m.sub.poke(0xa000, 0x12);
  m.sound.poke(0xe000, 0x12);
  m.sound.poke(0x0400, 0x12);
  assert.deepEqual(m.mem, before);
  assert.equal(m.peek(0xe000), ROMS.main[0xe000]);
});

test('ROM: peek/read resolve to each CPU\'s own ROM', () => {
  const m = new Machine();
  for (const [cpu, lo] of [['main', 0xa000], ['sub', 0xa000], ['sound', 0xe000]]) {
    for (const a of [lo, lo + 0x1234, 0xfffe, 0xffff]) {
      assert.equal(m.read(cpu, a), ROMS[cpu][a], `${cpu} ${a.toString(16)}`);
      assert.equal(m.cpuView(cpu).peek(a), ROMS[cpu][a]);
      assert.equal(m.cpuView(cpu).read(a), ROMS[cpu][a]);
    }
  }
  // Reset vectors, big-endian
  assert.equal(m.read16('main', 0xfffe), 0xe000);
  assert.equal(m.read16('sub', 0xfff8), 0xe061);
  assert.equal(m.sound.read16(0xfff8), 0xe055);
  assert.equal(m.read16(0xfffe), 0xe000, 'one argument = main CPU');
  assert.equal(m.read(0xe000), ROMS.main[0xe000], 'one argument = main CPU');
  // Pointer into RAM through read()
  m.poke(0x1000, 0xab);
  assert.equal(m.read('sub', 0x1000), 0xab);
  assert.throws(() => m.cpuView('nope'));
});

test('16-bit accesses are big-endian, high byte written first', () => {
  const m = new Machine();
  const order = [];
  const orig = m.busWrite.bind(m);
  m.busWrite = (cpu, a, v) => { order.push(a); orig(cpu, a, v); };
  m.poke16(0x0800, 0x1234);
  assert.deepEqual([m.mem[0x0800], m.mem[0x0801]], [0x12, 0x34]);
  assert.equal(m.peek16(0x0800), 0x1234);
  m.sound.poke16(0x0100, 0xbeef);
  assert.equal(m.mem[0x6100], 0xbe);
  assert.equal(m.sound.peek16(0x0100), 0xbeef);
  m.sub.poke16(0x1ffe, 0xa55a);
  assert.equal(m.peek16(0x1ffe), 0xa55a);
  assert.deepEqual(order, [0x0800, 0x0801, 0x0100, 0x0101, 0x1ffe, 0x1fff]);
});

test('fill and copy go byte by byte (overlap smears); copy reads ROM', () => {
  const m = new Machine();
  m.fill(0x0000, 0x20, 0x400);
  assert.equal(m.mem[0x3ff], 0x20);
  assert.equal(m.mem[0x400], 0);
  m.poke(0x0800, 7);
  m.copy(0x0801, 0x0800, 4);
  assert.deepEqual(Array.from(m.mem.slice(0x800, 0x805)), [7, 7, 7, 7, 7]);
  m.sound.copy(0x00a0, 0xe3ef, 0x20); // the sound CPU's boot copy
  assert.deepEqual(Array.from(m.mem.slice(0x60a0, 0x60c0)),
    Array.from(ROMS.sound.slice(0xe3ef, 0xe40f)));
});

test('main IRQ latch: A11 decides; disable clears the line', () => {
  const m = new Machine();
  const log = [];
  m.hooks.onIrqMask = (cpu, on) => log.push([cpu, on]);
  assert.deepEqual(m.irqMask, [0, 0, 0]);
  m.poke(0x7400, 0);
  assert.equal(m.irqMask[CPU.MAIN], 1);
  m.vblank();
  assert.equal(m.irqLine[CPU.MAIN], true);
  m.poke(0x7c00, 0xff); // data is irrelevant
  assert.equal(m.irqMask[CPU.MAIN], 0);
  assert.equal(m.irqLine[CPU.MAIN], false);
  m.poke(0x7000, 0);
  assert.equal(m.irqMask[CPU.MAIN], 1);
  m.poke(0x7820, 0); // boot's $0000 -> $7820-$782F lands in "disable"
  assert.equal(m.irqMask[CPU.MAIN], 0);
  assert.deepEqual(log, [[0, true], [0, false], [0, true], [0, false]]);
});

test('enabling a mask never asserts; a masked vblank is lost', () => {
  const m = new Machine();
  m.vblank();
  assert.deepEqual(m.irqLine, [false, false, false]);
  m.poke(0x7400, 0);
  assert.equal(m.irqLine[CPU.MAIN], false);
});

test('sub IRQ latch: A0 decides ($6001 on, $6080 off, $6081 on)', () => {
  const m = new Machine();
  m.sub.poke(0x6001, 0);
  assert.equal(m.irqMask[CPU.SUB], 1);
  m.vblank();
  assert.equal(m.irqLine[CPU.SUB], true);
  m.sub.poke(0x6080, 0);
  assert.equal(m.irqMask[CPU.SUB], 0);
  assert.equal(m.irqLine[CPU.SUB], false);
  m.sub.poke(0x6081, 0);
  assert.equal(m.irqMask[CPU.SUB], 1);
  m.sub.poke(0x6ffe, 0);
  assert.equal(m.irqMask[CPU.SUB], 0);
  // main's $6001 is the 15XX, not the sub latch
  m.poke(0x6001, 1);
  assert.equal(m.irqMask[CPU.SUB], 0);
});

test('sound IRQ latch: A13 decides ($4000 on, $6000 off)', () => {
  const m = new Machine();
  m.sound.poke(0x4000, 0);
  assert.equal(m.irqMask[CPU.SOUND], 1);
  m.vblank();
  assert.equal(m.irqLine[CPU.SOUND], true);
  m.sound.poke(0x6000, 0);
  assert.deepEqual([m.irqMask[CPU.SOUND], m.irqLine[CPU.SOUND]], [0, false]);
  m.sound.poke(0x5fff, 0);
  assert.equal(m.irqMask[CPU.SOUND], 1);
  m.sound.poke(0x7fff, 0);
  assert.equal(m.irqMask[CPU.SOUND], 0);
});

test('watchdog: main reads $7800+, sound reads/writes $2000+', () => {
  const m = new Machine();
  const who = [];
  m.hooks.onWatchdog = (cpu) => who.push(cpu);
  assert.equal(m.peek(0x7c00), 0);
  assert.equal(m.peek(0x7800), 0);
  m.poke(0x7c00, 0); // a write is the IRQ latch, not the watchdog
  assert.equal(m.sound.peek(0x3000), 0);
  m.sound.poke(0x2007, 0);
  m.sub.peek(0x7c00);
  assert.equal(m.watchdogKicks, 4);
  assert.deepEqual(who, [0, 0, 2, 2]);
});

test('SRESET: $8C00 holds sub + sound (and mutes), $8400 releases', () => {
  const m = new Machine();
  const log = [];
  m.hooks.onSreset = (held) => log.push(held);
  assert.equal(m.sreset, true, 'held from power-on (hardware.md 4.5)');
  assert.equal(m.soundEnable, false);
  m.poke(0x8c00, 0);
  assert.deepEqual(log, [], 'no change, no hook');
  m.poke(0x8400, 0);
  assert.equal(m.sreset, false);
  assert.equal(m.subsRunning, true);
  assert.equal(m.soundEnable, true);
  m.poke(0x8000, 0);
  m.poke(0x8800, 0);
  assert.equal(m.sreset, true);
  assert.deepEqual(log, [false, true]);
});

test('FRESET: $9C00 holds the I/O chips, $9400 releases', () => {
  const m = new Machine();
  const log = [];
  m.hooks.onFreset = (held) => log.push(held);
  m.poke(0x9c00, 0);
  assert.equal(m.io.inReset, true);
  m.poke(0x9400, 0);
  assert.equal(m.io.inReset, false);
  m.poke(0x9800, 0);
  m.poke(0x9000, 0);
  assert.deepEqual(log, [true, false, true, false]);
});

test('starfield control: $A000-$A7FF, reg = addr & 3', () => {
  const m = new Machine();
  const log = [];
  m.hooks.onStarCtrl = (r, v) => log.push([r, v]);
  m.poke(0xa000, 1);
  m.poke(0xa001, 0x85);
  m.poke(0xa002, 0x86);
  m.poke(0xa7ff, 0x87);
  m.poke(0xa800, 0x55); // ROM: ignored
  assert.deepEqual(Array.from(m.starCtrl), [1, 0x85, 0x86, 0x87]);
  assert.deepEqual(log, [[0, 1], [1, 0x85], [2, 0x86], [3, 0x87]]);
});

test('vblank + ioUpdate: IRQs per mask, then the I/O chip runs', () => {
  const m = new Machine();
  m.poke(0x7400, 0);
  m.sound.poke(0x4000, 0);
  m.poke(0x6808, 8);
  for (let i = 9; i < 16; i += 1) m.poke(0x6800 + i, 0xf);
  m.vblank();
  assert.deepEqual(m.irqLine, [true, false, true]);
  assert.equal(m.peek(0x6801), 0xf0, 'not yet: runs 50 us later');
  m.ioUpdate();
  assert.equal(m.peek(0x6800), 0xf6);
  assert.equal(m.peek(0x6801), 0xf9);
  // held in FRESET at vblank: no run
  m.poke(0x6809, 0);
  m.poke(0x9c00, 0);
  m.vblank();
  m.ioUpdate();
  assert.equal(m.peek(0x6801) & 0xf, 9);
});

test('I/O chips on the main bus only', () => {
  const m = new Machine();
  m.poke16(0x6808, 0x01ff); // E013: LDD #$01FF / STD $6808
  assert.equal(m.io.n56.ram[8], 1);
  assert.equal(m.io.n56.ram[9], 0xf);
  m.poke(0x6828, 4);
  assert.equal(m.peek(0x6822), 0x0e);
  assert.equal(m.peek(0x6828), 4);
  assert.equal(m.sub.peek(0x6822), 0);
  assert.equal(m.sound.peek(0x6822), 0);
});

test('irqPending: line, CC.I, and reset of sub/sound', () => {
  const m = new Machine();
  const clis = [];
  m.hooks.onCli = (cpu) => clis.push(cpu);
  m.poke(0x7400, 0);
  m.sub.poke(0x6001, 0);
  m.vblank();
  assert.equal(m.irqPending(CPU.MAIN), false, 'I set out of reset');
  m.cli();
  assert.deepEqual(clis, [0]);
  assert.equal(m.irqPending(CPU.MAIN), true);
  m.enterIrq(CPU.MAIN);
  assert.equal(m.irqPending(CPU.MAIN), false);
  m.sub.cli();
  assert.equal(m.irqPending(CPU.SUB), false, 'sub held in reset');
  m.poke(0x8400, 0);
  // Released from reset, the 6809 comes up with CC.I set (review m2).
  assert.equal(m.irqPending(CPU.SUB), false, 'reset sets CC.I');
  m.sub.cli();
  assert.equal(m.irqPending(CPU.SUB), true);
  m.sub.sei();
  assert.equal(m.irqPending(CPU.SUB), false);
});

test('inputs: setInput and setDip reach the chips', () => {
  const m = new Machine();
  m.poke(0x6808, 1);
  m.setInput('coin1', true);
  m.setInput('up', true);
  m.setInput('p2left', true);
  m.setInput('fire1', true);
  m.vblank();
  m.ioUpdate();
  assert.deepEqual([0, 1, 2, 3].map((n) => m.peek(0x6800 + n) & 0xf), [1, 1, 8, 1]);
  m.setDip('lives', 0x0);
  m.poke(0x6818, 4);
  m.vblank();
  m.ioUpdate();
  assert.equal(m.peek(0x6811) & 0x0c, 0x0c, '5 lives: both switches on');
  assert.throws(() => m.setInput('jump', true));
});

test('charge and writes counters', () => {
  const m = new Machine();
  m.charge(100);
  m.sub.charge(5);
  m.sound.charge(7);
  assert.deepEqual(m.charged, [100, 5, 7]);
  const w = m.writes;
  m.poke(0x0000, 1);
  m.sub.poke(0x6001, 0);
  assert.equal(m.writes, w + 2);
});

test('snapshots round-trip; power-on reset keeps the inputs', () => {
  const m = new Machine();
  m.poke(0x0100, 9);
  m.poke(0x7400, 0);
  m.poke(0x8400, 0);
  m.poke(0xa001, 0x85);
  m.poke(0x6808, 4);
  m.setInput('coin1', true);
  m.vblank();
  const s = m.getState();
  const n = new Machine();
  n.setState(structuredClone(s));
  // Inputs are the outside world, not board state: not in the snapshot.
  n.setInput('coin1', true);
  assert.deepEqual(n.getState(), s);
  n.ioUpdate();
  m.ioUpdate();
  assert.deepEqual(n.getState().io, m.getState().io);
  assert.equal(m.io.n56.credits, 1);
  m.setDip('lives', 0x8);
  m.reset();
  assert.equal(m.peek(0x0100), 0);
  assert.equal(m.io.n56.credits, 0);
  assert.equal(m.sreset, true);
  assert.deepEqual(m.irqMask, [0, 0, 0]);
  assert.equal(m.inputs.dips.DSWA_HIGH, 0xb, 'DIPs survive power cycling');
  assert.equal(m.inputs.coin1, true);
});

test('machine reset: only VINTON among the masks; RAM kept', () => {
  const m = new Machine();
  m.poke(0x0100, 9);
  m.poke(0x7400, 0);
  m.sub.poke(0x6001, 0);
  m.sound.poke(0x4000, 0);
  m.vblank();
  m.cli();
  m.poke(0x6808, 7);
  m.machineReset();
  assert.deepEqual(m.irqMask, [1, 0, 1]);
  assert.deepEqual(m.irqLine, [true, false, true]);
  assert.deepEqual(m.iMask, [true, true, true]);
  assert.equal(m.io.n56.ram[8], 0);
  assert.equal(m.peek(0x0100), 9);
});

test('read/read16 take a CPU name or number; others throw', () => {
  const m = new Machine();
  m.mem[0x0040] = 0x11;
  m.mem[0x0041] = 0x33;
  m.mem[0x6040] = 0x22;
  assert.equal(m.read('sub', 0x40), 0x11);
  assert.equal(m.read(CPU.SUB, 0x40), 0x11, 'numeric sub id: sub map');
  assert.equal(m.read(CPU.SOUND, 0x40), 0x22);
  assert.equal(m.read(CPU.MAIN, 0x40), 0x11);
  assert.equal(m.read16(CPU.SUB, 0x40), 0x1133);
  assert.equal(m.read16('sound', 0x40), 0x2200);
  assert.throws(() => m.read(/** @type {never} */ (3), 0x40));
  assert.throws(() => m.read(/** @type {never} */ ('cpu'), 0x40));
  assert.throws(() => m.read16(/** @type {never} */ (-1), 0x40));
});

test('SRESET change sets the sub and sound CC.I (6809 reset)', () => {
  const m = new Machine();
  m.poke(0x8400, 0);                 // release
  m.sub.cli();
  m.sound.cli();
  m.poke(0x8c00, 0);                 // hold ...
  m.poke(0x8400, 0);                 // ... and release: CPUs reset
  m.sub.poke(0x6001, 0);
  m.sound.poke(0x4000, 0);
  m.vblank();
  assert.equal(m.irqPending(CPU.SUB), false, 'no IRQ before ANDCC');
  assert.equal(m.irqPending(CPU.SOUND), false);
  m.sub.cli();
  assert.equal(m.irqPending(CPU.SUB), true);
});

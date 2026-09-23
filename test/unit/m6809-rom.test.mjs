// Copyright 2026 by Moshix
/**
 * Integration smoke test: the MC6809 core runs the real Gaplus main CPU ROM
 * (gp2-4.8d at $A000, gp2-3b.8c at $C000, gp2-2b.8b at $E000) from the
 * reset vector over plain RAM -- no I/O chips, no interrupts.
 *
 * Checks: the ROM images are the expected ones (CRC32 from docs/PLAN.md),
 * 200,000 instructions execute without any undocumented opcode, the ROM is
 * never written, and every instruction's cycle count agrees with the
 * table-driven model in test/m6809/cyclemodel.mjs.
 *
 * What it shows (logged): after clearing RAM $0000-$1FFF the boot code
 * calls a 65,536-iteration delay loop at $BE25 that kicks the watchdog
 * ($7C00) -- that is where the first 200,000 instructions end. Left to
 * run further it reaches the custom I/O chip self-test at $E083, which
 * fails on plain RAM and parks in `BRA *` at $E0C5 with error code $2031
 * in D.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { M6809 } from '../m6809/m6809.mjs';
import { expectedCycles } from '../m6809/cyclemodel.mjs';
import { disasm } from '../../tools/m6809dis.mjs';

const ROMS = fileURLToPath(new URL('../../roms/', import.meta.url));

/** [file, load address, crc32] */
const MAIN = /** @type {[string, number, number][]} */ ([
  ['gp2-4.8d', 0xa000, 0xe525d75d],
  ['gp2-3b.8c', 0xc000, 0xd77840a4],
  ['gp2-2b.8b', 0xe000, 0xb3cb90db],
]);

/** CRC-32 (IEEE), table-free. @param {Uint8Array} data @returns {number} */
function crc32(data) {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

const haveRoms = MAIN.every(([f]) => existsSync(ROMS + f));

/**
 * Build the machine: ROM $A000-$FFFF (writes ignored but counted), RAM
 * below.
 */
function board() {
  const mem = new Uint8Array(0x10000);
  for (const [file, base, crc] of MAIN) {
    const data = readFileSync(ROMS + file);
    assert.equal(crc32(data), crc, `${file} CRC32`);
    mem.set(data, base);
  }
  let romWrites = 0;
  const cpu = new M6809({
    read: (a) => mem[a],
    write: (a, v) => {
      if (a < 0xa000) mem[a] = v;
      else romWrites += 1;
    },
  });
  return { cpu, mem, romWrites: () => romWrites };
}

test('Gaplus main ROM: 200,000 instructions from reset', { skip: !haveRoms },
  () => {
    const { cpu, mem, romWrites } = board();
    const read = (/** @type {number} */ a) => mem[a];
    assert.equal(cpu.reset(), 4);
    assert.equal(cpu.pc, 0xe000, 'reset vector');
    /** @type {string[]} */
    const undoc = [];
    cpu.onUndocumented = (pc, op) => {
      undoc.push(`${pc.toString(16)}:${op.toString(16)}`);
    };
    const hist = new Map();
    let mismatches = 0;
    let firstMismatch = '';
    for (let i = 0; i < 200_000; i += 1) {
      const pc = cpu.pc;
      hist.set(pc, (hist.get(pc) ?? 0) + 1);
      const want = expectedCycles(read, pc, cpu);
      const got = cpu.step();
      if (want !== null && want !== got) {
        mismatches += 1;
        if (firstMismatch === '') {
          firstMismatch = `${pc.toString(16)} ${got} vs ${want}`;
        }
      }
    }
    assert.deepEqual(undoc, [], 'no undocumented opcodes');
    assert.equal(mismatches, 0, `cycle model mismatch ${firstMismatch}`);
    assert.equal(romWrites(), 0, 'no writes to ROM');

    // PC histogram, top 5 (lines kept under 79 columns)
    const top = [...hist].sort((p, q) => q[1] - p[1]).slice(0, 5);
    console.log(`main CPU: 200000 instructions, ${cpu.cycles} cycles`);
    for (const [pc, n] of top) {
      const t = disasm(read, pc).text;
      console.log(`  $${pc.toString(16).toUpperCase()}  ${String(n)
        .padStart(6)}x  ${t}`);
    }
    // the boot delay loop at $BE25 is where the time goes
    assert.equal(top[0][0], 0xbe2a);
  });

test('Gaplus main ROM: boot reaches the I/O self-test and parks',
  { skip: !haveRoms }, () => {
    const { cpu, mem } = board();
    cpu.reset();
    cpu.run(10_000_000);
    assert.equal(cpu.pc, 0xe0c5, 'BRA * after the failed I/O check');
    assert.equal(mem[0xe0c5], 0x20);
    assert.equal(cpu.d, 0x2031, 'error code: $6800 did not read $06,$09');
  });

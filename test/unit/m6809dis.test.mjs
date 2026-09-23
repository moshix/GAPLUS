// Copyright 2026 by Moshix
/**
 * Tests for the MC6809 disassembler (tools/m6809dis.mjs): MAME 6x09dasm
 * syntax for every addressing mode, instruction lengths agreeing with the
 * CPU core for every opcode and every indexed postbyte, flow kinds and
 * targets for the listing tools, and the CLI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  disasm, disasmRange, formatLine, hex,
} from '../../tools/m6809dis.mjs';
import { M6809, CC_I, CC_F } from '../m6809/m6809.mjs';
import { PAGE1, PAGE2, PAGE3 } from '../m6809/opcodes.mjs';

/**
 * Disassemble a byte list at $1000.
 * @param {number[]} bytes @param {object} [opts]
 */
function dis(bytes, opts) {
  const mem = new Uint8Array(0x10000);
  mem.set(bytes, 0x1000);
  return disasm((a) => mem[a], 0x1000, opts);
}

test('MAME syntax for every addressing mode', () => {
  /** @type {[number[], string][]} */
  const cases = [
    [[0x12], 'NOP'],
    [[0x96, 0x12], 'LDA    <$12'],
    [[0x8e, 0x12, 0x34], 'LDX    #$1234'],
    [[0x86, 0x05], 'LDA    #$05'],
    [[0xb6, 0x12, 0x34], 'LDA    $1234'],
    [[0xb6, 0x00, 0x34], 'LDA    >$0034'],
    [[0xad, 0x9f, 0xff, 0xfe], 'JSR    [$FFFE]'],
    [[0x30, 0x25], 'LEAX   $5,Y'],
    [[0x30, 0x3f], 'LEAX   -$1,Y'],
    [[0xa6, 0xa8, 0x05], 'LDA    $05,Y'],
    [[0xa6, 0xa8, 0xfb], 'LDA    -$05,Y'],
    [[0xa6, 0x89, 0x12, 0x34], 'LDA    $1234,X'],
    [[0xa6, 0x89, 0xff, 0xfe], 'LDA    -$0002,X'],
    [[0xa6, 0x80], 'LDA    ,X+'],
    [[0xa6, 0xc1], 'LDA    ,U++'],
    [[0xa6, 0xe2], 'LDA    ,-S'],
    [[0xa6, 0xa3], 'LDA    ,--Y'],
    [[0xa6, 0x84], 'LDA    ,X'],
    [[0xa6, 0x85], 'LDA    B,X'],
    [[0xa6, 0x86], 'LDA    A,X'],
    [[0xa6, 0x8b], 'LDA    D,X'],
    [[0xa6, 0x94], 'LDA    [,X]'],
    [[0xa6, 0xb1], 'LDA    [,Y++]'],
    [[0xa6, 0x98, 0x10], 'LDA    [$10,X]'],
    [[0xa6, 0x8c, 0x10], 'LDA    $1013,PCR'],
    [[0xa6, 0x8d, 0xff, 0xfc], 'LDA    $1000,PCR'],
    [[0xa6, 0x9c, 0x00], 'LDA    [$1003,PCR]'],
    [[0x20, 0xfe], 'BRA    $1000'],
    [[0x10, 0x27, 0x01, 0x00], 'LBEQ   $1104'],
    [[0x17, 0xff, 0xfd], 'LBSR   $1000'],
    [[0x1f, 0x8b], 'TFR    A,DP'],
    [[0x1e, 0x89], 'EXG    A,B'],
    [[0x1f, 0x61], 'TFR    inv,X'],
    [[0x34, 0x76], 'PSHS   U,Y,X,D'],
    [[0x34, 0xff], 'PSHS   PC,U,Y,X,DP,D,CC'],
    [[0x36, 0x44], 'PSHU   S,B'],
    [[0x35, 0xff], 'PULS   CC,D,DP,X,Y,U,PC'],
    [[0x37, 0x42], 'PULU   A,S'],
    [[0x10, 0xce, 0x16, 0x00], 'LDS    #$1600'],
    [[0x11, 0x83, 0x68, 0x10], 'CMPU   #$6810'],
    [[0x10, 0x3f], 'SWI2'],
    [[0x11, 0x3f], 'SWI3'],
    [[0x1a, 0x50], 'ORCC   #$50'],
    [[0x3c, 0xef], 'CWAI   #$EF'],
    [[0x4f], 'CLRA'],
    [[0x6f, 0x84], 'CLR    ,X'],
    // undocumented, MAME spellings
    [[0x01, 0x10], 'NEG    <$10'],
    [[0x42], 'XNCA'],
    [[0x5e], 'XCLRB'],
    [[0x87, 0x00], 'XSTA   #$00'],
    [[0x8f, 0x12, 0x34], 'XSTX   #$1234'],
    [[0x10, 0xc3, 0x00, 0x01], 'XADDD  #$0001'],
    [[0x14], 'XHCF'],
    [[0x10, 0x01], 'FCB    $10,$01'],
    [[0x10, 0x11, 0x8e, 0x00, 0x01], 'LDY    #$0001'],
    [[0xa6, 0x87], 'LDA    inv,X'],
    [[0xa6, 0x8f, 0x12, 0x34], 'LDA    $1234,inv'],
    [[0xa6, 0x90], 'LDA    [,X+]'],
  ];
  for (const [bytes, text] of cases) {
    const d = dis(bytes);
    assert.equal(d.text, text, bytes.map((b) => hex(b)).join(' '));
    assert.equal(d.len, bytes.length, `${text} length`);
    assert.deepEqual(d.bytes, bytes);
  }
});

test('undocumented flag', () => {
  assert.equal(dis([0x12]).undoc, false);
  assert.equal(dis([0x1b]).undoc, true);
  assert.equal(dis([0xa6, 0x87]).undoc, true, 'undefined postbyte');
  assert.equal(dis([0xa6, 0x90]).undoc, true, '[,R+]');
  assert.equal(dis([0xa6, 0x91]).undoc, false, '[,R++]');
});

test('flow kinds and static targets', () => {
  /** @type {[number[], string, number|null, boolean][]} */
  const cases = [
    [[0x7e, 0x20, 0x00], 'jump', 0x2000, false],
    [[0x6e, 0x84], 'jump', null, false],
    [[0x6e, 0x9f, 0xff, 0xfe], 'jump', null, false],
    [[0x6e, 0x8c, 0x10], 'jump', 0x1013, false],
    [[0x20, 0x10], 'jump', 0x1012, false],
    [[0x16, 0x00, 0x10], 'jump', 0x1013, false],
    [[0x26, 0x10], 'branch', 0x1012, true],
    [[0x10, 0x26, 0x00, 0x10], 'branch', 0x1014, true],
    [[0x21, 0x10], 'other', null, false],
    [[0x8d, 0x10], 'call', 0x1012, false],
    [[0x17, 0x00, 0x10], 'call', 0x1013, false],
    [[0xbd, 0xbe, 0x25], 'call', 0xbe25, false],
    [[0xad, 0x84], 'call', null, false],
    [[0x3f], 'call', null, false],
    [[0x39], 'return', null, false],
    [[0x3b], 'return', null, false],
    [[0x35, 0x86], 'return', null, false],
    [[0x35, 0x06], 'other', null, false],
    [[0x1f, 0x15], 'jump', null, false],
    [[0x1e, 0x51], 'jump', null, false],
    [[0x1f, 0x12], 'other', null, false],
    [[0x86, 0x00], 'other', null, false],
  ];
  for (const [bytes, kind, target, cond] of cases) {
    const d = dis(bytes);
    assert.equal(d.kind, kind, d.text);
    assert.equal(d.target, target, d.text);
    assert.equal(d.cond, cond, d.text);
  }
  // a direct JSR resolves only when the DP is known
  assert.equal(dis([0x9d, 0x40]).target, null);
  assert.equal(dis([0x9d, 0x40], { dp: 0x20 }).target, 0x2040);
  assert.equal(dis([0x96, 0x40], { dp: 0x20 }).ref, 0x2040);
  assert.equal(dis([0xb6, 0x12, 0x34]).ref, 0x1234);
});

/**
 * Run one instruction on the core and return how far PC moved.
 * @param {number[]} bytes
 */
function coreLength(bytes) {
  const mem = new Uint8Array(0x10000);
  mem.set(bytes, 0x1000);
  const cpu = new M6809({ read: (a) => mem[a], write: () => {} });
  cpu.pc = 0x1000; cpu.s = 0x8000;
  cpu.cc = CC_I | CC_F;
  cpu.setIrq(1);                      // lets SYNC/CWAI complete
  cpu.step();
  return cpu.pc - 0x1000;
}

test('length agrees with the core for every non-flow opcode', () => {
  let n = 0;
  for (const [prefix, table] of /** @type {const} */ ([
    [[], PAGE1], [[0x10], PAGE2], [[0x11], PAGE3],
  ])) {
    for (let op = 0; op < 256; op += 1) {
      const info = table[op];
      if (info === null || info.mode === 'page') continue;
      const bytes = [...prefix, op, 0x84, 0x00, 0x00, 0x00];
      const d = dis(bytes);
      // flow opcodes move PC elsewhere; CWAI vectors through $0000
      if (d.kind !== 'other' || info.name === 'CWAI') continue;
      assert.equal(coreLength(bytes), d.len, d.text);
      n += 1;
    }
  }
  // 320 opcodes minus jumps, calls, returns, branches and CWAI
  assert.equal(n, 270);
});

test('length agrees with the core for all 256 indexed postbytes', () => {
  for (let pb = 0; pb < 256; pb += 1) {
    const bytes = [0xa6, pb, 0x12, 0x34];
    assert.equal(coreLength(bytes), dis(bytes).len, `postbyte ${pb}`);
  }
});

test('range sweep and listing lines stay within 79 columns', () => {
  const mem = new Uint8Array(0x10000);
  let seed = 7;
  for (let i = 0; i < mem.length; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    mem[i] = seed >>> 24;
  }
  let count = 0;
  let last = 0;
  for (const ins of disasmRange((a) => mem[a], 0, 0x10000)) {
    assert.equal(ins.addr, last);
    last += ins.len;
    assert.ok(formatLine(ins).length <= 79);
    count += 1;
  }
  assert.ok(count > 20000);
});

test('CLI disassembles the Gaplus boot code', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  if (!existsSync(root + 'roms/gp2-2b.8b')) return;
  const out = execFileSync(process.execPath, [
    root + 'tools/m6809dis.mjs', '--from', 'E000', '--to', 'E013',
    root + 'roms/gp2-2b.8b@E000',
  ], { encoding: 'utf8' });
  const lines = out.trimEnd().split('\n');
  assert.deepEqual(lines, [
    'E000: 1A 10           ORCC   #$10',
    'E002: B7 8C 00        STA    $8C00',
    'E005: B7 94 00        STA    $9400',
    'E008: B7 7C 00        STA    $7C00',
    'E00B: 86 10           LDA    #$10',
    'E00D: 1F 8B           TFR    A,DP',
    'E00F: 10 CE 16 00     LDS    #$1600',
  ]);
  for (const l of lines) assert.ok(l.length <= 79);
});

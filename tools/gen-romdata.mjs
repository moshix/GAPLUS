// Copyright 2026 by Moshix
/**
 * Generate src/game/romdata.js: the three program ROMs, as base64, at
 * their CPU addresses, for the port to read tables where the 6809 did,
 * plus a data bitmap (`mask`): reading a code byte throws, because that
 * can only be a porting mistake (a wrong table address, an index past a
 * table, a JS array that should have been a ROM read).
 *
 * The mask is built from, per CPU:
 *   - the listing tracer (tools/gen-listing.mjs `buildAll`): every byte
 *     of a traced instruction is code; everything else (FCB/FDB tables,
 *     annotated data, text, fill, unreached bytes) is data;
 *   - READ_AS_DATA below: code bytes the ROM itself genuinely reads as
 *     data, each with its reader and reason; they are marked data;
 *   - SWEEPS below: the loops that read a whole ROM (checksums, the
 *     service RAM test's pattern). Those would mark every byte, so they
 *     are not in the mask: the port wraps each such read in
 *     `romSweep(cpu, fn)`, which lets code bytes of that CPU's declared
 *     range through for the duration of `fn` only.
 *   - reference/coverage/<cpu>.json `dataRead` (every ROM byte the real
 *     game read as data on the oracle board, sweeps excepted) is a check:
 *     each one must be data or in READ_AS_DATA, or generation fails.
 *
 * All bytes are shipped, code included: the checksums sum them.
 *
 *   node tools/gen-romdata.mjs          write src/game/romdata.js
 *   node tools/gen-romdata.mjs --check  exit 1 if the file is stale
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGaplus, ROOT } from './romset.mjs';
import { buildAll, COV_DIR } from './gen-listing.mjs';

export const OUT = join(ROOT, 'src', 'game', 'romdata.js');

/** Program ROM windows: [cpu, first address]; all end at $FFFF. */
export const WINDOWS = Object.freeze([
  ['main', 0xa000],
  ['sub', 0xa000],
  ['sound', 0xe000],
]);

/**
 * @typedef {object} ReadAsData
 * @property {number} lo first address @property {number} hi last address
 *   (inclusive) @property {string} reader the ROM instruction(s) reading it
 * @property {string} why
 */

/**
 * Code bytes the ROM genuinely reads as data (not porting mistakes: each
 * is what the 6809 does). Marked data in the mask. Ranges are inclusive.
 * @type {Readonly<Record<'main'|'sub'|'sound', readonly ReadAsData[]>>}
 */
export const READ_AS_DATA = Object.freeze({
  main: Object.freeze([
    {
      // ldy #boss_bonus_sprites / lda <boss_bonus_idx / asla / ldd a,y:
      // the index is +1 per boss hit in a chain and never bounded, and
      // A,Y is signed, so the word read is $D3A1 + (s8)(2 * idx):
      // $D321-$D420. The table has 12 words ($D3A1-$D3B8); the rest is
      // task_shot_hits' own code (main-C listing QUIRK).
      lo: 0xd321, hi: 0xd420, reader: '$D388 LDD A,Y',
      why: 'boss bonus sprite index runs past its table into code',
    },
  ]),
  sub: Object.freeze([
    {
      // object_spawn_random: ldx #$E000 / lda <frame_counter / lda a,x.
      // A,X is signed: frame_counter $00-$7F reads $E000-$E07F
      // (reset_sub, code), $80-$FF reads $DF80-$DFFF (gp2-7's fill).
      lo: 0xdf80, hi: 0xe07f, reader: '$B93B LDA A,X',
      why: 'noise table: the sub reads its own boot code as random bytes',
    },
    {
      // gp2-7 is the path chip; it holds no code. sub-C's decoder
      // (src/game/sub/gp2_7_paths.js) reads all of it, back-pointers
      // and copyright text included, so it stays readable as a whole.
      lo: 0xc000, hi: 0xdfff, reader: 'path streams, gp2_7_paths.js',
      why: 'the path chip is read in full as data',
    },
    {
      // effect_rising walks effect0_pictures with ldd ,x++ / cmpa #$FF:
      // the last list's $FF end marker is the table's last byte ($B85F),
      // so B picks up the next byte, effect_setup's first opcode.
      lo: 0xb860, hi: 0xb860, reader: '$B5D8 LDD ,X++',
      why: 'a word read of the end marker takes one byte of code into B',
    },
    {
      // task_score_anim: ldx #flyin_frames / asla / ldd a,x. On its
      // first frame A is the score byte just compared ($FE95-$FEB4, a
      // listing QUIRK), not the step $101E, so the signed a,x offset is
      // twice a BCD score byte: $F0C1 - 128 .. $F0C1 + 126, word reads,
      // over reset_formation_rows and the code before the table. Seen on
      // the ROM in AI games at PARSEC 20-24 (tools/ai-lockstep.mjs).
      lo: 0xf041, hi: 0xf140, reader: '$FEBF LDD A,X',
      why: 'the first frame indexes flyin_frames with a score byte',
    },
  ]),
  sound: Object.freeze([]),
});

/**
 * @typedef {object} Sweep
 * @property {number} lo @property {number} hi inclusive
 * @property {string} reader @property {string} why
 * @property {boolean} [coverage] its reads are in coverage `dataRead`
 */

/**
 * Loops that read a whole ROM. They are left out of the mask (it would
 * otherwise be all ones); the port wraps each of their reads in
 * `romSweep(cpu, fn)`, which allows code bytes in these ranges for that
 * CPU during `fn` only. They are the `ignoredReaders` of
 * tools/coverage.mjs, plus the sound-RAM test (whose $E000-$E3BF is in
 * coverage `dataRead`, and runs through the same port routine).
 * @type {Readonly<Record<'main'|'sub'|'sound', readonly Sweep[]>>}
 */
export const SWEEPS = Object.freeze({
  main: Object.freeze([
    {
      lo: 0xa000, hi: 0xffff, reader: '$B865/$B878/$B88B ADDA ,U+',
      why: 'service mode ROM checksums, one per 8 KB chip',
    },
    {
      lo: 0xe000, hi: 0xffff, reader: '$B743/$B758 LDX -$2000,U',
      why: 'service RAM test of $0000-$1FFF: the pattern is $E000-$FFFF',
    },
    {
      // Not an ignoredReader of tools/coverage.mjs: its reads are in
      // coverage dataRead, which the check below accepts here.
      lo: 0xe000, hi: 0xe3bf, reader: '$B7AC/$B7C1 LDX $7FC0,U',
      why: 'sound-RAM test of $6040-$63FF: the pattern is $E000-$E3BF',
      coverage: true,
    },
  ]),
  sub: Object.freeze([
    {
      lo: 0xa000, hi: 0xffff, reader: '$E018/$E02B/$E03E ADDA ,X+',
      why: 'reset_sub checksums its three ROMs',
    },
  ]),
  sound: Object.freeze([
    {
      lo: 0xe000, hi: 0xffff, reader: '$E013 ADDA ,X+',
      why: 'reset_sound checksums its ROM',
    },
  ]),
});

/**
 * The data bitmaps: bit (a - base) set = byte a is data. Code is what the
 * listing tracer decoded as instructions; READ_AS_DATA is then set.
 * Throws if the oracle's coverage saw the ROM read a byte as data that
 * is still code (a READ_AS_DATA entry is missing).
 * @param {{ main: Uint8Array, sub: Uint8Array, sound: Uint8Array }} roms
 * @returns {{ masks: Record<'main'|'sub'|'sound', Uint8Array>,
 *   stats: Record<'main'|'sub'|'sound', {data: number, code: number,
 *   whitelisted: number}> }}
 */
export function buildMasks(roms) {
  void roms; // the listing loads the same ROM set itself
  const { results } = buildAll();
  /** @type {Record<string, Uint8Array>} */
  const masks = {};
  /** @type {Record<string, {data: number, code: number, whitelisted: number}>} */
  const stats = {};
  for (const [c, base] of WINDOWS) {
    const cpu = /** @type {'main'|'sub'|'sound'} */ (c);
    const owner = results[cpu].trace.owner; // -1 = not an instruction byte
    const n = 0x10000 - base;
    const mask = new Uint8Array(n / 8);
    const set = (/** @type {number} */ a) => { mask[(a - base) >> 3] |= 1 << ((a - base) & 7); };
    const isSet = (/** @type {number} */ a) => ((mask[(a - base) >> 3] >> ((a - base) & 7)) & 1) === 1;
    let data = 0;
    for (let a = base; a <= 0xffff; a += 1) if (owner[a] === -1) { set(a); data += 1; }
    let whitelisted = 0;
    for (const w of READ_AS_DATA[cpu]) {
      for (let a = w.lo; a <= w.hi; a += 1) if (!isSet(a)) { set(a); whitelisted += 1; }
    }
    // Cross-check against what the real ROM read on the oracle board.
    const cov = JSON.parse(readFileSync(join(COV_DIR, `${cpu}.json`), 'utf8'));
    // Sweeps whose readers coverage.mjs ignores never show up there.
    const inSweep = (/** @type {number} */ a) => SWEEPS[cpu]
      .some((s) => s.coverage === true && a >= s.lo && a <= s.hi);
    const bad = (/** @type {number[]} */ (cov.dataRead ?? []))
      .filter((a) => a >= base && !isSet(a) && !inSweep(a));
    if (bad.length) {
      const list = bad.slice(0, 8).map((a) => `$${a.toString(16).toUpperCase()}`);
      throw new Error(`${cpu}: coverage reads code as data at ${list.join(' ')}` +
        `${bad.length > 8 ? ' ...' : ''}; add READ_AS_DATA entries`);
    }
    masks[cpu] = mask;
    stats[cpu] = { data, code: n - data - whitelisted, whitelisted };
  }
  return /** @type {ReturnType<typeof buildMasks>} */ ({ masks, stats });
}

/** @param {Uint8Array} b @returns {string} */
const b64 = (b) => Buffer.from(b).toString('base64');

/**
 * Wrap a long string into quoted, concatenated 76-column lines so the
 * generated file stays readable in an editor.
 * @param {string} s @returns {string}
 */
function wrap(s) {
  const lines = [];
  for (let i = 0; i < s.length; i += 70) lines.push(`'${s.slice(i, i + 70)}'`);
  return `    ${lines.join('\n    + ')}`;
}

/** @param {number} a @returns {string} */
const hex4 = (a) => `$${a.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * The whitelists as comment lines for the generated file (79 columns).
 * @returns {string}
 */
function whitelistComment() {
  const lines = [];
  for (const [cpu] of WINDOWS) {
    const c = /** @type {'main'|'sub'|'sound'} */ (cpu);
    for (const w of READ_AS_DATA[c]) {
      lines.push(` *   ${c} ${hex4(w.lo)}-${hex4(w.hi)} ${w.reader}:`,
        ` *     ${w.why}`);
    }
  }
  const sweeps = [];
  for (const [cpu] of WINDOWS) {
    const c = /** @type {'main'|'sub'|'sound'} */ (cpu);
    for (const w of SWEEPS[c]) {
      sweeps.push(` *   ${c} ${hex4(w.lo)}-${hex4(w.hi)} ${w.reader}:`,
        ` *     ${w.why}`);
    }
  }
  return ` * Code bytes the ROM reads as data (marked data in \`mask\`):\n`
    + `${lines.join('\n')}\n *\n`
    + ` * Whole-ROM sweeps (readable only inside \`romSweep\`):\n`
    + `${sweeps.join('\n')}`;
}

/**
 * @param {{ main: Uint8Array, sub: Uint8Array, sound: Uint8Array }} roms
 *   64 KB CPU images (tools/romset.mjs loadGaplus)
 * @param {Partial<Record<'main'|'sub'|'sound', Uint8Array>>} [masks]
 *   data bitmaps (bit (a - base) set = data byte); absent = all data.
 *   Default: buildMasks(roms), the code/data mask switched on.
 * @returns {string}
 */
export function buildRomdataSource(roms, masks = buildMasks(roms).masks) {
  const parts = WINDOWS.map(([cpu, base]) => {
    // Every byte is shipped, code included: the checksums sum them.
    const bytes = roms[/** @type {'main'} */ (cpu)].slice(base, 0x10000);
    const mask = masks[/** @type {'main'} */ (cpu)];
    const sweeps = SWEEPS[/** @type {'main'} */ (cpu)]
      .map((w) => `[0x${w.lo.toString(16).toUpperCase()}, `
        + `0x${w.hi.toString(16).toUpperCase()}]`).join(', ');
    const hexBase = `0x${base.toString(16).toUpperCase()}`;
    return `  ${cpu}: {\n    base: ${hexBase},\n    data:\n${wrap(b64(bytes))},\n`
      + `    mask: ${mask ? `\n${wrap(b64(mask))}` : 'null'},\n`
      + `    sweeps: [${sweeps}],\n  },`;
  });
  return `// Copyright 2026 by Moshix
// GENERATED by tools/gen-romdata.mjs from the gaplus ROM set -- do not edit.
/**
 * The program ROMs at their CPU addresses (main and sub $A000-$FFFF, sound
 * $E000-$FFFF). Game state holds ROM addresses (tables, strings, paths),
 * so the port reads data exactly where the 6809 did, never from copies.
 *
 * \`mask\` is a bitmap of the bytes that are data (bit i of byte i >> 3,
 * counted from \`base\`): what the listing tracer did not decode as code,
 * plus the code bytes the ROM itself reads as data (below). Reading any
 * other code byte throws, because that can only be a porting mistake.
 * (null = every byte is data.)
 *
${whitelistComment()}
 *
 * Words are big-endian (6809): high byte at the lower address.
 * @see docs/porting-guide.md section 5, tools/gen-romdata.mjs
 */

/** @typedef {'main'|'sub'|'sound'} Cpu */

/** @param {string} s @returns {Uint8Array} */
function decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const RAW = {
${parts.join('\n')}
};

/**
 * @typedef {object} RomImage
 * @property {number} base first ROM address
 * @property {Uint8Array} data bytes from base to $FFFF
 * @property {Uint8Array|null} mask data bitmap, or null = all data
 * @property {number[][]} sweeps [lo, hi] inclusive, see romSweep
 */

/** @param {typeof RAW.main} r @returns {RomImage} */
const unpack = (r) => ({ base: r.base, data: decode(r.data),
  mask: r.mask === null ? null : decode(r.mask), sweeps: r.sweeps });

/** @type {Record<Cpu, RomImage>} */
const ROMS = { main: unpack(RAW.main), sub: unpack(RAW.sub),
  sound: unpack(RAW.sound) };

/** The CPU whose sweep is open (romSweep), or null. @type {Cpu|null} */
let sweeping = null;

/** Tests only: every byte readable (allowCodeReads). */
let codeReads = false;

/** First ROM address of each CPU. */
export const ROM_BASE = Object.freeze({
  main: RAW.main.base, sub: RAW.sub.base, sound: RAW.sound.base,
});

/**
 * Is \`addr\` inside this CPU's ROM window?
 * @param {Cpu} cpu @param {number} addr @returns {boolean}
 */
export function isRom(cpu, addr) {
  return (addr & 0xffff) >= ROMS[cpu].base;
}

/**
 * Is the ROM byte at \`addr\` readable as data (outside a sweep)?
 * @param {Cpu} cpu @param {number} addr @returns {boolean}
 */
export function isData(cpu, addr) {
  const r = ROMS[cpu];
  const i = (addr & 0xffff) - r.base;
  if (i < 0) return false;
  return r.mask === null || ((r.mask[i >> 3] >> (i & 7)) & 1) === 1;
}

/**
 * Run \`fn\` with the whole-ROM sweep of \`cpu\` open: code bytes in that
 * CPU's declared sweep ranges (the checksums, the service RAM test's
 * pattern; listed above) read without throwing. Only the ports of those
 * loops use it, around each read, so a generator never yields while a
 * sweep is open.
 * @template T @param {Cpu} cpu @param {() => T} fn @returns {T}
 */
export function romSweep(cpu, fn) {
  const prev = sweeping;
  sweeping = cpu;
  try {
    return fn();
  } finally {
    sweeping = prev;
  }
}

/**
 * TESTS ONLY: let every ROM byte read, code included, until switched off.
 * For oracle tests that drive routines from random RAM (every mode
 * $00-$FF, random pointers and indexes): states the game never reaches,
 * where the real CPU reads code bytes too and the comparison with the
 * oracle checks the result. The port never calls this (checked by
 * test/unit/game-infra.test.mjs).
 * @param {boolean} on @returns {boolean} the previous setting
 */
export function allowCodeReads(on) {
  const prev = codeReads;
  codeReads = on;
  return prev;
}

/**
 * One byte of a CPU's ROM, at its CPU address.
 * @param {Cpu} cpu @param {number} addr @returns {number}
 */
export function romByte(cpu, addr) {
  const r = ROMS[cpu];
  const a = addr & 0xffff;
  const i = a - r.base;
  const hex = a.toString(16).toUpperCase().padStart(4, '0');
  if (i < 0) throw new Error(\`\${cpu} $\${hex} is not ROM\`);
  if (r.mask !== null && !codeReads && !((r.mask[i >> 3] >> (i & 7)) & 1)
    && !(sweeping === cpu && r.sweeps.some(([lo, hi]) => a >= lo && a <= hi))) {
    throw new Error(\`\${cpu} ROM $\${hex} is code, not data\`);
  }
  return r.data[i];
}

/**
 * Big-endian word from ROM: \`ldx $nnnn\` / \`ldd ,x\` read the high byte
 * first. $FFFF+1 wraps to $0000, which is not ROM and throws.
 * @param {Cpu} cpu @param {number} addr @returns {number}
 */
export function romWord(cpu, addr) {
  return (romByte(cpu, addr) << 8) | romByte(cpu, (addr + 1) & 0xffff);
}

/** Main CPU ROM byte. @param {number} addr @returns {number} */
export const mainRom = (addr) => romByte('main', addr);
/** Sub CPU ROM byte. @param {number} addr @returns {number} */
export const subRom = (addr) => romByte('sub', addr);
/** Sound CPU ROM byte. @param {number} addr @returns {number} */
export const soundRom = (addr) => romByte('sound', addr);
/** Main CPU ROM word. @param {number} addr @returns {number} */
export const mainWord = (addr) => romWord('main', addr);
/** Sub CPU ROM word. @param {number} addr @returns {number} */
export const subWord = (addr) => romWord('sub', addr);
/** Sound CPU ROM word. @param {number} addr @returns {number} */
export const soundWord = (addr) => romWord('sound', addr);
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const roms = loadGaplus();
  const { masks, stats } = buildMasks(roms);
  const src = buildRomdataSource(roms, masks);
  for (const [cpu] of WINDOWS) {
    const st = stats[/** @type {'main'} */ (cpu)];
    console.log(`${cpu.padEnd(5)} data ${String(st.data).padStart(5)}`
      + ` code ${String(st.code).padStart(5)}`
      + ` read-as-data ${String(st.whitelisted).padStart(4)}`);
  }
  if (process.argv.includes('--check')) {
    let cur = '';
    try { cur = readFileSync(OUT, 'utf8'); } catch { /* missing */ }
    if (cur !== src) {
      console.error('src/game/romdata.js is stale; run tools/gen-romdata.mjs');
      process.exit(1);
    }
    console.log('src/game/romdata.js is up to date');
  } else {
    writeFileSync(OUT, src);
    console.log(`wrote ${OUT} (${src.length} bytes)`);
  }
}

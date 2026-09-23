// Copyright 2026 by Moshix
/**
 * Generate the annotated listings of the three Gaplus program ROMs:
 *
 *   reference/gaplus-main.asm    main CPU,  $A000-$FFFF
 *   reference/gaplus-sub.asm     sub CPU,   $A000-$FFFF
 *   reference/gaplus-sound.asm   sound CPU, $E000-$FFFF
 *   reference/symbols.json       labels, RAM names and I/O names
 *
 * There is no commented Gaplus source, so everything is derived from the
 * ROM bytes plus a hand-maintained seed file per CPU:
 *
 *   reference/annotations/<cpu>.json   names, comments, extra entry points,
 *                                      data ranges, table formats, RAM names
 *   reference/coverage/<cpu>.json      (optional) addresses the oracle saw
 *                                      execute; each one becomes a trace root
 *
 * Code is found by recursive descent from the CPU vectors and the seeds:
 * fall-through, branches and calls are followed, the direct-page register is
 * tracked (LDA #n / TFR A,DP) so `<$nn` operands resolve, and computed
 * jumps through ROM pointer tables are recognised and followed (see
 * `dispatchTable`). Every ROM byte then appears in the listing exactly once,
 * as an instruction or as FCB/FDB data. Bytes nothing reaches are marked
 * `[unreached]`. The format of both JSON inputs is documented in
 * docs/disassembly-notes.md.
 *
 * Nothing here is typed in by hand, so re-running it is always safe:
 *   node tools/gen-listing.mjs            write the four files
 *   node tools/gen-listing.mjs --check    exit 1 if any file is stale
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadGaplus, ROOT } from './romset.mjs';
import { disasm, hex } from './m6809dis.mjs';

export const REF = join(ROOT, 'reference');
export const ANN_DIR = join(REF, 'annotations');
export const COV_DIR = join(REF, 'coverage');

/** Longest line anywhere in a listing. */
export const MAX_COL = 79;
/** Column where the comment of a code line starts. */
const COL_NOTE = 45;

/** @typedef {'main'|'sub'|'sound'} Cpu */
export const CPUS = /** @type {const} */ (['main', 'sub', 'sound']);

/** First ROM address of each CPU; all windows end at $FFFF. */
export const ROM_LO = Object.freeze({ main: 0xa000, sub: 0xa000, sound: 0xe000 });

const TITLES = Object.freeze({
  main: 'MAIN CPU  gp2-4.8d $A000, gp2-3b.8c $C000, gp2-2b.8b $E000',
  sub: 'SUB CPU   gp2-8.11d $A000, gp2-7.11c $C000, gp2-6.11b $E000',
  sound: 'SOUND CPU gp2-1.4b $E000',
});

/** 6809 vectors, $FFF0 upwards (the $FFF0 word is reserved). */
const VECTORS = Object.freeze([
  [0xfff0, 'reserved'], [0xfff2, 'SWI3'], [0xfff4, 'SWI2'], [0xfff6, 'FIRQ'],
  [0xfff8, 'IRQ'], [0xfffa, 'SWI'], [0xfffc, 'NMI'], [0xfffe, 'RESET'],
]);

// ---------------------------------------------------------------------------
// Hardware symbols (docs/hardware.md section 3)

/**
 * @typedef {object} HwSym
 * @property {number} lo first address
 * @property {number} hi last address (inclusive)
 * @property {string} name
 * @property {'r'|'w'|'rw'} access which accesses this name applies to
 * @property {boolean} latch the address bits below the decode are
 *   irrelevant: show the bare name for any address in the range
 * @property {number} canon canonical address for symbols.json
 * @property {string} comment
 * @property {((off: number) => string)=} detail per-offset explanation
 */

/** @param {number} off @returns {string} */
function wsgDetail(off) {
  const reg = ['r0', 'r1', 'r2 ctr', 'vol', 'freq lo', 'freq mid',
    'freq hi/wave', 'r7'][off & 7];
  return `WSG voice ${off >> 3} ${reg}`;
}

/** @param {number} off @returns {string} */
function io56Detail(off) {
  const n = ['credits tens', 'credits units', 'credits added',
    'credits used', 'P1 stick', 'P1 fire/start1', 'P2 stick',
    'P2 fire/start2', 'command', 'arg 9 (start ok)', 'arg 10', 'arg 11',
    'arg 12', 'arg 13', 'arg 14', 'arg 15'];
  return `56XX ${n[off]}`;
}

/** @param {number} off @returns {string} */
function io58Detail(off) {
  const n = ['DSWA hi', 'DSWA hi (coin A, lives)', 'DSWB lo (bonus)',
    'DSWB lo (rnd adv)', 'DSWB hi (diff, svc)', 'DSWB hi', 'DSWA lo',
    'DSWA lo (coin B)', 'command'];
  return `58XX ${off < 9 ? n[off] : `arg ${off}`}`;
}

/** @param {number} off @returns {string} */
function io62Detail(off) {
  if (off === 0) return '62XX IN2 (cabinet)';
  if (off === 8) return '62XX mode';
  if (off === 9) return '62XX $6829 (>= $0F: bang)';
  return `62XX byte ${off}`;
}

/**
 * @param {number} lo @param {number} hi @param {string} name
 * @param {string} comment @param {Partial<HwSym>} [extra]
 * @returns {HwSym}
 */
const hw = (lo, hi, name, comment, extra = {}) => ({
  lo, hi, name, comment, access: 'rw', latch: false, canon: lo, ...extra,
});

/** @type {Record<Cpu, HwSym[]>} */
const HW = {
  main: [
    hw(0x0000, 0x03ff, 'TILE_RAM', 'tilemap codes'),
    hw(0x0400, 0x07ff, 'TILE_ATTR', 'tilemap attributes'),
    hw(0x0f80, 0x0fff, 'SPRITE_RAM_1', 'sprite code/colour'),
    hw(0x1780, 0x17ff, 'SPRITE_RAM_2', 'sprite Y/X'),
    hw(0x1f7f, 0x1f7f, 'FLIP_SCREEN', 'flip screen (b0)'),
    hw(0x1f80, 0x1fff, 'SPRITE_RAM_3', 'sprite flags/X msb'),
    hw(0x6000, 0x603f, 'WSG', '15XX sound registers', { detail: wsgDetail }),
    hw(0x6800, 0x680f, 'IO56XX', '56XX I/O (coins, sticks)',
      { detail: io56Detail }),
    hw(0x6810, 0x681f, 'IO58XX', '58XX I/O (DIP switches)',
      { detail: io58Detail }),
    hw(0x6820, 0x682f, 'IO62XX', '62XX (cabinet, noise)',
      { detail: io62Detail }),
    hw(0x7000, 0x77ff, 'IRQ_ON_MAIN', 'main IRQ enable',
      { access: 'w', latch: true, canon: 0x7400 }),
    hw(0x7800, 0x7fff, 'IRQ_OFF_MAIN', 'main IRQ disable + clear',
      { access: 'w', latch: true, canon: 0x7c00 }),
    hw(0x7800, 0x7fff, 'WATCHDOG', 'watchdog reset',
      { access: 'r', latch: true, canon: 0x7c00 }),
    hw(0x8000, 0x87ff, 'SRESET_OFF', 'sub + sound CPUs run, sound on',
      { access: 'w', latch: true, canon: 0x8400 }),
    hw(0x8800, 0x8fff, 'SRESET_ON', 'sub + sound CPUs held in reset',
      { access: 'w', latch: true, canon: 0x8c00 }),
    hw(0x9000, 0x97ff, 'FRESET_OFF', 'I/O chips run',
      { access: 'w', latch: true, canon: 0x9400 }),
    hw(0x9800, 0x9fff, 'FRESET_ON', 'I/O chips held in reset',
      { access: 'w', latch: true, canon: 0x9c00 }),
    hw(0xa000, 0xa003, 'STARFIELD', 'starfield control',
      { access: 'w' }),
  ],
  sub: [
    hw(0x0000, 0x03ff, 'TILE_RAM', 'tilemap codes'),
    hw(0x0400, 0x07ff, 'TILE_ATTR', 'tilemap attributes'),
    hw(0x0f80, 0x0fff, 'SPRITE_RAM_1', 'sprite code/colour'),
    hw(0x1780, 0x17ff, 'SPRITE_RAM_2', 'sprite Y/X'),
    hw(0x1f7f, 0x1f7f, 'FLIP_SCREEN', 'flip screen (b0)'),
    hw(0x1f80, 0x1fff, 'SPRITE_RAM_3', 'sprite flags/X msb'),
    // VINTON: bit A0 of the address is the new mask.
    hw(0x6000, 0x6fff, 'IRQ_ON_SUB', 'sub IRQ enable (odd address)',
      { access: 'w', latch: true, canon: 0x6001 }),
    hw(0x6000, 0x6fff, 'IRQ_OFF_SUB', 'sub IRQ disable (even address)',
      { access: 'w', latch: true, canon: 0x6080 }),
  ],
  sound: [
    hw(0x0000, 0x003f, 'WSG', '15XX sound registers', { detail: wsgDetail }),
    hw(0x2000, 0x3fff, 'WATCHDOG', 'watchdog reset',
      { latch: true, canon: 0x3000 }),
    hw(0x4000, 0x5fff, 'IRQ_ON_SOUND', 'sound IRQ enable',
      { access: 'w', latch: true, canon: 0x4000 }),
    hw(0x6000, 0x7fff, 'IRQ_OFF_SOUND', 'sound IRQ disable + clear',
      { access: 'w', latch: true, canon: 0x6000 }),
  ],
};

/**
 * The hardware symbol for an access, or null.
 * @param {Cpu} cpu @param {number} addr @param {'r'|'w'} access
 * @returns {HwSym|null}
 */
function hwAt(cpu, addr, access) {
  for (const h of HW[cpu]) {
    if (addr < h.lo || addr > h.hi) continue;
    if (h.access !== 'rw' && h.access !== access) continue;
    if (cpu === 'sub' && h.lo === 0x6000) {
      // Sub VINTON: odd address = on, even = off.
      if ((addr & 1) !== (h.name === 'IRQ_ON_SUB' ? 1 : 0)) continue;
    }
    return h;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Game character encoding

/**
 * Tile code -> text for comments. The font is ASCII-ordered for digits,
 * letters and space (see assets/tiles.png); codes $80-$FF repeat $00-$7F.
 * Punctuation sits at its own codes, found by drawing the glyphs of
 * gp2-5.8s: $3B '-', $3C 'x' (times), $3D '=', $3E '/', $3F '?', $5B '.',
 * $28 copyright, $29-$2F the "namco" logo, $5C-$5F "LOOD" of the BLOOD
 * logo, $60-$62 ship and ball icons, $64-$67 frame corners, $68-$6B
 * quotes and apostrophes.
 */
const CHARMAP = (() => {
  /** @type {Map<number, string>} */
  const m = new Map();
  m.set(0x20, ' ');
  for (let c = 0x30; c <= 0x39; c += 1) m.set(c, String.fromCharCode(c));
  for (let c = 0x41; c <= 0x5a; c += 1) m.set(c, String.fromCharCode(c));
  m.set(0x3b, '-'); m.set(0x3c, 'x'); m.set(0x3d, '=');
  m.set(0x3e, '/'); m.set(0x3f, '?'); m.set(0x5b, '.');
  m.set(0x28, '(c)'); m.set(0x68, '"'); m.set(0x69, '"');
  m.set(0x6a, "'"); m.set(0x6b, "'");
  return m;
})();

/**
 * Decode game text for a comment; unknown codes appear as {xx}.
 * @param {number[]} bytes @returns {string}
 */
export function decodeText(bytes) {
  return bytes.map((b) => CHARMAP.get(b & 0x7f) ??
    `{${b.toString(16).toUpperCase().padStart(2, '0')}}`).join('');
}

// ---------------------------------------------------------------------------
// Annotation input

/**
 * @typedef {object} LabelAnn
 * @property {string} name
 * @property {string[]} doc block comment for the routine header
 * @property {boolean} entry trace from here
 * @property {number|null} dp direct page at entry
 */

/**
 * @typedef {object} DataAnn
 * @property {number} lo
 * @property {number} hi exclusive end
 * @property {string} type bytes|words|ptrs|code_ptrs|text|strings
 * @property {number} per bytes per line (bytes) / words per line
 * @property {string} comment
 * @property {number|null} dp for code_ptrs
 * @property {number} term string terminator (strings)
 * @property {number} head header bytes before the text (strings)
 * @property {boolean} reverse text is stored right to left (it is printed
 *   with increasing tile addresses, which run leftwards on the top and
 *   bottom rows)
 */

/**
 * @typedef {object} Ann
 * @property {Map<number, LabelAnn>} labels
 * @property {Map<number, string>} comments per-line comments
 * @property {Map<number, string[]>} blocks comments before a line
 * @property {DataAnn[]} data
 * @property {Map<number, number>} dp DP override at an address
 * @property {Set<number>} noreturn calls to these do not return
 * @property {Map<number, number>} inline bytes of inline data after a JSR
 * @property {Map<number, {count: number, sub: number[]|null}>} tables
 *   explicit table sizes by table address (overrides the heuristics)
 * @property {Map<number, {name: string, size: number, comment: string}>} ram
 *   by canonical (main CPU) address
 * @property {number|null} defaultDp DP for coverage roots
 * @property {string[]} header extra lines for the listing header
 */

/** @param {string|number} v @returns {number} */
function num(v) {
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/^\$|^0x/i, '');
  const n = Number.parseInt(s, 16);
  if (!Number.isFinite(n) || !/^[0-9a-f]+$/i.test(s)) {
    throw new Error(`bad hex value in annotations: ${v}`);
  }
  return n;
}

/**
 * RAM address in the CPU's own space -> canonical (main CPU) address. The
 * sound CPU's $0000-$03FF is main $6000-$63FF; main and sub share
 * $0000-$1FFF.
 * @param {Cpu} cpu @param {number} a @returns {number}
 */
export function canonRam(cpu, a) {
  if (cpu === 'sound' && a < 0x400) return a + 0x6000;
  return a;
}

/**
 * Read and normalise reference/annotations/<cpu>.json (missing = empty).
 * @param {Cpu} cpu @param {string} [dir]
 * @returns {Ann}
 */
export function loadAnnotations(cpu, dir = ANN_DIR) {
  const path = join(dir, `${cpu}.json`);
  /** @type {Record<string, unknown>} */
  const j = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  /** @type {Ann} */
  const ann = {
    labels: new Map(), comments: new Map(), blocks: new Map(), data: [],
    dp: new Map(), noreturn: new Set(), inline: new Map(), tables: new Map(),
    ram: new Map(), defaultDp: null, header: [],
  };
  /** @param {unknown} v @returns {Record<string, unknown>} */
  const obj = (v) => /** @type {Record<string, unknown>} */ (v ?? {});
  /** @param {unknown} v @returns {string[]} */
  const lines = (v) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
  if (j.default_dp !== undefined) ann.defaultDp = num(/** @type {string} */ (j.default_dp));
  ann.header = lines(j.header);
  for (const [k, v] of Object.entries(obj(j.labels))) {
    const o = typeof v === 'string' ? { name: v } : obj(v);
    ann.labels.set(num(k), {
      name: String(o.name),
      doc: lines(o.doc),
      entry: o.entry === true,
      dp: o.dp === undefined ? null : num(/** @type {string} */ (o.dp)),
    });
  }
  for (const [k, v] of Object.entries(obj(j.comments))) ann.comments.set(num(k), String(v));
  for (const [k, v] of Object.entries(obj(j.blocks))) ann.blocks.set(num(k), lines(v));
  for (const [k, v] of Object.entries(obj(j.dp))) ann.dp.set(num(k), num(/** @type {string} */ (v)));
  for (const v of /** @type {unknown[]} */ (j.noreturn ?? [])) ann.noreturn.add(num(/** @type {string} */ (v)));
  for (const [k, v] of Object.entries(obj(j.inline))) ann.inline.set(num(k), Number(v));
  for (const [k, v] of Object.entries(obj(j.tables))) {
    const o = typeof v === 'number' ? { count: v } : obj(v);
    ann.tables.set(num(k), {
      count: Number(o.count),
      sub: Array.isArray(o.sub) ? o.sub.map(Number) : null,
    });
  }
  for (const d of /** @type {Record<string, unknown>[]} */ (j.data ?? [])) {
    const lo = num(/** @type {string} */ (d.addr));
    const hi = d.end !== undefined ? num(/** @type {string} */ (d.end)) + 1
      : lo + Number(d.len);
    if (!(hi > lo)) throw new Error(`${cpu}: bad data range at ${hex(lo, 4)}`);
    const type = String(d.type ?? 'bytes');
    ann.data.push({
      lo, hi, type,
      per: Number(d.per ?? (type === 'bytes' ? 8 : type === 'words' ? 4 : 1)),
      comment: d.comment ? String(d.comment) : '',
      dp: d.dp === undefined ? null : num(/** @type {string} */ (d.dp)),
      term: d.term === undefined ? -1 : num(/** @type {string} */ (d.term)),
      head: Number(d.head ?? 0),
      reverse: d.reverse === true,
    });
    if (d.name) {
      ann.labels.set(lo, {
        name: String(d.name), doc: lines(d.doc), entry: false, dp: null,
      });
    }
  }
  ann.data.sort((a, b) => a.lo - b.lo);
  for (const [k, v] of Object.entries(obj(j.ram))) {
    const o = typeof v === 'string' ? { name: v } : obj(v);
    ann.ram.set(canonRam(cpu, num(k)), {
      name: String(o.name), size: Number(o.size ?? 1),
      comment: o.comment ? String(o.comment) : '',
    });
  }
  return ann;
}

/**
 * Read reference/coverage/<cpu>.json if present. Accepted shapes: a JSON
 * array of addresses, or `{ "executed": [...], "dp": {"AAAA": "HH"} }`
 * (`exec` is accepted for `executed`).
 * Addresses may be numbers or hex strings.
 * @param {Cpu} cpu @param {string} [dir]
 * @returns {{addrs: number[], dp: Map<number, number>}}
 */
export function loadCoverage(cpu, dir = COV_DIR) {
  const path = join(dir, `${cpu}.json`);
  if (!existsSync(path)) return { addrs: [], dp: new Map() };
  const j = JSON.parse(readFileSync(path, 'utf8'));
  // tools/coverage.mjs writes { cpu, exec, dataRead, ignoredReaders }.
  const list = Array.isArray(j) ? j : (j.executed ?? j.exec ?? []);
  /** @type {Map<number, number>} */
  const dp = new Map();
  for (const [k, v] of Object.entries(Array.isArray(j) ? {} : (j.dp ?? {}))) {
    dp.set(num(k), num(/** @type {string} */ (v)));
  }
  return { addrs: list.map((/** @type {string|number} */ a) => num(a)), dp };
}

// ---------------------------------------------------------------------------
// Tracing

/**
 * What the tracer knows about a register at one point of a linear path:
 * a constant, a value loaded from a constant table base (`LDX A,Y` with Y
 * known), or nothing.
 * @typedef {{c: number}|{tbl: number}|null} RegVal
 */

/**
 * @typedef {object} Site
 * @property {number} at address of the computed jump/call
 * @property {number} table table address
 * @property {'code'|'table'} kind code = table of code pointers;
 *   table = table of pointers to code-pointer tables (two-level dispatch)
 * @property {number|null} count entries, when an AND mask bounds the index
 * @property {number|null} dp
 */

/**
 * @typedef {object} Table
 * @property {number} lo @property {number} hi exclusive
 * @property {'code'|'table'|'sub'} kind
 * @property {number[]} from dispatch sites
 * @property {string} how how the size was found
 */

/**
 * @typedef {object} Trace
 * @property {Map<number, import('./m6809dis.mjs').Instr>} ins by start
 * @property {Int32Array} owner start address owning each code byte, or -1
 * @property {Map<number, number|null>} dpAt DP at each instruction
 * @property {Map<number, Set<number|null>>} dpConflict extra DPs seen
 * @property {Map<number, string>} flags per-instruction notes
 * @property {Map<number, Table>} tables by start
 * @property {Site[]} sites
 * @property {Set<number>} roots entry points (vectors, seeds, tables)
 * @property {Map<number, string>} rootWhy
 * @property {Map<number, {from: number, kind: string}[]>} xref by target
 * @property {Set<number>} coverageOnly addresses first reached from coverage
 * @property {number[]} conflicts addresses entered mid-instruction
 */

/** Mnemonic -> accumulator(s) it writes (besides the special cases). */
const WRITES = (() => {
  /** @type {Map<string, string[]>} */
  const m = new Map();
  for (const r of ['A', 'B']) {
    for (const op of ['LD', 'ADD', 'SUB', 'AND', 'OR', 'EOR', 'ADC', 'SBC']) {
      m.set(op + r, [r]);
    }
    for (const op of ['CLR', 'COM', 'NEG', 'INC', 'DEC', 'ASL', 'ASR', 'LSL',
      'LSR', 'ROL', 'ROR', 'XCLR', 'XDEC', 'XNC']) m.set(op + r, [r]);
  }
  m.set('ORA', ['A']); // "OR" + "A" is ORA, already covered, kept for clarity
  for (const op of ['LDD', 'ADDD', 'SUBD', 'MUL']) m.set(op, ['A', 'B']);
  m.set('SEX', ['A']); m.set('DAA', ['A']);
  m.set('LDX', ['X']); m.set('LEAX', ['X']); m.set('ABX', ['X']);
  m.set('LDY', ['Y']); m.set('LEAY', ['Y']);
  m.set('LDU', ['U']); m.set('LEAU', ['U']);
  return m;
})();

/** TFR/EXG register names by nibble (6809; others are undefined). */
const RR = ['D', 'X', 'Y', 'U', 'S', 'PC', '?', '?', 'A', 'B', 'CC', 'DP',
  '?', '?', '?', '?'];

/**
 * Trace one CPU's code.
 * @param {Cpu} cpu @param {Uint8Array} mem 64 KB image
 * @param {Ann} ann
 * @param {{addrs: number[], dp: Map<number, number>}} cov
 * @returns {Trace}
 */
export function trace(cpu, mem, ann, cov) {
  const lo = ROM_LO[cpu];
  const read = (/** @type {number} */ a) => mem[a & 0xffff];
  /** @type {Trace} */
  const t = {
    ins: new Map(), owner: new Int32Array(0x10000).fill(-1),
    dpAt: new Map(), dpConflict: new Map(), flags: new Map(),
    tables: new Map(), sites: [], roots: new Set(), rootWhy: new Map(),
    xref: new Map(), coverageOnly: new Set(), conflicts: [],
  };
  // Annotated data is never traced into.
  const isData = new Uint8Array(0x10000);
  for (const d of ann.data) isData.fill(1, d.lo, d.hi);
  isData.fill(1, 0xfff0, 0x10000);

  /** @type {{addr: number, dp: number|null, cov: boolean}[]} */
  const work = [];
  /**
   * @param {number} to @param {number} from @param {string} kind
   */
  const xref = (to, from, kind) => {
    let l = t.xref.get(to);
    if (!l) { l = []; t.xref.set(to, l); }
    if (!l.some((x) => x.from === from && x.kind === kind)) l.push({ from, kind });
  };
  /** @param {number} a @param {number|null} dp @param {string} why */
  const root = (a, dp, why) => {
    if (a < lo || a >= 0xfff0) return;
    if (!t.roots.has(a)) { t.roots.add(a); t.rootWhy.set(a, why); }
    work.push({ addr: a, dp, cov: false });
  };

  // Vectors.
  for (const [v, name] of VECTORS) {
    if (v === 0xfff0) continue;
    const a = read(v) << 8 | read(v + 1);
    xref(a, v, 'vector');
    root(a, name === 'RESET' ? 0 : ann.defaultDp, `${name} vector`);
  }
  for (const [a, l] of ann.labels) if (l.entry) root(a, l.dp ?? ann.defaultDp, 'seed');
  for (const d of ann.data) {
    if (d.type !== 'code_ptrs') continue;
    for (let p = d.lo; p + 1 < d.hi; p += 2) {
      const a = read(p) << 8 | read(p + 1);
      xref(a, p, 'table');
      root(a, d.dp ?? ann.defaultDp, `table ${hex(d.lo, 4)}`);
    }
  }

  /**
   * Follow one linear path.
   * @param {number} start @param {number|null} dp0 @param {boolean} fromCov
   */
  const run = (start, dp0, fromCov) => {
    let a = start;
    let dp = dp0;
    /** @type {(number|null)[]} */
    const dpStack = [];
    /** @type {Record<string, RegVal>} */
    let reg = { A: null, B: null, X: null, Y: null, U: null };
    /** @type {Record<string, number|null>} AND masks of A/B, scaled by shifts */
    let mask = { A: null, B: null };
    const forget = () => {
      reg = { A: null, B: null, X: null, Y: null, U: null };
      mask = { A: null, B: null };
    };
    while (a >= lo && a < 0xfff0) {
      if (ann.dp.has(a)) dp = ann.dp.get(a) ?? null;
      if (t.ins.has(a)) {
        // Already traced: record a second DP if it differs, then stop.
        const had = t.dpAt.get(a);
        if (had !== dp && dp !== null) {
          let s = t.dpConflict.get(a);
          if (!s) { s = new Set(); t.dpConflict.set(a, s); }
          s.add(dp);
        }
        return;
      }
      if (t.owner[a] !== -1 || isData[a]) {
        t.conflicts.push(a);
        return;
      }
      const ins = disasm(read, a, dp === null ? {} : { dp });
      // An instruction may not run into code already decoded or data.
      for (let k = 0; k < ins.len; k += 1) {
        if (t.owner[a + k] !== -1 || isData[a + k] || a + k >= 0xfff0) {
          t.conflicts.push(a);
          return;
        }
      }
      t.ins.set(a, ins);
      t.dpAt.set(a, dp);
      if (fromCov) t.coverageOnly.add(a);
      for (let k = 0; k < ins.len; k += 1) t.owner[a + k] = a;

      const name = ins.text.split(/\s+/)[0];
      const ops = ins.text.slice(7).trim();

      // --- control flow
      const indirect = ins.target === null &&
        (ins.kind === 'jump' || ins.kind === 'call');
      if (ins.target !== null && ins.kind !== 'other') {
        xref(ins.target, a, ins.kind);
        if (ins.kind === 'call') {
          if (!t.roots.has(ins.target)) {
            t.roots.add(ins.target);
            t.rootWhy.set(ins.target, 'call');
          }
        }
        work.push({ addr: ins.target, dp, cov: fromCov });
      }
      if (indirect) {
        const site = dispatchTable(name, ops, ins, reg, mask, dp);
        if (site) t.sites.push({ ...site, at: a });
        else if (ins.ref !== null && /^\[\$[0-9A-F]{4}\]$/.test(ops) &&
          ins.ref >= lo && ins.ref < 0x10000) {
          // JMP [$nnnn] through a ROM pointer.
          const tg = read(ins.ref) << 8 | read(ins.ref + 1);
          xref(tg, a, ins.kind);
          root(tg, dp, `pointer ${hex(ins.ref, 4)}`);
        } else if (!/PC$/.test(ops) || name === 'TFR' || name === 'EXG') {
          t.flags.set(a, 'indirect');
        }
      }
      if (ins.kind === 'return' || ins.kind === 'jump') return;
      if (ins.kind === 'call') {
        if (ins.target !== null && ann.noreturn.has(ins.target)) return;
        const skip = ins.target === null ? 0 : ann.inline.get(ins.target) ?? 0;
        forget();
        a += ins.len;
        if (skip) {
          // Inline arguments after the call: the callee skips them.
          t.flags.set(a, `inline ${skip}`);
          a += skip;
        }
        continue;
      }

      // --- register knowledge for jump tables and DP
      updateRegs(name, ops, ins, reg, mask);
      if (name === 'TFR' || name === 'EXG') {
        const pb = ins.bytes[ins.bytes.length - 1];
        const src = RR[pb >> 4];
        const dst = RR[pb & 15];
        if (dst === 'DP' && name === 'TFR') {
          const v = reg[src];
          dp = v && 'c' in v ? v.c & 0xff : null;
        } else if (dst === 'DP' || src === 'DP') {
          dp = null;
        }
      }
      if ((name === 'PSHS' || name === 'PSHU') && /\bDP\b/.test(ops)) dpStack.push(dp);
      if ((name === 'PULS' || name === 'PULU') && /\bDP\b/.test(ops)) {
        dp = dpStack.length ? dpStack.pop() ?? null : null;
      }
      a += ins.len;
    }
  };

  // Work to a fixed point: trace, then size the dispatch tables with what
  // is known and follow their entries, until nothing new turns up.
  const settle = () => {
    for (let round = 0; round < 50; round += 1) {
      while (work.length) {
        const w = /** @type {{addr: number, dp: number|null, cov: boolean}} */ (work.pop());
        run(w.addr, w.dp, w.cov);
      }
      const before = t.roots.size;
      sizeTables(t, mem, lo, ann, isData);
      for (const tb of t.tables.values()) {
        if (tb.kind === 'table') continue;
        for (let p = tb.lo; p + 1 < tb.hi; p += 2) {
          const tg = read(p) << 8 | read(p + 1);
          const site = t.sites.find((s) => tb.from.includes(s.at));
          root(tg, site ? site.dp : ann.defaultDp, `table ${hex(tb.lo, 4)}`);
        }
      }
      // Table entries that were already roots add nothing new; stop when a
      // round finds no new root (root() queued any new one onto `work`).
      if (t.roots.size === before) break;
    }
  };
  settle();
  // Then the coverage input: whatever it reaches that the static trace did
  // not is marked coverage-only. Each executed address that starts such a
  // run (nothing coverage-only falls into it) becomes a routine root.
  for (const a of cov.addrs) {
    work.push({ addr: a, dp: cov.dp.get(a) ?? ann.defaultDp, cov: true });
  }
  if (cov.addrs.length) {
    settle();
    const follows = new Set();
    for (const a of t.coverageOnly) {
      const ins = t.ins.get(a);
      if (ins && ins.kind !== 'jump' && ins.kind !== 'return') follows.add(a + ins.len);
    }
    for (const a of cov.addrs) {
      if (t.coverageOnly.has(a) && !follows.has(a) && !t.roots.has(a)) {
        t.roots.add(a);
        t.rootWhy.set(a, 'coverage');
      }
    }
  }
  for (const tb of t.tables.values()) {
    if (tb.kind === 'table') continue;
    for (let p = tb.lo; p + 1 < tb.hi; p += 2) xref(read(p) << 8 | read(p + 1), p, 'table');
  }
  return t;
}

/**
 * Update what the linear tracer knows about A, B, X, Y, U after one
 * instruction. Only what the table detection needs: constants from
 * immediates / PC-relative LEA, values fetched from a constant table base,
 * and AND masks of the accumulators scaled by later shifts.
 * @param {string} name @param {string} ops
 * @param {import('./m6809dis.mjs').Instr} ins
 * @param {Record<string, RegVal>} reg @param {Record<string, number|null>} mask
 */
function updateRegs(name, ops, ins, reg, mask) {
  /** @param {string} r @returns {number|null} */
  const constOf = (r) => { const v = reg[r]; return v && 'c' in v ? v.c : null; };
  /** @param {string} r @param {RegVal} v */
  const set = (r, v) => {
    if (r === 'D') { reg.A = null; reg.B = null; mask.A = null; mask.B = null; return; }
    if (r in reg) reg[r] = v;
    if (r === 'A' || r === 'B') mask[r] = null;
  };
  // AND masks: ANDA #m remembers m; shifts scale it.
  const m = /^AND([AB])$/.exec(name);
  if (m && ops.startsWith('#$')) {
    const r = m[1];
    const prev = mask[r];
    reg[r] = null;
    mask[r] = Number.parseInt(ops.slice(2), 16) & (prev ?? 0xff);
    return;
  }
  const sh = /^(ASL|LSL|LSR)([AB])$/.exec(name);
  if (sh) {
    const r = sh[2];
    const prev = mask[r];
    reg[r] = null;
    mask[r] = prev === null ? null
      : sh[1] === 'LSR' ? prev >> 1 : (prev << 1) & 0xff;
    return;
  }
  if (name === 'TFR' || name === 'EXG') {
    const pb = ins.bytes[ins.bytes.length - 1];
    const src = RR[pb >> 4];
    const dst = RR[pb & 15];
    if (name === 'TFR') {
      set(dst, reg[src] ?? null);
      if ((dst === 'A' || dst === 'B') && (src === 'A' || src === 'B')) mask[dst] = mask[src];
    } else {
      const v = reg[src] ?? null;
      set(src, reg[dst] ?? null);
      set(dst, v);
    }
    return;
  }
  if (/^(PULS|PULU)$/.test(name)) {
    for (const r of ops.split(',')) set(r, null);
    return;
  }
  const w = WRITES.get(name);
  if (!w) return;
  if (w.length === 2) { set('D', null); if (name === 'LDD' && ops.startsWith('#')) {
    const v = Number.parseInt(ops.slice(2), 16);
    reg.A = { c: v >> 8 }; reg.B = { c: v & 0xff };
  } return; }
  const r = w[0];
  // LDr #imm
  if (/^LD[ABXYU]$/.test(name) && ops.startsWith('#$')) {
    set(r, { c: Number.parseInt(ops.slice(2), 16) });
    return;
  }
  // LEAr $nnnn,PCR
  if (/^LEA[XYU]$/.test(name) && ops.endsWith(',PCR') && ins.ref !== null) {
    set(r, { c: ins.ref });
    return;
  }
  // LDr A,base / B,base / D,base / ,base with a constant base: a table read.
  const ix = /^(A|B|D|)?,([XYU])$/.exec(ops);
  if (/^LD[XYU]$/.test(name) && ix) {
    const base = constOf(ix[2]);
    set(r, base === null ? null : { tbl: base });
    return;
  }
  set(r, null);
}

/**
 * Recognise a computed jump through a ROM table.
 *   JMP/JSR [A,X]  with X = #tbl           table of code pointers
 *   JMP/JSR [,X]   with X = #ptr           one code pointer
 *   JMP/JSR ,X     with X loaded by LDX A,Y (Y = #tbl): code pointers
 *   JMP/JSR [B,U]  with U loaded by LDU A,U (U = #tbl): two levels, a
 *                  table of pointers to code-pointer tables
 *   TFR X,PC       as JMP ,X
 * @param {string} name @param {string} ops
 * @param {import('./m6809dis.mjs').Instr} ins
 * @param {Record<string, RegVal>} reg @param {Record<string, number|null>} mask
 * @param {number|null} dp
 * @returns {Omit<Site, 'at'>|null}
 */
function dispatchTable(name, ops, ins, reg, mask, dp) {
  /** @param {string} acc @returns {number|null} */
  const countOf = (acc) => {
    const mk = acc === 'A' || acc === 'B' ? mask[acc] : null;
    // A mask m on a doubled index allows m/2 + 1 word entries.
    return mk === null ? null : (mk >> 1) + 1;
  };
  let m = /^\[(A|B|D|),([XYU])\]$/.exec(ops);
  if ((name === 'JMP' || name === 'JSR') && m) {
    const v = reg[m[2]];
    if (v && 'c' in v) {
      return { table: v.c, kind: 'code', count: m[1] === '' ? 1 : countOf(m[1]), dp };
    }
    if (v && 'tbl' in v) return { table: v.tbl, kind: 'table', count: null, dp };
    return null;
  }
  m = /^,([XYU])$/.exec(ops);
  if ((name === 'JMP' || name === 'JSR') && m) {
    const v = reg[m[1]];
    if (v && 'tbl' in v) return { table: v.tbl, kind: 'code', count: null, dp };
    return null;
  }
  if (name === 'TFR' || name === 'EXG') {
    const pb = ins.bytes[ins.bytes.length - 1];
    const v = reg[RR[pb >> 4]];
    if (v && 'tbl' in v) return { table: v.tbl, kind: 'code', count: null, dp };
  }
  return null;
}

/**
 * Work out the extent of every dispatch table. A table ends at the first of:
 * the count from an annotation or an AND mask; the next code byte, data
 * range or other table; the lowest address any of its entries points to
 * above its start (code usually follows the table); an entry that is not a
 * plausible target (outside the ROM, into the middle of a traced
 * instruction or into data, or an undocumented opcode).
 * @param {Trace} t @param {Uint8Array} mem @param {number} lo
 * @param {Ann} ann @param {Uint8Array} isData
 */
function sizeTables(t, mem, lo, ann, isData) {
  const read = (/** @type {number} */ a) => mem[a & 0xffff];
  const word = (/** @type {number} */ a) => read(a) << 8 | read(a + 1);
  /** @type {Map<number, {kind: 'code'|'table'|'sub', from: number[], count: number|null, how: string}>} */
  const want = new Map();
  /**
   * @param {number} a @param {'code'|'table'|'sub'} kind @param {number} from
   * @param {number|null} count @param {string} how
   */
  const add = (a, kind, from, count, how) => {
    const w = want.get(a);
    if (w) {
      if (!w.from.includes(from)) w.from.push(from);
      if (w.count === null && count !== null) { w.count = count; w.how = how; }
      return;
    }
    want.set(a, { kind, from: [from], count, how });
  };
  for (const s of t.sites) {
    const pinned = ann.tables.get(s.table);
    add(s.table, s.kind, s.at, pinned ? pinned.count : s.count,
      pinned ? 'annotation' : s.count !== null ? 'index mask' : 'heuristic');
  }
  // Start positions of all known tables bound each other.
  const starts = () => [...want.keys()].sort((a, b) => a - b);

  /** @param {number} a @returns {boolean} */
  const plausibleCode = (a) => {
    if (a < lo || a >= 0xfff0 || isData[a]) return false;
    if (t.owner[a] !== -1) return t.owner[a] === a;
    return !disasm(read, a).undoc;
  };
  /** @param {number} from @returns {number} end bound from code/data/tables */
  const hardEnd = (from) => {
    let e = 0xfff0;
    for (let a = from; a < e; a += 1) {
      if (t.owner[a] !== -1 || isData[a]) { e = a; break; }
    }
    for (const s of starts()) if (s > from && s < e) e = s;
    return e;
  };

  t.tables.clear();
  // First the two-level tables, so their sub-tables join the list.
  for (const [a, w] of [...want].filter(([, x]) => x.kind === 'table')) {
    const pinned = ann.tables.get(a);
    const end = hardEnd(a);
    let hi = a;
    let low = end;
    const n = w.count ?? 64;
    for (let i = 0; i < n && hi + 2 <= Math.min(end, low); i += 1) {
      const p = word(hi);
      if (p < lo || p >= 0xfff0 || (t.owner[p] !== -1)) break;
      if (p > a && p < low) low = p;
      hi += 2;
    }
    t.tables.set(a, { lo: a, hi, kind: 'table', from: w.from, how: w.how });
    for (let i = 0, p = a; p < hi; p += 2, i += 1) {
      const sub = word(p);
      const cnt = pinned && pinned.sub ? pinned.sub[i] ?? null : null;
      add(sub, 'sub', a, cnt, cnt === null ? 'heuristic' : 'annotation');
    }
  }
  for (const [a, w] of want) {
    if (w.kind === 'table') continue;
    const end = hardEnd(a);
    let hi = a;
    let how = w.how;
    if (w.count !== null && w.how === 'annotation') {
      hi = Math.min(a + 2 * w.count, 0xfff0);
    } else if (w.count !== null) {
      // An index mask gives an upper bound; the table still cannot run
      // into code it points to (only the used low entries exist).
      let low = end;
      for (let i = 0; i < w.count && hi + 2 <= Math.min(end, low); i += 1) {
        const p = word(hi);
        if (p > a && p < low) low = p;
        hi += 2;
      }
      if (hi < a + 2 * w.count) how += ' (clipped)';
    } else {
      let low = end;
      for (let i = 0; i < 128 && hi + 2 <= Math.min(end, low); i += 1) {
        const p = word(hi);
        if (!plausibleCode(p)) break;
        if (p > a && p < low) low = p;
        hi += 2;
      }
    }
    if (hi > a) t.tables.set(a, { lo: a, hi, kind: w.kind, from: w.from, how });
  }
}

// ---------------------------------------------------------------------------
// Listing

/**
 * @typedef {object} Region a data run to render
 * @property {number} lo @property {number} hi
 * @property {string} type
 * @property {number} per
 * @property {string} comment
 * @property {number} term
 * @property {number} head
 * @property {boolean=} reverse
 * @property {string} tag note appended to every line ('' or '[unreached]')
 */

/** @param {number[]} b @returns {string} */
const hexBytes = (b) => b.map((v) => v.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/**
 * Break a comment into pieces that fit `width` columns.
 * @param {string} s @param {number} width @returns {string[]}
 */
export function wrapText(s, width) {
  const out = [];
  let line = '';
  for (const word of s.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) { out.push(line); line = ''; }
    let w = word;
    while (w.length > width) { out.push(w.slice(0, width)); w = w.slice(width); }
    line = line ? line + ' ' + w : w;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/**
 * Emit a code/data line with its comment, wrapping the comment onto
 * continuation lines that start with ';' at the comment column.
 * @param {string[]} out @param {string} left the part before the comment
 * @param {string} note
 */
function emit(out, left, note) {
  if (!note) { out.push(left.trimEnd()); return; }
  const col = Math.max(COL_NOTE, left.trimEnd().length + 1);
  if (col + 2 >= MAX_COL - 8) {
    out.push(left.trimEnd());
    for (const p of wrapText(note, MAX_COL - COL_NOTE - 2)) out.push(' '.repeat(COL_NOTE) + '; ' + p);
    return;
  }
  const parts = wrapText(note, MAX_COL - col - 2);
  out.push(left.padEnd(col) + '; ' + parts[0]);
  for (const p of parts.slice(1)) out.push(' '.repeat(COL_NOTE) + '; ' + p);
}

/**
 * Block comment lines ("; text"), wrapped to 79 columns.
 * @param {string[]} out @param {string[]} lines @param {string} [prefix]
 */
function block(out, lines, prefix = '; ') {
  for (const l of lines) {
    if (l === '') { out.push(prefix.trimEnd()); continue; }
    const indent = /^\s*/.exec(l)?.[0] ?? '';
    for (const p of wrapText(l, MAX_COL - prefix.length - indent.length)) {
      out.push(prefix + indent + p);
    }
  }
}

/**
 * Produce the listing and the symbol table for one CPU.
 * @param {Cpu} cpu @param {Uint8Array} mem @param {Ann} ann
 * @param {Map<number, {name: string, size: number, comment: string}>} ram
 *   all RAM names (canonical addresses), from every CPU's annotations
 * @param {{addrs: number[], dp: Map<number, number>}} cov
 */
export function generate(cpu, mem, ann, ram, cov) {
  const lo = ROM_LO[cpu];
  const read = (/** @type {number} */ a) => mem[a & 0xffff];
  const t = trace(cpu, mem, ann, cov);

  // ---- regions: annotated data, dispatch tables, vectors
  /** @type {Region[]} */
  const regions = [];
  for (const d of ann.data) regions.push({ ...d, tag: '' });
  for (const tb of t.tables.values()) {
    if (ann.data.some((d) => d.lo < tb.hi && tb.lo < d.hi)) continue;
    regions.push({
      lo: tb.lo, hi: tb.hi, type: tb.kind === 'table' ? 'ptrs' : 'code_ptrs',
      per: 1, comment: '', term: -1, head: 0, tag: '',
    });
  }
  regions.push({ lo: 0xfff0, hi: 0x10000, type: 'vectors', per: 1, comment: '', term: -1, head: 0, tag: '' });
  regions.sort((a, b) => a.lo - b.lo);
  const regionAt = new Map(regions.map((r) => [r.lo, r]));
  const inRegion = new Uint8Array(0x10000);
  for (const r of regions) inRegion.fill(1, r.lo, r.hi);

  // ---- labels
  /** @type {Map<number, string>} */
  const labels = new Map();
  /** @type {Set<number>} routine starts (get a header) */
  const routines = new Set();
  for (const [a, l] of ann.labels) labels.set(a, l.name);
  for (const [v, name] of VECTORS) {
    if (v === 0xfff0) continue;
    const a = read(v) << 8 | read(v + 1);
    if (a >= lo && a < 0xfff0 && !labels.has(a)) labels.set(a, `${name.toLowerCase()}_${cpu}`);
  }
  for (const a of t.roots) {
    routines.add(a);
    if (!labels.has(a)) labels.set(a, `sub_${hex(a, 4).slice(1)}`);
  }
  for (const [a, l] of ann.labels) if (l.doc.length && t.ins.has(a)) routines.add(a);
  for (const [to, list] of t.xref) {
    if (to < lo || labels.has(to)) continue;
    if (list.some((x) => x.kind !== 'vector')) {
      labels.set(to, `l${hex(to, 4).slice(1)}`);
    }
  }
  for (const tb of t.tables.values()) {
    if (!labels.has(tb.lo)) labels.set(tb.lo, `tbl_${hex(tb.lo, 4).slice(1)}`);
  }
  // Data referenced by instructions (extended, PC-relative, imm16 pointers
  // into the ROM window that are not code).
  /** @type {Map<number, number[]>} */
  const dataRefs = new Map();
  for (const ins of t.ins.values()) {
    const name = ins.text.split(/\s+/)[0];
    let r = ins.ref;
    const ops = ins.text.slice(7).trim();
    if (r === null && /^#\$[0-9A-F]{4}$/.test(ops) && /^(LD[DXYU]|CMP[XYU])$/.test(name)) {
      r = Number.parseInt(ops.slice(2), 16);
    }
    if (r === null || r < lo || r >= 0xfff0 || ins.kind !== 'other') continue;
    if (cpu === 'main' && r < 0xa800 && /^ST|^CLR/.test(name)) continue;
    if (t.owner[r] !== -1 && t.owner[r] === r) {
      const l = dataRefs.get(r) ?? []; l.push(ins.addr); dataRefs.set(r, l);
      continue;
    }
    if (t.owner[r] !== -1) continue;
    const l = dataRefs.get(r) ?? []; l.push(ins.addr); dataRefs.set(r, l);
    if (!labels.has(r)) labels.set(r, `dat_${hex(r, 4).slice(1)}`);
  }
  // Pointer tables that point at data: label the data they point to.
  for (const r of regions) {
    if (r.type !== 'ptrs') continue;
    for (let p = r.lo; p + 1 < r.hi; p += 2) {
      const v = read(p) << 8 | read(p + 1);
      if (v < lo || v >= 0xfff0 || t.owner[v] !== -1) continue;
      const l = dataRefs.get(v) ?? []; l.push(p); dataRefs.set(v, l);
      if (!labels.has(v)) labels.set(v, `dat_${hex(v, 4).slice(1)}`);
    }
  }
  const routineList = [...routines].sort((a, b) => a - b);
  /** @param {number} a @returns {string} routine containing a */
  const within = (a) => {
    let best = -1;
    for (const r of routineList) { if (r <= a) best = r; else break; }
    return best < 0 ? '' : labels.get(best) ?? '';
  };

  // ---- symbol substitution
  /** @type {Map<string, HwSym>} */
  const usedHw = new Map();
  /** @type {Set<number>} */
  const usedRam = new Set();
  /**
   * @param {number} addr @param {'r'|'w'} access
   * @returns {{text: string, note: string}|null}
   */
  const symFor = (addr, access) => {
    const romRead = addr >= lo && access === 'r';
    if (romRead || (addr >= lo && !(cpu === 'main' && addr < 0xa004))) {
      const l = labels.get(addr);
      if (l) return { text: l, note: '' };
      return null;
    }
    // RAM names only where this CPU actually sees that RAM: the sub CPU's
    // $6000-$6FFF is its IRQ latch, not the sound RAM.
    const visible = cpu === 'main' ? addr < 0x2000 || (addr >= 0x6000 && addr < 0x6400)
      : cpu === 'sub' ? addr < 0x2000 : addr < 0x400;
    const c = canonRam(cpu, addr);
    const exact = visible ? ram.get(c) : undefined;
    if (exact) { usedRam.add(c); return { text: exact.name, note: `[${hex(addr, 4)}]` }; }
    for (let k = 1; k < 64 && visible; k += 1) {
      const r = ram.get(c - k);
      if (r && r.size > k) {
        usedRam.add(c - k);
        return { text: `${r.name}+${k}`, note: `[${hex(addr, 4)}]` };
      }
    }
    const h = hwAt(cpu, addr, access);
    if (h) {
      usedHw.set(h.name, h);
      const off = addr - h.lo;
      const text = h.latch || h.lo === h.hi || off === 0 ? h.name
        : `${h.name}+${hex(off, off > 0xff ? 3 : 2)}`;
      const det = h.detail ? ' ' + h.detail(off) : '';
      return { text, note: `[${hex(addr, 4)}]${det}` };
    }
    return null;
  };

  /**
   * Rewrite an instruction's operand with names; returns the new text and
   * the notes it generates.
   * @param {import('./m6809dis.mjs').Instr} ins
   * @returns {{text: string, note: string}}
   */
  const symbolize = (ins) => {
    const name = ins.text.split(/\s+/)[0];
    let ops = ins.text.slice(7).trim();
    if (!ops) return { text: ins.text, note: '' };
    const access = /^(ST|CLR|XCLR)/.test(name) ? 'w' : 'r';
    const notes = [];
    // Branch / jump / call targets: labels.
    if (ins.target !== null && ins.kind !== 'other') {
      const l = labels.get(ins.target);
      const h = hex(ins.target, 4);
      if (l) ops = ops.replace(h, l);
    } else if (ins.ref !== null) {
      const s = symFor(ins.ref, access);
      const dir = /^<\$([0-9A-F]{2})$/.exec(ops);
      if (dir) {
        if (s) { ops = '<' + s.text; notes.push(s.note || `[${hex(ins.ref, 4)}]`); }
        else notes.push(`[${hex(ins.ref, 4)}]`);
      } else if (s) {
        const h = hex(ins.ref, 4);
        const at = ops.indexOf(h);
        if (at >= 0) {
          // ">$00nn" (forced extended) keeps the '>'.
          ops = ops.slice(0, at) + s.text + ops.slice(at + h.length);
          if (s.note) notes.push(s.note);
        }
      }
    } else {
      // #$nnnn pointers and 16-bit index offsets into named memory.
      const im = /^#\$([0-9A-F]{4})$/.exec(ops);
      const ix = /^(\[?)(-?)\$([0-9A-F]{4}),([XYUS])(\]?)$/.exec(ops);
      if (im && /^(LD[DXYUS]|CMP[DXYUS])$/.test(name)) {
        // Immediates are only pointers when loaded into an index register;
        // LDD/CMP values are named only when they hit a ROM label.
        const v = Number.parseInt(im[1], 16);
        const ptr = /^LD[XYUS]$/.test(name);
        // LDD #n is a value (often a pointer for the OTHER CPU, e.g. the
        // main CPU storing sub-ROM addresses): never name it.
        const s = v === 0 || name === 'LDD' || (!ptr && v < lo) ? null : symFor(v, 'r');
        const latch = s !== null && HW[cpu].some((h) => h.latch && h.name === s.text);
        if (s && !latch) {
          ops = '#' + s.text;
          if (s.note) notes.push(s.note.replace(/^\[/, '[#'));
        }
      } else if (ix && ix[2] === '') {
        // A 16-bit index offset is often a distance between banks ($0800,U)
        // rather than an address: name it only for video/sprite RAM.
        const v = Number.parseInt(ix[3], 16);
        const h = hwAt(cpu, v, access);
        const s = h && !h.latch && /^(TILE|SPRITE)/.test(h.name) ? symFor(v, access) : null;
        if (s) {
          ops = `${ix[1]}${s.text},${ix[4]}${ix[5]}`;
          if (s.note) notes.push(s.note);
        }
      }
    }
    return { text: name.padEnd(7) + ops, note: notes.join(' ') };
  };

  // ---- rendering
  /** @type {string[]} */
  const out = [];
  const bar = ';' + '-'.repeat(MAX_COL - 1);
  const cs = (/** @type {number} */ a, /** @type {number} */ b) => {
    let n = 0; for (let i = a; i < b; i += 1) n += t.owner[i] !== -1 ? 1 : 0; return n;
  };
  const codeBytes = cs(lo, 0x10000);
  block(out, [`Gaplus (Namco 1984, GP2 rev. B) -- ${TITLES[cpu]}`]);
  out.push('; GENERATED by tools/gen-listing.mjs from the ROMs and');
  out.push(`; reference/annotations/${cpu}.json. Do not edit: edit the annotations.`);
  out.push('; Columns: address, bytes, instruction, comment. Direct-page operands');
  out.push('; and named symbols show the resolved address in [brackets].');
  block(out, ann.header);
  out.push(`; ${codeBytes} code bytes, ${(0x10000 - lo) - codeBytes} data bytes,` +
    ` ${routineList.length} routines, ${t.tables.size} dispatch tables.`);
  if (cov.addrs.length) out.push(`; Coverage input: ${cov.addrs.length} executed addresses.`);
  out.push('');

  /** @type {string[]} */
  const body = [];
  /** @param {number} a */
  const header = (a) => {
    const name = labels.get(a) ?? '';
    const l = ann.labels.get(a);
    body.push('');
    body.push(bar);
    body.push(`; ${name}  (${hex(a, 4)})`);
    if (l && l.doc.length) block(body, l.doc);
    const refs = (t.xref.get(a) ?? []).slice().sort((x, y) => x.from - y.from);
    const calls = refs.filter((x) => x.kind === 'call').map((x) => `${hex(x.from, 4)} ${within(x.from)}`.trim());
    const jumps = refs.filter((x) => x.kind === 'jump' || x.kind === 'branch').map((x) => hex(x.from, 4));
    const tabs = refs.filter((x) => x.kind === 'table').map((x) => hex(x.from, 4));
    const vec = refs.filter((x) => x.kind === 'vector').map((x) => {
      const v = VECTORS.find(([va]) => va === x.from);
      return v ? v[1] : hex(x.from, 4);
    });
    if (vec.length) block(body, [`Vector: ${vec.join(', ')}`]);
    if (calls.length) block(body, [`Called from: ${calls.join(', ')}`]);
    if (jumps.length) block(body, [`Jumped to from: ${jumps.join(', ')}`]);
    if (tabs.length) block(body, [`Table entry at: ${tabs.join(', ')}`]);
    const why = t.rootWhy.get(a);
    if (why === 'seed') block(body, ['Entry point from the annotations']);
    if (t.coverageOnly.has(a)) block(body, ['Found by the coverage input only']);
    body.push(bar);
  };
  /** @param {number} a */
  const labelLine = (a) => {
    const l = labels.get(a);
    if (!l) return;
    const refs = t.ins.has(a) ? null : dataRefs.get(a);
    const doc = t.ins.has(a) ? null : ann.labels.get(a)?.doc;
    if (doc && doc.length) block(body, doc);
    if (refs) {
      const list = [...new Set(refs)].sort((x, y) => x - y)
        .map((f) => `${hex(f, 4)} ${within(f)}`.trim());
      block(body, [`Referenced from: ${list.join(', ')}`]);
    }
    body.push(`${l}:`);
  };
  /** @param {number} a */
  const blockLines = (a) => {
    const b = ann.blocks.get(a);
    if (b) block(body, b);
  };

  const unreached = { count: 0 };
  let a = lo;
  while (a < 0x10000) {
    const ins = t.ins.get(a);
    if (ins) {
      if (routines.has(a)) header(a);
      else if (ann.blocks.has(a) || labels.has(a)) body.push('');
      blockLines(a);
      labelLine(a);
      const { text, note } = symbolize(ins);
      const notes = [];
      const c = ann.comments.get(a);
      if (c) notes.push(c);
      if (note) notes.push(note);
      const fl = t.flags.get(a);
      if (fl === 'indirect') notes.push('[indirect]');
      const tb = t.sites.find((s) => s.at === a);
      if (tb) notes.push(`[table ${labels.get(tb.table) ?? hex(tb.table, 4)}]`);
      if (t.dpConflict.has(a)) notes.push('[DP differs on another path]');
      if (ins.undoc) notes.push('[undocumented]');
      emit(body, `${hex(a, 4).slice(1)}: ${hexBytes(ins.bytes).padEnd(15)} ${text}`, notes.join(' '));
      a += ins.len;
      continue;
    }
    const reg = regionAt.get(a);
    if (reg) {
      if (ann.blocks.has(a) || labels.has(a)) body.push('');
      blockLines(a);
      a = renderRegion(reg, body, { labels, read, ann, cpu, labelLine, blockLines, t });
      continue;
    }
    // Loose bytes: data that something references, or unreached.
    let b = a;
    while (b < 0x10000 && !t.ins.has(b) && !regionAt.has(b) && !inRegion[b] &&
      (b === a || (!labels.has(b) && !ann.blocks.has(b)))) b += 1;
    const referenced = labels.has(a) && !t.ins.has(a);
    if (ann.blocks.has(a) || labels.has(a)) body.push('');
    blockLines(a);
    renderLoose(a, b, body, { labels, read, ann, cpu, labelLine, blockLines, t },
      referenced ? '' : '[unreached]');
    if (!referenced) unreached.count += b - a;
    a = b;
  }

  // ---- equates for the symbols used
  if (usedHw.size) {
    out.push('; Hardware (docs/hardware.md section 3)');
    for (const h of [...usedHw.values()].sort((x, y) => x.canon - y.canon)) {
      emit(out, `${h.name.padEnd(16)} EQU   ${hex(h.canon, 4)}`, h.comment);
    }
    out.push('');
  }
  if (usedRam.size) {
    out.push('; RAM (addresses in this CPU\'s space)');
    for (const c of [...usedRam].sort((x, y) => x - y)) {
      const r = ram.get(c);
      if (!r) continue;
      const own = cpu === 'sound' && c >= 0x6000 && c < 0x6400 ? c - 0x6000 : c;
      const size = r.size > 1 ? ` (${r.size} bytes)` : '';
      emit(out, `${r.name.padEnd(16)} EQU   ${hex(own, 4)}`, r.comment + size);
    }
    out.push('');
  }
  out.push(...body);

  /** @type {Record<string, number>} */
  const syms = {};
  for (const [addr, name] of [...labels].sort((x, y) => x[0] - y[0])) syms[name] = addr;
  const dataBytes = (0x10000 - lo) - codeBytes;
  return {
    text: out.join('\n') + '\n',
    syms,
    trace: t,
    stats: {
      code: codeBytes, data: dataBytes, routines: routineList.length,
      tables: t.tables.size,
      unreached: unreached.count,
      conflicts: t.conflicts.length,
    },
  };
}

/**
 * @typedef {object} Ctx
 * @property {Map<number, string>} labels
 * @property {(a: number) => number} read
 * @property {Ann} ann
 * @property {Cpu} cpu
 * @property {(a: number) => void} labelLine
 * @property {(a: number) => void} blockLines
 * @property {Trace} t
 */

/**
 * Render FCB lines for bytes [a, b), 8 per line, breaking at labels.
 * @param {number} a @param {number} b @param {string[]} out @param {Ctx} ctx
 * @param {string} tag
 */
function renderLoose(a, b, out, ctx, tag) {
  if (tag === '' && looksLikeStrings(ctx.read, a, b)) {
    renderRegion({
      lo: a, hi: b, type: 'strings', per: 8, comment: '', term: 0, head: 0,
      tag: '',
    }, out, ctx);
    return;
  }
  ctx.labelLine(a);
  // Split off runs of 16+ identical $00/$FF bytes: EPROM fill, not data.
  /** @type {[number, number, boolean][]} [from, to, isFill] */
  const parts = [];
  let p = a;
  let start = a;
  while (p < b) {
    const v = ctx.read(p);
    let q = p;
    while (q < b && ctx.read(q) === v) q += 1;
    // $FF is EPROM blank; $00 counts as fill only where nothing refers.
    if ((v === 0xff || (v === 0x00 && tag !== '')) && q - p >= 16) {
      if (p > start) parts.push([start, p, false]);
      parts.push([p, q, true]);
      start = q;
    }
    p = q;
  }
  if (b > start) parts.push([start, b, false]);
  for (const [from, to, fill] of parts) {
    for (let q = from; q < to; q += 8) {
      const n = Math.min(8, to - q);
      const bytes = [];
      for (let i = 0; i < n; i += 1) bytes.push(ctx.read(q + i));
      const first = q === from;
      const flag = !first ? '' : fill
        ? `[fill ${hex(ctx.read(q))} x ${to - from}]` : tag;
      const note = [ctx.ann.comments.get(q) ?? '', flag].filter(Boolean).join(' ');
      dataLine(out, q, bytes, 'FCB', bytes.map((x) => hex(x)).join(','), note);
    }
  }
}

/** Tile codes that are text: space, (c), digits, punctuation, A-Z, '.'. */
const TEXT_CODES = new Set([0x20, 0x28, 0x68, 0x69, 0x6a, 0x6b]);
for (let c = 0x30; c <= 0x3f; c += 1) if (c !== 0x3a) TEXT_CODES.add(c);
for (let c = 0x41; c <= 0x5b; c += 1) TEXT_CODES.add(c);

/**
 * Is [a, b) a run of zero-terminated game-text strings (each at least two
 * characters, with at least one letter or digit)? Used to show referenced
 * data as text without an annotation.
 * @param {(a: number) => number} read @param {number} a @param {number} b
 * @returns {boolean}
 */
export function looksLikeStrings(read, a, b) {
  if (b - a < 3 || read(b - 1) !== 0) return false;
  let len = 0;
  let alnum = false;
  for (let p = a; p < b; p += 1) {
    const v = read(p);
    if (v === 0) {
      if (len < 2 || !alnum) return false;
      len = 0; alnum = false;
      continue;
    }
    if (!TEXT_CODES.has(v)) return false;
    if ((v >= 0x30 && v <= 0x39) || (v >= 0x41 && v <= 0x5a)) alnum = true;
    len += 1;
  }
  return true;
}

/**
 * One data line: bytes column 24 wide (8 bytes), then the directive.
 * @param {string[]} out @param {number} a @param {number[]} bytes
 * @param {string} op @param {string} arg @param {string} note
 */
function dataLine(out, a, bytes, op, arg, note) {
  const left = `${hex(a, 4).slice(1)}: ${hexBytes(bytes).padEnd(24)} ${op.padEnd(7)}${arg}`;
  emit(out, left, note);
}

/**
 * Render an annotated or detected data region; returns its end.
 * @param {Region} r @param {string[]} out @param {Ctx} ctx
 * @returns {number}
 */
function renderRegion(r, out, ctx) {
  const { read, labels } = ctx;
  const word = (/** @type {number} */ a) => read(a) << 8 | read(a + 1);
  ctx.labelLine(r.lo);
  let first = true;
  const note = (/** @type {number} */ a, /** @type {string} */ extra = '') => {
    const parts = [];
    if (first && r.comment) parts.push(r.comment);
    const c = ctx.ann.comments.get(a);
    if (c) parts.push(c);
    if (extra) parts.push(extra);
    first = false;
    return parts.join(' ');
  };
  /** @param {number} p a word inside the region: label it if possible */
  const ptrText = (p) => labels.get(word(p)) ?? hex(word(p), 4);
  let p = r.lo;
  if (r.type === 'vectors') {
    for (const [v, name] of VECTORS) {
      const tgt = word(v);
      const l = labels.get(tgt);
      dataLine(out, v, [read(v), read(v + 1)], 'FDB', l ?? hex(tgt, 4),
        `${name}${l ? ' ' + hex(tgt, 4) : ''}`);
    }
    return 0x10000;
  }
  while (p < r.hi) {
    if (p !== r.lo && (labels.has(p) || ctx.ann.blocks.has(p))) {
      out.push('');
      ctx.blockLines(p);
      ctx.labelLine(p);
    }
    // Stop a line at the next label so labels land on line starts.
    let lim = r.hi;
    for (let q = p + 1; q < r.hi; q += 1) {
      if (labels.has(q) || ctx.ann.blocks.has(q)) { lim = q; break; }
    }
    if (r.type === 'ptrs' || r.type === 'code_ptrs' || r.type === 'words') {
      if (lim - p < 2) {
        dataLine(out, p, [read(p)], 'FCB', hex(read(p)), note(p));
        p += 1;
        continue;
      }
      const n = Math.max(1, Math.min(r.per, Math.floor((lim - p) / 2)));
      const bytes = [];
      const args = [];
      const tg = [];
      for (let i = 0; i < n; i += 1) {
        bytes.push(read(p + 2 * i), read(p + 2 * i + 1));
        if (r.type === 'words') args.push(hex(word(p + 2 * i), 4));
        else {
          args.push(ptrText(p + 2 * i));
          if (labels.has(word(p + 2 * i))) tg.push(hex(word(p + 2 * i), 4));
        }
      }
      const idx = r.type === 'words' ? '' : `[${(p - r.lo) / 2}]`;
      dataLine(out, p, bytes, 'FDB', args.join(','), note(p, [idx, ...tg].filter(Boolean).join(' ')));
      p += 2 * n;
      continue;
    }
    if (r.type === 'strings' || r.type === 'text') {
      // strings: [head bytes][text ... term]; text: the whole range is text.
      let e = lim;
      let s = p;
      if (r.type === 'strings') {
        s = Math.min(p + r.head, lim);
        e = s;
        while (e < lim && read(e) !== r.term) e += 1;
        if (e < lim) e += 1; // include the terminator
      }
      if (s > p) {
        const hb = [];
        for (let q = p; q < s; q += 1) hb.push(read(q));
        dataLine(out, p, hb, 'FCB', hb.map((x) => hex(x)).join(','), note(p, 'header'));
      }
      // The decoded text goes on its own comment line above the bytes, cut
      // (not word-wrapped, so runs of spaces survive) to fit 79 columns.
      const all = [];
      for (let k = s; k < e; k += 1) {
        if (!(r.type === 'strings' && k === e - 1 && read(k) === r.term)) all.push(read(k));
      }
      const shown = `"${decodeText(r.reverse ? all.slice().reverse() : all)}"` +
        (r.reverse ? ' (stored reversed)' : '');
      const w = MAX_COL - 4;
      for (let k = 0; k < shown.length; k += w) out.push(`;   ${shown.slice(k, k + w)}`);
      for (let q = s; q < e; q += 8) {
        const tb = [];
        for (let k = q; k < Math.min(e, q + 8); k += 1) tb.push(read(k));
        dataLine(out, q, tb, 'FCB', tb.map((x) => hex(x)).join(','), note(q));
      }
      p = e;
      continue;
    }
    // bytes
    const n = Math.min(r.per, lim - p);
    const bytes = [];
    for (let i = 0; i < n; i += 1) bytes.push(read(p + i));
    dataLine(out, p, bytes, 'FCB', bytes.map((x) => hex(x)).join(','), note(p));
    p += n;
  }
  return r.hi;
}

// ---------------------------------------------------------------------------
// Driver

/**
 * Build everything in memory.
 * @param {{annDir?: string, covDir?: string}} [opts]
 * @returns {{files: Map<string, string>, stats: Record<string, Record<string, number>>, results: Record<string, ReturnType<typeof generate>>}}
 */
export function buildAll(opts = {}) {
  const roms = loadGaplus();
  /** @type {Record<string, Ann>} */
  const anns = {};
  /** @type {Map<number, {name: string, size: number, comment: string}>} */
  const ram = new Map();
  for (const cpu of CPUS) {
    anns[cpu] = loadAnnotations(cpu, opts.annDir);
    for (const [a, r] of anns[cpu].ram) {
      const prev = ram.get(a);
      if (prev && prev.name !== r.name) {
        throw new Error(`RAM ${hex(a, 4)} named ${prev.name} and ${r.name}`);
      }
      if (!prev || (!prev.comment && r.comment)) ram.set(a, r);
    }
  }
  /** @type {Map<string, string>} */
  const files = new Map();
  /** @type {Record<string, Record<string, number>>} */
  const stats = {};
  /** @type {Record<string, ReturnType<typeof generate>>} */
  const results = {};
  /** @type {Record<string, Record<string, number>>} */
  const symbols = { main: {}, sub: {}, sound: {}, ram: {}, io: {} };
  for (const cpu of CPUS) {
    const r = generate(cpu, roms[cpu], anns[cpu], ram, loadCoverage(cpu, opts.covDir));
    results[cpu] = r;
    files.set(join(REF, `gaplus-${cpu}.asm`), r.text);
    symbols[cpu] = r.syms;
    stats[cpu] = r.stats;
  }
  const ramSorted = [...ram].sort((x, y) => x[0] - y[0]);
  for (const [a, r] of ramSorted) symbols.ram[r.name] = a;
  /** @type {Record<string, string>} */
  const ramNotes = {};
  for (const [, r] of ramSorted) if (r.comment) ramNotes[r.name] = r.comment;
  for (const cpu of CPUS) {
    for (const h of HW[cpu]) {
      const key = cpu === 'main' ? h.name : `${cpu}:${h.name}`;
      if (cpu !== 'main' && HW.main.some((m) => m.name === h.name && m.canon === h.canon)) continue;
      symbols.io[key] = h.canon;
    }
  }
  const json = {
    _comment: 'GENERATED by tools/gen-listing.mjs. ram and io addresses are ' +
      'main-CPU addresses (sound $0000-$03FF = main $6000-$63FF); io keys ' +
      'prefixed "sub:" / "sound:" are in that CPU\'s space.',
    ...symbols,
    ram_comments: ramNotes,
  };
  files.set(join(REF, 'symbols.json'), JSON.stringify(json, null, 1) + '\n');
  return { files, stats, results };
}

function main() {
  const check = process.argv.includes('--check');
  const { files, stats, results } = buildAll();
  let stale = 0;
  for (const [path, text] of files) {
    if (check) {
      const old = existsSync(path) ? readFileSync(path, 'utf8') : '';
      if (old !== text) { console.log(`stale: ${path}`); stale += 1; }
    } else {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
    }
  }
  for (const cpu of CPUS) {
    const s = stats[cpu];
    // One line per CPU, kept within 79 columns.
    console.log(`${cpu.padEnd(5)} code ${String(s.code).padStart(5)} data ` +
      `${String(s.data).padStart(5)} unreached ${String(s.unreached).padStart(4)}` +
      ` routines ${String(s.routines).padStart(3)} tables ${String(s.tables).padStart(2)}` +
      ` conflicts ${s.conflicts}`);
    if (process.argv.includes('--tables')) {
      const t = results[cpu].trace;
      for (const tb of [...t.tables.values()].sort((x, y) => x.lo - y.lo)) {
        const line = `  ${hex(tb.lo, 4)}-${hex(tb.hi - 1, 4)} ${tb.kind.padEnd(5)}` +
          ` ${String((tb.hi - tb.lo) / 2).padStart(3)} entries  ${tb.how}` +
          `  from ${tb.from.map((f) => hex(f, 4)).join(',')}`;
        console.log(line.length > MAX_COL ? line.slice(0, MAX_COL - 3) + '...' : line);
      }
      for (const c of t.conflicts) console.log(`  conflict at ${hex(c, 4)}`);
      for (const [a, f] of t.flags) if (f === 'indirect') console.log(`  indirect at ${hex(a, 4)}`);
    }
  }
  if (check && stale) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

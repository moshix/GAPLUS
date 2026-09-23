// Copyright 2026 by Moshix
/**
 * Loader for the MAME `gaplus` ROM set -- "Gaplus (GP2 rev. B)", Namco 1984.
 *
 * The chips are the only first-hand evidence of what the board held, so
 * everything in the port that is data rather than code (graphics, colour
 * PROMs, waveform PROM, the programs' own tables) is extracted from here by
 * the tools/ generators and never typed in by hand.
 *
 * Where the chips come from, in order of preference:
 *   1. loose files in roms/  (roms/gp2-4.8d, ...)
 *   2. gaplus.zip in the project root (the stock, torrentzipped MAME set)
 * Every chip's size and CRC32 is checked against CHIPS (the table in
 * docs/PLAN.md, which is MAME's ROM_START(gaplus) in gaplus.cpp); a
 * mismatch throws with the file name, the expected and the actual CRC.
 *
 * The ZIP reader handles the only two methods the MAME sets use -- stored
 * and deflate -- through node:zlib, so the project stays dependency-free.
 *
 * Node only (node:fs, node:zlib). The chip table, CRC-32 and the region
 * layout are pure and live in src/dev/romlayout.js, shared with the
 * browser loader of the emulated preview (src/dev/romfetch.js); the port
 * itself never loads ROMs, it imports the modules the generators write.
 */
import { readFileSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHIPS, crc32, verifyChip, layoutGaplus } from '../src/dev/romlayout.js';

export { CHIPS, crc32, layoutGaplus };

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ROM_DIR = join(ROOT, 'roms');
export const ARCHIVE = join(ROOT, 'gaplus.zip');

/** @typedef {import('../src/dev/romlayout.js').Chip} Chip */

/** End-of-central-directory signature, and the central record signature. */
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

/**
 * Unpack every member of a ZIP archive.
 * @param {string} [path]
 * @returns {Map<string, Uint8Array>} file name -> contents
 */
export function readZip(path = ARCHIVE) {
  const zip = readFileSync(path);
  // The end-of-central-directory record sits at the tail, after a comment of
  // unknown length (torrentzip writes one), so it is found by scanning back.
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== EOCD) eocd -= 1;
  if (eocd < 0) throw new Error(`${path}: no end-of-central-directory record`);

  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  /** @type {Map<string, Uint8Array>} */
  const out = new Map();

  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(p) !== CENTRAL) throw new Error(`${path}: bad central record ${i}`);
    const method = zip.readUInt16LE(p + 10);
    const compressed = zip.readUInt32LE(p + 20);
    const plain = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('latin1', p + 46, p + 46 + nameLen);

    // The local header repeats the name and extra fields and its extra field
    // may differ in length from the central one, so the data offset must come
    // from the local header's own counts.
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataAt, dataAt + compressed);
    let body;
    if (method === 0) body = Buffer.from(raw);
    else if (method === 8) body = inflateRawSync(raw);
    else throw new Error(`${path}: ${name} uses unsupported method ${method}`);
    if (body.length !== plain) throw new Error(`${name}: ${body.length} bytes, expected ${plain}`);
    out.set(name, new Uint8Array(body));

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Read and verify every chip. Loose files in `romDir` win; anything missing
 * there is taken from the ZIP. Throws on a missing chip or a bad CRC.
 * @param {{romDir?: string, archive?: string}} [opts]
 * @returns {Map<string, Uint8Array>} chip name -> contents
 */
export function readChips(opts = {}) {
  const romDir = opts.romDir ?? ROM_DIR;
  const archive = opts.archive ?? ARCHIVE;
  /** @type {Map<string, Uint8Array> | null} */
  let zip = null;
  /** @type {Map<string, Uint8Array>} */
  const out = new Map();
  for (const chip of CHIPS) {
    const loose = join(romDir, chip.name);
    if (existsSync(loose)) {
      const data = new Uint8Array(readFileSync(loose));
      verifyChip(chip, data, loose);
      out.set(chip.name, data);
      continue;
    }
    if (zip === null) {
      if (!existsSync(archive)) {
        throw new Error(`${chip.name}: not in ${romDir} and ${archive} does not exist`);
      }
      zip = readZip(archive);
    }
    const data = zip.get(chip.name);
    if (!data) throw new Error(`${chip.name}: not in ${romDir} nor in ${archive}`);
    verifyChip(chip, data, archive);
    out.set(chip.name, data);
  }
  return out;
}

/** @typedef {import('../src/dev/romlayout.js').GaplusRoms} GaplusRoms */

/**
 * Every chip of the set, read from disk and placed the way MAME's
 * ROM_START(gaplus) and driver_init() place them (see layoutGaplus in
 * src/dev/romlayout.js for the layout).
 * @param {Map<string, Uint8Array>} [chips]
 * @returns {GaplusRoms}
 */
export function loadGaplus(chips = readChips()) {
  return layoutGaplus(chips);
}

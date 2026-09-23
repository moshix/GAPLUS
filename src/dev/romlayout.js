// Copyright 2026 by Moshix
/**
 * The MAME `gaplus` ROM set -- "Gaplus (GP2 rev. B)", Namco 1984 -- as
 * pure data and pure functions: the chip table, CRC-32, and the layout of
 * the chips into the regions the board wires them to.
 *
 * Shared by two loaders that differ only in where the bytes come from:
 *
 *   tools/romset.mjs    Node: loose files in roms/ or gaplus.zip
 *   src/dev/romfetch.js browser: fetch('roms/<name>') for the emulated
 *                       preview (the real ROM on the oracle's 6809 cores)
 *
 * No Node or browser APIs here, so both can import it.
 */

/**
 * @typedef {{name: string, size: number, crc: number, role: string}} Chip
 */

/**
 * Every chip of the set: file name, size, CRC32 (docs/PLAN.md, identical
 * to ROM_START(gaplus) in reference/mame/namco/gaplus.cpp).
 * @type {ReadonlyArray<Chip>}
 */
export const CHIPS = Object.freeze([
  { name: 'gp2-4.8d', size: 0x2000, crc: 0xe525d75d, role: 'main 6809 $A000-$BFFF' },
  { name: 'gp2-3b.8c', size: 0x2000, crc: 0xd77840a4, role: 'main 6809 $C000-$DFFF' },
  { name: 'gp2-2b.8b', size: 0x2000, crc: 0xb3cb90db, role: 'main 6809 $E000-$FFFF' },
  { name: 'gp2-8.11d', size: 0x2000, crc: 0x42b9fd7c, role: 'sub 6809 $A000-$BFFF' },
  { name: 'gp2-7.11c', size: 0x2000, crc: 0x0621f7df, role: 'sub 6809 $C000-$DFFF' },
  { name: 'gp2-6.11b', size: 0x2000, crc: 0x75b18652, role: 'sub 6809 $E000-$FFFF' },
  { name: 'gp2-1.4b', size: 0x2000, crc: 0xed8aa206, role: 'sound 6809 $E000-$FFFF' },
  { name: 'gp2-5.8s', size: 0x2000, crc: 0xf3d19987, role: 'characters' },
  { name: 'gp2-9.11m', size: 0x2000, crc: 0xe6a9ae67, role: 'sprites (plane 0)' },
  { name: 'gp2-11.11p', size: 0x2000, crc: 0x57740ff9, role: 'sprites 0-127' },
  { name: 'gp2-10.11n', size: 0x2000, crc: 0x6cd8ce11, role: 'sprites 128-255' },
  { name: 'gp2-12.11r', size: 0x2000, crc: 0x7316a1f1, role: 'sprites 256-383' },
  { name: 'gp2-3.1p', size: 0x100, crc: 0xa5091352, role: 'red palette PROM' },
  { name: 'gp2-1.1n', size: 0x100, crc: 0x8bc8022a, role: 'green palette PROM' },
  { name: 'gp2-2.2n', size: 0x100, crc: 0x8dabc20b, role: 'blue palette PROM' },
  { name: 'gp2-7.6s', size: 0x100, crc: 0x2faa3e09, role: 'char colour lookup' },
  { name: 'gp2-6.6p', size: 0x200, crc: 0x6f99c2da, role: 'sprite colour lookup lo' },
  { name: 'gp2-5.6n', size: 0x200, crc: 0xc7d31657, role: 'sprite colour lookup hi' },
  { name: 'gp2-4.3f', size: 0x100, crc: 0x2d9fbdd8, role: 'sound WSG waveforms' },
  { name: 'pal10l8.8n', size: 0x2c, crc: 0x08e5b2fe, role: 'PAL (address decode)' },
]);

/** Standard CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) lookup. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32 of a byte array, as MAME and ZIP compute it.
 * @param {Uint8Array} bytes
 * @returns {number} unsigned 32-bit
 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {number} v @returns {string} */
const hex8 = (v) => v.toString(16).padStart(8, '0');

/**
 * Check one chip's size and CRC32 against CHIPS; throws with the file
 * name, where it came from, and the expected and actual values.
 * @param {Chip} chip @param {Uint8Array} data @param {string} from
 */
export function verifyChip(chip, data, from) {
  if (data.length !== chip.size) {
    throw new Error(`${chip.name} (${from}): ${data.length} bytes, expected ${chip.size}`);
  }
  const crc = crc32(data);
  if (crc !== chip.crc) {
    throw new Error(`${chip.name} (${from}): CRC32 ${hex8(crc)}, expected ${hex8(chip.crc)}`
      + ' -- this is not the MAME gaplus (GP2 rev. B) set');
  }
}

/**
 * Lay chips out in a fresh region of `size` bytes, like MAME's ROM_LOAD.
 * @param {Map<string, Uint8Array>} chips
 * @param {number} size
 * @param {Array<[string, number]>} loads [chip name, region offset]
 * @returns {Uint8Array}
 */
function region(chips, size, loads) {
  const out = new Uint8Array(size);
  for (const [name, at] of loads) {
    const data = chips.get(name);
    if (!data) throw new Error(`romset is missing ${name}`);
    out.set(data, at);
  }
  return out;
}

/**
 * @typedef {object} GaplusRoms
 * @property {Map<string, Uint8Array>} chips every chip, verified
 * @property {Uint8Array} main 64 KB: main 6809 address space, ROM at $A000-$FFFF
 * @property {Uint8Array} sub 64 KB: sub 6809 address space, ROM at $A000-$FFFF
 * @property {Uint8Array} sound 64 KB: sound 6809 address space, ROM at $E000-$FFFF
 * @property {Uint8Array} gfx1 16 KB character region, after driver_init
 * @property {Uint8Array} gfx2 48 KB sprite region, after driver_init
 * @property {Uint8Array} proms 2 KB "proms" region: R, G, B, char LUT, sprite LUT lo, hi
 * @property {Uint8Array} wave 256 bytes: 15XX waveform PROM ("namco" region)
 * @property {Uint8Array} pal 44 bytes: PAL10L8 fuse map
 */

/**
 * Every chip of the set, placed the way MAME's ROM_START(gaplus) and
 * gaplus_base_state::driver_init() place them.
 *
 * The program images are whole 64 KB address spaces (zero outside ROM) so a
 * CPU core or a listing tool can index them by address directly.
 *
 * gfx1 and gfx2 are MAME's "gfx1"/"gfx2" regions AFTER driver_init(), which
 * builds a second copy of the 4-bit-per-pixel-pair data so a single
 * gfx_layout can reach both nibbles of each byte:
 *
 *   gfx1[$2000+i] = gfx1[i] >> 4      chars 256-511 = high nibbles of 8S
 *   gfx2[$8000+i] = gfx2[$6000+i] << 4  sprite plane 0 of sprites 128-255 =
 *                                        low nibbles of 11M
 *
 * gfx2 $A000-$BFFF stays zero: sprites 256-383 (11R) have no plane-0 data.
 *
 * @param {Map<string, Uint8Array>} chips chip name -> contents (verified)
 * @returns {GaplusRoms}
 */
export function layoutGaplus(chips) {
  const gfx1 = region(chips, 0x4000, [['gp2-5.8s', 0x0000]]);
  // driver_init: for (i = 0; i < 0x2000; i++) rom[i + 0x2000] = rom[i] >> 4;
  for (let i = 0; i < 0x2000; i += 1) gfx1[i + 0x2000] = gfx1[i] >> 4;

  const gfx2 = region(chips, 0xc000, [
    ['gp2-11.11p', 0x0000], ['gp2-10.11n', 0x2000],
    ['gp2-12.11r', 0x4000], ['gp2-9.11m', 0x6000],
  ]);
  // driver_init: rom = gfx2 + 0x6000; rom[i + 0x2000] = rom[i] << 4 (uint8).
  for (let i = 0; i < 0x2000; i += 1) gfx2[0x8000 + i] = (gfx2[0x6000 + i] << 4) & 0xff;

  return {
    chips,
    main: region(chips, 0x10000, [['gp2-4.8d', 0xa000], ['gp2-3b.8c', 0xc000], ['gp2-2b.8b', 0xe000]]),
    sub: region(chips, 0x10000, [['gp2-8.11d', 0xa000], ['gp2-7.11c', 0xc000], ['gp2-6.11b', 0xe000]]),
    sound: region(chips, 0x10000, [['gp2-1.4b', 0xe000]]),
    gfx1,
    gfx2,
    proms: region(chips, 0x800, [
      ['gp2-3.1p', 0x000], ['gp2-1.1n', 0x100], ['gp2-2.2n', 0x200], ['gp2-7.6s', 0x300],
      ['gp2-6.6p', 0x400], ['gp2-5.6n', 0x600],
    ]),
    wave: region(chips, 0x100, [['gp2-4.3f', 0]]),
    pal: region(chips, 0x2c, [['pal10l8.8n', 0]]),
  };
}

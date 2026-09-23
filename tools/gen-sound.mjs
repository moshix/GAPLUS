// Copyright 2026 by Moshix
/**
 * Emit src/audio/waveforms.js from the Gaplus waveform PROM gp2-4.3f
 * (MAME region "namco"). Nothing is transcribed by hand.
 *
 * How MAME's namco_15xx_device uses the PROM (reference/mame/sound/
 * namco.cpp, namco_audio_device<8, false>):
 *
 *   device_start      installs the 256-byte region as ROM at $00-$FF of
 *                     the device's data space;
 *   waveform_r(pos)   Packed == false: (byte[pos & 0xff] & 0x0f) - 8,
 *                     i.e. the LOW nibble, played signed (-8 .. +7);
 *   namco_update_one  select <<= 5; pos = select + ((counter >> fracbits)
 *                     & 31), so waveform n is bytes n*32 .. n*32+31;
 *                     each stream sample adds waveform * volume with
 *                     add_int(..., MIX_RES), MIX_RES = 128 * 8 = 1024.
 *
 * The module therefore holds the raw low nibbles (WAVEFORMS) and the
 * table MAME's older build_decoded_waveform kept and the current code
 * computes inline: (nibble - 8) * volume for the 16 volumes
 * (DECODED_WAVEFORMS). The high nibble of every PROM byte is ignored.
 *
 * Usage: node tools/gen-sound.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGaplus, ROOT } from './romset.mjs';

const WAVES = 8;
const STEPS = 32;

/**
 * Render the module text.
 * @param {Uint8Array} prom gp2-4.3f (256 bytes)
 * @returns {string}
 */
export function renderWaveforms(prom) {
  if (prom.length < WAVES * STEPS) throw new Error('gp2-4.3f too short');
  const rows = [];
  for (let w = 0; w < WAVES; w += 1) {
    const vals = [];
    for (let i = 0; i < STEPS; i += 1) vals.push(prom[w * STEPS + i] & 0x0f);
    const fmt = (a) => a.map((v) => v.toString().padStart(2)).join(',');
    rows.push(`  // waveform ${w}`);
    rows.push(`  ${fmt(vals.slice(0, 16))},`);
    rows.push(`  ${fmt(vals.slice(16))},`);
  }
  return `// Copyright 2026 by Moshix
/**
 * GENERATED FILE -- do not edit by hand.
 * Run \`node tools/gen-sound.mjs\` to regenerate.
 *
 * The Namco 15XX's eight waveforms, from the Gaplus waveform PROM
 * gp2-4.3f: 32 steps each, 4-bit unsigned (the low nibble of each PROM
 * byte; the chip plays them as value - 8). Waveform n occupies entries
 * n*32 .. n*32+31, the addressing MAME uses ((select << 5) + position).
 */

/** Number of waveforms, steps per waveform and volume levels. */
export const WAVE_COUNT = ${WAVES};
export const WAVE_STEPS = ${STEPS};
export const VOLUME_LEVELS = 16;

/** @type {Uint8Array} 256 entries, low nibble of each PROM byte. */
export const WAVEFORMS = Uint8Array.from([
${rows.join('\n')}
]);

/**
 * The volume-scaled table: DECODED_WAVEFORMS[(volume << 8) | pos] =
 * waveform_r(pos) * volume = ((WAVEFORMS[pos] & 0x0f) - 8) * volume,
 * exactly the integer namco_update_one hands to add_int (which divides
 * by MIX_RES = 1024). Volume 0 is all zeros (MAME skips such a voice).
 * @type {Int8Array} 16 x 256 entries, -120 .. +105
 */
export const DECODED_WAVEFORMS = (() => {
  const t = new Int8Array(VOLUME_LEVELS * 256);
  for (let v = 0; v < VOLUME_LEVELS; v += 1) {
    for (let pos = 0; pos < 256; pos += 1) t[(v << 8) | pos] = ((WAVEFORMS[pos] & 0x0f) - 8) * v;
  }
  return t;
})();
`;
}

/** Write src/audio/waveforms.js. */
function main() {
  const { wave } = loadGaplus();
  const dir = join(ROOT, 'src/audio');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'waveforms.js');
  writeFileSync(out, renderWaveforms(wave));
  console.log(`wrote ${out}`);
}

// Run only as a script, so tests can import renderWaveforms.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();

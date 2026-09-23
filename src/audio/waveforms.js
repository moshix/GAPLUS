// Copyright 2026 by Moshix
/**
 * GENERATED FILE -- do not edit by hand.
 * Run `node tools/gen-sound.mjs` to regenerate.
 *
 * The Namco 15XX's eight waveforms, from the Gaplus waveform PROM
 * gp2-4.3f: 32 steps each, 4-bit unsigned (the low nibble of each PROM
 * byte; the chip plays them as value - 8). Waveform n occupies entries
 * n*32 .. n*32+31, the addressing MAME uses ((select << 5) + position).
 */

/** Number of waveforms, steps per waveform and volume levels. */
export const WAVE_COUNT = 8;
export const WAVE_STEPS = 32;
export const VOLUME_LEVELS = 16;

/** @type {Uint8Array} 256 entries, low nibble of each PROM byte. */
export const WAVEFORMS = Uint8Array.from([
  // waveform 0
   7, 9,11,13,14,15,15,14,12,10, 8, 6, 6, 7, 7, 7,
   7, 7, 7, 8, 8, 6, 4, 2, 1, 1, 0, 0, 1, 3, 5, 7,
  // waveform 1
   8, 9,10,11,12,13,14,15,15,14,13,12,11,10, 9, 8,
   7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7,
  // waveform 2
  15,15,15,15,15,15,15,15, 0, 0, 0, 0, 0, 0, 0, 0,
   0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  // waveform 3
  10,12,14,15,14,12,10, 7, 7,10,12,14,15,14,12,10,
   5, 3, 1, 0, 1, 3, 5, 7, 7, 5, 3, 1, 0, 1, 3, 5,
  // waveform 4
  11,13,13,11, 8, 8, 9,12,14,15,14,11, 7, 6, 6, 8,
   9, 9, 8, 4, 1, 0, 1, 3, 6, 7, 7, 4, 2, 2, 4, 7,
  // waveform 5
   8,11,13,14,15,14,13,11, 8, 5, 2, 1, 0, 1, 2, 5,
   8,12,14,15,14,12, 8, 5, 1, 0, 1, 5, 8,15, 8, 0,
  // waveform 6
  13, 6, 9, 1, 6, 5,15,12,10,12, 4, 4, 2,11, 8,14,
   5, 8, 3,10, 6, 9, 2, 9, 7, 0, 9, 5,10, 5, 8, 6,
  // waveform 7
  15,15,14, 0, 1, 1, 0, 0,12,12,11, 0, 1, 1, 0, 0,
  10,10, 9, 0, 1, 1, 0, 0, 8, 8, 7, 0, 1, 1, 0, 0,
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

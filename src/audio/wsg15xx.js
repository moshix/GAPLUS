// Copyright 2026 by Moshix
/**
 * The Namco 15XX waveform sound generator as MAME's namco_15xx_device runs
 * it for Gaplus (reference/mame/sound/namco.cpp, namco.h;
 * reference/mame/namco/gaplus.cpp). Pure JavaScript: it runs in node tests,
 * on the main thread and inside the AudioWorklet.
 *
 * THE CHIP. Eight voices, each a 20-bit frequency added to a 32-bit phase
 * counter every stream sample, stepping through one of eight 32-sample
 * 4-bit waveforms (src/audio/waveforms.js, PROM gp2-4.3f) at a 4-bit
 * volume. It sits in a 1 KB window shared by both CPUs (main $6000-$63FF,
 * sound $0000-$03FF); offsets $00-$3F are the registers (namco_15xx_r / _w)
 * and $40-$3FF are plain RAM (not modelled here). Voice ch = 0..7 owns
 * offsets ch*8 + r:
 *
 *   r = 0, 1   stored only (readable)
 *   r = 2      WRITE EVENT: counter integer bits = data & $1F
 *              (counter = (counter & fracmask) | (data & $1F) << 18)
 *   r = 3      volume = data & $0F
 *   r = 4      frequency bits 0-7
 *   r = 5      frequency bits 8-15
 *   r = 6      bits 0-3 frequency bits 16-19, bits 4-6 waveform select
 *   r = 7      stored only
 *
 * A write of the value already stored is ignored entirely (so writing +2
 * with an unchanged byte does NOT reset the phase). Reads return the byte.
 *
 * CLOCK. gaplus.cpp: NAMCO_15XX(config, ..., XTAL(24'576'000) / 1024), i.e.
 * 24 kHz. device_clock_changed doubles the clock until it reaches
 * INTERNAL_RATE = 192 kHz (3 doublings) and adds one fraction bit per
 * doubling: the stream runs at 192,000 samples/s with f_fracbits = 18, so
 * the waveform position is (counter >> 18) & 31. Tone frequency =
 * freq * 192000 / 2^23 = freq * 24000 / 2^20 Hz.
 *
 * OUTPUT. sound_stream_update: nothing at all while sound_enable is false
 * (the counters do not advance either); otherwise, for each voice whose
 * volume is non-zero, add waveform_r(pos) * volume / MIX_RES to every
 * sample and advance its counter (a voice at volume 0 is skipped and its
 * counter holds). MIX_RES = 128 * 8 = 1024. gaplus.cpp routes the 15XX to
 * the speaker at 1.0.
 *
 * sound_enable is true at device_start and afterwards follows the main
 * CPU's SRESET latch ($8000-$87FF write = enabled, $8800-$8FFF = muted).
 *
 * TIMING. One video frame is 405,504 master clocks = 3168 stream samples
 * exactly (128 master clocks, 8 CPU cycles per sample), so a CPU cycle
 * count inside a frame maps to a stream sample as cycle >> 3.
 */

import { WAVEFORMS } from './waveforms.js';

/** Board crystal. */
export const MASTER_CLOCK = 24576000;
/** gaplus.cpp: XTAL(24'576'000) / 1024. */
export const WSG_CLOCK = MASTER_CLOCK / 1024;
/** namco.cpp INTERNAL_RATE: the clock is doubled until it reaches this. */
export const MAME_INTERNAL_RATE = 192000;
/** Number of voices (namco_audio_device<8, false>). */
export const VOICES = 8;
/** namco.h MIX_RES = 128 * MAX_VOICES. */
export const MIX_RES = 128 * VOICES;
/** gaplus.cpp: m_namco_15xx->add_route(ALL_OUTPUTS, "mono", 1.0). */
export const WSG_GAIN = 1.0;
/** Register bytes decoded by namco_15xx_r / _w. */
export const REG_COUNT = 0x40;

/**
 * namco_audio_device::device_clock_changed.
 * @param {number} clock chip clock in Hz
 * @returns {{ rate: number, fracbits: number }}
 */
export function clockChanged(clock) {
  let namcoClock = clock;
  let multiple = 0;
  while (namcoClock < MAME_INTERNAL_RATE) { namcoClock *= 2; multiple += 1; }
  return { rate: namcoClock, fracbits: multiple + 15 };
}

const CLOCK = clockChanged(WSG_CLOCK);
/** Stream rate (192,000) and fraction bits (18). */
export const WSG_RATE = CLOCK.rate;
export const WSG_FRACBITS = CLOCK.fracbits;

/**
 * Video: 6.144 MHz pixel clock, 384 x 264 per frame (docs/hardware.md):
 * 60.6060606... Hz, equal to src/machine/machine.js FRAME_RATE (1.536 MHz
 * / 25,344 cycles). MAME's literal set_refresh_hz(60.606060) differs by
 * 6e-7 Hz (3168.00003 samples per frame); the port uses the exact value.
 */
export const FRAME_RATE = MASTER_CLOCK / 4 / (384 * 264);
/** Stream samples per video frame: 405,504 / 128 = 3168. */
export const SAMPLES_PER_FRAME = (384 * 264 * 4) / (MASTER_CLOCK / WSG_RATE);
/** CPU (1.536 MHz) cycles per stream sample. */
export const CYCLES_PER_SAMPLE = (MASTER_CLOCK / 16) / WSG_RATE;

/** util::make_bitmask<uint32_t>(m_f_fracbits). */
const FRAC_MASK = (1 << WSG_FRACBITS) - 1;

/**
 * The tone a frequency register value produces, Hz.
 * @param {number} freq 20-bit register value
 * @returns {number}
 */
export const toneHz = (freq) => (freq * WSG_RATE) / 2 ** (WSG_FRACBITS + 5);

export class Wsg15xx {
  /**
   * @param {Uint8Array} [wave] the 256-byte waveform PROM (low nibbles
   *   used); defaults to the generated gp2-4.3f table
   */
  constructor(wave = WAVEFORMS) {
    this.wave = wave;
    /** m_soundregs: the 64 register bytes as written. */
    this.soundregs = new Uint8Array(REG_COUNT);
    /** Per-voice state (sound_channel): 20-bit frequency, phase counter. */
    this.frequency = new Uint32Array(VOICES);
    this.counter = new Uint32Array(VOICES);
    /** volume[0] (0-15) and waveform_select (0-7). */
    this.volume = new Uint8Array(VOICES);
    this.waveform = new Uint8Array(VOICES);
    /** device_start: "start with sound enabled". */
    this.soundEnable = true;
  }

  /**
   * namco_15xx_device::namco_15xx_w.
   * @param {number} offset 0-$3F
   * @param {number} data byte
   */
  write(offset, data) {
    offset &= REG_COUNT - 1;
    data &= 0xff;
    if (this.soundregs[offset] === data) return;
    // (m_stream->update() here: the caller renders up to this instant
    // before calling write, which is what the stream update achieves.)
    this.soundregs[offset] = data;
    const ch = offset >> 3;
    const base = ch * 8;
    switch (offset & 7) {
      case 2:
        // Grobda's DAC trick: set the counter's integer (position) bits.
        this.counter[ch] = ((this.counter[ch] & FRAC_MASK)
          | ((data & 0x1f) << WSG_FRACBITS)) >>> 0;
        break;
      case 3:
        this.volume[ch] = data & 0x0f;
        break;
      case 6:
        this.waveform[ch] = (data >> 4) & 7;
      // falls through: register 6 also holds frequency bits 16-19
      case 4:
      case 5:
        // The frequency has 20 bits; the high nibble comes from +6.
        this.frequency[ch] = this.soundregs[base + 4]
          + (this.soundregs[base + 5] << 8)
          + ((this.soundregs[base + 6] & 15) << 16);
        break;
      default:
        break;
    }
  }

  /**
   * namco_15xx_device::namco_15xx_r.
   * @param {number} offset @returns {number}
   */
  read(offset) {
    return this.soundregs[offset & (REG_COUNT - 1)];
  }

  /**
   * namco_audio_device::sound_enable_w (gaplus.cpp sreset_w).
   * @param {boolean|number} state
   */
  setSoundEnable(state) {
    this.soundEnable = Boolean(state);
  }

  /**
   * Write a whole register image, offsets $00-$3F in ascending order, as
   * a burst of CPU writes would (unchanged bytes are ignored as usual).
   * @param {ArrayLike<number>} regs 64 bytes
   */
  writeImage(regs) {
    for (let i = 0; i < REG_COUNT; i += 1) this.write(i, regs[i]);
  }

  /**
   * sound_stream_update + namco_update_one: add `count` stream samples,
   * as the integer sum over voices of waveform * volume (divide by MIX_RES
   * for MAME's float sample), into `out` starting at `offset`. The caller
   * zeroes `out` first. Voice-major, exactly as MAME loops.
   * @param {Int32Array} out @param {number} offset @param {number} count
   */
  renderSums(out, offset, count) {
    // "if no sound, we're done": no output and no counter movement.
    if (!this.soundEnable) return;
    const wave = this.wave;
    const shift = WSG_FRACBITS;
    const end = offset + count;
    for (let ch = 0; ch < VOICES; ch += 1) {
      const v = this.volume[ch];
      // Only update if we have non-zero volume.
      if (v === 0) continue;
      const select = this.waveform[ch] << 5;
      const freq = this.frequency[ch];
      let counter = this.counter[ch];
      for (let i = offset; i < end; i += 1) {
        // waveform_r(select + waveform_position(counter)): low nibble - 8.
        // (MAME's waveform_position takes an int, but >> of the value
        // then & 0x1f gives the same bits as the unsigned shift.)
        const w = (wave[(select + ((counter >>> shift) & 0x1f)) & 0xff] & 0x0f) - 8;
        out[i] += w * v;
        counter = (counter + freq) >>> 0; // uint32_t wrap
      }
      this.counter[ch] = counter;
    }
  }

  /**
   * Render `count` stream samples as floats (MAME's stream values, before
   * the route gain) into `out` at `offset`.
   * @param {Float32Array|Float64Array} out @param {number} offset
   * @param {number} count
   */
  render(out, offset, count) {
    const sums = new Int32Array(count);
    this.renderSums(sums, 0, count);
    for (let i = 0; i < count; i += 1) out[offset + i] = sums[i] / MIX_RES;
  }
}

// Copyright 2026 by Moshix
/**
 * The explosion "bang": a synthesized stand-in for MAME's sample.
 *
 * WHAT MAME DOES. Gaplus's 62XX custom (explosion/noise) is not emulated.
 * Instead gaplus_m.cpp plays sample 0 of the `gaplus` sample set,
 * `bang.wav`, on a 1-channel samples device routed to the speaker at 0.80,
 * whenever the main CPU writes a value >= $0F to $6829 (62XX offset 9):
 * samples->start(0, 0) -- no loop, and a new trigger restarts it from the
 * beginning. FBNeo does the same (BurnSamplePlay(0), gain 0.25). The WAV
 * is a recording from a real board and is not part of the ROM set, so we
 * cannot ship it.
 *
 * THE SUBSTITUTE (a documented departure from MAME). A short burst of
 * filtered noise, one second long, synthesized once at the 192 kHz stream
 * rate by a fixed-seed generator so it is identical on every run:
 *
 *   noise    xorshift32 white noise, sample-and-held for 16 stream samples
 *            (a 12 kHz noise clock). The hold gives the grainy, band-
 *            limited texture of the 11-22 kHz WAVs MAME's sample sets use
 *            and of the digital noise generators Namco's custom chips use.
 *   crack    the noise through a one-pole low-pass whose cutoff falls
 *            exponentially from 5 kHz to 800 Hz (time constant 120 ms),
 *            with an amplitude envelope exp(-t / 60 ms): the bright "k-sh"
 *            onset.
 *   rumble   the noise through two cascaded one-pole low-passes at 220 Hz,
 *            envelope exp(-t / 200 ms): the low body that carries the
 *            tail, like the band-limited noise of Galaga's 54XX explosion
 *            and Bosconian's.
 *   shape    crack + rumble (rumble weighted to comparable loudness),
 *            1.5 ms linear attack (a hard edge but no click), a 40 ms
 *            linear fade at the end, then normalized to a peak of
 *            BANG_PEAK -- a WAV recorded at a sane level, not clipped.
 *
 * The result is heard at BANG_PEAK * SAMPLES_GAIN = 0.4 at the most, which
 * sits above the loudest single 15XX voice (8 * 15 / 1024 = 0.12), as an
 * explosion does. Change the constants here to retune; the tests only pin
 * the envelope's shape, determinism and restart behaviour.
 */

/** gaplus.cpp: m_samples->add_route(ALL_OUTPUTS, "mono", 0.80). */
export const SAMPLES_GAIN = 0.80;
/** Peak of the normalized burst (as a WAV would store it, full scale 1). */
export const BANG_PEAK = 0.5;
/** Length, seconds. */
export const BANG_SECONDS = 1.0;
/** Stream samples each noise value is held (192 kHz / 16 = 12 kHz). */
export const NOISE_HOLD = 16;

const ATTACK_S = 0.0015;
const FADE_S = 0.040;
const CRACK_DECAY_S = 0.060;
const CRACK_FC_START = 5000;
const CRACK_FC_END = 800;
const CRACK_FC_TAU_S = 0.120;
const RUMBLE_DECAY_S = 0.200;
const RUMBLE_FC = 220;
/** Rumble weight: two 220 Hz poles leave little energy, so boost it. */
const RUMBLE_WEIGHT = 6;
const SEED = 0x62bada55;

/**
 * One-pole low-pass coefficient for cutoff fc at sample rate fs:
 * y += a * (x - y), a = 1 - exp(-2 pi fc / fs).
 * @param {number} fc @param {number} fs @returns {number}
 */
const onePole = (fc, fs) => 1 - Math.exp((-2 * Math.PI * fc) / fs);

/**
 * Render the whole burst.
 * @param {number} rate samples per second (the 15XX stream rate)
 * @returns {Float32Array} BANG_SECONDS * rate samples, peak BANG_PEAK
 */
export function synthesizeBang(rate) {
  const n = Math.round(BANG_SECONDS * rate);
  const out = new Float64Array(n);
  let s = SEED >>> 0;
  let noise = 0;
  let crack = 0;
  let r1 = 0;
  let r2 = 0;
  const aRumble = onePole(RUMBLE_FC, rate);
  const attack = ATTACK_S * rate;
  const fadeFrom = n - FADE_S * rate;
  for (let i = 0; i < n; i += 1) {
    if (i % NOISE_HOLD === 0) {
      // xorshift32; map the 32-bit state to [-1, 1).
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      noise = s / 2147483648 - 1;
    }
    const t = i / rate;
    // Crack: cutoff slides down exponentially, fast amplitude decay.
    const fc = CRACK_FC_END + (CRACK_FC_START - CRACK_FC_END) * Math.exp(-t / CRACK_FC_TAU_S);
    crack += onePole(fc, rate) * (noise - crack);
    // Rumble: fixed two-pole low-pass, slow decay.
    r1 += aRumble * (noise - r1);
    r2 += aRumble * (r1 - r2);
    let x = crack * Math.exp(-t / CRACK_DECAY_S)
      + RUMBLE_WEIGHT * r2 * Math.exp(-t / RUMBLE_DECAY_S);
    if (i < attack) x *= i / attack;
    if (i > fadeFrom) x *= (n - 1 - i) / (n - 1 - fadeFrom);
    out[i] = x;
  }
  let peak = 0;
  for (let i = 0; i < n; i += 1) peak = Math.max(peak, Math.abs(out[i]));
  const k = peak > 0 ? BANG_PEAK / peak : 0;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i += 1) f[i] = out[i] * k;
  return f;
}

/** Rendered bursts, one per rate. @type {Map<number, Float32Array>} */
const cache = new Map();

/**
 * Channel 0 of MAME's samples device playing the bang, stepped once per
 * stream sample: silent until triggered, then the burst once, no loop.
 */
export class BangVoice {
  /** @param {number} rate stream rate */
  constructor(rate) {
    let data = cache.get(rate);
    if (data === undefined) { data = synthesizeBang(rate); cache.set(rate, data); }
    this.data = data;
    /** Next sample to play; data.length when idle. */
    this.pos = data.length;
  }

  /** samples->start(0, 0): (re)start from the beginning. */
  trigger() {
    this.pos = 0;
  }

  /** @returns {boolean} true while the burst is sounding */
  get playing() {
    return this.pos < this.data.length;
  }

  /** @returns {number} the next sample, before SAMPLES_GAIN (0 when idle) */
  next() {
    if (this.pos >= this.data.length) return 0;
    const x = this.data[this.pos];
    this.pos += 1;
    return x;
  }
}

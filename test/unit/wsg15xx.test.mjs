// Copyright 2026 by Moshix
/**
 * The 15XX model (src/audio/wsg15xx.js) against a line-by-line
 * transcription of MAME's namco_15xx_device (reference/mame/sound/
 * namco.cpp, namco.h), plus the generated waveform table, the resampler,
 * the frame mixer, the bang, the worklet and the SoundEngine plumbing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Wsg15xx, clockChanged, toneHz, WSG_CLOCK, WSG_RATE, WSG_FRACBITS, MIX_RES,
  SAMPLES_PER_FRAME, CYCLES_PER_SAMPLE, FRAME_RATE, VOICES,
} from '../../src/audio/wsg15xx.js';
import { WAVEFORMS, DECODED_WAVEFORMS } from '../../src/audio/waveforms.js';
import { BoxResampler } from '../../src/audio/resample.js';
import {
  GaplusMixer, packEvent, imageEvents, EV_ENABLE, EV_BANG,
} from '../../src/audio/mixer.js';
import {
  BangVoice, synthesizeBang, BANG_PEAK, BANG_SECONDS, SAMPLES_GAIN,
} from '../../src/audio/bang.js';
import { SoundEngine, cycleToPos } from '../../src/audio/sound.js';
import { loadGaplus, ROOT } from '../../tools/romset.mjs';
import { renderWaveforms } from '../../tools/gen-sound.mjs';

const PROM = loadGaplus().wave;

/**
 * MAME's namco_audio_device<8, false> + namco_15xx_device, transcribed
 * statement by statement. Deliberately naive: separate voice objects, a
 * float stream buffer, C++ integer semantics spelled out.
 */
class MameNamco15xx {
  /** @param {number} clock */
  constructor(clock) {
    // namco.cpp
    this.INTERNAL_RATE = 192000;
    // namco.h
    this.MAX_VOICES = 8;
    this.MIX_RES = 128 * this.MAX_VOICES;
    // device_start: m_sound_enable = true; all voices zeroed.
    this.m_sound_enable = true;
    this.m_channel_list = [];
    for (let i = 0; i < this.MAX_VOICES; i += 1) {
      this.m_channel_list.push({ frequency: 0, counter: 0, volume: [0, 0, 0, 0], waveform_select: 0 });
    }
    // namco_15xx_device::device_start: make_unique_clear<uint8_t[]>(0x40)
    this.m_soundregs = new Array(0x40).fill(0);
    // device_clock_changed
    let clock_multiple;
    this.m_namco_clock = clock;
    for (clock_multiple = 0; this.m_namco_clock < this.INTERNAL_RATE; clock_multiple++) {
      this.m_namco_clock *= 2;
    }
    this.m_f_fracbits = clock_multiple + 15;
    this.m_sample_rate = this.m_namco_clock;
  }

  /** waveform_r, Packed == false @param {number} pos */
  waveform_r(pos) {
    return (PROM[pos & 0xff] & 0x0f) - 8;
  }

  /** waveform_position(int n) @param {number} n */
  waveform_position(n) {
    // n is passed as int: (int)counter >> fracbits is an arithmetic shift,
    // but & 0x1f keeps only bits fracbits .. fracbits+4, identical either way.
    return ((n | 0) >> this.m_f_fracbits) & 0x1f;
  }

  /** namco_update_one @returns {number} counter */
  namco_update_one(stream, output, select, volume, counter, freq) {
    select <<= 5;
    for (let sampindex = 0; sampindex < stream.length; sampindex++) {
      const waveform = this.waveform_r(select + this.waveform_position(counter));
      stream[sampindex] += (waveform * volume) / this.MIX_RES; // add_int
      counter = (counter + freq) >>> 0;
    }
    return counter;
  }

  /** sound_enable_w */
  sound_enable_w(state) { this.m_sound_enable = Boolean(state); }

  /** namco_15xx_w */
  namco_15xx_w(offset, data) {
    if (this.m_soundregs[offset] === data) return;
    this.m_soundregs[offset] = data;
    const ch = offset >> 3;
    if (ch >= this.MAX_VOICES) return;
    const voice = this.m_channel_list[ch];
    switch (offset & 7) {
      case 0x02: {
        // make_bitmask<uint32_t>(fracbits)
        const mask = (2 ** this.m_f_fracbits) - 1;
        voice.counter = (voice.counter & mask) >>> 0;
        voice.counter = (voice.counter | ((data & 0x1f) << this.m_f_fracbits)) >>> 0;
        break;
      }
      case 0x03:
        voice.volume[0] = data & 0x0f;
        break;
      case 0x06:
        voice.waveform_select = (data >> 4) & 7;
      // [[fallthrough]]
      case 0x04:
      case 0x05:
        voice.frequency = this.m_soundregs[ch * 8 + 0x04];
        voice.frequency += this.m_soundregs[ch * 8 + 0x05] << 8;
        voice.frequency += (this.m_soundregs[ch * 8 + 0x06] & 15) << 16;
        break;
      default:
        break;
    }
  }

  /** namco_15xx_r */
  namco_15xx_r(offset) { return this.m_soundregs[offset]; }

  /** sound_stream_update over a fresh buffer of n samples */
  sound_stream_update(n) {
    const stream = new Float64Array(n);
    if (!this.m_sound_enable) return stream;
    for (const voice of this.m_channel_list) {
      const v = voice.volume[0];
      if (v) {
        voice.counter = this.namco_update_one(stream, 0, voice.waveform_select, v,
          voice.counter, voice.frequency);
      }
    }
    return stream;
  }
}

/** Seeded PRNG (mulberry32). @param {number} seed */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a over 16-bit integer sample values.
 * @param {number} h running hash @param {number} v integer sample
 */
function fnv(h, v) {
  const x = v & 0xffff;
  h = Math.imul(h ^ (x & 0xff), 0x01000193) >>> 0;
  return Math.imul(h ^ (x >>> 8), 0x01000193) >>> 0;
}

/** A fixed register image: all 8 voices sounding, varied settings. */
function fixedImage() {
  const regs = new Uint8Array(0x40);
  for (let ch = 0; ch < 8; ch += 1) {
    const b = ch * 8;
    const freq = 0x00321 + ch * 0x02b7d + (ch & 1) * 0x10000;
    regs[b + 0] = 0xa5; regs[b + 1] = ch; // stored only
    regs[b + 3] = 0xf0 | (15 - ch * 2); // high nibble ignored
    regs[b + 4] = freq & 0xff;
    regs[b + 5] = (freq >> 8) & 0xff;
    regs[b + 6] = (ch << 4) | ((freq >> 16) & 0x0f) | 0x80; // bit 7 ignored
  }
  return regs;
}

/**
 * Golden FNV-1a checksums of the integer stream (sum of waveform * volume
 * per 192 kHz sample), as MameNamco15xx produces them. Both the reference
 * and the port must hit these, so a change to either shows up.
 */
const GOLDEN_FIXED = 0x8cbf29bf; // fixedImage(), 8 frames
const GOLDEN_SCRIPT = 0x801cd7c9; // the scripted writes, 40 frames

test('waveforms.js is generated from gp2-4.3f and up to date', () => {
  assert.equal(WAVEFORMS.length, 256);
  for (let i = 0; i < 256; i += 1) assert.equal(WAVEFORMS[i], PROM[i] & 0x0f);
  for (let v = 0; v < 16; v += 1) {
    for (let pos = 0; pos < 256; pos += 1) {
      // === on purpose: v = 0 gives -0 in the expression, +0 in the Int8Array.
      assert.ok(DECODED_WAVEFORMS[(v << 8) | pos] === ((PROM[pos] & 0x0f) - 8) * v);
    }
  }
  const file = readFileSync(join(ROOT, 'src/audio/waveforms.js'), 'utf8');
  assert.equal(file, renderWaveforms(PROM));
});

test('clock: 24 kHz doubled to 192 kHz, 18 fraction bits, 3168 per frame', () => {
  const mame = new MameNamco15xx(24576000 / 1024);
  assert.equal(WSG_CLOCK, 24000);
  assert.equal(WSG_RATE, mame.m_sample_rate);
  assert.equal(WSG_RATE, 192000);
  assert.equal(WSG_FRACBITS, mame.m_f_fracbits);
  assert.equal(WSG_FRACBITS, 18);
  assert.deepEqual(clockChanged(96000), { rate: 192000, fracbits: 16 });
  assert.equal(MIX_RES, 1024);
  assert.equal(SAMPLES_PER_FRAME, 3168);
  assert.equal(CYCLES_PER_SAMPLE, 8);
  assert.equal(SAMPLES_PER_FRAME * CYCLES_PER_SAMPLE, 25344);
  assert.ok(Math.abs(WSG_RATE / FRAME_RATE - SAMPLES_PER_FRAME) < 1e-9);
});

test('register decode matches namco_15xx_w for random write streams', () => {
  const r = rng(1);
  const mame = new MameNamco15xx(WSG_CLOCK);
  const wsg = new Wsg15xx();
  for (let i = 0; i < 50000; i += 1) {
    const off = Math.floor(r() * 0x40);
    const val = Math.floor(r() * 256);
    mame.namco_15xx_w(off, val);
    wsg.write(off, val);
    // Occasionally run a few samples so the +2 phase writes are visible.
    if (i % 97 === 0) { mame.sound_stream_update(13); wsg.render(new Float64Array(13), 0, 13); }
    assert.equal(wsg.read(off), mame.namco_15xx_r(off));
    const ch = off >> 3;
    const mv = mame.m_channel_list[ch];
    assert.equal(wsg.frequency[ch], mv.frequency);
    assert.equal(wsg.volume[ch], mv.volume[0]);
    assert.equal(wsg.waveform[ch], mv.waveform_select);
    assert.equal(wsg.counter[ch], mv.counter);
  }
});

test('register layout: volume +3, frequency +4/+5/+6 low nibble, wave +6', () => {
  const w = new Wsg15xx();
  w.write(0x2b, 0xf7); // voice 5 volume: low nibble only
  assert.equal(w.volume[5], 7);
  w.write(0x2c, 0x34); w.write(0x2d, 0x12); w.write(0x2e, 0xd9);
  assert.equal(w.frequency[5], 0x91234); // bits 16-19 from +6 low nibble
  assert.equal(w.waveform[5], 5); // (0xd9 >> 4) & 7
  assert.equal(w.read(0x2e), 0xd9); // read back as written
  // +2 sets the integer part of the counter and keeps the fraction.
  w.counter[1] = 0x0003ffff;
  w.write(0x0a, 0xff);
  assert.equal(w.counter[1], (0x1f << 18) | 0x3ffff);
  // A write of the unchanged value is a no-op (phase not reset).
  w.counter[1] = 0x12345;
  w.write(0x0a, 0xff);
  assert.equal(w.counter[1], 0x12345);
  // +0, +1 and +7 are stored only.
  const before = [...w.frequency, ...w.volume, ...w.waveform];
  w.write(0x10, 0x55); w.write(0x11, 0x66); w.write(0x17, 0x77);
  assert.deepEqual([...w.frequency, ...w.volume, ...w.waveform], before);
  assert.equal(w.read(0x17), 0x77);
});

test('frequency -> output period: square wave 2 at freq $1000 repeats every 2048', () => {
  const w = new Wsg15xx();
  w.writeImage(Object.assign(new Uint8Array(0x40), { 3: 15, 4: 0x00, 5: 0x10, 6: 0x20 }));
  const n = 2048 * 6;
  const out = new Float64Array(n);
  w.render(out, 0, n);
  // Tone = 4096 * 24000 / 2^20 = 93.75 Hz = 192000 / 2048.
  assert.equal(toneHz(0x1000), 93.75);
  for (let i = 0; i + 2048 < n; i += 1) assert.equal(out[i + 2048], out[i]);
  // Wave 2 of gp2-4.3f: 8 steps at 15 then 24 at 0 -> high 1/4 of the period.
  const hi = (15 - 8) * 15 / 1024;
  const lo = (0 - 8) * 15 / 1024;
  for (let i = 0; i < 2048; i += 1) assert.equal(out[i], i < 512 ? hi : lo, `sample ${i}`);
  // Rising edges: exactly one per period.
  let edges = 0;
  for (let i = 1; i < n; i += 1) if (out[i] > out[i - 1]) edges += 1;
  assert.equal(edges, 5);
});

test('silence when every volume is 0; counters hold', () => {
  const w = new Wsg15xx();
  const regs = fixedImage();
  for (let ch = 0; ch < 8; ch += 1) regs[ch * 8 + 3] = 0xf0; // volume nibble 0
  w.writeImage(regs);
  const out = new Float64Array(5000).fill(1);
  w.render(out, 0, 5000);
  assert.ok(out.every((x) => x === 0));
  assert.deepEqual([...w.counter], new Array(8).fill(0));
});

test('sound disabled (SRESET): silence and counters hold, then resume', () => {
  const mame = new MameNamco15xx(WSG_CLOCK);
  const w = new Wsg15xx();
  const regs = fixedImage();
  for (let i = 0; i < 0x40; i += 1) { mame.namco_15xx_w(i, regs[i]); w.write(i, regs[i]); }
  const a = new Float64Array(700);
  w.render(a, 0, 700);
  mame.sound_stream_update(700);
  const held = [...w.counter];
  w.setSoundEnable(false); mame.sound_enable_w(0);
  const b = new Float64Array(900).fill(1);
  w.render(b, 0, 900);
  assert.ok(b.every((x) => x === 0));
  assert.deepEqual([...w.counter], held);
  w.setSoundEnable(true); mame.sound_enable_w(1);
  const c = new Float64Array(500);
  w.render(c, 0, 500);
  assert.deepEqual([...c], [...mame.sound_stream_update(500)]);
});

/**
 * Checksum a render driven by `drive(chip, frame)` for `frames` frames,
 * against both implementations; returns both checksums.
 */
function checksums(frames, drive) {
  const mame = new MameNamco15xx(WSG_CLOCK);
  const w = new Wsg15xx();
  let hm = 0x811c9dc5;
  let hw = 0x811c9dc5;
  const sums = new Int32Array(SAMPLES_PER_FRAME);
  for (let f = 0; f < frames; f += 1) {
    // Each frame: a list of [pos, offset, data] or [pos, 'enable', v].
    const events = drive(f);
    let pos = 0;
    events.push([SAMPLES_PER_FRAME, null, 0]);
    for (const [at, off, data] of events) {
      const n = at - pos;
      if (n > 0) {
        const m = mame.sound_stream_update(n);
        for (let i = 0; i < n; i += 1) hm = fnv(hm, Math.round(m[i] * 1024));
        sums.fill(0, 0, n);
        w.renderSums(sums, 0, n);
        for (let i = 0; i < n; i += 1) hw = fnv(hw, sums[i]);
        pos = at;
      }
      if (off === 'enable') { mame.sound_enable_w(data); w.setSoundEnable(data); }
      else if (off !== null) { mame.namco_15xx_w(off, data); w.write(off, data); }
    }
  }
  return { mame: hm, port: hw };
}

test('golden checksum: fixed register image, 8 frames', () => {
  const regs = fixedImage();
  const { mame, port } = checksums(8, (f) => (f === 0 ? [...regs].map((d, i) => [0, i, d]) : []));
  assert.equal(port, mame);
  assert.equal(mame, GOLDEN_FIXED);
});

test('golden checksum: scripted writes incl. +2 phase sets and SRESET', () => {
  const r = rng(7);
  const { mame, port } = checksums(40, (f) => {
    const ev = [];
    // A burst at the top of the frame, like the IRQ handler's copy loop.
    for (let ch = 0; ch < 8; ch += 1) {
      for (const reg of [3, 4, 5, 6]) ev.push([Math.floor(ch * 4 + reg / 2), ch * 8 + reg, Math.floor(r() * 256)]);
    }
    // Mid-frame oddities.
    for (let k = 0; k < 3; k += 1) {
      ev.push([Math.floor(r() * SAMPLES_PER_FRAME), Math.floor(r() * 0x40), Math.floor(r() * 256)]);
    }
    if (f % 9 === 4) ev.push([Math.floor(r() * SAMPLES_PER_FRAME), 'enable', f % 18 === 4 ? 0 : 1]);
    ev.sort((a, b) => a[0] - b[0]);
    return ev;
  });
  assert.equal(port, mame);
  assert.equal(mame, GOLDEN_SCRIPT);
});

test('box resampler: constant in, constant out; mean of 4 at 48 kHz; mass kept', () => {
  const rs = new BoxResampler(192000, 48000);
  const got = [];
  for (let i = 0; i < 400; i += 1) {
    rs.push(i % 4 === 0 ? 1 : 0);
    while (rs.available > 0) got.push(rs.take());
  }
  assert.equal(got.length, 100);
  assert.ok(got.every((x) => Math.abs(x - 0.25) < 1e-12));
  const rs2 = new BoxResampler(192000, 44100);
  let inSum = 0;
  let outSum = 0;
  let outs = 0;
  const r = rng(4);
  for (let i = 0; i < 192000; i += 1) {
    const x = r() * 2 - 1;
    inSum += x;
    rs2.push(x);
    while (rs2.available > 0) { outSum += rs2.take(); outs += 1; }
  }
  assert.ok(Math.abs(outs - 44100) <= 1, `${outs} outputs`);
  assert.ok(Math.abs(outSum * (192000 / 44100) + rs2.acc - inSum) < 1e-6);
});

/** Mixer output samples per frame at 48 kHz (3168 / 4). */
const OUT = SAMPLES_PER_FRAME / 4;

/**
 * Reference for the mixer: the chip rendered in stream samples, events
 * applied at their positions, mean of 4 per output sample.
 */
function reference48k(frames) {
  const w = new Wsg15xx();
  const bang = new BangVoice(WSG_RATE);
  const out = [];
  for (const events of frames) {
    const stream = new Float64Array(SAMPLES_PER_FRAME);
    let e = 0;
    for (let p = 0; p < SAMPLES_PER_FRAME; p += 1) {
      while (e < events.length && (events[e] >>> 16) <= p) {
        const t = (events[e] >>> 8) & 0xff;
        const d = events[e] & 0xff;
        if (t < 0x40) w.write(t, d);
        else if (t === EV_ENABLE) w.setSoundEnable(d & 1);
        else if (t === EV_BANG) bang.trigger();
        e += 1;
      }
      const s = new Int32Array(1);
      w.renderSums(s, 0, 1);
      stream[p] = s[0] / MIX_RES + bang.next() * SAMPLES_GAIN;
    }
    for (let i = 0; i < OUT; i += 1) {
      out.push((stream[4 * i] + stream[4 * i + 1] + stream[4 * i + 2] + stream[4 * i + 3]) / 4);
    }
  }
  return out;
}

test('mixer: events land on their stream sample (image, SRESET, bang)', () => {
  const mx = new GaplusMixer(48000, { targetFrames: 1 });
  const regs = fixedImage();
  const f0 = imageEvents(regs);
  const f1 = Uint32Array.from([packEvent(1000, EV_ENABLE, 0), packEvent(2001, EV_ENABLE, 1),
    packEvent(2500, 0x03, 0)]);
  const f2 = Uint32Array.from([packEvent(123, EV_BANG, 0), packEvent(3000, 0x0b, 0)]);
  const frames = [f0, f1, f2];
  for (const events of frames) mx.push({ events });
  const out = new Float32Array(3 * OUT);
  mx.render(out, 0, 3 * OUT);
  const ref = reference48k(frames);
  for (let i = 0; i < ref.length; i += 1) assert.ok(Math.abs(out[i] - ref[i]) < 1e-6, `sample ${i}`);
  // SRESET window of frame 1 (stream 1000..2000 -> outputs 250..500): silent.
  assert.ok(out.subarray(OUT + 250, OUT + 500).every((x) => x === 0));
  assert.ok(out.subarray(OUT + 500, OUT + 600).some((x) => x !== 0));
  assert.equal(mx.stats.frames, 3);
});

test('mixer: late frames hold the registers; priming, trimming, pause', () => {
  const mx = new GaplusMixer(48000, { targetFrames: 1 });
  const events = imageEvents(fixedImage());
  mx.push({ events });
  const out = new Float32Array(3 * OUT);
  mx.render(out, 0, 3 * OUT);
  const ref = reference48k([events, new Uint32Array(0), new Uint32Array(0)]);
  for (let i = 0; i < ref.length; i += 1) assert.ok(Math.abs(out[i] - ref[i]) < 1e-6, `sample ${i}`);
  assert.ok(mx.stats.held >= 1);

  const m2 = new GaplusMixer(48000, { targetFrames: 2, maxFrames: 6 });
  const buf = new Float32Array(OUT);
  m2.push({ events });
  m2.render(buf, 0, OUT); // still priming: chip untouched, silent
  assert.ok(buf.every((x) => x === 0));
  for (let i = 0; i < 10; i += 1) m2.push({ events: new Uint32Array(0) });
  assert.ok(m2.queue.length <= 6);
  assert.ok(m2.stats.dropped > 0);
  // The dropped first frame's registers were still applied.
  assert.equal(m2.wsg.volume[0], 15);
  m2.setPaused(true);
  buf.fill(1);
  m2.render(buf, 0, OUT);
  assert.ok(buf.every((x) => x === 0));
  assert.equal(m2.queue.length, 0);
  m2.setPaused(false);
  assert.equal(m2.priming, true);
});

test('bang: deterministic noise burst, fast attack, exponential decay', () => {
  const a = synthesizeBang(WSG_RATE);
  const b = synthesizeBang(WSG_RATE);
  assert.deepEqual(a, b);
  assert.equal(a.length, BANG_SECONDS * WSG_RATE);
  let peak = 0;
  let peakAt = 0;
  for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i]) > peak) { peak = Math.abs(a[i]); peakAt = i; }
  assert.ok(Math.abs(peak - BANG_PEAK) < 1e-6);
  assert.ok(peakAt < 0.1 * WSG_RATE, `peak at ${peakAt}`);
  assert.ok(a[0] === 0); // attack starts from silence (no click)
  assert.ok(a[a.length - 1] === 0); // and fades out to silence
  const rms = (from, to) => {
    let s = 0;
    for (let i = from; i < to; i += 1) s += a[i] * a[i];
    return Math.sqrt(s / (to - from));
  };
  const tenth = WSG_RATE / 10;
  const early = rms(0, tenth);
  const mid = rms(4 * tenth, 5 * tenth);
  const late = rms(8 * tenth, 9 * tenth);
  // Monotonic decay: > 10 dB per 400 ms, and the tail is > 30 dB down.
  assert.ok(early > 3 * mid && mid > 3 * late, `${early} ${mid} ${late}`);
  assert.ok(20 * Math.log10(early / late) > 30);
  // It is noise, not a tone: plenty of sign changes, not periodic.
  let zc = 0;
  for (let i = 1; i < tenth; i += 1) if ((a[i] < 0) !== (a[i - 1] < 0)) zc += 1;
  assert.ok(zc > 50, `${zc} zero crossings`);
  // Playback: idle -> trigger -> plays once; a retrigger restarts it.
  const v = new BangVoice(WSG_RATE);
  assert.equal(v.playing, false);
  assert.equal(v.next(), 0);
  v.trigger();
  for (let i = 0; i < 1000; i += 1) assert.equal(v.next(), a[i]);
  v.trigger();
  assert.equal(v.next(), a[0]);
  assert.equal(v.next(), a[1]);
  v.pos = a.length - 1;
  v.next();
  assert.equal(v.playing, false);
  assert.equal(v.next(), 0);
});

test('SoundEngine: timed events, image mode, 62XX bang hook, pause', () => {
  const engine = new SoundEngine();
  /** @type {{type: string, events?: Uint32Array, on?: boolean}[]} */
  const posted = [];
  // Stand-in for the AudioWorkletNode; the engine only uses port.postMessage.
  engine.node = /** @type {AudioWorkletNode} */ (/** @type {unknown} */ ({
    port: { postMessage: (msg) => posted.push(msg) },
  }));
  engine.ready = true;
  assert.equal(cycleToPos(0), 0);
  assert.equal(cycleToPos(25343), 3167);
  assert.equal(cycleToPos(99999), 3167);
  // Frame 1: first post carries a sync of the (zero) state first.
  engine.write15xx(0x03, 0x0f, 800);
  engine.write62xx(0x09, 0x0e, 900); // < $0F: no bang
  engine.write62xx(0x08, 0x0f, 900); // wrong offset: no bang
  engine.write62xx(0x09, 0x0f, 16);
  engine.setSoundEnable(false, 24000);
  engine.update();
  let ev = /** @type {Uint32Array} */ (posted[0].events);
  assert.equal(ev.length, 1 + 64 + 3);
  assert.equal(ev[0], packEvent(0, EV_ENABLE, 1));
  const tail = [...ev.slice(65)];
  assert.deepEqual(tail, [packEvent(2, EV_BANG, 0), packEvent(100, 0x03, 0x0f),
    packEvent(3000, EV_ENABLE, 0)]);
  // Frame 2, image mode: 64 writes at sample 0 and nothing else.
  const regs = fixedImage();
  engine.update(regs);
  ev = /** @type {Uint32Array} */ (posted[1].events);
  assert.deepEqual([...ev], [...imageEvents(regs)]);
  // Pause: a pause message, no frames; resume resyncs from frame start.
  engine.setPaused(true);
  engine.update(regs);
  assert.equal(posted.length, 3);
  assert.equal(posted[2].type, 'pause');
  engine.setPaused(false);
  engine.update(regs);
  ev = /** @type {Uint32Array} */ (posted[4].events);
  assert.equal(ev[0], packEvent(0, EV_ENABLE, 0));
  assert.deepEqual([...ev.slice(1, 65)], [...imageEvents(regs)]);
  // Mute toggle.
  assert.equal(engine.muted, false);
  assert.equal(engine.toggle(), false);
  assert.equal(engine.muted, true);
});

test('wsg-worklet.js registers a processor that renders frames', async () => {
  /** @type {Record<string, unknown>} */
  const g = globalThis;
  let Proc = null;
  // The AudioWorkletGlobalScope names the module relies on.
  g.sampleRate = 48000;
  g.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null }; } };
  g.registerProcessor = (name, ctor) => { assert.equal(name, 'gaplus-sound'); Proc = ctor; };
  try {
    await import('../../src/audio/wsg-worklet.js');
    assert.ok(Proc !== null);
    const p = new Proc();
    const events = imageEvents(fixedImage());
    for (let i = 0; i < 3; i += 1) p.port.onmessage({ data: { type: 'frame', events } });
    p.port.onmessage({ data: { type: 'bang' } });
    assert.equal(p.mixer.bang.playing, true);
    const outputs = [[new Float32Array(128), new Float32Array(128)]];
    let heard = false;
    for (let i = 0; i < 20; i += 1) {
      assert.equal(p.process([], outputs), true);
      assert.deepEqual(outputs[0][1], outputs[0][0]);
      heard ||= outputs[0][0].some((x) => x !== 0);
    }
    assert.ok(heard);
  } finally {
    delete g.sampleRate;
    delete g.AudioWorkletProcessor;
    delete g.registerProcessor;
  }
});

test('VOICES is 8 and the chip starts enabled and silent', () => {
  assert.equal(VOICES, 8);
  const w = new Wsg15xx();
  assert.equal(w.soundEnable, true);
  const out = new Float64Array(100).fill(1);
  w.render(out, 0, 100);
  assert.ok(out.every((x) => x === 0));
});

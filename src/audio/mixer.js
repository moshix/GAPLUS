// Copyright 2026 by Moshix
/**
 * The Gaplus sound board as one sample stream: the 15XX WSG plus the
 * "bang" sample channel, driven by per-frame lists of timed events and
 * rendered at the device rate. Pure JavaScript with no WebAudio
 * dependency, so it runs inside the AudioWorklet (src/audio/wsg-worklet.js),
 * in the main-thread fallback, and in node tests alike.
 *
 * TIMELINE. Everything runs on the 15XX's 192 kHz stream clock, 3168
 * samples per video frame (8 CPU cycles per sample). A frame message
 * carries the frame's events, each stamped with the stream sample it lands
 * on; the mixer renders up to that sample, applies the event, and goes on
 * -- exactly what MAME's m_stream->update() before every register write
 * achieves. Event kinds (packEvent):
 *
 *   target $00-$3F   a 15XX register write (namco_15xx_w, incl. the +2
 *                    phase-set event and the same-value no-op)
 *   EV_ENABLE ($40)  sound_enable_w(data & 1) (SRESET latch)
 *   EV_BANG   ($41)  samples->start(0, 0): (re)start the bang
 *
 * GRANULARITY. The Gaplus sound CPU writes the 15XX only at the top of its
 * once-per-frame IRQ handler ($E05B-$E06F copies the staging buffer $0080-
 * $009F to registers +3..+6 of voices 0..7, 32 writes in ascending order,
 * within ~250 cycles = ~31 stream samples of the vblank IRQ), and a
 * static scan of gp2-1.4b finds no other 15XX writes except the boot-time
 * clear (and no +2 writes at all). So a frame's register image applied as
 * a burst at sample 0 (imageEvents) is exact up to that ~31-sample offset;
 * a host with per-write cycle stamps can send exact positions instead.
 *
 * JITTER. Frames arrive from the game loop, whose timing wobbles against
 * the audio clock. The mixer keeps a short queue: it starts playing once
 * `targetFrames` are queued; if a frame is late it keeps playing with the
 * registers held (the chip really would hold them, so tones continue with
 * no click); if the queue grows past `maxFrames` it drops the oldest
 * frames' time (their events are still applied, phases stay continuous)
 * until it is back at the target.
 */

import { Wsg15xx, WSG_RATE, WSG_GAIN, MIX_RES, SAMPLES_PER_FRAME, REG_COUNT } from './wsg15xx.js';
import { BoxResampler } from './resample.js';
import { BangVoice, SAMPLES_GAIN } from './bang.js';

/** Event targets beyond the 64 registers. */
export const EV_ENABLE = 0x40;
export const EV_BANG = 0x41;

/** Stream samples rendered per block: keeps the resampler ring (64) safe. */
const BLOCK = 32;

/**
 * Pack one event: (sample position in frame << 16) | (target << 8) | data.
 * @param {number} pos 0 .. SAMPLES_PER_FRAME-1
 * @param {number} target register offset, EV_ENABLE or EV_BANG
 * @param {number} data byte
 * @returns {number}
 */
export const packEvent = (pos, target, data) =>
  (((pos & 0xffff) << 16) | ((target & 0xff) << 8) | (data & 0xff)) >>> 0;

/**
 * A register image as one frame's events: a burst of 64 writes at sample
 * `pos`, offsets ascending (unchanged bytes are no-ops in the chip).
 * @param {ArrayLike<number>} regs 64 register bytes ($6000-$603F)
 * @param {number} [pos]
 * @returns {Uint32Array}
 */
export function imageEvents(regs, pos = 0) {
  const ev = new Uint32Array(REG_COUNT);
  for (let i = 0; i < REG_COUNT; i += 1) ev[i] = packEvent(pos, i, regs[i]);
  return ev;
}

/**
 * One frame of sound-board input, events sorted by position.
 * @typedef {object} SoundFrame
 * @property {Uint32Array} events packEvent values
 */

/** A frame with nothing happening (the late-frame hold). */
const EMPTY = new Uint32Array(0);

export class GaplusMixer {
  /**
   * @param {number} outRate device sample rate
   * @param {{ targetFrames?: number, maxFrames?: number, gain?: number }} [options]
   */
  constructor(outRate, options = {}) {
    this.outRate = outRate;
    this.targetFrames = options.targetFrames ?? 2;
    this.maxFrames = options.maxFrames ?? 6;
    this.gain = options.gain ?? 1;
    this.resampler = new BoxResampler(WSG_RATE, outRate);
    this.wsg = new Wsg15xx();
    this.bang = new BangVoice(WSG_RATE);
    this.sums = new Int32Array(BLOCK);
    /** @type {SoundFrame[]} */
    this.queue = [];
    /** Events of the frame being played, the next one to apply. */
    this.events = EMPTY;
    this.ev = 0;
    /** Stream position inside the frame; SAMPLES_PER_FRAME = need next. */
    this.pos = SAMPLES_PER_FRAME;
    this.priming = true;
    this.paused = false;
    this.stats = { frames: 0, held: 0, dropped: 0 };
  }

  /** @param {SoundFrame} frame */
  push(frame) {
    if (this.paused) return;
    this.queue.push(frame);
    if (this.queue.length > this.maxFrames) {
      // Running behind: skip audio time, keeping the state the skipped
      // frames leave behind (registers, enable, a restarted bang).
      while (this.queue.length > this.targetFrames) {
        const f = /** @type {SoundFrame} */ (this.queue.shift());
        for (let i = 0; i < f.events.length; i += 1) this.apply(f.events[i]);
        this.stats.dropped += 1;
      }
    }
    if (this.priming && this.queue.length >= this.targetFrames) this.priming = false;
  }

  /** Start the bang now (outside the frame timeline). */
  triggerBang() {
    this.bang.trigger();
  }

  /**
   * Silence and forget queued input (the game is paused); on resume the
   * queue refills to the target before sound starts again. Register and
   * enable events not yet played are applied, so the chip state stays
   * that of the last frame received.
   * @param {boolean} on
   */
  setPaused(on) {
    this.paused = on;
    if (!on) return;
    for (; this.ev < this.events.length; this.ev += 1) {
      const e = this.events[this.ev];
      if (((e >>> 8) & 0xff) !== EV_BANG) this.apply(e);
    }
    for (const f of this.queue) {
      for (const e of f.events) if (((e >>> 8) & 0xff) !== EV_BANG) this.apply(e);
    }
    this.queue.length = 0;
    this.events = EMPTY;
    this.ev = 0;
    this.pos = SAMPLES_PER_FRAME;
    this.priming = true;
  }

  /** @param {number} e packed event */
  apply(e) {
    const target = (e >>> 8) & 0xff;
    const data = e & 0xff;
    if (target < REG_COUNT) this.wsg.write(target, data);
    else if (target === EV_ENABLE) this.wsg.setSoundEnable(data & 1);
    else if (target === EV_BANG) this.bang.trigger();
  }

  /** Start the next frame, or hold the registers if none is due. */
  nextFrame() {
    // Events stamped past the frame end still happen, at its end.
    for (; this.ev < this.events.length; this.ev += 1) this.apply(this.events[this.ev]);
    const f = this.priming ? undefined : this.queue.shift();
    if (f === undefined) {
      if (!this.priming) this.stats.held += 1;
      this.events = EMPTY;
      if (!this.priming && this.queue.length === 0) this.priming = true;
    } else {
      this.events = f.events;
      this.stats.frames += 1;
    }
    this.pos = 0;
    this.ev = 0;
  }

  /**
   * Fill `count` device samples.
   * @param {Float32Array} out @param {number} offset @param {number} count
   */
  render(out, offset, count) {
    if (this.paused) { out.fill(0, offset, offset + count); return; }
    const rs = this.resampler;
    const sums = this.sums;
    let n = 0;
    while (n < count) {
      if (rs.available > 0) { out[offset + n] = rs.take() * this.gain; n += 1; continue; }
      if (this.pos >= SAMPLES_PER_FRAME) this.nextFrame();
      // Apply the events due at this stream sample.
      const ev = this.events;
      while (this.ev < ev.length && (ev[this.ev] >>> 16) <= this.pos) {
        this.apply(ev[this.ev]);
        this.ev += 1;
      }
      // Render up to the next event, the frame end, or one block.
      let len = Math.min(BLOCK, SAMPLES_PER_FRAME - this.pos);
      if (this.ev < ev.length) len = Math.min(len, (ev[this.ev] >>> 16) - this.pos);
      sums.fill(0, 0, len);
      this.wsg.renderSums(sums, 0, len);
      for (let i = 0; i < len; i += 1) {
        rs.push((sums[i] / MIX_RES) * WSG_GAIN + this.bang.next() * SAMPLES_GAIN);
      }
      this.pos += len;
    }
  }
}

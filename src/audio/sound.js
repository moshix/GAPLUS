// Copyright 2026 by Moshix
/**
 * WebAudio output of the Gaplus sound board.
 *
 * The ported sound CPU (gp2-1.4b) writes the Namco 15XX registers exactly
 * as the ROM does, once per frame; the main CPU switches the chip on and
 * off with the SRESET latch and fires the explosion through the 62XX.
 * This module only has to turn that into samples: it collects the frame's
 * events, stamped with the stream sample they land on, and sends them to
 * an AudioWorklet (src/audio/wsg-worklet.js) running GaplusMixer
 * (src/audio/mixer.js), which renders the 15XX (src/audio/wsg15xx.js) and
 * the bang (src/audio/bang.js) on the 192 kHz stream clock and resamples
 * to the device rate.
 *
 * HOST CONTRACT. `cycle` is the CPU cycle (1.536 MHz) inside the current
 * frame, 0 = the vblank IRQ; it is optional and defaults to 0.
 *
 *   engine.write15xx(offset, data, cycle)   a CPU write to $6000-$603F
 *                                           (sound $0000-$003F); or, at
 *                                           frame granularity, pass the
 *                                           register image to update()
 *   engine.setSoundEnable(on, cycle)        sreset_w: $8000 on, $8800 off
 *   engine.write62xx(offset, data, cycle)   a write to $6820-$682F (the
 *                                           bang fires on $6829 >= $0F)
 *   engine.triggerBang(cycle)               the bang itself
 *   engine.update(regs?)                    once per emulated frame, after
 *                                           it ran; `regs` = the 64 bytes
 *                                           at $6000-$603F when writes are
 *                                           not reported one by one
 *
 * plus start() from a user gesture, setPaused() when the simulation
 * freezes, and toggle() for mute.
 *
 * Without AudioWorklet support the same mixer runs on the main thread and
 * each frame's audio is scheduled as an AudioBufferSourceNode (higher
 * latency, can gap if a frame is very late).
 */

import { GaplusMixer, packEvent, imageEvents, EV_ENABLE, EV_BANG } from './mixer.js';
import { FRAME_RATE, SAMPLES_PER_FRAME, CYCLES_PER_SAMPLE, REG_COUNT } from './wsg15xx.js';

/** Overall output level. The mixer already applies MAME's route gains. */
const MASTER_LEVEL = 1.0;
/** Mute/pause ramp time constant, seconds (long enough not to click). */
const RAMP = 0.01;

/**
 * The stream sample a CPU cycle inside the frame falls on.
 * @param {number} cycle @returns {number}
 */
export function cycleToPos(cycle) {
  const pos = Math.floor(cycle / CYCLES_PER_SAMPLE);
  return Math.min(SAMPLES_PER_FRAME - 1, Math.max(0, pos));
}

export class SoundEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {GainNode|null} */
    this.master = null;
    /** @type {AudioWorkletNode|null} */
    this.node = null;
    /** Main-thread mixer when there is no AudioWorklet. @type {GaplusMixer|null} */
    this.fallback = null;
    this.nextTime = 0;
    this.carry = 0;
    /** @type {Promise<void>|null} */
    this.starting = null;
    this.ready = false;
    /** Player's sound on/off. */
    this.enabled = true;
    /** Simulation frozen. */
    this.paused = false;
    /** Events of the frame in progress (packEvent values). @type {number[]} */
    this.events = [];
    /** Shadow of the chip: registers and enable now, and at frame start. */
    this.regs = new Uint8Array(REG_COUNT);
    this.soundEnable = true;
    this.baseRegs = new Uint8Array(REG_COUNT);
    this.baseEnable = true;
    /** The mixer missed frames (not started, paused): resend the state. */
    this.needSync = true;
    /**
     * What the page has handed the mixer (diagnostics): frames sent, and
     * frames whose register image had a voice with non-zero volume.
     */
    this.sent = { frames: 0, audible: 0 };
    /** Pending stats() replies from the worklet. @type {Array<(s: object) => void>} */
    this.statsWaiters = [];
  }

  /**
   * Output statistics from the worklet ({samples, nonZero, peak, frames}),
   * plus what was sent; null without a worklet. Diagnostics only.
   * @returns {Promise<{samples: number, nonZero: number, peak: number,
   *   frames: number} | null>}
   */
  stats() {
    const node = this.node;
    if (node === null) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.statsWaiters.push(/** @type {(s: object) => void} */ (resolve));
      node.port.postMessage({ type: 'stats' });
    });
  }

  /**
   * Build the audio graph. Call from a user gesture (browsers refuse to
   * start audio otherwise); later calls just resume a suspended context.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.starting === null) this.starting = this.init();
    await this.starting;
    if (this.ctx !== null && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** @returns {Promise<void>} */
  async init() {
    const Ctor = globalThis.AudioContext ?? /** @type {typeof AudioContext|undefined} */ (
      /** @type {Record<string, unknown>} */ (globalThis).webkitAudioContext);
    if (Ctor === undefined) return;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;
    // Resume inside the gesture, before the first await, for Safari.
    void ctx.resume();
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    if (ctx.audioWorklet !== undefined && globalThis.AudioWorkletNode !== undefined) {
      try {
        // Carry this module's cache-busting query (index.html) to the
        // worklet entry point. Its own imports cannot carry it (import maps
        // do not apply in worklets); tools/serve.py disables caching.
        const self = new URL(import.meta.url);
        await ctx.audioWorklet.addModule(new URL(`./wsg-worklet.js${self.search}`, self));
        this.node = new AudioWorkletNode(ctx, 'gaplus-sound', {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        });
        this.node.connect(this.master);
        this.node.port.onmessage = (e) => {
          if (e.data?.type === 'stats') this.statsWaiters.shift()?.(e.data);
        };
      } catch {
        this.node = null;
      }
    }
    if (this.node === null) {
      this.fallback = new GaplusMixer(ctx.sampleRate);
      this.nextTime = 0;
    }
    this.ready = true;
    this.needSync = true;
    this.sendPause();
    this.applyGain();
  }

  /**
   * Freeze or resume with the simulation. Paused, the mixer drops its
   * queue and outputs silence; resuming re-primes it.
   * @param {boolean} on
   */
  setPaused(on) {
    this.paused = on;
    if (!on) this.needSync = true;
    this.sendPause();
    this.applyGain();
  }

  /** Mute / unmute. @returns {boolean} true if sound is now on */
  toggle() {
    this.enabled = !this.enabled;
    this.applyGain();
    return this.enabled;
  }

  /** @returns {boolean} true while the player has sound switched off */
  get muted() { return !this.enabled; }

  /**
   * A CPU write to a 15XX register.
   * @param {number} offset 0-$3F @param {number} data
   * @param {number} [cycle] CPU cycle inside the frame
   */
  write15xx(offset, data, cycle = 0) {
    offset &= REG_COUNT - 1;
    this.regs[offset] = data & 0xff;
    this.events.push(packEvent(cycleToPos(cycle), offset, data));
  }

  /**
   * sreset_w: the 15XX sounds only while the sub CPUs run.
   * @param {boolean|number} on @param {number} [cycle]
   */
  setSoundEnable(on, cycle = 0) {
    this.soundEnable = Boolean(on);
    this.events.push(packEvent(cycleToPos(cycle), EV_ENABLE, on ? 1 : 0));
  }

  /**
   * gaplus_base_state::customio_3_w: offset 9 with data >= $0F starts
   * the bang.
   * @param {number} offset $6820-$682F & $0F @param {number} data
   * @param {number} [cycle]
   */
  write62xx(offset, data, cycle = 0) {
    if ((offset & 0x0f) === 0x09 && (data & 0xff) >= 0x0f) this.triggerBang(cycle);
  }

  /**
   * Play the explosion (samples->start(0, 0)); restarts it if playing.
   * @param {number} [cycle] CPU cycle inside the frame
   */
  triggerBang(cycle = 0) {
    this.events.push(packEvent(cycleToPos(cycle), EV_BANG, 0));
  }

  /**
   * Once per emulated frame, after the frame ran: hand the frame's events
   * to the mixer.
   * @param {ArrayLike<number>} [regs] the 64 register bytes at the end of
   *   the frame, if writes were not reported with write15xx(): applied as
   *   a write burst at the frame's first sample, where the sound CPU's IRQ
   *   handler makes its writes.
   */
  update(regs) {
    /** @type {number[]} */
    let list = [];
    if (this.needSync) {
      // The mixer's chip missed some frames: restore the frame-start state.
      list.push(packEvent(0, EV_ENABLE, this.baseEnable ? 1 : 0));
      for (const e of imageEvents(this.baseRegs)) list.push(e);
    }
    if (regs !== undefined) {
      if (this.ready && !this.paused) {
        this.sent.frames += 1;
        // Volume is the low nibble of each voice's byte +3.
        for (let v = 3; v < REG_COUNT; v += 8) {
          if ((regs[v] & 0x0f) !== 0) { this.sent.audible += 1; break; }
        }
      }
      for (const e of imageEvents(regs)) list.push(e);
      for (let i = 0; i < REG_COUNT; i += 1) this.regs[i] = regs[i] & 0xff;
    }
    list = list.concat(this.events);
    this.events = [];
    // Stable sort by position: same-sample events keep their order.
    list.sort((x, y) => (x >>> 16) - (y >>> 16));
    this.baseRegs.set(this.regs);
    this.baseEnable = this.soundEnable;
    if (!this.ready || this.paused) { this.needSync = true; return; }
    this.needSync = false;
    const events = Uint32Array.from(list);
    if (this.node !== null) {
      this.node.port.postMessage({ type: 'frame', events }, [events.buffer]);
    } else if (this.fallback !== null) {
      this.fallback.push({ events });
      this.playFallback();
    }
  }

  /** Render one frame on the main thread and queue it (no AudioWorklet). */
  playFallback() {
    const ctx = /** @type {AudioContext} */ (this.ctx);
    const mixer = /** @type {GaplusMixer} */ (this.fallback);
    const exact = ctx.sampleRate / FRAME_RATE + this.carry;
    const count = Math.floor(exact);
    this.carry = exact - count;
    const buf = ctx.createBuffer(1, count, ctx.sampleRate);
    mixer.render(buf.getChannelData(0), 0, count);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(/** @type {GainNode} */ (this.master));
    // Keep ~50 ms ahead; if we fell behind, restart the schedule there.
    const now = ctx.currentTime;
    if (this.nextTime < now + 0.01 || this.nextTime > now + 0.2) this.nextTime = now + 0.05;
    src.start(this.nextTime);
    this.nextTime += count / ctx.sampleRate;
  }

  /** Tell the mixer about pause. */
  sendPause() {
    if (this.node !== null) this.node.port.postMessage({ type: 'pause', on: this.paused });
    if (this.fallback !== null) this.fallback.setPaused(this.paused);
  }

  /** Master gain from the mute and pause states, ramped. */
  applyGain() {
    if (this.master === null || this.ctx === null) return;
    const target = this.enabled && !this.paused ? MASTER_LEVEL : 0;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, RAMP);
  }
}

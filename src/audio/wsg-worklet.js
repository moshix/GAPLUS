// Copyright 2026 by Moshix
/**
 * AudioWorklet processor for the Gaplus sound board. Loaded by
 * src/audio/sound.js with audioWorklet.addModule(); runs GaplusMixer on the
 * audio thread and takes its input as messages from the page:
 *
 *   { type: 'frame', events }   one video frame (see mixer.js SoundFrame)
 *   { type: 'pause', on }       stop / resume (resume re-primes the queue)
 *   { type: 'bang' }            start the bang now (outside any frame)
 *   { type: 'stats' }           reply { type: 'stats', samples, nonZero,
 *                               peak, frames }: what it has output so far
 *                               (diagnostics: the smoke test uses it to
 *                               prove the game is actually audible)
 *
 * Output is mono; any further output channels get the same signal.
 */

import { GaplusMixer } from './mixer.js';

/* global AudioWorkletProcessor, registerProcessor, sampleRate */

class GaplusSoundProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mixer = new GaplusMixer(sampleRate);
    /** Output so far: samples, non-zero samples, peak |sample|, frames. */
    this.stats = { samples: 0, nonZero: 0, peak: 0, frames: 0 };
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'frame') {
        this.stats.frames += 1;
        this.mixer.push({ events: msg.events });
      } else if (msg.type === 'stats') {
        if (typeof this.port.postMessage === 'function') {
          this.port.postMessage({ type: 'stats', ...this.stats });
        }
      } else if (msg.type === 'pause') this.mixer.setPaused(Boolean(msg.on));
      else if (msg.type === 'bang') this.mixer.triggerBang();
    };
  }

  /**
   * @param {Float32Array[][]} _inputs
   * @param {Float32Array[][]} outputs
   * @returns {boolean}
   */
  process(_inputs, outputs) {
    const out = outputs[0];
    if (out === undefined || out.length === 0) return true;
    const first = out[0];
    this.mixer.render(first, 0, first.length);
    // Cheap running statistics (one pass over 128 samples per block).
    const st = this.stats;
    st.samples += first.length;
    for (let i = 0; i < first.length; i += 1) {
      const a = Math.abs(first[i]);
      if (a > 1e-6) st.nonZero += 1;
      if (a > st.peak) st.peak = a;
    }
    for (let c = 1; c < out.length; c += 1) out[c].set(first);
    return true;
  }
}

registerProcessor('gaplus-sound', GaplusSoundProcessor);

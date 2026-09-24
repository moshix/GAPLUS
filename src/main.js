// Copyright 2026 by Moshix
/**
 * Bootstrap: owns the canvas, the frame clock and input routing.
 *
 * The clock is deliberately not "one frame per requestAnimationFrame". The
 * original runs at 60.606 Hz (6.144 MHz pixel clock / (384 * 264)), which no
 * display matches exactly, so we accumulate real elapsed time and run however
 * many whole game frames are due. The game therefore always advances in
 * discrete 1/60.606 s steps -- the same steps the 6809 oracle takes --
 * regardless of what the monitor is doing.
 *
 * What runs is an *engine* (src/engine.js): "ROM", the original program on
 * the test oracle's emulated 6809s, or "JavaScript", the port. The start
 * screen (src/ui/chooser.js) asks which on every fresh load, preselecting
 * the last choice (localStorage); E or the settings bar switches later.
 * The page keeps the input state, the renderer and the sound engine; an
 * engine only runs frames and exposes its memory.
 *
 * The self-playing AI (A) exists only for the JavaScript engine: it reads
 * the port's state, never the ROM's. In ROM mode its control is disabled.
 *
 * URL helpers (for headless tests and poking around):
 *   ?engine=rom|port  skip the chooser
 *   ?frames=N         run N frames as fast as possible, show the last,
 *                     stop (skips the chooser too: last or default choice)
 *   &coin=F&start=G   with ?frames: tap coin at frame F, start at frame G
 *   ?zoom=Z           initial zoom 1-6
 * `globalThis.gaplus` exposes the game object in the console.
 *
 * FAILURES. Each stage of a frame (the AI, the engine, the renderer, the
 * sound hand-off) is guarded. A failing AI is switched off with a note and
 * the game carries on; any other failure stops the simulation with the
 * reason in the #status overlay, silences the sound (enable off, a zero
 * register image, mixer paused -- or the mixer would hold the last
 * registers and a tone would play forever) and logs the error with its
 * frame number. The frame clock itself always re-queues, so the page
 * never dies silently. `gaplus.testFault(stage)` injects a failure (for
 * the browser smoke test).
 */

import { FRAME_RATE } from './machine/machine.js';
import { createInputState } from './machine/namcoio.js';
import { Renderer, SCREEN_WIDTH, SCREEN_HEIGHT } from './video/renderer.js';
import { SoundEngine } from './audio/sound.js';
import { InputMux } from './input/mux.js';
import { GamepadInput } from './input/gamepad.js';
import { MACHINE_INPUT } from './input/bindings.js';
import { RemapUI } from './input/remapui.js';
import { setSwitch, releaseAll, testSwitch, setTestSwitch } from './input/switches.js';
import {
  createEngine, engineKindFrom, loadEngineChoice, saveEngineChoice,
} from './engine.js';
import { EngineChooser } from './ui/chooser.js';
import { aiAllowed, autoplayInputs, createPageAutoplayer } from './ai/hook.js';
import { REG_COUNT } from './audio/wsg15xx.js';

/**
 * Displayed in the corner of the page and the single place this is written
 * down. Bump it here when a feature lands, and keep `package.json` in step.
 */
export const VERSION = '0.2';

const FRAME_MS = 1000 / FRAME_RATE;
/** Never try to catch up more than this after a tab has been backgrounded. */
const MAX_CATCHUP_FRAMES = 4;
/** Frames run per macrotask by ?frames=N, so the page stays responsive. */
const FAST_CHUNK = 20;

/** Settings-bar names of the engines. */
const ENGINE_NAMES = Object.freeze({ rom: 'ROM', port: 'JavaScript' });

/** Tooltip of the AI control while the ROM engine runs. */
const AI_ROM_NOTE = 'JavaScript version only';

/** `localStorage`, or null where it is unavailable. @returns {Storage | null} */
function storage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * Reflect a toggle's state on its settings button.
 * @param {string} id @param {boolean} on
 */
function setPressed(id, on) {
  const el = document.getElementById(id);
  if (el !== null) el.setAttribute('aria-pressed', String(on));
}

/**
 * Keyboard to switch mapping. Gaplus has an 8-way stick, so all four arrows
 * move the ship. @see reference/mame/namco/gaplus.cpp INPUT_PORTS(gapluso)
 */
const KEY_MAP = /** @type {const} */ ({
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Space: 'fire1',
  Digit5: 'coin1',
  Digit6: 'coin2',
  Digit1: 'start1',
  Digit2: 'start2',
});

export class Game {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx === null) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;

    this.renderer = new Renderer();
    // The renderer draws into a Uint32Array; wrap the same buffer in the
    // Uint8ClampedArray that ImageData wants, so presenting copies nothing.
    this.frame = new ImageData(
      new Uint8ClampedArray(this.renderer.pixels.buffer), SCREEN_WIDTH, SCREEN_HEIGHT,
    );
    this.sound = new SoundEngine();
    /** The outside world: sticks, buttons, coin slots, DIPs. */
    this.inputs = createInputState();
    /** @type {Awaited<ReturnType<typeof createEngine>> | null} */
    this.engine = null;
    /** Last 15XX enable seen, to report changes to the sound engine. */
    this.soundOn = false;

    /** Whole game frames elapsed since boot. */
    this.frameCount = 0;
    /** Leftover real time not yet converted into game frames, in ms. */
    this.accumulator = 0;
    /** @type {number | null} */
    this.lastTime = null;
    this.running = false;
    /** Frozen by the player, with P or the pad. Survives a tab switch. */
    this.paused = false;
    /** Frozen because the tab is not visible; kept apart from `paused`. */
    this.hidden = false;
    /** Frozen while the engine chooser is open over a running game. */
    this.choosing = false;
    /** The self-playing AI is on (JavaScript engine only). */
    this.aiEnabled = false;
    /**
     * The AI playing the current engine, while it is on (src/ai/hook.js).
     * @type {import('./ai/autoplay.js').AutoPlayer | null}
     */
    this.ai = null;
    /** The AI's own switches; the engine runs on these while it plays. */
    this.aiInputs = createInputState();
    /** Why the simulation stopped on an error, or '' while it runs. */
    this.failure = '';
    /** Last seen state of the pad's pause control, for edge detection. */
    this.padPauseHeld = false;
    this.zoom = 2;

    /**
     * Keyboard and gamepad both close the same switches, so they go through a
     * mux rather than writing the input state directly. @see src/input/mux.js
     */
    this.mux = new InputMux((name, down) => setSwitch(this.inputs, name, down));
    this.gamepad = new GamepadInput();
    /** @type {RemapUI | null} */
    this.remap = null;
    /** @type {EngineChooser | null} */
    this.chooser = null;
  }

  /**
   * Adopt an engine: wire its explosion to the sound engine and say on the
   * page what is running. A new engine starts from power-on, so the frame
   * count restarts too.
   * @param {Awaited<ReturnType<typeof createEngine>>} engine
   */
  setEngine(engine) {
    this.engine = engine;
    this.frameCount = 0;
    this.clearFailure();
    this.soundOn = false;
    this.sound.setSoundEnable(false);
    // The bang lands on the stream sample of the CPU cycle that fired it.
    engine.onBang = (cycle) => this.sound.triggerBang(cycle);
    const badge = document.getElementById('badge');
    if (badge !== null) {
      badge.textContent = engine.label;
      badge.hidden = engine.label === '';
      badge.dataset.engine = engine.kind;
    }
    const name = document.getElementById('engine-name');
    if (name !== null) name.textContent = ENGINE_NAMES[engine.kind];
    if (engine.ready) showStatus('');
    else if (engine.kind === 'port') {
      showStatus(engine.why, 'play the ROM version', () => { void this.switchEngine('rom'); });
    } else showStatus(engine.why);
    this.canvas.dataset.engine = engine.kind;
    this.canvas.dataset.ready = String(engine.ready);
    this.setAi(false);
    this.updateAiControl();
    // Black until the new engine's first frame (its RAM is still zero,
    // which would draw tile 0 everywhere).
    this.renderer.pixels.fill(0xff000000);
    this.present();
  }

  /**
   * Load and run another engine, from power-on, and remember the choice.
   * @param {import('./engine.js').EngineKind} kind
   */
  async switchEngine(kind) {
    saveEngineChoice(storage(), kind);
    showStatus('loading…');
    this.setEngine(await createEngine(kind));
  }

  /**
   * The start screen again, over the running game (E / settings bar).
   * Picking the engine that is running just resumes it.
   */
  async openChooser() {
    if (this.chooser === null || this.chooser.isOpen) return;
    const current = this.engine?.kind ?? null;
    this.choosing = true;
    this.applyFrozen();
    const kind = await this.chooser.choose(current ?? loadEngineChoice(storage()),
      { cancelable: current !== null, current });
    this.choosing = false;
    this.applyFrozen();
    if (kind !== null && kind !== current) await this.switchEngine(kind);
  }

  /**
   * The AI control is live only when the engine can take the AI (the
   * JavaScript port); on the ROM it is disabled, with the reason as its
   * tooltip.
   */
  updateAiControl() {
    const ok = this.engine?.supportsAi === true;
    const button = /** @type {HTMLButtonElement | null} */ (document.getElementById('set-ai'));
    if (button !== null) {
      button.disabled = !ok;
      button.title = ok ? 'The computer plays (JavaScript version)' : AI_ROM_NOTE;
    }
  }

  /**
   * Turn the self-playing AI on or off. Does nothing on an engine that
   * cannot take it (the ROM): the AI exists only for the JavaScript port.
   * @param {boolean} on
   */
  setAi(on) {
    const engine = this.engine;
    const allowed = on && aiAllowed(engine);
    this.aiEnabled = allowed;
    // A fresh AI each time it is switched on: its history is of the frames
    // it saw, and it must never outlive the engine it read.
    this.ai = allowed && engine !== null ? createPageAutoplayer(engine, this.aiInputs) : null;
    if (engine !== null && 'aiEnabled' in engine) engine.aiEnabled = allowed;
    // Hand the controls back cleanly, or a stale gamepad input stays held.
    this.mux.clearSource('gamepad');
    this.mux.invalidate();
    setPressed('set-ai', allowed);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = null;
    requestAnimationFrame(this.tick);
  }

  stop() { this.running = false; }

  /**
   * One animation frame. The next one is queued whatever happens here: an
   * exception that escaped would otherwise end the loop for good.
   * @param {number} now milliseconds from requestAnimationFrame
   */
  tick = (now) => {
    if (!this.running) return;
    try {
      this.advance(now);
    } catch (err) {
      this.halt('page', err);
    } finally {
      requestAnimationFrame(this.tick);
    }
  };

  /**
   * The body of tick(): run the game frames that are due and show them.
   * @param {number} now milliseconds from requestAnimationFrame
   */
  advance(now) {
    if (this.lastTime === null) this.lastTime = now;
    this.accumulator += now - this.lastTime;
    this.lastTime = now;

    // Poll the pad here rather than in stepFrame: pause has to keep working
    // while the simulation is frozen, or the button that paused the game
    // could never unpause it.
    const padActions = this.gamepad.poll();
    this.handlePauseEdge(padActions.has('pause'));

    if (this.frozen) {
      // Drop the accumulator, or the time spent paused would be owed to the
      // simulation and it would fast-forward the instant it resumed.
      this.accumulator = 0;
      return;
    }

    let due = Math.floor(this.accumulator / FRAME_MS);
    if (due > MAX_CATCHUP_FRAMES) {
      // The tab was hidden or the machine stalled: drop the backlog rather
      // than fast-forwarding through it.
      this.accumulator = 0;
      due = 1;
    } else {
      this.accumulator -= due * FRAME_MS;
    }

    for (let i = 0; i < due; i += 1) this.stepFrame(padActions);
    if (due > 0) this.present();
  }

  /**
   * Advance the simulation by exactly one 1/60.606 s frame.
   * @param {ReadonlySet<string>} [padActions] this tick's gamepad state
   * @param {boolean} [draw] render the frame (false while fast-forwarding)
   */
  stepFrame(padActions, draw = true) {
    const engine = this.engine;
    if (engine === null || !engine.ready || this.failure !== '') return;
    this.frameCount += 1;
    this.mux.setAll('gamepad', toSwitchNames(padActions ?? this.gamepad.poll()));
    const input = this.frameInputs(engine);
    // Each stage is guarded on its own so the message names the culprit.
    // The port engine catches its own errors and goes not-ready (with
    // `why`) instead of throwing; the ROM engine throws.
    try {
      engine.runFrame(input);
    } catch (err) {
      this.halt('engine', err);
      return;
    }
    if (!engine.ready) {
      this.halt('engine', 'error' in engine ? engine.error : null, engine.why);
      return;
    }
    try {
      // The frame shown is RAM at the vblank instant, then the starfield
      // advances (MAME: screen_update, then screen_vblank(0)). The stars
      // advance every frame even when it is not drawn.
      if (draw) this.renderer.render(engine.mem, { starControl: engine.starControl });
      this.renderer.vblank(engine.starControl);
    } catch (err) {
      this.halt('renderer', err);
      return;
    }
    try {
      const on = engine.soundEnable();
      if (on !== this.soundOn) {
        this.soundOn = on;
        this.sound.setSoundEnable(on);
      }
      this.sound.update(engine.soundRegs());
    } catch (err) {
      this.halt('sound', err);
    }
  }

  /**
   * The inputs to run the next frame on. While the AI plays the port, the
   * frame runs on its switches; otherwise (and always on the ROM) on the
   * page's. An AI that throws is switched off, with a note under the
   * screen, and the frame runs on the page's switches: a broken AI must
   * never stop the game.
   * @param {NonNullable<Game['engine']>} engine
   * @returns {import('./machine/namcoio.js').InputState}
   */
  frameInputs(engine) {
    try {
      return autoplayInputs(engine, this.ai, this.inputs, this.aiInputs);
    } catch (err) {
      console.error(`gaplus: AI failed at frame ${this.frameCount}:`, err);
      this.setAi(false);
      showNote(`AI switched off after an error: ${messageOf(err)}`);
      return this.inputs;
    }
  }

  /**
   * Stop the simulation on an error: say why on the page, silence the
   * sound and log the error with the frame number. The frame loop keeps
   * running (so pause, E and the settings still work) but runs no frames
   * until a new engine or a reset (F2).
   * @param {string} stage what failed: engine, renderer, sound, page
   * @param {unknown} err the exception (null if only `why` is known)
   * @param {string} [why] the message to show; default from `err`
   */
  halt(stage, err, why = '') {
    if (this.failure !== '') return;
    const text = why !== '' ? why : `${stage} stopped: ${messageOf(err)}`;
    this.failure = text;
    console.error(`gaplus: ${stage} failed at frame ${this.frameCount}:`,
      err ?? text);
    this.silence();
    this.canvas.dataset.ready = 'false';
    this.canvas.dataset.failed = stage;
    const kind = this.engine?.kind;
    if (kind === 'port') {
      showStatus(text, 'play the ROM version', () => { void this.switchEngine('rom'); });
    } else if (kind !== undefined) {
      showStatus(text, 'restart', () => { void this.switchEngine(kind); });
    } else showStatus(text);
  }

  /**
   * Make the sound engine silent for good, even if its own update() is
   * what failed: sound off, an all-zero register image (volume 0 on every
   * voice), and the mixer paused (it outputs zeros while paused).
   */
  silence() {
    this.soundOn = false;
    try {
      this.sound.setSoundEnable(false);
      this.sound.update(new Uint8Array(REG_COUNT));
    } catch (err) {
      // Only a warning: the error that stopped the game is already logged,
      // and the paused mixer below is silent anyway.
      console.warn('gaplus: could not silence the sound engine:', err);
    }
    try { this.sound.setPaused(true); } catch { /* nothing more to do */ }
  }

  /** Forget a failure (new engine, reset): the simulation may run again. */
  clearFailure() {
    if (this.failure === '') return;
    this.failure = '';
    delete this.canvas.dataset.failed;
    showStatus('');
    this.sound.setPaused(this.frozen);
  }

  /**
   * Test hook (test/browser/smoke.mjs): make one stage throw on every
   * frame from now on. 'port' breaks the port inside the port engine,
   * 'engine' the engine object itself (as the ROM engine would throw),
   * 'ai' switches the AI on and breaks it.
   * @param {'engine' | 'port' | 'ai' | 'renderer' | 'sound'} stage
   */
  testFault(stage) {
    const boom = () => { throw new Error(`injected ${stage} fault`); };
    const engine = this.engine;
    if (stage === 'ai') {
      if (this.ai === null) this.setAi(true);
      if (this.ai !== null) Reflect.set(this.ai, 'step', boom);
    } else if (stage === 'port') {
      const port = engine !== null && 'port' in engine ? engine.port : null;
      if (port !== null) Reflect.set(port, 'runFrame', boom);
    } else if (stage === 'engine') {
      if (engine !== null) Reflect.set(engine, 'runFrame', boom);
    } else if (stage === 'renderer') Reflect.set(this.renderer, 'render', boom);
    else Reflect.set(this.sound, 'update', boom);
  }

  /** True while the simulation is stopped, for any reason. */
  get frozen() { return this.paused || this.hidden || this.choosing; }

  /** @param {boolean} held */
  handlePauseEdge(held) {
    if (held && !this.padPauseHeld) this.setPaused(!this.paused);
    this.padPauseHeld = held;
  }

  /** @param {boolean} on */
  setPaused(on) {
    if (this.paused === on) return;
    this.paused = on;
    setPressed('set-pause', on);
    this.applyFrozen();
  }

  /** @param {boolean} on */
  setHidden(on) {
    if (this.hidden === on) return;
    this.hidden = on;
    this.applyFrozen();
  }

  /**
   * Bring sound, the on-screen indicator and the clock in line with the two
   * freeze flags. Only a deliberate pause is announced on screen.
   */
  applyFrozen() {
    const frozen = this.frozen;
    // After a failure the mixer stays paused: its held registers may be
    // a tone that would otherwise play forever.
    this.sound.setPaused(frozen || this.failure !== '');
    // A still screen looks like a crash, so a pause is announced.
    showNote(this.paused ? 'PAUSED — P to resume' : '');
    if (!frozen) {
      this.mux.invalidate();
      this.lastTime = null;
      this.accumulator = 0;
    }
  }

  /** Start audio (needs a user gesture); hides the "start sound" hint. */
  startSound() {
    void this.sound.start().then(() => {
      const hint = document.getElementById('soundhint');
      if (hint !== null && this.sound.ready) hint.hidden = true;
    });
  }

  /** Mute or unmute, keeping the settings button in step. */
  toggleSound() {
    void this.sound.start().then(() => {
      this.sound.toggle();
      setPressed('set-sound', !this.sound.muted);
    });
  }

  /**
   * Flip the service-mode ("test") DIP switch. The ROM reads the DIPs at
   * boot only (docs/hardware.md s. 4.5, $E10B), so the board is reset,
   * as an operator would power-cycle the cabinet.
   */
  toggleTest() {
    const on = !testSwitch(this.inputs);
    setTestSwitch(this.inputs, on);
    setPressed('set-test', on);
    this.engine?.reset();
    // A reset starts from power-on, so a stopped engine may run again.
    if (this.engine?.ready === true) this.clearFailure();
    this.soundOn = false;
    this.sound.setSoundEnable(false);
  }

  present() {
    this.ctx.putImageData(this.frame, 0, 0);
    // Expose progress on the element itself, so a headless browser can tell
    // a running game from a stalled one.
    this.canvas.dataset.frame = String(this.frameCount);
  }

  /** Handy in the console: `gaplus.state()`. @returns {Record<string, unknown>} */
  state() {
    return {
      frame: this.frameCount,
      engine: this.engine?.kind ?? 'none',
      ready: this.engine?.ready ?? false,
      ai: this.aiEnabled,
      test: testSwitch(this.inputs),
    };
  }

  /**
   * Set the CSS scale of the screen. Fit-to-window zooms may be fractional;
   * the +/- keys step to the next whole factor (see stepZoom).
   * @param {number} z
   */
  setZoom(z) {
    this.zoom = Math.max(1, Math.min(6, z));
    this.canvas.style.setProperty('--zoom', String(this.zoom));
  }

  /**
   * +/- keys: move to the next whole zoom factor up or down, so a
   * fractional fit (say 2.6) goes to 3 or 2, never to 3.6 or 1.6. Once the
   * player zooms by hand, resizing the window no longer refits.
   * @param {1 | -1} dir
   */
  stepZoom(dir) {
    this.manualZoom = true;
    const z = this.zoom;
    this.setZoom(dir > 0 ? Math.floor(z + 1e-6) + 1 : Math.ceil(z - 1e-6) - 1);
  }
}

/** @param {unknown} err @returns {string} */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Translate gamepad actions into switch names, dropping host-only actions
 * such as `pause`.
 * @param {ReadonlySet<string>} actions
 * @returns {Set<import('./input/mux.js').InputName>}
 */
function toSwitchNames(actions) {
  /** @type {Set<import('./input/mux.js').InputName>} */
  const out = new Set();
  for (const action of actions) {
    const name = MACHINE_INPUT[action];
    if (name !== undefined) out.add(/** @type {import('./input/mux.js').InputName} */ (name));
  }
  return out;
}

/**
 * Show (or with '' hide) the message over the screen, optionally with one
 * action button under it.
 * @param {string} text
 * @param {string} [action] button label
 * @param {() => void} [onAction]
 */
function showStatus(text, action = '', onAction = undefined) {
  const el = document.getElementById('status');
  const msg = document.getElementById('statustext');
  const button = /** @type {HTMLButtonElement | null} */ (document.getElementById('statusaction'));
  if (el === null || msg === null) return;
  msg.textContent = text;
  el.hidden = text === '';
  if (button !== null) {
    button.textContent = action;
    button.hidden = action === '';
    button.onclick = onAction === undefined ? null : () => { button.blur(); onAction(); };
  }
}

/** @param {Game} game */
function attachInput(game) {
  /** @param {KeyboardEvent} e @param {boolean} down */
  const handle = (e, down) => {
    if (e.repeat) { if (e.code in KEY_MAP) e.preventDefault(); return; }
    // The chooser owns the keyboard while it is open (it stops its own
    // events; this catches a key pressed as it closes).
    if (game.chooser?.isOpen === true) return;
    // The remap dialog owns the keyboard while it is open.
    if (game.remap?.isOpen === true) {
      if (down && e.code === 'KeyG') { game.remap.close(); e.preventDefault(); }
      return;
    }
    const mapped = KEY_MAP[/** @type {keyof typeof KEY_MAP} */ (e.code)];
    if (mapped !== undefined) {
      game.mux.set('keyboard', mapped, down);
      e.preventDefault();
      return;
    }
    if (!down) return;
    if (e.code === 'KeyG') {
      game.remap?.toggle();
      e.preventDefault();
    } else if (e.code === 'KeyP') {
      game.setPaused(!game.paused);
      e.preventDefault();
    } else if (e.code === 'KeyM') {
      game.toggleSound();
      e.preventDefault();
    } else if (e.code === 'F2' || e.code === 'Digit9') {
      game.toggleTest();
      e.preventDefault();
    } else if (e.code === 'KeyA') {
      // JavaScript engine only; setAi ignores it on the ROM.
      game.setAi(!game.aiEnabled);
      e.preventDefault();
    } else if (e.code === 'KeyE') {
      void game.openChooser();
      e.preventDefault();
    } else if (e.code === 'Equal' || e.code === 'NumpadAdd') game.stepZoom(1);
    else if (e.code === 'Minus' || e.code === 'NumpadSubtract') game.stepZoom(-1);
    else if (e.code === 'Slash' || e.key === '?') { toggleHelp(); e.preventDefault(); }
  };
  // Any key is a user gesture, which is what browsers require before audio.
  window.addEventListener('keydown', (e) => { game.startSound(); handle(e, true); });
  window.addEventListener('keyup', (e) => handle(e, false));
  window.addEventListener('pointerdown', () => game.startSound());
  document.addEventListener('visibilitychange', () => {
    game.setHidden(document.hidden === true);
  });

  // The settings bar. Each button does what its key does; focus is dropped
  // afterwards so that Space -- the fire button -- cannot press it again.
  /** @param {string} id @param {() => void} action */
  const button = (id, action) => {
    const el = document.getElementById(id);
    if (el === null) return;
    el.addEventListener('click', () => {
      game.startSound();
      action();
      el.blur();
    });
  };
  button('set-sound', () => game.toggleSound());
  button('set-joy', () => game.remap?.toggle());
  button('set-pause', () => game.setPaused(!game.paused));
  button('set-test', () => game.toggleTest());
  button('set-ai', () => game.setAi(!game.aiEnabled));
  button('set-engine', () => { void game.openChooser(); });
  button('set-help', () => toggleHelp());

  window.addEventListener('gamepadconnected', () => { game.gamepad.recalibrate(); });
  window.addEventListener('gamepaddisconnected', () => {
    game.gamepad.handleDisconnect();
    game.mux.clearSource('gamepad');
  });
  window.addEventListener('focus', () => {
    game.gamepad.enabled = true;
    game.gamepad.recalibrate();
  });
  window.addEventListener('blur', () => {
    game.gamepad.enabled = false;
    // Open every switch: a key held while focus leaves never sends keyup.
    game.mux.reset();
    releaseAll(game.inputs);
  });
}

/**
 * `?frames=N`: run N frames as fast as possible (in chunks, so the page
 * stays alive and `canvas.dataset.frame` can be watched), show the last
 * one, and stop. `&coin=F` / `&start=G` tap coin 1 / start 1 at those
 * frames (bare `&coin&start`: 300 and 360).
 * @param {Game} game
 * @param {URLSearchParams} params
 * @param {number} frames
 * @returns {Promise<void>}
 */
async function runFast(game, params, frames) {
  /** @param {string} key @param {number} fallback @returns {number} */
  const at = (key, fallback) => {
    if (!params.has(key)) return -1;
    const v = Number.parseInt(params.get(key) ?? '', 10);
    return Number.isFinite(v) ? v : fallback;
  };
  const coinAt = at('coin', 300);
  const startAt = at('start', 360);
  const none = new Set();
  /** Hold a switch for 4 frames starting at frame `f`. @param {number} f @param {number} i @param {string} name */
  const tap = (f, i, name) => {
    if (f < 0) return;
    if (i === f) setSwitch(game.inputs, name, true);
    if (i === f + 4) setSwitch(game.inputs, name, false);
  };
  for (let i = 0; i < frames; i += 1) {
    tap(coinAt, i, 'coin1');
    tap(startAt, i, 'start1');
    game.stepFrame(none, i === frames - 1);
    if ((i + 1) % FAST_CHUNK === 0) {
      game.canvas.dataset.frame = String(game.frameCount);
      // Yield to the event loop between chunks.
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    }
  }
  game.present();
  showNote(`stopped after ${frames} frames (?frames)`);
}

/**
 * A one-line note under the screen (pause, ?frames), or '' to hide it.
 * @param {string} text
 */
function showNote(text) {
  const el = document.getElementById('runnote');
  if (el === null) return;
  el.textContent = text;
  el.hidden = text === '';
}

/** Show or hide the "?" panel listing every key. */
function toggleHelp() {
  const panel = document.getElementById('help');
  if (panel === null) return;
  panel.hidden = !panel.hidden;
  document.getElementById('set-help')?.setAttribute('aria-expanded', String(!panel.hidden));
}

/**
 * The largest zoom (1-6, fractional allowed) at which the screen and
 * everything else on the page fit the window without scrolling.
 *
 * The space the page needs besides the canvas is measured, not guessed:
 * the content's height minus the canvas's own height is what the legend,
 * settings bar, gaps and padding take (nothing, when they sit beside the
 * screen). The result is rounded down so the screen's height is a whole
 * number of device pixels.
 * @param {HTMLCanvasElement} canvas
 * @returns {number}
 */
function fitZoom(canvas) {
  const canvasH = canvas.getBoundingClientRect().height;
  // body is height:100%, so its scrollHeight is the window, not the
  // content. Measure the content instead: the lowest bottom edge of any
  // in-flow child (fixed-position ones like #version don't take space),
  // plus the body's bottom padding.
  let bottom = 0;
  for (const el of document.body.children) {
    if (!(el instanceof HTMLElement) || el.tagName === 'DIALOG') continue;
    if (getComputedStyle(el).position === 'fixed') continue;
    bottom = Math.max(bottom, el.getBoundingClientRect().bottom + window.scrollY);
  }
  const padBottom = Number.parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
  const others = Math.max(0, bottom + padBottom - canvasH);
  const dpr = window.devicePixelRatio || 1;
  // Beside-the-screen layout (landscape): the screen shares the width with
  // the side panel on its right and an equal empty column on its left
  // (the grid keeps it centred), so both come off the width.
  const side = document.getElementById('side');
  const beside = window.matchMedia('(min-aspect-ratio: 1/1)').matches;
  const sideW = beside && side !== null ? side.getBoundingClientRect().width + 16 : 16;
  const byW = (window.innerWidth - 2 * sideW) / 224;
  const byH = (window.innerHeight - others) / 288;
  // Snap down so the screen's height is a whole number of device pixels
  // (keeps its edges crisp); the zoom itself may be fractional.
  const z = Math.floor(Math.min(byW, byH) * 288 * dpr) / (288 * dpr);
  return Math.max(1, Math.min(6, z));
}

/** Stamp the version into the corner of the page. */
function showVersion() {
  const el = document.getElementById('version');
  if (el !== null) el.textContent = `version ${VERSION} · code by Moshix`;
}

async function boot() {
  const canvas = /** @type {HTMLCanvasElement | null} */ (document.getElementById('screen'));
  showVersion();
  if (canvas === null) return;
  const params = new URLSearchParams(location.search);
  const game = new Game(canvas);
  const zoom = Number.parseFloat(params.get('zoom') ?? '');
  if (Number.isFinite(zoom)) {
    game.manualZoom = true;
    game.setZoom(zoom);
  } else {
    // Two passes: the first measures the page at the default zoom, the
    // second corrects for rows (like the settings bar) that re-wrap once
    // the canvas width changes.
    game.setZoom(fitZoom(canvas));
    game.setZoom(fitZoom(canvas));
    window.addEventListener('resize', () => {
      if (!game.manualZoom) game.setZoom(fitZoom(canvas));
    });
  }
  game.remap = new RemapUI(game.gamepad);
  game.chooser = new EngineChooser({ gamepad: game.gamepad, onGesture: () => game.startSound() });
  attachInput(game);
  game.updateAiControl();
  // Handy for headless tests and for poking at things in the console.
  Reflect.set(globalThis, 'gaplus', game);
  // Paint a black frame so the canvas is never left transparent (an
  // all-zero buffer is transparent, which shows as grey).
  game.renderer.pixels.fill(0xff000000);
  game.present();

  const frames = Number.parseInt(params.get('frames') ?? '', 10);
  const fast = Number.isFinite(frames) && frames > 0;
  // The URL can name the engine; otherwise ask, preselecting last time's.
  let kind = engineKindFrom(location.search);
  if (kind === null) {
    const last = loadEngineChoice(storage());
    kind = fast ? last : (await game.chooser.choose(last)) ?? last;
    saveEngineChoice(storage(), kind);
  }
  showStatus('loading…');
  game.setEngine(await createEngine(kind));

  if (fast) {
    await runFast(game, params, frames);
    return;
  }
  game.start();
}

void boot();

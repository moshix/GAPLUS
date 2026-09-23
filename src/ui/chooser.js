// Copyright 2026 by Moshix
/**
 * The start screen: choose what to run, the original ROM on emulated
 * 6809s or the JavaScript port.
 *
 * Shown on every fresh load (unless the URL says `?engine=rom|port`), with
 * the last choice preselected, and again from the settings bar (E) to
 * switch engines. The markup is a native `<dialog id="chooser">` in
 * index.html whose options are `button[data-engine]`: showModal() gives
 * focus trapping and an inert page behind it for free.
 *
 * Navigation:
 *   keyboard  arrows move between the options; Enter or Space picks (the
 *             buttons' own activation); Escape closes it only when there
 *             is already a game to go back to
 *   gamepad   stick / d-pad moves, fire or start picks (polled once per
 *             animation frame while open, edge-triggered)
 *   mouse     click an option
 *
 * A click or key press on it is a user gesture, which the caller uses to
 * start audio (`onGesture`). A gamepad press is not a gesture in any
 * browser, so picking with the pad leaves sound off until a key or click.
 */

/** @typedef {import('../engine.js').EngineKind} EngineKind */
/** @typedef {import('../input/gamepad.js').GamepadInput} GamepadInput */

/**
 * Move a selection by `delta` through `count` items, wrapping around.
 * @param {number} index @param {number} count @param {number} delta
 * @returns {number}
 */
export function stepIndex(index, count, delta) {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/** Arrow keys and what they do to the selection. @type {Readonly<Record<string, number>>} */
const KEY_STEP = Object.freeze({ ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 });

export class EngineChooser {
  /**
   * @param {object} opts
   * @param {GamepadInput} [opts.gamepad] for pad navigation
   * @param {() => void} [opts.onGesture] a click or key on the chooser
   * @param {Document} [opts.doc]
   */
  constructor(opts = {}) {
    const doc = opts.doc ?? document;
    this.dialog = /** @type {HTMLDialogElement | null} */ (doc.getElementById('chooser'));
    /** @type {HTMLButtonElement[]} */
    this.options = this.dialog === null ? []
      : [...this.dialog.querySelectorAll('button[data-engine]')].map(
        (b) => /** @type {HTMLButtonElement} */ (b));
    this.gamepad = opts.gamepad ?? null;
    this.onGesture = opts.onGesture ?? (() => {});
    /** Resolves the pending choose(). @type {((kind: EngineKind | null) => void) | null} */
    this.resolve = null;
    /** Escape may close it (there is a game behind it). */
    this.cancelable = false;
    /** Pad state last frame, for edges. @type {Set<string>} */
    this.padHeld = new Set();
    if (this.dialog === null) return;

    for (const button of this.options) {
      button.addEventListener('click', () => {
        this.onGesture();
        this.finish(/** @type {EngineKind} */ (button.dataset.engine));
      });
    }
    this.dialog.addEventListener('keydown', (e) => {
      this.onGesture();
      const delta = KEY_STEP[e.key];
      if (delta !== undefined) {
        this.move(delta);
        e.preventDefault();
      }
      // Keep game keys from reaching the page's handler while choosing.
      e.stopPropagation();
    });
    this.dialog.addEventListener('keyup', (e) => e.stopPropagation());
    this.dialog.addEventListener('cancel', (e) => {
      // Escape: nothing to go back to on first load, so it must stay open.
      if (!this.cancelable) { e.preventDefault(); return; }
      this.finish(null);
    });
  }

  /** @returns {boolean} */
  get isOpen() { return this.dialog !== null && this.dialog.open; }

  /** Index of the focused option, or -1. @returns {number} */
  focusedIndex() {
    const active = this.dialog?.ownerDocument.activeElement;
    return this.options.findIndex((b) => b === active);
  }

  /** @param {number} delta */
  move(delta) {
    const at = this.focusedIndex();
    const next = stepIndex(at < 0 ? 0 : at, this.options.length, delta);
    this.options[next]?.focus();
  }

  /**
   * Show the chooser and wait for a pick.
   * @param {EngineKind} preselect option focused first
   * @param {{cancelable?: boolean, current?: EngineKind | null}} [opts]
   *   cancelable: Escape returns null (a game is running behind it);
   *   current: the engine running now, marked in the list
   * @returns {Promise<EngineKind | null>}
   */
  choose(preselect, opts = {}) {
    if (this.dialog === null) return Promise.resolve(preselect);
    this.cancelable = opts.cancelable === true;
    for (const b of this.options) {
      b.classList.toggle('current', b.dataset.engine === opts.current);
    }
    if (!this.dialog.open) this.dialog.showModal();
    const first = this.options.find((b) => b.dataset.engine === preselect) ?? this.options[0];
    first?.focus();
    this.padHeld = new Set(this.gamepad?.poll() ?? []);
    requestAnimationFrame(this.pollPad);
    return new Promise((resolve) => { this.resolve = resolve; });
  }

  /**
   * Gamepad navigation, once per animation frame while open. Only newly
   * pressed controls count, so a held stick moves one step, not sixty.
   */
  pollPad = () => {
    if (!this.isOpen || this.gamepad === null) return;
    const now = this.gamepad.poll();
    /** @param {string} a @returns {boolean} */
    const pressed = (a) => now.has(a) && !this.padHeld.has(a);
    if (pressed('up') || pressed('left')) this.move(-1);
    else if (pressed('down') || pressed('right')) this.move(1);
    else if (pressed('fire') || pressed('start')) {
      const at = this.focusedIndex();
      this.padHeld = now;
      this.finish(/** @type {EngineKind} */ (this.options[at < 0 ? 0 : at].dataset.engine));
      return;
    }
    this.padHeld = now;
    requestAnimationFrame(this.pollPad);
  };

  /** @param {EngineKind | null} kind */
  finish(kind) {
    if (this.dialog?.open) this.dialog.close();
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(kind);
  }
}

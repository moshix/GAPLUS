// Copyright 2026 by Moshix
/**
 * How the page lets the AI play: the one hook src/main.js calls before
 * every frame.
 *
 * The AI never touches the page's input state (the keyboard and pad keep
 * theirs) and never writes game RAM. It has an input state of its own
 * (src/machine/namcoio.js InputState, the same path a human's switches
 * take); before each frame the page's state is copied into it -- DIPs,
 * the service switch and the second player's controls pass through --
 * the AI opens every switch it owns and closes the ones it wants, and
 * that state is what the engine runs the frame with.
 *
 * The AI exists only for the JavaScript port: on any other engine (the
 * ROM) the hook hands back the page's own inputs and the AI never runs.
 */

import { AutoPlayer } from './autoplay.js';
import { copyInputs } from '../engine.js';
import { setSwitch } from '../input/switches.js';

/** @typedef {import('../machine/namcoio.js').InputState} InputState */

/**
 * What the hook needs of an engine.
 * @typedef {object} EngineLike
 * @property {string} kind          'rom' | 'port'
 * @property {boolean} supportsAi
 * @property {Uint8Array} mem       main-CPU address space
 */

/**
 * May the AI drive this engine? Only the JavaScript port.
 * @param {EngineLike | null | undefined} engine @returns {boolean}
 */
export function aiAllowed(engine) {
  return engine?.kind === 'port' && engine.supportsAi === true;
}

/**
 * An AutoPlayer that reads the engine's RAM and closes switches in `own`.
 * Reads go through `engine.mem` each time, so a port that replaces its
 * memory is still read correctly.
 * @param {EngineLike} engine @param {InputState} own
 * @returns {AutoPlayer}
 */
export function createPageAutoplayer(engine, own) {
  return new AutoPlayer({
    peek: (addr) => engine.mem[addr & 0xffff],
    setInput: (name, down) => setSwitch(own, name, down),
  });
}

/**
 * The inputs to run the next frame with.
 * @param {EngineLike | null} engine
 * @param {AutoPlayer | null} ai      null: the AI is off
 * @param {InputState} page           the page's (keyboard, pad, DIPs)
 * @param {InputState} own            the AI's
 * @returns {InputState}
 */
export function autoplayInputs(engine, ai, page, own) {
  if (ai === null || !aiAllowed(engine)) return page;
  copyInputs(page, own);
  ai.step();
  return own;
}

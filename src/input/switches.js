// Copyright 2026 by Moshix
/**
 * Closing and opening the cabinet's switches in an input state
 * (src/machine/namcoio.js `InputState`), by name.
 *
 * The page keeps ONE input state -- the outside world: sticks, buttons,
 * coin slots, DIP switches -- and hands it to whichever engine is running
 * each frame (the port's Machine, or the emulated preview board). The
 * input mux (mux.js) calls {@link setSwitch} only on real changes.
 *
 * Names are the ones `Machine.setInput` accepts, so the two stay
 * interchangeable: coin1 coin2 service start1 start2 fire1 fire2
 * up down left right p2up p2down p2left p2right.
 */

import { setDip } from '../machine/namcoio.js';

/** @typedef {import('../machine/namcoio.js').InputState} InputState */

const DIRS = /** @type {const} */ (['up', 'down', 'left', 'right']);
const BUTTONS = /** @type {const} */ (
  ['coin1', 'coin2', 'service', 'start1', 'start2', 'fire1', 'fire2']);

/** Every name {@link setSwitch} accepts. */
export const SWITCH_NAMES = Object.freeze([
  ...BUTTONS, ...DIRS, ...DIRS.map((d) => `p2${d}`),
]);

/**
 * Press (`down` true) or release a switch.
 * @param {InputState} inputs mutated in place
 * @param {string} name one of {@link SWITCH_NAMES}
 * @param {boolean} down
 */
export function setSwitch(inputs, name, down) {
  const dir = /** @type {typeof DIRS[number] | undefined} */ (
    DIRS.find((d) => d === name || `p2${d}` === name));
  if (dir !== undefined) {
    (name.startsWith('p2') ? inputs.p2 : inputs.p1)[dir] = down;
    return;
  }
  const button = BUTTONS.find((b) => b === name);
  if (button === undefined) throw new Error(`unknown switch ${name}`);
  inputs[button] = down;
}

/** Open every switch (window blur: a held key never sends keyup). @param {InputState} inputs */
export function releaseAll(inputs) {
  for (const b of BUTTONS) inputs[b] = false;
  for (const d of DIRS) { inputs.p1[d] = false; inputs.p2[d] = false; }
}

/**
 * The service-mode ("test") switch: MAME's SW2:1, the DSWB_HIGH bit $8,
 * active low ($8 off, $0 on). @see namcoio.js DIP_FIELDS.serviceMode
 * @param {InputState} inputs @returns {boolean}
 */
export function testSwitch(inputs) {
  return (inputs.dips.DSWB_HIGH & 0x08) === 0;
}

/** @param {InputState} inputs @param {boolean} on */
export function setTestSwitch(inputs, on) {
  setDip(inputs, 'serviceMode', on ? 0x0 : 0x8);
}

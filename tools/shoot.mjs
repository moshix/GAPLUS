// Copyright 2026 by Moshix
/**
 * Screenshot the ORIGINAL ROM, running on the emulated board
 * (src/emu/board.js), through the port's own renderer.
 *
 *   node tools/shoot.mjs out.png FRAME [options]
 *
 *   --coin@F         tap coin 1 at frame F (held 4 frames); repeatable
 *   --start@F        tap start 1 at frame F; also --start2@F, --service@F,
 *                    --fire@F, or any Machine input name: --left@F
 *   --hold=NAME@F-G  hold an input from frame F to frame G
 *   --play=SEED      from the first --start (or frame 0) on, random
 *                    joystick and fire (test/helpers/oracle.mjs
 *                    randomPlayer)
 *   --dip=FIELD:V    set a DIP field (namcoio.js DIP_FIELDS), e.g.
 *                    --dip=serviceMode:0 --dip=lives:0; --dip=FIELD:V@F
 *                    changes it at frame F
 *   --round=N@F      Round Advance: at frame F (in a started game, before
 *                    the stage starts) switch the DIP on, press P1 up N
 *                    times (stage_p1 += N), switch it off again
 *   --poke=ADDR:V@F  write byte V to RAM (main address, hex) at frame F
 *   --scale=N        pixel magnification (default 2)
 *   --every=N        also write out-FFFFF.png every N frames
 *
 * The renderer only reads RAM and the star latches, so if these look like
 * Gaplus, the board and the renderer are right together; if the port's
 * screen differs from them later, the port is wrong.
 */
import { writeFileSync } from 'node:fs';
import { makeOracle, randomPlayer } from '../test/helpers/oracle.mjs';
import { Renderer, SCREEN_WIDTH, SCREEN_HEIGHT } from '../src/video/renderer.js';
import { encodePng } from './png.mjs';

const args = process.argv.slice(2);
const out = args[0] ?? 'shot.png';
const frames = Number(args[1] ?? 600);
if (!Number.isInteger(frames) || frames < 1) {
  console.error('usage: node tools/shoot.mjs out.png FRAME [--coin@F] '
    + '[--start@F] [--play=SEED] [--dip=F:V]');
  process.exit(2);
}

const board = makeOracle();
const renderer = new Renderer();
let scale = 2;
let every = 0;
/** @type {number | null} */
let playSeed = null;
let firstStart = Infinity;
/** Extra per-frame actions. @type {Array<(f: number, b: typeof board) => void>} */
const scripts = [];
for (const arg of args.slice(2)) {
  let m;
  if ((m = arg.match(/^--(\w+)@(\d+)$/))) {
    const at = Number(m[2]);
    const name = { coin: 'coin1', start: 'start1', fire: 'fire1' }[m[1]] ?? m[1];
    if (name === 'start1') firstStart = Math.min(firstStart, at);
    board.tap(name, at, 4);
  } else if ((m = arg.match(/^--hold=(\w+)@(\d+)-(\d+)$/))) {
    board.at(Number(m[2]), m[1], true);
    board.at(Number(m[3]), m[1], false);
  } else if ((m = arg.match(/^--play=(\d+)$/))) {
    playSeed = Number(m[1]);
  } else if ((m = arg.match(/^--dip=(\w+):(\d+)$/))) {
    board.setDip(m[1], Number(m[2]));
  } else if ((m = arg.match(/^--dip=(\w+):(\d+)@(\d+)$/))) {
    const [field, value, at] = [m[1], Number(m[2]), Number(m[3])];
    scripts.push((f, b) => { if (f === at) b.setDip(field, value); });
  } else if ((m = arg.match(/^--round=(\d+)@(\d+)$/))) {
    const [steps, at] = [Number(m[1]), Number(m[2])];
    // round_select ($C163) loops in the main IRQ while the DIP is on and
    // adds 1 to stage_p1 per P1-up press (edge on $6804 bit 0).
    const end = at + 20 + steps * 20;
    scripts.push((f, b) => {
      if (f === at) b.setDip('roundAdvance', 0);
      // One press every 20 frames from at + 10: exactly `steps` presses.
      const k = f - at - 10;
      if (k >= 0 && k < steps * 20 && k % 20 === 0) b.setInput('up', true);
      if (k >= 0 && k < steps * 20 && k % 20 === 8) b.setInput('up', false);
      if (f === end) b.setDip('roundAdvance', 8);
    });
  } else if ((m = arg.match(/^--poke=([0-9a-fA-F]+):([0-9a-fA-F]+)@(\d+)$/))) {
    const [addr, value, at] = [parseInt(m[1], 16), parseInt(m[2], 16), Number(m[3])];
    scripts.push((f, b) => { if (f === at) b.mem[addr] = value; });
  } else if ((m = arg.match(/^--scale=(\d+)$/))) {
    scale = Number(m[1]);
  } else if ((m = arg.match(/^--every=(\d+)$/))) {
    every = Number(m[1]);
  } else {
    console.error(`unknown option ${arg}`);
    process.exit(2);
  }
}
/** @type {null | ((f: number, b: typeof board) => void)} */
let player = null;
if (playSeed !== null) {
  const from = Number.isFinite(firstStart) ? firstStart + 8 : 0;
  player = randomPlayer(playSeed, { from });
}
board.inputScript = (f, b) => {
  for (const s of scripts) s(f, b);
  // The random player pauses while Round Advance holds the stick.
  if (player && b.inputs.dips.DSWB_LOW & 8) player(f, b);
};

/** Render the board as it stands (the vblank instant) into a PNG. @param {string} file */
function save(file) {
  renderer.render(board.mem, { starControl: board.starCtrl });
  writeFileSync(file, encodePng(renderer.pixels, SCREEN_WIDTH, SCREEN_HEIGHT, scale));
}

for (let f = 0; f < frames; f += 1) {
  board.runFrame();
  if (every && board.frame % every === 0 && board.frame !== frames) {
    save(out.replace(/\.png$/, `-${String(board.frame).padStart(5, '0')}.png`));
  }
  // MAME: the screen is drawn at vblank, then the stars move
  // (screen_vblank(0)) at the same instant.
  if (board.frame === frames) save(out);
  renderer.vblank(board.starCtrl);
}
const pc = board.cpus.map((c) => `$${c.pc.toString(16).toUpperCase()}`);
console.log(`${out}: frame ${board.frame}, pc ${pc.join(' ')}`
  + (board.watchdogResets ? `, WATCHDOG x${board.watchdogResets}` : ''));

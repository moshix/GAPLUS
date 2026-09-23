// Copyright 2026 by Moshix
/**
 * The headline test: the original ROM on the oracle board and the
 * JavaScript port (src/game/port.js), stepped together from power-on with
 * the same inputs and compared byte for byte after every frame
 * (test/helpers/lockstep.mjs). Also the pieces it rests on: the port's
 * scheduler against the board with every CPU emulated, and each ported
 * CPU with the other two emulated.
 *
 * WHAT "EXACT" MEANS HERE. The three 6809s race through shared RAM, and
 * the oracle interleaves them in MAME's 256-cycle slices. The port's
 * scheduler uses the same slices and clocks (src/game/scheduler.js); a
 * ported CPU is exact where its code charges its 6809 cycles and yields
 * (SYNC) before the accesses another CPU can see. The sound CPU does both
 * and is exact. Until every CPU does, the full port has one-frame blips
 * (resync copies the ROM's RAM after 3 differing frames) -- the tests
 * marked `todo` state the final bar and report without failing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePortPair } from '../helpers/lockstep.mjs';
import { randomPlayer, makeOracle, callRoutine, fillRandom, loadState,
  diffRam } from '../helpers/oracle.mjs';
import { bridgeRoutine } from '../helpers/bridge.mjs';
import { Machine } from '../../src/machine/machine.js';

/**
 * Coin at 1500, start at 1600, then a seeded random stick and fire.
 * @param {number} seed
 * @returns {import('../helpers/lockstep.mjs').LockstepScript}
 */
function played(seed) {
  const player = randomPlayer(seed, { from: 1700 });
  return (f, press) => {
    if (f === 1500) press('coin1', true);
    if (f === 1504) press('coin1', false);
    if (f === 1600) press('start1', true);
    if (f === 1604) press('start1', false);
    player(f, { setInput: press });
  };
}

/** @param {import('../helpers/lockstep.mjs').PortRunReport} r */
const summary = (r) => `${r.diffFrames}/${r.frames} frames differ, first `
  + `${r.firstFrame}: ${r.firstLines.slice(0, 3).join('; ')}`
  + `${r.threw ? `; threw at ${r.threwAt}: ${r.threw.split('\n')[0]}` : ''}`;

test('scheduler: every CPU emulated = the oracle, boot to a played game', () => {
  const pair = makePortPair({ cores: [0, 1, 2] });
  const r = pair.run(3000, { script: played(3), stopAtFirst: true });
  assert.equal(r.threw, null);
  assert.equal(r.firstFrame, null, summary(r));
});

test('sound port: main and sub emulated, 4000 frames identical', () => {
  const pair = makePortPair({ cores: [0, 1] });
  const r = pair.run(4000, { script: played(5), stopAtFirst: true });
  assert.equal(r.threw, null);
  assert.equal(r.firstFrame, null, summary(r));
});

test('port: power-on and boot identical (the first 233 frames)', () => {
  const pair = makePortPair();
  const r = pair.run(233, { stopAtFirst: true });
  assert.equal(r.threw, null);
  assert.equal(r.firstFrame, null, summary(r));
  assert.equal(pair.coreCpus.length, 0, 'nothing bridged');
});

test('port: 3000 frames of attract with resync never throws', () => {
  const pair = makePortPair();
  const r = pair.run(3000, { resyncAfter: 3 });
  assert.equal(r.threw, null, String(r.threw));
  assert.equal(r.frames, 3000);
});

test('port: attract, every difference heals within 5 frames', {
  todo: 'main/sub chunks not yet synced (docs/requests/integration.md)',
}, () => {
  const pair = makePortPair();
  const r = pair.run(8000, { resyncAfter: 3 });
  assert.equal(r.threw, null);
  assert.ok(r.longestRun <= 5, `longest run ${r.longestRun}: ${summary(r)}`);
});

test('port: a played game, differences heal within 5 frames, < 5%', {
  todo: 'main/sub chunks not yet synced (docs/requests/integration.md)',
}, () => {
  const pair = makePortPair();
  const r = pair.run(12000, { resyncAfter: 3, script: played(7) });
  assert.equal(r.threw, null);
  assert.ok(r.longestRun <= 5, `longest run ${r.longestRun}`);
  assert.ok(r.diffFrames < 12000 * 0.05, summary(r));
});

test('bridge: a routine stand-in does what the ROM routine does', () => {
  // sound next_note ($E309) on a real post-boot state with a channel
  // block pointing at sound 0's first stream
  const boot = makeOracle();
  boot.runFrames(300);
  const m = new Machine();
  loadState(m, boot);
  fillRandom(m, 9, [[0x6100, 0x6111]]);
  m.soundRam[0x100] = 0xe7;
  m.soundRam[0x101] = 0x79;
  m.soundRam[0x102] = 0x00;
  const board = makeOracle();
  loadState(board, m);
  const rom = callRoutine(board, 'sound', 0xe309, { x: 0x0100 });
  const out = /** @type {{ x: number, cycles: number }} */ (
    bridgeRoutine('sound', 0xe309)(m, { x: 0x0100 }));
  assert.deepEqual(diffRam(board, m), []);
  assert.equal(out.x, rom.x);
  assert.equal(out.cycles, rom.cycles);
  // A routine that waits cannot be bridged as a call.
  assert.throws(() => bridgeRoutine('main', 0xd150)(new Machine(), {}),
    /waits/);
});

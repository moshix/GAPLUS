// Copyright 2026 by Moshix
/**
 * Differential tests of the gp2-8.11d port (src/game/sub/gp2_8*.js)
 * against the real ROM code on the oracle's sub CPU. Every test runs the
 * ROM routine (runRom: until RTS or `jmp task_dispatch_sub`) and the JS
 * routine from identical RAM and requires identical RAM afterwards
 * (stacks exempt), the same number of frames waited (CWAI vs yield) and
 * the same consumed output registers.
 *
 * States: real entry states recorded during a scripted game (formation,
 * challenging stage), those states run on for many frames, perturbed
 * copies of them that reach the rare branches, and seeded random states
 * for the code the game never ran in the recorded sessions (the four
 * objects, the power-up effects).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subWord } from '../../src/game/romdata.js';
import { SUB, SUB_AT } from '../../src/game/sub/routines.js';
import {
  GP2_8_ROUTINES, pair, poke2, setRam, runRom, runPort, check, rng,
  capturePlay,
} from './sub-gp2_8-lib.test.mjs';

/** @param {number} v */
const h4 = (v) => v.toString(16).toUpperCase().padStart(4, '0');

// ------------------------------------------------------ registration

test('every gp2-8 routine and table target is registered', () => {
  for (const [a, fn] of Object.entries(GP2_8_ROUTINES)) {
    assert.equal(SUB_AT[Number(a)], fn, `$${h4(Number(a))}`);
    assert.ok(Object.values(SUB).includes(fn), `SUB lacks $${h4(Number(a))}`);
  }
  /** @type {Array<[number, number]>} tables in gp2-8: [base, count] */
  const tables = [[0xb3e6, 6], [0xbb22, 15], [0xbedd, 4]];
  for (const [base, n] of tables) {
    for (let i = 0; i < n; i += 1) {
      const t = subWord(base + 2 * i);
      assert.equal(typeof SUB_AT[t], 'function', `$${h4(base)}[${i}]`);
    }
  }
  // The mode task lists ($E10D-$E17E): every entry in $A000-$BFFF
  for (let a = 0xe10d; a < 0xe17f; a += 2) {
    const t = subWord(a);
    if (t >= 0xa000 && t < 0xc000) {
      assert.equal(typeof SUB_AT[t], 'function', `task $${h4(t)}`);
    }
  }
});

// ------------------------------------------------- recorded game states

test('recorded entry states: every routine the game ran', () => {
  const caps = capturePlay();
  const p = pair();
  /** @type {Set<number>} */
  const seen = new Set();
  for (const c of caps) {
    setRam(p, c.ram);
    const what = `$${h4(c.pc)} frame ${c.frame}`;
    const { rom, port } = check(p, c.pc, c.regs, what);
    if (c.pc === 0xb163) {
      assert.equal(/** @type {{x: number}} */ (port).x, rom.x, what);
    }
    seen.add(c.pc);
  }
  // What the scripted game reaches (coverage file: the object states,
  // $B3F2/$B461/$B860 and $B5A1 are not among them)
  for (const a of [0xb014, 0xb0d4, 0xb163, 0xb20d, 0xb242, 0xb385,
    0xb3d1, 0xb90e, 0xbb50, 0xbb96, 0xbcf3, 0xbd18, 0xbd20, 0xbd56,
    0xbe4f, 0xbe6c, 0xbee5, 0xbf58]) {
    assert.ok(seen.has(a), `no recorded state for $${h4(a)}`);
  }
});

test('recorded task states run on for 60 frames', () => {
  const caps = capturePlay().filter((c) => [0xb014, 0xb385, 0xbb96,
    0xbcf3, 0xbee5, 0xb90e, 0xbb50, 0xb3d1].includes(c.pc));
  const p = pair();
  for (const c of caps) {
    setRam(p, c.ram);
    for (let f = 0; f < 60; f += 1) {
      check(p, c.pc, c.regs, `$${h4(c.pc)} frame ${c.frame}+${f}`);
      // the main IRQ's frame counter
      poke2(p, 0x1016, p.m.mem[0x1016] + 1);
      if (p.m.mem[0x102f] !== c.ram[0x102f]) break; // mode changed
    }
  }
});

// ------------------------------------------------- formation, perturbed

test('formation mover: perturbed flags, positions and pointers', () => {
  const caps = capturePlay().filter((c) => c.pc === 0xb014);
  const r = rng(11);
  const p = pair();
  for (let n = 0; n < 400; n += 1) {
    const c = caps[n % caps.length];
    setRam(p, c.ram);
    // random flag bytes: all combinations of b1 b4 b5 b6 b7
    for (let i = 0; i < 44; i += 1) {
      if (r() % 3 === 0) poke2(p, 0x1860 + i, r() & 0xf3);
    }
    poke2(p, 0x1086, 0x18); // formation_ptr = $1860-$188B
    poke2(p, 0x1087, 0x60 + (r() % 0x2c));
    // step counters, speeds, headings, positions, targets
    for (let i = 0; i < 44; i += 1) {
      if (r() & 1) poke2(p, 0x1890 + i, r() & 0x3f);
      if (r() & 1) poke2(p, 0x18c0 + i, r() & 0x3f);
      if (r() & 1) poke2(p, 0x1980 + i, r());
      if (r() & 1) poke2(p, 0x19e0 + i, r());
      if (r() % 4 === 0) {
        // near the target, to arrive
        const ty = c.ram[0x1b00 + 2 * i];
        const tx = c.ram[0x1b01 + 2 * i];
        poke2(p, 0x1630 + 2 * i, ty + (r() % 11) - 5);
        poke2(p, 0x1631 + 2 * i, tx + (r() % 11) - 5);
      } else if (r() & 1) {
        poke2(p, 0x1630 + 2 * i, r());
        poke2(p, 0x1631 + 2 * i, r());
      }
      if (r() % 8 === 0) poke2(p, 0x1c00 + i, r()); // slot+$39F counter
    }
    poke2(p, 0x112a, r() & 1 ? 0 : 0x55);
    poke2(p, 0x10f8, r() & 1);
    poke2(p, 0x1020, r() & 1);
    poke2(p, 0x1021, r() % 3 === 0 ? 1 : 0);
    poke2(p, 0x1011, r());
    check(p, 0xb014, c.regs, `B014 perturbed #${n}`);
  }
});

test('$B163 / $B20D / $B242 / $B0D4 alone, perturbed', () => {
  const caps = capturePlay().filter((c) => [0xb0d4, 0xb163, 0xb20d,
    0xb242].includes(c.pc));
  const r = rng(12);
  const p = pair();
  for (let n = 0; n < 600; n += 1) {
    const c = caps[n % caps.length];
    setRam(p, c.ram);
    const fp = (c.ram[0x1086] << 8) | c.ram[0x1087];
    const i = (fp - 0x1861) & 0xff;
    if (n % 3 !== 0) {
      poke2(p, 0x1860 + i, r());
      poke2(p, 0x1890 + i, r() & 0x7f);
      poke2(p, 0x18c0 + i, r() & 0x7f);
      poke2(p, 0x1980 + i, r());
      poke2(p, 0x1098, r());
      poke2(p, 0x1630 + 2 * i, r());
      poke2(p, 0x1920 + 2 * i, r());
      poke2(p, 0x1921 + 2 * i, r());
      if (r() & 1) {
        poke2(p, 0x1631 + 2 * i, c.ram[0x1b01 + 2 * i] + (r() % 9) - 4);
        poke2(p, 0x1630 + 2 * i, c.ram[0x1b00 + 2 * i] + (r() % 9) - 4);
      }
      poke2(p, 0x112a, r() & 1);
      poke2(p, 0x10f8, r() & 1);
      poke2(p, 0x1020, r() & 1);
      poke2(p, 0x1021, r() & 1);
    }
    const what = `$${h4(c.pc)} perturbed #${n}`;
    const { rom, port } = check(p, c.pc, c.regs, what);
    if (c.pc === 0xb163) {
      assert.equal(/** @type {{x: number}} */ (port).x, rom.x, what);
    }
  }
});

test('$B242 arrival: sent off again, every fourth time $DD44', () => {
  const caps = capturePlay().filter((c) => c.pc === 0xb242);
  const r = rng(25);
  const p = pair();
  for (let n = 0; n < 300; n += 1) {
    const c = caps[n % caps.length];
    setRam(p, c.ram);
    const fp = (c.ram[0x1086] << 8) | c.ram[0x1087];
    const i = (fp - 0x1861) & 0xff;
    poke2(p, 0x1630 + 2 * i, c.ram[0x1b00 + 2 * i] + (r() % 7) - 3);
    poke2(p, 0x1631 + 2 * i, c.ram[0x1b01 + 2 * i] + (r() % 7) - 3);
    poke2(p, 0x112a, r() % 4 === 0 ? 0x55 : 0);
    poke2(p, 0x10f8, r() % 4 === 0 ? 0 : 1);
    poke2(p, (fp + 0x039f) & 0xffff, r());
    poke2(p, 0x1020, r() & 1);
    poke2(p, 0x1021, r() & 1);
    check(p, 0xb242, c.regs, `B242 arrival #${n}`);
  }
});

test('$B0D4 path commands $F0 / $FF / $FE / heading, slot 42 end', () => {
  const caps = capturePlay().filter((c) => c.pc === 0xb0d4);
  const r = rng(26);
  const p = pair();
  for (let n = 0; n < 300; n += 1) {
    const c = caps[n % caps.length];
    setRam(p, c.ram);
    // Move the work to slot i (as $B031 would), path in RAM at $1C80
    const i = n % 5 === 0 ? 42 : r() % 44;
    const fp = 0x1861 + i;
    poke2(p, 0x1086, fp >> 8);
    poke2(p, 0x1087, fp & 0xff);
    /** @param {number} a @param {number} v */
    const w16 = (a, v) => { poke2(p, a, v >> 8); poke2(p, a + 1, v); };
    w16(0x1084, 0x0e30 + 2 * i);
    w16(0x10a0, 0x1630 + 2 * i);
    w16(0x10a2, 0x1631 + 2 * i);
    w16(0x10a4, 0x1e30 + 2 * i);
    w16(0x10a6, 0x1e31 + 2 * i);
    w16(0x1088, 0x1920 + 2 * i);
    w16(0x108a, 0x1921 + 2 * i);
    w16(0x108c, 0x1800 + 2 * i);
    w16(0x1090, 0x1890 + i);
    w16(0x10ad, 0x18c0 + i);
    w16(0x10cb, 0x18f0 + i);
    w16(0x1099, 0x19e0 + i);
    w16(0x1092, 0x1980 + i);
    w16(0x108e, 0x1b00 + 2 * i);
    w16(0x1094, 0x1b01 + 2 * i);
    w16(0x1800 + 2 * i, 0x1c80);
    poke2(p, 0x1890 + i, r() & 0x1f);
    poke2(p, 0x18c0 + i, 0x20 + (r() & 0x1f));
    poke2(p, 0x1860 + i, 0x83);
    // headings (< $40, dat_AAFF), then a command
    for (let k = 0; k < 6; k += 1) poke2(p, 0x1c80 + k, r() & 0x3f);
    const cmd = [0xf0, 0xff, 0xfe, r() & 0x3f][n % 4];
    poke2(p, 0x1c81 + (r() % 3), cmd);
    poke2(p, 0x1c90, r() & 0x3f);
    check(p, 0xb0d4, c.regs, `B0D4 cmd $${cmd.toString(16)} #${n}`);
  }
});

test('$B385 formation attack timer, every range', () => {
  const r = rng(13);
  const p = pair();
  for (let n = 0; n < 300; n += 1) {
    for (let a = 0; a < 0x2000; a += 1) poke2(p, a, r());
    poke2(p, 0x10d6, n % 10 === 0 ? 1 : 0);
    poke2(p, 0x1128, n % 7 === 0 ? r() : 0x3f);
    poke2(p, 0x1129, r() % 0x24);
    for (let i = 0; i < 4; i += 1) poke2(p, 0x1036 + i, r() % 20);
    check(p, 0xb385, {}, `B385 #${n}`);
  }
});

test('task_formation_init waits one frame', () => {
  const p = pair();
  const r = rng(14);
  for (let a = 0; a < 0x2000; a += 1) poke2(p, a, r());
  check(p, 0xbf58, {}, 'BF58');
});

// ---------------------------------------------------- the four objects

test('objects: noise table for all 256 frame counter values', () => {
  const p = pair();
  for (let fc = 0; fc < 256; fc += 1) {
    poke2(p, 0x1016, fc);
    poke2(p, 0x111d, 1);
    check(p, 0xb936, { u: 0x0ee2, y: 0x111d }, `B936 fc=${fc}`);
  }
});

test('objects: launcher + state machines over 3000 frames', () => {
  const r = rng(15);
  for (let run = 0; run < 6; run += 1) {
    const p = pair();
    for (let a = 0x0e00; a < 0x2000; a += 1) poke2(p, a, r());
    for (let a = 0x111d; a <= 0x1120; a += 1) poke2(p, a, 0);
    poke2(p, 0x1122, 1);
    poke2(p, 0x1119, 4 + (r() % 8));
    poke2(p, 0x111a, 0);
    poke2(p, 0x111b, 1);
    poke2(p, 0x1123, 0);
    for (let f = 0; f < 500; f += 1) {
      if (f % 50 === 0) poke2(p, 0x1600, r()); // player_y
      check(p, 0xbb50, {}, `BB50 run ${run} frame ${f}`);
      check(p, 0xb90e, {}, `B90E run ${run} frame ${f}`);
      poke2(p, 0x1016, p.m.mem[0x1016] + 1);
    }
  }
});

test('objects: every state from random sprites', () => {
  const r = rng(16);
  const p = pair();
  for (let n = 0; n < 2000; n += 1) {
    const u = [0x0ee2, 0x0eec, 0x0ef6, 0x0f00][n % 4];
    const y = 0x111d + (n % 4);
    for (let k = 0; k < 10; k += 1) {
      poke2(p, u + k, r());
      poke2(p, u + 0x800 + k, r());
      poke2(p, u + 0x1000 + k, r());
    }
    poke2(p, 0x1016, r());
    poke2(p, 0x1600, r() & 1 ? p.m.mem[u + 0x800] + (r() % 5) - 2 : r());
    const st = 1 + (n % 14);
    poke2(p, y, st);
    // object_state_call with the state in A
    const a = n % 97 === 0 ? 0x80 : st;
    check(p, 0xb930, { a, u, y, x: 0xbb22 }, `state ${a} #${n}`);
  }
});

test('objects: a state byte of $80 leaves the loop (state 0)', () => {
  const p = pair();
  const r = rng(17);
  for (let a = 0x0e00; a < 0x2000; a += 1) poke2(p, a, r());
  poke2(p, 0x111d, 0);
  poke2(p, 0x111e, 0x80);
  poke2(p, 0x111f, 3);
  poke2(p, 0x1120, 2);
  check(p, 0xb90e, {}, 'B90E state $80');
});

// --------------------------------------------------- power-up effects

test('effects: $B3D1 with every handler over many frames', () => {
  const r = rng(18);
  for (let run = 0; run < 24; run += 1) {
    const p = pair();
    for (let a = 0; a < 0x2000; a += 1) poke2(p, a, r());
    const eff = run % 6;
    poke2(p, 0x10cf, 1);
    poke2(p, 0x1070, eff);
    // (effect 0 indexes dat_B653 with $10D0: keep it on the table, or
    // the picture-list copy runs wild through RAM, $1070 included)
    const d0 = eff === 0 ? r() % 0x18 : r();
    poke2(p, 0x10d0, run < 12 ? 0 : d0);
    poke2(p, 0x106b, 0x02);
    poke2(p, 0x106c, run < 12 ? 0x20 : r());
    poke2(p, 0x1069, 0x01);
    poke2(p, 0x106a, 0xd0 + (r() % 16));
    poke2(p, 0x1035, [0x1e, 0x2d, 5][run % 3]);
    poke2(p, 0x10d2, run & 1 ? 7 : 3);
    for (let f = 0; f < 700; f += 1) {
      check(p, 0xb3d1, {}, `B3D1 effect ${eff} run ${run} frame ${f}`);
      poke2(p, 0x1016, p.m.mem[0x1016] + 1);
      if (p.m.mem[0x10cf] === 0) break;
    }
  }
});

test('effects: $B3F2 every $10D0 value', () => {
  const r = rng(19);
  const p = pair();
  for (let v = 0; v < 256; v += 1) {
    for (let a = 0x0e80; a < 0x1f00; a += 1) poke2(p, a, r());
    poke2(p, 0x10d0, v);
    poke2(p, 0x1016, r());
    check(p, 0xb3f2, {}, `B3F2 $10D0=${v}`);
  }
});

test('effects: $B860 with each A and $B461 alone', () => {
  const r = rng(20);
  const p = pair();
  for (let n = 0; n < 60; n += 1) {
    for (let a = 0x0e00; a < 0x2000; a += 1) poke2(p, a, r());
    poke2(p, 0x1035, [0x1e, 0x2d, r()][n % 3]);
    poke2(p, 0x102d, n & 1);
    poke2(p, 0x10d2, n % 4 === 0 ? 7 : r());
    check(p, 0xb860, { a: [4, 6, 8, 10, r() & 0xfe][n % 5] }, `B860 #${n}`);
    poke2(p, 0x1016, r());
    check(p, 0xb461, {}, `B461 #${n}`);
  }
});

test('effects: $B5A1 picture lists and the $17 animation', () => {
  const r = rng(21);
  const p = pair();
  for (let n = 0; n < 200; n += 1) {
    for (let a = 0x0e80; a < 0x1f00; a += 1) poke2(p, a, r());
    poke2(p, 0x10d0, n % 0x18);
    poke2(p, 0x1016, n & 1 ? 2 : r());
    poke2(p, 0x0e93, r() % 3 === 0 ? 0x2f : r());
    poke2(p, 0x1069, 0x01);
    poke2(p, 0x106a, n % 5 === 0 ? 0xdf : r());
    check(p, 0xb5a1, {}, `B5A1 #${n}`);
  }
});

// -------------------------------------------------- challenging stage

test('challenging stage: $BB96 every step, both CWAI paths', () => {
  const r = rng(22);
  const p = pair();
  for (let n = 0; n < 600; n += 1) {
    for (let a = 0x0e00; a < 0x2000; a += 1) poke2(p, a, r());
    poke2(p, 0x115a, n % 5 === 0 ? r() : n % 0x1a);
    poke2(p, 0x1035, [2, 7, 12, 0x39, r() % 60][n % 5]);
    poke2(p, 0x115b, n % 4 === 0 ? 3 : r() % 3);
    poke2(p, 0x115c, r() % 6);
    poke2(p, 0x115d, r());
    for (let a = 0x113a; a <= 0x113e; a += 1) {
      poke2(p, a, n & 1 ? 1 : r());
    }
    check(p, 0xbb96, {}, `BB96 $115A=${p.board.mem[0x115a]} #${n}`);
  }
});

test('challenging stage: bonus objects $BCF3 over many frames', () => {
  const r = rng(23);
  for (let run = 0; run < 10; run += 1) {
    const p = pair();
    for (let a = 0x0e00; a < 0x2000; a += 1) poke2(p, a, r());
    for (let k = 0; k < 5; k += 1) {
      poke2(p, 0x1132 + k, run < 5 ? 1 : 1 + (r() % 4));
      poke2(p, 0x114a + 2 * k, r() & 0x81);
    }
    poke2(p, 0x1035, r() % 60);
    for (let f = 0; f < 300; f += 1) {
      // positions move as the path code would, statuses flip at random
      for (let k = 0; k < 5; k += 1) {
        if (r() % 16 === 0) poke2(p, 0x1860 + k, r());
        if (r() % 8 === 0) poke2(p, 0x0e30 + 0x800 + 2 * k, r());
        if (r() % 8 === 0) poke2(p, 0x0e31 + 0x800 + 2 * k, r());
        if (r() % 16 === 0) poke2(p, 0x0e31 + 0x1000 + 2 * k, r());
        if (p.m.mem[0x1132 + k] === 0 && r() % 30 === 0) {
          poke2(p, 0x1132 + k, 1);
        }
      }
      check(p, 0xbcf3, {}, `BCF3 run ${run} frame ${f}`);
      check(p, 0xbee5, {}, `BEE5 run ${run} frame ${f}`);
    }
  }
});

test('challenging stage: each bonus state handler, random sprites', () => {
  const r = rng(24);
  const p = pair();
  for (let n = 0; n < 1200; n += 1) {
    const k = n % 5;
    const x = 0x113a + k;
    const u = 0x0e30 + 2 * k;
    for (const a of [x, x - 8, x + 0x726, x + 0x8a6, u, u + 1, u + 0x800,
      u + 0x801, u + 0x1001, u + 0x31a, u + 0x31b, 0x1109, 0x110a,
      0x110b, 0x1162, 0x1035]) poke2(p, a, r());
    if (n % 4 === 1) poke2(p, u + 0x800, r() % 0xe0);
    const st = 1 + (n % 4);
    check(p, 0xbd18, { a: st, x, u, y: 0x1132 + k }, `BD18 st ${st} #${n}`);
  }
});

// ------------------------------------------------- port-only sanity

test('the port routines return nothing they should not', () => {
  const p = pair();
  const { out } = runPort(GP2_8_ROUTINES[0xb461], p.m);
  assert.equal(out, undefined);
  // $B163 returns X (the heading entry) for $B20D
  const r = runRom(p.board, 0xb163);
  const o = /** @type {{x: number}} */ (runPort(GP2_8_ROUTINES[0xb163],
    p.m).out);
  assert.equal(o.x, r.x);
});

// ----------------------------------------------- the timing checks bite

test('a wrong cycle count or a missing SYNC fails the comparison', () => {
  const caps = capturePlay().filter((c) => c.pc === 0xb014);
  const c = caps[caps.length - 1];
  const p = pair();
  setRam(p, c.ram);
  // one instruction charged a cycle too many: the stamps after it and
  // the total differ
  const charge = p.m.sub.charge.bind(p.m.sub);
  let calls = 0;
  p.m.sub.charge = (n) => { calls += 1; charge(calls === 5 ? n + 1 : n); };
  assert.throws(() => check(p, 0xb014, c.regs, 'sabotaged cycles'),
    /timed accesses|cycles/);
  // one SYNC dropped: the stamps differ
  const q = pair();
  setRam(q, c.ram);
  const rom = runRom(q.board, 0xb014, c.regs);
  const fn = GP2_8_ROUTINES[0xb014];
  const port = runPort(function* dropOne(m) {
    let n = 0;
    for (const v of fn(m)) {
      n += 1;
      if (n !== 3) yield v;
    }
  }, q.m);
  assert.notDeepEqual(port.times, rom.times);
  assert.equal(port.cycles, rom.cycles);
});

// Copyright 2026 by Moshix
/**
 * Per-machine bookkeeping for main CPU ROM gp2-2b.8b ($E000-$FFFF) where
 * the 6809 used time rather than RAM: the foreground cycle clock of the
 * boot code, and the yield marker for busy-waits on another CPU.
 *
 * CLOCK. The boot (reset_main, $E000) runs with the main IRQ off and burns
 * real time: RAM clears with a watchdog read per word, and delay_65536
 * ($BE25, 787,734 cycles = 31.08 frames) between I/O chip commands. The
 * port has to spend the same number of frames there, and every write must
 * land in the same frame as on the board (the lock-step compares RAM at
 * every vblank). So the foreground keeps a cycle clock `t`: main-CPU
 * cycles since the current port frame began (the port frame starts at
 * vblank, where the oracle's runFrame() stops). burn(m, n) advances it
 * and yields once for every frame boundary crossed. The rule for exact
 * placement: an instruction belongs to the frame in which it STARTS (the
 * oracle core runs whole instructions), so callers burn the cycles up to
 * the start of the instruction that writes, then write.
 *
 * The clock is meant to be shared by every busy foreground routine of the
 * main CPU (delay_65536 lives in gp2-4, main-A's module): see
 * docs/requests/main-E.md, which asks for it to move to a shared file.
 * Until then this is its only copy and delay_65536's port has to reach it
 * through MAIN.fg_burn (registered by gp2_2b.js).
 *
 * SPIN. The boot handshake ($E0D2/$E0DD) polls shared RAM that the sub
 * and sound CPUs' foregrounds write. Those loops `yield SPIN` so the
 * scheduler can resolve the wait within the frame (porting-guide 6.3).
 * scheduler.js (integration) does not exist yet; SPIN here is the
 * registered symbol Symbol.for('gaplus.SPIN') so that the scheduler's own
 * SPIN can be the very same value.
 *
 * @see docs/porting-guide.md section 6.3
 */

/*
 * The clock and SPIN now live in the shared src/game/clock.js
 * (docs/requests/main-E.md 1); re-exported here for existing importers.
 */
export { FRAME_CYCLES, SPIN, clockOf, setClock, burn } from '../clock.js';
import { frameDue } from '../scheduler.js';

/**
 * scheduler.js SYNC (a registered symbol): "charged up to here; what
 * follows may race with another CPU" -- yielded right before every
 * instruction that touches RAM the sub or sound CPU also uses.
 */
export const SYNC = Symbol.for('gaplus.sync');

/**
 * RAM another CPU accesses, [lo, hi) main-CPU addresses: what the sub CPU
 * read or wrote in 12,000 oracle frames (boot, attract, coin, a played
 * game with random input; its stack left out), plus the sound CPU's
 * request/active flags $6040-$607F. A main-CPU access there may race, so
 * ported code must `yield SYNC` at exactly the cycle its instruction starts.
 */
// (integration, round 3: + main_task $1030, which the sub CPU clears on
// a mode change -- seen at frame 6216 of attract, not in the 12,000
// frames this list was measured on. + $16D0-$1711, the Y/X of the
// shadow entries task_clear_parked_flags ($EA89) scans: the sub moves
// objects there too; an AI game caught main's read in the wrong slice,
// frame 55,176 of tools/ai-lockstep.mjs run 11.)
export const RACY = Object.freeze([
  [0x0800, 0x0802], [0x0849, 0x084f], [0x0850, 0x0852], [0x0870, 0x0872],
  [0x09b0, 0x09b2], [0x09b4, 0x09b5], [0x09f4, 0x09f5], [0x0e00, 0x0ea6],
  [0x0eaa, 0x0ed0], [0x0f1e, 0x0f22], [0x0f82, 0x0fd0], [0x100f, 0x1011],
  [0x1013, 0x1014], [0x1016, 0x101b], [0x101e, 0x1021], [0x102c, 0x102d],
  [0x102e, 0x1031], [0x1035, 0x1038], [0x103a, 0x1044], [0x104a, 0x104c],
  [0x1052, 0x105a], [0x1064, 0x1066], [0x1069, 0x106b], [0x106e, 0x1072],
  [0x107a, 0x107b], [0x1081, 0x10be], [0x10bf, 0x10c2], [0x10cb, 0x10d1],
  [0x10d6, 0x10dc], [0x10e9, 0x10ea], [0x10f8, 0x1100], [0x1103, 0x1104],
  [0x1109, 0x110c], [0x110f, 0x1112], [0x1114, 0x1115], [0x1116, 0x1121],
  [0x1122, 0x1123], [0x1128, 0x112f], [0x1132, 0x1137], [0x113a, 0x113f],
  [0x1142, 0x1147], [0x114a, 0x1160], [0x1162, 0x1165], [0x1176, 0x1177],
  [0x1600, 0x16a6], [0x16aa, 0x16d0], [0x16d0, 0x1712], [0x1712, 0x1714],
  [0x171e, 0x1722],
  [0x1782, 0x17d0], [0x1800, 0x1858], [0x1860, 0x188d], [0x1890, 0x18bc],
  [0x18c0, 0x18ec], [0x18f0, 0x191c], [0x1920, 0x1978], [0x1980, 0x19ac],
  [0x19e0, 0x1a0c], [0x1a10, 0x1a52], [0x1b00, 0x1b58], [0x1b60, 0x1b62],
  [0x1b70, 0x1b71], [0x1d80, 0x1d81], [0x1e00, 0x1ea6], [0x1ea7, 0x1ea8],
  [0x1ea9, 0x1ed0], [0x1ed1, 0x1ed2], [0x1ed3, 0x1ed4], [0x1ed5, 0x1ed6],
  [0x1ed7, 0x1ed8], [0x1ed9, 0x1eda], [0x1edb, 0x1edc], [0x1edd, 0x1ede],
  [0x1edf, 0x1ee0], [0x1ee1, 0x1ee2], [0x1f1e, 0x1f22], [0x1f82, 0x1fd0],
  [0x6040, 0x6080],
]);

/**
 * RAM another CPU uses -- or any access once the running chunk is past
 * the next vblank (integration, round 3: scheduler.js frameDue).
 * @param {number} a main-CPU address @returns {boolean}
 */
export const isRacy = (a) => RACY.some(([lo, hi]) => a >= lo && a < hi)
  || frameDue();

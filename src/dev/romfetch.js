// Copyright 2026 by Moshix
/**
 * Browser ROM loader for the page's ROM version (the original program on
 * the test oracle's emulated 6809s): fetches every chip of the
 * gaplus set from `roms/<name>`, checks size and CRC32, and lays the chips
 * out exactly as tools/romset.mjs does in Node (both use
 * src/dev/romlayout.js), giving the same {main, sub, sound, gfx1, ...}
 * images the oracle board takes.
 *
 * Nothing in the port needs this: the ported game reads its ROM data from
 * the generated src/game/romdata.js. It exists only so the page can run
 * the real ROM on the test oracle's 6809 cores next to the port.
 * roms/ is git-ignored and never shipped; if it is not being served, the
 * error says which files are missing and where to put them.
 */

import { CHIPS, verifyChip, layoutGaplus } from './romlayout.js';

/** @typedef {import('./romlayout.js').GaplusRoms} GaplusRoms */

/** Thrown when chips are missing or wrong; `missing` lists file names. */
export class RomFetchError extends Error {
  /** @param {string} message @param {string[]} missing */
  constructor(message, missing) {
    super(message);
    this.name = 'RomFetchError';
    /** Chips that could not be fetched (404, network error). */
    this.missing = missing;
  }
}

/**
 * @typedef {(url: string) => Promise<{ok: boolean, status: number,
 *   arrayBuffer: () => Promise<ArrayBuffer>}>} FetchLike
 */

/**
 * Fetch, verify and lay out the whole set.
 * @param {object} [opts]
 * @param {string} [opts.base] directory URL, with trailing slash (default 'roms/')
 * @param {FetchLike} [opts.fetch] injectable for tests (default globalThis.fetch)
 * @returns {Promise<GaplusRoms>}
 */
export async function fetchRoms(opts = {}) {
  const base = opts.base ?? 'roms/';
  const get = opts.fetch ?? /** @type {FetchLike} */ (globalThis.fetch.bind(globalThis));
  /** @type {string[]} */
  const missing = [];
  // All chips in parallel: twenty small files, a single round trip's wait.
  const results = await Promise.all(CHIPS.map(async (chip) => {
    const url = `${base}${chip.name}`;
    try {
      const res = await get(url);
      if (!res.ok) { missing.push(chip.name); return null; }
      const data = new Uint8Array(await res.arrayBuffer());
      return /** @type {[string, Uint8Array]} */ ([chip.name, data]);
    } catch {
      missing.push(chip.name);
      return null;
    }
  }));
  if (missing.length > 0) {
    missing.sort();
    throw new RomFetchError(
      `${missing.length} of ${CHIPS.length} ROM files not found under ${base}`
        + ` (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', ...' : ''})`,
      missing,
    );
  }
  /** @type {Map<string, Uint8Array>} */
  const chips = new Map();
  for (const entry of results) {
    if (entry === null) continue;
    const [name, data] = entry;
    const chip = /** @type {import('./romlayout.js').Chip} */ (CHIPS.find((c) => c.name === name));
    // Size and CRC32: a wrong set would run, just not as Gaplus rev. B.
    verifyChip(chip, data, `${base}${name}`);
    chips.set(name, data);
  }
  return layoutGaplus(chips);
}

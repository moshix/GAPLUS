// Copyright 2026 by Moshix
/**
 * Call a routine from generator (foreground) code without knowing whether
 * it is itself a generator. Routines that can wait (anywhere down their
 * call tree: a CWAI, a poll loop on a value only an interrupt changes) are
 * generators and must be delegated to with `yield*`; the rest are plain
 * functions. Code written in parallel by different people cannot always
 * know which one a routine in another module is, so foreground code calls
 * across modules as
 *
 *     const out = yield* call(MAIN.sub_C2FC, m, { a, x });
 *
 * and gets the callee's return value either way.
 *
 * @see docs/porting-guide.md section 6
 * @param {Function} fn
 * @param {...unknown} args
 * @returns {Generator<unknown, unknown, unknown>}
 */
export function* call(fn, ...args) {
  const r = fn(...args);
  if (r !== null && typeof r === 'object' && typeof r.next === 'function'
      && typeof r[Symbol.iterator] === 'function') {
    return yield* r;
  }
  return r;
}

/**
 * Is `v` a generator object (the result of calling a generator function)?
 * Schedulers use it to tell a handler that waits from one that ran to
 * completion.
 * @param {unknown} v
 * @returns {v is Generator<unknown, unknown, unknown>}
 */
export function isGenerator(v) {
  return v !== null && typeof v === 'object'
    && typeof (/** @type {{next?: unknown}} */ (v)).next === 'function'
    && typeof (/** @type {{[Symbol.iterator]?: unknown}} */ (v))[Symbol.iterator]
      === 'function';
}

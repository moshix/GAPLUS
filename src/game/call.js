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
  if (isGenerator(r)) return yield* r;
  return r;
}

/**
 * %GeneratorPrototype%: the object every generator object inherits from.
 * `function* () {}` is a GeneratorFunction; its `.prototype` is the
 * prototype of its generator objects, and that inherits from
 * %GeneratorPrototype% (ECMA-262 section 27.5). Only real generator
 * objects have it in their prototype chain.
 */
const GENERATOR_PROTOTYPE = Object.getPrototypeOf(
  Object.getPrototypeOf((function* probe() { /* never run */ })()));

/**
 * Is `v` a generator object (the result of calling a generator function)?
 * Decided by the prototype chain (GENERATOR_PROTOTYPE), never by shape.
 * Schedulers use it to tell a handler that waits from one that ran to
 * completion.
 * @param {unknown} v
 * @returns {v is Generator<unknown, unknown, unknown>}
 */
export function isGenerator(v) {
  // Explicit, not duck typing: a routine's return value that merely has
  // next() and [Symbol.iterator] (a Map iterator, a register block that
  // happens to carry such fields) is a value, not a routine that waits.
  return v !== null && typeof v === 'object'
    && Object.prototype.isPrototypeOf.call(GENERATOR_PROTOTYPE, v);
}

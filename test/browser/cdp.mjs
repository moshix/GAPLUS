// Copyright 2026 by Moshix
/**
 * The smallest useful Chrome DevTools Protocol client: Node's built-in
 * WebSocket (Node >= 22; global in 21 behind a flag), no dependencies.
 *
 * One connection to the *browser* endpoint; pages are driven through
 * flattened sessions (Target.attachToTarget {flatten: true}), so every
 * message carries a sessionId and one socket serves them all.
 *
 *   const chrome = await launchChrome({ userDataDir });
 *   const cdp = await Cdp.connect(chrome.wsUrl);
 *   const page = await cdp.newPage('about:blank');
 *   await page.send('Page.enable');
 *   page.on('Runtime.consoleAPICalled', (p) => ...);
 *   ...
 *   cdp.close(); chrome.kill();
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the owner's Chrome lives (docs/PLAN.md). */
export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * JSON as the protocol sends it.
 * @typedef {null | boolean | number | string | JsonValue[] | JsonObject} JsonValue
 * @typedef {{[key: string]: JsonValue}} JsonObject
 */

/**
 * @typedef {{method?: string, params?: Record<string, unknown>,
 *   id?: number, result?: Record<string, unknown>,
 *   error?: {message: string}, sessionId?: string}} CdpMessage
 */

/** A page (target) session on a {@link Cdp} connection. */
export class Session {
  /** @param {Cdp} cdp @param {string} sessionId @param {string} targetId */
  constructor(cdp, sessionId, targetId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  /**
   * @param {string} method @param {Record<string, unknown>} [params]
   * @returns {Promise<JsonObject>}
   */
  send(method, params = {}) { return this.cdp.send(method, params, this.sessionId); }

  /**
   * Listen for an event of this session.
   * @param {string} method @param {(params: JsonObject) => void} fn
   */
  on(method, fn) { this.cdp.listen(this.sessionId, method, fn); }

  /**
   * Evaluate an expression in the page and return its value.
   * @param {string} expression @returns {Promise<JsonValue>}
   */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`page eval failed: ${r.exceptionDetails.text} ${expression}`);
    }
    return r.result.value;
  }
}

export class Cdp {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    /** @type {Map<number, {resolve: (v: JsonObject) => void, reject: (e: Error) => void}>} */
    this.pending = new Map();
    /** @type {Map<string, Array<(params: JsonObject) => void>>} */
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => this.dispatch(JSON.parse(String(ev.data))));
  }

  /** @param {string} url browser WebSocket URL @returns {Promise<Cdp>} */
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)),
        { once: true });
    });
  }

  /** @param {CdpMessage} msg */
  dispatch(msg) {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result ?? {});
      return;
    }
    const key = `${msg.sessionId ?? ''}|${msg.method}`;
    for (const fn of this.listeners.get(key) ?? []) fn(msg.params ?? {});
  }

  /**
   * @param {string} method @param {Record<string, unknown>} [params]
   * @param {string} [sessionId]
   * @returns {Promise<JsonObject>}
   */
  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId;
    this.nextId += 1;
    const msg = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }

  /**
   * @param {string} sessionId @param {string} method
   * @param {(params: JsonObject) => void} fn
   */
  listen(sessionId, method, fn) {
    const key = `${sessionId}|${method}`;
    const list = this.listeners.get(key) ?? [];
    list.push(fn);
    this.listeners.set(key, list);
  }

  /** Open a new tab and attach to it. @param {string} url @returns {Promise<Session>} */
  async newPage(url) {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return new Session(this, sessionId, targetId);
  }

  close() { this.ws.close(); }
}

/**
 * Start headless Chrome on a scratch profile and wait for its DevTools
 * endpoint. `--remote-debugging-port=0` lets Chrome pick a free port; it
 * writes the port and the browser path to <profile>/DevToolsActivePort.
 * @param {{userDataDir: string, chrome?: string, timeoutMs?: number,
 *   args?: string[]}} opts  `args`: extra Chrome switches
 * @returns {Promise<{wsUrl: string, kill: () => void}>}
 */
export async function launchChrome(opts) {
  const bin = opts.chrome ?? CHROME;
  if (!existsSync(bin)) throw new Error(`Chrome not found at ${bin}`);
  const child = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${opts.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--mute-audio',
    '--window-size=900,1000',
    ...(opts.args ?? []),
    'about:blank',
  ], { stdio: 'ignore' });
  const kill = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
  const file = join(opts.userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + (opts.timeoutMs ?? 20000);
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, 'utf8').split('\n');
      if (port && path) return { wsUrl: `ws://127.0.0.1:${port}${path}`, kill };
    }
    if (child.exitCode !== null) throw new Error(`Chrome exited with ${child.exitCode}`);
    await new Promise((r) => { setTimeout(r, 50); });
  }
  kill();
  throw new Error('Chrome did not publish a DevTools port');
}

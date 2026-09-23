// Copyright 2026 by Moshix
/**
 * Browser smoke test: the page, in real headless Chrome, driven through the
 * DevTools protocol (test/browser/cdp.mjs; no puppeteer, no dependencies;
 * Node >= 22 for the built-in WebSocket).
 *
 *   1. `?engine=rom&frames=600`: the page runs 600 frames as fast as it
 *      can and stops. Wait for canvas.dataset.frame to reach 600, check the
 *      canvas is not blank, screenshot screenshots/browser-smoke.png.
 *   2. `index.html` with no engine named: the chooser must open with ROM
 *      preselected; move with the arrow keys, pick ROM with Enter
 *      (screenshots/browser-chooser.png), check the AI control is
 *      disabled and A does nothing on the ROM, then press 5 (coin) and 1
 *      (start), play ~10 s, check the frame counter kept pace with
 *      60.606 Hz, screenshot screenshots/browser-game.png.
 *      Sound: after coin + start the page must have sent the worklet
 *      register images with a voice at non-zero volume, and the worklet
 *      must report non-silent output samples.
 *   3. `?engine=port`: "port not ready yet" with a button to the ROM
 *      version (screenshots/browser-port.png); the AI control is enabled
 *      there; the button switches to the ROM and frames run.
 *   4. Layout at 480 px and 1280 px wide (screenshots/browser-480.png,
 *      browser-1280.png): the key legend is one line, nothing scrolls
 *      sideways, and "?" opens the full key list.
 *
 * Any console error, uncaught exception or failed load fails the test.
 *
 *   node test/browser/smoke.mjs        (npm run test:browser)
 *
 * Output lines stay within 79 columns.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { Cdp, launchChrome, CHROME } from './cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = join(ROOT, 'screenshots');

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Distinct RGB colours on the game canvas (a blank screen has 1). */
const COUNT_COLOURS = `(() => {
  const c = document.getElementById('screen');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const seen = new Set();
  for (let i = 0; i < d.length; i += 4) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  return seen.size;
})()`;

const FRAME = `Number(document.getElementById('screen').dataset.frame || 0)`;

/**
 * Keys as CDP wants them: code, key and the Windows virtual key code.
 * @type {Record<string, {code: string, key: string, windowsVirtualKeyCode: number}>}
 */
const KEYS = {
  coin: { code: 'Digit5', key: '5', windowsVirtualKeyCode: 53 },
  start: { code: 'Digit1', key: '1', windowsVirtualKeyCode: 49 },
  fire: { code: 'Space', key: ' ', windowsVirtualKeyCode: 32 },
  left: { code: 'ArrowLeft', key: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  up: { code: 'ArrowUp', key: 'ArrowUp', windowsVirtualKeyCode: 38 },
  down: { code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ai: { code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65 },
  help: { code: 'Slash', key: '?', windowsVirtualKeyCode: 191 },
  engine: { code: 'KeyE', key: 'e', windowsVirtualKeyCode: 69 },
  escape: { code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 },
};

/** Enter, with the text that makes Chrome activate a focused button. */
const ENTER = { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };

const CHOOSER_OPEN = `document.getElementById('chooser').open`;
const FOCUSED_ENGINE = `document.activeElement?.dataset?.engine ?? null`;
const AI_STATE = `({ disabled: document.getElementById('set-ai').disabled,
  title: document.getElementById('set-ai').title, on: globalThis.gaplus.aiEnabled })`;

/** @param {string} msg */
function fail(msg) {
  throw new Error(msg);
}

/**
 * Poll `expr` in the page until `ok(value)` or the timeout.
 * @param {import('./cdp.mjs').Session} page @param {string} expr
 * @param {(v: import('./cdp.mjs').JsonValue) => boolean} ok @param {number} timeoutMs @param {string} what
 */
async function waitFor(page, expr, ok, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.eval(expr);
    if (ok(last)) return last;
    await sleep(100);
  }
  return fail(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/**
 * Hold a key for `ms`, as a player would.
 * @param {import('./cdp.mjs').Session} page @param {keyof typeof KEYS} name
 * @param {number} [ms]
 */
async function press(page, name, ms = 150) {
  const k = KEYS[name];
  await page.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
  await sleep(ms);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

/**
 * Save a PNG screenshot of the page.
 * @param {import('./cdp.mjs').Session} page @param {string} name
 */
async function screenshot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  const file = join(SHOTS, name);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

/**
 * Wire up error collection for one page: console errors, uncaught
 * exceptions and failed loads (404s are "error" log entries).
 * @param {import('./cdp.mjs').Session} page @returns {string[]}
 */
function collectErrors(page) {
  /** @type {string[]} */
  const errors = [];
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'assert') {
      errors.push(`console.${p.type}: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
  });
  page.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    errors.push(`exception: ${d.exception?.description ?? d.text}`);
  });
  page.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') errors.push(`log: ${p.entry.text} ${p.entry.url ?? ''}`);
  });
  return errors;
}

/**
 * Open a tab on `url` with error collection on and a fixed viewport.
 * @param {Cdp} cdp @param {string} url
 * @param {{width?: number, height?: number}} [size]
 */
async function openPage(cdp, url, size = {}) {
  const page = await cdp.newPage('about:blank');
  const errors = collectErrors(page);
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: size.width ?? 760, height: size.height ?? 900, deviceScaleFactor: 1, mobile: false,
  });
  await page.send('Page.navigate', { url });
  return { page, errors };
}

/** @param {string} label @param {string[]} errors */
function assertNoErrors(label, errors) {
  if (errors.length > 0) fail(`${label}: page errors:\n  ${errors.join('\n  ')}`);
}

async function main() {
  if (!existsSync(CHROME)) {
    console.log(`SKIP: Chrome not found at\n  ${CHROME}`);
    return;
  }
  mkdirSync(SHOTS, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'gaplus-chrome-'));
  const server = await startServer(ROOT);
  const chrome = await launchChrome({ userDataDir: profile });
  const cdp = await Cdp.connect(chrome.wsUrl);
  let ok = false;
  try {
    // ---------------------------------------------- 1. ?frames=600
    {
      const t0 = Date.now();
      const { page, errors } = await openPage(cdp,
        `${server.url}index.html?engine=rom&frames=600`);
      await waitFor(page, FRAME, (v) => v >= 600, 120000, 'frame 600');
      await sleep(300);
      const engine = await page.eval(`document.getElementById('screen').dataset.engine`);
      const colours = await page.eval(COUNT_COLOURS);
      const file = await screenshot(page, 'browser-smoke.png');
      console.log(`fast run: 600 frames in ${Date.now() - t0} ms, engine ${engine},`);
      console.log(`  ${colours} colours on screen -> ${file.slice(ROOT.length + 1)}`);
      assertNoErrors('?frames=600', errors);
      if (colours < 4) fail(`?frames=600: canvas looks blank (${colours} colours)`);
      await cdp.send('Target.closeTarget', { targetId: page.targetId });
    }

    // ------------------------- 2. the chooser, then ROM at normal speed
    {
      const { page, errors } = await openPage(cdp, `${server.url}index.html`);
      await waitFor(page, CHOOSER_OPEN, (v) => v === true, 10000, 'the chooser');
      const first = await page.eval(FOCUSED_ENGINE);
      if (first !== 'rom') fail(`chooser: ${first} preselected, expected rom`);
      await press(page, 'down', 50);
      const second = await page.eval(FOCUSED_ENGINE);
      if (second !== 'port') fail(`chooser: down arrow gave ${second}`);
      await screenshot(page, 'browser-chooser.png');
      await press(page, 'up', 50);
      if ((await page.eval(FOCUSED_ENGINE)) !== 'rom') fail('chooser: up arrow');
      // No frames may run while the chooser is up.
      if ((await page.eval(FRAME)) !== 0) fail('frames ran behind the chooser');
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
      await waitFor(page, CHOOSER_OPEN, (v) => v === false, 5000, 'chooser to close');
      // The engine loads (fetches the ROMs) after the pick.
      const engine = await waitFor(page, `document.getElementById('screen').dataset.engine`,
        (v) => v !== undefined, 10000, 'the engine');
      if (engine !== 'rom') fail(`chooser: picked rom, running ${engine}`);
      const stored = await page.eval(`localStorage.getItem('gaplus.engine.v1')`);
      console.log(`chooser: opened on ${first}, arrows ok, Enter -> ${engine}`
        + ` (stored ${stored})`);
      // Let it boot: the ROM's self-test and attract take a few seconds.
      // (A coin during the boot is wiped by the ROM's FRESET pulse.)
      await waitFor(page, FRAME, (v) => v >= 300, 30000, 'frame 300');
      // The AI is JavaScript-only: disabled on the ROM, and A does nothing.
      await press(page, 'ai', 50);
      const ai = await page.eval(AI_STATE);
      if (!ai.disabled || ai.on) fail(`ROM mode: AI control ${JSON.stringify(ai)}`);
      console.log(`ROM mode: AI control disabled ("${ai.title}"), A ignored`);
      await press(page, 'coin');
      await sleep(700);
      await press(page, 'start');
      const f0 = await page.eval(FRAME);
      const t0 = Date.now();
      // Play a little: move and shoot, so the screenshot shows a game.
      for (let i = 0; i < 10; i += 1) {
        await press(page, i % 3 === 0 ? 'left' : 'fire', 250);
        await sleep(750);
      }
      const frames = (await page.eval(FRAME)) - f0;
      const secs = (Date.now() - t0) / 1000;
      const colours = await page.eval(COUNT_COLOURS);
      const file = await screenshot(page, 'browser-game.png');
      // Sound: the coin chime and the start music must reach the speakers.
      const snd = /** @type {{ready: boolean, sent: {frames: number, audible: number},
        out: {samples: number, nonZero: number, peak: number} | null}} */ (
        await page.eval(`(async () => ({ ready: gaplus.sound.ready,
          sent: gaplus.sound.sent, out: await gaplus.sound.stats() }))()`));
      console.log(`played: ${frames} frames in ${secs.toFixed(1)} s`
        + ` = ${(frames / secs).toFixed(1)} fps`);
      const out = snd.out;
      console.log(`sound: ${snd.sent.audible}/${snd.sent.frames} images audible,`
        + ` worklet ${out ? `${out.nonZero}/${out.samples} samples,`
          + ` peak ${out.peak.toFixed(2)}` : 'missing'}`);
      if (!snd.ready) fail('sound: the audio engine never started');
      if (snd.sent.audible === 0) fail('sound: only silent register images sent');
      if (out === null) fail('sound: no AudioWorklet (main-thread fallback)');
      else if (out.nonZero === 0 || out.peak < 0.01) fail('sound: worklet output is silent');
      console.log(`  ${colours} colours on screen -> ${file.slice(ROOT.length + 1)}`);
      assertNoErrors('normal run', errors);
      if (colours < 4) fail(`normal run: canvas looks blank (${colours} colours)`);
      // The clock is 60.606 Hz; headless Chrome's rAF is close to 60.
      if (frames / secs < 45) fail(`normal run: only ${(frames / secs).toFixed(1)} fps`);
      // E brings the chooser back over the game, which freezes; Escape
      // closes it and the same game carries on.
      await press(page, 'engine', 50);
      await waitFor(page, CHOOSER_OPEN, (v) => v === true, 5000, 'chooser on E');
      const held = await page.eval(FRAME);
      await sleep(500);
      if ((await page.eval(FRAME)) !== held) fail('game ran behind the chooser');
      await press(page, 'escape', 50);
      await waitFor(page, CHOOSER_OPEN, (v) => v === false, 5000, 'chooser to close');
      await waitFor(page, FRAME, (v) => v > held + 20, 5000, 'game to resume');
      console.log('E: chooser over the game (frozen), Escape resumes');
      assertNoErrors('chooser again', errors);
      await cdp.send('Target.closeTarget', { targetId: page.targetId });
    }

    // --------------------------------- 3. the port: not ready yet, for now
    {
      const { page, errors } = await openPage(cdp, `${server.url}index.html?engine=port`);
      const STATUS = `(() => { const s = document.getElementById('status');
        const b = document.getElementById('statusaction');
        return { shown: !s.hidden, text: s.textContent.trim(),
          button: b.hidden ? '' : b.textContent }; })()`;
      const status = await waitFor(page, STATUS,
        (v) => v.shown && /not ready/.test(v.text), 10000, 'port status');
      if (status.button === '') fail('port: no button to the ROM version');
      await press(page, 'ai', 50);
      const ai = await page.eval(AI_STATE);
      if (ai.disabled || !ai.on) fail(`port mode: AI control ${JSON.stringify(ai)}`);
      await screenshot(page, 'browser-port.png');
      console.log(`port: "${status.text.split('\n')[0].slice(0, 40)}",`
        + ` AI toggles on`);
      await page.eval(`document.getElementById('statusaction').click()`);
      await waitFor(page, FRAME, (v) => v >= 60, 30000, 'ROM frames after switch');
      const after = await page.eval(AI_STATE);
      if (!after.disabled || after.on) fail('switched to ROM: AI still enabled');
      console.log('port -> "play the ROM version": ROM running, AI off');
      assertNoErrors('port run', errors);
      await cdp.send('Target.closeTarget', { targetId: page.targetId });
    }

    // ------------------------------------- 4. layout, narrow and wide
    for (const width of [480, 1280]) {
      const { page, errors } = await openPage(cdp,
        `${server.url}index.html?engine=rom&frames=300`, { width, height: 900 });
      await waitFor(page, FRAME, (v) => v >= 300, 60000, `frame 300 at ${width}px`);
      const LAYOUT = `(() => { const h = document.getElementById('hint');
        const line = parseFloat(getComputedStyle(h).lineHeight) || 18;
        return { hintH: h.getBoundingClientRect().height, line,
          hintOverflow: h.scrollWidth > h.clientWidth + 1,
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          text: h.textContent.replace(/\\s+/g, ' ').trim() }; })()`;
      const lay = await page.eval(LAYOUT);
      if (lay.hintH > lay.line * 1.6) fail(`${width}px: legend wraps (${lay.hintH}px)`);
      if (lay.hintOverflow || lay.pageOverflow) fail(`${width}px: horizontal overflow`);
      await press(page, 'help', 50);
      const help = await page.eval(`!document.getElementById('help').hidden`);
      if (!help) fail(`${width}px: "?" did not open the help`);
      await screenshot(page, `browser-${width}.png`);
      console.log(`${width}px: legend one line "${lay.text}", help opens`);
      assertNoErrors(`layout ${width}px`, errors);
      await cdp.send('Target.closeTarget', { targetId: page.targetId });
    }
    ok = true;
  } finally {
    cdp.close();
    chrome.kill();
    await server.close();
    await sleep(200);
    rmSync(profile, { recursive: true, force: true });
  }
  if (ok) console.log('browser smoke test: PASS');
}

main().catch((err) => {
  console.error(`browser smoke test: FAIL\n${err.message}`);
  process.exitCode = 1;
});

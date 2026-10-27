#!/usr/bin/env node
// One press to a real match (plan PR 5's acceptance: JUGAR AHORA, one press, a match within 15 s),
// measured in a headless Chrome or Edge on a fresh profile at 1366 x 768 with a fine pointer, as
// ui-fit runs a PC. A local measurement, not a CI job: it needs the local Worker and a dev server
// that proxies to it.
//
//   npm run dev:api        (wrangler dev, the Worker on 8787)
//   npm run dev            (Vite on 5173: /api, /ws, /room, /lobby go to the Worker)
//   node scripts/play-timing.mjs [--port 5173 | --url http://localhost:5173/] [--net server] [--first]
//
// Two clocks, printed apart:
//   boot→menus   navigation start to the hero focused with the loading screen gone (it takes the
//                keys while up): the build's, the device's and the network's; reported, never
//                failed;
//   press→match  the one Enter on the hero to the session in a match (`inMatch`): failed above
//                --limit ms (15000).
// A returning player is seeded before the page loads (turbogol.howPlay.v1 = 'kbm', so "How will
// you play?" stays away); --net server also seeds the Casual queue on the server path (bots fill an
// empty match there after 10 s; the default P2P path waits 15 s for a room before it moves a lone
// player to the server, so it takes longer: printed, as information). --first seeds nothing: the
// first press must bring the question, and a second Enter (MOUSE AND KEYBOARD, focused) the search;
// press→match counts from the first. No other key is ever sent: exit 1 when the match did not
// start, or took longer than the limit.
//   options: --browser <path> (or UI_FIT_BROWSER), --limit <ms>, --timeout <ms> (60000), --json <file>
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Page, findBrowser, freePort, sleep, waitHttp } from './cdp.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
}
const URL_ = typeof args.url === 'string' ? args.url : `http://localhost:${typeof args.port === 'string' ? args.port : '5173'}/`;
const NET = args.net === 'server' ? 'server' : 'p2p';
const FIRST = args.first === true;
const LIMIT = typeof args.limit === 'string' ? Number(args.limit) : 15_000;
const TIMEOUT = typeof args.timeout === 'string' ? Number(args.timeout) : 60_000;
const POINTER = 'primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2';

let browser = null;
let page = null;
let failed = false;
const profile = mkdtempSync(join(tmpdir(), 'tg-play-timing-'));
const result = { url: URL_, net: NET, first: FIRST, limitMs: LIMIT };

/** Enter on the focused control: `text` makes Chrome fire the keypress that clicks a focused <button>. */
async function enter() {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

try {
  if (!(await waitHttp(URL_, 10_000))) throw new Error(`nothing answers at ${URL_} (npm run dev, and npm run dev:api for the Worker)`);
  const cdpPort = await freePort();
  browser = spawn(findBrowser(args.browser), ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, `--blink-settings=${POINTER}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
  if (!(await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`, 30_000))) throw new Error('the browser did not start');
  const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  page = new Page(ws);
  page.targetId = target.id;
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.bringToFront');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
  // What a returning player has stored (the language stays the browser's).
  const seed = {};
  if (!FIRST) seed['turbogol.howPlay.v1'] = 'kbm';
  if (NET === 'server') seed['turbogol.menu.v1'] = JSON.stringify({ region: null, casualModes: ['2v2'], rankedModes: ['2v2'], net: 'server', leaderboardPlaylist: '2v2', lastQueue: 'casual' });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { for (const [k, v] of Object.entries(${JSON.stringify(seed)})) localStorage.setItem(k, v); } catch {}` });
  await page.send('Page.navigate', { url: URL_ });
  if (!(await page.until('window.__game && window.__game.menu.visible && document.activeElement?.dataset?.key === "hero" && document.querySelector("#overlay.ld-on") === null', 90_000, 50))) throw new Error('the menus never came up with the hero focused');
  result.bootToMenusMs = Math.round(await page.eval('performance.now()'));
  result.hero = await page.eval(`document.querySelector('.mn-hero-main')?.getAttribute('aria-label') ?? null`);
  // The press, timed in the page (its clock: performance.now()).
  await page.eval(`(window.__pressAt = -1, window.addEventListener('keydown', (e) => { if (e.key === 'Enter' && window.__pressAt < 0) window.__pressAt = performance.now(); }, true), true)`);
  await enter();
  let presses = 1;
  if (FIRST) {
    if (!(await page.until(`document.querySelector('.mn-sheet') !== null`, 3_000, 50))) throw new Error('--first: no "How will you play?" sheet after the first press');
    result.sheet = await page.eval(`document.querySelector('.mn-sheet')?.getAttribute('aria-label')`);
    // The sheet's first focus lands on the next frame (a slow one in a headless page).
    if (!(await page.until(`document.activeElement?.closest('.mn-sheet') != null`, 5_000, 50))) throw new Error('--first: nothing in the sheet took the focus');
    result.sheetFocus = await page.eval(`document.activeElement?.textContent ?? null`);
    await enter(); // MOUSE AND KEYBOARD
    presses++;
  }
  const end = Date.now() + TIMEOUT;
  let state = null;
  while (Date.now() < end) {
    state = await page.eval(`(() => { const s = window.__game.session; return { inMatch: s?.inMatch === true, kind: s?.kind ?? null, searching: window.__game.menu.host.searchView().active, now: performance.now() }; })()`);
    if (state.inMatch) break;
    await sleep(100);
  }
  const pressAt = await page.eval('window.__pressAt');
  result.presses = presses;
  result.kind = state?.kind ?? null;
  if (state === null || !state.inMatch) {
    failed = true;
    result.pressToMatchMs = null;
    console.log(`play-timing: no match within ${TIMEOUT} ms of the press (searching: ${state?.searching})`);
  } else {
    result.pressToMatchMs = Math.round(state.now - pressAt);
    if (result.pressToMatchMs > LIMIT) failed = true;
  }
  console.log(`play-timing ${NET}${FIRST ? ' (first time)' : ''}: boot→menus ${(result.bootToMenusMs / 1000).toFixed(1)} s (reported) · press→match ${result.pressToMatchMs === null ? '—' : (result.pressToMatchMs / 1000).toFixed(1) + ' s'} (limit ${(LIMIT / 1000).toFixed(0)} s) · ${presses} press${presses > 1 ? 'es' : ''} · session ${result.kind} · hero "${result.hero}"${FIRST ? ` · sheet "${result.sheet}", focus on "${result.sheetFocus}"` : ''} · ${failed ? 'FAIL' : 'ok'}`);
} catch (e) {
  failed = true;
  result.error = e instanceof Error ? e.message : String(e);
  console.error('play-timing: ' + result.error);
} finally {
  if (typeof args.json === 'string') writeFileSync(args.json, JSON.stringify(result, null, 2));
  try {
    await Promise.race([page?.send('Browser.close'), sleep(1500)]);
  } catch {
    /* gone */
  }
  try {
    browser?.kill();
  } catch {
    /* gone */
  }
  // Windows: Edge re-parents its browser process; take every process of this run's own profile.
  if (process.platform === 'win32' && browser !== null) {
    spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
    const leaf = profile.split(/[\\/]/).pop();
    spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${leaf}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
  }
  setTimeout(() => {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* still locked */
    }
    process.exit(failed ? 1 : 0);
  }, 700);
}

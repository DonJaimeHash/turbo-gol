#!/usr/bin/env node
// The layout check of the Tablero plan (§2.6): every menu screen, at the sizes that matter, with the
// wide fallback text (#widetext: plain Arial, about Roboto's width), in a headless Chrome or Edge
// driven over the DevTools protocol (Node's own WebSocket, no dependency). For each size it loads
// the game once (#ui=home), opens each screen and asks the page's window.__uiFit() (src/ui/fit.ts):
// the shell's bars overflowing, data-fit boxes still overflowing at their minimum, a horizontal
// scroll, focus rings a clipping box would cut. The stage scrolling is reported, not failed (the
// old screens scroll until their PR rebuilds them; plan PR 5 on).
//
//   VITE_UI_FIT=1 npm run build:client && node scripts/ui-fit.mjs        (vite preview, a free port)
//   node scripts/ui-fit.mjs --url http://localhost:5173/                 (a dev server: __uiFit is on)
//   options: --browser <path> (or UI_FIT_BROWSER), --port <preview port>, --sizes 780x360,960x540,
//            --screens home,training, --json <file>, --no-widetext
// Exit 1 when the shell overflows anywhere (CI's ui-fit job runs it as information until plan PR 6).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
}

const SIZES = [
  { name: '780x360', w: 780, h: 360, mobile: true },
  { name: '844x390', w: 844, h: 390, mobile: true },
  { name: '960x540-tv', w: 960, h: 540, tv: true },
  { name: '1366x768', w: 1366, h: 768 },
  { name: '390x844', w: 390, h: 844, mobile: true },
].filter((s) => typeof args.sizes !== 'string' || args.sizes.split(',').some((x) => s.name.startsWith(x)));
const SCREENS = typeof args.screens === 'string' ? args.screens.split(',') : ['home', 'play', 'casual', 'ranked', 'friendly', 'custom', 'training', 'garage', 'leaderboard', 'profile'];
const WIDETEXT = args['no-widetext'] !== true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const env = typeof args.browser === 'string' ? args.browser : process.env.UI_FIT_BROWSER;
  if (env) return env;
  const candidates =
    process.platform === 'win32'
      ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('no Chrome / Edge found: pass --browser <path> or set UI_FIT_BROWSER');
  return hit;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitHttp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

/** One CDP page session. */
class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }
  async until(expression, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await this.eval(`!!(${expression})`)) return true;
      } catch {
        /* navigating */
      }
      await sleep(300);
    }
    return false;
  }
}

let preview = null;
let browser = null;
let page = null;
const profile = mkdtempSync(join(tmpdir(), 'tg-ui-fit-'));
const cleanup = async () => {
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
  try {
    preview?.kill();
  } catch {
    /* gone */
  }
  setTimeout(() => {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* still locked */
    }
  }, 500);
};

let failures = 0;
const report = [];
try {
  let base = typeof args.url === 'string' ? args.url : null;
  if (base === null) {
    const port = typeof args.port === 'string' ? Number(args.port) : await freePort();
    preview = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    let exited = false;
    preview.on('exit', () => (exited = true));
    base = `http://127.0.0.1:${port}/`;
    // A server already on that port answers too: vite preview must be the one that is up.
    if (!(await waitHttp(base, 30_000)) || exited) throw new Error(`vite preview did not start on ${port} (build first: VITE_UI_FIT=1 npm run build:client; is the port taken?)`);
  }
  const cdpPort = await freePort();
  browser = spawn(findBrowser(), ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
  if (!(await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`, 30_000))) throw new Error('the browser did not start');
  const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  page = new Page(ws);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  for (const size of SIZES) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: size.mobile === true });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: size.mobile === true, maxTouchPoints: size.mobile ? 5 : 1 });
    const flags = ['ui=home', WIDETEXT ? 'widetext' : '', size.tv ? 'tv' : ''].filter(Boolean).join('&');
    await page.send('Page.navigate', { url: 'about:blank' });
    await page.send('Page.navigate', { url: `${base}#${flags}` });
    if (!(await page.until('window.__game && window.__game.menu.visible && typeof window.__uiFit === "function"', 90_000))) {
      console.log(`${size.name}: the menus never came up (no __uiFit: a build without VITE_UI_FIT=1?)`);
      failures++;
      continue;
    }
    await page.eval('document.fonts.ready.then(() => true)');
    for (const screen of SCREENS) {
      await page.eval(`(__game.menu.open(${JSON.stringify(screen)}, true), true)`);
      await sleep(400); // a mount, its fit on the next frame, a screen's own first render
      const r = await page.eval('window.__uiFit()');
      const bad = [...r.shellOverflow.map((x) => 'shell: ' + x), ...r.fitOverflow.map((x) => 'fit: ' + x), ...(r.hScroll ? ['horizontal scroll'] : []), ...r.clippedFocus.map((x) => 'ring cut: ' + x)];
      failures += bad.length;
      report.push({ size: size.name, ...r, bad });
      console.log(`${size.name.padEnd(11)} ${screen.padEnd(12)} ${bad.length === 0 ? 'ok' : 'FAIL'}${r.stageScroll ? '  (stage scrolls)' : ''}  nodes ${r.nodes}${bad.length ? '\n    ' + bad.join('\n    ') : ''}`);
    }
  }
  if (typeof args.json === 'string') writeFileSync(args.json, JSON.stringify(report, null, 2));
  console.log(failures === 0 ? 'ui-fit: no overflow' : `ui-fit: ${failures} problem(s)`);
} catch (e) {
  console.error('ui-fit: ' + (e instanceof Error ? e.message : String(e)));
  failures++;
} finally {
  await cleanup();
}
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 700);

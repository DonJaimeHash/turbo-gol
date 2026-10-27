#!/usr/bin/env node
// The layout check of the Tablero plan (§2.6): every menu screen, at the sizes that matter (the two
// phones held sideways, the TV at 960 and 1366, a PC at 1366 x 768, 1920 x 1080 and 1366 x 600, an
// upright phone and a tablet), with the wide fallback text (#widetext: plain Arial, about Roboto's
// width), in both languages (Spanish is the longer) and with the hints of every input, in a
// headless Chrome or Edge driven over the DevTools protocol (scripts/cdp.mjs). For each size and
// language it loads the game once (#ui=home), opens each screen and asks the page's
// window.__uiFit() (src/ui/fit.ts): the shell's bars overflowing, data-fit boxes still
// overflowing at their minimum, a horizontal scroll,
// focus rings a clipping box or the screen's edge would cut, text of the shell and of Inicio under
// the class's minimum (14 px on a phone, 16 on a TV at its reference view). Then it switches the
// last input (the hint bar's verbs, the strip's ‹ › / L R / Q E: data-input on <html>, tg-touch for
// a finger) and checks the screens that change the shell again. The stage scrolling is reported,
// not failed (the old screens scroll until their PR rebuilds them), but on Inicio, which fails it
// but upright (360 x 640 may scroll there); a label that took its text under that minimum for the
// wide text is reported too (allowed down to its own minimum: the rail's 12, a tile's).
//
// Inicio (plan PR 5) runs every hero state (play, search, offline, lobby, update and the dormant
// rejoin: window.__homeHero, sample data), ✕ CANCEL focused while searching, and on a TV the play
// state with a controller too; each also fails a title on more lines than it may take, text out of
// its tile or under ✕, and prints the hero's title as fitted. Last on a TV, with no controller
// (headless has none): the hero says it needs one, its press opens the sheet, and a controller that
// connects with A held closes the sheet without starting anything (plan PR 5 acceptance): its event
// first, then (CONTINUE ANYWAY focused) the game's frame first, which reads the press before any
// event or tick.
//
// Each size gets a fresh tab with the device it stands for: a mouse for the desktop sizes (the
// browser starts with a fine pointer and hover, --blink-settings: a Linux runner has no pointing
// device, and a page without one lays out as a TV, device.ts isTv), touch emulation for the phones
// (never turned off in a tab: that restores the machine's own pointer), #tv for the TVs; a page
// laid out as another class than its size's fails. Each line says the face the bars' text got
// (the fallback for Arial differs: Liberation Sans or DejaVu Sans on Linux), and __uiFit runs the
// fit a screen's mount queued for the next frame before it reports (that frame can come after the
// pause: a slow headless frame of the stadium, a tab in the background).
//
//   VITE_UI_FIT=1 npm run build:client && node scripts/ui-fit.mjs        (vite preview, a free port)
//   node scripts/ui-fit.mjs --url http://localhost:5173/                 (a dev server: __uiFit is on)
//   options: --browser <path> (or UI_FIT_BROWSER), --port <preview port>, --sizes 780x360,960x540,
//            --screens home,training, --json <file>, --no-widetext,
//            --langs en,es     the languages (default both: the page's own turbogol.lang),
//            --inputs <list>   the hint sets after the device's own (default all: keyboard, pad,
//                              remote, mouse, touch; 'default' for the device's own only),
//            --face <family>   #widetext in that face instead of Arial: a fallback wider than Arial
//                              (Verdana on Windows / macOS, 'DejaVu Sans' on Linux) must fit too,
//            --online          the region pill as a server that answers shows it (a region, the
//                              players), not 'Offline · RETRY' (no API server here),
//            --long-name       the account chip signed in, a 16-character name and a rank,
//            --no-pointer      start the browser without a pointing device (a Linux runner without
//                              the pin: the desktop sizes then fail as TVs)
// Exit 1 when the shell overflows anywhere, or Inicio fails a check (CI's ui-fit job runs it as
// information until plan PR 6).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Page, findBrowser, freePort, sleep, waitHttp } from './cdp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
}

// `layout`: the class the shell must take there (device.ts layoutClass). A TV at 1366 x 768 is a
// common panel: the TV scale (by width, 1.42 there) with the fallback text.
const SIZES = [
  { name: '780x360', w: 780, h: 360, mobile: true, layout: 'phone' },
  { name: '844x390', w: 844, h: 390, mobile: true, layout: 'phone' },
  { name: '960x540-tv', w: 960, h: 540, tv: true, layout: 'tv' },
  { name: '1366x768', w: 1366, h: 768, layout: 'pc' },
  { name: '1366x768-tv', w: 1366, h: 768, tv: true, layout: 'tv' },
  { name: '390x844', w: 390, h: 844, mobile: true, layout: 'portrait' },
  { name: '1920x1080', w: 1920, h: 1080, layout: 'pc' },
  { name: '1366x600', w: 1366, h: 600, layout: 'short' },
  { name: '820x1180', w: 820, h: 1180, mobile: true, layout: 'tablet' },
].filter((s) => typeof args.sizes !== 'string' || args.sizes.split(',').some((x) => s.name.startsWith(x)));
const SCREENS = typeof args.screens === 'string' ? args.screens.split(',') : ['home', 'casual', 'ranked', 'friendly', 'custom', 'training', 'garage', 'leaderboard', 'profile'];
// Inicio's hero states (window.__homeHero), in the order of their priority.
const HERO_KINDS = ['play', 'search', 'offline', 'lobby', 'update', 'rejoin'];
// The TV's controller message (tv.needPad), per language.
const NEED_PAD = { en: 'YOU NEED A CONTROLLER', es: 'NECESITAS UN CONTROL' };
const NEED_PAD_GO = { en: 'CONTINUE ANYWAY', es: 'SEGUIR IGUAL' };
// After the device's own input, the others on the screens that change the shell: section roots,
// stacked screens (‹ and the crumbs, no strip), the ones with tabs of their own (Q / E step those).
const INPUT_SCREENS = ['home', 'casual', 'custom', 'training', 'leaderboard', 'profile'].filter((x) => SCREENS.includes(x));
const LANGS = typeof args.langs === 'string' ? args.langs.split(',') : ['en', 'es'];
const ALL_INPUTS = ['keyboard', 'pad', 'remote', 'mouse', 'touch'];
const INPUTS = args.inputs === 'default' ? [] : typeof args.inputs === 'string' ? args.inputs.split(',').filter((x) => ALL_INPUTS.includes(x)) : ALL_INPUTS;
const ONLINE = args.online === true;
const LONG_NAME = args['long-name'] === true;
const WIDETEXT = args['no-widetext'] !== true;
const FACE = typeof args.face === 'string' ? args.face.replace(/['"\\]/g, '') : null;
// The pointer the browser starts with (Blink's PointerType / HoverType: 4 fine, 1 none; 2 hover, 1 none).
const POINTER = args['no-pointer'] === true ? 'primaryPointerType=1,availablePointerTypes=1,primaryHoverType=1,availableHoverTypes=1' : 'primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2';
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
  browser = spawn(findBrowser(args.browser), ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, `--blink-settings=${POINTER}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
  if (!(await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`, 30_000))) throw new Error('the browser did not start');
  /** A fresh tab: its own emulation, nothing carried from the size before. */
  const openPage = async () => {
    const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const p = new Page(ws);
    p.targetId = target.id;
    await p.send('Page.enable');
    await p.send('Runtime.enable');
    await p.send('DOM.enable');
    await p.send('CSS.enable');
    // In front and focused: a background tab runs no animation frame (the fit waits for one), and
    // a browser may open its own tabs over it (a welcome page, an extension's).
    await p.send('Page.bringToFront');
    await p.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return p;
  };
  for (const size of SIZES) for (const lang of LANGS) {
    if (page !== null) {
      const old = page;
      await fetch(`http://127.0.0.1:${cdpPort}/json/close/${old.targetId}`).catch(() => undefined);
      old.ws.close();
    }
    page = await openPage();
    await page.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: size.mobile === true });
    if (size.mobile === true) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    // The language the page reads as it starts (src/i18n.ts turbogol.lang), and the wide text in
    // another face (a fallback wider than Arial): over style.css's html.tg-widetext.
    const pre = [`try { localStorage.setItem('turbogol.lang', ${JSON.stringify(lang)}); } catch {}`];
    if (FACE !== null) {
      const css = `html.tg-widetext { --font-body: '${FACE}', sans-serif !important; --font-display: '${FACE}', sans-serif !important; }`;
      pre.push(`document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); });`);
    }
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: pre.join('\n') });
    const flags = ['ui=home', WIDETEXT ? 'widetext' : '', size.tv ? 'tv' : ''].filter(Boolean).join('&');
    await page.send('Page.navigate', { url: `${base}#${flags}` });
    const head = `${size.name.padEnd(11)} ${lang}`;
    if (!(await page.until('window.__game && window.__game.menu.visible && typeof window.__uiFit === "function"', 90_000))) {
      console.log(`${head}: the menus never came up (no __uiFit: a build without VITE_UI_FIT=1?)`);
      failures++;
      continue;
    }
    await page.eval('document.fonts.ready.then(() => true)');
    // The crowded states this page cannot reach without a server or an account, set on the Menu's
    // own parts (a layout check, not the game's API).
    if (ONLINE) await page.eval(`(() => { const m = __game.menu; const p = m.regionPill; const set = p.set.bind(p); const region = document.documentElement.lang === 'es' ? 'Auto · Sudamérica' : 'Auto · South America'; p.set = () => set({ kind: 'online', region, playing: 128 }); m.refreshChrome(); return true; })()`);
    if (LONG_NAME) await page.eval(`(() => { const t = __game.menu.topBar.chip.querySelector('.mn-chip-text'); if (t) { t.querySelector('b').textContent = 'MaximilianoGomez'; t.querySelector('small').textContent = document.documentElement.lang === 'es' ? 'Diamante III' : 'Diamond III'; } window.dispatchEvent(new Event('resize')); return true; })()`);
    // The first section label on screen (the bar's, the rail's or the tabs'), marked for the font query.
    await page.eval(`(() => { const el = [...document.querySelectorAll('.mn-sec-label, .mn-sl-label')].find((e) => e.getBoundingClientRect().width > 0); el?.setAttribute('data-uifit-face', ''); return true; })()`);
    const face = await page.fonts('[data-uifit-face]');
    const own = await page.eval('document.documentElement.dataset.input');
    const pageLang = await page.eval('document.documentElement.lang');
    console.log(`${head} layout ${await page.eval('document.documentElement.dataset.layout')}, input ${own}, language ${pageLang}, the bars' text in ${face}`);
    if (pageLang !== lang) {
      console.log(`${head}: the page is in ${pageLang}, expected ${lang}`);
      failures++;
    }
    /** Ask the page's __uiFit() and print one line: `screen` and its `note` (a hero state). */
    const check = async (input, screen, note = '') => {
      const r = await page.eval('window.__uiFit()');
      const small = r.smallText ?? [];
      const home = screen === 'home';
      const bad = [
        ...(r.layout !== size.layout ? [`layout: ${r.layout}, expected ${size.layout} (the browser's pointer: ${await page.eval("['fine', 'coarse', 'none'].find((k) => matchMedia('(pointer: ' + k + ')').matches) ?? '?'")})`] : []),
        ...r.shellOverflow.map((x) => 'shell: ' + x),
        ...r.fitOverflow.map((x) => 'fit: ' + x),
        ...(r.fitLines ?? []).map((x) => 'lines: ' + x),
        ...(r.spill ?? []).map((x) => 'spill: ' + x),
        ...(r.hScroll ? ['horizontal scroll'] : []),
        // Inicio never scrolls but upright (360 x 640 may).
        ...(home && r.stageScroll && r.layout !== 'portrait' ? ['the stage scrolls'] : []),
        ...r.clippedFocus.map((x) => 'ring cut: ' + x),
        ...small.filter((x) => !x.endsWith('(data-fit)')).map((x) => 'small text: ' + x),
      ];
      const shrunk = small.filter((x) => x.endsWith('(data-fit)')).length;
      const hero = home && r.hero ? `  hero ${JSON.stringify(r.hero.text)} ${r.hero.lines} line(s) @${r.hero.size}` : '';
      failures += bad.length;
      report.push({ size: size.name, lang, input, face: FACE ?? 'Arial', note, ...r, bad });
      console.log(`${head} ${input.padEnd(8)} ${(screen + (note ? ' ' + note : '')).padEnd(20)} ${bad.length === 0 ? 'ok' : 'FAIL'}${r.stageScroll ? '  (stage scrolls)' : ''}${shrunk > 0 ? `  (${shrunk} fitted under the minimum)` : ''}${hero}  nodes ${r.nodes}${bad.length ? '\n    ' + bad.join('\n    ') : ''}`);
    };
    const runs = [[own, SCREENS], ...INPUTS.filter((x) => x !== own).map((x) => [x, INPUT_SCREENS])];
    for (const [input, screens] of runs) for (const screen of screens) {
      // Another last input (device.ts): its hints and the strip's side; the Menu fits the bars on the change.
      if (input !== own && screen === screens[0]) await page.eval(`(() => { const h = document.documentElement; h.dataset.input = ${JSON.stringify(input)}; h.classList.toggle('tg-touch', ${JSON.stringify(input)} === 'touch'); return true; })()`);
      await page.eval(`(__game.menu.open(${JSON.stringify(screen)}, true), true)`);
      await sleep(input === own ? 400 : 200); // a mount and a screen's own first render (__uiFit runs the fit it queued)
      if (screen !== 'home' || input !== own) {
        await check(input, screen);
        continue;
      }
      // Inicio with the device's own input: every hero state, ✕ focused while searching, a TV's
      // play state with a controller too, then the live state again.
      for (const kind of HERO_KINDS) {
        await page.eval(`(window.__homeHero(${JSON.stringify(kind)}), true)`);
        await sleep(300);
        await check(input, screen, kind);
        if (kind === 'search') {
          await page.eval(`(document.querySelector('[data-key="hero-x"]')?.focus(), true)`);
          await sleep(200);
          await check(input, screen, 'search ✕');
          await page.eval(`(document.querySelector('[data-key="hero"]')?.focus(), true)`);
        }
      }
      if (size.tv) {
        await page.eval(`(window.__homeHero('play', { pad: true }), true)`);
        await sleep(300);
        await check(input, screen, 'play pad');
      }
      await page.eval('(window.__homeHero(null), true)');
      await sleep(200);
    }
    // Last on a TV (it leaves a fake controller in this tab): no controller, the slot says so; the
    // hero's press opens the sheet; a controller connecting with A held (the press that reveals
    // one) closes it and starts nothing.
    if (size.tv && SCREENS.includes('home')) {
      const fail = (why) => {
        failures++;
        console.log(`${head} ${own.padEnd(8)} ${'home need-pad'.padEnd(20)} FAIL\n    ${why}`);
      };
      await page.eval(`(() => { const h = document.documentElement; h.dataset.input = ${JSON.stringify(own)}; h.classList.remove('tg-touch'); __game.menu.open('home', true); return true; })()`);
      await sleep(400);
      const want = NEED_PAD[lang];
      const slot = await page.eval(`(() => { const s = document.querySelector('.mn-hero.mn-hero-needpad .mn-slot'); const i = document.querySelector('.mn-hero-icon'); return { text: s?.textContent ?? null, icon: i !== null && i.getBoundingClientRect().width > 0 }; })()`);
      if (slot.text !== want) fail(`the hero's slot reads ${JSON.stringify(slot.text)}, expected ${JSON.stringify(want)}`);
      else if (!slot.icon) fail("the hero's own icon is gone");
      else {
        await page.eval(`(document.querySelector('[data-key="hero"]').focus(), __game.menu.action('accept'), true)`);
        await sleep(300);
        const sheet = await page.eval(`document.querySelector('.mn-sheet')?.getAttribute('aria-label') ?? null`);
        const r = await page.eval('window.__uiFit()');
        const over = [...r.shellOverflow, ...r.fitOverflow, ...r.clippedFocus, ...(r.hScroll ? ['horizontal scroll'] : [])];
        if (sheet !== want) fail(`the sheet is ${JSON.stringify(sheet)}, expected ${JSON.stringify(want)}`);
        else if (over.length > 0) fail('the sheet: ' + over.join('; '));
        else {
          await page.eval(`(() => {
            const pad = { index: 0, id: 'ui-fit pad', connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 0, touched: i === 0, value: i === 0 ? 1 : 0 })) };
            window.__uiFitPad = pad;
            navigator.getGamepads = () => [pad];
            const e = new Event('gamepadconnected');
            Object.defineProperty(e, 'gamepad', { value: pad });
            window.dispatchEvent(e);
            return true;
          })()`);
          await sleep(300);
          await page.eval(`(window.__uiFitPad.buttons[0] = { pressed: false, touched: false, value: 0 }, true)`);
          await sleep(1200); // a super low tick
          const state = `({ sheet: document.querySelector('.mn-sheet') !== null, needPad: document.querySelector('.mn-hero-needpad') !== null, focus: document.activeElement?.dataset?.key ?? null, searching: __game.menu.host.searchView().active, menus: __game.menu.visible })`;
          const wrongOf = (after) => [after.sheet ? 'the sheet is still up' : '', after.needPad ? 'the hero still asks for a controller' : '', after.focus !== 'hero' ? `the focus is on ${after.focus}, not the hero` : '', after.searching ? 'a search started' : '', !after.menus ? 'a match started' : ''].filter(Boolean);
          const wrong = wrongOf(await page.eval(state));
          if (wrong.length > 0) fail('its event first: ' + wrong.join('; '));
          else {
            // The controller goes, the sheet again with CONTINUE ANYWAY focused, then the game's own
            // frame (Game.frame in the menus) reads the revealing press before any event or tick.
            await page.eval('(navigator.getGamepads = () => [], true)');
            await sleep(1500); // the loop drops the pad, a super low tick sees it gone
            await page.eval(`(document.querySelector('[data-key="hero"]').focus(), __game.menu.action('accept'), true)`);
            await sleep(300);
            const go = await page.eval(`(() => { const b = [...document.querySelectorAll('.mn-sheet button')].find((e) => e.textContent.includes(${JSON.stringify(NEED_PAD_GO[lang])})); b?.focus(); return b !== undefined && document.activeElement === b; })()`);
            if (!go) fail(`the second sheet has no focused ${JSON.stringify(NEED_PAD_GO[lang])}`);
            else {
              await page.eval(`(() => {
                const pad = window.__uiFitPad;
                pad.buttons[0] = { pressed: true, touched: true, value: 1 };
                navigator.getGamepads = () => [pad];
                const g = __game;
                g.input.beginFrame();
                g.input.sample(g.playerControls);
                g.processActions();
                return true;
              })()`);
              await sleep(300);
              await page.eval(`(window.__uiFitPad.buttons[0] = { pressed: false, touched: false, value: 0 }, true)`);
              await sleep(1200);
              const late = wrongOf(await page.eval(state));
              if (late.length > 0) fail('the frame first: ' + late.join('; '));
              else console.log(`${head} ${own.padEnd(8)} ${'home need-pad'.padEnd(20)} ok  (slot and sheet "${want}"; a controller with A held closed it, its event or the game's frame first, nothing started, the focus on the hero)`);
            }
          }
        }
      }
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

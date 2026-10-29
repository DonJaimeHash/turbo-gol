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
// state with a controller too; then Competitive in every format, idle and searching as the Menu
// runs a search (its own pills, the region's counting players), which fails a format left out of
// the subtitle and, on a TV, the region's name gone from the plate's row. Each also fails a title
// on more lines than it may take, text out of its tile or under ✕, and prints the hero's title as
// fitted. Last on a TV, with no controller (headless has none): the hero says it needs one, its
// press opens the sheet, and a controller that
// connects with A held closes the sheet without starting anything (plan PR 5 acceptance): its event
// first, then (CONTINUE ANYWAY focused) the game's frame first, which reads the press before any
// event or tick.
//
// The FINAL (plan PR 7) runs each kind's sample (window.__final: ranked with its rank card and a
// community node's line, casual, against the AI with a full 3v3, a lobby) and fails PLAY AGAIN without
// the focus (but on a touch screen).
//
// ENTRENAMIENTO, CLASIFICACIÓN and PERFIL (plan PR 13) run their states: training also as an
// account with Settings › Experimental on ('training:lab': the LAB tile, HOW TO PLAY as a row), the
// board with 100 sample rows and yours among them or under them, then as a guest (window.__board),
// the profile as a guest, an account and a community node operator (window.__profile). 'summary': a
// pack's summary over the training HUD (TrainingHud.showSummary, sample results), which fails it
// off screen, text out of its box or under 14 px on a phone (12 elsewhere), a button something
// covers (the touch controls) or under 44 px for a finger, and AGAIN without the focus (but on a
// touch screen).
//
// The touch match (plan PR 9, 'touch'), last on the touch sizes: an offline match in touch mode
// (Game.startMatch), its controls, each first-match card, the full scoreboard, the touch pause, and
// free play's pause with its training row; upright, the rotate notice. It fails a control nearer
// than 24 px to the right edge or the stick nearer than 28 to the left, two controls overlapping,
// the boost plate on screen, RESUME not over BOOST's centre, a card over JUMP / BOOST / DRIFT or
// its GOT IT under 56 px, anything off screen, text out of its box, a card's or the pause's text
// under 14 px and a control's label under 12.
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
// The interface size (Settings > Game, plan PR 11): a TV's runs are at its own 125 %; then every
// size runs the screens again (their states and samples, Inicio once; not the FINAL or the touch
// match) with the device's own input at the largest size Ajustes lists there
// (device.ts interfaceSizes: 150 % on a computer, 130 on a tablet, 115 on a phone held sideways;
// none past the device's own on a TV or a 360 tall or 390 wide phone), noted 'ui <size>%';
// --ui-size <pct> forces one, --no-ui-size skips the pass. Inicio may scroll there.
// MODOS (plan PR 6) runs by tab ('modes:casual' ...): Casual and Competitive idle with the action
// focused, then searching (the panel, as the Menu shows a search: its own search view and pills),
// CANCEL SEARCH and "While you wait: Free play" focused. CONTRA LA IA opens its Stadium sheet
// (plan PR 16), which fails it off screen, a stadium's name cut, under 44 px for a finger, the
// current one not marked or (but on a touch screen) not focused, and CANCEL not giving the focus
// back to the row.
//
// The Salas (plan PR 12) run their samples (window.__sala, screens/lobby.ts installSalaSamples): the
// Sala with 1 to 6 members, reconnecting, a TV's QR sheet, the code entry (mn-codecells), a join
// link's sheet, the lobby pill on Inicio, the lost connection's sheet; then the HUD's reconnection
// line ("Reconnecting… (attempt 2/5)", "Back in the match") must stay on screen and unclipped.
//
// The TV's typing and sign-in (plan PR 14, 'tv': window.__tvSignIn, screens/tvSignInSamples.ts): mn-keypad
// over PERFIL's guest name, its password and the code cells' sheet where there is no fine pointer (the
// TVs, the phones, the tablet), which fails it off screen, a key under 32 x 24 px or its text cut, no
// key focused, or a password's text shown; the TV's sign-in sheet (a code, expired) on the TVs; the
// phone's /tv sheets (sign in first, the code, the question with a long name, a refusal) and the
// anti-bot sheet everywhere.
//
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
// MODOS by its tabs: 'modes:<tab>' opens it on that tab (Menu.open's tab).
const SCREENS = typeof args.screens === 'string' ? args.screens.split(',') : ['home', 'modes:casual', 'modes:ranked', 'modes:lobbies', 'modes:ai', 'training', 'training:lab', 'summary', 'garage', 'leaderboard', 'leaderboard:rows', 'leaderboard:below', 'leaderboard:guest', 'profile', 'profile:account', 'profile:operator', 'final', 'touch', 'sala', 'tv'];
// The Salas' samples (window.__sala, plan PR 12): [kind, members]; 'qr' on a TV only.
const SALA_KINDS = [['members', 1], ['members', 2], ['members', 3], ['members', 4], ['members', 5], ['members', 6], ['reconnecting', 4], ['qr', 4], ['codecells', 0], ['join', 4], ['pill', 4], ['lost', 0]];
// PR 14's samples (window.__tvSignIn): the keypad's where no fine pointer, 'tv*' on a TV, the rest everywhere.
const TV_KINDS = ['keypad', 'keypad-password', 'keypad-code', 'tv', 'tv-expired', 'tvlink-signin', 'tvlink-code', 'tvlink-ask', 'tvlink-refused', 'antibot'];
/** The keypad on screen, its keys big enough and whole, one focused, a password in dots. */
const KEYPAD_CHECK = (kind) => `(() => {
  const out = [];
  const k = document.querySelector('.mn-keypad');
  if (!__game.menu.keypadOpen || k === null) return ['the keypad did not open'];
  const r = k.getBoundingClientRect();
  if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) out.push('keypad off screen: ' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(','));
  for (const b of k.querySelectorAll('.mn-kp-key')) {
    const q = b.getBoundingClientRect();
    if (q.height < 32 || q.width < 24) out.push('key too small: ' + b.dataset.key + ' ' + Math.round(q.width) + 'x' + Math.round(q.height));
    if (b.scrollWidth > b.clientWidth + 1) out.push('key text cut: ' + b.dataset.key);
  }
  if (!document.activeElement?.classList.contains('mn-kp-key')) out.push('no key focused');
  const text = k.querySelector('.mn-keypad-text')?.textContent ?? '';
  if (${JSON.stringify(kind)} === 'keypad-password' && !/^•*$/.test(text)) out.push('the password shows: ' + text.length + ' chars');
  return out;
})()`;
// The HUD's reconnection line, per language: the try and the way back (OnlineSession.hint).
const NET_LINES = { en: ['Reconnecting… (attempt 2/5)', 'Back in the match'], es: ['Reconectando… (intento 2/5)', 'De vuelta en el partido'] };
// The FINAL's samples (window.__final, plan PR 7): ranked (the rank card, a community node's line),
// casual (a loss), against the AI (a draw, a full 3v3), a lobby's match.
const FINAL_KINDS = ['ranked', 'casual', 'ai', 'lobby'];
// Inicio's hero states (window.__homeHero), in the order of their priority.
const HERO_KINDS = ['play', 'search', 'offline', 'lobby', 'update', 'rejoin'];
// A ranked search of every format as the Menu shows it (a layout check: its parts, not the game's
// API): the search view, and the region pill counting players (pills.ts PLAYING_SHOWN up; with
// --online its own count stays); SEARCH_DONE puts both back.
const RANKED_SEARCH = `(() => {
  const m = __game.menu;
  const p = m.regionPill;
  const since = performance.now() - 42000;
  const region = document.documentElement.lang === 'es' ? 'Auto · Sudamérica' : 'Auto · South America';
  window.__uiFitSearch = { view: m.host.searchView, set: p.set };
  m.host.searchView = () => ({ active: true, kind: 'ranked', modes: ['1v1', '2v2', '3v3'], text: '', since, region: null, error: null, reload: false });
  const set = p.set.bind(p);
  p.set = () => set({ kind: 'online', region, playing: 12 });
  window.__homeHero(null);
  m.refreshChrome();
  m.tick();
  return true;
})()`;
// CONTRA LA IA's Stadium sheet (plan PR 16): its checks, in the page.
const STADIUM_CHECK = `(() => {
  const out = [];
  const sh = document.querySelector('.mn-sheet');
  if (sh === null) return ['the stadium sheet did not open'];
  const label = document.querySelector('[data-key="ai-stadium"] .mn-picker-label')?.textContent ?? '';
  if (sh.getAttribute('aria-label') !== label) out.push('the sheet is ' + JSON.stringify(sh.getAttribute('aria-label')) + ', not ' + JSON.stringify(label));
  const r = sh.getBoundingClientRect();
  if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) out.push('sheet off screen: ' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(','));
  const touch = document.documentElement.classList.contains('tg-touch');
  const opts = [...sh.querySelectorAll('[data-key^="stadium-"]')];
  if (opts.length < 2) out.push(opts.length + ' stadiums listed');
  for (const b of opts) {
    if (b.scrollWidth > b.clientWidth + 1) out.push('name cut: ' + b.dataset.key);
    if (touch && b.getBoundingClientRect().height < 44) out.push('under 44 px for a finger: ' + b.dataset.key);
  }
  const current = 'stadium-' + __game.menu.host.theme;
  const marked = opts.filter((b) => b.getAttribute('aria-current') === 'true').map((b) => b.dataset.key);
  if (marked.join() !== current) out.push('marked ' + JSON.stringify(marked) + ', not ' + current);
  if (!touch && document.activeElement?.dataset?.key !== current) out.push('the focus is on ' + (document.activeElement?.dataset?.key ?? document.activeElement?.className ?? null) + ', not ' + current);
  return out;
})()`;
const SEARCH_DONE = `(() => { const m = __game.menu; const s = window.__uiFitSearch; m.host.searchView = s.view; m.regionPill.set = s.set; m.refreshChrome(); m.tick(); return true; })()`;
// MODOS' searching panel (plan PR 6): a search of the tab's kind, 4 s in, on the server queue (the
// bots box shows: its 10 s fill, the config's botFillMs, still ahead of a search started now), the
// region counting players; SEARCH_DONE puts it back.
const MODES_SEARCH = (kind) => `(() => {
  const m = __game.menu;
  const p = m.regionPill;
  const since = performance.now() - 4000;
  const region = document.documentElement.lang === 'es' ? 'Auto · Sudamérica' : 'Auto · South America';
  window.__uiFitSearch = { view: m.host.searchView, set: p.set };
  if (m.cfg !== null && !m.cfg.botFillMs) m.cfg.botFillMs = 10000;
  m.host.searchView = () => ({ active: true, kind: ${JSON.stringify(kind)}, modes: ['1v1', '2v2', '3v3'], text: '', since, region: null, net: 'server', error: null, reload: false });
  const set = p.set.bind(p);
  p.set = () => set({ kind: 'online', region, playing: 12 });
  m.refreshChrome();
  m.tick();
  return true;
})()`;
// Inicio's checks of its own: the hero's subtitle keeps every format (shown, not given way); a TV
// keeps the region's name in the pill by the plate (the hero's subtitle leaves it out searching).
const FORMATS = `(() => { const s = document.querySelector('.mn-hero-sub'); const t = s ? s.innerText : ''; return ['1v1', '2v2', '3v3'].filter((m) => !t.includes(m)).map((m) => 'the subtitle lost ' + m + ': ' + JSON.stringify(t)); })()`;
const TV_REGION = `(() => { const n = document.querySelector('.mn-home-pills .mn-pill-region .mn-pill-main'); return n !== null && n.getBoundingClientRect().width > 0 ? [] : ["the region's name is nowhere on screen (the pill by the plate gave it way)"]; })()`;
// A pack's summary (plan PR 13): its checks, in the page (see SCREENS' note).
const SUMMARY_CHECK = `(() => {
  const W = innerWidth, H = innerHeight, bad = [];
  const touch = document.documentElement.classList.contains('tg-touch');
  const card = document.querySelector('.trn-summary-card');
  if (card === null || card.getBoundingClientRect().width === 0) return ['the summary is not up'];
  const off = (e) => { const r = e.getBoundingClientRect(); return r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5; };
  const say = (e) => JSON.stringify(e.textContent.trim().slice(0, 40));
  if (off(card)) bad.push('the summary is off screen');
  const min = document.documentElement.dataset.layout === 'phone' || document.documentElement.dataset.layout === 'portrait' ? 14 : 12;
  for (const e of card.querySelectorAll('*')) {
    if (e.children.length > 0 || !e.textContent.trim() || e.getBoundingClientRect().width === 0) continue;
    const f = parseFloat(getComputedStyle(e).fontSize);
    if (f < min - 0.05) bad.push('text ' + f.toFixed(1) + 'px: ' + say(e));
    if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).display !== 'inline') bad.push('text overflows: ' + say(e));
  }
  for (const b of card.querySelectorAll('.trn-btn')) {
    if (b.hidden) continue;
    const r = b.getBoundingClientRect();
    if (off(b)) bad.push(say(b) + ' off screen');
    if (touch && b.offsetHeight < 44) bad.push(say(b) + ' under 44 px: ' + b.offsetHeight);
    // Upright, the rotate notice is over the whole training (turn the phone to play): not a cover.
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (top !== b && !b.contains(top) && (top === null || top.closest('.tc-rotate') === null)) bad.push(say(b) + ' is covered by ' + (top === null ? null : top.className || top.tagName));
  }
  if (!touch && !(document.activeElement && document.activeElement.classList.contains('trn-btn-primary'))) bad.push('AGAIN is not focused: ' + (document.activeElement ? document.activeElement.className : null));
  return bad;
})()`;
// The TV's controller message (tv.needPad), per language.
const NEED_PAD = { en: 'YOU NEED A CONTROLLER', es: 'NECESITAS UN CONTROL' };
const NEED_PAD_GO = { en: 'CONTINUE ANYWAY', es: 'SEGUIR IGUAL' };
// After the device's own input, the others on the screens that change the shell: section roots,
// stacked screens (‹ and the crumbs, no strip), the ones with tabs of their own (Q / E step those).
const INPUT_SCREENS = ['home', 'modes:casual', 'modes:lobbies', 'training', 'leaderboard', 'profile', 'sala'].filter((x) => SCREENS.includes(x));
// The touch match's checks (window context): what is wrong on screen now, from the controls' and the
// pause's own boxes. `boost` is BOOST's centre measured while the controls were up.
const TOUCH_CHECK = (state, boost) => `(() => {
  const W = innerWidth, H = innerHeight, bad = [];
  const box = (e) => e.getBoundingClientRect();
  const shown = (e) => e !== null && box(e).width > 0 && getComputedStyle(e).visibility !== 'hidden';
  const name = (e) => (e.className.baseVal ?? e.className).split(' ').filter((c) => /^(tc|hud)-/.test(c)).slice(-1)[0] ?? e.tagName;
  const off = (e) => { const r = box(e); return r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5; };
  const over = (a, b) => { const r = box(a), q = box(b); return r.left < q.right - 0.5 && q.left < r.right - 0.5 && r.top < q.bottom - 0.5 && q.top < r.bottom - 0.5; };
  /** Text of el's leaves under px, or out of its box (wider or taller than its parent's content). */
  const text = (root, px) => { for (const e of root.querySelectorAll('*')) { if (!shown(e) || e.children.length > 0 || !e.textContent.trim()) continue; const f = parseFloat(getComputedStyle(e).fontSize); if (f < px - 0.05) bad.push(name(e) + ' text ' + f.toFixed(1) + 'px: ' + JSON.stringify(e.textContent.trim())); if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).display !== 'inline') bad.push(name(e) + ' text overflows: ' + JSON.stringify(e.textContent.trim())); } };
  const btns = [...document.querySelectorAll('.tc-root.tc-show .tc-btn')].filter(shown);
  if (${JSON.stringify(state)} === 'play' || ${JSON.stringify(state)}.startsWith('card') || ${JSON.stringify(state)} === 'board') {
    if (btns.length < 5) bad.push('only ' + btns.length + ' touch controls up');
    for (const b of btns) {
      const r = box(b);
      if (W - r.right < 24 - 0.5) bad.push(name(b) + ' ' + (W - r.right).toFixed(1) + ' px from the right edge');
      if (off(b)) bad.push(name(b) + ' off screen');
      for (const l of b.querySelectorAll('div, span')) { const q = box(l); if (!l.textContent.trim()) continue; if (q.width > 0 && (q.width > r.width - 6 || parseFloat(getComputedStyle(l).fontSize) < 11.95)) bad.push(name(b) + ' label ' + JSON.stringify(l.textContent) + ' ' + q.width.toFixed(0) + ' wide @' + getComputedStyle(l).fontSize); }
    }
    for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) { const a = box(btns[i]), b = box(btns[j]); if (Math.hypot(a.left + a.width / 2 - b.left - b.width / 2, a.top + a.height / 2 - b.top - b.height / 2) < (a.width + b.width) / 2 - 0.5) bad.push(name(btns[i]) + ' overlaps ' + name(btns[j])); }
    if (box(document.querySelector('.tc-stick')).left < 28 - 0.5) bad.push('the stick nearer than 28 px to the left edge');
    if (shown(document.querySelector('.hud-boost'))) bad.push('the boost plate shows in touch mode');
    const bug = document.querySelector('.hud-top');
    for (const b of btns) if (over(bug, b)) bad.push('the scorebug under ' + name(b));
  }
  if (${JSON.stringify(state)}.startsWith('card')) {
    const card = document.querySelector('.tc-card');
    if (!shown(card)) bad.push('no card');
    else {
      if (off(card)) bad.push('the card is off screen');
      for (const b of document.querySelectorAll('.tc-jump, .tc-boost, .tc-drift')) if (over(card, b)) bad.push('the card covers ' + name(b));
      if (box(document.querySelector('.tc-card-ok')).height < 56 - 0.5) bad.push('GOT IT under 56 px');
      text(card, 14);
    }
  }
  if (${JSON.stringify(state)} === 'board') {
    const p = document.querySelector('.hud-sb-panel');
    if (!shown(p)) bad.push('the scoreboard is not up'); else if (off(p)) bad.push('the scoreboard is off screen');
  }
  if (${JSON.stringify(state)}.startsWith('pause')) {
    const items = [...document.querySelectorAll('.hud-pause-menu .hud-pause-btn')].filter(shown);
    const plate = document.querySelector('.hud-paused-plate');
    const bug = document.querySelector('.hud-top');
    if (items.length < 3) bad.push('only ' + items.length + ' pause buttons');
    for (const e of [...items, plate]) if (off(e)) bad.push(name(e) + ' off screen: ' + JSON.stringify(e.innerText.replace(/\\s+/g, ' ')));
    const all = [...items, plate, bug];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (over(all[i], all[j])) bad.push(JSON.stringify(all[i].innerText.replace(/\\s+/g, ' ')) + ' overlaps ' + JSON.stringify(all[j].innerText.replace(/\\s+/g, ' ')));
    const resume = document.querySelector('.hud-pause-primary');
    const r = box(resume);
    const b = ${JSON.stringify(boost)};
    if (!(r.left <= b.x && b.x <= r.right && r.top <= b.y && b.y <= r.bottom)) bad.push('RESUME is not over the centre of BOOST (' + b.x.toFixed(0) + ', ' + b.y.toFixed(0) + ')');
    if (W - r.right < 24 - 0.5) bad.push('RESUME ' + (W - r.right).toFixed(1) + ' px from the right edge');
    for (const e of items) if (e !== resume && !e.closest('.hud-pause-row') && box(e).left < 28 - 0.5) bad.push(name(e) + ' nearer than 28 px to the left edge');
    for (const e of items) text(e, 14);
    text(plate, 14);
  }
  if (${JSON.stringify(state)} === 'rotate') {
    const n = document.querySelector('.tc-rotate');
    if (!shown(n)) bad.push('no rotate notice upright');
    else { if (off(n.querySelector('.tc-rotate-text'))) bad.push('the notice is off screen'); text(n, 14); }
  }
  return bad;
})()`;
const LANGS = typeof args.langs === 'string' ? args.langs.split(',') : ['en', 'es'];
const ALL_INPUTS = ['keyboard', 'pad', 'remote', 'mouse', 'touch'];
const INPUTS = args.inputs === 'default' ? [] : typeof args.inputs === 'string' ? args.inputs.split(',').filter((x) => ALL_INPUTS.includes(x)) : ALL_INPUTS;
const ONLINE = args.online === true;
const LONG_NAME = args['long-name'] === true;
const WIDETEXT = args['no-widetext'] !== true;
const UI_SIZE = args['no-ui-size'] !== true;
const FACE = typeof args.face === 'string' ? args.face.replace(/['"\\]/g, '') : null;
// The pointer the browser starts with (Blink's PointerType / HoverType: 4 fine, 1 none; 2 hover, 1 none).
const POINTER = args['no-pointer'] === true ? 'primaryPointerType=1,availablePointerTypes=1,primaryHoverType=1,availableHoverTypes=1' : 'primaryPointerType=4,availablePointerTypes=4,primaryHoverType=2,availableHoverTypes=2';
// Ajustes (plan PR 10): each of its six tabs with the device's own input, before the touch match;
// CONTROLES with every other input's hints too (its own tabs: L / R, Q / E).
if (typeof args.screens !== 'string') SCREENS.splice(SCREENS.includes('touch') ? SCREENS.indexOf('touch') : SCREENS.length, 0, ...['controls', 'camera', 'game', 'audio', 'graphics', 'experimental'].map((t) => 'settings:' + t));
if (SCREENS.includes('settings:controls')) INPUT_SCREENS.push('settings:controls');

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
    /** Ask the page's __uiFit() and print one line: `screen` and its `note` (a hero state); `extra`: failures of the caller's own. */
    const check = async (input, screen, note = '', extra = []) => {
      const r = await page.eval('window.__uiFit()');
      const small = r.smallText ?? [];
      const home = screen === 'home';
      const bad = [
        ...extra,
        ...(r.layout !== size.layout ? [`layout: ${r.layout}, expected ${size.layout} (the browser's pointer: ${await page.eval("['fine', 'coarse', 'none'].find((k) => matchMedia('(pointer: ' + k + ')').matches) ?? '?'")})`] : []),
        ...r.shellOverflow.map((x) => 'shell: ' + x),
        ...r.fitOverflow.map((x) => 'fit: ' + x),
        ...(r.fitLines ?? []).map((x) => 'lines: ' + x),
        ...(r.spill ?? []).map((x) => 'spill: ' + x),
        ...(r.hScroll ? ['horizontal scroll'] : []),
        // Inicio never scrolls but upright (360 x 640 may).
        // Nor at a larger interface size than the device's own (it may, as every other screen).
        ...(home && r.stageScroll && r.layout !== 'portrait' && !note.startsWith('ui ') ? ['the stage scrolls'] : []),
        ...r.clippedFocus.map((x) => 'ring cut: ' + x),
        ...small.filter((x) => !x.endsWith('(data-fit)')).map((x) => 'small text: ' + x),
      ];
      const shrunk = small.filter((x) => x.endsWith('(data-fit)')).length;
      const hero = home && r.hero ? `  hero ${JSON.stringify(r.hero.text)} ${r.hero.lines} line(s) @${r.hero.size}` : '';
      failures += bad.length;
      report.push({ size: size.name, lang, input, face: FACE ?? 'Arial', note, ...r, bad });
      console.log(`${head} ${input.padEnd(8)} ${(screen + (note ? ' ' + note : '')).padEnd(20)} ${bad.length === 0 ? 'ok' : 'FAIL'}${r.stageScroll ? '  (stage scrolls)' : ''}${shrunk > 0 ? `  (${shrunk} fitted under the minimum)` : ''}${hero}  nodes ${r.nodes}${bad.length ? '\n    ' + bad.join('\n    ') : ''}`);
    };
    const runs = [[own, SCREENS.filter((x) => x !== 'touch')], ...INPUTS.filter((x) => x !== own).map((x) => [x, INPUT_SCREENS])];
    /**
     * One screen with `input`: its states and samples, as the device's own input runs them (the
     * others: the screen as it opens). `ui`: the interface-size pass's note ('ui 150%') before each
     * state's; Inicio is one check there.
     */
    const runScreen = async (input, screen, ui = '') => {
      const at = (note = '') => [ui, note].filter(Boolean).join(' ');
      if (screen === 'final') {
        for (const kind of FINAL_KINDS) {
          await page.eval(`(window.__final(${JSON.stringify(kind)}), true)`);
          await sleep(400);
          // The first focus lands with the mount's frame (Menu.autoFocus: the next animation frame), a
          // slow one at 1920 x 1080 in a headless page: SwiftShader draws the stadium on the CPU, and the
          // first 1920 x 1080 page of a CI run waited past 2 s for it (8fa31c1, d36fbb5; 1.9 s on 2c11269).
          // Two frames past the mount however long they take (10 s at most), then the focus.
          await page.eval('new Promise((r) => { const t = setTimeout(() => r(false), 10_000); requestAnimationFrame(() => requestAnimationFrame(() => (clearTimeout(t), r(true)))); })');
          await page.until("document.activeElement?.dataset?.key === 'final-again' || document.documentElement.classList.contains('tg-touch')", 2_000, 50);
          await check(input, screen, at(kind), await page.eval("document.activeElement?.dataset?.key === 'final-again' || document.documentElement.classList.contains('tg-touch') ? [] : ['PLAY AGAIN is not focused: ' + (document.activeElement?.className ?? null)]"));
        }
        await page.eval('(window.__final(null), true)');
        return;
      }
      if (screen === 'sala') {
        // Every sample with the device's own input; the Sala of 4 with the others (their hints).
        const kinds = input === own ? SALA_KINDS.filter(([k]) => k !== 'qr' || size.tv) : [['members', 4]];
        for (const [kind, n] of kinds) {
          await page.eval(`(window.__sala(${JSON.stringify(kind)}, ${n}), true)`);
          await sleep(input === own ? 400 : 250);
          await check(input, screen, at(n > 0 && kind !== 'join' && kind !== 'pill' ? `${kind} ${n}` : kind));
        }
        await page.eval('(window.__sala(null), true)');
        await sleep(200);
        if (input !== own) return;
        // The HUD's reconnection line, the menus away: on screen, its text whole.
        const lines = NET_LINES[lang] ?? NET_LINES.en;
        const bad = await page.eval(`(() => {
          const g = __game;
          const out = [];
          g.menu.hide();
          for (const [text, ok] of [[${JSON.stringify(lines[0])}, false], [${JSON.stringify(lines[1])}, true]]) {
            g.hud.setNetWait(text, ok);
            const el = document.querySelector('.hud-netwait');
            const r = el.getBoundingClientRect();
            if (r.width === 0) out.push(text + ': not shown');
            if (r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight) out.push(text + ': off the screen');
            if (el.scrollWidth > el.clientWidth + 1) out.push(text + ': cut');
          }
          g.hud.setNetWait(null);
          g.menu.show();
          return out;
        })()`);
        failures += bad.length;
        console.log(`${head} ${input.padEnd(8)} ${at('hud reconnect').padEnd(20)} ${bad.length === 0 ? 'ok' : 'FAIL\n    ' + bad.join('\n    ')}`);
        await sleep(300);
        return;
      }
      if (screen === 'tv') {
        const kinds = input !== own ? [] : TV_KINDS.filter((k) => (k.startsWith('keypad') ? size.tv || size.mobile : k === 'tv' || k === 'tv-expired' ? size.tv : true));
        for (const kind of kinds) {
          await page.eval(`(window.__tvSignIn(${JSON.stringify(kind)}), true)`);
          await sleep(400);
          await check(input, screen, at(kind), kind.startsWith('keypad') ? await page.eval(KEYPAD_CHECK(kind)) : []);
        }
        await page.eval('(window.__tvSignIn(null), true)');
        await sleep(200);
        return;
      }
      if (screen === 'summary') {
        // A pack's summary (plan PR 13) over the training HUD, then back to the menus.
        await page.eval(`(__game.startTraining('shooting-medium'), true)`);
        await page.until('__game.training !== null && __game.trainingHud !== null', 10_000, 100);
        await sleep(400);
        await page.eval(`(__game.trainingHud.showSummary(__game.training.pack.name, { passed: 5, total: 7, best: 6, newBest: false }, ['pass', 'fail', 'pass', 'pass', 'fail', 'pass', 'pass'], 'next'), true)`);
        await sleep(900); // its pop (0.35 s of scale) over, on a slow headless frame too
        const bad = await page.eval(SUMMARY_CHECK);
        failures += bad.length;
        report.push({ size: size.name, lang, input, face: FACE ?? 'Arial', note: at('summary'), bad });
        console.log(`${head} ${input.padEnd(8)} ${at('summary').padEnd(20)} ${bad.length === 0 ? 'ok' : 'FAIL'}${bad.length ? '\n    ' + bad.join('\n    ') : ''}`);
        await page.eval('(__game.stopTraining(), true)');
        await page.until('__game.menu.visible', 10_000, 100);
        await sleep(300);
        return;
      }
      const [id, tab] = screen.split(':');
      // PR 13's states are samples on the screen itself (the tab is a sample's kind there, not Menu.open's).
      const sampled = id === 'training' || id === 'leaderboard' || id === 'profile';
      // An account with Settings › Experimental on (training:lab): its view's switch, set on the page.
      if (id === 'training') await page.eval(`(() => { const x = __game.menu.host.experimental; window.__uiFitLab ??= Object.getOwnPropertyDescriptor(x, 'unlocked') ?? { value: x.unlocked }; Object.defineProperty(x, 'unlocked', ${tab === 'lab' ? '{ get: () => true, configurable: true }' : 'window.__uiFitLab'}); return true; })()`);
      await page.eval(`(__game.menu.open(${JSON.stringify(id)}, true${tab !== undefined && !sampled ? ', ' + JSON.stringify(tab) : ''}), true)`);
      if (id === 'leaderboard') await page.eval(`(window.__board(${JSON.stringify(tab ?? null)}), true)`);
      if (id === 'profile') await page.eval(`(window.__profile(${JSON.stringify(tab ?? null)}), true)`);
      await sleep(input === own ? 400 : 200); // a mount and a screen's own first render (__uiFit runs the fit it queued)
      if (id === 'modes' && input === own && (tab === 'casual' || tab === 'ranked')) {
        // Idle with FIND MATCH (or SIGN IN) focused, then searching every format (the longest
        // queue line), CANCEL SEARCH focused, then "While you wait: Free play" focused.
        await page.eval(`(document.querySelector('[data-key="modes-go"]')?.focus(), true)`);
        await sleep(200);
        await check(input, screen, at('idle'));
        await page.eval(MODES_SEARCH(tab));
        await sleep(300);
        await check(input, screen, at('search'));
        for (const key of ['modes-cancel', 'modes-practice']) {
          await page.eval(`(document.querySelector('[data-key="${key}"]')?.focus(), true)`);
          await sleep(200);
          await check(input, screen, at('search ' + key.slice(6)));
        }
        await page.eval(SEARCH_DONE);
        await sleep(200);
        return;
      }
      if (id === 'modes' && input === own && tab === 'ai') {
        // As it opens, then the Stadium sheet (its first focus with the next frame, as Menu.modal
        // gives it), then CANCEL: the focus back on the row (but on a touch screen).
        await check(input, screen, at());
        await page.eval(`(() => { const row = document.querySelector('[data-key="ai-stadium"]'); row?.focus({ preventScroll: true }); row?.click(); return true; })()`);
        await page.until(`document.querySelector('.mn-sheet') !== null && (document.documentElement.classList.contains('tg-touch') || document.activeElement?.dataset?.key?.startsWith('stadium-') === true)`, 3_000, 50);
        // Its rise over (a phone's from the bottom: 24 px low until then), however slow the frames.
        await sleep(200);
        await page.eval(`((document.querySelector('.mn-sheet')?.getAnimations({ subtree: true }) ?? []).forEach((a) => a.finish()), true)`);
        await check(input, screen, at('stadium'), await page.eval(STADIUM_CHECK));
        await page.eval(`([...document.querySelectorAll('.mn-sheet .mn-sheet-actions button')].at(-1)?.click(), true)`);
        await sleep(300);
        const back = await page.eval(`(() => { const a = document.activeElement; return document.querySelector('.mn-sheet') === null && (document.documentElement.classList.contains('tg-touch') || a?.dataset?.key === 'ai-stadium') ? [] : ['after CANCEL: ' + (document.querySelector('.mn-sheet') !== null ? 'the sheet is still up' : 'the focus is on ' + (a?.dataset?.key ?? a?.className ?? null))]; })()`);
        await check(input, screen, at('stadium cancel'), back);
        return;
      }
      if (screen !== 'home' || input !== own || ui !== '') {
        await check(input, screen, at());
        return;
      }
      // Inicio with the device's own input: every hero state, ✕ focused while searching, a TV's
      // play state with a controller too, then the live state again.
      for (const kind of HERO_KINDS) {
        await page.eval(`(window.__homeHero(${JSON.stringify(kind)}), true)`);
        await sleep(300);
        await check(input, screen, at(kind));
        if (kind === 'search') {
          await page.eval(`(document.querySelector('[data-key="hero-x"]')?.focus(), true)`);
          await sleep(200);
          await check(input, screen, at('search ✕'));
          await page.eval(`(document.querySelector('[data-key="hero"]')?.focus(), true)`);
        }
      }
      if (size.tv) {
        await page.eval(`(window.__homeHero('play', { pad: true }), true)`);
        await sleep(300);
        await check(input, screen, at('play pad'));
      }
      // The longest subtitle, Competitive in every format: idle, then searching as the Menu runs a
      // search (its own pills: the search view and a region pill counting players, set on its
      // parts), the pills at their most crowded. Every format stays in the subtitle; a TV keeps
      // the region's name by the plate (the pills' words the dot and the hero say go first).
      await page.eval(`(window.__homeHero('play', { ranked: true }), true)`);
      await sleep(300);
      await check(input, screen, at('play ranked'), await page.eval(FORMATS));
      await page.eval(RANKED_SEARCH);
      await sleep(300);
      await check(input, screen, at('search ranked'), [...(await page.eval(FORMATS)), ...(size.tv ? await page.eval(TV_REGION) : [])]);
      await page.eval(`(document.querySelector('[data-key="hero-x"]')?.focus(), true)`);
      await sleep(200);
      await check(input, screen, at('search ranked ✕'));
      await page.eval(`(document.querySelector('[data-key="hero"]')?.focus(), true)`);
      await page.eval(SEARCH_DONE);
      await page.eval('(window.__homeHero(null), true)');
      await sleep(200);
    };
    for (const [input, screens] of runs) for (const screen of screens) {
      // Another last input (device.ts): its hints and the strip's side; the Menu fits the bars on the change.
      if (input !== own && screen === screens[0]) await page.eval(`(() => { const h = document.documentElement; h.dataset.input = ${JSON.stringify(input)}; h.classList.toggle('tg-touch', ${JSON.stringify(input)} === 'touch'); return true; })()`);
      await runScreen(input, screen);
    }
    // The largest interface size of this class (the live settings, as Ajustes writes them), then
    // back to the device's own: the next tab reads the same storage.
    if (UI_SIZE) {
      // The largest the player can pick here: Ajustes' own option (or --ui-size <pct>).
      await page.eval(`(__game.menu.open('settings', true, 'game'), true)`);
      await sleep(300);
      const big = Number(args['ui-size']) || (await page.eval(`Math.max(...[...document.querySelectorAll('[data-key^="set-ui-size-"]')].filter((b) => !b.hidden).map((b) => parseInt(b.textContent, 10)))`));
      const setSize = (v) => page.eval(`(() => { const g = __game; g.settings.ui.size = ${v}; g.applySettings(); return true; })()`);
      await setSize(big);
      await sleep(300);
      // Nothing larger than the device's own listed here (a short phone held sideways): no pass.
      // Every screen as the device's own input runs it (its states and samples: the Salas', PR 13's
      // training, summary, board and profile, PR 14's keypad and sign-in sheets), that input back on
      // the page first.
      const pass = big > (size.tv ? 125 : 100) ? SCREENS.filter((x) => x !== 'touch' && x !== 'final') : [];
      if (pass.length > 0) await page.eval(`(() => { const h = document.documentElement; h.dataset.input = ${JSON.stringify(own)}; h.classList.toggle('tg-touch', ${JSON.stringify(own)} === 'touch'); return true; })()`);
      for (const screen of pass) await runScreen(own, screen, `ui ${big}%`);
      await setSize(0);
      await sleep(200);
    }
    // The touch match (plan PR 9), last on a touch size (it plays a match in this tab).
    if (size.mobile === true && SCREENS.includes('touch')) {
      const line = async (note, bad) => {
        failures += bad.length;
        report.push({ size: size.name, lang, input: 'touch', face: FACE ?? 'Arial', note: 'touch ' + note, bad });
        console.log(`${head} ${'touch'.padEnd(8)} ${('touch ' + note).padEnd(20)} ${bad.length === 0 ? 'ok' : 'FAIL'}${bad.length ? '\n    ' + bad.join('\n    ') : ''}`);
      };
      // A finger's page: the match starts in touch mode; the cards are each shown in turn (showCard),
      // then counted as seen so the later states have none.
      await page.eval(`(() => { const h = document.documentElement; h.dataset.input = 'touch'; h.classList.add('tg-touch'); __game.startMatch(); return true; })()`);
      if (size.layout === 'portrait') {
        await sleep(1200);
        await line('rotate', await page.eval(TOUCH_CHECK('rotate', null)));
      } else if (!(await page.until('__game.touch !== null && __game.touch.visible', 15_000, 100))) await line('play', ['the touch controls never came up']);
      else {
        await sleep(400);
        for (let i = 0; i < 3; i++) {
          await page.eval(`(__game.touch.showCard(${i}), true)`);
          await sleep(250);
          await line(`card ${i + 1}`, await page.eval(TOUCH_CHECK(`card${i + 1}`, null)));
        }
        await page.eval(`(() => { localStorage.setItem('turbogol.touchCards', '3'); __game.touch.seen = 3; __game.touch.showCard(3); return true; })()`);
        await sleep(250);
        await line('play', await page.eval(TOUCH_CHECK('play', null)));
        // The board as a tap on the scorebug opens it (the overlay's own switch).
        await page.eval('(__game.touch.setBoard(true), true)');
        // The Game shows it on its next frame of logic (a slow one in a headless page).
        await page.until("document.querySelector('.hud-sb-panel').getBoundingClientRect().width > 0", 5_000, 100);
        await line('board', await page.eval(TOUCH_CHECK('board', null)));
        await page.eval('(__game.touch.setBoard(false), true)');
        const boost = await page.eval(`(() => { const r = document.querySelector('.tc-boost').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await page.eval('(__game.setPaused(true), true)');
        await sleep(400);
        await line('pause', await page.eval(TOUCH_CHECK('pause', boost)));
        await page.eval(`(__game.quitToMenu(), __game.startTraining('freeplay'), true)`);
        if (await page.until('__game.touch.visible', 15_000, 100)) {
          await sleep(400);
          await line('free play', await page.eval(TOUCH_CHECK('play', null)));
          await page.eval('(__game.setPaused(true), true)');
          await sleep(400);
          await line('pause free play', await page.eval(TOUCH_CHECK('pause', boost)));
        } else await line('free play', ['free play never came up in touch mode']);
      }
      await page.eval(`(() => { if (__game.training !== null) __game.stopTraining(); else __game.quitToMenu(); return true; })()`);
      await page.until('__game.menu.visible', 10_000, 100);
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

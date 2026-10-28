// The UI's style budget (the Tablero plan, PR 1): what the stylesheets may never do again, and how
// big they and the one font may get. Reads the files; no browser.
// Run: node --test tests/css-budget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = await walk(SRC);
const cssFiles = files.filter((f) => f.endsWith('.css'));
const css = new Map(await Promise.all(cssFiles.map(async (f) => [relative(ROOT, f).replaceAll('\\', '/'), await readFile(f, 'utf8')])));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

test('the stylesheets the UI is made of are all here', () => {
  for (const f of ['src/style.css', 'src/ui/styles/tokens.css', 'src/ui/styles/focus.css', 'src/ui/styles/shell.css', 'src/ui/styles/components.css', 'src/ui/styles/tiles.css', 'src/ui/styles/screens/home.css', 'src/ui/styles/screens/settings.css', 'src/ui/menu.css', 'src/render/training.css', 'src/input/touch.css']) assert.ok(css.has(f), f);
});

test('nothing blurs the live scene: no backdrop-filter anywhere in src (CSS or code)', async () => {
  const hits = [];
  for (const f of files) {
    if (!/\.(css|ts|tsx|js|mjs|html)$/.test(f)) continue;
    const text = await readFile(f, 'utf8');
    if (/backdrop-?filter/i.test(text)) hits.push(relative(ROOT, f));
  }
  assert.deepEqual(hits, []);
});

test('colours are written once: no colour literal under src/ui/styles/ outside tokens.css', () => {
  const bad = [];
  for (const [f, text] of css) {
    if (!f.startsWith('src/ui/styles/') || f.endsWith('/tokens.css')) continue;
    for (const m of stripComments(text).matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi)) bad.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(bad, []);
});

test('font sizes and radii are written once: none as a literal under src/ui/styles/ outside tokens.css (plan §2.4)', () => {
  const bad = [];
  const length = /(?:^|[\s(,])-?(?:\d*\.)?\d+(?:px|rem|em|pt|%|vh|vw|vmin|vmax|ch|ex)\b/;
  for (const [f, text] of css) {
    if (!f.startsWith('src/ui/styles/') || f.endsWith('/tokens.css')) continue;
    const body = stripComments(text);
    // font-size: a token (or inherit); the font shorthand's size (before the '/' of its line height) too.
    for (const m of body.matchAll(/font-size:\s*([^;}]+)/g)) if (!/^(?:var\(--t-[\w-]+\)|inherit)$/.test(m[1].trim())) bad.push(`${f}: font-size: ${m[1].trim()}`);
    for (const m of body.matchAll(/(?:^|[;{\s])font:\s*([^;}]+)/g)) if (length.test(' ' + m[1].split('/')[0])) bad.push(`${f}: font: ${m[1].trim()}`);
    // border-radius: tokens, 0 or 50 % (a circle), corner by corner.
    for (const m of body.matchAll(/border-radius:\s*([^;}]+)/g)) {
      const parts = m[1].trim().split(/\s+/);
      if (!parts.every((p) => p === '0' || p === '50%' || /^var\(--r-[\w-]+\)$/.test(p))) bad.push(`${f}: border-radius: ${m[1].trim()}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the colour tokens of the plan exist (src/ui/styles/tokens.css)', () => {
  const tokens = css.get('src/ui/styles/tokens.css');
  const need = ['ink', 'surface-0', 'surface-1', 'surface-2', 'surface-3', 'edge', 'edge-hi', 'text', 'text-2', 'text-3', 'brand', 'brand-hi', 'brand-deep', 'brand-ink', 'brand-grad', 'blue', 'blue-deep', 'red', 'red-deep', 'danger', 'warn', 'ok', 'info', 'rank-gold', 'lab', 'focus', 'veil', 'scrim'];
  for (const n of need) assert.match(tokens, new RegExp(`--${n}:`), n);
  for (const n of ['sp-1', 'sp-8', 'r-slot', 'r-key', 'r-tile', 'r-panel', 't-hero', 't-label', 'z-menus', 'z-loading', 'focus-w', 'focus-heel']) assert.match(tokens, new RegExp(`--${n}:`), n);
});

test('weights stop at 700 and Impact is gone (no face goes higher: 800 / 900 were a synthetic bold)', () => {
  const bad = [];
  for (const [f, text] of css) {
    const body = stripComments(text);
    for (const m of body.matchAll(/font-weight:\s*(\d+)/g)) if (Number(m[1]) > 700) bad.push(`${f}: ${m[0]}`);
    for (const m of body.matchAll(/(?:^|[;{\s])font:[^;}]*\b([89]00)\b/g)) bad.push(`${f}: font ${m[1]}`);
    if (/\bImpact\b/.test(body)) bad.push(`${f}: Impact`);
  }
  assert.deepEqual(bad, []);
});

/** Every rule of a sheet with the @media conditions around it: [{ selector, media: string[] }]. */
function rules(text) {
  const out = [];
  const stack = [];
  const s = stripComments(text);
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') {
      const head = buf.trim();
      buf = '';
      if (head.startsWith('@')) stack.push({ at: head });
      else {
        out.push({ selector: head, media: stack.filter((x) => x.at).map((x) => x.at) });
        stack.push({ rule: head });
      }
    } else if (c === '}') {
      stack.pop();
      buf = '';
    } else if (c === ';' && stack.length > 0 && stack[stack.length - 1].rule) buf = '';
    else buf += c;
  }
  return out;
}

/** Every innermost rule of a sheet with its declarations: [{ selector, body }]. */
const blocks = (text) => [...stripComments(text).matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));

test('the type scale has every class of the plan: PC, short screens, phone landscape, phone portrait, TV', () => {
  const tokens = stripComments(css.get('src/ui/styles/tokens.css'));
  const roles = ['t-hero', 't-display', 't-numeral', 't-title', 't-heading', 't-body', 't-small', 't-label'];
  const scope = (head) => {
    const at = tokens.indexOf(head);
    assert.ok(at >= 0, head);
    let depth = 0;
    for (let i = tokens.indexOf('{', at); i < tokens.length; i++) {
      if (tokens[i] === '{') depth++;
      else if (tokens[i] === '}' && --depth === 0) return tokens.slice(at, i);
    }
    return '';
  };
  for (const head of [':root {', '@media (orientation: landscape) and (max-height: 500px)', '@media (orientation: portrait) and (max-width: 600px)', 'html.tg-tv {']) {
    const body = scope(head);
    for (const r of roles) assert.match(body, new RegExp(`--${r}:`), `${head} ${r}`);
  }
  assert.match(scope('@media (max-height: 600px) and (min-width: 900px)'), /--t-hero:/);
});

test('one pressed state: the menus (Ajustes too), the HUD pause and training squeeze to .97', () => {
  const all = [...css.values()].flatMap(blocks);
  for (const target of ['.mn [data-nav]:active', '.hud-pause-btn:active', '.mn-slider-step:active', '.hud-rule-btn:active', '.trn-btn:active']) {
    const hit = all.find((b) => b.selector.split(',').some((sel) => sel.trim().startsWith(target)) && /transform:\s*scale\(0?\.97\)/.test(b.body));
    assert.ok(hit, target);
  }
});

test('a scroller never cuts the focus ring: every vertical scroller declares a scroll padding', () => {
  const bad = [];
  for (const [f, text] of css) {
    for (const b of blocks(text)) {
      if (!/(?:^|;)\s*overflow(?:-y)?:\s*(?:auto|scroll)/.test(b.body)) continue;
      if (b.selector === '.overlay-detail') continue; // the loading screen's error text: nothing to focus
      if (!/scroll-padding/.test(b.body)) bad.push(`${f}: ${b.selector}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the debug readout (F3) stays hidden in a match: only .hud-debug shows it (B15)', () => {
  for (const [f, text] of css) {
    for (const b of blocks(text)) {
      if (!b.selector.split(',').some((sel) => /\.hud-fps$/.test(sel.trim()))) continue;
      const display = /(?:^|;)\s*display:\s*([\w-]+)/.exec(b.body);
      if (display && display[1] !== 'none') assert.match(b.selector, /\.hud-debug /, `${f}: ${b.selector}`);
    }
  }
});

test('hover only where a pointer really hovers: every :hover sits in @media (hover: hover)', () => {
  const bad = [];
  for (const [f, text] of css) {
    for (const r of rules(text)) {
      if (!r.selector.includes(':hover')) continue;
      if (!r.media.some((m) => /\(\s*hover\s*:\s*hover\s*\)/.test(m))) bad.push(`${f}: ${r.selector.replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('super low: one switch turns off every decorative transition and animation, by class prefix', () => {
  const style = stripComments(css.get('src/style.css'));
  const block = /((?:html\.tg-superlow \[class\*='(?:mn|hud|trn|tc)-'\][^,{]*,?\s*){4})\{([^}]*)\}/.exec(style);
  assert.ok(block, 'the prefix rule');
  for (const p of ['mn', 'hud', 'trn', 'tc']) assert.ok(block[1].includes(`[class*='${p}-']`), p);
  assert.match(block[2], /transition:\s*none\s*!important/);
  assert.match(block[2], /animation:\s*none\s*!important/);
  // The informative ones stay: the spinner, hold, the busy stripe, the low / overtime clock.
  for (const keep of ['.mn-spinner', '.mn-hold', '.mn-busy', '.hud-overtime', '.hud-clock-low']) assert.ok(block[1].includes(`:not(${keep})`), keep);
});

test('the focus ring is outline + pseudo-element + a spread-only ring that super low keeps (A11)', () => {
  const focus = stripComments(css.get('src/ui/styles/focus.css'));
  assert.match(focus, /outline:\s*var\(--focus-w\) solid var\(--focus\)/);
  // The gap ring outranks super low's `html.tg-superlow * { box-shadow: none !important }` (0,1,1);
  // an edge control (shell.css --ring-shadow) has it inside instead.
  assert.match(focus, /html:not\(\.tg-touch\) \.mn \.mn-focus,[^{]*\{[^}]*box-shadow:\s*var\(--ring-shadow, 0 0 0 var\(--focus-gap\) var\(--ink\)\) !important/);
  // Touch shows no ring: every ring rule is scoped to a page whose last input was not a finger.
  for (const r of rules(focus)) if (r.selector !== '.mn [data-nav]:focus') for (const sel of r.selector.split(',')) assert.match(sel.trim(), /^html:not\(\.tg-touch\) /, sel);
  assert.doesNotMatch(focus, /:is\(/, 'plain selector lists (an old TV WebView drops a whole rule it cannot parse)');
  for (const target of ['.hud-pause-menu > .hud-pause-btn.hud-focus', '.mn .mn-set-row-ctl.mn-focus', '.trn-summary-card .trn-btn-primary', '.mn .mn-focus']) assert.ok(focus.includes(target), target);
});

// Within about 1 % of what Vite's minifier writes (comments, spaces, last semicolons and leading
// zeros out). Over the plan's §2.7 budget of 70 KB for now, an open decision for the owner: Vite's
// sheet was 69.1 kB before PR 1, which adds the tokens, the focus ring, the pressed states and the
// font faces (75,157 B by this measure); PR 4 adds the shell (styles/shell.css and components.css,
// about 16.5 KB with its review's TV, phone and slot rules) and drops the old top bar, footer,
// banner, toasts and modals of menu.css (about 5.9 KB): 86,865 B; its review's follow-up 87,430 B.
// PR 5 adds the Inicio: styles/tiles.css (hero, mode tile, plate; PR 6, 8 and 13 reuse them) and
// styles/screens/home.css, about 12.5 KB, minus the old home and Play hub rules of menu.css and the
// old tiles' no-lift rules, about 1.2 KB, plus its review's tablet and TV subtitles and TV pill row:
// 99,550 B. The cap is that plus about 0.6 KB (the owner's call for PR 5), so nothing grows
// unnoticed; the crowded top bar's pills and a TV subtitle's second line take 179 B of it
// (99,729 B). PR 6 adds MODOS (styles/screens/modes.css: its tabs, formats, rows, mn-seg,
// mn-picker, the action zone and the searching panel per class, about 13.6 KB) minus the old
// playlist cards and the guest's locked card of menu.css (about 1.5 KB). PR 7 adds the FINAL
// (styles/screens/final.css, about 10.2 KB with its short, phone and upright layouts), PARTIDO
// ENCONTRADO (found.css, 1.2 KB) and the match HUD as drawn (the goal slab, the feed, the overtime
// line, the pause dock, the scorebug and the boost plate: about 4.8 KB more than the rules they
// replace). Both together: 128,806 B, the cap that plus about 0.6 KB. PR 9 adds the touch match:
// BOOST's amount and level, the moved CAM / RESET, the first-match cards, the live rotate notice
// (touch.css, about 2.1 KB more) and the two-thumb touch pause with its half-moon hold (style.css,
// about 2 KB, with the phone's 14 px floor for its lines): 132,990 B, the cap that plus about
// 0.6 KB. PR 12 adds the Salas (styles/screens/lobby.css: SALAS' tools and rows, mn-codecells, the
// Sala, the QR sheet, per class, about 7.6 KB) minus the old lobby list and lobby screen of menu.css
// and modes.css (about 2.6 KB): 133,989 B on its own, 138,173 B with PR 9. PR 10 deletes the Hud's
// settings sheet (style.css and focus.css, about 11.1 KB) and adds Ajustes as drawn
// (styles/screens/settings.css: the rail, the rows, sliders, switches, bindings, the quality cards,
// the Experimental page, the pause overlay, per class; about 11.1 KB): 132,999 B on its own. PR 12
// and PR 10 together: 138,182 B, the cap that plus about 0.6 KB. It steps down to 70 KB once PR 15
// deletes menu.css. Raising it is the owner's call, recorded in the PR.
const CSS_BUDGET = 138_800;

test(`the CSS stays within ${(CSS_BUDGET / 1024).toFixed(1)} KB minified`, () => {
  let total = 0;
  for (const text of css.values()) {
    total += stripComments(text)
      .replace(/\s+/g, ' ')
      .replace(/\s*([{}:;,>])\s*/g, '$1')
      .replace(/;}/g, '}')
      .replace(/([^\w.])0\.(\d)/g, '$1.$2').length;
  }
  assert.ok(total <= CSS_BUDGET, `${total} B > ${CSS_BUDGET} B`);
});

test('one display font, same origin, <= 20 KB, preloaded, swapped, licensed', async () => {
  const dir = join(ROOT, 'public', 'fonts');
  const woff2 = (await readdir(dir)).filter((f) => f.endsWith('.woff2'));
  assert.deepEqual(woff2, ['tg-display-v1.woff2']);
  const file = join(dir, woff2[0]);
  const size = (await stat(file)).size;
  assert.ok(size <= 20 * 1024, `${size} B`);
  const magic = (await readFile(file)).subarray(0, 4).toString('latin1');
  assert.equal(magic, 'wOF2');
  const ofl = await readFile(join(dir, 'OFL.txt'), 'utf8');
  assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(ofl, /Copyright 2017 The Barlow Project Authors/);
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const preload = /<link rel="preload" href="\/fonts\/tg-display-v1\.woff2" as="font" type="font\/woff2" crossorigin \/>/.exec(html);
  assert.ok(preload, 'index.html preloads the font (crossorigin: fonts are CORS requests)');
  assert.ok(html.indexOf(preload[0]) < html.indexOf('src/style.css'), 'before the stylesheet');
  const tokens = stripComments(css.get('src/ui/styles/tokens.css'));
  const face = /@font-face\s*\{[^}]*font-family:\s*'TG Display';[^}]*\}/.exec(tokens);
  assert.ok(face);
  assert.match(face[0], /src:\s*url\('\/fonts\/tg-display-v1\.woff2'\) format\('woff2'\)/);
  assert.match(face[0], /font-display:\s*swap/);
  assert.match(face[0], /unicode-range:/);
  const notices = await readFile(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /Barlow Condensed/);
  assert.match(notices, /SIL Open Font License/);
});

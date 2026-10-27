// How much of the screen the menus hide from the scene (node --test tests/cover.test.mjs):
// src/ui/cover.ts, the share a touch screen's menus report to the Game (MenuHost.setMenuCover), the
// background tests read from computed styles, the cover level of the Tablero shell (menuCover) and
// the stylesheet rules it relies on. No DOM: elements are plain objects with a parent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { atOverlays, coverShare, menuCover, opaqueBackground, paintsBackground } = await import('../src/ui/cover.ts');
const { MENU_COVER_LITE, MENU_FPS, MENU_FPS_LITE, HELD_FRAME, sceneFps } = await import('../src/render/quality.ts');

/** A fake element: its parent, whether it paints a background, and `contains` along the parents. */
function el(name, parent = null, paints = false) {
  return {
    name,
    parentElement: parent,
    paints,
    contains(other) {
      for (let e = other; e !== null; e = e.parentElement) if (e === this) return true;
      return false;
    },
  };
}

test('paintsBackground: images and colours of half opacity or more hide the scene', () => {
  const s = (backgroundColor, backgroundImage = 'none') => paintsBackground({ backgroundColor, backgroundImage });
  assert.equal(s('rgba(0, 0, 0, 0)'), false, 'transparent (the computed default)');
  assert.equal(s('transparent'), false);
  assert.equal(s(''), false);
  assert.equal(s('rgba(22, 26, 34, 0.82)'), true, 'a tile');
  assert.equal(s('rgba(10, 12, 16, 0.92)'), true, 'the bottom bar');
  assert.equal(s('rgba(2, 4, 10, 0.3)'), false, 'a light veil');
  assert.equal(s('rgb(14, 17, 23)'), true, 'opaque');
  assert.equal(s('rgba(0, 0, 0, 0)', 'linear-gradient(rgb(12, 14, 20), rgba(12, 14, 20, 0.62))'), true, 'a gradient');
  assert.equal(s('color(srgb 0.1 0.1 0.1 / 0.94)'), true, 'slash syntax');
  assert.equal(s('color(srgb 0.1 0.1 0.1 / 0.2)'), false);
  assert.equal(s('rgb(22 26 34 / 40%)'), false, 'a percentage');
  assert.equal(s('oklch(0.2 0.02 260)'), true, 'any other opaque syntax');
});

test('coverShare: the grid points whose top element (or an ancestor below the root) paints', () => {
  const root = el('root');
  const stage = el('stage', root);
  const top = el('top', root, true); // the top bar: a gradient
  const tile = el('tile', stage, true);
  const label = el('label', tile); // text on a tile: covered through its parent
  const heading = el('heading', stage); // text on the stage: the scene shows through
  const other = el('other'); // another layer (a toast host outside the root)
  const paints = (e) => e.paints;
  const W = 900;
  const H = 500;
  // The top row is the bar, the bottom 3 rows are tiles (their labels in the middle columns), the
  // second row is a heading over the stage.
  const at = (x, y) => (y < 100 ? top : y < 200 ? heading : x > 300 && x < 600 ? label : tile);
  assert.equal(coverShare(root, W, H, at, paints), 4 / 5, '4 of 5 rows');
  assert.ok(coverShare(root, W, H, at, paints) > MENU_COVER_LITE, 'today\'s phone home: 20 fps');
  // The scene above a grid anchored at the bottom (the Tablero home): 2 rows of tiles.
  const anchored = (x, y) => (y < 300 ? root : tile);
  assert.equal(coverShare(root, W, H, anchored, paints), 2 / 5);
  // The root itself (its own backdrop) lets the scene through.
  assert.equal(coverShare(root, W, H, () => root, paints), 0);
  // Points under another layer say nothing: left out, and with most of them out the share is unknown.
  const toast = (x, y) => (x > 700 && y > 300 ? other : at(x, y)); // a widget over 2 of the 5 rows, 2 of 9 columns
  assert.equal(coverShare(root, W, H, toast, paints), (4 * 9 - 2 * 2) / (5 * 9 - 2 * 2));
  assert.ok(Number.isNaN(coverShare(root, W, H, () => other, paints)), 'the settings screen on top');
  assert.ok(Number.isNaN(coverShare(root, W, H, (x, y) => (y < 300 ? other : tile), paints)), 'most of it under a layer');
  assert.ok(Number.isNaN(coverShare(root, W, H, () => null, paints)));
  assert.ok(Number.isNaN(coverShare(root, 0, H, at, paints)), 'no viewport');
});

test('opaqueBackground: only a flat colour of full opacity is an opaque page (super low\'s backdrop)', () => {
  const s = (backgroundColor, backgroundImage = 'none') => opaqueBackground({ backgroundColor, backgroundImage });
  assert.equal(s('rgb(5, 7, 13)'), true, '--ink, super low\'s --mn-backdrop');
  assert.equal(s('color(srgb 0.02 0.03 0.05 / 1)'), true);
  assert.equal(s('rgba(5, 7, 13, 0.92)'), false, 'a dark veil still lets the stadium through');
  assert.equal(s('rgba(0, 0, 0, 0)', 'linear-gradient(rgba(5, 7, 13, 0.92), rgba(5, 7, 13, 0.55))'), false, 'the usual --mn-backdrop gradient');
  assert.equal(s('rgb(5, 7, 13)', 'linear-gradient(red, blue)'), false, 'an image over it: see-through by rule');
  assert.equal(s('transparent'), false);
  assert.equal(s(''), false);
});

test('menuCover: the shell reports none when hidden, opaque under a sheet or an opaque page, else partial with its share', () => {
  const c = (visible, sheet, opaqueBackdrop, covered = 0.42) => menuCover({ visible, sheet, opaqueBackdrop, covered });
  assert.deepEqual(c(false, false, false), { level: 'none', covered: 0 }, 'hidden (a match)');
  assert.deepEqual(c(false, true, true), { level: 'none', covered: 0 }, 'hidden wins (Menu.hide closes the sheet)');
  assert.deepEqual(c(true, false, false), { level: 'partial', covered: 0.42 }, 'a section root, a stacked screen, GARAJE');
  assert.deepEqual(c(true, true, false), { level: 'opaque', covered: 0 }, 'a sheet: region, leave, update, language, About, a confirm');
  assert.deepEqual(c(true, false, true), { level: 'opaque', covered: 0 }, 'super low: the shell is one flat page');
  // What the Game makes of it (quality.ts sceneFps): 30 fps, 20 on a phone past the share, one held frame.
  const fps = (m, phone = false, lite = false) => sceneFps({ cover: m.level, cap: 0, lite, still: false, animated: true, phone, covered: m.covered });
  assert.equal(fps(c(true, false, false, 0.4)), MENU_FPS);
  assert.equal(fps(c(true, false, false, 0.9), true), MENU_FPS_LITE);
  assert.equal(fps(c(true, false, false, 0.4), true), MENU_FPS, 'a phone\'s GARAJE: little hidden, 30 fps');
  assert.equal(fps(c(true, true, false)), HELD_FRAME);
  assert.equal(fps(c(true, false, true), false, true), HELD_FRAME, 'super low\'s menus hide the stadium: nothing to draw at 20 fps');
  assert.equal(fps(c(false, false, false)), 0, 'a match: its cap');
});

/**
 * A fake shell (src/ui/styles/shell.css) on a `w` x `h` touch screen: the root (its backdrop left
 * out), the bars that paint (--surface-0-94), a stage whose tiles paint where `tile(x, y)` says, a
 * toast. `layout`: 'rail' (a phone held sideways: 123 px rail, top bar, stage), 'tabs' (upright:
 * top bar, stage, a link line and the tab bar at the bottom).
 */
function shell(layout, w, h, tile, toast = null) {
  const root = el('root');
  const bar = el('bar', root, true);
  const stage = el('stage', root);
  const tileEl = el('tile', stage, true);
  const text = el('text', stage);
  const toastEl = el('toast', el('toasts', root), true);
  // elementFromPoint never returns a toast (pointer-events: none): the Menu hit-tests its box first.
  const under = (x, y) => {
    if (layout === 'rail' && x < 123) return bar;
    if (y < 56) return bar; // the top bar
    if (layout === 'tabs' && y > h - 88) return bar; // the link line and the tabs
    return tile(x, y) ? tileEl : text;
  };
  const at = atOverlays(toast === null ? [] : [{ el: toastEl, left: toast.x0, top: toast.y0, right: toast.x1, bottom: toast.y1 }], under);
  return coverShare(root, w, h, at, (e) => e.paints);
}

test('coverShare on the shell: a tiled home hides most of a phone, GARAJE\'s almost empty stage little, a toast counts', () => {
  // JUGAR's tiles over the whole stage of a phone held sideways (780 x 360): past the 70 % share.
  const home = shell('rail', 780, 360, () => true);
  assert.equal(home, 1);
  assert.ok(home > MENU_COVER_LITE);
  // GARAJE: one small card in the middle of an empty stage (the stadium shows around it).
  const garage = shell('rail', 780, 360, (x, y) => x > 300 && x < 520 && y > 150 && y < 260);
  assert.ok(garage < MENU_COVER_LITE, `GARAJE ${garage}`);
  assert.ok(garage > 0, 'the rail and the top bar still count');
  // Upright (390 x 844): top bar, tabs, a list in the upper half only.
  const upright = shell('tabs', 390, 844, (x, y) => y < 420);
  assert.ok(upright > 0.4 && upright < MENU_COVER_LITE, `upright ${upright}`);
  // A toast over the empty part of GARAJE's stage counts while it is up (measured once a second;
  // it lets clicks through, so Menu.measureCover hit-tests the toasts' boxes before elementFromPoint).
  const withToast = shell('rail', 780, 360, (x, y) => x > 300 && x < 520 && y > 150 && y < 260, { x0: 130, x1: 780, y0: 280, y1: 360 });
  assert.ok(withToast > garage, `a toast: ${withToast} over ${garage}`);
});

test('atOverlays: a box the pointer passes through (a toast) is hit first, elsewhere the lookup decides', () => {
  const root = el('root');
  const toast = el('toast', root, true);
  const below = el('stage', root);
  const at = atOverlays([{ el: toast, left: 100, top: 300, right: 400, bottom: 340 }], () => below);
  assert.equal(at(250, 320), toast, 'inside the toast');
  assert.equal(at(100, 300), toast, 'on its edge');
  assert.equal(at(99, 320), below, 'beside it');
  assert.equal(at(250, 341), below, 'under it');
  const plain = () => below;
  assert.equal(atOverlays([], plain), plain, 'no toast up: the lookup itself');
});

test('the stylesheets keep what the cover relies on: super low\'s flat backdrop on .mn, the rotate screen outside the menus', async () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
  const style = strip(await readFile(new URL('../src/style.css', import.meta.url), 'utf8'));
  const shellCss = strip(await readFile(new URL('../src/ui/styles/shell.css', import.meta.url), 'utf8'));
  const tokens = strip(await readFile(new URL('../src/ui/styles/tokens.css', import.meta.url), 'utf8'));
  const touch = strip(await readFile(new URL('../src/input/touch.css', import.meta.url), 'utf8'));
  // .mn paints --mn-backdrop; super low points it at --ink, an opaque colour (Menu.readBackdrop reads it as 'opaque').
  assert.match(shellCss, /\.mn \{[^}]*background: var\(--mn-backdrop\)/);
  assert.match(style, /html\.tg-superlow \{[^}]*--mn-backdrop: var\(--ink\)/);
  assert.match(tokens, /--ink: #[0-9a-f]{6};/i, '--ink is a six-digit colour (no alpha)');
  // The rotate screen is the match's only (Game.rotateShown: not while the menus are up, .mn-open).
  assert.match(touch, /\.tg-touch :not\(\.mn-open\) > \.tc-rotate \{/);
});

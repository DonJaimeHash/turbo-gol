// How much of the screen the menus hide from the scene (node --test tests/cover.test.mjs):
// src/ui/cover.ts, the share a touch screen's menus report to the Game (MenuHost.setMenuCover), and
// the background test read from computed styles. No DOM: elements are plain objects with a parent.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { coverShare, paintsBackground } = await import('../src/ui/cover.ts');
const { MENU_COVER_LITE } = await import('../src/render/quality.ts');

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

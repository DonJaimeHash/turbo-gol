// The menus' focus model beyond the spatial pick (src/ui/nav.ts): rows, the way back, the focus
// memory by data-key and the entry into a zone, all pure (pickTarget itself: menu-accounts.test).
//   node --test tests/nav-rows.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND' && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
      throw err;
    }
  },
});

const NAV = await import('../src/ui/nav.ts');

const R = (left, top, width = 100, height = 40) => ({ left, top, width, height, right: left + width, bottom: top + height });

test('rowStep: ◀ ▶ walk a row in DOM order and stop at either end', () => {
  assert.equal(NAV.rowStep(0, 4, 'right'), 1);
  assert.equal(NAV.rowStep(2, 4, 'right'), 3);
  assert.equal(NAV.rowStep(3, 4, 'right'), -1, 'past the end');
  assert.equal(NAV.rowStep(1, 4, 'left'), 0);
  assert.equal(NAV.rowStep(0, 4, 'left'), -1, 'before the start');
  assert.equal(NAV.rowStep(-1, 4, 'right'), -1, 'not a member');
  assert.equal(NAV.rowStep(0, 1, 'right'), -1, 'a row of one');
});

test('unionBox: the box around a row (a wrapped one too); empty is a zero box', () => {
  assert.deepEqual(NAV.unionBox([R(10, 20), R(130, 20), R(10, 80, 220, 40)]), { left: 10, top: 20, right: 230, bottom: 120, width: 220, height: 100 });
  assert.deepEqual(NAV.unionBox([]), { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
});

test('a row left from its whole box: ▼ from any card of the playlists reaches the Region row, not the far button aligned with that card', () => {
  // Casual at 1366 x 768 (measured in Edge): three cards across, the Region cycler right-aligned under them,
  // FIND MATCH far below at the left.
  const cards = [R(112, 219, 373, 110), R(497, 219, 373, 110), R(881, 219, 373, 110)];
  const region = R(964, 415, 290, 37);
  const find = R(93, 585, 196, 54);
  const others = [region, R(964, 465, 290, 37), find];
  // From the card alone the old pick prefers the button aligned under it (the bug the row fixes)...
  assert.equal(NAV.pickTarget(cards[0], 'down', others), 2);
  // ...from the row's box it is the Region row, whichever card had the focus.
  assert.equal(NAV.pickTarget(NAV.unionBox(cards), 'down', others), 0);
});

test('NavPath: the opposite arrow retraces the moves (a stack), anything else does not; a path off the focus is dropped', () => {
  const p = new NAV.NavPath();
  p.push('1v1', 'region', 'down');
  p.push('region', 'net', 'down');
  assert.equal(p.back('net', 'up'), 'region');
  p.pop();
  assert.equal(p.back('region', 'up'), '1v1');
  p.pop();
  assert.equal(p.back('1v1', 'up'), null, 'nothing left');
  p.push('a', 'b', 'right');
  assert.equal(p.back('b', 'down'), null, 'not the opposite arrow');
  assert.equal(p.back('b', 'left'), 'a');
  assert.equal(p.length, 1, 'back() alone does not pop');
  assert.equal(p.back('elsewhere', 'left'), null, 'the focus is not where the path ends');
  assert.equal(p.length, 0, 'so the path is dropped');
  for (let i = 0; i < 40; i++) p.push(i, i + 1, 'down');
  assert.ok(p.length <= 24, 'bounded');
  assert.equal(p.back(40, 'up'), 39);
  p.clear();
  assert.equal(p.back(40, 'up'), null);
});

test('FocusMemory: the same element first, else the one with its data-key (a rebuilt list), else nothing', () => {
  const m = new NAV.FocusMemory();
  const keyOf = (e) => e.key ?? null;
  const tab3 = { key: 'board-3v3' };
  const tiles = [{ key: null }, { key: null }, tab3];
  m.remember('last:leaderboard', tab3, 'board-3v3');
  assert.equal(m.recall('last:leaderboard', tiles, keyOf), tab3, 'the element itself');
  const rebuilt = [{ key: 'board-1v1' }, { key: 'board-2v2' }, { key: 'board-3v3' }];
  assert.equal(m.recall('last:leaderboard', rebuilt, keyOf), rebuilt[2], 'by key after a rebuild');
  assert.equal(m.recall('last:leaderboard', rebuilt.slice(0, 2), keyOf), null, 'gone');
  assert.equal(m.recall('last:home', tiles, keyOf), null, 'another scope');
  const plain = {};
  m.remember('stage:home', plain, null);
  assert.equal(m.recall('stage:home', [plain], keyOf), plain);
  assert.equal(m.recall('stage:home', [{}], keyOf), null, 'no key: only the element itself');
  assert.equal(m.has('stage:home'), true);
  m.forget('stage:home');
  assert.equal(m.has('stage:home'), false);
});

test('zoneEntryIndex: remembered > the zone entry > the pick that way > the nearest centre', () => {
  const from = R(100, 300);
  const bar = [R(900, 10), R(1010, 10), R(80, 10)];
  assert.equal(NAV.zoneEntryIndex(from, 'up', bar, 1, 0), 1, 'the remembered one');
  assert.equal(NAV.zoneEntryIndex(from, 'up', bar, -1, 0), 0, 'its entry');
  assert.equal(NAV.zoneEntryIndex(from, 'up', bar, -1, -1), 2, 'the one above');
  assert.equal(NAV.zoneEntryIndex(from, 'up', bar, 7, -1), 2, 'an out-of-range memory is ignored');
  // Nothing strictly that way (side by side): the nearest centre.
  assert.equal(NAV.zoneEntryIndex(R(0, 0), 'down', [R(400, 0), R(150, 0)], -1, -1), 1);
  assert.equal(NAV.zoneEntryIndex(from, 'down', [], -1, -1), -1, 'an empty zone');
});

test('OPPOSITE pairs every direction', () => {
  for (const d of ['up', 'down', 'left', 'right']) assert.equal(NAV.OPPOSITE[NAV.OPPOSITE[d]], d);
  assert.equal(NAV.OPPOSITE.up, 'down');
  assert.equal(NAV.OPPOSITE.left, 'right');
});

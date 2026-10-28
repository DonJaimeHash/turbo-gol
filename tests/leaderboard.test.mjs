// CLASIFICACIÓN's decisions (src/ui/screens/leaderboardModel.ts, plan PR 13): ◀ ▶ between the
// playlists (never round), pages for LT / RT and PgUp / PgDn, your row, the list's notice and your
// standing beside the tabs.
// Run: node --test tests/leaderboard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const M = await import('../src/ui/screens/leaderboardModel.ts');
const LISTS = ['1v1', '2v2', '3v3'];

test('◀ ▶ step the playlists and stop at either end (the phone rail is past 1v1)', () => {
  assert.equal(M.stepPlaylist(LISTS, '1v1', 1), '2v2');
  assert.equal(M.stepPlaylist(LISTS, '3v3', -1), '2v2');
  assert.equal(M.stepPlaylist(LISTS, '1v1', -1), null);
  assert.equal(M.stepPlaylist(LISTS, '3v3', 1), null);
});

test('a page is the rows in sight but one; it lands clamped, from the first row when none had the focus', () => {
  assert.equal(M.rowsPerPage(560, 56), 9);
  assert.equal(M.rowsPerPage(40, 56), 1);
  assert.equal(M.rowsPerPage(400, 0), 1);
  assert.equal(M.pageStep(0, 100, 9, 1), 9);
  assert.equal(M.pageStep(95, 100, 9, 1), 99);
  assert.equal(M.pageStep(4, 100, 9, -1), 0);
  assert.equal(M.pageStep(-1, 100, 9, 1), 0);
  assert.equal(M.pageStep(3, 0, 9, 1), -1);
});

test('your row by name; not in the top: -1', () => {
  const e = (rank, name) => ({ rank, name, mmr: 1000, tier: 'gold-1', games: 10, wins: 5 });
  const entries = [e(1, 'ana'), e(2, 'bo'), e(3, 'cy')];
  assert.equal(M.youIndex(entries, e(2, 'bo')), 1);
  assert.equal(M.youIndex(entries, e(140, 'zed')), -1);
  assert.equal(M.youIndex(entries, null), -1);
});

test("the list's notice and your standing", () => {
  assert.equal(M.listNotice(true, false, 0), 'loading');
  assert.equal(M.listNotice(false, true, 0), 'error');
  assert.equal(M.listNotice(false, false, 0), 'empty');
  assert.equal(M.listNotice(false, false, 12), null);
  assert.equal(M.standing(false, false), 'guest');
  assert.equal(M.standing(true, false), 'placement');
  assert.equal(M.standing(true, true), 'you');
});

test("a shortcut by its source: a controller's LT / RT page (whatever data-input says yet), the keyboard's Q / E step the tabs", () => {
  assert.equal(M.boardCommand('tabNext', true, false), 'pageDown');
  assert.equal(M.boardCommand('tabPrev', true, false), 'pageUp');
  assert.equal(M.boardCommand('tabNext', false, false), null);
  assert.equal(M.boardCommand('tabPrev', false, true), null);
  // Pad X and Delete: your row; the keyboard's X too, unless it cancels a search; pad Y never.
  assert.equal(M.boardCommand('context', true, false), 'me');
  assert.equal(M.boardCommand('context', false, true), 'me');
  assert.equal(M.boardCommand('cancel', false, false), 'me');
  assert.equal(M.boardCommand('cancel', false, true), null);
  assert.equal(M.boardCommand('cancel', true, false), null);
  assert.equal(M.boardCommand('next', true, false), null);
});

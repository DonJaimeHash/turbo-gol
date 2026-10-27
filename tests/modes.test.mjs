// MODOS' decisions (src/ui/screens/modesModel.ts, plan PR 6): the tabs' order and stepping, formats
// <-> playlists, the connection's queue, the "bots join in" countdown only where it is true, the
// counts' threshold and the action zone per tab.
// Run: node --test tests/modes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const M = await import('../src/ui/screens/modesModel.ts');

test('the tabs: CASUAL, COMPETITIVE, LOBBIES, VS AI; Q / E and LB / RB step them round', () => {
  assert.deepEqual(M.MODE_TABS, ['casual', 'ranked', 'lobbies', 'ai']);
  assert.equal(M.stepTab('casual', 1), 'ranked');
  assert.equal(M.stepTab('ai', 1), 'casual', 'round');
  assert.equal(M.stepTab('casual', -1), 'ai', 'round');
  assert.ok(M.isModeTab('lobbies'));
  assert.ok(!M.isModeTab('friendly'), "today's screen ids are no tabs");
});

test('formats: one playlist is itself, any is the three; an older pick of two reads as any', () => {
  assert.deepEqual(M.FORMATS, ['1v1', '2v2', '3v3', 'any']);
  assert.equal(M.formatOf(['2v2']), '2v2');
  assert.equal(M.formatOf(['1v1', '2v2', '3v3']), 'any');
  assert.equal(M.formatOf(['1v1', '3v3']), 'any');
  assert.deepEqual(M.modesOf('3v3'), ['3v3']);
  assert.deepEqual(M.modesOf('any'), ['1v1', '2v2', '3v3']);
  const a = M.modesOf('any');
  a.pop();
  assert.equal(M.modesOf('any').length, 3, 'a fresh list each time');
});

test('the connection: auto and P2P join the P2P queue, Server the server one', () => {
  assert.deepEqual(M.NET_PICKS, ['auto', 'p2p', 'server']);
  assert.equal(M.queueNet('auto'), 'p2p');
  assert.equal(M.queueNet('p2p'), 'p2p');
  assert.equal(M.queueNet('server'), 'server');
});

test('bots join in: the path the search takes, counted from its start, never for Competitive', () => {
  const base = { kind: 'casual', since: 1000, botFillMs: 10_000, p2pFillMs: 15_000 };
  assert.deepEqual(M.botsCountdown({ ...base, net: 'server', now: 4000 }), { left: 7000, total: 10_000 }, "the server queue's bot fill");
  assert.deepEqual(M.botsCountdown({ ...base, net: 'p2p', now: 4000 }), { left: 12_000, total: 15_000 }, "the P2P queue's wait");
  assert.equal(M.botsCountdown({ ...base, net: 'server', now: 11_000 }), null, 'run out: the box goes, no 0:00');
  assert.equal(M.botsCountdown({ ...base, net: 'server', botFillMs: null, now: 2000 }), null, 'a Worker that did not say');
  assert.equal(M.botsCountdown({ ...base, kind: 'ranked', net: 'server', now: 2000 }), null, 'Competitive has no bots');
  assert.deepEqual(M.botsCountdown({ ...base, net: 'server', now: 500 }), { left: 10_000, total: 10_000 }, 'a clock before the start counts 0');
});

test('the bar: segments for the time left, rounded up, within 0..n', () => {
  assert.equal(M.botsSegments(10_000, 10_000, 18), 18);
  assert.equal(M.botsSegments(1, 10_000, 18), 1);
  assert.equal(M.botsSegments(0, 10_000, 18), 0);
  assert.equal(M.botsSegments(12_000, 15_000, 18), 15);
  assert.equal(M.botsSegments(5, 0, 18), 0);
});

test('counts under the threshold are not shown', () => {
  assert.ok(!M.countShown(0, 5));
  assert.ok(!M.countShown(4, 5));
  assert.ok(M.countShown(5, 5));
  assert.ok(!M.countShown(null, 5));
});

test('the action zone per tab: search, the searching panel on its own tab, sign in, banned, play, lobbies', () => {
  const a = { tab: 'casual', signedIn: false, banLeft: 0, searching: null };
  assert.equal(M.actionKind(a), 'search', 'A on Casual searches');
  assert.equal(M.actionKind({ ...a, searching: 'casual' }), 'searching');
  assert.equal(M.actionKind({ ...a, searching: 'ranked' }), 'search', "another kind's search: this tab's own FIND MATCH");
  assert.equal(M.actionKind({ ...a, tab: 'ranked' }), 'signIn', 'a guest');
  assert.equal(M.actionKind({ ...a, tab: 'ranked', signedIn: true, banLeft: 60_000 }), 'banned');
  assert.equal(M.actionKind({ ...a, tab: 'ranked', signedIn: true }), 'search');
  assert.equal(M.actionKind({ ...a, tab: 'ranked', signedIn: true, searching: 'ranked' }), 'searching');
  assert.equal(M.actionKind({ ...a, tab: 'ai', searching: 'casual' }), 'play');
  assert.equal(M.actionKind({ ...a, tab: 'lobbies' }), 'lobbies');
});

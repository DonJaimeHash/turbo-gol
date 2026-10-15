// Accounts, ranked results and lobbies, without workerd: AccountStore runs on node:sqlite (the
// same SQL the AccountsDO runs on its SQLite storage), the Worker's password / recovery helpers on
// node's WebCrypto, the OAuth identity exchange on a fake fetch, and the pure ranked-matchmaking
// and lobby helpers. Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const DO_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: DO_STUB, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND') {
        if (!/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
        if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
});

const S = await import('../src/accountStore.ts');
const A = await import('../src/accountRoutes.ts');
const ADO = await import('../src/AccountsDO.ts');
const M = await import('../src/MatchmakerDO.ts');
const L = await import('../src/LobbyDO.ts');
const D = await import('../src/LobbyDirectoryDO.ts');
const ACC = await import('../../src/net/account.ts');
const RT = await import('../../src/net/rating.ts');

/** node:sqlite behind the slice of ctx.storage.sql the store uses (exec(...).toArray()) + transactionSync. */
function makeStore() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? stmt.all(...bindings) : (stmt.run(...bindings), []);
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
  let depth = 0;
  const tx = (fn) => {
    if (depth > 0) return fn();
    depth++;
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      depth--;
    }
  };
  const store = new S.AccountStore(sql, tx);
  store.migrate();
  store.migrate(); // idempotent
  return { store, db };
}

const H = (c) => c.repeat(64).slice(0, 64);
const PW = { hash: H('a'), salt: H('b').slice(0, 32), iter: 100000 };
const NOW = 1_800_000_000_000;

test('register / credentials / unique usernames (case-insensitive)', () => {
  const { store } = makeStore();
  const u = store.register('Mariana', PW, [H('1')], H('r'), NOW);
  assert.match(u.userId, /^[0-9a-f]{16}$/);
  assert.equal(store.register('mariana', PW, [], H('s'), NOW), 'taken');
  assert.equal(store.register('MARIANA', PW, [], H('t'), NOW), 'taken');
  const c = store.credentials('MaRiAnA');
  assert.equal(c.userId, u.userId);
  assert.equal(c.username, 'Mariana');
  assert.equal(c.hash, PW.hash);
  assert.equal(store.credentials('nobody'), null);
  const me = store.me(u.userId, NOW);
  assert.deepEqual(me.providers, ['password']);
  assert.equal(me.ratings.length, 3);
  assert.equal(me.ratings[0].mmr, 1000);
  assert.equal(me.ratings[0].tier, null, 'placement');
  assert.equal(me.ratings[0].placementLeft, RT.PLACEMENT_MATCHES);
});

test('refresh tokens: rotation, single use, expiry, per-user cap, sign-out everywhere', () => {
  const { store } = makeStore();
  const u = store.register('alice', PW, [], H('1'), NOW);
  const r = store.rotateRefresh(H('1'), H('2'), NOW + 1000);
  assert.equal(r.userId, u.userId);
  assert.equal(store.rotateRefresh(H('1'), H('3'), NOW + 2000), null, 'the old token is gone (rotation)');
  assert.equal(store.rotateRefresh(H('2'), H('4'), NOW + S.REFRESH_TTL_MS + 5000), null, 'expired');
  store.addRefresh(u.userId, H('5'), NOW);
  for (let i = 0; i < 12; i++) store.addRefresh(u.userId, String(i).padStart(64, 'c'), NOW + 10 + i);
  assert.equal(store.refreshOwner(H('5'), NOW + 100), null, 'oldest dropped past REFRESH_PER_USER');
  assert.equal(store.refreshOwner('11'.padStart(64, 'c'), NOW + 100).userId, u.userId);
  store.deleteRefreshOf(u.userId, '11'.padStart(64, 'c'));
  assert.equal(store.refreshOwner('10'.padStart(64, 'c'), NOW + 100), null);
  assert.ok(store.refreshOwner('11'.padStart(64, 'c'), NOW + 100), 'kept the caller');
});

test('recovery codes: one use each, password replaced, every session signed out', () => {
  const { store } = makeStore();
  const u = store.register('bob', PW, [H('x'), H('y')], H('1'), NOW);
  const pw2 = { ...PW, hash: H('d') };
  assert.equal(store.recover('bob', H('z'), pw2, H('2'), NOW), null, 'unknown code');
  const r = store.recover('BOB', H('x'), pw2, H('2'), NOW);
  assert.equal(r.userId, u.userId);
  assert.equal(r.codesLeft, 1);
  assert.equal(store.credentials('bob').hash, H('d'));
  assert.equal(store.refreshOwner(H('1'), NOW), null, 'old sessions gone');
  assert.ok(store.refreshOwner(H('2'), NOW), 'new session');
  assert.equal(store.recover('bob', H('x'), pw2, H('3'), NOW), null, 'used up');
});

test('oauth: sign-up with a unique derived name, sign-in again, link, already linked elsewhere', () => {
  const { store } = makeStore();
  store.register('Jose_Perez', PW, [], H('1'), NOW);
  const g = store.oauth('google', 'g-123', 'José Pérez', null, H('2'), NOW);
  assert.equal(g.created, true);
  assert.notEqual(g.username.toLowerCase(), 'jose_perez', 'taken name gets a suffix');
  assert.match(g.username, /^Jose_Perez\d+$|^Jose_Pere\d+$|^Jose_Per\d+$/);
  const again = store.oauth('google', 'g-123', 'whatever', null, H('3'), NOW);
  assert.equal(again.userId, g.userId);
  assert.equal(again.created, false);
  const me = store.me(g.userId, NOW);
  assert.deepEqual(me.providers, ['google']);
  assert.equal(me.hasPassword, false);
  const alice = store.register('alice', PW, [], H('4'), NOW);
  assert.equal(store.oauth('discord', 'd-9', 'x', alice.userId, H('5'), NOW).userId, alice.userId);
  assert.deepEqual(store.me(alice.userId, NOW).providers, ['password', 'discord']);
  assert.equal(store.oauth('google', 'g-123', 'x', alice.userId, H('6'), NOW), 'already_linked');
  assert.equal(S.usernameFromDisplay('  Ñandú  Feliz!! '), 'Nandu_Feliz');
  assert.equal(S.usernameFromDisplay('x').length, 3);
  assert.equal(ACC.usernameProblem(S.usernameFromDisplay('Guest Person')), null, 'never a reserved prefix');
});

test('rename: taken, once per 30 days', () => {
  const { store } = makeStore();
  const a = store.register('anna', PW, [], H('1'), NOW);
  store.register('bert', PW, [], H('2'), NOW);
  assert.equal(store.rename(a.userId, 'BERT', NOW), 'taken');
  assert.equal(store.rename(a.userId, 'Annie', NOW).username, 'Annie');
  assert.equal(store.rename(a.userId, 'Anita', NOW + 1000), 'too_soon');
  assert.equal(store.rename(a.userId, 'Anita', NOW + S.RENAME_EVERY_MS + 1).username, 'Anita');
  assert.equal(store.credentials('anita').userId, a.userId);
});

test('ranked: result rated once (idempotent), placement, leaver ban, locks, check, leaderboard', () => {
  const { store } = makeStore();
  const ids = ['p1', 'p2', 'p3', 'p4'].map((n, i) => store.register(n, PW, [], H(String(i)), NOW).userId);
  store.rankedLock('m1', 'SA', ids, NOW + 600_000);
  const chk = store.rankedCheck(ids[0], ['2v2'], NOW);
  assert.deepEqual(chk.active, { matchId: 'm1', region: 'SA' });
  assert.equal(chk.ratings['2v2'].mmr, 1000);
  const input = { matchId: 'm1', playlist: '2v2', region: 'SA', winner: 0, blue: 3, red: 1, players: [
    { id: ids[0], team: 0, left: false }, { id: ids[1], team: 0, left: false }, { id: ids[2], team: 1, left: true }, { id: ids[3], team: 1, left: false },
  ] };
  assert.equal(store.applyRankedResult(input, NOW), true);
  assert.equal(store.applyRankedResult(input, NOW), false, 'second report ignored');
  assert.equal(store.rankedCheck(ids[0], ['2v2'], NOW).active, null, 'unlocked');
  const w = store.rankedResultFor('m1', ids[0], NOW);
  assert.equal(w.status, 'done');
  assert.equal(w.outcome, 'win');
  assert.ok(w.mmrAfter > w.mmrBefore);
  assert.equal(w.placementLeft, RT.PLACEMENT_MATCHES - 1);
  assert.equal(w.tierAfter, null);
  const leaver = store.rankedResultFor('m1', ids[2], NOW);
  assert.equal(leaver.left, true);
  assert.equal(leaver.banUntil, NOW + RT.ABANDON_BANS_MS[0]);
  assert.equal(store.rankedCheck(ids[2], ['2v2'], NOW).banUntil, NOW + RT.ABANDON_BANS_MS[0]);
  const mate = store.rankedResultFor('m1', ids[3], NOW);
  const lost = leaver.mmrBefore - leaver.mmrAfter;
  assert.ok(mate.mmrBefore - mate.mmrAfter < lost, 'protected teammate loses less');
  assert.equal(store.rankedResultFor('nope', ids[0], NOW).status, 'pending');
  // Play out placement for p1 / p2 and check the board.
  for (let g = 2; g <= RT.PLACEMENT_MATCHES; g++) {
    store.applyRankedResult({ ...input, matchId: 'm' + g, players: input.players.map((p) => ({ ...p, left: false })) }, NOW + g);
  }
  const placed = store.rankedResultFor('m' + RT.PLACEMENT_MATCHES, ids[0], NOW);
  assert.equal(placed.placementLeft, 0);
  assert.ok(placed.tierAfter, 'placed: a tier');
  const board = store.leaderboard('2v2', 10, ids[0]);
  assert.equal(board.total, 4);
  assert.equal(board.entries[0].games, RT.PLACEMENT_MATCHES);
  assert.ok(board.entries[0].mmr >= board.entries[3].mmr);
  assert.ok(['p1', 'p2'].includes(board.entries[0].name));
  assert.ok(board.you.rank <= 2);
  assert.equal(store.leaderboard('1v1', 10, null).total, 0);
});

test('ranked: abandons escalate inside 24 h; a cancel penalises only the no-shows; prune', () => {
  const { store } = makeStore();
  const a = store.register('quitter', PW, [], H('1'), NOW).userId;
  const b = store.register('patient', PW, [], H('2'), NOW).userId;
  assert.equal(store.cancelRanked('c1', '1v1', 'SA', [a, b], [a], 'no_show', NOW), true);
  assert.equal(store.cancelRanked('c1', '1v1', 'SA', [a, b], [a], 'no_show', NOW), false);
  assert.deepEqual(store.rankedResultFor('c1', b, NOW), { status: 'cancelled', reason: 'no_show' });
  assert.equal(store.banUntil(b, NOW), 0);
  assert.equal(store.banUntil(a, NOW), NOW + RT.ABANDON_BANS_MS[0]);
  store.cancelRanked('c2', '1v1', 'SA', [a, b], [a], 'dodge', NOW + 1000);
  assert.equal(store.banUntil(a, NOW + 1000), NOW + 1000 + RT.ABANDON_BANS_MS[1]);
  assert.equal(store.me(a, NOW + 2000).abandons24h, 2);
  store.prune(NOW + RT.ABANDON_WINDOW_MS + 10_000);
  assert.equal(store.me(a, NOW + RT.ABANDON_WINDOW_MS + 10_000).abandons24h, 0);
  assert.equal(store.banUntil(a, NOW + RT.ABANDON_WINDOW_MS + 10_000), 0);
});

test('Worker crypto: client key deterministic per normalised username, server hash verifies, recovery codes canonicalise', async () => {
  const k1 = await ACC.clientPasswordKey('Mariana', 'correct horse');
  const k2 = await ACC.clientPasswordKey('MARIANA', 'correct horse');
  const k3 = await ACC.clientPasswordKey('mariana', 'correct horsf');
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
  assert.ok(ACC.isClientKey(k1));
  const rec = await A.newPasswordRecord(k1);
  assert.equal(rec.iter, A.SERVER_KDF_ITERATIONS);
  assert.equal(await A.verifyPassword(k1, rec), true);
  assert.equal(await A.verifyPassword(k3, rec), false);
  assert.equal(await A.verifyPassword(k1, { hash: undefined, salt: undefined, iter: undefined }), false);
  const code = A.newRecoveryCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(await A.recoveryCodeHash(code.toLowerCase().replace('-', ' ')), await A.recoveryCodeHash(code));
  assert.equal(await A.recoveryCodeHash('ab0d-efgh'), await A.recoveryCodeHash('ABOD EFGH'), 'O read as 0');
});

test('username / password rules', () => {
  assert.equal(ACC.usernameProblem('Tomi_10'), null);
  assert.ok(ACC.usernameProblem('ab'));
  assert.ok(ACC.usernameProblem('_tomi'));
  assert.ok(ACC.usernameProblem('Guest-1234'));
  assert.ok(ACC.usernameProblem('admin'));
  assert.ok(ACC.usernameProblem('ñandu'), 'ASCII only');
  assert.equal(ACC.passwordProblem('a good passphrase', 'tomi'), null);
  assert.ok(ACC.passwordProblem('short', 'tomi'));
  assert.ok(ACC.passwordProblem('password', 'tomi'));
  assert.ok(ACC.passwordProblem('mytomi123', 'Tomi'));
  assert.ok(ACC.passwordProblem('aaaaaaaaaa', 'x'));
});

test('login throttle: free failures, then a doubling lock capped at 15 min; a new window starts over', () => {
  let e;
  for (let i = 0; i < ADO.LOGIN_FAILS_FREE - 1; i++) e = ADO.nextFail(e, NOW);
  assert.equal(e.lockedUntil, 0);
  e = ADO.nextFail(e, NOW);
  assert.equal(e.lockedUntil, NOW + 30_000);
  e = ADO.nextFail(e, NOW);
  assert.equal(e.lockedUntil, NOW + 60_000);
  for (let i = 0; i < 10; i++) e = ADO.nextFail(e, NOW);
  assert.equal(e.lockedUntil, NOW + ADO.LOGIN_LOCK_MAX_MS);
  assert.equal(ADO.nextFail(e, NOW + 16 * 60_000).count, 1);
});

test('oauthIdentity: code exchange with PKCE + client secret, then the user endpoint (Google sub, Discord id)', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('token')) return new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 });
    if (url.includes('googleapis')) return new Response(JSON.stringify({ sub: 'g1', name: 'Ana Gómez', given_name: 'Ana' }), { status: 200 });
    return new Response(JSON.stringify({ id: 'd1', username: 'ana_d', global_name: null }), { status: 200 });
  };
  const env = { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gs', DISCORD_CLIENT_ID: 'did', DISCORD_CLIENT_SECRET: 'ds' };
  assert.deepEqual(A.enabledProviders(env), ['google', 'discord']);
  assert.deepEqual(A.enabledProviders({ GOOGLE_CLIENT_ID: 'x' }), [], 'a half-configured provider stays off');
  const g = await A.oauthIdentity(A.providerConfig(env, 'google'), 'google', 'CODE', 'VERIFIER', 'https://x/cb', fake);
  assert.deepEqual(g, { id: 'g1', name: 'Ana' });
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('code_verifier'), 'VERIFIER');
  assert.equal(form.get('client_secret'), 'gs');
  assert.equal(form.get('redirect_uri'), 'https://x/cb');
  assert.equal(calls[1].init.headers.authorization, 'Bearer AT');
  const d = await A.oauthIdentity(A.providerConfig(env, 'discord'), 'discord', 'C', 'V', 'https://x/cb', fake);
  assert.deepEqual(d, { id: 'd1', name: 'ana_d' });
  const bad = await A.oauthIdentity(A.providerConfig(env, 'google'), 'google', 'C', 'V', 'u', async () => new Response('no', { status: 400 }));
  assert.equal(bad, null);
});

// ---- ranked matchmaking ---------------------------------------------------------------------------

test('rankedWindow grows 100 -> 600 MMR, then anything after 150 s', () => {
  assert.equal(M.rankedWindow(0), 100);
  assert.equal(M.rankedWindow(9_999), 100);
  assert.equal(M.rankedWindow(10_000), 150);
  assert.equal(M.rankedWindow(120_000), 600);
  assert.equal(M.rankedWindow(M.RANKED_ANY_AFTER_MS), Infinity);
});

test('pickRankedGroup: both windows must accept; the oldest anchor that can form a group; the closest fits', () => {
  const w = (id, mmr, joinedAt) => ({ playerId: id, joinedAt, mu: mmr / 40 });
  const t = 1_000_000;
  assert.equal(M.pickRankedGroup([w('a', 1000, t), w('b', 1300, t)], 2, t), null, '300 apart, both fresh');
  assert.deepEqual(M.pickRankedGroup([w('a', 1000, t), w('b', 1080, t)], 2, t).map((x) => x.playerId), ['a', 'b']);
  // a has waited 60 s (window 400) but b is fresh (100): b must accept too.
  assert.equal(M.pickRankedGroup([w('a', 1000, t - 60_000), w('b', 1300, t)], 2, t), null);
  assert.deepEqual(M.pickRankedGroup([w('a', 1000, t - 60_000), w('b', 1300, t - 60_000)], 2, t).map((x) => x.playerId), ['a', 'b']);
  const four = [w('a', 1000, t - 5), w('b', 1500, t - 4), w('c', 1050, t - 3), w('d', 990, t - 2), w('e', 1020, t - 1)];
  assert.deepEqual(M.pickRankedGroup(four, 4, t).map((x) => x.playerId), ['a', 'd', 'e', 'c'], 'b (500 away) left out, closest first');
  assert.deepEqual(M.pickRankedGroup([w('a', 2000, t - 10), w('b', 1000, t - 5), w('c', 1010, t)], 2, t).map((x) => x.playerId), ['b', 'c'], 'a cannot anchor: the next oldest does');
  assert.equal(M.pickRankedGroup([w('a', 1000, t)], 2, t), null);
});

test('balanceTeams: the split with the smallest summed-mu difference (2v2 and 3v3)', () => {
  const g = [30, 20, 26, 24].map((mu) => ({ mu }));
  const [blue, red] = M.balanceTeams(g, 2);
  const sum = (ix) => ix.reduce((s, i) => s + g[i].mu, 0);
  assert.equal(sum(blue), sum(red), '30+20 vs 26+24');
  const g3 = [40, 10, 25, 25, 30, 20].map((mu) => ({ mu }));
  const [b3, o3] = M.balanceTeams(g3, 3);
  assert.equal(b3.length, 3);
  assert.equal(Math.abs(b3.reduce((s, i) => s + g3[i].mu, 0) - o3.reduce((s, i) => s + g3[i].mu, 0)), 0);
  assert.deepEqual(M.balanceTeams([{ mu: 1 }, { mu: 2 }], 1), [[0], [1]]);
});

test('buildTeamRoster: fixed teams, humans first then bots, slots in order', () => {
  const r = M.buildTeamRoster(3, [[{ playerId: 'a', name: 'A' }], [{ playerId: 'b', name: 'B' }, { playerId: 'c', name: 'C' }]], 'player');
  assert.deepEqual(r.map((e) => [e.slot, e.team, e.kind, e.playerId ?? null]), [
    [0, 0, 'player', 'a'], [1, 0, 'bot', null], [2, 0, 'bot', null], [3, 1, 'player', 'b'], [4, 1, 'player', 'c'], [5, 1, 'bot', null],
  ]);
});

// ---- lobbies --------------------------------------------------------------------------------------

test('lobby helpers: names, codes, team for a newcomer, refit on a playlist change', () => {
  assert.equal(L.sanitizeLobbyName('  Sala   de   Tomi!  '), 'Sala de Tomi!');
  assert.equal(L.sanitizeLobbyName('ab'), null);
  assert.equal(L.sanitizeLobbyName('x'.repeat(25)), null);
  const code = D.randomCode();
  assert.equal(code.length, D.CODE_LENGTH);
  assert.equal(D.normalizeCode(code.toLowerCase().slice(0, 3) + '-' + code.slice(3)), code);
  assert.equal(D.normalizeCode('ABC12'), null);
  assert.equal(D.normalizeCode('ABCDE1'), null, '1 is not in the alphabet');
  assert.equal(L.teamForNewMember([], 2), 0);
  assert.equal(L.teamForNewMember([{ team: 0 }], 2), 1);
  assert.equal(L.teamForNewMember([{ team: 0 }, { team: 1 }], 2), 0);
  assert.equal(L.teamForNewMember([{ team: 1 }, { team: 1 }], 2), 0);
  assert.equal(L.teamForNewMember([{ team: 0 }, { team: 1 }], 1), null);
  const members = [{ id: 'm1', team: 0, joinedAt: 1 }, { id: 'm2', team: 0, joinedAt: 2 }, { id: 'm3', team: 1, joinedAt: 3 }];
  const fit = L.refitTeams(members, 1);
  assert.equal(fit, null, '3 players do not fit a 1v1');
  const two = L.refitTeams([{ id: 'm1', team: 0, joinedAt: 1 }, { id: 'm2', team: 0, joinedAt: 2 }], 1);
  assert.deepEqual([...two.entries()], [['m1', 0], ['m2', 1]], 'the newest moves');
  const s = L.parseLobbySettings({ mode: '3v3', matchLengthSeconds: 0, net: 'server' }, L.defaultLobbySettings('Sala'));
  assert.deepEqual(s, { name: 'Sala', mode: '3v3', visibility: 'public', net: 'server', matchLengthSeconds: 0 });
  assert.equal(L.parseLobbySettings({ matchLengthSeconds: 7 }, s), 'bad_length');
  assert.equal(L.parseLobbySettings({ mode: '4v4' }, s), 'bad_mode');
});

test('listLobbies: public and fresh only, own region first, open with room before full / in game', () => {
  const now = 10_000_000;
  const row = (code, o, vis = 'public', age = 0) => ({ lobbyId: code, visibility: vis, updatedAt: now - age, summary: { code, name: code, mode: '2v2', players: 1, max: 4, locked: false, host: 'h', region: 'SA', inGame: false, net: 'p2p', ...o } });
  const list = D.listLobbies([
    row('EU1', { region: 'EU', players: 3 }),
    row('FULL', { players: 4 }),
    row('GAME', { inGame: true }),
    row('OPEN2', { players: 2 }),
    row('OPEN1', {}),
    row('PRIV', {}, 'private'),
    row('OLD', {}, 'public', 20 * 60_000),
  ], 'SA', now);
  assert.deepEqual(list.map((l) => l.code), ['OPEN2', 'OPEN1', 'FULL', 'GAME', 'EU1']);
});

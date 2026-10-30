// The cosmetic cars and the hosts' shop on the server, without workerd: AccountStore's inventory,
// car pick, wallet, claims, freezes and grants on node:sqlite (the AccountsDO's SQL), the session's
// `car` / `since` claims (accountRoutes.ts accountSession, auth.ts verifySession), and the Worker's
// /api/me/items, /api/me/car, /api/me/shop, /api/me/shop/claim (and the /nodes/shop aliases) in
// front of a real AccountsDO, plus what /api/queue and /api/lobbies take from the session for the
// seat (index.ts seatFields: never the body). The catalog is nodes/control-plane/shop.ts's (its cars
// src/game/cosmetics.ts's): a test that needs a car to be claimable pins its status for the test, so
// none depends on which bodies are built. 'cloudflare:workers' and MatchDO's wasm are stubbed.
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const DO_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
const WASM_STUB = 'data:text/javascript,export const createHostArena = () => { throw new Error("no wasm in this test"); };';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: DO_STUB, shortCircuit: true };
    if (specifier === './wasm' && context.parentURL !== undefined && context.parentURL.endsWith('/server/src/MatchDO.ts')) return { url: WASM_STUB, shortCircuit: true };
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
const { AccountsDO } = await import('../src/AccountsDO.ts');
const { accountSession, LIMIT_COSMETIC_WRITES } = await import('../src/accountRoutes.ts');
const worker = (await import('../src/index.ts')).default;
const { signJwt, createSession, verifySession, verifyJwt, INTERNAL_HEADER, internalSecret } = await import('../src/auth.ts');
const { CATALOG, catalogItem } = await import('../../nodes/control-plane/shop.ts');
const { CAR_IDS, DEFAULT_CAR } = await import('../../src/game/cosmetics.ts');

const SECRET = 'host-shop-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const H = (c) => c.repeat(64).slice(0, 64);
const PW = { hash: H('a'), salt: H('b').slice(0, 32), iter: 100000 };
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;
const NODE = 'a1b2c3d4e5f60718';
/** A node match id (64 hex) per test credit. */
let nextMatch = 0;
const matchId = () => (++nextMatch).toString(16).padStart(64, '0');

/** node:sqlite behind ctx.storage.sql (exec(...).toArray()) and transactionSync. */
function sqlOn(db) {
  return {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? stmt.all(...bindings) : (stmt.run(...bindings), []);
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
}

function txOn(db) {
  let depth = 0;
  return (fn) => {
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
}

function makeStore() {
  const db = new DatabaseSync(':memory:');
  const store = new S.AccountStore(sqlOn(db), txOn(db));
  store.migrate();
  store.migrate(); // idempotent with the shop's tables
  return { store, db };
}

/** Run `fn` with catalog item `id` pinned to `status` (whichever bodies are built today). */
async function withStatus(id, status, fn) {
  const it = catalogItem(id);
  const was = it.status;
  it.status = status;
  try {
    return await fn();
  } finally {
    it.status = was;
  }
}

const credit = (store, userId, points, verified = true, at = NOW) => store.hostCredit({ matchId: matchId(), userId, nodeId: NODE, points, verified, at });

// ---- AccountStore ----------------------------------------------------------------------------------

test('AccountStore: a fresh account drives the default car; every sign-in path hands its session the car and the creation time', () => {
  const { store } = makeStore();
  const reg = store.register('Ana', PW, [], H('1'), NOW);
  assert.equal(reg.car, DEFAULT_CAR);
  assert.equal(reg.createdAt, NOW);
  const id = reg.userId;
  for (const [what, ref] of [
    ['signedIn', store.signedIn(id, H('2'), NOW + 1)],
    ['rotateRefresh', store.rotateRefresh(H('2'), H('3'), NOW + 2)],
    ['refreshOwner', store.refreshOwner(H('3'), NOW + 3)],
    ['rename', store.rename(id, 'Ana2', NOW + 4)],
  ]) {
    assert.equal(ref.userId, id, what);
    assert.equal(ref.car, DEFAULT_CAR, what);
    assert.equal(ref.createdAt, NOW, `${what}: the account's creation, not the call's`);
  }
  const o = store.createFromPending({ p: 'google', id: 'g-1', email: null, trust: 'none' }, 'Beto', H('4'), NOW + 5);
  assert.deepEqual([o.car, o.createdAt], [DEFAULT_CAR, NOW + 5]);
  const again = store.oauth('google', 'g-1', null, H('5'), NOW + 6);
  assert.deepEqual([again.userId, again.car, again.createdAt], [o.userId, DEFAULT_CAR, NOW + 5]);
  assert.deepEqual(store.items(id), { items: [], car: DEFAULT_CAR, cars: [DEFAULT_CAR] });
  assert.equal(store.items('ffffffffffffffff'), 'no_user');
});

test('AccountStore: a car is driven only while it is owned: picked after a grant, given up on a revoke', () => {
  const { store, db } = makeStore();
  const a = store.register('Ana', PW, [], H('1'), NOW).userId;
  assert.equal(store.setCar(a, 'tero', NOW), 'not_owned');
  assert.equal(store.setCar('ffffffffffffffff', DEFAULT_CAR, NOW), 'no_user');
  assert.deepEqual(store.grant(a, 'tero', NOW), { granted: true, items: ['tero'] }, 'a grant takes any status: the body may still be to come');
  assert.deepEqual(store.grant(a, 'tero', NOW + 1), { granted: false, items: ['tero'] }, 'idempotent');
  assert.equal(store.grant(a, 'car-next-1', NOW), 'unknown_item');
  assert.equal(store.grant('ffffffffffffffff', 'tero', NOW), 'no_user');
  const ref = store.setCar(a, 'tero', NOW + 2);
  assert.deepEqual([ref.userId, ref.username, ref.car, ref.createdAt], [a, 'Ana', 'tero', NOW]);
  assert.equal(store.signedIn(a, H('2'), NOW + 3).car, 'tero', 'the next session carries it');
  assert.deepEqual(store.items(a), { items: ['tero'], car: 'tero', cars: ['dune', 'tero'] }, 'cars in menu order');
  assert.equal(store.wallet(a).spent, 0, 'a grant costs nothing');
  assert.deepEqual(store.revoke(a, 'tero'), { revoked: true, refunded: 0, items: [] });
  assert.deepEqual(store.revoke(a, 'tero'), { revoked: false, refunded: 0, items: [] });
  assert.equal(store.equippedCar(a), DEFAULT_CAR, 'a revoked car gives way to the default');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM loadout').get().n, 0, 'its pick went with it');
  assert.equal(store.signedIn(a, H('4'), NOW + 4).car, DEFAULT_CAR);
  // A pick the account no longer owns, or junk, reads as the default car.
  db.prepare('INSERT INTO loadout (user_id, car, updated_at) VALUES (?, ?, ?)').run(a, 'condor', NOW);
  assert.equal(store.equippedCar(a), DEFAULT_CAR);
  db.prepare('UPDATE loadout SET car = ? WHERE user_id = ?').run('not-a-car', a);
  assert.equal(store.equippedCar(a), DEFAULT_CAR);
  assert.equal(store.setCar(a, DEFAULT_CAR, NOW + 5).car, DEFAULT_CAR, 'the default car is everyone\'s');
});

test('AccountsDO /equipped (a lobby\'s start): the car each account drives now; an unknown or banned account is left out; at most a 3v3\'s ids', async () => {
  const { env, store, db } = makeEnv();
  const a = store.register('Ana', PW, [], H('1'), NOW).userId;
  const b = store.register('Beto', PW, [], H('2'), NOW).userId;
  const c = store.register('Caro', PW, [], H('3'), NOW).userId;
  store.grant(a, 'tero', NOW);
  store.setCar(a, 'tero', NOW);
  store.grant(b, 'condor', NOW);
  store.setCar(b, 'condor', NOW);
  store.revoke(b, 'condor');
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(c);
  const ask = async (body) => {
    const res = await env.ACCOUNTS.get().fetch('https://accounts/equipped', { method: 'POST', headers: { [INTERNAL_HEADER]: await internalSecret(SECRET), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  assert.deepEqual(await ask({ userIds: [a, b, c, 'ffffffffffffffff'] }), { status: 200, json: { cars: { [a]: 'tero', [b]: DEFAULT_CAR } } });
  assert.equal((await ask({ userIds: Array.from({ length: 7 }, () => a) })).status, 400);
  assert.equal((await ask({ userIds: [3] })).status, 400);
  assert.equal((await ask({})).status, 400);
});

test('AccountStore wallet: one credit per match, a claim spends its cost once, the balance never goes below 0, nothing of it is pruned', async () => {
  const { store, db } = makeStore();
  const a = store.register('Ana', PW, [], H('1'), NOW).userId;
  const b = store.register('Beto', PW, [], H('2'), NOW).userId;
  assert.deepEqual(store.wallet(a), { earned: 0, spent: 0, balance: 0, frozen: null });
  // The free host badge needs one verified hosted match that served someone else: one the operator
  // played alone on their node (verified, 0 points) counts for nothing (ledger.ts countsAsHosted).
  assert.equal(store.claim(a, 'badge-host', NOW), 'requires_matches');
  assert.equal(store.hostCredit({ matchId: matchId(), userId: a, nodeId: NODE, points: 0, verified: true, at: NOW }), true);
  assert.equal(store.claim(a, 'badge-host', NOW), 'requires_matches', 'an operator-only match');
  const m = matchId();
  assert.equal(store.hostCredit({ matchId: m, userId: a, nodeId: NODE, points: 1000.004, verified: true, at: NOW }), true);
  assert.equal(store.hostCredit({ matchId: m, userId: a, nodeId: NODE, points: 1000, verified: true, at: NOW }), false, 'the outbox delivering it twice credits it once');
  assert.equal(store.wallet(a).earned, 1000);
  const badge = store.claim(a, 'badge-host', NOW + 1);
  assert.deepEqual([badge.item, badge.claimed, badge.wallet.spent, badge.items], ['badge-host', true, 0, ['badge-host']]);
  await withStatus('pampero', 'available', () => {
    assert.equal(store.claim(a, 'pampero', NOW + 2), 'insufficient', '1,000 of 1,500');
    credit(store, a, 600);
    const r = store.claim(a, 'pampero', NOW + 3);
    assert.equal(r.claimed, true);
    assert.deepEqual(r.wallet, { earned: 1600, spent: 1500, balance: 100, frozen: null });
    assert.deepEqual(r.items, ['badge-host', 'pampero']);
    const retry = store.claim(a, 'pampero', NOW + 4);
    assert.equal(retry.claimed, false, 'a retried claim spends nothing twice');
    assert.deepEqual(retry.wallet, r.wallet);
    assert.equal(store.claim(b, 'pampero', NOW), 'insufficient', 'points are the host\'s own: nothing to transfer');
  });
  await withStatus('carpincho', 'soon', () => assert.equal(store.claim(a, 'carpincho', NOW), 'not_available'));
  assert.equal(store.claim(a, 'nope-item', NOW), 'unknown_item');
  assert.equal(store.claim('ffffffffffffffff', 'badge-host', NOW), 'no_user');
  // A revoked claim gives its cost back; nothing ever makes the balance negative.
  assert.deepEqual(store.revoke(a, 'pampero'), { revoked: true, refunded: 1500, items: ['badge-host'] });
  assert.equal(store.wallet(a).balance, 1600);
  db.prepare("INSERT INTO host_claims (user_id, item_id, cost, at, source) VALUES (?, 'goal-next-1', 5000, ?, 'claim')").run(b, NOW);
  assert.equal(store.wallet(b).balance, 0, 'a row that would make it negative (none can be written) still reads 0');
  // The daily prune keeps every credit and claim.
  store.prune(NOW + 400 * DAY);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM host_credits').get().n, 3, "the operator-only match's 0 too");
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM host_claims').get().n, 2);
  assert.equal(store.wallet(a).earned, 1600);
});

test('AccountStore freeze: a failed verification pauses claims until a maintainer unfreezes; the outbox delivering it again after that freezes nothing', async () => {
  const { store } = makeStore();
  const a = store.register('Ana', PW, [], H('1'), NOW).userId;
  credit(store, a, 2000);
  assert.equal(store.hostFreeze(a, 'verification_failed:m1', NOW + 10), true);
  assert.equal(store.frozen(a), 'verification_failed:m1');
  assert.equal(store.hostFreeze(a, 'verification_failed:m2', NOW + 20), false, 'a freeze in force keeps its first reason');
  assert.equal(store.wallet(a).frozen, 'verification_failed:m1');
  await withStatus('condor', 'available', () => {
    assert.equal(store.claim(a, 'condor', NOW + 30), 'frozen');
    assert.equal(store.unfreeze(a, NOW + 40), true);
    assert.equal(store.unfreeze(a, NOW + 41), false, 'nothing left to unfreeze');
    assert.equal(store.hostFreeze(a, 'verification_failed:m1', NOW + 10), false, 'the same event delivered again');
    assert.equal(store.hostFreeze(a, 'verification_failed:m2', NOW + 20), false, 'an event from before the review');
    assert.equal(store.frozen(a), null);
    assert.equal(store.claim(a, 'condor', NOW + 50).claimed, true);
    assert.equal(store.hostFreeze(a, 'verification_failed:m3', NOW + 60), true, 'a new failure freezes again');
    assert.equal(store.shop(a).wallet.frozen, 'verification_failed:m3');
  });
  // A maintainer's clock behind the event's: still cleared.
  const b = store.register('Beto', PW, [], H('2'), NOW).userId;
  store.hostFreeze(b, 'verification_failed:m4', NOW + 100);
  assert.equal(store.unfreeze(b, NOW + 50), true);
  assert.equal(store.frozen(b), null);
});

test('AccountStore shop: the catalog as the account sees it (claimable first), owned items flagged, the default car never listed', async () => {
  const { store } = makeStore();
  const a = store.register('Ana', PW, [], H('1'), NOW).userId;
  credit(store, a, 1500);
  await withStatus('tero', 'available', async () => {
    await withStatus('pampero', 'soon', () => {
      store.grant(a, 'pampero', NOW);
      const s = store.shop(a);
      assert.deepEqual(s.wallet, { earned: 1500, spent: 0, balance: 1500, frozen: null });
      assert.deepEqual(new Set(s.items.map((i) => i.id)), new Set(CATALOG.map((i) => i.id)));
      assert.ok(!s.items.some((i) => i.id === DEFAULT_CAR));
      const byId = Object.fromEntries(s.items.map((i) => [i.id, i]));
      assert.deepEqual([byId.tero.claimable, byId.tero.blocked, byId.tero.owned, byId.tero.cost, byId.tero.nameKey], [true, undefined, false, 1500, 'car.tero']);
      assert.deepEqual([byId.pampero.owned, byId.pampero.claimable, byId.pampero.blocked], [true, false, undefined], 'owned: no reason to show');
      assert.equal(byId['boost-next-1'].blocked, 'not_available');
      assert.equal(byId['badge-host'].claimable, true, 'one verified match');
      const firstSoon = s.items.findIndex((i) => i.status !== 'available');
      assert.ok(s.items.slice(firstSoon).every((i) => i.status !== 'available'), 'available items first');
    });
  });
  assert.equal(store.shop('ffffffffffffffff'), 'no_user');
});

// ---- the session's car -----------------------------------------------------------------------------

test('the session: an account\'s car is signed only when it is not the default, with its creation time; verifySession keeps both only on an account session and a known car', async () => {
  const env = { JWT_SECRET: SECRET };
  const s = await accountSession(env, { userId: 'a1b2c3d4e5f60718', username: 'Ana', car: 'tero', createdAt: NOW - 10 * DAY }, NOW);
  assert.equal(s.car, 'tero');
  const c = await verifyJwt(SECRET, s.session, Math.floor(NOW / 1000));
  assert.deepEqual([c.acct, c.car, c.since], [1, 'tero', Math.floor((NOW - 10 * DAY) / 1000)]);
  const plain = await accountSession(env, { userId: 'a1b2c3d4e5f60718', username: 'Ana', car: DEFAULT_CAR, createdAt: NOW }, NOW);
  assert.equal(plain.car, DEFAULT_CAR, 'the answer says which car');
  assert.equal((await verifyJwt(SECRET, plain.session, Math.floor(NOW / 1000))).car, undefined, 'the token carries only another one');
  const old = await accountSession(env, { userId: 'a1b2c3d4e5f60718', username: 'Ana' }, NOW);
  assert.equal(old.car, DEFAULT_CAR, 'a UserRef without a car (an older AccountsDO): the default');
  const iat = Math.floor(Date.now() / 1000);
  const token = (extra) => signJwt(SECRET, { sub: 'a1b2c3d4e5f60718', name: 'Ana', iat, exp: iat + 3600, ...extra });
  const kept = await verifySession(SECRET, await token({ acct: 1, car: 'pampero', since: 1234 }));
  assert.deepEqual([kept.car, kept.since], ['pampero', 1234]);
  for (const extra of [{ car: 'pampero', since: 1234 }, { acct: 1, car: 'car-next-1', since: 'x' }, { acct: 1, car: 7, since: null }]) {
    const v = await verifySession(SECRET, await token(extra));
    assert.ok(v, 'the session itself stands');
    assert.deepEqual([v.car, v.since], [undefined, undefined], JSON.stringify(extra));
  }
});

// ---- the Worker in front of a real AccountsDO -----------------------------------------------------------

/** A fake namespace that records each call and answers `handler(path, body)`. */
function fakeNs(handler) {
  const calls = [];
  return {
    calls,
    ns: {
      idFromName: (n) => n,
      idFromString: (s) => s,
      newUniqueId: () => ({ toString: () => 'ab'.repeat(32) }),
      get: () => ({
        fetch: async (url, init) => {
          const u = new URL(url);
          const body = init && init.body ? JSON.parse(init.body) : null;
          calls.push({ path: u.pathname, body });
          return new Response(JSON.stringify(handler(u.pathname, body)), { headers: { 'content-type': 'application/json' } });
        },
      }),
    },
  };
}

/** The Worker with a real AccountsDO; the matchmaker and the lobbies are fakes that record what the seat carries. No node settings. */
function makeEnv() {
  const db = new DatabaseSync(':memory:');
  let alarm = null;
  const mm = fakeNs(() => ({ status: 'waiting', waiting: 1 }));
  const lobby = fakeNs(() => ({ ok: true }));
  const dir = fakeNs((path) => (path === '/allocate' ? { code: 'ABCDEF' } : path === '/resolve' ? { lobbyId: 'ab'.repeat(32) } : { ok: true }));
  const env = { JWT_SECRET: SECRET, VITE_ORIGINS: ORIGIN, FLAGS: { get: async () => null }, MATCHMAKER: mm.ns, LOBBY: lobby.ns, LOBBY_DIR: dir.ns };
  const ctx = {
    storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t) },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const obj = new AccountsDO(ctx, env);
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => obj.fetch(new Request(url, init)) }) };
  return { env, obj, store: obj.store, mm, lobby, db };
}

let ipCount = 0;
async function call(env, method, path, { token, body } = {}) {
  const headers = { 'CF-Connecting-IP': `198.51.100.${++ipCount % 250}`, Origin: ORIGIN };
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

const accountToken = (sub, extra = {}) => signJwt(SECRET, { sub, name: 'Ana', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, acct: 1, ...extra });

const ROUTES = [
  ['GET', '/api/me/items', undefined],
  ['POST', '/api/me/car', { car: 'tero' }],
  ['GET', '/api/me/shop', undefined],
  ['POST', '/api/me/shop/claim', { item: 'tero' }],
  ['GET', '/nodes/shop', undefined],
  ['POST', '/nodes/shop/claim', { item: 'tero' }],
];

test('Worker: the inventory and shop routes need an account: 401 without a session, 403 account_required for a guest (the /nodes/shop aliases too)', async () => {
  const { env } = makeEnv();
  const guest = (await createSession(SECRET, '0123456789abcdef', 'Invitado')).token;
  for (const [method, path, body] of ROUTES) {
    assert.equal((await call(env, method, path, { body })).status, 401, `${method} ${path} without a session`);
    const r = await call(env, method, path, { body, token: guest });
    assert.equal(r.status, 403, `${method} ${path} as a guest`);
    assert.equal(r.json.error, 'account_required');
  }
});

test('Worker: items, then a car picked: 409 until it is owned, then a fresh session that carries it; uncached; the default car takes it out of the token', async () => {
  const { env, store } = makeEnv();
  const id = store.register('Ana', PW, [], H('1'), Date.now()).userId;
  const token = await accountToken(id);
  let r = await call(env, 'GET', '/api/me/items', { token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { items: [], car: DEFAULT_CAR, cars: [DEFAULT_CAR] });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  r = await call(env, 'POST', '/api/me/car', { token, body: { car: 'tero' } });
  assert.deepEqual([r.status, r.json.error], [409, 'not_owned']);
  for (const bad of [{}, { car: 'Tero' }, { car: 'car-next-1' }, { car: 3 }]) assert.deepEqual([(await call(env, 'POST', '/api/me/car', { token, body: bad })).json.error], ['bad_car'], JSON.stringify(bad));
  store.grant(id, 'tero', Date.now());
  r = await call(env, 'POST', '/api/me/car', { token, body: { car: 'tero' } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.kind, r.json.playerId, r.json.name, r.json.car], ['account', id, 'Ana', 'tero']);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const claims = await verifySession(SECRET, r.json.session);
  assert.deepEqual([claims.acct, claims.car], [1, 'tero']);
  assert.equal(typeof claims.since, 'number', 'with the account\'s age');
  assert.deepEqual((await call(env, 'GET', '/api/me/items', { token })).json, { items: ['tero'], car: 'tero', cars: ['dune', 'tero'] });
  r = await call(env, 'POST', '/api/me/car', { token, body: { car: DEFAULT_CAR } });
  assert.equal(r.json.car, DEFAULT_CAR);
  assert.equal((await verifySession(SECRET, r.json.session)).car, undefined);
});

test('Worker: a car pick re-signs the session without extending it (a token 60 s from expiry stays so); a banned account can neither pick nor claim', async () => {
  const { env, store, db } = makeEnv();
  const id = store.register('Ana', PW, [], H('1'), Date.now()).userId;
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = await accountToken(id, { exp });
  store.grant(id, 'tero', Date.now());
  let r = await call(env, 'POST', '/api/me/car', { token, body: { car: 'tero' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.expiresAt, exp * 1000, "the Bearer's exp, not a fresh hour");
  const again = await call(env, 'POST', '/api/me/car', { token: r.json.session, body: { car: DEFAULT_CAR } });
  assert.deepEqual([again.status, (await verifySession(SECRET, again.json.session)).exp], [200, exp], 'and re-signing that one extends nothing either');
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(id);
  db.prepare('DELETE FROM refresh').run();
  r = await call(env, 'POST', '/api/me/car', { token, body: { car: 'tero' } });
  assert.deepEqual([r.status, r.json.error, r.json.session], [404, 'no_user', undefined]);
  r = await call(env, 'POST', '/api/me/shop/claim', { token, body: { item: 'badge-host' } });
  assert.deepEqual([r.status, r.json.error], [404, 'no_user']);
});

test('Worker: the shop and a claim round trip (a retry spends nothing twice); /nodes/shop answers the same without the node settings; refusals keep their codes', async () => {
  const { env, store } = makeEnv();
  const id = store.register('Ana', PW, [], H('1'), Date.now()).userId;
  const token = await accountToken(id);
  credit(store, id, 1600);
  await withStatus('pampero', 'available', async () => {
    const shop = await call(env, 'GET', '/api/me/shop', { token });
    assert.equal(shop.status, 200);
    assert.equal(shop.headers.get('cache-control'), 'no-store');
    assert.deepEqual(shop.json.wallet, { earned: 1600, spent: 0, balance: 1600, frozen: null });
    assert.equal(shop.json.items.find((i) => i.id === 'pampero').claimable, true);
    const alias = await call(env, 'GET', '/nodes/shop', { token });
    assert.equal(alias.status, 200, 'no NODES binding here: the alias is AccountsDO\'s');
    assert.deepEqual(alias.json, shop.json);
    let r = await call(env, 'POST', '/api/me/shop/claim', { token, body: { item: 'pampero' } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.item, r.json.claimed, r.json.wallet.balance, r.json.items], ['pampero', true, 100, ['pampero']]);
    r = await call(env, 'POST', '/nodes/shop/claim', { token, body: { itemId: 'pampero' } });
    assert.deepEqual([r.status, r.json.claimed, r.json.wallet.balance], [200, false, 100], 'the reference server\'s `itemId` too; owned: nothing spent');
    assert.deepEqual((await call(env, 'GET', '/api/me/items', { token })).json.cars, ['dune', 'pampero']);
  });
  await withStatus('condor', 'available', async () => {
    const r = await call(env, 'POST', '/api/me/shop/claim', { token, body: { item: 'condor' } });
    assert.deepEqual([r.status, r.json.error], [409, 'insufficient']);
  });
  await withStatus('condor', 'soon', async () => assert.deepEqual((await call(env, 'POST', '/api/me/shop/claim', { token, body: { item: 'condor' } })).json.error, 'not_available'));
  let r = await call(env, 'POST', '/api/me/shop/claim', { token, body: { item: 'no-such-item' } });
  assert.deepEqual([r.status, r.json.error], [404, 'unknown_item']);
  for (const bad of [{}, { item: 'A' }, { item: '../x' }, { item: 7 }]) assert.equal((await call(env, 'POST', '/api/me/shop/claim', { token, body: bad })).json.error, 'bad_item', JSON.stringify(bad));
  store.hostFreeze(id, 'verification_failed:x', Date.now());
  await withStatus('tero', 'available', async () => assert.equal((await call(env, 'POST', '/api/me/shop/claim', { token, body: { item: 'tero' } })).json.error, 'frozen'));
  r = await call(env, 'GET', '/api/me/shop', { token: await accountToken('ffffffffffffffff') });
  assert.deepEqual([r.status, r.json.error], [404, 'no_user']);
});

test('Worker: picking a car and claiming share a write budget per account and minute (429 rate_limited)', async () => {
  const { env, store } = makeEnv();
  const id = store.register('Carla', PW, [], H('1'), Date.now()).userId;
  const token = await accountToken(id);
  let limitedAt = 0;
  for (let i = 1; i <= LIMIT_COSMETIC_WRITES + 1; i++) {
    const r = await call(env, 'POST', '/api/me/car', { token, body: { car: DEFAULT_CAR } });
    if (r.status === 429 && limitedAt === 0) limitedAt = i;
  }
  assert.equal(limitedAt, LIMIT_COSMETIC_WRITES + 1);
  assert.equal((await call(env, 'POST', '/api/me/shop/claim', { token, body: { item: 'badge-host' } })).status, 429);
  assert.equal((await call(env, 'GET', '/api/me/items', { token })).status, 200, 'reads have their own budget');
});

test('Worker: a queue seats the session\'s car and account age, never a car from the body; a guest\'s seat has neither', async () => {
  const { env, mm } = makeEnv();
  const since = Math.floor((Date.now() - 10 * DAY - 60_000) / 1000);
  const joins = () => mm.calls.filter((c) => c.path === '/join').map((c) => c.body);
  await call(env, 'POST', '/api/queue', { token: await accountToken('a1b2c3d4e5f60718', { car: 'tero', since }), body: { mode: '1v1', kind: 'server', car: 'condor' } });
  let j = joins().at(-1);
  assert.deepEqual([j.playerId, j.car, j.account, j.accountAgeDays], ['a1b2c3d4e5f60718', 'tero', true, 10]);
  await call(env, 'POST', '/api/queue', { token: await accountToken('b1b2c3d4e5f60718'), body: { mode: '1v1', kind: 'server', car: 'condor' } });
  j = joins().at(-1);
  assert.deepEqual([j.car, j.account, j.accountAgeDays], [undefined, true, undefined], 'an account on the default car (and a token from before `since`)');
  const guest = (await createSession(SECRET, '0123456789abcdef', 'Invitado')).token;
  await call(env, 'POST', '/api/queue', { token: guest, body: { mode: '1v1', kind: 'server', car: 'condor' } });
  j = joins().at(-1);
  assert.deepEqual(Object.keys(j).filter((k) => ['car', 'account', 'accountAgeDays'].includes(k)), [], 'a guest: none of them');
  // A guest token that carries a car claim (forged or stale) still seats the default car.
  const forged = await signJwt(SECRET, { sub: '0123456789abcdef', name: 'X', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60, car: 'tero' });
  await call(env, 'POST', '/api/queue', { token: forged, body: { mode: '1v1', kind: 'server' } });
  assert.equal(joins().at(-1).car, undefined);
});

test('Worker: a lobby\'s host and each admitted member take the car of their session (LobbyDO keeps it with the seat)', async () => {
  const { env, lobby } = makeEnv();
  const settings = { name: 'Sala', mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: 300 };
  assert.equal((await call(env, 'POST', '/api/lobbies', { token: await accountToken('a1b2c3d4e5f60718', { car: 'tero' }), body: { ...settings, car: 'condor' } })).status, 200);
  const create = lobby.calls.find((c) => c.path === '/internal/create');
  assert.deepEqual([create.body.host.car, create.body.host.guest], ['tero', false]);
  assert.equal((await call(env, 'POST', '/api/lobbies/join', { token: await accountToken('b1b2c3d4e5f60718', { car: 'pampero' }), body: { code: 'ABCDEF', car: 'condor' } })).status, 200);
  assert.equal(lobby.calls.filter((c) => c.path === '/internal/admit').at(-1).body.car, 'pampero');
  const guest = (await createSession(SECRET, '0123456789abcdef', 'Invitado')).token;
  assert.equal((await call(env, 'POST', '/api/lobbies/join', { token: guest, body: { code: 'ABCDEF', car: 'condor' } })).status, 200);
  assert.equal('car' in lobby.calls.filter((c) => c.path === '/internal/admit').at(-1).body, false);
});

test('every catalog car can be granted, picked and seated: the session carries each one', async () => {
  const { store } = makeStore();
  const a = store.register('Ana', PW, [], H('1'), NOW).userId;
  for (const id of CAR_IDS) {
    if (id !== DEFAULT_CAR) store.grant(a, id, NOW);
    const ref = store.setCar(a, id, NOW);
    const s = await accountSession({ JWT_SECRET: SECRET }, ref, NOW);
    assert.equal(s.car, id);
    assert.equal((await verifyJwt(SECRET, s.session, Math.floor(NOW / 1000))).car, id === DEFAULT_CAR ? undefined : id);
  }
});

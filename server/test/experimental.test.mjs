// Settings > Experimental on the server: the switch and the physics presets in AccountStore
// (node:sqlite, the AccountsDO's SQL), and the Worker's /api/me/experimental and /api/me/presets
// routes in front of a real AccountsDO: account only (401 / 403 for a guest), validation with the
// shared table (src/game/physicsRules.ts), the 10-preset cap, the 4 KB body, the rate limit,
// no-store answers, MeInfo.experimental. 'cloudflare:workers' and MatchDO's wasm are stubbed.
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { makeAccount } from './helpers/accounts.mjs';

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
const { LIMIT_EXPERIMENTAL_WRITES } = await import('../src/accountRoutes.ts');
const worker = (await import('../src/index.ts')).default;
const { signJwt, createSession } = await import('../src/auth.ts');
const R = await import('../../src/game/physicsRules.ts');

const SECRET = 'experimental-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const H = (c) => c.repeat(64).slice(0, 64);
const NOW = 1_800_000_000_000;

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
  return (fn) => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
}

function makeStore() {
  const db = new DatabaseSync(':memory:');
  const store = new S.AccountStore(sqlOn(db), txOn(db));
  store.migrate();
  store.migrate(); // idempotent with the new tables
  return { store, db };
}

const preset = (n, values = {}) => ({ id: n.toString(16).padStart(12, '0'), name: `Rules ${n}`, values, updatedAt: 0 });

test('AccountStore: the switch defaults off, is set per account and shows in MeInfo', () => {
  const { store } = makeStore();
  const a = makeAccount(store, 'Ana', { now: NOW, refresh: H('1') }).userId;
  const b = makeAccount(store, 'Beto', { now: NOW, refresh: H('2') }).userId;
  assert.deepEqual(store.experimental(a), { enabled: false, presets: [] });
  assert.equal(store.me(a, NOW).experimental, false);
  assert.deepEqual(store.setExperimental(a, true, NOW), { enabled: true, presets: [] });
  assert.equal(store.me(a, NOW).experimental, true);
  assert.equal(store.me(b, NOW).experimental, false, 'per account');
  store.setExperimental(a, false, NOW + 1);
  assert.equal(store.experimentalEnabled(a), false);
  assert.equal(store.experimental('ffffffffffffffff'), 'no_user');
  assert.equal(store.setExperimental('ffffffffffffffff', true, NOW), 'no_user');
});

test('AccountStore presets: upsert, rename, the server stamp, oldest first, delete, 11th refused, per account', () => {
  const { store, db } = makeStore();
  const a = makeAccount(store, 'Ana', { now: NOW, refresh: H('1') }).userId;
  const b = makeAccount(store, 'Beto', { now: NOW, refresh: H('2') }).userId;
  let r = store.upsertPreset(a, preset(1, { gravity: 50 }), NOW);
  assert.deepEqual(r.presets, [{ id: '000000000001', name: 'Rules 1', values: { gravity: 50 }, updatedAt: NOW }]);
  store.upsertPreset(a, preset(2), NOW + 5);
  r = store.upsertPreset(a, { ...preset(1, { gravity: 60 }), name: 'Moon' }, NOW + 9);
  assert.deepEqual(r.presets.map((p) => [p.id, p.name, p.values, p.updatedAt]), [
    ['000000000001', 'Moon', { gravity: 60 }, NOW + 9],
    ['000000000002', 'Rules 2', {}, NOW + 5],
  ], 'a rename keeps its place (created_at), the stamp moves');
  for (let i = 3; i <= R.MAX_PRESETS; i++) assert.notEqual(store.upsertPreset(a, preset(i), NOW + i), 'too_many');
  assert.equal(store.upsertPreset(a, preset(11), NOW), 'too_many');
  assert.notEqual(store.upsertPreset(a, { ...preset(3), name: 'Still fits' }, NOW), 'too_many', 'replacing one at the cap is fine');
  assert.equal(store.presets(a).length, R.MAX_PRESETS);
  assert.deepEqual(store.presets(b), [], 'per account');
  r = store.deletePreset(a, '000000000002');
  assert.equal(r.presets.length, R.MAX_PRESETS - 1);
  assert.equal(store.deletePreset(a, '0000000000ff').presets.length, R.MAX_PRESETS - 1, 'an unknown id: the same list');
  assert.equal(store.upsertPreset('ffffffffffffffff', preset(1), NOW), 'no_user');
  // A stored row of an older schema still reads (lenient): unknown keys dropped, values snapped.
  db.prepare('UPDATE presets SET data = ? WHERE preset_id = ?').run(JSON.stringify({ gravity: 47, retired: 3 }), '000000000001');
  db.prepare('UPDATE presets SET data = ? WHERE preset_id = ?').run('{broken', '000000000003');
  const read = store.presets(a);
  assert.deepEqual(read[0].values, { gravity: 50 });
  assert.deepEqual(read.find((p) => p.id === '000000000003').values, {});
});

// ---- the Worker in front of a real AccountsDO -------------------------------------------------------

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  let alarm = null;
  const env = { JWT_SECRET: SECRET, VITE_ORIGINS: ORIGIN, FLAGS: { get: async () => null } };
  const ctx = {
    storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t) },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const obj = new AccountsDO(ctx, env);
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => obj.fetch(new Request(url, init)) }) };
  return { env, obj };
}

let ipCount = 0;
async function call(env, method, path, { token, body, raw } = {}) {
  const headers = { 'CF-Connecting-IP': `198.51.100.${++ipCount % 250}`, Origin: ORIGIN };
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env);
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

const accountToken = (sub, name = 'Ana') => signJwt(SECRET, { sub, name, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, acct: 1 });

test('Worker: every experimental route needs an account: 401 without a session, 403 account_required for a guest', async () => {
  const { env } = makeEnv();
  const guest = (await createSession(SECRET, '0123456789abcdef', 'Invitado')).token;
  const routes = [
    ['GET', '/api/me/experimental', undefined],
    ['POST', '/api/me/experimental', { enabled: true }],
    ['POST', '/api/me/presets', { preset: preset(1) }],
    ['POST', '/api/me/presets/delete', { id: '000000000001' }],
  ];
  for (const [method, path, body] of routes) {
    assert.equal((await call(env, method, path, { body })).status, 401, `${method} ${path} without a session`);
    const r = await call(env, method, path, { body, token: guest });
    assert.equal(r.status, 403, `${method} ${path} as a guest`);
    assert.equal(r.json.error, 'account_required');
  }
});

test('Worker: the switch and the presets round trip, uncached; MeInfo carries the switch', async () => {
  const { env, obj } = makeEnv();
  const id = makeAccount(obj.store, 'Ana', { now: Date.now(), refresh: H('1') }).userId;
  const token = await accountToken(id);
  let r = await call(env, 'GET', '/api/me/experimental', { token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { enabled: false, presets: [] });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  r = await call(env, 'POST', '/api/me/experimental', { token, body: { enabled: true } });
  assert.deepEqual(r.json, { enabled: true, presets: [] });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await call(env, 'GET', '/api/me', { token })).json.experimental, true);
  r = await call(env, 'POST', '/api/me/presets', { token, body: { preset: { id: '0123456789ab', name: '  Low   gravity ', values: { gravity: 47, ballDrag: 50, unknown: 4, gameSpeed: 50 }, updatedAt: 1 } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.presets.length, 1);
  const p = r.json.presets[0];
  assert.deepEqual([p.id, p.name, p.values], ['0123456789ab', 'Low gravity', { gravity: 50, gameSpeed: 50, ballDrag: 50 }], 'lenient: snapped, unknown dropped, free-play keys kept for training');
  assert.ok(p.updatedAt > 1, 'the server stamps it');
  r = await call(env, 'POST', '/api/me/presets/delete', { token, body: { id: '0123456789ab' } });
  assert.deepEqual(r.json, { enabled: true, presets: [] });
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('Worker: bad bodies get 400 (bad_request / bad_preset), the 11th preset 409 too_many, a body over 4 KB is refused', async () => {
  const { env, obj } = makeEnv();
  const id = makeAccount(obj.store, 'Beto', { now: Date.now(), refresh: H('1') }).userId;
  const token = await accountToken(id, 'Beto');
  const post = (path, body) => call(env, 'POST', path, { token, body });
  assert.equal((await post('/api/me/experimental', { enabled: 'yes' })).status, 400);
  assert.equal((await call(env, 'POST', '/api/me/experimental', { token, raw: '{nope' })).status, 400);
  for (const bad of [
    undefined,
    { id: 'standard', name: 'Standard', values: {} },
    { id: 'ABCDEF012345', name: 'Upper', values: {} },
    { id: '0123456789ab', name: 'ab', values: {} },
    { id: '0123456789ab', name: 7, values: {} },
  ]) {
    const r = await post('/api/me/presets', { preset: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.error, 'bad_preset');
  }
  assert.equal((await post('/api/me/presets/delete', { id: '../etc' })).json.error, 'bad_preset');
  const huge = { preset: { id: '0123456789ab', name: 'Huge', values: Object.fromEntries(Array.from({ length: 400 }, (_, i) => ['key' + i, i])) } };
  assert.ok(JSON.stringify(huge).length > 4096);
  assert.equal((await post('/api/me/presets', huge)).status, 400, 'over readJson cap');
  for (let i = 1; i <= R.MAX_PRESETS; i++) assert.equal((await post('/api/me/presets', { preset: preset(i) })).status, 200);
  const r = await post('/api/me/presets', { preset: preset(11) });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'too_many');
  // The largest preset the table allows is far under the cap.
  const full = Object.fromEntries(R.PHYSICS_FIELDS.map((f) => [f.key, R.fieldValues(f).at(-1) === f.default ? R.fieldValues(f)[0] : R.fieldValues(f).at(-1)]));
  assert.ok(JSON.stringify({ preset: { id: '0123456789ab', name: 'X'.repeat(24), values: full } }).length < 1024);
});

test('Worker: writes are limited per account and minute (429 rate_limited); another account is not', async () => {
  const { env, obj } = makeEnv();
  const id = makeAccount(obj.store, 'Carla', { now: Date.now(), refresh: H('1') }).userId;
  const other = makeAccount(obj.store, 'Dani', { now: Date.now(), refresh: H('2') }).userId;
  const token = await accountToken(id, 'Carla');
  let limitedAt = 0;
  for (let i = 1; i <= LIMIT_EXPERIMENTAL_WRITES + 2; i++) {
    const r = await call(env, 'POST', '/api/me/experimental', { token, body: { enabled: i % 2 === 0 } });
    if (r.status === 429 && limitedAt === 0) limitedAt = i;
  }
  assert.equal(limitedAt, LIMIT_EXPERIMENTAL_WRITES + 1);
  assert.equal((await call(env, 'POST', '/api/me/presets', { token, body: { preset: preset(1) } })).status, 429, 'presets share the write budget');
  assert.equal((await call(env, 'GET', '/api/me/experimental', { token })).status, 200, 'reads have their own');
  assert.equal((await call(env, 'POST', '/api/me/experimental', { token: await accountToken(other, 'Dani'), body: { enabled: true } })).status, 200);
});

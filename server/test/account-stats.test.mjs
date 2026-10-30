// The owner's account counts (the sign-in design's PR 0): AccountStore.accountStats on node:sqlite,
// and GET /nodes/admin/account-stats through the Worker (index.ts, nodeRoutes.ts) in front of a real
// AccountsDO and, for the node operators, a stub or a real NodeRegistryDO. Counts and booleans only,
// never an id, a name or an address; the maintainer gate (a trusted account's own session, not a
// TV's, fresh) refuses everyone else before the AccountsDO is asked; its limit; the node operators
// travel from the object to AccountsDO and never into the answer.
// 'cloudflare:workers' and MatchDO's wasm are stubbed by the resolve hook (match.test.mjs). Run
// from server/: npm test
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

// The control plane's auth timer (10 s) must never keep the test process alive.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = realSetTimeout(fn, ms, ...args);
  t.unref?.();
  return t;
};
const realLog = console.log;
console.log = (...args) => {
  if (process.env.NODELOG) realLog(...args);
};

const worker = (await import('../src/index.ts')).default;
const S = await import('../src/accountStore.ts');
const { AccountsDO } = await import('../src/AccountsDO.ts');
const { NodeRegistryDO } = await import('../src/NodeRegistryDO.ts');
const { accountGate, LIMITS } = await import('../src/limits.ts');
const { createSession, signJwt } = await import('../src/auth.ts');
const { generateEd25519 } = await import('../../nodes/shared/edcrypto.ts');

const SECRET = 'account-stats-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const NOW = Date.now();
const DAY = 24 * 60 * 60_000;
const H = (c) => c.repeat(64).slice(0, 64);
const PW = { hash: H('a'), salt: H('b').slice(0, 32), iter: 100000 };

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

/**
 * The fixture: every kind of account the counts tell apart. Returns the store, the database and
 * every id, name, address and provider id it holds (none of them may ever reach an answer).
 */
function fixture(store, db) {
  const secrets = [];
  const reg = (name, last = NOW) => {
    const id = store.register(name, PW, [], H(String(secrets.length % 10)), NOW - 100 * DAY).userId;
    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(last, id);
    secrets.push(id, name);
    return id;
  };
  // An OAuth account is made by the confirm step (createFromPending), a link by oauth (sign-in PR 6).
  const oauth = (p, pid, name, linkTo = null) => {
    const r = linkTo === null ? store.createFromPending({ p, id: pid, email: null, trust: 'none' }, name, H('e'), NOW - 100 * DAY) : store.oauth(p, pid, linkTo, H('e'), NOW - 100 * DAY);
    secrets.push(r.userId, r.username, pid);
    return r.userId;
  };
  const old = NOW - 60 * DAY;
  // Password only: active and rated, with points and an item; with an unproved hint; idle and empty; a node operator; suspended.
  const ana = reg('AnaRated');
  db.prepare("INSERT INTO ratings (user_id, playlist, season, mu, sigma, games, wins, losses, peak_mmr, last_played) VALUES (?, '1v1', 1, 26, 7, 3, 2, 1, 0, ?)").run(ana, NOW - DAY);
  db.prepare('INSERT INTO host_credits (match_id, user_id, node_id, points, verified, at) VALUES (?, ?, ?, 4.5, 1, ?)').run(H('7'), ana, 'b'.repeat(16), NOW - DAY);
  db.prepare("INSERT INTO host_claims (user_id, item_id, cost, at, source) VALUES (?, 'badge-host', 0, ?, 'claim')").run(ana, NOW - DAY);
  const hinted = reg('BetoHint', old);
  db.prepare("UPDATE users SET email_hint = 'beto.secret@discord-mail.com', email_hint_canon = 'beto.secret@discord-mail.com', email_hint_from = 'discord' WHERE id = ?").run(hinted);
  secrets.push('beto.secret@discord-mail.com');
  const idle = reg('CaroIdle', old);
  const operator = reg('DaniNodes', old);
  const banned = reg('EliBanned', old);
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(banned);
  // A refresh within 30 days makes an account active even without a sign-in (a cookie-restored player).
  const restored = reg('FedeCookie', old);
  db.prepare('INSERT INTO refresh (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(H('f'), restored, NOW - 2 * DAY, NOW + 28 * DAY);
  // A password and a verified email: not password-only; its key is the current one.
  const verified = reg('GabiMail', old);
  store.claimEmail(verified, 'gabi.secret@gmail.com', 'mail', NOW);
  db.prepare('UPDATE users SET pw_v = 2 WHERE id = ?').run(verified);
  secrets.push('gabi.secret@gmail.com', 'gabisecret@gmail.com');
  // A password plus Google; Google only; Discord only (with a hint); Google plus Discord.
  const both = reg('HugoBoth', old);
  oauth('google', 'google-sub-hugo-secret', 'x', both);
  const g = oauth('google', 'google-sub-ines-secret', 'InesG');
  const d = oauth('discord', 'discord-id-juan-secret', 'JuanD');
  db.prepare("UPDATE users SET email_hint = 'juan.secret@x.com', email_hint_canon = 'juan.secret@x.com', email_hint_from = 'discord' WHERE id = ?").run(d);
  secrets.push('juan.secret@x.com');
  const gd = oauth('google', 'google-sub-kim-secret', 'KimGD');
  oauth('discord', 'discord-id-kim-secret', 'x', gd);
  // The project's account (trusted): a password, a verified email and Discord.
  const project = reg('Proyecto', NOW);
  store.claimEmail(project, 'proyecto.secret@turbo-gol.com', 'mail', NOW);
  oauth('discord', 'discord-id-project-secret', 'x', project);
  secrets.push('proyecto.secret@turbo-gol.com');
  for (const id of [g, d, gd]) db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(old, id);
  return { ana, hinted, idle, operator, banned, restored, verified, both, g, d, gd, project, secrets };
}

function makeStore() {
  const db = new DatabaseSync(':memory:');
  const store = new S.AccountStore(sqlOn(db), txOn(db));
  store.migrate();
  return { db, store };
}

test('accountStats counts a fixture database right: by ways in, by pw_v, emails and hints, the active ones, the password-only accounts and what they hold, the trusted ones', () => {
  const { db, store } = makeStore();
  const f = fixture(store, db);
  const missing = 'f'.repeat(16);
  const st = store.accountStats([f.operator, f.operator, f.g, 'c'.repeat(16)], [f.project, missing], NOW);
  assert.deepEqual(st, {
    total: 12,
    banned: 1,
    byWays: {
      'password+google+discord': 0,
      'password+google': 1,
      'password+discord': 1,
      password: 7,
      'google+discord': 1,
      google: 1,
      discord: 1,
      none: 0,
    },
    byPwV: { 0: 3, 1: 8, 2: 1 },
    verifiedEmail: 2,
    emailHint: 2,
    active30d: 3,
    passwordOnly: { total: 6, active30d: 2, emailHint: 1, rated: 1, hostPoints: 1, items: 1, nodes: 1, withAny: 2 },
    operators: 2,
    trusted: [
      { found: true, password: true, verifiedEmail: true, google: false, discord: true },
      { found: false, password: false, verifiedEmail: false, google: false, discord: false },
    ],
  });
  const unknown = store.accountStats(null, [], NOW);
  assert.deepEqual([unknown.passwordOnly.nodes, unknown.operators, unknown.passwordOnly.withAny, unknown.trusted], [null, null, 1, []]);
  // Nothing at all: zeros, never NULL sums.
  const empty = makeStore().store.accountStats([], [], NOW);
  assert.deepEqual([empty.total, empty.banned, empty.active30d, empty.passwordOnly, empty.operators], [0, 0, 0, { total: 0, active30d: 0, emailHint: 0, rated: 0, hostPoints: 0, items: 0, nodes: 0, withAny: 0 }, 0]);
});

// ---- through the Worker ------------------------------------------------------------------------------

function bucket(files = {}) {
  const enc = new TextEncoder();
  const objects = new Map(Object.entries(files).map(([k, v]) => [k, enc.encode(v)]));
  const meta = (k, b) => ({ key: k, size: b.byteLength, httpEtag: `"etag-${k.length}-${b.byteLength}"` });
  return {
    objects,
    async get(k) {
      const b = objects.get(k);
      return b ? { ...meta(k, b), body: new Blob([b]).stream(), text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.slice().buffer } : null;
    },
    async head(k) {
      const b = objects.get(k);
      return b ? meta(k, b) : null;
    },
    async put(k, v) {
      objects.set(k, typeof v === 'string' ? enc.encode(v) : new Uint8Array(v));
    },
  };
}

const CONTROL = await generateEd25519();

/** The Worker's env with a real AccountsDO on node:sqlite (its calls counted) and, with `nodes`, the node settings. */
function makeEnv({ nodes = true, trusted } = {}) {
  const db = new DatabaseSync(':memory:');
  const ctx = { storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => null, setAlarm: async () => undefined }, blockConcurrencyWhile: (fn) => fn() };
  const env = { JWT_SECRET: SECRET, VITE_ORIGINS: ORIGIN, FLAGS: { get: async () => null } };
  const obj = new AccountsDO(ctx, env);
  const calls = [];
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => (calls.push(new URL(url).pathname), obj.fetch(new Request(url, init))) }) };
  const seen = [];
  if (nodes) {
    Object.assign(env, {
      NODES: { idFromName: (n) => ({ n }), get: () => ({ fetch: async (r) => (seen.push(new URL(r.url).pathname), env.nodesHandler(r)) }) },
      NODE_REPLAYS: bucket(),
      NODE_RELEASES: bucket({ 'channel.json': JSON.stringify({ stable: '0.2.0', minimum: '0.2.0' }) }),
      NODE_CONTROL_PRIVATE_KEY: CONTROL.privateKey,
      NODE_CONTROL_PUBLIC_KEY: CONTROL.publicKey,
      NODES_PUBLIC_BASE: ORIGIN,
    });
    env.nodesHandler = () => new Response(JSON.stringify({ operators: [] }), { headers: { 'content-type': 'application/json' } });
  }
  const f = fixture(obj.store, db);
  env.NODE_TRUSTED_OPERATORS = trusted ?? f.project;
  return { env, obj, db, f, calls, seen };
}

let ipCount = 0;
const freshIp = () => `198.51.100.${++ipCount}`;

async function req(env, method, path, { bearer, ip = freshIp() } = {}) {
  const headers = { 'CF-Connecting-IP': ip, Origin: ORIGIN };
  if (bearer) headers.authorization = 'Bearer ' + bearer;
  return worker.fetch(new Request(ORIGIN + path, { method, headers }), env);
}

const nowS = () => Math.floor(Date.now() / 1000);
/**
 * An account session; `aat`: when its device last proved a credential (seconds), `aal`: that proof's
 * level (2 a typed password; null: none, a session from before levels), `tv`: a TV's.
 */
const accountToken = (sub, { aat = nowS(), aal = 2, tv = false, name = 'Proyecto' } = {}) =>
  signJwt(SECRET, { sub, name, iat: nowS(), exp: nowS() + 3600, acct: 1, ...(aat === null ? {} : { aat }), ...(aal === null ? {} : { aal }), ...(tv ? { tv: 1 } : {}) });

/** Every leaf of the answer: a count, a boolean or null; never a string. */
function leaves(v, path = '') {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return [[path, v]];
  assert.equal(typeof v, 'object', `${path} is a ${typeof v}`);
  return Object.entries(v).flatMap(([k, x]) => leaves(x, `${path}.${k}`));
}

test('the gate: no session 401, a guest, another account, a TV of the project and a stale project session 403, before any AccountsDO or object call', async () => {
  const { env, f, calls, seen } = makeEnv();
  const stale = nowS() - 16 * 60;
  const cases = [
    [null, 401, 'unauthorized'],
    [(await createSession(SECRET, f.project, 'Proyecto')).token, 403, 'account_required'],
    [await accountToken(f.ana, { name: 'AnaRated' }), 403, 'not_trusted'],
    [await accountToken(f.project, { tv: true }), 403, 'tv_session'],
    [await accountToken(f.project, { aat: stale }), 403, 'reauth_required'],
    [await accountToken(f.project, { aat: null }), 403, 'reauth_required'],
    // Sign-in PR 4: level 2 (a typed password); a press on Discord's page is level 1, a family of before levels 0.
    [await accountToken(f.project, { aal: 1 }), 403, 'reauth_required'],
    [await accountToken(f.project, { aal: null }), 403, 'reauth_required'],
  ];
  const before = calls.length;
  for (const [bearer, status, code] of cases) {
    const res = await req(env, 'GET', '/nodes/admin/account-stats', { bearer });
    assert.deepEqual([res.status, (await res.json()).error], [status, code], code);
  }
  assert.equal(calls.length, before, 'the AccountsDO was never asked');
  assert.deepEqual(seen, [], 'nor the object');
  const ok = await req(env, 'GET', '/nodes/admin/account-stats', { bearer: await accountToken(f.project, { aat: nowS() - 14 * 60 }) });
  assert.equal(ok.status, 200, 'fresh within MAINTAINER_FRESH_S');
  for (const m of ['POST', 'PUT', 'DELETE']) assert.equal((await req(env, m, '/nodes/admin/account-stats', { bearer: await accountToken(f.project) })).status, 404, m);
});

test('a fresh project session gets counts only: no id, name, address or provider id anywhere; every leaf a number, a boolean or null; no-store, no CORS', async () => {
  const { env, f } = makeEnv();
  env.nodesHandler = () => new Response(JSON.stringify({ operators: [f.operator, f.ana, 'ab'.repeat(8), 'not-an-id'] }), { headers: { 'content-type': 'application/json' } });
  const res = await req(env, 'GET', '/nodes/admin/account-stats', { bearer: await accountToken(f.project) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  const text = await res.text();
  for (const s of f.secrets) assert.equal(text.toLowerCase().includes(s.toLowerCase()), false, `the answer names ${s}`);
  assert.doesNotMatch(text, /@|[0-9a-f]{16}/, 'no address and no id');
  const body = JSON.parse(text);
  for (const [path, v] of leaves(body)) assert.ok(v === null || typeof v === 'number' || typeof v === 'boolean', path);
  assert.deepEqual(Object.keys(body), ['total', 'banned', 'byWays', 'byPwV', 'verifiedEmail', 'emailHint', 'active30d', 'passwordOnly', 'operators', 'trusted']);
  assert.equal(body.total, 12);
  assert.deepEqual([body.operators, body.passwordOnly.nodes, body.passwordOnly.withAny], [2, 2, 2], 'Ana and Dani operate nodes; Ana holds more');
  assert.deepEqual(body.trusted, [{ found: true, password: true, verifiedEmail: true, google: false, discord: true }]);
});

test('the node operators: asked of the object at /internal/operators, passed to AccountsDO only; null without the node settings, when the object fails, is paused or names too many', async () => {
  const { env, f, seen } = makeEnv();
  const stats = async (e, project = f.project) => (await req(e, 'GET', '/nodes/admin/account-stats', { bearer: await accountToken(project) })).json();
  env.nodesHandler = () => new Response(JSON.stringify({ operators: [f.operator] }), { headers: { 'content-type': 'application/json' } });
  assert.equal((await stats(env)).passwordOnly.nodes, 1);
  assert.deepEqual(seen, ['/internal/operators']);
  env.nodesHandler = () => new Response('{"error":"nodes_unavailable"}', { status: 503 });
  assert.deepEqual([(await stats(env)).operators, (await stats(env)).passwordOnly.nodes], [null, null]);
  env.nodesHandler = () => {
    throw new Error('object reset');
  };
  assert.equal((await stats(env)).operators, null);
  env.nodesHandler = () => new Response(JSON.stringify({ operators: Array.from({ length: 501 }, (_, i) => i.toString(16).padStart(16, '0')) }));
  assert.equal((await stats(env)).operators, null, 'more than one body holds: unknown, never a wrong count');
  const paused = makeEnv();
  paused.env.FLAGS = { get: async (k) => (k === 'nodes_off' ? '1' : null) };
  const p = await stats(paused.env, paused.f.project);
  assert.deepEqual([p.total, p.operators], [12, null], 'the counts still come, without the object');
  assert.deepEqual(paused.seen, [], 'nodes_off: the object is never asked');
  const fork = makeEnv({ nodes: false });
  const r = await req(fork.env, 'GET', '/nodes/admin/account-stats', { bearer: await accountToken(fork.f.project) });
  assert.equal(r.status, 200, 'a fork without nodes has the counts too');
  const b = await r.json();
  assert.deepEqual([b.total, b.operators, b.passwordOnly.nodes], [12, null, null]);
  assert.equal((await req(fork.env, 'GET', '/nodes/admin/nodes', { bearer: await accountToken(fork.f.project) })).status, 404, 'the other admin routes stay 404 there');
});

test('10 a minute per account (limits.ts accountStats, the RL_10 binding), counted per account, not per network', async () => {
  assert.deepEqual(accountGate('GET', '/nodes/admin/account-stats'), ['accountStats']);
  assert.deepEqual(LIMITS.accountStats, { by: 'account', isolate: 10, edge: 'RL_10' });
  const { env, f } = makeEnv();
  const bearer = await accountToken(f.project);
  for (let i = 0; i < 10; i++) assert.equal((await req(env, 'GET', '/nodes/admin/account-stats', { bearer })).status, 200, `#${i + 1}`);
  const over = await req(env, 'GET', '/nodes/admin/account-stats', { bearer });
  assert.deepEqual([over.status, (await over.json()).error], [429, 'rate_limited']);
  // Another maintainer behind the same address is not counted with the first.
  const two = makeEnv({ trusted: undefined });
  two.env.NODE_TRUSTED_OPERATORS = `${two.f.project},${two.f.verified}`;
  assert.equal((await req(two.env, 'GET', '/nodes/admin/account-stats', { bearer: await accountToken(two.f.verified, { name: 'GabiMail' }), ip: '198.51.100.250' })).status, 200);
});

test('end to end on a real NodeRegistryDO: a registered node’s operator is counted, and the object’s route answers ids only to the internal header', async () => {
  const { env, f } = makeEnv();
  const db = new DatabaseSync(':memory:');
  let alarm = null;
  const ctx = {
    storage: { sql: sqlOn(db), transactionSync: (fn) => fn(), getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t), deleteAlarm: async () => void (alarm = null) },
    blockConcurrencyWhile: (fn) => fn(),
    acceptWebSocket: () => undefined,
    getWebSockets: () => [],
    waitUntil: () => undefined,
  };
  const registry = new NodeRegistryDO(ctx, env);
  env.nodesHandler = (r) => registry.fetch(r);
  const before = await (await req(env, 'GET', '/nodes/admin/account-stats', { bearer: await accountToken(f.project) })).json();
  assert.deepEqual([before.operators, before.passwordOnly.nodes], [0, 0], 'no node yet');
  const tok = await worker.fetch(new Request(ORIGIN + '/nodes/tokens', { method: 'POST', headers: { 'CF-Connecting-IP': freshIp(), Origin: ORIGIN, 'content-type': 'application/json', authorization: 'Bearer ' + (await accountToken(f.project)) }, body: JSON.stringify({ region: 'SA', name: 'sp-1' }) }), env);
  assert.equal(tok.status, 200);
  const keys = await generateEd25519();
  const reg = await worker.fetch(
    new Request(ORIGIN + '/nodes/register', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': freshIp(), 'content-type': 'application/json' },
      body: JSON.stringify({ token: (await tok.json()).token, publicKey: keys.publicKey, roles: ['host'], publicUrl: 'wss://sp1.turbo-gol.com', build: { version: '0.2.0', protocol: 1, wasmSha256: 'a'.repeat(64) }, specs: {}, capacity: { matches: 2, cpuMsPerMatchSecond: 1, memMBPerMatch: 20, uplinkMbps: null, source: 'bench' } }),
    }),
    env,
  );
  assert.equal(reg.status, 200);
  const after = await (await req(env, 'GET', '/nodes/admin/account-stats', { bearer: await accountToken(f.project) })).json();
  assert.deepEqual([after.operators, after.passwordOnly.nodes], [1, 0], 'the project operates it, and the project is not password-only');
  // The object's route itself: without the internal header it is refused like every other.
  assert.equal((await registry.fetch(new Request('https://nodes/internal/operators'))).status, 403);
  assert.equal((await req(env, 'GET', '/nodes/internal/operators')).status, 404, 'never reachable from outside');
});

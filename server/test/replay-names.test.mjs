// PERFIL's "hide my name in public replays" (src/net/replays.ts; audit pr60-1, the owner's choice of
// 2026-10-29: names show by default, an account may hide its own). The account side on node:sqlite
// (accountStore.ts replay_names, AccountsDO's /replay-name and /replay-hidden), the Worker's
// GET / POST /api/me/replay-name with its per-account limit (limits.ts replayName) before the
// object, and end to end: an account's choice in front of a real AccountsDO and a real
// NodeRegistryDO turns its name into 'Jugador N' in the public list and replay of a match listed
// before it chose, and back after the object's minute. 'cloudflare:workers' and MatchDO's wasm are
// stubbed by the resolve hook (match.test.mjs). Run from server/: npm test
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

// The control plane's auth timer must never keep the test process alive.
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

const { AccountStore } = await import('../src/accountStore.ts');
const { AccountsDO } = await import('../src/AccountsDO.ts');
const { NodeRegistryDO } = await import('../src/NodeRegistryDO.ts');
const A = await import('../src/accountRoutes.ts');
const worker = (await import('../src/index.ts')).default;
const { signJwt, createSession, INTERNAL_HEADER, internalSecret } = await import('../src/auth.ts');
const { generateEd25519, sha256Hex } = await import('../../nodes/shared/edcrypto.ts');
const { ReplayWriter, decodeReplay } = await import('../../nodes/shared/replay.ts');

const SECRET = 'replay-names-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const H = (c) => c.repeat(64).slice(0, 64);
const KEY = 'c'.repeat(64);
const HOUR = 60 * 60_000;
const BASE = Math.floor((Date.now() - 3 * HOUR) / HOUR) * HOUR + HOUR / 2;
const CONTROL = await generateEd25519();

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

/** An R2 bucket in memory (get, put, delete). */
function bucket() {
  const objects = new Map();
  return {
    objects,
    async get(k) {
      const b = objects.get(k);
      return b ? { key: k, size: b.byteLength, body: new Blob([b]).stream(), text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.slice().buffer } : null;
    },
    async head(k) {
      const b = objects.get(k);
      return b ? { key: k, size: b.byteLength } : null;
    },
    async put(k, v) {
      objects.set(k, new Uint8Array(v));
    },
    async delete(k) {
      for (const key of Array.isArray(k) ? k : [k]) objects.delete(key);
    },
  };
}

/** A real AccountsDO (counting the calls that reach it) and, with `nodes`, a real NodeRegistryDO in front of it. */
async function world({ nodes = false } = {}) {
  const env = { JWT_SECRET: SECRET, VITE_ORIGINS: ORIGIN, FLAGS: { get: async () => null }, TURNSTILE_DISABLED: '1' };
  const adb = new DatabaseSync(':memory:');
  let alarm = null;
  const actx = { storage: { sql: sqlOn(adb), transactionSync: txOn(adb), getAlarm: async () => alarm, setAlarm: async (t) => void (alarm = t) }, blockConcurrencyWhile: (fn) => fn() };
  const accounts = new AccountsDO(actx, env);
  const reached = [];
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => (reached.push(new URL(url).pathname), accounts.fetch(new Request(url, init))) }) };
  let reg = null;
  if (nodes) {
    Object.assign(env, {
      NODE_REPLAYS: bucket(),
      NODE_RELEASES: bucket(),
      NODE_CONTROL_PRIVATE_KEY: CONTROL.privateKey,
      NODE_CONTROL_PUBLIC_KEY: CONTROL.publicKey,
      NODE_TRUSTED_OPERATORS: 'a1b2c3d4e5f60718',
      NODES_PUBLIC_BASE: ORIGIN,
    });
    const ndb = new DatabaseSync(':memory:');
    let nalarm = null;
    const nctx = {
      storage: { sql: sqlOn(ndb), transactionSync: (fn) => fn(), getAlarm: async () => nalarm, setAlarm: async (t) => void (nalarm = t), deleteAlarm: async () => void (nalarm = null) },
      blockConcurrencyWhile: (fn) => fn(),
      acceptWebSocket: () => undefined,
      getWebSockets: () => [],
      waitUntil: () => undefined,
    };
    env.NODES = { idFromName: (n) => ({ n }), get: () => ({ fetch: (r) => reg.fetch(r) }) };
    reg = new NodeRegistryDO(nctx, env);
    await reg.ready;
  }
  return { env, accounts, reached, reg };
}

async function account(obj, name) {
  return obj.store.register(name, await A.newPasswordRecord(KEY), [], H(name[0].toLowerCase()), Date.now()).userId;
}

const accountToken = (sub, name) => signJwt(SECRET, { sub, name, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, acct: 1 });

let ipCount = 0;
async function call(env, method, path, { token, body, ip = `192.0.2.${++ipCount}` } = {}) {
  const headers = { 'CF-Connecting-IP': ip, Origin: ORIGIN };
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* bytes */
  }
  return { status: res.status, headers: res.headers, json, text };
}

// ---- the store and AccountsDO -------------------------------------------------------------------

test('accountStore: a name shows by default; an account hides it and shows it again; /replay-hidden answers only the accounts that hide, by id or by name', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new AccountStore(sqlOn(db), txOn(db));
  store.migrate();
  store.migrate(); // idempotent: one CREATE TABLE IF NOT EXISTS
  const pw = { hash: H('a'), salt: H('b').slice(0, 32), iter: 100000 };
  const ana = store.register('Ana', pw, [], H('1'), 1).userId;
  const beto = store.register('Beto', pw, [], H('2'), 1).userId;
  assert.deepEqual(store.replayName(ana), { hidden: false }, 'shown by default');
  assert.equal(store.replayName('ffffffffffffffff'), 'no_user');
  assert.equal(store.setReplayName('ffffffffffffffff', true, 2), 'no_user');
  assert.deepEqual(store.setReplayName(beto, true, 2), { hidden: true });
  assert.deepEqual(store.replayName(beto), { hidden: true });
  const guest = '0123456789abcdef';
  assert.deepEqual(store.replayHidden([ana, beto, guest], ['Ana', 'beto', 'BETO', 'Invitado 4821', 'nadie']), { ids: [beto], names: ['beto', 'BETO'] }, 'names as usernames are matched (case-insensitive)');
  assert.deepEqual(store.setReplayName(beto, false, 3), { hidden: false });
  assert.deepEqual(store.replayHidden([beto], ['Beto']), { ids: [], names: [] });
});

test('AccountsDO: /replay-name, /replay-name/set and /replay-hidden behind the internal header, bounded', async () => {
  const { accounts } = await world();
  const id = await account(accounts, 'Carla');
  const secret = await internalSecret(SECRET);
  const post = (path, body) => accounts.fetch(new Request('https://accounts' + path, { method: 'POST', headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const get = (path) => accounts.fetch(new Request('https://accounts' + path, { headers: { [INTERNAL_HEADER]: secret } }));
  assert.deepEqual(await (await get('/replay-name?userId=' + id)).json(), { hidden: false });
  assert.equal((await get('/replay-name?userId=ffffffffffffffff')).status, 404);
  assert.deepEqual(await (await post('/replay-name/set', { userId: id, hidden: true })).json(), { hidden: true });
  assert.equal((await post('/replay-name/set', { userId: id, hidden: 'yes' })).status, 400);
  assert.deepEqual(await (await post('/replay-hidden', { ids: [id, 'x'], names: ['carla'] })).json(), { ids: [id], names: ['carla'] });
  assert.equal((await post('/replay-hidden', { ids: Array(257).fill(id), names: [] })).status, 400, 'a page at most');
  assert.equal((await post('/replay-hidden', { ids: [id] })).status, 400);
  const forged = await accounts.fetch(new Request('https://accounts/replay-hidden', { method: 'POST', body: JSON.stringify({ ids: [id], names: [] }) }));
  assert.equal(forged.status, 403, 'only this deployment asks');
});

// ---- the Worker route ----------------------------------------------------------------------------

test('GET / POST /api/me/replay-name: an account reads and sets its own choice; a guest or no session cannot; a bad body is 400', async () => {
  const { env, accounts } = await world();
  const id = await account(accounts, 'Dario');
  const token = await accountToken(id, 'Dario');
  assert.deepEqual((await call(env, 'GET', '/api/me/replay-name', { token })).json, { hidden: false });
  const set = await call(env, 'POST', '/api/me/replay-name', { token, body: { hidden: true } });
  assert.equal(set.status, 200);
  assert.deepEqual(set.json, { hidden: true });
  assert.equal(set.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await call(env, 'GET', '/api/me/replay-name', { token })).json, { hidden: true });
  assert.equal(accounts.store.replayName(id).hidden, true, 'stored for that account');
  assert.equal((await call(env, 'POST', '/api/me/replay-name', { token, body: { hidden: 1 } })).status, 400);
  assert.equal((await call(env, 'GET', '/api/me/replay-name')).status, 401);
  const guest = (await createSession(SECRET, 'fedcba9876543210', 'Invitado 1234')).token;
  const g = await call(env, 'POST', '/api/me/replay-name', { token: guest, body: { hidden: true } });
  assert.equal(g.status, 403);
  assert.equal(g.json.error, 'account_required', 'a guest is "Invitado NNNN" already');
});

test('/api/me/replay-name: 30 a minute per account before AccountsDO (limits.ts replayName), whatever the address; another account is not affected', async () => {
  const { env, accounts, reached } = await world();
  const id = await account(accounts, 'Elena');
  const token = await accountToken(id, 'Elena');
  for (let i = 0; i < 30; i++) assert.equal((await call(env, i % 2 ? 'GET' : 'POST', '/api/me/replay-name', { token, body: i % 2 ? undefined : { hidden: i % 4 === 0 } })).status, 200, String(i));
  const before = reached.length;
  assert.equal((await call(env, 'GET', '/api/me/replay-name', { token })).status, 429);
  assert.equal(reached.length, before, 'refused before the object');
  const other = await account(accounts, 'Fede');
  assert.equal((await call(env, 'GET', '/api/me/replay-name', { token: await accountToken(other, 'Fede') })).status, 200);
});

// ---- end to end ----------------------------------------------------------------------------------

/** A 1v1 replay a node wrote, its two accounts' ids in its roster. */
function tgr(matchId, ids) {
  const w = new ReplayWriter({
    v: 1,
    matchId,
    nodeId: 'feedfacefeedface',
    build: { version: '0.3.0', protocol: 3, wasmSha256: 'd'.repeat(64) },
    mode: '1v1',
    region: 'SA',
    ranked: true,
    roster: [
      { slot: 0, team: 0, kind: 'player', name: 'x', playerId: ids[0] },
      { slot: 1, team: 1, kind: 'player', name: 'y', playerId: ids[1] },
    ],
    matchLengthSeconds: 180,
    kickoffSeed: 7,
    botDifficulty: 'medium',
    tickRate: 120,
    checkpointEvery: 120,
    startedAt: 0,
  });
  w.input(1, 0, new Int8Array([1, 0, 0, 0, 0, 0]), 0);
  w.hash(120, 1);
  w.end({ tick: 200, winner: 1, blue: 0, red: 1, reason: 'rules', forfeitTeam: -1 });
  return w.finish();
}

function settled(matchId, ids, names, sha) {
  return {
    assign: { matchId, mode: '1v1', region: 'SA', ranked: true, roster: ids.map((playerId, slot) => ({ slot, team: slot, kind: 'player', name: names[slot], playerId })), matchLengthSeconds: 180, kickoffSeed: 7, botDifficulty: 'medium', createdAt: BASE - 200_000 },
    nodeId: 'feedfacefeedface',
    state: 'done',
    humans: ids.map((playerId, i) => ({ playerId, name: names[i], account: true })),
    leaves: new Set(),
    leaveAt: new Map(),
    neverJoined: new Set(),
    left: new Set(),
    offered: new Set(),
    build: { version: '0.3.0', protocol: 3, wasmSha256: 'd'.repeat(64) },
    replaySha: sha,
    report: { kind: 'ended', matchId, result: { winner: 1, blue: 0, red: 1, endTick: 200, endReason: 'rules' }, replaySha256: sha, replayBytes: 100 },
    verdict: null,
    ledger: null,
    doneAt: BASE,
  };
}

test('end to end: an account hides its name in PERFIL and a match listed before shows "Jugador 2" in the list and the replay; showing it again lands within the object’s minute', async () => {
  const { env, accounts, reg } = await world({ nodes: true });
  const gaby = await account(accounts, 'Gaby');
  const hugo = await account(accounts, 'Hugo');
  const matchId = 'ab'.repeat(32);
  const bytes = tgr(matchId, [gaby, hugo]);
  reg.store.finished(settled(matchId, [gaby, hugo], ['Gaby', 'Hugo'], await sha256Hex(bytes)), { kind: 'rated', matchId, playlist: '1v1', region: 'SA', winner: 1, blue: 0, red: 1, players: [], nodeId: 'feedfacefeedface' });
  await env.NODE_REPLAYS.put(matchId, bytes);
  // Hugo turns it on after the match was listed.
  assert.equal((await call(env, 'POST', '/api/me/replay-name', { token: await accountToken(hugo, 'Hugo'), body: { hidden: true } })).status, 200);
  const list = await call(env, 'GET', '/nodes/replays');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.matches[0].players.map((p) => p.name), ['Gaby', 'Jugador 2']);
  const view = await worker.fetch(new Request(`${ORIGIN}/nodes/replays/${matchId}/view`, { headers: { 'CF-Connecting-IP': '192.0.2.250' } }), env);
  assert.equal(view.status, 200);
  const r = decodeReplay(new Uint8Array(await view.arrayBuffer()));
  assert.deepEqual(r.header.roster.map((e) => e.name), ['Gaby', 'Jugador 2']);
  assert.ok(!JSON.stringify(r.header).includes(hugo), 'no account id either');
  // Hugo shows it again: the object keeps its answer a minute, the isolate its first page 30 s.
  assert.equal((await call(env, 'POST', '/api/me/replay-name', { token: await accountToken(hugo, 'Hugo'), body: { hidden: false } })).status, 200);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 61_000;
    const again = await call(env, 'GET', '/nodes/replays');
    assert.deepEqual(again.json.matches[0].players.map((p) => p.name), ['Gaby', 'Hugo']);
  } finally {
    Date.now = realNow;
  }
});

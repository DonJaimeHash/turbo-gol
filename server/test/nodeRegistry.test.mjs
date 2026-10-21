// The NodeRegistryDO (server/src/NodeRegistryDO.ts, its tables in server/src/nodeStore.ts) on
// fakes, without workerd: its SQLite on node:sqlite (the same SQL), a fake DurableObjectState with
// hibernatable sockets, an alarm and waitUntil, R2 buckets in memory, ACCOUNTS and MATCHMAKER
// namespaces that record what the outbox delivers, and a node played by the test (it signs the
// challenge and its /healthz nonce, says hello, answers 'assign' and 'leave', reports). A fake
// fetch answers that /healthz (or fails it as a test asks) and takes the posts of the team's
// webhook, for the ALERTs, the watch, the cron's health check and the maintainers' routes. Date.now
// is the test's clock. A "deploy" builds a new object on the same database with every socket
// closed; a "hibernation" builds one on the same database and the same open sockets.
// Run from server/: npm test
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

// The control plane's auth (10 s) and RPC (5 s) timers must never keep the test process alive.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = realSetTimeout(fn, ms, ...args);
  t.unref?.();
  return t;
};

const D = await import('../src/NodeRegistryDO.ts');
const { NodeStore } = await import('../src/nodeStore.ts');
const { CLIENT_BUILD } = await import('../src/nodeApi.ts');
const { INTERNAL_HEADER, internalSecret } = await import('../src/auth.ts');
const { generateEd25519, importPrivateKey, sign, sha256Hex } = await import('../../nodes/shared/edcrypto.ts');
const { authMessage, reachMessage, replayRequestMessage } = await import('../../nodes/shared/controlProtocol.ts');
const { LINK_TIMEOUT_MS, NODE_OFFLINE_MS, RESTART_GRACE_MS } = await import('../../nodes/control-plane/controlPlane.ts');
const { STATE_VERSION } = await import('../../nodes/control-plane/persist.ts');

const SECRET = 'node-registry-test-secret';
const RealResponse = globalThis.Response;
/** Node refuses a 101 Response: the object's upgrade answer is kept as a 200 marked `upgraded` (room.test.mjs). */
globalThis.Response = class Response extends RealResponse {
  constructor(body, init) {
    if (init && init.status === 101) {
      super(body, { ...init, status: 200 });
      this.upgraded = true;
      this.webSocket = init.webSocket;
    } else super(body, init);
  }
};

let clock = 1_800_000_000_000;
Date.now = () => clock;

/** Every line the object logged (console.log), for the ALERT checks. NODELOG=1 prints them too. */
const lines = [];
const realLog = console.log;
console.log = (...args) => {
  const line = args.map(String).join(' ');
  lines.push(line);
  if (process.env.NODELOG) realLog(line);
};
const alerts = () => lines.filter((l) => l.startsWith('[nodes] ALERT'));

const PROJECT = 'a1b2c3d4e5f60718';
const STRANGER = '0123456789abcdef';
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const BASE = 'https://turbo-gol.test';
const NODE_URL = 'wss://sp1.turbo-gol.test';
const SPECS = { cpus: 2, cpuModel: 'x', memMB: 4096, arch: 'x64', os: 'linux', node: '24' };
const CAP = { matches: 4, cpuMsPerMatchSecond: 1, memMBPerMatch: 20, uplinkMbps: null, source: 'bench' };
const NODE_BUILD = { ...CLIENT_BUILD, version: '0.2.0' };
const CONTROL = await generateEd25519();
const secret = await internalSecret(SECRET);
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

/** `p`, or a failure once `ms` passed without it: a hang fails its test instead of stalling the file. */
async function within(ms, p, what) {
  let timer;
  const late = new Promise((_, reject) => (timer = realSetTimeout(() => reject(new Error(what)), ms)));
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(fn, what) {
  for (let i = 0; i < 200 && !(await fn()); i++) await sleep(2);
  assert.ok(await fn(), what);
}

// ---- fakes ---------------------------------------------------------------------------------------

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.att = null;
    /** The node behind it: sees every message the control plane sends. */
    this.onSend = null;
  }
  send(text) {
    if (this.readyState !== 1) throw new Error('send on a closed socket');
    const m = JSON.parse(text);
    this.sent.push(m);
    this.onSend?.(m);
  }
  close(code, reason) {
    if (this.readyState === 3) throw new Error('already closed');
    this.readyState = 3;
    this.closed = { code, reason };
  }
  serializeAttachment(a) {
    this.att = JSON.parse(JSON.stringify(a));
  }
  deserializeAttachment() {
    return this.att;
  }
  of(t) {
    return this.sent.filter((m) => m.t === t);
  }
}

globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
  }
};

/** node:sqlite behind ctx.storage.sql (exec(...).toArray()) and transactionSync, as accounts.test.mjs. */
function sqlOf(db) {
  const sql = {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? stmt.all(...bindings) : (stmt.run(...bindings), []);
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
  let depth = 0;
  const transactionSync = (fn) => {
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
  return { sql, transactionSync };
}

class FakeCtx {
  constructor(db = new DatabaseSync(':memory:'), sockets = []) {
    this.db = db;
    this.sockets = sockets;
    this.alarm = null;
    this.waits = [];
    const { sql, transactionSync } = sqlOf(db);
    this.storage = {
      sql,
      transactionSync,
      getAlarm: async () => this.alarm,
      setAlarm: async (t) => {
        this.alarm = t;
      },
      deleteAlarm: async () => {
        this.alarm = null;
      },
    };
  }
  blockConcurrencyWhile(fn) {
    return fn();
  }
  acceptWebSocket(ws) {
    this.sockets.push(ws);
  }
  getWebSockets() {
    return this.sockets.filter((w) => w.readyState === 1);
  }
  waitUntil(p) {
    this.waits.push(Promise.resolve(p));
  }
  /** Every waitUntil so far (the outbox drains it kicks), settled. */
  async settle() {
    while (this.waits.length > 0) await Promise.all(this.waits.splice(0));
  }
}

/** An R2 bucket in memory. */
function bucket(initial = {}) {
  const objects = new Map();
  const enc = new TextEncoder();
  const put = (k, v) => objects.set(k, typeof v === 'string' ? enc.encode(v) : new Uint8Array(v));
  for (const [k, v] of Object.entries(initial)) put(k, v);
  const view = (k) => {
    const b = objects.get(k);
    return b ? { key: k, size: b.byteLength, httpEtag: `"${b.byteLength}-${b[0] ?? 0}"`, text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.slice().buffer } : null;
  };
  return {
    objects,
    get: async (k) => view(k),
    head: async (k) => view(k),
    put: async (k, v) => void put(k, v),
  };
}

/** A DO namespace whose objects answer `answer(name, path, body)` (a Response, or an Error to throw); `calls` records each POST. */
function namespace(answer = () => new RealResponse('{"ok":true}')) {
  const calls = [];
  const ns = {
    calls,
    /** While set, every delivery waits for it (to look at the outbox before anything is delivered). */
    gate: null,
    answer,
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (url, init) => {
        if (ns.gate) await ns.gate;
        const path = new URL(url).pathname;
        const body = JSON.parse(init.body);
        calls.push({ name: id.name, path, body });
        const r = ns.answer(id.name, path, body);
        if (r instanceof Error) throw r;
        return r;
      },
    }),
  };
  return ns;
}

function makeEnv(over = {}) {
  return {
    JWT_SECRET: SECRET,
    NODES: {},
    NODE_REPLAYS: bucket(),
    NODE_RELEASES: bucket({ 'channel.json': JSON.stringify({ stable: '0.2.0', minimum: '0.2.0' }) }),
    NODE_CONTROL_PRIVATE_KEY: CONTROL.privateKey,
    NODE_CONTROL_PUBLIC_KEY: CONTROL.publicKey,
    NODE_TRUSTED_OPERATORS: PROJECT,
    NODES_PUBLIC_BASE: BASE + '/',
    ACCOUNTS: namespace(),
    MATCHMAKER: namespace(),
    ...over,
  };
}

/** The team's Discord webhook (NODE_ALERT_WEBHOOK) and what it got: each post's JSON body. */
const HOOK = 'https://discord.test/api/webhooks/1/secret';
const posts = [];
const posted = () => posts.map((p) => p.content);

/**
 * The nodes behind the fake /healthz: host -> { nodeId, key, draining?, fail? } (the registered
 * node: setting `draining` or `fail(url, init)` on it changes what its /healthz answers).
 */
const hosts = new Map();
globalThis.fetch = async (url, init = {}) => {
  if (String(url) === HOOK) {
    posts.push(JSON.parse(init.body));
    return new RealResponse(null, { status: 204 });
  }
  const u = new URL(String(url));
  const h = hosts.get(u.host);
  if (u.pathname !== '/healthz' || !h) throw new Error('unexpected fetch ' + url);
  if (h.fail) return h.fail(u, init);
  const nonce = u.searchParams.get('nonce');
  return new RealResponse(JSON.stringify({ ok: true, nodeId: h.nodeId, draining: h.draining === true, sig: await sign(h.key, reachMessage(h.nodeId, nonce)) }));
};

/** A NodeRegistryDO on `ctx`, started. An ALERT post's turn comes at once (nodeOps.test.mjs times the turns). */
async function boot(env, ctx = new FakeCtx()) {
  const obj = new D.NodeRegistryDO(ctx, env);
  obj.alertSleep = () => Promise.resolve();
  await obj.ready;
  return { obj, ctx, env };
}

async function call(h, method, path, { body, headers = {} } = {}) {
  const res = await h.obj.fetch(
    new Request('https://nodes' + path, {
      method,
      headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, headers: res.headers };
}

const tokenFor = (h, op = PROJECT, region = 'SA') => call(h, 'POST', '/nodes/tokens', { body: { region, name: 'sao-paulo-1' }, headers: { 'x-operator-id': op, 'x-operator-name': encodeURIComponent('Proyecto Señor') } });

/** Register a node with a fresh key; `node.key` signs for it. */
async function registerNode(h, { ip = '203.0.113.1', roles = ['host', 'verify'], publicUrl = NODE_URL, op = PROJECT } = {}) {
  const t = await tokenFor(h, op);
  assert.equal(t.status, 200, JSON.stringify(t.json));
  const keys = await generateEd25519();
  const r = await call(h, 'POST', '/nodes/register', {
    body: { token: t.json.token, publicKey: keys.publicKey, roles, publicUrl, build: NODE_BUILD, specs: SPECS, capacity: CAP },
    headers: { 'x-client-ip': ip },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const node = { ...r.json, key: await importPrivateKey(keys.privateKey), publicUrl };
  if (publicUrl) hosts.set(new URL(publicUrl).host, node);
  return node;
}

/** The node's reflexes on a socket: it answers 'assign' and 'leave' on whatever object `h.obj` is now. */
function answer(h, ws, node, opts = {}) {
  ws.onSend = (m) => {
    const reply = (data) => setImmediate(() => void h.obj.webSocketMessage(ws, JSON.stringify({ t: 'reply', rid: m.rid, ok: true, data })));
    if (m.t === 'assign') reply({ wsUrl: `${node.publicUrl}/m/${m.match.matchId}` });
    if (m.t === 'leave') reply({ slot: 0, closed: true, already: false, ended: false });
    opts.onSend?.(m);
  };
}

/** Open /nodes/connect for `node` and log in (no hello yet). */
async function connect(h, node) {
  const res = await h.obj.fetch(new Request('https://nodes/nodes/connect', { headers: { [INTERNAL_HEADER]: secret, Upgrade: 'websocket' } }));
  assert.equal(res.upgraded, true, 'upgraded');
  const ws = h.ctx.sockets.at(-1);
  answer(h, ws, node);
  const challenge = ws.of('challenge')[0];
  await h.obj.webSocketMessage(ws, JSON.stringify({ t: 'auth', nodeId: node.nodeId, sig: await sign(node.key, authMessage(node.nodeId, challenge.nonce)) }));
  assert.equal(ws.of('welcome').length, 1, 'welcome');
  return ws;
}

const helloOf = (node, over = {}) => ({ bootId: 'boot-1', build: NODE_BUILD, roles: ['host', 'verify'], transports: ['wss'], publicUrl: node.publicUrl, rtcReady: false, specs: SPECS, capacity: CAP, draining: false, egressCapGB: null, ...over });
const beat = (over = {}) => ({ active: 0, capacity: 4, draining: false, egressGB: 0, egressCapGB: null, tickLagP99Ms: 1, cpuLoad: 0.1, rssMB: 80, matches: [], ...over });
const send = (h, ws, m) => h.obj.webSocketMessage(ws, JSON.stringify(m));

/** A trusted node registered, connected, said hello and proven reachable (active). */
async function liveNode(h, opts = {}) {
  const node = await registerNode(h, opts);
  const ws = await connect(h, node);
  await send(h, ws, { t: 'hello', data: helloOf(node) });
  await waitFor(() => h.obj.cp.registry.node(node.nodeId).status === 'active', 'active after its probe');
  return { node, ws };
}

/** A body that counts how many chunks were pulled from it. */
function stream(chunks) {
  const s = { pulls: 0 };
  s.body = new ReadableStream(
    {
      pull(c) {
        if (s.pulls >= chunks.length) return c.close();
        c.enqueue(chunks[s.pulls++]);
      },
    },
    { highWaterMark: 0 }, // nothing is pulled before a read
  );
  return s;
}

const humans = (...ids) => ids.map((id, i) => ({ playerId: id, name: 'P' + i }));
const placeBody = (over = {}) => ({ mode: '1v1', region: 'SA', ranked: false, matchLengthSeconds: 180, humans: humans(A, B), ...over });

/** The rows of a table. */
const rows = (h, table) => h.ctx.db.prepare(`SELECT * FROM ${table}`).all();

// ---- the store -------------------------------------------------------------------------------------

test('migrate() is idempotent and keeps the rows; a state version this build does not read is refused', () => {
  const db = new DatabaseSync(':memory:');
  const { sql, transactionSync } = sqlOf(db);
  const store = new NodeStore(sql, transactionSync);
  store.migrate();
  db.prepare("INSERT INTO nodes (node_id, operator_id, public_key, data) VALUES ('n', 'o', 'k', '{}')").run();
  store.migrate();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n, 1);
  assert.deepEqual(db.prepare('SELECT k, v FROM meta').all().map((r) => ({ ...r })), [{ k: 'state_version', v: String(STATE_VERSION) }]);
  db.prepare("UPDATE meta SET v = ? WHERE k = 'state_version'").run(String(STATE_VERSION + 1));
  assert.throws(() => store.migrate(), /state version 2 .*a newer build wrote them/);
});

test('a state version written by a newer build: the object starts down with an ALERT, answers 503 and touches nothing', async () => {
  const db = new DatabaseSync(':memory:');
  const { sql, transactionSync } = sqlOf(db);
  new NodeStore(sql, transactionSync).migrate();
  db.prepare("UPDATE meta SET v = '9' WHERE k = 'state_version'").run();
  lines.length = 0;
  const h = await boot(makeEnv(), new FakeCtx(db));
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /not started, its state is left as it is: .*state version 9/);
  const r = await call(h, 'GET', '/nodes/status');
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'nodes_unavailable');
  assert.doesNotMatch(r.json.message, /state|version|unreadable/, 'the cause is for the ALERT line, not for any caller');
  assert.equal(h.ctx.alarm, null);
  assert.equal(db.prepare("SELECT v FROM meta WHERE k = 'state_version'").get().v, '9', 'the rows wait for the build that wrote them');
});

test('without the node settings the object serves nothing; every route needs the internal header', async () => {
  const h = await boot(makeEnv({ NODE_CONTROL_PRIVATE_KEY: undefined }));
  assert.equal((await call(h, 'GET', '/nodes/status')).status, 503);
  const ok = await boot(makeEnv());
  const res = await ok.obj.fetch(new Request('https://nodes/nodes/status'));
  assert.equal(res.status, 403);
});

// ---- tokens, registration ------------------------------------------------------------------------

test('tokens: a trusted operator only, a known region, 10 a day; the answer carries the install line', async () => {
  const h = await boot(makeEnv());
  assert.deepEqual((await tokenFor(h, STRANGER)).json.error, 'not_trusted');
  assert.equal((await tokenFor(h, STRANGER)).status, 403);
  assert.equal((await tokenFor(h, PROJECT, 'XX')).status, 400);
  const t = await tokenFor(h);
  assert.equal(t.status, 200);
  assert.match(t.json.token, /^tgn1_/);
  assert.equal(t.json.ttlMinutes, 60);
  assert.equal(t.json.install.linux, `curl -fsSL ${BASE}/nodes/releases/install.sh | sudo bash -s -- --control ${BASE} --token ${t.json.token}`);
  assert.equal(t.headers.get('cache-control'), 'no-store');
  const rec = h.obj.cp.registry.tokenList()[0];
  assert.equal(rec.operatorName, 'Proyecto Señor', 'the name comes URL-encoded');
  assert.equal(rows(h, 'node_tokens').length, 1, 'written through');
  for (let i = 1; i < D.TOKENS_PER_ACCOUNT_PER_DAY; i++) assert.equal((await tokenFor(h)).status, 200);
  assert.equal((await tokenFor(h)).status, 429);
  clock += 24 * 3_600_000;
  assert.equal((await tokenFor(h)).status, 200, 'a new day');
});

test('register: the control public key and the wss URL; 5 a hour per address, refused attempts included', async () => {
  const h = await boot(makeEnv());
  const node = await registerNode(h, { ip: '198.51.100.7' });
  assert.equal(node.controlPublicKey, CONTROL.publicKey);
  assert.equal(node.controlUrl, 'wss://turbo-gol.test/nodes/connect');
  assert.equal(node.status, 'pending');
  assert.equal(rows(h, 'nodes').length, 1);
  const bad = { body: { token: 'tgn1_nope' }, headers: { 'x-client-ip': '198.51.100.7' } };
  for (let i = 1; i < D.REGISTER_PER_IP_PER_HOUR; i++) assert.equal((await call(h, 'POST', '/nodes/register', bad)).status, 403);
  assert.equal((await call(h, 'POST', '/nodes/register', bad)).status, 429);
  assert.equal((await call(h, 'POST', '/nodes/register', { ...bad, headers: { 'x-client-ip': '198.51.100.8' } })).status, 403, 'another address');
  clock += 3_600_000;
  assert.equal((await call(h, 'POST', '/nodes/register', bad)).status, 403, 'an hour later');
});

test('register reads at most 4 KB of its body: a bigger one, sent without a Content-Length, is refused without being read whole', async () => {
  const h = await boot(makeEnv());
  // Valid JSON, so only the cap can refuse it (read whole, it would be a 403 for its token).
  const text = new TextEncoder().encode('{"token":"tgn1_' + 'a'.repeat(64 * 1024) + '"}');
  const big = stream(Array.from({ length: Math.ceil(text.byteLength / 1024) }, (_, i) => text.slice(i * 1024, (i + 1) * 1024)));
  const req = new Request('https://nodes/nodes/register', { method: 'POST', duplex: 'half', body: big.body, headers: { [INTERNAL_HEADER]: secret, 'x-client-ip': '198.51.100.30' } });
  assert.equal(req.headers.get('content-length'), null, 'a streamed body declares no length');
  const res = await h.obj.fetch(req);
  assert.deepEqual([res.status, (await res.json()).error], [400, 'bad_request']);
  assert.ok(big.pulls <= 5, `reading stopped at the cap (${big.pulls} KiB of ${Math.ceil(text.byteLength / 1024)} pulled)`);
  const declared = stream([text]);
  const r2 = await h.obj.fetch(new Request('https://nodes/nodes/register', { method: 'POST', duplex: 'half', body: declared.body, headers: { [INTERNAL_HEADER]: secret, 'x-client-ip': '198.51.100.30', 'content-length': String(text.byteLength) } }));
  assert.equal(r2.status, 400);
  assert.equal(declared.pulls, 0, 'a declared length over the cap: not a byte read');
});

test('register: an IPv6 /64 is one address; the limits keep a bounded number of windows and still let a new address in', async () => {
  const h = await boot(makeEnv());
  const bad = (ip) => call(h, 'POST', '/nodes/register', { body: { token: 'tgn1_nope' }, headers: { 'x-client-ip': ip } });
  for (let i = 1; i <= D.REGISTER_PER_IP_PER_HOUR; i++) assert.equal((await bad(`2001:db8:1:2::${i.toString(16)}`)).status, 403);
  assert.equal((await bad('2001:db8:1:2:ffff:ffff:ffff:ffff')).status, 429, 'another address of the same /64');
  assert.equal((await bad('2001:0db8:0001:0002:0:0:0:abcd')).status, 429, 'written out in full');
  assert.equal((await bad('2001:db8:1:3::1')).status, 403, 'the next /64');
  // A flood of fresh keys (one /64 each): the oldest windows go, the map never passes its cap.
  for (let i = 0; i < D.LIMIT_KEYS_MAX + 500; i++) h.obj.limited(`register:2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::/64`, 5, 3_600_000);
  assert.equal(h.obj.limits.size, D.LIMIT_KEYS_MAX);
  assert.equal(h.obj.limits.has('register:2001:db8:1:2::/64'), false, 'the oldest window went first');
  assert.equal((await bad('203.0.113.77')).status, 403, 'a new address is still let through, not refused for a full map');
  assert.equal(h.obj.limits.size, D.LIMIT_KEYS_MAX);
});

test('a control public key that is not the private key’s half: ALERT, and no registration, placement or rejoin', async () => {
  for (const over of [{ NODE_CONTROL_PUBLIC_KEY: (await generateEd25519()).publicKey }, { NODE_CONTROL_PRIVATE_KEY: 'not a key' }]) {
    lines.length = 0;
    const h = await boot(makeEnv(over));
    assert.equal(alerts().length, 1, Object.keys(over)[0]);
    assert.match(alerts()[0], /NODE_CONTROL_PUBLIC_KEY is not the public half of NODE_CONTROL_PRIVATE_KEY/);
    const t = await tokenFor(h);
    const keys = await generateEd25519();
    const r = await call(h, 'POST', '/nodes/register', { body: { token: t.json.token, publicKey: keys.publicKey, roles: ['host'], publicUrl: NODE_URL, build: NODE_BUILD, specs: SPECS, capacity: CAP } });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, 'nodes_unavailable', 'what any outage answers: an anonymous caller does not learn the key pair is wrong');
    assert.doesNotMatch(r.json.message, /key|sign|ticket/);
    assert.equal(h.obj.cp.registry.tokenList()[0].usedBy, null, 'the token is still good');
    assert.deepEqual((await call(h, 'POST', '/internal/place', { body: placeBody() })).json, { placement: null, hosts: 0 });
    const rj = await call(h, 'POST', '/internal/rejoin', { body: { matchId: 'ab'.repeat(32), playerId: A } });
    assert.deepEqual([rj.status, rj.json.error], [503, 'offline'], 'the code that keeps the lock, not nodes_unavailable');
  }
});

// ---- sockets ---------------------------------------------------------------------------------------

test('a node logs in, its { nodeId } is attached once, its probe makes it active, and the alarm runs from the first socket', async () => {
  const h = await boot(makeEnv());
  assert.equal(h.ctx.alarm, null, 'nothing to do yet');
  const node = await registerNode(h);
  const ws = await connect(h, node);
  assert.equal(h.ctx.alarm, clock + D.TICK_MS);
  assert.deepEqual(ws.att, { nodeId: node.nodeId });
  ws.att = 'untouched';
  await send(h, ws, { t: 'hello', data: helloOf(node) });
  await waitFor(() => h.obj.cp.registry.node(node.nodeId).status === 'active', 'trusted: active once reachable');
  await send(h, ws, { t: 'heartbeat', data: beat() });
  assert.equal(ws.att, 'untouched', 'stored once');
  assert.equal(ws.of('welcome')[0].channel.minimum, '0.2.0', 'the channel from R2');
  assert.equal(ws.of('update').length, 0);
  assert.equal(ws.closed, null);
});

test('socket guards: a binary frame closes 1003, a frame over 256 KB 1009, bad JSON 1008, and each frees its session', async () => {
  const h = await boot(makeEnv());
  const node = await registerNode(h);
  const open = async () => {
    await h.obj.fetch(new Request('https://nodes/nodes/connect', { headers: { [INTERNAL_HEADER]: secret, Upgrade: 'websocket' } }));
    return h.ctx.sockets.at(-1);
  };
  const plain = await h.obj.fetch(new Request('https://nodes/nodes/connect', { headers: { [INTERNAL_HEADER]: secret } }));
  assert.equal(plain.status, 426);
  const a = await open();
  await h.obj.webSocketMessage(a, new ArrayBuffer(8));
  assert.deepEqual(a.closed, { code: 1003, reason: 'text only' });
  const b = await open();
  await h.obj.webSocketMessage(b, 'x'.repeat(D.MAX_FRAME_CHARS + 1));
  assert.equal(b.closed.code, 1009);
  const c = await open();
  await h.obj.webSocketMessage(c, '{nope');
  assert.equal(c.closed.code, 1008);
  // A message on a socket the object already let go is not handled (a logged-in one's is only counted).
  await h.obj.webSocketMessage(c, JSON.stringify({ t: 'auth', nodeId: node.nodeId, sig: 'x' }));
  assert.equal(c.closed.code, 1008);
  const d = await open();
  await h.obj.webSocketClose(d, 1001, 'bye', true);
  assert.deepEqual(d.closed, { code: 1001, reason: 'bye' }, 'the close handshake is completed');
  assert.equal(h.ctx.getWebSockets().length, 0);
  await h.obj.alarm();
  assert.equal(h.ctx.alarm, null, 'no socket, no match: the alarm stops');
});

test('a socket the control plane closes ends its session at once, with or without a close event', async () => {
  const h = await boot(makeEnv());
  const { ws } = await liveNode(h);
  assert.equal((await call(h, 'POST', '/internal/place', { body: placeBody() })).json.hosts, 1);
  await send(h, ws, { t: 'heartbeat', data: { active: 'lots' } });
  assert.deepEqual(ws.closed, { code: 1008, reason: 'bad heartbeat' });
  assert.deepEqual((await call(h, 'POST', '/internal/place', { body: placeBody() })).json, { placement: null, hosts: 0 }, 'offline now, not at its heartbeat timeout');
});

// ---- placement and the internal routes -------------------------------------------------------------

test('place: the node is assigned and the row is written before the answer; rejoin, leave and status answer the contract', async () => {
  const h = await boot(makeEnv());
  const { node } = await liveNode(h);
  assert.equal((await call(h, 'POST', '/internal/place', { body: { ...placeBody(), mode: '4v4' } })).status, 400);
  const p = await call(h, 'POST', '/internal/place', { body: placeBody() });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const { placement, hosts } = p.json;
  assert.equal(hosts, 1);
  assert.equal(placement.nodeId, node.nodeId);
  assert.equal(placement.wsUrl, `${NODE_URL}/m/${placement.matchId}`);
  assert.match(placement.matchId, /^[0-9a-f]{64}$/);
  assert.deepEqual(placement.tickets.map((t) => t.playerId), [A, B]);
  assert.deepEqual(rows(h, 'node_matches').map((r) => [r.match_id, r.state]), [[placement.matchId, 'assigned']]);
  const id = placement.matchId;

  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${id}&playerId=${A}`)).json, { state: 'assigned', left: false });
  assert.equal((await call(h, 'GET', `/internal/status?matchId=${id}&playerId=${STRANGER}`)).status, 404);
  const rj = await call(h, 'POST', '/internal/rejoin', { body: { matchId: id, playerId: A } });
  assert.equal(rj.status, 200);
  assert.equal(rj.json.wsUrl, placement.wsUrl);
  assert.ok(rj.json.ticket.length > 100);
  assert.equal((await call(h, 'POST', '/internal/rejoin', { body: { matchId: 'cd'.repeat(32), playerId: A } })).json.error, 'no_match');
  assert.equal((await call(h, 'POST', '/internal/rejoin', { body: { matchId: id, playerId: STRANGER } })).status, 404);

  const lv = await call(h, 'POST', '/internal/leave', { body: { matchId: id, playerId: B, connected: false } });
  assert.equal(lv.status, 200, JSON.stringify(lv.json));
  assert.deepEqual(lv.json, { recorded: true, answer: { slot: 0, closed: true, already: false, ended: false } });
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${id}&playerId=${B}`)).json, { state: 'assigned', left: true });
  const again = await call(h, 'POST', '/internal/rejoin', { body: { matchId: id, playerId: B } });
  assert.deepEqual([again.status, again.json.error], [410, 'left']);
  assert.equal((await call(h, 'POST', '/internal/leave', { body: { matchId: 'cd'.repeat(32), playerId: A } })).status, 404);
  assert.equal(JSON.parse(rows(h, 'node_matches')[0].data).neverJoined[0], B, 'connected: false is kept');
});

test('a node that dropped its link: a leave is not recorded (503) and the lock stays with the player', async () => {
  const h = await boot(makeEnv());
  const { ws } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  await h.obj.webSocketClose(ws, 1006, '', false);
  const lv = await call(h, 'POST', '/internal/leave', { body: { matchId: placement.matchId, playerId: A } });
  assert.deepEqual([lv.status, lv.json.error], [503, 'offline']);
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${placement.matchId}&playerId=${A}`)).json, { state: 'assigned', left: false });
});

// ---- a stalled control link ------------------------------------------------------------------------

/** 2026-10-21 at `hms` UTC. */
const at = (hms) => Date.parse('2026-10-21T' + hms + 'Z');

for (const trusted of [true, false]) {
  test(`a stalled control link, the 2026-10-21 timeline on a ${trusted ? 'project' : 'community'} node: the beats held from x1.7 to x26.7 arrive at once, the link and the match stay, and placement skips the node until then`, async () => {
    clock = at('00:00:40.000');
    const h = await boot(makeEnv());
    clock = at('00:00:50.000');
    const { ws, node } = await liveNode(h);
    // Stage 1 registers only the project's nodes: a community one is the same record, untrusted.
    if (!trusted) h.obj.cp.registry.node(node.nodeId).trusted = false;
    const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
    assert.ok(placement, 'placed');
    const place = async () => (await call(h, 'POST', '/internal/place', { body: placeBody({ humans: humans(STRANGER) }) })).json;
    // The node beats at x1.7 and x6.7 s, the alarm runs at x3.4 and x8.4 s. Every beat sent between
    // 00:01:07 and 00:01:30.6 is held on the way; the four of them arrive at 00:01:30.619.
    const events = [{ t: at('00:01:30.619'), kind: 'flush' }];
    for (let t = at('00:00:51.000'); t <= at('00:01:40.000'); t += 100) {
      if (t % 5_000 === 1_700) events.push({ t, kind: t > at('00:01:07') && t < at('00:01:30.6') ? 'held' : 'beat' });
      if (t % 5_000 === 3_400) events.push({ t, kind: 'alarm' });
    }
    events.sort((a, b) => a.t - b.t);
    lines.length = 0;
    let held = 0;
    let stalled = null;
    let after = null;
    for (const e of events) {
      clock = e.t;
      if (e.kind === 'beat') await send(h, ws, { t: 'heartbeat', data: beat({ active: 1 }) });
      if (e.kind === 'held') held++;
      if (e.kind === 'alarm') await h.obj.alarm();
      if (e.kind === 'flush') {
        for (let i = 0; i < held; i++) await send(h, ws, { t: 'heartbeat', data: beat({ active: 1 }) });
        after = { online: h.obj.cp.registry.node(node.nodeId).online, place: await place() };
      }
      if (clock === at('00:01:23.400')) stalled = { closed: ws.closed, online: h.obj.cp.registry.node(node.nodeId).online, place: await place() };
    }
    assert.equal(held, 4);
    assert.deepEqual(stalled, { closed: null, online: false, place: { placement: null, hosts: 0 } }, 'out of placement at the heartbeat timeout, the link kept');
    assert.ok(lines.includes('[nodes] node sao-paulo-1: no heartbeat for 17 s, no new matches until the next one'), lines.join('\n'));
    assert.equal(after.online, true);
    assert.equal(after.place.hosts, 1);
    assert.equal(after.place.placement?.nodeId, node.nodeId, 'placement takes the node again after the burst');
    assert.ok(lines.includes('[nodes] node sao-paulo-1: heartbeat again after 24 s'), lines.join('\n'));
    assert.equal(ws.closed, null);
    assert.ok(!lines.some((l) => l.includes('4408')), lines.join('\n'));
    assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${placement.matchId}&playerId=${A}`)).json, { state: 'assigned', left: false });
    const n = h.obj.cp.registry.node(node.nodeId);
    assert.deepEqual([n.counters.lost, n.counters.strikes], [0, 0]);
  });
}

test('a link silent past LINK_TIMEOUT_MS is closed with 4408, its silence logged; what it held is counted once, and the same process comes back to its match', async () => {
  const h = await boot(makeEnv());
  const { ws, node } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  await send(h, ws, { t: 'heartbeat', data: beat({ active: 1 }) });
  const last = clock;
  lines.length = 0;
  while (clock + D.TICK_MS - last <= LINK_TIMEOUT_MS) {
    clock += D.TICK_MS;
    await h.obj.alarm();
  }
  assert.equal(ws.closed, null);
  clock += D.TICK_MS;
  await h.obj.alarm();
  assert.deepEqual(ws.closed, { code: 4408, reason: 'heartbeat timeout' });
  assert.ok(lines.includes(`[nodes] node sao-paulo-1: silent ${Math.round((clock - last) / 1000)} s, closing its control link (4408)`), lines.join('\n'));
  // The stall ends: its heartbeats come in on the closed socket, then the node's answer to the close.
  clock += 1_000;
  const late = clock - last;
  for (let i = 0; i < 10; i++) await send(h, ws, { t: 'heartbeat', data: beat({ active: 1 }) });
  await h.obj.webSocketClose(ws, 4408, 'heartbeat timeout', true);
  assert.equal(h.obj.cp.registry.node(node.nodeId).lastSeen, last, 'a closed link carries no heartbeat');
  // The same process logs in again (its backoff starts at 1 s), within NODE_OFFLINE_MS of its last heartbeat.
  clock += 1_000;
  const back = await connect(h, node);
  await send(h, back, { t: 'hello', data: helloOf(node) });
  await send(h, back, { t: 'heartbeat', data: beat({ active: 1 }) });
  for (let i = 0; i < 4; i++) {
    clock += D.TICK_MS;
    await send(h, back, { t: 'heartbeat', data: beat({ active: 1 }) });
    await h.obj.alarm();
  }
  assert.deepEqual(
    lines.filter((l) => l.includes('after its link was closed')),
    [`[nodes] node sao-paulo-1: 10 messages after its link was closed, up to ${Math.round((late - 5_000) / 1000)} s late`],
    'once, at the next alarm',
  );
  assert.equal(back.closed, null);
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${placement.matchId}&playerId=${A}`)).json, { state: 'assigned', left: false });
  const n = h.obj.cp.registry.node(node.nodeId);
  assert.deepEqual([n.counters.lost, n.counters.strikes], [0, 0]);
});

// ---- settled matches and the outbox ----------------------------------------------------------------

test('a ranked match the node lost: the settled row and its outbox rows exist when the ack goes out; /ranked-cancel then /release', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody({ ranked: true }) })).json;
  let atAck = null;
  answer(h, ws, { publicUrl: NODE_URL }, { onSend: (m) => m.t === 'ack' && (atAck = { matches: rows(h, 'node_matches').map((r) => r.state), outbox: rows(h, 'outbox').map((r) => r.path) }) });
  let open;
  env.ACCOUNTS.gate = env.MATCHMAKER.gate = new Promise((r) => (open = r));
  await send(h, ws, { t: 'report', id: 'r1', report: { kind: 'lost', matchId: placement.matchId, reason: 'tick_error' } });
  assert.deepEqual(atAck, { matches: ['done'], outbox: ['/ranked-cancel', '/release'] });
  open();
  env.ACCOUNTS.gate = env.MATCHMAKER.gate = null;
  await h.ctx.settle();
  assert.deepEqual(env.ACCOUNTS.calls.map((c) => [c.name, c.path, c.body.playlist, c.body.region, c.body.players, c.body.reason]), [['accounts-v1', '/ranked-cancel', '1v1', 'SA', [A, B], 'lost:tick_error']]);
  assert.deepEqual(env.MATCHMAKER.calls.map((c) => [c.name, c.path, c.body]), [['mm:SA', '/release', { matchId: placement.matchId, playerIds: [A, B] }]]);
  assert.deepEqual(rows(h, 'outbox'), [], 'delivered right away, not at the next alarm');
});

test('a casual match only frees its locks; a 5xx is tried again later, further apart, with an ALERT after a day', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  env.MATCHMAKER.answer = () => new RealResponse('down', { status: 503 });
  await send(h, ws, { t: 'report', id: 'r1', report: { kind: 'lost', matchId: placement.matchId, reason: 'tick_error' } });
  await h.ctx.settle();
  assert.equal(env.ACCOUNTS.calls.length, 0, 'a casual match records nothing');
  assert.equal(env.MATCHMAKER.calls.length, 1);
  let [row] = rows(h, 'outbox');
  assert.deepEqual([row.path, row.attempts, row.next_at - clock], ['/release', 1, 2_000]);
  /** An alarm and the delivery it starts (not waited for by the alarm itself). */
  const tick = async () => {
    await h.obj.alarm();
    await h.ctx.settle();
  };
  await tick();
  assert.equal(env.MATCHMAKER.calls.length, 1, 'not due yet');
  clock += 2_000;
  await tick();
  [row] = rows(h, 'outbox');
  assert.deepEqual([row.attempts, row.next_at - clock], [2, 4_000]);
  assert.equal(h.ctx.alarm, clock + D.TICK_MS, 'an undelivered row keeps the alarm');
  lines.length = 0;
  clock += 24 * 3_600_000;
  await tick();
  await tick();
  const late = alerts().filter((l) => l.includes(' outbox '));
  assert.equal(late.length, 1, 'once');
  assert.match(late[0], /ALERT outbox \/release for match \w{8} \(mm:SA\) undelivered for a day, 3 tries/);
  assert.equal(rows(h, 'outbox')[0].next_at - clock, 8_000);
  env.MATCHMAKER.answer = () => new RealResponse('{"ok":true}');
  clock += 300_000;
  await tick();
  assert.deepEqual(rows(h, 'outbox'), []);
});

test('a target that never answers holds back neither the alarm nor the other targets; its rows are retried after the timeout, one wait per pass', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws } = await liveNode(h);
  h.obj.timeoutMs = 200;
  env.ACCOUNTS.gate = new Promise(() => {}); // AccountsDO is stuck: no answer, no error
  /** A ranked match the node lost: a /ranked-cancel (AccountsDO) and a /release (the matchmaker). */
  const lose = async () => {
    const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody({ ranked: true }) })).json;
    await send(h, ws, { t: 'report', id: 'r-' + placement.matchId.slice(0, 8), report: { kind: 'lost', matchId: placement.matchId, reason: 'tick_error' } });
    return placement.matchId;
  };
  const first = await lose(); // its delivery starts now and waits on AccountsDO
  h.ctx.alarm = null; // the runtime consumed the alarm that runs now
  lines.length = 0;
  await within(1_000, h.obj.alarm(), 'the alarm waited for a delivery that never ends');
  assert.equal(h.ctx.alarm, clock + D.TICK_MS, 're-armed while the delivery still waits');
  assert.equal(rows(h, 'outbox')[0].attempts, 0, 'not given up yet: the alarm did not wait for it');
  await within(1_000, h.obj.alarm(), 'the alarm waited for the drain in flight');
  assert.equal(h.ctx.alarm, clock + D.TICK_MS, 'a second run neither');
  await h.ctx.settle();
  assert.deepEqual(rows(h, 'outbox').map((r) => [r.match_id, r.path, r.attempts, r.next_at - clock]), [[first, '/ranked-cancel', 1, 2_000]]);
  assert.ok(lines.some((l) => /outbox \/ranked-cancel failed \(match \w{8}, accounts\), to retry: Error: no answer in 0\.2 s/.test(l)), lines.join('\n'));
  assert.deepEqual(env.MATCHMAKER.calls.map((c) => c.body.matchId), [first], 'the other target was not held back');
  const second = await lose();
  await h.ctx.settle();
  clock += 2_000; // both /ranked-cancel rows are due
  await h.obj.alarm();
  await h.ctx.settle();
  assert.deepEqual(
    rows(h, 'outbox').map((r) => [r.match_id, r.attempts]),
    [
      [first, 2],
      [second, 1],
    ],
    'one wait for the stuck target in that pass: its second row waited for the next one',
  );
  assert.deepEqual(env.MATCHMAKER.calls.map((c) => c.body.matchId), [first, second]);
  env.ACCOUNTS.gate = null;
  clock += 4_000;
  await h.obj.alarm();
  await h.ctx.settle();
  assert.deepEqual(rows(h, 'outbox'), []);
  assert.deepEqual(env.ACCOUNTS.calls.map((c) => [c.path, c.body.matchId]), [['/ranked-cancel', first], ['/ranked-cancel', second]]);
});

test('a read of channel.json that never answers is given up: the alarm still re-arms and the last channel is kept', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws } = await liveNode(h);
  h.obj.timeoutMs = 50;
  env.NODE_RELEASES.get = () => new Promise(() => {});
  lines.length = 0;
  clock += D.CHANNEL_REFRESH_MS;
  await send(h, ws, { t: 'heartbeat', data: beat() });
  h.ctx.alarm = null;
  await within(1_000, h.obj.alarm(), 'the alarm waited for a read that never ends');
  assert.equal(h.ctx.alarm, clock + D.TICK_MS);
  assert.ok(lines.some((l) => l === '[nodes] channel.json not read, keeping the last one: Error: no answer in 0.05 s'), lines.join('\n'));
  assert.equal(ws.of('update').length, 0);
  assert.equal(ws.closed, null);
});

// ---- the alarm -------------------------------------------------------------------------------------

test('the alarm: re-armed while a socket, a match, a grace or an offline trusted node needs it, deleted when nothing does; a sweep that throws still re-arms', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws, node } = await liveNode(h);
  await h.obj.alarm();
  assert.equal(h.ctx.alarm, clock + D.TICK_MS, 'a socket');
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  await h.obj.webSocketClose(ws, 1006, '', false);
  await h.obj.alarm();
  assert.equal(h.ctx.alarm, clock + D.TICK_MS, 'no socket, but a match the sweep must still void');
  // The store fails while the sweep voids the silent node's match: an ALERT, the match stays, the alarm too.
  const store = h.obj.store;
  const finished = store.finished;
  store.finished = () => {
    throw new Error('disk full');
  };
  lines.length = 0;
  clock += NODE_OFFLINE_MS + 1;
  await h.obj.alarm();
  assert.match(alerts()[0], /ALERT sweep failed: Error: disk full/);
  assert.equal(h.ctx.alarm, clock + D.TICK_MS);
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${placement.matchId}&playerId=${A}`)).json.state, 'assigned');
  store.finished = finished;
  clock += D.TICK_MS;
  await h.obj.alarm();
  await h.ctx.settle();
  assert.equal(rows(h, 'node_matches')[0].state, 'done');
  assert.deepEqual(env.MATCHMAKER.calls.map((c) => c.path), ['/release']);
  await h.obj.alarm();
  assert.equal(h.ctx.alarm, clock + D.TICK_MS, 'the trusted node is still offline: its ALERT needs the alarm');
  h.obj.cp.setStatus(node.nodeId, 'suspended', 'retired');
  await h.obj.alarm();
  assert.equal(h.ctx.alarm, null, 'nothing left: deleted');
});

test('channel.json is read again every minute: a new minimum sends the nodes below it their update', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws } = await liveNode(h);
  /** Time passes for a node that keeps beating. */
  const later = async (ms) => {
    clock += ms;
    await send(h, ws, { t: 'heartbeat', data: beat() });
    await h.obj.alarm();
  };
  await env.NODE_RELEASES.put('channel.json', JSON.stringify({ stable: '0.3.0', minimum: '0.3.0' }));
  await later(30_000);
  assert.equal(ws.of('update').length, 0, 'not read yet');
  await later(D.CHANNEL_REFRESH_MS);
  assert.deepEqual(ws.of('update'), [{ t: 'update', version: '0.3.0' }]);
  await later(D.CHANNEL_REFRESH_MS);
  assert.equal(ws.of('update').length, 1, 'unchanged: nothing new');
  // A broken channel keeps the last good one, with one ALERT.
  lines.length = 0;
  await env.NODE_RELEASES.put('channel.json', '{"stable":');
  await later(D.CHANNEL_REFRESH_MS);
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /release channel missing or invalid .*holding the nodes to stable 0\.3\.0, minimum 0\.3\.0/);
});

// ---- deploys and hibernations ------------------------------------------------------------------------

test('a deploy (no socket survives) with an unfinished match: a grace, the alarm armed, and nothing voided before it ends', async () => {
  const env = makeEnv();
  let h = await boot(env);
  const { ws, node } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  ws.close(1012, 'deploy');
  const ctx = new FakeCtx(h.ctx.db);
  h = await boot(env, ctx);
  assert.equal(h.obj.cp.inGrace(), true);
  assert.equal(ctx.alarm, clock + D.TICK_MS);
  clock += RESTART_GRACE_MS - 1_000;
  await h.obj.alarm();
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${placement.matchId}&playerId=${A}`)).json.state, 'assigned');
  // The same node process comes back within the grace: its match goes on.
  const back = await connect(h, node);
  await send(h, back, { t: 'hello', data: helloOf(node) });
  clock += 10_000;
  await send(h, back, { t: 'heartbeat', data: beat({ active: 1 }) });
  await h.obj.alarm();
  assert.equal(h.obj.cp.inGrace(), false);
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${placement.matchId}&playerId=${A}`)).json.state, 'assigned');
  assert.equal(env.MATCHMAKER.calls.length, 0);
});

test('a deploy whose node never comes back: its match is void once the grace is over', async () => {
  const env = makeEnv();
  let h = await boot(env);
  const { ws } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  ws.close(1012, 'deploy');
  h = await boot(env, new FakeCtx(h.ctx.db));
  clock += RESTART_GRACE_MS + 1_000;
  await h.obj.alarm();
  await h.ctx.settle();
  assert.equal(rows(h, 'node_matches')[0].state, 'done');
  assert.deepEqual(env.MATCHMAKER.calls.map((c) => [c.path, c.body.matchId]), [['/release', placement.matchId]]);
});

test('a hibernation: the sockets are adopted without a grace, a placement uses the node before its next heartbeat, which is accepted', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { ws, node } = await liveNode(h);
  const first = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json.placement;
  // A second socket still logging in when the object slept.
  await h.obj.fetch(new Request('https://nodes/nodes/connect', { headers: { [INTERNAL_HEADER]: secret, Upgrade: 'websocket' } }));
  const pending = h.ctx.sockets.at(-1);
  const ctx = h.ctx;
  h.obj = new D.NodeRegistryDO(ctx, env); // same sockets, same database: the memory is all that went
  await h.obj.ready;
  assert.equal(h.obj.cp.unfinished(), 1);
  assert.equal(h.obj.cp.inGrace(), false, 'the node never lost its link: no grace');
  assert.deepEqual(pending.closed, { code: 4401, reason: 'log in again' });
  assert.equal(ws.closed, null);
  clock += 3_000;
  const p = await call(h, 'POST', '/internal/place', { body: placeBody() });
  assert.equal(p.json.placement?.nodeId, node.nodeId, 'adopted: online from the wake');
  await send(h, ws, { t: 'heartbeat', data: beat({ active: 1 }) });
  assert.equal(ws.closed, null, 'no new challenge: the heartbeat is taken');
  assert.equal(h.obj.cp.registry.node(node.nodeId).active, 1);
  assert.deepEqual((await call(h, 'GET', `/internal/status?matchId=${first.matchId}&playerId=${A}`)).json.state, 'assigned');
});

// ---- replays -----------------------------------------------------------------------------------------

test('a replay upload: refused before its body is read when the signature is wrong; 413 past 16 MiB; stored in R2 otherwise', async () => {
  const env = makeEnv();
  const h = await boot(env);
  const { node } = await liveNode(h);
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  const id = placement.matchId;
  const bytes = new Uint8Array(4096).map((_, i) => i & 0xff);
  const sha = await sha256Hex(bytes);
  const put = async (s, sig, ts = clock) =>
    h.obj.fetch(
      new Request(`https://nodes/nodes/replays/${id}`, {
        method: 'PUT',
        duplex: 'half',
        body: s.body,
        headers: { [INTERNAL_HEADER]: secret, 'x-node-id': node.nodeId, 'x-node-ts': String(ts), 'x-node-sig': sig, 'x-replay-sha256': sha },
      }),
    );
  const forged = stream([bytes]);
  const other = await importPrivateKey((await generateEd25519()).privateKey);
  const r1 = await put(forged, await sign(other, replayRequestMessage('PUT', id, sha, clock)));
  assert.deepEqual([r1.status, (await r1.json()).error], [401, 'bad_sig']);
  assert.equal(forged.pulls, 0, 'not a byte read');
  const sig = await sign(node.key, replayRequestMessage('PUT', id, sha, clock));
  const huge = stream(Array.from({ length: 20 }, () => new Uint8Array(1024 * 1024)));
  const r2 = await put(huge, sig);
  assert.equal(r2.status, 413);
  assert.ok(huge.pulls <= 17, 'reading stopped at the cap');
  const r3 = await put(stream([bytes.slice(0, 1000), bytes.slice(1000)]), sig);
  assert.equal(r3.status, 200, await r3.clone().text());
  assert.deepEqual(env.NODE_REPLAYS.objects.get(id), bytes);
  assert.equal(JSON.parse(rows(h, 'node_matches')[0].data).replaySha, sha, 'written before the 200');
  // Only the verifier the job went to may read it back.
  const get = await h.obj.fetch(new Request(`https://nodes/nodes/replays/${id}`, { headers: { [INTERNAL_HEADER]: secret, 'x-node-id': node.nodeId, 'x-node-ts': String(clock), 'x-node-sig': sig, 'x-replay-sha256': sha } }));
  assert.equal(get.status, 404);
});

// ---- public views ------------------------------------------------------------------------------------

test('status lists the nodes without their address; mine shows the operator its own', async () => {
  const h = await boot(makeEnv());
  const { node } = await liveNode(h);
  const s = await call(h, 'GET', '/nodes/status');
  assert.equal(s.status, 200);
  assert.deepEqual(s.json.build, CLIENT_BUILD);
  assert.equal(s.json.nodes.length, 1);
  assert.deepEqual([s.json.nodes[0].name, s.json.nodes[0].status, s.json.nodes[0].trusted, s.json.nodes[0].compatible], ['sao-paulo-1', 'active', true, true]);
  assert.ok(!JSON.stringify(s.json).includes('sp1.turbo-gol.test'), 'no address');
  assert.ok(!JSON.stringify(s.json).includes(node.nodeId), 'no node id');
  const mine = await call(h, 'GET', '/nodes/mine', { headers: { 'x-operator-id': PROJECT } });
  assert.deepEqual(mine.json.operator, { id: PROJECT, trusted: true });
  assert.deepEqual(mine.json.nodes.map((n) => [n.nodeId, n.publicUrl, n.reachable]), [[node.nodeId, NODE_URL, true]]);
  assert.deepEqual((await call(h, 'GET', '/nodes/mine', { headers: { 'x-operator-id': STRANGER } })).json.nodes, []);
});

// ---- the team's channel, the watch, the cron's health check --------------------------------------------

const MIN = 60_000;

/**
 * A NodeRegistryDO posting its ALERTs to the fake webhook, with a live trusted node and nothing
 * posted yet: a minute later, so the token's and the registration's posts are behind every limit.
 */
async function watched(over = {}) {
  const env = makeEnv({ NODE_ALERT_WEBHOOK: HOOK, ...over });
  const h = await boot(env);
  const live = await liveNode(h);
  await h.ctx.settle();
  clock += MIN;
  await send(h, live.ws, { t: 'heartbeat', data: beat() });
  posts.length = 0;
  return { h, env, ...live };
}

test('ALERT lines go to the team’s channel, the registry’s and the outbox’s too: in a code span, no mention; every token and trusted node each time', async () => {
  posts.length = 0;
  const env = makeEnv({ NODE_ALERT_WEBHOOK: HOOK });
  const h = await boot(env);
  const { node, ws } = await liveNode(h);
  await tokenFor(h); // the same line as the first token's: an account's action, posted again
  await h.ctx.settle();
  const token = '**ALERT** `registration token created for trusted operator Proyecto Señor (a1b2c3d4e5f60718), region SA`';
  assert.deepEqual(posted(), [token, `**ALERT** \`trusted node sao-paulo-1 (${node.nodeId}) registered for Proyecto Señor (a1b2c3d4e5f60718), roles host+verify at wss://sp1.turbo-gol.test\``, token]);
  assert.deepEqual(posts[0].allowed_mentions, { parse: [] });
  clock += 5 * MIN;
  await send(h, ws, { t: 'heartbeat', data: beat() });
  await tokenFor(h);
  await h.ctx.settle();
  assert.deepEqual(posted().slice(3), [token], 'five minutes later too');
  // A call AccountsDO refuses: the outbox drops it with an ALERT, which carries the body.
  env.ACCOUNTS.answer = () => new RealResponse('{"error":"bad_request"}', { status: 400 });
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody({ ranked: true }) })).json;
  await send(h, ws, { t: 'report', id: 'r1', report: { kind: 'lost', matchId: placement.matchId, reason: 'tick_error' } });
  await h.ctx.settle();
  assert.match(posted().at(-1), /^\*\*ALERT\*\* `outbox \/ranked-cancel 400 \(match \w{8}, accounts\), dropped: \{"error":"bad_request"\}; body \{.*\}`$/);
  // The control key: logged while the object starts, posted all the same.
  posts.length = 0;
  const bad = await boot(makeEnv({ NODE_ALERT_WEBHOOK: HOOK, NODE_CONTROL_PUBLIC_KEY: (await generateEd25519()).publicKey }));
  await bad.ctx.settle();
  assert.deepEqual(posted(), ['**ALERT** `NODE_CONTROL_PUBLIC_KEY is not the public half of NODE_CONTROL_PRIVATE_KEY: no placement, registration or rejoin until they match`']);
  // Without the webhook nothing is posted.
  posts.length = 0;
  const quiet = await boot(makeEnv());
  await tokenFor(quiet);
  await quiet.ctx.settle();
  assert.deepEqual(posts, []);
});

test('a trusted node offline for 2 minutes: one ALERT, the alarm running for it until then; a restart does not raise it again, its return is a plain line', async () => {
  const { h, env, node, ws } = await watched();
  const kept = () => rows(h, 'meta').find((r) => r.k === 'offline_alerted')?.v;
  await h.obj.webSocketClose(ws, 1006, '', false);
  await h.obj.alarm();
  assert.equal(h.ctx.alarm, clock + D.TICK_MS, 'no socket and no match: the offline node keeps the alarm');
  clock += 2 * MIN;
  await h.obj.alarm();
  await h.ctx.settle();
  assert.deepEqual(posts, [], 'not yet');
  clock += D.TICK_MS;
  await h.obj.alarm();
  assert.equal(h.ctx.alarm, null, 'its ALERT is out: nothing needs the alarm any more');
  await h.obj.alarm();
  await h.ctx.settle();
  assert.equal(posts.length, 1, 'once');
  assert.match(posted()[0], new RegExp(`^\\*\\*ALERT\\*\\* \`trusted node sao-paulo-1 \\(${node.nodeId}\\) offline for 2 min \\(last heartbeat \\d\\d:\\d\\d:\\d\\d UTC\\): no match goes to it\`$`));
  assert.equal(kept(), JSON.stringify([node.nodeId]));
  // A deploy, or the object evicted while it slept: the new one knows that ALERT went out.
  lines.length = 0;
  const later = await boot(env, new FakeCtx(h.ctx.db));
  assert.equal(later.ctx.alarm, null, 'nothing to wait for');
  clock += 3 * MIN;
  await later.obj.alarm();
  assert.deepEqual(alerts(), [], 'not raised again');
  // Its return: a plain line, and the row lets it go.
  const back = await connect(later, node);
  await send(later, back, { t: 'hello', data: helloOf(node) });
  await later.obj.alarm();
  await later.ctx.settle();
  assert.ok(lines.includes(`[nodes] trusted node sao-paulo-1 (${node.nodeId}) back online`), lines.join('\n'));
  assert.equal(posts.length, 1, 'not an ALERT');
  assert.equal(kept(), '[]');
  // Offline again, taken out of service, and back in service while still offline: a new outage, and the alarm runs for it.
  const status = (s) => call(later, 'POST', '/nodes/admin/status', { body: { nodeId: node.nodeId, status: s }, headers: { 'x-operator-id': PROJECT } });
  await later.obj.webSocketClose(back, 1006, '', false);
  clock += 3 * MIN;
  await later.obj.alarm();
  assert.deepEqual([kept(), later.ctx.alarm], [JSON.stringify([node.nodeId]), null]);
  await status('suspended');
  assert.deepEqual([kept(), later.ctx.alarm], ['[]', null], 'out of service: not watched');
  lines.length = 0;
  await status('active');
  assert.equal(later.ctx.alarm, clock + D.TICK_MS);
  await later.obj.alarm();
  assert.equal(alerts().filter((l) => l.includes(`trusted node sao-paulo-1 (${node.nodeId}) offline for`)).length, 1);
});

test('the watch: tick lag over 8 ms in 3 heartbeats, traffic at 80 % of the cap, a verification waiting 30 minutes, an update deferred for 2 hours', async () => {
  const { h, env, node, ws } = await watched();
  for (let i = 0; i < 3; i++) await send(h, ws, { t: 'heartbeat', data: beat({ tickLagP99Ms: 9.5 }) });
  await h.ctx.settle();
  assert.deepEqual(posted(), [`**ALERT** \`node sao-paulo-1 (${node.nodeId}): tick lag p99 9.5 ms in 3 heartbeats in a row (over 8 ms: its matches stutter)\``], 'at the third heartbeat, not at an alarm');
  await send(h, ws, { t: 'heartbeat', data: beat({ egressGB: 850, egressCapGB: 1000 }) });
  await h.obj.alarm();
  await h.ctx.settle();
  assert.match(posted()[1], /has sent 850\.0 GB of its 1000 GB monthly cap \(85 %\): at the cap it takes no more matches`$/);
  // A match its verifier has not answered for half an hour.
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  Object.assign(h.obj.cp.matches.get(placement.matchId), { state: 'verifying', report: { kind: 'ended', replaySha256: 'ab'.repeat(32) }, queuedAt: clock - 31 * MIN });
  await h.obj.alarm();
  await h.ctx.settle();
  assert.match(posted()[2], new RegExp(`^\\*\\*ALERT\\*\\* \`1 match waiting for verification, the oldest \\(${placement.matchId.slice(0, 8)} on sao-paulo-1\\) for 31 min: is a verifier on its build online\\?\`$`));
  // The channel moves on; the node verifies matches of its build, so its update waits for them.
  await env.NODE_RELEASES.put('channel.json', JSON.stringify({ stable: '0.3.0', minimum: '0.3.0' }));
  clock += D.CHANNEL_REFRESH_MS;
  await send(h, ws, { t: 'heartbeat', data: beat() });
  await h.obj.alarm();
  assert.deepEqual(ws.of('update'), [], 'deferred');
  await h.obj.alarm();
  clock += 2 * 60 * MIN + D.TICK_MS;
  await send(h, ws, { t: 'heartbeat', data: beat() });
  await h.obj.alarm();
  await h.ctx.settle();
  assert.equal(posts.length, 4);
  assert.match(posted()[3], new RegExp(`node sao-paulo-1 \\(${node.nodeId}\\) still on 0\\.2\\.0, below the channel's minimum 0\\.3\\.0, for 2 h: its update is deferred or it does not take it\`$`));
});

test('the cron’s health check: a TLS error while the heartbeats look fine is an ALERT, once; a drain nobody asked for too, not one the control plane asked for', async () => {
  const { h, node, ws } = await watched();
  const health = async () => (await call(h, 'POST', '/internal/health')).json;
  assert.deepEqual(await health(), { probed: 1, problems: 0 });
  node.fail = () => {
    throw new TypeError('fetch failed: certificate has expired');
  };
  assert.deepEqual(await health(), { probed: 1, problems: 1 });
  await send(h, ws, { t: 'heartbeat', data: beat() });
  assert.deepEqual(await health(), { probed: 1, problems: 1 });
  await h.ctx.settle();
  assert.deepEqual(posted(), [`**ALERT** \`node sao-paulo-1 (${node.nodeId}) /healthz at https://sp1.turbo-gol.test: TLS error (an expired or invalid certificate?): TypeError: fetch failed: certificate has expired\``]);
  assert.equal(h.obj.cp.registry.node(node.nodeId).online, true, 'its heartbeats look fine');
  node.fail = null;
  lines.length = 0;
  assert.deepEqual(await health(), { probed: 1, problems: 0 });
  assert.ok(lines.includes(`[nodes] node sao-paulo-1 (${node.nodeId}) /healthz answers again`));
  // A new problem is a new ALERT; past 10 minutes, the channel takes this node's again.
  clock += 10 * MIN;
  await send(h, ws, { t: 'heartbeat', data: beat() });
  node.draining = true;
  assert.deepEqual(await health(), { probed: 1, problems: 1 });
  await h.ctx.settle();
  assert.match(posted().at(-1), /: draining, and the control plane did not ask it to \(no drain, no update\)`$/);
  h.obj.cp.drain(node.nodeId, 'maintenance');
  assert.deepEqual(ws.of('drain'), [{ t: 'drain', reason: 'maintenance' }]);
  assert.deepEqual(await health(), { probed: 1, problems: 0 }, 'a drain the control plane asked for');
  await send(h, ws, { t: 'hello', data: helloOf(node, { bootId: 'boot-2', draining: true }) });
  assert.deepEqual(await health(), { probed: 1, problems: 1 }, 'a new node process that drains: nobody asked that one');
  node.draining = false;
  h.obj.healthzTimeoutMs = 30;
  node.fail = () => new Promise(() => {});
  lines.length = 0;
  assert.deepEqual(await within(1_000, health(), 'the probe waited for a node that never answers'), { probed: 1, problems: 1 });
  assert.ok(lines.includes(`[nodes] node sao-paulo-1 (${node.nodeId}) /healthz at https://sp1.turbo-gol.test still fails, now: no answer in 0.03 s`), lines.join('\n'));
  assert.deepEqual(alerts(), [], 'the same problem in another kind: no new ALERT');
  node.fail = null;
  await h.obj.webSocketClose(ws, 1006, '', false);
  assert.equal((await health()).probed, 1, 'offline, but seen within the hour');
  clock += 61 * MIN;
  assert.deepEqual(await health(), { probed: 0, problems: 0 }, 'gone for more than an hour: its offline ALERT went out');
});

test('the cron’s health check through a deploy: a drain asked before it is still expected, and so is the drain of a node below the channel’s minimum', async () => {
  const { h: before, env, node, ws } = await watched();
  before.obj.cp.drain(node.nodeId, 'maintenance');
  assert.equal(rows(before, 'meta').find((r) => r.k === 'drains_asked')?.v, JSON.stringify({ [node.nodeId]: 'boot-1' }), 'written down with the node process it went to');
  node.draining = true;
  // A deploy: every socket drops, and the same node process logs in again, still draining.
  ws.close(1012, 'deploy');
  const h = await boot(env, new FakeCtx(before.ctx.db));
  const back = await connect(h, node);
  await send(h, back, { t: 'hello', data: helloOf(node, { draining: true }) });
  const health = async () => (await call(h, 'POST', '/internal/health')).json;
  assert.deepEqual(await health(), { probed: 1, problems: 0 }, 'the drain asked before the deploy');
  // A new node process, a match on its build, and a channel that moves on: the verifier's update
  // waits for the match (no 'update' goes out), and the node drains by itself, as its welcome says.
  node.draining = false;
  await send(h, back, { t: 'hello', data: helloOf(node, { bootId: 'boot-2' }) });
  assert.ok((await call(h, 'POST', '/internal/place', { body: placeBody() })).json.placement);
  await env.NODE_RELEASES.put('channel.json', JSON.stringify({ stable: '0.3.0', minimum: '0.3.0' }));
  clock += D.CHANNEL_REFRESH_MS;
  await send(h, back, { t: 'heartbeat', data: beat({ active: 1 }) });
  await h.obj.alarm();
  assert.deepEqual(back.of('update'), [], 'deferred');
  node.draining = true;
  assert.deepEqual(await health(), { probed: 1, problems: 0 }, 'below the minimum: an update');
  await h.ctx.settle();
  assert.deepEqual(posts, []);
});

test('the maintainers’ routes: a trusted account only; the list, status, drain, update and reprobe, each an ALERT naming the account', async () => {
  const { h, env, node, ws } = await watched();
  const admin = { 'x-operator-id': PROJECT, 'x-operator-name': encodeURIComponent('Proyecto Señor') };
  const actor = 'admin Proyecto Señor (a1b2c3d4e5f60718)';
  const run = (method, what, body, headers = admin) => call(h, method, '/nodes/admin/' + what, { body, headers });
  for (const [m, w] of [['GET', 'nodes'], ['POST', 'drain'], ['POST', 'update']]) assert.equal((await run(m, w, m === 'POST' ? {} : undefined, { 'x-operator-id': STRANGER })).status, 403, w);
  assert.equal((await run('GET', 'status')).status, 404);
  assert.equal((await run('POST', 'reboot', { nodeId: node.nodeId })).status, 404);
  assert.equal((await run('POST', 'drain', { nodeId: 'nope' })).json.error, 'bad_node_id');
  assert.equal((await run('POST', 'drain', { nodeId: 'f'.repeat(16) })).json.error, 'no_node');
  // The list: everything about every node, its address and the matches held for it included.
  const { placement } = (await call(h, 'POST', '/internal/place', { body: placeBody() })).json;
  const list = await run('GET', 'nodes');
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.deepEqual(list.json.channel, { stable: '0.2.0', minimum: '0.2.0' });
  const [v] = list.json.nodes;
  assert.deepEqual([v.nodeId, v.publicUrl, v.operator, v.status, v.online, v.matches, v.lastSeen], [node.nodeId, NODE_URL, { id: PROJECT, name: 'Proyecto Señor' }, 'active', true, 1, clock]);
  await h.ctx.settle();
  assert.deepEqual(posted(), [`**ALERT** \`${actor}: listed the nodes (1, with their addresses)\``], 'a read too: the list holds the addresses');
  // The match ends: no work left on the node's build, so an update is not deferred.
  await send(h, ws, { t: 'report', id: 'r1', report: { kind: 'lost', matchId: placement.matchId, reason: 'tick_error' } });
  // status
  assert.equal((await run('POST', 'status', { nodeId: node.nodeId, status: 'pending' })).json.error, 'bad_status');
  const st = await run('POST', 'status', { nodeId: node.nodeId, status: 'suspended', reason: 'disk\nfull' });
  assert.deepEqual(st.json, { nodeId: node.nodeId, name: 'sao-paulo-1', status: 'suspended', was: 'active' });
  assert.deepEqual(ws.of('status').at(-1), { t: 'status', status: 'suspended', reason: 'disk full' });
  assert.equal((await run('POST', 'status', { nodeId: node.nodeId, status: 'active' })).json.status, 'active');
  // drain
  const dr = await run('POST', 'drain', { nodeId: node.nodeId, reason: 'kernel update' });
  assert.deepEqual([dr.status, dr.json.draining], [200, true]);
  assert.deepEqual(ws.of('drain'), [{ t: 'drain', reason: 'kernel update' }]);
  // update: the channel read again now, not within the minute
  await env.NODE_RELEASES.put('channel.json', JSON.stringify({ stable: '0.3.0', minimum: '0.3.0' }));
  const up = await run('POST', 'update');
  assert.deepEqual(up.json, { channel: { stable: '0.3.0', minimum: '0.3.0' }, below: [{ nodeId: node.nodeId, name: 'sao-paulo-1', version: '0.2.0' }] });
  assert.deepEqual(ws.of('update'), [{ t: 'update', version: '0.3.0' }], 'told once');
  assert.equal((await run('POST', 'update')).status, 200);
  assert.equal(ws.of('update').length, 2, 'asked again, told again');
  // reprobe: the control plane's probe and a direct one
  node.fail = () => {
    throw new TypeError('fetch failed: certificate has expired');
  };
  const rp = await run('POST', 'reprobe', { nodeId: node.nodeId });
  assert.deepEqual([rp.json.reachable, rp.json.healthz.kind], [true, 'tls'], 'one failed re-probe does not take a node out yet');
  node.fail = null;
  await h.ctx.settle();
  assert.deepEqual(posted(), [
    `**ALERT** \`${actor}: listed the nodes (1, with their addresses)\``,
    `**ALERT** \`${actor}: node sao-paulo-1 (${node.nodeId}) active -> suspended: disk full\``,
    `**ALERT** \`${actor}: node sao-paulo-1 (${node.nodeId}) suspended -> active\``,
    `**ALERT** \`${actor}: node sao-paulo-1 (${node.nodeId}) told to drain: kernel update\``,
    `**ALERT** \`${actor}: the nodes were told the channel again (stable 0.3.0, minimum 0.3.0): 1 online below its minimum\``,
    `**ALERT** \`${actor}: the nodes were told the channel again (stable 0.3.0, minimum 0.3.0): 1 online below its minimum\``,
    `**ALERT** \`${actor}: node sao-paulo-1 (${node.nodeId}) probed: TLS error (an expired or invalid certificate?): TypeError: fetch failed: certificate has expired; in wss placement\``,
  ], 'every call, the same one twice too, and more in a minute than the 5 alerts a minute');
  // A node offline is told nothing.
  await h.obj.webSocketClose(ws, 1006, '', false);
  const off = await run('POST', 'drain', { nodeId: node.nodeId });
  assert.deepEqual([off.status, off.json.error], [409, 'offline']);
  assert.ok(lines.at(-1).endsWith('not drained, it is offline: asked by a maintainer'), lines.at(-1));
});

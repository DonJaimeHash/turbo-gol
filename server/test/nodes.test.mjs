// Community nodes on the Worker's side, without workerd: the nodes config helpers of
// server/src/env.ts on a fake KV (and its capped body reader and per-address limit key), the
// NodeRegistryDO's address and internal contract
// (server/src/nodeApi.ts), and the outcome calls of a finished node match
// (server/src/nodeOutcome.ts) delivered to fake namespaces and to a real AccountsDO on node:sqlite
// (the same SQL it runs on its SQLite storage). Nothing in the Worker calls this code yet.
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

const E = await import('../src/env.ts');
const API = await import('../src/nodeApi.ts');
const O = await import('../src/nodeOutcome.ts');
const S = await import('../src/accountStore.ts');
const ADO = await import('../src/AccountsDO.ts');
const { INTERNAL_HEADER, internalSecret } = await import('../src/auth.ts');
const { PROTOCOL_VERSION } = await import('../../src/net/protocol.ts');
const { ROCKETSIM_WASM_SHA256 } = await import('../../src/sim/wasm/rocketsim.sha256.ts');

const SECRET = 'nodes-test-secret';
const RealResponse = globalThis.Response;
const NOW = 1_800_000_000_000;
const A = 'a1b2c3d4e5f60718';
const B = '0123456789abcdef';
const C = 'fedcba9876543210';

// ---- env.ts: flags and nodes config --------------------------------------------------------------

/** A FLAGS namespace holding `values` (an Error value makes its read throw); `reads` records each get(). */
function kv(values) {
  const reads = [];
  return {
    reads,
    FLAGS: {
      async get(name, opts) {
        reads.push({ name, opts });
        const v = values[name];
        if (v instanceof Error) throw v;
        return v ?? null;
      },
    },
  };
}

test('flag: 1, true and on turn a flag on; any other value, a missing key or a KV failure is off', async () => {
  for (const v of ['1', 'true', 'on']) assert.equal(await E.flag(kv({ f: v }), 'f'), true, v);
  for (const v of ['0', 'false', 'off', 'yes', '']) assert.equal(await E.flag(kv({ f: v }), 'f'), false, JSON.stringify(v));
  assert.equal(await E.flag(kv({}), 'f'), false);
  assert.equal(await E.flag(kv({ f: new Error('kv down') }), 'f'), false);
});

test('nodesMode: nodes_on absent or 0 is off, 1 is all, a list of account ids is a canary', async () => {
  assert.equal(await E.nodesMode(kv({})), 'off');
  assert.equal(await E.nodesMode(kv({ nodes_on: '0' })), 'off');
  assert.equal(await E.nodesMode(kv({ nodes_on: '1' })), 'all');
  assert.equal(await E.nodesMode(kv({ nodes_on: ' 1\n' })), 'all', 'blanks around the value do not matter');
  assert.deepEqual(await E.nodesMode(kv({ nodes_on: A })), new Set([A]));
  assert.deepEqual(await E.nodesMode(kv({ nodes_on: ` ${A}, ${B} ,${A},` })), new Set([A, B]));
  const flags = kv({ nodes_on: '1' });
  await E.nodesMode(flags);
  assert.deepEqual(flags.reads.map((r) => [r.name, r.opts.cacheTtl]).sort(), [['nodes_on', 60], ['vm_disabled', 60]]);
});

test('nodesMode fails closed: anything but 1 or a list holding an account id is off', async () => {
  const bad = ['', ' ', ',', 'true', 'on', 'yes', 'all', '2', A.toUpperCase(), A.slice(1), A + '0', `${A};${B}`];
  for (const v of bad) assert.equal(await E.nodesMode(kv({ nodes_on: v })), 'off', JSON.stringify(v));
  assert.deepEqual(await E.nodesMode(kv({ nodes_on: `${A},nope,${B.toUpperCase()},${C}` })), new Set([A, C]), 'a malformed entry is dropped, the valid ones stay');
  assert.equal(await E.nodesMode(kv({ nodes_on: new Error('kv down') })), 'off');
});

test('nodesMode: vm_disabled turns the nodes off whatever nodes_on says', async () => {
  for (const on of ['1', `${A},${B}`]) {
    for (const v of ['1', 'true', 'on']) assert.equal(await E.nodesMode(kv({ nodes_on: on, vm_disabled: v })), 'off', `${on} / ${v}`);
  }
  assert.equal(await E.nodesMode(kv({ nodes_on: '1', vm_disabled: '0' })), 'all');
});

test('nodesAllowed: everybody, nobody, or a canary that must hold every human of the match', () => {
  assert.equal(E.nodesAllowed('all', [A, C]), true);
  assert.equal(E.nodesAllowed('off', [A]), false);
  const canary = new Set([A, B]);
  assert.equal(E.nodesAllowed(canary, [A]), true);
  assert.equal(E.nodesAllowed(canary, [B, A]), true);
  assert.equal(E.nodesAllowed(canary, [A, C]), false, 'one player outside the canary keeps the match off the nodes');
  assert.equal(E.nodesAllowed(canary, []), false);
});

test('trustedOperatorIds: the account ids in NODE_TRUSTED_OPERATORS; an entry that is not one trusts nobody', () => {
  assert.deepEqual(E.trustedOperatorIds({}), new Set());
  assert.deepEqual(E.trustedOperatorIds({ NODE_TRUSTED_OPERATORS: '' }), new Set());
  assert.deepEqual(E.trustedOperatorIds({ NODE_TRUSTED_OPERATORS: ` ${A} ,${B},${A}\n` }), new Set([A, B]));
  assert.deepEqual(E.trustedOperatorIds({ NODE_TRUSTED_OPERATORS: `${A.toUpperCase()},${A}0,${A.slice(1)},Proyecto,*,${C}` }), new Set([C]));
});

test('nodesConfigured: the NodeRegistryDO, both buckets, both halves of the control key and the public origin', () => {
  const full = { NODES: {}, NODE_REPLAYS: {}, NODE_RELEASES: {}, NODE_CONTROL_PRIVATE_KEY: 'priv', NODE_CONTROL_PUBLIC_KEY: 'pub', NODES_PUBLIC_BASE: 'https://turbo-gol.com' };
  assert.equal(E.nodesConfigured(full), true);
  for (const k of Object.keys(full)) {
    const rest = { ...full };
    delete rest[k];
    assert.equal(E.nodesConfigured(rest), false, 'without ' + k);
  }
  assert.equal(E.nodesConfigured({ ...full, NODE_CONTROL_PRIVATE_KEY: '' }), false, 'an empty secret is no key');
  assert.equal(E.nodesConfigured({}), false, 'a fork or a test env without any of them');
});

// ---- env.ts: the body cap and the per-address limit key ------------------------------------------

test('limitKey: an IPv4 address as it is, an IPv6 one by its /64 however it is written', () => {
  for (const ip of ['203.0.113.5', 'local', 'unknown', '::ffff:192.0.2.1']) assert.equal(E.limitKey(ip), ip);
  const cases = [
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:DB8:0001:0002:aaaa::', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:db8::1:2:3:4', '2001:db8:0:0::/64'],
    ['2001:db8::5:0:0:0:1', '2001:db8:0:5::/64'],
    ['2001:db8::', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
  ];
  for (const [ip, key] of cases) assert.equal(E.limitKey(ip), key, ip);
});

/** A request whose body is `chunks`, streamed (no Content-Length); `pulls` counts the chunks read. */
function streamed(chunks, headers = {}) {
  const s = { pulls: 0 };
  const body = new ReadableStream(
    {
      pull(c) {
        if (s.pulls >= chunks.length) return c.close();
        c.enqueue(new TextEncoder().encode(chunks[s.pulls++]));
      },
    },
    { highWaterMark: 0 },
  );
  s.request = new Request('https://x/', { method: 'POST', duplex: 'half', body, headers });
  return s;
}

test('readJson: at most 4 KB, read only that far, a declared Content-Length over it not read at all; empty is {}, bad JSON null', async () => {
  const ok = streamed(['{"name":', '"Señor"}']);
  assert.deepEqual(await E.readJson(ok.request), { name: 'Señor' });
  const big = streamed(['{"pad":"', ...Array.from({ length: 64 }, () => 'x'.repeat(1024)), '"}']);
  assert.equal(await E.readJson(big.request), null);
  assert.ok(big.pulls <= 6, `stopped at the cap: ${big.pulls} chunks of 66`);
  const declared = streamed(['{}'], { 'content-length': '5000' });
  assert.equal(await E.readJson(declared.request), null);
  assert.equal(declared.pulls, 0);
  assert.deepEqual(await E.readJson(new Request('https://x/', { method: 'POST' })), {});
  assert.equal(await E.readJson(new Request('https://x/', { method: 'POST', body: '{nope' })), null);
  const edge = '{"a":"' + 'x'.repeat(E.JSON_MAX_BYTES - 8) + '"}';
  assert.equal(edge.length, E.JSON_MAX_BYTES);
  assert.equal((await E.readJson(new Request('https://x/', { method: 'POST', body: edge }))).a.length, E.JSON_MAX_BYTES - 8, 'exactly 4 KB is read');
});

// ---- nodeApi.ts ------------------------------------------------------------------------------------

test('nodesStub: the one NodeRegistryDO, nodes-v1, created near São Paulo', () => {
  const seen = [];
  const NODES = { idFromName: (name) => ({ name }), get: (id, opts) => (seen.push({ id, opts }), { stub: true }) };
  assert.deepEqual(API.nodesStub({ NODES }), { stub: true });
  assert.deepEqual(seen, [{ id: { name: 'nodes-v1' }, opts: { locationHint: 'sam' } }]);
});

test('CLIENT_BUILD: the protocol and the committed wasm hash of the web client', () => {
  assert.deepEqual(API.CLIENT_BUILD, { version: E.SERVER_VERSION, protocol: PROTOCOL_VERSION, wasmSha256: ROCKETSIM_WASM_SHA256 });
  assert.match(API.CLIENT_BUILD.wasmSha256, /^[0-9a-f]{64}$/);
});

test('internal contract: refusals answer 404, 410 or 503; a node lock holds while its match is played or reported and the player stays', () => {
  assert.deepEqual(API.NODE_ROUTES, { place: '/internal/place', rejoin: '/internal/rejoin', leave: '/internal/leave', status: '/internal/status', health: '/internal/health' });
  assert.deepEqual(API.REJOIN_STATUS, { no_match: 404, not_in_match: 404, left: 410, match_over: 410, offline: 503 });
  assert.deepEqual(API.LEAVE_STATUS, { no_match: 404, not_in_match: 404, match_over: 410, offline: 503 });
  for (const state of ['assigned', 'reporting']) {
    assert.equal(API.nodeLockHeld({ state, left: false }), true, state);
    assert.equal(API.nodeLockHeld({ state, left: true }), false, state + ', left');
  }
  for (const state of ['verifying', 'done']) assert.equal(API.nodeLockHeld({ state, left: false }), false, state);
});

// ---- nodeOutcome.ts: the calls -------------------------------------------------------------------

const MID = 'ab'.repeat(32);
const IDS = [A, B, C];

/** A 2v2 assignment of IDS (A and B blue, C and a bot red). */
function assign(over = {}) {
  const ids = over.ids ?? IDS;
  const roster = [
    { slot: 0, team: 0, kind: 'player', name: 'ana', playerId: ids[0] },
    { slot: 1, team: 0, kind: 'player', name: 'beto', playerId: ids[1] },
    { slot: 2, team: 1, kind: 'player', name: 'caro', playerId: ids[2] },
    ids[3] ? { slot: 3, team: 1, kind: 'player', name: 'dani', playerId: ids[3] } : { slot: 3, team: 1, kind: 'bot', name: 'Bot 2' },
  ];
  const { ids: _, ...rest } = over;
  return { matchId: MID, mode: '2v2', region: 'SA', ranked: true, roster, matchLengthSeconds: 180, kickoffSeed: 7, botDifficulty: 'medium', createdAt: NOW, ...rest };
}

const RATED = {
  kind: 'rated',
  matchId: MID,
  playlist: '2v2',
  region: 'SA',
  winner: 1,
  blue: 2,
  red: 3,
  players: [
    { id: A, team: 0, left: false },
    { id: B, team: 0, left: true },
    { id: C, team: 1, left: false },
  ],
  nodeId: 'n1',
};
const REASON = 'verification_failed:' + 'x'.repeat(40);
const RANKED_VOID = { kind: 'void', matchId: MID, nodeId: 'n1', ranked: true, reason: REASON, players: IDS, noShows: [C] };

const parsed = (calls) => calls.map((c) => ({ ...c, body: JSON.parse(c.body) }));
const release = (region = 'SA') => ({ matchId: MID, target: 'mm:' + region, path: '/release', body: { matchId: MID, playerIds: IDS } });

test("outcomeCalls: a rated match goes to /ranked-result with MatchDO's body, then frees the locks in its region", () => {
  const { nodeId: _, kind: __, ...body } = RATED;
  assert.deepEqual(parsed(O.outcomeCalls(RATED, assign(), IDS)), [{ matchId: MID, target: 'accounts', path: '/ranked-result', body }, release()]);
});

test("outcomeCalls: a ranked void goes to /ranked-cancel with the assignment's playlist and region, its noShows and a reason AccountsDO keeps whole", () => {
  const calls = parsed(O.outcomeCalls(RANKED_VOID, assign({ mode: '3v3', region: 'NA' }), IDS));
  assert.deepEqual(calls, [
    { matchId: MID, target: 'accounts', path: '/ranked-cancel', body: { matchId: MID, playlist: '3v3', region: 'NA', players: IDS, noShows: [C], reason: REASON.slice(0, 32) } },
    release('NA'),
  ]);
  assert.equal(calls[0].body.reason.length, 32);
});

test('outcomeCalls: a casual match records nothing, void or not; it only frees the locks', () => {
  const casual = assign({ ranked: false });
  const outcomes = [
    { kind: 'void', matchId: MID, nodeId: 'n1', ranked: false, reason: 'node_offline', players: IDS, noShows: [A] },
    { kind: 'unrated', matchId: MID, nodeId: 'n1', blue: 1, red: 0, verified: true },
    { kind: 'unrated', matchId: MID, nodeId: 'n1', blue: 0, red: 4, verified: false },
  ];
  for (const o of outcomes) assert.deepEqual(parsed(O.outcomeCalls(o, casual, IDS)), [release()], `${o.kind} ${o.verified ?? ''}`);
});

test('outcomeCalls: every outcome ends with exactly one /release of every human', () => {
  for (const o of [RATED, RANKED_VOID, { ...RANKED_VOID, ranked: false }, { kind: 'unrated', matchId: MID, nodeId: 'n1', blue: 0, red: 0, verified: true }]) {
    const calls = parsed(O.outcomeCalls(o, assign(), IDS));
    assert.deepEqual(calls.filter((c) => c.path === '/release'), [release()]);
    assert.equal(calls[calls.length - 1].path, '/release');
  }
});

// ---- nodeOutcome.ts: delivery --------------------------------------------------------------------

/** ACCOUNTS and MATCHMAKER whose objects answer `answer(name, path)`: a Response, or an Error to throw. `calls` records each POST. */
function deliveryEnv(answer) {
  const calls = [];
  const ns = () => ({
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (url, init) => {
        calls.push({ name: id.name, url, method: init.method, headers: init.headers, body: init.body });
        const r = answer(id.name, new URL(url).pathname);
        if (r instanceof Error) throw r;
        return r;
      },
    }),
  });
  return { calls, env: { JWT_SECRET: SECRET, ACCOUNTS: ns(), MATCHMAKER: ns() } };
}

const ok = () => new RealResponse('{"ok":true}', { status: 200 });

test('deliverCall: a 2xx is done; each call reaches its object with the internal header and the stored body', async () => {
  const { calls, env } = deliveryEnv(ok);
  const lines = [];
  const [result, rel] = O.outcomeCalls(RATED, assign(), IDS);
  assert.equal(await O.deliverCall(env, result, (l) => lines.push(l)), 'done');
  assert.equal(await O.deliverCall(env, rel, (l) => lines.push(l)), 'done');
  const secret = await internalSecret(SECRET);
  assert.deepEqual(
    calls.map((c) => [c.name, c.url, c.method, c.headers[INTERNAL_HEADER] === secret, c.headers['content-type'], c.body]),
    [
      ['accounts-v1', 'https://accounts/ranked-result', 'POST', true, 'application/json', result.body],
      ['mm:SA', 'https://matchmaker/release', 'POST', true, 'application/json', rel.body],
    ],
  );
  assert.deepEqual(lines, []);
});

test('deliverCall: an answer below 500 that is not a 2xx is done too, with one ALERT line that carries the body', async () => {
  const [result] = O.outcomeCalls(RATED, assign(), IDS);
  for (const status of [400, 403, 404, 409]) {
    const { env } = deliveryEnv(() => new RealResponse('{"error":"bad_request"}\n', { status }));
    const lines = [];
    assert.equal(await O.deliverCall(env, result, (l) => lines.push(l)), 'done', `${status}: a retry would be refused forever`);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith(`ALERT outbox /ranked-result ${status} (match abababab, accounts)`), lines[0]);
    assert.ok(lines[0].includes('"error":"bad_request"') && lines[0].includes(result.body), 'the answer and the body, to apply by hand');
    assert.doesNotMatch(lines[0], /[\r\n]/);
  }
});

test('deliverCall: a 5xx or a network error is retried, without an ALERT', async () => {
  const [, rel] = O.outcomeCalls(RATED, assign(), IDS);
  const answers = [() => new RealResponse('boom', { status: 500 }), () => new RealResponse('', { status: 503 }), () => new Error('Network connection lost.\nnext line')];
  for (const answer of answers) {
    const { calls, env } = deliveryEnv(answer);
    const lines = [];
    assert.equal(await O.deliverCall(env, rel, (l) => lines.push(l)), 'retry');
    assert.equal(calls.length, 1);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith('outbox /release '), lines[0]);
    assert.doesNotMatch(lines[0], /[\r\n]/);
  }
});

test('deliverCall: a target that does not answer within the timeout is retried, and a late answer is let go unread', async () => {
  const [, rel] = O.outcomeCalls(RATED, assign(), IDS);
  assert.equal(O.DELIVERY_TIMEOUT_MS, 10_000);
  const never = deliveryEnv(() => new Promise(() => {}));
  const lines = [];
  assert.equal(await O.deliverCall(never.env, rel, (l) => lines.push(l), 20), 'retry');
  assert.deepEqual(lines, ['outbox /release failed (match abababab, mm:SA), to retry: Error: no answer in 0.02 s']);
  let cancelled = false;
  const body = new ReadableStream({ cancel: () => void (cancelled = true) });
  const late = deliveryEnv(() => new Promise((r) => setTimeout(() => r(new RealResponse(body)), 40)));
  assert.equal(await O.deliverCall(late.env, rel, () => undefined, 10), 'retry');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(cancelled, true, 'its body cancelled');
});

test('deliverCall: a row for no known object sends nothing and is dropped with an ALERT', async () => {
  const { calls, env } = deliveryEnv(ok);
  const lines = [];
  const row = { matchId: MID, target: 'match', path: '/release', body: '{}' };
  assert.equal(await O.deliverCall(env, row, (l) => lines.push(l)), 'done');
  assert.equal(calls.length, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^ALERT outbox \/release - \(match abababab, match\), dropped: unknown target/);
});

// ---- nodeOutcome.ts against a real AccountsDO ----------------------------------------------------

const H = (c) => c.repeat(64).slice(0, 64);
const PW = { hash: H('a'), salt: H('b').slice(0, 32), iter: 100000 };

/** An AccountsDO on node:sqlite, its store, and an ACCOUNTS namespace that reaches it. */
function makeAccounts() {
  const db = new DatabaseSync(':memory:');
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
  const ctx = { storage: { sql, transactionSync, getAlarm: async () => NOW, setAlarm: async () => {} }, blockConcurrencyWhile: (fn) => fn() };
  const ado = new ADO.AccountsDO(ctx, { JWT_SECRET: SECRET });
  ado.now = () => NOW;
  const ACCOUNTS = { idFromName: (name) => ({ name }), get: () => ({ fetch: (url, init) => ado.fetch(new Request(url, init)) }) };
  return { store: new S.AccountStore(sql, transactionSync), ACCOUNTS };
}

test('outcome calls reach a real AccountsDO: a rated match is rated once, a ranked void abandons its no-shows, a second delivery is done and changes nothing', async () => {
  const { store, ACCOUNTS } = makeAccounts();
  const ids = ['ana', 'beto', 'caro', 'dani'].map((n, i) => store.register(n, PW, [], H(String(i)), NOW).userId);
  const releases = [];
  const MATCHMAKER = { idFromName: (name) => ({ name }), get: (id) => ({ fetch: async (_url, init) => (releases.push([id.name, JSON.parse(init.body)]), ok()) }) };
  const env = { JWT_SECRET: SECRET, ACCOUNTS, MATCHMAKER };
  const deliver = async (calls) => {
    for (const c of calls) assert.equal(await O.deliverCall(env, c, (l) => assert.fail(l)), 'done');
  };

  store.rankedLock(MID, 'SA', ids, NOW + 600_000);
  const rated = { ...RATED, winner: 0, players: ids.map((id, i) => ({ id, team: i < 2 ? 0 : 1, left: i === 3 })) };
  const calls = O.outcomeCalls(rated, assign({ ids }), ids);
  await deliver(calls);
  await deliver(calls); // at least once: the outbox may send a row again
  assert.equal(store.rankedResultFor(MID, ids[0], NOW).outcome, 'win');
  assert.equal(store.rankedResultFor(MID, ids[3], NOW).left, true);
  assert.equal(store.rankedCheck(ids[0], ['2v2'], NOW).ratings['2v2'].games, 1, 'rated once');
  assert.equal(store.rankedCheck(ids[0], ['2v2'], NOW).active, null, 'the ranked lock is gone');

  const MID2 = 'cd'.repeat(32);
  const voided = O.outcomeCalls({ ...RANKED_VOID, matchId: MID2, players: ids, noShows: [ids[2]] }, assign({ ids, matchId: MID2 }), ids);
  await deliver(voided);
  await deliver(voided);
  assert.deepEqual(store.rankedResultFor(MID2, ids[0], NOW), { status: 'cancelled', reason: REASON.slice(0, 32) });
  assert.ok(store.banUntil(ids[2], NOW) > NOW, 'the no-show got an abandon');
  assert.equal(store.banUntil(ids[1], NOW), 0, 'the others did not');
  assert.equal(store.rankedCheck(ids[1], ['2v2'], NOW).ratings['2v2'].games, 1, 'nobody rated by the void');

  assert.deepEqual(releases, [
    ['mm:SA', { matchId: MID, playerIds: ids }],
    ['mm:SA', { matchId: MID, playerIds: ids }],
    ['mm:SA', { matchId: MID2, playerIds: ids }],
    ['mm:SA', { matchId: MID2, playerIds: ids }],
  ]);
});

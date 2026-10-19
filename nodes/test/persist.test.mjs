// Persistence: the rows of persist.ts and the Registry's write-through and restore (what survives a
// Worker deploy or a Durable Object restart).
import '../dev/ts-resolve.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { STATE_VERSION, MemoryStore, nodeToRow, nodeFromRow, tokenToRow, tokenFromRow, matchToRow, matchFromRow } = await import('../control-plane/persist.ts');
const { Registry, MAX_STRIKES, STRIKE_COOLDOWN_MS, TOKEN_TTL_MS } = await import('../control-plane/registry.ts');
const { generateEd25519 } = await import('../shared/edcrypto.ts');

const BUILD = { version: '0.1.0', protocol: 1, wasmSha256: 'a'.repeat(64) };
const SPECS = { cpus: 2, cpuModel: 'x', memMB: 4096, arch: 'x64', os: 'linux', node: '24' };
const CAP = { matches: 4, cpuMsPerMatchSecond: 1, memMBPerMatch: 20, uplinkMbps: null, source: 'declared' };
const HEARTBEAT_RESET = { online: false, lastSeen: 0, active: 0, draining: false, tickLagP99Ms: 0, egressGB: 0, cpuLoad: 0 };
const OP = { id: 'op1', name: 'Juan' };
const PROJECT = { id: 'proj', name: 'Proyecto' };
const quiet = () => undefined;

const hello = (patch = {}) => ({ bootId: 'boot-1', build: BUILD, roles: ['host'], transports: ['wss'], publicUrl: 'wss://203.0.113.7', rtcReady: false, specs: SPECS, capacity: CAP, draining: false, egressCapGB: null, ...patch });
const beat = (patch = {}) => ({ active: 1, capacity: 4, draining: false, egressGB: 0.5, egressCapGB: null, tickLagP99Ms: 2, cpuLoad: 0.3, rssMB: 80, matches: [], ...patch });

/** A registry writing through `store`, as the DO builds it at every start. */
function boot(store, opts = {}) {
  const reg = new Registry({ allowInsecure: true, store, log: quiet, ...opts });
  reg.restore(store.rows());
  return reg;
}

/** A MemoryStore behind a store that counts the calls. */
function counted() {
  const mem = new MemoryStore();
  const calls = { node: 0, register: 0, tokens: 0, dropTokens: 0 };
  const store = {
    node: (n) => (calls.node++, mem.node(n)),
    register: (t, n) => (calls.register++, mem.register(t, n)),
    tokens: (t) => (calls.tokens++, mem.tokens(t)),
    dropTokens: (h) => (calls.dropTokens++, mem.dropTokens(h)),
    rows: () => mem.rows(),
  };
  return { mem, store, calls };
}

async function register(reg, token, now, extra = {}) {
  const keys = await generateEd25519();
  return reg.register({ token, publicKey: keys.publicKey, roles: ['host'], publicUrl: 'wss://203.0.113.7', build: BUILD, specs: SPECS, capacity: CAP, ...extra }, now);
}

async function regNode(reg, op, now, extra = {}) {
  const { token } = await reg.createToken(op, 'SA', now);
  const r = await register(reg, token, now, extra);
  assert.ok(r.ok, JSON.stringify(r));
  return r.node;
}

/** The node as a restart brings it back: heartbeat fields reset. */
const durable = (n) => ({ ...n, ...HEARTBEAT_RESET });

const A = 'a'.repeat(16);
const B = 'b'.repeat(16);

const tokenRecord = (patch = {}) => ({ hash: 'd'.repeat(64), operatorId: OP.id, operatorName: OP.name, region: 'SA', name: 'casa', createdAt: 5_000, expiresAt: 5_000 + TOKEN_TTL_MS, usedBy: null, ...patch });

function matchEntry(patch = {}) {
  const matchId = 'f'.repeat(64);
  const nodeId = 'e'.repeat(16);
  return {
    assign: {
      matchId,
      mode: '1v1',
      region: 'SA',
      ranked: true,
      roster: [
        { slot: 0, team: 0, kind: 'player', name: 'A', playerId: A },
        { slot: 1, team: 1, kind: 'player', name: 'B', playerId: B },
      ],
      matchLengthSeconds: 180,
      kickoffSeed: 12345,
      botDifficulty: 'medium',
      createdAt: 1_000,
      joinTimeoutMs: 45_000,
    },
    nodeId,
    transport: 'wss',
    humans: [
      { playerId: A, name: 'A', account: true, accountAgeDays: 30 },
      { playerId: B, name: 'B' },
    ],
    build: BUILD,
    bootId: 'boot-1',
    state: 'done',
    leaves: new Set([B]),
    leaveAt: new Map([[B, 61_000]]),
    neverJoined: new Set([B]),
    startedSeen: true,
    left: new Set([B]),
    offered: new Set([A, B]),
    replaySha: 'c'.repeat(64),
    regionFactor: 1.25,
    verifyRate: 1,
    report: {
      kind: 'ended',
      matchId,
      result: { winner: 0, blue: 2, red: 1, endTick: 7300, endReason: 'forfeit', forfeitTeam: 1 },
      replaySha256: 'c'.repeat(64),
      replayBytes: 200_000,
      stats: { ticks: 7300, durationMs: 61_000, slots: [{ slot: 0, received: 7000, dropped: 1, underruns: 2, overruns: 0, connectedMs: 61_000 }], tickLagP99Ms: 1, egressBytes: 9_000_000 },
    },
    reportedAt: 63_000,
    verdict: { ok: true, code: 'ok', ticks: 7300, score: { blue: 2, red: 1 }, winner: 0, finalHash: 987654, cpuMs: 800, endReason: 'forfeit', forfeitTeam: 1, presentTicks: [7300, 7000], leftSlots: [1], leftTicks: [7290], goneTicks: [-1, 7290] },
    verifiedBy: 'v'.repeat(16),
    outcome: { kind: 'rated', matchId, playlist: '1v1', region: 'SA', winner: 0, blue: 2, red: 1, players: [{ id: A, team: 0, left: false }, { id: B, team: 1, left: true }], nodeId },
    ledger: null,
    deadline: 1_200_000,
    queuedAt: 63_100,
    lastTry: 63_200,
    inFlight: true,
    doneAt: 64_000,
    ...patch,
  };
}

// ---- persist.ts -------------------------------------------------------------------------------

test('a node row keeps every durable field and drops the heartbeat ones', async () => {
  const reg = new Registry({ allowInsecure: true });
  const n = await regNode(reg, OP, 1_000);
  reg.connected(n.nodeId, hello({ egressCapGB: 900 }), 2_000);
  reg.markReachable(n.nodeId, 2_100);
  reg.heartbeat(n.nodeId, beat({ egressCapGB: 900 }), 3_000);
  reg.onLost(n.nodeId, 'crash', 3_500);
  assert.equal(n.online, true);

  const row = nodeToRow(n);
  assert.deepEqual([row.nodeId, row.operatorId, row.publicKey], [n.nodeId, OP.id, n.publicKey]);
  assert.equal(typeof row.data, 'string', 'one JSON column');
  const data = JSON.parse(row.data);
  assert.equal(data.v, STATE_VERSION);
  for (const k of Object.keys(HEARTBEAT_RESET)) assert.ok(!(k in data), `${k} is not written`);

  const back = nodeFromRow(row, new Set());
  assert.deepEqual(back, durable(n));
  assert.equal(back.status, 'probation');
  assert.equal(back.bootId, 'boot-1');
  assert.equal(back.egressCapGB, 900);
  assert.deepEqual(back.strikeTimes, [3_500]);
  assert.equal(nodeFromRow(row, new Set([OP.id])).trusted, true, 'trust comes from the operators of this load, not from the row');

  // Rows without the fields added later load with the registry's own defaults.
  const { capacityMax, pauseTimes, ...older } = JSON.parse(row.data);
  delete older.counters.probationVerified;
  const old = nodeFromRow({ ...row, data: JSON.stringify(older) }, new Set());
  assert.equal(old.capacityMax, CAP.matches);
  assert.deepEqual(old.pauseTimes, []);
  assert.equal(old.counters.probationVerified, 0);
});

test('a token row round-trips', () => {
  const t = tokenRecord();
  const row = tokenToRow(t);
  assert.deepEqual([row.hash, row.expiresAt], [t.hash, 5_000 + TOKEN_TTL_MS]);
  assert.deepEqual(tokenFromRow(row), t);
  const used = tokenRecord({ usedBy: 'n'.repeat(16) });
  assert.deepEqual(tokenFromRow(tokenToRow(used)), used);
});

test('a match row keeps the leaves, the report, the verdict and the outcome; the dispatch in flight is dropped', () => {
  const m = matchEntry();
  const row = matchToRow(m);
  assert.deepEqual([row.matchId, row.nodeId, row.state, row.doneAt], [m.assign.matchId, m.nodeId, 'done', 64_000]);
  const data = JSON.parse(row.data);
  assert.deepEqual(data.leaveAt, [[B, 61_000]], 'leaveAt as [playerId, ms] pairs');
  assert.deepEqual(data.offered, [A, B]);
  for (const k of ['inFlight', 'lastTry', 'verifiedBy']) assert.ok(!(k in data), `${k} is not written`);

  const back = matchFromRow(row);
  assert.deepEqual(back, { ...m, inFlight: false, lastTry: 0, verifiedBy: null });
  assert.ok(back.leaves instanceof Set && back.leaveAt instanceof Map && back.neverJoined instanceof Set && back.left instanceof Set && back.offered instanceof Set);

  const casual = matchEntry({ state: 'verifying', doneAt: 0, outcome: null, verdict: null, ledger: { matchId: m.assign.matchId, points: 3.5, regionFactor: 1.25, quality: 1, repeat: 1, playerMinutes: 2, weightedMinutes: 2.8, players: [] } });
  assert.deepEqual(matchFromRow(matchToRow(casual)), { ...casual, inFlight: false, lastTry: 0, verifiedBy: null });
});

test('a match caught reporting loads as assigned, without the report', () => {
  const m = matchEntry({ state: 'reporting', verdict: null, outcome: null, doneAt: 0, queuedAt: 0 });
  const back = matchFromRow(matchToRow(m));
  assert.equal(back.state, 'assigned', 'the node sends the report again at its next welcome');
  assert.equal(back.report, null);
  assert.equal(back.reportedAt, 0);
  assert.deepEqual(back.leaveAt, m.leaveAt, 'what the control plane recorded itself stays');
  assert.equal(back.replaySha, m.replaySha);
  assert.equal(back.startedSeen, true);
});

test('a row of an unknown state version is refused', async () => {
  const n = await regNode(new Registry(), OP, 0);
  const t = tokenRecord();
  const bump = (row) => ({ ...row, data: JSON.stringify({ ...JSON.parse(row.data), v: STATE_VERSION + 1 }) });
  const unversioned = (row) => {
    const { v, ...d } = JSON.parse(row.data);
    return { ...row, data: JSON.stringify(d) };
  };
  for (const change of [bump, unversioned]) {
    assert.throws(() => nodeFromRow(change(nodeToRow(n)), new Set()), /state version/);
    assert.throws(() => tokenFromRow(change(tokenToRow(t))), /state version/);
    assert.throws(() => matchFromRow(change(matchToRow(matchEntry()))), /state version/);
  }
  const store = new MemoryStore();
  store.node(n);
  store.nodeRows.set(n.nodeId, bump(store.nodeRows.get(n.nodeId)));
  assert.throws(() => boot(store), /state version/, 'a newer build’s rows stop the load');
});

test('the MemoryStore keeps, replaces and drops rows', async () => {
  const store = new MemoryStore();
  const n = await regNode(new Registry(), OP, 0);
  const t = tokenRecord();
  store.tokens([t, tokenRecord({ hash: '0'.repeat(64) })]);
  store.register({ ...t, usedBy: n.nodeId }, n);
  assert.equal(tokenFromRow(store.tokenRows.get(t.hash)).usedBy, n.nodeId, 'a registration spends the token');
  assert.deepEqual(nodeFromRow(store.nodeRows.get(n.nodeId), new Set()), durable(n));
  n.status = 'banned';
  store.node(n);
  assert.equal(store.rows().nodes.length, 1);
  assert.equal(nodeFromRow(store.rows().nodes[0], new Set()).status, 'banned');
  store.dropTokens([t.hash]);
  assert.deepEqual(store.rows().tokens.map((r) => r.hash), ['0'.repeat(64)]);

  const m = matchEntry({ state: 'assigned', outcome: null, doneAt: 0 });
  store.save(m);
  m.leaves.add(A);
  store.save(m);
  assert.equal(store.matchRows.size, 1);
  assert.deepEqual(matchFromRow(store.rows().matches[0]).leaves, new Set([A, B]));
  store.finished({ ...m, state: 'done', doneAt: 9 }, { kind: 'void' });
  assert.equal(store.matchRows.get(m.assign.matchId).state, 'done');
  store.drop(m.assign.matchId);
  assert.equal(store.matchRows.size, 0);
});

// ---- Registry write-through and restore ---------------------------------------------------------

test('heartbeats and disconnects never write; a hello writes once', async () => {
  const { store, calls } = counted();
  const reg = boot(store);
  const n = await regNode(reg, OP, 0);
  assert.deepEqual(calls, { node: 0, register: 1, tokens: 1, dropTokens: 0 });
  reg.connected(n.nodeId, hello(), 10);
  assert.equal(calls.node, 1, 'one write per hello');
  const before = calls.node;
  for (let i = 1; i <= 200; i++) reg.heartbeat(n.nodeId, beat({ active: i % 4, egressGB: i / 100 }), 10 + i * 5_000);
  reg.disconnected(n.nodeId);
  reg.sweep(10 + 201 * 5_000 + 60_000);
  assert.equal(calls.node, before, '200 heartbeats, a disconnect and an offline sweep: 0 writes');
  // An rtc host that proves itself in its hello: still one write.
  const home = await regNode(reg, OP, 0, { publicUrl: null });
  const w = calls.node;
  assert.equal(reg.connected(home.nodeId, hello({ transports: ['rtc'], publicUrl: null, rtcReady: true }), 20), 'probation');
  assert.equal(calls.node, w + 1);
});

test('every durable change is written through: a restart at any point brings the same node back', async () => {
  const store = new MemoryStore();
  const reg = boot(store);
  const n = await regNode(reg, OP, 0);
  const restarted = () => boot(store).node(n.nodeId);
  const steps = [
    () => reg.connected(n.nodeId, hello({ egressCapGB: 500, capacity: { ...CAP, matches: 6 } }), 1_000),
    () => reg.markReachable(n.nodeId, 1_100),
    () => reg.onAssigned(n.nodeId),
    () => reg.onVerified(n.nodeId, true, true),
    () => reg.onLost(n.nodeId, 'crash', 2_000),
    () => reg.setStatus(n.nodeId, 'active', 'by hand'),
    () => reg.onLost(n.nodeId, 'crash', 2_100),
    () => reg.onLost(n.nodeId, 'crash', 2_200),
    () => reg.onLost(n.nodeId, 'crash', 2_300),
    () => reg.sweep(2_300 + STRIKE_COOLDOWN_MS),
    () => reg.onVerified(n.nodeId, false, false),
  ];
  for (const [i, step] of steps.entries()) {
    step();
    assert.deepEqual(restarted(), durable(n), `after step ${i}`);
  }
  assert.equal(n.status, 'suspended');
  assert.equal(n.statusReason, 'verification_failed');
  assert.equal(n.counters.lost, 4);
  assert.equal(n.capacityMax, 6);
  assert.equal(n.bootId, 'boot-1', 'the boot id survives: a new one after the restart still voids the old process’s matches');
  // Promoted after its 20 verified matches: the new status and the counters, in one write.
  const p = await regNode(reg, OP, 0);
  reg.markReachable(p.nodeId, 0);
  for (let i = 0; i < 20; i++) reg.onVerified(p.nodeId, false, true);
  assert.equal(p.status, 'active');
  assert.deepEqual(boot(store).node(p.nodeId), durable(p));
});

test('tokens survive a restart: unused ones still register, used ones are refused, expired ones are pruned', async () => {
  const store = new MemoryStore();
  let reg = boot(store);
  const used = (await reg.createToken(OP, 'SA', 0)).token;
  const spare = (await reg.createToken(OP, 'SA', 0)).token;
  assert.ok((await register(reg, used, 10)).ok);

  reg = boot(store); // a deploy between minting the token and running the installer
  assert.equal(reg.tokenList().length, 2);
  assert.equal((await register(reg, used, 20)).code, 'bad_token', 'still spent');
  const r = await register(reg, spare, 30);
  assert.ok(r.ok, 'the other one still works');

  reg = boot(store);
  assert.equal(reg.node(r.node.nodeId).name, r.node.name);
  assert.equal((await register(reg, spare, 40)).code, 'bad_token');
  const late = (await reg.createToken(OP, 'SA', 1_000)).token;
  // A token minted two TTLs after the first ones prunes them, in the store too.
  const fresh = (await reg.createToken(OP, 'SA', 2 * TOKEN_TTL_MS + 1)).token;
  assert.equal(store.tokenRows.size, 2);
  reg = boot(store);
  assert.equal(reg.tokenList().length, 2);
  assert.equal((await register(reg, late, 2 * TOKEN_TTL_MS)).code, 'token_expired', 'expired but not pruned yet');
  assert.ok((await register(reg, fresh, 2 * TOKEN_TTL_MS)).ok);
});

test('concurrent registrations with one token: exactly one gets a node', async () => {
  const { mem, store, calls } = counted();
  const reg = boot(store);
  const { token } = await reg.createToken(OP, 'SA', 0);
  const keys = await Promise.all([1, 2, 3].map(() => generateEd25519()));
  const req = (k) => ({ token, publicKey: k.publicKey, roles: ['host'], publicUrl: 'wss://203.0.113.7', build: BUILD, specs: SPECS, capacity: CAP });
  // Hold every public-key check until all three have passed the token check: the interleaving the
  // awaits in register() allow, which Node's own timing seldom produces.
  const subtle = globalThis.crypto.subtle;
  const importKey = Object.getPrototypeOf(subtle).importKey;
  const held = [];
  subtle.importKey = (...args) => new Promise((resolve) => held.push(() => resolve(importKey.apply(subtle, args))));
  let results;
  try {
    const all = Promise.all(keys.map((k) => reg.register(req(k), 1)));
    for (let i = 0; i < 400 && held.length < keys.length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(held.length, keys.length, 'all three got past the token check');
    for (const go of held) go();
    results = await all;
  } finally {
    delete subtle.importKey;
  }
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results.map((r) => r.code ?? 'ok')));
  assert.deepEqual(
    results.filter((r) => !r.ok).map((r) => r.code),
    ['bad_token', 'bad_token'],
  );
  assert.equal(reg.list().length, 1);
  assert.equal(calls.register, 1);
  assert.equal(mem.nodeRows.size, 1);
  assert.equal(reg.tokenList()[0].usedBy, results.find((r) => r.ok).node.nodeId);
});

test('a strike pause survives a restart and the sweep lifts it at the same time', async () => {
  const store = new MemoryStore();
  let reg = boot(store);
  const n = await regNode(reg, OP, 0);
  reg.markReachable(n.nodeId, 0);
  reg.setStatus(n.nodeId, 'active', null);
  for (let i = 1; i <= MAX_STRIKES; i++) reg.onLost(n.nodeId, 'crash', i * 1_000);
  const until = MAX_STRIKES * 1_000 + STRIKE_COOLDOWN_MS;
  assert.equal(n.suspendedUntil, until);

  reg = boot(store);
  const back = reg.node(n.nodeId);
  assert.equal(back.status, 'suspended');
  assert.equal(back.suspendedUntil, until);
  assert.equal(back.statusBeforeSuspension, 'active');
  assert.deepEqual(reg.sweep(until - 1).restored, []);
  assert.deepEqual(reg.sweep(until).restored.map((x) => x.nodeId), [n.nodeId]);
  assert.equal(back.status, 'active');
  assert.equal(boot(store).node(n.nodeId).status, 'active', 'the lift is written too');
});

test('trust is recomputed at every load: an operator taken off the list loses it, one added gains it', async () => {
  const store = new MemoryStore();
  let reg = boot(store, { trustedOperators: [PROJECT.id] });
  const v = await regNode(reg, PROJECT, 0, { roles: ['host', 'verify'] });
  const c = await regNode(reg, OP, 0);
  assert.equal(v.trusted, true);
  reg.markReachable(v.nodeId, 0);
  assert.equal(v.status, 'active');

  reg = boot(store, { trustedOperators: [] });
  assert.equal(reg.node(v.nodeId).trusted, false, 'off the list: no longer trusted after the restart');
  assert.equal(reg.node(c.nodeId).trusted, false);

  reg = boot(store, { trustedOperators: [PROJECT.id, OP.id] });
  assert.equal(reg.node(v.nodeId).trusted, true);
  assert.equal(reg.node(c.nodeId).trusted, true);

  reg = boot(store);
  reg.addTrustedOperator(OP.id);
  assert.equal(reg.node(c.nodeId).trusted, true);
  assert.equal(JSON.parse(store.nodeRows.get(c.nodeId).data).trusted, true, 'the row says what memory says');
});

test('ALERT lines: every token and every registration of a trusted operator', async () => {
  const lines = [];
  const reg = new Registry({ allowInsecure: true, trustedOperators: [PROJECT.id], log: (m) => lines.push(m) });
  const c = await regNode(reg, OP, 0);
  assert.deepEqual(lines, [], 'a community operator’s token and node raise nothing');
  const v = await regNode(reg, PROJECT, 0, { roles: ['host', 'verify'], publicUrl: 'wss://sp1.example.org' });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^ALERT registration token created for trusted operator Proyecto \(proj\), region SA$/);
  assert.match(lines[1], new RegExp(`^ALERT trusted node ${v.name} \\(${v.nodeId}\\) registered for Proyecto \\(proj\\), roles host\\+verify at wss://sp1\\.example\\.org$`));
  // An operator made trusted after minting the token: its registration still alerts.
  const { token } = await reg.createToken({ id: 'late', name: 'Tarde' }, 'SA', 0);
  reg.addTrustedOperator('late');
  assert.equal(lines.length, 2);
  assert.ok((await register(reg, token, 0)).ok);
  assert.match(lines[2], /^ALERT trusted node .* registered for Tarde \(late\)/);
  assert.equal(c.trusted, false);
});

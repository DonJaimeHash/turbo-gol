// Persistence: the rows of persist.ts, the Registry's and the ControlPlane's write-through and
// restore (what survives a Worker deploy or a Durable Object restart), and the restart grace.
import '../dev/ts-resolve.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { human, leaveAtEnd, setup, sleep, wait } from './fakeNode.mjs';

const { STATE_VERSION, MemoryStore, nodeToRow, nodeFromRow, tokenToRow, tokenFromRow, matchToRow, matchFromRow } = await import('../control-plane/persist.ts');
const { Registry, MAX_STRIKES, STRIKE_COOLDOWN_MS, TOKEN_TTL_MS } = await import('../control-plane/registry.ts');
const { LINK_TIMEOUT_MS, NODE_OFFLINE_MS, RESTART_GRACE_MS, VERIFY_MAX_WAIT_MS } = await import('../control-plane/controlPlane.ts');
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
    () => reg.markUnreachable(n.nodeId),
    () => reg.markReachable(n.nodeId, 1_150),
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

// ---- ControlPlane write-through, restore and the restart grace ----------------------------------

/** A MemoryStore whose match writes also land in `log` (shared with the messages the node gets). */
function logged(log) {
  const mem = new MemoryStore();
  return {
    mem,
    node: (n) => mem.node(n),
    register: (t, n) => mem.register(t, n),
    tokens: (t) => mem.tokens(t),
    dropTokens: (h) => mem.dropTokens(h),
    save: (m) => {
      log.push({ what: 'save', state: m.state, started: m.startedSeen, leaves: m.leaves.size, replay: m.replaySha !== null, offered: m.offered.size });
      mem.save(m);
    },
    finished: (m, o) => {
      log.push({ what: 'finished', matchId: m.assign.matchId, kind: o.kind });
      mem.finished(m, o);
    },
    drop: (id) => mem.drop(id),
    rows: () => mem.rows(),
  };
}

const lost = (matchId) => ({ t: 'report', id: 'lost:' + matchId, report: { kind: 'lost', matchId, reason: 'node_shutdown' } });

test('a deploy mid-match loses nothing: no void inside the grace, and the same node process gets its match rated with its leaver', async () => {
  const store = new MemoryStore();
  const env = await setup({ status: 'active', store });
  const p = await env.place([human('a'), human('b')], { ranked: true });
  await env.heartbeat({ active: 1, matches: [{ matchId: p.matchId, tick: 240, phase: 'play', sockets: 2 }] });
  env.advance(6_000);
  const leftAt = env.now();
  await env.cp.leave(p.matchId, B);
  const { report } = await env.upload(p, { play: { stopAt: 700, endReason: 'forfeit', forfeitTeam: 1 }, mutate: leaveAtEnd(1) });

  env.restart(); // the Worker is deployed before the node's report arrives
  const m = env.cp.matches.get(p.matchId);
  assert.equal(m.state, 'assigned');
  assert.equal(m.startedSeen, true);
  assert.deepEqual([...m.leaves], [B]);
  assert.equal(m.leaveAt.get(B), leftAt, 'without it the takeover would be a bad_takeover');
  assert.equal(m.replaySha, report.replaySha256, 'without it the report would be a no_replay strike');
  assert.equal(env.cp.unfinished(), 1);
  assert.equal(env.cp.inGrace(), true);
  assert.match(env.logs.at(-1), /^restored 1 matches \(1 unfinished\): 90 s for the nodes to reconnect$/);

  env.advance(20_000);
  env.cp.sweep();
  assert.equal(m.state, 'assigned', '20 s without the node, inside the grace: no void');
  await env.reconnect(); // the same bootId: the same process, its match is still running
  assert.equal(m.state, 'assigned');
  const entry = await env.report(report); // the node sends its unacked report at the welcome
  assert.equal(entry.verdict.code, 'ok', entry.verdict.message);
  assert.equal(entry.outcome.kind, 'rated', JSON.stringify(entry.outcome));
  assert.deepEqual(
    entry.outcome.players.map((x) => x.left),
    [false, true],
  );
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 0);
  assert.equal(store.matchRows.get(p.matchId).state, 'done');
});

test('a node that never comes back after a deploy: when the grace ends its matches are void, with one strike and one outcome each', async () => {
  const store = new MemoryStore();
  const env = await setup({ store });
  const ps = [await env.place([human('a')]), await env.place([human('b')])];
  env.restart();
  env.advance(RESTART_GRACE_MS - 1);
  env.cp.sweep();
  for (const p of ps) assert.equal(env.cp.matches.get(p.matchId).state, 'assigned');
  env.advance(1);
  assert.equal(env.cp.inGrace(), false);
  env.cp.sweep();
  env.cp.sweep();
  for (const p of ps) {
    assert.equal(env.cp.matches.get(p.matchId).outcome.reason, 'node_offline');
    assert.equal(env.outcomes.filter((o) => o.matchId === p.matchId).length, 1);
    assert.equal(store.matchRows.get(p.matchId).state, 'done');
  }
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 1, 'one outage, one strike');
});

test('a new node process after a deploy voids its old matches at its hello, grace or not', async () => {
  const env = await setup({ store: new MemoryStore() });
  const p = await env.place([human('a')]);
  env.restart();
  env.boot = 'boot-2';
  await env.reconnect();
  assert.equal(env.cp.inGrace(), true);
  assert.equal(env.cp.matches.get(p.matchId).outcome.reason, 'node_restarted');
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 1);
});

test('a match waiting for its verification survives a deploy and is rated after the verifier’s hello, keeping its place in the queue', async () => {
  // A project node verifies its own matches; until the deploy its verifier keeps failing.
  const env = await setup({ store: new MemoryStore(), trusted: true, roles: ['host', 'verify'], noInline: true });
  await wait(() => env.registry.node(env.nodeId).status === 'active');
  const verify = env.onVerify;
  env.onVerify = async () => ({ ok: false, code: 'error', message: 'busy', ticks: 0, score: { blue: 0, red: 0 }, winner: -1, finalHash: 0, cpuMs: 0 });
  const p = await env.place([human('a'), human('b')], { ranked: true });
  env.advance(6_000);
  await env.cp.leave(p.matchId, B);
  const { entry } = await env.finish(p, { play: { stopAt: 700, endReason: 'forfeit', forfeitTeam: 1 }, mutate: leaveAtEnd(1), waitDone: false });
  await wait(() => env.logs.some((l) => l.includes('not possible now (error)')), 'a failed attempt');
  assert.equal(entry.state, 'verifying');
  const queuedAt = entry.queuedAt;

  env.restart();
  const back = env.cp.matches.get(p.matchId);
  assert.equal(back.state, 'verifying');
  assert.equal(back.queuedAt, queuedAt, 'the 6 h wait counts from the first queueing');
  assert.equal(back.report.kind, 'ended');
  env.onVerify = verify;
  env.advance(1_000);
  await env.reconnect(); // a verifier's hello dispatches the queue at once
  await wait(() => back.state === 'done', 'rated');
  assert.equal(back.outcome.kind, 'rated', JSON.stringify(back.outcome));
  assert.equal(back.verifiedBy, env.nodeId);
  assert.deepEqual(
    back.outcome.players.map((x) => x.left),
    [false, true],
  );
});

test('the 6 h verification wait gives up on nothing inside a restart’s grace', async () => {
  const env = await setup({ store: new MemoryStore(), trusted: true, roles: ['host', 'verify'], noInline: true });
  await wait(() => env.registry.node(env.nodeId).status === 'active');
  env.onVerify = async () => ({ ok: false, code: 'error', message: 'busy', ticks: 0, score: { blue: 0, red: 0 }, winner: -1, finalHash: 0, cpuMs: 0 });
  const p = await env.place([human('a'), human('b')], { ranked: true });
  const { entry } = await env.finish(p, { waitDone: false });
  await wait(() => env.logs.some((l) => l.includes('not possible now (error)')), 'a failed attempt');
  env.advance(VERIFY_MAX_WAIT_MS + 1); // the verifier fails all along; the deploy comes after 6 h
  env.restart();
  const back = env.cp.matches.get(p.matchId);
  assert.equal(back.queuedAt, entry.queuedAt);
  env.cp.sweep();
  assert.equal(back.state, 'verifying', 'its verifier must reconnect first');
  assert.ok(!env.logs.some((l) => l.includes('could not be verified')));
  env.advance(RESTART_GRACE_MS);
  env.cp.sweep();
  assert.equal(back.outcome.reason, 'unverified');
  assert.ok(env.logs.some((l) => l.startsWith(`ALERT match ${p.matchId} could not be verified`)));
});

test('a report deadline that passed during the outage voids nothing inside the grace', async () => {
  const env = await setup({ store: new MemoryStore() });
  const a = await env.place([human('a')]);
  const b = await env.place([human('b')]);
  env.advance(env.cp.matches.get(a.matchId).deadline - env.now() - 1_000);
  env.restart();
  env.advance(2_000);
  env.cp.sweep();
  assert.equal(env.cp.matches.get(a.matchId).state, 'assigned');
  assert.equal(env.cp.matches.get(b.matchId).state, 'assigned');
  await env.reconnect();
  const { entry } = await env.finish(a);
  assert.equal(entry.outcome.kind, 'unrated', 'its report came in the grace');
  // The other one never reports: once the grace is over it is late.
  env.advance(RESTART_GRACE_MS);
  env.cp.sweep();
  assert.equal(env.cp.matches.get(b.matchId).outcome.reason, 'no_report');
});

test('a ranked cancel a deploy held up is judged as of the restart: on time then is on time', async () => {
  const env = await setup({ store: new MemoryStore(), status: 'active' });
  const cancel = (p, noShows) => ({ t: 'report', id: 'cancelled:' + p.matchId, report: { kind: 'cancelled', matchId: p.matchId, reason: 'no_show', noShows } });
  const p = await env.place([human('a'), human('b')], { ranked: true });
  env.advance(44_000);
  env.restart(); // the node's no_show cancel, due at 45 s, waits for its reconnect
  env.advance(35_000); // its backoff: 1 + 2 + 4 + 8 + 16 s
  assert.equal(env.cp.inGrace(), true);
  await env.reconnect();
  await env.send(cancel(p, [B]));
  assert.equal(env.cp.matches.get(p.matchId).outcome.reason, 'no_show', '79 s after the assignment, but 44 s when the control plane went down');
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 0);

  // Already late when the control plane went down: late.
  const q = await env.place([human('c'), human('d')], { ranked: true });
  env.advance(80_000);
  env.restart();
  env.advance(5_000);
  await env.reconnect();
  await env.send(cancel(q, ['d'.repeat(16)]));
  assert.equal(env.cp.matches.get(q.matchId).outcome.reason, 'lost:late_cancel');
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 1);

  // Placed after the restart, on a node already back: the grace held nothing up.
  await env.place([human('e')]); // unfinished, so the next restart waits for the node
  env.advance(60_000);
  env.restart();
  await env.reconnect();
  const r = await env.place([human('f'), human('g')], { ranked: true });
  env.advance(80_000);
  assert.equal(env.cp.inGrace(), true);
  await env.send(cancel(r, ['g'.repeat(16)]));
  assert.equal(env.cp.matches.get(r.matchId).outcome.reason, 'lost:late_cancel');
});

test('one outage is one strike across a restart: the last strike time comes back from the node row', async () => {
  const env = await setup({ store: new MemoryStore() });
  const [p1, p2] = [await env.place([human('a')]), await env.place([human('b')])];
  await env.send(lost(p1.matchId));
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 1);
  env.restart();
  await env.reconnect();
  env.advance(10_000);
  await env.send(lost(p2.matchId));
  assert.equal(env.cp.matches.get(p2.matchId).state, 'done');
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 1, 'the same outage');
  env.advance(60_000);
  const p3 = await env.place([human('c')]);
  await env.send(lost(p3.matchId));
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 2, 'a later one counts');
});

test('every write goes out before the message that depends on it', async () => {
  const log = [];
  const at = (pred) => log.findIndex(pred);
  const env = await setup({ status: 'active', store: logged(log), onSend: (m) => log.push({ what: 'send', t: m.t }), onOutcome: (o) => log.push({ what: 'outcome', kind: o.kind }) });
  log.length = 0;
  const p = await env.place([human('a'), human('b')], { ranked: true });
  log.push({ what: 'placed' });
  assert.ok(at((x) => x.what === 'save' && x.state === 'assigned') < at((x) => x.what === 'placed'), 'the match before its tickets');

  log.length = 0;
  for (let i = 0; i < 3; i++) await env.heartbeat({ active: 1, matches: [{ matchId: p.matchId, tick: 100 + i, phase: 'play', sockets: 2 }] });
  assert.deepEqual(log, [{ what: 'save', state: 'assigned', started: true, leaves: 0, replay: false, offered: 0 }], 'the start once, not every heartbeat');

  env.advance(6_000);
  log.length = 0;
  await env.cp.leave(p.matchId, B);
  assert.deepEqual(
    log.map((x) => (x.what === 'save' ? `save leaves=${x.leaves}` : `${x.what} ${x.t}`)),
    ['save leaves=1', 'send leave', 'save leaves=1'],
    'the leave is written before it is relayed',
  );

  log.length = 0;
  const { report } = await env.upload(p, { play: { stopAt: 700, endReason: 'forfeit', forfeitTeam: 1 }, mutate: leaveAtEnd(1) });
  assert.deepEqual(log, [{ what: 'save', state: 'assigned', started: true, leaves: 1, replay: true, offered: 0 }], 'the upload is written before its 200');

  log.length = 0;
  await env.report(report);
  const verifying = at((x) => x.what === 'save' && x.state === 'verifying');
  assert.ok(verifying >= 0 && verifying < at((x) => x.what === 'send' && x.t === 'ack'), 'queued for verification before the ack');
  assert.ok(at((x) => x.what === 'finished' && x.kind === 'rated') > verifying);
  assert.ok(at((x) => x.what === 'finished' && x.kind === 'rated') < at((x) => x.what === 'outcome' && x.kind === 'rated'), 'settled before the outcome goes out (in the DO, its outbox rows)');

  log.length = 0;
  const q = await env.place([human('c')]);
  await env.send(lost(q.matchId));
  const settled = at((x) => x.what === 'finished' && x.kind === 'void');
  assert.ok(settled >= 0 && settled < at((x) => x.what === 'send' && x.t === 'ack'), 'settled before the ack');
  assert.ok(settled < at((x) => x.what === 'outcome' && x.kind === 'void'));

  // rtc: the offer (the evidence a no-show is judged on) is written before it is relayed.
  const rlog = [];
  const rtc = await setup({ rtc: true, status: 'active', store: logged(rlog), onSend: (m) => rlog.push({ what: 'send', t: m.t }) });
  const r = await rtc.place([human('d'), human('e')], { ranked: true });
  rlog.length = 0;
  await rtc.cp.rtcOffer(rtc.nodeId, r.matchId, r.tickets[0].ticket, 'v=0');
  assert.deepEqual(
    rlog.map((x) => (x.what === 'save' ? `save offered=${x.offered}` : `${x.what} ${x.t}`)),
    ['save offered=1', 'send rtcOffer'],
  );
});

test('a match settles once when the sweep voids it while its report is being read', async () => {
  const log = [];
  const env = await setup({ store: logged(log), getDelay: 100 });
  const p = await env.place([human('a')]);
  const { report } = await env.upload(p);
  env.advance(env.cp.matches.get(p.matchId).deadline - env.now() - 10);
  const sent = env.report(report, { waitDone: false });
  await sleep(20);
  assert.equal(env.cp.matches.get(p.matchId).state, 'reporting');
  env.advance(20);
  env.cp.sweep();
  await sent;
  await sleep(150);
  assert.equal(env.cp.matches.get(p.matchId).outcome.reason, 'no_report');
  assert.equal(log.filter((x) => x.what === 'finished').length, 1);
  assert.equal(env.outcomes.filter((o) => o.matchId === p.matchId).length, 1);
});

/** A MemoryStore whose next `fail.save` saves and `fail.finished` settlements throw (a full disk). */
function flaky() {
  const mem = new MemoryStore();
  const fail = { save: 0, finished: 0 };
  const hit = (what) => {
    if (fail[what] === 0) return;
    fail[what]--;
    throw new Error('SQLITE_FULL');
  };
  return {
    mem,
    fail,
    node: (n) => mem.node(n),
    register: (t, n) => mem.register(t, n),
    tokens: (t) => mem.tokens(t),
    dropTokens: (h) => mem.dropTokens(h),
    save: (m) => (hit('save'), mem.save(m)),
    finished: (m, o) => (hit('finished'), mem.finished(m, o)),
    drop: (id) => mem.drop(id),
    rows: () => mem.rows(),
  };
}

test('a store that fails while a match settles loses nothing: the next try settles it, once', async () => {
  const store = flaky();
  const env = await setup({ store });
  const acks = () => env.toNode.filter((m) => m.t === 'ack').length;
  const row = (id) => store.mem.matchRows.get(id).state;
  const outcomes = (id) => env.outcomes.filter((o) => o.matchId === id).length;

  // A 'lost' report: not acked, and the match waits for its report again.
  const p = await env.place([human('a')]);
  store.fail.finished = 1;
  await assert.rejects(env.send(lost(p.matchId)), /SQLITE_FULL/);
  const m = env.cp.matches.get(p.matchId);
  assert.deepEqual([m.state, m.report, m.outcome, row(p.matchId), acks(), outcomes(p.matchId)], ['assigned', null, null, 'assigned', 0, 0]);
  await env.send(lost(p.matchId)); // the node sends it again
  assert.deepEqual([m.state, row(p.matchId), acks(), outcomes(p.matchId)], ['done', 'done', 1, 1], 'settled by the copy, not acked and dropped');
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 1);

  // An 'ended' report whose queueing for verification fails: the copy is verified.
  const q = await env.place([human('b')]);
  const { report } = await env.upload(q);
  store.fail.save = 1;
  await assert.rejects(env.report(report, { waitDone: false }), /SQLITE_FULL/);
  const e = env.cp.matches.get(q.matchId);
  assert.deepEqual([e.state, e.report, row(q.matchId), acks()], ['assigned', null, 'assigned', 1]);
  await env.report(report);
  assert.equal(e.outcome.verified, true);
  assert.deepEqual([row(q.matchId), acks(), outcomes(q.matchId)], ['done', 2, 1]);

  // The sweep voiding a silent node's match: the next sweep does it.
  const s = await env.place([human('c')]);
  env.disconnect();
  env.advance(NODE_OFFLINE_MS + 1);
  store.fail.finished = 1;
  assert.throws(() => env.cp.sweep(), /SQLITE_FULL/);
  assert.equal(env.cp.matches.get(s.matchId).state, 'assigned', 'never settled in memory only: the purge would drop its row unsent');
  env.advance(5_000);
  env.cp.sweep();
  assert.equal(env.cp.matches.get(s.matchId).outcome.reason, 'node_offline');
  assert.deepEqual([row(s.matchId), outcomes(s.matchId)], ['done', 1]);
});

test('settled matches leave the store after the retention', async () => {
  const store = new MemoryStore();
  const env = await setup({ store });
  const p = await env.place([human('a')]);
  await env.send(lost(p.matchId));
  assert.equal(store.matchRows.get(p.matchId).state, 'done');
  assert.equal(env.cp.unfinished(), 0);
  env.advance(10 * 60_000);
  env.cp.sweep();
  assert.ok(store.matchRows.has(p.matchId));
  env.advance(1);
  env.cp.sweep();
  assert.equal(store.matchRows.has(p.matchId), false);
  assert.equal(env.cp.matches.has(p.matchId), false);
  // A cold start with nothing unfinished waits for nobody.
  env.restart();
  assert.equal(env.cp.inGrace(), false);
});

test('a socket that outlived a hibernation is adopted without a new challenge; an unknown or banned node is closed', async () => {
  const env = await setup({ store: new MemoryStore() });
  const p = await env.place([human('a')]);
  env.restart({ cold: false }); // the DO woke up: its memory is new, the sockets are the same
  assert.equal(env.cp.inGrace(), false, 'no grace: the nodes never left');
  const sent = [];
  const link = { send: (m) => sent.push(m), close: (code) => sent.push({ close: code }) };
  const s = env.cp.adopt(link, env.nodeId);
  assert.ok(s);
  assert.equal(env.cp.isOnline(env.nodeId), true);
  env.cp.sweep();
  assert.equal(env.cp.matches.get(p.matchId).state, 'assigned', 'a sweep before its first heartbeat voids nothing');
  env.session = s;
  await env.heartbeat({ active: 1, matches: [{ matchId: p.matchId, tick: 60, phase: 'play', sockets: 1 }] });
  assert.deepEqual(sent, [], 'no challenge and no "auth first"');
  assert.equal(env.registry.node(env.nodeId).online, true);
  assert.equal(env.cp.matches.get(p.matchId).startedSeen, true);

  // Another socket of the same node is adopted: it replaces the first, and the node stays online.
  const s2 = env.cp.adopt({ send() {}, close() {} }, env.nodeId);
  assert.deepEqual(sent, [{ close: 4000 }]);
  assert.equal(s.closed, true);
  assert.equal(env.cp.isOnline(env.nodeId), true);
  assert.equal(env.registry.node(env.nodeId).online, true);
  env.session = s2;
  await env.heartbeat();
  env.advance(20_000);
  env.cp.sweep();
  assert.equal(env.cp.matches.get(p.matchId).state, 'assigned', 'its heartbeats go on');

  const closes = [];
  const other = { send() {}, close: (code) => closes.push(code) };
  assert.equal(env.cp.adopt(other, 'f'.repeat(16)), null);
  env.registry.setStatus(env.nodeId, 'banned', 'test');
  assert.equal(env.cp.adopt(other, env.nodeId), null);
  assert.deepEqual(closes, [4401, 4401]);
});

test('an adopted socket whose node never speaks again: offline at the heartbeat timeout, closed after LINK_TIMEOUT_MS, its matches void after NODE_OFFLINE_MS', async () => {
  const env = await setup({ store: new MemoryStore() });
  const p = await env.place([human('a')]);
  env.restart({ cold: false });
  const closes = [];
  env.cp.adopt({ send() {}, close: (code) => closes.push(code) }, env.nodeId);
  assert.equal(env.cp.hostsOnline('SA'), 1, 'live from the adoption, before any heartbeat');
  // env.session stays the one closed by the restart: no heartbeats from here on.
  env.advance(15_000);
  env.cp.sweep();
  assert.equal(env.cp.hostsOnline('SA'), 1);
  env.advance(1_000);
  env.cp.sweep();
  assert.equal(env.cp.hostsOnline('SA'), 0, 'no new matches');
  assert.equal(env.cp.isOnline(env.nodeId), false);
  env.advance(LINK_TIMEOUT_MS - 16_000);
  env.cp.sweep();
  assert.deepEqual(closes, [], 'its link waits for a late heartbeat');
  env.advance(1);
  env.cp.sweep();
  assert.deepEqual(closes, [4408]);
  assert.equal(env.cp.matches.get(p.matchId).state, 'assigned');
  env.advance(NODE_OFFLINE_MS - LINK_TIMEOUT_MS);
  env.cp.sweep();
  assert.equal(env.cp.matches.get(p.matchId).outcome.reason, 'node_offline');
});

test('after a hibernation, a node whose socket did not survive it gets its full window to come back', async () => {
  // A project node: NODE_OFFLINE_MS from the restore, and the same process reconnecting goes on.
  const env = await setup({ store: new MemoryStore(), trusted: true });
  await wait(() => env.registry.node(env.nodeId).status === 'active');
  const p = await env.place([human('a'), human('b')], { ranked: true });
  env.advance(1_000);
  env.restart({ cold: false }); // its socket closed while the DO slept: nothing to adopt
  env.cp.sweep();
  const m = env.cp.matches.get(p.matchId);
  assert.equal(m.state, 'assigned', 'its last heartbeat is forgotten, not 0');
  env.advance(NODE_OFFLINE_MS - 1_000);
  env.cp.sweep();
  assert.equal(m.state, 'assigned');
  await env.reconnect();
  env.advance(NODE_OFFLINE_MS);
  env.cp.sweep();
  assert.equal(m.state, 'assigned');
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 0);

  // A community node: the same NODE_OFFLINE_MS from the restore.
  const c = await setup({ store: new MemoryStore() });
  const q = await c.place([human('c')]);
  c.restart({ cold: false });
  c.advance(NODE_OFFLINE_MS);
  c.cp.sweep();
  assert.equal(c.cp.matches.get(q.matchId).state, 'assigned');
  c.advance(1);
  c.cp.sweep();
  assert.equal(c.cp.matches.get(q.matchId).outcome.reason, 'node_offline');
});

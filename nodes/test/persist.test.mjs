// Persistence: the rows of persist.ts (what a Worker deploy or a Durable Object restart must not lose).
import '../dev/ts-resolve.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { STATE_VERSION, MemoryStore, nodeToRow, nodeFromRow, tokenToRow, tokenFromRow, matchToRow, matchFromRow } = await import('../control-plane/persist.ts');
const { Registry, TOKEN_TTL_MS } = await import('../control-plane/registry.ts');
const { generateEd25519 } = await import('../shared/edcrypto.ts');

const BUILD = { version: '0.1.0', protocol: 1, wasmSha256: 'a'.repeat(64) };
const SPECS = { cpus: 2, cpuModel: 'x', memMB: 4096, arch: 'x64', os: 'linux', node: '24' };
const CAP = { matches: 4, cpuMsPerMatchSecond: 1, memMBPerMatch: 20, uplinkMbps: null, source: 'declared' };
const HEARTBEAT_RESET = { online: false, lastSeen: 0, active: 0, draining: false, tickLagP99Ms: 0, egressGB: 0, cpuLoad: 0 };
const OP = { id: 'op1', name: 'Juan' };

const hello = (patch = {}) => ({ bootId: 'boot-1', build: BUILD, roles: ['host'], transports: ['wss'], publicUrl: 'wss://203.0.113.7', rtcReady: false, specs: SPECS, capacity: CAP, draining: false, egressCapGB: null, ...patch });
const beat = (patch = {}) => ({ active: 1, capacity: 4, draining: false, egressGB: 0.5, egressCapGB: null, tickLagP99Ms: 2, cpuLoad: 0.3, rssMB: 80, matches: [], ...patch });

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

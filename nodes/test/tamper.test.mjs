// A cheating node against the ControlPlane, without sockets: the node logs in, passes the probe,
// hosts a match honestly (accepted, points), then reports a second match with a forged score whose
// replay was edited to agree. The re-simulation catches it: no result, no points, node suspended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playRecordedMatch, testBuild } from './helpers.mjs';

const { ControlPlane } = await import('../control-plane/controlPlane.ts');
const { Registry } = await import('../control-plane/registry.ts');
const { Ledger } = await import('../control-plane/ledger.ts');
const { generateEd25519, importPrivateKey, sign, sha256Hex } = await import('../shared/edcrypto.ts');
const { authMessage, reachMessage, replayRequestMessage } = await import('../shared/controlProtocol.ts');
const { decodeReplay, ReplayWriter } = await import('../shared/replay.ts');
const { verifyReplay } = await import('../shared/verify.ts');
const { nodeSimFactory } = await import('../shared/nodeArena.ts');
const T = await import('../../src/sim/types.ts');

const SPECS = { cpus: 2, cpuModel: 'x', memMB: 4096, arch: 'x64', os: 'linux', node: '24' };
const CAP = { matches: 4, cpuMsPerMatchSecond: 1, memMBPerMatch: 20, uplinkMbps: null, source: 'declared' };

function forgeScore(bytes, extraBlue) {
  const r = decodeReplay(bytes);
  r.end.blue += extraBlue;
  r.end.winner = r.end.blue > r.end.red ? 0 : r.end.red > r.end.blue ? 1 : -1;
  const w = new ReplayWriter(r.header);
  const recs = [];
  for (let i = 0; i < r.inputCount; i++) recs.push([r.inputTicks[i], 0, i]);
  for (let i = 0; i < r.hashCount; i++) recs.push([r.hashTicks[i], 2, i]);
  recs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [tick, kind, i] of recs) {
    if (kind === 0) w.input(tick, r.inputSlots[i], r.inputData, i * T.PACKED_INPUT_BYTES);
    else w.hash(tick, r.hashValues[i]);
  }
  w.end(r.end);
  return { bytes: w.finish(), end: r.end };
}

test('a node that forges a score is caught by the re-simulation and suspended', async () => {
  const build = await testBuild();
  const ctl = await generateEd25519();
  const nodeKeys = await generateEd25519();
  const nodeKey = await importPrivateKey(nodeKeys.privateKey);
  const registry = new Registry({ allowInsecure: true });
  const replays = new Map();
  const outcomes = [];
  let clock = Date.now();
  const cp = new ControlPlane({
    now: () => clock,
    controlPrivateKey: ctl.privateKey,
    controlPublicKey: ctl.publicKey,
    controlUrl: 'ws://cp/nodes/connect',
    httpBase: 'http://cp',
    build: () => build,
    channel: () => ({ stable: build.version, minimum: '0.0.0' }),
    registry,
    ledger: new Ledger(),
    replays: { put: async (id, b) => void replays.set(id, b), get: async (id) => replays.get(id) ?? null },
    inlineVerify: (bytes, job) => verifyReplay(bytes, { makeSim: nodeSimFactory, wasmSha256: build.wasmSha256, protocol: build.protocol, expect: job.expect, expectNodeId: job.hostNodeId }),
    // The probe: the "node" signs the nonce it is asked about.
    fetchJson: async (url) => {
      const nonce = new URL(url.replace(/^ws/, 'http')).searchParams.get('nonce');
      return { nodeId, sig: await sign(nodeKey, reachMessage(nodeId, nonce)) };
    },
    onOutcome: (o) => outcomes.push(o),
    log: () => undefined,
  });

  const { token } = await registry.createToken({ id: 'op1', name: 'Tramposo' }, 'SA', Date.now());
  const reg = await registry.register({ token, publicKey: nodeKeys.publicKey, roles: ['host'], publicUrl: 'ws://198.51.100.9:7350', build, specs: SPECS, capacity: CAP }, Date.now());
  assert.ok(reg.ok);
  const nodeId = reg.node.nodeId;

  // The fake node answers the control plane's messages.
  const toNode = [];
  let session = null;
  const reply = (m) => setTimeout(() => void cp.onMessage(session, JSON.stringify(m)), 0);
  const link = {
    send(m) {
      toNode.push(m);
      if (m.t === 'challenge') void sign(nodeKey, authMessage(nodeId, m.nonce)).then((sig) => reply({ t: 'auth', nodeId, sig }));
      if (m.t === 'welcome') {
        reply({ t: 'hello', data: { build, roles: ['host'], publicUrl: 'ws://198.51.100.9:7350', specs: SPECS, capacity: CAP, draining: false, egressCapGB: null } });
        reply({ t: 'heartbeat', data: { active: 0, capacity: 4, draining: false, egressGB: 0, egressCapGB: null, tickLagP99Ms: 1, cpuLoad: 0.1, rssMB: 80, matches: [] } });
      }
      if (m.t === 'assign') reply({ t: 'reply', rid: m.rid, ok: true, data: { wsUrl: `ws://198.51.100.9:7350/m/${m.match.matchId}` } });
    },
    close() {},
  };
  session = cp.open(link);
  const wait = async (fn) => {
    for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(fn());
  };
  await wait(() => registry.node(nodeId).status === 'probation');

  async function hostMatch(forge) {
    // The node keeps heart-beating while the (simulated) clock moves.
    await cp.onMessage(session, JSON.stringify({ t: 'heartbeat', data: { active: 0, capacity: 4, draining: false, egressGB: 0, egressCapGB: null, tickLagP99Ms: 1, cpuLoad: 0.1, rssMB: 80, matches: [] } }));
    const humans = [{ playerId: 'a'.repeat(16), name: 'Azul', account: true, accountAgeDays: 30 }];
    const p = await cp.place({ mode: '1v1', region: 'SA', ranked: false, humans, matchLengthSeconds: 10, kickoffCountdownSeconds: 1, goalPauseSeconds: 1 });
    assert.ok(p, 'placed');
    const a = cp.matches.get(p.matchId).assign;
    // A deterministic ending whatever the (random) kickoff seed does: the rules by tick 1500, or
    // everybody gone ('empty', proven by 200 ticks of zero controls).
    const m = await playRecordedMatch({ roster: a.roster, seed: a.kickoffSeed, matchId: a.matchId, nodeId, lengthSeconds: 10, region: 'SA', ranked: false, stopAt: 1500, endReason: 'empty', idleSlots: { 0: 1300 } });
    let bytes = m.bytes;
    let end = m.end;
    if (forge) ({ bytes, end } = forgeScore(m.bytes, 2));
    clock += Math.ceil((end.tick / 120) * 1000) + 1000; // the match took its time
    const sha = await sha256Hex(bytes);
    const ts = clock;
    const up = await cp.storeReplay(a.matchId, nodeId, ts, await sign(nodeKey, replayRequestMessage('PUT', a.matchId, sha, ts)), sha, bytes);
    assert.ok(up.ok, JSON.stringify(up));
    const stats = { ticks: end.tick, durationMs: (end.tick / 120) * 1000, slots: [{ slot: 0, received: end.tick, dropped: 0, underruns: 0, overruns: 0, connectedMs: (end.tick / 120) * 1000 }], tickLagP99Ms: 1, egressBytes: 1e6 };
    const report = { kind: 'ended', matchId: a.matchId, result: { winner: end.winner, blue: end.blue, red: end.red, endTick: end.tick, endReason: end.reason }, replaySha256: sha, replayBytes: bytes.length, stats };
    await cp.onMessage(session, JSON.stringify({ t: 'report', id: 'ended:' + a.matchId, report }));
    await wait(() => cp.matches.get(a.matchId).state === 'done');
    return cp.matches.get(a.matchId);
  }

  const honest = await hostMatch(false);
  assert.equal(honest.verdict.code, 'ok');
  assert.equal(honest.outcome.kind, 'unrated');
  assert.ok(honest.ledger.points > 0);
  assert.ok(toNode.some((m) => m.t === 'ack'), 'reports are acknowledged');

  // A forged upload from another key is refused outright.
  const evil = await generateEd25519();
  const ts = Date.now();
  const refused = await cp.storeReplay(honest.assign.matchId, nodeId, ts, await sign(await importPrivateKey(evil.privateKey), replayRequestMessage('PUT', honest.assign.matchId, 'x', ts)), 'x', new Uint8Array(4));
  assert.equal(refused.ok, false);

  const cheat = await hostMatch(true);
  assert.equal(cheat.verdict.code, 'score_mismatch');
  assert.equal(cheat.outcome.kind, 'void');
  assert.match(cheat.outcome.reason, /^verification_failed/);
  assert.equal(cheat.ledger, null, 'no points');
  assert.equal(registry.node(nodeId).status, 'suspended');
  assert.ok(toNode.some((m) => m.t === 'status' && m.status === 'suspended'), 'the node is told');
  // A suspended node gets no more matches.
  assert.equal(await cp.place({ mode: '1v1', region: 'SA', ranked: false, humans: [{ playerId: 'b'.repeat(16), name: 'X' }], matchLengthSeconds: 10 }), null);
});

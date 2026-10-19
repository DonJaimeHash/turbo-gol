// Review fixes in the control plane, against a fake node (no sockets) and a controllable clock:
// the outcome comes from the verdict, points from verified minutes, no-shows and cancels are not
// taken on a community node's word, malformed messages never throw, leaves after the whistle are
// refused, dead or restarted nodes lose their matches (one strike per outage), verifier-side
// failures are retried, and a failed verification always means manual review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { T, playRecordedMatch, testBuild } from './helpers.mjs';

const { ControlPlane } = await import('../control-plane/controlPlane.ts');
const { Registry, STRIKE_COOLDOWN_MS, PROBATION_MATCHES } = await import('../control-plane/registry.ts');
const { Ledger } = await import('../control-plane/ledger.ts');
const { generateEd25519, importPrivateKey, sign, sha256Hex } = await import('../shared/edcrypto.ts');
const { authMessage, reachMessage, replayRequestMessage } = await import('../shared/controlProtocol.ts');
const { verifyReplay } = await import('../shared/verify.ts');
const { decodeReplay, ReplayWriter } = await import('../shared/replay.ts');
const { nodeSimFactory } = await import('../shared/nodeArena.ts');

const SPECS = { cpus: 2, cpuModel: 'x', memMB: 4096, arch: 'x64', os: 'linux', node: '24' };
const CAP = { matches: 4, cpuMsPerMatchSecond: 1, memMBPerMatch: 20, uplinkMbps: null, source: 'declared' };
const URL_ = 'ws://198.51.100.9:7350';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, what = 'condition') {
  for (let i = 0; i < 400 && !fn(); i++) await sleep(10);
  assert.ok(fn(), what);
}

/** Rebuild a replay with `mutate(parsed)` applied. */
function rewrite(bytes, mutate) {
  const r = decodeReplay(bytes);
  mutate(r);
  const w = new ReplayWriter(r.header);
  const recs = [];
  for (let i = 0; i < r.inputCount; i++) recs.push({ tick: r.inputTicks[i], o: 0, k: 'i', i });
  for (const t of r.takeovers) recs.push({ tick: t.tick, o: 1, k: 't', t });
  for (let i = 0; i < r.hashCount; i++) recs.push({ tick: r.hashTicks[i], o: 2, k: 'h', i });
  recs.sort((a, b) => a.tick - b.tick || a.o - b.o);
  for (const x of recs) {
    if (x.k === 'i') w.input(x.tick, r.inputSlots[x.i], r.inputData, x.i * T.PACKED_INPUT_BYTES);
    else if (x.k === 't') w.takeover(x.t.tick, x.t.slot);
    else w.hash(x.tick, r.hashValues[x.i]);
  }
  if (r.end) w.end(r.end);
  return w.finish();
}
const leaveAtEnd = (slot) => (bytes) => rewrite(bytes, (r) => r.takeovers.push({ tick: r.end.tick + 1, slot }));

const human = (c, extra = {}) => ({ playerId: c.repeat(16), name: c.toUpperCase(), account: true, accountAgeDays: 30, ...extra });

/** A control plane with one fake node (wss, or rtc with opts.rtc), logged in and proven reachable. */
async function setup(opts = {}) {
  const build = await testBuild();
  let clock = Date.now();
  const now = () => clock;
  const ctl = await generateEd25519();
  const nodeKeys = await generateEd25519();
  const nodeKey = await importPrivateKey(nodeKeys.privateKey);
  const log = process.env.CPLOG ? (m) => console.log('[cp] ' + m) : () => undefined;
  const registry = new Registry({ allowInsecure: true, trustedOperators: opts.trusted ? ['op1'] : [], log });
  const replays = new Map();
  const outcomes = [];
  let nodeId = '';
  const realVerify = (bytes, job) => verifyReplay(bytes, { makeSim: nodeSimFactory, wasmSha256: build.wasmSha256, protocol: build.protocol, expect: job.expect, expectNodeId: job.hostNodeId, leaves: job.leaves });
  const cp = new ControlPlane({
    controlPrivateKey: ctl.privateKey,
    controlPublicKey: ctl.publicKey,
    controlUrl: 'ws://cp/nodes/connect',
    httpBase: 'http://cp',
    build: () => build,
    channel: () => ({ stable: build.version, minimum: '0.0.0' }),
    registry,
    ledger: new Ledger(),
    replays: {
      put: async (id, b) => void replays.set(id, b),
      get: async (id) => {
        if (opts.getDelay) await sleep(opts.getDelay);
        return replays.get(id) ?? null;
      },
    },
    inlineVerify: opts.noInline ? undefined : opts.verify ? (bytes, job) => opts.verify(bytes, job, realVerify) : realVerify,
    casualVerifyRate: opts.casualVerifyRate,
    fetchJson: async (url) => {
      const nonce = new URL(url.replace(/^ws/, 'http')).searchParams.get('nonce');
      return { nodeId, sig: await sign(nodeKey, reachMessage(nodeId, nonce)) };
    },
    onOutcome: (o) => outcomes.push(o),
    now,
    log,
  });
  const { token } = await registry.createToken({ id: 'op1', name: 'Operador' }, 'SA', clock);
  const reg = await registry.register({ token, publicKey: nodeKeys.publicKey, roles: ['host'], ...(opts.rtc ? { publicUrl: null, transports: ['rtc'] } : { publicUrl: URL_ }), build, specs: SPECS, capacity: CAP }, clock);
  assert.ok(reg.ok);
  nodeId = reg.node.nodeId;

  const toNode = [];
  const closes = [];
  const env = { build, cp, registry, nodeKey, toNode, closes, outcomes, replays, nodeId, session: null, boot: 'boot-1', leaveAnswers: true };
  const fromNode = (m) => cp.onMessage(env.session, JSON.stringify(m));
  const transport = opts.rtc ? { transports: ['rtc'], publicUrl: null, rtcReady: true, rtcRelay: true } : { transports: ['wss'], publicUrl: URL_, rtcReady: false };
  env.hello = (patch = {}) => fromNode({ t: 'hello', data: { bootId: env.boot, build, roles: ['host'], ...transport, specs: SPECS, capacity: CAP, draining: false, egressCapGB: null, ...patch } });
  env.heartbeat = (patch = {}) => fromNode({ t: 'heartbeat', data: { active: 0, capacity: 4, draining: false, egressGB: 0, egressCapGB: null, tickLagP99Ms: 1, cpuLoad: 0.1, rssMB: 80, matches: [], ...patch } });
  env.send = fromNode;
  const link = {
    send(m) {
      toNode.push(m);
      if (m.t === 'challenge') void sign(nodeKey, authMessage(nodeId, m.nonce)).then((sig) => setTimeout(() => void fromNode({ t: 'auth', nodeId, sig }), 0));
      if (m.t === 'welcome') setTimeout(() => void env.hello().then(() => env.heartbeat()), 0);
      if (m.t === 'assign') setTimeout(() => void fromNode({ t: 'reply', rid: m.rid, ok: true, data: { wsUrl: opts.rtc ? null : `${URL_}/m/${m.match.matchId}` } }), 0);
      if (m.t === 'leave' && env.leaveAnswers) setTimeout(() => void fromNode({ t: 'reply', rid: m.rid, ok: true, data: { slot: 0, closed: true, already: false, ended: false } }), 0);
      if (m.t === 'leave' && !env.leaveAnswers) setTimeout(() => void fromNode({ t: 'reply', rid: m.rid, ok: false, code: 'match_over' }), 0);
    },
    close(code, reason) {
      closes.push({ code, reason });
    },
  };
  env.session = cp.open(link);
  await wait(() => ['probation', 'active'].includes(registry.node(nodeId).status), 'node reachable');
  if (opts.status) registry.setStatus(nodeId, opts.status, null);
  env.advance = (ms) => {
    clock += ms;
    // A live node keeps heart-beating while time passes (handled synchronously by onMessage).
    if (!env.session.closed) void env.heartbeat();
  };
  env.now = now;

  /** Place a match on the node. */
  env.place = async (humans, extra = {}) => {
    const p = await cp.place({ mode: '1v1', region: 'SA', ranked: false, humans, matchLengthSeconds: 10, kickoffCountdownSeconds: 1, goalPauseSeconds: 1, ...(opts.rtc ? { transports: ['rtc'] } : {}), ...extra });
    assert.ok(p, 'placed');
    return p;
  };
  /** Play it (scripted chasers), upload the replay, send the report (patched), wait until settled. */
  env.finish = async (p, { play = {}, mutate, report: patch = {}, stats: statsPatch, waitDone = true, noAdvance = false } = {}) => {
    const a = cp.matches.get(p.matchId).assign;
    const humanSlots = a.roster.filter((e) => e.kind === 'player').map((e) => e.slot);
    // Default ending, whatever the (random) kickoff seed does: the rules by tick 1500, or everybody
    // gone ('empty', proven by 200 ticks of zero controls).
    const ending = 'stopAt' in play ? {} : { stopAt: 1500, endReason: 'empty', idleSlots: Object.fromEntries(humanSlots.map((s) => [s, 1300])) };
    const m = await playRecordedMatch({ roster: a.roster, seed: a.kickoffSeed, matchId: a.matchId, nodeId, lengthSeconds: a.matchLengthSeconds, region: a.region, ranked: a.ranked, mode: a.mode, ...ending, ...play });
    const bytes = mutate ? mutate(m.bytes) : m.bytes;
    const end = m.end;
    // The match took its game time (plus a second) on the control plane's clock too.
    if (!noAdvance) env.advance(Math.ceil((end.tick / 120) * 1000) + 1000);
    const sha = await sha256Hex(bytes);
    const ts = now();
    const up = await cp.storeReplay(a.matchId, nodeId, ts, await sign(nodeKey, replayRequestMessage('PUT', a.matchId, sha, ts)), sha, bytes);
    assert.ok(up.ok, JSON.stringify(up));
    const secs = end.tick / 120;
    const stats = statsPatch ?? { ticks: end.tick, durationMs: secs * 1000, slots: humanSlots.map((slot) => ({ slot, received: end.tick, dropped: 0, underruns: 0, overruns: 0, connectedMs: secs * 1000 })), tickLagP99Ms: 1, egressBytes: 1e6 };
    const result = { winner: end.winner, blue: end.blue, red: end.red, endTick: end.tick, endReason: end.reason, ...(end.forfeitTeam !== -1 ? { forfeitTeam: end.forfeitTeam } : {}), ...(patch.result ?? {}) };
    const report = { kind: 'ended', matchId: a.matchId, result, replaySha256: sha, replayBytes: bytes.length, stats };
    await fromNode({ t: 'report', id: 'ended:' + a.matchId, report });
    if (waitDone) await wait(() => cp.matches.get(a.matchId).state === 'done', 'match settled');
    return { entry: cp.matches.get(a.matchId), end };
  };
  return env;
}

test("the outcome comes from the replay: a report whose end reason disagrees is a failed verification", async () => {
  const env = await setup({ status: 'active' });
  const p = await env.place([human('a'), human('b')], { ranked: true });
  env.advance(6_000);
  await env.cp.leave(p.matchId, 'b'.repeat(16));
  // Red forfeited by leaving (a loss); the node says everybody left, to void it.
  const { entry, end } = await env.finish(p, { play: { stopAt: 700, endReason: 'forfeit', forfeitTeam: 1 }, mutate: leaveAtEnd(1), report: { result: { endReason: 'left' } } });
  assert.equal(end.reason, 'forfeit');
  assert.equal(entry.verdict.code, 'ok', 'the replay itself is fine');
  assert.equal(entry.outcome.kind, 'void');
  assert.equal(entry.outcome.reason, 'verification_failed:report_mismatch');
  assert.equal(env.registry.node(env.nodeId).status, 'suspended');
});

test('a rated result uses the verdict and flags only proven leaves', async () => {
  const env = await setup({ status: 'active' });
  const p = await env.place([human('a'), human('b')], { ranked: true });
  env.advance(6_000);
  await env.cp.leave(p.matchId, 'b'.repeat(16));
  const { entry } = await env.finish(p, { play: { stopAt: 700, endReason: 'forfeit', forfeitTeam: 1 }, mutate: leaveAtEnd(1) });
  assert.equal(entry.outcome.kind, 'rated', JSON.stringify(entry.outcome));
  assert.equal(entry.outcome.winner, 0);
  assert.deepEqual(entry.outcome.players.map((x) => x.left), [false, true], 'only the proven leaver');
  // A quit pressed after the whistle is refused like MatchDO's 410 and flags nobody.
  await assert.rejects(env.cp.leave(p.matchId, 'a'.repeat(16)), (e) => e.code === 'match_over');
});

test('a node holding its report cannot turn a later, automatic leave into an abandon', async () => {
  const env = await setup({ status: 'active' });
  const p = await env.place([human('a'), human('b')], { ranked: true });
  // The match ends at 5.8 s; the node holds the report. Five minutes later B's client sends an
  // automatic leave (the P2P queue's active-match recovery), and the node records it at end + 1.
  env.advance(300_000);
  await env.cp.leave(p.matchId, 'b'.repeat(16));
  const { entry } = await env.finish(p, { play: { stopAt: 700, endReason: 'forfeit', forfeitTeam: 1 }, mutate: leaveAtEnd(1) });
  assert.equal(entry.outcome.reason, 'verification_failed:bad_takeover_time');
});

test('a ttl whistle before the TTL by the control plane’s clock is refused', async () => {
  const env = await setup();
  // An unlimited casual match (no overtime rule): the clock is the only check.
  const early = await env.place([human('a')], { matchLengthSeconds: 0 });
  const r1 = await env.finish(early, { play: { stopAt: 1200, endReason: 'ttl' } });
  assert.equal(r1.entry.outcome.reason, 'verification_failed:early_ttl');
  // Whistled after 10 s of play and reported after the TTL: the game clock gives it away.
  const env2 = await setup();
  const held = await env2.place([human('c')], { matchLengthSeconds: 0 });
  env2.advance(600_000);
  const r2 = await env2.finish(held, { play: { stopAt: 1200, endReason: 'ttl' } });
  assert.equal(r2.entry.outcome.reason, 'verification_failed:early_ttl', 'a held report does not make an early whistle');
  // A real TTL: 455 s of play, reported after 600 s.
  const env3 = await setup();
  const real = await env3.place([human('d')], { matchLengthSeconds: 0 });
  env3.advance(140_000);
  const r3 = await env3.finish(real, { play: { stopAt: 455 * 120, endReason: 'ttl' } });
  assert.equal(r3.entry.outcome.kind, 'unrated', r3.entry.outcome.reason);
});

test('a replay longer than the time since the assignment is refused', async () => {
  const env = await setup();
  const p = await env.place([human('a')], { matchLengthSeconds: 60 });
  const r = await env.finish(p, { play: { stopAt: 3000, endReason: 'empty', idleSlots: { 0: 2700 } }, noAdvance: true });
  assert.equal(r.entry.outcome.reason, 'verification_failed:impossible_length');
});

test('points come from verified minutes: inflated stats earn nothing extra', async () => {
  const env = await setup();
  const honest = await env.finish(await env.place([human('a')]));
  const pts = honest.entry.ledger.points;
  assert.ok(pts > 0);
  const inflated = await env.finish(await env.place([human('b')]), {
    stats: { ticks: 1e6, durationMs: 1e9, tickLagP99Ms: 0, egressBytes: 0, slots: Array.from({ length: 8 }, () => ({ slot: 0, received: 0, dropped: 0, underruns: 0, overruns: 0, connectedMs: 1e9 })) },
  });
  const e = inflated.entry.ledger;
  const verifiedMinutes = inflated.end.tick / 120 / 60;
  assert.ok(e.playerMinutes <= verifiedMinutes + 0.01, `${e.playerMinutes} min for a ${verifiedMinutes.toFixed(2)} min match`);
  assert.equal(e.players.length, 1, 'duplicate slots count once');
  assert.ok(e.quality <= 1, 'self-reported lag gives no bonus');
  assert.ok(e.points <= pts * 1.5 + 0.01, `inflated ${e.points} vs honest ${pts}`);
});

test('a community node cannot frame players with no-shows, nor cancel a ranked match late', async () => {
  const env = await setup({ status: 'active' });
  // A no-show before the join window closed is impossible for an honest node: lost, a strike.
  const p0 = await env.place([human('x'), human('y')], { ranked: true });
  await env.send({ t: 'report', id: 'c0', report: { kind: 'cancelled', matchId: p0.matchId, reason: 'no_show', noShows: ['y'.repeat(16)] } });
  assert.equal(env.cp.matches.get(p0.matchId).outcome.reason, 'lost:early_cancel');
  assert.deepEqual(env.cp.matches.get(p0.matchId).outcome.noShows, []);
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 1);
  // At the join deadline: void, but a wss node gives no evidence, so nobody gets an abandon.
  const p = await env.place([human('a'), human('b')], { ranked: true });
  env.advance(46_000);
  await env.send({ t: 'report', id: 'c1', report: { kind: 'cancelled', matchId: p.matchId, reason: 'no_show', noShows: ['b'.repeat(16)] } });
  const c1 = env.cp.matches.get(p.matchId);
  assert.equal(c1.outcome.reason, 'no_show');
  assert.deepEqual(c1.outcome.noShows, [], 'wss: the control plane saw nothing');
  // Long after the join window the match must have started: lost, a strike.
  const p2 = await env.place([human('c'), human('d')], { ranked: true });
  env.advance(120_000);
  await env.send({ t: 'report', id: 'c2', report: { kind: 'cancelled', matchId: p2.matchId, reason: 'no_show', noShows: ['d'.repeat(16)] } });
  const c2 = env.cp.matches.get(p2.matchId);
  assert.equal(c2.outcome.reason, 'lost:late_cancel');
  assert.deepEqual(c2.outcome.noShows, []);
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 2);
  // A dodge needs the player's own leave, relayed here; a client that never got in is not a dodger.
  const p3 = await env.place([human('e'), human('f')], { ranked: true });
  await env.send({ t: 'report', id: 'c3', report: { kind: 'cancelled', matchId: p3.matchId, reason: 'dodge', noShows: ['f'.repeat(16)] } });
  assert.equal(env.cp.matches.get(p3.matchId).outcome.reason, 'lost:unproven_cancel');
  const p4 = await env.place([human('g'), human('h')], { ranked: true });
  await env.cp.leave(p4.matchId, 'h'.repeat(16));
  await env.send({ t: 'report', id: 'c4', report: { kind: 'cancelled', matchId: p4.matchId, reason: 'dodge', noShows: ['h'.repeat(16)] } });
  assert.deepEqual(env.cp.matches.get(p4.matchId).outcome.noShows, ['h'.repeat(16)]);
  const p5 = await env.place([human('i'), human('j')], { ranked: true });
  await env.cp.leave(p5.matchId, 'j'.repeat(16), { connected: false });
  await env.send({ t: 'report', id: 'c5', report: { kind: 'cancelled', matchId: p5.matchId, reason: 'dodge', noShows: ['j'.repeat(16)] } });
  assert.deepEqual(env.cp.matches.get(p5.matchId).outcome.noShows, [], 'a cancel while connecting');
  // A project node is trusted with its no-show list.
  const t = await setup({ trusted: true });
  await wait(() => t.registry.node(t.nodeId).status === 'active');
  const pt = await t.place([human('e'), human('f')], { ranked: true });
  await t.send({ t: 'report', id: 'ct', report: { kind: 'cancelled', matchId: pt.matchId, reason: 'no_show', noShows: ['f'.repeat(16)] } });
  assert.deepEqual(t.cp.matches.get(pt.matchId).outcome.noShows, ['f'.repeat(16)]);
});

test('malformed messages are refused without throwing or corrupting the registry', async () => {
  const env = await setup();
  const anon = { closes: [] };
  const s = env.cp.open({ send() {}, close: (code) => anon.closes.push(code) });
  await env.cp.onMessage(s, 'null');
  await env.cp.onMessage(s, '{"t":5}');
  assert.deepEqual(anon.closes, [1008, 1008]);
  const before = env.registry.node(env.nodeId).build;
  await env.send({ t: 'hello', data: { build: null } });
  await env.send({ t: 'heartbeat', data: null });
  await env.send({ t: 'heartbeat', data: { active: -1000, capacity: 4, draining: false, egressGB: 0, egressCapGB: null, tickLagP99Ms: 0, cpuLoad: 0, rssMB: 1, matches: [] } });
  assert.deepEqual(env.closes.map((c) => c.code), [1008, 1008, 1008]);
  assert.deepEqual(env.registry.node(env.nodeId).build, before);
  assert.equal(env.registry.node(env.nodeId).active, 0);
  // A report without result / stats for a real match: settled as lost, a strike.
  const p = await env.place([human('a')]);
  await env.send({ t: 'report', id: 'x', report: { kind: 'ended', matchId: p.matchId } });
  assert.equal(env.cp.matches.get(p.matchId).outcome.reason, 'lost:bad_report');
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 1);
});

test('a second report never re-opens a settled match', async () => {
  const env = await setup();
  const p = await env.place([human('a')]);
  const a = env.cp.matches.get(p.matchId).assign;
  const m = await playRecordedMatch({ roster: a.roster, seed: a.kickoffSeed, matchId: a.matchId, nodeId: env.nodeId, lengthSeconds: 10, stopAt: 1500, endReason: 'empty', idleSlots: { 0: 1300 } });
  env.advance(14_000);
  const sha = await sha256Hex(m.bytes);
  const ts = env.now();
  await env.cp.storeReplay(a.matchId, env.nodeId, ts, await sign(env.nodeKey, replayRequestMessage('PUT', a.matchId, sha, ts)), sha, m.bytes);
  const stats = { ticks: m.end.tick, durationMs: 1000, slots: [{ slot: 0, received: 1, dropped: 0, underruns: 0, overruns: 0, connectedMs: 1000 }], tickLagP99Ms: 1, egressBytes: 1 };
  const ended = env.send({ t: 'report', id: 'e', report: { kind: 'ended', matchId: a.matchId, result: { winner: m.end.winner, blue: m.end.blue, red: m.end.red, endTick: m.end.tick, endReason: m.end.reason }, replaySha256: sha, replayBytes: m.bytes.length, stats } });
  const cancelled = env.send({ t: 'report', id: 'c', report: { kind: 'cancelled', matchId: a.matchId, reason: 'no_show', noShows: [] } });
  await Promise.all([ended, cancelled]);
  await wait(() => env.cp.matches.get(a.matchId).state === 'done');
  await sleep(50);
  const mine = env.outcomes.filter((o) => o.matchId === a.matchId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].kind, 'unrated');
});

test('takeovers need a leave the control plane relayed', async () => {
  const env = await setup();
  const three = [human('a'), human('b'), human('c')]; // 2v2: a + c blue, b red, a red bot
  const p = await env.place(three, { mode: '2v2', matchLengthSeconds: 15 });
  const r1 = await env.finish(p, { play: { takeovers: [{ tick: 900, slot: 1 }] } });
  assert.equal(r1.entry.outcome.reason, 'verification_failed:bad_takeover', 'nobody asked to leave');
  const env2 = await setup();
  const p2 = await env2.place(three, { mode: '2v2', matchLengthSeconds: 15 });
  env2.advance(8_000); // the takeover lands at tick 900 (7.5 s)
  await env2.cp.leave(p2.matchId, 'c'.repeat(16));
  const r2 = await env2.finish(p2, { play: { takeovers: [{ tick: 900, slot: 1 }] } });
  assert.equal(r2.entry.verdict.code, 'ok', r2.entry.verdict.message);
  assert.equal(r2.entry.outcome.kind, 'unrated');
});

test('a node whose socket closed loses its matches after the heartbeat timeout, with one strike', async () => {
  const env = await setup();
  const ps = [];
  for (const c of ['a', 'b', 'c']) ps.push(await env.place([human(c)]));
  env.cp.onClose(env.session);
  env.advance(5_000);
  env.cp.sweep();
  assert.equal(env.cp.matches.get(ps[0].matchId).state, 'assigned', 'a quick reconnect keeps them');
  env.advance(11_000);
  env.cp.sweep();
  for (const p of ps) assert.equal(env.cp.matches.get(p.matchId).outcome.reason, 'node_offline');
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 1, 'one outage, one strike');
  assert.equal(await env.cp.rejoinTicket(ps[0].matchId, 'a'.repeat(16)), null);
});

test('a restarted node (new bootId) loses the matches of its old process', async () => {
  const env = await setup();
  const p = await env.place([human('a')]);
  await env.hello(); // same process re-hello: nothing happens
  assert.equal(env.cp.matches.get(p.matchId).state, 'assigned');
  env.boot = 'boot-2';
  await env.hello();
  assert.equal(env.cp.matches.get(p.matchId).outcome.reason, 'node_restarted');
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 1);
});

test('a verifier-side failure is retried; a build lie found on the right build is the host’s fault', async () => {
  let calls = 0;
  const env = await setup({
    verify: async (bytes, job, real) => (++calls === 1 ? { ok: false, code: 'error', message: 'boom', ticks: 0, score: { blue: 0, red: 0 }, winner: -1, finalHash: 0, cpuMs: 0 } : real(bytes, job)),
  });
  const p = await env.place([human('a')]);
  const r = await env.finish(p, { waitDone: false });
  await wait(() => calls === 1);
  await sleep(20);
  assert.equal(r.entry.state, 'verifying', 'still queued, nobody blamed');
  assert.equal(env.registry.node(env.nodeId).status, 'probation');
  env.advance(16_000);
  env.cp.sweep();
  await wait(() => env.cp.matches.get(p.matchId).state === 'done');
  assert.equal(env.cp.matches.get(p.matchId).outcome.kind, 'unrated');

  const liar = await setup({ verify: async () => ({ ok: false, code: 'build_mismatch', message: 'x', ticks: 0, score: { blue: 0, red: 0 }, winner: -1, finalHash: 0, cpuMs: 0 }) });
  const q = await liar.finish(await liar.place([human('b')]));
  assert.equal(q.entry.outcome.reason, 'verification_failed:build_mismatch');
  assert.equal(liar.registry.node(liar.nodeId).status, 'suspended');
});

test('a failed verification replaces a strike pause with manual review; project nodes are never paused', async () => {
  const reg = new Registry();
  const build = await testBuild();
  const keys = await generateEd25519();
  const { token } = await reg.createToken({ id: 'op', name: 'Op' }, 'SA', 0);
  const n = (await reg.register({ token, publicKey: keys.publicKey, roles: ['host'], publicUrl: 'wss://203.0.113.1', build, specs: SPECS, capacity: CAP }, 0)).node;
  reg.markReachable(n.nodeId, 0);
  for (let i = 1; i <= 3; i++) reg.onLost(n.nodeId, 'crash', i);
  assert.equal(n.status, 'suspended');
  assert.ok(n.suspendedUntil !== null);
  assert.equal(reg.onVerified(n.nodeId, true, false), 'suspended');
  assert.equal(n.statusReason, 'verification_failed');
  assert.equal(n.suspendedUntil, null);
  reg.sweep(STRIKE_COOLDOWN_MS + 10);
  assert.equal(n.status, 'suspended', 'the cooldown no longer lifts it');

  const t = new Registry({ trustedOperators: ['proj'], log: () => undefined });
  const k2 = await generateEd25519();
  const tok = await t.createToken({ id: 'proj', name: 'Proyecto' }, 'SA', 0);
  const v = (await t.register({ token: tok.token, publicKey: k2.publicKey, roles: ['host', 'verify'], publicUrl: 'wss://203.0.113.2', build, specs: SPECS, capacity: CAP }, 0)).node;
  t.markReachable(v.nodeId, 0);
  assert.equal(v.status, 'active');
  assert.equal(t.onVerified(v.nodeId, true, false), null);
  assert.equal(v.status, 'active', 'a determinism bug on the project node raises an alert, not a pause');
});

test('the scheduler balances on the control plane’s own count and the region factor includes this match', async () => {
  const env = await setup();
  const first = await env.place([human('a')]);
  assert.equal(env.cp.matches.get(first.matchId).regionFactor, 0.75, '1 match / 4 slots');
  for (const c of ['b', 'c', 'd']) await env.place([human(c)]);
  await env.heartbeat({ active: 0 }); // the node claims to be idle
  const fifth = await env.cp.place({ mode: '1v1', region: 'SA', ranked: false, humans: [human('e')], matchLengthSeconds: 10 });
  assert.equal(fifth, null, 'full by the control plane’s count');
  assert.ok(env.cp.regionFactorAt('SA') > 1.5, 'unmet demand raises the factor');
});

test('an rtc node can only blame players who never even sent an offer, and only at the deadline', async () => {
  const env = await setup({ status: 'active', rtc: true });
  const A = 'a'.repeat(16);
  const B = 'b'.repeat(16);
  const p = await env.place([human('a'), human('b')], { ranked: true });
  assert.equal(p.transport, 'rtc');
  await env.send({ t: 'report', id: 'r1', report: { kind: 'cancelled', matchId: p.matchId, reason: 'no_show', noShows: [A, B] } });
  assert.equal(env.cp.matches.get(p.matchId).outcome.reason, 'lost:early_cancel', 'right after the assignment: impossible');
  assert.deepEqual(env.cp.matches.get(p.matchId).outcome.noShows, []);
  const q = await env.place([human('a'), human('b')], { ranked: true });
  env.advance(46_000);
  await env.send({ t: 'report', id: 'r2', report: { kind: 'cancelled', matchId: q.matchId, reason: 'no_show', noShows: [A, B] } });
  assert.deepEqual(env.cp.matches.get(q.matchId).outcome.noShows, [], 'nobody got through: nobody is blamed (MatchDO)');
  const r = await env.place([human('a'), human('b')], { ranked: true });
  env.cp.matches.get(r.matchId).offered.add(A); // A's offer went through the control plane
  env.advance(46_000);
  await env.send({ t: 'report', id: 'r3', report: { kind: 'cancelled', matchId: r.matchId, reason: 'no_show', noShows: [A, B] } });
  assert.deepEqual(env.cp.matches.get(r.matchId).outcome.noShows, [B]);
});

test('a copy of a report still being processed is not acked; lost reports of one outage are one strike', async () => {
  const env = await setup({ getDelay: 100 });
  const p = await env.place([human('a')]);
  const a = env.cp.matches.get(p.matchId).assign;
  const m = await playRecordedMatch({ roster: a.roster, seed: a.kickoffSeed, matchId: a.matchId, nodeId: env.nodeId, lengthSeconds: 10, stopAt: 1500, endReason: 'empty', idleSlots: { 0: 1300 } });
  env.advance(14_000);
  const sha = await sha256Hex(m.bytes);
  const ts = env.now();
  await env.cp.storeReplay(a.matchId, env.nodeId, ts, await sign(env.nodeKey, replayRequestMessage('PUT', a.matchId, sha, ts)), sha, m.bytes);
  const stats = { ticks: m.end.tick, durationMs: 1000, slots: [{ slot: 0, received: 1, dropped: 0, underruns: 0, overruns: 0, connectedMs: 1000 }], tickLagP99Ms: 1, egressBytes: 1 };
  const report = { kind: 'ended', matchId: a.matchId, result: { winner: m.end.winner, blue: m.end.blue, red: m.end.red, endTick: m.end.tick, endReason: m.end.reason }, replaySha256: sha, replayBytes: m.bytes.length, stats };
  const acksBefore = env.toNode.filter((x) => x.t === 'ack').length;
  const first = env.send({ t: 'report', id: 'dup', report });
  await sleep(10);
  await env.send({ t: 'report', id: 'dup', report });
  assert.equal(env.toNode.filter((x) => x.t === 'ack').length, acksBefore, 'the copy is not acked while the first is in flight');
  await first;
  assert.equal(env.toNode.filter((x) => x.t === 'ack').length, acksBefore + 1);
  // A stop-now with three running matches: three 'lost' reports, one strike.
  const ps = [];
  for (const c of ['b', 'c', 'd']) ps.push(await env.place([human(c)]));
  for (const x of ps) await env.send({ t: 'report', id: 'l' + x.matchId, report: { kind: 'lost', matchId: x.matchId, reason: 'node_shutdown' } });
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 1);
});

test('a second strike pause within 30 days sends an active node back to probation', async () => {
  const reg = new Registry();
  const build = await testBuild();
  const keys = await generateEd25519();
  const { token } = await reg.createToken({ id: 'op', name: 'Op' }, 'SA', 0);
  const n = (await reg.register({ token, publicKey: keys.publicKey, roles: ['host'], publicUrl: 'wss://203.0.113.1', build, specs: SPECS, capacity: CAP }, 0)).node;
  reg.markReachable(n.nodeId, 0);
  reg.setStatus(n.nodeId, 'active', null);
  const DAY = 24 * 60 * 60 * 1000;
  for (let i = 1; i <= 3; i++) reg.onLost(n.nodeId, 'crash', i);
  reg.sweep(DAY + 10);
  assert.equal(n.status, 'active', 'the first pause lifts back to active');
  assert.equal(n.counters.strikes, 3, 'the strikes keep their 7-day window');
  reg.onLost(n.nodeId, 'crash', DAY + 20);
  assert.equal(n.status, 'suspended', 'another strike that week pauses it again');
  reg.sweep(2 * DAY + 30);
  assert.equal(n.status, 'probation', 'a repeated pause demotes the node');
  for (let i = 0; i < PROBATION_MATCHES - 1; i++) reg.onVerified(n.nodeId, false, true);
  assert.equal(n.status, 'probation');
  reg.onVerified(n.nodeId, false, true);
  assert.equal(n.status, 'active', 'twenty fresh verified matches promote it again');
});

test('unmet demand only counts when the region’s nodes were out for load', async () => {
  const env = await setup();
  // An old client (wss only) is not unmet demand for... a wss node: it is placed. A transport
  // nobody in the region offers is not the nodes' fault.
  const rtcOnly = await env.cp.place({ mode: '1v1', region: 'SA', ranked: false, humans: [human('a')], matchLengthSeconds: 10, transports: ['rtc'] });
  assert.equal(rtcOnly, null);
  // The operator playing ranked on their own node: not demand either.
  env.registry.setStatus(env.nodeId, 'active', null);
  const own = await env.cp.place({ mode: '1v1', region: 'SA', ranked: true, humans: [{ playerId: 'op1', name: 'Op' }], matchLengthSeconds: 10 });
  assert.equal(own, null);
  assert.equal(env.cp.regionFactorAt('SA'), 0.75, 'nothing counted: 1 / 4');
});

test('every ranked match is verified; casual ones by sample: all on probation, the rate once active, none on project nodes', async () => {
  // Active node, nothing sampled: a casual match settles on the node's word, earns nothing.
  const env = await setup({ status: 'active', casualVerifyRate: 0 });
  const verifiedBefore = env.registry.node(env.nodeId).counters.verified;
  const c = await env.finish(await env.place([human('a')]));
  assert.equal(c.entry.outcome.kind, 'unrated');
  assert.equal(c.entry.outcome.verified, false);
  assert.equal(c.entry.verdict, null, 'not re-simulated');
  assert.equal(c.entry.ledger, null, 'no points without verification');
  assert.equal(env.registry.node(env.nodeId).counters.verified, verifiedBefore);
  // The same node, a ranked match: always verified.
  const p = await env.place([human('b'), human('c')], { ranked: true });
  env.advance(6_000);
  await env.cp.leave(p.matchId, 'c'.repeat(16));
  const r = await env.finish(p, { play: { stopAt: 700, endReason: 'forfeit', forfeitTeam: 1 }, mutate: leaveAtEnd(1) });
  assert.equal(r.entry.verdict.code, 'ok');
  assert.equal(r.entry.outcome.kind, 'rated');
  // On probation every casual match is verified (they are the node's way into ranked), whatever the rate.
  const pro = await setup({ casualVerifyRate: 0 });
  const pc = await pro.finish(await pro.place([human('d')]));
  assert.equal(pc.entry.verdict.code, 'ok');
  assert.equal(pc.entry.outcome.verified, true);
  assert.equal(pc.entry.ledger.sampleRate, 1);
  // A project node: casual matches are not verified (it earns nothing and is trusted).
  const t = await setup({ trusted: true, casualVerifyRate: 1 });
  await wait(() => t.registry.node(t.nodeId).status === 'active');
  const tc = await t.finish(await t.place([human('e')]));
  assert.equal(tc.entry.outcome.verified, false);
  // Active node, everything sampled: verified, points at weight 1.
  const all = await setup({ status: 'active', casualVerifyRate: 1 });
  const ac = await all.finish(await all.place([human('f')]));
  assert.equal(ac.entry.verdict.code, 'ok');
  assert.equal(ac.entry.ledger.sampleRate, 1);
});

test('a sampled casual match is worth 1 / rate, so an operator earns the same on average', () => {
  const L = new Ledger();
  const base = { nodeId: 'n', operatorId: 'op', region: 'SA', mode: '1v1', ranked: false, verified: true, endReason: 'rules', tickLagP99Ms: 2, underrunRate: 0 };
  const three = 3 * 60_000;
  const full = L.record({ ...base, matchId: 'm1', at: 1, players: [{ playerId: 'p1', connectedMs: three, account: true, accountAgeDays: 30 }] }, 1);
  const sampled = L.record({ ...base, matchId: 'm2', at: 2, sampleRate: 0.25, players: [{ playerId: 'p2', connectedMs: three, account: true, accountAgeDays: 30 }] }, 1);
  assert.equal(full.points, 3);
  assert.equal(sampled.points, 12);
});

test('match ids have 64 hex characters, like a MatchDO id', async () => {
  const env = await setup();
  const p = await env.place([human('a')]);
  assert.match(p.matchId, /^[0-9a-f]{64}$/);
});

test('a match that must be verified only goes to a node some verifier can re-simulate', async () => {
  // No in-process verifier (production) and no trusted verifier yet.
  const env = await setup({ status: 'active', noInline: true });
  assert.equal(await env.cp.place({ mode: '1v1', region: 'SA', ranked: true, humans: [human('a'), human('b')], matchLengthSeconds: 10 }), null, 'ranked: nobody could verify it');
  // Casual on an active node is only sampled: it may go there.
  assert.ok(await env.cp.place({ mode: '1v1', region: 'SA', ranked: false, humans: [human('c')], matchLengthSeconds: 10 }));
  // A project verifier on another release does not help; one on the node's release does.
  env.registry.addTrustedOperator('project');
  const keys = await generateEd25519();
  const { token } = await env.registry.createToken({ id: 'project', name: 'Proyecto' }, 'SA', env.now());
  const vr = await env.registry.register({ token, publicKey: keys.publicKey, roles: ['verify'], publicUrl: null, build: { ...env.build, version: '9.9.9' }, specs: SPECS, capacity: CAP }, env.now());
  assert.ok(vr.ok, JSON.stringify(vr));
  Object.assign(vr.node, { online: true, lastSeen: env.now() });
  assert.equal(await env.cp.place({ mode: '1v1', region: 'SA', ranked: true, humans: [human('d'), human('e')], matchLengthSeconds: 10 }), null, 'another release');
  vr.node.build = { ...env.build };
  assert.ok(await env.cp.place({ mode: '1v1', region: 'SA', ranked: true, humans: [human('f'), human('g')], matchLengthSeconds: 10 }), 'same release: placed');
  // A node on probation: every match is verified, so it needs a verifier too.
  const pro = await setup({ noInline: true });
  assert.equal(await pro.cp.place({ mode: '1v1', region: 'SA', ranked: false, humans: [human('h')], matchLengthSeconds: 10 }), null);
});

test('an unsampled casual match still needs its replay, and still counts for the repeat decay', async () => {
  const env = await setup({ status: 'active', casualVerifyRate: 0 });
  // No upload at all: struck and void, sampled or not.
  const p = await env.place([human('a')]);
  const stats = { ticks: 1200, durationMs: 10_000, slots: [{ slot: 0, received: 1, dropped: 0, underruns: 0, overruns: 0, connectedMs: 10_000 }], tickLagP99Ms: 1, egressBytes: 1 };
  env.advance(12_000);
  await env.send({ t: 'report', id: 'x', report: { kind: 'ended', matchId: p.matchId, result: { winner: -1, blue: 0, red: 0, endTick: 1200, endReason: 'rules' }, replaySha256: 'a'.repeat(64), replayBytes: 10, stats } });
  assert.equal(env.cp.matches.get(p.matchId).outcome.reason, 'no_replay');
  assert.equal(env.registry.node(env.nodeId).counters.strikes, 1);
  // With its replay: settles unverified, and the group's repeat history grows anyway.
  const q = await env.finish(await env.place([human('b')]));
  assert.equal(q.entry.outcome.verified, false);
  const L = env.cp.ledger;
  const later = L.record({ matchId: 'z', nodeId: env.nodeId, operatorId: 'op1', region: 'SA', mode: '1v1', ranked: false, verified: true, endReason: 'rules', tickLagP99Ms: 1, underrunRate: 0, at: env.now(), sampleRate: 0.2, players: [{ playerId: 'b'.repeat(16), connectedMs: 60_000, account: true, accountAgeDays: 30 }] }, 1);
  assert.equal(later.repeat, 0.5, 'the unsampled match of the same group counted');
});

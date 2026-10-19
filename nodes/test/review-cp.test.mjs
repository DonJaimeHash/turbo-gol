// Review fixes in the control plane, against a fake node (no sockets) and a controllable clock:
// the outcome comes from the verdict, points from verified minutes, no-shows and cancels are not
// taken on a community node's word, malformed messages never throw, leaves after the whistle are
// refused, dead or restarted nodes lose their matches (one strike per outage), verifier-side
// failures are retried, and a failed verification always means manual review. Also the API the
// Worker calls: rejoin reasons, the lock check, the hosts count, leaves and channel changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playRecordedMatch, testBuild } from './helpers.mjs';
import { CAP, SPECS, URL_, human, leaveAtEnd, setup, sleep, wait } from './fakeNode.mjs';

const { MAX_UNAUTHENTICATED, REPROBE_FAILURES, REPROBE_MS, TRUSTED_OFFLINE_MS } = await import('../control-plane/controlPlane.ts');
const { Registry, STRIKE_COOLDOWN_MS, PROBATION_MATCHES, usableTransports } = await import('../control-plane/registry.ts');
const { Ledger } = await import('../control-plane/ledger.ts');
const { generateEd25519, sign, sha256Hex } = await import('../shared/edcrypto.ts');
const { replayRequestMessage } = await import('../shared/controlProtocol.ts');
const { parseReport } = await import('../control-plane/validate.ts');

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

test('on a project node a ranked player with no socket at the whistle is a leaver; a community node’s word on it decides nothing', async () => {
  const stats = (gone) => ({
    ticks: 700,
    durationMs: 6_000,
    tickLagP99Ms: 1,
    egressBytes: 1,
    slots: [0, 1].map((slot) => ({ slot, received: 700, dropped: 0, underruns: 0, overruns: 0, connectedMs: 6_000, connectedAtEnd: slot !== gone })),
  });
  /** A ranked forfeit (B quits), with slot `gone` disconnected at the whistle: who is rated as a leaver. */
  const leavers = async (env, gone) => {
    const p = await env.place([human('a'), human('b')], { ranked: true });
    env.advance(6_000);
    await env.cp.leave(p.matchId, 'b'.repeat(16));
    const { entry } = await env.finish(p, { play: { stopAt: 700, endReason: 'forfeit', forfeitTeam: 1 }, mutate: leaveAtEnd(1), stats: stats(gone) });
    assert.equal(entry.outcome.kind, 'rated', JSON.stringify(entry.outcome));
    return entry.outcome.players.map((x) => x.left);
  };
  const project = await setup({ trusted: true });
  await wait(() => project.registry.node(project.nodeId).status === 'active');
  assert.deepEqual(await leavers(project, 0), [true, true], 'A closed the tab: a leaver, like on MatchDO');
  assert.deepEqual(await leavers(project, -1), [false, true]);
  const community = await setup({ status: 'active' });
  assert.deepEqual(await leavers(community, 0), [false, true], 'only the leave the control plane relayed');
});

test('connectedAtEnd: absent reads as connected (nodes before 0.2.0); anything but a boolean is a bad report', () => {
  const report = (slot) => ({
    kind: 'ended',
    matchId: 'm'.repeat(64),
    result: { winner: 0, blue: 1, red: 0, endTick: 100, endReason: 'rules' },
    replaySha256: 'a'.repeat(64),
    replayBytes: 10,
    stats: { ticks: 100, durationMs: 1_000, tickLagP99Ms: 1, egressBytes: 1, slots: [{ slot: 0, received: 100, dropped: 0, underruns: 0, overruns: 0, connectedMs: 1_000, ...slot }] },
  });
  assert.equal(parseReport(report({})).stats.slots[0].connectedAtEnd, true);
  assert.equal(parseReport(report({ connectedAtEnd: false })).stats.slots[0].connectedAtEnd, false);
  assert.equal(parseReport(report({ connectedAtEnd: 'no' })), null);
  assert.equal(parseReport(report({ connectedAtEnd: 0 })), null);
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

test('a trusted node whose control link drops keeps its matches for a minute: the same process reconnecting goes on', async () => {
  const env = await setup({ trusted: true });
  await wait(() => env.registry.node(env.nodeId).status === 'active');
  const p = await env.place([human('a'), human('b')], { ranked: true });
  env.advance(6_000);
  await env.cp.leave(p.matchId, 'b'.repeat(16));
  env.disconnect();
  env.advance(TRUSTED_OFFLINE_MS - 1_000);
  env.cp.sweep();
  assert.equal(env.cp.matches.get(p.matchId).state, 'assigned', 'a community node would have lost it after 15 s');
  await env.reconnect();
  const { entry } = await env.finish(p, { play: { stopAt: 700, endReason: 'forfeit', forfeitTeam: 1 }, mutate: leaveAtEnd(1) });
  assert.equal(entry.outcome.kind, 'rated', JSON.stringify(entry.outcome));
  assert.equal(env.registry.node(env.nodeId).counters.lost, 0);
  // Gone for longer: void, like any node.
  const q = await env.place([human('c'), human('d')], { ranked: true });
  env.disconnect();
  env.advance(TRUSTED_OFFLINE_MS + 1);
  env.cp.sweep();
  assert.equal(env.cp.matches.get(q.matchId).outcome.reason, 'node_offline');
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

test('a replay upload is authenticated before its body is hashed', async () => {
  const env = await setup();
  const p = await env.place([human('a')]);
  const bytes = new Uint8Array(1 << 20);
  const sha = await sha256Hex(bytes);
  const ts = env.now();
  // Every player of the match knows its id and the node's: a forged upload must cost no hashing.
  const subtle = globalThis.crypto.subtle;
  const digest = Object.getPrototypeOf(subtle).digest;
  let hashed = 0;
  subtle.digest = (...args) => {
    hashed++;
    return digest.apply(subtle, args);
  };
  const signed = async (hash) => sign(env.nodeKey, replayRequestMessage('PUT', p.matchId, hash, ts));
  try {
    assert.deepEqual(await env.cp.storeReplay(p.matchId, env.nodeId, ts, 'A'.repeat(86), sha, bytes), { ok: false, status: 401, code: 'bad_sig' });
    assert.equal(hashed, 0, 'refused before hashing');
    // The node's own signature over another hash: hashed once, and refused.
    const other = 'e'.repeat(64);
    const lie = await env.cp.storeReplay(p.matchId, env.nodeId, ts, await signed(other), other, bytes);
    assert.deepEqual(lie, { ok: false, status: 400, code: 'sha_mismatch' });
    assert.equal(hashed, 1);
    // What the Worker asks before it reads a body: the same answers, and null for a good upload.
    assert.deepEqual(await env.cp.replayPutCheck('f'.repeat(64), env.nodeId, ts, await signed(sha), sha), { ok: false, status: 404, code: 'no_match' });
    assert.deepEqual(await env.cp.replayPutCheck(p.matchId, env.nodeId, ts - 6 * 60_000, await signed(sha), sha), { ok: false, status: 401, code: 'stale' });
    assert.deepEqual(await env.cp.replayPutCheck(p.matchId, env.nodeId, ts, 'A'.repeat(86), sha), { ok: false, status: 401, code: 'bad_sig' });
    assert.equal(await env.cp.replayPutCheck(p.matchId, env.nodeId, ts, await signed(sha), sha), null);
    assert.equal(hashed, 1);
  } finally {
    delete subtle.digest;
  }
  assert.deepEqual(await env.cp.storeReplay(p.matchId, env.nodeId, ts, await signed(sha), sha, bytes), { ok: true });
  assert.equal(env.cp.matches.get(p.matchId).replaySha, sha);
  // Once the match is reported, even the node's own signed upload is refused unhashed.
  await env.send({ t: 'report', id: 'lost', report: { kind: 'lost', matchId: p.matchId, reason: 'node_shutdown' } });
  hashed = 0;
  subtle.digest = (...args) => {
    hashed++;
    return digest.apply(subtle, args);
  };
  try {
    assert.deepEqual(await env.cp.storeReplay(p.matchId, env.nodeId, ts, await signed(sha), sha, bytes), { ok: false, status: 409, code: 'already_reported' });
    assert.equal(hashed, 0);
  } finally {
    delete subtle.digest;
  }
});

test('only so many sockets wait to log in: one more closes the oldest, so idle sockets cannot keep a node out', async (t) => {
  const env = await setup();
  const closes = [];
  const opened = [];
  const anon = () => {
    const i = opened.length;
    const s = env.cp.open({ send() {}, close: (code) => closes.push([i, code]) });
    opened.push(s);
    return s;
  };
  const busy = () => closes.filter(([, c]) => c === 1013).map(([i]) => i);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let i = 0; i < MAX_UNAUTHENTICATED; i++) anon();
  assert.deepEqual(closes, []);
  assert.equal(anon().closed, false, 'the newcomer gets its challenge');
  assert.deepEqual(busy(), [0], 'the oldest goes');
  assert.equal(opened[0].closed, true);
  // A socket pushed out gets nowhere, whatever it sends.
  await env.cp.onMessage(opened[0], JSON.stringify({ t: 'auth', nodeId: env.nodeId, sig: 'x' }));
  assert.deepEqual(closes, [[0, 1013]]);
  env.cp.onClose(opened[5]); // one goes away: its place is free
  anon();
  assert.deepEqual(busy(), [0]);
  anon();
  assert.deepEqual(busy(), [0, 1]);
  assert.equal(env.logs.filter((l) => l.endsWith('sockets still to log in: closing the oldest')).length, 1, 'logged once a minute');
  // None of them logs in: each times out and frees its place, even without a close event.
  t.mock.timers.tick(10_000);
  assert.equal(closes.filter(([, c]) => c === 4401).length, MAX_UNAUTHENTICATED);
  t.mock.timers.reset();
  // With the cap full of idle sockets (a deploy, and somebody holding the door), the real node
  // still logs in, and leaves the count once it is in.
  for (let i = 0; i < MAX_UNAUTHENTICATED; i++) anon();
  const idle = opened.length - MAX_UNAUTHENTICATED;
  env.disconnect();
  await env.reconnect();
  assert.equal(env.cp.isOnline(env.nodeId), true);
  assert.deepEqual(busy(), [0, 1, idle], 'it pushed out the oldest idle socket');
  anon();
  assert.deepEqual(busy(), [0, 1, idle], 'the node that logged in no longer counts');
  anon();
  assert.deepEqual(busy(), [0, 1, idle, idle + 1]);
  for (const s of opened) env.cp.onClose(s);
});

// ---- the API the Worker calls -------------------------------------------------------------------

const lostReport = (matchId) => ({ t: 'report', id: 'lost:' + matchId, report: { kind: 'lost', matchId, reason: 'node_shutdown' } });

test('rejoin says why not: no_match, not_in_match, left, match_over, offline', async () => {
  const [A, B, C, D] = ['a', 'b', 'c', 'd'].map((c) => c.repeat(16));
  const env = await setup({ status: 'active' });
  const p = await env.place([human('a'), human('b')], { ranked: true });
  assert.deepEqual(await env.cp.rejoin('f'.repeat(64), A), { ok: false, code: 'no_match' });
  assert.deepEqual(await env.cp.rejoin(p.matchId, C), { ok: false, code: 'not_in_match' });
  const ok = await env.cp.rejoin(p.matchId, A);
  assert.equal(ok.ok, true);
  assert.equal(ok.wsUrl, p.wsUrl);
  assert.equal(typeof ok.ticket, 'string');
  assert.deepEqual(await env.cp.rejoinTicket(p.matchId, A).then((r) => Object.keys(r)), ['ticket', 'wsUrl']);
  await env.cp.leave(p.matchId, B);
  assert.deepEqual(await env.cp.rejoin(p.matchId, B), { ok: false, code: 'left' });
  assert.equal(await env.cp.rejoinTicket(p.matchId, B), null, 'rejoinTicket: null, as before');
  await env.send(lostReport(p.matchId));
  assert.deepEqual(await env.cp.rejoin(p.matchId, A), { ok: false, code: 'match_over' });
  assert.deepEqual(await env.cp.rejoin(p.matchId, B), { ok: false, code: 'left' }, 'a leaver stays a leaver');
  // A wss node checks tickets by itself, so only a missing public URL makes it unreachable.
  const q = await env.place([human('c')]);
  env.disconnect();
  assert.equal((await env.cp.rejoin(q.matchId, C)).ok, true, 'wss: its control link does not matter');
  env.registry.node(env.nodeId).publicUrl = null;
  assert.deepEqual(await env.cp.rejoin(q.matchId, C), { ok: false, code: 'offline' });
  // An rtc node needs its control link for the player's offer.
  const rtc = await setup({ rtc: true, status: 'active' });
  const r = await rtc.place([human('d')]);
  assert.equal((await rtc.cp.rejoin(r.matchId, D)).ok, true);
  rtc.disconnect();
  assert.deepEqual(await rtc.cp.rejoin(r.matchId, D), { ok: false, code: 'offline' });
});

test('matchStatus backs the matchmaker’s lock check; hostsOnline counts the hosts that may take a match', async () => {
  const [A, B, C] = ['a', 'b', 'c'].map((c) => c.repeat(16));
  const env = await setup({ status: 'active' });
  const p = await env.place([human('a'), human('b')], { ranked: true });
  assert.deepEqual(env.cp.matchStatus(p.matchId, A), { state: 'assigned', left: false });
  assert.equal(env.cp.matchStatus(p.matchId, C), null, 'not in it');
  assert.equal(env.cp.matchStatus('f'.repeat(64), A), null, 'unknown');
  await env.cp.leave(p.matchId, B);
  assert.deepEqual(env.cp.matchStatus(p.matchId, B), { state: 'assigned', left: true });
  await env.send(lostReport(p.matchId));
  assert.deepEqual(env.cp.matchStatus(p.matchId, A), { state: 'done', left: false });

  assert.equal(env.cp.hostsOnline('SA'), 1);
  assert.equal(env.cp.hostsOnline('EU'), 0);
  env.registry.setStatus(env.nodeId, 'suspended', 'test');
  assert.equal(env.cp.hostsOnline('SA'), 0, 'suspended: takes nothing');
  env.registry.setStatus(env.nodeId, 'probation', null);
  assert.equal(env.cp.hostsOnline('SA'), 1, 'probation: casual matches');
  env.disconnect();
  assert.equal(env.cp.hostsOnline('SA'), 0);
});

test('a leave is recorded before it is relayed: a failed relay still counts, an offline node records nothing', async () => {
  const [A, B, C, D] = ['a', 'b', 'c', 'd'].map((c) => c.repeat(16));
  const env = await setup({ status: 'active' });
  const p = await env.place([human('a'), human('b')], { ranked: true });
  assert.deepEqual(await env.cp.leave(p.matchId, A), { recorded: true, answer: { slot: 0, closed: true, already: false, ended: false } });
  // The node refuses (its match just ended there): the leave stands, the Worker frees the lock.
  env.leaveAnswers = false;
  assert.deepEqual(await env.cp.leave(p.matchId, B), { recorded: true, answer: null, error: 'match_over' });
  assert.deepEqual(env.cp.matchStatus(p.matchId, B), { state: 'assigned', left: true });
  assert.deepEqual(await env.cp.rejoin(p.matchId, B), { ok: false, code: 'left' });
  assert.equal(env.cp.matches.get(p.matchId).left.has(B), false, 'the node never confirmed it');
  // The node's link drops while the leave is in flight.
  const q = await env.place([human('c'), human('d')], { ranked: true });
  env.leaveAnswers = 'silent';
  const pending = env.cp.leave(q.matchId, D);
  await sleep(5);
  env.disconnect();
  assert.deepEqual(await pending, { recorded: true, answer: null, error: 'disconnected' });
  assert.equal(env.cp.matchStatus(q.matchId, D).left, true);
  // Offline before anything is recorded: an error, and the player may still rejoin.
  await assert.rejects(env.cp.leave(q.matchId, C), (e) => e.code === 'offline');
  assert.deepEqual(env.cp.matchStatus(q.matchId, C), { state: 'assigned', left: false });
  assert.equal((await env.cp.rejoin(q.matchId, C)).ok, true);
});

test('a channel change reaches the connected nodes at once; a project verifier with work on its build waits', async () => {
  const build = await testBuild();
  let channel = { stable: build.version, minimum: '0.0.0' };
  const env = await setup({ channel: () => channel });
  const updates = (e) => e.toNode.filter((m) => m.t === 'update');
  channel = { stable: '0.0.1', minimum: '0.0.1' };
  assert.deepEqual(updates(env), [], 'nothing until the control plane hears of it');
  env.cp.channelChanged();
  assert.deepEqual(updates(env), [{ t: 'update', version: '0.0.1' }]);

  let vch = { stable: build.version, minimum: '0.0.0' };
  const v = await setup({ trusted: true, roles: ['host', 'verify'], channel: () => vch });
  await wait(() => v.registry.node(v.nodeId).status === 'active');
  const p = await v.place([human('a')]);
  vch = { stable: '0.0.1', minimum: '0.0.1' };
  v.cp.channelChanged();
  assert.deepEqual(updates(v), [], 'a match on its build may still need it');
  assert.ok(v.logs.some((l) => /^update of verifier .* deferred/.test(l)));
  await v.send(lostReport(p.matchId));
  v.cp.sweep();
  assert.deepEqual(updates(v), [{ t: 'update', version: '0.0.1' }], 'once the work is done');
});

test('a missing or invalid release channel never breaks a hello: the last good one, or 0.0.0, and one ALERT', async () => {
  const build = await testBuild();
  let channel; // no channel.json in R2 yet
  const env = await setup({
    channel: () => {
      if (channel instanceof Error) throw channel;
      return channel;
    },
  });
  const welcomes = () => env.toNode.filter((m) => m.t === 'welcome').map((m) => m.channel);
  const alerts = () => env.logs.filter((l) => l.startsWith('ALERT release channel'));
  assert.deepEqual(welcomes(), [{ stable: '0.0.0', minimum: '0.0.0' }]);
  assert.deepEqual(alerts(), ['ALERT release channel missing or invalid (undefined): holding the nodes to stable 0.0.0, minimum 0.0.0']);
  assert.equal(env.registry.node(env.nodeId).online, true, 'the hello went through');

  channel = { stable: build.version, minimum: '0.0.0', note: 'x'.repeat(5000) };
  env.disconnect();
  await env.reconnect();
  assert.deepEqual(welcomes().at(-1), { stable: build.version, minimum: '0.0.0' }, 'only the known fields');

  channel = { stable: 5, minimum: '1.0.0' }; // a bad upload
  env.disconnect();
  await env.reconnect();
  assert.deepEqual(welcomes().at(-1), { stable: build.version, minimum: '0.0.0' }, 'the last good one');
  assert.equal(alerts().length, 2);
  assert.match(alerts()[1], /\(\{"stable":5,"minimum":"1\.0\.0"\}\): holding the nodes to stable 0\.0\.0-test, minimum 0\.0\.0$/);
  channel = new Error('R2 unavailable');
  env.cp.channelChanged();
  env.disconnect();
  await env.reconnect();
  assert.equal(alerts().length, 2, 'one ALERT per bad stretch');
  assert.deepEqual(env.toNode.filter((m) => m.t === 'update'), []);
});

test('a proven host is probed again every 5 minutes: three failures in a row take its wss out with an ALERT, a passing probe brings it back', async () => {
  const env = await setup({ status: 'active' });
  const n = env.registry.node(env.nodeId);
  // The checks the sweep starts, to wait for them.
  const started = [];
  for (const k of ['probe', 'reprobe']) {
    const real = env.cp[k].bind(env.cp);
    env.cp[k] = (id) => {
      const p = real(id);
      started.push(p);
      return p;
    };
  }
  /** One sweep `ms` later, with the host answering or not: it must check the host. */
  const sweepAfter = async (ms, fails) => {
    env.probeFails = fails ? 'fetch failed' : null;
    env.advance(ms);
    const before = started.length;
    env.cp.sweep();
    assert.equal(started.length, before + 1, 'the sweep checked the host');
    await started.at(-1);
  };
  env.advance(REPROBE_MS - 1_000);
  env.cp.sweep();
  assert.equal(started.length, 0, 'not before 5 minutes');
  await sweepAfter(1_000, false);
  assert.notEqual(n.reachableAt, null);

  // Caddy dies, or its certificate expires: retried every 30 s once it failed.
  await sweepAfter(REPROBE_MS, true);
  await sweepAfter(30_000, true);
  assert.notEqual(n.reachableAt, null, 'two failures: still placed');
  await sweepAfter(30_000, true);
  assert.equal(n.reachableAt, null);
  assert.equal(n.status, 'active', 'only the transport goes');
  assert.deepEqual(usableTransports(n), []);
  assert.deepEqual(
    env.logs.filter((l) => l.startsWith(`probe ${n.name} failed (`)),
    [1, 2, 3].map((i) => `probe ${n.name} failed (${i} of ${REPROBE_FAILURES}): Error: fetch failed`),
  );
  assert.ok(env.logs.includes(`ALERT node ${n.name} unreachable at ${URL_}: Error: fetch failed`));
  assert.equal(await env.cp.place({ mode: '1v1', region: 'SA', ranked: false, humans: [human('a')], matchLengthSeconds: 10 }), null, 'no placement on it');

  // Fixed: the unproven-host probe (every 30 s) passes.
  await sweepAfter(30_000, true); // still down: no new ALERT
  await sweepAfter(30_000, false);
  assert.notEqual(n.reachableAt, null);
  assert.ok(env.logs.includes(`node ${n.name} reachable again at ${URL_}`));
  assert.equal(env.logs.filter((l) => l.startsWith('ALERT node')).length, 1);
  assert.ok(await env.place([human('b')]));

  // Failures must come in a row: a pass in between starts the count again.
  await sweepAfter(REPROBE_MS, true);
  await sweepAfter(30_000, false);
  await sweepAfter(REPROBE_MS, true);
  await sweepAfter(30_000, true);
  assert.notEqual(n.reachableAt, null);
});

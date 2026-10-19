// End to end on loopback: the reference control plane, one community node (NodeRuntime) and scripted
// players speaking the real protocol. Registration with a one-time token, reachability probe,
// casual and ranked placement, EdDSA tickets, leaves, forfeit, replay upload, verification,
// rating outcome and reward points.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, testBuild } from './helpers.mjs';
import { connectPlayer, freePort, waitFor } from './player.mjs';

const { startControlPlane } = await import('../control-plane/devServer.ts');
const { NodeRuntime } = await import('../node/runtime.ts');
const { registerNode } = await import('../node/register.ts');
const { nodeSpecs } = await import('../node/bench.ts');

async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

async function outcomeOf(base, matchId) {
  return waitFor(async () => {
    const b = await (await fetch(`${base}/dev/outcome/${matchId}`)).json();
    return b.state === 'done' ? b : null;
  }, 30_000);
}

const CAPACITY = { matches: 4, cpuMsPerMatchSecond: 0, memMBPerMatch: 0, uplinkMbps: null, source: 'declared' };
const QUICK = { kickoffCountdownSeconds: 1, goalPauseSeconds: 1 };

test('a community node hosts casual and ranked matches; results are verified before anything is written', async () => {
  const cp = await startControlPlane({ port: 0, log: () => undefined, sweepMs: 500 });
  const nodePort = await freePort();
  let rt = null;
  try {
    // Operator signs in and asks for a one-time token.
    const op = (await post(`${cp.url}/dev/login`, { name: 'Juan' })).body.operatorId;
    const tok = await post(`${cp.url}/nodes/tokens`, { region: 'SA', name: 'cordoba-1' }, { 'x-dev-operator': op });
    assert.equal(tok.status, 200);
    assert.match(tok.body.token, /^tgn1_/);
    assert.match(tok.body.install.linux, /--token tgn1_/);
    assert.match(tok.body.install.windows, /-Token tgn1_/);

    // The node registers with it (key generated locally) and the token is burned.
    const build = await testBuild();
    const reg = { control: cp.url, token: tok.body.token, roles: ['host'], publicUrl: `ws://127.0.0.1:${nodePort}`, name: 'cordoba-1', build, specs: nodeSpecs(), capacity: CAPACITY };
    const identity = await registerNode(reg);
    assert.equal(identity.region, 'SA');
    await assert.rejects(registerNode(reg), /bad_token/);

    rt = new NodeRuntime({
      identity,
      build,
      specs: nodeSpecs(),
      capacity: CAPACITY,
      listenPort: nodePort,
      listenHost: '127.0.0.1',
      heartbeatMs: 300,
      log: () => undefined,
      timings: { startGraceMs: 300, endLingerMs: 100, emptyShutdownMs: 2_000 },
    });
    await rt.start();
    // Login over the control socket, then the reachability probe: pending -> probation.
    await waitFor(() => cp.cp.registry.node(identity.nodeId)?.status === 'probation', 10_000);
    assert.equal(rt.status, 'probation');

    // ---- casual: 1 human + 1 bot, the human quits after ~3 s of play ----
    const casualHuman = { playerId: 'c'.repeat(16), name: 'Casual', account: true, accountAgeDays: 30 };
    const placed = await post(`${cp.url}/dev/match`, { mode: '1v1', region: 'SA', ranked: false, humans: [casualHuman], matchLengthSeconds: 60, ...QUICK });
    assert.equal(placed.status, 200, JSON.stringify(placed.body));
    assert.equal(placed.body.wsUrl, `ws://127.0.0.1:${nodePort}/m/${placed.body.matchId}`);
    const pl = await connectPlayer({ wsUrl: placed.body.wsUrl, ticket: placed.body.tickets[0].ticket });
    assert.equal(pl.protocol, P.WS_SUBPROTOCOL);
    assert.equal(pl.welcome.matchId, placed.body.matchId);
    assert.match(pl.welcome.hostColo, /^node:cordoba-1/);
    await assert.rejects(connectPlayer({ wsUrl: placed.body.wsUrl, ticket: placed.body.tickets[0].ticket }), 'a ticket is single use');
    await waitFor(() => pl.lastTick > 3 * 120, 15_000);
    const lv = await post(`${cp.url}/dev/leave`, { matchId: placed.body.matchId, playerId: casualHuman.playerId });
    assert.equal(lv.status, 200, JSON.stringify(lv.body));
    assert.equal(lv.body.ended, true);
    const casual = await outcomeOf(cp.url, placed.body.matchId);
    assert.equal(casual.verdict.code, 'ok', casual.verdict.message);
    assert.equal(casual.outcome.kind, 'unrated');
    assert.ok(casual.ledger.points > 0, 'verified minutes earn points');
    assert.equal(casual.verifiedBy, 'control-plane');

    // ---- ranked needs an 'active' node ----
    const ana = { playerId: 'd'.repeat(16), name: 'Ana', account: true, accountAgeDays: 90 };
    const beto = { playerId: 'e'.repeat(16), name: 'Beto', account: true, accountAgeDays: 90 };
    const rankedReq = { mode: '1v1', region: 'SA', ranked: true, humans: [ana, beto], matchLengthSeconds: 120, ...QUICK };
    assert.equal((await post(`${cp.url}/dev/match`, rankedReq)).status, 503, 'probation nodes do not host ranked');
    cp.cp.setStatus(identity.nodeId, 'active', 'test');
    await waitFor(() => rt.status === 'active', 5_000);
    // The operator never hosts a ranked match they play in.
    assert.equal((await post(`${cp.url}/dev/match`, { ...rankedReq, humans: [{ ...ana, playerId: op }, beto] })).status, 503);

    const ranked = await post(`${cp.url}/dev/match`, rankedReq);
    assert.equal(ranked.status, 200, JSON.stringify(ranked.body));
    const ticketOf = (id) => ranked.body.tickets.find((t) => t.playerId === id).ticket;
    const a = await connectPlayer({ wsUrl: ranked.body.wsUrl, ticket: ticketOf(ana.playerId) });
    const b = await connectPlayer({ wsUrl: ranked.body.wsUrl, ticket: ticketOf(beto.playerId), steerPhase: 100 });
    await waitFor(() => a.lastTick > 3 * 120 && b.lastTick > 3 * 120, 15_000);
    // Beto quits for good: red has nobody left -> forfeit, blue wins.
    const q = await post(`${cp.url}/dev/leave`, { matchId: ranked.body.matchId, playerId: beto.playerId });
    assert.equal(q.body.ended, true);
    await waitFor(() => a.ended, 5_000);
    assert.equal(a.ended.forfeit, true);
    assert.equal(a.ended.winner, 0);
    const res = await outcomeOf(cp.url, ranked.body.matchId);
    assert.equal(res.verdict.code, 'ok', res.verdict.message);
    assert.equal(res.outcome.kind, 'rated');
    assert.equal(res.outcome.winner, 0);
    assert.deepEqual(
      res.outcome.players.map((p) => [p.id, p.left]),
      [
        [ana.playerId, false],
        [beto.playerId, true],
      ],
    );

    // ---- the operator's page ----
    const mine = await (await fetch(`${cp.url}/nodes/mine`, { headers: { 'x-dev-operator': op } })).json();
    assert.equal(mine.nodes.length, 1);
    assert.equal(mine.nodes[0].counters.verified, 2);
    assert.equal(mine.rewards.matches30d, 2);
    assert.ok(mine.rewards.points30d > 0);
    assert.equal(mine.wallet.balance, mine.rewards.earned, 'nothing spent yet');
    const pub = await (await fetch(`${cp.url}/nodes/status`)).json();
    assert.equal(pub.nodes[0].name, 'cordoba-1');
    assert.equal(pub.hosts[0].name, 'Juan');
  } finally {
    if (rt) await rt.stop();
    await cp.close();
  }
});

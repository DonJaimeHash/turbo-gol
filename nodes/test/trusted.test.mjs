// The project's own machine (the Sao Paulo VPS) as the trusted verifier. A community node on probation
// only gets matches while some verifier could re-simulate them; a match placed then waits in the
// verification queue if the verifier goes away, and is verified once one connects again.
// The host then claims an item in the shop with the points it earned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testBuild } from './helpers.mjs';
import { connectPlayer, freePort, waitFor } from './player.mjs';

const { startControlPlane } = await import('../control-plane/devServer.ts');
const { NodeRuntime } = await import('../node/runtime.ts');
const { registerNode } = await import('../node/register.ts');
const { nodeSpecs } = await import('../node/bench.ts');

async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const get = async (url, headers = {}) => (await fetch(url, { headers })).json();
const CAP = { matches: 2, cpuMsPerMatchSecond: 0, memMBPerMatch: 0, uplinkMbps: null, source: 'declared' };

async function startNode(cp, operatorName, opts) {
  const op = (await post(`${cp.url}/dev/login`, { name: operatorName })).body.operatorId;
  const tok = await post(`${cp.url}/nodes/tokens`, { region: 'SA', name: opts.name }, { 'x-dev-operator': op });
  const build = await testBuild();
  const identity = await registerNode({ control: cp.url, token: tok.body.token, build, specs: nodeSpecs(), capacity: CAP, ...opts });
  const rt = new NodeRuntime({ identity, build, specs: nodeSpecs(), capacity: CAP, listenPort: opts.port ?? 0, listenHost: '127.0.0.1', heartbeatMs: 300, log: () => undefined, timings: { startGraceMs: 300, endLingerMs: 100 } });
  await rt.start();
  return { op, identity, rt };
}

test('the trusted verifier (Sao Paulo VPS) verifies community matches; the queue waits for it', async () => {
  const cp = await startControlPlane({ port: 0, log: () => undefined, inlineVerify: false, trustedOperatorNames: ['Proyecto'], sweepMs: 300 });
  const nodes = [];
  try {
    const port = await freePort();
    const juan = await startNode(cp, 'Juan', { roles: ['host'], transports: ['wss'], publicUrl: `ws://127.0.0.1:${port}`, name: 'juan-1', port });
    nodes.push(juan.rt);
    await waitFor(() => cp.cp.registry.node(juan.identity.nodeId)?.status === 'probation', 10_000);

    const humans = [{ playerId: 'c'.repeat(16), name: 'Caro', account: true, accountAgeDays: 30 }];
    const req = { mode: '1v1', region: 'SA', ranked: false, humans, matchLengthSeconds: 90, kickoffCountdownSeconds: 1, goalPauseSeconds: 1 };
    assert.equal((await post(`${cp.url}/dev/match`, req)).status, 503, 'no verifier: a probation node gets nothing');
    const sp1 = await startNode(cp, 'Proyecto', { roles: ['verify'], transports: [], publicUrl: null, name: 'sao-paulo-1' });
    await waitFor(() => cp.cp.registry.node(sp1.identity.nodeId)?.status === 'active' && cp.cp.isOnline(sp1.identity.nodeId), 10_000);
    const p = await post(`${cp.url}/dev/match`, { mode: '1v1', region: 'SA', ranked: false, humans, matchLengthSeconds: 90, kickoffCountdownSeconds: 1, goalPauseSeconds: 1 });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const pl = await connectPlayer({ wsUrl: p.body.wsUrl, ticket: p.body.tickets[0].ticket });
    await waitFor(() => pl.lastTick > 3 * 120, 15_000);
    // The verifier goes away (a reboot) before the match is reported.
    await sp1.rt.stop();
    await waitFor(() => !cp.cp.isOnline(sp1.identity.nodeId), 5_000);
    await post(`${cp.url}/dev/leave`, { matchId: p.body.matchId, playerId: humans[0].playerId });

    // Nobody can verify yet: the result waits, it is not voided.
    await waitFor(async () => (await get(`${cp.url}/dev/outcome/${p.body.matchId}`)).state === 'verifying', 10_000);
    await new Promise((r) => setTimeout(r, 1_000));
    assert.equal((await get(`${cp.url}/dev/outcome/${p.body.matchId}`)).state, 'verifying');

    // A project verifier comes up again: trusted, active at once, and it takes the queued job.
    const sp = await startNode(cp, 'Proyecto', { roles: ['verify'], transports: [], publicUrl: null, name: 'sao-paulo-2' });
    nodes.push(sp.rt);
    const rec = cp.cp.registry.node(sp.identity.nodeId);
    assert.equal(rec.trusted, true);
    assert.equal(rec.status, 'active');
    const out = await waitFor(async () => {
      const b = await get(`${cp.url}/dev/outcome/${p.body.matchId}`);
      return b.state === 'done' ? b : null;
    }, 30_000);
    assert.equal(out.verifiedBy, sp.identity.nodeId, 'verified by the trusted VPS, not in the control plane');
    assert.equal(out.verdict.code, 'ok', out.verdict.message);
    assert.ok(out.ledger.points > 0);

    // Juan's points: the free host badge can be claimed; announced items cannot yet.
    const shop = await get(`${cp.url}/nodes/shop`, { 'x-dev-operator': juan.op });
    assert.ok(shop.wallet.balance > 0);
    assert.equal(shop.items.find((i) => i.id === 'badge-host').claimable, true);
    const claim = await post(`${cp.url}/nodes/shop/claim`, { itemId: 'badge-host' }, { 'x-dev-operator': juan.op });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    const soon = await post(`${cp.url}/nodes/shop/claim`, { itemId: 'boost-next-1' }, { 'x-dev-operator': juan.op });
    assert.equal(soon.body.error, 'not_available');
    assert.deepEqual((await get(`${cp.url}/nodes/inventory`, { 'x-dev-operator': juan.op })).items, ['badge-host']);
    // The project's machine earns nothing.
    assert.equal((await get(`${cp.url}/nodes/shop`, { 'x-dev-operator': sp.op })).wallet.earned, 0);
  } finally {
    for (const rt of nodes) await rt.stop();
    await cp.close();
  }
});

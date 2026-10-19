// A home PC (no listening port, WebRTC only) hosts a match, and the game's REAL NetClient plays it
// through the WebRTC socket adapter, with werift standing in for the browser's RTCPeerConnection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { T, P, testBuild } from './helpers.mjs';
import { waitFor } from './player.mjs';

const require = createRequire(import.meta.url);
const { RTCPeerConnection } = require('werift');
const { startControlPlane } = await import('../control-plane/devServer.ts');
const { NodeRuntime } = await import('../node/runtime.ts');
const { registerNode } = await import('../node/register.ts');
const { nodeSpecs } = await import('../node/bench.ts');
const { nodeAwareSocketFactory, isRtcNodeUrl, RtcSocket } = await import('../client/rtcSocket.ts');
const { NetClient } = await import('../../src/net/NetClient.ts');

async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

const CAPACITY = { matches: 2, cpuMsPerMatchSecond: 0, memMBPerMatch: 0, uplinkMbps: 20, source: 'declared' };
const peerDeps = { createPeer: (cfg) => new RTCPeerConnection(cfg), fetchFn: (u, init) => fetch(u, init) };

/** A NetClient on a factory that knows WebRTC nodes, driving a simple chase-forward input pattern. */
function player(wsUrl, ticket) {
  const st = { welcome: null, snaps: 0, lastTick: 0, closed: null, events: [] };
  const net = new NetClient({ apiBase: 'http://127.0.0.1:1', storage: null, webSocketFactory: nodeAwareSocketFactory(undefined, peerDeps), pingIntervalMs: 250 });
  const packed = new Int8Array(6 * T.PACKED_INPUT_BYTES);
  const c = T.emptyControls();
  net.onWelcome = (w) => {
    st.welcome = w;
    net.sendReady();
  };
  net.onSnapshot = (pkt) => {
    st.snaps++;
    st.lastTick = pkt.tick;
    for (let i = 0; i < 6; i++) {
      c.throttle = 1;
      c.steer = Math.sin((pkt.tick + i) / 40);
      c.boost = (pkt.tick + i) % 200 < 50;
      T.packControls(c, packed, i * T.PACKED_INPUT_BYTES);
    }
    net.sendInputs(pkt.tick + 1, 6, packed, pkt.tick);
  };
  net.onEvent = (e) => st.events.push(e);
  net.onClose = (code, reason, reconnecting) => {
    st.closed = { code, reason, reconnecting };
  };
  net.connect(wsUrl, ticket);
  return { net, st };
}

test('a home PC hosts over WebRTC: no open port, the real NetClient plays, the result is verified', async () => {
  const cp = await startControlPlane({ port: 0, log: () => undefined, sweepMs: 500 });
  let rt = null;
  const nets = [];
  try {
    const op = (await post(`${cp.url}/dev/login`, { name: 'Lucia' })).body.operatorId;
    const tok = await post(`${cp.url}/nodes/tokens`, { region: 'SA', name: 'casa-1' }, { 'x-dev-operator': op });
    const build = await testBuild();
    const identity = await registerNode({ control: cp.url, token: tok.body.token, roles: ['host'], transports: ['rtc'], publicUrl: null, name: 'casa-1', build, specs: nodeSpecs(), capacity: CAPACITY });
    assert.equal(identity.publicUrl, null);
    rt = new NodeRuntime({
      identity,
      build,
      specs: nodeSpecs(),
      capacity: CAPACITY,
      listenPort: 0,
      listenHost: '127.0.0.1',
      heartbeatMs: 300,
      log: () => undefined,
      timings: { startGraceMs: 300, endLingerMs: 100, emptyShutdownMs: 3_000 },
    });
    await rt.start();
    assert.equal(rt.server, null, 'a WebRTC node listens on nothing');
    // Reachable = the WebRTC self-test passed: pending -> probation.
    await waitFor(() => cp.cp.registry.node(identity.nodeId)?.status === 'probation', 15_000);
    assert.equal(rt.rtcReady, true);

    const humans = [{ playerId: 'h'.repeat(16), name: 'Hugo', account: true, accountAgeDays: 60 }];
    const base = { mode: '1v1', region: 'SA', ranked: false, humans, matchLengthSeconds: 90, kickoffCountdownSeconds: 1, goalPauseSeconds: 1 };
    // A client without the adapter (WebSocket only) is never sent to a home PC.
    assert.equal((await post(`${cp.url}/dev/match`, { ...base, transports: ['wss'] })).status, 503);
    const placed = await post(`${cp.url}/dev/match`, { ...base, transports: ['wss', 'rtc'] });
    assert.equal(placed.status, 200, JSON.stringify(placed.body));
    assert.equal(placed.body.transport, 'rtc');
    assert.ok(isRtcNodeUrl(placed.body.wsUrl), placed.body.wsUrl);
    assert.ok(placed.body.wsUrl.startsWith(cp.url.replace('http', 'ws') + '/nodes/rtc/'));

    const { net, st } = player(placed.body.wsUrl, placed.body.tickets[0].ticket);
    nets.push(net);
    await waitFor(() => st.welcome !== null, 15_000);
    assert.equal(st.welcome.matchId, placed.body.matchId);
    assert.equal(st.welcome.hostColo, 'node:casa-1');
    await waitFor(() => st.lastTick > 4 * 120, 20_000);
    assert.ok(st.snaps > 40, `snapshots ${st.snaps}`);

    // The same ticket cannot open a second connection.
    const again = await new Promise((resolve) => {
      const s = new RtcSocket(placed.body.wsUrl, [P.WS_SUBPROTOCOL, P.WS_TICKET_PREFIX + placed.body.tickets[0].ticket], peerDeps);
      s.onclose = (ev) => resolve(ev.code);
    });
    assert.equal(again, 1006, 'refused like a rejected upgrade');

    // The player quits: the node closes the channel with 1000 'left', NetClient does not reconnect.
    const lv = await post(`${cp.url}/dev/leave`, { matchId: placed.body.matchId, playerId: humans[0].playerId });
    assert.equal(lv.body.answer.ended, true);
    await waitFor(() => st.closed !== null, 5_000);
    assert.equal(st.closed.code, 1000);
    assert.equal(st.closed.reason, 'left');
    assert.equal(st.closed.reconnecting, false);
    const out = await waitFor(async () => {
      const b = await (await fetch(`${cp.url}/dev/outcome/${placed.body.matchId}`)).json();
      return b.state === 'done' ? b : null;
    }, 30_000);
    assert.equal(out.transport, 'rtc');
    assert.equal(out.verdict.code, 'ok', out.verdict.message);
    assert.equal(out.outcome.kind, 'unrated');
    assert.ok(out.ledger.points > 0, 'a home PC earns points like a VPS');
  } finally {
    for (const n of nets) n.dispose();
    if (rt) await rt.stop();
    await cp.close();
  }
});

test('signaling refuses bad tickets and unknown matches before they reach the node', async () => {
  const cp = await startControlPlane({ port: 0, log: () => undefined });
  try {
    const r1 = await post(`${cp.url}/nodes/rtc/${'a'.repeat(16)}/${'b'.repeat(32)}/ice`, { ticket: 'x.y.z' });
    assert.equal(r1.status, 404);
    const r2 = await post(`${cp.url}/nodes/rtc/${'a'.repeat(16)}/${'b'.repeat(32)}/offer`, { ticket: 'x.y.z', sdp: 'v=0' });
    assert.equal(r2.status, 404);
  } finally {
    await cp.close();
  }
});

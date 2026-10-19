// Local demo of the whole design:
//   - control plane on :8790
//   - "Proyecto" runs the trusted verifier (the role of the Sao Paulo VPS): every result is
//     re-simulated there, not in the control plane
//   - "Demo" runs a home PC (WebRTC, no open port) and a server (WebSocket on :7350)
//   - a casual match on the home PC, played by the game's real NetClient through the WebRTC adapter
//   - a ranked match on the server (promoted to "active" for the demo; normally 20 verified matches)
//   - Demo claims the free host badge in the shop
// Then it stays up (Ctrl+C to stop): open http://127.0.0.1:8790/host and sign in as "Demo".
//   npm run demo            (from nodes/)
//   npm run demo -- --once  (exit after the matches)
import { createRequire } from 'node:module';
import { T, testBuild } from '../test/helpers.mjs';
import { connectPlayer, waitFor } from '../test/player.mjs';

const require = createRequire(import.meta.url);
const { RTCPeerConnection } = require('werift');
const { startControlPlane } = await import('../control-plane/devServer.ts');
const { NodeRuntime } = await import('../node/runtime.ts');
const { registerNode } = await import('../node/register.ts');
const { nodeSpecs } = await import('../node/bench.ts');
const { nodeAwareSocketFactory } = await import('../client/rtcSocket.ts');
const { NetClient } = await import('../../src/net/NetClient.ts');

const say = (m) => console.log(`\n== ${m}`);
const post = async (url, body, headers = {}) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })).json();
const CAP = { matches: 4, cpuMsPerMatchSecond: 0, memMBPerMatch: 0, uplinkMbps: 20, source: 'declared' };

const cp = await startControlPlane({ port: 8790, inlineVerify: false, trustedOperatorNames: ['Proyecto'], log: (m) => console.log(`[control] ${m}`) });
const build = await testBuild();
const runtimes = [];

async function node(operator, reg, extra = {}) {
  const op = (await post(`${cp.url}/dev/login`, { name: operator })).operatorId;
  const tok = await post(`${cp.url}/nodes/tokens`, { region: 'SA', name: reg.name }, { 'x-dev-operator': op });
  const identity = await registerNode({ control: cp.url, token: tok.token, build, specs: nodeSpecs(), capacity: CAP, ...reg });
  const rt = new NodeRuntime({ identity, build, specs: nodeSpecs(), capacity: CAP, listenPort: extra.port ?? 0, listenHost: '127.0.0.1', heartbeatMs: 1000, log: (m) => console.log(`[${reg.name}] ${m}`) });
  await rt.start();
  runtimes.push(rt);
  return { op, identity, rt };
}

async function outcome(matchId) {
  return waitFor(async () => {
    const b = await (await fetch(`${cp.url}/dev/outcome/${matchId}`)).json();
    return b.state === 'done' ? b : null;
  }, 60_000);
}

say('the project brings up its trusted verifier (the Sao Paulo VPS role)');
await node('Proyecto', { roles: ['verify'], transports: [], publicUrl: null, name: 'sao-paulo-1' });

say('Demo registers a home PC (WebRTC, nothing to open) and a server (WebSocket on :7350)');
const home = await node('Demo', { roles: ['host'], transports: ['rtc'], publicUrl: null, name: 'casa-1' });
const vps = await node('Demo', { roles: ['host'], transports: ['wss'], publicUrl: 'ws://127.0.0.1:7350', name: 'vps-1' }, { port: 7350 });
await waitFor(() => cp.cp.registry.node(home.identity.nodeId)?.status === 'probation' && cp.cp.registry.node(vps.identity.nodeId)?.status === 'probation', 20_000);

say('casual match on the home PC, played by the real NetClient over WebRTC');
const casualHuman = { playerId: '1'.repeat(16), name: 'Luz', account: true, accountAgeDays: 40 };
// Only rtc in the demo request so the match lands on the home PC.
const p1 = await post(`${cp.url}/dev/match`, { mode: '1v1', region: 'SA', ranked: false, humans: [casualHuman], matchLengthSeconds: 120, kickoffCountdownSeconds: 1, goalPauseSeconds: 1, transports: ['rtc'] });
console.log(`placed on ${p1.nodeName} (${p1.transport}): ${p1.wsUrl}`);
const net = new NetClient({ apiBase: cp.url, storage: null, webSocketFactory: nodeAwareSocketFactory(undefined, { createPeer: (cfg) => new RTCPeerConnection(cfg) }) });
let lastTick = 0;
const packed = new Int8Array(6 * T.PACKED_INPUT_BYTES);
const c = T.emptyControls();
net.onWelcome = (w) => {
  console.log(`welcome from ${w.hostColo}`);
  net.sendReady();
};
net.onSnapshot = (pkt) => {
  lastTick = pkt.tick;
  for (let i = 0; i < 6; i++) {
    c.throttle = 1;
    c.steer = Math.sin((pkt.tick + i) / 40);
    T.packControls(c, packed, i * T.PACKED_INPUT_BYTES);
  }
  net.sendInputs(pkt.tick + 1, 6, packed, pkt.tick);
};
net.connect(p1.wsUrl, p1.tickets[0].ticket);
await waitFor(() => lastTick > 6 * 120, 30_000);
await post(`${cp.url}/dev/leave`, { matchId: p1.matchId, playerId: casualHuman.playerId });
let o = await outcome(p1.matchId);
console.log(`verdict ${o.verdict.code} by ${o.verifiedBy === runtimes[0].opts.identity.nodeId ? 'sao-paulo-1' : o.verifiedBy}, ${o.verdict.ticks} ticks re-simulated in ${o.verdict.cpuMs.toFixed(0)} ms, outcome ${o.outcome.kind}, ${o.ledger?.points ?? 0} points`);
net.dispose();

say('ranked match on the server (the demo promotes it to "active"; normally that takes 20 verified matches)');
cp.cp.setStatus(vps.identity.nodeId, 'active', 'demo');
await waitFor(() => vps.rt.status === 'active', 5_000);
const ana = { playerId: '2'.repeat(16), name: 'Ana', account: true, accountAgeDays: 90 };
const beto = { playerId: '3'.repeat(16), name: 'Beto', account: true, accountAgeDays: 90 };
const p2 = await post(`${cp.url}/dev/match`, { mode: '1v1', region: 'SA', ranked: true, humans: [ana, beto], matchLengthSeconds: 120, kickoffCountdownSeconds: 1, goalPauseSeconds: 1 });
console.log(`placed on ${p2.nodeName} (${p2.transport})`);
const pa = await connectPlayer({ wsUrl: p2.wsUrl, ticket: p2.tickets[0].ticket });
const pb = await connectPlayer({ wsUrl: p2.wsUrl, ticket: p2.tickets[1].ticket, steerPhase: 90 });
await waitFor(() => pa.lastTick > 6 * 120, 30_000);
await post(`${cp.url}/dev/leave`, { matchId: p2.matchId, playerId: beto.playerId });
o = await outcome(p2.matchId);
console.log(`verdict ${o.verdict.code}, outcome ${o.outcome.kind} (winner ${o.outcome.winner}, Beto left), ${o.ledger?.points ?? 0} points`);
pa.close();
pb.close();

say('Demo claims the free host badge');
const claim = await post(`${cp.url}/nodes/shop/claim`, { itemId: 'badge-host' }, { 'x-dev-operator': home.op });
console.log(claim.ok ? `claimed; balance ${claim.wallet.balance} points` : `claim refused: ${claim.error}`);

if (process.argv.includes('--once')) {
  for (const rt of runtimes) await rt.stop();
  await cp.close();
  process.exit(0);
}
console.log(`\nOpen ${cp.url}/host and sign in as "Demo" (or "Proyecto"). Ctrl+C to stop.`);

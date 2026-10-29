// Mesh (src/net/p2p/Mesh.ts) with a fake RTCPeerConnection, no browser:
//   node --test tests/p2p-mesh.test.mjs
// Covers: perfect-negotiation roles (polite = higher slot), channel creation by the lower slot,
// offer collisions, liveness (2 s without game packets, ICE failed 5 s, one ICE restart), the
// ack / redundancy assembly of a game packet, and getStats() parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('.') || /\.[cm]?ts$/.test(specifier)) throw err;
      return nextResolve(specifier.replace(/\.js$/, '') + '.ts', context);
    }
  },
});

const M = await import('../src/net/p2p/Mesh.ts');
const P = await import('../src/net/p2p/protocol.ts');
const { InputRing, assembleInputs } = await import('../src/net/InputRing.ts');
const S = await import('../src/net/NetStats.ts');
const { PACKED_INPUT_BYTES } = await import('../src/sim/types.ts');

const { Mesh, parsePeerStats, assembleGamePacket, signalKind, GAME_DEAD_MS, ICE_DEAD_MS, ICE_RESTART_DISCONNECTED_MS, OFFER_RETRY_MS, OFFER_MAX_TRIES } = M;

// ---- fakes ---------------------------------------------------------------------------------

let sdpCounter = 0;

class FakeChannel {
  constructor(label, init) {
    this.label = label;
    this.init = init ?? {};
    this.readyState = 'connecting';
    this.binaryType = 'blob';
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.sent = [];
  }
  send(data) {
    if (this.readyState !== 'open') throw new Error('not open');
    this.sent.push(Uint8Array.from(data));
  }
  close() {
    this.readyState = 'closed';
  }
  open() {
    this.readyState = 'open';
    if (this.onopen) this.onopen({});
  }
  deliver(bytes) {
    const copy = Uint8Array.from(bytes);
    if (this.onmessage) this.onmessage({ data: copy.buffer });
  }
}

class FakePC {
  constructor(config) {
    this.config = config;
    this.signalingState = 'stable';
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
    this.localDescription = null;
    this.onnegotiationneeded = null;
    this.onicecandidate = null;
    this.ondatachannel = null;
    this.oniceconnectionstatechange = null;
    this.onconnectionstatechange = null;
    this.channels = [];
    this.remote = [];
    this.candidates = [];
    this.restarts = 0;
    this.closed = false;
    this.report = [];
    this.negotiationPending = false;
  }
  createDataChannel(label, init) {
    const ch = new FakeChannel(label, init);
    this.channels.push(ch);
    // Browsers coalesce: one negotiationneeded per batch of changes.
    if (!this.negotiationPending) {
      this.negotiationPending = true;
      queueMicrotask(() => {
        this.negotiationPending = false;
        if (this.onnegotiationneeded && !this.closed) this.onnegotiationneeded({});
      });
    }
    return ch;
  }
  async setLocalDescription(desc) {
    const type = desc?.type ?? (this.signalingState === 'have-remote-offer' ? 'answer' : 'offer');
    this.localDescription = { type, sdp: `${type}-${++sdpCounter}` };
    this.signalingState = type === 'answer' ? 'stable' : 'have-local-offer';
  }
  async setRemoteDescription(desc) {
    this.remote.push(desc);
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(c) {
    this.candidates.push(c ?? null);
  }
  restartIce() {
    this.restarts++;
  }
  setConfiguration(config) {
    this.config = config;
    this.reconfigured = (this.reconfigured ?? 0) + 1;
  }
  async getStats() {
    const list = this.report;
    return { forEach: (cb) => list.forEach((e) => cb(e)) };
  }
  close() {
    this.closed = true;
  }
  // test helpers
  incomingChannel(label, init) {
    const ch = new FakeChannel(label, init);
    if (this.ondatachannel) this.ondatachannel({ channel: ch });
    return ch;
  }
  setIce(state) {
    this.iceConnectionState = state;
    if (this.oniceconnectionstatechange) this.oniceconnectionstatechange({});
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A mesh for `mySlot` with injectable time; `pcs` maps slot -> FakePC once addPeer ran. */
function makeMesh(mySlot, opts = {}) {
  const pcs = new Map();
  const signals = [];
  let t = 1000;
  const mesh = new Mesh({
    mySlot,
    iceServers: [{ urls: 'stun:stun.example:3478' }],
    signal: (to, data) => signals.push({ to, data }),
    now: () => t,
    connectionFactory: (config) => {
      const pc = new FakePC(config);
      pcs.set(pcs.size, pc); // insertion order == addPeer order
      return pc;
    },
    ...opts,
  });
  return { mesh, pcs, signals, setTime: (v) => (t = v), time: () => t };
}

/** Open both channels of peer index i (the lower-slot side created them, the higher got them). */
function openBoth(pc) {
  for (const ch of pc.channels) ch.open();
}

/** A LocalInputSource over an InputRing (the phase 1 newest-2 + unacked policy); the session uses the engine. */
function sourceOf(ring) {
  return {
    get newestLocalTick() {
      return ring.newestTick;
    },
    assembleLocalInputs: (ack, out, cap) => assembleInputs(ring, ack, out, cap),
  };
}

function packetFor(mesh, ring, ack, newestFromPeer, myTick) {
  const out = new Uint8Array(P.INPUT_HDR + P.P2P_INPUT_MAX_BATCH * PACKED_INPUT_BYTES);
  const scratch = new Int8Array(P.P2P_INPUT_MAX_BATCH * PACKED_INPUT_BYTES);
  const len = assembleGamePacket(sourceOf(ring), ack, newestFromPeer, myTick, out, scratch);
  const pkt = { firstTick: 0, count: 0, ackTick: 0, myTick: 0, packed: new Int8Array(P.P2P_INPUT_MAX_BATCH * PACKED_INPUT_BYTES) };
  if (len > 0) assert.ok(P.decodeP2pInput(out.subarray(0, len), pkt));
  return { len, pkt };
}

// ---- negotiation ---------------------------------------------------------------------------

test('polite = my slot > their slot; the lower slot creates both channels and offers, the higher side only answers', async () => {
  const { mesh, pcs, signals } = makeMesh(1);
  assert.equal(mesh.polite(0), true, 'vs slot 0 I am the higher slot: polite');
  assert.equal(mesh.polite(2), false, 'vs slot 2 I am the lower slot: impolite');

  mesh.addPeer(0);
  mesh.addPeer(2);
  assert.equal(mesh.peerCount, 2);
  const pc0 = pcs.get(0);
  const pc2 = pcs.get(1);
  assert.deepEqual(pc0.config, { iceServers: [{ urls: 'stun:stun.example:3478' }] });
  assert.equal(pc0.channels.length, 0, 'slot 0 (lower) creates the channels, not me');
  assert.deepEqual(
    pc2.channels.map((c) => [c.label, c.init]),
    [
      ['game', { ordered: false, maxRetransmits: 0 }],
      ['ctl', { ordered: true }],
    ],
    'towards slot 2 (higher) I create game (unordered, no retransmits) and ctl (ordered)',
  );
  assert.ok(pc2.channels.every((c) => c.binaryType === 'arraybuffer'));
  await flush();
  assert.equal(signals.length, 1, 'exactly one offer went out');
  assert.equal(signals[0].to, 2);
  assert.equal(signals[0].data.sdp.type, 'offer');
  assert.equal(pc2.signalingState, 'have-local-offer');

  // The answer from 2 completes that negotiation.
  mesh.handleSignal(2, { sdp: { type: 'answer', sdp: 'a' } });
  await flush();
  assert.equal(pc2.remote.length, 1);
  assert.equal(pc2.signalingState, 'stable');
  assert.equal(signals.length, 1, 'an answer produces no further signal');

  // An offer from 0 (the lower slot) is answered, and its channels arrive through ondatachannel.
  mesh.handleSignal(0, { sdp: { type: 'offer', sdp: 'o' } });
  await flush();
  assert.equal(pc0.remote[0].type, 'offer');
  assert.equal(signals.length, 2);
  assert.equal(signals[1].to, 0);
  assert.equal(signals[1].data.sdp.type, 'answer');

  // Trickle ICE both ways.
  pc0.onicecandidate({ candidate: { candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.deepEqual(signals[2], { to: 0, data: { candidate: { candidate: 'cand', sdpMid: '0', sdpMLineIndex: 0 } } });
  pc0.onicecandidate({ candidate: null });
  assert.deepEqual(signals[3], { to: 0, data: { candidate: null } });
  mesh.handleSignal(0, { candidate: { candidate: 'rc', sdpMid: '0', sdpMLineIndex: 0 } });
  mesh.handleSignal(0, { candidate: null });
  await flush();
  assert.deepEqual(pc0.candidates, [{ candidate: 'rc', sdpMid: '0', sdpMLineIndex: 0 }, null]);

  // Channels: incoming on the polite side, created on the impolite one; connected once both open.
  const connected = [];
  mesh.onPeerConnected = (slot) => connected.push(slot);
  assert.equal(mesh.allConnected(), false);
  const g0 = pc0.incomingChannel('game', { ordered: false, maxRetransmits: 0 });
  const c0 = pc0.incomingChannel('ctl', { ordered: true });
  assert.equal(g0.binaryType, 'arraybuffer');
  g0.open();
  assert.equal(mesh.peerState(0), S.PEER_STATE_CONNECTING, 'one channel open is not connected');
  c0.open();
  assert.equal(mesh.peerState(0), S.PEER_STATE_CONNECTED);
  assert.deepEqual(connected, [0]);
  assert.equal(mesh.connectedCount(), 1);
  assert.equal(mesh.allConnected(), false, 'slot 2 still connecting');
  openBoth(pc2);
  assert.deepEqual(connected, [0, 2]);
  assert.equal(mesh.allConnected(), true);
  assert.equal(mesh.expectedCount(), 2);
});

test('offer collision: the impolite side ignores the incoming offer (and its candidates), the polite side accepts it', async () => {
  // Me = 1. Towards 2 I am impolite and mid-offer.
  const { mesh, pcs } = makeMesh(1);
  mesh.addPeer(2);
  await flush();
  const pc2 = pcs.get(0);
  assert.equal(pc2.signalingState, 'have-local-offer');
  mesh.handleSignal(2, { sdp: { type: 'offer', sdp: 'their-offer' } });
  await flush();
  assert.equal(pc2.remote.length, 0, 'the colliding offer is ignored');
  mesh.handleSignal(2, { candidate: { candidate: 'x', sdpMid: '0', sdpMLineIndex: 0 } });
  await flush();
  assert.equal(pc2.candidates.length, 1, 'candidates are still passed on (errors on them are swallowed)');

  // Towards 0 I am polite: a colliding offer is applied (the browser rolls my offer back).
  mesh.addPeer(0);
  const pc0 = pcs.get(1);
  pc0.signalingState = 'have-local-offer';
  mesh.handleSignal(0, { sdp: { type: 'offer', sdp: 'o' } });
  await flush();
  assert.equal(pc0.remote.length, 1);
  assert.equal(pc0.remote[0].sdp, 'o');
});

// ---- channels, send / receive -------------------------------------------------------------

test('sendGame / sendCtl / broadcast only on open channels; onGame / onCtl get a view of the frame and count bytes', async () => {
  const { mesh, pcs } = makeMesh(0);
  mesh.addPeer(1);
  mesh.addPeer(2);
  await flush();
  const pc1 = pcs.get(0);
  const pc2 = pcs.get(1);
  const buf = new Uint8Array([1, 2, 3, 4, 5, 6]);
  assert.equal(mesh.sendGame(1, buf, 4), false, 'channel not open yet');
  openBoth(pc1);
  assert.equal(mesh.sendGame(1, buf, 4), true);
  assert.deepEqual([...pc1.channels[0].sent[0]], [1, 2, 3, 4], 'only `len` bytes go out');
  assert.equal(mesh.sendCtl(1, buf, 6), true);
  assert.deepEqual([...pc1.channels[1].sent[0]], [1, 2, 3, 4, 5, 6]);
  assert.equal(mesh.sendGame(7, buf, 4), false, 'unknown slot');
  assert.equal(mesh.broadcastGame(buf, 2), 1, 'slot 2 is not open: one recipient');
  openBoth(pc2);
  assert.equal(mesh.broadcastCtl(buf, 2), 2);
  assert.equal(mesh.bytesOut, 4 + 6 + 2 + 2 + 2);
  assert.equal(mesh.peerBytesSent(1), 4 + 6 + 2 + 2);
  assert.equal(mesh.peerBytesSent(2), 2);

  const got = [];
  mesh.onGame = (slot, bytes) => got.push(['game', slot, [...bytes]]);
  mesh.onCtl = (slot, bytes) => got.push(['ctl', slot, [...bytes]]);
  pc1.channels[0].deliver([9, 8, 7]);
  pc2.channels[1].deliver([5]);
  assert.deepEqual(got, [
    ['game', 1, [9, 8, 7]],
    ['ctl', 2, [5]],
  ]);
  assert.equal(mesh.bytesIn, 4);
  assert.equal(mesh.peerBytesReceived(1), 3);
  assert.equal(mesh.packetsIn, 2);

  mesh.close();
  assert.ok(pc1.closed && pc2.closed);
  assert.equal(mesh.sendGame(1, buf, 1), false);
});

// ---- liveness ------------------------------------------------------------------------------

test('liveness: 2 s without game packets kills a peer only once armed; a packet resets the timer; dead fires once', async () => {
  const { mesh, pcs, setTime } = makeMesh(0);
  mesh.addPeer(1);
  await flush();
  const pc1 = pcs.get(0);
  openBoth(pc1);
  const dead = [];
  mesh.onPeerDead = (slot) => dead.push(slot);
  setTime(1000 + GAME_DEAD_MS * 3);
  mesh.update();
  assert.deepEqual(dead, [], 'not armed: silence before the start is fine');

  setTime(10_000);
  mesh.armLiveness();
  setTime(10_000 + GAME_DEAD_MS);
  mesh.update();
  assert.deepEqual(dead, [], 'exactly GAME_DEAD_MS is not over the limit');
  setTime(10_000 + GAME_DEAD_MS - 100);
  pc1.channels[0].deliver([1]); // a game packet at this time restarts the clock
  setTime(10_000 + GAME_DEAD_MS + 1);
  mesh.update();
  assert.deepEqual(dead, [], 'the packet reset the timer');
  setTime(10_000 + GAME_DEAD_MS - 100 + GAME_DEAD_MS + 1);
  mesh.update();
  assert.deepEqual(dead, [1]);
  assert.equal(mesh.peerState(1), S.PEER_STATE_FAILED);
  assert.ok(pc1.closed, 'a dead peer connection is closed');
  mesh.update();
  assert.deepEqual(dead, [1], 'fires once');
  assert.equal(mesh.allConnected(), false, 'a failed peer is not connected');
  mesh.removePeer(1);
  assert.equal(mesh.peerState(1), S.PEER_STATE_DROPPED);
  assert.equal(mesh.allConnected(), true, 'a dropped peer is no longer expected');
  assert.equal(mesh.expectedCount(), 0);
});

test('ICE: failed restarts ICE once, dead after 5 s; disconnected restarts after 2 s; recovery clears the timer', async () => {
  const { mesh, pcs, setTime } = makeMesh(0);
  mesh.addPeer(1);
  mesh.addPeer(2);
  await flush();
  const pc1 = pcs.get(0);
  const pc2 = pcs.get(1);
  openBoth(pc1);
  openBoth(pc2);
  const dead = [];
  mesh.onPeerDead = (slot) => dead.push(slot);

  setTime(5000);
  pc1.setIce('failed');
  assert.equal(pc1.restarts, 1, 'failed: restart at once');
  setTime(5000 + ICE_DEAD_MS);
  mesh.update();
  assert.equal(pc1.restarts, 1, 'only one restart');
  assert.deepEqual(dead, []);
  setTime(5000 + ICE_DEAD_MS + 1);
  mesh.update();
  assert.deepEqual(dead, [1]);

  setTime(20_000);
  pc2.setIce('disconnected');
  assert.equal(pc2.restarts, 0, 'disconnected is often transient: no restart yet');
  setTime(20_000 + ICE_RESTART_DISCONNECTED_MS);
  mesh.update();
  assert.equal(pc2.restarts, 1);
  setTime(20_000 + ICE_RESTART_DISCONNECTED_MS + 500);
  pc2.setIce('connected');
  setTime(20_000 + ICE_DEAD_MS + 1000);
  mesh.update();
  assert.deepEqual(dead, [1], 'recovered: slot 2 lives');
  assert.equal(mesh.peerState(2), S.PEER_STATE_CONNECTED);
});

// ---- re-offer (staggered joins) -------------------------------------------------------------

test('re-offer: the offering side re-sends the SAME offer plus the candidates gathered since after 2 s without an answer, at most 3 tries; an answer stops it', async () => {
  const entries = [];
  const { mesh, pcs, signals, setTime } = makeMesh(0, { log: { push: (e, d) => entries.push(d === undefined ? e : `${e} ${d}`) } });
  setTime(1000);
  mesh.addPeer(1);
  await flush();
  const pc1 = pcs.get(0);
  assert.equal(signals.length, 1);
  const offer = signals[0].data;
  assert.equal(offer.sdp.type, 'offer');
  pc1.onicecandidate({ candidate: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 } });
  pc1.onicecandidate({ candidate: null });
  assert.equal(signals.length, 3);

  setTime(1000 + OFFER_RETRY_MS - 1);
  mesh.update();
  assert.equal(signals.length, 3, 'not yet');
  setTime(1000 + OFFER_RETRY_MS);
  mesh.update();
  assert.equal(signals.length, 6, 're-sent: offer + 2 candidates');
  assert.deepEqual(signals[3], { to: 1, data: offer }, 'the same SDP (same ICE credentials as the buffered candidates)');
  assert.deepEqual(signals[4].data, { candidate: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.deepEqual(signals[5].data, { candidate: null });
  assert.equal(mesh.reoffers, 1);
  assert.ok(entries.some((l) => /^reoffer 1 try 2 \(no answer\), 2 candidates$/.test(l)), `logged: ${entries.join(' | ')}`);

  setTime(1000 + 2 * OFFER_RETRY_MS);
  mesh.update();
  assert.equal(signals.length, 9, 'third try');
  assert.equal(mesh.reoffers, 2);
  setTime(1000 + 3 * OFFER_RETRY_MS);
  mesh.update();
  assert.equal(signals.length, 9, `OFFER_MAX_TRIES = ${OFFER_MAX_TRIES}: the timer gives up`);
  assert.ok(entries.some((l) => /^offer\.giveup 1/.test(l)));
  setTime(1000 + 10 * OFFER_RETRY_MS);
  mesh.update();
  assert.equal(signals.length, 9, 'stays given up');

  // The peer joins: reoffer() starts over at once (fresh target), then the timer again.
  mesh.reoffer(1);
  assert.equal(signals.length, 12);
  assert.equal(mesh.reoffers, 3);
  assert.ok(entries.some((l) => /^reoffer 1 try 1 \(peer joined\)/.test(l)));
  // An answer ends the retries.
  mesh.handleSignal(1, { sdp: { type: 'answer', sdp: 'a' } });
  await flush();
  assert.equal(pc1.signalingState, 'stable');
  setTime(1000 + 20 * OFFER_RETRY_MS);
  mesh.update();
  assert.equal(signals.length, 12, 'answered: no re-send');
  mesh.reoffer(1);
  assert.equal(signals.length, 12, 'reoffer() after the answer is a no-op');
  // A second answer (to a re-sent offer the peer had already answered) is ignored, not applied.
  mesh.handleSignal(1, { sdp: { type: 'answer', sdp: 'a-dup' } });
  await flush();
  assert.equal(pc1.remote.length, 1, 'the duplicate answer was not applied');
  assert.ok(entries.some((l) => /^sig\.dup 1/.test(l)));
  assert.ok(entries.some((l) => l === 'sig> 1 offer') && entries.some((l) => l === 'sig< 1 answer'), 'signals logged by type only');
  assert.ok(!entries.some((l) => /sdp:|v=0/.test(l)), 'never the SDP itself');
});

test('re-offer: the polite side never re-offers; a connected link stops the timer; signalDropped only logs', async () => {
  const entries = [];
  const { mesh, pcs, signals, setTime } = makeMesh(1, { log: { push: (e, d) => entries.push(`${e} ${d ?? ''}`) } });
  setTime(1000);
  mesh.addPeer(0); // polite towards 0
  mesh.addPeer(2); // impolite towards 2
  await flush();
  assert.equal(signals.length, 1, 'only the offer to 2');
  assert.equal(signals[0].to, 2);
  mesh.signalDropped(2);
  assert.ok(entries.some((l) => /^sig\.dropped 2 .*offer kept/.test(l)));
  mesh.reoffer(0);
  assert.equal(signals.length, 1, 'polite side: nothing to re-send');
  // slot 2 connects (both channels open) before any answer bookkeeping: no more re-sends.
  const pc2 = pcs.get(1);
  openBoth(pc2);
  assert.equal(mesh.peerState(2), S.PEER_STATE_CONNECTED);
  setTime(1000 + 5 * OFFER_RETRY_MS);
  mesh.update();
  assert.equal(signals.length, 1, 'connected: the offer timer is off');
  assert.ok(entries.some((l) => l === 'mesh.connected slot 2'));
  assert.ok(entries.some((l) => /^chan\.open 2 game/.test(l)));
  // ICE state changes are logged once per change.
  pc2.setIce('checking');
  pc2.setIce('checking');
  pc2.setIce('connected');
  assert.deepEqual(
    entries.filter((l) => l.startsWith('ice 2')),
    ['ice 2 checking', 'ice 2 connected'],
  );
  assert.equal(signalKind({ sdp: { type: 'offer', sdp: '' } }), 'offer');
  assert.equal(signalKind({ candidate: null }), 'end-of-candidates');
  assert.equal(signalKind({ candidate: { candidate: 'c', sdpMid: null, sdpMLineIndex: null } }), 'candidate');
});

test('re-offer buffers: the kept offer and its candidates are dropped once the answer arrives or the link connects; later candidates are not buffered', async () => {
  const { mesh, pcs, signals, setTime } = makeMesh(0);
  setTime(1000);
  mesh.addPeer(1); // impolite: offers
  mesh.addPeer(2);
  await flush();
  const pc1 = pcs.get(0);
  const pc2 = pcs.get(1);
  assert.equal(mesh.offerPending(1), true);
  assert.equal(mesh.offerPending(2), true);
  pc1.onicecandidate({ candidate: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 } });
  pc1.onicecandidate({ candidate: { candidate: 'c2', sdpMid: '0', sdpMLineIndex: 0 } });
  pc2.onicecandidate({ candidate: { candidate: 'd1', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.equal(mesh.bufferedCandidates(1), 2, 'kept for a re-send while unanswered');
  assert.equal(mesh.bufferedCandidates(2), 1);
  // Slot 1 answers: nothing is kept any more, and a candidate gathered later goes out but is not buffered.
  mesh.handleSignal(1, { sdp: { type: 'answer', sdp: 'a1' } });
  await flush();
  assert.equal(mesh.offerPending(1), false);
  assert.equal(mesh.bufferedCandidates(1), 0);
  const before = signals.length;
  pc1.onicecandidate({ candidate: { candidate: 'c3', sdpMid: '0', sdpMLineIndex: 0 } });
  pc1.onicecandidate({ candidate: null });
  assert.equal(signals.length, before + 2, 'trickle still signalled');
  assert.equal(mesh.bufferedCandidates(1), 0, 'not buffered after the answer');
  // Slot 2 connects before any answer bookkeeping (e.g. the answer raced the channel open): dropped too.
  openBoth(pc2);
  assert.equal(mesh.peerState(2), S.PEER_STATE_CONNECTED);
  assert.equal(mesh.offerPending(2), false);
  assert.equal(mesh.bufferedCandidates(2), 0);
  pc2.onicecandidate({ candidate: { candidate: 'd2', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.equal(mesh.bufferedCandidates(2), 0, 'not buffered once connected');
  // Neither the timer nor a join re-sends anything.
  const n = signals.length;
  setTime(1000 + 5 * OFFER_RETRY_MS);
  mesh.update();
  mesh.reoffer(1);
  mesh.reoffer(2);
  assert.equal(signals.length, n);
  assert.equal(mesh.reoffers, 0);
  assert.equal(mesh.offerPending(7), false, 'unknown slot');
  assert.equal(mesh.bufferedCandidates(7), 0);
});

// ---- packet assembly -----------------------------------------------------------------------

test('a game packet carries the newest 2 ticks plus every tick newer than the peer ack, capped at 16, with ack / myTick', () => {
  const ring = new InputRing();
  const src = new Int8Array(PACKED_INPUT_BYTES);
  for (let t = 3; t <= 12; t++) {
    src.fill(t);
    ring.set(t, src, 0);
  }
  let r = packetFor(null, ring, 8, 40, 100);
  assert.equal(r.pkt.firstTick, 9);
  assert.equal(r.pkt.count, 4, 'ticks 9..12: everything after ack 8');
  assert.equal(r.pkt.ackTick, 40, 'newest tick received from that peer');
  assert.equal(r.pkt.myTick, 100);
  assert.deepEqual([...r.pkt.packed.subarray(0, 4 * PACKED_INPUT_BYTES)].filter((_, i) => i % PACKED_INPUT_BYTES === 0), [9, 10, 11, 12]);
  assert.equal(r.len, P.INPUT_HDR + 4 * PACKED_INPUT_BYTES);

  r = packetFor(null, ring, 11, 0, 0);
  assert.equal(r.pkt.firstTick, 11);
  assert.equal(r.pkt.count, 2, 'everything acked but the newest: still the newest two');

  r = packetFor(null, ring, 12, 0, 0);
  assert.equal(r.pkt.count, 2, 'even with the newest acked the packet repeats the newest two');

  r = packetFor(null, ring, 0, 0, 0);
  assert.equal(r.pkt.firstTick, 3);
  assert.equal(r.pkt.count, 10, 'nothing acked: every stored tick (3..12), the gap before 3 ends the run');

  for (let t = 13; t <= 40; t++) {
    src.fill(t);
    ring.set(t, src, 0);
  }
  r = packetFor(null, ring, 0, 0, 0);
  assert.equal(r.pkt.count, P.P2P_INPUT_MAX_BATCH, 'cap 16');
  assert.equal(r.pkt.firstTick, 40 - 16 + 1);

  const empty = new InputRing();
  assert.equal(packetFor(null, empty, 0, 0, 0).len, 0);
});

// ---- stats ----------------------------------------------------------------------------------

test('parsePeerStats: selected pair via transport, candidate types (relay wins over srflx over host), rtt in ms; Firefox fallback', () => {
  const report = (entries) => ({ forEach: (cb) => entries.forEach((e) => cb(e)) });
  const out = { cand: 0, rttMs: 0, bytesSent: 0, bytesReceived: 0 };
  parsePeerStats(
    report([
      { type: 'transport', id: 'T', selectedCandidatePairId: 'P2' },
      { type: 'candidate-pair', id: 'P1', state: 'succeeded', nominated: true, localCandidateId: 'L1', remoteCandidateId: 'R1', currentRoundTripTime: 0.5 },
      { type: 'candidate-pair', id: 'P2', state: 'succeeded', nominated: true, localCandidateId: 'L2', remoteCandidateId: 'R2', currentRoundTripTime: 0.023, bytesSent: 1000, bytesReceived: 2000 },
      { type: 'local-candidate', id: 'L1', candidateType: 'relay' },
      { type: 'local-candidate', id: 'L2', candidateType: 'host' },
      { type: 'remote-candidate', id: 'R2', candidateType: 'srflx' },
    ]),
    out,
  );
  assert.equal(out.cand, S.PEER_CAND_SRFLX, 'host local + srflx remote = srflx');
  assert.ok(Math.abs(out.rttMs - 23) < 1e-6);
  assert.equal(out.bytesSent, 1000);
  assert.equal(out.bytesReceived, 2000);

  parsePeerStats(
    report([
      { type: 'candidate-pair', id: 'P1', state: 'succeeded', nominated: true, selected: true, localCandidateId: 'L1', remoteCandidateId: 'R1', currentRoundTripTime: 0.1 },
      { type: 'candidate-pair', id: 'P0', state: 'succeeded', nominated: true, localCandidateId: 'L0', remoteCandidateId: 'R0' },
      { type: 'local-candidate', id: 'L1', candidateType: 'relay' },
      { type: 'remote-candidate', id: 'R1', candidateType: 'host' },
    ]),
    out,
  );
  assert.equal(out.cand, S.PEER_CAND_RELAY, 'Firefox: the `selected` pair without a transport entry; relay on one side = relay');
  assert.equal(out.rttMs, 100);

  parsePeerStats(
    report([
      { type: 'candidate-pair', id: 'P0', state: 'succeeded', nominated: true, localCandidateId: 'L0', remoteCandidateId: 'R0' },
      { type: 'local-candidate', id: 'L0', candidateType: 'host' },
      { type: 'remote-candidate', id: 'R0', candidateType: 'host' },
    ]),
    out,
  );
  assert.equal(out.cand, S.PEER_CAND_HOST, 'no transport, no selected flag: the nominated succeeded pair');
  assert.equal(out.rttMs, 0, 'no currentRoundTripTime: 0');

  parsePeerStats(report([{ type: 'candidate-pair', id: 'P0', state: 'in-progress', nominated: false }]), out);
  assert.equal(out.cand, S.PEER_CAND_NONE);
  assert.equal(S.PEER_CAND_LABELS[S.PEER_CAND_RELAY], 'relay');
});

test('update() polls getStats once per second and keeps the peer rtt / candidate type', async () => {
  const { mesh, pcs, setTime } = makeMesh(0);
  mesh.addPeer(1);
  await flush();
  const pc1 = pcs.get(0);
  openBoth(pc1);
  pc1.report = [
    { type: 'transport', id: 'T', selectedCandidatePairId: 'P' },
    { type: 'candidate-pair', id: 'P', state: 'succeeded', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.042 },
    { type: 'local-candidate', id: 'L', candidateType: 'srflx' },
    { type: 'remote-candidate', id: 'R', candidateType: 'host' },
  ];
  setTime(5000);
  mesh.update();
  await flush();
  assert.ok(Math.abs(mesh.peerRttMs(1) - 42) < 1e-6);
  assert.equal(mesh.peerCand(1), S.PEER_CAND_SRFLX);
  pc1.report[1].currentRoundTripTime = 0.05;
  setTime(5500);
  mesh.update();
  await flush();
  assert.ok(Math.abs(mesh.peerRttMs(1) - 42) < 1e-6, 'not polled again within a second');
  setTime(6001);
  mesh.update();
  await flush();
  assert.ok(Math.abs(mesh.peerRttMs(1) - 50) < 1e-6);
});

// ---- TURN on demand (audit cost-2): the room's welcome has STUN only --------------------------------

test('TURN: a peer not connected TURN_ASK_AFTER_MS after it was added, or whose ICE goes bad, fires onIceTrouble once', async () => {
  const { mesh, pcs, setTime, time } = makeMesh(0);
  const trouble = [];
  mesh.onIceTrouble = (slot) => trouble.push(slot);
  mesh.addPeer(1);
  mesh.addPeer(2);
  await flush();
  setTime(time() + M.TURN_ASK_AFTER_MS - 1);
  mesh.update();
  assert.deepEqual(trouble, [], 'a direct link takes a second or two');
  openBoth(pcs.get(1)); // slot 2 connects in time
  setTime(time() + 1);
  mesh.update();
  mesh.update();
  assert.deepEqual(trouble, [1], 'slot 1 still connecting: once');
  pcs.get(0).setIce('failed');
  assert.deepEqual(trouble, [1], 'not twice for the same peer');
  pcs.get(1).setIce('failed'); // the connected one loses ICE later
  assert.deepEqual(trouble, [1, 2], 'ICE gone bad: its trouble too');
});

test('TURN: setIceServers applies only a list with a credential: every connection takes it, the ones still connecting restart ICE with a fresh window', async () => {
  const { mesh, pcs, setTime, time } = makeMesh(0);
  const dead = [];
  mesh.onPeerDead = (slot) => dead.push(slot);
  mesh.addPeer(1);
  mesh.addPeer(2);
  await flush();
  openBoth(pcs.get(1)); // slot 2 connected
  const failing = pcs.get(0);
  failing.setIce('failed'); // slot 1: its one restart goes now
  assert.equal(failing.restarts, 1);
  assert.equal(mesh.setIceServers([{ urls: 'stun:stun.example:3478' }]), false, 'STUN only (no TURN on the server): nothing changes');
  assert.equal(failing.reconfigured, undefined);
  setTime(time() + ICE_DEAD_MS - 1000);
  const turn = [{ urls: 'stun:stun.example:3478' }, { urls: ['turn:turn.example:3478?transport=udp'], username: 'u', credential: 'c' }];
  assert.equal(mesh.setIceServers(turn), true);
  assert.deepEqual(failing.config, { iceServers: turn });
  assert.equal(pcs.get(1).reconfigured, 1, 'the connected one takes the servers too');
  assert.equal(failing.restarts, 2, 'restarted with TURN');
  assert.equal(pcs.get(1).restarts, 0, 'a connected link is not restarted');
  failing.setIce('checking');
  setTime(time() + 2000); // past the old window's ICE_DEAD_MS
  failing.setIce('disconnected');
  mesh.update();
  assert.deepEqual(dead, [], 'a fresh ICE_DEAD_MS window after the TURN restart');
});

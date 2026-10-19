// WebRTC transport review fixes (node/rtcTransport.ts, client/rtcSocket.ts), with werift standing in
// for the browser: a bounded answer and an early ICE start when STUN / TURN never answer, close codes
// that survive a lost close frame, no dead connection handed to the room, an honest `relay` in the
// self-test (false without TURN, true through a real local TURN server), and no TURN allocation left
// running when a peer connection closes while werift is still gathering.
import '../dev/ts-resolve.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RTCPeerConnection } = require('werift');
const { answerOffer, rtcSelfTest, withCandidates, GATHER_TIMEOUT_MS, CLOSE_ACK_TIMEOUT_MS } = await import('../node/rtcTransport.ts');
const { RtcSocket } = await import('../client/rtcSocket.ts');
const { encodeRtcClose } = await import('../shared/controlProtocol.ts');
const P = await import('../../src/net/protocol.ts');

const LOCAL = { extraHostAddresses: ['127.0.0.1'] };
const RTC_URL = `wss://site.test/nodes/rtc/${'a'.repeat(16)}/${'b'.repeat(32)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `p`, or a rejection after `ms` (the timer is cleared either way, so it never holds the process). */
function within(p, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** Resolves with fn()'s first truthy value, or rejects after `ms`. */
async function until(fn, ms, what) {
  const end = performance.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** The player's side: werift with a loopback host candidate, like the browser's RTCPeerConnection. */
function clientPeer(cfg = { iceServers: [] }) {
  return new RTCPeerConnection({ ...cfg, iceAdditionalHostAddresses: ['127.0.0.1'], iceUseIpv6: false });
}

/**
 * A STUN / TURN server that never answers: a UDP port that swallows everything and, with `tcp`, a
 * TCP listener on the same port that accepts and then stays silent (werift's worst case: its UDP
 * allocation retries, then a TCP allocation that also never gets an answer, about 13 s in all).
 */
async function blackHole({ tcp = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const udp = dgram.createSocket('udp4');
    udp.on('message', () => undefined);
    await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve));
    const port = udp.address().port;
    if (!tcp) return { port, close: () => udp.close() };
    const socks = new Set();
    const srv = net.createServer((s) => {
      socks.add(s);
      s.on('data', () => undefined);
      s.on('error', () => undefined);
    });
    const listening = await new Promise((resolve) => {
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (!listening) {
      udp.close();
      if (attempt >= 5) throw new Error('no port free for both UDP and TCP');
      continue;
    }
    return {
      port,
      close: () => {
        udp.close();
        for (const s of socks) s.destroy();
        srv.close();
      },
    };
  }
}

// ---- a minimal UDP TURN server (RFC 5766 subset) on werift's own STUN codec ------------------------
// Allocate (401, then long-term credentials), Refresh, CreatePermission, ChannelBind, Send / Data
// indications and ChannelData. Permissions are not enforced. Test-only, so it lives here.
// werift's entry is lib/webrtc/src/index.js: three levels up is the package root (segments, not one
// '../../..' string, so that tools rewriting relative import paths leave it alone).
const weriftRoot = path.resolve(path.dirname(require.resolve('werift')), '..', '..', '..');
const stunLib = (p) => require(path.join(weriftRoot, 'lib/ice-server/src', p));
const { Message, parseMessage } = stunLib('stun/message.js');
const { methods, classes, isStunMessage } = stunLib('stun/const.js');
const { encodeChannelData, decodeChannelData, isChannelData } = stunLib('turn/frame.js');
const { makeTurnIntegrityKey } = stunLib('turn/auth.js');

/**
 * `grantDelay(n)`: how long the n-th allocation (1-based) waits before it is granted (werift keeps
 * retransmitting the same Allocate meanwhile, for about 6.4 s). `lifetime` in seconds: werift
 * refreshes an allocation every 5/6 of it, so a short one shows quickly whether it is still alive.
 */
async function startTurn({ user = 'user', pass = 'pass', realm = 'test', lifetime = 600, grantDelay = () => 0 } = {}) {
  const key = makeTurnIntegrityKey(user, realm, pass);
  const nonce = Buffer.from('0123456789abcdef');
  const srv = dgram.createSocket('udp4');
  /** "ip:port" of the client -> its allocation. */
  const allocs = new Map();
  const stats = { allocations: [], relayedIn: 0, relayedOut: 0 };
  const t0 = performance.now();
  const reply = (req, cls, attrs, to, sign = true) => {
    const m = new Message(req.messageMethod, cls, req.transactionId);
    for (const [k, v] of attrs) m.setAttribute(k, v);
    if (sign) m.addMessageIntegrity(key);
    srv.send(m.bytes, to.port, to.address);
  };
  srv.on('message', async (data, from) => {
    const a = allocs.get(`${from.address}:${from.port}`);
    if (isChannelData(data) && !isStunMessage(data)) {
      const d = decodeChannelData(data);
      const peer = d && a?.chans.get(d.channelNumber);
      if (peer) {
        stats.relayedOut++;
        a.relay.send(Buffer.from(d.data), peer[1], peer[0]);
      }
      return;
    }
    const msg = parseMessage(data);
    if (!msg) return;
    const method = msg.messageMethod;
    if (msg.messageClass === classes.INDICATION && method === methods.SEND && a?.granted) {
      const peer = msg.getAttributeValue('XOR-PEER-ADDRESS');
      const payload = msg.getAttributeValue('DATA');
      if (peer && payload) {
        stats.relayedOut++;
        a.relay.send(payload, peer[1], peer[0]);
      }
      return;
    }
    if (msg.messageClass !== classes.REQUEST) return;
    if (!msg.getAttributeValue('MESSAGE-INTEGRITY')) {
      reply(msg, classes.ERROR, [['ERROR-CODE', [401, 'Unauthorized']], ['REALM', realm], ['NONCE', nonce]], from, false);
      return;
    }
    if (method === methods.ALLOCATE) {
      if (a && !a.granted) return; // a retransmission: the pending grant answers its transaction
      const grant = (al) => {
        const ra = al.relay.address();
        reply(msg, classes.RESPONSE, [['XOR-RELAYED-ADDRESS', [ra.address, ra.port]], ['XOR-MAPPED-ADDRESS', [from.address, from.port]], ['LIFETIME', lifetime]], from);
      };
      if (a) return grant(a);
      const relay = dgram.createSocket('udp4');
      const al = { n: stats.allocations.length + 1, relay, granted: false, grantedAt: null, refreshes: [], chans: new Map(), byPeer: new Map() };
      allocs.set(`${from.address}:${from.port}`, al);
      stats.allocations.push(al);
      await new Promise((resolve) => relay.bind(0, '127.0.0.1', resolve));
      relay.on('message', (pd, pr) => {
        stats.relayedIn++;
        const ch = al.byPeer.get(`${pr.address}:${pr.port}`);
        if (ch !== undefined) {
          srv.send(encodeChannelData(ch, pd), from.port, from.address);
          return;
        }
        const ind = new Message(methods.DATA, classes.INDICATION);
        ind.setAttribute('XOR-PEER-ADDRESS', [pr.address, pr.port]);
        ind.setAttribute('DATA', pd);
        srv.send(ind.bytes, from.port, from.address);
      });
      setTimeout(() => {
        al.granted = true;
        al.grantedAt = performance.now() - t0;
        grant(al);
      }, grantDelay(al.n));
      return;
    }
    if (!a?.granted) {
      reply(msg, classes.ERROR, [['ERROR-CODE', [437, 'Allocation Mismatch']]], from);
      return;
    }
    if (method === methods.REFRESH) {
      a.refreshes.push(performance.now() - t0);
      reply(msg, classes.RESPONSE, [['LIFETIME', lifetime]], from);
      return;
    }
    if (method === methods.CHANNEL_BIND) {
      const ch = msg.getAttributeValue('CHANNEL-NUMBER');
      const peer = msg.getAttributeValue('XOR-PEER-ADDRESS');
      a.chans.set(ch, peer);
      a.byPeer.set(`${peer[0]}:${peer[1]}`, ch);
    }
    reply(msg, classes.RESPONSE, [], from); // ChannelBind, CreatePermission
  });
  await new Promise((resolve) => srv.bind(0, '127.0.0.1', resolve));
  return {
    port: srv.address().port,
    stats,
    /** Milliseconds since the server started (the clock of grantedAt and refreshes). */
    now: () => performance.now() - t0,
    iceServer: (credential = pass) => ({ urls: `turn:127.0.0.1:${srv.address().port}?transport=udp`, username: user, credential }),
    close() {
      for (const al of allocs.values()) al.relay.close();
      srv.close();
    },
  };
}

/**
 * Drop every SCTP packet a werift peer receives while `on()` says so (a lossy path). Test-only hook
 * into werift's DTLS -> SCTP hand-off; SCTP retransmits what was dropped once the path is back.
 */
function lossy(pc) {
  const dtls = pc.sctpTransport.dtlsTransport;
  const deliver = dtls.dataReceiver;
  const st = { dropping: false, dropped: 0 };
  dtls.dataReceiver = (buf) => {
    if (st.dropping) st.dropped++;
    else deliver(buf);
  };
  return st;
}

/**
 * An RtcSocket (the client adapter) connected to answerOffer (the node) through an in-process
 * stand-in for the control plane's /ice and /offer relay. Resolves once both ends are open.
 */
async function connectedPair() {
  let clientPc = null;
  let onConn = null;
  const connP = new Promise((resolve) => (onConn = resolve));
  const drops = [];
  const deps = {
    createPeer: (cfg) => (clientPc = clientPeer(cfg)),
    fetchFn: async (url, init) => {
      const body = JSON.parse(init.body);
      if (url.endsWith('/ice')) return { ok: true, status: 200, json: async () => ({ iceServers: [] }) };
      const sdp = await answerOffer(body.sdp, { iceServers: [], ...LOCAL }, P.WS_SUBPROTOCOL, onConn, () => drops.push(Date.now()));
      return { ok: true, status: 200, json: async () => ({ sdp }) };
    },
  };
  const sock = new RtcSocket(RTC_URL, [P.WS_SUBPROTOCOL, P.WS_TICKET_PREFIX + 'x.y.z'], deps);
  sock.binaryType = 'arraybuffer';
  const st = { sockClosed: null, connClosed: null, toClient: 0, toNode: 0 };
  sock.onmessage = () => st.toClient++;
  sock.onclose = (ev) => (st.sockClosed = { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
  const opened = new Promise((resolve) => (sock.onopen = resolve));
  const conn = await within(connP, 15_000, 'the node side');
  await within(opened, 5_000, 'the client side');
  conn.onmessage = () => st.toNode++;
  conn.onclose = (code, reason) => (st.connClosed = { code, reason });
  // Some traffic both ways first: SCTP then has an RTT estimate (RTO 1 s, its minimum).
  for (let i = 0; i < 20; i++) {
    conn.send(new Uint8Array([1, 2, 3]));
    sock.send(new Uint8Array([4, 5, 6]));
    await sleep(10);
  }
  await until(() => st.toClient >= 20 && st.toNode >= 20, 5_000, 'warm-up traffic');
  assert.equal(drops.length, 0);
  return { sock, conn, clientPc, nodePc: conn.pc, st };
}

/**
 * A raw werift player offering a 'tg' channel to answerOffer with the node's `iceServers`.
 * Resolves with the timings and both ends once the node handed the connection over.
 */
async function rawOffer(iceServers) {
  const client = clientPeer();
  const dc = client.createDataChannel('tg', { ordered: true });
  await client.setLocalDescription(await client.createOffer());
  let dropped = false;
  let onConn = null;
  const connP = new Promise((resolve) => (onConn = resolve));
  const t0 = performance.now();
  const answer = await answerOffer(client.localDescription.sdp, { iceServers, ...LOCAL }, P.WS_SUBPROTOCOL, onConn, () => {
    dropped = true;
    onConn(null);
  });
  const answerMs = performance.now() - t0;
  await client.setRemoteDescription({ type: 'answer', sdp: answer });
  return { client, dc, answer, answerMs, t0, connP, dropped: () => dropped };
}

test('withCandidates puts candidates into their m-section, before its attributes, once', () => {
  const sdp = ['v=0', 'o=- 1 0 IN IP4 0.0.0.0', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', 'a=ice-ufrag:x', 'a=mid:0', ''].join('\r\n');
  const host = { candidate: 'candidate:1 1 udp 2116026367 127.0.0.1 50000 typ host generation 0', sdpMLineIndex: 0 };
  const out = withCandidates(sdp, [host, { ...host }]);
  const lines = out.split('\r\n');
  assert.equal(lines.filter((l) => l.startsWith('a=candidate:')).length, 1);
  assert.equal(lines.indexOf('a=' + host.candidate), lines.indexOf('c=IN IP4 0.0.0.0') + 1);
  assert.ok(out.endsWith('\r\n'));
  assert.equal(withCandidates(out, [host]), out, 'a candidate already present is not repeated');
});

test('dead STUN and TURN servers: the answer goes out within the budget and the channel opens right after', { timeout: 60_000 }, async () => {
  // UDP swallowed, TCP accepted and never answered: werift alone gathers for ~13 s and starts the
  // answer's ICE checks only then (the client's CONNECT_TIMEOUT_MS is 15 s from /ice to open).
  const hole = await blackHole({ tcp: true });
  let run = null;
  let conn = null;
  try {
    const iceServers = [{ urls: `stun:127.0.0.1:${hole.port}` }, { urls: `turn:127.0.0.1:${hole.port}?transport=udp`, username: 'user', credential: 'pass' }];
    run = await rawOffer(iceServers);
    assert.ok(run.answerMs <= GATHER_TIMEOUT_MS + 1_000, `answer after ${Math.round(run.answerMs)} ms`);
    // Gathering was cut short, yet the answer carries the host candidate found so far.
    assert.match(run.answer, /^a=candidate:\S+ 1 udp \d+ 127\.0\.0\.1 \d+ typ host/m);
    conn = await within(run.connP, 30_000, 'the channel');
    const openMs = performance.now() - run.t0;
    assert.equal(run.dropped(), false, 'the seat was dropped');
    assert.equal(conn.open, true);
    // ICE started at the deadline, not when werift's own gathering gave up.
    assert.ok(openMs <= GATHER_TIMEOUT_MS + 2_500, `channel open after ${Math.round(openMs)} ms`);
    const nodePc = conn.pc;
    assert.notEqual(nodePc.iceGatheringState, 'complete', 'werift should still be gathering when the channel opens');
    // werift's own ICE start, once its gathering ends, joins the running one: the connection stays up.
    let toClient = 0;
    let toNode = 0;
    run.dc.onMessage.subscribe(() => toClient++);
    conn.onmessage = () => toNode++;
    await until(() => nodePc.iceGatheringState === 'complete', 25_000, "werift's gathering to end");
    await sleep(500);
    for (let i = 0; i < 10; i++) {
      conn.send(new Uint8Array([1]));
      run.dc.send(Buffer.from([2]));
    }
    await until(() => toClient >= 10 && toNode >= 10, 5_000, 'traffic after the gathering ended');
    assert.ok(['connected', 'completed'].includes(nodePc.iceConnectionState), nodePc.iceConnectionState);
    assert.equal(conn.open, true);
  } finally {
    if (conn && typeof conn.close === 'function') conn.close(1000, 'done');
    if (run) await run.client.close();
    hole.close();
  }
});

test("the node's close code survives a lost close frame (not 1006)", { timeout: 30_000 }, async () => {
  const { conn, clientPc, st } = await connectedPair();
  const loss = lossy(clientPc);
  // The first transmission of the close frame is lost; SCTP retransmits it after its RTO (1 s).
  loss.dropping = true;
  setTimeout(() => (loss.dropping = false), 400);
  const t0 = performance.now();
  conn.close(4000, 'replaced');
  await until(() => st.sockClosed && st.connClosed, CLOSE_ACK_TIMEOUT_MS + 2_000, 'both ends closed');
  assert.ok(loss.dropped > 0, 'the close frame was dropped at least once');
  assert.deepEqual(st.sockClosed, { code: 4000, reason: 'replaced', wasClean: true });
  assert.deepEqual(st.connClosed, { code: 4000, reason: 'replaced' });
  // The client's close of the channel is the acknowledgement: no need to wait for the fallback.
  assert.ok(performance.now() - t0 < CLOSE_ACK_TIMEOUT_MS, `closed after ${Math.round(performance.now() - t0)} ms`);
});

test("the player's close code survives a lost close frame too", { timeout: 30_000 }, async () => {
  const { sock, nodePc, st } = await connectedPair();
  const loss = lossy(nodePc);
  loss.dropping = true;
  setTimeout(() => (loss.dropping = false), 400);
  sock.close(1000, 'bye');
  await until(() => st.sockClosed && st.connClosed, CLOSE_ACK_TIMEOUT_MS + 2_000, 'both ends closed');
  assert.ok(loss.dropped > 0, 'the close frame was dropped at least once');
  assert.deepEqual(st.connClosed, { code: 1000, reason: 'bye' });
  assert.deepEqual(st.sockClosed, { code: 1000, reason: 'bye', wasClean: true });
});

test('a close with nobody answering still ends after the fallback, with our code', { timeout: 30_000 }, async () => {
  const { conn, clientPc, st } = await connectedPair();
  const loss = lossy(clientPc);
  loss.dropping = true; // the player is gone for good
  const t0 = performance.now();
  conn.close(1000, 'cancelled');
  await until(() => st.connClosed, CLOSE_ACK_TIMEOUT_MS + 2_000, 'the node side closed');
  const ms = performance.now() - t0;
  assert.deepEqual(st.connClosed, { code: 1000, reason: 'cancelled' });
  assert.ok(ms >= CLOSE_ACK_TIMEOUT_MS - 50 && ms < CLOSE_ACK_TIMEOUT_MS + 1_000, `node closed after ${Math.round(ms)} ms`);
  await clientPc.close();
});

test('a channel that dies before it is handed over never reaches onConn; its seat is freed', { timeout: 60_000 }, async () => {
  for (let i = 0; i < 3; i++) {
    const client = clientPeer();
    try {
      const dc = client.createDataChannel('tg', { ordered: true });
      // Queued before the channel opens: werift sends it right behind the DCEP OPEN, so the node
      // reads the close frame in the same turn as the open, before the deferred hand-over.
      dc.send(Buffer.from(encodeRtcClose(1000, 'bye')));
      await client.setLocalDescription(await client.createOffer());
      const calls = [];
      const sdp = await answerOffer(
        client.localDescription.sdp,
        { iceServers: [], ...LOCAL },
        P.WS_SUBPROTOCOL,
        (c) => calls.push(['conn', c.open]),
        () => calls.push(['drop']),
      );
      await client.setRemoteDescription({ type: 'answer', sdp });
      await until(() => calls.length > 0, 15_000, 'onConn or onDrop');
      await sleep(200);
      assert.deepEqual(calls, [['drop']], `round ${i}: ${JSON.stringify(calls)}`);
    } finally {
      await client.close();
    }
  }
});

test('rtcSelfTest without TURN connects over host candidates and says relay: false', { timeout: 60_000 }, async () => {
  const r = await rtcSelfTest({ iceServers: [], ...LOCAL });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.relay, false);
});

test('rtcSelfTest through a working TURN server says relay: true, and the server relayed the traffic', { timeout: 60_000 }, async () => {
  const turn = await startTurn();
  try {
    const r = await rtcSelfTest({ iceServers: [turn.iceServer()], ...LOCAL }, 8_000);
    assert.deepEqual({ ok: r.ok, relay: r.relay }, { ok: true, relay: true }, JSON.stringify(r));
    assert.ok(turn.stats.allocations.length >= 1, 'no allocation');
    assert.ok(turn.stats.relayedIn > 0 && turn.stats.relayedOut > 0, JSON.stringify({ in: turn.stats.relayedIn, out: turn.stats.relayedOut }));
    // With a STUN server too (the usual configuration), the relay-only side still proves the relay.
    const r2 = await rtcSelfTest({ iceServers: [{ urls: `stun:127.0.0.1:${turn.port}` }, turn.iceServer()], ...LOCAL }, 8_000);
    assert.deepEqual({ ok: r2.ok, relay: r2.relay }, { ok: true, relay: true }, JSON.stringify(r2));
  } finally {
    turn.close();
  }
});

test('rtcSelfTest with a TURN url but no credentials fails instead of passing over host candidates', { timeout: 30_000 }, async () => {
  const turn = await startTurn();
  try {
    for (const server of [{ urls: `turn:127.0.0.1:${turn.port}` }, { urls: [`TURN:127.0.0.1:${turn.port}?transport=udp`], username: 'user' }]) {
      const r = await rtcSelfTest({ iceServers: [{ urls: 'stun:127.0.0.1:9' }, server], ...LOCAL }, 5_000);
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.relay, false);
      assert.match(r.error ?? '', /credential/);
    }
    assert.equal(turn.stats.allocations.length, 0, 'the TURN server was contacted');
  } finally {
    turn.close();
  }
});

test('a peer connection closed while werift is still allocating on TURN leaves no allocation alive', { timeout: 90_000 }, async () => {
  // LIFETIME 1 s: werift refreshes a live allocation every ~0.83 s, so a leaked one shows at once.
  const OBSERVE_MS = 2_500;
  const alive = (al) => al.refreshes.filter((t) => t > al.grantedAt + 300).length;

  // 1. answerOffer: the node's TURN allocation is granted 5.5 s in (werift still retrying it); the
  //    channel opens at the deadline and the player leaves before the grant.
  const slow = await startTurn({ lifetime: 1, grantDelay: () => 5_500 });
  let run = null;
  try {
    run = await rawOffer([slow.iceServer()]);
    const conn = await within(run.connP, 15_000, 'the channel');
    assert.ok(conn && conn.open, 'no connection');
    let closed = null;
    conn.onclose = (code) => (closed = code);
    run.dc.close();
    await until(() => closed !== null, 3_000, 'the close');
    const [al] = slow.stats.allocations;
    assert.ok(al, 'the node never asked for an allocation');
    assert.equal(al.granted, false, 'the allocation was granted before the close: nothing tested');
    await until(() => al.granted, 10_000, 'the grant');
    await sleep(OBSERVE_MS);
    assert.equal(alive(al), 0, `allocation refreshed after the close at ${JSON.stringify(al.refreshes.map(Math.round))} (granted ${Math.round(al.grantedAt)})`);
  } finally {
    if (run) await run.client.close();
    slow.close();
  }

  // 2. rtcSelfTest: the relay-only side gets its allocation at once, the other side's comes after
  //    the self-test returned.
  const mixed = await startTurn({ lifetime: 1, grantDelay: (n) => (n === 1 ? 0 : 5_500) });
  try {
    const r = await rtcSelfTest({ iceServers: [mixed.iceServer()], ...LOCAL }, 8_000);
    const returnedAt = mixed.now();
    assert.deepEqual({ ok: r.ok, relay: r.relay }, { ok: true, relay: true }, JSON.stringify(r));
    assert.equal(mixed.stats.allocations.length, 2);
    const late = mixed.stats.allocations[1];
    assert.equal(late.granted, false, 'the late allocation was granted before the self-test returned: nothing tested');
    await until(() => late.granted, 10_000, 'the late grant');
    await sleep(OBSERVE_MS);
    for (const al of mixed.stats.allocations) {
      const after = al.refreshes.filter((t) => t > Math.max(returnedAt, al.grantedAt) + 300);
      assert.equal(after.length, 0, `allocation #${al.n} refreshed after the self-test: ${JSON.stringify(after.map(Math.round))}`);
    }
  } finally {
    mixed.close();
  }
});

// End-to-end smoke test of the phase 2 signaling path against a running Worker: `wrangler dev
// --port 8787` (run from server/) or a deploy. Node 24 (global fetch + WebSocket), no browser, no
// WebRTC: the two "peers" are plain WebSocket clients that exchange a fake SDP through the room.
//   node test/smoke-p2p.mjs                                (server/: local wrangler dev)
//   API=https://turbo-gol.com node server/test/smoke-p2p.mjs
//
// Options (flags win over env): --api=<base url> / API (default http://127.0.0.1:8787), --session-a /
// --session-b (ready-made guest sessions when the deploy has Turnstile on; see smoke.mjs),
// --skip-fallback (skip the 15 s lone-human test).
//
// Flow: health -> guest A, guest B -> both POST /api/queue { mode: '1v1', kind: 'p2p', p2pProtocol: P2P_PROTOCOL } at once -> both
// matched with kind 'p2p', the same roomId and a wsUrl ending in /room/<id> -> GET /api/ice (STUN) ->
// both open the room socket with ['tg1', 'ticket.<jwt>'] -> each gets a RoomWelcome (protocol 2, 2 peer
// slots, same seed, distinct 'you', iceServers with Cloudflare STUN) and B sees A's 'peerJoined' ->
// a reused ticket is refused -> A signals B (fake offer) and B receives it with from = A's slot ->
// ping/pong -> both 'ready' -> both receive 'start' with the same startAt ~1.5 s ahead (an
// 'unreachable' sent before the start is ignored) -> A reports slot B unreachable at tick 100: no
// drop (B's room socket is alive and talking: a lone report never picks who leaves) -> B reports A
// at tick 120 (the link is dead both ways) -> both receive 'drop' { slot: B, atTick: 100 } and
// 'drop' { slot: A, atTick: 120 } -> A closes: B gets 'peerLeft' and A can queue again at once (its
// lock is released with the socket) -> B closes. 2v2 with four humans: grace-alarm drop and majority drop; a
// second 2v2 where an unready peer leaves -> 'start' for the three ready ones + its drop at tick 0.
// Lock release (8d / 8e): a signal to a slot without a socket answers error 'signal_dropped' { to };
// /api/rejoin with a room id -> 410 p2p_room; a peer that closes its room socket before the start
// queues again within 1 s (no 409: the matchmaker verifies the lock with the room); a peer that never
// connected frees its lock with POST /api/leave; /api/leave during a live room closes that peer's
// socket (1000 'left'), the other peer gets 'peerLeft', the leaver queues at once; the peer still in
// the room gets 409 with a reason. Staggered joins / no-shows (8f-8h, protocol 2): a p2p queue
// without p2pProtocol answers 426 reload_required; in a 2v2 where two peers are ready and two join
// 2 s later the start waits for all four (no drop); in a 2v2 where one ticket is never used the room
// declares it a no-show after P2P_NO_SHOW_MS ('peerLeft' { slot, peerId: '' }), the present peers
// start and get 'drop' { slot, 0 }, the dead ticket is refused (and, since it did reach the room,
// late, its strike is forgiven); three unused tickets -> the p2p queue answers 429 no_show
// (retryAfterMs) while a server queue still works. Then a lone guest C
// queues p2p 1v1 and, after ~15 s, gets the phase 1 QueueResult (matchId, wsUrl /ws/<id>) of a
// Durable Object match with a bot.
// Exit 0 = pass, 1 = a check failed, 2 = cannot run (no session: Turnstile).
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND') {
        if (!/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
        if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
});

const P = await import('../../src/net/protocol.ts');
const P2 = await import('../../src/net/p2p/protocol.ts');
/** What the client sends in a p2p queue (P2P_PROTOCOL_VERSION); without it the Worker answers 426 reload_required. */
const P2P_PROTOCOL = P2.P2P_PROTOCOL_VERSION;

// ---- options ---------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const argOf = (name) => {
  const a = argv.find((s) => s.startsWith(`--${name}=`));
  return a === undefined ? undefined : a.slice(name.length + 3);
};
const API = (argOf('api') ?? process.env.API ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const SESSION_A = (argOf('session-a') ?? process.env.SESSION_A ?? '').trim();
const SESSION_B = (argOf('session-b') ?? process.env.SESSION_B ?? '').trim();
const SKIP_FALLBACK = argv.includes('--skip-fallback') || process.env.SKIP_FALLBACK === '1';
if (!/^https?:\/\//.test(API)) {
  console.error(`API must be an http(s) URL, got '${API}'`);
  process.exit(2);
}
const WS_BASE = API.replace(/^http/, 'ws');
/** The matchmaker's p2p fill wait (src/net/p2p/protocol.ts P2P_FILL_WAIT_MS) + the long-poll slack. */
const FALLBACK_WAIT_MS = 15_000;
const START_DELAY_MS = 1_500;
/** server/src/RoomDO.ts DROP_LEAD_TICKS: the drop tick is min(reported), nothing added. */
const DROP_LEAD_TICKS = 0;

const t0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - t0) / 1000).toFixed(2)}s]`, ...a);
let failures = 0;
const check = (cond, msg) => {
  if (cond) log('ok  ', msg);
  else {
    failures++;
    log('FAIL', msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(API + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

function resolveWs(wsUrl) {
  if (/^wss?:\/\//.test(wsUrl)) return wsUrl;
  if (/^https?:\/\//.test(wsUrl)) return wsUrl.replace(/^http/, 'ws');
  return WS_BASE + (wsUrl.startsWith('/') ? '' : '/') + wsUrl;
}

async function guest(name, session) {
  if (session.length > 0) {
    log(`${name}: using the SESSION token from env`);
    return session;
  }
  const g = await api('/api/guest', { name });
  if ((g.status === 403 && g.json?.error === 'turnstile_failed') || (g.status === 503 && g.json?.error === 'turnstile_unconfigured')) {
    log(`POST /api/guest -> ${g.status} ${g.json?.error}: this deploy only registers guests through Turnstile; pass SESSION_A / SESSION_B (see smoke.mjs)`);
    process.exit(2);
  }
  check(g.status === 200 && typeof g.json?.session === 'string', `POST /api/guest (${name}) -> ${g.status} ${g.text.slice(0, 100)}`);
  if (!g.json?.session) process.exit(1);
  return g.json.session;
}

/** A JSON WebSocket client for the room: queues every message; `next(type)` resolves the next one of that type. */
class RoomPeer {
  constructor(label, url, ticket) {
    this.label = label;
    this.inbox = [];
    this.waiters = [];
    this.closed = null;
    this.opened = new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, [P.WS_SUBPROTOCOL, P.WS_TICKET_PREFIX + ticket]);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`${label}: socket error`));
      this.ws.onclose = (e) => {
        this.closed = e;
        reject(new Error(`${label}: closed ${e.code} ${e.reason}`));
        for (const w of this.waiters.splice(0)) w.reject(new Error(`${label}: closed ${e.code} ${e.reason} while waiting for '${w.type}'`));
      };
      this.ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          check(false, `${label}: non-JSON frame`);
          return;
        }
        const i = this.waiters.findIndex((w) => w.type === msg.type);
        if (i >= 0) this.waiters.splice(i, 1)[0].resolve(msg);
        else this.inbox.push(msg);
      };
    });
    this.opened.catch(() => undefined);
  }
  next(type, timeoutMs = 5000) {
    const i = this.inbox.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    if (this.closed) return Promise.reject(new Error(`${this.label}: already closed (${this.closed.code})`));
    return new Promise((resolve, reject) => {
      const w = { type, resolve, reject };
      const timer = setTimeout(() => {
        const j = this.waiters.indexOf(w);
        if (j >= 0) this.waiters.splice(j, 1);
        reject(new Error(`${this.label}: no '${type}' within ${timeoutMs} ms (inbox: ${this.inbox.map((m) => m.type).join(',') || 'empty'})`));
      }, timeoutMs);
      w.resolve = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
      w.reject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      this.waiters.push(w);
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  /** Resolves with the close event (ours or the server's), or null after `timeoutMs`. */
  whenClosed(timeoutMs = 5000) {
    return new Promise((resolve) => {
      if (this.closed) return resolve(this.closed);
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const prev = this.ws.onclose;
      this.ws.onclose = (e) => {
        clearTimeout(timer);
        prev?.(e);
        resolve(e);
      };
    });
  }
  close(code = 1000) {
    const done = this.whenClosed(10_000);
    this.ws.close(code, 'done');
    return done;
  }
}

/** POST /api/queue that must NOT answer 409: after 300 ms the queue is left (the long-poll then answers 'waiting' at once); resolves with the answer. */
async function queueThenLeave(label, session, body) {
  const pending = api('/api/queue', body, session);
  await sleep(300);
  const left = await api('/api/leave', {}, session);
  const q = leftQueue(await Promise.race([pending, sleep(4000).then(() => ({ status: 0, json: null, text: 'timeout' }))]));
  log(`${label}: POST /api/queue -> ${q.status} ${q.text.slice(0, 80)}; left ${left.json?.left}`);
  return q;
}

/**
 * The Worker's /api/queue is join + long-poll. On the deploy the leave can land between the two
 * (Worker <-> matchmaker latency): the join succeeded (no 409) and the poll then finds the player
 * gone -> 404 not_queued. Same outcome as 'waiting' for these checks: queued, then left.
 */
function leftQueue(q) {
  if (q.status === 404 && q.json?.error === 'not_queued') return { status: 200, json: { status: 'waiting', waiting: 0, raced: true }, text: '{"status":"waiting","raced":"leave before poll"}' };
  return q;
}

async function expectNext(peer, type, timeoutMs) {
  try {
    return await peer.next(type, timeoutMs);
  } catch (e) {
    check(false, e.message);
    return null;
  }
}

// ---- 1. health + two guests -----------------------------------------------------------------------
log(`target ${API} (sockets ${WS_BASE})`);
const health = await api('/api/health');
check(health.status === 200 && health.json?.ok === true, `GET /api/health -> ${health.status} ${health.text}`);
const sessionA = await guest('Peer A', SESSION_A);
const sessionB = await guest('Peer B', SESSION_B);
const badKind = await api('/api/queue', { mode: '1v1', kind: 'nope' }, sessionA);
check(badKind.status === 400 && badKind.json?.error === 'bad_kind', `POST /api/queue bad kind -> ${badKind.status} ${badKind.json?.error}`);
// A page from before the protocol bump (no p2pProtocol) or of another version is told to reload, before any seat.
const stale = await api('/api/queue', { mode: '1v1', kind: 'p2p' }, sessionA);
check(stale.status === 426 && stale.json?.error === 'reload_required' && stale.json?.p2pProtocol === P2P_PROTOCOL, `p2p queue without p2pProtocol (a version 1 page) -> ${stale.status} ${stale.json?.error}: ${stale.json?.message}`);
const otherVersion = await api('/api/queue', { mode: '1v1', kind: 'p2p', p2pProtocol: P2P_PROTOCOL + 1 }, sessionA);
check(otherVersion.status === 426 && otherVersion.json?.error === 'reload_required', `p2p queue with p2pProtocol ${P2P_PROTOCOL + 1} -> ${otherVersion.status} ${otherVersion.json?.error}`);

// ---- 2. both queue p2p 1v1 at once -> the same room --------------------------------------------------
// Each request long-polls up to 25 s; a 'waiting' answer (e.g. the poll landed while the room was
// being created) is simply asked again, as the client does.
async function queueUntilMatched(label, session, body, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    const q = await api('/api/queue', body, session);
    log(`${label}: POST /api/queue -> ${q.status} ${q.text.slice(0, 120)}`);
    if (q.status !== 200 || q.json?.status === 'matched') return q;
  }
  return { status: 0, json: null, text: 'never matched' };
}
const tQueue = performance.now();
const [qa, qb] = await Promise.all([queueUntilMatched('A', sessionA, { mode: '1v1', kind: 'p2p', p2pProtocol: P2P_PROTOCOL }), queueUntilMatched('B', sessionB, { mode: '1v1', kind: 'p2p', p2pProtocol: P2P_PROTOCOL })]);
check(qa.status === 200 && qa.json?.status === 'matched' && qa.json?.kind === 'p2p', `A matched p2p (${((performance.now() - tQueue) / 1000).toFixed(2)} s for both)`);
check(qb.status === 200 && qb.json?.status === 'matched' && qb.json?.kind === 'p2p', 'B matched p2p');
if (qa.json?.status !== 'matched' || qb.json?.status !== 'matched') process.exit(1);
const roomId = qa.json.roomId;
check(/^[0-9a-f]{64}$/.test(roomId) && qb.json.roomId === roomId, `same roomId ${roomId.slice(0, 12)}...`);
check(typeof qa.json.ticket === 'string' && qa.json.ticket.split('.').length === 3 && qa.json.ticket !== qb.json.ticket, 'distinct JWT tickets');
check(typeof qa.json.wsUrl === 'string' && qa.json.wsUrl.endsWith('/room/' + roomId), `wsUrl ${qa.json.wsUrl}`);
const again = await api('/api/queue', { mode: '1v1', kind: 'p2p', p2pProtocol: P2P_PROTOCOL }, sessionA);
check(again.status === 409 && again.json?.error === 'active_match' && again.json?.matchId === roomId && again.json?.kind === 'p2p', `queue again while the room is alive -> ${again.status} ${again.json?.error} kind ${again.json?.kind}`);

// ---- 3. /api/ice ----------------------------------------------------------------------------------
const iceNoAuth = await api('/api/ice');
check(iceNoAuth.status === 401, `GET /api/ice without a session -> ${iceNoAuth.status}`);
const ice = await api('/api/ice', undefined, sessionA);
const stunOk = Array.isArray(ice.json?.iceServers) && ice.json.iceServers.some((s) => [].concat(s.urls).includes('stun:stun.cloudflare.com:3478'));
check(ice.status === 200 && stunOk, `GET /api/ice -> ${ice.status} ${ice.text.slice(0, 160)}`);
const hasTurn = Array.isArray(ice.json?.iceServers) && ice.json.iceServers.some((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));
log(`TURN credentials ${hasTurn ? 'present (TURN_KEY_ID / TURN_KEY_TOKEN configured)' : 'absent (STUN only: no TURN secrets)'}`);

// ---- 4. room sockets + welcome ----------------------------------------------------------------------
const wsTarget = resolveWs(qa.json.wsUrl);
const A = new RoomPeer('A', wsTarget, qa.json.ticket);
try {
  await A.opened;
} catch (e) {
  check(false, e.message);
  process.exit(1);
}
check(A.ws.protocol === P.WS_SUBPROTOCOL, `A negotiated subprotocol '${A.ws.protocol}'`);
const welcomeA = await expectNext(A, 'room');
if (!welcomeA) process.exit(1);
log(`A welcome: slot ${welcomeA.you?.slot} peer ${welcomeA.you?.peerId} seed ${welcomeA.seed} slots ${JSON.stringify(welcomeA.slots?.map((s) => `${s.slot}:${s.kind}/${s.team}${s.connected ? '*' : ''}`))}`);
check(welcomeA.protocol === P2P_PROTOCOL && welcomeA.roomId === roomId && welcomeA.mode === '1v1', `A: protocol ${welcomeA.protocol} (client ${P2P_PROTOCOL}), roomId, mode`);
check(Number.isInteger(welcomeA.seed) && welcomeA.seed >= 0 && welcomeA.seed <= 0xffffffff, `A: seed is a uint32 (${welcomeA.seed})`);
check(welcomeA.inputDelay === 3 && welcomeA.window === 16 && welcomeA.hashEvery === 30 && welcomeA.tickRate === 120, 'A: inputDelay 3, window 16, hashEvery 30, tickRate 120');
check(typeof welcomeA.matchLengthSeconds === 'number' && typeof welcomeA.now === 'number' && Math.abs(welcomeA.now - Date.now()) < 60_000, `A: matchLengthSeconds ${welcomeA.matchLengthSeconds}, now within a minute of ours`);
check(Array.isArray(welcomeA.slots) && welcomeA.slots.length === 2 && welcomeA.slots.every((s) => s.kind === 'peer'), 'A: 2 peer slots');
check(welcomeA.slots?.[welcomeA.you?.slot]?.connected === true && welcomeA.slots?.[welcomeA.you?.slot]?.peerId === welcomeA.you?.peerId, 'A: own slot connected with own peerId');
check(welcomeA.slots?.[1 - welcomeA.you?.slot]?.connected === false, 'A: the other slot is not connected yet');
check(Array.isArray(welcomeA.iceServers) && welcomeA.iceServers.some((s) => [].concat(s.urls).includes('stun:stun.cloudflare.com:3478')), 'A: welcome carries the STUN server');

// a reused ticket is refused (single-use jti)
const reuse = await new Promise((resolve) => {
  const ws = new WebSocket(wsTarget, [P.WS_SUBPROTOCOL, P.WS_TICKET_PREFIX + qa.json.ticket]);
  const timer = setTimeout(() => resolve('timeout'), 5000);
  ws.onopen = () => {
    clearTimeout(timer);
    resolve('opened');
    ws.close();
  };
  ws.onerror = () => {
    clearTimeout(timer);
    resolve('rejected');
  };
  ws.onclose = () => {
    clearTimeout(timer);
    resolve('rejected');
  };
});
check(reuse === 'rejected', `reused ticket -> ${reuse}`);
// A's socket must have survived that (the refused upgrade never reached its slot)
check(A.closed === null, 'A still connected after the refused reuse');

const B = new RoomPeer('B', wsTarget, qb.json.ticket);
try {
  await B.opened;
} catch (e) {
  check(false, e.message);
  process.exit(1);
}
const welcomeB = await expectNext(B, 'room');
if (!welcomeB) process.exit(1);
log(`B welcome: slot ${welcomeB.you?.slot} peer ${welcomeB.you?.peerId}`);
check(welcomeB.seed === welcomeA.seed && welcomeB.roomId === roomId, 'B: same seed and roomId');
check(welcomeB.you?.slot !== welcomeA.you?.slot && welcomeB.you?.peerId !== welcomeA.you?.peerId, `B: distinct you (slot ${welcomeB.you?.slot} vs ${welcomeA.you?.slot})`);
check(welcomeB.slots?.[welcomeA.you?.slot]?.connected === true && welcomeB.slots?.[welcomeA.you?.slot]?.peerId === welcomeA.you?.peerId, 'B: sees A connected with its peerId');
const joined = await expectNext(A, 'peerJoined');
check(joined !== null && joined.slot?.slot === welcomeB.you?.slot && joined.slot?.peerId === welcomeB.you?.peerId && joined.slot?.connected === true, `A: peerJoined for B (${JSON.stringify(joined?.slot)})`);
const slotA = welcomeA.you.slot;
const slotB = welcomeB.you.slot;

// ---- 5. signal relay, ping ----------------------------------------------------------------------------
const fakeOffer = { sdp: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' } };
A.send({ type: 'signal', to: slotB, data: fakeOffer });
const sig = await expectNext(B, 'signal');
check(sig !== null && sig.from === slotA && JSON.stringify(sig.data) === JSON.stringify(fakeOffer), 'B received the signal from A, data intact');
B.send({ type: 'signal', to: slotA, data: { candidate: null } });
const sig2 = await expectNext(A, 'signal');
check(sig2 !== null && sig2.from === slotB && sig2.data?.candidate === null, 'A received the end-of-candidates signal from B');
A.send({ type: 'signal', to: slotA, data: fakeOffer }); // to self: dropped
A.send({ type: 'signal', to: 7, data: fakeOffer }); // no such slot: dropped
A.send({ type: 'bogus', x: 1 }); // unknown type: ignored
const tPing = performance.now();
A.send({ type: 'ping', t0: 12345 });
const pong = await expectNext(A, 'pong');
check(pong !== null && pong.t0 === 12345 && typeof pong.now === 'number', `pong in ${(performance.now() - tPing).toFixed(1)} ms (server now ${pong?.now})`);
check(A.inbox.length === 0 && B.inbox.length === 0, `no stray messages (A ${A.inbox.map((m) => m.type).join(',')} | B ${B.inbox.map((m) => m.type).join(',')})`);

// ---- 6. ready -> start ------------------------------------------------------------------------------
A.send({ type: 'unreachable', slot: slotB, atTick: 50 });
A.send({ type: 'ready' });
await sleep(300);
check(A.inbox.length === 0 && B.inbox.length === 0, 'no start while only A is ready; an unreachable report before the start is ignored (no drop)');
const tReady = performance.now();
B.send({ type: 'ready' });
const [startA, startB] = await Promise.all([expectNext(A, 'start'), expectNext(B, 'start')]);
check(startA !== null && startB !== null && startA.startAt === startB.startAt, `both received start (startAt ${startA?.startAt}) ${(performance.now() - tReady).toFixed(0)} ms after the last ready`);
check(startA !== null && startA.startAt - startA.now === START_DELAY_MS, `startAt is now + ${START_DELAY_MS} ms on the server clock (got +${startA ? startA.startAt - startA.now : '?'})`);
B.send({ type: 'hashReport', tick: 30, hash: 123456, agree: 1, disagree: 0 });

// ---- 7. unreachable -> drop (1v1: a lone report about a live peer drops nobody; a link dead both ways drops both) ----
A.send({ type: 'unreachable', slot: slotB, atTick: 100 });
await sleep(300);
check(!A.inbox.some((m) => m.type === 'drop') && !B.inbox.some((m) => m.type === 'drop'), "no drop on a lone report: B's room socket is alive");
B.send({ type: 'unreachable', slot: slotA, atTick: 120 });
const [dropA, dropB] = await Promise.all([expectNext(A, 'drop'), expectNext(B, 'drop')]);
const [dropA2, dropB2] = await Promise.all([expectNext(A, 'drop'), expectNext(B, 'drop')]);
const pairOf = (x, y) => [x, y].filter((d) => d !== null).map((d) => `${d.slot}@${d.atTick}`).sort().join(' ');
const want = [`${slotA}@${120 + DROP_LEAD_TICKS}`, `${slotB}@${100 + DROP_LEAD_TICKS}`].sort().join(' ');
check(pairOf(dropA, dropA2) === want && pairOf(dropB, dropB2) === want, `a link dead both ways: both received both drops (${pairOf(dropA, dropA2)})`);
// B was dropped: its lock is free -> B can queue again right away (then leaves the queue)
{
  const pending = api('/api/queue', { mode: '2v2', kind: 'p2p', p2pProtocol: P2P_PROTOCOL }, sessionB);
  await sleep(300);
  const left = await api('/api/leave', {}, sessionB);
  const q = leftQueue(await Promise.race([pending, sleep(4000).then(() => ({ status: 0, json: null, text: 'timeout' }))]));
  check(q.status === 200 && q.json?.status === 'waiting' && left.json?.left === true, `B (dropped) can queue again: ${q.status} ${q.text.slice(0, 60)}; left ${left.json?.left}`);
}

// ---- 8. close -----------------------------------------------------------------------------------------
await A.close(1000);
const leftMsg = await expectNext(B, 'peerLeft');
check(leftMsg !== null && leftMsg.slot === slotA && leftMsg.peerId === welcomeA.you.peerId, `B received peerLeft for A (${JSON.stringify(leftMsg)})`);
{
  // A's lock is released with its socket: queue -> not 409 (then leave the queue at once)
  await sleep(300);
  const pending = api('/api/queue', { mode: '2v2', kind: 'p2p', p2pProtocol: P2P_PROTOCOL }, sessionA);
  await sleep(300);
  const left = await api('/api/leave', {}, sessionA);
  const q = await Promise.race([pending, sleep(4000).then(() => ({ status: 0, json: null, text: 'timeout' }))]);
  check(q.status === 200 && q.json?.status === 'waiting' && left.json?.left === true, `A can queue again after closing its room socket: ${q.status} ${q.text.slice(0, 60)}; left ${left.json?.left}`);
}
const closedB = await B.close(1000);
check(closedB.code === 1000, `B closed (${closedB.code})`);

// ---- 8b. 2v2 with four humans: the close-grace alarm and the majority vote ---------------------------------
// A and B are free again (lock released with the socket / the drop); D and E are new guests (reused by
// 8d, as F and G are by 8e: POST /api/guest is limited to 10 per client IP per minute).
let sessionD = '';
let sessionE = '';
let sessionF = '';
let sessionG = '';
{
  sessionD = await guest('Peer D', '');
  sessionE = await guest('Peer E', '');
  const four = [
    ['A', sessionA],
    ['B', sessionB],
    ['D', sessionD],
    ['E', sessionE],
  ];
  const results = await Promise.all(four.map(([label, s]) => queueUntilMatched(label, s, { mode: '2v2', kind: 'p2p', p2pProtocol: P2P_PROTOCOL })));
  const room2 = results[0].json?.roomId;
  check(results.every((r) => r.status === 200 && r.json?.status === 'matched' && r.json?.kind === 'p2p' && r.json?.roomId === room2), `2v2: all four matched into room ${String(room2).slice(0, 12)}...`);
  if (results.every((r) => r.json?.status === 'matched' && r.json?.kind === 'p2p')) {
    const peers = results.map((r, i) => new RoomPeer(four[i][0], resolveWs(r.json.wsUrl), r.json.ticket));
    const welcomes = [];
    for (const p of peers) {
      try {
        await p.opened;
        welcomes.push(await p.next('room'));
      } catch (e) {
        check(false, e.message);
        welcomes.push(null);
      }
    }
    const slots = welcomes.map((w) => w?.you?.slot);
    check(welcomes.every((w) => w !== null && w.slots.length === 4 && w.slots.every((s) => s.kind === 'peer')), `2v2 welcomes: 4 peer slots, slots ${slots.join(',')}`);
    check(new Set(slots).size === 4 && welcomes.every((w) => w?.seed === welcomes[0]?.seed), '2v2: distinct slots, one seed');
    // everyone ready -> start (the peerJoined messages of the later joiners are drained first)
    for (const p of peers) p.inbox.length = 0;
    for (const p of peers) p.send({ type: 'ready' });
    const starts = await Promise.all(peers.map((p) => expectNext(p, 'start')));
    check(starts.every((s) => s !== null && s.startAt === starts[0].startAt), `2v2: start to all four (startAt ${starts[0]?.startAt})`);
    const [pA, pB, pD, pE] = peers;
    const [sA, sB, , sE] = slots;
    // E leaves; A alone reports it: 1 of 3 voters is no majority, but E's socket is closed, so the
    // room re-checks after the 5 s grace (alarm) and drops E without a second report.
    await pE.close(1000);
    await Promise.all([pA, pB, pD].map((p) => expectNext(p, 'peerLeft')));
    const tGrace = performance.now();
    pA.send({ type: 'unreachable', slot: sE, atTick: 200 });
    await sleep(1500);
    check(![pA, pB, pD].some((p) => p.inbox.some((m) => m.type === 'drop')), 'no drop yet: one report of three voters, socket closed < 5 s ago');
    const dropsE = await Promise.all([pA, pB, pD].map((p) => expectNext(p, 'drop', 9000)));
    check(dropsE.every((d) => d !== null && d.slot === sE && d.atTick === 200 + DROP_LEAD_TICKS), `drop { slot: ${sE}, atTick: ${dropsE[0]?.atTick} } to the three others ${((performance.now() - tGrace) / 1000).toFixed(1)} s after the report (grace alarm)`);
    // B stays connected: A then D report it -> 2 of the 2 remaining voters -> drop at min(310, 300)
    pA.send({ type: 'unreachable', slot: sB, atTick: 310 });
    await sleep(300);
    check(![pA, pB, pD].some((p) => p.inbox.some((m) => m.type === 'drop')), 'no drop after a single report about a connected peer');
    pD.send({ type: 'unreachable', slot: sB, atTick: 300 });
    const dropsB = await Promise.all([pA, pB, pD].map((p) => expectNext(p, 'drop')));
    check(dropsB.every((d) => d !== null && d.slot === sB && d.atTick === 300 + DROP_LEAD_TICKS), `majority drop { slot: ${sB}, atTick: ${dropsB[0]?.atTick} } (the smallest reported tick) to everyone, the dropped peer included`);
    check(sA !== undefined, `voters were slots ${sA} and ${slots[2]}`);
    for (const p of [pA, pB, pD]) await p.close(1000);
  }
}

// ---- 8c. 2v2 with four humans: an unready peer leaving completes the start for the ready ones -----------
{
  sessionF = await guest('Peer F', '');
  sessionG = await guest('Peer G', '');
  const four = [
    ['A', sessionA],
    ['B', sessionB],
    ['F', sessionF],
    ['G', sessionG],
  ];
  const results = await Promise.all(four.map(([label, s]) => queueUntilMatched(label, s, { mode: '2v2', kind: 'p2p', p2pProtocol: P2P_PROTOCOL })));
  const room3 = results[0].json?.roomId;
  check(results.every((r) => r.status === 200 && r.json?.status === 'matched' && r.json?.kind === 'p2p' && r.json?.roomId === room3), `2v2 (second room): all four matched into room ${String(room3).slice(0, 12)}...`);
  if (results.every((r) => r.json?.status === 'matched' && r.json?.kind === 'p2p')) {
    const peers = results.map((r, i) => new RoomPeer(four[i][0], resolveWs(r.json.wsUrl), r.json.ticket));
    const welcomes = [];
    for (const p of peers) {
      try {
        await p.opened;
        welcomes.push(await p.next('room'));
      } catch (e) {
        check(false, e.message);
        welcomes.push(null);
      }
    }
    const slots = welcomes.map((w) => w?.you?.slot);
    for (const p of peers) p.inbox.length = 0;
    const [pA, pB, pF, pG] = peers;
    const sG = slots[3];
    for (const p of [pA, pB, pF]) p.send({ type: 'ready' });
    await sleep(400);
    check(![pA, pB, pF].some((p) => p.inbox.some((m) => m.type === 'start')), 'no start while G (connected) is not ready');
    const tLeave = performance.now();
    await pG.close(1000);
    const starts = await Promise.all([pA, pB, pF].map((p) => expectNext(p, 'start')));
    check(starts.every((s) => s !== null && s.startAt === starts[0].startAt), `G left unready -> start to the three ready peers ${(performance.now() - tLeave).toFixed(0)} ms after its close`);
    const dropsG = await Promise.all([pA, pB, pF].map((p) => expectNext(p, 'drop')));
    check(dropsG.every((d) => d !== null && d.slot === sG && d.atTick === 0), `drop { slot: ${sG}, atTick: 0 }: G is the team AI from tick 0`);
    for (const p of [pA, pB, pF]) await p.close(1000);
  }
}

// ---- 8d. lock release without the room: pre-start close, /api/leave of a peer that never connected, signal_dropped, rejoin of a room id ----
{
  const sessionH = sessionD; // D and E are free again: their 2v2 room sockets closed in 8b
  const sessionI = sessionE;
  const tMatch = performance.now();
  const [qh, qi] = await Promise.all([queueUntilMatched('H', sessionH, { mode: '1v1', kind: 'p2p', p2pProtocol: P2P_PROTOCOL }), queueUntilMatched('I', sessionI, { mode: '1v1', kind: 'p2p', p2pProtocol: P2P_PROTOCOL })]);
  const roomHI = qh.json?.roomId;
  check(qh.json?.status === 'matched' && qh.json?.kind === 'p2p' && qi.json?.roomId === roomHI, `H and I matched into room ${String(roomHI).slice(0, 12)}...`);
  if (qh.json?.status === 'matched' && qi.json?.roomId === roomHI) {
    const H = new RoomPeer('H', resolveWs(qh.json.wsUrl), qh.json.ticket);
    try {
      await H.opened;
    } catch (e) {
      check(false, e.message);
    }
    const wH = await expectNext(H, 'room');
    const slotI = wH ? 1 - wH.you.slot : 1;
    // A signal to the slot that has not joined: the room answers error signal_dropped { to } (not a kick).
    H.send({ type: 'signal', to: slotI, data: { sdp: { type: 'offer', sdp: 'v=0 staggered' } } });
    const dropped = await expectNext(H, 'error');
    check(dropped !== null && dropped.code === 'signal_dropped' && dropped.to === slotI && H.closed === null, `signal to the absent slot ${slotI} -> error ${dropped?.code} to ${dropped?.to}; H still connected`);
    // A room id through /api/rejoin: a clear 410 p2p_room (never a 400 / a MatchDO lookup).
    const rj = await api('/api/rejoin', { matchId: roomHI }, sessionH);
    check(rj.status === 410 && rj.json?.error === 'p2p_room', `POST /api/rejoin with the room id -> ${rj.status} ${rj.json?.error}`);
    // H closes its room socket before any start: it can queue again within 1 s, without 409.
    await H.close(1000);
    const sinceMatch = performance.now() - tMatch;
    if (sinceMatch < 2300) await sleep(2300 - sinceMatch); // the matchmaker trusts a lock younger than 2 s (LOCK_VERIFY_AFTER_MS) without asking the room
    const tClose = performance.now();
    await sleep(300);
    const qh2 = await queueThenLeave('H', sessionH, { mode: '3v3', kind: 'p2p', p2pProtocol: P2P_PROTOCOL });
    check(qh2.status === 200 && qh2.json?.status === 'waiting', `H queued ${((performance.now() - tClose) / 1000).toFixed(1)} s after closing its room socket pre-start (no 409)`);
    // I never opened its socket: POST /api/leave releases its lock (and tells the room); it can queue at once.
    const li = await api('/api/leave', {}, sessionI);
    check(li.status === 200 && li.json?.released === true, `I (never connected) POST /api/leave -> ${li.status} released ${li.json?.released}`);
    const qi2 = await queueThenLeave('I', sessionI, { mode: '3v3', kind: 'p2p', p2pProtocol: P2P_PROTOCOL });
    check(qi2.status === 200 && qi2.json?.status === 'waiting', 'I can queue right after /api/leave (no 409)');
    // Idempotent: nothing left to release.
    const li2 = await api('/api/leave', {}, sessionI);
    check(li2.status === 200 && li2.json?.released === false, `a second /api/leave releases nothing (${li2.text.slice(0, 60)})`);
  }
}

// ---- 8e. /api/leave during a live room: the leaver's socket is closed by the room, the other gets peerLeft, the leaver queues at once ----
{
  const sessionJ = sessionF; // F and G are free again (8c)
  const sessionK = sessionG;
  const [qj, qk] = await Promise.all([queueUntilMatched('J', sessionJ, { mode: '1v1', kind: 'p2p', p2pProtocol: P2P_PROTOCOL }), queueUntilMatched('K', sessionK, { mode: '1v1', kind: 'p2p', p2pProtocol: P2P_PROTOCOL })]);
  const roomJK = qj.json?.roomId;
  check(qj.json?.status === 'matched' && qj.json?.kind === 'p2p' && qk.json?.roomId === roomJK, `J and K matched into room ${String(roomJK).slice(0, 12)}...`);
  if (qj.json?.status === 'matched' && qk.json?.roomId === roomJK) {
    // K opens only after J's welcome: two sockets opened at once may reach the room in either order
    // (on the deploy K often wins), and then J learns about K from its welcome, not a peerJoined.
    const J = new RoomPeer('J', resolveWs(qj.json.wsUrl), qj.json.ticket);
    let K = null;
    let wJ = null;
    let wK = null;
    try {
      await J.opened;
      wJ = await J.next('room');
      K = new RoomPeer('K', resolveWs(qk.json.wsUrl), qk.json.ticket);
      await K.opened;
      wK = await K.next('room');
      await J.next('peerJoined');
    } catch (e) {
      check(false, e.message);
    }
    check(wJ !== null && wK !== null && wK.slots?.[wJ.you.slot]?.connected === true, 'both in the room, K sees J connected');
    const tLeave = performance.now();
    const lj = await api('/api/leave', {}, sessionJ);
    check(lj.status === 200 && lj.json?.released === true, `J POST /api/leave while in the room -> ${lj.status} released ${lj.json?.released} (${(performance.now() - tLeave).toFixed(0)} ms)`);
    // The room sends J the close frame (1000 'left'): node's client goes CLOSING at once; under
    // wrangler dev the proxied TCP connection is not torn down by the server, so the 'close' event
    // (which needs the TCP close) may never fire here (a browser closes the connection itself after
    // its closing-handshake timeout). CLOSING or CLOSED both prove the kick reached J.
    const tKick = performance.now();
    while (J.ws.readyState < 2 && performance.now() - tKick < 3000) await sleep(50);
    const closedJ = J.closed;
    check(J.ws.readyState >= 2, `the room closed J's socket: readyState ${J.ws.readyState} after ${(performance.now() - tKick).toFixed(0)} ms${closedJ ? ` (close ${closedJ.code} ${closedJ.reason})` : ' (close frame received, TCP still open: CLOSING)'}`);
    const plK = K !== null ? await expectNext(K, 'peerLeft') : null;
    check(plK !== null && wJ !== null && plK.slot === wJ.you.slot, `K got peerLeft for J ${(performance.now() - tLeave).toFixed(0)} ms after the leave`);
    // J queues immediately (no sleep): the lock was deleted before /api/leave answered.
    const qj2 = await queueThenLeave('J', sessionJ, { mode: '3v3', kind: 'p2p', p2pProtocol: P2P_PROTOCOL });
    check(qj2.status === 200 && qj2.json?.status === 'waiting', 'J queued right after /api/leave (no 409)');
    // K is still in the room: its queue is refused with the reason, then it leaves and can queue.
    const qk409 = await api('/api/queue', { mode: '1v1', kind: 'p2p', p2pProtocol: P2P_PROTOCOL }, sessionK);
    check(qk409.status === 409 && qk409.json?.error === 'active_match' && qk409.json?.kind === 'p2p' && typeof qk409.json?.message === 'string', `K (still in the room) -> ${qk409.status} ${qk409.json?.error}: ${qk409.json?.message}`);
    if (K !== null) await K.close(1000);
    await sleep(300);
    const qk2 = await queueThenLeave('K', sessionK, { mode: '3v3', kind: 'p2p', p2pProtocol: P2P_PROTOCOL });
    check(qk2.status === 200 && qk2.json?.status === 'waiting', 'K can queue after closing its socket (lock released by the room, verified by the matchmaker)');
  }
}

// ---- 8f. 2v2 staggered join: two peers ready at once, the other two join 2 s later -> the start waits for all four ----
/** Open the room socket of `label` and read its welcome (null on failure, already reported). */
async function enterRoom(label, q) {
  const p = new RoomPeer(label, resolveWs(q.json.wsUrl), q.json.ticket);
  try {
    await p.opened;
    return { p, w: await p.next('room') };
  } catch (e) {
    check(false, e.message);
    return { p, w: null };
  }
}
{
  const four = [
    ['A', sessionA],
    ['B', sessionB],
    ['D', sessionD],
    ['F', sessionF],
  ];
  const results = await Promise.all(four.map(([label, s]) => queueUntilMatched(label, s, { mode: '2v2', kind: 'p2p', p2pProtocol: P2P_PROTOCOL })));
  const roomS = results[0].json?.roomId;
  check(results.every((r) => r.json?.status === 'matched' && r.json?.roomId === roomS), `8f: A, B, D, F matched into room ${String(roomS).slice(0, 12)}...`);
  if (results.every((r) => r.json?.status === 'matched' && r.json?.roomId === roomS)) {
    const tMatch = performance.now();
    const a = await enterRoom('A', results[0]);
    const b = await enterRoom('B', results[1]);
    const absentSlots = (a.w?.slots ?? []).filter((s) => !s.connected && s.slot !== b.w?.you?.slot).map((s) => s.slot);
    check(a.w !== null && b.w !== null && absentSlots.length === 2 && a.w.slots.every((s) => s.left === undefined), `8f: A and B in; slots ${absentSlots.join(',')} not joined yet (not left)`);
    a.p.send({ type: 'ready' });
    b.p.send({ type: 'ready' });
    await sleep(2000);
    check(![a.p, b.p].some((p) => p.inbox.some((m) => m.type === 'start' || m.type === 'drop')), '8f: two of four ready and two absent: no start, no drop for 2 s');
    const d = await enterRoom('D', results[2]);
    const f = await enterRoom('F', results[3]);
    check(d.w !== null && f.w !== null && f.w.slots.every((s) => s.connected) && d.w.slots.every((s) => s.left === undefined), `8f: D and F joined ${((performance.now() - tMatch) / 1000).toFixed(1)} s after the match; F sees all four connected`);
    await sleep(300);
    check(![a.p, b.p, d.p, f.p].some((p) => p.inbox.some((m) => m.type === 'start')), '8f: D and F connected but not ready: still no start');
    d.p.send({ type: 'ready' });
    await sleep(300);
    check(![a.p, b.p, d.p, f.p].some((p) => p.inbox.some((m) => m.type === 'start')), '8f: three of four ready: no start');
    const tLast = performance.now();
    f.p.send({ type: 'ready' });
    const starts = await Promise.all([a.p, b.p, d.p, f.p].map((p) => expectNext(p, 'start')));
    check(starts.every((s) => s !== null && s.startAt === starts[0].startAt), `8f: start to all four (same startAt) ${(performance.now() - tLast).toFixed(0)} ms after the fourth ready`);
    await sleep(300);
    check(![a.p, b.p, d.p, f.p].some((p) => p.inbox.some((m) => m.type === 'drop' || m.type === 'peerLeft')), '8f: no drop, nobody left: the staggered joiners play');
    for (const p of [a.p, b.p, d.p, f.p]) await p.close(1000);
  }
}

// ---- 8g. 2v2 where one ticket never connects: the no-show grace, then start + drop { slot, 0 } -------------
// A, B and D connect and (like the real client) say ready only once every expected human is in;
// G never opens its socket. The room declares it a no-show NO_SHOW_MS after it was created
// ('peerLeft' with an empty peerId), the three then say ready -> 'start' + 'drop' { G, 0 } (a
// no-show strike for G); G's ticket is refused afterwards (403 'left'), and because that late ticket
// did reach the room the room asks the matchmaker to forgive the strike (G was slow, not absent); G
// is not stuck with a lock.
const NO_SHOW_MS = P2.P2P_NO_SHOW_MS;
{
  const four = [
    ['A', sessionA],
    ['B', sessionB],
    ['D', sessionD],
    ['G', sessionG],
  ];
  const results = await Promise.all(four.map(([label, s]) => queueUntilMatched(label, s, { mode: '2v2', kind: 'p2p', p2pProtocol: P2P_PROTOCOL })));
  const tMatch = performance.now();
  const roomN = results[0].json?.roomId;
  check(results.every((r) => r.json?.status === 'matched' && r.json?.roomId === roomN), `8g: A, B, D, G matched into room ${String(roomN).slice(0, 12)}...`);
  if (results.every((r) => r.json?.status === 'matched' && r.json?.roomId === roomN)) {
    const present = [await enterRoom('A', results[0]), await enterRoom('B', results[1]), await enterRoom('D', results[2])];
    const peers = present.map((e) => e.p);
    const mine = new Set(present.map((e) => e.w?.you?.slot));
    const slotG = [0, 1, 2, 3].find((s) => !mine.has(s));
    check(present.every((e) => e.w !== null) && slotG !== undefined, `8g: A, B, D in the room; G (slot ${slotG}) never connects`);
    const left = await Promise.all(peers.map((p) => expectNext(p, 'peerLeft', NO_SHOW_MS + 4000)));
    const tLeft = (performance.now() - tMatch) / 1000;
    check(left.every((m) => m !== null && m.slot === slotG && m.peerId === ''), `8g: peerLeft { slot: ${slotG}, peerId: '' } to the three ${tLeft.toFixed(1)} s after the match`);
    check(tLeft >= NO_SHOW_MS / 1000 - 1 && tLeft <= NO_SHOW_MS / 1000 + 3, `8g: the no-show pass ran after the ${NO_SHOW_MS / 1000} s grace (${tLeft.toFixed(1)} s)`);
    check(!peers.some((p) => p.inbox.some((m) => m.type === 'start')), '8g: no start before anyone said ready');
    for (const p of peers) p.send({ type: 'ready' });
    const starts = await Promise.all(peers.map((p) => expectNext(p, 'start')));
    check(starts.every((s) => s !== null && s.startAt === starts[0].startAt), '8g: start to the three present peers');
    const drops = await Promise.all(peers.map((p) => expectNext(p, 'drop')));
    check(drops.every((d) => d !== null && d.slot === slotG && d.atTick === 0), `8g: drop { slot: ${slotG}, atTick: 0 } to all three: G's car is the team AI from tick 0`);
    // G's ticket is dead now (403 'left' at the room: the upgrade is refused); a late ticket is not a
    // no-show, so the room forgives the strike of the start drop (checked in 8h: two strikes later G
    // is not blocked yet).
    const lateG = await new Promise((resolve) => {
      const ws = new WebSocket(resolveWs(results[3].json.wsUrl), [P.WS_SUBPROTOCOL, P.WS_TICKET_PREFIX + results[3].json.ticket]);
      const timer = setTimeout(() => resolve('timeout'), 5000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve('opened');
        ws.close();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        resolve('rejected');
      };
    });
    check(lateG === 'rejected', `8g: G's ticket after the no-show -> ${lateG}`);
    // G's lock was freed by the start drop: G queues without 409.
    const qg = await queueThenLeave('G', sessionG, { mode: '3v3', kind: 'p2p', p2pProtocol: P2P_PROTOCOL });
    check(qg.status === 200 && qg.json?.status === 'waiting', 'G can queue again (no 409)');
    for (const p of peers) await p.close(1000);
  }
}

// ---- 8h. no-show backoff: G leaves three room tickets unused -> its p2p queue answers 429 no_show ----------
// (8g's strike was forgiven: G's late ticket reached the room.) Each round: G and E match 1v1, E
// opens its socket (no strike for E), G leaves without ever connecting (POST /api/leave: a strike).
// Two strikes do not block; after the third the p2p queue is refused with retryAfterMs; a server
// queue still works.
{
  for (let round = 1; round <= 3; round++) {
    const [qg, qe] = await Promise.all([
      queueUntilMatched('G', sessionG, { mode: '1v1', kind: 'p2p', p2pProtocol: P2P_PROTOCOL }),
      queueUntilMatched('E', sessionE, { mode: '1v1', kind: 'p2p', p2pProtocol: P2P_PROTOCOL }),
    ]);
    if (qg.json?.status !== 'matched' || qe.json?.roomId !== qg.json?.roomId) {
      check(false, `8h round ${round}: G and E not matched together (${qg.text.slice(0, 80)} | ${qe.text.slice(0, 80)})`);
      break;
    }
    const e = await enterRoom('E', qe);
    const lg = await api('/api/leave', {}, sessionG);
    check(lg.status === 200 && lg.json?.released === true, `8h round ${round}: G took a ticket and left without connecting (strike ${round})`);
    await expectNext(e.p, 'peerLeft');
    await e.p.close(1000);
    await sleep(800); // E's lock goes with its socket (released in the background): the next round must not see it fresh
    if (round === 2) {
      const q2 = await queueThenLeave('G', sessionG, { mode: '3v3', kind: 'p2p', p2pProtocol: P2P_PROTOCOL });
      check(q2.status === 200 && q2.json?.status === 'waiting', `8h: two strikes (8g's was forgiven) -> not blocked yet (${q2.status} ${q2.json?.error ?? q2.json?.status})`);
    }
  }
  const blocked = await api('/api/queue', { mode: '1v1', kind: 'p2p', p2pProtocol: P2P_PROTOCOL }, sessionG);
  check(blocked.status === 429 && blocked.json?.error === 'no_show' && blocked.json?.retryAfterMs > 250_000, `8h: G's p2p queue -> ${blocked.status} ${blocked.json?.error} retryAfterMs ${blocked.json?.retryAfterMs}: ${blocked.json?.message}`);
  const serverOk = await queueThenLeave('G', sessionG, { mode: '1v1', kind: 'server' });
  check(serverOk.status === 200 && serverOk.json?.status === 'waiting', '8h: G can still queue a server match');
}

// ---- 9. a lone human in p2p 1v1 falls back to a Durable Object match after ~15 s -------------------------
if (SKIP_FALLBACK) {
  log('SKIP fallback test (--skip-fallback)');
} else {
  const sessionC = await guest('Peer C', '');
  const tC = performance.now();
  let result = null;
  for (let attempt = 0; attempt < 3 && result === null; attempt++) {
    const q = await api('/api/queue', { mode: '1v1', kind: 'p2p', p2pProtocol: P2P_PROTOCOL }, sessionC);
    log(`C: POST /api/queue -> ${q.status} ${q.text.slice(0, 120)}`);
    if (q.status !== 200) {
      failures++;
      break;
    }
    if (q.json.status === 'matched') result = q.json;
  }
  const waited = (performance.now() - tC) / 1000;
  check(result !== null, `C matched after ${waited.toFixed(1)} s`);
  if (result) {
    check(result.kind !== 'p2p' && /^[0-9a-f]{64}$/.test(result.matchId ?? '') && typeof result.ticket === 'string', `C fell back to a server match: matchId ${result.matchId?.slice(0, 12)}...`);
    check(typeof result.wsUrl === 'string' && result.wsUrl.endsWith('/ws/' + result.matchId), `C wsUrl ${result.wsUrl}`);
    check(waited >= FALLBACK_WAIT_MS / 1000 - 1 && waited < FALLBACK_WAIT_MS / 1000 + 10, `fallback took ~${(FALLBACK_WAIT_MS / 1000).toFixed(0)} s (${waited.toFixed(1)} s)`);
    // Do not join it: the MatchDO's 'unused room' alarm drops it after 90 s and frees C's lock.
  }
}

log(failures === 0 ? 'ALL OK' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

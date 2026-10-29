// Live checks of the abuse guards against a running `wrangler dev` (any port; the state is per
// server, so run it on a private instance or right after `smoke.mjs`):
//   API=http://127.0.0.1:8787 node server/test/hardening.mjs
//   WAIT_UNUSED=1 ...        also waits ~100 s for the 'unused room' alarm (a room nobody joins)
//
// guest -> queue (bot fill) -> WebSocket: Welcome roster has no playerId -> ping flood closes the
// socket with 1008 'rate' -> rejoin replaces the socket (old one closed 4000 'replaced', the new one
// keeps getting snapshots) -> /api/rejoin per-player rate limit (429) -> /api/guest per-IP rate
// limit (429) -> [WAIT_UNUSED] a second guest's room that is never joined is gone after 90 s and
// its lock is released (queue again -> not 409). Exit 0 = pass.
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

const API = process.env.API ?? 'http://127.0.0.1:8787';
const WAIT_UNUSED = process.env.WAIT_UNUSED === '1';
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

async function queueUntilMatched(session, mode = '1v1') {
  for (let attempt = 0; attempt < 4; attempt++) {
    const q = await api('/api/queue', { mode }, session);
    if (q.status !== 200) return q;
    if (q.json.status === 'matched') return q;
  }
  return { status: 0, json: null, text: 'not matched' };
}

/** Open the match socket and wait for the Welcome; returns { ws, welcome, closed() }. */
function openSocket(wsUrl, ticket) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, [P.WS_SUBPROTOCOL, P.WS_TICKET_PREFIX + ticket]);
    ws.binaryType = 'arraybuffer';
    const state = { ws, welcome: null, close: null, snapshots: 0, events: [] };
    const timer = setTimeout(() => reject(new Error('no Welcome within 10 s')), 10_000);
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('ws error'));
    };
    ws.onclose = (e) => {
      state.close = { code: e.code, reason: e.reason };
      if (!state.welcome) {
        clearTimeout(timer);
        reject(new Error(`closed before Welcome: ${e.code} ${e.reason}`));
      }
    };
    ws.onmessage = (ev) => {
      const buf = new Uint8Array(ev.data);
      const type = P.msgType(buf);
      if (type === P.MsgType.Welcome) {
        state.welcome = P.decodeJson(buf);
        clearTimeout(timer);
        resolve(state);
      } else if (type === P.MsgType.Snapshot) state.snapshots++;
      else if (type === P.MsgType.Event) state.events.push(P.decodeJson(buf));
    };
  });
}

// ---- 1. a match ------------------------------------------------------------------------------
const guest = await api('/api/guest', { name: 'Hardening' });
check(guest.status === 200, `POST /api/guest -> ${guest.status}`);
if (!guest.json?.session) process.exit(1);
const session = guest.json.session;
const q = await queueUntilMatched(session);
check(q.status === 200 && q.json?.status === 'matched', `matched: ${q.text.slice(0, 80)}`);
if (!q.json?.ticket) process.exit(1);
const matchId = q.json.matchId;

const a = await openSocket(q.json.wsUrl, q.json.ticket);
check(a.welcome.matchId === matchId, 'Welcome on socket A');
check(a.welcome.roster.every((r) => !('playerId' in r)), `Welcome roster exposes no playerId: ${JSON.stringify(a.welcome.roster.map((r) => Object.keys(r)))}`);
a.ws.send(P.encodeJson(P.MsgType.Ready, {}));
a.ws.send(P.encodeJson(P.MsgType.Ready, {})); // a second Ready is a no-op
await sleep(1500);
check(a.snapshots > 0 && a.close === null, `loop running: ${a.snapshots} snapshots on A, still open`);

// ---- 2. ping flood -> 1008 'rate' --------------------------------------------------------------
{
  const pingBuf = new Uint8Array(P.PING_LEN);
  const before = a.snapshots;
  for (let i = 0; i < 400 && a.ws.readyState === WebSocket.OPEN; i++) a.ws.send(pingBuf.subarray(0, P.encodePing(pingBuf, performance.now())));
  const until = performance.now() + 5000;
  while (a.close === null && performance.now() < until) await sleep(50);
  check(a.close !== null && a.close.code === 1008 && a.close.reason === 'rate', `400 pings in a burst -> closed ${a.close?.code} '${a.close?.reason}'`);
  log(`snapshots on A before the flood: ${before}, total ${a.snapshots}`);
}

// ---- 3. rejoin replaces the socket (B then C; B is closed 4000 'replaced') ----------------------
const rj1 = await api('/api/rejoin', { matchId }, session);
check(rj1.status === 200 && typeof rj1.json?.ticket === 'string', `POST /api/rejoin after the kick -> ${rj1.status}`);
const b = await openSocket(rj1.json.wsUrl, rj1.json.ticket);
check(b.welcome.slot === a.welcome.slot, 'socket B got the same slot');
await sleep(500);
const rj2 = await api('/api/rejoin', { matchId }, session);
const c = await openSocket(rj2.json.wsUrl, rj2.json.ticket);
await sleep(700);
check(b.close !== null && b.close.code === 4000 && b.close.reason === 'replaced', `socket B closed by the replacement: ${b.close?.code} '${b.close?.reason}'`);
check(c.close === null && c.snapshots > 10, `socket C keeps playing: ${c.snapshots} snapshots, open`);
check(!c.events.some((e) => e.type === 'playerLeft'), `no playerLeft broadcast for a replacement (${c.events.map((e) => e.type).join(',') || 'no events'})`);

// ---- 4. /api/rejoin rate limit per playerId (10 / min) ------------------------------------------
{
  let first429 = -1;
  for (let i = 3; i <= 14; i++) {
    const r = await api('/api/rejoin', { matchId }, session);
    if (r.status === 429) {
      first429 = i;
      break;
    }
    if (r.status !== 200) {
      check(false, `rejoin #${i} -> ${r.status} ${r.text}`);
      break;
    }
  }
  check(first429 === 11, `the 11th /api/rejoin of the minute -> 429 (first 429 at #${first429})`);
}

// ---- 5. /api/guest rate limit per network (120 / min: a whole class behind one address still gets in)
{
  let okCount = 0;
  let first429At = -1;
  for (let i = 1; i <= 125; i++) {
    const g = await api('/api/guest', { name: `Flood ${i}` });
    if (g.status === 200) okCount++;
    else if (g.status === 429) {
      first429At = i;
      break;
    } else check(false, `guest #${i} -> ${g.status}`);
  }
  check(first429At > 100 && first429At <= 121, `guest registrations limited: ${okCount} ok, 429 at #${first429At} (120 / min per network incl. the earlier ones)`);
}

c.ws.close(1000, 'done');

// ---- 6. [optional] a room nobody joins is dropped at 90 s and its lock released ------------------
if (WAIT_UNUSED) {
  await sleep(61_000); // a fresh guest minute
  const g2 = await api('/api/guest', { name: 'Ghost' });
  check(g2.status === 200, `ghost guest -> ${g2.status}`);
  const q2 = await queueUntilMatched(g2.json.session);
  check(q2.json?.status === 'matched', `ghost matched (room ${q2.json?.matchId?.slice(0, 8)}...) and never connects`);
  const again = await api('/api/queue', { mode: '1v1' }, g2.json.session);
  check(again.status === 409, `queue again right away -> ${again.status} (lock held)`);
  log('waiting 100 s for the unused-room alarm...');
  await sleep(100_000);
  const rj = await api('/api/rejoin', { matchId: q2.json.matchId }, g2.json.session);
  check(rj.status === 404 && rj.json?.error === 'no_match', `rejoin the unused room after 100 s -> ${rj.status} ${rj.json?.error}`);
  // The lock is released: queue again long-polls, so bot-fill may answer 'matched' with a FRESH
  // room. A 409 (stuck lock) or the dead matchId coming back would be the failure.
  const q3 = await api('/api/queue', { mode: '1v1' }, g2.json.session);
  const ok = q3.status === 200 && (q3.json?.status === 'waiting' || (q3.json?.status === 'matched' && q3.json.matchId !== q2.json.matchId));
  check(ok, `queue again -> ${q3.status} ${q3.json?.status ?? q3.json?.error} (lock released, no 409, not the dead room)`);
  await api('/api/leave', {}, g2.json.session);
}

await sleep(200);
log(failures === 0 ? 'HARDENING PASSED' : `HARDENING FAILED (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);

// LobbyClient's reconnection (plan PR 12) on fake fetch / WebSocket / page events: a dropped lobby
// socket joins again by code quietly ('reconnecting', the state kept), a close that ends the stay
// does not, the tab coming back into view checks a silent socket, the tries stop at a refusal that
// ends it or when the window is over; the new host actions and peek. Run: node --test tests/lobby-client.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND' && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
      throw err;
    }
  },
});

const LC = await import('../src/net/LobbyClient.ts');

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const ANSWER = { lobbyId: 'L', code: 'ABC234', ticket: 'T', wsUrl: 'ws://x/lobby/L' };
const STATE = { code: 'ABC234', settings: { mode: '2v2' }, hasPassword: false, region: 'SA', members: [{ id: 'm1', name: 'Ana', team: 0, host: true, guest: true, inGame: false }], you: 'm1', status: 'open' };
const PONG_WAIT = 30;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

class FakeWs {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.sent = [];
    this.readyState = 0;
  }
  send(d) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
  drop(code = 1006, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

class FakeEvents {
  constructor() {
    this.hidden = false;
    this.handlers = {};
  }
  addEventListener(type, fn) {
    (this.handlers[type] ??= []).push(fn);
  }
  fire(type) {
    for (const fn of this.handlers[type] ?? []) fn();
  }
}

/** Every client made, left after each test (their ping timers would keep the run alive). */
const made = [];
test.afterEach(() => {
  for (const c of made.splice(0)) c.leave();
});

/** A client on fakes; `join` answers each POST /api/lobbies/join (default: the ticket). */
function client({ join = () => res(200, ANSWER), windowMs = 1_000, delays = [5, 5] } = {}) {
  const sockets = [];
  const calls = [];
  const doc = new FakeEvents();
  const win = new FakeEvents();
  const lc = new LC.LobbyClient({
    fetchFn: async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization });
      if (url === '/api/lobbies/join') return join(calls.filter((c) => c.url === url).length);
      if (url.startsWith('/api/lobbies/peek')) return res(200, { code: 'ABC234', mode: '2v2', players: 2, max: 4 });
      return res(404, { error: 'not_found' });
    },
    webSocketFactory: (u, p) => {
      const ws = new FakeWs(u, p);
      sockets.push(ws);
      return ws;
    },
    bearer: async () => 'b',
    events: { doc, win },
    reconnectDelaysMs: delays,
    reconnectWindowMs: windowMs,
    pongWaitMs: PONG_WAIT,
  });
  made.push(lc);
  return { lc, sockets, calls, doc, win };
}

async function joined(h) {
  await h.lc.join('ABC234', 'pw');
  h.sockets[0].open();
  h.sockets[0].receive({ t: 'state', lobby: STATE });
}

test('a dropped socket joins again by code (same password), quietly: reconnecting, the state kept, open again', async () => {
  const h = client();
  await joined(h);
  const statuses = [];
  let closed = null;
  h.lc.onStatus = () => statuses.push(h.lc.status);
  h.lc.onClosed = (r) => (closed = r);
  h.sockets[0].drop(1006);
  assert.equal(h.lc.status, 'reconnecting');
  assert.equal(h.lc.inLobby, true, 'still in the lobby for the menus (the pill, the Sala)');
  assert.equal(h.lc.state?.code, 'ABC234', 'the Sala keeps showing the lobby');
  await tick(10);
  const again = h.calls.filter((c) => c.url === '/api/lobbies/join');
  assert.equal(again.length, 2);
  assert.deepEqual(again[1].body, { code: 'ABC234', password: 'pw' });
  assert.equal(h.sockets.length, 2);
  h.sockets[1].open();
  assert.equal(h.lc.status, 'open');
  assert.deepEqual(statuses, ['reconnecting', 'open']);
  assert.equal(closed, null, 'no close reported');
});

test('a close that ends the stay never reconnects: kicked, the lobby closed, another tab, left', async () => {
  for (const [code, reason, want] of [[4003, '', 'kicked'], [4004, 'idle', 'idle'], [4000, 'replaced', 'replaced']]) {
    const h = client();
    await joined(h);
    let closed = null;
    h.lc.onClosed = (r) => (closed = r);
    h.sockets[0].drop(code, reason);
    await tick(10);
    assert.equal(closed, want);
    assert.equal(h.lc.inLobby, false);
    assert.equal(h.calls.filter((c) => c.url === '/api/lobbies/join').length, 1, 'no join again');
  }
});

test('reconnecting: a refusal that ends it (kicked, no lobby) closes the stay; network failures retry until the window is over', async () => {
  const kicked = client({ join: (n) => (n === 1 ? res(200, ANSWER) : res(403, { error: 'kicked', message: 'x' })) });
  await joined(kicked);
  let why = null;
  kicked.lc.onClosed = (r) => (why = r);
  kicked.sockets[0].drop();
  await tick(10);
  assert.equal(why, 'kicked');
  const gone = client({ join: (n) => (n === 1 ? res(200, ANSWER) : res(404, { error: 'no_lobby' })) });
  await joined(gone);
  gone.lc.onClosed = (r) => (why = r);
  gone.sockets[0].drop();
  await tick(10);
  assert.equal(why, 'ended');
  // The server out of reach: tries every delay, then 'lost' when the window ends.
  const down = client({ join: (n) => (n === 1 ? res(200, ANSWER) : res(503, { error: 'unavailable' })), windowMs: 150, delays: [10] });
  await joined(down);
  down.lc.onClosed = (r) => (why = r);
  why = null;
  down.sockets[0].drop();
  await tick(450);
  assert.equal(why, 'lost');
  const tries = down.calls.filter((c) => c.url === '/api/lobbies/join').length - 1;
  assert.ok(tries >= 2, `several tries (${tries})`);
});

test('the tab back in view: a silent socket counts as dropped; one that answers stays; offline -> online tries at once', async () => {
  const h = client();
  await joined(h);
  h.doc.hidden = true;
  h.doc.fire('visibilitychange');
  assert.equal(h.sockets[0].sent.length, 0, 'nothing while hidden');
  h.doc.hidden = false;
  h.doc.fire('visibilitychange');
  assert.equal(h.sockets[0].sent.at(-1), 'ping');
  h.sockets[0].receive('pong');
  await tick(PONG_WAIT + 20);
  assert.equal(h.lc.status, 'open', 'it answered');
  h.doc.fire('visibilitychange');
  await tick(PONG_WAIT + 20);
  assert.equal(h.lc.status === 'reconnecting' || h.sockets.length === 2, true, 'no answer: reconnecting');
  // Reconnecting with the network back: a try right away.
  const net = client({ join: (n) => (n === 1 ? res(200, ANSWER) : res(503, { error: 'unavailable' })), windowMs: 10_000, delays: [5_000] });
  await joined(net);
  net.sockets[0].drop();
  await tick(10);
  const before = net.calls.length;
  net.win.fire('online');
  await tick(10);
  assert.equal(net.calls.length, before + 1, 'the online event tries now, not after the 5 s wait');
  net.lc.leave();
  assert.equal(net.lc.status, 'idle', 'leaving while reconnecting stops it');
});

test('the host actions and LISTO go on the socket; peek needs no session', async () => {
  const h = client();
  await joined(h);
  h.lc.makeHost('m2');
  h.lc.move('m2', 1);
  h.lc.setReady(true);
  assert.deepEqual(h.sockets[0].sent.map((s) => JSON.parse(s)), [{ t: 'host', member: 'm2' }, { t: 'move', member: 'm2', team: 1 }, { t: 'ready', ready: true }]);
  const p = await h.lc.peek('ABC234');
  assert.equal(p.max, 4);
  const call = h.calls.at(-1);
  assert.equal(call.url, '/api/lobbies/peek?code=ABC234');
  assert.equal(call.auth, undefined);
});

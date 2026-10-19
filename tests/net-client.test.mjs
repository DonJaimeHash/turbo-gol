// NetClient (src/net/NetClient.ts) and its pure helpers with a fake fetch / WebSocket:
//   node --test tests/net-client.test.mjs
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

const P = await import('../src/net/protocol.ts');
const { ClockSync, TICK_MS, median } = await import('../src/net/ClockSync.ts');
const { LossEstimator, RateMeter } = await import('../src/net/NetStats.ts');
const { NetClient, NetError, resolveWsUrl, sanitizeName, loadGuestRecord, saveGuestRecord, GUEST_STORAGE_KEY, sessionValid, parseServerConfig } =
  await import('../src/net/NetClient.ts');
const { getToken, TURNSTILE_TOKEN_TIMEOUT_MS } = await import('../src/net/Turnstile.ts');
const T = await import('../src/sim/types.ts');

const { MsgType, encodeSnapshot, encodePong, encodeJson, decodeInput, decodePing, INPUT_HEADER, fnv1a32 } = P;

// ---- fakes ---------------------------------------------------------------------------------

class FakeStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

class FakeSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.binaryType = 'blob';
    this.readyState = 0;
    this.protocol = '';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.sent = [];
    this.closed = null;
  }
  send(data) {
    this.sent.push(data instanceof Uint8Array ? new Uint8Array(data) : data);
  }
  close(code, reason) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.protocol = 'tg1';
    if (this.onopen) this.onopen({});
  }
  deliver(bytes) {
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    if (this.onmessage) this.onmessage({ data: copy.buffer });
  }
  dropped(code, reason = '') {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code, reason });
  }
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** GET /api/config of a server without Turnstile (local dev); routes may override '/api/config'. */
const CONFIG_OFF = { turnstileSiteKey: null, protocol: P.PROTOCOL_VERSION, version: 'test', region: 'local' };

/**
 * A fake window.turnstile: render() records the container / options and lets `behave(opts, id)`
 * drive the callbacks; remove() records the widget ids.
 */
function fakeTurnstile(behave) {
  const api = {
    rendered: [],
    removed: [],
    render(container, opts) {
      const id = `w${api.rendered.length + 1}`;
      api.rendered.push({ container, opts });
      behave(opts, id);
      return id;
    },
    remove(id) {
      api.removed.push(id);
    },
    reset() {},
  };
  return api;
}

function makeClient(routes, opts = {}) {
  const sockets = [];
  const calls = [];
  let t = 1000;
  const client = new NetClient({
    storage: opts.storage ?? new FakeStorage(),
    now: () => t,
    fetchFn: async (url, init) => {
      calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
      const r = url in routes ? routes[url] : url === '/api/config' ? () => jsonResponse(200, CONFIG_OFF) : undefined;
      if (typeof r === 'function') return r(init, calls.length);
      return r ?? jsonResponse(404, {});
    },
    webSocketFactory: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    pingIntervalMs: 1e9,
    ...opts,
  });
  return { client, sockets, calls, setTime: (v) => (t = v), now: () => t };
}

const GUEST = { playerId: 'p1', name: 'Tester', session: 'jwt-session', expiresAt: Date.now() + 24 * 3600 * 1000 };

// ---- ClockSync ---------------------------------------------------------------------------

test('median helper', () => {
  const s = new Float64Array(16);
  assert.equal(median(new Float64Array([5, 1, 3]), 3, s), 3);
  assert.equal(median(new Float64Array([4, 1, 3, 2]), 4, s), 2.5);
  assert.equal(median(new Float64Array([7]), 1, s), 7);
  assert.equal(median(new Float64Array([]), 0, s), 0);
});

test('RTT / offset / host tick estimate from synthetic 4-timestamp pongs', () => {
  const clock = new ClockSync();
  // Host clock = client clock + 5000 ms; host tick advances at 120 Hz from tick 0 at host time 0.
  const OFFSET = 5000;
  const hostTickAt = (hostMs) => Math.floor(hostMs / TICK_MS);
  const oneWay = 30; // 60 ms rtt, symmetric
  for (let i = 0; i < 10; i++) {
    const t0 = 1000 + i * 250;
    const t1 = t0 + oneWay + OFFSET;
    const t2 = t1 + 2; // 2 ms of host processing (excluded from the rtt)
    const t3 = t2 - OFFSET + oneWay;
    clock.addPong(t0, t1, t2, t3, hostTickAt(t2));
  }
  assert.equal(clock.samples, 10);
  assert.ok(Math.abs(clock.rtt - 60) < 1e-9, `rtt ${clock.rtt}`);
  assert.ok(Math.abs(clock.offset - OFFSET) < 1e-9, `offset ${clock.offset}`);
  assert.ok(clock.jitter < 1e-9);
  // Estimate at a later client time: host tick = (now + offset) / TICK_MS (within a tick).
  const now = 5000;
  const est = clock.hostTickEstimate(now);
  const truth = (now + OFFSET) / TICK_MS;
  assert.ok(Math.abs(est - truth) < 1, `estimate ${est} vs ${truth}`);
});

test('the median rejects outliers and jitter is the mean absolute deviation', () => {
  const clock = new ClockSync();
  const rtts = [40, 42, 38, 41, 300, 39, 40, 43];
  let t0 = 0;
  for (const rtt of rtts) {
    const t1 = t0 + rtt / 2;
    const t3 = t0 + rtt;
    clock.addPong(t0, t1, t1, t3, 100);
    t0 += 250;
  }
  const sorted = [...rtts].sort((a, b) => a - b);
  const med = (sorted[3] + sorted[4]) / 2;
  assert.equal(clock.rtt, med);
  const dev = rtts.reduce((a, r) => a + Math.abs(r - med), 0) / rtts.length;
  assert.ok(Math.abs(clock.jitter - dev) < 1e-9);
  // Window of 16: after 20 more clean samples the outlier is gone.
  for (let i = 0; i < 20; i++) {
    clock.addPong(t0, t0 + 20, t0 + 20, t0 + 40, 100);
    t0 += 250;
  }
  assert.equal(clock.rtt, 40);
  assert.equal(clock.jitter, 0);
  assert.equal(clock.samples, 16);
});

// ---- Loss / rate --------------------------------------------------------------------------

test('loss estimate from snapshot tick gaps', () => {
  const loss = new LossEstimator();
  for (let t = 4; t <= 40; t += 4) loss.onSnapshotTick(t);
  assert.equal(loss.interval, 4);
  assert.equal(loss.loss, 0);
  loss.onSnapshotTick(52); // 44 and 48 missing
  assert.equal(loss.missed, 2);
  assert.equal(loss.received, 11);
  assert.ok(Math.abs(loss.loss - 2 / 13) < 1e-9);
  loss.onSnapshotTick(56);
  loss.onSnapshotTick(56); // duplicate / out of order: ignored as a gap
  assert.equal(loss.missed, 2);
  // Window slides: 128 clean snapshots later the misses are gone.
  let t = 60;
  for (let i = 0; i < 128; i++) {
    loss.onSnapshotTick(t);
    t += 4;
  }
  assert.equal(loss.missed, 0);
  assert.equal(loss.loss, 0);
});

test('rate meter', () => {
  const m = new RateMeter(250);
  assert.equal(m.sample(0, 0), 0);
  assert.equal(m.sample(100, 10), 0, 'too soon');
  assert.equal(m.sample(500, 20), 40, '20 per 0.5 s');
  assert.equal(m.sample(1500, 20), 0);
});

// ---- Guest record / URLs ------------------------------------------------------------------

test('guest record persistence and name sanitising', () => {
  const st = new FakeStorage();
  const fresh = loadGuestRecord(st);
  assert.match(fresh.name, /^Guest\d{3}$/);
  assert.equal(fresh.session, null);
  saveGuestRecord(st, { name: 'Tomi', session: GUEST });
  const back = loadGuestRecord(st);
  assert.equal(back.name, 'Tomi');
  assert.deepEqual(back.session, GUEST);
  assert.ok(st.getItem(GUEST_STORAGE_KEY));
  st.setItem(GUEST_STORAGE_KEY, '{not json');
  assert.match(loadGuestRecord(st).name, /^Guest\d{3}$/);
  assert.equal(sanitizeName('  Ja  vi  '), 'Ja vi');
  assert.equal(sanitizeName('x'.repeat(40)).length, 16);
  assert.match(sanitizeName('   '), /^Guest\d{3}$/);
  assert.equal(sessionValid(GUEST), true);
  assert.equal(sessionValid({ ...GUEST, expiresAt: Math.floor((Date.now() + 3600_000) / 1000) }), true, 'seconds accepted');
  assert.equal(sessionValid({ ...GUEST, expiresAt: Date.now() + 1000 }), false, 'about to expire');
  assert.equal(sessionValid(null), false);
});

test('resolveWsUrl keeps absolute ws urls and maps http(s) to ws(s)', () => {
  assert.equal(resolveWsUrl('ws://127.0.0.1:8787/ws/abc'), 'ws://127.0.0.1:8787/ws/abc');
  assert.equal(resolveWsUrl('wss://x.example/ws/abc'), 'wss://x.example/ws/abc');
  assert.equal(resolveWsUrl('https://x.example/ws/abc'), 'wss://x.example/ws/abc');
  assert.equal(resolveWsUrl('http://x.example/ws/abc'), 'ws://x.example/ws/abc');
  assert.equal(resolveWsUrl('/ws/abc'), '/ws/abc', 'no location in node: left as is');
});

// ---- Queue / connect / messages -----------------------------------------------------------

test('queue: registers the guest, long-polls until matched, reports the waiting count', async () => {
  let polls = 0;
  const waiting = [];
  const { client, calls } = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': (init) => {
      polls++;
      assert.equal(init.headers.authorization, `Bearer ${GUEST.session}`);
      if (polls < 3) return jsonResponse(200, { status: 'waiting', waiting: polls });
      return jsonResponse(200, { status: 'matched', matchId: 'm1', ticket: 'tkt', wsUrl: '/ws/m1' });
    },
  });
  client.setName('Tester');
  const m = await client.queue('1v1', (n) => waiting.push(n));
  assert.deepEqual(m, { matchId: 'm1', ticket: 'tkt', wsUrl: '/ws/m1' });
  assert.deepEqual(waiting, [1, 2]);
  // The config is read once before the first guest registration (no Turnstile here: no token).
  assert.deepEqual(
    calls.map((c) => c.url),
    ['/api/config', '/api/guest', '/api/queue', '/api/queue', '/api/queue'],
  );
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(calls[1].body, { name: 'Tester' });
  assert.equal(calls[2].body.mode, '1v1');
  assert.equal(client.guest.playerId, 'p1');
  assert.equal(client.matchId, 'm1');
});

// ---- Config / Turnstile -------------------------------------------------------------------

test('config: GET /api/config is fetched once per client and cached; a failure is retried', async () => {
  let n = 0;
  const h = makeClient({
    '/api/config': () => {
      n++;
      return n === 1 ? jsonResponse(503, { error: 'down' }) : jsonResponse(200, { turnstileSiteKey: 'sk-1', protocol: P.PROTOCOL_VERSION, version: '0.1.0', region: 'EZE' });
    },
  });
  await assert.rejects(h.client.config(), (err) => err instanceof NetError && err.code === 'http' && err.status === 503 && /down/.test(err.message));
  const a = await h.client.config();
  const b = await h.client.config();
  assert.equal(n, 2, 'the failure was not cached, the success is');
  assert.equal(a, b, 'same object');
  assert.deepEqual(a, { turnstileSiteKey: 'sk-1', protocol: P.PROTOCOL_VERSION, version: '0.1.0', region: 'EZE', autoRegion: '', oauth: [] });
  // Concurrent callers share one request.
  const h2 = makeClient({ '/api/config': () => jsonResponse(200, CONFIG_OFF) });
  await Promise.all([h2.client.config(), h2.client.config(), h2.client.config()]);
  assert.equal(h2.calls.length, 1);
  // A protocol mismatch is refused before any guest is created; a malformed body too.
  const h3 = makeClient({ '/api/config': () => jsonResponse(200, { ...CONFIG_OFF, protocol: P.PROTOCOL_VERSION + 1 }) });
  await assert.rejects(h3.client.config(), (err) => err instanceof NetError && err.code === 'protocol');
  const h4 = makeClient({ '/api/config': () => jsonResponse(200, 'nope') });
  await assert.rejects(h4.client.config(), (err) => err instanceof NetError && err.code === 'protocol');
  // Lenient parsing: an empty / missing sitekey means no Turnstile.
  assert.deepEqual(parseServerConfig({ turnstileSiteKey: '' }), { turnstileSiteKey: null, protocol: 0, version: '', region: '', autoRegion: '', oauth: [] });
  assert.deepEqual(parseServerConfig({}), { turnstileSiteKey: null, protocol: 0, version: '', region: '', autoRegion: '', oauth: [] });
  assert.deepEqual(parseServerConfig({ autoRegion: 'SA', oauth: ['google', 3] }).oauth, ['google'], 'accounts: providers kept, junk dropped');
  assert.equal(parseServerConfig(null), null);
  // A server without the route (404) means no Turnstile; the answer is cached like any other.
  const h6 = makeClient({ '/api/config': () => jsonResponse(404, { error: 'not_found' }), '/api/guest': () => jsonResponse(200, GUEST) });
  await h6.client.ensureGuest();
  assert.deepEqual(await h6.client.config(), { turnstileSiteKey: null, protocol: 0, version: '', region: '' });
  assert.equal(h6.calls.filter((c) => c.url === '/api/config').length, 1);
  assert.deepEqual(Object.keys(h6.calls[1].body), ['name'], 'no token without a sitekey');
  // A stored valid session needs no config at all.
  const st = new FakeStorage();
  saveGuestRecord(st, { name: 'Tester', session: GUEST });
  const h5 = makeClient({ '/api/queue': () => jsonResponse(200, { status: 'matched', matchId: 'm', ticket: 't', wsUrl: '/ws/m' }) }, { storage: st });
  await h5.client.queue('1v1');
  assert.deepEqual(
    h5.calls.map((c) => c.url),
    ['/api/queue'],
  );
});

test('guest: with a sitekey the Turnstile token is obtained in the container and sent', async () => {
  const container = { hidden: true };
  const api = fakeTurnstile((opts) => setTimeout(() => opts.callback('tok-abc'), 0));
  let loads = 0;
  const phases = [];
  const h = makeClient(
    {
      '/api/config': () => jsonResponse(200, { turnstileSiteKey: 'sk-1', protocol: P.PROTOCOL_VERSION, version: '0.1.0', region: 'EZE' }),
      '/api/guest': () => jsonResponse(200, GUEST),
      '/api/queue': () => jsonResponse(200, { status: 'matched', matchId: 'm1', ticket: 'tkt', wsUrl: '/ws/m1' }),
    },
    {
      turnstileContainer: () => container,
      turnstileLoader: async () => {
        loads++;
        return api;
      },
    },
  );
  const { client, calls } = h;
  client.onTurnstile = (active) => phases.push([active, container.hidden]);
  client.setName('Tester');
  await client.queue('1v1');
  assert.equal(loads, 1);
  assert.equal(api.rendered.length, 1);
  const r = api.rendered[0];
  assert.equal(r.container, container);
  assert.equal(r.opts.sitekey, 'sk-1');
  assert.equal(r.opts.theme, 'dark');
  assert.equal(r.opts.appearance, 'interaction-only');
  assert.equal(r.opts.size, 'normal');
  assert.deepEqual(api.removed, ['w1'], 'the widget is removed once the token is in');
  assert.equal(container.hidden, true, 'the slot is hidden again');
  assert.deepEqual(phases, [
    [true, true],
    [false, true],
  ]);
  const guest = calls.find((c) => c.url === '/api/guest');
  assert.deepEqual(guest.body, { name: 'Tester', turnstileToken: 'tok-abc' });
  // The config is cached: a second registration (name change) renders a new widget without a fetch.
  client.setName('Other');
  await client.ensureGuest();
  assert.equal(calls.filter((c) => c.url === '/api/config').length, 1);
  assert.equal(api.rendered.length, 2);
  assert.deepEqual(api.removed, ['w1', 'w2']);
});

test('guest: no token and no Turnstile load when the sitekey is null', async () => {
  let loads = 0;
  const { client, calls } = makeClient(
    { '/api/guest': () => jsonResponse(200, GUEST) },
    {
      turnstileContainer: () => ({ hidden: true }),
      turnstileLoader: async () => {
        loads++;
        throw new Error('must not load');
      },
    },
  );
  client.setName('Tester');
  await client.ensureGuest();
  assert.equal(loads, 0);
  assert.deepEqual(calls[1].body, { name: 'Tester' });
  assert.equal('turnstileToken' in calls[1].body, false);
});

test('guest: 403 turnstile_failed / 503 turnstile_unconfigured and a failed challenge reject with NetError turnstile', async () => {
  const withSitekey = { '/api/config': () => jsonResponse(200, { turnstileSiteKey: 'sk-1', protocol: P.PROTOCOL_VERSION, version: '0.1.0', region: 'EZE' }) };
  const okToken = { turnstileContainer: () => ({ hidden: true }), turnstileLoader: async () => fakeTurnstile((opts) => opts.callback('tok')) };
  const failed = makeClient({ ...withSitekey, '/api/guest': () => jsonResponse(403, { error: 'turnstile_failed' }) }, okToken).client;
  await assert.rejects(failed.queue('1v1'), (err) => err instanceof NetError && err.code === 'turnstile' && err.status === 403);
  const unconfigured = makeClient({ '/api/guest': () => jsonResponse(503, { error: 'turnstile_unconfigured' }) }).client;
  await assert.rejects(unconfigured.ensureGuest(), (err) => err instanceof NetError && err.code === 'turnstile' && err.status === 503);
  // Other refusals keep the http code.
  const other = makeClient({ '/api/guest': () => jsonResponse(429, { error: 'rate_limited' }) }).client;
  await assert.rejects(other.ensureGuest(), (err) => err instanceof NetError && err.code === 'http' && err.status === 429 && /rate_limited/.test(err.message));
  // The widget reports an error: no POST /api/guest, NetError turnstile with status 0.
  const api = fakeTurnstile((opts) => opts['error-callback']('300030'));
  const phases = [];
  const h = makeClient({ ...withSitekey, '/api/guest': () => jsonResponse(200, GUEST) }, { turnstileContainer: () => ({ hidden: true }), turnstileLoader: async () => api });
  h.client.onTurnstile = (a) => phases.push(a);
  await assert.rejects(h.client.ensureGuest(), (err) => err instanceof NetError && err.code === 'turnstile' && err.status === 0 && /300030/.test(err.message));
  assert.equal(h.calls.some((c) => c.url === '/api/guest'), false);
  assert.deepEqual(api.removed, ['w1']);
  assert.deepEqual(phases, [true, false]);
  // No container to render into: same error, nothing loaded.
  const noBox = makeClient({ ...withSitekey }, { turnstileLoader: async () => api }).client;
  await assert.rejects(noBox.ensureGuest(), (err) => err instanceof NetError && err.code === 'turnstile');
  assert.equal(api.rendered.length, 1);
  // The script failing to load is a turnstile error too.
  const noScript = makeClient({ ...withSitekey }, { turnstileContainer: () => ({ hidden: true }), turnstileLoader: async () => { throw new Error('turnstile script failed to load'); } }).client;
  await assert.rejects(noScript.ensureGuest(), (err) => err instanceof NetError && err.code === 'turnstile' && /script/.test(err.message));
});

test('cancelQueue during the challenge removes the widget and rejects with cancelled', async () => {
  const container = { hidden: true };
  const api = fakeTurnstile(() => {}); // never answers
  const h = makeClient(
    {
      '/api/config': () => jsonResponse(200, { turnstileSiteKey: 'sk-1', protocol: P.PROTOCOL_VERSION, version: '0.1.0', region: 'EZE' }),
      '/api/guest': () => jsonResponse(200, GUEST),
    },
    { turnstileContainer: () => container, turnstileLoader: async () => api },
  );
  const p = h.client.queue('1v1');
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(api.rendered.length, 1);
  assert.equal(container.hidden, false, 'the slot is shown while the widget lives');
  h.client.cancelQueue();
  await assert.rejects(p, (err) => err instanceof NetError && err.code === 'cancelled');
  assert.deepEqual(api.removed, ['w1']);
  assert.equal(container.hidden, true);
  assert.equal(h.calls.some((c) => c.url === '/api/guest'), false, 'no registration after the cancel');
  assert.equal(h.calls.some((c) => c.url === '/api/leave'), false, 'nothing was queued server-side');
});

test('Turnstile.getToken: timeout, synchronous callback, abort and render failures all remove the widget', async () => {
  assert.equal(TURNSTILE_TOKEN_TIMEOUT_MS, 60_000);
  const box = { hidden: true };
  // Timeout.
  const silent = fakeTurnstile(() => {});
  await assert.rejects(getToken('sk', box, { load: async () => silent, timeoutMs: 5 }), /timeout/);
  assert.deepEqual(silent.removed, ['w1']);
  assert.equal(box.hidden, true);
  // A callback fired synchronously inside render() still gets its widget removed.
  const sync = fakeTurnstile((opts) => opts.callback('now'));
  assert.equal(await getToken('sk', box, { load: async () => sync }), 'now');
  assert.deepEqual(sync.removed, ['w1']);
  // Abort before and during.
  const aborted = new AbortController();
  aborted.abort();
  const untouched = fakeTurnstile(() => {});
  await assert.rejects(getToken('sk', box, { load: async () => untouched, signal: aborted.signal }), /cancelled/);
  assert.equal(untouched.rendered.length, 0);
  const ctrl = new AbortController();
  const pending = fakeTurnstile(() => {});
  const p = getToken('sk', box, { load: async () => pending, signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(box.hidden, false);
  ctrl.abort();
  await assert.rejects(p, /cancelled/);
  assert.deepEqual(pending.removed, ['w1']);
  assert.equal(box.hidden, true);
  // render() returning no id / throwing, an empty token, expired / unsupported callbacks.
  const noId = { render: () => undefined, remove() {}, reset() {} };
  await assert.rejects(getToken('sk', box, { load: async () => noId }), /render failed/);
  const throws = { render: () => { throw new Error('boom'); }, remove() {}, reset() {} };
  await assert.rejects(getToken('sk', box, { load: async () => throws }), /boom/);
  const empty = fakeTurnstile((opts) => opts.callback(''));
  await assert.rejects(getToken('sk', box, { load: async () => empty }), /empty token/);
  const unsupported = fakeTurnstile((opts) => opts['unsupported-callback']());
  await assert.rejects(getToken('sk', box, { load: async () => unsupported }), /unsupported/);
  assert.deepEqual(unsupported.removed, ['w1']);
  // The second settle of a widget is ignored (error after the token).
  let late = null;
  const twice = fakeTurnstile((opts) => {
    opts.callback('first');
    late = () => opts['error-callback']('x');
  });
  assert.equal(await getToken('sk', box, { load: async () => twice }), 'first');
  late();
  assert.deepEqual(twice.removed, ['w1']);
});

test('queue: cancel rejects with NetError cancelled; a 401 re-registers the guest once', async () => {
  const { client, calls } = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': (init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    '/api/leave': () => jsonResponse(200, { ok: true, left: true }),
  });
  const p = client.queue('2v2');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(client.queueing, true);
  client.cancelQueue();
  await assert.rejects(p, (err) => err instanceof NetError && err.code === 'cancelled');
  assert.equal(client.queueing, false);
  // The matchmaker is told to drop the waiter (best effort), with the session.
  const leave = calls.find((c) => c.url === '/api/leave');
  assert.ok(leave, 'cancel posts /api/leave');
  assert.equal(leave.init.headers.authorization, 'Bearer ' + GUEST.session);
  // Cancelling before the guest registered sends no leave (nothing was queued server-side).
  const c0 = makeClient({ '/api/guest': () => new Promise(() => {}) });
  void c0.client.queue('1v1');
  await new Promise((r) => setTimeout(r, 0));
  c0.client.cancelQueue();
  assert.equal(c0.calls.some((c) => c.url === '/api/leave'), false);

  let guests = 0;
  let queues = 0;
  const c2 = makeClient({
    '/api/guest': () => jsonResponse(200, { ...GUEST, playerId: `p${++guests}` }),
    '/api/queue': () => (++queues === 1 ? jsonResponse(401, {}) : jsonResponse(200, { status: 'matched', matchId: 'm', ticket: 't', wsUrl: '/ws/m' })),
  }).client;
  await c2.queue('3v3');
  assert.equal(guests, 2, 'expired session -> new guest');
  assert.equal(queues, 2);
});

test('queue: 409 active_match rejoins that match with a fresh ticket', async () => {
  const calls = [];
  const { client } = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => jsonResponse(409, { error: 'active_match', matchId: 'abc' }),
    '/api/rejoin': (init) => {
      calls.push(JSON.parse(init.body));
      return jsonResponse(200, { status: 'matched', matchId: 'abc', ticket: 'T9', wsUrl: '/ws/abc' });
    },
  });
  const m = await client.queue('1v1');
  assert.deepEqual(m, { matchId: 'abc', ticket: 'T9', wsUrl: '/ws/abc' });
  assert.deepEqual(calls, [{ matchId: 'abc' }]);
  assert.equal(client.matchId, 'abc');
  // Any other 409 is an error, with the server's reason in the message.
  const other = makeClient({ '/api/guest': () => jsonResponse(200, GUEST), '/api/queue': () => jsonResponse(409, { error: 'slot_taken', message: 'seat gone' }) }).client;
  await assert.rejects(other.queue('1v1'), (err) => err instanceof NetError && err.code === 'http' && /409 slot_taken: seat gone/.test(err.message));
});

test('queue: 409 active_match of kind p2p -> POST /api/leave { matchId } once, then the queue is retried; a second 409 is an error with the reason', async () => {
  const seen = [];
  let queues = 0;
  const h = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => (++queues === 1 ? jsonResponse(409, { error: 'active_match', matchId: 'r'.repeat(64), kind: 'p2p', message: 'still in a room' }) : jsonResponse(200, { status: 'matched', kind: 'p2p', roomId: 'room2', ticket: 'T', wsUrl: '/room/room2' })),
    '/api/leave': (init) => {
      seen.push(JSON.parse(init.body));
      return jsonResponse(200, { ok: true, left: false, released: true });
    },
    '/api/rejoin': () => {
      throw new Error('a p2p lock must not be rejoined');
    },
  });
  const a = await h.client.queue('1v1', 'p2p');
  assert.deepEqual(a, { kind: 'p2p', roomId: 'room2', ticket: 'T', wsUrl: '/room/room2' });
  assert.deepEqual(seen, [{ matchId: 'r'.repeat(64) }], 'the lock of THAT room is released');
  assert.equal(queues, 2);
  assert.equal(h.client.leaves, 1);
  const order = h.calls.map((c) => c.url).filter((u) => u === '/api/queue' || u === '/api/leave');
  assert.deepEqual(order, ['/api/queue', '/api/leave', '/api/queue'], 'leave between the two queue calls');

  // The lock survives the leave (an old server): the second 409 fails with the server's reason.
  const stuck = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => jsonResponse(409, { error: 'active_match', matchId: 'r'.repeat(64), kind: 'p2p', message: 'still in a room' }),
    '/api/leave': () => jsonResponse(200, { ok: true, left: false, released: false }),
  });
  await assert.rejects(stuck.client.queue('1v1', 'p2p'), (err) => err instanceof NetError && err.status === 409 && /active_match: still in a room/.test(err.message) && /sala P2P rrrrrrrr/.test(err.message));
  assert.equal(stuck.calls.filter((c) => c.url === '/api/queue').length, 2, 'retried once, not forever');
});

test('queue: 409 active_match of kind server whose rejoin answers 404 / 410 (lock freed by the Worker) is retried once; 410 p2p_room also leaves first', async () => {
  let queues = 0;
  const h = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => (++queues === 1 ? jsonResponse(409, { error: 'active_match', matchId: 'abc', kind: 'server' }) : jsonResponse(200, { status: 'matched', matchId: 'm2', ticket: 'T2', wsUrl: '/ws/m2' })),
    '/api/rejoin': () => jsonResponse(410, { error: 'match_over' }),
    '/api/leave': () => jsonResponse(200, { ok: true, left: false, released: false }),
  });
  const m = await h.client.queue('1v1');
  assert.deepEqual(m, { matchId: 'm2', ticket: 'T2', wsUrl: '/ws/m2' });
  assert.equal(h.calls.filter((c) => c.url === '/api/leave').length, 0, 'a server lock is not left, the Worker freed it');
  assert.equal(queues, 2);

  // An old-style 409 without `kind` pointing at a room id, on a server queue: the rejoin says
  // p2p_room -> leave + retry. (A p2p queue never rejoins: see the next test.)
  let q2 = 0;
  const leaves = [];
  let rejoins2 = 0;
  const h2 = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => (++q2 === 1 ? jsonResponse(409, { error: 'active_match', matchId: 'r'.repeat(64) }) : jsonResponse(200, { status: 'matched', matchId: 'm3', ticket: 'T3', wsUrl: '/ws/m3' })),
    '/api/rejoin': () => {
      rejoins2++;
      return jsonResponse(410, { error: 'p2p_room', message: 'a P2P room cannot be rejoined' });
    },
    '/api/leave': (init) => {
      leaves.push(JSON.parse(init.body));
      return jsonResponse(200, { ok: true, left: false, released: true });
    },
  });
  const a = await h2.client.queue('1v1', 'server');
  assert.deepEqual(a, { kind: 'server', matchId: 'm3', ticket: 'T3', wsUrl: '/ws/m3' });
  assert.equal(rejoins2, 1);
  assert.deepEqual(leaves, [{ matchId: 'r'.repeat(64) }]);

  // A rejoin that fails for another reason (500) is not retried.
  const h3 = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => jsonResponse(409, { error: 'active_match', matchId: 'abc', kind: 'server' }),
    '/api/rejoin': () => jsonResponse(500, { error: 'internal' }),
  });
  await assert.rejects(h3.client.queue('1v1'), (err) => err instanceof NetError && err.status === 500);
  assert.equal(h3.calls.filter((c) => c.url === '/api/queue').length, 1);
});

test('queue: a P2P queue refused by our SERVER match (409 kind server) never rejoins it: POST /api/leave { matchId } once, then the P2P queue is retried', async () => {
  const mid = 'c'.repeat(64);
  let queues = 0;
  const leaves = [];
  const h = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () =>
      ++queues === 1
        ? jsonResponse(409, { error: 'active_match', matchId: mid, kind: 'server', message: 'you still have a server match' })
        : jsonResponse(200, { status: 'matched', kind: 'p2p', roomId: 'room9', ticket: 'T', wsUrl: '/room/room9' }),
    '/api/leave': (init) => {
      leaves.push(JSON.parse(init.body));
      return jsonResponse(200, { ok: true, left: false, released: true });
    },
    '/api/rejoin': () => {
      throw new Error('a P2P queue must not rejoin the server match it was refused by');
    },
  });
  const a = await h.client.queue('1v1', 'p2p');
  assert.deepEqual(a, { kind: 'p2p', roomId: 'room9', ticket: 'T', wsUrl: '/room/room9' });
  assert.deepEqual(leaves, [{ matchId: mid }], 'the lock of THAT match is released');
  assert.equal(h.client.leaves, 1);
  const order = h.calls.map((c) => c.url).filter((u) => u !== '/api/config' && u !== '/api/guest');
  assert.deepEqual(order, ['/api/queue', '/api/leave', '/api/queue'], 'leave between the two queue calls, no rejoin');
  assert.deepEqual(h.calls.filter((c) => c.url === '/api/queue').map((c) => c.body.kind), ['p2p', 'p2p'], 'the retry is still a P2P queue');

  // An old server that keeps the lock: the second 409 fails with the reason, retried once only.
  const stuck = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => jsonResponse(409, { error: 'active_match', matchId: mid, kind: 'server', message: 'you still have a server match' }),
    '/api/leave': () => jsonResponse(200, { ok: true, left: false, released: false }),
  });
  await assert.rejects(
    stuck.client.queue('1v1', 'p2p'),
    (err) => err instanceof NetError && err.status === 409 && err.serverCode === 'active_match' && /el partido en servidor cccccccc sigue activo/.test(err.message),
  );
  assert.equal(stuck.calls.filter((c) => c.url === '/api/queue').length, 2);
  assert.equal(stuck.calls.filter((c) => c.url === '/api/rejoin').length, 0);
});

test('queue: a SERVER queue refused by our server match (409 kind server) still rejoins it (the reload / network-drop path)', async () => {
  const mid = 'd'.repeat(64);
  const rejoins = [];
  const h = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => jsonResponse(409, { error: 'active_match', matchId: mid, kind: 'server' }),
    '/api/rejoin': (init) => {
      rejoins.push(JSON.parse(init.body));
      return jsonResponse(200, { status: 'matched', matchId: mid, ticket: 'T7', wsUrl: '/ws/' + mid });
    },
    '/api/leave': () => {
      throw new Error('a server queue must not leave its own server match');
    },
  });
  const a = await h.client.queue('1v1', 'server');
  assert.deepEqual(a, { kind: 'server', matchId: mid, ticket: 'T7', wsUrl: '/ws/' + mid });
  assert.deepEqual(rejoins, [{ matchId: mid }]);
  assert.equal(h.client.matchId, mid);
  assert.equal(h.client.leaves, 0);
});

test('leaveMatch(matchId): POST /api/leave { matchId } (an explicit quit of a server match); without one the body stays {}', async () => {
  const bodies = [];
  const h = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/leave': (init) => {
      bodies.push(JSON.parse(init.body));
      return jsonResponse(200, { ok: true, left: false, released: bodies.length === 1 });
    },
  });
  await h.client.ensureGuest();
  assert.equal(await h.client.leaveMatch('e'.repeat(64)), true);
  assert.equal(await h.client.leaveMatch(), false);
  assert.deepEqual(bodies, [{ matchId: 'e'.repeat(64) }, {}]);
  const call = h.calls.find((c) => c.url === '/api/leave');
  assert.equal(call.init.headers.authorization, 'Bearer jwt-session', 'with the session');
  assert.equal(h.client.leaves, 2);
});

const ACCOUNT = (session, playerId = 'acc1') => ({ kind: 'account', playerId, name: 'Tomi', session, expiresAt: Date.now() + 3600_000 });

test('refreshBearer: an account session asked to last longer replaces lastBearer, only when it is the same player; failures keep the old one', async () => {
  const h = makeClient({});
  let next = ACCOUNT('jwt-a1');
  const asked = [];
  h.client.sessionProvider = async (minValidMs) => {
    asked.push(minValidMs);
    if (next instanceof Error) throw next;
    return next;
  };
  await h.client.ensureGuest();
  assert.equal(h.client.lastBearer, 'jwt-a1');
  next = ACCOUNT('jwt-a2');
  await h.client.refreshBearer(15 * 60_000);
  assert.deepEqual(asked, [undefined, 15 * 60_000]);
  assert.equal(h.client.lastBearer, 'jwt-a2');
  // Signed in as someone else since the queue: the match is still left as the player who queued.
  next = ACCOUNT('jwt-b1', 'acc2');
  await h.client.refreshBearer(15 * 60_000);
  assert.equal(h.client.lastBearer, 'jwt-a2');
  next = new Error('offline');
  await h.client.refreshBearer(15 * 60_000);
  assert.equal(h.client.lastBearer, 'jwt-a2');
  // A guest has nothing to renew.
  const g = makeClient({ '/api/guest': () => jsonResponse(200, GUEST) });
  g.client.sessionProvider = async () => null;
  await g.client.ensureGuest();
  await g.client.refreshBearer(15 * 60_000);
  assert.equal(g.client.lastBearer, 'jwt-session');
});

test('leaveMatch retryRejected: the first POST goes out at once; a 401 refreshes the account session and sends the leave once more', async () => {
  const auths = [];
  let session = 'jwt-a1';
  let refused = new Set(['Bearer jwt-a1']);
  const h = makeClient({
    '/api/leave': (init) => {
      auths.push(init.headers.authorization);
      return refused.has(init.headers.authorization) ? jsonResponse(401, { error: 'unauthorized' }) : jsonResponse(200, { ok: true, left: true, released: true });
    },
  });
  let rejected = 0;
  h.client.sessionProvider = async () => ACCOUNT(session);
  h.client.onSessionRejected = async () => {
    rejected++;
    session = `jwt-a${rejected + 1}`;
  };
  await h.client.ensureGuest();
  const leaving = h.client.leaveMatch('e'.repeat(64), { retryRejected: true });
  assert.deepEqual(auths, ['Bearer jwt-a1'], 'sent before leaveMatch returned (the caller closes the socket next)');
  assert.equal(await leaving, true);
  assert.equal(rejected, 1);
  assert.deepEqual(auths, ['Bearer jwt-a1', 'Bearer jwt-a2']);
  assert.deepEqual(h.calls.filter((c) => c.url === '/api/leave').map((c) => c.body), [{ matchId: 'e'.repeat(64) }, { matchId: 'e'.repeat(64) }]);
  assert.equal(h.client.leaves, 2);
  // Refused again with the fresh Bearer: once is all.
  refused = new Set(['Bearer jwt-a2', 'Bearer jwt-a3']);
  auths.length = 0;
  assert.equal(await h.client.leaveMatch('e'.repeat(64), { retryRejected: true }), false);
  assert.deepEqual(auths, ['Bearer jwt-a2', 'Bearer jwt-a3']);

  // Without retryRejected a 401 is the answer, as before; a guest has no fresh session to retry with.
  const g = makeClient({ '/api/guest': () => jsonResponse(200, GUEST), '/api/leave': () => jsonResponse(401, { error: 'unauthorized' }) });
  let asked = 0;
  g.client.onSessionRejected = async () => void asked++;
  await g.client.ensureGuest();
  assert.equal(await g.client.leaveMatch('e'.repeat(64)), false);
  assert.equal(asked, 0);
  assert.equal(await g.client.leaveMatch('e'.repeat(64), { retryRejected: true }), false);
  assert.equal(asked, 1);
  assert.equal(g.calls.filter((c) => c.url === '/api/leave').length, 2);
});

test('NetError carries the server code (serverCode) and retryAfterMs; recovery branches on the code, never on the message text', async () => {
  const P2 = await import('../src/net/p2p/protocol.ts');
  // 429 no_show: the code and the retry delay ride on the error.
  const ns = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => jsonResponse(429, { error: 'no_show', message: '3 room tickets taken without opening the room socket', retryAfterMs: 299_400.5 }),
  });
  await assert.rejects(ns.client.queue('1v1', 'p2p'), (err) => err instanceof NetError && err.status === 429 && err.serverCode === 'no_show' && err.retryAfterMs === 299_401 && /429 no_show: 3 room tickets/.test(err.message));
  // A p2p queue states this page's P2P protocol; a server queue does not.
  const body = ns.calls.find((c) => c.url === '/api/queue').body;
  assert.deepEqual(body, { mode: '1v1', kind: 'p2p', p2pProtocol: P2.P2P_PROTOCOL_VERSION });
  const sv = makeClient({ '/api/guest': () => jsonResponse(200, GUEST), '/api/queue': () => jsonResponse(426, { error: 'reload_required', message: 'reload the page' }) });
  await assert.rejects(sv.client.queue('1v1', 'server'), (err) => err instanceof NetError && err.serverCode === 'reload_required' && err.retryAfterMs === 0);
  assert.deepEqual(sv.calls.find((c) => c.url === '/api/queue').body, { mode: '1v1', kind: 'server' });
  // A body without a code (or not JSON): serverCode ''.
  const plain = makeClient({ '/api/guest': () => jsonResponse(200, GUEST), '/api/queue': () => ({ ok: false, status: 502, json: async () => { throw new Error('html'); } }) });
  await assert.rejects(plain.client.queue('1v1'), (err) => err instanceof NetError && err.status === 502 && err.serverCode === '' && err.message === 'queue failed (502)');
  // 410 whose MESSAGE mentions p2p_room but whose code is another: no /api/leave (the old regex would have left).
  let q = 0;
  const h = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => (++q === 1 ? jsonResponse(409, { error: 'active_match', matchId: 'abc', kind: 'server' }) : jsonResponse(200, { status: 'matched', matchId: 'm2', ticket: 'T2', wsUrl: '/ws/m2' })),
    '/api/rejoin': () => jsonResponse(410, { error: 'match_over', message: 'over (this is not a p2p_room)' }),
    '/api/leave': () => jsonResponse(200, { ok: true, left: false, released: false }),
  });
  await h.client.queue('1v1');
  assert.equal(h.calls.filter((c) => c.url === '/api/leave').length, 0, 'branching on serverCode, not on the text');
  // Turnstile codes with a message are still recognised (the code, not 'code: message').
  const ts = makeClient({ '/api/guest': () => jsonResponse(503, { error: 'turnstile_unconfigured', message: 'TURNSTILE_SITEKEY must be set' }) }).client;
  await assert.rejects(ts.ensureGuest(), (err) => err instanceof NetError && err.code === 'turnstile' && err.status === 503 && err.serverCode === 'turnstile_unconfigured');
  // A rejoin failure exposes its code too.
  const rj = makeClient({ '/api/guest': () => jsonResponse(200, GUEST), '/api/rejoin': () => jsonResponse(410, { error: 'p2p_room', message: 'a P2P room cannot be rejoined' }) }).client;
  await assert.rejects(rj.rejoin('r'.repeat(64)), (err) => err instanceof NetError && err.status === 410 && err.serverCode === 'p2p_room');
});

test('leaveMatch: POST /api/leave with the session, resolves with `released`; the next queue waits for it; without a session it is a no-op', async () => {
  const order = [];
  let resolveLeave;
  const h = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/leave': () => {
      order.push('leave');
      return new Promise((r) => (resolveLeave = () => r(jsonResponse(200, { ok: true, left: false, released: true }))));
    },
    '/api/queue': () => {
      order.push('queue');
      return jsonResponse(200, { status: 'matched', matchId: 'm', ticket: 'T', wsUrl: '/ws/m' });
    },
  });
  assert.equal(await h.client.leaveMatch(), false, 'no guest session yet: nothing to leave');
  await h.client.ensureGuest();
  const leaving = h.client.leaveMatch();
  const queued = h.client.queue('1v1');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ['leave'], 'the queue POST waits for the leave to finish');
  resolveLeave();
  assert.equal(await leaving, true);
  await queued;
  assert.deepEqual(order, ['leave', 'queue']);
  assert.equal(h.client.leaves, 1);
  // A failed leave does not block the queue.
  const h2 = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/leave': () => jsonResponse(500, { error: 'internal' }),
    '/api/queue': () => jsonResponse(200, { status: 'matched', matchId: 'm', ticket: 'T', wsUrl: '/ws/m' }),
  });
  await h2.client.ensureGuest();
  assert.equal(await h2.client.leaveMatch(), false);
  assert.equal((await h2.client.queue('1v1')).matchId, 'm');
});

test('connect: subprotocols carry the ticket, binaryType arraybuffer, ping / pong feed the clock', () => {
  const h = makeClient({});
  const { client, sockets } = h;
  client.connect('/ws/m1', 'JWT');
  assert.equal(sockets.length, 1);
  const ws = sockets[0];
  assert.deepEqual(ws.protocols, ['tg1', 'ticket.JWT']);
  assert.equal(ws.binaryType, 'arraybuffer');
  assert.equal(client.connected, false);
  ws.open();
  assert.equal(client.connected, true);
  // The open sent a ping with t0 = now.
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0][0], MsgType.Ping);
  assert.equal(decodePing(ws.sent[0]), 1000);
  // Pong: host clock offset 100, 40 ms rtt.
  const pong = new Uint8Array(P.PONG_LEN);
  h.setTime(1040);
  encodePong(pong, 1000, 1120, 1120, 777);
  ws.deliver(pong);
  assert.equal(client.clock.samples, 1);
  assert.equal(client.rtt, 40);
  assert.equal(client.clock.offset, 100);
  assert.equal(client.clock.lastHostTick, 777);
  const est = client.hostTickEstimate(1040);
  assert.ok(Math.abs(est - (777 + (1040 + 100 - 1120) / TICK_MS)) < 1e-9, `estimate ${est}`);
  assert.equal(client.bytesIn, P.PONG_LEN);
  assert.equal(client.bytesOut, P.PING_LEN);
});

test('sendInputs packs the batch into one reusable buffer; snapshots / events / welcome dispatch', () => {
  const h = makeClient({});
  const { client, sockets } = h;
  const got = { welcome: null, snapshots: [], events: [], errors: [] };
  client.onWelcome = (w) => (got.welcome = w);
  client.onSnapshot = (pkt) => got.snapshots.push({ tick: pkt.tick, hint: pkt.bufferHint, len: pkt.stateLen, hash: pkt.stateHash, in0: pkt.inputs[0], ack: pkt.lastInputTick });
  client.onEvent = (e) => got.events.push(e);
  client.onError = (code, msg) => got.errors.push([code, msg]);
  client.connect('ws://h/ws/m', 'T');
  const ws = sockets[0];
  ws.open();
  ws.sent.length = 0;

  const packed = new Int8Array(3 * 6);
  packed.set([127, -127, 0, 0, 0, 1, 10, 20, 30, 40, 50, 2, -1, -2, -3, -4, -5, 4]);
  assert.equal(client.sendInputs(100, 3, packed, 96), true);
  assert.equal(ws.sent.length, 1);
  const frame = ws.sent[0];
  assert.equal(frame.length, INPUT_HEADER + 18);
  const pkt = { firstTick: 0, count: 0, ackTick: 0, packed: new Int8Array(P.INPUT_MAX_BATCH * 6) };
  assert.equal(decodeInput(frame, pkt), true);
  assert.equal(pkt.firstTick, 100);
  assert.equal(pkt.count, 3);
  assert.equal(pkt.ackTick, 96);
  assert.deepEqual(Array.from(pkt.packed.subarray(0, 18)), Array.from(packed));
  assert.equal(client.sendInputs(1, 0, packed, 0), false, 'empty batch refused');
  assert.equal(client.sendInputs(1, 33, packed, 0), false, 'over INPUT_MAX_BATCH refused');
  assert.equal(client.bytesOut, P.PING_LEN + frame.length, 'the ping sent on open plus the input frame');

  // Welcome.
  const welcome = { protocol: P.PROTOCOL_VERSION, matchId: 'm', mode: '1v1', tickRate: 120, carId: 1, slot: 0, roster: [{ carId: 1, slot: 0, team: 0, name: 'A', kind: 'player' }, { carId: 2, slot: 1, team: 1, name: 'Bot', kind: 'bot' }], tick: 0, matchLengthSeconds: 300 };
  ws.deliver(encodeJson(MsgType.Welcome, welcome));
  assert.deepEqual(got.welcome, welcome);
  assert.equal(client.welcome.matchId, 'm');
  client.sendReady();
  assert.equal(ws.sent[ws.sent.length - 1][0], MsgType.Ready);

  // Snapshots: decoded into the reusable packet, loss / age / hint / ack tracked.
  const state = new Uint8Array(100);
  for (let i = 0; i < 100; i++) state[i] = i;
  const inputs = new Int8Array(12);
  inputs[0] = 55;
  const out = new Uint8Array(512);
  h.setTime(2000);
  let len = encodeSnapshot(out, 40, 38, -2, 2, inputs, state, 100, fnv1a32(state, 100));
  ws.deliver(out.subarray(0, len));
  h.setTime(2033);
  len = encodeSnapshot(out, 48, 46, 1, 2, inputs, state, 100, fnv1a32(state, 100));
  ws.deliver(out.subarray(0, len));
  assert.equal(got.snapshots.length, 2);
  assert.deepEqual(got.snapshots[1], { tick: 48, hint: 1, len: 100, hash: fnv1a32(state, 100), in0: 55, ack: 46 });
  assert.equal(client.snapshotsIn, 2);
  assert.equal(client.lastBufferHint, 1);
  assert.equal(client.lastInputTickAcked, 46);
  assert.equal(client.snapshotAge(2050), 17);
  assert.equal(client.loss.interval, 8);

  // Events / errors / kick.
  ws.deliver(encodeJson(MsgType.Event, { type: 'goal', team: 1, blue: 0, red: 1, tick: 50 }));
  assert.equal(got.events[0].type, 'goal');
  ws.deliver(encodeJson(MsgType.Error, { code: 'rate', message: 'slow down' }));
  assert.deepEqual(got.errors[0], ['rate', 'slow down']);
  ws.deliver(encodeJson(MsgType.Kick, { reason: 'idle' }));
  assert.deepEqual(got.errors[1], ['kick', 'idle']);
  // A truncated frame is ignored.
  ws.deliver(new Uint8Array([MsgType.Snapshot, 1, 2]));
  assert.equal(got.snapshots.length, 2);
});

test('reconnect once through /api/rejoin on an abnormal close; never on 1000 or after close()', async () => {
  let rejoins = 0;
  const h = makeClient({
    '/api/guest': () => jsonResponse(200, GUEST),
    '/api/queue': () => jsonResponse(200, { status: 'matched', matchId: 'm9', ticket: 'T1', wsUrl: '/ws/m9' }),
    '/api/rejoin': (init) => {
      rejoins++;
      assert.deepEqual(JSON.parse(init.body), { matchId: 'm9' });
      assert.equal(init.headers.authorization, `Bearer ${GUEST.session}`);
      return jsonResponse(200, { status: 'matched', matchId: 'm9', ticket: 'T2', wsUrl: '/ws/m9' });
    },
  });
  const { client, sockets } = h;
  const closes = [];
  client.onClose = (code, reason, reconnecting) => closes.push([code, reconnecting]);
  const m = await client.queue('1v1');
  client.connect(m.wsUrl, m.ticket);
  sockets[0].open();
  sockets[0].dropped(1006, 'network');
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rejoins, 1);
  assert.equal(sockets.length, 2);
  assert.deepEqual(sockets[1].protocols, ['tg1', 'ticket.T2']);
  assert.deepEqual(closes, [[1006, true]]);
  assert.equal(client.reconnects, 1);
  // Second drop: no further attempt.
  sockets[1].open();
  sockets[1].dropped(1006, 'again');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(rejoins, 1);
  assert.deepEqual(closes[1], [1006, false]);

  // A clean 1000 never reconnects.
  const h2 = makeClient({ '/api/rejoin': () => jsonResponse(200, { ticket: 'x', wsUrl: '/ws/x' }) });
  h2.client.matchId = 'mm';
  const c2 = [];
  h2.client.onClose = (code, reason, r) => c2.push([code, r]);
  h2.client.connect('/ws/mm', 't');
  h2.sockets[0].open();
  h2.sockets[0].dropped(1000, 'bye');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(c2, [[1000, false]]);
  assert.equal(h2.sockets.length, 1);

  // close() from our side: the socket closes with 1000 and the later close event is ours.
  const h3 = makeClient({});
  h3.client.matchId = 'q';
  h3.client.connect('/ws/q', 't');
  h3.sockets[0].open();
  h3.client.close(1000, 'leave');
  assert.deepEqual(h3.sockets[0].closed, { code: 1000, reason: 'leave' });
  assert.equal(h3.client.connected, false);
});

test('a protocol version mismatch in the Welcome closes the socket with an error', () => {
  const { client, sockets } = makeClient({});
  const errors = [];
  client.onError = (code, msg) => errors.push(code);
  client.connect('/ws/v', 't');
  sockets[0].open();
  sockets[0].deliver(encodeJson(MsgType.Welcome, { protocol: 99, matchId: 'v', mode: '1v1', tickRate: 120, carId: 1, slot: 0, roster: [], tick: 0, matchLengthSeconds: 0 }));
  assert.deepEqual(errors, ['protocol']);
  assert.equal(sockets[0].closed.code, 1002);
  assert.equal(client.connected, false);
});

test('packControls round-trips through the input ring bytes the client sends', () => {
  const c = { throttle: 0.5, steer: -1, pitch: 0.25, yaw: 0, roll: 1, jump: true, boost: false, handbrake: true };
  const packed = new Int8Array(6);
  T.packControls(c, packed, 0);
  const back = T.emptyControls();
  T.unpackControls(packed, 0, back);
  assert.ok(Math.abs(back.throttle - 0.5) < 1 / 127);
  assert.equal(back.steer, -1);
  assert.equal(back.roll, 1);
  assert.equal(back.jump, true);
  assert.equal(back.boost, false);
  assert.equal(back.handbrake, true);
});

test('resetNetStatsView puts a used view back to its idle values in place', async () => {
  const { newNetStatsView, resetNetStatsView } = await import('../src/net/NetStats.ts');
  const fresh = newNetStatsView();
  const used = newNetStatsView();
  used.state = 'playing';
  used.rttMs = 42;
  used.jitterMs = 3;
  used.lossPct = 1.5;
  used.lead = 6;
  used.leadAdjust = 2;
  used.hostTick = 1000;
  used.localTick = 1006;
  used.rateScale = 1.05;
  used.rollbacksPerSec = 30;
  used.replayedPerSec = 120;
  used.desyncs = 1;
  used.resyncs = 2;
  used.mispredictions = 3;
  used.errorCar = 12.5;
  used.bufferHint = -4;
  used.bytesInPerSec = 40000;
  used.bytesOutPerSec = 2000;
  used.snapshotAgeMs = 25;
  used.reconnects = 1;
  used.host = 'node:sao-paulo-1';
  resetNetStatsView(used);
  assert.deepEqual(used, fresh);
  assert.equal(used.snapshotAgeMs, -1);
});

// ---- One anti-bot flow at a time (the Hud has a single Turnstile slot) ------------------------

function turnstileClient() {
  const container = { hidden: true };
  const pending = [];
  const api = fakeTurnstile((opts) => pending.push(opts)); // answered by hand
  const h = makeClient(
    {
      '/api/config': () => jsonResponse(200, { turnstileSiteKey: 'sk-1', protocol: P.PROTOCOL_VERSION, version: '0.1.0', region: 'EZE' }),
      '/api/guest': () => jsonResponse(200, GUEST),
    },
    { turnstileContainer: () => container, turnstileLoader: async () => api },
  );
  h.client.setName('Tester');
  return { ...h, container, pending, api };
}

const ticks = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

test('guest: concurrent ensureGuest calls share one challenge and one registration', async () => {
  const { client, calls, container, pending, api } = turnstileClient();
  const a = client.ensureGuest();
  const b = client.ensureGuest();
  await ticks();
  assert.equal(api.rendered.length, 1, 'one widget while the first registration runs');
  pending[0].callback('tok-1');
  const [ga, gb] = await Promise.all([a, b]);
  assert.equal(ga.session, gb.session);
  assert.equal(calls.filter((c) => c.url === '/api/guest').length, 1, 'the caller that waited reuses the session');
  assert.equal(api.rendered.length, 1);
  assert.equal(container.hidden, true);
});

test('anti-bot: a sign-up challenge waits for the guest one (one widget in the slot at a time)', async () => {
  const { client, container, pending, api } = turnstileClient();
  const g = client.ensureGuest();
  const t = client.antiBotToken();
  await ticks();
  assert.equal(api.rendered.length, 1);
  pending[0].callback('tok-guest');
  await g;
  await ticks();
  assert.equal(api.rendered.length, 2, 'the second widget renders once the first one is gone');
  assert.deepEqual(api.removed, ['w1']);
  assert.equal(container.hidden, false, 'the second widget keeps the slot visible');
  pending[1].callback('tok-signup');
  assert.equal(await t, 'tok-signup');
  assert.equal(container.hidden, true);
});

test('cancelChallenge removes the widget on screen and drops the flows waiting for it', async () => {
  const { client, calls, container, pending, api } = turnstileClient();
  const g = client.ensureGuest();
  const t = client.antiBotToken();
  await ticks();
  assert.equal(api.rendered.length, 1);
  client.cancelChallenge();
  await assert.rejects(g, (err) => err instanceof NetError && err.code === 'cancelled');
  await assert.rejects(t, (err) => err instanceof NetError && err.code === 'cancelled');
  assert.equal(api.rendered.length, 1, 'the waiting flow never rendered a widget');
  assert.deepEqual(api.removed, ['w1']);
  assert.equal(container.hidden, true);
  assert.equal(calls.some((c) => c.url === '/api/guest'), false);
  // Flows started afterwards run normally.
  const again = client.ensureGuest();
  await ticks();
  assert.equal(api.rendered.length, 2);
  pending[1].callback('tok-2');
  assert.equal((await again).session, GUEST.session);
});

test('a queue cancelled while waiting for another challenge gives up without rendering', async () => {
  const { client, calls, pending, api } = turnstileClient();
  const signup = client.antiBotToken();
  await ticks();
  const q = client.queue('1v1');
  await ticks();
  assert.equal(api.rendered.length, 1, 'the queue waits for the sign-up widget');
  client.cancelQueue();
  await assert.rejects(q, (err) => err instanceof NetError && err.code === 'cancelled');
  pending[0].callback('tok-signup');
  assert.equal(await signup, 'tok-signup');
  await ticks();
  assert.equal(api.rendered.length, 1, 'the cancelled queue never rendered');
  assert.equal(calls.some((c) => c.url === '/api/guest' || c.url === '/api/queue'), false);
});

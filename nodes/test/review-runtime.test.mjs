// The node runtime and its control-plane agent against a scripted fake control plane (WebSocket +
// replay HTTP on one loopback port): drain vs in-flight uploads, stop vs update, the control plane
// clock, report re-sends, the WebRTC self-test schedule, bootId, and verification jobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_BUILD_VERSION, P, playRecordedMatch, roster1v1, testBuild } from './helpers.mjs';

const { NodeRuntime } = await import('../node/runtime.ts');
const { Agent } = await import('../node/agent.ts');
const { startHttp, readBody, header, json, errorJson } = await import('../node/http.ts');
const { acceptUpgrade } = await import('../node/wsServer.ts');
const { generateEd25519, verifyWith, sha256Hex, randomB64, importPrivateKey, importPublicKey } = await import('../shared/edcrypto.ts');
const { authMessage, replayRequestMessage, EXIT_UPDATE } = await import('../shared/controlProtocol.ts');
const { createNodeTicket, verifyNodeTicket } = await import('../shared/nodeTickets.ts');

const NODE_ID = 'n'.repeat(16);
const MATCH = 'm'.repeat(32);
const CAP = { matches: 2, cpuMsPerMatchSecond: 0, memMBPerMatch: 0, uplinkMbps: null, source: 'declared' };
const SPECS = { cpus: 1, cpuModel: 'test', memMB: 1024, arch: 'x64', os: 'test', node: '24' };
const MIN = 60_000;
const build = await testBuild();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 5_000, stepMs = 10) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await sleep(stepMs);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * A scripted control plane. Its clock is Date.now() + st.skewMs; replay requests are checked like
 * the real one (5 minutes of tolerance -> 401 'stale', node signature), answers carry a Date
 * header on that clock. st.dropAcks: the next N reports get no ack (a report it failed to process).
 * st.putUnavailable: while it returns true, replay uploads get a 503 (the Worker being deployed).
 * st.iceServers: the welcome's list, or a function minting one per welcome. opts.welcome: patched
 * into every welcome.
 */
async function fakeControl(opts = {}) {
  const nodeKeys = await generateEd25519();
  const ctlKeys = await generateEd25519();
  const st = {
    skewMs: opts.skewMs ?? 0,
    dropAcks: 0,
    putDelayMs: 0,
    putUnavailable: null,
    iceServers: [{ urls: 'stun:stun.test:3478' }, { urls: 'turn:turn.test:3478', username: 'u', credential: 'c' }],
    /** Logins (auth accepted). */
    logins: 0,
    replays: new Map(),
    /** Every message the node sent. */
    msgs: [],
    /** Every replay request: { method, matchId, status, code, ts, at }. */
    reqs: [],
    welcomesAt: [],
    conn: null,
  };
  const now = () => Date.now() + st.skewMs;
  const send = (m) => st.conn?.send(JSON.stringify(m));
  const welcome = (patch = {}) => {
    st.welcomesAt.push(performance.now());
    const iceServers = typeof st.iceServers === 'function' ? st.iceServers() : st.iceServers;
    send({ t: 'welcome', nodeId: NODE_ID, status: 'active', region: 'SA', channel: { stable: FAKE_BUILD_VERSION, minimum: '0.0.0' }, serverTime: now(), iceServers, ...opts.welcome, ...patch });
  };
  const srv = await startHttp(0, '127.0.0.1', {
    onRequest: async (req, res) => {
      const m = /^\/nodes\/replays\/([0-9A-Za-z_-]{8,64})$/.exec(new URL(req.url ?? '/', 'http://x').pathname);
      if (!m || (req.method !== 'PUT' && req.method !== 'GET')) return errorJson(res, 404, 'not_found');
      const date = { date: new Date(now()).toUTCString() };
      const ts = Number(header(req, 'x-node-ts'));
      const sig = header(req, 'x-node-sig') ?? '';
      const sha = header(req, 'x-replay-sha256') ?? '';
      const log = (status, code) => st.reqs.push({ method: req.method, matchId: m[1], status, code, ts, at: performance.now() });
      const bytes = req.method === 'PUT' ? await readBody(req, 16 * 1024 * 1024) : null;
      if (!Number.isFinite(ts) || Math.abs(now() - ts) > 5 * MIN) {
        log(401, 'stale');
        return json(res, 401, { error: 'stale' }, date);
      }
      if (!(await verifyWith(nodeKeys.publicKey, replayRequestMessage(req.method, m[1], sha, ts), sig))) {
        log(401, 'bad_sig');
        return json(res, 401, { error: 'bad_sig' }, date);
      }
      if (req.method === 'GET') {
        const stored = st.replays.get(m[1]);
        log(stored ? 200 : 404, stored ? null : 'no_replay');
        if (!stored) return json(res, 404, { error: 'no_replay' }, date);
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...date });
        return void res.end(stored);
      }
      if ((await sha256Hex(bytes)) !== sha) {
        log(400, 'sha_mismatch');
        return json(res, 400, { error: 'sha_mismatch' }, date);
      }
      if (st.putUnavailable?.()) {
        log(503, 'unavailable');
        return json(res, 503, { error: 'unavailable' }, date);
      }
      if (st.putDelayMs > 0) await sleep(st.putDelayMs);
      st.replays.set(m[1], bytes);
      log(200, null);
      return json(res, 200, { ok: true }, date);
    },
    onUpgrade: (req, socket, head) => {
      if (new URL(req.url ?? '/', 'http://x').pathname !== '/nodes/connect') return socket.destroy();
      const conn = acceptUpgrade(req, socket, head);
      if (!conn) return;
      st.conn = conn;
      const nonce = randomB64(16);
      conn.onmessage = async (data) => {
        const msg = JSON.parse(new TextDecoder().decode(data));
        st.msgs.push({ ...msg, at: performance.now() });
        if (msg.t === 'auth') {
          if (msg.nodeId !== NODE_ID || !(await verifyWith(nodeKeys.publicKey, authMessage(NODE_ID, nonce), msg.sig))) return conn.close(4001, 'bad_auth');
          st.logins++;
          welcome();
        } else if (msg.t === 'report') {
          if (st.dropAcks > 0) st.dropAcks--;
          else send({ t: 'ack', id: msg.id });
        }
      };
      conn.onclose = () => {
        if (st.conn === conn) st.conn = null;
      };
      conn.send(JSON.stringify({ t: 'challenge', nonce }));
    },
  });
  const base = `127.0.0.1:${srv.port}`;
  return {
    st,
    now,
    send,
    welcome,
    /** A player ticket for this node, issued on the control plane's clock. */
    ticket: async (t) => createNodeTicket(await importPrivateKey(ctlKeys.privateKey), { ...t, nodeId: NODE_ID }, now()),
    controlPublicKey: ctlKeys.publicKey,
    agentIdentity: { nodeId: NODE_ID, privateKey: nodeKeys.privateKey, controlUrl: `ws://${base}/nodes/connect`, httpBase: `http://${base}` },
    identity: (roles = ['host'], transports = ['rtc']) => ({
      nodeId: NODE_ID,
      operatorId: 'o'.repeat(16),
      name: 'review-node',
      region: 'SA',
      privateKey: nodeKeys.privateKey,
      publicKey: nodeKeys.publicKey,
      controlPublicKey: ctlKeys.publicKey,
      controlUrl: `ws://${base}/nodes/connect`,
      httpBase: `http://${base}`,
      roles,
      transports,
      publicUrl: null,
    }),
    replayUrl: (matchId) => `http://${base}/nodes/replays/${matchId}`,
    msgsOf: (t) => st.msgs.filter((m) => m.t === t),
    close: async () => {
      st.conn?.close(1000, 'bye');
      await srv.close();
    },
  };
}

const okSelfTest = async () => ({ ok: true, relay: false, ms: 1 });

function runtime(cp, extra = {}) {
  const logs = [];
  const exits = [];
  const rt = new NodeRuntime({
    identity: cp.identity(extra.roles, extra.transports),
    build,
    specs: SPECS,
    capacity: CAP,
    listenPort: 0,
    listenHost: '127.0.0.1',
    heartbeatMs: 1_000,
    log: (m) => logs.push(m),
    selfTest: okSelfTest,
    onExit: (code) => exits.push(code),
    ...extra.opts,
  });
  return { rt, logs, exits };
}

// Bare agent handlers: only what the agent calls on its own.
const stubHandlers = {
  hello: () => ({ build, roles: ['host'], transports: ['rtc'], publicUrl: null, rtcReady: false, specs: SPECS, capacity: CAP, draining: false, egressCapGB: null }),
  heartbeat: () => ({ active: 0, capacity: 1, draining: false, egressGB: 0, egressCapGB: null, tickLagP99Ms: 0, cpuLoad: 0, rssMB: 0, matches: [] }),
  assign: async () => ({ wsUrl: null }),
  leave: async () => ({ slot: 0, closed: true, already: false, ended: false }),
  verify: async () => {
    throw new Error('no');
  },
  rtcOffer: async () => ({ sdp: '' }),
  drain() {},
  update() {},
  welcome() {},
  status() {},
};
const RESULT = { winner: -1, blue: 0, red: 0, endTick: 600, endReason: 'left' };
const STATS = { ticks: 600, durationMs: 5_000, slots: [], tickLagP99Ms: 0, egressBytes: 0 };
const replayBytes = (tag) => new TextEncoder().encode(`replay bytes ${tag}`);

test('a draining node does not exit while its last replay is uploading or its report is unacknowledged (exit 0 after both)', async () => {
  const cp = await fakeControl({ skewMs: 15 * MIN }); // the control plane's clock is 15 min ahead of ours
  cp.st.putDelayMs = 400;
  const { rt, exits } = runtime(cp, { opts: { timings: { startGraceMs: 10 } } });
  let atExit = null;
  rt.opts.onExit = (code) => {
    exits.push(code);
    atExit = { code, puts: cp.st.reqs.filter((r) => r.method === 'PUT' && r.status === 200).length, reports: cp.msgsOf('report').map((m) => m.report.kind), backlog: rt.agent.backlog };
  };
  try {
    await rt.start();
    await rt.agent.whenConnected();
    assert.equal(rt.status, 'active');
    const roster = roster1v1(true, false);
    await rt['assign']({ matchId: MATCH, mode: '1v1', region: 'SA', ranked: false, roster, matchLengthSeconds: 60, kickoffSeed: 1, botDifficulty: 'medium', createdAt: cp.now() });
    const room = rt.rooms.get(MATCH);
    // The room gets the control plane's clock (createdAt and the TTL are on it).
    assert.ok(Math.abs(room['ctx'].serverNow() - cp.now()) < 2_000, 'RoomContext.serverNow follows the welcome');
    const ws = { remoteAddress: '127.0.0.1', protocol: P.WS_SUBPROTOCOL, open: true, bufferedAmount: 0, bytesSent: 0, onmessage: null, onclose: null, send() {}, close() {} };
    room.attach(ws, { sub: roster[0].playerId, mid: MATCH, team: 0, slot: 0, role: 'player', name: 'Azul', iat: 0, exp: 0, jti: 'j'.repeat(32), aud: NODE_ID });
    ws.onmessage(new Uint8Array([P.MsgType.Ready]), false);
    await waitFor(() => room.status().tick > 30);

    rt.requestStop();
    const left = await rt['leave'](MATCH, roster[0].playerId);
    assert.equal(left.ended, true);
    await waitFor(() => !rt.rooms.has(MATCH));
    assert.equal(rt.agent.backlog, 1, 'the upload in flight counts in the backlog');
    assert.deepEqual(exits, [], 'no exit while the replay is uploading');
    await waitFor(() => atExit !== null, 5_000);
    assert.equal(atExit.code, 0);
    assert.equal(atExit.puts, 1, 'the replay was stored before the exit (signed on the control plane clock)');
    assert.deepEqual(atExit.reports, ['ended'], 'the report was sent before the exit');
    assert.equal(atExit.backlog, 0, 'and acknowledged');
    assert.deepEqual(exits, [0]);
  } finally {
    await rt.stop();
    await cp.close();
  }
});

test('a requested stop exits 0 whether an update arrives before or after it; an update alone exits 75', async () => {
  const fakeRoom = { status: () => ({ matchId: 'fakefake', tick: 0, phase: 'kickoff', sockets: 0 }), dispose() {} };
  for (const order of ['update-then-stop', 'stop-then-update', 'update-only']) {
    const cp = await fakeControl();
    const { rt, exits } = runtime(cp);
    try {
      await rt.start();
      await rt.agent.whenConnected();
      rt.rooms.set('fakefake', fakeRoom); // a match still running holds the exit
      if (order !== 'stop-then-update') {
        cp.send({ t: 'update', version: '9.9.9' });
        await waitFor(() => rt.updateTo === '9.9.9');
      }
      if (order !== 'update-only') rt.requestStop();
      if (order === 'stop-then-update') {
        cp.send({ t: 'update', version: '9.9.9' });
        await waitFor(() => rt.updateTo === '9.9.9');
      }
      // A later update (the channel moved again) does not override the stop either.
      if (order !== 'update-only') {
        cp.send({ t: 'update', version: '9.9.10' });
        await waitFor(() => rt.updateTo === '9.9.10');
      }
      assert.equal(rt.draining, true);
      assert.deepEqual(exits, [], `${order}: no exit while a match runs`);
      rt.rooms.delete('fakefake');
      rt['maybeExit'](); // what the room's onClosed does
      await waitFor(() => exits.length > 0);
      assert.deepEqual(exits, [order === 'update-only' ? EXIT_UPDATE : 0], order);
    } finally {
      await rt.stop();
      await cp.close();
    }
  }
});

test('replay requests are signed on the control plane clock; a stale answer is retried after a re-sync, not reported lost', async () => {
  const cp = await fakeControl({ skewMs: 20 * MIN });
  let agent = new Agent(cp.agentIdentity, stubHandlers, { log: () => undefined, uploadRetryMs: 20, staleWaitMs: 5_000 });
  try {
    agent.start();
    await agent.whenConnected();
    assert.ok(Math.abs(agent.serverNow() - cp.now()) < 2_000, 'offset taken from welcome.serverTime');

    // 1. Our clock is 20 min behind: still accepted (the old node signed with Date.now(): 401 stale -> lost).
    await agent.submitEnded('match0001', RESULT, replayBytes(1), STATS);
    assert.deepEqual(cp.st.reqs.map((r) => r.status), [200]);
    await waitFor(() => agent.backlog === 0);
    assert.deepEqual(cp.msgsOf('report').map((m) => m.report.kind), ['ended']);

    // The verifier's signed download uses the same clock.
    const sha = await sha256Hex(replayBytes(1));
    const got = await agent.fetchReplay({ matchId: 'match0001', leaves: [], hostNodeId: NODE_ID, replayUrl: cp.replayUrl('match0001'), replaySha256: sha, expect: {} });
    assert.deepEqual([...got], [...replayBytes(1)]);

    // 2. The control plane's clock moves 10 more minutes: refused as 'stale', the upload waits for
    //    the next welcome (it carries serverTime) and goes through; nothing is reported lost.
    cp.st.skewMs = 30 * MIN;
    const p = agent.submitEnded('match0002', RESULT, replayBytes(2), STATS);
    await waitFor(() => cp.st.reqs.some((r) => r.matchId === 'match0002' && r.code === 'stale'));
    assert.equal(agent.backlog, 1, 'waiting, still in the backlog');
    await sleep(100);
    assert.equal(cp.st.reqs.filter((r) => r.matchId === 'match0002').length, 1, 'no blind retry before the welcome');
    cp.welcome();
    await p;
    const r2 = cp.st.reqs.filter((r) => r.matchId === 'match0002');
    assert.deepEqual(r2.map((r) => r.status), [401, 200]);
    assert.ok(r2[1].at > cp.st.welcomesAt.at(-1), 'retried after the welcome');
    await waitFor(() => agent.backlog === 0);
    assert.deepEqual(cp.msgsOf('report').map((m) => `${m.report.kind}:${m.report.matchId}`), ['ended:match0001', 'ended:match0002']);
    await agent.stop();

    // 3. No welcome comes (still connected, the local clock jumped): the refusal's Date header re-syncs it.
    agent = new Agent(cp.agentIdentity, stubHandlers, { log: () => undefined, uploadRetryMs: 20, staleWaitMs: 100 });
    agent.start();
    await agent.whenConnected();
    cp.st.skewMs = 45 * MIN;
    await agent.submitEnded('match0003', RESULT, replayBytes(3), STATS);
    assert.deepEqual(cp.st.reqs.filter((r) => r.matchId === 'match0003').map((r) => r.status), [401, 200]);
    assert.ok(Math.abs(agent.serverNow() - cp.now()) < 3_000);
    await waitFor(() => agent.backlog === 0);
    assert.equal(cp.msgsOf('report').filter((m) => m.report.kind === 'lost').length, 0);
  } finally {
    await agent.stop();
    await cp.close();
  }
});

test('a replay upload outlasts a minute of control plane errors (a Worker deploy); it gives up after about 75 s', async () => {
  const cp = await fakeControl();
  // The retry waits run on a virtual clock: the defaults (12 attempts, 0.5 s doubling to 10 s) are
  // what is under test, and they add up to more than a minute.
  let clockMs = 0;
  const waits = [];
  const agent = new Agent(cp.agentIdentity, stubHandlers, {
    log: () => undefined,
    sleep: async (ms) => {
      waits.push(ms);
      clockMs += ms;
    },
  });
  try {
    agent.start();
    await agent.whenConnected();
    cp.st.putUnavailable = () => clockMs < 60_000;
    await agent.submitEnded('match0001', RESULT, replayBytes(1), STATS);
    const statuses = cp.st.reqs.filter((r) => r.matchId === 'match0001').map((r) => r.status);
    assert.deepEqual(statuses, [...Array(10).fill(503), 200], 'ten refusals over 65.5 s, then stored');
    assert.ok(clockMs >= 60_000);
    await waitFor(() => agent.backlog === 0);
    assert.deepEqual(cp.msgsOf('report').map((m) => m.report.kind), ['ended']);

    // The control plane never comes back: 12 attempts, about 75 s of waits, then the match is lost.
    waits.length = 0;
    cp.st.putUnavailable = () => true;
    await agent.submitEnded('match0002', RESULT, replayBytes(2), STATS);
    assert.equal(cp.st.reqs.filter((r) => r.matchId === 'match0002').length, 12);
    assert.deepEqual(waits, [500, 1_000, 2_000, 4_000, 8_000, ...Array(6).fill(10_000)]);
    assert.equal(waits.reduce((a, b) => a + b, 0), 75_500);
    await waitFor(() => agent.backlog === 0);
    assert.deepEqual(cp.msgsOf('report').map((m) => `${m.report.kind}:${m.report.matchId}`), ['ended:match0001', 'lost:match0002']);
  } finally {
    await agent.stop();
    await cp.close();
  }
});

test('unacknowledged reports are re-sent periodically while connected, and no longer once acked', async () => {
  const cp = await fakeControl();
  const agent = new Agent(cp.agentIdentity, stubHandlers, { log: () => undefined, resendMs: 60, resendAfterMs: 40 });
  try {
    agent.start();
    await agent.whenConnected();
    cp.st.dropAcks = 2; // the control plane fails to process the first two copies
    agent.submit({ kind: 'lost', matchId: 'match0001', reason: 'tick_error' });
    await waitFor(() => agent.backlog === 0, 3_000);
    const copies = () => cp.msgsOf('report').filter((m) => m.id === 'lost:match0001').length;
    assert.equal(copies(), 3);
    await sleep(250);
    assert.equal(copies(), 3, 'acked: not sent again');
    // A fresh report is not re-sent before it is resendAfterMs old.
    cp.st.dropAcks = 1;
    agent.submit({ kind: 'cancelled', matchId: 'match0002', reason: 'no_show', noShows: [] });
    await sleep(20);
    assert.equal(cp.msgsOf('report').filter((m) => m.id === 'cancelled:match0002').length, 1);
    await waitFor(() => agent.backlog === 0, 3_000);
  } finally {
    await agent.stop();
    await cp.close();
  }
});

test('WebRTC self-test: backoff while failing, refresh while passing, re-run after a welcome during a test; hello carries rtcRelay and one bootId', async () => {
  const cp = await fakeControl();
  const calls = [];
  const results = [false, false, false, true]; // then always ok
  let gate = null;
  const selfTest = async (cfg) => {
    calls.push({ at: performance.now(), ice: cfg.iceServers.map((s) => s.urls).join(',') });
    if (gate) await gate.promise;
    const ok = results.length > 0 ? results.shift() : true;
    return { ok, relay: ok, ms: 1, ...(ok ? {} : { error: 'no channel' }) };
  };
  const { rt } = runtime(cp, { opts: { selfTest, rtcSchedule: { retryMs: 50, maxRetryMs: 120, refreshMs: 300 } } });
  try {
    await rt.start();
    // welcome -> fail, +50 fail, +100 fail, +120 (cap) pass, +300 refresh
    await waitFor(() => calls.length >= 5, 5_000);
    const gap = (i) => calls[i].at - calls[i - 1].at;
    assert.ok(gap(1) >= 45 && gap(1) < 250, `first retry ${gap(1)}`);
    assert.ok(gap(2) >= 95 && gap(2) < 300, `second retry ${gap(2)}`);
    assert.ok(gap(3) >= 115 && gap(3) < 320, `capped retry ${gap(3)}`);
    assert.ok(gap(4) >= 295, `refresh ${gap(4)}`);
    assert.equal(rt.rtcReady, true);
    assert.equal(rt.rtcRelay, true);
    const hellos = cp.msgsOf('hello').map((m) => m.data);
    assert.equal(hellos[0].rtcReady, false, 'the hello at welcome: not tested yet');
    assert.ok(hellos.some((h) => h.rtcReady === true && h.rtcRelay === true), 'a re-hello reports the relay');
    assert.match(hellos[0].bootId, /^[0-9a-f]{32}$/);
    assert.ok(hellos.every((h) => h.bootId === hellos[0].bootId), 'one bootId per process');

    // A welcome arrives while a test runs: the running test finishes, then one more runs at once
    // with the newest ICE servers (the old node dropped it until the next welcome).
    gate = deferred();
    cp.st.iceServers = [{ urls: 'turn:a.test:3478', username: 'u', credential: 'a' }];
    cp.welcome();
    await waitFor(() => calls.at(-1).ice === 'turn:a.test:3478');
    const n = calls.length;
    cp.st.iceServers = [{ urls: 'turn:b.test:3478', username: 'u', credential: 'b' }];
    cp.welcome();
    await sleep(30);
    assert.equal(calls.length, n, 'no second test in parallel');
    const released = performance.now();
    const g = gate;
    gate = null;
    g.resolve();
    await waitFor(() => calls.length > n);
    assert.equal(calls[n].ice, 'turn:b.test:3478');
    assert.ok(calls[n].at - released < 150, 'right after, not at the next refresh');

    // Relay lost (TURN no longer works, host candidates do): rtcReady stays, rtcRelay goes false in a re-hello.
    results.push(true);
    const lastHellos = cp.msgsOf('hello').length;
    rt.opts.selfTest = async (cfg) => {
      calls.push({ at: performance.now(), ice: cfg.iceServers.map((s) => s.urls).join(',') });
      return { ok: true, relay: false, ms: 1 };
    };
    cp.welcome();
    await waitFor(() => rt.rtcRelay === false);
    assert.equal(rt.rtcReady, true);
    await waitFor(() => cp.msgsOf('hello').slice(lastHellos).some((m) => m.data.rtcReady === true && m.data.rtcRelay === false));
  } finally {
    await rt.stop();
    await cp.close();
  }
});

/** Short-lived TURN credentials, REST style ("<expiry ms>:<name>"), and a self-test that fails on expired ones like TURN does. */
function expiringTurn(ttlMs) {
  let minted = 0;
  const calls = [];
  return {
    calls,
    mint: (name = `w${++minted}`) => [{ urls: 'stun:stun.test:3478' }, { urls: 'turn:turn.test:3478', username: `${Date.now() + ttlMs}:${name}`, credential: 'x' }],
    selfTest: async (cfg) => {
      const turn = cfg.iceServers.find((s) => /^turns?:/.test(s.urls));
      const [expiry, name] = turn ? turn.username.split(':') : ['0', 'none'];
      const expired = Number(expiry) <= Date.now();
      calls.push({ at: performance.now(), name, expired });
      return expired ? { ok: false, relay: false, ms: 1, error: 'TURN 401' } : { ok: true, relay: true, ms: 1 };
    },
  };
}

test('scheduled self-tests never use expired TURN credentials: an idle node logs in again for fresh ones, a busy one waits (or takes a player offer\'s)', async () => {
  const cp = await fakeControl();
  const turn = expiringTurn(400);
  cp.st.iceServers = () => turn.mint();
  const { rt } = runtime(cp, { opts: { selfTest: turn.selfTest, rtcSchedule: { retryMs: 50, maxRetryMs: 100, refreshMs: 250, iceFreshMs: 150, quietPollMs: 40 } } });
  const fakeRoom = { status: () => ({ matchId: 'fakefake', tick: 0, phase: 'kickoff', sockets: 0 }), dispose() {} };
  try {
    await rt.start();
    await waitFor(() => turn.calls.length >= 1);
    assert.equal(rt.rtcRelay, true);
    // The refresh comes when the welcome's credentials are too old: a new login, a new welcome, a test with its credentials.
    await waitFor(() => turn.calls.length >= 2);
    assert.equal(cp.st.logins, 2, 'logged in again for fresh ICE servers');
    assert.equal(turn.calls[1].name, 'w2');
    assert.ok(turn.calls[1].at - turn.calls[0].at >= 245, 'at the refresh, not before');

    // Busy (a match runs): no new login and no test with the old credentials...
    rt.rooms.set('fakefake', fakeRoom);
    const before = turn.calls.length;
    await sleep(450); // the refresh came due ~200 ms ago and was polled since
    assert.equal(turn.calls.length, before, 'no test with stale credentials');
    assert.equal(cp.st.logins, 2, 'no new login while a match runs');
    // ...until a player's offer brings credentials minted just now (the offer itself is for no match here).
    cp.send({ t: 'rtcOffer', rid: 'o1', matchId: 'x'.repeat(16), ticket: 't', sdp: 'v=0', iceServers: turn.mint('offer') });
    await waitFor(() => turn.calls.length > before, 1_000);
    assert.equal(turn.calls.at(-1).name, 'offer');
    assert.equal(cp.st.logins, 2);

    // Idle again: the next refresh logs in again.
    rt.rooms.delete('fakefake');
    await waitFor(() => cp.st.logins === 3 && turn.calls.at(-1).name === 'w3', 2_000);

    assert.ok(turn.calls.every((c) => !c.expired), JSON.stringify(turn.calls));
    const hellos = cp.msgsOf('hello').map((m) => m.data);
    const firstReady = hellos.findIndex((h) => h.rtcReady);
    assert.ok(firstReady >= 0);
    assert.ok(hellos.slice(firstReady).every((h) => h.rtcReady && h.rtcRelay), 'never downgraded');
    assert.ok(hellos.every((h) => h.bootId === hellos[0].bootId), 'a re-login is the same process');
  } finally {
    await rt.stop();
    await cp.close();
  }
});

test('a welcome without TURN (the control plane could not mint credentials): passing without relay is retried with backoff, with new servers', async () => {
  const cp = await fakeControl();
  const turn = expiringTurn(60_000);
  let welcomes = 0;
  cp.st.iceServers = () => (++welcomes === 1 ? [{ urls: 'stun:stun.test:3478' }] : turn.mint());
  const calls = [];
  const selfTest = async (cfg) => {
    const relay = cfg.iceServers.some((s) => /^turns?:/.test(s.urls));
    calls.push({ at: performance.now(), relay });
    return { ok: true, relay, ms: 1 };
  };
  const { rt } = runtime(cp, { opts: { selfTest, rtcSchedule: { retryMs: 60, maxRetryMs: 120, refreshMs: 60_000, iceFreshMs: 60_000, quietPollMs: 40 } } });
  try {
    await rt.start();
    await waitFor(() => calls.length >= 2, 2_000);
    assert.equal(calls[0].relay, false);
    assert.equal(calls[1].relay, true, 'the retry got a list with TURN');
    assert.ok(calls[1].at - calls[0].at >= 55, 'after the first backoff step, not the 30-min refresh');
    assert.equal(cp.st.logins, 2);
    await waitFor(() => cp.msgsOf('hello').some((m) => m.data.rtcReady && m.data.rtcRelay));
    await sleep(200);
    assert.equal(calls.length, 2, 'passing through TURN: the next run is the refresh');
  } finally {
    await rt.stop();
    await cp.close();
  }
});

test('player tickets are checked on the control plane clock (a node whose clock runs 3 min ahead still admits players)', async () => {
  const cp = await fakeControl({ skewMs: -3 * MIN }); // the control plane is 3 min behind this machine
  const { rt } = runtime(cp, { transports: ['wss', 'rtc'] });
  const roster = roster1v1(true, true);
  try {
    await rt.start();
    await rt.agent.whenConnected();
    await rt['assign']({ matchId: MATCH, mode: '1v1', region: 'SA', ranked: false, roster, matchLengthSeconds: 60, kickoffSeed: 1, botDifficulty: 'medium', createdAt: cp.now() });
    const t0 = await cp.ticket({ sub: roster[0].playerId, mid: MATCH, team: 0, slot: 0, name: 'Azul' });
    const t1 = await cp.ticket({ sub: roster[1].playerId, mid: MATCH, team: 1, slot: 1, name: 'Rojo' });
    const pub = await importPublicKey(cp.controlPublicKey);
    assert.equal(await verifyNodeTicket(pub, t0, MATCH, NODE_ID), null, 'on this machine\'s clock the fresh ticket looks expired');

    // rtc: the offer relayed by the control plane gets past the ticket check, and only then fails
    // on its fake SDP (refused before any peer connection is made: nothing lingers).
    cp.send({ t: 'rtcOffer', rid: 'o1', matchId: MATCH, ticket: t0, sdp: 'not an offer', iceServers: [] });
    const reply = await waitFor(() => cp.msgsOf('reply').find((x) => x.rid === 'o1'), 5_000);
    assert.equal(reply.code, 'bad_offer', JSON.stringify(reply));

    // wss: the upgrade is accepted.
    const ws = new WebSocket(`ws://127.0.0.1:${rt.port}/m/${MATCH}`, [P.WS_SUBPROTOCOL, P.WS_TICKET_PREFIX + t1]);
    const opened = await new Promise((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
    });
    assert.equal(opened, true, 'upgrade accepted');
    ws.close();
  } finally {
    await rt.stop();
    await cp.close();
  }
});

test('a welcome that makes the node exit (idle, below the channel minimum) leaves no session timer running', async () => {
  const cp = await fakeControl({ welcome: { channel: { stable: '99.0.0', minimum: '99.0.0' } } });
  const { rt, exits } = runtime(cp);
  rt.opts.onExit = (code) => {
    exits.push(code);
    void rt.stop(); // what main.ts does
  };
  try {
    await rt.start();
    await waitFor(() => exits.length > 0);
    assert.deepEqual(exits, [EXIT_UPDATE]);
    await sleep(50);
    assert.equal(rt.agent['hbTimer'], null);
    assert.equal(rt.agent['resendTimer'], null);
    assert.equal(cp.msgsOf('hello').length, 0, 'no hello from a stopped agent');
  } finally {
    await rt.stop();
    await cp.close();
  }
});

test('verification: leaves reach the verifier, the job shape is checked, and the event loop keeps turning', async () => {
  const cp = await fakeControl({ skewMs: 12 * MIN });
  const roster = roster1v1(true, false);
  const m = await playRecordedMatch({ roster, lengthSeconds: 60, stopAt: 4800, takeovers: [{ tick: 4800, slot: 0 }], endReason: 'left' });
  cp.st.replays.set(MATCH, m.bytes);
  const sha = await sha256Hex(m.bytes);
  const { rt } = runtime(cp, { roles: ['verify'], transports: [] });
  const expect = { matchId: MATCH, mode: '1v1', region: 'SA', ranked: false, roster, matchLengthSeconds: 60, kickoffSeed: 1, botDifficulty: 'medium', createdAt: 0, kickoffCountdownSeconds: 1, goalPauseSeconds: 1 };
  const job = (patch = {}) => ({ matchId: MATCH, leaves: [roster[0].playerId], hostNodeId: NODE_ID, replayUrl: cp.replayUrl(MATCH), expect, replaySha256: sha, ...patch });
  let rid = 0;
  const ask = async (j) => {
    const id = `r${++rid}`;
    cp.send({ t: 'verify', rid: id, job: j });
    return waitFor(() => cp.msgsOf('reply').find((x) => x.rid === id), 20_000);
  };
  try {
    await rt.start();
    await rt.agent.whenConnected();
    for (const bad of [{ leaves: 'x' }, { leaves: [7] }, { leaves: undefined }, { replaySha256: 'zz' }, { matchId: '../x' }]) {
      const r = await ask(job(bad));
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(r.code, 'bad_job');
    }
    // The match ran 4800 ticks; a sliced verification lets a 1 ms timer fire between slices
    // (between the replay download and the verdict; a synchronous one: none).
    const fires = [];
    const iv = setInterval(() => fires.push(performance.now()), 1);
    const okReply = await ask(job());
    clearInterval(iv);
    assert.equal(okReply.ok, true, JSON.stringify(okReply));
    assert.equal(okReply.data.code, 'ok', JSON.stringify(okReply.data));
    assert.equal(okReply.data.endReason, 'left');
    const downloadedAt = cp.st.reqs.filter((r) => r.method === 'GET' && r.status === 200).at(-1).at;
    const during = fires.filter((t) => t > downloadedAt && t < okReply.at).length;
    assert.ok(during >= 8, `timers fired ${during} times during the verification`);
    // The same replay without the relayed leave: the takeover is not allowed.
    const noLeave = await ask(job({ leaves: [] }));
    assert.equal(noLeave.ok, true);
    assert.equal(noLeave.data.code, 'bad_takeover');
  } finally {
    await rt.stop();
    await cp.close();
  }
});

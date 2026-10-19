// A control plane with one fake node (no sockets) and a controllable clock: the harness of the
// control-plane tests. The node logs in, says hello and answers 'assign', 'leave' and 'verify'
// like a real one. It can drop its control link and reconnect, and outlive a restart of the
// control plane: a new Registry and ControlPlane loaded from the store, as after a Worker deploy.
import assert from 'node:assert/strict';
import { T, playRecordedMatch, testBuild } from './helpers.mjs';

const { ControlPlane } = await import('../control-plane/controlPlane.ts');
const { Registry } = await import('../control-plane/registry.ts');
const { Ledger } = await import('../control-plane/ledger.ts');
const { generateEd25519, importPrivateKey, sign, sha256Hex } = await import('../shared/edcrypto.ts');
const { authMessage, reachMessage, replayRequestMessage } = await import('../shared/controlProtocol.ts');
const { verifyReplay } = await import('../shared/verify.ts');
const { decodeReplay, ReplayWriter } = await import('../shared/replay.ts');
const { nodeSimFactory } = await import('../shared/nodeArena.ts');

export const SPECS = { cpus: 2, cpuModel: 'x', memMB: 4096, arch: 'x64', os: 'linux', node: '24' };
export const CAP = { matches: 4, cpuMsPerMatchSecond: 1, memMBPerMatch: 20, uplinkMbps: null, source: 'declared' };
export const URL_ = 'ws://198.51.100.9:7350';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function wait(fn, what = 'condition') {
  for (let i = 0; i < 400 && !fn(); i++) await sleep(10);
  assert.ok(fn(), what);
}

/** Rebuild a replay with `mutate(parsed)` applied. */
export function rewrite(bytes, mutate) {
  const r = decodeReplay(bytes);
  mutate(r);
  const w = new ReplayWriter(r.header);
  const recs = [];
  for (let i = 0; i < r.inputCount; i++) recs.push({ tick: r.inputTicks[i], o: 0, k: 'i', i });
  for (const t of r.takeovers) recs.push({ tick: t.tick, o: 1, k: 't', t });
  for (let i = 0; i < r.hashCount; i++) recs.push({ tick: r.hashTicks[i], o: 2, k: 'h', i });
  recs.sort((a, b) => a.tick - b.tick || a.o - b.o);
  for (const x of recs) {
    if (x.k === 'i') w.input(x.tick, r.inputSlots[x.i], r.inputData, x.i * T.PACKED_INPUT_BYTES);
    else if (x.k === 't') w.takeover(x.t.tick, x.t.slot);
    else w.hash(x.tick, r.hashValues[x.i]);
  }
  if (r.end) w.end(r.end);
  return w.finish();
}
export const leaveAtEnd = (slot) => (bytes) => rewrite(bytes, (r) => r.takeovers.push({ tick: r.end.tick + 1, slot }));

export const human = (c, extra = {}) => ({ playerId: c.repeat(16), name: c.toUpperCase(), account: true, accountAgeDays: 30, ...extra });

/**
 * A control plane with one fake node (wss, or rtc with opts.rtc), logged in and proven reachable.
 *   opts.trusted          the node's operator is the project's
 *   opts.roles            the node's roles (default ['host'])
 *   opts.status           set the node's status once it is reachable
 *   opts.store            what the Registry and the ControlPlane write through (restart() loads it)
 *   opts.restartGraceMs   the ControlPlane's
 *   opts.channel          the ControlPlane's channel option (default stable = the build, minimum 0.0.0)
 *   opts.onSend(m)        sees every message the control plane sends the node, in order
 *   opts.onOutcome(o)     sees every outcome as the control plane hands it on
 *   opts.noInline, opts.verify, opts.casualVerifyRate, opts.getDelay (a slow replay store)
 */
export async function setup(opts = {}) {
  const build = await testBuild();
  let clock = Date.now();
  const now = () => clock;
  const ctl = await generateEd25519();
  const nodeKeys = await generateEd25519();
  const nodeKey = await importPrivateKey(nodeKeys.privateKey);
  const store = opts.store;
  const trusted = opts.trusted ? ['op1'] : [];
  const replays = new Map();
  const realVerify = (bytes, job) => verifyReplay(bytes, { makeSim: nodeSimFactory, wasmSha256: build.wasmSha256, protocol: build.protocol, expect: job.expect, expectNodeId: job.hostNodeId, leaves: job.leaves });
  const env = {
    build,
    nodeKey,
    toNode: [],
    closes: [],
    outcomes: [],
    /** Every line the control plane and the registry logged. */
    logs: [],
    replays,
    store,
    nodeId: '',
    session: null,
    boot: 'boot-1',
    /** How the node answers a relayed leave: true (applied), false (refused: match_over), 'silent' (no reply). */
    leaveAnswers: true,
    /** Health probes the node answered or failed; while probeFails is a string, they fail with it. */
    probes: 0,
    probeFails: null,
    /** Hellos the node sent (one per login). */
    hellos: 0,
    /** The node's verdict for a 'verify' job (null: no reply). */
    onVerify: async (job) => (replays.has(job.matchId) ? realVerify(replays.get(job.matchId), job) : null),
  };
  const log = (m) => {
    env.logs.push(m);
    if (process.env.CPLOG) console.log('[cp] ' + m);
  };
  const newRegistry = () => new Registry({ allowInsecure: true, trustedOperators: trusted, store, log });
  const newControlPlane = (registry) =>
    new ControlPlane({
      controlPrivateKey: ctl.privateKey,
      controlPublicKey: ctl.publicKey,
      controlUrl: 'ws://cp/nodes/connect',
      httpBase: 'http://cp',
      build: () => build,
      channel: opts.channel ?? (() => ({ stable: build.version, minimum: '0.0.0' })),
      registry,
      ledger: new Ledger(),
      replays: {
        put: async (id, b) => void replays.set(id, b),
        get: async (id) => {
          if (opts.getDelay) await sleep(opts.getDelay);
          return replays.get(id) ?? null;
        },
      },
      inlineVerify: opts.noInline ? undefined : opts.verify ? (bytes, job) => opts.verify(bytes, job, realVerify) : realVerify,
      casualVerifyRate: opts.casualVerifyRate,
      fetchJson: async (url) => {
        env.probes++;
        if (env.probeFails) throw new Error(env.probeFails);
        const nonce = new URL(url.replace(/^ws/, 'http')).searchParams.get('nonce');
        return { nodeId: env.nodeId, sig: await sign(nodeKey, reachMessage(env.nodeId, nonce)) };
      },
      onOutcome: (o) => {
        env.outcomes.push(o);
        opts.onOutcome?.(o);
      },
      store,
      restartGraceMs: opts.restartGraceMs,
      now,
      log,
    });
  env.registry = newRegistry();
  env.cp = newControlPlane(env.registry);
  const roles = opts.roles ?? ['host'];
  const { token } = await env.registry.createToken({ id: 'op1', name: 'Operador' }, 'SA', clock);
  const reg = await env.registry.register({ token, publicKey: nodeKeys.publicKey, roles, ...(opts.rtc ? { publicUrl: null, transports: ['rtc'] } : { publicUrl: URL_ }), build, specs: SPECS, capacity: CAP }, clock);
  assert.ok(reg.ok);
  const nodeId = reg.node.nodeId;
  env.nodeId = nodeId;

  const transport = opts.rtc ? { transports: ['rtc'], publicUrl: null, rtcReady: true, rtcRelay: true } : { transports: ['wss'], publicUrl: URL_, rtcReady: false };
  const helloData = (patch = {}) => ({ bootId: env.boot, build, roles, ...transport, specs: SPECS, capacity: CAP, draining: false, egressCapGB: null, ...patch });
  const beatData = (patch = {}) => ({ active: 0, capacity: 4, draining: false, egressGB: 0, egressCapGB: null, tickLagP99Ms: 1, cpuLoad: 0.1, rssMB: 80, matches: [], ...patch });
  /** A message from the node on its current control link. */
  env.send = (m) => env.cp.onMessage(env.session, JSON.stringify(m));
  env.hello = (patch = {}) => env.send({ t: 'hello', data: helloData(patch) });
  env.heartbeat = (patch = {}) => env.send({ t: 'heartbeat', data: beatData(patch) });

  /** Open a control link to the current control plane; the node answers on the session it belongs to. */
  const connect = () => {
    const cp = env.cp;
    let session = null;
    const reply = (m) => cp.onMessage(session, JSON.stringify(m));
    const later = (m) => setTimeout(() => void reply(m), 0);
    const link = {
      send(m) {
        opts.onSend?.(m);
        env.toNode.push(m);
        if (m.t === 'challenge') void sign(nodeKey, authMessage(nodeId, m.nonce)).then((sig) => later({ t: 'auth', nodeId, sig }));
        if (m.t === 'welcome') {
          setTimeout(async () => {
            await reply({ t: 'hello', data: helloData() });
            env.hellos++;
            await reply({ t: 'heartbeat', data: beatData() });
          }, 0);
        }
        if (m.t === 'assign') later({ t: 'reply', rid: m.rid, ok: true, data: { wsUrl: opts.rtc ? null : `${URL_}/m/${m.match.matchId}` } });
        if (m.t === 'leave' && env.leaveAnswers === true) later({ t: 'reply', rid: m.rid, ok: true, data: { slot: 0, closed: true, already: false, ended: false } });
        if (m.t === 'leave' && env.leaveAnswers === false) later({ t: 'reply', rid: m.rid, ok: false, code: 'match_over' });
        if (m.t === 'rtcOffer') later({ t: 'reply', rid: m.rid, ok: true, data: { sdp: 'v=0' } });
        if (m.t === 'verify') {
          void Promise.resolve(env.onVerify(m.job)).then((verdict) => {
            if (verdict) later({ t: 'reply', rid: m.rid, ok: true, data: verdict });
          });
        }
      },
      close(code, reason) {
        env.closes.push({ code, reason });
      },
    };
    session = cp.open(link);
    env.session = session;
    return link;
  };
  connect();
  await wait(() => ['probation', 'active'].includes(env.registry.node(nodeId).status), 'node reachable');
  if (opts.status) env.registry.setStatus(nodeId, opts.status, null);

  /** The control link drops (the control plane sees the close). */
  env.disconnect = () => env.cp.onClose(env.session);
  /** The same node process logs in again; resolves after its hello and first heartbeat went in. */
  env.reconnect = async () => {
    const before = env.hellos;
    connect();
    await wait(() => env.hellos > before, 'hello after the reconnect');
    await sleep(0);
  };
  /**
   * The control plane restarts. `cold` (a deploy): its sockets are gone, and a new Registry and
   * ControlPlane load the store's rows. The node is not connected afterwards: reconnect().
   */
  env.restart = ({ cold = true } = {}) => {
    if (!env.session.closed) env.cp.onClose(env.session);
    const rows = store.rows();
    env.registry = newRegistry();
    env.registry.restore(rows);
    env.cp = newControlPlane(env.registry);
    env.cp.restore(rows.matches, { cold });
  };
  env.advance = (ms) => {
    clock += ms;
    // A live node keeps heart-beating while time passes (handled synchronously by onMessage).
    if (!env.session.closed) void env.heartbeat();
  };
  env.now = now;

  /** Place a match on the node. */
  env.place = async (humans, extra = {}) => {
    const p = await env.cp.place({ mode: '1v1', region: 'SA', ranked: false, humans, matchLengthSeconds: 10, kickoffCountdownSeconds: 1, goalPauseSeconds: 1, ...(opts.rtc ? { transports: ['rtc'] } : {}), ...extra });
    assert.ok(p, 'placed');
    return p;
  };
  /** Play it (scripted chasers) and upload the replay; returns the 'ended' report (patched) without sending it. */
  env.upload = async (p, { play = {}, mutate, report: patch = {}, stats: statsPatch, noAdvance = false } = {}) => {
    const a = env.cp.matches.get(p.matchId).assign;
    const humanSlots = a.roster.filter((e) => e.kind === 'player').map((e) => e.slot);
    // Default ending, whatever the (random) kickoff seed does: the rules by tick 1500, or everybody
    // gone ('empty', proven by 200 ticks of zero controls).
    const ending = 'stopAt' in play ? {} : { stopAt: 1500, endReason: 'empty', idleSlots: Object.fromEntries(humanSlots.map((s) => [s, 1300])) };
    const m = await playRecordedMatch({ roster: a.roster, seed: a.kickoffSeed, matchId: a.matchId, nodeId, lengthSeconds: a.matchLengthSeconds, region: a.region, ranked: a.ranked, mode: a.mode, ...ending, ...play });
    const bytes = mutate ? mutate(m.bytes) : m.bytes;
    const end = m.end;
    // The match took its game time (plus a second) on the control plane's clock too.
    if (!noAdvance) env.advance(Math.ceil((end.tick / 120) * 1000) + 1000);
    const sha = await sha256Hex(bytes);
    const ts = now();
    const up = await env.cp.storeReplay(a.matchId, nodeId, ts, await sign(nodeKey, replayRequestMessage('PUT', a.matchId, sha, ts)), sha, bytes);
    assert.ok(up.ok, JSON.stringify(up));
    const secs = end.tick / 120;
    const stats = statsPatch ?? { ticks: end.tick, durationMs: secs * 1000, slots: humanSlots.map((slot) => ({ slot, received: end.tick, dropped: 0, underruns: 0, overruns: 0, connectedMs: secs * 1000 })), tickLagP99Ms: 1, egressBytes: 1e6 };
    const result = { winner: end.winner, blue: end.blue, red: end.red, endTick: end.tick, endReason: end.reason, ...(end.forfeitTeam !== -1 ? { forfeitTeam: end.forfeitTeam } : {}), ...(patch.result ?? {}) };
    return { report: { kind: 'ended', matchId: a.matchId, result, replaySha256: sha, replayBytes: bytes.length, stats }, end };
  };
  /** Send a report; with waitDone, wait until its match settled. */
  env.report = async (report, { waitDone = true } = {}) => {
    await env.send({ t: 'report', id: `${report.kind}:${report.matchId}`, report });
    if (waitDone) await wait(() => env.cp.matches.get(report.matchId).state === 'done', 'match settled');
    return env.cp.matches.get(report.matchId);
  };
  /** upload() + report(): play it, upload the replay, send the report, wait until settled. */
  env.finish = async (p, { waitDone = true, ...rest } = {}) => {
    const { report, end } = await env.upload(p, rest);
    const entry = await env.report(report, { waitDone });
    return { entry, end };
  };
  return env;
}

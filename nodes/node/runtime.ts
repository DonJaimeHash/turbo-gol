/**
 * NodeRuntime: everything a running node is. The player-facing HTTP server (GET /healthz, the
 * match WebSockets at /m/<matchId>), the WebRTC acceptor, the match rooms, the node-wide ticker,
 * the control-plane agent and, with the 'verify' role, the replay verifier.
 *
 *   wss node   players --wss--> [Caddy :443, TLS] --> http://127.0.0.1:7350 /m/<matchId>
 *   rtc node   players --DataChannel (ICE: host / srflx / TURN)--> this process
 *              (the offer / answer travels over the control connection)
 *   always     node --wss--> control plane /nodes/connect   (outbound only)
 *
 * The node trusts nothing it is told by players beyond what MatchDO trusts, and holds no secret of
 * the project: tickets are checked with the control plane's PUBLIC key (aud = this node), and the
 * node's own private key only proves who the node is.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { WS_SUBPROTOCOL, WS_TICKET_PREFIX } from '../../src/net/protocol';
import { EXIT_UPDATE, compareVersions, reachMessage } from '../shared/controlProtocol';
import type {
  AssignAnswer,
  BuildId,
  HeartbeatData,
  HelloData,
  IceServer,
  LeaveAnswer,
  MatchAssignment,
  NodeCapacity,
  NodeRole,
  NodeSpecs,
  NodeStatus,
  NodeTransport,
  RtcAnswer,
  VerifyJob,
  VerifyVerdict,
} from '../shared/controlProtocol';
import { importPrivateKey, importPublicKey, randomHexId, sign } from '../shared/edcrypto';
import { verifyNodeTicket } from '../shared/nodeTickets';
import { nodeSimFactory } from '../shared/nodeArena';
import { verifyReplay } from '../shared/verify';
import { Agent, AgentError } from './agent';
import type { AgentOptions } from './agent';
import { errorJson, json, startHttp } from './http';
import type { IncomingMessage, RunningServer, ServerResponse } from './http';
import { MAX_FRAME_BYTES, MatchRoom } from './matchRoom';
import type { RoomTimings } from './matchRoom';
import { answerOffer, rtcSelfTest } from './rtcTransport';
import type { RtcConfig, SelfTest } from './rtcTransport';
import { Ticker } from './ticker';
import { acceptUpgrade, clientIp, offeredProtocols, rejectUpgrade } from './wsServer';

/** What `turbogol-node register` writes to <data>/node.json. */
export interface NodeIdentityFile {
  nodeId: string;
  operatorId: string;
  name: string;
  region: string;
  privateKey: string;
  publicKey: string;
  controlPublicKey: string;
  /** ws(s)://.../nodes/connect */
  controlUrl: string;
  /** http(s)://... */
  httpBase: string;
  roles: NodeRole[];
  /** How players reach this node (older node.json files: ['wss']). */
  transports?: NodeTransport[];
  /** ws(s)://host[:port] players use; null without the 'wss' transport. */
  publicUrl: string | null;
}

export interface RuntimeOptions {
  identity: NodeIdentityFile;
  build: BuildId;
  specs: NodeSpecs;
  capacity: NodeCapacity;
  listenPort: number;
  listenHost: string;
  /** Where egress counters live (optional). */
  dataDir?: string;
  egressCapGB?: number | null;
  timings?: Partial<RoomTimings>;
  heartbeatMs?: number;
  /** WebRTC host candidates: port range, extra addresses (tests use 127.0.0.1). */
  rtc?: Omit<RtcConfig, 'iceServers'>;
  log?: (msg: string) => void;
  /** Drained for an update (or asked to stop): the process should exit with this code. */
  onExit?: (code: number) => void;
  /** The WebRTC self-test (default rtcSelfTest; tests inject a fake). */
  selfTest?: (cfg: RtcConfig) => Promise<SelfTest>;
  /**
   * WebRTC self-test schedule (ms): retries while not passing through TURN, doubling from retryMs
   * up to maxRetryMs; re-runs every refreshMs while passing. A scheduled run needs ICE servers
   * younger than iceFreshMs; older ones are renewed by logging in again once the control
   * connection is idle (checked every quietPollMs).
   */
  rtcSchedule?: { retryMs?: number; maxRetryMs?: number; refreshMs?: number; iceFreshMs?: number; quietPollMs?: number };
  /** Agent retry timings (tests). */
  agent?: Omit<AgentOptions, 'heartbeatMs' | 'log'>;
}

const MATCH_PATH = /^\/m\/([0-9A-Za-z_-]{8,64})$/;
const MATCH_ID = /^[0-9A-Za-z_-]{8,64}$/;
/** WebRTC self-test: first retry after a failure (doubles), its cap, and the refresh while passing (TURN credentials expire). */
const RTC_RETRY_MS = 30_000;
const RTC_MAX_RETRY_MS = 10 * 60_000;
const RTC_REFRESH_MS = 30 * 60_000;
/**
 * ICE servers older than this are not used for a scheduled self-test: the control plane's TURN
 * credentials are short-lived (10 min in production) and come only with a welcome or a player's
 * offer, so a test with older ones could fail a healthy node.
 */
const ICE_FRESH_MS = 5 * 60_000;
/** Renewing the ICE servers waits for an idle control connection; it looks again this often. */
const RTC_QUIET_POLL_MS = 30_000;
/** A draining node with an upload or a report still in flight looks again this often. */
const EXIT_POLL_MS = 500;

const setImmediateFn = (globalThis as unknown as { setImmediate: (cb: () => void) => unknown }).setImmediate;
/** Verification slices waiting for their turn. */
const sliceQueue: Array<() => void> = [];
function releaseSlice(): void {
  const next = sliceQueue.shift();
  // Queued from inside an immediate: runs at the NEXT loop turn, after the timers (the ticker).
  if (sliceQueue.length > 0) setImmediateFn(releaseSlice);
  next?.();
}
/**
 * Let the matches tick between verification slices (verifyReplay awaits it every few hundred
 * ticks). One slice per event-loop turn in total: two verifications at once take turns instead of
 * running their slices back to back before the ticker gets a chance.
 */
const yieldToLoop = (): Promise<void> =>
  new Promise((resolve) => {
    sliceQueue.push(resolve);
    if (sliceQueue.length === 1) setImmediateFn(releaseSlice);
  });

/** The list offers a TURN server (a self-test through it can prove players behind any NAT reach this node). */
function hasTurn(servers: readonly IceServer[]): boolean {
  return servers.some((s) => !!s && (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => typeof u === 'string' && /^turns?:/.test(u)));
}

/** Light shape check of a verification job (the control plane is trusted, but a malformed job must not crash or mislead). */
function validJob(j: unknown): j is VerifyJob {
  if (!j || typeof j !== 'object') return false;
  const v = j as Record<string, unknown>;
  return (
    typeof v.matchId === 'string' &&
    MATCH_ID.test(v.matchId) &&
    typeof v.hostNodeId === 'string' &&
    v.hostNodeId.length > 0 &&
    v.hostNodeId.length <= 64 &&
    typeof v.replayUrl === 'string' &&
    /^https?:\/\//.test(v.replayUrl) &&
    typeof v.replaySha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(v.replaySha256) &&
    !!v.expect &&
    typeof v.expect === 'object' &&
    Array.isArray(v.leaves) &&
    v.leaves.length <= 64 &&
    v.leaves.every((p) => typeof p === 'string' && p.length <= 64)
  );
}

export function transportsOf(id: NodeIdentityFile): NodeTransport[] {
  if (!id.roles.includes('host')) return []; // a verifier only dials out
  if (id.transports && id.transports.length > 0) return id.transports;
  return id.publicUrl ? ['wss'] : ['rtc'];
}

export class NodeRuntime {
  readonly opts: RuntimeOptions;
  readonly rooms = new Map<string, MatchRoom>();
  readonly ticker = new Ticker();
  readonly agent: Agent;
  readonly transports: NodeTransport[];
  status: NodeStatus = 'pending';
  draining = false;
  /** An update the control plane asked for (exit EXIT_UPDATE once drained, unless a stop was requested). */
  updateTo: string | null = null;
  /** The operator asked to stop (SIGTERM, the launcher): exit 0 once drained, whatever update comes. */
  stopRequested = false;
  /** Random per process start, the same on every re-hello: a new one tells the control plane this node restarted. */
  readonly bootId = randomHexId(16);
  server: RunningServer | null = null;
  /** ICE servers from the latest welcome or player's offer (STUN, short-lived TURN credentials). */
  iceServers: IceServer[] = [];
  /** performance.now() when iceServers arrived. */
  iceAt = 0;
  rtcReady = false;
  /** The passing self-test went through a TURN relay. */
  rtcRelay = false;
  lastSelfTest: SelfTest | null = null;

  private readonly controlKey: Promise<CryptoKey>;
  private readonly nodeKey: Promise<CryptoKey>;
  private readonly log: (msg: string) => void;
  private egressMonth = '';
  private egressBytes = 0;
  private cpuPrev = process.cpuUsage();
  private cpuPrevAt = performance.now();
  private verifying = 0;
  private exited = false;
  private stopped = false;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;
  private selfTesting = false;
  /** A welcome (new ICE servers) arrived during a self-test: run again right after it. */
  private selfTestAgain = false;
  private rtcTimer: ReturnType<typeof setTimeout> | null = null;
  private rtcFailures = 0;

  constructor(opts: RuntimeOptions) {
    this.opts = opts;
    this.transports = transportsOf(opts.identity);
    this.log = opts.log ?? ((m) => console.log(`[node] ${m}`));
    this.controlKey = importPublicKey(opts.identity.controlPublicKey);
    this.nodeKey = importPrivateKey(opts.identity.privateKey);
    const id = opts.identity;
    this.agent = new Agent(
      { nodeId: id.nodeId, privateKey: id.privateKey, controlUrl: id.controlUrl, httpBase: id.httpBase },
      {
        hello: () => this.hello(),
        heartbeat: () => this.heartbeat(),
        assign: (m) => this.assign(m),
        leave: (matchId, playerId) => this.leave(matchId, playerId),
        verify: (job) => this.verify(job),
        rtcOffer: (o) => this.rtcOffer(o.matchId, o.ticket, o.sdp, o.iceServers),
        drain: (reason) => this.drain(reason),
        update: (version) => this.update(version),
        status: (s, reason) => {
          this.status = s;
          this.log(`status ${s}${reason ? ` (${reason})` : ''}`);
        },
        welcome: (w) => {
          this.status = w.status;
          this.iceServers = w.iceServers;
          this.iceAt = performance.now();
          this.log(`connected to the control plane: ${w.status}, region ${w.region}, stable ${w.channel.stable}`);
          if (compareVersions(this.opts.build.version, w.channel.minimum) < 0) this.update(w.channel.stable);
          // Fresh TURN credentials: test with them now (or right after the test in progress).
          if (this.transports.includes('rtc')) void this.selfTest();
        },
      },
      { ...(opts.agent ?? {}), heartbeatMs: opts.heartbeatMs, log: (m) => this.log(m) },
    );
  }

  async start(): Promise<void> {
    await this.loadEgress();
    if (this.transports.includes('wss')) {
      this.server = await startHttp(this.opts.listenPort, this.opts.listenHost, {
        onRequest: (req, res) => this.onRequest(req, res),
        onUpgrade: (req, socket, head) => this.onUpgrade(req, socket, head),
      });
      this.log(`listening on ${this.opts.listenHost}:${this.server.port}`);
    } else {
      this.log('WebRTC node: no listening port (players connect through ICE)');
    }
    this.agent.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.rtcTimer) clearTimeout(this.rtcTimer);
    if (this.exitTimer) clearTimeout(this.exitTimer);
    this.rtcTimer = null;
    this.exitTimer = null;
    for (const r of [...this.rooms.values()]) r.dispose('node_shutdown');
    await this.agent.stop();
    if (this.server) await this.server.close();
    this.server = null;
  }

  get port(): number {
    return this.server?.port ?? 0;
  }

  /**
   * Run the WebRTC reachability self-test with the latest ICE servers. Called at every welcome
   * (fresh TURN credentials) and by its own schedule: until a test passes through TURN (what the
   * control plane requires when it hands out TURN), retries with backoff (30 s, 60 s, 120 s... up
   * to 10 min); once it does, again every 30 min. A call during a test (a new welcome) runs once
   * more right after it; it then returns null.
   */
  async selfTest(): Promise<SelfTest | null> {
    if (this.selfTesting) {
      this.selfTestAgain = true;
      return null;
    }
    if (this.stopped) return null;
    if (this.rtcTimer) clearTimeout(this.rtcTimer);
    this.rtcTimer = null;
    this.selfTesting = true;
    let r: SelfTest;
    try {
      const run = this.opts.selfTest ?? rtcSelfTest;
      r = await run({ iceServers: this.iceServers, ...(this.opts.rtc ?? {}) });
    } catch (e) {
      r = { ok: false, relay: false, ms: 0, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.selfTesting = false;
    }
    if (this.stopped) return r;
    this.lastSelfTest = r;
    const was = { ready: this.rtcReady, relay: this.rtcRelay };
    this.rtcReady = r.ok;
    this.rtcRelay = r.ok && r.relay;
    this.log(r.ok ? `WebRTC self-test ok in ${r.ms} ms${r.relay ? ' (through TURN)' : ' (no TURN relay)'}` : `WebRTC self-test FAILED: ${r.error ?? 'no channel'}`);
    if (was.ready !== this.rtcReady || was.relay !== this.rtcRelay) this.agent.rehello();
    if (this.selfTestAgain) {
      // A welcome came during the test: its ICE servers have not been tried yet.
      this.selfTestAgain = false;
      void this.selfTest();
      return r;
    }
    this.scheduleSelfTest(this.rtcRelay);
    return r;
  }

  private scheduleSelfTest(passed: boolean): void {
    const s = this.opts.rtcSchedule ?? {};
    let wait: number;
    if (passed) {
      this.rtcFailures = 0;
      wait = s.refreshMs ?? RTC_REFRESH_MS;
    } else {
      const first = s.retryMs ?? RTC_RETRY_MS;
      wait = Math.min(first * 2 ** Math.min(this.rtcFailures, 20), s.maxRetryMs ?? RTC_MAX_RETRY_MS);
      this.rtcFailures++;
    }
    if (this.rtcTimer) clearTimeout(this.rtcTimer);
    this.rtcTimer = setTimeout(() => this.scheduledSelfTest(), wait);
  }

  /**
   * A retry or a refresh. It runs only with ICE servers fresh enough to judge the node by: TURN
   * credentials expire, and a test with expired ones would fail a healthy node (rtcReady false:
   * no more rtc matches). Older ones, or a list without TURN (the control plane could not mint
   * credentials), are renewed by logging in again, which the control plane answers with a welcome
   * carrying new ones (its handler runs the test); but only while nothing depends on the control
   * connection (no match, verification, request or report in flight), else it looks again later.
   */
  private scheduledSelfTest(): void {
    this.rtcTimer = null;
    // Draining: no new matches, nothing to prove. Offline: the next welcome runs it.
    if (this.stopped || this.draining || this.selfTesting || !this.agent.connected) return;
    const s = this.opts.rtcSchedule ?? {};
    const fresh = performance.now() - this.iceAt < (s.iceFreshMs ?? ICE_FRESH_MS) && hasTurn(this.iceServers);
    if (fresh) {
      void this.selfTest();
      return;
    }
    if (this.rooms.size === 0 && this.verifying === 0 && this.agent.idle) {
      this.log('logging in again for fresh ICE servers (WebRTC self-test)');
      this.agent.reconnect();
      return;
    }
    this.rtcTimer = setTimeout(() => this.scheduledSelfTest(), s.quietPollMs ?? RTC_QUIET_POLL_MS);
  }

  // ---- HTTP (wss transport) ------------------------------------------------------------------

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://node');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const body: Record<string, unknown> = {
        ok: true,
        nodeId: this.opts.identity.nodeId,
        version: this.opts.build.version,
        active: this.rooms.size,
        capacity: this.opts.capacity.matches,
        draining: this.draining,
      };
      const nonce = url.searchParams.get('nonce');
      if (nonce && /^[A-Za-z0-9_-]{16,64}$/.test(nonce)) body.sig = await sign(await this.nodeKey, reachMessage(this.opts.identity.nodeId, nonce));
      return json(res, 200, body);
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Turbogol community node ${this.opts.identity.name} (${this.opts.build.version})\n`);
      return;
    }
    errorJson(res, 404, 'not_found');
  }

  private async onUpgrade(req: IncomingMessage, socket: Socket, head: Uint8Array): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://node');
    const m = MATCH_PATH.exec(url.pathname);
    if (!m) return rejectUpgrade(socket, 404, 'not_found');
    const matchId = m[1];
    const room = this.rooms.get(matchId);
    if (!room) return rejectUpgrade(socket, 404, 'no_match');
    const offered = offeredProtocols(req);
    if (!offered.includes(WS_SUBPROTOCOL)) return rejectUpgrade(socket, 400, 'bad_protocol');
    const t = offered.find((p) => p.startsWith(WS_TICKET_PREFIX));
    if (!t) return rejectUpgrade(socket, 401, 'no_ticket');
    // Tickets expire on the control plane's clock (90 s), not this machine's.
    const claims = await verifyNodeTicket(await this.controlKey, t.slice(WS_TICKET_PREFIX.length), matchId, this.opts.identity.nodeId, this.agent.serverNow());
    if (!claims) return rejectUpgrade(socket, 403, 'bad_ticket');
    if (socket.destroyed) return;
    // From here to attach() everything is synchronous: no other upgrade can interleave.
    const pre = room.precheck(claims);
    if (!pre.ok) return rejectUpgrade(socket, pre.status, pre.code, pre.message);
    const ws = acceptUpgrade(req, socket, head, { protocol: WS_SUBPROTOCOL, maxMessageBytes: MAX_FRAME_BYTES, remoteAddress: clientIp(req) });
    if (!ws) return;
    room.attach(ws, claims);
  }

  // ---- WebRTC (rtc transport) ----------------------------------------------------------------

  /** A player's offer, relayed by the control plane: the same checks as a WebSocket upgrade. */
  private async rtcOffer(matchId: string, ticket: string, sdp: string, iceServers: IceServer[]): Promise<RtcAnswer> {
    if (!this.transports.includes('rtc')) throw new AgentError('no_rtc');
    if (iceServers.length > 0) {
      // Minted for this node just now: the next scheduled self-test can use them.
      this.iceServers = iceServers;
      this.iceAt = performance.now();
    }
    const room = this.rooms.get(matchId);
    if (!room) throw new AgentError('no_match');
    // Tickets expire on the control plane's clock (90 s), not this machine's.
    const claims = await verifyNodeTicket(await this.controlKey, ticket, matchId, this.opts.identity.nodeId, this.agent.serverNow());
    if (!claims) throw new AgentError('bad_ticket');
    const pre = room.reserve(claims);
    if (!pre.ok) throw new AgentError(pre.code, pre.message);
    const cfg: RtcConfig = { iceServers: iceServers.length > 0 ? iceServers : this.iceServers, ...(this.opts.rtc ?? {}) };
    try {
      const answer = await answerOffer(
        sdp,
        cfg,
        WS_SUBPROTOCOL,
        (conn) => {
          // The seat may have changed while ICE ran (left, match over, a newer socket).
          const again = room.precheck(claims, { reserved: true });
          if (!again.ok) {
            room.unreserve(claims.jti);
            conn.close(1008, again.code);
            return;
          }
          room.attach(conn, claims);
        },
        () => room.unreserve(claims.jti),
      );
      return { sdp: answer };
    } catch (e) {
      room.unreserve(claims.jti);
      throw new AgentError('bad_offer', e instanceof Error ? e.message : String(e));
    }
  }

  // ---- agent handlers ---------------------------------------------------------------------

  private hello(): HelloData {
    return {
      bootId: this.bootId,
      build: this.opts.build,
      roles: this.opts.identity.roles,
      transports: this.transports,
      publicUrl: this.opts.identity.publicUrl,
      rtcReady: this.rtcReady,
      rtcRelay: this.rtcRelay,
      specs: this.opts.specs,
      capacity: this.opts.capacity,
      draining: this.draining,
      egressCapGB: this.opts.egressCapGB ?? null,
    };
  }

  heartbeat(): HeartbeatData {
    const now = performance.now();
    const cpu = process.cpuUsage(this.cpuPrev);
    const wall = Math.max(1, now - this.cpuPrevAt);
    this.cpuPrev = process.cpuUsage();
    this.cpuPrevAt = now;
    const lag = this.ticker.lag.quantile(0.99);
    this.ticker.lag.reset();
    return {
      active: this.rooms.size,
      capacity: this.opts.capacity.matches,
      draining: this.draining,
      egressGB: this.egressGB(),
      egressCapGB: this.opts.egressCapGB ?? null,
      tickLagP99Ms: lag,
      cpuLoad: (cpu.user + cpu.system) / 1000 / wall,
      rssMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      matches: [...this.rooms.values()].map((r) => r.status()),
    };
  }

  private async assign(match: MatchAssignment): Promise<AssignAnswer> {
    const publicUrl = this.opts.identity.publicUrl;
    if (!this.opts.identity.roles.includes('host')) throw new AgentError('not_a_host');
    const wsUrl = this.transports.includes('wss') && publicUrl ? `${publicUrl}/m/${match.matchId}` : null;
    if (wsUrl === null && !this.transports.includes('rtc')) throw new AgentError('no_transport');
    if (this.rooms.has(match.matchId)) return { wsUrl }; // a retried assign
    if (this.draining) throw new AgentError('draining');
    if (this.status === 'suspended' || this.status === 'banned' || this.status === 'pending') throw new AgentError('not_eligible', this.status);
    if (this.rooms.size >= this.opts.capacity.matches) throw new AgentError('full');
    const cap = this.opts.egressCapGB;
    if (cap !== null && cap !== undefined && this.egressGB() >= cap) throw new AgentError('egress_cap');
    if (!/^[0-9A-Za-z_-]{8,64}$/.test(match.matchId) || !Array.isArray(match.roster) || match.roster.length < 1 || match.roster.length > 8) {
      throw new AgentError('bad_assignment');
    }
    const room = await MatchRoom.create(match, {
      nodeId: this.opts.identity.nodeId,
      label: 'node:' + this.opts.identity.name,
      build: this.opts.build,
      ticker: this.ticker,
      timings: this.opts.timings,
      // The control plane's clock (createdAt and the TTL are on it), not this machine's.
      serverNow: () => this.agent.serverNow(),
      hooks: {
        onEnded: (r, result, replay, stats) => {
          this.addEgress(stats.egressBytes);
          void this.agent.submitEnded(r.matchId, result, replay, stats);
        },
        onCancelled: (r, reason, noShows) => this.agent.submit({ kind: 'cancelled', matchId: r.matchId, reason, noShows }),
        onLost: (r, reason) => this.agent.submit({ kind: 'lost', matchId: r.matchId, reason }),
        onClosed: (r) => {
          this.rooms.delete(r.matchId);
          this.agent.pulse();
          this.maybeExit();
        },
      },
    });
    this.rooms.set(match.matchId, room);
    this.agent.pulse();
    return { wsUrl };
  }

  private async leave(matchId: string, playerId: string): Promise<LeaveAnswer> {
    const room = this.rooms.get(matchId);
    if (!room) throw new AgentError('no_match');
    const a = room.leave(playerId);
    if ('error' in a) throw new AgentError(a.code);
    return a;
  }

  private async verify(job: VerifyJob): Promise<VerifyVerdict> {
    if (!this.opts.identity.roles.includes('verify')) throw new AgentError('not_a_verifier');
    if (!validJob(job)) throw new AgentError('bad_job');
    if (this.verifying >= 2) throw new AgentError('busy');
    // Draining: no new jobs (the control plane retries them elsewhere or after the restart).
    if (this.draining) throw new AgentError('draining');
    this.verifying++;
    try {
      const bytes = await this.agent.fetchReplay(job);
      // Its set-up (up to the first slice) takes a loop turn of its own too.
      await yieldToLoop();
      return await verifyReplay(bytes, {
        makeSim: nodeSimFactory,
        wasmSha256: this.opts.build.wasmSha256,
        protocol: this.opts.build.protocol,
        // The match's JavaScript (rules, bots, arena mesh) ships in the node release: same release only.
        version: this.opts.build.version,
        expect: job.expect,
        expectNodeId: job.hostNodeId,
        // Only the leaves the control plane relayed may appear as takeovers.
        leaves: job.leaves,
        // A host + verify node keeps ticking its matches while it re-simulates.
        yieldFn: yieldToLoop,
      });
    } finally {
      this.verifying--;
      this.maybeExit(); // a draining verifier exits once its last verification is answered
    }
  }

  private drain(reason: string): void {
    if (!this.draining) this.log(`draining: ${reason}`);
    this.draining = true;
    this.agent.pulse();
    this.maybeExit();
  }

  private update(version: string): void {
    if (this.updateTo === version) return;
    this.updateTo = version;
    if (this.stopRequested) {
      this.log(`update to ${version} available, but a stop was requested: the node stops (no restart)`);
      return;
    }
    this.log(`update to ${version} requested: draining (${this.rooms.size} matches running)`);
    this.drain('update');
  }

  /** Graceful stop (SIGTERM, the launcher): drain, exit 0 when the last match is over and reported. An update never overrides it. */
  requestStop(): void {
    if (!this.stopRequested) this.log(`stop requested: draining (${this.rooms.size} matches running)`);
    this.stopRequested = true;
    this.drain('stop');
  }

  private maybeExit(): void {
    if (this.exited || this.stopped || (!this.stopRequested && this.updateTo === null)) return;
    if (this.rooms.size > 0) return; // the last room's onClosed calls again
    if (this.agent.backlog > 0 || this.verifying > 0) {
      // A replay upload in flight, a report not acknowledged yet or a verification still running:
      // exiting now would lose it.
      if (!this.exitTimer) {
        this.exitTimer = setTimeout(() => {
          this.exitTimer = null;
          this.maybeExit();
        }, EXIT_POLL_MS);
      }
      return;
    }
    this.exited = true;
    const code = this.stopRequested ? 0 : EXIT_UPDATE;
    this.log(code === 0 ? 'drained: stopping' : `drained: exiting for the update to ${this.updateTo}`);
    this.opts.onExit?.(code);
  }

  // ---- egress -----------------------------------------------------------------------------

  private monthKey(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private egressGB(): number {
    if (this.egressMonth !== this.monthKey()) {
      this.egressMonth = this.monthKey();
      this.egressBytes = 0;
    }
    return this.egressBytes / 1e9;
  }

  private addEgress(bytes: number): void {
    this.egressGB();
    this.egressBytes += bytes;
    if (this.opts.dataDir) {
      void writeFile(join(this.opts.dataDir, 'egress.json'), JSON.stringify({ month: this.egressMonth, bytes: this.egressBytes })).catch(() => undefined);
    }
  }

  private async loadEgress(): Promise<void> {
    this.egressMonth = this.monthKey();
    if (!this.opts.dataDir) return;
    await mkdir(this.opts.dataDir, { recursive: true });
    try {
      const e = JSON.parse(await readFile(join(this.opts.dataDir, 'egress.json'), 'utf8')) as { month?: string; bytes?: number };
      if (e.month === this.egressMonth && typeof e.bytes === 'number') this.egressBytes = e.bytes;
    } catch {
      /* first run */
    }
  }
}

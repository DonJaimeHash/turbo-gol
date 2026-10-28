/**
 * NodeRegistryDO: the community nodes' control plane (nodes/control-plane: Registry and
 * ControlPlane) inside the Worker. One object, 'nodes-v1' near São Paulo (nodeApi.ts), reached
 * only through the Worker (internal header): the /nodes/* routes of nodeRoutes.ts and the
 * matchmaker's internal routes.
 *
 *   POST /nodes/register         RegisterRequest (at most 4 KB read), x-client-ip -> RegisterAnswer (403 <code> when
 *                                refused); 5 per address per hour, an IPv6 address counted by its /64
 *   GET  /nodes/connect          WebSocket upgrade: a node's control link (Hibernation API)
 *   PUT  /nodes/replays/<id>     the hosting node's replay upload, signed (x-node-id / -ts / -sig, x-replay-sha256): the
 *                                signature is checked before the body (up to 16 MiB) is read
 *   GET  /nodes/replays/<id>     the replay, for the verifier node its job went to (signed the same way)
 *   GET  /nodes/status           the public list of nodes
 *   POST /nodes/tokens           { region, name? } with x-operator-id / x-operator-name (an account the Worker found in
 *                                NODE_TRUSTED_OPERATORS; checked again here) -> a one-time token and its install line;
 *                                10 per account per day
 *   GET  /nodes/mine             x-operator-id -> that operator's nodes and its rewards (Ledger.summary)
 *   GET  /nodes/admin/nodes      the maintainers' routes, x-operator-id / x-operator-name as for tokens (checked
 *   POST /nodes/admin/status     again here): every node in full; { nodeId, status, reason } (ControlPlane.setStatus);
 *   POST /nodes/admin/drain      { nodeId, reason } (one-way: the node comes back with a restart on its machine);
 *   POST /nodes/admin/update     channel.json read again and every node below its minimum told to update;
 *   POST /nodes/admin/reprobe    { nodeId }: its /healthz checked now;
 *   POST /nodes/admin/grant      { account, item }, /revoke { account, item }, /unfreeze { account }: an account's
 *                                items and wallet, passed on to AccountsDO (/host-grant, -revoke, -unfreeze). Each
 *                                call is an ALERT line naming who made it
 *   POST /internal/place | /internal/rejoin | /internal/leave, GET /internal/status: the matchmaker's (nodeApi.ts)
 *   POST /internal/health        the cron's (index.ts scheduled, every 5 minutes): /healthz of every trusted wss
 *                                node online, or in service and seen by the object in the last hour, 5 s each
 *                                (nodeWatch.ts healthzTargets)
 *
 * State (nodeStore.ts, SQLite): the tokens, nodes and matches the control plane writes through,
 * and the outbox of settled matches, written in the transaction that settles each one and
 * delivered to AccountsDO and the matchmakers by the alarm (nodeOutcome.ts). The rewards ledger
 * too: a scored match's entry and its operator's totals in that same transaction (with the
 * outbox's /host-credit to the operator's account, and /host-freeze after a failed verification),
 * its repeat notes as they come; Ledger.restore reads them back at every start. Only community
 * nodes earn: a project node's matches have no entry (ControlPlane.applyVerdict).
 *
 * A start without sockets is cold (a deploy drops every socket): the control plane gives its nodes
 * the restart grace before it voids anything for silence. A wake after a hibernation keeps the
 * sockets: each is adopted from the { nodeId } attachment it got when it logged in, with no new
 * challenge, unless the attachment says its node had gone quiet (no heartbeat for 15 s): that one
 * is closed (4408), and a live node logs in again. The alarm runs every 5 s while there is a
 * socket, an unfinished match, an outbox row or a grace: the sweep is the only thing that voids a
 * dead node's matches, so it must run with no node connected too. It also starts the outbox's
 * delivery, without waiting for it (each delivery times out, and a stuck target holds back only
 * its own rows), and reads channel.json from R2 again every minute.
 *
 * The control key: NODE_CONTROL_PUBLIC_KEY (var) must be the public half of
 * NODE_CONTROL_PRIVATE_KEY (secret), or the nodes would refuse every ticket. When they differ the
 * object raises an ALERT and places nothing, registers nothing and mints no rejoin ticket; nodes
 * already registered keep reporting. A caller is only told the control plane is unavailable, as
 * when its state cannot be read: the cause is for the ALERT lines.
 *
 * ALERT lines, the object's and those of the control plane and the registry it runs, also go to
 * the team's Discord channel when NODE_ALERT_WEBHOOK is set (nodeAlerts.ts: each alert at most once
 * in 10 minutes; an account's action, a maintainer's call or the registry's token and trusted node
 * lines, every time). The alarm also watches the nodes for what nodeWatch.ts lists (a trusted node
 * offline, traffic near its cap, tick lag, a verification or an update waiting too long), and it
 * keeps running while a trusted node in service is offline until its ALERT goes out, so that one
 * is noticed with nothing else going on. Which nodes got theirs is kept in meta: a restart does
 * not raise them again, and the object can sleep while such a node stays away.
 */
import { DurableObject } from 'cloudflare:workers';
import { ControlPlane, NodeRefused } from '../../nodes/control-plane/controlPlane';
import type { NodeLink, PlaceRequest, Session } from '../../nodes/control-plane/controlPlane';
import { Ledger } from '../../nodes/control-plane/ledger';
import { Registry, TOKEN_TTL_MS } from '../../nodes/control-plane/registry';
import type { NodeRecord, RegistryOptions } from '../../nodes/control-plane/registry';
import { compareVersions } from '../../nodes/shared/controlProtocol';
import type { HeartbeatData, NodeStatus, RegisterAnswer, RegisterRequest, ReleaseChannel } from '../../nodes/shared/controlProtocol';
import { importPrivateKey, sign, verifyWith } from '../../nodes/shared/edcrypto';
import { REGIONS, isRegion } from '../../src/net/account';
import { seatCar } from '../../src/net/cosmetics';
import { CATALOG, catalogItem } from '../../nodes/control-plane/shop';
import { accountsCall } from './accountRoutes';
import { checkInternal } from './auth';
import { carriesPhysics, error, isHex, isMode, json, limitKey, nodesConfigured, readCapped, readJson, sanitizeName, trustedOperatorIds, withTimeout } from './env';
import type { Env, NodesEnv } from './env';
import { AlertHook } from './nodeAlerts';
import type { FetchFn } from './nodeAlerts';
import { CLIENT_BUILD, LEAVE_STATUS, NODE_ROUTES, REJOIN_STATUS } from './nodeApi';
import type { LeaveAnswer, LeaveRefusal, PlaceAnswer, RejoinTicket, StatusAnswer } from './nodeApi';
import { DELIVERY_TIMEOUT_MS, deliverCall } from './nodeOutcome';
import { NodeStore } from './nodeStore';
import { HEALTHZ_TIMEOUT_MS, NodeWatch, channelOf, healthzTargets, label, probeHealthz } from './nodeWatch';
import type { WatchNote } from './nodeWatch';

/** The alarm's period while anything needs it. */
export const TICK_MS = 5_000;
/** channel.json is read from R2 again this often. */
export const CHANNEL_REFRESH_MS = 60_000;
export const CHANNEL_KEY = 'channel.json';
/** A node's control frames are small JSON: anything bigger closes the socket (the reference server's cap). */
export const MAX_FRAME_CHARS = 256 * 1024;
export const REPLAY_MAX_BYTES = 16 * 1024 * 1024;
export const REGISTER_PER_IP_PER_HOUR = 5;
export const TOKENS_PER_ACCOUNT_PER_DAY = 10;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const OUTBOX_BATCH = 50;
/** A failed delivery is tried again after 2^attempts seconds, at most this long. */
const OUTBOX_MAX_BACKOFF_MS = 5 * 60_000;
/** The rate limits keep at most this many windows: past it the oldest one goes. */
export const LIMIT_KEYS_MAX = 10_000;
/** Expired windows are swept once every this many calls, not at each one. */
const LIMIT_PURGE_EVERY = 256;
/**
 * What any caller hears while the control plane cannot serve, whatever the cause: the cause is in
 * the ALERT lines, and an anonymous caller learns nothing it could time an attack against.
 */
const UNAVAILABLE = 'the node control plane is not available right now: try again later';
const REPLAY_ROUTE = /^\/nodes\/replays\/([0-9a-f]{64})$/;
const DIFFICULTIES = ['easy', 'medium', 'hard'];
/** What a maintainer may set (pending is the control plane's: a node not proven reachable yet). */
const ADMIN_STATUSES: readonly NodeStatus[] = ['probation', 'active', 'suspended', 'banned'];
/** A maintainer's reason (a status change, a drain) is kept to this many characters. */
const REASON_MAX = 200;
/** The meta row of drainAsked. */
const DRAINS_KEY = 'drains_asked';
/** The meta row of the nodes whose offline ALERT went out (NodeWatch.offlineAlerted). */
const OFFLINE_KEY = 'offline_alerted';

/** NODE_CONTROL_PUBLIC_KEY is the public half of NODE_CONTROL_PRIVATE_KEY: what one signs, the other verifies. */
export async function controlKeysMatch(privateKey: string, publicKey: string): Promise<boolean> {
  const probe = 'turbogol-control-key-check';
  try {
    return await verifyWith(publicKey, probe, await sign(await importPrivateKey(privateKey), probe));
  } catch {
    return false;
  }
}

/** The node a socket logged in as before the object slept, and whether it was quiet then (its attachment), or null. */
function attachedNode(ws: WebSocket): { nodeId: string; quiet: boolean } | null {
  try {
    const a: unknown = ws.deserializeAttachment();
    const { nodeId, quiet } = (typeof a === 'object' && a !== null ? a : {}) as { nodeId?: unknown; quiet?: unknown };
    return typeof nodeId === 'string' ? { nodeId, quiet: quiet === true } : null;
  } catch {
    return null;
  }
}

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 3 && v.every((x) => isStr(x, 64));

/**
 * POST /internal/place as the matchmaker builds it, or null (400). ControlPlane.place checks the
 * teams against the humans. Exported for the tests (server/test/experimental-lobby.test.mjs).
 */
export function parsePlace(v: unknown): PlaceRequest | null {
  if (typeof v !== 'object' || v === null) return null;
  // A community node runs the standard physics only: a placement with experimental rules is refused.
  if (carriesPhysics(v)) return null;
  const b = v as Record<string, unknown>;
  if (!isMode(b.mode) || !isRegion(b.region) || typeof b.ranked !== 'boolean' || !isNum(b.matchLengthSeconds)) return null;
  if (!Array.isArray(b.humans) || b.humans.length < 1 || b.humans.length > 6) return null;
  const humans: PlaceRequest['humans'] = [];
  for (const h of b.humans as unknown[]) {
    const x = (typeof h === 'object' && h !== null ? h : {}) as Record<string, unknown>;
    if (!isStr(x.playerId, 64) || !isStr(x.name, 32)) return null;
    // The car stays with the match (MatchEntry.humans: the rejoin's `cars`); one the catalog does not know is dropped.
    const car = seatCar(x.car);
    humans.push({ playerId: x.playerId, name: x.name, ...(x.account === true ? { account: true } : {}), ...(isNum(x.accountAgeDays) ? { accountAgeDays: x.accountAgeDays } : {}), ...(car !== undefined ? { car } : {}) });
  }
  const out: PlaceRequest = { mode: b.mode, region: b.region, ranked: b.ranked, matchLengthSeconds: b.matchLengthSeconds, humans };
  if (b.teams !== undefined) {
    const t = b.teams as { blue?: unknown; red?: unknown } | null;
    if (!t || !isIdList(t.blue) || !isIdList(t.red)) return null;
    out.teams = { blue: t.blue, red: t.red };
  }
  if (b.transports !== undefined) {
    if (!Array.isArray(b.transports) || !b.transports.every((x) => x === 'wss' || x === 'rtc')) return null;
    out.transports = b.transports as PlaceRequest['transports'];
  }
  if (b.botDifficulty !== undefined) {
    if (!DIFFICULTIES.includes(b.botDifficulty as string)) return null;
    out.botDifficulty = b.botDifficulty as PlaceRequest['botDifficulty'];
  }
  for (const k of ['kickoffCountdownSeconds', 'goalPauseSeconds', 'joinTimeoutMs'] as const) {
    const n = b[k];
    if (n === undefined) continue;
    if (!isNum(n)) return null;
    out[k] = n;
  }
  return out;
}

/** A maintainer's reason: one line, no control characters, at most REASON_MAX characters; null when there is none. */
function reasonOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, REASON_MAX);
  return s.length > 0 ? s : null;
}

/** The Registry, handing each heartbeat to the object once it took it (NodeWatch counts the tick lag per heartbeat). */
class WatchedRegistry extends Registry {
  private readonly onBeat: (n: NodeRecord) => void;

  constructor(opts: RegistryOptions, onBeat: (n: NodeRecord) => void) {
    super(opts);
    this.onBeat = onBeat;
  }

  override heartbeat(id: string, hb: HeartbeatData, now: number): void {
    super.heartbeat(id, hb, now);
    const n = this.node(id);
    if (n) this.onBeat(n);
  }
}

export class NodeRegistryDO extends DurableObject<Env> {
  /** The start (blockConcurrencyWhile): every handler waits for it. */
  private readonly ready: Promise<void>;
  /** The env when every node setting is there (nodesConfigured), else null and the object serves nothing. */
  private readonly cfg: NodesEnv | null;
  private store: NodeStore | null = null;
  private cp: ControlPlane | null = null;
  /**
   * How long the object waits for another object or for R2: an outbox delivery or a read of
   * channel.json that takes longer is given up and tried again later (tests shorten it).
   */
  timeoutMs = DELIVERY_TIMEOUT_MS;
  /** How long the cron's probe of a node's /healthz waits (tests shorten it). */
  healthzTimeoutMs = HEALTHZ_TIMEOUT_MS;
  /** What the object fetches the ALERT webhook and the nodes' /healthz with (tests hand in a fake). */
  fetchFn: FetchFn = (url, init) => fetch(url, init);
  /** How an ALERT post waits for its turn on the webhook (nodeAlerts.ts; tests hand in one that does not wait). */
  alertSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  /** The control key pair matches (controlKeysMatch): tickets the nodes can check. */
  private keyOk = false;
  /** channel.json as last read (parsed; its text when it is not JSON; null when missing), its text and when it was read. */
  private channel: unknown = null;
  private channelText: string | null = null;
  private channelAt = 0;
  /** The last channel.json that read as a channel: the minimum the watch holds the nodes to. */
  private goodChannel: { stable: string; minimum: string } | null = null;
  private readonly alerts: AlertHook;
  /** Replaced at the start by one that knows the offline ALERTs already out (meta). */
  private watch = new NodeWatch();
  /** The offline_alerted row as last written (or read at the start). */
  private offlineRow = '[]';
  /** When this object started: a node it has not seen counts as offline from then. */
  private startedAt = 0;
  /**
   * Nodes the control plane told to drain or update, with the process (bootId) it told: its drain
   * is expected. Kept in meta: a node drained by hand stays drained through a deploy.
   */
  private drainAsked = new Map<string, string | null>();
  private readonly sessions = new WeakMap<WebSocket, Session>();
  /** Sockets whose { nodeId } attachment is stored. */
  private readonly attached = new WeakSet<WebSocket>();
  /** Registrations per address and tokens per account, in fixed windows (the object is one for every node: they hold globally). */
  private readonly limits = new Map<string, { n: number; resetAt: number }>();
  private limitCalls = 0;
  private draining: Promise<void> | null = null;
  private drainAgain = false;
  /** Outbox rows already reported as a day old (once per row and process). */
  private readonly lateRows = new Set<number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.cfg = nodesConfigured(env) ? env : null;
    this.alerts = new AlertHook({
      url: env.NODE_ALERT_WEBHOOK,
      waitUntil: (p) => ctx.waitUntil(p),
      fetch: (url, init) => this.fetchFn(url, init),
      sleep: (ms) => this.alertSleep(ms),
      log: (m) => console.log(`[nodes] ${m}`),
    });
    this.ready = ctx.blockConcurrencyWhile(() => this.start());
  }

  /** A line of the object's log. One that starts with ALERT also goes to the team's channel, as `key` (nodeAlerts.ts). */
  private log(msg: string, key?: string): void {
    console.log(`[nodes] ${msg}`);
    if (msg.startsWith('ALERT')) this.alerts.post(msg, key);
  }

  /**
   * A line about what an account did (a maintainer's call, a token, a trusted node registered). One
   * that starts with ALERT goes to the team's channel every time (AlertHook.audit): the same call
   * twice, or a harmful one after a few harmless ones, is never left out of it.
   */
  private audit(msg: string): void {
    console.log(`[nodes] ${msg}`);
    if (msg.startsWith('ALERT')) this.alerts.audit(msg);
  }

  private note(notes: Iterable<WatchNote>): void {
    for (const n of notes) this.log(n.line, n.key);
  }

  private async start(): Promise<void> {
    const env = this.cfg;
    if (!env) return;
    this.startedAt = Date.now();
    const store = new NodeStore(
      this.ctx.storage.sql,
      (fn) => this.ctx.storage.transactionSync(fn),
      () => this.kickOutbox(),
      () => Date.now(),
    );
    const log = (m: string) => this.log(m);
    this.keyOk = await controlKeysMatch(env.NODE_CONTROL_PRIVATE_KEY, env.NODE_CONTROL_PUBLIC_KEY);
    if (!this.keyOk) this.log('ALERT NODE_CONTROL_PUBLIC_KEY is not the public half of NODE_CONTROL_PRIVATE_KEY: no placement, registration or rejoin until they match');
    await this.refreshChannel();
    const base = env.NODES_PUBLIC_BASE.replace(/\/+$/, '');
    try {
      store.migrate();
      const rows = store.load(Date.now());
      this.drainAsked = drainsOf(store.meta(DRAINS_KEY));
      this.offlineRow = store.meta(OFFLINE_KEY) ?? '[]';
      this.watch = new NodeWatch(idsOf(this.offlineRow));
      // Each of the registry's ALERTs is an account's action: a token or a node of a trusted operator.
      const audit = (m: string) => this.audit(m);
      const registry = new WatchedRegistry({ allowInsecure: false, trustedOperators: [...trustedOperatorIds(env)], regions: REGIONS.map((r) => r.id), store, log: audit }, (n) => {
        const note = this.watch.beat(n);
        if (note) this.note([note]);
      });
      registry.restore(rows);
      // The rewards ledger as the store kept it: the repeat decay, the leaderboard and the summaries go on after a deploy.
      const ledger = new Ledger({ onNote: (n) => store.ledgerNote(n) });
      ledger.restore(store.ledgerSnapshot(Date.now()), Date.now());
      const cp = new ControlPlane({
        controlPrivateKey: env.NODE_CONTROL_PRIVATE_KEY,
        controlPublicKey: env.NODE_CONTROL_PUBLIC_KEY,
        controlUrl: base.replace(/^http/, 'ws') + '/nodes/connect',
        httpBase: base,
        build: () => CLIENT_BUILD,
        // Whatever R2 holds: the control plane checks it at every use and keeps the last good one.
        channel: () => this.channel as ReleaseChannel,
        registry,
        ledger,
        replays: {
          put: async (id, bytes) => {
            await env.NODE_REPLAYS.put(id, bytes);
          },
          get: async (id) => {
            const o = await env.NODE_REPLAYS.get(id);
            return o ? new Uint8Array(await o.arrayBuffer()) : null;
          },
        },
        // Its reachability probes, through the object's fetch like the cron's.
        fetchJson: async (u) => (await this.fetchFn(u, { signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS) })).json(),
        store,
        now: () => Date.now(),
        log,
      });
      // A deploy drops every socket; a hibernation keeps them (they are adopted below).
      const sockets = this.ctx.getWebSockets();
      cp.restore(rows.matches, { cold: sockets.length === 0 });
      this.store = store;
      this.cp = cp;
      for (const ws of sockets) this.adopt(cp, ws);
    } catch (e) {
      this.store = null;
      this.cp = null;
      this.log(`ALERT node control plane not started, its state is left as it is: ${String(e)}`);
      for (const ws of this.ctx.getWebSockets()) closeQuietly(ws, 1011, 'unavailable');
      return;
    }
    await this.rearm();
  }

  /** A socket that outlived a hibernation: an authenticated session again, or closed (it must log in anew). */
  private adopt(cp: ControlPlane, ws: WebSocket): void {
    const a = attachedNode(ws);
    const link = this.link(ws);
    if (a === null) {
      // It was still logging in when the object slept: its challenge is gone with the memory.
      link.close(4401, 'log in again');
      return;
    }
    const s = cp.adopt(link, a.nodeId, a.quiet); // closes an unknown or banned node's socket itself, and a quiet one
    if (!s) return;
    this.sessions.set(ws, s);
    this.attached.add(ws);
  }

  /** The control plane's side of a socket. */
  private link(ws: WebSocket): NodeLink {
    return {
      send: (msg) => {
        // A node that drains after this was asked to (nodeWatch.ts: the cron's /healthz check).
        if (msg.t === 'drain' || msg.t === 'update') this.askedToDrain(this.sessions.get(ws)?.nodeId ?? null);
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          /* closed meanwhile: its close is handled on its own */
        }
      },
      close: (code, reason) => {
        closeQuietly(ws, code, reason);
        // webSocketClose is not guaranteed for a close the object starts (RoomDO.kick): end the session now.
        this.gone(ws);
      },
      // On the socket with its node: a wake closes a socket that was quiet instead of adopting it.
      quiet: (quiet) => {
        const nodeId = this.sessions.get(ws)?.nodeId;
        if (!nodeId) return;
        try {
          ws.serializeAttachment(quiet ? { nodeId, quiet } : { nodeId });
          this.attached.add(ws);
        } catch {
          /* closed meanwhile: nothing left to adopt */
        }
      },
    };
  }

  /**
   * The socket's session ends. It stays the socket's: what still comes on it (the backlog of a
   * stalled link, after its 4408) reaches the control plane, which only counts it for the log.
   */
  private gone(ws: WebSocket): void {
    const s = this.sessions.get(ws);
    if (s && !s.closed) this.cp?.onClose(s);
  }

  // ---- Hibernation API handlers -----------------------------------------------------------

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ready;
    const cp = this.cp;
    const s = this.sessions.get(ws);
    if (!cp || !s) return this.link(ws).close(4401, 'log in again');
    if (typeof message !== 'string') return this.link(ws).close(1003, 'text only');
    if (message.length > MAX_FRAME_CHARS) return this.link(ws).close(1009, 'frame too big');
    // It never throws for what a node sends; a store that fails on a report rejects (no ack: the node sends it again).
    await cp.onMessage(s, message).catch((e: unknown) => this.log(`node message failed: ${String(e)}`));
    if (s.nodeId !== null && !s.closed && !this.attached.has(ws)) {
      // Logged in: a wake after a hibernation adopts the socket from this, with no new challenge.
      ws.serializeAttachment({ nodeId: s.nodeId });
      this.attached.add(ws);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    await this.ready;
    // The node sent its close frame; the runtime does not answer it by itself (RoomDO.webSocketClose).
    closeQuietly(ws, code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, reason.slice(0, 120));
    this.gone(ws);
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.ready;
    this.gone(ws);
  }

  // ---- alarm --------------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    await this.ready;
    const cp = this.cp;
    if (!cp) return;
    // Each step on its own: a store write that fails in one (the match stays as it was, the next
    // run tries again) must neither skip the others nor stop the alarm.
    try {
      cp.sweep();
    } catch (e) {
      this.log(`ALERT sweep failed: ${String(e)}`);
    }
    try {
      this.note(this.watch.tick(Date.now(), cp.registry.list(), cp.matches.values(), this.goodChannel?.minimum ?? null, this.startedAt));
      this.keepOffline();
    } catch (e) {
      this.log(`ALERT node watch failed: ${String(e)}`);
    }
    // The next run is set before anything waits on another object: the sweep is what closes timed
    // out sockets and voids a dead node's matches, and a slow target must not hold it back. The
    // outbox is not awaited for the same reason; each delivery has its own timeout.
    await this.rearm();
    this.kickOutbox();
    if (Date.now() - this.channelAt >= CHANNEL_REFRESH_MS) await this.refreshChannel();
  }

  /** The nodes whose offline ALERT went out, written to meta when they changed. A failed write is tried again at the next alarm. */
  private keepOffline(): void {
    const row = JSON.stringify(this.watch.offlineAlerted());
    if (row === this.offlineRow) return;
    try {
      this.store?.setMeta(OFFLINE_KEY, row);
      this.offlineRow = row;
    } catch (e) {
      this.log(`${OFFLINE_KEY} not written: ${String(e)}`);
    }
  }

  /**
   * Something needs the alarm: a node's socket, a match not settled, an undelivered call, a
   * restart's grace, or a trusted node in service offline whose ALERT has not gone out yet (it
   * needs time to pass). Once it has, the object may sleep: the node's return comes on a socket.
   */
  private busy(): boolean {
    const cp = this.cp;
    if (!cp || !this.store) return false;
    return this.ctx.getWebSockets().length > 0 || cp.unfinished() > 0 || cp.inGrace() || this.store.outboxSize() > 0 || this.watch.watching(cp.registry.list());
  }

  private async rearm(): Promise<void> {
    if (this.busy()) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    else await this.ctx.storage.deleteAlarm();
  }

  /** On a new socket and a placement: the alarm runs, without moving one already set. */
  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  /**
   * Read channel.json again. A change reaches the nodes now (ControlPlane.channelChanged: those
   * below a new minimum are told to update), not at their next hello. A read that fails or takes
   * longer than timeoutMs keeps the last one; a missing or malformed object is handed on as it
   * is, and the control plane holds the nodes to the last good channel with an ALERT. True when
   * it changed (and the nodes were told).
   */
  private async refreshChannel(): Promise<boolean> {
    const env = this.cfg;
    if (!env) return false;
    this.channelAt = Date.now();
    let text: string | null;
    try {
      text = await withTimeout(env.NODE_RELEASES.get(CHANNEL_KEY).then((o) => (o ? o.text() : null)), this.timeoutMs);
    } catch (e) {
      this.log(`${CHANNEL_KEY} not read, keeping the last one: ${String(e)}`);
      return false;
    }
    if (text === this.channelText) return false;
    this.channelText = text;
    try {
      this.channel = text === null ? null : JSON.parse(text);
    } catch {
      this.channel = text;
    }
    this.goodChannel = channelOf(this.channel) ?? this.goodChannel;
    this.cp?.channelChanged();
    return true;
  }

  // ---- outbox -------------------------------------------------------------------------------

  /** Rows were just written: deliver them now rather than at the next alarm. */
  private kickOutbox(): void {
    this.ctx.waitUntil(
      Promise.resolve()
        .then(() => this.drain())
        .catch((e: unknown) => this.log(`ALERT outbox failed: ${String(e)}`)),
    );
  }

  /** Deliver every due row; a drain asked for while one runs makes it go round once more (rows written meanwhile). */
  private drain(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return this.draining;
    }
    const run = async () => {
      do {
        this.drainAgain = false;
        await this.drainDue();
      } while (this.drainAgain);
    };
    this.draining = run().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /**
   * One pass over the due rows, oldest first. A delivered row is deleted (deliverCall: a 2xx, or a
   * refusal it reported with an ALERT); any other is tried again 2, 4, 8 ... s later, at most
   * every 5 minutes, and a day without delivery raises an ALERT. A target that failed is not
   * asked again in the same pass: its other rows wait for the next one, and the other targets'
   * rows do not wait behind its timeouts.
   */
  private async drainDue(): Promise<void> {
    const store = this.store;
    if (!store) return;
    const failed = new Set<string>();
    for (const row of store.due(Date.now(), OUTBOX_BATCH)) {
      if (failed.has(row.target)) continue;
      if ((await deliverCall(this.env, row, (m) => this.log(m), this.timeoutMs)) === 'done') {
        store.delivered(row.id);
        this.lateRows.delete(row.id);
        continue;
      }
      failed.add(row.target);
      const attempts = row.attempts + 1;
      const now = Date.now();
      store.retryAt(row.id, attempts, now + Math.min(1000 * 2 ** attempts, OUTBOX_MAX_BACKOFF_MS));
      if (now - row.createdAt > DAY_MS && !this.lateRows.has(row.id)) {
        this.lateRows.add(row.id);
        this.log(`ALERT outbox ${row.path} for match ${row.matchId.slice(0, 8)} (${row.target}) undelivered for a day, ${attempts} tries: still retrying`);
      }
    }
  }

  // ---- HTTP ---------------------------------------------------------------------------------

  /**
   * Fixed window: true when `key` was hit more than `max` times in its current window. Bounded,
   * since anyone can bring new keys: expired windows are swept every LIMIT_PURGE_EVERY calls (a
   * sweep at each call would cost every junk request the whole map, on the thread the heartbeats
   * use), and past LIMIT_KEYS_MAX the oldest window goes, so a new caller is still let through.
   */
  private limited(key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    if (++this.limitCalls % LIMIT_PURGE_EVERY === 0) for (const [k, v] of this.limits) if (v.resetAt <= now) this.limits.delete(k);
    const e = this.limits.get(key);
    if (!e || e.resetAt <= now) {
      // Deleted and set again: a renewed window moves to the end, the Map's order stays the windows' age.
      this.limits.delete(key);
      if (this.limits.size >= LIMIT_KEYS_MAX) this.limits.delete(this.limits.keys().next().value as string);
      this.limits.set(key, { n: 1, resetAt: now + windowMs });
      return false;
    }
    return ++e.n > max;
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (!this.env.JWT_SECRET) return error(500, 'no_secret');
    if (!(await checkInternal(this.env.JWT_SECRET, request))) return error(403, 'forbidden');
    const cp = this.cp;
    const env = this.cfg;
    if (!cp || !env) return error(503, 'nodes_unavailable', UNAVAILABLE);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      if (path === '/nodes/connect') return await this.accept(request, cp);
      if (method === 'POST' && path === '/nodes/register') return await this.register(request, cp, env);
      const replay = REPLAY_ROUTE.exec(path);
      if (replay && method === 'PUT') return await this.putReplay(request, cp, replay[1]);
      if (replay && method === 'GET') return await this.getReplay(request, cp, replay[1]);
      if (method === 'GET' && path === '/nodes/status') return this.status(cp);
      if (method === 'POST' && path === '/nodes/tokens') return await this.token(request, cp, env);
      if (method === 'GET' && path === '/nodes/mine') return this.mine(request, cp);
      if (path.startsWith('/nodes/admin/')) return await this.admin(request, cp, path.slice('/nodes/admin/'.length));
      if (method === 'POST' && path === NODE_ROUTES.place) return await this.place(request, cp);
      if (method === 'POST' && path === NODE_ROUTES.rejoin) return await this.rejoin(request, cp);
      if (method === 'POST' && path === NODE_ROUTES.leave) return await this.leave(request, cp);
      if (method === 'GET' && path === NODE_ROUTES.status) return this.matchStatus(url, cp);
      if (method === 'POST' && path === NODE_ROUTES.health) return await this.health(cp);
    } catch (e) {
      this.log(`${method} ${path} failed: ${String(e)}`);
      return error(500, 'internal');
    }
    return error(404, 'not_found');
  }

  private async accept(request: Request, cp: ControlPlane): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error(426, 'upgrade_required');
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    // The challenge goes out now; the socket is a session from here (MAX_UNAUTHENTICATED caps those still to log in).
    this.sessions.set(server, cp.open(this.link(server)));
    await this.ensureAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async register(request: Request, cp: ControlPlane, env: NodesEnv): Promise<Response> {
    const ip = limitKey(request.headers.get('x-client-ip') ?? 'unknown');
    if (this.limited('register:' + ip, REGISTER_PER_IP_PER_HOUR, HOUR_MS)) return error(429, 'rate_limited', `at most ${REGISTER_PER_IP_PER_HOUR} registrations per hour from one address`);
    // Before the token is spent (it stays good): a node registered now would get a public key that
    // fits no ticket. The ALERT at the start names the cause; the caller hears what any outage says.
    if (!this.keyOk) return error(503, 'nodes_unavailable', UNAVAILABLE);
    const body = await readJson<RegisterRequest>(request);
    if (!body) return error(400, 'bad_request');
    const r = await cp.registry.register(body, Date.now());
    if (!r.ok) return error(403, r.code, r.message);
    const n = r.node;
    this.log(`registered node ${n.name} (${n.nodeId}) for ${n.operatorName}, roles ${n.roles.join('+')}, transports ${n.transports.join('+') || '-'}${n.trusted ? ', trusted' : ''}`);
    const answer: RegisterAnswer = {
      nodeId: n.nodeId,
      operatorId: n.operatorId,
      region: n.region,
      name: n.name,
      status: n.status,
      controlPublicKey: env.NODE_CONTROL_PUBLIC_KEY,
      controlUrl: publicBase(env).replace(/^http/, 'ws') + '/nodes/connect',
    };
    return json(answer);
  }

  private async putReplay(request: Request, cp: ControlPlane, matchId: string): Promise<Response> {
    const h = request.headers;
    const nodeId = h.get('x-node-id') ?? '';
    const ts = Number(h.get('x-node-ts'));
    const sig = h.get('x-node-sig') ?? '';
    const sha = h.get('x-replay-sha256') ?? '';
    // Before the body: every player of a node match knows its id and the node's, and a forged
    // upload must cost neither the read nor the hash of 16 MiB on the object every heartbeat uses.
    const refused = await cp.replayPutCheck(matchId, nodeId, ts, sig, sha);
    if (refused) return error(refused.status, refused.code);
    const bytes = await readCapped(request, REPLAY_MAX_BYTES);
    if (!bytes) return error(413, 'too_large');
    const r = await cp.storeReplay(matchId, nodeId, ts, sig, sha, bytes);
    return r.ok ? json({ ok: true }) : error(r.status, r.code);
  }

  private async getReplay(request: Request, cp: ControlPlane, matchId: string): Promise<Response> {
    const h = request.headers;
    const bytes = await cp.loadReplayFor(matchId, h.get('x-node-id') ?? '', Number(h.get('x-node-ts')), h.get('x-node-sig') ?? '', h.get('x-replay-sha256') ?? '');
    if (!bytes) return error(404, 'no_replay');
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
  }

  /** The public list (the reference server's GET /nodes/status): no address, no operator id. */
  private status(cp: ControlPlane): Response {
    const nodes = cp.registry.list();
    const names = new Map(nodes.map((n) => [n.operatorId, n.operatorName]));
    return json({
      build: CLIENT_BUILD,
      nodes: nodes.map((n) => ({
        name: n.name,
        operator: n.operatorName,
        region: n.region,
        status: n.status,
        online: n.online,
        roles: n.roles,
        transports: n.transports,
        active: n.active,
        capacity: n.capacity.matches,
        tickLagP99Ms: n.tickLagP99Ms,
        version: n.build.version,
        compatible: cp.sameBuildAs(n.build),
        trusted: n.trusted,
      })),
      hosts: cp.ledger.leaderboard(Date.now()).map((e) => ({ name: names.get(e.operatorId) ?? e.operatorId.slice(0, 6), points: e.points })),
    });
  }

  private async token(request: Request, cp: ControlPlane, env: NodesEnv): Promise<Response> {
    const id = request.headers.get('x-operator-id') ?? '';
    // The Worker let only a trusted account through; the object holds the same list, and only it decides.
    if (!cp.registry.isTrusted(id)) return error(403, 'not_trusted', 'only the project creates node tokens for now');
    const b = await readJson<{ region?: unknown; name?: unknown }>(request);
    if (!b || !isRegion(b.region)) return error(400, 'bad_region');
    if (this.limited('tokens:' + id, TOKENS_PER_ACCOUNT_PER_DAY, DAY_MS)) return error(429, 'rate_limited', `at most ${TOKENS_PER_ACCOUNT_PER_DAY} tokens a day`);
    const name = sanitizeName(decodeHeader(request.headers.get('x-operator-name'))) ?? id.slice(0, 6);
    const t = await cp.registry.createToken({ id, name }, b.region, Date.now(), typeof b.name === 'string' ? b.name : undefined);
    const base = publicBase(env);
    return json(
      {
        token: t.token,
        expiresAt: t.expiresAt,
        ttlMinutes: TOKEN_TTL_MS / 60_000,
        install: { linux: `curl -fsSL ${base}/nodes/releases/install.sh | sudo bash -s -- --control ${base} --token ${t.token}` },
      },
      200,
      { 'cache-control': 'no-store' },
    );
  }

  private mine(request: Request, cp: ControlPlane): Response {
    const id = request.headers.get('x-operator-id') ?? '';
    return json(
      {
        operator: { id, trusted: cp.registry.isTrusted(id) },
        nodes: cp.registry.byOperator(id).map((n) => mineView(cp, n)),
        // The ledger's view (30 days, all time): the wallet to spend it is the account's (GET /api/me/shop).
        rewards: cp.ledger.summary(id, Date.now()),
      },
      200,
      { 'cache-control': 'no-store' },
    );
  }

  private async place(request: Request, cp: ControlPlane): Promise<Response> {
    const body = parsePlace(await readJson<unknown>(request));
    if (!body) return error(400, 'bad_request');
    // No node would accept a ticket signed now: the matchmaker uses its own servers, and hosts 0 makes it stop asking for a while.
    if (!this.keyOk) return json({ placement: null, hosts: 0 } satisfies PlaceAnswer);
    let placement: PlaceAnswer['placement'];
    try {
      placement = await cp.place(body);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('bad ')) return error(400, 'bad_request', e.message);
      throw e;
    }
    if (placement) await this.ensureAlarm();
    return json({ placement, hosts: cp.hostsOnline(body.region) } satisfies PlaceAnswer);
  }

  private async rejoin(request: Request, cp: ControlPlane): Promise<Response> {
    const b = await readJson<{ matchId?: unknown; playerId?: unknown }>(request);
    if (!b || !isHex(b.matchId, 64) || !isStr(b.playerId, 64)) return error(400, 'bad_request');
    if (!this.keyOk) return error(REJOIN_STATUS.offline, 'offline');
    const r = await cp.rejoin(b.matchId, b.playerId);
    return r.ok ? json({ ticket: r.ticket, wsUrl: r.wsUrl, ...(r.cars ? { cars: r.cars } : {}) } satisfies RejoinTicket) : error(REJOIN_STATUS[r.code], r.code);
  }

  private async leave(request: Request, cp: ControlPlane): Promise<Response> {
    const b = await readJson<{ matchId?: unknown; playerId?: unknown; connected?: unknown }>(request);
    if (!b || !isHex(b.matchId, 64) || !isStr(b.playerId, 64)) return error(400, 'bad_request');
    try {
      const answer: LeaveAnswer = await cp.leave(b.matchId, b.playerId, b.connected === false ? { connected: false } : {});
      return json(answer);
    } catch (e) {
      if (e instanceof NodeRefused && e.code in LEAVE_STATUS) return error(LEAVE_STATUS[e.code as LeaveRefusal], e.code);
      throw e;
    }
  }

  private matchStatus(url: URL, cp: ControlPlane): Response {
    const s = cp.matchStatus(url.searchParams.get('matchId') ?? '', url.searchParams.get('playerId') ?? '');
    return s ? json(s satisfies StatusAnswer) : error(404, 'no_match');
  }

  // ---- the cron's health check ------------------------------------------------------------------

  /**
   * POST /internal/health (index.ts scheduled, every 5 minutes): the /healthz of every trusted wss
   * node online, or in service and seen by this object in the last hour (healthzTargets), all at
   * once, 5 s each. A problem raises its ALERT when it starts (NodeWatch.health); a drain the node
   * was asked for is no problem.
   */
  private async health(cp: ControlPlane): Promise<Response> {
    const targets = healthzTargets(cp.registry.list(), Date.now());
    const found = await Promise.all(targets.map(async (n) => ({ n, r: await probeHealthz(n, this.fetchFn, this.healthzTimeoutMs) })));
    let problems = 0;
    for (const { n, r } of found) {
      const expected = this.drainExpected(n);
      if (!r.ok || (r.draining && !expected)) problems++;
      const note = this.watch.health(n, r, expected);
      if (note) this.note([note]);
    }
    return json({ probed: targets.length, problems });
  }

  /** The control plane sent this node a drain or an update: written down with the node process it went to. */
  private askedToDrain(nodeId: string | null): void {
    if (nodeId === null) return;
    const boot = this.cp?.registry.node(nodeId)?.bootId ?? null;
    if (this.drainAsked.has(nodeId) && this.drainAsked.get(nodeId) === boot) return;
    this.drainAsked.set(nodeId, boot);
    try {
      this.store?.setMeta(DRAINS_KEY, JSON.stringify(Object.fromEntries(this.drainAsked)));
    } catch (e) {
      this.log(`${DRAINS_KEY} not written: ${String(e)}`);
    }
  }

  /**
   * A drain the node was asked for: a drain or an update sent to the process now running, or a
   * version below the channel's minimum (an update: a node also starts one itself when its welcome
   * names a higher minimum, with no 'update' message).
   */
  private drainExpected(n: NodeRecord): boolean {
    const ch = this.goodChannel;
    if (ch && compareVersions(n.build.version, ch.minimum) < 0) return true;
    return this.drainAsked.has(n.nodeId) && this.drainAsked.get(n.nodeId) === n.bootId;
  }

  // ---- maintainers --------------------------------------------------------------------------------

  /**
   * /nodes/admin/<what>, for an account in NODE_TRUSTED_OPERATORS (the Worker checked it; the object
   * holds the same list and decides). Every action is an ALERT line naming who did it, the list too
   * (it holds the nodes' addresses), posted every time (audit): a project session in the wrong hands
   * shows in the team's channel.
   */
  private async admin(request: Request, cp: ControlPlane, what: string): Promise<Response> {
    const id = request.headers.get('x-operator-id') ?? '';
    if (!cp.registry.isTrusted(id)) return error(403, 'not_trusted', 'only the project maintains the nodes');
    const actor = `${sanitizeName(decodeHeader(request.headers.get('x-operator-name'))) ?? id.slice(0, 6)} (${id})`;
    if (request.method === 'GET' && what === 'nodes') return this.adminNodes(cp, actor);
    if (request.method !== 'POST') return error(404, 'not_found');
    if (what === 'update') return await this.adminUpdate(cp, actor);
    if (what === 'grant' || what === 'revoke' || what === 'unfreeze') return await this.adminInventory(request, actor, what);
    if (what !== 'status' && what !== 'drain' && what !== 'reprobe') return error(404, 'not_found');
    const b = await readJson<{ nodeId?: unknown; status?: unknown; reason?: unknown }>(request);
    if (!b || !isHex(b.nodeId, 16)) return error(400, 'bad_node_id', 'nodeId: the 16 hex characters of a node');
    const n = cp.registry.node(b.nodeId);
    if (!n) return error(404, 'no_node');
    if (what === 'status') return await this.adminStatus(cp, actor, n, b.status, reasonOf(b.reason));
    if (what === 'drain') return this.adminDrain(cp, actor, n, reasonOf(b.reason));
    return await this.adminReprobe(cp, actor, n);
  }

  /** GET /nodes/admin/nodes: every node with its address, counters and live state, and the matches the control plane holds for it. */
  private adminNodes(cp: ControlPlane, actor: string): Response {
    const open = new Map<string, number>();
    let verifying = 0;
    for (const m of cp.matches.values()) {
      if (m.state === 'done') continue;
      open.set(m.nodeId, (open.get(m.nodeId) ?? 0) + 1);
      if (m.state === 'verifying') verifying++;
    }
    const nodes = cp.registry.list().map((n) => ({
      ...mineView(cp, n),
      operator: { id: n.operatorId, name: n.operatorName },
      createdAt: n.createdAt,
      lastSeen: n.lastSeen > 0 ? n.lastSeen : null,
      draining: n.draining,
      egressCapGB: n.egressCapGB,
      cpuLoad: n.cpuLoad,
      bootId: n.bootId,
      matches: open.get(n.nodeId) ?? 0,
    }));
    this.audit(`ALERT admin ${actor}: listed the nodes (${nodes.length}, with their addresses)`);
    return json({ build: CLIENT_BUILD, channel: this.goodChannel, verifying, nodes }, 200, { 'cache-control': 'no-store' });
  }

  /**
   * POST /nodes/admin/status { nodeId, status, reason? }: ControlPlane.setStatus, and the node is
   * told. A trusted node set to suspended or banned is out of service: no matches, no offline ALERT.
   * Set back in service while offline, its outage is a new one: the alarm runs for its ALERT.
   */
  private async adminStatus(cp: ControlPlane, actor: string, n: NodeRecord, status: unknown, reason: string | null): Promise<Response> {
    if (!ADMIN_STATUSES.includes(status as NodeStatus)) return error(400, 'bad_status', `status: ${ADMIN_STATUSES.join(', ')}`);
    const was = n.status;
    cp.setStatus(n.nodeId, status as NodeStatus, reason);
    this.audit(`ALERT admin ${actor}: node ${label(n)} ${was} -> ${n.status}${was === n.status ? ' (no change)' : ''}${reason ? `: ${reason}` : ''}`);
    this.watch.statusSet(n);
    this.keepOffline();
    if (this.busy()) await this.ensureAlarm();
    return json({ nodeId: n.nodeId, name: n.name, status: n.status, was });
  }

  /**
   * POST /nodes/admin/drain { nodeId, reason? }: the node takes no new match, plays out the ones it
   * has and then idles. One-way (node/runtime.ts): it comes back with `sudo systemctl restart
   * turbogol-node` on its machine. A node that is not connected is told nothing (409).
   */
  private adminDrain(cp: ControlPlane, actor: string, n: NodeRecord, reason: string | null): Response {
    const why = reason ?? 'asked by a maintainer';
    if (!cp.isOnline(n.nodeId)) {
      this.audit(`ALERT admin ${actor}: node ${label(n)} not drained, it is offline: ${why}`);
      return error(409, 'offline', 'the node is not connected: nothing was sent');
    }
    cp.drain(n.nodeId, why);
    this.audit(`ALERT admin ${actor}: node ${label(n)} told to drain: ${why}`);
    return json({ nodeId: n.nodeId, name: n.name, draining: true, back: 'sudo systemctl restart turbogol-node on its machine' });
  }

  /**
   * POST /nodes/admin/update: channel.json read again now (not within the minute) and every node
   * below its minimum told to update (ControlPlane.channelChanged; a verifier with matches of its
   * build still to verify waits for them, as at a hello).
   */
  private async adminUpdate(cp: ControlPlane, actor: string): Promise<Response> {
    if (!(await this.refreshChannel())) cp.channelChanged();
    const ch = this.goodChannel;
    const below = ch ? cp.registry.list().filter((n) => n.online && compareVersions(n.build.version, ch.minimum) < 0) : [];
    this.audit(`ALERT admin ${actor}: the nodes were told the channel again (${ch ? `stable ${ch.stable}, minimum ${ch.minimum}` : 'no valid channel'}): ${below.length} online below its minimum`);
    return json({ channel: ch, below: below.map((n) => ({ nodeId: n.nodeId, name: n.name, version: n.build.version })) });
  }

  /**
   * POST /nodes/admin/grant { account, item }, /revoke { account, item }, /unfreeze { account }: an
   * account's items and wallet in AccountsDO (accountStore.ts host_claims, host_freeze), each an
   * ALERT naming who did it and what AccountsDO answered (audit). A grant is a claim that costs
   * nothing, whatever the item's status: a test account's car, or what a mistake took; a revoke
   * gives a claim's cost back; an unfreeze lets the claims of an operator under review go on. The
   * answer is AccountsDO's, as it is.
   */
  private async adminInventory(request: Request, actor: string, what: 'grant' | 'revoke' | 'unfreeze'): Promise<Response> {
    const b = await readJson<{ account?: unknown; item?: unknown }>(request);
    if (!b || !isHex(b.account, 16)) return error(400, 'bad_account', 'account: the 16 hex characters of an account id');
    const item = what === 'unfreeze' ? null : typeof b.item === 'string' ? catalogItem(b.item) : undefined;
    if (item === undefined) return error(400, 'unknown_item', `item: one of ${CATALOG.map((i) => i.id).join(', ')}`);
    const res = await accountsCall(this.env, '/host-' + what, item === null ? { userId: b.account } : { userId: b.account, item: item.id });
    const text = await res.text();
    this.audit(`ALERT admin ${actor}: ${what}${item ? ` ${item.id}` : ''} for account ${b.account} -> ${res.status} ${text.slice(0, 120)}`);
    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }

  /**
   * POST /nodes/admin/reprobe { nodeId }: a wss host's /healthz now. The control plane's own probe
   * runs (a host not proven reachable goes back into placement when it passes; a failure of a
   * proven one counts toward taking it out), and the answer says what a direct probe found.
   */
  private async adminReprobe(cp: ControlPlane, actor: string, n: NodeRecord): Promise<Response> {
    if (!n.roles.includes('host') || !n.transports.includes('wss') || !n.publicUrl) return error(409, 'not_wss', 'only a wss host has a /healthz to probe');
    const [, healthz] = await Promise.all([n.reachableAt === null ? cp.probe(n.nodeId) : cp.reprobe(n.nodeId), probeHealthz(n, this.fetchFn, this.healthzTimeoutMs)]);
    const reachable = n.reachableAt !== null;
    const found = healthz.ok ? (healthz.draining ? 'ok, draining' : 'ok') : healthz.detail;
    this.audit(`ALERT admin ${actor}: node ${label(n)} probed: ${found}; ${reachable ? 'in' : 'out of'} wss placement`);
    return json({ nodeId: n.nodeId, name: n.name, reachable, healthz });
  }
}

function publicBase(env: NodesEnv): string {
  return env.NODES_PUBLIC_BASE.replace(/\/+$/, '');
}

/** The drains_asked meta row (node id -> bootId), or an empty map when it is missing or does not read. */
function drainsOf(v: string | null): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let o: unknown = null;
  try {
    o = v === null ? null : JSON.parse(v);
  } catch {
    /* an empty map */
  }
  if (typeof o === 'object' && o !== null) {
    for (const [k, b] of Object.entries(o)) if (b === null || typeof b === 'string') out.set(k, b);
  }
  return out;
}

/** The offline_alerted meta row (a list of node ids), or none when it does not read. */
function idsOf(v: string): string[] {
  let o: unknown = null;
  try {
    o = JSON.parse(v);
  } catch {
    /* none */
  }
  return Array.isArray(o) ? o.filter((x): x is string => typeof x === 'string') : [];
}

/** The Worker sends the operator's name URL-encoded (header values are Latin-1). */
function decodeHeader(v: string | null): string {
  try {
    return decodeURIComponent(v ?? '');
  } catch {
    return '';
  }
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* already closed */
  }
}

/** GET /nodes/mine: one of the operator's own nodes, its address and counters included. */
function mineView(cp: ControlPlane, n: NodeRecord) {
  return {
    nodeId: n.nodeId,
    name: n.name,
    region: n.region,
    status: n.status,
    statusReason: n.statusReason,
    suspendedUntil: n.suspendedUntil,
    online: n.online,
    roles: n.roles,
    transports: n.transports,
    trusted: n.trusted,
    publicUrl: n.publicUrl,
    reachable: n.reachableAt !== null,
    active: n.active,
    capacity: n.capacity,
    tickLagP99Ms: n.tickLagP99Ms,
    egressGB: Math.round(n.egressGB * 100) / 100,
    counters: n.counters,
    version: n.build.version,
    compatible: cp.sameBuildAs(n.build),
  };
}

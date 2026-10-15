/**
 * MatchDO: one Durable Object per match. The matchmaker registers the roster (POST
 * /internal/create), the Worker forwards verified WebSocket upgrades (GET /ws/<id> with the
 * ticket claims in x-* headers and the internal header), and this object runs the RoomHost at
 * 120 Hz with the standard (non-hibernating) WebSocket API: the tick loop is a setInterval, which
 * keeps the object alive for the length of the match.
 *
 * Lifecycle
 *   create      roster + createdAt in storage, wasm instantiated (pre-warmed), 'unused room' alarm (90 s)
 *   upgrade     internal header + claim headers, slot check, host ready, single-use jti (storage),
 *               accept, Welcome (a new socket for a slot replaces the old one: close 4000 'replaced')
 *   start       when every human (not left) has sent Ready or 5 s after the first socket ('started' persisted)
 *   loop        setInterval(8 ms) + accumulator on Date.now() deltas (<= 8 ticks per callback)
 *               -> ticks, snapshots every 4 ticks, events, empty-room check (15 s)
 *   leave       POST /internal/leave { playerId } (the matchmaker, for the player's own POST /api/leave
 *               { matchId }: an explicit quit from the menu, never a network drop or a reload): the
 *               slot's socket is closed (1000 'left'), the slot is flagged left ('left' persisted: its
 *               upgrades and /internal/rejoin answer 410 'left'), the host's BotTeam drives the car
 *               from the next tick (RoomHost.convertToBot) and the others get 'botTakeover'. The
 *               last human leaving (every 'player' slot left) ends the match at once: shutdown('left')
 *               before the answer (sockets closed, scoped matchmaker /release with the capacity entry,
 *               storage wiped; a later /api/rejoin gets 404). Not the empty-room check: it needs the
 *               loop (a quit before the first socket would wait for the 90 s 'unused' alarm) and the
 *               freed lock would let one guest queue and quit back to back, each quit keeping a match
 *               (a MAX_ACTIVE_ROOMS slot) alive meanwhile
 *   end         'ended' event + final snapshot, sockets closed (1000) 2 s later, storage wiped,
 *               matchmaker locks released (scoped to this matchId)
 *   alarm       90 s after create: shutdown when nobody ever connected (tickets never used); then
 *               regulation + 10 min: a match still running (unlimited overtime) gets an 'ended'
 *               event (leader wins, -1 when tied) and a final snapshot before shutdown('ttl')
 *   restart     a deploy / eviction / crash mid-match loses the sim (memory only): the constructor
 *               sees 'started' without 'ended', marks the match reset, answers 410 'match_reset'
 *               to upgrades and rejoins, and shuts down (locks released) instead of replaying
 *               the countdown at 0-0
 *
 * Guards: <= 8 sockets, frames <= 512 B, a token bucket over every incoming message per socket
 * (burst 128, 150/s; exceeding it closes with 1008 'rate'), input packets <= 6 + 1 per host tick
 * per slot (extras are dropped), any malformed frame closes the socket with 1008. The Welcome
 * roster carries no playerId (the session subject stays server side).
 *
 * Measurements: the Welcome carries `hostColo`, the Cloudflare colo this object runs in, read once
 * per isolate from https://cloudflare.com/cdn-cgi/trace (started with the host pre-warm, 5 s cap,
 * 'unknown' on failure and retried by a later room; kept in memory and in storage).
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { error, json, readJson } from './env';
import type { GameModeId } from './env';
import { INTERNAL_HEADER, checkInternal, internalSecret } from './auth';
import { RoomHost } from './roomHost';
import type { RosterEntry } from './roomHost';
import { createHostArena } from './wasm';
import type { HostArena } from './wasm';
import {
  INPUT_MAX_BATCH,
  MsgType,
  PING_LEN,
  PONG_LEN,
  PROTOCOL_VERSION,
  TICK_RATE,
  WS_SUBPROTOCOL,
  decodeInput,
  decodePing,
  encodeJson,
  encodePong,
} from '../../src/net/protocol';
import type { InputPacket, MatchEvent, Welcome } from '../../src/net/protocol';
import { MAX_CARS, PACKED_INPUT_BYTES } from '../../src/sim/types';

const TICK_MS = 1000 / TICK_RATE;
const INTERVAL_MS = 8;
const MAX_TICKS_PER_CALLBACK = 8;
const MAX_SOCKETS = 8;
const MAX_FRAME_BYTES = 512;
/** Message budget per socket: every incoming frame is a billable DO request (~1,000/s soft limit per object). */
const MSG_BURST = 128; // ~2 s of a legitimate client's backlog after a TCP stall (60 inputs + 4 pings per second)
const MSG_REFILL_PER_MS = 150 / 1000;
/** Input packets per slot: a small burst plus one per host tick (the client sends one per two ticks). */
const INPUT_BURST = 6;
const START_GRACE_MS = 5_000;
const EMPTY_SHUTDOWN_MS = 15_000;
const END_LINGER_MS = 2_000;
const TTL_AFTER_MATCH_MS = 10 * 60_000;
/** A room whose tickets were never used (no socket, loop never started) is dropped at this age. */
const UNUSED_ALARM_MS = 90_000;
const ALARM_SLACK_MS = 1_000;
/** Ranked: every player must be connected and ready this long after the create, or the match is cancelled (absent players: an abandon each). */
export const RANKED_JOIN_MS = 45_000;
/** Ranked: a team whose every remaining player has been disconnected this long forfeits. */
export const RANKED_DC_FORFEIT_MS = 60_000;
const FORFEIT_CHECK_MS = 1_000;
const SNAPSHOT_EVERY = 4;
const KICKOFF_SEED = 1;
/** Close code for a socket replaced by a newer one for the same slot (the client does not rejoin). */
const CLOSE_REPLACED = 4000;
/** Where this isolate runs (Welcome.hostColo): Cloudflare's trace endpoint, parsed for its 'colo=' line. */
const TRACE_URL = 'https://cloudflare.com/cdn-cgi/trace';
const TRACE_TIMEOUT_MS = 5_000;
const COLO_UNKNOWN = 'unknown';
/** A failed trace is tried again by a room created this long after it (one trace per isolate otherwise). */
const COLO_RETRY_MS = 60_000;
let coloCache: Promise<string> | null = null;
let coloRetryAt = 0;

/** The colo of this isolate (all its objects share it), 'unknown' when the trace fails or times out. */
function traceColo(): Promise<string> {
  const now = Date.now();
  if (coloCache === null || (coloRetryAt !== 0 && now >= coloRetryAt)) {
    coloRetryAt = 0;
    const p = (async (): Promise<string> => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TRACE_TIMEOUT_MS);
      try {
        const res = await fetch(TRACE_URL, { signal: ctrl.signal });
        if (!res.ok) return COLO_UNKNOWN;
        const m = /^colo=([A-Za-z0-9]+)\s*$/m.exec(await res.text());
        return m ? m[1] : COLO_UNKNOWN;
      } catch {
        return COLO_UNKNOWN;
      } finally {
        clearTimeout(timer);
      }
    })();
    coloCache = p;
    void p.then((c) => {
      if (c === COLO_UNKNOWN) coloRetryAt = Date.now() + COLO_RETRY_MS;
    });
  }
  return coloCache;
}

export interface MatchRecord {
  matchId: string;
  mode: GameModeId;
  region: string;
  roster: RosterEntry[];
  matchLengthSeconds: number;
  createdAt: number;
  /** Ranked (accounts only): no start without every player, forfeit when a team is gone, the result goes to AccountsDO. */
  ranked?: boolean;
}

/** What POST /internal/leave answers the matchmaker (MatchDO.leave). */
export interface MatchLeaveAnswer {
  ok: true;
  slot: number;
  /** A live socket of the slot was closed (1000 'left'). */
  closed: boolean;
  /** The slot was left already (a repeated leave): nothing changed. */
  already: boolean;
  /** It was the last human: the match shut down before this answer (its locks and capacity entry released). */
  ended: boolean;
}

interface Client {
  ws: WebSocket;
  slot: number;
  playerId: string;
  name: string;
  ready: boolean;
  /** In clients[] and counted in liveSockets; cleared exactly once by unlink(). */
  attached: boolean;
  /** Token bucket over every incoming message (MSG_BURST, MSG_REFILL_PER_MS). */
  tokens: number;
  tokensAt: number;
  /** Token bucket over input packets (INPUT_BURST, +1 per host tick since `inputTick`). */
  inputTokens: number;
  inputTick: number;
}

interface CreateBody extends Partial<MatchRecord> {}

function ttlDeadline(rec: MatchRecord): number {
  return rec.createdAt + rec.matchLengthSeconds * 1000 + TTL_AFTER_MATCH_MS;
}

export class MatchDO extends DurableObject<Env> {
  private record: MatchRecord | null = null;
  private loaded: Promise<void>;
  private hostPromise: Promise<RoomHost> | null = null;
  private host: RoomHost | null = null;
  private arena: HostArena | null = null;
  private readonly clients: Array<Client | null> = new Array<Client | null>(MAX_CARS).fill(null);
  private liveSockets = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private lastNow = 0;
  private acc = 0;
  private emptySince = -1;
  private ended = false;
  private shutDown = false;
  /** The object restarted mid-match: upgrades / rejoins answer 410 'match_reset' while it lives. */
  private matchReset = false;
  /** Human slots whose player left for good (POST /internal/leave): bot-driven, never rejoined. Persisted as 'left'. */
  private readonly leftSlots = new Uint8Array(MAX_CARS);
  /** Ranked bookkeeping (memory only: a restart cancels a ranked match anyway): when the slot's socket closed (0 = connected or never). */
  private readonly discSince = new Float64Array(MAX_CARS);
  private forfeitCheckAt = 0;
  /** The ranked result (or cancellation) went out: shutdown must not send another. */
  private rankedReported = false;
  /** Welcome.hostColo: from storage, else from the trace started by ensureHost (COLO_UNKNOWN until then). */
  private hostColo: string = COLO_UNKNOWN;
  private coloPromise: Promise<string> | null = null;
  // preallocated scratch
  private outBuf = new Uint8Array(0);
  private readonly pongBuf = new Uint8Array(PONG_LEN);
  private readonly inputPkt: InputPacket = { firstTick: 0, count: 0, ackTick: 0, packed: new Int8Array(INPUT_MAX_BATCH * PACKED_INPUT_BYTES) };
  private readonly eventScratch: MatchEvent[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      const rec = await ctx.storage.get<MatchRecord>('record');
      if (rec) this.record = rec;
      const colo = await ctx.storage.get<string>('hostColo');
      if (typeof colo === 'string' && colo.length > 0) this.hostColo = colo;
      const left = await ctx.storage.get<number[]>('left');
      if (Array.isArray(left)) for (const s of left) if (Number.isInteger(s) && s >= 0 && s < MAX_CARS) this.leftSlots[s] = 1;
      this.ended = (await ctx.storage.get<boolean>('ended')) === true;
      const started = (await ctx.storage.get<boolean>('started')) === true;
      if (rec && started && !this.ended) {
        // Deploy / eviction / crash while the loop was running: the sim state lived only in memory,
        // so the match cannot resume. Nobody is told "0-0 again": the players get a 410 and their
        // locks are freed so they can queue again.
        console.warn(`MatchDO ${rec.matchId}: restarted mid-match, resetting`);
        this.matchReset = true;
        this.ended = true;
        await this.shutdown('match_reset');
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.loaded;
    if (!this.env.JWT_SECRET) return error(500, 'no_secret', 'JWT_SECRET is not configured');
    // Every route, the upgrade included: the slot ownership comes from headers only the Worker sets.
    if (!(await checkInternal(this.env.JWT_SECRET, request))) return error(403, 'forbidden');
    const url = new URL(request.url);
    if (url.pathname === '/ws' || url.pathname.startsWith('/ws/')) return this.upgrade(request);
    if (request.method === 'POST' && url.pathname === '/internal/create') return this.create(request);
    if (request.method === 'POST' && url.pathname === '/internal/rejoin') return this.rejoin(request);
    if (request.method === 'POST' && url.pathname === '/internal/leave') return this.leave(request);
    if (request.method === 'GET' && url.pathname === '/internal/status') return this.status();
    return error(404, 'not_found');
  }

  override async alarm(): Promise<void> {
    await this.loaded;
    const rec = this.record;
    if (!rec || this.shutDown) return;
    const now = Date.now();
    const ttlAt = ttlDeadline(rec);
    if (now < ttlAt - ALARM_SLACK_MS) {
      // The early alarm (UNUSED_ALARM_MS after create). Without a socket the loop never ran, so
      // neither the 'empty' check nor the whistle would ever reach this room before the TTL.
      const host = this.host;
      if (rec.ranked && !(host !== null && host.isStarted)) {
        await this.cancelRanked('no_show');
        return;
      }
      if (this.liveSockets === 0 && !(host !== null && host.isStarted)) {
        await this.shutdown('unused');
        return;
      }
      await this.ctx.storage.setAlarm(ttlAt);
      return;
    }
    this.endByTtl();
    await this.shutdown('ttl');
  }

  // ---- internal endpoints -----------------------------------------------------------------

  private async create(request: Request): Promise<Response> {
    if (this.record) return error(409, 'exists');
    const body = await readJson<CreateBody>(request);
    if (!body || typeof body.matchId !== 'string' || !Array.isArray(body.roster) || body.roster.length < 1 || body.roster.length > MAX_CARS) {
      return error(400, 'bad_request');
    }
    for (let i = 0; i < body.roster.length; i++) {
      const e = body.roster[i];
      if (!e || e.slot !== i || (e.team !== 0 && e.team !== 1) || (e.kind !== 'player' && e.kind !== 'bot') || typeof e.name !== 'string') {
        return error(400, 'bad_roster');
      }
      if (e.kind === 'player' && typeof e.playerId !== 'string') return error(400, 'bad_roster');
    }
    const rec: MatchRecord = {
      matchId: body.matchId,
      mode: body.mode ?? '1v1',
      region: typeof body.region === 'string' ? body.region : '?',
      roster: body.roster,
      matchLengthSeconds: typeof body.matchLengthSeconds === 'number' ? body.matchLengthSeconds : 300,
      createdAt: typeof body.createdAt === 'number' ? body.createdAt : Date.now(),
      ranked: body.ranked === true,
    };
    this.record = rec;
    await this.ctx.storage.put('record', rec);
    // First the 'unused room' check; alarm() re-arms it to the TTL (ttlDeadline) when the room is in use.
    await this.ctx.storage.setAlarm(Date.now() + (rec.ranked ? RANKED_JOIN_MS : UNUSED_ALARM_MS));
    try {
      await this.ensureHost(); // pre-warm the wasm so the first upgrade is fast
    } catch (e) {
      console.error('MatchDO: host init failed', e);
      // Leave the object empty so the id is not a half-made room.
      this.record = null;
      this.hostPromise = null;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return error(500, 'host_init_failed', String(e));
    }
    return json({ ok: true, matchId: rec.matchId });
  }

  private async rejoin(request: Request): Promise<Response> {
    const body = await readJson<{ playerId?: unknown }>(request);
    if (!body || typeof body.playerId !== 'string') return error(400, 'bad_request');
    if (this.matchReset) return error(410, 'match_reset');
    const rec = this.record;
    if (!rec || this.ended || this.shutDown) return error(404, 'no_match');
    const e = rec.roster.find((r) => r.kind === 'player' && r.playerId === body.playerId);
    if (!e) return error(404, 'not_in_match');
    if (this.leftSlots[e.slot] === 1) return error(410, 'left', 'you left this match (its bots drive your car): queue again');
    return json({ ok: true, slot: e.slot, team: e.team, name: e.name, mode: rec.mode });
  }

  /**
   * POST /internal/leave { playerId }: the player quit this match for good (see the header). Close
   * the slot's socket, flag the slot left, hand the car to the host's BotTeam and tell the others.
   * Everything but the storage write happens before the first await, so no upgrade, rejoin or tick
   * runs in between. Idempotent (`already`). 410 after the whistle (nothing to hand over). The last
   * human leaving shuts the match down before answering (`ended`): no deadlock with the waiting
   * matchmaker, its /release goes out through waitUntil and its input gate is open while it waits
   * for this answer (an outgoing fetch).
   */
  private async leave(request: Request): Promise<Response> {
    const body = await readJson<{ playerId?: unknown }>(request);
    if (!body || typeof body.playerId !== 'string') return error(400, 'bad_request');
    if (this.matchReset) return error(410, 'match_reset');
    const rec = this.record;
    if (!rec || this.shutDown) return error(404, 'no_match');
    if (this.ended) return error(410, 'match_over');
    const e = rec.roster.find((r) => r.kind === 'player' && r.playerId === body.playerId);
    if (!e) return error(404, 'not_in_match');
    const slot = e.slot;
    if (this.leftSlots[slot] === 1) return json({ ok: true, slot, closed: false, already: true, ended: false } satisfies MatchLeaveAnswer);
    this.leftSlots[slot] = 1;
    const c = this.clients[slot];
    const closed = c !== null && this.detach(c, 1000, 'left');
    if (rec.ranked) {
      const h = this.host;
      if (h === null || !h.isStarted) {
        // A dodge before the kickoff: nobody is rated, the quitter takes the abandon.
        await this.cancelRanked('dodge', [body.playerId]);
        return json({ ok: true, slot, closed, already: false, ended: true } satisfies MatchLeaveAnswer);
      }
      if (this.teamGone(e.team, Date.now(), true)) {
        this.forceEnd(e.team === 0 ? 1 : 0);
        void this.ctx.storage.put('left', this.leftList());
        return json({ ok: true, slot, closed, already: false, ended: true } satisfies MatchLeaveAnswer);
      }
    }
    if (!this.humansRemain(rec)) {
      // Nobody left to play for: end now (see the header), the capacity entry goes with the release.
      await this.shutdown('left');
      return json({ ok: true, slot, closed, already: false, ended: true } satisfies MatchLeaveAnswer);
    }
    // A host still being created applies leftSlots itself (ensureHost).
    const host = this.host;
    if (host !== null) host.convertToBot(slot);
    this.broadcast(encodeJson(MsgType.Event, { type: 'botTakeover', slot, tick: host !== null ? host.currentTick + 1 : 0 } satisfies MatchEvent), null);
    this.maybeStart(); // the others may all be ready now
    await this.ctx.storage.put('left', this.leftList());
    return json({ ok: true, slot, closed, already: false, ended: false } satisfies MatchLeaveAnswer);
  }

  /** Some 'player' slot of the roster has not left (connected or not). */
  private humansRemain(rec: MatchRecord): boolean {
    for (let i = 0; i < rec.roster.length; i++) if (rec.roster[i].kind === 'player' && this.leftSlots[i] === 0) return true;
    return false;
  }

  /** The left slots, ascending (the persisted 'left' row and /internal/status). */
  private leftList(): number[] {
    const out: number[] = [];
    for (let i = 0; i < MAX_CARS; i++) if (this.leftSlots[i] === 1) out.push(i);
    return out;
  }

  private status(): Response {
    // No roster: never created, or shut down (storage wiped). The matchmaker's lock check frees on 404.
    if (!this.record) return error(404, 'no_match');
    const h = this.host;
    return json({
      matchId: this.record?.matchId ?? null,
      mode: this.record?.mode ?? null,
      roster: this.record?.roster ?? [],
      started: h?.isStarted ?? false,
      tick: h?.currentTick ?? 0,
      phase: h?.phase ?? 'none',
      score: h?.score ?? null,
      liveSockets: this.liveSockets,
      left: this.leftList(),
      ended: this.ended,
      reset: this.matchReset,
      hostColo: this.hostColo,
      slotStats: h ? h.slotStats.slice(0, h.numCars) : [],
    });
  }

  // ---- WebSocket upgrade ------------------------------------------------------------------

  private async upgrade(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error(426, 'upgrade_required');
    if (this.matchReset) return error(410, 'match_reset');
    const rec = this.record;
    if (!rec || this.shutDown) return error(404, 'no_match');
    if (this.ended) return error(410, 'match_over');
    const h = request.headers;
    const playerId = h.get('x-player-id') ?? '';
    const slot = Number(h.get('x-slot'));
    const team = Number(h.get('x-team'));
    const jti = h.get('x-jti') ?? '';
    if (!Number.isInteger(slot) || slot < 0 || slot >= rec.roster.length) return error(403, 'bad_slot');
    const entry = rec.roster[slot];
    if (entry.kind !== 'player' || entry.playerId !== playerId || entry.team !== team) return error(403, 'not_your_slot');
    if (this.leftSlots[slot] === 1) return error(410, 'left', 'you left this match');
    if (!/^[0-9a-f]{32}$/.test(jti)) return error(403, 'bad_ticket');
    if (this.clients[slot] === null && this.liveSockets >= MAX_SOCKETS) return error(503, 'full');

    let host: RoomHost;
    let hostColo: string;
    try {
      // ensureHost also starts the colo trace (pre-warm: it normally finished long before the
      // first upgrade); waiting for both keeps the Welcome's hostColo final (5 s cap on the trace).
      const pending = this.ensureHost();
      [host, hostColo] = await Promise.all([pending, this.coloPromise ?? Promise.resolve(this.hostColo)]);
    } catch (e) {
      console.error('MatchDO: host init failed', e);
      return error(500, 'host_init_failed', String(e));
    }
    // ensureHost is an outgoing promise, not a storage op, so the input gate did not hold other
    // events (timers, other upgrades for this slot) while it was pending: re-check the room.
    if (this.matchReset) return error(410, 'match_reset');
    if (this.shutDown) return error(404, 'no_match');
    if (this.ended) return error(410, 'match_over');
    if (this.leftSlots[slot] === 1) return error(410, 'left', 'you left this match'); // a /internal/leave ran meanwhile
    if (this.clients[slot] === null && this.liveSockets >= MAX_SOCKETS) return error(503, 'full');
    // Single use of the ticket, checked last so a transient failure above does not burn it. The
    // storage ops hold the input gate: nothing else runs between the get, the put and the attach.
    if (await this.ctx.storage.get('jti:' + jti)) return error(403, 'ticket_used');
    await this.ctx.storage.put('jti:' + jti, true);
    const existing = this.clients[slot];
    if (existing !== null && existing.playerId !== playerId) return error(409, 'slot_taken');
    if (existing === null && this.liveSockets >= MAX_SOCKETS) return error(503, 'full');
    const replaced = existing !== null;
    if (existing !== null) this.detach(existing, CLOSE_REPLACED, 'replaced');

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    // workerd (this compatibility date) follows the WHATWG default binaryType 'blob'; the hot path
    // wants ArrayBuffers (a Blob would need an async read per frame).
    server.binaryType = 'arraybuffer';
    const now = Date.now();
    const c: Client = {
      ws: server,
      slot,
      playerId,
      name: entry.name,
      ready: false,
      attached: true,
      tokens: MSG_BURST,
      tokensAt: now,
      inputTokens: INPUT_BURST,
      inputTick: host.currentTick,
    };
    this.clients[slot] = c;
    this.liveSockets++;
    this.emptySince = -1;
    this.discSince[slot] = 0;
    host.setConnected(slot, true);
    server.addEventListener('message', (ev) => this.onMessage(c, ev));
    server.addEventListener('close', () => this.onClose(c));
    server.addEventListener('error', () => this.onClose(c));

    const welcome: Welcome = {
      protocol: PROTOCOL_VERSION,
      matchId: rec.matchId,
      mode: rec.mode,
      tickRate: TICK_RATE,
      carId: this.arena ? this.arena.carIds[slot] : 0,
      slot,
      // A slot whose player left is the host's bot now (the BOT tag on a rejoiner's scoreboard).
      roster: rec.roster.map((e, i) => ({ carId: this.arena ? this.arena.carIds[i] : 0, slot: e.slot, team: e.team, name: e.name, kind: this.leftSlots[i] === 1 ? 'bot' : e.kind })),
      tick: host.currentTick,
      matchLengthSeconds: rec.matchLengthSeconds,
      hostColo,
    };
    this.safeSend(c, encodeJson(MsgType.Welcome, welcome));
    // A reconnection replaces a socket that was still attached: the others never saw it leave.
    if (!replaced) this.broadcast(encodeJson(MsgType.Event, { type: 'playerJoined', slot, name: c.name } satisfies MatchEvent), c);

    // Ranked never starts short-handed: only maybeStart (every player ready) or the RANKED_JOIN_MS cancel.
    if (!host.isStarted && !this.startTimer && !rec.ranked) {
      this.startTimer = setTimeout(() => {
        this.startTimer = null;
        this.startLoop();
      }, START_GRACE_MS);
    }
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': WS_SUBPROTOCOL } });
  }

  private onMessage(c: Client, ev: MessageEvent): void {
    if (!c.attached || this.clients[c.slot] !== c) return;
    // Budget over every message type (each one is a billable request): refill by wall time, which
    // advances between I/O callbacks in workerd.
    const now = Date.now();
    const dt = now - c.tokensAt;
    let tokens = dt > 0 ? c.tokens + dt * MSG_REFILL_PER_MS : c.tokens;
    if (tokens > MSG_BURST) tokens = MSG_BURST;
    c.tokensAt = now;
    if (tokens < 1) {
      c.tokens = tokens;
      return this.kick(c, 1008, 'rate');
    }
    c.tokens = tokens - 1;
    const host = this.host;
    const data: unknown = ev.data;
    let buf: Uint8Array;
    if (data instanceof ArrayBuffer) buf = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) buf = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else return this.kick(c, 1008, 'binary frames only');
    if (buf.length === 0 || buf.length > MAX_FRAME_BYTES) return this.kick(c, 1008, 'frame size');
    switch (buf[0]) {
      case MsgType.Input: {
        if (!host) return;
        const t = host.currentTick;
        if (t !== c.inputTick) {
          let n = c.inputTokens + (t - c.inputTick);
          if (n > INPUT_BURST) n = INPUT_BURST;
          c.inputTokens = n;
          c.inputTick = t;
        }
        if (c.inputTokens < 1) return; // over budget for this stretch of ticks: dropped (the next packet resends the unacked ticks)
        c.inputTokens--;
        const pkt = this.inputPkt;
        if (!decodeInput(buf, pkt)) return this.kick(c, 1008, 'bad input');
        host.addInputs(c.slot, pkt.firstTick, pkt.count, pkt.packed, 0);
        return;
      }
      case MsgType.Ping: {
        if (buf.length < PING_LEN) return this.kick(c, 1008, 'bad ping');
        const len = encodePong(this.pongBuf, decodePing(buf), now, now, host ? host.currentTick : 0);
        this.safeSend(c, this.pongBuf.subarray(0, len));
        return;
      }
      case MsgType.Ready: {
        if (!c.ready) {
          c.ready = true;
          this.maybeStart();
        }
        return;
      }
      default:
        return this.kick(c, 1008, 'unknown message');
    }
  }

  private onClose(c: Client): void {
    if (!this.unlink(c)) return;
    this.discSince[c.slot] = Date.now();
    if (!this.shutDown) this.broadcast(encodeJson(MsgType.Event, { type: 'playerLeft', slot: c.slot } satisfies MatchEvent), null);
  }

  /**
   * Take `c` out of the room exactly once (liveSockets is decremented on this transition only, so
   * a socket replaced during a racing upgrade cannot leave a phantom count behind). Returns true
   * when `c` was still the slot's current socket (the slot is now empty).
   */
  private unlink(c: Client): boolean {
    if (!c.attached) return false;
    c.attached = false;
    this.liveSockets--;
    if (this.liveSockets === 0) this.emptySince = Date.now();
    if (this.clients[c.slot] !== c) return false;
    this.clients[c.slot] = null;
    this.host?.setConnected(c.slot, false);
    return true;
  }

  private detach(c: Client, code: number, reason: string): boolean {
    const wasCurrent = this.unlink(c);
    try {
      c.ws.close(code, reason);
    } catch {
      /* already closed */
    }
    return wasCurrent;
  }

  private kick(c: Client, code: number, reason: string): void {
    if (this.detach(c, code, reason) && !this.shutDown) {
      this.broadcast(encodeJson(MsgType.Event, { type: 'playerLeft', slot: c.slot } satisfies MatchEvent), null);
    }
  }

  private safeSend(c: Client, bytes: Uint8Array): void {
    try {
      c.ws.send(bytes);
    } catch {
      this.onClose(c);
    }
  }

  private broadcast(bytes: Uint8Array, except: Client | null): void {
    for (let i = 0; i < MAX_CARS; i++) {
      const c = this.clients[i];
      if (c && c !== except) this.safeSend(c, bytes);
    }
  }

  // ---- host / loop ------------------------------------------------------------------------

  /** Start the colo trace once per room (storage first); never rejects, never delays the host. */
  private resolveColo(): Promise<string> {
    if (this.coloPromise === null) {
      this.coloPromise =
        this.hostColo !== COLO_UNKNOWN
          ? Promise.resolve(this.hostColo)
          : traceColo().then((colo) => {
              this.hostColo = colo;
              if (colo !== COLO_UNKNOWN) this.ctx.storage.put('hostColo', colo).catch(() => undefined);
              return colo;
            });
    }
    return this.coloPromise;
  }

  private ensureHost(): Promise<RoomHost> {
    if (!this.hostPromise) {
      const rec = this.record;
      if (!rec) return Promise.reject(new Error('no roster'));
      void this.resolveColo();
      this.hostPromise = (async () => {
        const arena = await createHostArena(rec.roster, KICKOFF_SEED);
        this.arena = arena;
        const host = new RoomHost(arena.sim, rec.roster, {
          tickRate: TICK_RATE,
          snapshotEvery: SNAPSHOT_EVERY,
          inputBufferTarget: 2,
          inputBufferMax: 8,
          matchLengthSeconds: rec.matchLengthSeconds,
          kickoffSeed: KICKOFF_SEED,
        });
        // A leave that came while the arena was being built (or before an eviction, from storage).
        for (let s = 0; s < rec.roster.length; s++) if (this.leftSlots[s] === 1) host.convertToBot(s);
        this.outBuf = new Uint8Array(host.snapshotMaxBytes);
        this.host = host;
        return host;
      })();
    }
    return this.hostPromise;
  }

  private maybeStart(): void {
    const host = this.host;
    if (!host || host.isStarted || !this.record) return;
    if (this.liveSockets === 0) return; // nobody to play for (every human left): the 5 s start timer / the alarm decide
    for (let i = 0; i < MAX_CARS; i++) {
      const e = this.record.roster[i];
      if (!e || e.kind !== 'player' || this.leftSlots[i] === 1) continue;
      const c = this.clients[i];
      if (!c || !c.ready) return;
    }
    this.startLoop();
  }

  private startLoop(): void {
    const host = this.host;
    if (!host || host.isStarted || this.shutDown || this.ended) return;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    // 'started' without 'ended' after a restart means the match was lost (see the constructor).
    void this.ctx.storage.put('started', true);
    host.start();
    this.lastNow = Date.now();
    this.acc = 0;
    this.interval = setInterval(() => this.onInterval(), INTERVAL_MS);
  }

  private onInterval(): void {
    const host = this.host;
    if (!host || this.shutDown || this.ended) return;
    try {
      const now = Date.now();
      let dt = now - this.lastNow;
      this.lastNow = now;
      if (dt < 0) dt = 0;
      if (dt > 250) dt = 250;
      this.acc += dt;
      let n = Math.floor(this.acc / TICK_MS);
      if (n > MAX_TICKS_PER_CALLBACK) n = MAX_TICKS_PER_CALLBACK;
      this.acc -= n * TICK_MS;
      if (this.acc > TICK_MS * MAX_TICKS_PER_CALLBACK) this.acc = TICK_MS * MAX_TICKS_PER_CALLBACK;
      for (let i = 0; i < n; i++) {
        host.tick();
        if (host.snapshotDue) this.sendSnapshots(host);
        if (host.events.length > 0) this.flushEvents(host);
        if (host.ended) {
          this.onEnded();
          return;
        }
      }
      if (this.record?.ranked && now >= this.forfeitCheckAt) {
        this.forfeitCheckAt = now + FORFEIT_CHECK_MS;
        for (const team of [0, 1] as const) {
          if (this.teamGone(team, now, false)) {
            this.forceEnd(team === 0 ? 1 : 0);
            return;
          }
        }
      }
      if (this.liveSockets === 0) {
        if (this.emptySince < 0) this.emptySince = now;
        else if (now - this.emptySince >= EMPTY_SHUTDOWN_MS) void this.shutdown('empty');
      }
    } catch (e) {
      // A throw anywhere in the tick (sim, snapshot encoding, event flush) must not leave the loop
      // running with no way out: close the room.
      console.error('MatchDO: tick failed', e);
      void this.shutdown('tick_error');
    }
  }

  private sendSnapshots(host: RoomHost): void {
    host.prepareSnapshot();
    for (let i = 0; i < MAX_CARS; i++) {
      const c = this.clients[i];
      if (!c) continue;
      const len = host.snapshot(this.outBuf, i);
      this.safeSend(c, this.outBuf.subarray(0, len));
    }
  }

  private flushEvents(host: RoomHost): void {
    const n = host.takeEvents(this.eventScratch);
    for (let i = 0; i < n; i++) this.broadcast(encodeJson(MsgType.Event, this.eventScratch[i]), null);
    this.eventScratch.length = 0;
  }

  private onEnded(): void {
    if (this.ended) return;
    this.ended = true;
    void this.ctx.storage.put('ended', true);
    const host = this.host;
    if (host !== null) {
      const sc = host.score;
      this.reportRanked(sc.blue > sc.red ? 0 : sc.red > sc.blue ? 1 : -1);
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      void this.shutdown('ended');
    }, END_LINGER_MS);
  }

  /** The TTL caught a match still running (unlimited overtime): whistle, leader wins (-1 when tied). */
  private endByTtl(): void {
    const host = this.host;
    if (!host || !host.isStarted || this.ended) return;
    this.ended = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    const s = host.score;
    const winner: 0 | 1 | -1 = s.blue > s.red ? 0 : s.red > s.blue ? 1 : -1;
    try {
      this.sendSnapshots(host);
    } catch (e) {
      console.error('MatchDO: final snapshot failed', e);
    }
    this.broadcast(encodeJson(MsgType.Event, { type: 'ended', winner, blue: s.blue, red: s.red, tick: host.currentTick } satisfies MatchEvent), null);
    this.reportRanked(winner);
  }

  // ---- ranked -------------------------------------------------------------------------------

  /**
   * Every remaining (not left) human of `team` is gone: left, or (unless `leftOnly`) disconnected
   * for RANKED_DC_FORFEIT_MS. A team without humans at all (cannot happen in ranked) is never gone.
   */
  private teamGone(team: 0 | 1, now: number, leftOnly: boolean): boolean {
    const rec = this.record;
    if (!rec) return false;
    let humans = 0;
    for (let i = 0; i < rec.roster.length; i++) {
      const e = rec.roster[i];
      if (e.kind !== 'player' || e.team !== team) continue;
      humans++;
      if (this.leftSlots[i] === 1) continue;
      if (leftOnly) return false;
      if (this.clients[i] !== null) return false;
      const since = this.discSince[i];
      if (since === 0 || now - since < RANKED_DC_FORFEIT_MS) return false;
    }
    return humans > 0;
  }

  /** End a ranked match now with `winner` (a forfeit): whistle, final snapshot, report, then the usual linger + shutdown. */
  private forceEnd(winner: 0 | 1): void {
    const host = this.host;
    if (!host || !host.isStarted || this.ended) return;
    this.ended = true;
    void this.ctx.storage.put('ended', true);
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    const s = host.score;
    try {
      this.sendSnapshots(host);
    } catch (e) {
      console.error('MatchDO: final snapshot failed', e);
    }
    this.broadcast(encodeJson(MsgType.Event, { type: 'ended', winner, blue: s.blue, red: s.red, tick: host.currentTick, forfeit: true } satisfies MatchEvent), null);
    this.reportRanked(winner);
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      void this.shutdown('ended');
    }, END_LINGER_MS);
  }

  /** POST to AccountsDO with up to 3 attempts (5xx / network); runs under waitUntil. */
  private accountsPost(path: string, payload: unknown): Promise<void> {
    const env = this.env;
    return (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts-v1')).fetch('https://accounts' + path, {
            method: 'POST',
            headers: { [INTERNAL_HEADER]: await internalSecret(env.JWT_SECRET), 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          await res.body?.cancel();
          if (res.ok || res.status < 500) return;
        } catch (e) {
          console.error('MatchDO: accounts ' + path + ' failed', e);
        }
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    })();
  }

  /** The finished ranked match to AccountsDO (once): a player who left or is disconnected at the whistle is rated as a leaver. */
  private reportRanked(winner: 0 | 1 | -1): void {
    const rec = this.record;
    const host = this.host;
    if (!rec?.ranked || this.rankedReported || !host) return;
    this.rankedReported = true;
    const s = host.score;
    const players = rec.roster
      .filter((e) => e.kind === 'player' && e.playerId)
      .map((e) => ({ id: e.playerId as string, team: e.team, left: this.leftSlots[e.slot] === 1 || this.clients[e.slot] === null }));
    this.ctx.waitUntil(this.accountsPost('/ranked-result', { matchId: rec.matchId, playlist: rec.mode, region: rec.region, winner, blue: s.blue, red: s.red, players }));
  }

  /**
   * A ranked match that will not be played: nobody rated; `noShows` (default: every player not
   * connected and ready right now) get an abandon. The others are told (event 'cancelled') and the
   * match shuts down (locks released: they can queue again at once).
   */
  private async cancelRanked(reason: string, noShows?: string[]): Promise<void> {
    const rec = this.record;
    if (!rec?.ranked || this.rankedReported) return;
    this.rankedReported = true;
    const players = rec.roster.filter((e) => e.kind === 'player' && e.playerId).map((e) => e.playerId as string);
    // Nobody connected at all looks like our failure more than theirs: no abandon for anyone then.
    const absent = noShows ?? (this.liveSockets === 0 ? [] : rec.roster.filter((e) => e.kind === 'player' && e.playerId && !this.clients[e.slot]?.ready).map((e) => e.playerId as string));
    this.ctx.waitUntil(this.accountsPost('/ranked-cancel', { matchId: rec.matchId, playlist: rec.mode, region: rec.region, players, noShows: absent, reason }));
    this.broadcast(encodeJson(MsgType.Event, { type: 'cancelled', reason } satisfies MatchEvent), null);
    await this.shutdown('cancelled');
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.shutDown) return;
    this.shutDown = true;
    const r = this.record;
    if (r?.ranked && !this.rankedReported) {
      // Lost to a restart / error / an empty room: nobody is rated or penalised, the locks go.
      this.rankedReported = true;
      const players = r.roster.filter((e) => e.kind === 'player' && e.playerId).map((e) => e.playerId as string);
      this.ctx.waitUntil(this.accountsPost('/ranked-cancel', { matchId: r.matchId, playlist: r.mode, region: r.region, players, noShows: [], reason }));
    }
    if (this.interval) clearInterval(this.interval);
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    this.interval = null;
    this.startTimer = null;
    this.endTimer = null;
    for (let i = 0; i < MAX_CARS; i++) {
      const c = this.clients[i];
      if (c) this.detach(c, 1000, reason);
    }
    const rec = this.record;
    if (rec && this.env.JWT_SECRET) {
      const ids = rec.roster.filter((e) => e.kind === 'player' && e.playerId).map((e) => e.playerId as string);
      const release = (async () => {
        try {
          const secret = await internalSecret(this.env.JWT_SECRET);
          const mm = this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName('mm:' + rec.region));
          await mm.fetch('https://matchmaker/release', {
            method: 'POST',
            headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
            body: JSON.stringify({ matchId: rec.matchId, playerIds: ids }),
          });
        } catch (e) {
          console.error('MatchDO: release failed', e);
        }
      })();
      this.ctx.waitUntil(release);
    }
    this.record = null;
    this.host = null;
    this.hostPromise = null;
    this.arena = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

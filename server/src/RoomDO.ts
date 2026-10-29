/**
 * RoomDO: the signaling room of one peer-to-peer match (docs/online/PHASE2.md). It never simulates
 * anything: every peer runs the same wasm / bots / match flow and exchanges inputs over WebRTC; this
 * object only hands out the room config (seed, slots, ICE servers), relays WebRTC signals, agrees
 * the synchronised start and announces drops, so that every peer applies the same roster change
 * at the same tick. Hibernation API: a socket costs nothing while nobody talks (no timers; the
 * only alarm is the cleanup / TTL), and the per-socket facts live in the socket attachment so the
 * object can be evicted and woken by the next frame.
 *
 * Lifecycle
 *   create    POST /internal/create (matchmaker): roster (slots: peer / bot, names, playerIds, a peer's car), mode,
 *             seed (random uint32), region, createdAt, physics (a custom lobby's experimental rules,
 *             null = standard: checked strictly again, 400 bad_physics; with rules every peer slot
 *             must carry guest: false, else 403 account_required) -> storage; 'unused'
 *             cleanup in 90 s
 *   upgrade   GET /room/<id> forwarded by the Worker with the verified ticket claims in x-* headers
 *             + the internal header: slot check, a slot already `left` or dropped is refused (403
 *             'left': its lock may have been freed and the player seated elsewhere; a ticket
 *             outlives the join grace), single-use jti (storage), acceptWebSocket with tags
 *             [peerId, 'slot:<n>'] (a second socket for the same slot replaces the first: 4000
 *             'replaced'), RoomWelcome with STUN only (+ 'start' and the drops so far when the
 *             match already started), 'peerJoined' to the others. The slot is `joining` while
 *             its upgrade runs (in memory: the no-show pass skips it) and the gone check runs
 *             again before the accept.
 *             A verified ticket of the slot reaching the room marks it `arrived` (persisted): the
 *             player showed up, so it is never named a no-show; one that arrives after its slot was
 *             given up (a slow join past the grace: 403 'left') also asks the matchmaker to take
 *             back the strike it may already have counted for this room (POST /forgive)
 *   messages  signal -> relayed to the target slot (when it has no socket the sender gets
 *             'error' { code: 'signal_dropped', to } and re-offers on its 'peerJoined'); ready
 *             { physicsFp } -> the fingerprint of the peer's arena mutators must be the room
 *             rules' (physicsFingerprint: required with experimental rules, checked when present
 *             with standard ones), else 'error' physics_mismatch and the socket is closed (the slot
 *             is left like any closed one: the others start without it, its car the team AI); once
 *             every connected peer is ready, >= 2 are connected and NO peer slot is still absent
 *             without being `left` (a ticket in flight: a staggered joiner must not be dropped at
 *             tick 0 by the first two humans): 'start' { startAt: now + 1.5 s } to all, then 'drop'
 *             { slot, atTick: 0 } for every peer slot without a socket (its car is the team AI from
 *             tick 0 on every peer); the same decision is re-run whenever a socket goes away before
 *             the start (an unready peer leaving must not strand the ready ones) and when the
 *             no-show grace passes; no-show: a slot that has not connected NO_SHOW_MS after create
 *             is declared left (alarm): 'peerLeft' { slot, peerId: '' } to the others, which then
 *             start without it (its ticket is refused from then on); ping -> pong;
 *             turn -> { type: 'turn', iceServers } (cost-2): TURN credentials minted for this
 *             seat on demand (its mesh did not connect), never in the welcome: only with the TURN
 *             secrets set and turn_cf_disabled off, at most TURN_PER_SLOT per seat and
 *             TURN_PER_PLAYER_PER_DAY per player (the region's matchmaker, POST /turn-quota: no
 *             answer = no), ttl = the room's remaining life; kept in the state and revoked when the
 *             seat's socket goes and at the cleanup; refused = { iceServers: [] };
 *             unreachable { slot, atTick } (atTick = the first tick the
 *             reporter has no input of that slot for; ignored before the start: a dead link is then
 *             the client's own fallback) -> 'drop' { slot, atTick: min(reported) } when a majority
 *             of the other live peers reported that slot, or when its own socket closed > 5 s ago
 *             (re-checked by an alarm). With one other live peer (1v1, two humans and bots) a lone
 *             report does not drop a target whose own room socket is open and talking (a message
 *             within TARGET_SILENT_MS): the room cannot tell which side broke the link, so the
 *             reporter cannot pick who leaves. When the target reports the reporter as well (a dead
 *             link both ways, both sockets alive) both are dropped, each at its reported tick; a
 *             target that goes quiet is dropped by the alarm re-check. A reporter's repeated report
 *             only ever lowers its tick, and a report that changes nothing writes nothing; at most
 *             REPORT_BURST reports that change something per socket (one more every
 *             REPORT_REFILL_MS), the rest are ignored; hashReport -> kept in memory for
 *             /internal/status
 *   close     'peerLeft' to the others; the player's matchmaker lock is released at once (the lock
 *             lives as long as the signaling socket: a peer that leaves, reloads or falls back to a
 *             Durable Object match can queue again immediately; it cannot rejoin this room: a P2P
 *             match has no authority to resync from in this phase); the slot is `left` for good
 *             in later welcomes (a ticket is single use); no socket for 60 s -> cleanup
 *   presence  GET /internal/presence?playerId= (matchmaker): whether that player's slot has a live
 *             socket / ever had one / left / was dropped, so a stale lock is verified before a
 *             queue is refused with 409
 *   leave     POST /internal/leave { playerId } (matchmaker, from POST /api/leave): the slot's
 *             socket is closed (1000 'left') -> the close path above; a slot that never connected
 *             is marked left and announced ('peerLeft' with an empty peerId) so the others stop
 *             waiting for it; the answer's `noShow` tells whether the player never showed up (no
 *             socket, no ticket ever reached the room: the matchmaker counts a strike)
 *   cleanup   sockets closed (1000), the TURN credentials minted for the room revoked, locks +
 *             capacity released at the region matchmaker (the
 *             players that never showed up are named in `noShow`, so the matchmaker can back off
 *             repeat no-shows), storage wiped; hard TTL 20 min after create (alarm); a room that has
 *             not started NOT_READY_MS after its last peer joined (sockets open, nobody ready: a
 *             client falls back after FALLBACK_MS = 10 s) is cleaned up then ('not_ready', rt-3)
 *
 * Experimental rules (RoomRecord.physics): the welcome of EVERY socket carries them (first, late
 * and replacement sockets: null = standard), every peer builds its arena with them, and the
 * 'ready' fingerprint makes a peer that runs other physics impossible to miss (the state hash does
 * not cover the config). Such a room counts for nothing: it never names a no-show to the
 * matchmaker (release, /internal/leave, /forgive), which marks its locks too; nothing reports a
 * P2P result anywhere.
 *
 * Guards: JSON text frames only (binary ignored), <= 16 KB (1009), a token bucket of 60 messages/s
 * (burst 400: a 3v3 mesh setup trickles 5 offers / answers plus the host / srflx / relay
 * candidates of 5 connections in its first second) per socket (1008 'rate'), malformed JSON ->
 * 1008, unknown types ignored. Every message is a billable Durable Object request; the clients
 * ping every 15 s and report hashes every 10 s (or on a disagreement) once the match runs, so the
 * object mostly hibernates during a match.
 *
 * setWebSocketAutoResponse is not used: the client's ping carries t0 and expects the server clock
 * in the pong (clock offset for startAt), which a static auto-response cannot produce.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { TURN_MIN_TTL_SECONDS, TURN_PER_SLOT, error, iceServersFor, isMode, json, readJson, revokeTurnCredential, stunOnly, turnConfigured, turnUsernames } from './env';
import type { GameModeId } from './env';
import { INTERNAL_HEADER, checkInternal, internalSecret, randomHex } from './auth';
import { TICK_RATE, WS_SUBPROTOCOL } from '../../src/net/protocol';
import { MAX_CARS } from '../../src/sim/types';
import { DEFAULT_MATCH_SECONDS } from '../../src/game/Match';
import { parseLobbyRules } from '../../src/game/physicsRules';
import type { RulesSnapshot } from '../../src/game/physicsRules';
import { physicsFingerprint } from '../../src/sim/mutators';
import { seatCar } from '../../src/net/cosmetics';
import type { CarId } from '../../src/game/cosmetics';
// Type-only: node's strip-only loader cannot load that module's `const enum` and
// server/test/room.test.mjs imports this file. The numeric defaults are mirrored below and checked
// against the protocol's literal types by tsc.
import type { P2P_ERROR_RELOAD, P2P_HASH_EVERY, P2P_INPUT_DELAY_DEFAULT, P2P_NO_SHOW_MS, P2P_PROTOCOL_VERSION, P2P_WINDOW_DEFAULT, ROOM_ERROR_PHYSICS_MISMATCH, ROOM_ERROR_SIGNAL_DROPPED, RoomServerMessage, RoomSlot, RoomWelcome, SignalData } from '../../src/net/p2p/protocol';

/** Mirrors protocol.ts P2P_PROTOCOL_VERSION (the welcome's `protocol`; the Worker's queue gate checks the client's against it). */
export const ROOM_PROTOCOL: typeof P2P_PROTOCOL_VERSION = 5;
/** Mirrors protocol.ts P2P_ERROR_RELOAD: the error code of a stale page (another P2P protocol). */
export const RELOAD_REQUIRED: typeof P2P_ERROR_RELOAD = 'reload_required';
/** Mirrors protocol.ts P2P_NO_SHOW_MS: a peer slot not connected this long after create is declared left. */
export const NO_SHOW_MS: typeof P2P_NO_SHOW_MS = 6_000;
/** Mirrors protocol.ts ROOM_ERROR_SIGNAL_DROPPED (type-only import above; checked by tsc). */
export const SIGNAL_DROPPED: typeof ROOM_ERROR_SIGNAL_DROPPED = 'signal_dropped';
/** Mirrors protocol.ts ROOM_ERROR_PHYSICS_MISMATCH: a 'ready' whose physicsFp is not the room rules'. */
export const PHYSICS_MISMATCH: typeof ROOM_ERROR_PHYSICS_MISMATCH = 'physics_mismatch';
/** The close code of a socket refused for its physics (after the 'error' frame). */
export const CLOSE_PHYSICS_MISMATCH = 4005;
const INPUT_DELAY: typeof P2P_INPUT_DELAY_DEFAULT = 3;
const WINDOW: typeof P2P_WINDOW_DEFAULT = 16;
const HASH_EVERY: typeof P2P_HASH_EVERY = 30;

/** JSON frames above this are refused (an SDP offer is ~4-8 KB). */
export const MAX_FRAME_CHARS = 16 * 1024;
export const MSG_BURST = 400;
const MSG_REFILL_PER_MS = 60 / 1000;
/** 'start' points this far into the future (server clock) so every peer can schedule tick 0. */
export const START_DELAY_MS = 1_500;
export const MIN_HUMANS = 2;
/**
 * Ticks added to the drop tick. Zero: the peers report contiguousInputTick + 1 and the room takes
 * the minimum, the one tick every reporter can confirm without guessing an input of the dead
 * peer; a peer that had confirmed further rewinds to it (RollbackEngine.drop). Any lead would put
 * hold-last ticks between the last known input and the drop on the peers that got less.
 */
export const DROP_LEAD_TICKS = 0;
/** A slot whose socket closed this long ago is dropped on the first unreachable report. */
export const CLOSE_GRACE_MS = 5_000;
/**
 * A target whose room socket sent nothing for this long counts as silent (the clients ping every
 * 15 s and report hashes every 10 s during a match): one report then drops it (rt-4).
 */
export const TARGET_SILENT_MS = 35_000;
/** 'unreachable' reports that change the room's state, per socket: a burst, then one per REPORT_REFILL_MS (rt-m2). */
export const REPORT_BURST = 8;
export const REPORT_REFILL_MS = 2_000;
/** Cleanup after the last socket closed / after create with no socket at all (tickets last 90 s). */
export const EMPTY_MS = 60_000;
export const UNUSED_MS = 90_000;
/** Hard TTL from create; the matchmaker's lock for a p2p room is a little longer than this. */
export const ROOM_TTL_MS = 20 * 60_000;
/** A room not started this long after its last peer joined is cleaned up (its locks and capacity freed). */
export const NOT_READY_MS = 60_000;
const ALARM_SLACK_MS = 250;
const CLOSE_REPLACED = 4000;
const WS_OPEN = 1;

export interface RoomSlotRecord {
  slot: number;
  team: 0 | 1;
  kind: 'peer' | 'bot';
  name: string;
  playerId?: string;
  /** A peer seat's car (the matchmaker's roster; absent = the default car): every welcome and 'peerJoined' carries it. */
  car?: CarId;
}

export interface RoomRecord {
  roomId: string;
  mode: GameModeId;
  region: string;
  /** Kickoff deal and bot RNG on every peer (rs_reset_kickoff(seed), BotTeam seed). */
  seed: number;
  slots: RoomSlotRecord[];
  matchLengthSeconds: number;
  createdAt: number;
  /** A custom lobby's experimental rules (null = standard; absent in records of older builds). */
  physics?: RulesSnapshot | null;
}

export interface UnreachableReport {
  /** The slot reported dead. */
  slot: number;
  /** The reporting slot. */
  from: number;
  atTick: number;
}

/** Mutable room state, one storage key ('state'); small (<= 8 slots). */
interface RoomState {
  startAt: number | null;
  dropped: Array<{ slot: number; atTick: number }>;
  /** Generation of each slot's current socket, 0 = none (a replaced / stale socket has an older gen). */
  cur: number[];
  /** When the slot's last current socket closed (0 = never had one, or connected now). */
  closedAt: number[];
  /** The slot is gone for good: its socket closed, or the player left through the matchmaker before connecting. */
  left: boolean[];
  /**
   * A verified ticket of the slot reached the room (an upgrade got past the ownership checks: accepted,
   * waiting for TURN, or refused because the slot was already given up). Never a no-show strike.
   */
  arrived: boolean[];
  reports: UnreachableReport[];
  emptyAt: number | null;
  dropCheckAt: number | null;
  /** The no-show pass (NO_SHOW_MS after create) ran: its alarm is not re-armed. */
  noShowDone: boolean;
  nextGen: number;
  /** When the last socket was admitted (null: none yet): the NOT_READY_MS cleanup of a room that never starts. */
  lastJoinAt: number | null;
  /** TURN credentials minted for the seats (their usernames): revoked when the seat goes and at the cleanup. */
  turn: Array<{ slot: number; user: string }>;
}

/** What GET /internal/presence answers the matchmaker (RoomDO.presence). */
export interface PresenceInfo {
  roomId: string;
  slot: number;
  /** A live socket on the slot right now. */
  connected: boolean;
  /** The slot had a socket at some point (a ticket was used). */
  everConnected: boolean;
  left: boolean;
  dropped: boolean;
  started: boolean;
}

/** What POST /internal/leave answers the matchmaker (RoomDO.leave). */
export interface RoomLeaveAnswer {
  ok: true;
  slot: number;
  /** A live socket was closed. */
  closed: boolean;
  /** The slot had a socket at some point. */
  everConnected: boolean;
  /** The player never showed up: no socket and no ticket of it ever reached the room (a strike). */
  noShow: boolean;
}

/** Per-socket facts, kept in the socket attachment (survives hibernation). */
interface Attachment {
  slot: number;
  gen: number;
  peerId: string;
  playerId: string;
  ready: boolean;
  /** The last message of this socket (ms; refreshed in the attachment every SEEN_EVERY_MS): the target liveness of decideDrop. */
  seenAt?: number;
}

/** How stale the attachment's seenAt may get before a message rewrites it. */
const SEEN_EVERY_MS = 5_000;

interface HashReport {
  tick: number;
  hash: number;
  agree: number;
  disagree: number;
  at: number;
}

interface CreateBody {
  roomId?: unknown;
  mode?: unknown;
  region?: unknown;
  seed?: unknown;
  slots?: unknown;
  matchLengthSeconds?: unknown;
  createdAt?: unknown;
  physics?: unknown;
}

// ---- pure decisions (unit-tested in server/test/room.test.mjs) ----------------------------------

/** The room's experimental rules (null = standard physics). */
export function roomPhysics(rec: RoomRecord): RulesSnapshot | null {
  return rec.physics ?? null;
}

/**
 * A 'ready' frame's `physicsFp` against the room's rules: true when the peer may start. With
 * experimental rules the fingerprint is required and must be theirs; with standard physics one
 * that is present must be the stock fingerprint (a peer that runs a preset in a standard room is
 * refused as well), and a missing one is let through (headless tools).
 */
export function physicsReady(rules: RulesSnapshot | null, physicsFp: unknown): boolean {
  if (physicsFp === undefined && rules === null) return true;
  return typeof physicsFp === 'number' && physicsFp === physicsFingerprint(rules);
}

/** Smallest count that is more than half of `n` (1 for n = 1, 2 for n = 2 or 3, 3 for 4 or 5, ...). */
export function majorityOf(n: number): number {
  return (n >> 1) + 1;
}

export interface StartPeer {
  connected: boolean;
  ready: boolean;
  /** Gone for good (socket closed, left through the matchmaker, no-show): not waited for. Absent = false. */
  left?: boolean;
}

/**
 * Start when at least `minHumans` peers are connected, every connected peer is ready and no peer
 * slot is still absent without being `left` (its ticket may be in flight: starting would drop it at
 * tick 0 the moment it joins; the room declares it a no-show after NO_SHOW_MS instead).
 */
export function decideStart(peers: ReadonlyArray<StartPeer>, minHumans: number = MIN_HUMANS): boolean {
  let connected = 0;
  for (const p of peers) {
    if (!p.connected) {
      if (p.left !== true) return false;
      continue;
    }
    if (!p.ready) return false;
    connected++;
  }
  return connected >= minHumans;
}

export interface DropQuery {
  target: number;
  reports: readonly UnreachableReport[];
  /** Slots of the other live peers (not the target, not dropped): the voters. */
  others: readonly number[];
  /** Milliseconds since the target's own socket closed; null while it is connected or never was. */
  closedAgoMs: number | null;
  /** The target's own room socket is open and talking (TARGET_SILENT_MS): a lone vote is not enough then. Absent = false. */
  targetLive?: boolean;
  closeGraceMs?: number;
  leadTicks?: number;
}

/**
 * Drop `target` when a majority of `others` reported it unreachable (any single report when the
 * target's socket has been closed for more than the grace), at min(reported atTick) + lead (lead
 * 0: see DROP_LEAD_TICKS). Reports from slots outside `others` (dropped peers, the target itself,
 * bots) do not count. A single vote never drops a target that is `targetLive` (its room socket open
 * and talking): with one other peer that vote is the whole majority, and the reporter would choose
 * who leaves the match (rt-4; mutualDrop handles a link dead both ways).
 */
export function decideDrop(q: DropQuery): { atTick: number } | null {
  const grace = q.closeGraceMs ?? CLOSE_GRACE_MS;
  const lead = q.leadTicks ?? DROP_LEAD_TICKS;
  let votes = 0;
  let minTick = 0x7fffffff;
  for (const r of q.reports) {
    if (r.slot !== q.target || !q.others.includes(r.from)) continue;
    votes++;
    if (r.atTick < minTick) minTick = r.atTick;
  }
  if (votes === 0) return null;
  if (q.closedAgoMs !== null && q.closedAgoMs > grace) return { atTick: minTick + lead };
  if (votes >= majorityOf(q.others.length) && !(votes < 2 && q.targetLive === true)) return { atTick: minTick + lead };
  return null;
}

/**
 * Two live peers that each reported the other (the link between them is dead both ways and both
 * room sockets are alive): the ticks to drop each of them at (min reported + lead), or null. Pure.
 */
export function mutualDrop(reports: readonly UnreachableReport[], a: number, b: number, leadTicks: number = DROP_LEAD_TICKS): { a: number; b: number } | null {
  let aTick = -1;
  let bTick = -1;
  for (const r of reports) {
    if (r.slot === a && r.from === b && (aTick < 0 || r.atTick < aTick)) aTick = r.atTick;
    if (r.slot === b && r.from === a && (bTick < 0 || r.atTick < bTick)) bTick = r.atTick;
  }
  return aTick >= 0 && bTick >= 0 ? { a: aTick + leadTicks, b: bTick + leadTicks } : null;
}

function freshState(): RoomState {
  return {
    startAt: null,
    dropped: [],
    cur: new Array<number>(MAX_CARS).fill(0),
    closedAt: new Array<number>(MAX_CARS).fill(0),
    left: new Array<boolean>(MAX_CARS).fill(false),
    arrived: new Array<boolean>(MAX_CARS).fill(false),
    reports: [],
    emptyAt: null,
    dropCheckAt: null,
    noShowDone: false,
    nextGen: 0,
    lastJoinAt: null,
    turn: [],
  };
}

/** A state persisted by an older build may lack newer fields. */
function upgradeState(st: RoomState): RoomState {
  if (!Array.isArray(st.left) || st.left.length !== MAX_CARS) st.left = new Array<boolean>(MAX_CARS).fill(false);
  if (!Array.isArray(st.arrived) || st.arrived.length !== MAX_CARS) st.arrived = new Array<boolean>(MAX_CARS).fill(false);
  if (typeof st.noShowDone !== 'boolean') st.noShowDone = false;
  if (typeof st.lastJoinAt !== 'number') st.lastJoinAt = null;
  if (!Array.isArray(st.turn)) st.turn = [];
  return st;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isSignalData(v: unknown): v is SignalData {
  return isRecord(v) && ('sdp' in v || 'candidate' in v);
}

function isUint32(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
}

export class RoomDO extends DurableObject<Env> {
  private record: RoomRecord | null = null;
  private state: RoomState = freshState();
  private readonly loaded: Promise<void>;
  /** The current socket of each slot (rebuilt from ctx.getWebSockets() after a wake-up). */
  private readonly live: Array<WebSocket | null> = new Array<WebSocket | null>(MAX_CARS).fill(null);
  private readonly atts = new WeakMap<WebSocket, Attachment>();
  private readonly buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();
  /** The 'unreachable' budget per socket (REPORT_BURST, REPORT_REFILL_MS). */
  private readonly reportBuckets = new WeakMap<WebSocket, { tokens: number; at: number }>();
  private readonly hashes = new Map<number, HashReport>();
  /**
   * Upgrades of each slot past the ownership checks and not finished yet (in memory: a request in
   * flight keeps the object alive). The TURN fetch opens the input gate for up to 3 s; meanwhile the
   * no-show pass skips the slot, so a player that reached the room within the grace is waited for.
   */
  private readonly joining = new Uint8Array(MAX_CARS);
  /** A 'turn' request of the slot is being served (its mint is an outgoing fetch): a second one waits for nothing. */
  private readonly turnBusy = new Uint8Array(MAX_CARS);
  private cleaned = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      const rec = await ctx.storage.get<RoomRecord>('record');
      if (rec) this.record = rec;
      const st = await ctx.storage.get<RoomState>('state');
      if (st) this.state = upgradeState(st);
      if (rec && this.reconcileSockets(Date.now())) {
        // Sockets vanished while hibernated: the ready ones may now be the whole room.
        if (this.state.startAt === null) await this.maybeStart(Date.now());
        await this.persist();
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.loaded;
    if (!this.env.JWT_SECRET) return error(500, 'no_secret', 'JWT_SECRET is not configured');
    if (!(await checkInternal(this.env.JWT_SECRET, request))) return error(403, 'forbidden');
    const url = new URL(request.url);
    if (url.pathname === '/room' || url.pathname.startsWith('/room/')) return this.upgrade(request);
    if (request.method === 'POST' && url.pathname === '/internal/create') return this.create(request);
    if (request.method === 'GET' && url.pathname === '/internal/status') return this.status();
    if (request.method === 'GET' && url.pathname === '/internal/presence') return this.presence(url.searchParams.get('playerId') ?? '');
    if (request.method === 'POST' && url.pathname === '/internal/leave') return this.leave(request);
    return error(404, 'not_found');
  }

  override async alarm(): Promise<void> {
    await this.loaded;
    const rec = this.record;
    if (!rec || this.cleaned) return;
    const now = Date.now();
    if (now >= rec.createdAt + ROOM_TTL_MS - ALARM_SLACK_MS) {
      await this.cleanup('ttl');
      return;
    }
    const st = this.state;
    if (st.startAt === null && st.lastJoinAt !== null && now >= st.lastJoinAt + NOT_READY_MS - ALARM_SLACK_MS) {
      // Sockets open, nobody starting: a client gives the mesh FALLBACK_MS and leaves; whatever is
      // still here holds a room (and locks) for nothing.
      await this.cleanup('not_ready');
      return;
    }
    if (!st.noShowDone && now >= rec.createdAt + NO_SHOW_MS - ALARM_SLACK_MS) {
      // The join grace is over: whoever has not connected is not coming (its ticket is refused
      // from now on); the peers waiting for it stop waiting and the start is re-evaluated.
      st.noShowDone = true;
      this.markNoShows();
      if (st.startAt === null) await this.maybeStart(now);
    }
    if (st.dropCheckAt !== null && now >= st.dropCheckAt - ALARM_SLACK_MS) {
      st.dropCheckAt = null;
      const targets = new Set<number>();
      for (const r of st.reports) targets.add(r.slot);
      for (const t of targets) this.evaluateDrop(t, now);
    }
    if (st.emptyAt !== null && now >= st.emptyAt - ALARM_SLACK_MS) {
      if (this.connectedCount() === 0) {
        await this.cleanup('empty');
        return;
      }
      st.emptyAt = null;
    }
    await this.persist();
    await this.rearm();
  }

  // ---- Hibernation API handlers -----------------------------------------------------------

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.loaded;
    if (this.cleaned || !this.record) return;
    const att = this.attOf(ws);
    if (!att || this.state.cur[att.slot] !== att.gen) return; // replaced / stale socket
    const now = Date.now();
    if (!this.takeToken(ws, now)) return this.kick(ws, 1008, 'rate', now);
    // Talking: the drop vote sees this socket alive (kept in the attachment across hibernation).
    if (att.seenAt === undefined || now - att.seenAt >= SEEN_EVERY_MS) {
      att.seenAt = now;
      ws.serializeAttachment(att);
    }
    if (typeof message !== 'string') return; // the signaling protocol is JSON text; binary is ignored
    if (message.length > MAX_FRAME_CHARS) return this.kick(ws, 1009, 'frame size', now);
    let msg: unknown;
    try {
      msg = JSON.parse(message);
    } catch {
      return this.kick(ws, 1008, 'bad json', now);
    }
    if (!isRecord(msg) || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'signal': {
        const to = msg.to;
        if (!isUint32(to) || to >= this.record.slots.length || to === att.slot || !isSignalData(msg.data)) return;
        const target = this.live[to];
        if (target === null) {
          // Nobody there yet (a staggered join): tell the sender, which re-offers on 'peerJoined'.
          this.send(ws, { type: 'error', code: SIGNAL_DROPPED, message: `slot ${to} has no socket`, to });
          return;
        }
        this.send(target, { type: 'signal', from: att.slot, data: msg.data });
        return;
      }
      case 'ready': {
        if (att.ready) return;
        if (!physicsReady(roomPhysics(this.record), msg.physicsFp)) {
          // This peer's arena does not run the room's rules (a modified page, an apply bug): it must
          // not start, or the room would desync forever. Its slot is left like a closed one.
          this.send(ws, { type: 'error', code: PHYSICS_MISMATCH, message: 'your arena does not run this room\'s rules: reload the page' });
          await this.kick(ws, CLOSE_PHYSICS_MISMATCH, PHYSICS_MISMATCH, now);
          return;
        }
        att.ready = true;
        ws.serializeAttachment(att);
        await this.maybeStart(now);
        return;
      }
      case 'ping': {
        this.send(ws, { type: 'pong', t0: typeof msg.t0 === 'number' ? msg.t0 : 0, now });
        return;
      }
      case 'unreachable': {
        if (!isUint32(msg.slot) || !isUint32(msg.atTick)) return;
        await this.onUnreachable(ws, att.slot, msg.slot, msg.atTick, now);
        return;
      }
      case 'turn': {
        await this.onTurn(ws, att);
        return;
      }
      case 'hashReport': {
        if (!isUint32(msg.tick) || !isUint32(msg.hash)) return;
        const agree = isUint32(msg.agree) ? msg.agree : 0;
        const disagree = isUint32(msg.disagree) ? msg.disagree : 0;
        this.hashes.set(att.slot, { tick: msg.tick, hash: msg.hash, agree, disagree, at: now });
        return;
      }
      default:
        return; // unknown types are ignored (forward compatibility)
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    await this.loaded;
    // The peer sent its close frame; the runtime does not answer it by itself: complete the
    // handshake (otherwise the client hangs waiting for our frame). Harmless when already closed.
    try {
      ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, reason.slice(0, 120));
    } catch {
      /* already closed */
    }
    await this.onSocketGone(ws, Date.now());
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.loaded;
    await this.onSocketGone(ws, Date.now());
  }

  // ---- internal endpoints -----------------------------------------------------------------

  private async create(request: Request): Promise<Response> {
    if (this.record) return error(409, 'exists');
    const body = await readJson<CreateBody>(request);
    if (!body || typeof body.roomId !== 'string' || !isMode(body.mode) || !Array.isArray(body.slots) || body.slots.length < 2 || body.slots.length > MAX_CARS) {
      return error(400, 'bad_request');
    }
    const slots: RoomSlotRecord[] = [];
    let peers = 0;
    let guests = 0;
    for (let i = 0; i < body.slots.length; i++) {
      const e: unknown = body.slots[i];
      if (!isRecord(e) || e.slot !== i || (e.team !== 0 && e.team !== 1) || (e.kind !== 'peer' && e.kind !== 'bot') || typeof e.name !== 'string') return error(400, 'bad_roster');
      if (e.kind === 'peer') {
        if (typeof e.playerId !== 'string') return error(400, 'bad_roster');
        peers++;
        // Only a room with experimental rules reads it: a seat is signed in when it says guest: false.
        if (e.guest !== false) guests++;
        // A car the catalog does not know is dropped (the default car), never refused.
        const car = seatCar(e.car);
        slots.push({ slot: i, team: e.team, kind: 'peer', name: e.name, playerId: e.playerId, ...(car !== undefined ? { car } : {}) });
      } else {
        slots.push({ slot: i, team: e.team, kind: 'bot', name: e.name });
      }
    }
    if (peers < MIN_HUMANS) return error(400, 'bad_roster', `a p2p room needs >= ${MIN_HUMANS} peers`);
    // A custom lobby's rules, checked again as strictly (the matchmaker did, LobbyDO did).
    const physics = parseLobbyRules(body.physics);
    if (physics === 'bad') return error(400, 'bad_physics', 'invalid experimental rules');
    // ... and signed-in players only: every peer seat must say guest: false (the matchmaker's flag).
    if (physics !== null && guests > 0) return error(403, 'account_required', 'experimental rules are for signed-in players only');
    const now = Date.now();
    const rec: RoomRecord = {
      roomId: body.roomId,
      mode: body.mode,
      region: typeof body.region === 'string' ? body.region : '?',
      seed: isUint32(body.seed) ? body.seed : crypto.getRandomValues(new Uint32Array(1))[0],
      slots,
      matchLengthSeconds: typeof body.matchLengthSeconds === 'number' && body.matchLengthSeconds >= 0 ? Math.floor(body.matchLengthSeconds) : DEFAULT_MATCH_SECONDS,
      createdAt: typeof body.createdAt === 'number' ? body.createdAt : now,
      physics,
    };
    this.record = rec;
    this.state = freshState();
    this.state.emptyAt = now + UNUSED_MS;
    await this.ctx.storage.put('record', rec);
    await this.persist();
    await this.rearm();
    return json({ ok: true, roomId: rec.roomId, seed: rec.seed });
  }

  /** GET /internal/presence?playerId= (the matchmaker verifying a lock): 404 when the room is gone or the player is not in it. */
  private presence(playerId: string): Response {
    const rec = this.record;
    if (!rec || this.cleaned) return error(404, 'no_room');
    const entry = rec.slots.find((s) => s.kind === 'peer' && s.playerId === playerId);
    if (!entry || playerId.length === 0) return error(404, 'not_member');
    const st = this.state;
    const slot = entry.slot;
    const out: PresenceInfo = {
      roomId: rec.roomId,
      slot,
      connected: this.live[slot] !== null,
      everConnected: st.cur[slot] !== 0 || st.closedAt[slot] > 0,
      left: st.left[slot],
      dropped: this.isDropped(slot),
      started: st.startAt !== null,
    };
    return json(out);
  }

  /**
   * POST /internal/leave { playerId } (the matchmaker, for POST /api/leave): the player is out of
   * this room. A live socket is closed (1000 'left'), which runs the usual close path (peerLeft,
   * lock release, start re-evaluation); a slot that never connected is marked left and announced,
   * so the peers waiting for it stop waiting. Idempotent.
   */
  private async leave(request: Request): Promise<Response> {
    const rec = this.record;
    if (!rec || this.cleaned) return error(404, 'no_room');
    const body = await readJson<{ playerId?: unknown }>(request);
    if (!body || typeof body.playerId !== 'string') return error(400, 'bad_request');
    const entry = rec.slots.find((s) => s.kind === 'peer' && s.playerId === body.playerId);
    if (!entry) return error(404, 'not_member');
    const slot = entry.slot;
    const now = Date.now();
    const ws = this.live[slot];
    if (ws !== null) {
      await this.kick(ws, 1000, 'left', now);
      const kicked: RoomLeaveAnswer = { ok: true, slot, closed: true, everConnected: true, noShow: false };
      return json(kicked);
    }
    const st = this.state;
    const everConnected = st.closedAt[slot] > 0;
    if (!st.left[slot] && !this.isDropped(slot)) {
      // An upgrade of this slot waiting for TURN is refused when it resumes (gone check).
      st.left[slot] = true;
      this.broadcast({ type: 'peerLeft', slot, peerId: '' }, null);
      if (st.startAt === null) await this.maybeStart(now);
      await this.persist();
    }
    // `noShow` true: the player never opened its socket nor presented its ticket (the matchmaker
    // counts a strike); never in a room with experimental rules (it counts for nothing).
    const out: RoomLeaveAnswer = { ok: true, slot, closed: false, everConnected, noShow: roomPhysics(rec) === null && this.isNoShow(slot) };
    return json(out);
  }

  private status(): Response {
    const rec = this.record;
    const hashes: Record<string, HashReport> = {};
    for (const [slot, h] of this.hashes) hashes[String(slot)] = h;
    return json({
      roomId: rec?.roomId ?? null,
      mode: rec?.mode ?? null,
      seed: rec?.seed ?? null,
      region: rec?.region ?? null,
      createdAt: rec?.createdAt ?? null,
      physics: rec ? roomPhysics(rec) : null,
      slots: rec ? this.roomSlots() : [],
      connected: this.connectedCount(),
      startAt: this.state.startAt,
      dropped: this.state.dropped,
      reports: this.state.reports,
      hashes,
      cleaned: this.cleaned,
    });
  }

  // ---- WebSocket upgrade ------------------------------------------------------------------

  private async upgrade(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error(426, 'upgrade_required');
    const rec = this.record;
    if (!rec || this.cleaned) return error(404, 'no_room');
    const h = request.headers;
    const playerId = h.get('x-player-id') ?? '';
    const slot = Number(h.get('x-slot'));
    const team = Number(h.get('x-team'));
    const jti = h.get('x-jti') ?? '';
    if (!Number.isInteger(slot) || slot < 0 || slot >= rec.slots.length) return error(403, 'bad_slot');
    const entry = rec.slots[slot];
    if (entry.kind !== 'peer' || entry.playerId !== playerId || entry.team !== team) return error(403, 'not_your_slot');
    if (!/^[0-9a-f]{32}$/.test(jti)) return error(403, 'bad_ticket');
    // Gone for good (its socket closed, it left through the matchmaker, it was declared a no-show
    // or dropped): the matchmaker may already have freed its lock and seated it in another room,
    // and the others were told it is not coming. A ticket (90 s) outlives every one of those.
    if (this.isGone(slot)) return this.refuseGone(slot, playerId);
    // The player showed up with its ticket: whatever happens next, it is not a no-show.
    this.state.arrived[slot] = true;
    this.joining[slot]++;
    let admitted = false;
    try {
      // No TURN here (cost-2): the welcome carries STUN only, a seat asks for TURN once its ticket
      // was used ('turn'). The room AND the slot are re-checked all the same.
      if (!this.record || this.cleaned) return error(404, 'no_room');
      if (this.isGone(slot)) return error(403, 'left', 'this slot left the room (single-use seat)');
      // Single use of the ticket, checked last so a transient failure above does not burn it.
      if (await this.ctx.storage.get('jti:' + jti)) return error(403, 'ticket_used');
      await this.ctx.storage.put('jti:' + jti, true);
      admitted = true;
      return await this.admit(rec, slot, playerId, stunOnly());
    } finally {
      this.joining[slot]--;
      if (!admitted) await this.afterFailedJoin(slot);
    }
  }

  /**
   * 403 'left' for a slot that is gone. A slot that never had a socket and whose player shows up
   * only now (a slow join past the no-show grace, or after the matchmaker gave its lock up) is not
   * a no-show: it is marked `arrived` (the start drop / cleanup no longer name it) and the
   * matchmaker is asked, once, to take back the strike it may already have counted for this room.
   */
  private async refuseGone(slot: number, playerId: string): Promise<Response> {
    if (this.isNoShow(slot)) {
      this.state.arrived[slot] = true;
      await this.persist();
      // A room with experimental rules never named a no-show: nothing to take back.
      if (this.record !== null && roomPhysics(this.record) === null) this.forgive(playerId);
    }
    return error(403, 'left', 'this slot left the room (single-use seat)');
  }

  /**
   * An upgrade that waited for TURN and was not admitted: when the no-show pass ran meanwhile (and
   * skipped this slot), the slot is declared now and the start re-evaluated, or the present peers
   * would wait for it until their fallback. Nothing to do once the room is gone or started.
   */
  private async afterFailedJoin(slot: number): Promise<void> {
    const st = this.state;
    if (!this.record || this.cleaned || this.joining[slot] > 0 || !st.noShowDone || st.startAt !== null) return;
    this.markNoShows();
    await this.maybeStart(Date.now());
    await this.persist();
  }

  /** Accept the socket of `slot` (ticket verified and burnt), welcome it and tell the others. */
  private async admit(rec: RoomRecord, slot: number, playerId: string, iceServers: RoomWelcome['iceServers']): Promise<Response> {
    const st = this.state;
    const now = Date.now();
    const old = this.live[slot];
    const replaced = old !== null;
    if (old !== null) {
      // The newer socket wins; the old one is closed without a 'peerLeft' (the slot stays occupied).
      this.live[slot] = null;
      this.atts.delete(old);
      try {
        old.close(CLOSE_REPLACED, 'replaced');
      } catch {
        /* already closed */
      }
    }
    const gen = ++st.nextGen;
    const peerId = randomHex(8);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [peerId, 'slot:' + slot]);
    const att: Attachment = { slot, gen, peerId, playerId, ready: false, seenAt: now };
    server.serializeAttachment(att);
    this.atts.set(server, att);
    this.live[slot] = server;
    st.cur[slot] = gen;
    st.closedAt[slot] = 0;
    st.emptyAt = null;
    st.lastJoinAt = now;
    await this.persist();
    await this.rearm();

    const welcome: RoomWelcome = {
      type: 'room',
      protocol: ROOM_PROTOCOL,
      roomId: rec.roomId,
      mode: rec.mode,
      seed: rec.seed,
      inputDelay: INPUT_DELAY,
      window: WINDOW,
      hashEvery: HASH_EVERY,
      tickRate: TICK_RATE,
      matchLengthSeconds: rec.matchLengthSeconds,
      you: { slot, peerId },
      slots: this.roomSlots(),
      iceServers,
      now,
      // Every welcome carries the rules (first, late and replacement sockets alike).
      physics: roomPhysics(rec),
    };
    this.send(server, welcome);
    if (st.startAt !== null) {
      // Late (re)connection: the match is running; the peer learns the timeline and the roster changes.
      this.send(server, { type: 'start', startAt: st.startAt, now });
      for (const d of st.dropped) this.send(server, { type: 'drop', slot: d.slot, atTick: d.atTick });
    }
    if (!replaced) this.broadcast({ type: 'peerJoined', slot: this.roomSlot(slot) }, server);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': WS_SUBPROTOCOL } });
  }

  /**
   * A seat asks for TURN (its mesh did not connect): checked (configured, this socket is the
   * seat's, TURN_PER_SLOT, the player's daily quota at the matchmaker), then minted for the room's
   * remaining life and recorded for the revoke. Anything refused answers an empty list.
   */
  private async onTurn(ws: WebSocket, att: Attachment): Promise<void> {
    const rec = this.record;
    const st = this.state;
    const slot = att.slot;
    const none = (): void => this.send(ws, { type: 'turn', iceServers: [] });
    if (!rec || !turnConfigured(this.env) || this.turnBusy[slot] === 1) return none();
    if (st.turn.filter((t) => t.slot === slot).length >= TURN_PER_SLOT) return none();
    this.turnBusy[slot] = 1;
    try {
      if (!(await this.turnQuota(rec, att.playerId))) return none();
      const now = Date.now();
      const ttl = Math.max(TURN_MIN_TTL_SECONDS, Math.ceil((rec.createdAt + ROOM_TTL_MS - now) / 1000));
      const list = await iceServersFor(this.env, fetch, ttl);
      const users = turnUsernames(list);
      // Outgoing fetches above: the seat may be gone meanwhile (closed, replaced, the room cleaned).
      if (!this.record || this.cleaned || st.cur[slot] !== att.gen) {
        this.revoke(users);
        return;
      }
      if (users.length === 0) return none();
      for (const user of users) st.turn.push({ slot, user });
      await this.persist();
      this.send(ws, { type: 'turn', iceServers: list });
    } finally {
      this.turnBusy[slot] = 0;
    }
  }

  /** The player's daily TURN quota at the region's matchmaker (POST /turn-quota): true = mint. No answer = no. */
  private async turnQuota(rec: RoomRecord, playerId: string): Promise<boolean> {
    const env = this.env;
    try {
      const secret = await internalSecret(env.JWT_SECRET);
      const res = await env.MATCHMAKER.get(env.MATCHMAKER.idFromName('mm:' + rec.region)).fetch('https://matchmaker/turn-quota', {
        method: 'POST',
        headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
        body: JSON.stringify({ playerId }),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return false;
      }
      const b = (await res.json()) as { ok?: unknown };
      return b.ok === true;
    } catch (e) {
      console.error('RoomDO: turn quota failed (no TURN)', e);
      return false;
    }
  }

  /** Revoke TURN credentials in the background (best effort). */
  private revoke(users: readonly string[]): void {
    if (users.length === 0) return;
    const env = this.env;
    this.ctx.waitUntil(Promise.all(users.map((u) => revokeTurnCredential(env, u))).then(() => undefined));
  }

  /** The slot's TURN credentials out of the state, revoked (the caller persists). */
  private revokeSlot(slot: number): void {
    const st = this.state;
    const mine = st.turn.filter((t) => t.slot === slot);
    if (mine.length === 0) return;
    st.turn = st.turn.filter((t) => t.slot !== slot);
    this.revoke(mine.map((t) => t.user));
  }

  // ---- room logic -------------------------------------------------------------------------

  private async maybeStart(now: number): Promise<void> {
    const rec = this.record;
    const st = this.state;
    if (!rec || st.startAt !== null) return;
    // A 'ready' arriving after the grace (a late alarm): the no-shows are declared here as well.
    if (!st.noShowDone && now >= rec.createdAt + NO_SHOW_MS) {
      st.noShowDone = true;
      this.markNoShows();
    }
    // A slot whose upgrade is in flight is absent and not `left`: decideStart waits for it.
    const peers: StartPeer[] = [];
    for (const s of rec.slots) {
      if (s.kind !== 'peer') continue;
      const ws = this.live[s.slot];
      const att = ws !== null ? this.attOf(ws) : null;
      peers.push({ connected: ws !== null, ready: att !== null && att.ready, left: st.left[s.slot] || this.isDropped(s.slot) });
    }
    if (!decideStart(peers, MIN_HUMANS)) return;
    st.startAt = now + START_DELAY_MS;
    this.broadcast({ type: 'start', startAt: st.startAt, now }, null);
    // A peer slot with nobody on it when the match starts can never confirm a tick: every peer
    // hands it to the team AI from tick 0 (deterministic, same as a mid-match drop).
    for (const s of rec.slots) {
      if (s.kind === 'peer' && this.live[s.slot] === null && !this.isDropped(s.slot)) this.dropSlot(s.slot, 0);
    }
    await this.persist();
  }

  /**
   * The join grace is over: every peer slot that never had a socket is `left` (announced with an
   * empty peerId, exactly like a never-connected slot leaving through the matchmaker). Its lock is
   * not released here: the start's drop at tick 0 frees it naming it a no-show (dropSlot), or the
   * matchmaker frees it (and counts the no-show) when the player queues again, or the cleanup does.
   * A slot whose upgrade is in flight (`joining`: waiting for TURN) is skipped: it reached the room
   * within the grace, so the start waits for it (afterFailedJoin declares it if it is not admitted).
   * The caller persists.
   */
  private markNoShows(): void {
    const rec = this.record;
    if (!rec) return;
    const st = this.state;
    for (const s of rec.slots) {
      if (s.kind !== 'peer' || st.left[s.slot] || this.isDropped(s.slot)) continue;
      if (this.live[s.slot] !== null || st.closedAt[s.slot] > 0) continue; // connected now, or was
      if (this.joining[s.slot] > 0) continue; // its upgrade is waiting for TURN
      st.left[s.slot] = true;
      this.broadcast({ type: 'peerLeft', slot: s.slot, peerId: '' }, null);
    }
  }

  private async onUnreachable(ws: WebSocket, from: number, target: number, atTick: number, now: number): Promise<void> {
    const rec = this.record;
    if (!rec || target === from || target >= rec.slots.length || rec.slots[target].kind !== 'peer') return;
    const st = this.state;
    // Before the start a dead link is a mesh failure the client handles itself (its fallback);
    // kicking the target would strand it with a drop of its own slot, and a closed socket is
    // already dropped at tick 0 by maybeStart.
    if (st.startAt === null) return;
    if (this.isDropped(from)) return;
    const prior = st.dropped.find((d) => d.slot === target);
    if (prior) {
      // Already announced: repeat it to this reporter only (it may have missed the broadcast).
      const ws = this.live[from];
      if (ws !== null) this.send(ws, { type: 'drop', slot: prior.slot, atTick: prior.atTick });
      return;
    }
    // Only the smallest tick of a reporter matters (the drop goes at the minimum): a repeat that does
    // not lower it changes nothing and writes nothing (rt-m2); a change takes from the report budget.
    const existing = st.reports.find((r) => r.slot === target && r.from === from);
    const changes = existing === undefined || atTick < existing.atTick;
    if (changes) {
      if (!this.takeReportToken(ws, now)) return;
      if (existing) existing.atTick = atTick;
      else st.reports.push({ slot: target, from, atTick });
    }
    const checkAt = st.dropCheckAt;
    const drops = st.dropped.length;
    // Evaluated on a repeat as well: the target may have gone quiet since.
    this.evaluateDrop(target, now);
    if (!changes && st.dropped.length === drops && st.dropCheckAt === checkAt) return;
    await this.persist();
    if (st.dropCheckAt !== checkAt) await this.rearm();
  }

  /** One report of `ws`'s 'unreachable' budget (REPORT_BURST, then one per REPORT_REFILL_MS). */
  private takeReportToken(ws: WebSocket, now: number): boolean {
    let b = this.reportBuckets.get(ws);
    if (b === undefined) {
      b = { tokens: REPORT_BURST, at: now };
      this.reportBuckets.set(ws, b);
    }
    b.tokens = Math.min(REPORT_BURST, b.tokens + Math.max(0, now - b.at) / REPORT_REFILL_MS);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** The slot's room socket is open and sent something within TARGET_SILENT_MS. */
  private talking(slot: number, now: number): boolean {
    const ws = this.live[slot];
    if (ws === null) return false;
    const att = this.attOf(ws);
    return att !== null && att.seenAt !== undefined && now - att.seenAt < TARGET_SILENT_MS;
  }

  /** Apply decideDrop to the reports about `target`; schedules the grace re-check when its socket is closed. */
  private evaluateDrop(target: number, now: number): void {
    const rec = this.record;
    if (!rec || this.isDropped(target)) return;
    const st = this.state;
    const others: number[] = [];
    for (const s of rec.slots) if (s.kind === 'peer' && s.slot !== target && !this.isDropped(s.slot)) others.push(s.slot);
    const closedAgoMs = st.cur[target] === 0 && st.closedAt[target] > 0 ? now - st.closedAt[target] : null;
    const targetLive = closedAgoMs === null && this.talking(target, now);
    const d = decideDrop({ target, reports: st.reports, others, closedAgoMs, targetLive });
    if (d) {
      this.dropSlot(target, d.atTick);
      return;
    }
    if (others.length === 1 && targetLive) {
      // A lone report against a peer that is alive: dropped only if it reports the reporter too
      // (the link is dead both ways: both go, neither picks), or once it goes quiet (the alarm).
      const other = others[0];
      const both = this.talking(other, now) ? mutualDrop(st.reports, target, other) : null;
      if (both !== null) {
        this.dropSlot(target, both.a);
        this.dropSlot(other, both.b);
        return;
      }
      if (st.reports.some((r) => r.slot === target && r.from === other)) {
        const att = this.attOf(this.live[target] as WebSocket);
        const at = (att?.seenAt ?? now) + TARGET_SILENT_MS + 50;
        if (st.dropCheckAt === null || at < st.dropCheckAt) st.dropCheckAt = at;
      }
      return;
    }
    if (closedAgoMs !== null) {
      const at = st.closedAt[target] + CLOSE_GRACE_MS + 50;
      if (st.dropCheckAt === null || at < st.dropCheckAt) st.dropCheckAt = at;
    }
  }

  /**
   * Record + broadcast the drop and free the player's matchmaker lock (the caller persists). A slot
   * whose player never showed up (dropped at tick 0 by the start, no ticket of it ever reached the
   * room: a no-show) is named in `noShow`, so the matchmaker counts the strike (NO_SHOW_LIMIT) when
   * it frees that lock.
   */
  private dropSlot(slot: number, atTick: number): void {
    const rec = this.record;
    if (!rec) return;
    const st = this.state;
    st.dropped.push({ slot, atTick });
    for (let i = st.reports.length - 1; i >= 0; i--) if (st.reports[i].slot === slot || st.reports[i].from === slot) st.reports.splice(i, 1);
    this.broadcast({ type: 'drop', slot, atTick }, null);
    const playerId = rec.slots[slot].playerId;
    if (playerId === undefined) return;
    this.release([playerId], false, this.isNoShow(slot) ? [playerId] : []);
  }

  /** A socket is gone (closed by the peer, errored, or kicked here): idempotent, stale sockets are ignored. */
  private async onSocketGone(ws: WebSocket, now: number): Promise<void> {
    const att = this.attOf(ws);
    this.atts.delete(ws);
    this.buckets.delete(ws);
    this.reportBuckets.delete(ws);
    const rec = this.record;
    if (!att || !rec || this.cleaned) return;
    const st = this.state;
    if (st.cur[att.slot] !== att.gen) return; // replaced earlier: the slot has a newer socket
    this.live[att.slot] = null;
    st.cur[att.slot] = 0;
    st.closedAt[att.slot] = now;
    st.left[att.slot] = true; // single-use ticket: this slot never comes back
    this.revokeSlot(att.slot); // its TURN credentials die with the seat
    this.broadcast({ type: 'peerLeft', slot: att.slot, peerId: att.peerId }, null);
    this.release([att.playerId], false);
    if (this.connectedCount() === 0) st.emptyAt = now + EMPTY_MS;
    if (st.startAt !== null && st.reports.some((r) => r.slot === att.slot)) {
      // Someone already reported it: once the grace passes a single report is enough.
      const at = now + CLOSE_GRACE_MS + 50;
      if (st.dropCheckAt === null || at < st.dropCheckAt) st.dropCheckAt = at;
    }
    // An unready peer leaving may complete the start decision for the ready ones ('ready' is
    // idempotent, so nobody else could re-trigger it).
    if (st.startAt === null) await this.maybeStart(now);
    await this.persist();
    await this.rearm();
  }

  private async cleanup(reason: string): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    const rec = this.record;
    let sockets: WebSocket[] = [];
    try {
      sockets = this.ctx.getWebSockets();
    } catch {
      /* none */
    }
    for (const ws of sockets) {
      try {
        ws.close(1000, reason);
      } catch {
        /* already closed */
      }
    }
    this.live.fill(null);
    // Every TURN credential of the room dies with it (they would outlive it by their ttl).
    this.revoke(this.state.turn.map((t) => t.user));
    this.state.turn = [];
    if (rec) {
      const ids: string[] = [];
      const noShow: string[] = [];
      for (const s of rec.slots) {
        if (s.playerId === undefined) continue;
        ids.push(s.playerId);
        if (this.isNoShow(s.slot)) noShow.push(s.playerId); // never opened its socket nor presented its ticket
      }
      this.release(ids, true, noShow);
    }
    this.record = null;
    this.hashes.clear();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Free the players' one-active-match locks at the region matchmaker (scoped to this room id);
   * `closeRoom` also frees the room's slot in the capacity count; `noShow` names the players
   * among them that never opened their socket (the matchmaker backs off repeat no-shows). Best
   * effort, in the background.
   */
  private release(playerIds: string[], closeRoom: boolean, noShowIds: string[] = []): void {
    const rec = this.record;
    const env = this.env;
    if (!rec || !env.JWT_SECRET || (playerIds.length === 0 && !closeRoom)) return;
    // A room with experimental rules counts for nothing: no no-show strikes (the matchmaker's
    // lock is marked as well, so a modified release could not count one either).
    const noShow = roomPhysics(rec) === null ? noShowIds : [];
    const roomId = rec.roomId;
    const region = rec.region;
    this.ctx.waitUntil(
      (async () => {
        try {
          const secret = await internalSecret(env.JWT_SECRET);
          const mm = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('mm:' + region));
          await mm.fetch('https://matchmaker/release', {
            method: 'POST',
            headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
            body: JSON.stringify(noShow.length > 0 ? { matchId: roomId, playerIds, closeRoom, noShow } : { matchId: roomId, playerIds, closeRoom }),
          });
        } catch (e) {
          console.error('RoomDO: release failed', e);
        }
      })(),
    );
  }

  /**
   * The player of a given-up slot showed up after all (a late ticket): ask the region matchmaker to
   * take back the no-show strike of this room, if it counted one (POST /forgive; idempotent, scoped
   * to the room id). Best effort, in the background.
   */
  private forgive(playerId: string): void {
    const rec = this.record;
    const env = this.env;
    if (!rec || !env.JWT_SECRET) return;
    const roomId = rec.roomId;
    const region = rec.region;
    this.ctx.waitUntil(
      (async () => {
        try {
          const secret = await internalSecret(env.JWT_SECRET);
          const mm = env.MATCHMAKER.get(env.MATCHMAKER.idFromName('mm:' + region));
          await mm.fetch('https://matchmaker/forgive', {
            method: 'POST',
            headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
            body: JSON.stringify({ matchId: roomId, playerId }),
          });
        } catch (e) {
          console.error('RoomDO: forgive failed', e);
        }
      })(),
    );
  }

  // ---- helpers ----------------------------------------------------------------------------

  private attOf(ws: WebSocket): Attachment | null {
    let a = this.atts.get(ws);
    if (a === undefined) {
      let raw: unknown = null;
      try {
        raw = ws.deserializeAttachment();
      } catch {
        return null;
      }
      if (!isRecord(raw) || typeof raw.slot !== 'number' || typeof raw.gen !== 'number' || typeof raw.peerId !== 'string' || typeof raw.playerId !== 'string') return null;
      a = { slot: raw.slot, gen: raw.gen, peerId: raw.peerId, playerId: raw.playerId, ready: raw.ready === true, ...(typeof raw.seenAt === 'number' ? { seenAt: raw.seenAt } : {}) };
      this.atts.set(ws, a);
    }
    return a;
  }

  /**
   * After a wake-up: map the restored sockets to their slots; a slot whose socket is gone counts
   * as closed now (announced with 'peerLeft' and its lock released, exactly as a close would have).
   */
  private reconcileSockets(now: number): boolean {
    let sockets: WebSocket[];
    try {
      sockets = this.ctx.getWebSockets();
    } catch {
      return false;
    }
    const st = this.state;
    const rec = this.record;
    for (const ws of sockets) {
      const a = this.attOf(ws);
      if (a && a.slot < MAX_CARS && st.cur[a.slot] === a.gen && ws.readyState === WS_OPEN) this.live[a.slot] = ws;
    }
    let changed = false;
    const gone: string[] = [];
    for (let s = 0; s < MAX_CARS; s++) {
      if (st.cur[s] !== 0 && this.live[s] === null) {
        st.cur[s] = 0;
        st.closedAt[s] = now;
        st.left[s] = true;
        changed = true;
        this.broadcast({ type: 'peerLeft', slot: s, peerId: '' }, null);
        const playerId = rec !== null && s < rec.slots.length ? rec.slots[s].playerId : undefined;
        if (playerId !== undefined) gone.push(playerId);
      }
    }
    if (gone.length > 0) this.release(gone, false);
    if (changed && this.connectedCount() === 0 && st.emptyAt === null) st.emptyAt = now + EMPTY_MS;
    return changed;
  }

  private takeToken(ws: WebSocket, now: number): boolean {
    let b = this.buckets.get(ws);
    if (b === undefined) {
      b = { tokens: MSG_BURST, at: now };
      this.buckets.set(ws, b);
    }
    const dt = now - b.at;
    let tokens = dt > 0 ? b.tokens + dt * MSG_REFILL_PER_MS : b.tokens;
    if (tokens > MSG_BURST) tokens = MSG_BURST;
    b.at = now;
    if (tokens < 1) {
      b.tokens = tokens;
      return false;
    }
    b.tokens = tokens - 1;
    return true;
  }

  private kick(ws: WebSocket, code: number, reason: string, now: number): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
    // webSocketClose is not guaranteed for a close we initiated: run the same (idempotent) path.
    return this.onSocketGone(ws, now);
  }

  private isDropped(slot: number): boolean {
    for (const d of this.state.dropped) if (d.slot === slot) return true;
    return false;
  }

  /** The slot is out of this room for good (left, no-show, or dropped): a ticket of it is refused. */
  private isGone(slot: number): boolean {
    return this.state.left[slot] || this.isDropped(slot);
  }

  /** The player of `slot` never showed up: no socket ever, and no ticket of it ever reached the room. */
  private isNoShow(slot: number): boolean {
    const st = this.state;
    return st.cur[slot] === 0 && st.closedAt[slot] === 0 && !st.arrived[slot];
  }

  private connectedCount(): number {
    let n = 0;
    for (let s = 0; s < MAX_CARS; s++) if (this.live[s] !== null) n++;
    return n;
  }

  private roomSlot(slot: number): RoomSlot {
    const e = (this.record as RoomRecord).slots[slot];
    const ws = this.live[slot];
    const att = ws !== null ? this.attOf(ws) : null;
    const out: RoomSlot = { slot: e.slot, team: e.team, name: e.name, kind: e.kind, connected: ws !== null };
    if (e.car !== undefined) out.car = e.car;
    if (att !== null) out.peerId = att.peerId;
    if (ws === null && e.kind === 'peer' && this.state.left[slot]) out.left = true;
    return out;
  }

  private roomSlots(): RoomSlot[] {
    const rec = this.record as RoomRecord;
    const out: RoomSlot[] = [];
    for (let i = 0; i < rec.slots.length; i++) out.push(this.roomSlot(i));
    return out;
  }

  private send(ws: WebSocket, msg: RoomServerMessage): void {
    this.sendText(ws, JSON.stringify(msg));
  }

  private sendText(ws: WebSocket, text: string): void {
    try {
      ws.send(text);
    } catch {
      /* closing: the close event follows */
    }
  }

  private broadcast(msg: RoomServerMessage, except: WebSocket | null): void {
    const text = JSON.stringify(msg);
    for (let s = 0; s < MAX_CARS; s++) {
      const ws = this.live[s];
      if (ws !== null && ws !== except) this.sendText(ws, text);
    }
  }

  private persist(): Promise<void> {
    return this.ctx.storage.put('state', this.state);
  }

  /** One alarm for everything: the earliest of the no-show pass, empty cleanup, drop re-check and the hard TTL. */
  private async rearm(): Promise<void> {
    const rec = this.record;
    if (!rec || this.cleaned) return;
    let at = rec.createdAt + ROOM_TTL_MS;
    const st = this.state;
    if (!st.noShowDone && st.startAt === null && rec.createdAt + NO_SHOW_MS < at) at = rec.createdAt + NO_SHOW_MS;
    if (st.emptyAt !== null && st.emptyAt < at) at = st.emptyAt;
    if (st.dropCheckAt !== null && st.dropCheckAt < at) at = st.dropCheckAt;
    if (st.startAt === null && st.lastJoinAt !== null && st.lastJoinAt + NOT_READY_MS < at) at = st.lastJoinAt + NOT_READY_MS;
    await this.ctx.storage.setAlarm(at);
  }
}

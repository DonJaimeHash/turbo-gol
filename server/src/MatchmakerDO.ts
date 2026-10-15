/**
 * MatchmakerDO: one instance per region ('mm:' + region), reached only through the Worker with
 * the internal shared-secret header.
 *
 *   POST /join    { playerId, name, mode, kind? }  -> QueueResult | QueueResultP2p (matched right away) or 'waiting';
 *                                               409 { error: 'active_match', matchId, kind } while a match / room of the
 *                                               player is REALLY alive: a lock older than LOCK_VERIFY_AFTER_MS is
 *                                               verified first (RoomDO /internal/presence: the player's slot has a
 *                                               socket, or never had one and the lock is younger than JOIN_GRACE_MS;
 *                                               MatchDO /internal/status: not ended / reset) and released when stale,
 *                                               so a peer whose room socket close was not processed yet, whose room
 *                                               upgrade failed or whose room is gone queues again at once (a stale p2p
 *                                               lock also tells the room, /internal/leave, so the slot is `left` there
 *                                               and its ticket refused: one player can never sit in two rooms);
 *                                               429 'no_show' (retryAfterMs) for a p2p queue of a player that took
 *                                               NO_SHOW_LIMIT room tickets without ever showing up in the room (no
 *                                               socket, no upgrade with the ticket) within NO_SHOW_WINDOW_MS
 *                                               (griefing: every such ticket makes a partner wait and fall back to a
 *                                               simulating MatchDO); blocked NO_SHOW_BLOCK_MS, server queues still
 *                                               work; 503 'capacity' when MAX_ACTIVE_ROOMS rooms are alive
 *   GET  /poll?playerId=...                  -> same, answers when matched or after 25 s
 *   POST /leave   { playerId, matchId? }     -> { ok, left, released }: drops a waiter that is still queued (Esc in the
 *                                               menu) so the bot fill does not open a room nobody joins, AND frees the
 *                                               player's p2p room lock (when `matchId` is given it must be that room):
 *                                               the lock is deleted first, then the RoomDO is told (/internal/leave:
 *                                               it closes the player's socket -> 'peerLeft' to the others, or marks a
 *                                               never-connected slot left). A MatchDO ('server') lock is released only
 *                                               when `matchId` names that match (an explicit quit: OnlineSession.leave,
 *                                               or a P2P queue refused by it): the lock goes first, then the MatchDO is
 *                                               told (/internal/leave: socket closed, slot left for good and driven by
 *                                               the host's bots, /api/rejoin 410 'left'; the last human's leave ends
 *                                               the match at once, its /release drops the capacity entry, so a guest
 *                                               that queues and quits back to back holds no rooms). Without a matchId (Esc in the
 *                                               queue, a P2P teardown) or with another id a server lock stays: a reload
 *                                               / network drop rejoins that match on 409
 *   POST /release { matchId, playerIds, closeRoom?, noShow? }
 *                                            -> frees the "one active match per player" locks (and cached results)
 *                                               that point at `matchId` (a MatchDO match id or a RoomDO room id) and,
 *                                               unless closeRoom === false, forgets the room (capacity); a stale
 *                                               release from an older match cannot touch a newer lock; `noShow` names
 *                                               the players that never showed up (a strike each, once per room)
 *   POST /forgive { matchId, playerId }      -> { ok, forgiven }: the room saw the player's ticket after all (a slow
 *                                               join refused 403 'left' past the grace): the strike of that room is
 *                                               taken back; one not counted yet is remembered and skipped when it comes
 *   GET  /stats                              -> queue sizes, locks, rooms (debug)
 *
 * Two kinds of queue per mode (phase 2, docs/online/PHASE2.md):
 *   'server' (phase 1): a MatchDO match forms when the mode has all its humans (2 / 4 / 6) or when
 *            the oldest waiter has waited >= BOT_FILL_MS (bots fill the rest, at least one human).
 *   'p2p' (default, casual): a RoomDO signaling room forms at once with all the humans; after
 *            P2P_FILL_WAIT (15 s) with >= 2 humans it forms with bots in the free slots; a lone
 *            human after the wait is moved to the server path (a MatchDO match with bots, exactly
 *            as phase 1, answered in the phase 1 QueueResult shape). Rooms get a random uint32
 *            seed (kickoff deal + bot RNG on every peer) and tickets with role 'peer'.
 * Humans alternate teams (1st blue, 2nd red, ...); slot order is blue humans, blue bots, red
 * humans, red bots. The roster is registered in the target object (POST /internal/create)
 * BEFORE the tickets go out, so a ticket always points at a prepared room. While that create is
 * in flight the humans are in `forming`: a concurrent /join or /poll for one of them answers
 * 'waiting' instead of queueing a ghost waiter (outgoing fetches do not close the input gate).
 * Everything is in memory except the active-match locks ('active:<playerId>') and the live rooms
 * ('room:<id>', matches and p2p rooms alike), which expire with the match length + a grace period
 * (p2p: the room's hard TTL) and are released by the MatchDO / RoomDO when they shut down.
 *
 * Spend control (DECISIONS.md): at most MAX_ACTIVE_ROOMS Durable Object matches (each one
 * simulates) and, separately, MAX_ACTIVE_P2P_ROOMS signaling rooms (no simulation: a RoomDO only
 * relays and mostly hibernates) alive per region matchmaker; at a cap no room of that kind forms
 * (waiters keep waiting) and new joiners of that kind get 503.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { error, isMode, isModeList, isQueueKind, json, matchLengthSeconds, readJson } from './env';
import type { GameModeId, QueueKind, RoomKind } from './env';
import { INTERNAL_HEADER, checkInternal, createTicket, internalSecret } from './auth';
import type { TicketRole } from './auth';
import type { RosterEntry } from './roomHost';
import type { PresenceInfo, RoomSlotRecord } from './RoomDO';
import { MODES } from '../../src/sim/constants';
import type { QueueResult } from '../../src/net/protocol';
// Type-only (node's strip-only loader rejects that module's const enum; server/test/room.test.mjs
// imports this file). P2P_FILL_WAIT mirrors P2P_FILL_WAIT_MS and is checked against it by tsc.
import type { P2P_FILL_WAIT_MS, QueueResultP2p } from '../../src/net/p2p/protocol';

export const POLL_TIMEOUT_MS = 25_000;
export const BOT_FILL_MS = 10_000;
/** p2p: with >= 2 humans the room forms with bots after this; a lone human goes to the server path. */
export const P2P_FILL_WAIT: typeof P2P_FILL_WAIT_MS = 15_000;
/** Concurrent MatchDO matches this matchmaker may have alive (DECISIONS.md: 20 for the budget). */
export const MAX_ACTIVE_ROOMS = 20;
/** Concurrent RoomDO signaling rooms (p2p): no simulation cost, only signaling traffic. */
export const MAX_ACTIVE_P2P_ROOMS = 200;
/** A waiter that has not polled for this long is dropped. */
const STALE_MS = 40_000;
/** Active-match lock lifetime beyond the regulation length (overtime, reconnections). */
const ACTIVE_GRACE_MS = 10 * 60_000;
/** Lock / capacity lifetime of a p2p room: the RoomDO's hard TTL (20 min) plus slack; the room releases earlier. */
const P2P_LOCK_MS = 20 * 60_000 + 60_000;
const MATCHED_TTL_MS = 90_000;
const SWEEP_MS = 500;
/** After a failed room creation (DO error) the queue waits this long before the next attempt. */
const RETRY_AFTER_MS = 5_000;
/** A lock younger than this answers 409 without asking the room (the player just got its ticket). */
export const LOCK_VERIFY_AFTER_MS = 2_000;
/** A p2p lock whose slot never connected is kept this long after issue (the ticket is in flight), then counts as stale. */
export const JOIN_GRACE_MS = 10_000;
/**
 * No-show backoff: a room ticket taken and never used (the lock freed while the room says the
 * player never showed up, i.e. no socket and no upgrade with that ticket ever reached it: /leave,
 * the stale-lock verification, the room's drop at tick 0 when it starts without the slot, or its
 * cleanup) is a strike, counted only when the ticket reached the player (ActiveMatch.delivered: a
 * result still waiting for its poll is not the player's fault) and at most once per room; a room
 * that sees the ticket late after all (POST /forgive) takes its strike back. Strikes older than the
 * window are forgotten, and from NO_SHOW_LIMIT strikes on p2p queues answer 429 for
 * NO_SHOW_BLOCK_MS after the last one. In memory per region matchmaker (lost on eviction).
 */
export const NO_SHOW_LIMIT = 3;
export const NO_SHOW_WINDOW_MS = 10 * 60_000;
export const NO_SHOW_BLOCK_MS = 5 * 60_000;
/** Above this many tracked players (or forgiven rooms) the stale entries are pruned on the next strike (forgive). */
const NO_SHOW_PRUNE_AT = 2000;
/** Room ids kept per strike entry (the newest; an older strike can no longer be forgiven, it still counts). */
export const NO_SHOW_ROOMS_KEPT = 8;

export type AnyQueueResult = QueueResult | QueueResultP2p;

/** A waiter's rating in one ranked playlist (the Worker reads it from AccountsDO for every ranked join). */
export interface QueueRating {
  mu: number;
  sigma: number;
}

interface Waiter {
  playerId: string;
  name: string;
  /** Every playlist the player searches at once (several at once); the waiter sits in each of those queues. */
  modes: GameModeId[];
  kind: QueueKind;
  joinedAt: number;
  lastSeen: number;
  resolvers: Array<(r: AnyQueueResult) => void>;
  /** kind 'ranked': the rating per searched playlist. */
  ratings?: Partial<Record<GameModeId, QueueRating>>;
}

interface ActiveMatch {
  /** Match id (server) or room id (p2p). */
  matchId: string;
  until: number;
  /** Absent in rows written by phase 1 (= 'server'). */
  kind?: RoomKind;
  /** When the lock was issued (absent in older rows = long ago: verified at once). */
  since?: number;
  /**
   * The ticket reached the player (a response carried it). In memory only: a lock restored from
   * storage after an eviction counts as not delivered. A lock freed without its slot ever
   * connecting is a no-show strike only when the player actually had the ticket.
   */
  delivered?: boolean;
}

interface LeaveBody {
  playerId?: unknown;
  matchId?: unknown;
}

/** What /internal/status of a MatchDO tells about its liveness (the fields read here). */
interface MatchStatusInfo {
  matchId?: unknown;
  ended?: unknown;
  reset?: unknown;
}

/**
 * Whether a p2p room still holds the player, from the room's presence answer: a live socket, or
 * a slot that never connected while its ticket may still be used (lock younger than `graceMs`).
 * A dropped / left slot, or one that had a socket and lost it, no longer holds it. Pure.
 */
export function roomHoldsPlayer(p: PresenceInfo, lockAgeMs: number, graceMs: number = JOIN_GRACE_MS): boolean {
  if (p.dropped || p.left) return false;
  if (p.connected) return true;
  if (p.everConnected) return false;
  return lockAgeMs < graceMs;
}

/** A live match / room in the capacity count ('room:<id>' rows; older rows hold the bare `until`). */
interface RoomEntry {
  until: number;
  kind: RoomKind;
}

function roomEntryOf(v: unknown): RoomEntry | null {
  if (typeof v === 'number') return { until: v, kind: 'server' };
  if (typeof v === 'object' && v !== null && typeof (v as RoomEntry).until === 'number') {
    const k = (v as RoomEntry).kind;
    return { until: (v as RoomEntry).until, kind: k === 'p2p' ? 'p2p' : 'server' };
  }
  return null;
}

function capacityOf(kind: RoomKind): number {
  return kind === 'p2p' ? MAX_ACTIVE_P2P_ROOMS : MAX_ACTIVE_ROOMS;
}

interface JoinBody {
  playerId?: unknown;
  name?: unknown;
  /** One playlist (phase 1 / 2 clients) ... */
  mode?: unknown;
  /** ... or several searched at once (wins over `mode`). */
  modes?: unknown;
  kind?: unknown;
  /** kind 'ranked': { [mode]: { mu, sigma } } from AccountsDO (the Worker fills it, never the client). */
  ratings?: unknown;
}

/** POST /custom: a custom lobby's start (LobbyDO): fixed teams, bots in the free slots. */
interface CustomBody {
  kind?: unknown;
  mode?: unknown;
  members?: unknown;
  matchLengthSeconds?: unknown;
}

// ---- ranked matchmaking (pure, unit-tested in server/test/ranked.test.mjs) --------------------------

/** The MMR gap a ranked waiter accepts grows with its wait: base, + growth per step, capped; anything after RANKED_ANY_AFTER_MS. */
export const RANKED_WINDOW_BASE = 100;
export const RANKED_WINDOW_GROWTH = 50;
export const RANKED_WINDOW_STEP_MS = 10_000;
export const RANKED_WINDOW_MAX = 600;
export const RANKED_ANY_AFTER_MS = 150_000;
/** Displayed MMR per unit of mu (src/net/rating.ts MMR_SCALE). */
const MMR_PER_MU = 40;

export function rankedWindow(waitedMs: number): number {
  if (waitedMs >= RANKED_ANY_AFTER_MS) return Infinity;
  return Math.min(RANKED_WINDOW_MAX, RANKED_WINDOW_BASE + RANKED_WINDOW_GROWTH * Math.floor(Math.max(0, waitedMs) / RANKED_WINDOW_STEP_MS));
}

export interface RankedCandidate {
  playerId: string;
  joinedAt: number;
  mu: number;
}

/**
 * `need` ranked waiters that can play together now, or null: the oldest waiter that can anchor a
 * group wins; a candidate fits when its MMR gap to the anchor is within BOTH windows (each side
 * accepts the other); the closest fits are taken. `waiters` in queue order (oldest first).
 */
export function pickRankedGroup<T extends RankedCandidate>(waiters: readonly T[], need: number, now: number): T[] | null {
  if (waiters.length < need) return null;
  for (const anchor of waiters) {
    const wa = rankedWindow(now - anchor.joinedAt);
    const fits = waiters
      .filter((w) => w !== anchor && Math.abs(w.mu - anchor.mu) * MMR_PER_MU <= Math.min(wa, rankedWindow(now - w.joinedAt)))
      .sort((a, b) => Math.abs(a.mu - anchor.mu) - Math.abs(b.mu - anchor.mu) || a.joinedAt - b.joinedAt);
    if (fits.length >= need - 1) return [anchor, ...fits.slice(0, need - 1)];
  }
  return null;
}

/**
 * The fairest split of `group` (2 x perTeam players) into two teams: the smallest difference of
 * summed mu (every combination is tried: 3v3 has 10). Returns the two teams' indexes into `group`.
 */
export function balanceTeams(group: readonly { mu: number }[], perTeam: number): [number[], number[]] {
  const n = group.length;
  let best: number[] = [];
  let bestDiff = Infinity;
  const total = group.reduce((s, g) => s + g.mu, 0);
  const pick: number[] = [0]; // player 0 always blue: each split is tried once
  const rec = (start: number): void => {
    if (pick.length === perTeam) {
      const sum = pick.reduce((s, i) => s + group[i].mu, 0);
      const diff = Math.abs(total - 2 * sum);
      if (diff < bestDiff - 1e-9) {
        bestDiff = diff;
        best = pick.slice();
      }
      return;
    }
    for (let i = start; i < n; i++) {
      pick.push(i);
      rec(i + 1);
      pick.pop();
    }
  };
  rec(1);
  const blue = best;
  const red: number[] = [];
  for (let i = 0; i < n; i++) if (!blue.includes(i)) red.push(i);
  return [blue, red];
}

/** A roster in the given team order (custom lobbies, balanced ranked teams): each team's humans, then bots up to perTeam. */
export function buildTeamRoster<K extends string>(perTeam: number, teams: readonly [readonly HumanEntry[], readonly HumanEntry[]], humanKind: K): Array<RosterSlot<K>> {
  const roster: Array<RosterSlot<K>> = [];
  for (const team of [0, 1] as const) {
    const hs = teams[team].slice(0, perTeam);
    for (const h of hs) roster.push({ slot: roster.length, team, kind: humanKind, name: h.name, playerId: h.playerId });
    for (let b = hs.length; b < perTeam; b++) roster.push({ slot: roster.length, team, kind: 'bot', name: `Bot ${b + 1}` });
  }
  return roster;
}

function parseRatings(v: unknown, modes: readonly GameModeId[]): Partial<Record<GameModeId, QueueRating>> | null {
  if (!v || typeof v !== 'object') return null;
  const out: Partial<Record<GameModeId, QueueRating>> = {};
  for (const m of modes) {
    const r = (v as Record<string, unknown>)[m] as QueueRating | undefined;
    if (!r || typeof r.mu !== 'number' || typeof r.sigma !== 'number' || !Number.isFinite(r.mu) || !Number.isFinite(r.sigma)) return null;
    out[m] = { mu: r.mu, sigma: r.sigma };
  }
  return out;
}

interface ReleaseBody {
  matchId?: unknown;
  playerIds?: unknown;
  closeRoom?: unknown;
  noShow?: unknown;
}

interface ForgiveBody {
  matchId?: unknown;
  playerId?: unknown;
}

/** What RoomDO /internal/leave answers (RoomLeaveAnswer; the field read here, unchecked JSON). */
interface RoomLeaveInfo {
  noShow?: unknown;
}

/** No-show strikes of one player (see NO_SHOW_LIMIT). */
export interface NoShowEntry {
  count: number;
  lastAt: number;
  /** The rooms of the strikes in the current window, newest last (at most NO_SHOW_ROOMS_KEPT): a room counts once, and POST /forgive names one. */
  rooms: string[];
}

interface QueueKey {
  mode: GameModeId;
  kind: QueueKind;
}

interface FormOptions {
  /** Fixed teams (ranked balance, custom lobby picks) instead of alternating queue order. */
  teams?: [readonly HumanEntry[], readonly HumanEntry[]];
  ranked?: boolean;
  /** Regulation length (custom lobbies); default MATCH_LENGTH_SECONDS. */
  matchLengthSeconds?: number;
}

const MODE_IDS: readonly GameModeId[] = ['1v1', '2v2', '3v3'];
const KINDS: readonly QueueKind[] = ['p2p', 'server', 'ranked'];

function queueKey(mode: GameModeId, kind: QueueKind): string {
  return mode + ':' + kind;
}

export function isP2pResult(r: AnyQueueResult): r is QueueResultP2p {
  return 'kind' in r && r.kind === 'p2p';
}

/** The id a cached result points at: the match id (server) or the room id (p2p). */
function resultId(r: AnyQueueResult): string | undefined {
  return isP2pResult(r) ? r.roomId : r.matchId;
}

// ---- pure parts (unit-tested in server/test/room.test.mjs) -------------------------------------

export interface HumanEntry {
  playerId: string;
  name: string;
}

export interface RosterSlot<K extends string> {
  slot: number;
  team: 0 | 1;
  kind: K | 'bot';
  name: string;
  playerId?: string;
}

/**
 * Humans alternate teams in queue order (1st blue, 2nd red, ...); each team is its humans then
 * bots up to `perTeam`; slots are numbered in that order (blue first). `humanKind` is 'player' for a
 * MatchDO roster and 'peer' for a RoomDO room.
 */
export function buildRoster<K extends string>(perTeam: number, humans: readonly HumanEntry[], humanKind: K): Array<RosterSlot<K>> {
  const roster: Array<RosterSlot<K>> = [];
  const blue: HumanEntry[] = [];
  const red: HumanEntry[] = [];
  for (let i = 0; i < humans.length; i++) (i % 2 === 0 ? blue : red).push(humans[i]);
  const addTeam = (team: 0 | 1, hs: HumanEntry[]): void => {
    for (const h of hs) roster.push({ slot: roster.length, team, kind: humanKind, name: h.name, playerId: h.playerId });
    for (let b = hs.length; b < perTeam; b++) roster.push({ slot: roster.length, team, kind: 'bot', name: `Bot ${b + 1}` });
  };
  addTeam(0, blue);
  addTeam(1, red);
  return roster;
}

export type P2pFormation = 'wait' | 'room' | 'room_bots' | 'server';

/**
 * What a p2p queue with `humans` waiters (the oldest waited `waitedMs`) does: a full room at once;
 * after the fill wait, a room with bots when there are at least two humans, else the server path.
 */
export function decideP2pFormation(humans: number, need: number, waitedMs: number, fillWaitMs: number = P2P_FILL_WAIT): P2pFormation {
  if (humans <= 0) return 'wait';
  if (humans >= need) return 'room';
  if (waitedMs < fillWaitMs) return 'wait';
  return humans >= 2 ? 'room_bots' : 'server';
}

export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/** The human-readable reason of a 409 (the client shows it in the menu). */
export function lockMessage(kind: RoomKind): string {
  return kind === 'p2p'
    ? 'you are still in a P2P room: leave it (POST /api/leave) before queueing again'
    : 'you still have a server match: rejoin it (POST /api/rejoin) or quit it for good (POST /api/leave { matchId })';
}

/**
 * Whether POST /leave { matchId? } frees a lock of `kind` on `lockId` (`named` = the request's
 * matchId, null when absent). A p2p room lock: without a matchId or with that room's id. A server
 * (MatchDO) lock: only when the request names that very match (an explicit quit); a leave without
 * one (Esc in the queue, a P2P teardown) keeps it, so a reload or a network drop still rejoins.
 * A wrong id never frees anything. Pure.
 */
export function leaveReleases(kind: RoomKind, lockId: string, named: string | null): boolean {
  if (kind === 'p2p') return named === null || named === lockId;
  return named !== null && named === lockId;
}

/**
 * One more no-show strike, for room `roomId`, on top of `prev` (a strike older than the window starts
 * the count over; a room already struck in the window does not count again: `prev` is returned). Pure.
 */
export function recordNoShow(prev: NoShowEntry | undefined, roomId: string, now: number, windowMs: number = NO_SHOW_WINDOW_MS): NoShowEntry {
  if (prev === undefined || now - prev.lastAt >= windowMs) return { count: 1, lastAt: now, rooms: [roomId] };
  if (prev.rooms.includes(roomId)) return prev;
  const rooms = prev.rooms.length >= NO_SHOW_ROOMS_KEPT ? prev.rooms.slice(1) : prev.rooms.slice();
  rooms.push(roomId);
  return { count: prev.count + 1, lastAt: now, rooms };
}

/**
 * `prev` without the strike of room `roomId` (the room saw the player's ticket after all): `prev`
 * itself when that room is not among its strikes, null when no strike is left. `lastAt` is kept
 * (the block of the remaining strikes ends when it would have). Pure.
 */
export function forgiveNoShow(prev: NoShowEntry, roomId: string): NoShowEntry | null {
  const i = prev.rooms.indexOf(roomId);
  if (i < 0) return prev;
  if (prev.count <= 1) return null;
  const rooms = prev.rooms.slice();
  rooms.splice(i, 1);
  return { count: prev.count - 1, lastAt: prev.lastAt, rooms };
}

/** Milliseconds the player's p2p queues stay refused (0 = not blocked). Pure. */
export function noShowBlockedFor(entry: NoShowEntry | undefined, now: number, limit: number = NO_SHOW_LIMIT, blockMs: number = NO_SHOW_BLOCK_MS): number {
  if (entry === undefined || entry.count < limit) return 0;
  const left = entry.lastAt + blockMs - now;
  return left > 0 ? left : 0;
}

export function noShowMessage(count: number, leftMs: number): string {
  return `${count} room tickets taken without opening the room socket: P2P queue refused for ${Math.ceil(leftMs / 1000)} s (kind 'server' still works)`;
}

export class MatchmakerDO extends DurableObject<Env> {
  private readonly queues = new Map<string, Waiter[]>();
  /** Results handed out (or about to be): `delivered` flips when a response carries the ticket. */
  private readonly matched = new Map<string, { result: AnyQueueResult; until: number; delivered: boolean }>();
  private readonly active = new Map<string, ActiveMatch>();
  /** id -> expiry / kind of matches / rooms created by this matchmaker and not yet released (the capacity count). */
  private readonly rooms = new Map<string, RoomEntry>();
  /** Players spliced out of a queue whose room is being created (playerId -> their queue). */
  private readonly forming = new Map<string, QueueKey>();
  /** No-show strikes per playerId (NO_SHOW_*). */
  private readonly noShows = new Map<string, NoShowEntry>();
  /** Forgiven before the strike came ('<playerId> <roomId>' -> expiry): that strike is skipped. */
  private readonly forgiven = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly retryAt = new Map<string, number>();
  private region = '?';
  /** The clock of the request handlers (Date.now; tests inject their own). */
  now: () => number = () => Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const m of MODE_IDS) for (const k of KINDS) this.queues.set(queueKey(m, k), []);
    void ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const rows = await ctx.storage.list<ActiveMatch>({ prefix: 'active:' });
      for (const [k, v] of rows) {
        if (v.until > now) this.active.set(k.slice('active:'.length), v);
        else void ctx.storage.delete(k);
      }
      const roomRows = await ctx.storage.list<unknown>({ prefix: 'room:' });
      for (const [k, v] of roomRows) {
        const e = roomEntryOf(v);
        if (e && e.until > now) this.rooms.set(k.slice('room:'.length), e);
        else void ctx.storage.delete(k);
      }
      const region = await ctx.storage.get<string>('region');
      if (region) this.region = region;
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.env.JWT_SECRET) return error(500, 'no_secret', 'JWT_SECRET is not configured');
    if (!(await checkInternal(this.env.JWT_SECRET, request))) return error(403, 'forbidden');
    const url = new URL(request.url);
    const region = request.headers.get('x-region');
    if (region && region !== this.region) {
      this.region = region;
      void this.ctx.storage.put('region', region);
    }
    const now = this.now();
    if (request.method === 'POST' && url.pathname === '/join') return this.join(request, now);
    if (request.method === 'GET' && url.pathname === '/poll') return this.poll(url.searchParams.get('playerId') ?? '', now);
    if (request.method === 'POST' && url.pathname === '/leave') return this.leave(request, now);
    if (request.method === 'POST' && url.pathname === '/release') return this.release(request);
    if (request.method === 'POST' && url.pathname === '/forgive') return this.forgive(request, now);
    if (request.method === 'GET' && url.pathname === '/stats') return this.stats(now);
    if (request.method === 'GET' && url.pathname === '/population') return this.population(now);
    if (request.method === 'POST' && url.pathname === '/custom') return this.custom(request, now);
    return error(404, 'not_found');
  }

  // ---- handlers ---------------------------------------------------------------------------

  private async join(request: Request, now: number): Promise<Response> {
    const body = await readJson<JoinBody>(request);
    if (!body || typeof body.playerId !== 'string' || typeof body.name !== 'string') return error(400, 'bad_request');
    const modes: GameModeId[] | null = isModeList(body.modes) ? body.modes.slice() : isMode(body.mode) ? [body.mode] : null;
    if (modes === null) return error(400, 'bad_request');
    if (body.kind !== undefined && !isQueueKind(body.kind)) return error(400, 'bad_kind', "kind must be 'p2p' | 'server' | 'ranked'");
    const playerId = body.playerId;
    const kind: QueueKind = body.kind ?? 'p2p';
    const key: QueueKey = { mode: modes[0], kind };
    let ratings: Waiter['ratings'];
    if (kind === 'ranked') {
      const r = parseRatings(body.ratings, modes);
      if (r === null) return error(400, 'bad_ratings');
      ratings = r;
    }

    // A result never handed out comes first: a player whose poll answered 'waiting' while its
    // room was being created (see `forming`) comes back here and must get its ticket, not 409
    // (a p2p room cannot be rejoined). Once delivered, a new queue request answers 409 as in
    // phase 1 (the ticket is single use; the phase 1 client rejoins, the p2p client waits for
    // its socket to close, which frees the lock).
    const m = this.matched.get(playerId);
    if (m && m.until > now && !m.delivered) return this.deliver(playerId, m);
    const act = this.active.get(playerId);
    if (act && act.until > now) {
      // Really in that room / match? A fresh lock is trusted; an older one is checked against the
      // object itself (its release may be in flight, or never happened: upgrade failed, room gone).
      const fresh = now - (act.since ?? 0) < LOCK_VERIFY_AFTER_MS;
      if (fresh || (await this.lockHeld(act, playerId, now))) {
        return json({ error: 'active_match', matchId: act.matchId, kind: act.kind ?? 'server', message: lockMessage(act.kind ?? 'server') }, 409);
      }
      await this.forget(playerId, act);
      // The room must know too: the slot is `left` there (its ticket refused, the others told),
      // exactly as after /leave, so the player cannot end up with sockets in two rooms.
      if ((act.kind ?? 'server') === 'p2p') await this.leftRoom(act, playerId, now);
    }
    const m2 = this.matched.get(playerId);
    if (m2 && m2.until > now) return this.deliver(playerId, m2);
    const formingKey = this.forming.get(playerId);
    if (formingKey !== undefined) return json(this.waitingResult(formingKey)); // the room is being created: the next poll answers 'matched'
    if (key.kind === 'p2p') {
      const entry = this.noShows.get(playerId);
      const blockedMs = noShowBlockedFor(entry, now);
      if (entry !== undefined && blockedMs > 0) return json({ error: 'no_show', message: noShowMessage(entry.count, blockedMs), retryAfterMs: blockedMs }, 429);
    }

    let waiter = this.findWaiter(playerId);
    if (waiter && (waiter.kind !== kind || waiter.modes.length !== modes.length || waiter.modes.some((m) => !modes.includes(m)))) {
      this.removeWaiter(waiter);
      waiter = null;
    }
    if (waiter) {
      waiter.lastSeen = now;
      waiter.name = body.name;
      if (ratings) waiter.ratings = ratings;
    } else {
      const roomKind: RoomKind = kind === 'p2p' ? 'p2p' : 'server';
      if (this.activeRooms(now, roomKind) >= capacityOf(roomKind)) return error(503, 'capacity', 'all rooms are busy, try again in a minute');
      waiter = { playerId, name: body.name, modes, kind, joinedAt: now, lastSeen: now, resolvers: [], ratings };
      for (const m of modes) this.queue({ mode: m, kind }).push(waiter);
    }
    for (const m of modes) {
      await this.tryForm({ mode: m, kind }, now);
      if (this.matched.has(playerId)) break;
    }
    const r = this.matched.get(playerId);
    if (r) return this.deliver(playerId, r);
    this.scheduleSweep();
    return json(this.waitingResult(waiter));
  }

  private deliver(playerId: string, m: { result: AnyQueueResult; delivered: boolean }): Response {
    m.delivered = true;
    this.markDelivered(playerId, resultId(m.result));
    return json(m.result);
  }

  /** The lock for `id` now has its ticket in the player's hands (see ActiveMatch.delivered). */
  private markDelivered(playerId: string, id: string | undefined): void {
    const a = this.active.get(playerId);
    if (a !== undefined && a.matchId === id) a.delivered = true;
  }

  private poll(playerId: string, now: number): Promise<Response> | Response {
    const m = this.matched.get(playerId);
    if (m && m.until > now) return this.deliver(playerId, m);
    const formingKey = this.forming.get(playerId);
    if (formingKey !== undefined) return json(this.waitingResult(formingKey));
    const waiter = this.findWaiter(playerId);
    if (!waiter) return error(404, 'not_queued');
    waiter.lastSeen = now;
    this.scheduleSweep();
    return new Promise<Response>((resolve) => {
      let done = false;
      const finish = (r: AnyQueueResult): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(json(r));
      };
      const timer = setTimeout(() => {
        const i = waiter.resolvers.indexOf(finish);
        if (i >= 0) waiter.resolvers.splice(i, 1);
        waiter.lastSeen = Date.now();
        finish(this.waitingResult(waiter));
      }, POLL_TIMEOUT_MS);
      waiter.resolvers.push(finish);
    });
  }

  /**
   * The client stopped waiting / left its p2p room / quit its server match: drop its waiter
   * (pending long-polls answer 'waiting' at once) and free its lock when the leave covers it (see
   * leaveReleases). The lock goes first (synchronously, so a join that follows this call sees it
   * gone), the room / match is told afterwards (awaited: by the time the client gets its answer
   * the other peers have their 'peerLeft' / the match's bots drive the player's car).
   */
  private async leave(request: Request, now: number): Promise<Response> {
    const body = await readJson<LeaveBody>(request);
    if (!body || typeof body.playerId !== 'string') return error(400, 'bad_request');
    const playerId = body.playerId;
    let left = false;
    const waiter = this.findWaiter(playerId);
    if (waiter) {
      this.removeWaiter(waiter);
      const r = this.waitingResult(waiter);
      for (const resolve of waiter.resolvers) resolve(r);
      waiter.resolvers.length = 0;
      left = true;
    }
    let released = false;
    const act = this.active.get(playerId);
    const named = typeof body.matchId === 'string' ? body.matchId : null;
    if (act && act.until > now && leaveReleases(act.kind ?? 'server', act.matchId, named)) {
      await this.forget(playerId, act);
      released = true;
      if (act.kind === 'p2p') await this.leftRoom(act, playerId, now);
      else await this.matchLeave(act.matchId, playerId);
    }
    return json({ ok: true, left, released });
  }

  /**
   * Tell the MatchDO the player quit for good (its server lock was just freed): it closes the
   * player's socket and hands the car to its bots (MatchLeaveAnswer); for the last human it ends
   * the match before answering, and its /release (waitUntil) reaches this object while it waits
   * here (an outgoing fetch keeps the input gate open). Best effort: a 404 / 410 (the match is over
   * or gone) or an unreachable object leaves nothing to hand over.
   */
  private async matchLeave(matchId: string, playerId: string): Promise<void> {
    const env = this.env;
    try {
      const secret = await internalSecret(env.JWT_SECRET);
      const res = await env.MATCH.get(env.MATCH.idFromString(matchId)).fetch('https://match/internal/leave', {
        method: 'POST',
        headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
        body: JSON.stringify({ playerId }),
      });
      await res.body?.cancel();
    } catch (e) {
      console.error('matchmaker: match leave failed', e);
    }
  }

  /**
   * Tell the room the player is out of it (its lock `act` was just freed) and, when the room says
   * the player never showed up although it had the ticket, count the no-show.
   */
  private async leftRoom(act: ActiveMatch, playerId: string, now: number): Promise<void> {
    const info = await this.roomLeave(act.matchId, playerId);
    if (info !== null && info.noShow === true && act.delivered === true) this.strike(playerId, act.matchId, now);
  }

  /** A no-show strike for room `roomId` (once per room; skipped when that room already forgave it). */
  private strike(playerId: string, roomId: string, now: number): void {
    const key = playerId + ' ' + roomId;
    const f = this.forgiven.get(key);
    if (f !== undefined) {
      this.forgiven.delete(key);
      if (f > now) return;
    }
    if (this.noShows.size >= NO_SHOW_PRUNE_AT) {
      for (const [id, e] of this.noShows) if (now - e.lastAt >= NO_SHOW_WINDOW_MS + NO_SHOW_BLOCK_MS) this.noShows.delete(id);
    }
    this.noShows.set(playerId, recordNoShow(this.noShows.get(playerId), roomId, now));
  }

  /**
   * POST /forgive { matchId, playerId } (a RoomDO that refused a late ticket of a slot it had given
   * up): take back the strike of that room. One not counted yet (its release / leave answer is still
   * on the way) is remembered for the window and skipped when it comes. Idempotent.
   */
  private async forgive(request: Request, now: number): Promise<Response> {
    const body = await readJson<ForgiveBody>(request);
    if (!body || typeof body.matchId !== 'string' || typeof body.playerId !== 'string') return error(400, 'bad_request');
    const playerId = body.playerId;
    const roomId = body.matchId;
    const entry = this.noShows.get(playerId);
    if (entry !== undefined && entry.rooms.includes(roomId)) {
      const next = forgiveNoShow(entry, roomId);
      if (next === null) this.noShows.delete(playerId);
      else this.noShows.set(playerId, next);
      return json({ ok: true, forgiven: true });
    }
    if (this.forgiven.size >= NO_SHOW_PRUNE_AT) {
      for (const [k, until] of this.forgiven) if (until <= now) this.forgiven.delete(k);
    }
    if (this.forgiven.size < NO_SHOW_PRUNE_AT) this.forgiven.set(playerId + ' ' + roomId, now + NO_SHOW_WINDOW_MS);
    return json({ ok: true, forgiven: false });
  }

  /** Delete a player's lock (and a cached result pointing at the same id). Scoped: a newer lock is untouched. */
  private async forget(playerId: string, act: ActiveMatch): Promise<void> {
    if (this.active.get(playerId) === act) {
      this.active.delete(playerId);
      await this.ctx.storage.delete('active:' + playerId);
    }
    const m = this.matched.get(playerId);
    if (m && resultId(m.result) === act.matchId) this.matched.delete(playerId);
  }

  /** Does the room / match behind `act` still hold the player? Unreachable object = yes (the lock expires by itself; /leave frees it). */
  private async lockHeld(act: ActiveMatch, playerId: string, now: number): Promise<boolean> {
    const env = this.env;
    try {
      const secret = await internalSecret(env.JWT_SECRET);
      const headers = { [INTERNAL_HEADER]: secret };
      if ((act.kind ?? 'server') === 'p2p') {
        const res = await env.ROOM.get(env.ROOM.idFromString(act.matchId)).fetch('https://room/internal/presence?playerId=' + encodeURIComponent(playerId), { headers });
        if (res.status === 404) return false; // room gone / not a member
        if (!res.ok) return true;
        const p = (await res.json()) as PresenceInfo;
        return roomHoldsPlayer(p, now - (act.since ?? 0));
      }
      const res = await env.MATCH.get(env.MATCH.idFromString(act.matchId)).fetch('https://match/internal/status', { headers });
      if (res.status === 404) return false;
      if (!res.ok) return true;
      const s = (await res.json()) as MatchStatusInfo;
      return typeof s.matchId === 'string' && s.ended !== true && s.reset !== true;
    } catch (e) {
      console.error('matchmaker: lock verification failed', e);
      return true;
    }
  }

  /** Tell the RoomDO the player left (its socket is closed there -> 'peerLeft' to the others). Best effort: null when the room did not answer. */
  private async roomLeave(roomId: string, playerId: string): Promise<RoomLeaveInfo | null> {
    const env = this.env;
    try {
      const secret = await internalSecret(env.JWT_SECRET);
      const res = await env.ROOM.get(env.ROOM.idFromString(roomId)).fetch('https://room/internal/leave', {
        method: 'POST',
        headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
        body: JSON.stringify({ playerId }),
      });
      if (!res.ok) return null;
      const info: unknown = await res.json();
      return typeof info === 'object' && info !== null ? (info as RoomLeaveInfo) : null;
    } catch (e) {
      console.error('matchmaker: room leave failed', e);
      return null;
    }
  }

  /** Scoped to one match / room id: locks and cached tickets that point at another (newer) one are untouched. */
  private async release(request: Request): Promise<Response> {
    const body = await readJson<ReleaseBody>(request);
    if (!body || typeof body.matchId !== 'string' || !Array.isArray(body.playerIds)) return error(400, 'bad_request');
    const matchId = body.matchId;
    const closeRoom = body.closeRoom !== false;
    const now = this.now();
    let n = 0;
    for (const id of body.playerIds) {
      if (typeof id !== 'string') continue;
      const a = this.active.get(id);
      if (a && a.matchId === matchId) {
        this.active.delete(id);
        await this.ctx.storage.delete('active:' + id);
        n++;
        // Never showed up although it had the ticket (the room's start drop or its cleanup says
        // so): a strike, once per lock (the lock is gone after this) and per room.
        if (a.delivered === true && Array.isArray(body.noShow) && body.noShow.includes(id)) this.strike(id, matchId, now);
      }
      const m = this.matched.get(id);
      if (m && resultId(m.result) === matchId) this.matched.delete(id); // a cached 'matched' result would point at the dead room
    }
    if (closeRoom && this.rooms.delete(matchId)) await this.ctx.storage.delete('room:' + matchId);
    return json({ ok: true, released: n });
  }

  /** GET /population: waiting per playlist (casual = p2p + server, ranked) and players holding a lock (playing). */
  private population(now: number): Response {
    const casual: Record<GameModeId, number> = { '1v1': 0, '2v2': 0, '3v3': 0 };
    const ranked: Record<GameModeId, number> = { '1v1': 0, '2v2': 0, '3v3': 0 };
    for (const m of MODE_IDS) {
      casual[m] = this.queue({ mode: m, kind: 'p2p' }).length + this.queue({ mode: m, kind: 'server' }).length;
      ranked[m] = this.queue({ mode: m, kind: 'ranked' }).length;
    }
    let playing = 0;
    for (const a of this.active.values()) if (a.until > now) playing++;
    return json({ region: this.region, casual, ranked, playing });
  }

  /**
   * POST /custom { kind, mode, members: [{ playerId, name, team }], matchLengthSeconds } (LobbyDO
   * start): a match / room with the lobby's teams (bots in the free slots), the members locked like
   * queue matches. Answers { results: { [playerId]: AnyQueueResult } } at once (no long-poll), 409
   * 'member_busy' { playerId } when a member still holds a live lock, 503 'capacity' at the cap.
   */
  private async custom(request: Request, now: number): Promise<Response> {
    const body = await readJson<CustomBody>(request);
    if (!body || (body.kind !== 'p2p' && body.kind !== 'server') || !isMode(body.mode) || !Array.isArray(body.members)) return error(400, 'bad_request');
    const mode = body.mode;
    const perTeam = MODES[mode];
    const teams: [HumanEntry[], HumanEntry[]] = [[], []];
    const seen = new Set<string>();
    for (const m of body.members as Array<{ playerId?: unknown; name?: unknown; team?: unknown }>) {
      if (!m || typeof m.playerId !== 'string' || typeof m.name !== 'string' || (m.team !== 0 && m.team !== 1) || seen.has(m.playerId)) return error(400, 'bad_members');
      seen.add(m.playerId);
      teams[m.team].push({ playerId: m.playerId, name: m.name });
    }
    if (seen.size === 0 || teams[0].length > perTeam || teams[1].length > perTeam) return error(400, 'bad_members');
    const length = typeof body.matchLengthSeconds === 'number' && body.matchLengthSeconds >= 0 && body.matchLengthSeconds <= 1800 ? Math.floor(body.matchLengthSeconds) : undefined;
    const humans = [...teams[0], ...teams[1]];
    for (const h of humans) {
      const act = this.active.get(h.playerId);
      if (act && act.until > now && (await this.lockHeld(act, h.playerId, now))) return json({ error: 'member_busy', playerId: h.playerId, message: h.name + ' todavía está en otra partida' }, 409);
      if (act) await this.forget(h.playerId, act);
      const w = this.findWaiter(h.playerId);
      if (w) this.removeWaiter(w);
    }
    // P2P needs two humans to have peers; a lone member plays on the server against bots.
    const kind: RoomKind = body.kind === 'p2p' && humans.length >= 2 ? 'p2p' : 'server';
    if (this.activeRooms(now, kind) >= capacityOf(kind)) return error(503, 'capacity', 'all rooms are busy, try again in a minute');
    for (const h of humans) this.forming.set(h.playerId, { mode, kind });
    try {
      if (kind === 'p2p') await this.formRoom(mode, humans, now, { teams, matchLengthSeconds: length });
      else await this.formMatch(mode, humans, now, { teams, matchLengthSeconds: length });
    } catch (e) {
      console.error('matchmaker: custom form failed', e);
      return error(500, 'form_failed');
    } finally {
      for (const h of humans) this.forming.delete(h.playerId);
    }
    const results: Record<string, AnyQueueResult> = {};
    for (const h of humans) {
      const m = this.matched.get(h.playerId);
      if (!m) continue;
      m.delivered = true;
      this.markDelivered(h.playerId, resultId(m.result));
      results[h.playerId] = m.result;
    }
    return json({ results });
  }

  private stats(now: number): Response {
    const queues: Record<string, number> = {};
    for (const [key, q] of this.queues) queues[key] = q.length;
    let active = 0;
    for (const a of this.active.values()) if (a.until > now) active++;
    return json({
      region: this.region,
      queues,
      active,
      matched: this.matched.size,
      rooms: this.activeRooms(now, 'server'),
      maxRooms: MAX_ACTIVE_ROOMS,
      p2pRooms: this.activeRooms(now, 'p2p'),
      maxP2pRooms: MAX_ACTIVE_P2P_ROOMS,
      forming: this.forming.size,
      noShows: this.noShows.size,
      forgiven: this.forgiven.size,
    });
  }

  // ---- queue logic ------------------------------------------------------------------------

  private queue(key: QueueKey): Waiter[] {
    return this.queues.get(queueKey(key.mode, key.kind)) as Waiter[];
  }

  private findWaiter(playerId: string): Waiter | null {
    for (const q of this.queues.values()) for (const w of q) if (w.playerId === playerId) return w;
    return null;
  }

  /** Out of every queue it sits in (one per searched playlist). */
  private removeWaiter(w: Waiter): void {
    for (const m of w.modes) {
      const q = this.queue({ mode: m, kind: w.kind });
      const i = q.indexOf(w);
      if (i >= 0) q.splice(i, 1);
    }
  }

  /** 'waiting' with the number of players in the same queue(s): for a waiter, the distinct players across its playlists. */
  private waitingResult(k: QueueKey | Waiter): QueueResult {
    if ('modes' in k) {
      const seen = new Set<string>();
      for (const m of k.modes) for (const w of this.queue({ mode: m, kind: k.kind })) seen.add(w.playerId);
      return { status: 'waiting', waiting: Math.max(seen.size, 1) };
    }
    return { status: 'waiting', waiting: this.queue(k).length };
  }

  /** Rooms of `kind` created here that were neither released nor expired (expired ones are forgotten on the way). */
  private activeRooms(now: number, kind: RoomKind): number {
    let n = 0;
    for (const [id, e] of this.rooms) {
      if (e.until > now) {
        if (e.kind === kind) n++;
      } else {
        this.rooms.delete(id);
        void this.ctx.storage.delete('room:' + id);
      }
    }
    return n;
  }

  private scheduleSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      void this.sweep();
    }, SWEEP_MS);
  }

  private async sweep(): Promise<void> {
    const now = this.now();
    let pending = false;
    for (const mode of MODE_IDS) {
      for (const kind of KINDS) {
        const key: QueueKey = { mode, kind };
        await this.tryForm(key, now);
        if (this.queue(key).length > 0) pending = true;
      }
    }
    for (const [id, m] of this.matched) if (m.until <= now) this.matched.delete(id);
    if (pending) this.scheduleSweep();
  }

  /** Drop waiters that stopped polling, then form a match / room if the queue is ready and a room is allowed. */
  /** Back into every queue it searched (a failed room creation), in join order so it keeps its place. */
  private requeue(humans: readonly Waiter[]): void {
    for (const h of humans) {
      for (const m of h.modes) {
        const q = this.queue({ mode: m, kind: h.kind });
        if (q.includes(h)) continue;
        let i = 0;
        while (i < q.length && q[i].joinedAt <= h.joinedAt) i++;
        q.splice(i, 0, h);
      }
    }
  }

  /** Drop waiters that stopped polling, then form a match / room if the queue is ready and a room is allowed. */
  private async tryForm(key: QueueKey, now: number): Promise<void> {
    const q = this.queue(key);
    for (let i = q.length - 1; i >= 0; i--) {
      if (now - q[i].lastSeen > STALE_MS) {
        const w = q[i];
        this.removeWaiter(w);
        for (const r of w.resolvers) r(this.waitingResult(key));
        w.resolvers.length = 0;
      }
    }
    if (q.length === 0) return;
    const k = queueKey(key.mode, key.kind);
    if ((this.retryAt.get(k) ?? 0) > now) return;
    const perTeam = MODES[key.mode];
    const need = perTeam * 2;
    const waited = now - q[0].joinedAt;
    let humans: Waiter[];
    let p2p = false;
    let teams: [Waiter[], Waiter[]] | undefined;
    if (key.kind === 'ranked') {
      // Ranked: only full rosters of humans whose MMRs fit each other's (growing) windows; never bots.
      const cands = q.map((w) => ({ w, playerId: w.playerId, joinedAt: w.joinedAt, mu: w.ratings?.[key.mode]?.mu ?? 25 }));
      const group = pickRankedGroup(cands, need, now);
      if (group === null) return;
      const [blue, red] = balanceTeams(group, perTeam);
      teams = [blue.map((i) => group[i].w), red.map((i) => group[i].w)];
      humans = group.map((g) => g.w);
    } else if (key.kind === 'server') {
      if (q.length < need && waited < BOT_FILL_MS) return;
      humans = q.slice(0, Math.min(need, q.length));
    } else {
      const f = decideP2pFormation(q.length, need, waited);
      if (f === 'wait') return;
      humans = q.slice(0, f === 'room' ? need : q.length); // 'room_bots' / 'server' take everyone waiting (1 for 'server')
      p2p = f !== 'server';
    }
    const roomKind: RoomKind = p2p ? 'p2p' : 'server';
    if (this.activeRooms(now, roomKind) >= capacityOf(roomKind)) return; // at the budget cap: they keep waiting until a room is released
    for (const h of humans) {
      this.removeWaiter(h);
      this.forming.set(h.playerId, key);
    }
    try {
      if (p2p) await this.formRoom(key.mode, humans, now);
      else await this.formMatch(key.mode, humans, now, { teams, ranked: key.kind === 'ranked' });
    } catch (e) {
      console.error('matchmaker: form failed', e);
      // Put them back (original join times) and retry after a backoff.
      this.requeue(humans);
      this.retryAt.set(k, now + RETRY_AFTER_MS);
    } finally {
      for (const h of humans) this.forming.delete(h.playerId);
    }
  }

  /**
   * An authoritative MatchDO match (bots fill the free slots): phase 1 casual, ranked (balanced
   * `teams`, rated by AccountsDO when it ends, locked there too so one account plays one ranked
   * match across every region) and custom lobbies (fixed `teams`, `matchLengthSeconds`).
   */
  private async formMatch(mode: GameModeId, humans: readonly HumanEntry[], now: number, opts: FormOptions = {}): Promise<string> {
    const env = this.env;
    const perTeam = MODES[mode];
    const roster: RosterEntry[] = opts.teams ? buildTeamRoster(perTeam, opts.teams, 'player') : buildRoster(perTeam, humans, 'player');
    const id = env.MATCH.newUniqueId();
    const matchId = id.toString();
    const length = opts.matchLengthSeconds ?? matchLengthSeconds(env);
    const secret = await internalSecret(env.JWT_SECRET);
    const res = await env.MATCH.get(id).fetch('https://match/internal/create', {
      method: 'POST',
      headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
      body: JSON.stringify({ matchId, mode, region: this.region, roster, matchLengthSeconds: length, createdAt: now, ranked: opts.ranked === true }),
    });
    if (!res.ok) throw new Error(`MatchDO create -> ${res.status} ${await res.text()}`);
    const until = now + (length > 0 ? length : 20 * 60) * 1000 + ACTIVE_GRACE_MS;
    if (opts.ranked) {
      try {
        const lock = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts-v1')).fetch('https://accounts/ranked-lock', {
          method: 'POST',
          headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
          body: JSON.stringify({ matchId, region: this.region, userIds: humans.map((h) => h.playerId), until }),
        });
        await lock.body?.cancel();
      } catch (e) {
        console.error('matchmaker: ranked lock failed', e); // the region lock below still holds the player here
      }
    }
    await this.issue(
      humans,
      roster.filter((e) => e.kind === 'player'),
      matchId,
      'player',
      until,
      now,
      (ticket) => ({ status: 'matched', matchId, ticket, wsUrl: '/ws/' + matchId, ...(opts.ranked ? { ranked: true } : {}) }) satisfies QueueResult,
    );
    return matchId;
  }

  /** Phase 2: a RoomDO signaling room; every peer simulates (bots included) from the shared seed. */
  private async formRoom(mode: GameModeId, humans: readonly HumanEntry[], now: number, opts: FormOptions = {}): Promise<string> {
    const env = this.env;
    const slots: RoomSlotRecord[] = opts.teams ? buildTeamRoster(MODES[mode], opts.teams, 'peer') : buildRoster(MODES[mode], humans, 'peer');
    const id = env.ROOM.newUniqueId();
    const roomId = id.toString();
    const seed = randomSeed();
    const secret = await internalSecret(env.JWT_SECRET);
    const res = await env.ROOM.get(id).fetch('https://room/internal/create', {
      method: 'POST',
      headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, mode, region: this.region, seed, slots, matchLengthSeconds: opts.matchLengthSeconds ?? matchLengthSeconds(env), createdAt: now }),
    });
    if (!res.ok) throw new Error(`RoomDO create -> ${res.status} ${await res.text()}`);
    await this.issue(
      humans,
      slots.filter((e) => e.kind === 'peer'),
      roomId,
      'peer',
      now + P2P_LOCK_MS,
      now,
      (ticket) => ({ status: 'matched', kind: 'p2p', roomId, ticket, wsUrl: '/room/' + roomId }) satisfies QueueResultP2p,
    );
    return roomId;
  }

  /** Register the room, mint one ticket per human, lock them, cache the results and answer their long-polls. */
  private async issue(
    humans: ReadonlyArray<HumanEntry & { resolvers?: Waiter['resolvers'] }>,
    seats: ReadonlyArray<{ slot: number; team: 0 | 1; name: string; playerId?: string }>,
    id: string,
    role: TicketRole,
    until: number,
    now: number,
    makeResult: (ticket: string) => AnyQueueResult,
  ): Promise<void> {
    const kind: RoomKind = role === 'peer' ? 'p2p' : 'server';
    const entry: RoomEntry = { until, kind };
    this.rooms.set(id, entry);
    await this.ctx.storage.put('room:' + id, entry);
    for (const e of seats) {
      if (!e.playerId) continue;
      const ticket = await createTicket(this.env.JWT_SECRET, { sub: e.playerId, mid: id, team: e.team, slot: e.slot, name: e.name, role }, now);
      this.matched.set(e.playerId, { result: makeResult(ticket), until: now + MATCHED_TTL_MS, delivered: false });
      const lock: ActiveMatch = { matchId: id, until, kind, since: now };
      this.active.set(e.playerId, lock);
      await this.ctx.storage.put('active:' + e.playerId, lock);
    }
    for (const h of humans) {
      const r = this.matched.get(h.playerId);
      if (!r || !h.resolvers || h.resolvers.length === 0) continue; // no long-poll pending: the next join / poll delivers it
      r.delivered = true;
      this.markDelivered(h.playerId, id);
      for (const resolve of h.resolvers) resolve(r.result);
      h.resolvers.length = 0;
    }
  }
}

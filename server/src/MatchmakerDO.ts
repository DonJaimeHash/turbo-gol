/**
 * MatchmakerDO: one instance per region ('mm:' + region), reached only through the Worker with
 * the internal shared-secret header.
 *
 *   POST /join    { playerId, name, mode, kind?, doDisabled?, car?, account?, accountAgeDays? }
 *                                            -> QueueResult | QueueResultP2p (matched right away) or 'waiting';
 *                                               car / account / accountAgeDays: the session's (index.ts seatFields),
 *                                               kept with the seat (HumanEntry) and copied into every roster;
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
 *                                               work; 503 'capacity' when MAX_ACTIVE_ROOMS rooms are alive (not for a
 *                                               server / ranked join of a player the nodes are on for where a node can
 *                                               host now, nodesHere: that match waits for a node). A lock on a node
 *                                               match answers 409 with kind 'server' and node: true (it is rejoined like
 *                                               a server match). `doDisabled` (the Worker read do_disabled set and let a
 *                                               server / ranked queue through, D9): where no node can host now, 503
 *                                               'do_disabled' as without the nodes, instead of waiting for nothing
 *   GET  /poll?playerId=...                  -> same, answers when matched or after 25 s (also while the player's match
 *                                               is being formed: a node placement can take seconds)
 *   POST /leave   { playerId, matchId? }     -> { ok, left, released }: drops a waiter that is still queued (Esc in the
 *                                               menu; one whose match is being formed is taken out of it once that is
 *                                               over, withdraw) so the bot fill does not open a room nobody joins, AND frees the
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
 *                                               / network drop rejoins that match on 409. A node lock follows the server
 *                                               rule, but the node goes first (/internal/leave, `connected: false` passed
 *                                               on): the lock is freed only once the control plane recorded the leave or
 *                                               no longer knows the match (200 / 404 / 410); a 503, an error or no answer
 *                                               keeps it (released: false), so a leave the node never saw cannot put the
 *                                               player in a second match of this region (every lock is per region
 *                                               matchmaker; a ranked match is also locked in AccountsDO, every region)
 *   POST /release { matchId, playerIds, closeRoom?, noShow? }
 *                                            -> frees the "one active match per player" locks (and cached results)
 *                                               that point at `matchId` (a MatchDO match id, a RoomDO room id, or a node
 *                                               match id: the NodeRegistryDO's outbox) and,
 *                                               unless closeRoom === false, forgets the room (capacity); a stale
 *                                               release from an older match cannot touch a newer lock; `noShow` names
 *                                               the players that never showed up (a strike each, once per room)
 *   POST /forgive { matchId, playerId }      -> { ok, forgiven }: the room saw the player's ticket after all (a slow
 *                                               join refused 403 'left' past the grace): the strike of that room is
 *                                               taken back; one not counted yet is remembered and skipped when it comes
 *   GET  /stats                              -> queue sizes, locks (nodeLocks: those on node matches), rooms (debug)
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
 * humans, red bots. Each human seat carries its car (src/net/cosmetics.ts: absent = the default,
 * which every bot drives): the MatchDO roster, the RoomDO slots, and for a node match the result's
 * `cars` by slot (the node itself never gets them). The roster is registered in the target object
 * (POST /internal/create) BEFORE the tickets go out, so a ticket always points at a prepared room. While that create (or a
 * node placement) is in flight the humans are in `forming`: a concurrent /join for one of them
 * answers 'waiting' and its /poll waits for the outcome, instead of queueing a ghost waiter
 * (outgoing fetches do not close the input gate).
 * Everything is in memory except the active-match locks ('active:<playerId>') and the live rooms
 * ('room:<id>', matches and p2p rooms alike), which expire with the match length + a grace period
 * (p2p: the room's hard TTL) and are released by the MatchDO / RoomDO when they shut down.
 *
 * Spend control (DECISIONS.md): at most MAX_ACTIVE_ROOMS Durable Object matches (each one
 * simulates) and, separately, MAX_ACTIVE_P2P_ROOMS signaling rooms (no simulation: a RoomDO only
 * relays and mostly hibernates) alive per region matchmaker; at a cap no room of that kind forms
 * (waiters keep waiting) and new joiners of that kind get 503.
 *
 * Community nodes (nodes/, the NodeRegistryDO), behind the KV flag nodes_on (env.ts nodesMode: off,
 * everyone, or a canary of account ids; vm_disabled turns them off): a MatchDO match whose humans
 * the nodes are all on for is offered to a node first (formMatch, POST /internal/place). Placed, it
 * is locked as kind 'node' and answered with the node's own wss:// URL and node: true; it never
 * counts toward MAX_ACTIVE_ROOMS. Not placed (no node free, an error, no answer in
 * NODE_CALL_TIMEOUT_MS), today's MatchDO is created, unless do_disabled is set or the cap is
 * reached: then the humans wait in the queue for a node. A region no node can host now (not one the
 * nodes serve, or in the back-off after hosts 0 or a failed call) has no node to wait for: there
 * the cap answers 503 and waiters wait for a free room as without the nodes, and with do_disabled
 * the server / ranked joins answer 503 (no MatchDO is created for them either). Custom lobbies
 * never go to a node. With the nodes off for a player (or not configured: a fork, the tests)
 * everything is as without them.
 *
 * Experimental rules (the owner's rule: every ranked or counted match, P2P included, runs the
 * standard physics; the experimental counts for nothing): only a custom lobby's /custom may carry
 * `physics` (src/game/physicsRules.ts parseLobbyRules, strict: 400 bad_physics), only for a
 * P2P room with at least 2 humans (400 experimental_p2p_only otherwise: no lone-human MatchDO
 * fallback, never formMatch, never a node) and only when every member says `guest: false` (403
 * account_required; the room gets that flag per seat and checks it again). /join (the casual
 * and ranked queues) refuses a body that carries it (400 experimental_lobby_only). The rules go
 * to RoomDO /internal/create; the room's locks and capacity entry are marked experimental
 * (ActiveMatch.exp, RoomEntry.exp, kept in storage), and a room so marked never counts a no-show
 * strike, whatever its release says.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { EXPERIMENTAL_REFUSED, carriesPhysics, error, flag, isMode, isModeList, isQueueKind, json, matchLengthSeconds, nodesAllowed, nodesConfigured, nodesMode, readJson } from './env';
import type { GameModeId, LockKind, NodesMode, QueueKind, RoomKind } from './env';
import { INTERNAL_HEADER, checkInternal, createTicket, internalSecret } from './auth';
import type { TicketRole } from './auth';
import { NODE_CALL_TIMEOUT_MS, NODE_ROUTES, askNodes, nodeLockHeld, placementFor } from './nodeApi';
import type { PlaceBody } from './nodeApi';
import type { Placement } from '../../nodes/control-plane/controlPlane';
import type { RosterEntry } from './roomHost';
import type { PresenceInfo, RoomSlotRecord } from './RoomDO';
import { MODES } from '../../src/sim/constants';
import { isRegion } from '../../src/net/account';
import { parseLobbyRules } from '../../src/game/physicsRules';
import type { RulesSnapshot } from '../../src/game/physicsRules';
import type { QueueResult } from '../../src/net/protocol';
import { carsBySlot, seatCar } from '../../src/net/cosmetics';
import type { CosmeticQueueResult } from '../../src/net/cosmetics';
import type { CarId } from '../../src/game/cosmetics';
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
/**
 * No placement is asked for this long after the NodeRegistryDO said no node of the region can host
 * (hosts 0), or failed to answer: a stuck object then costs one wait a minute, not one per match.
 */
export const NO_HOSTS_BACKOFF_MS = 60_000;
/** nodes_on and vm_disabled are read again at most this often (every join and formation asks). */
export const NODES_MODE_TTL_MS = 10_000;

export type AnyQueueResult = QueueResult | QueueResultP2p;

/** A waiter's rating in one ranked playlist (the Worker reads it from AccountsDO for every ranked join). */
export interface QueueRating {
  mu: number;
  sigma: number;
}

interface Waiter extends HumanEntry {
  /** Every playlist the player searches at once (several at once); the waiter sits in each of those queues. */
  modes: GameModeId[];
  kind: QueueKind;
  joinedAt: number;
  lastSeen: number;
  resolvers: Array<(r: AnyQueueResult) => void>;
  /** kind 'ranked': the rating per searched playlist. */
  ratings?: Partial<Record<GameModeId, QueueRating>>;
  /** p2p queue: its lone-human server path found no node and no room (NoRoom); not tried again before this. */
  noRoomUntil?: number;
}

interface ActiveMatch {
  /** Match id (server, node) or room id (p2p). */
  matchId: string;
  until: number;
  /** Absent in rows written by phase 1 (= 'server'). 'node': a match on a community node (NodeRegistryDO). */
  kind?: LockKind;
  /** When the lock was issued (absent in older rows = long ago: verified at once). */
  since?: number;
  /**
   * The ticket reached the player (a response carried it). In memory only: a lock restored from
   * storage after an eviction counts as not delivered. A lock freed without its slot ever
   * connecting is a no-show strike only when the player actually had the ticket.
   */
  delivered?: boolean;
  /** A room with experimental rules: it never counts a no-show strike (it counts for nothing). */
  exp?: true;
}

interface LeaveBody {
  playerId?: unknown;
  matchId?: unknown;
  /** false: the client never got into the match (a cancel while connecting). Passed on to a node only. */
  connected?: unknown;
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
  /** A P2P room with experimental rules (no no-show strikes). */
  exp?: true;
}

function roomEntryOf(v: unknown): RoomEntry | null {
  if (typeof v === 'number') return { until: v, kind: 'server' };
  if (typeof v === 'object' && v !== null && typeof (v as RoomEntry).until === 'number') {
    const k = (v as RoomEntry).kind;
    const entry: RoomEntry = { until: (v as RoomEntry).until, kind: k === 'p2p' ? 'p2p' : 'server' };
    if ((v as RoomEntry).exp === true) entry.exp = true;
    return entry;
  }
  return null;
}

function capacityOf(kind: RoomKind): number {
  return kind === 'p2p' ? MAX_ACTIVE_P2P_ROOMS : MAX_ACTIVE_ROOMS;
}

/** What a lock reads as to the client and to leaveReleases: a node match as a server one (rejoined; freed only by an explicit quit). */
function roomKindOf(act: ActiveMatch): RoomKind {
  return act.kind === 'p2p' ? 'p2p' : 'server';
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
  /** true: the Worker read do_disabled set (it lets only a server / ranked queue of a player the nodes are on for through). */
  doDisabled?: unknown;
  /** Never accepted: experimental rules exist only in custom lobbies (400 experimental_lobby_only). */
  physics?: unknown;
  /** From the session (index.ts seatFields), never the client's body: the account's car (absent: the default car) ... */
  car?: unknown;
  /** ... and, for the rewards weight of a node match, that it is an account and its age in days. */
  account?: unknown;
  accountAgeDays?: unknown;
}

/** POST /custom: a custom lobby's start (LobbyDO): fixed teams, bots in the free slots. */
interface CustomBody {
  kind?: unknown;
  mode?: unknown;
  members?: unknown;
  matchLengthSeconds?: unknown;
  /** The lobby's experimental rules (null / absent = standard): P2P with >= 2 humans only. */
  physics?: unknown;
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
    for (const h of hs) roster.push(seatOf(roster.length, team, humanKind, h));
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
  /** false: never on a community node (custom lobbies: 0-1800 s against a node's length + 600 s TTL). Default: when the nodes are on for every human. */
  nodes?: boolean;
  /**
   * formRoom only (a custom lobby's P2P room): its experimental rules, null / absent = standard;
   * the room gets each peer's HumanEntry.guest with them. formMatch refuses any (a MatchDO or a
   * node never runs other physics than the standard).
   */
  physics?: RulesSnapshot | null;
}

/**
 * formMatch: no node took the match and the Worker's own servers may not take it either
 * (do_disabled, or MAX_ACTIVE_ROOMS reached), or one of the humans left while the nodes were asked
 * ('left': no MatchDO is created with it). Not a failure: the humans (but one that left) go back
 * to their queue.
 */
class NoRoom extends Error {
  readonly code: 'do_disabled' | 'capacity' | 'left';
  constructor(code: 'do_disabled' | 'capacity' | 'left') {
    super(code);
    this.code = code;
  }
}

/** A seat issue() locks and tickets: a roster slot with its human. */
interface Seat {
  slot: number;
  team: 0 | 1;
  name: string;
  playerId?: string;
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
  /** /custom only: false for a signed-in lobby member (a room with experimental rules needs it of every seat). */
  guest?: boolean;
  /** The car the seat drives (the session's, or the lobby member's), copied into the roster; absent: the default car. */
  car?: CarId;
  /** A registered account and its age: the rewards weight of a node match (PlaceBody humans; ledger.ts). */
  account?: boolean;
  accountAgeDays?: number;
}

export interface RosterSlot<K extends string> {
  slot: number;
  team: 0 | 1;
  kind: K | 'bot';
  name: string;
  playerId?: string;
  /** A human seat's car (src/net/cosmetics.ts SeatCar): the MatchDO's welcome and the RoomDO's slots carry it; bots drive the default. */
  car?: CarId;
}

/** A human's roster slot: the fields both roster builders copy, its car included when it has one. */
function seatOf<K extends string>(slot: number, team: 0 | 1, kind: K, h: HumanEntry): RosterSlot<K> {
  return { slot, team, kind, name: h.name, playerId: h.playerId, ...(h.car !== undefined ? { car: h.car } : {}) };
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
    for (const h of hs) roster.push(seatOf(roster.length, team, humanKind, h));
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
  /**
   * Players spliced out of a queue whose match / room is being formed: their waiter (a queue's
   * formation: a /poll waits on it, issue() answers it) or, for a custom lobby's member, its queue.
   */
  private readonly forming = new Map<string, Waiter | QueueKey>();
  /** Forming waiters whose /leave came meanwhile: taken out of the formation once it is over (withdraw). */
  private readonly cancels = new Set<string>();
  /** No-show strikes per playerId (NO_SHOW_*). */
  private readonly noShows = new Map<string, NoShowEntry>();
  /** Forgiven before the strike came ('<playerId> <roomId>' -> expiry): that strike is skipped. */
  private readonly forgiven = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly retryAt = new Map<string, number>();
  private region = '?';
  /** nodesMode as last read (readNodes), and when; the read in flight, and whether one ever finished. */
  private nodes: NodesMode = 'off';
  private nodesReadAt = -Infinity;
  private nodesRead: Promise<void> | null = null;
  private nodesKnown = false;
  /** No placement is asked before this (NO_HOSTS_BACKOFF_MS). */
  private noHostsUntil = 0;
  /** The clock of the request handlers (Date.now; tests inject their own). */
  now: () => number = () => Date.now();
  /** How long a call to the NodeRegistryDO may take (tests shorten it). */
  nodeTimeoutMs = NODE_CALL_TIMEOUT_MS;

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
    // The casual and ranked queues run the standard physics, always (the Worker refuses it first).
    if (carriesPhysics(body)) return error(400, EXPERIMENTAL_REFUSED, 'experimental rules exist only in custom P2P lobbies');
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
    // The seat's car and rewards weight (the Worker's, from the session): a field of another shape is dropped.
    const car = seatCar(body.car);
    const account = body.account === true;
    const accountAgeDays = typeof body.accountAgeDays === 'number' && Number.isFinite(body.accountAgeDays) && body.accountAgeDays >= 0 ? Math.floor(body.accountAgeDays) : undefined;
    await this.readNodes(now); // before any state is read: the steps below must not wait on I/O
    // D9 lets this server / ranked queue wait for a node; where none can host now (nodesHere)
    // there is nothing to wait for, and it is refused as without the nodes.
    const doDisabled = body.doDisabled === true && kind !== 'p2p';

    // Left while its match was being formed (leave): nothing of that formation reaches it. Its
    // poll waits for the formation's end (withdraw), then it queues anew.
    const cancelled = this.forming.get(playerId);
    if (cancelled !== undefined && this.cancels.has(playerId)) return json(this.waitingResult(cancelled));

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
        // A node match is rejoined like a server one (the client rejoins any 409 that is not p2p).
        const shown = roomKindOf(act);
        return json({ error: 'active_match', matchId: act.matchId, kind: shown, ...(act.kind === 'node' ? { node: true } : {}), message: lockMessage(shown) }, 409);
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
    if (doDisabled && !this.nodesHere([playerId], now)) return this.refuseDoDisabled(waiter);
    if (waiter) {
      waiter.lastSeen = now;
      waiter.name = body.name;
      // A session refreshed meanwhile may carry another car (POST /api/me/car): the newest one sits.
      waiter.car = car;
      waiter.account = account;
      waiter.accountAgeDays = accountAgeDays;
      if (ratings) waiter.ratings = ratings;
    } else {
      const roomKind: RoomKind = kind === 'p2p' ? 'p2p' : 'server';
      // With the nodes on for this player a server / ranked match waits for a node, not for a free
      // MatchDO (formMatch): no cap here, unless no node can host now. A player outside the canary
      // gets today's 503.
      if (this.activeRooms(now, roomKind) >= capacityOf(roomKind) && !(roomKind === 'server' && this.nodesHere([playerId], now))) {
        return error(503, 'capacity', 'all rooms are busy, try again in a minute');
      }
      waiter = { playerId, name: body.name, car, account, accountAgeDays, modes, kind, joinedAt: now, lastSeen: now, resolvers: [], ratings };
      for (const m of modes) this.queue({ mode: m, kind }).push(waiter);
    }
    for (const m of modes) {
      await this.tryForm({ mode: m, kind }, now);
      if (this.matched.has(playerId)) break;
    }
    const r = this.matched.get(playerId);
    if (r) return this.deliver(playerId, r);
    // That formation may have just found no node here (hosts 0): refused now, not after a poll.
    if (doDisabled && !this.nodesHere([playerId], now)) return this.refuseDoDisabled(this.findWaiter(playerId));
    this.scheduleSweep();
    return json(this.waitingResult(waiter));
  }

  /** 503 do_disabled for a server / ranked join with no node to wait for (join): its waiter, if any, is dropped. */
  private refuseDoDisabled(waiter: Waiter | null): Response {
    if (waiter) this.dropWaiter(waiter);
    return error(503, 'do_disabled');
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
    if (m && m.until > now && !this.cancels.has(playerId)) return this.deliver(playerId, m);
    const forming = this.forming.get(playerId);
    if (forming !== undefined && !('resolvers' in forming)) return json(this.waitingResult(forming)); // a custom lobby's start answers its members itself
    // While its match is being formed (a node placement can take seconds) the poll waits on the
    // waiter all the same: issue() answers it, or the formation's end / the timer with 'waiting'.
    // An answer at once would have the client ask again at once, into the queue rate limit.
    const waiter = forming ?? this.findWaiter(playerId);
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
   * the other peers have their 'peerLeft' / the match's bots drive the player's car). A node match
   * is the other way round: the node first, and the lock goes only once it took the leave
   * (nodeLeave). A waiter whose match is being formed is out of every queue already: it is marked
   * (cancels) and tryForm takes it out of the formation once that is over (withdraw).
   */
  private async leave(request: Request, now: number): Promise<Response> {
    const body = await readJson<LeaveBody>(request);
    if (!body || typeof body.playerId !== 'string') return error(400, 'bad_request');
    const playerId = body.playerId;
    let left = false;
    const waiter = this.findWaiter(playerId);
    if (waiter) {
      this.dropWaiter(waiter);
      left = true;
    }
    const forming = this.forming.get(playerId);
    if (forming !== undefined && 'resolvers' in forming) {
      this.cancels.add(playerId);
      this.answerWaiting(forming);
      left = true;
    }
    const act = this.active.get(playerId);
    const named = typeof body.matchId === 'string' ? body.matchId : null;
    const released = act !== undefined && (await this.leaveLock(playerId, act, named, body.connected === false, now));
    return json({ ok: true, left, released });
  }

  /**
   * Free the player's lock `act` when a leave naming `named` covers it (leaveReleases), and tell its
   * room / match (the lock first) or its node (the node first: the lock goes only once the node took
   * the leave, nodeLeave; `neverConnected` is passed on). True when the lock was freed.
   */
  private async leaveLock(playerId: string, act: ActiveMatch, named: string | null, neverConnected: boolean, now: number): Promise<boolean> {
    if (act.until <= now || !leaveReleases(roomKindOf(act), act.matchId, named)) return false;
    if (act.kind === 'node') {
      const released = await this.nodeLeave(act.matchId, playerId, neverConnected);
      if (released) await this.forget(playerId, act);
      return released;
    }
    await this.forget(playerId, act);
    if (act.kind === 'p2p') await this.leftRoom(act, playerId, now);
    else await this.matchLeave(act.matchId, playerId);
    return true;
  }

  /**
   * A waiter whose /leave came while its match was being formed (leave), now that the formation is
   * over (`formed`: the match / room id, null when none formed; it is not back in the queue then,
   * tryForm). A node match it never got into is quit as an explicit leave, connected: false (never
   * a dodge; the lock goes once the node took it, D12). Anything else as a leave right after the
   * formation: a p2p room's lock is freed and the room told (no strike: the ticket never reached
   * the player); a MatchDO's lock stays, and the next queue gets that match (a ranked quit before
   * the kickoff would be a dodge). Its polls meanwhile then answer 'waiting'.
   */
  private async withdraw(w: Waiter, formed: string | null, now: number): Promise<void> {
    try {
      const act = this.active.get(w.playerId);
      if (formed !== null && act !== undefined && act.matchId === formed) await this.leaveLock(w.playerId, act, act.kind === 'node' ? formed : null, true, now);
    } finally {
      this.forming.delete(w.playerId);
      this.cancels.delete(w.playerId);
      this.answerWaiting(w);
    }
  }

  /**
   * Tell the node's control plane the player quits its node match, before the lock goes (D12):
   * true when the lock may go (the leave is recorded: 200, even when the relay to the node then
   * failed; or the control plane no longer has the player in a running match: 404, 410), false
   * when it must stay (503 offline: nothing was recorded, the player may still rejoin; any other
   * answer, an error, or none within nodeTimeoutMs, longer than the node's own RPC). Without the
   * nodes configured nothing can hold the player: true.
   */
  private async nodeLeave(matchId: string, playerId: string, neverConnected: boolean): Promise<boolean> {
    const env = this.env;
    if (!nodesConfigured(env)) return true;
    try {
      const r = await askNodes(env, NODE_ROUTES.leave, { matchId, playerId, ...(neverConnected ? { connected: false } : {}) }, this.nodeTimeoutMs);
      if ((r.status >= 200 && r.status < 300) || r.status === 404 || r.status === 410) return true;
      console.error(`matchmaker: node leave -> ${r.status}: lock kept`);
    } catch (e) {
      console.error('matchmaker: node leave failed, lock kept', e);
    }
    return false;
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
    if (info !== null && info.noShow === true && act.delivered === true && !this.experimental(act)) this.strike(playerId, act.matchId, now);
  }

  /** The lock is one of a room with experimental rules (the lock's mark, or the room's): never a strike. */
  private experimental(act: ActiveMatch): boolean {
    return act.exp === true || this.rooms.get(act.matchId)?.exp === true;
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

  /**
   * Does the room / match behind `act` still hold the player? Unreachable object = yes (the lock
   * expires by itself; /leave frees it). A node match holds while the control plane has it played
   * or reported and the player has not left it (nodeLockHeld; a 200 that is no status keeps it); a
   * 404 (it knows neither the match nor the player in it) frees it, any other refusal keeps it, and
   * without the nodes configured nothing holds it.
   */
  private async lockHeld(act: ActiveMatch, playerId: string, now: number): Promise<boolean> {
    const env = this.env;
    try {
      if (act.kind === 'node') {
        if (!nodesConfigured(env)) return false;
        const q = new URLSearchParams({ matchId: act.matchId, playerId });
        const r = await askNodes(env, NODE_ROUTES.status + '?' + q.toString(), undefined, this.nodeTimeoutMs);
        if (r.status === 404) return false;
        if (r.status !== 200) return true;
        return nodeLockHeld(r.body);
      }
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
        // so): a strike, once per lock (the lock is gone after this) and per room; never in a room
        // with experimental rules, whatever the release names.
        if (a.delivered === true && Array.isArray(body.noShow) && body.noShow.includes(id) && !this.experimental(a)) this.strike(id, matchId, now);
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
   * POST /custom { kind, mode, members: [{ playerId, name, team, guest }], matchLengthSeconds,
   * physics } (LobbyDO start): a match / room with the lobby's teams (bots in the free slots), the
   * members locked like queue matches. Answers { results: { [playerId]: AnyQueueResult } } at once (no long-poll), 409
   * 'member_busy' { playerId } when a member still holds a live lock, 503 'capacity' at the cap.
   */
  private async custom(request: Request, now: number): Promise<Response> {
    const body = await readJson<CustomBody>(request);
    if (!body || (body.kind !== 'p2p' && body.kind !== 'server') || !isMode(body.mode) || !Array.isArray(body.members)) return error(400, 'bad_request');
    const mode = body.mode;
    const perTeam = MODES[mode];
    const teams: [HumanEntry[], HumanEntry[]] = [[], []];
    const seen = new Set<string>();
    let guests = false;
    for (const m of body.members as Array<{ playerId?: unknown; name?: unknown; team?: unknown; guest?: unknown; car?: unknown }>) {
      if (!m || typeof m.playerId !== 'string' || typeof m.name !== 'string' || (m.team !== 0 && m.team !== 1) || seen.has(m.playerId)) return error(400, 'bad_members');
      seen.add(m.playerId);
      // Signed in only when the lobby says so (a member without the flag counts as a guest).
      const guest = m.guest !== false;
      if (guest) guests = true;
      // The member's car as the lobby took it from its session; one of another shape is dropped.
      const car = seatCar(m.car);
      teams[m.team].push({ playerId: m.playerId, name: m.name, guest, ...(car !== undefined ? { car } : {}) });
    }
    if (seen.size === 0 || teams[0].length > perTeam || teams[1].length > perTeam) return error(400, 'bad_members');
    const length = typeof body.matchLengthSeconds === 'number' && body.matchLengthSeconds >= 0 && body.matchLengthSeconds <= 1800 ? Math.floor(body.matchLengthSeconds) : undefined;
    // Experimental rules: checked again (strictly), and only for a P2P room with >= 2 humans: no
    // lone-human MatchDO with them, never a node.
    const physics = parseLobbyRules(body.physics);
    if (physics === 'bad') return error(400, 'bad_physics', 'invalid experimental rules');
    if (physics !== null && (body.kind !== 'p2p' || seen.size < 2)) return error(400, 'experimental_p2p_only', 'experimental rules need a P2P match with at least 2 players');
    // ... and signed-in players only (LobbyDO refuses guests at every door; checked again here).
    if (physics !== null && guests) return error(403, 'account_required', 'experimental rules are for signed-in players only');
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
      if (kind === 'p2p') await this.formRoom(mode, humans, now, { teams, matchLengthSeconds: length, physics });
      else await this.formMatch(mode, humans, now, { teams, matchLengthSeconds: length, nodes: false });
    } catch (e) {
      if (e instanceof NoRoom) return error(503, e.code, 'all rooms are busy, try again in a minute');
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
    let nodeLocks = 0;
    for (const a of this.active.values()) {
      if (a.until <= now) continue;
      active++;
      if (a.kind === 'node') nodeLocks++;
    }
    return json({
      region: this.region,
      queues,
      active,
      nodeLocks,
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

  /** Out of every queue, its pending long-polls answered 'waiting' at once. */
  private dropWaiter(w: Waiter): void {
    this.removeWaiter(w);
    this.answerWaiting(w);
  }

  /** Answer the waiter's pending long-polls 'waiting' now (each client then asks again). */
  private answerWaiting(w: Waiter): void {
    const r = this.waitingResult(w);
    for (const resolve of w.resolvers) resolve(r);
    w.resolvers.length = 0;
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
    await this.readNodes(now);
    let pending = false;
    for (const mode of MODE_IDS) {
      for (const kind of KINDS) {
        const key: QueueKey = { mode, kind };
        // Not awaited: a slow node placement must not hold up the other queues' timed formations.
        // tryForm moves its humans to `forming` before its first await; a failure requeues them
        // and schedules a sweep.
        void this.tryForm(key, now);
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
      // A lone human whose server path found no room (NoRoom) waits out its own back-off; a second
      // human still forms a P2P room (a RoomDO, its own cap) at once.
      if (f === 'wait' || (f === 'server' && (q[0].noRoomUntil ?? 0) > now)) return;
      humans = q.slice(0, f === 'room' ? need : q.length); // 'room_bots' / 'server' take everyone waiting (1 for 'server')
      p2p = f !== 'server';
    }
    const roomKind: RoomKind = p2p ? 'p2p' : 'server';
    const ids = humans.map((h) => h.playerId);
    // At the budget cap they keep waiting until a room is released; where a node can take the match
    // of every one of them (a lone p2p human's server path included) formMatch asks one first.
    if (this.activeRooms(now, roomKind) >= capacityOf(roomKind) && !(roomKind === 'server' && this.nodesHere(ids, now))) return;
    for (const h of humans) {
      this.removeWaiter(h);
      this.forming.set(h.playerId, h);
    }
    let formed: string | null = null;
    try {
      formed = p2p ? await this.formRoom(key.mode, humans, now) : await this.formMatch(key.mode, humans, now, { teams, ranked: key.kind === 'ranked' });
    } catch (e) {
      // NoRoom: no node now and no MatchDO allowed (they wait for one), or one of them left; no failure.
      if (!(e instanceof NoRoom)) console.error('matchmaker: form failed', e);
      // Put them back (original join times; not one that left) and retry after a backoff: the
      // queue's, except after a leave (the others may form at once) and on a p2p queue, where only
      // its lone human's server path found no room (the queue may still form a room).
      const back = humans.filter((h) => !this.cancels.has(h.playerId));
      this.requeue(back);
      if (!(e instanceof NoRoom) || (e.code !== 'left' && key.kind !== 'p2p')) this.retryAt.set(k, now + RETRY_AFTER_MS);
      else if (e.code !== 'left') for (const h of back) h.noRoomUntil = now + RETRY_AFTER_MS;
      // do_disabled where no node can host now (hosts 0): their next join is refused, so answer now.
      if (e instanceof NoRoom && e.code === 'do_disabled' && !this.nodesHere(ids, now)) for (const h of back) this.answerWaiting(h);
      this.scheduleSweep();
    } finally {
      for (const h of humans) if (!this.cancels.has(h.playerId)) this.forming.delete(h.playerId);
    }
    for (const h of humans) if (this.cancels.has(h.playerId)) await this.withdraw(h, formed, now);
  }

  /**
   * An authoritative match (bots fill the free slots): phase 1 casual, ranked (balanced `teams`,
   * rated by AccountsDO when it ends, locked there too so one account plays one ranked match
   * across every region) and custom lobbies (fixed `teams`, `matchLengthSeconds`). On a community
   * node when the nodes are on for every human and one takes it (placeOnNode); otherwise a
   * MatchDO, or NoRoom when the nodes were asked and the Worker's own servers are off
   * (do_disabled) or full (MAX_ACTIVE_ROOMS), or one of the humans left meanwhile.
   */
  private async formMatch(mode: GameModeId, humans: readonly HumanEntry[], now: number, opts: FormOptions = {}): Promise<string> {
    // A MatchDO and a community node run the standard physics only (/custom never sends rules here).
    if (opts.physics !== undefined && opts.physics !== null) throw new Error('formMatch: experimental rules are for P2P rooms only');
    const env = this.env;
    const length = opts.matchLengthSeconds ?? matchLengthSeconds(env);
    const until = now + (length > 0 ? length : 20 * 60) * 1000 + ACTIVE_GRACE_MS;
    if (opts.nodes !== false && this.nodesFor(humans.map((h) => h.playerId))) {
      const placed = await this.placeOnNode(mode, humans, now, length, opts);
      if (placed) {
        if (opts.ranked) await this.rankedLock(placed.matchId, humans, until);
        const tickets = new Map(placed.tickets.map((t) => [t.playerId, t.ticket]));
        const names = new Map(humans.map((h) => [h.playerId, h.name]));
        // The node never hears of cars (placeOnNode): its welcome has none, so the result carries them by slot.
        const carOf = new Map(humans.map((h) => [h.playerId, h.car]));
        const cars = carsBySlot(MODES[mode] * 2, placed.tickets.map((t) => ({ slot: t.slot, car: carOf.get(t.playerId) })));
        await this.issue(
          humans,
          placed.tickets.map((t) => ({ slot: t.slot, team: t.team, name: names.get(t.playerId) ?? '', playerId: t.playerId })),
          placed.matchId,
          'node',
          until,
          now,
          (seat) => tickets.get(seat.playerId) as string, // placementFor: one ticket per human
          (ticket) => ({ status: 'matched', matchId: placed.matchId, ticket, wsUrl: placed.wsUrl, node: true, ...(opts.ranked ? { ranked: true } : {}), ...(cars ? { cars } : {}) }) satisfies CosmeticQueueResult,
        );
        return placed.matchId;
      }
      // D9: with do_disabled no MatchDO is created; the humans wait in the queue for a node.
      if (await flag(env, 'do_disabled')) throw new NoRoom('do_disabled');
      if (this.activeRooms(now, 'server') >= MAX_ACTIVE_ROOMS) throw new NoRoom('capacity');
      // One of them left while the node was asked (leave): no MatchDO with it, the others wait on.
      if (humans.some((h) => this.cancels.has(h.playerId))) throw new NoRoom('left');
    }
    const perTeam = MODES[mode];
    const roster: RosterEntry[] = opts.teams ? buildTeamRoster(perTeam, opts.teams, 'player') : buildRoster(perTeam, humans, 'player');
    const id = env.MATCH.newUniqueId();
    const matchId = id.toString();
    const secret = await internalSecret(env.JWT_SECRET);
    const res = await env.MATCH.get(id).fetch('https://match/internal/create', {
      method: 'POST',
      headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
      body: JSON.stringify({ matchId, mode, region: this.region, roster, matchLengthSeconds: length, createdAt: now, ranked: opts.ranked === true }),
    });
    if (!res.ok) throw new Error(`MatchDO create -> ${res.status} ${await res.text()}`);
    if (opts.ranked) await this.rankedLock(matchId, humans, until);
    await this.issue(
      humans,
      roster.filter((e) => e.kind === 'player'),
      matchId,
      'server',
      until,
      now,
      this.mint(matchId, 'player', now),
      (ticket) => ({ status: 'matched', matchId, ticket, wsUrl: '/ws/' + matchId, ...(opts.ranked ? { ranked: true } : {}) }) satisfies QueueResult,
    );
    return matchId;
  }

  /** The ranked lock in AccountsDO: one ranked match per account across every region, until it is rated or cancelled. */
  private async rankedLock(matchId: string, humans: readonly HumanEntry[], until: number): Promise<void> {
    const env = this.env;
    try {
      const secret = await internalSecret(env.JWT_SECRET);
      const lock = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName('accounts-v1')).fetch('https://accounts/ranked-lock', {
        method: 'POST',
        headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
        body: JSON.stringify({ matchId, region: this.region, userIds: humans.map((h) => h.playerId), until }),
      });
      await lock.body?.cancel();
    } catch (e) {
      console.error('matchmaker: ranked lock failed', e); // the region lock (issue) still holds the player here
    }
  }

  /**
   * Read nodes_on / vm_disabled again when NODES_MODE_TTL_MS has passed (no KV read at all while
   * the nodes are not configured). Callers do it before they look at the queues: nodesFor is then
   * synchronous, and no queue changes under them while KV answers. Until a first read is done every
   * caller waits for it (the 'off' it starts from is no value: a canary player the Worker let
   * through do_disabled would get a MatchDO); a later read serves the last value to the others.
   */
  private async readNodes(now: number): Promise<void> {
    if (!nodesConfigured(this.env)) return;
    if (now - this.nodesReadAt >= NODES_MODE_TTL_MS) {
      this.nodesReadAt = now;
      this.nodesRead = nodesMode(this.env).then((mode) => {
        this.nodes = mode;
        this.nodesKnown = true;
      });
      await this.nodesRead;
    } else if (!this.nodesKnown) await this.nodesRead;
  }

  /** The nodes are on for every one of these players (configured, and nodes_on as last read names them all). */
  private nodesFor(playerIds: readonly string[]): boolean {
    return nodesConfigured(this.env) && nodesAllowed(this.nodes, playerIds);
  }

  /**
   * ... and a node may take their match now: this region is one the nodes serve, outside the
   * back-off after hosts 0 or a failed call (NO_HOSTS_BACKOFF_MS). Otherwise there is no node to
   * wait for: the cap applies as without the nodes, and with do_disabled their server / ranked
   * joins are refused (join; formMatch creates no MatchDO for them either).
   */
  private nodesHere(playerIds: readonly string[], now: number): boolean {
    return this.nodesFor(playerIds) && isRegion(this.region) && now >= this.noHostsUntil;
  }

  /**
   * The match on a community node, or null and the caller goes on with a MatchDO: no region the
   * nodes know, the back-off after hosts 0 or a failed call (NO_HOSTS_BACKOFF_MS), no node free,
   * an error, no answer within nodeTimeoutMs, or an answer that is not a placement for exactly
   * these humans. Formation never fails because of the nodes. Stage 1 sends no transports (the
   * default is wss). Each human goes with what the control plane keeps of it and never hands a
   * node: whether it is an account and its age (the rewards weight of a community node's points,
   * ledger.ts; the project's nodes earn nothing) and its car (MatchEntry.humans, for the rejoin's
   * `cars`: the assignment's roster is built field by field, so a node's is the same as without).
   */
  private async placeOnNode(mode: GameModeId, humans: readonly HumanEntry[], now: number, length: number, opts: FormOptions): Promise<Placement | null> {
    const env = this.env;
    if (!nodesConfigured(env) || !isRegion(this.region) || now < this.noHostsUntil) return null;
    const body: PlaceBody = {
      mode,
      region: this.region,
      ranked: opts.ranked === true,
      matchLengthSeconds: length,
      humans: humans.map((h) => ({
        playerId: h.playerId,
        name: h.name,
        ...(h.account === true ? { account: true } : {}),
        ...(h.accountAgeDays !== undefined ? { accountAgeDays: h.accountAgeDays } : {}),
        ...(h.car !== undefined ? { car: h.car } : {}),
      })),
      ...(opts.teams ? { teams: { blue: opts.teams[0].map((h) => h.playerId), red: opts.teams[1].map((h) => h.playerId) } } : {}),
    };
    try {
      const r = await askNodes(env, NODE_ROUTES.place, body, this.nodeTimeoutMs);
      if (r.status !== 200) throw new Error(`place -> ${r.status} ${JSON.stringify(r.body)}`);
      const answer = (r.body ?? {}) as { placement?: unknown; hosts?: unknown };
      if (answer.hosts === 0) this.noHostsUntil = now + NO_HOSTS_BACKOFF_MS;
      if (answer.placement === null || answer.placement === undefined) return null; // no node took it
      const placed = placementFor(answer, humans.map((h) => h.playerId));
      if (placed === null) throw new Error('place: not a placement for these players');
      return placed;
    } catch (e) {
      this.noHostsUntil = now + NO_HOSTS_BACKOFF_MS;
      console.error('matchmaker: node placement failed, a MatchDO instead', e);
      return null;
    }
  }

  /** Phase 2: a RoomDO signaling room; every peer simulates (bots included) from the shared seed. */
  private async formRoom(mode: GameModeId, humans: readonly HumanEntry[], now: number, opts: FormOptions = {}): Promise<string> {
    const env = this.env;
    const slots: RoomSlotRecord[] = opts.teams ? buildTeamRoster(MODES[mode], opts.teams, 'peer') : buildRoster(MODES[mode], humans, 'peer');
    // Experimental rules: every peer seat says whether its player is a guest (RoomDO refuses one).
    const physics = opts.physics ?? null;
    const guestOf = new Map(humans.map((h) => [h.playerId, h.guest]));
    const id = env.ROOM.newUniqueId();
    const roomId = id.toString();
    const seed = randomSeed();
    const secret = await internalSecret(env.JWT_SECRET);
    const res = await env.ROOM.get(id).fetch('https://room/internal/create', {
      method: 'POST',
      headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, mode, region: this.region, seed, slots: physics === null ? slots : slots.map((s) => (s.kind === 'peer' ? { ...s, guest: guestOf.get(s.playerId as string) !== false } : s)), matchLengthSeconds: opts.matchLengthSeconds ?? matchLengthSeconds(env), createdAt: now, physics }),
    });
    if (!res.ok) throw new Error(`RoomDO create -> ${res.status} ${await res.text()}`);
    await this.issue(
      humans,
      slots.filter((e) => e.kind === 'peer'),
      roomId,
      'p2p',
      now + P2P_LOCK_MS,
      now,
      this.mint(roomId, 'peer', now),
      (ticket) => ({ status: 'matched', kind: 'p2p', roomId, ticket, wsUrl: '/room/' + roomId }) satisfies QueueResultP2p,
      opts.physics !== undefined && opts.physics !== null,
    );
    return roomId;
  }

  /** The Worker's own ticket for a seat of MatchDO / RoomDO `id` (a node match comes with the control plane's). */
  private mint(id: string, role: TicketRole, now: number): (seat: Seat & { playerId: string }) => Promise<string> {
    return (e) => createTicket(this.env.JWT_SECRET, { sub: e.playerId, mid: id, team: e.team, slot: e.slot, name: e.name, role }, now);
  }

  /**
   * Register the match / room, lock its humans (a lock of `kind`), give each seat its ticket
   * (`ticketFor`), cache the results and answer their long-polls. A node match is none of the
   * Worker's rooms: it never counts toward MAX_ACTIVE_ROOMS. `experimental`: a P2P room with
   * experimental rules (its locks and capacity entry are marked: no no-show strikes).
   */
  private async issue(
    humans: ReadonlyArray<HumanEntry & { resolvers?: Waiter['resolvers'] }>,
    seats: ReadonlyArray<Seat>,
    id: string,
    kind: LockKind,
    until: number,
    now: number,
    ticketFor: (seat: Seat & { playerId: string }) => Promise<string> | string,
    makeResult: (ticket: string) => AnyQueueResult,
    experimental = false,
  ): Promise<void> {
    if (kind !== 'node') {
      const entry: RoomEntry = { until, kind };
      if (experimental) entry.exp = true;
      this.rooms.set(id, entry);
      await this.ctx.storage.put('room:' + id, entry);
    }
    for (const e of seats) {
      if (!e.playerId) continue;
      const ticket = await ticketFor({ ...e, playerId: e.playerId });
      this.matched.set(e.playerId, { result: makeResult(ticket), until: now + MATCHED_TTL_MS, delivered: false });
      const lock: ActiveMatch = { matchId: id, until, kind, since: now };
      if (experimental) lock.exp = true;
      this.active.set(e.playerId, lock);
      await this.ctx.storage.put('active:' + e.playerId, lock);
    }
    for (const h of humans) {
      const r = this.matched.get(h.playerId);
      // No long-poll pending: the next join / poll delivers it. One that left meanwhile gets nothing (withdraw).
      if (!r || !h.resolvers || h.resolvers.length === 0 || this.cancels.has(h.playerId)) continue;
      r.delivered = true;
      this.markDelivered(h.playerId, id);
      for (const resolve of h.resolvers) resolve(r.result);
      h.resolvers.length = 0;
    }
  }
}

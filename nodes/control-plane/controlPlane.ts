/**
 * ControlPlane: the orchestration that will live in the NodeRegistryDO. Transport-agnostic: it
 * talks to nodes through NodeLink (a WebSocket in both the reference server and workerd) and gets
 * its clock, keys, ICE servers and storage injected. The reference server (devServer.ts) wires it to
 * node:http; docs/INTEGRACION.md lists what the Worker will wire instead.
 *
 * Responsibilities
 *   sessions      challenge / response login of nodes, one live session per node, request/reply.
 *                 Every message is shape-checked (validate.ts) before anything reads it.
 *   reachability  'wss': GET <publicUrl>/healthz?nonce= signed by the node, again every 5 minutes
 *                 (failing three times in a row takes wss out of placement, with an ALERT); 'rtc':
 *                 the node's WebRTC self-test through TURN. pending -> probation (trusted -> active)
 *   placement     scheduler.pickNode -> 'assign' -> EdDSA tickets + the URL for the transport
 *   signaling     a player's WebRTC offer relayed to an rtc node (ticket checked on both ends)
 *   leaves        a player's explicit quit relayed to the node (MatchDO /internal/leave semantics);
 *                 the verifier only accepts takeovers of players whose leave went through here
 *   results       report + replay -> verification queue (trusted verifier nodes, e.g. the Sao
 *                 Paulo VPS; in-process only in the reference server) -> outcome (rated / unrated /
 *                 void) for AccountsDO + ledger points + shop wallet. The outcome is built from the
 *                 VERDICT (end reason, score, leaves, present minutes), never from the node's word.
 *                 What is verified (verifyRateOf): EVERY ranked match, since protecting the ranking
 *                 is the point of verifying. Casual matches only by sample: all of a node's while
 *                 it is on probation (they are its way into ranked), casualVerifyRate of an active
 *                 node's (an audit; only sampled matches earn points, worth 1 / rate), none of a
 *                 project node's.
 *   health        silent or restarted nodes: their matches are void (no penalties for players), one
 *                 strike per outage; strike suspensions lift after their cooldown
 *   persistence   every durable change of a match is written through `store` (persist.ts) before
 *                 the message that depends on it goes out: a Durable Object holds its outgoing
 *                 messages only for the writes issued before the send. `restore` loads the rows back
 *                 after a restart; a cold start (a deploy) gives the nodes `restartGraceMs` to
 *                 reconnect before anything is voided for being silent or late.
 */
import {
  HEARTBEAT_TIMEOUT_MS,
  sameSimulation,
  HOST_FAULT_CODES,
  RPC_TIMEOUT_MS,
  RTC_OFFER_TIMEOUT_MS,
  TTL_AFTER_MATCH_SECONDS,
  VERIFY_TIMEOUT_MS,
  authMessage,
  compareVersions,
  reachMessage,
  replayRequestMessage,
  rtcMatchUrl,
  sameBuild,
} from '../shared/controlProtocol';
import type {
  AssignAnswer,
  BuildId,
  Difficulty,
  GameMode,
  IceServer,
  LeaveAnswer,
  MatchAssignment,
  MatchReport,
  NodeStatus,
  NodeTransport,
  ReleaseChannel,
  RosterEntry,
  RtcAnswer,
  ToNode,
  VerifyJob,
  VerifyVerdict,
} from '../shared/controlProtocol';
import { importPrivateKey, importPublicKey, randomB64, randomHexId, sha256Hex, verifyWith } from '../shared/edcrypto';
import { createNodeTicket, verifyNodeTicket } from '../shared/nodeTickets';
import { TICK_RATE } from '../../src/sim/types';
import { regionFactor } from './ledger';
import type { Ledger, LedgerEntry, LedgerPlayer } from './ledger';
import { matchFromRow } from './persist';
import type { MatchRow, MatchStore } from './persist';
import { MAX_CAPACITY, usableTransports } from './registry';
import type { Registry, NodeRecord } from './registry';
import { ineligibility, pickNode, pickVerifier, transportFor } from './scheduler';
import type { Shop } from './shop';
import { parseFromNode, parseHeartbeat, parseHello, parseReport, reportMatchId } from './validate';

const MODES: Record<GameMode, number> = { '1v1': 1, '2v2': 2, '3v3': 3 };
const AUTH_TIMEOUT_MS = 10_000;
/**
 * Sockets still to log in, each holding an auth timer on the one control plane: one more closes
 * the oldest (1013, try again later), so a flood of upgrades cannot stall the nodes' heartbeats. A
 * node logs in within one round trip: to push it out, a flood must open this many in that time.
 */
export const MAX_UNAUTHENTICATED = 64;
/** A placed match with no report this long after its regulation + TTL is void. */
const REPORT_GRACE_MS = 15 * 60_000;
/** Unproven wss hosts are probed again this often while connected; so is a proven one after a failed re-probe. */
const PROBE_RETRY_MS = 30_000;
/**
 * Proven wss hosts are probed again this often while connected: an expired certificate or a dead
 * proxy would otherwise keep players landing on a node they cannot open (close code 1006).
 */
export const REPROBE_MS = 5 * 60_000;
/** Failed re-probes in a row that take a host's wss out of placement until a probe passes again. */
export const REPROBE_FAILURES = 3;
/** A queued verification is retried this often while no verifier can take it. */
const VERIFY_RETRY_MS = 15_000;
/** Ranked results wait this long for a verifier (e.g. the Sao Paulo VPS rebooting) before the match is void. */
export const VERIFY_MAX_WAIT_MS = 6 * 60 * 60 * 1000;
/** MatchDO's ranked join window when the assignment does not set one. */
const DEFAULT_JOIN_MS = 45_000;
/** A community node's ranked 'cancelled' report must arrive within the join window plus this. */
const CANCEL_SLACK_MS = 30_000;
/** A 'ttl' ending is accepted this long before the TTL by the control plane's clock (report latency, clock skew). */
const TTL_SLACK_MS = 60_000;
/** Finished matches stay in memory this long (status pages, late replies), then only the outcome remains downstream. */
const DONE_RETENTION_MS = 10 * 60_000;
/** Share of an active community node's casual matches that are verified (and earn points, worth 1 / rate). */
export const CASUAL_VERIFY_RATE = 0.2;
/** Matches the matchmaker could not place on a node count as demand for this long. */
const UNPLACED_WINDOW_MS = 15 * 60_000;
/** Strikes closer together than this count once: one outage (a stop, a crash, a restart) is one strike, however many matches it took. */
const STRIKE_DEDUPE_MS = 60_000;
/** An honest ranked 'no_show' comes when the join window closes; this much earlier is accepted (clock skew). */
const NO_SHOW_SKEW_MS = 5_000;
/** A casual match starts at most this long after its assignment (MatchDO: 90 s unused + 5 s start grace). */
const CASUAL_START_WINDOW_MS = 95_000;
/** Simulation time a node may lose to stalls (the tick loop clamps long gaps). */
const STALL_SLACK_S = 30;
/** Network and clock slack between the control plane relaying a leave and the node applying it. */
const LEAVE_SLACK_S = 5;
/** A ranked 'empty' is the node's fault (a strike) only when every human vanished within this many ticks. */
const EMPTY_TOGETHER_TICKS = 240;
/**
 * After a cold start with unfinished matches, nothing is voided for being silent or late this
 * long: the nodes lost their control link with the old process and need it to reconnect. The
 * agent's backoff doubles from 1 s to a 30 s cap, +-25 %: six tries take about 76 s at worst.
 */
export const RESTART_GRACE_MS = 90_000;
/**
 * A trusted node's matches outlive its silence this long (a community node's: HEARTBEAT_TIMEOUT_MS,
 * for now). A short drop of its control link does not stop the matches it hosts: voiding them
 * would have players finish a ranked match that already counts for nothing. If the same process
 * reconnects in time (its backoff: 1, 2, 4, 8, 16 s) they go on; a new one voids them at its hello.
 */
export const TRUSTED_OFFLINE_MS = 60_000;

/** A request to a node without its correlation id (distributive Omit over the request variants). */
type RpcRequest = Extract<ToNode, { rid: string }> extends infer U ? (U extends unknown ? Omit<U, 'rid'> : never) : never;

/** One side of a node's control WebSocket. */
export interface NodeLink {
  send(msg: ToNode): void;
  close(code: number, reason: string): void;
}

export interface Human {
  playerId: string;
  name: string;
  /** Registered account (rewards weight) and its age. Guests: false / 0. */
  account?: boolean;
  accountAgeDays?: number;
}

export interface PlaceRequest {
  mode: GameMode;
  region: string;
  ranked: boolean;
  humans: Human[];
  /** Fixed teams (ranked balanceTeams, custom lobby picks): the same order MatchmakerDO.buildTeamRoster uses. Absent: humans alternate. */
  teams?: { blue: string[]; red: string[] };
  matchLengthSeconds: number;
  /** Transports EVERY player's client supports (default ['wss']: clients without the WebRTC adapter). */
  transports?: NodeTransport[];
  botDifficulty?: Difficulty;
  kickoffCountdownSeconds?: number;
  goalPauseSeconds?: number;
  joinTimeoutMs?: number;
}

export interface PlayerTicket {
  playerId: string;
  slot: number;
  team: 0 | 1;
  ticket: string;
}

export interface Placement {
  matchId: string;
  nodeId: string;
  nodeName: string;
  transport: NodeTransport;
  /** wss: the node itself; rtc: <site>/nodes/rtc/<node>/<match>, which the WebRTC socket adapter recognises. */
  wsUrl: string;
  tickets: PlayerTicket[];
}

/** What the Worker does with a finished match (the AccountsDO calls of MatchDO.reportRanked / cancelRanked). */
export type MatchOutcome =
  | { kind: 'rated'; matchId: string; playlist: GameMode; region: string; winner: 0 | 1 | -1; blue: number; red: number; players: Array<{ id: string; team: 0 | 1; left: boolean }>; nodeId: string }
  /** A casual match. `verified`: re-simulated (sampled); otherwise the score is the node's word, which decides nothing. */
  | { kind: 'unrated'; matchId: string; nodeId: string; blue: number; red: number; verified: boolean }
  | { kind: 'void'; matchId: string; nodeId: string; ranked: boolean; reason: string; players: string[]; noShows: string[] };

/** assigned -> (report received) reporting -> verifying -> done; or straight to done (void). */
export type MatchState = 'assigned' | 'reporting' | 'verifying' | 'done';

/**
 * rejoin(): a fresh ticket, or why not. The Worker answers 404 for no_match and not_in_match, 410
 * for left and match_over (it keeps the player's lock only on 'left': the match goes on without
 * them), 503 for offline (it keeps the lock: the node may come back).
 */
export type RejoinAnswer = { ok: true; ticket: string; wsUrl: string } | { ok: false; code: 'no_match' | 'not_in_match' | 'left' | 'match_over' | 'offline' };

/**
 * leave() resolved: the leave is recorded (the Worker answers 200 and frees the lock), whatever
 * the node answered. `answer` is the node's; null when the relay failed (`error`: timeout,
 * disconnected, or the node's refusal), and then the node may or may not have applied it.
 */
export interface LeaveResult {
  recorded: true;
  answer: LeaveAnswer | null;
  error?: string;
}

/** A refused replay upload: the HTTP status and error code the Worker answers. */
export type ReplayRefusal = { ok: false; status: number; code: string };

export interface MatchEntry {
  assign: MatchAssignment;
  nodeId: string;
  transport: NodeTransport;
  humans: Human[];
  /** The build the match was placed on (node = clients): only a verifier on it can re-simulate the replay. */
  build: BuildId;
  /** The node process that took the match (hello.bootId): a restarted node lost it. */
  bootId: string | null;
  state: MatchState;
  /** Players whose leave was relayed to the node: the only takeovers the replay may contain. */
  leaves: Set<string>;
  /** When each leave was relayed (the control plane's clock): its takeover must fall in the matching tick window. */
  leaveAt: Map<string, number>;
  /** Players whose client said it never got into the match when it left (cancel while connecting): never a dodge. */
  neverJoined: Set<string>;
  /** The node's own heartbeat showed this match ticking: it started, so it can no longer be 'cancelled'. */
  startedSeen: boolean;
  /** Leaves the node accepted (before the end). */
  left: Set<string>;
  /** rtc: players who presented their ticket with a WebRTC offer (evidence they tried to join). */
  offered: Set<string>;
  /** SHA-256 of the replay the node uploaded (null until then): checked against every 'ended' report, sampled or not. */
  replaySha: string | null;
  /** Region factor when the match was placed (demand includes this match). */
  regionFactor: number;
  /** The chance this kind of match had of being verified (1 ranked / probation; casualVerifyRate; 0), set at the report. */
  verifyRate: number;
  report: MatchReport | null;
  /** When the report arrived (the control plane's clock). */
  reportedAt: number;
  verdict: VerifyVerdict | null;
  verifiedBy: string | null;
  outcome: MatchOutcome | null;
  ledger: LedgerEntry | null;
  /** When the control plane gives up waiting for a report. */
  deadline: number;
  /** Verification queue: when the job was queued, the last dispatch attempt, a dispatch in flight. */
  queuedAt: number;
  lastTry: number;
  inFlight: boolean;
  doneAt: number;
}

export interface ControlPlaneOptions {
  /** PKCS#8 / raw base64url Ed25519 pair that signs tickets (the private half is a Worker secret). */
  controlPrivateKey: string;
  controlPublicKey: string;
  /** ws(s)://.../nodes/connect and http(s)://... base handed to nodes at registration. */
  controlUrl: string;
  httpBase: string;
  /** The site players load the game from (rtc match URLs); default httpBase. */
  siteBase?: string;
  /** The build the current web client runs: nodes must match it to get matches. */
  build: () => BuildId;
  /** The release channel (channel.json in R2). Checked at every use: a bad one never throws, see channel(). */
  channel: () => ReleaseChannel;
  registry: Registry;
  ledger: Ledger;
  shop?: Shop;
  /** STUN + short-lived TURN credentials (production: Cloudflare Realtime TURN, like /api/ice). */
  iceServers?: (purpose: 'node' | 'player') => Promise<IceServer[]>;
  /**
   * rtc nodes must pass their self-test THROUGH TURN to get matches (default true). Only the local
   * reference server without TURN turns it off: there a plain self-test is accepted.
   */
  requireRelay?: boolean;
  /** Share of an active community node's casual matches that are verified (default CASUAL_VERIFY_RATE). Ranked: always. */
  casualVerifyRate?: number;
  /** Verification in-process when no trusted verifier node is online (the reference server does). */
  inlineVerify?: (bytes: Uint8Array, job: VerifyJob) => Promise<VerifyVerdict>;
  /** GET <url> returning JSON (reachability probe); injectable for tests. */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Replay storage (R2 in production). */
  replays: { put(matchId: string, bytes: Uint8Array): Promise<void>; get(matchId: string): Promise<Uint8Array | null> };
  onOutcome?: (o: MatchOutcome, m: MatchEntry) => void;
  /** Where match changes are written as they happen, each before the message that depends on it (none: memory only). */
  store?: MatchStore;
  /** How long a cold start with unfinished matches waits for the nodes (default RESTART_GRACE_MS). */
  restartGraceMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** A control-plane request the node refused. */
export class NodeRefused extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export class Session {
  readonly link: NodeLink;
  nodeId: string | null = null;
  readonly nonce = randomB64(24);
  closed = false;
  readonly pending = new Map<string, Pending>();
  authTimer: ReturnType<typeof setTimeout> | null = null;
  verifying = 0;
  constructor(link: NodeLink) {
    this.link = link;
  }
}

/** Same slot order as MatchmakerDO.buildRoster: blue humans, blue bots, red humans, red bots; humans alternate teams. */
export function buildRoster(perTeam: number, humans: readonly Human[]): RosterEntry[] {
  const blue: Human[] = [];
  const red: Human[] = [];
  humans.forEach((h, i) => (i % 2 === 0 ? blue : red).push(h));
  return rosterOf(perTeam, blue, red);
}

/** MatchmakerDO.buildTeamRoster: the given teams (ids in `teams` order), bots fill the rest. */
export function buildTeamRoster(perTeam: number, humans: readonly Human[], teams: { blue: string[]; red: string[] }): RosterEntry[] {
  const byId = new Map(humans.map((h) => [h.playerId, h]));
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((h): h is Human => h !== undefined);
  const blue = pick(teams.blue);
  const red = pick(teams.red);
  if (blue.length > perTeam || red.length > perTeam || blue.length + red.length !== humans.length || new Set([...teams.blue, ...teams.red]).size !== humans.length) {
    throw new Error('bad teams');
  }
  return rosterOf(perTeam, blue, red);
}

function rosterOf(perTeam: number, blue: Human[], red: Human[]): RosterEntry[] {
  const roster: RosterEntry[] = [];
  const add = (team: 0 | 1, hs: Human[]) => {
    for (const h of hs) roster.push({ slot: roster.length, team, kind: 'player', name: h.name, playerId: h.playerId });
    for (let b = hs.length; b < perTeam; b++) roster.push({ slot: roster.length, team, kind: 'bot', name: `Bot ${b + 1}` });
  };
  add(0, blue);
  add(1, red);
  return roster;
}

/** A uniform number in [0, 1) from the platform's CSPRNG (sampling and verifier picks must not be predictable). */
function randomUnit(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
}

function httpOf(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

/** A release version as builds carry it (validate.parseBuild's rule). */
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
/** No channel known: nobody is below the minimum, so nobody is told to update. */
const NO_CHANNEL: ReleaseChannel = { stable: '0.0.0', minimum: '0.0.0' };

/** The channel the control plane can compare versions against, with nothing else in it, or null. */
function cleanChannel(v: unknown): ReleaseChannel | null {
  if (typeof v !== 'object' || v === null) return null;
  const { stable, minimum, canary } = v as Record<string, unknown>;
  if (typeof stable !== 'string' || !VERSION.test(stable) || typeof minimum !== 'string' || !VERSION.test(minimum)) return null;
  return { stable, minimum, ...(typeof canary === 'string' && VERSION.test(canary) ? { canary } : {}) };
}

/** A short, log-safe picture of a value. */
function describe(v: unknown): string {
  try {
    return String(JSON.stringify(v)).slice(0, 80);
  } catch {
    return typeof v;
  }
}

/**
 * Why a reachability probe failed, fit for a log line. The node writes the answer, and a JSON
 * error quotes it (newlines and all): its words must not become lines of their own, ALERTs for
 * the maintainers among them.
 */
function probeFailure(e: unknown): string {
  if (e instanceof SyntaxError) return 'bad json';
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'timeout';
  return String(e).replace(/[^\x20-\x7e]+/g, ' ').slice(0, 120);
}

export class ControlPlane {
  readonly registry: Registry;
  readonly ledger: Ledger;
  readonly shop: Shop | null;
  readonly matches = new Map<string, MatchEntry>();
  private readonly o: ControlPlaneOptions;
  private readonly sessions = new Map<string, Session>();
  /** Sessions that have not logged in yet: at most MAX_UNAUTHENTICATED. */
  private readonly unauthenticated = new Set<Session>();
  /** When the cap last closed a socket (logged once a minute). */
  private lastBusyLog = 0;
  private readonly key: Promise<CryptoKey>;
  private readonly pub: Promise<CryptoKey>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly requireRelay: boolean;
  private readonly casualVerifyRate: number;
  private readonly probing = new Set<string>();
  private readonly lastProbe = new Map<string, number>();
  /** Failed re-probes in a row of proven hosts, and the hosts they took out (for the recovery line). */
  private readonly probeFailures = new Map<string, number>();
  private readonly unreachable = new Set<string>();
  private readonly deferredUpdates = new Set<string>();
  private readonly lastStrike = new Map<string, number>();
  /** Matches the matchmaker asked for and no node could take (region, when): demand the nodes did not meet. */
  private unplaced: Array<{ region: string; at: number }> = [];
  private readonly restartGraceMs: number;
  /** Until then a cold start waits for its nodes: see inGrace(). */
  private graceUntil = 0;
  /**
   * When restore() ran (0: never). A restored node's lastSeen is 0, so its silence counts from
   * here; and a report the restart held up is judged as if it had arrived then.
   */
  private restoredAt = 0;
  /** The last valid release channel, and whether a bad one was already alerted. */
  private goodChannel: ReleaseChannel | null = null;
  private channelAlerted = false;

  constructor(o: ControlPlaneOptions) {
    this.o = o;
    this.registry = o.registry;
    this.ledger = o.ledger;
    this.shop = o.shop ?? null;
    this.key = importPrivateKey(o.controlPrivateKey);
    // A key that does not import fails each place() and rejoin() that needs it, not the process:
    // nothing else awaits it, and an unhandled rejection would end the reference server.
    this.key.catch(() => undefined);
    this.pub = importPublicKey(o.controlPublicKey);
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(`[control] ${m}`));
    this.requireRelay = o.requireRelay !== false;
    const rate = o.casualVerifyRate ?? CASUAL_VERIFY_RATE;
    this.casualVerifyRate = Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : CASUAL_VERIFY_RATE;
    this.restartGraceMs = o.restartGraceMs ?? RESTART_GRACE_MS;
  }

  // ---- persistence --------------------------------------------------------------------------

  /** Write a match through the store. Call it before sending anything that depends on the change. */
  private save(m: MatchEntry): void {
    this.o.store?.save(m);
  }

  /**
   * Load the match rows written through `store` into a fresh control plane, after its registry
   * restored the nodes. `cold`: the process started without the nodes' sockets (a deploy or a
   * crash drops them; a hibernation keeps them, and they are adopt()ed instead). Then, while some
   * match is unfinished, nothing is voided for being silent or late until restartGraceMs passed:
   * the same node process reconnects and keeps its matches; a new one voids them at its hello.
   */
  restore(rows: MatchRow[], opts: { cold: boolean }): void {
    this.matches.clear();
    for (const r of rows) {
      const m = matchFromRow(r);
      this.matches.set(m.assign.matchId, m);
    }
    // One outage is one strike across a restart too: the last strike of each node is its newest strike time.
    this.lastStrike.clear();
    for (const n of this.registry.list()) {
      const last = n.strikeTimes[n.strikeTimes.length - 1];
      if (last !== undefined) this.lastStrike.set(n.nodeId, last);
    }
    const open = this.unfinished();
    this.restoredAt = this.now();
    this.graceUntil = opts.cold && open > 0 ? this.restoredAt + this.restartGraceMs : 0;
    this.log(`restored ${rows.length} matches (${open} unfinished)${this.graceUntil > 0 ? `: ${Math.round(this.restartGraceMs / 1000)} s for the nodes to reconnect` : ''}`);
  }

  /** Matches not settled yet (assigned, reporting, verifying): the DO keeps its alarm while there are any. */
  unfinished(): number {
    let n = 0;
    for (const m of this.matches.values()) if (m.state !== 'done') n++;
    return n;
  }

  /**
   * A cold start is still waiting for its nodes: the sweep voids no match of a silent node and
   * none past its report deadline, and the verification queue gives up on nothing. Cooldowns,
   * probes, the purge and verification dispatch go on.
   */
  inGrace(): boolean {
    return this.now() < this.graceUntil;
  }

  private ice(purpose: 'node' | 'player'): Promise<IceServer[]> {
    return this.o.iceServers ? this.o.iceServers(purpose).catch(() => []) : Promise.resolve([]);
  }

  // ---- sessions -----------------------------------------------------------------------------

  /** A node opened /nodes/connect. Feed its messages to onMessage(session, text); call onClose when it goes. */
  open(link: NodeLink): Session {
    const s = new Session(link);
    if (this.unauthenticated.size >= MAX_UNAUTHENTICATED) {
      // The oldest goes, not the newcomer: refusing new sockets would let idle ones, reopened as
      // they time out, keep every node from logging in (after a deploy, all of them at once).
      const now = this.now();
      if (now - this.lastBusyLog >= 60_000) {
        this.lastBusyLog = now;
        this.log(`${MAX_UNAUTHENTICATED} sockets still to log in: closing the oldest`);
      }
      const oldest = this.unauthenticated.values().next().value;
      if (oldest) {
        oldest.link.close(1013, 'busy');
        this.onClose(oldest);
      }
    }
    this.unauthenticated.add(s);
    link.send({ t: 'challenge', nonce: s.nonce });
    s.authTimer = setTimeout(() => {
      if (s.nodeId) return;
      link.close(4401, 'auth timeout');
      this.onClose(s); // its place under the cap is free even if the close event never comes
    }, AUTH_TIMEOUT_MS);
    return s;
  }

  /**
   * A node socket that outlived a hibernation of the Durable Object, logged in before it (the
   * socket's `{ nodeId }` attachment): an authenticated session again, with no new challenge.
   * Sessions live in memory, so without this the first message after a wake would hit 'auth
   * first'. An unknown or banned node is closed with 4401 (null). The node is live from the
   * adoption: placement sees it, and the heartbeat timeout closes the socket if the node behind it
   * hung or died meanwhile. Its next heartbeat brings its live fields back.
   */
  adopt(link: NodeLink, nodeId: string): Session | null {
    const n = this.registry.node(nodeId);
    if (!n || n.status === 'banned') {
      link.close(4401, 'unknown node');
      return null;
    }
    const s = new Session(link);
    s.nodeId = nodeId;
    const old = this.sessions.get(nodeId);
    if (old) {
      old.link.close(4000, 'replaced');
      this.onClose(old);
    }
    this.sessions.set(nodeId, s);
    this.registry.adopted(nodeId, this.now());
    return s;
  }

  onClose(s: Session): void {
    s.closed = true;
    this.unauthenticated.delete(s);
    if (s.authTimer) clearTimeout(s.authTimer);
    for (const p of s.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new NodeRefused('disconnected'));
    }
    s.pending.clear();
    if (s.nodeId && this.sessions.get(s.nodeId) === s) {
      this.sessions.delete(s.nodeId);
      this.registry.disconnected(s.nodeId);
    }
  }

  /** One text frame from a node. Never throws for anything the node sends; a storage failure while handling a report rejects (no ack: the node sends it again). */
  async onMessage(s: Session, text: string): Promise<void> {
    if (s.closed) return; // a socket the control plane already let go (pushed out by the cap, replaced, timed out)
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return s.link.close(1008, 'bad json');
    }
    const m = parseFromNode(raw);
    if (!m) return s.link.close(1008, 'bad message');
    if (!s.nodeId) {
      if (m.t !== 'auth') return s.link.close(4401, 'auth first');
      return this.auth(s, m.nodeId, m.sig);
    }
    const nodeId = s.nodeId;
    switch (m.t) {
      case 'hello': {
        const hello = parseHello(m.data, MAX_CAPACITY);
        if (!hello) return s.link.close(1008, 'bad hello');
        const prevBoot = this.registry.node(nodeId)?.bootId ?? null;
        const changed = this.registry.connected(nodeId, hello, this.now(), { requireRelay: this.requireRelay });
        if (prevBoot !== null && hello.bootId && hello.bootId !== prevBoot) {
          // A new process: every match the old one held is gone.
          this.voidMatchesOf(nodeId, 'node_restarted', (x) => x.state === 'assigned' && x.bootId === prevBoot);
        }
        if (changed) this.notifyStatus(nodeId, changed);
        void this.probe(nodeId);
        this.maybeUpdate(nodeId);
        if (this.registry.node(nodeId)?.roles.includes('verify')) this.pump(true); // a verifier just came up: retry now
        return;
      }
      case 'heartbeat': {
        const hb = parseHeartbeat(m.data, MAX_CAPACITY);
        if (!hb) return s.link.close(1008, 'bad heartbeat');
        this.registry.heartbeat(nodeId, hb, this.now());
        for (const x of hb.matches) {
          const m = x.tick > 0 ? this.matches.get(x.matchId) : undefined;
          if (m && m.nodeId === nodeId && !m.startedSeen) {
            m.startedSeen = true;
            this.save(m); // once per match, not per heartbeat
          }
        }
        return;
      }
      case 'reply': {
        const p = s.pending.get(m.rid);
        if (!p) return;
        s.pending.delete(m.rid);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m.data);
        else p.reject(new NodeRefused(String(m.code).slice(0, 32), typeof m.message === 'string' ? m.message.slice(0, 200) : undefined));
        return;
      }
      case 'report': {
        const r = parseReport(m.report);
        if (!r) {
          const id = reportMatchId(m.report);
          if (id) this.badReport(nodeId, id);
        } else if (!(await this.onReport(nodeId, r))) {
          return; // the first copy is still being processed: no ack, the node sends it again
        } // (onReport throws on a storage failure: no ack either)
        if (!s.closed) s.link.send({ t: 'ack', id: m.id });
        return;
      }
      default:
        return;
    }
  }

  private async auth(s: Session, nodeId: unknown, sig: unknown): Promise<void> {
    if (typeof nodeId !== 'string' || typeof sig !== 'string' || nodeId.length > 32 || sig.length > 200) return s.link.close(4401, 'bad auth');
    const n = this.registry.node(nodeId);
    if (!n || !(await verifyWith(n.publicKey, authMessage(nodeId, s.nonce), sig))) return s.link.close(4401, 'bad auth');
    if (n.status === 'banned') {
      s.link.send({ t: 'error', code: 'banned' });
      return s.link.close(4403, 'banned');
    }
    if (s.closed) return;
    if (s.authTimer) clearTimeout(s.authTimer);
    this.unauthenticated.delete(s);
    const old = this.sessions.get(nodeId);
    if (old && old !== s) {
      old.link.close(4000, 'replaced');
      this.onClose(old);
    }
    s.nodeId = nodeId;
    this.sessions.set(nodeId, s);
    const iceServers = n.transports.includes('rtc') ? await this.ice('node') : [];
    if (s.closed) return;
    s.link.send({ t: 'welcome', nodeId, status: n.status, region: n.region, channel: this.channel(), serverTime: this.now(), iceServers });
  }

  private call<T>(nodeId: string, msg: RpcRequest, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    const s = this.sessions.get(nodeId);
    if (!s || s.closed) return Promise.reject(new NodeRefused('offline'));
    const rid = randomHexId(8);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        s.pending.delete(rid);
        reject(new NodeRefused('timeout'));
      }, timeoutMs);
      s.pending.set(rid, { resolve: resolve as (v: unknown) => void, reject, timer });
      s.link.send({ ...msg, rid } as ToNode);
    });
  }

  private notify(nodeId: string, msg: ToNode): void {
    const s = this.sessions.get(nodeId);
    if (s && !s.closed) s.link.send(msg);
  }

  private notifyStatus(nodeId: string, status: NodeStatus): void {
    const n = this.registry.node(nodeId);
    this.notify(nodeId, { t: 'status', status, ...(n?.statusReason ? { reason: n.statusReason } : {}) });
  }

  isOnline(nodeId: string): boolean {
    return this.sessions.has(nodeId);
  }

  // ---- reachability / versions ------------------------------------------------------------------

  /** Prove a wss node's publicUrl: GET /healthz?nonce=, the node signs the nonce with its key. */
  async probe(nodeId: string): Promise<boolean> {
    const n = this.registry.node(nodeId);
    if (!n || !n.roles.includes('host') || !n.transports.includes('wss') || !n.publicUrl || n.reachableAt !== null || this.probing.has(nodeId)) return n?.reachableAt != null;
    const error = await this.healthz(n, n.publicUrl);
    if (error !== null) {
      this.log(`probe ${n.name} failed: ${error}`);
      return false;
    }
    const changed = this.registry.markReachable(nodeId, this.now());
    if (changed) this.notifyStatus(nodeId, changed);
    this.probeFailures.delete(nodeId);
    if (this.unreachable.delete(nodeId)) this.log(`node ${n.name} reachable again at ${n.publicUrl}`);
    else this.log(`probe ${n.name}: reachable at ${n.publicUrl}`);
    return true;
  }

  /**
   * Check a proven wss host again (the sweep does every REPROBE_MS; a maintainer may ask for one).
   * REPROBE_FAILURES failures in a row take wss out of its transports (registry.markUnreachable)
   * with an ALERT; from then on it is an unproven host again, probed every PROBE_RETRY_MS until
   * one passes. A failure is retried after PROBE_RETRY_MS too, so a dead host is out within about
   * a minute, not fifteen. Resolves whether wss still reaches the node.
   */
  async reprobe(nodeId: string): Promise<boolean> {
    const n = this.registry.node(nodeId);
    if (!n || !n.roles.includes('host') || !n.transports.includes('wss') || !n.publicUrl || n.reachableAt === null || this.probing.has(nodeId)) return n?.reachableAt != null;
    const url = n.publicUrl;
    const error = await this.healthz(n, url);
    if (error === null) {
      this.probeFailures.delete(nodeId);
      return true;
    }
    // A hello with a new address meanwhile: that one gets proven from scratch.
    if (n.reachableAt === null || n.publicUrl !== url) return n.reachableAt !== null;
    const failures = (this.probeFailures.get(nodeId) ?? 0) + 1;
    this.log(`probe ${n.name} failed (${failures} of ${REPROBE_FAILURES}): ${error}`);
    if (failures < REPROBE_FAILURES) {
      this.probeFailures.set(nodeId, failures);
      return true;
    }
    this.probeFailures.delete(nodeId);
    this.registry.markUnreachable(nodeId);
    this.unreachable.add(nodeId);
    this.log(`ALERT node ${n.name} unreachable at ${url}: ${error}`);
    return false;
  }

  /** GET <url>/healthz?nonce= and check the node signed the nonce: null when it did, or what went wrong. */
  private async healthz(n: NodeRecord, url: string): Promise<string | null> {
    this.probing.add(n.nodeId);
    this.lastProbe.set(n.nodeId, this.now());
    try {
      const nonce = randomB64(18);
      const get = this.o.fetchJson ?? (async (u: string) => (await fetch(u, { signal: AbortSignal.timeout(5_000) })).json());
      const body = (await get(`${httpOf(url)}/healthz?nonce=${nonce}`)) as { nodeId?: unknown; sig?: unknown };
      if (body?.nodeId !== n.nodeId || typeof body.sig !== 'string' || !(await verifyWith(n.publicKey, reachMessage(n.nodeId, nonce), body.sig))) return 'bad answer';
      return null;
    } catch (e) {
      return probeFailure(e);
    } finally {
      this.probing.delete(n.nodeId);
    }
  }

  /**
   * Nodes older than the channel minimum get an 'update' (they drain and restart on the new
   * release). A trusted verifier waits while matches PLAYED on its build still need verifying: once
   * it moves to the new build, nobody could re-simulate them.
   */
  maybeUpdate(nodeId: string): void {
    const n = this.registry.node(nodeId);
    const ch = this.channel();
    if (!n || compareVersions(n.build.version, ch.minimum) >= 0) {
      this.deferredUpdates.delete(nodeId);
      return;
    }
    if (n.trusted && n.roles.includes('verify') && this.workOnBuild(n.build)) {
      if (!this.deferredUpdates.has(nodeId)) this.log(`update of verifier ${n.name} deferred: matches on its build still need verifying`);
      this.deferredUpdates.add(nodeId);
      return;
    }
    this.deferredUpdates.delete(nodeId);
    this.notify(nodeId, { t: 'update', version: ch.stable });
  }

  /**
   * The release channel changed (the DO re-reads channel.json): nodes below the new minimum get
   * their 'update' now, not at their next hello. A trusted verifier with matches of its build still
   * to verify waits, as it would at a hello.
   */
  channelChanged(): void {
    for (const id of this.sessions.keys()) this.maybeUpdate(id);
  }

  /**
   * The release channel the nodes are held to. A missing or malformed one (no channel.json in R2,
   * a bad upload) must not break every hello: the last good one stays, or 0.0.0 (nobody is told to
   * update), with one ALERT until a good one is back.
   */
  private channel(): ReleaseChannel {
    let raw: unknown = null;
    let threw = '';
    try {
      raw = this.o.channel();
    } catch (e) {
      threw = String(e);
    }
    const ch = cleanChannel(raw);
    if (ch) {
      this.goodChannel = ch;
      this.channelAlerted = false;
      return ch;
    }
    const use = this.goodChannel ?? NO_CHANNEL;
    if (!this.channelAlerted) {
      this.channelAlerted = true;
      this.log(`ALERT release channel missing or invalid (${threw || describe(raw)}): holding the nodes to stable ${use.stable}, minimum ${use.minimum}`);
    }
    return use;
  }

  /** Someone can verify a match played on `build`: a trusted verifier on that exact release, or the in-process verifier (reference server). */
  private verifiable(build: BuildId): boolean {
    if (this.o.inlineVerify && sameBuild(this.o.build(), build)) return true;
    const now = this.now();
    return this.registry
      .list()
      .some((v) => v.trusted && v.roles.includes('verify') && v.online && !v.draining && now - v.lastSeen <= HEARTBEAT_TIMEOUT_MS && (v.status === 'probation' || v.status === 'active') && sameSimulation(v.build, build));
  }

  /** Some match played on `build` is still running or waiting for its verification. */
  private workOnBuild(build: BuildId): boolean {
    for (const m of this.matches.values()) if (m.state !== 'done' && sameSimulation(m.build, build)) return true;
    return false;
  }

  setStatus(nodeId: string, status: NodeStatus, reason: string | null): void {
    if (this.registry.setStatus(nodeId, status, reason)) this.notifyStatus(nodeId, status);
  }

  drain(nodeId: string, reason: string): void {
    this.notify(nodeId, { t: 'drain', reason });
  }

  // ---- placement ----------------------------------------------------------------------------

  private urlFor(node: NodeRecord, transport: NodeTransport, matchId: string): string {
    return transport === 'wss' ? `${node.publicUrl}/m/${matchId}` : rtcMatchUrl(this.o.siteBase ?? this.o.httpBase, node.nodeId, matchId);
  }

  /** Matches the control plane counts as running on a node (the node's own heartbeat may lie). */
  private runningOn(nodeId: string): number {
    let n = 0;
    for (const m of this.matches.values()) if (m.nodeId === nodeId && (m.state === 'assigned' || m.state === 'reporting')) n++;
    return n;
  }

  /**
   * Region factor for a match placed now: (matches running on the region's nodes + this one +
   * matches the region's nodes could not take lately) / match slots the region's online hosts
   * offer, through ledger.regionFactor (0.5 .. 3).
   */
  regionFactorAt(region: string): number {
    const now = this.now();
    let demand = 1;
    for (const m of this.matches.values()) if (m.assign.region === region && (m.state === 'assigned' || m.state === 'reporting')) demand++;
    for (const u of this.unplaced) if (u.region === region && now - u.at < UNPLACED_WINDOW_MS) demand++;
    let supply = 0;
    for (const n of this.registry.list()) if (n.region === region && this.mayHost(n)) supply += Math.max(n.capacity.matches, n.capacityMax ?? 0);
    return regionFactor(demand, supply);
  }

  /**
   * An online host in probation or active that players can reach: one whose wss the re-probes
   * took out (and that has no other way in) offers nothing until a probe passes again.
   */
  private mayHost(n: NodeRecord): boolean {
    return this.isOnline(n.nodeId) && n.roles.includes('host') && (n.status === 'probation' || n.status === 'active') && usableTransports(n).length > 0;
  }

  /**
   * No node took the match. It counts as unmet demand (it raises the region factor) only when the
   * region had no host at all, or its hosts were out only for load: full, at their egress cap or
   * offline. Requests no node could take by rule (transport, build, status, the operator playing)
   * and refusals of 'assign' do not count: a node must not be able to raise its own factor.
   */
  private noPlace(req: PlaceRequest, refused: boolean, transports: NodeTransport[]): null {
    const now = this.now();
    this.unplaced = this.unplaced.filter((u) => now - u.at < UNPLACED_WINDOW_MS);
    if (refused || this.unplaced.length >= 10_000) return null;
    const preq = { region: req.region, mode: req.mode, ranked: req.ranked, playerIds: req.humans.map((h) => h.playerId), build: this.o.build(), transports, now };
    const hosts = this.registry.list().filter((n) => n.region === req.region && n.roles.includes('host'));
    const loadOnly = hosts.every((n) => {
      const why = ineligibility({ ...n, online: n.online && this.isOnline(n.nodeId), active: Math.max(n.active, this.runningOn(n.nodeId)) }, preq);
      return why === 'full' || why === 'egress_cap' || why === 'offline';
    });
    if (loadOnly) this.unplaced.push({ region: req.region, at: now });
    return null;
  }

  /**
   * Put a match on a community node: pick, assign (the node pre-warms the arena), mint one EdDSA
   * ticket per human. null when no node is eligible or the chosen one refused: the matchmaker then
   * creates a MatchDO exactly as today (and the region counts it as unmet demand).
   */
  async place(req: PlaceRequest, tries = 2): Promise<Placement | null> {
    const perTeam = MODES[req.mode];
    if (!perTeam || req.humans.length < 1 || req.humans.length > perTeam * 2) throw new Error('bad place request');
    const transports: NodeTransport[] = req.transports && req.transports.length > 0 ? req.transports : ['wss'];
    const roster = req.teams ? buildTeamRoster(perTeam, req.humans, req.teams) : buildRoster(perTeam, req.humans);
    const tried = new Set<string>();
    let refused = false;
    for (let attempt = 0; attempt < tries; attempt++) {
      const now = this.now();
      // The load the scheduler balances on: never below what the control plane itself placed there.
      // Only nodes whose matches can be verified when they must be: a ranked match, and every
      // match of a node on probation, needs a verifier on the node's exact release. And none for a
      // trusted verifier whose update waits until the matches on its release are done.
      const candidates = this.registry
        .list()
        .filter((n) => !tried.has(n.nodeId) && this.isOnline(n.nodeId) && !this.deferredUpdates.has(n.nodeId))
        .filter((n) => !(req.ranked || n.status === 'probation') || this.verifiable(n.build))
        .map((n) => ({ ...n, active: Math.max(n.active, this.runningOn(n.nodeId)) }));
      const picked = pickNode(candidates, { region: req.region, mode: req.mode, ranked: req.ranked, playerIds: req.humans.map((h) => h.playerId), build: this.o.build(), transports, now });
      const node = picked ? this.registry.node(picked.nodeId) : undefined;
      if (!node) return this.noPlace(req, refused, transports);
      tried.add(node.nodeId);
      const transport = transportFor(node, transports);
      if (!transport) continue;
      const assign: MatchAssignment = {
        // 64 hex characters, like a MatchDO id: the Worker's routes (/api/rejoin, /api/leave, the
        // ranked result) only accept those.
        matchId: randomHexId(32),
        mode: req.mode,
        region: req.region,
        ranked: req.ranked,
        roster,
        matchLengthSeconds: req.matchLengthSeconds,
        kickoffSeed: crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff,
        botDifficulty: req.botDifficulty ?? 'medium',
        createdAt: now,
        ...(req.kickoffCountdownSeconds !== undefined ? { kickoffCountdownSeconds: req.kickoffCountdownSeconds } : {}),
        ...(req.goalPauseSeconds !== undefined ? { goalPauseSeconds: req.goalPauseSeconds } : {}),
        ...(req.joinTimeoutMs !== undefined ? { joinTimeoutMs: req.joinTimeoutMs } : {}),
      };
      const factor = this.regionFactorAt(req.region);
      let answer: AssignAnswer;
      try {
        answer = await this.call<AssignAnswer>(node.nodeId, { t: 'assign', match: assign });
      } catch (e) {
        this.log(`assign on ${node.name} refused: ${e instanceof NodeRefused ? e.code : String(e)}`);
        refused = true;
        continue;
      }
      if (transport === 'wss' && answer?.wsUrl !== `${node.publicUrl}/m/${assign.matchId}`) {
        this.log(`assign on ${node.name}: unexpected wsUrl ${String(answer?.wsUrl)}`);
        refused = true;
        continue;
      }
      this.registry.onAssigned(node.nodeId);
      const key = await this.key;
      const tickets: PlayerTicket[] = [];
      for (const e of roster) {
        if (e.kind !== 'player' || !e.playerId) continue;
        const ticket = await createNodeTicket(key, { sub: e.playerId, mid: assign.matchId, team: e.team, slot: e.slot, name: e.name, nodeId: node.nodeId }, now);
        tickets.push({ playerId: e.playerId, slot: e.slot, team: e.team, ticket });
      }
      const length = req.matchLengthSeconds > 0 ? req.matchLengthSeconds : 600;
      const m: MatchEntry = {
        assign,
        nodeId: node.nodeId,
        transport,
        humans: req.humans,
        build: { ...node.build },
        bootId: node.bootId,
        state: 'assigned',
        leaves: new Set(),
        leaveAt: new Map(),
        neverJoined: new Set(),
        startedSeen: false,
        left: new Set(),
        offered: new Set(),
        regionFactor: factor,
        replaySha: null,
        verifyRate: 1,
        report: null,
        reportedAt: 0,
        verdict: null,
        verifiedBy: null,
        outcome: null,
        ledger: null,
        deadline: now + length * 1000 + TTL_AFTER_MATCH_SECONDS * 1000 + REPORT_GRACE_MS,
        queuedAt: 0,
        lastTry: 0,
        inFlight: false,
        doneAt: 0,
      };
      this.matches.set(assign.matchId, m);
      this.save(m); // before the tickets go out: a restart must still know the match their players join
      return { matchId: assign.matchId, nodeId: node.nodeId, nodeName: node.name, transport, wsUrl: this.urlFor(node, transport, assign.matchId), tickets };
    }
    return this.noPlace(req, refused, transports);
  }

  /** A fresh ticket for a player rejoining a node match (POST /api/rejoin), or why not (checked in this order). */
  async rejoin(matchId: string, playerId: string): Promise<RejoinAnswer> {
    const m = this.matches.get(matchId);
    if (!m) return { ok: false, code: 'no_match' };
    const e = m.assign.roster.find((r) => r.kind === 'player' && r.playerId === playerId);
    if (!e) return { ok: false, code: 'not_in_match' };
    if (m.leaves.has(playerId)) return { ok: false, code: 'left' };
    if (m.state !== 'assigned') return { ok: false, code: 'match_over' };
    // A wss node checks the ticket by itself; an rtc one needs its control link for the offer.
    const n = this.registry.node(m.nodeId);
    if (!n || (m.transport === 'rtc' && !this.isOnline(n.nodeId)) || (m.transport === 'wss' && !n.publicUrl)) return { ok: false, code: 'offline' };
    const ticket = await createNodeTicket(await this.key, { sub: playerId, mid: matchId, team: e.team, slot: e.slot, name: e.name, nodeId: n.nodeId }, this.now());
    return { ok: true, ticket, wsUrl: this.urlFor(n, m.transport, matchId) };
  }

  /** rejoin() without the reason: null when the player cannot rejoin. */
  async rejoinTicket(matchId: string, playerId: string): Promise<{ ticket: string; wsUrl: string } | null> {
    const r = await this.rejoin(matchId, playerId);
    return r.ok ? { ticket: r.ticket, wsUrl: r.wsUrl } : null;
  }

  /**
   * A player's node match as the matchmaker's lock check sees it (GET /internal/status): the lock
   * holds while the match is 'assigned' or 'reporting' and the player has not left. null (404)
   * when the control plane does not know the match, or the player in it.
   */
  matchStatus(matchId: string, playerId: string): { state: MatchState; left: boolean } | null {
    const m = this.matches.get(matchId);
    if (!m || !m.assign.roster.some((r) => r.kind === 'player' && r.playerId === playerId)) return null;
    return { state: m.state, left: m.leaves.has(playerId) };
  }

  /**
   * Host nodes online in `region` that may take matches (probation or active, reachable): the
   * `hosts` of POST /internal/place. While it is 0 the matchmaker stops asking for a while.
   */
  hostsOnline(region: string): number {
    let n = 0;
    for (const x of this.registry.list()) if (x.region === region && this.mayHost(x)) n++;
    return n;
  }

  /**
   * POST /api/leave { matchId, connected } for a node match. Like MatchDO: refused once the match
   * is over ('match_over'). The leave is recorded with its time: the replay's takeover for it must
   * fall in the matching tick window, so a node holding its report cannot turn a later, automatic
   * leave into an abandon. `connected: false` (the client never got into the match, e.g. a cancel
   * while connecting) is never a dodge.
   *
   * Throws NodeRefused before recording anything (no_match, not_in_match, match_over, offline: the
   * Worker keeps the lock on that one, the player may still rejoin). Once recorded it resolves,
   * even when the relay then fails: the player is out of the match from then on (rejoin answers
   * 'left'), so the Worker must free the lock rather than strand them in it.
   */
  async leave(matchId: string, playerId: string, opts: { connected?: boolean } = {}): Promise<LeaveResult> {
    const m = this.matches.get(matchId);
    if (!m) throw new NodeRefused('no_match');
    if (!m.assign.roster.some((r) => r.kind === 'player' && r.playerId === playerId)) throw new NodeRefused('not_in_match');
    if (m.state !== 'assigned') throw new NodeRefused('match_over');
    if (!this.isOnline(m.nodeId)) throw new NodeRefused('offline'); // nothing recorded: the player may still rejoin
    // Before sending, and written: the node may record the takeover even if its reply is lost, and
    // a restart that forgot leaveAt would turn that honest takeover into a 'bad_takeover'.
    m.leaves.add(playerId);
    if (!m.leaveAt.has(playerId)) m.leaveAt.set(playerId, this.now());
    if (opts.connected === false) m.neverJoined.add(playerId);
    this.save(m);
    let answer: LeaveAnswer;
    try {
      answer = await this.call<LeaveAnswer>(m.nodeId, { t: 'leave', matchId, playerId });
    } catch (e) {
      return { recorded: true, answer: null, error: e instanceof NodeRefused ? e.code : String(e) };
    }
    m.left.add(playerId);
    this.save(m);
    return { recorded: true, answer };
  }

  // ---- WebRTC signaling (players of rtc nodes) ----------------------------------------------

  private async rtcCheck(nodeId: string, matchId: string, ticket: string): Promise<{ m: MatchEntry; playerId: string }> {
    const m = this.matches.get(matchId);
    if (!m || m.nodeId !== nodeId || m.transport !== 'rtc') throw new NodeRefused('no_match');
    if (m.state !== 'assigned') throw new NodeRefused('match_over');
    // The node checks the ticket too; this only keeps junk off the node's control connection.
    const claims = typeof ticket === 'string' && ticket.length < 2048 ? await verifyNodeTicket(await this.pub, ticket, matchId, nodeId, this.now()) : null;
    if (!claims) throw new NodeRefused('bad_ticket');
    return { m, playerId: claims.sub };
  }

  /** POST /nodes/rtc/<node>/<match>/ice: the ICE servers for this player (TURN credentials minted per ticket). */
  async rtcIce(nodeId: string, matchId: string, ticket: string): Promise<{ iceServers: IceServer[] }> {
    await this.rtcCheck(nodeId, matchId, ticket);
    return { iceServers: await this.ice('player') };
  }

  /** POST /nodes/rtc/<node>/<match>/offer: relay the player's offer, return the node's answer. */
  async rtcOffer(nodeId: string, matchId: string, ticket: string, sdp: string): Promise<RtcAnswer> {
    if (typeof sdp !== 'string' || sdp.length > 32 * 1024) throw new NodeRefused('bad_offer');
    const { m, playerId } = await this.rtcCheck(nodeId, matchId, ticket);
    if (!m.offered.has(playerId)) {
      m.offered.add(playerId);
      this.save(m); // the evidence a no-show is judged on
    }
    const iceServers = await this.ice('node');
    return this.call<RtcAnswer>(nodeId, { t: 'rtcOffer', matchId, ticket, sdp, iceServers }, RTC_OFFER_TIMEOUT_MS);
  }

  // ---- results ------------------------------------------------------------------------------

  /**
   * The checks of PUT /nodes/replays/<matchId> that need no body: only the hosting node, on time,
   * signed over the declared hash, before its report. null when the upload may go on. The Worker
   * runs it before it reads the body (up to 16 MiB): every player of a node match knows its id
   * and the node's, and reading or hashing 16 MiB for anyone who asks would be a cheap way to
   * stall the one control plane every node's heartbeats go through.
   */
  async replayPutCheck(matchId: string, nodeId: string, ts: number, sig: string, declaredSha: string): Promise<ReplayRefusal | null> {
    const m = this.matches.get(matchId);
    const n = this.registry.node(nodeId);
    if (!m || !n || m.nodeId !== nodeId) return { ok: false, status: 404, code: 'no_match' };
    if (!Number.isFinite(ts) || Math.abs(this.now() - ts) > 5 * 60_000) return { ok: false, status: 401, code: 'stale' };
    if (!(await verifyWith(n.publicKey, replayRequestMessage('PUT', matchId, declaredSha, ts), sig))) return { ok: false, status: 401, code: 'bad_sig' };
    if (m.report || m.state !== 'assigned') return { ok: false, status: 409, code: 'already_reported' };
    return null;
  }

  /**
   * PUT /nodes/replays/<matchId> once the body is in: replayPutCheck again (the match may have
   * been reported while the body arrived), then the hash as declared.
   */
  async storeReplay(matchId: string, nodeId: string, ts: number, sig: string, declaredSha: string, bytes: Uint8Array): Promise<{ ok: true } | ReplayRefusal> {
    const refused = await this.replayPutCheck(matchId, nodeId, ts, sig, declaredSha);
    if (refused) return refused;
    const m = this.matches.get(matchId);
    if (!m) return { ok: false, status: 404, code: 'no_match' };
    const sha = await sha256Hex(bytes);
    if (sha !== declaredSha) return { ok: false, status: 400, code: 'sha_mismatch' };
    await this.o.replays.put(matchId, bytes);
    m.replaySha = sha;
    // Before the 200: a restart that forgot the upload would strike the node's honest 'ended' as 'no_replay'.
    this.save(m);
    return { ok: true };
  }

  /** GET /nodes/replays/<matchId> for the verifier node the job went to. */
  async loadReplayFor(matchId: string, nodeId: string, ts: number, sig: string, sha: string): Promise<Uint8Array | null> {
    const m = this.matches.get(matchId);
    const n = this.registry.node(nodeId);
    if (!m || !n || m.verifiedBy !== nodeId || !Number.isFinite(ts) || Math.abs(this.now() - ts) > 5 * 60_000) return null;
    if (!(await verifyWith(n.publicKey, replayRequestMessage('GET', matchId, sha, ts), sig))) return null;
    return this.o.replays.get(matchId);
  }

  private voidMatch(m: MatchEntry, reason: string, noShows: string[] = []): void {
    this.finish(m, { kind: 'void', matchId: m.assign.matchId, nodeId: m.nodeId, ranked: m.assign.ranked, reason, players: this.playerIds(m), noShows });
  }

  /**
   * A strike for the node (unless trusted: the registry skips those), the node told when it was
   * paused. Strikes within STRIKE_DEDUPE_MS of the last one count once: one stop, crash or restart
   * is one strike however many matches it took.
   */
  private strike(nodeId: string, reason: string): void {
    const now = this.now();
    const last = this.lastStrike.get(nodeId);
    if (last !== undefined && now - last < STRIKE_DEDUPE_MS) return;
    this.lastStrike.set(nodeId, now);
    const changed = this.registry.onLost(nodeId, reason, now);
    if (changed) this.notifyStatus(nodeId, changed);
  }

  /** Void every match of `nodeId` that `which` selects, with ONE strike for the whole outage. */
  private voidMatchesOf(nodeId: string, reason: string, which: (m: MatchEntry) => boolean): number {
    const hit = [...this.matches.values()].filter((m) => m.nodeId === nodeId && which(m));
    for (const m of hit) this.voidMatch(m, reason);
    if (hit.length > 0) this.strike(nodeId, reason);
    return hit.length;
  }

  /** A report that failed validation, for a match of this node: settled as lost (a strike). */
  private badReport(nodeId: string, matchId: string): void {
    const m = this.matches.get(matchId);
    if (!m || m.nodeId !== nodeId || m.state !== 'assigned' || m.report) return;
    this.log(`bad report from ${nodeId} for ${matchId.slice(0, 8)}`);
    this.strike(nodeId, 'bad_report');
    this.voidMatch(m, 'lost:bad_report');
  }

  /**
   * A report for one of the node's matches. Returns false when it must not be acked (a copy of a
   * report still being processed). Rejects when a store fails, and the match then waits for its
   * report as if it had never come: the node sends it again (no ack), and that copy is judged
   * afresh instead of being acked as a second report while the row still says 'assigned'.
   */
  private async onReport(nodeId: string, r: MatchReport): Promise<boolean> {
    try {
      return await this.takeReport(nodeId, r);
    } catch (e) {
      // Back to waiting for the report, unless the sweep settled the match meanwhile.
      const m = this.matches.get(r.matchId);
      if (m && m.report === r && m.state !== 'done') {
        m.state = 'assigned';
        m.report = null;
        m.reportedAt = 0;
      }
      throw e;
    }
  }

  /** onReport without the way back: settle the match on its report, or queue it for verification. */
  private async takeReport(nodeId: string, r: MatchReport): Promise<boolean> {
    const m = this.matches.get(r.matchId);
    if (m && m.nodeId === nodeId && m.state === 'reporting') return false;
    // Unknown, foreign, already settled or a second report: ack and forget.
    if (!m || m.nodeId !== nodeId || m.state !== 'assigned' || m.report) return true;
    m.report = r;
    m.state = 'reporting';
    m.reportedAt = this.now();
    const n = this.registry.node(nodeId);
    const ranked = m.assign.ranked;
    const players = this.playerIds(m);
    if (r.kind === 'cancelled') {
      if (!ranked) {
        this.voidMatch(m, r.reason);
        return true;
      }
      if (n?.trusted) {
        this.voidMatch(m, r.reason, r.noShows.filter((p) => players.includes(p)));
        return true;
      }
      // A community node: its word decides nothing. A ranked match can only be cancelled before it
      // starts, for a reason the control plane can check, and abandons need the control plane's own
      // evidence. Anything else is a match the node lost (a strike), with no abandons.
      const joinMs = m.assign.joinTimeoutMs ?? DEFAULT_JOIN_MS;
      const since = m.reportedAt - m.assign.createdAt;
      const lost = (why: string): boolean => {
        this.strike(nodeId, why);
        this.voidMatch(m, 'lost:' + why);
        return true;
      };
      // A cancel a deploy held up (the node sends it again at its welcome, in the grace) is late
      // only if it was late already when the control plane restarted.
      const heldUp = this.inGrace() && m.assign.createdAt < this.restoredAt;
      const lateness = (heldUp ? Math.min(m.reportedAt, this.restoredAt) : m.reportedAt) - m.assign.createdAt;
      if (lateness > joinMs + CANCEL_SLACK_MS || m.startedSeen) return lost('late_cancel');
      if (r.reason === 'dodge') {
        // A player's own leave, relayed here before the start (MatchDO: a dodge is an abandon).
        const relayed = r.noShows.filter((p) => players.includes(p) && m.leaves.has(p));
        if (relayed.length === 0) return lost('unproven_cancel');
        this.voidMatch(m, 'dodge', relayed.filter((p) => !m.neverJoined.has(p)));
        return true;
      }
      if (r.reason === 'no_show') {
        // Only when the join window closed. rtc: whoever never even sent an offer; nobody when
        // nobody got through (MatchDO: no live socket, no penalty). wss: no evidence, no abandons.
        if (since < joinMs - NO_SHOW_SKEW_MS) return lost('early_cancel');
        const noShows = m.transport === 'rtc' && m.offered.size > 0 ? r.noShows.filter((p) => players.includes(p) && !m.offered.has(p)) : [];
        this.voidMatch(m, 'no_show', noShows);
        return true;
      }
      return lost('cancel:' + r.reason); // a shutdown before the start, or anything else: like an outage
    }
    if (r.kind === 'lost') {
      this.strike(nodeId, r.reason);
      this.voidMatch(m, 'lost:' + r.reason);
      return true;
    }
    // 'ended'. A casual match that is not sampled settles now, on the node's word: it has no
    // rating and earns no points, so the word decides nothing.
    // The replay must have been uploaded, whether or not this match is sampled: otherwise
    // reporting 'ended' without one would beat honestly reporting 'lost' (always a strike).
    if (m.replaySha === null || m.replaySha !== r.replaySha256) {
      this.strike(nodeId, 'no_replay');
      this.voidMatch(m, 'no_replay');
      return true;
    }
    m.verifyRate = this.verifyRateOf(m, n);
    if (m.verifyRate < 1 && randomUnit() >= m.verifyRate) {
      // Still one more match of this group on this operator: the repeat decay must see it, or the
      // 1 / rate weight of the sampled ones would pay a farming group more than verifying everything.
      if (n && !n.trusted) this.ledger.noteGroup(n.operatorId, this.playerIds(m), this.now());
      this.finish(m, { kind: 'unrated', matchId: m.assign.matchId, nodeId, blue: r.result.blue, red: r.result.red, verified: false });
      return true;
    }
    // Verify before anything is written.
    const bytes = await this.o.replays.get(m.assign.matchId);
    const sha = bytes ? await sha256Hex(bytes) : null;
    if (m.state !== 'reporting' || m.report !== r) return true; // settled meanwhile (sweep)
    if (sha === null || sha !== r.replaySha256) {
      this.strike(nodeId, 'no_replay');
      this.voidMatch(m, 'no_replay');
      return true;
    }
    m.state = 'verifying';
    m.queuedAt = this.now();
    m.lastTry = 0;
    // Before the ack: the node forgets an acked report, so only this row keeps the match queued.
    // ('reporting' is never written: it only lasts across the replay read above.)
    this.save(m);
    this.pump();
    return true;
  }

  /** Dispatch every queued verification that can go now (called on reports, verifier hellos and sweeps). */
  pump(force = false): void {
    const now = this.now();
    const grace = this.inGrace();
    for (const m of this.matches.values()) {
      if (m.state !== 'verifying' || m.inFlight) continue;
      if (!force && m.lastTry !== 0 && now - m.lastTry < VERIFY_RETRY_MS) continue;
      // After a restart the verifier needs its reconnect too: try, but give up on nothing yet.
      if (now - m.queuedAt > VERIFY_MAX_WAIT_MS && !grace) {
        this.log(`ALERT match ${m.assign.matchId} could not be verified for ${VERIFY_MAX_WAIT_MS / 3_600_000} h`);
        this.voidMatch(m, 'unverified');
        continue;
      }
      void this.tryVerify(m);
    }
  }

  private async tryVerify(m: MatchEntry): Promise<void> {
    m.inFlight = true;
    m.lastTry = this.now();
    try {
      const host = this.registry.node(m.nodeId);
      const r = m.report;
      if (!host || r?.kind !== 'ended') return this.voidMatch(m, 'unverified');
      const job: VerifyJob = {
        matchId: m.assign.matchId,
        leaves: [...m.leaves],
        hostNodeId: m.nodeId,
        replayUrl: `${this.o.httpBase}/nodes/replays/${m.assign.matchId}`,
        expect: m.assign,
        replaySha256: r.replaySha256,
      };
      let verdict: VerifyVerdict | null = null;
      let verifierBuild: BuildId | null = null;
      // Only a verifier on the build the match was PLAYED on can re-simulate it.
      const v = pickVerifier(this.registry.list(), host, m.build, this.now(), (id) => this.sessions.get(id)?.verifying ?? 0, { playerIds: this.playerIds(m), rand: randomUnit });
      if (v) {
        const s = this.sessions.get(v.nodeId);
        m.verifiedBy = v.nodeId;
        verifierBuild = { ...v.build };
        if (s) s.verifying++;
        try {
          verdict = await this.call<VerifyVerdict>(v.nodeId, { t: 'verify', job }, VERIFY_TIMEOUT_MS);
        } catch (e) {
          this.log(`verifier ${v.name} failed: ${e instanceof NodeRefused ? e.code : String(e)}`);
        } finally {
          if (s) s.verifying--;
        }
      }
      if (!verdict && this.o.inlineVerify && sameBuild(this.o.build(), m.build)) {
        m.verifiedBy = 'control-plane';
        verifierBuild = { ...this.o.build(), version: m.build.version }; // it checks wasm + protocol only
        const bytes = await this.o.replays.get(m.assign.matchId);
        if (bytes) verdict = await this.o.inlineVerify(bytes, job);
      }
      if (!verdict || typeof verdict !== 'object' || typeof verdict.code !== 'string') {
        m.verifiedBy = null;
        return; // stays queued: the sweep retries until VERIFY_MAX_WAIT_MS
      }
      this.applyVerdict(m, host, r, verdict, verifierBuild);
    } catch (e) {
      this.log(`verification of ${m.assign.matchId.slice(0, 8)} threw: ${String(e)}`);
    } finally {
      m.inFlight = false;
    }
  }

  /**
   * The chance a finished match is verified. Ranked: always (the ranking is what verification
   * protects). Casual: always while the host is on probation (its verified casual matches are its
   * way into ranked); casualVerifyRate once it is active; never on a project node (it earns
   * nothing and is trusted). Unknown host: always.
   */
  private verifyRateOf(m: MatchEntry, host: NodeRecord | undefined): number {
    if (m.assign.ranked || !host) return 1;
    if (host.trusted) return 0;
    if (host.status === 'active') return this.casualVerifyRate;
    return 1;
  }

  /** When the node's wall-clock TTL may whistle this match, by the control plane's clock. */
  private ttlAt(m: MatchEntry): number {
    return m.assign.createdAt + m.assign.matchLengthSeconds * 1000 + TTL_AFTER_MATCH_SECONDS * 1000;
  }

  private applyVerdict(m: MatchEntry, host: NodeRecord, r: Extract<MatchReport, { kind: 'ended' }>, verdict: VerifyVerdict, verifierBuild: BuildId | null): void {
    if (m.state !== 'verifying') return;
    const matchId = m.assign.matchId;
    if (!verdict.ok && !HOST_FAULT_CODES.includes(verdict.code)) {
      // The verifier's side ('error', or a verifier on another build): retry later, nobody is blamed.
      // A verifier on the placement build that still sees another build means the replay lies.
      const hostLied = verdict.code === 'build_mismatch' && verifierBuild !== null && sameSimulation(verifierBuild, m.build);
      if (!hostLied) {
        this.log(`verification of ${matchId.slice(0, 8)} not possible now (${verdict.code}): retrying`);
        m.verifiedBy = null;
        return;
      }
    }
    m.verdict = verdict;
    // The report must say exactly what the replay proves.
    const res = r.result;
    let why: string | null = verdict.ok ? null : verdict.code;
    if (
      why === null &&
      (verdict.endReason !== res.endReason ||
        (verdict.forfeitTeam ?? null) !== (res.forfeitTeam ?? null) ||
        verdict.score.blue !== res.blue ||
        verdict.score.red !== res.red ||
        verdict.winner !== res.winner ||
        verdict.ticks !== res.endTick)
    ) {
      why = 'report_mismatch';
    }
    const startWindowS = (m.assign.ranked ? (m.assign.joinTimeoutMs ?? DEFAULT_JOIN_MS) : CASUAL_START_WINDOW_MS) / 1000;
    const elapsedS = (m.reportedAt - m.assign.createdAt) / 1000;
    // A replay cannot hold more game time than wall time passed between the assignment and the report.
    if (why === null && verdict.ticks / TICK_RATE > elapsedS + LEAVE_SLACK_S) why = 'impossible_length';
    // The TTL is wall-clock time from the assignment: the control plane's clock decides it, and the
    // game clock must have run that long too (minus the join window and slack), or the node
    // whistled early and only held its report.
    if (why === null && verdict.endReason === 'ttl') {
      const ttlS = (this.ttlAt(m) - m.assign.createdAt) / 1000;
      if (m.reportedAt < this.ttlAt(m) - TTL_SLACK_MS || verdict.ticks / TICK_RATE < ttlS - startWindowS - TTL_SLACK_MS / 1000) why = 'early_ttl';
    }
    // Each proven leave: its takeover tick must match when the control plane relayed it.
    if (why === null) {
      const slots = verdict.leftSlots ?? [];
      const ticks = verdict.leftTicks ?? [];
      for (let i = 0; i < slots.length && why === null; i++) {
        const pid = m.assign.roster[slots[i]]?.playerId ?? '';
        const at = m.leaveAt.get(pid);
        if (at === undefined) {
          why = 'bad_takeover';
          break;
        }
        const tickS = (ticks[i] ?? 0) / TICK_RATE;
        const relayedS = (at - m.assign.createdAt) / 1000;
        if (tickS > relayedS + LEAVE_SLACK_S || tickS < relayedS - startWindowS - STALL_SLACK_S) why = 'bad_takeover_time';
      }
    }
    const ok = why === null;
    const changed = this.registry.onVerified(m.nodeId, m.assign.ranked, ok);
    if (changed) this.notifyStatus(m.nodeId, changed);
    if (!ok) {
      this.log(`ALERT match ${matchId} on ${host.name}: verification ${why} ${verdict.message ?? ''}`);
      if (!host.trusted) this.shop?.freeze(host.operatorId, `verification_failed:${matchId}`);
      return this.voidMatch(m, 'verification_failed:' + why);
    }
    const reason = verdict.endReason ?? res.endReason;
    // Rewards: verified minutes (the project's own machines earn nothing).
    if (!host.trusted) {
      const present = verdict.presentTicks ?? [];
      const seen = new Set<number>();
      const players: LedgerPlayer[] = [];
      let underruns = 0;
      for (const st of r.stats.slots) {
        const e = m.assign.roster[st.slot];
        if (!e || e.kind !== 'player' || !e.playerId || seen.has(st.slot)) continue;
        seen.add(st.slot);
        underruns += st.underruns;
        const provenMs = Math.min(((present[st.slot] ?? 0) * 1000) / TICK_RATE, Math.max(0, m.reportedAt - m.assign.createdAt));
        const h = m.humans.find((x) => x.playerId === e.playerId);
        players.push({ playerId: e.playerId, connectedMs: Math.min(st.connectedMs, provenMs), account: h?.account === true, accountAgeDays: h?.accountAgeDays ?? 0 });
      }
      m.ledger = this.ledger.record(
        {
          matchId,
          nodeId: m.nodeId,
          operatorId: host.operatorId,
          region: m.assign.region,
          mode: m.assign.mode,
          ranked: m.assign.ranked,
          verified: true,
          endReason: reason,
          players,
          tickLagP99Ms: r.stats.tickLagP99Ms,
          underrunRate: underruns / Math.max(1, verdict.ticks * Math.max(1, players.length)),
          at: this.now(),
          sampleRate: m.verifyRate,
        },
        m.regionFactor,
      );
    }
    const rateable = m.assign.ranked && (reason === 'rules' || reason === 'forfeit' || (reason === 'ttl' && m.assign.matchLengthSeconds > 0));
    if (rateable) {
      const leftSlots = new Set(verdict.leftSlots ?? []);
      const roster = m.assign.roster.filter((e) => e.kind === 'player' && e.playerId);
      // MatchDO's rule on a project node: no socket at the whistle is leaving (closing the tab
      // escapes nothing). A community node's word on its sockets decides nothing; the replay
      // cannot tell a gone player from one holding no input, so there only proven leaves count.
      const goneAtEnd = (slot: number) => host.trusted && r.stats.slots.some((s) => s.slot === slot && !s.connectedAtEnd);
      return this.finish(m, {
        kind: 'rated',
        matchId,
        playlist: m.assign.mode,
        region: m.assign.region,
        winner: verdict.winner,
        blue: verdict.score.blue,
        red: verdict.score.red,
        // Leaves the replay proves (each one went through leave() above) make a leaver.
        players: roster.map((e) => ({ id: e.playerId as string, team: e.team, left: leftSlots.has(e.slot) || goneAtEnd(e.slot) })),
        nodeId: m.nodeId,
      });
    }
    if (m.assign.ranked) {
      // Every player vanished at once: the node's network, most likely (a strike). Players closing
      // their tabs one after another is not the node's fault.
      if (reason === 'empty') {
        const gone = (verdict.goneTicks ?? []).filter((t, slot) => m.assign.roster[slot]?.kind === 'player' && t >= 0);
        if (gone.length > 0 && Math.max(...gone) - Math.min(...gone) <= EMPTY_TOGETHER_TICKS) this.strike(m.nodeId, 'empty');
      }
      return this.voidMatch(m, reason);
    }
    return this.finish(m, { kind: 'unrated', matchId, nodeId: m.nodeId, blue: verdict.score.blue, red: verdict.score.red, verified: true });
  }

  private playerIds(m: MatchEntry): string[] {
    return m.assign.roster.filter((e) => e.kind === 'player' && e.playerId).map((e) => e.playerId as string);
  }

  /**
   * Settle a match once (later calls are ignored). The store gets the settled row before anything
   * else hears of it (in the DO, with the outbox rows that deliver the outcome, in one transaction).
   * When the store throws, the match stays as it was and the caller gets the error: the report is
   * not acked, the sweep or the queue tries again. A match settled only in memory would never be
   * delivered, and the purge would drop its row as if it had been.
   */
  private finish(m: MatchEntry, o: MatchOutcome): void {
    if (m.state === 'done') return;
    const was = { state: m.state, outcome: m.outcome, doneAt: m.doneAt };
    m.state = 'done';
    m.outcome = o;
    m.doneAt = this.now();
    try {
      this.o.store?.finished(m, o);
    } catch (e) {
      Object.assign(m, was);
      throw e;
    }
    this.log(`match ${m.assign.matchId.slice(0, 8)} -> ${o.kind}${o.kind === 'void' ? ' (' + o.reason + ')' : ''}${m.ledger ? `, ${m.ledger.points} pts` : ''}`);
    try {
      this.o.onOutcome?.(o, m);
    } catch (e) {
      this.log(`onOutcome threw: ${String(e)}`);
    }
  }

  // ---- health -------------------------------------------------------------------------------

  /** Call every few seconds: silent nodes go offline (their matches void), cooldowns lift, queues retry. */
  sweep(): void {
    const now = this.now();
    const grace = this.inGrace();
    const { offline, restored } = this.registry.sweep(now);
    for (const n of restored) {
      this.log(`node ${n.name}: strike cooldown over, back to ${n.status}`);
      this.notifyStatus(n.nodeId, n.status);
    }
    for (const n of offline) {
      const s = this.sessions.get(n.nodeId);
      if (s) {
        s.link.close(4408, 'heartbeat timeout');
        this.onClose(s);
      }
    }
    // A node gone for HEARTBEAT_TIMEOUT_MS (socket closed, or silent), a trusted one for
    // TRUSTED_OFFLINE_MS: its running matches are void, one strike for the outage. A quick
    // reconnect of the same process keeps them. Not while a restart waits for its nodes: they all
    // look gone then. A restart forgot when each node was last seen: a node whose socket did not
    // survive a hibernation gets its full window from the restore, as it would have without it.
    const gone = new Set<string>();
    for (const m of this.matches.values()) {
      if (grace || m.state !== 'assigned' || gone.has(m.nodeId) || this.isOnline(m.nodeId)) continue;
      const n = this.registry.node(m.nodeId);
      if (!n || now - Math.max(n.lastSeen, this.restoredAt) > (n.trusted ? TRUSTED_OFFLINE_MS : HEARTBEAT_TIMEOUT_MS)) gone.add(m.nodeId);
    }
    for (const id of gone) this.voidMatchesOf(id, 'node_offline', (m) => m.state === 'assigned');
    // Hosts still unproven (Caddy may have been fetching its certificate at the first hello): probe
    // again. Proven ones: check again every REPROBE_MS, sooner after a failure.
    for (const n of this.registry.list()) {
      if (!n.transports.includes('wss') || !this.isOnline(n.nodeId)) continue;
      const since = now - (this.lastProbe.get(n.nodeId) ?? 0);
      if (n.reachableAt === null) {
        if (since >= PROBE_RETRY_MS) void this.probe(n.nodeId);
      } else if (since >= (this.probeFailures.has(n.nodeId) ? PROBE_RETRY_MS : REPROBE_MS)) {
        void this.reprobe(n.nodeId);
      }
    }
    // No report by the deadline: void, one strike. Not in a restart's grace: a deadline that passed
    // while the control plane was down is nobody's fault, and the node re-sends its report at the welcome.
    const late = new Set<string>();
    for (const m of this.matches.values()) if (!grace && (m.state === 'assigned' || m.state === 'reporting') && now > m.deadline) late.add(m.nodeId);
    for (const id of late) this.voidMatchesOf(id, 'no_report', (m) => (m.state === 'assigned' || m.state === 'reporting') && now > m.deadline);
    for (const [id, m] of this.matches) {
      if (m.state !== 'done' || now - m.doneAt <= DONE_RETENTION_MS) continue;
      this.matches.delete(id);
      this.o.store?.drop(id);
    }
    this.unplaced = this.unplaced.filter((u) => now - u.at < UNPLACED_WINDOW_MS);
    for (const id of [...this.deferredUpdates]) this.maybeUpdate(id);
    this.pump();
  }

  /** The build the clients run (placements need it); exposed for the reference server's views. */
  get currentBuild(): BuildId {
    return this.o.build();
  }

  sameBuildAs(b: BuildId): boolean {
    return sameBuild(b, this.o.build());
  }
}

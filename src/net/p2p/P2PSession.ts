/**
 * P2PSession: a casual match between browsers with no simulation server (phase 2,
 * docs/online/PHASE2.md), driven inside the Game's frame loop like OnlineSession (phase 1).
 *
 * States: idle -> queue (POST /api/queue kind 'p2p') -> signaling (room socket, waiting for the
 * RoomWelcome) -> connecting (roster built, WebRTC mesh negotiating; 'ready' once every other
 * human slot that has not left is in the mesh with both channels open, at least one) -> countdown ('start' received,
 * waiting for tick 0 = startAt on the local clock) -> playing -> ended (the confirmed Match blew
 * the whistle) -> idle. A server queue answer ('kind: server', a lone human), a mesh that is not
 * complete (or a 'start' that has not come) FALLBACK_MS after the welcome OR after the last
 * 'peerJoined' (staggered joins: the window restarts whenever a peer shows up, so the first
 * joiner never gives up on a peer that is still negotiating), and a room where every other peer
 * actually left before the start ('peerLeft', or `left` in the welcome; a slot that merely has
 * not joined yet is waited for) hand the match over to the phase 1 OnlineSession through
 * Game.p2pHandover. A room a custom lobby assigned (joinAssigned) never does: its members are
 * friends, not the public queue, so those same paths fail back to the lobby (STATUS.lobbyFailed;
 * the host starts again). Whenever the session leaves a room it was assigned (fallback, leave, cancel,
 * failure, the final whistle) it also POSTs /api/leave (NetClient.leaveMatch) so the matchmaker
 * frees its one-active-match lock at once instead of waiting for the room socket's close to be
 * processed: the next queue (the fallback's own server queue included) must not answer 409.
 *
 * Staggered joins: the first joiner's welcome lists the other slot as connected: false, so the
 * mesh gets that peer on 'peerJoined' (addPeer: the lower slot offers). When the LOWER slot is
 * the later joiner it offers on its own welcome (the other is connected: true). A 'peerJoined'
 * for a slot the mesh already negotiates with re-sends the pending offer (Mesh.reoffer: the room
 * dropped a signal sent before the target socket existed, which it reports as the non-fatal
 * 'signal_dropped' error, routed to the mesh instead of failing the session). A slot that never
 * joins is declared a no-show by the room P2P_NO_SHOW_MS after it was created ('peerLeft' with an
 * empty peerId, which also restarts the FALLBACK_MS window): the present peers then say ready, the
 * room starts and drops the absent slot at tick 0 ('drop' { slot, 0 }), so every peer hands it to
 * the team AI from the first simulated tick (the engine cannot confirm a tick without that slot's
 * input or its drop, so the drop lands at the same tick everywhere).
 *
 * Experimental rules (a custom lobby's RoomWelcome.physics, src/game/physicsRules.ts): the Game
 * builds the arena with them (applyP2PRoster), both BotTeams plan with their physics profile
 * (botPhysicsOf), and 'ready' carries the fingerprint of the mutators the wasm reads back, which
 * the room compares with its own (ROOM_ERROR_PHYSICS_MISMATCH: STATUS.physicsMismatch). Such a room
 * has NO server fallback: every path that would hand over to a casual server match (the mesh not
 * complete in time, everybody else gone before the start) fails to the lobby instead
 * (STATUS.experimentalFailed), and nothing of it is ever recorded anywhere.
 *
 * Errors with a clear menu line: a stale page (426 'reload_required' from the queue, or a welcome
 * of another P2P protocol or with rules this build cannot read) -> STATUS.reload; 429 'no_show' (too many room tickets left unused) ->
 * noShowStatus(retryAfterMs). A room socket that closes before the welcome (the room refused the
 * upgrade: browsers only show 1006; e.g. 403 'left' for a join that got there after the no-show
 * grace, or an expired ticket) releases the lock and queues again by itself, once per quickMatch
 * (STATUS.requeue); a second one fails to the menu (p2p.roomClosed, its close code to the console).
 * Any other failed queue request reads as netErrorText (src/net/netErrorText.ts).
 *
 * Debug: `log` (P2PLog, 256-entry ring, window.__game.p2p.log) gets one line per event from the
 * session, the RoomClient and the Mesh (queue result, welcome, signals, ICE states, ready / start,
 * drops, fallback / failure reasons); nothing is pushed per tick.
 *
 * Determinism (binding, see protocol.ts): the bots (two BotTeams seeded with the room seed) and the
 * Match run ONLY on the confirmed timeline, once per confirmed tick, in order, inside the
 * RollbackEngine hooks: botInputs(tick) syncs the confirmed state at tick - 1 into the state
 * buffer (with the bridge's FX events muted), refreshes the ball prediction on EVERY confirmed
 * tick (the wasm BallPredTracker's incremental / full decision then depends on the confirmed ball
 * states only, never on when a peer rolled back) and packs the bot controls; onConfirmedTick(tick)
 * detects goals on the rising edge of the ball-scored flag of the confirmed state, ticks the Match,
 * performs its kickoff resets with rs_reset_kickoff(kickoffSeedOf(seed, n)) and saves a CHECKPOINT of the
 * confirmed-timeline objects (Match, kickoff count, scored flag, the bot layout and both BotTeams,
 * Match.saveState / BotTeam.saveState) in a ring keyed by tick (CHECKPOINT_TICKS entries, plus one
 * per hash tick like the engine's hash ring). Predicted ticks only sample the local input and let
 * the engine hold-last every remote slot. A dropped slot joins its team's BotTeam from the drop
 * tick on (botInputs checks the tick, so every peer switches identically).
 *
 * Resync / rewind: when the engine restarts the confirmed timeline at an earlier tick (resync from
 * the majority's state, or a drop whose tick was already confirmed) the hooks run again from
 * tick + 1, so the checkpoint of `tick` is restored first (onResync / onRewind): the Match clock
 * and score, the kickoff counter (the next rs_reset_kickoff seed) and the bots' RNG / memory then
 * continue exactly as on the other peers instead of advancing twice. A StateResponse carries the
 * answering peer's checkpoint as a trailer after the sim blob (protocol.ts splitStateTrailer), so
 * a resync adopts the MAJORITY's Match / bots too, not just its sim state. Match events re-emitted
 * during such a replay are not forwarded to the Game (no double goal banner).
 *
 * Clock: tick 0 is at `startAt` (server clock) = startAtLocal on performance.now() through the
 * RoomClient's ping / pong offset; expected tick = floor((now - startAtLocal) / TICK_MS). Per frame
 * the engine advances up to the expected tick unless canAdvance() is false (stall: the HUD shows
 * 'Esperando a <name>'); when the engine is ahead of the slowest peer (engine.blockReason
 * 'throttle', or framesAhead() with an engine that has no blockReason) the local clock is shifted
 * by one tick (a timesync skip), at most one per frame, and the newest inputs keep going out like
 * during a stall. Inputs go out every SEND_EVERY ticks to each peer: the engine's local inputs
 * newer than what that peer acknowledged (cap 16, assembleGamePacket over
 * engine.assembleLocalInputs, so the auto-filled first ticks ship too); confirmed hashes go over
 * the reliable channel. The vote's outcome (engine.onHashDecided) drives the minority streak: a
 * minority verdict twice in a row requests the majority's state (StateRequest to the peer whose
 * vote is the majority's; the answer is accepted only from that peer, for that tick, with the
 * majority hash and a matching blob hash), three in a row after a resync abandon the match.
 *
 * Everything on the per-tick / per-packet path is preallocated (packed scratch, the frame buffers,
 * per-slot typed arrays, the checkpoint ring, exact-length views of the send buffer); the
 * RoomClient, Mesh and RollbackEngine are built per room.
 */
import { BotTeam } from '../../ai/Team';
import { botPhysicsOf } from '../../sim/mutators';
import { MUTATOR_COUNT, mutatorFingerprint } from '../../sim/mutatorLayout';
import type { RulesSnapshot } from '../../game/physicsRules';
import type { GameMode } from '../../sim/constants';
import {
  BALL_OFFSET,
  B_POS,
  MAX_CARS,
  MAX_STATE_BYTES,
  PACKED_INPUT_BYTES,
  TICK_DT,
  Team,
  emptyControls,
  packControls,
  type CarControls,
  type SimEvents,
} from '../../sim/types';
import { Match, type MatchEvent } from '../../game/Match';
import { TICK_MS } from '../ClockSync';
import { NetClient, NetError, type ServerAssignment, type P2pAssignment } from '../NetClient';
import { outcomeOf, type Outcome } from '../outcome';
import { netErrorText } from '../netErrorText';
import {
  NET_STATS_MAX_PEERS,
  PEER_STATE_CONNECTED,
  PEER_STATE_DROPPED,
  RateMeter,
  newNetStatsView,
  resetNetStatsView,
  type NetStatsView,
} from '../NetStats';
import { fnv1a32 } from '../protocol';
import type { ClockMode } from '../../render/Hud';
import { duration, language, t } from '../../i18n';
import { P2PLog } from './DebugLog';
import { Mesh, assembleGamePacket, type MeshOptions } from './Mesh';
import {
  HASH_LEN,
  INPUT_HDR,
  P2P_ERROR_BAD_PHYSICS,
  P2P_ERROR_NO_SHOW,
  P2P_ERROR_RELOAD,
  P2P_HASH_EVERY,
  P2P_INPUT_DELAY_DEFAULT,
  P2P_NO_SHOW_MS,
  P2P_INPUT_MAX_BATCH,
  P2P_WINDOW_DEFAULT,
  P2pMsg,
  ROOM_ERROR_PHYSICS_MISMATCH,
  STATE_REQ_LEN,
  STATE_RESP_HDR,
  decodeHash,
  decodeP2pInput,
  decodeStateRequest,
  decodeStateResponse,
  encodeHash,
  encodeP2pInput,
  encodeStateRequest,
  encodeStateResponse,
  encodeStateTrailer,
  p2pMsgType,
  setStateResponseLen,
  splitStateTrailer,
  stateTrailerBytes,
  type IceServer,
  type P2pInputPacket,
  type RoomSlot,
  type RoomWelcome,
  type SignalData,
  type StateResponsePacket,
  type StateTrailerSplit,
} from './protocol';
import { HASH_RING, MAX_PREDICTED, P2P_HISTORY_TICKS_DEFAULT } from './Rollback';
import { ROOM_PING_INTERVAL_MATCH_MS, RoomClient, type RoomClientOptions } from './RoomClient';

export type P2PState = 'idle' | 'queue' | 'signaling' | 'connecting' | 'countdown' | 'playing' | 'ended';

/**
 * The mesh must be complete and the 'start' received this long after the welcome (restarted by
 * every 'peerJoined' and by a pre-start 'peerLeft' that leaves others to play with), else the
 * match falls back to a server. It must outlast the room's no-show grace (P2P_NO_SHOW_MS after the
 * room was created, i.e. before any welcome) plus the start round trip: the peers that are present
 * wait for an absent slot until the room declares it a no-show, then send 'ready' and get 'start'.
 */
export const FALLBACK_MS = 10_000;
/** What FALLBACK_MS leaves after the no-show grace for the ready / start round trip (checked by the tests). */
export const FALLBACK_MARGIN_MS = FALLBACK_MS - P2P_NO_SHOW_MS;
/** Timesync: shift the local clock when more than this many ticks (plus rtt / 2) ahead of the slowest peer. */
export const TIMESYNC_AHEAD = 2;
/** At most one timesync skip per this many ticks. */
export const TIMESYNC_MIN_GAP_TICKS = 30;
/** A stall longer than this (ms) shows 'Esperando a <name>'. */
export const STALL_HINT_MS = 250;
/** Input packet cadence (ticks). */
export const SEND_EVERY = 2;
/** During a stall / throttle the newest inputs are repeated at this interval (ms) so a lost packet never deadlocks two peers. */
export const STALL_RESEND_MS = 50;
/** Most ticks simulated in one frame (a hidden tab catches up over several frames). */
export const MAX_TICKS_PER_FRAME = 64;
/** Most extra packets per peer per send for a backlog longer than one batch (the input store holds 256 ticks = 16 batches). */
export const MAX_BACKLOG_CHUNKS = 16;
/** Minority verdicts in a row: 2 -> request the majority's state, 3 (after a resync) -> abandon, 5 (never answered) -> abandon. */
export const DESYNC_RESYNC_AT = 2;
export const DESYNC_ABANDON_AT = 3;
export const DESYNC_GIVE_UP_AT = 5;
/** Confirmed-tick checkpoints kept per tick (>= the engine's snapshot ring: a drop rewind lands inside it). */
export const CHECKPOINT_TICKS = P2P_HISTORY_TICKS_DEFAULT;
const STATS_INTERVAL_MS = 250;
/** Hash summaries to the room: this often, plus at once after a disagreeing vote (the room only monitors; the vote is peer to peer). */
export const HASH_REPORT_EVERY_MS = 10_000;
/** Bot difficulty of a P2P room (a room constant: every peer must use the same). */
export const P2P_BOT_DIFFICULTY = 'medium';
/** The red team's seed is offset from the room seed so the two teams do not share a noise stream. */
export const RED_SEED_OFFSET = 1_000_003;
/** Session checkpoint header: kickoffs, wasScored, isBot per slot. */
const CHECKPOINT_HDR = 2 + MAX_CARS;
/** Floats one checkpoint may take (every bot of both teams allocated). */
export const CHECKPOINT_FLOATS = CHECKPOINT_HDR + Match.STATE_FLOATS + 2 * BotTeam.stateFloatsMax(MAX_CARS);

// ---- status strings (pure, for the menu / HUD) --------------------------------------------------

export function queueStatus(waiting: number): string {
  return t('p2p.queueWaiting', { count: waiting });
}

export function connectingStatus(connected: number, total: number): string {
  return t('p2p.connecting', { connected, total });
}

export function waitingStatus(name: string): string {
  return t('p2p.waiting', { name });
}

/**
 * The menu line for a 429 'no_show' (P2P queues refused for `retryAfterMs`; a server match still
 * works). The wait is in seconds below two minutes ('90 sec', Spanish '90 s'), in whole minutes from there.
 */
export function noShowStatus(retryAfterMs: number): string {
  const s = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const time = s >= 120 ? duration(s * 1000) : new Intl.NumberFormat(language(), { style: 'unit', unit: 'second', unitDisplay: 'short' }).format(s);
  return t('error.queue.no_show', { time });
}

export const STATUS = {
  queue: t('p2p.queue'),
  room: t('p2p.room'),
  readyWait: t('p2p.readyWait'),
  fallback: t('p2p.fallback'),
  nobodyLeft: t('p2p.nobodyLeft'),
  serverAnswer: t('p2p.serverAnswer'),
  desync: t('p2p.desync'),
  droppedMe: t('p2p.droppedMe'),
  requeue: t('p2p.requeue'),
  lostRoom: t('p2p.lostRoom'),
  reload: t('error.queue.reload_required'),
  experimentalFailed: t('p2p.experimentalFailed'),
  lobbyFailed: t('p2p.lobbyFailed'),
  physicsMismatch: t('p2p.physicsMismatch'),
} as const;

/**
 * The rs_reset_kickoff seed of the room's `n`-th kickoff (0: the welcome's and tick 1's): the room
 * seed (a uint32) plus n, as a NON-NEGATIVE int31. The wasm takes an int and deals RANDOM spots
 * for a negative one, so a room seed from 2^31 up (half of them, and a seed just below after a few
 * goals) gave every peer its own kickoff: a desync at the first hash vote and after every goal,
 * each healed by a resync. Every protocol 5 peer deals with this, the same spots for the same room.
 */
export function kickoffSeedOf(roomSeed: number, n: number): number {
  return (roomSeed + n) & 0x7fffffff;
}

/** Tick expected at local time `nowMs` when tick 0 is at `startAtLocalMs` (negative before the start). */
export function expectedTickAt(nowMs: number, startAtLocalMs: number): number {
  return Math.floor((nowMs - startAtLocalMs) / TICK_MS);
}

// ---- what the session needs from its collaborators (fakes in tests) -------------------------------

/** The RollbackEngine API of docs/online/PHASE2.md as src/net/p2p/Rollback.ts implements it. */
export interface RollbackEngineLike {
  readonly tick: number;
  readonly confirmedTick: number;
  /** Newest local input tick registered (addLocalInput / the engine's own auto-fill). */
  readonly newestLocalTick: number;
  /** Why the last canAdvance() said no; engines without it get the framesAhead() timesync heuristic. */
  readonly blockReason?: 'none' | 'stall' | 'throttle';
  addLocalInput(packed: Int8Array, off: number): number;
  addRemoteInput(slot: number, firstTick: number, count: number, packed: Int8Array): void;
  /** Local inputs newer than ackTick (cap), oldest first; count returned, firstTick = newestLocalTick - count + 1. */
  assembleLocalInputs(ackTick: number, out: Int8Array, cap?: number): number;
  /** Copy `count` local inputs from `firstTick` (oldest first); false when any is unknown. Older chunks of a long backlog. */
  copyLocalInputs?(firstTick: number, count: number, out: Int8Array): boolean;
  /** Highest tick up to which EVERY input of `slot` is known: what we acknowledge to that peer (its resend floor) and what we report when it dies. */
  contiguousInputTick?(slot: number): number;
  canAdvance(): boolean;
  advance(): void;
  framesAhead(): number;
  /** `ackTick` = the newest tick that peer reported having from us (feeds the latency-free lead estimate). */
  noteRemoteTick(slot: number, myTick: number, ackTick: number): void;
  /** The human slot whose missing input holds the confirmed timeline back (-1 = none). */
  waitingFor?(): number;
  /** Hashes recorded since the last call (ascending), to broadcast over 'ctl'. */
  confirmedHashes(): readonly { tick: number; hash: number }[];
  receiveHash(slot: number, tick: number, hash: number): 'agree' | 'disagree' | 'unknown';
  /** The hash `slot` voted for `tick` (-1 = none): picks the resync source. */
  voteOf?(slot: number, tick: number): number;
  stateAt(tick: number): { blob: Uint8Array; len: number; hash: number } | null;
  resync(tick: number, blob: Uint8Array, len: number): void;
  drop(slot: number, atTick: number): void;
  onDesync?: ((tick: number, mine: number, majority: number, agree: number, disagree: number) => void) | null;
  /** Fired once per decided hash vote (agreed = mine is the majority's): drives the minority streak. */
  onHashDecided?: ((tick: number, agreed: boolean) => void) | null;
  readonly stats: { rollbacks: number; resimTicks: number; stalls: number; desyncs: number; resyncs: number; predictedAhead: number; mispredictions?: number; throttles?: number; rewinds?: number };
}

export interface EngineHooks {
  botInputs(tick: number, packedOut: Int8Array): void;
  onConfirmedTick(tick: number): void;
  /** resync() loaded the majority's state at `tick`: realign the confirmed-timeline objects. */
  onResync(tick: number): void;
  /** drop() rewound the confirmed timeline to the snapshot of `tick`: restore the checkpoint of `tick`. */
  onRewind(tick: number): void;
  onDesync(tick: number, mine: number, majority: number, agree: number, disagree: number): void;
  onHashDecided(tick: number, agreed: boolean): void;
}

export interface EngineOptions {
  inputDelay: number;
  window: number;
  hashEvery: number;
}

/** The sim as the engine sees it (RocketSimBridge satisfies it; the Game passes its RocketSim). */
export interface P2PSim {
  readonly buf: Float32Array;
  readonly tickCount: number;
  readonly numCars: number;
  readonly ballPred: Float32Array;
  readonly predTick?: number;
  readonly events: SimEvents;
  carOffset(slot: number): number;
  slotOf(carId: number): number;
  saveState(out: Uint8Array): number;
  loadState(blob: Uint8Array, len?: number): void;
  stateHash(): number;
  stateSizeMax(): number;
  setControlsPacked(packed: Int8Array, numSlots: number): void;
  step(n?: number): void;
  sync(): void;
  syncQuiet?(): void;
  resetKickoff(seed: number): void;
  updateBallPrediction(): void;
  /** A full re-prediction from the current ball state (RocketSimBridge.forceBallPrediction); updateBallPrediction when absent. */
  forceBallPrediction?(): void;
  isBallScored(): boolean;
  /**
   * The arena's mutators as the wasm reads them back (RocketSimBridge.getMutators): their
   * fingerprint goes out with 'ready'. Absent (fakes): 'ready' carries none.
   */
  getMutators?(out?: Float32Array): Float32Array;
}

export type EngineFactory = (sim: P2PSim, numSlots: number, humanSlots: readonly number[], localSlot: number, hooks: EngineHooks, opts: EngineOptions) => RollbackEngineLike;

/** What the session uses of RoomClient. */
export interface RoomLike {
  onWelcome: ((w: RoomWelcome) => void) | null;
  onPeerJoined: ((slot: RoomSlot) => void) | null;
  onPeerLeft: ((slot: number, peerId: string) => void) | null;
  onSignal: ((from: number, data: SignalData) => void) | null;
  onStart: ((startAt: number, now: number) => void) | null;
  onDrop: ((slot: number, atTick: number) => void) | null;
  onError: ((code: string, message: string) => void) | null;
  onClose: ((code: number, reason: string) => void) | null;
  /** The room could not relay our signal to `to` (no socket there yet; the mesh re-offers). */
  onSignalDropped?: ((to: number) => void) | null;
  readonly rttMs: number;
  connect(wsUrl: string, ticket: string): void;
  signal(to: number, data: SignalData): boolean;
  /** `physicsFp`: the fingerprint of the arena's mutators (the room refuses another one). */
  ready(physicsFp?: number): boolean;
  unreachable(slot: number, atTick: number): boolean;
  hashReport(tick: number, hash: number, agree: number, disagree: number): boolean;
  serverToLocal(serverMs: number): number;
  /** Slow the clock pings down once the match runs (optional). */
  setPingIntervalMs?(ms: number): void;
  /** Ask for TURN credentials (optional in fakes); the answer comes to onTurn. */
  requestTurn?(): boolean;
  onTurn?: ((iceServers: IceServer[]) => void) | null;
  close(code?: number, reason?: string): void;
  dispose(): void;
}

/** What the session uses of Mesh. */
export interface MeshLike {
  onGame: ((slot: number, bytes: Uint8Array) => void) | null;
  onCtl: ((slot: number, bytes: Uint8Array) => void) | null;
  onPeerConnected: ((slot: number) => void) | null;
  onPeerDead: ((slot: number) => void) | null;
  /** A peer is not connecting well: ask for TURN (optional in fakes). */
  onIceTrouble?: ((slot: number) => void) | null;
  /** The room's TURN answer (optional in fakes). */
  setIceServers?(list: readonly IceServer[]): boolean;
  readonly bytesIn: number;
  readonly bytesOut: number;
  addPeer(slot: number): void;
  removePeer(slot: number): void;
  /** The peer (re)joined the room: re-send a pending offer (optional in fakes). */
  reoffer?(slot: number): void;
  /** The room dropped our last signal to `slot` (optional in fakes). */
  signalDropped?(slot: number): void;
  handleSignal(from: number, data: SignalData): void;
  allConnected(): boolean;
  connectedCount(): number;
  expectedCount(): number;
  peerState(slot: number): number;
  peerRttMs(slot: number): number;
  peerCand(slot: number): number;
  sendGame(slot: number, buf: Uint8Array, len: number): boolean;
  sendCtl(slot: number, buf: Uint8Array, len: number): boolean;
  broadcastCtl(buf: Uint8Array, len: number): number;
  armLiveness(now: number): void;
  update(now: number): void;
  close(): void;
}

/** What the session needs from the Game (src/game/Game.ts implements it; tests use a stub). */
export interface P2PGameHooks {
  readonly sim: P2PSim;
  /**
   * Fresh arena from the room roster (player at you.slot, no local bot teams), created with the
   * room's physics (w.physics, null = standard) before any car. Throws on a bad roster or rules.
   */
  applyP2PRoster(w: RoomWelcome): void;
  restoreOfflineRoster(): void;
  /** The match is on screen (start received): hide the menu, reset the offline match, block edges. */
  p2pMatchOnScreen(): void;
  /** Sample the player's controls for the next tick (zero while the pause overlay owns the input). */
  p2pSampleInput(out: CarControls): void;
  /** After each predicted tick: prev / cur snapshots, pad pickups, player sounds. */
  p2pAfterTick(): void;
  /** The sim state changed outside a tick (resync): refresh the current snapshot. */
  afterRollback(): void;
  /** Confirmed-timeline match flow (countdown / go / goal / overtime / ended): HUD, FX, audio. */
  p2pMatchEvent(e: MatchEvent, blue: number, red: number): void;
  /** A kickoff reset happened on the confirmed timeline (snap the camera). */
  p2pKickoffReset(): void;
  /** `slot` is driven by the team AI from now on (banner, scoreboard tag). */
  p2pSlotDropped(slot: number, name: string): void;
  /** Hand the match over to the phase 1 session: an assignment to join, or null = queue a server match. */
  p2pHandover(mode: GameMode, assignment: ServerAssignment | null, notice: string): void;
  /** The session died mid-match: back to the menu with the reason. */
  onSessionDisconnected(message: string): void;
  /**
   * Matchmaking / signaling / connecting failed (fail(): the menu shows `message`): a custom
   * lobby's member goes back to its lobby. Optional (test fakes).
   */
  p2pFailed?(message: string): void;
}

export interface P2PSessionOptions {
  /** Shared with the OnlineSession (same guest record / name); created when omitted. */
  client?: NetClient;
  engineFactory: EngineFactory;
  roomFactory?: (opts: RoomClientOptions) => RoomLike;
  meshFactory?: (opts: MeshOptions) => MeshLike;
  now?: () => number;
}

/** A checkpoint found in the ring (reused result object). */
interface CheckpointRef {
  buf: Float64Array;
  off: number;
  len: number;
}

/** User-facing text for a failure: the P2P lock with its own wait format, any other NetError by netErrorText. */
function describe(err: unknown): string {
  if (err instanceof NetError) {
    if (err.serverCode === P2P_ERROR_NO_SHOW) return noShowStatus(err.retryAfterMs);
    return netErrorText(err);
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The developer text of a failure, for the debug log (a NetError's message keeps the status and the server's code). */
function logText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function zeroPacked(out: Int8Array, off: number): void {
  for (let i = 0; i < PACKED_INPUT_BYTES; i++) out[off + i] = 0;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** An integer room parameter within [lo, hi], else the default (a bad server value must not throw from the socket handler). */
function roomInt(v: number, lo: number, hi: number, dflt: number): number {
  return Number.isInteger(v) && v >= lo && v <= hi ? v : dflt;
}

export class P2PSession {
  readonly kind = 'p2p' as const;
  state: P2PState = 'idle';
  /** Menu status line while busy ('' otherwise). */
  status = '';
  /** Last failure (shown in the menu until the next attempt). */
  error: string | null = null;
  /** What that failure leaves the player to do (src/net/outcome.ts). */
  errorOutcome: Outcome = 'retry';
  mode: GameMode = '1v1';

  readonly client: NetClient;
  readonly stats: NetStatsView = newNetStatsView();
  /** Debug ring (window.__game.p2p.log): `log.text()` / JSON.stringify(log) read it. */
  readonly log: P2PLog;
  /** The confirmed-timeline match (score / clock / phase for the HUD). */
  match: Match;
  welcome: RoomWelcome | null = null;
  /**
   * The current room's experimental rules (RoomWelcome.physics), null = standard physics. Set by
   * the welcome, cleared when the session leaves the room.
   */
  rules: RulesSnapshot | null = null;
  engine: RollbackEngineLike | null = null;
  mesh: MeshLike | null = null;
  room: RoomLike | null = null;
  /** My roster slot (-1 before the welcome). */
  mySlot = -1;
  /** Tick 0 on the local clock (performance.now() ms); NaN before 'start'. */
  startAtLocal = Number.NaN;
  /** Kickoff resets performed on the confirmed timeline (seed + kickoffs). */
  kickoffs = 0;
  // Counters (monotonic per match; the stats view shows rates / totals).
  stallFrames = 0;
  /** Frames that skipped a tick because the engine was ahead of the slowest peer. */
  throttleFrames = 0;
  timesyncSkips = 0;
  hashesAgreed = 0;
  hashesDisagreed = 0;
  stateRequests = 0;
  resyncs = 0;
  /** Resyncs / rewinds that found a checkpoint (own or the majority's trailer) to realign Match + bots. */
  checkpointRestores = 0;
  peersDead = 0;

  private readonly game: P2PGameHooks;
  private readonly now: () => number;
  private readonly engineFactory: EngineFactory;
  private readonly roomFactory: (opts: RoomClientOptions) => RoomLike;
  private readonly meshFactory: (opts: MeshOptions) => MeshLike;

  // Roster (slot order).
  private numSlots = 0;
  private readonly names: string[] = [];
  private readonly teamOf = new Uint8Array(MAX_CARS);
  private readonly isBot = new Uint8Array(MAX_CARS);
  private readonly isPeer = new Uint8Array(MAX_CARS);
  /** Peer slots that left the room before the start (a replacement clears it). */
  private readonly peerGone = new Uint8Array(MAX_CARS);
  /** Peer slots the mesh declared dead and we reported to the room (awaiting its drop). */
  private readonly reportedDead = new Uint8Array(MAX_CARS);
  /** Tick from which a dropped human slot is a bot (-1 = never). */
  private readonly dropAt = new Int32Array(MAX_CARS).fill(-1);
  private readonly humanSlots: number[] = [];
  private readonly controls: CarControls[] = [];
  private blueTeam: BotTeam | null = null;
  private redTeam: BotTeam | null = null;
  private readonly blueBots: number[] = [];
  private readonly blueOuts: CarControls[] = [];
  private readonly redBots: number[] = [];
  private readonly redOuts: CarControls[] = [];
  private teamsDirty = false;
  private rosterApplied = false;

  // Inputs.
  private readonly packed = new Int8Array(PACKED_INPUT_BYTES);
  private readonly scratch = new Int8Array(P2P_INPUT_MAX_BATCH * PACKED_INPUT_BYTES);
  private readonly gameBuf = new Uint8Array(INPUT_HDR + P2P_INPUT_MAX_BATCH * PACKED_INPUT_BYTES);
  /** Exact-length views of gameBuf by length (the mesh then sends the view itself: no subarray per send). */
  private readonly gameViews: (Uint8Array | null)[] = [];
  private readonly ctlBuf = new Uint8Array(HASH_LEN);
  private readonly reqBuf = new Uint8Array(STATE_REQ_LEN);
  /** StateResponse frame: header + sim blob + checkpoint trailer (allocated with the checkpoint ring). */
  private stateBuf: Uint8Array | null = null;
  private readonly pkt: P2pInputPacket = { firstTick: 0, count: 0, ackTick: 0, myTick: 0, packed: new Int8Array(P2P_INPUT_MAX_BATCH * PACKED_INPUT_BYTES) };
  private readonly hashIn = { tick: 0, hash: 0 };
  private readonly stateReqIn = { tick: 0 };
  private readonly stateIn: StateResponsePacket = { tick: 0, len: 0, hash: 0, blob: new Uint8Array(0) };
  private readonly trailerSplit: StateTrailerSplit = { simLen: 0, count: 0 };
  /** Per peer slot: newest tick of OURS it acknowledged, newest tick of ITS inputs we hold. */
  private readonly peerAck = new Int32Array(MAX_CARS);
  private readonly peerNewest = new Int32Array(MAX_CARS);
  /** Per peer slot: the tick up to which we hold ALL its inputs (what we acknowledge; see sendInputs). */
  private readonly peerContig = new Int32Array(MAX_CARS);
  private readonly peerHashTick = new Int32Array(MAX_CARS).fill(-1);
  private readonly peerHash = new Uint32Array(MAX_CARS);
  private readonly localControls: CarControls = emptyControls();
  /** getMutators() scratch for the 'ready' fingerprint. */
  private readonly mutatorScratch = new Float32Array(MUTATOR_COUNT);

  // Checkpoints of the confirmed-timeline objects (see the header): a ring per tick and one per hash tick.
  private ckBuf: Float64Array | null = null;
  private readonly ckTick = new Int32Array(CHECKPOINT_TICKS).fill(-1);
  private readonly ckLen = new Int32Array(CHECKPOINT_TICKS);
  private hkBuf: Float64Array | null = null;
  private readonly hkTick = new Int32Array(HASH_RING).fill(-1);
  private readonly hkLen = new Int32Array(HASH_RING);
  private readonly ckRef: CheckpointRef = { buf: new Float64Array(0), off: 0, len: 0 };
  /** The trailer of the StateResponse being applied (count > 0 while engine.resync runs). */
  private trailerIn: Float64Array | null = null;
  private trailerCount = 0;
  /** The engine is re-running confirmed ticks it already reported (resync / rewind): no Game FX for their events. */
  private replaying = false;

  // Clock / loop.
  /** Start of the current FALLBACK_MS window: the welcome, restarted by every peerJoined. */
  private fallbackAt = 0;
  /** A room was assigned by the queue (a lock to release on the way out). */
  private roomAssigned = false;
  private readySent = false;
  private livenessArmed = false;
  private ticksSinceSend = 0;
  private lastSendAt = -1e9;
  private lastSkipTick = -1e9;
  private stallSince = -1;
  private waitSlot = -1;
  private waitText: string | null = null;
  private lastHashReportAt = -1e9;
  private hashReportDue = false;
  /** This room's 'turn' went out (once per room: the credentials cover every peer link of the seat). */
  private turnAsked = false;
  private lastConfirmedHash = 0;
  private lastConfirmedHashTick = 0;
  private minorityStreak = 0;
  private resyncedInStreak = false;
  private requestedTick = -1;
  private requestedSlot = -1;
  private expectedHash = 0;
  private wasScored = false;
  private inputDelay = P2P_INPUT_DELAY_DEFAULT;
  private hashEvery = P2P_HASH_EVERY;
  private alpha = 0;

  // Stats.
  private readonly rollbackMeter = new RateMeter(STATS_INTERVAL_MS);
  private readonly resimMeter = new RateMeter(STATS_INTERVAL_MS);
  private readonly bytesInMeter = new RateMeter(STATS_INTERVAL_MS);
  private readonly bytesOutMeter = new RateMeter(STATS_INTERVAL_MS);
  private statsAt = -1e9;
  /** Bumped by cancel() / leave() / fail(): async results of an older attempt are ignored. */
  private attempt = 0;
  /** This quickMatch already queued again after a room socket closed before its welcome (once). */
  private requeued = false;
  /** The room was a custom lobby's (joinAssigned): no server fallback, back to the lobby. */
  private lobbyRoom = false;

  constructor(game: P2PGameHooks, opts: P2PSessionOptions) {
    this.game = game;
    this.now = opts.now ?? defaultNow;
    this.engineFactory = opts.engineFactory;
    this.roomFactory = opts.roomFactory ?? ((o) => new RoomClient(o));
    this.meshFactory = opts.meshFactory ?? ((o) => new Mesh(o));
    this.client = opts.client ?? new NetClient();
    this.log = new P2PLog(this.now);
    this.match = new Match();
    for (let i = 0; i < MAX_CARS; i++) {
      this.controls.push(emptyControls());
      this.names.push('');
    }
    for (let i = 0; i <= this.gameBuf.length; i++) this.gameViews.push(null);
  }

  // ---- GameSession view --------------------------------------------------------------------

  /** The session owns the loop and the roster. */
  get active(): boolean {
    return this.state === 'connecting' || this.state === 'countdown' || this.state === 'playing' || this.state === 'ended';
  }

  /** Matchmaking / connecting: the menu shows `status` and Esc / B cancels. */
  get busy(): boolean {
    return this.state === 'queue' || this.state === 'signaling' || this.state === 'connecting';
  }

  /** A match is on screen and taking input. */
  get inMatch(): boolean {
    return this.state === 'countdown' || this.state === 'playing';
  }

  /** The current room plays experimental rules (no server fallback, nothing recorded). */
  get experimental(): boolean {
    return this.rules !== null;
  }

  get name(): string {
    return this.client.name;
  }

  setName(name: string): void {
    this.client.setName(name);
  }

  get statusText(): string | null {
    if (this.busy) return this.status;
    return this.error;
  }

  get statusIsError(): boolean {
    return !this.busy && this.error !== null;
  }

  /** Cars take no input: countdown, goal pause, after the whistle, not started. */
  get frozen(): boolean {
    if (!this.inMatch && this.state !== 'ended') return true;
    return this.confirmedFrozen;
  }

  get score(): { blue: number; red: number } {
    return this.match.score;
  }

  get overtime(): boolean {
    return this.match.overtime;
  }

  get displaySeconds(): number {
    return this.match.displaySeconds;
  }

  get clockMode(): ClockMode {
    const m = this.match;
    return m.overtime ? 'overtime' : m.isUnlimited ? 'unlimited' : 'regulation';
  }

  formatClock(): string {
    return this.match.formatClock();
  }

  /** In-match hint ('Esperando a <name>…' during a stall), null otherwise. */
  get hint(): string | null {
    return this.waitText;
  }

  private get confirmedFrozen(): boolean {
    const m = this.match;
    return m.frozen || m.inGoalPause || m.phase === 'ended' || m.phase === 'menu';
  }

  /** `slot` is driven by a BotTeam as of the last confirmed bot pass (room bots and dropped humans). */
  isBotSlot(slot: number): boolean {
    return slot >= 0 && slot < this.numSlots && this.isBot[slot] === 1;
  }

  /** Other peer slots of the roster that have not left the room before the start (they may still join / connect). */
  remainingPeers(): number {
    let n = 0;
    for (let s = 0; s < this.numSlots; s++) if (this.isPeer[s] === 1 && s !== this.mySlot && this.peerGone[s] === 0) n++;
    return n;
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  /** Quick match (P2P) in `mode`: guest session, queue, room. No-op unless idle. */
  quickMatch(mode: GameMode): void {
    if (this.state !== 'idle') return;
    this.requeued = false;
    this.lobbyRoom = false;
    this.queueP2p(mode, STATUS.queue, `quickMatch ${mode}`);
  }

  /**
   * Join a room the server already formed (a custom lobby's start answers every member with its
   * room ticket): skip the queue. No-op unless idle. A room close later does NOT re-queue (the
   * lobby decides what comes next).
   */
  joinAssigned(mode: GameMode, a: P2pAssignment): void {
    if (this.state !== 'idle') return;
    this.requeued = true;
    this.lobbyRoom = true;
    this.mode = mode;
    this.error = null;
    this.attempt++;
    this.log.push('assigned', `room ${a.roomId.slice(0, 8)}`);
    this.joinRoom(a);
  }

  /** POST /api/queue kind 'p2p' (quickMatch, or the one automatic retry of handleRoomClose). */
  private queueP2p(mode: GameMode, status: string, why: string): void {
    this.mode = mode;
    this.error = null;
    this.setState('queue', why);
    this.status = status;
    const attempt = ++this.attempt;
    this.client
      .queue(mode, 'p2p', (waiting) => {
        if (attempt === this.attempt && this.state === 'queue') this.status = queueStatus(waiting);
      })
      .then(
        (a) => {
          if (attempt !== this.attempt || this.state !== 'queue') {
            this.log.push('queue.late', `${a.kind} answer after attempt ${attempt} ended (state ${this.state})`);
            return;
          }
          if (a.kind === 'server') {
            // A lone human: the matchmaker formed a Durable Object match instead.
            this.log.push('queue.result', `server match ${a.matchId.slice(0, 8)}`);
            this.setState('idle', 'server answer');
            this.status = '';
            this.game.p2pHandover(mode, a, STATUS.serverAnswer);
            return;
          }
          this.log.push('queue.result', `p2p room ${a.roomId.slice(0, 8)} ${a.wsUrl}`);
          this.joinRoom(a);
        },
        (err: unknown) => {
          if (attempt !== this.attempt) return;
          if (err instanceof NetError && err.code === 'cancelled') {
            this.log.push('queue.cancelled');
            this.setState('idle', 'queue cancelled');
            this.status = '';
            return;
          }
          this.log.push('queue.error', logText(err));
          this.fail(describe(err), outcomeOf(err as NetError));
        },
      );
  }

  /** Abort matchmaking / signaling / connecting (Esc, B, PLAY). */
  cancel(): void {
    if (!this.busy) return;
    this.log.push('cancel', this.state);
    this.attempt++;
    this.client.cancelQueue();
    const hadRoster = this.rosterApplied;
    this.teardown();
    this.setState('idle', 'cancel');
    this.status = '';
    if (hadRoster) this.game.restoreOfflineRoster();
  }

  /** Leave the match (menu, quit, final whistle): close the room and the mesh, offline roster back. */
  leave(): void {
    if (this.state === 'idle') return;
    if (this.busy) {
      this.cancel();
      return;
    }
    this.log.push('leave', `${this.state} tick ${this.engine !== null ? this.engine.tick : -1}`);
    this.attempt++;
    this.teardown();
    this.setState('idle', 'leave');
    this.status = '';
    this.game.restoreOfflineRoster();
  }

  private setState(s: P2PState, why: string): void {
    if (s === this.state) return;
    this.log.push('state', `${this.state} -> ${s} (${why})`);
    this.state = s;
  }

  dispose(): void {
    this.leave();
  }

  // ---- loop --------------------------------------------------------------------------------

  /**
   * One frame: liveness / stats of the mesh, the connecting-phase bookkeeping (ready, fallback),
   * then the ticks due by the clock. Returns the interpolation alpha for the views.
   */
  advance(dt: number): number {
    void dt; // the P2P clock is wall-clock based (startAtLocal), not accumulated frame time
    const now = this.now();
    const mesh = this.mesh;
    if (mesh !== null) mesh.update(now);
    if (this.state === 'connecting') {
      this.advanceConnecting(now);
      return 0;
    }
    const engine = this.engine;
    if (engine === null || (this.state !== 'countdown' && this.state !== 'playing' && this.state !== 'ended')) return 0;
    this.runTicks(engine, now);
    if (now - this.statsAt >= STATS_INTERVAL_MS) {
      this.statsAt = now;
      this.updateStats(now);
    }
    return this.alpha;
  }

  /**
   * Connecting: 'ready' once EVERY other human slot that has not left is in the mesh with both
   * channels open (mesh.expectedCount() === remainingPeers(), at least one): a slot that has not
   * joined yet keeps us from saying ready, because 'ready' cannot be taken back and the room starts
   * once every connected peer said it (a late joiner would then be dropped at tick 0, or start with
   * a half-built mesh). The room declares a slot that never connects a no-show after P2P_NO_SHOW_MS
   * ('peerLeft'), which completes the condition for the ones present. A server match instead when
   * nobody is left to play with (every other peer ACTUALLY left before the start: 'peerLeft' or
   * `left` in the welcome) or when FALLBACK_MS passed since the welcome / the last 'peerJoined' /
   * 'peerLeft' without a 'start' (mesh incomplete, or ready sent and the room never started).
   */
  private advanceConnecting(now: number): void {
    const mesh = this.mesh;
    const room = this.room;
    if (mesh === null || room === null) return;
    if (this.remainingPeers() === 0) {
      this.log.push('fallback', 'every other peer left before the start');
      this.fallback(STATUS.nobodyLeft);
      return;
    }
    if (now - this.fallbackAt > FALLBACK_MS) {
      this.log.push('fallback', `${FALLBACK_MS} ms without start: mesh ${mesh.connectedCount()}/${mesh.expectedCount()} connected, ${this.remainingPeers()} peers expected, ready ${this.readySent ? 'sent' : 'not sent'}`);
      this.fallback(STATUS.fallback);
      return;
    }
    const remaining = this.remainingPeers();
    const expected = mesh.expectedCount();
    if (expected > 0 && expected === remaining && mesh.allConnected()) {
      if (!this.readySent) {
        this.readySent = true;
        this.log.push('ready', `mesh complete (${mesh.connectedCount()} of ${remaining} peers)`);
        room.ready(this.physicsFingerprint());
      }
      this.status = STATUS.readyWait;
      return;
    }
    this.status = connectingStatus(mesh.connectedCount(), remaining);
  }

  private runTicks(engine: RollbackEngineLike, now: number): void {
    let expected = expectedTickAt(now, this.startAtLocal);
    let steps = 0;
    let stalled = false;
    let throttled = false;
    while (engine.tick < expected && steps < MAX_TICKS_PER_FRAME) {
      if (!engine.canAdvance()) {
        if (engine.blockReason === 'throttle') {
          // Ahead of the slowest peer: tick 0 moves one tick later. One tick per frame at most
          // (the lead samples cannot change inside the loop: skipping the whole backlog at once
          // would shift the clock by the frame's worth of ticks).
          this.skipTick(engine);
          throttled = true;
          break;
        }
        stalled = true;
        break;
      }
      if (engine.blockReason === undefined && this.timesyncSkip(engine)) {
        expected = expectedTickAt(now, this.startAtLocal);
        continue;
      }
      this.stepTick(engine);
      steps++;
    }
    const frac = (now - this.startAtLocal) / TICK_MS - engine.tick;
    this.alpha = engine.tick >= expected ? (frac < 0 ? 0 : frac > 1 ? 1 : frac) : 1;
    if (steps > 0) {
      if (this.state === 'countdown') this.setState('playing', 'first tick');
      if (!this.livenessArmed) {
        // From the first local step on a silent peer is dead (GAME_DEAD_MS): arming at 'start'
        // would leave a peer whose first packet is late (hidden tab, clock offset) no margin.
        this.livenessArmed = true;
        if (this.mesh !== null) this.mesh.armLiveness(now);
      }
    }
    if (stalled) {
      this.stallFrames++;
      if (this.stallSince < 0) this.stallSince = now;
      else if (now - this.stallSince >= STALL_HINT_MS) this.updateWaitHint();
    } else {
      this.stallSince = -1;
      this.setWaitSlot(-1);
    }
    if (throttled) this.throttleFrames++;
    // Keep repeating our newest inputs while blocked: a stall may be mutual after a lost packet,
    // and a throttled peer must still refresh its ack / tick and keep the liveness alive.
    if ((stalled || throttled) && now - this.lastSendAt >= STALL_RESEND_MS) this.sendInputs(engine, now);
    if (this.ticksSinceSend >= SEND_EVERY) this.sendInputs(engine, now);
    this.publishHashes(engine, now);
  }

  /** A timesync skip: tick 0 moves one tick later on the local clock. */
  private skipTick(engine: RollbackEngineLike): void {
    this.lastSkipTick = engine.tick;
    this.startAtLocal += TICK_MS;
    this.timesyncSkips++;
  }

  /** Engines without blockReason: too far ahead of the slowest peer by framesAhead() (once per TIMESYNC_MIN_GAP_TICKS). */
  private timesyncSkip(engine: RollbackEngineLike): boolean {
    if (engine.tick - this.lastSkipTick < TIMESYNC_MIN_GAP_TICKS) return false;
    const ahead = engine.framesAhead();
    if (ahead <= TIMESYNC_AHEAD + this.halfRttTicks()) return false;
    this.skipTick(engine);
    return true;
  }

  /** The largest peer rtt / 2 in ticks (the reported remote ticks are that old). */
  private halfRttTicks(): number {
    const mesh = this.mesh;
    if (mesh === null) return 0;
    let rtt = 0;
    for (let s = 0; s < this.numSlots; s++) {
      if (this.isPeer[s] === 0 || s === this.mySlot) continue;
      const r = mesh.peerRttMs(s);
      if (r > rtt) rtt = r;
    }
    return Math.ceil(rtt / 2 / TICK_MS);
  }

  /** One predicted tick: sample, pack, register for tick + inputDelay, advance the engine. */
  private stepTick(engine: RollbackEngineLike): void {
    const c = this.localControls;
    this.game.p2pSampleInput(c);
    const packed = this.packed;
    if (this.confirmedFrozen) packed.fill(0);
    else packControls(c, packed, 0);
    engine.addLocalInput(packed, 0);
    engine.advance();
    this.ticksSinceSend++;
    this.game.p2pAfterTick();
  }

  /** The view of gameBuf of exactly `len` bytes (cached per length: the mesh sends it as is). */
  private gameView(len: number): Uint8Array {
    let v = this.gameViews[len];
    if (v === null) {
      v = this.gameBuf.subarray(0, len);
      this.gameViews[len] = v;
    }
    return v;
  }

  /**
   * Our local inputs to every live peer: everything newer than what it acknowledged (its ackTick =
   * the tick up to which it holds ALL our inputs), oldest first, `ackTick` = the same for its
   * inputs here. A backlog longer than one batch (a stall after losses: the receiver cannot
   * advance, its ack stands still while our auto-filled ticks pile up) goes out as several packets:
   * one packet carrying only the newest P2P_INPUT_MAX_BATCH ticks would leave a hole that no later
   * ack could close, and both peers would wait for each other for good.
   */
  private sendInputs(engine: RollbackEngineLike, now: number): void {
    this.ticksSinceSend = 0;
    this.lastSendAt = now;
    const mesh = this.mesh;
    const newest = engine.newestLocalTick;
    if (mesh === null || newest < 1) return;
    for (let s = 0; s < this.numSlots; s++) {
      if (this.isPeer[s] === 0 || s === this.mySlot || this.dropAt[s] >= 0) continue;
      let acked = this.peerAck[s];
      if (engine.copyLocalInputs !== undefined) {
        let chunks = 0;
        while (newest - acked > P2P_INPUT_MAX_BATCH && chunks < MAX_BACKLOG_CHUNKS) {
          chunks++;
          const first = acked + 1;
          // Unknown = older than the engine's input store: that peer is past GAME_DEAD_MS anyway.
          if (engine.copyLocalInputs(first, P2P_INPUT_MAX_BATCH, this.scratch)) {
            const len = encodeP2pInput(this.gameBuf, first, P2P_INPUT_MAX_BATCH, this.peerContig[s], engine.tick, this.scratch, 0);
            mesh.sendGame(s, this.gameView(len), len);
          }
          acked += P2P_INPUT_MAX_BATCH;
        }
      }
      const len = assembleGamePacket(engine, acked, this.peerContig[s], engine.tick, this.gameBuf, this.scratch);
      if (len > 0) mesh.sendGame(s, this.gameView(len), len);
    }
  }

  /**
   * Confirmed hashes (every hashEvery ticks) go to every peer over 'ctl'; a summary goes to the
   * room every HASH_REPORT_EVERY_MS and right after a disagreeing vote (the room only monitors:
   * every report wakes the Durable Object). A state request nobody answered within a hash period
   * is forgotten, so the next minority verdict asks again.
   */
  private publishHashes(engine: RollbackEngineLike, now: number): void {
    const mesh = this.mesh;
    const hashes = engine.confirmedHashes();
    if (mesh !== null) {
      for (let i = 0; i < hashes.length; i++) {
        const h = hashes[i];
        const len = encodeHash(this.ctlBuf, h.tick, h.hash);
        mesh.broadcastCtl(this.ctlBuf, len);
        this.lastConfirmedHash = h.hash;
        this.lastConfirmedHashTick = h.tick;
      }
    }
    if (this.requestedTick >= 0 && engine.confirmedTick >= this.requestedTick + this.hashEvery) {
      this.requestedTick = -1;
      this.requestedSlot = -1;
    }
    const room = this.room;
    if (room !== null && this.lastConfirmedHashTick > 0 && (this.hashReportDue || now - this.lastHashReportAt >= HASH_REPORT_EVERY_MS)) {
      this.lastHashReportAt = now;
      this.hashReportDue = false;
      room.hashReport(this.lastConfirmedHashTick, this.lastConfirmedHash, this.hashesAgreed, this.hashesDisagreed);
    }
  }

  private updateWaitHint(): void {
    const engine = this.engine;
    if (engine !== null && engine.waitingFor !== undefined) {
      this.setWaitSlot(engine.waitingFor());
      return;
    }
    // The human peer whose newest input is the oldest is the one we wait for.
    let worst = -1;
    let worstTick = 0x7fffffff;
    for (let s = 0; s < this.numSlots; s++) {
      if (this.isPeer[s] === 0 || s === this.mySlot || this.dropAt[s] >= 0) continue;
      if (this.peerNewest[s] < worstTick) {
        worstTick = this.peerNewest[s];
        worst = s;
      }
    }
    this.setWaitSlot(worst);
  }

  private setWaitSlot(slot: number): void {
    if (slot === this.waitSlot) return;
    this.waitSlot = slot;
    this.waitText = slot < 0 ? null : waitingStatus(this.names[slot]);
  }

  // ---- engine hooks (confirmed timeline only) ----------------------------------------------

  /** The state buffer from the arena without the bridge's FX events (those belong to the predicted timeline). */
  private mutedSync(): void {
    const sim = this.game.sim;
    if (sim.syncQuiet !== undefined) {
      sim.syncQuiet();
      return;
    }
    const ev = sim.events;
    const g = ev.onGoal;
    const b = ev.onBump;
    const h = ev.onBallHit;
    ev.onGoal = undefined;
    ev.onBump = undefined;
    ev.onBallHit = undefined;
    try {
      sim.sync();
    } finally {
      ev.onGoal = g;
      ev.onBump = b;
      ev.onBallHit = h;
    }
  }

  /** Bot inputs for `tick` from the confirmed state at tick - 1 (which the engine has in the arena). */
  private botInputs(tick: number, packedOut: Int8Array): void {
    this.mutedSync();
    this.applyDrops(tick);
    const sim = this.game.sim;
    const n = this.numSlots;
    if (this.confirmedFrozen) {
      // Frozen (countdown / goal pause / whistle): nobody moves, humans included, like the phase 1 host.
      for (let s = 0; s < n; s++) zeroPacked(packedOut, s * PACKED_INPUT_BYTES);
      return;
    }
    // Every confirmed tick, never on predicted ones: the wasm tracker's incremental / full decision
    // then depends on the confirmed ball states alone (identical on every peer). A FULL
    // re-prediction at agreed ticks: when the arena holds a hash tick's state (a resync lands on a
    // hash tick) and at every drop tick (a rewind lands on atTick - 1), so a peer that loaded a
    // state holds the same prediction as the ones that updated incrementally through it (the
    // tracker reuses its data within a tolerance: histories matter, see forceBallPrediction).
    if (sim.forceBallPrediction !== undefined && ((tick - 1) % this.hashEvery === 0 || this.isDropTick(tick))) sim.forceBallPrediction();
    else sim.updateBallPrediction();
    if (this.redBots.length > 0 && this.redTeam !== null) this.redTeam.think(sim, this.redOuts);
    if (this.blueBots.length > 0 && this.blueTeam !== null) this.blueTeam.think(sim, this.blueOuts);
    for (let s = 0; s < n; s++) if (this.isBot[s] === 1) packControls(this.controls[s], packedOut, s * PACKED_INPUT_BYTES);
  }

  private isDropTick(tick: number): boolean {
    const n = this.numSlots;
    for (let s = 0; s < n; s++) if (this.dropAt[s] === tick) return true;
    return false;
  }

  /** Human slots dropped at a tick <= `tick` join their team's BotTeam (deterministic: keyed to the confirmed tick). */
  private applyDrops(tick: number): void {
    const n = this.numSlots;
    for (let s = 0; s < n; s++) {
      const at = this.dropAt[s];
      if (at >= 0 && at <= tick && this.isBot[s] === 0) {
        this.isBot[s] = 1;
        this.teamsDirty = true;
      }
    }
    if (this.teamsDirty) this.rebuildTeams();
  }

  private rebuildTeams(): void {
    this.teamsDirty = false;
    const blue = this.blueBots;
    const blueOuts = this.blueOuts;
    const red = this.redBots;
    const redOuts = this.redOuts;
    blue.length = 0;
    blueOuts.length = 0;
    red.length = 0;
    redOuts.length = 0;
    const bluePassive: number[] = [];
    const redPassive: number[] = [];
    for (let s = 0; s < this.numSlots; s++) {
      const redTeam = this.teamOf[s] === Team.Red;
      if (this.isBot[s] === 1) {
        (redTeam ? red : blue).push(s);
        (redTeam ? redOuts : blueOuts).push(this.controls[s]);
      } else (redTeam ? redPassive : bluePassive).push(s);
    }
    if (this.blueTeam !== null) this.blueTeam.setSlots(blue, bluePassive);
    if (this.redTeam !== null) this.redTeam.setSlots(red, redPassive);
  }

  /** Match flow for confirmed `tick` (state after the step in the arena), then the checkpoint of `tick`. */
  private onConfirmedTick(tick: number): void {
    this.mutedSync();
    const sim = this.game.sim;
    const scored = sim.isBallScored();
    if (scored && !this.wasScored) {
      // Ball inside a net on the confirmed timeline: y > 0 is the red net, so blue scored.
      const team: Team = sim.buf[BALL_OFFSET + B_POS + 1] > 0 ? Team.Blue : Team.Red;
      this.match.onGoal(team);
    }
    this.wasScored = scored;
    const events = this.match.tick(TICK_DT);
    for (let i = 0; i < events.length; i++) this.onMatchEvent(events[i]);
    this.saveCheckpoint(tick);
  }

  private onMatchEvent(e: MatchEvent): void {
    switch (e.type) {
      case 'kickoffReset': {
        const w = this.welcome;
        this.game.sim.resetKickoff(kickoffSeedOf(w !== null ? w.seed : 0, this.kickoffs++));
        this.wasScored = false;
        if (this.blueTeam !== null) this.blueTeam.reset();
        if (this.redTeam !== null) this.redTeam.reset();
        if (!this.replaying) this.game.p2pKickoffReset();
        return;
      }
      case 'freeze':
        return;
      case 'ended':
        if (this.state === 'ended') return;
        this.setState('ended', `whistle ${this.match.score.blue}-${this.match.score.red}`);
        this.game.p2pMatchEvent(e, this.match.score.blue, this.match.score.red);
        return;
      default:
        if (!this.replaying) this.game.p2pMatchEvent(e, this.match.score.blue, this.match.score.red);
        return;
    }
  }

  /**
   * The majority's confirmed state replaced ours at `tick`: realign the confirmed-timeline objects
   * from the response's trailer (the majority's checkpoint) or, without one, from our own
   * checkpoint of `tick`; later checkpoints belong to the abandoned timeline.
   */
  private onResync(tick: number): void {
    this.mutedSync();
    const trailer = this.trailerIn;
    if (trailer !== null && this.trailerCount > 0) {
      this.readCheckpoint(trailer, 0);
      this.checkpointRestores++;
    } else if (!this.restoreOwnCheckpoint(tick)) {
      this.wasScored = this.game.sim.isBallScored();
    }
    // Every other checkpoint belongs to the abandoned timeline (the engine forgets its snapshots too).
    this.resetCheckpoints();
    this.saveCheckpoint(tick);
    this.game.afterRollback();
  }

  /** The engine rewound the confirmed timeline to the snapshot of `tick` (a drop already confirmed): same realignment from our checkpoint. */
  private onRewind(tick: number): void {
    this.mutedSync();
    if (!this.restoreOwnCheckpoint(tick)) this.wasScored = this.game.sim.isBallScored();
    this.forgetCheckpointsAfter(tick);
    this.game.afterRollback();
  }

  private onHashDecided(tick: number, agreed: boolean): void {
    void tick;
    if (agreed) {
      // Back in the majority: the streak is over and an answer still pending is moot.
      this.minorityStreak = 0;
      this.resyncedInStreak = false;
      this.requestedTick = -1;
      this.requestedSlot = -1;
    } else this.hashReportDue = true;
  }

  private onDesync(tick: number, mine: number, majority: number, agree: number, disagree: number): void {
    void mine;
    void agree;
    void disagree;
    this.minorityStreak++;
    this.log.push('desync', `tick ${tick} streak ${this.minorityStreak} agree ${agree} disagree ${disagree}`);
    if (this.minorityStreak >= DESYNC_GIVE_UP_AT || (this.minorityStreak >= DESYNC_ABANDON_AT && this.resyncedInStreak)) {
      this.disconnect(STATUS.desync);
      return;
    }
    if (this.minorityStreak < DESYNC_RESYNC_AT) return;
    if (this.requestedTick >= 0) return; // one request in flight (forgotten after a hash period)
    const source = this.majoritySlot(tick, majority);
    const mesh = this.mesh;
    if (source < 0 || mesh === null) return;
    const len = encodeStateRequest(this.reqBuf, tick);
    if (mesh.sendCtl(source, this.reqBuf, len)) {
      this.requestedTick = tick;
      this.requestedSlot = source;
      this.expectedHash = majority >>> 0;
      this.stateRequests++;
      this.log.push('stateRequest>', `slot ${source} tick ${tick}`);
    }
  }

  /** The lowest live human peer whose vote at `tick` is the majority's (engine.voteOf, else the last hash heard); 1v1: the lower slot is the reference. */
  private majoritySlot(tick: number, majority: number): number {
    const engine = this.engine;
    let fallback = -1;
    for (let s = 0; s < this.numSlots; s++) {
      if (this.isPeer[s] === 0 || s === this.mySlot || this.dropAt[s] >= 0) continue;
      const vote = engine !== null && engine.voteOf !== undefined ? engine.voteOf(s, tick) : this.peerHashTick[s] === tick ? this.peerHash[s] : -1;
      if (vote === majority) return s;
      if (fallback < 0 && s < this.mySlot) fallback = s;
    }
    return fallback;
  }

  // ---- checkpoints -----------------------------------------------------------------------------

  /** Everything the hooks derive (kickoffs, scored flag, bot layout, Match, both teams) at out[off..]; returns the end offset. */
  private writeCheckpoint(out: Float64Array, off: number): number {
    let o = off;
    out[o++] = this.kickoffs;
    out[o++] = this.wasScored ? 1 : 0;
    for (let s = 0; s < MAX_CARS; s++) out[o++] = this.isBot[s];
    o = this.match.saveState(out, o);
    if (this.blueTeam !== null) o = this.blueTeam.saveState(out, o);
    if (this.redTeam !== null) o = this.redTeam.saveState(out, o);
    return o;
  }

  /** Restore a checkpoint written by writeCheckpoint (the teams are re-laid out from the saved bot flags first). */
  private readCheckpoint(src: Float64Array, off: number): void {
    let o = off;
    this.kickoffs = src[o++];
    this.wasScored = src[o++] !== 0;
    for (let s = 0; s < MAX_CARS; s++) this.isBot[s] = src[o++] !== 0 ? 1 : 0;
    this.rebuildTeams();
    o = this.match.loadState(src, o);
    if (this.blueTeam !== null) o = this.blueTeam.loadState(src, o);
    if (this.redTeam !== null) o = this.redTeam.loadState(src, o);
    if (this.state === 'ended' && this.match.phase !== 'ended') this.state = 'playing';
  }

  private saveCheckpoint(tick: number): void {
    const ck = this.ckBuf;
    const hk = this.hkBuf;
    if (ck === null || hk === null) return;
    const i = tick % CHECKPOINT_TICKS;
    const off = i * CHECKPOINT_FLOATS;
    const len = this.writeCheckpoint(ck, off) - off;
    this.ckTick[i] = tick;
    this.ckLen[i] = len;
    if (tick > 0 && tick % this.hashEvery === 0) {
      const e = ((tick / this.hashEvery) | 0) % HASH_RING;
      const dst = e * CHECKPOINT_FLOATS;
      for (let k = 0; k < len; k++) hk[dst + k] = ck[off + k];
      this.hkTick[e] = tick;
      this.hkLen[e] = len;
    }
  }

  /** The checkpoint of `tick` (per-tick ring, then the hash ring) into ckRef; null when gone. */
  private checkpointAt(tick: number): CheckpointRef | null {
    const ck = this.ckBuf;
    const hk = this.hkBuf;
    if (ck === null || hk === null || tick < 0) return null;
    const ref = this.ckRef;
    const i = tick % CHECKPOINT_TICKS;
    if (this.ckTick[i] === tick) {
      ref.buf = ck;
      ref.off = i * CHECKPOINT_FLOATS;
      ref.len = this.ckLen[i];
      return ref;
    }
    if (tick > 0 && tick % this.hashEvery === 0) {
      const e = ((tick / this.hashEvery) | 0) % HASH_RING;
      if (this.hkTick[e] === tick) {
        ref.buf = hk;
        ref.off = e * CHECKPOINT_FLOATS;
        ref.len = this.hkLen[e];
        return ref;
      }
    }
    return null;
  }

  private restoreOwnCheckpoint(tick: number): boolean {
    const c = this.checkpointAt(tick);
    if (c === null) return false;
    this.readCheckpoint(c.buf, c.off);
    this.checkpointRestores++;
    return true;
  }

  private forgetCheckpointsAfter(tick: number): void {
    for (let i = 0; i < CHECKPOINT_TICKS; i++) if (this.ckTick[i] > tick) this.ckTick[i] = -1;
    for (let e = 0; e < HASH_RING; e++) if (this.hkTick[e] > tick) this.hkTick[e] = -1;
  }

  private resetCheckpoints(): void {
    this.ckTick.fill(-1);
    this.hkTick.fill(-1);
    this.trailerCount = 0;
  }

  /** The checkpoint ring, the trailer scratch and the StateResponse frame (once per session, on the first room). */
  private ensureCheckpointBuffers(): void {
    if (this.ckBuf !== null) return;
    this.ckBuf = new Float64Array(CHECKPOINT_TICKS * CHECKPOINT_FLOATS);
    this.hkBuf = new Float64Array(HASH_RING * CHECKPOINT_FLOATS);
    this.trailerIn = new Float64Array(CHECKPOINT_FLOATS);
    this.stateBuf = new Uint8Array(STATE_RESP_HDR + MAX_STATE_BYTES + stateTrailerBytes(CHECKPOINT_FLOATS));
  }

  // ---- room ----------------------------------------------------------------------------------

  private joinRoom(a: P2pAssignment): void {
    this.setState('signaling', 'room assigned');
    this.status = STATUS.room;
    this.roomAssigned = true;
    const room = this.roomFactory({ now: this.now, log: this.log });
    this.room = room;
    room.onWelcome = (w) => this.handleWelcome(w);
    room.onPeerJoined = (slot) => this.handlePeerJoined(slot);
    room.onPeerLeft = (slot) => this.handlePeerLeft(slot);
    room.onSignal = (from, data) => {
      if (this.mesh !== null) this.mesh.handleSignal(from, data);
      else this.log.push('sig<', `${from} before the mesh exists: ignored`);
    };
    room.onStart = (startAt) => this.handleStart(startAt);
    room.onDrop = (slot, atTick) => this.handleDrop(slot, atTick);
    room.onError = (code, message) => this.handleRoomError(code, message);
    room.onClose = (code, reason) => this.handleRoomClose(code, reason);
    room.onSignalDropped = (to) => {
      if (this.mesh !== null && this.mesh.signalDropped !== undefined) this.mesh.signalDropped(to);
    };
    // TURN on demand: the room answers our 'turn' (sent once, on the mesh's first ICE trouble).
    this.turnAsked = false;
    room.onTurn = (list) => {
      const applied = this.mesh !== null && this.mesh.setIceServers !== undefined && this.mesh.setIceServers(list);
      this.log.push('turn', applied ? `${list.length} servers, ICE restarted` : 'none for us');
    };
    room.connect(a.wsUrl, a.ticket);
  }

  private handleWelcome(w: RoomWelcome): void {
    if (this.state !== 'signaling' || this.room === null) {
      this.log.push('welcome.ignored', `state ${this.state}`);
      return;
    }
    const slots = w.slots.slice().sort((a, b) => a.slot - b.slot);
    if (slots.length === 0 || slots.length > MAX_CARS || slots.length > NET_STATS_MAX_PEERS) {
      this.fail(t('p2p.badSlots', { count: slots.length }));
      return;
    }
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].slot !== i) {
        this.fail(t('p2p.slotGap'));
        return;
      }
    }
    if (w.you.slot < 0 || w.you.slot >= slots.length || slots[w.you.slot].kind !== 'peer') {
      this.fail(t('p2p.badSlot', { slot: w.you.slot }));
      return;
    }
    try {
      this.game.applyP2PRoster(w);
    } catch (err) {
      // The arena may be gone or half built (createArena destroys it when the wasm refuses the
      // rules): fail() rebuilds the offline one, as after any applied roster.
      this.rosterApplied = true;
      this.fail(`Roster: ${describe(err)}`);
      return;
    }
    this.rosterApplied = true;
    this.welcome = w;
    this.rules = w.physics ?? null;
    this.mode = w.mode;
    this.mySlot = w.you.slot;
    this.numSlots = slots.length;
    this.humanSlots.length = 0;
    this.dropAt.fill(-1);
    this.peerGone.fill(0);
    this.reportedDead.fill(0);
    this.peerAck.fill(0);
    this.peerNewest.fill(0);
    this.peerContig.fill(0);
    this.peerHashTick.fill(-1);
    this.peerHash.fill(0);
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      this.names[i] = s.name;
      this.teamOf[i] = s.team;
      this.isBot[i] = s.kind === 'bot' ? 1 : 0;
      this.isPeer[i] = s.kind === 'peer' ? 1 : 0;
      if (s.kind === 'peer') this.humanSlots.push(i);
      // Gone for good (socket closed / left through the matchmaker): not waited for, like a peerLeft.
      if (s.kind === 'peer' && s.left === true && !s.connected && i !== w.you.slot) this.peerGone[i] = 1;
    }
    for (let i = slots.length; i < MAX_CARS; i++) {
      this.names[i] = '';
      this.isBot[i] = 0;
      this.isPeer[i] = 0;
    }
    // Room parameters within what the engine accepts (a bad value falls back to the default
    // instead of throwing from the socket handler with the arena already replaced).
    this.inputDelay = roomInt(w.inputDelay, 0, 32, P2P_INPUT_DELAY_DEFAULT);
    this.hashEvery = roomInt(w.hashEvery, 1, 600, P2P_HASH_EVERY);
    const window = roomInt(w.window, 1, MAX_PREDICTED, P2P_WINDOW_DEFAULT);
    // Per-match counters (the HUD panel shows them as this match's totals; the previous match's
    // values stay readable until the next room).
    this.stallFrames = 0;
    this.throttleFrames = 0;
    this.timesyncSkips = 0;
    this.hashesAgreed = 0;
    this.hashesDisagreed = 0;
    this.stateRequests = 0;
    this.resyncs = 0;
    this.checkpointRestores = 0;
    this.peersDead = 0;
    const sim = this.game.sim;
    sim.resetKickoff(kickoffSeedOf(w.seed, 0));
    this.kickoffs = 0;
    this.wasScored = false;
    // The room's physics profile (the stock one for standard rules): the same integers on every
    // peer give the same profile, so the bots stay deterministic under any rules.
    const physics = botPhysicsOf(this.rules?.values ?? {});
    this.blueTeam = new BotTeam({ team: Team.Blue, difficulty: P2P_BOT_DIFFICULTY, seed: w.seed, physics });
    this.redTeam = new BotTeam({ team: Team.Red, difficulty: P2P_BOT_DIFFICULTY, seed: (w.seed + RED_SEED_OFFSET) | 0, physics });
    this.teamsDirty = true;
    this.rebuildTeams();
    this.match = new Match({ lengthSeconds: w.matchLengthSeconds });
    this.match.start();
    this.ensureCheckpointBuffers();
    this.resetCheckpoints();
    const hooks: EngineHooks = {
      botInputs: (tick, out) => this.botInputs(tick, out),
      onConfirmedTick: (tick) => this.onConfirmedTick(tick),
      onResync: (tick) => this.onResync(tick),
      onRewind: (tick) => this.onRewind(tick),
      onDesync: (tick, mine, majority, agree, disagree) => this.onDesync(tick, mine, majority, agree, disagree),
      onHashDecided: (tick, agreed) => this.onHashDecided(tick, agreed),
    };
    let engine: RollbackEngineLike;
    try {
      engine = this.engineFactory(sim, slots.length, this.humanSlots, this.mySlot, hooks, { inputDelay: this.inputDelay, window, hashEvery: this.hashEvery });
    } catch (err) {
      console.error('P2P engine:', describe(err));
      this.fail(t('p2p.engine'), 'reload');
      return;
    }
    if (engine.onDesync !== undefined) engine.onDesync = hooks.onDesync;
    if (engine.onHashDecided !== undefined) engine.onHashDecided = hooks.onHashDecided;
    this.engine = engine;
    // The checkpoint of tick 0: the kickoff layout with the fresh Match / teams.
    this.saveCheckpoint(sim.tickCount);
    const room = this.room;
    const mesh = this.meshFactory({
      mySlot: this.mySlot,
      iceServers: w.iceServers,
      signal: (to, data) => {
        room.signal(to, data);
      },
      now: this.now,
      log: this.log,
    });
    mesh.onGame = (slot, bytes) => this.handleGame(slot, bytes);
    mesh.onCtl = (slot, bytes) => this.handleCtl(slot, bytes);
    mesh.onPeerDead = (slot) => this.handlePeerDead(slot);
    mesh.onIceTrouble = () => {
      if (this.turnAsked || this.room === null || this.room.requestTurn === undefined) return;
      this.turnAsked = true;
      this.room.requestTurn();
    };
    this.mesh = mesh;
    for (const s of slots) if (s.kind === 'peer' && s.slot !== this.mySlot && s.connected) mesh.addPeer(s.slot);
    this.fallbackAt = this.now();
    this.readySent = false;
    this.livenessArmed = false;
    this.setState('connecting', `welcome: me ${this.mySlot}, ${mesh.expectedCount()} peers present, ${this.remainingPeers()} expected`);
    this.status = connectingStatus(0, mesh.expectedCount());
    this.fillPeerNames();
  }

  /**
   * A peer joined (or re-joined) the room. The mesh gets it (the lower slot then offers); a peer
   * already negotiating gets its pending offer re-sent (the room may have dropped the first one,
   * sent before this socket existed). The fallback window restarts: a peer that just arrived
   * deserves its own FALLBACK_MS to complete the mesh.
   */
  private handlePeerJoined(s: RoomSlot): void {
    if (!this.active || this.mesh === null) return;
    if (s.kind !== 'peer' || s.slot < 0 || s.slot >= this.numSlots || s.slot === this.mySlot) return;
    this.peerGone[s.slot] = 0;
    if (!s.connected || this.dropAt[s.slot] >= 0) return;
    const mesh = this.mesh;
    mesh.addPeer(s.slot);
    if (mesh.reoffer !== undefined) mesh.reoffer(s.slot);
    if (this.state === 'connecting') {
      this.fallbackAt = this.now();
      this.log.push('fallback.restart', `peer ${s.slot} joined: ${FALLBACK_MS} ms window restarted`);
    }
  }

  private handlePeerLeft(slot: number): void {
    // Before the start the mesh stops expecting it; it counts as gone until a replacement joins
    // (advanceConnecting falls back when nobody is left). Mid-match the room's drop handles it.
    if (this.state !== 'connecting' || this.mesh === null) return;
    if (slot >= 0 && slot < this.numSlots && this.isPeer[slot] === 1 && slot !== this.mySlot) this.peerGone[slot] = 1;
    this.mesh.removePeer(slot);
    const remaining = this.remainingPeers();
    if (remaining > 0) {
      // The room re-evaluates its start without that slot (a no-show, or a peer that gave up): the
      // ones still here get a whole window to finish the mesh, say ready and receive the 'start'.
      this.fallbackAt = this.now();
    }
    this.log.push('peerLeft', `slot ${slot}: ${remaining} peers still expected`);
  }

  private handleStart(startAt: number): void {
    if (this.state !== 'connecting' || this.room === null || this.mesh === null) {
      this.log.push('start.ignored', `state ${this.state}`);
      return;
    }
    this.startAtLocal = this.room.serverToLocal(startAt);
    this.log.push('start', `tick 0 at local ${this.startAtLocal.toFixed(1)} (now ${this.now().toFixed(1)}, in ${(this.startAtLocal - this.now()).toFixed(0)} ms)`);
    this.setState('countdown', 'start received');
    this.status = '';
    // The clock offset is set; from here on the pings only keep the room socket alive.
    if (this.room.setPingIntervalMs !== undefined) this.room.setPingIntervalMs(ROOM_PING_INTERVAL_MATCH_MS);
    this.game.p2pMatchOnScreen();
  }

  private handleDrop(slot: number, atTick: number): void {
    if (!this.active || slot < 0 || slot >= this.numSlots) return;
    if (slot === this.mySlot) {
      this.disconnect(STATUS.droppedMe);
      return;
    }
    if (this.dropAt[slot] >= 0) return;
    this.log.push('drop', `slot ${slot} atTick ${atTick} (confirmed ${this.engine !== null ? this.engine.confirmedTick : -1}, tick ${this.engine !== null ? this.engine.tick : -1})`);
    this.dropAt[slot] = atTick;
    this.reportedDead[slot] = 0;
    if (this.engine !== null && this.isPeer[slot] === 1) {
      // A drop tick already confirmed makes the engine rewind and re-run (onRewind, hooks): no Game FX twice.
      this.replaying = true;
      try {
        this.engine.drop(slot, atTick);
      } finally {
        this.replaying = false;
      }
    }
    if (this.mesh !== null) this.mesh.removePeer(slot);
    if (this.waitSlot === slot) this.setWaitSlot(-1);
    this.game.p2pSlotDropped(slot, this.names[slot]);
  }

  /**
   * The mesh gave a peer link up. During the match the room is told the first tick we have no
   * input of that peer for (contiguousInputTick + 1): the room drops it at the minimum over the
   * reporters, so nobody has to guess an input below the drop tick. Before the start a dead link
   * is a mesh failure: advanceConnecting falls back (the room ignores pre-start reports anyway).
   * Without a room socket nobody can coordinate the drop and the match would stall for good.
   */
  private handlePeerDead(slot: number): void {
    this.peersDead++;
    this.log.push('peerDead', `slot ${slot} state ${this.state}`);
    if (!this.inMatch || slot < 0 || slot >= this.numSlots || this.dropAt[slot] >= 0) return;
    const room = this.room;
    if (room === null) {
      this.disconnect(STATUS.lostRoom);
      return;
    }
    const engine = this.engine;
    const contig = engine !== null && engine.contiguousInputTick !== undefined ? engine.contiguousInputTick(slot) : -1;
    const at = contig >= 0 ? contig + 1 : engine !== null ? engine.tick : 0;
    this.reportedDead[slot] = 1;
    room.unreachable(slot, at);
  }

  private handleRoomError(code: string, message: string): void {
    if (code === ROOM_ERROR_PHYSICS_MISMATCH) {
      // The room refused our 'ready': our arena does not run the room's rules. It closes the socket.
      this.log.push('room.physics', message);
      if (this.state === 'signaling' || this.state === 'connecting') this.fail(STATUS.physicsMismatch);
      else this.error = STATUS.physicsMismatch;
      return;
    }
    if (code === P2P_ERROR_RELOAD || code === P2P_ERROR_BAD_PHYSICS) {
      // Another P2P protocol in the welcome: this page is stale, only a reload helps.
      this.log.push('room.reload', message);
      if (this.state === 'signaling' || this.state === 'connecting') this.fail(STATUS.reload, 'reload');
      else this.error = STATUS.reload;
      return;
    }
    if (this.state === 'signaling' || this.state === 'connecting') {
      console.warn(`P2P room error ${code}: ${message}`); // the code for the console, the text for the player
      this.fail(message);
      return;
    }
    this.error = message;
  }

  private handleRoomClose(code: number, reason: string): void {
    if (this.state === 'signaling' && !this.requeued) {
      // Closed before the welcome: the room refused the upgrade (browsers hide its status: a seat
      // given up after the no-show grace answers 403 'left', an expired ticket 401, a room already
      // gone 404, all read 1006) or the socket died on the way. The seat is lost either way: release
      // the lock (teardown; the next queue waits for it) and queue again, once per quickMatch.
      this.requeued = true;
      this.log.push('room.requeue', `closed before the welcome (${code}${reason.length > 0 ? ` ${reason}` : ''}): queueing again`);
      const mode = this.mode;
      this.attempt++;
      this.teardown();
      this.queueP2p(mode, STATUS.requeue, 'room closed before the welcome');
      return;
    }
    if (this.state === 'signaling' || this.state === 'connecting') {
      console.warn(`P2P room closed (${code}${reason.length > 0 ? `: ${reason}` : ''})`);
      this.fail(t('p2p.roomClosed'));
      return;
    }
    // Mid-match the room is only needed for drops: the mesh keeps the match going, unless a drop
    // is already pending (a peer reported dead and not yet dropped): that one would never come.
    this.room = null;
    if (!this.inMatch) return;
    this.log.push('room.lost', `mid-match (${code} ${reason})`);
    for (let s = 0; s < this.numSlots; s++) {
      if (this.reportedDead[s] === 1 && this.dropAt[s] < 0) {
        this.disconnect(STATUS.lostRoom);
        return;
      }
    }
  }

  // ---- mesh --------------------------------------------------------------------------------

  private handleGame(slot: number, bytes: Uint8Array): void {
    const engine = this.engine;
    if (engine === null || slot < 0 || slot >= this.numSlots) return;
    const pkt = this.pkt;
    if (!decodeP2pInput(bytes, pkt)) return;
    engine.addRemoteInput(slot, pkt.firstTick, pkt.count, pkt.packed);
    engine.noteRemoteTick(slot, pkt.myTick, pkt.ackTick);
    if (pkt.ackTick > this.peerAck[slot]) this.peerAck[slot] = pkt.ackTick;
    const newest = pkt.firstTick + pkt.count - 1;
    if (newest > this.peerNewest[slot]) this.peerNewest[slot] = newest;
    // What we acknowledge: the tick up to which we hold ALL of that peer's inputs, so a hole left
    // by a lost chunk is resent (engines without the query: the newest, as every packet of a peer
    // is contiguous with the previous ack).
    const contig = engine.contiguousInputTick !== undefined ? engine.contiguousInputTick(slot) : newest;
    this.peerContig[slot] = contig < 0 ? 0 : contig;
  }

  private handleCtl(slot: number, bytes: Uint8Array): void {
    const engine = this.engine;
    const mesh = this.mesh;
    if (engine === null || mesh === null || slot < 0 || slot >= this.numSlots || bytes.length === 0) return;
    switch (p2pMsgType(bytes)) {
      case P2pMsg.Hash: {
        const h = this.hashIn;
        if (!decodeHash(bytes, h)) return;
        this.peerHashTick[slot] = h.tick;
        this.peerHash[slot] = h.hash;
        const verdict = engine.receiveHash(slot, h.tick, h.hash);
        if (verdict === 'agree') this.hashesAgreed++;
        else if (verdict === 'disagree') {
          this.hashesDisagreed++;
          this.hashReportDue = true;
          this.log.push('hash.disagree', `slot ${slot} tick ${h.tick} theirs ${h.hash >>> 0} (disagreed ${this.hashesDisagreed}, agreed ${this.hashesAgreed})`);
        }
        return;
      }
      case P2pMsg.StateRequest: {
        const q = this.stateReqIn;
        if (!decodeStateRequest(bytes, q)) return;
        const buf = this.stateBuf;
        if (buf === null) return;
        const st = engine.stateAt(q.tick);
        if (st === null) return;
        let len = encodeStateResponse(buf, q.tick, st.hash, st.blob, st.len);
        // Our checkpoint of that tick rides along, so the requester adopts our Match / bots too.
        const ck = this.checkpointAt(q.tick);
        if (ck !== null) {
          len = encodeStateTrailer(buf, len, ck.buf, ck.off, ck.len);
          setStateResponseLen(buf, len - STATE_RESP_HDR);
        }
        mesh.sendCtl(slot, buf, len);
        return;
      }
      case P2pMsg.StateResponse: {
        const r = this.stateIn;
        if (!decodeStateResponse(bytes, r)) return;
        // Only the answer we asked for: from that peer, for that tick, carrying the majority hash
        // and a blob that hashes to it (nobody overwrites our confirmed state otherwise).
        if (this.requestedTick < 0 || slot !== this.requestedSlot || r.tick !== this.requestedTick || r.hash !== this.expectedHash) return;
        const trailer = this.trailerIn;
        if (trailer === null) return;
        splitStateTrailer(r.blob, r.len, trailer, this.trailerSplit);
        const simLen = this.trailerSplit.simLen;
        if (simLen <= 0 || fnv1a32(r.blob, simLen) !== r.hash) return;
        this.requestedTick = -1;
        this.requestedSlot = -1;
        this.trailerCount = this.trailerSplit.count;
        this.replaying = true;
        try {
          engine.resync(r.tick, r.blob, simLen);
        } catch (err) {
          this.error = `Resync: ${describe(err)}`;
          this.log.push('resync.error', this.error);
          return;
        } finally {
          this.replaying = false;
          this.trailerCount = 0;
        }
        this.resyncs++;
        this.resyncedInStreak = true;
        this.log.push('resync', `from slot ${slot} tick ${r.tick} (${simLen} sim bytes, trailer ${this.trailerSplit.count} floats)`);
        return;
      }
      default:
        return;
    }
  }

  // ---- internals ---------------------------------------------------------------------------

  /**
   * Mesh not complete in time / nobody left: leave the room and let the Game queue a server match.
   * The lock release (teardown -> NetClient.leaveMatch) is awaited by the client's next queue, so
   * the fallback's server queue cannot be refused with 409 by our own stale room lock. A lobby's
   * room never becomes a public Casual match: back to the lobby (fail: Game.p2pFailed).
   */
  private fallback(notice: string): void {
    if (this.rules !== null) {
      // An experimental room never becomes a casual server match: back to the lobby.
      this.log.push('handover.refused', `experimental rules "${this.rules.name}": no server fallback (${notice})`);
      this.fail(STATUS.experimentalFailed);
      return;
    }
    if (this.lobbyRoom) {
      this.log.push('handover.refused', `lobby room: no public queue (${notice})`);
      this.fail(STATUS.lobbyFailed);
      return;
    }
    this.log.push('handover', notice);
    this.attempt++;
    const mode = this.mode;
    this.teardown();
    this.setState('idle', 'fallback');
    this.status = '';
    this.game.p2pHandover(mode, null, notice);
  }

  /**
   * The fingerprint of the arena's mutators as the wasm reads them back (what 'ready' carries: the
   * room compares it with its rules'); undefined when the sim cannot read them (test fakes).
   */
  private physicsFingerprint(): number | undefined {
    const sim = this.game.sim;
    if (sim.getMutators === undefined) return undefined;
    try {
      return mutatorFingerprint(sim.getMutators(this.mutatorScratch));
    } catch (err) {
      this.log.push('physics.read', logText(err));
      return undefined;
    }
  }

  /** Matchmaking / signaling / connecting failed: back to idle with the error on the menu (and what it leaves to do). */
  private fail(message: string, outcome: Outcome = 'retry'): void {
    this.log.push('fail', message);
    this.errorOutcome = outcome;
    this.attempt++;
    this.client.cancelQueue();
    const hadRoster = this.rosterApplied;
    this.teardown();
    this.setState('idle', 'fail');
    this.status = '';
    this.error = message;
    if (hadRoster) this.game.restoreOfflineRoster();
    if (this.game.p2pFailed !== undefined) this.game.p2pFailed(message);
  }

  /** The match died (desync, dropped by the room, room lost with a dead peer): the Game shows the menu (which leaves the session). */
  private disconnect(message: string): void {
    this.log.push('disconnect', message);
    this.error = message;
    this.game.onSessionDisconnected(message);
  }

  /**
   * Close the mesh and the room socket and, when a room was assigned, free the matchmaker lock
   * through POST /api/leave (best effort; the matchmaker also kicks our room socket if it is still
   * open, so the other peers get 'peerLeft' even when our close frame is late).
   */
  private teardown(): void {
    const mesh = this.mesh;
    const room = this.room;
    this.mesh = null;
    this.room = null;
    if (mesh !== null) mesh.close();
    if (room !== null) room.dispose();
    if (this.roomAssigned) {
      this.roomAssigned = false;
      this.log.push('release', 'POST /api/leave (room lock)');
      void this.client.leaveMatch().then(
        (released) => this.log.push('release.done', released ? 'lock released' : 'nothing to release'),
        (err: unknown) => this.log.push('release.error', logText(err)),
      );
    }
    this.engine = null;
    this.welcome = null;
    this.rules = null;
    this.rosterApplied = false;
    this.blueTeam = null;
    this.redTeam = null;
    this.blueBots.length = 0;
    this.blueOuts.length = 0;
    this.redBots.length = 0;
    this.redOuts.length = 0;
    this.humanSlots.length = 0;
    this.numSlots = 0;
    this.mySlot = -1;
    this.startAtLocal = Number.NaN;
    this.readySent = false;
    this.livenessArmed = false;
    this.ticksSinceSend = 0;
    this.lastSendAt = -1e9;
    this.lastSkipTick = -1e9;
    this.stallSince = -1;
    this.setWaitSlot(-1);
    this.lastHashReportAt = -1e9;
    this.hashReportDue = false;
    this.lastConfirmedHash = 0;
    this.lastConfirmedHashTick = 0;
    this.minorityStreak = 0;
    this.resyncedInStreak = false;
    this.requestedTick = -1;
    this.requestedSlot = -1;
    this.wasScored = false;
    this.replaying = false;
    this.alpha = 0;
    this.resetCheckpoints();
    this.match.reset();
    this.rollbackMeter.reset();
    this.resimMeter.reset();
    this.bytesInMeter.reset();
    this.bytesOutMeter.reset();
    resetNetStatsView(this.stats); // the HUD panel keeps this object: no stale rows after the match
  }

  private fillPeerNames(): void {
    const s = this.stats;
    let k = 0;
    for (let slot = 0; slot < this.numSlots && k < NET_STATS_MAX_PEERS; slot++) {
      if (this.isPeer[slot] === 0 || slot === this.mySlot) continue;
      s.p2pPeerSlot[k] = slot;
      s.p2pPeerName[k] = this.names[slot];
      k++;
    }
    s.p2pPeers = k;
  }

  private updateStats(now: number): void {
    const s = this.stats;
    const engine = this.engine;
    const mesh = this.mesh;
    s.state = this.state;
    s.kind = 'p2p';
    s.lead = this.inputDelay;
    s.inputDelay = this.inputDelay;
    s.leadAdjust = 0;
    s.rateScale = 1;
    s.lossPct = 0;
    s.jitterMs = 0;
    s.snapshotAgeMs = -1;
    s.reconnects = 0;
    s.mispredictions = engine !== null && engine.stats.mispredictions !== undefined ? engine.stats.mispredictions : 0;
    s.errorCar = 0;
    let rtt = 0;
    for (let k = 0; k < s.p2pPeers; k++) {
      const slot = s.p2pPeerSlot[k];
      if (mesh !== null) {
        s.p2pPeerRtt[k] = mesh.peerRttMs(slot);
        s.p2pPeerCand[k] = mesh.peerCand(slot);
        s.p2pPeerState[k] = this.dropAt[slot] >= 0 ? PEER_STATE_DROPPED : mesh.peerState(slot);
        if (s.p2pPeerState[k] === PEER_STATE_CONNECTED && s.p2pPeerRtt[k] > rtt) rtt = s.p2pPeerRtt[k];
      }
      s.p2pPeerTick[k] = this.peerNewest[slot];
    }
    s.rttMs = rtt;
    s.bufferHint = engine !== null ? engine.framesAhead() : 0;
    s.hostTick = engine !== null ? engine.confirmedTick : 0;
    s.localTick = engine !== null ? engine.tick : 0;
    s.confirmedTick = s.hostTick;
    s.predictedAhead = engine !== null ? engine.tick - engine.confirmedTick : 0;
    s.rollbacksPerSec = this.rollbackMeter.sample(now, engine !== null ? engine.stats.rollbacks : 0);
    s.replayedPerSec = this.resimMeter.sample(now, engine !== null ? engine.stats.resimTicks : 0);
    s.desyncs = engine !== null ? engine.stats.desyncs : 0;
    s.resyncs = this.resyncs;
    s.stalls = this.stallFrames;
    s.timesyncSkips = this.timesyncSkips;
    s.bytesInPerSec = this.bytesInMeter.sample(now, mesh !== null ? mesh.bytesIn : 0);
    s.bytesOutPerSec = this.bytesOutMeter.sample(now, mesh !== null ? mesh.bytesOut : 0);
  }
}

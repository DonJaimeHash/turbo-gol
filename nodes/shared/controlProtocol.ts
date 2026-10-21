/**
 * Control plane <-> node protocol. Pure types and constants, no runtime dependencies: shared by
 * the node program (node/), the reference control plane (control-plane/), the browser adapter
 * (client/) and, later, the NodeRegistryDO in the Worker.
 *
 * Transport
 *   HTTP   POST /nodes/register                one-time registration token -> node identity
 *          PUT  /nodes/replays/<matchId>       replay upload (node-signed, see replayRequestMessage)
 *          GET  /nodes/replays/<matchId>       replay download for a verifier node (node-signed)
 *          GET  /nodes/releases/channel        { stable, minimum } for the launcher
 *          GET  /nodes/releases/<v>/<file>     signed release files
 *          POST /nodes/rtc/<node>/<match>/ice    { ticket } -> { iceServers }      (players, WebRTC nodes)
 *          POST /nodes/rtc/<node>/<match>/offer  { ticket, sdp } -> { sdp }        (players, WebRTC nodes)
 *   WS     GET  /nodes/connect                 the node's ONE outbound control connection (text
 *                                              frames, one JSON message each). The node always
 *                                              dials out: it never exposes an admin port, like a
 *                                              GitHub Actions runner or a Lichess fishnet client.
 *
 * Two ways players reach a node (NodeTransport):
 *   'wss'  a public IP with ports 80/443: WebSocket over TLS straight to the node (Caddy + a Let's
 *          Encrypt IP certificate). The browser needs nothing new: same protocol as MatchDO.
 *   'rtc'  a home PC behind NAT / CGNAT: one reliable, ordered WebRTC DataChannel ('tg') carrying
 *          exactly the same frames. Signaling is one offer / answer through the control plane
 *          (non-trickle: both sides gather first), ICE with STUN and TURN, so it works without
 *          opening ports. The browser wraps it as a WebSocket (client/rtcSocket.ts).
 *
 * Handshake on /nodes/connect: control -> { t: 'challenge', nonce }, node -> { t: 'auth', nodeId,
 * sig = Ed25519(node key, authMessage(nodeId, nonce)) }, control -> { t: 'welcome' }, node ->
 * { t: 'hello' }. Then heartbeats every HEARTBEAT_MS, requests with a `rid` answered by a
 * { t: 'reply', rid } and reports (match results) acknowledged by { t: 'ack', id }.
 */
import type { RosterEntry } from '../../server/src/roomHost';
import type { Difficulty } from '../../src/ai/Bot';

export type { RosterEntry, Difficulty };

export const CONTROL_PROTOCOL = 2;
export const HEARTBEAT_MS = 5_000;
/**
 * A node silent for this long is offline: no new matches. Its control link and its running matches
 * last longer (LINK_TIMEOUT_MS and NODE_OFFLINE_MS in control-plane/controlPlane.ts).
 */
export const HEARTBEAT_TIMEOUT_MS = 15_000;
/** Request -> reply timeout (assign, leave). */
export const RPC_TIMEOUT_MS = 5_000;
/** An rtcOffer includes the node's ICE gathering (STUN / TURN round trips). */
export const RTC_OFFER_TIMEOUT_MS = 10_000;
/** Verification can take a few seconds of CPU (a long match with bots). */
export const VERIFY_TIMEOUT_MS = 60_000;
/** MatchDO's TTL_AFTER_MATCH_MS: a match still running this long after its regulation ends is whistled (wall clock from the assignment). */
export const TTL_AFTER_MATCH_SECONDS = 600;
/** Exit code the node uses after draining for an update: the launcher re-checks the channel and restarts. */
export const EXIT_UPDATE = 75;

/** The DataChannel label of a WebRTC node connection. */
export const RTC_CHANNEL = 'tg';
/**
 * First byte of the transport-level close frame on the DataChannel: [0xFE, code hi, code lo,
 * ...reason UTF-8]. A DataChannel has no close codes; this carries the WebSocket ones (1000
 * 'ended', 4000 'replaced', 1008 'rate'...) that NetClient acts on. Never a game MsgType.
 */
export const RTC_CLOSE_FRAME = 0xfe;

export type NodeRole = 'host' | 'verify';
export type NodeTransport = 'wss' | 'rtc';
export type GameMode = '1v1' | '2v2' | '3v3';

/** Same shape as RTCIceServer / the existing /api/ice answer. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * pending    registered, not proven reachable yet (no matches)
 * probation  reachable; casual matches only until PROBATION_MATCHES verified matches
 * active     ranked too (a trusted, project-run node skips probation)
 * suspended  a failed verification (until a maintainer looks) or too many lost matches (lifts by
 *            itself after a cooldown)
 * banned     permanent
 */
export type NodeStatus = 'pending' | 'probation' | 'active' | 'suspended' | 'banned';

/** What makes two simulations compatible: same wasm bytes and same client <-> host protocol. */
export interface BuildId {
  /** Node program version (semver of the release). */
  version: string;
  /** src/net/protocol.ts PROTOCOL_VERSION. */
  protocol: number;
  /** SHA-256 of rocketsim.wasm (hex). */
  wasmSha256: string;
}

export interface NodeSpecs {
  cpus: number;
  cpuModel: string;
  memMB: number;
  arch: string;
  os: string;
  node: string;
}

/** Measured by node/bench.ts (or declared by the operator when the benchmark is skipped). */
export interface NodeCapacity {
  /** Concurrent matches this node accepts. */
  matches: number;
  /** CPU per second of match (ms), 3v3 with six bots: the worst case. */
  cpuMsPerMatchSecond: number;
  /** Resident memory per match (MB). */
  memMBPerMatch: number;
  /** Operator-declared upload bandwidth (Mbit/s), null when not given. */
  uplinkMbps: number | null;
  source: 'bench' | 'declared';
}

export interface ReleaseChannel {
  stable: string;
  /** Older nodes get an 'update' and no new matches. */
  minimum: string;
  canary?: string;
}

/** A match placed on a node (the control plane's record; the replay header must match it). */
export interface MatchAssignment {
  matchId: string;
  mode: GameMode;
  region: string;
  ranked: boolean;
  roster: RosterEntry[];
  matchLengthSeconds: number;
  kickoffSeed: number;
  botDifficulty: Difficulty;
  createdAt: number;
  /** Optional timing overrides (tests, short demo matches). They change the simulation, so the replay records them. */
  kickoffCountdownSeconds?: number;
  goalPauseSeconds?: number;
  /** Ranked: every player must be connected and ready this long after the assignment (default 45 s). */
  joinTimeoutMs?: number;
}

// ---- HTTP: registration ---------------------------------------------------------------------

export interface RegisterRequest {
  token: string;
  publicKey: string;
  name?: string;
  roles: NodeRole[];
  /** How players can reach a host (default: ['wss'] with a publicUrl, else ['rtc']). */
  transports?: NodeTransport[];
  /** wss:// (or ws:// in local development) base URL players reach; null without 'wss'. */
  publicUrl: string | null;
  build: BuildId;
  specs: NodeSpecs;
  capacity: NodeCapacity;
}

export interface RegisterAnswer {
  nodeId: string;
  operatorId: string;
  region: string;
  name: string;
  status: NodeStatus;
  /** Verifies the EdDSA match tickets and signed control data. */
  controlPublicKey: string;
  /** Where to open the control WebSocket (ws(s)://.../nodes/connect). */
  controlUrl: string;
}

// ---- WebSocket messages ---------------------------------------------------------------------

export interface HelloData {
  /** Random per process start: a new one means the node restarted and every match it held is gone. */
  bootId?: string;
  build: BuildId;
  roles: NodeRole[];
  transports: NodeTransport[];
  publicUrl: string | null;
  /** The WebRTC self-test passed (a DataChannel through the given ICE servers opened). */
  rtcReady: boolean;
  /** That self-test went through a TURN relay (the only proof that any player can reach the node). */
  rtcRelay?: boolean;
  specs: NodeSpecs;
  capacity: NodeCapacity;
  draining: boolean;
  /** Monthly egress cap the operator set (GB), null = none. */
  egressCapGB: number | null;
}

export interface HeartbeatData {
  active: number;
  capacity: number;
  draining: boolean;
  /** Bytes sent to players this calendar month, in GB. */
  egressGB: number;
  egressCapGB: number | null;
  /** p99 of (tick execution time - ideal tick time) over the last interval, ms. */
  tickLagP99Ms: number;
  /** Fraction of one core the process used over the last interval (0..1+). */
  cpuLoad: number;
  rssMB: number;
  matches: Array<{ matchId: string; tick: number; phase: string; sockets: number }>;
}

export type EndReason = 'rules' | 'forfeit' | 'ttl' | 'left' | 'empty';

export interface MatchResult {
  winner: 0 | 1 | -1;
  blue: number;
  red: number;
  endTick: number;
  endReason: EndReason;
  /** The team that forfeited (endReason 'forfeit'). */
  forfeitTeam?: 0 | 1;
}

export interface SlotStatsReport {
  slot: number;
  received: number;
  dropped: number;
  underruns: number;
  overruns: number;
  /** Time a socket was attached to this slot while the match ran (ms). */
  connectedMs: number;
  /**
   * A socket was attached to this slot at the whistle. MatchDO rates a ranked player without one
   * as a leaver; the control plane takes this from trusted nodes only. Nodes before 0.2.0 do not
   * send it: read as true.
   */
  connectedAtEnd: boolean;
}

export interface MatchStats {
  ticks: number;
  durationMs: number;
  slots: SlotStatsReport[];
  tickLagP99Ms: number;
  egressBytes: number;
}

export type MatchReport =
  /** The match ran (started) and stopped for `result.endReason`; the replay was uploaded first. */
  | { kind: 'ended'; matchId: string; result: MatchResult; replaySha256: string; replayBytes: number; stats: MatchStats }
  /** Never started: ranked no-show / dodge, or an unused room. `noShows`: players to give an abandon. */
  | { kind: 'cancelled'; matchId: string; reason: string; noShows: string[] }
  /** Lost without a usable replay (tick error, replay upload failed): nothing to rate. */
  | { kind: 'lost'; matchId: string; reason: string };

export interface VerifyJob {
  matchId: string;
  /** Players whose explicit leave (POST /api/leave) the control plane relayed: the only takeovers a replay may contain. */
  leaves: string[];
  /** The node that hosted the match (the replay header must name it). */
  hostNodeId: string;
  /** Absolute URL of the replay (GET, node-signed). */
  replayUrl: string;
  /** The control plane's own record: the replay header must agree with it. */
  expect: MatchAssignment;
  /** sha256 the reporting node declared for the replay. */
  replaySha256: string;
}

export type ToNode =
  | { t: 'challenge'; nonce: string }
  | { t: 'welcome'; nodeId: string; status: NodeStatus; region: string; channel: ReleaseChannel; serverTime: number; iceServers: IceServer[] }
  | { t: 'status'; status: NodeStatus; reason?: string }
  | { t: 'assign'; rid: string; match: MatchAssignment }
  | { t: 'leave'; rid: string; matchId: string; playerId: string }
  | { t: 'verify'; rid: string; job: VerifyJob }
  /** A player's WebRTC offer (the ticket proves the seat; the node checks it like a WebSocket upgrade). */
  | { t: 'rtcOffer'; rid: string; matchId: string; ticket: string; sdp: string; iceServers: IceServer[] }
  | { t: 'drain'; reason: string }
  | { t: 'update'; version: string }
  | { t: 'ack'; id: string }
  | { t: 'error'; code: string; message?: string };

export type FromNode =
  | { t: 'auth'; nodeId: string; sig: string }
  | { t: 'hello'; data: HelloData }
  | { t: 'heartbeat'; data: HeartbeatData }
  | { t: 'reply'; rid: string; ok: true; data?: unknown }
  | { t: 'reply'; rid: string; ok: false; code: string; message?: string }
  | { t: 'report'; id: string; report: MatchReport };

/** Answer to 'assign'. */
export interface AssignAnswer {
  /** wss nodes: where the players connect (ws(s)://host/m/<matchId>). null for an rtc-only node. */
  wsUrl: string | null;
}

/** Answer to 'rtcOffer'. */
export interface RtcAnswer {
  sdp: string;
}

/** Answer to 'leave' (mirrors MatchDO's MatchLeaveAnswer). */
export interface LeaveAnswer {
  slot: number;
  closed: boolean;
  already: boolean;
  ended: boolean;
}

export interface VerifyVerdict {
  ok: boolean;
  code: VerifyCode;
  message?: string;
  /** First checkpoint tick whose state hash differed. */
  divergedAtTick?: number;
  ticks: number;
  score: { blue: number; red: number };
  winner: 0 | 1 | -1;
  finalHash: number;
  cpuMs: number;
  /** How the replay says the match ended (proven when ok): the control plane rates from this, never from the report. */
  endReason?: EndReason;
  forfeitTeam?: 0 | 1;
  /** Per roster slot: ticks the slot was a present human (bots 0). Long all-zero stretches (a disconnected slot) do not count. */
  presentTicks?: number[];
  /** Roster slots whose explicit leave the replay proves (a takeover). */
  leftSlots?: number[];
  /** The takeover tick of each leftSlots entry (same order): the control plane checks it against when the leave was relayed. */
  leftTicks?: number[];
  /** Per roster slot: the tick a human was gone from (takeover, or the start of its final all-zero stretch); -1 still playing, bots -1. */
  goneTicks?: number[];
}

export type VerifyCode =
  | 'ok'
  | 'bad_replay'
  | 'build_mismatch'
  | 'header_mismatch'
  | 'hash_mismatch'
  | 'score_mismatch'
  | 'end_mismatch'
  | 'forfeit_unproven'
  | 'bad_takeover'
  | 'too_long'
  | 'error';

/**
 * Verdicts that prove the HOST lied or broke the rules (the node is suspended, the operator's
 * shop frozen). 'build_mismatch' and 'error' are the verifier's side: the job is retried.
 */
export const HOST_FAULT_CODES: readonly VerifyCode[] = ['bad_replay', 'header_mismatch', 'hash_mismatch', 'score_mismatch', 'end_mismatch', 'forfeit_unproven', 'bad_takeover', 'too_long'];

// ---- signed strings -------------------------------------------------------------------------

/** What a node signs to answer the control challenge. */
export function authMessage(nodeId: string, nonce: string): string {
  return `tgn-auth.v1.${nodeId}.${nonce}`;
}

/** What a node signs for a replay upload / download (headers x-node-id, x-node-sig, x-node-ts). */
export function replayRequestMessage(method: 'PUT' | 'GET', matchId: string, sha256: string, ts: number): string {
  return `tgn-replay.v1.${method}.${matchId}.${sha256}.${ts}`;
}

/** What a node signs for the reachability probe (GET /healthz?nonce=). */
export function reachMessage(nodeId: string, nonce: string): string {
  return `tgn-reach.v1.${nodeId}.${nonce}`;
}

/** Same build as the clients: same wasm and protocol. What placement needs (the browser only speaks the protocol). */
export function sameBuild(a: BuildId | null | undefined, b: BuildId | null | undefined): boolean {
  return !!a && !!b && a.wasmSha256 === b.wasmSha256 && a.protocol === b.protocol;
}

/**
 * Same simulation: same wasm, same protocol AND the same node release. The release bundles the
 * JavaScript that runs the match (RoomHost, match rules, bots, the arena mesh), so a release that
 * changes any of it without a new wasm or protocol still re-simulates differently. Verification
 * needs this stronger match: a verifier on another release would report a hash mismatch and
 * blame an honest host.
 */
export function sameSimulation(a: BuildId | null | undefined, b: BuildId | null | undefined): boolean {
  return sameBuild(a, b) && !!a && !!b && a.version === b.version;
}

/** Compare two dotted versions numerically (1.2.10 > 1.2.9). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The path a player's socket factory recognises as a WebRTC node: /nodes/rtc/<nodeId>/<matchId>. */
export const RTC_PATH = /^\/nodes\/rtc\/([0-9a-f]{16})\/([0-9A-Za-z_-]{8,64})$/;

/** The URL the matchmaker hands a player for a match on an rtc node (wss:// so old code paths keep it absolute). */
export function rtcMatchUrl(siteBase: string, nodeId: string, matchId: string): string {
  return `${siteBase.replace(/^http/, 'ws').replace(/\/$/, '')}/nodes/rtc/${nodeId}/${matchId}`;
}

/** Encode a close frame for the DataChannel transport. */
export function encodeRtcClose(code: number, reason: string): Uint8Array {
  const r = new TextEncoder().encode(reason).subarray(0, 123);
  const out = new Uint8Array(3 + r.length);
  out[0] = RTC_CLOSE_FRAME;
  out[1] = (code >>> 8) & 0xff;
  out[2] = code & 0xff;
  out.set(r, 3);
  return out;
}

/** Decode a close frame, or null when `buf` is not one. */
export function decodeRtcClose(buf: Uint8Array): { code: number; reason: string } | null {
  if (buf.length < 3 || buf[0] !== RTC_CLOSE_FRAME) return null;
  let reason = '';
  try {
    // ignoreBOM: false is the default; @cloudflare/workers-types requires it spelled out (the Worker's typecheck reaches this file).
    reason = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf.subarray(3));
  } catch {
    reason = '';
  }
  return { code: (buf[1] << 8) | buf[2], reason };
}

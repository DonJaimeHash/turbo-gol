/**
 * Phase 2 wire protocol: peer-to-peer deterministic rollback (GGPO style) between 2-6 browsers.
 * Pure TypeScript shared by the client (src/net/p2p) and the signaling Worker (server/src/RoomDO.ts).
 *
 * Two transports:
 *  1. Signaling: JSON messages over a WebSocket to the room Durable Object (hibernating, cheap).
 *     Carries the room config, WebRTC offers/answers/ICE, readiness, the synchronised start, and
 *     drop announcements. Never carries game inputs.
 *  2. Mesh: WebRTC DataChannels between every pair of peers. 'game' is unordered + unreliable
 *     (maxRetransmits 0) and carries input batches; 'ctl' is ordered + reliable and carries hash
 *     reports and state resync. Binary, little-endian, byte 0 = P2pMsg.
 *
 * Determinism contract: every peer runs the same RocketSim wasm, the same BotTeam (seeded from the
 * room seed) and the same Match logic on the CONFIRMED timeline (a tick is confirmed when every
 * human slot's input for it is known). Bots and match events are evaluated only on confirmed ticks,
 * so re-simulation never advances a bot's RNG or re-fires a goal differently on two peers.
 */
import { PACKED_INPUT_BYTES } from '../../sim/types';

/**
 * Signaling protocol version (RoomWelcome.protocol; a mismatch tells the client to reload).
 *   1  first deploy
 *   2  the room answers a signal to a slot without a socket with error 'signal_dropped' (non-fatal
 *      for the sender; a version 1 client treated every 'error' as fatal), RoomSlot.left, 'peerLeft'
 *      with an empty peerId for a slot that never connected (left through the matchmaker or declared
 *      a no-show after P2P_NO_SHOW_MS), and the start waits for every slot that may still join.
 *      POST /api/queue { kind: 'p2p' } carries `p2pProtocol` (QueueRequestP2p): a page cached from
 *      before a deploy is refused with 426 P2P_ERROR_RELOAD instead of taking a room seat.
 *   3: the field changed (rounded goals): every peer simulates on the same collision mesh, so a
 *      page from before is refused the same way. Bump it whenever the shared simulation changes
 *      (the field, the physics, the bots): peers on different builds would desync.
 */
export const P2P_PROTOCOL_VERSION = 3;

/**
 * Error code of a P2P protocol mismatch, on both paths: POST /api/queue { kind: 'p2p' } without
 * this build's P2P_PROTOCOL_VERSION in `p2pProtocol` answers 426 { error: 'reload_required' } (a
 * version 1 page shows "queue failed (426 reload_required)"), and RoomClient fails with this code
 * when a welcome carries another protocol. P2PSession shows STATUS.reload for either.
 */
export const P2P_ERROR_RELOAD = 'reload_required';

/**
 * A peer slot whose socket has not opened this long after the room was created is declared a
 * no-show by the room: 'peerLeft' { slot, peerId: '' } to the others (they stop waiting for it and
 * start without it, its car being the team AI from tick 0) and its ticket is refused from then on
 * (403 'left'). Must leave the client's FALLBACK_MS (10 s from the welcome, restarted by every
 * 'peerJoined') enough margin for the room's 'start' to arrive: no-show + START_DELAY + a round trip.
 */
export const P2P_NO_SHOW_MS = 6000;

/** Fixed input delay (ticks) a peer applies to its own inputs; rooms in one region use 3 (25 ms). */
export const P2P_INPUT_DELAY_DEFAULT = 3;
/** Prediction window: how far the predicted timeline may run ahead of the confirmed one before stalling. */
export const P2P_WINDOW_DEFAULT = 16;
/** Confirmed-state hash reports every N ticks. */
export const P2P_HASH_EVERY = 30;
/** Max ticks per input batch (newest 2 + redundancy of unacked). */
export const P2P_INPUT_MAX_BATCH = 16;

// ---- Signaling (JSON over WebSocket to RoomDO) --------------------------------------------------

export interface RoomSlot {
  slot: number;
  team: 0 | 1;
  name: string;
  kind: 'peer' | 'bot';
  /** Opaque per-connection id of the peer owning this slot (undefined for bots / not yet joined). */
  peerId?: string;
  connected: boolean;
  /**
   * The peer is gone for good (its socket closed, or it told the matchmaker it left through
   * POST /api/leave before ever connecting): a later joiner must not wait for it. A room ticket
   * is single use, so a slot that lost its socket never comes back. Absent = false.
   */
  left?: boolean;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Room -> peer, right after the socket is accepted. */
export interface RoomWelcome {
  type: 'room';
  protocol: number;
  roomId: string;
  mode: '1v1' | '2v2' | '3v3';
  /** Shared seed: kickoff deal (rs_reset_kickoff(seed)) and bot RNG (BotTeam seed = seed). */
  seed: number;
  inputDelay: number;
  window: number;
  hashEvery: number;
  tickRate: number;
  matchLengthSeconds: number;
  you: { slot: number; peerId: string };
  slots: RoomSlot[];
  /** STUN/TURN servers for RTCPeerConnection (TURN credentials are short-lived when present). */
  iceServers: IceServer[];
  /** Server wall clock (ms since epoch) when this message was sent, for a coarse clock offset. */
  now: number;
}

export type RoomServerMessage =
  | RoomWelcome
  | { type: 'peerJoined'; slot: RoomSlot }
  /** The slot is gone for good; `peerId` is '' when it never connected (left through the matchmaker, or a no-show). */
  | { type: 'peerLeft'; slot: number; peerId: string }
  /** Relay of a WebRTC signal from another peer (sdp or ICE candidate). */
  | { type: 'signal'; from: number; data: SignalData }
  /** Everyone is ready: tick 0 is simulated at startAt (server clock, ms); countdown is run by Match from tick 0. */
  | { type: 'start'; startAt: number; now: number }
  /** A peer is gone for good: from `atTick` on its slot is driven by the team AI on every peer. */
  | { type: 'drop'; slot: number; atTick: number }
  | { type: 'pong'; t0: number; now: number }
  /**
   * `code` ROOM_ERROR_SIGNAL_DROPPED (with `to` = the target slot): a 'signal' could not be relayed
   * because that slot has no socket yet; the sender re-offers when the slot joins (Mesh.reoffer)
   * or after OFFER_RETRY_MS. Every other code is a fatal room error for the client.
   */
  | { type: 'error'; code: string; message?: string; to?: number };

/** RoomServerMessage 'error' code of a dropped signal relay (not fatal: the offer is re-sent). */
export const ROOM_ERROR_SIGNAL_DROPPED = 'signal_dropped';

export type SignalData = { sdp: { type: 'offer' | 'answer'; sdp: string } } | { candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null };

export type RoomClientMessage =
  | { type: 'signal'; to: number; data: SignalData }
  /** Mesh complete on my side (every pair connected) and the game is loaded. */
  | { type: 'ready' }
  | { type: 'ping'; t0: number }
  /** My P2P connection to `slot` is dead (after the mesh timeout); the room decides the drop tick. */
  | { type: 'unreachable'; slot: number; atTick: number }
  /** Confirmed-tick hash summary for monitoring (the vote itself happens peer to peer). */
  | { type: 'hashReport'; tick: number; hash: number; agree: number; disagree: number };

// ---- Mesh (binary over DataChannels) -----------------------------------------------------------

// A const object rather than a `const enum` (same values, same `P2pMsg.Input` usage): node's
// type stripping (the test runner) rejects enums, exactly as in ../protocol.ts MsgType.
export const P2pMsg = {
  /** game channel: [0]=1, u32 firstTick, u8 count, u32 ackTick (the tick up to which the sender holds ALL inputs received from YOU: its resend floor), u32 myTick (sender's current predicted tick), then count × 6 int8 inputs, oldest first. */
  Input: 1,
  /** ctl channel: [0]=2, u32 tick, u32 hash. */
  Hash: 2,
  /** ctl: [0]=3, u32 tick — "send me your confirmed state at tick". */
  StateRequest: 3,
  /** ctl: [0]=4, u32 tick, u16 len, u32 hash, then len bytes (rs_save_state blob). */
  StateResponse: 4,
} as const;
export type P2pMsg = (typeof P2pMsg)[keyof typeof P2pMsg];

export const INPUT_HDR = 14;

// Little-endian field access by byte arithmetic: no DataView (an allocation per call) on the
// per-packet send / receive path.
function readU32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function writeU32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}
function readU16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function writeU16(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
}

export interface P2pInputPacket {
  firstTick: number;
  count: number;
  ackTick: number;
  myTick: number;
  /** count × 6 int8 (caller-provided buffer of P2P_INPUT_MAX_BATCH × 6). */
  packed: Int8Array;
}

export function encodeP2pInput(out: Uint8Array, firstTick: number, count: number, ackTick: number, myTick: number, packed: Int8Array, packedOff: number): number {
  out[0] = P2pMsg.Input;
  writeU32(out, 1, firstTick >>> 0);
  out[5] = count;
  writeU32(out, 6, ackTick >>> 0);
  writeU32(out, 10, myTick >>> 0);
  const n = count * PACKED_INPUT_BYTES;
  for (let i = 0; i < n; i++) out[INPUT_HDR + i] = packed[packedOff + i] & 0xff;
  return INPUT_HDR + n;
}

export function decodeP2pInput(buf: Uint8Array, pkt: P2pInputPacket): boolean {
  if (buf.length < INPUT_HDR || buf[0] !== P2pMsg.Input) return false;
  const count = buf[5];
  if (count < 1 || count > P2P_INPUT_MAX_BATCH || buf.length < INPUT_HDR + count * PACKED_INPUT_BYTES) return false;
  pkt.firstTick = readU32(buf, 1);
  pkt.count = count;
  pkt.ackTick = readU32(buf, 6);
  pkt.myTick = readU32(buf, 10);
  const n = count * PACKED_INPUT_BYTES;
  for (let i = 0; i < n; i++) pkt.packed[i] = (buf[INPUT_HDR + i] << 24) >> 24;
  return true;
}

export const HASH_LEN = 9;
export function encodeHash(out: Uint8Array, tick: number, hash: number): number {
  out[0] = P2pMsg.Hash;
  writeU32(out, 1, tick >>> 0);
  writeU32(out, 5, hash >>> 0);
  return HASH_LEN;
}
export function decodeHash(buf: Uint8Array, out: { tick: number; hash: number }): boolean {
  if (buf.length < HASH_LEN || buf[0] !== P2pMsg.Hash) return false;
  out.tick = readU32(buf, 1);
  out.hash = readU32(buf, 5);
  return true;
}

export const STATE_REQ_LEN = 5;
export function encodeStateRequest(out: Uint8Array, tick: number): number {
  out[0] = P2pMsg.StateRequest;
  writeU32(out, 1, tick >>> 0);
  return STATE_REQ_LEN;
}
export function decodeStateRequest(buf: Uint8Array, out: { tick: number }): boolean {
  if (buf.length < STATE_REQ_LEN || buf[0] !== P2pMsg.StateRequest) return false;
  out.tick = readU32(buf, 1);
  return true;
}

export const STATE_RESP_HDR = 11;
export function encodeStateResponse(out: Uint8Array, tick: number, hash: number, blob: Uint8Array, len: number): number {
  out[0] = P2pMsg.StateResponse;
  writeU32(out, 1, tick >>> 0);
  writeU16(out, 5, len);
  writeU32(out, 7, hash >>> 0);
  for (let i = 0; i < len; i++) out[STATE_RESP_HDR + i] = blob[i];
  return STATE_RESP_HDR + len;
}
/** Rewrite the `len` field of an encoded StateResponse (after a trailer was appended to its blob). */
export function setStateResponseLen(out: Uint8Array, len: number): void {
  writeU16(out, 5, len);
}
export interface StateResponsePacket {
  tick: number;
  len: number;
  hash: number;
  /** View into the frame (copy if kept). */
  blob: Uint8Array;
}
export function decodeStateResponse(buf: Uint8Array, out: StateResponsePacket): boolean {
  if (buf.length < STATE_RESP_HDR || buf[0] !== P2pMsg.StateResponse) return false;
  const len = readU16(buf, 5);
  if (buf.length < STATE_RESP_HDR + len) return false;
  out.tick = readU32(buf, 1);
  out.len = len;
  out.hash = readU32(buf, 7);
  out.blob = buf.subarray(STATE_RESP_HDR, STATE_RESP_HDR + len);
  return true;
}

// ---- Confirmed-timeline trailer of a StateResponse ----------------------------------------
/**
 * The blob of a StateResponse MAY end with a trailer that carries the sender's confirmed-timeline
 * objects at that tick (P2PSession checkpoint: Match, kickoff count, bot teams), so the peer that
 * resyncs realigns everything the hash does not cover. Layout, appended after the rs_save_state
 * bytes: `count` float64 little-endian, then u16 count, u16 STATE_TRAILER_MAGIC. The StateResponse
 * `len` covers both parts; `hash` is the hash of the sim part only (what the vote compared).
 * A blob without the magic is a plain sim blob (splitStateTrailer reports count 0).
 */
export const STATE_TRAILER_MAGIC = 0x5254; // 'RT'
export const STATE_TRAILER_FOOTER = 4;
/** Bytes a trailer of `count` floats takes. */
export function stateTrailerBytes(count: number): number {
  return count * 8 + STATE_TRAILER_FOOTER;
}
/** Append `count` floats of src[srcOff..] at out[off..]; returns the new end offset. */
export function encodeStateTrailer(out: Uint8Array, off: number, src: Float64Array, srcOff: number, count: number): number {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let o = off;
  for (let i = 0; i < count; i++) {
    dv.setFloat64(o, src[srcOff + i], true);
    o += 8;
  }
  writeU16(out, o, count);
  writeU16(out, o + 2, STATE_TRAILER_MAGIC);
  return o + 4;
}
export interface StateTrailerSplit {
  /** Bytes of the sim part (== len when there is no trailer). */
  simLen: number;
  /** Floats in the trailer (0 = none / malformed). */
  count: number;
}
/** Find the trailer in blob[0..len); decodes the floats into `floats` (capacity permitting). */
export function splitStateTrailer(blob: Uint8Array, len: number, floats: Float64Array, out: StateTrailerSplit): void {
  out.simLen = len;
  out.count = 0;
  if (len < STATE_TRAILER_FOOTER || readU16(blob, len - 2) !== STATE_TRAILER_MAGIC) return;
  const count = readU16(blob, len - 4);
  const bytes = stateTrailerBytes(count);
  if (bytes > len || count > floats.length) return;
  const start = len - bytes;
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let i = 0; i < count; i++) floats[i] = dv.getFloat64(start + i * 8, true);
  out.simLen = start;
  out.count = count;
}

export function p2pMsgType(buf: Uint8Array): P2pMsg {
  return buf[0] as P2pMsg;
}

// ---- Matchmaking additions (HTTP) --------------------------------------------------------------
/**
 * POST /api/queue { mode, kind: 'p2p' | 'server' } (default 'p2p' for casual). A p2p queue forms a
 * room when the mode's humans are present (2/4/6) or, after P2P_FILL_WAIT_MS with >= 2 humans, with
 * bots in the free slots; a lone human after that wait falls back to a server (Durable Object)
 * match exactly as in phase 1. The response says which kind was formed.
 */
export const P2P_FILL_WAIT_MS = 15000;

/** The body of a P2P queue request (NetClient.queue with kind 'p2p'). */
export interface QueueRequestP2p {
  mode: '1v1' | '2v2' | '3v3';
  kind: 'p2p';
  /** P2P_PROTOCOL_VERSION of the page; another value (or none, a version 1 page) -> 426 P2P_ERROR_RELOAD. */
  p2pProtocol: number;
}

/**
 * 429 { error: 'no_show', message, retryAfterMs } from POST /api/queue { kind: 'p2p' }: the player
 * took several room tickets without ever opening the room socket (each one made the others wait for
 * the no-show grace); P2P queues are refused for `retryAfterMs`, server queues still work.
 */
export const P2P_ERROR_NO_SHOW = 'no_show';

export interface QueueResultP2p {
  status: 'matched';
  kind: 'p2p';
  roomId: string;
  /** Ticket JWT with role 'peer'; sent as the subprotocol ['tg1', 'ticket.' + ticket] to wsUrl. */
  ticket: string;
  /** ws(s)://host/room/<roomId> */
  wsUrl: string;
}

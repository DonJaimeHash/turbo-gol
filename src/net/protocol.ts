/**
 * Wire protocol between the browser client and a room host (Durable Object in phase 1, dedicated
 * server later). Pure TypeScript, no DOM, no Node: shared by src/ (client) and server/ (Worker).
 *
 * Framing: every WebSocket / DataChannel message is ONE binary frame; byte 0 is the MsgType. Control
 * plane messages (welcome, events, errors) carry a JSON payload after the type byte; hot-path
 * messages (inputs, snapshots, ping/pong) are packed little-endian with DataView. All encoders
 * write into caller-provided buffers and return the byte length (no allocations per packet); the
 * decoders fill caller-provided objects.
 *
 * Ticks are the authoritative arena tick count (uint32, 120 Hz). Inputs are 6 int8 per car
 * (see types.ts packControls). A state blob is what rs_save_state produced on the host (same wasm
 * on both ends, so the client can rs_load_state it directly).
 */
import { PACKED_INPUT_BYTES } from '../sim/types';

/**
 * 2: the field changed (rounded goals): a client must predict on the same collision mesh as the
 * host, so a page cached from before is refused (NetClient checks /api/config and the Welcome).
 * 3: the bots changed (the host's bots and a client predicting them must agree).
 */
export const PROTOCOL_VERSION = 3;
export const TICK_RATE = 120;

// A const object rather than a `const enum`: node's type stripping (the test runner) rejects
// enums, and the values / usage (`MsgType.Snapshot`, the `MsgType` type) are identical.
export const MsgType = {
  // client -> host
  Input: 1, // batched inputs for consecutive ticks
  Ping: 2,
  Ready: 3, // JSON: client finished loading, ok to start the countdown
  // host -> client
  Welcome: 16, // JSON: Welcome
  Snapshot: 17, // binary: authoritative state at a tick + echoed inputs
  Pong: 18,
  Event: 19, // JSON: MatchEvent
  Error: 20, // JSON: { code, message }
  Kick: 21, // JSON: { reason }
} as const;
export type MsgType = (typeof MsgType)[keyof typeof MsgType];

/** Sent once after the WebSocket is accepted (ticket already verified by the edge Worker). */
export interface Welcome {
  protocol: number;
  matchId: string;
  mode: '1v1' | '2v2' | '3v3';
  tickRate: number;
  /** Your car id and slot (creation order) inside the arena. */
  carId: number;
  slot: number;
  /** Roster in slot order. kind 'bot' slots are driven by the host's AI. */
  roster: Array<{ carId: number; slot: number; team: 0 | 1; name: string; kind: 'player' | 'bot'; playerId?: string }>;
  /** Current host tick when this message was sent. */
  tick: number;
  /** Match length in seconds (0 = unlimited). */
  matchLengthSeconds: number;
  /** Cloudflare colo (IATA code) the host object runs in, 'unknown' when the trace failed; measurements only. */
  hostColo?: string;
}

export type MatchEvent =
  | { type: 'countdown'; n: number; tick: number }
  | { type: 'go'; tick: number }
  | { type: 'goal'; team: 0 | 1; blue: number; red: number; tick: number }
  | { type: 'kickoff'; tick: number }
  | { type: 'overtime'; tick: number }
  /** `forfeit`: a ranked match ended early because a whole team left (quit or disconnected too long). */
  | { type: 'ended'; winner: 0 | 1 | -1; blue: number; red: number; tick: number; forfeit?: boolean }
  /** A ranked match that never started (a player did not connect in time): nobody is rated, the absent players get an abandon. Followed by close 1000 'cancelled'. */
  | { type: 'cancelled'; reason: string }
  | { type: 'playerJoined'; slot: number; name: string }
  | { type: 'playerLeft'; slot: number }
  /** The slot's player quit the match for good (POST /api/leave { matchId }): the host's bot drives that car from `tick` on. */
  | { type: 'botTakeover'; slot: number; tick: number }
  | { type: 'clock'; seconds: number; tick: number };

// ---- Input (client -> host) ---------------------------------------------------------------
// [0] MsgType.Input
// [1..4] uint32 firstTick       tick of inputs[0]
// [5] uint8 count               number of consecutive ticks (1..INPUT_MAX_BATCH)
// [6..9] uint32 ackTick         newest snapshot tick the client has applied (0 = none)
// [10..] int8 × 6 × count       packed controls, oldest first
export const INPUT_MAX_BATCH = 32;
export const INPUT_HEADER = 10;

export interface InputPacket {
  firstTick: number;
  count: number;
  ackTick: number;
  /** count × 6 int8, oldest first (view into the packet or a reusable buffer). */
  packed: Int8Array;
}

export function encodeInput(out: Uint8Array, firstTick: number, count: number, ackTick: number, packed: Int8Array, packedOff: number): number {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = MsgType.Input;
  dv.setUint32(1, firstTick >>> 0, true);
  out[5] = count;
  dv.setUint32(6, ackTick >>> 0, true);
  const n = count * PACKED_INPUT_BYTES;
  for (let i = 0; i < n; i++) out[INPUT_HEADER + i] = packed[packedOff + i] & 0xff;
  return INPUT_HEADER + n;
}

/** Returns false if the packet is malformed. `pkt.packed` must have room for INPUT_MAX_BATCH × 6. */
export function decodeInput(buf: Uint8Array, pkt: InputPacket): boolean {
  if (buf.length < INPUT_HEADER || buf[0] !== MsgType.Input) return false;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = buf[5];
  if (count < 1 || count > INPUT_MAX_BATCH || buf.length < INPUT_HEADER + count * PACKED_INPUT_BYTES) return false;
  pkt.firstTick = dv.getUint32(1, true);
  pkt.count = count;
  pkt.ackTick = dv.getUint32(6, true);
  const n = count * PACKED_INPUT_BYTES;
  for (let i = 0; i < n; i++) pkt.packed[i] = (buf[INPUT_HEADER + i] << 24) >> 24;
  return true;
}

// ---- Snapshot (host -> client) --------------------------------------------------------------
// [0] MsgType.Snapshot
// [1..4] uint32 tick             state after this tick
// [5..8] uint32 lastInputTick    newest input tick of THIS client the host has applied (0 = none)
// [9] int8 bufferHint            host's input-buffer feedback: +n = client is n ticks too far ahead
//                                (slow down), -n = behind (speed up), 0 = on target
// [10] uint8 numCars
// [11..12] uint16 stateLen
// [13..] int8 × 6 × numCars      inputs the host applied at this tick, slot order
// [..] uint8 × stateLen          rs_save_state blob
// [..4] uint32 stateHash         FNV-1a of the blob (desync detection)
export const SNAPSHOT_HEADER = 13;

export interface SnapshotPacket {
  tick: number;
  lastInputTick: number;
  bufferHint: number;
  numCars: number;
  /** numCars × 6 int8 (slot order). */
  inputs: Int8Array;
  stateLen: number;
  /** View into the received frame (valid until the next message); copy if kept. */
  state: Uint8Array;
  stateHash: number;
}

export function encodeSnapshot(
  out: Uint8Array,
  tick: number,
  lastInputTick: number,
  bufferHint: number,
  numCars: number,
  inputs: Int8Array,
  state: Uint8Array,
  stateLen: number,
  stateHash: number,
): number {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = MsgType.Snapshot;
  dv.setUint32(1, tick >>> 0, true);
  dv.setUint32(5, lastInputTick >>> 0, true);
  dv.setInt8(9, Math.max(-127, Math.min(127, bufferHint)));
  out[10] = numCars;
  dv.setUint16(11, stateLen, true);
  let p = SNAPSHOT_HEADER;
  const n = numCars * PACKED_INPUT_BYTES;
  for (let i = 0; i < n; i++) out[p + i] = inputs[i] & 0xff;
  p += n;
  out.set(state.subarray(0, stateLen), p);
  p += stateLen;
  dv.setUint32(p, stateHash >>> 0, true);
  return p + 4;
}

export function decodeSnapshot(buf: Uint8Array, pkt: SnapshotPacket): boolean {
  if (buf.length < SNAPSHOT_HEADER + 4 || buf[0] !== MsgType.Snapshot) return false;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numCars = buf[10];
  const stateLen = dv.getUint16(11, true);
  const n = numCars * PACKED_INPUT_BYTES;
  if (buf.length < SNAPSHOT_HEADER + n + stateLen + 4) return false;
  pkt.tick = dv.getUint32(1, true);
  pkt.lastInputTick = dv.getUint32(5, true);
  pkt.bufferHint = dv.getInt8(9);
  pkt.numCars = numCars;
  for (let i = 0; i < n; i++) pkt.inputs[i] = (buf[SNAPSHOT_HEADER + i] << 24) >> 24;
  pkt.stateLen = stateLen;
  pkt.state = buf.subarray(SNAPSHOT_HEADER + n, SNAPSHOT_HEADER + n + stateLen);
  pkt.stateHash = dv.getUint32(SNAPSHOT_HEADER + n + stateLen, true);
  return true;
}

// ---- Ping / Pong (4-timestamp clock sync, ms as float64) -------------------------------------
// Ping: [0] type, [1..8] f64 t0 (client send time, performance.now())
// Pong: [0] type, [1..8] f64 t0, [9..16] f64 t1 (host receive), [17..24] f64 t2 (host send), [25..28] uint32 hostTick
export const PING_LEN = 9;
export const PONG_LEN = 29;

export function encodePing(out: Uint8Array, t0: number): number {
  out[0] = MsgType.Ping;
  new DataView(out.buffer, out.byteOffset, out.byteLength).setFloat64(1, t0, true);
  return PING_LEN;
}

export function decodePing(buf: Uint8Array): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat64(1, true);
}

export function encodePong(out: Uint8Array, t0: number, t1: number, t2: number, hostTick: number): number {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = MsgType.Pong;
  dv.setFloat64(1, t0, true);
  dv.setFloat64(9, t1, true);
  dv.setFloat64(17, t2, true);
  dv.setUint32(25, hostTick >>> 0, true);
  return PONG_LEN;
}

export interface PongPacket {
  t0: number;
  t1: number;
  t2: number;
  hostTick: number;
}

export function decodePong(buf: Uint8Array, pkt: PongPacket): boolean {
  if (buf.length < PONG_LEN || buf[0] !== MsgType.Pong) return false;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  pkt.t0 = dv.getFloat64(1, true);
  pkt.t1 = dv.getFloat64(9, true);
  pkt.t2 = dv.getFloat64(17, true);
  pkt.hostTick = dv.getUint32(25, true);
  return true;
}

// ---- JSON control messages -----------------------------------------------------------------
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeJson(type: MsgType, payload: unknown): Uint8Array {
  const body = textEncoder.encode(JSON.stringify(payload));
  const out = new Uint8Array(1 + body.length);
  out[0] = type;
  out.set(body, 1);
  return out;
}

export function decodeJson<T>(buf: Uint8Array): T {
  return JSON.parse(textDecoder.decode(buf.subarray(1))) as T;
}

export function msgType(buf: Uint8Array): MsgType {
  return buf[0] as MsgType;
}

/** FNV-1a 32-bit over a byte range (same function the wasm uses for rs_state_hash). */
export function fnv1a32(bytes: Uint8Array, len: number = bytes.length): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < len; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---- HTTP control plane (Worker) --------------------------------------------------------------
/** POST /api/guest { name?, turnstileToken? } -> GuestSession */
export interface GuestSession {
  playerId: string;
  name: string;
  /** Bearer token for /api/* (HS256 JWT, 24 h). */
  session: string;
  expiresAt: number;
}

/** POST /api/queue { mode, region? } with Authorization: Bearer <session> -> QueueResult (long-poll up to ~25 s). */
export interface QueueResult {
  status: 'matched' | 'waiting';
  matchId?: string;
  /** Match ticket (HS256 JWT, 90 s): { sub, mid, team, slot, role: 'player', jti }. Sent as the WebSocket subprotocol: ['tg1', 'ticket.' + ticket]. */
  ticket?: string;
  wsUrl?: string;
  /** Players currently waiting in this queue (for the UI). */
  waiting?: number;
  /** A ranked match (kind 'ranked'): rated when it ends, GET /api/ranked/result?matchId= has the change. */
  ranked?: boolean;
}

export const WS_SUBPROTOCOL = 'tg1';
export const WS_TICKET_PREFIX = 'ticket.';

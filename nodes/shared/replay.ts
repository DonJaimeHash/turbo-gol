/**
 * Match replay: the trust anchor of community hosting.
 *
 * The simulation is deterministic (same rocketsim.wasm, fixed 120 Hz, seeded kickoffs, bots and
 * match rules without clocks or Math.random), so a match is fully described by its setup plus the
 * controls the host APPLIED to every human car at every tick. Bots are not recorded: the verifier
 * runs the same BotTeam code and must reproduce them, which also proves the host did not steer a
 * bot. A node therefore cannot invent a goal, move the ball or change a score without the
 * re-simulation noticing at the next state-hash checkpoint.
 *
 * Binary layout (little-endian):
 *   "TGR1"                        magic
 *   u32 headerLen, header JSON    ReplayHeader (UTF-8)
 *   records, in tick order:
 *     1 INPUT     u32 tick, u8 slot, i8 x 6   applied controls of a human slot CHANGED at `tick`
 *                                             (every human slot is written on tick 1)
 *     2 TAKEOVER  u32 tick, u8 slot           the slot is a bot from `tick` on (an explicit leave)
 *     3 HASH      u32 tick, u32 hash          rs_state_hash after `tick` (every checkpointEvery ticks)
 *     4 END       u32 tick, i8 winner, u16 blue, u16 red, u8 reason, i8 forfeitTeam   (last record)
 *
 * Size: a human changes controls a few times per second, so a 5-minute 1v1 is ~20-60 KB raw and
 * compresses well. The applied controls are the post-freeze values (zeros during countdowns and
 * goal pauses), exactly what RoomHost.appliedInputs exposes after each tick.
 */
import { PACKED_INPUT_BYTES } from '../../src/sim/types';
import type { BuildId, Difficulty, EndReason, GameMode, RosterEntry } from './controlProtocol';

export const REPLAY_VERSION = 1;
export const CHECKPOINT_EVERY = 120;
export const REPLAY_MAX_BYTES = 16 * 1024 * 1024;

const MAGIC = [0x54, 0x47, 0x52, 0x31]; // "TGR1"
export const REC_INPUT = 1;
export const REC_TAKEOVER = 2;
export const REC_HASH = 3;
export const REC_END = 4;
const END_REASONS: readonly EndReason[] = ['rules', 'forfeit', 'ttl', 'left', 'empty'];

export interface ReplayHeader {
  v: 1;
  matchId: string;
  nodeId: string;
  build: BuildId;
  mode: GameMode;
  region: string;
  ranked: boolean;
  roster: RosterEntry[];
  matchLengthSeconds: number;
  kickoffSeed: number;
  botDifficulty: Difficulty;
  kickoffCountdownSeconds?: number;
  goalPauseSeconds?: number;
  tickRate: number;
  checkpointEvery: number;
  /** Wall clock of the first tick (ms). Informational only. */
  startedAt: number;
}

export interface ReplayEnd {
  tick: number;
  winner: 0 | 1 | -1;
  blue: number;
  red: number;
  reason: EndReason;
  forfeitTeam: 0 | 1 | -1;
}

export interface Replay {
  header: ReplayHeader;
  inputCount: number;
  inputTicks: Uint32Array;
  inputSlots: Uint8Array;
  /** inputCount x 6 int8. */
  inputData: Int8Array;
  takeovers: Array<{ tick: number; slot: number }>;
  hashCount: number;
  hashTicks: Uint32Array;
  hashValues: Uint32Array;
  end: ReplayEnd | null;
}

export class ReplayError extends Error {}

// ---- writing ------------------------------------------------------------------------------

class ByteWriter {
  private buf = new Uint8Array(4096);
  private dv = new DataView(this.buf.buffer);
  len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.dv = new DataView(next.buffer);
  }
  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }
  i8(v: number): void {
    this.ensure(1);
    this.dv.setInt8(this.len++, v);
  }
  u16(v: number): void {
    this.ensure(2);
    this.dv.setUint16(this.len, v, true);
    this.len += 2;
  }
  u32(v: number): void {
    this.ensure(4);
    this.dv.setUint32(this.len, v >>> 0, true);
    this.len += 4;
  }
  bytes(src: Uint8Array): void {
    this.ensure(src.length);
    this.buf.set(src, this.len);
    this.len += src.length;
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Low-level writer: header first, then records in tick order. */
export class ReplayWriter {
  readonly header: ReplayHeader;
  private readonly w = new ByteWriter();
  private ended = false;

  constructor(header: ReplayHeader) {
    this.header = header;
    for (const b of MAGIC) this.w.u8(b);
    const json = new TextEncoder().encode(JSON.stringify(header));
    this.w.u32(json.length);
    this.w.bytes(json);
  }

  input(tick: number, slot: number, packed: Int8Array, off: number): void {
    this.w.u8(REC_INPUT);
    this.w.u32(tick);
    this.w.u8(slot);
    for (let k = 0; k < PACKED_INPUT_BYTES; k++) this.w.i8(packed[off + k]);
  }

  takeover(tick: number, slot: number): void {
    this.w.u8(REC_TAKEOVER);
    this.w.u32(tick);
    this.w.u8(slot);
  }

  hash(tick: number, h: number): void {
    this.w.u8(REC_HASH);
    this.w.u32(tick);
    this.w.u32(h);
  }

  end(e: ReplayEnd): void {
    if (this.ended) return;
    this.ended = true;
    this.w.u8(REC_END);
    this.w.u32(e.tick);
    this.w.i8(e.winner);
    this.w.u16(e.blue);
    this.w.u16(e.red);
    this.w.u8(END_REASONS.indexOf(e.reason));
    this.w.i8(e.forfeitTeam);
  }

  get byteLength(): number {
    return this.w.len;
  }

  finish(): Uint8Array {
    return this.w.finish();
  }
}

/** What the recorder reads from the host after each tick (RoomHost satisfies it). */
export interface RecordableHost {
  readonly currentTick: number;
  readonly numCars: number;
  readonly appliedInputs: Int8Array;
  isHumanSlot(slot: number): boolean;
}

export interface HashableSim {
  stateHash(): number;
}

/**
 * Records a running RoomHost: call afterTick() right after every host.tick(), takeover() when a
 * slot is handed to the bots (RoomHost.convertToBot, tick = currentTick + 1) and end() once.
 * Allocation-free per tick (the writer grows by doubling).
 */
export class ReplayRecorder {
  private readonly writer: ReplayWriter;
  private readonly last: Int8Array;
  private readonly seen: Uint8Array;
  private readonly every: number;

  constructor(header: ReplayHeader) {
    this.writer = new ReplayWriter(header);
    this.last = new Int8Array(header.roster.length * PACKED_INPUT_BYTES);
    this.seen = new Uint8Array(header.roster.length);
    this.every = Math.max(1, header.checkpointEvery);
  }

  afterTick(host: RecordableHost, sim: HashableSim): void {
    const T = host.currentTick;
    const a = host.appliedInputs;
    const n = host.numCars;
    for (let slot = 0; slot < n; slot++) {
      if (!host.isHumanSlot(slot)) continue;
      const base = slot * PACKED_INPUT_BYTES;
      let changed = this.seen[slot] === 0;
      if (!changed) {
        for (let k = 0; k < PACKED_INPUT_BYTES; k++) {
          if (a[base + k] !== this.last[base + k]) {
            changed = true;
            break;
          }
        }
      }
      if (changed) {
        this.writer.input(T, slot, a, base);
        for (let k = 0; k < PACKED_INPUT_BYTES; k++) this.last[base + k] = a[base + k];
        this.seen[slot] = 1;
      }
    }
    if (T % this.every === 0) this.writer.hash(T, sim.stateHash());
  }

  takeover(tick: number, slot: number): void {
    this.writer.takeover(tick, slot);
  }

  end(e: ReplayEnd): void {
    this.writer.end(e);
  }

  get byteLength(): number {
    return this.writer.byteLength;
  }

  finish(): Uint8Array {
    return this.writer.finish();
  }
}

// ---- reading ------------------------------------------------------------------------------

function fail(msg: string): never {
  throw new ReplayError(msg);
}

function checkHeader(h: unknown): ReplayHeader {
  if (!h || typeof h !== 'object') fail('header is not an object');
  const x = h as Partial<ReplayHeader>;
  if (x.v !== 1) fail('unsupported replay version');
  if (typeof x.matchId !== 'string' || typeof x.nodeId !== 'string') fail('header ids');
  const b = x.build;
  if (!b || typeof b.version !== 'string' || typeof b.protocol !== 'number' || typeof b.wasmSha256 !== 'string') fail('header build');
  if (x.mode !== '1v1' && x.mode !== '2v2' && x.mode !== '3v3') fail('header mode');
  if (typeof x.region !== 'string' || typeof x.ranked !== 'boolean') fail('header region / ranked');
  if (!Array.isArray(x.roster) || x.roster.length < 1 || x.roster.length > 8) fail('header roster');
  x.roster.forEach((e, i) => {
    if (!e || e.slot !== i || (e.team !== 0 && e.team !== 1) || (e.kind !== 'player' && e.kind !== 'bot') || typeof e.name !== 'string') fail(`roster[${i}]`);
    if (e.kind === 'player' && typeof e.playerId !== 'string') fail(`roster[${i}].playerId`);
  });
  if (typeof x.matchLengthSeconds !== 'number' || !(x.matchLengthSeconds >= 0)) fail('header matchLengthSeconds');
  if (!Number.isInteger(x.kickoffSeed)) fail('header kickoffSeed');
  if (x.botDifficulty !== 'easy' && x.botDifficulty !== 'medium' && x.botDifficulty !== 'hard') fail('header botDifficulty');
  if (x.tickRate !== 120) fail('header tickRate');
  if (!Number.isInteger(x.checkpointEvery) || (x.checkpointEvery as number) < 1) fail('header checkpointEvery');
  for (const k of ['kickoffCountdownSeconds', 'goalPauseSeconds'] as const) {
    if (x[k] !== undefined && !(typeof x[k] === 'number' && (x[k] as number) >= 0 && (x[k] as number) <= 30)) fail('header ' + k);
  }
  return x as ReplayHeader;
}

/** Parse and validate a replay. Throws ReplayError on anything malformed or out of order. */
export function decodeReplay(bytes: Uint8Array): Replay {
  if (bytes.length > REPLAY_MAX_BYTES) fail('replay too large');
  if (bytes.length < 8) fail('replay too short');
  for (let i = 0; i < 4; i++) if (bytes[i] !== MAGIC[i]) fail('bad magic');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hlen = dv.getUint32(4, true);
  if (hlen > 64 * 1024 || 8 + hlen > bytes.length) fail('bad header length');
  let header: ReplayHeader;
  try {
    header = checkHeader(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(8, 8 + hlen))));
  } catch (e) {
    if (e instanceof ReplayError) throw e;
    fail('header is not JSON');
  }
  const slots = header.roster.length;

  // First pass: count, so the typed arrays are sized exactly.
  let p = 8 + hlen;
  let nIn = 0;
  let nHash = 0;
  while (p < bytes.length) {
    const t = bytes[p];
    const size = t === REC_INPUT ? 12 : t === REC_TAKEOVER ? 6 : t === REC_HASH ? 9 : t === REC_END ? 12 : -1;
    if (size < 0) fail(`unknown record type ${t} at ${p}`);
    if (p + size > bytes.length) fail('truncated record');
    if (t === REC_INPUT) nIn++;
    else if (t === REC_HASH) nHash++;
    p += size;
  }

  const r: Replay = {
    header,
    inputCount: nIn,
    inputTicks: new Uint32Array(nIn),
    inputSlots: new Uint8Array(nIn),
    inputData: new Int8Array(nIn * PACKED_INPUT_BYTES),
    takeovers: [],
    hashCount: nHash,
    hashTicks: new Uint32Array(nHash),
    hashValues: new Uint32Array(nHash),
    end: null,
  };
  p = 8 + hlen;
  let i = 0;
  let h = 0;
  let lastInputTick = 0;
  let lastTakeoverTick = 0;
  let lastHashTick = 0;
  const takenOver = new Uint8Array(slots);
  while (p < bytes.length) {
    if (r.end) fail('record after END');
    const t = bytes[p];
    const tick = dv.getUint32(p + 1, true);
    if (tick < 1) fail('tick 0 record');
    if (t === REC_INPUT) {
      const slot = bytes[p + 5];
      if (slot >= slots || header.roster[slot].kind !== 'player') fail(`input for non-human slot ${slot}`);
      if (tick < lastInputTick) fail('input records out of order');
      if (takenOver[slot] === 1) fail(`input for slot ${slot} after its takeover`);
      lastInputTick = tick;
      r.inputTicks[i] = tick;
      r.inputSlots[i] = slot;
      for (let k = 0; k < PACKED_INPUT_BYTES; k++) r.inputData[i * PACKED_INPUT_BYTES + k] = dv.getInt8(p + 6 + k);
      i++;
      p += 12;
    } else if (t === REC_TAKEOVER) {
      const slot = bytes[p + 5];
      if (slot >= slots || header.roster[slot].kind !== 'player' || takenOver[slot] === 1) fail(`bad takeover of slot ${slot}`);
      if (tick < lastTakeoverTick) fail('takeovers out of order');
      lastTakeoverTick = tick;
      takenOver[slot] = 1;
      r.takeovers.push({ tick, slot });
      p += 6;
    } else if (t === REC_HASH) {
      if (tick <= lastHashTick && h > 0) fail('hash records out of order');
      lastHashTick = tick;
      r.hashTicks[h] = tick;
      r.hashValues[h] = dv.getUint32(p + 5, true);
      h++;
      p += 9;
    } else {
      const winner = dv.getInt8(p + 5);
      const reason = END_REASONS[bytes[p + 10]];
      const forfeitTeam = dv.getInt8(p + 11);
      if (winner !== 0 && winner !== 1 && winner !== -1) fail('bad winner');
      if (!reason) fail('bad end reason');
      if (forfeitTeam !== 0 && forfeitTeam !== 1 && forfeitTeam !== -1) fail('bad forfeit team');
      r.end = { tick, winner, blue: dv.getUint16(p + 6, true), red: dv.getUint16(p + 8, true), reason, forfeitTeam };
      p += 12;
    }
  }
  const end = r.end;
  if (end) {
    if (lastInputTick > end.tick || lastTakeoverTick > end.tick + 1 || lastHashTick > end.tick) fail('records after the END tick');
  }
  return r;
}

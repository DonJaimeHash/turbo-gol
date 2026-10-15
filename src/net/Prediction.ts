/**
 * Client-side prediction with rollback (phase 1 online, see docs/online/PHASE1.md).
 *
 * The local sim runs `lead` ticks ahead of the host with the player's own inputs and the last
 * known input of every remote slot (held). When a snapshot arrives the authoritative state is
 * loaded (rs_load_state), the remote holds are refreshed from the echoed inputs, and the local
 * ticks after the snapshot are replayed from the input ring: snapshot.tick + 1 .. localTick.
 *
 * Visual smoothing: the positions of the player's car and the ball predicted for localTick are
 * recorded before the load; after the replay the difference (old prediction - corrected state) is
 * added to `errorOffsetCar` / `errorOffsetBall` so the views can keep showing where things were
 * and glide to the corrected place: the offsets decay by ERR_DECAY per tick (ERR_DECAY_FAR when
 * at least ERR_FAR uu long) and snap to zero beyond ERR_SNAP uu (kickoff resets, demolitions).
 *
 * The predictor only needs the subset of the bridge in `RollbackSim` (RocketSimBridge.ts once
 * the save / load exports land; tests use a tiny deterministic stand-in). Allocation-free after
 * construction: the frame of packed controls, the ring and the offsets are preallocated.
 */
import { BALL_OFFSET, B_POS, C_POS, MAX_CARS, MAX_STATE_BYTES, PACKED_INPUT_BYTES } from '../sim/types';
import { InputRing } from './InputRing';
import type { SnapshotPacket } from './protocol';

/** What the predictor needs from the sim (structurally satisfied by RocketSimBridge.RocketSim). */
export interface RollbackSim {
  readonly buf: Float32Array;
  readonly tickCount: number;
  readonly numCars: number;
  carOffset(slot: number): number;
  /** Serialise the full dynamic state into `out`; returns the byte length (-1 / throw on error). */
  saveState(out: Uint8Array): number;
  /** Restore a blob produced by saveState on the same roster. May return a non-zero code or throw on error. */
  loadState(blob: Uint8Array, len?: number): number | void;
  /** FNV-1a 32 of the bytes saveState would produce now. */
  stateHash(): number;
  stateSizeMax(): number;
  /** Controls for every car from one packed array (6 int8 per slot, slot order). */
  setControlsPacked(packed: Int8Array, numSlots: number): void;
  step(n?: number): void;
  /** Refresh `buf` (and fire the bridge's events). */
  sync(): void;
}

export const ERR_DECAY = 0.95;
export const ERR_DECAY_FAR = 0.85;
/** Offsets at least this long (uu) decay with ERR_DECAY_FAR. */
export const ERR_FAR = 100;
/** Offsets longer than this (uu) snap to zero. */
export const ERR_SNAP = 200;
/** Longest replay (ticks); older snapshots hard-resync the local tick to the snapshot instead. */
export const MAX_REPLAY = 255;

export class RollbackPredictor {
  readonly sim: RollbackSim;
  readonly mySlot: number;
  readonly numCars: number;
  /** The player's inputs by tick (also what the input sender resends from). */
  readonly inputs = new InputRing();
  /** Last known packed input of every slot (slot order); the player's slot is refreshed per tick. */
  readonly hold: Int8Array;
  /** Visual error offsets (uu, x y z) for the player's car and the ball; see the header. */
  readonly errorOffsetCar = new Float32Array(3);
  readonly errorOffsetBall = new Float32Array(3);

  /** Tick of the state currently in the sim (after the last step / replay). */
  localTick = 0;
  /** Newest snapshot tick applied (0 = none): the ackTick of the input packets. */
  lastSnapshotTick = 0;
  /** True once a snapshot has been loaded (before that the sim holds no authoritative state). */
  synced = false;

  // Counters (the HUD shows rates; never reset while a match runs).
  rollbacks = 0;
  replayedTicks = 0;
  desyncs = 0;
  /** Snapshots that could not be replayed (host ahead of us or older than the ring): localTick was reset. */
  resyncs = 0;
  /** loadState rejected a blob (roster / format mismatch). */
  loadErrors = 0;
  /** Misprediction magnitude (uu) of the player's car / ball at the last rollback, and the worst seen. */
  lastErrorCar = 0;
  lastErrorBall = 0;
  maxErrorCar = 0;
  /** Snapshots whose hash differed from our own prediction for that tick (only while trackHashes). */
  mispredictions = 0;
  /** Dev: hash every local tick and compare with the snapshot of the same tick (costs a save per tick). */
  trackHashes = false;

  private readonly frame: Int8Array;
  private readonly hashes = new Uint32Array(256);
  private readonly hashTicks = new Int32Array(256).fill(-1);
  private readonly predCar = new Float32Array(3);
  private readonly predBall = new Float32Array(3);

  constructor(sim: RollbackSim, mySlot: number, numCars: number) {
    if (numCars < 1 || numCars > MAX_CARS) throw new Error(`RollbackPredictor: numCars ${numCars} out of range`);
    if (mySlot < 0 || mySlot >= numCars) throw new Error(`RollbackPredictor: slot ${mySlot} out of range`);
    if (sim.stateSizeMax() > MAX_STATE_BYTES) throw new Error('RollbackPredictor: state blob larger than MAX_STATE_BYTES');
    this.sim = sim;
    this.mySlot = mySlot;
    this.numCars = numCars;
    this.hold = new Int8Array(numCars * PACKED_INPUT_BYTES);
    this.frame = new Int8Array(numCars * PACKED_INPUT_BYTES);
    this.localTick = sim.tickCount;
  }

  /** Overwrite the held input of a remote slot (6 bytes at src[off..]). */
  setHold(slot: number, src: Int8Array, off: number): void {
    const base = slot * PACKED_INPUT_BYTES;
    for (let i = 0; i < PACKED_INPUT_BYTES; i++) this.hold[base + i] = src[off + i];
  }

  /**
   * Produce local tick `tick` (= localTick + 1): store the player's packed input (6 bytes at
   * src[off..]) for that tick, apply it with the remote holds and step once. The caller syncs.
   */
  stepLocal(tick: number, src: Int8Array, off: number): void {
    this.inputs.set(tick, src, off);
    this.setHold(this.mySlot, src, off);
    this.sim.setControlsPacked(this.hold, this.numCars);
    this.sim.step(1);
    this.localTick = tick;
    if (this.trackHashes) this.recordHash(tick);
  }

  /**
   * Load an authoritative snapshot and replay the local ticks after it. Call between frames (or
   * between ticks); afterwards the sim holds localTick again (or the snapshot tick when the replay
   * was impossible: host ahead, or more than MAX_REPLAY ticks behind) and `buf` is synced.
   */
  applySnapshot(pkt: SnapshotPacket): void {
    const sim = this.sim;
    const buf = sim.buf;
    const myOff = sim.carOffset(this.mySlot) + C_POS;
    const pc = this.predCar;
    const pb = this.predBall;
    const hadState = this.synced;
    pc[0] = buf[myOff];
    pc[1] = buf[myOff + 1];
    pc[2] = buf[myOff + 2];
    pb[0] = buf[BALL_OFFSET + B_POS];
    pb[1] = buf[BALL_OFFSET + B_POS + 1];
    pb[2] = buf[BALL_OFFSET + B_POS + 2];

    let ok = true;
    try {
      const rc = sim.loadState(pkt.state, pkt.stateLen);
      if (typeof rc === 'number' && rc !== 0) ok = false;
    } catch {
      ok = false;
    }
    if (!ok) {
      this.loadErrors++;
      return;
    }
    if (sim.stateHash() !== pkt.stateHash) this.desyncs++;
    if (this.trackHashes) {
      const s = pkt.tick & 255;
      if (this.hashTicks[s] === pkt.tick && this.hashes[s] !== pkt.stateHash) this.mispredictions++;
    }

    // Remote holds from the echoed inputs; the player's slot keeps its own newest input.
    const n = this.numCars * PACKED_INPUT_BYTES;
    const myBase = this.mySlot * PACKED_INPUT_BYTES;
    const hold = this.hold;
    for (let i = 0; i < n; i++) {
      if (i >= myBase && i < myBase + PACKED_INPUT_BYTES) continue;
      hold[i] = pkt.inputs[i];
    }

    const target = this.localTick;
    let count = hadState ? target - pkt.tick : 0;
    if (count < 0 || count > MAX_REPLAY) {
      this.resyncs++;
      count = 0;
    }
    if (count > 0) {
      const frame = this.frame;
      frame.set(hold);
      // The player's input at the snapshot tick, as the host applied it, is the hold until the ring
      // provides a newer one (ticks missing from the ring keep the previous frame's value).
      for (let i = 0; i < PACKED_INPUT_BYTES; i++) frame[myBase + i] = pkt.inputs[myBase + i];
      for (let t = pkt.tick + 1; t <= target; t++) {
        this.inputs.copyTo(t, frame, myBase);
        sim.setControlsPacked(frame, this.numCars);
        sim.step(1);
        if (this.trackHashes) this.recordHash(t);
      }
      this.rollbacks++;
      this.replayedTicks += count;
      this.localTick = target;
    } else {
      this.localTick = pkt.tick;
    }
    this.lastSnapshotTick = pkt.tick;
    this.synced = true;
    sim.sync();

    if (count > 0) {
      const nb = sim.buf;
      const ec = this.errorOffsetCar;
      const eb = this.errorOffsetBall;
      const dcx = pc[0] - nb[myOff];
      const dcy = pc[1] - nb[myOff + 1];
      const dcz = pc[2] - nb[myOff + 2];
      const dbx = pb[0] - nb[BALL_OFFSET + B_POS];
      const dby = pb[1] - nb[BALL_OFFSET + B_POS + 1];
      const dbz = pb[2] - nb[BALL_OFFSET + B_POS + 2];
      this.lastErrorCar = Math.sqrt(dcx * dcx + dcy * dcy + dcz * dcz);
      this.lastErrorBall = Math.sqrt(dbx * dbx + dby * dby + dbz * dbz);
      if (this.lastErrorCar > this.maxErrorCar) this.maxErrorCar = this.lastErrorCar;
      ec[0] += dcx;
      ec[1] += dcy;
      ec[2] += dcz;
      eb[0] += dbx;
      eb[1] += dby;
      eb[2] += dbz;
      snapIfFar(ec);
      snapIfFar(eb);
    } else {
      this.errorOffsetCar.fill(0);
      this.errorOffsetBall.fill(0);
    }
  }

  /** Per local tick: shrink the visual error offsets. */
  decayOffsets(): void {
    decay(this.errorOffsetCar);
    decay(this.errorOffsetBall);
  }

  /** Forget everything (new match / reconnect); counters are kept. */
  reset(): void {
    this.inputs.clear();
    this.hold.fill(0);
    this.errorOffsetCar.fill(0);
    this.errorOffsetBall.fill(0);
    this.hashTicks.fill(-1);
    this.synced = false;
    this.lastSnapshotTick = 0;
    this.localTick = this.sim.tickCount;
  }

  private recordHash(tick: number): void {
    const s = tick & 255;
    this.hashes[s] = this.sim.stateHash();
    this.hashTicks[s] = tick;
  }
}

function snapIfFar(v: Float32Array): void {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len > ERR_SNAP) v.fill(0);
}

function decay(v: Float32Array): void {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len === 0) return;
  if (len > ERR_SNAP) {
    v.fill(0);
    return;
  }
  const k = len >= ERR_FAR ? ERR_DECAY_FAR : ERR_DECAY;
  v[0] *= k;
  v[1] *= k;
  v[2] *= k;
  if (len * k < 0.05) v.fill(0);
}

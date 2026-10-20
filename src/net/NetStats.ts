/**
 * Network statistics for the HUD panel: a loss estimate from snapshot tick gaps, per-second rate
 * meters over monotonically growing counters, and the plain view object the Hud formats. Pure
 * TypeScript (node tests), no allocations after construction.
 */

/** Snapshots remembered for the loss window. */
const LOSS_WINDOW = 128;

/**
 * Loss estimate from the gaps between consecutive snapshot ticks. The host sends a snapshot every
 * `interval` ticks (learned as the smallest positive gap seen, 4 at 30 Hz); a gap of k intervals
 * means k - 1 snapshots did not arrive (or were dropped by the host under back-pressure). The ratio
 * is kept over the last LOSS_WINDOW snapshots.
 */
export class LossEstimator {
  /** Snapshot cadence in ticks (learned; 0 until two snapshots arrived). */
  interval = 0;
  /** Snapshots received / missed in the window. */
  received = 0;
  missed = 0;
  lastTick = -1;

  private readonly missedRing = new Uint8Array(LOSS_WINDOW);
  private head = 0;
  private filled = 0;

  onSnapshotTick(tick: number): void {
    const last = this.lastTick;
    this.lastTick = tick;
    if (last < 0 || tick <= last) {
      this.push(0);
      return;
    }
    const gap = tick - last;
    if (this.interval === 0 || gap < this.interval) this.interval = gap;
    const k = Math.round(gap / this.interval) - 1;
    this.push(k > 0 ? (k > 255 ? 255 : k) : 0);
  }

  /** Fraction of snapshots lost in the window (0..1). */
  get loss(): number {
    const total = this.received + this.missed;
    return total === 0 ? 0 : this.missed / total;
  }

  reset(): void {
    this.interval = 0;
    this.received = 0;
    this.missed = 0;
    this.lastTick = -1;
    this.head = 0;
    this.filled = 0;
    this.missedRing.fill(0);
  }

  private push(missed: number): void {
    const ring = this.missedRing;
    if (this.filled === LOSS_WINDOW) {
      this.missed -= ring[this.head];
      this.received--;
    } else {
      this.filled++;
    }
    ring[this.head] = missed;
    this.head = (this.head + 1) % LOSS_WINDOW;
    this.missed += missed;
    this.received++;
  }
}

/** Per-second rate of a growing counter, sampled whenever at least `minIntervalMs` passed. */
export class RateMeter {
  rate = 0;
  private lastValue = 0;
  private lastTime = -1;
  private readonly minIntervalMs: number;

  constructor(minIntervalMs = 250) {
    this.minIntervalMs = minIntervalMs;
  }

  /** Feed the current counter value; returns the rate per second (updated at most every minIntervalMs). */
  sample(nowMs: number, value: number): number {
    if (this.lastTime < 0) {
      this.lastTime = nowMs;
      this.lastValue = value;
      return this.rate;
    }
    const dt = nowMs - this.lastTime;
    if (dt < this.minIntervalMs) return this.rate;
    this.rate = ((value - this.lastValue) * 1000) / dt;
    this.lastTime = nowMs;
    this.lastValue = value;
    return this.rate;
  }

  reset(): void {
    this.rate = 0;
    this.lastTime = -1;
    this.lastValue = 0;
  }
}

/** Most peers a P2P room can have besides us (MAX_CARS - 1, rounded to a fixed 8 rows). */
export const NET_STATS_MAX_PEERS = 8;

/** Selected ICE candidate pair type of a peer link (NetStatsView.p2pPeerCand). */
export const PEER_CAND_NONE = 0;
export const PEER_CAND_HOST = 1;
export const PEER_CAND_SRFLX = 2;
export const PEER_CAND_RELAY = 3;
export const PEER_CAND_LABELS: readonly string[] = ['—', 'host', 'srflx', 'relay'];

/** Link state of a peer (NetStatsView.p2pPeerState). */
export const PEER_STATE_CONNECTING = 0;
export const PEER_STATE_CONNECTED = 1;
export const PEER_STATE_FAILED = 2;
export const PEER_STATE_DROPPED = 3;
export const PEER_STATE_LABELS: readonly string[] = ['connecting', 'connected', 'failed', 'dropped'];

/**
 * What the HUD network panel shows. One object per session, refilled in place a few times per
 * second. The phase 1 (server) fields come first; the `p2p*` block (phase 2 mesh) holds one row per
 * peer in fixed-size arrays (NET_STATS_MAX_PEERS), so refilling it never allocates.
 */
export interface NetStatsView {
  state: string;
  /** Which session fills the view: 'server' (phase 1 Durable Object host) or 'p2p' (mesh); 'none' when idle. */
  kind: 'none' | 'server' | 'p2p';
  rttMs: number;
  jitterMs: number;
  /** 0..100 */
  lossPct: number;
  lead: number;
  leadAdjust: number;
  hostTick: number;
  localTick: number;
  /** Local sim speed relative to real time (0.95..1.05). */
  rateScale: number;
  rollbacksPerSec: number;
  replayedPerSec: number;
  desyncs: number;
  resyncs: number;
  mispredictions: number;
  /** Last misprediction magnitude of the player's car (uu). */
  errorCar: number;
  bufferHint: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  /** -1 until the first snapshot. */
  snapshotAgeMs: number;
  reconnects: number;
  /** Welcome.hostColo of the server match ('' before it): the panel names the host only when it is a community node. */
  host: string;

  // ---- P2P mesh (phase 2) ----
  /** Rows in use of the p2pPeer* arrays. */
  p2pPeers: number;
  p2pPeerSlot: Int32Array;
  /** Display names (one string per roster slot, set once when the roster is built). */
  p2pPeerName: string[];
  /** currentRoundTripTime of the selected candidate pair (ms); 0 until getStats reports one. */
  p2pPeerRtt: Float32Array;
  /** PEER_CAND_* */
  p2pPeerCand: Uint8Array;
  /** PEER_STATE_* */
  p2pPeerState: Uint8Array;
  /** Newest input tick received from the peer. */
  p2pPeerTick: Int32Array;
  /** Rollback engine: last confirmed tick, predicted ticks ahead of it, stalls (frames waiting for inputs), timesync skips. */
  confirmedTick: number;
  predictedAhead: number;
  stalls: number;
  timesyncSkips: number;
  /** Fixed input delay (ticks) applied to the local inputs. */
  inputDelay: number;
}

/**
 * Put a view back to its idle values in place (no allocation): the HUD keeps showing the same
 * object after a match, so a stale ping / rollback rate would otherwise survive into offline play.
 */
export function resetNetStatsView(s: NetStatsView): void {
  s.state = 'idle';
  s.kind = 'none';
  s.rttMs = 0;
  s.jitterMs = 0;
  s.lossPct = 0;
  s.lead = 0;
  s.leadAdjust = 0;
  s.hostTick = 0;
  s.localTick = 0;
  s.rateScale = 1;
  s.rollbacksPerSec = 0;
  s.replayedPerSec = 0;
  s.desyncs = 0;
  s.resyncs = 0;
  s.mispredictions = 0;
  s.errorCar = 0;
  s.bufferHint = 0;
  s.bytesInPerSec = 0;
  s.bytesOutPerSec = 0;
  s.snapshotAgeMs = -1;
  s.reconnects = 0;
  s.host = '';
  s.p2pPeers = 0;
  s.p2pPeerSlot.fill(-1);
  for (let i = 0; i < NET_STATS_MAX_PEERS; i++) s.p2pPeerName[i] = '';
  s.p2pPeerRtt.fill(0);
  s.p2pPeerCand.fill(PEER_CAND_NONE);
  s.p2pPeerState.fill(PEER_STATE_CONNECTING);
  s.p2pPeerTick.fill(0);
  s.confirmedTick = 0;
  s.predictedAhead = 0;
  s.stalls = 0;
  s.timesyncSkips = 0;
  s.inputDelay = 0;
}

export function newNetStatsView(): NetStatsView {
  const names: string[] = [];
  for (let i = 0; i < NET_STATS_MAX_PEERS; i++) names.push('');
  return {
    state: 'idle',
    kind: 'none',
    rttMs: 0,
    jitterMs: 0,
    lossPct: 0,
    lead: 0,
    leadAdjust: 0,
    hostTick: 0,
    localTick: 0,
    rateScale: 1,
    rollbacksPerSec: 0,
    replayedPerSec: 0,
    desyncs: 0,
    resyncs: 0,
    mispredictions: 0,
    errorCar: 0,
    bufferHint: 0,
    bytesInPerSec: 0,
    bytesOutPerSec: 0,
    snapshotAgeMs: -1,
    reconnects: 0,
    host: '',
    p2pPeers: 0,
    p2pPeerSlot: new Int32Array(NET_STATS_MAX_PEERS).fill(-1),
    p2pPeerName: names,
    p2pPeerRtt: new Float32Array(NET_STATS_MAX_PEERS),
    p2pPeerCand: new Uint8Array(NET_STATS_MAX_PEERS),
    p2pPeerState: new Uint8Array(NET_STATS_MAX_PEERS),
    p2pPeerTick: new Int32Array(NET_STATS_MAX_PEERS),
    confirmedTick: 0,
    predictedAhead: 0,
    stalls: 0,
    timesyncSkips: 0,
    inputDelay: 0,
  };
}

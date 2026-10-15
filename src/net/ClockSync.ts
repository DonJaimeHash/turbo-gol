/**
 * Four-timestamp clock sync over ping / pong (see protocol.ts encodePing / encodePong).
 *
 *   client t0 ──ping──▶ host t1 (receive) … t2 (send) ──pong──▶ client t3
 *   rtt    = (t3 - t0) - (t2 - t1)            (the host's processing time is excluded)
 *   offset = ((t1 - t0) + (t2 - t3)) / 2      (host clock - client clock, ms)
 *
 * The host tick at client time `now` is `hostTick + ((now + offset) - t2) / TICK_MS`: the pong
 * carries the host tick at t2, and `now + offset` is the host clock now. Each pong therefore gives
 * one sample of `tickBase = hostTick + (offset - t2) / TICK_MS`, and the estimate is
 * `now / TICK_MS + median(tickBase)`. All three statistics (rtt, offset, tick base) are medians
 * over the last WINDOW samples; jitter is the mean absolute deviation of the rtt samples from
 * their median. Pure, allocation-free after construction; runs in node for the tests.
 */
import { TICK_RATE } from './protocol';

/** Milliseconds per authoritative tick (8.333 at 120 Hz). */
export const TICK_MS = 1000 / TICK_RATE;

export class ClockSync {
  static readonly WINDOW = 16;

  /** Median round trip (ms) over the window. */
  rtt = 0;
  /** Mean |rtt sample - median rtt| (ms). */
  jitter = 0;
  /** Median host clock - client clock (ms). */
  offset = 0;
  /** Number of pongs in the window (0 = no estimate yet). */
  samples = 0;
  /** Raw values of the newest pong. */
  lastRtt = 0;
  lastHostTick = 0;
  lastT3 = 0;

  private readonly rtts = new Float64Array(ClockSync.WINDOW);
  private readonly offsets = new Float64Array(ClockSync.WINDOW);
  private readonly bases = new Float64Array(ClockSync.WINDOW);
  private readonly scratch = new Float64Array(ClockSync.WINDOW);
  private head = 0;
  private tickBase = 0;

  /** Record one pong. `hostTick` is the host's tick count at t2. */
  addPong(t0: number, t1: number, t2: number, t3: number, hostTick: number): void {
    const rtt = Math.max(0, t3 - t0 - (t2 - t1));
    const offset = (t1 - t0 + (t2 - t3)) / 2;
    const base = hostTick + (offset - t2) / TICK_MS;
    const i = this.head;
    this.rtts[i] = rtt;
    this.offsets[i] = offset;
    this.bases[i] = base;
    this.head = (i + 1) % ClockSync.WINDOW;
    if (this.samples < ClockSync.WINDOW) this.samples++;
    this.lastRtt = rtt;
    this.lastHostTick = hostTick;
    this.lastT3 = t3;
    this.recompute();
  }

  /** Estimated (fractional) host tick at client time `nowMs` (same clock as t0 / t3). */
  hostTickEstimate(nowMs: number): number {
    if (this.samples === 0) return 0;
    return nowMs / TICK_MS + this.tickBase;
  }

  reset(): void {
    this.samples = 0;
    this.head = 0;
    this.rtt = 0;
    this.jitter = 0;
    this.offset = 0;
    this.tickBase = 0;
    this.lastRtt = 0;
    this.lastHostTick = 0;
    this.lastT3 = 0;
  }

  private recompute(): void {
    const n = this.samples;
    const med = this.rtt = median(this.rtts, n, this.scratch);
    let dev = 0;
    for (let i = 0; i < n; i++) dev += Math.abs(this.rtts[i] - med);
    this.jitter = dev / n;
    this.offset = median(this.offsets, n, this.scratch);
    this.tickBase = median(this.bases, n, this.scratch);
  }
}

/** Median of the first n entries of `src` (copied into `scratch`, insertion sorted: n <= 16). */
export function median(src: Float64Array, n: number, scratch: Float64Array): number {
  if (n <= 0) return 0;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    let j = i - 1;
    while (j >= 0 && scratch[j] > v) {
      scratch[j + 1] = scratch[j];
      j--;
    }
    scratch[j + 1] = v;
  }
  const mid = n >> 1;
  return (n & 1) === 1 ? scratch[mid] : (scratch[mid - 1] + scratch[mid]) / 2;
}

/** Lead bounds (ticks the local sim runs ahead of the estimated host tick). */
export const LEAD_MIN = 2;
export const LEAD_MAX = 24;
/** Margin added to the one-way latency: twice the measured jitter plus this many ms. */
export const LEAD_JITTER_FLOOR_MS = 2;

/**
 * Ticks to run ahead of the host so an input sent now reaches the host before it simulates that
 * tick: one-way latency (rtt / 2) plus a jitter margin, rounded up, plus one tick of slack. Clamped
 * to [LEAD_MIN, LEAD_MAX]; `adjust` is the bufferHint correction (LeadAdjuster).
 */
export function computeLead(rttMs: number, jitterMs: number, adjust = 0): number {
  const margin = 2 * jitterMs + LEAD_JITTER_FLOOR_MS;
  const base = Math.ceil((rttMs / 2 + margin) / TICK_MS) + 1;
  const lead = base + adjust;
  return lead < LEAD_MIN ? LEAD_MIN : lead > LEAD_MAX ? LEAD_MAX : lead;
}

/** Snapshots per second the host sends (30 Hz at 120 Hz ticks). */
export const SNAPSHOT_HZ = 30;
export const LEAD_ADJUST_MAX = 8;

/**
 * Turns the host's bufferHint stream into a lead correction of +-1 tick per second of consistent
 * hints: a positive hint (the client is too far ahead) counts towards lowering the lead, a
 * negative one (underruns on the host) towards raising it, and a zero hint walks the count back.
 */
export class LeadAdjuster {
  adjust = 0;
  private acc = 0;
  private readonly perSecond: number;

  constructor(snapshotsPerSecond = SNAPSHOT_HZ) {
    this.perSecond = snapshotsPerSecond;
  }

  onHint(hint: number): void {
    if (hint > 0) this.acc = this.acc < 0 ? 1 : this.acc + 1;
    else if (hint < 0) this.acc = this.acc > 0 ? -1 : this.acc - 1;
    else if (this.acc > 0) this.acc--;
    else if (this.acc < 0) this.acc++;
    if (this.acc >= this.perSecond) {
      this.acc = 0;
      if (this.adjust > -LEAD_ADJUST_MAX) this.adjust--;
    } else if (this.acc <= -this.perSecond) {
      this.acc = 0;
      if (this.adjust < LEAD_ADJUST_MAX) this.adjust++;
    }
  }

  reset(): void {
    this.adjust = 0;
    this.acc = 0;
  }
}

/**
 * One timer for every match on the node. Each callback hands the current performance.now() to
 * every room; a room converts elapsed time into 120 Hz ticks with its own accumulator (the same
 * scheme MatchDO uses with its own setInterval). One timer instead of one per match keeps the
 * event loop quiet and makes the lag measurement node-wide.
 *
 * Lag: when a room runs ticks, the oldest pending tick became due `acc - TICK_MS` ago; that delay
 * goes into a histogram. Its p99 is the node's main quality signal (heartbeats, rewards, scheduler):
 * an overloaded or noisy machine shows up there long before players complain.
 */
export interface Tickable {
  advance(nowMs: number): void;
}

/** Fixed-bucket histogram of tick lag: 0.25 ms buckets up to 64 ms (larger values land in the last). */
export class LagHistogram {
  private static readonly BUCKET_MS = 0.25;
  private static readonly BUCKETS = 256;
  private readonly counts = new Uint32Array(LagHistogram.BUCKETS);
  private total = 0;

  add(ms: number): void {
    let i = Math.floor((ms > 0 ? ms : 0) / LagHistogram.BUCKET_MS);
    if (i >= LagHistogram.BUCKETS) i = LagHistogram.BUCKETS - 1;
    this.counts[i]++;
    this.total++;
  }

  get samples(): number {
    return this.total;
  }

  quantile(q: number): number {
    if (this.total === 0) return 0;
    const want = Math.ceil(this.total * q);
    let seen = 0;
    for (let i = 0; i < LagHistogram.BUCKETS; i++) {
      seen += this.counts[i];
      if (seen >= want) return (i + 1) * LagHistogram.BUCKET_MS;
    }
    return LagHistogram.BUCKETS * LagHistogram.BUCKET_MS;
  }

  reset(): void {
    this.counts.fill(0);
    this.total = 0;
  }
}

export class Ticker {
  readonly intervalMs: number;
  /** Node-wide lag since the last heartbeat (the agent reads and resets it). */
  readonly lag = new LagHistogram();
  private readonly items = new Set<Tickable>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(intervalMs = 4) {
    this.intervalMs = intervalMs;
  }

  add(t: Tickable): void {
    this.items.add(t);
    if (!this.timer) this.timer = setInterval(() => this.run(), this.intervalMs);
  }

  remove(t: Tickable): void {
    this.items.delete(t);
    if (this.items.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get size(): number {
    return this.items.size;
  }

  private run(): void {
    const now = performance.now();
    for (const t of this.items) {
      try {
        t.advance(now);
      } catch (e) {
        console.error('ticker: room advance threw', e);
      }
    }
  }
}

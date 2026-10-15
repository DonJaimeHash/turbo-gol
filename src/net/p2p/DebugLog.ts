/**
 * P2PLog: an in-session ring of one-line debug entries (time, event, detail) written by the
 * P2PSession, its RoomClient and its Mesh (docs/online/PHASE2.md). Entries are pushed ONLY on
 * events (queue result, welcome, every signal in / out, ICE / connection state changes, ready /
 * start, drops, fallback and failure reasons), never per tick: a push stores the event name and
 * the detail string in fixed-size arrays (the strings themselves are built by the caller at the
 * event). Nothing else is allocated until someone reads the log.
 *
 * Exposed as window.__game.p2p.log, so a failure on the deploy can be read with one JS call:
 *   __game.p2p.log.text()            one line per entry, oldest first
 *   JSON.stringify(__game.p2p.log)   the same lines as a JSON array (toJSON)
 * Time is the session clock (performance.now(), ms) formatted as seconds with 3 decimals.
 */
export const P2P_LOG_SIZE = 256;

/** What the collaborators (RoomClient, Mesh) need: push one line. */
export interface P2PLogSink {
  push(event: string, detail?: string): void;
}

/** One decoded entry (the reusable out-parameter of P2PLog.entry). */
export interface P2PLogEntry {
  /** Sequence number since the log was created (monotonic across wraps). */
  seq: number;
  /** Clock value at the push (ms). */
  at: number;
  event: string;
  detail: string;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class P2PLog implements P2PLogSink {
  readonly size: number;
  private readonly at: Float64Array;
  private readonly events: string[] = [];
  private readonly details: string[] = [];
  private readonly now: () => number;
  private head = 0;
  private count = 0;
  private seq = 0;

  constructor(now?: () => number, size: number = P2P_LOG_SIZE) {
    this.size = size > 0 ? size : P2P_LOG_SIZE;
    this.now = now ?? defaultNow;
    this.at = new Float64Array(this.size);
    for (let i = 0; i < this.size; i++) {
      this.events.push('');
      this.details.push('');
    }
  }

  /** Entries currently held (<= size). */
  get length(): number {
    return this.count;
  }

  /** Entries pushed since creation (the ring forgot `total - length` of them). */
  get total(): number {
    return this.seq;
  }

  push(event: string, detail: string = ''): void {
    const i = this.head;
    this.at[i] = this.now();
    this.events[i] = event;
    this.details[i] = detail;
    this.head = (i + 1) % this.size;
    if (this.count < this.size) this.count++;
    this.seq++;
  }

  /** The i-th held entry (0 = oldest) into `out`; false when out of range. Allocation-free. */
  entry(i: number, out: P2PLogEntry): boolean {
    if (i < 0 || i >= this.count) return false;
    const idx = (this.head - this.count + i + this.size) % this.size;
    out.seq = this.seq - this.count + i;
    out.at = this.at[idx];
    out.event = this.events[idx];
    out.detail = this.details[idx];
    return true;
  }

  /** The event name of the i-th held entry ('' out of range): for tests / probes without allocating. */
  eventAt(i: number): string {
    if (i < 0 || i >= this.count) return '';
    return this.events[(this.head - this.count + i + this.size) % this.size];
  }

  /** True when any held entry has this event name (tests). */
  has(event: string): boolean {
    for (let i = 0; i < this.count; i++) if (this.eventAt(i) === event) return true;
    return false;
  }

  /** Formatted lines, oldest first (allocates: read-time only). */
  lines(): string[] {
    const out: string[] = [];
    const e: P2PLogEntry = { seq: 0, at: 0, event: '', detail: '' };
    for (let i = 0; i < this.count; i++) {
      this.entry(i, e);
      const t = (e.at / 1000).toFixed(3);
      out.push(e.detail.length > 0 ? `${t} #${e.seq} ${e.event} ${e.detail}` : `${t} #${e.seq} ${e.event}`);
    }
    return out;
  }

  text(): string {
    return this.lines().join('\n');
  }

  toJSON(): string[] {
    return this.lines();
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

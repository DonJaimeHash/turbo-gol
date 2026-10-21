/**
 * The NodeRegistryDO's ALERT lines on a Discord channel of the team (NODE_ALERT_WEBHOOK, a secret,
 * optional): every line the object logs that starts with ALERT is also posted there, through
 * waitUntil, so nobody has to read the Worker's logs to learn that a node went quiet. The logs keep
 * every line; the channel gets two kinds:
 *
 *   alerts       what the object sees go wrong (post): the same alert at most once per
 *                ALERT_DEDUPE_MS, and at most ALERT_BURST in any minute. The ones left out are
 *                counted, and the count goes out with the next post, or alone once the minute allows.
 *   audit lines  what an account did (audit: a maintainer's call, a token created, a trusted node
 *                registered): every one is posted, none merged with another or left out by that
 *                limit, so a project session in the wrong hands cannot hide its last steps behind a
 *                few harmless ones.
 *
 * Posts take turns, at most ALERT_PACE in any ALERT_PACE_MS (Discord takes 5 a webhook in 2 s). One
 * Discord answers 429 is tried once more after its Retry-After; one that still fails is counted
 * like a line left out, and the same alert may go out again.
 *
 * The lines carry what nodes send (a node's name, its version, the answer of its /healthz, a
 * verifier's message) and what maintainers type (a drain's reason). None of it may be read as
 * Discord markdown, a mention or a link: the line goes in one code span, without backticks or
 * invisible characters, cut to fit the message, and the post allows no mention and no embed.
 */

/** The message's text is cut to this (Discord takes 2,000 characters). */
export const ALERT_MAX_CHARS = 1900;
/** The same alert (alertKey) is posted at most once in this long. */
export const ALERT_DEDUPE_MS = 10 * 60_000;
/**
 * Alerts posted in any ALERT_BURST_MS at most (a sliding window; audit lines are not counted): a
 * cascade (every match of a broken verifier) must not bury the channel.
 */
export const ALERT_BURST = 5;
export const ALERT_BURST_MS = 60_000;
/**
 * Posts started in any ALERT_PACE_MS at most, the others wait their turn: Discord takes 5 posts a
 * webhook in 2 s, and 4 in 3 s leave room for one that arrives late.
 */
export const ALERT_PACE = 4;
export const ALERT_PACE_MS = 3_000;
/** Posts waiting for their turn at most (a flood of audit lines): past it a line is counted as left out. */
export const ALERT_QUEUE_MAX = 50;
/** A post answered 429 is tried once more after its Retry-After, waited at most this long. */
export const ALERT_RETRY_MAX_MS = 10_000;
/** A post that takes longer is given up (it never holds the object). */
export const ALERT_POST_TIMEOUT_MS = 5_000;
/** Discord's SUPPRESS_EMBEDS message flag: no preview of any address in the text. */
const SUPPRESS_EMBEDS = 1 << 2;
/** Keys remembered at most (each for ALERT_DEDUPE_MS). */
const KEYS_MAX = 500;

/** What the object fetches with (global fetch in production; tests hand in a fake). */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The alert a line is: lines that differ only in their numbers or long hex ids (a count, a time, a
 * match or node id) are the same alert. A number that ends a word stays: node names keep their
 * digits (sp1 is not sp2, sao-paulo-1 is not sao-paulo-2). Audit lines never go through it: two
 * maintainers' calls are two posts, whatever their words.
 */
export function alertKey(line: string): string {
  return line
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/(?<![\w-])\d+(?:\.\d+)?\b/g, '#')
    .slice(0, 200);
}

/**
 * `s` fit for a Discord code span: backticks become quotes, control and invisible formatting
 * characters (bidi overrides, zero-width ones) and line breaks become spaces, and it is cut to
 * `max` characters (an ellipsis marks the cut). Never empty: an empty span would show its backticks.
 */
export function codeSafe(s: string, max: number): string {
  const t = s
    .replace(/`/g, "'")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim();
  if (t.length === 0) return '-';
  if (t.length <= max) return t;
  let cut = t.slice(0, Math.max(0, max - 1));
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // never half a character
  return cut + '…';
}

/** The webhook message for one ALERT line: its text in a code span, then `note` (the object's own words), at most ALERT_MAX_CHARS. */
export function alertContent(line: string, note = ''): string {
  const head = '**ALERT** `';
  const tail = '`' + (note ? '\n' + note : '');
  return head + codeSafe(line.replace(/^ALERT\s*/, ''), ALERT_MAX_CHARS - head.length - tail.length) + tail;
}

/** What the channel is told about `n` lines it did not get. */
export function leftOutNote(n: number): string {
  return `(${n} more ALERT line${n === 1 ? '' : 's'} only in the Worker's logs)`;
}

export interface AlertHookOptions {
  /** NODE_ALERT_WEBHOOK; unset: nothing is posted. */
  url: string | undefined;
  /** The object's ctx.waitUntil: a post never holds the handler that logged the line. */
  waitUntil: (p: Promise<unknown>) => void;
  fetch: FetchFn;
  now?: () => number;
  /** How a post waits for its turn (setTimeout; tests hand in their clock's). */
  sleep?: (ms: number) => Promise<void>;
  /** For the hook's own failures: never an ALERT line, or a failing webhook would post about itself. */
  log?: (msg: string) => void;
}

/** A post on its way: an alert (its key, and when it was taken), an audit line (no key), or the count alone (no line). */
interface Post {
  line: string | null;
  key: string | null;
  at: number;
}

export class AlertHook {
  private readonly o: AlertHookOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** When each alert was last posted. */
  private readonly sent = new Map<string, number>();
  /** When the last ALERT_BURST alerts were taken, oldest first. */
  private readonly burst: number[] = [];
  /** When the last ALERT_PACE posts start, oldest first (the last ones may be still to come). */
  private readonly turns: number[] = [];
  /** Posts waiting for their turn. */
  private waiting = 0;
  /** ALERT lines only in the logs since the last post: left out by the limit, or not delivered. */
  private skipped = 0;
  /** The count alone is on its way. */
  private counting = false;

  constructor(o: AlertHookOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Post an alert, unless the same alert (`key`, alertKey(line) by default) went out less than
   * ALERT_DEDUPE_MS ago, or ALERT_BURST alerts went out in the last minute (then it is counted).
   * True when it is posted, now or at its turn.
   */
  post(line: string, key: string = alertKey(line)): boolean {
    if (!this.o.url) return false;
    const now = this.now();
    const last = this.sent.get(key);
    if (last !== undefined && now - last < ALERT_DEDUPE_MS) return false;
    if (this.full(now)) {
      this.leftOut(1);
      return false;
    }
    if (!this.queue({ line, key, at: now })) return false;
    this.burst.push(now);
    // Deleted and set again, so the Map stays in posting order: past KEYS_MAX the oldest go first.
    this.sent.delete(key);
    if (this.sent.size >= KEYS_MAX) for (const [k, t] of this.sent) if (now - t >= ALERT_DEDUPE_MS || this.sent.size >= KEYS_MAX) this.sent.delete(k);
    this.sent.set(key, now);
    return true;
  }

  /** Post an audit line: every one, never merged with another nor left out by the burst limit. True when it is posted, now or at its turn. */
  audit(line: string): boolean {
    if (!this.o.url) return false;
    return this.queue({ line, key: null, at: this.now() });
  }

  /**
   * The post's turn: now while fewer than ALERT_PACE started in the last ALERT_PACE_MS, else once
   * the oldest of those is that far behind. False (the line counted) when ALERT_QUEUE_MAX already
   * wait; the count alone (`always`) waits all the same.
   */
  private queue(p: Post, always = false): boolean {
    const now = this.now();
    const turn = this.turns.length >= ALERT_PACE ? Math.max(now, this.turns[0] + ALERT_PACE_MS) : now;
    if (turn > now && this.waiting >= ALERT_QUEUE_MAX && !always) {
      this.leftOut(1);
      return false;
    }
    this.turns.push(turn);
    if (this.turns.length > ALERT_PACE) this.turns.shift();
    if (turn <= now) {
      this.o.waitUntil(this.deliver(p));
      return true;
    }
    this.waiting++;
    this.o.waitUntil(
      this.sleep(turn - now).then(() => {
        this.waiting--;
        return this.deliver(p);
      }),
    );
    return true;
  }

  /** ALERT_BURST alerts went out in the last ALERT_BURST_MS (the older ones are dropped from the window). */
  private full(now: number): boolean {
    while (this.burst.length > 0 && now - this.burst[0] >= ALERT_BURST_MS) this.burst.shift();
    return this.burst.length >= ALERT_BURST;
  }

  /** `n` more lines only in the logs: counted, and the count posted alone once the minute allows, unless a post takes it first. */
  private leftOut(n: number): void {
    this.skipped += n;
    if (this.counting) return;
    this.counting = true;
    const now = this.now();
    const at = (this.full(now) ? this.burst[0] : now) + ALERT_BURST_MS;
    this.o.waitUntil(
      this.sleep(Math.max(0, at - now)).then(() => {
        this.counting = false;
        if (this.skipped > 0) this.queue({ line: null, key: null, at: this.now() }, true);
      }),
    );
  }

  /**
   * One post, carrying the count of the lines left out so far, tried once more after a 429. One
   * that fails is counted with the lines it carried, and its alert may go out again; the count
   * alone that fails is kept for the next post (the webhook may be gone: it is not tried again).
   */
  private async deliver(p: Post): Promise<void> {
    const url = this.o.url;
    if (!url) return;
    const carried = this.skipped;
    this.skipped = 0;
    if (p.line === null && carried === 0) return; // a post took the count first
    const note = carried > 0 ? leftOutNote(carried) : '';
    const content = p.line === null ? note : alertContent(p.line, note);
    let done = await this.send(url, content);
    if (typeof done === 'number') {
      await this.sleep(done);
      done = (await this.send(url, content)) === true;
    }
    if (done) return;
    if (p.key !== null && this.sent.get(p.key) === p.at) this.sent.delete(p.key);
    if (p.line === null) this.skipped += carried;
    else this.leftOut(1 + carried);
  }

  /**
   * One POST, given up after ALERT_POST_TIMEOUT_MS: true when Discord took it, the wait its 429
   * asks for (Retry-After, at most ALERT_RETRY_MAX_MS), false otherwise. A failure is logged
   * without the URL: it is a secret.
   */
  private async send(url: string, content: string): Promise<boolean | number> {
    const log = this.o.log ?? ((m: string) => console.log(m));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ALERT_POST_TIMEOUT_MS);
    try {
      const res = await this.o.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS }),
        signal: ctrl.signal,
      });
      await res.body?.cancel();
      if (res.ok) return true;
      log(`alert webhook answered ${res.status}`);
      if (res.status !== 429) return false;
      const s = Number(res.headers.get('retry-after'));
      return Math.min(Number.isFinite(s) && s > 0 ? s * 1000 : ALERT_PACE_MS, ALERT_RETRY_MAX_MS);
    } catch (e) {
      log(`alert webhook failed (${e instanceof Error ? e.name : 'error'})`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

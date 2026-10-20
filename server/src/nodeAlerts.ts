/**
 * The NodeRegistryDO's ALERT lines on a Discord channel of the team (NODE_ALERT_WEBHOOK, a secret,
 * optional): every line the object logs that starts with ALERT is also posted there, through
 * waitUntil, so nobody has to read the Worker's logs to learn that a node went quiet. The logs keep
 * every line; the channel gets the same alert at most once per ALERT_DEDUPE_MS and at most
 * ALERT_BURST posts a minute (the rest are counted in the next post).
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
 * Posts per minute at most: a cascade (every match of a broken verifier) must not get the webhook
 * rate limited. Discord takes 5 posts a webhook in 2 s, and these may all go out at once.
 */
export const ALERT_BURST = 5;
const BURST_WINDOW_MS = 60_000;
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
 * digits (sp1 is not sp2, sao-paulo-1 is not sao-paulo-2).
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

export interface AlertHookOptions {
  /** NODE_ALERT_WEBHOOK; unset: nothing is posted. */
  url: string | undefined;
  /** The object's ctx.waitUntil: a post never holds the handler that logged the line. */
  waitUntil: (p: Promise<unknown>) => void;
  fetch: FetchFn;
  now?: () => number;
  /** For the hook's own failures: never an ALERT line, or a failing webhook would post about itself. */
  log?: (msg: string) => void;
}

export class AlertHook {
  private readonly o: AlertHookOptions;
  private readonly now: () => number;
  /** When each alert was last posted. */
  private readonly sent = new Map<string, number>();
  private windowStart = 0;
  private windowPosts = 0;
  /** ALERT lines left out by the burst limit since the last post. */
  private skipped = 0;

  constructor(o: AlertHookOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  /**
   * Post one ALERT line, unless the same alert (`key`, alertKey(line) by default) went out less
   * than ALERT_DEDUPE_MS ago or this minute's posts are spent. True when a post was started.
   */
  post(line: string, key: string = alertKey(line)): boolean {
    const url = this.o.url;
    if (!url) return false;
    const now = this.now();
    const last = this.sent.get(key);
    if (last !== undefined && now - last < ALERT_DEDUPE_MS) return false;
    if (now - this.windowStart >= BURST_WINDOW_MS) {
      this.windowStart = now;
      this.windowPosts = 0;
    }
    if (this.windowPosts >= ALERT_BURST) {
      this.skipped++;
      return false;
    }
    this.windowPosts++;
    // Deleted and set again, so the Map stays in posting order: past KEYS_MAX the oldest go first.
    this.sent.delete(key);
    if (this.sent.size >= KEYS_MAX) for (const [k, t] of this.sent) if (now - t >= ALERT_DEDUPE_MS || this.sent.size >= KEYS_MAX) this.sent.delete(k);
    this.sent.set(key, now);
    const note = this.skipped > 0 ? `(${this.skipped} more ALERT line${this.skipped === 1 ? '' : 's'} only in the Worker's logs)` : '';
    this.skipped = 0;
    this.o.waitUntil(this.deliver(url, alertContent(line, note)));
    return true;
  }

  /** One POST, given up after ALERT_POST_TIMEOUT_MS. A failure is logged without the URL: it is a secret. */
  private async deliver(url: string, content: string): Promise<void> {
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
      if (!res.ok) log(`alert webhook answered ${res.status}`);
    } catch (e) {
      log(`alert webhook failed (${e instanceof Error ? e.name : 'error'})`);
    } finally {
      clearTimeout(timer);
    }
  }
}

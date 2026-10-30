/**
 * The Worker's mailer (docs/online/MAIL.md; the sign-in design, sections 4.5 and 4.6). Nothing
 * calls it yet: the routes that send mail come with the email accounts.
 *
 *   chooseMailer(request, env)  the live mailer only with the binding, MAIL_LIVE=1, a sender and a
 *                               host that is not loopback; the stub otherwise (dev, tests, forks)
 *   composeMail(to, rendered)   a message for one recipient (mailTemplates.ts renders the bodies)
 *   deliver(mailer, message)    send it; a failure logs `mail_failed kind lane err` and nothing else
 *   linkOrigin(request, env)    the origin of every link in a mail (MAIL_LINK_ORIGIN, or loopback)
 *   emailAvailable(...)         a mailer can deliver and the kill flag is off (`/api/config` auth.email)
 *   isDevAuth, devMailResponse  the dev-only outbox of the stub (GET /api/dev/mail): 404 off the gate
 *
 * This is the only file that may touch env.EMAIL (server/test/mail.test.mjs fails otherwise), so
 * no path can send without passing chooseMailer's three conditions. Under `wrangler dev` the
 * binding is wrangler's local simulation anyway (wrangler.jsonc gives it no `remote` flag): it
 * writes the message to a local file and never reaches Email Service.
 */
import { error, json, type Env, type MailBinding } from './env';
import { laneOf, mailKilled, type MailKind, type MailLane } from './mailCaps';
import type { RenderedMail } from './mailTemplates';

/** One message to one recipient, ready to send. */
export interface MailMessage {
  kind: MailKind;
  lane: MailLane;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** X-Entity-Ref-ID: random per message, so Gmail never threads separate codes together. */
  ref: string;
  /** The mail's link and code, for the stub's outbox only: the live mailer sends the bodies. */
  link?: string;
  code?: string;
}

export interface Mailer {
  /** True only for the mailer that reaches Email Service. */
  readonly live: boolean;
  send(m: MailMessage): Promise<void>;
}

// ---- Hosts ----------------------------------------------------------------------------------------

/** The loopback test of index.ts (isLoopbackHost), kept here so the mailer depends on no router. */
function isLoopbackHost(h: string): boolean {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
}

/** The request reached the Worker on a loopback host: `wrangler dev`. A deploy never does. */
export function isLocalDev(request: Request): boolean {
  return isLoopbackHost(new URL(request.url).hostname);
}

/** `origin` is a loopback http(s) origin (the Vite dev server, on any port). */
function loopbackOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !isLoopbackHost(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Where links point while the game runs locally and the request carries no loopback Origin. */
export const DEV_LINK_ORIGIN = 'http://localhost:5173';

/**
 * The origin of every link in a mail. On a loopback host (wrangler dev): the request's Origin when
 * it is a loopback one, else DEV_LINK_ORIGIN. Anywhere else: the MAIL_LINK_ORIGIN var, an https
 * origin, or null (the route then answers 503 `email_unconfigured`). Never the request's Host or
 * any other header, so a forged one cannot put its own site in a mail.
 */
export function linkOrigin(request: Request, env: Pick<Env, 'MAIL_LINK_ORIGIN'>): string | null {
  if (isLocalDev(request)) return loopbackOrigin(request.headers.get('Origin') ?? '') ?? DEV_LINK_ORIGIN;
  const v = (env.MAIL_LINK_ORIGIN ?? '').trim();
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.origin === v.replace(/\/$/, '') ? u.origin : null;
  } catch {
    return null;
  }
}

// ---- Messages -------------------------------------------------------------------------------------

/**
 * One address and nothing else: no list, no display name, no header-breaking character. Mail is
 * always one recipient per message (no CC, no BCC), so nobody's address is shown to anyone else.
 * The full rules (normalizeEmail) are the account code's; this only refuses what could add a second
 * recipient or a header. One rule with them: every address normalizeEmail takes passes here, the
 * apostrophe of o'brien@x.ie included (RFC 5322 atext; server/test/address-rule.test.mjs checks both).
 */
export function isOneRecipient(to: unknown): to is string {
  return typeof to === 'string' && to.length <= 254 && /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"'()[\]\\]+\.[^\s@<>,;:"'()[\]\\]+$/.test(to) && !/[\p{Cc}]/u.test(to);
}

function randomRef(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** A rendered mail for one recipient. Throws on an address that is not exactly one. */
export function composeMail(to: string, r: RenderedMail): MailMessage {
  if (!isOneRecipient(to)) throw new Error('mail: one recipient per message');
  return {
    kind: r.kind,
    lane: laneOf(r.kind),
    to,
    subject: r.subject,
    text: r.text,
    html: r.html,
    ref: randomRef(),
    ...(r.link ? { link: r.link } : {}),
    ...(r.code ? { code: r.code } : {}),
  };
}

/** `an***@x.com`: what a log line may say about an address (the stub's, on loopback only). */
export function maskAddress(to: string): string {
  const at = to.lastIndexOf('@');
  if (at < 1) return '***';
  return to.slice(0, Math.min(2, at - 1) || 1) + '***' + to.slice(at);
}

/** MAIL_FROM as the binding takes it: `Name <address>` gives a name and an address. Null if it is neither. */
export function parseSender(v: string | undefined): { email: string; name: string } | string | null {
  const s = (v ?? '').trim();
  const named = /^([^<>"\r\n]{1,64}?)\s*<([^<>\s]+)>$/.exec(s);
  if (named && isOneRecipient(named[2])) return { name: named[1].trim(), email: named[2] };
  return isOneRecipient(s) ? s : null;
}

// ---- The mailers ----------------------------------------------------------------------------------

/**
 * The headers of transactional mail: no vacation replies (RFC 3834), no auto-responses, no
 * threading of separate codes. Email Service accepts Auto-Submitted and any X- header; there is no
 * List-Unsubscribe, which belongs to news (docs/online/MAIL.md).
 */
export function mailHeaders(ref: string): Record<string, string> {
  return { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All', 'X-Entity-Ref-ID': ref };
}

/** Email Service through the `send_email` binding: one recipient, the sender, both bodies, the headers. */
export class LiveMailer implements Mailer {
  readonly live = true;
  private readonly binding: MailBinding;
  private readonly from: { email: string; name: string } | string;
  constructor(binding: MailBinding, from: { email: string; name: string } | string) {
    this.binding = binding;
    this.from = from;
  }

  async send(m: MailMessage): Promise<void> {
    if (!isOneRecipient(m.to)) throw new Error('mail: one recipient per message');
    if (/[\r\n]/.test(m.subject)) throw new Error('mail: a subject is one line');
    await this.binding.send({ to: m.to, from: this.from, subject: m.subject, text: m.text, html: m.html, headers: mailHeaders(m.ref) });
  }
}

/** What the stub "sent", newest last (GET /api/dev/mail shows it newest first). */
export interface OutboxEntry {
  at: number;
  kind: MailKind;
  lane: MailLane;
  to: string;
  subject: string;
  text: string;
  link?: string;
  code?: string;
}

/** The stub's outbox in this isolate: the last OUTBOX_SIZE messages. */
export const OUTBOX_SIZE = 20;
const OUTBOX: OutboxEntry[] = [];

/**
 * Sends nothing. On a loopback host (`keep`) it records the message in the outbox and logs
 * `[mail stub] <kind> to an***@x.com <link>`, so a developer can open the link. Anywhere else (a
 * deploy without MAIL_LIVE) it keeps nothing and logs only the kind: no address, link or code.
 */
export class StubMailer implements Mailer {
  readonly live = false;
  readonly outbox: OutboxEntry[];
  private readonly keep: boolean;
  constructor(keep: boolean, outbox: OutboxEntry[] = []) {
    this.keep = keep;
    this.outbox = outbox;
  }

  async send(m: MailMessage): Promise<void> {
    if (!this.keep) {
      console.log(`mail_stub kind=${m.kind} lane=${m.lane} (live mail is off: not sent)`);
      return;
    }
    this.outbox.push({ at: Date.now(), kind: m.kind, lane: m.lane, to: m.to, subject: m.subject, text: m.text, ...(m.link ? { link: m.link } : {}), ...(m.code ? { code: m.code } : {}) });
    if (this.outbox.length > OUTBOX_SIZE) this.outbox.splice(0, this.outbox.length - OUTBOX_SIZE);
    console.log(`[mail stub] ${m.kind} to ${maskAddress(m.to)} ${m.link ?? '(code in GET /api/dev/mail)'}`);
  }
}

/**
 * The live mailer only when all of these hold: the `EMAIL` binding exists, the MAIL_LIVE secret is
 * '1', MAIL_FROM is a sender, and the request's host is not loopback. `wrangler dev` is always
 * loopback, so a stray MAIL_LIVE in .dev.vars or .env still sends nothing. Otherwise the stub.
 */
export function chooseMailer(request: Request, env: Pick<Env, 'EMAIL' | 'MAIL_LIVE' | 'MAIL_FROM'>, outbox: OutboxEntry[] = OUTBOX): Mailer {
  const local = isLocalDev(request);
  if (env.EMAIL && env.MAIL_LIVE === '1' && !local) {
    const from = parseSender(env.MAIL_FROM);
    if (from) return new LiveMailer(env.EMAIL, from);
    console.warn('mail: MAIL_FROM is not a sender address, so live mail stays off');
  }
  return new StubMailer(local, outbox);
}

/** The error's code (E_RATE_LIMIT_EXCEEDED...) or its name: never its message, which may hold the address. */
function errorName(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  if (typeof c === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(c)) return c;
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === 'string' && /^[A-Za-z]{1,40}$/.test(n) ? n : 'unknown';
}

/**
 * Send `m`, for a route's `waitUntil` once it has answered. There is no retry (a retry would mail a
 * second code): the person presses REENVIAR. A failure logs `mail_failed kind=<kind> lane=<lane>
 * err=<code>`, with no address, link or code, then calls `onFailed` (AccountsDO counts the lane's
 * failures). Never rejects.
 */
export async function deliver(mailer: Mailer, m: MailMessage, onFailed?: (kind: MailKind, lane: MailLane) => Promise<void> | void): Promise<boolean> {
  try {
    await mailer.send(m);
    return true;
  } catch (e) {
    console.warn(`mail_failed kind=${m.kind} lane=${m.lane} err=${errorName(e)}`);
    try {
      await onFailed?.(m.kind, m.lane);
    } catch {
      // counting a failure must not throw into waitUntil
    }
    return false;
  }
}

/**
 * The flows that send mail may show (`/api/config` auth.email): the kill flag is off, links have an
 * origin, and the mailer delivers, live or, on a loopback host, into the stub's outbox. False on a
 * deploy that forgot MAIL_LIVE, so it never offers a code that cannot arrive.
 */
export async function emailAvailable(request: Request, env: Pick<Env, 'EMAIL' | 'MAIL_LIVE' | 'MAIL_FROM' | 'MAIL_LINK_ORIGIN' | 'FLAGS'>): Promise<boolean> {
  if (linkOrigin(request, env) === null) return false;
  if (!chooseMailer(request, env, []).live && !isLocalDev(request)) return false;
  return !(await mailKilled(env));
}

// ---- Dev only -------------------------------------------------------------------------------------

/**
 * The dev-only gate: DEV_AUTH=1 (in your own server/.dev.vars), a loopback request host, and no
 * Origin or a loopback one. Production's host is turbo-gol.com, so it is closed there whatever
 * the vars say.
 */
export function isDevAuth(request: Request, env: Pick<Env, 'DEV_AUTH'>): boolean {
  if (env.DEV_AUTH !== '1' || !isLocalDev(request)) return false;
  const origin = request.headers.get('Origin');
  return origin === null || loopbackOrigin(origin) !== null;
}

/**
 * GET /api/dev/mail: the stub's outbox, newest first, with links and codes, so local runs and
 * agents can finish a flow. 404 `not_found` whenever the gate is closed, the same answer as any
 * unknown route. Mounted by accountRoutes.ts devRoute, beside the dev sign-in (POST /api/dev/signin).
 */
export function devMailResponse(request: Request, env: Pick<Env, 'DEV_AUTH'>, outbox: readonly OutboxEntry[] = OUTBOX): Response {
  if (request.method !== 'GET' || !isDevAuth(request, env)) return error(404, 'not_found');
  return json({ messages: [...outbox].reverse() }, 200, { 'cache-control': 'no-store' });
}

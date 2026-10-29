/**
 * What may be mailed, and how much (docs/online/MAIL.md; the sign-in design, sections 2.16, 4.6
 * and 4.7). Pure numbers and rules: the counters themselves live in AccountsDO's SQLite (exact,
 * global, they survive deploys), which a later change wires to these functions. Nothing here sends
 * mail or reads a request.
 *
 *   MAIL_KINDS / laneOf   every message and the lane it counts in
 *   dailyCap, laneAllows  the day's global cap (EMAIL_DAILY_CAP) and each lane's share of it
 *   MAIL_CAPS, takeSlot   the per-address, per-network and per-account caps, as fixed windows
 *   signupPaused          the automatic pause of the sign-up lane after repeated send failures
 *   mailKilled            the kill flag, KV `email_off`: every lane stops
 */
import { flag, type Env } from './env';

/** Every message the Worker can send (mailTemplates.ts renders each one in es and en). */
export const MAIL_KINDS = [
  'verify_signup', // M1
  'signup_exists', // M2
  'reset', // M3
  'password_changed', // M4
  'verify_email', // M5
  'email_changed', // M6
  'email_in_use', // M7
  'provider_linked', // M8, and its variant 'unlinked'
  'deletion_scheduled', // M9
  'legacy_reminder', // M10
  'reauth_code', // M11
  'email_moved', // M12
] as const;

export type MailKind = (typeof MAIL_KINDS)[number];

/**
 * signup: mail that anonymous sign-ups start. account: codes and links an account asked for.
 * notice: security notices about something that already happened.
 */
export type MailLane = 'signup' | 'account' | 'notice';

const LANE: Record<MailKind, MailLane> = {
  verify_signup: 'signup',
  signup_exists: 'signup',
  reset: 'account',
  verify_email: 'account',
  email_in_use: 'account',
  legacy_reminder: 'account',
  reauth_code: 'account',
  password_changed: 'notice',
  email_changed: 'notice',
  provider_linked: 'notice',
  deletion_scheduled: 'notice',
  email_moved: 'notice',
};

export function laneOf(kind: MailKind): MailLane {
  return LANE[kind];
}

/** The security notices go out in both languages (mailTemplates.ts), the account's first. */
export function isNotice(kind: MailKind): boolean {
  return LANE[kind] === 'notice';
}

// ---- The day's global cap, in lanes --------------------------------------------------------------

/** EMAIL_DAILY_CAP until the owner reads the account's quota in the Email Service dashboard. */
export const DEFAULT_DAILY_CAP = 100;
/** Above this a var is a typo, not a quota. */
const MAX_DAILY_CAP = 1_000_000;

/**
 * A lane may send while the day's total across all lanes is below its share of the cap: a flood
 * of sign-ups stops at 60 %, so resets and codes (90 %) and security notices (100 %) still go.
 */
export const LANE_SHARE: Readonly<Record<MailLane, number>> = { signup: 0.6, account: 0.9, notice: 1 };

/** EMAIL_DAILY_CAP as a positive integer; DEFAULT_DAILY_CAP when unset or not one. */
export function dailyCap(env: Pick<Env, 'EMAIL_DAILY_CAP'>): number {
  const raw = env.EMAIL_DAILY_CAP;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAILY_CAP ? n : DEFAULT_DAILY_CAP;
}

/** How many mails of the day (all lanes together) a lane may see before it stops. */
export function laneLimit(lane: MailLane, cap: number): number {
  return Math.floor(cap * LANE_SHARE[lane]);
}

/** `lane` may send one more, given the day's total so far across all lanes. */
export function laneAllows(lane: MailLane, dayTotal: number, cap: number): boolean {
  return dayTotal < laneLimit(lane, cap);
}

/** The UTC day a mail counts in (`mail_day.day`). */
export function mailDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

// ---- Per address, per network, per account -------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** At most `hour` in an hour and `day` in 24 hours (either may be absent). */
export interface WindowCap {
  hour?: number;
  day: number;
}

/**
 * The durable caps (design section 2.16). A network is limitKey's (env.ts): an IPv6 /64, or an
 * IPv4 address, which gets 20 times more because a school, a LAN party or a carrier's CGNAT puts
 * many players behind one; the fine work is done per address and per account.
 */
export const MAIL_CAPS = {
  /** Mail to one address (its canon), every kind except the notices. */
  recipient: { hour: 5, day: 10 },
  /** Security notices to one account, counted on their own. */
  notice: { day: 5 },
  /** Mail started by anonymous routes, per network. */
  networkV6: { hour: 10, day: 30 },
  networkV4: { hour: 200, day: 600 },
  /** Mail started by /api/me/* and reauth, per account. */
  account: { day: 10 },
} as const satisfies Record<string, WindowCap>;

/** Resends of one attempt: one a minute, three in all; each re-sends the same code and link. */
export const RESEND = { gapMs: 60_000, max: 3 } as const;

/** The cap of a network key (limitKey): an IPv6 /64 ends in '::/64', anything else counts as IPv4. */
export function networkCap(netKey: string): WindowCap {
  return netKey.endsWith('::/64') ? MAIL_CAPS.networkV6 : MAIL_CAPS.networkV4;
}

/** A `mail_rate` row: a fixed hour window and a fixed 24-hour window, each from its first mail. */
export interface MailWindow {
  hour_at: number;
  hour_n: number;
  day_at: number;
  day_n: number;
}

/**
 * Take one slot of `cap` at `now`. A window that is over starts again at `now`. A refusal counts
 * nothing, so a caller that keeps asking never pushes its own window further out.
 */
export function takeSlot(row: MailWindow | null, cap: WindowCap, now: number): { ok: boolean; row: MailWindow } {
  const cur: MailWindow = row ? { ...row } : { hour_at: now, hour_n: 0, day_at: now, day_n: 0 };
  if (now - cur.hour_at >= HOUR || now < cur.hour_at) {
    cur.hour_at = now;
    cur.hour_n = 0;
  }
  if (now - cur.day_at >= DAY || now < cur.day_at) {
    cur.day_at = now;
    cur.day_n = 0;
  }
  const hourFull = cap.hour !== undefined && cur.hour_n >= cap.hour;
  if (hourFull || cur.day_n >= cap.day) return { ok: false, row: cur };
  cur.hour_n++;
  cur.day_n++;
  return { ok: true, row: cur };
}

// ---- Failures, the pause and the kill flag --------------------------------------------------------

/**
 * After `failures` failed sends in `windowMs`, the sign-up lane pauses for `pauseMs` (503
 * `email_paused` for every address alike). The account and notice lanes never pause by
 * themselves: the same count there raises one ALERT per `alertEveryMs` instead, so burning the
 * quota or tripping failures can stop new email sign-ups for a while, never a reset.
 */
export const FAILURES = { failures: 10, windowMs: 10 * 60_000, pauseMs: 30 * 60_000, alertEveryMs: 30 * 60_000 } as const;

/** The new `paused_until` of a lane after a failure, or 0 when the lane does not pause. */
export function pauseAfterFailures(lane: MailLane, failuresInWindow: number, now: number): number {
  if (lane !== 'signup' || failuresInWindow < FAILURES.failures) return 0;
  return now + FAILURES.pauseMs;
}

/** The lane's failures call for an ALERT (the lanes that never pause), at most once per alertEveryMs. */
export function alertAfterFailures(lane: MailLane, failuresInWindow: number, lastAlertAt: number, now: number): boolean {
  if (lane === 'signup' || failuresInWindow < FAILURES.failures) return false;
  return now - lastAlertAt >= FAILURES.alertEveryMs;
}

/** The KV flag that stops every lane at once, no deploy needed (`/api/config` then says auth.email: false). */
export const MAIL_KILL_FLAG = 'email_off';

/** The kill flag is set ('1', 'true' or 'on'; edge-cached 60 s). A KV that cannot be read counts as not set. */
export function mailKilled(env: Pick<Env, 'FLAGS'>): Promise<boolean> {
  return flag(env, MAIL_KILL_FLAG);
}

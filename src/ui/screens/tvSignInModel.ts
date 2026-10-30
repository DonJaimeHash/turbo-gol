/**
 * The pure part of the TV's sign-in with the phone (screens/tvSignIn.ts; tests/tv-signin.test.mjs):
 * the /tv page's link and how its code rides in the hash, the countdown, the marker kept across a
 * sign-in's round trip, and the phone's continuation after it. No DOM.
 */
import { CODE_ALPHABET, CODE_LENGTH } from './lobbyModel';
import type { TvInfoAnswer } from '../../net/account';

/** The phone's page that confirms a TV (the SPA answers it: server/wrangler.jsonc not_found_handling). */
export const TV_PATH = '/tv';

/**
 * The link a TV's QR opens: `https://turbo-gol.com/tv#ABC234`, the code in the hash (a browser never
 * sends it, so it stays out of every server log). The code alone: `#tv` is the TV emulation flag.
 */
export function tvLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}${TV_PATH}#${code}`;
}

/** What the TV writes for the phone to type: "turbo-gol.com/tv" (the link without scheme or hash). */
export function tvShortLink(origin: string): string {
  return origin.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '') + TV_PATH;
}

/** The /tv page (`location.pathname`). */
export function isTvPath(pathname: string): boolean {
  return pathname === TV_PATH || pathname === TV_PATH + '/';
}

/**
 * The code a /tv link carries: the hash's first word when it is a whole code in capitals (a flag
 * such as #webgpu is lower case), else null.
 */
export function tvHashCode(hash: string): string | null {
  const m = /^#?([A-Z0-9]{6})(?:&|$)/.exec(hash);
  if (m === null || m[1].length !== CODE_LENGTH || ![...m[1]].every((ch) => CODE_ALPHABET.includes(ch))) return null;
  return m[1];
}

/** The hash without its code (what else the link carried: flags). */
export function withoutTvCode(hash: string): string {
  if (tvHashCode(hash) === null) return hash;
  const rest = hash.replace(/^#?[A-Z0-9]{6}&?/, '');
  return rest.length > 0 ? '#' + rest : '';
}

/** m:ss until `until`, '0:00' past it (both on one clock: `now`'s). */
export function timeLeft(until: number, now: number): string {
  const s = Math.max(0, Math.ceil((until - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The phone's "a TV is waiting" marker (sessionStorage, JSON { at }: never the code, which is always
 * typed, A6) lasts this long: a sign-in on the phone, a provider's round trip, the confirm sheet,
 * and an account created with email while the TV renews its code (about 28 minutes).
 */
export const PENDING_MS = 30 * 60_000;

/** The longest life a TV counts down for one code (the server's is 4 minutes). */
export const CODE_LIFE_MAX_MS = 5 * 60_000;

/**
 * When a TV's code ends on the TV's own clock (`now`: performance.now()): its life from the start
 * answer (`ttlMs`), at most a code's life. Never the server's `expiresAt` against Date.now(): a TV
 * box's clock can be minutes off, and one ahead would end every code at once. The poll's
 * tv_code_expired stays the authority.
 */
export function tvDeadline(ttlMs: number, now: number): number {
  return now + Math.max(0, Math.min(Number.isFinite(ttlMs) ? ttlMs : CODE_LIFE_MAX_MS, CODE_LIFE_MAX_MS));
}


/**
 * Where the TV is, as the phone's sheet says it before CONFIRMAR: "Córdoba, AR · Telecom" (city,
 * country code, network), null when Cloudflare knew nothing of its start.
 */
export function tvPlace(where: TvInfoAnswer['where']): string | null {
  if (where === null) return null;
  const known = (s: string | null): s is string => typeof s === 'string' && s.length > 0;
  const place = [where.city, where.country].filter(known).join(', ');
  const parts = [place, where.org].filter(known);
  // The sentence ends it: a network named "… S.A." loses its own last dot.
  return parts.length > 0 ? parts.join(' · ').replace(/[.]+$/, '') : null;
}

/** A live marker ({ at } within PENDING_MS): a TV waits for this phone's sign-in. A marker of before (it held the code) counts too, its code never read. */
export function pendingMarker(raw: string | null, now: number): boolean {
  if (raw === null) return false;
  try {
    const v = JSON.parse(raw) as { at?: unknown };
    return typeof v.at === 'number' && now - v.at <= PENDING_MS && now >= v.at;
  } catch {
    return false;
  }
}

/** What the phone's /tv continuation needs (tvSignIn.ts installTvLink wires the menus and the account in). */
export interface TvContinuationDeps {
  /** The arbiter's turn (Game.ts urlSheets): the OAuth result and its confirm sheet go first. */
  turn: () => Promise<void>;
  /** The menus are up and no sheet is (a join link's, an anti-bot one). */
  ready: () => Promise<void>;
  signedIn: () => boolean;
  /** The account from the refresh cookie, when the page has not restored it yet. */
  restore: () => Promise<unknown>;
  /** Signed in: the code entry (typed, never the link's). */
  codeEntry: () => void;
  /** Signed out: "sign in first"; `dropped` when it closes without a sign-in (CANCELAR, Back). */
  signInFirst: (dropped: () => void) => void;
  /** Every account change (a sign-in on PERFIL, the confirm sheet's CREAR, a provider's round trip). */
  subscribe: (fn: () => void) => void;
}

/**
 * The phone's /tv continuation, in order and once (the design's §3.11 step 3): after the steps
 * before it (the arbiter), signed in → the code entry; signed out → "sign in first", and the next
 * sign-in, however it happens, → the code entry. An account change while the steps before it run
 * (the confirm sheet creating the account) starts nothing: the turn brings the code entry.
 */
export function tvContinuation(d: TvContinuationDeps): void {
  let waiting = false;
  const run = async (): Promise<void> => {
    await d.turn();
    await d.ready();
    if (!d.signedIn()) await d.restore().catch(() => null);
    if (!d.signedIn()) {
      waiting = true;
      d.signInFirst(() => {
        waiting = false;
      });
      return;
    }
    waiting = false;
    d.codeEntry();
  };
  d.subscribe(() => {
    if (!waiting || !d.signedIn()) return;
    waiting = false;
    void run();
  });
  void run();
}

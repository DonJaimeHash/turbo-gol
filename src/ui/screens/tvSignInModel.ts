/**
 * The pure part of the TV's sign-in with the phone (screens/tvSignIn.ts; tests/tv-signin.test.mjs):
 * the /tv page's link and how its code rides in the hash, the countdown, the code kept across a
 * sign-in's round trip. No DOM.
 */
import { CODE_ALPHABET, CODE_LENGTH } from './lobbyModel';

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

/** m:ss until `expiresAt` (epoch ms), '0:00' past it. */
export function timeLeft(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A code kept for after a sign-in (sessionStorage, JSON { code, at }) lasts this long, a TV code's life. */
export const PENDING_MS = 5 * 60_000;

/** The kept code ('' = the page was open without one), null when there is none or it is stale. */
export function pendingCode(raw: string | null, now: number): string | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { code?: unknown; at?: unknown };
    if (typeof v.code !== 'string' || typeof v.at !== 'number' || now - v.at > PENDING_MS || now < v.at) return null;
    return v.code === '' || tvHashCode(v.code) !== null ? v.code : null;
  } catch {
    return null;
  }
}

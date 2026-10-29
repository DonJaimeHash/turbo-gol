/**
 * The TV's sign-in with the phone (the device-code pattern), the AccountsDO's table of short-lived
 * codes. Kept in memory: a code lives 5 minutes at most and the one AccountsDO is global, so a
 * restart only drops codes a TV then asks for again (NUEVO CÓDIGO). Pure apart from the injected
 * random source; the AccountsDO passes its clock (tests/tv-signin.test.mjs).
 *
 *   start(ip, secretHash, now)                  a TV without a session: a code of the lobby alphabet,
 *                                               bound to the SHA-256 of the device secret the Worker
 *                                               made (the secret itself never reaches the object)
 *   confirm(code, user, ip, now)                the phone's account: binds the code once
 *   poll(code, secretHash, now)                 the TV: pending, expired (a wrong secret too), or the
 *                                               account it was approved for (then wiped: one use)
 *
 * Limits: TV_CODES_PER_IP live codes per IP (a new one replaces the oldest: a TV asking for NUEVO
 * CÓDIGO again and again; the Worker's rate limit bounds how often), TV_CODES_MAX live codes in all
 * (then a start is refused); TV_CONFIRM_FAILS failed confirms (a wrong, expired or used code) per
 * account and TV_CONFIRM_IP_FAILS per IP within TV_FAIL_WINDOW_MS, then every confirm is refused
 * until the window ends (an IP is often shared: a phone carrier's, a school's). An IPv6 address
 * counts by its /64 (ipKey: one subscriber's network), so a block of addresses is one IP. A used
 * code stays as a tombstone (no secret, no account), and an expired one TV_KEEP_MS longer, so a
 * replay says "used" and a late phone "expired", not "wrong"; those rows go on every call, at most
 * every SWEEP_EVERY_MS, and on the object's alarm, and past TV_ROWS_MAX the oldest go first.
 *
 * The codes live in memory: an eviction or a deploy drops them. For a code's life after the object
 * woke (`wokeAt`), a code it does not know may be one it lost, so it is "expired", not "wrong". A
 * wrong device secret answers as an unknown code does, so a poll never tells a live code apart.
 */

/** The lobby code alphabet (LobbyDirectoryDO.ts CODE_ALPHABET: no I, O, 0 or 1) and its length. */
export const TV_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const TV_CODE_LENGTH = 6;
export const TV_CODE_TTL_MS = 5 * 60_000;
export const TV_POLL_MS = 3_000;
/** How long an expired or used code is still known (to say so) before it goes. */
export const TV_KEEP_MS = 5 * 60_000;
export const TV_CODES_PER_IP = 5;
export const TV_CODES_MAX = 2_000;
/** Rows kept in all (live codes and the tombstones of expired or used ones). */
export const TV_ROWS_MAX = 2 * TV_CODES_MAX;
export const TV_CONFIRM_FAILS = 10;
export const TV_CONFIRM_IP_FAILS = 50;
export const TV_FAIL_WINDOW_MS = 15 * 60_000;
const SWEEP_EVERY_MS = 10_000;

export interface TvUser {
  userId: string;
  username: string;
}

interface TvEntry {
  /** SHA-256 hex of the device secret; '' once used. */
  secretHash: string;
  ip: string;
  expiresAt: number;
  user: TvUser | null;
  used: boolean;
}

interface TvFails {
  count: number;
  first: number;
}

export type TvStart = { code: string; expiresAt: number } | 'full';
export type TvConfirm = 'ok' | 'wrong' | 'expired' | 'used' | { throttled: number };
export type TvPoll = 'pending' | 'expired' | 'used' | TvUser;

/** Equal hex strings, in time that does not depend on where they differ. */
export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** A code as typed or linked: capitals, the alphabet only; null when it is not a whole one. */
export function tvCode(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 16) return null;
  const c = v.toUpperCase().replace(/[\s-]/g, '');
  return c.length === TV_CODE_LENGTH && [...c].every((ch) => TV_CODE_ALPHABET.includes(ch)) ? c : null;
}

/**
 * The key an IP counts under: an IPv4 address as it is, an IPv6 address by its /64 (its first four
 * groups written out: "2001:db8:0:0"), so the addresses of one network count as one.
 */
export function ipKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.toLowerCase().split('%')[0].split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = tail === undefined ? left : [...left, ...new Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':');
}

export class TvCodes {
  private readonly codes = new Map<string, TvEntry>();
  private readonly fails = new Map<string, TvFails>();
  private sweptAt = -Infinity;
  /** When the object woke (its first call): codes from before may have been lost. */
  wokeAt: number | null = null;
  private readonly random: (n: number) => Uint8Array;

  constructor(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))) {
    this.random = random;
  }

  get size(): number {
    return this.codes.size;
  }

  start(ip: string, secretHash: string, now: number): TvStart {
    this.sweep(now);
    ip = ipKey(ip);
    const live = [...this.codes].filter(([, e]) => !e.used && e.expiresAt > now);
    const mine = live.filter(([, e]) => e.ip === ip);
    if (mine.length >= TV_CODES_PER_IP) this.codes.delete(mine[0][0]); // insertion order: the oldest
    else if (live.length >= TV_CODES_MAX) return 'full';
    // Past the rows' cap the oldest tombstones go (a late phone then hears "wrong"): only live codes fill it.
    for (const [k, e] of this.codes) {
      if (this.codes.size < TV_ROWS_MAX) break;
      if (e.used || e.expiresAt <= now) this.codes.delete(k);
    }
    if (this.codes.size >= TV_ROWS_MAX) return 'full';
    let code = '';
    do {
      const b = this.random(TV_CODE_LENGTH);
      code = '';
      for (let i = 0; i < TV_CODE_LENGTH; i++) code += TV_CODE_ALPHABET[b[i] & 31]; // 32 letters: uniform
    } while (this.codes.has(code));
    const expiresAt = now + TV_CODE_TTL_MS;
    this.codes.set(code, { secretHash, ip, expiresAt, user: null, used: false });
    return { code, expiresAt };
  }

  /** The failure counters of a confirm by `user` from `ip`. */
  private failKeys(userId: string, ip: string): string[] {
    return ['u:' + userId, 'ip:' + ipKey(ip)];
  }

  /** ms until `keys` may confirm again; 0 = now. */
  private throttled(keys: readonly string[], now: number): number {
    let wait = 0;
    for (const k of keys) {
      const f = this.fails.get(k);
      if (f === undefined) continue;
      if (now - f.first >= TV_FAIL_WINDOW_MS) this.fails.delete(k);
      else if (f.count >= (k.startsWith('ip:') ? TV_CONFIRM_IP_FAILS : TV_CONFIRM_FAILS)) wait = Math.max(wait, f.first + TV_FAIL_WINDOW_MS - now);
    }
    return wait;
  }

  private fail(keys: readonly string[], now: number): void {
    for (const k of keys) {
      const f = this.fails.get(k);
      if (f === undefined || now - f.first >= TV_FAIL_WINDOW_MS) this.fails.set(k, { count: 1, first: now });
      else f.count++;
    }
  }

  confirm(code: string, user: TvUser, ip: string, now: number): TvConfirm {
    this.sweep(now);
    const keys = this.failKeys(user.userId, ip);
    const wait = this.throttled(keys, now);
    if (wait > 0) return { throttled: wait };
    const e = this.codes.get(code);
    const out: TvConfirm = e === undefined ? (this.mayHaveLost(now) ? 'expired' : 'wrong') : e.used || e.user !== null ? 'used' : e.expiresAt <= now ? 'expired' : 'ok';
    if (out !== 'ok') {
      this.fail(keys, now);
      return out;
    }
    (e as TvEntry).user = { userId: user.userId, username: user.username };
    return 'ok';
  }

  poll(code: string, secretHash: string, now: number): TvPoll {
    this.sweep(now);
    const e = this.codes.get(code);
    if (e === undefined || (e.expiresAt <= now && !e.used)) return 'expired';
    if (e.used) return 'used';
    if (!sameHex(e.secretHash, secretHash)) return 'expired'; // as an unknown code: nothing tells a live one
    if (e.user === null) return 'pending';
    const user = e.user;
    e.user = null;
    e.secretHash = '';
    e.used = true;
    return user;
  }

  /** A code this object does not know may be one it lost: it woke less than a code's life ago. */
  private mayHaveLost(now: number): boolean {
    return this.wokeAt !== null && now - this.wokeAt < TV_CODE_TTL_MS;
  }

  /** Drop the codes past their keep and the finished failure windows (`force`: now, the alarm). */
  sweep(now: number, force = false): void {
    if (this.wokeAt === null) this.wokeAt = now;
    if (!force && now - this.sweptAt < SWEEP_EVERY_MS) return;
    this.sweptAt = now;
    for (const [k, e] of this.codes) if (e.expiresAt + TV_KEEP_MS <= now) this.codes.delete(k);
    for (const [k, f] of this.fails) if (now - f.first >= TV_FAIL_WINDOW_MS) this.fails.delete(k);
  }
}

/**
 * The TV's sign-in with the phone (the device-code pattern), the AccountsDO's table of short-lived
 * codes. Kept in memory: a code lives 5 minutes at most and the one AccountsDO is global, so a
 * restart only drops codes a TV then asks for again (NUEVO CÓDIGO). Pure apart from the injected
 * random source; the AccountsDO passes its clock (tests/tv-signin.test.mjs).
 *
 *   start(ip, secretHash, now, where?)          a TV without a session: a code of the lobby alphabet,
 *                                               bound to the SHA-256 of the device secret the Worker
 *                                               made (the secret itself never reaches the object) and
 *                                               to where the TV is (request.cf: country, city, network)
 *   info(code, user, ip, now, phone?)           the phone, before it confirms: where that TV is, and
 *                                               whether it is on the phone's network or in its country
 *                                               (counted as a confirm: a wrong code is a failure)
 *   confirm(code, user, ip, now)                the phone's account: binds the code once
 *   poll(code, secretHash, now)                 the TV: pending, expired (a wrong secret too), or the
 *                                               account it was approved for (then wiped: one use)
 *
 * Limits: TV_CODES_PER_IP live codes per IPv6 /64 and TV_CODES_PER_IPV4 per IPv4 address (a new one
 * replaces the oldest: a TV asking for NUEVO CÓDIGO again and again; an IPv4 address may be a
 * carrier's, shared by many homes, hence more), TV_CODES_PER_48 per IPv6 /48 and TV_CODES_PER_24 per
 * IPv4 /24 (then a start from there is refused, 'busy': one free /48 holds 65,536 /64s and once
 * filled the whole table), TV_CODES_MAX live codes in all (then a start is refused). The Worker
 * asks a Turnstile token first, so each code costs a solved check. An unclaimed code lives
 * TV_CODE_TTL_MS; a confirmed one at least TV_POLL_GRACE_MS more, for the TV's next poll.
 * TV_CONFIRM_FAILS failed confirms (a wrong, expired or used code) per
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
/** An unclaimed code's life: long enough to reach the phone, sign in on it and type the code. */
export const TV_CODE_TTL_MS = 4 * 60_000;
export const TV_POLL_MS = 3_000;
/** A confirmed code lives at least this much longer: the TV's next poll takes it. */
export const TV_POLL_GRACE_MS = 30_000;
/** How long an expired or used code is still known (to say so) before it goes. */
export const TV_KEEP_MS = 5 * 60_000;
/** Live codes per IPv6 /64 (one subscriber's network). */
export const TV_CODES_PER_IP = 5;
/** Live codes per IPv4 address: a carrier's NAT puts many homes behind one. */
export const TV_CODES_PER_IPV4 = 20;
/** Live codes per IPv6 /48 (one site, or one free tunnel-broker allocation) and per IPv4 /24. */
export const TV_CODES_PER_48 = 20;
export const TV_CODES_PER_24 = 100;
/** Live codes in all: an entry is a couple of hundred bytes. */
export const TV_CODES_MAX = 20_000;
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

/** Where a request comes from (request.cf), coarse: the phone shows the TV's before it confirms. */
export interface TvWhere {
  country: string | null;
  city: string | null;
  /** The network: its number and its name (Cloudflare's asOrganization). */
  asn: number | null;
  org: string | null;
}

interface TvEntry {
  /** SHA-256 hex of the device secret; '' once used. */
  secretHash: string;
  /** ipKey of the start: the IPv4 address or the IPv6 /64. */
  ip: string;
  /** wideKey of the start: the IPv4 /24 or the IPv6 /48 (null for an address that is neither). */
  wide: string | null;
  v6: boolean;
  expiresAt: number;
  createdAt: number;
  where: TvWhere | null;
  user: TvUser | null;
  used: boolean;
}

/** TvCodes.info: where the TV is, and how it relates to the phone asking. */
export interface TvInfo {
  where: TvWhere | null;
  /** The phone is on the TV's network (the same IPv4 address or IPv6 /64: a home's Wi-Fi). */
  sameNetwork: boolean;
  /** The phone is in the TV's country (false when either is unknown). */
  sameCountry: boolean;
  createdAt: number;
}

interface TvFails {
  count: number;
  first: number;
}

export type TvStart = { code: string; expiresAt: number } | 'full' | 'busy';
export type TvConfirm = 'ok' | 'wrong' | 'expired' | 'used' | { throttled: number };
export type TvAsk = TvInfo | 'wrong' | 'expired' | 'used' | { throttled: number };
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

/** The wider block an IP belongs to: an IPv4 address's /24 ("203.0.113"), an IPv6 address's /48 ("2001:db8:0"); null for anything else ('local'). */
export function wideKey(ip: string): string | null {
  if (ip.includes(':')) return ipKey(ip).split(':').slice(0, 3).join(':');
  const parts = ip.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p)) ? parts.slice(0, 3).join('.') : null;
}

export class TvCodes {
  private readonly codes = new Map<string, TvEntry>();
  /** The codes of each ipKey and of each wideKey, oldest first: a start counts its own blocks, not the table. */
  private readonly byIp = new Map<string, Set<string>>();
  private readonly byWide = new Map<string, Set<string>>();
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

  /** The live (unused, unexpired) codes of an index's set, oldest first. */
  private liveOf(set: Set<string> | undefined, now: number): string[] {
    const out: string[] = [];
    if (set === undefined) return out;
    for (const k of set) {
      const e = this.codes.get(k);
      if (e !== undefined && !e.used && e.expiresAt > now) out.push(k);
    }
    return out;
  }

  private drop(code: string): void {
    const e = this.codes.get(code);
    if (e === undefined) return;
    this.codes.delete(code);
    for (const [index, key] of [[this.byIp, 'ip:' + e.ip], [this.byWide, 'w:' + e.wide]] as const) {
      const set = index.get(key);
      set?.delete(code);
      if (set !== undefined && set.size === 0) index.delete(key);
    }
  }

  /**
   * The live codes in all, counted at most every SWEEP_EVERY_MS and moved by each start in between
   * (an overcount until the next count: expiries and uses only lower it). Asked only once the table
   * holds as many rows as the cap, so a start stays cheap however big the table is.
   */
  private liveCount = 0;
  private liveCountAt = -Infinity;

  private liveTotal(now: number): number {
    if (now - this.liveCountAt >= SWEEP_EVERY_MS) {
      let n = 0;
      for (const e of this.codes.values()) if (!e.used && e.expiresAt > now) n++;
      this.liveCount = n;
      this.liveCountAt = now;
    }
    return this.liveCount;
  }

  start(rawIp: string, secretHash: string, now: number, where: TvWhere | null = null): TvStart {
    this.sweep(now);
    const ip = ipKey(rawIp);
    const v6 = rawIp.includes(':');
    const wide = wideKey(rawIp);
    const mine = this.liveOf(this.byIp.get('ip:' + ip), now);
    if (mine.length >= (v6 ? TV_CODES_PER_IP : TV_CODES_PER_IPV4)) {
      this.drop(mine[0]); // the oldest: one live code for another
      this.liveCount--;
    } else if (wide !== null && this.liveOf(this.byWide.get('w:' + wide), now).length >= (v6 ? TV_CODES_PER_48 : TV_CODES_PER_24)) return 'busy';
    // Only a table that holds as many rows as the cap can hold as many live codes: count them then.
    else if (this.codes.size >= TV_CODES_MAX && this.liveTotal(now) >= TV_CODES_MAX) return 'full';
    // Past the rows' cap the oldest tombstones go (a late phone then hears "wrong"): only live codes fill it.
    for (const [k, e] of this.codes) {
      if (this.codes.size < TV_ROWS_MAX) break;
      if (e.used || e.expiresAt <= now) this.drop(k);
    }
    if (this.codes.size >= TV_ROWS_MAX) return 'full';
    let code = '';
    do {
      const b = this.random(TV_CODE_LENGTH);
      code = '';
      for (let i = 0; i < TV_CODE_LENGTH; i++) code += TV_CODE_ALPHABET[b[i] & 31]; // 32 letters: uniform
    } while (this.codes.has(code));
    const expiresAt = now + TV_CODE_TTL_MS;
    this.codes.set(code, { secretHash, ip, wide, v6, expiresAt, createdAt: now, where, user: null, used: false });
    this.liveCount++;
    for (const [index, key] of [[this.byIp, 'ip:' + ip], [this.byWide, 'w:' + wide]] as const) {
      let set = index.get(key);
      if (set === undefined) index.set(key, (set = new Set()));
      set.add(code);
    }
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

  /** The live, unbound entry of `code` for a phone, or why not (a failure counted, as a confirm's). */
  private ask(code: string, user: TvUser, ip: string, now: number): TvEntry | 'wrong' | 'expired' | 'used' | { throttled: number } {
    this.sweep(now);
    const keys = this.failKeys(user.userId, ip);
    const wait = this.throttled(keys, now);
    if (wait > 0) return { throttled: wait };
    const e = this.codes.get(code);
    const out = e === undefined ? (this.mayHaveLost(now) ? 'expired' : 'wrong') : e.used || e.user !== null ? 'used' : e.expiresAt <= now ? 'expired' : e;
    if (typeof out === 'string') this.fail(keys, now);
    return out;
  }

  /** Before the phone confirms: where the TV showing `code` is, beside the phone's own place. */
  info(code: string, user: TvUser, ip: string, now: number, phone: TvWhere | null = null): TvAsk {
    const e = this.ask(code, user, ip, now);
    if (typeof e === 'string' || 'throttled' in e) return e;
    const country = e.where?.country ?? null;
    return { where: e.where, sameNetwork: e.ip === ipKey(ip), sameCountry: country !== null && country === (phone?.country ?? null), createdAt: e.createdAt };
  }

  confirm(code: string, user: TvUser, ip: string, now: number): TvConfirm {
    const e = this.ask(code, user, ip, now);
    if (typeof e === 'string' || 'throttled' in e) return e;
    e.user = { userId: user.userId, username: user.username };
    e.expiresAt = Math.max(e.expiresAt, now + TV_POLL_GRACE_MS); // the TV's next poll takes it
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
    this.liveCount--; // a tombstone now
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
    for (const [k, e] of this.codes) if (e.expiresAt + TV_KEEP_MS <= now) this.drop(k);
    for (const [k, f] of this.fails) if (now - f.first >= TV_FAIL_WINDOW_MS) this.fails.delete(k);
  }
}

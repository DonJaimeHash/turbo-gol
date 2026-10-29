/**
 * Every rate limit of the Worker, in one table (LIMITS below), and the two counters behind it.
 *
 * The counters
 *   in-isolate  a fixed one-minute window per key in this isolate's memory (isolateLimited): the
 *               cheap pre-filter. It costs nothing and stops a flood that lands on one isolate, but
 *               each isolate (and each Cloudflare location) counts on its own.
 *   edge        a Workers Rate Limiting binding (wrangler.jsonc `ratelimits`, named after its limit
 *               per 60 s: RL_10 ... RL_1200). Counted per Cloudflare location across every isolate
 *               there, approximate and eventually consistent (Cloudflare's docs: a burst may pass
 *               a little over). Under `wrangler dev` miniflare simulates it exactly (a fixed window
 *               on the wall clock). A Worker without the binding (tests, a fork) keeps the
 *               in-isolate count only, and a binding that throws lets the request through: a
 *               broken counter must never stop play.
 *
 * Who a limit counts (the rule's `by`)
 *   session   the Bearer session's id: a guest's or an account's. One person.
 *   account   an account session's id; a guest or anonymous caller is not counted by it.
 *   network   the client address (CF-Connecting-IP): an IPv4 address as it is, an IPv6 one by its
 *             /64 (env.ts limitKey). Both name a whole network: a school or an ISP's CGNAT shares
 *             one IPv4 address, and a school LAN shares one IPv6 /64. So a per-network limit is
 *             set for a few hundred players behind it (1,200 a minute on the frequent routes,
 *             120 on the rare ones: signing in, creating a guest), and a route a person calls
 *             often is counted per session or account first.
 *
 * LIMITS (per minute; `edge` is the binding, i.e. the same count across the location's isolates)
 *
 *   route                               rule             by       isolate  edge     why
 *   POST /api/guest                     guest            network      120  RL_120   every guest can queue and open rooms (Turnstile is the gate)
 *   POST /api/queue                     queue            session       20  RL_60    a long poll of 25 s: ~3 a minute in play; checked before the KV flags
 *   POST /api/rejoin                    rejoin           session       10  RL_60    each one mints a ticket; a reconnecting client asks a few times
 *                                       rejoinNet        network     1200  RL_1200
 *   POST /api/leave                     leave            session       30  RL_60    the menu's BACK and every match's end
 *                                       leaveNet         network     1200  RL_1200
 *   POST /api/lobbies                   lobbyCreate      session        5  RL_10    a LobbyDO and a directory code each
 *                                       lobbyCreateNet   network     1200  RL_1200
 *   POST /api/lobbies/join              lobbyJoin        session       20  RL_60    a password guess each
 *                                       lobbyJoinNet     network     1200  RL_1200
 *   GET  /api/lobbies, /api/lobbies/peek lobbyList       network     1200  -        served from a 3 s cache per isolate
 *   GET  /api/population                population       network     1200  -        cached 5 s per isolate; every menu asks every 10 s
 *   POST /api/auth/logout               logout           network     1200  RL_1200  no session: the cookie is the only key (one AccountsDO call)
 *   POST /api/auth/refresh              refresh          network     1200  RL_1200  every page load and every hour of an account
 *   POST /api/auth/login                login            network      120  RL_120   two AccountsDO calls and a PBKDF2 each
 *   POST /api/auth/register             register         network      120  RL_120
 *   POST /api/auth/recover              recover          network      120  RL_120
 *   GET  /api/auth/oauth/<p>/start      oauthStart       network      120  RL_120
 *   GET  /api/auth/oauth/<p>/callback   oauthCallback    network      120  RL_120   a token request to Google or Discord each (its state is
 *                                                                                    single-use too: firstUse)
 *   POST /api/auth/password             password         account       10  RL_10    a PBKDF2 and an AccountsDO write
 *   POST /api/auth/recovery-codes       recoveryCodes    account       10  RL_10    an AccountsDO write
 *   GET  /api/me                        me               account       60  RL_60    one AccountsDO call each
 *                                       meNet            network     1200  RL_1200
 *   GET  /api/ranked/result             rankedResult     account       60  RL_60    polled every 1-3 s for two minutes after a ranked match
 *                                       rankedResultNet  network     1200  RL_1200
 *   GET  /api/leaderboard               leaderboardYou   account       60  RL_60    the account's own row: one AccountsDO call (cached 15 s)
 *                                       leaderboardNet   network     1200  RL_1200  the board itself is cached 30 s per isolate
 *   GET|HEAD /nodes/releases/*          nodeReleases     network     1200  RL_1200  installers and launchers; versioned files from the edge cache
 *
 * Limits kept where they are (in-isolate only, per minute unless stated; the object ones hold
 * across isolates because there is one object):
 *   accountRoutes.ts   register 5, login 30, refresh 60, recover 10, oauth start 20 per raw address;
 *                      rename 5, training 20, experimental 30 writes / 60 reads, items and shop 60
 *                      reads, car and claim 30 writes per account; TV start 10, poll 60, confirm 30
 *                      per /64 (tvCodes.ts ipKey), plus tvCodes' own live-code and failed-confirm caps
 *   AccountsDO         the sign-in lockouts per username and address (accountStore.ts)
 *   nodeRoutes.ts      register 5 an hour per /64, replays 60 PUT and 60 GET, status 60 per /64,
 *                      mine 30 and admin 30 per account, tokens 10 a day per account
 *   NodeRegistryDO     register 5 an hour per /64, tokens 10 a day per account
 *
 * A 429 is error 429 'rate_limited' everywhere. The Cloudflare zone may add a WAF rate-limiting
 * rule in front of all this (server/README.md, "Rate limits").
 */
import { limitKey } from './env';
import type { SessionClaims } from './auth';

/** The Workers Rate Limiting bindings (wrangler.jsonc `ratelimits`): each is `limit` per `period` seconds. */
export const EDGE_BINDINGS = {
  RL_10: { limit: 10, period: 60 },
  RL_30: { limit: 30, period: 60 },
  RL_60: { limit: 60, period: 60 },
  RL_120: { limit: 120, period: 60 },
  RL_1200: { limit: 1200, period: 60 },
} as const;
export type EdgeBinding = keyof typeof EDGE_BINDINGS;

export type LimitSubject = 'session' | 'account' | 'network' | 'wide';

export interface LimitRule {
  by: LimitSubject;
  /** Per isolate and minute: the pre-filter. */
  isolate: number;
  /** The binding that counts it across the location's isolates; absent: in-isolate only. */
  edge?: EdgeBinding;
}

/** The table of the header comment, as the code reads it. */
export const LIMITS = {
  guest: { by: 'network', isolate: 120, edge: 'RL_120' },
  queue: { by: 'session', isolate: 20, edge: 'RL_60' },
  rejoin: { by: 'session', isolate: 10, edge: 'RL_60' },
  rejoinNet: { by: 'network', isolate: 1200, edge: 'RL_1200' },
  leave: { by: 'session', isolate: 30, edge: 'RL_60' },
  leaveNet: { by: 'network', isolate: 1200, edge: 'RL_1200' },
  lobbyCreate: { by: 'session', isolate: 5, edge: 'RL_10' },
  lobbyCreateNet: { by: 'network', isolate: 1200, edge: 'RL_1200' },
  lobbyJoin: { by: 'session', isolate: 20, edge: 'RL_60' },
  lobbyJoinNet: { by: 'network', isolate: 1200, edge: 'RL_1200' },
  lobbyList: { by: 'network', isolate: 1200 },
  population: { by: 'network', isolate: 1200 },
  logout: { by: 'network', isolate: 1200, edge: 'RL_1200' },
  refresh: { by: 'network', isolate: 1200, edge: 'RL_1200' },
  login: { by: 'network', isolate: 120, edge: 'RL_120' },
  register: { by: 'network', isolate: 120, edge: 'RL_120' },
  recover: { by: 'network', isolate: 120, edge: 'RL_120' },
  oauthStart: { by: 'network', isolate: 120, edge: 'RL_120' },
  oauthCallback: { by: 'network', isolate: 120, edge: 'RL_120' },
  password: { by: 'account', isolate: 10, edge: 'RL_10' },
  recoveryCodes: { by: 'account', isolate: 10, edge: 'RL_10' },
  me: { by: 'account', isolate: 60, edge: 'RL_60' },
  meNet: { by: 'network', isolate: 1200, edge: 'RL_1200' },
  rankedResult: { by: 'account', isolate: 60, edge: 'RL_60' },
  rankedResultNet: { by: 'network', isolate: 1200, edge: 'RL_1200' },
  leaderboardYou: { by: 'account', isolate: 60, edge: 'RL_60' },
  leaderboardNet: { by: 'network', isolate: 1200, edge: 'RL_1200' },
  nodeReleases: { by: 'network', isolate: 1200, edge: 'RL_1200' },
} as const satisfies Record<string, LimitRule>;
export type LimitName = keyof typeof LIMITS;

/**
 * The account routes' rules (accountRoutes.ts), checked by index.ts before the route runs so the
 * single AccountsDO is never asked for a request over its limit. [] for every other route.
 */
export function accountGate(method: string, path: string): readonly LimitName[] {
  if (method === 'POST') {
    switch (path) {
      case '/api/auth/logout':
        return ['logout'];
      case '/api/auth/refresh':
        return ['refresh'];
      case '/api/auth/login':
        return ['login'];
      case '/api/auth/register':
        return ['register'];
      case '/api/auth/recover':
        return ['recover'];
      case '/api/auth/password':
        return ['password'];
      case '/api/auth/recovery-codes':
        return ['recoveryCodes'];
    }
    return [];
  }
  if (method !== 'GET') return [];
  if (path === '/api/me') return ['me', 'meNet'];
  if (path === '/api/ranked/result') return ['rankedResult', 'rankedResultNet'];
  if (path === '/api/leaderboard') return ['leaderboardYou', 'leaderboardNet'];
  const o = /^\/api\/auth\/oauth\/(?:google|discord)\/(start|callback)$/.exec(path);
  if (o) return [o[1] === 'start' ? 'oauthStart' : 'oauthCallback'];
  return [];
}

// ---- who a limit counts ---------------------------------------------------------------------------

/** The eight groups of an IPv6 address (lower case, no zone), or null when it is not one. */
function ipv6Groups(ip: string): string[] | null {
  if (!ip.includes(':') || ip.includes('.')) return null;
  const [head, tail] = ip.toLowerCase().split('%')[0].split('::', 2);
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const groups = tail === undefined ? front : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back];
  return groups.map((g) => g.replace(/^0+(?=.)/, ''));
}

/** The wide prefix of an address: IPv6 by its /48, IPv4 by its /24 ('local' and the like as they are). */
export function widePrefix(ip: string): string {
  const v6 = ipv6Groups(ip);
  if (v6) return v6.slice(0, 3).join(':') + '::/48';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip.replace(/^::ffff:/i, ''));
  return v4 ? `${v4[1]}.${v4[2]}.${v4[3]}.0/24` : ip;
}

/** What each kind of rule counts for one request (null: the rule does not apply to it). */
export interface Subjects {
  network: string;
  wide: string;
  session: string | null;
  account: string | null;
}

/** Cloudflare sets CF-Connecting-IP at the edge (clients cannot forge it); wrangler dev sets it too. */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'local';
}

export function subjectsOf(ip: string, session: SessionClaims | null): Subjects {
  return { network: limitKey(ip), wide: widePrefix(ip), session: session?.sub ?? null, account: session?.acct === 1 ? session.sub : null };
}

// ---- the counters ----------------------------------------------------------------------------------

const ISOLATE_WINDOW_MS = 60_000;
/** Windows kept at most; past it the oldest goes (anyone can bring new keys). */
const ISOLATE_KEYS_MAX = 50_000;
const isolateWindows = new Map<string, { n: number; resetAt: number }>();
let isolateCalls = 0;

/** Fixed-window counter in this isolate: true when `key` was hit more than `max` times in its current window of `windowMs`. */
export function isolateLimited(key: string, max: number, now: number = Date.now(), windowMs: number = ISOLATE_WINDOW_MS): boolean {
  if (++isolateCalls % 256 === 0) for (const [k, v] of isolateWindows) if (v.resetAt <= now) isolateWindows.delete(k);
  const e = isolateWindows.get(key);
  if (!e || e.resetAt <= now) {
    isolateWindows.delete(key);
    if (isolateWindows.size >= ISOLATE_KEYS_MAX) isolateWindows.delete(isolateWindows.keys().next().value as string);
    isolateWindows.set(key, { n: 1, resetAt: now + windowMs });
    return false;
  }
  return ++e.n > max;
}

/** True when the request is over the rule's limit for `subject`; a null subject is never limited. */
export type Limiter = (name: LimitName, subject: string | null) => Promise<boolean>;

let lastBindingWarn = 0;

/** The limiter of one request: the in-isolate pre-filter, then the rule's binding when the Worker has it. */
export function limiter(env: Partial<Record<EdgeBinding, RateLimit>>): Limiter {
  return async (name, subject) => {
    if (subject === null) return false;
    const rule: LimitRule = LIMITS[name];
    const key = name + ':' + subject;
    if (isolateLimited(key, rule.isolate)) return true;
    const binding = rule.edge ? env[rule.edge] : undefined;
    if (!binding) return false;
    try {
      return !(await binding.limit({ key })).success;
    } catch (e) {
      const now = Date.now();
      if (now - lastBindingWarn >= 60_000) {
        lastBindingWarn = now;
        console.warn(`rate limit binding ${rule.edge} failed, letting the request through: ${String(e)}`);
      }
      return false;
    }
  };
}

/** The first of `names` the request is over (each counted by its own `by`), or null. */
export async function overLimit(limit: Limiter, names: readonly LimitName[], s: Subjects): Promise<LimitName | null> {
  for (const n of names) if (await limit(n, s[LIMITS[n].by])) return n;
  return null;
}


// ---- single use ------------------------------------------------------------------------------------

const USED_MAX = 20_000;
const used = new Map<string, number>();

/** The Cache API's default cache (per Cloudflare location), or null where there is none (node tests). */
export function edgeCache(): Cache | null {
  const c = (globalThis as { caches?: { default?: Cache } }).caches;
  return c?.default ?? null;
}

/**
 * True the first time `scope`/`id` is seen within `ttlMs`, false for a replay. Exact in this
 * isolate (memory); across the isolates of one Cloudflare location through the Cache API, a marker
 * under `origin` (best effort: two copies that arrive together may both pass). The OAuth state's
 * nonce: one state cookie is good for one token request to the provider.
 */
export async function firstUse(scope: string, id: string, ttlMs: number, origin: string | null, now: number = Date.now()): Promise<boolean> {
  const key = scope + ':' + id;
  const exp = used.get(key);
  if (exp !== undefined && exp > now) return false;
  if (used.size >= USED_MAX) {
    for (const [k, v] of used) if (v <= now) used.delete(k);
    if (used.size >= USED_MAX) used.delete(used.keys().next().value as string);
  }
  used.set(key, now + ttlMs);
  const cache = edgeCache();
  if (cache && origin) {
    const marker = `${origin}/api/_used/${encodeURIComponent(scope)}/${encodeURIComponent(id)}`;
    try {
      if (await cache.match(marker)) return false;
      await cache.put(marker, new Response('1', { headers: { 'cache-control': `max-age=${Math.max(1, Math.ceil(ttlMs / 1000))}` } }));
    } catch {
      /* the isolate's own memory still holds it */
    }
  }
  return true;
}

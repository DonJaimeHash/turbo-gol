// Security limits of the matchmaker (server/src/MatchmakerDO.ts) around the MatchDO slots (audit
// rt-3, cost-6): ranked keeps a share of every region's slots, guest-only matches stop at their
// share, a guest session plays one MatchDO match at a time across EVERY region (the guard, real
// MatchmakerDO 'guard:<n>' instances here) and an IPv6 /64 a few, and a guest's lobby match is 5
// minutes at most. A world of fakes: every MATCHMAKER name is a real MatchmakerDO on its own fake
// storage, MATCH and ROOM answer their internal routes. Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const DO_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
const WASM_STUB = 'data:text/javascript,export const createHostArena = () => { throw new Error("no wasm in this test"); };';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: DO_STUB, shortCircuit: true };
    if (specifier === './wasm' && context.parentURL !== undefined && context.parentURL.endsWith('/server/src/MatchDO.ts')) return { url: WASM_STUB, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND') {
        if (!/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
        if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
});

// The matchmakers' sweep timers (500 ms, re-armed while a queue is not empty) must never keep the test process alive.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = realSetTimeout(fn, ms, ...args);
  t.unref?.();
  return t;
};

const M = await import('../src/MatchmakerDO.ts');
const L = await import('../src/LobbyDO.ts');
const worker = (await import('../src/index.ts')).default;
const { INTERNAL_HEADER, internalSecret, createSession } = await import('../src/auth.ts');
const SECRET = 'mm-limits-test-secret';
// The numbers as this PR sets them (literal fallbacks: the same tests run against main's matchmaker, which has none of them).
const TRUST_MS = M.GUARD_TRUST_MS ?? 10_000;
const RANKED_RESERVED = M.RANKED_RESERVED_ROOMS ?? 5;
const GUEST_ROOMS = M.GUEST_ROOMS_MAX ?? 10;
const RealResponse = globalThis.Response;

class FakeStorage {
  constructor() {
    this.map = new Map();
    this.alarm = null;
  }
  async get(k) {
    return this.map.get(k);
  }
  async put(k, v) {
    this.map.set(k, structuredClone(v));
  }
  async delete(k) {
    return this.map.delete(k);
  }
  async deleteAll() {
    this.map.clear();
  }
  async list({ prefix }) {
    const out = new Map();
    for (const [k, v] of this.map) if (k.startsWith(prefix)) out.set(k, structuredClone(v));
    return out;
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(t) {
    this.alarm = t;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

const hex64 = () => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

/** Every MATCHMAKER name a real MatchmakerDO (regions and guard shards); MatchDOs that answer /internal/status from `alive`. */
async function makeWorld() {
  let t = 5_000_000;
  const alive = new Map(); // matchId -> false once ended (absent: alive)
  const created = [];
  const objs = new Map();
  const secret = await internalSecret(SECRET);
  const env = {
    JWT_SECRET: SECRET,
    MATCH_LENGTH_SECONDS: 300,
    REGION_OVERRIDE: '',
    MATCH: {
      newUniqueId: () => ({ toString: () => hex64() }),
      idFromString: (s) => s,
      get: (id) => ({
        fetch: async (url) => {
          const path = new URL(url).pathname;
          if (path === '/internal/create') {
            created.push(String(id));
            return new RealResponse('{"ok":true}');
          }
          if (path === '/internal/status') return alive.get(String(id)) === false ? new RealResponse('{"error":"no_match"}', { status: 404 }) : new RealResponse(JSON.stringify({ matchId: String(id), ended: false, reset: false }));
          return new RealResponse('{"ok":true}');
        },
      }),
    },
    ROOM: { newUniqueId: () => ({ toString: () => hex64() }), idFromString: (s) => s, get: () => ({ fetch: async () => new RealResponse('{"ok":true}') }) },
    MATCHMAKER: {
      idFromName: (n) => n,
      get: (name) => ({
        fetch: async (url, init) => {
          if (!objs.has(name)) {
            const mm = new M.MatchmakerDO({ storage: new FakeStorage(), blockConcurrencyWhile: (fn) => fn() }, env);
            await new Promise((r) => setTimeout(r, 0));
            mm.now = () => t;
            objs.set(name, mm);
          }
          return objs.get(name).fetch(new Request(url, init));
        },
      }),
    },
  };
  const call = async (region, path, body) => {
    const res = await env.MATCHMAKER.get('mm:' + region).fetch('https://matchmaker' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { [INTERNAL_HEADER]: secret, 'content-type': 'application/json', 'x-region': region },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const w = { env, call, alive, created, objs, advance: (ms) => (t += ms), time: () => t };
  /** A /join of `who` ({ id, guest?, ip? }) in `region`. */
  w.join = (region, who, kind = 'server', extra = {}) => call(region, '/join', { playerId: who.id, name: who.id, mode: '1v1', kind, ...(who.guest ? { guest: true, ip: who.ip ?? '198.51.100.1' } : {}), ...extra });
  /** A lone guest's bot match in `region`: queued, then filled with a bot after BOT_FILL_MS. */
  w.botMatch = async (region, who) => {
    let r = await w.join(region, who);
    assert.equal(r.json.status, 'waiting', JSON.stringify(r.json));
    w.advance(M.BOT_FILL_MS);
    r = await w.join(region, who);
    assert.equal(r.json.status, 'matched', `${region}: ${JSON.stringify(r.json)}`);
    return r.json.matchId;
  };
  return w;
}

const guest = (id, ip) => ({ id, guest: true, ...(ip ? { ip } : {}) });

// ---- the guard: one MatchDO match per guest session across the regions -------------------------------

test('a guest with a bot match in SA cannot hold another MatchDO match in NA: 409 active_match naming SA (server and p2p queues alike)', async () => {
  const w = await makeWorld();
  const g = guest('g1');
  const sa = await w.botMatch('SA', g);
  w.advance(TRUST_MS + 1);
  let r = await w.join('NA', g);
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'active_match');
  assert.equal(r.json.kind, 'server');
  assert.equal(r.json.matchId, sa);
  assert.equal(r.json.region, 'SA');
  r = await w.join('EU', g, 'p2p');
  assert.equal(r.status, 409, 'a P2P queue would fall back to a bot match: refused too');
  assert.equal(w.created.length, 1, 'one MatchDO only');
});

test('once the SA match is over (its MatchDO says so) the guest queues anywhere; accounts are never held by the guard', async () => {
  const w = await makeWorld();
  const g = guest('g2');
  const sa = await w.botMatch('SA', g);
  w.alive.set(sa, false); // shut down (its release may not have reached anything)
  w.advance(TRUST_MS + 1);
  assert.equal((await w.join('NA', g)).json.status, 'waiting');
  await w.call('NA', '/leave', { playerId: g.id }); // Esc in the queue
  const acct = { id: 'acct1' };
  await w.botMatch('SA', acct);
  await w.botMatch('NA', acct);
  assert.equal(w.created.length, 3);
});

test('two regions forming for the same guest at once: the guard lets one MatchDO through, the other formation drops it and its next join is told', async () => {
  const w = await makeWorld();
  const g = guest('g3');
  assert.equal((await w.join('SA', g)).json.status, 'waiting');
  assert.equal((await w.join('NA', g)).json.status, 'waiting', 'both queued before any match existed');
  w.advance(M.BOT_FILL_MS);
  const a = await w.join('SA', g);
  assert.equal(a.json.status, 'matched');
  const b = await w.join('NA', g);
  assert.notEqual(b.json.status, 'matched', `NA formed no second match (${JSON.stringify(b.json)})`);
  assert.equal(w.created.length, 1);
  const again = await w.join('NA', g);
  assert.equal(again.status, 409);
  assert.equal(again.json.region, 'SA');
});

test('an IPv6 /64 holds at most 3 guest matches across the regions (429 guest_limit); an IPv4 address shared by a school is never capped', async () => {
  const w = await makeWorld();
  for (let i = 0; i < 3; i++) await w.botMatch(['SA', 'NA', 'EU'][i], guest('home' + i, `2001:db8:5:6:${i}::1`));
  w.advance(TRUST_MS + 1);
  const r = await w.join('SA', guest('home3', '2001:db8:5:6:ffff::2'));
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'guest_limit');
  for (let i = 0; i < 8; i++) await w.botMatch('SA', guest('school' + i, '203.0.113.9'));
  assert.equal(w.created.length, 11);
});

// ---- the regional shares -----------------------------------------------------------------------------

test('casual matches stop at MAX_ACTIVE_ROOMS - RANKED_RESERVED_ROOMS; ranked still forms in the slots kept for it', async () => {
  const w = await makeWorld();
  const casual = M.MAX_ACTIVE_ROOMS - RANKED_RESERVED;
  for (let i = 0; i < casual; i++) {
    assert.equal((await w.join('SA', { id: 'a' + i })).json.status, 'waiting');
    assert.equal((await w.join('SA', { id: 'b' + i })).json.status, 'matched', `casual match ${i}`);
  }
  const full = await w.join('SA', { id: 'late' });
  assert.equal(full.status, 503);
  assert.equal(full.json.error, 'capacity');
  const ratings = { '1v1': { mu: 25, sigma: 8 } };
  assert.equal((await w.join('SA', { id: 'r1' }, 'ranked', { ratings })).json.status, 'waiting');
  assert.equal((await w.join('SA', { id: 'r2' }, 'ranked', { ratings })).json.status, 'matched', 'ranked has its own slots');
  assert.equal(w.created.length, casual + 1);
});

test('matches of guests only stop at GUEST_ROOMS_MAX in a region; an account casual match still forms', async () => {
  const w = await makeWorld();
  for (let i = 0; i < GUEST_ROOMS; i++) await w.botMatch('SA', guest('gg' + i));
  const r = await w.join('SA', guest('gg-late'));
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'capacity');
  assert.equal((await w.join('SA', { id: 'acct-a' })).json.status, 'waiting');
  assert.equal((await w.join('SA', { id: 'acct-b' })).json.status, 'matched', 'accounts are not held by the guests\' share');
});

// ---- lobbies --------------------------------------------------------------------------------------------

test('/custom: a MatchDO match with a guest in it is 300 s at most (400 guest_length for 600 or unlimited); accounts keep every length', async () => {
  const w = await makeWorld();
  const lone = (guestFlag, len) => w.call('SA', '/custom', { kind: 'server', mode: '1v1', members: [{ playerId: 'm' + len + guestFlag, name: 'Lu', team: 0, guest: guestFlag }], matchLengthSeconds: len });
  for (const len of [600, 0]) {
    const r = await lone(true, len);
    assert.equal(r.status, 400, `guest ${len}`);
    assert.equal(r.json.error, 'guest_length');
  }
  assert.equal((await lone(true, 300)).status, 200);
  assert.equal((await lone(false, 600)).status, 200);
  assert.equal((await lone(false, 0)).status, 200);
  assert.equal(M.GUEST_MAX_MATCH_SECONDS, L.GUEST_SERVER_MAX_SECONDS, 'the lobby says the same');
  // A P2P room with guests keeps any length (no MatchDO).
  const p2p = await w.call('SA', '/custom', { kind: 'p2p', mode: '1v1', members: [{ playerId: 'p1', name: 'A', team: 0, guest: true }, { playerId: 'p2', name: 'B', team: 1, guest: true }], matchLengthSeconds: 0 });
  assert.equal(p2p.status, 200);
});

test('/custom: a guest member with a MatchDO match in another region makes the start 409 member_busy', async () => {
  const w = await makeWorld();
  await w.botMatch('NA', guest('gm'));
  w.advance(TRUST_MS + 1);
  const r = await w.call('SA', '/custom', { kind: 'server', mode: '1v1', members: [{ playerId: 'gm', name: 'Gus', team: 0, guest: true }], matchLengthSeconds: 300 });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'member_busy');
});

test('the guard sweeps expired holds out of its storage', async () => {
  const w = await makeWorld();
  await w.botMatch('SA', guest('gs'));
  const shard = w.objs.get('guard:' + M.guardShard('p:gs'));
  assert.ok(shard.ctx.storage.map.has('g:p:gs'));
  assert.ok(shard.ctx.storage.alarm !== null, 'a sweep is armed');
  w.advance(2 * 60 * 60_000);
  await shard.alarm();
  assert.equal(shard.ctx.storage.map.has('g:p:gs'), false);
});

test('Worker /api/queue hands the matchmaker guest: true and the address for a guest session only', async () => {
  const calls = [];
  const env = {
    JWT_SECRET: SECRET,
    REGION_OVERRIDE: 'SA',
    FLAGS: { get: async () => null },
    MATCHMAKER: {
      idFromName: (n) => n,
      get: () => ({
        fetch: async (url, init) => {
          if (init && init.body) calls.push(JSON.parse(init.body));
          return new RealResponse(JSON.stringify({ status: 'matched', matchId: 'ab'.repeat(32), ticket: 't', wsUrl: '/ws/x' }));
        },
      }),
    },
  };
  const queue = async (token) =>
    worker.fetch(new Request('http://127.0.0.1:8787/api/queue', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'CF-Connecting-IP': '2001:db8::5' }, body: JSON.stringify({ mode: '1v1', kind: 'server' }) }), env);
  const { token } = await createSession(SECRET, '0123456789abcdef', 'Invitado');
  assert.equal((await queue(token)).status, 200);
  assert.equal(calls[0].guest, true);
  assert.equal(calls[0].ip, '2001:db8::5');
});

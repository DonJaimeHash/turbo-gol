// Plan PR 14 (TV: typing and signing in with the phone), the parts without a browser: mn-keypad's
// keys and typing (src/ui/components/keypad.ts), the /tv link and its code in the hash, the
// countdown and the code kept across a sign-in (src/ui/screens/tvSignInModel.ts), AccountClient's
// tv calls (the approved session adopted only on signInWith), Turnstile's interaction callbacks and
// NetClient's pre-warmed token (used once; a pre-warm that wants a click gives up quietly, the
// registration's own check asks the player). The server side: server/test/tv-signin.test.mjs.
// Run: node --test tests/tv-signin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND' && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
      throw err;
    }
  },
});

const K = await import('../src/ui/components/keypad.ts');
const M = await import('../src/ui/screens/tvSignInModel.ts');
const L = await import('../src/ui/screens/lobbyModel.ts');
const { AccountClient } = await import('../src/net/AccountClient.ts');
const { NetClient, WARM_MS } = await import('../src/net/NetClient.ts');
const { getToken } = await import('../src/net/Turnstile.ts');
const P = await import('../src/net/protocol.ts');

const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) });

test('keypad: A–Z / 0–9 and . - _ @ in rows of ten, the case; a code only its alphabet in rows of eight, no case or space', () => {
  const text = K.keypadRows('text');
  assert.deepEqual(text, ['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ.-_@', '1234567890']);
  assert.equal(K.keypadRows('text', true)[0], 'abcdefghij');
  assert.equal(K.keypadRows('text', true)[2], 'uvwxyz.-_@');
  const code = K.keypadRows('code');
  assert.equal(code.join(''), L.CODE_ALPHABET, 'the lobby alphabet, nothing else (no I, O, 0, 1)');
  assert.ok(code.every((r) => r.length === 8));
  assert.deepEqual(K.keypadActions('text'), ['case', 'delete', 'space', 'done']);
  assert.deepEqual(K.keypadActions('code'), ['delete', 'done']);
});

test('keypad: typing holds the field maxLength, a code its alphabet in capitals and six at most; ⌫, no leading space; dots for a password', () => {
  let v = '';
  for (const k of ['J', 'a', 'v', 'i']) v = K.keypadType(v, k, 'text', 16);
  assert.equal(v, 'Javi');
  assert.equal(K.keypadType('', 'space', 'text', 16), '', 'no leading space');
  assert.equal(K.keypadType('Javi', 'space', 'text', 16), 'Javi ');
  assert.equal(K.keypadType('Javi', 'delete', 'text', 16), 'Jav');
  assert.equal(K.keypadType('', 'delete', 'text', 16), '');
  assert.equal(K.keypadType('x'.repeat(16), 'y', 'text', 16), 'x'.repeat(16), 'maxLength');
  assert.equal(K.keypadType('AB', 'c', 'code', 64), 'ABC');
  assert.equal(K.keypadType('AB', 'O', 'code', 64), 'AB', 'O is not in the alphabet');
  assert.equal(K.keypadType('AB', '1', 'code', 64), 'AB');
  assert.equal(K.keypadType('AB', 'space', 'code', 64), 'AB');
  assert.equal(K.keypadType('ABC234', 'Z', 'code', 64), 'ABC234', 'six at most');
  assert.equal(K.keypadType('ab', 'ñ', 'text', 64), 'abñ', 'a keyboard types what it has');
  assert.equal(K.keypadType('ab', 'Enter', 'text', 64), 'ab', 'a key name is no character');
  assert.equal(K.keypadShown('hunter22', true), '••••••••');
  assert.equal(K.keypadShown('Javi', false), 'Javi');
});

test('/tv: the link carries the code in the hash only; a flag is no code; the hash keeps its flags', () => {
  assert.equal(M.tvLink('https://turbo-gol.com/', 'ABC234'), 'https://turbo-gol.com/tv#ABC234');
  assert.ok(!M.tvLink('https://turbo-gol.com', 'ABC234').includes('?'));
  assert.equal(M.tvShortLink('https://turbo-gol.com'), 'turbo-gol.com/tv');
  assert.equal(M.tvShortLink('http://localhost:5350/'), 'localhost:5350/tv');
  assert.ok(M.isTvPath('/tv') && M.isTvPath('/tv/'));
  assert.ok(!M.isTvPath('/') && !M.isTvPath('/tvx'));
  assert.equal(M.tvHashCode('#ABC234'), 'ABC234');
  assert.equal(M.tvHashCode('#ABC234&superlow'), 'ABC234');
  for (const h of ['', '#', '#tv', '#webgpu', '#webgl2', '#WEBGL2X', '#ABC23', '#ABCO23', '#ABC1234', '#sala=ABC234']) assert.equal(M.tvHashCode(h), null, h);
  assert.equal(M.withoutTvCode('#ABC234'), '');
  assert.equal(M.withoutTvCode('#ABC234&superlow&tv'), '#superlow&tv');
  assert.equal(M.withoutTvCode('#superlow'), '#superlow');
});

test('/tv: the countdown; a code kept for 5 minutes across a sign-in (an empty one: the page without a code)', () => {
  assert.equal(M.timeLeft(300_000, 0), '5:00');
  assert.equal(M.timeLeft(61_500, 0), '1:02');
  assert.equal(M.timeLeft(9_000, 0), '0:09');
  assert.equal(M.timeLeft(0, 5), '0:00');
  const at = 1_000_000;
  assert.equal(M.pendingCode(JSON.stringify({ code: 'ABC234', at }), at + 1000), 'ABC234');
  assert.equal(M.pendingCode(JSON.stringify({ code: '', at }), at + 1000), '');
  assert.equal(M.pendingCode(JSON.stringify({ code: 'ABC234', at }), at + M.PENDING_MS + 1), null, 'stale');
  for (const raw of [null, '{', '"x"', JSON.stringify({ code: 'ABCO23', at }), JSON.stringify({ code: 5, at }), JSON.stringify({ code: 'ABC234', at: at + 5000 })]) assert.equal(M.pendingCode(raw, at), null, String(raw));
});

test('/tv: a TV whose clock is minutes off the server still gets its code\'s whole life (counted on its own clock from ttlMs)', () => {
  // The server's answer: expiresAt on its clock, ttlMs the life from now. The TV's Date.now() runs 6 minutes ahead.
  const server = 1_800_000_000_000;
  const answer = { expiresAt: server + 300_000, ttlMs: 300_000 };
  const tvWall = server + 360_000;
  assert.equal(M.timeLeft(answer.expiresAt, tvWall), '0:00', 'the server\'s expiresAt against the TV\'s clock: gone at once');
  const t0 = 12_345.6; // performance.now() at the answer
  const until = M.tvDeadline(answer.ttlMs, t0);
  assert.equal(M.timeLeft(until, t0), '5:00');
  assert.equal(M.timeLeft(until, t0 + 299_000), '0:01');
  assert.ok(t0 + 299_999 < until && t0 + 300_000 >= until);
  assert.equal(M.tvDeadline(3_600_000, 0), M.PENDING_MS, 'never longer than a code\'s life');
  assert.equal(M.tvDeadline(-5, 0), 0);
  assert.equal(M.tvDeadline(Number.NaN, 0), M.PENDING_MS);
});

test('AccountClient: tvStart, tvPoll pending then approved (adopted only by signInWith), tvConfirm with the Bearer', async () => {
  const calls = [];
  const session = { kind: 'account', playerId: 'u1', name: 'Ana', session: 'jwt', expiresAt: Date.now() + 3_600_000 };
  let approve = false;
  const acc = new AccountClient({
    storage: null,
    fetchFn: async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization ?? null });
      if (url === '/api/auth/tv/start') return res(200, { code: 'ABC234', secret: 's'.repeat(43), expiresAt: Date.now() + 300_000, ttlMs: 300_000, pollMs: 3000 });
      if (url === '/api/auth/tv/poll') return res(200, approve ? { ...session, state: 'approved' } : { state: 'pending' });
      if (url === '/api/auth/tv/confirm') return init.headers.authorization ? res(200, { ok: true }) : res(401, { error: 'unauthorized' });
      if (url === '/api/auth/login') return res(200, session);
      return res(404, {});
    },
  });
  const s = await acc.tvStart();
  assert.equal(s.code, 'ABC234');
  assert.deepEqual(await acc.tvPoll(s.code, s.secret), { state: 'pending' });
  assert.deepEqual(calls[1].body, { code: 'ABC234', secret: s.secret });
  approve = true;
  let changes = 0;
  acc.subscribe(() => changes++);
  const r = await acc.tvPoll(s.code, s.secret);
  assert.equal(r.state, 'approved');
  assert.equal(acc.signedIn, false, 'not adopted yet: the TV closes its sheet first');
  assert.equal(changes, 0);
  acc.signInWith(r);
  assert.equal(acc.signedIn, true);
  assert.equal(acc.account.name, 'Ana');
  assert.equal(changes, 1);
  await acc.tvConfirm('ABC234');
  assert.equal(calls.at(-1).auth, 'Bearer jwt');
  assert.deepEqual(calls.at(-1).body, { code: 'ABC234' });
});

test('AccountClient: a refused confirm says why in words (wrong, expired, used, too many tries)', async () => {
  const answers = {
    tv_code_wrong: res(404, { error: 'tv_code_wrong', message: 'Ese código no existe' }),
    tv_code_expired: res(410, { error: 'tv_code_expired' }),
    tv_code_used: res(409, { error: 'tv_code_used' }),
    throttled: res(429, { error: 'throttled', retryAfterMs: 60_000 }),
  };
  for (const [code, answer] of Object.entries(answers)) {
    const acc = new AccountClient({ storage: null, fetchFn: async (url) => (url === '/api/auth/login' ? res(200, { kind: 'account', playerId: 'u1', name: 'Ana', session: 'jwt', expiresAt: Date.now() + 3_600_000 }) : answer) });
    await acc.login('Ana', 'password-ok-1');
    await assert.rejects(acc.tvConfirm('ABC234'), (e) => e.code === code && e.message.length > 0 && !/^error\./.test(e.message), code);
  }
});

/** A fake window.turnstile driven by `behave(opts)`. */
function fakeTurnstile(behave) {
  const api = {
    rendered: 0,
    removed: 0,
    render(container, opts) {
      api.rendered++;
      behave(opts);
      return 'w' + api.rendered;
    },
    remove() {
      api.removed++;
    },
    reset() {},
  };
  return api;
}

test('Turnstile: onInteractive brackets the interaction, and is off again whatever ends the challenge', async () => {
  const seen = [];
  const api = fakeTurnstile((o) => {
    o['before-interactive-callback']();
    setTimeout(() => {
      o['after-interactive-callback']();
      o.callback('tok');
    }, 0);
  });
  assert.equal(await getToken('sk', { hidden: true }, { load: async () => api, onInteractive: (on) => seen.push(on) }), 'tok');
  assert.deepEqual(seen, [true, false]);
  const ctrl = new AbortController();
  const seen2 = [];
  const stuck = fakeTurnstile((o) => o['before-interactive-callback']());
  const p = getToken('sk', { hidden: true }, { load: async () => stuck, signal: ctrl.signal, onInteractive: (on) => seen2.push(on) });
  await new Promise((r) => setTimeout(r, 5));
  ctrl.abort();
  await assert.rejects(p);
  assert.deepEqual(seen2, [true, false], 'CANCEL (an abort) ends it too');
});

class FakeStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

function client(api, t = { now: 1000 }) {
  const calls = [];
  const c = new NetClient({
    storage: new FakeStorage(),
    now: () => t.now,
    fetchFn: async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url === '/api/config') return res(200, { turnstileSiteKey: 'sk-1', protocol: P.PROTOCOL_VERSION, version: 't', region: 'EZE' });
      if (url === '/api/guest') return res(200, { playerId: 'p1', name: calls.at(-1).body.name, session: 'jwt', expiresAt: Date.now() + 86_400_000 });
      return res(404, {});
    },
    turnstileContainer: () => ({ hidden: true }),
    turnstileLoader: async () => api,
  });
  return { c, calls, t };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test('NetClient: Inicio pre-warms one token, the next registration uses it (no second widget), once; stale after WARM_MS', async () => {
  const api = fakeTurnstile((o) => setTimeout(() => o.callback('tok-' + api.rendered), 0));
  const { c, calls, t } = client(api);
  const phases = [];
  c.onTurnstile = (on) => phases.push(on);
  c.prewarmAntiBot();
  c.prewarmAntiBot(); // one at a time
  await settle();
  assert.equal(api.rendered, 1);
  assert.deepEqual(phases, [], 'a pre-warm reports nothing');
  c.setName('Tester');
  await c.ensureGuest();
  assert.equal(api.rendered, 1, 'the registration took the warm token');
  assert.deepEqual(calls.find((x) => x.url === '/api/guest').body, { name: 'Tester', turnstileToken: 'tok-1' });
  c.prewarmAntiBot();
  await settle();
  assert.equal(api.rendered, 1, 'a stored guest needs no pre-warm');
  // A sign-up later: a token of its own (the warm one was used); a stale warm one is not used.
  c.setName('Other');
  c.prewarmAntiBot();
  await settle();
  assert.equal(api.rendered, 2);
  t.now += WARM_MS + 1;
  assert.equal(await c.antiBotToken(), 'tok-3', 'stale: a fresh check');
});

test('NetClient: a pre-warm that wants a click gives up quietly; the registration own check asks the player (onAntiBotAsk)', async () => {
  let interactive = true;
  const api = fakeTurnstile((o) => {
    if (interactive) o['before-interactive-callback']();
    else setTimeout(() => o.callback('tok'), 0);
  });
  const { c } = client(api);
  const asks = [];
  c.onAntiBotAsk = (on) => asks.push(on);
  c.prewarmAntiBot();
  await settle();
  assert.equal(api.removed, 1, 'the widget went');
  assert.deepEqual(asks, [], 'nobody was asked');
  c.setName('Tester');
  const p = c.ensureGuest();
  await settle();
  assert.deepEqual(asks, [true], 'the sheet: the check wants the player');
  c.cancelChallenge(); // its CANCEL
  await assert.rejects(p, (e) => e.code === 'cancelled');
  assert.deepEqual(asks, [true, false]);
  interactive = false;
  assert.equal((await c.ensureGuest()).name, 'Tester', 'the next one goes through');
});

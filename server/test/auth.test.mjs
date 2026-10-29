// Unit tests for server/src/auth.ts (WebCrypto HS256 JWT). Run from server/:
//   npm test        (= node --experimental-transform-types --test "test/*.test.mjs")
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
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

const A = await import('../src/auth.ts');
const SECRET = 'unit-test-secret';

test('base64url round trip', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 62, 63]);
  const s = A.base64urlEncode(bytes);
  assert.doesNotMatch(s, /[+/=]/);
  assert.deepEqual(Array.from(A.base64urlDecode(s)), Array.from(bytes));
  assert.equal(A.base64urlDecode('not*valid'), null);
});

test('timingSafeEqual', () => {
  const a = new TextEncoder().encode('abcdef');
  assert.equal(A.timingSafeEqual(a, new TextEncoder().encode('abcdef')), true);
  assert.equal(A.timingSafeEqual(a, new TextEncoder().encode('abcdeg')), false);
  assert.equal(A.timingSafeEqual(a, new TextEncoder().encode('abcde')), false);
});

test('session: sign / verify round trip, 24 h expiry', async () => {
  const now = 1_700_000_000_000;
  const { token, expiresAt } = await A.createSession(SECRET, '0123456789abcdef', 'Alice', now);
  assert.equal(token.split('.').length, 3);
  assert.equal(expiresAt, (Math.floor(now / 1000) + A.SESSION_TTL_SECONDS) * 1000);
  const c = await A.verifySession(SECRET, token, now + 1000);
  assert.ok(c);
  assert.equal(c.sub, '0123456789abcdef');
  assert.equal(c.name, 'Invitado 9743', "a guest's name is the server's, from its id (guest-names.test.mjs)");
  assert.equal(c.exp - c.iat, A.SESSION_TTL_SECONDS);
  // expired
  assert.equal(await A.verifySession(SECRET, token, now + (A.SESSION_TTL_SECONDS + 1) * 1000), null);
  // wrong secret
  assert.equal(await A.verifySession('other', token, now), null);
});

test('tamper detection: payload, signature, header, alg=none', async () => {
  const now = 1_700_000_000_000;
  const { token } = await A.createSession(SECRET, '0123456789abcdef', 'Alice', now);
  const [h, p, s] = token.split('.');
  const flip = (str, i) => str.slice(0, i) + (str[i] === 'A' ? 'B' : 'A') + str.slice(i + 1);
  assert.equal(await A.verifyJwt(SECRET, `${h}.${flip(p, 3)}.${s}`, now / 1000), null, 'payload bit flip');
  assert.equal(await A.verifyJwt(SECRET, `${h}.${p}.${flip(s, 5)}`, now / 1000), null, 'signature bit flip');
  assert.equal(await A.verifyJwt(SECRET, `${h}.${p}`, now / 1000), null, 'missing signature');
  assert.equal(await A.verifyJwt(SECRET, `${h}.${p}.`, now / 1000), null, 'empty signature');
  // forged payload re-encoded (sub changed) with the original signature
  const claims = JSON.parse(new TextDecoder().decode(A.base64urlDecode(p)));
  claims.sub = 'ffffffffffffffff';
  const forged = A.base64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  assert.equal(await A.verifyJwt(SECRET, `${h}.${forged}.${s}`, now / 1000), null, 'forged payload');
  // alg: none
  const none = A.base64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })));
  assert.equal(await A.verifyJwt(SECRET, `${none}.${p}.${s}`, now / 1000), null, 'alg none');
  assert.equal(await A.verifyJwt(SECRET, `${none}.${p}.`, now / 1000), null, 'alg none, empty sig');
  // token without exp is rejected
  const noExp = await A.signJwt(SECRET, { sub: 'x' });
  assert.equal(await A.verifyJwt(SECRET, noExp, now / 1000), null);
});

test('ticket: claims, 90 s expiry, match id binding, single jti per ticket', async () => {
  const now = 1_700_000_000_000;
  const mid = 'a'.repeat(64);
  const t1 = await A.createTicket(SECRET, { sub: '0123456789abcdef', mid, team: 1, slot: 3, name: 'Bob' }, now);
  const t2 = await A.createTicket(SECRET, { sub: '0123456789abcdef', mid, team: 1, slot: 3, name: 'Bob' }, now);
  const c = await A.verifyTicket(SECRET, t1, mid, now + 89_000);
  assert.ok(c);
  assert.equal(c.role, 'player');
  assert.equal(c.team, 1);
  assert.equal(c.slot, 3);
  assert.equal(c.name, 'Bob');
  assert.equal(c.exp - c.iat, A.TICKET_TTL_SECONDS);
  assert.match(c.jti, /^[0-9a-f]{32}$/);
  const c2 = await A.verifyTicket(SECRET, t2, mid, now);
  assert.notEqual(c.jti, c2.jti, 'every ticket gets its own jti');
  assert.equal(await A.verifyTicket(SECRET, t1, mid, now + 91_000), null, 'expired');
  assert.equal(await A.verifyTicket(SECRET, t1, 'b'.repeat(64), now), null, 'other match');
  // a session token is not a ticket
  const { token } = await A.createSession(SECRET, '0123456789abcdef', 'Bob', now);
  assert.equal(await A.verifyTicket(SECRET, token, mid, now), null);
});

test('internal secret is stable per JWT secret and differs between secrets', async () => {
  const a = await A.internalSecret('s1');
  const b = await A.internalSecret('s1');
  const c = await A.internalSecret('s2');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
  const req = new Request('https://x/', { headers: { [A.INTERNAL_HEADER]: a } });
  assert.equal(await A.checkInternal('s1', req), true);
  assert.equal(await A.checkInternal('s2', req), false);
  assert.equal(await A.checkInternal('s1', new Request('https://x/')), false);
});

test('randomHex', () => {
  const a = A.randomHex(8);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, A.randomHex(8));
});

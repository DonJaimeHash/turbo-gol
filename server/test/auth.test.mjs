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
  assert.equal(c.name, 'Alice');
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

// ---- Security 3 (auth-9): typed tokens, a domain-separated internal secret ----------------------

test('auth-9: a ticket never verifies as a session, a session never as a ticket; both say their typ', async () => {
  const now = 1_700_000_000_000;
  const mid = 'a'.repeat(64);
  for (const role of ['player', 'peer', 'lobby']) {
    const ticket = await A.createTicket(SECRET, { sub: '0123456789abcdef', mid, team: 0, slot: 0, name: 'Ana', role }, now);
    assert.equal(JSON.parse(new TextDecoder().decode(A.base64urlDecode(ticket.split('.')[1]))).typ, 't');
    assert.equal(await A.verifySession(SECRET, ticket, now), null, `a ${role} ticket is no Bearer session`);
    assert.ok(await A.verifyTicket(SECRET, ticket, mid, now, role));
  }
  const { token } = await A.createSession(SECRET, '0123456789abcdef', 'Ana', now);
  assert.equal(JSON.parse(new TextDecoder().decode(A.base64urlDecode(token.split('.')[1]))).typ, 's');
  assert.ok(await A.verifySession(SECRET, token, now));
  // Any other typ (an OAuth state's 'oa', a made-up one) is no session, even with a session's claims.
  const iat = Math.floor(now / 1000);
  for (const typ of ['oa', 't', 'x']) assert.equal(await A.verifySession(SECRET, await A.signJwt(SECRET, { typ, sub: '0123456789abcdef', name: 'Ana', iat, exp: iat + 60 }), now), null, typ);
  // A ticket-shaped token typed as a session is still refused as a ticket.
  assert.equal(await A.verifyTicket(SECRET, await A.signJwt(SECRET, { typ: 's', sub: '0123456789abcdef', mid, team: 0, slot: 0, role: 'player', name: 'Ana', iat, exp: iat + 60, jti: 'b'.repeat(32) }), mid, now), null);
});

test('auth-9: tokens signed before the types keep working for their life (no sign-out at the deploy), a legacy ticket stays a ticket only', async () => {
  const now = 1_700_000_000_000;
  const iat = Math.floor(now / 1000);
  const mid = 'c'.repeat(64);
  const legacyGuest = await A.signJwt(SECRET, { sub: '0123456789abcdef', name: 'Ana', iat, exp: iat + A.SESSION_TTL_SECONDS });
  assert.equal((await A.verifySession(SECRET, legacyGuest, now)).name, 'Ana', 'an untyped 24 h guest session');
  const legacyAccount = await A.signJwt(SECRET, { sub: '0123456789abcdef', name: 'Ana', iat, exp: iat + 3600, acct: 1, car: 'pampero' });
  assert.equal((await A.verifySession(SECRET, legacyAccount, now)).acct, 1, 'an untyped 1 h account session');
  const legacyTicket = await A.signJwt(SECRET, { sub: '0123456789abcdef', mid, team: 1, slot: 2, role: 'peer', name: 'Ana', iat, exp: iat + 90, jti: 'd'.repeat(32) });
  assert.ok(await A.verifyTicket(SECRET, legacyTicket, mid, now, 'peer'), 'an untyped 90 s ticket still opens its socket');
  assert.equal(await A.verifySession(SECRET, legacyTicket, now), null, 'but is no Bearer session');
});

test('auth-9: the TV scope and the fresh sign-in are an account session\'s only; a TV never carries a fresh sign-in', async () => {
  const now = 1_700_000_000_000;
  const iat = Math.floor(now / 1000);
  const sign = (c) => A.signJwt(SECRET, { typ: 's', sub: '0123456789abcdef', name: 'Ana', iat, exp: iat + 600, ...c });
  assert.deepEqual([(await A.verifySession(SECRET, await sign({ acct: 1, tv: 1 }), now)).tv], [1]);
  assert.equal((await A.verifySession(SECRET, await sign({ acct: 1, aat: iat }), now)).aat, iat);
  assert.equal((await A.verifySession(SECRET, await sign({ tv: 1, aat: iat }), now)).tv, undefined, 'a guest claims no scope');
  assert.equal((await A.verifySession(SECRET, await sign({ aat: iat }), now)).aat, undefined);
  assert.equal((await A.verifySession(SECRET, await sign({ acct: 1, tv: 1, aat: iat }), now)).aat, undefined, 'a TV never has a fresh sign-in');
  assert.equal((await A.verifySession(SECRET, await sign({ acct: 1, tv: 2 }), now)).tv, undefined);
});

test('auth-9: the internal secret is HKDF-derived, apart from the token key: not the HMAC of any label under it', async () => {
  const enc = new TextEncoder();
  const v = await A.internalSecret('s1');
  assert.match(v, /^[0-9a-f]{64}$/);
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const hmac = await crypto.subtle.importKey('raw', enc.encode('s1'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  assert.notEqual(v, hex(await crypto.subtle.sign('HMAC', hmac, enc.encode('turbogol-internal-v1'))), 'not the v1 value (an HMAC under the JWT key)');
  const ikm = await crypto.subtle.importKey('raw', enc.encode('s1'), 'HKDF', false, ['deriveBits']);
  const want = hex(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('turbogol/hkdf/v2'), info: enc.encode('internal-auth') }, ikm, 256));
  assert.equal(v, want);
});

test('randomHex', () => {
  const a = A.randomHex(8);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, A.randomHex(8));
});

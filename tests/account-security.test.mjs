// Security 3, the browser's side (src/net/AccountClient.ts on a fake fetch): a refresh another tab
// won is asked again, not taken for a sign-out; the device list and sign out everywhere; the TV's
// limited scope as the session says it; the TV code typed (never confirmed from the link); linking,
// a first password and new codes behind a fresh sign-in; and from sign-in PR 4 the anti-bot token
// of every sign-in, both keys of a password, and "confirm it's you" at the level the server names.
// The server's side: server/test/takeover.test.mjs and server/test/levels.test.mjs.
//   node --test tests/account-security.test.mjs
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

const AC = await import('../src/net/AccountClient.ts');

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function fakeServer(handlers) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body, headers: init.headers });
    const h = handlers[path.split('?')[0]];
    if (!h) return res(404, { error: 'not_found' });
    return h(body, init.headers, path, calls);
  };
  return { fetchFn, calls };
}

const SESSION = (extra = {}) => ({ kind: 'account', playerId: 'abcdef0123456789', name: 'Ana', session: 'jwt-ana', expiresAt: Date.now() + 3_600_000, ...extra });
const client = (handlers, opts = {}) => {
  const srv = fakeServer(handlers);
  return { acc: new AC.AccountClient({ storage: null, fetchFn: srv.fetchFn, sleep: async () => undefined, ...opts }), calls: srv.calls };
};

// ---- auth-4 ---------------------------------------------------------------------------------------

test('auth-4: a refresh another tab won (409 refresh_race) is asked once more and the session kept, not signed out', async () => {
  let n = 0;
  const { acc, calls } = client({ '/api/auth/refresh': () => (++n === 1 ? res(409, { error: 'refresh_race' }) : res(200, SESSION())) });
  const s = await acc.restore();
  assert.equal(s?.name, 'Ana');
  assert.equal(calls.filter((c) => c.path === '/api/auth/refresh').length, 2);
  assert.equal(acc.signedIn, true);
});

test('auth-4: the device list and sign out everywhere (any account), which signs this browser out too', async () => {
  const devices = [
    { id: 'a'.repeat(32), kind: 'web', signedInAt: 1, lastUsedAt: 2, country: 'AR', city: 'Córdoba', current: true },
    { id: 'b'.repeat(32), kind: 'tv', signedInAt: 1, lastUsedAt: 3, country: null, city: null, current: false },
    { id: 5, kind: 'web' }, // junk is dropped
  ];
  const { acc, calls } = client({
    '/api/auth/refresh': () => res(200, SESSION()),
    '/api/auth/sessions': () => res(200, { sessions: devices }),
    '/api/auth/sessions/revoke': () => res(200, { revoked: 1 }),
    '/api/auth/sessions/revoke-all': () => res(200, { revoked: 3 }),
  });
  await acc.restore();
  const list = await acc.sessions();
  assert.deepEqual(list.map((d) => d.id), ['a'.repeat(32), 'b'.repeat(32)]);
  await acc.revokeSession('b'.repeat(32));
  assert.deepEqual(calls.at(-1).body, { id: 'b'.repeat(32) });
  assert.equal(calls.at(-1).headers.authorization, 'Bearer jwt-ana');
  assert.equal(acc.signedIn, true, 'another device: this one stays');
  await acc.signOutEverywhere();
  assert.equal(calls.at(-1).path, '/api/auth/sessions/revoke-all');
  assert.equal(acc.signedIn, false, 'every device, this one too');
});

// ---- auth-1: the TV's limited scope as the session carries it ------------------------------------

test('auth-1: an approved TV session keeps its tv flag (PERFIL then shows only its own sign-out); the OAuth refusal has words', async () => {
  const { acc } = client({});
  acc.signInWith({ ...SESSION({ tv: true }), state: 'approved' });
  assert.equal(acc.account.tv, true);
  assert.equal('state' in acc.account, false, 'only the session is adopted');
  assert.doesNotMatch(AC.oauthErrorText('tv_session'), /^error\.|Couldn't sign in/);
});

// ---- auth-1 / client-1 / tv-1: the phone types the code and sees where the TV is; the TV solves the check ----

test('auth-1: the TV\'s start sends the anti-bot token (one per code); a check that wants a press or fails starts without one (the live check: a remote cannot answer it)', async () => {
  let n = 0;
  const { acc, calls } = client(
    { '/api/auth/tv/start': () => res(200, { code: 'ABC234', secret: 's'.repeat(43), expiresAt: Date.now() + 240_000, ttlMs: 240_000, pollMs: 3000 }) },
    { antiBot: async () => 'tok-' + ++n },
  );
  await acc.tvStart();
  await acc.tvStart();
  assert.deepEqual(calls.map((c) => c.body), [{ turnstileToken: 'tok-1' }, { turnstileToken: 'tok-2' }]);
  const start = () => res(200, { code: 'ABC234', secret: 's'.repeat(43), expiresAt: Date.now() + 240_000, ttlMs: 240_000, pollMs: 3000 });
  const { acc: broken, calls: c2 } = client({ '/api/auth/tv/start': start }, { antiBot: async () => Promise.reject(new Error('widget')) });
  assert.equal((await broken.tvStart()).code, 'ABC234');
  assert.deepEqual(c2.map((c) => c.body), [{}], 'no token: the server counts the code under its tighter caps');
  // The quiet check is the TV's (never the sheet that asks the player); a token the server refused: once more without one.
  let asked = 0;
  let n2 = 0;
  const { acc: tv, calls: c3 } = client({ '/api/auth/tv/start': (b) => (b.turnstileToken ? res(403, { error: 'turnstile_failed' }) : start()) }, { antiBot: async () => (asked++, 'loud'), antiBotQuiet: async () => 'quiet-' + ++n2 });
  assert.equal((await tv.tvStart()).code, 'ABC234');
  assert.deepEqual(c3.map((c) => c.body), [{ turnstileToken: 'quiet-1' }, {}]);
  assert.equal(asked, 0, 'the check that asks the player is never used for a TV');
});

test('auth-1: the phone asks where the TV is with its Bearer (POST /api/auth/tv/info), and words it', async () => {
  const where = { country: 'AR', city: 'Córdoba', asn: 7303, org: 'Telecom Argentina' };
  const { acc, calls } = client({
    '/api/auth/refresh': () => res(200, SESSION()),
    '/api/auth/tv/info': () => res(200, { where, sameNetwork: false, sameCountry: true, createdAt: 1 }),
  });
  await acc.restore();
  const info = await acc.tvInfo('ABC234');
  assert.deepEqual(calls.at(-1).body, { code: 'ABC234' });
  assert.equal(calls.at(-1).headers.authorization, 'Bearer jwt-ana');
  const M = await import('../src/ui/screens/tvSignInModel.ts');
  assert.equal(M.tvPlace(info.where), 'Córdoba, AR · Telecom Argentina');
  assert.equal(M.tvPlace({ country: 'AR', city: null, asn: null, org: null }), 'AR');
  assert.equal(M.tvPlace({ country: 'AR', city: 'Rosario', asn: 1, org: 'Coop. Ltda.' }), 'Rosario, AR · Coop. Ltda', 'the sentence puts its own dot');
  assert.equal(M.tvPlace({ country: null, city: null, asn: null, org: null }), null);
  assert.equal(M.tvPlace(null), null);
});

test('auth-1 / client-1: the /tv page never confirms the link\'s code in one tap: the entry is always empty and typed, the place shown before CONFIRMAR', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/ui/screens/tvSignIn.ts', import.meta.url), 'utf8');
  const install = src.slice(src.indexOf('export function installTvLink'));
  assert.match(install, /codeSheet\(menu, '', ask\)/, 'the code cells start empty');
  assert.doesNotMatch(install, /\bask\(code\)/, 'the link\'s code never goes to the CONFIRMAR sheet');
  assert.doesNotMatch(install, /codeSheet\(menu, code\b/, 'nor into the cells');
  assert.match(install, /acc\.tvInfo\(c\)/, 'where the TV is, asked before the sheet');
});

// ---- auth-2 / authz-1: a link after a fresh sign-in, re-authentication, unlink -------------------

test('auth-2: PERFIL links only right after a sign-in (fresh), else it asks "confirm it is you"; a TV never is fresh', async () => {
  let now = 1_800_000_000_000;
  const { acc } = client({ '/api/auth/refresh': () => res(200, SESSION({ authAt: now - 60_000, authLvl: 1 })) }, { now: () => now });
  await acc.restore();
  assert.equal(acc.fresh(), true, 'signed in a minute ago');
  assert.equal(acc.fresh(2), false, 'with a provider (level 1): not enough for a level-2 change');
  now += 9 * 60_000;
  assert.equal(acc.fresh(), false, 'nine minutes later: confirm first');
  acc.signInWith({ ...SESSION({ tv: true, authAt: now }) });
  assert.equal(acc.fresh(), false, 'a TV, whatever it says');
  assert.equal(acc.oauthUrl('discord', true), '/api/auth/oauth/discord/start?link=1');
  assert.equal(acc.oauthUrl('google', 'reauth'), '/api/auth/oauth/google/start?reauth=1');
  assert.equal(acc.oauthUrl('google'), '/api/auth/oauth/google/start');
  assert.deepEqual(AC.parseAuthHash('#auth=reauth'), { kind: 'reauth' });
  for (const code of ['provider_set', 'reauth_required', 'reauth_mismatch', 'link_expired']) assert.doesNotMatch(AC.oauthErrorText(code), /^error\.|^auth\.|Couldn't sign in/, code);
});

test('authz-1: a password re-authentication sends the client key with the Bearer and adopts the fresh session; unlink asks the server and reloads the profile', async () => {
  const { acc, calls } = client({
    '/api/auth/refresh': () => res(200, SESSION()),
    '/api/auth/reauth': (body) => (body.password.length === 64 ? res(200, SESSION({ session: 'jwt-fresh', authAt: Date.now(), authLvl: 2 })) : res(400, {})),
    '/api/auth/unlink': () => res(200, { ok: true }),
    '/api/me': () => res(200, { playerId: 'abcdef0123456789', name: 'Ana', providers: ['discord'], hasPassword: false, linkedAt: { discord: 5 } }),
  });
  await acc.restore();
  await acc.reauth('una contraseña');
  const r = calls.find((c) => c.path === '/api/auth/reauth');
  assert.match(r.body.password, /^[0-9a-f]{64}$/, 'never the typed password');
  assert.match(r.body.legacy, /^[0-9a-f]{64}$/, 'and the legacy key, which re-keys a password of before');
  assert.equal(r.headers.authorization, 'Bearer jwt-ana');
  assert.equal(acc.account.session, 'jwt-fresh');
  assert.equal(acc.fresh(), true);
  assert.equal(acc.fresh(2), true, 'a typed password is level 2');
  await acc.unlink('google');
  assert.deepEqual(calls.find((c) => c.path === '/api/auth/unlink').body, { provider: 'google' });
  assert.deepEqual(acc.me.linkedAt, { discord: 5 });
});

// ---- auth-3 / authz-2 / auth-persist-1: a first password only from the mailbox (sign-in PR 8); links behind "confirm it is you" ----

test('auth-3: PERFIL never sets a first password or mints codes from a Bearer: CREAR CONTRASEÑA mails a link to the verified address; a link and an unlink go through "confirm it is you"', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/ui/screens/profile.ts', import.meta.url), 'utf8');
  assert.match(src, /t\('profile\.createPassword'\)[\s\S]{0,200}acc\.passwordLink\(\)/, "a first password: a link to the account's own mailbox");
  assert.match(src, /me\.emailVerified !== true[\s\S]{0,120}t\('auth\.addEmailFirst'\)/, 'without a verified address: add one first');
  assert.doesNotMatch(src, /newRecoveryCodes|codesDialog|showRecoveryCodes/, 'no recovery codes are minted any more');
  const ac = await readFile(new URL('../src/net/AccountClient.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(ac, /\/api\/auth\/(?:register|recovery-codes|password)'/, 'the routes PR 7 retired (410) are never called');
  // The level is linkLevel's: 1, or 2 for the project account (tests/maintainer-link-level.test.mjs).
  assert.match(src, /fresh\(\(\) => \(window\.location\.href = acc\.oauthUrl\(p, true\)\)(?:, linkLevel\((?:me|acc\.me)\))?\)/, 'a link');
  assert.match(src, /fresh\(\(\) => \{\s*void acc\.unlink\(p\)/, 'an unlink');
  assert.match(src, /acc\.oauthUrl\(p, 'reauth'\)/, 'the provider round trip');
  assert.match(src, /await acc\.reauth\(pass\.input\.value\)/, 'or the password');
});

// ---- auth-5 / sign-in PR 4: every anonymous sign-in carries a solved anti-bot check ----------------

test('auth-5 (sign-in PR 4): login and recover send a solved anti-bot token every time; a token that died (403 turnstile_failed) is replaced once, silently; other refusals are not retried', async () => {
  let tokens = 0;
  const { acc, calls } = client(
    { '/api/auth/login': (body) => (body.turnstileToken === 'tok-2' ? res(200, SESSION()) : res(403, { error: 'turnstile_failed' })) },
    { antiBot: async () => 'tok-' + ++tokens },
  );
  const s = await acc.legacySignIn('Ana', 'una contraseña');
  assert.equal(s.name, 'Ana');
  assert.deepEqual(calls.map((c) => c.body.turnstileToken), ['tok-1', 'tok-2'], 'one token per request, a new one for the retry');
  const { acc: banned, calls: c2 } = client({ '/api/auth/login': () => res(403, { error: 'banned' }) }, { antiBot: async () => 'tok' });
  await assert.rejects(banned.legacySignIn('Ana', 'una contraseña'), (e) => e.code === 'banned');
  assert.equal(c2.length, 1);
  const { acc: twice, calls: c3 } = client({ '/api/auth/login': () => res(403, { error: 'turnstile_failed' }) }, { antiBot: async () => 'tok' });
  await assert.rejects(twice.legacySignIn('Ana', 'una contraseña'), (e) => e.code === 'turnstile_failed' && !/^error\./.test(e.message));
  assert.equal(c3.length, 2, 'once more, never a loop');
  const { acc: rec, calls: c4 } = client({ '/api/auth/recover': () => res(200, { ...SESSION(), codesLeft: 7 }) }, { antiBot: async () => 'tok-r' });
  await rec.recover('Ana', 'AAAA-BBBB', 'una contraseña nueva');
  assert.equal(c4[0].body.turnstileToken, 'tok-r');
  const { acc: broken } = client({}, { antiBot: async () => Promise.reject(new Error('widget')) });
  await assert.rejects(broken.legacySignIn('Ana', 'una contraseña'), (e) => e.code === 'turnstile_failed' && e.status === 0, 'the check never ran here (PERFIL says: allow the site, or use a provider)');
});

test('auth-5 (sign-in PR 4): a username paused for new browsers (30 minutes to an hour) keeps its wait, and PERFIL says what to do in minutes instead of counting seconds', async () => {
  const WAIT = 30 * 60_000 - 1000;
  const { acc } = client({ '/api/auth/login': () => res(429, { error: 'throttled', message: 'Demasiados intentos, espera un momento', retryAfterMs: WAIT }) });
  const e = await acc.legacySignIn('Ana', 'una contraseña').then(() => null, (err) => err);
  assert.ok(e.code === 'throttled' && e.retryAfterMs === WAIT);
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/ui/screens/profile.ts', import.meta.url), 'utf8');
  assert.match(src, /const PAIR_LOCK_MAX_MS = 15 \* 60_000;/, 'the longest lock of a pair and a network pause');
  assert.match(src, /e\.code === 'throttled' && e\.retryAfterMs > PAIR_LOCK_MAX_MS\) return t\('profile\.retryNewDevice', \{ minutes: Math\.ceil\(e\.retryAfterMs \/ 60_000\) \}\)/);
  const es = (await import('../src/locales/es.ts')).default;
  const en = (await import('../src/locales/en.ts')).default;
  assert.match(es['profile.retryNewDevice'], /dispositivo que ya usaste.*\{minutes\} min/);
  assert.doesNotMatch(es['profile.retryNewDevice'], /\b(usaste vos|probá|entrá|intentá|esperá)\b/, 'neutral tú, no voseo');
  assert.match(en['profile.retryNewDevice'], /device you have used before.*\{minutes\} min/);
  assert.equal(es['profile.retryTomorrow'], undefined, 'no pause lasts until tomorrow any more');
});

test('sign-in PR 4 and 8: the username sign-in sends both keys of the typed password (the legacy one re-keys it); a password change proves the current one by both and stores the current key; a rename sends no password; a session of before levels is never fresh', async () => {
  const ACC = await import('../src/net/account.ts');
  const { acc, calls } = client({
    '/api/auth/login': () => res(200, SESSION({ authAt: Date.now() })),
    '/api/me/password': () => res(200, { ok: true }),
    '/api/me/username': () => res(200, SESSION({ name: 'Ana2' })),
    '/api/me': () => res(200, { playerId: 'abcdef0123456789', name: 'Ana2', providers: ['password'], hasPassword: true }),
  });
  await acc.legacySignIn(' Ana ', 'una contraseña');
  const [legacy, current] = [await ACC.legacyPasswordKey('Ana', 'una contraseña'), await ACC.passwordKey('una contraseña')];
  assert.deepEqual(calls[0].body, { username: 'Ana', password: legacy, passwordV2: current });
  assert.notEqual(legacy, current);
  assert.equal(await ACC.passwordKey('una contraseña'), await ACC.passwordKey('una contraseña'.normalize('NFD')), 'NFKC first');
  assert.equal(acc.fresh(), false, 'an authAt without a level (a session of before levels) is level 0');
  await acc.changePassword('una contraseña', 'otra clave larga');
  assert.equal(calls.at(-1).path, '/api/me/password');
  assert.deepEqual(calls.at(-1).body, { current, legacy: await ACC.legacyPasswordKey(acc.account.name, 'una contraseña'), password: await ACC.passwordKey('otra clave larga'), lang: 'en' });
  assert.equal(calls.at(-1).headers.authorization, 'Bearer jwt-ana');
  await acc.rename('Ana2');
  assert.deepEqual(calls.find((c) => c.path === '/api/me/username').body, { username: 'Ana2', lang: 'en' }, 'the Bearer only: the name salts no password any more');
  for (const c of calls) for (const v of Object.values(c.body ?? {})) assert.notEqual(v, 'una contraseña', 'never the typed password');
});

test('sign-in PR 4: "confirm it\'s you" asks for the level the server names; at level 2 PERFIL offers the password only and says a provider is not enough; an unlink asked for level 2 confirms again', async () => {
  const { acc } = client({ '/api/auth/unlink': () => res(403, { error: 'reauth_required', message: 'Confirma que eres tú: vuelve a entrar con tu cuenta', level: 2 }) });
  acc.signInWith(SESSION({ authAt: Date.now(), authLvl: 1 }));
  const e = await acc.unlink('discord').then(() => null, (err) => err);
  assert.equal(e.code, 'reauth_required');
  assert.equal(e.level, 2, 'the level comes with the refusal');
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/ui/screens/profile.ts', import.meta.url), 'utf8');
  // (sign-in PR 9 adds `resume`: the dialog a provider's round trip comes back to.)
  assert.match(src, /const fresh = \(go: \(\) => void, level: 1 \| 2 = 1, force = false, resume: string \| null = null\): void => \{\s*if \(!force && acc\.fresh\(level\)\)/, 'the sheet is for a level');
  assert.match(src, /const offered = level === 1 \? own : \[\];/, 'no provider at level 2');
  assert.match(src, /e\.code === 'reauth_required' && e\.level > level \? unlinkNow\(p, 2\)/, 'an unlink asked for level 2 asks again, once');
  const es = (await import('../src/locales/es.ts')).default;
  const en = (await import('../src/locales/en.ts')).default;
  assert.equal(es['profile.reauthPasswordOnly'], 'Para esto no alcanza con {providers}: usa tu contraseña.');
  assert.equal(en['profile.reauthPasswordOnly'], "{providers} isn't enough for this: use your password.");
});

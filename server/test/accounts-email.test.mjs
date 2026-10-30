// Sign-in PR 7 (the design's section 8, "email accounts, server side"): sign-up with a code before
// the account exists, sign-in by email, forgot and reset, the password behind a session, "confirm
// it's you" by a code, the mail caps and lanes, and the routes that go. Through the real Worker
// (index.ts) in front of a real AccountsDO on node:sqlite, as levels.test.mjs runs them. Mail goes
// to a fake `send_email` binding that only records (nothing leaves this machine), or to the stub.
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

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

// ---- the fake Turnstile (and nothing else: every other network call fails the test) -------------
globalThis.fetch = async (url, init) => {
  const u = String(url instanceof Request ? url.url : url);
  if (u === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    const body = new URLSearchParams(await new Response(init?.body).text());
    return new Response(JSON.stringify({ success: body.get('response') === 'good-token' }), { headers: { 'content-type': 'application/json' } });
  }
  throw new Error('BLOCKED network call in a test: ' + u);
};

const { AccountsDO } = await import('../src/AccountsDO.ts');
const ADO = await import('../src/AccountsDO.ts');
const A = await import('../src/accountRoutes.ts');
const ACC = await import('../../src/net/account.ts');
const worker = (await import('../src/index.ts')).default;

const SECRET = 'accounts-email-test-secret';
const ORIGIN = 'https://turbo-gol.com';
const PEPPER = 'c0ffee11'.repeat(8);
const MIN = 60_000;
const TURNSTILE_ON = { TURNSTILE_DISABLED: '0', TURNSTILE_SECRET: 'ts-secret', TURNSTILE_SITEKEY: 'ts-site' };
const TOK = { turnstileToken: 'good-token' };
const PW = 'una contraseña bien larga';
const KEY = await ACC.passwordKey(PW);
const WRONG = 'e'.repeat(64);

function sqlOn(db) {
  return {
    exec(query, ...bindings) {
      const stmt = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? stmt.all(...bindings) : (stmt.run(...bindings), []);
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
}

function txOn(db) {
  let depth = 0;
  return (fn) => {
    if (depth > 0) return fn();
    depth++;
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      depth--;
    }
  };
}

/** A live deploy's mail settings with a fake binding that records every message (MAIL_LIVE in a test env only: nothing can send). */
function liveMail(outbox, fail = () => false) {
  return { EMAIL: { send: async (m) => (fail(m) ? Promise.reject(Object.assign(new Error('boom'), { code: 'E_DELIVERY_FAILED' })) : void outbox.push(m)) }, MAIL_LIVE: '1', MAIL_FROM: 'Turbogol <no-reply@turbo-gol.com>', MAIL_LINK_ORIGIN: ORIGIN };
}

function makeEnv(extra = {}, { fail } = {}) {
  const db = new DatabaseSync(':memory:');
  const outbox = [];
  const flags = new Map();
  const env = { JWT_SECRET: SECRET, VITE_ORIGINS: ORIGIN, FLAGS: { get: async (k) => flags.get(k) ?? null }, TURNSTILE_DISABLED: '1', DISCORD_CLIENT_ID: 'did', DISCORD_CLIENT_SECRET: 'dsec', ...liveMail(outbox, fail), ...extra };
  const ctx = { storage: { sql: sqlOn(db), transactionSync: txOn(db), getAlarm: async () => 1, setAlarm: async () => {} }, blockConcurrencyWhile: (fn) => fn() };
  const obj = new AccountsDO(ctx, env);
  const calls = [];
  env.ACCOUNTS = { idFromName: (n) => ({ n }), get: () => ({ fetch: (url, init) => (calls.push(new URL(url).pathname), obj.fetch(new Request(url, init))) }) };
  return { env, obj, db, outbox, flags, calls };
}

let ipBase = 0;
const ips = () => {
  const base = ++ipBase;
  return (i = 0) => `198.18.${base}.${i + 1}`;
};

const setCookies = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean));
const cookieOf = (r, name) => {
  for (const c of setCookies(r)) {
    const m = new RegExp('^' + name + '=([^;]*)').exec(c ?? '');
    if (m) return m[1];
  }
  return null;
};

/** One request through the Worker; what it sends in waitUntil has gone out when this returns. */
async function req(env, method, path, { ip = '198.18.0.1', origin = ORIGIN, bearer, cookie, body, host = ORIGIN } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (origin !== null) headers.Origin = origin;
  if (bearer) headers.authorization = 'Bearer ' + bearer;
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const res = await worker.fetch(new Request(host + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await Promise.all(pending);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, json, raw: res };
}
const post = (env, path, o = {}) => req(env, 'POST', path, { body: {}, ...o });

const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const row = (obj, id) => obj.store.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray()[0];
/** The code and the link of a mail (its text part). */
const codeIn = (m) => /^(\d{6})$/m.exec(m.text)?.[1] ?? null;
const linkIn = (m) => {
  const x = /\/account#([a-z]+)=([A-Za-z0-9_-]+)/.exec(m.text);
  return x ? { kind: x[1], token: x[2] } : null;
};
const shape = (r) => ({ status: r.status, keys: Object.keys(r.json ?? {}).sort() });

const start = (env, email, ip, extra = {}) => post(env, '/api/auth/signup/start', { ip, body: { email, lang: 'es', ...extra } });
const finish = (env, proof, ip, extra = {}) => post(env, '/api/auth/signup/finish', { ip, body: { ...proof, username: 'Nueva' + Math.floor(Math.random() * 1e6), password: KEY, lang: 'es', tz: 'America/Argentina/Buenos_Aires', ...extra } });

/** A whole sign-up by code: the account's session answer, the mail and the attempt. */
async function signUp(env, outbox, email, ip, extra = {}) {
  const s = await start(env, email, ip);
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const m = outbox.at(-1);
  const f = await finish(env, { attempt: s.json.attempt, code: codeIn(m) }, ip, extra);
  assert.equal(f.status, 200, JSON.stringify(f.json));
  return { ...f, attempt: s.json.attempt, mail: m, rt: cookieOf(f.raw, '__Host-tg_rt') };
}

/** An account made straight in the store (a Discord one, a legacy one), with a verified address when `email` is given. */
function storeAccount(obj, name, { email, discord, pw } = {}) {
  const id = obj.store.register(name, pw ?? { hash: 'a'.repeat(64), salt: 'b'.repeat(32), iter: 100000, v: 1 }, [], 'f'.repeat(63) + String(name.length % 10), Date.now()).userId;
  if (pw === null) obj.store.sql.exec('UPDATE users SET pw_hash = NULL, pw_salt = NULL, pw_iter = NULL, pw_v = 0 WHERE id = ?', id);
  if (discord) obj.store.sql.exec('UPDATE users SET discord_id = ? WHERE id = ?', discord, id);
  if (email) assert.equal(obj.store.claimEmail(id, email, 'mail', Date.now()), 'ok');
  return id;
}

// ---- start and check ------------------------------------------------------------------------------

test('signup/start: the same status and keys for a new, a hinted, a claimed and a held address; the mailbox gets M1, M1 "hint", M2 and M2 "held"', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const owner = storeAccount(obj, 'Duena', { pw: null, email: 'duena@gmail.com', discord: 'd-duena' });
  const hinter = storeAccount(obj, 'Pista', { pw: null, discord: 'd-pista' });
  assert.equal(obj.store.setEmailHint(hinter, 'pista@x.com', 'discord'), 'ok');
  const holder = storeAccount(obj, 'Movida', { email: 'nueva@x.com' });
  obj.store.sql.exec('INSERT INTO email_holds (canon, user_id, email, until) VALUES (?, ?, ?, ?)', 'vieja@x.com', holder, 'Vieja@X.com', Date.now() + 7 * 24 * 60 * MIN);
  const answers = [];
  for (const email of ['nadie@x.com', 'pista@x.com', 'Due.na+tg@GoogleMail.com', 'vieja@x.com']) answers.push(await start(env, email, ip(answers.length)));
  for (const a of answers) assert.deepEqual(shape(a), { status: 200, keys: ['attempt', 'codeLength', 'resendAt'] });
  assert.equal(new Set(answers.map((a) => a.json.attempt)).size, 4);
  assert.deepEqual(answers.map((a) => a.json.codeLength), [6, 6, 6, 6]);
  const [m1, hint, m2, held] = outbox;
  assert.deepEqual(outbox.map((m) => m.to), ['nadie@x.com', 'pista@x.com', 'duena@gmail.com', 'Vieja@X.com'], 'M2 goes to the account\'s own address; "held" to the held one');
  assert.match(m1.subject, /^\d{6} es tu código de Turbogol$/);
  assert.equal(linkIn(m1).kind, 'verify');
  assert.match(hint.text, /Si ya entras a Turbogol con Discord/);
  assert.equal(codeIn(m2), null, 'M2 carries no code');
  assert.equal(m2.subject, 'Ya tienes una cuenta de Turbogol');
  assert.equal(linkIn(m2).kind, 'reset', 'it carries a reset link');
  assert.match(m2.text, /Entras con Discord/);
  assert.match(held.text, /queda reservado unos días para la cuenta Movida/);
  assert.equal(linkIn(held), null);
  // One row each, the decoys like the others (a random code hash, no flag).
  const rows = obj.store.sql.exec("SELECT * FROM mail_tokens WHERE purpose = 'signup' ORDER BY created_at").toArray();
  assert.equal(rows.length, 4);
  for (const r of rows) assert.deepEqual([typeof r.code_hash, r.code_hash.length, r.attempt_hash.length], ['string', 64, 64]);
  // A decoy fails as a wrong code does.
  const decoy = await post(env, '/api/auth/signup/check', { ip: ip(9), body: { attempt: answers[2].json.attempt, code: '123456' } });
  const wrong = await post(env, '/api/auth/signup/check', { ip: ip(9), body: { attempt: answers[0].json.attempt, code: codeIn(m1) === '123456' ? '654321' : '123456' } });
  assert.deepEqual([decoy.status, decoy.json], [wrong.status, wrong.json]);
  assert.deepEqual(wrong.json, { error: 'code_wrong', message: 'Ese código no es correcto', triesLeft: 4 });
});

test('signup/start: I9: the address and its canon come from what was typed; a body\'s canon, trust or verified field is never read', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const r = await start(env, 'Ana.Perez+tg@GoogleMail.com', ip(0), { canon: 'victima@x.com', emailCanon: 'victima@x.com', email_canon: 'victima@x.com', trust: 'auth', verified: true });
  assert.equal(r.status, 200);
  const t = obj.store.sql.exec("SELECT email, email_canon FROM mail_tokens WHERE purpose = 'signup'").toArray()[0];
  assert.deepEqual(t, { email: 'ana.perez+tg@googlemail.com', email_canon: 'anaperez@gmail.com' });
  const f = await finish(env, { attempt: r.json.attempt, code: codeIn(outbox[0]) }, ip(0), { canon: 'victima@x.com', email: 'victima@x.com', verified: false });
  assert.equal(f.status, 200);
  assert.deepEqual([row(obj, f.json.playerId).email, row(obj, f.json.playerId).email_canon], ['ana.perez+tg@googlemail.com', 'anaperez@gmail.com']);
  for (const bad of ['no-arroba', 'a@b', 'x@y.invalid', '', 42]) assert.deepEqual([(await start(env, bad, ip(1))).status, (await start(env, bad, ip(1))).json.error], [400, 'bad_email'], String(bad));
});

test('signup/check: wrong codes count and the fifth is code_expired; the right code then is dead too; nothing is consumed by a right one', async () => {
  const { env, outbox } = makeEnv();
  const ip = ips();
  const s = await start(env, 'cinco@x.com', ip(0));
  const code = codeIn(outbox[0]);
  const other = code === '000000' ? '111111' : '000000';
  const ok = await post(env, '/api/auth/signup/check', { ip: ip(0), body: { attempt: s.json.attempt, code } });
  assert.deepEqual([ok.status, ok.json], [200, { email: 'cinco@x.com' }]);
  assert.equal((await post(env, '/api/auth/signup/check', { ip: ip(0), body: { attempt: s.json.attempt, code: code.slice(0, 3) + ' ' + code.slice(3) } })).status, 200, 'a pasted code with a space');
  const left = [];
  for (let i = 0; i < 5; i++) {
    const r = await post(env, '/api/auth/signup/check', { ip: ip(0), body: { attempt: s.json.attempt, code: other } });
    left.push(r.json.error === 'code_wrong' ? r.json.triesLeft : r.json.error);
  }
  assert.deepEqual(left, [4, 3, 2, 1, 'code_expired']);
  const dead = await post(env, '/api/auth/signup/check', { ip: ip(0), body: { attempt: s.json.attempt, code } });
  assert.deepEqual([dead.status, dead.json.error], [410, 'code_expired']);
  // Another browser has no attempt id: a code alone proves nothing.
  const s2 = await start(env, 'cinco@x.com', ip(1));
  const noId = await post(env, '/api/auth/signup/check', { ip: ip(1), body: { attempt: 'A'.repeat(43), code: codeIn(outbox[1]) } });
  assert.deepEqual([noId.status, noId.json.error], [410, 'code_expired']);
  assert.equal((await post(env, '/api/auth/signup/check', { ip: ip(1), body: { attempt: s2.json.attempt, code: codeIn(outbox[1]) } })).status, 200);
});

test('signup/check: an address gets 10 failed codes a day, whatever the attempts; then its codes are refused for a day (the right one too) while its link still works', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const t0 = Date.now();
  obj.now = () => t0;
  const atts = [];
  for (let i = 0; i < 3; i++) {
    atts.push((await start(env, 'blanco@x.com', ip(i))).json.attempt);
    obj.now = () => t0 + (i + 1) * 61_000;
  }
  const code = (i) => codeIn(outbox[i]);
  const wrong = (i) => (code(i) === '999999' ? '888888' : '999999');
  const tally = [];
  for (let n = 0; n < 12; n++) {
    const i = n < 5 ? 0 : n < 10 ? 1 : 2;
    const r = await post(env, '/api/auth/signup/check', { ip: ip(5), body: { attempt: atts[i], code: wrong(i) } });
    tally.push(r.status);
  }
  assert.deepEqual(tally, [400, 400, 400, 400, 410, 400, 400, 400, 400, 410, 429, 429], '5 + 5 failures, then the address is paused');
  const right = await post(env, '/api/auth/signup/check', { ip: ip(6), body: { attempt: atts[2], code: code(2) } });
  assert.deepEqual([right.status, right.json.error], [429, 'throttled']);
  assert.ok(right.json.retryAfterMs > 23 * 60 * MIN);
  // The link of that mail still makes the account.
  const f = await finish(env, { token: linkIn(outbox[2]).token }, ip(6));
  assert.equal(f.status, 200, JSON.stringify(f.json));
  // A day later the address's codes work again (another sign-up of it would; this one is used).
  obj.now = () => t0 + 24 * 60 * MIN + 5 * MIN;
  assert.equal((await start(env, 'otra@x.com', ip(7))).status, 200);
  assert.equal((await post(env, '/api/auth/signup/check', { ip: ip(7), body: { attempt: (await start(env, 'blanco2@x.com', ip(8))).json.attempt, code: codeIn(outbox.at(-1)) } })).status, 200);
});

test('a sign-up link works once: the finish by its token makes the account; the same link again is already_created for 10 minutes, then link_invalid; a GET-like check consumes nothing', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const t0 = Date.now();
  obj.now = () => t0;
  await start(env, 'enlace@x.com', ip(0));
  const token = linkIn(outbox[0]).token;
  for (let i = 0; i < 3; i++) assert.deepEqual((await post(env, '/api/auth/signup/check', { ip: ip(0), body: { token } })).json, { email: 'enlace@x.com' });
  const f = await finish(env, { token }, ip(0), { username: 'Enlazada' });
  assert.equal(f.status, 200);
  const again = await finish(env, { token }, ip(0), { username: 'Otra' });
  assert.deepEqual([again.status, again.json.error, again.json.email], [409, 'already_created', 'enlace@x.com']);
  obj.now = () => t0 + 11 * MIN;
  const late = await finish(env, { token }, ip(0), { username: 'Otra' });
  assert.deepEqual([late.status, late.json.error], [410, 'link_invalid']);
  assert.deepEqual([(await post(env, '/api/auth/signup/check', { ip: ip(0), body: { token: 'Q'.repeat(43) } })).status], [410], 'an unknown link');
  assert.equal(obj.store.sql.exec('SELECT COUNT(*) AS n FROM users').toArray()[0].n, 1);
});

// ---- resend -----------------------------------------------------------------------------------------

test('code/resend: the same code and link again, the code alive 15 minutes past the resend (at most 60 from the start), the tries kept; 1 a minute, 3 per attempt', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const t0 = Date.now();
  obj.now = () => t0;
  const s = await start(env, 'reenvio@x.com', ip(0));
  const first = outbox[0];
  const code = codeIn(first);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 2; i++) await post(env, '/api/auth/signup/check', { ip: ip(0), body: { attempt: s.json.attempt, code: wrong } });
  const soon = await post(env, '/api/auth/code/resend', { ip: ip(0), body: { attempt: s.json.attempt } });
  assert.deepEqual([soon.status, soon.json.error], [429, 'email_rate_limited'], 'not before a minute');
  const sentAt = [];
  for (let i = 1; i <= 3; i++) {
    obj.now = () => t0 + i * 14 * MIN;
    const r = await post(env, '/api/auth/code/resend', { ip: ip(0), body: { attempt: s.json.attempt } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(Object.keys(r.json).sort(), ['resendAt', 'resendsLeft']);
    assert.equal(r.json.resendsLeft, 3 - i);
    sentAt.push(obj.now());
    assert.equal(codeIn(outbox.at(-1)), code, 'the same code');
    assert.deepEqual(linkIn(outbox.at(-1)), linkIn(first), 'the same link');
  }
  obj.now = () => t0 + 4 * 14 * MIN;
  const fourth = await post(env, '/api/auth/code/resend', { ip: ip(0), body: { attempt: s.json.attempt } });
  assert.deepEqual([fourth.status, fourth.json.error], [429, 'email_rate_limited'], 'three per attempt');
  // 42 + 15 = 57 minutes: alive at 56, the tries still counted (2 used: 3 left).
  obj.now = () => t0 + 56 * MIN;
  const w = await post(env, '/api/auth/signup/check', { ip: ip(0), body: { attempt: s.json.attempt, code: wrong } });
  assert.deepEqual([w.status, w.json.triesLeft], [400, 2], 'the tries were not reset');
  assert.equal((await post(env, '/api/auth/signup/check', { ip: ip(0), body: { attempt: s.json.attempt, code } })).status, 200);
  obj.now = () => t0 + 58 * MIN;
  assert.equal((await post(env, '/api/auth/signup/check', { ip: ip(0), body: { attempt: s.json.attempt, code } })).json.error, 'code_expired');
  // The 60-minute ceiling: a resend at 50 minutes keeps the code only to 60.
  const s2 = await start(env, 'techo@x.com', ip(1));
  const t1 = obj.now();
  obj.now = () => t1 + 50 * MIN;
  assert.equal((await post(env, '/api/auth/code/resend', { ip: ip(1), body: { attempt: s2.json.attempt } })).status, 200);
  obj.now = () => t1 + 61 * MIN;
  assert.equal((await post(env, '/api/auth/signup/check', { ip: ip(1), body: { attempt: s2.json.attempt, code: codeIn(outbox.at(-1)) } })).json.error, 'code_expired');
  // The link lives its 24 hours whatever the code does.
  assert.equal((await post(env, '/api/auth/signup/check', { ip: ip(1), body: { token: linkIn(outbox.at(-1)).token } })).status, 200);
});

// ---- finish -------------------------------------------------------------------------------------------

test('signup/finish: a pw_v 2 account (peppered) with its verified address, at level 2 with method password, the news consent, the device cookie; other accounts\' hints of the address cleared', async () => {
  const { env, obj, outbox } = makeEnv({ PASSWORD_PEPPER: PEPPER });
  const ip = ips();
  const hinter = storeAccount(obj, 'Pista', { pw: null, discord: 'd-pista' });
  obj.store.setEmailHint(hinter, 'Nueva.Cuenta@gmail.com', 'discord');
  const r = await signUp(env, outbox, 'nueva.cuenta@gmail.com', ip(0), { username: 'Nueva_1', news: true });
  assert.equal(r.json.name, 'Nueva_1');
  const u = row(obj, r.json.playerId);
  assert.deepEqual([u.pw_v, u.pw_kid, u.email, u.email_canon, u.email_proof, u.lang, u.tz], [2, 'p1', 'nueva.cuenta@gmail.com', 'nuevacuenta@gmail.com', 'mail', 'es', 'America/Argentina/Buenos_Aires']);
  assert.ok(u.email_verified_at > 0);
  assert.equal(await A.verifyPassword(KEY, obj.store.credentials('Nueva_1'), { PASSWORD_PEPPER: PEPPER }), true);
  const c = claims(r.json.session);
  assert.equal(c.aal, 2);
  assert.ok(Math.abs(c.aat * 1000 - Date.now()) < 5000);
  const fam = obj.store.sql.exec('SELECT auth_lvl, method FROM refresh WHERE user_id = ?', r.json.playerId).toArray();
  assert.deepEqual(fam, [{ auth_lvl: 2, method: 'password' }]);
  assert.ok(cookieOf(r.raw, '__Host-tg_dv'), 'a password was typed: the device cookie');
  assert.deepEqual(obj.store.sql.exec("SELECT kind, version, granted, source FROM consents WHERE user_id = ?", r.json.playerId).toArray(), [{ kind: 'news', version: 'news-v1', granted: 1, source: 'signup' }]);
  assert.equal(row(obj, hinter).email_hint, null, 'the hint went');
  const me = await req(env, 'GET', '/api/me', { bearer: r.json.session, ip: ip(0) });
  assert.deepEqual([me.json.email, me.json.emailVerified, me.json.legacy, me.json.news, me.json.hasPassword], ['nueva.cuenta@gmail.com', true, false, true, true]);
  // The used rows of the address keep no address.
  for (const t of obj.store.sql.exec("SELECT email, email_canon, payload FROM mail_tokens WHERE purpose = 'signup'").toArray()) assert.deepEqual(t, { email: '', email_canon: '', payload: '{}' });
  // Without the opt-in, no news consent.
  const r2 = await signUp(env, outbox, 'sin.novedades@x.com', ip(1));
  assert.equal(obj.store.sql.exec('SELECT COUNT(*) AS n FROM consents WHERE user_id = ?', r2.json.playerId).toArray()[0].n, 0);
  assert.equal((await post(env, '/api/auth/signup/finish', { ip: ip(1), body: { attempt: 'A'.repeat(43), code: '123456', username: 'Ana', password: 'corta' } })).json.error, 'bad_password');
});

test('signup/finish: two finishes on one address give one 200 and one 409; a repeat within 10 minutes is already_created; an address claimed meanwhile is email_taken', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const t0 = Date.now();
  obj.now = () => t0;
  const a = await start(env, 'carrera@x.com', ip(0));
  obj.now = () => t0 + 1000;
  const b = await start(env, 'carrera@x.com', ip(1));
  const [ra, rb] = await Promise.all([
    finish(env, { attempt: a.json.attempt, code: codeIn(outbox[0]) }, ip(0), { username: 'Carrera' }),
    finish(env, { attempt: b.json.attempt, code: codeIn(outbox[1]) }, ip(1), { username: 'Carrera2' }),
  ]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
  const lost = ra.status === 409 ? ra : rb;
  assert.deepEqual([lost.json.error, lost.json.email], ['already_created', 'carrera@x.com']);
  const again = await finish(env, { attempt: a.json.attempt, code: codeIn(outbox[0]) }, ip(0), { username: 'Carrera3' });
  assert.deepEqual([again.status, again.json.error], [409, 'already_created'], 'the lost answer of a bad network');
  assert.equal(obj.store.sql.exec("SELECT COUNT(*) AS n FROM users WHERE email_canon = 'carrera@x.com'").toArray()[0].n, 1);
  // The race of section 7: the address claimed between the check and the finish (a Google claim, a move).
  const c = await start(env, 'robada@x.com', ip(2));
  const other = storeAccount(obj, 'Ganadora', { pw: null, discord: 'd-gana' });
  assert.equal(obj.store.claimEmail(other, 'robada@x.com', 'google', obj.now()), 'ok');
  const taken = await finish(env, { attempt: c.json.attempt, code: codeIn(outbox.at(-1)) }, ip(2));
  assert.deepEqual([taken.status, taken.json.error], [409, 'email_taken']);
});

test('signup/finish: a reserved name is name_reserved and a protected look-alike name_lookalike, each with a free suggestion; a taken name username_taken; an ordinary shared skeleton passes; nothing is consumed', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const owner = storeAccount(obj, 'Proyecto', { email: 'proyecto@x.com' });
  storeAccount(obj, 'Juan_1');
  obj.store.rebuildProtectedSkeletons([owner]);
  const s = await start(env, 'nombres@x.com', ip(0));
  const proof = { attempt: s.json.attempt, code: codeIn(outbox[0]) };
  const reserved = await finish(env, proof, ip(0), { username: 'Adm1n' });
  assert.deepEqual([reserved.status, reserved.json.error], [400, 'name_reserved']);
  assert.match(reserved.json.suggest, /^Jugador\d{4}$/);
  const look = await finish(env, proof, ip(0), { username: 'Pr0yect0' });
  assert.deepEqual([look.status, look.json.error], [409, 'name_lookalike']);
  assert.equal(ACC.usernameIssue(look.json.suggest), null);
  assert.equal(obj.store.isLookalike(look.json.suggest, null), false);
  const taken = await finish(env, proof, ip(0), { username: 'juan_1' });
  assert.deepEqual([taken.status, taken.json.error], [409, 'username_taken']);
  assert.match(taken.json.suggest, /^juan_\d{4}$/);
  const bad = await finish(env, proof, ip(0), { username: 'tg-verify.com' });
  assert.deepEqual([bad.status, bad.json.error], [400, 'bad_username']);
  const ok = await finish(env, proof, ip(0), { username: 'Juani' });
  assert.equal(ok.status, 200, 'the same code still works: nothing was consumed; ' + JSON.stringify(ok.json));
});

test('signup/finish: new accounts per network: 10 a day for an IPv6 /64; the same IPv4 address takes 20 (a school), far from its 200', async () => {
  const { env, outbox } = makeEnv();
  // Each mail from a /64 of its own (the mail caps are apart); every finish from one /64.
  const home = (i) => `2001:db8:77:1::${i + 1}`;
  for (let i = 0; i < 10; i++) {
    const s = await start(env, `v6-${i}@x.com`, `2001:db8:77:${i + 10}::1`);
    assert.equal((await finish(env, { attempt: s.json.attempt, code: codeIn(outbox.at(-1)) }, home(i))).status, 200);
  }
  const s = await start(env, 'v6-10@x.com', '2001:db8:77:99::1');
  assert.equal(s.status, 200);
  const f = await finish(env, { attempt: s.json.attempt, code: codeIn(outbox.at(-1)) }, home(10));
  assert.deepEqual([f.status, f.json.error], [429, 'rate_limited']);
  assert.ok(f.json.retryAfterMs > 23 * 60 * MIN);
  for (let i = 0; i < 20; i++) await signUp(env, outbox, `aula-${i}@x.com`, '203.0.113.77');
});

// ---- caps, lanes, the kill flag ------------------------------------------------------------------------

test('mail caps: one address takes 5 mails an hour (all kinds alike, resends too); an IPv6 /64 10 anonymous mails an hour, an IPv4 address 200; refusals count nothing', async () => {
  const { env, outbox } = makeEnv();
  const ip = ips();
  const tally = [];
  for (let i = 0; i < 7; i++) tally.push((await start(env, 'bomba@x.com', ip(i))).status);
  assert.deepEqual(tally, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal(outbox.filter((m) => m.to === 'bomba@x.com').length, 5);
  const r = await start(env, 'bomba@x.com', ip(9));
  assert.equal(r.json.error, 'email_rate_limited');
  const net = [];
  for (let i = 0; i < 12; i++) net.push((await start(env, `red${i}@x.com`, `2001:db8:78:2::${i + 1}`)).status);
  assert.deepEqual(net, [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 429, 429]);
  for (let i = 0; i < 40; i++) assert.equal((await start(env, `escuela${i}@x.com`, '203.0.113.78')).status, 200, 'a school behind one IPv4 address');
});

test('the signup lane stops at 60 % of EMAIL_DAILY_CAP, the same for every address; the kill flag gives 503 email_paused everywhere and auth.email false', async () => {
  const { env, outbox, flags } = makeEnv({ EMAIL_DAILY_CAP: '10' });
  const ip = ips();
  for (let i = 0; i < 6; i++) assert.equal((await start(env, `l${i}@x.com`, ip(i))).status, 200);
  const full = await start(env, 'l6@x.com', ip(6));
  assert.deepEqual([full.status, full.json.error], [429, 'email_rate_limited']);
  assert.equal(outbox.length, 6);
  assert.equal((await req(env, 'GET', '/api/config')).json.auth.email, true);
  flags.set('email_off', '1');
  const off = await start(env, 'l7@x.com', ip(7));
  assert.deepEqual([off.status, off.json.error], [503, 'email_paused']);
  assert.equal((await post(env, '/api/auth/code/resend', { ip: ip(7), body: { attempt: 'A'.repeat(43) } })).status, 503);
  assert.equal((await req(env, 'GET', '/api/config')).json.auth.email, false);
});

test('the automatic pause (10 failed sends in 10 minutes) stops the signup lane only; failures log kind, lane and code, never an address', async () => {
  let failing = true;
  const { env, obj, outbox } = makeEnv({}, { fail: () => failing });
  const ip = ips();
  const logs = [];
  const warn = console.warn;
  console.warn = (...a) => logs.push(a.join(' '));
  try {
    for (let i = 0; i < 10; i++) assert.equal((await start(env, `f${i}@x.com`, ip(i))).status, 200, 'the answer never says whether the mail went');
  } finally {
    console.warn = warn;
  }
  assert.equal(logs.filter((l) => l === 'mail_failed kind=verify_signup lane=signup err=E_DELIVERY_FAILED').length, 10);
  assert.ok(logs.every((l) => !/@/.test(l)), logs.join('\n'));
  failing = false;
  const paused = await start(env, 'f10@x.com', ip(10));
  assert.deepEqual([paused.status, paused.json.error], [503, 'email_paused']);
  assert.equal(outbox.length, 0);
  // Thirty minutes later the lane sends again.
  const t = Date.now();
  obj.now = () => t + 31 * MIN;
  assert.equal((await start(env, 'f11@x.com', ip(11))).status, 200);
  assert.equal(outbox.length, 1);
});

// ---- the gate, Turnstile, the config, the outbox ---------------------------------------------------------

test('signup/start needs Turnstile (before the AccountsDO hears of it); check, finish and resend need none (bound to the attempt)', async () => {
  const { env, outbox, calls } = makeEnv(TURNSTILE_ON);
  const ip = ips();
  for (const extra of [{}, { turnstileToken: 'bad-token' }]) {
    const r = await start(env, 'ts@x.com', ip(0), extra);
    assert.deepEqual([r.status, r.json.error], [403, 'turnstile_failed']);
  }
  assert.equal(calls.filter((p) => p.startsWith('/signup')).length, 0);
  const s = await start(env, 'ts@x.com', ip(0), TOK);
  assert.equal(s.status, 200);
  assert.equal((await post(env, '/api/auth/signup/check', { ip: ip(0), body: { attempt: s.json.attempt, code: codeIn(outbox[0]) } })).status, 200);
  assert.equal((await finish(env, { attempt: s.json.attempt, code: codeIn(outbox[0]) }, ip(0))).status, 200);
});

test('a deploy without MAIL_LIVE (or without MAIL_LINK_ORIGIN) answers 503 email_unconfigured and shows auth.email false; wrangler dev uses the stub, whose outbox only DEV_AUTH=1 on loopback opens', async () => {
  const noLive = makeEnv({ MAIL_LIVE: undefined });
  const r = await start(noLive.env, 'x@x.com', '198.18.250.1');
  assert.deepEqual([r.status, r.json.error], [503, 'email_unconfigured']);
  assert.equal((await req(noLive.env, 'GET', '/api/config')).json.auth.email, false);
  assert.equal(noLive.calls.length, 0, 'nothing counted');
  const noOrigin = makeEnv({ MAIL_LINK_ORIGIN: undefined });
  assert.equal((await start(noOrigin.env, 'x@x.com', '198.18.250.2')).json.error, 'email_unconfigured');
  // wrangler dev: a loopback host, the stub (no binding called), the link to the loopback page.
  const dev = makeEnv({ MAIL_LIVE: '1', DEV_AUTH: '1' });
  const local = { host: 'http://127.0.0.1:9019', origin: 'http://127.0.0.1:5519', ip: '127.0.0.1' };
  assert.equal((await req(dev.env, 'GET', '/api/config', local)).json.auth.email, true);
  const s = await req(dev.env, 'POST', '/api/auth/signup/start', { ...local, body: { email: 'dev@x.com' } });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  assert.equal(dev.outbox.length, 0, 'the binding is never called on loopback, MAIL_LIVE or not');
  const box = await req(dev.env, 'GET', '/api/dev/mail', local);
  assert.equal(box.status, 200);
  const m = box.json.messages.find((x) => x.to === 'dev@x.com');
  assert.match(m.link, /^http:\/\/127\.0\.0\.1:5519\/account#verify=[A-Za-z0-9_-]{43}$/);
  assert.match(m.code, /^\d{6}$/);
  // Closed: the 404 of any unknown route, on production's host or without DEV_AUTH.
  for (const [env, o] of [[dev.env, {}], [noLive.env, local]]) {
    const closed = await req(env, 'GET', '/api/dev/mail', o);
    assert.deepEqual([closed.status, closed.json.error], [404, 'not_found']);
  }
});

test('every link of a mail is MAIL_LINK_ORIGIN\'s, the token in the fragment, whatever the Host and Origin say', async () => {
  const { env, outbox } = makeEnv();
  // A request that names another site as both its Host and its Origin (production's Host is always
  // turbo-gol.com, but nothing here relies on it): the mail still links only to MAIL_LINK_ORIGIN.
  const r = await req(env, 'POST', '/api/auth/signup/start', { host: 'https://evil.example', origin: 'https://evil.example', ip: '198.18.251.1', body: { email: 'host@x.com' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  for (const url of outbox[0].text.match(/https?:\/\/\S+/g)) assert.ok(url.startsWith('https://turbo-gol.com/account#'), url);
  assert.doesNotMatch(outbox[0].html, /evil\.example/);
  assert.equal(outbox[0].from.email, 'no-reply@turbo-gol.com');
  assert.equal(outbox[0].headers['Auto-Submitted'], 'auto-generated');
});

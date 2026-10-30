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

test('signup/finish (review): a dual-stack school on one IPv6 /64 signs up a class of 25, as one IPv4 address does; a /64 has the IPv4 cap, 200 new accounts a day', async () => {
  const { env, obj, outbox } = makeEnv({ EMAIL_DAILY_CAP: '1000' });
  assert.deepEqual(ADO.NEW_ACCOUNTS, { v6: { day: 200 }, v4: { day: 200 } });
  // 25 students, 25 addresses of one /64 (SLAAC): every mail, every code, every account.
  for (let i = 0; i < 25; i++) await signUp(env, outbox, `alumno${i}@x.com`, `2001:db8:77:1::${(i + 1).toString(16)}`);
  for (let i = 0; i < 25; i++) await signUp(env, outbox, `aula-${i}@x.com`, '203.0.113.77');
  // The cap is still there, at an IPv4 address's number: a /64 with 199 accounts today takes one more.
  const key = await obj.throttleKey('na', '2001:db8:77:2::/64');
  obj.store.mailWindowsWrite(new Map([[key, { hour_at: Date.now(), hour_n: 0, day_at: Date.now(), day_n: 199 }]]));
  await signUp(env, outbox, 'el200@x.com', '2001:db8:77:2::1');
  const s = await start(env, 'el201@x.com', '2001:db8:77:2::2');
  const f = await finish(env, { attempt: s.json.attempt, code: codeIn(outbox.at(-1)) }, '2001:db8:77:2::2');
  assert.deepEqual([f.status, f.json.error], [429, 'rate_limited']);
  assert.ok(f.json.retryAfterMs > 23 * 60 * MIN);
});

// ---- caps, lanes, the kill flag ------------------------------------------------------------------------

test('mail caps: one address takes 5 mails an hour (all kinds alike, resends too); an IPv6 /64 and an IPv4 address 200 anonymous mails an hour each (a school on either); refusals count nothing', async () => {
  const { env, obj, outbox } = makeEnv({ EMAIL_DAILY_CAP: '1000' });
  const ip = ips();
  const tally = [];
  for (let i = 0; i < 7; i++) tally.push((await start(env, 'bomba@x.com', ip(i))).status);
  assert.deepEqual(tally, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal(outbox.filter((m) => m.to === 'bomba@x.com').length, 5);
  const r = await start(env, 'bomba@x.com', ip(9));
  assert.equal(r.json.error, 'email_rate_limited');
  for (let i = 0; i < 30; i++) assert.equal((await start(env, `red${i}@x.com`, `2001:db8:78:2::${(i + 1).toString(16)}`)).status, 200, 'a dual-stack school on one /64');
  for (let i = 0; i < 30; i++) assert.equal((await start(env, `escuela${i}@x.com`, '203.0.113.78')).status, 200, 'a school behind one IPv4 address');
  // At 199 this hour, a /64 takes one more mail and then waits for the hour; forgot counts on the same window.
  const key = await obj.throttleKey('mn', '2001:db8:78:3::/64');
  obj.store.mailWindowsWrite(new Map([[key, { hour_at: Date.now(), hour_n: 199, day_at: Date.now(), day_n: 199 }]]));
  assert.equal((await start(env, 'red-200@x.com', '2001:db8:78:3::1')).status, 200);
  const full = await start(env, 'red-201@x.com', '2001:db8:78:3::2');
  assert.deepEqual([full.status, full.json.error], [429, 'rate_limited']);
  assert.ok(full.json.retryAfterMs > 59 * MIN);
  const fg = await post(env, '/api/auth/forgot', { ip: '2001:db8:78:3::3', body: { email: 'red-202@x.com', lang: 'en' } });
  assert.deepEqual([fg.status, fg.json.error], [429, 'rate_limited']);
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

// ---- sign-in -----------------------------------------------------------------------------------------

const AUTH = await import('../src/auth.ts');
const signin = (env, email, password, ip, cookie) => post(env, '/api/auth/signin', { ip, cookie, body: { email, password } });
const bearerOf = (sub, name, extra = {}) => AUTH.signJwt(SECRET, { typ: 's', sub, name, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, acct: 1, ...extra });

/** One charged failure straight at the object (the counters only, no PBKDF2): what a wrong password counts. */
async function doFail(obj, subject, ip) {
  const headers = { [AUTH.INTERNAL_HEADER]: await AUTH.internalSecret(SECRET), 'content-type': 'application/json' };
  const r = await obj.fetch(new Request('https://accounts/auth-begin', { method: 'POST', headers, body: JSON.stringify({ ...subject, ip, charge: true }) }));
  return r.status === 200 ? 401 : r.status;
}

test('signin: an unknown address, a wrong password, a legacy key not re-keyed and an OAuth-only account get one answer after one server stage at the real parameters; the right password signs in at level 2 (method password); banned only after it', async () => {
  const { env, obj, outbox } = makeEnv({ PASSWORD_PEPPER: PEPPER });
  const ip = ips();
  const real = await signUp(env, outbox, 'Real.Cuenta@gmail.com', ip(0), { username: 'Real' });
  const legacy = storeAccount(obj, 'Vieja', { pw: await A.newPasswordRecord(await ACC.legacyPasswordKey('Vieja', PW), 1), email: 'vieja@x.com' });
  storeAccount(obj, 'Solo', { pw: null, discord: 'd-solo', email: 'solo@x.com' });
  const subtle = crypto.subtle;
  const [derive, sign] = [subtle.deriveBits, subtle.sign];
  const hex = (b) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength)).toString('hex');
  let seen = [];
  subtle.deriveBits = async function (alg, key, len) {
    if (alg.name === 'PBKDF2') seen.push(`pbkdf2:${alg.iterations}:${new Uint8Array(alg.salt).byteLength}`);
    return derive.call(this, alg, key, len);
  };
  subtle.sign = async function (alg, key, data) {
    if ([WRONG, KEY].includes(hex(data))) seen.push('hmac(key)');
    return sign.call(this, alg, key, data);
  };
  const answers = [];
  try {
    for (const [email, key] of [['nadie@x.com', WRONG], ['real.cuenta@gmail.com', WRONG], ['vieja@x.com', KEY], ['solo@x.com', KEY]]) {
      seen = [];
      const r = await signin(env, email, key, ip(answers.length + 1));
      answers.push({ status: r.status, json: r.json, seen });
    }
  } finally {
    subtle.deriveBits = derive;
    subtle.sign = sign;
  }
  for (const a of answers) {
    assert.deepEqual([a.status, a.json], [401, { error: 'bad_credentials', message: 'Correo o contraseña incorrectos' }]);
    assert.deepEqual(a.seen, ['hmac(key)', 'pbkdf2:100000:16'], "the pepper and one PBKDF2 at a real record's parameters");
  }
  assert.equal(row(obj, legacy).pw_v, 1, 'a legacy key signs in by its username, never here');
  // The right password, by any spelling of the address's canon.
  const ok = await signin(env, 'realcuenta+tg@GoogleMail.com', KEY, ip(8));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.playerId, real.json.playerId);
  assert.equal(claims(ok.json.session).aal, 2);
  assert.ok(cookieOf(ok.raw, '__Host-tg_dv'));
  const fams = obj.store.sql.exec('SELECT method, auth_lvl FROM refresh WHERE user_id = ? ORDER BY created_at', real.json.playerId).toArray();
  assert.deepEqual(fams.at(-1), { method: 'password', auth_lvl: 2 });
  // Suspended: said only after the right password.
  obj.store.sql.exec('UPDATE users SET banned = 1 WHERE id = ?', real.json.playerId);
  assert.equal((await signin(env, 'real.cuenta@gmail.com', WRONG, ip(9))).status, 401);
  assert.equal((await signin(env, 'real.cuenta@gmail.com', KEY, ip(9))).json.error, 'banned');
  assert.equal((await post(env, '/api/auth/signin', { ip: ip(9), body: { email: 'x@x.com', password: 'corta' } })).status, 400);
});

test('signin needs Turnstile every time, before the AccountsDO hears of it', async () => {
  const { env, obj, calls } = makeEnv(TURNSTILE_ON);
  const ip = ips();
  storeAccount(obj, 'Ts', { pw: await A.newPasswordRecord(KEY, 2), email: 'ts@x.com' });
  for (const extra of [{}, { turnstileToken: 'bad-token' }]) {
    const r = await post(env, '/api/auth/signin', { ip: ip(0), body: { email: 'ts@x.com', password: KEY, ...extra } });
    assert.deepEqual([r.status, r.json.error], [403, 'turnstile_failed']);
  }
  assert.equal(calls.filter((p) => p.startsWith('/auth')).length, 0);
  assert.equal((await post(env, '/api/auth/signin', { ip: ip(0), body: { email: 'ts@x.com', password: KEY, ...TOK } })).status, 200);
});

test("signin throttles (auth/levels' THROTTLE_RULES, keyed by the typed canon): the pair 5, the canon 50 a day from unknown browsers, the network 600 in 15 minutes for IPv4 and for an IPv6 /64 (its /48's 300 binds first), one budget with the username sign-in; the account's own browser is never paused", async () => {
  const { env, obj } = makeEnv();
  storeAccount(obj, 'Blanco', { pw: await A.newPasswordRecord(KEY, 2), email: 'blanco@x.com' });
  // The account's own browser (its device cookie, from an earlier sign-in).
  const own = await signin(env, 'blanco@x.com', KEY, '100.70.9.1');
  const dv = '__Host-tg_dv=' + cookieOf(own.raw, '__Host-tg_dv');
  // The pair: one address from one network.
  const pair = [];
  for (let i = 0; i < 7; i++) pair.push((await signin(env, 'blanco@x.com', WRONG, '100.70.0.1')).status);
  assert.deepEqual(pair, [401, 401, 401, 401, 401, 429, 429]);
  // The canon: 50 failures a day from browsers it does not know, wherever they come from (5 came above).
  for (let i = 0; i < 45; i++) assert.equal(await doFail(obj, { email: 'Blanco@x.com' }, `100.71.${i}.1`), 401);
  const paused = await signin(env, 'blanco@x.com', KEY, '100.72.0.1');
  assert.deepEqual([paused.status, paused.json.error], [429, 'throttled'], 'the right password too, from an unknown browser');
  assert.equal((await signin(env, 'blanco@x.com', KEY, '100.72.0.2', dv)).status, 200, 'its own browser still signs in');
  // The network: a school's IPv4 address shares 600 failures between the email and the username sign-ins.
  for (let i = 0; i < 599; i++) assert.equal(await doFail(obj, i % 2 ? { email: `typo${i}@x.com` } : { username: `typo${i}` }, '203.0.113.90'), 401);
  storeAccount(obj, 'Alumna', { pw: await A.newPasswordRecord(KEY, 2), email: 'alumna@x.com' });
  assert.equal((await signin(env, 'alumna@x.com', KEY, '203.0.113.90')).status, 200, 'a success gives its charge back');
  assert.equal(await doFail(obj, { email: 'typo-600@x.com' }, '203.0.113.90'), 401, 'the 600th failure');
  assert.equal(await doFail(obj, { username: 'typo-601' }, '203.0.113.90'), 429, 'then the pause, for both paths');
  // IPv6: one /64 has an IPv4 address's 600, and its /48's 300 binds first.
  for (let i = 0; i < 300; i++) assert.equal(await doFail(obj, { email: `v6-${i}@x.com` }, `2001:db8:90:${i % 40}::1`), 401);
  assert.equal(await doFail(obj, { email: 'v6-x@x.com' }, '2001:db8:90:99::1'), 429, 'the /48 pauses');
});

// ---- forgot and reset ----------------------------------------------------------------------------------

const forgot = (env, email, ip) => post(env, '/api/auth/forgot', { ip, body: { email, lang: 'en' } });

test('forgot: the same answer either way; M3 ("reset" or "create") only to an account that claimed the address, never to a stranger, a hint or a held address; the caps count both alike', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const withPw = storeAccount(obj, 'ConClave', { pw: await A.newPasswordRecord(KEY, 2), email: 'con@x.com' });
  storeAccount(obj, 'SinClave', { pw: null, discord: 'd-sin', email: 'sin@x.com' });
  const hinted = storeAccount(obj, 'Pista', { pw: null, discord: 'd-pista' });
  obj.store.setEmailHint(hinted, 'pista@x.com', 'discord');
  obj.store.sql.exec('INSERT INTO email_holds (canon, user_id, email, until) VALUES (?, ?, ?, ?)', 'vieja@x.com', withPw, 'vieja@x.com', Date.now() + 7 * 24 * 60 * MIN);
  const answers = [];
  for (const email of ['con@x.com', 'SIN@x.com', 'nadie@x.com', 'pista@x.com', 'vieja@x.com']) answers.push(await forgot(env, email, ip(answers.length)));
  for (const a of answers) assert.deepEqual([a.status, a.json], [200, { ok: true }]);
  assert.deepEqual(outbox.map((m) => m.to), ['con@x.com', 'sin@x.com']);
  assert.equal(outbox[0].subject, 'Choose a new Turbogol password', "the request's language for an account without one");
  assert.equal(outbox[1].subject, 'Create a Turbogol password');
  assert.match(outbox[1].text, /You sign in with Discord/);
  assert.equal(linkIn(outbox[0]).kind, 'reset');
  // A stranger's address fills its caps as an account's does: 5 an hour, then the same 429.
  const tallies = { nadie: [], con: [] };
  for (let i = 0; i < 5; i++) {
    tallies.nadie.push((await forgot(env, 'nadie@x.com', ip(10 + i))).status);
    tallies.con.push((await forgot(env, 'con@x.com', ip(20 + i))).status);
  }
  assert.deepEqual(tallies, { nadie: [200, 200, 200, 200, 429], con: [200, 200, 200, 200, 429] });
});

test("reset works once: the password stored (level 2, method reset), every family revoked, the other tokens dead, the address's throttles cleared, M4 in both languages; a newer link supersedes an older one; one victim is never locked out by a stranger", async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const acc = await signUp(env, outbox, 'victima@x.com', ip(0), { username: 'Victima', lang: 'en' });
  const other = await signin(env, 'victima@x.com', KEY, ip(1));
  // A "confirm it's you" code pending on the account: the reset kills it.
  const code = await post(env, '/api/auth/reauth/code', { ip: ip(1), bearer: other.json.session, body: {} });
  assert.equal(code.status, 200, JSON.stringify(code.json));
  const m11 = outbox.at(-1);
  // A stranger pauses the address's password sign-in (50 failures a day from browsers it does not know).
  for (let i = 0; i < 50; i++) await doFail(obj, { email: 'victima@x.com' }, `100.80.${i}.1`);
  assert.equal((await signin(env, 'victima@x.com', KEY, ip(2))).status, 429);
  // Two forgots: the newer link supersedes the older.
  assert.equal((await forgot(env, 'victima@x.com', ip(3))).status, 200);
  const old = linkIn(outbox.at(-1)).token;
  assert.equal((await forgot(env, 'victima@x.com', ip(4))).status, 200);
  const token = linkIn(outbox.at(-1)).token;
  assert.equal((await post(env, '/api/auth/reset/peek', { ip: ip(5), body: { token: old } })).status, 410, 'superseded');
  const peek = await post(env, '/api/auth/reset/peek', { ip: ip(5), body: { token } });
  assert.deepEqual(peek.json, { name: 'Victima', email: 'victima@x.com', hasPassword: true });
  assert.equal((await post(env, '/api/auth/reset/peek', { ip: ip(5), body: { token } })).status, 200, 'a peek consumes nothing');
  const NEW = await ACC.passwordKey('la clave nueva de verdad');
  const r = await post(env, '/api/auth/reset', { ip: ip(5), body: { token, password: NEW } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.playerId, acc.json.playerId);
  assert.equal(claims(r.json.session).aal, 2);
  assert.deepEqual(obj.store.sql.exec('SELECT method, auth_lvl FROM refresh WHERE user_id = ?', acc.json.playerId).toArray(), [{ method: 'reset', auth_lvl: 2 }], 'one family: this browser');
  assert.equal((await post(env, '/api/auth/refresh', { ip: ip(1), cookie: '__Host-tg_rt=' + cookieOf(other.raw, '__Host-tg_rt') })).status, 401, 'every other device signed out');
  assert.equal((await post(env, '/api/auth/reset', { ip: ip(5), body: { token, password: NEW } })).status, 410, 'once');
  const dead = await post(env, '/api/auth/reauth/code/verify', { ip: ip(5), bearer: r.json.session, cookie: '__Host-tg_rt=' + cookieOf(r.raw, '__Host-tg_rt'), body: { attempt: code.json.attempt, code: codeIn(m11) } });
  assert.deepEqual([dead.status, dead.json.error], [410, 'code_expired'], 'the reauth code died with the reset');
  const m4 = outbox.at(-1);
  assert.equal(m4.to, 'victima@x.com');
  assert.equal(m4.subject, 'Your Turbogol password changed · Tu contraseña de Turbogol cambió', "both languages, the account's first");
  assert.match(m4.text, /https:\/\/turbo-gol\.com\/account#forgot/);
  // The stranger's pause went with the reset: the new password signs in at once, the old one never.
  assert.equal((await signin(env, 'victima@x.com', NEW, ip(2))).status, 200);
  assert.equal((await signin(env, 'victima@x.com', KEY, ip(6))).status, 401);
  assert.equal((await post(env, '/api/auth/reset', { ip: ip(6), body: { token: 'Z'.repeat(43), password: NEW } })).json.error, 'link_invalid');
});

// ---- the password behind a session, and "confirm it's you" by a code ----------------------------------

test('me/password: the current password changes it (the other devices out, M4, the reset links dead); a wrong one counts per account; me/password/link mails a "create" link and never sets a password', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const a = await signUp(env, outbox, 'clave@x.com', ip(0), { username: 'Clave' });
  const b = await signin(env, 'clave@x.com', KEY, ip(1));
  await forgot(env, 'clave@x.com', ip(2));
  const pending = linkIn(outbox.at(-1)).token;
  const cookie = '__Host-tg_rt=' + a.rt;
  const NEW = await ACC.passwordKey('otra clave muy larga');
  const tally = [];
  for (let i = 0; i < 6; i++) tally.push((await post(env, '/api/me/password', { ip: ip(3), bearer: a.json.session, cookie, body: { current: WRONG, password: NEW } })).status);
  assert.deepEqual(tally, [401, 401, 401, 401, 401, 429], "the account's 'pa:' counter");
  obj.store.throttleClear(obj.store.sql.exec("SELECT key FROM auth_throttle WHERE key LIKE 'pa:%'").toArray().map((x) => x.key));
  assert.equal((await post(env, '/api/me/password', { ip: ip(3), bearer: a.json.session, body: { current: KEY, password: NEW } })).json.error, 'no_refresh');
  const ok = await post(env, '/api/me/password', { ip: ip(3), bearer: a.json.session, cookie, body: { current: KEY, password: NEW } });
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }]);
  assert.equal(outbox.at(-1).subject, 'Tu contraseña de Turbogol cambió · Your Turbogol password changed');
  assert.equal((await post(env, '/api/auth/refresh', { ip: ip(1), cookie: '__Host-tg_rt=' + cookieOf(b.raw, '__Host-tg_rt') })).status, 401);
  assert.equal((await post(env, '/api/auth/refresh', { ip: ip(0), cookie })).status, 200, 'this device stays');
  assert.equal((await post(env, '/api/auth/reset/peek', { ip: ip(3), body: { token: pending } })).status, 410, 'a change kills the reset links');
  assert.equal((await signin(env, 'clave@x.com', NEW, ip(4))).status, 200);
  // The link: an account without a password gets "create"; the Bearer alone sets nothing.
  const solo = storeAccount(obj, 'SinClave', { pw: null, discord: 'd-sin', email: 'sin@x.com' });
  const link = await post(env, '/api/me/password/link', { ip: ip(5), bearer: await bearerOf(solo, 'SinClave'), body: {} });
  assert.deepEqual([link.status, link.json], [200, { sentTo: 'sin@x.com' }]);
  assert.match(outbox.at(-1).subject, /Crea una contraseña para Turbogol|Create a Turbogol password/);
  assert.equal(row(obj, solo).pw_hash, null);
  assert.equal((await post(env, '/api/me/password/link', { ip: ip(5), bearer: await bearerOf(solo, 'SinClave', { tv: 1 }), body: {} })).json.error, 'tv_session');
});

test("reauth/code: a code from the account's own mailbox raises this browser to level 2 (M11, 5 tries, bound to the account); 5 a day; a maintainer confirms with its password; no address, 409", async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const acc = await signUp(env, outbox, 'confirma@x.com', ip(0), { username: 'Confirma' });
  // A device of before levels (auth_lvl 0): its session carries no level.
  const tok = 'y'.repeat(43);
  obj.store.sql.exec("INSERT INTO refresh (hash, user_id, created_at, expires_at, kind, auth_at, family_at) VALUES (?, ?, ?, ?, 'web', ?, ?)", await A.sha256Hex(tok), acc.json.playerId, Date.now(), Date.now() + 86_400_000, Date.now() - 60_000, Date.now() - 60_000);
  const s = await post(env, '/api/auth/refresh', { ip: ip(1), cookie: '__Host-tg_rt=' + tok });
  const rt = cookieOf(s.raw, '__Host-tg_rt');
  assert.equal(claims(s.json.session).aal, undefined);
  const c = await post(env, '/api/auth/reauth/code', { ip: ip(1), bearer: s.json.session, body: {} });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.deepEqual(Object.keys(c.json).sort(), ['attempt', 'resendAt', 'to']);
  assert.equal(c.json.to, 'confirma@x.com');
  const m11 = outbox.at(-1);
  assert.match(m11.subject, /^\d{6} es tu código para confirmar que eres tú$/);
  assert.equal(linkIn(m11), null, 'no link');
  const code = codeIn(m11);
  const verify = (body, bearer = s.json.session) => post(env, '/api/auth/reauth/code/verify', { ip: ip(1), bearer, cookie: '__Host-tg_rt=' + rt, body });
  // Another account's Bearer cannot use this attempt.
  const other = await signUp(env, outbox, 'otro@x.com', ip(2), { username: 'Otro' });
  assert.equal((await verify({ attempt: c.json.attempt, code }, other.json.session)).json.error, 'code_expired');
  assert.equal((await verify({ attempt: c.json.attempt, code: code === '000000' ? '111111' : '000000' })).json.triesLeft, 4);
  const ok = await verify({ attempt: c.json.attempt, code });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(claims(ok.json.session).aal, 2);
  assert.deepEqual(obj.store.sql.exec('SELECT auth_lvl FROM refresh WHERE hash = ?', await A.sha256Hex(rt)).toArray()[0], { auth_lvl: 2 });
  assert.equal((await verify({ attempt: c.json.attempt, code })).json.error, 'code_expired', 'once');
  // Five a day per account (one was used above); an hour on, so the address's 5 an hour (M1 counted) is not what refuses.
  const t0 = Date.now() + 61 * MIN;
  obj.now = () => t0;
  const t = [];
  for (let i = 0; i < 5; i++) t.push((await post(env, '/api/auth/reauth/code', { ip: ip(3 + i), bearer: s.json.session, body: {} })).status);
  assert.deepEqual(t, [200, 200, 200, 200, 429]);
  // Its resend needs its own Bearer.
  const attempt = (await post(env, '/api/auth/reauth/code', { ip: ip(9), bearer: other.json.session, body: {} })).json.attempt;
  const before = outbox.length;
  obj.now = () => t0 + 61_000;
  assert.equal((await post(env, '/api/auth/code/resend', { ip: ip(9), body: { attempt } })).json.error, 'code_expired', 'no Bearer');
  assert.equal((await post(env, '/api/auth/code/resend', { ip: ip(9), bearer: s.json.session, body: { attempt } })).json.error, 'code_expired', "another account's");
  assert.equal((await post(env, '/api/auth/code/resend', { ip: ip(9), bearer: other.json.session, body: { attempt } })).status, 200);
  assert.equal(outbox.length, before + 1);
  assert.equal(codeIn(outbox.at(-1)), codeIn(outbox[before - 1]), 'the same code');
  // The project's maintainer confirms with its password: the maintainer routes' level 2 stays a typed password's.
  env.NODE_TRUSTED_OPERATORS = acc.json.playerId;
  assert.equal((await post(env, '/api/auth/reauth/code', { ip: ip(10), bearer: s.json.session, body: {} })).json.error, 'password_required');
  delete env.NODE_TRUSTED_OPERATORS;
  const noMail = storeAccount(obj, 'SinCorreo', { pw: null, discord: 'd-nada' });
  assert.equal((await post(env, '/api/auth/reauth/code', { ip: ip(11), bearer: await bearerOf(noMail, 'SinCorreo'), body: {} })).json.error, 'email_required');
});

test('the ceiling (R6): a verified address reaches level 2 by a code, so unlinking down to one way in asks for level 2 of an account without a password', () => {
  const { obj } = makeEnv();
  const id = storeAccount(obj, 'DosVias', { pw: null, discord: 'd-dos', email: 'dos@x.com' });
  obj.store.sql.exec("UPDATE users SET google_sub = 'g-dos' WHERE id = ?", id);
  assert.equal(obj.store.unlink(id, 'google', 1), 'level2', 'one way would be left, and the mailbox gives level 2');
  assert.equal(obj.store.unlink(id, 'google', 2), 'ok');
  const sin = storeAccount(obj, 'SinCorreo', { pw: null, discord: 'd-sc' });
  obj.store.sql.exec("UPDATE users SET google_sub = 'g-sc' WHERE id = ?", sin);
  assert.equal(obj.store.unlink(sin, 'google', 1), 'ok', 'without an address its ceiling stays 1');
});

// ---- lanes -----------------------------------------------------------------------------------------------

test('the lanes: a full signup lane (60 %) and the automatic pause stop sign-up mail only; resets still go', async () => {
  let failing = false;
  const { env, obj, outbox } = makeEnv({ EMAIL_DAILY_CAP: '10' }, { fail: () => failing });
  const ip = ips();
  storeAccount(obj, 'Duena', { pw: await A.newPasswordRecord(KEY, 2), email: 'duena@x.com' });
  for (let i = 0; i < 6; i++) assert.equal((await start(env, `s${i}@x.com`, ip(i))).status, 200);
  assert.equal((await start(env, 's6@x.com', ip(6))).json.error, 'email_rate_limited');
  assert.equal((await forgot(env, 'duena@x.com', ip(7))).status, 200);
  assert.equal(outbox.at(-1).to, 'duena@x.com', 'the account lane goes on to 90 %');
  // The pause: 10 failed sends of the signup lane in 10 minutes (a day of its own and a higher cap: the lanes have room).
  const day = Date.UTC(2031, 0, 2, 12);
  obj.now = () => day;
  env.EMAIL_DAILY_CAP = '100';
  failing = true;
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (let i = 0; i < 10; i++) await start(env, `p${i}@x.com`, ip(20 + i));
  } finally {
    console.warn = warn;
  }
  failing = false;
  const sent = outbox.length;
  assert.equal((await start(env, 'p10@x.com', ip(31))).json.error, 'email_paused');
  assert.equal((await forgot(env, 'duena@x.com', ip(32))).status, 200);
  assert.equal(outbox.length, sent + 1, 'the reset went');
});

// ---- the routes that go, and the rename ------------------------------------------------------------------

test('register, recovery-codes and the old password route answer 410 gone, to anyone; an email account renames with a Bearer alone (a legacy key asks level 2 first; a protected look-alike is refused with a suggestion)', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const acc = await signUp(env, outbox, 'renombra@x.com', ip(0), { username: 'Renombra' });
  for (const path of ['/api/auth/register', '/api/auth/recovery-codes', '/api/auth/password']) {
    for (const bearer of [undefined, acc.json.session]) {
      const r = await post(env, path, { ip: ip(1), bearer, body: { username: 'Nueva', password: KEY, passwordV2: KEY } });
      assert.deepEqual([r.status, r.json.error], [410, 'gone'], path);
    }
  }
  assert.match((await post(env, '/api/auth/register', { ip: ip(1), body: {} })).json.message, /ahora las cuentas se crean con un correo/);
  assert.equal(obj.store.sql.exec('SELECT COUNT(*) AS n FROM users').toArray()[0].n, 1);
  const owner = storeAccount(obj, 'Proyecto', { email: 'p@x.com' });
  obj.store.rebuildProtectedSkeletons([owner]);
  const look = await post(env, '/api/me/username', { ip: ip(2), bearer: acc.json.session, body: { username: 'Pr0yect0' } });
  assert.deepEqual([look.status, look.json.error], [409, 'name_lookalike']);
  assert.equal(ACC.usernameIssue(look.json.suggest), null);
  const taken = await post(env, '/api/me/username', { ip: ip(2), bearer: acc.json.session, body: { username: 'proyecto' } });
  assert.deepEqual([taken.status, taken.json.error, typeof taken.json.suggest], [409, 'username_taken', 'string']);
  const ok = await post(env, '/api/me/username', { ip: ip(2), bearer: acc.json.session, body: { username: 'Renombrada' } });
  assert.deepEqual([ok.status, ok.json.name], [200, 'Renombrada'], 'no password asked');
  const legacy = storeAccount(obj, 'Vieja');
  const lr = await post(env, '/api/me/username', { ip: ip(3), bearer: await bearerOf(legacy, 'Vieja'), body: { username: 'VieJa2' } });
  assert.deepEqual([lr.status, lr.json.error, lr.json.level], [403, 'reauth_required', 2]);
});

test("rename (review): an account whose password signs in by its username needs fresh(2): a stolen Bearer past the window is 403 reauth_required and the owner's name still signs in; a fresh sign-in or \"confirm it's you\" renames; email and provider accounts rename with a Bearer alone", async () => {
  const { env, obj } = makeEnv();
  const ip = ips();
  const rec = await A.newPasswordRecord(KEY, 2, {});
  const login = (username, i) => post(env, '/api/auth/login', { ip: ip(i), body: { username, password: KEY, passwordV2: KEY } });
  const rename = (bearer, username, extra = {}) => post(env, '/api/me/username', { ip: '203.0.113.200', bearer, body: { username }, ...extra });
  const nowS = Math.floor(Date.now() / 1000);
  // A pw_v 2 password and no verified email: every legacy account re-keyed at a sign-in since PR 4.
  const ana = storeAccount(obj, 'AnaVieja', { pw: rec });
  assert.equal(row(obj, ana).pw_v, 2);
  const own = await login('AnaVieja', 0);
  assert.equal(own.status, 200, JSON.stringify(own.json));
  // A thief's copies of the owner's 1-hour Bearer: 11 minutes after its sign-in (a refresh keeps the
  // sign-in's aat), one with no proof at all (a family from before levels) and one at level 1.
  for (const extra of [{ aal: 2, aat: nowS - 11 * 60 }, {}, { aal: 1, aat: nowS }]) {
    const r = await rename(await bearerOf(ana, 'AnaVieja', extra), 'Robado');
    assert.deepEqual([r.status, r.json.error, r.json.level], [403, 'reauth_required', 2], JSON.stringify(extra));
  }
  assert.deepEqual([row(obj, ana).username, row(obj, ana).renamed_at], ['AnaVieja', 0], 'not renamed, no 30-day wait started');
  assert.equal((await login('AnaVieja', 1)).status, 200, "the owner's own name still signs in");
  // The owner, just signed in with the password (aal 2, aat now), renames, and the new name signs in.
  const ren = await rename(own.json.session, 'AnaNueva');
  assert.deepEqual([ren.status, ren.json.name], [200, 'AnaNueva'], JSON.stringify(ren.json));
  assert.equal((await login('AnaNueva', 2)).status, 200);
  // Past the window, "confirm it's you" with the password (POST /api/auth/reauth) makes it fresh.
  const beto = storeAccount(obj, 'BetoViejo', { pw: await A.newPasswordRecord(KEY, 2, {}) });
  const b0 = await login('BetoViejo', 3);
  const cookie = '__Host-tg_rt=' + cookieOf(b0.raw, '__Host-tg_rt');
  const stale = await bearerOf(beto, 'BetoViejo', { aal: 2, aat: nowS - 11 * 60 });
  assert.equal((await rename(stale, 'BetoNuevo')).json.error, 'reauth_required');
  const re = await post(env, '/api/auth/reauth', { ip: ip(3), bearer: stale, cookie, body: { password: KEY } });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  assert.equal((await rename(re.json.session, 'BetoNuevo')).status, 200);
  // Its name is no way in for an account with a verified email (it signs in by email) or one without
  // a password (a provider): a Bearer alone, even with no proof in it.
  const mail = storeAccount(obj, 'ConMail', { email: 'conmail@x.com', pw: await A.newPasswordRecord(KEY, 2, {}) });
  assert.equal((await rename(await bearerOf(mail, 'ConMail'), 'ConMail2')).status, 200);
  const disco = storeAccount(obj, 'Disco', { discord: '4242', pw: null });
  assert.equal((await rename(await bearerOf(disco, 'Disco'), 'Disco2')).status, 200);
  // A TV still never renames.
  assert.equal((await rename(await bearerOf(beto, 'BetoNuevo', { aal: 2, aat: nowS, tv: 1 }), 'BetoTV')).json.error, 'tv_session');
});

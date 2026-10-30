// Sign-in PR 9 (the design's section 8, "email management and the grace UI"): adding and changing
// an account's email by a code to the new address (M5), with M6 and its 7-day undo to the old one and
// the old canon held meanwhile; an address another account holds (M7, the move and M12); a hint
// confirmed by an ordinary code; POST /api/me/prefs; the cutoff for passwords without a verified
// email (LEGACY_PASSWORD_UNTIL, meta.legacy_seen, /api/config auth.legacy, 410 legacy_closed, M10 from
// the alarm). Through the real Worker (index.ts) in front of a real AccountsDO on node:sqlite, as
// accounts-email.test.mjs runs them; mail goes to a fake binding that only records.
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


const AUTH = await import('../src/auth.ts');
const DAY = 24 * 60 * MIN;
const signin = (env, email, password, ip, cookie) => post(env, '/api/auth/signin', { ip, cookie, body: { email, password } });
const login = (env, body, ip, cookie) => post(env, '/api/auth/login', { ip, cookie, body });
async function refresh(env, rt, ip = '198.19.202.1') {
  const r = await post(env, '/api/auth/refresh', { ip, cookie: '__Host-tg_rt=' + rt });
  return { ...r, rt: cookieOf(r.raw, '__Host-tg_rt') };
}
/** A session of `userId` as the Worker signs one (a stale proof, a level, a TV), for the routes' freshness. */
const sessionOf = (env, userId, name, scope = {}) => A.accountSession(env, { userId, username: name, ...scope }).then((s) => s.session);
/** The add or change of `email` by the Bearer `bearer`. */
const askEmail = (env, bearer, email, ip, extra = {}) => post(env, '/api/me/email', { ip, bearer, body: { email, lang: 'es', ...extra } });
const verifyEmail = (env, bearer, attempt, code, ip, cookie) => post(env, '/api/me/email/verify', { ip, bearer, cookie, body: { attempt, code } });
const other = (code) => (code === '000000' ? '111111' : '000000');
/** A legacy account (users.pw_v 1, the key salted with its name), as every production password of before is. */
async function legacyAccount(obj, name) {
  const k = { v1: await ACC.legacyPasswordKey(name, PW), v2: KEY };
  const id = obj.store.register(name, await A.newPasswordRecord(k.v1, 1), [], await A.sha256Hex('legacy-' + name), Date.now()).userId;
  return { id, ...k };
}

// ---- a change: the code to the new address, M6 and its undo to the old one ---------------------------

test('a change: the code goes to the new address (M5), M6 with the undo to the old one (both languages, the new one masked); the other devices are signed out, this one stays; the old canon is held', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const a = await signUp(env, outbox, 'Ana@x.com', ip(0), { username: 'Ana_Cambia' });
  const other2 = await signin(env, 'ana@x.com', KEY, ip(1));
  assert.equal(other2.status, 200, 'a second device');
  const rt2 = cookieOf(other2.raw, '__Host-tg_rt');
  const ask = await askEmail(env, a.json.session, 'Nueva.Ana@x.com', ip(0));
  assert.deepEqual(shape(ask), { status: 200, keys: ['attempt', 'resendAt', 'to'] });
  assert.equal(ask.json.to, 'nueva.ana@x.com');
  const m5 = outbox.at(-1);
  assert.equal(m5.to, 'nueva.ana@x.com', 'the code goes to the new address');
  assert.match(m5.subject, /^\d{6} es tu código para confirmar tu correo$/);
  assert.equal(linkIn(m5).kind, 'email');
  assert.equal(obj.store.sql.exec("SELECT purpose FROM mail_tokens WHERE user_id = ? AND used_at = 0 AND purpose LIKE '%email'", a.json.playerId).toArray()[0].purpose, 'change_email');
  // Nothing changed until the code: the old address still signs in.
  assert.equal(row(obj, a.json.playerId).email, 'ana@x.com');
  const wrong = await verifyEmail(env, a.json.session, ask.json.attempt, other(codeIn(m5)), ip(0), '__Host-tg_rt=' + a.rt);
  assert.deepEqual([wrong.status, wrong.json.error, wrong.json.triesLeft], [400, 'code_wrong', 4]);
  const ok = await verifyEmail(env, a.json.session, ask.json.attempt, codeIn(m5), ip(0), '__Host-tg_rt=' + a.rt);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.email, ok.json.emailVerified, 'mail' in ok.json], ['nueva.ana@x.com', true, false], 'MeInfo, and nothing of the mail');
  const u = row(obj, a.json.playerId);
  assert.deepEqual([u.email, u.email_canon, u.email_proof], ['nueva.ana@x.com', 'nueva.ana@x.com', 'mail']);
  // M6 to the old address, both languages, the undo link, the new address masked.
  const m6 = outbox.at(-1);
  assert.equal(m6.to, 'ana@x.com');
  assert.equal(m6.subject, "El correo de tu cuenta de Turbogol cambió · Your Turbogol account's email changed");
  assert.match(m6.text.replace(/⁠/g, ''), /cambió a nu\*\*\*@x\.com/, 'masked (and made unlinkable)');
  assert.doesNotMatch(m6.text, /nueva\.ana/);
  assert.equal(linkIn(m6).kind, 'undo');
  assert.match(m6.text, /— English —/);
  // The other families are revoked; this device stays.
  assert.equal((await refresh(env, rt2, ip(1))).status, 401, 'the other device is signed out');
  assert.equal((await refresh(env, a.rt, ip(0))).status, 200, 'this one stays');
  // The old canon is held for 7 days.
  const hold = obj.store.sql.exec('SELECT * FROM email_holds').toArray();
  assert.equal(hold.length, 1);
  assert.deepEqual([hold[0].canon, hold[0].user_id, hold[0].email], ['ana@x.com', a.json.playerId, 'ana@x.com']);
  assert.ok(Math.abs(hold[0].until - (Date.now() + 7 * DAY)) < 5000);
  // The new address signs in now; the old one no longer does.
  assert.equal((await signin(env, 'nueva.ana@x.com', KEY, ip(2))).status, 200);
  assert.equal((await signin(env, 'ana@x.com', KEY, ip(3))).status, 401);
  // The code is used: once.
  assert.equal((await verifyEmail(env, a.json.session, ask.json.attempt, codeIn(m5), ip(0))).status, 410);
});

test('the hold: for the 7 days a sign-up with the old address gets M2 "held" and an add gets M7 "held" (a decoy); the undo then gives the address back, a new password, every device out, providers linked in the 7 days unlinked, the email locked', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const a = await signUp(env, outbox, 'vieja@x.com', ip(0), { username: 'Ana_Hold' });
  const ask = await askEmail(env, a.json.session, 'ladron@x.com', ip(0));
  assert.equal((await verifyEmail(env, a.json.session, ask.json.attempt, codeIn(outbox.at(-1)), ip(0), '__Host-tg_rt=' + a.rt)).status, 200);
  const undoToken = linkIn(outbox.at(-1)).token;
  // A provider linked after the change (the thief's) and one linked long before (the owner's).
  obj.store.sql.exec('UPDATE users SET discord_id = ?, discord_linked_at = ?, google_sub = ?, google_linked_at = ? WHERE id = ?', 'd-ladron', Date.now(), 'g-duena', Date.now() - 30 * DAY, a.json.playerId);
  // A sign-up of the held address: M2 "held", no code.
  const s = await start(env, 'vieja@x.com', ip(1));
  assert.equal(s.status, 200);
  assert.equal(outbox.at(-1).to, 'vieja@x.com');
  assert.match(outbox.at(-1).text, /queda reservado unos días para la cuenta Ana_Hold/);
  assert.equal(codeIn(outbox.at(-1)), null);
  // Another account's add of it: the same answer, M7 "held", a decoy row.
  const b = await signUp(env, outbox, 'beto@x.com', ip(2), { username: 'Beto_Hold' });
  const ab = await askEmail(env, b.json.session, 'Vieja@X.com', ip(2));
  assert.deepEqual(shape(ab), { status: 200, keys: ['attempt', 'resendAt', 'to'] });
  assert.match(outbox.at(-1).subject, /^Alguien quiere usar tu correo en Turbogol$/);
  assert.match(outbox.at(-1).text, /queda reservado unos días para la cuenta Ana_Hold/);
  const decoy = await verifyEmail(env, b.json.session, ab.json.attempt, '123456', ip(2));
  assert.deepEqual([decoy.status, decoy.json.error], [400, 'code_wrong'], 'a decoy fails like a wrong code');
  // The undo: peek, then a new password.
  const peek = await post(env, '/api/auth/email/undo/peek', { ip: ip(3), body: { token: undoToken } });
  assert.deepEqual([peek.status, peek.json], [200, { name: 'Ana_Hold', email: 'vieja@x.com' }]);
  const NEW = await ACC.passwordKey('otra contraseña muy larga');
  const undo = await post(env, '/api/auth/email/undo', { ip: ip(3), body: { token: undoToken, password: NEW } });
  assert.equal(undo.status, 200, JSON.stringify(undo.json));
  assert.equal(claims(undo.json.session).aal, 2);
  const u = row(obj, a.json.playerId);
  assert.deepEqual([u.email, u.email_canon, u.discord_id, u.google_sub], ['vieja@x.com', 'vieja@x.com', null, 'g-duena'], 'the address back; the provider of the 7 days unlinked, the older one kept');
  assert.ok(u.email_locked_until > Date.now() + 6 * DAY, 'the email locked for 7 days');
  assert.equal(obj.store.sql.exec('SELECT COUNT(*) AS n FROM email_holds').toArray()[0].n, 0, 'the hold went');
  assert.equal((await refresh(env, a.rt, ip(0))).status, 401, 'every family revoked');
  assert.equal(obj.store.sql.exec('SELECT COUNT(*) AS n FROM refresh WHERE user_id = ?', a.json.playerId).toArray()[0].n, 1, 'one new for this browser');
  assert.equal((await signin(env, 'vieja@x.com', NEW, ip(4))).status, 200, 'the new password');
  assert.equal((await signin(env, 'vieja@x.com', KEY, ip(5))).status, 401, 'the old one no longer');
  // The lock: no change for 7 days.
  const fresh = await signin(env, 'vieja@x.com', NEW, ip(6));
  const locked = await askEmail(env, fresh.json.session, 'otra@x.com', ip(6));
  assert.deepEqual([locked.status, locked.json.error], [409, 'email_locked']);
  assert.ok(locked.json.until > Date.now());
  // The link works once; the thief's address is free again.
  assert.equal((await post(env, '/api/auth/email/undo', { ip: ip(3), body: { token: undoToken, password: NEW } })).status, 410);
  assert.equal((await post(env, '/api/auth/email/undo/peek', { ip: ip(3), body: { token: undoToken } })).status, 410);
  await start(env, 'ladron@x.com', ip(7));
  assert.match(outbox.at(-1).subject, /^\d{6} es tu código de Turbogol$/, "M1: the address is nobody's");
});

/** Changes the account's email to `to` by its code, and answers M6 (the undo to the address it left). */
async function changeTo(env, outbox, a, to, ip) {
  const ask = await askEmail(env, a.json.session, to, ip);
  assert.equal(ask.status, 200, JSON.stringify(ask.json));
  const ok = await verifyEmail(env, a.json.session, ask.json.attempt, codeIn(outbox.at(-1)), ip, '__Host-tg_rt=' + a.rt);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const m6 = outbox.at(-1);
  assert.equal(linkIn(m6)?.kind, 'undo', 'M6: ' + m6.subject);
  return m6;
}
const holdCount = (obj) => obj.store.sql.exec('SELECT COUNT(*) AS n FROM email_holds').toArray()[0].n;

test("two changes (the review of PR 9): the undo of the second does not cancel the first's; the owner's link still restores the address, a new password, every device out, the thief's Discord unlinked", async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const a = await signUp(env, outbox, 'duena@x.com', ip(0), { username: 'Duena_Dos' });
  // Whoever has the password (level 2) changes the email twice: U1 goes to the owner, U2 to the thief's first address.
  const m6a = await changeTo(env, outbox, a, 'ladron1@x.com', ip(0));
  assert.equal(m6a.to, 'duena@x.com');
  const m6b = await changeTo(env, outbox, a, 'ladron2@x.com', ip(0));
  assert.equal(m6b.to, 'ladron1@x.com');
  const U1 = linkIn(m6a).token;
  const U2 = linkIn(m6b).token;
  assert.equal(holdCount(obj), 2, 'both old addresses held');
  // The thief undoes its own second change: back to its first address, its own password, the email locked.
  const THIEF = await ACC.passwordKey('la contraseña del ladrón');
  const u2 = await post(env, '/api/auth/email/undo', { ip: ip(1), body: { token: U2, password: THIEF } });
  assert.equal(u2.status, 200, JSON.stringify(u2.json));
  assert.equal(row(obj, a.json.playerId).email, 'ladron1@x.com');
  const thiefRt = cookieOf(u2.raw, '__Host-tg_rt');
  // Then it links its Discord (a way back in that the owner's undo must take away).
  obj.store.sql.exec('UPDATE users SET discord_id = ?, discord_linked_at = ? WHERE id = ?', 'd-ladron', Date.now(), a.json.playerId);
  // The owner's link still works.
  const peek = await post(env, '/api/auth/email/undo/peek', { ip: ip(2), body: { token: U1 } });
  assert.deepEqual([peek.status, peek.json], [200, { name: 'Duena_Dos', email: 'duena@x.com' }], "the owner's undo (U1) is still live");
  assert.equal(obj.store.sql.exec('SELECT COUNT(*) AS n FROM email_holds WHERE canon = ?', 'duena@x.com').toArray()[0].n, 1, "the owner's address still held");
  const OWNER = await ACC.passwordKey('la contraseña nueva de la dueña');
  const u1 = await post(env, '/api/auth/email/undo', { ip: ip(2), body: { token: U1, password: OWNER } });
  assert.equal(u1.status, 200, JSON.stringify(u1.json));
  const u = row(obj, a.json.playerId);
  assert.deepEqual([u.email, u.email_canon, u.discord_id], ['duena@x.com', 'duena@x.com', null], "the owner's address back, the thief's Discord gone");
  assert.equal((await refresh(env, thiefRt, ip(1))).status, 401, "the thief's new family is revoked");
  assert.equal((await signin(env, 'duena@x.com', OWNER, ip(3))).status, 200, "the owner's new password");
  assert.equal((await signin(env, 'ladron1@x.com', THIEF, ip(4))).status, 401, "the thief's address and password no longer");
  assert.equal(holdCount(obj), 0);
  assert.equal((await post(env, '/api/auth/email/undo/peek', { ip: ip(2), body: { token: U1 } })).status, 410, 'used once');
});

test('two changes, the first undo used first: it wins, the later undo dies with its hold (the address it held is free again)', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const a = await signUp(env, outbox, 'primera@x.com', ip(0), { username: 'Duena_Tres' });
  const U1 = linkIn(await changeTo(env, outbox, a, 'segunda@x.com', ip(0))).token;
  const U2 = linkIn(await changeTo(env, outbox, a, 'tercera@x.com', ip(0))).token;
  const NEW = await ACC.passwordKey('otra contraseña bien larga');
  assert.equal((await post(env, '/api/auth/email/undo', { ip: ip(1), body: { token: U1, password: NEW } })).status, 200);
  assert.equal(row(obj, a.json.playerId).email, 'primera@x.com');
  assert.equal((await post(env, '/api/auth/email/undo/peek', { ip: ip(1), body: { token: U2 } })).status, 410, 'the later undo is dead');
  assert.equal((await post(env, '/api/auth/email/undo', { ip: ip(1), body: { token: U2, password: NEW } })).status, 410);
  assert.equal(row(obj, a.json.playerId).email, 'primera@x.com', 'and changes nothing');
  assert.equal(holdCount(obj), 0, "the later change's hold went with its undo");
  await start(env, 'segunda@x.com', ip(2));
  assert.match(outbox.at(-1).subject, /^\d{6} es tu código de Turbogol$/, "M1: the address is nobody's");
});

// ---- in use: another account's address, the move -------------------------------------------------------

test('in use: an address another account claimed gives the same answer and M7; a move works when that account keeps a way in (M12, it keeps its Discord), is a decoy when it has none, and move_refused when it lost it meanwhile', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const a = await signUp(env, outbox, 'a.cuenta@x.com', ip(0), { username: 'Ana_Mueve' });
  const bea = storeAccount(obj, 'Bea_Discord', { pw: null, email: 'bea@x.com', discord: 'd-bea' });
  const ceci = storeAccount(obj, 'Ceci_Sola', { email: 'ceci@x.com' });
  const answers = [await askEmail(env, a.json.session, 'libre@x.com', ip(0)), await askEmail(env, a.json.session, 'Bea@X.com', ip(0))];
  const move = outbox.at(-1);
  answers.push(await askEmail(env, a.json.session, 'ceci@x.com', ip(0)));
  const only = outbox.at(-1);
  for (const r of answers) assert.deepEqual(shape(r), { status: 200, keys: ['attempt', 'resendAt', 'to'] }, 'one answer whoever holds the address (I6)');
  assert.deepEqual(answers.map((r) => r.json.to), ['libre@x.com', 'bea@x.com', 'ceci@x.com'], 'the address typed, never whose it is');
  assert.equal(move.to, 'bea@x.com');
  assert.equal(move.subject, 'Alguien quiere usar tu correo en Turbogol');
  assert.match(move.text, /usar este correo en otra cuenta de Turbogol: Ana_Mueve/);
  assert.match(move.text, /sigue entrando con Discord/);
  assert.ok(codeIn(move), 'the move code');
  assert.equal(only.to, 'ceci@x.com');
  assert.match(only.text, /es la única forma de entrar a la cuenta Ceci_Sola/);
  assert.equal(codeIn(only), null);
  // The only way in: a decoy, whatever is typed.
  assert.equal((await verifyEmail(env, a.json.session, answers[2].json.attempt, '123456', ip(0))).json.error, 'code_wrong');
  assert.equal(row(obj, ceci).email, 'ceci@x.com');
  // The move: the newest request superseded the older ones, so ask for Bea's again.
  const again = await askEmail(env, a.json.session, 'bea@x.com', ip(1));
  const code = codeIn(outbox.at(-1));
  assert.equal((await verifyEmail(env, a.json.session, answers[1].json.attempt, codeIn(move), ip(1))).status, 410, 'the older move request was superseded');
  const ok = await verifyEmail(env, a.json.session, again.json.attempt, code, ip(1), '__Host-tg_rt=' + a.rt);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.email, 'bea@x.com');
  const b = row(obj, bea);
  assert.deepEqual([b.email, b.email_canon, b.email_verified_at, b.discord_id], [null, null, 0, 'd-bea'], 'Bea keeps her Discord, loses the address');
  const m12 = outbox.find((m) => m.subject.includes('Tu correo pasó a la cuenta Ana_Mueve de Turbogol'));
  assert.ok(m12, 'M12: ' + JSON.stringify(outbox.map((m) => m.subject)));
  assert.equal(m12.to, 'bea@x.com');
  assert.match(m12.text, /es el de la cuenta Ana_Mueve\. La cuenta Bea_Discord ya no lo usa y sigue entrando con Discord/);
  assert.ok(outbox.some((m) => m.to === 'a.cuenta@x.com' && m.subject.startsWith('El correo de tu cuenta de Turbogol cambió')), 'M6 to the old address of the account that took it');
  // move_refused: the other account lost its way in after the code went.
  const d = storeAccount(obj, 'Dani_Discord', { pw: null, email: 'dani@x.com', discord: 'd-dani' });
  const e = await signUp(env, outbox, 'eli@x.com', ip(2), { username: 'Eli_Mueve' });
  const ae = await askEmail(env, e.json.session, 'dani@x.com', ip(2));
  const codeE = codeIn(outbox.at(-1));
  obj.store.sql.exec('UPDATE users SET discord_id = NULL WHERE id = ?', d);
  const refused = await verifyEmail(env, e.json.session, ae.json.attempt, codeE, ip(2));
  assert.deepEqual([refused.status, refused.json.error], [409, 'move_refused']);
  assert.equal(row(obj, d).email, 'dani@x.com', 'nothing moved');
  // A race: an address that was free gets an account meanwhile.
  const f = await askEmail(env, e.json.session, 'carrera@x.com', ip(2));
  const codeF = codeIn(outbox.at(-1));
  storeAccount(obj, 'Rapida_Carrera', { email: 'carrera@x.com' });
  const race = await verifyEmail(env, e.json.session, f.json.attempt, codeF, ip(2));
  assert.deepEqual([race.status, race.json.error], [409, 'email_taken']);
});

test('hints: an address carried as a hint is claimed by an ordinary code (M5), and every hint of it is cleared; no move', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const h1 = storeAccount(obj, 'Hugo_Discord', { pw: null, discord: 'd-hugo' });
  const h2 = storeAccount(obj, 'Otro_Discord1', { pw: null, discord: 'd-otro' });
  assert.equal(obj.store.setEmailHint(h1, 'hugo@x.com', 'discord'), 'ok');
  assert.equal(obj.store.setEmailHint(h2, 'Hugo@X.com', 'discord'), 'ok');
  // A Discord account's own CONFIRMAR: a fresh press on Discord's page (level 1) is enough to add.
  const s = await sessionOf(env, h1, 'Hugo_Discord', { authAt: Date.now(), authLvl: 1 });
  const ask = await askEmail(env, s, 'hugo@x.com', ip(0));
  assert.equal(ask.status, 200, JSON.stringify(ask.json));
  const m5 = outbox.at(-1);
  assert.equal(m5.to, 'hugo@x.com');
  assert.match(m5.subject, /es tu código para confirmar tu correo$/);
  assert.equal(obj.store.sql.exec('SELECT purpose FROM mail_tokens WHERE user_id = ? AND used_at = 0', h1).toArray()[0].purpose, 'add_email');
  const ok = await verifyEmail(env, s, ask.json.attempt, codeIn(m5), ip(0));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.email, ok.json.emailHint], ['hugo@x.com', null]);
  assert.deepEqual([row(obj, h1).email_proof, row(obj, h2).email_hint, row(obj, h2).email_hint_canon], ['mail', null, null], "the other account's hint of it cleared");
  assert.equal(outbox.filter((m) => /Turbogol cambió|pasó a la cuenta/.test(m.subject)).length, 0, 'an add: no M6, no M12');
  assert.equal(obj.store.sql.exec('SELECT COUNT(*) AS n FROM email_holds').toArray()[0].n, 0, 'an add holds nothing');
});

test("who may ask: an add needs fresh(1), a change fresh(2); a password of before (pw_v 1) is re-keyed first (403 level 2); a TV never; same_email; I9: a forged canon or trust is never read", async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const disc = storeAccount(obj, 'Solo_Discord', { pw: null, discord: 'd-solo' });
  const stale = await sessionOf(env, disc, 'Solo_Discord', { authAt: Date.now() - 11 * MIN, authLvl: 1 });
  const none = await sessionOf(env, disc, 'Solo_Discord');
  for (const bearer of [stale, none]) {
    const r = await askEmail(env, bearer, 'solo@x.com', ip(0));
    assert.deepEqual([r.status, r.json.error, r.json.level], [403, 'reauth_required', 1], 'an add: fresh(1)');
  }
  const a = await signUp(env, outbox, 'nivel@x.com', ip(1), { username: 'Ana_Nivel' });
  const lvl1 = await sessionOf(env, a.json.playerId, 'Ana_Nivel', { authAt: Date.now(), authLvl: 1 });
  const change = await askEmail(env, lvl1, 'otro@x.com', ip(1));
  assert.deepEqual([change.status, change.json.error, change.json.level], [403, 'reauth_required', 2], 'a change: fresh(2)');
  assert.equal((await askEmail(env, a.json.session, 'otro@x.com', ip(1))).status, 200, 'right after the sign-up: level 2');
  const same = await askEmail(env, a.json.session, 'Nivel+tg@X.com', ip(1));
  assert.deepEqual([same.status, same.json.error], [400, 'same_email'], 'its own canon');
  assert.equal((await askEmail(env, a.json.session, 'no-arroba', ip(1))).json.error, 'bad_email');
  const tv = await sessionOf(env, a.json.playerId, 'Ana_Nivel', { tv: true });
  assert.deepEqual([(await askEmail(env, tv, 'otro@x.com', ip(1))).json.error, (await verifyEmail(env, tv, 'A'.repeat(43), '123456', ip(1))).json.error], ['tv_session', 'tv_session']);
  // A legacy key: "confirm it's you" with the password first, which re-keys it.
  const old = await legacyAccount(obj, 'Viejo_Leg');
  const fresh = await sessionOf(env, old.id, 'Viejo_Leg', { authAt: Date.now(), authLvl: 2 });
  const leg = await askEmail(env, fresh, 'viejo@x.com', ip(2));
  assert.deepEqual([leg.status, leg.json.error, leg.json.level], [403, 'reauth_required', 2]);
  // I9: the address and its canon come from what was typed.
  const forged = await askEmail(env, a.json.session, 'Forjado.Nuevo+x@GoogleMail.com', ip(1), { canon: 'nivel@x.com', emailCanon: 'victima@x.com', trust: 'auth', verified: true });
  assert.equal(forged.status, 200);
  const t = obj.store.sql.exec("SELECT email, email_canon FROM mail_tokens WHERE user_id = ? AND used_at = 0 AND purpose = 'change_email'", a.json.playerId).toArray();
  assert.deepEqual(t, [{ email: 'forjado.nuevo+x@googlemail.com', email_canon: 'forjadonuevo@gmail.com' }], 'one live request (the newest superseded the older one), its canon derived here');
});

test('the mailed link (/account#email=): POST /api/auth/email/confirm applies it from any device, once; code/resend sends the same code and link again to the account that asked', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const a = await signUp(env, outbox, 'enlace.a@x.com', ip(0), { username: 'Ana_Enlace' });
  const ask = await askEmail(env, a.json.session, 'enlace.b@x.com', ip(0));
  const m5 = outbox.at(-1);
  // A minute later, REENVIAR: the same code and link (the Bearer of the row's account only).
  obj.now = () => Date.now() + 61_000;
  assert.equal((await post(env, '/api/auth/code/resend', { ip: ip(0), body: { attempt: ask.json.attempt } })).status, 410, "no Bearer: not this account's row");
  const re = await post(env, '/api/auth/code/resend', { ip: ip(0), bearer: a.json.session, body: { attempt: ask.json.attempt } });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  assert.deepEqual([outbox.at(-1).to, codeIn(outbox.at(-1)), linkIn(outbox.at(-1)).token], ['enlace.b@x.com', codeIn(m5), linkIn(m5).token]);
  obj.now = () => Date.now();
  // The link, opened elsewhere (no session).
  const c = await post(env, '/api/auth/email/confirm', { ip: ip(5), body: { token: linkIn(m5).token } });
  assert.deepEqual([c.status, c.json], [200, { ok: true, name: 'Ana_Enlace', email: 'enlace.b@x.com' }]);
  assert.equal(row(obj, a.json.playerId).email, 'enlace.b@x.com');
  assert.ok(outbox.some((m) => m.to === 'enlace.a@x.com' && linkIn(m)?.kind === 'undo'), 'M6');
  assert.equal((await post(env, '/api/auth/email/confirm', { ip: ip(5), body: { token: linkIn(m5).token } })).json.error, 'link_invalid', 'once');
  assert.equal((await verifyEmail(env, a.json.session, ask.json.attempt, codeIn(m5), ip(0))).status, 410, 'its code is spent with it');
  assert.equal((await post(env, '/api/auth/email/confirm', { ip: ip(5), body: { token: 'Q'.repeat(43) } })).status, 410);
});

// ---- preferences ------------------------------------------------------------------------------------------

// ---- M6 and M12 always go (the review of PR 9): a change that cannot mail its undo does not apply ----

/** The day's notice lane set so that `left` more mails fit under the day's cap (EMAIL_DAILY_CAP: 100 by default). */
function laneLeft(obj, left, cap = 100) {
  const day = new Date().toISOString().slice(0, 10);
  const d = obj.store.mailDay(day);
  obj.store.sql.exec("INSERT OR IGNORE INTO mail_day (day, lane) VALUES (?, 'notice')", day);
  obj.store.sql.exec("UPDATE mail_day SET sent = ? WHERE day = ? AND lane = 'notice'", cap - left - d.signup.sent - d.account.sent, day);
}
const undoRows = (obj, id) => obj.store.sql.exec("SELECT COUNT(*) AS n FROM mail_tokens WHERE user_id = ? AND purpose = 'undo_email' AND used_at = 0", id).toArray()[0].n;

test("five notices first fill the account's cap of the day (M4 a sixth time is skipped), and a change still mails M6 with its undo", async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const a = await signUp(env, outbox, 'duena@x.com', ip(0), { username: 'Duena_Cupo' });
  const cookie = '__Host-tg_rt=' + a.rt;
  // Whoever typed the password (level 2) changes it six times: five M4 notices, the account's cap.
  let cur = KEY;
  for (let i = 0; i < 6; i++) {
    const next = await ACC.passwordKey('clave del ladrón número ' + i);
    const r = await post(env, '/api/me/password', { ip: ip(0), bearer: a.json.session, cookie, body: { current: cur, password: next, lang: 'es' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    cur = next;
  }
  const m4 = () => outbox.filter((m) => m.to === 'duena@x.com' && /contraseña/i.test(m.subject)).length;
  assert.equal(m4(), 5, 'the sixth M4 is skipped: the cap still holds for the other notices');
  const m6 = await changeTo(env, outbox, a, 'ladron@x.com', ip(0));
  assert.equal(m6.to, 'duena@x.com', 'M6 goes all the same');
  assert.equal(row(obj, a.json.playerId).email, 'ladron@x.com');
  assert.equal(undoRows(obj, a.json.playerId), 1);
  assert.equal(outbox.filter((m) => m.to === 'duena@x.com' && linkIn(m)?.kind === 'undo').length, 1);
});

test('the day\'s notice lane full, or mail off: a change by its code or its link answers 429 / 503 and changes nothing; once there is room the same code applies it and M6 goes; an add needs no notice and applies', async () => {
  const { env, obj, outbox, flags } = makeEnv();
  const ip = ips();
  const a = await signUp(env, outbox, 'llena@x.com', ip(0), { username: 'Ana_Llena' });
  const cookie = '__Host-tg_rt=' + a.rt;
  const ask = await askEmail(env, a.json.session, 'nueva.llena@x.com', ip(0));
  assert.equal(ask.status, 200);
  const m5 = outbox.at(-1);
  const unchanged = () => {
    assert.equal(row(obj, a.json.playerId).email, 'llena@x.com', 'the address unchanged');
    assert.deepEqual([undoRows(obj, a.json.playerId), holdCount(obj)], [0, 0], 'no undo row, no hold');
    assert.ok(!outbox.some((m) => linkIn(m)?.kind === 'undo'), 'no M6');
  };
  // The lane is full (an attacker's own accounts' notices, say): no room for M6.
  laneLeft(obj, 0);
  const byCode = await verifyEmail(env, a.json.session, ask.json.attempt, codeIn(m5), ip(0), cookie);
  assert.deepEqual([byCode.status, byCode.json.error], [429, 'email_rate_limited']);
  assert.ok(byCode.json.retryAfterMs > 0, 'until tomorrow');
  const byLink = await post(env, '/api/auth/email/confirm', { ip: ip(1), body: { token: linkIn(m5).token } });
  assert.deepEqual([byLink.status, byLink.json.error], [429, 'email_rate_limited']);
  unchanged();
  // Mail off (the kill flag) with room in the lane: 503, nothing changes.
  laneLeft(obj, 1);
  flags.set('email_off', '1');
  const off = await verifyEmail(env, a.json.session, ask.json.attempt, codeIn(m5), ip(0), cookie);
  assert.deepEqual([off.status, off.json.error], [503, 'email_paused']);
  assert.deepEqual([(await post(env, '/api/auth/email/confirm', { ip: ip(1), body: { token: linkIn(m5).token } })).status], [503]);
  unchanged();
  // An add mails nothing after its code: it applies with the lane full and mail off.
  const disc = storeAccount(obj, 'Solo_Lleno', { pw: null, discord: 'd-lleno' });
  flags.delete('email_off');
  laneLeft(obj, 50); // its start, in the account lane (90 % of the day)
  const add = await askEmail(env, await sessionOf(env, disc, 'Solo_Lleno', { authAt: Date.now(), authLvl: 1 }), 'solo.lleno@x.com', ip(2));
  assert.equal(add.status, 200, JSON.stringify(add.json));
  laneLeft(obj, 0);
  flags.set('email_off', '1');
  const added = await post(env, '/api/auth/email/confirm', { ip: ip(2), body: { token: linkIn(outbox.at(-1)).token } });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.equal(row(obj, disc).email, 'solo.lleno@x.com');
  // Room again: the same code (still live) applies the change, and M6 goes.
  flags.delete('email_off');
  laneLeft(obj, 1);
  const ok = await verifyEmail(env, a.json.session, ask.json.attempt, codeIn(m5), ip(0), cookie);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(row(obj, a.json.playerId).email, 'nueva.llena@x.com');
  assert.equal(outbox.at(-1).to, 'llena@x.com');
  assert.equal(linkIn(outbox.at(-1)).kind, 'undo');
});

test('a change that is also a move needs room for M6 and M12: one left answers 429 and moves nothing; with two, both go', async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const a = await signUp(env, outbox, 'ana.mueve@x.com', ip(0), { username: 'Ana_Dos_Avisos' });
  const bea = storeAccount(obj, 'Bea_Dos_Avisos', { pw: null, email: 'bea.dos@x.com', discord: 'd-bea-dos' });
  const ask = await askEmail(env, a.json.session, 'bea.dos@x.com', ip(0));
  assert.equal(ask.status, 200);
  const code = codeIn(outbox.at(-1));
  laneLeft(obj, 1);
  const one = await verifyEmail(env, a.json.session, ask.json.attempt, code, ip(0), '__Host-tg_rt=' + a.rt);
  assert.deepEqual([one.status, one.json.error], [429, 'email_rate_limited']);
  assert.deepEqual([row(obj, a.json.playerId).email, row(obj, bea).email], ['ana.mueve@x.com', 'bea.dos@x.com'], 'nothing moved');
  laneLeft(obj, 2);
  const two = await verifyEmail(env, a.json.session, ask.json.attempt, code, ip(0), '__Host-tg_rt=' + a.rt);
  assert.equal(two.status, 200, JSON.stringify(two.json));
  assert.deepEqual([row(obj, a.json.playerId).email, row(obj, bea).email], ['bea.dos@x.com', null]);
  const last = outbox.slice(-2).map((m) => [m.to, m.subject.split(' · ')[0]]);
  assert.deepEqual(last.map(([to]) => to).sort(), ['ana.mueve@x.com', 'bea.dos@x.com'], 'M6 to the old address and M12 to the moved one: ' + JSON.stringify(last));
});

test("me/prefs: the language and zone of the account's mail (Idioma while signed in); a TV gets 403; anything else is bad_prefs", async () => {
  const { env, obj, outbox } = makeEnv();
  const ip = ips();
  const a = await signUp(env, outbox, 'prefs@x.com', ip(0), { username: 'Ana_Prefs' });
  const r = await post(env, '/api/me/prefs', { ip: ip(0), bearer: a.json.session, body: { lang: 'en', tz: 'Europe/Madrid' } });
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  assert.deepEqual([row(obj, a.json.playerId).lang, row(obj, a.json.playerId).tz], ['en', 'Europe/Madrid']);
  assert.equal((await post(env, '/api/me/prefs', { ip: ip(0), bearer: a.json.session, body: { lang: 'es', tz: '' } })).status, 200, 'no zone');
  for (const body of [{ lang: 'fr', tz: '' }, { lang: 'es', tz: 'Mars/Olympus' }, { lang: 'es', tz: '../etc' }, {}]) assert.deepEqual([(await post(env, '/api/me/prefs', { ip: ip(0), bearer: a.json.session, body })).json.error], ['bad_prefs'], JSON.stringify(body));
  const tv = await sessionOf(env, a.json.playerId, 'Ana_Prefs', { tv: true });
  const t = await post(env, '/api/me/prefs', { ip: ip(0), bearer: tv, body: { lang: 'en', tz: '' } });
  assert.deepEqual([t.status, t.json.error], [403, 'tv_session']);
  assert.equal(row(obj, a.json.playerId).lang, 'es', 'a TV never sets the language');
  assert.equal((await post(env, '/api/me/prefs', { ip: ip(0), body: { lang: 'en', tz: '' } })).status, 401);
});

// ---- the cutoff ---------------------------------------------------------------------------------------------

/** YYYY-MM-DD of a time. */
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const noonOf = (t) => Date.parse(isoDay(t) + 'T12:00:00Z');

test('the cutoff: unset, no date and no AccountsDO call; with a date, its floor is legacy_seen + 30 days and a later date extends it; GET /api/config says the phase', async () => {
  const none = makeEnv();
  const cfg0 = await req(none.env, 'GET', '/api/config');
  assert.deepEqual(cfg0.json.auth.legacy, { phase: 'none', until: null });
  assert.deepEqual(none.calls.filter((p) => p === '/legacy'), [], 'no call while unset');
  const soon = Date.now() + 10 * DAY;
  const { env, obj, calls } = makeEnv({ LEGACY_PASSWORD_UNTIL: isoDay(soon) + 'x' });
  assert.deepEqual((await req(env, 'GET', '/api/config')).json.auth.legacy, { phase: 'none', until: null }, 'not a date: none');
  env.LEGACY_PASSWORD_UNTIL = isoDay(soon);
  const seenAt = Date.now();
  obj.now = () => seenAt;
  const c1 = await req(env, 'GET', '/api/config');
  const floor = seenAt + 30 * DAY;
  assert.deepEqual(c1.json.auth.legacy, { phase: 'grace', until: floor }, 'a date 10 days ahead: at least 30 days from when it was first seen');
  assert.equal(Number(obj.store.sql.exec("SELECT v FROM meta WHERE k = 'legacy_seen'").toArray()[0].v), seenAt);
  const n = calls.filter((p) => p === '/legacy').length;
  await req(env, 'GET', '/api/config');
  assert.equal(calls.filter((p) => p === '/legacy').length, n, 'asked once per isolate and value');
  // A later date extends the grace; it reads at 12:00 UTC.
  const later = Date.now() + 60 * DAY;
  obj.now = () => seenAt + DAY;
  env.LEGACY_PASSWORD_UNTIL = isoDay(later);
  assert.deepEqual((await req(env, 'GET', '/api/config')).json.auth.legacy, { phase: 'grace', until: noonOf(later) });
  // An earlier one stops at the floor, which the first sight set.
  env.LEGACY_PASSWORD_UNTIL = isoDay(Date.now() - 5 * DAY);
  assert.deepEqual((await req(env, 'GET', '/api/config')).json.auth.legacy, { phase: 'grace', until: floor });
  assert.deepEqual(obj.legacy(floor + 1), { phase: 'closed', until: floor });
  // Unset again: the daily alarm forgets the floor's start, so a new value gives its full 30 days.
  delete env.LEGACY_PASSWORD_UNTIL;
  await obj.alarm();
  assert.equal(obj.store.sql.exec("SELECT COUNT(*) AS n FROM meta WHERE k = 'legacy_seen'").toArray()[0].n, 0);
});

/** An env whose cutoff passed: first seen 40 days ago, a date 35 days ago (the cutoff 10 days ago). */
function closedEnv(extra = {}) {
  const e = makeEnv({ LEGACY_PASSWORD_UNTIL: isoDay(Date.now() - 35 * DAY), ...extra });
  e.obj.store.legacyCutoff(noonOf(Date.now() - 35 * DAY), Date.now() - 40 * DAY);
  return e;
}

test('after the cutoff: login and recover answer 410 legacy_closed { until } with no lookup; a password without a verified email no longer counts as a way in', async () => {
  const { env, obj, calls } = closedEnv();
  const ip = ips();
  const ana = await legacyAccount(obj, 'Ana_Cierre');
  const cfg = await req(env, 'GET', '/api/config');
  assert.equal(cfg.json.auth.legacy.phase, 'closed');
  calls.length = 0;
  const r = await login(env, { username: 'Ana_Cierre', password: ana.v1, passwordV2: ana.v2 }, ip(0));
  assert.deepEqual([r.status, r.json.error, r.json.until], [410, 'legacy_closed', cfg.json.auth.legacy.until]);
  assert.deepEqual(calls, [], 'no lookup: the AccountsDO never heard of it');
  const rc = await post(env, '/api/auth/recover', { ip: ip(0), body: { username: 'Ana_Cierre', code: 'AAAA-BBBB', passwordV2: KEY } });
  assert.deepEqual([rc.status, rc.json.error], [410, 'legacy_closed']);
  assert.deepEqual(calls, []);
  // The AccountsDO refuses a username sign-in by itself too (a Worker of before).
  const headers = { 'content-type': 'application/json', [AUTH.INTERNAL_HEADER]: await AUTH.internalSecret(SECRET) };
  const direct = await obj.fetch(new Request('https://accounts/auth-begin', { method: 'POST', headers, body: JSON.stringify({ username: 'Ana_Cierre', ip: '1.2.3.4', charge: true }) }));
  assert.equal(direct.status, 410);
  // A password-only account has no way in left; one with Discord keeps that one, and cannot unlink it.
  obj.store.sql.exec('UPDATE users SET discord_id = ? WHERE id = ?', 'd-ana', ana.id);
  const s = await sessionOf(env, ana.id, 'Ana_Cierre', { authAt: Date.now(), authLvl: 2 });
  const me = await req(env, 'GET', '/api/me', { bearer: s, ip: ip(1) });
  assert.equal(me.json.waysIn, 1, 'Discord only: the password signs in nowhere now');
  const un = await post(env, '/api/auth/unlink', { ip: ip(1), bearer: s, body: { provider: 'discord' } });
  assert.deepEqual([un.status, un.json.error], [409, 'last_method']);
});

test("after the cutoff: \"confirm it's you\" with a password of before (v1) still works and re-keys it, and an email can then be added; the same password then signs in by email", async () => {
  const { env, obj, outbox } = closedEnv();
  const ip = ips();
  const ana = await legacyAccount(obj, 'Ana_Salva');
  // Still signed in by cookie (never re-keyed): level 0.
  obj.store.addRefresh(ana.id, await A.sha256Hex('c'.repeat(43)), Date.now(), 0);
  const s = await refresh(env, 'c'.repeat(43), ip(0));
  assert.equal(s.status, 200);
  const first = await askEmail(env, s.json.session, 'ana.salva@x.com', ip(0));
  assert.deepEqual([first.status, first.json.error, first.json.level], [403, 'reauth_required', 2], 'the password of before first');
  const re = await post(env, '/api/auth/reauth', { ip: ip(0), bearer: s.json.session, cookie: '__Host-tg_rt=' + s.rt, body: { legacy: ana.v1, password: ana.v2 } });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  assert.equal(row(obj, ana.id).pw_v, 2, 're-keyed after the cutoff');
  const ask = await askEmail(env, re.json.session, 'ana.salva@x.com', ip(0));
  assert.equal(ask.status, 200, JSON.stringify(ask.json));
  const ok = await verifyEmail(env, re.json.session, ask.json.attempt, codeIn(outbox.at(-1)), ip(0), '__Host-tg_rt=' + s.rt);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.waysIn, 1, 'the password counts again: it signs in by email');
  assert.equal((await signin(env, 'ana.salva@x.com', ana.v2, ip(1))).status, 200);
});

test('M10 from the alarm: in the last 7 days before the cutoff, a reset link to each account whose password is still of before and has a verified address, once per cutoff; nothing earlier, nothing without live mail', async () => {
  const until = Date.now() + 5 * DAY;
  const { env, obj, outbox } = makeEnv({ LEGACY_PASSWORD_UNTIL: isoDay(until) });
  obj.store.legacyCutoff(noonOf(until), Date.now() - 40 * DAY);
  const ana = await legacyAccount(obj, 'Ana_Recuerda');
  assert.equal(obj.store.claimEmail(ana.id, 'ana.recuerda@x.com', 'mail', Date.now()), 'ok');
  await legacyAccount(obj, 'Sin_Correo1');
  storeAccount(obj, 'Ya_Rekeyed', { pw: { hash: 'a'.repeat(64), salt: 'b'.repeat(32), iter: 100000, v: 2 }, email: 'rekeyed@x.com' });
  assert.equal(await obj.legacyAlarm(Date.now()), 1);
  assert.equal(outbox.length, 1);
  const m = outbox[0];
  assert.equal(m.to, 'ana.recuerda@x.com');
  assert.match(m.subject, /^Your Turbogol username stops signing in on /, 'the account has no language: English');
  assert.equal(linkIn(m).kind, 'reset');
  assert.equal((await post(env, '/api/auth/reset/peek', { body: { token: linkIn(m).token } })).json.name, 'Ana_Recuerda', 'its link is a live reset');
  assert.equal(await obj.legacyAlarm(Date.now() + 1000), 0, 'once per account and cutoff');
  // Earlier than 7 days before, nothing; without live mail, nothing at all (no row, no token).
  const far = makeEnv({ LEGACY_PASSWORD_UNTIL: isoDay(Date.now() + 20 * DAY) });
  far.obj.store.legacyCutoff(noonOf(Date.now() + 20 * DAY), Date.now() - 40 * DAY);
  const b = await legacyAccount(far.obj, 'Beto_Lejos');
  far.obj.store.claimEmail(b.id, 'beto.lejos@x.com', 'mail', Date.now());
  assert.equal(await far.obj.legacyAlarm(Date.now()), 0);
  const stub = makeEnv({ LEGACY_PASSWORD_UNTIL: isoDay(until), MAIL_LIVE: undefined });
  stub.obj.store.legacyCutoff(noonOf(until), Date.now() - 40 * DAY);
  const c = await legacyAccount(stub.obj, 'Ceci_Stub');
  stub.obj.store.claimEmail(c.id, 'ceci.stub@x.com', 'mail', Date.now());
  assert.equal(await stub.obj.legacyAlarm(Date.now()), 0);
  assert.equal(stub.obj.store.sql.exec('SELECT COUNT(*) AS n FROM mail_tokens').toArray()[0].n, 0);
  assert.equal(stub.outbox.length, 0);
});

// The mailer and its stub (src/mail.ts; docs/online/MAIL.md). Nothing here sends mail or talks to
// Cloudflare: the "binding" is a fake that records what it is handed. What it holds:
//   - only chooseMailer's conditions (EMAIL, MAIL_LIVE=1, a sender, a host that is not loopback)
//     give the live mailer, and only chooseMailer reads env.EMAIL;
//   - wrangler.jsonc's binding has no `remote` flag (wrangler dev then simulates it locally), and no
//     committed file sets MAIL_LIVE or DEV_AUTH;
//   - every URL of every mail is LINK_ORIGIN's even under a hostile Host and Origin;
//   - the live adapter sends one recipient, the sender, both bodies and the transactional headers;
//   - a failure logs no address, link or code; the dev outbox answers 404 off its gate.
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGIN, TOKEN, assertOwnUrls, captureConsole, renderAll } from './mailSamples.mjs';

const M = await import('../src/mail.ts');
const T = await import('../src/mailTemplates.ts');
const C = await import('../src/mailCaps.ts');

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(SERVER, '..');
const SENDER = 'Turbogol <no-reply@turbo-gol.com>';

const req = (url, headers = {}) => new Request(url, { headers });
const PROD = () => req('https://turbo-gol.com/api/auth/signup/start', { Origin: ORIGIN });

function fakeBinding() {
  const calls = [];
  return { calls, async send(m) { calls.push(m); return { messageId: 'm' + calls.length }; } };
}

const LIVE_ENV = (binding = fakeBinding()) => ({ EMAIL: binding, MAIL_LIVE: '1', MAIL_FROM: SENDER, MAIL_LINK_ORIGIN: ORIGIN });

// ---- Links: only LINK_ORIGIN, whatever the request says -------------------------------------------

test('a hostile Host and Origin never reach a mail: production takes MAIL_LINK_ORIGIN, a loopback host its own', () => {
  const env = { MAIL_LINK_ORIGIN: ORIGIN };
  const hostile = [
    req('https://evil.example/api/auth/forgot', { Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example', Referer: 'https://evil.example/' }),
    req('https://turbo-gol.com/api/auth/forgot', { Host: 'evil.example', Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example' }),
    req('https://evil.localhost.evil.example/api/auth/forgot', { Origin: 'http://localhost:5173' }),
  ];
  for (const r of hostile) {
    const origin = M.linkOrigin(r, env);
    assert.equal(origin, ORIGIN);
    const all = renderAll(T, origin);
    assertOwnUrls(all, ORIGIN);
    for (const { r: m } of all) assert.ok(!(m.subject + m.text + m.html).includes('evil'));
  }
  // A loopback host (wrangler dev): a loopback Origin, else the Vite default; never a foreign Origin.
  assert.equal(M.linkOrigin(req('http://127.0.0.1:8787/api/x', { Origin: 'https://evil.example' }), env), M.DEV_LINK_ORIGIN);
  assert.equal(M.linkOrigin(req('http://127.0.0.1:8787/api/x', { Origin: 'http://localhost:5494' }), env), 'http://localhost:5494');
  assert.equal(M.linkOrigin(req('http://localhost:8787/api/x', { Origin: 'http://127.0.0.1:5173/some/path' }), env), 'http://127.0.0.1:5173');
  assert.equal(M.linkOrigin(req('http://[::1]:8787/api/x'), env), M.DEV_LINK_ORIGIN);
  assert.equal(M.linkOrigin(req('http://127.0.0.1:8787/api/x', { Origin: 'javascript:alert(1)' }), env), M.DEV_LINK_ORIGIN);
  const dev = renderAll(T, M.linkOrigin(req('http://127.0.0.1:8787/api/x', { Origin: 'https://evil.example' }), env));
  assertOwnUrls(dev, M.DEV_LINK_ORIGIN);
  // Production without a usable var: no origin (the route answers 503 email_unconfigured).
  for (const v of [undefined, '', 'http://turbo-gol.com', 'https://turbo-gol.com/account', 'not a url', 'https://turbo-gol.com?x=1']) assert.equal(M.linkOrigin(PROD(), { MAIL_LINK_ORIGIN: v }), null, String(v));
  assert.equal(M.linkOrigin(PROD(), { MAIL_LINK_ORIGIN: 'https://turbo-gol.com/' }), ORIGIN, 'a trailing slash is the same origin');
});

// ---- The mailers ----------------------------------------------------------------------------------

function chooseCases(b) {
  const stub = (r, env) => {
    const m = M.chooseMailer(r, env, []);
    assert.equal(m.live, false);
    assert.ok(m instanceof M.StubMailer);
  };
  assert.equal(M.chooseMailer(PROD(), LIVE_ENV(b)).live, true);
  assert.ok(M.chooseMailer(PROD(), LIVE_ENV(b)) instanceof M.LiveMailer);
  stub(PROD(), { ...LIVE_ENV(b), EMAIL: undefined });
  for (const v of [undefined, '', '0', 'true', 'on', ' 1', 'yes']) stub(PROD(), { ...LIVE_ENV(b), MAIL_LIVE: v });
  for (const v of [undefined, '', 'Turbogol', 'a@b.com, c@d.com']) stub(PROD(), { ...LIVE_ENV(b), MAIL_FROM: v });
  for (const host of ['http://localhost:8787', 'http://127.0.0.1:8994', 'http://[::1]:8787', 'http://tg.localhost:8787']) stub(req(host + '/api/auth/forgot', { Origin: ORIGIN }), LIVE_ENV(b));
}

test('chooseMailer: the live mailer only with EMAIL, MAIL_LIVE=1, a sender and a host that is not loopback', async () => {
  const b = fakeBinding();
  const lines = await captureConsole(() => chooseCases(b));
  assert.equal(lines.filter((l) => l.includes('MAIL_FROM is not a sender')).length, 4, 'a bad MAIL_FROM is said once per choice');
  assert.equal(b.calls.length, 0, 'choosing sends nothing');
});

test('the stub on a loopback host and on a deploy without MAIL_LIVE never touches the binding', async () => {
  const b = fakeBinding();
  const r = T.renderMail({ kind: 'reset', name: 'Ana', variant: 'reset', token: TOKEN }, { origin: ORIGIN, lang: 'es' });
  const msg = M.composeMail('ana.perez@example.org', r);
  const lines = await captureConsole(async () => {
    await M.chooseMailer(req('http://127.0.0.1:8787/api/auth/forgot'), LIVE_ENV(b), []).send(msg);
    await M.chooseMailer(PROD(), { ...LIVE_ENV(b), MAIL_LIVE: undefined }, []).send(msg);
  });
  assert.equal(b.calls.length, 0);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], `[mail stub] reset to an***@example.org ${r.link}`, 'loopback: the link, for the developer');
  assert.ok(!lines[1].includes('ana') && !lines[1].includes(TOKEN) && !lines[1].includes('@'), 'a deploy: no address, no link');
});

test('the stub keeps the last 20 messages on a loopback host, nothing on a deploy', async () => {
  const local = new M.StubMailer(true, []);
  const deploy = new M.StubMailer(false, []);
  await captureConsole(async () => {
    for (let i = 0; i < 25; i++) {
      const code = String(100000 + i);
      const m = M.composeMail(`p${i}@example.org`, T.renderMail({ kind: 'reauth_code', name: 'Ana', code }, { origin: ORIGIN, lang: 'en' }));
      await local.send(m);
      await deploy.send(m);
    }
  });
  assert.equal(local.outbox.length, M.OUTBOX_SIZE);
  assert.equal(local.outbox[0].to, 'p5@example.org');
  assert.equal(local.outbox.at(-1).code, '100024');
  assert.equal(deploy.outbox.length, 0);
});

test('the live mailer sends one recipient, the sender, both bodies and the transactional headers', async () => {
  const b = fakeBinding();
  const mailer = M.chooseMailer(PROD(), LIVE_ENV(b));
  const r = T.renderMail({ kind: 'verify_signup', code: '048213', token: TOKEN }, { origin: ORIGIN, lang: 'es' });
  const a = M.composeMail('ana@example.org', r);
  assert.equal(a.lane, C.laneOf('verify_signup'));
  await mailer.send(a);
  await mailer.send(M.composeMail('ana@example.org', r));
  assert.equal(b.calls.length, 2);
  const sent = b.calls[0];
  assert.deepEqual(Object.keys(sent).sort(), ['from', 'headers', 'html', 'subject', 'text', 'to'], 'no cc, bcc, replyTo or attachments');
  assert.equal(sent.to, 'ana@example.org');
  assert.deepEqual(sent.from, { name: 'Turbogol', email: 'no-reply@turbo-gol.com' });
  assert.equal(sent.subject, '048213 es tu código de Turbogol');
  assert.equal(sent.text, r.text);
  assert.equal(sent.html, r.html);
  assert.equal(sent.headers['Auto-Submitted'], 'auto-generated');
  assert.equal(sent.headers['X-Auto-Response-Suppress'], 'All');
  assert.match(sent.headers['X-Entity-Ref-ID'], /^[0-9a-f]{32}$/);
  assert.notEqual(sent.headers['X-Entity-Ref-ID'], b.calls[1].headers['X-Entity-Ref-ID'], 'one ref per message');
  assert.deepEqual(Object.keys(sent.headers).sort(), ['Auto-Submitted', 'X-Auto-Response-Suppress', 'X-Entity-Ref-ID'], 'no List-Unsubscribe: transactional');
  // Never a second recipient, a display name or a header in the address.
  for (const to of ['a@x.com, b@y.com', 'a@x.com;b@y.com', 'a@x.com\r\nBcc: c@z.com', 'Ana <a@x.com>', 'a@x.com b@y.com', '', 'nobody', 'a@b']) {
    assert.throws(() => M.composeMail(to, r), /one recipient/, JSON.stringify(to));
    await assert.rejects(mailer.send({ ...a, to }), /one recipient/, JSON.stringify(to));
  }
  await assert.rejects(mailer.send({ ...a, subject: 'x\r\nBcc: c@z.com' }), /subject/);
  assert.equal(b.calls.length, 2, 'a refused message never reaches the binding');
});

test('parseSender: a named sender, a bare address, or nothing', () => {
  assert.deepEqual(M.parseSender(SENDER), { name: 'Turbogol', email: 'no-reply@turbo-gol.com' });
  assert.equal(M.parseSender('no-reply@turbo-gol.com'), 'no-reply@turbo-gol.com');
  for (const v of [undefined, '', 'Turbogol', 'Turbogol <a@b.com>, x@y.com', 'T <a@b.com> <c@d.com>', '"T\r\n" <a@b.com>']) assert.equal(M.parseSender(v), null, String(v));
});

test('deliver: a failed send logs kind, lane and the error code, never the address, link or code; no retry', async () => {
  let tries = 0;
  const failing = {
    live: true,
    async send() {
      tries++;
      const e = new Error('recipient ana@example.org suppressed for https://turbo-gol.com/account#verify=' + TOKEN);
      e.code = 'E_RECIPIENT_SUPPRESSED';
      throw e;
    },
  };
  const msg = M.composeMail('ana@example.org', T.renderMail({ kind: 'verify_signup', code: '048213', token: TOKEN }, { origin: ORIGIN, lang: 'en' }));
  const failed = [];
  let ok;
  const lines = await captureConsole(async () => {
    ok = await M.deliver(failing, msg, (kind, lane) => failed.push([kind, lane]));
  });
  assert.equal(ok, false);
  assert.equal(tries, 1);
  assert.deepEqual(failed, [['verify_signup', 'signup']]);
  assert.deepEqual(lines, ['mail_failed kind=verify_signup lane=signup err=E_RECIPIENT_SUPPRESSED']);
  // A plain error gives its name; a throwing failure counter never escapes into waitUntil.
  const plain = await captureConsole(async () => {
    ok = await M.deliver({ live: true, send: async () => { throw new TypeError('boom ana@example.org'); } }, msg, () => { throw new Error('do down'); });
  });
  assert.equal(ok, false);
  assert.deepEqual(plain, ['mail_failed kind=verify_signup lane=signup err=TypeError']);
  const b = fakeBinding();
  assert.equal(await M.deliver(new M.LiveMailer(b, 'no-reply@turbo-gol.com'), msg), true);
  assert.equal(b.calls.length, 1);
});

test('emailAvailable: the flows that mail show only when a mailer delivers and the kill flag is off', async () => {
  const kv = (v) => ({ get: async (k) => (k === 'email_off' ? v : null) });
  const broken = { get: async () => { throw new Error('kv down'); } };
  assert.equal(await M.emailAvailable(PROD(), { ...LIVE_ENV(), FLAGS: kv(null) }), true);
  assert.equal(await M.emailAvailable(PROD(), { ...LIVE_ENV(), FLAGS: kv('1') }), false, 'killed');
  assert.equal(await M.emailAvailable(PROD(), { ...LIVE_ENV(), FLAGS: broken }), true, 'a KV that cannot be read counts as not set');
  assert.equal(await M.emailAvailable(PROD(), { ...LIVE_ENV(), MAIL_LIVE: undefined, FLAGS: kv(null) }), false, 'a deploy that forgot MAIL_LIVE never offers a code');
  assert.equal(await M.emailAvailable(PROD(), { ...LIVE_ENV(), MAIL_LINK_ORIGIN: undefined, FLAGS: kv(null) }), false, 'no link origin');
  assert.equal(await M.emailAvailable(req('http://127.0.0.1:8787/api/config'), { FLAGS: kv(null) }), true, 'wrangler dev: the stub outbox');
  assert.equal(await M.emailAvailable(req('http://127.0.0.1:8787/api/config'), { FLAGS: kv('on') }), false);
});

// ---- The dev outbox -------------------------------------------------------------------------------

test('GET /api/dev/mail: 404 whenever the gate is closed; the outbox, newest first, behind it', async () => {
  const outbox = [];
  const stub = new M.StubMailer(true, outbox);
  await captureConsole(async () => {
    await stub.send(M.composeMail('a@example.org', T.renderMail({ kind: 'verify_signup', code: '111111', token: TOKEN }, { origin: 'http://localhost:5173', lang: 'en' })));
    await stub.send(M.composeMail('b@example.org', T.renderMail({ kind: 'reauth_code', name: 'Ana', code: '222222' }, { origin: 'http://localhost:5173', lang: 'en' })));
  });
  const closed = [
    [req('http://127.0.0.1:8787/api/dev/mail'), {}],
    [req('http://127.0.0.1:8787/api/dev/mail'), { DEV_AUTH: '0' }],
    [req('http://127.0.0.1:8787/api/dev/mail'), { DEV_AUTH: 'true' }],
    [req('https://turbo-gol.com/api/dev/mail'), { DEV_AUTH: '1' }],
    [req('https://turbo-gol.com/api/dev/mail', { Origin: 'http://localhost:5173' }), { DEV_AUTH: '1' }],
    [req('http://127.0.0.1:8787/api/dev/mail', { Origin: 'https://evil.example' }), { DEV_AUTH: '1' }],
    [new Request('http://127.0.0.1:8787/api/dev/mail', { method: 'POST' }), { DEV_AUTH: '1' }],
  ];
  for (const [r, env] of closed) {
    const res = M.devMailResponse(r, env, outbox);
    assert.equal(res.status, 404, `${r.method} ${r.url} ${JSON.stringify(env)}`);
    assert.deepEqual(await res.json(), { error: 'not_found', message: 'not_found' }, 'the same answer as any unknown route');
  }
  const open = M.devMailResponse(req('http://127.0.0.1:8787/api/dev/mail', { Origin: 'http://localhost:5173' }), { DEV_AUTH: '1' }, outbox);
  assert.equal(open.status, 200);
  assert.equal(open.headers.get('cache-control'), 'no-store');
  const { messages } = await open.json();
  assert.deepEqual(messages.map((m) => [m.kind, m.to, m.code ?? null]), [['reauth_code', 'b@example.org', '222222'], ['verify_signup', 'a@example.org', '111111']]);
  assert.equal(messages[1].link, 'http://localhost:5173/account#verify=' + TOKEN);
  assert.equal(M.devMailResponse(req('http://localhost:8787/api/dev/mail'), { DEV_AUTH: '1' }, outbox).status, 200, 'no Origin: a curl from this machine');
});

// ---- Only mail.ts touches the binding; the committed config never sends from dev ------------------

function tsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

test('env.EMAIL and .EMAIL.send appear only in src/mail.ts, inside chooseMailer: no path bypasses it', () => {
  const src = join(SERVER, 'src');
  const offenders = [];
  for (const f of tsFiles(src)) {
    const name = relative(src, f).replace(/\\/g, '/');
    if (name === 'mail.ts') continue;
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (!/\bEMAIL\b/.test(line)) return;
      // env.ts declares the binding's field and may name it in its comments.
      if (name === 'env.ts' && (/^\s*EMAIL\?: MailBinding;$/.test(line) || /^\s*(\*|\/\/|\/\*)/.test(line))) return;
      offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
  const mail = readFileSync(join(src, 'mail.ts'), 'utf8');
  const start = mail.indexOf('export function chooseMailer(');
  const end = mail.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  // Every read of the binding (env.EMAIL, env['EMAIL'], a destructured EMAIL, EMAIL.send) sits in
  // chooseMailer; a type such as Pick<Env, 'EMAIL'> reads nothing.
  const access = /\benv\s*\??\.\s*EMAIL\b|\[\s*['"`]EMAIL['"`]\s*\]|\bEMAIL\s*\??\.\s*send\b|\{[^}]*\bEMAIL\b[^}]*\}\s*=/g;
  for (const bypass of ['await env.EMAIL.send(m)', 'env?.EMAIL', "env['EMAIL']", 'const { EMAIL, FLAGS } = env', 'EMAIL.send(m)']) assert.equal([...bypass.matchAll(access)].length > 0, true, bypass);
  const reads = [...mail.matchAll(access)].map((m) => m.index).filter((i) => !/^\s*(\*|\/\/)/.test(mail.slice(mail.lastIndexOf('\n', i) + 1, i)));
  assert.ok(reads.length > 0);
  for (const i of reads) assert.ok(i > start && i < end, 'env.EMAIL read outside chooseMailer, at offset ' + i);
});

test("mail.ts's loopback test is index.ts's", () => {
  const body = (file) => {
    const s = readFileSync(join(SERVER, 'src', file), 'utf8');
    const m = /function isLoopbackHost\(h: string\): boolean \{\n([^}]*)\}/.exec(s);
    assert.ok(m, file);
    return m[1].trim();
  };
  assert.equal(body('mail.ts'), body('index.ts'));
});

/** wrangler.jsonc without its comments and trailing commas. */
function readJsonc(file) {
  const s = readFileSync(file, 'utf8');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      i = s.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

test('wrangler.jsonc: the EMAIL binding without "remote" (wrangler dev simulates it), and the mail vars', () => {
  const cfg = readJsonc(join(SERVER, 'wrangler.jsonc'));
  assert.deepEqual(cfg.send_email, [{ name: 'EMAIL' }], 'one binding, no remote flag, no other key');
  for (const [name, env] of Object.entries(cfg.env ?? {})) for (const b of env.send_email ?? []) assert.ok(!('remote' in b), `env.${name}`);
  assert.deepEqual(M.parseSender(cfg.vars.MAIL_FROM), { name: 'Turbogol', email: 'no-reply@turbo-gol.com' });
  assert.equal(M.linkOrigin(PROD(), cfg.vars), ORIGIN);
  assert.equal(C.dailyCap(cfg.vars), 100);
  assert.equal(cfg.vars.EMAIL_DAILY_CAP, 100, 'set, not the fallback');
});

test('neither wrangler.jsonc vars nor any committed example file sets MAIL_LIVE or DEV_AUTH', () => {
  const cfg = readJsonc(join(SERVER, 'wrangler.jsonc'));
  const scopes = [['vars', cfg.vars ?? {}], ...Object.entries(cfg.env ?? {}).map(([n, e]) => [`env.${n}.vars`, e.vars ?? {}])];
  for (const [where, vars] of scopes) for (const k of ['MAIL_LIVE', 'DEV_AUTH']) assert.ok(!(k in vars), `${where}.${k}`);
  let files;
  try {
    files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    files = ['server/.dev.vars.example'].filter((f) => existsSync(join(ROOT, f))); // a tarball without git
  }
  const examples = files.filter((f) => /(^|\/)(\.dev\.vars[^/]*|\.env[^/]*|[^/]*\.example)$/.test(f));
  assert.ok(examples.includes('server/.dev.vars.example'), 'the example file is found');
  for (const f of examples) assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), /^\s*(?:export\s+)?(?:MAIL_LIVE|DEV_AUTH)\s*=/m, f);
});

test('mail.ts names neither the commercial game nor its studio', () => {
  const banned = ['cm9ja2V0bGVhZ3Vl', 'cHN5b25peA=='].map((b) => Buffer.from(b, 'base64').toString('utf8'));
  const src = readFileSync(join(SERVER, 'src', 'mail.ts'), 'utf8').toLowerCase().replace(/[^a-z]/g, '');
  for (const w of banned) assert.ok(!src.includes(w));
});

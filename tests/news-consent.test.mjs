// The news consent in the browser (sign-in PR 13, the design's §2.11 and §3.14; no news is sent):
// AccountClient.setNews (PERFIL's switch: POST /api/me/consent) and unsubscribeNews (the page's
// form of POST /api/news/unsubscribe, from a news mail's /account#unsub=<id>); PERFIL's PRIVACIDAD
// switch, shown only with a verified address and never on a TV; the /account#unsub= sheet, which
// changes nothing until its button and then says done; the copy in both languages. Against a fake
// fetch and a small fake DOM, as tests/account-deletion.test.mjs and tests/menu-accounts.test.mjs.
// The server's side: server/test/news-consent.test.mjs.
//   node --test tests/news-consent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  // The screens import package.json as Vite does (no `with { type: 'json' }`): its version, as a module.
  load(url, context, nextLoad) {
    if (url.endsWith('/package.json') && context.importAttributes?.type !== 'json') {
      const { version } = JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
      return { format: 'module', shortCircuit: true, source: `export const version = ${JSON.stringify(version)}; export default { version: ${JSON.stringify(version)} };` };
    }
    return nextLoad(url, context);
  },
});

const AC = await import('../src/net/AccountClient.ts');
const E = await import('../src/net/emailAuth.ts');
const P = await import('../src/ui/screens/profile.ts');
const SHEET = await import('../src/ui/components/sheet.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;
const PROFILE = readFileSync(new URL('../src/ui/screens/profile.ts', import.meta.url), 'utf8');
const LINKS = readFileSync(new URL('../src/ui/screens/accountLinks.ts', import.meta.url), 'utf8');

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

function fakeServer(handlers) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body, headers: init.headers });
    const h = handlers[path.split('?')[0]];
    if (!h) return res(404, { error: 'not_found' });
    return h(body, init.headers, calls);
  };
  return { fetchFn, calls };
}

const NOW = 1_800_000_000_000;
const SESSION = (extra = {}) => ({ kind: 'account', playerId: 'abcdef0123456789', name: 'Mariana', session: 'jwt-m', expiresAt: NOW + 3_600_000, authAt: NOW, authLvl: 2, ...extra });
const ME = (extra = {}) => ({ playerId: 'abcdef0123456789', name: 'Mariana', createdAt: 0, providers: ['password'], hasPassword: true, renameAt: 0, ratings: [], rankedBanUntil: 0, abandons24h: 0, season: 1, experimental: false, email: 'mariana@example.com', emailHint: null, emailVerified: true, legacy: false, news: false, deletionAt: 0, waysIn: 1, ...extra });
/** An unsubscribe id as the server mints it: 16 random bytes, base64url (22 characters). */
const UNSUB = 'Zx3_kQ-9aB1cD2eF3gH4iJ';

function client(handlers) {
  const srv = fakeServer(handlers);
  const session = memStorage();
  const acc = new AC.AccountClient({ storage: memStorage(), session, fetchFn: srv.fetchFn, now: () => NOW, sleep: async () => undefined, antiBot: async () => 'tok' });
  return { acc, calls: srv.calls, session };
}

// ---- AccountClient -----------------------------------------------------------------------------

test('setNews: POST /api/me/consent { kind: "news", granted } with the Bearer; the server\'s state, kept in this account\'s MeInfo without a redraw', async () => {
  let state = false;
  const { acc, calls } = client({
    '/api/auth/signin': () => res(200, SESSION()),
    '/api/me': () => res(200, ME({ news: state })),
    '/api/me/consent': (b, h) => (h.authorization === 'Bearer jwt-m' && b.kind === 'news' && typeof b.granted === 'boolean' ? ((state = b.granted), res(200, { news: state, terms: null })) : res(400, { error: 'bad_consent' })),
  });
  await acc.signIn('mariana@example.com', 'una clave larga');
  await acc.fetchMe();
  let changes = 0;
  acc.subscribe(() => changes++);
  const me = acc.me;
  assert.equal(await acc.setNews(true), true);
  const sent = calls.at(-1);
  assert.deepEqual([sent.path, sent.method, sent.body, sent.headers['content-type']], ['/api/me/consent', 'POST', { kind: 'news', granted: true }, 'application/json']);
  assert.equal(acc.me, me, 'the same MeInfo');
  assert.equal(acc.me.news, true);
  assert.equal(changes, 0, 'nothing else redraws on it');
  assert.equal(await acc.setNews(false), false);
  assert.equal(acc.me.news, false);
});

test('setNews refusals: email_required, tv_session and deletion_pending carry the player\'s text; the MeInfo stays as it was; a guest sends nothing', async () => {
  let answer = res(409, { error: 'email_required', message: 'Primero agrega un correo a tu cuenta.' });
  const { acc, calls } = client({
    '/api/auth/signin': () => res(200, SESSION()),
    '/api/me': () => res(200, ME({ news: true })),
    '/api/me/consent': () => answer,
  });
  await assert.rejects(acc.setNews(true), (e) => e instanceof AC.AccountError && e.code === 'unauthorized');
  assert.equal(calls.length, 0, 'signed out: no request');
  await acc.signIn('mariana@example.com', 'una clave larga');
  await acc.fetchMe();
  await assert.rejects(acc.setNews(true), (e) => e.code === 'email_required' && e.status === 409 && e.message === en['error.account.email_required']);
  answer = res(403, { error: 'tv_session', message: 'x' });
  await assert.rejects(acc.setNews(false), (e) => e.code === 'tv_session' && e.message === en['error.account.tv_session']);
  answer = res(409, { error: 'deletion_pending', message: 'x', purgeAt: NOW + 86_400_000 });
  await assert.rejects(acc.setNews(true), (e) => e.code === 'deletion_pending');
  assert.equal(acc.me.news, true, 'untouched by a refusal');
});

test('unsubscribeNews: the page\'s form, POST /api/news/unsubscribe { u } as JSON with no Bearer (signed in or not); the kept /account#unsub= link is spent; no network keeps it', async () => {
  let up = true;
  const { acc, calls } = client({
    '/api/news/unsubscribe': (b, h) => (up ? (h.authorization === undefined && typeof b.u === 'string' ? res(200, { ok: true }) : res(400, { error: 'bad_request' })) : Promise.reject(new TypeError('offline'))),
  });
  const link = E.parseAccountLink('/account', '#unsub=' + UNSUB);
  assert.deepEqual(link, { kind: 'unsub', token: UNSUB }, "the server's 22-character id is a link token");
  acc.keepPendingLink(link);
  up = false;
  await assert.rejects(acc.unsubscribeNews(UNSUB), (e) => e.code === 'network');
  assert.deepEqual(acc.pendingLink(), link, 'kept: the same link can go again');
  up = true;
  await acc.unsubscribeNews(UNSUB);
  const sent = calls.at(-1);
  assert.deepEqual([sent.path, sent.method, sent.body, sent.headers['content-type']], ['/api/news/unsubscribe', 'POST', { u: UNSUB }, 'application/json']);
  assert.ok(!sent.path.includes(UNSUB), 'the id goes in the body, never the query (R8)');
  assert.equal(acc.pendingLink(), null, 'spent');
});

// ---- PERFIL's switch (§3.14 step 2) -----------------------------------------------------------------

test('PERFIL shows "News by email" only with a verified address, no deletion pending and not on a TV', () => {
  assert.equal(P.newsSwitchShown(ME(), false), true);
  assert.equal(P.newsSwitchShown(ME({ news: true }), false), true);
  assert.equal(P.newsSwitchShown(ME(), true), false, 'a TV signed in with the phone: a full session changes it');
  assert.equal(P.newsSwitchShown(null, false), false);
  assert.equal(P.newsSwitchShown(ME({ email: null, emailVerified: false }), false), false, 'no email');
  assert.equal(P.newsSwitchShown(ME({ email: null, emailHint: 'mariana@example.com', emailVerified: false }), false), false, 'a provider\'s hint is no verified address');
  assert.equal(P.newsSwitchShown(ME({ email: undefined, emailVerified: true }), false), false, "a TV's /api/me has no address");
  assert.equal(P.newsSwitchShown(ME({ deletionAt: NOW + 86_400_000 }), false), false, 'a deletion pending');
  const { email, emailVerified, ...older } = ME();
  assert.equal(P.newsSwitchShown(older, false), false, 'a server of before the sign-in work');
});

test('PERFIL\'s switch: in PRIVACIDAD, under the replay switch, with its note; it reads the account\'s news (off by default), shows a press at once, and the server\'s answer to the newest press settles it; a refusal says why', () => {
  const view = PROFILE.slice(PROFILE.indexOf('const accountView = '), PROFILE.indexOf('/** ACERCA DE, under either view. */'));
  assert.match(view, /const newsRow = newsSwitchShown\(me, tvScope\) \? setRow\(t\('profile\.news'\), newsSwitch\.el, t\('profile\.newsHelp'\)\) : null;/);
  assert.match(view, /section\(t\('profile\.privacy'\), setRow\(t\('profile\.hideReplayName'\), hideSwitch\.el, t\('profile\.hideReplayNameHelp'\)\), newsRow\)/);
  assert.match(view, /toggleSwitch\(\s*'profile-news',\s*t\('profile\.news'\),\s*\(\) => \(newsChoice !== null && newsChoice\.who === who \? newsChoice\.on : newsMe\(\)\?\.news === true\)/, 'off unless the newest row is a grant');
  assert.match(view, /void acc\.setNews\(on\)\.then\(settle, \(e: unknown\) => \{\s*settle\(\);\s*menu\.toast\(errText\(e\), 'error'\);/);
  assert.match(view, /if \(seq === newsSeq\) newsChoice = null;/, 'an older answer never undoes a newer press');
});

// ---- the /account#unsub= sheet (§3.14 step 3) --------------------------------------------------------

/** A fake element: enough for src/ui/dom.ts h() and components/sheet.ts (tests/menu-accounts.test.mjs's). */
class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.text = '';
    this.dataset = {};
    this.classList = {
      add: (c) => (this.className = [...new Set([...this.className.split(' ').filter(Boolean), c])].join(' ')),
      remove: (c) => (this.className = this.className.split(' ').filter((x) => x && x !== c).join(' ')),
      toggle: (c, on) => ((on ?? !this.classList.contains(c)) ? this.classList.add(c) : this.classList.remove(c)),
      contains: (c) => this.className.split(' ').includes(c),
    };
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  removeAttribute(k) {
    this.attrs.delete(k);
  }
  hasAttribute(k) {
    return this.attrs.has(k);
  }
  appendChild(c) {
    this.children.push(c);
    if (c instanceof FakeEl) c.parentNode = this;
    return c;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, init = {}) {
    const e = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const fn of this.listeners.get(type) ?? []) fn(e);
    return e;
  }
  /** A button's click() (none while disabled, as a browser's), an input's focus() (document.activeElement). */
  click() {
    if (this.disabled !== true) this.dispatch('click');
  }
  focus() {
    globalThis.document.activeElement = this;
  }
  /** One compound of classes and a tag ('button.mn-btn-primary', '.mn-sheet'). */
  is(compound) {
    const [tag, ...classes] = compound.split('.');
    return (tag === '' || this.tagName === tag.toUpperCase()) && classes.every((c) => this.classList.contains(c));
  }
  closest(sel) {
    for (let e = this; e; e = e.parentNode) if (e.is(sel)) return e;
    return null;
  }
  /** Descendant selectors of compounds ('.mn-sheet-actions .mn-btn-primary'). */
  querySelector(sel) {
    const parts = sel.trim().split(/\s+/);
    const last = parts.pop();
    const within = (e) => {
      const up = [];
      for (let a = e.parentNode; a; a = a === this ? null : a.parentNode) up.push(a);
      return up;
    };
    return (
      this.all()
        .slice(1)
        .find((e) => {
          if (!e.is(last)) return false;
          const up = within(e);
          let at = 0;
          for (let i = parts.length - 1; i >= 0; i--) {
            while (at < up.length && !up[at].is(parts[i])) at++;
            if (at === up.length) return false;
            at++;
          }
          return true;
        }) ?? null
    );
  }
  set textContent(v) {
    this.text = String(v);
    this.children = [];
  }
  get textContent() {
    return this.text + this.children.map((c) => c.textContent ?? '').join('');
  }
  /** Every element under this one, this one first. */
  all() {
    return [this, ...this.children.filter((c) => c instanceof FakeEl).flatMap((c) => c.all())];
  }
}

const withDom = async (fn) => {
  const before = globalThis.document;
  globalThis.document = { createElement: (tag) => new FakeEl(tag), createTextNode: (t) => ({ textContent: String(t) }), documentElement: new FakeEl('html'), getElementById: () => null };
  try {
    return await fn();
  } finally {
    globalThis.document = before;
  }
};

/**
 * A Menu for accountLinks' sheets, as Menu.modal: modal() mounts the real sheet (components/sheet.ts)
 * and closes the one up first (a sheet that replaces another); a closer of a sheet gone does nothing.
 */
function sheetMenu(accounts) {
  const m = { cfg: { oauth: ['discord'] }, visible: true, sheet: null, spec: null, closer: null, closed: 0, toasts: [], host: { accounts } };
  Object.defineProperty(m, 'modalOpen', { get: () => m.sheet !== null });
  m.toast = (text, kind) => m.toasts.push([kind, text]);
  m.modal = (spec) => {
    m.closer?.();
    let up = true;
    const close = () => {
      if (!up) return;
      up = false;
      m.closed++;
      if (m.closer === close) {
        m.sheet = null;
        m.spec = null;
        m.closer = null;
      }
      spec.onClose?.();
    };
    m.closer = close;
    m.spec = spec;
    m.sheet = SHEET.sheetBox(spec, close);
    return close;
  };
  m.refocus = () => undefined;
  return m;
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const button = (menu, label) => menu.sheet?.all().find((e) => e.tagName === 'BUTTON' && e.textContent === label) ?? null;

test('/account#unsub=<id>: nothing changes until UNSUBSCRIBE; then "Done: we won\'t send you news anymore." (the same for any id); a signed-in account reads /api/me again; CANCEL sends nothing', async () => {
  const L = await import('../src/ui/screens/accountLinks.ts');
  await withDom(async () => {
    const calls = [];
    const acc = {
      signedIn: true,
      keepPendingLink: (l) => calls.push(['keep', l]),
      fetchMe: async () => void calls.push(['fetchMe']),
      unsubscribeNews: async (id) => void calls.push(['unsubscribe', id]),
    };
    const menu = sheetMenu(acc);
    await L.openAccountLink(menu, { kind: 'unsub', token: UNSUB });
    assert.equal(menu.spec.title, 'News by email');
    assert.ok(menu.sheet.textContent.includes(en['auth.unsubNote']));
    assert.deepEqual(calls, [], 'opening the link changes nothing (a mail scanner\'s visit)');
    button(menu, 'UNSUBSCRIBE').click();
    await settle();
    await settle();
    assert.deepEqual(calls.filter((c) => c[0] === 'unsubscribe'), [['unsubscribe', UNSUB]]);
    assert.equal(menu.spec.title, 'News by email');
    assert.ok(menu.sheet.textContent.includes("Done: we won't send you news anymore."));
    assert.ok(calls.some((c) => c[0] === 'fetchMe'), "PERFIL's switch reads the new state");
    assert.ok(calls.some((c) => c[0] === 'keep' && c[1] === null), 'the kept link is forgotten');
    // CANCELAR: nothing sent.
    const quiet = [];
    const menu2 = sheetMenu({ signedIn: false, keepPendingLink: (l) => quiet.push(['keep', l]), fetchMe: async () => quiet.push(['fetchMe']), unsubscribeNews: async (id) => quiet.push(['unsubscribe', id]) });
    await L.openAccountLink(menu2, { kind: 'unsub', token: UNSUB });
    button(menu2, 'CANCEL').click();
    await settle();
    assert.deepEqual(quiet, [['keep', null]]);
  });
});

test('/account#unsub=: no network says so in the sheet and keeps it up (the button can be pressed again); the keep link still says it is not valid here', async () => {
  const L = await import('../src/ui/screens/accountLinks.ts');
  await withDom(async () => {
    let tries = 0;
    const acc = {
      signedIn: false,
      keepPendingLink: () => undefined,
      fetchMe: async () => undefined,
      unsubscribeNews: async () => {
        tries++;
        if (tries === 1) throw new AC.AccountError(en['error.network'], 0, 'network');
      },
    };
    const menu = sheetMenu(acc);
    L.openUnsubSheet(menu, UNSUB);
    button(menu, 'UNSUBSCRIBE').click();
    await settle();
    await settle();
    assert.equal(menu.spec.title, 'News by email');
    assert.ok(menu.sheet.textContent.includes(en['error.network']));
    assert.equal(menu.closed, 0);
    button(menu, 'UNSUBSCRIBE').click();
    await settle();
    await settle();
    assert.equal(tries, 2);
    assert.ok(menu.sheet.textContent.includes("Done: we won't send you news anymore."));
    // keep: its sheet comes with the terms of service.
    const toasts = sheetMenu({ keepPendingLink: () => undefined });
    await L.openAccountLink(toasts, { kind: 'keep', token: 'K'.repeat(43) });
    assert.deepEqual(toasts.toasts, [['error', en['error.account.link_invalid']]]);
  });
  assert.match(LINKS, /if \(link\.kind === 'unsub'\) return openUnsubSheet\(menu, link\.token\);/);
});

// ---- the copy ---------------------------------------------------------------------------------------

test('the copy, as the design quotes it, in both languages (Spanish with tú)', () => {
  assert.equal(es['profile.news'], 'Novedades por correo');
  assert.equal(en['profile.news'], 'News by email');
  assert.equal(es['profile.newsHelp'], 'Solo noticias de Turbogol, nunca de terceros. Puedes darte de baja cuando quieras.');
  assert.equal(en['profile.newsHelp'], 'Only Turbogol news, never third parties. Unsubscribe any time.');
  assert.equal(es['auth.unsubDone'], 'Listo: ya no te enviamos novedades.');
  assert.equal(en['auth.unsubDone'], "Done: we won't send you news anymore.");
  for (const k of ['auth.unsubTitle', 'auth.unsubNote', 'auth.unsubConfirm']) {
    assert.equal(typeof es[k], 'string', k);
    assert.equal(typeof en[k], 'string', k);
  }
  assert.equal(es['auth.unsubConfirm'], 'DARME DE BAJA');
  assert.equal(en['auth.unsubConfirm'], 'UNSUBSCRIBE');
  // The sign-up's and the confirm step's switches are the existing ones, at NO (accountLinks.ts).
  assert.match(LINKS, /let news = false;\s*const newsSwitch = toggleSwitch\('auth-news', t\('auth\.signupNews'\)/);
  assert.match(LINKS, /let news = false;\s*const sw = toggleSwitch\('auth-news', t\('auth\.news'\)/);
});

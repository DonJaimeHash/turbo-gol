// Shared by the mail tests (mail.test.mjs, mail-templates.test.mjs, mail-caps.test.mjs): the
// resolver for the Worker's extensionless TypeScript imports, one sample of every message and
// variant, and the URL checks. Imported first, so the hook is in place before any src/ module loads.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const rel = specifier.startsWith('./') || specifier.startsWith('../');
      if (rel && err && err.code === 'ERR_MODULE_NOT_FOUND' && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
      throw err;
    }
  },
});

export const ORIGIN = 'https://turbo-gol.com';
export const TOKEN = 'Zq3_vR8-kP2mXw9LhT4cYb7NfJ1sDe6GaU5oQiW0tE'; // 43 base64url characters, as a link token is
export const AT = Date.UTC(2026, 9, 30, 1, 4); // 22:04 on the 29th in Buenos Aires, 02:04 on the 30th in Madrid

/** One sample of every kind and variant (mailTemplates.ts MailData). */
export const SAMPLES = [
  { kind: 'verify_signup', code: '048213', token: TOKEN },
  { kind: 'verify_signup', code: '048213', token: TOKEN, hint: 'discord' },
  { kind: 'signup_exists', name: 'Ana', variant: 'reset', methods: ['email', 'discord'], token: TOKEN },
  { kind: 'signup_exists', name: 'Ana', variant: 'held' },
  { kind: 'reset', name: 'Ana', variant: 'reset', token: TOKEN },
  { kind: 'reset', name: 'Ana', variant: 'create', methods: ['google', 'discord'], token: TOKEN },
  { kind: 'password_changed', name: 'Ana', at: AT },
  { kind: 'verify_email', name: 'Ana', code: '731904', token: TOKEN },
  { kind: 'email_changed', name: 'Ana', masked: 'an***@gmail.com', at: AT, token: TOKEN, providers: ['discord', 'google'] },
  { kind: 'email_changed', name: 'Ana', masked: 'an***@gmail.com', at: AT, token: TOKEN, providers: [] },
  { kind: 'email_in_use', name: 'Ana', other: 'Beto', variant: 'move', code: '555123', methods: ['username'] },
  { kind: 'email_in_use', name: 'Ana', other: 'Beto', variant: 'only' },
  { kind: 'email_in_use', name: 'Ana', other: 'Beto', variant: 'held' },
  { kind: 'provider_linked', name: 'Ana', provider: 'google', at: AT, variant: 'linked' },
  { kind: 'provider_linked', name: 'Ana', provider: 'discord', at: AT, variant: 'unlinked' },
  { kind: 'deletion_scheduled', name: 'Ana', at: AT, token: TOKEN },
  { kind: 'legacy_reminder', name: 'Ana', at: AT, token: TOKEN },
  { kind: 'reauth_code', name: 'Ana', code: '902211' },
  { kind: 'email_moved', name: 'Ana', other: 'Beto', at: AT, methods: ['username', 'discord'] },
];

export const label = (d) => d.kind + (d.variant ? '/' + d.variant : '') + (d.hint ? '/hint' : '') + (d.providers && !d.providers.length ? '/no-providers' : '');

/** Every sample in es and in en, rendered by `T` (the mailTemplates module) for `origin`. */
export function renderAll(T, origin = ORIGIN, tz) {
  const out = [];
  for (const d of SAMPLES) for (const lang of ['es', 'en']) out.push({ d, lang, r: T.renderMail(d, { origin, lang, tz }) });
  return out;
}

/** Every http(s) URL in a body, and every href of an html part. */
export const urlsIn = (s) => [...s.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
export const hrefsIn = (s) => [...s.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

const LINK_KINDS = new Set(['verify', 'email', 'reset', 'undo', 'keep', 'unsub']);

/** Every URL of every rendered mail is `${origin}/account#<kind>=<token>` (or #forgot), with no query. */
export function assertOwnUrls(rendered, origin) {
  for (const { d, lang, r } of rendered) {
    const at = `${label(d)} ${lang}`;
    const urls = [...urlsIn(r.text), ...urlsIn(r.html), ...hrefsIn(r.html)];
    if ('token' in d || d.kind === 'password_changed') assert.ok(urls.length > 0, at);
    for (const u of urls) {
      assert.ok(u.startsWith(origin + '/account#'), `${at}: ${u}`);
      const url = new URL(u);
      assert.equal(url.search, '', `${at}: no query (${u})`);
      const frag = url.hash.slice(1);
      if (frag === 'forgot') continue;
      const [kind, token] = frag.split('=');
      assert.ok(LINK_KINDS.has(kind), at);
      assert.equal(token, TOKEN, at);
    }
  }
}

/** Console lines while `fn` runs. */
export async function captureConsole(fn) {
  const lines = [];
  const keep = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(keep)) console[k] = (...a) => lines.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, keep);
  }
  return lines;
}

// Every mail the Worker can send (src/mailTemplates.ts; docs/online/MAIL.md): every kind and
// variant in es and in en, the codes in the subject, the security notices in both languages with
// the account's first, neutral Spanish and the client's copy rules, no brand of the commercial
// game, html without images, tracking or remote content, every URL LINK_ORIGIN's with its token in
// the fragment, values cleaned and escaped, dates in the account's time zone or the date alone.
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AT, ORIGIN, SAMPLES, TOKEN, assertOwnUrls, foreignDomainsIn, label, renderAll } from './mailSamples.mjs';

const T = await import('../src/mailTemplates.ts');
const C = await import('../src/mailCaps.ts');

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(SERVER, '..');
const all = (origin, tz) => renderAll(T, origin, tz);

test('every kind of mailCaps.MAIL_KINDS has a sample, and renders in es and in en', () => {
  assert.deepEqual([...new Set(SAMPLES.map((d) => d.kind))].sort(), [...C.MAIL_KINDS].sort());
  for (const { d, lang, r } of all()) {
    const at = `${label(d)} ${lang}`;
    assert.equal(r.kind, d.kind, at);
    assert.equal(r.lang, lang, at);
    assert.ok(r.subject.length > 0 && !/[\r\n]/.test(r.subject), at);
    assert.ok(r.text.length > 0 && r.html.length > 0, at);
    assert.match(r.html, new RegExp(`^<!doctype html>\\n<html lang="${lang}">`), at);
    if ('code' in d) {
      assert.equal(r.code, d.code, at);
      assert.ok(r.text.includes(d.code), at);
    }
    if ('token' in d) assert.ok(r.link && r.link.endsWith('=' + d.token), at);
    else assert.equal(r.link, undefined, at);
    // about 3 KB a message, far below the 5 MiB limit
    assert.ok(r.html.length + r.text.length < 8_000, `${at}: ${r.html.length + r.text.length} bytes`);
  }
});

test('the codes lead the subject of the code mails, so a phone shows them on its lock screen', () => {
  for (const { d, r } of all()) if (d.kind === 'verify_signup' || d.kind === 'verify_email' || d.kind === 'reauth_code') assert.ok(r.subject.startsWith(d.code + ' '), label(d));
});

test("the security notices carry both languages, the account's first; the other mail only one", () => {
  const footer = { es: 'Este correo es automático: no lo respondas.', en: "This is an automatic email: please don't reply." };
  const heading = { es: '— Español —', en: '— English —' };
  const greeting = { es: /^Hola[,:]/m, en: /^Hi[ ,]/m };
  for (const { d, lang, r } of all()) {
    const other = lang === 'es' ? 'en' : 'es';
    const at = `${label(d)} ${lang}`;
    if (C.isNotice(d.kind)) {
      assert.ok(r.text.indexOf(footer[lang]) < r.text.indexOf(footer[other]) && r.text.includes(footer[other]), at);
      assert.ok(r.text.includes(heading[other]) && !r.text.includes(heading[lang]), at);
      const [before, after] = r.text.split(heading[other]);
      assert.match(before, greeting[lang], at);
      assert.match(after, greeting[other], at);
      assert.equal(r.subject.split(' · ').length, 2, at);
      assert.ok(r.html.includes(`<div lang="${other}">`), at);
    } else {
      assert.ok(r.text.includes(footer[lang]) && !r.text.includes(footer[other]), at);
      assert.doesNotMatch(r.text, greeting[other], at);
      assert.ok(!r.subject.includes(' · '), at);
    }
  }
});

// The client's copy rules, mirrored: tests/i18n-copy.test.mjs RULES and tests/i18n-es.test.mjs's
// voseo check. The test after the next fails when either source changes without this copy.
const COPY_RULES = {
  shop: { en: /\b(?:buy|buying|bought|purchase\w*|shop\w*|store|stores|price\w*|coins?|offers?|sale|sell\w*)\b/i, es: /\b(?:compr\w*|tienda\w*|precio\w*|monedas?|ofertas?|rebaja\w*|vend\w*|dorad[oa]s?)\b/i },
  emoji: { en: /\p{Extended_Pictographic}/u, es: /\p{Extended_Pictographic}/u },
  modeNames: { en: /\b(?:one-on-one|pairs|trios)\b|\{count\} cars?\b|\b\d+ cars\b/i, es: /\b(?:mano a mano|parejas|tr[ií]os)\b|\{count\} autos?\b|\b\d+ autos\b/i },
  rawCodes: { en: /\(\d{3,4}\b|\b1006\b/, es: /\(\d{3,4}\b|\b1006\b/ },
  codeSlots: { en: /\{(?:status|detail|reason)\}/, es: /\{(?:status|detail|reason)\}/ },
};
const VOSEO_ALLOWED_SRC = "new Set(['está', 'estás', 'más', 'demás', 'también', 'qué', 'así', 'aquí', 'sí', 'después', 'según', 'aún', 'esté', 'guardé', 'atrás', 'país', 'inglés', 'podrá'])";
const VOSEO_ALLOWED = new Set(['está', 'estás', 'más', 'demás', 'también', 'qué', 'así', 'aquí', 'sí', 'después', 'según', 'aún', 'esté', 'guardé', 'atrás', 'país', 'inglés', 'podrá']);
const VOSEO_WORD = /(?<![\p{L}])(\p{L}+(?:á|é|í|ás|és|ís))(?![\p{L}])/gu;
const VOSEO_PRONOUN = /(?<![\p{L}])(vos|sos)(?![\p{L}])/giu;

function voseo(text) {
  const bad = [];
  for (const m of text.matchAll(VOSEO_WORD)) if (!VOSEO_ALLOWED.has(m[1].toLowerCase())) bad.push(m[1]);
  for (const m of text.matchAll(VOSEO_PRONOUN)) bad.push(m[1]);
  return bad;
}

test('the Spanish is neutral (tú, never voseo), and no mail breaks a copy rule of the client', () => {
  for (const { d, lang, r } of all()) {
    const at = `${label(d)} ${lang}`;
    const text = r.subject + '\n' + r.text;
    assert.deepEqual(voseo(text), [], at);
    for (const [rule, re] of Object.entries(COPY_RULES)) {
      assert.doesNotMatch(text, re.es, `${at}: ${rule} (es)`);
      assert.doesNotMatch(text, re.en, `${at}: ${rule} (en)`);
    }
  }
  assert.deepEqual(voseo('Podés elegir: creá tu cuenta, vos sos el dueño'), ['Podés', 'creá', 'vos', 'sos'], 'the check catches voseo');
});

test("the mirrored copy rules are still the client tests' own", () => {
  const copy = readFileSync(join(ROOT, 'tests', 'i18n-copy.test.mjs'), 'utf8');
  const es = readFileSync(join(ROOT, 'tests', 'i18n-es.test.mjs'), 'utf8');
  for (const [rule, langs] of Object.entries(COPY_RULES)) for (const [lang, re] of Object.entries(langs)) assert.ok(copy.includes('/' + re.source + '/'), `${rule}.${lang} changed in tests/i18n-copy.test.mjs`);
  assert.ok(es.includes(VOSEO_ALLOWED_SRC), 'the allow-list changed in tests/i18n-es.test.mjs');
  assert.ok(es.includes('/' + VOSEO_WORD.source + '/gu') && es.includes('/' + VOSEO_PRONOUN.source + '/giu'), 'the voseo patterns changed in tests/i18n-es.test.mjs');
});

test('no template names the commercial game or its studio', () => {
  // Kept out of the repository in plain text (TRADEMARKS.md, CONTRIBUTING.md): the letters, base64.
  const banned = ['cm9ja2V0bGVhZ3Vl', 'cHN5b25peA=='].map((b) => Buffer.from(b, 'base64').toString('utf8'));
  for (const { d, lang, r } of all()) {
    const letters = (r.subject + r.text + r.html).toLowerCase().replace(/[^a-z]/g, '');
    for (const w of banned) assert.ok(!letters.includes(w), `${label(d)} ${lang}`);
  }
  const src = readFileSync(join(SERVER, 'src', 'mailTemplates.ts'), 'utf8').toLowerCase().replace(/[^a-z]/g, '');
  for (const w of banned) assert.ok(!src.includes(w));
});

test('html: no image, tracking, remote font, style sheet, script or form; inline styles only', () => {
  for (const { d, lang, r } of all()) {
    const at = `${label(d)} ${lang}`;
    assert.doesNotMatch(r.html, /<(?:img|script|link|style|iframe|form|object|embed|svg|video|audio|base|meta http-equiv)\b/i, at);
    assert.doesNotMatch(r.html, /\b(?:src|srcset|background|action|formaction)\s*=|url\(|@import|@font-face/i, at);
  }
});

test('every URL of every template is the origin given + /account#<kind>=<token>, the token never in a query', () => {
  assertOwnUrls(all(), ORIGIN);
  assertOwnUrls(all('http://localhost:5494'), 'http://localhost:5494');
  const forgot = T.renderMail({ kind: 'password_changed', name: 'Ana', at: AT }, { origin: ORIGIN, lang: 'en' });
  assert.ok(forgot.text.includes('at https://turbo-gol.com/account#forgot and check'), "M4's {origin} is the link origin too");
  assert.ok(forgot.text.includes('\n— Turbogol · turbo-gol.com\n'), "the footer names the link origin's host");
  assert.equal(T.mailLink(ORIGIN, 'keep', TOKEN), 'https://turbo-gol.com/account#keep=' + TOKEN);
});

test('renderMail refuses an origin that is not one, a token that is not base64url and a code that is not 6 digits', () => {
  const d = { kind: 'reset', name: 'Ana', variant: 'reset', token: TOKEN };
  for (const origin of ['https://turbo-gol.com/x', 'javascript:alert(1)', 'turbo-gol.com', 'ftp://turbo-gol.com', 'https://turbo-gol.com#x']) assert.throws(() => T.renderMail(d, { origin, lang: 'es' }), /origin/, origin);
  for (const token of ['short', '"><img src=x>', TOKEN + '?a=b', 'https://evil.example/' + TOKEN, TOKEN + '#x']) assert.throws(() => T.renderMail({ ...d, token }, { origin: ORIGIN, lang: 'es' }), /token/, token);
  for (const code of ['12345', '1234567', 'abcdef', '12 345']) assert.throws(() => T.renderMail({ kind: 'reauth_code', name: 'Ana', code }, { origin: ORIGIN, lang: 'en' }), /code/, code);
  assert.throws(() => T.renderMail({ kind: 'reset', name: 'Ana', variant: 'create', methods: [], token: TOKEN }, { origin: ORIGIN, lang: 'en' }), /methods/);
  assert.throws(() => T.renderMail({ kind: 'password_changed', name: '  ', at: AT }, { origin: ORIGIN, lang: 'en' }), /name/);
});

test('values are cleaned of control characters and escaped in the html', () => {
  const name = '<b>"Ana"&\'x';
  const other = 'Beto\r\nBcc: evil@example.com';
  const r = T.renderMail({ kind: 'email_moved', name, other, at: AT, methods: ['discord'] }, { origin: ORIGIN, lang: 'es' });
  assert.ok(!/[\r\n]/.test(r.subject));
  assert.ok(r.subject.replaceAll('\u2060', '').includes('Beto Bcc: evil@example.com'), 'the line break is gone, the words stay as text');
  assert.ok(!r.html.includes('<b>') && r.html.includes('&lt;b&gt;&quot;Ana&quot;&amp;&#39;x'));
  assert.ok(r.text.includes(name), 'the text part carries the name as it is');
  const bidi = T.renderMail({ kind: 'reauth_code', name: 'Ana' + String.fromCodePoint(0x202e) + 'evil', code: '123456' }, { origin: ORIGIN, lang: 'en' });
  assert.ok(!bidi.text.includes(String.fromCodePoint(0x202e)) && bidi.text.includes('Hi Ana evil,'));
});

// Review of PR 2 (major): "tg-verify.com" is a valid username, and mail clients link bare domains.
// In M7 the attacker's name sat next to the code that moves the victim's address, as a link.
test('a name or the masked address that reads like a domain or a URL never becomes a link, and still reads the same', () => {
  const hostile = ['tg-verify.com', 'www.evil.gg', 'Ana.co', 'turbo-gol.com.evil.io', 'a.b.c.d.e.gg', 'http://evil.com/x', '//evil.com', 'evil\u3002com', 'evil\uFF0Ecom', 'pay@evil.io', 'evil.com\\x'];
  const joinedDot = '\u2060.\u2060';
  for (const value of hostile) {
    const rendered = [];
    for (const s of SAMPLES) {
      if (!('name' in s || 'other' in s || 'masked' in s)) continue;
      const d = { ...s, ...('name' in s ? { name: value } : {}), ...('other' in s ? { other: value } : {}), ...('masked' in s ? { masked: 'an***@' + value } : {}) };
      for (const lang of ['es', 'en']) rendered.push({ d, lang, r: T.renderMail(d, { origin: ORIGIN, lang }) });
    }
    assert.ok(rendered.length >= 30, value);
    assertOwnUrls(rendered, ORIGIN); // no domain but turbo-gol.com in any subject, text or html
    for (const { d, lang, r } of rendered) {
      const at = `${label(d)} ${lang} ${value}`;
      assert.ok(r.text.replaceAll('\u2060', '').includes(value), `${at}: the text shows the name as it is, plus invisible joiners`);
      assert.ok(r.subject.replaceAll('\u2060', '').length >= 10, at);
      const plainHtml = r.html.replaceAll('\u2060', '').replace(/<\/?span>/g, '');
      assert.ok(plainHtml.includes(value.replace(/&/g, '&amp;')), `${at}: the html shows it too`);
      if (value.includes('.')) {
        assert.ok(r.text.includes(joinedDot), at);
        assert.ok(r.html.includes('\u2060<span>.</span>\u2060'), `${at}: each dot of a value in its own span`);
      }
    }
  }
  // The attack of the review, word for word: the code mail of M7 and the subject of M12.
  const m7 = T.renderMail({ kind: 'email_in_use', name: 'Ana', other: 'tg-verify.com', variant: 'move', code: '555123', methods: ['username'] }, { origin: ORIGIN, lang: 'en' });
  assert.ok(!m7.text.includes('tg-verify.com') && m7.text.includes('tg-verify\u2060.\u2060com'));
  const m12 = T.renderMail({ kind: 'email_moved', name: 'Ana', other: 'tg-verify.com', at: AT, methods: ['username'] }, { origin: ORIGIN, lang: 'es' });
  assert.deepEqual(foreignDomainsIn(m12.subject, ORIGIN), []);
  assert.ok(m12.subject.replaceAll('\u2060', '').startsWith('Tu correo pasó a la cuenta tg-verify.com de Turbogol · '));
  // The copy of the templates never gets joiners, only the values do.
  for (const { r } of all()) assert.ok(!(r.subject + r.text).replace(/an\*\*\*\u2060@\u2060gmail\u2060\.\u2060com/g, '').includes('\u2060'));
});

test('M7 "move": the code goes into the game, on that account, and is never shared', () => {
  const d = { kind: 'email_in_use', name: 'Ana', other: 'Beto', variant: 'move', code: '555123', methods: ['username'] };
  const es = T.renderMail(d, { origin: ORIGIN, lang: 'es' }).text;
  const en = T.renderMail(d, { origin: ORIGIN, lang: 'en' }).text;
  assert.ok(es.includes('quieres usar este correo en Beto, escribe este código en el juego, en esa cuenta:\n\n555123\n'));
  assert.ok(es.includes('El código caduca en 15 minutos. No compartas el código con nadie: Turbogol nunca te lo va a pedir.'));
  assert.ok(en.includes('you want this email on Beto, type this code in the game, on that account:\n\n555123\n'));
  assert.ok(en.includes('The code expires in 15 minutes. Never share the code: Turbogol will never ask you for it.'));
  assert.doesNotMatch(en, /type this code there/);
});

test('{methods} and {providers}: in the mail\'s language, joined with "o" / "or"; a notice without providers drops the clause', () => {
  const create = T.renderMail({ kind: 'reset', name: 'Ana', variant: 'create', methods: ['email', 'google', 'discord'], token: TOKEN }, { origin: ORIGIN, lang: 'es' });
  assert.ok(create.text.includes('Entras a tu cuenta con tu correo y tu contraseña, Google o Discord.'));
  const en = T.renderMail({ kind: 'signup_exists', name: 'Ana', variant: 'reset', methods: ['username', 'discord'], token: TOKEN }, { origin: ORIGIN, lang: 'en' });
  assert.ok(en.text.includes('You sign in with your username and password or Discord.'));
  const some = T.renderMail({ kind: 'email_changed', name: 'Ana', masked: 'an***@x.com', at: AT, token: TOKEN, providers: ['discord'] }, { origin: ORIGIN, lang: 'es' });
  assert.ok(some.text.includes('cualquier cuenta de Discord vinculada') && some.text.includes('any Discord account linked'));
  const none = T.renderMail({ kind: 'email_changed', name: 'Ana', masked: 'an***@x.com', at: AT, token: TOKEN, providers: [] }, { origin: ORIGIN, lang: 'es' });
  assert.ok(!/Google|Discord/.test(none.text), 'a fork without providers names none');
});

test('dates: the time and the zone with a time zone, the date alone (UTC) without one', () => {
  assert.equal(T.formatMailDate(AT, 'es', 'America/Argentina/Buenos_Aires'), '29 de octubre de 2026 a las 22:04 GMT-3');
  assert.equal(T.formatMailDate(AT, 'en', 'America/Argentina/Buenos_Aires'), 'October 29, 2026 at 10:04 PM GMT-3');
  assert.equal(T.formatMailDate(AT, 'es'), '30 de octubre de 2026');
  assert.equal(T.formatMailDate(AT, 'en', ''), 'October 30, 2026');
  assert.equal(T.formatMailDate(AT, 'en', 'Mars/Olympus_Mons'), 'October 30, 2026', 'an unknown zone counts as none');
  assert.equal(T.formatMailDate(AT, 'es', 'America/Argentina/Buenos_Aires', 'day'), '29 de octubre de 2026', 'a day is the date alone, in the zone');
  const withTz = T.renderMail({ kind: 'password_changed', name: 'Ana', at: AT }, { origin: ORIGIN, lang: 'es', tz: 'Europe/Madrid' });
  assert.ok(withTz.text.includes('cambió el 30 de octubre de 2026 a las 2:04 CET'));
  assert.ok(withTz.text.includes('changed on October 30, 2026 at 2:04 AM GMT+1'), 'the English half uses the same zone');
  const noTz = T.renderMail({ kind: 'password_changed', name: 'Ana', at: AT }, { origin: ORIGIN, lang: 'es' });
  assert.ok(noTz.text.includes('cambió el 30 de octubre de 2026 y cerramos'));
  assert.doesNotMatch(noTz.text, /\d:\d\d/, 'no time without a zone');
  const del = T.renderMail({ kind: 'deletion_scheduled', name: 'Ana', at: AT, token: TOKEN }, { origin: ORIGIN, lang: 'en', tz: 'America/Mexico_City' });
  assert.ok(del.subject.startsWith('Your Turbogol account will be deleted on October 29, 2026 · '));
});

test("mailLang: the account's language, else the request's (es-AR is es), else English", () => {
  assert.equal(T.mailLang('es', 'en'), 'es');
  assert.equal(T.mailLang('', 'es-AR'), 'es');
  assert.equal(T.mailLang(null, 'EN-gb'), 'en');
  assert.equal(T.mailLang('', ''), 'en');
  assert.equal(T.mailLang('fr', 'es'), 'es');
  assert.equal(T.mailLang(undefined, 'pt-BR'), 'en');
});

// Translations (src/i18n.ts, src/locales/*.ts): language detection, plurals, placeholders and the
// rules every locale file must follow. Run: node --test tests/i18n.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('.') || /\.[cm]?ts$/.test(specifier)) throw err;
      return nextResolve(specifier.replace(/\.js$/, '') + '.ts', context);
    }
  },
});

const I = await import('../src/i18n.ts');
const en = (await import('../src/locales/en.ts')).default;
const LOCALES_DIR = new URL('../src/locales/', import.meta.url);

test('pickLanguage: saved choice, then the system list (exact tag, then base), then English', () => {
  assert.equal(I.pickLanguage('es', ['en-US']), 'es', 'a saved choice wins');
  assert.equal(I.pickLanguage('xx', ['es-AR']), 'es', 'an unknown saved choice is ignored');
  assert.equal(I.pickLanguage(null, ['es-AR']), 'es');
  assert.equal(I.pickLanguage(null, ['fr-FR', 'es']), 'es', 'the first shipped language in the list');
  assert.equal(I.pickLanguage(null, ['pt-BR']), 'en');
  assert.equal(I.pickLanguage(null, []), 'en');
  assert.equal(I.pickLanguage('ES', ['EN-us']), 'es', 'case-insensitive');
  assert.equal(I.pickLanguage(null, ['ES-ar']), 'es');
});

test('outside a browser the language is English (node shares the OS locale through navigator)', () => {
  assert.equal(I.language(), 'en');
  assert.equal(I.systemLanguage(), 'en');
  assert.equal(I.t('lang.title'), en['lang.title']);
});

test('plurals pick the form with Intl.PluralRules and fall back to other', () => {
  const enMsg = { one: '{count} lobby', other: '{count} lobbies' };
  const esMsg = { one: '{count} sala', other: '{count} salas' };
  assert.equal(I.formatMessage(enMsg, { count: 1 }, 'en'), '1 lobby');
  assert.equal(I.formatMessage(enMsg, { count: 2 }, 'en'), '2 lobbies');
  assert.equal(I.formatMessage(enMsg, { count: 0 }, 'en'), '0 lobbies');
  assert.equal(I.formatMessage(esMsg, { count: 1 }, 'es'), '1 sala');
  assert.equal(I.formatMessage(esMsg, { count: 5 }, 'es'), '5 salas');
  assert.equal(I.formatMessage({ other: '{count} x' }, { count: 1 }, 'en'), '1 x', 'missing form -> other');
});

test('placeholders: filled with String(value), an unknown one stays visible', () => {
  assert.equal(I.formatMessage('Hi {name}, {n} left', { name: 'Ana', n: 3 }, 'en'), 'Hi Ana, 3 left');
  assert.equal(I.formatMessage('Hi {name}', {}, 'en'), 'Hi {name}');
  assert.equal(I.formatMessage('Hi {name}', undefined, 'en'), 'Hi {name}');
});

test('a partial translation falls back to English per key', () => {
  assert.equal(I.textIn({}, 'fr', 'lang.title'), en['lang.title']);
  assert.equal(I.textIn({ 'lang.title': 'Langue' }, 'fr', 'lang.title'), 'Langue');
  assert.equal(I.textIn({}, 'fr', 'lang.auto', { language: 'English' }), 'Automatic (English)');
});

const placeholders = (v) => new Set([...(typeof v === 'string' ? [v] : Object.values(v)).join(' ').matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

test('every locale: placeholders exist in English, plural forms are valid for the language', () => {
  for (const [code, { messages }] of Object.entries(I.LOCALES)) {
    const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
    for (const [key, value] of Object.entries(messages)) {
      assert.ok(key in en, `${code}: unknown key ${key}`);
      const known = placeholders(en[key]);
      for (const p of placeholders(value)) assert.ok(known.has(p), `${code} ${key}: {${p}} is not in the English text`);
      if (typeof value !== 'string') {
        assert.ok('other' in value, `${code} ${key}: plural without 'other'`);
        for (const form of Object.keys(value)) assert.ok(categories.includes(form), `${code} ${key}: '${form}' is not a plural form of ${code}`);
      }
    }
  }
});

test('locale files only import types (a runtime import would deadlock startup)', () => {
  for (const file of readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(new URL(file, LOCALES_DIR), 'utf8');
    assert.doesNotMatch(src, /^\s*import\s+(?!type\b)/m, `${file} has a runtime import`);
  }
});

test('duration rounds up to seconds, minutes or hours in the current language', () => {
  const unit = (n, u) => new Intl.NumberFormat('en', { style: 'unit', unit: u, unitDisplay: 'short' }).format(n);
  assert.equal(I.duration(0), unit(0, 'second'));
  assert.equal(I.duration(44_100), unit(45, 'second'));
  assert.equal(I.duration(60_000), unit(1, 'minute'));
  assert.equal(I.duration(299_000), unit(5, 'minute'));
  assert.equal(I.duration(24 * 3_600_000), unit(24, 'hour'));
});

test('serverText: the server message when the client has no text for the code', () => {
  assert.equal(I.serverText('lobby', 'no_such_code', 'Mensaje del servidor'), 'Mensaje del servidor');
});

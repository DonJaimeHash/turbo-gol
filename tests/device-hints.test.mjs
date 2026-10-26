// The hint bar speaks the last input's language only (src/ui/shell/hints.ts, plan §1.6): which
// verbs and which drawn keys each input gets, and that none of them names another device's keys.
// The verbs are real texts in English and Spanish.
//   node --test tests/device-hints.test.mjs
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

const H = await import('../src/ui/shell/hints.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

const INPUTS = ['pad', 'remote', 'keyboard', 'mouse', 'touch'];
const flat = (items) => items.map((i) => `${i.glyphs.join('+')} ${i.verb}`);

test('a controller: A select, B back, LB RB sections, Start settings (+ Y cancel search)', () => {
  assert.deepEqual(flat(H.hintItems('pad', { searching: false })), ['pad-a nav.select', 'pad-b nav.back', 'pad-lb+pad-rb nav.sections', 'pad-start nav.settings']);
  assert.equal(flat(H.hintItems('pad', { searching: true })).at(-1), 'pad-y nav.cancelSearch');
});

test('a keyboard: ENTER select, ESC back, Q E sections (+ X cancel search)', () => {
  assert.deepEqual(flat(H.hintItems('keyboard', { searching: false })), ['key-enter nav.select', 'key-esc nav.back', 'key-q+key-e nav.sections']);
  assert.equal(flat(H.hintItems('keyboard', { searching: true })).at(-1), 'key-x nav.cancelSearch');
});

test('a TV remote: OK select, the back button, the up arrow to the sections (a search is cancelled on its pill)', () => {
  for (const searching of [false, true]) assert.deepEqual(flat(H.hintItems('remote', { searching })), ['remote-ok nav.select', 'remote-back nav.backRemote', 'remote-up nav.sections']);
});

test('a mouse and a finger: no hints', () => {
  for (const input of ['mouse', 'touch']) for (const searching of [false, true]) assert.deepEqual(H.hintItems(input, { searching }), []);
});

test("no input shows another device's keys", () => {
  for (const input of INPUTS) {
    for (const searching of [false, true]) {
      for (const it of H.hintItems(input, { searching })) for (const g of it.glyphs) assert.equal(H.glyphDevice(g), input, `${input}: ${g}`);
    }
  }
});

test('every verb is a text in English and Spanish, and none names a key or a click', () => {
  for (const input of INPUTS) {
    for (const it of H.hintItems(input, { searching: true })) {
      for (const msgs of [en, es]) {
        const text = msgs[it.verb];
        assert.equal(typeof text, 'string', it.verb);
        assert.doesNotMatch(text, /\b(?:Esc|Enter|Intro|LB|RB|[ABXY]|Q|E|OK|click|clic)\b/, `${it.verb}: ${text}`);
      }
    }
  }
});

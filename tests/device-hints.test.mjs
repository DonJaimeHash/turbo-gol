// The hint bar speaks the last input's language only (src/ui/shell/hints.ts, plan §1.6): which
// verbs and which drawn keys each input gets, and that none of them names another device's keys.
// The verbs are real texts in English and Spanish.
//   node --test tests/device-hints.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';

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

test("a crowded hint bar (a TV with its pills) lets hints go: the controller's Settings first (the gear says it), cancel last (the pill's ✕)", () => {
  // fit.ts data-fit-give levels (the pills' words are 2, pills.ts).
  const gives = (input, ctx) => H.hintItems(input, ctx).filter((i) => i.give !== undefined).map((i) => i.give + ' ' + i.glyphs.join('+') + ' ' + i.verb);
  assert.deepEqual(gives('pad', { searching: false }), ['1 pad-start nav.settings']);
  assert.deepEqual(gives('pad', { searching: true }), ['1 pad-start nav.settings', '3 pad-y nav.cancelSearch']);
  assert.deepEqual(gives('keyboard', { searching: true }), ['3 key-x nav.cancelSearch']);
  for (const stacked of [false, true]) assert.deepEqual(gives('remote', { searching: true, stacked }), [], 'a remote keeps every hint (it cancels on the pill)');
  for (const input of ['pad', 'keyboard', 'remote']) for (const it of H.hintItems(input, { searching: false })) assert.ok(it.give !== 2, "level 2 is the pills' words");
});

test('a keyboard: ENTER select, ESC back, Q E sections (+ X cancel search)', () => {
  assert.deepEqual(flat(H.hintItems('keyboard', { searching: false })), ['key-enter nav.select', 'key-esc nav.back', 'key-q+key-e nav.sections']);
  assert.equal(flat(H.hintItems('keyboard', { searching: true })).at(-1), 'key-x nav.cancelSearch');
});

test('a TV remote: OK select, the back button, the up arrow to the sections (a search is cancelled on its pill)', () => {
  for (const searching of [false, true]) assert.deepEqual(flat(H.hintItems('remote', { searching })), ['remote-ok nav.select', 'remote-back nav.backRemote', 'remote-up nav.sections']);
});

test('a keyboard on a screen with tabs of its own: Q E step those (Leaderboard, Profile)', () => {
  assert.deepEqual(flat(H.hintItems('keyboard', { searching: false, ownTabs: true })), ['key-enter nav.select', 'key-esc nav.back', 'key-q+key-e nav.tabs']);
  assert.equal(flat(H.hintItems('keyboard', { searching: false, stacked: true })).at(-1), 'key-q+key-e nav.sections', 'Q / E still step the sections on a stacked screen');
  assert.equal(flat(H.hintItems('pad', { searching: false, ownTabs: true })).at(2), 'pad-lb+pad-rb nav.sections', "a controller's LB / RB stay the sections' (LT / RT step the tabs)");
});

test('a TV remote on a stacked screen: no "▲ Sections" (▲ lands on ‹ there, the section bar steps aside)', () => {
  assert.deepEqual(flat(H.hintItems('remote', { searching: false, stacked: true })), ['remote-ok nav.select', 'remote-back nav.backRemote']);
  assert.equal(flat(H.hintItems('remote', { searching: false, ownTabs: true })).at(-1), 'remote-up nav.sections');
});

test('a mouse and a finger: no hints', () => {
  for (const input of ['mouse', 'touch']) for (const searching of [false, true]) assert.deepEqual(H.hintItems(input, { searching }), []);
});

test("no input shows another device's keys", () => {
  for (const input of INPUTS) {
    for (const searching of [false, true]) {
      for (const stacked of [false, true]) {
        for (const ownTabs of [false, true]) for (const it of H.hintItems(input, { searching, stacked, ownTabs })) for (const g of it.glyphs) assert.equal(H.glyphDevice(g), input, `${input}: ${g}`);
      }
    }
  }
});

test('every verb is a text in English and Spanish, and none names a key or a click', () => {
  for (const input of INPUTS) {
    for (const it of [...H.hintItems(input, { searching: true }), ...H.hintItems(input, { searching: true, ownTabs: true })]) {
      for (const msgs of [en, es]) {
        const text = msgs[it.verb];
        assert.equal(typeof text, 'string', it.verb);
        assert.doesNotMatch(text, /\b(?:Esc|Enter|Intro|LB|RB|[ABXY]|Q|E|OK|click|clic)\b/, `${it.verb}: ${text}`);
      }
    }
  }
});

test('fit.ts giveLevels: the levels the parts give way at, lowest first, once each (none and junk left out)', async () => {
  const { giveLevels } = await import('../src/ui/fit.ts');
  assert.deepEqual(giveLevels([3, 1, 2, 2, 1]), [1, 2, 3]);
  assert.deepEqual(giveLevels([0, Number.NaN, -1, 1.5]), []);
  assert.deepEqual(giveLevels([]), []);
});

test("the shell declares what gives way in a crowded bar: the strip's sides (in its section bar), the pills' words, the hints' levels", async () => {
  const src = async (f) => readFile(new URL('../src/ui/' + f, import.meta.url), 'utf8');
  const top = await src('shell/topbar.ts');
  assert.match(top, /'span\.mn-sec-side',\s*\{[^}]*'data-fit-give': '1'/);
  assert.match(top, /'data-fit': '14', 'data-fit-scope': '\.mn-secbar'/);
  const pills = await src('shell/pills.ts');
  assert.match(pills, /const WORDS = \{ 'data-fit-give': '2' \}/);
  assert.ok((pills.match(/, WORDS[,)]/g) ?? []).length >= 8, 'every word of the region, search and update pills');
  assert.doesNotMatch(pills, /icon\([^)]*\), WORDS|mn-spinner', WORDS|mn-dot\.on', WORDS/, 'icons, the spinner and the dot stay');
  assert.match(await src('shell/hintbar.ts'), /'data-fit-give': it\.give !== undefined/);
});

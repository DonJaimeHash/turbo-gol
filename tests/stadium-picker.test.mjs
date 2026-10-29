// The stadium sheet (src/ui/components/stadium.ts, plan PR 16): MODOS › CONTRA LA IA's Stadium row
// opens it (it opened GARAJE's "coming soon", and nothing called setTheme), it lists every theme
// once, the current one marked, and a pick switches the theme unless it is the current one.
//   node --test tests/stadium-picker.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const S = await import('../src/ui/components/stadium.ts');
const { THEME_IDS, DEFAULT_THEME } = await import('../src/render/theme.ts');
const { default: en } = await import('../src/locales/en.ts');
const { default: es } = await import('../src/locales/es.ts');

test('the options: every theme once, in order, the current one alone marked', () => {
  for (const current of THEME_IDS) {
    const opts = S.stadiumOptions(current);
    assert.deepEqual(opts.map((o) => o.id), [...THEME_IDS]);
    assert.deepEqual(opts.filter((o) => o.on).map((o) => o.id), [current]);
  }
  assert.ok(THEME_IDS.length >= 2, 'a choice to make');
});

test('a pick: another theme switches once (the setter saves it), the current one does nothing', () => {
  const calls = [];
  const host = { theme: DEFAULT_THEME, setTheme: (id) => calls.push(id) };
  assert.equal(S.chooseStadium(host, DEFAULT_THEME), false);
  assert.deepEqual(calls, [], 'no loading screen for the theme already on');
  const other = THEME_IDS.find((id) => id !== DEFAULT_THEME);
  assert.equal(S.chooseStadium(host, other), true);
  assert.deepEqual(calls, [other]);
});

test('every theme has its name, and the sheet its note, in English and Spanish', () => {
  for (const [lang, dict] of [['en', en], ['es', es]]) {
    const names = THEME_IDS.map((id) => dict[`theme.${id}`]);
    for (const [i, n] of names.entries()) assert.ok(typeof n === 'string' && n.length > 0, `${lang}: theme.${THEME_IDS[i]}`);
    assert.equal(new Set(names).size, names.length, `${lang}: the names differ`);
    for (const k of ['friendly.theme', 'friendly.themeNote']) assert.ok(typeof dict[k] === 'string' && dict[k].length > 0, `${lang}: ${k}`);
  }
});

test("MODOS' Stadium row opens the stadium sheet, not GARAJE", () => {
  const src = readFileSync(new URL('../src/ui/screens/modes.ts', import.meta.url), 'utf8');
  const row = src.split('\n').find((l) => l.includes("picker('ai-stadium'"));
  assert.ok(row !== undefined, 'the row');
  assert.match(row, /openStadiumPicker\(menu\b/);
  assert.doesNotMatch(row, /open\('garage'\)/);
});

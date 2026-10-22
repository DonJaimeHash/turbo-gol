// Experimental rules as every menu writes them (src/render/rulesText.ts, shared by the Settings >
// Experimental editor, the training screen, the TrainingHud and the custom lobby screens): the
// lobby's rules line, the Spanish labels of every key, and the lobby rules cycler (custom.ts
// rulesChoices). Pure (node runs the English texts; the Spanish ones are read from
// src/locales/es.ts). The editor's value formats are in hud-menu.test.mjs.
// Run: node --test tests/rules-text.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
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

const T = await import('../src/render/rulesText.ts');
const R = await import('../src/game/physicsRules.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

test('lobbyRulesLine: the name, then every change in a match in table order (free-play keys left out), the same value texts as the editor', () => {
  const field = (k) => R.PHYSICS_FIELDS.find((f) => f.key === k);
  assert.equal(T.lobbyRulesLine(R.snapshotOf('Low gravity', { gravity: 50, ballDrag: 50 })), 'Low gravity · Gravity 50% · Air drag (ball) 50%');
  assert.equal(T.lobbyRulesLine({ v: 1, name: 'Plain', values: {} }), 'Plain', 'nothing changed: the name alone');
  assert.equal(T.lobbyRulesLine({ v: 1, name: 'Slow', values: { gameSpeed: 50 } }), 'Slow', 'game speed is free play only');
  const arcade = R.BUILT_IN_PRESETS.find((p) => p.id === 'arcade');
  const line = T.lobbyRulesLine(R.snapshotOf('Arcade', arcade.values));
  assert.equal(line, 'Arcade · Car top speed 94 km/h · Boost power 130% · Boost use Endless · Boost at kickoff 100 · Unlimited flips ON · Bump strength 150%');
  assert.ok(!line.includes('more'), 'a lobby line lists every change');
  // One module: the lobby line uses exactly the editor's value texts.
  for (const [k, v] of Object.entries(arcade.values)) assert.ok(line.includes(T.formatRuleValue(field(k), v)), k);
});

test('every rules key has its label in both languages (the lobby line names them)', () => {
  for (const k of R.PHYSICS_KEYS) {
    assert.equal(typeof en[`rules.${k}`], 'string', k);
    assert.equal(typeof es[`rules.${k}`], 'string', k);
  }
});

test("the lobby rules cycler (custom.ts rulesChoices): Standard first, the lobby's rules when they are none of the presets, and after EDIT PRESETS the picked preset with its new values instead of a stale copy", async () => {
  const { rulesChoices } = await import('../src/ui/screens/custom.ts');
  const builtIns = R.BUILT_IN_PRESETS.map((p) => ({ id: p.id, builtIn: true, name: '', values: p.values, synced: true }));
  const moon = { id: 'aaaaaaaaaaaa', builtIn: false, name: 'Moon ball', values: { gravity: 40 }, synced: true };
  assert.equal(rulesChoices(null, null), null, 'not unlocked, standard lobby: no rules row');
  assert.deepEqual(rulesChoices(null, R.snapshotOf('Moon ball', { gravity: 40 })).map((c) => c.id), ['standard', 'lobby'], 'a host who took over: keep or clear');
  const before = R.snapshotOf('Moon ball', { gravity: 40 });
  assert.deepEqual(rulesChoices([...builtIns, moon], before).map((c) => c.id), [...builtIns.map((p) => p.id), moon.id], 'the lobby rules are the preset: no extra option');
  // The host edits "Moon ball" in Settings > Experimental and comes back.
  const edited = { ...moon, values: { gravity: 30 } };
  const stale = rulesChoices([...builtIns, edited], before);
  assert.equal(stale.filter((c) => c.label === 'Moon ball').length, 2, 'without the kept pick: the old copy is listed as well');
  const back = rulesChoices([...builtIns, edited], before, moon.id);
  assert.equal(back.filter((c) => c.label === 'Moon ball').length, 1, 'with it: only the preset, with its new values');
  assert.deepEqual(back.find((c) => c.id === moon.id).physics.values, { gravity: 30 });
  // The picked preset was deleted meanwhile: the draft's rules stay as the lobby option.
  assert.deepEqual(rulesChoices(builtIns, before, moon.id).at(-1), { id: 'lobby', label: 'Moon ball', physics: before });
});

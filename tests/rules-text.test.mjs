// Experimental rules as the menus write them (src/ui/rulesText.ts): one value per display kind
// (percent, km/h like the HUD, toggles, demolitions, seconds, the kickoff boost), the changes of a
// set of values in table order, a lobby's rules line, and the Spanish labels of every key. Pure
// (node runs the English texts; the Spanish ones are read from src/locales/es.ts).
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

const T = await import('../src/ui/rulesText.ts');
const R = await import('../src/game/physicsRules.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

test('formatRuleValue: % of standard, speeds in km/h (the HUD unit), toggles, demolitions, seconds, the kickoff boost', () => {
  assert.equal(T.formatRuleValue('gravity', 50), '50%');
  assert.equal(T.formatRuleValue('ballMaxSpeed', 100), '216 km/h', 'stock 6000 uu/s');
  assert.equal(T.formatRuleValue('ballMaxSpeed', 130), '281 km/h');
  assert.equal(T.formatRuleValue('carMaxSpeed', 2600), '94 km/h');
  assert.equal(T.formatRuleValue('carMaxSpeed', 2000), '72 km/h');
  assert.equal(T.formatRuleValue('unlimitedFlips', 1), en['settings.on']);
  assert.equal(T.formatRuleValue('unlimitedFlips', 0), en['settings.off']);
  assert.deepEqual([0, 1, 2].map((v) => T.formatRuleValue('demoMode', v)), [en['rules.demoNormal'], en['rules.demoContact'], en['rules.demoOff']]);
  assert.equal(T.formatRuleValue('respawnDelay', 2), '2 s');
  assert.equal(T.formatRuleValue('spawnBoost', 100), '100');
});

test('rulesChanges / rulesSummary: the non-default keys in table order, free-play keys left out, a toggle that is on by its label', () => {
  assert.equal(T.rulesChanges({ ballDrag: 50, gravity: 50, gameSpeed: 50 }), 'Gravity 50% · Air drag (ball) 50%');
  assert.equal(T.rulesChanges({}), '');
  const arcade = R.BUILT_IN_PRESETS.find((p) => p.id === 'arcade');
  assert.equal(T.rulesChanges(arcade.values), 'Car top speed 94 km/h · Boost power 130% · Boost use 0% · Boost at kickoff 100 · Unlimited flips · Bump strength 150%');
  assert.equal(T.rulesChanges(arcade.values, 2), 'Car top speed 94 km/h · Boost power 130%', 'at most n');
  assert.equal(T.rulesSummary(R.snapshotOf('Low gravity', { gravity: 50, ballDrag: 50 })), 'Low gravity · Gravity 50% · Air drag (ball) 50%');
  assert.equal(T.rulesSummary({ v: 1, name: 'Plain', values: {} }), 'Plain');
});

test('every rules key has its label in both languages (the lobby line names them)', () => {
  for (const k of R.PHYSICS_KEYS) {
    assert.equal(typeof en[`rules.${k}`], 'string', k);
    assert.equal(typeof es[`rules.${k}`], 'string', k);
  }
});

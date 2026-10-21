// The experimental physics table and its parsers (src/game/physicsRules.ts): the grid invariants,
// strict and lenient parsing, the canonical form, the built-ins, the stored presets, the rules
// snapshot and the automatic names. Pure (node's type stripping imports it as it is).
// Run: node --test tests/physics-rules.test.mjs
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

const R = await import('../src/game/physicsRules.ts');
const { sanitizeLobbyName } = await import('../src/net/account.ts');

/**
 * The physical value each field sets, and the C++ hard limits of the design (section 6.1). Until
 * src/sim/mutators.ts lands (the physics core's pull request, which mirrors the limits), this is
 * the check that every UI range stays inside them; then this table should import from there.
 */
const PHYSICAL = {
  gravity: { of: (p) => (-650 * p) / 100, lo: -2000, hi: -100 },
  ballMaxSpeed: { of: (p) => (6000 * p) / 100, lo: 1000, hi: 8500 },
  ballHit: { of: (p) => p / 100, lo: 0, hi: 4 },
  ballWeight: { of: (p) => (30 * p) / 100, lo: 10, hi: 90 },
  ballBounce: { of: (p) => (0.6 * p) / 100, lo: 0, hi: 0.95 },
  ballDrag: { of: (p) => (0.03 * p) / 100, lo: 0, hi: 0.5 },
  carMaxSpeed: { of: (v) => v, lo: 1500, hi: 2700 },
  boostPower: { of: (p) => (991.667 * p) / 100, lo: 0, hi: 3000 }, // the ground one; air (1058.3) below 3200 too
  boostUse: { of: (p) => ((100 / 3) * p) / 100, lo: 0, hi: 100 },
  spawnBoost: { of: (v) => v, lo: 0, hi: 100 },
  jumpPower: { of: (p) => (292 * p) / 100, lo: 0, hi: 600 }, // jumpImmediateForce; jumpAccel (1458.3) below 3000 too
  unlimitedFlips: { of: (v) => v, lo: 0, hi: 1 },
  unlimitedDoubleJumps: { of: (v) => v, lo: 0, hi: 1 },
  bumpForce: { of: (p) => p / 100, lo: 0, hi: 5 },
  demoMode: { of: (v) => v, lo: 0, hi: 2 },
  respawnDelay: { of: (v) => v, lo: 0.5, hi: 10 },
};

test('the table: 17 known keys in editor groups, defaults on the grid, at most 18 steps, integers only', () => {
  assert.equal(R.PHYSICS_FIELDS.length, 17);
  assert.equal(new Set(R.PHYSICS_KEYS).size, 17);
  const groups = R.PHYSICS_FIELDS.map((f) => f.group);
  assert.deepEqual([...new Set(groups)], R.PHYSICS_GROUPS, 'grouped and in group order');
  assert.deepEqual(R.PHYSICS_GROUPS.map((g) => groups.filter((x) => x === g).length), [2, 5, 7, 3]);
  for (const f of R.PHYSICS_FIELDS) {
    const grid = R.fieldValues(f);
    assert.ok(grid.includes(f.default), `${f.key}: default on the grid`);
    assert.ok(grid.length - 1 <= R.MAX_RANGE_STEPS, `${f.key}: ${grid.length - 1} steps`);
    assert.ok(grid.every(Number.isInteger), `${f.key}: integers`);
    for (const v of grid) assert.equal(R.onGrid(f, v), true);
    assert.equal(R.snapToGrid(f, f.default), f.default);
  }
  assert.deepEqual(R.PHYSICS_FIELDS.filter((f) => f.scope === 'training').map((f) => f.key), ['gameSpeed'], 'only game speed is free-play only');
  assert.equal(R.physicsField('__proto__'), undefined);
  assert.equal(R.physicsField('toString'), undefined);
});

test('every grid value stays inside the hard limits; ball speed cannot tunnel, bounce stays below 1, gravity stays down', () => {
  for (const f of R.PHYSICS_FIELDS) {
    if (f.key === 'gameSpeed') {
      assert.ok(R.fieldValues(f).every((v) => v > 0 && v <= 100), 'game speed never above 100 %');
      continue;
    }
    const m = PHYSICAL[f.key];
    assert.ok(m, `${f.key} has a physical mapping`);
    for (const v of R.fieldValues(f)) {
      const x = m.of(v);
      assert.ok(x >= m.lo && x <= m.hi, `${f.key} ${v} -> ${x} outside ${m.lo}..${m.hi}`);
    }
  }
  const ball = R.physicsField('ballMaxSpeed');
  assert.ok((6000 * ball.max) / 100 / 120 <= 0.72 * 91.25, 'top ball speed per tick <= 0.72 ball radius');
  assert.ok((0.6 * R.physicsField('ballBounce').max) / 100 < 1);
  assert.ok((-650 * R.physicsField('gravity').min) / 100 < 0);
  assert.ok(R.physicsField('carMaxSpeed').max / 120 < 2 * 19.3, 'a car moves less than its hitbox height per tick');
});

test('strict: unknown, non-integer, off-grid, out-of-range, NaN, strings, arrays and free-play keys in a match are refused', () => {
  const ok = { gravity: 50, ballDrag: 50 };
  assert.deepEqual(R.parsePhysicsValues(ok, 'strict', 'match'), ok);
  for (const bad of [
    { nope: 1 },
    { gravity: 55 },
    { gravity: 50.5 },
    { gravity: 20 },
    { gravity: 210 },
    { gravity: NaN },
    { gravity: Infinity },
    { gravity: '50' },
    { gravity: null },
    { spawnBoost: 34 },
    { unlimitedFlips: 2 },
    { demoMode: 3 },
    { respawnDelay: 0 },
    { __proto__: { gravity: 50 }, constructor: 1 },
    [],
    null,
    'gravity',
    7,
  ]) {
    assert.equal(R.parsePhysicsValues(bad, 'strict', 'match'), null, JSON.stringify(bad));
  }
  assert.equal(R.parsePhysicsValues({ gameSpeed: 50 }, 'strict', 'match'), null, 'game speed is free play only');
  assert.deepEqual(R.parsePhysicsValues({ gameSpeed: 50 }, 'strict', 'training'), { gameSpeed: 50 });
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['k' + i, 1]));
  assert.equal(R.parsePhysicsValues(many, 'strict'), null);
});

test('lenient: drops unknown and bad keys, snaps to the grid, never fails; the canonical form omits defaults in table order', () => {
  assert.deepEqual(R.parsePhysicsValues({ ballDrag: 60, gravity: 47, nope: 1, ballHit: 'x', ballWeight: 9999, spawnBoost: 40 }, 'lenient'), { gravity: 50, ballWeight: 200, ballDrag: 50 }, 'spawnBoost 40 snaps to the default 33: omitted');
  assert.deepEqual(R.parsePhysicsValues({ gravity: -5, carMaxSpeed: 2324 }, 'lenient'), { gravity: 30 }, 'clamped; snapped to the default: omitted');
  assert.deepEqual(R.parsePhysicsValues({ gameSpeed: 50, gravity: 50 }, 'lenient', 'match'), { gravity: 50 });
  for (const junk of [null, [], 'x', 3, undefined]) assert.deepEqual(R.parsePhysicsValues(junk, 'lenient'), {});
  assert.deepEqual(Object.keys(R.canonicalValues({ ballDrag: 50, gravity: 50, ballHit: 100 })), ['gravity', 'ballDrag']);
  assert.equal(R.isStock({}), true);
  assert.equal(R.isStock({ gravity: 100, unlimitedFlips: 0 }), true);
  assert.equal(R.isStock({ gameSpeed: 50 }), false);
  assert.equal(R.isStock({ gameSpeed: 50 }, 'match'), true, 'a match ignores free-play keys');
  assert.equal(R.sameValues({ gravity: 50, ballHit: 100 }, { gravity: 50 }), true);
  assert.equal(R.sameValues({ gravity: 50 }, { gravity: 60 }), false);
  assert.equal(R.valueOf({}, 'spawnBoost'), 33);
  assert.equal(R.valueOf({ spawnBoost: 100 }, 'spawnBoost'), 100);
  assert.deepEqual(R.rulesOf({ gameSpeed: 50, gravity: 50 }), { v: R.PHYSICS_SCHEMA, values: { gravity: 50 } });
  assert.deepEqual(R.summarizeChanges({ ballDrag: 50, gravity: 50, bumpForce: 0 }, 2), [{ key: 'gravity', value: 50 }, { key: 'ballDrag', value: 50 }]);
});

test('snapping a choice takes the nearest option (a tie the lower one)', () => {
  const spawn = R.physicsField('spawnBoost');
  assert.equal(R.snapToGrid(spawn, 40), 33);
  assert.equal(R.snapToGrid(spawn, 42), 50);
  assert.equal(R.snapToGrid(spawn, 1000), 100);
  assert.equal(R.snapToGrid(R.physicsField('unlimitedFlips'), 0.5), 0);
  assert.equal(R.snapToGrid(R.physicsField('ballDrag'), 12.5), 25, 'a range rounds half up');
});

test('the built-ins: five, valid in a match, Standard is stock, stable ids that no stored preset can take', () => {
  assert.deepEqual(R.BUILT_IN_PRESETS.map((p) => p.id), ['standard', 'lowGravity', 'fastBall', 'bouncy', 'arcade']);
  for (const p of R.BUILT_IN_PRESETS) {
    assert.deepEqual(R.parsePhysicsValues(p.values, 'strict', 'match'), p.values, `${p.id} is strict-valid and canonical`);
    assert.equal(R.isBuiltInId(p.id), true);
    assert.equal(R.PRESET_ID_RE.test(p.id), false);
  }
  assert.equal(R.isStock(R.BUILT_IN_PRESETS[0].values), true);
  assert.equal(R.BUILT_IN_PRESETS.slice(1).every((p) => !R.isStock(p.values)), true);
  assert.equal(R.isBuiltInId('0123456789ab'), false);
});

test('stored presets: a 12-hex id, a sanitized name, lenient values; lists drop duplicates and stop at the cap', () => {
  const p = R.parseStoredPreset({ id: '0123456789ab', name: '  Low   gravity!! ', values: { gravity: 52, nope: 1 }, updatedAt: 7 });
  assert.deepEqual(p, { id: '0123456789ab', name: 'Low gravity!!', values: { gravity: 50 }, updatedAt: 7 });
  assert.equal(R.parseStoredPreset({ id: 'ABCDEF012345', name: 'abc' }), null, 'lowercase hex only');
  assert.equal(R.parseStoredPreset({ id: '0123456789ab', name: 'ab' }), null, 'too short a name');
  assert.equal(R.parseStoredPreset({ id: '0123456789ab', name: '(())' }), null, 'nothing left of it');
  assert.equal(R.parseStoredPreset({ id: 'standard', name: 'Standard' }), null, 'a built-in id');
  assert.equal(R.parseStoredPreset({ id: '0123456789ab', name: 'Fine', updatedAt: -1 }).updatedAt, 0);
  assert.deepEqual(R.parseStoredPreset({ id: '0123456789ab', name: 'Fine', values: 'x' }).values, {});
  const list = Array.from({ length: 14 }, (_, i) => ({ id: i.toString(16).padStart(12, '0'), name: 'Preset ' + i, values: {} }));
  assert.equal(R.parsePresetList(list).length, R.MAX_PRESETS);
  assert.equal(R.parsePresetList([list[0], list[0], list[1]]).length, 2);
  assert.deepEqual(R.parsePresetList('x'), []);
  const ids = new Set(Array.from({ length: 50 }, () => R.newPresetId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, R.PRESET_ID_RE);
  assert.equal(R.newPresetId((n) => new Uint8Array(n).fill(0xab)), 'abababababab');
});

test('rules snapshot: a copy with v, a valid name and strict match values; anything else is refused', () => {
  const s = R.snapshotOf('Low gravity', { gravity: 50, gameSpeed: 50 });
  assert.deepEqual(s, { v: 1, name: 'Low gravity', values: { gravity: 50 } }, 'free-play keys never reach a lobby');
  assert.deepEqual(R.parseRulesSnapshot(JSON.parse(JSON.stringify(s))), s);
  assert.equal(R.snapshotOf('x', {}), null);
  for (const bad of [
    { ...s, v: 2 },
    { ...s, name: 'Low  gravity' },
    { ...s, name: 'ab' },
    { ...s, values: { gameSpeed: 50 } },
    { ...s, values: { gravity: 55 } },
    { v: 1, name: 'Low gravity' },
    null,
  ]) {
    assert.equal(R.parseRulesSnapshot(bad), null, JSON.stringify(bad));
  }
});

test('automatic names: the first free "My rules N"; copies "{name} #N" from 2, a copy of a copy from its original, cut to fit', () => {
  const def = (n) => `My rules ${n}`;
  const copy = (name, n) => `${name} #${n}`;
  assert.equal(R.defaultPresetName([], def), 'My rules 1');
  assert.equal(R.defaultPresetName(['My rules 1', 'my RULES 2'], def), 'My rules 3', 'case-insensitive');
  assert.equal(R.copyPresetName('Low gravity', [], copy), 'Low gravity #2');
  assert.equal(R.copyPresetName('Low gravity', ['Low gravity #2'], copy), 'Low gravity #3');
  assert.equal(R.copyPresetName('Low gravity #2', ['Low gravity #2'], copy), 'Low gravity #3');
  const long = 'A'.repeat(24);
  const c = R.copyPresetName(long, [], copy);
  assert.equal(c, 'A'.repeat(21) + ' #2');
  assert.equal(sanitizeLobbyName(c), c);
  assert.equal(R.copyPresetName('Ends with space ' + 'x'.repeat(6), [], copy).length <= 24, true);
});

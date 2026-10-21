// The pitch's load-time bakes and per-theme turf data (node --test tests/turf.test.mjs):
// src/render/turf/bake.ts and turfTheme.ts are pure (typed arrays, no three.js), so they run here.
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

const bake = await import('../src/render/turf/bake.ts');
const { TURF_LOOKS, turfLook } = await import('../src/render/turf/turfTheme.ts');
const { THEME_IDS, themeWorld } = await import('../src/render/theme.ts');
const { TIERS } = await import('../src/render/quality.ts');
const { ARENA, BOOST_PADS_BIG, BOOST_PADS_SMALL, KICKOFF_SPAWNS } = await import('../src/sim/constants.ts');

const { BLADE_FIELD_SIZE, FIELD_MAP, POOL_MAP } = bake;
const FLAT_X = ARENA.extentX - ARENA.sideRampRadius;
const FLAT_Z = ARENA.extentY - ARENA.backRampRadius;

/** Texel (i, j) of a floor map nearest to world (x, z). */
function texelAt(rect, x, z) {
  const i = Math.min(rect.w - 1, Math.max(0, Math.floor(((x - rect.x0) / rect.sx) * rect.w)));
  const j = Math.min(rect.h - 1, Math.max(0, Math.floor(((z - rect.z0) / rect.sz) * rect.h)));
  return (j * rect.w + i) * 4;
}

test('the blade field is deterministic, cached and tiles seamlessly', () => {
  const a = bake.bladeField();
  assert.equal(a.length, BLADE_FIELD_SIZE * BLADE_FIELD_SIZE * 4);
  assert.equal(bake.bladeField(), a, 'baked once per page load');
  const b = bake.bakeBladeField(64, 40, 7);
  const c = bake.bakeBladeField(64, 40, 7);
  assert.deepEqual(b, c, 'same seed, same field');
  // Tiling: the height step across the wrap seam is no larger than across any interior column.
  const N = BLADE_FIELD_SIZE;
  const colStep = (x0, x1) => {
    let s = 0;
    for (let y = 0; y < N; y++) s += Math.abs(a[(y * N + x0) * 4] - a[(y * N + x1) * 4]);
    return s / N;
  };
  let interior = 0;
  for (let x = 0; x < N - 1; x += 37) interior = Math.max(interior, colStep(x, x + 1));
  assert.ok(colStep(N - 1, 0) <= interior * 1.25, `seam ${colStep(N - 1, 0)} vs interior ${interior}`);
  // Real blades: most texels are covered, heights use the range, normals centre on flat.
  let covered = 0;
  let nx = 0;
  for (let i = 0; i < N * N; i++) {
    if (a[i * 4] > 0.1 * 255) covered++;
    nx += a[i * 4 + 1];
  }
  assert.ok(covered / (N * N) > 0.6, `coverage ${covered / (N * N)}`);
  assert.ok(Math.abs(nx / (N * N) - 127.5) < 8, 'normals average to flat');
});

test('puddle basins are ranked: the level is the flooded share of the pitch', () => {
  const f = bake.fieldMap();
  assert.equal(f.length, FIELD_MAP.w * FIELD_MAP.h * 4);
  for (const level of [0.1, 0.2, 0.36]) {
    let below = 0;
    let total = 0;
    for (let j = 0; j < FIELD_MAP.h; j++) {
      for (let i = 0; i < FIELD_MAP.w; i++) {
        const x = FIELD_MAP.x0 + ((i + 0.5) / FIELD_MAP.w) * FIELD_MAP.sx;
        const z = FIELD_MAP.z0 + ((j + 0.5) / FIELD_MAP.h) * FIELD_MAP.sz;
        if (Math.abs(x) > FLAT_X || Math.abs(z) > FLAT_Z) continue;
        total++;
        if (f[(j * FIELD_MAP.w + i) * 4 + 2] / 255 < level) below++;
      }
    }
    assert.ok(Math.abs(below / total - level) < 0.015, `level ${level}: share ${below / total}`);
  }
});

test('wear: the goal mouths and the centre spot are worn, the wings mostly not', () => {
  const f = bake.fieldMap();
  const wear = (x, z) => f[texelAt(FIELD_MAP, x, z)] / 255;
  const mouth = (wear(0, -5150) + wear(0, 5150)) / 2;
  const centre = wear(0, 0);
  let wing = 0;
  for (const [x, z] of [[-3000, -1000], [3000, 1000], [-2500, 2000], [2500, -2000]]) wing += wear(x, z) / 4;
  assert.ok(mouth > centre && centre > wing, `mouth ${mouth} centre ${centre} wing ${wing}`);
  assert.ok(mouth < 0.95, 'some grass is left in the goal mouths');
});

test('pool map: floodlit where the heads aim, the pads masked, dark without lamps', () => {
  const world = themeWorld('harbour-night');
  const pm = bake.bakePoolMap(world.floodlights);
  assert.equal(pm.length, POOL_MAP.w * POOL_MAP.h * 4);
  const green = (x, z) => bake.decodePool(pm[texelAt(POOL_MAP, x, z) + 1]);
  // The heads are cross-aimed toward the middle: brighter there than in the far corners.
  assert.ok(green(0, 0) > 2 * green(-3900, 5200), `${green(0, 0)} vs ${green(-3900, 5200)}`);
  assert.ok(green(0, 0) > 0.5 && green(0, 0) < bake.POOL_MAX, 'inside the encoded range');
  // Pad mask: 1 on every pad, 0 at the centre spot and on a kickoff spot.
  for (const p of [...BOOST_PADS_BIG, ...BOOST_PADS_SMALL]) assert.equal(pm[texelAt(POOL_MAP, p[0], p[1]) + 3], 255, `pad ${p}`);
  assert.equal(pm[texelAt(POOL_MAP, 0, 0) + 3], 0);
  assert.equal(pm[texelAt(POOL_MAP, KICKOFF_SPAWNS[0][0], KICKOFF_SPAWNS[0][1]) + 3], 0);
  // Re-bake in place (what a theme change does) with every head off: no light, mask kept.
  const off = world.floodlights.map((f) => ({ ...f, strength: 0 }));
  assert.equal(bake.bakePoolMap(off, pm), pm, 'same buffer');
  for (let t = 0; t < POOL_MAP.w * POOL_MAP.h; t += 97) assert.equal(pm[t * 4] + pm[t * 4 + 1] + pm[t * 4 + 2], 0);
  assert.equal(pm[texelAt(POOL_MAP, BOOST_PADS_BIG[0][0], BOOST_PADS_BIG[0][1]) + 3], 255);
});

test('streak heads: a fixed count per tier whatever the theme, far heads first', () => {
  const world = themeWorld('harbour-night');
  for (const q of ['low', 'high', 'ultra']) {
    const n = TIERS[q].turfStreaks;
    const heads = bake.streakLamps(world.floodlights, n);
    assert.equal(heads.length, n);
    assert.ok(heads.every((h, i) => i === 0 || Math.abs(h.position[2]) <= Math.abs(heads[i - 1].position[2]) || heads[i - 1].strength === 0));
  }
  const none = bake.streakLamps([], 4);
  assert.equal(none.length, 4);
  assert.ok(none.every((h) => h.strength === 0 && h.color.every((c) => c === 0)), 'dark padding slots');
});

test('the markings fold the kickoff rings into one quadrant without losing or adding one', () => {
  // markings.ts draws the rings at |p|: valid only if the ring set is symmetric in x and in z.
  const full = new Set();
  for (const [kx, ky] of KICKOFF_SPAWNS) for (const s of [-1, 1]) full.add(`${s * kx || 0},${s * ky || 0}`);
  const unfolded = new Set();
  for (const [qx, qz] of bake.KICKOFF_RINGS_QUADRANT) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) unfolded.add(`${sx * qx || 0},${sz * qz || 0}`);
  }
  assert.deepEqual([...unfolded].sort(), [...full].sort());
});

test('every theme has a turf look; puddles stay subtle', () => {
  assert.deepEqual(Object.keys(TURF_LOOKS).sort(), [...THEME_IDS].sort());
  for (const id of THEME_IDS) {
    const look = turfLook(id);
    const w = themeWorld(id);
    const coverage = look.puddles * w.wetness;
    assert.ok(coverage >= 0 && coverage <= 0.25, `${id}: puddle coverage ${coverage}`);
    assert.ok(look.stripes >= 0 && look.stripes <= 0.5);
    assert.ok(look.dry >= 0 && look.dry <= 1);
    assert.ok(look.pools >= 0 && look.streaks >= 0 && look.team >= 0);
    assert.equal(look.tint.length, 3);
  }
});

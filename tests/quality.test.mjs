// Quality tiers and theme ids (node --test tests/quality.test.mjs): the tier table, the migration of
// saves from before the third tier, the menu order and the theme id parser. quality.ts and theme.ts
// are pure data, so they load in node without three.
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

const { QUALITIES, TIERS, tier, parseQuality, nextQuality, pixelRatio, MAX_TOUCH_PIXEL_RATIO } = await import('../src/render/quality.ts');
const { THEME_IDS, DEFAULT_THEME, parseTheme, themeWorld } = await import('../src/render/theme.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

test('three tiers in menu order, one table entry each', () => {
  assert.deepEqual(QUALITIES, ['low', 'high', 'ultra']);
  assert.deepEqual(Object.keys(TIERS).sort(), [...QUALITIES].sort());
  for (const q of QUALITIES) assert.equal(tier(q), TIERS[q]);
});

test('low keeps the old performance tier (1) and high the old quality tier (0)', () => {
  const low = tier('low');
  assert.equal(low.msaa, 0, 'FXAA instead of MSAA');
  assert.equal(low.bloom, false);
  assert.equal(low.maxPixelRatio, 1, 'CSS resolution');
  assert.equal(low.dynamicResolution, false);
  assert.equal(low.shadowMapSize, 2048);
  assert.equal(low.shadowRadius, 3);
  assert.equal(low.detail, 'low');
  assert.equal(low.netDetail, false, 'no near-camera hex fade on the glass');
  assert.equal(low.particles, 512);

  const high = tier('high');
  assert.equal(high.msaa, 4);
  assert.equal(high.bloom, true);
  assert.equal(high.bloomMips, 3);
  assert.equal(high.pixelBudget, 6e6);
  assert.equal(high.shadowMapSize, 4096);
  assert.equal(high.shadowRadius, 4);
  assert.equal(high.detail, 'high');
  assert.equal(high.netDetail, true);
  assert.equal(high.particles, 1536);
});

test('the pixel ratio of low and high is the one the old tiers used (1 and 0)', () => {
  // The old Renderer.resize: quality 1 rendered at CSS resolution; quality 0 followed the device
  // (phones capped at 2) down to a 6 Mpx budget, never below 1:1 for the budget.
  const oldQ0 = (dpr, touch, w, h) => {
    let d = dpr || 1;
    if (touch) d = Math.min(d, 2);
    return Math.min(d, Math.max(1, Math.sqrt(6e6 / (w * h))));
  };
  const sizes = [
    [375, 812],
    [812, 375],
    [1280, 720],
    [1536, 864],
    [1600, 900],
    [1920, 1080],
    [2560, 1440],
    [3840, 2160],
  ];
  for (const dpr of [0.75, 1, 1.25, 1.369, 1.5, 2, 2.25, 2.5, 3, 4]) {
    for (const touch of [false, true]) {
      for (const [w, h] of sizes) {
        const at = `dpr ${dpr} touch ${touch} ${w}x${h}`;
        assert.equal(pixelRatio(tier('low'), dpr, touch, w, h), 1, `low ${at}`);
        assert.equal(pixelRatio(tier('high'), dpr, touch, w, h), oldQ0(dpr, touch, w, h), `high ${at}`);
        assert.ok(pixelRatio(tier('ultra'), dpr, touch, w, h) >= pixelRatio(tier('high'), dpr, touch, w, h), `ultra ${at}`);
      }
    }
  }
  assert.equal(MAX_TOUCH_PIXEL_RATIO, 2);
  // A dpr-2 1080p laptop on high renders at ~1.7x instead of 2x (the budget).
  assert.ok(Math.abs(pixelRatio(tier('high'), 2, false, 1920, 1080) - Math.sqrt(6e6 / (1920 * 1080))) < 1e-12);
});

test('ultra is never below high on any switch', () => {
  const high = tier('high');
  const ultra = tier('ultra');
  for (const [key, hv] of Object.entries(high)) {
    const uv = ultra[key];
    if (typeof hv === 'number') {
      // Smaller is better only for the lowest dynamic-resolution scale.
      if (key === 'minResolutionScale') assert.ok(uv <= hv, `${key}: ultra ${uv} > high ${hv}`);
      else assert.ok(uv >= hv, `${key}: ultra ${uv} < high ${hv}`);
    } else if (typeof hv === 'boolean') assert.ok(uv || !hv, `${key}: on at high, off at ultra`);
    else assert.equal(uv, hv, key);
  }
});

test('dynamic resolution ranges are sane', () => {
  for (const q of QUALITIES) {
    const s = tier(q);
    assert.ok(s.minResolutionScale > 0 && s.minResolutionScale <= 1, `${q}: minResolutionScale in (0, 1]`);
    if (!s.dynamicResolution) assert.equal(s.minResolutionScale, 1, `${q}: no dynamic resolution, no lower scale`);
  }
});

test('parseQuality reads the tier names and the numbers saved before the third tier', () => {
  for (const q of QUALITIES) assert.equal(parseQuality(q), q);
  assert.equal(parseQuality(0), 'high', 'old quality 0');
  assert.equal(parseQuality(1), 'low', 'old performance 1');
  for (const bad of [2, -1, '0', '1', 'HIGH', 'medium', null, undefined, {}, true]) assert.equal(parseQuality(bad), null, String(bad));
});

test('the quality key cycles low -> high -> ultra -> low', () => {
  assert.equal(nextQuality('low'), 'high');
  assert.equal(nextQuality('high'), 'ultra');
  assert.equal(nextQuality('ultra'), 'low');
});

test('every tier has a menu label in English and Spanish', () => {
  assert.equal(en['quality.low'], 'Performance');
  assert.equal(en['quality.high'], 'High');
  assert.equal(en['quality.ultra'], 'Ultra');
  assert.equal(es['quality.low'], 'Rendimiento');
  assert.equal(es['quality.high'], 'Alta');
  assert.equal(es['quality.ultra'], 'Ultra');
});

test('parseTheme accepts the known ids only; unbuilt themes fall back to the default world', () => {
  for (const id of THEME_IDS) assert.equal(parseTheme(id), id);
  for (const bad of ['', 'harbour', 'HARBOUR-NIGHT', 0, null, undefined]) assert.equal(parseTheme(bad), null, String(bad));
  assert.ok(THEME_IDS.includes(DEFAULT_THEME));
  assert.equal(themeWorld(DEFAULT_THEME).id, DEFAULT_THEME);
  for (const id of THEME_IDS) assert.ok(themeWorld(id) !== undefined, id);
});

// Quality tiers and theme ids (node --test tests/quality.test.mjs): the tier table, the migration of
// saves from before the third tier, the menu order and the theme id parser. quality.ts and theme.ts
// are pure data, so they load in node without three; the tests of how post/lighting.ts applies the
// tier's shadow fields and the theme's keys (at the end) load three's lights and math, which need
// no renderer either.
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

const { QUALITIES, TIERS, tier, parseQuality, nextQuality, lowerQuality, pixelRatio, startingQuality, needsReload, drawsFrame, SUPERLOW_PIXELS, LOW_MEMORY_GB, MAX_TOUCH_PIXEL_RATIO } = await import('../src/render/quality.ts');
const { HELD_FRAME, MENU_FPS, MENU_FPS_LITE, MENU_COVER_LITE, FPS_CAPS, parseFpsCap, frameCap, sceneFps, drawsScene, runsLogic, FramePacer, pauseHolds } = await import('../src/render/quality.ts');
const { THEME_IDS, DEFAULT_THEME, parseTheme, themeWorld, lookOf, lightsOf: themeLights } = await import('../src/render/theme.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

test('four tiers in menu order, one table entry each', () => {
  assert.deepEqual(QUALITIES, ['superlow', 'low', 'high', 'ultra']);
  assert.deepEqual(Object.keys(TIERS).sort(), [...QUALITIES].sort());
  for (const q of QUALITIES) assert.equal(tier(q), TIERS[q]);
});

test('low renders straight to the canvas; high keeps the old quality tier (0)', () => {
  const low = tier('low');
  // The direct path: no HDR target, no post pass; the canvas' MSAA x4 instead of FXAA.
  assert.equal(low.output, 'direct');
  assert.equal(low.msaa, 4, 'canvas MSAA');
  assert.equal(low.bloom, false, 'no glow target on the canvas');
  for (const key of ['gtao', 'ssr', 'lensFlare', 'grassBlades', 'beamCones', 'puddles', 'turfRelief']) assert.equal(low[key], false, `low ${key}`);
  // Up to 1.5x within a 1 Mpx budget, dynamic resolution down to 0.6 of it.
  assert.equal(low.maxPixelRatio, 1.5);
  assert.equal(low.pixelBudget, 1e6);
  assert.equal(low.dynamicResolution, true);
  assert.equal(low.minResolutionScale, 0.6);
  assert.equal(low.shadowMapSize, 2048);
  assert.equal(low.shadowRadius, 3);
  assert.equal(low.detail, 'low');
  assert.equal(low.netDetail, false, 'no near-camera hex fade on the glass');
  assert.equal(low.particles, 512);
  // Its own look: the turf, stands, steel and boards unlit with the theme's light baked in, no
  // cage netting, no streak heads (the baked turf has no sheen to reflect them).
  assert.equal(low.bakedLight, true);
  assert.equal(low.netting, false);
  assert.equal(low.turfStreaks, 0);
  for (const q of ['high', 'ultra']) {
    assert.equal(tier(q).bakedLight, false, `${q}: lit surfaces`);
    assert.equal(tier(q).netting, true, `${q}: the cage netting`);
  }

  const high = tier('high');
  assert.equal(high.output, 'post');
  assert.equal(tier('ultra').output, 'post');
  assert.equal(high.msaa, 4);
  assert.equal(high.bloom, true);
  assert.equal(high.pixelBudget, 6e6);
  // Two 2048 keys on the desktop default (67 MB); ultra keeps the 4096 maps (268 MB).
  assert.equal(high.shadowMapSize, 2048);
  assert.equal(high.shadowRadius, 3);
  assert.equal(tier('ultra').shadowMapSize, 4096);
  assert.equal(tier('ultra').shadowRadius, 4);
  assert.equal(high.detail, 'high');
  assert.equal(high.netDetail, true);
  assert.equal(high.particles, 1536);
});

test('post and lighting switches (post/: two keys, bloom, the ultra extras)', () => {
  const low = tier('low');
  const high = tier('high');
  const ultra = tier('ultra');
  // Both keys exist on every tier (constant light count); low has no shadow maps (ground blobs).
  assert.equal(low.shadowedKeys, 0);
  assert.equal(high.shadowedKeys, 2);
  assert.equal(ultra.shadowedKeys, 2);
  // Emissive bloom over BloomNode's full 5 mips (its maximum) with a tight radius; none on low.
  assert.equal(high.bloomMips, 5);
  assert.equal(ultra.bloomMips, 5);
  for (const q of QUALITIES) assert.ok(tier(q).bloomMips >= 1 && tier(q).bloomMips <= 5, `${q}: BloomNode has 1..5 mips`);
  // Screen-space extras are ultra-only (high keeps its budget); MSAA, never TRAA, on high and ultra.
  for (const key of ['gtao', 'ssr', 'lensFlare']) {
    assert.equal(low[key], false, `low ${key}`);
    assert.equal(high[key], false, `high ${key}`);
    assert.equal(ultra[key], true, `ultra ${key}`);
  }
  assert.equal(ultra.msaa, 4);
  // Shadow maps are square powers of two the PCF filter can use.
  for (const q of QUALITIES) {
    const s = tier(q);
    assert.ok(Number.isInteger(Math.log2(s.shadowMapSize)) && s.shadowMapSize >= 512 && s.shadowMapSize <= 4096, `${q}: shadow map size`);
    assert.ok(s.shadowRadius > 0, `${q}: PCF radius`);
  }
});

test('every theme world feeds the lights and the grade sane values', () => {
  for (const id of THEME_IDS) {
    const w = themeWorld(id);
    for (const key of w.keys) {
      assert.ok(Math.abs(Math.hypot(...key.dir) - 1) < 1e-9, `${id}: key direction is a unit vector`);
      assert.ok(key.dir[1] > 0.2, `${id}: keys light from above (shadows stay on the pitch)`);
      assert.ok(key.intensity > 0 && key.color.every((c) => c >= 0), `${id}: key colour and intensity`);
    }
    assert.ok(w.keys[0].intensity >= w.keys[1].intensity, `${id}: keys[0] is the brighter key (the first to cast a shadow)`);
    assert.ok(w.fill.intensity >= 0 && w.fill.env >= 0, `${id}: fill`);
    assert.ok(['neutral', 'aces', 'agx'].includes(w.toneMapping), `${id}: tone curve`);
    assert.ok(w.exposure > 0, `${id}: exposure`);
    assert.ok(w.grade.contrast > 0 && w.grade.saturation >= 0, `${id}: grade`);
    assert.ok(w.grade.vignette >= 0 && w.grade.vignette < 1, `${id}: vignette`);
  }
});

test('the pixel ratio of high is the one the old quality tier (0) used; low: up to 1.5 within 1 Mpx', () => {
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
        const low = Math.min(dpr, 1.5, Math.max(1, Math.sqrt(1e6 / (w * h))));
        assert.equal(pixelRatio(tier('low'), dpr, touch, w, h), low, `low ${at}`);
        assert.equal(pixelRatio(tier('high'), dpr, touch, w, h), oldQ0(dpr, touch, w, h), `high ${at}`);
        assert.ok(pixelRatio(tier('ultra'), dpr, touch, w, h) >= pixelRatio(tier('high'), dpr, touch, w, h), `ultra ${at}`);
      }
    }
  }
  assert.equal(MAX_TOUCH_PIXEL_RATIO, 2);
  // A dpr-2 1080p laptop on high renders at ~1.7x instead of 2x (the budget).
  assert.ok(Math.abs(pixelRatio(tier('high'), 2, false, 1920, 1080) - Math.sqrt(6e6 / (1920 * 1080))) < 1e-12);
  // Low: a dpr-3 phone in landscape (780x360 CSS) at 1.5x (1170x540), a 1600x900 desktop at 1x.
  assert.equal(pixelRatio(tier('low'), 3, true, 780, 360), 1.5);
  assert.equal(pixelRatio(tier('low'), 1.369, false, 1600, 900), 1);
});

test("the drawing buffer fits the device's largest render target (maxTextureSize)", () => {
  // WebGPU compatibility mode allows 4096: a 3840x2160 CSS canvas at dpr 2 on high would be 7680.
  assert.equal(pixelRatio(tier('high'), 2, false, 3840, 2160, 4096), Math.min(Math.sqrt(6e6 / (3840 * 2160)) > 1 ? 2 : 1, 4096 / 3840));
  assert.ok(pixelRatio(tier('ultra'), 2, false, 3840, 2160, 4096) * 3840 <= 4096);
  assert.ok(pixelRatio(tier('low'), 3, true, 5000, 2000, 4096) * 5000 <= 4096 + 1e-9, 'below 1 when it must');
  // Nothing changes when the canvas fits.
  for (const q of QUALITIES) assert.equal(pixelRatio(tier(q), 2, false, 1600, 900, 4096), pixelRatio(tier(q), 2, false, 1600, 900), q);
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

test('super low: the direct path at about 640x360, 30 fps, nothing built that costs', () => {
  const s = tier('superlow');
  assert.equal(s.output, 'direct');
  assert.equal(s.msaa, 0, 'no MSAA (a multisampled canvas costs a tiler its write-out)');
  assert.equal(s.bloom, false);
  assert.equal(s.shadowedKeys, 0, 'no shadow maps');
  assert.equal(s.dynamicResolution, false, 'a fixed size: the compositor upscales it');
  assert.equal(s.minResolutionScale, 1);
  assert.equal(s.maxPixelRatio, 1);
  assert.equal(s.pixelBudget, SUPERLOW_PIXELS);
  assert.equal(SUPERLOW_PIXELS, 640 * 360);
  assert.equal(s.maxFps, 30);
  assert.equal(s.world, 'lite', 'no bake, no environment, no fog');
  for (const k of ['cheapMaterials', 'liteTurf', 'preferWebGL2', 'cpuLite', 'bakedLight']) assert.equal(s[k], true, k);
  for (const k of ['crowd', 'glare', 'netting', 'grassBlades', 'beamCones', 'gtao', 'ssr', 'lensFlare', 'puddles', 'turfRelief']) assert.equal(s[k], false, k);
  assert.equal(s.particles, 128);
  assert.equal(s.detail, 'low');
  // The other tiers keep everything as before.
  for (const q of ['low', 'high', 'ultra']) {
    const t = tier(q);
    assert.equal(t.world, 'baked', q);
    assert.equal(t.maxFps, 0, q);
    for (const k of ['cheapMaterials', 'liteTurf', 'preferWebGL2', 'cpuLite']) assert.equal(t[k], false, `${q} ${k}`);
    for (const k of ['crowd', 'glare']) assert.equal(t[k], true, `${q} ${k}`);
  }
});

test("super low's pixel ratio: the 640x360 budget below 1:1, exact on the 962x541 TV", () => {
  const sl = tier('superlow');
  const size = (w, h) => {
    const r = pixelRatio(sl, 1.3312, false, w, h);
    return [Math.floor(w * r), Math.floor(h * r)];
  };
  assert.deepEqual(size(962, 541), [640, 360], 'the TV: a 2x upscale to its 1280x720 UI');
  assert.deepEqual(size(1280, 720), [640, 360]);
  assert.deepEqual(size(1920, 1080), [640, 360]);
  for (const [w, h] of [[1600, 900], [1366, 768], [1024, 768], [780, 360], [3840, 2160]]) {
    const [bw, bh] = size(w, h);
    assert.ok(Math.abs(bw * bh - SUPERLOW_PIXELS) / SUPERLOW_PIXELS < 0.01, `${w}x${h}: ${bw}x${bh} about the budget`);
    assert.ok(Math.abs(bw / bh - w / h) < 0.01, `${w}x${h}: the aspect kept`);
  }
  // A canvas already under the budget stays at 1:1 (never above it), whatever the dpr.
  assert.equal(pixelRatio(sl, 3, true, 480, 270), 1);
  assert.equal(pixelRatio(sl, 0.75, false, 400, 300), 1);
});

test('needsReload: only a switch into or out of super low reloads the page', () => {
  for (const a of QUALITIES) {
    for (const b of QUALITIES) {
      const cross = (a === 'superlow') !== (b === 'superlow');
      assert.equal(needsReload(a, b), cross, `${a} -> ${b}`);
    }
  }
});

test('drawsFrame: a 30 fps cap draws every other vsync at 60 Hz, 25 fps at 50 Hz, all frames of a slower device', () => {
  const run = (hz, cap, n = 600) => {
    let last = -1;
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      const t = i * (1000 / hz) + (i % 3 === 0 ? 0.3 : -0.2); // vsync jitter
      if (drawsFrame(t, last, cap)) {
        last = t;
        drawn++;
      }
    }
    return (drawn / n) * hz;
  };
  assert.ok(Math.abs(run(60, 30) - 30) < 0.5, `60 Hz: ${run(60, 30)}`);
  assert.ok(Math.abs(run(50, 30) - 25) < 0.5, `50 Hz: ${run(50, 30)}`);
  assert.ok(Math.abs(run(120, 30) - 30) < 0.5, `120 Hz: ${run(120, 30)}`);
  assert.ok(Math.abs(run(144, 30) - 28.8) < 1.5, `144 Hz: ${run(144, 30)}`);
  assert.equal(run(20, 30), 20, 'a device at 20 fps draws every frame');
  assert.equal(run(60, 0), 60, 'no cap');
  assert.equal(drawsFrame(100, -1, 30), true, 'the first frame');
  assert.equal(drawsFrame(100, 200, 30), true, 'a timestamp that went back');
});

// ---- UI at rest (Game.ts frame): the scene's rate under the menus, held frames, the logic's cadence ----

/** sceneFps with a match on high (no cap) by default; `p` overrides. */
const pace = (p = {}) => sceneFps({ cover: 'none', cap: 0, lite: false, still: false, animated: true, phone: false, covered: 0, ...p });
/** Drawn frames per second of `n` animation frames at `hz` with vsync jitter, under `draws(t, last)`. */
function drawnRate(hz, draws, n = 600) {
  let last = -1;
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const t = i * (1000 / hz) + (i % 3 === 0 ? 0.3 : -0.2);
    if (draws(t, last)) {
      last = t;
      drawn++;
    }
  }
  return (drawn / n) * hz;
}
/** The refreshes between drawn frames of a fresh FramePacer at `fps` on `hz` over `secs` (jitter as drawnRate), and the rate. */
function paced(hz, fps, secs = 30) {
  const pacer = new FramePacer();
  const counts = new Set();
  let lastI = -1;
  let first = -1;
  let lastT = 0;
  let drawn = 0;
  for (let i = 0; i < Math.round(hz * secs); i++) {
    const t = 1000 + i * (1000 / hz) + (i % 3 === 0 ? 0.3 : -0.2);
    if (!pacer.draws(t, fps)) continue;
    if (lastI >= 0) counts.add(i - lastI);
    if (first < 0) first = t;
    lastT = t;
    lastI = i;
    drawn++;
  }
  return { fps: ((drawn - 1) * 1000) / (lastT - first), counts: [...counts].sort((a, b) => a - b) };
}
const DISPLAYS = [50, 59.94, 60, 60.05, 75, 90, 100, 119.88, 120, 144, 165, 240];

test('frameCap: the lower of the tier cap and the player limit, 0 = none; parseFpsCap keeps 30 / 60 only', () => {
  assert.equal(frameCap(0, 0), 0);
  assert.equal(frameCap(30, 0), 30, 'super low alone');
  assert.equal(frameCap(0, 60), 60, 'the player limit alone');
  assert.equal(frameCap(30, 60), 30);
  assert.equal(frameCap(60, 30), 30);
  assert.deepEqual(FPS_CAPS, [0, 30, 60]);
  for (const v of FPS_CAPS) assert.equal(parseFpsCap(v), v);
  for (const bad of [20, 45, 120, '30', null, undefined, true, {}]) assert.equal(parseFpsCap(bad), 0, String(bad));
});

test('sceneFps: a match at its cap, the menus at 30 (20 on super low or a mostly covered phone), held under opaque layers', () => {
  // A match: the tier's cap with the player's limit, whatever the menus said before.
  assert.equal(pace(), 0, 'high: the display rate');
  assert.equal(pace({ cap: TIERS.superlow.maxFps, lite: true }), 30, 'super low: 30');
  assert.equal(pace({ cap: frameCap(0, 60) }), 60, 'a 60 fps limit');
  // The menus with the stadium showing through.
  assert.equal(MENU_FPS, 30);
  assert.equal(MENU_FPS_LITE, 20);
  assert.equal(pace({ cover: 'partial' }), 30, 'low / high / ultra');
  assert.equal(pace({ cover: 'partial', cap: 30, lite: true }), 20, 'super low');
  assert.equal(pace({ cover: 'partial', phone: true, covered: 0.6 }), 30, 'a phone, the scene mostly visible');
  assert.equal(pace({ cover: 'partial', phone: true, covered: MENU_COVER_LITE }), 30, 'at the threshold');
  assert.equal(pace({ cover: 'partial', phone: true, covered: 0.86 }), 20, 'a phone, mostly covered');
  assert.equal(pace({ cover: 'partial', phone: false, covered: 0.86 }), 30, 'the 70 % rule is a phone\'s');
  assert.equal(pace({ cover: 'partial', cap: frameCap(0, 30) }), 30, 'never above the player limit');
  // One held frame: the menus' stadium may not move (prefers-reduced-motion, the pref off), an
  // opaque layer (modal, settings, the rotate screen), an offline pause.
  assert.equal(pace({ cover: 'partial', animated: false }), HELD_FRAME);
  assert.equal(pace({ cover: 'opaque' }), HELD_FRAME);
  assert.equal(pace({ cover: 'opaque', cap: 30, lite: true }), HELD_FRAME);
  assert.equal(pace({ still: true }), HELD_FRAME, 'offline pause');
  assert.equal(pace({ still: true, cover: 'partial' }), HELD_FRAME);
});

test('pauseHolds: only an offline pause holds the scene; online the match goes on (its pause, its whistle)', () => {
  assert.equal(pauseHolds(true, false, false), true, 'an offline match or training, paused');
  assert.equal(pauseHolds(false, false, false), false);
  assert.equal(pauseHolds(true, true, false), false, 'the menus pace their own scene');
  // Online: a pause, and the session's 'ended' state (the whistle, the menus not back yet: still an
  // active session, though not inMatch) with the pause up.
  assert.equal(pauseHolds(true, false, true), false, 'an online pause, or the whistle under it');
  assert.equal(pace({ still: pauseHolds(true, false, true), cap: TIERS.superlow.maxFps, lite: true }), 30, 'its end drawn at the cap');
});

test('FramePacer: 20 / 30 / 60 fps on average on any display (its own rate when slower)', () => {
  for (const hz of DISPLAYS) {
    for (const fps of [MENU_FPS_LITE, MENU_FPS, 60]) {
      const r = paced(hz, fps);
      assert.ok(Math.abs(r.fps - Math.min(fps, hz)) < 0.5, `${fps} fps on ${hz} Hz: ${r.fps.toFixed(2)}`);
    }
  }
  // Where drawsFrame's whole refreshes fall short (quality.ts FramePacer).
  assert.ok(Math.abs(drawnRate(165, (t, last) => drawsFrame(t, last, 30), 3300) - 27.5) < 0.5, 'drawsFrame: 27.5 on 165 Hz');
  assert.ok(Math.abs(drawnRate(75, (t, last) => drawsFrame(t, last, 60), 1500) - 37.5) < 0.5, 'drawsFrame: 37.5 on 75 Hz');
});

test('FramePacer: the two nearest counts of refreshes, one on a display a hair off a multiple of the rate', () => {
  assert.deepEqual(paced(165, 30).counts, [5, 6]);
  assert.deepEqual(paced(144, 30).counts, [4, 5]);
  assert.deepEqual(paced(50, 20).counts, [2, 3]);
  assert.deepEqual(paced(144, 60).counts, [2, 3]);
  assert.deepEqual(paced(75, 60).counts, [1, 2]);
  // Locked to the display (a strict deadline would skip or double a refresh every few seconds there).
  const locked = [
    [59.94, 30, 2],
    [60, 30, 2],
    [60.05, 30, 2],
    [59.94, 20, 3],
    [60.05, 20, 3],
    [119.88, 30, 4],
    [120, 60, 2],
    [60, 60, 1],
    [60.05, 60, 1],
    [240, 30, 8],
  ];
  for (const [hz, fps, k] of locked) assert.deepEqual(paced(hz, fps, 60).counts, [k], `${fps} fps on ${hz} Hz: every ${k} refreshes`);
  assert.deepEqual(paced(50, 60).counts, [1], 'a display slower than the rate: every frame');
});

test('FramePacer: the first frame, a forced one and a stall start the deadline over; a clock that went back draws', () => {
  const p = new FramePacer();
  const v = 1000 / 60;
  assert.equal(p.draws(1000, 30), true, 'the first frame');
  assert.equal(p.draws(1000 + v, 30), false);
  assert.equal(p.draws(1000 + 2 * v, 30), true);
  assert.equal(p.draws(1000 + 3 * v, 30, true), true, 'forced (a change of pace, a redraw)');
  assert.equal(p.draws(1000 + 4 * v, 30), false, 'one period from the forced frame');
  assert.equal(p.draws(1000 + 5 * v, 30), true);
  // A stall of half a second: one frame, then the rate from it (no burst to catch up).
  let t = 1500 + 5 * v;
  assert.equal(p.draws(t, 30), true);
  assert.equal(p.draws((t += v), 30), false);
  assert.equal(p.draws((t += v), 30), true);
  assert.equal(p.draws(t - 1000, 30), true, 'a timestamp that went back');
  for (let i = 0; i < 5; i++) assert.equal(p.draws(t + i * v, 0), true, 'fps 0: every frame');
  p.reset();
  assert.equal(p.draws(t + 5 * v, 30), true, 'after reset');
});

test('drawsScene: the paced rates through a FramePacer, the tier cap in whole refreshes, nothing while held unless something changed', () => {
  const at = (fps) => {
    const pacer = new FramePacer();
    return (t, last) => drawsScene(t, last, fps, false, pacer);
  };
  assert.ok(Math.abs(drawnRate(60, at(30)) - 30) < 0.5, `menus at 60 Hz: ${drawnRate(60, at(30))}`);
  assert.ok(Math.abs(drawnRate(60, at(20)) - 20) < 0.5, `super low menus at 60 Hz: ${drawnRate(60, at(20))}`);
  assert.ok(Math.abs(drawnRate(50, at(20), 1000) - 20) < 0.5, `50 Hz: ${drawnRate(50, at(20), 1000)}`);
  assert.ok(Math.abs(drawnRate(165, at(30), 3300) - 30) < 0.5, `165 Hz: ${drawnRate(165, at(30), 3300)}`);
  assert.equal(drawnRate(60, at(0)), 60, 'a match without a cap');
  assert.equal(drawnRate(60, at(HELD_FRAME)), 0, 'held');
  // No pacer: the tier's own cap over a match not being played, in whole refreshes as drawsFrame.
  const whole = (fps) => (t, last) => drawsScene(t, last, fps, false, null);
  assert.ok(Math.abs(drawnRate(50, whole(30)) - 25) < 0.5, `whole refreshes on 50 Hz: ${drawnRate(50, whole(30))}`);
  assert.equal(drawnRate(60, whole(0)), 60);
  const p = new FramePacer();
  assert.equal(drawsScene(5000, 4990, HELD_FRAME, true, p), true, 'a change under the held frame draws it once');
  assert.equal(drawsScene(5000, 4990, 20, true, p), true);
  assert.equal(drawsScene(5010, 5000, 20, false, p), false, 'a forced frame starts the period');
  assert.equal(drawsScene(5000, -1, HELD_FRAME, false, p), false, 'held from the first frame: only a change draws');
  assert.equal(drawsScene(5000, -1, HELD_FRAME, false, null), false);
  assert.equal(drawsScene(5010, 5000, 20, false, p), true, 'held resets the pacer: its next paced frame draws');
});

test("runsLogic: a live match keeps its cap (the tier's in whole refreshes, the player's at its average), the menus and an offline pause run every frame", () => {
  const logic = (cap, live, pacer) => (t, last) => runsLogic(t, last, cap, live, pacer);
  assert.ok(Math.abs(drawnRate(60, logic(30, true, null)) - 30) < 0.5, 'super low match: 30, as drawsFrame');
  assert.ok(Math.abs(drawnRate(50, logic(30, true, null)) - 25) < 0.5, 'super low match on 50 Hz: 25, as it always was');
  assert.equal(drawnRate(60, logic(0, true, null)), 60);
  for (const [hz, cap] of [[144, 60], [165, 60], [75, 60], [144, 30], [165, 30], [50, 30]]) {
    const r = drawnRate(hz, logic(cap, true, new FramePacer()), hz * 20);
    assert.ok(Math.abs(r - cap) < 0.5, `the player's ${cap} fps limit on ${hz} Hz: ${r.toFixed(2)}`);
  }
  assert.equal(drawnRate(60, logic(30, false, null)), 60, 'super low menus: every frame');
  assert.equal(drawnRate(144, logic(30, false, new FramePacer())), 144);
});

test('parseQuality reads the tier names and the numbers saved before the third tier', () => {
  for (const q of QUALITIES) assert.equal(parseQuality(q), q);
  assert.equal(parseQuality(0), 'high', 'old quality 0');
  assert.equal(parseQuality(1), 'low', 'old performance 1');
  for (const bad of [2, -1, '0', '1', 'HIGH', 'medium', null, undefined, {}, true]) assert.equal(parseQuality(bad), null, String(bad));
});

test('WebGL2, WebGPU compatibility mode and small-memory devices start on low unless the player chose a tier', () => {
  const core = { webgpu: true, compatibilityMode: false, deviceMemory: undefined };
  const weak = [
    ['WebGL2', { ...core, webgpu: false }],
    ['compatibility mode', { ...core, compatibilityMode: true }],
    ['4 GB', { ...core, deviceMemory: 4 }],
    ['2 GB', { ...core, deviceMemory: 2 }],
  ];
  for (const q of QUALITIES) {
    assert.equal(startingQuality(q, false, core), q, `${q}: WebGPU keeps the saved / default tier`);
    assert.equal(startingQuality(q, true, core), q, `${q}: WebGPU, chosen`);
    assert.equal(startingQuality(q, false, { ...core, deviceMemory: 8 }), q, `${q}: 8 GB`);
    for (const [name, device] of weak) {
      assert.equal(startingQuality(q, true, device), q, `${q}: ${name} keeps a tier the player chose`);
      // Only tiers above low come down to it: super low (decided for a weaker device) stays.
      assert.equal(startingQuality(q, false, device), q === 'superlow' ? 'superlow' : 'low', `${q}: ${name} default`);
    }
  }
  assert.equal(LOW_MEMORY_GB, 4);
});

test("a GPU's remembered ceiling caps the starting tier, a chosen one too", () => {
  const core = { webgpu: true, compatibilityMode: false, deviceMemory: undefined };
  assert.equal(startingQuality('ultra', true, core, 'high'), 'high');
  assert.equal(startingQuality('ultra', true, core, 'low'), 'low');
  assert.equal(startingQuality('high', true, core, 'ultra'), 'high', 'a ceiling never raises');
  assert.equal(startingQuality('low', true, core, 'high'), 'low');
  assert.equal(startingQuality('ultra', false, core, null), 'ultra');
  assert.equal(startingQuality('high', true, core, 'superlow'), 'superlow', 'a ceiling may be super low');
  assert.equal(startingQuality('superlow', false, { ...core, webgpu: false }, 'high'), 'superlow');
});

test('lowerQuality steps ultra -> high -> low -> superlow -> null', () => {
  assert.equal(lowerQuality('ultra'), 'high');
  assert.equal(lowerQuality('high'), 'low');
  assert.equal(lowerQuality('low'), 'superlow');
  assert.equal(lowerQuality('superlow'), null);
});

test("lookOf: the low tier takes the theme's low overrides, the post tiers never", () => {
  const w = themeWorld(DEFAULT_THEME);
  assert.deepEqual(lookOf(w, 'post'), { exposure: w.exposure, grade: w.grade });
  const tuned = { ...w, low: { exposure: 1.4, grade: { contrast: 1.0, vignette: 0.1 } } };
  assert.deepEqual(lookOf(tuned, 'post'), { exposure: w.exposure, grade: w.grade });
  const low = lookOf(tuned, 'direct');
  assert.equal(low.exposure, 1.4);
  assert.deepEqual(low.grade, { ...w.grade, contrast: 1.0, vignette: 0.1 });
  for (const id of THEME_IDS) {
    const l = lookOf(themeWorld(id), 'direct');
    assert.ok(l.exposure > 0 && l.grade.contrast > 0 && l.grade.saturation >= 0 && l.grade.vignette >= 0 && l.grade.vignette < 1, `${id}: low look sane`);
  }
});

test("lightsOf: the low tier takes the theme's low key intensities and fill, the post tiers never", () => {
  const w = themeWorld(DEFAULT_THEME);
  for (const id of THEME_IDS) {
    const tw = themeWorld(id);
    const post = themeLights(tw, 'post');
    assert.equal(post.keys, tw.keys, `${id}: post keys are the theme's`);
    assert.equal(post.fill, tw.fill, `${id}: post fill is the theme's`);
  }
  const tuned = { ...w, low: { keys: [3, 2], fill: { intensity: 2 } } };
  const low = themeLights(tuned, 'direct');
  assert.deepEqual(low.keys.map((k) => k.intensity), [3, 2]);
  low.keys.forEach((k, i) => {
    assert.deepEqual(k.dir, w.keys[i].dir, "directions stay the theme's");
    assert.deepEqual(k.color, w.keys[i].color, "colours stay the theme's");
  });
  assert.deepEqual(low.fill, { ...w.fill, intensity: 2 });
  // Only a fill override: the keys stay the theme's objects; only a look override: the fill too.
  assert.equal(themeLights({ ...w, low: { fill: { env: 1 } } }, 'direct').keys, w.keys);
  assert.equal(themeLights({ ...w, low: { exposure: 2 } }, 'direct').fill, w.fill);
});

test('every theme reads at least as bright and flat on Performance as on high; the direct path compiles no contrast or vignette', () => {
  for (const id of THEME_IDS) {
    const w = themeWorld(id);
    const low = lookOf(w, 'direct');
    const lights = themeLights(w, 'direct');
    assert.ok(low.exposure >= w.exposure, `${id}: low exposure ${low.exposure} >= ${w.exposure}`);
    assert.ok(low.grade.contrast <= w.grade.contrast, `${id}: low contrast no harder`);
    assert.ok(low.grade.lift.every((c, i) => c >= w.grade.lift[i]), `${id}: low lift no darker`);
    // post/pipeline.ts compiles these stages only when some theme uses them on the direct path.
    assert.equal(low.grade.contrast, 1, `${id}: no contrast stage on the direct path`);
    assert.equal(low.grade.vignette, 0, `${id}: no vignette on the direct path`);
    assert.ok(lights.fill.intensity >= w.fill.intensity && lights.fill.env >= w.fill.env, `${id}: low fill no dimmer`);
    lights.keys.forEach((k, i) => assert.ok(k.intensity >= w.keys[i].intensity && k.intensity > 0, `${id}: low key ${i} no dimmer`));
    assert.ok(lights.keys[0].intensity >= lights.keys[1].intensity, `${id}: keys[0] stays the brighter key`);
  }
});

test('the quality key cycles superlow -> low -> high -> ultra -> superlow', () => {
  assert.equal(nextQuality('superlow'), 'low');
  assert.equal(nextQuality('low'), 'high');
  assert.equal(nextQuality('high'), 'ultra');
  assert.equal(nextQuality('ultra'), 'superlow');
});

test('every tier has a menu label in English and Spanish', () => {
  assert.equal(en['quality.superlow'], 'Super low');
  assert.equal(es['quality.superlow'], 'Súper bajo');
  for (const q of QUALITIES) {
    const key = `settings.quality${q[0].toUpperCase()}${q.slice(1)}Hint`;
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en ${key}`);
    assert.ok(typeof es[key] === 'string' && es[key].length > 0, `es ${key}`);
  }
  assert.equal(en['quality.low'], 'Performance');
  assert.equal(en['quality.high'], 'High');
  assert.equal(en['quality.ultra'], 'Ultra');
  assert.equal(es['quality.low'], 'Rendimiento');
  assert.equal(es['quality.high'], 'Alta');
  assert.equal(es['quality.ultra'], 'Ultra');
});

test('every theme has a menu name in English and Spanish (the stadium row of the Friendly screen)', () => {
  const names = {
    'harbour-night': ['Night harbour', 'Puerto de noche'],
    'canyon-sunset': ['Red canyon', 'Cañón rojo'],
    'alpine-day': ['Alpine valley', 'Valle alpino'],
  };
  assert.deepEqual(Object.keys(names).sort(), [...THEME_IDS].sort());
  for (const id of THEME_IDS) {
    assert.equal(en[`theme.${id}`], names[id][0], `${id} (en)`);
    assert.equal(es[`theme.${id}`], names[id][1], `${id} (es)`);
  }
  assert.equal(en['friendly.theme'], 'Stadium');
  assert.equal(es['friendly.theme'], 'Estadio');
});

test('parseTheme accepts the known ids only; unbuilt themes fall back to the default world', () => {
  for (const id of THEME_IDS) assert.equal(parseTheme(id), id);
  for (const bad of ['', 'harbour', 'HARBOUR-NIGHT', 0, null, undefined]) assert.equal(parseTheme(bad), null, String(bad));
  assert.ok(THEME_IDS.includes(DEFAULT_THEME));
  assert.equal(themeWorld(DEFAULT_THEME).id, DEFAULT_THEME);
  for (const id of THEME_IDS) assert.ok(themeWorld(id) !== undefined, id);
});

// ---- post/lighting.ts: the tier's shadow fields and the theme's keys, applied to real lights ----

const THREE = await import('three/webgpu');
const { createLighting } = await import('../src/render/post/lighting.ts');
const { ARENA } = await import('../src/sim/constants.ts');

const lightsOf = (scene) => scene.children.filter((o) => o.isLight);

test('lighting: both keys and the fill exist on every tier and theme (constant light count)', () => {
  for (const q of QUALITIES) {
    const scene = new THREE.Scene();
    const lighting = createLighting(scene, q, DEFAULT_THEME);
    assert.deepEqual(lightsOf(scene).map((l) => l.name), ['key-0', 'key-1', 'fill'], `${q}: lights`);
    assert.equal(lighting.sun, lighting.keys[0]);
    for (const id of THEME_IDS) {
      lighting.setTheme(id);
      assert.equal(lightsOf(scene).length, 3, `${q} / ${id}: a theme switch never changes the light count`);
    }
    lighting.dispose();
    assert.equal(scene.children.length, 0, `${q}: dispose removes the keys, their targets and the fill`);
  }
});

test('lighting: the tier decides which keys cast shadows (keys[0] first), their map size and PCF radius', () => {
  const scene = new THREE.Scene();
  const lighting = createLighting(scene, 'low', DEFAULT_THEME);
  // The order a session switches in, so the size and castShadow changes are exercised both ways.
  for (const q of ['low', 'high', 'ultra', 'low', 'high']) {
    lighting.setQuality(q);
    const spec = tier(q);
    lighting.keys.forEach((key, i) => {
      assert.equal(key.castShadow, i < spec.shadowedKeys, `${q}: key ${i} castShadow`);
      assert.equal(key.shadow.mapSize.x, spec.shadowMapSize, `${q}: key ${i} map width`);
      assert.equal(key.shadow.mapSize.y, spec.shadowMapSize, `${q}: key ${i} map height`);
      assert.equal(key.shadow.radius, spec.shadowRadius, `${q}: key ${i} PCF radius`);
    });
  }
  lighting.dispose();
});

test('lighting: keys and fill follow the theme world (direction, colour, intensity)', () => {
  const scene = new THREE.Scene();
  const lighting = createLighting(scene, 'high', DEFAULT_THEME);
  for (const id of THEME_IDS) {
    lighting.setTheme(id);
    const w = themeWorld(id);
    lighting.keys.forEach((key, i) => {
      const spec = w.keys[i];
      const dir = key.position.clone().sub(key.target.position).normalize();
      assert.ok(dir.distanceTo(new THREE.Vector3(...spec.dir)) < 1e-9, `${id}: key ${i} direction`);
      assert.deepEqual(key.color.toArray(), [...spec.color], `${id}: key ${i} colour`);
      assert.equal(key.intensity, spec.intensity, `${id}: key ${i} intensity`);
    });
    assert.deepEqual(lighting.hemi.color.toArray(), [...w.fill.sky], `${id}: fill sky`);
    assert.deepEqual(lighting.hemi.groundColor.toArray(), [...w.fill.ground], `${id}: fill ground`);
    assert.equal(lighting.hemi.intensity, w.fill.intensity, `${id}: fill intensity`);
  }
  lighting.dispose();
});

test("lighting: the low tier lights with the theme's low keys and fill, a switch back restores the theme's", () => {
  const scene = new THREE.Scene();
  const lighting = createLighting(scene, 'low', DEFAULT_THEME);
  const check = (q, id) => {
    const want = themeLights(themeWorld(id), tier(q).output);
    lighting.keys.forEach((key, i) => assert.equal(key.intensity, want.keys[i].intensity, `${q} / ${id}: key ${i} intensity`));
    assert.equal(lighting.hemi.intensity, want.fill.intensity, `${q} / ${id}: fill intensity`);
    assert.deepEqual(lighting.hemi.color.toArray(), [...want.fill.sky], `${q} / ${id}: fill sky`);
  };
  check('low', DEFAULT_THEME);
  for (const q of ['high', 'low', 'ultra', 'low']) {
    lighting.setQuality(q);
    for (const id of THEME_IDS) {
      lighting.setTheme(id);
      check(q, id);
    }
  }
  lighting.dispose();
});

test('lighting: each shadow frustum holds the whole arena box (field + goals, floor to ceiling)', () => {
  const scene = new THREE.Scene();
  const lighting = createLighting(scene, 'high', DEFAULT_THEME);
  const hx = ARENA.extentX;
  const hz = ARENA.extentY + ARENA.goalDepth;
  const p = new THREE.Vector3();
  for (const id of THEME_IDS) {
    lighting.setTheme(id);
    for (const key of lighting.keys) {
      const cam = key.shadow.camera;
      assert.ok(cam.near > 0 && cam.far > cam.near, `${id} ${key.name}: near / far`);
      for (let i = 0; i < 8; i++) {
        p.set(i & 1 ? hx : -hx, i & 2 ? ARENA.height : 0, i & 4 ? hz : -hz).project(cam);
        for (const c of [p.x, p.y, p.z]) assert.ok(Math.abs(c) <= 1, `${id} ${key.name}: corner ${i} inside the frustum (${p.toArray()})`);
      }
    }
  }
  lighting.dispose();
});

const { parseResolutionScale, scaledPixelRatio, RESOLUTION_SCALE_RANGE, DEFAULT_RESOLUTION_SCALE } = await import('../src/render/quality.ts');

test('resolution scale (Settings > Graphics): a pref saved before it reads 100; snapped to 5 % inside 50-125', () => {
  assert.equal(DEFAULT_RESOLUTION_SCALE, 100);
  assert.deepEqual(RESOLUTION_SCALE_RANGE, [50, 125, 5]);
  for (const v of [undefined, null, 'big', NaN, Infinity]) assert.equal(parseResolutionScale(v), 100, String(v));
  assert.equal(parseResolutionScale(85), 85);
  assert.equal(parseResolutionScale(87), 85);
  assert.equal(parseResolutionScale(10), 50);
  assert.equal(parseResolutionScale(400), 125);
});

test('scaledPixelRatio: the scale multiplies the tier ratio; no side passes the device limit (4096 in WebGPU compatibility)', () => {
  assert.equal(scaledPixelRatio(1, 0.5, 1366, 768), 0.5);
  assert.equal(scaledPixelRatio(2, 1.25, 1366, 768, 4096), 2.5);
  // 125 % of a 2x 1920-wide canvas would be 4800 wide: capped at 4096.
  const r = scaledPixelRatio(2, 1.25, 1920, 1080, 4096);
  assert.ok(Math.floor(1920 * r) <= 4096 && Math.floor(1080 * r) <= 4096);
  assert.ok(Math.abs(r - 4096 / 1920) < 1e-9);
  assert.equal(scaledPixelRatio(1, 0, 800, 600), 1, 'no scale: the tier ratio');
});

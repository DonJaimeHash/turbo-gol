// The world module's CPU side (node --test tests/world.test.mjs): the world presets and the theme
// facts they pair with, the harbour generator (determinism, the live layer's bounds and heights,
// dry runs), the lamp light map and its half floats, the cache key / record validation / row copy,
// and the silent fallback when IndexedDB is missing. Shaders and the bake itself need a GPU: they
// are checked in the running game (docs/visuals/REWORK.md, #nancheck).
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

const THREE = await import('three/webgpu');
const { THEME_IDS, themeWorld } = await import('../src/render/theme.ts');
const { worldPreset, hasWorldPreset, dirFromAzEl } = await import('../src/render/world/presets.ts');
const H = await import('../src/render/world/harbour.ts');
const { KIND } = await import('../src/render/world/geo.ts');
const { lightMapTexels, buildLightMap, toHalfBits } = await import('../src/render/world/lightmap.ts');
const cache = await import('../src/render/world/cache.ts');

const finite3 = (c) => c.length === 3 && c.every((v) => Number.isFinite(v) && v >= 0);

test('every theme resolves to a world preset; the three built ones are their own', () => {
  for (const id of THEME_IDS) assert.ok(worldPreset(id).skyline === 'harbour' || worldPreset(id).skyline === 'canyon', id);
  for (const id of ['harbour-night', 'harbour-day', 'canyon-sunset']) assert.ok(hasWorldPreset(id), id);
  assert.equal(worldPreset('harbour-night').skyline, 'harbour');
  assert.equal(worldPreset('harbour-day').skyline, 'harbour');
  assert.equal(worldPreset('canyon-sunset').skyline, 'canyon');
  // themes without a preset yet use the default world
  assert.equal(worldPreset('city-dusk'), worldPreset('harbour-night'));
});

test('world presets hold finite, non-negative radiance and sane ranges', () => {
  for (const id of ['harbour-night', 'harbour-day', 'canyon-sunset']) {
    const p = worldPreset(id);
    for (const c of [p.zenith, p.mid, p.horizon, p.glow.color, p.key.color, p.key.light, p.ambSky, p.ambGround, p.sea.color, p.envTurf]) assert.ok(finite3(c), `${id} colour ${c}`);
    for (const cl of [p.clouds, p.cirrus]) {
      assert.ok(cl.cover >= 0 && cl.cover <= 1, `${id} cover`);
      assert.ok(cl.alpha >= 0 && cl.alpha <= 1, `${id} alpha`);
      assert.ok(cl.height > 0 && cl.scale > 0 && cl.stretch > 0, `${id} cloud shape`);
      for (const c of [cl.lit, cl.shadow, cl.under]) assert.ok(finite3(c), `${id} cloud colour`);
    }
    assert.ok(p.hazeHeight > 0 && p.hazeGain > 0 && p.lights >= 0 && p.windows >= 0 && p.envLamp >= 0, id);
    assert.ok(p.key.el > 0 && p.key.el < 90 && p.key.sizeDeg > 0, `${id} key body above the horizon`);
  }
  // night has the moon, stars and lamps; day has none of them
  assert.equal(worldPreset('harbour-night').key.moon, true);
  assert.ok(worldPreset('harbour-night').stars > 0 && worldPreset('harbour-night').lights > 0);
  assert.equal(worldPreset('harbour-day').key.moon, false);
  assert.equal(worldPreset('harbour-day').stars, 0);
  assert.equal(worldPreset('harbour-day').lights, 0);
});

test('dirFromAzEl: unit vectors, azimuth 0 = +z, 90 = -x, elevation up', () => {
  const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  assert.ok(close(dirFromAzEl(0, 0), [-0, 0, 1]));
  assert.ok(close(dirFromAzEl(90, 0), [-1, 0, Math.cos(Math.PI / 2)]));
  assert.ok(close(dirFromAzEl(0, 90), [-0, 1, Math.cos(Math.PI / 2)]));
  for (const [az, el] of [[12, 3], [-38, 31], [200, 60]]) assert.ok(Math.abs(Math.hypot(...dirFromAzEl(az, el)) - 1) < 1e-12);
});

test('the built themes keep the light count and ship their shared facts (setTheme end to end)', () => {
  const night = themeWorld('harbour-night');
  for (const id of ['harbour-night', 'harbour-day', 'canyon-sunset']) {
    const w = themeWorld(id);
    assert.equal(w.id, id, 'its own entry, not the fallback');
    assert.equal(w.keys.length, 2);
    for (const k of w.keys) {
      assert.ok(Math.abs(Math.hypot(...k.dir) - 1) < 1e-9, `${id} key dir is a unit vector`);
      assert.ok(k.dir[1] > 0, `${id} key from above`);
      assert.ok(finite3(k.color) && k.intensity > 0, `${id} key colour`);
    }
    assert.equal(w.floodlights.length, night.floodlights.length, `${id}: same floodlight slots`);
    assert.ok(w.fog.density > 0 && finite3(w.fog.color), `${id} fog`);
    assert.ok(w.fill.env > 0 && w.fill.intensity > 0, `${id} fill`);
    assert.ok(['neutral', 'aces', 'agx'].includes(w.toneMapping) && w.exposure > 0, `${id} tone`);
  }
  assert.ok(themeWorld('harbour-day').floodlights.every((f) => f.strength === 0), 'floodlights off by day');
  assert.equal(themeWorld('harbour-day').night, false);
});

test('harbour live layer: deterministic, inside its radius, clear of the stadium, tall over the boards', () => {
  const a = H.buildHarbourLive();
  const b = H.buildHarbourLive();
  const pa = a.geometry.attributes.position.array;
  const pb = b.geometry.attributes.position.array;
  assert.equal(pa.length, pb.length);
  assert.ok(pa.every((v, i) => v === pb[i]), 'same seed, same geometry');
  const col = a.geometry.attributes.kcol.array;
  let maxR = 0;
  let yardTop = -Infinity;
  let craneTop = -Infinity;
  for (let i = 0; i < pa.length / 3; i++) {
    const x = pa[i * 3];
    const y = pa[i * 3 + 1];
    const z = pa[i * 3 + 2];
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z));
    maxR = Math.max(maxR, Math.hypot(x, y - 250, z));
    // nothing of the harbour stands up inside the stadium's footprint
    if (Math.abs(x) < H.STADIUM_HALF_X && Math.abs(z) < H.STADIUM_HALF_Z) assert.ok(y <= H.QUAY + 1, `vertex ${i} (${x}, ${y}, ${z}) inside the stadium`);
    const kind = col[i * 4 + 3];
    if (kind === KIND.CONTAINER && z > 8000 && z < 15000) yardTop = Math.max(yardTop, y);
    if (kind === KIND.STEEL && z > 14000 && z < 24000 && Math.abs(x) < 6000) craneTop = Math.max(craneTop, y);
  }
  assert.ok(maxR <= H.LIVE_RADIUS, `live layer within ${H.LIVE_RADIUS} (got ${maxR.toFixed(0)})`);
  assert.ok(yardTop > 900 + 250, `north yard rises clearly above y = 900 (top ${yardTop.toFixed(0)})`);
  assert.ok(craneTop > 5500, `cranes tower over the yard (top ${craneTop.toFixed(0)})`);
  for (const name of ['normal', 'kcol', 'kloc', 'kdat']) assert.ok(a.geometry.attributes[name].array.every(Number.isFinite), name);
  assert.ok(a.stats.triangles < 60000, `live triangles ${a.stats.triangles}`);
  assert.deepEqual(a.lighthouse.pos, H.LIGHTHOUSE_LANTERN, 'the beam origin constant matches the generator');
  assert.ok(a.lamps.length > 10);
  a.geometry.dispose();
  b.geometry.dispose();
});

test('a dry far-harbour run collects exactly the lamps of a full run (cached and baked light maps agree)', () => {
  const dry = H.buildHarbourFar(true);
  const full = H.buildHarbourFar(false);
  assert.equal(dry.geometry, null);
  assert.deepEqual(dry.lamps, full.lamps);
  assert.equal(dry.stats.parts, full.stats.parts);
  assert.ok(full.geometry.attributes.position.count === full.stats.verts);
  full.geometry.dispose();
});

test('light map: finite, non-negative light, lamps light the ground below them', () => {
  const lamps = [
    { pos: [0, 3000, 0], range: 2700, color: [3.6, 2, 0.8], down: 1 },
    { pos: [5000, 1000, 2000], range: 1300, color: [1.6, 1.65, 1.8], down: 0 },
  ];
  const res = 64;
  const { data, rect } = lightMapTexels(lamps, res, [0, 3000]);
  assert.equal(data.length, res * res * 4 * 4);
  for (let t = 0; t < data.length; t += 4) {
    for (let k = 0; k < 3; k++) assert.ok(Number.isFinite(data[t + k]) && data[t + k] >= 0);
    assert.ok(Number.isFinite(data[t + 3]) && Math.abs(data[t + 3]) <= 1 + 1e-6, 'direction component');
  }
  // the up-facing ground under the first lamp is lit, far corners are dark
  const i = Math.floor(((0 - rect[0]) / rect[2]) * res);
  const j = Math.floor(((0 - rect[1]) / rect[3]) * res);
  assert.ok(data[(j * res + i) * 4] > 0.1);
  assert.equal(data[0], 0);
  const lm = buildLightMap(lamps, res);
  assert.equal(lm.data.length, data.length);
  assert.equal(lm.res, res);
  lm.texture.dispose();
});

test('toHalfBits matches three within half precision (truncation)', () => {
  for (const v of [0, 6.2e-5, 0.001, 0.1, 0.5, 1, 1.5, 3.14159, 100, 1234.5, 60000, -0.25, -3, -60000]) {
    const back = THREE.DataUtils.fromHalfFloat(toHalfBits(v));
    if (v === 0) assert.equal(back, 0);
    else assert.ok(Math.abs(back - v) / Math.abs(v) < 1.1e-3, `${v} -> ${back}`);
  }
});

test('cache key: version, sizes, backend and a data hash', () => {
  const k = cache.cacheKey('harbour-night', 1024, 256, 2, 8, 'webgpu', '{"a":1}');
  assert.ok(k.startsWith(`v${cache.WORLD_CACHE_VERSION}/harbour-night/1024/256/2/8/webgpu/`));
  assert.notEqual(k, cache.cacheKey('harbour-night', 1024, 256, 2, 8, 'webgpu', '{"a":2}'), 'edited data, new key');
  assert.notEqual(k, cache.cacheKey('harbour-night', 512, 128, 2, 4, 'webgpu', '{"a":1}'), 'other tier, new key');
  assert.notEqual(k, cache.cacheKey('harbour-night', 1024, 256, 2, 8, 'webgl2', '{"a":1}'), 'other backend, new key');
  assert.equal(cache.hashString('abc'), cache.hashString('abc'));
});

test('cache records are only used with the sizes the key promises', () => {
  const shape = { face: 4, lutBytes: 16, envW: 3, envH: 2 };
  const rec = {
    key: 'k',
    savedAt: 1,
    face: 4,
    faces: new ArrayBuffer(6 * 4 * 4 * 4),
    lut: new ArrayBuffer(16),
    env: new ArrayBuffer(3 * 2 * 4),
    envW: 3,
    envH: 2,
    lm: new ArrayBuffer(2 * 2 * 4 * 4 * 2),
    lmRes: 2,
    lmRect: [0, 0, 1, 1],
    lmLayers: [0, 3000],
  };
  assert.equal(cache.validBake(rec, 'k', shape), true);
  assert.equal(cache.validBake({ ...rec, lm: null }, 'k', shape), true, 'a skyline without lamps');
  assert.equal(cache.validBake(rec, 'other', shape), false);
  assert.equal(cache.validBake({ ...rec, faces: new ArrayBuffer(10) }, 'k', shape), false);
  assert.equal(cache.validBake({ ...rec, env: new ArrayBuffer(4) }, 'k', shape), false);
  assert.equal(cache.validBake({ ...rec, lmRes: 3 }, 'k', shape), false);
  assert.equal(cache.validBake(null, 'k', shape), false);
});

test('without IndexedDB the cache reports "not cached" at once', async () => {
  assert.equal(globalThis.indexedDB, undefined);
  assert.equal(await cache.openCache(), false);
  assert.equal(await cache.readBake('k', { face: 4, lutBytes: 16, envW: 3, envH: 2 }), null);
  assert.equal(await cache.writeBake({ key: 'k' }), false);
});

test('copyRows: drops the row padding of a readback and can reverse the rows', () => {
  // 2 x 3 texels of 1 byte, rows padded to 4 bytes
  const src = new Uint8Array([1, 2, 0, 0, 3, 4, 0, 0, 5, 6]);
  const out = new Uint8Array(6);
  cache.copyRows(src, 2, 3, 1, out, 0);
  assert.deepEqual([...out], [1, 2, 3, 4, 5, 6]);
  cache.copyRows(src, 2, 3, 1, out, 0, true);
  assert.deepEqual([...out], [5, 6, 3, 4, 1, 2]);
  const tight = new Uint8Array([1, 2, 3, 4]);
  const out2 = new Uint8Array(8);
  cache.copyRows(tight, 2, 2, 1, out2, 4, true);
  assert.deepEqual([...out2], [0, 0, 0, 0, 3, 4, 1, 2]);
});

const { createLatestQueue } = await import('../src/render/world/queue.ts');

test('latest-wins queue: an idle request that needs no work never wedges later requests', async () => {
  const ran = [];
  const q = createLatestQueue('a', (x, y) => x === y, async (w) => { ran.push(w); }, { alive: () => true, onError: () => {} });
  await q.request('a');
  assert.deepEqual(ran, ['a']);
  // nothing to do (e.g. a tier switch between two tiers with the same bake sizes)...
  await q.request('a');
  assert.deepEqual(ran, ['a']);
  // ...and the next real change still runs (it used to return the settled loop and do nothing)
  await q.request('b');
  assert.deepEqual(ran, ['a', 'b']);
  assert.equal(q.wanted, 'b');
});

test('latest-wins queue: wishes made during a run collapse to the newest one', async () => {
  const ran = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const q = createLatestQueue('a', (x, y) => x === y, async (w) => { ran.push(w); if (w === 'a') await gate; }, { alive: () => true, onError: () => {} });
  const first = q.request('a');
  const second = q.request('b');
  q.request('c');
  assert.equal(first, second, 'one loop at a time');
  release();
  await first;
  assert.deepEqual(ran, ['a', 'c']);
});

test('latest-wins queue: failures are reported and the loop goes on; a dead owner does nothing', async () => {
  const errs = [];
  const ran = [];
  let alive = true;
  const q = createLatestQueue('a', (x, y) => x === y, (w) => { ran.push(w); if (w === 'a') throw new Error('sync boom'); return Promise.resolve(); }, { alive: () => alive, onError: (e) => errs.push(e.message) });
  await q.request('a');
  assert.deepEqual(errs, ['sync boom']);
  await q.request('b');
  assert.deepEqual(ran, ['a', 'b'], 'a synchronous throw does not wedge the queue');
  alive = false;
  await q.request('c');
  assert.deepEqual(ran, ['a', 'b']);
});

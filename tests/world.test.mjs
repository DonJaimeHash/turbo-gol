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

test('every theme resolves to a world preset; the built ones are their own', () => {
  for (const id of THEME_IDS) assert.ok(['harbour', 'canyon', 'city', 'alpine', 'railyard'].includes(worldPreset(id).skyline), id);
  for (const id of ['harbour-night', 'harbour-day', 'canyon-sunset', 'city-dusk', 'alpine-day', 'railyard-night']) assert.ok(hasWorldPreset(id), id);
  assert.equal(worldPreset('harbour-night').skyline, 'harbour');
  assert.equal(worldPreset('harbour-day').skyline, 'harbour');
  assert.equal(worldPreset('canyon-sunset').skyline, 'canyon');
  assert.equal(worldPreset('city-dusk').skyline, 'city');
  assert.equal(worldPreset('alpine-day').skyline, 'alpine');
  assert.equal(worldPreset('railyard-night').skyline, 'railyard');
  // themes without a preset yet use the default world
  for (const id of THEME_IDS) if (!hasWorldPreset(id)) assert.equal(worldPreset(id), worldPreset('harbour-night'), id);
});

test('world presets hold finite, non-negative radiance and sane ranges', () => {
  for (const id of ['harbour-night', 'harbour-day', 'canyon-sunset', 'city-dusk', 'alpine-day', 'railyard-night']) {
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
    if (p.proxyTop !== undefined) assert.ok(p.proxyTop[0] > 0 && p.proxyTop[1] > p.proxyTop[0], `${id} proxy band`);
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
  for (const id of ['harbour-night', 'harbour-day', 'canyon-sunset', 'city-dusk', 'alpine-day', 'railyard-night']) {
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
  for (const id of ['harbour-day', 'alpine-day']) {
    assert.ok(themeWorld(id).floodlights.every((f) => f.strength === 0), `${id}: floodlights off by day`);
    assert.equal(themeWorld(id).night, false);
    // the main key is the sky's sun (shadows fall away from the disc the player sees)
    const p = worldPreset(id);
    const sun = dirFromAzEl(p.key.az, p.key.el);
    const k = themeWorld(id).keys[0].dir;
    assert.ok(sun[0] * k[0] + sun[1] * k[1] + sun[2] * k[2] > 0.9999, `${id}: keys[0] points at the sun disc`);
  }
  // the city at dusk: the sky still glows (a sun just over the horizon, no moon) but the pitch is
  // floodlit like the night and soaked
  const city = themeWorld('city-dusk');
  assert.equal(city.night, true);
  assert.ok(city.floodlights.every((f) => f.strength === 1), 'all eight heads on');
  assert.ok(city.wetness > themeWorld('harbour-night').wetness, 'wetter than the harbour');
  assert.equal(worldPreset('city-dusk').key.moon, false);
  assert.ok(worldPreset('city-dusk').key.el < 3 && worldPreset('city-dusk').lights > 0 && worldPreset('city-dusk').windows > 0);
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

test('the baked skylines stay under the dome parallax hand-over band (no smeared towers)', async () => {
  const { PROXY_TOP } = await import('../src/render/world/dome.ts');
  const { BAKE_ORIGIN } = await import('../src/render/world/World.ts');
  const { buildCanyon } = await import('../src/render/world/canyon.ts');
  assert.ok(H.SKYLINE_TOP <= PROXY_TOP[0] + BAKE_ORIGIN.y, 'the band starts above the skyline');
  const maxY = (geo) => {
    const p = geo.attributes.position.array;
    let m = -Infinity;
    for (let i = 1; i < p.length; i += 3) m = Math.max(m, p[i]);
    return m;
  };
  const far = H.buildHarbourFar(false);
  assert.ok(maxY(far.geometry) <= H.SKYLINE_TOP, `far harbour top ${maxY(far.geometry).toFixed(0)}`);
  far.geometry.dispose();
  const canyon = buildCanyon(dirFromAzEl(8, 4.5), false);
  assert.ok(maxY(canyon.geometry) <= H.SKYLINE_TOP, `canyon top ${maxY(canyon.geometry).toFixed(0)}`);
  canyon.geometry.dispose();
});

// ---- city-dusk (src/render/world/city.ts)

const C = await import('../src/render/world/city.ts');

test('city live layer: deterministic, inside the live radius, clear of the stadium, towers over the far goal', () => {
  const a = C.buildCityLive();
  const b = C.buildCityLive();
  const pa = a.geometry.attributes.position.array;
  const pb = b.geometry.attributes.position.array;
  assert.equal(pa.length, pb.length);
  assert.ok(pa.every((v, i) => v === pb[i]), 'same seed, same geometry');
  const col = a.geometry.attributes.kcol.array;
  let maxR = 0;
  let farEndTop = -Infinity;
  let spireTop = -Infinity;
  let lowest = Infinity;
  for (let i = 0; i < pa.length / 3; i++) {
    const x = pa[i * 3];
    const y = pa[i * 3 + 1];
    const z = pa[i * 3 + 2];
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z));
    maxR = Math.max(maxR, Math.hypot(x, y - 250, z));
    lowest = Math.min(lowest, y);
    // the stadium and its apron stand on the deck: nothing of the city rises inside their footprint
    if (Math.abs(x) < H.STADIUM_HALF_X - 400 && Math.abs(z) < 6500) assert.ok(y <= H.QUAY + 1, `vertex ${i} (${x}, ${y}, ${z}) inside the stadium`);
    const kind = col[i * 4 + 3];
    if (kind === KIND.TOWER && z > C.DECK_Z && Math.abs(x) < 12000) farEndTop = Math.max(farEndTop, y);
    if (z > 15000 && z < 22000 && Math.abs(x + 5200) < 200) spireTop = Math.max(spireTop, y);
  }
  assert.ok(maxR <= H.LIVE_RADIUS, `live layer within ${H.LIVE_RADIUS} (got ${maxR.toFixed(0)})`);
  assert.ok(lowest >= C.CITY_STREET - 1, 'nothing below the streets');
  assert.ok(farEndTop > 7000, `towers rise well over the boards behind the far goal (top ${farEndTop.toFixed(0)})`);
  assert.ok(spireTop > H.SKYLINE_TOP, `the live spire may rise above the baked skyline's cap (top ${spireTop.toFixed(0)})`);
  for (const name of ['normal', 'kcol', 'kloc', 'kdat']) assert.ok(a.geometry.attributes[name].array.every(Number.isFinite), name);
  // the same vertex layout as the harbour's live layer: World.ts swaps the geometry, the pipeline stays
  const h = H.buildHarbourLive();
  assert.deepEqual(Object.keys(a.geometry.attributes).sort(), Object.keys(h.geometry.attributes).sort());
  for (const name of Object.keys(h.geometry.attributes)) assert.equal(a.geometry.attributes[name].itemSize, h.geometry.attributes[name].itemSize, name);
  assert.equal(a.geometry.index.array.constructor, h.geometry.index.array.constructor, 'same index format');
  assert.ok(a.stats.triangles <= h.stats.triangles, `no more triangles than the harbour's live layer (${a.stats.triangles} vs ${h.stats.triangles})`);
  // lamps: the deck poles and the street lamps, all inside the live area, lighting downward
  assert.ok(a.lamps.length > 50);
  for (const L of a.lamps) assert.ok(Math.hypot(L.pos[0], L.pos[2]) < H.LIVE_RADIUS && L.down === 1 && finite3(L.color));
  a.geometry.dispose();
  b.geometry.dispose();
  h.geometry.dispose();
});

test('city far bake: under the dome band, deterministic lamps (none: no light map), a dry run counts the same parts', () => {
  const full = C.buildCityFar(false);
  const dry = C.buildCityFar(true);
  assert.equal(dry.geometry, null);
  assert.deepEqual(dry.lamps, full.lamps);
  assert.equal(dry.stats.parts, full.stats.parts);
  assert.equal(full.geometry.attributes.position.count, full.stats.verts);
  const p = full.geometry.attributes.position.array;
  let top = -Infinity;
  for (let i = 1; i < p.length; i += 3) top = Math.max(top, p[i]);
  assert.ok(top <= H.SKYLINE_TOP, `far city top ${top.toFixed(0)}`);
  assert.ok(full.geometry.attributes.kdat.array.every(Number.isFinite));
  full.geometry.dispose();
});

test('city patterns: seeds carry the facade style and the crown as the shader decodes them (float32)', () => {
  for (let i = 0; i < 400; i++) {
    const r = (i + 0.5) / 400;
    for (const style of [C.TOWER_STYLE.OFFICE, C.TOWER_STYLE.RESIDENTIAL, C.TOWER_STYLE.DARK]) {
      const s = Math.fround(C.towerSeed(style, r));
      assert.equal(Math.floor(Math.fround(s * 3)), style, `style of seed ${s}`);
      const f = Math.fround(s * Math.fround(C.CROWN_K));
      assert.equal(C.crownOf(s), f - Math.floor(f) >= C.CROWN_MIN);
    }
  }
  // the bay lines the DECK pattern draws match the parked cars' rows, on the deck, past the apron
  assert.equal(C.BAY_X % C.BAY_W, 0, 'bays start on a line');
  assert.ok(C.ROW_Z0 - C.ROW_HALF > 6500, 'first row past the stadium apron');
  assert.ok(C.ROW_Z0 + (C.ROWS - 1) * C.ROW_PITCH + C.ROW_HALF < C.DECK_Z, 'last row on the deck');
  assert.ok(C.DECK_SEED >= 0.5 && C.STREET_SEED < 0.5);
  // the light map's two layers are the street and the deck; the dome's floor for the city is the street
  assert.deepEqual([...C.CITY_LIGHT_LAYERS], [C.CITY_STREET, H.QUAY]);
});

test('city parallax proxy: its band starts no lower than the default one and stays over the baked skyline', async () => {
  const { PROXY_TOP } = await import('../src/render/world/dome.ts');
  const { BAKE_ORIGIN } = await import('../src/render/world/World.ts');
  assert.ok(C.CITY_PROXY_TOP[0] >= PROXY_TOP[0] && C.CITY_PROXY_TOP[1] > C.CITY_PROXY_TOP[0]);
  assert.ok(H.SKYLINE_TOP <= C.CITY_PROXY_TOP[0] + BAKE_ORIGIN.y);
  assert.ok(C.CITY_PROXY_MAX_R > H.LIVE_RADIUS, 'the proxy stays behind the live layer');
});

// ---------------------------------------------------------------------------------- alpine valley

const AL = await import('../src/render/world/alpine.ts');

test('alpine live layer: deterministic, inside its radius, clear of the stadium, pines over the boards', () => {
  const a = AL.buildAlpineLive();
  const b = AL.buildAlpineLive();
  const pa = a.geometry.attributes.position.array;
  const pb = b.geometry.attributes.position.array;
  assert.equal(pa.length, pb.length);
  assert.ok(pa.every((v, i) => v === pb[i]), 'same seed, same geometry');
  // the harbour's attribute layout exactly: the live mesh swaps geometries without a new pipeline
  const h = H.buildHarbourLive();
  for (const name of ['position', 'normal', 'kcol', 'kloc', 'kdat']) {
    assert.equal(a.geometry.attributes[name].itemSize, h.geometry.attributes[name].itemSize, name);
    assert.equal(a.geometry.attributes[name].array.constructor, h.geometry.attributes[name].array.constructor, name);
    assert.ok(a.geometry.attributes[name].array.every(Number.isFinite), `${name} finite`);
  }
  assert.equal(a.geometry.index.array.constructor, h.geometry.index.array.constructor, 'index type');
  h.geometry.dispose();
  const col = a.geometry.attributes.kcol.array;
  let maxR = 0;
  let endTreeTop = -Infinity;
  for (let i = 0; i < pa.length / 3; i++) {
    const x = pa[i * 3];
    const y = pa[i * 3 + 1];
    const z = pa[i * 3 + 2];
    maxR = Math.max(maxR, Math.hypot(x, y - 250, z));
    if (Math.abs(x) < H.STADIUM_HALF_X && Math.abs(z) < H.STADIUM_HALF_Z) assert.ok(y <= H.QUAY + 1, `vertex ${i} (${x}, ${y}, ${z}) inside the stadium`);
    const kind = col[i * 4 + 3];
    assert.ok(kind === KIND.FOLIAGE || kind === KIND.MEADOW, `kind ${kind}`);
    if (kind === KIND.FOLIAGE && z > 8000 && Math.abs(x) < 6000) endTreeTop = Math.max(endTreeTop, y);
  }
  assert.ok(maxR <= H.LIVE_RADIUS, `live layer within ${H.LIVE_RADIUS} (got ${maxR.toFixed(0)})`);
  assert.ok(endTreeTop > 900 + 250, `pines rise above the boards behind the red goal (top ${endTreeTop.toFixed(0)})`);
  assert.ok(a.stats.trees > 800, `a forest (${a.stats.trees} pines)`);
  assert.ok(a.stats.triangles < 110000, `live triangles ${a.stats.triangles}`);
  assert.deepEqual(a.lamps, [], 'no lamps by day: the light map stays empty');
  a.geometry.dispose();
  b.geometry.dispose();
});

test('alpine terrain: flat under the stadium, the live edge sits on the baked land, a crest hides the seam', () => {
  // flat floor under the stadium footprint (the apron and the pitch lie on it)
  for (const [x, z] of [[0, 0], [7900, 7500], [-7900, -7500], [8000, 0], [0, -7600]]) assert.equal(AL.valleyHeight(x, z), AL.ALPINE_GROUND);
  // the bake continues the live terrain exactly up to the crest
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    const x = Math.sin(a) * (AL.LIVE_EDGE - 1);
    const z = Math.cos(a) * (AL.LIVE_EDGE - 1);
    assert.equal(AL.terrainHeight(x, z), AL.valleyHeight(x, z));
  }
  // the live edge is a ridge: along every radial line the baked land behind it drops first
  for (let k = 0; k < 360; k++) {
    const a = (k / 360) * Math.PI * 2;
    const crest = AL.terrainHeight(Math.sin(a) * AL.LIVE_EDGE, Math.cos(a) * AL.LIVE_EDGE);
    for (let r = AL.LIVE_EDGE + 300; r < AL.LIVE_EDGE + 9000; r += 300) assert.ok(AL.terrainHeight(Math.sin(a) * r, Math.cos(a) * r) < crest + 1, `az ${k}: land rises right behind the crest at r ${r}`);
  }
  // so from cameras near the pitch (chase and kickoff heights, anywhere on the field), the baked
  // land just behind the crest stays under the line of sight over the live crest (the live edge
  // never meets its baked continuation in view; only a camera high over a low end crest sees
  // past it, where the crest's pines stand in front of the seam)
  const cams = [[0, 250, 0], [4400, 300, 5600], [-4400, 300, -5600], [-4400, 30, 5600], [3000, 600, -2000]];
  for (const [cx, cy, cz] of cams) {
    for (let k = 0; k < 96; k++) {
      const a = (k / 96) * Math.PI * 2;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      // distance along the ray to the live edge (camera inside the circle)
      const b = cx * dx + cz * dz;
      const c = cx * cx + cz * cz - AL.LIVE_EDGE * AL.LIVE_EDGE;
      const tEdge = -b + Math.sqrt(b * b - c);
      // rays that run into a side stand (|x| 5150..7610, |z| < 6300, up to ~2860) are hidden anyway
      let blocked = false;
      for (let t = 0; t < 12000 && !blocked; t += 100) blocked = Math.abs(cx + dx * t) > 5150 && Math.abs(cx + dx * t) < 7610 && Math.abs(cz + dz * t) < 6300;
      if (blocked) continue;
      const slopeAt = (t) => (AL.terrainHeight(cx + dx * t, cz + dz * t) - cy) / t;
      const crest = slopeAt(tEdge - 50);
      for (let t = tEdge + 600; t < tEdge + 9000; t += 400) assert.ok(slopeAt(t) < crest + 1e-3, `camera (${cx}, ${cy}, ${cz}) az ${k}: land behind the crest in view at +${(t - tEdge).toFixed(0)}`);
    }
  }
});

test('alpine far bake: under its own parallax band, real mountains, finite data', async () => {
  const { BAKE_ORIGIN } = await import('../src/render/world/World.ts');
  const p = worldPreset('alpine-day');
  assert.ok(p.proxyTop !== undefined, 'the alpine preset raises the band');
  assert.ok(AL.ALPINE_TOP <= p.proxyTop[0] + BAKE_ORIGIN.y, 'the band starts above the mountains');
  const sun = dirFromAzEl(p.key.az, p.key.el);
  const far = AL.buildAlpineFar(sun, false);
  const pos = far.geometry.attributes.position.array;
  let top = -Infinity;
  let aheadTop = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    top = Math.max(top, pos[i + 1]);
    // the massif ahead of the blue kickoff camera (+z) rises well above the live crest
    if (pos[i + 2] > 40000 && Math.abs(pos[i]) < pos[i + 2] * 0.5) aheadTop = Math.max(aheadTop, pos[i + 1]);
  }
  assert.ok(top <= AL.ALPINE_TOP, `top ${top.toFixed(0)} <= ${AL.ALPINE_TOP}`);
  assert.ok(aheadTop > 15000, `a massif ahead (top ${aheadTop.toFixed(0)})`);
  const kd = far.geometry.attributes.kdat.array;
  for (let i = 0; i < kd.length; i += 4) {
    assert.ok(kd[i] >= 0 && kd[i] <= 1 && kd[i + 1] > 0 && kd[i + 1] <= 1, 'sun visibility and occlusion in range');
  }
  for (const name of ['position', 'normal', 'kcol', 'kloc', 'kdat']) assert.ok(far.geometry.attributes[name].array.every(Number.isFinite), name);
  assert.ok(far.geometry.attributes.kcol.array.every((v, i) => i % 4 !== 3 || v === KIND.ALPINE), 'one pattern kind');
  // crests are at least a cell wide: no vertex on the mountains stands as a spike above both its
  // ring neighbours (a crest thinner than the rows, crossing them obliquely, was baked as a comb of
  // one-ring teeth along the ridge line; that mesh had ~1.6 % such vertices above 8000)
  const r0 = Math.hypot(pos[0], pos[2]);
  let nt = 1;
  while (Math.abs(Math.hypot(pos[nt * 3], pos[nt * 3 + 2]) - r0) < 1) nt++;
  const nr = pos.length / 3 / nt;
  assert.ok(Number.isInteger(nr) && nr > 100, `a polar grid (${nt} columns, ${nr} rings)`);
  const hAt = (ri, ti) => pos[(ri * nt + ((ti + nt) % nt)) * 3 + 1];
  let high = 0;
  let spikes = 0;
  for (let ri = 1; ri < nr - 1; ri++) {
    for (let ti = 0; ti < nt; ti++) {
      const h = hAt(ri, ti);
      if (h < 8000) continue;
      high++;
      if (h - Math.max(hAt(ri - 1, ti), hAt(ri + 1, ti)) > 600 && h > Math.max(hAt(ri, ti - 1), hAt(ri, ti + 1))) spikes++;
    }
  }
  assert.ok(spikes < high * 0.004, `ridge spikes across the rings: ${spikes} of ${high} vertices`);
  // the bake builds it in slices (World.ts farMesh): the same geometry, bit for bit
  let yields = 0;
  const sliced = AL.buildAlpineFarSliced(sun, 0);
  const counting = setInterval(() => yields++, 0);
  const s = await sliced;
  clearInterval(counting);
  for (const name of ['position', 'normal', 'kcol', 'kloc', 'kdat']) {
    const a = far.geometry.attributes[name].array;
    const b = s.geometry.attributes[name].array;
    assert.equal(a.length, b.length, name);
    assert.ok(a.every((v, i) => Object.is(v, b[i])), `${name}: sliced build differs`);
  }
  assert.ok(far.geometry.index.array.every((v, i) => v === s.geometry.index.array[i]), 'index');
  assert.ok(yields > 0, 'the sliced build gives the thread back');
  s.geometry.dispose();
  far.geometry.dispose();
  const dry = AL.buildAlpineFar(sun, true);
  assert.equal(dry.geometry, null);
  assert.deepEqual(dry.lamps, []);
});

test('alpine vertexNormals: three computeVertexNormals bit for bit (raw arrays, no BufferGeometry)', () => {
  // a jagged indexed mesh: a height grid with shared vertices, plus one overlapping triangle
  const n = 24;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3;
      pos[k] = i * 137.5 + (j % 3) * 11;
      pos[k + 1] = Math.abs(Math.sin(i * 1.7) * Math.cos(j * 2.3)) * 900 + i * j;
      pos[k + 2] = j * 129.25;
    }
  }
  const idx = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
  }
  idx.push(0, 1, 2);
  const index = new Uint32Array(idx);
  const ref = new THREE.BufferGeometry();
  ref.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  ref.setIndex(new THREE.BufferAttribute(index, 1));
  ref.computeVertexNormals();
  const gen = AL.vertexNormals(pos, index);
  let r = gen.next();
  while (r.done !== true) r = gen.next();
  const want = ref.attributes.normal.array;
  assert.equal(r.value.length, want.length);
  assert.ok(r.value.every((v, i) => Object.is(v, want[i])), 'same bits as three');
  ref.dispose();
});

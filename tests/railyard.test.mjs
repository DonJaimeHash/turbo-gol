// The railyard theme ('railyard-night', world/railyard.ts) and the canyon lift (world/canyon.ts),
// CPU side (node --test tests/railyard.test.mjs): the theme's own entries in every per-theme table,
// the live layer's bounds, budget and composition, the dry far run, the baked skyline under the
// dome's parallax band, the canyon's wall distance and the sun's notch. Shaders and the bake need a
// GPU: they are checked in the running game (docs/visuals/REWORK.md, #nancheck, pipeline counts).
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

const { themeWorld, DEFAULT_THEME } = await import('../src/render/theme.ts');
const { worldPreset, hasWorldPreset, dirFromAzEl } = await import('../src/render/world/presets.ts');
const { KIND } = await import('../src/render/world/geo.ts');
const H = await import('../src/render/world/harbour.ts');
const Y = await import('../src/render/world/railyard.ts');
const { buildCanyon, NEAR_WALL } = await import('../src/render/world/canyon.ts');
const { PROXY_TOP } = await import('../src/render/world/dome.ts');
const { BAKE_ORIGIN } = await import('../src/render/world/World.ts');
const { stadiumTheme } = await import('../src/render/stadium/palette.ts');
const { turfLook } = await import('../src/render/turf/turfTheme.ts');

const finite3 = (c) => c.length === 3 && c.every((v) => Number.isFinite(v) && v >= 0);
const unitLen = (d) => Math.hypot(...d);

test('railyard-night has its own entry in every per-theme table (world, preset, stadium, turf)', () => {
  const w = themeWorld('railyard-night');
  assert.equal(w.id, 'railyard-night', 'its own ThemeWorld, not the fallback');
  assert.equal(w.night, true);
  const night = themeWorld(DEFAULT_THEME);
  assert.equal(w.keys.length, 2);
  assert.equal(w.floodlights.length, night.floodlights.length, 'same floodlight slots: same light count, no recompile');
  for (const k of w.keys) {
    assert.ok(Math.abs(unitLen(k.dir) - 1) < 1e-9 && k.dir[1] > 0, 'keys from above, unit');
    assert.ok(finite3(k.color) && k.intensity > 0);
  }
  assert.ok(w.floodlights.every((f) => f.strength > 0), 'the towers burn at night');
  assert.ok(w.wetness > 0.4 && w.wetness <= 1, 'a wet night pitch');
  assert.ok(w.fog.density > 0 && finite3(w.fog.color) && w.fill.env > 0);
  assert.ok(['neutral', 'aces', 'agx'].includes(w.toneMapping));

  assert.ok(hasWorldPreset('railyard-night'));
  const p = worldPreset('railyard-night');
  assert.equal(p.skyline, 'railyard');
  for (const c of [p.zenith, p.mid, p.horizon, p.glow.color, p.key.color, p.key.light, p.ambSky, p.ambGround, p.envTurf]) assert.ok(finite3(c), `colour ${c}`);
  for (const cl of [p.clouds, p.cirrus]) assert.ok(cl.cover >= 0 && cl.cover <= 1 && cl.alpha >= 0 && cl.alpha <= 1 && cl.height > 0 && cl.scale > 0 && cl.stretch > 0);
  assert.ok(p.lights > 0 && p.windows > 0, 'lamps and lit windows at night');
  // an orange city glow on the horizon behind the far goal, a violet zenith
  assert.ok(p.glow.color[0] > p.glow.color[2] * 4 && Math.abs(p.glow.az) < 20, 'orange glow toward +z');
  assert.ok(p.zenith[2] > p.zenith[0], 'violet-blue zenith');

  assert.notEqual(stadiumTheme('railyard-night'), stadiumTheme(DEFAULT_THEME), 'its own stadium palette');
  assert.ok(turfLook('railyard-night').pools > 0, 'night turf with floodlight pools');
});

test('railyard kinds are unique pattern ids', () => {
  const ids = Object.values(KIND);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(KIND.BRICK !== undefined && KIND.RAILBED !== undefined);
});

test('railyard live layer: deterministic, inside its radius, clear of the stadium, lighter than the harbour', () => {
  const a = Y.buildRailyardLive();
  const b = Y.buildRailyardLive();
  const pa = a.geometry.attributes.position.array;
  const pb = b.geometry.attributes.position.array;
  assert.equal(pa.length, pb.length);
  assert.ok(pa.every((v, i) => v === pb[i]), 'same seed, same geometry');
  const col = a.geometry.attributes.kcol.array;
  const dat = a.geometry.attributes.kdat.array;
  let maxR = 0;
  let farTop = -Infinity;
  let gantryTop = -Infinity;
  const kinds = new Set();
  for (let i = 0; i < pa.length / 3; i++) {
    const x = pa[i * 3];
    const y = pa[i * 3 + 1];
    const z = pa[i * 3 + 2];
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z));
    maxR = Math.max(maxR, Math.hypot(x, y - 250, z));
    if (Math.abs(x) < H.STADIUM_HALF_X && Math.abs(z) < H.STADIUM_HALF_Z) assert.ok(y <= H.QUAY + 1, `vertex ${i} (${x}, ${y}, ${z}) inside the stadium`);
    const kind = col[i * 4 + 3];
    kinds.add(kind);
    // what the kickoff camera sees through the far end: |x| within the opening, beyond the goal
    if (z > 8000 && z < 16000 && Math.abs(x) < 6500) farTop = Math.max(farTop, y);
    if (kind === KIND.STEEL && Math.abs(z - Y.GANTRY_Z) < 400 && Math.abs(x) < 3000) gantryTop = Math.max(gantryTop, y);
    if (kind === KIND.BRICK) {
      const style = Math.floor(dat[i * 4 + 3]);
      assert.ok(style >= 0 && style <= 4, `brick style ${style}`);
    }
  }
  assert.ok(maxR <= H.LIVE_RADIUS, `live layer within ${H.LIVE_RADIUS} (got ${maxR.toFixed(0)})`);
  assert.ok(farTop >= Y.CHIMNEY_TOP, `the far end rises well above y = 900 (top ${farTop.toFixed(0)})`);
  assert.ok(gantryTop >= Y.GANTRY_TOP - 50, `the gantry spans the far end (top ${gantryTop.toFixed(0)})`);
  for (const k of [KIND.BRICK, KIND.RAILBED, KIND.CONTAINER, KIND.WINDOWS, KIND.LAMP, KIND.STEEL]) assert.ok(kinds.has(k), `kind ${k} used`);
  for (const name of ['normal', 'kcol', 'kloc', 'kdat']) assert.ok(a.geometry.attributes[name].array.every(Number.isFinite), name);
  // the same attribute layout as the harbour's live layer: the world swaps geometries, same pipeline
  const h = H.buildHarbourLive();
  assert.deepEqual(Object.keys(a.geometry.attributes).sort(), Object.keys(h.geometry.attributes).sort());
  for (const name of Object.keys(h.geometry.attributes)) assert.equal(a.geometry.attributes[name].itemSize, h.geometry.attributes[name].itemSize, name);
  assert.equal(a.geometry.index.array.constructor, h.geometry.index.array.constructor, 'same index type');
  assert.ok(a.stats.triangles <= h.stats.triangles, `no more live triangles than the harbour (${a.stats.triangles} vs ${h.stats.triangles})`);
  assert.ok(a.lamps.length > 20 && a.lamps.every((l) => finite3(l.color) && l.range > 0));
  for (const g of [a.geometry, b.geometry, h.geometry]) g.dispose();
});

test('a dry far-railyard run collects exactly the lamps of a full run; the bake stays under the parallax band', () => {
  const dry = Y.buildRailyardFar(true);
  const full = Y.buildRailyardFar(false);
  assert.equal(dry.geometry, null);
  assert.deepEqual(dry.lamps, full.lamps);
  assert.equal(dry.stats.parts, full.stats.parts);
  assert.equal(full.geometry.attributes.position.count, full.stats.verts);
  assert.ok(H.SKYLINE_TOP <= PROXY_TOP[0] + BAKE_ORIGIN.y);
  const p = full.geometry.attributes.position.array;
  let maxY = -Infinity;
  for (let i = 1; i < p.length; i += 3) maxY = Math.max(maxY, p[i]);
  assert.ok(maxY <= H.SKYLINE_TOP, `far railyard top ${maxY.toFixed(0)}`);
  assert.ok(p.every(Number.isFinite));
  full.geometry.dispose();
});

test('canyon: its own sunset (sun right of the far goal, key light on it), walls kept off the arena, the sun in a notch', () => {
  const w = themeWorld('canyon-sunset');
  const p = worldPreset('canyon-sunset');
  assert.equal(w.id, 'canyon-sunset');
  assert.equal(p.skyline, 'canyon');
  assert.ok(p.key.az > 0 && p.key.az < 20 && p.key.el > 0 && p.key.el < 10, 'a low sun right of the far goal');
  // keys[0] stands for the sun: the same azimuth, a little higher
  const sun = dirFromAzEl(p.key.az, p.key.el);
  const k = w.keys[0].dir;
  const azK = Math.atan2(-k[0], k[2]) * (180 / Math.PI);
  assert.ok(Math.abs(azK - p.key.az) < 1, `key azimuth ${azK.toFixed(2)} vs sun ${p.key.az}`);
  assert.ok(k[1] > sun[1], 'the key sits above the disc');
  assert.notEqual(stadiumTheme('canyon-sunset'), stadiumTheme(DEFAULT_THEME), 'its own stadium palette');

  const c = buildCanyon(sun, false);
  const pos = c.geometry.attributes.position.array;
  let maxY = -Infinity;
  let horizon = -Infinity;
  const sunAz = Math.atan2(sun[0], sun[2]);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = pos[i + 1];
    const z = pos[i + 2];
    maxY = Math.max(maxY, y);
    // beside the arena no wall stands nearer than NEAR_WALL minus the meander and the talus
    if (Math.abs(z) < 8000 && y > 1500) assert.ok(Math.abs(x) > NEAR_WALL - 2400, `wall at (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`);
    // the terrain's elevation seen from the bake origin in the sun's azimuth
    const r = Math.hypot(x, z);
    let d = Math.atan2(x, z) - sunAz;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (r > 8000 && Math.abs(d) < 0.01) horizon = Math.max(horizon, Math.atan2(y - BAKE_ORIGIN.y, r));
  }
  assert.ok(maxY <= H.SKYLINE_TOP, `canyon top ${maxY.toFixed(0)}`);
  assert.ok(horizon < Math.asin(sun[1]), `the sun clears the horizon (terrain ${(horizon * 57.3).toFixed(2)} deg, sun ${p.key.el} deg)`);
  c.geometry.dispose();
});

// Device capabilities and the tier safety net (node --test tests/tier-safety.test.mjs): the pure
// tier adjustment of capabilities.ts (what a WebGPU compatibility-mode phone, a WebGL2 context
// without a multisampled canvas or a small texture limit runs of each tier), readCapabilities on
// fake backends, the remembered ceilings and the fallback decisions of tierGuard.ts (one tier down,
// a window after each switch, never a loop), and the glow-tag switch of materials.ts that keeps
// MRT outputs off the direct tier.
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

const { QUALITIES, tier } = await import('../src/render/quality.ts');
const { FULL_CAPABILITIES, adjustTier, tierChanges, readCapabilities } = await import('../src/render/capabilities.ts');
const { TierGuard, readCeiling, writeCeiling, CEILING_KEY, CEILING_TTL_MS, FALLBACK_WINDOW_MS, MAX_CEILINGS } = await import('../src/render/tierGuard.ts');

const COMPAT = { ...FULL_CAPABILITIES, compatibilityMode: true, msaaHdr: false, maxTextureSize: 4096, maxColorAttachments: 4, gpu: 'webgpu-compat:arm/midgard' };

test('a device that can do everything runs every tier as the table says (same object)', () => {
  for (const q of QUALITIES) {
    assert.equal(adjustTier(tier(q), FULL_CAPABILITIES), tier(q), q);
    assert.deepEqual(tierChanges(tier(q), adjustTier(tier(q), FULL_CAPABILITIES)), [], q);
  }
});

test('WebGPU compatibility mode: the post tiers take FXAA (no multisampled rgba16float), low keeps the canvas MSAA', () => {
  const low = adjustTier(tier('low'), COMPAT);
  assert.equal(low.output, 'direct');
  assert.equal(low.msaa, 4, 'the 8-bit canvas multisamples in compatibility mode');
  for (const q of ['high', 'ultra']) {
    const s = adjustTier(tier(q), COMPAT);
    assert.equal(s.msaa, 0, `${q}: FXAA`);
    assert.equal(s.bloom, true, `${q}: bloom stays (4 colour targets)`);
    assert.equal(s.shadowMapSize, tier(q).shadowMapSize, `${q}: 4096 fits`);
    assert.deepEqual(tierChanges(tier(q), s), ['msaa 4 -> 0'], q);
  }
  // Everything else is the table's.
  const ultra = adjustTier(tier('ultra'), COMPAT);
  for (const k of ['gtao', 'ssr', 'lensFlare', 'grassBlades', 'beamCones']) assert.equal(ultra[k], true, k);
});

test('no multisampled canvas: the direct tier runs without anti-aliasing; small limits shrink the maps', () => {
  const noAa = { ...FULL_CAPABILITIES, backend: 'webgl2', msaaCanvas: false };
  assert.equal(adjustTier(tier('low'), noAa).msaa, 0);
  assert.equal(adjustTier(tier('high'), noAa).msaa, 4, 'the post tiers do not need the canvas');
  const tiny = { ...FULL_CAPABILITIES, maxTextureSize: 3000, maxColorAttachments: 1 };
  const ultra = adjustTier(tier('ultra'), tiny);
  assert.equal(ultra.shadowMapSize, 2048, 'a power of two under the limit');
  assert.equal(ultra.skyCubeSize, 1024);
  assert.equal(ultra.bloom, false, 'one colour target: no glow target');
  assert.equal(ultra.lensFlare, false, 'the glare reads the bloom');
  assert.deepEqual(tierChanges(tier('ultra'), ultra), ['bloom true -> false', 'shadowMapSize 4096 -> 2048', 'lensFlare true -> false']);
});

test('readCapabilities: WebGPU core, compatibility mode, no float32-filterable', () => {
  const device = (features, limits = {}) => ({
    features: new Set(features),
    limits: { maxTextureDimension2D: 8192, maxColorAttachments: 8, ...limits },
    adapterInfo: { vendor: 'apple', architecture: 'common-3', device: '', description: '' },
  });
  const core = readCapabilities({ backend: { isWebGPUBackend: true, compatibilityMode: false, device: device(['float32-filterable', 'core-features-and-limits']) } });
  assert.equal(core.backend, 'webgpu');
  assert.equal(core.msaaHdr, true);
  assert.equal(core.msaaCanvas, true);
  assert.equal(core.float32Filterable, true);
  assert.equal(core.gpu, 'webgpu:apple/common-3');
  const iphone = readCapabilities({ backend: { isWebGPUBackend: true, compatibilityMode: false, device: device(['core-features-and-limits']) } });
  assert.equal(iphone.float32Filterable, false);
  assert.equal(iphone.msaaHdr, true);
  assert.equal(iphone.gpu, 'webgpu-nof32f:apple/common-3', 'its own ceiling key');
  const compat = readCapabilities({ backend: { isWebGPUBackend: true, compatibilityMode: true, device: device([], { maxTextureDimension2D: 4096, maxColorAttachments: 4 }) } });
  assert.equal(compat.compatibilityMode, true);
  assert.equal(compat.msaaHdr, false);
  assert.equal(compat.msaaCanvas, true);
  assert.equal(compat.maxTextureSize, 4096);
  assert.equal(compat.maxColorAttachments, 4);
  assert.ok(compat.gpu.startsWith('webgpu-compat'));
});

test('readCapabilities: WebGL2 reads the half-float MSAA sample counts and the context antialias', () => {
  const fakeGl = (exts, samples, antialias) => ({
    RENDERBUFFER: 1, RGBA16F: 2, SAMPLES: 3, MAX_TEXTURE_SIZE: 4, MAX_RENDERBUFFER_SIZE: 5, MAX_DRAW_BUFFERS: 6, VENDOR: 7, RENDERER: 8,
    getExtension: (n) => (exts.includes(n) ? {} : null),
    getInternalformatParameter: () => (samples === null ? null : Int32Array.from(samples)),
    getParameter: (p) => ({ 4: 16384, 5: 8192, 6: 8, 7: 'v', 8: 'r' })[p],
    getContextAttributes: () => ({ antialias }),
  });
  const desktop = readCapabilities({ backend: { gl: fakeGl(['EXT_color_buffer_float', 'OES_texture_float_linear'], [8, 4, 2], true) } });
  assert.equal(desktop.backend, 'webgl2');
  assert.equal(desktop.msaaHdr, true);
  assert.equal(desktop.msaaCanvas, true);
  assert.equal(desktop.float32Filterable, true);
  assert.equal(desktop.maxTextureSize, 8192, 'the smaller of the texture and renderbuffer limits');
  assert.equal(desktop.gpu, 'webgl2:v/r');
  const phone = readCapabilities({ backend: { gl: fakeGl(['EXT_color_buffer_half_float'], [2], false) } });
  assert.equal(phone.msaaHdr, false, 'no 4x RGBA16F');
  assert.equal(phone.msaaCanvas, false);
  assert.equal(phone.float32Filterable, false);
  const none = readCapabilities({ backend: { gl: fakeGl([], [4], true) } });
  assert.equal(none.msaaHdr, false, 'no renderable half float at all');
});

/** A localStorage stand-in. */
function store() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

test('ceilings: per GPU, only ever lowered while valid, expired after the TTL, at most MAX_CEILINGS', () => {
  const s = store();
  const t0 = 1_000_000;
  assert.equal(readCeiling(s, 'gpu-a', t0), null);
  writeCeiling(s, 'gpu-a', 'high', t0);
  assert.equal(readCeiling(s, 'gpu-a', t0 + 1), 'high');
  assert.equal(readCeiling(s, 'gpu-b', t0 + 1), null, 'another GPU');
  writeCeiling(s, 'gpu-a', 'ultra', t0 + 2);
  assert.equal(readCeiling(s, 'gpu-a', t0 + 3), 'high', 'a valid lower record stays');
  writeCeiling(s, 'gpu-a', 'low', t0 + 4);
  assert.equal(readCeiling(s, 'gpu-a', t0 + 5), 'low');
  assert.equal(readCeiling(s, 'gpu-a', t0 + 4 + CEILING_TTL_MS + 1), null, 'expired');
  writeCeiling(s, 'gpu-a', 'high', t0 + 4 + CEILING_TTL_MS + 1);
  assert.equal(readCeiling(s, 'gpu-a', t0 + 4 + CEILING_TTL_MS + 2), 'high', 'an expired record is replaced');
  for (let i = 0; i < MAX_CEILINGS + 3; i++) writeCeiling(s, `gpu-${i}`, 'low', t0 + 10 + i);
  assert.equal(Object.keys(JSON.parse(s.getItem(CEILING_KEY))).length, MAX_CEILINGS);
  assert.equal(readCeiling(s, `gpu-${MAX_CEILINGS + 2}`, t0 + 100), 'low', 'the newest stay');
  // Garbage and missing storage never throw.
  s.setItem(CEILING_KEY, '{not json');
  assert.equal(readCeiling(s, 'gpu-a', t0), null);
  s.setItem(CEILING_KEY, JSON.stringify({ x: { q: 'medium', at: 1 }, y: null }));
  assert.equal(readCeiling(s, 'x', 2), null);
  assert.equal(readCeiling(null, 'gpu-a', t0), null);
  writeCeiling(null, 'gpu-a', 'low', t0);
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  writeCeiling(full, 'gpu-a', 'low', t0);
});

test('the guard falls one tier per failure, within the window, never twice at once, never below low', () => {
  let now = 0;
  const guard = new TierGuard(() => now);
  guard.arm();
  now = 100;
  assert.deepEqual(guard.onFailure('error', 'ultra'), { from: 'ultra', to: 'high', reload: false });
  assert.equal(guard.fallingBack, true);
  assert.equal(guard.onFailure('error', 'ultra'), null, 'the rest of the burst is the fallback\'s');
  assert.equal(guard.onFailure('lost', 'ultra'), null);
  now = 2000;
  guard.arm(); // the fallback switch to high is done
  assert.equal(guard.fallingBack, false);
  now = 2500;
  assert.deepEqual(guard.onFailure('error', 'high'), { from: 'high', to: 'low', reload: false });
  now = 4000;
  guard.arm();
  assert.equal(guard.onFailure('error', 'low'), null, 'nothing below low');
  assert.equal(guard.onFailure('lost', 'low'), null, 'no reload loop on low');
});

test('a validation error long after a switch is not the tier\'s; a lost device always is', () => {
  let now = 0;
  const guard = new TierGuard(() => now);
  assert.equal(guard.onFailure('error', 'high'), null, 'never armed: not counted');
  guard.arm();
  now = FALLBACK_WINDOW_MS + 1;
  assert.equal(guard.onFailure('error', 'high'), null, 'outside the window');
  assert.deepEqual(guard.onFailure('lost', 'high'), { from: 'high', to: 'low', reload: true });
  now += 10;
  guard.arm();
  now += FALLBACK_WINDOW_MS - 100;
  assert.deepEqual(guard.onFailure('error', 'ultra'), { from: 'ultra', to: 'high', reload: false }, 'a new switch re-arms');
});

// ---- materials.ts: glow tags follow the tier ------------------------------------------------------

const THREE = await import('three/webgpu');
const { vec3 } = await import('three/tsl');
const { glowMrt, noGlowMrt, setGlowTargets, glowTargetsOn, keepGlowTag } = await import('../src/render/materials.ts');

test('without bloom glowMrt / noGlowMrt are null, and kept materials are re-tagged both ways until disposed', () => {
  setGlowTargets(true);
  assert.equal(glowTargetsOn(), true);
  assert.notEqual(glowMrt(vec3(1, 0, 0)), null);
  const kept = new THREE.MeshBasicNodeMaterial();
  keepGlowTag(kept, () => glowMrt(vec3(1, 1, 1), 'none'));
  assert.notEqual(kept.mrtNode, null);
  const version = kept.version;
  setGlowTargets(false);
  assert.equal(glowMrt(vec3(1, 0, 0)), null);
  assert.equal(noGlowMrt(), null);
  assert.equal(kept.mrtNode, null, 're-tagged for the direct tier');
  assert.ok(kept.version > version, 'needsUpdate: rebuilt on its next draw');
  setGlowTargets(true);
  assert.notEqual(kept.mrtNode, null, 'tagged again on a tier with bloom');
  kept.dispose();
  setGlowTargets(false);
  assert.notEqual(kept.mrtNode, null, 'a disposed material is forgotten');
  setGlowTargets(true);
});

// GPU diagnostics (node --test tests/gpu-diag.test.mjs): the #diag / #lowgpu / #compat /
// #nof32filter hash flags, the #lowgpu context emulation (hidden extensions, capped limits) on a
// fake canvas and context, the #compat / #nof32filter adapter emulation on a fake navigator.gpu,
// and the program audit's GLSL resource count against a context's limits.
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

const { diagFlags, hiddenFeatures, installAdapterEmulation, glslProgramUse, programOverLimits, installLowGpuEmulation, LOWGPU_EXTENSIONS, LOWGPU_LIMITS } = await import('../src/render/gpuDiag.ts');

const off = { diag: false, lowgpu: false, compat: false, nof32filter: false };

test('the flags are whole words of the hash', () => {
  assert.deepEqual(diagFlags(''), off);
  assert.deepEqual(diagFlags('#diag'), { ...off, diag: true });
  assert.deepEqual(diagFlags('#lowgpu&diag&stats'), { ...off, diag: true, lowgpu: true });
  assert.deepEqual(diagFlags('#stats&lowgpu'), { ...off, lowgpu: true });
  assert.deepEqual(diagFlags('#diagnostics&nolowgpu'), off);
  assert.deepEqual(diagFlags('#compat&diag'), { ...off, diag: true, compat: true });
  assert.deepEqual(diagFlags('#nof32filter'), { ...off, nof32filter: true });
  assert.deepEqual(diagFlags('#compatible&f32filter'), off);
});

test('#compat hides core-features-and-limits, #nof32filter float32-filterable from the adapter and the device', async () => {
  assert.deepEqual(hiddenFeatures(off), []);
  assert.deepEqual(hiddenFeatures({ compat: true, nof32filter: true }), ['core-features-and-limits', 'float32-filterable']);
  const requested = [];
  const adapter = {
    features: new Set(['core-features-and-limits', 'float32-filterable', 'timestamp-query']),
    limits: { maxTextureDimension2D: 16384 },
    info: { vendor: 'x' },
    async requestDevice(desc) {
      requested.push(desc);
      return { features: new Set(desc?.requiredFeatures ?? []) };
    },
  };
  const gpu = { async requestAdapter() { return adapter; } };
  const hadNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { gpu }, configurable: true });
  try {
    assert.equal(typeof installAdapterEmulation([]), 'function', 'nothing to hide: a no-op');
    const restore = installAdapterEmulation(hiddenFeatures({ compat: true, nof32filter: false }));
    const a = await gpu.requestAdapter({ featureLevel: 'compatibility' });
    assert.deepEqual([...a.features].sort(), ['float32-filterable', 'timestamp-query']);
    assert.equal(a.limits.maxTextureDimension2D, 16384, 'everything else passes through');
    assert.equal(a.info.vendor, 'x');
    const d = await a.requestDevice({ requiredFeatures: ['core-features-and-limits', 'timestamp-query'], requiredLimits: {} });
    assert.deepEqual([...d.features], ['timestamp-query'], 'a compatibility-mode device');
    assert.deepEqual(requested.at(-1).requiredLimits, {});
    restore();
    assert.equal(Object.prototype.hasOwnProperty.call(gpu, 'requestAdapter'), true, 'own method restored');
    assert.equal(await gpu.requestAdapter(), adapter);
  } finally {
    if (hadNavigator) Object.defineProperty(globalThis, 'navigator', hadNavigator);
    else delete globalThis.navigator;
  }
});

test('#lowgpu hides the float-linear, float-target and float-blend extensions and caps the limits', () => {
  for (const name of ['OES_texture_float_linear', 'EXT_color_buffer_float', 'EXT_float_blend', 'EXT_disjoint_timer_query_webgl2', 'WEBGL_multi_draw', 'EXT_clip_control']) {
    assert.ok(!LOWGPU_EXTENSIONS.includes(name), `${name} is hidden`);
  }
  assert.ok(LOWGPU_EXTENSIONS.includes('EXT_color_buffer_half_float'), 'half-float targets stay');

  const all = ['OES_texture_float_linear', 'EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_float_blend', 'KHR_parallel_shader_compile'];
  const params = new Map([
    [0x0d33, 16384], // MAX_TEXTURE_SIZE
    [0x8dfc, 30], // MAX_VARYING_VECTORS
    [0x8d57, 8], // MAX_SAMPLES
    [0x1f01, 'renderer'], // RENDERER (not a number: passed through)
  ]);
  const fakeGl = {
    getExtension: (n) => (all.includes(n) ? { name: n } : null),
    getSupportedExtensions: () => all.slice(),
    getParameter: (p) => params.get(p) ?? 1,
  };
  class FakeCanvas {
    getContext(type) {
      return type === 'webgl2' ? fakeGl : { kind: type };
    }
  }
  globalThis.HTMLCanvasElement = FakeCanvas;
  const original = FakeCanvas.prototype.getContext;
  const restore = installLowGpuEmulation();
  const gl = new FakeCanvas().getContext('webgl2');
  restore();
  assert.equal(FakeCanvas.prototype.getContext, original, 'getContext is restored');
  assert.equal(gl.getExtension('OES_texture_float_linear'), null);
  assert.equal(gl.getExtension('EXT_color_buffer_float'), null);
  assert.equal(gl.getExtension('EXT_float_blend'), null);
  assert.deepEqual(gl.getExtension('EXT_color_buffer_half_float'), { name: 'EXT_color_buffer_half_float' });
  assert.deepEqual(gl.getSupportedExtensions(), ['EXT_color_buffer_half_float', 'KHR_parallel_shader_compile']);
  const cap = new Map(LOWGPU_LIMITS);
  assert.equal(gl.getParameter(0x0d33), cap.get(0x0d33));
  assert.equal(gl.getParameter(0x8dfc), 15);
  assert.equal(gl.getParameter(0x8d57), 4);
  assert.equal(gl.getParameter(0x1f01), 'renderer');
  // Other context types are untouched.
  assert.deepEqual(new FakeCanvas().getContext('2d'), { kind: '2d' });
  delete globalThis.HTMLCanvasElement;
});

test('the program audit counts varyings in vec4 rows and samplers per stage', () => {
  const vs = [
    '#version 300 es',
    'layout(location = 0) in vec3 position;',
    'out vec3 vNormal;',
    'flat out highp int vId;',
    'out vec2 vUv[2];',
    'out mat3 vTbn;',
    'uniform sampler2D heights;',
    'void main() {}',
  ].join('\n');
  const fs = ['#version 300 es', 'in vec3 vNormal;', 'out vec4 fragColor;', 'uniform highp sampler2D a;', 'uniform sampler2DShadow s;', 'uniform samplerCube e;', 'void main() {}'].join('\n');
  // The fragment output is the fragment shader's, never counted.
  const use = glslProgramUse(vs, fs);
  assert.deepEqual(use, { varyingRows: 1 + 1 + 2 + 3, varyingComponents: 3 + 1 + 4 + 9, vertexSamplers: 1, fragmentSamplers: 3 });
  assert.deepEqual(programOverLimits(use, { varyings: 15, textureUnits: 16, vertexTextureUnits: 16 }), []);
  assert.deepEqual(programOverLimits(use, { varyings: 6, textureUnits: 2, vertexTextureUnits: 0 }), ['7 varyings > 6', '3 textures > 2', '1 vertex textures > 0']);
});

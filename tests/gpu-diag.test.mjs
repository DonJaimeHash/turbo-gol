// GPU diagnostics (node --test tests/gpu-diag.test.mjs): the #diag / #lowgpu hash flags, the
// #lowgpu context emulation (hidden extensions, capped limits) on a fake canvas and context, and the
// program audit's GLSL resource count against a context's limits.
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

const { diagFlags, glslProgramUse, programOverLimits, installLowGpuEmulation, LOWGPU_EXTENSIONS, LOWGPU_LIMITS } = await import('../src/render/gpuDiag.ts');

test('the flags are whole words of the hash', () => {
  assert.deepEqual(diagFlags(''), { diag: false, lowgpu: false });
  assert.deepEqual(diagFlags('#diag'), { diag: true, lowgpu: false });
  assert.deepEqual(diagFlags('#lowgpu&diag&stats'), { diag: true, lowgpu: true });
  assert.deepEqual(diagFlags('#stats&lowgpu'), { diag: false, lowgpu: true });
  assert.deepEqual(diagFlags('#diagnostics&nolowgpu'), { diag: false, lowgpu: false });
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

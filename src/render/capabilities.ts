/**
 * What the GPU and the browser can do, read once at renderer init (`readCapabilities`), and the tier
 * the device actually runs (`adjustTier`): TIERS[q] without the pieces the device cannot do. The
 * menu still offers every tier; a tier the device cannot do fully runs without them, and #diag
 * lists what was changed (`tierChanges`).
 *
 * Found on the owner's phones (2026-10-21) and reproduced on a desktop with the #compat and
 * #nof32filter flags (gpuDiag.ts):
 *
 *   WebGPU compatibility mode (Chrome on an OpenGL ES driver: a Huawei Kirin 710F / Mali): the
 *   format rgba16float "does not support multisampling" there, so the high tier's MSAA x4 HDR
 *   scene pass (its 'output-msaa' and 'emissive-msaa' textures) was invalid and every frame
 *   failed. Without `msaaHdr` the post tiers take FXAA instead. The canvas (rgba8unorm /
 *   bgra8unorm) does multisample there, but `msaaCanvas` is off by default in that mode: Dawn's
 *   OpenGL ES backend resolves a multisampled pass with a framebuffer blit after it, so a tiled
 *   phone GPU writes all four samples of colour and depth to memory and reads them back (three
 *   stores the canvas' multisampled attachment on every backend), about six times the memory
 *   traffic of the frame without it on the weakest phones the game runs on. The direct tier runs
 *   there without anti-aliasing (its markings are anti-aliased in the shader); `#msaa` turns the
 *   canvas MSAA back on for an A/B on the phone, `#nomsaa` turns every tier's off anywhere.
 *   No 'float32-filterable' (Safari on an iPhone): no tier binds a float32 colour texture (every
 *   target and baked texture is RGBA8 or half float; depth textures are bound as depth), and every
 *   tier runs clean on Chromium without the feature. The iPhone's ultra failure ("encoder state is
 *   'Locked'") is WebKit's and is left to the safety net (tierGuard.ts) and #diag's pass report.
 *
 * Pure (no three, no DOM) except `readCapabilities`, which reads the backend structurally.
 */
import type { TierSpec } from './quality';

export interface Capabilities {
  readonly backend: 'webgpu' | 'webgl2';
  /** WebGPU compatibility mode: no 'core-features-and-limits' (OpenGL ES drivers, older phones). */
  readonly compatibilityMode: boolean;
  /** A 4x multisampled rgba16float render target (the post tiers' HDR scene pass). */
  readonly msaaHdr: boolean;
  /** A 4x multisampled canvas (the direct tier's anti-aliasing). */
  readonly msaaCanvas: boolean;
  /** Linear filtering of float32 textures ('float32-filterable' / OES_texture_float_linear); informative, no tier needs it. */
  readonly float32Filterable: boolean;
  /** Largest side of a 2D texture or render target (maxTextureDimension2D / MAX_TEXTURE_SIZE). */
  readonly maxTextureSize: number;
  /** Colour targets one pass may write (bloom's MRT needs 2). */
  readonly maxColorAttachments: number;
  /** Identity of the GPU and the mode it runs in: the key of the remembered tier (tierGuard.ts). */
  readonly gpu: string;
}

/** A device that can do everything (node tests, and the switches before the renderer exists). */
export const FULL_CAPABILITIES: Capabilities = {
  backend: 'webgpu',
  compatibilityMode: false,
  msaaHdr: true,
  msaaCanvas: true,
  float32Filterable: true,
  maxTextureSize: 8192,
  maxColorAttachments: 8,
  gpu: 'any',
};

/**
 * `caps` without multisampling (`#nomsaa`, an A/B on a phone): adjustTier then runs the direct
 * tier without anti-aliasing and the post tiers with FXAA. Pure.
 */
export function withoutMsaa(caps: Capabilities): Capabilities {
  return { ...caps, msaaHdr: false, msaaCanvas: false };
}

/**
 * `caps` with the canvas MSAA forced on in WebGPU compatibility mode (`#msaa`, the A/B of its
 * default there; the canvas formats do multisample in that mode). Other devices unchanged. Pure.
 */
export function withCompatCanvasMsaa(caps: Capabilities): Capabilities {
  return caps.backend === 'webgpu' && caps.compatibilityMode ? { ...caps, msaaCanvas: true } : caps;
}

/**
 * `#nopost` (a diagnostic): a post tier's switches on the direct path, straight to the canvas
 * without its HDR target, bloom and screen-space passes (the cost of the post chain on a device,
 * A/B'd against the same tier). Other tiers unchanged. Pure.
 */
export function withoutPost(spec: TierSpec): TierSpec {
  if (spec.output !== 'post') return spec;
  return { ...spec, output: 'direct', bloom: false, lensFlare: false, gtao: false, ssr: false };
}

/**
 * Whether this WebGL2 context can render into a half-float colour target (RGBA16F): enables
 * EXT_color_buffer_float or EXT_color_buffer_half_float and checks a 4x4 target's framebuffer for
 * completeness. three never checks, so without either extension every HalfFloat target (the
 * world's sky cube and environment, the post tiers' scene pass) stays incomplete and draws
 * nothing: a black world. Renderer.create runs such a device on super low, which renders no
 * float target. Leaves no state behind (the previous framebuffer and texture bindings are restored).
 */
export function canRenderHalfFloat(gl: WebGL2RenderingContext): boolean {
  if (gl.getExtension('EXT_color_buffer_float') === null && gl.getExtension('EXT_color_buffer_half_float') === null) return false;
  const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  const tex = gl.createTexture();
  const fb = gl.createFramebuffer();
  try {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, 4, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } catch {
    return false;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
  }
}

/** The largest power of two <= n (n >= 1). */
function floorPow2(n: number): number {
  return 2 ** Math.floor(Math.log2(Math.max(1, n)));
}

/**
 * The switches of `spec` the device `caps` can run: the same object when nothing changes, else a
 * copy with the unsupported pieces off. Pure.
 *
 *   msaa       'post' tiers need a multisampled rgba16float target, else 0 (FXAA on the output);
 *              the 'direct' tier needs a multisampled canvas, else 0 (no anti-aliasing).
 *   bloom      needs two colour targets (output + emissive); the lens glare reads the bloom.
 *   sizes      shadow maps, the sky cube and the environment fit maxTextureSize.
 */
export function adjustTier(spec: TierSpec, caps: Capabilities): TierSpec {
  const out: { -readonly [K in keyof TierSpec]: TierSpec[K] } = { ...spec };
  if (spec.msaa > 0 && !(spec.output === 'direct' ? caps.msaaCanvas : caps.msaaHdr)) out.msaa = 0;
  if (spec.bloom && caps.maxColorAttachments < 2) {
    out.bloom = false;
    out.lensFlare = false;
  }
  const maxSize = floorPow2(caps.maxTextureSize);
  out.shadowMapSize = Math.min(spec.shadowMapSize, maxSize);
  out.skyCubeSize = Math.min(spec.skyCubeSize, maxSize);
  out.envSize = Math.min(spec.envSize, maxSize);
  for (const k of Object.keys(spec) as (keyof TierSpec)[]) if (out[k] !== spec[k]) return out;
  return spec;
}

/** The switches `adjusted` changed from `base`, as short text for #diag ('msaa 4 -> 0'). */
export function tierChanges(base: TierSpec, adjusted: TierSpec): string[] {
  const out: string[] = [];
  for (const k of Object.keys(base) as (keyof TierSpec)[]) {
    if (base[k] !== adjusted[k]) out.push(`${k} ${String(base[k])} -> ${String(adjusted[k])}`);
  }
  return out;
}

/** The parts of a three.js r186 WebGPURenderer readCapabilities looks at (structural: no import). */
interface RendererLike {
  readonly backend: unknown;
}

interface WebGpuBackendLike {
  readonly isWebGPUBackend?: boolean;
  readonly compatibilityMode?: boolean | null;
  readonly device?: { readonly features: { has(name: string): boolean }; readonly limits: Record<string, number>; readonly adapterInfo?: Record<string, string> };
  readonly gl?: WebGL2RenderingContext;
}

/**
 * Read the backend's capabilities once it initialised. `msaaCanvas` on WebGL2 is whatever the
 * context was created with (Renderer creates it with antialias); on WebGPU every canvas format
 * multisamples, in compatibility mode too, where it is off all the same (see the file header).
 */
export function readCapabilities(renderer: RendererLike): Capabilities {
  const backend = renderer.backend as WebGpuBackendLike;
  if (backend.isWebGPUBackend === true && backend.device !== undefined) {
    const d = backend.device;
    const compat = backend.compatibilityMode === true;
    const f32 = d.features.has('float32-filterable');
    const info = d.adapterInfo;
    const name = info !== undefined ? [info.vendor, info.architecture, info.device, info.description].filter((s) => s !== undefined && s !== '').join('/') : '';
    return {
      backend: 'webgpu',
      compatibilityMode: compat,
      msaaHdr: !compat,
      msaaCanvas: !compat,
      float32Filterable: f32,
      maxTextureSize: d.limits.maxTextureDimension2D ?? 8192,
      maxColorAttachments: d.limits.maxColorAttachments ?? 8,
      gpu: `webgpu${compat ? '-compat' : ''}${f32 ? '' : '-nof32f'}:${name || 'unknown'}`,
    };
  }
  const gl = backend.gl;
  if (gl === undefined) return { ...FULL_CAPABILITIES, backend: 'webgl2', gpu: 'webgl2:unknown' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number; UNMASKED_VENDOR_WEBGL: number } | null;
  const vendor = String(gl.getParameter(dbg !== null ? dbg.UNMASKED_VENDOR_WEBGL : gl.VENDOR));
  const rendererName = String(gl.getParameter(dbg !== null ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  // A half-float colour target needs EXT_color_buffer_float or EXT_color_buffer_half_float; the
  // driver lists the sample counts it can multisample RGBA16F with.
  let msaaHdr = false;
  if (gl.getExtension('EXT_color_buffer_float') !== null || gl.getExtension('EXT_color_buffer_half_float') !== null) {
    try {
      const counts = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES) as Int32Array | null;
      msaaHdr = counts !== null && Array.prototype.some.call(counts, (n: number) => n >= 4);
    } catch {
      msaaHdr = false;
    }
  }
  const attrs = gl.getContextAttributes();
  return {
    backend: 'webgl2',
    compatibilityMode: false,
    msaaHdr,
    msaaCanvas: attrs !== null && attrs.antialias === true,
    float32Filterable: gl.getExtension('OES_texture_float_linear') !== null,
    maxTextureSize: Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number),
    maxColorAttachments: gl.getParameter(gl.MAX_DRAW_BUFFERS) as number,
    gpu: `webgl2:${vendor}/${rendererName}`,
  };
}

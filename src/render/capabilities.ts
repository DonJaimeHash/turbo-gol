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
 *   bgra8unorm) does multisample there, so the direct low tier keeps its MSAA x4.
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
 * multisamples, in compatibility mode too.
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
      msaaCanvas: true,
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

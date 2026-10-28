/**
 * GPU diagnostics for phones and a low-end GPU emulation for desktops (URL hash flags, off by
 * default; nothing here is ever sent anywhere).
 *
 *   #diag    a small on-screen panel (top centre, pointer-events off) with the backend and why,
 *            the GPU / renderer string, the extensions or features and the limits that matter to
 *            the renderer, the tier and theme, the drawing buffer, and every shader compile / link
 *            error, GPU validation error and three.js warning seen so far, so a player can send a
 *            screenshot of it from any phone. It also checks every linked WebGL program against
 *            the context's limits (varyings, texture units, uniform blocks) and lists the programs
 *            that fail or would not fit. The same text goes to the console once a second while it
 *            changes (`window.__diag()` returns it). It shows the tier as the device runs it (the
 *            render path, MSAA, every switch capabilities.ts turned off) and the remembered ceiling
 *            of tierGuard.ts. On WebGPU it names the passes of a command buffer that failed: each
 *            encoder's finish() runs in an error scope and the error lists the encoder's passes
 *            and their attachments (texture label, format, samples, mip; '(open)' for a pass never
 *            ended), then goes on to the renderer's safety net as an uncaptured error would. The
 *            first messages stay on the panel (the cause), the latest after them.
 *   #compat  WebGPU in compatibility mode (an Android phone's Chrome on OpenGL ES), and
 *   #nof32filter  a WebGPU device without 'float32-filterable' (an iPhone's Safari): the adapter
 *            three requests hides those features (installAdapterEmulation), so the device lacks
 *            them and validates like the phone's (compatibility mode with its default limits).
 *   #nomsaa  no multisampling on any tier (capabilities.ts withoutMsaa: the direct tier draws the
 *            canvas without anti-aliasing, the post tiers take FXAA), and
 *   #msaa    the direct tier's canvas MSAA x4 in WebGPU compatibility mode too, where it is off by
 *            default (a blit resolve: capabilities.ts): A/Bs on a phone, whose canvas MSAA a
 *            tiled GPU pays in memory traffic, against the fps line and #diag's px size.
 *   #lowgpu  forces the WebGL2 backend and makes its context look like a Mali-G51-class Android
 *            phone's before three.js initialises: only the extensions such a phone has are exposed
 *            (no OES_texture_float_linear, EXT_color_buffer_float, EXT_float_blend, timer queries,
 *            multi-draw, clip control...; EXT_color_buffer_half_float, anisotropic filtering and
 *            parallel compile stay), and the limits three reads are capped (8192 textures, 4
 *            samples, 4 draw buffers, 15 varyings, 1024 uniform vectors, 16 KB uniform blocks).
 *            An extension that is never enabled through getExtension is really off in the
 *            browser (a float32 texture with linear filtering samples black, a float32 colour
 *            target is incomplete), so the emulation reproduces the formats a phone lacks; the
 *            capped limits are checked by #diag's program audit (a desktop driver still links a
 *            program the phone would refuse). On a device WITHOUT EXT_color_buffer_half_float (the
 *            1 GB TV of docs/visuals/REWORK.md "Super low": float yes, half float no) it keeps
 *            EXT_color_buffer_float, so a renderable half-float format stays (the emulated phone
 *            used to leave none there: every HalfFloat target incomplete, a black 3D scene).
 *   #tv      the 1 GB Android TV itself (TV Bro on WebView, Mali-G31): WebGL2 forced, no
 *            EXT_color_buffer_half_float (EXT_color_buffer_float stays), no anisotropy, no
 *            KHR_parallel_shader_compile, no float-linear filtering, no timer queries, its limits,
 *            the renderer string 'ARM / Mali-G31' (the boot's GPU probe sees it too:
 *            bootTier.ts), and no pointer and 1 GB for the boot tier (readBootSignals).
 *   #nofloatrt  a WebGL2 context without any renderable float format (no EXT_color_buffer_float
 *            nor EXT_color_buffer_half_float): what Renderer.create's float-target guard catches.
 *
 * #diag=audit also drains gl.getError() and audits each linked program (link status, limits) on
 * every refresh; plain #diag only counts them (a status read can wait on a compile without
 * KHR_parallel_shader_compile). The panel also shows the drawn frame rate and the animation frames
 * the loop ran (frameStats.ts: under the menus the scene is drawn slower or held, Game.ts), the
 * stalls, the CPU per frame of the ball prediction, the bots, the physics step and the render
 * call, the wasm memory, the pipelines, why the session runs its tier (bootTier.ts), the pointer,
 * the secure context and the pixel ratio, logs one JSON line every 5 s ('[diag-json] {...}') and
 * has a button that loses the context or the device (`__diag.loseContext()`): the safety net's test.
 *
 * Cost: nothing without the flags (one string test at boot). With #diag the context or device is
 * wrapped once (shader sources, link status read back once a second): diagnostics only.
 */
import * as THREE from 'three/webgpu';
import type { Capabilities } from './capabilities';
import { diagStats } from './frameStats';
import { parseHashFlags, type HashFlags } from './hashFlags';

/** The URL flags of this module (hashFlags.ts: every flag of the page). */
export type DiagFlags = HashFlags;

/** The page's hash flags (whole words: `#diag=audit` is #diag, `#hide=stadium-netting` is not #net). */
export function diagFlags(hash: string): DiagFlags {
  return parseHashFlags(hash);
}

/**
 * Chain `hook` into three.js's console function (its warnings and errors: shader errors, pipeline
 * failures, uncaught GPU errors, a lost device): the hook sees every message, then the previous
 * function (another hook) or the browser console gets it as before.
 */
export function addThreeConsoleHook(hook: (type: 'log' | 'warn' | 'error', message: string, params: readonly unknown[]) => void): void {
  const prev = THREE.getConsoleFunction();
  THREE.setConsoleFunction((type: 'log' | 'warn' | 'error', message: string, ...params: unknown[]) => {
    hook(type, message, params);
    if (prev) {
      prev(type, message, ...params);
      return;
    }
    const c = console as unknown as Record<string, (...a: unknown[]) => void>;
    const first = params[0] as { isStackTrace?: boolean; getError?: (m: string) => unknown } | undefined;
    const log = c[type] ?? console.log;
    if (first !== undefined && first !== null && first.isStackTrace === true && first.getError) log(first.getError(message));
    else log(message, ...params);
  });
}

// ---- #compat / #nof32filter ---------------------------------------------------------------------

/**
 * The WebGPU features the adapter emulation hides for the flags: 'core-features-and-limits' makes
 * the device a compatibility-mode one (three r186 always asks for a 'compatibility' feature-level
 * adapter and requests every feature it lists, so a desktop Chrome then gets the same validation
 * and the same default limits as the phone: 4096 textures, 15 varyings, 16 KB uniform buffers,
 * 4 colour targets), 'float32-filterable' is what Safari on an iPhone lacks.
 */
export function hiddenFeatures(flags: Pick<DiagFlags, 'compat' | 'nof32filter'>): string[] {
  const out: string[] = [];
  if (flags.compat) out.push('core-features-and-limits');
  if (flags.nof32filter) out.push('float32-filterable');
  return out;
}

/** An adapter that does not list (or grant) the `hidden` features. */
function wrapAdapter(adapter: GPUAdapter, hidden: ReadonlySet<string>): GPUAdapter {
  const features = new Set<string>();
  for (const f of adapter.features) if (!hidden.has(f)) features.add(f);
  const requestDevice = (desc?: GPUDeviceDescriptor): Promise<GPUDevice> => {
    const required = desc?.requiredFeatures !== undefined ? [...desc.requiredFeatures].filter((f) => !hidden.has(f)) : undefined;
    return adapter.requestDevice(desc === undefined ? undefined : { ...desc, requiredFeatures: required });
  };
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'features') return features;
      if (prop === 'requestDevice') return requestDevice;
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/**
 * #compat / #nof32filter: until the returned function is called, navigator.gpu.requestAdapter
 * hands out adapters without the `hidden` features (see hiddenFeatures), so the device three.js
 * creates in between lacks them. Does nothing without WebGPU or with nothing to hide.
 */
export function installAdapterEmulation(hidden: readonly string[]): () => void {
  const nav = typeof navigator !== 'undefined' ? (navigator as unknown as { gpu?: GPU }) : {};
  const gpu = nav.gpu;
  if (gpu === undefined || hidden.length === 0) return () => undefined;
  const set = new Set(hidden);
  const original = gpu.requestAdapter.bind(gpu);
  const own = Object.prototype.hasOwnProperty.call(gpu, 'requestAdapter');
  const prev = gpu.requestAdapter;
  (gpu as unknown as { requestAdapter: GPU['requestAdapter'] }).requestAdapter = async (opts?: GPURequestAdapterOptions) => {
    const adapter = await original(opts);
    return adapter === null ? null : wrapAdapter(adapter, set);
  };
  return () => {
    if (own) (gpu as unknown as { requestAdapter: GPU['requestAdapter'] }).requestAdapter = prev;
    else delete (gpu as unknown as { requestAdapter?: GPU['requestAdapter'] }).requestAdapter;
  };
}

// ---- #lowgpu ----------------------------------------------------------------------------------

/**
 * The WebGL2 extensions #lowgpu keeps: what a Mali-G51-class Android browser exposes of the ones
 * three.js asks for. Everything else (OES_texture_float_linear, EXT_color_buffer_float,
 * EXT_float_blend, EXT_disjoint_timer_query_webgl2, WEBGL_multi_draw, EXT_clip_control,
 * OES_draw_buffers_indexed...) reads as missing.
 */
export const LOWGPU_EXTENSIONS: readonly string[] = [
  'EXT_color_buffer_half_float',
  'EXT_texture_filter_anisotropic',
  'KHR_parallel_shader_compile',
  'WEBGL_compressed_texture_astc',
  'WEBGL_compressed_texture_etc',
  'WEBGL_debug_renderer_info',
  'WEBGL_debug_shaders',
  'WEBGL_lose_context',
];

/** WebGL2 limits (GLenum -> value) capped by #lowgpu, from Mali-G51-class phones. */
export const LOWGPU_LIMITS: ReadonlyArray<readonly [number, number]> = [
  [0x0d33, 8192], // MAX_TEXTURE_SIZE
  [0x851c, 8192], // MAX_CUBE_MAP_TEXTURE_SIZE
  [0x84e8, 8192], // MAX_RENDERBUFFER_SIZE
  [0x8872, 16], // MAX_TEXTURE_IMAGE_UNITS
  [0x8b4c, 16], // MAX_VERTEX_TEXTURE_IMAGE_UNITS
  [0x8dfc, 15], // MAX_VARYING_VECTORS
  [0x8b4b, 60], // MAX_VARYING_COMPONENTS
  [0x9122, 64], // MAX_VERTEX_OUTPUT_COMPONENTS
  [0x9125, 60], // MAX_FRAGMENT_INPUT_COMPONENTS
  [0x8dfd, 1024], // MAX_FRAGMENT_UNIFORM_VECTORS
  [0x8dfb, 1024], // MAX_VERTEX_UNIFORM_VECTORS
  [0x8a30, 16384], // MAX_UNIFORM_BLOCK_SIZE
  [0x8a2b, 12], // MAX_VERTEX_UNIFORM_BLOCKS
  [0x8a2d, 12], // MAX_FRAGMENT_UNIFORM_BLOCKS
  [0x8d57, 4], // MAX_SAMPLES
  [0x8824, 4], // MAX_DRAW_BUFFERS
  [0x8cdf, 4], // MAX_COLOR_ATTACHMENTS
  [0x84ff, 16], // MAX_TEXTURE_MAX_ANISOTROPY_EXT
];

/**
 * The WebGL2 extensions #tv hides: what the 1 GB TV's WebView lacks of the ones three.js asks for
 * (measured with #diag&webgl2 there: f32-linear NO, cb-half NO, aniso NO, parallel NO, timer NO,
 * msrtt NO; cb-float and f32-blend yes).
 */
export const TV_HIDDEN_EXTENSIONS: readonly string[] = [
  'OES_texture_float_linear',
  'EXT_color_buffer_half_float',
  'EXT_texture_filter_anisotropic',
  'KHR_parallel_shader_compile',
  'EXT_disjoint_timer_query_webgl2',
  'WEBGL_multisampled_render_to_texture',
];

/** WebGL2 limits #tv caps (measured on the TV; the desktop's own lower values stay). */
export const TV_LIMITS: ReadonlyArray<readonly [number, number]> = [
  [0x0d33, 8192], // MAX_TEXTURE_SIZE
  [0x851c, 8192], // MAX_CUBE_MAP_TEXTURE_SIZE
  [0x84e8, 8192], // MAX_RENDERBUFFER_SIZE
  [0x8872, 16], // MAX_TEXTURE_IMAGE_UNITS
  [0x8b4d, 96], // MAX_COMBINED_TEXTURE_IMAGE_UNITS
  [0x8dfc, 31], // MAX_VARYING_VECTORS
  [0x8dfd, 4096], // MAX_FRAGMENT_UNIFORM_VECTORS
  [0x8dfb, 4096], // MAX_VERTEX_UNIFORM_VECTORS
  [0x8a30, 65536], // MAX_UNIFORM_BLOCK_SIZE
  [0x8d57, 4], // MAX_SAMPLES
  [0x8824, 4], // MAX_DRAW_BUFFERS
  [0x8cdf, 4], // MAX_COLOR_ATTACHMENTS
];

/** UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL (WEBGL_debug_renderer_info). */
const UNMASKED_VENDOR = 0x9245;
const UNMASKED_RENDERER = 0x9246;
/** What #tv's context reports through WEBGL_debug_renderer_info. */
export const TV_GPU: readonly [vendor: string, renderer: string] = ['ARM', 'Mali-G31'];

/** One emulated WebGL2 device: which extensions it exposes, its limits, its renderer string. */
export interface GlProfile {
  /** Only these (null: every extension but `hide`). */
  readonly keep: ReadonlySet<string> | null;
  readonly hide: ReadonlySet<string>;
  readonly limits: ReadonlyMap<number, number>;
  readonly gpu: readonly [string, string] | null;
}

/**
 * The context profile of the emulation flags (null: none). #lowgpu: the phone's allowlist (plus
 * EXT_color_buffer_float on a device without EXT_color_buffer_half_float, profileExtensions) and
 * limits. #tv: the TV's blocklist, limits and renderer string. #nofloatrt (alone or with either):
 * both colour-buffer float extensions off.
 */
export function glProfile(flags: Pick<HashFlags, 'lowgpu' | 'tv' | 'nofloatrt'>): GlProfile | null {
  if (!flags.lowgpu && !flags.tv && !flags.nofloatrt) return null;
  const hide = new Set<string>(flags.tv ? TV_HIDDEN_EXTENSIONS : []);
  if (flags.nofloatrt) {
    hide.add('EXT_color_buffer_float');
    hide.add('EXT_color_buffer_half_float');
  }
  const limits = new Map<number, number>(flags.tv ? TV_LIMITS : []);
  if (flags.lowgpu) for (const [k, v] of LOWGPU_LIMITS) limits.set(k, Math.min(v, limits.get(k) ?? v));
  return { keep: flags.lowgpu ? new Set(LOWGPU_EXTENSIONS) : null, hide, limits, gpu: flags.tv ? TV_GPU : null };
}

/**
 * The extensions `profile` exposes of a context that supports `real`. The phone's allowlist keeps
 * EXT_color_buffer_float when the device has no EXT_color_buffer_half_float, so a renderable float
 * format stays (see the file header). Pure.
 */
export function profileExtensions(profile: GlProfile, real: readonly string[]): Set<string> {
  const realSet = new Set(real);
  const keep = profile.keep;
  const keepFloat = keep !== null && !realSet.has('EXT_color_buffer_half_float');
  const out = new Set<string>();
  for (const n of real) {
    if (profile.hide.has(n)) continue;
    if (keep !== null && !keep.has(n) && !(keepFloat && n === 'EXT_color_buffer_float')) continue;
    out.add(n);
  }
  return out;
}

const patchedContexts = new WeakSet<object>();

/** Make a WebGL2 context look like `profile`'s device (see the file header). */
function patchContext(gl: WebGL2RenderingContext, profile: GlProfile): void {
  if (patchedContexts.has(gl)) return;
  patchedContexts.add(gl);
  const getExtension = gl.getExtension.bind(gl);
  const getSupportedExtensions = gl.getSupportedExtensions.bind(gl);
  const getParameter = gl.getParameter.bind(gl);
  const exposed = profileExtensions(profile, getSupportedExtensions() ?? []);
  const gpu = profile.gpu;
  const g = gl as unknown as Record<string, unknown>;
  g.getExtension = (name: string): unknown => (exposed.has(name) ? getExtension(name) : null);
  g.getSupportedExtensions = (): string[] => (getSupportedExtensions() ?? []).filter((n) => exposed.has(n));
  g.getParameter = (pname: number): unknown => {
    if (gpu !== null && pname === UNMASKED_VENDOR) return gpu[0];
    if (gpu !== null && pname === UNMASKED_RENDERER) return gpu[1];
    const v: unknown = getParameter(pname);
    const cap = profile.limits.get(pname);
    return cap !== undefined && typeof v === 'number' ? Math.min(v, cap) : v;
  };
}

/**
 * The emulation flags (#lowgpu, #tv, #nofloatrt): patch canvas.getContext until the returned
 * function is called, so the WebGL2 contexts created in between (the boot's GPU probe, three's)
 * are the emulated device's (the patch stays on those contexts). Null when no flag asks for one.
 */
export function installGlEmulation(flags: Pick<HashFlags, 'lowgpu' | 'tv' | 'nofloatrt'>): (() => void) | null {
  const profile = glProfile(flags);
  if (profile === null || typeof HTMLCanvasElement === 'undefined') return null;
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: (this: HTMLCanvasElement, type: string, attrs?: unknown) => unknown };
  const original = proto.getContext;
  proto.getContext = function (this: HTMLCanvasElement, type: string, attrs?: unknown): unknown {
    const ctx = original.call(this, type, attrs);
    if (type === 'webgl2' && ctx !== null && ctx !== undefined) patchContext(ctx as WebGL2RenderingContext, profile);
    return ctx;
  };
  return () => {
    proto.getContext = original;
  };
}

/** #lowgpu alone: installGlEmulation with the phone's profile. */
export function installLowGpuEmulation(): () => void {
  return installGlEmulation({ lowgpu: true, tv: false, nofloatrt: false }) ?? ((): void => undefined);
}

// ---- #diag ------------------------------------------------------------------------------------

/** What the panel shows that only the renderer knows (read on every refresh). */
export interface DiagState {
  readonly tier: string;
  readonly theme: string;
  /** The tier's switches this device runs differently (capabilities.ts tierChanges). */
  readonly changes: readonly string[];
  readonly output: string;
  readonly msaa: number;
  /** The highest tier that has not failed on this GPU (tierGuard.ts), null when none failed. */
  readonly ceiling: string | null;
  readonly caps: Capabilities;
  /** Why the session runs its tier (bootTier.ts TierReason). */
  readonly reason: string;
  /** The boot's signals: the primary pointer, navigator.deviceMemory, the probed GPU string ('' when not probed). */
  readonly pointer: string;
  readonly deviceMemory: number | undefined;
  readonly probedGpu: string;
  /** The drawing buffer's pixel ratio. */
  readonly pixelRatio: number;
  /** Bytes of the physics module's wasm memory (0 when unknown). */
  readonly wasmBytes: number;
}

/** Seconds between two JSON lines in the console. */
const JSON_EVERY_S = 5;

/** One render pass an encoder began (WebGPU #diag pass report). */
interface PassRecord {
  readonly what: string;
  ended: boolean;
}

/** Texture views -> 'label(format x4 mip1)' for the pass report (#diag only). */
const viewNames = new WeakMap<object, string>();
let viewsHooked = false;

/** Name every texture view created from now on (GPUTexture.prototype.createView, #diag only). */
function hookTextureViews(): void {
  if (viewsHooked || typeof GPUTexture === 'undefined') return;
  viewsHooked = true;
  const proto = GPUTexture.prototype as unknown as { createView: (this: GPUTexture, d?: GPUTextureViewDescriptor) => GPUTextureView };
  const createView = proto.createView;
  proto.createView = function (this: GPUTexture, d?: GPUTextureViewDescriptor): GPUTextureView {
    const v = createView.call(this, d);
    const fmt = d?.format ?? this.format;
    const mip = d?.baseMipLevel !== undefined && d.baseMipLevel > 0 ? ` mip${d.baseMipLevel}` : '';
    viewNames.set(v, `${this.label || 'canvas'}(${fmt}${this.sampleCount > 1 ? ` x${this.sampleCount}` : ''}${mip})`);
    return v;
  };
}

/** The attachments of a render pass, as text. */
function describePass(desc: GPURenderPassDescriptor): string {
  const parts: string[] = [];
  for (const c of desc.colorAttachments) if (c !== null && c !== undefined) parts.push(viewNames.get(c.view) ?? '?');
  const ds = desc.depthStencilAttachment;
  if (ds !== undefined) parts.push(`depth ${viewNames.get(ds.view) ?? '?'}`);
  return `${desc.label ?? ''}[${parts.join(', ')}]`;
}

/** A linked WebGL program the audit has looked at. */
interface ProgramRecord {
  readonly program: WebGLProgram;
  done: boolean;
}

/** Resource use of one GLSL ES 3.0 program, from its sources and the linked program. */
export interface ProgramUse {
  /** Vertex shader outputs in vec4 rows (one per float..vec4, columns per matrix) and in components. */
  readonly varyingRows: number;
  readonly varyingComponents: number;
  /** Sampler uniforms in each stage. */
  readonly vertexSamplers: number;
  readonly fragmentSamplers: number;
}

const COMPONENTS: Readonly<Record<string, readonly [rows: number, comps: number]>> = {
  float: [1, 1], int: [1, 1], uint: [1, 1], bool: [1, 1],
  vec2: [1, 2], ivec2: [1, 2], uvec2: [1, 2], bvec2: [1, 2],
  vec3: [1, 3], ivec3: [1, 3], uvec3: [1, 3], bvec3: [1, 3],
  vec4: [1, 4], ivec4: [1, 4], uvec4: [1, 4], bvec4: [1, 4],
  mat2: [2, 4], mat3: [3, 9], mat4: [4, 16],
};

/** Varyings and samplers of a vertex + fragment GLSL ES 3.0 source pair (pure: tested in node). */
export function glslProgramUse(vertex: string, fragment: string): ProgramUse {
  let rows = 0;
  let comps = 0;
  for (const m of vertex.matchAll(/^\s*(?:(?:flat|smooth|centroid|invariant)\s+)*out\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;/gm)) {
    const [r, c] = COMPONENTS[m[1]] ?? [1, 4];
    const n = m[3] !== undefined ? Number(m[3]) : 1;
    rows += r * n;
    comps += c * n;
  }
  const samplers = (src: string): number => [...src.matchAll(/^\s*uniform\s+(?:(?:highp|mediump|lowp)\s+)?[iu]?sampler\w+\s+\w+/gm)].length;
  return { varyingRows: rows, varyingComponents: comps, vertexSamplers: samplers(vertex), fragmentSamplers: samplers(fragment) };
}

/** Problems of a program's use against a context's limits ([] = fits). */
export function programOverLimits(use: ProgramUse, limits: { varyings: number; textureUnits: number; vertexTextureUnits: number }): string[] {
  const out: string[] = [];
  if (use.varyingRows > limits.varyings) out.push(`${use.varyingRows} varyings > ${limits.varyings}`);
  if (use.fragmentSamplers > limits.textureUnits) out.push(`${use.fragmentSamplers} textures > ${limits.textureUnits}`);
  if (use.vertexSamplers > limits.vertexTextureUnits) out.push(`${use.vertexSamplers} vertex textures > ${limits.vertexTextureUnits}`);
  return out;
}

const PANEL_ID = 'turbogol-diag';
const MAX_MESSAGES = 8;
/** The first messages always stay on the panel (the cause comes first); the rest roll. */
const FIRST_KEPT = 3;

/**
 * The #diag panel and its probes. Create it right after the renderer's backend initialised
 * (`attach`), before any shader compiles, so it sees every program.
 */
export class GpuDiag {
  private readonly el: HTMLPreElement;
  private readonly lines: string[] = [];
  private readonly messages: string[] = [];
  private readonly programs: ProgramRecord[] = [];
  /** GL shader -> the material name three compiled it for. */
  private readonly shaderNames = new WeakMap<WebGLShader, string>();
  private readonly failed: string[] = [];
  private readonly over: string[] = [];
  private glErrors = 0;
  private lastText = '';
  private lastStable = '';
  private timer = 0;
  private refreshes = 0;
  private readonly button: HTMLButtonElement;
  private gl: WebGL2RenderingContext | null = null;
  private header: string[] = [];

  private readonly gpu: THREE.WebGPURenderer;
  private readonly state: () => DiagState;
  private readonly flags: DiagFlags;
  /** An error the pass report captured in its scope (it would have been uncaptured): to the safety net. */
  private readonly onCaptured: (message: string) => void;

  constructor(gpu: THREE.WebGPURenderer, state: () => DiagState, flags: DiagFlags, onCaptured: (message: string) => void) {
    this.gpu = gpu;
    this.state = state;
    this.flags = flags;
    this.onCaptured = onCaptured;
    const el = document.createElement('pre');
    el.id = PANEL_ID;
    el.style.cssText = [
      'position:fixed',
      'top:56px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:2147483000',
      'margin:0',
      'padding:6px 8px',
      'max-width:min(92vw,720px)',
      'max-height:70vh',
      'overflow:hidden',
      'white-space:pre-wrap',
      'word-break:break-word',
      'font:10px/1.35 ui-monospace,Menlo,Consolas,monospace',
      'color:#e8f2d0',
      'background:rgba(6,9,14,0.82)',
      'border:1px solid rgba(198,255,46,0.45)',
      'border-radius:6px',
      'pointer-events:none',
    ].join(';');
    this.el = el;
    (document.body ?? document.documentElement).appendChild(el);
    // The safety net's test: lose the WebGL context, or report a lost WebGPU device and destroy it.
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'lose context';
    button.style.cssText = 'position:fixed;top:30px;left:50%;transform:translateX(-50%);z-index:2147483001;font:11px ui-monospace,Menlo,Consolas,monospace;padding:2px 8px;color:#e8f2d0;background:#401018;border:1px solid #ff6070;border-radius:4px;cursor:pointer';
    button.addEventListener('click', () => this.loseContext());
    this.button = button;
    (document.body ?? document.documentElement).appendChild(button);
    (window as unknown as { __diag: (() => string) & { loseContext?: () => string } }).__diag = Object.assign(() => this.text(), { loseContext: () => this.loseContext() });
  }

  /**
   * Lose the context (WebGL2: WEBGL_lose_context) or the device (WebGPU: three's onDeviceLost
   * with a simulated message, then device.destroy(), whose own 'destroyed' loss three ignores).
   */
  loseContext(): string {
    const backend = this.gpu.backend as unknown as { isWebGPUBackend?: boolean; gl?: WebGL2RenderingContext; device?: GPUDevice };
    if (backend.isWebGPUBackend === true && backend.device !== undefined) {
      const r = this.gpu as unknown as { onDeviceLost: (info: unknown) => void };
      r.onDeviceLost({ api: 'WebGPU', message: '#diag: simulated device loss', reason: null });
      backend.device.destroy();
      return 'WebGPU device lost (simulated) and destroyed';
    }
    const ext = backend.gl?.getExtension('WEBGL_lose_context') ?? null;
    if (ext === null) return 'no WEBGL_lose_context';
    ext.loseContext();
    return 'WebGL context lost';
  }

  /** Install the probes (three's console, the context or device) and start refreshing. */
  attach(): void {
    this.hookThreeConsole();
    const backend = this.gpu.backend as unknown as { isWebGPUBackend?: boolean; gl?: WebGL2RenderingContext; device?: GPUDevice };
    if (backend.isWebGPUBackend === true && backend.device !== undefined) this.hookDevice(backend.device);
    else if (backend.gl !== undefined) this.hookGl(backend.gl);
    this.header = this.describeBackend();
    this.refresh();
    this.timer = window.setInterval(() => this.refresh(), 1000);
    window.addEventListener('error', (e) => this.note(`js: ${e.message}`));
  }

  /** The panel text (also `window.__diag()`). */
  text(): string {
    return this.lines.join('\n');
  }

  dispose(): void {
    window.clearInterval(this.timer);
    this.el.remove();
    this.button.remove();
  }

  // ---- probes -------------------------------------------------------------------------------

  private note(msg: string, max = 260): void {
    const m = msg.replace(/\s+/g, ' ').trim().slice(0, max);
    if (m.length === 0 || this.messages.includes(m)) return;
    this.messages.push(m);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(FIRST_KEPT, 1);
  }

  /** three.js warnings and errors (shader errors, pipeline failures) go through its console function. */
  private hookThreeConsole(): void {
    addThreeConsoleHook((type, message, params) => {
      if (type === 'error' || type === 'warn') this.note(`${type === 'error' ? 'ERR' : 'warn'} ${message} ${params.filter((p) => typeof p === 'string').join(' ')}`);
    });
  }

  private hookGl(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    const link = gl.linkProgram.bind(gl);
    const g = gl as unknown as Record<string, unknown>;
    g.linkProgram = (p: WebGLProgram): void => {
      link(p);
      this.programs.push({ program: p, done: false });
    };
    // Label each shader with its material's name (three's createProgram compiles one stage).
    const backend = this.gpu.backend as unknown as { createProgram(program: { name?: string; stage: string }): void; get(o: object): { shaderGPU?: WebGLShader } };
    const create = backend.createProgram.bind(backend);
    backend.createProgram = (program) => {
      create(program);
      const s = backend.get(program).shaderGPU;
      if (s !== undefined) this.shaderNames.set(s, program.name !== undefined && program.name !== '' ? program.name : '(unnamed)');
    };
  }

  private hookDevice(device: GPUDevice): void {
    device.addEventListener('uncapturederror', (e) => {
      const err = (e as GPUUncapturedErrorEvent).error;
      this.note(`GPU ${err.constructor.name}: ${err.message}`);
    });
    this.hookEncoders(device);
    const createShaderModule = device.createShaderModule.bind(device);
    (device as unknown as { createShaderModule: (d: GPUShaderModuleDescriptor) => GPUShaderModule }).createShaderModule = (d) => {
      const mod = createShaderModule(d);
      // Not every WebGPU implementation has getCompilationInfo yet: the probe must never break a
      // shader module (a missing method or a rejected promise only skips the messages).
      if (typeof mod.getCompilationInfo === 'function') {
        mod
          .getCompilationInfo()
          .then((info) => {
            for (const m of info.messages) if (m.type === 'error') this.note(`WGSL ${d.label ?? ''} ${m.lineNum}:${m.linePos} ${m.message}`);
          })
          .catch(() => undefined);
      }
      return mod;
    };
  }

  /**
   * The pass report: every command encoder remembers the render passes it began (their attachments)
   * and whether each ended; its finish() runs in a validation error scope, so an error of that
   * command buffer (a WebKit encoder left 'Locked' by an invalid pass, Dawn's "While encoding
   * BeginRenderPass...") is noted with the passes, then handed to the safety net like the
   * uncaptured error it would have been. Scopes are a stack: the push / pop pair is synchronous
   * around finish(), so three's own scopes (pipeline creation) below it are untouched.
   */
  private hookEncoders(device: GPUDevice): void {
    hookTextureViews();
    const createCommandEncoder = device.createCommandEncoder.bind(device);
    (device as unknown as { createCommandEncoder: (d?: GPUCommandEncoderDescriptor) => GPUCommandEncoder }).createCommandEncoder = (d) => {
      const enc = createCommandEncoder(d);
      const passes: PassRecord[] = [];
      const begin = enc.beginRenderPass.bind(enc);
      (enc as unknown as { beginRenderPass: (pd: GPURenderPassDescriptor) => GPURenderPassEncoder }).beginRenderPass = (pd) => {
        const rec: PassRecord = { what: describePass(pd), ended: false };
        passes.push(rec);
        const pass = begin(pd);
        const end = pass.end.bind(pass);
        (pass as unknown as { end: () => void }).end = () => {
          rec.ended = true;
          end();
        };
        return pass;
      };
      const finish = enc.finish.bind(enc);
      (enc as unknown as { finish: (fd?: GPUCommandBufferDescriptor) => GPUCommandBuffer }).finish = (fd) => {
        device.pushErrorScope('validation');
        const cb = finish(fd);
        void device
          .popErrorScope()
          .then((err) => {
            if (err === null) return;
            const list = passes.map((p) => `${p.what}${p.ended ? '' : ' (open)'}`).join(' ');
            this.note(`GPU finish ${enc.label || '?'} passes ${list || 'none'}: ${err.message}`, 420);
            this.onCaptured(err.message);
          })
          .catch(() => undefined);
        return cb;
      };
      return enc;
    };
  }

  /** Link status and limits of the programs linked since the last refresh (WebGL2, #diag=audit only). */
  private auditPrograms(): void {
    const gl = this.gl;
    if (gl === null || !this.flags.audit) return;
    const parallel = gl.getExtension('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number } | null;
    const limits = {
      varyings: gl.getParameter(gl.MAX_VARYING_VECTORS) as number,
      textureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
      vertexTextureUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) as number,
    };
    for (const rec of this.programs) {
      if (rec.done) continue;
      if (parallel !== null && gl.getProgramParameter(rec.program, parallel.COMPLETION_STATUS_KHR) !== true) continue;
      rec.done = true;
      const shaders = gl.getAttachedShaders(rec.program) ?? [];
      let vs = '';
      let fs = '';
      let name = '';
      for (const s of shaders) {
        const src = gl.getShaderSource(s) ?? '';
        if (gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.VERTEX_SHADER) vs = src;
        else fs = src;
        name = this.shaderNames.get(s) ?? name;
      }
      if (gl.getProgramParameter(rec.program, gl.LINK_STATUS) !== true) {
        const logs = [gl.getProgramInfoLog(rec.program) ?? '', ...shaders.map((s) => gl.getShaderInfoLog(s) ?? '')]
          .join(' ')
          .replace(/[\s\u0000-\u001f]+/g, ' ') // drivers end their logs with a NUL
          .trim();
        this.failed.push(`${name || '?'}: ${logs.slice(0, 200) || 'link failed'}`);
      }
      const problems = programOverLimits(glslProgramUse(vs, fs), limits);
      if (problems.length > 0) this.over.push(`${name || '?'}: ${problems.join(', ')}`);
    }
    for (let i = 0; i < 8; i++) {
      const e = gl.getError();
      if (e === gl.NO_ERROR || e === gl.CONTEXT_LOST_WEBGL) break;
      this.glErrors++;
      this.note(`GL error 0x${e.toString(16)}`);
    }
  }

  // ---- text ---------------------------------------------------------------------------------

  private describeBackend(): string[] {
    const out: string[] = [];
    const backend = this.gpu.backend as unknown as { isWebGPUBackend?: boolean; gl?: WebGL2RenderingContext; device?: GPUDevice; compatibilityMode?: boolean };
    const yn = (b: boolean): string => (b ? 'yes' : 'NO');
    if (backend.isWebGPUBackend === true && backend.device !== undefined) {
      const d = backend.device;
      const info = (d as unknown as { adapterInfo?: GPUAdapterInfo }).adapterInfo;
      out.push(`backend WebGPU${backend.compatibilityMode === true ? ' (compatibility mode)' : ''}`);
      if (info !== undefined) out.push(`gpu  ${[info.vendor, info.architecture, info.device, info.description].filter((s) => s !== '').join(' / ') || '(no adapter info)'}`);
      const f = (n: string): string => `${n.replace(/^(float32|texture-compression)-/, (m) => (m === 'float32-' ? 'f32-' : 'tc-'))} ${yn(d.features.has(n))}`;
      out.push(`feat ${['float32-filterable', 'float32-blendable', 'rg11b10ufloat-renderable', 'timestamp-query', 'shader-f16', 'texture-compression-astc', 'texture-compression-etc2'].map(f).join(' | ')}`);
      const L = d.limits as unknown as Record<string, number>;
      const lim = (k: string, short: string): string => `${short} ${L[k] ?? '?'}`;
      out.push(
        `lim  ${[
          lim('maxTextureDimension2D', 'tex'),
          lim('maxSampledTexturesPerShaderStage', 'textures'),
          lim('maxSamplersPerShaderStage', 'samplers'),
          lim('maxInterStageShaderVariables', 'varyings'),
          lim('maxUniformBuffersPerShaderStage', 'ubos'),
          lim('maxUniformBufferBindingSize', 'ubo'),
          lim('maxStorageBuffersPerShaderStage', 'ssbos'),
          lim('maxColorAttachments', 'targets'),
          lim('maxColorAttachmentBytesPerSample', 'bytes/sample'),
        ].join(' | ')}`,
      );
    } else if (backend.gl !== undefined) {
      const gl = backend.gl;
      const f = this.flags;
      const why = f.tv
        ? 'forced by #tv (emulated 1 GB TV)'
        : f.lowgpu
          ? 'forced by #lowgpu (emulated low-end phone)'
          : f.webgl2
            ? 'forced by #webgl2'
            : this.state().tier === 'superlow' && !f.webgpu
              ? 'super low prefers WebGL2 (#webgpu: WebGPU)'
              : typeof navigator !== 'undefined' && 'gpu' in navigator
                ? 'WebGPU adapter or device unavailable'
                : 'no WebGPU in this browser';
      out.push(`backend WebGL2 (${why})`);
      const dbg = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number; UNMASKED_VENDOR_WEBGL: number } | null;
      const renderer = dbg !== null ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
      const vendor = dbg !== null ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR));
      out.push(`gpu  ${vendor} / ${renderer}`);
      out.push(`glsl ${String(gl.getParameter(gl.VERSION))} / ${String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION))}`);
      const exts = new Set(gl.getSupportedExtensions() ?? []);
      const e = (n: string, short: string): string => `${short} ${yn(exts.has(n))}`;
      out.push(
        `ext  ${[
          e('OES_texture_float_linear', 'f32-linear'),
          e('EXT_color_buffer_float', 'cb-float'),
          e('EXT_color_buffer_half_float', 'cb-half'),
          e('EXT_float_blend', 'f32-blend'),
          e('EXT_texture_filter_anisotropic', 'aniso'),
          e('KHR_parallel_shader_compile', 'parallel'),
          e('EXT_disjoint_timer_query_webgl2', 'timer'),
          e('WEBGL_multisampled_render_to_texture', 'msrtt'),
        ].join(' | ')}`,
      );
      const p = (n: number): string => String(gl.getParameter(n));
      const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
      out.push(
        `lim  tex ${p(gl.MAX_TEXTURE_SIZE)} | units ${p(gl.MAX_TEXTURE_IMAGE_UNITS)}/${p(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS)} | varyings ${p(gl.MAX_VARYING_VECTORS)} | fuv ${p(gl.MAX_FRAGMENT_UNIFORM_VECTORS)} | vuv ${p(
          gl.MAX_VERTEX_UNIFORM_VECTORS,
        )} | ubo ${p(gl.MAX_UNIFORM_BLOCK_SIZE)}x${p(gl.MAX_FRAGMENT_UNIFORM_BLOCKS)} | samples ${p(gl.MAX_SAMPLES)} | draw ${p(gl.MAX_DRAW_BUFFERS)} | highp ${hp !== null && hp.precision > 0 ? hp.precision : 'NO'}`,
      );
    }
    const nav = navigator as unknown as { deviceMemory?: number; hardwareConcurrency?: number };
    out.push(`dev  ${navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 150)} | ${nav.deviceMemory ?? '?'} GB | ${nav.hardwareConcurrency ?? '?'} cores`);
    return out;
  }

  private refresh(): void {
    this.auditPrograms();
    const s = this.state();
    const canvas = this.gpu.domElement;
    const f = this.flags;
    const emulated = [
      f.tv ? ' #tv' : '',
      f.lowgpu ? ' #lowgpu' : '',
      f.nofloatrt ? ' #nofloatrt' : '',
      f.compat ? ' #compat' : '',
      f.nof32filter ? ' #nof32filter' : '',
      f.nomsaa ? ' #nomsaa' : '',
      f.msaa ? ' #msaa' : '',
      f.audit ? ' audit' : '',
      f.nopost ? ' #nopost' : '',
      f.norender ? ' #norender' : '',
      f.pr > 0 ? ` #pr=${f.pr}` : '',
      f.hide.length > 0 ? ` #hide=${f.hide.join(',')}` : '',
    ].join('');
    const lines = [`Turbogol #diag${emulated}`, ...this.header];
    const c = s.caps;
    const secure = typeof isSecureContext === 'boolean' ? isSecureContext : false;
    lines.push(`boot pointer ${s.pointer} | ${s.deviceMemory ?? '?'} GB | secure ${secure ? 'yes' : 'NO'} | probe ${s.probedGpu || '(not probed)'}`);
    lines.push(`caps msaa-hdr ${c.msaaHdr ? 'yes' : 'NO'} | msaa-canvas ${c.msaaCanvas ? 'yes' : 'NO'} | max tex ${c.maxTextureSize} | targets ${c.maxColorAttachments} | ceiling ${s.ceiling ?? 'none'}`);
    lines.push(
      `run  tier ${s.tier} (${s.reason}; ${s.output}, msaa ${s.msaa}) | theme ${s.theme} | ${canvas.width}x${canvas.height} px, ratio ${s.pixelRatio.toFixed(4)} (css ${canvas.clientWidth}x${canvas.clientHeight}, dpr ${window.devicePixelRatio})`,
    );
    if (s.changes.length > 0) lines.push(`adj  ${s.changes.join(' | ')}`);
    const st = diagStats !== null ? diagStats.snapshot() : null;
    if (st !== null) {
      const ms = (v: number): string => v.toFixed(2);
      lines.push(`fps  1 s min ${st.fpsMin1.toFixed(1)} avg ${st.fpsAvg1.toFixed(1)} of ${st.rafAvg1.toFixed(0)} rAF | 5 s avg ${st.fpsAvg5.toFixed(1)} | frames > 50 ms ${st.over50}, > 100 ms ${st.over100} (since warm-up)`);
      lines.push(`cpu  ms/frame: ball pred ${ms(st.cpu.pred)} (worst ${ms(st.predMax)}) | bots ${ms(st.cpu.bots)} | step ${ms(st.cpu.step)} | render ${ms(st.cpu.render)} | wasm ${(s.wasmBytes / 1048576).toFixed(1)} MB`);
    }
    const pipelines = (this.gpu as unknown as { _pipelines?: { caches?: Map<unknown, unknown> } })._pipelines?.caches?.size ?? -1;
    if (this.gl !== null) {
      const pending = f.audit ? this.programs.filter((r) => !r.done).length : 0;
      const audit = f.audit ? ` | ${this.failed.length} FAILED | ${this.over.length} over the limits | ${this.glErrors} GL errors` : ' (#diag=audit: link status, limits, GL errors)';
      lines.push(`prog ${this.programs.length} linked${pending > 0 ? ` (${pending} compiling)` : ''}, ${pipelines} pipelines${audit}`);
      for (const fl of this.failed.slice(-4)) lines.push(`fail ${fl}`);
      for (const o of this.over.slice(-4)) lines.push(`over ${o}`);
    } else lines.push(`prog ${pipelines} pipelines`);
    for (const m of this.messages) lines.push(`msg  ${m}`);
    if (this.messages.length === 0 && this.failed.length === 0) lines.push('msg  no shader or GPU errors so far');
    this.lines.length = 0;
    this.lines.push(...lines);
    const text = this.text();
    if (text !== this.lastText) {
      this.lastText = text;
      this.el.textContent = text;
      // The whole panel goes to the console when more than the running figures changed.
      const stable = lines.filter((l) => !/^(fps|cpu|run|prog) /.test(l)).join('\n');
      if (stable !== this.lastStable) {
        this.lastStable = stable;
        console.info(`[diag]\n${text}`);
      }
    }
    // One machine-readable line every JSON_EVERY_S (adb logcat -s chromium, or the console).
    if (++this.refreshes % JSON_EVERY_S === 0) {
      const info = this.gpu.info.render;
      console.info(
        `[diag-json] ${JSON.stringify({
          t: Math.round(performance.now()),
          tier: s.tier,
          reason: s.reason,
          backend: c.backend,
          px: [canvas.width, canvas.height],
          ratio: +s.pixelRatio.toFixed(4),
          fps1: st !== null ? [+st.fpsMin1.toFixed(1), +st.fpsAvg1.toFixed(1)] : null,
          fps5: st !== null ? +st.fpsAvg5.toFixed(1) : null,
          raf1: st !== null ? +st.rafAvg1.toFixed(1) : null,
          over50: st?.over50 ?? null,
          over100: st?.over100 ?? null,
          cpu: st !== null ? { pred: +st.cpu.pred.toFixed(2), predMax: +st.predMax.toFixed(2), bots: +st.cpu.bots.toFixed(2), step: +st.cpu.step.toFixed(2), render: +st.cpu.render.toFixed(2) } : null,
          draws: info.drawCalls,
          tris: info.triangles,
          pipelines,
          programs: this.gl !== null ? this.programs.length : null,
          glErrors: f.audit ? this.glErrors : null,
          wasmMB: +(s.wasmBytes / 1048576).toFixed(1),
          msgs: this.messages.length,
        })}`,
      );
    }
  }
}

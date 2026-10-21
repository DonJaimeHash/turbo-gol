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
 *            changes (`window.__diag()` returns it).
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
 *            program the phone would refuse).
 *
 * Cost: nothing without the flags (one string test at boot). With #diag the context or device is
 * wrapped once (shader sources, link status read back once a second): diagnostics only.
 */
import * as THREE from 'three/webgpu';

/** The URL flags of this module. */
export interface DiagFlags {
  readonly diag: boolean;
  readonly lowgpu: boolean;
}

export function diagFlags(hash: string): DiagFlags {
  return { diag: /(^|[#&])diag(&|$)/.test(hash), lowgpu: /(^|[#&])lowgpu(&|$)/.test(hash) };
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

const patchedContexts = new WeakSet<object>();

/** Make a WebGL2 context look like a low-end phone's (see the file header). */
function patchLowGpuContext(gl: WebGL2RenderingContext): void {
  if (patchedContexts.has(gl)) return;
  patchedContexts.add(gl);
  const keep = new Set(LOWGPU_EXTENSIONS);
  const caps = new Map<number, number>(LOWGPU_LIMITS);
  const getExtension = gl.getExtension.bind(gl);
  const getSupportedExtensions = gl.getSupportedExtensions.bind(gl);
  const getParameter = gl.getParameter.bind(gl);
  const g = gl as unknown as Record<string, unknown>;
  g.getExtension = (name: string): unknown => (keep.has(name) ? getExtension(name) : null);
  g.getSupportedExtensions = (): string[] => (getSupportedExtensions() ?? []).filter((n) => keep.has(n));
  g.getParameter = (pname: number): unknown => {
    const v: unknown = getParameter(pname);
    const cap = caps.get(pname);
    return cap !== undefined && typeof v === 'number' ? Math.min(v, cap) : v;
  };
}

/**
 * #lowgpu: patch canvas.getContext until the returned function is called, so the WebGL2 context
 * three.js creates in between is the emulated one.
 */
export function installLowGpuEmulation(): () => void {
  const proto = HTMLCanvasElement.prototype as unknown as { getContext: (this: HTMLCanvasElement, type: string, attrs?: unknown) => unknown };
  const original = proto.getContext;
  proto.getContext = function (this: HTMLCanvasElement, type: string, attrs?: unknown): unknown {
    const ctx = original.call(this, type, attrs);
    if (type === 'webgl2' && ctx !== null && ctx !== undefined) patchLowGpuContext(ctx as WebGL2RenderingContext);
    return ctx;
  };
  return () => {
    proto.getContext = original;
  };
}

// ---- #diag ------------------------------------------------------------------------------------

/** What the panel shows that only the renderer knows (read on every refresh). */
export interface DiagState {
  readonly tier: string;
  readonly theme: string;
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
  private timer = 0;
  private gl: WebGL2RenderingContext | null = null;
  private header: string[] = [];

  private readonly gpu: THREE.WebGPURenderer;
  private readonly state: () => DiagState;
  private readonly lowgpu: boolean;

  constructor(gpu: THREE.WebGPURenderer, state: () => DiagState, lowgpu: boolean) {
    this.gpu = gpu;
    this.state = state;
    this.lowgpu = lowgpu;
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
    (window as unknown as { __diag: () => string }).__diag = () => this.text();
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
  }

  // ---- probes -------------------------------------------------------------------------------

  private note(msg: string): void {
    const m = msg.replace(/\s+/g, ' ').trim().slice(0, 260);
    if (m.length === 0 || this.messages.includes(m)) return;
    this.messages.push(m);
    if (this.messages.length > MAX_MESSAGES) this.messages.shift();
  }

  /** three.js warnings and errors (shader errors, pipeline failures) go through its console function. */
  private hookThreeConsole(): void {
    const prev = THREE.getConsoleFunction();
    THREE.setConsoleFunction((type: 'log' | 'warn' | 'error', message: string, ...params: unknown[]) => {
      if (type === 'error' || type === 'warn') this.note(`${type === 'error' ? 'ERR' : 'warn'} ${message} ${params.filter((p) => typeof p === 'string').join(' ')}`);
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

  /** Link status and limits of the programs linked since the last refresh (WebGL2). */
  private auditPrograms(): void {
    const gl = this.gl;
    if (gl === null) return;
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
    const hash = location.hash;
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
      const why = this.lowgpu ? 'forced by #lowgpu (emulated low-end phone)' : hash.includes('webgl2') ? 'forced by #webgl2' : typeof navigator !== 'undefined' && 'gpu' in navigator ? 'WebGPU adapter or device unavailable' : 'no WebGPU in this browser';
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
    const lines = [`Turbogol #diag${this.lowgpu ? ' #lowgpu' : ''}`, ...this.header];
    lines.push(`run  tier ${s.tier} | theme ${s.theme} | ${canvas.width}x${canvas.height} px (css ${canvas.clientWidth}x${canvas.clientHeight}, dpr ${window.devicePixelRatio})`);
    if (this.gl !== null) {
      const pending = this.programs.filter((r) => !r.done).length;
      lines.push(`prog ${this.programs.length} linked${pending > 0 ? ` (${pending} compiling)` : ''} | ${this.failed.length} FAILED | ${this.over.length} over the limits | ${this.glErrors} GL errors`);
      for (const f of this.failed.slice(-4)) lines.push(`fail ${f}`);
      for (const o of this.over.slice(-4)) lines.push(`over ${o}`);
    }
    for (const m of this.messages) lines.push(`msg  ${m}`);
    if (this.messages.length === 0 && this.failed.length === 0) lines.push('msg  no shader or GPU errors so far');
    this.lines.length = 0;
    this.lines.push(...lines);
    const text = this.text();
    if (text !== this.lastText) {
      this.lastText = text;
      this.el.textContent = text;
      console.info(`[diag]\n${text}`);
    }
  }
}

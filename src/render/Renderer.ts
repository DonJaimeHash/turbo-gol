/**
 * Renderer core: three.js r186 `WebGPURenderer` (automatic WebGL2 fallback), scene, camera,
 * resize / pixel budget, GPU timing, dynamic resolution and `#nancheck` for the quality tiers of
 * quality.ts. The parts phase 2 of docs/visuals/REWORK.md rebuilds live in their own folders:
 *
 *   world/   sky dome, PMREM environment, fog and clear colour (`createWorld`)
 *   post/    the theme's two key lights, fill and shadows (`createLighting`, lighting.ts) and the
 *            render path of a tier (`buildPostChain`, pipeline.ts)
 *
 *   superlow (direct):   the direct path of low at about 640x360 (quality.ts SUPERLOW_PIXELS), no
 *                        MSAA, 30 fps at most (Game), the lite world (world/liteWorld.ts: a
 *                        gradient dome, no bake, no environment, no fog), WebGL2 unless the URL
 *                        says #webgpu; decided before the renderer exists (bootTier.ts)
 *   low (direct):        three's DirectRenderPipeline straight into the canvas: the theme's look
 *                        (vignette, exposure, grade, tone curve) and sRGB at the end of every
 *                        material, the canvas' MSAA x4 (none in WebGPU compatibility mode), no
 *                        HDR target, no MRT, no post pass; a pixel ratio up to 1.5 (1 Mpx
 *                        budget), no shadow maps (ground blobs), no bloom
 *   high / ultra (post): HDR scene pass (MRT `output` + `emissive`) -> [ultra: GTAO, SSR on the
 *                        wet pitch] -> bloom from the EMISSIVE target only [+ ultra lens glare] ->
 *                        vignette -> exposure, HDR grade and the theme's tone curve -> sRGB ->
 *                        FXAA where the scene pass has no MSAA; MSAA x4, pixel ratio min(dpr,
 *                        6 Mpx budget) but never below 1 (quality.ts `pixelRatio`), two shadowed
 *                        keys (2048 / PCF 3 on high, 4096 / PCF 4 on ultra), 5-mip bloom
 *
 * Capabilities (capabilities.ts): read once after init (`caps`); every tier runs as
 * `adjustTier(tier(q), caps)` (`spec`): no multisampled HDR target in WebGPU compatibility mode ->
 * FXAA, no multisampled canvas -> the direct tier without AA, maps and the drawing buffer within
 * maxTextureSize. The boot tier comes first (bootTier.ts: the URL's #superlow, the tab's recovery,
 * a GPU of this device that fell back to super low (tierGuard.ts readSuperlowBoot), the player's
 * choice, super low on a 1 GB device or a TV on the slow GPU list, else the saved or default
 * tier), before the backend exists, because super low picks its own (WebGL2) and its world; when
 * super low is only reached after init (this GPU's ceiling, no float target), a ceiling at super
 * low makes the next boots pick its backend. Once the backend is up, startingQuality (quality.ts) lowers a tier above low to low on
 * WebGL2, in WebGPU compatibility mode and with navigator.deviceMemory <= 4 unless the player chose
 * one, never above the GPU's remembered ceiling (tierGuard.ts); and a WebGL2 device that cannot
 * render into any half-float target (capabilities.ts canRenderHalfFloat) runs super low, which
 * renders none, instead of a black world. `tierReason` says which rule decided (#diag).
 *
 * The renderer is created with `antialias: true` (false with `#nomsaa`, the A/B flag that turns
 * every tier's multisampling off: capabilities.ts withoutMsaa): only the direct tier draws the scene into the
 * canvas, so on WebGPU its samples (`_samples`, set per tier) only matter there (three gives
 * full-screen passes 0 samples); on WebGL2 it is the context's multisampled framebuffer, fixed at
 * creation (three only asks for one while the output colour space is the working one: linear during
 * init). Switching tiers disposes the previous path (scene pass, ultra passes, bloom, pipeline quad;
 * leaving the direct tier, the canvas' MSAA buffer) and builds the new one.
 *
 * Failures (`setFailureListener`): WebGPU uncaptured errors, failed pipelines or WebGL programs and
 * a lost device or context go to the Game, whose safety net (tierGuard.ts) falls back one tier.
 *
 * `#webgl2` in the URL forces three's WebGL2 backend (the automatic fallback of browsers without
 * WebGPU), to test that path on any machine; `#lowgpu` forces it with a context that looks like a
 * low-end phone's (no float-linear / float-target / float-blend extensions, capped limits), `#tv`
 * with the 1 GB TV's (and its boot signals), `#nofloatrt` without any renderable float format;
 * `#compat` and `#nof32filter` make the WebGPU device a compatibility-mode one (an OpenGL ES
 * Android phone) or one without 'float32-filterable' (an iPhone); `#diag` shows the backend, GPU,
 * extensions, limits, capabilities, the tier as this device runs it, theme and every shader or GPU
 * error on screen (gpuDiag.ts).
 *
 * GPU timing: with `#stats` in the URL the renderer is created with `trackTimestamp` and resolves
 * the render-pass timestamps every frame; `gpuTimeMs` / `stats().gpuMs` expose them (0 when the
 * backend has no timestamp queries). Off by default: the per-frame resolve allocates a promise.
 *
 * Dynamic resolution (tiers with `dynamicResolution`): loop frames pass their rAF timestamp to
 * render(); a DynamicResolution controller (dynamicResolution.ts) turns the intervals (and the GPU
 * time with `#stats`) into a scale between the tier's minResolutionScale and 1. Post tiers apply
 * it to the scene pass (the composite upsamples the scene; bloom, the vignette and FXAA run at
 * full size; the ultra passes that read the scene depth follow it); the direct tier multiplies the
 * canvas' pixel ratio by it (a resize: the controller changes it at most every half second, steps
 * of 0.05 to 0.1, and leaves the reallocation's long frame out of its mean). `stats().resolutionScale`
 * reports it.
 *
 * NaN hygiene (post/pipeline.ts sanitises every pass-target read, materials their glow writes in
 * `glowMrt()`): with `#nancheck` in the URL the renderer reads the scene pass targets and the bloom
 * result back every NANCHECK_EVERY frames and logs '[nancheck] ...' counters (NaN / Inf / negative
 * / black texels, NaN bounding box); the same report lives at `window.__nancheck`. The direct tier
 * has no HDR target to read (it says so once): its look starts with max(0), which turns a NaN into
 * 0, and it has no glow target to spread one. Zero cost without the hash (one boolean test per
 * frame).
 *
 * Diagnostics (hashFlags.ts, nothing without them): `#pr=<x>` sets the pixel ratio, `#hide=<names>`
 * draws those meshes invisible every frame, `#nopost` runs the post tiers on the direct path
 * (capabilities.ts withoutPost), `#norender` does everything but the draw (the CPU ceiling).
 *
 * Nothing else here allocates per frame: `render()` and `stats()` reuse the same objects.
 */
import * as THREE from 'three/webgpu';
import { adjustTier, canRenderHalfFloat, readCapabilities, tierChanges, withCompatCanvasMsaa, withoutMsaa, withoutPost, type Capabilities } from './capabilities';
import { bootTier, readBootSignals, type TierReason } from './bootTier';
import { diagSources } from './frameStats';
import { emulatedDevice, pageFlags, type HashFlags } from './hashFlags';
import { DynamicResolution } from './dynamicResolution';
import { setGlowTargets } from './materials';
import { createLighting, type Lighting } from './post/lighting';
import { buildPostChain, type PostChain } from './post/pipeline';
import { parseQuality, pixelRatio, startingQuality, tier, type Quality, type TierSpec } from './quality';
import { GpuDiag, addThreeConsoleHook, hiddenFeatures, installAdapterEmulation, installGlEmulation } from './gpuDiag';
import { DEFAULT_THEME, themeWorld, type ThemeId } from './theme';
import { RECOVER_KEY, TRY_TIER_KEY, readCeiling, readSuperlowBoot, writeCeiling, type FailureKind } from './tierGuard';
import { createLiteWorld } from './world/liteWorld';
import { createWorld, type World } from './world/World';

export interface RendererOptions {
  /** Quality tier: the prefs' (default 'high'); bootTier.ts may start on super low instead. */
  quality?: Quality;
  /**
   * The player chose `quality` in the menu (default true). When false the boot may pick super low
   * (bootTier.ts) and a weak backend starts on low (quality.ts startingQuality).
   */
  qualityChosen?: boolean;
  /** Stadium theme (default DEFAULT_THEME). */
  theme?: ThemeId;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  /** Mean GPU render time (ms) over the frames since the previous stats() call; 0 when unavailable. */
  gpuMs: number;
  /** Resolution scale set by dynamic resolution (1 = full: the scene pass, or the direct tier's pixel ratio); NaN on tiers without it. */
  resolutionScale: number;
}

/** A GPU failure the renderer saw (Renderer.setFailureListener; the safety net is tierGuard.ts). */
export interface GpuFailure {
  /** 'error': a WebGPU validation / out-of-memory / internal error, a pipeline or WebGL program that failed; 'lost': the device or the WebGL context is gone. */
  readonly kind: FailureKind;
  readonly message: string;
  /** The tier that was rendering. */
  readonly tier: Quality;
}

/** three's messages (its console function, type 'error') that mean a pipeline or program failed. */
const FAILED_PROGRAM = /Shader Error|pipeline creation failed/i;

/** Camera planes in uu (1 uu = 1 three unit). */
export const CAMERA_NEAR = 10;
export const CAMERA_FAR = 40000;
/** Longest wait for the boot's non-blocking pipeline compile (Renderer.precompile). */
const PRECOMPILE_TIMEOUT_MS = 10000;
/** `#nancheck`: frames between two readbacks. */
const NANCHECK_EVERY = 30;

/** `#nancheck` counters for one render target (see Renderer.runNanCheck). */
export interface NanCheckCounts {
  w: number;
  h: number;
  /** Texels with a NaN / Inf / negative component (rgb), and texels whose rgb is exactly 0. */
  nan: number;
  inf: number;
  neg: number;
  black: number;
  /** Bounding box of the NaN texels (inclusive; x1 < x0 when there are none). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** First NaN texel in scan order (-1 when there are none). */
  fx: number;
  fy: number;
}

/** `#nancheck` report, also exposed as `window.__nancheck`. */
export interface NanCheckReport {
  /** Readbacks done so far and the frame index of the last one. */
  checks: number;
  frame: number;
  /** Readbacks in which any target held a NaN or Inf. */
  badChecks: number;
  /** Running totals over all readbacks (nan + inf + neg texels, all targets). */
  totalNan: number;
  totalInf: number;
  totalNeg: number;
  output: NanCheckCounts;
  emissive: NanCheckCounts;
  bloom: NanCheckCounts;
}

function makeCounts(): NanCheckCounts {
  return { w: 0, h: 0, nan: 0, inf: 0, neg: 0, black: 0, x0: 0, y0: 0, x1: -1, y1: -1, fx: -1, fy: -1 };
}

function resetCounts(c: NanCheckCounts, w = 0, h = 0): void {
  c.w = w;
  c.h = h;
  c.nan = c.inf = c.neg = c.black = 0;
  c.x0 = c.y0 = Number.POSITIVE_INFINITY;
  c.x1 = c.y1 = -1;
  c.fx = c.fy = -1;
}

/** WebGPU readbacks pad every row but the last to 256 bytes: row stride in array elements. */
function rowStride(data: ArrayLike<number>, w: number, h: number): number {
  return h > 1 ? Math.round((data.length - w * 4) / (h - 1)) : w * 4;
}

function halfToFloat(bits: number): number {
  const s = (bits & 0x8000) !== 0 ? -1 : 1;
  const e = (bits >> 10) & 0x1f;
  const m = bits & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m === 0 ? s * Number.POSITIVE_INFINITY : Number.NaN;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** rgb of texel (x, y) of a readback as text (half floats decoded). */
function texelStr(data: ArrayLike<number>, w: number, h: number, x: number, y: number): string {
  if (x < 0 || y < 0 || x >= w || y >= h) return '?';
  const i = y * rowStride(data, w, h) + x * 4;
  const half = data instanceof Uint16Array;
  const c = (k: number): string => {
    const v = half ? halfToFloat(data[i + k]) : data[i + k];
    return Number.isFinite(v) ? v.toPrecision(4) : String(v);
  };
  return `(${c(0)}, ${c(1)}, ${c(2)})`;
}

/**
 * Classify every texel of a readback. Half-float data (Uint16Array, rgba16float) is decoded by
 * bit pattern; anything else is treated as float.
 */
function scanTarget(data: ArrayLike<number>, w: number, h: number, out: NanCheckCounts): void {
  resetCounts(out, w, h);
  const stride = rowStride(data, w, h);
  const half = data instanceof Uint16Array;
  for (let y = 0; y < h; y++) {
    let i = y * stride;
    for (let x = 0; x < w; x++, i += 4) {
      let nan = false;
      let inf = false;
      let neg = false;
      let black = true;
      for (let c = 0; c < 3; c++) {
        const v = data[i + c];
        if (half) {
          const m = v & 0x7fff;
          if (m > 0x7c00) nan = true;
          else if (m === 0x7c00) inf = true;
          else if (m !== 0 && (v & 0x8000) !== 0) neg = true;
          if (m !== 0) black = false;
        } else {
          if (v !== v) nan = true;
          else if (v === Number.POSITIVE_INFINITY || v === Number.NEGATIVE_INFINITY) inf = true;
          else if (v < 0) neg = true;
          if (v !== 0) black = false;
        }
      }
      if (nan) {
        if (out.nan === 0) {
          out.fx = x;
          out.fy = y;
        }
        out.nan++;
        if (x < out.x0) out.x0 = x;
        if (x > out.x1) out.x1 = x;
        if (y < out.y0) out.y0 = y;
        if (y > out.y1) out.y1 = y;
      }
      if (inf) out.inf++;
      if (neg) out.neg++;
      if (black) out.black++;
    }
  }
}

function fmtCounts(name: string, c: NanCheckCounts): string {
  const box = c.nan > 0 ? ` nanBox=[${c.x0},${c.y0}-${c.x1},${c.y1}]` : '';
  return `${name}(${c.w}x${c.h}): nan=${c.nan} inf=${c.inf} neg=${c.neg} black=${c.black}${box}`;
}

export class Renderer {
  readonly gpu: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly isWebGPU: boolean;
  /** The brighter key light (keys[0] of post/lighting.ts, shadowed on high and ultra). Cars and the ball set `castShadow`; the floor receives. */
  readonly sun: THREE.DirectionalLight;
  /** Hemisphere fill (post/lighting.ts). */
  readonly hemi: THREE.HemisphereLight;
  /** True when GPU timestamps are being collected (`#stats` and backend support). */
  readonly gpuTimingEnabled: boolean;
  /** What the GPU can do (capabilities.ts), read at init. */
  readonly caps: Capabilities;
  quality: Quality;
  /** The tier's switches as this device runs them: adjustTier(tier(quality), caps). */
  spec: TierSpec;
  /** Stadium theme (setTheme): the lights, the world and the post chain follow it. */
  theme: ThemeId;
  /** Called after every resize (the chase camera re-applies its horizontal FOV here). */
  onResize: (() => void) | null = null;
  /** Why the session runs its tier (bootTier.ts; 'weak' / 'ceiling' / 'nofloat' set at init). */
  tierReason: TierReason = 'default';
  /** This boot runs the player's pick above the GPU's ceiling once (tierGuard.ts TRY_TIER_KEY). */
  triesAboveCeiling = false;

  private readonly canvas: HTMLCanvasElement;
  /** `#diag` panel (gpuDiag.ts), null without the flag. */
  private diag: GpuDiag | null = null;
  /** Key light, fill and shadows (post/lighting.ts). */
  private readonly lighting: Lighting;
  /** Sky, environment, fog (world/World.ts). */
  private readonly world: World;
  /** The current tier's pipeline and passes (post/pipeline.ts); null only while being rebuilt. */
  private post: PostChain | null = null;
  private readonly statsOut: RenderStats = { drawCalls: 0, triangles: 0, gpuMs: 0, resolutionScale: Number.NaN };
  /** Dynamic resolution (tiers with `dynamicResolution`): scales the scene pass to hold the refresh rate. */
  private readonly dynRes = new DynamicResolution();
  private dynamicResolution = false;
  /** requestAnimationFrame timestamp (ms) of the previous loop frame; -1 after a tier switch. */
  private lastFrameAt = -1;
  private gpuSum = 0;
  private gpuFrames = 0;
  /** `#nancheck` diagnostics (null = off, the default). */
  private readonly nanReport: NanCheckReport | null;
  private nanFrame = 0;
  private nanBusy = false;
  private nanDirectNoted = false;
  private readonly onWindowResize = (): void => this.resize();
  /**
   * Re-measures whenever the canvas' CSS box changes, after layout. Window 'resize' alone is not
   * enough: iOS (rotation, a page opened from the home screen) can fire it before the new layout
   * settles, which left the drawing buffer and the camera at a stale aspect and stretched the 3D
   * view while the DOM HUD looked right.
   */
  private readonly sizeObserver: ResizeObserver | null = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.resize()) : null;
  /** The canvas' CSS size at the last resize: render() re-measures when it differs (a backstop for the observer). */
  private cssW = -1;
  private cssH = -1;
  /** Who hears about GPU failures (Game: the tier fallback), and one failure seen before it listened. */
  private failureListener: ((f: GpuFailure) => void) | null = null;
  private pendingFailure: GpuFailure | null = null;
  /** The page's URL flags (diagnostics: #pr, #hide, #nopost, #norender). */
  private readonly flags: HashFlags = pageFlags();

  private constructor(gpu: THREE.WebGPURenderer, canvas: HTMLCanvasElement, quality: Quality, theme: ThemeId, timing: boolean, caps: Capabilities) {
    this.gpu = gpu;
    this.canvas = canvas;
    this.quality = quality;
    this.caps = caps;
    this.spec = adjustTier(tier(quality), caps);
    this.theme = theme;
    this.isWebGPU = (gpu.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    // Before the world builds its kept materials: their glow tags follow the tier (materials.ts).
    setGlowTargets(this.spec.bloom);
    // The backend clears the flag when 'timestamp-query' (or EXT_disjoint_timer_query_webgl2) is absent.
    this.gpuTimingEnabled = timing && (gpu.backend as { trackTimestamp?: boolean }).trackTimestamp === true;
    this.nanReport = null;
    if (this.flags.nancheck) {
      this.nanReport = {
        checks: 0,
        frame: 0,
        badChecks: 0,
        totalNan: 0,
        totalInf: 0,
        totalNeg: 0,
        output: makeCounts(),
        emissive: makeCounts(),
        bloom: makeCounts(),
      };
      (window as unknown as { __nancheck: NanCheckReport }).__nancheck = this.nanReport;
      console.info(`[nancheck] enabled: pass targets + bloom result read back every ${NANCHECK_EVERY} frames`);
    }

    // No shadow code at all on the lite tier (super low: its own session, a switch to it reloads).
    gpu.shadowMap.enabled = this.spec.world !== 'lite';
    gpu.shadowMap.type = THREE.PCFShadowMap;
    // The pipeline issues several internal renders per frame (shadow, scene, bloom mips, composite);
    // reset the counters once per frame ourselves so stats() reports the whole frame.
    gpu.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, CAMERA_NEAR, CAMERA_FAR);
    this.camera.position.set(0, 600, -2200);
    this.camera.lookAt(0, 100, 0);

    // Key light (+ target) and fill, then the clear colour, fog, sky dome and PMREM environment.
    this.lighting = createLighting(this.scene, quality, theme);
    this.sun = this.lighting.sun;
    this.hemi = this.lighting.hemi;
    // The world is chosen once (quality.ts needsReload): the bake, or the lite dome of super low.
    this.world = this.spec.world === 'lite' ? createLiteWorld(gpu, this.scene, quality, theme) : createWorld(gpu, this.scene, quality, theme);

    window.addEventListener('resize', this.onWindowResize);
    if (this.sizeObserver !== null) this.sizeObserver.observe(canvas);
    this.applyQuality(quality);
  }

  /**
   * Hear about GPU failures: WebGPU uncaptured errors (validation, out of memory, internal), a
   * render pipeline or WebGL program that failed, a lost device or WebGL context. A failure seen
   * before anyone listened (the boot's warm-up) is delivered at once. Null stops listening.
   */
  setFailureListener(fn: ((f: GpuFailure) => void) | null): void {
    this.failureListener = fn;
    const pending = this.pendingFailure;
    if (fn !== null && pending !== null) {
      this.pendingFailure = null;
      fn(pending);
    }
  }

  private reportFailure(kind: FailureKind, message: string): void {
    const f: GpuFailure = { kind, message, tier: this.quality };
    if (this.failureListener !== null) this.failureListener(f);
    else if (this.pendingFailure === null || kind === 'lost') this.pendingFailure = f;
  }

  /** Route three's error callbacks and messages into reportFailure (once, at creation). */
  private watchFailures(): void {
    const gpu = this.gpu as unknown as { onError: (info: unknown) => void; onDeviceLost: (info: unknown) => void };
    const message = (info: unknown): string => {
      const m = (info as { message?: unknown } | null)?.message;
      return typeof m === 'string' ? m : String(info);
    };
    const onError = gpu.onError;
    gpu.onError = (info: unknown): void => {
      onError.call(this.gpu, info);
      this.reportFailure('error', message(info));
    };
    const onLost = gpu.onDeviceLost;
    gpu.onDeviceLost = (info: unknown): void => {
      onLost.call(this.gpu, info);
      this.reportFailure('lost', message(info));
    };
    addThreeConsoleHook((type, msg) => {
      if (type === 'error' && FAILED_PROGRAM.test(msg)) this.reportFailure('error', msg);
    });
  }

  /**
   * Create the WebGPU renderer on `canvas` (falls back to WebGL2 by itself) and await backend init.
   * The boot tier is decided first (bootTier.ts), with the URL's emulation already installed so the
   * GPU probe sees the emulated device: super low starts the WebGL2 backend (unless `#webgpu`) and
   * a context without MSAA, both fixed at creation.
   */
  static async create(canvas: HTMLCanvasElement, opts: RendererOptions = {}): Promise<Renderer> {
    const flags = pageFlags();
    const timing = flags.stats;
    // `#lowgpu` / `#tv` / `#nofloatrt`: the WebGL2 contexts created from now until init is over
    // (the boot's GPU probe, three's) look like that device's.
    const restoreGetContext = installGlEmulation(flags);
    // `#compat` / `#nof32filter`: the WebGPU adapter three requests hides those features.
    const restoreAdapter = installAdapterEmulation(hiddenFeatures(flags));
    let recover = false;
    let tryTier: Quality | null = null;
    let superlowBoot = false;
    try {
      recover = window.sessionStorage.getItem(RECOVER_KEY) === '1';
      tryTier = parseQuality(window.sessionStorage.getItem(TRY_TIER_KEY));
      window.sessionStorage.removeItem(TRY_TIER_KEY);
      superlowBoot = readSuperlowBoot(window.localStorage, Date.now());
    } catch {
      /* storage unavailable */
    }
    const signals = readBootSignals(flags.tv);
    const chosen = opts.qualityChosen ?? true;
    const prefsTier = parseQuality(opts.quality ?? 'high') ?? 'high';
    // The player just picked this tier across a reload (Game.restartOn): this boot tries it above
    // any ceiling once (super low's included); Game.bootDone lifts the ceiling when it runs the
    // fallback window clean.
    const trying = tryTier !== null && chosen && prefsTier === tryTier;
    const boot = bootTier({ quality: prefsTier, qualitySet: chosen }, signals, flags.superlow ? 'hash' : recover ? 'recover' : null, superlowBoot && !trying);
    const bootSpec = tier(boot.tier);
    const gpu = new THREE.WebGPURenderer({
      canvas,
      // MSAA x4 for what is drawn straight into the canvas: only the direct tiers do that (super
      // low without it). The post tiers' final full-screen quad is single-sampled whatever this
      // says (three gives full-screen passes 0 samples on WebGPU); on WebGL2 it is the context's
      // own multisampled framebuffer, fixed at creation, which the post tiers' quad then draws
      // into as well.
      antialias: !flags.nomsaa && bootSpec.msaa > 0,
      alpha: false,
      powerPreference: 'high-performance',
      trackTimestamp: timing,
      // `#webgl2` in the URL: the WebGL2 fallback even where WebGPU exists (testing the fallback);
      // super low prefers it (one 8-bit pass, the context's depth discarded before present, no
      // Dawn heaps in a 1 GB device's browser process) unless `#webgpu` asks for the A/B.
      forceWebGL: flags.webgl2 || flags.lowgpu || flags.tv || (bootSpec.preferWebGL2 && !flags.webgpu),
    });
    // three r186's WebGL2 backend creates its context with antialias only when the renderer's
    // current samples are > 0, which it reports as 0 while the output colour space differs from
    // the working one (its own sRGB output pass would need a framebuffer target): linear during
    // init, so the fallback's canvas multisamples too, sRGB again right after.
    gpu.outputColorSpace = THREE.LinearSRGBColorSpace;
    try {
      await gpu.init();
    } finally {
      gpu.outputColorSpace = THREE.SRGBColorSpace;
      if (restoreGetContext !== null) restoreGetContext();
      restoreAdapter();
    }
    const webgpu = (gpu.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    // `#nomsaa`: no tier multisamples; `#msaa`: the canvas MSAA even in WebGPU compatibility mode,
    // where it is off by default (capabilities.ts): the A/Bs of its cost on a phone.
    const read = readCapabilities(gpu);
    const caps = flags.nomsaa ? withoutMsaa(read) : flags.msaa ? withCompatCanvasMsaa(read) : read;
    let ceiling: Quality | null = null;
    try {
      ceiling = readCeiling(window.localStorage, caps.gpu, Date.now());
    } catch {
      /* storage unavailable */
    }
    const tryIt = trying && boot.reason === 'chosen' && (ceiling !== null || superlowBoot);
    if (tryIt) ceiling = null;
    const nav = navigator as unknown as { deviceMemory?: number };
    let quality = startingQuality(boot.tier, boot.reason === 'chosen', { webgpu, compatibilityMode: caps.compatibilityMode, deviceMemory: flags.tv ? 1 : nav.deviceMemory }, ceiling);
    let reason: TierReason = quality === boot.tier ? boot.reason : quality === ceiling ? 'ceiling' : 'weak';
    // A WebGL2 device without any renderable half-float format would bake a black world (and the
    // post tiers would draw nothing): super low renders no float target at all.
    const gl = (gpu.backend as { gl?: WebGL2RenderingContext }).gl;
    if (!webgpu && gl !== undefined && quality !== 'superlow' && !canRenderHalfFloat(gl)) {
      quality = 'superlow';
      reason = 'nofloat';
    }
    // Super low reached after the backend was chosen for another tier (this GPU's ceiling, or no
    // float target): this page runs it on that backend and context (a multisampled WebGL2 one, or
    // WebGPU); the ceiling at super low makes the next boots start on super low's own
    // (tierGuard.ts readSuperlowBoot). Not from an emulated device (#tv, #lowgpu...): its record
    // would hold for this browser's real GPU too.
    if (quality === 'superlow' && boot.tier !== 'superlow' && !emulatedDevice(flags)) {
      try {
        writeCeiling(window.localStorage, caps.gpu, 'superlow', Date.now());
      } catch {
        /* storage unavailable */
      }
    }
    // `#diag`: the on-screen panel and its probes, installed before any shader compiles.
    const theme = opts.theme ?? DEFAULT_THEME;
    let renderer: Renderer | null = null;
    let diag: GpuDiag | null = null;
    if (flags.diag) {
      diag = new GpuDiag(
        gpu,
        () => {
          const q = renderer?.quality ?? quality;
          const spec = renderer?.spec ?? tier(q);
          let now: string | null = null;
          try {
            now = readCeiling(window.localStorage, caps.gpu, Date.now());
            // A GPU of this device fell to super low: the boots start on it (tierGuard.ts).
            if (readSuperlowBoot(window.localStorage, Date.now())) now = `${now ?? 'none'} (boot: superlow)`;
          } catch {
            now = ceiling;
          }
          return {
            tier: q,
            theme: renderer?.theme ?? theme,
            changes: tierChanges(tier(q), spec),
            output: spec.output,
            msaa: spec.msaa,
            ceiling: now,
            caps,
            reason: renderer?.tierReason ?? reason,
            pointer: signals.pointer,
            deviceMemory: signals.deviceMemory,
            probedGpu: signals.gpu,
            pixelRatio: gpu.getPixelRatio(),
            wasmBytes: diagSources.wasmBytes(),
          };
        },
        flags,
        (message) => renderer?.reportFailure('error', message),
      );
      diag.attach();
    }
    renderer = new Renderer(gpu, canvas, quality, theme, timing, caps);
    renderer.tierReason = reason;
    renderer.triesAboveCeiling = tryIt;
    renderer.diag = diag;
    renderer.watchFailures();
    // The world's load-time work behind the boot overlay: its first bake or cache read.
    await renderer.world.ready;
    return renderer;
  }

  setQuality(q: Quality): void {
    if (q === this.quality && this.post !== null) return;
    this.applyQuality(q);
  }

  /** The world's bakes / cache reads asked for so far (a tier or theme switch) are done. Never rejects. */
  settled(): Promise<void> {
    return this.world.settled();
  }

  /**
   * Switch the stadium theme: the lights (keys and fill) and the post chain (exposure, tone curve,
   * grade) rewrite uniforms, the world re-bakes (its phase); nothing recompiles.
   */
  setTheme(theme: ThemeId): void {
    this.theme = theme;
    this.lighting.setTheme(theme);
    this.world.setTheme(theme);
    if (this.post !== null) this.post.setTheme(themeWorld(theme));
  }

  /**
   * Match the drawing buffer to the canvas' CSS size (window resize, the canvas' ResizeObserver and
   * render() when the size changed; also called by setQuality). The pixel ratio follows the device
   * up to the tier's maxPixelRatio and pixel budget, never below 1:1; a tier whose maxPixelRatio is
   * 1 (low) renders at CSS resolution.
   */
  resize(): void {
    this.cssW = this.canvas.clientWidth;
    this.cssH = this.canvas.clientHeight;
    const w = Math.max(1, this.cssW || window.innerWidth);
    const h = Math.max(1, this.cssH || window.innerHeight);
    const spec = this.spec;
    const touch = spec.maxPixelRatio > 1 && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    // The direct tier's dynamic resolution is the canvas' own pixel ratio (no scene pass to scale).
    const scale = this.dynamicResolution && spec.output === 'direct' ? this.dynRes.scale : 1;
    // `#pr=<x>`: a fixed pixel ratio (the TV's R1-R3 runs: does the cost follow the pixels?).
    const ratio = this.flags.pr > 0 ? this.flags.pr : pixelRatio(spec, window.devicePixelRatio, touch, w, h, this.caps.maxTextureSize) * scale;
    this.gpu.setPixelRatio(ratio);
    this.gpu.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.onResize) this.onResize();
  }

  /**
   * Draw one frame through the tier's path (post/pipeline.ts): the HDR pipeline, whose scene pass
   * names its targets `output` / `emissive`, or the direct path into the canvas (no glow tags
   * there: glowMrt returns null on tiers without bloom). Never `gpu.render(scene, camera)` alone:
   * that would add three's own HalfFloat framebuffer and output pass and skip the theme's look.
   *
   * `frameTime`: the frame's requestAnimationFrame timestamp (ms). Loop frames pass it so dynamic
   * resolution sees the presentation intervals; one-off renders (the boot warm-up) leave it out.
   */
  render(frameTime?: number): void {
    // ResizeObserver callbacks wait for the next rendering update; checking here as well means the
    // frame about to be drawn never uses a stale aspect (two layout reads, no allocation).
    if (this.canvas.clientWidth !== this.cssW || this.canvas.clientHeight !== this.cssH) this.resize();
    if (frameTime !== undefined) {
      // No interval while the page is hidden (a background tab's throttled frames are no load).
      if (this.dynamicResolution && this.lastFrameAt >= 0 && this.post !== null && document.visibilityState !== 'hidden') {
        // GPU time of the last resolved frame when `#stats` timing is on, else intervals only.
        const gpuMs = this.gpuTimingEnabled ? this.gpu.info.render.timestamp : Number.NaN;
        if (this.dynRes.update(frameTime - this.lastFrameAt, gpuMs)) {
          // Direct tier: a new canvas size (the controller changes it at most every half second
          // and leaves the reallocation's long frame out of its mean); post tiers: the scene pass.
          if (this.post.output === 'direct') this.resize();
          else this.post.setResolutionScale(this.dynRes.scale);
        }
      }
      this.lastFrameAt = frameTime;
    }
    this.gpu.info.reset();
    if (this.flags.hide.length > 0) this.applyHide();
    // `#norender`: the frame without its draw (physics, bots, HUD, compositor: the CPU ceiling).
    if (this.post !== null && !this.flags.norender) this.post.render();
    if (this.nanReport !== null && ++this.nanFrame % NANCHECK_EVERY === 0 && !this.nanBusy) void this.runNanCheck();
    if (this.gpuTimingEnabled) {
      // Diagnostics only (#stats): reads back the render-pass timestamps written this frame.
      void this.gpu.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
      this.gpuSum += this.gpu.info.render.timestamp;
      this.gpuFrames++;
    }
  }

  /**
   * The boot's pipeline compile, in parallel instead of one pipeline after the other (Game.warmUpAsync
   * calls it with every normally hidden mesh visible, then renders the synchronous warm-up frame).
   *
   * WebGPU: one frame through the real pipeline (scene pass, shadow maps, ultra passes, bloom,
   * output) with three's synchronous pipeline creation switched to createRenderPipelineAsync, so
   * every pipeline of that frame (the exact variants: same targets, MRT, sample counts) is requested
   * at once and the browser's GPU process compiles them on its worker threads; draws whose pipeline
   * is not ready are skipped (the frame is hidden behind the boot overlay). Measured on the high
   * tier (dev server, warm world cache, GPU shared with other sessions): the first frame was ready
   * on the GPU 2.5-2.8 s after the page started instead of 5.4-6.1 s with the synchronous
   * warm-up alone (52 pipelines either way). three r186's own compileAsync awaits each object's
   * pipelines in turn (10 s here), and a compileAsync per object builds some wrong variants
   * (transparent double-pass materials, a second turf program).
   *
   * WebGL2: a compileAsync of the scene (KHR_parallel_shader_compile) with the path's own target
   * and MRT (post tiers) or in-material output (the direct tier), PostChain.compileAsync; the
   * shadow and post passes are left to the warm-up frame (a few small programs). Measured on the low tier's first load: 1.8 s instead of 5.7 s of synchronous
   * compile. Three's WebGL2 backend polls the parallel compile from requestAnimationFrame, which
   * never fires in a hidden tab: the promise then settles after `timeoutMs` and the first visible
   * frames finish what is left.
   */
  async precompile(timeoutMs = PRECOMPILE_TIMEOUT_MS): Promise<void> {
    const post = this.post;
    if (post === null) return;
    const gpu = this.gpu;
    let compiling: Promise<unknown>;
    let settle = (): void => undefined;
    if (this.isWebGPU) {
      type PipelineUtils = { createRenderPipeline(renderObject: unknown, promises: Promise<void>[] | null): void };
      const utils = (gpu.backend as unknown as { pipelineUtils?: PipelineUtils }).pipelineUtils;
      // three internals (r186): without them the synchronous warm-up frame compiles everything.
      if (utils === undefined || typeof utils.createRenderPipeline !== 'function') return;
      const own = Object.prototype.hasOwnProperty.call(utils, 'createRenderPipeline');
      const create = utils.createRenderPipeline;
      const pending: Promise<void>[] = [];
      utils.createRenderPipeline = function (this: PipelineUtils, renderObject, promises) {
        create.call(this, renderObject, promises ?? pending);
      };
      try {
        this.render();
      } finally {
        if (own) utils.createRenderPipeline = create;
        else delete (utils as Partial<PipelineUtils>).createRenderPipeline;
      }
      compiling = Promise.all(pending);
    } else {
      // The scene pass's target and MRT, or the direct path's in-material output (pipeline.ts),
      // held until the compile settles or times out.
      const c = post.compileAsync();
      compiling = c.promise;
      settle = c.settle;
    }
    let timer = 0;
    await Promise.race([compiling, new Promise<void>((resolve) => (timer = window.setTimeout(resolve, timeoutMs)))]);
    window.clearTimeout(timer);
    // A compile still running after the timeout: the direct path keeps its context until the
    // compile settles (every frame renders with that same context and colour state, so the frames
    // are unchanged, and the objects still to build get the shaders they draw with); the post
    // path's held scene-pass target would take the frames' output quad, so it is restored now and
    // the rest builds with the default state (the warm-up frame builds what it draws).
    if (post.output !== 'direct') settle();
  }

  /**
   * Mean GPU render time (ms) of the last stats() window; NaN when timing is off (no `#stats` or
   * the backend has no timestamp queries), so callers can hide the readout.
   */
  get gpuTimeMs(): number {
    return this.gpuTimingEnabled ? this.statsOut.gpuMs : Number.NaN;
  }

  /**
   * Draw calls / triangles of the last frame, mean GPU ms since the last call and the current
   * dynamic-resolution scale (same object every call).
   */
  stats(): RenderStats {
    const r = this.gpu.info.render;
    this.statsOut.drawCalls = r.drawCalls;
    this.statsOut.triangles = r.triangles;
    this.statsOut.gpuMs = this.gpuFrames > 0 ? this.gpuSum / this.gpuFrames : 0;
    this.statsOut.resolutionScale = this.dynamicResolution ? this.dynRes.scale : Number.NaN;
    this.gpuSum = 0;
    this.gpuFrames = 0;
    return this.statsOut;
  }

  /** `#hide=<names>`: the named meshes, found once per tier switch and hidden before every draw. */
  private hidden: THREE.Object3D[] = [];
  private hideScan = 0;

  private applyHide(): void {
    // The views rebuild on a tier or roster switch: look the names up again now and then.
    if (++this.hideScan % 60 === 1) {
      const names = new Set(this.flags.hide);
      const found: THREE.Object3D[] = [];
      this.scene.traverse((o) => {
        if (names.has(o.name)) found.push(o);
      });
      this.hidden = found;
    }
    for (const o of this.hidden) o.visible = false;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onWindowResize);
    if (this.sizeObserver !== null) this.sizeObserver.disconnect();
    if (this.post !== null) {
      this.post.dispose();
      this.post = null;
    }
    this.world.dispose();
    this.lighting.dispose();
    if (this.diag !== null) this.diag.dispose();
    this.gpu.dispose();
  }

  /**
   * `#nancheck`: read the scene pass targets (output, emissive) and the bloom composite back to
   * the CPU and count bad texels. Diagnostics only: allocates the readback buffers.
   */
  private async runNanCheck(): Promise<void> {
    const report = this.nanReport;
    const post = this.post;
    if (report === null || post === null) return;
    const scenePass = post.scenePass;
    const bloomPass = post.bloomPass;
    if (scenePass === null) {
      // The direct tier keeps no HDR target to read back: a NaN there is already 0 on screen (the
      // look's first max(0), pipeline.ts), and it has no glow target to spread one.
      if (!this.nanDirectNoted) console.info('[nancheck] the direct (low) tier renders straight to the canvas: no HDR targets to read back');
      this.nanDirectNoted = true;
      return;
    }
    this.nanBusy = true;
    const frame = this.nanFrame;
    try {
      const rt = scenePass.renderTarget;
      const w = rt.width;
      const h = rt.height;
      const bloomRt =
        bloomPass !== null ? (bloomPass as unknown as { _renderTargetsHorizontal?: THREE.RenderTarget[] })._renderTargetsHorizontal?.[0] : undefined;
      // Issue every readback before awaiting any: the copies are encoded synchronously, so all
      // three capture the SAME frame (awaiting one first lets later frames render in between).
      const outP = this.gpu.readRenderTargetPixelsAsync(rt, 0, 0, w, h, 0);
      const emiP = rt.textures.length > 1 ? this.gpu.readRenderTargetPixelsAsync(rt, 0, 0, w, h, 1) : null;
      const bloP = bloomRt !== undefined && bloomRt.width > 0 ? this.gpu.readRenderTargetPixelsAsync(bloomRt, 0, 0, bloomRt.width, bloomRt.height, 0) : null;
      const outD = await outP;
      scanTarget(outD, w, h, report.output);
      const emiD = emiP !== null ? await emiP : null;
      if (emiD !== null) scanTarget(emiD, w, h, report.emissive);
      else resetCounts(report.emissive);
      if (bloP !== null && bloomRt !== undefined) scanTarget(await bloP, bloomRt.width, bloomRt.height, report.bloom);
      else resetCounts(report.bloom);
      const o = report.output;
      const e = report.emissive;
      const b = report.bloom;
      // Cross-reference the first NaN of each scene target with the other target's texel.
      let xref = '';
      if (e.nan > 0) xref += ` outputAtEmissiveNaN(${e.fx},${e.fy})=${texelStr(outD, w, h, e.fx, e.fy)}`;
      if (o.nan > 0 && emiD !== null) xref += ` emissiveAtOutputNaN(${o.fx},${o.fy})=${texelStr(emiD, w, h, o.fx, o.fy)}`;
      report.checks++;
      report.frame = frame;
      report.totalNan += o.nan + e.nan + b.nan;
      report.totalInf += o.inf + e.inf + b.inf;
      report.totalNeg += o.neg + e.neg + b.neg;
      if (o.nan + e.nan + b.nan + o.inf + e.inf + b.inf > 0) report.badChecks++;
      console.info(
        `[nancheck] frame ${frame} ${fmtCounts('output', o)} | ${fmtCounts('emissive', e)} | ${fmtCounts('bloom', b)} | bad ${report.badChecks}/${report.checks} totals nan=${report.totalNan} inf=${report.totalInf} neg=${report.totalNeg}${xref}`,
      );
    } catch (err) {
      console.warn('[nancheck] readback failed', err);
    } finally {
      this.nanBusy = false;
    }
  }

  /**
   * Leaving the direct tier on WebGPU: free the canvas' multisampled colour buffer three keeps for
   * it (4 samples of the drawing buffer, ~43 MB at 2190x1233), which the post tiers never use (their
   * full-screen quad is single-sampled; the depth buffer is replaced by three itself). three r186
   * internals: the canvas target's colour texture and its backend data; getColorBuffer recreates the
   * buffer when the direct tier comes back (its sample count no longer matches).
   */
  private releaseCanvasMsaa(): void {
    if (!this.isWebGPU) return;
    try {
      const target = (this.gpu as unknown as { getCanvasTarget(): { colorTexture?: { samples: number } } }).getCanvasTarget();
      const tex = target.colorTexture;
      if (tex === undefined) return;
      const data = (this.gpu.backend as unknown as { get(o: object): { texture?: GPUTexture } }).get(tex);
      if (data.texture === undefined) return;
      data.texture.destroy();
      data.texture = undefined;
      tex.samples = 0;
    } catch (err) {
      console.warn('[renderer] could not free the canvas MSAA buffer (three internals changed?)', err);
    }
  }

  private applyQuality(q: Quality): void {
    this.quality = q;
    // `#nopost`: the post tiers on the direct path (the post chain's cost, A/B'd on the device).
    const adjusted = adjustTier(tier(q), this.caps);
    const spec = this.flags.nopost ? withoutPost(adjusted) : adjusted;
    this.spec = spec;
    // Glow tags for the views about to be built (and the world's kept materials), then the shadow
    // map size and PCF radius of the tier, then the world's tier switches.
    setGlowTargets(spec.bloom);
    this.lighting.setQuality(q, spec);
    this.world.setQuality(q);

    if (this.post !== null) {
      const wasDirect = this.post.output === 'direct';
      this.post.dispose();
      this.post = null;
      if (wasDirect && spec.output !== 'direct') this.releaseCanvasMsaa();
    }
    // The canvas' MSAA, which only the direct path uses (WebGPU: read per render, the post tiers'
    // quad is single-sampled anyway; WebGL2: the context's, fixed at creation). three r186 zeroes
    // it in WebGPU compatibility mode, where its own default path would render into a
    // multisampled rgba16float target that mode cannot create; the canvas' 8-bit formats do
    // multisample there, and no path here goes through three's default one (both draw the
    // canvas with NoToneMapping in the working colour space).
    if (this.isWebGPU) (this.gpu as unknown as { _samples: number })._samples = spec.output === 'direct' ? spec.msaa : 0;
    // A new path starts at full resolution; the controller starts over in the tier's range.
    this.dynamicResolution = spec.dynamicResolution;
    this.dynRes.reset(spec.dynamicResolution ? spec.minResolutionScale : 1);
    this.lastFrameAt = -1;
    this.post = buildPostChain(this.gpu, this.scene, this.camera, spec, themeWorld(this.theme));
    this.hideScan = 0;
    this.resize();
  }
}

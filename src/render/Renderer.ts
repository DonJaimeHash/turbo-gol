/**
 * Renderer core: three.js r186 `WebGPURenderer` (automatic WebGL2 fallback), scene, camera,
 * resize / pixel budget, GPU timing, dynamic resolution and `#nancheck` for the quality tiers of
 * quality.ts. The parts phase 2 of docs/visuals/REWORK.md rebuilds live in their own folders:
 *
 *   world/   sky dome, PMREM environment, fog and clear colour (`createWorld`)
 *   post/    the theme's two key lights, fill and shadows (`createLighting`, lighting.ts) and the
 *            RenderPipeline of a tier (`buildPostChain`, pipeline.ts): HDR scene pass (MRT `output`
 *            + `emissive` on tiers with bloom) -> [ultra: GTAO, SSR on the wet pitch] -> bloom from
 *            the EMISSIVE target only [+ ultra lens glare] -> vignette -> exposure, HDR grade and
 *            the theme's tone curve -> sRGB (`renderOutput`) -> FXAA on tiers without MSAA
 *
 *   low:          no MSAA (FXAA instead), pixel ratio 1, one shadowed key (2048, PCF radius 3), no
 *                 bloom
 *   high / ultra: MSAA x4 on the scene pass, pixel ratio min(dpr, pixel budget 6 Mpx) but never
 *                 below 1 (quality.ts `pixelRatio`), two shadowed keys (4096, PCF radius 4), 5-mip
 *                 bloom, dynamic resolution; ultra adds GTAO, SSR and lens glare (post/screenSpace.ts)
 *
 * The renderer is created with `antialias: false`: MSAA lives on the scene pass (`samples`), so the
 * final full-screen quad is single-sampled on every tier. Switching tiers disposes the previous
 * chain (scene pass, ultra passes, bloom, pipeline quad) and builds the new one.
 *
 * GPU timing: with `#stats` in the URL the renderer is created with `trackTimestamp` and resolves
 * the render-pass timestamps every frame; `gpuTimeMs` / `stats().gpuMs` expose them (0 when the
 * backend has no timestamp queries). Off by default: the per-frame resolve allocates a promise.
 *
 * Dynamic resolution (tiers with `dynamicResolution`): loop frames pass their rAF timestamp to
 * render(); a DynamicResolution controller (dynamicResolution.ts) turns the intervals (and the GPU
 * time with `#stats`) into a scene-pass scale between the tier's minResolutionScale and 1, applied
 * through the chain's setResolutionScale: the composite upsamples the scene, bloom (sized from the
 * drawing buffer), the vignette and FXAA run at full size (the ultra passes that read the scene
 * depth follow the scale). `stats().resolutionScale` reports it.
 *
 * NaN hygiene (post/pipeline.ts sanitises every pass-target read, materials their glow writes in
 * `glowMrt()`): with `#nancheck` in the URL the renderer reads the scene pass targets and the bloom
 * result back every NANCHECK_EVERY frames and logs '[nancheck] ...' counters (NaN / Inf / negative
 * / black texels, NaN bounding box); the same report lives at `window.__nancheck`. Zero cost
 * without the hash (one boolean test per frame).
 *
 * Nothing else here allocates per frame: `render()` and `stats()` reuse the same objects.
 */
import * as THREE from 'three/webgpu';
import { DynamicResolution } from './dynamicResolution';
import { createLighting, type Lighting } from './post/lighting';
import { buildPostChain, type PostChain } from './post/pipeline';
import { pixelRatio, tier, type Quality } from './quality';
import { DEFAULT_THEME, themeWorld, type ThemeId } from './theme';
import { createWorld, type World } from './world/World';

export interface RendererOptions {
  /** Quality tier (default 'high'). */
  quality?: Quality;
  /** Stadium theme (default DEFAULT_THEME). */
  theme?: ThemeId;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  /** Mean GPU render time (ms) over the frames since the previous stats() call; 0 when unavailable. */
  gpuMs: number;
  /** Scene-pass resolution scale set by dynamic resolution (1 = full); NaN on tiers without it. */
  resolutionScale: number;
}

/** Camera planes in uu (1 uu = 1 three unit). */
export const CAMERA_NEAR = 10;
export const CAMERA_FAR = 40000;
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
  /** The brighter key light (keys[0] of post/lighting.ts, shadowed on every tier). Cars and the ball set `castShadow`; the floor receives. */
  readonly sun: THREE.DirectionalLight;
  /** Hemisphere fill (post/lighting.ts). */
  readonly hemi: THREE.HemisphereLight;
  /** True when GPU timestamps are being collected (`#stats` and backend support). */
  readonly gpuTimingEnabled: boolean;
  quality: Quality;
  /** Stadium theme (setTheme). Nothing reads it yet: the themes phase of docs/visuals/REWORK.md does. */
  theme: ThemeId;
  /** Called after every resize (the chase camera re-applies its horizontal FOV here). */
  onResize: (() => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
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

  private constructor(gpu: THREE.WebGPURenderer, canvas: HTMLCanvasElement, quality: Quality, theme: ThemeId, timing: boolean) {
    this.gpu = gpu;
    this.canvas = canvas;
    this.quality = quality;
    this.theme = theme;
    this.isWebGPU = (gpu.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    // The backend clears the flag when 'timestamp-query' (or EXT_disjoint_timer_query_webgl2) is absent.
    this.gpuTimingEnabled = timing && (gpu.backend as { trackTimestamp?: boolean }).trackTimestamp === true;
    this.nanReport = null;
    if (typeof location !== 'undefined' && location.hash.includes('nancheck')) {
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

    gpu.shadowMap.enabled = true;
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
    this.world = createWorld(gpu, this.scene, quality, theme);

    window.addEventListener('resize', this.onWindowResize);
    if (this.sizeObserver !== null) this.sizeObserver.observe(canvas);
    this.applyQuality(quality);
  }

  /** Create the WebGPU renderer on `canvas` (falls back to WebGL2 by itself) and await backend init. */
  static async create(canvas: HTMLCanvasElement, opts: RendererOptions = {}): Promise<Renderer> {
    const timing = typeof location !== 'undefined' && location.hash.includes('stats');
    const gpu = new THREE.WebGPURenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      trackTimestamp: timing,
    });
    await gpu.init();
    const renderer = new Renderer(gpu, canvas, opts.quality ?? 'high', opts.theme ?? DEFAULT_THEME, timing);
    // The world's load-time work (behind the boot overlay; resolved at once until world/ bakes).
    await renderer.world.ready;
    return renderer;
  }

  setQuality(q: Quality): void {
    if (q === this.quality && this.post !== null) return;
    this.applyQuality(q);
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
    const spec = tier(this.quality);
    const touch = spec.maxPixelRatio > 1 && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    this.gpu.setPixelRatio(pixelRatio(spec, window.devicePixelRatio, touch, w, h));
    this.gpu.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.onResize) this.onResize();
  }

  /**
   * Draw one frame through the pipeline. The scene must always go through the PassNode (whose
   * targets are named `output` / `emissive`): a direct `gpu.render(scene, camera)` would compile
   * the glow-tagged materials against the renderer's unnamed internal framebuffer and fail.
   *
   * `frameTime`: the frame's requestAnimationFrame timestamp (ms). Loop frames pass it so dynamic
   * resolution sees the presentation intervals; one-off renders (the boot warm-up) leave it out.
   */
  render(frameTime?: number): void {
    // ResizeObserver callbacks wait for the next rendering update; checking here as well means the
    // frame about to be drawn never uses a stale aspect (two layout reads, no allocation).
    if (this.canvas.clientWidth !== this.cssW || this.canvas.clientHeight !== this.cssH) this.resize();
    if (frameTime !== undefined) {
      if (this.dynamicResolution && this.lastFrameAt >= 0 && this.post !== null) {
        // GPU time of the last resolved frame when `#stats` timing is on, else intervals only.
        const gpuMs = this.gpuTimingEnabled ? this.gpu.info.render.timestamp : Number.NaN;
        if (this.dynRes.update(frameTime - this.lastFrameAt, gpuMs)) this.post.setResolutionScale(this.dynRes.scale);
      }
      this.lastFrameAt = frameTime;
    }
    this.gpu.info.reset();
    if (this.post !== null) this.post.pipeline.render();
    if (this.nanReport !== null && ++this.nanFrame % NANCHECK_EVERY === 0 && !this.nanBusy) void this.runNanCheck();
    if (this.gpuTimingEnabled) {
      // Diagnostics only (#stats): reads back the render-pass timestamps written this frame.
      void this.gpu.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
      this.gpuSum += this.gpu.info.render.timestamp;
      this.gpuFrames++;
    }
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

  dispose(): void {
    window.removeEventListener('resize', this.onWindowResize);
    if (this.sizeObserver !== null) this.sizeObserver.disconnect();
    if (this.post !== null) {
      this.post.dispose();
      this.post = null;
    }
    this.world.dispose();
    this.lighting.dispose();
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

  private applyQuality(q: Quality): void {
    this.quality = q;
    const spec = tier(q);
    // Shadow map size and PCF radius of the tier, then the world's tier switches.
    this.lighting.setQuality(q);
    this.world.setQuality(q);

    if (this.post !== null) {
      this.post.dispose();
      this.post = null;
    }
    // A new scene pass starts at full resolution; the controller starts over in the tier's range.
    this.dynamicResolution = spec.dynamicResolution;
    this.dynRes.reset(spec.dynamicResolution ? spec.minResolutionScale : 1);
    this.lastFrameAt = -1;
    this.post = buildPostChain(this.gpu, this.scene, this.camera, q, themeWorld(this.theme));
    this.resize();
  }
}

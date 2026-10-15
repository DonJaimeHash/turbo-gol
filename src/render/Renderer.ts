/**
 * Renderer core: three.js r186 `WebGPURenderer` (automatic WebGL2 fallback), scene, camera, lights,
 * sky, fog, environment map and post-processing with two quality tiers.
 *
 * Both tiers render through one RenderPipeline:
 *   scene pass (HDR HalfFloat; MRT `output` + `emissive` at quality 0) -> bloom from the EMISSIVE
 *   target only (threshold 0, see materials.ts for the glow contract) -> vignette -> Neutral tone
 *   mapping + sRGB (`renderOutput`) -> FXAA at quality 1.
 *
 *   quality 0: MSAA x4 on the scene pass, pixel ratio min(dpr, pixel budget 6 Mpx) but never
 *              below 1, 4096 shadow map, bloom, PCF radius 4
 *   quality 1: no MSAA (FXAA instead), pixel ratio 1, 2048 shadow map, no bloom, PCF radius 3
 *
 * The renderer is created with `antialias: false`: MSAA lives on the scene pass (`samples`), so the
 * final full-screen quad is single-sampled at both tiers. Switching tiers disposes the previous
 * PassNode / BloomNode (RenderPipeline.dispose() only frees its quad material).
 *
 * GPU timing: with `#stats` in the URL the renderer is created with `trackTimestamp` and resolves
 * the render-pass timestamps every frame; `gpuTimeMs` / `stats().gpuMs` expose them (0 when the
 * backend has no timestamp queries). Off by default: the per-frame resolve allocates a promise.
 *
 * NaN hygiene: the pass targets are HalfFloat, and a single NaN texel in the emissive target
 * would blur through the bloom mips into a big black rectangle (NaN + x = NaN in the composite,
 * NaN -> 0 in the final unorm write). Every read of a pass target in the composite is therefore
 * sanitised with max(0) / min(HDR_MAX) (min / max return the non-NaN operand on every backend) and
 * materials sanitise their own glow writes in `glowMrt()`. With `#nancheck` in the URL the
 * renderer reads the scene pass targets and the bloom result back every NANCHECK_EVERY frames and
 * logs '[nancheck] ...' counters (NaN / Inf / negative / black texels, NaN bounding box); the same
 * report lives at `window.__nancheck`. Zero cost without the hash (one boolean test per frame).
 *
 * Nothing else here allocates per frame: `render()` and `stats()` reuse the same objects.
 */
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  atan,
  emissive,
  float,
  floor,
  hash,
  length,
  mix,
  mrt,
  mx_fractal_noise_float,
  mx_noise_float,
  normalize,
  oneMinus,
  output,
  pass,
  positionWorld,
  renderOutput,
  screenUV,
  sin,
  smoothstep,
  step,
  time,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ARENA } from '../sim/constants';
import { GLOW_MAX, glowMrt, type Vec3Node } from './materials';

export type Quality = 0 | 1;

export interface RendererOptions {
  quality?: Quality;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  /** Mean GPU render time (ms) over the frames since the previous stats() call; 0 when unavailable. */
  gpuMs: number;
}

/** Camera planes in uu (1 uu = 1 three unit). */
export const CAMERA_NEAR = 10;
export const CAMERA_FAR = 40000;
const SKY_RADIUS = 32000;
/** Drawing-buffer pixel budget at quality 0 (a dpr-2 1080p laptop renders at ~1.7x instead of 2x). */
const PIXEL_BUDGET_Q0 = 6e6;
/** Phones and tablets render quality 0 at most at this pixel ratio (their DPR of 3+ costs ~2x the pixels). */
const MAX_TOUCH_PIXEL_RATIO = 2;
/** Sky horizon colour (linear); also the fog and clear colour so distant tiers blend into the sky. */
const HORIZON = { r: 0.11, g: 0.15, b: 0.27 };
const SUN_COLOR = 0xfff3e2;
const SUN_INTENSITY = 3.2;
const EXPOSURE = 1.15;
/** HDR ceiling applied when the composite reads a pass target (HalfFloat max is 65504). */
const HDR_MAX = 65000;
/** `#nancheck`: frames between two readbacks. */
const NANCHECK_EVERY = 30;

const _v = new THREE.Vector3();

interface Disposable {
  dispose(): void;
}

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
  /** Key light (the only shadow caster). Cars and the ball set `castShadow`; the floor receives. */
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** True when GPU timestamps are being collected (`#stats` and backend support). */
  readonly gpuTimingEnabled: boolean;
  quality: Quality;
  /** Called after every resize (the chase camera re-applies its horizontal FOV here). */
  onResize: (() => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly sky: THREE.Mesh;
  private readonly background = new THREE.Color(HORIZON.r, HORIZON.g, HORIZON.b);
  private pipeline: THREE.RenderPipeline | null = null;
  private scenePass: ReturnType<typeof pass> | null = null;
  private bloomPass: ReturnType<typeof bloom> | null = null;
  private envTarget: Disposable | null = null;
  private readonly statsOut: RenderStats = { drawCalls: 0, triangles: 0, gpuMs: 0 };
  private gpuSum = 0;
  private gpuFrames = 0;
  /** `#nancheck` diagnostics (null = off, the default). */
  private readonly nanReport: NanCheckReport | null;
  private nanFrame = 0;
  private nanBusy = false;
  private readonly onWindowResize = (): void => this.resize();

  private constructor(gpu: THREE.WebGPURenderer, canvas: HTMLCanvasElement, quality: Quality, timing: boolean) {
    this.gpu = gpu;
    this.canvas = canvas;
    this.quality = quality;
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

    gpu.toneMapping = THREE.NeutralToneMapping;
    gpu.toneMappingExposure = EXPOSURE;
    gpu.shadowMap.enabled = true;
    gpu.shadowMap.type = THREE.PCFShadowMap;
    gpu.setClearColor(this.background, 1);
    // The pipeline issues several internal renders per frame (shadow, scene, bloom mips, composite);
    // reset the counters once per frame ourselves so stats() reports the whole frame.
    gpu.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, CAMERA_NEAR, CAMERA_FAR);
    this.camera.position.set(0, 600, -2200);
    this.camera.lookAt(0, 100, 0);

    // Key light at ~41° elevation so a grounded car's shadow sticks out beside / behind it
    // (at 50°+ the whole shadow hides under the car).
    this.sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
    this.sun.position.set(3800, 5000, -4200);
    this.sun.target.position.set(0, 0, 0);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 2; // uu
    this.sun.shadow.radius = 4;
    this.scene.add(this.sun, this.sun.target);
    this.fitShadowFrustum();

    // Floodlit stadium: bright cool sky light, green turf bounce from below (undersides pick up a green tint).
    this.hemi = new THREE.HemisphereLight(0xc5d4ff, 0x2a5a30, 1.5);
    this.scene.add(this.hemi);

    // Fog matches the sky horizon; the stands (6000-10000 uu away) are barely touched.
    this.scene.fog = new THREE.Fog(this.background, 12000, 40000);
    this.scene.background = null;

    this.sky = buildSkyDome();
    this.scene.add(this.sky);

    window.addEventListener('resize', this.onWindowResize);
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
    const renderer = new Renderer(gpu, canvas, opts.quality ?? 0, timing);
    renderer.buildEnvironment();
    return renderer;
  }

  setQuality(q: Quality): void {
    if (q === this.quality && this.pipeline !== null) return;
    this.applyQuality(q);
  }

  /**
   * Match the drawing buffer to the canvas' CSS size (call on window resize; also called by
   * setQuality). Quality 0 keeps the device pixel ratio up to a pixel budget, never below 1:1;
   * quality 1 renders at CSS resolution.
   */
  resize(): void {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    let pr = 1;
    if (this.quality === 0) {
      let dpr = window.devicePixelRatio || 1;
      if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) dpr = Math.min(dpr, MAX_TOUCH_PIXEL_RATIO);
      pr = Math.min(dpr, Math.max(1, Math.sqrt(PIXEL_BUDGET_Q0 / (w * h))));
    }
    this.gpu.setPixelRatio(pr);
    this.gpu.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.onResize) this.onResize();
  }

  /**
   * Draw one frame through the pipeline. The scene must always go through the PassNode (whose
   * targets are named `output` / `emissive`): a direct `gpu.render(scene, camera)` would compile
   * the glow-tagged materials against the renderer's unnamed internal framebuffer and fail.
   */
  render(): void {
    this.gpu.info.reset();
    if (this.pipeline !== null) this.pipeline.render();
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

  /** Draw calls / triangles of the last frame, mean GPU ms since the last call (same object every call). */
  stats(): RenderStats {
    const r = this.gpu.info.render;
    this.statsOut.drawCalls = r.drawCalls;
    this.statsOut.triangles = r.triangles;
    this.statsOut.gpuMs = this.gpuFrames > 0 ? this.gpuSum / this.gpuFrames : 0;
    this.gpuSum = 0;
    this.gpuFrames = 0;
    return this.statsOut;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onWindowResize);
    this.teardownPipeline();
    if (this.envTarget !== null) {
      this.envTarget.dispose();
      this.envTarget = null;
      this.scene.environment = null;
    }
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.gpu.dispose();
  }

  /**
   * `#nancheck`: read the scene pass targets (output, emissive) and the bloom composite back to
   * the CPU and count bad texels. Diagnostics only: allocates the readback buffers.
   */
  private async runNanCheck(): Promise<void> {
    const report = this.nanReport;
    const scenePass = this.scenePass;
    if (report === null || scenePass === null) return;
    this.nanBusy = true;
    const frame = this.nanFrame;
    try {
      const rt = scenePass.renderTarget;
      const w = rt.width;
      const h = rt.height;
      const bloomRt =
        this.bloomPass !== null ? (this.bloomPass as unknown as { _renderTargetsHorizontal?: THREE.RenderTarget[] })._renderTargetsHorizontal?.[0] : undefined;
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

  /** Free the scene pass (HDR MSAA target + depth) and the bloom chain before dropping the pipeline. */
  private teardownPipeline(): void {
    if (this.bloomPass !== null) {
      this.bloomPass.dispose();
      this.bloomPass = null;
    }
    if (this.scenePass !== null) {
      this.scenePass.dispose();
      this.scenePass = null;
    }
    if (this.pipeline !== null) {
      this.pipeline.dispose();
      this.pipeline = null;
    }
  }

  private applyQuality(q: Quality): void {
    this.quality = q;
    const high = q === 0;

    // three's ShadowNode resizes its render target from `mapSize` on every shadow render, so only
    // the size changes here (disposing / nulling `shadow.map` would orphan the node's target).
    const size = high ? 4096 : 2048;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.needsUpdate = true;
    }
    this.sun.shadow.radius = high ? 4 : 3;

    this.teardownPipeline();

    // Scene pass: HDR HalfFloat target, MSAA only at quality 0 (the renderer itself is created
    // without antialias so nothing else is multisampled). The WebGPU backend only supports 1 or 4
    // samples, so the tiers are 4 / 0.
    const scenePass = pass(this.scene, this.camera, { samples: high ? 4 : 0 });
    this.scenePass = scenePass;
    // Every pass target is read through `sanitize`: min / max return the non-NaN operand, so a NaN
    // or Inf texel written by a material becomes 0 / HDR_MAX here instead of poisoning the bloom
    // blur (one NaN at a coarse mip upsamples to a big black rectangle) or the tone map.
    const sanitize = (c: Node<'vec4'>): Vec3Node => c.rgb.max(0.0).min(HDR_MAX);
    let hdr: Vec3Node = sanitize(scenePass.getTextureNode('output'));
    if (high) {
      // Bloom reads the emissive MRT target (cleared to black), so only tagged emitters glow.
      // Lit materials without an mrtNode (ball, car bodies) write their emissiveNode through this
      // pass-level MRT, raw: clamp it like glowMrt() does so a NaN / Inf / negative emissive term
      // (e.g. the ball's hex seam weights rounding past 1) never reaches the bloom chain. The
      // member keeps three's default NoBlending for this target.
      scenePass.setMRT(mrt({ output, emissive: emissive.max(0.0).min(GLOW_MAX) }).setClearColor('emissive', 0x000000, 0));
      const bloomPass = bloom(vec4(sanitize(scenePass.getTextureNode('emissive')), 1.0), 0.5, 0.45, 0);
      // Three mips give a tight glow (mips 3-4 are only ~1.5% of the blur fill, so this is
      // a look choice, not a saving). `_nMips` is private to BloomNode; three is pinned to 0.186.x.
      const mips = bloomPass as unknown as { _nMips?: number };
      if (typeof mips._nMips === 'number') mips._nMips = 3;
      else console.warn('BloomNode private API changed; bloom falls back to 5 mips');
      this.bloomPass = bloomPass;
      hdr = hdr.add(sanitize(bloomPass));
    }

    // Subtle vignette in HDR, then tone mapping + sRGB once (outputColorTransform is off so the
    // FXAA pass at quality 1 runs on the final LDR image, which is what it expects).
    const uvc = screenUV.sub(0.5).mul(vec2(1.0, 0.8));
    const vignette = oneMinus(smoothstep(0.45, 1.1, length(uvc).mul(1.6)).mul(0.32));
    const shaded = vec4(hdr.mul(vignette), 1.0);
    const ldr = renderOutput(shaded);
    const pipeline = new THREE.RenderPipeline(this.gpu);
    pipeline.outputColorTransform = false;
    pipeline.outputNode = high ? ldr : fxaa(ldr);
    this.pipeline = pipeline;
    this.resize();
  }

  /**
   * Procedural stadium environment map (PMREM, built once): turf below, a stands band at the
   * horizon, a bright rail ring, floodlight banks high up. Paint, glass, rims and the ball reflect
   * it; without it PBR speculars have only the single key light to reflect.
   */
  private buildEnvironment(): void {
    const env = new THREE.Scene();
    const trash: Disposable[] = [];

    const domeGeo = new THREE.SphereGeometry(50, 32, 16);
    const domeMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
    const up = normalize(positionWorld).y;
    const turf = vec3(0.05, 0.13, 0.08);
    const stands = vec3(0.16, 0.2, 0.31);
    const sky = vec3(0.027, 0.047, 0.1);
    const rail = oneMinus(smoothstep(0.0, 0.012, length(up.sub(0.05))));
    domeMat.colorNode = mix(mix(turf, stands, smoothstep(-0.35, 0.0, up)), sky, smoothstep(0.05, 0.3, up)).add(vec3(1.4, 1.8, 2.2).mul(rail));
    env.add(new THREE.Mesh(domeGeo, domeMat));
    trash.push(domeGeo, domeMat);

    const lampMat = new THREE.MeshBasicNodeMaterial();
    lampMat.colorNode = vec3(1.0, 0.95, 0.86).mul(12);
    const lampGeo = new THREE.PlaneGeometry(1, 1);
    trash.push(lampGeo, lampMat);
    const addLamp = (az: number, elev: number, w: number, h: number): void => {
      const m = new THREE.Mesh(lampGeo, lampMat);
      const r = 40;
      m.position.set(Math.cos(az) * Math.cos(elev) * r, Math.sin(elev) * r, Math.sin(az) * Math.cos(elev) * r);
      m.scale.set(w, h, 1);
      m.lookAt(0, 0, 0);
      env.add(m);
    };
    for (let i = 0; i < 16; i++) addLamp((i / 16) * Math.PI * 2, (60 + (i % 2) * 12) * (Math.PI / 180), 4, 2);
    for (let i = 0; i < 4; i++) addLamp((i + 0.5) * (Math.PI / 2), 48 * (Math.PI / 180), 9, 5);

    const pmrem = new THREE.PMREMGenerator(this.gpu);
    const target = pmrem.fromScene(env, 0.04);
    pmrem.dispose();
    for (const d of trash) d.dispose();
    this.envTarget = target;
    this.scene.environment = target.texture;
    this.scene.environmentIntensity = 0.55;
  }

  /** Orthographic shadow frustum fitted to the arena box (field + goals, floor to ceiling). */
  private fitShadowFrustum(): void {
    const sun = this.sun;
    sun.updateMatrixWorld(true);
    sun.target.updateMatrixWorld(true);
    sun.shadow.updateMatrices(sun);
    const inv = sun.shadow.camera.matrixWorldInverse;
    const hx = ARENA.extentX + 200;
    const hz = ARENA.extentY + ARENA.goalDepth + 200;
    const top = ARENA.height + 100;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? hx : -hx, i & 2 ? top : -50, i & 4 ? hz : -hz).applyMatrix4(inv);
      if (_v.x < minX) minX = _v.x;
      if (_v.x > maxX) maxX = _v.x;
      if (_v.y < minY) minY = _v.y;
      if (_v.y > maxY) maxY = _v.y;
      if (_v.z < minZ) minZ = _v.z;
      if (_v.z > maxZ) maxZ = _v.z;
    }
    const sc = sun.shadow.camera;
    sc.left = minX;
    sc.right = maxX;
    sc.bottom = minY;
    sc.top = maxY;
    // The shadow camera looks down its -z axis, so points in front have negative z.
    sc.near = Math.max(1, -maxZ - 100);
    sc.far = -minZ + 100;
    sc.updateProjectionMatrix();
  }
}

/**
 * Night-stadium sky: gradient dome (horizon glow -> deep blue zenith), two layers of twinkling
 * stars (a few peak above 1 and bloom), a warm city glow with a noisy skyline at the horizon and a
 * thin drifting cloud band. Drawn LAST among opaques (renderOrder 1000, depth tested, no depth
 * write) so it only shades the pixels the arena left uncovered: zero overdraw from inside the
 * shell, and it fills the view through the glass. Shown at both quality tiers.
 */
function buildSkyDome(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 24, 12);
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  const dir = normalize(positionWorld);
  const up = dir.y;
  const horizon = vec3(HORIZON.r, HORIZON.g, HORIZON.b);
  const mid = vec3(0.035, 0.05, 0.11);
  const zenith = vec3(0.012, 0.015, 0.035);
  const gradient = mix(mix(horizon, mid, smoothstep(-0.02, 0.25, up)), zenith, smoothstep(0.25, 0.9, up));

  // City glow: sodium haze under the horizon line, shaped by a noisy skyline.
  const az = atan(dir.z, dir.x);
  const skyline = mx_noise_float(vec2(az.mul(4.0), 0.0)).mul(0.5).add(0.5);
  const glow = oneMinus(smoothstep(-0.02, 0.14, up)).mul(float(0.35).add(skyline.mul(0.65)));
  const city = vec3(0.3, 0.2, 0.1).mul(glow).mul(0.9);

  // Cloud band drifting slowly.
  const c = mx_fractal_noise_float(vec3(dir.xz.mul(2.5).add(time.mul(0.008)), 0.0), 3);
  const cloud = vec3(0.04, 0.05, 0.09).mul(smoothstep(0.45, 0.8, c)).mul(smoothstep(0.05, 0.35, up));

  const aboveHorizon = smoothstep(0.08, 0.45, up);
  const starLayer = (cellSize: number, threshold: number, gain: number): Vec3Node => {
    const cell = floor(dir.xz.mul(cellSize));
    const h = hash(cell.x.add(cell.y.mul(131.7)));
    const on = step(threshold, h);
    const twinkle = float(0.8).add(sin(time.mul(1.7).add(h.mul(6.283))).mul(0.6));
    return vec3(0.9, 0.95, 1.0).mul(on.mul(twinkle).mul(gain).mul(aboveHorizon));
  };
  const stars = starLayer(420, 0.9965, 0.5).add(starLayer(900, 0.994, 0.9));

  material.colorNode = gradient.add(city).add(cloud).add(stars);
  material.mrtNode = glowMrt(stars.mul(0.6), 'none');
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

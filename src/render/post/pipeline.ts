/**
 * The render path of a quality tier: every switch comes from the (capability-adjusted) tier spec
 * (quality.ts, capabilities.ts) and every look value from the theme (theme.ts `ThemeWorld`:
 * exposure, tone mapping, grade, vignette). Two kinds (`TierSpec.output`):
 *
 * 'post' (high, ultra): three's RenderPipeline
 *   scene pass   HDR HalfFloat, MSAA `msaa`; MRT `output` + `emissive` on tiers with bloom
 *   ultra        + half-resolution GTAO, SSR on the wet pitch, lens glare (screenSpace.ts)
 *   bloom        from the EMISSIVE target only (threshold 0, `bloomMips` mips, a tight halo; see
 *                materials.ts for the glow contract)
 *   vignette     in HDR (theme `grade.vignette`)
 *   grade        in HDR, after the exposure and before the tone map: gain, lift, contrast around
 *                mid grey (in log space), saturation (theme `grade`)
 *   tone map     the theme's curve (neutral / ACES / AgX), chosen by a uniform branch, then sRGB
 *                once (`renderOutput` with NoToneMapping: the curve is already applied)
 *   FXAA         last, on tiers without MSAA (it expects the final LDR image); also where the
 *                device has no multisampled HDR target (WebGPU compatibility mode)
 *
 * 'direct' (low, "Performance"): three's DirectRenderPipeline draws the scene straight into the
 *   canvas: the same exposure, grade and tone curve (`finish`; the contrast and the vignette only
 *   when some theme uses them on this path, DIRECT_CONTRAST / DIRECT_VIGNETTE: none does today),
 *   then sRGB, run at the end
 *   of every material's fragment shader (three's `getOutput` context hook, output targets only:
 *   bakes and shadow maps are untouched). No HDR target, no MRT (glowMrt returns null on tiers
 *   without bloom, and three ignores material MRT outputs on the canvas), no composite, no FXAA:
 *   one pass, 8-bit, MSAA from the canvas (Renderer: `renderer.samples`), resolved on tile on
 *   phones. Blending happens after the tone curve (display space): additive glows add up brighter
 *   and translucent layers mix their tone-mapped colours. Its look can differ per theme
 *   (`ThemeWorld.low`, theme.ts `lookOf`). Dynamic resolution there is the canvas' pixel ratio (Renderer).
 *
 * Theme switches only write uniforms (`setTheme`): the tone-mapping curve is a uniform-selected
 * branch over the curves the themes use (`CURVES`, one curve: no branch), not the renderer's
 * toneMapping (which would recompile the output), so switching theme never compiles a shader. The
 * renderer's own toneMapping stays NoToneMapping.
 *
 * NaN hygiene: the pass targets are HalfFloat, and a single NaN texel in the emissive target would
 * blur through the bloom mips into a big black rectangle (NaN + x = NaN in the composite, NaN -> 0
 * in the final unorm write). Every read of a pass target in the composite is therefore sanitised
 * with max(0) / min(HDR_MAX) (min / max return the non-NaN operand on every backend); materials
 * sanitise their own glow writes in `glowMrt()`. The grade keeps its pow base above 0 and starts
 * with max(0), which is also what keeps a material's NaN out of the direct tier's canvas.
 *
 * Dynamic resolution scales the scene pass only (`setResolutionScale`, plus the ultra passes that
 * read its depth): the composite samples it through screen UVs, so it is upsampled to the drawing
 * buffer, and bloom (sized from the drawing buffer), the glare, the vignette and FXAA keep running
 * at full size.
 *
 * TRAA is not used on any tier: without per-object motion vectors it loses AA on moving cars
 * (prototype study); high and ultra keep MSAA x4.
 */
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  Fn,
  If,
  acesFilmicToneMapping,
  agxToneMapping,
  emissive,
  float,
  length,
  luminance,
  mix,
  mrt,
  neutralToneMapping,
  oneMinus,
  output,
  pass,
  pow,
  renderOutput,
  rtt,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { GLOW_MAX, type Vec3Node } from '../materials';
import type { TierSpec } from '../quality';
import { THEME_IDS, lookOf, themeWorld, type ThemeWorld } from '../theme';
import { buildScreenSpace, type ScreenSpaceExtras } from './screenSpace';

/** HDR ceiling applied when the composite reads a pass target (HalfFloat max is 65504). */
const HDR_MAX = 65000;
/**
 * Bloom: strength and radius of BloomNode over the tier's `bloomMips`. A low radius weights the
 * small mips (1.0, 0.8, 0.6, 0.4, 0.2 at radius 0), so lamps get a hot, tight glare with a faint
 * wide skirt instead of a grey haze over the roof.
 */
const BLOOM_STRENGTH = 0.42;
const BLOOM_RADIUS = 0.12;
/** Mid grey the contrast pivots around (linear, after exposure). */
const GRADE_PIVOT = 0.18;
type Curve = ThemeWorld['toneMapping'];
/** Uniform values of `ThemeWorld.toneMapping` (the branch in `finish`). */
const TONE_CURVES: Readonly<Record<Curve, number>> = { neutral: 0, aces: 1, agx: 2 };
/** The curves the themes use (the branch covers only these; one curve compiles no branch). */
const CURVES: readonly Curve[] = [...new Set(THEME_IDS.map((id) => themeWorld(id).toneMapping))];
/**
 * The direct path compiles only the look stages some theme uses there (its low overrides, theme.ts
 * `lookOf`): the contrast (three pow per fragment) when a theme's direct contrast differs from 1,
 * the vignette when one's is above 0. Decided over every theme, so a theme switch still compiles
 * nothing; the look runs at the end of EVERY material on that path, overdraw included.
 */
const DIRECT_LOOKS = THEME_IDS.map((id) => lookOf(themeWorld(id), 'direct').grade);
const DIRECT_CONTRAST = DIRECT_LOOKS.some((g) => g.contrast !== 1);
const DIRECT_VIGNETTE = DIRECT_LOOKS.some((g) => g.vignette > 0);

export type ScenePass = ReturnType<typeof pass>;
export type BloomPass = ReturnType<typeof bloom>;

/** One tier's render path and the passes the Renderer reads (`#nancheck`) or must dispose. */
export interface PostChain {
  /** The tier's `output`: 'direct' draws straight into the canvas, 'post' through the HDR pipeline. */
  readonly output: TierSpec['output'];
  /** Draw one frame of `scene` from `camera` into the canvas. */
  render(): void;
  /** The HDR scene pass: `output` (+ `emissive` with bloom) targets; null on the direct path. */
  readonly scenePass: ScenePass | null;
  /** The bloom chain, null on tiers without bloom. */
  readonly bloomPass: BloomPass | null;
  /** Dynamic resolution: scale the scene pass (1 = the drawing buffer's size); no-op on the direct path. */
  setResolutionScale(scale: number): void;
  /** The theme changed: exposure, tone curve, grade, vignette and the SSR wetness (uniform writes only). */
  setTheme(world: ThemeWorld): void;
  /**
   * WebGL2's parallel compile (Renderer.precompile): three's compileAsync of the scene with the
   * exact target, MRT and output processing this path renders with. Never used on WebGPU. three
   * r186 builds each object's shaders AFTER compileAsync's first await (one object per yield to the
   * main thread), so that state stays set until the compile settles: restored then, or by
   * `settle()` (Renderer.precompile's timeout: nothing must render with it afterwards). Restoring
   * it right after the call, as before, built most programs for the default context (the direct
   * path's look and sRGB missing, the post tiers' canvas instead of their HDR target and MRT):
   * wasted compiles, and the warm-up frame then compiled the real ones synchronously.
   */
  compileAsync(): { readonly promise: Promise<unknown>; settle(): void };
  /** Free what the path allocated: scene pass (HDR MSAA target + depth), ultra passes, bloom chain, FXAA's input target, the pipeline. */
  dispose(): void;
}

/** The look uniforms of one chain, written from the theme. */
interface LookUniforms {
  exposure: THREE.UniformNode<'float', number>;
  curve: THREE.UniformNode<'float', number>;
  contrast: THREE.UniformNode<'float', number>;
  saturation: THREE.UniformNode<'float', number>;
  lift: THREE.UniformNode<'vec3', THREE.Vector3>;
  gain: THREE.UniformNode<'vec3', THREE.Vector3>;
  vignette: THREE.UniformNode<'float', number>;
}

function lookUniforms(): LookUniforms {
  return {
    exposure: uniform(1),
    curve: uniform(0),
    contrast: uniform(1),
    saturation: uniform(1),
    lift: uniform(new THREE.Vector3()),
    gain: uniform(new THREE.Vector3(1, 1, 1)),
    vignette: uniform(0),
  };
}

function writeLook(u: LookUniforms, world: ThemeWorld, output: TierSpec['output']): void {
  const { exposure, grade: g } = lookOf(world, output);
  u.exposure.value = exposure;
  u.curve.value = TONE_CURVES[world.toneMapping];
  u.contrast.value = g.contrast;
  u.saturation.value = g.saturation;
  u.lift.value.set(g.lift[0], g.lift[1], g.lift[2]);
  u.gain.value.set(g.gain[0], g.gain[1], g.gain[2]);
  u.vignette.value = g.vignette;
}

/** One tone curve of the theme set (linear in, linear [0, 1] out). */
function curveOf(c: Curve, color: Vec3Node): Vec3Node {
  const one = float(1.0);
  return (c === 'aces' ? acesFilmicToneMapping(color, one) : c === 'agx' ? agxToneMapping(color, one) : neutralToneMapping(color, one)) as unknown as Vec3Node;
}

/**
 * Exposure, grade and tone curve of a linear HDR colour (linear in, linear [0, 1] out). One
 * function so the colour is evaluated once; with several curves in use the curve is a uniform
 * branch (only one runs). The first max(0) also turns a NaN into 0 (min / max return the non-NaN
 * operand).
 *
 * On the direct path this runs at the end of every material, so it is built per material: an
 * ADDITIVE material (halos, beams, flames, pads' glow, particles) adds its result to what is
 * already drawn, and a lift there would be added once per additive layer, a flat plateau over the
 * whole quad or cone (square halos round the floodlights and a solid bar for the lighthouse beam
 * on the night sky). Additive materials take no lift (their black stays black); the post path's
 * single full-screen quad is not additive and keeps it.
 */
function finish(u: LookUniforms, contrast = true): (hdr: Vec3Node) => Vec3Node {
  const fn = Fn(([input]: [Node], builder: { material?: THREE.Material | null }) => {
    // Gain (multiplies the highlights) and lift (adds to the shadows), after the exposure.
    const additive = builder.material?.blending === THREE.AdditiveBlending;
    const scaled = (input as Vec3Node).max(0.0).mul(u.exposure).mul(u.gain);
    const c = (additive ? scaled : scaled.add(u.lift)).max(0.0).toVar();
    // Contrast around mid grey in log space (pow base kept above 0: no NaN from pow(0, k) * 0);
    // left out where no theme changes it (the direct path: DIRECT_CONTRAST).
    if (contrast) {
      c.assign(pow(c.div(GRADE_PIVOT).max(1e-6), vec3(u.contrast, u.contrast, u.contrast)).mul(GRADE_PIVOT));
    }
    // Saturation around the luminance (can push a channel below 0: clamped).
    c.assign(mix(vec3(luminance(c)), c, u.saturation).max(0.0));
    const [first, ...rest] = CURVES;
    if (rest.length === 0) return curveOf(first, c);
    const out = vec3(0, 0, 0).toVar();
    let chain = If(u.curve.equal(float(TONE_CURVES[first])), () => {
      out.assign(curveOf(first, c));
    });
    for (const k of rest) {
      chain = chain.ElseIf(u.curve.equal(float(TONE_CURVES[k])), () => {
        out.assign(curveOf(k, c));
      });
    }
    return out;
  });
  return (hdr) => fn(hdr) as unknown as Vec3Node;
}

/** The theme's vignette factor at this pixel (1 in the middle). */
function vignetteOf(u: LookUniforms): Node<'float'> {
  const uvc = screenUV.sub(0.5).mul(vec2(1.0, 0.8));
  return oneMinus(smoothstep(0.45, 1.1, length(uvc).mul(1.6)).mul(u.vignette));
}

/**
 * Build the render path of tier `spec` (already adjusted to the device: capabilities.ts) for
 * `scene` / `camera`, with the look of theme `world`. The renderer's own tone mapping is switched
 * off: both paths apply the theme's curve themselves.
 */
export function buildPostChain(gpu: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, spec: TierSpec, world: ThemeWorld): PostChain {
  gpu.toneMapping = THREE.NoToneMapping;
  gpu.toneMappingExposure = 1;
  return spec.output === 'direct' ? buildDirect(gpu, scene, camera, world) : buildHdr(gpu, scene, camera, spec, world);
}

/** 'direct': three's DirectRenderPipeline with the look at the end of every material (see the file header). */
function buildDirect(gpu: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, world: ThemeWorld): PostChain {
  const look = lookUniforms();
  writeLook(look, world, 'direct');
  // The material's output (fog included) -> vignette, exposure, grade, curve; alpha kept for the
  // blending. The pipeline then applies sRGB (renderOutput with the renderer's NoToneMapping).
  // Only the stages some theme uses on this path (DIRECT_CONTRAST, DIRECT_VIGNETTE).
  const lit = DIRECT_VIGNETTE ? output.rgb.mul(vignetteOf(look)) : output.rgb;
  const pipeline = new THREE.DirectRenderPipeline(gpu, vec4(finish(look, DIRECT_CONTRAST)(lit), output.a));
  // three r186 internals (pinned to 0.186.x): the context the pipeline renders with.
  const internals = pipeline as unknown as { _update(): void; _contextNode: THREE.ContextNode<unknown> | null };
  return {
    output: 'direct',
    scenePass: null,
    bloomPass: null,
    render() {
      pipeline.render(scene, camera);
    },
    setResolutionScale() {
      /* the Renderer scales the canvas' pixel ratio instead */
    },
    setTheme(w) {
      writeLook(look, w, 'direct');
    },
    compileAsync() {
      // DirectRenderPipeline.render() swaps these in around renderer.render(); the deferred node
      // builds of compileAsync read them until it settles (see PostChain.compileAsync).
      internals._update();
      const ctx = internals._contextNode;
      if (ctx === null) return { promise: Promise.resolve(), settle() {} };
      const prevCtx = gpu.contextNode;
      const tone = gpu.toneMapping;
      const space = gpu.outputColorSpace;
      gpu.contextNode = ctx;
      gpu.toneMapping = THREE.NoToneMapping;
      gpu.outputColorSpace = THREE.ColorManagement.workingColorSpace;
      let held = true;
      const settle = (): void => {
        if (!held) return;
        held = false;
        gpu.contextNode = prevCtx;
        gpu.toneMapping = tone;
        gpu.outputColorSpace = space;
      };
      const promise = gpu.compileAsync(scene, camera).finally(settle);
      return { promise, settle };
    },
    dispose() {
      pipeline.dispose();
    },
  };
}

/** 'post': the HDR RenderPipeline (see the file header). */
function buildHdr(gpu: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, spec: TierSpec, world: ThemeWorld): PostChain {
  const look = lookUniforms();
  writeLook(look, world, 'post');

  // Scene pass: HDR HalfFloat target, MSAA on the tiers that ask for it (the post tiers' final
  // quad is single-sampled whatever the renderer's samples: three renders full-screen passes with
  // 0). The WebGPU backend only supports 1 or 4 samples, hence the table's 4 / 0.
  const scenePass = pass(scene, camera, { samples: spec.msaa });
  // Every pass target is read through `sanitize`: min / max return the non-NaN operand, so a NaN
  // or Inf texel written by a material becomes 0 / HDR_MAX here instead of poisoning the bloom
  // blur (one NaN at a coarse mip upsamples to a big black rectangle) or the tone map.
  const sanitize = (c: Node<'vec4'>): Vec3Node => c.rgb.max(0.0).min(HDR_MAX);
  let hdr: Vec3Node = sanitize(scenePass.getTextureNode('output'));
  let bloomPass: BloomPass | null = null;
  if (spec.bloom) {
    // Bloom reads the emissive MRT target (cleared to black), so only tagged emitters glow.
    // Lit materials without an mrtNode (ball, car bodies) write their emissiveNode through this
    // pass-level MRT, raw: clamp it like glowMrt() does so a NaN / Inf / negative emissive term
    // (e.g. the ball's hex seam weights rounding past 1) never reaches the bloom chain. The
    // member keeps three's default NoBlending for this target.
    scenePass.setMRT(mrt({ output, emissive: emissive.max(0.0).min(GLOW_MAX) }).setClearColor('emissive', 0x000000, 0));
    bloomPass = bloom(vec4(sanitize(scenePass.getTextureNode('emissive')), 1.0), BLOOM_STRENGTH, BLOOM_RADIUS, 0);
    // `_nMips` is private to BloomNode (three is pinned to 0.186.x); 5 is also its default.
    const mips = bloomPass as unknown as { _nMips?: number };
    if (typeof mips._nMips === 'number') mips._nMips = spec.bloomMips;
    else console.warn('BloomNode private API changed; bloom falls back to 5 mips');
  }

  // Ultra: AO and wet reflections shade the lit colour; the glare adds after the bloom (it reads
  // the bloom's first mip, so the bloom is referenced first in the graph and renders first).
  const extras: ScreenSpaceExtras | null = buildScreenSpace(scenePass, camera, bloomPass, spec, world);
  if (extras !== null) hdr = extras.shade(hdr);
  if (bloomPass !== null) hdr = hdr.add(sanitize(bloomPass));
  if (extras !== null && extras.glare !== null) hdr = hdr.add(extras.glare);

  // Vignette in HDR, then exposure, grade and tone curve, then sRGB once (outputColorTransform
  // is off so the FXAA pass of the tiers without MSAA runs on the final LDR image, as it expects).
  const toned = finish(look)(hdr.mul(vignetteOf(look)));
  const ldr = renderOutput(vec4(toned, 1.0), THREE.NoToneMapping);
  const pipeline = new THREE.RenderPipeline(gpu);
  pipeline.outputColorTransform = false;
  // FXAA samples its input as a texture. Given a plain node, fxaa() wraps it in an RTTNode of its
  // own (a drawing-buffer-sized HalfFloat target + depth) that nothing could dispose: every switch
  // to a tier without MSAA leaked one. The chain owns that target instead (no depth: a quad needs
  // none) and frees it in dispose().
  const ldrTarget = spec.msaa > 0 ? null : rtt(ldr, null, null, { depthBuffer: false });
  pipeline.outputNode = ldrTarget === null ? ldr : fxaa(ldrTarget);

  return {
    output: 'post',
    scenePass,
    bloomPass,
    render() {
      pipeline.render();
    },
    setResolutionScale(scale) {
      scenePass.setResolutionScale(scale);
      if (extras !== null) extras.setResolutionScale(scale);
    },
    setTheme(w) {
      writeLook(look, w, 'post');
      if (extras !== null) extras.setTheme(w);
    },
    compileAsync() {
      // The scene pass's target and MRT, held until the deferred node builds are done (see
      // PostChain.compileAsync).
      const prevTarget = gpu.getRenderTarget();
      const prevMrt = gpu.getMRT();
      gpu.setRenderTarget(scenePass.renderTarget);
      gpu.setMRT(scenePass.getMRT());
      let held = true;
      const settle = (): void => {
        if (!held) return;
        held = false;
        gpu.setRenderTarget(prevTarget);
        gpu.setMRT(prevMrt);
      };
      const promise = gpu.compileAsync(scene, camera).finally(settle);
      return { promise, settle };
    },
    dispose() {
      // RenderPipeline.dispose() only frees its quad material: the passes go first.
      if (extras !== null) extras.dispose();
      if (bloomPass !== null) bloomPass.dispose();
      if (ldrTarget !== null) ldrTarget.dispose();
      scenePass.dispose();
      pipeline.dispose();
    },
  };
}

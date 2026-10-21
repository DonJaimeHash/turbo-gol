/**
 * The render pipeline of a quality tier: every switch comes from the tier table (quality.ts) and
 * every look value from the theme (theme.ts `ThemeWorld`: exposure, tone mapping, grade, vignette).
 *
 *   scene pass   HDR HalfFloat, MSAA `msaa`; MRT `output` + `emissive` on tiers with bloom
 *   ultra        + half-resolution GTAO, SSR on the wet pitch, lens glare (screenSpace.ts)
 *   bloom        from the EMISSIVE target only (threshold 0, `bloomMips` mips, a tight halo; see
 *                materials.ts for the glow contract)
 *   vignette     in HDR (theme `grade.vignette`)
 *   grade        in HDR, after the exposure and before the tone map: gain, lift, contrast around
 *                mid grey (in log space), saturation (theme `grade`)
 *   tone map     the theme's curve (neutral / ACES / AgX), chosen by a uniform branch, then sRGB
 *                once (`renderOutput` with NoToneMapping: the curve is already applied)
 *   FXAA         last, on tiers without MSAA (it expects the final LDR image)
 *
 * Theme switches only write uniforms (`setTheme`): the tone-mapping curve is a uniform-selected
 * branch, not the renderer's toneMapping (which would recompile the output quad), so switching
 * theme never compiles a shader. The renderer's own toneMapping stays NoToneMapping.
 *
 * NaN hygiene: the pass targets are HalfFloat, and a single NaN texel in the emissive target would
 * blur through the bloom mips into a big black rectangle (NaN + x = NaN in the composite, NaN -> 0
 * in the final unorm write). Every read of a pass target in the composite is therefore sanitised
 * with max(0) / min(HDR_MAX) (min / max return the non-NaN operand on every backend); materials
 * sanitise their own glow writes in `glowMrt()`. The grade keeps its pow base above 0.
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
import { tier, type Quality } from '../quality';
import type { ThemeWorld } from '../theme';
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
/** Uniform values of `ThemeWorld.toneMapping` (the branch in `toneMap`). */
const TONE_CURVES = { neutral: 0, aces: 1, agx: 2 } as const;

export type ScenePass = ReturnType<typeof pass>;
export type BloomPass = ReturnType<typeof bloom>;

/** One tier's pipeline and the passes the Renderer reads (`#nancheck`) or must dispose. */
export interface PostChain {
  readonly pipeline: THREE.RenderPipeline;
  /** The HDR scene pass: `output` (+ `emissive` with bloom) targets. */
  readonly scenePass: ScenePass;
  /** The bloom chain, null on tiers without bloom. */
  readonly bloomPass: BloomPass | null;
  /** Dynamic resolution: scale the scene pass (1 = the drawing buffer's size). */
  setResolutionScale(scale: number): void;
  /** The theme changed: exposure, tone curve, grade, vignette and the SSR wetness (uniform writes only). */
  setTheme(world: ThemeWorld): void;
  /** Free the scene pass (HDR MSAA target + depth), the ultra passes, the bloom chain and the pipeline's quad. */
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

function writeLook(u: LookUniforms, world: ThemeWorld): void {
  const g = world.grade;
  u.exposure.value = world.exposure;
  u.curve.value = TONE_CURVES[world.toneMapping];
  u.contrast.value = g.contrast;
  u.saturation.value = g.saturation;
  u.lift.value.set(g.lift[0], g.lift[1], g.lift[2]);
  u.gain.value.set(g.gain[0], g.gain[1], g.gain[2]);
  u.vignette.value = g.vignette;
}

/**
 * Exposure, grade and tone curve of a sanitised HDR colour (linear in, linear [0, 1] out). One
 * function so the colour is evaluated once; the curve is a uniform branch (only one runs).
 */
function finish(u: LookUniforms): (hdr: Vec3Node) => Vec3Node {
  const fn = Fn(([input]: [Node]) => {
    // Gain (multiplies the highlights) and lift (adds to the shadows), after the exposure.
    const c = (input as Vec3Node).mul(u.exposure).mul(u.gain).add(u.lift).max(0.0).toVar();
    // Contrast around mid grey in log space (pow base kept above 0: no NaN from pow(0, k) * 0).
    c.assign(pow(c.div(GRADE_PIVOT).max(1e-6), vec3(u.contrast, u.contrast, u.contrast)).mul(GRADE_PIVOT));
    // Saturation around the luminance (can push a channel below 0: clamped).
    c.assign(mix(vec3(luminance(c)), c, u.saturation).max(0.0));
    const out = vec3(0, 0, 0).toVar();
    If(u.curve.equal(float(TONE_CURVES.aces)), () => {
      out.assign(acesFilmicToneMapping(c, float(1.0)));
    })
      .ElseIf(u.curve.equal(float(TONE_CURVES.agx)), () => {
        out.assign(agxToneMapping(c, float(1.0)));
      })
      .Else(() => {
        out.assign(neutralToneMapping(c, float(1.0)));
      });
    return out;
  });
  return (hdr) => fn(hdr) as unknown as Vec3Node;
}

/**
 * Build the pipeline of tier `quality` for `scene` / `camera`, with the look of theme `world`.
 * The renderer's own tone mapping is switched off: the chain applies the theme's curve itself.
 */
export function buildPostChain(
  gpu: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  quality: Quality,
  world: ThemeWorld,
): PostChain {
  const spec = tier(quality);
  gpu.toneMapping = THREE.NoToneMapping;
  gpu.toneMappingExposure = 1;
  const look = lookUniforms();
  writeLook(look, world);

  // Scene pass: HDR HalfFloat target, MSAA on the tiers that ask for it (the renderer itself is
  // created without antialias so nothing else is multisampled). The WebGPU backend only supports
  // 1 or 4 samples, hence the table's 4 / 0.
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
  const uvc = screenUV.sub(0.5).mul(vec2(1.0, 0.8));
  const vignette = oneMinus(smoothstep(0.45, 1.1, length(uvc).mul(1.6)).mul(look.vignette));
  const toned = finish(look)(hdr.mul(vignette));
  const ldr = renderOutput(vec4(toned, 1.0), THREE.NoToneMapping);
  const pipeline = new THREE.RenderPipeline(gpu);
  pipeline.outputColorTransform = false;
  pipeline.outputNode = spec.msaa > 0 ? ldr : fxaa(ldr);

  return {
    pipeline,
    scenePass,
    bloomPass,
    setResolutionScale(scale) {
      scenePass.setResolutionScale(scale);
      if (extras !== null) extras.setResolutionScale(scale);
    },
    setTheme(w) {
      writeLook(look, w);
      if (extras !== null) extras.setTheme(w);
    },
    dispose() {
      // RenderPipeline.dispose() only frees its quad material: the passes go first.
      if (extras !== null) extras.dispose();
      if (bloomPass !== null) bloomPass.dispose();
      scenePass.dispose();
      pipeline.dispose();
    },
  };
}

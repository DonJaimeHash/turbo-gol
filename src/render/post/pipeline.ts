/**
 * The render pipeline of a quality tier (moved from Renderer.applyQuality): every switch comes from
 * the tier table, so the post phase of docs/visuals/REWORK.md (grade per theme, GTAO / SSR / lens
 * flare on ultra) only changes this file and the table.
 *
 *   scene pass (HDR HalfFloat; MSAA `msaa`; MRT `output` + `emissive` on tiers with bloom)
 *   -> bloom from the EMISSIVE target only (threshold 0, `bloomMips` mips; see materials.ts for
 *      the glow contract) -> vignette -> Neutral tone mapping + sRGB once (`renderOutput`)
 *   -> FXAA on tiers without MSAA.
 *
 * NaN hygiene: the pass targets are HalfFloat, and a single NaN texel in the emissive target would
 * blur through the bloom mips into a big black rectangle (NaN + x = NaN in the composite, NaN -> 0
 * in the final unorm write). Every read of a pass target in the composite is therefore sanitised
 * with max(0) / min(HDR_MAX) (min / max return the non-NaN operand on every backend); materials
 * sanitise their own glow writes in `glowMrt()`.
 *
 * Dynamic resolution scales the scene pass only (`setResolutionScale`): the composite samples it
 * through screen UVs, so it is upsampled to the drawing buffer, and bloom (sized from the drawing
 * buffer), the vignette and FXAA keep running at full size.
 */
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { emissive, length, mrt, oneMinus, output, pass, renderOutput, screenUV, smoothstep, vec2, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { GLOW_MAX, type Vec3Node } from '../materials';
import { tier, type Quality } from '../quality';
import type { ThemeWorld } from '../theme';

/** HDR ceiling applied when the composite reads a pass target (HalfFloat max is 65504). */
const HDR_MAX = 65000;
/** Tone mapping and exposure of the final image (the theme's own values come with the post phase). */
const TONE_MAPPING = THREE.NeutralToneMapping;
const EXPOSURE = 1.15;
/** Vignette strength (darkening at the corners) and its shape. */
const VIGNETTE = 0.32;

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
  /** Free the scene pass (HDR MSAA target + depth), the bloom chain and the pipeline's quad. */
  dispose(): void;
}

/**
 * Build the pipeline of tier `quality` for `scene` / `camera`, and set the renderer's tone mapping
 * and exposure (renderOutput applies them). `world` is the theme's shared facts; the post phase
 * reads its tone mapping, exposure and grade, today's values are kept for now.
 */
export function buildPostChain(
  gpu: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  quality: Quality,
  world: ThemeWorld,
): PostChain {
  const spec = tier(quality);
  void world;
  // Read by the pipeline when it is created (and by renderOutput below).
  gpu.toneMapping = TONE_MAPPING;
  gpu.toneMappingExposure = EXPOSURE;

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
    bloomPass = bloom(vec4(sanitize(scenePass.getTextureNode('emissive')), 1.0), 0.5, 0.45, 0);
    // Three mips (the table's bloomMips) give a tight glow (mips 3-4 are only ~1.5% of the blur
    // fill, so this is a look choice, not a saving). `_nMips` is private to BloomNode; three is
    // pinned to 0.186.x.
    const mips = bloomPass as unknown as { _nMips?: number };
    if (typeof mips._nMips === 'number') mips._nMips = spec.bloomMips;
    else console.warn('BloomNode private API changed; bloom falls back to 5 mips');
    hdr = hdr.add(sanitize(bloomPass));
  }

  // Subtle vignette in HDR, then tone mapping + sRGB once (outputColorTransform is off so the
  // FXAA pass of the tiers without MSAA runs on the final LDR image, which is what it expects).
  const uvc = screenUV.sub(0.5).mul(vec2(1.0, 0.8));
  const vignette = oneMinus(smoothstep(0.45, 1.1, length(uvc).mul(1.6)).mul(VIGNETTE));
  const shaded = vec4(hdr.mul(vignette), 1.0);
  const ldr = renderOutput(shaded);
  const pipeline = new THREE.RenderPipeline(gpu);
  pipeline.outputColorTransform = false;
  pipeline.outputNode = spec.msaa > 0 ? ldr : fxaa(ldr);

  return {
    pipeline,
    scenePass,
    bloomPass,
    setResolutionScale(scale) {
      scenePass.setResolutionScale(scale);
    },
    dispose() {
      // RenderPipeline.dispose() only frees its quad material: the passes go first.
      if (bloomPass !== null) bloomPass.dispose();
      scenePass.dispose();
      pipeline.dispose();
    },
  };
}

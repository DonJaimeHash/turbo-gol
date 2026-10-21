/**
 * The ultra tier's screen-space extras, built on the scene pass of post/pipeline.ts:
 *
 *   half depth  the MSAA scene depth copied (sample 0) into a plain half-resolution DepthTexture
 *               (quadPass.ts): GTAO gathers depth and WGSL cannot gather a multisampled texture;
 *               both effects also read less memory at half size
 *   GTAO        three's ground-truth AO at half resolution, normals rebuilt from the depth (no
 *               normal MRT target: the scene pass keeps its two targets). No temporal filter
 *               (there is no TRAA, see below): the composite softens its noise with four bilinear
 *               taps (a 4x4 box of AO texels) and applies it at AO_STRENGTH
 *   SSR         three's screen-space reflections at half resolution, ONLY on wet pitch pixels:
 *               the mask is rebuilt from the depth (world height of the pixel ~ 0, i.e. the turf)
 *               times the theme's wetness, so no material has to write a mask target; the pitch
 *               normal is the exact world up (the turf is a plane), hit normals come from depth.
 *               Its roughness blur gives the soft, smeared reflections of wet grass
 *   glare       a procedural streak (anamorphic, horizontal) and three lens ghosts from the
 *               brightest emissive (the bloom's first blurred mip, above GLARE_THRESHOLD), one
 *               quarter-resolution pass
 *
 * TRAA is deliberately not used: without per-object motion vectors it lost AA on moving cars in
 * the prototype study; the scene keeps MSAA x4.
 *
 * NaN hygiene: every texture these passes write is read back through max(0) / min(HDR_MAX) (AO
 * through saturate) and every computed uv is saturated, as in the pipeline.
 *
 * Dynamic resolution: the half-depth copy, GTAO and SSR follow the scene pass' scale
 * (`setResolutionScale`); the glare is sized from the bloom, i.e. the drawing buffer.
 */
import * as THREE from 'three/webgpu';
import type { Node, TextureNode } from 'three/webgpu';
import {
  distance,
  float,
  getNormalFromDepth,
  getViewPosition,
  int,
  mix,
  oneMinus,
  pow,
  sample,
  saturate,
  screenUV,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import type { FloatNode, Vec2Node, Vec3Node } from '../materials';
import type { TierSpec } from '../quality';
import type { ThemeWorld } from '../theme';
import { QuadPassNode } from './quadPass';
import type { BloomPass, ScenePass } from './pipeline';

/** HDR ceiling of every read (same as the pipeline's). */
const HDR_MAX = 65000;

/** GTAO: view-space radius and thickness (uu), sample count (baked into its shader), strength in the composite. */
const AO_RADIUS = 90;
const AO_THICKNESS = 60;
const AO_SAMPLES = 8;
const AO_STRENGTH = 0.75;

/** SSR: pixels whose |world height| is below FLOOR_Y0 are pitch (fading out by FLOOR_Y1, uu). */
const FLOOR_Y0 = 4;
const FLOOR_Y1 = 14;
/** SSR march: quality (fraction of texels stepped), plane distance a reflection may reach (uu), hit thickness (uu). */
const SSR_QUALITY = 0.22;
const SSR_MAX_DISTANCE = 1400;
const SSR_THICKNESS = 45;
/** Blur roughness of the wet-grass reflection, the brightest reflected luminance, and its gain in the composite. */
const SSR_ROUGHNESS = 0.6;
const SSR_MAX_LUMINANCE = 6;
const SSR_GAIN = 0.6;

/** Glare: bright-part threshold (linear HDR of the blurred emissive), streak reach (uv per tap) and gains. */
const GLARE_THRESHOLD = 0.75;
const STREAK_TAPS = 24;
const STREAK_STEP = 0.005;
const STREAK_GAIN = 0.18;
const STREAK_TINT: readonly [number, number, number] = [0.75, 0.85, 1.0];
const GHOST_SPACING = 0.34;
const GHOST_GAIN = 0.15;
const GHOST_TINTS: readonly (readonly [number, number, number])[] = [
  [1.0, 0.75, 0.45],
  [0.5, 0.85, 1.0],
  [0.85, 0.6, 1.0],
];

export interface ScreenSpaceExtras {
  /** The lit HDR colour (before bloom) with AO and wet reflections. */
  shade(hdr: Vec3Node): Vec3Node;
  /** The glare to add after the bloom (null without lens flare). */
  readonly glare: Vec3Node | null;
  /** Dynamic resolution: the scene pass' scale. */
  setResolutionScale(scale: number): void;
  /** The theme changed (wetness of the SSR mask). */
  setTheme(world: ThemeWorld): void;
  dispose(): void;
}

/**
 * Build the extras the tier asks for (`gtao`, `ssr`, `lensFlare`); null when it asks for none.
 * The glare needs the bloom chain (it reads its first mip), so it is skipped without bloom.
 */
export function buildScreenSpace(
  scenePass: ScenePass,
  camera: THREE.PerspectiveCamera,
  bloomPass: BloomPass | null,
  spec: TierSpec,
  world: ThemeWorld,
): ScreenSpaceExtras | null {
  const wantFlare = spec.lensFlare && bloomPass !== null;
  if (!spec.gtao && !spec.ssr && !wantFlare) return null;
  const owned: { dispose(): void }[] = [];
  const sanitize = (c: Node): Vec3Node => (c as Vec3Node).max(0.0).min(HDR_MAX);

  // Half-resolution single-sample depth (sample 0 of the MSAA depth) for GTAO and SSR.
  let depthCopy: QuadPassNode | null = null;
  let halfDepth: TextureNode | null = null;
  if (spec.gtao || spec.ssr) {
    const sceneDepth = scenePass.getTextureNode('depth');
    depthCopy = new QuadPassNode('post.halfDepth', vec4(0), {
      scaleX: 0.5,
      scaleY: 0.5,
      type: THREE.UnsignedByteType,
      format: THREE.RedFormat,
      depthNode: sceneDepth.r,
    });
    owned.push(depthCopy);
    halfDepth = depthCopy.getDepthNode();
  }

  // Camera matrices by reference: three updates them in place, the uniforms read them every frame.
  const projInv = uniform(camera.projectionMatrixInverse);
  const camWorld = uniform(camera.matrixWorld);
  const viewMatrix = uniform(camera.matrixWorldInverse);
  const wetness = uniform(world.wetness);

  let aoPass: ReturnType<typeof ao> | null = null;
  if (spec.gtao && halfDepth !== null) {
    aoPass = ao(halfDepth, null as unknown as Node, camera);
    aoPass.resolutionScale = 0.5;
    aoPass.radius.value = AO_RADIUS;
    aoPass.thickness.value = AO_THICKNESS;
    aoPass.samples.value = AO_SAMPLES;
    aoPass.scale.value = 1;
    owned.push(aoPass);
  }

  let ssrPass: ReturnType<typeof ssr> | null = null;
  if (spec.ssr && halfDepth !== null) {
    const depthTex = halfDepth;
    /**
     * 1 on pitch pixels (world height ~ 0), 0 elsewhere; the background (depth 1) is discarded by
     * SSR itself. |height|, not height: a surface visible BELOW the pitch plane (ground or stand
     * bases outside the cage) is not wet turf and must not reflect with the pitch's up normal.
     */
    const pitchMask = (u: Vec2Node): FloatNode => {
      const d = depthTex.sample(saturate(u)).r;
      const viewPos = getViewPosition(saturate(u), d, projInv) as Vec3Node;
      const worldY = camWorld.mul(vec4(viewPos, 1.0)).y;
      return oneMinus(smoothstep(FLOOR_Y0, FLOOR_Y1, worldY.abs()));
    };
    const viewUp = viewMatrix.mul(vec4(0.0, 1.0, 0.0, 0.0)).xyz.normalize();
    // Normals: SSR reads `normalNode` once at the reflecting pixel (setup) and samples it at each
    // hit. The reflecting pixel is pitch (the mask discards everything else), and the pitch is a
    // plane: its exact up normal, for free. Hit points (cars, ball, boards) rebuild theirs from
    // the depth (9 loads, only on the march's hit).
    const normals = sample((u: Node) => getNormalFromDepth(saturate(u as Vec2Node), depthTex, projInv));
    (normals as unknown as { setup(): Node }).setup = () => viewUp;
    ssrPass = ssr(scenePass.getTextureNode('output'), depthTex, normals as unknown as Node<'vec3'>, {
      metalnessNode: pitchMask(uv()).mul(wetness),
      roughnessNode: float(SSR_ROUGHNESS),
      camera,
    });
    ssrPass.resolutionScale = 0.5;
    ssrPass.quality.value = SSR_QUALITY;
    ssrPass.maxDistance.value = SSR_MAX_DISTANCE;
    ssrPass.thickness.value = SSR_THICKNESS;
    ssrPass.maxLuminance.value = SSR_MAX_LUMINANCE;
    owned.push(ssrPass);
  }

  let glare: Vec3Node | null = null;
  if (wantFlare && bloomPass !== null) {
    // The bloom's first fully blurred mip (half resolution): private to BloomNode, three is pinned
    // to 0.186.x (the pipeline relies on the same internals for `_nMips` and #nancheck).
    const mips = (bloomPass as unknown as { _renderTargetsVertical?: THREE.RenderTarget[] })._renderTargetsVertical;
    if (mips !== undefined && mips.length > 0) {
      const src = mips[0].texture;
      const bright = (u: Vec2Node): Vec3Node => (texture(src, saturate(u)).rgb as Vec3Node).max(0.0).min(HDR_MAX).sub(GLARE_THRESHOLD).max(0.0);
      const p = uv();
      // Streak: symmetric horizontal taps, exponential falloff (a lens-coating smear of the lamps).
      let streak: Vec3Node = bright(p).mul(1.0);
      for (let i = 1; i <= STREAK_TAPS; i++) {
        const w = Math.exp((-3.0 * i) / STREAK_TAPS);
        const pair = bright(p.add(vec2(i * STREAK_STEP, 0))).add(bright(p.sub(vec2(i * STREAK_STEP, 0))));
        streak = streak.add(pair.mul(w));
      }
      // Ghosts: the bright parts mirrored through the centre (pseudo lens flare), fading off-centre.
      const mirrored = vec2(1.0, 1.0).sub(p);
      const ghostVec = vec2(0.5, 0.5).sub(mirrored).mul(GHOST_SPACING);
      let ghosts: Vec3Node = vec3(0, 0, 0);
      for (let k = 0; k < GHOST_TINTS.length; k++) {
        const g = mirrored.add(ghostVec.mul(k + 1));
        const fade = pow(saturate(oneMinus(distance(saturate(g), vec2(0.5, 0.5)).mul(1.6))), 3.0);
        const t = GHOST_TINTS[k];
        ghosts = ghosts.add(bright(g).mul(vec3(t[0], t[1], t[2])).mul(fade));
      }
      const glareFrag = vec4(streak.mul(vec3(STREAK_TINT[0], STREAK_TINT[1], STREAK_TINT[2])).mul(STREAK_GAIN).add(ghosts.mul(GHOST_GAIN)), 1.0);
      const glarePass = new QuadPassNode('post.glare', glareFrag, { scaleX: 0.25, scaleY: 0.25 });
      owned.push(glarePass);
      glare = sanitize(glarePass.getTextureNode().rgb);
    } else {
      console.warn('BloomNode private API changed; no lens glare');
    }
  }

  const aoTex = aoPass !== null ? aoPass.getTextureNode() : null;
  const ssrTex = ssrPass !== null ? ssrPass.getTextureNode() : null;

  return {
    glare,
    shade(hdr) {
      let out = hdr;
      if (aoTex !== null) {
        // Four bilinear taps one AO texel off-centre: a 4x4 box that hides the per-pixel noise.
        const texel = vec2(1.0, 1.0).div(vec2(aoTex.size(int(0)) as unknown as Node<'ivec2'>));
        const s = screenUV;
        const tap = (dx: number, dy: number): FloatNode => aoTex.sample(saturate(s.add(texel.mul(vec2(dx, dy))))).r as FloatNode;
        const occlusion = saturate(tap(-1, -1).add(tap(1, -1)).add(tap(-1, 1)).add(tap(1, 1)).mul(0.25));
        out = out.mul(mix(float(1.0), occlusion, AO_STRENGTH));
      }
      if (ssrTex !== null) out = out.add(sanitize(ssrTex.rgb).mul(SSR_GAIN));
      return out;
    },
    setResolutionScale(scale) {
      if (depthCopy !== null) depthCopy.resolutionScale = scale;
      if (aoPass !== null) aoPass.resolutionScale = 0.5 * scale;
      if (ssrPass !== null) ssrPass.resolutionScale = 0.5 * scale;
    },
    setTheme(w) {
      wetness.value = w.wetness;
    },
    dispose() {
      for (const d of owned) d.dispose();
    },
  };
}

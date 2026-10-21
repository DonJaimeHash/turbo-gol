/**
 * The pitch material: wet, freshly mown grass with painted markings, built from the load-time bakes
 * of bake.ts (no image files). One node graph per tier (the tier switch rebuilds the views); a theme
 * writes only uniforms (`TurfUniforms`) and re-bakes the pool map, so it never recompiles.
 *
 * What makes it read as grass (all procedural):
 *   - The baked blade field, mipmapped and anisotropic (the filter anti-aliases the blades: no
 *     shimmer at distance or at grazing angles), read as the detail, a clump-scale rotated copy
 *     and (relief tiers) a second rotated copy at 2.37x that hides the tiling.
 *   - View-dependent mowing stripes: each band's blades are bent one way, so a band bent away from
 *     the viewer looks lighter and the stripes flip when the camera turns round, like real turf.
 *   - The field map: wear (paler trampled grass near the centre spot and in front of the goals,
 *     bare soil in the goal mouths), damp patches, puddle basins and colour variation.
 *   - Paint IN the grass: ragged edges near the camera, paint mostly on the blade tips.
 *   - Wetness: damp darkening, water films between the blades and (tiers with puddles) soft,
 *     subtle puddles in the basins (~20 % coverage, wide soft rims, never mirror cut-outs). The
 *     damp sheen is one clear-coat-like lobe: the water flattens the grass normal and smooths its
 *     roughness where it lies (never below SHEEN_ROUGHNESS).
 *   - The theme's floodlights: their pools baked into the pool map (static diffuse light, added as
 *     albedo x irradiance) and their analytic GGX streaks on the wet turf (tier.turfStreaks heads,
 *     lobe widened by the lamp size and by distance so far streaks stretch instead of glittering).
 *   - Relief tiers: parallax-occlusion relief through the blade heights near the camera, blade
 *     normals, and a one-tap self-shadow of the blades toward the main key out to mid distance.
 *     Low is flat filtered (the geometric normal).
 *
 * Gameplay readability kept from the old floor: every marking (markings.ts), the faint team tint of
 * each half, team-tinted goal floors and the pulsing goal-mouth glow, which is the ONLY floor term in
 * the glow MRT (`glowMrt(..., 'none')`: the streaks, pools and line lift never bloom).
 *
 * Cost at 1600x900 CSS (dpr 1.37, chase camera, the floor's share of the frame): ~0.2 ms on low,
 * ~0.5 ms on high (docs/visuals/REWORK.md budgets 0.25 / 0.6). A MeshPhysical clear coat measured
 * 0.18 ms more on high and mirrored the directional keys as one big glare, so it is not used.
 *
 * NaN hygiene: every uv into a clamped map is saturated, every pow / sqrt / log2 argument is
 * saturated or kept positive, every normalize has a non-zero argument (normals are (x, 1, z)
 * shaped), every smoothstep has distinct edges, and the lamp vectors never vanish (the heads are far
 * above the pitch; their distance is clamped to >= 1 uu anyway).
 */
import * as THREE from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import {
  Fn,
  If,
  abs,
  cameraPosition,
  cameraViewMatrix,
  dFdx,
  dFdy,
  dot,
  float,
  fract,
  fwidth,
  inverseSqrt,
  length,
  log2,
  max,
  min,
  mix,
  normalize,
  oneMinus,
  pmremTexture,
  positionWorld,
  pow,
  saturate,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  transformDirection,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { ARENA } from '../../sim/constants';
import { TEAM_BLUE, TEAM_RED, glowMrt, linearVec3, type FloatNode, type FloatUniform, type Vec2Node, type Vec3Node } from '../materials';
import type { TierSpec } from '../quality';
import { BLADE_FIELD_SIZE, FIELD_MAP, GRASS_HEIGHT, LAMP_REF_DISTANCE, POOL_MAP, POOL_MAX, TURF_TILE, type FloorMapRect } from './bake';
import { markingsCoverage } from './markings';

export type Vec3Uniform = UniformNode<'vec3', THREE.Vector3>;
type Vec4Node = Node<'vec4'>;
type LampPosArray = ReturnType<typeof uniformArray<'vec4'>>;
type LampColArray = ReturnType<typeof uniformArray<'vec3'>>;

/** Everything a theme (or the integration phase) may tune at runtime: uniform writes only. */
export interface TurfUniforms {
  /** 0 dry .. 1 soaked (themeWorld().wetness). */
  readonly wetness: FloatUniform;
  /** Share of the pitch under water (TurfLook.puddles x wetness; tiers with puddles). */
  readonly puddleLevel: FloatUniform;
  readonly stripes: FloatUniform;
  /** Gain of the baked pools and of the analytic streaks. */
  readonly pools: FloatUniform;
  readonly streaks: FloatUniform;
  /** Yellowing 0..1 and the grass colour multiplier. */
  readonly dry: FloatUniform;
  readonly tint: Vec3Uniform;
  /** Self-illumination of the paint (1 at night, lower by day). */
  readonly lineLift: FloatUniform;
  /** Team tint strength of the halves (1 = default). */
  readonly team: FloatUniform;
  /** Unit vector toward the main key light (self-shadow of the blades on the relief tiers). */
  readonly keyDir: Vec3Uniform;
  /** Brightest environment radiance the turf reflects (CappedEnvironmentNode; per theme, night / day). */
  readonly envMax: FloatUniform;
  /** Share of the key lights' direct specular the turf keeps (TurfLightingModel; per theme, night / day). */
  readonly keySpecular: FloatUniform;
  /** How much the pool map shapes the key lights (poolKeyGain: 0 none .. 1 fully; per theme). */
  readonly poolKeys: FloatUniform;
  /** Streak heads: xyz = position (uu), w = source radius (uu); colour = linear RGB x strength. */
  readonly lampPos: LampPosArray;
  readonly lampCol: LampColArray;
  readonly lampCount: number;
}

export interface TurfTextures {
  readonly blades: THREE.Texture;
  readonly field: THREE.Texture;
  readonly pools: THREE.Texture;
}

/** Uniforms with neutral values and `lampCount` dark streak slots (TurfView.setTheme fills them). */
export function createTurfUniforms(lampCount: number): TurfUniforms {
  const pos: THREE.Vector4[] = [];
  const col: THREE.Vector3[] = [];
  for (let i = 0; i < lampCount; i++) {
    pos.push(new THREE.Vector4(0, 10000, 0, 260));
    col.push(new THREE.Vector3(0, 0, 0));
  }
  return {
    wetness: uniform(0),
    puddleLevel: uniform(0),
    stripes: uniform(0.3),
    pools: uniform(0),
    streaks: uniform(0),
    dry: uniform(0),
    tint: uniform(new THREE.Vector3(1, 1, 1)),
    team: uniform(1),
    lineLift: uniform(1),
    keyDir: uniform(new THREE.Vector3(0, 1, 0)),
    envMax: uniform(1e4),
    keySpecular: uniform(1),
    poolKeys: uniform(0),
    lampPos: uniformArray<'vec4'>(pos, 'vec4'),
    lampCol: uniformArray<'vec3'>(col, 'vec3'),
    lampCount,
  };
}

// ---- shared pieces (also used by the grass blades) -------------------------------------------------

type Rgb3 = readonly [number, number, number];
/** Grass palette (linear): dark bases, mid blades, light tips. */
const GRASS_DARK: Rgb3 = [0.02, 0.045, 0.014];
const GRASS_MID: Rgb3 = [0.045, 0.13, 0.024];
const GRASS_TIP: Rgb3 = [0.12, 0.22, 0.045];
/** Thatch between the blades, worn turf, bare soil, line paint. */
const THATCH: Rgb3 = [0.03, 0.028, 0.015];
const WORN: Rgb3 = [0.13, 0.135, 0.06];
const SOIL: Rgb3 = [0.055, 0.04, 0.024];
export const PAINT: Rgb3 = [0.7, 0.73, 0.68];
/** Self-illumination of the paint (keeps the lines readable at distance; never blooms). */
const PAINT_LIFT = 0.035;
/** Team tint of each half: share of the luminance-preserving team colour at the far end of a half. */
const TEAM_TINT = 0.16;

export const v3 = (c: Rgb3): Vec3Node => vec3(c[0], c[1], c[2]);

/** uv of floor point `p` in a floor map (saturated: the maps clamp). */
export function floorMapUv(p: Vec2Node, rect: FloorMapRect): Vec2Node {
  return saturate(p.sub(vec2(rect.x0, rect.z0)).div(vec2(rect.sx, rect.sz)));
}

/**
 * Grass colour from the blade height `shadeH` (0 thatch .. 1 tip), the per-blade / clump tints
 * (0..1), the large-scale hue (0..1), wear (trample 0..1, bare 0..1), the clump value, the blade
 * height `h` and the theme (dry, tint). The floor and the blades both use it, so the blades fade
 * into the floor.
 */
export function grassAlbedo(
  shadeH: FloatNode,
  bladeTint: FloatNode,
  clumpK: FloatNode,
  hue: FloatNode,
  trample: FloatNode,
  bare: FloatNode,
  clumpS: FloatNode,
  h: FloatNode,
  U: TurfUniforms,
): Vec3Node {
  let a: Vec3Node = mix(v3(GRASS_DARK), v3(GRASS_MID), smoothstep(0.04, 0.45, shadeH));
  a = mix(a, v3(GRASS_TIP), smoothstep(0.5, 1.0, shadeH).mul(0.8));
  a = a.mul(mix(float(0.62), float(1.35), bladeTint)).mul(mix(float(0.72), float(1.28), clumpK));
  // Large-scale hue: some areas yellower, some bluer; then the theme's yellowing and tint.
  a = mix(a, a.mul(vec3(1.3, 1.04, 0.62)), smoothstep(0.45, 0.75, hue).mul(0.75));
  a = mix(a, a.mul(vec3(0.82, 1.0, 1.08)), smoothstep(0.45, 0.2, hue).mul(0.6));
  a = mix(a, a.mul(vec3(1.4, 1.12, 0.5)), U.dry);
  a = a.mul(U.tint);
  // Gaps between the blades: thatch and soil.
  a = mix(v3(THATCH), a, smoothstep(0.015, 0.14, shadeH));
  // Wear: paler, yellower trampled grass, then bare soil.
  a = mix(a, v3(WORN).mul(mix(float(0.8), float(1.2), bladeTint)), trample.mul(0.55));
  a = mix(a, v3(SOIL).mul(mix(float(0.8), float(1.15), clumpS)), bare.mul(smoothstep(0.35, 0.05, h).mul(0.6).add(0.35)));
  return a;
}

/** Mowing bands: 14 across the length (bent toward +-z), 8 lengthwise (bent toward +-x). */
export const BAND_Z = (ARENA.extentY * 2) / 14;
export const BAND_X = (ARENA.extentX * 2) / 8;
/** Half width (uu) of the blend between two mowing bands. */
const BAND_EDGE = 110;

/**
 * Mowing bands at floor point `p`: which way the blades are bent, vec2(x: -1..1 toward +-x for the
 * faint lengthwise bands, y: -1..1 toward +-z for the bands across the length). `fwZ` / `fwX` are
 * the pixel footprints of the band coordinates p.y / BAND_Z and p.x / BAND_X (the blades, in the
 * vertex stage, pass null).
 */
export function bandBend(p: Vec2Node, fwZ: FloatNode | null, fwX: FloatNode | null): Vec2Node {
  const wobble = sin(p.x.mul(0.0021)).mul(14).add(sin(p.x.mul(0.013)).mul(3)); // mower lines are not perfect
  const triZ = abs(fract(p.y.add(wobble).div(BAND_Z * 2)).mul(2).sub(1));
  const triX = abs(fract(p.x.div(BAND_X * 2)).mul(2).sub(1));
  // Soft band edges (a mower's pass blends over ~1 m, so a near band edge never reads as a shadow
  // line), never narrower than the pixel footprint (no aliasing at distance).
  const eZ = fwZ === null ? float(BAND_EDGE / BAND_Z) : max(fwZ, float(BAND_EDGE / BAND_Z));
  const eX = fwX === null ? float(BAND_EDGE / BAND_X) : max(fwX, float(BAND_EDGE / BAND_X));
  const bendZ = smoothstep(float(0.5).sub(eZ), float(0.5).add(eZ), triZ).mul(2).sub(1);
  const bendX = smoothstep(float(0.5).sub(eX), float(0.5).add(eX), triX).mul(2).sub(1);
  return vec2(bendX, bendZ);
}

/**
 * Mowing stripes seen along the horizontal view vector `vh` (toward the camera) for the band bend
 * `bend` (bandBend): blades bent AWAY from the viewer show their long, lit sides, so that band looks
 * lighter, and the stripes flip when the camera turns round. Returns the brightness (~1 +- stripes).
 */
export function mowingStripes(bend: Vec2Node, vh: Vec2Node, trample: FloatNode, U: TurfUniforms): FloatNode {
  const sd = vh.y.mul(bend.y).add(vh.x.mul(bend.x).mul(0.35));
  return float(1).sub(sd.mul(U.stripes).mul(oneMinus(trample.mul(0.5))));
}

/** Luminance-preserving team tint of the two halves (blue at -z, red at +z), 1 near the halfway line. */
export function teamTint(p: Vec2Node, U: TurfUniforms): Vec3Node {
  const blue = linearVec3(TEAM_BLUE);
  const red = linearVec3(TEAM_RED);
  const lum = (c: Vec3Node): FloatNode => dot(c, vec3(0.2126, 0.7152, 0.0722));
  const toBlue = smoothstep(float(0.22 * ARENA.extentY), float(0.9 * ARENA.extentY), p.y.negate());
  const toRed = smoothstep(float(0.22 * ARENA.extentY), float(0.9 * ARENA.extentY), p.y);
  const k = float(TEAM_TINT).mul(U.team);
  const tb = mix(vec3(1, 1, 1), blue.div(lum(blue)), toBlue.mul(k));
  const tr = mix(vec3(1, 1, 1), red.div(lum(red)), toRed.mul(k));
  return tb.mul(tr);
}

// ---- the floor -------------------------------------------------------------------------------------

/** Parallax-occlusion relief: range (uu) and ray-march steps. */
const RELIEF_RANGE = 600;
const RELIEF_STEPS = 6;
/** Self-shadow tap: how far up the blades the light ray is tested (blade-field units) and its range (uu). */
const SHADOW_RISE = 0.3;
const SHADOW_RANGE = 2600;
/** Puddle look: basin-rank width of the rim (wide: no hard outline), and never a full mirror. */
const PUDDLE_SOFT = 0.18;
const PUDDLE_MAX = 0.65;
/**
 * Goal-mouth glow: colour at the line (x team colour, +-25 % pulse) and its share in the bloom input.
 * Both kept low: the glow covers metres of turf in front of each goal, and the darker night turf
 * there turned team-blue or red, its bloom a coloured haze over the whole near pitch at kickoff.
 */
const GOAL_GLOW = 0.02;
const GOAL_GLOW_BLOOM = 2.0;
/**
 * Roughness the water film brings the grass lobe down to. Never a mirror: a smooth lobe would mirror
 * whatever bright band the environment holds (cut-out-looking puddles); the sharp lamp reflections
 * are the analytic streaks.
 */
const SHEEN_ROUGHNESS = 0.26;

const rot2 = (p: Vec2Node, a: number): Vec2Node => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)));
};

/** World -> view space direction (normalNode is a view-space normal). */
export const viewN = (nW: Vec3Node): Vec3Node => transformDirection(nW, cameraViewMatrix);

/** Specular anti-aliasing (Kaplanyan / Tokuyoshi): widen the roughness where the normal varies within a pixel. */
function aaRoughness(rough: FloatNode, nW: Vec3Node): FloatNode {
  const dx = dFdx(nW);
  const dy = dFdy(nW);
  const variance = dot(dx, dx).add(dot(dy, dy)).mul(0.5);
  return sqrt(saturate(rough.mul(rough).add(min(variance, float(0.2)))));
}

/**
 * Relief: the floor mesh is the top of the grass; the eye ray is marched down through GRASS_HEIGHT
 * in RELIEF_STEPS fixed steps and the first sample inside a blade is what the pixel shows (blades
 * occlude each other and slide with parallax, no geometry, no overdraw). The march reads the
 * base footprint's mip level explicitly (`lod`: a stable mip choice, and no anisotropic taps for
 * a height test). Only within RELIEF_RANGE (dynamic branch).
 * Returns vec4(uv, hit depth 0..1 below the grass top, relief fade 0..1).
 */
function reliefHit(blades: THREE.Texture, uv0: Vec2Node, lod: FloatNode, V: Vec3Node, dist: FloatNode): Vec4Node {
  const fn = Fn(() => {
    const out = vec4(uv0, 0, 0).toVar();
    If(dist.lessThan(RELIEF_RANGE), () => {
      const fade = oneMinus(smoothstep(RELIEF_RANGE * 0.55, RELIEF_RANGE, dist));
      const vy = max(V.y, 0.12);
      // uv shift per unit of depth below the grass top (the eye ray runs along -V)
      const stepUv = V.xz.negate().div(vy).mul(GRASS_HEIGHT / TURF_TILE).mul(fade);
      let tHit: FloatNode = float(1);
      for (let i = RELIEF_STEPS; i >= 1; i--) {
        // Walking from the bottom up and keeping the last hit = the first hit seen from the top.
        const t = i / RELIEF_STEPS;
        const hi = texture(blades, uv0.add(stepUv.mul(t))).level(lod).r;
        tHit = select(hi.greaterThanEqual(1 - t + 0.5 / RELIEF_STEPS), float(t), tHit);
      }
      out.assign(vec4(uv0.add(stepUv.mul(tHit)), tHit, fade));
    });
    return out;
  });
  return fn() as unknown as Vec4Node;
}

/** Streak lobe shape: stretched toward the camera along the pitch, narrowed across it (anisotropic GGX). */
const STREAK_STRETCH = 2.6;
const STREAK_NARROW = 0.65;

/**
 * Analytic reflection of the streak heads in the water film: an anisotropic GGX lobe per head,
 * widened by the head's angular size (Karis 2013) and by `rough` (sub-pixel ripples, growing near
 * the camera), STRETCHED along the view's direction over the pitch and narrowed across it: the
 * blades and ripples break the film up into the long, soft streaks running toward the camera that a
 * wet pitch shows, never round mirror images of the heads (Ht and Hb are the half vector's parts
 * toward the camera and across, on the flat water). For these near-mirror lobes H ~ N, so the
 * Fresnel term (water F0 0.02) and the Smith visibility (~ 1 / (4 NoL NoV), its NoL cancelling the
 * cosine) are taken at the view angle once per pixel, outside the head loop: ~40 ALU per head.
 * Radiance in LAMP_REF_DISTANCE units (bake.ts).
 */
function lampStreaks(rough: FloatNode, V: Vec3Node, U: TurfUniforms): Vec3Node {
  let sum: Vec3Node = vec3(0, 0, 0);
  const P = positionWorld;
  const NoV = saturate(V.y);
  const F = float(0.02).add(pow(oneMinus(NoV), 5).mul(0.98));
  const k = F.mul((LAMP_REF_DISTANCE * LAMP_REF_DISTANCE) / (4 * Math.PI)).div(NoV.add(0.04));
  const r2 = rough.mul(rough);
  // Unit horizontal direction toward the camera (any unit vector when looking straight down).
  const th = V.xz.div(max(length(V.xz), float(1e-3)));
  for (let i = 0; i < U.lampCount; i++) {
    const lp = U.lampPos.element(i);
    const Lv = lp.xyz.sub(P);
    const invD = inverseSqrt(max(dot(Lv, Lv), float(1)));
    const H = normalize(Lv.mul(invD).add(V));
    const ht = dot(H.xz, th);
    const hb = H.x.mul(th.y).sub(H.z.mul(th.x));
    const a = max(r2.add(lp.w.mul(invD).mul(0.5)), float(0.002));
    const at = a.mul(STREAK_STRETCH);
    const ab = a.mul(STREAK_NARROW);
    const den = ht.mul(ht).div(at.mul(at)).add(hb.mul(hb).div(ab.mul(ab))).add(H.y.mul(H.y));
    sum = sum.add(U.lampCol.element(i).mul(float(1).div(at.mul(ab).mul(den.mul(den))).mul(invD).mul(invD)));
  }
  return sum.mul(k);
}

/** One PMREM node per environment texture (PMREMNode builds a generator of its own; share them). */
const turfPmrem = new WeakMap<THREE.Texture, ReturnType<typeof pmremTexture>>();

/**
 * The scene environment for the turf with its radiance capped at `cap` (before
 * scene.environmentIntensity). The world's probe holds the floodlight heads as hot panels (so paint
 * and glass show the lamps); on the damp turf their blurred images read as whitish fog over the
 * puddles from high cameras, and the lamps' reflections on the wet pitch are the analytic streaks'
 * job. Given as the material's `envNode`, it is sampled by MeshStandardNodeMaterial's
 * EnvironmentNode in its radiance and irradiance contexts exactly like scene.environment (the same
 * texture reads, one min more).
 */
class CappedEnvironmentNode extends THREE.Node {
  private readonly cap: FloatNode;

  constructor(cap: FloatNode) {
    super('vec3');
    this.cap = cap;
  }

  override setup(builder: THREE.NodeBuilder): Node {
    const env = (builder as unknown as { environmentNode: { value: THREE.Texture } | null }).environmentNode;
    if (env === null || env === undefined) return vec3(0, 0, 0);
    let pm = turfPmrem.get(env.value);
    if (pm === undefined) {
      pm = pmremTexture(env.value);
      turfPmrem.set(env.value, pm);
    }
    return (pm as unknown as Vec3Node).min(this.cap);
  }
}

/**
 * The turf's lighting model: three's physical model with two changes to the key lights' direct
 * term (the keys are the only direct lights; the fill and the environment are indirect):
 *  - their light is scaled by `keyGain`, the floodlight pool map's irradiance (poolKeyGain): at
 *    night the keys stand for the floodlight towers, so the pools shape their light and, being
 *    part of the keys, sit UNDER the keys' shadows (car and ball shadows read; an unshadowed
 *    emissive pool term washed them out);
 *  - their direct specular is scaled by `keySpecular`: on the damp sheen the keys' GGX highlight
 *    was one broad white blob per key (whitish fog over the pitch in front of the goals); the
 *    towers' reflections on the wet turf are the analytic streaks (lampStreaks). The scale runs
 *    after every direct light (start() lights them, then calls indirect()), on the summed term.
 */
class TurfLightingModel extends THREE.PhysicalLightingModel {
  private readonly keySpecular: FloatNode;
  private readonly keyGain: FloatNode;

  constructor(keySpecular: FloatNode, keyGain: FloatNode) {
    super();
    this.keySpecular = keySpecular;
    this.keyGain = keyGain;
  }

  override direct(input: THREE.LightingModelDirectInput, builder: THREE.NodeBuilder): void {
    super.direct({ ...input, lightColor: (input.lightColor as Vec3Node).mul(this.keyGain) }, builder);
  }

  override indirect(builder: THREE.NodeBuilder): void {
    const ctx = (builder as unknown as { context: { reflectedLight: { directSpecular: Vec3Node } } }).context;
    ctx.reflectedLight.directSpecular.mulAssign(this.keySpecular);
    super.indirect(builder);
  }
}

/** MeshStandardNodeMaterial lit through TurfLightingModel (the floor and the ultra grass blades). */
export class TurfNodeMaterial extends THREE.MeshStandardNodeMaterial {
  private readonly keySpecular: FloatNode;
  /** Gain of the key lights (poolKeyGain), set before the first build. */
  keyGain: FloatNode = float(1);

  constructor(keySpecular: FloatNode) {
    super();
    this.keySpecular = keySpecular;
  }

  override setupLightingModel(): THREE.PhysicalLightingModel {
    return new TurfLightingModel(this.keySpecular, this.keyGain);
  }
}

/**
 * Gain of the key lights from the pool map's rgb (sqrt-encoded irradiance, bake.ts): 1 where
 * `poolKeys` is 0 (day themes), the pool's irradiance luminance (mean ~0.96 on the night harbour,
 * 0.47 .. 1.47 from the 5th to the 95th percentile) where it is 1.
 */
export function poolKeyGain(poolRgb: Vec3Node, U: TurfUniforms): FloatNode {
  const irr = dot(poolRgb.mul(poolRgb), vec3(0.2126, 0.7152, 0.0722)).mul(POOL_MAX);
  return mix(float(1), irr, U.poolKeys);
}

export interface TurfMaterialOptions {
  /** The arena clock (s): the goal-mouth glow pulses with it. */
  readonly timeU: FloatUniform;
  readonly spec: TierSpec;
  readonly textures: TurfTextures;
  readonly uniforms: TurfUniforms;
}

/** The floor material of a tier (see the file header): MeshStandard, one lobe, on every tier. */
export function buildTurfMaterial(o: TurfMaterialOptions): THREE.MeshStandardNodeMaterial {
  const { timeU, spec, textures, uniforms: U } = o;
  const relief = spec.turfRelief;
  const m = new TurfNodeMaterial(U.keySpecular);
  m.name = 'turf';
  const p = positionWorld.xz; // (x, sim y)
  const toCam = cameraPosition.sub(positionWorld);
  const dist = max(length(toCam), float(1));
  const V = toCam.div(dist);

  // -- blade field: A = the detail (through the relief on its tiers)
  const uv0 = p.div(TURF_TILE);
  const gx = dFdx(uv0);
  const gy = dFdy(uv0);
  // The base footprint's mip level (isotropic: for the height tests of the relief and self-shadow).
  const lod = log2(max(max(length(gx), length(gy)).mul(BLADE_FIELD_SIZE), float(1e-6)));
  let tA: Vec4Node;
  let reliefAo: FloatNode = float(1);
  let uvHit: Vec2Node = uv0;
  if (relief) {
    const r = reliefHit(textures.blades, uv0, lod, V, dist);
    uvHit = r.xy;
    tA = texture(textures.blades, uvHit).grad(gx, gy);
    reliefAo = mix(float(1), mix(float(1), float(0.8), r.z), r.w);
  } else {
    tA = texture(textures.blades, uv0);
  }
  // The clump-scale copy (~55 uu clumps). On the relief tiers a second, rotated copy at 2.37x the
  // tile hides the tiling and carries the water ripples; low reuses the clump read for both.
  const tC = texture(textures.blades, rot2(p, -1.1).div(TURF_TILE * 11));
  const clumpS = tC.a;
  const tB = relief ? texture(textures.blades, rot2(p, 0.61).div(TURF_TILE * 2.37).add(vec2(0.31, 0.77))) : tC;
  // -- field map: wear, damp, basin rank, hue
  const f = texture(textures.field, floorMapUv(p, FIELD_MAP));
  const wear = f.r;
  const damp = f.g;
  const basin = f.b;
  const hue = f.a;

  // Bare soil where the wear is heaviest (broken up by the clumps); blades there are short.
  const bare = smoothstep(0.72, 0.97, wear.add(clumpS.sub(0.5).mul(0.45)));
  const trample = smoothstep(0.15, 0.75, wear);
  const h = tA.r.mul(oneMinus(bare.mul(0.75))).mul(oneMinus(trample.mul(0.25)));
  const bladeTint = mix(tA.a, tB.a, 0.45);
  const clumpK = clumpS.mul(0.6).add(tB.a.mul(0.4)); // 0..1, mid-scale variation

  // -- albedo
  const stripe = mowingStripes(bandBend(p, fwidth(p.y.div(BAND_Z)), fwidth(p.x.div(BAND_X))), V.xz, trample, U);
  let albedo: Vec3Node = grassAlbedo(h, bladeTint, clumpK, hue, trample, bare, clumpS, h, U).mul(stripe).mul(reliefAo);
  if (relief) {
    // Self-shadow: one tap toward the main key, SHADOW_RISE up the blades. Blades taller than the
    // light ray there shade this point; the mips calm it down with distance by themselves.
    const kd = U.keyDir;
    const reach = (SHADOW_RISE * GRASS_HEIGHT) / TURF_TILE;
    const toLight = kd.xz.div(max(kd.y, 0.25)).mul(reach);
    const hS = texture(textures.blades, uvHit.add(toLight)).level(lod).r;
    const occl = saturate(hS.sub(tA.r).sub(SHADOW_RISE).mul(4)).mul(oneMinus(smoothstep(SHADOW_RANGE * 0.4, SHADOW_RANGE, dist)));
    albedo = albedo.mul(oneMinus(occl.mul(0.55)));
  }
  // The team tint is the grass's, not the soil's (bare goal-mouth soil read grey-purple in blue).
  albedo = albedo.mul(mix(teamTint(p, U), vec3(1, 1, 1), bare));

  // Goal floors (beyond the goal lines): shaded by the net, a hint of the team colour.
  const az = abs(p.y);
  const glowCol = mix(linearVec3(TEAM_BLUE), linearVec3(TEAM_RED), step(float(0), p.y));
  const inGoal = smoothstep(float(ARENA.extentY - 10), float(ARENA.extentY + 60), az);
  albedo = mix(albedo, albedo.mul(0.55).add(glowCol.mul(0.012)), inGoal);

  // -- paint in the grass: ragged edges near the camera, paint mostly on the blade tips
  const nearK = oneMinus(smoothstep(300, 1500, dist));
  const jitter = h.sub(0.4).mul(5).mul(nearK).add(clumpS.sub(0.5).mul(4));
  const fw = fwidth(p);
  const aa = max(fw.x, fw.y).mul(0.8).add(0.25);
  const lines = markingsCoverage(p, jitter, aa);
  const paintOnBlade = mix(float(0.55), float(1.0), smoothstep(0.05, 0.5, h));
  const paint = lines.mul(paintOnBlade).mul(oneMinus(bare.mul(0.5)));
  albedo = mix(albedo, v3(PAINT), paint);

  // -- water: damp darkening everywhere (scaled by the wetness), water films between the blades
  //    (broken up at the clump scale), puddles in the basins (tiers with puddles)
  const W = U.wetness;
  const dampLocal = saturate(W.mul(damp.mul(1.1).add(0.25)));
  let puddle: FloatNode = float(0);
  if (spec.puddles) {
    // Basin rank below the level holds water; the rim is wide and broken by the clumps and the
    // blade tips, so a puddle is a soft dark sheen that fades in, never a cut-out.
    const depth = U.puddleLevel.sub(basin).add(clumpK.sub(0.5).mul(0.08)).add(h.sub(0.4).mul(0.03));
    puddle = smoothstep(float(-PUDDLE_SOFT), float(PUDDLE_SOFT), depth).mul(PUDDLE_MAX).mul(oneMinus(paint.mul(0.5))).mul(oneMinus(inGoal));
  }
  const gapPatches = smoothstep(0.3, 0.78, clumpK.add(damp.mul(0.35)).sub(0.12));
  // Near: water shows in the gaps between blades; far: the gaps are sub-pixel, use their share.
  const gapNear = oneMinus(smoothstep(0.06, 0.4, h));
  const gapShare = mix(gapNear, float(0.45), smoothstep(450, 1600, dist));
  const gap = dampLocal.mul(gapShare).mul(gapPatches);
  const water = max(puddle, gap);
  // The streaks read the water cover without the per-blade gaps (those would sparkle and crawl in
  // motion): a smooth film over the clump-scale patches.
  const waterSmooth = max(puddle, dampLocal.mul(0.45).mul(gapPatches));
  // Wet surfaces are darker; under a puddle a little darker still (subtle: the puddles read through
  // their sheen, not as dark blotches).
  albedo = albedo.mul(mix(float(1), float(0.78), dampLocal));
  albedo = albedo.mul(mix(float(1), float(0.8), puddle));

  // -- normals (world): blade normals from the bake, a gently undulating water surface
  const nT = tA.gb.mul(2).sub(1);
  const bladeStrength = oneMinus(bare.mul(0.6));
  const bladeN = normalize(vec3(nT.x.mul(bladeStrength), 1, nT.y.mul(bladeStrength)));
  const rip = tB.gb.mul(2).sub(1);
  const waterN = normalize(vec3(rip.x.mul(0.03), 1, rip.y.mul(0.03)));
  const grassRough = mix(float(0.82), float(0.58), dampLocal).sub(paint.mul(0.15));
  // Ripple roughness of the lamp streaks: near the camera the film is broken up by the blades (soft,
  // wide glints, never a round mirror image of a head), farther down the pitch it reads smoother and
  // puddles smoother still; the lobe's stretch toward the camera makes the streaks. Water held
  // between blades is never a flat mirror, which also keeps the glints from turning into pixel
  // glitter at grazing angles.
  const rippleRough = mix(mix(float(0.3), float(0.21), smoothstep(300, 2500, dist)), float(0.12), saturate(puddle.mul(1.4)).mul(0.6));

  m.metalnessNode = float(0);
  m.colorNode = albedo;
  m.envNode = new CappedEnvironmentNode(U.envMax);
  // The damp sheen: the water film flattens the grass normal and smooths its lobe where it lies
  // (puddles only part way: their sharp reflections are the streaks, a smooth lobe there would mirror
  // the environment's brightest band as a cut-out). Low is flat filtered: the geometric normal, no
  // specular anti-aliasing needed.
  const sheenRough = mix(grassRough, float(SHEEN_ROUGHNESS), max(gap, puddle.mul(0.55)));
  if (relief) {
    const nW = normalize(mix(bladeN, waterN, water));
    m.normalNode = viewN(nW);
    m.roughnessNode = aaRoughness(sheenRough, nW);
  } else {
    m.roughnessNode = sheenRough;
  }

  // -- floodlights: the baked pools (diffuse) and the analytic streaks (only where there is water;
  //    the water mask is coherent at the clump scale, so most dry turf skips the lamp loop)
  const pool = texture(textures.pools, floorMapUv(p, POOL_MAP));
  const poolE = pool.rgb.mul(pool.rgb).mul(POOL_MAX).mul(U.pools);
  m.keyGain = poolKeyGain(pool.rgb, U);
  // The lamps reflect off the water surface taken flat: its ripples are in the roughness (blade-scale
  // normals would glitter and crawl in motion; the streaks break up through the clump-scale water
  // cover instead).
  const streaks = Fn(() => {
    // Evaluated before the branch (they hold texture reads).
    const r = rippleRough.toVar();
    const wv = waterSmooth.toVar();
    const e = vec3(0, 0, 0).toVar();
    If(wv.greaterThan(0.003), () => {
      e.assign(lampStreaks(r, V, U).mul(wv));
    });
    return e;
  })() as unknown as Vec3Node;

  // Goal-mouth glow: fades in over the last metres before the line (strongest at the line, the cube
  // of the old ramp, so tighter to it), pulses gently. Dimmer than on the old bright floor in colour;
  // the bloom input at the line stays about the same as the old floor's.
  const bz = ARENA.extentY - ARENA.backRampRadius - 60;
  const mouthK = smoothstep(float(bz - 700), float(bz + 100), az);
  const inMouth = step(abs(p.x), float(ARENA.goalHalfWidth + 40)).mul(mouthK).mul(mouthK).mul(mouthK);
  const pulse = float(GOAL_GLOW).add(sin(timeU.mul(1.5)).mul(GOAL_GLOW * 0.25));
  const goalGlow = glowCol.mul(inMouth).mul(pulse);

  m.emissiveNode = albedo
    .mul(poolE)
    .add(v3(PAINT).mul(paint.mul(PAINT_LIFT).mul(U.lineLift)))
    .add(streaks.mul(U.streaks))
    .add(goalGlow);
  // Only the goal glow blooms (the streaks, pools and paint lift stay out of the glow target).
  m.mrtNode = glowMrt(goalGlow.mul(GOAL_GLOW_BLOOM), 'none');

  // A shadow keeps a little cool light of its key (the other towers and the wet turf's bounce),
  // never the 36-44 % that left the cars' shadows invisible under two keys: each key's shadow
  // only takes that key's light, the other key and the pools still light the spot.
  const shadowTint = vec3(0.15, 0.19, 0.19);
  const tintShadow = Fn(([shadow]: [Node]) => mix(shadowTint, vec3(1.0, 1.0, 1.0), shadow as Vec3Node));
  m.receivedShadowNode = tintShadow as unknown as () => Node;
  return m;
}

/**
 * The stadium's per-theme look (docs/visuals/REWORK.md, "Themes"): every value a theme may change
 * is a TSL uniform here, so a theme switch only rewrites uniforms (setTheme) and never recompiles a
 * shader. The shared world facts (night / day, the floodlights' strengths) come from theme.ts; the
 * stadium's own colours live in STADIUM_THEMES below, keyed by ThemeId.
 *
 * The Performance tier (TierSpec.bakedLight) takes each theme's `low` levels and bakes the
 * theme's light (its low keys and fill, theme.ts `lightsOf`) into the unlit stands, steel and
 * boards through `stadiumLight`: the same uniform set, other values (a tier switch rebuilds the
 * view and rewrites them).
 *
 * Colours are linear-light RGB (HDR allowed), the values the shaders use.
 */
import * as THREE from 'three/webgpu';
import { dot, max, mix, uniform } from 'three/tsl';
import type { FloatUniform, Vec3Node } from '../materials';
import { lightsOf, themeWorld, DEFAULT_THEME, type Rgb, type ThemeId } from '../theme';
import { towerHeads } from './layout';

/** The stadium's own per-theme parameters. */
export interface StadiumTheme {
  /** LED boards: card brightness (emissive multiplier) and the white rail on top. */
  readonly ledIntensity: number;
  readonly railIntensity: number;
  /** Lamp heads: HDR brightness of a lamp core at strength 1 (bloom does the halo on high). */
  readonly lampIntensity: number;
  /** Glare sprite round each head (tight exponential), and the ultra beams' haze. */
  readonly glare: number;
  readonly beam: number;
  /** Netting: wire colour, ambient light on the wires (sky + bounce), floodlight catch, coverage. */
  readonly netColor: Rgb;
  readonly netAmbient: Rgb;
  readonly netLight: number;
  readonly netOpacity: number;
  /** Crowd: light on the people (unlit shader), how much the back rows darken, the canopy downlights. */
  readonly crowdLight: Rgb;
  readonly crowdDepthDim: number;
  readonly canopyLight: number;
  /** The floor-ramp pad under the boards (close to the turf's colour, darker toward the boards). */
  readonly rampColor: Rgb;
  /** Steel: a rim term so floodlit tubes read against the sky. */
  readonly steelRim: Rgb;
  /** Stands built of timber instead of concrete, 0..1 (planked walls and rows, shingled canopy); absent = 0. */
  readonly standWood?: number;
  /**
   * The Performance tier (TierSpec.bakedLight): its own crowd, board, lamp and steel levels where
   * they differ (a bright crowd, not a dark mass), and `light`, a gain on the theme's light the
   * unlit stands, steel and boards bake in there (stadiumLight).
   */
  readonly low?: Partial<Pick<StadiumTheme, 'ledIntensity' | 'glare' | 'crowdLight' | 'crowdDepthDim' | 'canopyLight' | 'steelRim'>> & { readonly light?: number };
}

/**
 * Themes built so far; the others fall back to the default until the themes phase adds them (with
 * the same uniforms, so adding one never recompiles anything).
 */
const STADIUM_THEMES: Readonly<Partial<Record<ThemeId, StadiumTheme>>> = {
  'harbour-night': {
    ledIntensity: 0.4,
    railIntensity: 0.8,
    lampIntensity: 30,
    glare: 0.55,
    beam: 0.5,
    netColor: [0.34, 0.36, 0.39],
    netAmbient: [0.06, 0.068, 0.095],
    netLight: 0.5,
    netOpacity: 1,
    crowdLight: [0.42, 0.38, 0.33],
    crowdDepthDim: 0.55,
    canopyLight: 0.6,
    rampColor: [0.035, 0.085, 0.04],
    steelRim: [0.05, 0.055, 0.07],
    low: { crowdLight: [0.75, 0.7, 0.62], crowdDepthDim: 0.3, light: 1.4 },
  },
  // "Valle Alto" at midday (floodlights off): brighter boards so they read in the sun, a lighter,
  // more transparent mesh lit by the sky (the concept's "light cage"), a slightly brighter crowd
  // under the clear mountain light, and timber stands.
  'alpine-day': {
    ledIntensity: 1.0,
    railIntensity: 1.1,
    lampIntensity: 30,
    glare: 0.55,
    beam: 0.5,
    netColor: [0.33, 0.34, 0.35],
    netAmbient: [0.5, 0.53, 0.6],
    netLight: 0.5,
    netOpacity: 0.55,
    crowdLight: [0.66, 0.66, 0.68],
    crowdDepthDim: 0.45,
    canopyLight: 0,
    rampColor: [0.04, 0.095, 0.04],
    steelRim: [0.02, 0.022, 0.026],
    standWood: 1,
    low: { crowdLight: [0.82, 0.82, 0.85], crowdDepthDim: 0.25 },
  },
  // the red canyon at sunset: warm sky light on the wire and the crowd, the steel rimmed by the sun
  'canyon-sunset': {
    ledIntensity: 0.45,
    railIntensity: 0.8,
    lampIntensity: 30,
    glare: 0.45,
    beam: 0.35,
    netColor: [0.32, 0.27, 0.25],
    netAmbient: [0.2, 0.11, 0.1],
    netLight: 0.35,
    netOpacity: 1,
    crowdLight: [0.52, 0.4, 0.36],
    crowdDepthDim: 0.5,
    canopyLight: 0.35,
    rampColor: [0.05, 0.085, 0.035],
    steelRim: [0.14, 0.07, 0.04],
    low: { crowdLight: [0.8, 0.66, 0.58], crowdDepthDim: 0.3 },
  },
};

export function stadiumTheme(id: ThemeId): StadiumTheme {
  return STADIUM_THEMES[id] ?? (STADIUM_THEMES[DEFAULT_THEME] as StadiumTheme);
}

/** A linear RGB colour uniform (a vec3 in the shaders). */
export type ColorUniform = THREE.UniformNode<'vec3', THREE.Vector3>;

/** The uniforms every stadium material reads (one set per StadiumView). */
export interface StadiumUniforms {
  readonly ledIntensity: FloatUniform;
  readonly railIntensity: FloatUniform;
  readonly lampIntensity: FloatUniform;
  readonly glare: FloatUniform;
  readonly beam: FloatUniform;
  readonly netColor: ColorUniform;
  readonly netAmbient: ColorUniform;
  readonly netLight: FloatUniform;
  readonly netOpacity: FloatUniform;
  readonly crowdLight: ColorUniform;
  readonly crowdDepthDim: FloatUniform;
  readonly canopyLight: FloatUniform;
  readonly rampColor: ColorUniform;
  readonly steelRim: ColorUniform;
  readonly standWood: FloatUniform;
  /**
   * The light the unlit surfaces of the bakedLight tiers take (stadiumLight): each key's colour x
   * intensity / pi and direction, the hemisphere fill's sky and ground (x intensity / pi, plus
   * the image-based light's share), all x the theme's low `light` gain.
   */
  readonly bakedKey0: ColorUniform;
  readonly bakedKey1: ColorUniform;
  readonly bakedDir0: ColorUniform;
  readonly bakedDir1: ColorUniform;
  readonly bakedSky: ColorUniform;
  readonly bakedGround: ColorUniform;
  /** Per tower head (layout.towerHeads order): the theme floodlight's strength (0 = off by day). */
  readonly head: readonly FloatUniform[];
}

export function createStadiumUniforms(): StadiumUniforms {
  const f = (v = 0): FloatUniform => uniform(v);
  const c = (): ColorUniform => uniform(new THREE.Vector3(0, 0, 0));
  return {
    ledIntensity: f(),
    railIntensity: f(),
    lampIntensity: f(),
    glare: f(),
    beam: f(),
    netColor: c(),
    netAmbient: c(),
    netLight: f(),
    netOpacity: f(1),
    crowdLight: c(),
    crowdDepthDim: f(),
    canopyLight: f(),
    rampColor: c(),
    steelRim: c(),
    standWood: f(),
    bakedKey0: c(),
    bakedKey1: c(),
    bakedDir0: c(),
    bakedDir1: c(),
    bakedSky: c(),
    bakedGround: c(),
    head: towerHeads().map(() => f()),
  };
}

/**
 * The theme's light on an unlit surface with world normal `n` (the bakedLight tiers' stands,
 * steel and boards: albedo x this, no light loop and no environment read): both keys' n . l and
 * the hemisphere fill, what three's physical model gives a Lambertian surface, plus the image-based
 * light's share in the fill (applyStadiumTheme). One function so every unlit surface agrees.
 */
export function stadiumLight(u: StadiumUniforms, n: Vec3Node): Vec3Node {
  const k0 = u.bakedKey0.mul(max(dot(n, u.bakedDir0), 0.0));
  const k1 = u.bakedKey1.mul(max(dot(n, u.bakedDir1), 0.0));
  return k0.add(k1).add(mix(u.bakedGround, u.bakedSky, n.y.mul(0.5).add(0.5)));
}

/**
 * Write theme `id` into the uniforms, with its `low` levels and the Performance tier's baked light
 * when `baked` (TierSpec.bakedLight). Returns the per-head strengths (also written to `u.head`)
 * for the meshes that carry them in a vertex attribute.
 */
export function applyStadiumTheme(u: StadiumUniforms, id: ThemeId, baked = false): number[] {
  const own = stadiumTheme(id);
  const t: StadiumTheme = baked && own.low !== undefined ? { ...own, ...own.low } : own;
  const world = themeWorld(id);
  u.ledIntensity.value = t.ledIntensity;
  u.railIntensity.value = t.railIntensity;
  u.lampIntensity.value = t.lampIntensity;
  u.glare.value = t.glare;
  u.beam.value = t.beam;
  u.netColor.value.set(...t.netColor);
  u.netAmbient.value.set(...t.netAmbient);
  u.netLight.value = t.netLight;
  u.netOpacity.value = t.netOpacity;
  u.crowdLight.value.set(...t.crowdLight);
  u.crowdDepthDim.value = t.crowdDepthDim;
  u.canopyLight.value = world.night ? t.canopyLight : 0;
  u.rampColor.value.set(...t.rampColor);
  u.steelRim.value.set(...t.steelRim);
  u.standWood.value = t.standWood ?? 0;
  // The baked light: the lights of the tier's path (the theme's low ones when baked), / pi as
  // three's Lambert term, the environment's share folded into the fill (its sky colour as the
  // probe's mean radiance), x the theme's low gain.
  const lights = lightsOf(world, baked ? 'direct' : 'post');
  const gain = (baked ? own.low?.light : undefined) ?? 1;
  const kd = gain / Math.PI;
  const [a, b] = lights.keys;
  u.bakedKey0.value.set(a.color[0], a.color[1], a.color[2]).multiplyScalar(a.intensity * kd);
  u.bakedKey1.value.set(b.color[0], b.color[1], b.color[2]).multiplyScalar(b.intensity * kd);
  u.bakedDir0.value.set(a.dir[0], a.dir[1], a.dir[2]);
  u.bakedDir1.value.set(b.dir[0], b.dir[1], b.dir[2]);
  const f = lights.fill;
  const hemi = f.intensity * kd;
  const env = f.env * gain;
  u.bakedSky.value.set(f.sky[0] * (hemi + env), f.sky[1] * (hemi + env), f.sky[2] * (hemi + env));
  u.bakedGround.value.set(f.ground[0] * hemi + f.sky[0] * env * 0.5, f.ground[1] * hemi + f.sky[1] * env * 0.5, f.ground[2] * hemi + f.sky[2] * env * 0.5);
  // Head i is the theme's floodlight i (same order as theme.ts builds them); a theme with fewer
  // floodlights leaves the rest dark.
  const strengths = u.head.map((h, i) => {
    const s = world.floodlights[i]?.strength ?? 0;
    h.value = s;
    return s;
  });
  return strengths;
}

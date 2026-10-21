/**
 * The stadium's per-theme look (docs/visuals/REWORK.md, "Themes"): every value a theme may change
 * is a TSL uniform here, so a theme switch only rewrites uniforms (setTheme) and never recompiles a
 * shader. The shared world facts (night / day, the floodlights' strengths) come from theme.ts; the
 * stadium's own colours live in STADIUM_THEMES below, keyed by ThemeId.
 *
 * Colours are linear-light RGB (HDR allowed), the values the shaders use.
 */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { FloatUniform } from '../materials';
import { themeWorld, DEFAULT_THEME, type Rgb, type ThemeId } from '../theme';
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
    crowdLight: [0.25, 0.25, 0.29],
    crowdDepthDim: 0.55,
    canopyLight: 0.35,
    rampColor: [0.035, 0.085, 0.04],
    steelRim: [0.05, 0.055, 0.07],
  },
  // "Valle Alto" at midday (floodlights off): brighter boards so they read in the sun, the wires
  // lit by the sky (a light, transparent mesh rather than a dark veil: the concept's "light cage"),
  // the crowd in the canopy's shade, and timber stands.
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
    head: towerHeads().map(() => f()),
  };
}

/**
 * Write theme `id` into the uniforms. Returns the per-head strengths (also written to `u.head`)
 * for the meshes that carry them in a vertex attribute.
 */
export function applyStadiumTheme(u: StadiumUniforms, id: ThemeId): number[] {
  const t = stadiumTheme(id);
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
  // Head i is the theme's floodlight i (same order as theme.ts builds them); a theme with fewer
  // floodlights leaves the rest dark.
  const strengths = u.head.map((h, i) => {
    const s = world.floodlights[i]?.strength ?? 0;
    h.value = s;
    return s;
  });
  return strengths;
}

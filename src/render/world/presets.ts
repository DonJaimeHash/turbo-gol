/**
 * Per-theme parameters of the world module: the sky (gradient, horizon glow, moon or sun, stars,
 * two cloud layers), the light the backdrop geometry receives, the sea and the environment
 * extras. A preset is DATA only: the same generators and shaders read it, so a theme switch writes
 * these numbers into uniforms and re-bakes the cube map (never a recompile). `skyline` picks the
 * geometry generator (harbour.ts / canyon.ts / alpine.ts).
 *
 * The facts other views share (key lights, fill, floodlights, fog, grade) live in ../theme.ts;
 * the fog density and colour of the stadium come from there, the aerial haze of the backdrop from
 * the sky colours here (`horizon` + `glow`, see atmosphere.ts hazeColor).
 *
 * Colours are linear HDR radiance (what the HalfFloat cube stores before tone mapping).
 * Directions are azimuth / elevation in degrees: azimuth 0 = +z (behind the red goal, what the blue
 * kickoff camera faces), 90 = -x (the right of that view), -90 = +x (its left), 180 = -z.
 */
import type { Rgb, ThemeId } from '../theme';

export type SkylineId = 'harbour' | 'canyon' | 'alpine';

export interface CloudPreset {
  /** 0 clear .. 1 overcast. */
  readonly cover: number;
  /** Horizontal frequency of the layer (higher = smaller clouds). */
  readonly scale: number;
  /** Projection height: larger = a higher layer (less perspective squash toward the horizon). */
  readonly height: number;
  /** Top colour where the key body lights the cloud, its shadowed side, and the light from below. */
  readonly lit: Rgb;
  readonly shadow: Rgb;
  /** City glow (or sunset) on the underside: multiplied by the horizon glow lobe. */
  readonly under: Rgb;
  /** Opacity of a fully dense cloud. */
  readonly alpha: number;
  /** Stretch of the noise along x (1 = round puffs, > 1 = streaks). */
  readonly stretch: number;
}

export interface WorldPreset {
  readonly skyline: SkylineId;
  readonly zenith: Rgb;
  readonly mid: Rgb;
  readonly horizon: Rgb;
  /** Light pollution or sunset hugging the horizon, strongest toward `az`. */
  readonly glow: { readonly color: Rgb; readonly az: number; readonly spread: number; readonly height: number };
  /** The key body (moon or sun): disc, halos, and its light on the backdrop geometry (`light`). */
  readonly key: {
    readonly az: number;
    readonly el: number;
    readonly color: Rgb;
    readonly disc: number;
    readonly sizeDeg: number;
    readonly halo: number;
    readonly halo2: number;
    readonly moon: boolean;
    readonly light: Rgb;
  };
  /** Hemispheric ambient on the backdrop geometry. */
  readonly ambSky: Rgb;
  readonly ambGround: Rgb;
  readonly stars: number;
  /** The low cumulus layer (lit from below by the city) and a high thin layer behind it. */
  readonly clouds: CloudPreset;
  readonly cirrus: CloudPreset;
  /** Height falloff (uu) of the aerial haze; its density is the theme's fog density (theme.ts). */
  readonly hazeHeight: number;
  /** Multiplier of the haze density over the stadium fog's (the backdrop is far: more air). */
  readonly hazeGain: number;
  /** Lamps and lit windows of the backdrop: 0 off (day) .. 1. */
  readonly lights: number;
  readonly windows: number;
  readonly sea: { readonly color: Rgb; readonly rough: number };
  /** Environment extras (env.ts): the lit pitch under the probe and the floodlight heads' radiance. */
  readonly envTurf: Rgb;
  readonly envLamp: number;
  /**
   * Heights over the bake origin (uu) where the dome's parallax proxy hands over to "at infinity"
   * (when absent: dome.ts PROXY_TOP).
   * A skyline taller than the default band (the alpine mountains) raises it above its highest
   * point, so no peak straddles the hand-over.
   */
  readonly proxyTop?: readonly [number, number];
}

const PRESETS: Readonly<Partial<Record<ThemeId, WorldPreset>>> = {
  // The owner's main reference: a night harbour, deep blue sky, clouds lit from below by the city.
  'harbour-night': {
    skyline: 'harbour',
    zenith: [0.005, 0.011, 0.04],
    mid: [0.014, 0.03, 0.1],
    horizon: [0.06, 0.06, 0.13],
    glow: { color: [0.22, 0.11, 0.045], az: 12, spread: 0.6, height: 0.08 },
    key: { az: -38, el: 31, color: [0.78, 0.84, 1.0], disc: 3.4, sizeDeg: 0.9, halo: 0.014, halo2: 0.06, moon: true, light: [0.05, 0.06, 0.095] },
    ambSky: [0.011, 0.015, 0.034],
    ambGround: [0.012, 0.009, 0.008],
    stars: 1.0,
    clouds: { cover: 0.52, scale: 0.8, height: 0.085, lit: [0.06, 0.075, 0.12], shadow: [0.008, 0.011, 0.028], under: [0.2, 0.09, 0.07], alpha: 0.95, stretch: 1.0 },
    cirrus: { cover: 0.42, scale: 0.42, height: 0.22, lit: [0.03, 0.04, 0.075], shadow: [0.008, 0.012, 0.03], under: [0.07, 0.035, 0.03], alpha: 0.55, stretch: 2.6 },
    hazeHeight: 2600,
    hazeGain: 1.0,
    lights: 1.0,
    windows: 0.55,
    sea: { color: [0.0015, 0.003, 0.005], rough: 1.0 },
    envTurf: [0.035, 0.07, 0.035],
    envLamp: 40,
  },

  // Another generator (tiered red cliffs and buttes instead of the harbour), the same sky, haze and
  // lighting code. A strong sunset: the disc low in a notch of the horizon right of the far goal
  // (azimuth 13), a hot orange glow along the horizon, a violet zenith and a field of small clouds
  // lit pink and orange from below; the walls facing the sun burn red, the others fall into violet
  // shade.
  'canyon-sunset': {
    skyline: 'canyon',
    zenith: [0.022, 0.03, 0.15],
    mid: [0.13, 0.08, 0.3],
    horizon: [0.75, 0.32, 0.12],
    glow: { color: [0.95, 0.36, 0.08], az: 13, spread: 0.85, height: 0.075 },
    key: { az: 13, el: 4.6, color: [1.0, 0.6, 0.26], disc: 150, sizeDeg: 1.25, halo: 0.25, halo2: 1.1, moon: false, light: [3.8, 1.6, 0.55] },
    ambSky: [0.14, 0.09, 0.18],
    ambGround: [0.22, 0.085, 0.04],
    stars: 0.0,
    clouds: { cover: 0.5, scale: 1.25, height: 0.085, lit: [0.95, 0.42, 0.36], shadow: [0.13, 0.075, 0.2], under: [0.75, 0.25, 0.1], alpha: 0.92, stretch: 1.2 },
    cirrus: { cover: 0.46, scale: 0.3, height: 0.24, lit: [0.95, 0.44, 0.38], shadow: [0.2, 0.1, 0.22], under: [0.45, 0.14, 0.05], alpha: 0.5, stretch: 2.6 },
    hazeHeight: 3800,
    hazeGain: 0.42,
    lights: 0.25,
    windows: 0.0,
    sea: { color: [0.02, 0.02, 0.02], rough: 1.0 },
    envTurf: [0.12, 0.13, 0.05],
    envLamp: 18,
  },

  // "Valle Alto": a mountain valley in clear midday light. The sun stands high on the left of the
  // blue kickoff view, a little ahead (the massif ahead is side-lit: lit faces and shadowed
  // gullies, its snow bright), a deep blue sky with
  // fair-weather cumulus and a few high streaks, little haze low in the valley and almost none on
  // the peaks (alpine.ts; aerial perspective by height). The mountains rise above the default
  // parallax band, so the band moves above them (proxyTop; alpine.ts ALPINE_TOP).
  'alpine-day': {
    skyline: 'alpine',
    zenith: [0.026, 0.085, 0.33],
    mid: [0.09, 0.22, 0.58],
    horizon: [0.42, 0.55, 0.76],
    glow: { color: [0.12, 0.11, 0.09], az: -70, spread: 0.45, height: 0.14 },
    key: { az: -70, el: 40, color: [1.0, 0.94, 0.84], disc: 160, sizeDeg: 0.9, halo: 0.22, halo2: 0.9, moon: false, light: [1.62, 1.55, 1.42] },
    ambSky: [0.16, 0.22, 0.36],
    ambGround: [0.07, 0.085, 0.05],
    stars: 0.0,
    clouds: { cover: 0.47, scale: 0.9, height: 0.1, lit: [1.2, 1.18, 1.14], shadow: [0.34, 0.41, 0.56], under: [0.06, 0.06, 0.05], alpha: 0.96, stretch: 1.0 },
    cirrus: { cover: 0.3, scale: 0.32, height: 0.3, lit: [0.95, 1.0, 1.08], shadow: [0.55, 0.64, 0.82], under: [0.02, 0.02, 0.02], alpha: 0.35, stretch: 3.6 },
    hazeHeight: 12000,
    hazeGain: 1.0,
    lights: 0.0,
    windows: 0.0,
    sea: { color: [0.01, 0.03, 0.045], rough: 1.0 },
    envTurf: [0.1, 0.2, 0.06],
    envLamp: 0,
    proxyTop: [33000, 47000],
  },
};

/** The world preset of a theme; themes without one yet use the default (harbour-night) world. */
export function worldPreset(id: ThemeId): WorldPreset {
  return PRESETS[id] ?? (PRESETS['harbour-night'] as WorldPreset);
}

/** Theme ids that have their own world preset (the others fall back to harbour-night). */
export function hasWorldPreset(id: ThemeId): boolean {
  return PRESETS[id] !== undefined;
}

/** Unit direction for an azimuth / elevation in degrees (see the file header for the convention). */
export function dirFromAzEl(azDeg: number, elDeg: number): [number, number, number] {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return [-Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
}

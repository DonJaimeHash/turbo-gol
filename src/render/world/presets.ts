/**
 * Per-theme parameters of the world module: the sky (gradient, horizon glow, moon or sun, stars,
 * two cloud layers), the light the backdrop geometry receives, the sea and the environment
 * extras. A preset is DATA only: the same generators and shaders read it, so a theme switch writes
 * these numbers into uniforms and re-bakes the cube map (never a recompile). `skyline` picks the
 * geometry generator (harbour.ts / canyon.ts / city.ts).
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

export type SkylineId = 'harbour' | 'canyon' | 'city';

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
}

const PRESETS: Readonly<Partial<Record<ThemeId, WorldPreset>>> = {
  // The owner's main reference: a night harbour, deep blue sky, clouds lit from below by the city.
  'harbour-night': {
    skyline: 'harbour',
    zenith: [0.0035, 0.007, 0.026],
    mid: [0.009, 0.02, 0.07],
    horizon: [0.05, 0.05, 0.11],
    glow: { color: [0.22, 0.11, 0.045], az: 12, spread: 0.6, height: 0.08 },
    key: { az: -38, el: 31, color: [0.78, 0.84, 1.0], disc: 3.4, sizeDeg: 0.9, halo: 0.014, halo2: 0.06, moon: true, light: [0.05, 0.06, 0.095] },
    ambSky: [0.011, 0.015, 0.034],
    ambGround: [0.012, 0.009, 0.008],
    stars: 1.0,
    clouds: { cover: 0.52, scale: 0.8, height: 0.085, lit: [0.045, 0.055, 0.09], shadow: [0.006, 0.008, 0.02], under: [0.2, 0.09, 0.07], alpha: 0.95, stretch: 1.0 },
    cirrus: { cover: 0.42, scale: 0.42, height: 0.22, lit: [0.03, 0.04, 0.075], shadow: [0.008, 0.012, 0.03], under: [0.07, 0.035, 0.03], alpha: 0.55, stretch: 2.6 },
    hazeHeight: 2600,
    hazeGain: 1.0,
    lights: 1.0,
    windows: 0.55,
    sea: { color: [0.0015, 0.003, 0.005], rough: 1.0 },
    envTurf: [0.035, 0.07, 0.035],
    envLamp: 40,
  },

  // The same harbour by day: the same geometry and shaders, only numbers change.
  'harbour-day': {
    skyline: 'harbour',
    zenith: [0.05, 0.12, 0.4],
    mid: [0.17, 0.32, 0.7],
    horizon: [0.6, 0.65, 0.74],
    glow: { color: [0.32, 0.24, 0.14], az: 24, spread: 0.85, height: 0.16 },
    key: { az: 24, el: 30, color: [1.0, 0.88, 0.7], disc: 160, sizeDeg: 0.9, halo: 0.32, halo2: 1.1, moon: false, light: [3.0, 2.65, 2.15] },
    ambSky: [0.42, 0.52, 0.74],
    ambGround: [0.2, 0.18, 0.15],
    stars: 0.0,
    clouds: { cover: 0.44, scale: 0.5, height: 0.085, lit: [1.45, 1.38, 1.3], shadow: [0.36, 0.4, 0.52], under: [0.3, 0.22, 0.14], alpha: 0.9, stretch: 1.0 },
    cirrus: { cover: 0.38, scale: 0.3, height: 0.25, lit: [1.2, 1.22, 1.25], shadow: [0.55, 0.62, 0.78], under: [0.12, 0.09, 0.06], alpha: 0.5, stretch: 3.0 },
    hazeHeight: 3500,
    hazeGain: 1.0,
    lights: 0.0,
    windows: 0.0,
    sea: { color: [0.01, 0.03, 0.045], rough: 1.0 },
    envTurf: [0.12, 0.22, 0.09],
    envLamp: 0,
  },

  // Another generator (rock mesas instead of the harbour), the same sky, haze and lighting code.
  'canyon-sunset': {
    skyline: 'canyon',
    zenith: [0.03, 0.04, 0.15],
    mid: [0.16, 0.1, 0.24],
    horizon: [0.62, 0.28, 0.15],
    glow: { color: [0.62, 0.24, 0.07], az: 8, spread: 0.9, height: 0.07 },
    key: { az: 8, el: 4.5, color: [1.0, 0.55, 0.22], disc: 70, sizeDeg: 1.1, halo: 0.4, halo2: 1.6, moon: false, light: [3.4, 1.55, 0.6] },
    ambSky: [0.1, 0.08, 0.15],
    ambGround: [0.12, 0.05, 0.03],
    stars: 0.0,
    clouds: { cover: 0.48, scale: 0.45, height: 0.085, lit: [1.1, 0.48, 0.26], shadow: [0.12, 0.06, 0.11], under: [0.5, 0.18, 0.06], alpha: 0.9, stretch: 1.0 },
    cirrus: { cover: 0.45, scale: 0.28, height: 0.24, lit: [1.3, 0.62, 0.32], shadow: [0.2, 0.1, 0.16], under: [0.35, 0.12, 0.05], alpha: 0.6, stretch: 3.2 },
    hazeHeight: 5000,
    hazeGain: 1.0,
    lights: 0.25,
    windows: 0.0,
    sea: { color: [0.02, 0.02, 0.02], rough: 1.0 },
    envTurf: [0.1, 0.12, 0.05],
    envLamp: 18,
  },

  // "Distrito 9": the car park's roof in the middle of a city just after sunset (city.ts). The sun
  // is a degree above the horizon behind the far goal's skyline (hidden by the towers: only its
  // glow shows); a deep violet sky, clouds lit pink and orange from below, the first stars.
  'city-dusk': {
    skyline: 'city',
    zenith: [0.004, 0.006, 0.032],
    mid: [0.012, 0.02, 0.09],
    horizon: [0.16, 0.07, 0.12],
    glow: { color: [0.3, 0.1, 0.045], az: 6, spread: 0.6, height: 0.08 },
    key: { az: 6, el: 1.2, color: [1.0, 0.45, 0.25], disc: 20, sizeDeg: 1.0, halo: 0.04, halo2: 0.08, moon: false, light: [0.06, 0.03, 0.03] },
    ambSky: [0.035, 0.03, 0.08],
    ambGround: [0.02, 0.014, 0.016],
    stars: 0.25,
    clouds: { cover: 0.4, scale: 0.6, height: 0.085, lit: [0.045, 0.04, 0.09], shadow: [0.012, 0.013, 0.036], under: [0.7, 0.22, 0.13], alpha: 0.9, stretch: 1.3 },
    cirrus: { cover: 0.48, scale: 0.34, height: 0.24, lit: [0.05, 0.045, 0.1], shadow: [0.018, 0.02, 0.055], under: [0.38, 0.13, 0.08], alpha: 0.5, stretch: 3.2 },
    hazeHeight: 3400,
    hazeGain: 0.6,
    lights: 1.0,
    windows: 0.62,
    sea: { color: [0.004, 0.004, 0.006], rough: 1.0 },
    envTurf: [0.03, 0.06, 0.035],
    envLamp: 40,
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

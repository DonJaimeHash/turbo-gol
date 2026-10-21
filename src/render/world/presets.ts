/**
 * Per-theme parameters of the world module: the sky (gradient, horizon glow, moon or sun, stars,
 * two cloud layers), the light the backdrop geometry receives, the sea and the environment
 * extras. A preset is DATA only: the same generators and shaders read it, so a theme switch writes
 * these numbers into uniforms and re-bakes the cube map (never a recompile). `skyline` picks the
 * geometry generator (harbour.ts / canyon.ts / railyard.ts).
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

export type SkylineId = 'harbour' | 'canyon' | 'railyard';

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

  // "Patio Ferroviario": an old railway depot at night (railyard.ts). An orange-tinted night: the
  // city behind the far goal (azimuth 0) lights a wide band of the horizon and the undersides of
  // broken clouds, the zenith stays deep violet, a dim moon sits behind the kickoff camera and
  // rims the faces turned toward the pitch; few stars through the light pollution.
  'railyard-night': {
    skyline: 'railyard',
    zenith: [0.004, 0.006, 0.04],
    mid: [0.022, 0.024, 0.105],
    horizon: [0.19, 0.075, 0.065],
    glow: { color: [0.5, 0.17, 0.05], az: 4, spread: 0.7, height: 0.09 },
    key: { az: 172, el: 27, color: [0.82, 0.84, 1.0], disc: 2.2, sizeDeg: 0.85, halo: 0.01, halo2: 0.04, moon: true, light: [0.032, 0.034, 0.052] },
    ambSky: [0.014, 0.012, 0.03],
    ambGround: [0.018, 0.01, 0.007],
    stars: 0.35,
    clouds: { cover: 0.55, scale: 0.62, height: 0.085, lit: [0.075, 0.06, 0.15], shadow: [0.016, 0.015, 0.05], under: [0.9, 0.32, 0.1], alpha: 0.95, stretch: 1.35 },
    cirrus: { cover: 0.46, scale: 0.4, height: 0.22, lit: [0.06, 0.05, 0.11], shadow: [0.014, 0.014, 0.036], under: [0.35, 0.12, 0.06], alpha: 0.55, stretch: 2.8 },
    hazeHeight: 2400,
    hazeGain: 0.35,
    lights: 1.0,
    windows: 0.6,
    sea: { color: [0.002, 0.002, 0.002], rough: 1.0 },
    envTurf: [0.04, 0.062, 0.03],
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

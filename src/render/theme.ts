/**
 * Stadium themes: where the arena stands (a night harbour, a red canyon at sunset...). A theme is
 * DATA only: the same generators and shaders read it, so switching theme re-bakes the sky and
 * backdrop and rewrites uniforms, and never changes the light count or the material variants (a
 * light-count change recompiles every lit material, several seconds on the web).
 *
 * This file holds the facts several views share (key lights, fill, floodlights, wetness, fog, tone
 * mapping and grade). Each view keeps its own per-theme parameters next to its code, keyed by
 * ThemeId: the sky and backdrop generators (world/), the stadium palette (stadium/), the turf
 * colours (turf/). Gameplay never reads a theme: the field, the goals and the collision mesh are
 * identical in every theme, and every player may see a different one.
 *
 * Axes and units are three.js world space in uu (1 uu ~ 1 cm): x across the field (side walls at
 * +-4400), y up (ceiling 2250), z along it (goal lines at +-5600; blue goal at -z, red at +z).
 * Colours are linear-light RGB (HDR allowed), the values shaders use.
 */

export type ThemeId = 'harbour-night' | 'harbour-day' | 'canyon-sunset' | 'alpine-day';

/** Menu order. */
export const THEME_IDS: readonly ThemeId[] = ['harbour-night', 'harbour-day', 'canyon-sunset', 'alpine-day'];

export const DEFAULT_THEME: ThemeId = 'harbour-night';

export type Rgb = readonly [number, number, number];
export type Vec3Tuple = readonly [number, number, number];

export interface KeyLight {
  /** Unit vector from the field centre toward the light. */
  readonly dir: Vec3Tuple;
  readonly color: Rgb;
  /** DirectionalLight intensity. */
  readonly intensity: number;
}

export interface Floodlight {
  /** Centre of the lamp head and the point of the pitch it is aimed at. */
  readonly position: Vec3Tuple;
  readonly target: Vec3Tuple;
  readonly color: Rgb;
  /** 1 = a standard head: scales its glow, its baked pool on the pitch and its wet streak (0 = off). */
  readonly strength: number;
}

export interface ThemeWorld {
  readonly id: ThemeId;
  /** Night themes light the pitch with floodlights (pools, streaks, hot lamp heads); day themes with the sun. */
  readonly night: boolean;
  /**
   * The two key lights: directional, the only shadow casters (keys[0] keeps its shadow on the low
   * tier, keys[1] lights without one there). At night they stand for the floodlight towers.
   */
  readonly keys: readonly [KeyLight, KeyLight];
  /** Hemisphere fill (sky / ground colours, intensity) and the image-based lighting intensity. */
  readonly fill: { readonly sky: Rgb; readonly ground: Rgb; readonly intensity: number; readonly env: number };
  /** Lamp heads round the field; the turf bakes their pools and draws their streaks on wet grass. */
  readonly floodlights: readonly Floodlight[];
  /** 0 dry .. 1 soaked: turf sheen and puddles, streak strength. */
  readonly wetness: number;
  /** Exponential distance fog (density per uu): the backdrop bake and the stadium fade into it. */
  readonly fog: { readonly color: Rgb; readonly density: number };
  /** Final image: tone mapping, exposure and a light colour grade (applied in HDR before the tone map). */
  readonly toneMapping: 'neutral' | 'aces' | 'agx';
  readonly exposure: number;
  readonly grade: {
    readonly contrast: number;
    readonly saturation: number;
    /** Added to the shadows / multiplied into the highlights. */
    readonly lift: Rgb;
    readonly gain: Rgb;
    /** 0 = none; the old renderer used 0.32. */
    readonly vignette: number;
  };
}

/** Floodlight towers outside the side walls, heads above the cage roof (shared by every theme). */
export const TOWER_X = 4880;
export const TOWER_Z: readonly number[] = [-4300, -1450, 1450, 4300];
export const HEAD_Y = 3250;

function unit(x: number, y: number, z: number): Vec3Tuple {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

/** The eight standard heads, cross-aimed: each lights the far half of the pitch, a bit toward the centre. */
function towerFloodlights(color: Rgb, strength: number): Floodlight[] {
  const out: Floodlight[] = [];
  for (const sx of [-1, 1]) {
    for (const z of TOWER_Z) {
      out.push({ position: [sx * (TOWER_X - 240), HEAD_Y, z * 0.985], target: [-sx * 1500, 0, z * 0.72], color, strength });
    }
  }
  return out;
}

const WARM_LAMP: Rgb = [1.0, 0.93, 0.82];

/** Themes built so far (the themes phase of docs/visuals/REWORK.md adds the others). */
const WORLDS: Readonly<Partial<Record<ThemeId, ThemeWorld>>> = {
  'harbour-night': {
    id: 'harbour-night',
    night: true,
    // Two raking keys (~30 degrees up) from opposite corner towers: long, readable car shadows and
    // a backlit sheen whichever way the camera faces. Dimmer than the old single sun (3.2) so the
    // lamp heads and boards (HDR emitters) stand out against a darker, contrasty pitch. keys[0]
    // clearly dominant: each shadow only takes its own key's light, so a balanced pair washed the
    // car shadows out.
    keys: [
      { dir: unit(-TOWER_X, HEAD_Y, -2900), color: WARM_LAMP, intensity: 2.4 },
      { dir: unit(TOWER_X, HEAD_Y, 2900), color: WARM_LAMP, intensity: 0.95 },
    ],
    // Low fill (the old hemisphere was 1.5 of a pale blue): shadows and the unlit sides of the cars
    // stay dark navy instead of a grey wash. `env` is the image-based lighting intensity.
    fill: { sky: [0.05, 0.065, 0.12], ground: [0.03, 0.022, 0.018], intensity: 0.7, env: 0.3 },
    floodlights: towerFloodlights(WARM_LAMP, 1),
    wetness: 0.55,
    fog: { color: [0.05, 0.046, 0.105], density: 1.6e-5 },
    // ACES: a stronger toe (deep shadows, no black lift) and a filmic shoulder for the hot lamps,
    // moodier than Neutral for this night; the grade adds contrast, cool shadows, warm highlights.
    toneMapping: 'aces',
    exposure: 1.0,
    grade: { contrast: 1.18, saturation: 1.12, lift: [0, 0.002, 0.006], gain: [1.03, 1, 0.96], vignette: 0.3 },
  },
  // The same harbour by day: the sun is the main key (azimuth 24 deg, elevation 30 deg, the sky's
  // sun disc in world/presets.ts), a weak cool sky key from the other side, floodlights off. Bright,
  // crisp afternoon: a strong sun on the stadium's scale (the backdrop's key.light ~ 5 / pi), a
  // modest sky fill, clear air, ACES for a filmic shoulder on the sunlit cloud tops.
  'harbour-day': {
    id: 'harbour-day',
    night: false,
    keys: [
      { dir: unit(-0.352, 0.5, 0.791), color: [1.0, 0.92, 0.8], intensity: 5.0 },
      { dir: unit(0.5, 0.62, -0.6), color: [0.72, 0.82, 1.0], intensity: 0.8 },
    ],
    fill: { sky: [0.46, 0.55, 0.72], ground: [0.2, 0.19, 0.15], intensity: 1.0, env: 0.55 },
    floodlights: towerFloodlights(WARM_LAMP, 0),
    wetness: 0.09,
    fog: { color: [0.46, 0.55, 0.7], density: 0.45e-5 },
    toneMapping: 'aces',
    exposure: 1.12,
    grade: { contrast: 1.06, saturation: 1.1, lift: [0, 0, 0.002], gain: [1.02, 1, 0.98], vignette: 0.22 },
  },
  // A red canyon at sunset: the low sun behind the red goal, right of it (azimuth 13 deg, the sky's
  // disc in world/presets.ts; the key sits a little higher than the disc so the pitch is not lit at
  // a grazing angle), the floodlights already on at half strength, dry turf, a warm haze; a strong
  // orange key against a violet fill, graded warm and contrasty.
  'canyon-sunset': {
    id: 'canyon-sunset',
    night: false,
    keys: [
      { dir: unit(-0.2200, 0.2079, 0.9531), color: [1.0, 0.58, 0.28], intensity: 2.8 },
      { dir: unit(TOWER_X, HEAD_Y, -2900), color: WARM_LAMP, intensity: 1.0 },
    ],
    fill: { sky: [0.4, 0.27, 0.45], ground: [0.32, 0.12, 0.05], intensity: 0.85, env: 0.6 },
    floodlights: towerFloodlights(WARM_LAMP, 0.45),
    wetness: 0.05,
    fog: { color: [0.6, 0.26, 0.14], density: 0.8e-5 },
    toneMapping: 'aces',
    exposure: 1.0,
    grade: { contrast: 1.13, saturation: 1.14, lift: [0.004, 0, 0.004], gain: [1.04, 0.99, 0.93], vignette: 0.32 },
  },
  // "Valle Alto", a mountain valley at midday: the sun high on the left of the blue kickoff view
  // (azimuth -70 deg, elevation 40 deg, the sky's sun disc in world/presets.ts) as the main
  // key, a weak cool sky key from the other side, a bright sky fill, floodlights off, a dry pitch,
  // clear air. Radiometry matches the backdrop: the preset's key.light ~ this key / pi.
  'alpine-day': {
    id: 'alpine-day',
    night: false,
    keys: [
      { dir: unit(0.7198, 0.6428, 0.262), color: [1.0, 0.95, 0.87], intensity: 5.0 },
      { dir: unit(-0.55, 0.6, -0.55), color: [0.7, 0.8, 1.0], intensity: 0.8 },
    ],
    fill: { sky: [0.46, 0.56, 0.74], ground: [0.2, 0.22, 0.12], intensity: 1.0, env: 0.55 },
    floodlights: towerFloodlights(WARM_LAMP, 0),
    wetness: 0.03,
    fog: { color: [0.44, 0.56, 0.76], density: 0.35e-5 },
    toneMapping: 'aces',
    exposure: 1.15,
    grade: { contrast: 1.05, saturation: 1.08, lift: [0, 0, 0.002], gain: [1.0, 1.0, 1.02], vignette: 0.2 },
  },
};

/** The shared world facts of a theme (unknown or not-yet-built themes fall back to the default). */
export function themeWorld(id: ThemeId): ThemeWorld {
  return WORLDS[id] ?? (WORLDS[DEFAULT_THEME] as ThemeWorld);
}

/** A saved theme id, or null. */
export function parseTheme(v: unknown): ThemeId | null {
  return typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v) ? (v as ThemeId) : null;
}

/**
 * The turf's own per-theme parameters (theme.ts holds the facts several views share: the key lights,
 * the floodlights, the wetness). Everything here reaches the shader as uniform values, so a theme
 * switch never recompiles the pitch: TurfView.setTheme writes them and re-bakes the pool map.
 *
 * Pure data (no three.js): tests/turf.test.mjs checks every theme has a sane entry.
 */
import type { Rgb, ThemeId } from '../theme';

export interface TurfLook {
  /** Grass colour multiplier (linear RGB) over the base palette. */
  readonly tint: Rgb;
  /** Yellowing of the blades, 0 lush .. 1 sun-baked. */
  readonly dry: number;
  /** Mowing-stripe contrast (the view-dependent sheen of the bent bands), 0..0.5. */
  readonly stripes: number;
  /** Gain of the baked floodlight pools on the pitch (themeWorld().floodlights; 0 = no pools). */
  readonly pools: number;
  /** Gain of the analytic floodlight streaks on wet turf. */
  readonly streaks: number;
  /**
   * Puddle level: the share of the pitch whose basins hold water at wetness 1 (scaled by the theme's
   * wetness; only on tiers with puddles). Kept low (~0.2): puddles are soft damp patches, never
   * mirror cut-outs.
   */
  readonly puddles: number;
  /** Team tint of each half (0 = none, 1 = the default strength). */
  readonly team: number;
  /**
   * The Performance tier's unlit turf (TierSpec.bakedLight, turfMaterial.ts buildBakedTurfMaterial):
   * the lit grass colour itself (linear RGB, the light baked in: before the exposure and the tone
   * curve), the contrast of the floodlight pools over it (0 = evenly lit, 1 = the pool map's own
   * spread), the mowing-stripe contrast and the brightness of the line paint (x the paint colour).
   */
  readonly baked: { readonly grass: Rgb; readonly pools: number; readonly stripes: number; readonly paint: number };
}

/** The night harbour: streaks and puddles toned down (calm reflections; 1 and 0.36 before). */
const NIGHT: TurfLook = {
  tint: [1.45, 0.9, 0.72],
  dry: 0.05,
  stripes: 0.3,
  pools: 1,
  streaks: 0.55,
  puddles: 0.2,
  team: 1,
  baked: { grass: [0.05, 0.125, 0.03], pools: 0.35, stripes: 0.45, paint: 0.75 },
};

/** Per theme (every ThemeId has one; turfLook falls back to the night look for an unknown id). */
export const TURF_LOOKS: Readonly<Record<ThemeId, TurfLook>> = {
  'harbour-night': NIGHT,
  'canyon-sunset': {
    tint: [1.08, 0.98, 0.84],
    dry: 0.45,
    stripes: 0.28,
    pools: 0.25,
    streaks: 0.5,
    puddles: 0.1,
    team: 1,
    baked: { grass: [0.085, 0.15, 0.035], pools: 0.15, stripes: 0.45, paint: 0.9 },
  },
  'alpine-day': {
    tint: [1.0, 1.07, 0.84],
    dry: 0.06,
    stripes: 0.36,
    pools: 0,
    streaks: 0.4,
    puddles: 0.15,
    team: 1,
    baked: { grass: [0.05, 0.155, 0.032], pools: 0, stripes: 0.45, paint: 1.0 },
  },
};

/** The turf look of a theme. */
export function turfLook(id: ThemeId): TurfLook {
  return TURF_LOOKS[id] ?? NIGHT;
}

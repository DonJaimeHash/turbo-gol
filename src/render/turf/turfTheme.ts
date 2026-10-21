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
}

const NIGHT: TurfLook = { tint: [1, 1, 1], dry: 0.05, stripes: 0.3, pools: 1, streaks: 1, puddles: 0.36, team: 1 };

/** Per theme. Themes not built in theme.ts yet still get their own turf look here. */
export const TURF_LOOKS: Readonly<Record<ThemeId, TurfLook>> = {
  'harbour-night': NIGHT,
  'harbour-day': { tint: [1.02, 1, 0.95], dry: 0.12, stripes: 0.32, pools: 0, streaks: 0.6, puddles: 0.3, team: 1 },
  'canyon-sunset': { tint: [1.08, 0.98, 0.84], dry: 0.45, stripes: 0.28, pools: 0.25, streaks: 0.5, puddles: 0.1, team: 1 },
  'city-dusk': { tint: [0.96, 1, 1.02], dry: 0.05, stripes: 0.3, pools: 0.8, streaks: 1.1, puddles: 0.42, team: 1 },
  'alpine-day': { tint: [1.0, 1.07, 0.84], dry: 0.06, stripes: 0.36, pools: 0, streaks: 0.4, puddles: 0.15, team: 1 },
  'railyard-night': { tint: [1.04, 0.98, 0.9], dry: 0.2, stripes: 0.26, pools: 1, streaks: 1, puddles: 0.42, team: 1 },
};

/** The turf look of a theme. */
export function turfLook(id: ThemeId): TurfLook {
  return TURF_LOOKS[id] ?? NIGHT;
}

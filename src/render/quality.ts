/**
 * Graphics quality tiers. One table says what each tier turns on, so every view (renderer, arena,
 * stadium, turf, sky, cars, ball, effects) reads the same switches instead of comparing tier names.
 *
 *   low    phones, tablets, integrated GPUs and always the WebGL2 fallback's default: no MSAA (FXAA),
 *          no bloom (glow comes from geometry and HDR colour), pixel ratio 1, one shadowed key light,
 *          the cheapest turf, crowd and sky bake.
 *   high   the desktop default: MSAA x4, emissive bloom, two shadowed key lights, relief turf, the
 *          full stadium; a pixel budget with dynamic resolution so big screens keep their refresh rate.
 *   ultra  opt-in on top of high: grass blades near the camera, GTAO, screen-space reflections on wet
 *          turf, floodlight beams, lens flare, bigger shadow maps and pixel budget.
 *
 * The values start as the two old tiers (low = the old performance tier, high and ultra = the old
 * quality 0); the modules of docs/visuals/REWORK.md tune them as they land.
 *
 * The tier is saved with the player's prefs (Game.ts); saves from before the third tier stored a
 * number (0 = high, 1 = performance), which `parseQuality` still reads.
 */

export type Quality = 'low' | 'high' | 'ultra';

/** Menu order (also the order the quality key cycles through). */
export const QUALITIES: readonly Quality[] = ['low', 'high', 'ultra'];

export interface TierSpec {
  /** MSAA samples on the scene pass (WebGPU supports only 1 or 4); 0 = FXAA on the output instead. */
  readonly msaa: 0 | 4;
  /** Emissive bloom (the glow MRT target); without it glow must come from geometry and HDR colour. */
  readonly bloom: boolean;
  /** Bloom mip levels (BloomNode's private _nMips, three pinned to 0.186.x). */
  readonly bloomMips: number;
  /** Highest device pixel ratio used (phones are also capped at 2 by the renderer). */
  readonly maxPixelRatio: number;
  /** Drawing-buffer pixel budget (pixels): above it the pixel ratio drops, never below 1. */
  readonly pixelBudget: number;
  /** Scale the scene pass down (and back up) to hold the display's refresh rate. */
  readonly dynamicResolution: boolean;
  /** Lowest scene-pass resolution scale dynamic resolution may use. */
  readonly minResolutionScale: number;
  /** Key lights that cast shadows (the other key, if any, still lights without shadows). */
  readonly shadowedKeys: 1 | 2;
  /** Shadow map size of each shadowed key and its PCF radius. */
  readonly shadowMapSize: number;
  readonly shadowRadius: number;
  /** Size of one face of the baked sky + backdrop cube map, and of the PMREM environment. */
  readonly skyCubeSize: number;
  readonly envSize: number;
  /** Turf: parallax relief and self-shadowing of the blade texture. */
  readonly turfRelief: boolean;
  /** Turf: real grass blades (instanced geometry) within a few metres of the camera. */
  readonly grassBlades: boolean;
  /** Turf: puddles (else only a damp sheen); analytic floodlight streaks on the wet pitch. */
  readonly puddles: boolean;
  readonly turfStreaks: number;
  /** Stadium: crowd density (people per seat block, 0..1) and the netting's fine wire detail. */
  readonly crowdDensity: number;
  readonly netDetail: boolean;
  /** Stadium: additive floodlight beam cones. */
  readonly beamCones: boolean;
  /** Post: ground-truth ambient occlusion, screen-space reflections on wet pixels, lens flare. */
  readonly gtao: boolean;
  readonly ssr: boolean;
  readonly lensFlare: boolean;
  /** Geometry detail of cars, ball, goal frames and pads (the old quality 0 vs 1 segment counts). */
  readonly detail: 'low' | 'high';
  /** Particle pool size (Effects). */
  readonly particles: number;
}

export const TIERS: Readonly<Record<Quality, TierSpec>> = {
  low: {
    msaa: 0,
    bloom: false,
    bloomMips: 3,
    maxPixelRatio: 1,
    pixelBudget: 2.2e6,
    dynamicResolution: false,
    minResolutionScale: 1,
    shadowedKeys: 1,
    shadowMapSize: 2048,
    shadowRadius: 3,
    skyCubeSize: 512,
    envSize: 128,
    turfRelief: false,
    grassBlades: false,
    puddles: false,
    turfStreaks: 4,
    crowdDensity: 0.5,
    netDetail: false,
    beamCones: false,
    gtao: false,
    ssr: false,
    lensFlare: false,
    detail: 'low',
    particles: 512,
  },
  high: {
    msaa: 4,
    bloom: true,
    bloomMips: 3,
    maxPixelRatio: 2,
    pixelBudget: 6e6,
    dynamicResolution: true,
    minResolutionScale: 0.6,
    shadowedKeys: 2,
    shadowMapSize: 4096,
    shadowRadius: 4,
    skyCubeSize: 1024,
    envSize: 256,
    turfRelief: true,
    grassBlades: false,
    puddles: true,
    turfStreaks: 8,
    crowdDensity: 1,
    netDetail: true,
    beamCones: false,
    gtao: false,
    ssr: false,
    lensFlare: false,
    detail: 'high',
    particles: 1536,
  },
  ultra: {
    msaa: 4,
    bloom: true,
    bloomMips: 3,
    maxPixelRatio: 2,
    pixelBudget: 6e6,
    dynamicResolution: true,
    minResolutionScale: 0.6,
    shadowedKeys: 2,
    shadowMapSize: 4096,
    shadowRadius: 4,
    skyCubeSize: 1024,
    envSize: 256,
    turfRelief: true,
    grassBlades: true,
    puddles: true,
    turfStreaks: 8,
    crowdDensity: 1,
    netDetail: true,
    beamCones: true,
    gtao: true,
    ssr: true,
    lensFlare: true,
    detail: 'high',
    particles: 1536,
  },
};

/** The tier's switches. */
export function tier(q: Quality): TierSpec {
  return TIERS[q];
}

/** A saved tier: the current names, or the numbers saved before the third tier (0 high, 1 performance). */
export function parseQuality(v: unknown): Quality | null {
  if (v === 'low' || v === 'high' || v === 'ultra') return v;
  if (v === 0) return 'high';
  if (v === 1) return 'low';
  return null;
}

/** The next tier in menu order (the quality key cycles low -> high -> ultra -> low). */
export function nextQuality(q: Quality): Quality {
  return QUALITIES[(QUALITIES.indexOf(q) + 1) % QUALITIES.length];
}

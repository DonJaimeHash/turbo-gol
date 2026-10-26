/**
 * Graphics quality tiers. One table says what each tier turns on, so every view (renderer, arena,
 * stadium, turf, sky, cars, ball, effects) reads the same switches instead of comparing tier names.
 * The renderer runs `adjustTier(TIERS[q], capabilities)` (capabilities.ts): the same switches
 * without what the device cannot do (no multisampled HDR target in WebGPU compatibility mode...).
 *
 *   superlow  ("Super low") very weak devices: a 1 GB Android TV on a Mali-G31 (docs/visuals/REWORK.md
 *          "Super low"), set-top boxes, the oldest phones. The direct path of low at about 640x360
 *          (a 230k pixel budget below 1:1, no dynamic resolution: the compositor upscales a fixed
 *          size), 30 fps at most (20 under the menus: sceneFps, FramePacer), no MSAA, no shadow
 *          maps, and nothing built that costs: no world bake (a gradient sky dome from the theme's
 *          colours, no live layer, no environment map, no fog, no IndexedDB: world/liteWorld.ts),
 *          no crowd (the stands are painted), no netting, lamp heads without halos, Lambert /
 *          unlit materials for the cars, the ball and the goals, a small turf texture instead of
 *          the blade field, 128 particles kept small on screen, and the game's own CPU trims
 *          (`cpuLite`). Its backend and world are chosen when the renderer is created (WebGL2 by
 *          default, `preferWebGL2`), so switching into or out of it reloads the page
 *          (`needsReload`); low / high / ultra switch in place.
 *   low    phones, tablets, integrated GPUs, WebGPU compatibility mode, small-memory devices and the
 *          WebGL2 fallback's default: renders STRAIGHT to the canvas (`output: 'direct'`: no HDR
 *          target, no MRT, no post pass; exposure, grade, vignette, tone curve and sRGB run at the
 *          end of every material's shader) with the canvas's MSAA x4 (none in WebGPU compatibility
 *          mode: capabilities.ts), no bloom (glow comes from geometry and colour), a pixel ratio
 *          up to 1.5 within a 1 Mpx budget with dynamic
 *          resolution down to 0.6 of it, no shadow maps (the cars and the ball keep their ground
 *          blobs), and its own look rather than a cut-down high: the turf, stands, steel and boards
 *          unlit with the theme's light baked into their colour (`bakedLight`), no cage netting,
 *          a bright flat crowd, the smallest sky bake, a brighter grade per theme (theme.ts `low`).
 *   high   the desktop default: MSAA x4, emissive bloom, two shadowed key lights (2048 maps), relief
 *          turf, the full stadium; a pixel budget with dynamic resolution so big screens keep their
 *          refresh rate.
 *   ultra  opt-in on top of high: grass blades near the camera, GTAO, screen-space reflections on wet
 *          turf, floodlight beams, lens glare, and 4096 shadow maps (see `shadowMapSize`: two 8192
 *          maps would hold about 1 GB). It keeps MSAA x4 (no TRAA: no per-object motion vectors).
 *
 * The values start as the two old tiers (low = the old performance tier, high and ultra = the old
 * quality 0); the modules of docs/visuals/REWORK.md tune them as they land.
 *
 * The tier is saved with the player's prefs (Game.ts); saves from before the third tier stored a
 * number (0 = high, 1 = performance), which `parseQuality` still reads.
 */

export type Quality = 'superlow' | 'low' | 'high' | 'ultra';

/** Menu order (also the order the quality key cycles through), lowest first. */
export const QUALITIES: readonly Quality[] = ['superlow', 'low', 'high', 'ultra'];

export interface TierSpec {
  /**
   * How the frame reaches the canvas. 'post': the HDR pipeline of post/pipeline.ts (a HalfFloat
   * scene pass, MRT with the glow target when `bloom`, the composite, FXAA without MSAA). 'direct':
   * `renderer` draws the scene straight into the canvas (three's DirectRenderPipeline: the look
   * of post/pipeline.ts `finish` and sRGB at the end of each material's fragment shader; no HDR
   * target, no MRT, no post pass), the cheapest path on every GPU: one pass, 8-bit, MSAA resolved
   * on tile. Blending happens after the tone curve (display space) there.
   */
  readonly output: 'direct' | 'post';
  /**
   * MSAA samples (WebGPU supports only 1 or 4). 'post': on the HDR scene pass, 0 = FXAA on the
   * output instead. 'direct': on the canvas, 0 = no anti-aliasing.
   */
  readonly msaa: 0 | 4;
  /** Emissive bloom (the glow MRT target); without it glow must come from geometry and HDR colour. */
  readonly bloom: boolean;
  /** Bloom mip levels, 1..5 (BloomNode's private _nMips, three pinned to 0.186.x); post/pipeline.ts weights them for a tight halo. */
  readonly bloomMips: number;
  /**
   * Highest device pixel ratio used (Infinity = only the pixel budget limits it; phones and tablets
   * are also capped at MAX_TOUCH_PIXEL_RATIO). 1 renders at CSS resolution. See `pixelRatio`.
   */
  readonly maxPixelRatio: number;
  /** Drawing-buffer pixel budget (pixels): above it the pixel ratio drops, never below 1. */
  readonly pixelBudget: number;
  /**
   * Scale the resolution down (and back up) to hold the display's refresh rate: the scene pass on
   * 'post' tiers, the canvas' pixel ratio on the 'direct' tier.
   */
  readonly dynamicResolution: boolean;
  /** Lowest resolution scale dynamic resolution may use. */
  readonly minResolutionScale: number;
  /**
   * Theme key lights that cast shadows (post/lighting.ts: keys[0] first; a key without one still
   * lights). None on low: the cars' and the ball's ground blobs ground them there (the cars show
   * theirs at all times on low), no material samples a shadow map, and the shadow pass is gone.
   * Phones start on low, and the shadow-map sampling is the one path every material that went
   * missing on a Mali-G51 Android phone shared (the pitch, the cars and the ball, the only
   * receivers; three r186 also takes an Android-only depth-compare fallback for it on WebGPU).
   */
  readonly shadowedKeys: 0 | 1 | 2;
  /**
   * Shadow map size of each shadowed key and its PCF radius. GPU memory: three r186's shadow target
   * holds a depth24plus map AND an unused RGBA8 colour texture of the same size, 8 bytes per texel:
   * 2048 = 34 MB, 4096 = 134 MB per shadowed key: low none, high 67 MB (two 2048 keys, the
   * desktop default stays lean), ultra 268 MB (two 4096 keys, the sharpest car shadows).
   */
  readonly shadowMapSize: number;
  readonly shadowRadius: number;
  /** Size of one face of the baked sky + backdrop cube map, and of the PMREM environment. */
  readonly skyCubeSize: number;
  readonly envSize: number;
  /** Turf: parallax relief and self-shadowing of the blade texture. */
  readonly turfRelief: boolean;
  /** Turf: real grass blades (instanced geometry) within a few metres of the camera. */
  readonly grassBlades: boolean;
  /**
   * Turf: puddles (else only a damp sheen); analytic floodlight streaks on the wet pitch, from the
   * `turfStreaks` heads of turf/bake.ts streakLamps (0 = none: the baked-light turf of low has no
   * sheen to reflect them; 4 = the four corners; each head is a loop step per wet pixel).
   */
  readonly puddles: boolean;
  readonly turfStreaks: number;
  /**
   * The Performance look (low): the big static surfaces are unlit, their light baked into their
   * colour from the theme, so they cost no light loop, no environment read and no specular: the
   * turf is a clean, evenly lit green (mowing stripes, markings, team tint, the floodlight pools
   * at a low contrast; no wear, damp, sheen, puddles or streaks: turf/), the stands, the steel and
   * the boards take one dot product of the theme's light, the crowd a bright flat palette
   * (stadium/). The cars, the ball and the goals stay lit (the theme's keys and fill: their low
   * overrides, theme.ts `lightsOf`).
   */
  readonly bakedLight: boolean;
  /**
   * Stadium: the cage's wire netting (one transparent layer over most of the upper screen, about a
   * tenth of the old low frame's pixel cost). Without it the steel frame alone draws the cage.
   */
  readonly netting: boolean;
  /** Stadium: crowd density (people per seat block, 0..1) and the netting's fine wire detail. */
  readonly crowdDensity: number;
  readonly netDetail: boolean;
  /** Stadium: additive floodlight beam cones. */
  readonly beamCones: boolean;
  /**
   * Post (post/screenSpace.ts): half-resolution ground-truth ambient occlusion, half-resolution
   * screen-space reflections on the wet pitch, procedural lens glare (streak + ghosts) of the
   * brightest emissive. Ultra-only: together about +0.9 ms at 1600x900 on the reference GPU.
   */
  readonly gtao: boolean;
  readonly ssr: boolean;
  readonly lensFlare: boolean;
  /** Geometry detail of cars, ball, goal frames and pads (the old quality 0 vs 1 segment counts). */
  readonly detail: 'low' | 'high';
  /** Particle pool size (Effects). */
  readonly particles: number;
  /**
   * The world round the stadium (world/): 'baked' the sky and backdrop bake (a HalfFloat cube, the
   * PMREM environment, the live near layer, fog, the IndexedDB cache); 'lite' a gradient dome from
   * the theme's sky colours and nothing else (no environment map, no fog, no render target).
   */
  readonly world: 'baked' | 'lite';
  /**
   * The cars, the ball and the goals on cheap materials (Lambert and unlit, no clearcoat, no
   * environment), the particles capped on screen, no flash shells.
   */
  readonly cheapMaterials: boolean;
  /** Stadium: the instanced SDF crowd (off: the stand rows are painted, opaque). */
  readonly crowd: boolean;
  /** Stadium: the glare sprites round the lamp heads (off: the lamp panels alone). */
  readonly glare: boolean;
  /** Turf: a small grain texture instead of the blade field and no field map (the unlit turf only). */
  readonly liteTurf: boolean;
  /**
   * Frames per second at most in a match (0 = the display's rate): extra animation frames are
   * skipped. Under the menus the scene runs slower still (sceneFps).
   */
  readonly maxFps: number;
  /** The tier starts the WebGL2 backend unless the URL asks for WebGPU (decided before the renderer exists). */
  readonly preferWebGL2: boolean;
  /**
   * The game's CPU trims (Game.ts): the HUD without blur, shadows or decorative animation (a class
   * on <html>) and its texts at 10 Hz, no audio room, the ball prediction every 8 ticks instead of
   * 4, a one-line notice when going online.
   */
  readonly cpuLite: boolean;
}

/**
 * Super low's drawing-buffer budget (pixels): 640x360. Below 1:1 the pixel ratio follows it
 * (`pixelRatio`), so the internal resolution stays about the same on any screen.
 */
export const SUPERLOW_PIXELS = 640 * 360;

export const TIERS: Readonly<Record<Quality, TierSpec>> = {
  superlow: {
    output: 'direct',
    msaa: 0,
    bloom: false,
    bloomMips: 3,
    // About 640x360 whatever the screen (SUPERLOW_PIXELS below 1:1, pixelRatio): a 962x541 CSS TV
    // (dpr 1.33, a 1280x720 UI surface) draws exactly 640x360, which its compositor doubles.
    maxPixelRatio: 1,
    pixelBudget: SUPERLOW_PIXELS,
    dynamicResolution: false,
    minResolutionScale: 1,
    shadowedKeys: 0,
    shadowMapSize: 512,
    shadowRadius: 1,
    skyCubeSize: 64,
    envSize: 32,
    turfRelief: false,
    grassBlades: false,
    puddles: false,
    turfStreaks: 0,
    bakedLight: true,
    netting: false,
    crowdDensity: 0,
    netDetail: false,
    beamCones: false,
    gtao: false,
    ssr: false,
    lensFlare: false,
    detail: 'low',
    particles: 128,
    world: 'lite',
    cheapMaterials: true,
    crowd: false,
    glare: false,
    liteTurf: true,
    maxFps: 30,
    preferWebGL2: true,
    cpuLite: true,
  },
  low: {
    output: 'direct',
    msaa: 4,
    bloom: false,
    bloomMips: 3,
    // Up to 1.5x on a phone (780x360 CSS -> 1170x540), 1 on desktops and tablets (the budget, never
    // below 1 for it); dynamic resolution goes down to 0.6 of that when frames come late (a phone
    // 702x324): fluid first, and only as far down as the frames need.
    maxPixelRatio: 1.5,
    pixelBudget: 1e6,
    dynamicResolution: true,
    minResolutionScale: 0.6,
    shadowedKeys: 0,
    shadowMapSize: 2048,
    shadowRadius: 3,
    skyCubeSize: 512,
    envSize: 128,
    turfRelief: false,
    grassBlades: false,
    puddles: false,
    turfStreaks: 0,
    bakedLight: true,
    netting: false,
    crowdDensity: 0.5,
    netDetail: false,
    beamCones: false,
    gtao: false,
    ssr: false,
    lensFlare: false,
    detail: 'low',
    particles: 512,
    world: 'baked',
    cheapMaterials: false,
    crowd: true,
    glare: true,
    liteTurf: false,
    maxFps: 0,
    preferWebGL2: false,
    cpuLite: false,
  },
  high: {
    output: 'post',
    msaa: 4,
    bloom: true,
    bloomMips: 5,
    maxPixelRatio: Infinity,
    pixelBudget: 6e6,
    dynamicResolution: true,
    minResolutionScale: 0.6,
    shadowedKeys: 2,
    shadowMapSize: 2048,
    shadowRadius: 3,
    skyCubeSize: 1024,
    envSize: 256,
    turfRelief: true,
    grassBlades: false,
    puddles: true,
    turfStreaks: 4,
    bakedLight: false,
    netting: true,
    crowdDensity: 1,
    netDetail: true,
    beamCones: false,
    gtao: false,
    ssr: false,
    lensFlare: false,
    detail: 'high',
    particles: 1536,
    world: 'baked',
    cheapMaterials: false,
    crowd: true,
    glare: true,
    liteTurf: false,
    maxFps: 0,
    preferWebGL2: false,
    cpuLite: false,
  },
  ultra: {
    output: 'post',
    msaa: 4,
    bloom: true,
    bloomMips: 5,
    maxPixelRatio: Infinity,
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
    turfStreaks: 4,
    bakedLight: false,
    netting: true,
    crowdDensity: 1,
    netDetail: true,
    beamCones: true,
    gtao: true,
    ssr: true,
    lensFlare: true,
    detail: 'high',
    particles: 1536,
    world: 'baked',
    cheapMaterials: false,
    crowd: true,
    glare: true,
    liteTurf: false,
    maxFps: 0,
    preferWebGL2: false,
    cpuLite: false,
  },
};

/** The tier's switches. */
export function tier(q: Quality): TierSpec {
  return TIERS[q];
}

/** Phones and tablets render at most at this pixel ratio on any tier (their DPR of 3+ costs ~2x the pixels). */
export const MAX_TOUCH_PIXEL_RATIO = 2;

/**
 * The drawing-buffer pixel ratio of tier `spec` for a canvas of `cssW` x `cssH` CSS pixels: the
 * device pixel ratio up to the tier's maxPixelRatio (and MAX_TOUCH_PIXEL_RATIO on a `touch`
 * screen), lowered to fit the pixel budget but never below 1:1 for it; a tier whose maxPixelRatio is
 * 1 or less renders at most at CSS resolution and goes BELOW it for its budget (super low: about
 * SUPERLOW_PIXELS on any screen), snapped so the drawing buffer is the budget's whole size (three
 * floors width x ratio and height x ratio: a 962x541 CSS canvas gets exactly 640x360). (A dpr-2
 * 1080p laptop on high renders at ~1.7x instead of 2x.) The drawing buffer never exceeds
 * `maxTextureSize` on either side (the device's largest render target: 4096 in WebGPU
 * compatibility mode), which may take the ratio below 1 on a huge canvas.
 */
export function pixelRatio(spec: TierSpec, devicePixelRatio: number, touch: boolean, cssW: number, cssH: number, maxTextureSize = Infinity): number {
  const fit = maxTextureSize / Math.max(1, cssW, cssH);
  if (!(spec.maxPixelRatio > 1)) {
    const budget = Math.sqrt(spec.pixelBudget / Math.max(1, cssW * cssH));
    const r = Math.min(1, spec.maxPixelRatio, fit, budget);
    if (!(r < 1) || r !== budget) return r;
    // Below 1:1 for the budget: the ratio whose floored size is the rounded one on both axes.
    const w = Math.max(1, Math.round(cssW * r));
    const h = Math.max(1, Math.round(cssH * r));
    return Math.min(1, fit, Math.max(w / Math.max(1, cssW), h / Math.max(1, cssH)) + 1e-7);
  }
  let dpr = Math.min(devicePixelRatio || 1, spec.maxPixelRatio);
  if (touch) dpr = Math.min(dpr, MAX_TOUCH_PIXEL_RATIO);
  return Math.min(dpr, Math.max(1, Math.sqrt(spec.pixelBudget / (cssW * cssH))), fit);
}

/** A saved tier: the current names, or the numbers saved before the third tier (0 high, 1 performance). */
export function parseQuality(v: unknown): Quality | null {
  if (typeof v === 'string' && (QUALITIES as readonly string[]).includes(v)) return v as Quality;
  if (v === 0) return 'high';
  if (v === 1) return 'low';
  return null;
}

/** What the starting tier depends on besides the saved one (read at renderer init). */
export interface StartingDevice {
  /** WebGPU (false: the WebGL2 fallback). */
  readonly webgpu: boolean;
  /** WebGPU in compatibility mode (an OpenGL ES driver: older or low-end phones). */
  readonly compatibilityMode: boolean;
  /** navigator.deviceMemory in GB (Chromium only, rounded down to 0.25..8); undefined elsewhere. */
  readonly deviceMemory: number | undefined;
}

/** Devices with this much memory (GB) or less start on low (Chromium reports 4 for 4 GB phones). */
export const LOW_MEMORY_GB = 4;

/**
 * The tier a session starts on, once the renderer knows its backend: the boot's tier `saved`
 * (bootTier.ts: the player's, the URL's, super low on a weak TV, or the default), except on a
 * device that should start on low unless the player chose a tier in the menu (`chosen`): the
 * WebGL2 fallback (it compiles every pipeline several times slower and renders about 2x slower
 * than WebGPU), WebGPU in compatibility mode (OpenGL ES phones) and devices with LOW_MEMORY_GB or
 * less. Only tiers above low come down to it: super low stays (it was decided for a weaker device
 * than these). Phones and tablets already start on low through their default (Game.ts loadPrefs).
 * `ceiling` is the highest tier that has not failed on this GPU (tierGuard.ts), which caps even a
 * chosen tier (and may be super low).
 */
export function startingQuality(saved: Quality, chosen: boolean, device: StartingDevice, ceiling: Quality | null = null): Quality {
  const weak = !device.webgpu || device.compatibilityMode || (device.deviceMemory !== undefined && device.deviceMemory <= LOW_MEMORY_GB);
  const q = weak && !chosen && QUALITIES.indexOf(saved) > QUALITIES.indexOf('low') ? 'low' : saved;
  return ceiling !== null && QUALITIES.indexOf(ceiling) < QUALITIES.indexOf(q) ? ceiling : q;
}

/**
 * Switching from `from` to `to` needs a page reload: the two tiers want a different backend or a
 * different world, both chosen when the renderer is created (super low <-> the others). Pure.
 */
export function needsReload(from: Quality, to: Quality): boolean {
  const a = TIERS[from];
  const b = TIERS[to];
  return a.world !== b.world || a.preferWebGL2 !== b.preferWebGL2;
}

/**
 * Whether the animation frame at `now` (ms) is drawn when the last drawn one was at `last` (ms, < 0
 * = none) and the tier draws at most `maxFps` frames a second (0 = all). A frame is drawn once
 * the interval is within 2 ms of the cap's (rAF timestamps sit on vsyncs: 30 fps on a 60 Hz
 * display, 25 on 50 Hz, every frame of a device already slower than the cap). The skipped frames
 * change nothing: the game's clock reads the time of the next drawn one. Pure.
 */
export function drawsFrame(now: number, last: number, maxFps: number): boolean {
  if (!(maxFps > 0) || last < 0) return true;
  const gap = now - last;
  return gap < 0 || gap >= 1000 / maxFps - 2;
}

/**
 * "UI at rest" (Game.ts frame): what lies over the 3D scene. 'none': a match, or nothing; 'partial':
 * the menus with the stadium showing through (Game.setMenuCover, reported by src/ui/Menu.ts);
 * 'opaque': a layer that hides it (a menu modal, the settings screen, the rotate-your-phone screen).
 */
export type SceneCover = 'none' | 'partial' | 'opaque';

/** sceneFps: no frame at all, the last one drawn stays on the canvas until something changes. */
export const HELD_FRAME = -1;
/** The scene's rate under the menus (sceneFps); MENU_FPS_LITE on super low and on a phone whose menus hide most of it. */
export const MENU_FPS = 30;
export const MENU_FPS_LITE = 20;
/** A touch screen's menus that hide more than this share of it (src/ui/cover.ts coverShare) draw the scene at MENU_FPS_LITE. */
export const MENU_COVER_LITE = 0.7;

/** The player's frame limit (GamePrefs.fpsCap: the Graphics row of a later settings page): 0 = the display's rate. */
export type FpsCap = 0 | 30 | 60;
export const FPS_CAPS: readonly FpsCap[] = [0, 30, 60];

/** A saved frame limit; anything else is 0 (no limit). Pure. */
export function parseFpsCap(v: unknown): FpsCap {
  return v === 30 || v === 60 ? v : 0;
}

/** The lower of two frame caps (frames per second, 0 = none): the tier's maxFps and the player's limit. Pure. */
export function frameCap(a: number, b: number): number {
  if (!(a > 0)) return b > 0 ? b : 0;
  return b > 0 && b < a ? b : a;
}

/** What decides the scene's rate (sceneFps), read by the Game every frame. */
export interface ScenePace {
  readonly cover: SceneCover;
  /** The frame cap of a match (frameCap of the tier's maxFps and GamePrefs.fpsCap; 0 = none). */
  readonly cap: number;
  /** The tier's CPU trims (TierSpec.cpuLite: super low). */
  readonly lite: boolean;
  /** Nothing in the scene moves: an offline pause (pauseHolds: the sim stopped, the views and the camera frozen). */
  readonly still: boolean;
  /** The menus' stadium may move: GamePrefs.menuSceneAnimated, and no prefers-reduced-motion (the orbit stops). */
  readonly animated: boolean;
  /** A touch screen (coarse pointer), and the share of the screen the menus hide (coverShare; 0 elsewhere). */
  readonly phone: boolean;
  readonly covered: number;
}

/**
 * ScenePace.still: a pause holds the scene in an offline match or training (the sim stopped, the
 * views and the camera frozen), not under the menus; never with a session active (`online`), whose
 * match goes on under its pause and after its whistle ('ended', until the menus come back). Pure.
 */
export function pauseHolds(paused: boolean, menus: boolean, online: boolean): boolean {
  return paused && !menus && !online;
}

/**
 * Frames per second the scene is drawn at (0 = every animation frame, HELD_FRAME = none): a match
 * at its cap; the menus at MENU_FPS, MENU_FPS_LITE on super low or on a phone whose menus hide
 * more than MENU_COVER_LITE of it, one held frame when their stadium may not move; one held frame
 * under an opaque layer and in an offline pause. Never above the cap. Pure.
 */
export function sceneFps(p: ScenePace): number {
  if (p.cover === 'opaque' || p.still) return HELD_FRAME;
  if (p.cover === 'none') return p.cap;
  if (!p.animated) return HELD_FRAME;
  return frameCap(p.cap, p.lite || (p.phone && p.covered > MENU_COVER_LITE) ? MENU_FPS_LITE : MENU_FPS);
}

/** FramePacer: the share of each frame's lateness (or earliness) that moves the next deadline. */
const PACE_PULL = 0.1;

/**
 * A frame rate that keeps its average on any display (the menus' 30 / 20 fps, the player's
 * GamePrefs.fpsCap: Game.ts frame). drawsFrame rounds every wait up to whole refreshes, which
 * loses up to one refresh a frame (27.5 fps for 30 on 165 Hz, 16.7 for 20 on 50 Hz, 37.5 for 60
 * on 75 Hz). Here an animation frame is drawn when it is the refresh nearest the deadline (within
 * half the last rAF interval of it), and the next deadline is one period after that one, moved
 * PACE_PULL of the way toward the frame actually drawn: elsewhere the frames alternate between
 * the two nearest counts of refreshes and the average holds (30 on 144 / 165 Hz: 5 and 6
 * refreshes on 165; 20 on 50 Hz: 2 and 3); on a display a hair off a multiple of the rate
 * (59.94 / 60.05 / 119.88 Hz) the pull locks it to the display (30.03 fps on 60.05 Hz, every
 * second refresh), where a strict deadline would skip or double a refresh every few seconds.
 * More than a period late (a stall, a frame rate the display cannot give) starts the deadline
 * over from the frame drawn. Call it on every animation frame where it paces (it reads the
 * display's period from them).
 */
export class FramePacer {
  private due = -1;
  private prev = -1;

  /** Forget the deadline: the next frame is drawn and starts a new one. */
  reset(): void {
    this.due = -1;
  }

  /**
   * Whether the animation frame at `now` (ms) is drawn at `fps` (0 or less: every frame); `force`
   * draws it and starts the deadline over from it (a change of pace, a redraw).
   */
  draws(now: number, fps: number, force = false): boolean {
    const gap = this.prev >= 0 ? now - this.prev : 0;
    this.prev = now;
    if (!(fps > 0)) {
      this.due = -1;
      return true;
    }
    const period = 1000 / fps;
    const lead = this.due - now;
    // Not yet: more than half a refresh before the deadline (two periods or more before it: a clock that went back).
    if (!force && this.due >= 0 && lead > 0.5 * Math.min(gap > 0 ? gap : 0, period) && lead < 2 * period) return false;
    this.due = force || this.due < 0 || lead < -period || lead >= 2 * period ? now + period : this.due + period - PACE_PULL * lead;
    return true;
  }
}

/**
 * Whether the animation frame at `now` (ms) runs the game's logic (input, sim, session) when the
 * last one that did was at `last` (ms, < 0 = none): a match being played (`live`) keeps its frame
 * cap (the frames in between do nothing, the next one carries their time); the tier's own cap
 * (super low's 30: `pacer` null) in whole refreshes as drawsFrame, so a match runs as it always
 * did, a lower GamePrefs.fpsCap through `pacer` at its average. The menus and an offline pause run
 * every animation frame, so a pad press is read whatever the scene's rate (a press shorter than
 * one drawn frame is not lost).
 */
export function runsLogic(now: number, last: number, cap: number, live: boolean, pacer: FramePacer | null): boolean {
  if (!live) return true;
  return pacer === null ? drawsFrame(now, last, cap) : pacer.draws(now, cap);
}

/**
 * Whether the animation frame at `now` (ms) draws the scene at `fps` (sceneFps, 0 = every frame):
 * never for HELD_FRAME, always when `redraw` (something under the held frame changed: the canvas
 * size, the cover, a rebuilt view; a change of pace); else through `pacer` (the menus' rates, the
 * player's limit: their average), or with `pacer` null in whole refreshes from the last drawn
 * frame at `last` (ms, < 0 = none) as drawsFrame (the tier's own cap).
 */
export function drawsScene(now: number, last: number, fps: number, redraw: boolean, pacer: FramePacer | null): boolean {
  if (fps === HELD_FRAME) {
    pacer?.reset();
    return redraw;
  }
  if (pacer === null) return redraw || drawsFrame(now, last, fps);
  return pacer.draws(now, fps, redraw);
}

/** The tier below `q` (ultra -> high -> low -> superlow), null below super low. */
export function lowerQuality(q: Quality): Quality | null {
  const i = QUALITIES.indexOf(q);
  return i > 0 ? QUALITIES[i - 1] : null;
}

/** The tiers a player without experimental features may pick (bootTier.ts gateTierPrefs). */
export const LOCKED_QUALITIES: readonly Quality[] = ['low', 'high', 'ultra'];

/**
 * The tiers Settings > Graphics lists: every tier for a signed-in player with experimental
 * features on (`unlocked`, src/game/experimentalStore.ts), else all but super low. Only the pick
 * is gated: a device still starts on super low by itself (bootTier.ts auto, the URL, the tab's
 * recovery, a ceiling) and the safety net still falls into it (`lowerQuality`). Pure.
 */
export function menuQualities(unlocked: boolean): readonly Quality[] {
  return unlocked ? QUALITIES : LOCKED_QUALITIES;
}

/**
 * The next tier of `list` in menu order, wrapping (the legacy quality key: superlow -> low -> high
 * -> ultra -> superlow with every tier); a tier outside the list steps to the first listed one above it.
 */
export function nextQuality(q: Quality, list: readonly Quality[] = QUALITIES): Quality {
  if (list.length === 0) return q;
  const i = list.indexOf(q);
  if (i >= 0) return list[(i + 1) % list.length];
  const rank = QUALITIES.indexOf(q);
  return list.find((x) => QUALITIES.indexOf(x) > rank) ?? list[0];
}

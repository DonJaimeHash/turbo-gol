/**
 * The tier a page load starts on, decided BEFORE the renderer exists: super low wants its own
 * backend (WebGL2) and a context without MSAA, both fixed when three creates them, and a world
 * without the bake (quality.ts `world`). Renderer.create still adjusts the result once the
 * backend is known (quality.ts startingQuality: low on weak backends, the GPU's remembered
 * ceiling; the WebGL2 float-target guard) without ever raising super low.
 *
 * Precedence (`bootTier`):
 *   1. `#superlow` in the URL ('hash'), or the tab's recovery after a second lost device
 *      ('recover', sessionStorage: tierGuard.ts lossStep): super low for this page load only.
 *      Neither is ever saved: the prefs keep the player's own tier (Game.persistPrefs).
 *   1b. A GPU of this device fell back to super low ('ceiling': tierGuard.ts readSuperlowBoot), a
 *      ceiling known before the backend, so the fallback gets super low's backend and context;
 *      not while the player's own pick across a reload is tried (Renderer.create).
 *   2. The player's choice in Settings > Graphics ('chosen', prefs.qualitySet). Super low is a
 *      pick for signed-in players with experimental features on only: main.ts runs the prefs
 *      through `gateTierPrefs` first, so anyone else's saved super low reads as Performance, not
 *      chosen, and falls through to auto (a weak TV still gets super low by itself).
 *   3. Auto: super low on a device with no pointer at all (a TV: neither fine nor coarse) whose
 *      GPU is on the slow list ('tv-gpu'; the GPU string comes from a throwaway WebGL2 context,
 *      `probeGpu`), or on 1 GB or less (`navigator.deviceMemory` <= 1: 'memory'). Phones (coarse
 *      pointer) and computers (fine) never get it from the GPU list: phones start on low anyway.
 *   4. Otherwise the saved or default tier ('default': low on phones, high elsewhere, Game.ts
 *      loadPrefs).
 *
 * The slow list holds what this game measured or what is the same class: Mali-G31 (the 1 GB TV:
 * 3 fps on the old low tier), Mali-G51 / G52 (Chromecast-class TVs and boxes; only on TVs: the
 * phones with them run low), Mali-T7xx / T8xx (Midgard) and PowerVR GE8xxx. Extend it when a
 * device that slips past it is seen (#diag shows the string and the reason).
 *
 * Pure except `pointerKind` and `probeGpu` (DOM); `navigator.deviceMemory` exists only in a secure
 * context (https or localhost) and on Chromium: undefined is never read as a small device.
 */
import { parseQuality, type Quality } from './quality';

export type PointerKind = 'fine' | 'coarse' | 'none';

/** What decides super low before the renderer exists. */
export interface BootSignals {
  /** navigator.deviceMemory (GB, Chromium in a secure context), undefined elsewhere. */
  readonly deviceMemory: number | undefined;
  /** The primary pointer: 'none' is a TV (a remote or a gamepad). */
  readonly pointer: PointerKind;
  /** The unmasked WebGL renderer string ('' when not probed: a fine or coarse pointer). */
  readonly gpu: string;
}

/** Why the session runs its tier (#diag; Renderer.tierReason). */
export type TierReason =
  | 'hash'
  | 'recover'
  | 'chosen'
  | 'memory'
  | 'tv-gpu'
  | 'default'
  /** Renderer.create lowered it: a weak backend (WebGL2, compatibility mode, <= 4 GB). */
  | 'weak'
  /** Renderer.create capped it at the GPU's remembered ceiling (tierGuard.ts). */
  | 'ceiling'
  /** Renderer.create: WebGL2 without any renderable float format (the world bake would be black). */
  | 'nofloat'
  /** The safety net fell back to it during the session (tierGuard.ts). */
  | 'fallback';

/** GPUs that start on super low when the device has no pointer (a TV). */
export const SLOW_TV_GPU = /\bMali-(?:G31|G51|G52|T7\d\d|T8\d\d)\b|\bGE8\d{3}\b/i;

/** Devices with this much memory (GB) or less start on super low (Chromium reports 1 for 1 GB and less). */
export const SUPERLOW_MEMORY_GB = 1;

/** Why auto picks super low for `s`, or null. Pure. */
export function autoSuperlow(s: BootSignals): 'memory' | 'tv-gpu' | null {
  if (s.pointer === 'none' && SLOW_TV_GPU.test(s.gpu)) return 'tv-gpu';
  if (s.deviceMemory !== undefined && s.deviceMemory > 0 && s.deviceMemory <= SUPERLOW_MEMORY_GB) return 'memory';
  return null;
}

/** Only TVs are probed: the slow list is read for them alone (a phone keeps low, a computer high). */
export function needsGpuProbe(pointer: PointerKind): boolean {
  return pointer === 'none';
}

export interface BootPrefs {
  /** The prefs' tier (the player's when `qualitySet`, else the saved default). */
  readonly quality: Quality;
  readonly qualitySet: boolean;
}

/** What forces the tier for this page load only: the URL, or the tab's recovery after lost devices. */
export type BootForce = 'hash' | 'recover' | null;

/**
 * The boot tier and why (see the file header). `capped`: a GPU of this device fell back to super
 * low (tierGuard.ts readSuperlowBoot), which caps even the player's tier like any ceiling; the
 * caller leaves it false while the player's pick across a reload is tried (TRY_TIER_KEY). Pure.
 */
export function bootTier(prefs: BootPrefs, signals: BootSignals, force: BootForce, capped = false): { tier: Quality; reason: TierReason } {
  if (force !== null) return { tier: 'superlow', reason: force };
  if (capped) return { tier: 'superlow', reason: 'ceiling' };
  const saved = parseQuality(prefs.quality) ?? 'high';
  if (prefs.qualitySet) return { tier: saved, reason: 'chosen' };
  const auto = autoSuperlow(signals);
  if (auto !== null) return { tier: 'superlow', reason: auto };
  return { tier: saved, reason: 'default' };
}

/** The primary pointer of this device. */
export function pointerKind(): PointerKind {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'fine';
  try {
    if (window.matchMedia('(pointer: fine)').matches) return 'fine';
    if (window.matchMedia('(pointer: coarse)').matches) return 'coarse';
    return 'none';
  } catch {
    return 'fine';
  }
}

/**
 * The GPU's name from a throwaway WebGL2 context (WEBGL_debug_renderer_info; the plain RENDERER
 * string without it), released at once with WEBGL_lose_context so the game's canvas and backend
 * are untouched. '' when WebGL2 is unavailable.
 */
export function probeGpu(): string {
  if (typeof document === 'undefined') return '';
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (gl === null) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
    const name = String(gl.getParameter(ext !== null ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose !== null) lose.loseContext();
    return name;
  } catch {
    return '';
  }
}

/** The signals of this device (`tv`: the #tv emulation's 1 GB and no pointer). */
export function readBootSignals(tv: boolean): BootSignals {
  const nav = typeof navigator !== 'undefined' ? (navigator as unknown as { deviceMemory?: number }) : {};
  const pointer = tv ? 'none' : pointerKind();
  return { deviceMemory: tv ? 1 : nav.deviceMemory, pointer, gpu: needsGpuProbe(pointer) ? probeGpu() : '' };
}

/** What the prefs keep of the tier (Game.persistPrefs). */
export interface TierPrefs {
  readonly quality: Quality;
  readonly qualitySet: boolean;
}

/** What the prefs fall back to when super low is picked by a player who may not pick it: Performance, not chosen. */
const LOCKED_PREFS: TierPrefs = { quality: 'low', qualitySet: false };

/**
 * The prefs after an event: the player's pick in the menu ('pick') becomes their tier; a tier the
 * session runs on its own ('run': #superlow, the tab's recovery, auto super low, low on a weak
 * backend, a GPU's ceiling, the float-target guard, a fallback) never touches them, so the next
 * page load decides again from the same prefs; 'lock' (the player can no longer pick super low:
 * signed out, another account, experimental features off) turns a super low pick into
 * Performance, not chosen (`gateTierPrefs`). Pure.
 */
export function tierPrefsAfter(
  prefs: TierPrefs,
  event: { readonly kind: 'pick'; readonly tier: Quality } | { readonly kind: 'run'; readonly tier: Quality; readonly reason: TierReason } | { readonly kind: 'lock' },
): TierPrefs {
  if (event.kind === 'pick') return { quality: event.tier, qualitySet: true };
  if (event.kind === 'lock') return gateTierPrefs(prefs, false);
  return prefs;
}

/**
 * Super low is a pick for signed-in players with experimental features on (`unlocked`,
 * src/game/experimentalStore.ts unlockedAtBoot at boot): anyone else's saved pick of it reads as
 * Performance, NOT chosen, so the auto rule still starts a TV on the slow-GPU list or a 1 GB
 * device on super low by itself, and the URL, the tab's recovery and a ceiling still force it
 * (they come before the prefs in `bootTier`). Every other pick is kept. Returns `prefs` itself
 * when nothing changes. Pure.
 */
export function gateTierPrefs<P extends TierPrefs>(prefs: P, unlocked: boolean): P {
  if (unlocked || !prefs.qualitySet || prefs.quality !== 'superlow') return prefs;
  return { ...prefs, ...LOCKED_PREFS };
}

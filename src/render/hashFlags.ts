/**
 * The URL hash flags (`#diag&stats&pr=0.5`), read once at boot. Every flag is a whole word of the
 * hash: a name between the start or `&` (after the `#`) and `&` or the end, optionally with a
 * `=value`, so `#hide=stadium-netting` never turns on `#net` and `#diag=audit` is `#diag` in
 * audit mode. Nothing here persists: the flags hold for the page load they are in. Pure.
 *
 *   backend / tier   webgl2 (three's WebGL2 fallback), webgpu (super low on WebGPU, an A/B),
 *                    superlow (start on super low, never saved), tv (the 1 GB Android TV of
 *                    docs/visuals/REWORK.md "Super low", emulated: gpuDiag.ts installTvEmulation)
 *   emulation        lowgpu, compat, nof32filter, nofloatrt (WebGL2 without any renderable float
 *                    format: the production guard's test), nomsaa, msaa (gpuDiag.ts)
 *   diagnostics      diag (diag=audit: GL errors and program audits too), stats, debug, net,
 *                    nancheck, worldnocache, nopost (the post tiers draw straight to the canvas),
 *                    norender (everything but the drawing: the CPU ceiling), pr=<x> (pixel ratio),
 *                    hide=<mesh names, comma separated>
 *   layout           widetext (every UI family becomes plain Arial, about 1.5x the display face
 *                    and as wide as Android's Roboto: html.tg-widetext, src/style.css), so a label
 *                    that only fits in a condensed face shows up on a desktop
 *   input            keys (every key event's key, code and keyCode on screen, and the input and
 *                    history events: a real TV's BACK, CH+ / CH− and system keyboard; src/ui/keysOverlay.ts)
 *   car previews     car=<id>[,<id>...] (the offline roster's cars in roster order, owned or not:
 *                    the player's first, then the bots'; an empty entry keeps that slot's own car),
 *                    showroom[=<yaw>[,<pitch>[,<slot>]]] (the showroom camera at boot, menu hidden:
 *                    a fixed angle in degrees, or a slow orbit when bare, on roster entry <slot>,
 *                    the player by default). Read only where previews are allowed: a dev server or
 *                    a VITE_PREVIEW_CARS=1 build (src/game/carSelection.ts previewCarsAllowed).
 */

export interface HashFlags {
  readonly diag: boolean;
  /** `#diag=audit`: the panel also drains gl.getError() and audits every linked program. */
  readonly audit: boolean;
  readonly stats: boolean;
  readonly debug: boolean;
  readonly net: boolean;
  readonly nancheck: boolean;
  readonly worldnocache: boolean;
  readonly webgl2: boolean;
  readonly webgpu: boolean;
  readonly superlow: boolean;
  readonly tv: boolean;
  readonly lowgpu: boolean;
  readonly compat: boolean;
  readonly nof32filter: boolean;
  readonly nofloatrt: boolean;
  readonly nomsaa: boolean;
  readonly msaa: boolean;
  readonly nopost: boolean;
  readonly norender: boolean;
  /** `#widetext`: the UI in plain Arial (a fit test for the fallback fonts). */
  readonly widetext: boolean;
  /** `#keys`: the key events on screen (src/ui/keysOverlay.ts). */
  readonly keys: boolean;
  /** `#pr=<x>`: the drawing buffer's pixel ratio (0 = no override). */
  readonly pr: number;
  /** `#hide=a,b`: mesh names drawn invisible every frame. */
  readonly hide: readonly string[];
  /** `#car=<id>[,<id>...]`: the car ids to preview per roster entry (unchecked here; '' = that slot's own), [] without the flag. */
  readonly cars: readonly string[];
  /** `#showroom`: the showroom camera's angles and car, null without the flag. */
  readonly showroom: ShowroomView | null;
}

/** `#showroom=<yaw>[,<pitch>[,<slot>]]`, angles in degrees; null = not given (a bare `#showroom` orbits the player's car). */
export interface ShowroomView {
  readonly yawDeg: number | null;
  readonly pitchDeg: number | null;
  /** The roster entry framed (0 = the player offline; a 1v1's red bot is 1). */
  readonly slot: number | null;
}

/** The view of a `#showroom` value ('' when bare, null when absent); a non-number is not given. */
export function parseShowroom(value: string | null): ShowroomView | null {
  if (value === null) return null;
  const [yaw, pitch, slot] = value.split(',').map((s) => (s.trim().length > 0 ? Number(s) : Number.NaN));
  return {
    yawDeg: Number.isFinite(yaw) ? yaw : null,
    pitchDeg: pitch !== undefined && Number.isFinite(pitch) ? pitch : null,
    slot: slot !== undefined && Number.isInteger(slot) && slot >= 0 ? slot : null,
  };
}

/** The value of flag `name` in `hash`: '' for a bare flag, null when absent. */
export function hashValue(hash: string, name: string): string | null {
  const m = new RegExp(`(?:^|[#&])${name}(?:=([^&]*))?(?:&|$)`).exec(hash);
  if (m === null) return null;
  try {
    return decodeURIComponent(m[1] ?? '');
  } catch {
    return m[1] ?? '';
  }
}

/** Whether the bare or valued flag `name` is in `hash`. */
export function hasFlag(hash: string, name: string): boolean {
  return hashValue(hash, name) !== null;
}

export function parseHashFlags(hash: string): HashFlags {
  const has = (n: string): boolean => hasFlag(hash, n);
  const diag = hashValue(hash, 'diag');
  const pr = Number(hashValue(hash, 'pr') ?? '');
  const hide = hashValue(hash, 'hide');
  const car = hashValue(hash, 'car');
  return {
    diag: diag !== null,
    audit: diag === 'audit',
    stats: has('stats'),
    debug: has('debug'),
    net: has('net'),
    nancheck: has('nancheck'),
    worldnocache: has('worldnocache'),
    webgl2: has('webgl2'),
    webgpu: has('webgpu'),
    superlow: has('superlow'),
    tv: has('tv'),
    lowgpu: has('lowgpu'),
    compat: has('compat'),
    nof32filter: has('nof32filter'),
    nofloatrt: has('nofloatrt'),
    nomsaa: has('nomsaa'),
    msaa: has('msaa'),
    nopost: has('nopost'),
    norender: has('norender'),
    widetext: has('widetext'),
    keys: has('keys'),
    pr: Number.isFinite(pr) && pr > 0 ? Math.min(4, Math.max(0.1, pr)) : 0,
    hide: hide !== null ? hide.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : [],
    cars: car !== null && car.length > 0 ? car.split(',').map((s) => s.trim()) : [],
    showroom: parseShowroom(hashValue(hash, 'showroom')),
  };
}

/**
 * The page emulates another device (#tv, #lowgpu, #nofloatrt, #compat, #nof32filter): what it
 * learns about that device is not written where this browser's real GPU reads it back
 * (tierGuard.ts writeCeiling's super low boot record). Pure.
 */
export function emulatedDevice(f: Pick<HashFlags, 'tv' | 'lowgpu' | 'nofloatrt' | 'compat' | 'nof32filter'>): boolean {
  return f.tv || f.lowgpu || f.nofloatrt || f.compat || f.nof32filter;
}

/** `hash` without the tier flags a player's own choice replaces (`#superlow`); '' or '#...' (Game.switchQuality). */
export function withoutTierFlags(hash: string): string {
  const parts = hash.replace(/^#/, '').split('&').filter((p) => p.length > 0 && p.split('=')[0] !== 'superlow');
  return parts.length > 0 ? `#${parts.join('&')}` : '';
}

/** The flags of this page load (empty outside a browser). */
let current: HashFlags | null = null;
export function pageFlags(): HashFlags {
  if (current === null) current = parseHashFlags(typeof location !== 'undefined' ? location.hash : '');
  return current;
}

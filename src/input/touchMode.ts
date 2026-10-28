/**
 * Touch mode decisions for the on-screen controls (src/input/TouchControls.ts): which press turns
 * `tg-touch` on or off. The last input used wins: a finger or a pen turns it on; a mouse, a key the
 * game uses or a gamepad button (counted by Input.gamepadPresses) turns it off. Also the phone
 * platform decisions: the automatic fullscreen (Android) and the one-time add-to-home-screen hint
 * (iPhone). Pure (no DOM, no CSS) so node tests drive it; TouchControls reads the browser.
 */
import { ACTION_IDS, type BindingProfile } from './bindings';

/**
 * Fixed menu keys (Input's menu navigation, src/ui/Menu.ts, the Hud's menus): a press turns touch
 * mode off. Q / E (tabs, sections), X (cancel the search) and Delete (the context action) are the
 * menus' shortcuts (Menu.onKey).
 */
export const MENU_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'NumpadEnter',
  'Escape',
  'Backspace',
  'Tab',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'KeyX',
  'Delete',
]);

/** Keys that never mean the keyboard is in use: phone volume / media keys, launcher and browser keys. */
const IGNORED_KEYS = /^(Media|Audio|Launch|Browser)/;

/**
 * A keydown of `code` (KeyboardEvent.code) means the keyboard is in use, so touch mode goes off: a
 * fixed menu key or a key bound in the keyboard + mouse profile `kbm`. Never a key typed into a
 * text field (`inTextField`), a virtual keyboard's code '' or a volume / media / launcher /
 * browser key.
 */
export function keyLeavesTouchMode(code: unknown, inTextField: boolean, kbm: Readonly<BindingProfile>): boolean {
  if (typeof code !== 'string' || code === '' || inTextField || IGNORED_KEYS.test(code)) return false;
  if (MENU_KEYS.has(code)) return true;
  for (let i = 0; i < ACTION_IDS.length; i++) {
    const b = kbm[ACTION_IDS[i]];
    if (b && b.kind === 'key' && b.code === code) return true;
  }
  return false;
}

/** Touch mode after a press of a `pointerType` pointer: on for a finger or a pen, off for a mouse, null (unchanged) otherwise. */
export function pointerTouchMode(pointerType: string): boolean | null {
  if (pointerType === 'mouse') return false;
  if (pointerType === 'touch' || pointerType === 'pen') return true;
  return null;
}

/** What the phone platform decisions read (TouchControls.platformEnv() fills it from the browser). */
export interface PlatformEnv {
  /** (pointer: coarse) matches: the primary pointer is a finger (phones, tablets; not touch laptops). */
  coarse: boolean;
  /** typeof screen.orientation.lock === 'function': Android browsers and desktop Chrome, not Safari (iPhone, iPad). */
  orientationLock: boolean;
  /** Element fullscreen exists: document.fullscreenEnabled and Element.requestFullscreen (not on an iPhone). */
  elementFullscreen: boolean;
  /** Something is fullscreen already (document.fullscreenElement). */
  fullscreen: boolean;
  /** Launched from the home screen: (display-mode: standalone) or iOS's navigator.standalone. */
  standalone: boolean;
}

/**
 * A finger tap goes fullscreen and locks landscape: only on a phone or tablet whose browser locks
 * the orientation (Android). Never on a desktop or a touch laptop / Chromebook (a fine primary
 * pointer) nor on an iPad (no orientation lock); nor when it is fullscreen already or cannot be.
 */
export function shouldAutoFullscreen(env: Readonly<PlatformEnv>): boolean {
  return env.coarse && env.orientationLock && env.elementFullscreen && !env.fullscreen;
}

/**
 * The one-time "Share › Add to Home Screen" hint (iPhone): a finger device whose browser has no
 * element fullscreen, in a browser tab (not launched from the home screen), never `shown` before.
 * Safari only (no orientation lock): an Android WebView or iframe without fullscreen would get
 * iPhone instructions. An iPad before Safari 16.4 (prefixed fullscreen only) gets it too: its
 * Share menu has the same item.
 */
export function shouldShowInstallHint(env: Readonly<PlatformEnv>, shown: boolean): boolean {
  return env.coarse && !env.orientationLock && !env.elementFullscreen && !env.standalone && !shown;
}

/**
 * Touch mode decisions for the on-screen controls (src/input/TouchControls.ts): which press turns
 * `tg-touch` on or off. The last input used wins: a finger or a pen turns it on; a mouse, a key the
 * game uses or a gamepad button (counted by Input.gamepadPresses) turns it off. Pure (no DOM, no
 * CSS) so node tests drive it.
 */
import { ACTION_IDS, type BindingProfile } from './bindings';

/** Fixed menu keys (Input's menu navigation, src/ui/Menu.ts, the Hud's menus): a press turns touch mode off. */
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

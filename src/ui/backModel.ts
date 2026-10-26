/**
 * The order of Back (plan §1.5), pure so it is tested apart (tests/back-model.test.mjs). Back is
 * the menus' ‹, Esc, Backspace, pad B, and the system Back that src/ui/backGuard.ts turns into one
 * step inside the game (Android's gesture, a TV remote's BACK, the browser's back, GoBack /
 * BrowserBack keys). PR 0's guard keeps its one sentinel history entry: sections are no history
 * entries of their own (as a replaceState on the root entry would be), so Back from ENTRENAMIENTO
 * comes to JUGAR and never walks out of the site; only JUGAR's root asks to leave.
 *
 * In the game (systemBack, Game.onSystemBack): nothing while a load runs; a key capture is
 * cancelled; the Hud's screen (pause, settings) takes it; else the menus (menuBack); else a pack
 * summary goes to the menu; else a match being played pauses (a paused one stays paused: Esc / B /
 * RESUME resume it, only QUIT leaves).
 *
 * In the menus (menuBack, Menu.back):
 *   1. a sheet is up: it closes (a blocking one stays: Back does nothing);
 *   2. a text field is being edited: editing stops (touch skips this: Android's first Back
 *      already hid the keyboard);
 *   3. the screen on top has its own back (a lobby asks before leaving): it takes it;
 *   4. a stacked screen: it pops, with its focus remembered;
 *   5. a section other than JUGAR: back to JUGAR;
 *   6. JUGAR's root: "Leave Turbogol?" with KEEP PLAYING focused.
 */
import type { SectionId } from './shell/sections';
import { HOME_SECTION } from './shell/sections';

export type SheetKind = 'none' | 'dismissable' | 'blocking';

export interface MenuBackState {
  readonly sheet: SheetKind;
  /** A text field of the menus is in editing mode. */
  readonly editing: boolean;
  /** The last input was a finger (touch mode). */
  readonly touch: boolean;
  /** The screen on top has a back() of its own that has not declined this one. */
  readonly screenBack: boolean;
  /** Screens in the section's stack (1: its root). */
  readonly depth: number;
  readonly section: SectionId;
}

export type MenuBackStep = 'closeSheet' | 'blocked' | 'stopEditing' | 'screen' | 'pop' | 'home' | 'leave';

export function menuBack(s: MenuBackState): MenuBackStep {
  if (s.sheet === 'dismissable') return 'closeSheet';
  if (s.sheet === 'blocking') return 'blocked';
  if (s.editing && !s.touch) return 'stopEditing';
  if (s.screenBack) return 'screen';
  if (s.depth > 1) return 'pop';
  if (s.section !== HOME_SECTION) return 'home';
  return 'leave';
}

export interface SystemBackState {
  /** The loading screen is up (a load or a reload behind it). */
  readonly loading: boolean;
  /** A key / button capture of Settings is waiting for a press. */
  readonly capturing: boolean;
  /** The Hud's own screen is up: the pause menu or the settings screen. */
  readonly hudMenu: boolean;
  /** The front-end menus are up. */
  readonly menus: boolean;
  /** A training pack's summary is up. */
  readonly summary: boolean;
  /** A match (or free play) is being played, not paused. */
  readonly playing: boolean;
}

export type SystemBackStep = 'none' | 'cancelCapture' | 'hud' | 'menus' | 'leaveSummary' | 'pause';

export function systemBack(s: SystemBackState): SystemBackStep {
  if (s.loading) return 'none';
  if (s.capturing) return 'cancelCapture';
  if (s.hudMenu) return 'hud';
  if (s.menus) return 'menus';
  if (s.summary) return 'leaveSummary';
  if (s.playing) return 'pause';
  return 'none';
}

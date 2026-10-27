/**
 * "How will you play?" (plan PR 5): asked once, at a new PC player's first press of a control that
 * starts a match (Menu.beforeMatch), never at boot. The answer is stored (`turbogol.howPlay.v1`)
 * and sets the controls: mouse and keyboard keeps the default layout, keyboard only applies its
 * preset (Settings › Controls has the same), a controller changes nothing. Never asked on a TV, a
 * phone or a tablet, in touch mode, of a returning player (the controls card already seen, or
 * bindings of their own: never overwritten) or for a controller's press, which answers by itself.
 * Pure, plus two storage helpers: node tests import it.
 */
import type { InputKind } from './device';
import { STORAGE_PREFIX } from '../brand';

export type ControlScheme = 'kbm' | 'keyboard' | 'pad';

export const HOW_PLAY_KEY = STORAGE_PREFIX + 'howPlay.v1';

const isScheme = (v: unknown): v is ControlScheme => v === 'kbm' || v === 'keyboard' || v === 'pad';

/** The stored answer, null when none (or storage is blocked). */
export function readHowPlay(): ControlScheme | null {
  try {
    const v = localStorage.getItem(HOW_PLAY_KEY);
    return isScheme(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeHowPlay(s: ControlScheme): void {
  try {
    localStorage.setItem(HOW_PLAY_KEY, s);
  } catch {
    /* storage blocked: asked again next page load */
  }
}

/** What decides the question at a match-starting press. */
export interface HowPlayContext {
  /** html.tg-tv (the TV asks for a controller instead: Menu.openNeedPad). */
  readonly tv: boolean;
  /** device.ts layoutClass: only 'pc' and 'short' ask. */
  readonly layout: string;
  /** Touch mode (tg-touch). */
  readonly touch: boolean;
  /** The input that pressed (a pad's A: 'pad', whatever data-input still says). */
  readonly input: InputKind;
  /** An answer is stored already. */
  readonly answered: boolean;
  /** The controls card was seen, or the keyboard + mouse bindings are the player's own. */
  readonly returning: boolean;
}

/** 'pad': the press answered it (store 'pad' and play); 'ask'; 'no' (play). Pure. */
export function howPlayAsk(i: HowPlayContext): 'no' | 'ask' | 'pad' {
  if (i.tv || (i.layout !== 'pc' && i.layout !== 'short') || i.touch || i.answered || i.returning) return 'no';
  return i.input === 'pad' ? 'pad' : 'ask';
}

/**
 * The hint bar's content (plan §1.6): the verbs of a section root or a stacked screen in the
 * language of the LAST input only (src/ui/device.ts lastInput), never another device's keys:
 *   pad       A Select · B Back · LB RB Sections (+ LT RT Tabs on a root with tabs of its own:
 *             GARAJE names them "Cars or stadiums"), or LB RB Modes on a stacked screen with tabs of
 *             its own (MODOS: they step those there, plan §1.5) · ≡ Settings (+ Y Cancel search); a crowded bar
 *             (a TV's, with its pills) drops ≡ Settings first (`give` 1: the gear is in the top
 *             bar), the cancel hint last (`give` 4: the search pill's ✕ is beside it)
 *   remote    OK Select · ↩ Back · ▲ Sections (not on a stacked screen: ▲ lands on ‹ there, the
 *             section bar steps aside)
 *   keyboard  ENTER Select · ESC Back · Q E Sections, or Q E Tabs on a screen with tabs of its own
 *             (Q / E step those there: Menu.tabOrSection, plan §1.5; MODOS names them "Modes")
 *             (+ X Cancel search, `give` 4)
 *   mouse     nothing (the bar keeps its links)
 *   touch     nothing (no bar on a phone; the cards teach)
 * Key and button names are glyphs (components/glyphs.ts), never translated; the verbs are i18n
 * keys. Pure, no DOM: tests/device-hints.test.mjs.
 */
import type { InputKind } from '../device';
import type { Key } from '../../i18n';

/** A drawn key or button: `pad-*` a controller's, `key-*` a keyboard's, `remote-*` a TV remote's. */
export type GlyphId = 'pad-a' | 'pad-b' | 'pad-x' | 'pad-y' | 'pad-lb' | 'pad-rb' | 'pad-lt' | 'pad-rt' | 'pad-start' | 'key-enter' | 'key-esc' | 'key-q' | 'key-e' | 'key-x' | 'key-pgup' | 'key-pgdn' | 'remote-ok' | 'remote-back' | 'remote-up';

export interface HintItem {
  readonly glyphs: readonly GlyphId[];
  readonly verb: Key;
  /**
   * The level it gives way at in a crowded bar (fit.ts data-fit-give; the pills' words are 2 and 3):
   * 1 for the controller's Settings (the top bar's gear says it), 4 for cancelling the search (the
   * search pill's ✕ beside it).
   */
  readonly give?: number;
}

export interface HintContext {
  /** A search is running (its cancel shortcut joins the bar). */
  readonly searching: boolean;
  /** A screen stacked on its section's root (‹ and the crumbs instead of the section bar). */
  readonly stacked?: boolean;
  /** The screen on top has tabs of its own (Leaderboard's playlists, Profile's sign-in forms, MODOS' modes). */
  readonly ownTabs?: boolean;
  /** What those tabs are (Screen.tabsVerb: MODOS' "Modes"); "Tabs" without. */
  readonly tabsVerb?: Key;
}

/** The device a glyph belongs to. */
export function glyphDevice(g: GlyphId): 'pad' | 'keyboard' | 'remote' {
  return g.startsWith('pad-') ? 'pad' : g.startsWith('key-') ? 'keyboard' : 'remote';
}

export function hintItems(input: InputKind, ctx: HintContext): HintItem[] {
  switch (input) {
    case 'pad': {
      const out: HintItem[] = [
        { glyphs: ['pad-a'], verb: 'nav.select' },
        { glyphs: ['pad-b'], verb: 'nav.back' },
        // A stacked screen's own tabs take LB / RB (the section bar is not there: Menu.command).
        { glyphs: ['pad-lb', 'pad-rb'], verb: ctx.stacked === true && ctx.ownTabs === true ? (ctx.tabsVerb ?? 'nav.tabs') : 'nav.sections' },
        { glyphs: ['pad-start'], verb: 'nav.settings', give: 1 },
      ];
      // A root's own tabs (GARAJE, CLASIFICACIÓN, PERFIL's forms) step with LT / RT (plan §1.5).
      if (ctx.stacked !== true && ctx.ownTabs === true) out.splice(3, 0, { glyphs: ['pad-lt', 'pad-rt'], verb: ctx.tabsVerb ?? 'nav.tabs', give: 2 });
      if (ctx.searching) out.push({ glyphs: ['pad-y'], verb: 'nav.cancelSearch', give: 4 });
      return out;
    }
    case 'keyboard': {
      const out: HintItem[] = [
        { glyphs: ['key-enter'], verb: 'nav.select' },
        { glyphs: ['key-esc'], verb: 'nav.back' },
        { glyphs: ['key-q', 'key-e'], verb: ctx.ownTabs === true ? (ctx.tabsVerb ?? 'nav.tabs') : 'nav.sections' },
      ];
      if (ctx.searching) out.push({ glyphs: ['key-x'], verb: 'nav.cancelSearch', give: 4 });
      return out;
    }
    case 'remote': {
      const out: HintItem[] = [
        { glyphs: ['remote-ok'], verb: 'nav.select' },
        { glyphs: ['remote-back'], verb: 'nav.backRemote' },
      ];
      if (ctx.stacked !== true) out.push({ glyphs: ['remote-up'], verb: 'nav.sections' });
      return out;
    }
    default:
      return [];
  }
}

/**
 * The hint bar's content (plan §1.6): the verbs of a section root or a stacked screen in the
 * language of the LAST input only (src/ui/device.ts lastInput), never another device's keys:
 *   pad       A Select · B Back · LB RB Sections · ≡ Settings (+ Y Cancel search)
 *   remote    OK Select · ↩ Back · ▲ Sections
 *   keyboard  ENTER Select · ESC Back · Q E Sections (+ X Cancel search)
 *   mouse     nothing (the bar keeps its links)
 *   touch     nothing (no bar on a phone; the cards teach)
 * Key and button names are glyphs (components/glyphs.ts), never translated; the verbs are i18n
 * keys. Pure, no DOM: tests/device-hints.test.mjs.
 */
import type { InputKind } from '../device';
import type { Key } from '../../i18n';

/** A drawn key or button: `pad-*` a controller's, `key-*` a keyboard's, `remote-*` a TV remote's. */
export type GlyphId = 'pad-a' | 'pad-b' | 'pad-y' | 'pad-lb' | 'pad-rb' | 'pad-start' | 'key-enter' | 'key-esc' | 'key-q' | 'key-e' | 'key-x' | 'remote-ok' | 'remote-back' | 'remote-up';

export interface HintItem {
  readonly glyphs: readonly GlyphId[];
  readonly verb: Key;
}

export interface HintContext {
  /** A search is running (its cancel shortcut joins the bar). */
  readonly searching: boolean;
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
        { glyphs: ['pad-lb', 'pad-rb'], verb: 'nav.sections' },
        { glyphs: ['pad-start'], verb: 'nav.settings' },
      ];
      if (ctx.searching) out.push({ glyphs: ['pad-y'], verb: 'nav.cancelSearch' });
      return out;
    }
    case 'keyboard': {
      const out: HintItem[] = [
        { glyphs: ['key-enter'], verb: 'nav.select' },
        { glyphs: ['key-esc'], verb: 'nav.back' },
        { glyphs: ['key-q', 'key-e'], verb: 'nav.sections' },
      ];
      if (ctx.searching) out.push({ glyphs: ['key-x'], verb: 'nav.cancelSearch' });
      return out;
    }
    case 'remote':
      return [
        { glyphs: ['remote-ok'], verb: 'nav.select' },
        { glyphs: ['remote-back'], verb: 'nav.backRemote' },
        { glyphs: ['remote-up'], verb: 'nav.sections' },
      ];
    default:
      return [];
  }
}

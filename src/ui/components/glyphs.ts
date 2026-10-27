/**
 * Drawn keys and buttons for the hint bar and the section bar (plan §1.6), never a maker's colours
 * or symbols: a controller's face button is a circle with a 4-dot diamond, its position filled, and
 * the standard mapping's letter; a bumper an L / R pill skewed -20°; Start a ≡ box; a keyboard key a
 * keycap; a TV remote's OK, Back (↩) and ▲ round buttons. Decorative (aria-hidden): the verb next to
 * them says what they do. Built on call, nothing at import.
 */
import { h } from '../dom';
import type { GlyphId } from '../shell/hints';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The diamond's dots (top, right, bottom, left) on a 12 grid; `on` is filled. */
function diamond(on: 0 | 1 | 2 | 3): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const at: Array<[number, number]> = [
    [6, 2],
    [10, 6],
    [6, 10],
    [2, 6],
  ];
  at.forEach(([x, y], i) => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', String(x));
    c.setAttribute('cy', String(y));
    c.setAttribute('r', '1.6');
    c.setAttribute('class', i === on ? 'mn-glyph-dot-on' : 'mn-glyph-dot');
    svg.appendChild(c);
  });
  return svg;
}

/** A face button: [diamond] + letter (A bottom, B right, X left, Y top). */
function face(letter: string, pos: 0 | 1 | 2 | 3): HTMLElement {
  return h('span.mn-glyph-pair', null, h('span.mn-glyph.mn-glyph-face', null, diamond(pos)), h('b.mn-glyph-letter', null, letter));
}

const key = (text: string): HTMLElement => h('kbd.mn-key', null, text);
const round = (text: string): HTMLElement => h('span.mn-glyph.mn-glyph-round', null, text);
const bumper = (text: string): HTMLElement => h('span.mn-glyph.mn-glyph-bumper', null, h('span', null, text));

export function glyph(id: GlyphId): HTMLElement {
  switch (id) {
    case 'pad-a':
      return face('A', 2);
    case 'pad-b':
      return face('B', 1);
    case 'pad-y':
      return face('Y', 0);
    case 'pad-lb':
      return bumper('L');
    case 'pad-rb':
      return bumper('R');
    case 'pad-start':
      return h('span.mn-glyph.mn-glyph-start', null, '≡');
    case 'key-enter':
      return key('ENTER');
    case 'key-esc':
      return key('ESC');
    case 'key-q':
      return key('Q');
    case 'key-e':
      return key('E');
    case 'key-x':
      return key('X');
    case 'remote-ok':
      return round('OK');
    case 'remote-back':
      return round('↩');
    default:
      return round('▲');
  }
}

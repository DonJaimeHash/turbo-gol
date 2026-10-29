/**
 * The cars as side-view outlines (plan §1.4.2: GARAJE's rows and the redeem sheet), one original
 * drawing per body, the nose to the right, on a 72 x 36 grid: the body's line, a detail that tells
 * it apart (the Dune's roll hoop, the Pampero's wing, the Carpincho's roof rack, the Cóndor's
 * T-tail, the Tero's roof wing) and the two wheels on the ground (y 32). Strokes take the colour of
 * the text (`currentColor`: a locked car's row draws it in --edge-hi), the wheels are filled with
 * the well's ink (styles/screens/garage.css). Every car simulates as the same Standard car: these
 * are looks only. Built on call, nothing at import (tests/garage-screen.test.mjs reads the data).
 */
import type { CarId } from '../../game/cosmetics';

export interface Silhouette {
  /** The body's outline. */
  readonly body: string;
  /** Its telling detail (open strokes). */
  readonly detail: string;
  /** The rear and the front wheel: centre x, radius (centres sit on y = 32 - r). */
  readonly wheels: readonly [readonly [number, number], readonly [number, number]];
}

export const SILHOUETTES: Readonly<Record<CarId, Silhouette>> = {
  // A low pod under a bubble canopy, the roll hoop over it, pontoon arches on big knobby tyres.
  dune: { body: 'M4 25L7 19L18 16Q24 8 35 8Q46 8 51 15L62 17L67 21V25Z', detail: 'M28 10L31 4H43L46 10M60 17V14H65', wheels: [[17, 7], [55, 7]] },
  // An arrowhead wedge: the long nose low to the right, a low canopy, the wing on swan necks.
  pampero: { body: 'M3 26V20L14 19L28 13H40L54 19L70 23V26Z', detail: 'M8 19L6 13M2 13H13', wheels: [[15, 6], [58, 5]] },
  // A barrel body under a high cab whose roof rolls into the rump, the roof rack, a square muzzle.
  carpincho: { body: 'M5 26Q4 15 16 14L23 7H47Q52 7 55 13H64Q67 14 67 26Z', detail: 'M25 4H45M29 4V7M41 4V7M50 9V3', wheels: [[18, 6.5], [54, 6.5]] },
  // A long fuselage to a hooked beak, the cab-forward canopy, the dorsal fin with its T-tail.
  condor: { body: 'M3 25L5 20L24 18L36 12H46L52 17L66 19L71 23L68 26H3Z', detail: 'M12 18L8 7M4 7H13', wheels: [[15, 5.5], [57, 5.5]] },
  // A short two-box hatch, the tall glasshouse, box flares, the wing on the roof's tail.
  tero: { body: 'M6 26V17L15 15L21 8H45L53 15L64 17L66 26Z', detail: 'M19 8L17 4H29M33 8V15M60 21H66', wheels: [[18, 6], [54, 6]] },
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function node<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Car `id`'s outline as an <svg> (aria-hidden: its row names the car). */
export function carSilhouette(id: CarId, cls = 'mn-car-sil'): SVGSVGElement {
  const s = SILHOUETTES[id];
  const svg = node('svg', { class: cls, viewBox: '0 0 72 36', 'aria-hidden': 'true', focusable: 'false' });
  svg.append(node('path', { class: 'mn-car-sil-body', d: s.body }), node('path', { class: 'mn-car-sil-line', d: s.detail }));
  for (const [x, r] of s.wheels) svg.append(node('circle', { class: 'mn-car-sil-wheel', cx: x, cy: 32 - r, r }), node('circle', { class: 'mn-car-sil-hub', cx: x, cy: 32 - r, r: Math.round(r * 0.36 * 10) / 10 }));
  return svg;
}

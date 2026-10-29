/**
 * The UI's own icons: one inline SVG sprite (no image file, no icon font, no emoji). Every icon is
 * drawn here on a 24 x 24 grid with 2-unit round strokes; `icon()` sets the stroke on the
 * referencing <svg> (fill none, stroke currentColor), so an icon takes the colour of its text and
 * the sprite stays small (tests/icons.test.mjs: <= 6 KB). A dot is a zero-length segment
 * (`h.01`) under a round cap.
 *
 * The sprite is a hidden <svg> of <symbol id="tg-i-NAME"> mounted once, on the first `icon()`
 * call; nothing here touches the DOM at import, so node tests can import the screens that use it.
 */

export const ICON_PATHS = {
  play: 'M2 8.5h4.5M1 12h5.5M2 15.5h4.5M10 5.2l11 6.8-11 6.8z',
  training: 'M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6',
  garage: 'M4 16v-3l2-5h12l2 5v3zM4 13h16M7 16v2M17 16v2',
  leaderboard: 'M4 20v-8h5v8M9 20V6h6v14M15 20v-6h5v6M3 20h18',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 1 0 0 8M4 21a8 8 0 0 1 16 0',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 1 0 0 6M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1',
  back: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
  arrow: 'M5 12h13M13 6l6 6-6 6',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  lock: 'M6 11h12v10H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  // Server points (GARAJE, the bar's pill): three slanted bars, the owner's drawing.
  points: 'M6.5 3.5h15l-1.6 4.5h-15zM4.9 9.75h15l-1.6 4.5h-15zM3.3 16h15l-1.6 4.5h-15z',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13M15.5 15.5 20 20',
  friends: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 1 0 0 7M2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.5a6.5 6.5 0 0 1 3.5 5.5',
  bot: 'M5 8h14v11H5zM12 4v4M9 13h.01M15 13h.01M9.5 16.5h5M2 12v3M22 12v3',
  trophy: 'M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3M12 14v4M8 21h8',
  rank: 'M12 3l8 3v6c0 4.6-3.4 8-8 9-4.6-1-8-4.4-8-9V6zM8.5 13.2l3.5-3 3.5 3',
  ball: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18M12 8l3.8 2.8-1.5 4.4H9.7l-1.5-4.4zM12 3v5M15.8 10.8l4.6-1.5M14.3 15.2l2.8 4M9.7 15.2l-2.8 4M8.2 10.8 3.6 9.3',
  stadium: 'M3 9c0-2 4-4 9-4s9 2 9 4v6c0 2-4 4-9 4s-9-2-9-4zM3 9c0 2 4 4 9 4s9-2 9-4',
  pad: 'M7 8h10a4 4 0 0 1 4 4v1a3 3 0 0 1-5.4 1.8L14.5 14h-5l-1.1 1.8A3 3 0 0 1 3 13v-1a4 4 0 0 1 4-4M7 10.5v3M5.5 12h3M16 11h.01M18 13h.01',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  mouse: 'M12 3a6 6 0 0 0-6 6v6a6 6 0 0 0 12 0V9a6 6 0 0 0-6-6M12 7v3',
  touch: 'M9 12V5a1.5 1.5 0 0 1 3 0v6m0-1a1.5 1.5 0 0 1 3 0v2m0-1a1.5 1.5 0 0 1 3 0v4a6 6 0 0 1-6 6h-1a5 5 0 0 1-4.2-2.3L4 14.5a1.5 1.5 0 0 1 2.4-1.8L9 15',
  tv: 'M3 5h18v12H3zM8 21h8M12 17v4',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 10.5a3 3 0 1 0 0 6 3 3 0 1 0 0-6',
  audio: 'M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  graphics: 'M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M11 16v4',
  lab: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3M7.5 15h9',
  share: 'M12 15V3M8 7l4-4 4 4M5 12v7h14v-7',
  copy: 'M9 9h11v11H9zM15 9V4H4v11h5',
  refresh: 'M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4',
  exit: 'M10 4H5v16h5M14 8l4 4-4 4M18 12H9',
  pause: 'M8 5v14M16 5v14',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16',
  warning: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  offline: 'M2 8.8a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M3 3l18 18',
  boost: 'M13 2 4 14h7l-1 8 9-12h-7z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18M12 11v6M12 7.5h.01',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];

/** The sprite's own id and each symbol's (`tg-i-` + name). */
export const SPRITE_ID = 'tg-icons';
export const iconId = (name: IconName): string => `tg-i-${name}`;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The sprite's markup (pure): a hidden <svg> with one <symbol> per icon. */
export function spriteMarkup(): string {
  let s = `<svg xmlns="${SVG_NS}" id="${SPRITE_ID}" width="0" height="0" style="position:absolute" aria-hidden="true">`;
  for (const name of ICON_NAMES) s += `<symbol id="${iconId(name)}" viewBox="0 0 24 24"><path d="${ICON_PATHS[name]}"/></symbol>`;
  return s + '</svg>';
}

/** Puts the sprite in the page once (later calls find it). */
export function mountIconSprite(doc: Document = document): void {
  if (doc.getElementById(SPRITE_ID) !== null) return;
  const host = doc.createElement('div');
  host.innerHTML = spriteMarkup();
  const svg = host.firstElementChild;
  if (svg !== null) doc.body.appendChild(svg);
}

/**
 * An icon: <svg class="mn-icon [cls]" aria-hidden="true"><use href="#tg-i-NAME"/></svg>, stroked in
 * the current text colour. Decorative: the label next to it says what it is.
 */
export function icon(name: IconName, cls?: string): SVGSVGElement {
  mountIconSprite();
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls ? `mn-icon ${cls}` : 'mn-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${iconId(name)}`);
  svg.appendChild(use);
  return svg;
}

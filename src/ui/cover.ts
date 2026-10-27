/**
 * How much of the screen the menus hide from the 3D scene behind them (the Game's "UI at rest",
 * src/render/quality.ts sceneFps: a phone's menus that hide more than MENU_COVER_LITE of it draw
 * the scene at 20 fps instead of 30). Menu.ts measures it on touch screens when a screen mounts,
 * a modal closes or the viewport changes, and reports it with the cover (MenuHost.setMenuCover).
 *
 * A grid of points over the viewport: a point is covered when the element on top of it, or one of
 * its ancestors inside the menus' root (the root's own backdrop excluded), paints a background of
 * at least half opacity: the bars, the tiles, the panels. Text, gaps and the stage itself let the
 * scene through. A point whose top element lies outside the root (another layer: the settings
 * screen, the loading screen, the anti-bot widget) says nothing and is left out; with most of them
 * out the share is unknown (NaN) and the last one stands. Pure with the two lookups passed in (no
 * DOM at module level: node tests import it).
 */

/** The grid: COLS x ROWS points at the centres of equal cells. */
const COLS = 9;
const ROWS = 5;
/** A background at least this opaque hides the scene. */
const OPAQUE_ALPHA = 0.5;

/** The parts of a computed style the test reads. */
export interface BackgroundStyle {
  readonly backgroundColor: string;
  readonly backgroundImage: string;
}

/** The alpha of a computed colour: 'rgba(r, g, b, a)', or the part after '/' ('color(srgb r g b / a)', a % too); 1 otherwise. */
function alphaOf(c: string): number {
  let a: string | undefined;
  if (c.startsWith('rgba(') && !c.includes('/')) a = c.slice(5, -1).split(',')[3];
  else if (c.includes('/')) a = c.slice(c.lastIndexOf('/') + 1).replace(')', '');
  if (a === undefined) return 1;
  const v = Number.parseFloat(a);
  if (Number.isNaN(v)) return 1;
  return a.trim().endsWith('%') ? v / 100 : v;
}

/**
 * Whether a computed style paints over the scene: a background image (the gradients of the bars
 * and the hero tile) or a colour with alpha >= OPAQUE_ALPHA. Pure.
 */
export function paintsBackground(s: BackgroundStyle): boolean {
  if (s.backgroundImage !== '' && s.backgroundImage !== 'none') return true;
  const c = s.backgroundColor.trim();
  if (c === '' || c === 'transparent') return false;
  return alphaOf(c) >= OPAQUE_ALPHA;
}

/**
 * The share (0..1) of a `w` x `h` viewport that `root`'s descendants hide, NaN when another layer
 * is on top of most of it: `at(x, y)` is the top element there (document.elementFromPoint),
 * `paints(el)` its background test (paintsBackground of its computed style). Pure.
 */
export function coverShare(root: Element, w: number, h: number, at: (x: number, y: number) => Element | null, paints: (el: Element) => boolean): number {
  if (!(w > 0) || !(h > 0)) return Number.NaN;
  let inside = 0;
  let covered = 0;
  for (let iy = 0; iy < ROWS; iy++) {
    for (let ix = 0; ix < COLS; ix++) {
      let el = at(((ix + 0.5) / COLS) * w, ((iy + 0.5) / ROWS) * h);
      if (el === null || !root.contains(el)) continue;
      inside++;
      for (; el !== null && el !== root; el = el.parentElement) {
        if (paints(el)) {
          covered++;
          break;
        }
      }
    }
  }
  return inside * 2 > COLS * ROWS ? covered / inside : Number.NaN;
}

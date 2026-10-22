/**
 * The canvas atlas of the LED boards (no image or font files: the text uses the system sans-serif,
 * every emblem is a canvas path from emblems.ts). What it shows is a place's content set
 * (content.ts): both harbour themes share the harbour's, every other theme has its own.
 *
 *   boardAtlas()   -> a BOARD_COLS x BOARD_ROWS cell canvas texture (cells at the card aspect);
 *                     paintBoards() draws a set's BOARD_CARDS sponsor cards into cells 0..19 and
 *                     its main and secondary sponsors, in the wider layout of the big side-wall
 *                     board, into cells BIG_CELL0 + k * BIG_PANELS + j (k 0 main, 1 secondary;
 *                     j the board's panel 0..2: the big card cut in three, one third per cell)
 *
 * StadiumView paints it when it is built and repaints it when a theme switch changes the place:
 * into the same canvas and texture (same size, `needsUpdate`), so the material keeps its binding
 * and never recompiles, and nothing is allocated per frame. drawBoards() takes any 2D context (the
 * tests record one in node).
 *
 * Every name is invented for Turbogol; none is a real brand, and nothing copies a real logo.
 */
import * as THREE from 'three/webgpu';
import type { BoardCard, ContentSet } from './content';
import { EMBLEMS, type Ctx } from './emblems';
import { BIG_PANELS, CARD_ASPECT } from './layout';

export const BOARD_COLS = 2;
/** The regular cards of a set (cells 0 .. BOARD_CARDS - 1). */
export const BOARD_CARDS = 20;
/** The first cell of the big board's sponsors (2 sponsors x BIG_PANELS thirds). */
export const BIG_CELL0 = BOARD_CARDS;
export const BOARD_ROWS = Math.ceil((BOARD_CARDS + 2 * BIG_PANELS) / BOARD_COLS);

const FONT = 'system-ui, "Segoe UI", Roboto, Arial, sans-serif';

function fitText(ctx: Ctx, text: string, maxW: number, size: number, weight: number, italic: boolean): number {
  let s = size;
  for (;;) {
    ctx.font = `${italic ? 'italic ' : ''}${weight} ${s}px ${FONT}`;
    if (ctx.measureText(text).width <= maxW || s < 10) return s;
    s -= 2;
  }
}

/** The colour a 2-stop gradient of '#rrggbb' colours shows at t (canvas gradients mix in sRGB). */
function mixHex(a: string, b: string, t: number): string {
  const ch = (c: string, i: number): number => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  const m = (i: number): number => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t);
  return `rgb(${m(0)},${m(1)},${m(2)})`;
}

/** Start a paint from a clean context state and an empty canvas. */
function reset(ctx: Ctx, w: number, h: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.clearRect(0, 0, w, h);
}

function drawCard(ctx: Ctx, card: BoardCard, x: number, y: number, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, card.bg[0]);
  g.addColorStop(1, card.bg[1]);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  // A thin accent bar at the bottom and a faint diagonal sheen: board graphics, not a flat fill.
  ctx.fillStyle = card.ac;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(x, y + h - h * 0.07, w, h * 0.07);
  ctx.globalAlpha = 0.07;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.55, y);
  ctx.lineTo(x + w * 0.75, y);
  ctx.lineTo(x + w * 0.62, y + h);
  ctx.lineTo(x + w * 0.42, y + h);
  ctx.fill();
  ctx.globalAlpha = 1;

  // The emblem cuts its details out in the card's colour behind it.
  EMBLEMS[card.logo](ctx, x + h * 0.55, y + h * 0.46, h * 0.36, card.ac, mixHex(card.bg[0], card.bg[1], 0.46));
  // The name (bold, slightly condensed and italic: sporty) and a tagline.
  const tx = x + h * 1.05;
  const maxW = w - (tx - x) - h * 0.25;
  ctx.fillStyle = card.fg;
  const big = fitText(ctx, card.name, maxW / 0.86, Math.round(h * 0.5), 900, true);
  ctx.save();
  ctx.translate(tx, y + h * 0.58);
  ctx.scale(0.86, 1);
  ctx.font = `italic 900 ${big}px ${FONT}`;
  ctx.fillText(card.name, 0, 0);
  ctx.restore();
  const small = fitText(ctx, card.tag, maxW, Math.round(h * 0.17), 700, false);
  ctx.font = `700 ${small}px ${FONT}`;
  ctx.globalAlpha = 0.85;
  ctx.fillText(card.tag, tx + 2, y + h * 0.82);
  ctx.globalAlpha = 1;
}

/**
 * A main or secondary sponsor across the big side-wall board (`w` ~ 15 `h`): the emblem at both
 * ends, the name large and centred with its tagline under it, accent lines top and bottom and a
 * few faint diagonal sheens. Calm: no busy pattern, the board shows for 30 s at a time.
 */
function drawBigCard(ctx: Ctx, card: BoardCard, x: number, y: number, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, card.bg[0]);
  g.addColorStop(1, card.bg[1]);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = card.ac;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(x, y + h - h * 0.07, w, h * 0.07);
  ctx.globalAlpha = 0.55;
  ctx.fillRect(x, y, w, h * 0.035);
  ctx.globalAlpha = 0.06;
  for (let k = 0; k < 5; k++) {
    const sx = x + w * (0.08 + k * 0.2);
    ctx.beginPath();
    ctx.moveTo(sx, y);
    ctx.lineTo(sx + h * 0.9, y);
    ctx.lineTo(sx + h * 0.4, y + h);
    ctx.lineTo(sx - h * 0.5, y + h);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const cut = mixHex(card.bg[0], card.bg[1], 0.48);
  EMBLEMS[card.logo](ctx, x + h * 0.9, y + h * 0.47, h * 0.38, card.ac, cut);
  EMBLEMS[card.logo](ctx, x + w - h * 0.9, y + h * 0.47, h * 0.38, card.ac, cut);
  const maxW = w - h * 4.2;
  ctx.fillStyle = card.fg;
  ctx.textAlign = 'center';
  const big = fitText(ctx, card.name, maxW / 0.9, Math.round(h * 0.6), 900, true);
  ctx.save();
  ctx.translate(x + w / 2, y + h * 0.63);
  ctx.scale(0.9, 1);
  ctx.font = `italic 900 ${big}px ${FONT}`;
  ctx.fillText(card.name, 0, 0);
  ctx.restore();
  const small = fitText(ctx, card.tag, maxW * 0.7, Math.round(h * 0.15), 700, false);
  ctx.font = `700 ${small}px ${FONT}`;
  ctx.globalAlpha = 0.85;
  ctx.fillText(card.tag, x + w / 2, y + h * 0.86);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

/** Size (px) of a `width`-wide board atlas: BOARD_COLS x BOARD_ROWS cells at the card aspect. */
export function boardAtlasSize(width: number): { width: number; height: number } {
  return { width, height: Math.round((BOARD_ROWS * width) / (BOARD_COLS * CARD_ASPECT)) };
}

/**
 * Draw a set into a `width` x `height` context (boardAtlasSize), cell i at column i % BOARD_COLS
 * of row floor(i / BOARD_COLS): the BOARD_CARDS cards, then each big sponsor cut in BIG_PANELS
 * thirds (the whole card drawn once per third, clipped to its cell, so the thirds join up). The
 * thirds fill their cells' whole width (the cards keep a 1 px border): the board samples them up
 * to half a texel from the edge, and every join of two thirds is either two neighbouring cells of
 * a row or the atlas's right edge and its left edge, so no other card bleeds into a join.
 */
export function drawBoards(ctx: Ctx, width: number, height: number, set: ContentSet): void {
  reset(ctx, width, height);
  const cw = width / BOARD_COLS;
  const ch = height / BOARD_ROWS;
  // A 1 px inset keeps neighbouring cells from bleeding into each other in the lower mips.
  const cell = (i: number): [number, number] => [(i % BOARD_COLS) * cw + 1, Math.floor(i / BOARD_COLS) * ch + 1];
  for (let i = 0; i < BOARD_CARDS; i++) {
    const [x, y] = cell(i);
    drawCard(ctx, set.cards[i], x, y, cw - 2, ch - 2);
  }
  [set.main, set.secondary].forEach((card, k) => {
    for (let j = 0; j < BIG_PANELS; j++) {
      const [x1, y] = cell(BIG_CELL0 + k * BIG_PANELS + j);
      const x = x1 - 1;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, cw, ch - 2);
      ctx.clip();
      drawBigCard(ctx, card, x - j * cw, y, BIG_PANELS * cw, ch - 2);
      ctx.restore();
    }
  });
}

function canvasTexture(width: number, height: number, anisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** The 2D context of a canvas texture's own canvas (the same context on every call). */
function contextOf(tex: THREE.CanvasTexture): { ctx: Ctx; width: number; height: number } {
  const canvas = tex.image as HTMLCanvasElement;
  return { ctx: canvas.getContext('2d') as Ctx, width: canvas.width, height: canvas.height };
}

/** LED-board atlas: a `width`-wide canvas texture of BOARD_COLS x BOARD_ROWS cells (paintBoards fills it). */
export function boardAtlas(width: number): THREE.CanvasTexture {
  const size = boardAtlasSize(width);
  return canvasTexture(size.width, size.height, 8);
}

/** Paint a set into the board atlas (the same texture: re-uploaded on the next frame). */
export function paintBoards(tex: THREE.CanvasTexture, set: ContentSet): void {
  const { ctx, width, height } = contextOf(tex);
  drawBoards(ctx, width, height, set);
  tex.needsUpdate = true;
}

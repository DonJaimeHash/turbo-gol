/**
 * The canvas atlas of the LED boards (no image or font files: the text uses the system sans-serif,
 * every emblem is a canvas path from emblems.ts). What it shows is a place's content set
 * (content.ts): both harbour themes share the harbour's, every other theme has its own.
 *
 *   boardAtlas()   -> a BOARD_COLS x BOARD_ROWS card canvas texture; paintBoards() draws a set's
 *                     BOARD_CARDS sponsor cards into it
 *
 * StadiumView paints it when it is built and repaints it when a theme switch changes the place:
 * into the same canvas and texture (same size, `needsUpdate`), so the material keeps its binding
 * and never recompiles, and nothing is allocated per frame. drawBoards() takes any 2D context (the
 * tests record one in node).
 *
 * Every name is invented for Turbogol; none is a real brand, and nothing copies a real logo.
 */
import * as THREE from 'three/webgpu';
import type { BoardCard } from './content';
import { EMBLEMS, type Ctx } from './emblems';

export const BOARD_COLS = 2;
export const BOARD_ROWS = 10;
export const BOARD_CARDS = BOARD_COLS * BOARD_ROWS;

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

/** Draw BOARD_CARDS cards into a `size` x `size` context, row by row (card i at column i % BOARD_COLS). */
export function drawBoards(ctx: Ctx, size: number, cards: readonly BoardCard[]): void {
  reset(ctx, size, size);
  const cw = size / BOARD_COLS;
  const ch = size / BOARD_ROWS;
  for (let i = 0; i < BOARD_CARDS; i++) {
    const c = i % BOARD_COLS;
    const r = Math.floor(i / BOARD_COLS);
    // A 1 px inset keeps neighbouring cards from bleeding into each other in the lower mips.
    drawCard(ctx, cards[i], c * cw + 1, r * ch + 1, cw - 2, ch - 2);
  }
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
function contextOf(tex: THREE.CanvasTexture): { ctx: Ctx; width: number } {
  const canvas = tex.image as HTMLCanvasElement;
  return { ctx: canvas.getContext('2d') as Ctx, width: canvas.width };
}

/** LED-board atlas: a `size` x `size` canvas texture for BOARD_COLS x BOARD_ROWS cards (paintBoards fills it). */
export function boardAtlas(size: number): THREE.CanvasTexture {
  return canvasTexture(size, size, 8);
}

/** Paint a set's cards into the board atlas (the same texture: re-uploaded on the next frame). */
export function paintBoards(tex: THREE.CanvasTexture, cards: readonly BoardCard[]): void {
  const { ctx, width } = contextOf(tex);
  drawBoards(ctx, width, cards);
  tex.needsUpdate = true;
}

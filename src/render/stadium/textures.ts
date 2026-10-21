/**
 * Procedural textures of the stadium, drawn once at build time with a 2D canvas (no image or font
 * files: the text uses the system sans-serif, every emblem is a canvas path).
 *
 *   boardAtlas()  -> BOARD_COLS x BOARD_ROWS LED-board cards (invented sponsors)
 *   bannerAtlas() -> BANNER_DESIGNS hanging-banner designs side by side (anchor emblem, lighthouse,
 *                    ball)
 *
 * Every name here is invented for Turbogol; none is a real brand, and nothing copies a real logo.
 */
import * as THREE from 'three/webgpu';
import { BANNER_DESIGNS } from './layout';

export const BOARD_COLS = 2;
export const BOARD_ROWS = 10;
export const BOARD_CARDS = BOARD_COLS * BOARD_ROWS;

const FONT = 'system-ui, "Segoe UI", Roboto, Arial, sans-serif';

type Ctx = CanvasRenderingContext2D;
/** An emblem drawn centred on (x, y), about 2 * s across, in `color` (`bg` for cut-outs). */
type Emblem = (ctx: Ctx, x: number, y: number, s: number, color: string, bg: string) => void;

/** A ship's anchor: ring, stock, shank, curved arms with flukes and the crown. */
export const drawAnchor: Emblem = (ctx, x, y, s, color) => {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 0.075;
  ctx.beginPath();
  ctx.arc(0, -0.78, 0.11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-0.3, -0.56);
  ctx.lineTo(0.3, -0.56);
  ctx.lineWidth = 0.08;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -0.66);
  ctx.lineTo(0, 0.8);
  ctx.lineWidth = 0.1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0.18, 0.6, Math.PI * 0.12, Math.PI * 0.88);
  ctx.lineWidth = 0.09;
  ctx.stroke();
  for (const sx of [-1, 1]) {
    const a = sx > 0 ? Math.PI * 0.12 : Math.PI * 0.88;
    const tx = Math.cos(a) * 0.6;
    const ty = 0.18 + Math.sin(a) * 0.6;
    ctx.beginPath();
    ctx.moveTo(tx + sx * 0.06, ty - 0.3);
    ctx.lineTo(tx + sx * 0.17, ty + 0.06);
    ctx.lineTo(tx - sx * 0.12, ty + 0.02);
    ctx.closePath();
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(-0.1, 0.72);
  ctx.lineTo(0, 0.86);
  ctx.lineTo(0.1, 0.72);
  ctx.fill();
  ctx.restore();
};

const drawWave: Emblem = (ctx, x, y, s, color) => {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.12;
  ctx.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const px = -0.8 + t * 1.6;
      const py = -0.35 + k * 0.35 + Math.sin(t * Math.PI * 2 + k * 0.6) * 0.12;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();
};

const drawBolt: Emblem = (ctx, x, y, s, color) => {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0.18, -0.9);
  ctx.lineTo(-0.42, 0.12);
  ctx.lineTo(-0.02, 0.12);
  ctx.lineTo(-0.2, 0.9);
  ctx.lineTo(0.44, -0.18);
  ctx.lineTo(0.04, -0.18);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
};

/** A lighthouse tower with a lantern, two red bands and light beams. */
const drawLighthouse: Emblem = (ctx, x, y, s, color, bg) => {
  void bg;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-0.22, 0.85);
  ctx.lineTo(-0.13, -0.38);
  ctx.lineTo(0.13, -0.38);
  ctx.lineTo(0.22, 0.85);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(-0.2, -0.62, 0.4, 0.18);
  ctx.beginPath();
  ctx.moveTo(-0.22, -0.62);
  ctx.lineTo(0, -0.86);
  ctx.lineTo(0.22, -0.62);
  ctx.fill();
  ctx.fillStyle = '#e8322f';
  ctx.fillRect(-0.18, 0.05, 0.36, 0.12);
  ctx.fillRect(-0.16, -0.25, 0.32, 0.1);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  for (const sx of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(sx * 0.2, -0.53);
    ctx.lineTo(sx * 0.95, -0.75);
    ctx.lineTo(sx * 0.95, -0.35);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
};

/** A panelled ball (pentagons cut out in the background colour). */
const drawBall: Emblem = (ctx, x, y, s, color, bg) => {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, 0.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = bg;
  const pent = (cx: number, cy: number, r: number, rot: number): void => {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = rot + (i * Math.PI * 2) / 5;
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  };
  pent(0, 0, 0.26, -Math.PI / 2);
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 5 + Math.PI / 5;
    pent(Math.cos(a) * 0.66, Math.sin(a) * 0.66, 0.2, a);
  }
  ctx.restore();
};

const drawChevrons: Emblem = (ctx, x, y, s, color) => {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = color;
  for (let k = 0; k < 3; k++) {
    const ox = -0.6 + k * 0.45;
    ctx.beginPath();
    ctx.moveTo(ox, -0.7);
    ctx.lineTo(ox + 0.3, -0.7);
    ctx.lineTo(ox + 0.75, 0);
    ctx.lineTo(ox + 0.3, 0.7);
    ctx.lineTo(ox, 0.7);
    ctx.lineTo(ox + 0.45, 0);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
};

const EMBLEMS = { anchor: drawAnchor, wave: drawWave, bolt: drawBolt, lighthouse: drawLighthouse, ball: drawBall, chevrons: drawChevrons } as const;

interface Card {
  readonly name: string;
  readonly tag: string;
  readonly logo: keyof typeof EMBLEMS;
  /** Background gradient (top, bottom), text colour, accent / emblem colour. */
  readonly bg: readonly [string, string];
  readonly fg: string;
  readonly ac: string;
}

/** The board cards: invented harbour-town sponsors (darker card palette, critic's fix). */
const CARDS: readonly Card[] = [
  { name: 'PUERTO SUR', tag: 'LIGA DEL PUERTO', logo: 'anchor', bg: ['#0b1d42', '#06122a'], fg: '#ffffff', ac: '#ffffff' },
  { name: 'TURBOGOL', tag: 'turbo-gol.com', logo: 'chevrons', bg: ['#0a0e17', '#04060b'], fg: '#ffffff', ac: '#c6ff2e' },
  { name: 'MARELUX', tag: 'ENERGÍA DEL MAR', logo: 'wave', bg: ['#08305a', '#051d3d'], fg: '#ffffff', ac: '#47d2ff' },
  { name: 'CHISPAZO', tag: 'BEBIDA ENERGÉTICA', logo: 'bolt', bg: ['#121705', '#090b02'], fg: '#e9ff9a', ac: '#c6ff2e' },
  { name: 'FARO ALTO', tag: 'NEUMÁTICOS', logo: 'lighthouse', bg: ['#1a2233', '#0e131f'], fg: '#ffffff', ac: '#ffffff' },
  { name: 'ESTIBA', tag: 'LOGÍSTICA PORTUARIA', logo: 'chevrons', bg: ['#9c420a', '#6a2a04'], fg: '#ffffff', ac: '#ffffff' },
  { name: 'BOYA AZUL', tag: 'SEGUROS', logo: 'ball', bg: ['#164fae', '#0c337a'], fg: '#ffffff', ac: '#ffffff' },
  { name: 'NUDO SIETE', tag: 'ROPA DEPORTIVA', logo: 'anchor', bg: ['#0f0f0f', '#000000'], fg: '#ffffff', ac: '#ffcc00' },
  { name: 'CORALINA', tag: 'TELECOMUNICACIONES', logo: 'wave', bg: ['#b81a4e', '#820c33'], fg: '#ffffff', ac: '#ffffff' },
  { name: 'CANAL CANCHA', tag: 'TODOS LOS PARTIDOS', logo: 'ball', bg: ['#a8840f', '#735a05'], fg: '#14110a', ac: '#14110a' },
  { name: 'MÁS GOL.', tag: 'MÁS TURBO. MÁS PUERTO.', logo: 'chevrons', bg: ['#0b1d42', '#06122a'], fg: '#ffffff', ac: '#3a9bff' },
  { name: 'ONDAMAR', tag: 'CRUCEROS', logo: 'lighthouse', bg: ['#052a3e', '#031a27'], fg: '#ffffff', ac: '#ffd36b' },
  { name: 'GRÚA NORTE', tag: 'MAQUINARIA', logo: 'chevrons', bg: ['#14120a', '#0a0904'], fg: '#ffd21f', ac: '#ffd21f' },
  { name: 'SALINA', tag: 'AGUA MINERAL', logo: 'wave', bg: ['#092647', '#05162c'], fg: '#e6f4ff', ac: '#4fb3ff' },
  { name: 'TIMONEL', tag: 'BANCO DIGITAL', logo: 'anchor', bg: ['#181238', '#0c0921'], fg: '#ffffff', ac: '#9b8cff' },
  { name: 'VELA ROJA', tag: 'PIZZERÍA', logo: 'ball', bg: ['#aa0e27', '#74081a'], fg: '#ffffff', ac: '#ffffff' },
  { name: 'PIXELMAR', tag: 'VIDEOJUEGOS', logo: 'bolt', bg: ['#250840', '#140423'], fg: '#ffffff', ac: '#ff4fd8' },
  { name: 'MUELLE 9', tag: 'MERCADO', logo: 'anchor', bg: ['#0d3528', '#072118'], fg: '#ffffff', ac: '#7cf0b5' },
  { name: 'AEROFARO', tag: 'AEROLÍNEA', logo: 'wave', bg: ['#0e1527', '#070b15'], fg: '#ffffff', ac: '#8fd0ff' },
  { name: 'LIGA PORTUARIA', tag: 'NOCHE DE PUERTO', logo: 'anchor', bg: ['#0b1d42', '#06122a'], fg: '#ffffff', ac: '#ffffff' },
];

function fitText(ctx: Ctx, text: string, maxW: number, size: number, weight: number, italic: boolean): number {
  let s = size;
  for (;;) {
    ctx.font = `${italic ? 'italic ' : ''}${weight} ${s}px ${FONT}`;
    if (ctx.measureText(text).width <= maxW || s < 10) return s;
    s -= 2;
  }
}

function drawCard(ctx: Ctx, card: Card, x: number, y: number, w: number, h: number): void {
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

  EMBLEMS[card.logo](ctx, x + h * 0.55, y + h * 0.46, h * 0.36, card.ac, card.bg[1]);
  // The name (bold, slightly condensed and italic: sporty) and a tagline.
  const tx = x + h * 1.05;
  const maxW = w - (tx - x) - h * 0.25;
  ctx.fillStyle = card.fg;
  ctx.textBaseline = 'alphabetic';
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

function canvasTexture(canvas: HTMLCanvasElement, anisotropy: number, wrap: THREE.Wrapping): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = wrap;
  tex.wrapT = wrap;
  tex.needsUpdate = true;
  return tex;
}

/** LED-board atlas: BOARD_COLS x BOARD_ROWS cards in a `size` x `size` canvas. */
export function boardAtlas(size: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d') as Ctx;
  const cw = size / BOARD_COLS;
  const ch = size / BOARD_ROWS;
  for (let i = 0; i < BOARD_CARDS; i++) {
    const c = i % BOARD_COLS;
    const r = Math.floor(i / BOARD_COLS);
    // A 1 px inset keeps neighbouring cards from bleeding into each other in the lower mips.
    drawCard(ctx, CARDS[i], c * cw + 1, r * ch + 1, cw - 2, ch - 2);
  }
  return canvasTexture(canvas, 8, THREE.ClampToEdgeWrapping);
}

interface BannerDesign {
  readonly bg: readonly [string, string];
  readonly fg: string;
  readonly emblem: Emblem;
  readonly text: string;
}

/** Banner designs, in the order layout.ts bannerPlaces() picks them: blue, red, lighthouse, ball. */
const BANNERS: readonly BannerDesign[] = [
  { bg: ['#13295c', '#0a1736'], fg: '#ffffff', emblem: drawAnchor, text: 'PUERTO SUR' },
  { bg: ['#8a1124', '#4f0712'], fg: '#ffffff', emblem: drawAnchor, text: 'PUERTO SUR' },
  { bg: ['#13295c', '#0a1736'], fg: '#ffffff', emblem: drawLighthouse, text: 'EL FARO' },
  { bg: ['#0e1626', '#060a12'], fg: '#c6ff2e', emblem: (ctx, x, y, s, _c, bg) => drawBall(ctx, x, y, s * 0.85, '#ffffff', bg), text: 'TURBOGOL' },
];

/**
 * Hanging banners: BANNER_DESIGNS designs side by side, each w x 3w (cloth with a stitched border,
 * a sleeve at the top, the emblem, a name and a swallow-tail cut the shader alpha-tests).
 */
export function bannerAtlas(w: number): THREE.CanvasTexture {
  const h = w * 3;
  const canvas = document.createElement('canvas');
  canvas.width = w * BANNER_DESIGNS;
  canvas.height = h;
  const ctx = canvas.getContext('2d') as Ctx;
  BANNERS.forEach((d, i) => {
    const x0 = i * w;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, d.bg[0]);
    g.addColorStop(1, d.bg[1]);
    ctx.fillStyle = g;
    ctx.fillRect(x0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = w * 0.025;
    ctx.strokeRect(x0 + w * 0.07, h * 0.06, w * 0.86, h * 0.86);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x0, 0, w, h * 0.035);
    d.emblem(ctx, x0 + w / 2, h * 0.4, w * 0.36, '#ffffff', d.bg[1]);
    ctx.fillStyle = d.fg;
    const fs = fitText(ctx, d.text, w * 0.74, Math.round(w * 0.14), 900, false);
    ctx.font = `900 ${fs}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(d.text, x0 + w / 2, h * 0.78);
    ctx.textAlign = 'left';
    // Swallow-tail cut at the bottom (transparent below the V).
    ctx.clearRect(x0, h * 0.94, w, h * 0.06);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x0, h * 0.94);
    ctx.lineTo(x0 + w, h * 0.94);
    ctx.lineTo(x0 + w, h);
    ctx.lineTo(x0 + w / 2, h * 0.955);
    ctx.lineTo(x0, h);
    ctx.closePath();
    ctx.fill();
  });
  return canvasTexture(canvas, 4, THREE.ClampToEdgeWrapping);
}

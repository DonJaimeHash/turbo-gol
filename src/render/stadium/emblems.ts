/**
 * The emblems of the board cards and banners (textures.ts), each a 2D-canvas path drawn by code
 * (no image files, nothing copied from a real logo). An emblem is drawn centred on (x, y), about
 * 2 * s across, in one colour; `bg` (the card's or banner's background colour behind the emblem)
 * cuts details out of it. Every emblem saves and restores the context state.
 *
 *   generic    bolt, ball, chevrons, wave         (any place)
 *   harbour    anchor, lighthouse
 *   canyon     sunMesa (a striped sun over a mesa), cactus
 *   city       skyline, neonStar
 *   alpine     peak (a snowy summit), pine
 *   railyard   wheel (a locomotive driving wheel on its rail), gear, chimney (a works chimney and
 *              a sawtooth hall)
 */

export type Ctx = CanvasRenderingContext2D;
/** An emblem drawn centred on (x, y), about 2 * s across, in `color` (`bg` for cut-outs). */
export type Emblem = (ctx: Ctx, x: number, y: number, s: number, color: string, bg: string) => void;

/** Save the context and enter the emblem's unit space (centre 0, 0; radius about 1). */
function enter(ctx: Ctx, x: number, y: number, s: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

// ---- Generic ----------------------------------------------------------------------------------

const drawWave: Emblem = (ctx, x, y, s, color) => {
  enter(ctx, x, y, s, color);
  ctx.lineWidth = 0.12;
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
  enter(ctx, x, y, s, color);
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

/** A panelled ball (pentagons cut out in the background). */
const drawBall: Emblem = (ctx, x, y, s, color, bg) => {
  enter(ctx, x, y, s, color);
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
  enter(ctx, x, y, s, color);
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

// ---- Harbour ----------------------------------------------------------------------------------

/** A ship's anchor: ring, stock, shank, curved arms with flukes and the crown. */
const drawAnchor: Emblem = (ctx, x, y, s, color) => {
  enter(ctx, x, y, s, color);
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

/** A lighthouse tower with a lantern, two red bands and light beams. */
const drawLighthouse: Emblem = (ctx, x, y, s, color) => {
  enter(ctx, x, y, s, color);
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

// ---- Canyon -----------------------------------------------------------------------------------

/** A sunset sun with short rays and two cut stripes, sinking behind a mesa and a small butte. */
const drawSunMesa: Emblem = (ctx, x, y, s, color, bg) => {
  enter(ctx, x, y, s, color);
  const sy = -0.12;
  ctx.beginPath();
  ctx.arc(0, sy, 0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 0.075;
  for (let i = 0; i < 7; i++) {
    const a = Math.PI * (1.08 + (i * 0.84) / 6);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * 0.6, sy + Math.sin(a) * 0.6);
    ctx.lineTo(Math.cos(a) * 0.82, sy + Math.sin(a) * 0.82);
    ctx.stroke();
  }
  ctx.fillStyle = bg;
  ctx.fillRect(-0.5, 0.0, 1.0, 0.05);
  ctx.fillRect(-0.5, 0.11, 1.0, 0.07);
  // The mesa (flat top, a stepped flank) and a butte, outlined in the background so they stand
  // clear of the sun.
  const mesa = (): void => {
    ctx.beginPath();
    ctx.moveTo(-0.98, 0.82);
    ctx.lineTo(-0.86, 0.42);
    ctx.lineTo(-0.7, 0.3);
    ctx.lineTo(-0.62, 0.2);
    ctx.lineTo(0.22, 0.2);
    ctx.lineTo(0.3, 0.34);
    ctx.lineTo(0.42, 0.4);
    ctx.lineTo(0.5, 0.82);
    ctx.closePath();
    ctx.moveTo(0.46, 0.82);
    ctx.lineTo(0.6, 0.5);
    ctx.lineTo(0.84, 0.5);
    ctx.lineTo(0.98, 0.82);
    ctx.closePath();
  };
  mesa();
  ctx.strokeStyle = bg;
  ctx.lineWidth = 0.1;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillRect(-1, 0.88, 2, 0.06);
  ctx.restore();
};

/** A saguaro cactus: a round-topped trunk with ribs, two curved arms, standing on the ground. */
const drawCactus: Emblem = (ctx, x, y, s, color, bg) => {
  enter(ctx, x, y, s, color);
  ctx.lineWidth = 0.22;
  ctx.beginPath();
  ctx.moveTo(0, 0.24);
  ctx.lineTo(-0.26, 0.24);
  ctx.arcTo(-0.44, 0.24, -0.44, 0.06, 0.18);
  ctx.lineTo(-0.44, -0.3);
  ctx.moveTo(0, -0.02);
  ctx.lineTo(0.26, -0.02);
  ctx.arcTo(0.44, -0.02, 0.44, -0.2, 0.18);
  ctx.lineTo(0.44, -0.52);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-0.16, 0.86);
  ctx.lineTo(-0.16, -0.64);
  ctx.arc(0, -0.64, 0.16, Math.PI, 0);
  ctx.lineTo(0.16, 0.86);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = bg;
  ctx.lineWidth = 0.032;
  ctx.beginPath();
  ctx.moveTo(-0.065, -0.6);
  ctx.lineTo(-0.065, 0.8);
  ctx.moveTo(0.065, -0.6);
  ctx.lineTo(0.065, 0.8);
  ctx.stroke();
  ctx.fillRect(-0.7, 0.86, 1.4, 0.07);
  ctx.restore();
};

// ---- City -------------------------------------------------------------------------------------

/** Downtown towers on a ground line, windows cut out, an antenna on the tallest. */
const drawSkyline: Emblem = (ctx, x, y, s, color, bg) => {
  enter(ctx, x, y, s, color);
  const towers: readonly (readonly [number, number, number])[] = [
    [-0.92, 0.3, -0.12],
    [-0.62, 0.26, -0.48],
    [-0.36, 0.3, -0.84],
    [-0.06, 0.24, -0.3],
    [0.18, 0.3, -0.62],
    [0.48, 0.24, -0.2],
    [0.72, 0.22, 0.05],
  ];
  for (const [tx, tw, top] of towers) ctx.fillRect(tx, top, tw, 0.8 - top);
  ctx.fillRect(0.24, -0.72, 0.18, 0.1);
  ctx.lineWidth = 0.045;
  ctx.beginPath();
  ctx.moveTo(-0.21, -0.84);
  ctx.lineTo(-0.21, -1.0);
  ctx.stroke();
  ctx.fillStyle = bg;
  for (const [tx, tw, top] of towers) {
    for (let wy = top + 0.1; wy < 0.68; wy += 0.14) {
      for (let c = 0; c < 2; c++) ctx.fillRect(tx + tw * (0.2 + c * 0.36), wy, tw * 0.24, 0.065);
    }
  }
  ctx.fillRect(-1, 0.8, 2, 0.04);
  ctx.fillStyle = color;
  ctx.fillRect(-1, 0.84, 2, 0.07);
  ctx.restore();
};

/** A neon star: a five-pointed outline with a soft glow (wide faint strokes) and two sparkles. */
const drawNeonStar: Emblem = (ctx, x, y, s, color) => {
  enter(ctx, x, y, s, color);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 1 ? 0.36 : 0.86;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx.lineTo(Math.cos(a) * r, 0.06 + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = 0.28;
  ctx.stroke();
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 0.16;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 0.075;
  ctx.stroke();
  ctx.lineWidth = 0.045;
  ctx.beginPath();
  for (const [cx, cy, r] of [
    [0.8, -0.72, 0.13],
    [-0.82, 0.62, 0.1],
  ] as const) {
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
  }
  ctx.stroke();
  ctx.restore();
};

// ---- Alpine -----------------------------------------------------------------------------------

/** A snowy summit (a jagged snow line cut below the top) before a dimmer second peak. */
const drawPeak: Emblem = (ctx, x, y, s, color, bg) => {
  enter(ctx, x, y, s, color);
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.moveTo(0.05, 0.8);
  ctx.lineTo(0.52, -0.22);
  ctx.lineTo(0.98, 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.moveTo(-0.98, 0.8);
  ctx.lineTo(-0.12, -0.82);
  ctx.lineTo(0.74, 0.8);
  ctx.closePath();
  ctx.strokeStyle = bg;
  ctx.lineWidth = 0.08;
  ctx.stroke();
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.lineWidth = 0.07;
  ctx.beginPath();
  ctx.moveTo(-0.5, -0.2);
  ctx.lineTo(-0.34, -0.06);
  ctx.lineTo(-0.2, -0.24);
  ctx.lineTo(-0.05, -0.1);
  ctx.lineTo(0.08, -0.27);
  ctx.lineTo(0.26, -0.14);
  ctx.stroke();
  ctx.restore();
  ctx.fillRect(-1, 0.86, 2, 0.07);
  ctx.restore();
};

/** A pine: three tiers (each upper tier outlined in the background over the one below) and a trunk. */
const drawPine: Emblem = (ctx, x, y, s, color, bg) => {
  enter(ctx, x, y, s, color);
  ctx.fillRect(-0.09, 0.5, 0.18, 0.38);
  ctx.strokeStyle = bg;
  ctx.lineWidth = 0.07;
  const tiers: readonly (readonly [number, number, number])[] = [
    [-0.3, 0.58, 0.66],
    [-0.62, 0.2, 0.5],
    [-0.94, -0.18, 0.34],
  ];
  tiers.forEach(([apex, base, hw], i) => {
    ctx.beginPath();
    ctx.moveTo(0, apex);
    ctx.lineTo(hw, base);
    ctx.lineTo(-hw, base);
    ctx.closePath();
    if (i > 0) ctx.stroke();
    ctx.fill();
  });
  ctx.fillRect(-0.62, 0.88, 1.24, 0.06);
  ctx.restore();
};

// ---- Railyard ---------------------------------------------------------------------------------

/** A locomotive driving wheel: rim, spokes, the crescent counterweight, hub, crank boss, on a rail. */
const drawWheel: Emblem = (ctx, x, y, s, color, bg) => {
  enter(ctx, x, y, s, color);
  const cy = -0.06;
  ctx.lineWidth = 0.13;
  ctx.beginPath();
  ctx.arc(0, cy, 0.78, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 0.06;
  ctx.beginPath();
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI * 2) / 12 + Math.PI / 12;
    ctx.moveTo(Math.cos(a) * 0.18, cy + Math.sin(a) * 0.18);
    ctx.lineTo(Math.cos(a) * 0.74, cy + Math.sin(a) * 0.74);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, cy, 0.74, Math.PI * 0.16, Math.PI * 0.84);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, cy, 0.21, 0, Math.PI * 2);
  ctx.moveTo(0.1, cy - 0.42);
  ctx.arc(0, cy - 0.42, 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(0, cy, 0.08, 0, Math.PI * 2);
  ctx.moveTo(0.04, cy - 0.42);
  ctx.arc(0, cy - 0.42, 0.04, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(-1, 0.86, 2, 0.08);
  ctx.restore();
};

/** A ten-tooth gear with a bore and five lightening holes. */
const drawGear: Emblem = (ctx, x, y, s, color, bg) => {
  enter(ctx, x, y, s, color);
  const N = 10;
  const t = (Math.PI * 2) / N;
  const at = (r: number, a: number): void => ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const a0 = i * t;
    at(0.66, a0);
    at(0.66, a0 + 0.18 * t);
    at(0.9, a0 + 0.3 * t);
    at(0.9, a0 + 0.7 * t);
    at(0.66, a0 + 0.82 * t);
  }
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(0, 0, 0.24, 0, Math.PI * 2);
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    ctx.moveTo(Math.cos(a) * 0.45 + 0.1, Math.sin(a) * 0.45);
    ctx.arc(Math.cos(a) * 0.45, Math.sin(a) * 0.45, 0.1, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.restore();
};

/** A tapering brick chimney with smoke, beside a works hall with a sawtooth roof. */
const drawChimney: Emblem = (ctx, x, y, s, color, bg) => {
  enter(ctx, x, y, s, color);
  ctx.beginPath();
  ctx.moveTo(-0.95, 0.88);
  ctx.lineTo(-0.95, 0.3);
  for (let k = 0; k < 3; k++) {
    const x0 = -0.95 + k * 0.3;
    ctx.lineTo(x0, 0.06);
    ctx.lineTo(x0 + 0.3, 0.3);
  }
  ctx.lineTo(-0.05, 0.88);
  ctx.closePath();
  ctx.moveTo(0.05, 0.88);
  ctx.lineTo(0.14, -0.5);
  ctx.lineTo(0.34, -0.5);
  ctx.lineTo(0.43, 0.88);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(0.09, -0.6, 0.3, 0.11);
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  for (const [cx, cy, r] of [
    [0.3, -0.76, 0.13],
    [0.52, -0.84, 0.16],
    [0.78, -0.8, 0.19],
  ] as const) {
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = bg;
  for (const by of [-0.22, 0.14, 0.5]) ctx.fillRect(0.0, by, 0.5, 0.035);
  for (let k = 0; k < 3; k++) ctx.fillRect(-0.88 + k * 0.3, 0.46, 0.15, 0.16);
  ctx.restore();
};

export const EMBLEMS = {
  wave: drawWave,
  bolt: drawBolt,
  ball: drawBall,
  chevrons: drawChevrons,
  anchor: drawAnchor,
  lighthouse: drawLighthouse,
  sunMesa: drawSunMesa,
  cactus: drawCactus,
  skyline: drawSkyline,
  neonStar: drawNeonStar,
  peak: drawPeak,
  pine: drawPine,
  wheel: drawWheel,
  gear: drawGear,
  chimney: drawChimney,
} as const satisfies Readonly<Record<string, Emblem>>;

export type EmblemId = keyof typeof EMBLEMS;

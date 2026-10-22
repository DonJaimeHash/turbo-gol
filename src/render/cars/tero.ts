/**
 * The Tero ('tero', the southern lapwing: small, loud, territorial): a compact retro rally
 * hatchback. A short two-box body with a tall glasshouse (raked screen, upright hatch, blacked-out
 * B-pillar, thick C-pillars), square-cut bolted-on box flares over all four wheels joined by
 * black sills, a roof scoop, a roof wing with black side plates, a four-lamp pod on the bonnet,
 * square headlights, black bumpers with a tow strap at each end, mud flaps behind the front
 * wheels, door mirrors, a white number plate with a black "7" on each door, and the twin
 * thrusters leaving through notches in the black rear bumper, a hot core glowing in each throat.
 * Rally livery: twin stripes in the accent yellow over the bonnet, the roof's edges, the roof and
 * the wing, three yellow chevrons on the roof between them (what the chase camera sees), team
 * paint above a yellow pinstripe and gloss carbon below it. Wheels: knobby gravel tyres on white
 * six-spoke rims with a team hub, the same size front and rear (bigger than the dune runner's
 * front ones: a lifted stance).
 *
 * Designed on the default hitbox in the build frame (kit.hl / hh / hw 58.75 / 17.83 / 41.85;
 * docs/cars.md "Two frames"). The tub and the glasshouse are swept from explicit profiles (sweep,
 * below) rather than kit.loft's superellipses, so the stripe edges, pillars and window edges sit
 * on exact columns: every surface change follows a triangle edge and the stripes cost no
 * triangle. Everything stays inside the hitbox: the rear tyres stand past the tail, so the rear
 * bumper sits between them and the mud flaps hang behind the front wheels only.
 */
import * as THREE from 'three/webgpu';
import { BOOST_NOZZLE_X, CAGE, CAR_KIND, DISC, EXHAUST, HEADLIGHT, TAILLIGHT, TRIM } from './kit';
import type { BodyKit, CarBodySpec, Surface, WheelAt, WheelStyle } from './types';

/** Rally yellow: the stripes, the pinstripe (LiverySpec.accent), the mud flaps' bars. */
const ACCENT = 0xffc21a;

/** Knobby gravel tyres on white six-spoke rally rims over a dark dish, no beadlock, a team hub cap. */
export const TERO_WHEEL: WheelStyle = {
  id: 'tero-rally-6',
  tyre: 'knobby',
  spokes: 6,
  spokeWidth: 0.22,
  dish: 0.32,
  dishColor: DISC.color,
  rim: 0xe6e8ec,
  rimFinish: { metal: 0.3, rough: 0.36 },
  bead: null,
  bolts: 0,
  hub: 'team',
  // Without the beadlock ring and its bolts the wheel is lighter than the dune runner's.
  budget: { low: 400, high: 560 },
};

// ---- surfaces (vertex data only: kinds the shared material already has) --------------------

/** Satin black plastic: bumpers, B-pillar, wing plates, scoop mouth, wheel-well liners, trim. */
const BLACK: Surface = { ...TRIM, color: 0x15171b, rough: 0.6 };
/** Mud-flap rubber. */
const RUBBER: Surface = { ...TRIM, color: 0x0d0e10, rough: 0.9 };
/** White number plates. */
const PLATE: Surface = { ...TRIM, color: 0xf1f1ec, metal: 0, rough: 0.42 };
/** Yellow trim (the mud flaps' bars). */
const YELLOW: Surface = { ...TRIM, color: ACCENT, metal: 0, rough: 0.5 };
/** Tow straps: the lapwing's red spur. */
const STRAP: Surface = { ...TRIM, color: 0xff4a1c, metal: 0, rough: 0.7 };
/** The pod's lamp lenses: selective yellow, hot. */
const POD_LAMP: Surface = { ...HEADLIGHT, color: 0xffe7a3, emissive: 2.8 };
/** Amber indicators beside the tail lights. */
const INDICATOR: Surface = { ...TAILLIGHT, color: 0xff9a1a, emissive: 1.6 };
/** The thrusters' throats: a hot glow deep in the pipe. */
const THROAT: Surface = { ...TAILLIGHT, color: 0xff6418, emissive: 1.3 };
/** Mirror glass (the door mirrors' back faces). */
const MIRROR: Surface = { color: 0xc9ced6, metal: 1, rough: 0.12, emissive: 0, kind: CAR_KIND.CHROME };
/** Panel gaps and bolt heads. */
const GAP: Surface = { ...DISC, color: 0x0b0c0f, rough: 0.7 };
/** Satin alloy: lamp cans, exhaust lips, sump guard. */
const ALLOY = CAGE;

// ---- sweep: a closed solid from explicit rings ---------------------------------------------

/** A ring point (build frame) and the label of where it sits on its profile. */
interface RP {
  readonly p: readonly [number, number, number];
  readonly l: string;
}

/**
 * Picks the surface of one segment of a sweep: `band` is the ring gap (0 = rings 0..1), or -1 /
 * -2 for the first / last cap; `a`, `b` the labels of the segment's two ring points (caps: the
 * point and the next one).
 */
type SweepPick = (band: number, a: string, b: string) => Surface;

/**
 * A closed solid swept through `rings` (each the same number of points, in the same order round
 * the profile): consecutive rings stitched into quads, both ends closed by a fan on their own
 * vertices (a crisp end edge), smooth normals along and round the sides. Each segment's surface
 * comes from `pick`, so a stripe, a window or a pillar is a run of columns: the parts sharing an
 * edge share its vertices exactly (no crack) and its normal (no shading seam). Faces point
 * outwards whichever way the rings run (the signed volume decides). Points must not coincide
 * within a ring nor between consecutive rings (a zero-area face has no normal). The last cap's
 * fan meets at `endCentre` when given (a point inside that ring's plane), else at the ring's
 * average point.
 */
function sweep(k: BodyKit, rings: readonly (readonly RP[])[], pick: SweepPick, endCentre?: readonly [number, number, number]): void {
  const n = rings[0].length;
  const pos: number[] = [];
  const tris: number[] = [];
  const surf: Surface[] = [];
  for (const r of rings) for (const q of r) pos.push(q.p[0], q.p[1], q.p[2]);
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      const a = i * n + j;
      const b = i * n + j1;
      const c = (i + 1) * n + j;
      const d = (i + 1) * n + j1;
      const s = pick(i, rings[i][j].l, rings[i][j1].l);
      tris.push(a, c, b, b, c, d);
      surf.push(s, s);
    }
  }
  const cap = (r: readonly RP[], last: boolean): void => {
    const first = pos.length / 3;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const q of r) {
      pos.push(q.p[0], q.p[1], q.p[2]);
      cx += q.p[0] / n;
      cy += q.p[1] / n;
      cz += q.p[2] / n;
    }
    const centre = pos.length / 3;
    if (last && endCentre !== undefined) pos.push(endCentre[0], endCentre[1], endCentre[2]);
    else pos.push(cx, cy, cz);
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      if (last) tris.push(centre, first + j1, first + j);
      else tris.push(centre, first + j, first + j1);
      surf.push(pick(last ? -2 : -1, r[j].l, r[j1].l));
    }
  };
  cap(rings[0], false);
  cap(rings[rings.length - 1], true);
  // Outwards: a positive signed volume (divergence theorem), else flip every face.
  let vol = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3;
    const b = tris[t + 1] * 3;
    const c = tris[t + 2] * 3;
    vol +=
      pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
      pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
      pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  if (vol < 0) {
    for (let t = 0; t < tris.length; t += 3) {
      const b = tris[t + 1];
      tris[t + 1] = tris[t + 2];
      tris[t + 2] = b;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(tris);
  g.computeVertexNormals();
  const P = g.attributes.position.array;
  const N = g.attributes.normal.array;
  // One non-indexed geometry per surface, in the order the surfaces first appear.
  const groups = new Map<Surface, { p: number[]; n: number[] }>();
  for (let t = 0; t < surf.length; t++) {
    let grp = groups.get(surf[t]);
    if (grp === undefined) {
      grp = { p: [], n: [] };
      groups.set(surf[t], grp);
    }
    for (let v = 0; v < 3; v++) {
      const i = tris[t * 3 + v] * 3;
      grp.p.push(P[i], P[i + 1], P[i + 2]);
      grp.n.push(N[i], N[i + 1], N[i + 2]);
    }
  }
  g.dispose();
  for (const [s, grp] of groups) {
    const part = new THREE.BufferGeometry();
    part.setAttribute('position', new THREE.Float32BufferAttribute(grp.p, 3));
    part.setAttribute('normal', new THREE.Float32BufferAttribute(grp.n, 3));
    k.push(part, s);
  }
}

/** A labelled profile point (u, v, label). */
type PP = readonly [number, number, string];

/** A profile half (z >= 0) mirrored into a full ring at station x of a sweep along x: (z, y) -> (x, y, z). */
function ringX(x: number, centreBottom: PP | null, half: readonly PP[], centreTop: PP | null): RP[] {
  const out: RP[] = [];
  if (centreBottom !== null) out.push({ p: [x, centreBottom[1], 0], l: centreBottom[2] });
  for (const [z, y, l] of half) out.push({ p: [x, y, z], l });
  if (centreTop !== null) out.push({ p: [x, centreTop[1], 0], l: centreTop[2] });
  for (let i = half.length - 1; i >= 0; i--) out.push({ p: [x, half[i][1], -half[i][0]], l: half[i][2] });
  return out;
}

/** `k` points strictly inside a circular arc of radius r about (cu, cv), from angle a0 to a1 (rad). */
function arc(cu: number, cv: number, r: number, a0: number, a1: number, k: number, l: string): PP[] {
  const out: PP[] = [];
  for (let i = 1; i <= k; i++) {
    const a = a0 + ((a1 - a0) * i) / (k + 1);
    out.push([cu + r * Math.cos(a), cv + r * Math.sin(a), l]);
  }
  return out;
}

/** Whether the segment a-b joins exactly the labels u and v (either way round). */
function seg(a: string, b: string, u: string, v: string): boolean {
  return (a === u && b === v) || (a === v && b === u);
}

/** A bar across the car from z0 to z1 of a chamfered section (x depth, y height), its ends chamfered on high detail. */
function bar(k: BodyKit, s: Surface, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  const c = 0.8;
  const sec = (z: number, inset: number): RP[] => {
    const a = x0 + inset;
    const b = x1 - inset;
    const lo = y0 + inset;
    const hi = y1 - inset;
    return [
      [a, lo + c],
      [a + c, lo],
      [b - c, lo],
      [b, lo + c],
      [b, hi - c],
      [b - c, hi],
      [a + c, hi],
      [a, hi - c],
    ].map(([px, py]) => ({ p: [px, py, z] as const, l: 'b' }));
  };
  sweep(k, k.hi ? [sec(z0, 0.7), sec(z0 + 0.9, 0), sec(z1 - 0.9, 0), sec(z1, 0.7)] : [sec(z0, 0), sec(z1, 0)], () => s);
}

// ---- the tub: bonnet, flanks, wheel wells, tail ----------------------------------------------

/** Stripe columns (|z|, build frame) shared by the bonnet, the roof, the roof's edges and the wing. */
const STRIPE_IN = 7.5;
const STRIPE_OUT = 13;

/** One station of the tub: x, half width W, bottom yb, belt / bonnet top yt, wheel well (stem half width, ceiling) or null. */
interface TubStation {
  readonly x: number;
  readonly w: number;
  readonly yb: number;
  readonly yt: number;
  readonly well: { readonly stem: number; readonly ceil: number } | null;
}

/**
 * The tub's profile at one station (right half, labelled; ringX mirrors it): a bottom corner that
 * is either rounded (between the wheels) or a wheel well (a narrow stem under a ceiling just over
 * the tyre), a flat flank, a slight tumblehome to a rounded top corner, and a crowned top with the
 * stripe columns. Low detail cuts the bottom corner square (three points instead of six) and drops
 * a point of the top corner and a column of the top.
 */
function tubRing(s: TubStation, hi: boolean): RP[] {
  const { x, w, yb, yt } = s;
  const wt = w - 0.7;
  const crown = 0.55;
  const top = (z: number): number => yt + crown * (1 - (z / (wt - 1.6)) ** 2);
  // The bottom corner: six points on high (rounded), three on low (square-cut).
  const n = hi ? 6 : 3;
  const low: PP[] =
    s.well === null
      ? // A rounded bottom corner, radius 4, from the floor to the flank.
        Array.from({ length: n }, (_, i): PP => {
          const a = -Math.PI / 2 + (i * Math.PI) / (2 * (n - 1));
          return [w - 4 + 4 * Math.cos(a), yb + 4 + 4 * Math.sin(a), 'low'];
        })
      : hi
        ? [
            [s.well.stem - 1.2, yb, 'low'],
            [s.well.stem, yb + 1.2, 'low'],
            [s.well.stem, s.well.ceil - 0.8, 'low'],
            [s.well.stem + 0.8, s.well.ceil, 'low'],
            [w - 1.0, s.well.ceil, 'low'],
            [w, s.well.ceil + 0.8, 'low'],
          ]
        : [
            [s.well.stem, yb, 'low'],
            [s.well.stem, s.well.ceil, 'low'],
            [w, s.well.ceil, 'low'],
          ];
  const shoulder = yt - 1.6;
  // The flank is flat up to `side`, then leans in (tumblehome) to the rounded top corner.
  const side = Math.max(yt - 3.4, (low[n - 1][1] + shoulder) * 0.5);
  const half: PP[] = [
    ...low,
    [w, side, 'side'],
    [wt, shoulder, 'corner'],
    ...(hi ? [[wt - 0.5, yt - 0.5, 'corner'] as PP] : []),
    [wt - 1.6, top(wt - 1.6), 'edge'],
    ...(hi ? [[21.5, top(21.5), 't21'] as PP] : []),
    [STRIPE_OUT, top(STRIPE_OUT), 's13'],
    [STRIPE_IN, top(STRIPE_IN), 's7'],
  ];
  return ringX(x, [0, yb, 'low'], half, [0, top(0), 'tc']);
}

function tub(k: BodyKit, stripe: Surface): void {
  const { hi } = k;
  const front = k.wheels.front;
  const back = k.wheels.back;
  // The wells: a stem inside the tyres, a ceiling 1.75 uu over them, open 1.1 uu clear of each
  // tyre where it meets the tub's bottom.
  const stem = front.zIn - 1.7;
  const wellF = { stem, ceil: front.y + front.radius + 1.75 };
  const wellR = { stem, ceil: back.y + back.radius + 1.75 };
  const yb = -k.hh + 0.25;
  const reachF = Math.sqrt(Math.max(0, front.radius ** 2 - (yb - front.y) ** 2)) + 1.1;
  const reachR = Math.sqrt(Math.max(0, back.radius ** 2 - (yb - back.y) ** 2)) + 1.1;
  const cowl = front.x - reachF - 1.0;
  const stations: TubStation[] = [
    { x: 58.0, w: 29.2, yb: -15.0, yt: -3.4, well: null },
    { x: 57.3, w: 31.2, yb: -16.0, yt: -2.6, well: null },
    { x: 56.0, w: 32.3, yb: -16.8, yt: -2.0, well: null },
    { x: front.x + reachF + 0.9, w: 32.8, yb: -17.2, yt: -1.35, well: null },
    { x: front.x + reachF, w: 32.9, yb: -17.2, yt: -1.1, well: wellF },
    ...(hi ? [{ x: 40, w: 33.4, yb, yt: -0.2, well: wellF }] : []),
    { x: front.x - reachF, w: 33.6, yb, yt: 1.0, well: wellF },
    { x: cowl, w: 33.6, yb, yt: 1.05, well: null },
    { x: back.x + reachR + 1.0, w: 33.6, yb, yt: 2.4, well: null },
    { x: back.x + reachR, w: 33.6, yb, yt: 2.4, well: wellR },
    ...(hi
      ? [
          { x: -52.0, w: 33.4, yb, yt: 2.9, well: wellR },
          { x: -54.8, w: 33.0, yb, yt: 2.9, well: wellR },
        ]
      : []),
    { x: -55.6, w: 32.0, yb: yb + 0.8, yt: 2.2, well: { stem: stem - 0.6, ceil: wellR.ceil + 0.4 } },
  ];
  // Stripes on the bonnet (ahead of the cowl); team paint everywhere else.
  sweep(
    k,
    stations.map((s) => tubRing(s, hi)),
    (band, a, b) => (band >= 0 && stations[band + 1].x >= cowl - 1e-6 && seg(a, b, 's13', 's7') ? stripe : k.paint),
  );
}

// ---- the glasshouse --------------------------------------------------------------------------

/** One level of the glasshouse: height y (and the hatch face's own), screen x, hatch x, half width W. */
interface GlassLevel {
  readonly y: number;
  readonly yRear: number;
  readonly xf: number;
  readonly xr: number;
  readonly w: number;
}

const PILLAR_A = 4.5;
const PILLAR_C = 6.5;
const B_PILLAR_X = -14.5;

/**
 * The glasshouse's ring at one level (a rounded rectangle in plan, labelled round its edge): the
 * screen face with the stripe columns, the A-pillar arc, the side with the B-pillar's two edges and
 * the quarter window's end, the C-pillar arc, the hatch face with the rear glass's edge and the
 * stripe columns. The hatch face's points sit at their own height (the glass starts higher there:
 * a painted tailgate under it).
 */
function glassRing(g: GlassLevel, kA: number, kC: number): RP[] {
  const { y, yRear, xf, xr, w } = g;
  const half: PP[] = [
    [xf, STRIPE_IN, 'F7'],
    [xf, STRIPE_OUT, 'F13'],
    [xf, w - PILLAR_A, 'FA'],
    ...arc(xf - PILLAR_A, w - PILLAR_A, PILLAR_A, 0, Math.PI / 2, kA, 'A'),
    [xf - PILLAR_A, w, 'S'],
    [B_PILLAR_X + 1.5, w, 'B1'],
    [B_PILLAR_X - 1.5, w, 'B2'],
    [xr + PILLAR_C + 7, w, 'Cs'],
    [xr + PILLAR_C, w, 'C'],
    ...arc(xr + PILLAR_C, w - PILLAR_C, PILLAR_C, Math.PI / 2, Math.PI, kC, 'C'),
    [xr, w - PILLAR_C, 'C'],
    [xr, w - PILLAR_C - 4, 'RG'],
    [xr, STRIPE_OUT, 'R13'],
    [xr, STRIPE_IN, 'R7'],
  ];
  const at = (l: string): number => (l === 'RG' || l === 'R13' || l === 'R7' ? yRear : y);
  const out: RP[] = half.map(([px, pz, l]) => ({ p: [px, at(l), pz], l }));
  for (let i = half.length - 1; i >= 0; i--) out.push({ p: [half[i][0], at(half[i][2]), -half[i][1]], l: half[i][2] });
  return out;
}

function glasshouse(k: BodyKit, stripe: Surface): void {
  const hi = k.hi;
  const levels: GlassLevel[] = [
    { y: -0.6, yRear: -0.6, xf: 21.4, xr: -54.4, w: 31.4 }, // inside the tub
    { y: 3.6, yRear: 6.6, xf: 20.0, xr: -54.0, w: 31.0 }, // belt: the glass starts
    { y: 14.2, yRear: 14.2, xf: 10.6, xr: -48.0, w: 27.6 }, // the glass ends
    { y: 15.6, yRear: 15.6, xf: 7.6, xr: -45.6, w: 25.2 }, // the roof
  ];
  const kA = hi ? 2 : 1;
  const kC = hi ? 3 : 1;
  const glass = k.glass;
  // band 0: the belt and the tailgate (paint); band 1: the windows and pillars; band 2: the
  // roof's edge, striped.
  const pick: SweepPick = (band, a, b) => {
    if (band === 2) return seg(a, b, 'F7', 'F13') || seg(a, b, 'R7', 'R13') ? stripe : k.paint;
    if (band !== 1) return k.paint;
    // The screen and the rear glass between the pillars.
    if (seg(a, b, 'F7', 'F7') || seg(a, b, 'F7', 'F13') || seg(a, b, 'F13', 'FA')) return glass;
    if (seg(a, b, 'R7', 'R7') || seg(a, b, 'R7', 'R13') || seg(a, b, 'R13', 'RG')) return glass;
    // The door window, the blacked-out B-pillar, the quarter window.
    if (seg(a, b, 'S', 'B1') || seg(a, b, 'B2', 'Cs')) return glass;
    if (seg(a, b, 'B1', 'B2')) return BLACK;
    return k.paint;
  };
  // The roof is the last cap: its fan meets behind the scoop, on the chevrons (LiverySpec).
  const roof = levels[levels.length - 1];
  sweep(k, levels.map((l) => glassRing(l, kA, kC)), pick, [-25, roof.y, 0]);
  // A rear wiper parked across the bottom of the hatch glass.
  const wiper = new THREE.BoxGeometry(0.45, 0.45, 11);
  wiper.rotateX(0.12);
  wiper.translate(-53.75, 7.3, -3.0);
  k.push(wiper, BLACK);
}

// ---- roof scoop, roof stripes, wing ----------------------------------------------------------

function roof(k: BodyKit, stripe: Surface): void {
  const roofY = 15.6;
  // The stripes over the flat roof: thin panels, proud of it (no depth fight).
  for (const side of [-1, 1]) k.box(stripe, 52.4, 0.16, STRIPE_OUT - STRIPE_IN, -19.0, roofY + 0.08, side * (STRIPE_IN + STRIPE_OUT) * 0.5);
  // The scoop between the stripes: a low rounded hump, its mouth (the front cap) black.
  const ring = (x: number, w: number, top: number): RP[] =>
    ringX(x, [0, roofY - 0.6, 'b'], [
      [w, roofY - 0.6, 'b'],
      [w * 0.93, top - 0.75, 's'],
      [w * 0.72, top, 's'],
      [w * 0.3, top + 0.05, 's'],
    ], null);
  const rings = k.hi
    ? [ring(2.9, 6.3, 17.6), ring(1.9, 6.1, 17.5), ring(-7.0, 5.3, 16.7), ring(-15.5, 4.0, 15.75)]
    : [ring(2.9, 6.3, 17.6), ring(1.9, 6.1, 17.5), ring(-15.5, 4.0, 15.75)];
  sweep(k, rings, (band) => (band === -1 ? BLACK : k.paint));
}

function wing(k: BodyKit, stripe: Surface): void {
  // An airfoil across the car over the hatch, its leading edge on the roof, the trailing edge raised.
  const foil: readonly (readonly [number, number])[] = [
    [-43.4, 15.7],
    [-44.6, 16.55],
    [-50.5, 17.35],
    [-57.9, 17.72],
    [-57.9, 17.18],
    [-50.5, 16.45],
    [-44.8, 15.3],
  ];
  const zs = [-29, -STRIPE_OUT, -STRIPE_IN, STRIPE_IN, STRIPE_OUT, 29];
  const rings = zs.map((z) => foil.map(([x, y]) => ({ p: [x, y, z] as const, l: 'w' })));
  sweep(k, rings, (band) => (band === 1 || band === 3 ? stripe : k.paint));
  // Black side plates under the wing's ends.
  for (const side of [-1, 1]) {
    k.fin(BLACK, [
      [-45.6, 15.9],
      [-57.9, 17.7],
      [-57.9, 14.2],
      [-51.0, 12.4],
    ], 0.9, 'xy', side * 28.6);
  }
}

// ---- box flares, sills, mud flaps, doors -------------------------------------------------------

/**
 * A bolted-on box flare over wheel `w` on side `side`: a square-cut arch band (an extruded
 * polygon with chamfered edges) clear of the tyre, cut at the nose or the tail where it would leave
 * the hitbox, the faces round the opening black (the wheel-well liner); bolt heads along it on high
 * detail.
 */
function flare(k: BodyKit, w: WheelAt, side: number): void {
  const lim = k.hl - 0.25;
  const r = w.radius;
  const bottom = -k.hh + 0.25 - w.y; // relative to the wheel centre
  const ring: [number, number][] = [
    [-(r + 6.5), bottom],
    [-(r + 6.5), r + 0.8],
    [-(r + 2.5), r + 5.9],
    [r + 2.5, r + 5.9],
    [r + 6.5, r + 0.8],
    [r + 6.5, bottom],
    [r + 1.8, bottom],
    [r - 0.4, r - 2.0],
    [8.1, r + 1.9],
    [-8.1, r + 1.9],
    [-(r - 0.4), r - 2.0],
    [-(r + 1.8), bottom],
  ];
  const clipped = clipX(
    ring.map(([u, v]) => [w.x + u, w.y + v] as const),
    -lim,
    lim,
  );
  const shape = new THREE.Shape(clipped.map(([x, y]) => new THREE.Vector2(x, y)));
  const zIn = 30.4;
  const zOut = k.hw - 0.25;
  const bevel = 0.8;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: zOut - zIn - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 1,
    curveSegments: 1,
  });
  // The extrusion runs along +z from -bevel to depth + bevel: the band zIn..zOut on either side.
  g.translate(0, 0, side > 0 ? zIn + bevel : -zOut + bevel);
  const cx = w.x;
  const cy = w.y;
  k.pushBy(g, (x, y, _z, nx, ny, nz) => {
    // Faces round the opening look at the wheel centre.
    const dx = cx - x;
    const dy = cy - y;
    const d = Math.hypot(dx, dy) || 1;
    return Math.abs(nz) < 0.5 && (nx * dx + ny * dy) / d > 0.35 && d < r + 4.5 ? BLACK : k.paint;
  });
  if (!k.hi) return;
  // Bolt heads along the band over the arch.
  for (const [u, v] of [
    [-(r + 0.6), r + 2.4],
    [-7.5, r + 4.0],
    [7.5, r + 4.0],
    [r + 0.6, r + 2.4],
  ]) {
    const x = w.x + u;
    if (Math.abs(x) > lim - 1.5) continue;
    k.box(GAP, 0.9, 0.9, 0.3, x, w.y + v, side * (zOut - 0.05));
  }
}

/** Clip a closed polygon (x, y) to lo <= x <= hi (Sutherland-Hodgman, two planes). */
function clipX(poly: readonly (readonly [number, number])[], lo: number, hi: number): [number, number][] {
  const clip = (pts: readonly (readonly [number, number])[], inside: (x: number) => boolean, at: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ina = inside(a[0]);
      const inb = inside(b[0]);
      if (ina) out.push([a[0], a[1]]);
      if (ina !== inb) {
        const t = (at - a[0]) / (b[0] - a[0]);
        out.push([at, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  };
  return clip(clip(poly, (x) => x >= lo, lo), (x) => x <= hi, hi);
}

function sills(k: BodyKit): void {
  const front = k.wheels.front;
  const back = k.wheels.back;
  const x0 = front.x - front.radius - 5.6;
  const x1 = back.x + back.radius + 5.9;
  const y0 = -k.hh + 0.25;
  for (const side of [-1, 1]) {
    const ring = (x: number, out: number): RP[] =>
      [
        [31.6, y0],
        [out - 0.8, y0],
        [out, y0 + 0.8],
        [out, y0 + 4.6],
        [out - 0.8, y0 + 5.4],
        [31.6, y0 + 5.4],
      ].map(([z, y]) => ({ p: [x, y, side * z] as const, l: 's' }));
    sweep(k, k.hi ? [ring(x0, 37.9), ring(x0 - 0.8, 38.8), ring(x1 + 0.8, 38.8), ring(x1, 37.9)] : [ring(x0, 38.8), ring(x1, 38.8)], () => k.paint);
  }
}

function mudFlaps(k: BodyKit): void {
  const front = k.wheels.front;
  const x = front.x - front.radius + 0.35;
  const zc = (front.zIn + front.zOut) * 0.5 + 0.6;
  for (const side of [-1, 1]) {
    // Black rubber, its face to the wheel yellow under a black top band.
    k.box(RUBBER, 0.7, 9.0, 16.6, x, -12.9, side * zc);
    k.box(YELLOW, 0.25, 6.2, 14.6, x + 0.45, -14.0, side * zc);
  }
}

/** Door shut lines and handles, and the white number plate with a black "7" on each door. */
function doors(k: BodyKit): void {
  const plate: [number, number][] = [
    [-8.6, -10.6],
    [5.0, -10.6],
    [6.0, -9.6],
    [6.0, -2.4],
    [5.0, -1.4],
    [-8.6, -1.4],
    [-9.6, -2.4],
    [-9.6, -9.6],
  ];
  const cx = -1.8;
  for (const side of [-1, 1]) {
    for (const x of [14.3, B_PILLAR_X - 1.5]) k.box(GAP, 0.24, 10.6, 0.3, x, -6.5, side * 33.62);
    if (k.hi) k.box(BLACK, 3.0, 0.7, 0.5, -12.4, -0.6, side * 33.7);
    k.fin(PLATE, plate, 0.7, 'xy', side * 33.75);
    // A "7", read the right way round from either side (+x is to the right seen from +z).
    k.box(BLACK, 5.2, 1.3, 0.3, cx, -3.15, side * 34.2);
    const stroke = new THREE.BoxGeometry(1.4, 6.6, 0.3);
    stroke.rotateZ(side * -0.38);
    stroke.translate(cx + side * 0.9, -6.4, side * 34.2);
    k.push(stroke, BLACK);
  }
}

// ---- front: bumper, nose lamps, light pod, mirrors -----------------------------------------------

function nose(k: BodyKit): void {
  const hl = k.hl;
  // Black front bumper across the nose, a red tow strap on it, an alloy sump guard under it.
  bar(k, BLACK, 52.8, hl - 0.35, -16.6, -10.2, -34.2, 34.2);
  k.box(STRAP, 0.7, 4.6, 2.4, hl - 0.38, -13.4, 22.4);
  k.box(ALLOY, 17, 0.9, 36, 48.5, -k.hh + 0.7, 0);
  // Square headlights and a black grille on the nose face.
  for (const side of [-1, 1]) k.box(HEADLIGHT, 0.7, 3.9, 8.6, 58.25, -6.85, side * 20.8);
  k.box(BLACK, 0.6, 3.2, 28.6, 58.2, -7.0, 0);
}

function lightPod(k: BodyKit): void {
  const hi = k.hi;
  // The pod: a team-painted housing on the bonnet carrying four big round lamps.
  const sec = (x: number, w: number, y0: number, y1: number): RP[] =>
    ringX(x, [0, y0, 'p'], [
      [w, y0, 'p'],
      [w, y1 - 1.6, 'p'],
      [w - 1.2, y1 - 0.4, 'p'],
      [w - 3.0, y1, 'p'],
    ], [0, y1, 'p']);
  const rings = hi
    ? [sec(47.2, 19.6, -2.6, 5.0), sec(48.0, 20.4, -2.6, 5.8), sec(52.0, 20.4, -2.6, 5.8), sec(52.6, 19.8, -2.2, 5.2)]
    : [sec(47.4, 19.8, -2.6, 5.2), sec(52.0, 20.4, -2.6, 5.8), sec(52.6, 19.8, -2.2, 5.2)];
  sweep(k, rings, () => k.paint);
  const segs = hi ? 16 : 10;
  for (const z of [-14.55, -4.85, 4.85, 14.55]) {
    const can = new THREE.CylinderGeometry(3.55, 3.3, 3.6, segs, 1, false);
    can.rotateZ(-Math.PI / 2); // axis along x, the top cap (the lens) forward
    can.translate(52.6, 1.8, z);
    k.pushBy(can, (_x, _y, _z, nx) => (nx > 0.7 ? POD_LAMP : ALLOY));
  }
}

function mirrors(k: BodyKit): void {
  for (const side of [-1, 1]) {
    k.box(BLACK, 1.2, 1.0, 3.0, 15.4, 5.3, side * 31.0);
    const head = new THREE.BoxGeometry(3.2, 3.0, 5.0);
    head.translate(15.2, 6.0, side * 34.4);
    k.pushBy(head, (_x, _y, _z, nx) => (nx < -0.7 ? MIRROR : k.paint));
  }
}

// ---- tail: notched bumper, thrusters, lights -----------------------------------------------

function tail(k: BodyKit): void {
  const hi = k.hi;
  const { x: nx, y: ny, z: nz } = k.nozzle;
  const back = -k.hl + 0.35;
  const pipeR = 4.6;
  // The black rear bumper between the tyres, notched where the thrusters pass through it: a low
  // bar under the pipes, three blocks standing up between and beside them.
  bar(k, BLACK, back, -54.0, -17.0, ny - pipeR - 1.0, -21.0, 21.0);
  const top = ny - 1.4;
  const blocks: [number, number][] = [
    [-2.6, 2.6],
    [nz + pipeR + 0.8, 20.6],
    [-20.6, -(nz + pipeR + 0.8)],
  ];
  for (const [z0, z1] of blocks) {
    // Set 0.2 uu forward of the bar's face: no coplanar faces.
    const b0 = back + 0.2;
    if (hi) bar(k, BLACK, b0, -54.0, ny - pipeR - 2.0, top, z0, z1);
    else k.box(BLACK, -54.0 - b0, top - (ny - pipeR - 2.0), z1 - z0, (b0 - 54.0) * 0.5, (top + ny - pipeR - 2.0) * 0.5, (z0 + z1) * 0.5);
  }
  k.box(STRAP, 0.7, 4.4, 2.4, -k.hl + 0.38, -13.0, -17.0);
  // Twin thrusters: a heat-tinted housing, a dark throat with a hot core glowing in it, an alloy
  // lip round the exit.
  for (const side of [-1, 1]) {
    const z = side * nz;
    const housing = new THREE.CylinderGeometry(4.2, pipeR, 7, hi ? 16 : 8, 1, false);
    housing.rotateZ(Math.PI / 2);
    housing.translate(nx + 3.5, ny, z);
    k.pushBy(housing, (_x, _y, _z, nX) => (nX < -0.7 ? DISC : EXHAUST));
    // The core stands 0.25 uu proud of the dark throat (no depth fight with it).
    const core = new THREE.CylinderGeometry(2.5, 2.5, 0.4, hi ? 12 : 8, 1, false);
    core.rotateZ(Math.PI / 2);
    core.translate(nx - 0.05, ny, z);
    k.push(core, THROAT);
    if (hi) {
      const lip = new THREE.TorusGeometry(4.5, 0.5, 4, 16);
      lip.rotateY(Math.PI / 2);
      lip.translate(nx + 0.45, ny, z);
      k.push(lip, ALLOY);
    }
  }
  // Tail lights on the tail's upper corners: red outboard, amber indicators inboard.
  for (const side of [-1, 1]) {
    k.box(TAILLIGHT, 1.0, 3.8, 7.0, -55.7, 0.0, side * 25.7);
    k.box(INDICATOR, 1.0, 3.8, 1.8, -55.7, 0.0, side * 21.3);
  }
}

function build(k: BodyKit): void {
  const stripe: Surface = { ...k.paint, color: ACCENT };
  tub(k, stripe);
  glasshouse(k, stripe);
  roof(k, stripe);
  wing(k, stripe);
  for (const w of [k.wheels.front, k.wheels.back]) for (const side of [-1, 1]) flare(k, w, side);
  sills(k);
  mudFlaps(k);
  doors(k);
  nose(k);
  lightPod(k);
  mirrors(k);
  tail(k);
}

export const TERO: CarBodySpec = {
  id: 'tero',
  build,
  // The same tyre size (16 uu) front and rear, narrow gravel tyres tucked under the flares.
  wheels: { style: TERO_WHEEL, visual: 1.28, outer: 38, width: 0.85, rear: { visual: 16 / 15 } },
  livery: {
    // Team paint over gloss carbon sills, the line just over the sills' tops (car-local uu).
    twoToneY: 8.8,
    pinstripe: 0.4,
    // Yellow arrows on the roof between the stripes, behind the scoop: what the chase camera sees.
    // Three whole chevrons: 0.9 halfWidth + 0.36 period < period leaves a gap between them for
    // the cuts at x0 and x1 (the arrows' tips are at period k + 3.06).
    chevrons: { x0: -30.8, x1: -5.3, halfWidth: 5.8, period: 8.5 },
    // The bonnet's shut lines: its rear edge at the cowl, its front edge ahead of the lamp pod.
    seams: { x: [35.6, 69.6], maxZ: 30 },
    accent: ACCENT,
    chevronTint: 1,
    grime: { y0: 11, y1: 3, amount: 0.6 },
    ao: { y0: 2, y1: 14 },
    heat: { x: BOOST_NOZZLE_X, length: 7 },
  },
  budget: { low: 2000, high: 3500 },
};

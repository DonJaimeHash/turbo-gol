/**
 * The Tero ('tero', the southern lapwing: small, loud, territorial): a compact retro rally
 * hatchback. A short two-box body with a tall glasshouse (raked screen under a white sun strip,
 * blacked-out B-pillar, thick C-pillars, a painted tailgate under a small rear glass) and a crowned
 * roof, flanks bowed out a little at the doors, square-cut bolted-on box flares over all four wheels
 * (a lip that drops over each tyre's shoulder, rounded outer edges) joined by black sills, white mud
 * flaps behind the front wheels, a boxy roof scoop over the screen header with a black crest blade
 * behind it (the lapwing's), a roof wing standing on two pylons between black end plates, a
 * four-lamp pod on the bonnet (selective yellow lenses set back in black bezels, in red cans: the
 * bird's red eye), square headlights in a black band across the nose (its black breast), a black
 * front bumper with a tow strap and an alloy skid plate, wedge door mirrors on painted arms, a white
 * number plate with a black "7" on each door. At the rear: thin red lights standing on the
 * tailgate's corners (amber indicator cells at their feet), one chamfered black bumper beam across
 * the tail with the twin thrusters standing out of it (thick dark gunmetal housings, an alloy lip,
 * a deep black throat narrowing to a small dim core), an alloy diffuser with black strakes and a tow
 * strap under it between the rear tyres.
 * Rally livery: twin stripes in the accent yellow over the bonnet, the roof, the wing and down the
 * tailgate, two big yellow chevrons on the roof between them (what the chase camera sees), team
 * paint above a yellow pinstripe and gloss carbon below it. Wheels: knobby gravel tyres on white
 * six-spoke rims with a white outer lip and a team hub, the same size front and rear (14.25 uu).
 *
 * Designed on the default hitbox in the build frame (kit.hl / hh / hw 58.75 / 17.83 / 41.85;
 * docs/cars.md "Two frames"). The tub, the glasshouse and the roof are swept from explicit profiles
 * (sweep, below) rather than kit.loft's superellipses, so the stripe edges, pillars and window
 * edges sit on exact columns: every surface change follows a triangle edge and the stripes cost no
 * triangle; the flares are slabs (slab, below) through a concave outline. Everything stays inside
 * the hitbox: the roof's edge sits at 15 so the scoop, the crest and the wing's air gap fit under
 * its top (17.83), the rear tyres stand past the tail (the axle is the sim's), so the rear bumper
 * sits between them and the mud flaps hang behind the front wheels only, inside a deeper opening
 * (the body's floor is the hitbox's: no flap and no flare can hang below it). The thrusters' throats
 * are 3 uu deep, so the tub's tail and the beam's face stand ahead of their floors.
 */
import * as THREE from 'three/webgpu';
import { BOOST_NOZZLE_X, CAGE, CAR_KIND, DISC, EXHAUST, HEADLIGHT, TAILLIGHT, TRIM } from './kit';
import type { BodyKit, CarBodySpec, Surface, WheelAt, WheelStyle } from './types';

/** Rally yellow: the stripes, the pinstripe and the chevrons (LiverySpec.accent). */
const ACCENT = 0xffc21a;

/** Knobby gravel tyres on white six-spoke rally rims over a dark dish, a white outer lip, a team hub cap. */
export const TERO_WHEEL: WheelStyle = {
  id: 'tero-rally-6',
  tyre: 'knobby',
  spokes: 6,
  spokeWidth: 0.24,
  dish: 0.32,
  dishColor: DISC.color,
  rim: 0xe6e8ec,
  rimFinish: { metal: 0.3, rough: 0.36 },
  // The rim's outer lip: the bead ring in the rim's white, without bolts (the spokes end on it).
  bead: 0xe6e8ec,
  bolts: 0,
  hub: 'team',
  budget: { low: 440, high: 640 },
};

// ---- surfaces (vertex data only: kinds the shared material already has) --------------------

/** Satin black plastic: bumpers, sills, B-pillar, wing underside and plates, crest, liners, trim. */
const BLACK: Surface = { ...TRIM, color: 0x15171b, rough: 0.6 };
/** White trim: number plates, the sun strip, the mud flaps. */
const WHITE: Surface = { ...TRIM, color: 0xf1f1ec, metal: 0, rough: 0.42 };
/** Tow straps: the lapwing's red spur. */
const STRAP: Surface = { ...TRIM, color: 0xff4a1c, metal: 0, rough: 0.7 };
/** The pod's lamp lenses: selective yellow, deep enough to stay yellow through the bloom and the tone map. */
const POD_LAMP: Surface = { ...HEADLIGHT, color: 0xffb300, emissive: 1.1 };
/** The pod's lamp cans: red, the lapwing's eye ring. */
const POD_CAN: Surface = { ...TRIM, color: 0x9e1a14, metal: 0.4, rough: 0.4 };
/** Tail lights: a deep saturated red at a low emission, so neither the bloom nor the flat tone map (low tiers) turns them orange. */
const TAIL: Surface = { ...TAILLIGHT, color: 0xd0101c, emissive: 0.8 };
/** Amber indicator cells at the foot of the tail lights. */
const INDICATOR: Surface = { ...TAILLIGHT, color: 0xff7a00, emissive: 0.9 };
/** The thrusters' housings: dark gunmetal under the heat tint (EXHAUST multiplies its colour). */
const HOUSING: Surface = { ...EXHAUST, color: 0x4f5660, metal: 0.85, rough: 0.3 };
/** The housings' exit face on low detail (no alloy lip there). */
const HOUSING_FACE: Surface = { ...HOUSING, color: 0x9aa1aa };
/** The thrusters' throats: near black, no emission. */
const THROAT: Surface = { ...DISC, color: 0x0c0d10, rough: 0.6 };
/** The thrusters' cores: a small dim glow at the throat's floor (40% of its mouth), well under a lamp's. */
const CORE: Surface = { ...HEADLIGHT, color: 0xffb64a, emissive: 0.6 };
/** Mirror glass (the door mirrors' back faces). */
const MIRROR: Surface = { color: 0xc9ced6, metal: 1, rough: 0.12, emissive: 0, kind: CAR_KIND.CHROME };
/** Panel gaps. */
const GAP: Surface = { ...DISC, color: 0x0b0c0f, rough: 0.7 };
/** Satin alloy: skid plate, exhaust lips, bolt heads, bonnet pins. */
const ALLOY = CAGE;
/** The rear diffuser: a darker satin alloy, so the tail's lower half does not outshine its paint. */
const DIFFUSER: Surface = { ...CAGE, color: 0x8c939d };
/** The glass, a lighter tint than the stock canopy's (a large flat screen reads as a hole), per team. */
const TERO_GLASS: readonly [number, number] = [0x172b44, 0x36141c];

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
  pushGroups(k, groups);
}

/** One non-indexed part per surface (position, normal; kit.push bakes the surface). */
function pushGroups(k: BodyKit, groups: ReadonlyMap<Surface, { readonly p: number[]; readonly n: number[] }>): void {
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

/** A circle of `n` points of radius r round the x axis through (y, z), at station x. */
function circle(x: number, y: number, z: number, r: number, n: number, l: string): RP[] {
  return Array.from({ length: n }, (_, i): RP => {
    const a = (i * Math.PI * 2) / n;
    return { p: [x, y + r * Math.cos(a), z + r * Math.sin(a)], l };
  });
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

// ---- slab: a closed solid through a concave outline -----------------------------------------

/** A slab outline point (x, y, label). */
type SP = readonly [number, number, string];

/** The outline `poly` (counter-clockwise in x, y) moved `d` uu inwards along each corner's mitre. */
function inset(poly: readonly SP[], d: number): SP[] {
  const n = poly.length;
  const unit = (x: number, y: number): [number, number] => {
    const l = Math.hypot(x, y);
    return [x / l, y / l];
  };
  return poly.map((p, i): SP => {
    const a = poly[(i + n - 1) % n];
    const b = poly[(i + 1) % n];
    // The outward normals (the right-hand side of a counter-clockwise outline) of the two edges.
    const n1 = unit(p[1] - a[1], a[0] - p[0]);
    const n2 = unit(b[1] - p[1], p[0] - b[0]);
    const m = d / (1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [p[0] - (n1[0] + n2[0]) * m, p[1] - (n1[1] + n2[1]) * m, p[2]];
  });
}

/**
 * A closed solid through `layers` along +z (each the same outline point for point, counter-
 * clockwise in x, y, at its own z), mirrored to -z when `side` < 0: the walls between consecutive
 * layers and a flat cap on the first and the last layer (triangulated, so the outline may be
 * concave). The walls are flat round the outline (a square-cut corner stays sharp) and smooth along
 * z where two bands meet at under 60 degrees, rolling into the last cap the same way (a chamfer
 * reads as a round edge). `pick(a, b, band)` gives the surface of the wall between the outline
 * points labelled a and b in band `band` (layers band..band + 1); the caps are `cap`.
 */
function slab(k: BodyKit, layers: readonly { readonly z: number; readonly poly: readonly SP[] }[], pick: (a: string, b: string, band: number) => Surface, cap: Surface, side: number): void {
  const n = layers[0].poly.length;
  const groups = new Map<Surface, { p: number[]; n: number[] }>();
  const emit = (s: Surface, v: readonly THREE.Vector3[], nn: readonly THREE.Vector3[]): void => {
    let grp = groups.get(s);
    if (grp === undefined) {
      grp = { p: [], n: [] };
      groups.set(s, grp);
    }
    // Mirroring to -z flips the winding: swap two corners.
    for (const t of side > 0 ? [0, 1, 2] : [0, 2, 1]) {
      grp.p.push(v[t].x, v[t].y, side * v[t].z);
      grp.n.push(nn[t].x, nn[t].y, side * nn[t].z);
    }
  };
  const P = (i: number, j: number): THREE.Vector3 => new THREE.Vector3(layers[i].poly[j][0], layers[i].poly[j][1], layers[i].z);
  // The outward normal of the wall quad on edge j (point j to j + 1) in band i: across its diagonals.
  const faceN = (i: number, j: number): THREE.Vector3 => {
    const j1 = (j + 1) % n;
    const d1 = P(i + 1, j1).sub(P(i, j));
    const d2 = P(i + 1, j).sub(P(i, j1));
    return d1.cross(d2).normalize();
  };
  const zAxis = new THREE.Vector3(0, 0, 1);
  const blend = (f: THREE.Vector3, o: THREE.Vector3 | null): THREE.Vector3 => (o !== null && f.dot(o) > 0.5 ? f.clone().add(o).normalize() : f);
  for (let i = 0; i + 1 < layers.length; i++) {
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      const f = faceN(i, j);
      const lo = blend(f, i > 0 ? faceN(i - 1, j) : null);
      const hi = blend(f, i + 2 < layers.length ? faceN(i + 1, j) : zAxis);
      const s = pick(layers[0].poly[j][2], layers[0].poly[j1][2], i);
      emit(s, [P(i, j), P(i, j1), P(i + 1, j)], [lo, lo, hi]);
      emit(s, [P(i, j1), P(i + 1, j1), P(i + 1, j)], [lo, hi, hi]);
    }
  }
  const capOf = (i: number, facing: number): void => {
    const pts = layers[i].poly.map((q) => new THREE.Vector2(q[0], q[1]));
    const nn = new THREE.Vector3(0, 0, facing);
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(pts, [])) {
      const A = P(i, a);
      const B = P(i, b);
      const C = P(i, c);
      const cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
      emit(cap, cross * facing > 0 ? [A, B, C] : [A, C, B], [nn, nn, nn]);
    }
  };
  capOf(0, -1);
  capOf(layers.length - 1, 1);
  pushGroups(k, groups);
}

// ---- the tub: bonnet, flanks, wheel wells, tail ----------------------------------------------

/** Stripe columns (|z|, build frame) shared by the bonnet, the roof, the roof's edges, the tailgate and the wing. */
const STRIPE_IN = 7.5;
const STRIPE_OUT = 13;
/** How far the flanks bow out at mid-height (high detail): the doors catch a soft highlight. */
const BOW = 0.35;

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
 * the tyre), a flank bowed out at mid-height (high detail), a slight tumblehome to a rounded top
 * corner, and a crowned top with the stripe columns. Low detail cuts the bottom corner square
 * (three points instead of six), keeps the flank flat and drops a point of the top corner and a
 * column of the top.
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
  // The flank rises to `side` (bowed out half way up), then leans in (tumblehome) to the rounded top corner.
  const side = Math.max(yt - 3.4, (low[n - 1][1] + shoulder) * 0.5);
  const half: PP[] = [
    ...low,
    ...(hi ? [[w + BOW, (low[n - 1][1] + side) * 0.5, 'bow'] as PP] : []),
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

/** The tub's tail face (build x): ahead of the thrusters' throat floors (k.nozzle.x + THROAT_DEPTH), which it would show through. */
const TUB_TAIL = -54.6;

function tub(k: BodyKit, stripe: Surface): void {
  const { hi } = k;
  const front = k.wheels.front;
  const back = k.wheels.back;
  // The wells: a stem inside the tyres, a ceiling 1.75 uu over them, open 1.1 uu clear of each
  // tyre where it meets the tub's bottom. The front well's stem stands 3 uu further in and its
  // opening 1.6 uu longer: room for the steered tyre's corners.
  const wellF = { stem: front.zIn - 4.7, ceil: front.y + front.radius + 1.75 };
  const wellR = { stem: back.zIn - 1.7, ceil: back.y + back.radius + 1.75 };
  const yb = -k.hh + 0.25;
  const reachF = Math.sqrt(Math.max(0, front.radius ** 2 - (yb - front.y) ** 2)) + 2.7;
  const reachR = Math.sqrt(Math.max(0, back.radius ** 2 - (yb - back.y) ** 2)) + 1.1;
  const cowl = front.x - reachF - 1.0;
  // The bonnet falls 5.6 uu from the cowl to the nose: a slight wedge under the lamp pod.
  const stations: TubStation[] = [
    { x: 58.0, w: 29.2, yb: -15.0, yt: -4.6, well: null },
    ...(hi ? [{ x: 57.3, w: 31.2, yb: -16.0, yt: -3.8, well: null }] : []),
    { x: 56.0, w: 32.3, yb: -16.8, yt: -3.0, well: null },
    { x: front.x + reachF + 0.9, w: 32.8, yb: -17.2, yt: -2.1, well: null },
    { x: front.x + reachF, w: 32.9, yb: -17.2, yt: -1.8, well: wellF },
    ...(hi ? [{ x: 40, w: 33.4, yb, yt: -0.5, well: wellF }] : []),
    { x: front.x - reachF, w: 33.6, yb, yt: 1.0, well: wellF },
    { x: cowl, w: 33.6, yb, yt: 1.05, well: null },
    { x: back.x + reachR + 1.0, w: 33.6, yb, yt: 2.4, well: null },
    { x: back.x + reachR, w: 33.6, yb, yt: 2.4, well: wellR },
    ...(hi
      ? [
          { x: -51.6, w: 33.4, yb, yt: 2.9, well: wellR },
          { x: TUB_TAIL + 0.7, w: 33.0, yb, yt: 2.9, well: wellR },
        ]
      : []),
    { x: TUB_TAIL, w: 32.0, yb: yb + 0.8, yt: 2.2, well: { stem: wellR.stem - 0.6, ceil: wellR.ceil + 0.4 } },
  ];
  // Stripes on the bonnet (ahead of the cowl) and on the ledge behind the tailgate; team paint
  // everywhere else.
  sweep(
    k,
    stations.map((s) => tubRing(s, hi)),
    (band, a, b) => (band >= 0 && seg(a, b, 's13', 's7') && (stations[band + 1].x >= cowl - 1e-6 || stations[band].x <= -51.5) ? stripe : k.paint),
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
/** The roof's edge: 3.1 uu under the hitbox's top for the crown, the scoop, the crest and the wing. */
const ROOF_Y = 14.7;

/**
 * The glasshouse's levels: inside the tub, the belt (the side and screen glass start there, the
 * rear glass higher up over a painted tailgate), the glass's top, the roof's edge.
 */
const GLASS_LEVELS: readonly GlassLevel[] = [
  { y: -0.6, yRear: -0.6, xf: 21.4, xr: -54.4, w: 31.4 },
  { y: 3.6, yRear: 8.0, xf: 20.0, xr: -54.0, w: 31.0 },
  { y: 13.6, yRear: 13.6, xf: 11.0, xr: -48.6, w: 27.7 },
  { y: ROOF_Y, yRear: ROOF_Y, xf: 8.2, xr: -46.2, w: 25.3 },
];

/**
 * The glasshouse's ring at one level (a rounded rectangle in plan, labelled round its edge): the
 * screen face with the stripe columns, the A-pillar arc, the side with the B-pillar's two edges and
 * the quarter window's end, the C-pillar arc, the hatch face with the rear glass's edge and the
 * stripe columns. The hatch face's points and the C-pillar's rear corner sit at their own height
 * (the glass starts higher there: a painted tailgate under it).
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
  // The C-pillar's rear corner rises with the tailgate: the hatch face is flat up to the glass.
  const at = (l: string): number => (l === 'C' || l === 'RG' || l === 'R13' || l === 'R7' ? yRear : y);
  const out: RP[] = half.map(([px, pz, l]) => ({ p: [px, at(l), pz], l }));
  for (let i = half.length - 1; i >= 0; i--) out.push({ p: [half[i][0], at(half[i][2]), -half[i][1]], l: half[i][2] });
  return out;
}

/**
 * A point on the windscreen (the belt level to the glass's top level, flat across z) at height y,
 * `off` uu out along its normal, and the screen glass's half width there.
 */
function onScreen(y: number, off: number): { x: number; y: number; hw: number; ang: number } {
  const [, l1, l2] = GLASS_LEVELS;
  const t = (y - l1.y) / (l2.y - l1.y);
  const dx = l2.xf - l1.xf;
  const dy = l2.y - l1.y;
  const len = Math.hypot(dx, dy);
  const nx = dy / len;
  const ny = -dx / len;
  return { x: l1.xf + dx * t + nx * off, y: y + ny * off, hw: l1.w + (l2.w - l1.w) * t - PILLAR_A, ang: Math.atan2(ny, nx) };
}

function glasshouse(k: BodyKit, stripe: Surface): void {
  const hi = k.hi;
  const kA = hi ? 2 : 1;
  const kC = hi ? 3 : 1;
  const glass: Surface = { ...k.glass, color: TERO_GLASS[k.team] };
  // band 0: the belt and the tailgate (paint, the stripes down the tailgate); band 1: the windows
  // and pillars; band 2: the roof's edge, striped.
  const pick: SweepPick = (band, a, b) => {
    if (band === 0) return seg(a, b, 'R7', 'R13') ? stripe : k.paint;
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
  // The flat top is the last cap, hidden under the crowned roof panel (roofPanel).
  sweep(k, GLASS_LEVELS.map((l) => glassRing(l, kA, kC)), pick, [-25, ROOF_Y, 0]);
  // A white sun strip over the screen's top fifth, 0.05 uu proud of the glass.
  const strip = (s: number): RP[] =>
    [
      [11.4, 0.05],
      [11.4, 0.25],
      [13.5, 0.25],
      [13.5, 0.05],
    ].map(([y, off]) => {
      const q = onScreen(y, off);
      return { p: [q.x, q.y, s * q.hw] as const, l: 'w' };
    });
  sweep(k, [strip(-1), strip(1)], () => WHITE);
  if (!hi) return;
  // Wipers parked along the screen's foot, and one across the foot of the hatch glass (high detail).
  for (const zc of [-10.5, 7.5]) {
    const q = onScreen(4.7, 0.28);
    const blade = new THREE.BoxGeometry(0.3, 0.5, 13);
    blade.rotateZ(q.ang);
    blade.translate(q.x, q.y, zc);
    k.push(blade, BLACK);
  }
  const [, l1, l2] = GLASS_LEVELS;
  const t = 0.12;
  const wiper = new THREE.BoxGeometry(0.45, 0.45, 11);
  wiper.rotateX(0.12);
  wiper.translate(l1.xr + (l2.xr - l1.xr) * t - 0.25, l1.yRear + (l2.yRear - l1.yRear) * t + 0.2, -3.0);
  k.push(wiper, BLACK);
}

// ---- roof: crowned panel, scoop, crest, wing ----------------------------------------------------

/**
 * The roof: a panel over the glasshouse's flat top, crowned 0.5 uu at the centre line and rolling
 * down to its edge, in the glasshouse's own plan (the pillars' rounded corners), the twin stripes
 * as runs of its columns. Its ends crown less, easing into the screen's header and the hatch's.
 */
function roofPanel(k: BodyKit, stripe: Surface): void {
  const l3 = GLASS_LEVELS[3];
  // The plan's right edge from the A-pillar round to the hatch (x falling), for its half width at any x.
  const ring = glassRing(l3, k.hi ? 2 : 1, k.hi ? 3 : 1);
  const half = ring.slice(0, ring.length / 2);
  const i0 = half.findIndex((q) => q.l === 'FA');
  let i1 = half.length - 1;
  while (half[i1].l !== 'C') i1--;
  const edge = half.slice(i0, i1 + 1).map((q) => [q.p[0], q.p[2]] as const);
  const widthAt = (x: number): number => {
    for (let i = 0; i + 1 < edge.length; i++) {
      const [xa, za] = edge[i];
      const [xb, zb] = edge[i + 1];
      if (x <= xa && x >= xb) return xa === xb ? Math.min(za, zb) : za + ((zb - za) * (x - xa)) / (xb - xa);
    }
    return edge[edge.length - 1][1];
  };
  const stations: readonly (readonly [number, number])[] = k.hi
    ? [
        [l3.xf - 0.15, 0.1],
        [l3.xf - 1.5, 0.36],
        [l3.xf - 4.6, 0.5],
        [l3.xr + 6.6, 0.5],
        [l3.xr + 2.2, 0.34],
        [l3.xr + 0.15, 0.1],
      ]
    : [
        [l3.xf - 0.2, 0.1],
        [l3.xf - 2.6, 0.5],
        [l3.xr + 3.2, 0.5],
        [l3.xr + 0.2, 0.1],
      ];
  // The panel's foot sits inside the glasshouse's top band (0.5 uu wider there).
  const base = ROOF_Y - 0.3;
  const rings = stations.map(([x, crown]) => {
    const W = widthAt(x) - 0.05;
    const e = W - 0.4;
    const y = (z: number): number => ROOF_Y + 0.08 + crown * (1 - (z / e) ** 2);
    return ringX(
      x,
      [0, base, 'b'],
      [
        [W, base, 'b'],
        [e, ROOF_Y + 0.08, 'e'],
        [STRIPE_OUT, y(STRIPE_OUT), 's13'],
        [STRIPE_IN, y(STRIPE_IN), 's7'],
      ],
      [0, y(0), 'tc'],
    );
  });
  sweep(k, rings, (_band, a, b) => (seg(a, b, 's13', 's7') ? stripe : k.paint));
}

function roof(k: BodyKit): void {
  // A boxy scoop between the stripes, its black mouth over the screen's header, its flat top
  // 2.4 uu over the crowned roof back past the screen, then dropping into the roof: it breaks the
  // roofline in profile and reads as a block from the chase camera.
  const ring = (x: number, w: number, top: number, base: number): RP[] =>
    ringX(x, [0, base, 'b'], [
      [w, base, 'b'],
      [w, top - 0.7, 's'],
      [w - 0.8, top, 's'],
      [w * 0.3, top + 0.04, 's'],
    ], null);
  const mouth = ring(9.5, 5.6, 17.55, 13.4);
  const lip = ring(8.7, 5.7, 17.7, 13.9);
  const tail = ring(-9.0, 4.4, ROOF_Y + 0.45, ROOF_Y - 0.6);
  sweep(k, [mouth, lip, ring(-3.0, 5.4, 17.5, ROOF_Y - 0.6), tail], (band) => (band === -1 ? BLACK : k.paint));
  // The crest: a thin black blade rising out of the scoop's tail, swept back to a point.
  k.fin(
    BLACK,
    [
      [-11.0, ROOF_Y - 0.4],
      [-13.6, ROOF_Y + 0.9],
      [-21.6, 17.75],
      [-19.4, ROOF_Y + 0.75],
      [-19.2, ROOF_Y - 0.4],
    ],
    1.1,
    'xy',
    0,
  );
}

function wing(k: BodyKit, stripe: Surface): void {
  // An airfoil across the car behind the roof, its trailing edge raised; an air gap of 1.5 uu and
  // more over the roof's edge and the rear glass. Black underneath.
  const foil: readonly (readonly [number, number, string])[] = [
    [-46.4, 16.4, 'n'],
    [-47.4, 16.95, 't'],
    [-52.2, 17.4, 't'],
    [-58.3, 17.72, 't'],
    [-58.3, 17.0, 'e'],
    [-52.2, 16.35, 'u'],
    [-47.6, 15.95, 'u'],
  ];
  const zs = [-29, -STRIPE_OUT, -STRIPE_IN, STRIPE_IN, STRIPE_OUT, 29];
  const rings = zs.map((z) => foil.map(([x, y, l]) => ({ p: [x, y, z] as const, l })));
  sweep(k, rings, (band, a, b) => (a !== 't' && b !== 't' ? BLACK : band === 1 || band === 3 ? stripe : k.paint));
  for (const side of [-1, 1]) {
    // Two pylons from the roof's edge and the rear glass up into the wing.
    k.fin(
      BLACK,
      [
        [-47.1, 16.3],
        [-51.4, 16.6],
        [-51.4, 10.2],
        [-47.8, 13.4],
      ],
      0.8,
      'xy',
      side * 17.5,
    );
    // Tall, square black end plates.
    k.fin(
      BLACK,
      [
        [-46.9, 17.05],
        [-52.2, 17.55],
        [-58.45, 17.78],
        [-58.45, 13.4],
        [-49.8, 13.4],
        [-47.4, 14.6],
      ],
      0.9,
      'xy',
      side * 28.6,
    );
  }
}

// ---- box flares, sills, mud flaps, doors -------------------------------------------------------

/** How far behind a front tyre (past its radius) its mud flap hangs, and the flap's thickness. */
const FLAP_X = 2.6;
const FLAP_T = 0.8;

/**
 * A bolted-on box flare over wheel `w` on side `side`: a slab from inside the tub (|z| 30.4) out to
 * the hitbox's side, square-cut. Over the tyre its opening clears it (the black wheel-well liner);
 * outside the tyre a painted lip drops over the tyre's shoulder (4.5 uu on the rear, 2.4 on the
 * front, which steers), and on high detail the outer edge rolls round 1.2 uu into the face, where
 * alloy bolt heads sit. The front flare's opening runs further back, round the mud flap; the rear
 * flare ends at the hitbox's tail in a face sloping down and back, capping the tyre that stands
 * past it.
 */
function flare(k: BodyKit, w: WheelAt, side: number, front: boolean): void {
  const r = w.radius;
  const bot = -k.hh + 0.25 - w.y; // the body's floor, from the wheel centre
  const tail = -(k.hl - 0.25) - w.x; // the hitbox's tail, from the wheel centre
  const drop = front ? 2.4 : 4.5;
  const lipTop = r + 1.9 - drop;
  const flapBack = r + FLAP_X + FLAP_T;
  // Counter-clockwise from the front leg's foot: the front leg, the top, the rear leg (or the
  // sloping tail), then the opening from its rear foot round to its front foot: over the tyre
  // (hi) and on the lip (lip).
  const outline: SP[] = front
    ? [
        [r + 6.5, bot, 'o'],
        [r + 6.5, r + 0.8, 'o'],
        [r + 2.5, r + 5.9, 'o'],
        [-(r + 3.6), r + 5.9, 'o'],
        [-(r + 7.6), r + 0.8, 'o'],
        [-(r + 7.6), bot, 'o'],
      ]
    : [
        [r + 6.5, bot, 'o'],
        [r + 6.5, r + 0.8, 'o'],
        [r + 2.5, r + 5.9, 'o'],
        [tail + 3.2, r + 5.9, 'o'],
        [tail, r + 1.0, 'o'],
      ];
  const openHi: SP[] = front
    ? [
        [-(flapBack + 1.6), bot, 'w'],
        [-(flapBack + 0.3), r - 1.0, 'w'],
        [-8.1, r + 1.9, 'w'],
        [8.1, r + 1.9, 'w'],
        [r - 0.4, r - 2.0, 'w'],
        [r + 1.8, bot, 'w'],
      ]
    : [
        [tail, r - 0.6, 'w'],
        [-8.1, r + 1.9, 'w'],
        [8.1, r + 1.9, 'w'],
        [r - 0.4, r - 2.0, 'w'],
        [r + 1.8, bot, 'w'],
      ];
  const openLip: SP[] = front
    ? [
        [-(flapBack + 1.6), bot, 'w'],
        [-(flapBack + 0.3), r - 1.0 - drop * 0.6, 'w'],
        [-7.0, lipTop, 'w'],
        [7.0, lipTop, 'w'],
        [r - 1.0, r - 2.0 - drop * 0.8, 'w'],
        [r + 1.0, bot, 'w'],
      ]
    : [
        [tail, lipTop - 1.2, 'w'],
        [-6.5, lipTop, 'w'],
        [6.5, lipTop, 'w'],
        [r - 2.4, r - 2.0 - drop * 0.8, 'w'],
        [r - 0.4, bot, 'w'],
      ];
  const abs = (pts: readonly SP[]): SP[] => pts.map(([u, v, l]): SP => [w.x + u, w.y + v, l]);
  const polyHi = abs([...outline, ...openHi]);
  const polyLip = abs([...outline, ...openLip]);
  const zIn = 30.4;
  const zTyre = w.zOut + 0.3;
  const zOut = k.hw - 0.25;
  const round = 1.2;
  const layers = k.hi
    ? [
        { z: zIn, poly: polyHi },
        { z: zTyre, poly: polyHi },
        { z: zTyre + 1.1, poly: polyLip },
        { z: zOut, poly: inset(polyLip, round) },
      ]
    : [
        { z: zIn, poly: polyHi },
        { z: zTyre, poly: polyHi },
        { z: zOut, poly: polyLip },
      ];
  // The opening's faces over the tyre are the black liner; the lip is painted all round.
  slab(k, layers, (a, b, band) => (a === 'w' && b === 'w' && band === 0 ? BLACK : k.paint), k.paint, side);
  if (!k.hi) return;
  // Alloy bolt heads along the face over the arch.
  const vB = (lipTop + round + r + 5.9 - round) * 0.5;
  for (const u of front ? [-10, 0, 10] : [-8, 0, 9]) k.box(ALLOY, 0.9, 0.9, 0.3, w.x + u, w.y + vB, side * (zOut - 0.05));
}

/** Black sills between the flares (the flank out to |z| 38.8 where the supersonic streaks leave). */
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
    sweep(k, k.hi ? [ring(x0, 37.9), ring(x0 - 0.8, 38.8), ring(x1 + 0.8, 38.8), ring(x1, 37.9)] : [ring(x0, 38.8), ring(x1, 38.8)], () => BLACK);
  }
}

/**
 * White mud flaps behind the front wheels, as wide as the tyre and flush with the flare, raked back
 * 8 degrees, hanging from inside the arch down to the body's floor.
 */
function mudFlaps(k: BodyKit): void {
  const w = k.wheels.front;
  const r = w.radius;
  const y0 = -k.hh + 0.25;
  const y1 = w.y + r - 0.6;
  const z0 = w.zIn + 0.5;
  const z1 = k.hw - 1.0;
  for (const side of [-1, 1]) {
    const flap = new THREE.BoxGeometry(FLAP_T, y1 - y0, z1 - z0);
    flap.rotateZ(-0.14);
    flap.translate(w.x - r - FLAP_X - FLAP_T * 0.5 - 0.55, (y0 + y1) * 0.5, side * (z0 + z1) * 0.5);
    // White where the wheel and the side look at it, black rubber behind.
    k.pushBy(flap, (_x, _y, _z, nx) => (nx < -0.5 ? BLACK : WHITE));
  }
}

/**
 * Door shut lines following the flank's bow and handles (high detail), and the white number plate
 * with a black "7" on each door, its back on the flank (the bow sinks it a little at mid-height).
 */
function doors(k: BodyKit): void {
  const w = 33.6; // the tub's half width at the doors
  const plate: [number, number][] = [
    [-8.6, -11.2],
    [5.0, -11.2],
    [6.0, -10.2],
    [6.0, -3.4],
    [5.0, -2.4],
    [-8.6, -2.4],
    [-9.6, -3.4],
    [-9.6, -10.2],
  ];
  const cx = -1.8;
  for (const side of [-1, 1]) {
    if (k.hi) {
      // Two segments a line: from the sill up to the bow's crest, and on up to the belt's corner.
      for (const x of [14.0, B_PILLAR_X - 1.5]) {
        for (const [ya, za, yb, zb] of [
          [-12.0, w + 0.1, -7.6, w + BOW],
          [-7.6, w + BOW, -1.4, w - 0.12],
        ]) {
          const len = Math.hypot(yb - ya, zb - za);
          const line = new THREE.BoxGeometry(0.24, len, 0.3);
          line.rotateX(side * Math.atan2(zb - za, yb - ya));
          line.translate(x, (ya + yb) * 0.5, side * (za + zb) * 0.5);
          k.push(line, GAP);
        }
      }
      k.box(BLACK, 3.0, 0.7, 0.5, -12.4, -1.0, side * 33.5);
    }
    k.fin(WHITE, plate, 0.7, 'xy', side * (w + 0.4));
    // A "7", read the right way round from either side (+x is to the right seen from +z).
    k.box(BLACK, 5.2, 1.3, 0.3, cx, -4.0, side * (w + 0.85));
    const stroke = new THREE.BoxGeometry(1.4, 6.0, 0.3);
    stroke.rotateZ(side * -0.38);
    stroke.translate(cx + side * 0.9, -7.55, side * (w + 0.85));
    k.push(stroke, BLACK);
  }
}

// ---- front: bumper, breast band, skid plate, light pod, mirrors -------------------------------

function nose(k: BodyKit): void {
  const hl = k.hl;
  // Black front bumper across the nose, a red tow strap on it.
  bar(k, BLACK, 52.8, hl - 0.35, -15.0, -10.2, -34.2, 34.2);
  k.box(STRAP, 0.7, 4.6, 2.4, hl - 0.38, -12.6, 22.4);
  // An alloy skid plate under the bumper, its front turned up in front of the bumper's foot (a
  // flat plate on low detail).
  if (!k.hi) k.box(ALLOY, hl - 0.2 - 49.5, 0.8, 34, (hl - 0.2 + 49.5) * 0.5, -17.15, 0);
  const skid = (z: number): RP[] =>
    [
      [49.5, -17.55],
      [55.6, -17.55],
      [hl - 0.2, -15.3],
      [hl - 0.2, -14.4],
      [hl - 0.8, -14.4],
      [55.2, -16.75],
      [49.5, -16.75],
    ].map(([x, y]) => ({ p: [x, y, z] as const, l: 'k' }));
  if (k.hi) sweep(k, [skid(-17), skid(17)], () => ALLOY);
  // A black band across the nose face over the bumper (the lapwing's black breast), the square
  // headlights set in it, a little proud: a black frame round each lamp on every tier.
  k.box(BLACK, 0.5, 5.2, 53.0, 58.2, -7.6, 0);
  for (const side of [-1, 1]) k.box(HEADLIGHT, 0.5, 3.5, 8.0, 58.45, -7.6, side * 20.6);
  // Alloy bonnet pins at the bonnet's front corners (high detail).
  if (k.hi) for (const side of [-1, 1]) k.box(ALLOY, 1.0, 0.6, 1.0, 55.2, -2.2, side * 24.5);
}

function lightPod(k: BodyKit): void {
  const hi = k.hi;
  // The pod: a team-painted housing on the bonnet carrying four big round lamps in red cans.
  const sec = (x: number, w: number, y0: number, y1: number): RP[] =>
    ringX(x, [0, y0, 'p'], [
      [w, y0, 'p'],
      [w, y1 - 1.6, 'p'],
      [w - 1.2, y1 - 0.4, 'p'],
      [w - 3.0, y1, 'p'],
    ], [0, y1, 'p']);
  const rings = hi
    ? [sec(47.2, 19.6, -3.2, 5.0), sec(48.0, 20.4, -3.2, 5.8), sec(52.0, 20.4, -3.2, 5.8), sec(52.6, 19.8, -2.8, 5.2)]
    : [sec(47.4, 20.2, -3.2, 5.6), sec(52.6, 19.8, -2.8, 5.2)];
  sweep(k, rings, () => k.paint);
  // Each lamp: a red can, its rim turning in as a black bezel to a lens set 0.5 uu back.
  const segs = hi ? 12 : 8;
  for (const z of [-14.55, -4.85, 4.85, 14.55]) {
    sweep(
      k,
      [circle(50.9, 1.8, z, 3.25, segs, 'c'), circle(54.2, 1.8, z, 3.55, segs, 'c'), circle(53.7, 1.8, z, 2.7, segs, 'l')],
      (band) => (band === -2 ? POD_LAMP : band === 1 ? BLACK : POD_CAN),
    );
  }
}

/**
 * Door mirrors at the A-pillar's foot: a wedge head (a flat mirror glass behind, tapering to a
 * rounded nose in front, its outer end swept back) on a painted arm from the belt, which joins it to
 * the body against the glass from either side.
 */
function mirrors(k: BodyKit): void {
  const xb = 13.0; // the mirror glass's plane
  const prof: readonly (readonly [number, number, string])[] = [
    [0, -2.0, 'm'],
    [0, 2.0, 'm'],
    [1.6, 2.15, 'h'],
    [3.5, 1.4, 'h'],
    [4.5, 0.2, 'h'],
    [3.9, -1.3, 'h'],
    [1.8, -2.05, 'h'],
  ];
  const yc = 6.2;
  for (const side of [-1, 1]) {
    // `sweepBack` pulls the nose back towards the glass (the outer end's taper), `inset` shrinks the ring.
    const ring = (z: number, inset: number, sweepBack: number): RP[] =>
      prof.map(([u, v, l]) => ({ p: [xb + inset + u * (1 - sweepBack) * (1 - inset / 2.2), yc + v * (1 - inset / 2.2), side * z] as const, l }));
    const rings = k.hi ? [ring(34.2, 0.3, 0), ring(40.2, 0, 0.12), ring(40.9, 0.5, 0.2)] : [ring(34.2, 0, 0), ring(40.9, 0.3, 0.2)];
    sweep(k, rings, (band, a, b) => (band >= 0 && a === 'm' && b === 'm' ? MIRROR : k.paint));
    const arm = new THREE.BoxGeometry(2.6, 1.5, 5.0);
    arm.rotateX(-side * 0.55);
    arm.translate(15.0, 4.0, side * 33.0);
    k.push(arm, k.paint);
  }
}

// ---- tail: bumper beam, thrusters, diffuser, lights ------------------------------------------

/** How deep the thrusters' throats run in from their exit plane to the glowing core. */
const THROAT_DEPTH = 3.0;

function tail(k: BodyKit): void {
  const hi = k.hi;
  const { x: nx, y: ny, z: nz } = k.nozzle;
  // One chamfered bumper beam across the tail at the thrusters' height, between the rear flares,
  // in team paint (the dark housings stand out of it, and the tail keeps its team colour); its
  // face stays ahead of the throats' floors (they would show it).
  const face = nx + THROAT_DEPTH + 0.15;
  const beamTop = ny + 5.6;
  bar(k, k.paint, face, -51.6, ny - 6.2, beamTop, -32.8, 32.8);
  // Under it, between the rear tyres: an alloy diffuser with black strakes, and a red tow strap.
  const yb = -k.hh + 0.3;
  const yt = ny - 6.0;
  k.box(DIFFUSER, 2.6, yt - yb, 40.6, face - 0.1 + 1.3, (yb + yt) * 0.5, 0);
  for (const z of [-10.5, 0, 10.5]) k.box(BLACK, 2.6, yt - yb - 0.6, 0.8, face - 1.25, (yb + yt) * 0.5 - 0.3, z);
  k.box(STRAP, 0.7, 4.4, 2.4, face - 0.45, -12.5, -16.0);
  // Twin thrusters standing 3 uu out of the beam, swept round their axis: a thick dark gunmetal
  // housing (EXHAUST, its exit at the nozzle plane) rolling round into its face, a narrow alloy lip
  // (high detail), a black throat narrowing 3 uu in to a small dim core.
  const R = 5.0;
  const n = hi ? 14 : 8;
  for (const s of [-1, 1]) {
    const z = s * nz;
    const rings = hi
      ? [
          circle(nx + 6.0, ny, z, R, n, 'h'),
          circle(nx + 0.45, ny, z, R, n, 'h'),
          circle(nx, ny, z, R - 0.45, n, 'h'),
          circle(nx, ny, z, 3.65, n, 'h'),
          circle(nx, ny, z, 3.05, n, 'h'),
          circle(nx + THROAT_DEPTH, ny, z, 1.2, n, 'h'),
        ]
      : [circle(nx + 6.0, ny, z, R, n, 'h'), circle(nx, ny, z, R, n, 'h'), circle(nx, ny, z, 3.05, n, 'h'), circle(nx + THROAT_DEPTH, ny, z, 1.2, n, 'h')];
    const throat = rings.length - 2;
    // Low detail has no lip ring: its face is a lighter gunmetal, so the housing still reads as a
    // ring round the black throat without bloom or reflections.
    sweep(k, rings, (band) => (band === -2 ? CORE : band === throat ? THROAT : hi ? (band === 3 ? ALLOY : HOUSING) : band === 1 ? HOUSING_FACE : HOUSING));
  }
  // Tail lights on the tailgate's outer corners, tall and thin: an amber indicator cell over the
  // beam, a red bar up the tailgate and on up the C-pillar beside the rear glass.
  const [l0, l1, l2] = GLASS_LEVELS;
  const xAt = (y: number): number => l0.xr + ((l1.xr - l0.xr) * (y - l0.yRear)) / (l1.yRear - l0.yRear);
  const dx = l2.xr - l1.xr;
  const dy = l2.yRear - l1.yRear;
  const len = Math.hypot(dx, dy);
  const bar0 = beamTop + 1.5;
  for (const side of [-1, 1]) {
    k.box(INDICATOR, 0.9, 1.2, 3.0, xAt(beamTop + 0.8) - 0.25, beamTop + 0.8, side * 22.6);
    k.box(TAIL, 0.9, l1.yRear - bar0, 3.0, xAt((bar0 + l1.yRear) * 0.5) - 0.25, (bar0 + l1.yRear) * 0.5, side * 22.6);
    const up = new THREE.BoxGeometry(0.8, 4.4, 3.0);
    up.rotateZ(-Math.atan2(dx, dy));
    up.translate(l1.xr + (dx / len) * 2.1 - (dy / len) * 0.15, l1.yRear + (dy / len) * 2.1 + (dx / len) * 0.15, side * 22.6);
    k.push(up, TAIL);
  }
}

function build(k: BodyKit): void {
  const stripe: Surface = { ...k.paint, color: ACCENT };
  tub(k, stripe);
  glasshouse(k, stripe);
  roofPanel(k, stripe);
  roof(k);
  wing(k, stripe);
  for (const w of [k.wheels.front, k.wheels.back]) for (const side of [-1, 1]) flare(k, w, side, w === k.wheels.front);
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
  // The same tyre size (14.25 uu) front and rear: the rear's `visual` is its own (the sim's rear
  // wheels are bigger), full-width gravel tyres filling the flares.
  wheels: { style: TERO_WHEEL, visual: 1.14, outer: 39, width: 1, rear: { visual: 0.95 } },
  livery: {
    // Team paint over gloss carbon, the line just over the black sills' tops (car-local uu).
    twoToneY: 8.8,
    pinstripe: 0.4,
    // Two big yellow arrows on the roof between the stripes, behind the crest: what the chase
    // camera sees. Their strokes are 0.36 period = 4.5 uu along x; x0 and x1 fall in the gaps
    // either side of the two whole arrows (arrow k spans period k - 0.9 halfWidth .. period k +
    // 0.36 period).
    chevrons: { x0: -32.0, x1: -7.0, halfWidth: 7, period: 12.5 },
    // One shut line, the bonnet's rear edge at the cowl (given twice): a second ahead of the lamp
    // pod aliased into a dotted line.
    seams: { x: [35.6, 35.6], maxZ: 30 },
    accent: ACCENT,
    chevronTint: 1,
    grime: { y0: 11, y1: 3, amount: 0.6 },
    ao: { y0: 2, y1: 14 },
    heat: { x: BOOST_NOZZLE_X, length: 7 },
  },
  budget: { low: 2000, high: 3500 },
};

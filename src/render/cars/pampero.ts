/**
 * The Pampero ('pampero', the cold southern wind of the pampas): a low, wide, razor-edged wedge of
 * an endurance hyper-GT, built from faceted lofts (polygon sections with hard creases, so every
 * facet takes its own light; super low shades them by diffuse alone). A long nose spear with a
 * rounded ridge drops to a carbon arrow splitter between two fender pods. One pod per side runs
 * nose to tail with a flat, sharp shoulder rising as a wedge: the front fender, the blade over a
 * deep dark side intake behind the front wheel, the rear haunch scooped in behind the intake, a
 * tumblehome kick line along the flank, arches swept round the wheels. The shoulder chamfer is one
 * light line: a headlight at the nose, the ice stripe along the car, a tail light at the back. A
 * low, smooth fastback canopy with a dark glass band; mirrors on stalks; louvres over the arches; a
 * team rear wing with a flap on twin raked alloy pylons, carbon endplates edged with team light;
 * the twin thrusters as jet exhausts with team-lit lips in a carbon bay over diffuser fins, between
 * two red light blades on the bevelled carbon rear panels. Paint is two-tone: team colour over
 * gloss carbon below the flank crease, an ice pinstripe on it, no chevrons. Slick tyres on light
 * twelve-vane turbine rims, taller and wider at the rear.
 *
 * Designed on the default hitbox in the build frame (docs/cars.md: hitbox-centred uu, kit.hl / hh /
 * hw 58.75 / 17.83 / 41.85; the livery is car-local, the build frame + (13.88, 20.76, 0)). Within
 * the targets: body 2,724 triangles on high and 1,920 on low, wheels 604 / 424.
 */
import * as THREE from 'three/webgpu';
import { BOOST_NOZZLE_X, CAGE, CAR_KIND, CARBON, DISC, EXHAUST, HEADLIGHT, PAINT_METAL, PAINT_ROUGH, TAILLIGHT, TRIM, TWO_PI, clamp, loft } from './kit';
import type { BodyKit, CarBodySpec, Ring, Surface, WheelAt, WheelStyle } from './types';

/** The ice accent (sRGB): the pinstripe, the shoulder stripe, the headlights' tint. */
const ICE = 0xcdeeff;

/** Slick tyres on light twelve-vane turbine rims over a dark dish, a light lip, a team hub. */
export const TURBINE: WheelStyle = {
  id: 'pampero-turbine',
  tyre: 'slick',
  spokes: 12,
  spokeWidth: 0.11,
  dish: 0.5,
  dishColor: 0x0b0d10,
  rim: 0xc3cad3,
  rimFinish: { metal: 0.85, rough: 0.26 },
  bead: 0xdfe4ea,
  bolts: 0,
  hub: 'team',
  budget: { low: 424, high: 604 },
};

/** The body's floor (build frame): every part's underside. */
const FLOOR = -17.4;
/** The flanks' crease (build frame): the widest line of the side pods, the two-tone line on it. */
const CREASE = -12.26;

type P3 = readonly [number, number, number];
type V3 = [number, number, number];

const sub = (a: P3, b: P3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: P3, b: P3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: P3, b: P3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function unit(v: P3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}
function centroid(r: readonly P3[]): V3 {
  const c: V3 = [0, 0, 0];
  for (const p of r) for (let i = 0; i < 3; i++) c[i] += p[i] / r.length;
  return c;
}
/** A non-indexed geometry from flat position and normal arrays. */
function geometry(pos: readonly number[], nrm: readonly number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/**
 * A faceted loft (the kit's loft is smooth all round): `rings` are convex polygons of one point
 * count, joined facet by facet. Each facet (points f, f + 1) is a strip of its own, smooth along
 * the loft (its normal averaged across a ring, except at the `hard` rings) and crisp across, so the
 * creases stay sharp on every tier (super low shades them by diffuse alone), except at the
 * `smooth` points, where the two facets blend (a rounded ridge). `surf(facet, span)` picks each
 * quad's surface; both ends are flat caps. Faces point away from the ring's centroid. No ring may
 * repeat its neighbour and no facet may shrink to a point (a zero normal is NaN in the shader).
 */
function facetLoft(
  k: BodyKit,
  rings: readonly (readonly P3[])[],
  surf: (facet: number, span: number) => Surface,
  caps: readonly [Surface, Surface],
  hard: readonly number[] = [],
  smooth: readonly number[] = [],
): void {
  const nr = rings.length;
  const np = rings[0].length;
  const cen = rings.map(centroid);
  // Every quad's outward unit normal (Newell), qn[facet][span], and each facet's winding.
  const qn: V3[][] = [];
  const signs: number[] = [];
  for (let f = 0; f < np; f++) {
    const g = (f + 1) % np;
    const row: V3[] = [];
    let out = 0;
    for (let s = 0; s + 1 < nr; s++) {
      const a = rings[s][f];
      const b = rings[s][g];
      const c = rings[s + 1][f];
      const d = rings[s + 1][g];
      const n = cross(sub(d, a), sub(c, b));
      const mid: V3 = [0, 0, 0];
      for (let i = 0; i < 3; i++) mid[i] = (a[i] + b[i] + c[i] + d[i]) / 4 - (cen[s][i] + cen[s + 1][i]) / 2;
      out += dot(n, mid);
      row.push(unit(n));
    }
    const sign = out < 0 ? -1 : 1;
    signs.push(sign);
    qn.push(row.map(([x, y, z]): V3 => [x * sign, y * sign, z * sign]));
  }
  const blend = (n: V3, m: V3): V3 => {
    const v: V3 = [n[0] + m[0], n[1] + m[1], n[2] + m[2]];
    return Math.hypot(v[0], v[1], v[2]) < 1e-6 ? n : unit(v);
  };
  // Facet f's normal at ring r of span s: averaged along the loft across a soft ring...
  const along = (f: number, s: number, r: number): V3 => {
    const other = r === s ? s - 1 : s + 1;
    return hard.includes(r) || other < 0 || other >= nr - 1 ? qn[f][s] : blend(qn[f][s], qn[f][other]);
  };
  // ...and across the facets at a smooth point p (facet p - 1 ends there, facet p starts).
  const normal = (f: number, s: number, r: number, p: number): V3 => {
    const n = along(f, s, r);
    return smooth.includes(p) ? blend(n, along(p === f ? (f + np - 1) % np : p, s, r)) : n;
  };
  for (let f = 0; f < np; f++) {
    const g = (f + 1) % np;
    let s0 = 0;
    for (let s = 1; s <= nr - 1; s++) {
      if (s < nr - 1 && surf(f, s) === surf(f, s0)) continue;
      const pos: number[] = [];
      const nrm: number[] = [];
      for (let q = s0; q < s; q++) {
        const corner = [rings[q][f], rings[q][g], rings[q + 1][f], rings[q + 1][g]];
        for (const i of signs[f] > 0 ? [0, 1, 2, 1, 3, 2] : [0, 2, 1, 1, 2, 3]) {
          pos.push(...corner[i]);
          nrm.push(...normal(f, q, i < 2 ? q : q + 1, i % 2 === 0 ? f : g));
        }
      }
      k.push(geometry(pos, nrm), surf(f, s0));
      s0 = s;
    }
  }
  // Flat end caps, fanned from the centroid, facing away from the neighbouring ring.
  for (const [r, nb, s] of [[0, 1, caps[0]], [nr - 1, nr - 2, caps[1]]] as const) {
    const ring = rings[r];
    const c = cen[r];
    let n: V3 = [0, 0, 0];
    for (let j = 0; j < np; j++) {
      const t = cross(sub(ring[j], c), sub(ring[(j + 1) % np], c));
      n = [n[0] + t[0], n[1] + t[1], n[2] + t[2]];
    }
    const flip = dot(n, sub(c, cen[nb])) < 0;
    n = unit(flip ? [-n[0], -n[1], -n[2]] : n);
    const pos: number[] = [];
    const nrm: number[] = [];
    for (let j = 0; j < np; j++) {
      const p = ring[j];
      const q = ring[(j + 1) % np];
      pos.push(...c, ...(flip ? q : p), ...(flip ? p : q));
      for (let i = 0; i < 3; i++) nrm.push(...n);
    }
    k.push(geometry(pos, nrm), s);
  }
}

/** A smooth loft ring across x: centre z `zc`, half width `hu`, from `bottom` to `top`, widest at `wide` of the height. */
function ring(x: number, zc: number, hu: number, bottom: number, top: number, wide = 0.5): Ring {
  const yc = bottom + (top - bottom) * wide;
  return { o: [x, yc, zc], u: [0, 0, 1], v: [0, 1, 0], hu, hv: top - yc, hvNeg: yc - bottom };
}

/** Piecewise linear y over x through `pts` ([x, y], x descending), clamped at the ends. */
function profile(pts: readonly (readonly [number, number])[]): (x: number) => number {
  return (x) => {
    if (x >= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i];
      if (x >= x1) {
        const [x0, y0] = pts[i - 1];
        return y1 + ((y0 - y1) * (x - x1)) / (x0 - x1);
      }
    }
    return pts[pts.length - 1][1];
  };
}

/**
 * The row (0..seg-1, counted from +u towards +v) of a smooth loft of rings at constant, monotone x,
 * all of exponent `n`, that the point (x, y, z) lies on: a window band follows the loft's rows.
 */
function rowOf(rings: readonly Ring[], seg: number, n: number, x: number, y: number, z: number): number {
  const last = rings.length - 1;
  const dir = Math.sign(rings[last].o[0] - rings[0].o[0]);
  let i = 0;
  while (i < last - 1 && (x - rings[i + 1].o[0]) * dir > 0) i++;
  const a = rings[i];
  const b = rings[i + 1];
  const t = clamp((x - a.o[0]) / (b.o[0] - a.o[0]), 0, 1);
  const mix = (p: number, q: number): number => p + (q - p) * t;
  const dv = y - mix(a.o[1], b.o[1]);
  const hv = dv >= 0 ? mix(a.hv, b.hv) : mix(a.hvNeg ?? a.hv, b.hvNeg ?? b.hv);
  const u = (z - mix(a.o[2], b.o[2])) / mix(a.hu, b.hu);
  const v = dv / hv;
  const p = n / 2; // the superellipse's |cos|^(2/n), inverted
  let ang = Math.atan2(Math.sign(v) * Math.abs(v) ** p, Math.sign(u) * Math.abs(u) ** p);
  if (ang < 0) ang += TWO_PI;
  return Math.floor(ang / (TWO_PI / seg)) % seg;
}

/**
 * The side pod's section at `x` (the right side; the left mirrors z), from `b` up to `t` between
 * the inner face `zi` and the outer face `zo`, its lower points at `xb` (a raked ring): a tucked
 * lower flank up to the crease, the flank up to the kick line `yK` (scooped in by `scoop` at the
 * crease), the upper flank leaning in (tumblehome), the shoulder chamfer (the stripe), the flat
 * top falling slightly inwards, an inner chamfer and wall, the floor. Facets 0 tuck, 1 flank,
 * 2 upper flank, 3 shoulder, 4 top, 5 inner chamfer, 6 inner wall, 7 floor.
 */
function podRing(x: number, zi: number, zo: number, b: number, t: number, yK: number, scoop: number, xb = x): P3[] {
  const yC = clamp(CREASE, b + 0.35, t - 1.6);
  const tuck = clamp((yC - b) * 0.45, 0.15, 2.4);
  const sh = Math.min(1.3, 0.45 * (t - yC));
  const yk = clamp(yK, yC + 0.4, t - sh - 0.4);
  const lean = clamp((t - sh - yk) * 0.3, 0.2, 2.2);
  const yI = t - Math.min(1.8, 0.45 * (t - b));
  const at = (y: number): number => xb + ((x - xb) * (y - b)) / (t - b);
  return [
    [xb, b, zo - tuck - scoop],
    [at(yC), yC, zo - scoop],
    [at(yk), yk, zo - 0.15],
    [at(t - sh), t - sh, zo - lean],
    [x, t, zo - lean - 1.2],
    [at(t - 0.5), t - 0.5, zi + 1.2],
    [at(yI), yI, zi],
    [xb, b, zi],
  ];
}

/**
 * The tub's section at `x`, half width `hu`, from `b` to `t`, widest at `wide` of the height: a
 * shallow ridge down the middle of the top, the upper flanks to the crease, the lower flanks
 * tucked to the floor. Facets 0 top, 1 upper flank, 2 lower flank, 3 floor, 4..6 the left side.
 */
function tubRing(x: number, hu: number, b: number, t: number, wide: number): P3[] {
  const m = b + (t - b) * wide;
  const r = 0.2 * (t - m);
  return [
    [x, t, 0],
    [x, t - r, hu * 0.62],
    [x, m, hu],
    [x, b, hu * 0.86],
    [x, b, -hu * 0.86],
    [x, m, -hu],
    [x, t - r, -hu * 0.62],
  ];
}

/**
 * Where an arch over wheel `w` (clearance `gap`) cuts a pod: `steps` + 1 stations from where it
 * meets the floor in front of the wheel to where it meets it behind, or `tailX`: x descending and
 * the arch's height there.
 */
function archStations(w: WheelAt, gap: number, steps: number, tailX: number): { x: number; y: number }[] {
  const ra = w.radius + gap;
  const a0 = Math.asin(clamp((FLOOR - w.y) / ra, -1, 1));
  const a1 = Math.min(Math.PI - a0, Math.acos(clamp((tailX - w.x) / ra, -1, 1)));
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    out.push({ x: w.x + ra * Math.cos(a), y: Math.max(FLOOR, w.y + ra * Math.sin(a)) });
  }
  return out;
}

function build(k: BodyKit): void {
  const { hi, paint, glass, strip } = k;
  const accent: Surface = { color: ICE, metal: PAINT_METAL, rough: PAINT_ROUGH, emissive: 0.25, kind: CAR_KIND.PAINT };

  // Central tub, nose to tail: a pointed spear with a shallow ridge dropping to the floor at the
  // nose (the wedge line), the cockpit, and the carbon tail panel of the jet bay.
  const tub = [
    tubRing(58.6, 1.6, FLOOR, -14.4, 0.35),
    tubRing(56.4, 4.2, FLOOR, -13.6, 0.35),
    tubRing(52, 7.6, FLOOR, -12.0, 0.38),
    tubRing(45, 10.8, FLOOR, -9.6, 0.4),
    tubRing(37, 13, FLOOR, -7.0, 0.42),
    tubRing(28, 15.2, FLOOR, -4.2, 0.45),
    tubRing(18, 16.8, FLOOR, -1.8, 0.45),
    tubRing(6, 17.4, FLOOR, 0.2, 0.45),
    tubRing(-10, 17.4, FLOOR, 1.2, 0.45),
    tubRing(-26, 17, FLOOR, 1.4, 0.45),
    tubRing(-40, 16.2, FLOOR, 1.4, 0.45),
    tubRing(-53.5, 15.2, FLOOR, 1.0, 0.45),
  ];
  facetLoft(k, tub, (f) => (f === 3 ? TRIM : paint), [paint, CARBON], [], [0]);

  // Canopy: a smooth, low fastback bubble over the sharp body. Glass wraps the windscreen and the
  // sides as one dark band; the roof and the fastback behind the side windows are paint.
  const canSeg = hi ? 20 : 12;
  const canN = 2.6;
  const can = [
    ring(28, 0, 6, -9, -5.0, 0.4),
    ring(24, 0, 10.4, -9, -0.8, 0.4),
    ring(16, 0, 13.4, -8, 5.0, 0.4),
    ring(8, 0, 14.6, -7, 9.0, 0.4),
    ...(hi ? [ring(0, 0, 15, -6, 10.8, 0.4)] : []),
    ring(-8, 0, 14.8, -6, 11.2, 0.4),
    ...(hi ? [ring(-18, 0, 13.8, -6, 10.2, 0.4)] : []),
    ring(-28, 0, 12, -6, 8.2, 0.4),
    ...(hi ? [ring(-38, 0, 9.6, -6, 5.8, 0.4)] : []),
    ring(-46, 0, 7.4, -6, 3.8, 0.4),
    ring(-51, 0, 5.6, -6, 2.4, 0.4),
  ];
  const step = 360 / canSeg;
  k.pushBy(loft(can, canSeg, canN), (x, y, z, nx) => {
    if (Math.abs(nx) > 0.97 && (x > 27.9 || x < -50.9)) return paint; // the end caps
    const mid = (rowOf(can, canSeg, canN, x, y, z) + 0.5) * step;
    const side = mid > 15 && mid < 165; // above the belt line
    if (x > 8) return side ? glass : paint; // the windscreen
    if (x > -28 && side && (mid < 70 || mid > 110)) return glass; // the side windows
    return paint;
  });

  // One faceted pod per side, nose to tail: the front fender, the blade over the side intake, the
  // rear haunch. Flat, sharp shoulders rising as a wedge, undersides swept round the wheels; the
  // shoulder chamfer is a headlight at the nose, the ice stripe along the car, a tail light at the
  // back.
  const shoulder = profile([
    [58.2, -14.6],
    [56.4, -12.4],
    [54.2, -10.2],
    [52, -8.6],
    [50, -7.4],
    [46, -6.0],
    [42, -5.0],
    [37.4, -4.4],
    [30, -3.6],
    [20, -2.4],
    [18, -2.2],
    [6, 0.2],
    [3.6, 1.0],
    [-4, 2.4],
    [-16, 3.0],
    [-30, 3.4],
    [-59, 3.8],
  ]);
  // The kick line: where the flank folds in, rising as a wedge from the nose to the tail.
  const kick = profile([
    [58, -13.4],
    [-58, -3.2],
  ]);
  // The scoop: the flank below the kick line drawn in behind the intake, fading out at the rear arch.
  const scoop = profile([
    [3.6, 0],
    [-4, 3.8],
    [-16, 2.4],
    [-30, 0],
  ]);
  const tailX = -58.5;
  const front = archStations(k.wheels.front, 1.5, hi ? 10 : 7, tailX);
  const back = archStations(k.wheels.back, 1.5, hi ? 9 : 6, tailX + 1.1);
  const last = back[back.length - 1];
  // Stations: [x, zi, zo, bottom, top, lower x]; the intake's four after the front arch, the tail
  // bevelled into the carbon rear panel.
  const st: (readonly [number, number, number, number, number, number?])[] = [
    [58.2, 23.4, 31.6, FLOOR, shoulder(58.2)],
    [56.4, 21.2, 35.4, FLOOR, shoulder(56.4)],
    [54.2, 20, 38.4, FLOOR, shoulder(54.2)],
    ...front.map((a) => [a.x, 19.6, 41.6, a.y, shoulder(a.x)] as const),
    [20.4, 19.8, 41.4, FLOOR, shoulder(20.4)], // the fender's back: the intake's raked front wall up to...
    [18, 21.4, 40.2, -4.6, shoulder(18)], // ...the blade over the intake, a waist in plan...
    [6, 21.4, 40.2, -2.8, shoulder(6)],
    [3.6, 18, 41.2, FLOOR, shoulder(3.6), 5.4], // ...and the haunch's front, the intake's mouth
    [-4, 15.4, 41.6, FLOOR, shoulder(-4)],
    [-16, 15.4, 41.6, FLOOR, shoulder(-16)],
    ...back.map((a) => [a.x, 15.4, 41.6, a.y, shoulder(a.x)] as const),
    [tailX, 16.3, 40.7, last.y + 0.9, shoulder(tailX) - 0.9],
  ];
  const i0 = 3 + front.length; // the station at the fender's back
  const spans = st.length - 1;
  for (const s of [-1, 1]) {
    const rings = st.map(([x, zi, zo, b, t, xb]) => podRing(x, zi, zo, b, t, kick(x), scoop(x), xb).map(([px, py, pz]): P3 => [px, py, pz * s]));
    facetLoft(
      k,
      rings,
      (f, sp) => {
        if (f === 7) return TRIM; // the floor and the wheel-well liners
        const mouth = sp === i0 + 2;
        if ((sp === i0 || mouth) && (f === 0 || f === 6)) return TRIM; // the intake's front wall and its mouth
        if (mouth && f === 1) return TRIM;
        if (f === 3) return sp < 2 ? HEADLIGHT : sp >= spans - 2 ? TAILLIGHT : accent;
        return paint;
      },
      [paint, CARBON],
      [i0, i0 + 1, i0 + 2, i0 + 3, spans],
    );

    // Mirrors on stalks off the fenders, beside the windscreen (their glass faces back).
    k.fin(paint, [[24.2, 0.9], [23, 2.1], [20.5, 2.3], [20.3, 0.2], [22, -0.1]], 4.2, 'xy', s * 24.6);
    k.fin(CARBON, [[23.2, -3.2], [21.6, -3.2], [21.2, 0.4], [22.4, 0.4]], 0.8, 'xy', s * 24.6);
    if (hi) k.box(glass, 0.3, 1.7, 3.6, 20.25, 1.2, s * 24.6);

    // The intake: a dark cavity behind the front wheel, a carbon sill under it with a team light.
    k.box(TRIM, 17.6, 12.4, 15, 12, -10.7, s * 24.5);
    k.box(CARBON, 19, 2.9, 9.9, 12, -15.85, s * 36.45);
    k.box(strip, 17, 0.7, 0.5, 12, -14.55, s * 41.3);

    // A headlight slit on the fender's chisel front, a red light blade across the haunch's tail.
    k.box(HEADLIGHT, 0.5, 0.9, 6.4, 58.3, -15.6, s * 27.4);
    k.box(TAILLIGHT, 0.9, 1.5, 19.4, -58.25, 0.6, s * 29.2);

    // Louvres over the rear wheels, and over the front ones on high detail.
    for (const x of [-40.5, -43.5, -46.5, -49.5]) k.box(TRIM, 1.0, 0.5, 10.5, x, shoulder(x) - 0.2, s * 30);
    if (hi) for (const x of [31, 33.5, 36]) k.box(TRIM, 1.0, 0.5, 9, x, shoulder(x) - 0.2, s * 30);

    // Rear wing: a raked alloy pylon on the deck and a carbon endplate at the wing's tip.
    k.fin(CAGE, [[-39.5, -0.6], [-45.5, -0.6], [-55.2, 14.8], [-50.4, 14.8]], 1.3, 'xy', s * 12.5);
    k.fin(CARBON, [[-58.6, 10.6], [-50.5, 10.6], [-46.6, 17.4], [-58.6, 17.4]], 1.1, 'xy', s * 40.3);
    k.box(strip, 0.5, 6.2, 1.3, -58.45, 14.2, s * 40.3);
  }

  // The wing: a lens-section main plane lofted across the car, trailing edge up, and a steeper
  // flap over its trailing edge (high detail).
  const wing = (xc: number, yc: number, aoa: number, tips: readonly [number, number], hu: number, hv: number, seg: number): void => {
    const u = [Math.cos(aoa), -Math.sin(aoa), 0] as const;
    const v = [Math.sin(aoa), Math.cos(aoa), 0] as const;
    const r = (z: number, w: number, h: number): Ring => ({ o: [xc, yc, z], u, v, hu: w, hv: h });
    const [z0, z1] = tips;
    k.push(loft([r(-z1, hu * 0.88, hv * 0.65), r(-z0, hu, hv), r(z0, hu, hv), r(z1, hu * 0.88, hv * 0.65)], seg, 2.4), paint);
  };
  wing(-52.9, 14.4, 0.15, [38, 40.3], 5.5, 1.2, hi ? 12 : 8);
  if (hi) wing(-56.7, 16.5, 0.3, [38.4, 40.3], 2.0, 0.45, 8);

  // Carbon arrow splitter under the nose and the fender fronts (kept ahead of the front tyres).
  k.fin(
    CARBON,
    [
      [58.7, -1.5],
      [58.7, 1.5],
      [57.9, 22],
      [56, 40.8],
      [52.4, 40.8],
      [54, 22],
      [52, 9],
      [52, -9],
      [54, -22],
      [52.4, -40.8],
      [56, -40.8],
      [57.9, -22],
    ],
    0.8,
    'xz',
    -16.9,
  );

  // Diffuser fins on the carbon tail panel under the jets (satin, so their edges do not glint).
  for (const z of [-12.4, -3.6, 3.6, 12.4]) {
    k.fin(TRIM, [[-53, -17.3], [-58.3, -17.3], [-58.3, -10.4], [-56.4, -8.2], [-53, -8.2]], 0.7, 'xy', z);
  }

  // Twin thrusters as jet exhausts in the carbon bay: heat-tinted housing, dark throat and a
  // team-lit lip ring each, exiting at the boost nozzles.
  const { x: nx, y: ny } = k.nozzle;
  const jSeg = hi ? 16 : 10;
  for (const side of [-1, 1]) {
    const z = side * k.nozzle.z;
    const housing = new THREE.CylinderGeometry(3.7, 4.1, 6.5, jSeg, 1, false);
    housing.rotateZ(Math.PI / 2);
    housing.translate(nx + 3.25, ny, z);
    k.push(housing, EXHAUST);
    const throat = new THREE.CircleGeometry(3.0, jSeg);
    throat.rotateY(-Math.PI / 2);
    throat.translate(nx - 0.05, ny, z);
    k.push(throat, DISC);
    const lip = new THREE.TorusGeometry(3.2, 0.5, hi ? 4 : 3, hi ? 16 : 12);
    lip.rotateY(Math.PI / 2);
    lip.translate(nx + 0.05, ny, z);
    k.push(lip, strip);
  }
}

export const PAMPERO: CarBodySpec = {
  id: 'pampero',
  build,
  wheels: { style: TURBINE, visual: 1.12, outer: 40.6, width: 1.05, rear: { visual: 1.1, width: 1.2 } },
  // Car-local uu (the build frame + (13.88, 20.76, 0)): the two-tone line on the flanks' crease
  // (CREASE, build -12.26); the bonnet seam across the nose spear (build 45) and the engine cover's
  // across the fastback (build -32).
  livery: {
    twoToneY: 8.5,
    pinstripe: 0.4,
    chevrons: null,
    seams: { x: [58.9, -18.1], maxZ: 12 },
    accent: ICE,
    chevronTint: 0,
    grime: { y0: 9.5, y1: 4, amount: 0.4 },
    ao: { y0: 3, y1: 12 },
    heat: { x: BOOST_NOZZLE_X, length: 6.5 },
  },
  budget: { low: 2000, high: 3500 },
};

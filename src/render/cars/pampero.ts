/**
 * The Pampero ('pampero', the cold southern wind of the pampas): a low, wide, razor-edged wedge of
 * an endurance hyper-GT, built from faceted lofts (polygon sections with hard creases, so every
 * facet takes its own light; super low shades them by diffuse alone), one design language from
 * the nose to the canopy and the tail.
 *
 * An arrowhead in plan: a long nose spear, lowest and furthest forward, falls to a carbon tip with
 * a team-lit splitter edge, and widens into two fender pods whose fronts are knife blades swept
 * back to the outer corners, the headlights on the blades' edges. Each pod runs nose to tail with a
 * flat, sharp shoulder rising as a wedge and a ridge running diagonally across its top (inner front
 * to outer rear): the front fender narrowed over the front wheel (the front track sits inside the
 * rear's), a deep side intake behind it raked like the windscreen and tapering to a point under
 * the blade, with a back wall and two vanes, then the rear haunch at full width, its tail dropping
 * over the rear tyre. The shoulder chamfer is one light line: headlights at the nose, the ice
 * stripe along the car, the tail lights at the back. A low faceted canopy, its glass one dark band
 * over the windscreen, the sides and the roof, a hard belt crease, a ridged fastback with a short
 * fin; mirrors on swept arms off the canopy's flanks. A deep team wing with a flap (high detail)
 * hangs from two carbon swan-neck pylons between swept carbon endplates edged with team light. The
 * tail is a vertical panel in a dark shade of the team colour: the twin thrusters exit it as jet
 * exhausts, a team-coloured fan in each team-lit lip, over a diffuser ramp whose fins, lit at
 * their trailing edges, are the car's lowest, rearmost parts; the pods' bevelled tails, in the
 * same dark shade, carry the red light blades. Paint is two-tone: team colour over gloss carbon below the flank crease,
 * an ice pinstripe on it, no chevrons. Slick tyres on twelve-vane turbine rims, taller, wider and
 * further out at the rear.
 *
 * Lamps and team light run hotter on high detail (high and ultra, where bloom carries the colour)
 * than on low detail (low and super low, no bloom), where a lamp too hot tone-maps to white or
 * orange: the same parts, plain vertex data, less emission.
 *
 * Designed on the default hitbox in the build frame (docs/cars.md: hitbox-centred uu, kit.hl / hh /
 * hw 58.75 / 17.83 / 41.85; the livery is car-local, the build frame + (13.88, 20.76, 0)). The
 * body cannot reach below the hitbox (build y -17.83, 20 uu over the ground) nor past its tail, so
 * the lower half of each tyre and the back of the rear tyres show on every car. Within the
 * targets: body 2,752 triangles on high and 1,984 on low, wheels 604 / 424.
 */
import * as THREE from 'three/webgpu';
import { BOOST_NOZZLE_X, CAR_KIND, CARBON, EXHAUST, HEADLIGHT, PAINT_METAL, PAINT_ROUGH, TAILLIGHT, TEAM_PAINT, TRIM, clamp, tube } from './kit';
import type { BodyKit, CarBodySpec, Surface, WheelAt, WheelStyle } from './types';

/** The ice accent (sRGB): the pinstripe, the shoulder stripe. */
const ICE = 0xcdeeff;

/** Slick tyres on twelve-vane turbine rims (satin alloy) over a dark dish, a light lip, a team hub. */
export const TURBINE: WheelStyle = {
  id: 'pampero-turbine',
  tyre: 'slick',
  spokes: 12,
  spokeWidth: 0.11,
  dish: 0.5,
  dishColor: 0x0b0d10,
  rim: 0xa9b1bb,
  rimFinish: { metal: 0.6, rough: 0.3 },
  bead: 0xdfe4ea,
  bolts: 0,
  hub: 'team',
  budget: { low: 424, high: 604 },
};

/** The body's floor (build frame): every part's underside, at the hitbox's (less 0.13 uu). */
const FLOOR = -17.7;
/** The flanks' crease (build frame): the two-tone line and the pinstripe on it. */
const CREASE = -12.26;
/** The underside of the pods' knife blades at the nose (build frame). */
const BLADE = -14.2;

type P3 = readonly [number, number, number];
type V3 = [number, number, number];
type XY = readonly (readonly [number, number])[];

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
/** `c` (sRGB hex) scaled by `f` per channel: a darker shade. */
function shade(c: number, f: number): number {
  const ch = (s: number): number => Math.round(((c >> s) & 255) * f) << s;
  return ch(16) | ch(8) | ch(0);
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

/** Piecewise linear y over x through `pts` ([x, y], x descending), clamped at the ends. */
function profile(pts: XY): (x: number) => number {
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

/** The x along a ring's outer flank (its points 0..4, rising) at height `y`. */
function flankX(r: readonly P3[], y: number): number {
  for (let i = 1; i <= 4; i++) {
    if (y <= r[i][1] || i === 4) {
      const [a, b] = [r[i - 1], r[i]];
      return a[0] + ((b[0] - a[0]) * clamp((y - a[1]) / (b[1] - a[1]), 0, 1));
    }
  }
  return r[0][0];
}

/**
 * One station of a side pod (the right side; the left mirrors z): its top at `x` (its floor at
 * `xb`, a raked ring), between the inner face `zi` and the outer face `zo`, from the bottom `b`
 * up to the outer shoulder's top `t` and the ridge `tr` at `zr`, the kick line `yK`, the lower
 * flank drawn in by `scoop` (the intake's depth and the haunch's waist) up to the crease `yC`.
 */
interface PodStation {
  readonly x: number;
  readonly xb: number;
  readonly zi: number;
  readonly zo: number;
  readonly b: number;
  readonly t: number;
  readonly tr: number;
  readonly zr: number;
  readonly yK: number;
  readonly scoop: number;
  readonly yC: number;
}

/**
 * The side pod's section: a tucked lower flank up to the crease, the flank up to the kick line
 * (both drawn in by the scoop), the upper flank leaning in (tumblehome), the shoulder chamfer (the
 * light line), the top in two facets meeting at the ridge, an inner chamfer and wall, the floor.
 * Facets 0 tuck, 1 flank, 2 upper flank, 3 shoulder, 4 outer top, 5 inner top, 6 inner chamfer,
 * 7 inner wall, 8 floor.
 */
function podRing(s: PodStation): P3[] {
  const { x, xb, zi, zo, b, t, tr, zr, scoop } = s;
  const yC = clamp(s.yC, b + 0.35, t - 1.6);
  const tuck = clamp((yC - b) * 0.45, 0.15, 2.4);
  const sh = Math.min(1.3, 0.45 * (t - yC));
  const yk = clamp(s.yK, yC + 0.4, t - sh - 0.4);
  const lean = clamp((t - sh - yk) * 0.3, 0.2, 2.2);
  const ti = tr - 0.9;
  const yI = ti - Math.min(1.8, 0.45 * (ti - b));
  const at = (y: number): number => xb + ((x - xb) * (y - b)) / (tr - b);
  return [
    [xb, b, zo - tuck - scoop],
    [at(yC), yC, zo - scoop],
    [at(yk), yk, zo - 0.15],
    [at(t - sh), t - sh, zo - lean],
    [at(t), t, zo - lean - 1.2],
    [x, tr, zr],
    [at(ti), ti, zi + 1.2],
    [at(yI), yI, zi],
    [xb, b, zi],
  ];
}

/**
 * The tub's section at `x`, half width `hu`, from `b` to `t`, widest at `wide` of the height: a
 * shallow ridge down the middle of the top, the upper flanks to the widest line, the lower flanks
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
 * The canopy's section at `x`, half width `hu`, from `b` (inside the tub) to the belt crease and the
 * ridge `top`: the lower side, the side glass, the roof's side and the roof, meeting at a ridge.
 * Facets 0 roof, 1 roof side, 2 side, 3 lower side, 4 floor, 5..8 the left side.
 */
function canopyRing(x: number, hu: number, b: number, belt: number, top: number): P3[] {
  const roof = top - 0.14 * (top - belt);
  const upper = belt + 0.5 * (top - belt);
  return [
    [x, top, 0],
    [x, roof, hu * 0.42],
    [x, upper, hu * 0.84],
    [x, belt, hu],
    [x, b, hu * 0.9],
    [x, b, -hu * 0.9],
    [x, belt, -hu],
    [x, upper, -hu * 0.84],
    [x, roof, -hu * 0.42],
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

/** The pod's outer shoulder top (build y over x): a knife at the nose rising as a wedge to the tail. */
const SHOULDER = profile([
  [53.6, -12.0],
  [47.4, -12.0],
  [45.3, -11.4],
  [42.8, -8.4],
  [40, -6.4],
  [37.4, -5.3],
  [30, -4.0],
  [20, -2.5],
  [6, 0.0],
  [-4, 2.2],
  [-16, 2.9],
  [-30, 3.3],
  [-59, 3.7],
]);
/** The pod's ridge: steep off the knife (the chisel), then 0.7 over the shoulder. */
const RIDGE = profile([
  [53.6, -11.6],
  [51.6, -10.7],
  [49.1, -9.7],
  [47.4, -9.0],
  [45.3, -8.2],
  [42.8, -7.1],
  [40, -5.9],
  [37.4, -4.7],
  [30, -3.3],
  [20, -1.8],
  [6, 0.7],
  [-4, 2.9],
  [-16, 3.6],
  [-30, 4.0],
  [-59, 4.4],
]);
/** Where the ridge runs across the pod's top (0 inner face, 1 outer): inner front to outer rear. */
const RIDGE_AT = profile([
  [53.6, 0.5],
  [49, 0.4],
  [37.4, 0.42],
  [20, 0.5],
  [0, 0.6],
  [-20, 0.66],
  [-59, 0.62],
]);
/** The pod's outer face in plan: the blade swept back to the outer corner, the waist, the haunch. */
const OUTER = profile([
  [53.6, 23.0],
  [45.27, 37.5],
  [43.5, 38.0],
  [25.6, 38.2],
  [14, 38.9],
  [3, 40.4],
  [-3, 41.2],
  [-8, 41.6],
  [-59, 41.6],
]);
/** The pod's inner face in plan. */
const INNER = profile([
  [53.6, 18.6],
  [49, 18.2],
  [45, 17.6],
  [26, 17.6],
  [23, 18.6],
  [20, 19.5],
  [6, 19.5],
  [2, 18.0],
  [-3, 15.4],
  [-59, 15.4],
]);
/** The kick line, where the flank folds in: rising as a wedge from the nose to the tail. */
const KICK = profile([
  [58, -13.4],
  [-58, -3.2],
]);
/** The haunch's waist: the lower flank drawn in behind the intake, out again at the rear arch. */
const WAIST = profile([
  [-3, 0],
  [-8, 1.6],
  [-18, 1.0],
  [-27, 0.3],
  [-31, 0],
]);
/** The spear's top over x, nose to tail (its tail kicks up into the rear panel). */
const SPEAR = profile([
  [58.7, -16.1],
  [56.2, -13.8],
  [53.6, -11.7],
  [49, -10.0],
  [43, -8.4],
  [36, -6.4],
  [28, -4.6],
  [24, -3.6],
  [16, -2.2],
  [8, -0.4],
  [0, 0.4],
  [-8, 0.85],
  [-26, 1.25],
  [-40, 1.5],
  [-46, 1.8],
  [-52, 2.6],
  [-56.6, 3.6],
]);

function build(k: BodyKit): void {
  const { hi, paint, glass, strip } = k;
  const accent: Surface = { color: ICE, metal: PAINT_METAL, rough: PAINT_ROUGH, emissive: 0.25, kind: CAR_KIND.PAINT };
  // Lamps and team light: hotter with bloom (high detail), saturated and softer without it.
  const glow: Surface = { ...strip, emissive: hi ? 1.2 : 0.6 };
  const tail: Surface = hi ? TAILLIGHT : { ...TAILLIGHT, color: 0xff0a1a, emissive: 0.45 };
  // A dark shade of the team colour (satin): the rear panels, the diffuser and the intake's upper vane.
  const dark: Surface = { color: shade(TEAM_PAINT[k.team], 0.4), metal: 0.3, rough: 0.42, emissive: 0, kind: CAR_KIND.TRIM };
  // The intake's back wall (dark grey, so its depth reads) and the jets' fans (team colour).
  const wall: Surface = { ...TRIM, color: 0x2a2e35, rough: 0.6 };
  const fan: Surface = { color: TEAM_PAINT[k.team], metal: 0.25, rough: 0.4, emissive: hi ? 0.5 : 0.55, kind: CAR_KIND.TRIM };

  // Central tub, nose to tail: a pointed spear with a rounded ridge, lowest and furthest forward,
  // widening to meet the pods' inner faces so the nose is one arrowhead and the deck between canopy
  // and pods a shallow valley; its floor rises at the tail into the diffuser ramp, its tail is the
  // dark rear panel the thrusters exit.
  const hu = (x: number): number => INNER(x) + 0.6;
  const tubSt: (readonly [number, number, number, number?])[] = [
    [58.7, 1.4, 0.4],
    [56.2, 9.2, 0.35],
    [53.6, 19.2, 0.35],
    [49, hu(49), 0.55],
    [43, hu(43), 0.85],
    [36, hu(36), 0.85],
    [28, 19.0, 0.85],
    [24, 20.0, 0.85],
    [20, 20.1, 0.85],
    [8, 20.1, 0.85],
    ...(hi ? [[0, 18.4, 0.85] as const] : []),
    [-4, 16.0, 0.85],
    [-26, 16.0, 0.85],
    [-46, 16.0, 0.85],
    [-52, 16.0, 0.85, -14.0],
    [-56.6, 16.0, 0.85, -9.8],
  ];
  const tub = tubSt.map(([x, w, wide, b]) => tubRing(x, w, b ?? FLOOR, SPEAR(x), wide));
  // The tip's top and upper flanks, below the two-tone line, keep the team colour (no livery): a
  // team arrow over the carbon splitter.
  const tip: Surface = { color: TEAM_PAINT[k.team], metal: PAINT_METAL, rough: PAINT_ROUGH, emissive: 0, kind: CAR_KIND.TRIM };
  const tipTop = (f: number, sp: number): boolean => sp < 3 && (f <= 1 || f >= 5);
  const ramp = tubSt.findIndex(([x]) => x === -46); // the diffuser ramp's first ring (dark team, like its fins)
  facetLoft(k, tub, (f, sp) => (f === 3 ? (sp >= ramp ? dark : TRIM) : tipTop(f, sp) ? tip : paint), [paint, dark], [1, 2, 3, ramp], [0]);

  // Canopy: faceted, low, a hard belt crease over a body-colour band; its glass is one dark band
  // over the windscreen, the sides and the roof; behind it a ridged paint fastback.
  const canSt: (readonly [number, number, number, number, number])[] = [
    [29, 6.8, -9.5, -5.6, -4.0],
    [24, 11.0, -9.5, -3.0, -0.4],
    [16, 13.6, -8, -0.8, 5.0],
    [8, 14.6, -7, 1.0, 9.0],
    ...(hi ? [[0, 15.0, -6, 1.8, 10.8] as const] : []),
    [-8, 14.8, -6, 2.2, 11.2],
    ...(hi ? [[-18, 13.8, -6, 2.5, 10.3] as const] : []),
    [-26, 12.4, -6, 2.6, 8.7],
    ...(hi ? [[-36, 10.2, -6, 2.6, 6.5] as const] : []),
    [-45, 7.8, -6, 2.7, 4.6],
    [-50, 6.0, -6, 2.8, 3.8],
  ];
  const can = canSt.map(([x, w, b, belt, top]) => canopyRing(x, w, b, belt, top));
  const glassEnd = canSt.findIndex(([x]) => x === -26);
  // The glass rounded across its facets (no facet-sized glints), crisp at the belt; the fastback
  // crisp all round, its ridge a spine.
  facetLoft(k, can.slice(0, glassEnd + 1), (f) => (f !== 3 && f !== 4 && f !== 5 ? glass : paint), [paint, paint], [0], [0, 1, 2, 7, 8]);
  facetLoft(k, can.slice(glassEnd), () => paint, [paint, paint]);
  // A short fin on the fastback's ridge.
  k.fin(paint, [[-19, 9.4], [-25, 12.6], [-29, 12.4], [-47, 5.4], [-48.6, 3.4], [-19, 3.4]], 0.8, 'xy', 0);

  // One faceted pod per side, nose to tail.
  const tailX = -58.6;
  const front = archStations(k.wheels.front, 1.2, hi ? 10 : 6, tailX);
  const back = archStations(k.wheels.back, 1.0, hi ? 9 : 6, -57.0);
  const st = (x: number, b: number, o: Partial<PodStation> = {}): PodStation => {
    const zi = o.zi ?? INNER(x);
    const zo = o.zo ?? OUTER(x);
    return { x, xb: x, zi, zo, b, t: SHOULDER(x), tr: RIDGE(x), zr: zi + RIDGE_AT(x) * (zo - zi), yK: KICK(x), scoop: 0, yC: CREASE, ...o };
  };
  // The intake behind the front wheel: rings raked like the windscreen (floor `xb`, top `x`), the
  // lower flank drawn in (the opening) under a top edge falling to a point at the rear.
  const intake = (xb: number, x: number, zo: number, scoop: number, yK: number): PodStation =>
    st(x, FLOOR, { xb, zi: INNER(xb), zo, scoop, yK, yC: yK - 1.0 });
  const stations: PodStation[] = [
    // The knife blades, 2.2 uu thick over open air and the front tyre, swept back to the outer
    // corner (zo); then the fender.
    st(53.6, BLADE),
    st(51.6, BLADE),
    ...front.map((a) => (a.y < BLADE ? st(a.x, BLADE) : st(a.x, a.y, a.x > 45 ? { t: a.y + 2.2 } : {}))),
    st(14.2, FLOOR, { xb: 25.2, zi: 18.4, zo: 38.3 }), // the intake's front edge
    intake(24.4, 13.4, 38.5, 9.0, -4.6),
    intake(19, 8, 39.0, 8.6, -7.0),
    ...(hi ? [intake(13, 3, 39.6, 6.6, -10.2)] : []),
    intake(7, -2, 40.2, 3.6, -13.6),
    intake(2, -5, 41.0, 0.4, -16.6),
    st(-8, FLOOR, { scoop: WAIST(-8) }),
    st(-18, FLOOR, { scoop: WAIST(-18) }),
    ...(hi ? [st(-27, FLOOR, { scoop: WAIST(-27) })] : []),
    ...back.map((a) => st(a.x, a.y)),
    // The tail, bevelled into the dark rear panel, dropping over the rear tyre.
    { ...st(tailX, -9.6, { zi: 16.3, zo: 40.7 }), t: SHOULDER(tailX) - 0.9, tr: RIDGE(tailX) - 0.9 },
  ];
  const spans = stations.length - 1;
  const iB = stations.findIndex((s) => s.x !== s.xb); // the intake's front edge
  const iG = iB + (hi ? 5 : 4); // its last ring, where the opening closes
  const iSweep = stations.findIndex((s) => s.x < 45); // the first ring behind the blades
  const lamp = (sp: number): boolean => stations[sp].x > 45;
  const hard = [iSweep - 1, iB, iB + 1, spans - 1, spans];
  for (const s of [-1, 1]) {
    const rings = stations.map((p) => podRing(p).map(([px, py, pz]): P3 => [px, py, pz * s]));
    facetLoft(
      k,
      rings,
      (f, sp) => {
        if (f === 8) return TRIM; // the floor and the wheel-well liners
        if (sp >= iB && sp < iG && f <= 1) return sp === iB ? wall : f === 0 ? wall : TRIM; // the intake: front and back walls, roof
        if (f === 3) return lamp(sp) ? HEADLIGHT : sp >= spans - 2 ? tail : accent;
        if (sp === spans - 1) return dark; // the bevel round the tail
        return paint;
      },
      [paint, dark],
      hard,
    );

    // The intake's vanes: an upper one in the dark team shade, a lower one lit, from the front wall
    // to where the top edge comes down to them, just inside the opening's lip.
    const kicks = rings.slice(iB + 1, iG + 1).map((r) => r[2]); // the opening's top edge
    const vane = (y: number, surface: Surface, th: number): void => {
      const xf = (flankX(rings[iB], y) + flankX(rings[iB + 1], y)) * 0.5;
      let xr = kicks[kicks.length - 1][0];
      for (let i = 1; i < kicks.length; i++) {
        if (kicks[i][1] <= y + 0.4) {
          const [a, b] = [kicks[i - 1], kicks[i]];
          xr = a[0] + ((b[0] - a[0]) * (y + 0.4 - a[1])) / (b[1] - a[1]);
          break;
        }
      }
      const zf = Math.abs(rings[iB + 1][2][2]);
      const zr = OUTER(xr) - 0.15;
      k.fin(surface, [[xf, s * (zf - 3.4)], [xf, s * (zf - 0.7)], [xr, s * (zr - 0.7)], [xr, s * (zr - 3.0)]], th, 'xz', y);
    };
    vane(-9.0, dark, 0.6);
    vane(-13.4, glow, 0.45);

    // Mirrors on swept arms off the canopy's flanks, low beside it (carbon; their glass faces back).
    k.push(tube(17.4, -2.6, s * 12.4, 14.8, -1.2, s * 15.4, 0.4, 4), CARBON);
    k.fin(CARBON, [[15.8, -2.0], [15.0, 0.1], [12.8, 0.1], [12.6, -1.6], [13.6, -2.2]], 2.4, 'xy', s * 16.2);
    if (hi) k.box(glass, 0.3, 1.6, 2.0, 12.65, -0.8, s * 16.2);

    // The red light blade across the tail.
    k.box(tail, 0.9, 1.6, 21, -58.25, 0.6, s * 29);

    // Louvres: over the rear wheels on the inner top, over the front ones on the outer top (high).
    for (const x of hi ? [-40.5, -43.5, -46.5, -49.5] : [-42, -46.5]) k.box(TRIM, 1.0, 0.6, 8, x, RIDGE(x) - 0.75, s * 23.5);
    if (hi) for (const x of [31, 33.5, 36]) k.box(TRIM, 1.0, 0.6, 7, x, RIDGE(x) - 0.65, s * 31.6);

    // Rear wing: a carbon swan-neck pylon from the deck over the main plane's top, and a swept
    // carbon endplate at its tip, its trailing edge lit.
    k.fin(
      CARBON,
      [
        [-34.5, -0.5],
        [-37.5, 6.5],
        [-39.8, 12.4],
        [-41.6, 16.0],
        [-43.6, 17.4],
        [-50.0, 17.4],
        [-51.6, 16.4],
        [-51.6, 14.6],
        [-46.4, 14.3],
        [-44.4, 14.6],
        [-42.4, 12.0],
        [-40.6, 6.0],
        [-38.2, -0.5],
      ],
      1.6,
      'xy',
      s * 11.5,
    );
    k.fin(CARBON, [[-42.6, 11.4], [-47.0, 17.6], [-58.7, 17.6], [-58.7, 9.4]], 1.0, 'xy', s * 40.4);
    k.box(glow, 0.4, 7.6, 1.2, -58.5, 13.5, s * 40.4);
  }

  // The wing: a faceted section (rounded leading edge) across the car between the endplates, team
  // colour on top, carbon below, and a steeper flap over its trailing edge (high detail).
  const wing = (lx: number, ly: number, chord: number, aoa: number, h: number): void => {
    const d = [-Math.cos(aoa), Math.sin(aoa)] as const;
    const n = [Math.sin(aoa), Math.cos(aoa)] as const;
    const sec: XY = [
      [0, 0],
      [0.22, 0.5],
      [0.7, 0.42],
      [1, 0.1],
      [1, -0.18],
      [0.35, -0.5],
    ];
    const ring = (z: number): P3[] => sec.map(([u, v]) => [lx + u * chord * d[0] + v * h * n[0], ly + u * chord * d[1] + v * h * n[1], z]);
    facetLoft(k, [ring(-40.2), ring(40.2)], (f) => (f <= 2 ? paint : f === 3 ? TRIM : CARBON), [CARBON, CARBON], [], [0]);
  };
  wing(-43.6, 12.6, 13, 0.13, 2.9);
  if (hi) wing(-54.6, 15.3, 4.0, 0.42, 1.0);

  // The splitter's team-lit leading edge under the spear, swept to the pods' inner corners.
  k.fin(
    glow,
    [
      [58.72, -0.9],
      [58.72, 0.9],
      [53.4, 19.0],
      [52.4, 19.0],
      [57.4, 0],
      [52.4, -19.0],
      [53.4, -19.0],
    ],
    0.5,
    'xz',
    FLOOR + 0.25,
  );

  // The diffuser's fins under the ramp, the lowest and rearmost parts, lit at their trailing edges.
  for (const z of [-13, -5, 5, 13]) {
    k.fin(dark, [[-45, FLOOR], [-58.7, FLOOR], [-58.7, -12.2], [-56.0, -9.0], [-45, -16.6]], 0.8, 'xy', z);
    k.box(glow, 0.3, 2.4, 0.6, -58.6, FLOOR + 1.3, z);
  }

  // Twin thrusters as jet exhausts out of the rear panel: heat-tinted housing, a team-lit lip ring
  // and a team-coloured fan in each, exiting at the boost nozzles.
  const { x: nx, y: ny } = k.nozzle;
  const jSeg = hi ? 16 : 10;
  for (const side of [-1, 1]) {
    const z = side * k.nozzle.z;
    const housing = new THREE.CylinderGeometry(4.4, 4.8, 3.2, jSeg, 1, false);
    housing.rotateZ(Math.PI / 2);
    housing.translate(nx + 1.6, ny, z);
    k.push(housing, EXHAUST);
    const cone = new THREE.ConeGeometry(3.4, 0.7, jSeg);
    cone.rotateZ(Math.PI / 2);
    cone.translate(nx - 0.35, ny, z);
    k.push(cone, fan);
    const lip = new THREE.TorusGeometry(3.9, 0.55, hi ? 4 : 3, hi ? 16 : 10);
    lip.rotateY(Math.PI / 2);
    lip.translate(nx + 0.05, ny, z);
    k.push(lip, glow);
  }
}

export const PAMPERO: CarBodySpec = {
  id: 'pampero',
  build,
  // The front track inside the rear's (the front pods narrower than the haunches: an arrow in
  // plan), the rear tyres tucked 2 uu under the haunches.
  wheels: { style: TURBINE, visual: 1.04, outer: 36.8, width: 1.0, rear: { visual: 1.06, outer: 39.6, width: 1.02 } },
  // Car-local uu (the build frame + (13.88, 20.76, 0)): the two-tone line on the flanks' crease
  // (CREASE, build -12.26); one seam, the engine cover's, across the fastback (build -32).
  livery: {
    twoToneY: 8.5,
    pinstripe: 0.4,
    chevrons: null,
    seams: { x: [-18.1, -18.1], maxZ: 12 },
    accent: ICE,
    chevronTint: 0,
    grime: { y0: 9.5, y1: 4, amount: 0.4 },
    ao: { y0: 3, y1: 12 },
    heat: { x: BOOST_NOZZLE_X, length: 6.5 },
  },
  budget: { low: 2000, high: 3500 },
};

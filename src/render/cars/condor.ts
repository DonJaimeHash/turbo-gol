/**
 * The Cóndor ('condor'): an aero jet racer after the Andean condor gliding. A low lofted fuselage
 * with a cab-forward bubble canopy that runs back into a tapering spine, a white collar behind the
 * glass (the condor's ruff) and a tall swept dorsal fin over the tail; teardrop wheel pods faired
 * over the tops of all four wheels, the front pair tied to the nose by canards, the rear pair to
 * the fuselage by swept delta wings (their tips at the supersonic streaks' flank, |z| ~40); jet
 * intakes on the flanks (high detail); twin faceted afterburner nozzles at the boost nozzles with a
 * team glow ring on each lip. Team glow lamp seams trace the panel lines: the crest of each pod,
 * the wing leading edges, the spine and both edges of the fin, so from the chase camera the car is
 * two rings, a lit fin and four light lines. Slit headlights on the front pods, tail-light bars on
 * dark panels on the rear pods. Paint is team colour all over above a low two-tone line (gloss
 * carbon under it) with an ice-white pinstripe, two panel grooves and no chevrons. Wheels: slick
 * tyres on dark aero disc covers with seven thin turbine vanes, a light ring, six bolts (high) and
 * a team hub; the rear ones bigger and wider (a raked stance).
 *
 * Designed on the default hitbox in the build frame (kit.hl / hh / hw 58.75 / 17.83 / 41.85):
 * nose 58.6, nozzle exit -58, fin top 17.3, body floor -17.6, pods out to |z| 41.7. Within the
 * dune runner's triangles on both details (docs/cars.md Budgets): its geometry is not pinned, but
 * the part order is the vertex order, so keep it.
 */
import * as THREE from 'three/webgpu';
import { BOOST_NOZZLE_X, CAR_KIND, DISC, EXHAUST, HEADLIGHT, TAILLIGHT, TRIM, TWO_PI, loft, section } from './kit';
import type { BodyKit, CarBodySpec, Ring, Surface, WheelStyle } from './types';

type V3 = readonly [number, number, number];

/** A section ring across the car (kit section) with its own superellipse exponent. */
function sec(x: number, w: number, y0: number, y1: number, zc: number, n: number): Ring {
  return { ...section(x, w, y0, y1, zc), n };
}

/**
 * The point at angle `a` (0 = +z, pi / 2 = the top) on the polygon `loft` draws for ring (x, w, y0,
 * y1, zc) of exponent `n` with `seg` points, moved `out` uu outwards: where a seam lies on a part.
 */
function onRing(x: number, w: number, y0: number, y1: number, zc: number, n: number, seg: number, a: number, out: number): V3 {
  const step = TWO_PI / seg;
  const j = Math.floor(a / step);
  const t = a / step - j;
  const e = 2 / n;
  const yc = (y0 + y1) * 0.5;
  const hv = (y1 - y0) * 0.5;
  const pt = (k: number): [number, number] => {
    const c = Math.cos(k * step);
    const s = Math.sin(k * step);
    return [Math.sign(c) * Math.pow(Math.abs(c), e) * w, Math.sign(s) * Math.pow(Math.abs(s), e) * hv];
  };
  const [u0, v0] = pt(j);
  const [u1, v1] = pt(j + 1);
  const u = u0 + (u1 - u0) * t;
  const v = v0 + (v1 - v0) * t;
  const l = Math.hypot(u / w, v / hv) || 1;
  return [x, yc + v + (out * (v / hv)) / l, zc + u + (out * (u / w)) / l];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * A closed round strand of radius `r` through `pts` (a lamp seam laid along a panel line): a loft of
 * rings square to the path. `ref` is any direction never along the path (it orients the rings).
 */
function strand(pts: readonly V3[], r: number, seg: number, ref: V3 = [0, 1, 0]): THREE.BufferGeometry {
  const rings: Ring[] = pts.map((p, i) => {
    const t = unit(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)]));
    const u = unit(cross(ref, t));
    return { o: p, u, v: cross(t, u), hu: r, hv: r };
  });
  return loft(rings, seg, 2);
}

/** Flat-shaded copy (each face its own normal): the afterburner petals. */
function faceted(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const f = g.toNonIndexed();
  g.dispose();
  f.deleteAttribute('normal');
  f.computeVertexNormals();
  return f;
}

// Every table is in the build frame (hitbox-centred uu, +x forward, +y up, +z right).
// Fuselage, nose to tail: x, half width, y0, y1, superellipse exponent.
const FUSE: readonly (readonly [number, number, number, number, number])[] = [
  [58.6, 1.4, -13.1, -11.5, 2.2],
  [57.4, 4.2, -14.6, -9.8, 2.4],
  [55.6, 6.6, -15.6, -8.2, 2.6],
  [52.5, 9.0, -16.4, -6.0, 2.8],
  [45, 12.0, -17.1, -3.4, 3],
  [35, 14.2, -17.4, -1.0, 3],
  [23, 15.4, -17.5, 1.0, 3],
  [8, 16.0, -17.5, 2.2, 3],
  [-8, 16.0, -17.5, 2.6, 3],
  [-24, 15.4, -17.4, 2.8, 3],
  [-38, 14.4, -16.8, 3.2, 3],
  [-47, 13.4, -14.6, 3.8, 3],
  [-52.6, 12.2, -8.6, 4.4, 3],
];
// Canopy and spine: x, half width, equator y (sunk into the fuselage below it), top y.
const CAB: readonly (readonly [number, number, number, number])[] = [
  [38, 2.4, -2.6, -0.6],
  [34, 7.0, -2.2, 4.6],
  [27, 10.4, -1.6, 9.2],
  [18, 11.8, -1.0, 11.6],
  [8, 11.6, -0.4, 12.0],
  [-2, 10.2, 0.0, 10.8],
  [-8, 8.8, 0.3, 9.4],
  [-11, 8.0, 0.5, 8.6],
  [-22, 6.2, 1.0, 7.4],
  [-36, 4.8, 1.4, 6.6],
  [-48, 3.8, 1.8, 6.0],
  [-55.5, 2.6, 2.2, 5.2],
];
const GLASS_END = -8;
const COLLAR_END = -11;
// Front wheel pods (centre z FRONT_Z): x, half width, y0, y1.
const FRONT_Z = 29.5;
const FRONT_N = 3.4;
const FRONT_POD: readonly (readonly [number, number, number, number])[] = [
  [57.8, 4.0, -15.8, -12.6],
  [55, 8.0, -16.9, -9.4],
  [49, 10.2, -17.4, -6.6],
  [38, 10.8, -17.5, -5.4],
  [27, 10.4, -17.5, -6.4],
  [18, 8.6, -17.0, -8.0],
  [8, 6.4, -15.8, -10.0],
  [0, 3.0, -13.6, -11.0],
];
// Rear wheel pods (centre z REAR_Z): the rear tyres are bigger and wider (CONDOR.wheels.rear).
const REAR_Z = 29.2;
const REAR_N = 4;
const REAR_POD: readonly (readonly [number, number, number, number])[] = [
  [-21, 3.4, -14.0, -9.6],
  [-25, 9.0, -16.6, -5.0],
  [-31, 11.8, -17.5, -1.6],
  [-40, 12.5, -17.6, 0.8],
  [-48, 12.5, -17.6, 1.0],
  [-54, 12.1, -17.2, -0.2],
  [-58.3, 10.8, -16.2, -3.4],
];
// Delta wings: z, leading edge x, trailing edge x, centre y, half thickness.
const WING: readonly (readonly [number, number, number, number, number])[] = [
  [12, 20, -44, -11.2, 2.6],
  [26, 4, -38, -11.6, 2.0],
  [39.5, -12, -30, -12.0, 1.3],
];
// Dorsal fin: y, chord centre x, half chord, half thickness.
const FIN: readonly (readonly [number, number, number, number])[] = [
  [2.0, -42, 15, 2.4],
  [8, -45.5, 11.5, 1.9],
  [13.5, -49.5, 7.5, 1.3],
  [17.3, -53, 4.0, 0.7],
];
// Canards from the nose to the front pods: z, leading edge x, trailing edge x, centre y, half thickness.
const CANARD: readonly (readonly [number, number, number, number, number])[] = [
  [6, 51, 35, -12.4, 1.7],
  [22, 45, 33, -12.0, 1.1],
];

// Jet intakes on the fuselage flanks behind the canopy (centre z INTAKE_Z): x, half width, y0, y1.
const INTAKE_Z = 16.2;
const INTAKE: readonly (readonly [number, number, number, number])[] = [
  [-1, 2.4, -6.2, -0.6],
  [-5, 3.0, -6.8, 0.0],
  [-15, 2.6, -6.4, -0.6],
  [-25, 0.8, -4.4, -2.8],
];

/** The collar behind the canopy: white satin trim (no livery). */
const WHITE_TRIM: Surface = { color: 0xe6eaf0, metal: 0.1, rough: 0.4, emissive: 0, kind: CAR_KIND.TRIM };

function build(k: BodyKit): void {
  const { hi, paint, glass, strip } = k;
  const podSeg = hi ? 16 : 10;

  // Fuselage: the nose cone to the tail round the thrusters, its tail face dark.
  k.pushBy(
    loft(FUSE.map(([x, w, y0, y1, n]) => sec(x, w, y0, y1, 0, n)), hi ? 20 : 12, 3),
    (x, _y, _z, nx) => (x < -52 && nx < -0.9 ? TRIM : paint),
  );

  // Canopy flowing back into the spine: glass, a white collar, then paint.
  k.pushBy(
    loft(
      CAB.map(([x, w, yEq, yTop]) => ({ o: [x, yEq, 0], u: [0, 0, 1], v: [0, 1, 0], hu: w, hv: yTop - yEq, hvNeg: 4.5 }) as Ring),
      hi ? 18 : 10,
      2.2,
    ),
    (x) => (x > GLASS_END ? glass : x > COLLAR_END ? WHITE_TRIM : paint),
  );

  // Jet intakes on the flanks behind the canopy, their mouths dark (high detail: too small to
  // read on the low tiers).
  if (hi) {
    for (const side of [-1, 1]) {
      k.pushBy(loft(INTAKE.map(([x, w, y0, y1]) => sec(x, w, y0, y1, side * INTAKE_Z, 2.6)), 10, 2.6), (_x, _y, _z, nx) => (nx > 0.6 ? DISC : paint));
    }
  }

  // Wheel pods faired over the tops of the wheels, the canards and the delta wings joining them
  // to the fuselage.
  for (const side of [-1, 1]) {
    k.push(loft(FRONT_POD.map(([x, w, y0, y1]) => sec(x, w, y0, y1, side * FRONT_Z, FRONT_N)), podSeg, FRONT_N), paint);
    k.push(loft(REAR_POD.map(([x, w, y0, y1]) => sec(x, w, y0, y1, side * REAR_Z, REAR_N)), podSeg, REAR_N), paint);
    const span = (t: readonly (readonly [number, number, number, number, number])[]): Ring[] =>
      t.map(([z, le, te, yc, hv]) => ({ o: [(le + te) * 0.5, yc, side * z], u: [1, 0, 0], v: [0, 1, 0], hu: (le - te) * 0.5, hv }));
    k.push(loft(span(WING), hi ? 12 : 6, 2), paint);
    k.push(loft(span(CANARD), hi ? 10 : 4, 2), paint);
  }

  // Dorsal fin on the spine.
  k.push(
    loft(
      FIN.map(([y, xc, hu, hv]) => ({ o: [xc, y, 0], u: [1, 0, 0], v: [0, 0, 1], hu, hv }) as Ring),
      hi ? 12 : 6,
      2,
    ),
    paint,
  );

  // Twin afterburners at the boost nozzles: a faceted petal housing (a closed lathe ring: outer
  // skin, lip, bore), a dark throat at the bottom of the bore and a team glow ring on the lip.
  const { x: nx, y: ny } = k.nozzle;
  const nSeg = hi ? 12 : 8;
  for (const side of [-1, 1]) {
    const z = side * k.nozzle.z;
    const lathe = new THREE.LatheGeometry(
      [new THREE.Vector2(5.2, 0), new THREE.Vector2(5.0, 3), new THREE.Vector2(4.5, 7), new THREE.Vector2(3.5, 7), new THREE.Vector2(3.1, 2.8), new THREE.Vector2(5.2, 0)],
      nSeg,
    );
    lathe.rotateZ(Math.PI / 2); // the lathe's +y (the exit) to -x
    lathe.translate(nx + 7, ny, z);
    k.push(faceted(lathe), EXHAUST);
    const throat = new THREE.CircleGeometry(3.3, nSeg);
    throat.rotateY(-Math.PI / 2);
    throat.translate(nx + 4.2, ny, z);
    k.push(throat, DISC);
    const ring = new THREE.TorusGeometry(3.95, 0.68, 4, nSeg);
    ring.rotateY(Math.PI / 2);
    ring.translate(nx + 0.05, ny, z);
    k.push(ring, strip);
  }

  // Lamp seams (team glow) along the panel lines: the wing leading edges, the crest of each pod,
  // the fin's trailing edge, the spine and the fin's leading edge. Six-sided on high (the bloom
  // widens them); on low a wider diamond, its ridge standing out of the panel, so a seam still
  // reads without bloom.
  const sSeg = hi ? 6 : 4;
  const sR = hi ? 0.5 : 0.62;
  const sIn = hi ? 0 : -0.1;
  const top = Math.PI / 2;
  for (const side of [-1, 1]) {
    const [w0, , w2] = WING;
    const le = (t: number): V3 => [w0[1] + (w2[1] - w0[1]) * t, w0[3] + (w2[3] - w0[3]) * t, side * (w0[0] + (w2[0] - w0[0]) * t)];
    k.push(strand([le(0.1), le(0.985)], sR, sSeg), strip);
    k.push(strand(REAR_POD.slice(1, -1).map(([x, w, y0, y1]) => onRing(x, w, y0, y1, side * REAR_Z, REAR_N, podSeg, top, sIn)), sR, sSeg), strip);
    k.push(strand(FRONT_POD.slice(1, -1).map(([x, w, y0, y1]) => onRing(x, w, y0, y1, side * FRONT_Z, FRONT_N, podSeg, top, sIn)), sR, sSeg), strip);
  }
  k.push(
    strand(
      [
        [-57.15, 3.0, 0],
        [-57.15, 16.9, 0],
      ],
      sR + 0.05,
      sSeg,
      [0, 0, 1],
    ),
    strip,
  );
  // ...and from the collar along the spine and up the fin's leading edge.
  k.push(
    strand(
      [
        [-11.6, 8.55, 0],
        [-22, 7.35, 0],
        [-31.6, 6.85, 0],
        [-34.0, 8.0, 0],
        [-42.0, 13.5, 0],
        [-48.7, 16.95, 0],
      ],
      sR - 0.05,
      sSeg,
      [0, 0, 1],
    ),
    strip,
  );

  // Lamps: slit headlights on the front pods, tail-light bars on the rear pods.
  for (const side of [-1, 1]) {
    k.box(HEADLIGHT, 0.8, 1.4, 5.6, 58.2, -14.2, side * FRONT_Z);
    k.box(TRIM, 0.4, 5.2, 16, -58.35, -8.6, side * REAR_Z);
    k.box(TAILLIGHT, 0.4, 1.3, 14, -58.5, -7.2, side * REAR_Z);
  }
}

/**
 * Slick tyres on aero disc covers: a dark disc flush with the tyre faces (dish 1), seven thin vanes
 * standing proud of it, a light ring round it, six bolts on high and a team-paint hub.
 */
export const CONDOR_AERO: WheelStyle = {
  id: 'condor-aero',
  tyre: 'slick',
  spokes: 7,
  spokeWidth: 0.1,
  dish: 1.0,
  dishColor: 0x1d2128,
  rim: 0x3a414c,
  rimFinish: { metal: 0.75, rough: 0.34 },
  bead: 0xdfe6f0,
  bolts: 6,
  hub: 'team',
  budget: { low: 364, high: 688 },
};

export const CONDOR: CarBodySpec = {
  id: 'condor',
  build,
  wheels: { style: CONDOR_AERO, visual: 1.08, outer: 38.5, rear: { visual: 1.16, outer: 40, width: 1.25 } },
  // Car-local uu (the build frame + (13.88, 20.76, 0)): the two-tone line at build y -14.3, the
  // grooves across the nose deck (build x 45) and the rear deck (build x -30).
  livery: {
    twoToneY: 6.5,
    pinstripe: 0.35,
    chevrons: null,
    seams: { x: [58.9, -16.1], maxZ: 14 },
    accent: 0xe9eef5,
    chevronTint: 0,
    grime: { y0: 9, y1: 3, amount: 0.45 },
    ao: { y0: 2, y1: 13 },
    heat: { x: BOOST_NOZZLE_X, length: 7 },
  },
  budget: { low: 2000, high: 3500 },
};

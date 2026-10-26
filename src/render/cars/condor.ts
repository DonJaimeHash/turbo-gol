/**
 * The Cóndor ('condor'): an aero jet racer after the Andean condor gliding. A low lofted fuselage
 * ending in a sharp white beak hooked down to a point (the ruff's white), a cab-forward bubble
 * canopy, a proud white ruff behind the glass and a low spine running back to a tall swept dorsal
 * fin (an ice-white leading edge) with a T-tail; the fuselage ends in a dark engine bay, twin
 * near-black satin petal afterburners standing out of it (a team glow rim, a near-black bore, a
 * team glowing core inside). One side body per side faired over both wheels: a front fender and a
 * raised rear haunch, each with a real wheel opening over its tyre (a carbon liner under it),
 * joined low by a rocker sill; above the sill a dihedral delta wing (white secondary-feather band
 * on top, carbon below) runs from the fuselage to the haunch. Each haunch ends in a painted bevel
 * round a dark tail-lamp housing with a red slit across its top: the tail lights sit outboard,
 * over the rear tyres, and the carbon valance between the tyres stays unlit. Team glow lamp lines:
 * along the nose's ridge from the canopy down to the beak, along each fender's crest, from each
 * wing's root along its leading edge and on along the haunch's shoulder to the tail bevel, along
 * the spine from the ruff to the fin and across the T-tail's trailing edge. Swept slash headlights
 * on the fenders' inboard crests. Paint is team colour above a low two-tone line (gloss carbon
 * below it, along the sills) with an ice-white pinstripe, two panel grooves and no chevrons.
 * Wheels: slick tyres on dark aero disc covers with five light turbine vanes, a light ring, six
 * bolts (high) and a team hub; the rear ones a little bigger.
 *
 * Designed on the default hitbox in the build frame (kit.hl / hh / hw 58.75 / 17.83 / 41.85):
 * beak 58.6, nozzle exit -58, T-tail top 16.7, body floor -17.6, haunches out to |z| 41.7. The
 * wheel openings follow the body's own wheels (k.wheels), 2.5 uu over the front tyres (steering)
 * and 1.9 over the rear ones. Within the dune runner's triangles on both details (docs/cars.md
 * Budgets): its geometry is not pinned, but the part order is the vertex order, so keep it. On low
 * detail (no bloom) the lamps run cooler, so they keep the team hue instead of clipping to white,
 * and the lamp lines are wide flat strips standing off the panels, their top lit and their bevels
 * dark (a red lamp on red paint needs the dark edge).
 */
import * as THREE from 'three/webgpu';
import { BOOST_NOZZLE_X, CAR_KIND, CARBON, EXHAUST, HEADLIGHT, TAILLIGHT, TRIM, TWO_PI, loft, section } from './kit';
import type { BodyKit, CarBodySpec, Ring, Surface, WheelAt, WheelStyle } from './types';

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
 * A closed strand through `pts` (a lamp line laid along a panel line): a loft of rings square to
 * the path, half width `hu` along cross(ref, path) and half height `hv` across it. `ref` is any
 * direction never along the path (it orients the rings).
 */
function strand(pts: readonly V3[], hu: number, hv: number, seg: number, ref: V3 = [0, 1, 0]): THREE.BufferGeometry {
  const rings: Ring[] = pts.map((p, i) => {
    const t = unit(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)]));
    const u = unit(cross(ref, t));
    return { o: p, u, v: cross(t, u), hu, hv };
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
/** The body's floor (the hitbox floor is -17.83). */
const FLOOR = -17.6;
// Fuselage, beak to tail: x, half width, y0, y1, superellipse exponent (under 2 at the beak: a
// ridge on top). The tip hooks down; the tail is a wide dark engine bay the afterburners leave.
const FUSE: readonly (readonly [number, number, number, number, number])[] = [
  [58.6, 0.5, -17.3, -16.5, 1.8],
  [57.6, 2.2, -16.4, -12.6, 1.7],
  [55.2, 4.4, -15.6, -8.8, 1.8],
  [52.5, 8.6, -16.6, -5.6, 2.3],
  [46, 11.6, -17.1, -3.0, 2.8],
  [36, 14.0, -17.4, -1.2, 3],
  [22, 15.6, -17.5, 0.8, 3],
  [4, 16.0, -17.5, 2.2, 3],
  [-16, 15.8, -17.5, 2.8, 3],
  [-34, 15.4, -17.4, 3.0, 3],
  [-46, 15.0, -17.0, 3.2, 3.2],
  [-54, 14.6, -16.2, 3.4, 3.4],
];
/** The white beak runs forward of this x (a FUSE ring); the engine bay is the fuselage's tail face. */
const BEAK_X = 55.2;
const TAIL_X = -54;
// Canopy and ruff: x, half width, equator y (sunk CAB_FLOOR into the fuselage), top y. The ruff
// stands proud of the glass and of the spine.
const CAB: readonly (readonly [number, number, number, number])[] = [
  [47, 2.4, -3.4, -1.4],
  [43, 7.0, -3.0, 3.8],
  [36, 10.4, -2.4, 8.6],
  [27, 11.8, -1.6, 11.2],
  [17, 11.6, -0.8, 11.8],
  [6, 10.0, -0.2, 10.4],
  [1.5, 9.0, 0.2, 9.2],
  [0.6, 10.8, 0.3, 11.2],
  [-1.6, 10.4, 0.4, 10.6],
  [-3.4, 7.4, 0.5, 7.6],
];
// The spine, from inside the ruff to the tail, kept low so the fin stands tall.
const SPINE: readonly (readonly [number, number, number, number])[] = [
  [-2.6, 6.0, 0.6, 6.6],
  [-10, 5.4, 0.8, 5.8],
  [-26, 4.4, 1.2, 4.9],
  [-44, 3.6, 1.5, 4.3],
  [-53.6, 2.6, 1.7, 4.0],
];
const CAB_N = 2.2;
const CAB_FLOOR = 4.5;
const GLASS_END = 1.5;
// One side body per side, nose to tail (the left mirrors the right): x, centre |z|, half width,
// floor y before the wheel openings are cut, top y. A blade nose, the front fender, the low rocker
// sill, the raised rear haunch; the openings (archY) lift the floor over each wheel.
const SIDE: readonly (readonly [number, number, number, number, number])[] = [
  [57.6, 28.6, 3.2, -16.2, -13.8],
  [55.6, 29.2, 7.2, -17.3, -10.4],
  [52.6, 29.5, 9.6, FLOOR, -7.0],
  [46, 29.5, 10.8, FLOOR, -4.2],
  [37.4, 29.5, 10.9, FLOOR, -2.8],
  [28, 29.2, 10.6, FLOOR, -4.0],
  [21, 27.4, 10.0, FLOOR, -7.4],
  [12, 25.0, 9.3, FLOOR, -10.2],
  [-12, 25.0, 9.3, FLOOR, -10.2],
  [-21, 27.6, 10.2, FLOOR, -6.0],
  [-30, 30.2, 11.0, FLOOR, -1.0],
  [-40, 30.7, 11.0, FLOOR, 2.8],
  [-48, 30.7, 11.0, FLOOR, 3.8],
  [-54, 30.6, 10.8, FLOOR, 2.6],
  [-58.3, 30.4, 10.2, FLOOR, 0.2],
];
const SIDE_N = 3;
/** The side body's fixed rings (the openings add theirs): the nose, the sill. */
const SIDE_NOSE = [57.6, 55.6, 52.6];
const SIDE_SILL = [21, 12, -12, -21];
const SIDE_TAIL = -58.3;
/** The haunch's tail face: a painted bevel this deep (x) and this far in (width, height) round a dark lamp housing. */
const TAIL_BEVEL = 1.2;
const TAIL_INSET = 1.3;
/** Opening clearance over the tyre (uu): the front tyres steer. */
const FRONT_GAP = 2.5;
const REAR_GAP = 1.9;
// Delta wings, dihedral (~8 deg): |z|, leading edge x, trailing edge x, centre y, half thickness.
// A thick root faired into the fuselage; the tip runs into the rear haunch's shoulder.
const WING: readonly (readonly [number, number, number, number, number])[] = [
  [13, 14, -30, -7.8, 3.6],
  [22, 2, -28.5, -6.6, 2.3],
  [30, -9.5, -27.5, -5.4, 1.5],
  [36.5, -19.5, -29, -4.3, 0.9],
];
// Dorsal fin: y, chord centre x, half chord, half thickness (a fillet into the spine). Its root
// ends ahead of the tail face, so nothing overhangs.
const FIN: readonly (readonly [number, number, number, number])[] = [
  [2.0, -39.8, 13.8, 3.2],
  [6.0, -42.6, 10.8, 1.9],
  [11.0, -46.4, 7.4, 1.15],
  [15.2, -49.6, 4.9, 0.8],
];
// T-tail on the fin: |z|, chord centre x, half chord, y, half thickness.
const TAIL: readonly (readonly [number, number, number, number, number])[] = [
  [9.5, -53.0, 2.9, 16.0, 0.55],
  [0, -50.6, 5.4, 15.7, 1.0],
];
// Afterburner profile: radius, distance aft of the housing's front (BURNER_LEN ahead of the exit),
// petal (alternating +-PETAL round the housing on high). Out of the engine bay a tapering housing,
// a waist, a flared lip (its outer rim glows), a dark inner lip, then the bore back to a dark end
// with a glowing core, BURNER_CORE inside the lip.
const BURNER_LEN = 8.5;
const BURNER_CORE = 2.5;
const BURNER_HI: readonly (readonly [number, number, boolean])[] = [
  [3.2, 0, false],
  [4.8, 1.4, true],
  [5.5, 4.5, true],
  [4.85, 7.4, true],
  [5.4, 8.5, false],
  [5.05, 8.5, false],
  [4.4, 8.5, false],
  [4.0, 7.7, false],
  [3.8, BURNER_LEN - BURNER_CORE, false],
];
const BURNER_LO: readonly (readonly [number, number, boolean])[] = [
  [3.2, 0, false],
  [5.5, 4.5, false],
  [4.85, 7.4, false],
  [5.4, 8.5, false],
  [5.05, 8.5, false],
  [4.4, 8.5, false],
  [3.8, BURNER_LEN - BURNER_CORE, false],
];
/** The lip's glowing rim: the exit face outside this radius (between the rim's and the inner lip's triangles). */
const LIP_R = 4.9;
/** The hot core's radius, on the dark end of the bore. */
const CORE_R = 2.4;
const PETAL = 0.3;

/** The ruff, the fin's leading edge and the wings' secondary-feather bands: white satin trim (no livery). */
const WHITE_TRIM: Surface = { color: 0xe6eaf0, metal: 0.1, rough: 0.4, emissive: 0, kind: CAR_KIND.TRIM };
/** The afterburner petals: near-black satin gunmetal, rough enough that no facet glints (the heat tint stays at the lip). */
const PETALS: Surface = { ...EXHAUST, color: 0x181b20, metal: 0.55, rough: 0.62 };
/** The afterburners' bores: near black. */
const THROAT: Surface = { color: 0x0b0d10, metal: 0.3, rough: 0.6, emissive: 0, kind: CAR_KIND.DARK_METAL };

/** A wheel opening: the centre of the wheel at rest and the opening's radius. */
interface Opening {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

function opening(w: WheelAt, gap: number): Opening {
  return { x: w.x, y: w.y, r: w.radius + gap };
}

/** The opening's edge height at `x` (-Infinity clear of it). */
function archY(o: Opening, x: number): number {
  const dx = x - o.x;
  return Math.abs(dx) < o.r ? o.y + Math.sqrt(o.r * o.r - dx * dx) : -Infinity;
}

/** `n` x stations round the opening's edge, from where it leaves the floor in front to behind (or to xMin). */
function archXs(o: Opening, n: number, xMin: number): number[] {
  const a0 = Math.asin(Math.min(1, (FLOOR - o.y) / o.r));
  let a1 = Math.PI - a0;
  if (o.x + o.r * Math.cos(a1) < xMin) a1 = Math.acos((xMin - o.x) / o.r);
  return Array.from({ length: n }, (_, i) => o.x + o.r * Math.cos(a0 + ((a1 - a0) * i) / (n - 1)));
}

/** The SIDE table at `x` (linear between its rows): centre |z|, half width, floor y, top y. */
function sideAt(x: number): readonly [number, number, number, number] {
  let i = 0;
  while (i < SIDE.length - 2 && SIDE[i + 1][0] > x) i++;
  const a = SIDE[i];
  const b = SIDE[i + 1];
  const t = Math.min(1, Math.max(0, (a[0] - x) / (a[0] - b[0])));
  const l = (j: number): number => a[j] + (b[j] - a[j]) * t;
  return [l(1), l(2), l(3), l(4)];
}

/** A side body section: x, centre |z|, half width, y0, y1. */
type SideRing = readonly [number, number, number, number, number];

/** The side body's rings with both wheel openings cut, nose to tail. */
function sideRings(front: Opening, rear: Opening, hi: boolean): SideRing[] {
  const xs = [...SIDE_NOSE, ...archXs(front, hi ? 7 : 5, -Infinity), ...SIDE_SILL, ...archXs(rear, hi ? 6 : 4, SIDE_TAIL + TAIL_BEVEL)];
  const rings: SideRing[] = xs.map((x) => {
    const [zc, w, y0, y1] = sideAt(x);
    return [x, zc, w, Math.max(y0, archY(front, x), archY(rear, x)), y1];
  });
  // The bevel round the tail face: the last ring again, smaller, at the tail.
  const [, zc, w, y0, y1] = rings[rings.length - 1];
  rings.push([SIDE_TAIL, zc, w - TAIL_INSET, y0 + TAIL_INSET, y1 - TAIL_INSET]);
  return rings;
}

function build(k: BodyKit): void {
  const { hi, paint, glass } = k;
  // Lamps without bloom (low detail) run cooler, so they keep the team hue instead of clipping white.
  const strip: Surface = hi ? k.strip : { ...k.strip, emissive: 0.55 };
  const tail: Surface = hi ? { ...TAILLIGHT, emissive: 1.5 } : { ...TAILLIGHT, color: 0xff0d16, emissive: 0.4 };
  const core: Surface = { ...k.strip, emissive: hi ? 0.6 : 0.3 };

  // Fuselage: the beak (a white hooked tip) to the engine bay (its dark tail face).
  const fuseSeg = hi ? 20 : 10;
  k.pushBy(
    loft(FUSE.map(([x, w, y0, y1, n]) => sec(x, w, y0, y1, 0, n)), fuseSeg, 3),
    (x, _y, _z, nx) => (x > BEAK_X ? WHITE_TRIM : x < TAIL_X + 0.5 && nx < -0.9 ? TRIM : paint),
  );

  // Canopy with the white ruff behind the glass, then the low spine.
  const cabRing = ([x, w, yEq, yTop]: readonly [number, number, number, number]): Ring => ({ o: [x, yEq, 0], u: [0, 0, 1], v: [0, 1, 0], hu: w, hv: yTop - yEq, hvNeg: CAB_FLOOR });
  k.pushBy(loft(CAB.map(cabRing), hi ? 18 : 10, CAB_N), (x) => (x > GLASS_END ? glass : WHITE_TRIM));
  k.push(loft(SPINE.map(cabRing), hi ? 8 : 6, CAB_N), paint);

  // Side bodies: fender, sill and haunch in one loft, the wheel openings lined in carbon, the
  // haunches' tail faces dark like the engine bay between them.
  const front = opening(k.wheels.front, FRONT_GAP);
  const rear = opening(k.wheels.back, REAR_GAP);
  const rings = sideRings(front, rear, hi);
  const sideSeg = hi ? 14 : 8;
  for (const side of [-1, 1]) {
    k.pushBy(
      loft(
        rings.map(([x, zc, w, y0, y1]) => sec(x, w, y0, y1, side * zc, SIDE_N)),
        sideSeg,
        SIDE_N,
      ),
      (x, y, _z, nx, ny) => (ny < -0.3 && y > FLOOR + 1.5 ? CARBON : x < SIDE_TAIL + 0.5 && nx < -0.9 ? TRIM : paint),
    );
  }

  // Wings from the fuselage over the sills into the haunches: paint, a white band on the outer
  // half's trailing half, carbon below.
  for (const side of [-1, 1]) {
    k.pushBy(
      loft(
        WING.map(([z, le, te, yc, hv]) => ({ o: [(le + te) * 0.5, yc, side * z], u: [1, 0, 0], v: [0, 1, 0], hu: (le - te) * 0.5, hv }) as Ring),
        hi ? 8 : 4,
        2,
      ),
      (_x, _y, z, nx, ny) => (ny < -0.3 ? CARBON : ny > 0.2 && nx < 0.05 && Math.abs(z) > 21 ? WHITE_TRIM : paint),
    );
  }

  // Dorsal fin and the T-tail on top of it. The fin's leading-edge facets (the ring segments either
  // side of +u, the loft's segments 0 and seg - 1 along each band) are ice white: a panel 0.19 of
  // the chord deep on high, half of it on low, where it has to read at 640 x 360.
  const finSeg = hi ? 10 : 6;
  const finSides = (FIN.length - 1) * 2 * finSeg;
  let finT = 0;
  k.pushBy(
    loft(
      FIN.map(([y, xc, hu, hv]) => ({ o: [xc, y, 0], u: [1, 0, 0], v: [0, 0, 1], hu, hv }) as Ring),
      finSeg,
      2,
    ),
    () => {
      const j = Math.floor((finT % (2 * finSeg)) / 2);
      const le = finT < finSides && (j === 0 || j === finSeg - 1);
      finT++;
      return le ? WHITE_TRIM : paint;
    },
  );
  k.push(
    loft(
      [TAIL[0], TAIL[1], TAIL[0]].map(([z, xc, hu, y, hv], i) => ({ o: [xc, y, (i - 1) * z], u: [1, 0, 0], v: [0, 1, 0], hu, hv }) as Ring),
      hi ? 8 : 4,
      2,
    ),
    paint,
  );

  // Twin afterburners at the boost nozzles, out of the engine bay: a faceted gunmetal petal
  // housing (EXHAUST) with a team glow rim, a near-black bore and a glowing core at its end.
  const { x: nX, y: nY, z: nZ } = k.nozzle;
  const nSeg = hi ? 12 : 8;
  const prof = hi ? BURNER_HI : BURNER_LO;
  for (const side of [-1, 1]) {
    const zN = side * nZ;
    const g = new THREE.LatheGeometry(
      prof.map(([r, h]) => new THREE.Vector2(r, h)),
      nSeg,
    );
    const pos = g.attributes.position;
    for (let i = 0; i <= nSeg; i++) {
      for (let j = 0; j < prof.length; j++) {
        const [r, , petal] = prof[j];
        if (!petal) continue;
        const f = (r + (i % 2 === 0 ? PETAL : -PETAL)) / r;
        const v = i * prof.length + j;
        pos.setX(v, pos.getX(v) * f);
        pos.setZ(v, pos.getZ(v) * f);
      }
    }
    g.rotateZ(Math.PI / 2); // the lathe's +y (aft distance) to -x
    g.translate(nX + BURNER_LEN, nY, zN);
    k.pushBy(faceted(g), (_x, y, z, fx, fy, fz) => {
      const dy = y - nY;
      const dz = z - zN;
      if (fx < -0.85) return dy * dy + dz * dz > LIP_R * LIP_R ? strip : THROAT;
      return dy * fy + dz * fz < 0 ? THROAT : PETALS;
    });
    const end = new THREE.CircleGeometry(prof[prof.length - 1][0] + 0.1, nSeg);
    end.rotateY(-Math.PI / 2);
    end.translate(nX + BURNER_CORE + 0.05, nY, zN);
    k.push(end, THROAT);
    const hot = new THREE.CircleGeometry(CORE_R, nSeg);
    hot.rotateY(-Math.PI / 2);
    hot.translate(nX + BURNER_CORE, nY, zN);
    k.push(hot, core);
  }

  // An unlit carbon valance (the diffuser) between the rear tyres under the engine bay; the tail
  // lights are two slits across the top of the haunches' dark tail faces.
  k.box(CARBON, 7.8, 5.6, 42, -54.4, FLOOR + 2.8, 0);
  {
    const [, zc, w, y0, y1] = rings[rings.length - 1];
    const ySlit = y1 - (y1 - y0) * 0.3;
    for (const side of [-1, 1]) k.box(tail, 0.6, 1.1, w * 1.45, SIDE_TAIL - 0.1, ySlit, side * zc);
  }

  // Lamp lines (team glow) along the panel lines. On high a thin diamond (the bloom widens it); on
  // low a wide flat strip standing off the panel, its top facet lit and its bevels dark.
  const sSeg = hi ? 4 : 6;
  const wide = hi ? 0.5 : 1.5;
  const flat = 0.5;
  const off = hi ? 0 : 0.4;
  const lamp = (pts: readonly V3[], hu: number, hv: number): void => {
    const g = strand(pts, hu, hv, sSeg);
    if (hi) {
      k.push(g, strip);
      return;
    }
    // The loft's triangles in order: two per ring segment along each band (segment 1 is the top
    // facet), then the end caps.
    const sides = (pts.length - 1) * 2 * sSeg;
    let t = 0;
    k.pushBy(g, () => {
      const top = t < sides && Math.floor((t % (2 * sSeg)) / 2) === 1;
      t++;
      return top ? strip : TRIM;
    });
  };
  const crestA = 0.45 * Math.PI;
  const shoulderA = 0.34 * Math.PI;
  for (const side of [-1, 1]) {
    const mirror = (a: number): number => (side > 0 ? a : Math.PI - a);
    // The fender's crest, from the nose to the sill.
    const fender = rings.filter(([x]) => x <= SIDE_NOSE[1] && x >= SIDE_SILL[0]);
    lamp(
      fender.map(([x, zc, w, y0, y1]) => onRing(x, w, y0, y1, side * zc, SIDE_N, sideSeg, mirror(crestA), off)),
      wide,
      flat,
    );
    // The wing's leading edge from its root, then on along the haunch's shoulder to the tail.
    const [r0, r1] = WING;
    const t = (16.5 - r0[0]) / (r1[0] - r0[0]);
    const wingLe: V3[] = [
      [r0[1] + (r1[1] - r0[1]) * t, r0[3] + (r1[3] - r0[3]) * t + off, side * 16.5],
      ...WING.slice(1).map(([z, le, , yc]): V3 => [le, yc + off, side * z]),
    ];
    const haunch = rings.filter(([x]) => x < SIDE_SILL[SIDE_SILL.length - 1] && x > SIDE_TAIL);
    lamp([...wingLe, ...haunch.map(([x, zc, w, y0, y1]) => onRing(x, w, y0, y1, side * zc, SIDE_N, sideSeg, mirror(shoulderA), off))], wide, flat);
  }
  // Along the spine from the ruff to the fin, and across the T-tail's trailing edge.
  lamp(
    [
      [-3.6, 6.55 + off, 0],
      [-10, 5.85 + off, 0],
      [-18, 5.35 + off, 0],
      [-25.6, 4.95 + off, 0],
    ],
    hi ? 0.45 : 0.9,
    flat,
  );
  // Along the nose's ridge from the canopy down to the beak (the culmen).
  const ridge = (x: number): V3 => {
    let i = 0;
    while (i < FUSE.length - 2 && FUSE[i + 1][0] > x) i++;
    const top = ([rx, w, y0, y1, n]: (typeof FUSE)[number]): V3 => onRing(rx, w, y0, y1, 0, n, fuseSeg, Math.PI / 2, off);
    const a = top(FUSE[i]);
    const b = top(FUSE[i + 1]);
    return [x, a[1] + ((b[1] - a[1]) * (a[0] - x)) / (a[0] - b[0]), 0];
  };
  lamp([ridge(48.6), ridge(52.5), ridge(54.9)], hi ? 0.45 : 0.9, flat);
  lamp(
    [
      [-55.8, 16.1, -9.2],
      [-55.9, 15.8, 0],
      [-55.8, 16.1, 9.2],
    ],
    hi ? 0.55 : 0.9,
    0.45,
  );

  // Swept slash headlights along the fenders' inboard crests (a ring shorter on low).
  for (const side of [-1, 1]) {
    const slash = (a: number): number => (side > 0 ? a : Math.PI - a);
    const angles = [0.88, 0.76, 0.66, 0.58];
    k.push(
      strand(
        rings.slice(1, hi ? 5 : 4).map(([x, zc, w, y0, y1], i) => onRing(x, w, y0, y1, side * zc, SIDE_N, sideSeg, slash(Math.PI * angles[i]), 0.15)),
        0.85,
        0.45,
        4,
      ),
      HEADLIGHT,
    );
  }
}

/**
 * Slick tyres on aero disc covers: a dark disc flush with the tyre faces (dish 1), five light
 * turbine vanes standing proud of it, a light ring round it, six bolts on high and a team-paint hub.
 */
export const CONDOR_AERO: WheelStyle = {
  id: 'condor-aero',
  tyre: 'slick',
  spokes: 5,
  spokeWidth: 0.16,
  dish: 1.0,
  dishColor: 0x1d2128,
  rim: 0x6b7480,
  rimFinish: { metal: 0.75, rough: 0.34 },
  bead: 0xdfe6f0,
  bolts: 6,
  hub: 'team',
  budget: { low: 340, high: 664 },
};

export const CONDOR: CarBodySpec = {
  id: 'condor',
  build,
  wheels: { style: CONDOR_AERO, visual: 1.04, outer: 38.5, rear: { visual: 1.08, outer: 40, width: 1 } },
  // Car-local uu (the build frame + (13.88, 20.76, 0)): the two-tone line low on the body at
  // build y -11.9 (carbon along the sills and under the fenders' ends), the grooves across the nose
  // deck (build x 45) and the rear deck (build x -30); the heat tint only on the last 2.5 uu.
  livery: {
    twoToneY: 8.9,
    pinstripe: 0.4,
    chevrons: null,
    seams: { x: [58.9, -16.1], maxZ: 14 },
    accent: 0xe9eef5,
    chevronTint: 0,
    grime: { y0: 9, y1: 3, amount: 0.45 },
    ao: { y0: 2, y1: 13 },
    heat: { x: BOOST_NOZZLE_X, length: 2.5 },
  },
  budget: { low: 2000, high: 3500 },
};

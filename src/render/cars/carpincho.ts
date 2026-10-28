/**
 * The Carpincho ('carpincho'): a friendly armoured off-road brute, chunky and calm like the
 * capybara. A barrel-sided body with a studded armour plate bolted on each door, under a high cab
 * (a cream roof cap, a dark visor round the split windshield) whose roof rolls down into a round
 * rump; a tall, blunt, square muzzle with two oval nostril intakes and its round headlamps set high
 * in pods on the bonnet's front corners, half-lidded (the sleepy eyes), and big round mirrors high
 * on the pillars for ears; huge round pontoon fenders whose outer roll wraps down over fat knobby
 * tyres on dark deep-dish beadlock rims (one size all round), their ends rounded off; a light steel
 * tubular bull bar with round amber fog lamps; a roof rack with a light bar, a spare wheel, a
 * rolled canvas swag and a team light across its back, a snorkel with a ram head up the right
 * A-pillar, rock sliders with team light strips on brackets under the sills, and a short gunmetal
 * rear tub holding the two thrusters as big exhaust cans, each with a team-lit ring (what the chase
 * camera sees, under two big round amber tail lamps with white reverse segments on the rump).
 *
 * Designed in the build frame on the default hitbox (kit.hl / hh / hw 58.75 / 17.83 / 41.85; the
 * floor at y -37.8, the wheels at rest at x 37.4 and -47.6, y -22.8, radius 15, tyres |z| 18.8 to
 * 39.5). Side view: body -15..3 (two-tone line -9), bonnet 5, the muzzle's face 0.6 high at x
 * 55.3, the cab's belt 2.5 and roof 14.8 from the windshield (x 20 at the belt) back to x -12, then
 * the rump rolls down to the body at x -36.3; rack, light bar and swag to 17.7; door plates x
 * -21.5..11.5, y -7.7..-1.4. Top view: bonnet |z| 28.6, cab 28.4, door barrel 32.2, plates 32.7,
 * sliders 33.8, fenders 41.65, deck 16.4.
 */
import * as THREE from 'three/webgpu';
import { BOOST_NOZZLE_X, CAR_KIND, EXHAUST, HEADLIGHT, TRIM, loft, tube } from './kit';
import type { BodyKit, CarBodySpec, Ring, Surface, WheelAt, WheelStyle } from './types';

type V3 = readonly [number, number, number];
type V2 = readonly [number, number];

/** Cream: the roof cap, the bezels, the beadlock rings, the bonnet chevron and the pinstripe. */
const CREAM = 0xe6d8b8;
/** Graphite tube steel: the rack, the rock sliders. */
const GRAPHITE: Surface = { color: 0x3c424b, metal: 0.65, rough: 0.36, emissive: 0, kind: CAR_KIND.ALLOY };
/** Light brushed steel: the bull bar (it stands clear of the dark chin). */
const BAR: Surface = { color: 0xaab1ba, metal: 0.7, rough: 0.3, emissive: 0, kind: CAR_KIND.ALLOY };
/** Warm cream alloy: the headlamp bezels and the spare's hub. */
const BEZEL: Surface = { color: 0xe4d9bf, metal: 0.6, rough: 0.3, emissive: 0, kind: CAR_KIND.ALLOY };
/** Dark gunmetal: the rear tub between the rear fenders (the team rings and tail lamps pop on it, either team). */
const TUB: Surface = { color: 0x2b2f36, metal: 0.55, rough: 0.45, emissive: 0, kind: CAR_KIND.DARK_METAL };
/** Dark matte trim: the cab's front face round the windshield (pillars and header). */
const FRAME: Surface = { color: 0x1d2026, metal: 0, rough: 0.7, emissive: 0, kind: CAR_KIND.TRIM };
/** Warm white reverse lamps: the lower segment of each tail lamp. */
const REVERSE: Surface = { color: 0xfff1dc, metal: 0, rough: 0.12, emissive: 2, kind: CAR_KIND.LAMP };
/** Chrome armour bolts. */
const STUD: Surface = { color: 0xd8dce2, metal: 1, rough: 0.2, emissive: 0, kind: CAR_KIND.CHROME };
/** Amber fog lamps. */
const FOG: Surface = { color: 0xffb444, metal: 0, rough: 0.12, emissive: 2.4, kind: CAR_KIND.LAMP };
/** Olive canvas: the rolled swag on the rack (it reads on the cream roof). */
const CANVAS: Surface = { color: 0x6f6a46, metal: 0, rough: 0.8, emissive: 0, kind: CAR_KIND.TRIM };
/** Dark anodised brackets, clamps and saddles. */
const BRACKET: Surface = { color: 0x23272e, metal: 0.6, rough: 0.4, emissive: 0, kind: CAR_KIND.DARK_METAL };
/** Charcoal rubber: the spare tyre in the rack. */
const SPARE: Surface = { color: 0x1d1e22, metal: 0, rough: 0.85, emissive: 0, kind: CAR_KIND.TRIM };
/** Matte black rubber: the windshield frame and the lamp bezels (a dark edge on any paint). */
const RUBBER: Surface = { color: 0x0b0c0e, metal: 0, rough: 0.62, emissive: 0, kind: CAR_KIND.TRIM };
/**
 * The exhaust cans: gunmetal with the heat band at the exit on high; on low detail (low, super low:
 * no bloom, and on super low no reflections) a dark base so they never read pale.
 */
const CAN_HI: Surface = { ...EXHAUST, color: 0x7c828b, metal: 0.8, rough: 0.28 };
const CAN_LO: Surface = { ...EXHAUST, color: 0x30343c, metal: 0.55, rough: 0.45 };

/**
 * Deep-dish beadlock wheels: a knobby tyre, dark gunmetal rim, narrow spokes and a darker dish, a
 * thick cream beadlock ring (the bright part) with its bolts, a team hub cap. The dune runner's
 * wheel budget.
 */
export const CARPINCHO_WHEEL: WheelStyle = {
  id: 'carpincho-beadlock',
  tyre: 'knobby',
  spokes: 6,
  spokeWidth: 0.13,
  dish: 0.55,
  dishColor: 0x15171b,
  rim: 0x3a3e46,
  rimFinish: { metal: 0.65, rough: 0.35 },
  bead: CREAM,
  bolts: 8,
  hub: 'team',
  budget: { low: 440, high: 820 },
};

// ---- geometry helpers --------------------------------------------------------------------------

/**
 * A closed solid from rings of explicit points (every ring the same count, in the same turning
 * order): neighbouring rings stitched into quads that share vertices (smooth), both ends closed by
 * a flat fan on their own vertices (a crisp edge). Outward-facing whatever the rings' turn. No two
 * neighbouring rings may coincide, and no ring may collapse to a point.
 */
function ringLoft(rings: readonly (readonly V3[])[]): THREE.BufferGeometry {
  const m = rings[0].length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const r of rings) for (const p of r) pos.push(p[0], p[1], p[2]);
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let j = 0; j < m; j++) {
      const a = i * m + j;
      const b = i * m + ((j + 1) % m);
      const c = (i + 1) * m + j;
      const d = (i + 1) * m + ((j + 1) % m);
      idx.push(a, c, b, b, c, d);
    }
  }
  const cap = (r: readonly V3[], last: boolean): void => {
    const first = pos.length / 3;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of r) {
      pos.push(p[0], p[1], p[2]);
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    pos.push(cx / m, cy / m, cz / m);
    const centre = first + m;
    for (let j = 0; j < m; j++) {
      const a = first + j;
      const b = first + ((j + 1) % m);
      if (last) idx.push(centre, b, a);
      else idx.push(centre, a, b);
    }
  };
  cap(rings[0], false);
  cap(rings[rings.length - 1], true);
  // Outward: a positive signed volume (the divergence theorem over the closed surface).
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    vol +=
      pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) +
      pos[a + 1] * (pos[b + 2] * pos[c] - pos[b] * pos[c + 2]) +
      pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  if (vol < 0) {
    for (let t = 0; t < idx.length; t += 3) {
      const s = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = s;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A section across the car at `x` with a round-shouldered top half (`hvTop`) over a deeper bottom: top y `top`, bottom y `bottom`. */
function shoulder(x: number, hu: number, top: number, bottom: number, hvTop: number, n?: number): Ring {
  const cy = top - hvTop;
  return { o: [x, cy, 0], u: [0, 0, 1], v: [0, 1, 0], hu, hv: hvTop, hvNeg: cy - bottom, n };
}

/** Mirror a right-half outline (z >= 0, listed from the bottom up to the centre line) into a closed one. */
function mirrored(half: readonly V2[]): V2[] {
  const out: V2[] = [...half];
  for (let i = half.length - 1; i >= 0; i--) {
    const [z, y] = half[i];
    if (z > 1e-6) out.push([-z, y]);
  }
  return out;
}

/** A cylinder along x from x0 (radius r0) to x1 (radius r1) at (y, z): lamps, pods and cans. */
function xCylinder(r0: number, r1: number, x0: number, x1: number, y: number, z: number, seg: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, Math.abs(x1 - x0), seg, 1, false);
  g.rotateZ(-Math.PI / 2); // +y (the top, radius r1) -> +x
  g.translate((x0 + x1) * 0.5, y, z);
  return g;
}

/**
 * A lamp lens facing +x: a cylinder of radius r from x0 to x1 at (y, z) with only its front cap
 * (its back always sits inside a pod, bezel or housing): `push` it as two parts.
 */
function xLens(r: number, x0: number, x1: number, y: number, z: number, seg: number): THREE.BufferGeometry[] {
  const side = new THREE.CylinderGeometry(r, r, x1 - x0, seg, 1, true);
  side.rotateZ(-Math.PI / 2);
  side.translate((x0 + x1) * 0.5, y, z);
  const face = new THREE.CircleGeometry(r, seg);
  face.rotateY(Math.PI / 2);
  face.translate(x1, y, z);
  return [side, face];
}

/**
 * A cylinder of radius r from a to b with only its cap at b (the end at a always sits inside
 * another part: a lamp in its bezel, a bezel in the body, a can in its collar): two parts to push.
 */
function capped(a: V3, b: V3, r: number, seg: number): THREE.BufferGeometry[] {
  const d = sub(b, a);
  const len = Math.hypot(d[0], d[1], d[2]);
  const side = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
  const face = new THREE.CircleGeometry(r, seg);
  face.rotateX(-Math.PI / 2); // +z -> +y: the cylinder's top
  face.translate(0, len * 0.5, 0);
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5),
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(d[0] / len, d[1] / len, d[2] / len)),
    new THREE.Vector3(1, 1, 1),
  );
  side.applyMatrix4(m);
  face.applyMatrix4(m);
  return [side, face];
}

/** An ellipse ring (radii rz, ry) across x at (x, y, z): m points, half a step off the axes (flat sides top and bottom). */
function ellipse(x: number, y: number, z: number, rz: number, ry: number, m: number): V3[] {
  const out: V3[] = [];
  for (let j = 0; j < m; j++) {
    const a = ((j + 0.5) / m) * Math.PI * 2;
    out.push([x, y + ry * Math.sin(a), z + rz * Math.cos(a)]);
  }
  return out;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const along = (p: V3, n: V3, d: number): V3 => [p[0] + n[0] * d, p[1] + n[1] * d, p[2] + n[2] * d];

/**
 * A thin glass pane over a frame: its front, `front(t, v)` (t across, v up, both 0..1), a grid with
 * the surface's own smooth normals on vertices it shares with nothing (so the edges never bend
 * them: one soft sheen, no faceted flecks), flat sides down to `back(t, v)`; the back lies buried
 * in the frame.
 */
function pane(front: (t: number, v: number) => V3, back: (t: number, v: number) => V3, cols: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const f0 = front(0.5, 0.5);
  const b0 = back(0.5, 0.5);
  const centre: V3 = [(f0[0] + b0[0]) * 0.5, (f0[1] + b0[1]) * 0.5, (f0[2] + b0[2]) * 0.5];
  const tri = (a: V3, b: V3, c: V3, ns?: readonly [V3, V3, V3]): void => {
    const fn = norm(cross(sub(b, a), sub(c, a)));
    const mid: V3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const flip = dot(fn, ns ? ns[0] : sub(mid, centre)) < 0;
    const pts = flip ? [a, c, b] : [a, b, c];
    const nn = ns ? (flip ? [ns[0], ns[2], ns[1]] : ns) : null;
    for (let i = 0; i < 3; i++) {
      pos.push(pts[i][0], pts[i][1], pts[i][2]);
      const n = nn ? nn[i] : flip ? ([-fn[0], -fn[1], -fn[2]] as V3) : fn;
      nor.push(n[0], n[1], n[2]);
    }
  };
  const quad = (a: V3, b: V3, c: V3, d: V3, ns?: readonly [V3, V3, V3, V3]): void => {
    tri(a, b, c, ns && [ns[0], ns[1], ns[2]]);
    tri(a, c, d, ns && [ns[0], ns[2], ns[3]]);
  };
  const e = 1e-3;
  const normal = (t: number, v: number): V3 => {
    const dt = sub(front(Math.min(1, t + e), v), front(Math.max(0, t - e), v));
    const dv = sub(front(t, Math.min(1, v + e)), front(t, Math.max(0, v - e)));
    const n = norm(cross(dt, dv));
    return dot(n, sub(front(t, v), back(t, v))) < 0 ? [-n[0], -n[1], -n[2]] : n;
  };
  for (let i = 0; i < cols; i++) {
    const t0 = i / cols;
    const t1 = (i + 1) / cols;
    quad(front(t0, 0), front(t1, 0), front(t1, 1), front(t0, 1), [normal(t0, 0), normal(t1, 0), normal(t1, 1), normal(t0, 1)]);
    quad(front(t0, 0), front(t1, 0), back(t1, 0), back(t0, 0));
    quad(front(t0, 1), front(t1, 1), back(t1, 1), back(t0, 1));
  }
  quad(front(0, 0), front(0, 1), back(0, 1), back(0, 0));
  quad(front(1, 0), front(1, 1), back(1, 1), back(1, 0));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/**
 * A round pontoon fender over `w` on both sides: the `sec` section ((|z|, height over the tyre)
 * points, one closed outline) swept round the wheel from angle a0 to a1 (radians from the front,
 * over the top) in `steps`, each end closed by a rounded cap: rings shrinking toward the section's
 * centre while they run on along the arc's tangent (`caps`: [distance, scale] pairs).
 */
function pontoon(k: BodyKit, w: WheelAt, a0: number, a1: number, sec: readonly V2[], steps: number, caps: readonly (readonly [number, number])[]): void {
  let sc = 0;
  let tc = 0;
  for (const [s, t] of sec) {
    sc += s;
    tc += t;
  }
  sc /= sec.length;
  tc /= sec.length;
  for (const side of [-1, 1]) {
    const ring = (a: number, d: number, tx: number, ty: number, scale: number): V3[] =>
      sec.map(([s, t]) => {
        const r = w.radius + tc + (t - tc) * scale;
        return [w.x + r * Math.cos(a) + d * tx, w.y + r * Math.sin(a) + d * ty, side * (sc + (s - sc) * scale)];
      });
    const rings: V3[][] = [];
    // The a0 end runs on against the sweep (tangent (sin, -cos)), the a1 end with it (-sin, cos).
    for (let i = caps.length - 1; i >= 0; i--) rings.push(ring(a0, caps[i][0], Math.sin(a0), -Math.cos(a0), caps[i][1]));
    for (let i = 0; i <= steps; i++) rings.push(ring(a0 + ((a1 - a0) * i) / steps, 0, 0, 0, 1));
    for (const [d, s] of caps) rings.push(ring(a1, d, -Math.sin(a1), Math.cos(a1), s));
    k.push(ringLoft(rings), k.paint);
  }
}

// ---- the cab -----------------------------------------------------------------------------------

/** Cab heights (build frame): hidden bottom, belt (team paint below, cream above). */
const CAB_BOT = -1;
const CAB_BELT = 2.5;
/** Right half of the cab's section (z, y), bottom up to the roof's centre line: tumblehome, a round roof shoulder, a crowned roof. */
const CAB_HALF_HI: readonly V2[] = [
  [28.4, -1],
  [28.4, 2.5],
  [27.9, 5.2],
  [26.5, 10.7],
  [25.5, 12.6],
  [23.4, 13.7],
  [12, 14.55],
  [0, 14.8],
];
const CAB_HALF_LO: readonly V2[] = [
  [28.4, -1],
  [28.4, 2.5],
  [27.4, 7.5],
  [25.2, 12.8],
  [0, 14.8],
];
/** The windshield plane: x at the belt, and its rake (uu back per uu up). */
const WS_X = 20;
const WS_RAKE = 0.38;

function wsX(y: number): number {
  return WS_X - (y - CAB_BELT) * WS_RAKE;
}

/** A cab station: x, width scale, height scale over CAB_BOT. */
type Station = readonly [number, number, number];
/**
 * The cab behind the windshield, front to back: the roof runs flat to x -12, then the rump: the
 * roof drops 4 uu over the next 19 and rolls down into the body (the capybara's back), its rear
 * corners rounded (radius 5 in plan). Low detail keeps six.
 */
const RUMP: readonly Station[] = [
  [-12, 1, 1],
  [-25.5, 1, 0.91],
  [-28.8, 1, 0.85],
  [-31.4, 1, 0.775],
  [-33.3, 0.985, 0.685],
  [-34.7, 0.953, 0.575],
  [-35.6, 0.914, 0.45],
  [-36.1, 0.873, 0.32],
  [-36.3, 0.824, 0.2],
];
const RUMP_LOW = [0, 1, 3, 4, 6, 8];

/** Whether (z, y) is inside the closed outline `poly` (even-odd). */
function inside(poly: readonly V2[], z: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [zi, yi] = poly[i];
    const [zj, yj] = poly[j];
    if (yi > y !== yj > y && z < ((zj - zi) * (y - yi)) / (yj - yi) + zi) c = !c;
  }
  return c;
}

function lerpStation(a: Station, b: Station, f: number): Station {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** The station (width and height scale) at x along the cab (1, 1 ahead of the rump). */
function stationAt(st: readonly Station[], x: number): Station {
  if (x >= st[0][0]) return [x, 1, 1];
  for (let i = 0; i + 1 < st.length; i++) {
    const a = st[i];
    const b = st[i + 1];
    if (x >= b[0]) return lerpStation(a, b, (a[0] - x) / (a[0] - b[0]));
  }
  return st[st.length - 1];
}

/**
 * The cab's back surface (the rump) at (z, y): its x, where the ruled surface between two
 * stations (the section scaled by their interpolated width and height) first contains the point,
 * searching forward from the tail.
 */
function rumpX(sec: readonly V2[], st: readonly Station[], z: number, y: number): number {
  const has = (s: Station): boolean => inside(sec, z / s[1], CAB_BOT + (y - CAB_BOT) / s[2]);
  for (let i = st.length - 1; i > 0; i--) {
    const back = st[i];
    const front = st[i - 1];
    if (!has(front)) continue;
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 30; it++) {
      const f = (lo + hi) * 0.5;
      if (has(lerpStation(back, front, f))) hi = f;
      else lo = f;
    }
    return back[0] + (front[0] - back[0]) * hi;
  }
  return st[0][0];
}

/** A point on the rump at (z, y) and its outward normal. */
function onRump(sec: readonly V2[], st: readonly Station[], z: number, y: number): { p: V3; n: V3 } {
  const h = 0.25;
  const x = rumpX(sec, st, z, y);
  const dxdy = (rumpX(sec, st, z, y + h) - rumpX(sec, st, z, y - h)) / (2 * h);
  const dxdz = (rumpX(sec, st, z + h, y) - rumpX(sec, st, z - h, y)) / (2 * h);
  return { p: [x, y, z], n: norm([-1, dxdy, dxdz]) };
}

/** The cab's side |z| at (x, y): the right half outline's width at that height, scaled by the station there. */
function cabSideZ(half: readonly V2[], st: readonly Station[], x: number, y: number): number {
  const [, sz, sy] = stationAt(st, x);
  const yu = CAB_BOT + (y - CAB_BOT) / sy;
  for (let i = 0; i + 1 < half.length; i++) {
    const [z0, y0] = half[i];
    const [z1, y1] = half[i + 1];
    if (yu <= y1) return sz * (z0 + ((z1 - z0) * (yu - y0)) / (y1 - y0));
  }
  return 0;
}

function build(k: BodyKit): void {
  const { hi, hl, paint } = k;
  const { front, back } = k.wheels;
  const cream: Surface = { ...paint, color: CREAM };
  /** Satin dark glass for the up-facing panes: a soft sheen, never the sky as a mirror. */
  const satin: Surface = { color: k.glass.color, metal: 0, rough: 0.34, emissive: 0, kind: CAR_KIND.TRIM };

  // Body: barrel-sided doors (round in section, widest at y -1) between the axles, a raised bonnet
  // over the front wheels ending in the muzzle: a tall, blunt block with a radius-5 fillet over its
  // flat face and rounded corners in plan; behind the cab it rolls down to the keel's deck.
  const body: Ring[] = [
    shoulder(-40.6, 25.5, 1.2, -5.2, 3),
    shoulder(-39.9, 28.6, 2.3, -5.8, 3.6),
    shoulder(-38.6, 30.2, 2.9, -6.8, 4),
    shoulder(-36.2, 31, 3, -8.6, 4, 3),
    shoulder(-31.5, 32.2, 3, -15, 4, 2.8),
    shoulder(16, 32.2, 3, -15, 4, 2.8),
    shoulder(19.5, 30.6, 3.6, -9.5, 4, 3.2),
    shoulder(23.5, 28.6, 4.4, -7, 4.2),
    shoulder(36, 28.6, 5, -6.6, 4.6),
    shoulder(50.3, 28.2, 5, -10.5, 4.6),
    shoulder(52.8, 27.2, 4.4, -11.6, 4.4),
    shoulder(54.3, 25.6, 3.3, -12.2, 4),
    shoulder(55, 24, 2, -12.4, 3.2),
    shoulder(55.3, 22.6, 0.6, -12.4, 2.4),
  ];
  // Its round rear end under the rump is the gunmetal tub's front wall (whole loft bands: on low
  // detail only the end cap). Low detail keeps nine rings, at twelve points round like high (a
  // point on the centre line: the bonnet chevron's paint).
  const tubX = hi ? -38 : -39.5;
  const lowRings = [0, 3, 4, 5, 7, 8, 9, 10, 13];
  k.pushBy(loft(hi ? body : lowRings.map((i) => body[i]), 12, 3.4), (x) => (x < tubX ? TUB : paint));

  // Keel: the narrow chassis between the tyres, nose to tail; behind the cab its top is the deck,
  // gunmetal like its tail (the tub the cans sit in).
  k.pushBy(
    loft(
      [
        shoulder(-58.4, 15.4, -5.6, -15.8, 3),
        shoulder(-57.6, 16.4, -5, -16.6, 3.2),
        shoulder(-44, 16.4, -5, -16.6, 3.2),
        shoulder(50, 15.6, -6, -17.3, 3),
        shoulder(54.4, 14.4, -7.5, -16, 2.5),
      ],
      hi ? 8 : 6,
      3,
    ),
    (x) => (x < -40 ? TUB : paint),
  );

  // Cab: a high box with tumblehome, a crowned roof and the round rump, in team paint; a cream
  // roof cap over what faces up (the roof from its shoulders, the top of the rump), and its front
  // face round the windshield (pillars, header) dark matte trim.
  const half = hi ? CAB_HALF_HI : CAB_HALF_LO;
  const sec = mirrored(half);
  const rump = hi ? RUMP : RUMP_LOW.map((i) => RUMP[i]);
  const cabRings: V3[][] = [sec.map(([z, y]): V3 => [wsX(y), y, z]), ...rump.map(([x, sz, sy]) => sec.map(([z, y]): V3 => [x, CAB_BOT + (y - CAB_BOT) * sy, z * sz]))];
  k.pushBy(ringLoft(cabRings), (x, _y, _z, nx, ny) => (nx > 0.8 && x > 10 ? FRAME : ny > 0.7 ? cream : paint));

  // Split windshield: a black frame (and centre post) on the windshield plane, two satin panes
  // standing out of it, each bowed forward across its width.
  const wsN = norm([1, WS_RAKE, 0]);
  const onWs = (z: number, y: number, off: number): V3 => [wsX(y) + wsN[0] * off, y + wsN[1] * off, z];
  const frame: V2[] = [
    [-26.5, 4.5],
    [26.5, 4.5],
    [22.6, 13.6],
    [-22.6, 13.6],
  ];
  k.push(ringLoft([frame.map(([z, y]) => onWs(z, y, -0.4)), frame.map(([z, y]) => onWs(z, y, 0.3))]), RUBBER);
  const paneTop = (t: number): number => 13.2 - 1.3 * Math.max(0, (t - 0.6) / 0.4) ** 2;
  for (const side of [-1, 1]) {
    const at = (t: number, v: number, off: (t: number) => number): V3 => {
      const y = 4.9 + (paneTop(t) - 4.9) * v;
      const zOut = 26 + (22.2 - 26) * ((y - 4.9) / (13.2 - 4.9));
      return onWs(side * (0.9 + (zOut - 0.9) * t), y, off(t));
    };
    k.push(
      pane(
        (t, v) => at(t, v, (u) => 0.45 + 0.5 * Math.sin(Math.PI * u)),
        (t, v) => at(t, v, () => -0.3),
        hi ? 4 : 2,
      ),
      satin,
    );
  }

  // One pill-shaped side window a side (round ends), flush glass on the tumblehome.
  const pill: V2[] = [];
  {
    const [x0, x1, y0, y1] = [-21, 12.5, 5.9, 10.1];
    const r = (y1 - y0) * 0.5;
    const n = hi ? 4 : 3;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / (n - 1);
      pill.push([x1 - r + r * Math.cos(a), y0 + r + r * Math.sin(a)]);
    }
    for (let i = 0; i < n; i++) {
      const a = Math.PI / 2 + (Math.PI * i) / (n - 1);
      pill.push([x0 + r + r * Math.cos(a), y0 + r + r * Math.sin(a)]);
    }
  }
  for (const side of [-1, 1]) {
    const ring = (off: number): V3[] => pill.map(([x, y]): V3 => [x, y, side * (cabSideZ(half, rump, x, y) + off)]);
    k.push(ringLoft([ring(-0.5), ring(0.3)]), k.glass);
  }

  // Rear window: a rounded rectangle of satin glass on the rump, and two round amber tail lamps in
  // black bezels at its corners (amber on either team, beside the team rings below).
  const rw: V2[] = [];
  {
    const [zr, y0, y1, r] = [12.5, 7.3, 11, 2];
    const n = hi ? 3 : 2;
    const corners: V3[] = [
      [zr - r, y1 - r, 0],
      [-(zr - r), y1 - r, Math.PI / 2],
      [-(zr - r), y0 + r, Math.PI],
      [zr - r, y0 + r, (Math.PI * 3) / 2],
    ];
    for (const [cz, cy, a0] of corners) for (let i = 0; i < n; i++) {
      const a = a0 + ((Math.PI / 2) * i) / (n - 1);
      rw.push([cz + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  // Flat glass: the outline projected onto the rump's tangent plane at its centre (the rump is
  // convex, so the plane stands clear of it everywhere), one normal over the whole pane.
  const rc = onRump(sec, rump, 0, 9.15);
  const rwFlat = rw.map(([z, y]) => {
    const s = onRump(sec, rump, z, y).p;
    return along(s, rc.n, -dot(sub(s, rc.p), rc.n));
  });
  k.push(ringLoft([rwFlat.map((p) => along(p, rc.n, -0.6)), rwFlat.map((p) => along(p, rc.n, 0.3))]), satin);
  // Big round lamps (amber on either team, never red on red) with a warm white reverse segment at
  // the bottom, in black bezels.
  const amber: Surface = { color: 0xffa030, metal: 0, rough: 0.12, emissive: hi ? 1.9 : 2.6, kind: CAR_KIND.LAMP };
  const ts = hi ? 10 : 8;
  for (const side of [-1, 1]) {
    const { p, n } = onRump(sec, rump, side * 19.2, 4.6);
    for (const g of capped(along(p, n, -1.6), along(p, n, 0.45), 3.05, ts)) k.push(g, RUBBER);
    for (const g of capped(along(p, n, 0.3), along(p, n, 0.75), 2.35, ts)) k.pushBy(g, (_x, y) => (y < p[1] - 1.05 ? REVERSE : amber));
  }

  // Huge round pontoon fenders over all four wheels (team paint): a full rolled section, its outer
  // edge wrapping down past the tyre's shoulder (less at the front, where the wheels steer), each
  // end rounded off. The front ones end high at the nose behind the bull bar.
  const DEG = Math.PI / 180;
  const rearSec: readonly V2[] = hi
    ? [
        [16, 1.5],
        [16, 5.4],
        [24, 8.5],
        [34, 8.2],
        [40.2, 5.4],
        [41.65, 0.4],
        [40.8, -3.3],
        [39.9, 1.5],
      ]
    : [
        [16, 1.5],
        [16, 6.2],
        [28, 8.6],
        [40.4, 5.6],
        [41.6, -3],
        [40.2, 1.5],
      ];
  const frontSec: readonly V2[] = rearSec.map(([s, t]) => [s, t < 0 ? t * 0.35 : t < 1.5 ? t * 0.6 + 0.6 : t]);
  const caps: readonly (readonly [number, number])[] = hi
    ? [
        [2.05, 0.71],
        [2.8, 0.26],
      ]
    : [[2.4, 0.42]];
  const steps = hi ? 5 : 4;
  pontoon(k, front, 40 * DEG, 142 * DEG, frontSec, steps, caps);
  pontoon(k, back, 32 * DEG, 112 * DEG, rearSec, steps, caps);

  // Twin thrusters: big exhaust cans lying on the rear deck, a collar round a wide team ring (lit
  // in full team colour, no bloom needed) and a dark team throat, a clamp band and a saddle each.
  const { x: nx, y: ny, z: nzz } = k.nozzle;
  const canLen = 14.8;
  const cs = hi ? 12 : 10;
  const can = hi ? CAN_HI : CAN_LO;
  const ringLamp: Surface = { color: paint.color, metal: 0, rough: 0.2, emissive: hi ? 1.2 : 0.9, kind: CAR_KIND.LAMP };
  const throatLamp: Surface = { color: paint.color, metal: 0, rough: 0.5, emissive: 0.12, kind: CAR_KIND.LAMP };
  for (const side of [-1, 1]) {
    const z = side * nzz;
    for (const g of capped([nx + 1.2, ny, z], [nx + canLen, ny, z], 5, cs)) k.push(g, can);
    k.push(xCylinder(5.6, 5.6, nx, nx + 1.6, ny, z, cs), can);
    const ring = new THREE.RingGeometry(2.6, 4.75, cs, 1);
    ring.rotateY(-Math.PI / 2);
    ring.translate(nx - 0.1, ny, z);
    k.push(ring, ringLamp);
    const throat = new THREE.CircleGeometry(2.6, cs);
    throat.rotateY(-Math.PI / 2);
    throat.translate(nx - 0.12, ny, z);
    k.push(throat, throatLamp);
    if (hi) {
      const clamp = new THREE.CylinderGeometry(5.45, 5.45, 1.4, 12, 1, true); // its open ends sit on the can
      clamp.rotateZ(-Math.PI / 2);
      clamp.translate(nx + 7.9, ny, z);
      k.push(clamp, BRACKET);
    }
    k.box(BRACKET, 9, 2.2, 6, nx + 8, -5.6, z);
  }

  // The face. Muzzle: two oval nostril intakes on the flat front, a raised lip round a dark,
  // recessed inside.
  const faceX = 55.3;
  const ns = hi ? 10 : 8;
  for (const side of [-1, 1]) {
    const [cy, cz] = [-3, side * 7.5];
    const rings = [ellipse(faceX - 0.6, cy, cz, 4.7, 2.5, ns), ellipse(faceX + 0.9, cy, cz, 4.5, 2.35, ns), ellipse(faceX + 1.05, cy, cz, 3.4, 1.8, ns), ellipse(faceX + 0.15, cy, cz, 3.1, 1.6, ns)];
    k.pushBy(ringLoft(hi ? rings : [rings[0], rings[2], rings[3]]), (_x, y, z) => (Math.hypot((z - cz) / 4.7, (y - cy) / 2.5) < 0.75 ? RUBBER : paint));
  }
  // Eyes: the round headlamps high on the bonnet's front corners, in tapered pods (team paint, a
  // cream bezel face), half covered by heavy lids drooping outward: calm, sleepy.
  const ls = hi ? 12 : 10;
  const [eyeY, eyeZ, eyeR] = [5.2, 17.6, 4];
  for (const side of [-1, 1]) {
    const z = side * eyeZ;
    const pod = (x: number, r: number, h: number, y: number): Ring => ({ o: [x, y, z], u: [0, 0, 1], v: [0, 1, 0], hu: r, hv: h });
    k.pushBy(loft([pod(45.8, 2.4, 0.9, 4.6), pod(51.4, 4.1, 3.9, 5.15), pod(54.4, eyeR, eyeR, eyeY)], 10, 2), (_x, _y, _z, nx) => (nx > 0.9 ? BEZEL : paint));
    for (const g of xLens(2.8, 54, 54.85, eyeY, z, ls)) k.push(g, HEADLIGHT);
    const lid: V2[] = [];
    const [aOut, aIn] = [Math.asin(0.45 / 4.25), Math.PI - Math.asin(1 / 4.25)];
    const n = hi ? 5 : 4;
    for (let i = 0; i < n; i++) {
      const a = aOut + ((aIn - aOut) * i) / (n - 1);
      lid.push([z + side * 4.25 * Math.cos(a), eyeY + 4.25 * Math.sin(a)]);
    }
    k.push(ringLoft([lid.map(([lz, ly]): V3 => [53.6, ly, lz]), lid.map(([lz, ly]): V3 => [55.25, ly, lz])]), paint);
  }
  // Skid plate under the muzzle (high detail).
  if (hi) k.box(GRAPHITE, 5, 1.2, 26, 53.2, -15.6, 0);

  // Tubular bull bar: a bumper tube across the nose, two uprights to the face under the nostrils,
  // round amber fog lamps on it.
  const barX = hl - 1.55;
  k.push(tube(barX, -11, -29.5, barX, -11, 29.5, 1.45, hi ? 8 : 6), BAR);
  for (const side of [-1, 1]) k.push(tube(barX, -10.4, side * 14, faceX + 0.3, -5.4, side * 14, 1, hi ? 6 : 3), BAR);
  for (const side of [-1, 1]) {
    for (const g of xLens(2.3, 55.9, 57.9, -8.4, side * 18.6, hi ? 10 : 8)) k.push(g, RUBBER);
    for (const g of xLens(1.75, 57.7, 58.35, -8.4, side * 18.6, hi ? 10 : 8)) k.push(g, FOG);
  }

  // Roof rack on the flat of the roof: two rails on four legs, a spare wheel lying in it (cross
  // bars on low detail), a light bar across its front, a fat rolled canvas swag strapped across
  // its back.
  const railY = 16.1;
  for (const side of [-1, 1]) {
    k.push(tube(-16, railY, side * 20.5, 7, railY, side * 20.5, 0.75, hi ? 6 : 3), GRAPHITE);
    if (hi) for (const x of [-13.5, 4.5]) k.box(BRACKET, 1.4, 2.2, 1.4, x, 15.1, side * 20.5);
  }
  if (hi) {
    // Open-bottomed (they stand in the roof): only their tops are capped.
    for (const g of capped([-4.4, 14.6, 0], [-4.4, 17.2, 0], 5.8, 10)) k.push(g, SPARE);
    for (const g of capped([-4.4, 14.45, 0], [-4.4, 17.35, 0], 3, 8)) k.push(g, BEZEL);
  } else for (const x of [-7, 0.5]) k.box(GRAPHITE, 1.3, 0.7, 42, x, railY, 0);
  k.box(TRIM, 2.4, 2.4, 36, 8.6, 16.4, 0);
  if (hi) for (const z of [-12, -6, 0, 6, 12]) k.box(HEADLIGHT, 0.5, 1.5, 4.2, 10.05, 16.4, z);
  else k.box(HEADLIGHT, 0.5, 1.5, 28.6, 10.05, 16.4, 0);
  k.box(k.strip, 1, 1, 42, -16.2, railY, 0);
  k.push(tube(-12.6, 15.9, -16.5, -12.6, 15.9, 16.5, 1.75, hi ? 7 : 6), CANVAS);
  if (hi) for (const z of [-8, 8]) k.box(BRACKET, 3.7, 3.7, 0.9, -12.6, 15.9, z);

  // Snorkel out of the right front fender, up the A-pillar in two clamps, a round ram head on top
  // facing forward.
  const sn = hi ? 6 : 3;
  k.push(tube(25, -2.6, 31.3, 21.2, 4.4, 30.3, 1.35, sn), TRIM);
  k.push(tube(21.4, 4, 30.3, 17.2, 14, 29, 1.35, sn), TRIM);
  for (const f of hi ? [0.3, 0.72] : []) {
    const [x, y, z] = [21.4 - 4.2 * f, 4 + 10 * f, 30.3 - 1.3 * f];
    const [dx, dy, dz] = norm([-4.2, 10, -1.3]);
    k.push(tube(x - dx * 0.45, y - dy * 0.45, z - dz * 0.45, x + dx * 0.45, y + dy * 0.45, z + dz * 0.45, 1.75, sn), BRACKET);
  }
  const head = new THREE.SphereGeometry(1, hi ? 6 : 5, hi ? 4 : 3);
  head.scale(2.7, 2.05, 2.5);
  head.translate(17.7, 15.5, 29);
  k.push(head, TRIM);

  // Ears: big round mirrors on stalks high on the A-pillars, at the roof's front corners, flattened
  // ovals leaning back and out, team paint outside, a dark glass inside.
  for (const side of [-1, 1]) {
    k.push(tube(14.4, 10.4, side * 26, 13.6, 12.2, side * 30.2, 0.5, hi ? 4 : 3), BRACKET);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(13.2, 13.1, side * 31.3),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-side * 0.26, 0, 0.35, 'XYZ')),
      new THREE.Vector3(1, 1, 1),
    );
    const shell = new THREE.SphereGeometry(1, hi ? 7 : 5, hi ? 4 : 3);
    shell.scale(1.05, 3.3, 2.75);
    shell.applyMatrix4(m);
    k.push(shell, paint);
    if (hi) {
      const inner = new THREE.CylinderGeometry(1, 1, 0.2, 5, 1, false);
      inner.rotateZ(Math.PI / 2);
      inner.scale(1, 2.35, 1.9);
      inner.translate(-0.97, 0, 0);
      inner.applyMatrix4(m);
      k.push(inner, RUBBER);
    }
  }

  // Armour: a raised plate bolted on each door, standing off the barrel's lower facet (the loft's
  // section points at 0 and -360/seg degrees: y -1 down to the two-tone line), six big chrome studs
  // on high detail; a slab on low.
  {
    const seg = 12;
    const e = 2 / 2.8;
    const a = (Math.PI * 2) / seg;
    const [y0, z0] = [-1, 32.2];
    const [y1, z1] = [-1 - 14 * Math.sin(a) ** e, 32.2 * Math.cos(a) ** e];
    const len = Math.hypot(y0 - y1, z0 - z1);
    const up: V2 = [(y0 - y1) / len, (z0 - z1) / len]; // (y, z) up the facet
    const out: V2 = [-up[1], up[0]]; // (y, z) outward
    const [xc, hu, hv, down] = [-5, 16.5, 3.35, 3.75]; // centre x, half length and height; the centre's distance down the facet
    for (const side of [-1, 1]) {
      const c: V3 = [xc, y0 - up[0] * down, side * (z0 - up[1] * down)];
      const vAx: V3 = [0, up[0], side * up[1]];
      const nAx: V3 = [0, out[0], side * out[1]];
      if (hi) {
        const ring = (d: number): Ring => ({ o: along(c, nAx, d), u: [1, 0, 0], v: vAx, hu, hv });
        // Team paint on its face, its edge dark (a bolted-on plate, not a bulge in the door).
        k.pushBy(loft([ring(-0.4), ring(0.7)], 12, 5), (_x, _y, _z, nx, ny, nz) => (nx * nAx[0] + ny * nAx[1] + nz * nAx[2] > 0.5 ? paint : FRAME));
        // Studs: low square-based pyramids (half an octahedron shows), 1.4 uu across, 0.4 proud.
        const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, side * vAx[1], side * vAx[2]), new THREE.Vector3(...nAx));
        for (const [u, v] of [
          [-12.6, 1.75],
          [0, 2],
          [12.6, 1.75],
          [-12.6, -1.75],
          [0, -2],
          [12.6, -1.75],
        ] as const) {
          const stud = new THREE.OctahedronGeometry(1, 0);
          stud.rotateZ(Math.PI / 4);
          stud.scale(1, 1, 0.4);
          stud.applyMatrix4(basis);
          const p = along(along(c, [1, 0, 0], u), vAx, v);
          const q = along(p, nAx, 0.7);
          stud.translate(q[0], q[1], q[2]);
          k.push(stud, STUD);
        }
      } else {
        const slab = new THREE.BoxGeometry(hu * 2, hv * 2, 1.1);
        slab.rotateX(side * Math.atan2(up[1], up[0]));
        const q = along(c, nAx, 0.15);
        slab.translate(q[0], q[1], q[2]);
        k.pushBy(slab, (_x, _y, _z, nx, ny, nz) => (nx * nAx[0] + ny * nAx[1] + nz * nAx[2] > 0.5 ? paint : FRAME));
      }
    }
  }

  // Rock sliders of flat-faced section under the sills on two brackets each, a team light strip
  // along each one's outer face.
  for (const side of [-1, 1]) {
    if (hi) {
      const rail = (x: number): Ring => ({ o: [x, -14.4, side * 31.5], u: [0, 0, 1], v: [0, 1, 0], hu: 2, hv: 1.1 });
      k.push(loft([rail(-27), rail(17)], 8, 4), GRAPHITE);
    } else k.box(GRAPHITE, 44, 2.2, 4, -5, -14.4, side * 31.5);
    k.box(k.strip, 41, 0.75, 0.5, -5, -14.4, side * 33.55);
    for (const x of [-17, 7]) k.box(BRACKET, 2, 1.3, 12, x, -14.6, side * 24.5);
  }

  // Rear step bumper under the cans.
  k.box(TRIM, 2.2, 3, 30, -hl + 1.3, -11.6, 0);
}

export const CARPINCHO: CarBodySpec = {
  id: 'carpincho',
  build,
  // One wheel size all round (radius 15 at rest: 1.2 x the front's physics radius, 1.0 x the
  // rear's), fat (1.15 x 18 uu), their outer faces just inside the fenders' wrapped-down roll.
  wheels: { style: CARPINCHO_WHEEL, visual: 1.2, outer: 39.5, width: 1.15, rear: { visual: 1.0 } },
  // Car-local uu (the build frame + (13.88, 20.76, 0)).
  livery: {
    // Gloss carbon below build y -9: the lower doors, the chin, the fender tips.
    twoToneY: 11.76,
    pinstripe: 0.4,
    accent: CREAM,
    // One bold cream chevron on the flat of the bonnet between the eyes, its tip just behind them
    // (build x 34.9..47.2, |z| < 8): one stripe of the period-14 pattern (phase 56), clear of the
    // fillet, the seam and the grime.
    chevrons: { x0: 48.8, x1: 61.04, halfWidth: 8, period: 14 },
    chevronTint: 1,
    // One seam: the bonnet lid's back edge at the cowl (build x 24.5).
    seams: { x: [38.4, 38.4], maxZ: 24 },
    grime: { y0: 15, y1: 5, amount: 0.6 },
    ao: { y0: 2, y1: 14 },
    // A short heat band at the cans' exits; the rest of each can stays clean metal.
    heat: { x: BOOST_NOZZLE_X, length: 6 },
  },
  budget: { low: 2000, high: 3500 },
};

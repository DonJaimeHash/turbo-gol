/**
 * The Carpincho ('carpincho'): a friendly armoured off-road brute, chunky and calm like the
 * capybara. A barrel-sided body carries a high, boxy cab with rounded corners, a round rump, small
 * flush side windows and a split, bowed windshield; huge round pontoon fenders sit over fat knobby
 * tyres on deep-dish beadlock rims (one size all round); a tubular bull bar with round amber fog
 * lamps guards a blunt snout with two round headlamps (its face); a roof rack with a light bar and
 * a rolled canvas swag, a snorkel up the right A-pillar, round mirrors for ears, rock sliders along
 * the sills, and a short rear deck between the rear fenders holding the two thrusters as big
 * heat-blued exhaust cans, a team-lit ring in each (what the chase camera sees).
 *
 * Designed in the build frame on the default hitbox (kit.hl / hh / hw 58.75 / 17.83 / 41.85; the
 * floor at y -37.8, the wheels at rest at x 37.4 and -47.6, y -22.8, radius 15, tyres |z| 17.1 to
 * 40.5). Side view: sills -14, belt 2.5, windows 5.2..10.7, roof 14.7, rack and light bar to 17.6;
 * the fenders reach y 1 over the axles; cab x -38.5..20 (windshield base), deck behind it at y -5.
 * Top view: bonnet and cab |z| 28, doors 30.4, fenders to 41.6, deck 16.4, rock sliders 35.6.
 */
import * as THREE from 'three/webgpu';
import { BOOST_NOZZLE_X, CAR_KIND, DISC, EXHAUST, HEADLIGHT, TAILLIGHT, TRIM, loft, tube } from './kit';
import type { BodyKit, CarBodySpec, Ring, Surface, WheelAt, WheelStyle } from './types';

type V3 = readonly [number, number, number];
type V2 = readonly [number, number];

/** Graphite tube steel: the bull bar, the rack, the rock sliders. */
const GRAPHITE: Surface = { color: 0x3c424b, metal: 0.65, rough: 0.36, emissive: 0, kind: CAR_KIND.ALLOY };
/** Warm cream alloy: the headlamp bezels. */
const BEZEL: Surface = { color: 0xe4d9bf, metal: 0.6, rough: 0.3, emissive: 0, kind: CAR_KIND.ALLOY };
/** Amber fog lamps. */
const FOG: Surface = { color: 0xffb444, metal: 0, rough: 0.12, emissive: 2.4, kind: CAR_KIND.LAMP };
/** Sand canvas: the rolled swag on the rack. */
const CANVAS: Surface = { color: 0xb49a6c, metal: 0, rough: 0.8, emissive: 0, kind: CAR_KIND.TRIM };
/** Dark anodised brackets, clamps and saddles. */
const BRACKET: Surface = { color: 0x23272e, metal: 0.6, rough: 0.4, emissive: 0, kind: CAR_KIND.DARK_METAL };

/**
 * Deep-dish beadlock wheels: a knobby tyre, a cream beadlock ring with chrome bolts as the lip, six
 * cream spokes running down into a dark dish set well back, a team hub cap. The dune runner's
 * wheel budget.
 */
export const CARPINCHO_WHEEL: WheelStyle = {
  id: 'carpincho-beadlock',
  tyre: 'knobby',
  spokes: 6,
  spokeWidth: 0.24,
  dish: 0.5,
  dishColor: 0x1d2026,
  rim: 0xdccca4,
  rimFinish: { metal: 0.3, rough: 0.45 },
  bead: 0xe2d4b0,
  bolts: 8,
  hub: 'team',
  budget: { low: 440, high: 820 },
};

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

/** The flat ring of a part's outline `pts` (z, y) mapped by `at` into the build frame. */
function mapOutline(pts: readonly V2[], at: (z: number, y: number) => V3): V3[] {
  return pts.map(([z, y]) => at(z, y));
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

/** A cylinder of radius r along x from x0 to x1 at (y, z): lamps, bezels and cans. */
function xCylinder(r0: number, r1: number, x0: number, x1: number, y: number, z: number, seg: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, Math.abs(x1 - x0), seg, 1, false);
  g.rotateZ(-Math.PI / 2); // +y (the top, radius r1) -> +x
  g.translate((x0 + x1) * 0.5, y, z);
  return g;
}

/**
 * A fender flare over `w`: a band of superellipse section swept round the wheel from angle a0 to
 * a1 (radians from the front, over the top), its inner face `gap` over the tyre, `thick` deep,
 * between |z| zIn and zOut; both end rings taper (a rounded nose, never a point).
 */
function flare(k: BodyKit, w: WheelAt, a0: number, a1: number, o: { gap: number; thick: number; zIn: number; zOut: number; n: number; steps: number; seg: number }): void {
  const rm = w.radius + o.gap + o.thick * 0.5;
  const hu = (o.zOut - o.zIn) * 0.5;
  for (const side of [-1, 1]) {
    const zc = side * (o.zIn + hu);
    const rings: Ring[] = [];
    for (let i = 0; i <= o.steps; i++) {
      const a = a0 + ((a1 - a0) * i) / o.steps;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const end = i === 0 || i === o.steps;
      rings.push({ o: [w.x + rm * c, w.y + rm * s, zc], u: [0, 0, 1], v: [c, s, 0], hu: end ? hu * 0.94 : hu, hv: o.thick * (end ? 0.3 : 0.5) });
    }
    k.push(loft(rings, o.seg, o.n), k.paint);
  }
}

// ---- the cab -----------------------------------------------------------------------------------

/** Cab heights (build frame): hidden bottom, belt, window bottom, window top, roof shoulder and crown. */
const CAB_BOT = -1;
const CAB_BELT = 2.5;
const WIN_LO = 5.2;
const WIN_HI = 10.7;
const ROOF = 14.3;
const ROOF_CROWN = 14.7;
/** Cab half widths: belt, window bottom, window top (the tumblehome); the roof's corner radius. */
const CAB_W = 28.4;
const WIN_W0 = 27.9;
const WIN_W1 = 26.5;
const ROOF_RC = ROOF - WIN_HI;
/** The cab's stations along x: the rear wall, the B-pillar, the roof's front edge. */
const CAB_REAR = -38.5;
const B_PILLAR: V2 = [-14, -12];
const ROOF_FRONT = 12;
/** The windshield plane: x at the belt, and its rake (uu back per uu up). */
const WS_X = 20;
const WS_RAKE = 0.38;

function wsX(y: number): number {
  return WS_X - (y - CAB_BELT) * WS_RAKE;
}

/**
 * The cab's round rump, tail forward: [x, width scale, height scale over CAB_BOT]. The roof falls
 * toward the back (the capybara's back) and the rear corners round off. Low detail keeps four.
 */
const RUMP: readonly (readonly [number, number, number])[] = [
  [CAB_REAR, 0.84, 0.82],
  [CAB_REAR + 0.6, 0.93, 0.865],
  [CAB_REAR + 1.5, 0.975, 0.9],
  [CAB_REAR + 2.8, 0.995, 0.925],
  [CAB_REAR + 9, 1, 0.965],
  [CAB_REAR + 19, 1, 0.99],
];
const RUMP_LOW = [0, 1, 3, 5];
/** The rump station where the side windows start (the C-pillar is behind it), raked forward this much at their top. */
const C_PILLAR = RUMP[3];
const WIN_X0 = C_PILLAR[0];
const C_RAKE = 3.4;

/** 0 at the window's bottom edge, 1 at its top (the section's unscaled height). */
function winT(y: number): number {
  return Math.min(1, Math.max(0, (y - WIN_LO) / (WIN_HI - WIN_LO)));
}

/** The rump's height scale at x (1 ahead of it), along the stations `st`. */
function rumpY(st: readonly (readonly [number, number, number])[], x: number): number {
  for (let i = 0; i + 1 < st.length; i++) {
    const [x0, , y0] = st[i];
    const [x1, , y1] = st[i + 1];
    if (x <= x1) return y0 + ((y1 - y0) * Math.max(0, x - x0)) / (x1 - x0);
  }
  const [xl, , yl] = st[st.length - 1];
  return yl + (1 - yl) * Math.min(1, (x - xl) / 6);
}

/** The cab's section (z, y), closed, counter-clockwise from the bottom right. */
function cabSection(hi: boolean): V2[] {
  const arc: V2[] = [];
  const steps = hi ? 3 : 2;
  const cz = WIN_W1 - ROOF_RC;
  for (let i = 1; i <= steps; i++) {
    const t = ((i / steps) * Math.PI) / 2;
    arc.push([cz + ROOF_RC * Math.cos(t), WIN_HI + ROOF_RC * Math.sin(t)]);
  }
  const half: V2[] = [[CAB_W, CAB_BOT], [CAB_W, CAB_BELT], [WIN_W0, WIN_LO], [WIN_W1, WIN_HI], ...arc];
  if (hi) half.push([11, ROOF + (ROOF_CROWN - ROOF) * 0.75]);
  half.push([0, ROOF_CROWN]);
  return mirrored(half);
}

function build(k: BodyKit): void {
  const { hi, hl, paint, glass } = k;
  const { front, back } = k.wheels;

  // Body: barrel-sided doors between the axles, narrowing into a broad bonnet over the front wheels
  // and a blunt rounded snout; behind the cab it drops to the keel's deck.
  k.push(
    loft(
      [
        shoulder(-39.9, 27.5, 1.6, -5, 3.6),
        shoulder(-39.2, 29.8, 2.6, -6.2, 4),
        shoulder(-37.9, 30.4, 3, -7.2, 4),
        shoulder(-35.6, 30.4, 3, -8.8, 4),
        shoulder(-32.5, 30.4, 3, -14, 4),
        shoulder(15.5, 30.4, 3, -14, 4),
        shoulder(19.5, 30.4, 3, -9.5, 4),
        shoulder(23.5, 28.4, 3, -6.5, 4),
        shoulder(49, 28, 2.6, -6, 4),
        shoulder(52.6, 26.6, 2, -8.6, 4),
        shoulder(54.4, 24, 0.9, -10, 3.6),
        shoulder(55.1, 20.5, -0.3, -9.6, 3.2),
      ],
      hi ? 16 : 12,
      3.4,
    ),
    paint,
  );

  // Keel: the narrow chassis between the tyres, nose to tail; behind the cab its top is the deck.
  k.push(
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
    paint,
  );

  // Cab: a high box with tumblehome and a round rump, flush side windows either side of a B-pillar,
  // the windshield plane at its nose (the glass is a pane set into it, below).
  const sec = cabSection(hi);
  const at = (x: number, sz: number, sy: number) => (z: number, y: number): V3 => [x, CAB_BOT + (y - CAB_BOT) * sy, z * sz];
  const rump = hi ? RUMP : RUMP_LOW.map((i) => RUMP[i]);
  const cabRings: V3[][] = [
    // The C-pillar station leans forward with the rump: its window edge rakes, top forward.
    ...rump.map((st) => {
      const [x, sz, sy] = st;
      return mapOutline(sec, st === C_PILLAR ? (z, y) => at(x + C_RAKE * winT(y), sz, sy)(z, y) : at(x, sz, sy));
    }),
    mapOutline(sec, at(B_PILLAR[0], 1, 1)),
    mapOutline(sec, at(B_PILLAR[1], 1, 1)),
    mapOutline(sec, at(ROOF_FRONT, 1, 1)),
    mapOutline(sec, (z, y) => [wsX(y), y, z]),
  ];
  k.pushBy(ringLoft(cabRings), (x, y, _z, _nx, _ny, nz) => {
    const yu = CAB_BOT + (y - CAB_BOT) / rumpY(rump, x); // the unscaled section height
    const band = yu > WIN_LO + 0.05 && yu < WIN_HI - 0.05 && Math.abs(nz) > 0.6;
    const pillar = x < WIN_X0 + C_RAKE * winT(yu) || (x > B_PILLAR[0] && x < B_PILLAR[1]);
    return band && !pillar ? glass : paint;
  });

  // Split windshield: two panes either side of a painted centre post, each bowed forward across
  // its width (a flat pane mirrors the sky as one slab), standing out of the windshield plane
  // inside a painted frame.
  const wsN = new THREE.Vector3(1, WS_RAKE, 0).normalize();
  const onWs = (z: number, y: number, off: number): V3 => [wsX(y) + wsN.x * off, y + wsN.y * off, z];
  const cols = hi ? 3 : 2;
  for (const side of [-1, 1]) {
    const paneRings: V3[][] = [];
    for (let i = 0; i <= cols; i++) {
      const t = i / cols; // 0 at the post, 1 at the A-pillar
      const s = side * (0.05 + 0.95 * t);
      const top = 13.4 - 1.4 * Math.max(0, (t - 0.65) / 0.35) ** 2;
      const out = 0.3 + 0.7 * Math.sin(Math.PI * Math.min(1, t * 1.05));
      paneRings.push([onWs(s * 26.4, 3.9, -0.3), onWs(s * 26.4, 3.9, out), onWs(s * 23.2, top, out), onWs(s * 23.2, top, -0.3)]);
    }
    k.push(ringLoft(paneRings), glass);
  }

  // Rear window pane and two vertical tail lamps on the cab's back wall.
  const rw: V2[] = mirrored([
    [17.0, 5.2],
    [16.4, 9.2],
    [14.8, 10.0],
    [0, 10.2],
  ]);
  k.push(ringLoft([mapOutline(rw, (z, y) => [CAB_REAR + 0.3, y, z]), mapOutline(rw, (z, y) => [CAB_REAR - 0.3, y, z])]), glass);
  for (const side of [-1, 1]) k.box(TAILLIGHT, 0.6, 5.6, 1.8, CAB_REAR - 0.15, 6.0, side * 20.4);

  // Huge round pontoon fenders over all four wheels (team paint): the front ones end high at the
  // nose behind the bull bar, the rear ones at the tail.
  const DEG = Math.PI / 180;
  const fo = { gap: 1.6, thick: 7.2, zIn: 16, zOut: k.hw - 0.25, n: 3, steps: hi ? 8 : 5, seg: hi ? 12 : 8 };
  const rOut = back.radius + fo.gap + fo.thick;
  flare(k, front, 38 * DEG, 152 * DEG, fo);
  flare(k, back, 28 * DEG, Math.acos(Math.max(-1, (-hl + 0.3 - back.x) / rOut)), fo);

  // Twin thrusters: big exhaust cans lying on the rear deck, heat-blued from the exit, a collar
  // round a team-lit ring and a dark throat, a clamp band and a saddle each.
  const { x: nx, y: ny, z: nzz } = k.nozzle;
  const canLen = 14.8;
  const cs = hi ? 16 : 10;
  const glow: Surface = { ...k.strip, emissive: 0.9 };
  for (const side of [-1, 1]) {
    const z = side * nzz;
    k.push(xCylinder(5, 5, nx + 1.2, nx + canLen, ny, z, cs), EXHAUST);
    k.push(xCylinder(5.6, 5.6, nx, nx + 1.6, ny, z, cs), EXHAUST);
    const ring = new THREE.RingGeometry(3.4, 4.4, cs, 1);
    ring.rotateY(-Math.PI / 2);
    ring.translate(nx - 0.1, ny, z);
    k.push(ring, glow);
    const throat = new THREE.CircleGeometry(3.4, cs);
    throat.rotateY(-Math.PI / 2);
    throat.translate(nx - 0.12, ny, z);
    k.push(throat, DISC);
    if (hi) k.push(xCylinder(5.45, 5.45, nx + 7.2, nx + 8.6, ny, z, 12), BRACKET);
    k.box(BRACKET, 9, 2.2, 6, nx + 8, -5.6, z);
  }

  // Snout: a dark grille with three slats between two round headlamps in cream bezels.
  k.box(TRIM, 0.8, 7, 17, 55.2, -5, 0);
  for (const y of [-7, -5, -3]) k.box(GRAPHITE, 0.5, 0.7, 16.4, 55.7, y, 0);
  const ls = hi ? 12 : 8;
  for (const side of [-1, 1]) {
    k.push(xCylinder(3.6, 3.6, 54.6, 55.6, -4.8, side * 15.2, ls), BEZEL);
    k.push(xCylinder(2.85, 2.85, 55.4, 56.1, -4.8, side * 15.2, ls), HEADLIGHT);
  }
  // Skid plate under the snout.
  k.box(GRAPHITE, 5, 1.2, 24, 53.5, -15.6, 0);

  // Tubular bull bar: a bumper tube across the nose in front of the fenders, a round hoop over the
  // grille, round amber fog lamps.
  const barX = hl - 2.0;
  k.push(tube(barX, -11, -30, barX, -11, 30, 1.6, hi ? 10 : 6), GRAPHITE);
  const hoop = new THREE.TorusGeometry(9.4, 1.25, 4, hi ? 10 : 8, Math.PI);
  hoop.rotateY(Math.PI / 2);
  hoop.translate(barX + 0.2, -11, 0);
  k.push(hoop, GRAPHITE);
  const fs = hi ? 12 : 6;
  for (const side of [-1, 1]) {
    k.push(xCylinder(2.7, 2.7, barX - 0.6, barX + 1.2, -8.2, side * 25, fs), TRIM);
    k.push(xCylinder(2.1, 2.1, barX + 1.0, barX + 1.7, -8.2, side * 25, fs), FOG);
  }

  // Roof rack: two rails on four legs (high detail), three cross bars, a light bar across its front.
  const railY = 16.1;
  for (const side of [-1, 1]) {
    k.push(tube(-33, railY, side * 20.5, 7, railY, side * 20.5, 0.75, hi ? 6 : 4), GRAPHITE);
    if (hi) for (const x of [-30, 3]) k.box(BRACKET, 1.4, 2.4, 1.4, x, 15.0, side * 20.5);
  }
  for (const x of [-25, -14, -3]) k.box(GRAPHITE, 1.3, 0.7, 42, x, railY, 0);
  k.box(TRIM, 2.4, 2.4, 36, 8.6, 16.4, 0);
  // A rolled canvas swag strapped across the back of the rack.
  k.push(tube(-28.6, 15.6, -16.5, -28.6, 15.6, 16.5, 1.45, hi ? 10 : 6), CANVAS);
  if (hi) for (const z of [-9, 9]) k.box(BRACKET, 3.3, 3.3, 0.9, -28.6, 15.6, z);
  if (hi) for (const z of [-12, -6, 0, 6, 12]) k.box(HEADLIGHT, 0.5, 1.5, 4.2, 10.05, 16.4, z);
  else k.box(HEADLIGHT, 0.5, 1.5, 28.6, 10.05, 16.4, 0);

  // Snorkel out of the right front fender, up the A-pillar, its ram head facing forward over the roof line.
  const sn = hi ? 8 : 4;
  k.push(tube(25.5, -2.5, 31, 21.1, 4.3, 30.1, 1.35, sn), TRIM);
  k.push(tube(21.4, 3.8, 30.1, 16.7, 14.4, 28.8, 1.35, sn), TRIM);
  k.push(xCylinder(1.9, 1.9, 15.4, 20.4, 14.7, 28.8, hi ? 10 : 6), TRIM);

  // Round mirrors on stalks at the A-pillars (the capybara's ears).
  for (const side of [-1, 1]) {
    k.push(tube(16.3, 6.4, side * 27.8, 15.7, 7.8, side * 30.4, 0.45, 4), BRACKET);
    const mirror = new THREE.SphereGeometry(1, hi ? 7 : 5, hi ? 4 : 3);
    mirror.scale(1.3, 2.0, 2.3);
    mirror.translate(15.6, 8.4, side * 31.2);
    k.push(mirror, paint);
  }

  // Team light strips along the doors, rock sliders along the sills between the fender ends.
  for (const side of [-1, 1]) {
    k.box(k.strip, 46, 0.9, 0.6, -7.5, -6, side * 30.1);
    k.push(tube(-30.5, -13.4, side * 35.6, 20.3, -13.4, side * 35.6, 1.7, hi ? 8 : 5), GRAPHITE);
    if (hi) for (const x of [-17, 3]) k.box(BRACKET, 2.2, 1.4, 5, x, -13.2, side * 32.6);
  }

  // Rear step bumper under the cans.
  k.box(TRIM, 2.2, 3, 30, -hl + 1.3, -11.6, 0);
}

export const CARPINCHO: CarBodySpec = {
  id: 'carpincho',
  build,
  // One wheel size all round (radius 15 at rest: 1.2 x the front's physics radius, 1.0 x the
  // rear's), fat (1.3 x 18 uu) and flush with the fenders.
  wheels: { style: CARPINCHO_WHEEL, visual: 1.2, outer: 40.5, width: 1.3, rear: { visual: 1.0 } },
  // Car-local uu (the build frame + (13.88, 20.76, 0)).
  livery: {
    // Gloss carbon only along the lowest band of the doors and the fender ends (build y -11.8).
    twoToneY: 9,
    pinstripe: 0.4,
    accent: 0xf2b54a,
    // Soft forward chevrons on the bonnet (build x 30..52), tinted toward the sand accent.
    chevrons: { x0: 44, x1: 66, halfWidth: 10, period: 12 },
    chevronTint: 0.7,
    // The bonnet lid: its front edge and its back edge before the windshield.
    seams: { x: [65.5, 36.6], maxZ: 22 },
    grime: { y0: 15, y1: 5, amount: 0.7 },
    ao: { y0: 2, y1: 14 },
    // The cans run 14.8 uu forward of the exit plane: the heat tint fades along them.
    heat: { x: BOOST_NOZZLE_X, length: 14 },
  },
  budget: { low: 2000, high: 3500 },
};

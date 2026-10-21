/**
 * Red canyon generator (original design, baked only): the stadium sits on the sandy floor of a
 * meandering canyon whose walls rise in tiers of sheer cliffs and benches right behind the stands;
 * toward the far goal (+z) the canyon opens onto a valley of mesas and buttes under the setting
 * sun, with a gap on the horizon where the sun goes down.
 *
 * Everything is one analytic height function H(x, z) evaluated on the CPU:
 *   canyon walls   three tiers of near-vertical cliffs (smoothsteps over a short run) separated by
 *                  benches whose depth wanders along the canyon; the wall line itself wobbles in
 *                  and out (buttresses and alcoves), with a talus slope at its foot. The nearest
 *                  walls stand at least NEAR_WALL from the canyon axis, so the dome's parallax
 *                  proxy (dome.ts) does not shear them from the arena's corner cameras; beyond
 *                  both ends the canyon narrows, so its walls frame the views through the ends
 *   buttes         steep-sided, flat-topped towers (some with a second tier) in the opening, none
 *                  in the sun's azimuth window, so the disc sets in a notch of the horizon
 *   strata         floor(h / STEP) + smoothstep riser: ledges across every cliff face
 * The mesh is a polar grid around the origin, its rings densest where the near cliffs stand. Sun
 * shadows: every vertex marches toward the sun over a height grid (fine near the arena, coarse
 * beyond); ambient occlusion compares the vertex with the mean height around it. Both are stored
 * per vertex (kdat.x / kdat.y) for the STRATA pattern; kdat.z holds the cliff steepness hint.
 */
import * as THREE from 'three/webgpu';
import { GeoBuilder, KIND, rng, type Lamp } from './geo';
import { SKYLINE_TOP } from './harbour';

/** Nearest distance (uu) of the first cliff from the canyon's axis (the parallax proxy's limit). */
export const NEAR_WALL = 11800;
/** Strata step (uu): every cliff face shows a ledge at each multiple of it. */
const STEP = 380;

const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function hash2(ix: number, iz: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise2(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function fbm2(x: number, z: number, oct: number): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let n = 0;
  for (let o = 0; o < oct; o++) {
    s += a * vnoise2(x * f + o * 17.3, z * f - o * 9.1);
    n += a;
    f *= 2.03;
    a *= 0.5;
  }
  return s / n;
}

/** A height grid of H over a square [-E, E]^2 with bilinear lookup (shadow march, occlusion). */
function heightGrid(H: (x: number, z: number) => number, n: number, E: number): (x: number, z: number) => number {
  const grid = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) grid[j * n + i] = H(-E + ((i + 0.5) / n) * 2 * E, -E + ((j + 0.5) / n) * 2 * E);
  }
  return (x, z) => {
    const fx = ((x + E) / (2 * E)) * n - 0.5;
    const fz = ((z + E) / (2 * E)) * n - 0.5;
    const i = Math.max(0, Math.min(n - 2, Math.floor(fx)));
    const j = Math.max(0, Math.min(n - 2, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - i));
    const v = Math.min(1, Math.max(0, fz - j));
    const a = grid[j * n + i];
    const b = grid[j * n + i + 1];
    const c = grid[(j + 1) * n + i];
    const d = grid[(j + 1) * n + i + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

export interface Canyon {
  readonly geometry: THREE.BufferGeometry | null;
  readonly lamps: Lamp[];
  readonly stats: { readonly parts: number; readonly verts: number };
}

/** Build the canyon; `sunDir` (unit, toward the sun) bakes the terrain shadows and keeps the sun's notch open. */
export function buildCanyon(sunDir: readonly [number, number, number], dry = false, seed = 11): Canyon {
  const g = new GeoBuilder(dry);
  if (dry) return { geometry: null, lamps: [], stats: { parts: 0, verts: 0 } };
  const R = rng(seed);
  const sunAz = Math.atan2(sunDir[0], sunDir[2]);
  const buttes: { x: number; z: number; r: number; h: number; cap: number }[] = [];
  for (let i = 0; buttes.length < 30 && i < 200; i++) {
    const z = 26000 + R() * 90000;
    const x = (R() - 0.5) * (14000 + z * 0.95);
    const r = 1300 + R() * 4200;
    const h = 2600 + R() * 6400;
    const cap = R() < 0.45 ? 0.55 + R() * 0.25 : 1;
    // keep the sun's notch clear: no butte within a few degrees of its azimuth
    let d = Math.atan2(x, z) - sunAz;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) < Math.atan2(r * 1.2, Math.hypot(x, z)) + 0.08) continue;
    buttes.push({ x, z, r, h, cap });
  }
  // Terrain above CAP_START is eased toward SKYLINE_TOP (harbour.ts: under the dome's parallax
  // band). The strata add at most ~10 uu and the surface noise under 60 uu on top of it.
  const CAP_START = 8400;
  const CAP_ROOM = SKYLINE_TOP - 200 - CAP_START;
  const H = (x: number, z: number): number => {
    const meander = 1600 * Math.sin(z / 23000) + 600 * Math.sin(z / 7700 + 1.3);
    const side = x >= meander ? 1 : -1;
    const ax = Math.abs(x - meander);
    // beside the arena the walls keep NEAR_WALL; beyond both ends the canyon narrows (so its walls
    // frame the views through the ends; less on the right of the far end, where the sun sets),
    // then far behind the red goal it opens onto the valley of buttes
    const narrow = sstep(9000, 26000, Math.abs(z)) * (side > 0 || z < 0 ? 3600 : 1300);
    const open = sstep(44000, 95000, z);
    const W = NEAR_WALL + 2000 * fbm2(z / 18000, 3.3, 2) - narrow + open * 30000;
    let h = 0;
    // (the wobble only pushes the wall outward: nearer than W - 1700 is canyon floor)
    if (ax > W - 1700) {
      // the wall line wobbles in and out (buttresses, alcoves); never nearer than NEAR_WALL
      const wob = 1700 * fbm2(z / 4200, side * 7.7, 3) + 500 * fbm2(z / 1100, side * 3.1, 2);
      const dx = ax - wob;
      // three tiers of cliffs separated by benches
      const P = 7600 + 2000 * fbm2(x / 16000 + 5, z / 16000, 3);
      const run = 520 + 360 * fbm2(z / 2600, side * 5.5, 2);
      const b1 = 1100 + 1900 * fbm2(z / 6000, side * 2.1, 2);
      const b2 = 900 + 2100 * fbm2(z / 7000, side * 4.3, 2);
      const e1 = W + run + b1;
      const e2 = e1 + run + b2;
      h = P * (0.44 * sstep(W, W + run, dx) + 0.32 * sstep(e1, e1 + run, dx) + 0.24 * sstep(e2, e2 + run * 1.3, dx));
      // talus at the foot of the first cliff
      h = Math.max(h, 520 * sstep(W - 1700, W + 120, dx));
    }
    if (z > 18000) {
      for (const b of buttes) {
        const dx2 = x - b.x;
        const dz2 = z - b.z;
        const rr = b.r * 1.12;
        if (dx2 * dx2 + dz2 * dz2 < rr * rr) {
          const d = Math.hypot(dx2, dz2);
          // a sheer tower, its top tier set back when it has one
          const t = sstep(rr, b.r * 0.96, d) * b.h * (b.cap < 1 ? b.cap + (1 - b.cap) * sstep(b.r * 0.72, b.r * 0.62, d) : 1);
          h = Math.max(h, t);
        }
      }
    }
    if (h > CAP_START) h = CAP_START + CAP_ROOM * (1 - Math.exp(-(h - CAP_START) / CAP_ROOM));
    // strata: flat ledges, steep risers on every cliff face
    const t = h / STEP;
    h = (Math.floor(t) + sstep(0.55, 1.0, t - Math.floor(t))) * STEP;
    if (h > 1) h += (fbm2(x / 1400, z / 1400, 3) - 0.5) * 110 * Math.min(1, h / 1500);
    // sandy floor with low dunes
    const floor = -30 + (fbm2(x / 3000, z / 3000, 2) - 0.5) * 90 * sstep(6000, 12000, Math.hypot(x, z));
    return Math.max(h, floor);
  };

  // ---- height grids for the shadow march / occlusion: fine round the arena, coarse beyond
  const NEAR_E = 34000;
  const Gn = heightGrid(H, 256, NEAR_E);
  const Gf = heightGrid(H, 176, 130000);
  const G = (x: number, z: number): number => (Math.abs(x) < NEAR_E - 300 && Math.abs(z) < NEAR_E - 300 ? Gn(x, z) : Gf(x, z));
  const sunVis = (x: number, y: number, z: number): number => {
    let t = 160;
    let vis = 1;
    for (let k = 0; k < 26 && t < 90000; k++) {
      const h = G(x + sunDir[0] * t, z + sunDir[2] * t);
      vis = Math.min(vis, sstep(-180, 180, y + sunDir[1] * t - h)); // soft penumbra
      if (vis <= 0) break;
      t *= 1.3;
    }
    return vis;
  };

  // ---- polar mesh: dense rings where the near cliffs stand, coarser beyond
  const NT = 576;
  const radii: number[] = [];
  for (let r = 6500; r < 150000; r *= r < 42000 ? 1.0135 : 1.03) radii.push(r);
  const NR = radii.length;
  const nv = NT * NR;
  const pos = new Float32Array(nv * 3);
  const rgb = new Float32Array(nv * 3);
  const dat = new Float32Array(nv * 4);
  for (let ri = 0; ri < NR; ri++) {
    const r = radii[ri];
    for (let ti = 0; ti < NT; ti++) {
      const a = (ti / NT) * Math.PI * 2;
      const x = Math.sin(a) * r;
      const z = Math.cos(a) * r;
      const y = H(x, z);
      const k = ri * NT + ti;
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      // sand on the floor, rock tint above; slight per-vertex variation
      const rock = sstep(150, 700, y);
      const tint = 0.9 + 0.2 * hash2(ri, ti);
      rgb[k * 3] = (0.62 * (1 - rock) + rock) * tint;
      rgb[k * 3 + 1] = (0.42 * (1 - rock) + rock) * tint;
      rgb[k * 3 + 2] = (0.3 * (1 - rock) + rock) * tint;
      dat[k * 4] = sunVis(x, y + 40, z);
      const around = (G(x + 2200, z) + G(x - 2200, z) + G(x, z + 2200) + G(x, z - 2200)) * 0.25;
      dat[k * 4 + 1] = 0.45 + 0.55 * sstep(-2600, 300, y - around);
      dat[k * 4 + 3] = hash2(ti, ri);
    }
  }
  const idx = new Uint32Array((NR - 1) * NT * 6);
  let n = 0;
  for (let ri = 0; ri < NR - 1; ri++) {
    for (let ti = 0; ti < NT; ti++) {
      const a = ri * NT + ti;
      const b = ri * NT + ((ti + 1) % NT);
      const c = (ri + 1) * NT + ti;
      const d = (ri + 1) * NT + ((ti + 1) % NT);
      // counter-clockwise seen from above (+y)
      idx[n++] = a;
      idx[n++] = c;
      idx[n++] = b;
      idx[n++] = b;
      idx[n++] = c;
      idx[n++] = d;
    }
  }
  // normals from the mesh itself (cheaper than two extra height evaluations per vertex)
  const tmp = new THREE.BufferGeometry();
  tmp.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  tmp.setIndex(new THREE.BufferAttribute(idx, 1));
  tmp.computeVertexNormals();
  const nrm = Float32Array.from(tmp.attributes.normal.array as ArrayLike<number>);
  tmp.dispose();
  g.raw(pos, nrm, idx, rgb, dat, KIND.STRATA);
  // a sand disc under the stadium, so the floor has no hole in the middle
  g.boxAt(0, -60, 0, 7000, 30, 7000, [0.62 * 0.95, 0.42 * 0.95, 0.3 * 0.95], KIND.GROUND, 0.3);
  return { geometry: g.build(), lamps: [], stats: { parts: g.parts, verts: g.verts } };
}

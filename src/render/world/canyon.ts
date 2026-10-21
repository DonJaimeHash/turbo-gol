/**
 * Red canyon generator (original design, baked only): the stadium sits on the sandy floor of a
 * meandering canyon whose terraced walls rise right behind the stands; toward the far goal (+z) the
 * canyon opens onto a valley of mesas and buttes under the setting sun.
 *
 * Everything is one analytic height function H(x, z) evaluated on the CPU:
 *   canyon walls   smooth step on the distance to a meandering axis, plateau height from fbm
 *   buttes         a few steep-sided discs scattered in the opening
 *   terraces       floor(h / step) + smoothstep riser: flat ledges, steep cliffs
 * The mesh is a polar grid around the origin (fine near, coarse far). Sun shadows: every vertex
 * marches toward the sun over a coarse height grid; ambient occlusion compares the vertex with the
 * mean height around it. Both are stored per vertex (kdat.x / kdat.y) for the STRATA pattern.
 */
import * as THREE from 'three/webgpu';
import { GeoBuilder, KIND, rng, type Lamp } from './geo';
import { SKYLINE_TOP } from './harbour';

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

export interface Canyon {
  readonly geometry: THREE.BufferGeometry | null;
  readonly lamps: Lamp[];
  readonly stats: { readonly parts: number; readonly verts: number };
}

/** Build the canyon; `sunDir` (unit, toward the sun) bakes the terrain shadows. */
export function buildCanyon(sunDir: readonly [number, number, number], dry = false, seed = 11): Canyon {
  const g = new GeoBuilder(dry);
  if (dry) return { geometry: null, lamps: [], stats: { parts: 0, verts: 0 } };
  const R = rng(seed);
  const buttes: { x: number; z: number; r: number; h: number }[] = [];
  for (let i = 0; i < 26; i++) {
    const z = 26000 + R() * 90000;
    const x = (R() - 0.5) * (12000 + z * 0.9);
    buttes.push({ x, z, r: 1500 + R() * 4500, h: 2500 + R() * 7000 });
  }
  const STEP = 620;
  // Terrain above CAP_START is eased toward SKYLINE_TOP (harbour.ts: under the dome's parallax
  // band). The terraces add at most ~20 uu and the surface noise under 130 uu on top of it.
  const CAP_START = 8400;
  const CAP_ROOM = SKYLINE_TOP - 200 - CAP_START;
  const H = (x: number, z: number): number => {
    const meander = 2600 * Math.sin(z / 23000) + 1100 * Math.sin(z / 7700 + 1.3);
    const dx = Math.abs(x - meander);
    const open = sstep(22000, 80000, z);
    const W = 9000 + 2600 * fbm2(z / 18000, 3.3, 2) + open * 26000;
    const wall = sstep(W, W + 2400 + 2600 * fbm2(x / 9000, z / 9000, 2), dx);
    const plateau = 7200 + 4200 * fbm2(x / 16000 + 5, z / 16000, 4);
    let h = wall * plateau;
    if (z > 20000) {
      for (const b of buttes) {
        const dx2 = x - b.x;
        const dz2 = z - b.z;
        const rr = b.r * 1.15;
        if (dx2 * dx2 + dz2 * dz2 < rr * rr) h = Math.max(h, sstep(rr, b.r * 0.9, Math.hypot(dx2, dz2)) * b.h);
      }
    }
    if (h > CAP_START) h = CAP_START + CAP_ROOM * (1 - Math.exp(-(h - CAP_START) / CAP_ROOM));
    // terraces: flat ledges, steep risers
    const t = h / STEP;
    h = (Math.floor(t) + sstep(0.5, 1.0, t - Math.floor(t))) * STEP;
    h += (fbm2(x / 1400, z / 1400, 3) - 0.5) * 260 * Math.min(1, h / 1500);
    // sandy floor with low dunes
    const floor = -30 + (fbm2(x / 3000, z / 3000, 2) - 0.5) * 90 * sstep(6000, 12000, Math.hypot(x, z));
    return Math.max(h, floor);
  };

  // ---- coarse height grid for the shadow march / occlusion
  const GN = 256;
  const GE = 130000;
  const grid = new Float32Array(GN * GN);
  for (let j = 0; j < GN; j++) {
    for (let i = 0; i < GN; i++) grid[j * GN + i] = H(-GE + ((i + 0.5) / GN) * 2 * GE, -GE + ((j + 0.5) / GN) * 2 * GE);
  }
  const G = (x: number, z: number): number => {
    const fx = ((x + GE) / (2 * GE)) * GN - 0.5;
    const fz = ((z + GE) / (2 * GE)) * GN - 0.5;
    const i = Math.max(0, Math.min(GN - 2, Math.floor(fx)));
    const j = Math.max(0, Math.min(GN - 2, Math.floor(fz)));
    const u = Math.min(1, Math.max(0, fx - i));
    const v = Math.min(1, Math.max(0, fz - j));
    const a = grid[j * GN + i];
    const b = grid[j * GN + i + 1];
    const c = grid[(j + 1) * GN + i];
    const d = grid[(j + 1) * GN + i + 1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const sunVis = (x: number, y: number, z: number): number => {
    let t = 300;
    let vis = 1;
    for (let k = 0; k < 22 && t < 90000; k++) {
      const h = G(x + sunDir[0] * t, z + sunDir[2] * t);
      vis = Math.min(vis, sstep(-250, 250, y + sunDir[1] * t - h)); // soft penumbra
      if (vis <= 0) break;
      t *= 1.35;
    }
    return vis;
  };

  // ---- polar mesh
  const NT = 512;
  const radii: number[] = [];
  for (let r = 6500; r < 150000; r *= 1.03) radii.push(r);
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
      const around = (G(x + 2500, z) + G(x - 2500, z) + G(x, z + 2500) + G(x, z - 2500)) * 0.25;
      dat[k * 4 + 1] = 0.55 + 0.45 * sstep(-2500, 400, y - around);
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

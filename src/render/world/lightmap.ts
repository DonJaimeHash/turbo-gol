/**
 * Lamp light map, computed on the CPU once per skyline (typed arrays, no GPU loop).
 *
 * The yard masts, crane floods, quay posts and ship lights (~40 point lamps) would cost a loop in
 * every shaded pixel and seconds of shader compilation. Their light changes slowly over space, so
 * it is evaluated on a top-down grid at two heights instead:
 *
 *   tile 0 / 2: irradiance on an UP-facing surface at height layers[0] / layers[1] (rgb) + the
 *               mean horizontal direction toward the lamps (x)
 *   tile 1 / 3: irradiance on a SIDE-facing surface turned toward the lamps (rgb) + direction (z)
 *
 * The structure materials read it with 4 bilinear taps (atmosphere.ts lampLight). Each lamp only
 * touches the texels within its reach (4 x range), so a build costs a few milliseconds.
 */
import * as THREE from 'three/webgpu';
import { sstep, type Lamp } from './geo';

export interface LightMap {
  readonly texture: THREE.DataTexture;
  /** Texels across (the texture is res x 4 * res) and its half-float texels (for the cache). */
  readonly res: number;
  readonly data: Uint16Array;
  /** xz rectangle covered: x0, z0, width, depth (uu). */
  readonly rect: readonly [number, number, number, number];
  /** Heights of the two layers (uu). */
  readonly layers: readonly [number, number];
}

const sat = (x: number): number => Math.min(1, Math.max(0, x));

/** The float texels of a light map (rgba, `res` wide, 4 * `res` high), for tests and the texture. */
export function lightMapTexels(lamps: readonly Lamp[], res: number, layers: readonly [number, number]): { data: Float32Array; rect: [number, number, number, number] } {
  // cover every lamp's reach (4 x range)
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const L of lamps) {
    const r = L.range * 4;
    x0 = Math.min(x0, L.pos[0] - r);
    x1 = Math.max(x1, L.pos[0] + r);
    z0 = Math.min(z0, L.pos[2] - r);
    z1 = Math.max(z1, L.pos[2] + r);
  }
  if (!Number.isFinite(x0)) {
    x0 = -1;
    x1 = 1;
    z0 = -1;
    z1 = 1;
  }
  const rect: [number, number, number, number] = [x0, z0, x1 - x0, z1 - z0];
  const W = res;
  const data = new Float32Array(W * res * 4 * 4);
  // accumulators per layer: up rgb, side rgb, direction x / z (luminance weighted), weight
  const acc = new Float32Array(res * res * 9);
  for (let layer = 0; layer < 2; layer++) {
    const y = layers[layer];
    acc.fill(0);
    for (const L of lamps) {
      const reach = L.range * 4;
      const i0 = Math.max(0, Math.floor(((L.pos[0] - reach - x0) / rect[2]) * res));
      const i1 = Math.min(res - 1, Math.ceil(((L.pos[0] + reach - x0) / rect[2]) * res));
      const j0 = Math.max(0, Math.floor(((L.pos[2] - reach - z0) / rect[3]) * res));
      const j1 = Math.min(res - 1, Math.ceil(((L.pos[2] + reach - z0) / rect[3]) * res));
      const r2 = L.range * L.range;
      for (let j = j0; j <= j1; j++) {
        const z = z0 + ((j + 0.5) / res) * rect[3];
        for (let i = i0; i <= i1; i++) {
          const x = x0 + ((i + 0.5) / res) * rect[2];
          const vx = L.pos[0] - x;
          const vy = L.pos[1] - y;
          const vz = L.pos[2] - z;
          const d2 = Math.max(vx * vx + vy * vy + vz * vz, 1);
          if (d2 >= 16 * r2) continue;
          const d = Math.sqrt(d2);
          const ly = vy / d;
          const k = (r2 / (d2 + r2)) * (1 - d2 / (16 * r2)) * (L.down ? sstep(0.15, 0.6, ly) : 1);
          if (k <= 0) continue;
          const h = Math.hypot(vx, vz) / d;
          const up = k * sat(ly * 0.85 + 0.15);
          const side = k * sat(h * 0.85 + 0.15);
          const o = (j * res + i) * 9;
          acc[o] += L.color[0] * up;
          acc[o + 1] += L.color[1] * up;
          acc[o + 2] += L.color[2] * up;
          acc[o + 3] += L.color[0] * side;
          acc[o + 4] += L.color[1] * side;
          acc[o + 5] += L.color[2] * side;
          const lum = (L.color[0] + L.color[1] + L.color[2]) * side;
          if (h > 1e-4) {
            acc[o + 6] += (vx / d / h) * lum;
            acc[o + 7] += (vz / d / h) * lum;
          }
          acc[o + 8] += lum;
        }
      }
    }
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const o = (j * res + i) * 9;
        const w = acc[o + 8];
        const a = (layer * 2 * res + j) * W + i;
        const b = ((layer * 2 + 1) * res + j) * W + i;
        data[a * 4] = acc[o];
        data[a * 4 + 1] = acc[o + 1];
        data[a * 4 + 2] = acc[o + 2];
        data[a * 4 + 3] = w > 0 ? acc[o + 6] / w : 0;
        data[b * 4] = acc[o + 3];
        data[b * 4 + 1] = acc[o + 4];
        data[b * 4 + 2] = acc[o + 5];
        data[b * 4 + 3] = w > 0 ? acc[o + 7] / w : 0;
      }
    }
  }
  return { data, rect };
}

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

/**
 * Float to half-float bits, truncating (a light map does not need round-to-nearest), for values
 * already clamped to the half range. Inlined bit maths: ~10x faster than a table call per texel.
 */
export function toHalfBits(v: number): number {
  _f32[0] = v;
  const x = _u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 112; // rebias 127 -> 15
  const m = x & 0x7fffff;
  if (e <= 0) return e < -10 ? sign : sign | ((m | 0x800000) >> (14 - e));
  if (e >= 31) return sign | 0x7c00;
  return sign | (e << 10) | (m >> 13);
}

/** Build the light map texture of a skyline's lamps (HalfFloat RGBA, `res` x 4 * `res`). */
export function buildLightMap(lamps: readonly Lamp[], res = 256, layers: readonly [number, number] = [0, 3000]): LightMap {
  const { data, rect } = lightMapTexels(lamps, res, layers);
  const u16 = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    u16[i] = v === 0 ? 0 : toHalfBits(v > 60000 ? 60000 : v < -60000 ? -60000 : v);
  }
  return lightMapFromData(u16, res, rect, layers);
}

/** A light map from its half-float texels (a fresh build or the cache). */
export function lightMapFromData(data: Uint16Array, res: number, rect: readonly [number, number, number, number], layers: readonly [number, number]): LightMap {
  const texture = new THREE.DataTexture(data, res, res * 4, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, res, data, rect: [rect[0], rect[1], rect[2], rect[3]], layers: [layers[0], layers[1]] };
}

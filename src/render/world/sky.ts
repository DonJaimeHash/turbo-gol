/**
 * The night sky dome around the stadium (moved from Renderer.ts; the world phase of
 * docs/visuals/REWORK.md replaces it with a baked sky + backdrop per theme).
 */
import * as THREE from 'three/webgpu';
import { atan, float, floor, hash, mix, mx_fractal_noise_float, mx_noise_float, normalize, oneMinus, positionWorld, sin, smoothstep, step, time, vec2, vec3 } from 'three/tsl';
import { glowMrt, type Vec3Node } from '../materials';

/** Radius of the dome (uu), inside the camera's far plane. */
const SKY_RADIUS = 32000;
/** Sky horizon colour (linear); also the fog and clear colour so distant tiers blend into the sky. */
export const HORIZON = { r: 0.11, g: 0.15, b: 0.27 } as const;

/**
 * Night-stadium sky: gradient dome (horizon glow -> deep blue zenith), two layers of twinkling
 * stars (a few peak above 1 and bloom), a warm city glow with a noisy skyline at the horizon and a
 * thin drifting cloud band. Drawn LAST among opaques (renderOrder 1000, depth tested, no depth
 * write) so it only shades the pixels the arena left uncovered: zero overdraw from inside the
 * shell, and it fills the view through the glass. Shown on every quality tier.
 */
export function buildSkyDome(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 24, 12);
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  const dir = normalize(positionWorld);
  const up = dir.y;
  const horizon = vec3(HORIZON.r, HORIZON.g, HORIZON.b);
  const mid = vec3(0.035, 0.05, 0.11);
  const zenith = vec3(0.012, 0.015, 0.035);
  const gradient = mix(mix(horizon, mid, smoothstep(-0.02, 0.25, up)), zenith, smoothstep(0.25, 0.9, up));

  // City glow: sodium haze under the horizon line, shaped by a noisy skyline.
  const az = atan(dir.z, dir.x);
  const skyline = mx_noise_float(vec2(az.mul(4.0), 0.0)).mul(0.5).add(0.5);
  const glow = oneMinus(smoothstep(-0.02, 0.14, up)).mul(float(0.35).add(skyline.mul(0.65)));
  const city = vec3(0.3, 0.2, 0.1).mul(glow).mul(0.9);

  // Cloud band drifting slowly.
  const c = mx_fractal_noise_float(vec3(dir.xz.mul(2.5).add(time.mul(0.008)), 0.0), 3);
  const cloud = vec3(0.04, 0.05, 0.09).mul(smoothstep(0.45, 0.8, c)).mul(smoothstep(0.05, 0.35, up));

  const aboveHorizon = smoothstep(0.08, 0.45, up);
  const starLayer = (cellSize: number, threshold: number, gain: number): Vec3Node => {
    const cell = floor(dir.xz.mul(cellSize));
    const h = hash(cell.x.add(cell.y.mul(131.7)));
    const on = step(threshold, h);
    const twinkle = float(0.8).add(sin(time.mul(1.7).add(h.mul(6.283))).mul(0.6));
    return vec3(0.9, 0.95, 1.0).mul(on.mul(twinkle).mul(gain).mul(aboveHorizon));
  };
  const stars = starLayer(420, 0.9965, 0.5).add(starLayer(900, 0.994, 0.9));

  material.colorNode = gradient.add(city).add(cloud).add(stars);
  material.mrtNode = glowMrt(stars.mul(0.6), 'none');
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

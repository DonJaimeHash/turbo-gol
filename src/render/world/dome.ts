/**
 * The per-frame backdrop: the dome that shows the baked cube, and the lighthouse beam.
 *
 * Dome: one back-faced sphere drawn LAST among opaques (renderOrder 1000, depth tested, no depth
 * write), so it only shades the pixels the stadium and the live harbour leave uncovered. It
 * samples the baked cube in a parallax-corrected direction: the camera ray is intersected with a
 * vertical cylinder round the bake origin whose radius depends only on azimuth, R(az) = the mean
 * distance of the baked skyline (the proxy lookup, bake.ts), refined `iterations` times; above
 * the skyline (uTop) the lookup blends back to the raw view direction, so clouds, the moon and
 * stars stay at infinity. Rays going down also meet the ground plane (uGround): the nearer hit
 * wins, so the quay round the stadium gets the parallax of a floor, not of a wall. 0 iterations
 * would be a classic skybox.
 *
 * Beam: an additive cone from the lantern, swept round on the GPU clock (no per-frame CPU work),
 * brightest along its axis and near the lamp, transparent at its silhouette (a fake volumetric
 * falloff from the view angle). Only on tiers with geometry detail (high, ultra).
 */
import * as THREE from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import {
  Fn,
  abs,
  atan,
  cameraPosition,
  cubeTexture,
  dot,
  float,
  length,
  max,
  min,
  mix,
  normalLocal,
  normalize,
  oneMinus,
  positionLocal,
  positionWorld,
  pow,
  rotate,
  saturate,
  smoothstep,
  sqrt,
  step,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { glowMrt } from '../materials';
import { PROXY_SCALE } from './bake';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/**
 * Live dome radius (uu): inside the camera's far plane (40000) from anywhere in the arena box (at
 * most ~8150 from the origin), and outside every live part (harbour.ts LIVE_RADIUS).
 */
export const DOME_RADIUS = 31000;
/** Heights (uu over the bake origin) where the parallax proxy hands over to "at infinity". */
export const PROXY_TOP: readonly [number, number] = [10000, 15000];
/** Lighthouse beam length (uu) and its sweep speed (rad / s). */
const BEAM_LEN = 9000;
const BEAM_SPEED = 0.55;

export interface Dome {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicNodeMaterial;
  /** The cube and proxy lookup it samples (swap `.value`, never the node). */
  readonly cube: ReturnType<typeof cubeTexture>;
  readonly lut: ReturnType<typeof texture>;
  dispose(): void;
}

/**
 * The view direction to sample the baked cube with (see the file header). `lut` is the proxy
 * lookup, `uOrigin` the bake origin, `uTop` the hand-over heights, `uGround` the floor height
 * relative to the origin.
 */
function parallaxDir(lut: ReturnType<typeof texture>, uOrigin: UniformNode<'vec3', THREE.Vector3>, uTop: UniformNode<'vec2', THREE.Vector2>, uGround: UniformNode<'float', number>, iterations: number): V3 {
  const d = positionWorld.sub(cameraPosition);
  const rd = d.div(max(length(d), 1e-3)).toVar();
  if (iterations === 0) return rd;
  const ro = cameraPosition.sub(uOrigin).toVar();
  const a = max(dot(rd.xz, rd.xz), 1e-6);
  const b = dot(ro.xz, rd.xz);
  const cc = dot(ro.xz, ro.xz);
  let az: Node<'vec2'> = rd.xz.div(sqrt(a));
  let t: F = float(1e7);
  for (let i = 0; i < iterations; i++) {
    // R(az) from the baked lookup, u = azimuth / 2pi + 0.5
    const u = atan(az.x, az.y).div(Math.PI * 2).add(0.5);
    const R = (lut.sample(vec2(u, 0.5)) as unknown as Node<'vec4'>).x.mul(PROXY_SCALE);
    t = b.negate().add(sqrt(max(b.mul(b).sub(a.mul(cc.sub(R.mul(R)))), 0.0))).div(a);
    const hitXZ = ro.xz.add(rd.xz.mul(t));
    az = hitXZ.div(max(length(hitXZ), 1e-3));
  }
  // only clearly-near ground (plane hit well inside the cylinder) is treated as floor, with a
  // smooth hand-over, so things standing at the proxy radius keep their cylinder parallax
  const tPlane = uGround.sub(ro.y).div(min(rd.y, -1e-4));
  const ratio = tPlane.div(max(t, 1.0));
  const k = oneMinus(smoothstep(0.45, 0.75, ratio)).mul(step(rd.y, 0.0)).mul(step(0.0, tPlane));
  const tt = mix(t, tPlane, k);
  const hit = ro.add(rd.mul(tt));
  // above the skyline (uTop.x .. uTop.y over the origin) the backdrop is at infinity
  const w = smoothstep(uTop.x, uTop.y, hit.y);
  return normalize(mix(hit.div(max(length(hit), 1.0)), rd, w));
}

/**
 * The dome over `cubeTex` with the proxy lookup `lut`, centred on the bake origin. `iterations`
 * (1 or 2) of the parallax search; the floor sits at `groundY`.
 */
export function buildDome(cubeTex: THREE.CubeTexture, lutTex: THREE.Texture, origin: THREE.Vector3, groundY: number, iterations: number): Dome {
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  const uOrigin = uniform(origin.clone());
  const uTop = uniform(new THREE.Vector2(PROXY_TOP[0], PROXY_TOP[1]));
  const uGround = uniform(groundY - origin.y);
  const cube = cubeTexture(cubeTex);
  const lut = texture(lutTex);
  const color = Fn(() => {
    const dir = parallaxDir(lut, uOrigin, uTop, uGround, iterations);
    return cube.sample(dir).rgb.max(0.0).min(60000.0);
  })().toVar('domeColor');
  material.colorNode = color;
  // the baked lamps and lit windows bloom like the live ones (same threshold and gain)
  material.mrtNode = glowMrt(max(color.sub(1.0), vec3(0.0)).mul(0.5), 'none');
  const geometry = new THREE.SphereGeometry(DOME_RADIUS, 48, 24);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'world-dome';
  mesh.position.copy(origin);
  mesh.renderOrder = 1000;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return {
    mesh,
    material,
    cube,
    lut,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

export interface Beam {
  readonly mesh: THREE.Mesh;
  /** 0 hides the beam (vertices collapse: no fragments), 1 shows it. */
  readonly on: UniformNode<'float', number>;
  /** Overall brightness (the theme's lamp level). */
  readonly intensity: UniformNode<'float', number>;
  dispose(): void;
}

/** The lighthouse beam (see the file header); place `mesh` at the lantern. */
export function buildBeam(): Beam {
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  // additive: draw order does not matter, so skip three's two-pass (back, front) transparency
  material.forceSinglePass = true;
  const on = uniform(1);
  const intensity = uniform(1);
  const spin = vec3(0, time.mul(BEAM_SPEED), 0);
  material.positionNode = rotate(positionLocal, spin).mul(on);
  const col = Fn(() => {
    const d = positionWorld.sub(cameraPosition);
    const rd = d.div(max(length(d), 1e-3));
    const n = rotate(normalLocal, spin);
    const facing = saturate(abs(dot(n.div(max(length(n), 1e-5)), rd)));
    // cone uv.y runs 0 at the far end to 1 at the tip (the lamp)
    const along = pow(saturate(uv().y), 2.2);
    return vec3(1.0, 0.9, 0.7).mul(along.mul(pow(facing, 1.5)).mul(0.22).mul(intensity));
  })().toVar('beamColor');
  material.colorNode = col;
  material.mrtNode = glowMrt(col.mul(0.5));
  const geometry = new THREE.ConeGeometry(700, BEAM_LEN, 24, 1, true).translate(0, -BEAM_LEN / 2, 0).rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'world-beam';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1001;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  return {
    mesh,
    on,
    intensity,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

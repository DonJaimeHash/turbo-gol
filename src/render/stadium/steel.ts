/**
 * The steel: cage arches hugging the OUTSIDE of the netting along the arena's real cross-section
 * (vertical wall, the 600 uu wall-to-ceiling arc, the flat roof: the physics ceiling is flat, so
 * the roof is too), corner and end ribs, rings round the cage, the roof-edge ring over the netting's
 * seam with the roof, longitudinal roof beams, and the eight floodlight towers (tapered poles with
 * flanges, a service platform, brackets and the head frame behind each lamp panel). Swept tubes and
 * boxes merged into ONE mesh with ONE lit material: a single draw however many members there are.
 * Thin and dark (galvanised steel at night); a cheap rim term helps the tubes read against the sky.
 * Never casts shadows (only cars and the ball do).
 */
import * as THREE from 'three/webgpu';
import { abs, cameraPosition, dot, float, mix, normalWorld, normalize, positionWorld, pow, saturate, smoothstep, vec3 } from 'three/tsl';
import type { TierSpec } from '../quality';
import { arcInPlane, mergeParts, roundedOutline, sweepTube } from './geometry';
import {
  ARCH_OFF,
  ARCH_R,
  ARCH_Z,
  CORNER_RIB_DEG,
  END_RIB_X,
  FIELD,
  HEAD_H,
  HEAD_W,
  RING_R,
  RING_Y,
  ROOF_BEAM_R,
  ROOF_BEAM_X,
  ROOF_RING_R,
  towerHeads,
} from './layout';
import { stadiumLight, type StadiumUniforms } from './palette';

/**
 * Profile of a rib at outline point (bx, bz) with outward plan normal (nx, nz), its centre line
 * `off` outside the shell: up the wall, round the ceiling arc, ending on the roof edge.
 */
function ribPath(bx: number, bz: number, nx: number, nz: number, off: number, segs: number): THREE.Vector3[] {
  const pts = [new THREE.Vector3(bx + nx * off, 0, bz + nz * off)];
  const cx = bx - nx * FIELD.ceilR;
  const cz = bz - nz * FIELD.ceilR;
  for (const p of arcInPlane(cx, FIELD.wallTop, cz, nx, nz, FIELD.ceilR + off, 0, Math.PI / 2, segs)) pts.push(p);
  return pts;
}

export interface SteelBuild {
  readonly geometry: THREE.BufferGeometry;
  readonly triangles: number;
}

export function buildSteelGeometry(spec: TierSpec): SteelBuild {
  const high = spec.detail === 'high';
  const radial = high ? 8 : 6;
  const arcSegs = high ? 10 : 6;
  const parts: THREE.BufferGeometry[] = [];

  // ---- Transverse arches over the field (straight side walls, across the roof) ---------------
  for (const z of ARCH_Z) {
    const left = ribPath(-FIELD.halfX, z, -1, 0, ARCH_OFF, arcSegs);
    const right = ribPath(FIELD.halfX, z, 1, 0, ARCH_OFF, arcSegs).reverse();
    parts.push(sweepTube([...left, ...right], ARCH_R, radial, false, new THREE.Vector3(0, 0, 1)));
  }
  // ---- Corner ribs and end ribs (up the wall, round the arc, ending on the roof ring) ---------
  const ribR = ARCH_R * 0.8;
  const ribOff = ribR + 6;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (const deg of CORNER_RIB_DEG) {
        const a = (deg * Math.PI) / 180;
        const nx = sx * Math.cos(a);
        const nz = sz * Math.sin(a);
        const bx = sx * FIELD.cx + nx * FIELD.cornerR;
        const bz = sz * FIELD.cz + nz * FIELD.cornerR;
        parts.push(sweepTube(ribPath(bx, bz, nx, nz, ribOff, arcSegs), ribR, radial, false, new THREE.Vector3(-nz, 0, nx)));
      }
      for (const x of END_RIB_X) {
        parts.push(sweepTube(ribPath(sx * x, sz * FIELD.halfZ, 0, sz, ribOff, arcSegs), ribR, radial, false, new THREE.Vector3(1, 0, 0)));
      }
    }
  }
  // ---- Rings round the cage and round the roof edge -------------------------------------------
  const cornerSegs = high ? 14 : 8;
  for (const y of RING_Y) parts.push(sweepTube(roundedOutline(RING_R + 6, y, cornerSegs), RING_R, radial, true));
  parts.push(sweepTube(roundedOutline(-FIELD.ceilR, FIELD.ceiling + ROOF_RING_R + 6, cornerSegs), ROOF_RING_R, radial, true));
  // ---- Longitudinal roof beams (end on the roof ring) -------------------------------------------
  for (const x of ROOF_BEAM_X) {
    const ax = Math.abs(x);
    // The roof ring's z at this x (corner arc inset by ceilR, or the straight end).
    const r = FIELD.cornerR - FIELD.ceilR;
    const zEnd = ax <= FIELD.cx ? FIELD.halfZ - FIELD.ceilR : FIELD.cz + Math.sqrt(Math.max(0, r * r - (ax - FIELD.cx) ** 2));
    const y = FIELD.ceiling + ROOF_BEAM_R + 6;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) pts.push(new THREE.Vector3(x, y, -zEnd + (2 * zEnd * i) / 8));
    parts.push(sweepTube(pts, ROOF_BEAM_R, radial, false, new THREE.Vector3(1, 0, 0)));
  }

  // ---- Floodlight towers --------------------------------------------------------------------
  const m4 = new THREE.Matrix4();
  const basis = new THREE.Matrix4();
  const dir = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const head = new THREE.Vector3();
  for (const H of towerHeads()) {
    const [bx, , bz] = H.base;
    const sx = Math.sign(bx);
    const poleH = H.position[1] - 120;
    const pole = new THREE.CylinderGeometry(22, 42, poleH, radial, 1, true);
    pole.translate(bx, poleH / 2, bz);
    parts.push(pole);
    // A flange every 900 uu (pole sections) and a service platform under the head.
    for (let y = 900; y < poleH; y += 900) {
      const r = 46 - (y / poleH) * 18;
      const fl = new THREE.CylinderGeometry(r, r, 16, radial);
      fl.translate(bx, y, bz);
      parts.push(fl);
    }
    const plat = new THREE.BoxGeometry(240, 12, 240);
    plat.translate(bx - sx * 90, H.position[1] - 330, bz);
    parts.push(plat);
    // Head frame: a box behind the lamp panel, facing the aim point.
    dir.set(...H.dir);
    right.set(...H.right);
    up.set(...H.up);
    head.set(...H.position);
    basis.makeBasis(right, up, dir);
    m4.copy(basis).setPosition(head);
    const frame = new THREE.BoxGeometry(HEAD_W + 60, HEAD_H + 60, 56);
    frame.translate(0, 0, -34);
    frame.applyMatrix4(m4);
    parts.push(frame);
    // Visor over the top of the panel.
    const visor = new THREE.BoxGeometry(HEAD_W + 60, 10, 80);
    visor.translate(0, HEAD_H / 2 + 30, 18);
    visor.applyMatrix4(m4);
    parts.push(visor);
    // Brackets from the pole top to the back of the head.
    const back = head.clone().addScaledVector(dir, -66);
    parts.push(sweepTube([new THREE.Vector3(bx, H.position[1] - 140, bz), back], 15, radial, false, right.clone()));
    parts.push(sweepTube([new THREE.Vector3(bx, H.position[1] - 330, bz), back.clone().add(new THREE.Vector3(0, -150, 0))], 11, radial, false, right.clone()));
  }

  const geometry = mergeParts(parts);
  return { geometry, triangles: geometry.getAttribute('position').count / 3 };
}

/**
 * Painted steel on tiers with `bakedLight` (unlit): a mid grey x the theme's baked light, so the
 * frame reads as structure without the metal's environment reflections.
 */
const STEEL_BAKED = [0.075, 0.08, 0.09] as const;

/**
 * Dark galvanised steel, lit (keys, fill, environment), with a cheap view rim from the uniforms;
 * on tiers with `bakedLight` unlit painted steel x the theme's baked light, the same rim.
 */
export function buildSteelMaterial(spec: TierSpec, u: StadiumUniforms): THREE.MeshStandardNodeMaterial | THREE.MeshBasicNodeMaterial {
  const view = normalize(cameraPosition.sub(positionWorld));
  const rim = pow(saturate(float(1).sub(abs(dot(normalWorld, view)))), 3);
  const top = smoothstep(-0.2, 0.9, normalWorld.y);
  const rimCol = u.steelRim.mul(rim.mul(mix(float(0.4), float(1), top)));
  if (spec.bakedLight) {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = vec3(...STEEL_BAKED).mul(stadiumLight(u, normalWorld)).add(rimCol);
    return m;
  }
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x262a31, metalness: 0.7, roughness: 0.42 });
  m.emissiveNode = rimCol;
  return m;
}

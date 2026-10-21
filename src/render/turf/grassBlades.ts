/**
 * Real grass blades near the camera (tiers with `grassBlades`, ultra): one instanced draw of a
 * tapered, bent 3-triangle blade per world cell of BLADE_SPACING uu, in a square patch that follows
 * the camera. The patch origin snaps to the cell grid, so a blade's identity (its hash) belongs to
 * its world cell and nothing swims as the camera moves. Blades shrink to nothing toward the patch
 * edge (BLADE_RANGE from the camera) and widen with distance so they never get thinner than about a
 * pixel (no sparkle), their colour comes from the turf's own palette and field maps (grassAlbedo),
 * so they fade into the floor. A blade loses its width with its height: one with (almost) no height
 * would lie flat in the floor plane and z-fight with it as dots of blade colour, so it degenerates
 * to zero area and draws nothing.
 *
 * Readability: no blades on the boost pads (the pool map's pad mask) or in the puddles (drowned),
 * blades on the markings are painted and shorter, nothing off the flat floor (ramps, goals).
 *
 * Glow: `noGlowMrt()` (an untagged lit material would overwrite the glow target with its own
 * emissive, i.e. bloom the pools' light and erase the goal-mouth glow under the blades).
 *
 * Per frame (CPU): onBeforeRender writes the patch origin (one Vector2) and skips the draw
 * (instanceCount 0) while the camera is higher than BLADE_MAX_CAMERA_Y above the pitch, where every
 * blade has faded anyway. setWarmUp(true) forces the draw so the pipeline compiles at boot.
 */
import * as THREE from 'three/webgpu';
import type { UniformNode } from 'three/webgpu';
import {
  cameraPosition,
  cos,
  cross,
  faceDirection,
  float,
  floor,
  hash,
  instanceIndex,
  length,
  max,
  mix,
  normalize,
  oneMinus,
  positionLocal,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
} from 'three/tsl';
import { ARENA } from '../../sim/constants';
import { noGlowMrt, type Vec3Node } from '../materials';
import { FIELD_MAP, GRASS_HEIGHT, POOL_MAP, POOL_MAX, TURF_TILE } from './bake';
import { markingsCoverage, roundedRectSdf } from './markings';
import { PAINT, bandBend, floorMapUv, grassAlbedo, mowingStripes, teamTint, v3, viewN, type TurfTextures, type TurfUniforms } from './turfMaterial';

/** Patch radius around the camera (uu) and the blade grid spacing (uu). */
const BLADE_RANGE = 320;
const BLADE_SPACING = 2.3;
/** Above this camera height (uu) every blade has faded out: the draw is skipped. */
const BLADE_MAX_CAMERA_Y = BLADE_RANGE + 60;
/** Blade half width at the root (uu) and the distance from which it widens to stay ~1 px. */
const BLADE_HALF_WIDTH = 0.2;
const BLADE_WIDEN_FROM = 140;
/** Blade heights (uu) over which the width goes from 0 to full (a flat blade must not draw). */
const BLADE_SOLID_FROM = 0.25;
const BLADE_SOLID_AT = 0.9;
/** Blade roughness dry .. damp (broad: a sheen like the floor's, never glints). */
const BLADE_ROUGHNESS: readonly [number, number] = [0.9, 0.66];

const _cam = new THREE.Vector3();

export class GrassBlades {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly origin: UniformNode<'vec2', THREE.Vector2>;
  private readonly total: number;
  private warm = false;

  constructor(parent: THREE.Object3D, textures: TurfTextures, U: TurfUniforms) {
    const W = 2 * Math.ceil(BLADE_RANGE / BLADE_SPACING); // even: the cell grid stays integer
    this.total = W * W;
    this.origin = uniform(new THREE.Vector2(0, 0));

    // Blade template: x = across (-1..1), y = t (0 root .. 1 tip); a quad, a narrower quad, a tip.
    const geo = new THREE.InstancedBufferGeometry();
    const verts = [-1, 0, 0, 1, 0, 0, -0.72, 0.45, 0, 0.72, 0.45, 0, 0, 1, 0];
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
    geo.instanceCount = this.total;
    this.geometry = geo;

    // MeshStandard with a broad lobe (BLADE_ROUGHNESS): the blades must pick up the same damp sheen
    // as the floor round them. Lambert blades (no specular) read as a band of dark dots wherever
    // the floor shows a key light's sheen; the lobe is rough enough not to sparkle and costs no
    // measurable time over Lambert (both ~0.13 ms on ultra at the chase camera).
    const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
    m.name = 'turf-blades';
    m.metalnessNode = float(0);

    // -- the blade's world cell and its random values
    const ii = float(instanceIndex);
    const gz = floor(ii.div(W));
    const gx = ii.sub(gz.mul(W));
    const cell = this.origin.div(BLADE_SPACING).add(vec2(gx, gz)).sub(W / 2);
    // TSL's hash() converts its seed to uint: shift the cells positive first (else every negative
    // cell collapses to one value and rows show).
    const hc = hash(cell.x.add(60000).add(hash(cell.y.add(60000)).mul(1048576)));
    const h1 = hash(hc.mul(911.3).add(0.17));
    const h2 = hash(hc.mul(577.7).add(3.31));
    const h3 = hash(hc.mul(313.9).add(7.73));
    const root = cell.add(vec2(h1, h2)).mul(BLADE_SPACING);

    // -- what grows here (vertex stage: explicit mip levels, the same maps as the floor)
    const toCam = cameraPosition.sub(vec3(root.x, 0, root.y));
    const dCam = length(toCam.xz);
    const fade = oneMinus(smoothstep(BLADE_RANGE * 0.6, BLADE_RANGE * 0.95, dCam));
    const flat = roundedRectSdf(root, ARENA.extentX - ARENA.sideRampRadius - 20, ARENA.extentY - ARENA.backRampRadius - 20, ARENA.cornerRadius - ARENA.sideRampRadius);
    const f = texture(textures.field, floorMapUv(root, FIELD_MAP)).level(float(0));
    const pool = texture(textures.pools, floorMapUv(root, POOL_MAP)).level(float(0));
    const pads = pool.a;
    const tB = texture(textures.blades, root.div(TURF_TILE * 2.37)).level(float(3));
    const clumpS = texture(textures.blades, root.div(TURF_TILE * 11)).level(float(2)).a;
    const trample = smoothstep(0.15, 0.75, f.r);
    const bare = smoothstep(0.72, 0.97, f.r.add(clumpS.sub(0.5).mul(0.45)));
    const paint = markingsCoverage(root, float(0), float(2));
    const depth = U.puddleLevel.sub(f.b);
    const drowned = smoothstep(-0.05, 0.06, depth);
    const height = float(GRASS_HEIGHT)
      .mul(h3.mul(0.7).add(0.55))
      .mul(oneMinus(bare.mul(0.85)))
      .mul(oneMinus(trample.mul(0.3)))
      .mul(oneMinus(paint.mul(0.35)))
      .mul(oneMinus(pads))
      .mul(oneMinus(drowned.mul(0.85)))
      .mul(fade)
      .mul(step(flat, float(0)));

    // -- shape: yaw, a lean that follows the mowing band, widening with distance
    const bend = bandBend(root, null, null);
    const yaw = h1.mul(Math.PI * 2);
    const side = vec3(cos(yaw), 0, sin(yaw));
    const leanAmt = h2.mul(0.45).add(0.25);
    const lean = vec3(sin(yaw).negate().mul(0.55).add(bend.x.mul(0.2)), 0, cos(yaw).mul(0.55).add(bend.y.mul(0.65))).mul(leanAmt);
    const t = positionLocal.y;
    // Width goes to 0 with the height: a blade faded out (patch edge), masked (pads) or off the flat
    // floor would otherwise lie in the floor plane and z-fight with it (it draws after the floor
    // with the same depth), a ring of dark dots following the camera.
    const halfW = float(BLADE_HALF_WIDTH)
      .mul(h2.mul(0.5).add(0.75))
      .mul(max(float(1), dCam.div(BLADE_WIDEN_FROM)))
      .mul(smoothstep(BLADE_SOLID_FROM, BLADE_SOLID_AT, height));
    m.positionNode = vec3(root.x, 0, root.y)
      .add(side.mul(positionLocal.x.mul(halfW)))
      .add(vec3(0, t.mul(height), 0))
      .add(lean.mul(t.mul(t).mul(height)));

    // -- colour (vertex stage, interpolated): the turf palette by height along the blade, the
    //    stripes, the team tint, the damp darkening and the paint
    const camDir = toCam.xz.div(max(length(toCam), float(1)));
    const shade = t.mul(0.6).add(0.4);
    let col: Vec3Node = grassAlbedo(shade, mix(h3, tB.a, 0.5), clumpS.mul(0.6).add(tB.a.mul(0.4)), f.a, trample, bare, clumpS, float(0.6), U);
    col = col.mul(mowingStripes(bend, camDir, trample, U)).mul(teamTint(root, U));
    const dampLocal = U.wetness.mul(f.g.mul(1.1).add(0.25)).min(1);
    col = col.mul(mix(float(1), float(0.75), dampLocal));
    col = mix(col, v3(PAINT), paint.mul(t.mul(0.4).add(0.6)));
    m.colorNode = varying(col);
    m.roughnessNode = varying(mix(float(BLADE_ROUGHNESS[0]), float(BLADE_ROUGHNESS[1]), dampLocal));
    // The floodlight pools light the blades like the floor below (same baked irradiance).
    m.emissiveNode = varying(col.mul(pool.rgb.mul(pool.rgb).mul(POOL_MAX).mul(U.pools)));

    // Soft normal: part face normal, mostly up (blades are thin and translucent), flipped on the
    // back face so both sides light alike.
    const faceN = normalize(cross(side, vec3(0, 1, 0).add(lean.mul(t.mul(2)))));
    const faceV = varying(faceN);
    m.normalNode = viewN(normalize(mix(faceV.mul(faceDirection), vec3(0, 1, 0), 0.6)));
    // Never in the glow target: the emissive above is the pools' light, not a glow, and an
    // untagged material would also overwrite the goal-mouth glow the floor wrote under the blades.
    m.mrtNode = noGlowMrt();
    this.material = m;

    const mesh = new THREE.Mesh(geo, m);
    mesh.name = 'turf-blades';
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1; // after the floor: its depth rejects hidden blade pixels early
    mesh.onBeforeRender = (_renderer, _scene, camera) => this.place(camera);
    this.mesh = mesh;
    parent.add(mesh);
  }

  /** Patch under the camera, pushed forward so it covers what is seen; skip the draw from high up. */
  private place(camera: THREE.Camera): void {
    const e = camera.matrixWorld.elements;
    _cam.set(e[12], e[13], e[14]);
    // Camera forward = -z column of its world matrix; push the patch ahead on the ground.
    let fx = -e[8];
    let fz = -e[10];
    const fl = Math.hypot(fx, fz);
    if (fl > 1e-4) {
      fx /= fl;
      fz /= fl;
    } else fx = fz = 0;
    const cx = _cam.x + fx * BLADE_RANGE * 0.45;
    const cz = _cam.z + fz * BLADE_RANGE * 0.45;
    this.origin.value.set(Math.round(cx / BLADE_SPACING) * BLADE_SPACING, Math.round(cz / BLADE_SPACING) * BLADE_SPACING);
    this.geometry.instanceCount = this.warm || _cam.y < BLADE_MAX_CAMERA_Y ? this.total : 0;
  }

  /** Warm-up (TurfView.setWarmUp): draw the blades whatever the camera height. */
  setWarmUp(on: boolean): void {
    this.warm = on;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

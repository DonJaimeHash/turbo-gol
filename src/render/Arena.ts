/**
 * Visual arena: procedural floor (TSL turf + our markings + goal-mouth glow), the shell and ceiling
 * as near-transparent dark glass (fresnel / near-only hex, bright edge frames), goal chambers with
 * a see-through square net, a steel truss with spotlight lamps and haze cones above the glass roof,
 * the stadium backdrop (tiered crowd with camera flashes following the rounded field outline, roof
 * ring, floodlight masts with halos) and the boost pads (constants.ts) as two instanced meshes
 * (ring + floor glow + floating pill / orb).
 *
 * Field markings (all from constants.ts): a touchline 60 uu inside the ramp feet following the
 * rounded corners, the halfway line, a 1300 uu centre circle with a 280 uu inner ring, a ring on
 * every kickoff spot, and per goal a 2100 uu arc around the goal centre, a goal box 2600 x 900 and
 * the goal line across the mouth with short lines up to it along the posts.
 *
 * Draw calls: floor 1, shell 1, ceiling 1, goals 1, emissive bars 1, stands 1, masts 1, halos 1,
 * truss 1, cones 1, pads 2 = 12. Per frame: one uniform write (time) plus pad-state attribute
 * writes only while a pad changes (pickup flash / recharge).
 *
 * Bloom: see materials.ts. Every unlit material here that should glow tags its glow with
 * `glowMrt()`; the floor only tags the goal glow (not the white lines).
 */
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  Fn,
  abs,
  atan,
  attribute,
  cameraProjectionMatrix,
  cos,
  diffuseColor,
  float,
  floor,
  fract,
  hash,
  instanceIndex,
  instancedBufferAttribute,
  length,
  max,
  min,
  mix,
  modelViewMatrix,
  mx_noise_float,
  negate,
  normalView,
  normalWorld,
  oneMinus,
  positionGeometry,
  positionLocal,
  positionViewDirection,
  positionWorld,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ArenaMesh } from '../sim/arenaMesh';
import { ARENA, BOOST_PADS_BIG, BOOST_PADS_SMALL, BOOST_PAD_BIG_RADIUS, BOOST_PAD_SMALL_RADIUS, KICKOFF_SPAWNS } from '../sim/constants';
import { NUM_BOOST_PADS } from '../sim/types';
import { simToThree } from './coords';
import {
  BOOST_YELLOW,
  TEAM_BLUE,
  TEAM_RED,
  boxSdf,
  cameraDistance,
  cellHash,
  fresnel,
  glowMrt,
  hdrColor,
  hexEdgeMask,
  lineMask,
  linearVec3,
  type FloatNode,
  type FloatUniform,
  type Vec2Node,
  type Vec3Node,
} from './materials';

export type Quality = 0 | 1;

/**
 * Tolerant view of the sim's triangle-mesh records (sim coords, uu). The sim owner may name the
 * arrays `vertices`/`triangles` (as rs_api.h does) or `positions`/`indices`; both are accepted.
 */
interface MeshDataLike {
  readonly vertices?: ArrayLike<number>;
  readonly positions?: ArrayLike<number>;
  readonly triangles?: ArrayLike<number>;
  readonly indices?: ArrayLike<number>;
}
interface ArenaMeshLike {
  readonly shell?: MeshDataLike;
  readonly walls?: MeshDataLike;
  readonly goals?: MeshDataLike;
  readonly goal?: MeshDataLike;
  readonly floor?: MeshDataLike;
  readonly ceiling?: MeshDataLike;
  readonly uvs?: { readonly goals?: ArrayLike<number> };
}

const BIG_COUNT = BOOST_PADS_BIG.length;
const SMALL_COUNT = BOOST_PADS_SMALL.length;
/** RocketSim pad cooldowns (s), used to animate the recharge creep. */
const BIG_COOLDOWN = 10;
const SMALL_COOLDOWN = 4;
/** Height of the big pad's floating orb / the small pad's pill above the floor. */
const ORB_Y = 100;
const PILL_Y = 46;
/** Pickup flash: the pad state jumps to PEAK and decays to the cooldown value over this long. */
const PAD_FLASH_SECONDS = 0.15;
const PAD_FLASH_PEAK = 1.4;
/** Stands: tiers of unit boxes ring the rounded field outline; the end walls start beyond the goal backs. */
const STAND_TIERS = 14;
const ROOF_TIERS = 2;
const TIER_HEIGHT = 170;
const TIER_DEPTH = 260;
const STAND_OFFSET_SIDE = 900;
const STAND_OFFSET_END = ARENA.goalDepth + 240;
/** Chords per rounded stand corner. */
const STAND_CORNER_SEGS = 5;
const STAND_BASE_Y = 260;
const ROOF_Y = STAND_BASE_Y + STAND_TIERS * TIER_HEIGHT;
const MAST_X = ARENA.extentX + 2600;
const MAST_Z = ARENA.extentY + 2200;
const MAST_HEIGHT = 3400;
const HALO_SIZE = 1400;
/** Truss above the glass ceiling (outside the playable volume): 3 girders, 11 cross beams. */
const TRUSS_Y = ARENA.height + 140;
const TRUSS_GIRDERS: readonly number[] = [-0.6 * ARENA.extentX, 0, 0.6 * ARENA.extentX];
const TRUSS_BEAMS = 11;
const TRUSS_BEAM_STEP = (ARENA.extentY * 2) / (TRUSS_BEAMS - 1);
/** Lamp rows halfway between the cross beams, 4 per half (8 of the 10 gaps, the end gaps stay dark). */
const LAMP_ROWS: readonly number[] = [-3.5, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5].map((k) => k * TRUSS_BEAM_STEP);
const LAMP_Y = TRUSS_Y - 50;
const CONE_HEIGHT = 900;
const CONE_RADIUS = 380;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _e = new THREE.Euler();

interface Disposable {
  dispose(): void;
}

export class ArenaView {
  readonly group = new THREE.Group();
  readonly floor: THREE.Mesh;
  readonly shell: THREE.Mesh;
  readonly goals: THREE.Mesh | null;
  readonly padMeshes: { readonly big: THREE.InstancedMesh; readonly small: THREE.InstancedMesh };

  private readonly scene: THREE.Scene;
  private readonly timeU = uniform(0);
  private readonly bigState = new Float32Array(BIG_COUNT);
  private readonly smallState = new Float32Array(SMALL_COUNT);
  private readonly bigPending = new Float32Array(BIG_COUNT);
  private readonly smallPending = new Float32Array(SMALL_COUNT);
  private readonly bigFlash = new Float32Array(BIG_COUNT);
  private readonly smallFlash = new Float32Array(SMALL_COUNT);
  private readonly bigStateAttr: THREE.InstancedBufferAttribute;
  private readonly smallStateAttr: THREE.InstancedBufferAttribute;
  private readonly disposables: Disposable[] = [];

  constructor(scene: THREE.Scene, mesh: ArenaMesh, quality: Quality) {
    this.scene = scene;
    const m = mesh as unknown as ArenaMeshLike;
    const high = quality === 0;

    // ---- Floor (the sim's exact floor fan when available, else a plane) ------------------------
    let floorGeo: THREE.BufferGeometry;
    if (m.floor !== undefined) floorGeo = toGeometry(m.floor, 'floor', 0, ARENA.height * 0.5, 0);
    else {
      floorGeo = new THREE.PlaneGeometry(ARENA.extentX * 2, (ARENA.extentY + ARENA.goalDepth) * 2, 1, 1);
      floorGeo.rotateX(-Math.PI / 2);
    }
    this.floor = new THREE.Mesh(floorGeo, buildFloorMaterial(this.timeU));
    this.floor.receiveShadow = true;
    this.floor.castShadow = false;
    this.floor.matrixAutoUpdate = false;
    this.track(floorGeo, this.floor.material as THREE.Material);
    this.group.add(this.floor);

    // ---- Shell + ceiling: dark glass (transparent, drawn first among transparents) --------------
    const shellData = m.shell ?? m.walls;
    const shellGeo = toGeometry(shellData, 'shell', 0, ARENA.height * 0.5, 0);
    this.shell = new THREE.Mesh(shellGeo, buildGlassMaterial(high, false));
    this.shell.castShadow = false;
    this.shell.receiveShadow = false;
    this.shell.matrixAutoUpdate = false;
    this.shell.frustumCulled = false;
    this.shell.renderOrder = -5;
    this.track(shellGeo, this.shell.material as THREE.Material);
    this.group.add(this.shell);

    let ceilGeo: THREE.BufferGeometry;
    if (m.ceiling !== undefined) ceilGeo = toGeometry(m.ceiling, 'ceiling', 0, ARENA.height * 0.5, 0);
    else {
      ceilGeo = new THREE.PlaneGeometry(ARENA.extentX * 2, ARENA.extentY * 2, 1, 1);
      ceilGeo.rotateX(Math.PI / 2); // normal -y: visible from inside only
      ceilGeo.translate(0, ARENA.height - 4, 0);
    }
    const ceiling = new THREE.Mesh(ceilGeo, buildGlassMaterial(high, true));
    ceiling.castShadow = false;
    ceiling.receiveShadow = false;
    ceiling.matrixAutoUpdate = false;
    ceiling.frustumCulled = false;
    ceiling.renderOrder = -5;
    this.track(ceilGeo, ceiling.material as THREE.Material);
    this.group.add(ceiling);

    // ---- Goals: see-through square net (uses the sim's planar UVs when provided) ---------------
    const goalData = m.goals ?? m.goal;
    if (goalData !== undefined) {
      const goalUv = m.uvs?.goals;
      const goalGeo = toGeometry(goalData, 'goals', 0, ARENA.goalHeight * 0.5, ARENA.extentY + ARENA.goalDepth * 0.5, goalUv);
      const goals = new THREE.Mesh(goalGeo, buildGoalMaterial(goalUv !== undefined));
      goals.castShadow = false;
      goals.receiveShadow = false;
      goals.matrixAutoUpdate = false;
      goals.frustumCulled = false;
      goals.renderOrder = -4;
      this.track(goalGeo, goals.material as THREE.Material);
      this.group.add(goals);
      this.goals = goals;
    } else this.goals = null;

    // ---- Emissive bars: goal frames, truss lamp heads, floodlight heads (1 draw call) ----------
    this.group.add(this.buildEmissiveBars());

    // ---- Roof: truss lattice + spotlight haze cones (2 draw calls) -----------------------------
    this.group.add(this.buildTruss());
    this.group.add(this.buildCones());

    // ---- Stadium backdrop: crowd tiers + roof ring, masts, floodlight halos (3 draw calls) -----
    this.group.add(this.buildStands());
    this.group.add(this.buildMasts());
    this.group.add(this.buildHalos());

    // ---- Boost pads (2 draw calls) ----------------------------------------------------------
    this.bigStateAttr = new THREE.InstancedBufferAttribute(this.bigState, 1);
    this.bigStateAttr.setUsage(THREE.DynamicDrawUsage);
    this.smallStateAttr = new THREE.InstancedBufferAttribute(this.smallState, 1);
    this.smallStateAttr.setUsage(THREE.DynamicDrawUsage);
    this.bigState.fill(1);
    this.smallState.fill(1);
    const big = this.buildPads(BOOST_PADS_BIG, buildBigPadGeometry(high), this.bigStateAttr);
    const small = this.buildPads(BOOST_PADS_SMALL, buildSmallPadGeometry(), this.smallStateAttr);
    this.padMeshes = { big, small };
    this.group.add(big, small);

    this.group.matrixAutoUpdate = false;
    scene.add(this.group);
  }

  /**
   * Pad `index` in state-buffer order (the big pads first, then the small ones). `cooldown` is the seconds left
   * before the pad re-activates (ignored while active). An active -> inactive edge starts the
   * pickup flash, which update() decays into the recharge value.
   */
  setPadState(index: number, active: boolean, cooldown: number): void {
    if (index < 0 || index >= NUM_BOOST_PADS) return;
    const isBig = index < BIG_COUNT;
    const i = isBig ? index : index - BIG_COUNT;
    const arr = isBig ? this.bigState : this.smallState;
    const flash = isBig ? this.bigFlash : this.smallFlash;
    const pending = isBig ? this.bigPending : this.smallPending;
    let v = 1;
    if (!active) {
      v = 1 - cooldown / (isBig ? BIG_COOLDOWN : SMALL_COOLDOWN);
      v = v < 0 ? 0 : v > 0.98 ? 0.98 : v;
      if (arr[i] === 1 && flash[i] <= 0) flash[i] = PAD_FLASH_SECONDS;
    }
    if (flash[i] > 0) {
      pending[i] = v; // update() drives the attribute while the flash plays
      return;
    }
    if (arr[i] !== v) {
      arr[i] = v;
      (isBig ? this.bigStateAttr : this.smallStateAttr).needsUpdate = true;
    }
  }

  update(dt: number, time: number): void {
    this.timeU.value = time;
    this.decayFlash(this.bigFlash, this.bigPending, this.bigState, this.bigStateAttr, dt);
    this.decayFlash(this.smallFlash, this.smallPending, this.smallState, this.smallStateAttr, dt);
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private decayFlash(flash: Float32Array, pending: Float32Array, state: Float32Array, attr: THREE.InstancedBufferAttribute, dt: number): void {
    let changed = false;
    for (let i = 0; i < flash.length; i++) {
      if (flash[i] <= 0) continue;
      flash[i] -= dt;
      if (flash[i] <= 0) {
        flash[i] = 0;
        state[i] = pending[i];
      } else {
        const k = flash[i] / PAD_FLASH_SECONDS;
        state[i] = pending[i] + (PAD_FLASH_PEAK - pending[i]) * k;
      }
      changed = true;
    }
    if (changed) attr.needsUpdate = true;
  }

  private track(...items: Disposable[]): void {
    for (const d of items) this.disposables.push(d);
  }

  private buildPads(
    positions: ReadonlyArray<readonly [number, number, number]>,
    geometry: THREE.BufferGeometry,
    stateAttr: THREE.InstancedBufferAttribute,
  ): THREE.InstancedMesh {
    const material = buildPadMaterial(stateAttr, this.timeU);
    const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      simToThree(_p, p[0], p[1], 0);
      _m.makeTranslation(_p.x, 0, _p.z);
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.track(geometry, material);
    return mesh;
  }

  /** Goal frames (team HDR), 24 lamp heads under the truss (hot white) and 4 floodlight heads. */
  private buildEmissiveBars(): THREE.InstancedMesh {
    const t = 24; // bar thickness (uu)
    const gw = ARENA.goalHalfWidth;
    const gh = ARENA.goalHeight;
    const count = 6 + TRUSS_GIRDERS.length * LAMP_ROWS.length + 4;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicNodeMaterial();
    material.mrtNode = glowMrt(diffuseColor.rgb, 'none');
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    let i = 0;
    const put = (x: number, y: number, z: number, sx: number, sy: number, sz: number, hex: number, intensity: number, yaw = 0): void => {
      _e.set(0, yaw, 0);
      _q.setFromEuler(_e);
      _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
      mesh.setMatrixAt(i, _m);
      mesh.setColorAt(i, hdrColor(hex, intensity, _c));
      i++;
    };
    // Goal frames: two posts + crossbar per goal, set into the back wall at the edge of the mouth.
    for (const side of [-1, 1] as const) {
      const hex = side < 0 ? TEAM_BLUE : TEAM_RED;
      const z = side * ARENA.extentY;
      put(-(gw + t / 2), (gh + t) / 2, z, t, gh + t, t, hex, 2.2);
      put(gw + t / 2, (gh + t) / 2, z, t, gh + t, t, hex, 2.2);
      put(0, gh + t / 2, z, gw * 2 + t * 2, t, t, hex, 2.2);
    }
    // Spotlight lamp heads at the girder / beam crossings, just under the truss.
    for (const x of TRUSS_GIRDERS) for (const z of LAMP_ROWS) put(x, LAMP_Y, z, 180, 40, 180, 0xfff4e0, 3.5);
    // Floodlight heads on the four masts, angled at the centre spot.
    for (const sx of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        const x = sx * MAST_X;
        const z = sz * MAST_Z;
        put(x, MAST_HEIGHT - 120, z, 760, 320, 40, 0xfff6e6, 3.2, Math.atan2(-x, -z));
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.track(geometry, material);
    return mesh;
  }

  /** Steel lattice above the glass ceiling: 3 girders, 11 cross beams, a zig-zag web between them. */
  private buildTruss(): THREE.InstancedMesh {
    const beams = TRUSS_BEAMS;
    const gaps = TRUSS_GIRDERS.length - 1;
    const count = TRUSS_GIRDERS.length + beams + (beams - 1) * gaps;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardNodeMaterial({ color: 0x2b313c, roughness: 0.55, metalness: 0.6 });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    let i = 0;
    for (const x of TRUSS_GIRDERS) {
      _m.compose(_p.set(x, TRUSS_Y, 0), _q.identity(), _s.set(60, 60, ARENA.extentY * 2 + 1600));
      mesh.setMatrixAt(i++, _m);
    }
    for (let b = 0; b < beams; b++) {
      const z = -ARENA.extentY + b * TRUSS_BEAM_STEP;
      _m.compose(_p.set(0, TRUSS_Y, z), _q.identity(), _s.set(ARENA.extentX * 2 + 1200, 60, 60));
      mesh.setMatrixAt(i++, _m);
    }
    for (let b = 0; b < beams - 1; b++) {
      for (let g = 0; g < gaps; g++) {
        let z0 = -ARENA.extentY + b * TRUSS_BEAM_STEP;
        let z1 = z0 + TRUSS_BEAM_STEP;
        if ((b + g) % 2 === 1) [z0, z1] = [z1, z0];
        const x0 = TRUSS_GIRDERS[g];
        const x1 = TRUSS_GIRDERS[g + 1];
        const len = Math.hypot(x1 - x0, z1 - z0);
        _e.set(0, Math.atan2(-(z1 - z0), x1 - x0), 0);
        _q.setFromEuler(_e);
        _m.compose(_p.set((x0 + x1) / 2, TRUSS_Y - 40, (z0 + z1) / 2), _q, _s.set(len, 40, 40));
        mesh.setMatrixAt(i++, _m);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.track(geometry, material);
    return mesh;
  }

  /** Fake volumetric spotlight cones hanging from the lamp heads (additive haze, tip at the lamp). */
  private buildCones(): THREE.InstancedMesh {
    const count = TRUSS_GIRDERS.length * LAMP_ROWS.length;
    const geometry = new THREE.ConeGeometry(1, 1, 12, 1, true);
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    // ConeGeometry's uv.y is 1 at the tip: bright at the lamp, fading to the base; the silhouette
    // fades out so the cone reads as haze, not a shape. The bloom tag deliberately uses only the
    // tip fade (no pow(), no view-dependent term): three clamps the colour target but writes the
    // MRT glow member raw, so a NaN there blooms into a black rectangle (see materials.ts).
    const fade = uv().y.mul(uv().y);
    const facing = abs(normalView.dot(positionViewDirection));
    const warm = vec3(1.0, 0.95, 0.85);
    const col = warm.mul(0.1).mul(fade).mul(facing).toVar();
    material.colorNode = col;
    material.mrtNode = glowMrt(warm.mul(0.05).mul(fade));
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    let i = 0;
    for (const x of TRUSS_GIRDERS) {
      for (const z of LAMP_ROWS) {
        _m.compose(_p.set(x, LAMP_Y - 20 - CONE_HEIGHT / 2, z), _q.identity(), _s.set(CONE_RADIUS, CONE_HEIGHT, CONE_RADIUS));
        mesh.setMatrixAt(i++, _m);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.track(geometry, material);
    return mesh;
  }

  /**
   * Seat tiers: stepped rings around the arena following its rounded outline, offset outward so
   * they sit behind the glass (the end walls start beyond the goal backs). 14 crowd tiers plus a
   * dark 2-tier roof ring; each ring is 2 sides, 2 ends and 4 corner arcs of STAND_CORNER_SEGS
   * chords, one draw call. Every instance is a unit box whose local +z points away from the arena,
   * which the crowd shader relies on.
   */
  private buildStands(): THREE.InstancedMesh {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = buildSeatMaterial();
    const rings = STAND_TIERS + 1;
    const perRing = 4 + 4 * STAND_CORNER_SEGS;
    const mesh = new THREE.InstancedMesh(geometry, material, rings * perRing);
    let i = 0;
    const seg = (x0: number, z0: number, x1: number, z1: number, y: number, h: number, nx: number, nz: number, stretch = 1): void => {
      _e.set(0, Math.atan2(nx, nz), 0);
      _q.setFromEuler(_e);
      _m.compose(_p.set((x0 + x1) / 2, y, (z0 + z1) / 2), _q, _s.set(Math.hypot(x1 - x0, z1 - z0) * stretch, h, TIER_DEPTH));
      mesh.setMatrixAt(i, _m);
      i++;
    };
    for (let t = 0; t < rings; t++) {
      const roof = t === STAND_TIERS;
      const offSide = STAND_OFFSET_SIDE + t * TIER_DEPTH;
      const offEnd = STAND_OFFSET_END + t * TIER_DEPTH;
      const h = roof ? TIER_HEIGHT * ROOF_TIERS : TIER_HEIGHT;
      const y = STAND_BASE_Y + t * TIER_HEIGHT + h / 2;
      // The ring is the field outline grown by offSide (same corner centres, radius + offSide),
      // with the straight ends pushed out further to offEnd.
      const sideX = ARENA.extentX + offSide;
      const endZ = ARENA.extentY + offEnd;
      const cx = ARENA.cornerCentreX;
      const cz = endZ - (ARENA.cornerRadius + offSide);
      const rr = ARENA.cornerRadius + offSide;
      seg(sideX, -cz, sideX, cz, y, h, 1, 0);
      seg(-sideX, -cz, -sideX, cz, y, h, -1, 0);
      seg(-cx, endZ, cx, endZ, y, h, 0, 1);
      seg(-cx, -endZ, cx, -endZ, y, h, 0, -1);
      // Corner chords, stretched so the outer faces of neighbouring boxes meet.
      const stretch = (rr + TIER_DEPTH / 2) / (rr * Math.cos(Math.PI / 4 / STAND_CORNER_SEGS));
      for (const sx of [-1, 1] as const) {
        for (const sz of [-1, 1] as const) {
          for (let k = 0; k < STAND_CORNER_SEGS; k++) {
            const a0 = ((Math.PI / 2) * k) / STAND_CORNER_SEGS;
            const a1 = ((Math.PI / 2) * (k + 1)) / STAND_CORNER_SEGS;
            const am = (a0 + a1) / 2;
            seg(
              sx * (cx + rr * Math.cos(a0)),
              sz * (cz + rr * Math.sin(a0)),
              sx * (cx + rr * Math.cos(a1)),
              sz * (cz + rr * Math.sin(a1)),
              y,
              h,
              sx * Math.cos(am),
              sz * Math.sin(am),
              stretch,
            );
          }
        }
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.track(geometry, material);
    return mesh;
  }

  /** Four floodlight masts with a crossarm each (the lamp heads live in the emissive mesh). */
  private buildMasts(): THREE.InstancedMesh {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardNodeMaterial({ color: 0x1b1f28, roughness: 0.7, metalness: 0.4 });
    const mesh = new THREE.InstancedMesh(geometry, material, 8);
    let i = 0;
    for (const sx of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        const x = sx * MAST_X;
        const z = sz * MAST_Z;
        _m.compose(_p.set(x, MAST_HEIGHT / 2, z), _q.identity(), _s.set(90, MAST_HEIGHT, 90));
        mesh.setMatrixAt(i++, _m);
        _e.set(0, Math.atan2(-x, -z), 0);
        _q.setFromEuler(_e);
        _m.compose(_p.set(x, MAST_HEIGHT - 320, z), _q, _s.set(900, 50, 50));
        mesh.setMatrixAt(i++, _m);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.track(geometry, material);
    return mesh;
  }

  /**
   * Floodlight halos: one mesh of four camera-facing quads (billboarded in the vertex shader from a
   * per-vertex corner attribute, so a single draw call and no per-frame CPU work).
   */
  private buildHalos(): THREE.Mesh {
    const n = 4;
    const pos = new Float32Array(n * 4 * 3);
    const corner = new Float32Array(n * 4 * 2);
    const uvs = new Float32Array(n * 4 * 2);
    const index = new Uint16Array(n * 6);
    let v = 0;
    let k = 0;
    const corners: ReadonlyArray<readonly [number, number]> = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ];
    for (const sx of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        const base = v;
        for (const [cx, cy] of corners) {
          pos[v * 3] = sx * MAST_X;
          pos[v * 3 + 1] = MAST_HEIGHT - 120;
          pos[v * 3 + 2] = sz * MAST_Z;
          corner[v * 2] = cx;
          corner[v * 2 + 1] = cy;
          uvs[v * 2] = cx + 0.5;
          uvs[v * 2 + 1] = cy + 0.5;
          v++;
        }
        index[k++] = base;
        index[k++] = base + 1;
        index[k++] = base + 2;
        index[k++] = base;
        index[k++] = base + 2;
        index[k++] = base + 3;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));

    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const cornerN = attribute('aCorner', 'vec2');
    const centreView = modelViewMatrix.mul(vec4(positionLocal, 1.0));
    material.vertexNode = cameraProjectionMatrix.mul(centreView.add(vec4(cornerN.mul(HALO_SIZE), 0.0, 0.0)));
    const falloff = oneMinus(smoothstep(0.15, 0.5, length(uv().sub(0.5))));
    const col = vec3(1.0, 0.92, 0.78).mul(falloff).mul(1.2);
    material.colorNode = col;
    material.mrtNode = glowMrt(col.mul(0.8));

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.track(geometry, material);
    return mesh;
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/**
 * Sim mesh (sim coords) → three.js BufferGeometry (y up) with vertex normals. The axis swap is a
 * reflection, so the winding flips; triangles are re-wound so their faces point INTO the arena
 * (checked against the reference interior point, which makes this robust to either convention).
 * `uvs` (2 floats per vertex, uu) are copied into a 'uv' attribute when given.
 */
function toGeometry(md: MeshDataLike | undefined, name: string, ix: number, iy: number, iz: number, uvs?: ArrayLike<number>): THREE.BufferGeometry {
  const src = md?.vertices ?? md?.positions;
  const tri = md?.triangles ?? md?.indices;
  if (src === undefined || tri === undefined) throw new Error(`ArenaMesh.${name}: expected vertices/triangles (or positions/indices)`);
  const n = Math.floor(src.length / 3);
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = src[i * 3];
    positions[i * 3 + 1] = src[i * 3 + 2];
    positions[i * 3 + 2] = src[i * 3 + 1];
  }
  const index = new Uint32Array(tri.length);
  for (let i = 0; i < tri.length; i++) index[i] = tri[i];

  // Majority vote on orientation against the interior point (per goal chamber, mirrored in z).
  let inward = 0;
  let outward = 0;
  for (let i = 0; i + 2 < index.length; i += 3) {
    const a = index[i] * 3;
    const b = index[i + 1] * 3;
    const c = index[i + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const cx = (positions[a] + positions[b] + positions[c]) / 3;
    const cy = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
    const cz = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
    const rz = iz === 0 ? 0 : Math.sign(cz) * iz;
    const d = nx * (ix - cx) + ny * (iy - cy) + nz * (rz - cz);
    if (d > 0) inward++;
    else if (d < 0) outward++;
  }
  if (outward > inward) {
    for (let i = 0; i + 2 < index.length; i += 3) {
      const t = index[i + 1];
      index[i + 1] = index[i + 2];
      index[i + 2] = t;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (uvs !== undefined && uvs.length >= n * 2) {
    const uvArr = new Float32Array(n * 2);
    for (let i = 0; i < n * 2; i++) uvArr[i] = uvs[i];
    geo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  }
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Pad part kinds, stored per vertex in the 'aKind' attribute. */
const PAD_RING = 0;
const PAD_DISC = 1;
const PAD_ORB = 2;

function tagKind(geo: THREE.BufferGeometry, kind: number): THREE.BufferGeometry {
  const g = geo.index !== null ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const count = g.getAttribute('position').count;
  g.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(count).fill(kind), 1));
  return g;
}

/** Floor glow disc shared by both pad kinds (additive, fades to the rim). */
function padDisc(radius: number): THREE.BufferGeometry {
  const disc = new THREE.CircleGeometry(radius * 1.25, 24);
  disc.rotateX(-Math.PI / 2);
  disc.translate(0, 1.5, 0);
  return tagKind(disc, PAD_DISC);
}

/** Big pad: a lit ring, a floor glow disc and a floating orb (bright core, soft rim). */
function buildBigPadGeometry(high: boolean): THREE.BufferGeometry {
  const ring = new THREE.RingGeometry(BOOST_PAD_BIG_RADIUS - 64, BOOST_PAD_BIG_RADIUS, 24);
  ring.rotateX(-Math.PI / 2);
  ring.translate(0, 2.5, 0);
  const orb = new THREE.IcosahedronGeometry(48, high ? 2 : 1);
  orb.translate(0, ORB_Y, 0);
  const parts = [tagKind(ring, PAD_RING), padDisc(BOOST_PAD_BIG_RADIUS), tagKind(orb, PAD_ORB)];
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

/** Small pad: a lit ring, a floor glow disc and a small pill of light floating above it. */
function buildSmallPadGeometry(): THREE.BufferGeometry {
  const ring = new THREE.RingGeometry(BOOST_PAD_SMALL_RADIUS - 60, BOOST_PAD_SMALL_RADIUS - 24, 24);
  ring.rotateX(-Math.PI / 2);
  ring.translate(0, 2.5, 0);
  const pill = new THREE.CapsuleGeometry(9, 26, 4, 10);
  pill.rotateZ(Math.PI / 2); // lying flat
  pill.translate(0, PILL_Y, 0);
  const parts = [tagKind(ring, PAD_RING), padDisc(BOOST_PAD_SMALL_RADIUS), tagKind(pill, PAD_ORB)];
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

// ---------------------------------------------------------------------------------------------
// Materials (TSL node graphs, built once)
// ---------------------------------------------------------------------------------------------

/** Signed distance to the outline of a rounded rectangle centred on the origin (half extents hx, hy, corner radius r). */
function roundedRectSdf(p: Vec2Node, hx: number, hy: number, r: number): FloatNode {
  const q = abs(p).sub(vec2(hx - r, hy - r));
  return length(max(q, vec2(0, 0))).add(min(max(q.x, q.y), float(0))).sub(r);
}

/**
 * Turf: blade noise (faded with distance to avoid shimmer), mowing bands across the length of the
 * field (14 bands, 800 uu each) with a faint lengthwise split, crisp 12 uu markings (see the file
 * header), faint team halves, team-coloured goal floors and a pulsing goal-mouth glow. Shadows are
 * tinted cool green-grey instead of black (floodlit from many lamps).
 */
function buildFloorMaterial(timeU: FloatUniform): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0 });
  const p = positionWorld.xz; // (x, sim y)
  const ax = abs(p.x);
  const az = abs(p.y);

  const nearK = oneMinus(smoothstep(float(1500), float(3200), cameraDistance()));
  const n1 = mx_noise_float(p.mul(1 / 22)).mul(0.5).add(0.5);
  const n2 = cellHash(p, 5);
  const band = (ARENA.extentY * 2) / 14;
  const stripeY = step(0.5, fract(p.y.div(band * 2)));
  const stripeX = step(float(0), p.x);
  const mow = mix(float(0.93), float(1.07), stripeY).mul(mix(float(0.985), float(1.015), stripeX));
  const turf = vec3(0.075, 0.27, 0.11);
  let base = turf.mul(float(0.88).add(n1.mul(0.16)).add(n2.mul(0.1).mul(nearK))).mul(mow);

  const toBlue = smoothstep(float(0.22 * ARENA.extentY), float(0.9 * ARENA.extentY), negate(p.y));
  const toRed = smoothstep(float(0.22 * ARENA.extentY), float(0.9 * ARENA.extentY), p.y);
  const tint = linearVec3(TEAM_BLUE).mul(toBlue).add(linearVec3(TEAM_RED).mul(toRed));
  base = base.add(tint.mul(0.07));

  const glowCol = mix(linearVec3(TEAM_BLUE), linearVec3(TEAM_RED), step(float(0), p.y));
  const inGoal = step(float(ARENA.extentY), az);
  base = mix(base, glowCol.mul(0.12), inGoal);

  // Markings. The flat floor ends where the ramps start; the touchline runs LINE_INSET inside the
  // ramp feet (a rounded rectangle whose corner arcs follow the rounded walls); the goal line sits
  // on the mouth plane, joined to the touchline by short lines along the posts.
  const hw = 12;
  const LINE_INSET = 60;
  const bx = ARENA.extentX - ARENA.sideRampRadius - LINE_INSET;
  const bz = ARENA.extentY - ARENA.backRampRadius - LINE_INSET;
  const rr = ARENA.cornerRadius - ARENA.sideRampRadius - LINE_INSET;
  const gw = ARENA.goalHalfWidth;
  const inMouthX = step(ax, float(gw)); // 1 where |x| <= goal half width
  const nearBack = step(float(bz - 40), az);
  const notMouth = oneMinus(inMouthX.mul(nearBack));
  const inField = step(az, float(bz));
  const inMouthStrip = step(float(bz), az).mul(step(az, float(ARENA.extentY)));

  let lines = lineMask(roundedRectSdf(p, bx, bz, rr), hw).mul(notMouth);
  lines = max(lines, lineMask(az.sub(ARENA.extentY), hw).mul(inMouthX));
  lines = max(lines, lineMask(ax.sub(gw), hw).mul(inMouthStrip));
  lines = max(lines, lineMask(p.y, hw).mul(step(ax, float(bx))));
  // Centre: a wide circle and a small inner ring around the kickoff spot.
  lines = max(lines, lineMask(length(p).sub(1300), hw));
  lines = max(lines, lineMask(length(p).sub(280), hw * 0.75));
  // A small ring on every kickoff spot (both teams).
  for (const [kx, ky] of KICKOFF_SPAWNS) {
    for (const s of [-1, 1] as const) lines = max(lines, lineMask(length(p.sub(vec2(s * kx, s * ky))).sub(70), 7));
  }
  // Goal areas: an arc around the goal centre and a goal box in front of the mouth.
  for (const s of [-1, 1] as const) {
    const goalCentre = vec2(0, s * ARENA.extentY);
    lines = max(lines, lineMask(length(p.sub(goalCentre)).sub(2100), hw).mul(inField));
    lines = max(lines, lineMask(boxSdf(p, 0, s * (bz - 450), gw + 300, 450), hw).mul(inField));
  }

  // Goal-mouth glow: fades in over the last metres before the line, pulses gently.
  const inMouth = step(ax, float(gw + 40)).mul(smoothstep(float(bz - 700), float(bz + 100), az));
  const pulse = float(0.16).add(sin(timeU.mul(1.5)).mul(0.04));
  const goalGlow = glowCol.mul(inMouth).mul(pulse);

  const lineCol = vec3(0.92, 0.95, 1.0);
  m.colorNode = mix(base, lineCol, lines.mul(0.9));
  // A touch of self-illumination keeps the lines readable at distance; only the goal glow blooms.
  m.emissiveNode = lineCol.mul(lines.mul(0.14)).add(goalGlow);
  m.mrtNode = glowMrt(goalGlow.mul(0.6), 'none');
  m.roughnessNode = float(0.82).sub(lines.mul(0.3));
  const shadowTint = vec3(0.52, 0.66, 0.6);
  const tintShadow = Fn(([shadow]: [Node]) => mix(shadowTint, vec3(1.0, 1.0, 1.0), shadow as Vec3Node));
  m.receivedShadowNode = tintShadow as unknown as () => Node;
  return m;
}

/**
 * Dark glass for the shell (walls) and the ceiling: almost transparent, the stadium shows through;
 * fresnel brightens grazing views; a faint hex panel mesh only reads near the camera / at grazing
 * angles (walls only; skipped at quality 1); bright white-cyan frames run where the glass meets the
 * floor ramp and where it meets the ceiling arc (HDR, they bloom). Rough glass reflects the env map.
 */
function buildGlassMaterial(high: boolean, ceiling: boolean): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({
    roughness: 0.12,
    metalness: 0,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
  });
  const p = positionWorld;
  const fres2 = fresnel(2.0);
  let opacity: FloatNode = float(ceiling ? 0.12 : 0.16).add(fres2.mul(0.45));
  let glow: Vec3Node = vec3(0, 0, 0);
  let bloomGlow: Vec3Node = vec3(0, 0, 0);
  if (!ceiling) {
    const n = abs(normalWorld);
    const w = n.div(n.x.add(n.y).add(n.z));
    const cell = 320;
    const lw = 3;
    const hex = hexEdgeMask(p.zy, cell, lw)
      .mul(w.x)
      .add(hexEdgeMask(p.xy, cell, lw).mul(w.z))
      .add(hexEdgeMask(p.xz, cell, lw).mul(w.y));
    const grazing = fresnel(1.5).mul(0.6);
    let vis: FloatNode = grazing;
    if (high) {
      const near = oneMinus(smoothstep(float(700), float(2400), cameraDistance()));
      vis = max(near.mul(0.9), grazing);
    }
    const hexVis = hex.mul(vis);
    const frame = lineMask(p.y.sub(ARENA.sideRampRadius + 8), 7).add(lineMask(p.y.sub(ARENA.height - ARENA.ceilingRadius - 8), 7));
    const frameColor = vec3(1.1, 1.6, 2.0);
    const hexGlow = vec3(0.3, 0.65, 1.0).mul(hexVis).mul(0.55);
    const frameGlow = frameColor.mul(frame);
    opacity = opacity.add(hexVis.mul(0.6)).add(frame);
    glow = hexGlow.add(frameGlow);
    bloomGlow = frameGlow.add(hexGlow.mul(0.25));
  }
  m.opacityNode = opacity.saturate();
  m.colorNode = vec3(0.02, 0.03, 0.05);
  m.emissiveNode = glow;
  m.mrtNode = glowMrt(bloomGlow);
  return m;
}

/**
 * Goal chambers: a see-through square net (strands 56 uu apart) in the team colour, a fresnel glow
 * and a lit lintel along the top of the mouth. Blue at -z, red at +z. The sim provides planar
 * UVs (x, distance along the profile); without them a world-space projection is used.
 */
function buildGoalMaterial(hasUv: boolean): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({
    roughness: 0.6,
    metalness: 0,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
  });
  const p = positionWorld;
  const isRed = step(float(0), p.z);
  const tint = mix(linearVec3(TEAM_BLUE), linearVec3(TEAM_RED), isRed);
  const planar = hasUv ? uv() : vec2(p.x, p.y.add(abs(p.z)));
  const cellSize = 56;
  const strandU = lineMask(fract(planar.x.div(cellSize)).mul(cellSize).sub(cellSize / 2), 1.8);
  const strandV = lineMask(fract(planar.y.div(cellSize)).mul(cellSize).sub(cellSize / 2), 1.8);
  const net = max(strandU, strandV);
  const lintel = smoothstep(float(ARENA.goalHeight - 60), float(ARENA.goalHeight), p.y);
  m.opacityNode = net.mul(0.85).add(0.08);
  m.colorNode = tint.mul(0.5);
  m.emissiveNode = tint.mul(net.mul(0.5)).add(tint.mul(fresnel(2.5)).mul(0.3)).add(tint.mul(lintel).mul(0.8));
  m.mrtNode = glowMrt(tint.mul(net.mul(0.3).add(lintel.mul(0.8))));
  return m;
}

/**
 * Crowd tiers (unlit; the stands are floodlit so a flat look is right): the arena-facing faces are
 * a hashed palette of dim multicolour dots with a team tint per end, sparse HDR camera flashes
 * and a distance dim; the walkway tops are concrete with a lit rail; the roof ring is dark.
 */
function buildSeatMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const pw = positionWorld;
  const isTop = smoothstep(float(0.3), float(0.7), normalWorld.y);
  const isRoof = step(float(ROOF_Y), pw.y);

  // Cells along each tier (the mix of x and z keeps the curved corner segments from striping).
  const cell = floor(vec2(pw.x.mul(0.8).add(pw.z.mul(1.25)), pw.y).div(34));
  const h = hash(cell.x.add(cell.y.mul(57.17)).add(11.3));
  const h2 = hash(cell.x.mul(3.1).add(cell.y.mul(29.3)).add(5.7));
  const navy = linearVec3(0x151c2e);
  const grey = linearVec3(0x3a4152);
  const light = linearVec3(0x6b6a62);
  const teamSide = smoothstep(float(-1500), float(1500), pw.z);
  const teamCol = mix(linearVec3(0x1d3f8a), linearVec3(0x7a1424), teamSide);
  let crowd = mix(mix(navy, grey, step(float(0.45), h)), light, step(float(0.82), h));
  crowd = mix(crowd, teamCol, step(float(0.5), h2).mul(0.35));
  const flashOn = step(float(0.985), hash(cell.x.add(cell.y.mul(57.17)).add(floor(time.mul(6)).mul(13.7))));
  const flash = vec3(2.5, 2.5, 2.5).mul(flashOn);
  const dim = mix(float(1), float(0.55), smoothstep(float(3000), float(9000), cameraDistance()));

  // Walkway: concrete with a bright rail 18 uu from the front edge (local z = -0.5 faces the arena).
  const rail = lineMask(positionGeometry.z.add(0.5).mul(TIER_DEPTH).sub(18), 6);
  const railCol = vec3(0.9, 0.95, 1.0).mul(rail).mul(0.6);
  const topCol = linearVec3(0x20242c).add(railCol);

  let col = mix(crowd.add(flash), topCol, isTop).mul(dim);
  col = mix(col, linearVec3(0x0a0d14), isRoof);
  m.colorNode = col;
  const notRoof = oneMinus(isRoof);
  m.mrtNode = glowMrt(flash.mul(oneMinus(isTop)).mul(notRoof).add(railCol.mul(isTop).mul(0.5)), 'none');
  return m;
}

/**
 * Boost pad material: per-instance state from an instanced attribute (1 active, < 1 recharging,
 * > 1 pickup flash) and a per-vertex part kind. Ring: bright while active, dim with a clock-wipe
 * recharge arc; floor disc: soft additive glow; pill / orb: bobs, spins and shrinks to nothing
 * while inactive, bright core with a soft rim. Unlit, additive, HDR, tagged for bloom.
 */
function buildPadMaterial(stateAttr: THREE.InstancedBufferAttribute, timeU: FloatUniform): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const state = instancedBufferAttribute<'float'>(stateAttr, 'float');
  const kind = attribute('aKind', 'float');
  const isOrb = step(float(1.5), kind);
  const isDisc = step(float(0.5), kind).mul(oneMinus(isOrb));
  const isRing = oneMinus(step(float(0.5), kind));
  const charge = min(state, float(1));
  const active = step(float(0.999), state).mul(step(state, float(1.001)));
  const flash = max(state.sub(1), float(0)).mul(6);

  // Pad-local geometry (before instancing) for the spin / wipe; the instance offset is re-added.
  const pg = positionGeometry;
  const offset = positionLocal.sub(pg);
  const phase = float(instanceIndex).mul(0.9);
  const t = timeU.add(phase);
  const bob = sin(t.mul(2.2)).mul(10);
  const ang = t.mul(1.3);
  const c = cos(ang);
  const s = sin(ang);
  const rx = pg.x.mul(c).sub(pg.z.mul(s));
  const rz = pg.x.mul(s).add(pg.z.mul(c));
  const orbPos = vec3(rx.mul(active), pg.y.add(bob), rz.mul(active));
  m.positionNode = offset.add(mix(pg, orbPos, isOrb));

  const glow = linearVec3(BOOST_YELLOW);
  const white = vec3(1, 1, 1);
  // Ring: active 1.25; recharging 0.18 plus a clock-wipe arc that brightens as the pad charges.
  const angN = atan(pg.z, pg.x).div(2 * Math.PI).add(0.5);
  const wiped = step(angN, charge);
  const ringK = mix(float(0.18).add(wiped.mul(0.35)), float(1.25), active);
  const ringCol = glow.mul(ringK).add(white.mul(flash));
  // Floor glow disc.
  const discFall = oneMinus(smoothstep(float(0.15), float(0.5), length(uv().sub(0.5))));
  const discCol = glow.mul(0.5).mul(discFall).mul(mix(float(0.25), float(1.0), active)).add(white.mul(flash).mul(0.3));
  // Pill / orb: bright core, softer rim, gentle pulse.
  const pulse = float(0.9).add(sin(t.mul(4)).mul(0.1));
  const orbCol = glow.mul(mix(float(3.0), float(1.2), fresnel(1.5))).mul(pulse);
  const col = ringCol.mul(isRing).add(discCol.mul(isDisc)).add(orbCol.mul(isOrb));
  m.colorNode = col;
  m.mrtNode = glowMrt(col.mul(0.7));
  return m;
}

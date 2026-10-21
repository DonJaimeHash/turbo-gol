/**
 * Visual arena: the pitch (turf/), the stadium around it (stadium/: the shell and ceiling glass,
 * truss, lamps, haze cones, stands, masts, halos), the goal chambers with a see-through square net
 * and glowing frames, and the boost pads (constants.ts) as two instanced meshes (ring + floor glow
 * + floating pill / orb). The sim's surfaces (floor, shell, ceiling, goals) are converted here and
 * handed to the views that draw them.
 *
 * Goals: the netting (see-through square net projected from the world axes, so it runs on round
 * the rounded edges) and a glowing tube along the middle of each rounded post / crossbar edge
 * (ArenaMesh.goalFrames: from the floor at one post over the crossbar to the floor at the other).
 *
 * Draw calls: floor 1 (TurfView), stadium 8 (StadiumView: shell, ceiling, emissive bars, truss,
 * cones, stands, masts, halos), goals 1, goal frames 2, pads 2 = 14. Per frame: one uniform write
 * (time) plus pad-state attribute writes only while a pad changes (pickup flash / recharge).
 *
 * Bloom: see materials.ts. Every unlit material here that should glow tags its glow with
 * `glowMrt()`.
 */
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  atan,
  attribute,
  cos,
  diffuseColor,
  float,
  fract,
  instanceIndex,
  instancedBufferAttribute,
  length,
  max,
  min,
  mix,
  normalWorld,
  oneMinus,
  positionGeometry,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  step,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ArenaMesh } from '../sim/arenaMesh';
import { ARENA, BOOST_PADS_BIG, BOOST_PADS_SMALL, BOOST_PAD_BIG_RADIUS, BOOST_PAD_SMALL_RADIUS } from '../sim/constants';
import { NUM_BOOST_PADS } from '../sim/types';
import { simToThree } from './coords';
import { BOOST_YELLOW, TEAM_BLUE, TEAM_RED, fresnel, glowMrt, hdrColor, lineMask, linearVec3, type FloatUniform } from './materials';
import { tier, type Quality } from './quality';
import { StadiumView } from './stadium/StadiumView';
import type { ThemeId } from './theme';
import { TurfView } from './turf/TurfView';

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

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();

interface Disposable {
  dispose(): void;
}

export class ArenaView {
  readonly group = new THREE.Group();
  /** The pitch and the stadium (their own folders); `floor` / `shell` are their meshes. */
  readonly turf: TurfView;
  readonly stadium: StadiumView;
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

  /**
   * Build the arena for a quality tier (the tier table's `detail` here, the turf and stadium read
   * their own switches) and a stadium theme (no view reads it yet: the themes phase of
   * docs/visuals/REWORK.md does).
   */
  constructor(scene: THREE.Scene, mesh: ArenaMesh, quality: Quality, theme: ThemeId) {
    this.scene = scene;
    const m = mesh as unknown as ArenaMeshLike;
    const high = tier(quality).detail === 'high';

    // ---- Floor (the sim's exact floor fan when available, else a plane) ------------------------
    let floorGeo: THREE.BufferGeometry;
    if (m.floor !== undefined) floorGeo = toGeometry(m.floor, 'floor', 0, ARENA.height * 0.5, 0);
    else {
      floorGeo = new THREE.PlaneGeometry(ARENA.extentX * 2, (ARENA.extentY + ARENA.goalDepth) * 2, 1, 1);
      floorGeo.rotateX(-Math.PI / 2);
    }
    this.turf = new TurfView(this.group, floorGeo, this.timeU, quality, theme);
    this.floor = this.turf.mesh;

    // ---- Stadium: shell + ceiling glass, truss, lamps, cones, stands, masts, halos (8) --------
    const shellGeo = toGeometry(m.shell ?? m.walls, 'shell', 0, ARENA.height * 0.5, 0);
    let ceilGeo: THREE.BufferGeometry;
    if (m.ceiling !== undefined) ceilGeo = toGeometry(m.ceiling, 'ceiling', 0, ARENA.height * 0.5, 0);
    else {
      ceilGeo = new THREE.PlaneGeometry(ARENA.extentX * 2, ARENA.extentY * 2, 1, 1);
      ceilGeo.rotateX(Math.PI / 2); // normal -y: visible from inside only
      ceilGeo.translate(0, ARENA.height - 4, 0);
    }
    this.stadium = new StadiumView(this.group, { shell: shellGeo, ceiling: ceilGeo }, quality, theme);
    this.shell = this.stadium.shell;

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

    // ---- Goal frames (2 draw calls) ----------------------------------------------------------
    for (const frame of this.buildGoalFrames(mesh.goalFrames ?? [], high)) this.group.add(frame);

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

  /** The stadium theme changed: the turf and the stadium rewrite their uniforms (Game.setTheme). */
  setTheme(theme: ThemeId): void {
    this.turf.setTheme(theme);
    this.stadium.setTheme(theme);
  }

  /** Pipeline warm-up (Game.setWarm): the turf's and the stadium's meshes that start hidden. */
  setWarmUp(on: boolean): void {
    this.turf.setWarmUp(on);
    this.stadium.setWarmUp(on);
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.turf.dispose();
    this.stadium.dispose();
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

  /**
   * One glowing tube per goal (team HDR) along ArenaMesh.goalFrames: the middle of the rounded post
   * and crossbar edge, down each post's floor curve to the floor. Blue (the -y goal) first.
   */
  private buildGoalFrames(frames: readonly ArrayLike<number>[], high: boolean): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    frames.forEach((f, i) => {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k + 2 < f.length; k += 3) pts.push(simToThree(new THREE.Vector3(), f[k], f[k + 1], f[k + 2]));
      if (pts.length < 2) return;
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      const geometry = new THREE.TubeGeometry(curve, high ? 180 : 90, 12, high ? 8 : 6, false);
      const material = new THREE.MeshBasicNodeMaterial();
      material.color = hdrColor(i === 0 ? TEAM_BLUE : TEAM_RED, 2.2);
      material.mrtNode = glowMrt(diffuseColor.rgb, 'none');
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = i === 0 ? 'goal-frame-blue' : 'goal-frame-red';
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      this.track(geometry, material);
      out.push(mesh);
    });
    return out;
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

/**
 * Goal chambers: a see-through square net (strands 56 uu apart) in the team colour, a fresnel glow
 * and a lit lintel along the top of the mouth. Blue at -z, red at +z. The sim provides planar
 * UVs (x, distance along the profile); without them a world-space projection is used.
 * Both sides: round the mouth the cage is netting, so the chamber is also seen from outside, as a
 * net box behind the end wall (forceSinglePass keeps it one draw).
 */
function buildGoalMaterial(hasUv: boolean): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({
    roughness: 0.6,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  });
  m.forceSinglePass = true;
  const p = positionWorld;
  const isRed = step(float(0), p.z);
  const tint = mix(linearVec3(TEAM_BLUE), linearVec3(TEAM_RED), isRed);
  // The net, projected along each world axis and blended by the normal (triplanar): the cells run
  // on round the rounded posts, roof and back instead of stretching on a single planar projection.
  const cellSize = 56;
  const strand = (a: Node<'float'>): Node<'float'> => lineMask(fract(a.div(cellSize)).mul(cellSize).sub(cellSize / 2), 1.8);
  const netOf = (a: Node<'float'>, b: Node<'float'>): Node<'float'> => max(strand(a), strand(b));
  const nw = abs(normalWorld);
  const w = nw.mul(nw).mul(nw).mul(nw);
  const wsum = w.x.add(w.y).add(w.z).max(1e-4);
  const net = netOf(p.z, p.y).mul(w.x).add(netOf(p.x, p.z).mul(w.y)).add(netOf(p.x, p.y).mul(w.z)).div(wsum);
  void hasUv; // the sim's UVs (x, height) are kept for other materials; the net is triplanar
  const lintel = smoothstep(float(ARENA.goalHeight - 60), float(ARENA.goalHeight), p.y);
  m.opacityNode = net.mul(0.85).add(0.08);
  m.colorNode = tint.mul(0.5);
  m.emissiveNode = tint.mul(net.mul(0.5)).add(tint.mul(fresnel(2.5)).mul(0.3)).add(tint.mul(lintel).mul(0.8));
  m.mrtNode = glowMrt(tint.mul(net.mul(0.3).add(lintel.mul(0.8))));
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

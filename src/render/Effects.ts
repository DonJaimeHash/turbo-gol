/**
 * Pooled effects for the three.js WebGPU renderer: twin boost ribbons + embers (one per thruster),
 * supersonic air streaks, ball speed streak, goal explosion (particles + team / white / lime
 * confetti + double shockwave ring + fresnel shell), car demolitions (fireball, flames, team
 * sparks, falling embers, haze, a ground shockwave and a flash shell), boost pad pickup pops and
 * ball-contact sparks with a small impact ring.
 *
 * Meshes (all additive, none allocate per frame):
 *  - particles: ONE InstancedMesh (fixed pool of low-poly spheres). Per instance: the matrix
 *    (position + uniform scale, or an ellipsoid stretched along an axis for sparks/flakes) and a
 *    premultiplied HDR colour in `instanceColor`. Live particles are kept contiguous at the front
 *    of the pool and only that prefix is uploaded (update ranges).
 *  - ribbons: ONE BufferGeometry holding a fixed block of points per emitter (left and right
 *    boost, left and right streak per car, plus the ball). The CPU writes the centre line,
 *    tangent, half width, fade and colour; the vertex shader offsets each pair of vertices
 *    sideways, camera facing.
 *  - rings: ONE InstancedMesh (5 slots: two goal shockwaves, one ball-contact ring, two demolition
 *    shockwaves).
 *  - flash: one fresnel shell sphere, visible for half a second after a goal; a second one for
 *    demolitions (0.4 s).
 *
 * Tiers with `cheapMaterials` (super low, a 128-particle pool): no flash shells (a goal next to the
 * camera filled the screen with additive layers on a GPU that blends slowly), and every particle
 * is kept small on screen: its radius at most SCREEN_CAP x its distance from the camera (about a
 * dozen pixels at 640x360), its stretched length three times that.
 */
import * as THREE from 'three/webgpu';
import { attribute, cameraPosition, cross, diffuseColor, materialColor, normalView, positionLocal, positionViewDirection } from 'three/tsl';
import type { Team } from '../sim/types';
import {
  B_HIT_REL_POS,
  B_POS,
  B_VEL,
  BALL_OFFSET,
  C_IS_BOOSTING,
  C_IS_DEMOED,
  C_IS_SUPERSONIC,
  C_POS,
  C_ROT,
  C_TEAM,
  C_VEL,
  CAR_STRIDE,
  CARS_OFFSET,
  MAX_CARS,
} from '../sim/types';
import { BALL } from '../sim/constants';
import { simRotMatToQuat, simToThree, simVecLerpFromBuf } from './coords';
import { BOOST_NOZZLE_X, BOOST_NOZZLE_Y, BOOST_NOZZLE_Z, TEAM_GLOW } from './Car';
import { BRAND_LIME, glowMrt } from './materials';
import { tier, type Quality } from './quality';

const TWO_PI = Math.PI * 2;
const GRAVITY = 650; // uu/s^2, the sim's gravity
/** Ball speed above which the ball leaves a streak (uu/s). */
const BALL_STREAK_SPEED = 1400;
/** Boost thrusters at the rear of a car, local three.js coords (x forward, y up, +-z). */
const REAR_X = BOOST_NOZZLE_X - 1;
const REAR_Y = BOOST_NOZZLE_Y;
const REAR_Z = BOOST_NOZZLE_Z;
/** Supersonic air-streak emitters on the flanks, local three.js coords. */
const STREAK_X = -12;
const STREAK_Y = 8;
const STREAK_Z = 44;
/** Emitters reset when they jumped further than this between frames (teleport). */
const EMIT_TELEPORT_SQ = 400 * 400;
const GOAL_RING_DURATION = 1.2;
const GOAL_RING2_DELAY = 0.4;
const GOAL_FLASH_DURATION = 0.5;
const FLASH_SCALE_0 = 130;
const FLASH_SCALE_1 = 900;
const HIT_RING_DURATION = 0.2;
const DEMO_RING_DURATION = 0.55;
const DEMO_FLASH_DURATION = 0.3;
const DEMO_FLASH_SCALE_0 = 40;
const DEMO_FLASH_SCALE_1 = 240;
/** Ring slots in the rings InstancedMesh. */
const RING_GOAL_A = 0;
const RING_GOAL_B = 1;
const RING_HIT = 2;
const RING_DEMO_A = 3;
const RING_DEMO_B = 4;
const RING_SLOTS = 5;
/**
 * Bloom tags (materials.ts): fraction of each effect's own colour written to the glow target. The
 * colour is read back from `diffuseColor` (instance colour x colorNode, already evaluated in the
 * main fragment flow); the MRT write has alpha 1, so fading materials fold `diffuseColor.a` in.
 */
const GLOW_PARTICLES = 0.6;
const GLOW_RIBBON = 0.5;
const GLOW_RING = 0.6;
const GLOW_FLASH = 0.4;
/** Super low: a particle's radius at most this x its distance from the camera (tan of ~2.3 degrees). */
const SCREEN_CAP = 0.04;

// Ribbons.
const RIBBON_CAP = 48; // points per emitter
const RIBBON_SPACING = 18; // uu between committed points
const RIBBON_MAX_SUB = 6; // max points committed per emitter per frame
/** Emitters per car: left boost, left streak, right streak, right boost. */
const RIBBONS_PER_CAR = 4;
const RIBBON_EMITTERS = MAX_CARS * RIBBONS_PER_CAR + 1;
const RIBBON_BALL = MAX_CARS * RIBBONS_PER_CAR;
const BOOST_RIBBON_WIDTH = 6;
const BOOST_RIBBON_LIFE = 0.4;
const STREAK_RIBBON_WIDTH = 4;
const STREAK_RIBBON_LIFE = 0.22;
const BALL_RIBBON_WIDTH = 16;
const BALL_RIBBON_LIFE = 0.3;

// ---- scratch -------------------------------------------------------------------------------
const _p = new THREE.Vector3();
const _bp = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _rear = new THREE.Vector3();
const _rear2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _n = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _up = new THREE.Vector3(0, 1, 0);

function rnd(amp: number): number {
  return (Math.random() - 0.5) * 2 * amp;
}

/** Additive material whose colour fades towards the silhouette so spheres read as soft glows. */
function createSoftMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.transparent = true;
  m.blending = THREE.AdditiveBlending;
  m.depthWrite = false;
  m.fog = false;
  const soft = normalView.dot(positionViewDirection).saturate().pow(1.5);
  m.colorNode = materialColor.mul(soft);
  m.mrtNode = glowMrt(diffuseColor.rgb.mul(GLOW_PARTICLES));
  return m;
}

/** Additive fresnel-only shell: bright at the silhouette, transparent face on (a bubble). */
function createShellMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.transparent = true;
  m.blending = THREE.AdditiveBlending;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.fog = false;
  // saturate before oneMinus: |n . v| can exceed 1 by an ulp and pow() of a negative base is NaN.
  const rim = normalView.dot(positionViewDirection).abs().saturate().oneMinus().pow(2.5);
  m.colorNode = materialColor.mul(rim).mul(1.8);
  m.mrtNode = glowMrt(diffuseColor.rgb.mul(diffuseColor.a).mul(GLOW_FLASH)); // material.opacity fades it
  return m;
}

/** Plain additive material (rings); per-instance colour carries the opacity. */
function createRingMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.transparent = true;
  m.blending = THREE.AdditiveBlending;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.fog = false;
  m.mrtNode = glowMrt(diffuseColor.rgb.mul(GLOW_RING));
  return m;
}

/**
 * Camera-facing ribbon: every vertex carries the centre-line point, its tangent and a signed half
 * width; the shader pushes it sideways along normalize(tangent x (camera - point)).
 */
function createRibbonMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.transparent = true;
  m.blending = THREE.AdditiveBlending;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.fog = false;
  const tangent = attribute('aTangent', 'vec3');
  const side = attribute('aSide', 'float');
  const fade = attribute('aFade', 'float');
  const col = attribute('aColor', 'vec3');
  const c = cross(tangent, cameraPosition.sub(positionLocal));
  const dir = c.div(c.length().max(1e-3)); // camera on the tangent line: zero width, never NaN
  m.positionNode = positionLocal.add(dir.mul(side));
  // `fade` is written in [0, 1] but MSAA interpolates varyings at the pixel centre, which sits
  // outside the triangle for partially covered edge pixels: past the ribbon's tail it extrapolates
  // below 0 and pow() of a negative base is NaN (one NaN texel in the glow target blurs into a big
  // black rectangle through the bloom mips). Saturate first.
  m.colorNode = col.mul(fade.saturate().pow(1.5));
  m.mrtNode = glowMrt(diffuseColor.rgb.mul(GLOW_RIBBON));
  return m;
}

export class Effects {
  private readonly scene: THREE.Scene;
  /** High detail (TierSpec.detail): fuller bursts and boost embers. */
  private readonly hi: boolean;
  /** Pool size. */
  private readonly n: number;
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly matArr: Float32Array;
  private readonly colArr: Float32Array;

  // Particle pool (struct of arrays).
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly axis: Float32Array;
  private readonly col: Float32Array;
  private readonly life: Float32Array;
  private readonly invLife: Float32Array;
  private readonly size: Float32Array;
  private readonly len: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  /** Live particles occupy [0, alive); dead ones are swap-removed so only live instances are drawn. */
  private alive = 0;
  /** Round-robin overwrite cursor used only when the pool is full. */
  private next = 0;

  // Per-car emitter state.
  private readonly slotTeam = new Int8Array(MAX_CARS).fill(-1);
  private readonly slotBoostAcc = new Float32Array(MAX_CARS);
  /**
   * 1 once the car has been drawn alive: a demolition explodes only after that, so a car that is
   * already demolished when the view starts (an online join, a new roster) never explodes.
   */
  private readonly slotAlive = new Uint8Array(MAX_CARS);
  /** Last live interpolated position and velocity per slot, three.js coords (x, y, z, vx, vy, vz). */
  private readonly slotLast = new Float32Array(MAX_CARS * 6);
  /**
   * Called once per demolition with the car slot and the explosion point (three.js coords), from
   * update(): the game plays the sound there (the same edge for offline, server and P2P matches).
   */
  onDemolition: ((slot: number, x: number, y: number, z: number) => void) | null = null;

  // Ribbon pool: per emitter a ring of RIBBON_CAP points (x, y, z, age).
  private readonly ribbon: THREE.Mesh;
  private readonly ribbonMat: THREE.MeshBasicNodeMaterial;
  private readonly rbPosAttr: THREE.BufferAttribute;
  private readonly rbTanAttr: THREE.BufferAttribute;
  private readonly rbSideAttr: THREE.BufferAttribute;
  private readonly rbFadeAttr: THREE.BufferAttribute;
  private readonly rbColAttr: THREE.BufferAttribute;
  private readonly rbPos: Float32Array;
  private readonly rbTan: Float32Array;
  private readonly rbSide: Float32Array;
  private readonly rbFade: Float32Array;
  private readonly rbCol: Float32Array;
  private readonly rbPts = new Float32Array(RIBBON_EMITTERS * RIBBON_CAP * 4);
  private readonly rbHead = new Int32Array(RIBBON_EMITTERS);
  private readonly rbCount = new Int32Array(RIBBON_EMITTERS);
  private readonly rbPrevCount = new Int32Array(RIBBON_EMITTERS);
  private readonly rbLife = new Float32Array(RIBBON_EMITTERS);
  private readonly rbWidth = new Float32Array(RIBBON_EMITTERS);
  private readonly rbColor = new Float32Array(RIBBON_EMITTERS * 3);

  /** Linear RGB team glow colours, [blue rgb, red rgb]. */
  private readonly teamGlow = new Float32Array(6);
  /** Linear RGB brand lime (confetti). */
  private readonly lime = new Float32Array(3);

  // Rings (goal shockwaves + contact ring) in one InstancedMesh.
  private readonly rings: THREE.InstancedMesh;
  private readonly ringMat: THREE.MeshBasicNodeMaterial;
  private readonly ringT = new Float32Array(RING_SLOTS).fill(-1);
  private readonly ringDelay = new Float32Array(RING_SLOTS);
  private readonly ringDur = new Float32Array(RING_SLOTS);
  private readonly ringS0 = new Float32Array(RING_SLOTS);
  private readonly ringS1 = new Float32Array(RING_SLOTS);
  private readonly ringK = new Float32Array(RING_SLOTS);
  private readonly ringPos = new Float32Array(RING_SLOTS * 3);
  private readonly ringCol = new Float32Array(RING_SLOTS * 3);
  private readonly ringQuat: THREE.Quaternion[] = [];

  // Goal flash shell.
  private readonly flash: THREE.Mesh;
  private readonly flashMat: THREE.MeshBasicNodeMaterial;
  private flashT = -1;
  // Demolition flash shell (one at a time: a second demo restarts it) and the next ring slot.
  private readonly demoFlash: THREE.Mesh;
  private readonly demoFlashMat: THREE.MeshBasicNodeMaterial;
  private demoFlashT = -1;
  private demoRing = RING_DEMO_A;
  /** Which hidden meshes a warm-up render forced visible (see setWarmUp). */
  private warmParticles = false;
  private warmRibbon = false;
  private warmRings = false;
  private warmFlash = false;
  private warmDemoFlash = false;
  /** The flash shells exist on screen (not on tiers with cheapMaterials). */
  private readonly flashes: boolean;
  /** Super low: the camera whose distance caps the particles' size (null: no cap). */
  private readonly capCamera: THREE.Camera | null;

  // Deferred ball hit (the contact offset is read from the next state buffer the view receives).
  private pendingHitSpeed = -1;
  private disposed = false;

  constructor(scene: THREE.Scene, quality: Quality, camera: THREE.Camera | null = null) {
    this.scene = scene;
    const spec = tier(quality);
    this.hi = spec.detail === 'high';
    this.flashes = !spec.cheapMaterials;
    this.capCamera = spec.cheapMaterials ? camera : null;
    const n = spec.particles;
    this.n = n;

    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.axis = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.invLife = new Float32Array(n);
    this.size = new Float32Array(n);
    this.len = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);

    this.material = createSoftMaterial();
    this.material.name = 'fx-particles';
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), this.material, n);
    this.mesh.name = 'fx-particles';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 10;
    this.matArr = this.mesh.instanceMatrix.array as Float32Array;
    this.colArr = this.mesh.instanceColor.array as Float32Array;
    // InstancedMesh initialises identity matrices: collapse everything to nothing.
    this.matArr.fill(0);
    for (let i = 0; i < n; i++) this.matArr[i * 16 + 15] = 1;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = 0;
    this.mesh.visible = false;
    scene.add(this.mesh);

    for (let t = 0; t < 2; t++) {
      _c.setHex(TEAM_GLOW[t]);
      this.teamGlow[t * 3] = _c.r;
      this.teamGlow[t * 3 + 1] = _c.g;
      this.teamGlow[t * 3 + 2] = _c.b;
    }
    _c.setHex(BRAND_LIME);
    this.lime[0] = _c.r;
    this.lime[1] = _c.g;
    this.lime[2] = _c.b;

    // Ribbons: fixed vertex blocks (2 verts per point) and a fixed quad index buffer.
    const nv = RIBBON_EMITTERS * RIBBON_CAP * 2;
    this.rbPos = new Float32Array(nv * 3);
    this.rbTan = new Float32Array(nv * 3);
    this.rbSide = new Float32Array(nv);
    this.rbFade = new Float32Array(nv);
    this.rbCol = new Float32Array(nv * 3);
    const rbGeo = new THREE.BufferGeometry();
    this.rbPosAttr = new THREE.BufferAttribute(this.rbPos, 3).setUsage(THREE.DynamicDrawUsage);
    this.rbTanAttr = new THREE.BufferAttribute(this.rbTan, 3).setUsage(THREE.DynamicDrawUsage);
    this.rbSideAttr = new THREE.BufferAttribute(this.rbSide, 1).setUsage(THREE.DynamicDrawUsage);
    this.rbFadeAttr = new THREE.BufferAttribute(this.rbFade, 1).setUsage(THREE.DynamicDrawUsage);
    this.rbColAttr = new THREE.BufferAttribute(this.rbCol, 3).setUsage(THREE.DynamicDrawUsage);
    rbGeo.setAttribute('position', this.rbPosAttr);
    rbGeo.setAttribute('aTangent', this.rbTanAttr);
    rbGeo.setAttribute('aSide', this.rbSideAttr);
    rbGeo.setAttribute('aFade', this.rbFadeAttr);
    rbGeo.setAttribute('aColor', this.rbColAttr);
    const idx = new Uint16Array(RIBBON_EMITTERS * (RIBBON_CAP - 1) * 6);
    let k = 0;
    for (let e = 0; e < RIBBON_EMITTERS; e++) {
      const base = e * RIBBON_CAP * 2;
      for (let s = 0; s < RIBBON_CAP - 1; s++) {
        const v = base + s * 2;
        idx[k++] = v;
        idx[k++] = v + 1;
        idx[k++] = v + 2;
        idx[k++] = v + 1;
        idx[k++] = v + 3;
        idx[k++] = v + 2;
      }
    }
    rbGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    rbGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.ribbonMat = createRibbonMaterial();
    this.ribbonMat.name = 'fx-ribbons';
    // Cheap tiers: additive, one pass instead of the back-then-front pair (a pipeline less).
    this.ribbonMat.forceSinglePass = spec.cheapMaterials;
    this.ribbon = new THREE.Mesh(rbGeo, this.ribbonMat);
    this.ribbon.name = 'fx-ribbons';
    this.ribbon.frustumCulled = false;
    this.ribbon.castShadow = false;
    this.ribbon.receiveShadow = false;
    this.ribbon.renderOrder = 9;
    this.ribbon.visible = false;
    scene.add(this.ribbon);

    // Rings.
    this.ringMat = createRingMaterial();
    this.ringMat.name = 'fx-rings';
    this.ringMat.forceSinglePass = spec.cheapMaterials;
    this.rings = new THREE.InstancedMesh(new THREE.RingGeometry(0.86, 1, this.hi ? 64 : 40, 1), this.ringMat, RING_SLOTS);
    this.rings.name = 'fx-rings';
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(RING_SLOTS * 3), 3);
    this.rings.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.rings.count = 0;
    this.rings.visible = false;
    this.rings.frustumCulled = false;
    this.rings.castShadow = false;
    this.rings.receiveShadow = false;
    this.rings.renderOrder = 11;
    for (let i = 0; i < RING_SLOTS; i++) this.ringQuat.push(new THREE.Quaternion());
    scene.add(this.rings);

    // Flash shell.
    this.flashMat = createShellMaterial();
    this.flashMat.name = 'fx-goal-flash';
    this.flash = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), this.flashMat);
    this.flash.name = 'fx-goal-flash';
    this.flash.visible = false;
    this.flash.frustumCulled = false;
    this.flash.renderOrder = 11;
    scene.add(this.flash);

    this.demoFlashMat = createShellMaterial();
    this.demoFlashMat.name = 'fx-demo-flash';
    this.demoFlash = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), this.demoFlashMat);
    this.demoFlash.name = 'fx-demo-flash';
    this.demoFlash.visible = false;
    this.demoFlash.frustumCulled = false;
    this.demoFlash.renderOrder = 11;
    scene.add(this.demoFlash);
  }

  /** Tell the effects which team a car slot belongs to (otherwise C_TEAM from the buffer is used). */
  registerCar(slot: number, team: Team): void {
    if (slot >= 0 && slot < MAX_CARS) this.slotTeam[slot] = team;
  }

  /**
   * Emit from the cars in `carSlots` and from the ball, then advance every live particle, ribbon
   * and ring. `prev`/`cur` are full state buffers; `alpha` the interpolation factor; `dt` the
   * frame time.
   */
  update(prev: Float32Array, cur: Float32Array, alpha: number, dt: number, carSlots: number[]): void {
    if (this.disposed) return;
    if (!(dt > 0)) dt = 0;
    else if (dt > 0.1) dt = 0.1;
    this.ribbonAge(dt);
    for (let i = 0; i < carSlots.length; i++) this.updateCar(prev, cur, alpha, dt, carSlots[i]);
    this.updateBall(prev, cur, alpha, dt);
    if (this.pendingHitSpeed >= 0) {
      this.spawnBallHit(cur, this.pendingHitSpeed);
      this.pendingHitSpeed = -1;
    }
    this.ribbonBuild();
    this.updateRings(dt);
    this.updateFlash(dt);
    this.updateDemoFlash(dt);
    this.simulate(dt);
  }

  /** Goal explosion in the scoring team's colour at the ball position (sim coords). */
  onGoal(team: Team, simPos: readonly [number, number, number]): void {
    simToThree(_p, simPos[0], simPos[1], simPos[2]);
    const gi = team * 3;
    const r = this.teamGlow[gi] * 0.75 + 0.25;
    const g = this.teamGlow[gi + 1] * 0.75 + 0.25;
    const b = this.teamGlow[gi + 2] * 0.75 + 0.25;
    const hi = this.hi;
    this.burst(_p.x, _p.y, _p.z, hi ? 200 : 110, r * 1.4, g * 1.4, b * 1.4, 500, 2000, 0.25, 5, 14, 0.9, 1.6, 0.55, 0.8, 22, 0);

    // Confetti: slow tumbling flakes in team glow / white / brand lime.
    const cn = hi ? 47 : 27;
    const tg = this.teamGlow;
    this.burst(_p.x, _p.y, _p.z, cn, tg[gi] * 1.3, tg[gi + 1] * 1.3, tg[gi + 2] * 1.3, 350, 1300, 0.45, 5, 8, 1.8, 2.6, 0.35, 2.5, 14, 1);
    this.burst(_p.x, _p.y, _p.z, cn, 1.2, 1.2, 1.2, 350, 1300, 0.45, 5, 8, 1.8, 2.6, 0.35, 2.5, 14, 1);
    this.burst(_p.x, _p.y, _p.z, cn, this.lime[0] * 1.3, this.lime[1] * 1.3, this.lime[2] * 1.3, 350, 1300, 0.45, 5, 8, 1.8, 2.6, 0.35, 2.5, 14, 1);

    // Double shockwave along the goal plane (ring normal = +z = sim +y).
    this.startRing(RING_GOAL_A, _p, null, 120, 2720, GOAL_RING_DURATION, 0, r * 1.6, g * 1.6, b * 1.6, 0.9);
    this.startRing(RING_GOAL_B, _p, null, 120, 2720, GOAL_RING_DURATION, GOAL_RING2_DELAY, r * 1.6, g * 1.6, b * 1.6, 0.45);

    if (this.flashes) {
      this.flash.position.copy(_p);
      this.flash.scale.setScalar(FLASH_SCALE_0);
      this.flashMat.color.setRGB(r * 0.6 + 0.4, g * 0.6 + 0.4, b * 0.6 + 0.4).multiplyScalar(1.3);
      this.flashMat.opacity = 0.8;
      this.flash.visible = true;
      this.flashT = 0;
    }
  }

  /**
   * Sparks and a small impact ring where a car touched the ball; `speed` = relative hit speed
   * (uu/s). The burst is deferred to the next update() so the contact offset (B_HIT_REL_POS) can
   * be read from the state buffer the views receive; `simPos` is only a fallback.
   */
  onBallHit(simPos: readonly [number, number, number], speed: number): void {
    simToThree(_bp, simPos[0], simPos[1], simPos[2]);
    this.pendingHitSpeed = Math.max(0, speed);
  }

  /** Yellow pop when a boost pad is collected. */
  onPadPickup(simPos: readonly [number, number, number], big: boolean): void {
    simToThree(_p, simPos[0], simPos[1], simPos[2]);
    const count = big ? 16 : 7;
    this.burst(_p.x, _p.y + 10, _p.z, count, 1.8, 1.5, 0.45, 150, big ? 520 : 400, 0.9, 4, big ? 9 : 7, 0.32, 0.55, 0.6, 2, 0, 0);
  }

  /**
   * Pipeline warm-up hook (Game.warmUp): every mesh that starts hidden (particles, ribbons, rings,
   * flash) is drawn once with nothing visible in it (one collapsed instance / zero opacity) so its
   * shader compiles before the first boost, goal or ball touch. `false` undoes only what this
   * forced; effects that were already live are never touched.
   */
  setWarmUp(on: boolean): void {
    if (this.disposed) return;
    if (on) {
      this.warmParticles = !this.mesh.visible;
      if (this.warmParticles) {
        // Slot 0 may hold a dead particle's matrix / colour: collapse it before showing it.
        this.matArr.fill(0, 0, 16);
        this.matArr[15] = 1;
        this.colArr.fill(0, 0, 3);
        const im = this.mesh.instanceMatrix;
        im.clearUpdateRanges();
        im.addUpdateRange(0, 16);
        im.needsUpdate = true;
        const ic = this.mesh.instanceColor;
        if (ic !== null) {
          ic.clearUpdateRanges();
          ic.addUpdateRange(0, 3);
          ic.needsUpdate = true;
        }
        this.mesh.count = 1;
        this.mesh.visible = true;
      }
      this.warmRibbon = !this.ribbon.visible;
      if (this.warmRibbon) this.ribbon.visible = true; // unused points are collapsed with fade 0
      this.warmRings = !this.rings.visible;
      if (this.warmRings) {
        _m.makeScale(0, 0, 0);
        this.rings.setMatrixAt(0, _m);
        _c.setRGB(0, 0, 0);
        this.rings.setColorAt(0, _c);
        const im = this.rings.instanceMatrix;
        im.clearUpdateRanges();
        im.addUpdateRange(0, 16);
        im.needsUpdate = true;
        const ic = this.rings.instanceColor;
        if (ic !== null) {
          ic.clearUpdateRanges();
          ic.addUpdateRange(0, 3);
          ic.needsUpdate = true;
        }
        this.rings.count = 1;
        this.rings.visible = true;
      }
      this.warmFlash = this.flashes && !this.flash.visible;
      if (this.warmFlash) {
        this.flash.scale.setScalar(0.01);
        this.flashMat.opacity = 0;
        this.flash.visible = true;
      }
      this.warmDemoFlash = this.flashes && !this.demoFlash.visible;
      if (this.warmDemoFlash) {
        this.demoFlash.scale.setScalar(0.01);
        this.demoFlashMat.opacity = 0;
        this.demoFlash.visible = true;
      }
    } else {
      if (this.warmParticles) {
        this.mesh.count = 0;
        this.mesh.visible = false;
      }
      if (this.warmRibbon) this.ribbon.visible = false;
      if (this.warmRings) {
        this.rings.count = 0;
        this.rings.visible = false;
      }
      if (this.warmFlash) this.flash.visible = false;
      if (this.warmDemoFlash) this.demoFlash.visible = false;
      this.warmDemoFlash = false;
      this.warmParticles = false;
      this.warmRibbon = false;
      this.warmRings = false;
      this.warmFlash = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.mesh);
    this.scene.remove(this.ribbon);
    this.scene.remove(this.rings);
    this.scene.remove(this.flash);
    this.scene.remove(this.demoFlash);
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.material.dispose();
    this.ribbon.geometry.dispose();
    this.ribbonMat.dispose();
    this.rings.geometry.dispose();
    this.rings.dispose();
    this.ringMat.dispose();
    this.flash.geometry.dispose();
    this.flashMat.dispose();
    this.demoFlash.geometry.dispose();
    this.demoFlashMat.dispose();
  }

  // ---- emitters ----------------------------------------------------------------------------

  private updateCar(prev: Float32Array, cur: Float32Array, alpha: number, dt: number, slot: number): void {
    if (slot < 0 || slot >= MAX_CARS) return;
    const off = CARS_OFFSET + slot * CAR_STRIDE;
    const r = off + C_ROT;
    const fx = cur[r];
    const fy = cur[r + 1];
    const fz = cur[r + 2];
    let team = this.slotTeam[slot];
    if (team < 0) team = cur[off + C_TEAM] > 0.5 ? 1 : 0;
    if (cur[off + C_IS_DEMOED] > 0.5 || fx * fx + fy * fy + fz * fz < 0.5) {
      this.slotBoostAcc[slot] = 0;
      if (this.slotAlive[slot] === 1 && cur[off + C_IS_DEMOED] > 0.5) this.explode(slot, team);
      this.slotAlive[slot] = 0;
      return;
    }

    simVecLerpFromBuf(_p, prev, cur, off + C_POS, alpha);
    simRotMatToQuat(_q, cur, r);
    _fwd.set(1, 0, 0).applyQuaternion(_q);
    _rear.set(REAR_X, REAR_Y, -REAR_Z).applyQuaternion(_q).add(_p);
    _rear2.set(REAR_X, REAR_Y, REAR_Z).applyQuaternion(_q).add(_p);
    const v = off + C_VEL;
    _vel.set(cur[v], cur[v + 2], cur[v + 1]);
    const speed = _vel.length();
    const l6 = slot * 6;
    this.slotLast[l6] = _p.x;
    this.slotLast[l6 + 1] = _p.y;
    this.slotLast[l6 + 2] = _p.z;
    this.slotLast[l6 + 3] = _vel.x;
    this.slotLast[l6 + 4] = _vel.y;
    this.slotLast[l6 + 5] = _vel.z;
    this.slotAlive[slot] = 1;
    const gi = team * 3;
    const e = slot * RIBBONS_PER_CAR;

    if (cur[off + C_IS_BOOSTING] > 0.5) {
      // A continuous ribbon from each thruster plus a few embers (alternating thrusters).
      const tr = this.teamGlow[gi] * 1.6;
      const tg = this.teamGlow[gi + 1] * 1.6;
      const tb = this.teamGlow[gi + 2] * 1.6;
      this.ribbonStyle(e, BOOST_RIBBON_WIDTH, BOOST_RIBBON_LIFE, tr, tg, tb);
      this.ribbonEmit(e, _rear.x, _rear.y, _rear.z);
      this.ribbonStyle(e + 3, BOOST_RIBBON_WIDTH, BOOST_RIBBON_LIFE, tr, tg, tb);
      this.ribbonEmit(e + 3, _rear2.x, _rear2.y, _rear2.z);

      const acc = this.slotBoostAcc[slot] + (this.hi ? 35 : 20) * dt;
      const count = Math.floor(acc);
      this.slotBoostAcc[slot] = acc - count;
      const cr = this.teamGlow[gi] * 1.25;
      const cg = this.teamGlow[gi + 1] * 1.25;
      const cb = this.teamGlow[gi + 2] * 1.25;
      for (let k = 0; k < count; k++) {
        const src = (k & 1) === 0 ? _rear : _rear2;
        this.spawn(
          src.x + rnd(3),
          src.y + rnd(3),
          src.z + rnd(3),
          _vel.x * 0.2 - _fwd.x * 180 + rnd(50),
          _vel.y * 0.2 - _fwd.y * 180 + rnd(50),
          _vel.z * 0.2 - _fwd.z * 180 + rnd(50),
          cr,
          cg,
          cb,
          3 + Math.random() * 2.5,
          0.25 + Math.random() * 0.15,
          0,
          0,
          0,
          0,
          0,
          4,
        );
      }
    } else {
      this.slotBoostAcc[slot] = 0;
    }

    if (cur[off + C_IS_SUPERSONIC] > 0.5 && speed > 1) {
      for (let s = 0; s < 2; s++) {
        const ei = e + 1 + s;
        this.ribbonStyle(ei, STREAK_RIBBON_WIDTH, STREAK_RIBBON_LIFE, 0.9, 0.9, 0.9);
        _side.set(STREAK_X, STREAK_Y, s === 0 ? -STREAK_Z : STREAK_Z).applyQuaternion(_q).add(_p);
        this.ribbonEmit(ei, _side.x, _side.y, _side.z);
      }
    }
  }

  /**
   * A demolished car blows up at its last live position (slotLast): a hot white core, rising
   * orange flames, fast team-coloured sparks, embers that arc out and bounce on the floor, a few
   * dim haze puffs (additive, so lit smoke rather than dark smoke), a ground shockwave and a flash
   * shell. Everything inherits 30 % of the car's velocity. About 140 particles (60 at low detail).
   */
  private explode(slot: number, team: number): void {
    const l6 = slot * 6;
    const x = this.slotLast[l6];
    const y = this.slotLast[l6 + 1];
    const z = this.slotLast[l6 + 2];
    const vx = this.slotLast[l6 + 3] * 0.3;
    const vy = this.slotLast[l6 + 4] * 0.3;
    const vz = this.slotLast[l6 + 5] * 0.3;
    const gi = (team === 1 ? 1 : 0) * 3;
    const tr = this.teamGlow[gi];
    const tg = this.teamGlow[gi + 1];
    const tb = this.teamGlow[gi + 2];
    const hi = this.hi;
    // Core, flames, deep red flames, sparks, embers, haze.
    this.burst(x, y, z, hi ? 10 : 5, 2.2, 1.45, 0.6, 30, 220, 0.3, 24, 40, 0.2, 0.36, -0.1, 4, 0, 0, vx, vy, vz);
    this.burst(x, y, z, hi ? 40 : 18, 2.0, 0.55, 0.08, 150, 650, 0.45, 14, 30, 0.45, 0.85, -0.35, 2.2, 0, 0, vx, vy, vz);
    this.burst(x, y, z, hi ? 16 : 7, 1.1, 0.16, 0.02, 250, 500, 0.6, 20, 34, 0.6, 1.0, -0.3, 2.4, 0, 0, vx, vy, vz);
    this.burst(x, y, z, hi ? 44 : 18, tr * 1.8, tg * 1.8, tb * 1.8, 700, 1700, 0.35, 2.5, 4.5, 0.35, 0.7, 0.8, 1.2, 30, 0, vx, vy, vz);
    this.burst(x, y, z, hi ? 22 : 10, 1.5, 0.55, 0.12, 400, 1100, 0.7, 4, 8, 1, 1.7, 1.2, 0.4, 0, 0, vx, vy, vz);
    this.burst(x, y + 20, z, hi ? 10 : 4, 0.22, 0.17, 0.14, 40, 160, 0.6, 55, 85, 1, 1.5, -0.08, 1.6, 0, 0, vx * 0.5, vy * 0.5, vz * 0.5);

    // Ground shockwave (alternating slots so two demos in a row both show) and the flash shell.
    _p.set(x, Math.max(y, 12), z);
    const ring = this.demoRing;
    this.demoRing = ring === RING_DEMO_A ? RING_DEMO_B : RING_DEMO_A;
    this.startRing(ring, _p, _up, 40, 760, DEMO_RING_DURATION, 0, 1.7, 0.7, 0.16, 0.9);
    if (this.flashes) {
      this.demoFlash.position.set(x, y, z);
      this.demoFlash.scale.setScalar(DEMO_FLASH_SCALE_0);
      this.demoFlashMat.color.setRGB(1.3, 0.55, 0.16);
      this.demoFlashMat.opacity = 0.45;
      this.demoFlash.visible = true;
      this.demoFlashT = 0;
    }

    if (this.onDemolition !== null) this.onDemolition(slot, x, y, z);
  }

  private updateBall(prev: Float32Array, cur: Float32Array, alpha: number, _dt: number): void {
    const o = BALL_OFFSET;
    simVecLerpFromBuf(_bp, prev, cur, o + B_POS, alpha);
    _vel.set(cur[o + B_VEL], cur[o + B_VEL + 2], cur[o + B_VEL + 1]);
    if (_vel.lengthSq() > BALL_STREAK_SPEED * BALL_STREAK_SPEED) {
      this.ribbonStyle(RIBBON_BALL, BALL_RIBBON_WIDTH, BALL_RIBBON_LIFE, 0.55, 0.6, 0.7);
      this.ribbonEmit(RIBBON_BALL, _bp.x, _bp.y, _bp.z);
    }
  }

  /** Sparks + impact ring at the last contact point on the ball surface (from `cur`). */
  private spawnBallHit(cur: Float32Array, speed: number): void {
    const o = BALL_OFFSET + B_HIT_REL_POS;
    _n.set(cur[o], cur[o + 2], cur[o + 1]); // sim -> three
    const l = _n.length();
    const onSurface = l > 1;
    let x = _bp.x;
    let y = _bp.y;
    let z = _bp.z;
    if (onSurface) {
      _n.multiplyScalar(1 / l);
      x += _n.x * BALL.visualRadius;
      y += _n.y * BALL.visualRadius;
      z += _n.z * BALL.visualRadius;
    }
    const count = 6 + Math.min(14, Math.floor(speed / 200));
    const vMax = Math.min(1400, 450 + speed * 0.3);
    this.burst(x, y, z, count, 1.6, 1.6, 1.5, 300, vMax, 0.15, 2.5, 5, 0.15, 0.3, 0.6, 3, 18, 0);
    if (onSurface) {
      _p.set(x + _n.x * 3, y + _n.y * 3, z + _n.z * 3);
      this.startRing(RING_HIT, _p, _n, 30, 140, HIT_RING_DURATION, 0, 1.3, 1.3, 1.3, 0.6);
    }
  }

  // ---- ribbons -----------------------------------------------------------------------------

  private ribbonStyle(e: number, width: number, life: number, r: number, g: number, b: number): void {
    this.rbWidth[e] = width;
    this.rbLife[e] = life;
    this.rbColor[e * 3] = r;
    this.rbColor[e * 3 + 1] = g;
    this.rbColor[e * 3 + 2] = b;
  }

  private ribbonPush(e: number, x: number, y: number, z: number, age: number): void {
    const head = this.rbCount[e] === 0 ? 0 : (this.rbHead[e] + 1) % RIBBON_CAP;
    this.rbHead[e] = head;
    const i = (e * RIBBON_CAP + head) * 4;
    const pts = this.rbPts;
    pts[i] = x;
    pts[i + 1] = y;
    pts[i + 2] = z;
    pts[i + 3] = age;
    if (this.rbCount[e] < RIBBON_CAP) this.rbCount[e]++;
  }

  /**
   * Feed the emitter's current position: the head point follows the emitter every frame and is
   * committed (plus evenly spaced sub-samples) once it is RIBBON_SPACING away from the previous
   * committed point. A jump larger than the teleport threshold restarts the ribbon.
   */
  private ribbonEmit(e: number, x: number, y: number, z: number): void {
    // A NaN / absurd emitter position would become a NaN vertex (and a NaN fragment): emit nothing.
    if (!(Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e7)) return;
    const pts = this.rbPts;
    const base = e * RIBBON_CAP;
    let count = this.rbCount[e];
    if (count === 0) {
      this.ribbonPush(e, x, y, z, 0);
      this.ribbonPush(e, x, y, z, 0);
      return;
    }
    const hi = (base + this.rbHead[e]) * 4;
    const tx = x - pts[hi];
    const ty = y - pts[hi + 1];
    const tz = z - pts[hi + 2];
    if (tx * tx + ty * ty + tz * tz > EMIT_TELEPORT_SQ) {
      this.rbCount[e] = 0;
      this.ribbonPush(e, x, y, z, 0);
      this.ribbonPush(e, x, y, z, 0);
      return;
    }
    if (count === 1) {
      this.ribbonPush(e, x, y, z, 0);
      count = 2;
    }
    const prevIdx = (this.rbHead[e] - 1 + RIBBON_CAP) % RIBBON_CAP;
    const pi = (base + prevIdx) * 4;
    const dx = x - pts[pi];
    const dy = y - pts[pi + 1];
    const dz = z - pts[pi + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > RIBBON_SPACING) {
      const nSub = Math.min(RIBBON_MAX_SUB, Math.floor(d / RIBBON_SPACING));
      const prevAge = pts[pi + 3];
      for (let k = 1; k <= nSub; k++) {
        const f = (k * RIBBON_SPACING) / d;
        const sx = pts[pi] + dx * f;
        const sy = pts[pi + 1] + dy * f;
        const sz = pts[pi + 2] + dz * f;
        const age = prevAge * (1 - f);
        if (k === 1) {
          // Replace the following head with the first committed sample.
          const h = (base + this.rbHead[e]) * 4;
          pts[h] = sx;
          pts[h + 1] = sy;
          pts[h + 2] = sz;
          pts[h + 3] = age;
        } else {
          this.ribbonPush(e, sx, sy, sz, age);
        }
      }
      this.ribbonPush(e, x, y, z, 0);
    } else {
      const h = (base + this.rbHead[e]) * 4;
      pts[h] = x;
      pts[h + 1] = y;
      pts[h + 2] = z;
      pts[h + 3] = 0;
    }
  }

  /** Age every ribbon point and drop expired ones from the tail. */
  private ribbonAge(dt: number): void {
    if (dt <= 0) return;
    const pts = this.rbPts;
    for (let e = 0; e < RIBBON_EMITTERS; e++) {
      let count = this.rbCount[e];
      if (count === 0) continue;
      const base = e * RIBBON_CAP;
      const head = this.rbHead[e];
      const life = this.rbLife[e];
      let tail = (head - count + 1 + RIBBON_CAP) % RIBBON_CAP;
      for (let i = 0; i < count; i++) {
        const idx = (base + ((tail + i) % RIBBON_CAP)) * 4 + 3;
        pts[idx] += dt;
      }
      while (count > 0 && pts[(base + tail) * 4 + 3] >= life) {
        count--;
        tail = (tail + 1) % RIBBON_CAP;
      }
      this.rbCount[e] = count;
    }
  }

  /**
   * Write the ribbon vertex blocks (dead slots collapse onto the newest point with zero width).
   * Only the blocks written this frame (live emitters and emitters that just died) are uploaded:
   * one update range per run of consecutive dirty blocks, so a boosting car (two jets) plus the
   * ball ribbon upload three 48-point blocks instead of the whole 33-block buffer.
   */
  private ribbonBuild(): void {
    const pts = this.rbPts;
    const pos = this.rbPos;
    const tan = this.rbTan;
    const side = this.rbSide;
    const fade = this.rbFade;
    const col = this.rbCol;
    let any = false;
    let dirty = false;
    let runStart = 0; // first emitter of the current run of dirty blocks
    let runEnd = 0; // one past its last emitter
    for (let e = 0; e < RIBBON_EMITTERS; e++) {
      const count = this.rbCount[e];
      const vb = e * RIBBON_CAP * 2;
      if (count === 0 && this.rbPrevCount[e] === 0) continue; // untouched block: nothing to upload
      // Dirty block: extend the current run of dirty blocks or flush it and start a new one.
      if (dirty && runEnd === e) runEnd = e + 1;
      else {
        if (dirty) this.ribbonAddRange(runStart, runEnd);
        runStart = e;
        runEnd = e + 1;
      }
      dirty = true;
      if (count === 0) {
        // The emitter just died: collapse its block (zero width, zero fade) once.
        for (let i = 0; i < RIBBON_CAP * 2; i++) {
          side[vb + i] = 0;
          fade[vb + i] = 0;
        }
        this.rbPrevCount[e] = 0;
        continue;
      }
      any = true;
      this.rbPrevCount[e] = count;
      const base = e * RIBBON_CAP;
      const head = this.rbHead[e];
      const tail = (head - count + 1 + RIBBON_CAP) % RIBBON_CAP;
      const invLife = 1 / this.rbLife[e];
      const w0 = this.rbWidth[e];
      const cr = this.rbColor[e * 3];
      const cg = this.rbColor[e * 3 + 1];
      const cb = this.rbColor[e * 3 + 2];
      for (let i = 0; i < count; i++) {
        const pi = (base + ((tail + i) % RIBBON_CAP)) * 4;
        const pa = (base + ((tail + (i > 0 ? i - 1 : 0)) % RIBBON_CAP)) * 4;
        const pb = (base + ((tail + (i < count - 1 ? i + 1 : i)) % RIBBON_CAP)) * 4;
        let tx = pts[pb] - pts[pa];
        let ty = pts[pb + 1] - pts[pa + 1];
        let tz = pts[pb + 2] - pts[pa + 2];
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (tl > 1e-4) {
          tx /= tl;
          ty /= tl;
          tz /= tl;
        } else {
          tx = 1;
          ty = 0;
          tz = 0;
        }
        const f = Math.max(0, 1 - pts[pi + 3] * invLife);
        const w = w0 * f;
        const v0 = vb + i * 2;
        const v1 = v0 + 1;
        const o0 = v0 * 3;
        const o1 = v1 * 3;
        pos[o0] = pts[pi];
        pos[o0 + 1] = pts[pi + 1];
        pos[o0 + 2] = pts[pi + 2];
        pos[o1] = pts[pi];
        pos[o1 + 1] = pts[pi + 1];
        pos[o1 + 2] = pts[pi + 2];
        tan[o0] = tx;
        tan[o0 + 1] = ty;
        tan[o0 + 2] = tz;
        tan[o1] = tx;
        tan[o1 + 1] = ty;
        tan[o1 + 2] = tz;
        side[v0] = w;
        side[v1] = -w;
        fade[v0] = f;
        fade[v1] = f;
        col[o0] = cr;
        col[o0 + 1] = cg;
        col[o0 + 2] = cb;
        col[o1] = cr;
        col[o1 + 1] = cg;
        col[o1 + 2] = cb;
      }
      // Unused slots: collapse onto the head so the bridging quad is degenerate.
      const hp = (base + head) * 4;
      for (let i = count; i < RIBBON_CAP; i++) {
        const v0 = vb + i * 2;
        const o0 = v0 * 3;
        pos[o0] = pts[hp];
        pos[o0 + 1] = pts[hp + 1];
        pos[o0 + 2] = pts[hp + 2];
        pos[o0 + 3] = pts[hp];
        pos[o0 + 4] = pts[hp + 1];
        pos[o0 + 5] = pts[hp + 2];
        side[v0] = 0;
        side[v0 + 1] = 0;
        fade[v0] = 0;
        fade[v0 + 1] = 0;
      }
    }
    this.ribbon.visible = any;
    if (dirty) {
      this.ribbonAddRange(runStart, runEnd);
      this.rbPosAttr.needsUpdate = true;
      this.rbTanAttr.needsUpdate = true;
      this.rbSideAttr.needsUpdate = true;
      this.rbFadeAttr.needsUpdate = true;
      this.rbColAttr.needsUpdate = true;
    }
  }

  /**
   * Queue the upload of emitter blocks [from, to) on the five ribbon attributes. Ranges accumulate
   * until the renderer consumes them (it clears the list after the upload), so a frame that is not
   * rendered keeps its blocks queued for the next one.
   */
  private ribbonAddRange(from: number, to: number): void {
    const v0 = from * RIBBON_CAP * 2;
    const nv = (to - from) * RIBBON_CAP * 2;
    this.rbPosAttr.addUpdateRange(v0 * 3, nv * 3);
    this.rbTanAttr.addUpdateRange(v0 * 3, nv * 3);
    this.rbColAttr.addUpdateRange(v0 * 3, nv * 3);
    this.rbSideAttr.addUpdateRange(v0, nv);
    this.rbFadeAttr.addUpdateRange(v0, nv);
  }

  // ---- rings & flash -------------------------------------------------------------------------

  /**
   * Start a ring in slot `i` at `p` (three coords) with its normal along `normal` (null = +z, the
   * goal plane), expanding from s0 to s1 over `dur` seconds after `delay`.
   */
  private startRing(
    i: number,
    p: THREE.Vector3,
    normal: THREE.Vector3 | null,
    s0: number,
    s1: number,
    dur: number,
    delay: number,
    r: number,
    g: number,
    b: number,
    k: number,
  ): void {
    this.ringT[i] = 0;
    this.ringDelay[i] = delay;
    this.ringDur[i] = dur;
    this.ringS0[i] = s0;
    this.ringS1[i] = s1;
    this.ringK[i] = k;
    this.ringPos[i * 3] = p.x;
    this.ringPos[i * 3 + 1] = p.y;
    this.ringPos[i * 3 + 2] = p.z;
    this.ringCol[i * 3] = r;
    this.ringCol[i * 3 + 1] = g;
    this.ringCol[i * 3 + 2] = b;
    if (normal === null) this.ringQuat[i].identity();
    else this.ringQuat[i].setFromUnitVectors(_zAxis, normal);
  }

  private updateRings(dt: number): void {
    let n = 0;
    for (let i = 0; i < RING_SLOTS; i++) {
      if (this.ringT[i] < 0) continue;
      if (this.ringDelay[i] > 0) {
        this.ringDelay[i] -= dt;
        if (this.ringDelay[i] > 0) continue;
      }
      this.ringT[i] += dt;
      const t = this.ringT[i] / this.ringDur[i];
      if (t >= 1) {
        this.ringT[i] = -1;
        continue;
      }
      const te = 1 - (1 - t) * (1 - t);
      const s = this.ringS0[i] + (this.ringS1[i] - this.ringS0[i]) * te;
      const op = Math.pow(1 - t, 1.5) * this.ringK[i];
      _p.set(this.ringPos[i * 3], this.ringPos[i * 3 + 1], this.ringPos[i * 3 + 2]);
      _s.set(s, s, 1);
      _m.compose(_p, this.ringQuat[i], _s);
      this.rings.setMatrixAt(n, _m);
      _c.setRGB(this.ringCol[i * 3] * op, this.ringCol[i * 3 + 1] * op, this.ringCol[i * 3 + 2] * op);
      this.rings.setColorAt(n, _c);
      n++;
    }
    this.rings.count = n;
    this.rings.visible = n > 0;
    if (n > 0) {
      const im = this.rings.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, n * 16);
      im.needsUpdate = true;
      const ic = this.rings.instanceColor;
      if (ic !== null) {
        ic.clearUpdateRanges();
        ic.addUpdateRange(0, n * 3);
        ic.needsUpdate = true;
      }
    }
  }

  private updateFlash(dt: number): void {
    if (this.flashT < 0) return;
    this.flashT += dt;
    const ft = this.flashT / GOAL_FLASH_DURATION;
    if (ft >= 1) {
      this.flash.visible = false;
      this.flashT = -1;
      return;
    }
    const te = 1 - (1 - ft) * (1 - ft);
    this.flash.scale.setScalar(FLASH_SCALE_0 + (FLASH_SCALE_1 - FLASH_SCALE_0) * te);
    this.flashMat.opacity = 0.8 * (1 - ft) * (1 - ft);
  }

  private updateDemoFlash(dt: number): void {
    if (this.demoFlashT < 0) return;
    this.demoFlashT += dt;
    const ft = this.demoFlashT / DEMO_FLASH_DURATION;
    if (ft >= 1) {
      this.demoFlash.visible = false;
      this.demoFlashT = -1;
      return;
    }
    const te = 1 - (1 - ft) * (1 - ft);
    this.demoFlash.scale.setScalar(DEMO_FLASH_SCALE_0 + (DEMO_FLASH_SCALE_1 - DEMO_FLASH_SCALE_0) * te);
    this.demoFlashMat.opacity = 0.45 * (1 - ft) * (1 - ft);
  }

  // ---- pool --------------------------------------------------------------------------------

  /**
   * Radial burst of `count` particles. `sparkLen` > 0 stretches particles: with `axisMode` 0 odd
   * particles become sparks along their velocity; with `axisMode` 1 every particle becomes a flake
   * stretched along a random axis. (bvx, bvy, bvz) is added to every particle's velocity.
   */
  private burst(
    x: number,
    y: number,
    z: number,
    count: number,
    r: number,
    g: number,
    b: number,
    vMin: number,
    vMax: number,
    upBias: number,
    sMin: number,
    sMax: number,
    lMin: number,
    lMax: number,
    grav: number,
    drag: number,
    sparkLen: number,
    axisMode: 0 | 1,
    bvx = 0,
    bvy = 0,
    bvz = 0,
  ): void {
    for (let i = 0; i < count; i++) {
      const zz = Math.random() * 2 - 1;
      const phi = Math.random() * TWO_PI;
      const rr = Math.sqrt(1 - zz * zz);
      let dx = rr * Math.cos(phi);
      let dy = zz + upBias;
      let dz = rr * Math.sin(phi);
      const il = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
      dx *= il;
      dy *= il;
      dz *= il;
      const sp = vMin + Math.random() * (vMax - vMin);
      let ax = dx;
      let ay = dy;
      let az = dz;
      let len = 0;
      if (sparkLen > 0) {
        if (axisMode === 1) {
          const az2 = Math.random() * 2 - 1;
          const ph2 = Math.random() * TWO_PI;
          const rr2 = Math.sqrt(1 - az2 * az2);
          ax = rr2 * Math.cos(ph2);
          ay = az2;
          az = rr2 * Math.sin(ph2);
          len = sparkLen;
        } else if ((i & 1) === 1) {
          len = sparkLen;
        }
      }
      this.spawn(
        x,
        y,
        z,
        dx * sp + bvx,
        dy * sp + bvy,
        dz * sp + bvz,
        r,
        g,
        b,
        sMin + Math.random() * (sMax - sMin),
        lMin + Math.random() * (lMax - lMin),
        len,
        ax,
        ay,
        az,
        grav,
        drag,
      );
    }
  }

  /** Copy every per-particle field from slot `from` to slot `to`. */
  private copyParticle(from: number, to: number): void {
    const f3 = from * 3;
    const t3 = to * 3;
    this.pos[t3] = this.pos[f3];
    this.pos[t3 + 1] = this.pos[f3 + 1];
    this.pos[t3 + 2] = this.pos[f3 + 2];
    this.vel[t3] = this.vel[f3];
    this.vel[t3 + 1] = this.vel[f3 + 1];
    this.vel[t3 + 2] = this.vel[f3 + 2];
    this.axis[t3] = this.axis[f3];
    this.axis[t3 + 1] = this.axis[f3 + 1];
    this.axis[t3 + 2] = this.axis[f3 + 2];
    this.col[t3] = this.col[f3];
    this.col[t3 + 1] = this.col[f3 + 1];
    this.col[t3 + 2] = this.col[f3 + 2];
    this.life[to] = this.life[from];
    this.invLife[to] = this.invLife[from];
    this.size[to] = this.size[from];
    this.len[to] = this.len[from];
    this.grav[to] = this.grav[from];
    this.drag[to] = this.drag[from];
  }

  /** Take a free pool slot (or overwrite a live particle round-robin when the pool is full). */
  private spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    r: number,
    g: number,
    b: number,
    size: number,
    life: number,
    len: number,
    ax: number,
    ay: number,
    az: number,
    grav: number,
    drag: number,
  ): void {
    let i: number;
    if (this.alive < this.n) {
      i = this.alive++;
    } else {
      i = this.next;
      this.next = i + 1 >= this.n ? 0 : i + 1;
    }
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.axis[i3] = ax;
    this.axis[i3 + 1] = ay;
    this.axis[i3 + 2] = az;
    this.col[i3] = r;
    this.col[i3 + 1] = g;
    this.col[i3 + 2] = b;
    this.size[i] = size;
    this.life[i] = life;
    this.invLife[i] = 1 / life;
    this.len[i] = len;
    this.grav[i] = grav;
    this.drag[i] = drag;
  }

  /**
   * Age, integrate and write every live particle into the instance matrix/colour arrays. Dead
   * particles are swap-removed from the live range so `mesh.count` only covers live instances,
   * and only that live prefix is uploaded (update ranges; the attributes are DynamicDrawUsage so
   * the renderer re-uploads them every frame the mesh is visible).
   */
  private simulate(dt: number): void {
    const m = this.matArr;
    const c = this.colArr;
    const pos = this.pos;
    const vel = this.vel;
    const axis = this.axis;
    const col = this.col;
    let alive = this.alive;
    let i = 0;
    const cam = this.capCamera;
    const cx = cam !== null ? cam.position.x : 0;
    const cy = cam !== null ? cam.position.y : 0;
    const cz = cam !== null ? cam.position.z : 0;
    while (i < alive) {
      const l = this.life[i] - dt;
      if (l <= 0) {
        alive--;
        if (i !== alive) this.copyParticle(alive, i);
        continue; // slot i now holds the former last particle: process it next
      }
      this.life[i] = l;
      const o = i * 16;
      const i3 = i * 3;

      // Integrate.
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      let vx = vel[i3] * damp;
      let vy = (vel[i3 + 1] - GRAVITY * this.grav[i] * dt) * damp;
      let vz = vel[i3 + 2] * damp;
      const px = pos[i3] + vx * dt;
      let py = pos[i3 + 1] + vy * dt;
      const pz = pos[i3 + 2] + vz * dt;
      const fade = l * this.invLife[i];
      let s = this.size[i] * (0.35 + 0.65 * fade);
      // Super low: never a big blob in front of the camera (one additive layer over the screen).
      let cap = Infinity;
      if (cam !== null) {
        const dx = pos[i3] - cx;
        const dy = pos[i3 + 1] - cy;
        const dz = pos[i3 + 2] - cz;
        cap = Math.sqrt(dx * dx + dy * dy + dz * dz) * SCREEN_CAP;
        if (s > cap) s = cap;
      }
      if (py < s) {
        // Floor bounce.
        py = s;
        if (vy < 0) vy = -vy * 0.3;
        vx *= 0.8;
        vz *= 0.8;
      }
      vel[i3] = vx;
      vel[i3 + 1] = vy;
      vel[i3 + 2] = vz;
      pos[i3] = px;
      pos[i3 + 1] = py;
      pos[i3 + 2] = pz;

      // Matrix: sphere, or ellipsoid with semi-axes (len, s, s) along `axis`.
      const len = this.len[i];
      if (len > 0) {
        const ax = axis[i3];
        const ay = axis[i3 + 1];
        const az = axis[i3 + 2];
        let ux: number;
        let uy: number;
        let uz: number;
        if (ay < 0.9 && ay > -0.9) {
          // axis x up
          ux = az;
          uy = 0;
          uz = -ax;
        } else {
          // axis x right
          ux = 0;
          uy = az;
          uz = -ay;
        }
        const ul = 1 / Math.max(1e-6, Math.sqrt(ux * ux + uy * uy + uz * uz));
        ux *= ul;
        uy *= ul;
        uz *= ul;
        const wx = ay * uz - az * uy;
        const wy = az * ux - ax * uz;
        const wz = ax * uy - ay * ux;
        const L = Math.min(len * (0.5 + 0.5 * fade), cap * 3);
        m[o] = ax * L;
        m[o + 1] = ay * L;
        m[o + 2] = az * L;
        m[o + 4] = ux * s;
        m[o + 5] = uy * s;
        m[o + 6] = uz * s;
        m[o + 8] = wx * s;
        m[o + 9] = wy * s;
        m[o + 10] = wz * s;
      } else {
        m[o] = s;
        m[o + 1] = 0;
        m[o + 2] = 0;
        m[o + 4] = 0;
        m[o + 5] = s;
        m[o + 6] = 0;
        m[o + 8] = 0;
        m[o + 9] = 0;
        m[o + 10] = s;
      }
      m[o + 12] = px;
      m[o + 13] = py;
      m[o + 14] = pz;

      const f = fade * fade * (3 - 2 * fade);
      c[i3] = col[i3] * f;
      c[i3 + 1] = col[i3 + 1] * f;
      c[i3 + 2] = col[i3 + 2] * f;
      i++;
    }
    this.alive = alive;
    this.mesh.count = alive;
    this.mesh.visible = alive > 0;
    if (alive > 0) {
      // Only the live prefix changed: restrict the upload to it (PERF-10).
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, alive * 16);
      im.needsUpdate = true;
      const ic = this.mesh.instanceColor;
      if (ic !== null) {
        ic.clearUpdateRanges();
        ic.addUpdateRange(0, alive * 3);
        ic.needsUpdate = true;
      }
    }
  }
}

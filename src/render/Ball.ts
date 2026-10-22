/**
 * Procedural ball for the three.js WebGPU renderer.
 *
 * - Sphere of BALL.visualRadius with a TSL material: the Turbogol match ball, a stitched panel
 *   ball. Its 32 panels are the faces of a truncated icosahedron projected onto the sphere: 20
 *   pearl hexagons and 12 graphite pentagons, each pentagon carrying a glowing brand-lime ring.
 *   Panels are pillowed (bent normals rising from the seams), the seams are dark grooves with
 *   stitches beside them, and a little wear (scuffs, faint grass stains) breaks the gloss.
 *   Everything is analytic in the local normal (no textures, no seams in the mesh), so the panel
 *   pattern turns with the ball and the spin reads from any side. Colours: BALL_COLORS.
 * - Rotation is integrated locally from B_ANG_VEL each frame (RocketSim's noBallRot leaves B_ROT
 *   constant by default, so the sim rotation cannot be trusted for visuals).
 * - Ground blob: a soft dark disc on the floor under the ball, always visible (the main depth
 *   cue), fading and growing with height.
 * - Ground marker: a flat additive ring on the floor under the ball that fades in with height.
 *
 * Draw calls: ball 1 + blob 1 + marker 1 (only while airborne). No per-frame allocations.
 */
import * as THREE from 'three/webgpu';
import {
  cross,
  dot,
  float,
  fract,
  fwidth,
  length,
  max,
  mix,
  normalLocal,
  normalView,
  normalize,
  positionViewDirection,
  smoothstep,
  step,
  transformNormalToView,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import { B_ANG_VEL, B_POS, BALL_OFFSET } from '../sim/types';
import { BALL } from '../sim/constants';
import { simVecLerpFromBuf } from './coords';
import {
  BRAND_LIME,
  OpaqueAlbedoPhysicalMaterial,
  linearVec3,
  noGlowMrt,
  resolvedFade,
  thinLineMask,
  valueNoise3,
  type FloatNode,
  type Vec3Node,
} from './materials';
import { tier, type Quality } from './quality';

/**
 * The match ball's colourway (sRGB hex). Restyle the ball here: the shader reads nothing else.
 * Keep `glow` the brand lime (the ball's brand cue) and the pentagons clearly darker than the
 * hexagons, which is what makes the spin readable.
 */
export const BALL_COLORS = {
  /** The 20 hexagon panels: pearl white. */
  hexagon: 0xe9ebe5,
  /** The 12 pentagon panels: graphite. */
  pentagon: 0x2b3039,
  /** The grooves between panels. */
  seam: 0x0e1013,
  /** Stitch dashes along the grooves. */
  stitch: 0x8a8f96,
  /** The glowing ring inset in every pentagon (blooms on tiers with bloom). */
  glow: BRAND_LIME,
  /** Grass stain tint (multiplied into the hexagons where the wear noise says so). */
  stain: 0xc9d3a8,
} as const;

/** Golden ratio: the icosahedron's coordinates. */
const PHI = (1 + Math.sqrt(5)) / 2;
/**
 * Truncated icosahedron face planes: hexagons lie at 1.51152 and pentagons at 1.55163 from the
 * centre (the icosahedron's edges cut at thirds). A direction belongs to the face whose plane it
 * meets first (largest dot(n, c) / distance), so pentagon scores get this weight (hexagon
 * distance / pentagon distance); tests/car-ball-materials.test.mjs checks it against the
 * polyhedron.
 */
export const BALL_PENT_WEIGHT = 0.9741542;
/** Seam groove half width (radians on the unit sphere) and the stitches just outside it. */
const SEAM_HALF = 0.011;
const STITCH_OFFSET = 0.019;
const STITCH_HALF = 0.0035;
/** Stitches per radian along a seam, and the dash duty (fraction of a period that is thread). */
const STITCH_PER_RAD = 60;
const STITCH_DUTY = 0.45;
/**
 * Pillow: panels curve down into the seam over this many radians, the normal tilting toward the
 * seam by up to PILLOW_TILT there and easing to none inside the panel ((1 - t)^2, no crease).
 */
const PILLOW = 0.085;
const PILLOW_TILT = 0.3;
/** Lime ring in each pentagon: radius and half width (chord length on the unit sphere). */
const RING_R = 0.15;
const RING_HALF = 0.024;
/** Emissive multiplier of the lime ring (blooms on high; HDR colour alone on low). */
const RING_GLOW = 1.6;
/** prev→cur jumps longer than this are teleports (goal reset): snap instead of lerp. */
const TELEPORT_DIST_SQ = 500 * 500;
/** Marker fades in between these heights above the floor (uu, ball bottom). */
const MARKER_FADE_LO = 40;
const MARKER_FADE_HI = 450;
const MARKER_MAX_OPACITY = 0.6;
/** Marker ring thickness (uu). */
const MARKER_THICKNESS = 6;
/** Blob shadow: opacity/scale at rest and at BLOB_MAX_HEIGHT (uu, ball bottom). */
const BLOB_OPACITY_LO = 0.55;
const BLOB_OPACITY_HI = 0.15;
const BLOB_SCALE_HI = 1.6;
const BLOB_MAX_HEIGHT = 1500;
/**
 * Height (uu) of the ground blob and the airborne marker above the floor: just above the turf, and
 * above the grass blades (up to ~5 uu) on tiers with `grassBlades`, which would speckle them.
 */
const GROUND_Y = 0.8;
const GROUND_Y_BLADES = 6;

const _dq = new THREE.Quaternion();

type Vec3Tuple = [number, number, number];

function unit(x: number, y: number, z: number): Vec3Tuple {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

/**
 * Unit face normals of the truncated icosahedron: the 12 pentagons are the icosahedron's vertices
 * (cyclic permutations of (0, +-1, +-phi)), the 20 hexagons its face centres: (+-1, +-1, +-1) and
 * the cyclic permutations of (0, +-phi, +-1/phi). The cyclic order matters: the other chirality,
 * (0, +-1/phi, +-phi), is not a face of this icosahedron and gives irregular panels.
 */
export function ballPanelCentres(): { pent: Vec3Tuple[]; hex: Vec3Tuple[] } {
  const pent: Vec3Tuple[] = [];
  const hex: Vec3Tuple[] = [];
  for (const a of [-1, 1]) {
    for (const b of [-1, 1]) {
      pent.push(unit(0, a, b * PHI), unit(a, b * PHI, 0), unit(b * PHI, 0, a));
      hex.push(unit(0, a * PHI, b / PHI), unit(b / PHI, 0, a * PHI), unit(a * PHI, b / PHI, 0));
      for (const c of [-1, 1]) hex.push(unit(a, b, c));
    }
  }
  return { pent, hex };
}

/**
 * The faces the shader searches after folding the normal into the positive octant (abs): the
 * panel layout is symmetric under every coordinate sign flip, so the 7 faces with non-negative
 * coordinates stand for all 32. Three hexagon pairs are neighbours across a coordinate plane
 * (mirror images of each other), so those mirrors join the list as runner-up candidates: with
 * them the folded search finds the same face and the same runner-up as the full one wherever a
 * seam is near (tests/car-ball-materials.test.mjs checks that against the 32-face search).
 */
export function ballFoldedPanels(): { c: Vec3Tuple; pent: boolean }[] {
  return [
    { c: unit(0, 1, PHI), pent: true },
    { c: unit(1, PHI, 0), pent: true },
    { c: unit(PHI, 0, 1), pent: true },
    { c: unit(1, 1, 1), pent: false },
    { c: unit(0, PHI, 1 / PHI), pent: false },
    { c: unit(1 / PHI, 0, PHI), pent: false },
    { c: unit(PHI, 1 / PHI, 0), pent: false },
    { c: unit(0, PHI, -1 / PHI), pent: false },
    { c: unit(-1 / PHI, 0, PHI), pent: false },
    { c: unit(PHI, -1 / PHI, 0), pent: false },
  ];
}

/**
 * The match-ball material (see the file header). The normal is folded into the positive octant
 * and the 10 candidate faces of ballFoldedPanels are walked once in straight-line code: best and
 * runner-up weighted scores and centres. Their score gap over its gradient is the distance to the
 * seam in radians, which drives the groove, the stitches and the pillow; the chord to the
 * pentagon centre draws the lime ring. Everything but the pillow tilt is symmetric, so it is
 * computed in the folded frame; the tilt is unfolded by the normal's signs. Every line goes
 * through thinLineMask, so seams and rings fade to their average at distance instead of crawling.
 * `hi` false (detail 'low') drops the pillow normal, the grass stains and two wear octaves.
 * `cheap` (TierSpec.cheapMaterials, super low): Lambert with the same panels, seams, stitches and
 * lime rings, no wear noise, no specular or environment.
 * Per pixel: 10 dot / mix steps and 0 (super low), 1 (low) or 4 (high) value-noise lookups; only
 * the ball's pixels pay.
 */
function createBallMaterial(hi: boolean, cheap = false): THREE.MeshPhysicalNodeMaterial | THREE.MeshLambertNodeMaterial {
  const n = normalize(normalLocal);
  const f = n.abs(); // folded into the positive octant
  const signs = step(0.0, n).mul(2.0).sub(1.0); // unfolds a folded-frame vector (+1 on the planes)

  let best: FloatNode = float(-2.0);
  let second: FloatNode = float(-2.0);
  let bestW: Vec3Node = vec3(0.0, 1.0, 0.0); // weighted centre (unit centre x its face weight)
  let secondW: Vec3Node = vec3(1.0, 0.0, 0.0);
  let isPent: FloatNode = float(0.0);
  // Arithmetic (step + mix), not select(): TSL emits select() as if / else blocks, and chained
  // steps nest them (32 of them passed WGSL's statement depth limit of 127). Each step here is one
  // flat statement per variable.
  for (const { c, pent } of ballFoldedPanels()) {
    const w = pent ? BALL_PENT_WEIGHT : 1;
    const cw = vec3(c[0] * w, c[1] * w, c[2] * w);
    const sc = dot(f, cw).toVar();
    const wins = step(best, sc).toVar(); // 1 when this face beats the best so far
    const beatsSecond = step(second, sc);
    secondW = mix(mix(secondW, cw, beatsSecond), bestW, wins).toVar();
    second = mix(max(second, sc), best, wins).toVar();
    isPent = mix(isPent, float(pent ? 1 : 0), wins).toVar();
    bestW = mix(bestW, cw, wins).toVar();
    best = max(best, sc).toVar();
  }

  // Distance to the seam (radians): the score gap over the gap's tangential gradient.
  const g = bestW.sub(secondW);
  const gTan = g.sub(f.mul(dot(f, g)));
  const d = best.sub(second).div(length(gTan).max(1e-4));
  const groove = thinLineMask(d, SEAM_HALF);
  // Stitches: dashes along the seam, in a thin band on the panel side of the groove.
  const along = dot(f, normalize(cross(bestW, secondW)));
  const dashD = fract(along.mul(STITCH_PER_RAD)).sub(0.5);
  const dashFw = fwidth(along.mul(STITCH_PER_RAD)); // the continuous coordinate: no line at the wrap
  const dash = thinLineMask(dashD, STITCH_DUTY * 0.5, dashFw).mul(resolvedFade(along.mul(STITCH_PER_RAD)));
  const stitch = dash.mul(thinLineMask(d.sub(STITCH_OFFSET), STITCH_HALF));
  // Lime ring around each pentagon centre (chord distance from the unit centre).
  const centre = bestW.div(mix(float(1.0), float(BALL_PENT_WEIGHT), isPent));
  const ring = thinLineMask(length(f.sub(centre)).sub(RING_R), RING_HALF).mul(isPent);

  // Wear in the ball's own (unfolded) frame: scuffs (rougher, a touch darker), faint grass stains.
  // Three octaves (lacunarity 2, gain 0.5) on high, the first one alone on low, none when cheap.
  let wear: FloatNode = cheap ? float(0.0) : valueNoise3(n.mul(5.0));
  if (hi) wear = wear.add(valueNoise3(n.mul(10.0)).mul(0.5)).add(valueNoise3(n.mul(20.0)).mul(0.25));
  const scuff = cheap ? float(0.0) : smoothstep(0.2, 0.7, wear);
  const stain: FloatNode = hi ? smoothstep(0.5, 0.85, valueNoise3(n.mul(2.3).add(7.1))) : float(0.0);

  const ink = linearVec3(BALL_COLORS.pentagon);
  let panel: Vec3Node = mix(linearVec3(BALL_COLORS.hexagon), ink, isPent);
  panel = mix(panel, panel.mul(linearVec3(BALL_COLORS.stain)), stain.mul(0.55).mul(isPent.oneMinus()));
  panel = panel.mul(scuff.mul(0.12).oneMinus());
  const lime = linearVec3(BALL_COLORS.glow);
  let albedo: Vec3Node = mix(panel, linearVec3(BALL_COLORS.seam), groove);
  albedo = mix(albedo, mix(linearVec3(BALL_COLORS.stitch), panel.mul(0.55), isPent), stitch.mul(0.85));
  albedo = mix(albedo, lime.mul(0.75), ring);
  if (cheap) {
    const lm = new THREE.MeshLambertNodeMaterial();
    lm.colorNode = albedo;
    // NodeMaterial.setupLighting adds any material's emissiveNode (r186 types it on Standard only).
    (lm as unknown as { emissiveNode: unknown }).emissiveNode = lime.mul(ring.mul(RING_GLOW));
    lm.name = 'ball-turbogol-lambert';
    return lm;
  }
  const m = new OpaqueAlbedoPhysicalMaterial();
  m.albedoNode = albedo; // not colorNode: keeps the panel search out of the shadow pipelines
  // A glossy PU skin without a clearcoat (a coat adds a second specular lobe per light for a
  // highlight the low base roughness already gives); scuffs and seams go matte.
  m.roughnessNode = mix(mix(float(0.26), float(0.55), scuff), float(0.78), max(groove, stitch));
  m.metalnessNode = float(0.0);
  const fresnel = normalView.dot(positionViewDirection).saturate().oneMinus().pow(4.0);
  m.emissiveNode = lime.mul(ring.mul(RING_GLOW)).add(panel.mul(fresnel.mul(0.06)));
  if (hi) {
    // Pillow: the panel curves down into the seam; tilt the normal toward the seam (against the
    // gap's gradient, which points into the panel), easing out so the panel has no inner crease.
    const gDir = normalize(gTan.add(f.mul(1e-5))).mul(signs);
    const t = d.div(PILLOW).saturate().oneMinus();
    const slope = t.mul(t).mul(PILLOW_TILT);
    m.normalNode = transformNormalToView(normalize(n.sub(gDir.mul(slope)))).normalize();
  }
  m.name = 'ball-turbogol';
  return m;
}

/** Flat dark disc with a soft radial falloff (opacity from a uniform). */
function createBlobMaterial(): { material: THREE.MeshBasicNodeMaterial; opacity: THREE.UniformNode<'float', number> } {
  const m = new THREE.MeshBasicNodeMaterial();
  m.transparent = true;
  m.blending = THREE.NormalBlending;
  m.depthWrite = false;
  m.fog = false;
  const opacity = uniform(BLOB_OPACITY_LO);
  m.colorNode = vec3(0.0, 0.0, 0.0);
  m.opacityNode = smoothstep(0.35, 1.0, uv().sub(0.5).length().mul(2.0)).oneMinus().mul(opacity);
  m.mrtNode = noGlowMrt(); // an untagged material would overwrite the glow target under the shadow
  m.name = 'ball-blob';
  return { material: m, opacity };
}

function smooth01(x: number, lo: number, hi: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

export class BallView {
  readonly root: THREE.Mesh;
  /** Alias of root.position (interpolated, three.js coords). */
  readonly position: THREE.Vector3;

  private readonly scene: THREE.Scene;
  private readonly material: THREE.MeshPhysicalNodeMaterial | THREE.MeshLambertNodeMaterial;
  private readonly marker: THREE.Mesh;
  private readonly markerMat: THREE.MeshBasicNodeMaterial;
  private readonly blob: THREE.Mesh;
  private readonly blobMat: THREE.MeshBasicNodeMaterial;
  private readonly blobOpacity: THREE.UniformNode<'float', number>;
  private disposed = false;
  /** Marker state to restore after a warm-up render (see setWarmUp). */
  private warmMarker = false;
  private warmMarkerOpacity = 0;

  constructor(scene: THREE.Scene, quality: Quality) {
    this.scene = scene;
    const spec = tier(quality);
    const hi = spec.detail === 'high';
    const groundY = spec.grassBlades ? GROUND_Y_BLADES : GROUND_Y;
    const widthSeg = hi ? 48 : 28;
    const heightSeg = hi ? 32 : 18;
    this.material = createBallMaterial(hi, spec.cheapMaterials);
    this.root = new THREE.Mesh(new THREE.SphereGeometry(BALL.visualRadius, widthSeg, heightSeg), this.material);
    this.root.name = 'ball';
    this.root.castShadow = true;
    this.root.receiveShadow = true;
    this.root.position.set(0, BALL.restZ, 0);
    this.position = this.root.position;
    scene.add(this.root);

    // Ground blob (always visible).
    const blob = createBlobMaterial();
    this.blobMat = blob.material;
    this.blobOpacity = blob.opacity;
    const blobGeo = new THREE.CircleGeometry(BALL.visualRadius * 1.15, 24);
    blobGeo.rotateX(-Math.PI / 2); // lie flat on the floor
    this.blob = new THREE.Mesh(blobGeo, this.blobMat);
    this.blob.name = 'ball-blob';
    this.blob.frustumCulled = false;
    this.blob.renderOrder = 1;
    this.blob.castShadow = false;
    this.blob.receiveShadow = false;
    this.blob.position.y = groundY;
    scene.add(this.blob);

    const ringGeo = new THREE.RingGeometry(BALL.visualRadius - MARKER_THICKNESS, BALL.visualRadius, hi ? 48 : 32, 1);
    ringGeo.rotateX(-Math.PI / 2); // lie flat on the floor
    this.markerMat = new THREE.MeshBasicNodeMaterial();
    this.markerMat.color.setHex(0xffffff);
    this.markerMat.transparent = true;
    this.markerMat.opacity = 0;
    this.markerMat.depthWrite = false;
    this.markerMat.blending = THREE.AdditiveBlending;
    this.markerMat.side = THREE.DoubleSide;
    this.markerMat.fog = false;
    this.markerMat.mrtNode = noGlowMrt(); // a plain white ring: must neither bloom nor erase glow
    // Cheap tiers: additive, one pass instead of the back-then-front pair (a pipeline less).
    this.markerMat.forceSinglePass = spec.cheapMaterials;
    this.markerMat.name = 'ball-marker';
    this.marker = new THREE.Mesh(ringGeo, this.markerMat);
    this.marker.name = 'ball-marker';
    this.marker.visible = false;
    this.marker.renderOrder = 2;
    this.marker.position.y = groundY + 0.2;
    scene.add(this.marker);
  }

  /** Interpolate between two full state buffers (ball at BALL_OFFSET) and spin the ball. */
  update(prev: Float32Array, cur: Float32Array, alpha: number, dt: number): void {
    const p = BALL_OFFSET + B_POS;
    const dx = cur[p] - prev[p];
    const dy = cur[p + 1] - prev[p + 1];
    const dz = cur[p + 2] - prev[p + 2];
    const a = dx * dx + dy * dy + dz * dz > TELEPORT_DIST_SQ ? 1 : alpha;
    simVecLerpFromBuf(this.root.position, prev, cur, p, a);

    // Visual spin from the angular velocity. The sim's left-handed coordinates map to three.js with a
    // y/z swap (a reflection), which flips the sense of rotation: ω_three = -(ωx, ωz, ωy).
    const w = BALL_OFFSET + B_ANG_VEL;
    const wx = -cur[w];
    const wy = -cur[w + 2];
    const wz = -cur[w + 1];
    const mag = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (mag > 1e-5 && dt > 0) {
      const half = mag * dt * 0.5;
      const s = Math.sin(half) / mag;
      _dq.set(wx * s, wy * s, wz * s, Math.cos(half));
      this.root.quaternion.premultiply(_dq).normalize();
    }

    // Ground blob: fades and grows with height.
    const height = this.root.position.y - BALL.visualRadius;
    const hk = height > 0 ? Math.min(1, height / BLOB_MAX_HEIGHT) : 0; // NaN-safe: never a NaN blob scale
    this.blob.position.x = this.root.position.x;
    this.blob.position.z = this.root.position.z;
    const bs = 1 + (BLOB_SCALE_HI - 1) * hk;
    this.blob.scale.set(bs, 1, bs);
    this.blobOpacity.value = BLOB_OPACITY_LO + (BLOB_OPACITY_HI - BLOB_OPACITY_LO) * hk;

    // Ground marker under the ball, fading in with height.
    const k = smooth01(height, MARKER_FADE_LO, MARKER_FADE_HI) * MARKER_MAX_OPACITY;
    if (k > 0.01) {
      this.marker.visible = true;
      this.marker.position.x = this.root.position.x;
      this.marker.position.z = this.root.position.z;
      this.markerMat.opacity = k;
    } else {
      this.marker.visible = false;
    }
  }

  /**
   * Pipeline warm-up hook (Game.warmUp): draw the normally hidden ground marker once at zero
   * opacity so its shader compiles before the ball first leaves the floor.
   */
  setWarmUp(on: boolean): void {
    if (on) {
      this.warmMarker = this.marker.visible;
      this.warmMarkerOpacity = this.markerMat.opacity;
      if (!this.marker.visible) {
        this.markerMat.opacity = 0;
        this.marker.visible = true;
      }
    } else {
      this.marker.visible = this.warmMarker;
      this.markerMat.opacity = this.warmMarkerOpacity;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.root);
    this.scene.remove(this.marker);
    this.scene.remove(this.blob);
    this.root.geometry.dispose();
    this.material.dispose();
    this.marker.geometry.dispose();
    this.markerMat.dispose();
    this.blob.geometry.dispose();
    this.blobMat.dispose();
  }
}

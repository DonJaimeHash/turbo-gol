/**
 * Procedural ball for the three.js WebGPU renderer.
 *
 * - Sphere of BALL.visualRadius with a TSL material: the Turbogol match ball. One continuous
 *   seam band wanders around the sphere (the saddle curve z = k (x^2 - y^2) on the unit sphere,
 *   swinging about 43 degrees above and below the equator) and splits it into a white half and a
 *   cool grey half; the band is brand lime, lit (it blooms softly) and outlined in graphite, and a
 *   graphite 'T' monogram sits at the centre of each half. Everything is analytic in the local
 *   normal (no textures, no seams in the mesh), so the spin reads clearly from any side.
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
  color,
  float,
  fwidth,
  min,
  mix,
  normalLocal,
  normalView,
  positionViewDirection,
  select,
  smoothstep,
  step,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { B_ANG_VEL, B_POS, BALL_OFFSET } from '../sim/types';
import { BALL } from '../sim/constants';
import { simVecLerpFromBuf } from './coords';
import { BRAND_LIME, boxSdf, noGlowMrt } from './materials';
import { tier, type Quality } from './quality';

/** Seam surface z = SEAM_K (x^2 - y^2): larger swings the band further from the equator. */
const SEAM_K = 1.3;
/** Band half width and the width of its graphite outline (radians on the unit sphere). */
const BAND_HALF = 0.075;
const BAND_OUTLINE = 0.018;
/** Glow of the lime band (emissive multiplier; the bloom picks it up). */
const BAND_GLOW = 0.5;
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

const _dq = new THREE.Quaternion();

/**
 * The match-ball material. `f = z - k (x^2 - y^2)` of the unit local normal is positive on one
 * half and negative on the other; `f / |grad f|` (the gradient is never shorter than 1, so the
 * division is safe) is a distance to the seam in radians, anti-aliased with fwidth. The
 * monogram is a box-SDF 'T' in the gnomonic tangent plane of each pole (+z on the white half,
 * -z on the grey half, mirrored there so it reads the right way round from outside).
 */
function createBallMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  const n = normalLocal.normalize();
  const f = n.z.sub(n.x.mul(n.x).sub(n.y.mul(n.y)).mul(SEAM_K));
  const grad = vec3(n.x.mul(-2 * SEAM_K), n.y.mul(2 * SEAM_K), 1.0).length();
  const dist = f.div(grad).abs();
  const aa = fwidth(dist).mul(0.75).add(1e-4);
  const band = smoothstep(aa.negate().add(BAND_HALF), aa.add(BAND_HALF), dist).oneMinus();
  const rim = smoothstep(aa.negate().add(BAND_HALF + BAND_OUTLINE), aa.add(BAND_HALF + BAND_OUTLINE), dist).oneMinus().sub(band).saturate();
  const white = step(0.0, f);

  // 'T' at the pole of each half: top bar plus stem, union of two box SDFs.
  const sz = select(n.z.greaterThan(0.0), 1.0, -1.0);
  const p = vec2(n.x.mul(sz), n.y).div(n.z.abs().max(0.3));
  const tSdf = min(boxSdf(p, 0, 0.22, 0.3, 0.08), boxSdf(p, 0, -0.01, 0.085, 0.31));
  const taa = fwidth(tSdf).mul(0.75).add(1e-4);
  const logo = smoothstep(taa.negate(), taa, tSdf).oneMinus().mul(step(0.6, n.z.abs()));

  const ink = color(0x1b2230);
  const lime = color(BRAND_LIME);
  const panel = mix(color(0xb3bcc9), color(0xf3f5f8), white);
  const albedo = mix(mix(mix(panel, ink, logo), ink, rim), lime, band);
  m.colorNode = albedo;
  m.roughnessNode = mix(mix(float(0.38), float(0.5), rim.add(logo).saturate()), float(0.25), band);
  m.metalnessNode = mix(0.1, 0.0, band);
  const fresnel = normalView.dot(positionViewDirection).saturate().oneMinus().pow(4.0);
  m.emissiveNode = lime.mul(band.mul(BAND_GLOW)).add(panel.mul(fresnel.mul(0.08)));
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
  private readonly material: THREE.MeshStandardNodeMaterial;
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
    const hi = tier(quality).detail === 'high';
    const widthSeg = hi ? 48 : 28;
    const heightSeg = hi ? 32 : 18;
    this.material = createBallMaterial();
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
    this.blob.position.y = 0.8;
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
    this.markerMat.name = 'ball-marker';
    this.marker = new THREE.Mesh(ringGeo, this.markerMat);
    this.marker.name = 'ball-marker';
    this.marker.visible = false;
    this.marker.renderOrder = 2;
    this.marker.position.y = 1;
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

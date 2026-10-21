/**
 * Procedural car (body + wheels + boost flame + ground blob) for the three.js WebGPU renderer.
 *
 * The Turbogol "dune runner": a low lofted pod with a bubble canopy, a white roll hoop carrying a
 * four-lamp light bar, wide pontoon arches over all four wheels joined by side pods with a team
 * light strip, a nerf-bar bumper with two fog lamps, and twin round thrusters at the tail (the
 * boost leaves as two plasma jets). Paint is two-tone: team colour above a lime pinstripe, gloss
 * carbon below it, and forward chevrons on the nose. Wheels are knobby off-road tyres on dark
 * six-spoke rims with a light beadlock ring and a team-coloured hub cap.
 *
 * Local frame (three.js): +x forward, +y up, +z right (see coords.ts). The root is placed at the
 * sim car origin (axle height, car rest z = 17 above the floor); the hitbox centre sits at
 * `hitboxOffset` relative to it. Every visible part of the body is built INSIDE the physics
 * hitbox so the visible car never clips through walls (the wheels follow the physics wheels; the
 * rear tyres stand a little proud of the tail, the arches stop at the hitbox).
 *
 * Draw calls per car: body (1 merged geometry) + wheels (1 InstancedMesh, 4 instances) + flame
 * (1, only while boosting / supersonic; both jets, their nozzle discs and the underglow are ONE
 * merged geometry driven by uniforms) + ground blob (1, only while airborne at high detail / when
 * visible at low detail, see TierSpec.detail). Materials: ONE MeshPhysicalNodeMaterial shared by
 * all cars (surface properties live in vertex attributes: `color` = linear base colour, `aMat` =
 * (metalness, roughness, emissive, paintMix); clearcoat, the two-tone split, the pinstripe and the
 * chevrons are derived from them in TSL) plus one additive flame material and one blob material
 * per car.
 *
 * No per-frame allocations: all maths goes through module scratch objects.
 */
import * as THREE from 'three/webgpu';
import {
  attribute,
  color,
  cos,
  diffuseColor,
  float,
  fract,
  mix,
  mx_noise_float,
  normalLocal,
  normalView,
  positionLocal,
  positionViewDirection,
  select,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CarConfigInfo, Team } from '../sim/types';
import {
  C_IS_BOOSTING,
  C_IS_DEMOED,
  C_IS_SUPERSONIC,
  C_POS,
  C_ROT,
  C_VEL,
  C_WHEEL_STEER,
  C_WHEEL_SUSPENSION,
} from '../sim/types';
import { simRotMatToQuat, simVecLerpFromBuf } from './coords';
import { BRAND_LIME, glowMrt, lineMask, linearVec3, noGlowMrt } from './materials';
import { tier, type Quality, type TierSpec } from './quality';

/**
 * Team paint (sRGB hex), indexed by Team (0 blue, 1 red). The blue is the lighter of the two
 * (lit paint L* ~57 vs ~44) so the teams also separate by lightness for colour-blind players.
 */
export const TEAM_PAINT: readonly [number, number] = [0x2a86f0, 0xc8152f];
/** Brighter team tint for flames, light strips, trails and explosions, indexed by Team. */
export const TEAM_GLOW: readonly [number, number] = [0x56b0ff, 0xff3d55];
/** Canopy glass, a dark team tint. */
const TEAM_GLASS: readonly [number, number] = [0x0a1a34, 0x2c0a12];

/**
 * Boost nozzles in car-local three.js coordinates (x forward, y up, z right) for the default
 * hitbox: the twin thrusters sit at (x, y, +-z). Effects.ts emits the boost trails from here.
 */
export const BOOST_NOZZLE_X = -44.3;
export const BOOST_NOZZLE_Y = 19.75;
export const BOOST_NOZZLE_Z = 8;

/** Surface description baked into vertex attributes and read by the shared material. */
interface Surface {
  readonly color: number;
  readonly metal: number;
  readonly rough: number;
  /** Emissive strength (multiplies the base colour; > 1 pushes into bloom). */
  readonly emissive: number;
  /**
   * 0..1 strength of the glossy fresnel rim highlight AND the clearcoat. Exactly 1 marks team
   * paint, which also gets the two-tone split, the pinstripe and the chevrons.
   */
  readonly paint: number;
}

const TRIM: Surface = { color: 0x15181d, metal: 0.15, rough: 0.7, emissive: 0, paint: 0 };
const CAGE: Surface = { color: 0xdfe3ea, metal: 0.5, rough: 0.34, emissive: 0, paint: 0.4 };
const HEADLIGHT: Surface = { color: 0xffffff, metal: 0, rough: 0.4, emissive: 3.0, paint: 0 };
const TAILLIGHT: Surface = { color: 0xff2a1e, metal: 0, rough: 0.4, emissive: 1.8, paint: 0 };
const TYRE: Surface = { color: 0x0c0e11, metal: 0, rough: 0.92, emissive: 0, paint: 0 };
const RIM: Surface = { color: 0xaab0b8, metal: 0.75, rough: 0.32, emissive: 0, paint: 0 }; // gunmetal chrome: fully metallic parts mirrored the red crowd tiers and read pink
const RIM_DARK: Surface = { color: 0x2c313a, metal: 0.65, rough: 0.38, emissive: 0, paint: 0 };
const BEAD: Surface = { color: 0xd3d8e0, metal: 0.55, rough: 0.36, emissive: 0, paint: 0 };
const DISC: Surface = { color: 0x1b1e24, metal: 0.4, rough: 0.6, emissive: 0, paint: 0 };

const TWO_PI = Math.PI * 2;
/** Height of the car origin above the floor at rest (RocketSim CAR_SPAWN_REST_Z), any preset. */
const CAR_REST_Z = 17;
/** Visual suspension travel is clamped to rest +- this (uu). */
const SUSPENSION_CLAMP = 12;
/** prev->cur jumps longer than this are teleports (respawn / kickoff reset): snap instead of lerp. */
const TELEPORT_DIST_SQ = 300 * 300;
/** Wheel (tyre) width in uu. */
const WHEEL_WIDTH = 18;
/** Visual wheel radius over the physics radius (the contact point is kept on the floor). */
const WHEEL_VISUAL = 1.1;
/** Target distance of the outer tyre face from the car centre line (uu), clamped to the hitbox. */
const WHEEL_OUTER = 39;
/** Rim radius in tyre-radius units (the sidewall runs from here to the tread). */
const RIM_R = 0.66;
/** Tyre carcass radius in tyre-radius units; the knobs stand out to 1. */
const TREAD_R = 0.93;
/** Car-local height (uu above the car origin) of the two-tone line: paint above, carbon below. */
const TWO_TONE_Y = 8.75;
/** Half width (uu) of the lime pinstripe on the two-tone line. */
const PINSTRIPE_HALF_W = 0.45;
/** Nose chevrons: car-local x range, half width about the centre line, period along x (uu). */
const CHEVRON_X0 = 38;
const CHEVRON_X1 = 68;
const CHEVRON_HALF_W = 12;
const CHEVRON_PERIOD = 11;
/** Flame (one jet) size at full boost (uu). */
const FLAME_LENGTH = 112;
const FLAME_RADIUS = 7.5;
/** Shock diamonds along a jet. */
const FLAME_DIAMONDS = 4.5;
/** Fraction of the flame colour written to the bloom (glow) target. */
const FLAME_GLOW = 0.6;
/** Underglow quad under the body (uu). */
const GLOW_LENGTH = 90;
const GLOW_WIDTH = 50;
/** Underglow ease rate (1/s). */
const GLOW_RATE = 12;
/** Blob shadow footprint at ground level (uu) and the height over which it fades/grows. */
const BLOB_LENGTH = 70;
const BLOB_WIDTH = 60;
const BLOB_MAX_HEIGHT = 800;

// ---- scratch -------------------------------------------------------------------------------
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _col = new THREE.Color();

// ---- shared material ------------------------------------------------------------------------
let sharedMaterial: THREE.MeshPhysicalNodeMaterial | null = null;
let sharedRefs = 0;

/**
 * One physically based node material for every car part of every car. Base colour, metalness,
 * roughness, emissive, clearcoat and a TSL fresnel highlight are all driven by vertex attributes
 * so a whole car (and its wheels) share a single material. The livery is procedural, on team
 * paint only (paintMix exactly 1): gloss carbon below the two-tone line, a lime pinstripe on the
 * line (slightly emissive so it reads in shadow) and forward-pointing white chevrons on the top
 * of the nose.
 */
function createCarMaterial(): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial();
  const base = attribute('color', 'vec3');
  const surf = attribute('aMat', 'vec4');
  const paintMask = step(0.99, surf.w);
  const p = positionLocal;
  const za = p.z.abs();
  const onNose = step(CHEVRON_X0, p.x).mul(step(p.x, CHEVRON_X1)).mul(step(za, CHEVRON_HALF_W)).mul(step(0.35, normalLocal.y));
  const chevron = step(fract(p.x.add(za.mul(0.9)).div(CHEVRON_PERIOD)), 0.36).mul(onNose).mul(paintMask);
  const lower = step(p.y, TWO_TONE_Y).mul(paintMask);
  const pin = lineMask(p.y.sub(TWO_TONE_Y), PINSTRIPE_HALF_W).mul(paintMask);
  const lime = linearVec3(BRAND_LIME);
  const carbon = linearVec3(0x16181d);
  const albedo = mix(mix(mix(base, carbon, lower), vec3(0.92, 0.93, 0.95), chevron.mul(0.9)), lime, pin);
  const fresnel = normalView.dot(positionViewDirection).saturate().oneMinus().pow(3.0);
  const rim = mix(albedo, vec3(1.0, 1.0, 1.0), 0.55).mul(fresnel.mul(surf.w).mul(0.35));
  m.colorNode = albedo;
  m.metalnessNode = surf.x;
  m.roughnessNode = surf.y;
  m.emissiveNode = base.mul(surf.z).add(rim).add(lime.mul(pin.mul(0.35)));
  m.clearcoatNode = surf.w;
  m.clearcoatRoughnessNode = float(0.08);
  m.name = 'car-surface';
  return m;
}

/**
 * Reference-counted: the material is disposed when the last CarView releases it. A roster change
 * (Game.rebuildCarViews) builds the new views before disposing the old ones so the count never
 * reaches zero in between and the compiled material survives the rebuild.
 */
function acquireCarMaterial(): THREE.MeshPhysicalNodeMaterial {
  if (sharedMaterial === null) sharedMaterial = createCarMaterial();
  sharedRefs++;
  return sharedMaterial;
}

function releaseCarMaterial(): void {
  sharedRefs--;
  if (sharedRefs <= 0 && sharedMaterial !== null) {
    sharedMaterial.dispose();
    sharedMaterial = null;
    sharedRefs = 0;
  }
}

/** Uniforms that drive the merged flame geometry (jets, nozzle discs, underglow). */
interface FlameUniforms {
  readonly len: THREE.UniformNode<'float', number>;
  readonly rad: THREE.UniformNode<'float', number>;
  readonly boostK: THREE.UniformNode<'float', number>;
  readonly intensity: THREE.UniformNode<'float', number>;
}

/**
 * Additive twin plasma jets: per thruster a team-coloured plume with stationary shock diamonds
 * (bright, slightly pinched nodes along the jet) around a team-tinted white core, a hot nozzle
 * ring, plus one team underglow quad under the body (scaled by the `boostK` uniform so it fades
 * without an extra object toggle). Part ids come from `aPart`: 0 plume, 1 core, 2 nozzle disc,
 * 3 underglow; `aJet` (-1 / +1, 0 for the underglow) puts a part on the left or right thruster.
 * Jet / disc vertices are unit sized and scaled by the `len` / `rad` uniforms around the nozzle.
 */
function createFlameMaterial(team: Team, glowCentre: THREE.Vector3, jetZ: number): { material: THREE.MeshBasicNodeMaterial; u: FlameUniforms } {
  const m = new THREE.MeshBasicNodeMaterial();
  m.transparent = true;
  m.blending = THREE.AdditiveBlending;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.fog = false;

  const u: FlameUniforms = {
    len: uniform(FLAME_LENGTH),
    rad: uniform(FLAME_RADIUS),
    boostK: uniform(0),
    intensity: uniform(0),
  };
  const part = attribute('aPart', 'float');
  const jet = attribute('aJet', 'float');
  const isCone = part.lessThan(1.5);
  const isDisc = part.lessThan(2.5);
  // Jets: 1 at the tip, 0 at the base. Saturated because with MSAA (tiers with msaa 4) varyings are
  // interpolated at the pixel centre, which lies OUTSIDE the triangle for partially covered edge
  // pixels: past the tip `uv.y` extrapolates above 1 and pow() of the negative 1 - t is NaN. One
  // NaN texel in the glow target blurs through the bloom mips into a big black rectangle.
  const t = uv().y.saturate();
  // Wrapped clock: keeps the noise / flicker arguments precise after hours of play.
  const clock = time.mod(1000.0);
  const diamondPhase = t.mul(FLAME_DIAMONDS * TWO_PI);

  // Position: radial wobble growing towards the tip (vertex noise, decorrelated per jet) and a
  // slight pinch at every shock diamond; then the jet goes to its thruster.
  const wobble = mx_noise_float(vec3(positionLocal.y.mul(2.2), positionLocal.z.mul(2.2).add(jet.mul(3.7)), t.mul(3.0).sub(clock.mul(7.0))))
    .mul(0.18)
    .mul(t);
  const pinch = cos(diamondPhase).mul(-0.12).mul(t.oneMinus());
  const jetOffset = vec3(0, 0, jet.mul(jetZ));
  const coneP = positionLocal.add(normalLocal.mul(wobble.add(pinch))).mul(vec3(u.len, u.rad, u.rad)).add(jetOffset);
  const discP = positionLocal.mul(u.rad).add(jetOffset);
  const gc = vec3(glowCentre.x, glowCentre.y, glowCentre.z);
  const glowP = positionLocal.sub(gc).mul(u.boostK).add(gc);
  m.positionNode = select(isCone, coneP, select(isDisc, discP, glowP));

  // Colour per part. Every pow() base below is in [0, 1].
  const tint = color(TEAM_GLOW[team]);
  const core = mix(vec3(1.0, 1.0, 1.0), tint, 0.2);
  const flicker = sin(t.mul(16.0).sub(clock.mul(40.0))).mul(0.12).add(0.88);
  // |n . v| is in [0, 1] for unit vectors; the saturate also maps a NaN (degenerate normal) to 0.
  const edgeSoft = normalView.dot(positionViewDirection).abs().saturate().pow(0.8);
  const fadeT = t.oneMinus();
  const diamonds = cos(diamondPhase).mul(0.5).add(0.5).saturate().pow(6.0).mul(fadeT);
  const heat = fadeT.pow(6.0).mul(0.8).add(diamonds.mul(0.7)).saturate();
  const coneCol = mix(tint, core, heat).mul(fadeT.pow(1.2)).mul(diamonds.mul(0.8).add(1.0)).mul(flicker).mul(edgeSoft);
  const coneK = select(part.lessThan(0.5), float(1.0), float(1.8));
  const radial = uv().sub(0.5).length().mul(2.0).saturate();
  const ring = radial.sub(0.72).abs().mul(4.0).oneMinus().saturate();
  const discCol = core.mul(radial.oneMinus().pow(2.0).mul(0.5).add(ring.pow(2.0).mul(2.0)));
  const glowCol = tint.mul(0.9).mul(radial.oneMinus().pow(1.6)).mul(u.boostK);
  m.colorNode = select(isCone, coneCol.mul(coneK), select(isDisc, discCol, glowCol)).mul(u.intensity);
  // Bloom tag (materials.ts): a fraction of the flame's own colour, read back from diffuseColor so
  // the view-dependent terms are evaluated once, in the main fragment flow. Note that three clamps
  // the colour target (max(output, 0)) but writes this MRT member raw: a NaN here is what used to
  // become the black bloom rectangle (see the `t` saturate above and glowMrt's clamp).
  m.mrtNode = glowMrt(diffuseColor.rgb.mul(FLAME_GLOW));
  m.name = 'car-flame';
  return { material: m, u };
}

/** Flat dark disc with a soft radial falloff: the car's ground blob shadow. */
function createBlobMaterial(): { material: THREE.MeshBasicNodeMaterial; opacity: THREE.UniformNode<'float', number> } {
  const m = new THREE.MeshBasicNodeMaterial();
  m.transparent = true;
  m.blending = THREE.NormalBlending;
  m.depthWrite = false;
  m.fog = false;
  const opacity = uniform(0);
  m.colorNode = vec3(0.0, 0.0, 0.0);
  m.opacityNode = smoothstep(0.35, 1.0, uv().sub(0.5).length().mul(2.0)).oneMinus().mul(opacity);
  m.mrtNode = noGlowMrt(); // an untagged material would overwrite the glow target under the shadow
  m.name = 'car-blob';
  return { material: m, opacity };
}

// ---- geometry -------------------------------------------------------------------------------

/**
 * Bake one Surface into `color` / `aMat` attributes, converting to non-indexed so parts can be
 * merged. The car material reads no uv, so it is dropped (every merged part then carries the same
 * attribute set: position, normal, color, aMat).
 */
function tag(src: THREE.BufferGeometry, s: Surface): THREE.BufferGeometry {
  let g = src;
  if (src.index !== null) {
    g = src.toNonIndexed();
    src.dispose();
  }
  if (g.getAttribute('uv') !== undefined) g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const mat = new Float32Array(n * 4);
  _col.setHex(s.color); // sRGB hex -> linear working colour space
  for (let v = 0; v < n; v++) {
    col[v * 3] = _col.r;
    col[v * 3 + 1] = _col.g;
    col[v * 3 + 2] = _col.b;
    mat[v * 4] = s.metal;
    mat[v * 4 + 1] = s.rough;
    mat[v * 4 + 2] = s.emissive;
    mat[v * 4 + 3] = s.paint;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aMat', new THREE.BufferAttribute(mat, 4));
  return g;
}

function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

/** One cross-section of a lofted part: a superellipse of half sizes (hu, hv) in the (u, v) plane at `o`. */
interface Ring {
  readonly o: readonly [number, number, number];
  readonly u: readonly [number, number, number];
  readonly v: readonly [number, number, number];
  readonly hu: number;
  readonly hv: number;
}

/** A body section across the car at `x`: half width `w` about `zc`, from `y0` up to `y1`. */
function section(x: number, w: number, y0: number, y1: number, zc = 0): Ring {
  return { o: [x, (y0 + y1) * 0.5, zc], u: [0, 0, 1], v: [0, 1, 0], hu: w, hv: (y1 - y0) * 0.5 };
}

/**
 * Smooth lofted solid: a superellipse ring per section (exponent `n`: 2 = ellipse, larger =
 * boxier, `seg` points), consecutive rings stitched into quads, both ends closed by a flat fan
 * on their own vertices (a crisp end edge). The sides share ring vertices, so
 * computeVertexNormals() shades them smoothly. Winding is chosen so the faces point outwards
 * whichever way the rings progress.
 */
function loft(rings: readonly Ring[], seg: number, n: number): THREE.BufferGeometry {
  const e = 2 / n;
  const cu = new Float64Array(seg);
  const cv = new Float64Array(seg);
  for (let j = 0; j < seg; j++) {
    const a = (j / seg) * TWO_PI;
    const c = Math.cos(a);
    const s = Math.sin(a);
    cu[j] = Math.sign(c) * Math.pow(Math.abs(c), e);
    cv[j] = Math.sign(s) * Math.pow(Math.abs(s), e);
  }
  const pos: number[] = [];
  const idx: number[] = [];
  const ringPoints = (r: Ring): void => {
    for (let j = 0; j < seg; j++) {
      const a = cu[j] * r.hu;
      const b = cv[j] * r.hv;
      pos.push(r.o[0] + r.u[0] * a + r.v[0] * b, r.o[1] + r.u[1] * a + r.v[1] * b, r.o[2] + r.u[2] * a + r.v[2] * b);
    }
  };
  for (const r of rings) ringPoints(r);
  // (a, c, b) faces outwards when u . ((o1 - o0) x v) > 0: the ring turns from +u towards +v.
  const r0 = rings[0];
  const r1 = rings[1];
  const px = r1.o[0] - r0.o[0];
  const py = r1.o[1] - r0.o[1];
  const pz = r1.o[2] - r0.o[2];
  const [vx, vy, vz] = r0.v;
  const flip = r0.u[0] * (py * vz - pz * vy) + r0.u[1] * (pz * vx - px * vz) + r0.u[2] * (px * vy - py * vx) < 0;
  const tri = (a: number, b: number, c: number): void => {
    if (flip) idx.push(a, c, b);
    else idx.push(a, b, c);
  };
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j;
      const b = i * seg + ((j + 1) % seg);
      const c = (i + 1) * seg + j;
      const d = (i + 1) * seg + ((j + 1) % seg);
      tri(a, c, b);
      tri(b, c, d);
    }
  }
  const cap = (r: Ring, last: boolean): void => {
    const first = pos.length / 3;
    ringPoints(r);
    const centre = pos.length / 3;
    pos.push(r.o[0], r.o[1], r.o[2]);
    for (let j = 0; j < seg; j++) {
      const a = first + j;
      const b = first + ((j + 1) % seg);
      if (last) tri(centre, b, a);
      else tri(centre, a, b);
    }
  };
  cap(rings[0], false);
  cap(rings[rings.length - 1], true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Cylinder of radius `r` from point a to point b (axis along a -> b). */
function tube(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, seg: number): THREE.BufferGeometry {
  _v.set(bx - ax, by - ay, bz - az);
  const len = _v.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false);
  _q.setFromUnitVectors(_s.set(0, 1, 0), _v.multiplyScalar(1 / len));
  _m.compose(_s.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5), _q, _v.set(1, 1, 1));
  g.applyMatrix4(_m);
  return g;
}

/**
 * The dune runner, built in hitbox-centred coordinates (designed on the default hitbox, about
 * 120 x 39 x 87 uu) and translated to the car origin at the end. A final guard squeezes the body
 * into the hitbox (minus a margin) should a preset ever be smaller than the design.
 */
function buildBodyGeometry(cfg: CarConfigInfo, team: Team, detail: TierSpec['detail']): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const hi = detail === 'high';
  const L = cfg.hitboxSize[0];
  const W = cfg.hitboxSize[1];
  const H = cfg.hitboxSize[2];
  const ox = cfg.hitboxOffset[0];
  const oy = cfg.hitboxOffset[2];
  const oz = cfg.hitboxOffset[1];
  const margin = 1.5; // the visible body stays this far inside the hitbox
  const hl = L * 0.5 - margin;
  const hh = H * 0.5 - margin;
  const hw = W * 0.5 - margin;
  const paint: Surface = { color: TEAM_PAINT[team], metal: 0.25, rough: 0.4, emissive: 0, paint: 1 };
  const glass: Surface = { color: TEAM_GLASS[team], metal: 0.85, rough: 0.06, emissive: 0, paint: 0.7 };
  const strip: Surface = { color: TEAM_GLOW[team], metal: 0, rough: 0.4, emissive: 1.4, paint: 0 };

  const box = (s: Surface, sx: number, sy: number, sz: number, x: number, y: number, z: number): void => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    parts.push(tag(g, s));
  };

  // Main pod, tail to nose: a rounded, slightly boxy tub that rises to the rear deck and dips
  // into a blunt rounded nose.
  const podSeg = hi ? 20 : 14;
  parts.push(
    tag(
      loft(
        [
          section(-56.5, 6, -6, 0),
          section(-55, 12, -10, 3),
          section(-50, 16, -14, 5),
          section(-38, 18, -16, 5.5),
          section(-24, 19, -16.5, 4.5),
          section(-6, 19, -16.5, 3.5),
          section(12, 19, -16.5, 3),
          section(24, 18.5, -16.5, 1.5),
          section(38, 17, -16.5, -1),
          section(50, 15, -16.5, -3.5),
          section(56, 11, -15.5, -6),
          section(58.5, 6, -13, -9),
        ],
        podSeg,
        3,
      ),
      paint,
    ),
  );

  // Bubble canopy (the upper ~105 degrees of an ellipsoid; the rest is inside the pod).
  const canopy = new THREE.SphereGeometry(1, hi ? 22 : 14, hi ? 12 : 8, 0, TWO_PI, 0, Math.PI * 0.58);
  canopy.scale(22, 12.5, 14.5);
  canopy.translate(-4, 2.5, 0);
  parts.push(tag(canopy, glass));

  // Side pods between the arches, each with a team light strip along its flank.
  for (const side of [-1, 1]) {
    const zc = side * 30.5;
    parts.push(
      tag(
        loft(
          [
            section(-29, 4, -13, -8, zc),
            section(-26, 9.5, -15.5, -4.5, zc),
            section(-18, 10.8, -16, -3.5, zc),
            section(10, 10.8, -16, -3.5, zc),
            section(17, 9.5, -15.5, -4.5, zc),
            section(20.5, 4, -14, -9, zc),
          ],
          hi ? 14 : 10,
          3,
        ),
        paint,
      ),
    );
    box(strip, 38, 1.4, 0.8, -4, -9.5, side * 41.3);
  }

  // Wide pontoon arches over the wheels: a rounded band swept around each wheel's rest position,
  // its ends cut where they would leave the hitbox (floor, tail).
  const fwx = cfg.frontWheelOffset[0] - ox;
  const bwx = cfg.backWheelOffset[0] - ox;
  const frv = cfg.frontWheelRadius * WHEEL_VISUAL;
  const brv = cfg.backWheelRadius * WHEEL_VISUAL;
  const archZIn = 20;
  const archZOut = hw - 0.25;
  const archHu = (archZOut - archZIn) * 0.5;
  const arch = (wx: number, rv: number): void => {
    const cy = rv - CAR_REST_Z - oy; // wheel centre at rest (contact point on the floor)
    const rIn = rv + 1.75;
    const rOut = Math.min(rIn + 3, hh - cy);
    if (rOut - rIn < 1) return;
    const rm = (rIn + rOut) * 0.5;
    const hv = (rOut - rIn) * 0.5;
    const low = Math.asin(clamp((-hh + 0.3 - cy) / rIn, -1, 1));
    let a0 = Math.max(low, 0.17);
    let a1 = Math.PI - a0;
    const front = (hl - wx) / rOut; // the outer edge must stay behind the nose...
    if (front < 1) a0 = Math.max(a0, Math.acos(Math.max(-1, front)));
    const rear = (-hl - wx) / rOut; // ...and in front of the tail
    if (rear > -1) a1 = Math.min(a1, Math.acos(Math.min(1, rear)));
    if (a1 - a0 < 0.3) return;
    const steps = hi ? 10 : 7;
    for (const side of [-1, 1]) {
      const zc = side * (archZIn + archHu);
      const rings: Ring[] = [];
      for (let i = 0; i <= steps; i++) {
        const a = a0 + ((a1 - a0) * i) / steps;
        const c = Math.cos(a);
        const s = Math.sin(a);
        rings.push({ o: [wx + rm * c, cy + rm * s, zc], u: [0, 0, 1], v: [c, s, 0], hu: archHu, hv });
      }
      parts.push(tag(loft(rings, hi ? 12 : 8, 4), paint));
    }
  };
  arch(fwx, frv);
  arch(bwx, brv);

  // Roll hoop behind the canopy (a half torus across the car) carrying a four-lamp light bar,
  // with two braces back to the rear deck.
  const hoopX = -24;
  const hoopR = Math.min(16, hh - 1.8);
  const hoop = new THREE.TorusGeometry(hoopR, 1.5, hi ? 8 : 5, hi ? 16 : 10, Math.PI);
  hoop.rotateY(Math.PI / 2);
  const hoopY = -1.5; // the open tube ends sink into the pod
  hoop.translate(hoopX, hoopY, 0);
  parts.push(tag(hoop, CAGE));
  const braceY = hoopY + Math.sqrt(hoopR * hoopR - 7.7 * 7.7);
  for (const side of [-1, 1]) parts.push(tag(tube(hoopX, braceY, side * 7.7, -46, 4, side * 10, 1.1, hi ? 8 : 5), CAGE));
  const barY = hoopY + hoopR - 0.7;
  box(TRIM, 3, 2.4, 17, hoopX + 2.4, barY, 0);
  for (const z of [-7.2, -2.4, 2.4, 7.2]) box(HEADLIGHT, 0.8, 1.8, 2.8, hoopX + 4.1, barY, z);

  // Engine cover on the rear deck.
  box(TRIM, 11, 4.5, 13, -38, 6.5, 0);
  box(TRIM, 9, 0.8, 14, -38.5, 9.2, 0);

  // Twin thrusters: housing, dark throat and a tail-light ring each.
  const nx = -hl + 0.75; // nozzle exit plane
  const ny = BOOST_NOZZLE_Y - oy;
  for (const side of [-1, 1]) {
    const z = side * BOOST_NOZZLE_Z;
    const housing = new THREE.CylinderGeometry(4.2, 4.6, 7, hi ? 16 : 10, 1, false);
    housing.rotateZ(Math.PI / 2);
    housing.translate(nx + 3.5, ny, z);
    parts.push(tag(housing, RIM));
    const throat = new THREE.CircleGeometry(3.3, hi ? 16 : 10);
    throat.rotateY(-Math.PI / 2);
    throat.translate(nx - 0.05, ny, z);
    parts.push(tag(throat, DISC));
    const ring = new THREE.TorusGeometry(4.5, 0.55, 5, hi ? 18 : 12);
    ring.rotateY(Math.PI / 2);
    ring.translate(nx + 0.1, ny, z);
    parts.push(tag(ring, TAILLIGHT));
  }

  // Nerf-bar bumper across the nose with a fog lamp at each end.
  const bumperX = hl - 1.75;
  parts.push(tag(tube(bumperX, -12.5, -24, bumperX, -12.5, 24, 1.4, hi ? 10 : 6), CAGE));
  for (const side of [-1, 1]) {
    const lamp = new THREE.CylinderGeometry(2.2, 2.2, 2, hi ? 14 : 8, 1, false);
    lamp.rotateZ(Math.PI / 2);
    lamp.translate(hl - 1.0, -12.5, side * 20.5);
    parts.push(tag(lamp, HEADLIGHT));
  }

  const merged = mergeParts(parts);
  // Containment guard: squeeze any axis that would leave the hitbox (no-op on the default one).
  merged.computeBoundingBox();
  const bb = merged.boundingBox as THREE.Box3;
  const kx = Math.min(1, hl / Math.max(-bb.min.x, bb.max.x));
  const ky = Math.min(1, hh / Math.max(-bb.min.y, bb.max.y));
  const kz = Math.min(1, hw / Math.max(-bb.min.z, bb.max.z));
  if (kx < 0.999 || ky < 0.999 || kz < 0.999) {
    if (import.meta.env.DEV) console.warn(`[car-body] body exceeds the hitbox, squeezed by (${kx.toFixed(3)}, ${ky.toFixed(3)}, ${kz.toFixed(3)})`);
    merged.scale(kx, ky, kz);
  }
  merged.translate(ox, oy, oz);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Unit-radius wheel with the axle along local z; instances scale (radius, radius, 1). Knobby
 * off-road tyre (carcass, sidewalls, staggered tread blocks), dark six-spoke rim over a dish, a
 * light beadlock ring with bolts on both faces and a team-coloured hub cap.
 */
function buildWheelGeometry(width: number, detail: TierSpec['detail'], team: Team): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const hi = detail === 'high';
  const seg = hi ? 24 : 14;
  const seg2 = hi ? 18 : 10;
  const hw = width * 0.5;
  const hub: Surface = { color: TEAM_PAINT[team], metal: 0.3, rough: 0.4, emissive: 0.15, paint: 0.98 };

  const tread = new THREE.CylinderGeometry(TREAD_R, TREAD_R, width, seg, 1, true);
  tread.rotateX(Math.PI / 2);
  parts.push(tag(tread, TYRE));
  const knobs = hi ? 16 : 12;
  const knobH = 1 - TREAD_R + 0.01;
  for (let i = 0; i < knobs; i++) {
    const knob = new THREE.BoxGeometry(0.24, knobH, width * 0.46);
    knob.translate(0, 1 - knobH * 0.5, ((i & 1) === 0 ? -1 : 1) * width * 0.25);
    knob.rotateZ((i * TWO_PI) / knobs);
    parts.push(tag(knob, TYRE));
  }
  for (const side of [-1, 1]) {
    const wall = new THREE.RingGeometry(RIM_R, TREAD_R, seg, 1);
    if (side < 0) wall.rotateY(Math.PI);
    wall.translate(0, 0, side * hw);
    parts.push(tag(wall, TYRE));
    const bead = new THREE.RingGeometry(0.54, 0.7, seg2, 1);
    if (side < 0) bead.rotateY(Math.PI);
    bead.translate(0, 0, side * (hw + 0.35));
    parts.push(tag(bead, BEAD));
    if (hi) {
      for (let i = 0; i < 8; i++) {
        const bolt = new THREE.BoxGeometry(0.07, 0.07, 0.3);
        bolt.translate(0, 0.62, side * (hw + 0.45));
        bolt.rotateZ((i * TWO_PI) / 8 + 0.3);
        parts.push(tag(bolt, RIM));
      }
    }
  }
  const barrel = new THREE.CylinderGeometry(RIM_R, RIM_R, width + 0.6, seg2, 1, true);
  barrel.rotateX(Math.PI / 2);
  parts.push(tag(barrel, RIM_DARK));
  const dish = new THREE.CylinderGeometry(0.6, 0.6, width * 0.4, seg2, 1, false);
  dish.rotateX(Math.PI / 2);
  parts.push(tag(dish, DISC));
  for (let i = 0; i < 6; i++) {
    const spoke = new THREE.BoxGeometry(0.17, 0.42, width + 0.9);
    spoke.translate(0, 0.36, 0);
    spoke.rotateZ((i * TWO_PI) / 6);
    parts.push(tag(spoke, RIM_DARK));
  }
  const cap = new THREE.CylinderGeometry(0.2, 0.22, width + 1.6, 10, 1, false);
  cap.rotateX(Math.PI / 2);
  parts.push(tag(cap, hub));
  const merged = mergeParts(parts);
  merged.computeBoundingSphere();
  return merged;
}

/** Tag every vertex of a flame part with its part id and thruster side. */
function flamePart(g: THREE.BufferGeometry, id: number, jet: number): THREE.BufferGeometry {
  let out = g;
  if (g.index !== null) {
    out = g.toNonIndexed();
    g.dispose();
  }
  const n = out.attributes.position.count;
  out.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(id), 1));
  out.setAttribute('aJet', new THREE.BufferAttribute(new Float32Array(n).fill(jet), 1));
  return out;
}

/**
 * Unit jet of revolution with the base at the origin and the tip at -x (uv.y 0 at the base, 1 at
 * the tip). `r(t)` is the radius profile, t from 0 (base) to 1 (tip).
 */
function jetGeometry(length: number, segments: number, points: number, r: (t: number) => number): THREE.BufferGeometry {
  const profile: THREE.Vector2[] = [];
  for (let i = 0; i <= points; i++) {
    const t = i / points;
    profile.push(new THREE.Vector2(Math.max(0, r(t)), t * length));
  }
  const g = new THREE.LatheGeometry(profile, segments);
  g.rotateZ(Math.PI / 2); // +y (the lathe axis) -> -x
  return g;
}

/**
 * Merged flame: per thruster a plume (swells just behind the nozzle, then tapers) and a shorter
 * core, both unit sized and scaled in the shader, plus a nozzle disc in the exit plane; and the
 * underglow quad at `glowCentre`.
 */
function buildFlameGeometry(glowCentre: THREE.Vector3): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const jet of [-1, 1]) {
    const plume = jetGeometry(1, 10, 10, (t) => 0.6 * (0.75 + 0.5 * Math.sin(Math.PI * 0.5 * Math.min(t / 0.2, 1))) * Math.pow(1 - t, 0.6));
    const core = jetGeometry(0.62, 8, 6, (t) => 0.42 * Math.pow(1 - t, 0.6));
    const disc = new THREE.CircleGeometry(0.62, 12);
    disc.rotateY(-Math.PI / 2); // normal towards -x (the plume)
    parts.push(flamePart(plume, 0, jet), flamePart(core, 1, jet), flamePart(disc, 2, jet));
  }
  const glow = new THREE.PlaneGeometry(GLOW_LENGTH, GLOW_WIDTH);
  glow.rotateX(-Math.PI / 2); // flat, normal +y
  glow.translate(glowCentre.x, glowCentre.y, glowCentre.z);
  parts.push(flamePart(glow, 3, 0));
  const merged = mergeParts(parts);
  if (import.meta.env.DEV) assertUnitNormals(merged, 'car-flame');
  return merged;
}

/**
 * Dev-only check (runs once per geometry build): every normal must be unit length. A zero normal
 * would be normalised to NaN in the fragment shader and the flame's NaN would end up in the bloom.
 */
function assertUnitNormals(g: THREE.BufferGeometry, name: string): void {
  const n = g.getAttribute('normal');
  if (n === undefined) {
    console.warn(`[${name}] geometry has no normal attribute`);
    return;
  }
  for (let i = 0; i < n.count; i++) {
    const x = n.getX(i);
    const y = n.getY(i);
    const z = n.getZ(i);
    const l2 = x * x + y * y + z * z;
    if (!(l2 > 0.9 && l2 < 1.1)) {
      console.warn(`[${name}] degenerate normal at vertex ${i}: (${x}, ${y}, ${z})`);
      return;
    }
  }
}

function rotValid(buf: Float32Array, r: number): boolean {
  const fx = buf[r];
  const fy = buf[r + 1];
  const fz = buf[r + 2];
  return fx * fx + fy * fy + fz * fz > 0.5;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smooth01(x: number, lo: number, hi: number): number {
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---- view -----------------------------------------------------------------------------------

export class CarView {
  readonly root = new THREE.Group();
  /** Alias of root.position (interpolated sim car origin, three.js coords). */
  readonly position: THREE.Vector3;
  /** Alias of root.quaternion (local +x forward, +y up, +z right). */
  readonly quaternion: THREE.Quaternion;
  /** The boost flame mesh (child of root, at the rear). Visible only while boosting/supersonic. */
  readonly boostFlame: THREE.Object3D;
  readonly team: Team;
  readonly config: CarConfigInfo;

  private readonly scene: THREE.Scene;
  /** High geometry detail: the shadow map grounds the car, the blob only shows once airborne (updateBlob). */
  private readonly blobOnlyAirborne: boolean;
  private readonly body: THREE.Mesh;
  private readonly wheels: THREE.InstancedMesh;
  private readonly flame: THREE.Mesh;
  private readonly flameMat: THREE.MeshBasicNodeMaterial;
  private readonly flameU: FlameUniforms;
  private readonly blob: THREE.Mesh;
  private readonly blobMat: THREE.MeshBasicNodeMaterial;
  private readonly blobOpacity: THREE.UniformNode<'float', number>;
  private readonly spin = new Float32Array(4);
  /** Visual outward offset of the wheel centres per axle (front, back), uu. */
  private readonly track = new Float32Array(2);
  private userVisible = true;
  private demoed = false;
  private flick = 1;
  private boostK = 0;
  private disposed = false;
  /** Visibility / opacity to restore after a warm-up render (see setWarmUp). */
  private warmFlame = false;
  private warmBlob = false;
  private warmBlobOpacity = 0;

  constructor(scene: THREE.Scene, config: CarConfigInfo, team: Team, quality: Quality) {
    this.scene = scene;
    this.config = config;
    this.team = team;
    const detail = tier(quality).detail;
    this.blobOnlyAirborne = detail === 'high';
    this.position = this.root.position;
    this.quaternion = this.root.quaternion;
    this.root.name = team === 0 ? 'car-blue' : 'car-red';

    const material = acquireCarMaterial();

    this.body = new THREE.Mesh(buildBodyGeometry(config, team, detail), material);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.root.add(this.body);

    const wheelOuter = Math.min(WHEEL_OUTER, config.hitboxSize[1] * 0.5 - 2.5);
    this.track[0] = Math.max(0, wheelOuter - WHEEL_WIDTH * 0.5 - config.frontWheelOffset[1]);
    this.track[1] = Math.max(0, wheelOuter - WHEEL_WIDTH * 0.5 - config.backWheelOffset[1]);
    this.wheels = new THREE.InstancedMesh(buildWheelGeometry(WHEEL_WIDTH, detail, team), material, 4);
    this.wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wheels.castShadow = true;
    this.wheels.receiveShadow = true;
    this.wheels.frustumCulled = false; // instance bounds are not tracked; the car is small anyway
    this.root.add(this.wheels);

    // Flame mesh just behind the thrusters' exit plane (the body puts it 0.75 uu inside the hitbox
    // margin); the jets sit at +-BOOST_NOZZLE_Z and the underglow centre is given relative to it.
    const nozzleX = config.hitboxOffset[0] - (config.hitboxSize[0] * 0.5 - 1.5) + 0.75 - 0.2;
    const nozzleY = BOOST_NOZZLE_Y;
    _v.set(config.hitboxOffset[0] - nozzleX, config.hitboxOffset[2] - config.hitboxSize[2] * 0.5 - 1 - nozzleY, 0);
    const flame = createFlameMaterial(team, _v, BOOST_NOZZLE_Z);
    this.flameMat = flame.material;
    this.flameU = flame.u;
    this.flame = new THREE.Mesh(buildFlameGeometry(_v), this.flameMat);
    this.flame.position.set(nozzleX, nozzleY, 0);
    this.flame.visible = false;
    this.flame.frustumCulled = false;
    this.flame.renderOrder = 5;
    this.root.add(this.flame);
    this.boostFlame = this.flame;

    // Ground blob (child of the scene so it stays flat on the floor).
    const blob = createBlobMaterial();
    this.blobMat = blob.material;
    this.blobOpacity = blob.opacity;
    const blobGeo = new THREE.CircleGeometry(1, 20);
    blobGeo.rotateX(-Math.PI / 2);
    this.blob = new THREE.Mesh(blobGeo, this.blobMat);
    this.blob.name = 'car-blob';
    this.blob.visible = false;
    this.blob.frustumCulled = false;
    this.blob.renderOrder = 1;
    this.blob.castShadow = false;
    this.blob.receiveShadow = false;
    scene.add(this.blob);

    this.placeWheelsAtRest();
    scene.add(this.root);
  }

  /**
   * Interpolate the car between two state buffers (`off` = float offset of this car's slot in
   * both buffers) and animate wheels/flame/blob. Safe to call with all-zero buffers.
   */
  update(prev: Float32Array, cur: Float32Array, off: number, alpha: number, dt: number): void {
    const demoed = cur[off + C_IS_DEMOED] > 0.5;
    if (demoed !== this.demoed) {
      this.demoed = demoed;
      this.root.visible = this.userVisible && !demoed;
    }
    if (!this.root.visible) {
      this.blob.visible = false;
      return;
    }

    // Position: lerp, but snap across teleports (respawn / kickoff reset).
    const p = off + C_POS;
    const dx = cur[p] - prev[p];
    const dy = cur[p + 1] - prev[p + 1];
    const dz = cur[p + 2] - prev[p + 2];
    const a = dx * dx + dy * dy + dz * dz > TELEPORT_DIST_SQ ? 1 : alpha;
    simVecLerpFromBuf(this.root.position, prev, cur, p, a);

    // Rotation: slerp between the two RotMats (identity while the sim has not produced state).
    const r = off + C_ROT;
    const curValid = rotValid(cur, r);
    if (curValid && a < 1 && rotValid(prev, r)) {
      simRotMatToQuat(_qa, prev, r);
      simRotMatToQuat(_qb, cur, r);
      this.root.quaternion.slerpQuaternions(_qa, _qb, a);
    } else if (curValid) {
      simRotMatToQuat(this.root.quaternion, cur, r);
    } else {
      this.root.quaternion.identity();
    }

    // Wheels: forward speed = vel . forward (sim coords, no conversion needed for a dot product).
    const v = off + C_VEL;
    const fwdSpeed = cur[v] * cur[r] + cur[v + 1] * cur[r + 1] + cur[v + 2] * cur[r + 2];
    this.updateWheels(prev, cur, off, a, dt, fwdSpeed);

    // Boost flame (full while boosting; a faint short heat cone while merely supersonic) and the
    // team underglow, eased in/out while boosting.
    const boosting = cur[off + C_IS_BOOSTING] > 0.5;
    const supersonic = cur[off + C_IS_SUPERSONIC] > 0.5;
    const ease = Math.min(1, dt * GLOW_RATE);
    this.boostK += ((boosting ? 1 : 0) - this.boostK) * ease;
    const u = this.flameU;
    if (boosting || supersonic) {
      this.flick += (0.7 + Math.random() * 0.6 - this.flick) * Math.min(1, dt * 30);
      const f = this.flick;
      if (boosting) {
        u.len.value = (supersonic ? FLAME_LENGTH * 1.35 : FLAME_LENGTH) * f;
        u.rad.value = FLAME_RADIUS * (0.85 + 0.15 * f);
        u.intensity.value = 1;
      } else {
        u.len.value = FLAME_LENGTH * 0.4 * f;
        u.rad.value = FLAME_RADIUS * 0.6;
        u.intensity.value = 0.3;
      }
    } else {
      u.intensity.value = 0;
    }
    u.boostK.value = this.boostK;
    this.flame.visible = boosting || supersonic || this.boostK > 0.02;

    this.updateBlob(cur, r);
  }

  /**
   * Pipeline warm-up hook (Game.warmUp): make the normally hidden flame and ground blob renderable
   * for one frame at zero intensity / opacity so their shaders compile before the first boost or
   * jump; `false` restores what update() had decided. Live (visible) meshes are left alone.
   */
  setWarmUp(on: boolean): void {
    if (on) {
      this.warmFlame = this.flame.visible;
      this.warmBlob = this.blob.visible;
      this.warmBlobOpacity = this.blobOpacity.value;
      // Hidden flame: intensity / boostK are already ~0, so the mesh draws nothing visible.
      this.flame.visible = true;
      if (!this.blob.visible) {
        this.blobOpacity.value = 0;
        this.blob.visible = true;
      }
    } else {
      this.flame.visible = this.warmFlame;
      this.blob.visible = this.warmBlob;
      this.blobOpacity.value = this.warmBlobOpacity;
    }
  }

  /** User-level visibility (menus, replays). Demolition hides the car independently. */
  setVisible(v: boolean): void {
    this.userVisible = v;
    this.root.visible = v && !this.demoed;
    if (!this.root.visible) this.blob.visible = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.root);
    this.scene.remove(this.blob);
    this.body.geometry.dispose();
    this.wheels.geometry.dispose();
    this.wheels.dispose();
    this.flame.geometry.dispose();
    this.flameMat.dispose();
    this.blob.geometry.dispose();
    this.blobMat.dispose();
    releaseCarMaterial();
  }

  /**
   * Ground blob under the hitbox centre: grows and fades with height (0..BLOB_MAX_HEIGHT), fades
   * out on walls/ceiling (car up vector), and at high detail only appears once the car is airborne
   * (the shadow map handles grounded cars there).
   */
  private updateBlob(cur: Float32Array, r: number): void {
    const cfg = this.config;
    const q = this.root.quaternion;
    const h = this.root.position.y - CAR_REST_Z;
    const k = h > 0 ? Math.min(1, h / BLOB_MAX_HEIGHT) : 0; // NaN-safe: a bad height collapses to 0, never a NaN scale
    const upY = rotValid(cur, r) ? cur[r + 8] : 1; // sim up.z = three up.y
    let op = (0.5 - 0.38 * k) * clamp(upY, 0, 1);
    if (this.blobOnlyAirborne) op *= smooth01(h, 20, 45);
    if (op <= 0.01) {
      this.blob.visible = false;
      return;
    }
    this.blob.visible = true;
    this.blobOpacity.value = op;
    _v.set(cfg.hitboxOffset[0], 0, 0).applyQuaternion(q).add(this.root.position);
    this.blob.position.set(_v.x, 0.6, _v.z);
    const grow = 1 + 0.3 * k;
    this.blob.scale.set(BLOB_LENGTH * grow, 1, BLOB_WIDTH * grow);
    _v.set(1, 0, 0).applyQuaternion(q);
    if (_v.x * _v.x + _v.z * _v.z > 0.01) this.blob.rotation.y = Math.atan2(-_v.z, _v.x);
  }

  /**
   * Before the sim has produced a state the wheels sit exactly on the floor: the config rest
   * length includes the spring preload, so the geometric value (hardpoint height above the floor
   * minus the radius) is what a parked car shows.
   */
  private placeWheelsAtRest(): void {
    const cfg = this.config;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const radius = front ? cfg.frontWheelRadius : cfg.backWheelRadius;
      const hp = front ? cfg.frontWheelOffset : cfg.backWheelOffset;
      const rest = hp[2] + CAR_REST_Z - radius;
      this.composeWheel(i, hp, rest, radius, 0, 0);
    }
    this.wheels.instanceMatrix.needsUpdate = true;
  }

  /**
   * Instance matrix = T(hardpoint - suspension*up + visual lift/track) * Ry(-steer) * Rz(spin)
   * * S(visualRadius, visualRadius, 1). The visual radius is WHEEL_VISUAL x the physics radius;
   * the centre is lifted by the difference so the contact point stays on the floor.
   */
  private composeWheel(i: number, hp: readonly [number, number, number], s: number, radius: number, steer: number, ang: number): void {
    const rv = radius * WHEEL_VISUAL;
    const track = this.track[i < 2 ? 0 : 1];
    _e.set(0, -steer, ang, 'XYZ');
    _q.setFromEuler(_e);
    _v.set(hp[0], hp[2] - s + (rv - radius), (i & 1) === 0 ? -(hp[1] + track) : hp[1] + track);
    _s.set(rv, rv, 1);
    _m.compose(_v, _q, _s);
    this.wheels.setMatrixAt(i, _m);
  }

  /**
   * Wheel order in the state buffer: FL, FR, BL, BR. Left = -z in the car's three.js frame.
   * (Positive sim steer turns the nose towards +right, which is a negative rotation about +y here.)
   */
  private updateWheels(prev: Float32Array, cur: Float32Array, off: number, alpha: number, dt: number, fwdSpeed: number): void {
    const cfg = this.config;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const radius = front ? cfg.frontWheelRadius : cfg.backWheelRadius;
      const rest = front ? cfg.frontSuspensionRest : cfg.backSuspensionRest;
      const hp = front ? cfg.frontWheelOffset : cfg.backWheelOffset;

      // `rest` (config) is the fully extended spring (default preset: 38.755); a parked car sits
      // compressed at hardpoint-height-above-floor - radius (25.25). Allow from 12 uu below the
      // parked length (hard landing) up to full extension (wheels hanging in the air).
      const parked = hp[2] + CAR_REST_Z - radius;
      const sIdx = off + C_WHEEL_SUSPENSION + i;
      let sp = prev[sIdx];
      let sc = cur[sIdx];
      if (!(sp > 0)) sp = parked; // zero state buffer -> wheel on the floor
      if (!(sc > 0)) sc = parked;
      const s = clamp(sp + (sc - sp) * alpha, parked - SUSPENSION_CLAMP, Math.max(parked, rest) + 2);

      const steer = front ? cur[off + C_WHEEL_STEER + i] : 0;
      let ang = this.spin[i] - (fwdSpeed * dt) / (radius * WHEEL_VISUAL);
      if (ang > TWO_PI || ang < -TWO_PI) ang %= TWO_PI;
      this.spin[i] = ang;
      this.composeWheel(i, hp, s, radius, steer, ang);
    }
    this.wheels.instanceMatrix.needsUpdate = true;
  }
}

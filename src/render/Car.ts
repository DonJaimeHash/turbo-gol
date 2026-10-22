/**
 * Procedural car (body + wheels + boost flame + ground blob) for the three.js WebGPU renderer.
 *
 * The body and the wheels come from src/render/cars (docs/cars.md): one CarBodySpec per cosmetic
 * car (the dune runner today: cars/dune.ts), built from the shared kit (cars/kit.ts) and wheel
 * styles (cars/wheels.ts), cached per (body, team, detail) and per (wheel style, team, detail)
 * and reference-counted (cars/cache.ts). This file is the rest: the shared material, the flame,
 * the blob and CarView, which can swap its body in place (setBody).
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
 * all cars and wheels of a tier (surface properties live in vertex attributes: `color` = linear
 * base colour, `aMat` = (metalness, roughness, emissive, kind), see CAR_KIND; the body's livery in
 * four per-object uniforms, see liveryUniforms) plus one additive flame material and one blob
 * material per car. Every body draws with the same material, mesh types and vertex layout: a
 * body is geometry and uniform values only, never a draw call or a pipeline.
 *
 * The shared material (createCarMaterial) turns each surface kind into a real-looking material in
 * TSL, without textures: metallic-flake paint under a deep clearcoat, gloss carbon twill, dark
 * tinted glass, chrome / satin alloy / heat-tinted exhausts, tyre rubber with knob sipes and
 * sidewall detail, HDR lamps, and a little grime low on the body. Team colours come unchanged
 * from TEAM_PAINT, so the teams keep their colour-blind lightness separation.
 *
 * No per-frame allocations: all maths goes through module scratch objects.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  atan,
  attribute,
  color,
  cos,
  diffuseColor,
  float,
  floor,
  fract,
  fwidth,
  hash,
  length,
  max,
  min,
  mix,
  mod,
  modelViewMatrix,
  mx_noise_float,
  normalGeometry,
  normalLocal,
  normalView,
  normalViewGeometry,
  normalize,
  positionGeometry,
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
  vec4,
} from 'three/tsl';
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
import {
  BRAND_LIME,
  OpaqueAlbedoPhysicalMaterial,
  SHARED_INSTANCING_CAPACITY,
  bumpNormal,
  cellHash3,
  glowMrt,
  lineMask,
  linearVec3,
  noGlowMrt,
  resolvedFade,
  thinLineMask,
  valueNoise3,
  type FloatNode,
  type Vec3Node,
} from './materials';
import { tier, type Quality, type TierSpec } from './quality';
import { acquireBodyGeometry, acquireWheelGeometry, releaseBodyGeometry, releaseWheelGeometry } from './cars/cache';
import { DEFAULT_BODY, carBody } from './cars/index';
import {
  BOOST_NOZZLE_Y,
  BOOST_NOZZLE_Z,
  CAR_KIND,
  CAR_REST_Z,
  HITBOX_MARGIN,
  KNOBS_HIGH,
  KNOBS_LOW,
  KNOB_WIDTH,
  PAINT_METAL,
  PAINT_ROUGH,
  RIM_R,
  TEAM_GLOW,
  TREAD_R,
  TWO_PI,
  WHEEL_WIDTH,
  assertUnitNormals,
  clamp,
  mergeParts,
  type CarKind,
} from './cars/kit';
import type { CarBodySpec, CarDetail, LiverySpec, WheelStyle } from './cars/types';
import { buildWheel, tyreRadius } from './cars/wheels';

// The shared car constants live with the body kit; these names stay importable from here.
export { BOOST_NOZZLE_X, BOOST_NOZZLE_Y, BOOST_NOZZLE_Z, CAR_KIND, TEAM_GLOW, TEAM_PAINT, type CarKind } from './cars/kit';

/** Visual suspension travel is clamped to rest +- this (uu). */
const SUSPENSION_CLAMP = 12;
/** prev->cur jumps longer than this are teleports (respawn / kickoff reset): snap instead of lerp. */
const TELEPORT_DIST_SQ = 300 * 300;
/** Letter cells round the sidewall's lettering band. */
const GLYPHS = 56;
/** Half width and depth (uu) of the livery's panel seams (LiverySpec.seams places them). */
const SEAM_HALF_W = 0.18;
const SEAM_DEPTH = 0.3;
/** Metallic flake cell size (uu) and the tilt of a flake's normal. */
const FLAKE_SIZE = 0.12;
const FLAKE_TILT = 0.28;
/** Clearcoat roughness on clean paint, carbon, glass and lenses. */
const COAT_ROUGH = 0.03;
/** Carbon tow width (uu) of the 2x2 twill. */
const CARBON_TOW = 0.32;
/** Approximate visual wheel radius (uu): scales the unit wheel space for noise and relief. */
const WHEEL_R_UU = 14;
/**
 * Lamp emission gain. With bloom (high, ultra) the emissive target adds the halo; without it (low)
 * the lamp has to read from its HDR colour alone, so it runs a little hotter: the lens core tone
 * maps toward white-hot with the colour kept at its rim (the lens falloff).
 */
const LAMP_GAIN_BLOOM = 1.6;
const LAMP_GAIN_FLAT = 1.9;
/** Strength of the paint's fresnel rim lift (keeps the silhouette readable on dark themes). */
const RIM_LIFT = 0.22;
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

// ---- shared material ------------------------------------------------------------------------

/** What a tier changes in the shared car material (read from its TierSpec). */
interface CarMaterialVariant {
  /**
   * Fine detail, on geometry detail 'high': metallic flakes, knob sipes, sidewall ribs and
   * lettering, bead turning marks, carbon weave, noise-driven grime and dust, and the per-pixel
   * relief (normalNode) that carries them. The low variant keeps the paint, livery, seam lines,
   * metals, glass, lamps and a uniform dirt film: a much smaller shader (compile time on phones and
   * the WebGL2 fallback), whose fine detail would be sub-pixel at pixel ratio 1 anyway.
   */
  readonly fine: boolean;
  /** Tread knobs around the tyre (the wheel geometry of the same detail). */
  readonly knobs: number;
  /** Lamp emission gain (LAMP_GAIN_BLOOM with bloom, LAMP_GAIN_FLAT without). */
  readonly lampGain: number;
  /**
   * Lambert instead of the physical model (TierSpec.cheapMaterials, super low): the flat
   * variant's albedo (livery, carbon, glass, metals' base colours) and emission (lamps, the
   * pinstripe, the rim lift) under one diffuse lobe per light: no specular, no clearcoat, no
   * environment read.
   */
  readonly cheap: boolean;
}

function carMaterialVariant(spec: TierSpec): CarMaterialVariant {
  const hi = spec.detail === 'high';
  return { fine: hi, knobs: hi ? KNOBS_HIGH : KNOBS_LOW, lampGain: spec.bloom ? LAMP_GAIN_BLOOM : LAMP_GAIN_FLAT, cheap: spec.cheapMaterials };
}

function variantKey(v: CarMaterialVariant): string {
  return `${v.cheap ? 'lambert' : v.fine ? 'fine' : 'flat'}-${v.knobs}-${v.lampGain}`;
}

/** 1 where `kind` is `k` (kinds are integers, so the neighbours are exactly 0), else 0. */
function isKind(kind: FloatNode, k: CarKind): FloatNode {
  return float(1).sub(kind.sub(k).abs().min(1));
}

/**
 * 2x2 carbon twill of CARBON_TOW tows, projected along the dominant axis of the geometry normal
 * `nG`: `tow` 0..1 across each tow, `weaveRes` 1 while the tows are resolved, 0 once sub-pixel.
 */
function carbonWeave(p: Vec3Node, nG: Vec3Node): { tow: FloatNode; weaveRes: FloatNode } {
  const cp = select(nG.y.abs().greaterThan(0.6), p.xz, select(nG.z.abs().greaterThan(0.6), p.xy, p.zy)).div(CARBON_TOW);
  const cell = floor(cp);
  const cf = fract(cp);
  const twillDir = step(2.0, mod(cell.x.add(cell.y), 4.0));
  const across = mix(cf.y, cf.x, twillDir);
  const tow = sin(across.mul(Math.PI)).mul(0.55).add(0.45).mul(mix(1.0, 0.62, twillDir));
  const weaveRes = resolvedFade(cp.x, 0.15, 0.45).mul(resolvedFade(cp.y, 0.15, 0.45));
  return { tow, weaveRes };
}

/** Tyre surface detail of the fine variant (each 0..1; see createCarMaterial). */
interface TyreDetail {
  /** Knob sipes (grooves on the knob tops). */
  readonly sipe: FloatNode;
  /** Fine concentric sidewall ribs (relief only). */
  readonly ribs: FloatNode;
  /** Raised moulded lettering on the sidewall band. */
  readonly letters: FloatNode;
  /** A groove line just outside the rim. */
  readonly beadLine: FloatNode;
}

/**
 * Knob sipes, sidewall ribs, moulded lettering and the bead line, in the unit wheel space of
 * buildWheelGeometry (`p`; `r` its radius, `rr` 0 at the rim to 1 at the carcass). Everything
 * angular is built on fract() of the tread angle, so atan's jump at +-pi leaves no seam.
 */
function tyreDetail(p: Vec3Node, r: FloatNode, rr: FloatNode, onWall: FloatNode, onCrown: FloatNode, knobs: number): TyreDetail {
  // atan(0, 0) is undefined: nudge x off zero (only the hub centre, never a tyre pixel, gets there).
  const tx = select(p.x.abs().lessThan(1e-5), float(1e-5), p.x);
  const theta = atan(p.y, tx);
  // Knob i is centred at angle pi/2 + i * 2pi / knobs; `a` is the angle from the nearest knob centre
  // in pitch units (fract keeps it continuous across atan's seam at +-pi).
  const a = fract(theta.sub(Math.PI / 2).mul(knobs / TWO_PI).add(0.5)).sub(0.5);
  const pitch = TWO_PI / knobs; // tyre-radius units per pitch at the crown
  const knobHalf = (KNOB_WIDTH * 0.5) / pitch;
  // Two zig-zag sipes along the axle on each knob, and one cut across its middle.
  const zig = sin(p.z.mul(1.6)).mul(0.05 * knobHalf);
  const sipeA = thinLineMask(a.abs().sub(knobHalf * 0.42).add(zig).mul(pitch * WHEEL_R_UU), 0.16);
  const sipeB = thinLineMask(p.z.abs().sub(WHEEL_WIDTH * 0.25), 0.14).mul(step(a.abs(), knobHalf * 0.9));
  const sipe = max(sipeA, sipeB).mul(onCrown);
  // Sidewall: fine concentric ribs, a raised band with blocky "lettering", a bead line at the rim.
  const ribs = sin(r.mul(TWO_PI * 40)).mul(0.5).add(0.5).mul(resolvedFade(r.mul(40), 0.15, 0.45));
  const band = smoothstep(0.38, 0.42, rr).mul(smoothstep(0.76, 0.8, rr).oneMinus());
  // Lettering: GLYPHS cells round the band, each a letter-like set of strokes picked by a hash
  // (a vertical: centre, both sides or left; a horizontal: top, top and bottom, middle or none).
  const glyphU = theta.mul(GLYPHS / TWO_PI);
  // Footprint of glyphU without atan's jump at +-pi (the shifted copy jumps at 0 instead).
  const glyphFw = min(fwidth(glyphU), fwidth(fract(theta.div(TWO_PI).add(0.5)).mul(GLYPHS)));
  const gu = fract(glyphU);
  const gv = rr.sub(0.42).div(0.36).saturate();
  // hash() converts its seed to u32, which clamps negatives to 0: keep every glyph's seed positive
  // (glyphU runs -GLYPHS/2..GLYPHS/2; the two faces get different text).
  const glyphSeed = floor(glyphU).add(64.0).add(step(0.0, p.z).mul(128.0));
  const h1 = hash(glyphSeed);
  const h2 = hash(glyphSeed.add(17.0));
  const gvFw = fwidth(gv);
  const stem = (c: number): FloatNode => thinLineMask(gu.sub(c), 0.075, glyphFw);
  const bar = (c: number): FloatNode => thinLineMask(gv.sub(c), 0.1, gvFw).mul(step(0.18, gu)).mul(step(gu, 0.82));
  const left = stem(0.22);
  const top = bar(0.88);
  const vertical = mix(mix(stem(0.5), max(left, stem(0.78)), step(0.33, h1)), left, step(0.66, h1));
  const horizontal = mix(mix(top, max(top, bar(0.12)), step(0.25, h2)), mix(bar(0.5), float(0.0), step(0.75, h2)), step(0.5, h2));
  const word = step(0.12, fract(theta.mul(3 / TWO_PI).add(0.04))); // three words round the wall
  const letters = max(vertical, horizontal).mul(step(gv, 0.999)).mul(step(0.001, gv)).mul(band).mul(word).mul(onWall);
  const beadLine = thinLineMask(rr.sub(0.12), 0.03).mul(onWall);
  return { sipe, ribs, letters, beadLine };
}

/** Every output of the shared material, as one mesh type's node graph (see createCarMaterial). */
interface CarSurface {
  readonly albedo: Vec3Node;
  readonly metalness: FloatNode;
  readonly roughness: FloatNode;
  readonly clearcoat: FloatNode;
  readonly clearcoatRoughness: FloatNode;
  readonly ao: FloatNode;
  readonly emissive: Vec3Node;
  /** Fine variant only: the relief normal and the clearcoat's (the grooves without the flakes). */
  readonly normal: Vec3Node | null;
  readonly coatNormal: Vec3Node | null;
}

/** Vertex attributes and geometry terms both mesh types read. */
interface SurfaceInputs {
  /** Linear base colour (`color`) and (metalness, roughness, emissive, kind) (`aMat`). */
  readonly base: Vec3Node;
  readonly metal: FloatNode;
  readonly rough: FloatNode;
  readonly glow: FloatNode;
  readonly kind: FloatNode;
  /** Geometry-space position and unit normal (car-local uu on the body, unit wheel on the wheels). */
  readonly p: Vec3Node;
  readonly nG: Vec3Node;
  /** Facing ratio, saturated (a safe pow base): paint flop, lamp lenses, rim lift. */
  readonly ndv: FloatNode;
}

function surfaceInputs(): SurfaceInputs {
  const surf = attribute('aMat', 'vec4');
  return {
    base: attribute('color', 'vec3'),
    metal: surf.x,
    rough: surf.y,
    glow: surf.z,
    kind: surf.w,
    p: positionGeometry,
    nG: normalize(normalGeometry.add(vec3(0.0, 1e-6, 0.0))), // never normalize(0)
    ndv: normalViewGeometry.dot(positionViewDirection).saturate(),
  };
}

/**
 * Metallic flakes: a per-cell normal tilt in view space for cells of FLAKE_SIZE in `q` (uu), and
 * `res`, 1 while a cell spans several pixels. Not normalised (transformNormalToView would
 * normalise: every flake the same tilt, and NaN for a zero jitter); the cell hash gives each
 * flake its own tilt. Below a few pixels a flake reads as grain, so the tilt fades early and the
 * caller widens the base-coat lobe instead (the flakes' average). The fade reads the footprint of
 * all three axes: on the pod top seen from the side, z shrinks at grazing angles while x does not.
 */
function flakes(q: Vec3Node): { tilt: Vec3Node; res: FloatNode } {
  const fq = q.div(FLAKE_SIZE);
  const fw = fwidth(fq);
  const res = smoothstep(0.12, 0.45, max(max(fw.x, fw.y), fw.z)).oneMinus();
  const tilt = modelViewMatrix.mul(vec4(cellHash3(fq).sub(0.5), 0.0)).xyz.mul(res.mul(FLAKE_TILT));
  return { tilt, res };
}

/**
 * A body's livery (LiverySpec, car-local uu) as the four vec4s bodySurface reads:
 *   [0] two-tone y, pinstripe half width, seam x (bonnet), seam x (deck lid)
 *   [1] chevrons x0, x1, half width, period along x
 *   [2] seam max |z|, grime y0 (clean above), grime y1 (dirty below), grime amount
 *   [3] ao y0 (darkest below), ao y1 (open above), heat-tint x (exit plane), heat-tint length
 * A feature that is off gets numbers that zero its mask: the two-tone line far below the car,
 * chevrons with x0 > x1, seams with a negative |z| limit, a zero pinstripe (masked by step()).
 */
export type PackedLivery = readonly [THREE.Vector4, THREE.Vector4, THREE.Vector4, THREE.Vector4];

/** Far below any body (uu): a two-tone line here leaves the whole body painted. */
const LIVERY_OFF_Y = -1e4;

export function packLivery(l: LiverySpec): PackedLivery {
  const ch = l.chevrons;
  const se = l.seams;
  return [
    new THREE.Vector4(l.twoToneY ?? LIVERY_OFF_Y, l.pinstripe, se !== null ? se.x[0] : 0, se !== null ? se.x[1] : 0),
    ch !== null ? new THREE.Vector4(ch.x0, ch.x1, ch.halfWidth, ch.period) : new THREE.Vector4(1e4, -1e4, -1, 1),
    new THREE.Vector4(se !== null ? se.maxZ : -1, l.grime.y0, l.grime.y1, l.grime.amount),
    new THREE.Vector4(l.ao.y0, l.ao.y1, l.heat.x, l.heat.length),
  ];
}

/** Packed liveries by body (packed once; CarView puts the body's on its mesh, see setBody). */
const packedLiveries = new WeakMap<CarBodySpec, PackedLivery>();

function liveryOf(spec: CarBodySpec): PackedLivery {
  let p = packedLiveries.get(spec);
  if (p === undefined) {
    p = packLivery(spec.livery);
    packedLiveries.set(spec, p);
  }
  return p;
}

/** Where CarView keeps its body's packed livery: the body mesh's userData (read per draw below). */
interface LiveryHolder {
  carLivery?: PackedLivery;
}

type LiveryUniform = THREE.UniformNode<'vec4', THREE.Vector4>;

/**
 * The livery as four uniforms of the object group (three's default for `uniform`), refreshed per
 * drawn object (onObjectUpdate) from the body mesh's `userData.carLivery`, the default body's
 * livery for any other object. Why uniforms of the object group: the cars of every body keep ONE
 * material and so one node build, one shader and one pipeline per tier variant (three caches the
 * build by material and geometry layout, NodeManager.getForRender, never by uniform values);
 * the object group already holds each draw's own matrices in a uniform buffer of its own
 * (NodeBuilderState.createBindings clones the non-shared groups per render object), so the
 * livery is 64 more bytes in a buffer every body draw already binds and updates (the material
 * has nodes: NodeMaterialObserver refreshes it on every draw). No bind group, varying or texture
 * is added on WebGPU or WebGL2. The shadow pipelines never see it: it only reaches outputs the
 * depth pass does not build (albedoNode, not colorNode). Alternatives weighed: compiled constants
 * (the old way: one shape for every body), a per-vertex livery attribute (a new attribute is a
 * new geometry layout, and a vec4 more per vertex on every body), a uniform array indexed by a
 * body id (the same per-object refresh, plus an index to carry).
 */
function liveryUniforms(): readonly [LiveryUniform, LiveryUniform, LiveryUniform, LiveryUniform] {
  const fallback = liveryOf(DEFAULT_BODY);
  const slot = (i: 0 | 1 | 2 | 3): LiveryUniform =>
    uniform(fallback[i].clone()).onObjectUpdate(({ object }) => ((object?.userData as LiveryHolder | undefined)?.carLivery ?? fallback)[i]);
  return [slot(0), slot(1), slot(2), slot(3)];
}

/**
 * The body (pod, side pods, arches, canopy, cage, lamps, engine cover, thrusters), car-local uu:
 * metallic-flake team paint under a deep clearcoat with the drawn body's livery (LiverySpec: gloss
 * carbon below the two-tone line, lime pinstripe, white nose chevrons, two panel seams), carbon
 * twill, dark tinted glass, a satin alloy cage, heat-tinted thruster housings, HDR lamps and grime
 * low down.
 */
function bodySurface(v: CarMaterialVariant): CarSurface {
  const { base, metal: metal0, rough: rough0, glow, kind, p, nG, ndv } = surfaceInputs();
  const zero = float(0.0);
  const kPaint = isKind(kind, CAR_KIND.PAINT);
  const kCarbon = isKind(kind, CAR_KIND.CARBON);
  const kGlass = isKind(kind, CAR_KIND.GLASS);
  const kAlloy = isKind(kind, CAR_KIND.ALLOY);
  const kLamp = isKind(kind, CAR_KIND.LAMP);
  const kExhaust = isKind(kind, CAR_KIND.EXHAUST);
  const kTrim = isKind(kind, CAR_KIND.TRIM);

  // Noise (fine variant): ~12 uu grime blotches and a ~1 uu grain (the alloy's hand-brushed look).
  const coarse: FloatNode = v.fine ? valueNoise3(p.mul(0.085)) : zero;
  const grain: FloatNode = v.fine ? valueNoise3(p.mul(0.9)) : zero;

  // Livery on team paint, the drawn body's (packLivery's four uniforms): two-tone line, pinstripe,
  // nose chevrons.
  const [liv0, liv1, liv2, liv3] = liveryUniforms();
  const za = p.z.abs();
  const onNose = step(liv1.x, p.x).mul(step(p.x, liv1.y)).mul(step(za, liv1.z)).mul(step(0.35, nG.y));
  const chevron = step(fract(p.x.add(za.mul(0.9)).div(liv1.w)), 0.36).mul(onNose).mul(kPaint);
  const lower = step(p.y, liv0.x).mul(kPaint);
  const upper = kPaint.sub(lower);
  const pin = lineMask(p.y.sub(liv0.x), liv0.y).mul(step(1e-3, liv0.y)).mul(kPaint); // no stripe at width 0
  const lime = linearVec3(BRAND_LIME);
  // Panel seams: thin grooves across the top of the paint (the dune runner's bonnet and deck lid).
  const onTop = smoothstep(0.25, 0.55, nG.y).mul(step(za, liv2.x)).mul(upper);
  const seam = max(thinLineMask(p.x.sub(liv0.z), SEAM_HALF_W), thinLineMask(p.x.sub(liv0.w), SEAM_HALF_W)).mul(onTop);

  // Carbon twill (lower body and carbon parts); its average once the tows are sub-pixel.
  const { tow, weaveRes } = v.fine ? carbonWeave(p, nG) : { tow: float(0.6), weaveRes: zero };
  const weave = mix(float(0.6), tow, weaveRes);
  const carbonMask = kCarbon.add(lower).min(1.0);
  const carbonCol = mix(vec3(0.012, 0.013, 0.015), vec3(0.036, 0.038, 0.042), weave);

  // Thruster housings: heat tint from deep blue at the exit through straw to clean metal.
  const heatT = p.x.sub(liv3.z).div(liv3.w).saturate();
  const heatTint = mix(mix(vec3(0.32, 0.36, 0.7), vec3(0.95, 0.72, 0.42), smoothstep(0.0, 0.35, heatT)), vec3(1.0, 1.0, 1.0), smoothstep(0.35, 0.8, heatT));

  // Grime: a dirt film low on the body (a uniform 0.2 film without the noise).
  const dirty = smoothstep(-0.2, 0.5, coarse.add(grain.mul(0.3)));
  const grimeTake = kPaint.add(kCarbon).add(kTrim).add(kAlloy.mul(0.6)).add(kExhaust.mul(0.5)).min(1.0);
  const grime = smoothstep(liv2.z, liv2.y, p.y).oneMinus().mul(dirty).mul(grimeTake).mul(liv2.w);
  const dirt = vec3(0.05, 0.046, 0.038);

  // Flakes on the upper paint; their sub-pixel average widens the base-coat lobe (flakeBlur).
  const flake = v.fine ? flakes(p) : null;
  const flakeMask = upper.mul(pin.oneMinus()).mul(chevron.oneMinus());
  const flakeBlur = (flake !== null ? flake.res.oneMinus() : float(1.0)).mul(0.08).mul(flakeMask);

  // Colour. Paint face / flop: the pigment reads brighter facing the viewer, deeper at grazing.
  const flop = mix(float(0.86), float(1.04), ndv.pow(0.6));
  const livery = mix(mix(mix(base.mul(flop), carbonCol, lower), vec3(0.88, 0.89, 0.91), chevron.mul(0.92)), lime, pin).mul(seam.mul(0.8).oneMinus());
  let albedo: Vec3Node = mix(base, livery, kPaint);
  albedo = mix(albedo, carbonCol, kCarbon);
  albedo = mix(albedo, base.mul(heatTint), kExhaust);
  albedo = mix(albedo, base.mul(0.18), kLamp); // a lamp's lit look comes from its emission
  albedo = mix(albedo, dirt, grime);

  const paintMetal = mix(float(PAINT_METAL), float(0.2), lower).mul(pin.oneMinus()).mul(chevron.mul(0.8).oneMinus());
  let metalness: FloatNode = mix(metal0, paintMetal, kPaint);
  metalness = mix(metalness, float(0.2), kCarbon).mul(grime.oneMinus());
  const paintRough = mix(mix(float(PAINT_ROUGH), float(0.3).add(weave.mul(0.1)), lower), float(0.4), chevron).add(flakeBlur);
  let roughness: FloatNode = mix(rough0, paintRough, kPaint);
  roughness = mix(roughness, float(0.3).add(weave.mul(0.12)), kCarbon);
  roughness = mix(roughness, rough0.mul(grain.mul(0.35).add(1.0)), kAlloy); // satin, brushed by hand
  roughness = mix(roughness, float(0.85), seam);
  roughness = mix(roughness, float(0.82), grime).saturate();

  // Clearcoat: paint (and its carbon), carbon parts, glass, lamp lenses; dulled by grime.
  const clearcoat = kPaint.add(kCarbon).add(kGlass).add(kLamp.mul(0.8)).min(1.0).mul(grime.mul(1.4).oneMinus().saturate()).mul(seam.oneMinus());

  // Emission: HDR lamps with a lens falloff, the pinstripe's faint glow, the paint's rim lift.
  const lens = ndv.mul(ndv).mul(0.55).add(0.45);
  const lamps = base.mul(glow).mul(mix(float(1.0), lens.mul(v.lampGain), kLamp));
  const rimLift = ndv.oneMinus().pow(3.0).mul(RIM_LIFT).mul(kPaint).mul(grime.oneMinus());
  const emissive = lamps.add(lime.mul(pin.mul(0.35))).add(mix(albedo, vec3(1.0, 1.0, 1.0), 0.5).mul(rimLift));

  let normal: Vec3Node | null = null;
  let coatNormal: Vec3Node | null = null;
  if (flake !== null) {
    const carbonH = tow.sub(0.5).mul(weaveRes).mul(0.03).mul(carbonMask);
    coatNormal = bumpNormal(seam.mul(-SEAM_DEPTH).add(carbonH));
    normal = normalize(coatNormal.add(flake.tilt.mul(flakeMask)));
  }
  return {
    albedo,
    metalness,
    roughness,
    clearcoat,
    clearcoatRoughness: float(COAT_ROUGH).add(grime.mul(0.4)),
    ao: mix(float(0.45), float(1.0), smoothstep(liv3.x, liv3.y, p.y)), // the underbody gets little sky
    emissive,
    normal,
    coatNormal,
  };
}

/**
 * The wheels, in the unit wheel space the instances scale (radius 1 in xy, axle along z in uu),
 * so the detail turns with the tyre: knobby rubber with sipes, sidewall ribs and moulded lettering
 * and a little dust, a machined beadlock, chrome bolts, dark anodised spokes and a flake-paint hub.
 */
function wheelSurface(v: CarMaterialVariant): CarSurface {
  const { base, metal: metal0, rough: rough0, glow, kind, p, nG, ndv } = surfaceInputs();
  const zero = float(0.0);
  const kTyre = isKind(kind, CAR_KIND.TYRE);
  const kHub = isKind(kind, CAR_KIND.HUB);
  const kBead = isKind(kind, CAR_KIND.BEAD);
  const r = length(p.xy);
  // Unit wheel scaled to uu, so the noise and the flakes have the body's grain.
  const q = vec3(p.x.mul(WHEEL_R_UU), p.y.mul(WHEEL_R_UU), p.z);

  const onWall = smoothstep(0.55, 0.85, nG.z.abs());
  const onCrown = step(0.985, r).mul(onWall.oneMinus()); // knob tops (the carcass sits at TREAD_R)
  const rr = r.sub(RIM_R).div(TREAD_R - RIM_R).saturate();
  const { sipe, ribs, letters, beadLine } = v.fine ? tyreDetail(p, r, rr, onWall, onCrown, v.knobs) : { sipe: zero, ribs: zero, letters: zero, beadLine: zero };
  // Dust settles on the crown edges and the lower sidewall (the wheel turns: no "low" here); one
  // noise in the fine variant, a uniform 0.2 film without it.
  const dirty = smoothstep(-0.2, 0.5, v.fine ? valueNoise3(q.mul(0.085)) : zero);
  const dust = dirty.mul(mix(smoothstep(0.7, 0.95, rr).mul(onWall), float(0.6), onWall.oneMinus())).mul(0.15);
  const rubber = mix(vec3(0.016, 0.016, 0.018), vec3(0.024, 0.024, 0.025), onCrown); // scuffed crown
  const tyreCol = mix(mix(mix(rubber, vec3(0.006, 0.006, 0.007), sipe), vec3(0.03, 0.03, 0.032), letters), vec3(0.07, 0.066, 0.06), dust);
  const tyreRough = mix(mix(mix(float(0.88), float(0.8), onCrown), float(0.6), letters), float(0.95), max(sipe, dust));
  // Beadlock: concentric turning marks (roughness), faded once sub-pixel.
  const turning: FloatNode = v.fine ? sin(r.mul(TWO_PI * 60)).mul(resolvedFade(r.mul(60), 0.1, 0.3)) : zero;
  const flake = v.fine ? flakes(q) : null;
  const flakeBlur = (flake !== null ? flake.res.oneMinus() : float(1.0)).mul(0.08).mul(kHub);

  const flop = mix(float(0.86), float(1.04), ndv.pow(0.6));
  const albedo = mix(mix(base, base.mul(flop), kHub), tyreCol, kTyre);
  let roughness: FloatNode = mix(rough0, rough0.add(flakeBlur), kHub);
  roughness = mix(roughness, rough0.add(turning.mul(0.05)), kBead);
  roughness = mix(roughness, tyreRough, kTyre).saturate();
  const rimLift = ndv.oneMinus().pow(3.0).mul(RIM_LIFT).mul(kHub);

  let normal: Vec3Node | null = null;
  let coatNormal: Vec3Node | null = null;
  if (flake !== null) {
    const tyreH = sipe.mul(-0.45).add(ribs.mul(0.012).add(letters.mul(0.16)).sub(beadLine.mul(0.12)).mul(onWall));
    coatNormal = bumpNormal(tyreH.mul(kTyre).add(turning.mul(0.006).mul(kBead)));
    normal = normalize(coatNormal.add(flake.tilt.mul(kHub)));
  }
  return {
    albedo,
    metalness: metal0,
    roughness,
    clearcoat: kHub, // the hub cap's paint
    clearcoatRoughness: float(COAT_ROUGH),
    ao: mix(float(0.55), float(1.0), smoothstep(0.5, 0.68, r)), // deep inside the rim
    emissive: base.mul(glow).add(mix(albedo, vec3(1.0, 1.0, 1.0), 0.5).mul(rimLift)),
    normal,
    coatNormal,
  };
}

/**
 * One physically based node material for every car part of every car of a tier. Everything comes
 * from the vertex attributes (`color`, `aMat` = metalness, roughness, emissive, kind) and the
 * geometry-space position, so the cars of both teams draw with it and nothing is per car.
 *
 * The body and the wheels are different pipelines anyway (the wheels are instanced), so the
 * material builds only what each needs: its outputs are Fn nodes that pick, at shader build time,
 * the body graph (bodySurface) or the wheel graph (wheelSurface) by the object being built. Each
 * shader is about half of a combined one: less to compile (WebGL2 and phones) and to run.
 * Within a graph every kind is evaluated and mixed in, branch-free: the derivative-based relief
 * needs uniform control flow, and a car covers few pixels.
 *
 * NaN hygiene: every pow base is saturated, the tread angle never takes atan(0, 0), fades and
 * masks are smoothstep / saturate outputs, bumpNormal guards its normalisation and the flake tilt
 * is never normalised.
 */
function createCarMaterial(v: CarMaterialVariant): CarMaterial {
  // One graph per mesh type, built on first use and shared by all the outputs (and every build).
  let body: CarSurface | null = null;
  let wheel: CarSurface | null = null;
  const surfaceOf = (builder: THREE.NodeBuilder): CarSurface => {
    if ((builder.object as THREE.InstancedMesh | null)?.isInstancedMesh === true) return (wheel ??= wheelSurface(v));
    return (body ??= bodySurface(v));
  };
  if (v.cheap) {
    const lm = new THREE.MeshLambertNodeMaterial();
    lm.colorNode = Fn((b) => surfaceOf(b).albedo)();
    // NodeMaterial.setupLighting adds any material's emissiveNode (r186 types it on Standard only).
    (lm as unknown as { emissiveNode: unknown }).emissiveNode = Fn((b) => surfaceOf(b).emissive)();
    lm.name = 'car-surface-lambert';
    return lm;
  }
  const m = new OpaqueAlbedoPhysicalMaterial();
  m.albedoNode = Fn((b) => surfaceOf(b).albedo)(); // not colorNode: keeps the livery out of the shadow pipelines
  m.metalnessNode = Fn((b) => surfaceOf(b).metalness)();
  m.roughnessNode = Fn((b) => surfaceOf(b).roughness)();
  m.clearcoatNode = Fn((b) => surfaceOf(b).clearcoat)();
  m.clearcoatRoughnessNode = Fn((b) => surfaceOf(b).clearcoatRoughness)();
  m.aoNode = Fn((b) => surfaceOf(b).ao)();
  m.emissiveNode = Fn((b) => surfaceOf(b).emissive)();
  if (v.fine) {
    m.normalNode = Fn((b) => surfaceOf(b).normal ?? normalViewGeometry)();
    // The coat lies smooth over the flakes but follows the grooves.
    m.clearcoatNormalNode = Fn((b) => surfaceOf(b).coatNormal ?? normalViewGeometry)();
  }
  m.name = v.fine ? 'car-surface' : 'car-surface-flat';
  return m;
}

/**
 * Shared materials by variant, reference-counted: a material is disposed when the last CarView of
 * its tier releases it. A roster change (Game.rebuildCarViews) builds the new views before
 * disposing the old ones so the count never reaches zero in between and the compiled material
 * survives the rebuild. A tier switch builds the other variant (a different shader anyway: the
 * pipeline's MSAA and MRT change with the tier).
 */
const sharedMaterials = new Map<string, { material: CarMaterial; refs: number }>();

/** The shared car material: physical on every tier but the cheap one (Lambert, super low). */
export type CarMaterial = THREE.MeshPhysicalNodeMaterial | THREE.MeshLambertNodeMaterial;

/** The shared material of tier `spec` and its variant key (for releaseCarMaterial). Exported for tests. */
export function acquireCarMaterial(spec: TierSpec): { material: CarMaterial; key: string } {
  const v = carMaterialVariant(spec);
  const key = variantKey(v);
  let entry = sharedMaterials.get(key);
  if (entry === undefined) {
    entry = { material: createCarMaterial(v), refs: 0 };
    sharedMaterials.set(key, entry);
  }
  entry.refs++;
  return { material: entry.material, key };
}

/** Drops one reference to the shared material of `key`; the last one disposes it. Exported for tests. */
export function releaseCarMaterial(key: string): void {
  const entry = sharedMaterials.get(key);
  if (entry === undefined) return;
  entry.refs--;
  if (entry.refs <= 0) {
    entry.material.dispose();
    sharedMaterials.delete(key);
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
function createFlameMaterial(team: Team, glowCentre: THREE.Vector3, jetZ: number, cheap = false): { material: THREE.MeshBasicNodeMaterial; u: FlameUniforms } {
  const m = new THREE.MeshBasicNodeMaterial();
  m.transparent = true;
  m.blending = THREE.AdditiveBlending;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.fog = false;
  // Cheap tiers (super low): additive, so the order of the faces does not matter: one pass instead
  // of three's back-then-front pair (one pipeline and one draw less), and the team tint a uniform
  // (both teams' flames share one program).
  if (cheap) m.forceSinglePass = true;

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
  // (Cheap tiers: no wobble. Its noise functions come out of each car's own build in another
  // order, so every car's flame would be a program of its own.)
  const wobble = cheap
    ? float(0)
    : mx_noise_float(vec3(positionLocal.y.mul(2.2), positionLocal.z.mul(2.2).add(jet.mul(3.7)), t.mul(3.0).sub(clock.mul(7.0))))
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
  const tint = cheap ? uniform(new THREE.Color(TEAM_GLOW[team])) : color(TEAM_GLOW[team]);
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

// ---- geometry (the flame; the body and wheels: src/render/cars) -------------------------

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
  if (import.meta.env?.DEV) assertUnitNormals(merged, 'car-flame');
  return merged;
}

function rotValid(buf: Float32Array, r: number): boolean {
  const fx = buf[r];
  const fy = buf[r + 1];
  const fz = buf[r + 2];
  return fx * fx + fy * fy + fz * fz > 0.5;
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
  /** Height of the blob over the floor: above the grass blades on tiers with `grassBlades`. */
  private readonly blobY: number;
  /** Variant key of the shared car material this view holds (see acquireCarMaterial). */
  private readonly materialKey: string;
  /** Geometry detail of the tier this view was built for (the body and wheel cache keys). */
  private readonly detail: CarDetail;
  /** The body drawn (cars/index.ts) and the cached geometry it holds (cars/cache.ts keys); see setBody. */
  private bodySpec: CarBodySpec;
  private bodyKey: string;
  /** Cache key of the shared wheel geometry held, null while the wheels are this view's own (ownWheels). */
  private wheelKey: string | null = null;
  /**
   * Cheap tiers: the wheel geometries this view built for itself, by style id, kept until
   * dispose(); null elsewhere (shared through cars/cache.ts). There the wheels instance through
   * vertex attributes (SHARED_INSTANCING_CAPACITY), which three r186 counts as the render
   * object's node attributes, and the dispose handler a geometry gets when it is first drawn
   * (renderers/common/Geometries.js initGeometry) deletes the node attributes of THAT render
   * object as it is then: a wheel geometry disposed after a swap, or shared with a view that
   * swapped away from it, would take a live mesh's instance-matrix buffers with it (the wheels
   * vanish). The body and the other tiers' wheels have no node attributes and share safely.
   */
  private readonly ownWheels: Map<string, THREE.BufferGeometry> | null;
  /** The body's wheels: visual radius over the physics radius, outer tyre radius (unit wheel). */
  private wheelVisual = 1;
  private tyreR = 1;
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

  /**
   * `body`: the car body id (src/game/cosmetics.ts CarId; an id without a body yet draws the
   * default one). Physics never depends on it: the view reads the Standard `config` like any car.
   */
  constructor(scene: THREE.Scene, config: CarConfigInfo, team: Team, quality: Quality, body: string = DEFAULT_BODY.id) {
    this.scene = scene;
    this.config = config;
    this.team = team;
    const spec = tier(quality);
    const detail: CarDetail = spec.detail;
    this.detail = detail;
    this.blobOnlyAirborne = detail === 'high';
    this.blobY = spec.grassBlades ? 6 : 0.6;
    this.position = this.root.position;
    this.quaternion = this.root.quaternion;
    this.root.name = team === 0 ? 'car-blue' : 'car-red';

    const shared = acquireCarMaterial(spec);
    this.materialKey = shared.key;
    const material = shared.material;

    const bodySpec = carBody(body);
    this.bodySpec = bodySpec;
    const bodyGeo = acquireBodyGeometry(bodySpec, config, team, detail);
    this.bodyKey = bodyGeo.key;
    this.body = new THREE.Mesh(bodyGeo.geometry, material);
    (this.body.userData as LiveryHolder).carLivery = liveryOf(bodySpec);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.root.add(this.body);

    this.placeWheelsFor(bodySpec);
    this.ownWheels = spec.cheapMaterials ? new Map() : null;
    // Cheap tiers: an instance buffer past the uniform-buffer limit, so every car's wheels share
    // one program (materials.ts SHARED_INSTANCING_CAPACITY); 4 are drawn and uploaded.
    this.wheels = new THREE.InstancedMesh(this.wheelGeometry(bodySpec.wheels.style), material, spec.cheapMaterials ? SHARED_INSTANCING_CAPACITY : 4);
    this.wheels.count = 4;
    this.wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wheels.castShadow = true;
    this.wheels.receiveShadow = true;
    this.wheels.frustumCulled = false; // instance bounds are not tracked; the car is small anyway
    this.root.add(this.wheels);

    // Flame mesh just behind the thrusters' exit plane (the body puts it 0.75 uu inside the hitbox
    // margin); the jets sit at +-BOOST_NOZZLE_Z and the underglow centre is given relative to it.
    const nozzleX = config.hitboxOffset[0] - (config.hitboxSize[0] * 0.5 - HITBOX_MARGIN) + 0.75 - 0.2;
    const nozzleY = BOOST_NOZZLE_Y;
    _v.set(config.hitboxOffset[0] - nozzleX, config.hitboxOffset[2] - config.hitboxSize[2] * 0.5 - 1 - nozzleY, 0);
    const flame = createFlameMaterial(team, _v, BOOST_NOZZLE_Z, spec.cheapMaterials);
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

  /** The id of the body drawn (cars/index.ts; the default body's for an id without one). */
  get bodyId(): string {
    return this.bodySpec.id;
  }

  /**
   * Draw body `id` (an id without a body yet draws the default one) on the SAME meshes: the body
   * and wheel geometry are swapped in place, so the material, the render objects and their
   * pipelines stay. A new mesh would be a new node build, and a new InstancedMesh a new wheel
   * program on most tiers (its instance buffer is part of the shader): no compile, no warm-up.
   * The geometry comes from the shared cache (cars/cache.ts: built on first use, a few ms, so
   * call this from a menu or a load, never from update()); the old one is released after the
   * swap. The wheels take the new body's placement from the next update(). Returns whether the
   * body changed.
   */
  setBody(id: string): boolean {
    const spec = carBody(id);
    if (this.disposed || spec === this.bodySpec) return false;
    const body = acquireBodyGeometry(spec, this.config, this.team, this.detail);
    const oldBody = this.bodyKey;
    const oldWheel = this.wheelKey;
    this.body.geometry = body.geometry;
    this.wheels.geometry = this.wheelGeometry(spec.wheels.style);
    (this.body.userData as LiveryHolder).carLivery = liveryOf(spec);
    this.bodySpec = spec;
    this.bodyKey = body.key;
    this.placeWheelsFor(spec);
    releaseBodyGeometry(oldBody);
    if (oldWheel !== null) releaseWheelGeometry(oldWheel);
    return true;
  }

  /**
   * The unit wheel of `style` for this view: shared from the cache (wheelKey holds the reference)
   * or, on cheap tiers, this view's own (ownWheels: built once per style, kept until dispose()).
   */
  private wheelGeometry(style: WheelStyle): THREE.BufferGeometry {
    const own = this.ownWheels;
    if (own === null) {
      const shared = acquireWheelGeometry(style, this.team, this.detail);
      this.wheelKey = shared.key;
      return shared.geometry;
    }
    let g = own.get(style.id);
    if (g === undefined) {
      g = buildWheel(style, this.detail, this.team);
      own.set(style.id, g);
    }
    return g;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.root);
    this.scene.remove(this.blob);
    // The body and wheel geometry are shared (cars/cache.ts): the last release disposes them. A
    // cheap tier's own wheels go after their mesh (ownWheels: the dispose handler then only drops
    // this dead mesh's instance buffers).
    releaseBodyGeometry(this.bodyKey);
    if (this.wheelKey !== null) releaseWheelGeometry(this.wheelKey);
    this.wheels.dispose();
    if (this.ownWheels !== null) for (const g of this.ownWheels.values()) g.dispose();
    this.flame.geometry.dispose();
    this.flameMat.dispose();
    this.blob.geometry.dispose();
    this.blobMat.dispose();
    releaseCarMaterial(this.materialKey);
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
    this.blob.position.set(_v.x, this.blobY, _v.z);
    const grow = 1 + 0.3 * k;
    this.blob.scale.set(BLOB_LENGTH * grow, 1, BLOB_WIDTH * grow);
    _v.set(1, 0, 0).applyQuaternion(q);
    if (_v.x * _v.x + _v.z * _v.z > 0.01) this.blob.rotation.y = Math.atan2(-_v.z, _v.x);
  }

  /**
   * The body's wheel placement (WheelPlacement: instance-matrix values only): the track that puts
   * the outer tyre face at `outer` (inside the hitbox), the visual radius and the tyre's outer
   * radius (kept finite and positive: a NaN scale would hide the wheels).
   */
  private placeWheelsFor(spec: CarBodySpec): void {
    const cfg = this.config;
    const w = spec.wheels;
    const wheelOuter = Math.min(w.outer, cfg.hitboxSize[1] * 0.5 - 2.5);
    this.track[0] = Math.max(0, wheelOuter - WHEEL_WIDTH * 0.5 - cfg.frontWheelOffset[1]);
    this.track[1] = Math.max(0, wheelOuter - WHEEL_WIDTH * 0.5 - cfg.backWheelOffset[1]);
    this.wheelVisual = w.visual > 0 ? w.visual : 1;
    const r = tyreRadius(w.style);
    this.tyreR = r > 0 ? r : 1;
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
    this.markWheels();
  }

  /** The 4 wheel matrices changed: upload them (only them: the cheap tiers' buffer holds 1025). */
  private markWheels(): void {
    const im = this.wheels.instanceMatrix;
    im.clearUpdateRanges();
    im.addUpdateRange(0, 4 * 16);
    im.needsUpdate = true;
  }

  /**
   * Instance matrix = T(hardpoint - suspension*up + visual lift/track) * Ry(-steer) * Rz(spin)
   * * S(visualRadius, visualRadius, 1). The visual radius is the body's `wheels.visual` x the
   * physics radius; the centre is lifted by the difference between the tyre's outer radius
   * (visual radius x tyreR) and the physics radius, so the contact point stays on the floor.
   */
  private composeWheel(i: number, hp: readonly [number, number, number], s: number, radius: number, steer: number, ang: number): void {
    const rv = radius * this.wheelVisual;
    const track = this.track[i < 2 ? 0 : 1];
    _e.set(0, -steer, ang, 'XYZ');
    _q.setFromEuler(_e);
    _v.set(hp[0], hp[2] - s + (rv * this.tyreR - radius), (i & 1) === 0 ? -(hp[1] + track) : hp[1] + track);
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
      let ang = this.spin[i] - (fwdSpeed * dt) / (radius * this.wheelVisual * this.tyreR); // rolls on its outer radius
      if (ang > TWO_PI || ang < -TWO_PI) ang %= TWO_PI;
      this.spin[i] = ang;
      this.composeWheel(i, hp, s, radius, steer, ang);
    }
    this.markWheels();
  }
}

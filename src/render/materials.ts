/**
 * Shared palette and TSL helpers for the render layer. Car.ts / Ball.ts / Effects.ts may import
 * the team colours and the HDR / glow helpers so that everything meant to bloom uses the same
 * mechanism.
 *
 * Bloom contract (see Renderer): the scene pass renders two targets, `output` (the lit colour)
 * and `emissive`. Bloom reads ONLY the `emissive` target (threshold 0), so bright turf, white
 * lines and specular highlights never haze. MeshStandard/Physical node materials write their
 * `emissiveNode` there automatically. Unlit `MeshBasicNodeMaterial`s write nothing unless they
 * set `material.mrtNode = glowMrt(<colour node>)`, which is what every flame, pad, lamp, halo and
 * particle that should glow must do; things that must NOT glow may leave `mrtNode` null (nothing
 * is written) or use `noGlowMrt()` to be explicit.
 *
 * NaN contract: three writes the colour target through `max(output, 0)` (WGSL / HLSL / MSL max
 * return the non-NaN operand), so a NaN in a material's colour never reaches the `output`
 * target, but the MRT `emissive` member is written RAW. A NaN there blurs through the bloom mips
 * into a large black rectangle. `glowMrt()` therefore sanitises its write with max(0) / min(GLOW_MAX),
 * and materials keep every pow() base non-negative (MSAA interpolates varyings at the pixel
 * centre, which extrapolates attributes such as uv past their vertex range on edge pixels).
 *
 * Every helper here builds a node graph once, at material creation; nothing runs per frame on the
 * CPU and nothing allocates after setup.
 */
import * as THREE from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import {
  abs,
  cameraPosition,
  cross,
  dFdx,
  dFdy,
  diffuseColor,
  dot,
  faceDirection,
  float,
  floor,
  fwidth,
  hash,
  length,
  max,
  mod,
  mrt,
  normalViewGeometry,
  normalWorld,
  normalize,
  oneMinus,
  output,
  positionView,
  positionWorld,
  pow,
  saturate,
  select,
  sign,
  smoothstep,
  vec2,
  vec3,
} from 'three/tsl';

/** Typed TSL node aliases (r186 typings only expose operators on typed nodes). */
export type FloatNode = Node<'float'>;
export type Vec2Node = Node<'vec2'>;
export type Vec3Node = Node<'vec3'>;
export type FloatUniform = UniformNode<'float', number>;
export type MrtNode = ReturnType<typeof mrt>;

const _lin = new THREE.Color();

/** A constant linear-space vec3 node from an sRGB hex colour (what `color(hex)` does, typed as vec3). */
export function linearVec3(hex: number): Vec3Node {
  _lin.setHex(hex);
  return vec3(_lin.r, _lin.g, _lin.b);
}

/**
 * Turbogol team colours for the world (goal frames, nets, turf tint), index = Team (0 blue,
 * 1 red). Azure vs crimson: opposite hues on the blue-yellow axis that red-green colour-blind
 * players still separate, and the blue is clearly lighter than the red (CIE L* ~63 vs ~52; the
 * HUD's deeper crimson #d42039 widens that to ~17), so the two also differ in plain lightness.
 * The HUD stylesheet mirrors them (src/style.css :root --blue / --red).
 */
export const TEAM_BLUE = 0x3a9bff;
export const TEAM_RED = 0xf02a44;
export const TEAM_COLORS: readonly [number, number] = [TEAM_BLUE, TEAM_RED];
/** Brand accent ("volt" lime): ball band, car pinstripe, goal confetti; the HUD boost bar (--brand). */
export const BRAND_LIME = 0xc6ff2e;
/** Boost pads. */
export const BOOST_YELLOW = 0xffc23a;
/**
 * Bloom input threshold. Bloom reads the emissive MRT target, so this is 0: everything written
 * through `emissiveNode` / `glowMrt()` glows in proportion to its brightness.
 */
export const BLOOM_THRESHOLD = 0;
/**
 * Ceiling of one glow write (linear HDR). Far above every emitter (lamps ~3.5, pad flash 6, flames
 * ~2); its job is to bound the additive accumulation and, with the floor of 0, to sanitise NaN.
 */
export const GLOW_MAX = 64;

/** HDR colour: `hex` scaled by `intensity` (> 1 blooms). Writes into `out` when given. */
export function hdrColor(hex: number, intensity: number, out: THREE.Color = new THREE.Color()): THREE.Color {
  return out.setHex(hex).multiplyScalar(intensity);
}

/**
 * Tag for the bloom pass: writes `emissiveNode` into the scene pass' `emissive` target.
 * `blending` is how that write combines with what is already in the target:
 *   'additive' (default) adds, which is right for additive flames / glows and for glass that
 *   must not erase the lamps behind it; 'material' uses the material's own blend state;
 *   'none' overwrites (opaque surfaces).
 */
export function glowMrt(emissiveNode: Vec3Node, blending: 'additive' | 'material' | 'none' = 'additive'): MrtNode {
  // Sanitised write: min / max return the non-NaN operand (WGSL, HLSL, MSL), so a NaN produced by
  // the material (e.g. pow() of a varying that MSAA centre interpolation extrapolated below 0)
  // lands as 0 instead of entering the bloom chain, where ONE NaN texel blurs through the mips
  // into a large black rectangle. Inf is capped the same way.
  const safe = emissiveNode.max(0.0).min(GLOW_MAX);
  // `output` is named too so that on a single-target pass (quality 1, shadow / env renders) the
  // struct degrades to just the colour instead of an empty (invalid) output struct.
  const node = mrt({ output, emissive: safe });
  if (blending !== 'none') {
    node.setBlendMode('emissive', new THREE.BlendMode(blending === 'additive' ? THREE.AdditiveBlending : THREE.MaterialBlending));
  }
  return node;
}

/** Explicit "never blooms" tag (adds zero to the emissive target, so nothing behind is erased). */
export function noGlowMrt(): MrtNode {
  return glowMrt(vec3(0, 0, 0), 'additive');
}

/** Unlit material in an HDR colour that blooms, for neon strips, lamps and other glowing things. */
export function emissiveMaterial(hex: number, intensity: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  hdrColor(hex, intensity, m.color);
  m.mrtNode = glowMrt(linearVec3(hex).mul(intensity), 'none');
  return m;
}

/**
 * Anti-aliased line mask: 1 where |dist| < halfWidth, feathered over about one pixel.
 * `dist` is a signed distance in world units (uu).
 */
export function lineMask(dist: FloatNode, halfWidth: number): FloatNode {
  const d = abs(dist);
  const aa = fwidth(d).mul(0.75).add(0.35);
  return oneMinus(smoothstep(float(halfWidth).sub(aa), float(halfWidth).add(aa), d));
}

/**
 * Hexagonal cell edges for a 2D coordinate `p` (world units): 1 on the edges, 0 inside the cells.
 * Based on the classic hex-grid construction (two offset rectangular lattices, nearest centre).
 */
export function hexEdgeMask(p: Vec2Node, cellSize: number, lineWidth: number): FloatNode {
  const r = vec2(1, 1.7320508);
  const h = vec2(0.5, 0.8660254);
  const q = p.div(cellSize);
  const a = mod(q, r).sub(h);
  const b = mod(q.sub(h), r).sub(h);
  const gv = select(length(a).lessThan(length(b)), a, b);
  const ga = abs(gv);
  // Hex distance: 0 at the cell centre, 0.5 on the edges.
  const d = max(dot(ga, h), ga.x);
  const w = lineWidth / cellSize;
  const aa = fwidth(d).mul(0.75);
  return smoothstep(float(0.5 - w).sub(aa), float(0.5 - w).add(aa), d);
}

/** Fresnel rim factor (0 facing the camera, 1 at grazing angles), from world-space normal. */
export function fresnel(power: number): FloatNode {
  const v = normalize(cameraPosition.sub(positionWorld));
  return pow(saturate(oneMinus(abs(dot(normalWorld, v)))), power);
}

/** Distance from the camera to the fragment (uu). */
export function cameraDistance(): FloatNode {
  return length(cameraPosition.sub(positionWorld));
}

/** Pseudo-random 0..1 value per `size`-sized cell of a 2D coordinate. */
export function cellHash(p: Vec2Node, size: number): FloatNode {
  const c = floor(p.div(size));
  return hash(c.x.add(c.y.mul(57.17)).add(11.3));
}

/**
 * Signed distance to an octagon centred at the origin: sides at |x| = hx, |y| = hy and 45°
 * corner cuts on |x| + |y| = diag. Exact on the edges (what the line masks need).
 */
export function octagonSdf(p: Vec2Node, hx: number, hy: number, diag: number): FloatNode {
  const a = abs(p);
  return max(max(a.x.sub(hx), a.y.sub(hy)), a.x.add(a.y).sub(diag).mul(Math.SQRT1_2));
}

/** Signed distance to an axis-aligned box outline (Chebyshev form; exact on the edges). */
export function boxSdf(p: Vec2Node, cx: number, cy: number, hx: number, hy: number): FloatNode {
  const d = abs(p.sub(vec2(cx, cy)));
  return max(d.x.sub(hx), d.y.sub(hy));
}

/**
 * View-space normal from a procedural height field (uu) by screen-space derivatives: Mikkelsen,
 * "Bump Mapping Unparametrized Surfaces on the GPU" (2010), the maths of three's BumpMapNode fed by
 * any float node instead of a texture. Use it as `material.normalNode`. Heights are in world units,
 * so a 0.3 uu groove keeps its depth at any distance; fade patterns that get smaller than a pixel
 * (`resolvedFade`) or their derivatives sparkle. NaN-safe: a degenerate footprint (grazing or
 * sub-pixel triangle, det 0) falls back to the geometric normal instead of normalising zero.
 * Derivatives need uniform control flow, so feed it branch-free (mix / select) height nodes only.
 */
export function bumpNormal(height: FloatNode): Vec3Node {
  const n = normalViewGeometry;
  const dpdx = dFdx(positionView);
  const dpdy = dFdy(positionView);
  const r1 = cross(dpdy, n);
  const r2 = cross(n, dpdx);
  const det = dot(dpdx, r1).mul(faceDirection);
  const grad = sign(det).mul(dFdx(height).mul(r1).add(dFdy(height).mul(r2)));
  return normalize(abs(det).mul(n).sub(grad).add(n.mul(1e-6)));
}

/**
 * 1 while a pattern is resolved on screen, fading to 0 as it would alias: `coord` advances by 1 per
 * pattern period (cells, stripes, rings...); the fade runs from `lo` to `hi` periods per pixel.
 */
export function resolvedFade(coord: FloatNode, lo = 0.35, hi = 0.9): FloatNode {
  return oneMinus(smoothstep(lo, hi, fwidth(coord)));
}

/**
 * Coverage of a thin line of half width `halfWidth` at signed distance `dist` (same units), box
 * filtered over the pixel footprint. Once the line is thinner than a pixel it widens to the
 * footprint and dims by the same factor (the "phone wire" trick): the average stays right and the
 * line fades smoothly at distance instead of breaking into crawling dashes. Always in 0..1.
 * `footprint` overrides fwidth(dist), for distances built with fract() whose wrap would otherwise
 * read as a one-pixel line: pass the fwidth of the continuous coordinate instead.
 */
export function thinLineMask(dist: FloatNode, halfWidth: number, footprint?: FloatNode): FloatNode {
  const fw = (footprint ?? fwidth(dist)).max(1e-6);
  const w = fw.mul(0.5).max(halfWidth);
  const cover = saturate(w.sub(abs(dist)).div(fw).add(0.5));
  return cover.mul(saturate(float(halfWidth).div(w)));
}

/**
 * A MeshPhysicalNodeMaterial whose procedural albedo stays out of the shadow pass. three's shadow
 * pass copies `material.colorNode` into its depth material (it multiplies the shadow alpha by
 * `colorNode.a`), so a big procedural colour graph set as colorNode is compiled into, and run by,
 * every shadow pipeline of the object. Opaque materials whose albedo never changes their alpha set
 * `albedoNode` instead: it is assigned to the diffuse colour in the material's own build only.
 */
export class OpaqueAlbedoPhysicalMaterial extends THREE.MeshPhysicalNodeMaterial {
  /** Linear albedo (replaces colorNode; leave colorNode null). */
  albedoNode: Vec3Node | null = null;

  override setupDiffuseColor(builder: THREE.NodeBuilder): void {
    super.setupDiffuseColor(builder);
    if (this.albedoNode !== null) diffuseColor.rgb.assign(this.albedoNode);
  }
}

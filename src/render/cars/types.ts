/**
 * The contract of a car body (docs/cars.md): what a body module (dune.ts, ...) declares and the kit
 * it builds with. Bodies are cosmetic only: every car keeps CarPreset.Standard (hitbox, wheels,
 * physics), the shared car material, the same mesh types and the same vertex layout, so a body
 * adds no draw call, no pipeline and no shader compile.
 */
import type * as THREE from 'three/webgpu';
import type { CarConfigInfo, Team } from '../../sim/types';
import type { CarKind } from './kit';

/** Geometry detail (TierSpec.detail): 'high' on high / ultra, 'low' on low / super low. */
export type CarDetail = 'low' | 'high';

/** Surface description baked into vertex attributes and read by the shared material. */
export interface Surface {
  /** Base colour, sRGB hex (stored linear in `color`). */
  readonly color: number;
  readonly metal: number;
  readonly rough: number;
  /** Emissive strength (multiplies the base colour; > 1 pushes into bloom). */
  readonly emissive: number;
  readonly kind: CarKind;
}

/** One cross-section of a lofted part: a superellipse of half sizes (hu, hv) in the (u, v) plane at `o`. */
export interface Ring {
  readonly o: readonly [number, number, number];
  readonly u: readonly [number, number, number];
  readonly v: readonly [number, number, number];
  readonly hu: number;
  readonly hv: number;
}

/** BodyKit.arch's shape; every field defaults to the dune runner's pontoon arch. */
export interface ArchOptions {
  /** Inner and outer face of the band (|z|, hitbox-centred uu): 20 and hw - 0.25. */
  readonly zIn?: number;
  readonly zOut?: number;
  /** Clearance over the tyre (1.75) and band thickness (3, clipped by the hitbox top), uu. */
  readonly gap?: number;
  readonly thickness?: number;
  /** Superellipse exponent of the band's section (4: a rounded box). */
  readonly exponent?: number;
  /** The band's surface (team paint). */
  readonly surface?: Surface;
}

/**
 * What CarBodySpec.build receives (kit.ts createKit). Coordinates are hitbox-centred uu, three's
 * axes (+x forward, +y up, +z right); buildBody translates the merged body to the car origin.
 * Every helper appends parts in call order: the order is the vertex order (keep it stable).
 */
export interface BodyKit {
  /** Geometry detail 'high': spend the segments there, keep 'low' near half. */
  readonly hi: boolean;
  readonly cfg: CarConfigInfo;
  readonly team: Team;
  /** Design half extents: the hitbox minus HITBOX_MARGIN (default hitbox: 58.75, 17.83, 41.85). */
  readonly hl: number;
  readonly hh: number;
  readonly hw: number;
  /** The hitbox centre relative to the car origin, three's axes (default: 13.88, 20.76, 0). */
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  /** Team surfaces: paint (PAINT, carries the livery), canopy glass (GLASS), light strips (LAMP). */
  readonly paint: Surface;
  readonly glass: Surface;
  readonly strip: Surface;
  /** Tag `g` with `s` and append it (any three geometry; indexed ones are expanded, uvs dropped). */
  push(g: THREE.BufferGeometry, s: Surface): void;
  /** An axis-aligned box of size (sx, sy, sz) centred at (x, y, z). */
  box(s: Surface, sx: number, sy: number, sz: number, x: number, y: number, z: number): void;
  /** A wheel arch on both sides over the wheel at x `wx` (hitbox-centred) of visual radius `rv`. */
  arch(wx: number, rv: number, opts?: ArchOptions): void;
}

/**
 * The livery the shared material paints on a body's PAINT surfaces, in car-local uu (the car
 * origin, axle height at rest: y up, x forward). Per body, without a pipeline per body: Car.ts
 * packs it into four per-object uniforms read from the body mesh (packLivery, liveryUniforms).
 */
export interface LiverySpec {
  /** Two-tone line height: team paint above, gloss carbon below; null = paint all over. */
  readonly twoToneY: number | null;
  /** Half width of the lime pinstripe on the two-tone line; 0 = none. */
  readonly pinstripe: number;
  /** White chevrons on up-facing paint (normal y > 0.35): x range, half width about z = 0, period along x; null = none. */
  readonly chevrons: { readonly x0: number; readonly x1: number; readonly halfWidth: number; readonly period: number } | null;
  /** Two panel seams across the top of the paint at these x, up to |z| < maxZ; null = none. */
  readonly seams: { readonly x: readonly [number, number]; readonly maxZ: number } | null;
  /** Grime: fully dirty below y1, clean above y0 (y1 < y0), at `amount` (0..1). */
  readonly grime: { readonly y0: number; readonly y1: number; readonly amount: number };
  /** Ambient occlusion of the underbody: darkest below y0, open above y1 (y0 < y1). */
  readonly ao: { readonly y0: number; readonly y1: number };
  /** EXHAUST heat tint: blue at the thruster exit plane `x`, clean metal `length` uu forward of it. */
  readonly heat: { readonly x: number; readonly length: number };
}

/**
 * A wheel style: the unit wheel's geometry (wheels.ts buildWheel), instanced 4 times per car. The
 * tyre's radii, width and knob count are compiled into the shared shader and stay fixed (kit.ts
 * RIM_R, TREAD_R, WHEEL_WIDTH, KNOBS_HIGH / KNOBS_LOW); the rim, spokes and hub are free.
 */
export interface WheelStyle {
  /** Geometry cache key part: one id, one geometry (styles with the same id must be the same object). */
  readonly id: string;
  /** 'knobby': tread blocks to radius 1 (KNOBS_*); 'slick': a smooth tread below the shader's crown radius. */
  readonly tyre: 'knobby' | 'slick';
  /** Spokes (box arms from the hub to the barrel) and their width (tyre-radius units). */
  readonly spokes: number;
  readonly spokeWidth: number;
  /** Depth of the dark dish behind the spokes, as a fraction of the tyre width. */
  readonly dish: number;
  /** Rim colour (barrel and spokes), sRGB hex: dark metal (DARK_METAL kind). */
  readonly rim: number;
  /** Beadlock bolts per face, high detail only (0 = none). */
  readonly bolts: number;
  /** Hub cap colour: the team paint, or a fixed sRGB hex. */
  readonly hub: 'team' | number;
}

/** How a body places its wheels: instance-matrix values only (no shader or geometry cost). */
export interface WheelPlacement {
  readonly style: WheelStyle;
  /** Visual tyre radius over the physics radius (the contact point stays on the floor). */
  readonly visual: number;
  /** Target distance of the outer tyre face from the centre line (uu), clamped to the hitbox. */
  readonly outer: number;
}

/** A registered car body (src/render/cars/index.ts). */
export interface CarBodySpec {
  /** The cosmetic id (src/game/cosmetics.ts CarId) this body draws. */
  readonly id: string;
  /** Appends the body's parts through the kit, in hitbox-centred uu, in a fixed order. */
  readonly build: (kit: BodyKit) => void;
  readonly wheels: WheelPlacement;
  readonly livery: LiverySpec;
  /** Body triangles allowed per detail (tested; at most kit.ts BODY_TRIS_CAP). */
  readonly budget: Readonly<Record<CarDetail, number>>;
}

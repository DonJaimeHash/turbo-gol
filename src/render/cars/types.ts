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

/**
 * One cross-section of a lofted part: a superellipse of half sizes (hu, hv) in the (u, v) plane at
 * `o`. Never zero-sized (taper a point to at least 0.3 uu: a ring collapsed to a point has no
 * normal there).
 */
export interface Ring {
  readonly o: readonly [number, number, number];
  readonly u: readonly [number, number, number];
  readonly v: readonly [number, number, number];
  readonly hu: number;
  readonly hv: number;
  /** Half size on the -v side when it differs from hv (a flat floor under a round top). */
  readonly hvNeg?: number;
  /** This ring's superellipse exponent when it differs from the loft's (a crease sharpening along the part). */
  readonly n?: number;
}

/** A per-triangle surface choice (BodyKit.pushBy): the triangle's centre and unit face normal, build frame. */
export type SurfacePicker = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => Surface;

/**
 * Where one axle's wheels are drawn at rest, in the build frame (hitbox-centred uu, BodyKit.wheels):
 * kit.ts resolveWheels, the same numbers CarView draws them with. The left wheel mirrors the right.
 */
export interface WheelAt {
  /** The axle's x and the wheel centre's height at rest (the tyre on the floor). */
  readonly x: number;
  readonly y: number;
  /** Outer tyre radius (uu): the physics radius x `visual` x the style's tyre radius. */
  readonly radius: number;
  /** |z| of the tyre's inner and outer faces. */
  readonly zIn: number;
  readonly zOut: number;
}

/** BodyKit.arch's shape; every field defaults to the dune runner's pontoon arch. */
export interface ArchOptions {
  /**
   * Inner and outer face of the band (|z|, hitbox-centred uu): 20 and hw - 0.25 for arch; for
   * wheelArch 1 uu inside the tyre's inner face and 2.6 uu past its outer face (at most hw - 0.25).
   */
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
 * What CarBodySpec.build receives (kit.ts createKit). Coordinates are the BUILD FRAME: hitbox-
 * centred uu, three's axes (+x forward, +y up, +z right); buildBody translates the merged body to
 * the car origin, so car-local = build + (ox, oy, oz) (Standard: + (13.88, 20.76, 0)). The livery
 * (LiverySpec) is written car-local. Every helper appends parts in call order: the order is the
 * vertex order (keep it stable). Every part is a closed solid: the car material is single sided,
 * so a plane vanishes from behind (fins and wings: `fin` or a thin box).
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
  /**
   * The boost nozzles in the build frame: the thrusters' exit plane `x` (-hl + 0.75), centre
   * height `y` (car-local BOOST_NOZZLE_Y) and the right one's `z` (BOOST_NOZZLE_Z; the left at -z).
   */
  readonly nozzle: { readonly x: number; readonly y: number; readonly z: number };
  /** The body's wheels at rest (its own WheelPlacement, resolved on this hitbox), build frame. */
  readonly wheels: { readonly front: WheelAt; readonly back: WheelAt };
  /** Team surfaces: paint (PAINT, carries the livery), canopy glass (GLASS), light strips (LAMP). */
  readonly paint: Surface;
  readonly glass: Surface;
  readonly strip: Surface;
  /** Tag `g` with `s` and append it (any three geometry; indexed ones are expanded, uvs dropped). */
  push(g: THREE.BufferGeometry, s: Surface): void;
  /** Like push, a surface per triangle (`pick`): a window band or a stripe inside one loft. */
  pushBy(g: THREE.BufferGeometry, pick: SurfacePicker): void;
  /** An axis-aligned box of size (sx, sy, sz) centred at (x, y, z). */
  box(s: Surface, sx: number, sy: number, sz: number, x: number, y: number, z: number): void;
  /**
   * A flat closed solid: polygon `profile` extruded `thickness` uu and centred on `at`. 'xy' (the
   * default): points (x, y), a vertical fin across z; 'xz': points (x, z), a horizontal wing across y.
   */
  fin(s: Surface, profile: readonly (readonly [number, number])[], thickness: number, plane?: 'xy' | 'xz', at?: number): void;
  /**
   * A wheel arch on both sides over the wheel at x `wx` (build frame) of outer radius `rv`, its
   * centre `rv` over the floor (a knobby tyre at rest): the dune runner's form.
   */
  arch(wx: number, rv: number, opts?: ArchOptions): void;
  /** A wheel arch over `wheel` (k.wheels.front / back): its x, radius and centre, its band round the tyre. */
  wheelArch(wheel: WheelAt, opts?: ArchOptions): void;
}

/**
 * The livery the shared material paints on a body's PAINT surfaces, in CAR-LOCAL uu (the car
 * origin, axle height at rest: y up, x forward), not the build frame: car-local = build + (k.ox,
 * k.oy, k.oz), + (13.88, 20.76, 0) on Standard. Per body, without a pipeline per body: Car.ts packs
 * it into five per-object uniforms read from the body mesh (packLivery, liveryUniforms).
 * tests/car-bodies.test.mjs checks that each feature lands on the body's paint.
 */
export interface LiverySpec {
  /** Two-tone line height: team paint above, gloss carbon below; null = paint all over. */
  readonly twoToneY: number | null;
  /** Half width of the accent pinstripe on the two-tone line; 0 = none. */
  readonly pinstripe: number;
  /** Chevrons on up-facing paint (normal y > 0.35): x range, half width about z = 0, period along x; null = none. */
  readonly chevrons: { readonly x0: number; readonly x1: number; readonly halfWidth: number; readonly period: number } | null;
  /**
   * Two panel grooves across the top of the paint (up-facing, above the two-tone line) as planes
   * at these x, up to |z| < maxZ; null = none. One seam: give its x twice.
   */
  readonly seams: { readonly x: readonly [number, number]; readonly maxZ: number } | null;
  /** The pinstripe's colour (sRGB hex; the dune runner's is the brand lime). */
  readonly accent: number;
  /** The chevrons' colour from white (0) to the accent (1). */
  readonly chevronTint: number;
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
 * RIM_R, TREAD_R, WHEEL_WIDTH, KNOBS_HIGH / KNOBS_LOW); the rim, spokes, dish, bead and hub are
 * plain vertex data and free.
 */
export interface WheelStyle {
  /** Geometry cache key part: one id, one geometry (styles with the same id must be the same object). */
  readonly id: string;
  /** 'knobby': tread blocks to radius 1 (KNOBS_*); 'slick': a smooth tread below the shader's crown radius. */
  readonly tyre: 'knobby' | 'slick';
  /** Spokes (box arms from the hub to the barrel) and their width (tyre-radius units). */
  readonly spokes: number;
  readonly spokeWidth: number;
  /** Depth of the dish behind the spokes, as a fraction of the tyre width, and its colour (sRGB hex). */
  readonly dish: number;
  readonly dishColor: number;
  /** Rim colour (barrel and spokes), sRGB hex, and its finish: dark anodised 0.75 / 0.34, chrome 1 / 0.16. */
  readonly rim: number;
  readonly rimFinish: { readonly metal: number; readonly rough: number };
  /** Beadlock ring colour on both faces (sRGB hex, machined BEAD kind); null = none (and no bolts). */
  readonly bead: number | null;
  /** Beadlock bolts per face, high detail only (0 = none). */
  readonly bolts: number;
  /** Hub cap colour: the team paint, or a fixed sRGB hex. */
  readonly hub: 'team' | number;
  /** Triangles of the unit wheel per detail (tested): aim for kit.ts WHEEL_TRIS_TARGET, never past WHEEL_TRIS_CAP. */
  readonly budget: Readonly<Record<CarDetail, number>>;
}

/**
 * How a body places its wheels: instance-matrix values only (no shader or geometry cost), resolved
 * on the hitbox by kit.ts resolveWheels (for CarView and BodyKit.wheels alike).
 */
export interface WheelPlacement {
  readonly style: WheelStyle;
  /** Visual tyre radius over the physics radius, kit.ts WHEEL_VISUAL_RANGE (the contact point stays on the floor). */
  readonly visual: number;
  /** Distance of the outer tyre face from the centre line (uu), at most kit.ts wheelOuterMax (40.85 on Standard). */
  readonly outer: number;
  /** Tyre width over WHEEL_WIDTH (an instance scale), kit.ts WHEEL_WIDTH_RANGE; 1 when absent. */
  readonly width?: number;
  /** The rear axle's own numbers where they differ from the front's (bigger rear tyres). */
  readonly rear?: { readonly visual?: number; readonly outer?: number; readonly width?: number };
}

/** A registered car body (src/render/cars/index.ts). */
export interface CarBodySpec {
  /** The cosmetic id (src/game/cosmetics.ts CarId) this body draws. */
  readonly id: string;
  /** Appends the body's parts through the kit, in hitbox-centred uu, in a fixed order. */
  readonly build: (kit: BodyKit) => void;
  readonly wheels: WheelPlacement;
  readonly livery: LiverySpec;
  /**
   * Body triangles allowed per detail (the test fails past it): aim for kit.ts BODY_TRIS_TARGET (a
   * body above it says why in its module comment), never past BODY_TRIS_CAP (the test refuses it).
   */
  readonly budget: Readonly<Record<CarDetail, number>>;
}

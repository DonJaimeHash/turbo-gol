/**
 * The pitch: one mesh on the sim's exact floor geometry with the turf material (turfMaterial.ts),
 * plus real grass blades near the camera on the tiers with `grassBlades` (grassBlades.ts). ArenaView
 * builds it first and disposes it (a tier switch rebuilds the whole view).
 *
 * Load-time work (behind the boot overlay, measured in Chrome): the blade field (~140 ms) and the
 * field map (~80 ms) are baked once per page load and shared by every TurfView (bake.ts); the pool
 * map is baked from the theme's floodlights (~30-60 ms) once per floodlight rig and cached, so a
 * tier switch (which rebuilds the views) bakes nothing. setTheme otherwise writes uniforms only:
 * the light count, the lamp count and the material variant never change with the theme.
 *
 * Per tier (quality.ts), at 1600x900 CSS on the chase camera (docs/visuals/REWORK.md budgets):
 *   low    flat filtered blade texture (2x anisotropic), damp sheen, no puddles, `turfStreaks` (4)
 *          analytic floodlight streaks, baked pools; 1 draw, ~0.2 ms (budget 0.25).
 *   high   blade normals, relief + self-shadow of the blades, soft puddles, 8 streaks (8x
 *          anisotropic); 1 draw, ~0.5 ms (budget 0.6).
 *   ultra  high + instanced grass blades within ~3 m of the camera; 2 draws,
 *          blades ~0.1 ms (budget 0.4).
 *
 * Shadows: receives (the cars and the ball cast), never casts. Nothing allocates per frame: the
 * blades move their patch in their own onBeforeRender (one Vector2 write).
 */
import * as THREE from 'three/webgpu';
import type { FloatUniform } from '../materials';
import { tier, type Quality, type TierSpec } from '../quality';
import { themeWorld, type ThemeId, type ThemeWorld } from '../theme';
import { BLADE_FIELD_SIZE, FIELD_MAP, POOL_MAP, bakePoolMap, bladeField, fieldMap, streakLamps } from './bake';
import { GrassBlades } from './grassBlades';
import { buildTurfMaterial, createTurfUniforms, type TurfTextures, type TurfUniforms } from './turfMaterial';
import { turfLook } from './turfTheme';

/** Source radius (uu) of a floodlight head for the streak lobe (the head is ~5 m across). */
const LAMP_RADIUS = 260;
/**
 * Overall gains of the floodlight pools, the wet streaks and the mowing stripes over the theme
 * looks (turfTheme.ts), tuned in the integration phase against the lighting of post/lighting.ts.
 * The stripes stay faint (the view-dependent sheen of a mown pitch, not dark bands across it).
 */
const POOL_GAIN = 0.2;
const STREAK_GAIN = 0.24;
const STRIPE_GAIN = 0.55;
/**
 * Brightest environment radiance the turf reflects (turfMaterial.ts CappedEnvironmentNode): at night
 * the probe's hot floodlight panels stay out of the damp sheen (the streaks reflect the lamps); by
 * day the bright sky must pass.
 */
const ENV_MAX_NIGHT = 0.5;
const ENV_MAX_DAY = 50;
/**
 * Share of the key lights' direct specular on the turf (turfMaterial.ts TurfLightingModel): at
 * night the keys stand for the towers, whose reflections are the streaks; by day the sun's sheen.
 */
const KEY_SPECULAR_NIGHT = 0.12;
const KEY_SPECULAR_DAY = 1;
/**
 * At night the pool map shapes the key lights (turfMaterial.ts poolKeyGain), so the pools sit under
 * the keys' shadows; POOL_GAIN is then only the unshadowed spill of the other heads.
 */
const POOL_KEYS_NIGHT = 1;

/**
 * The pool map of each floodlight rig seen so far (static: baked once, then reused). Keyed by the
 * theme's floodlight list, not its id: themes not built yet share the default theme's world (and
 * its list), so they share its map instead of baking identical copies.
 */
const POOL_MAPS = new WeakMap<ThemeWorld['floodlights'], Uint8Array>();
function poolMapOf(theme: ThemeId): Uint8Array {
  const rig = themeWorld(theme).floodlights;
  let data = POOL_MAPS.get(rig);
  if (data === undefined) {
    data = bakePoolMap(rig);
    POOL_MAPS.set(rig, data);
  }
  return data;
}

/** Anisotropic filtering of the blade field per tier (the grazing-angle sharpness of the turf). */
function bladeAnisotropy(spec: TierSpec): number {
  return spec.turfRelief ? 8 : 2;
}

function dataTexture(data: Uint8Array, w: number, h: number, repeat: boolean, anisotropy: number, name: string): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.colorSpace = THREE.NoColorSpace; // data, not colour
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

export class TurfView {
  readonly mesh: THREE.Mesh;
  /** The grass blades near the camera (tiers with `grassBlades`), else null. */
  readonly blades: GrassBlades | null;
  /** The turf's runtime knobs (theme values; the integration phase may tune them live). */
  readonly uniforms: TurfUniforms;

  private readonly textures: { readonly blades: THREE.DataTexture; readonly field: THREE.DataTexture; readonly pools: THREE.DataTexture };
  private theme: ThemeId | null = null;

  /**
   * `geometry`: the floor (three coords, owned and disposed by this view); `timeU`: the arena's
   * clock uniform (s), shared with the pads. The meshes are added to `parent`.
   */
  constructor(parent: THREE.Object3D, geometry: THREE.BufferGeometry, timeU: FloatUniform, quality: Quality, theme: ThemeId) {
    const spec = tier(quality);
    this.textures = {
      blades: dataTexture(bladeField(), BLADE_FIELD_SIZE, BLADE_FIELD_SIZE, true, bladeAnisotropy(spec), 'turf-blades'),
      field: dataTexture(fieldMap(), FIELD_MAP.w, FIELD_MAP.h, false, 4, 'turf-field-map'),
      pools: dataTexture(poolMapOf(theme), POOL_MAP.w, POOL_MAP.h, false, 1, 'turf-pools'),
    };
    this.uniforms = createTurfUniforms(spec.turfStreaks);
    this.setTheme(theme);

    const textures: TurfTextures = this.textures;
    this.mesh = new THREE.Mesh(geometry, buildTurfMaterial({ timeU, spec, textures, uniforms: this.uniforms }));
    this.mesh.name = 'turf';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.matrixAutoUpdate = false;
    parent.add(this.mesh);

    this.blades = spec.grassBlades ? new GrassBlades(parent, textures, this.uniforms) : null;
  }

  /**
   * The stadium theme changed: uniform writes and the theme's pool map into the same texture (baked
   * on its floodlight rig's first use, ~30-60 ms); never a rebuild or a recompile.
   */
  setTheme(theme: ThemeId): void {
    if (theme === this.theme) return;
    this.theme = theme;
    const world = themeWorld(theme);
    const look = turfLook(theme);
    const U = this.uniforms;
    U.wetness.value = world.wetness;
    U.puddleLevel.value = look.puddles * world.wetness;
    U.stripes.value = look.stripes * STRIPE_GAIN;
    U.pools.value = look.pools * POOL_GAIN;
    U.streaks.value = look.streaks * STREAK_GAIN;
    U.dry.value = look.dry;
    U.tint.value.set(look.tint[0], look.tint[1], look.tint[2]);
    U.team.value = look.team;
    // The paint's self-illumination keeps the lines readable under floodlights; by day the sun does.
    U.lineLift.value = world.night ? 1 : 0.3;
    U.envMax.value = world.night ? ENV_MAX_NIGHT : ENV_MAX_DAY;
    U.keySpecular.value = world.night ? KEY_SPECULAR_NIGHT : KEY_SPECULAR_DAY;
    U.poolKeys.value = world.night ? POOL_KEYS_NIGHT : 0;
    const k = world.keys[0].dir;
    U.keyDir.value.set(k[0], k[1], k[2]);
    const heads = streakLamps(world.floodlights, U.lampCount);
    for (let i = 0; i < U.lampCount; i++) {
      const f = heads[i];
      (U.lampPos.array[i] as THREE.Vector4).set(f.position[0], f.position[1], f.position[2], LAMP_RADIUS);
      (U.lampCol.array[i] as THREE.Vector3).set(f.color[0] * f.strength, f.color[1] * f.strength, f.color[2] * f.strength);
    }
    const pools = this.textures.pools;
    const data = poolMapOf(theme);
    if (pools.image.data !== data) {
      pools.image.data = data;
      pools.needsUpdate = true;
    }
  }

  /**
   * Pipeline warm-up (Game.setWarm): make meshes that start hidden renderable while `on`, so their
   * shaders compile behind the boot overlay. The blades skip their draw while the camera is high
   * above the pitch; the warm-up frame draws them regardless.
   */
  setWarmUp(on: boolean): void {
    if (this.blades !== null) this.blades.setWarmUp(on);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    if (this.blades !== null) this.blades.dispose();
    this.textures.blades.dispose();
    this.textures.field.dispose();
    this.textures.pools.dispose();
  }
}

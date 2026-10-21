/**
 * Key lights, fill and shadows: the theme's two directional keys (`ThemeWorld.keys`) and its
 * hemisphere fill (`ThemeWorld.fill`), with the tier's shadows.
 *
 * Why two keys and a dim fill: a floodlit pitch reads as real when one or two dominant lights
 * rake across it and leave proper shadows; an even wash of cross-firing lights (or a bright
 * ambient term) flattens it into a grey card (the prototype study measured near-pitch contrast
 * 0.08 that way, against 0.14 in the concept). At night the keys stand for the floodlight towers
 * on two opposite corners; the theme's floodlight pools and wet streaks are the turf's job
 * (turf/), the lamp heads the stadium's (stadium/).
 *
 * Constant light count: BOTH keys and the fill exist on every tier and theme (3 lights), because
 * a light-count change recompiles every lit material (measured 6-7.5 s on the web). A theme switch
 * rewrites colours, intensities and directions (uniforms) and refits the shadow frustums (CPU
 * only). The tier decides how many keys cast shadows (`TierSpec.shadowedKeys`: none on low, keys[0]
 * first, the brighter one); a tier switch rebuilds the views and the post chain anyway, so the
 * castShadow change recompiles nothing extra.
 *
 * Shadows: only cars and the ball cast (they set `castShadow`); the floor receives. Each shadow
 * frustum is an orthographic box fitted to the arena (field + goals, floor to ceiling) seen from
 * its key's direction, refitted whenever that direction changes (setTheme).
 *
 * Units: uu (1 uu ~ 1 cm); colours are linear-light RGB from theme.ts.
 */
import * as THREE from 'three/webgpu';
import { ARENA } from '../../sim/constants';
import { tier, type Quality, type TierSpec } from '../quality';
import { themeWorld, type ThemeId } from '../theme';

/**
 * Distance of each key from the field centre along its direction (uu). A directional light only
 * uses its direction; this keeps the light outside the arena box so the fitted frustum's near
 * plane sits in front of everything that casts (the arena's half-diagonal is about 7800 uu).
 */
const KEY_DISTANCE = 12000;
/** Depth bias (normalised shadow depth, ~2 uu over the fitted range) and normal offset (uu). */
const SHADOW_BIAS = -0.00015;
const SHADOW_NORMAL_BIAS = 2;

const _v = new THREE.Vector3();

export type KeyLights = readonly [THREE.DirectionalLight, THREE.DirectionalLight];

export interface Lighting {
  /** The theme's two key lights; keys[0] is the brighter one and the first to cast shadows. */
  readonly keys: KeyLights;
  /** keys[0] (the alias the Renderer exposes as `sun`). */
  readonly sun: THREE.DirectionalLight;
  /** Hemisphere fill (the theme's `fill.sky` / `fill.ground` / `fill.intensity`). */
  readonly hemi: THREE.HemisphereLight;
  /**
   * Apply the tier: which keys cast shadows, their map size and PCF radius. Only as part of a full
   * tier switch (Game.setQuality rebuilds every lit material right after): three r186 shares one
   * light node per light, so the first material built after a key stops casting frees that key's
   * shadow map, and any older material still sampling it crashes in ShadowNode.updateShadow.
   * `spec`: the tier's switches as the device runs them (capabilities.ts adjustTier), default tier(q).
   */
  setQuality(quality: Quality, spec?: TierSpec): void;
  /** Rewrite the keys and the fill from the theme (uniform writes + frustum refits; never changes the light count). */
  setTheme(theme: ThemeId): void;
  /** Remove the lights from the scene and free the shadow maps. */
  dispose(): void;
}

function makeKey(name: string): THREE.DirectionalLight {
  const key = new THREE.DirectionalLight(0xffffff, 1);
  key.name = name;
  key.target.position.set(0, 0, 0);
  key.shadow.bias = SHADOW_BIAS;
  key.shadow.normalBias = SHADOW_NORMAL_BIAS;
  return key;
}

/** Add the two keys (+ their targets) and the fill to `scene`, set up for tier `quality` and theme `theme`. */
export function createLighting(scene: THREE.Scene, quality: Quality, theme: ThemeId): Lighting {
  const keys: KeyLights = [makeKey('key-0'), makeKey('key-1')];
  for (const key of keys) scene.add(key, key.target);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
  hemi.name = 'fill';
  scene.add(hemi);

  const setTheme = (id: ThemeId): void => {
    const world = themeWorld(id);
    for (let i = 0; i < keys.length; i++) {
      const spec = world.keys[i];
      const key = keys[i];
      key.color.setRGB(spec.color[0], spec.color[1], spec.color[2]);
      key.intensity = spec.intensity;
      key.position.set(spec.dir[0], spec.dir[1], spec.dir[2]).multiplyScalar(KEY_DISTANCE);
      fitShadowFrustum(key);
    }
    const fill = world.fill;
    hemi.color.setRGB(fill.sky[0], fill.sky[1], fill.sky[2]);
    hemi.groundColor.setRGB(fill.ground[0], fill.ground[1], fill.ground[2]);
    hemi.intensity = fill.intensity;
  };

  const setQuality = (q: Quality, spec: TierSpec = tier(q)): void => {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      key.castShadow = i < spec.shadowedKeys;
      // three's ShadowNode resizes its render target from `mapSize` on every shadow render, so only
      // the size changes here (disposing / nulling `shadow.map` would orphan the node's target). A
      // key that stops casting has its shadow node (and map) freed by three when the rebuilt views'
      // materials set up their lights without it.
      const size = spec.shadowMapSize;
      if (key.shadow.mapSize.x !== size) {
        key.shadow.mapSize.set(size, size);
        key.shadow.needsUpdate = true;
      }
      key.shadow.radius = spec.shadowRadius;
    }
  };

  setTheme(theme);
  setQuality(quality);

  return {
    keys,
    sun: keys[0],
    hemi,
    setQuality,
    setTheme,
    dispose() {
      for (const key of keys) {
        scene.remove(key, key.target);
        key.dispose();
      }
      scene.remove(hemi);
      hemi.dispose();
    },
  };
}

/** Orthographic shadow frustum of `key` fitted to the arena box (field + goals, floor to ceiling). */
function fitShadowFrustum(key: THREE.DirectionalLight): void {
  key.updateMatrixWorld(true);
  key.target.updateMatrixWorld(true);
  key.shadow.updateMatrices(key);
  const inv = key.shadow.camera.matrixWorldInverse;
  const hx = ARENA.extentX + 200;
  const hz = ARENA.extentY + ARENA.goalDepth + 200;
  const top = ARENA.height + 100;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    _v.set(i & 1 ? hx : -hx, i & 2 ? top : -50, i & 4 ? hz : -hz).applyMatrix4(inv);
    if (_v.x < minX) minX = _v.x;
    if (_v.x > maxX) maxX = _v.x;
    if (_v.y < minY) minY = _v.y;
    if (_v.y > maxY) maxY = _v.y;
    if (_v.z < minZ) minZ = _v.z;
    if (_v.z > maxZ) maxZ = _v.z;
  }
  const sc = key.shadow.camera;
  sc.left = minX;
  sc.right = maxX;
  sc.bottom = minY;
  sc.top = maxY;
  // The shadow camera looks down its -z axis, so points in front have negative z.
  sc.near = Math.max(1, -maxZ - 100);
  sc.far = -minZ + 100;
  sc.updateProjectionMatrix();
}

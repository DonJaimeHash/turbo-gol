/**
 * Key light, fill and shadows (moved from Renderer.ts): one shadow-casting directional key light
 * and a hemisphere fill, the tier's shadow map size and PCF radius. The post and lighting phase of
 * docs/visuals/REWORK.md turns it into the theme's two keys (`TierSpec.shadowedKeys` of them cast
 * shadows) and fill behind this same API; the light count must not change between themes (a
 * light-count change recompiles every lit material).
 *
 * Shadows: only cars and the ball cast (they set `castShadow`); the floor receives. The shadow
 * frustum is an orthographic box fitted once to the arena (field + goals, floor to ceiling).
 */
import * as THREE from 'three/webgpu';
import { ARENA } from '../../sim/constants';
import { tier, type Quality } from '../quality';
import type { ThemeId } from '../theme';

const SUN_COLOR = 0xfff3e2;
const SUN_INTENSITY = 3.2;

const _v = new THREE.Vector3();

export interface Lighting {
  /** Key light (the only shadow caster). Cars and the ball set `castShadow`; the floor receives. */
  readonly sun: THREE.DirectionalLight;
  /** Hemisphere fill. */
  readonly hemi: THREE.HemisphereLight;
  /** Apply the tier's shadow map size and PCF radius. */
  setQuality(quality: Quality): void;
  /** The stadium theme changed (one theme so far: nothing to rewrite; never changes the light count). */
  setTheme(theme: ThemeId): void;
  /** Remove the lights from the scene and free the shadow map. */
  dispose(): void;
}

/** Add the key light (+ its target) and the fill to `scene`, set up for tier `quality`. */
export function createLighting(scene: THREE.Scene, quality: Quality, theme: ThemeId): Lighting {
  void theme; // one theme so far

  // Key light at ~41° elevation so a grounded car's shadow sticks out beside / behind it
  // (at 50°+ the whole shadow hides under the car).
  const sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.position.set(3800, 5000, -4200);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 2; // uu
  sun.shadow.radius = 4;
  scene.add(sun, sun.target);
  fitShadowFrustum(sun);

  // Floodlit stadium: bright cool sky light, green turf bounce from below (undersides pick up a green tint).
  const hemi = new THREE.HemisphereLight(0xc5d4ff, 0x2a5a30, 1.5);
  scene.add(hemi);

  const setQuality = (q: Quality): void => {
    const spec = tier(q);
    // three's ShadowNode resizes its render target from `mapSize` on every shadow render, so only
    // the size changes here (disposing / nulling `shadow.map` would orphan the node's target).
    const size = spec.shadowMapSize;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.needsUpdate = true;
    }
    sun.shadow.radius = spec.shadowRadius;
  };
  setQuality(quality);

  return {
    sun,
    hemi,
    setQuality,
    setTheme() {
      // One theme so far: nothing to rewrite.
    },
    dispose() {
      scene.remove(sun, sun.target, hemi);
      sun.dispose();
      hemi.dispose();
    },
  };
}

/** Orthographic shadow frustum fitted to the arena box (field + goals, floor to ceiling). */
function fitShadowFrustum(sun: THREE.DirectionalLight): void {
  sun.updateMatrixWorld(true);
  sun.target.updateMatrixWorld(true);
  sun.shadow.updateMatrices(sun);
  const inv = sun.shadow.camera.matrixWorldInverse;
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
  const sc = sun.shadow.camera;
  sc.left = minX;
  sc.right = maxX;
  sc.bottom = minY;
  sc.top = maxY;
  // The shadow camera looks down its -z axis, so points in front have negative z.
  sc.near = Math.max(1, -maxZ - 100);
  sc.far = -minZ + 100;
  sc.updateProjectionMatrix();
}

/**
 * The world around the stadium, behind one small API the Renderer calls: the sky dome, the
 * image-based lighting environment (PMREM), and the fog and clear colour that blend the far stands
 * into the sky's horizon.
 *
 * Today this is the night sky of before (sky.ts) and the procedural stadium environment
 * (environment.ts), the same on every tier and theme. The world phase of docs/visuals/REWORK.md
 * replaces both with a sky + backdrop baked into a cube map at the tier's skyCubeSize / envSize
 * (cached in IndexedDB) and re-baked by setTheme, without touching the Renderer.
 */
import * as THREE from 'three/webgpu';
import type { Quality } from '../quality';
import type { ThemeId } from '../theme';
import { buildEnvironment } from './environment';
import { buildSkyDome, HORIZON } from './sky';

/** Linear fog from the stands outward (uu): the stands (6000-10000 uu away) are barely touched. */
const FOG_NEAR = 12000;
const FOG_FAR = 40000;

export interface World {
  /**
   * Load-time work (a bake, a cache read) is done: Renderer.create awaits it behind the boot
   * overlay. Resolved at once today (nothing is baked).
   */
  readonly ready: Promise<void>;
  /** The quality tier changed (nothing depends on it yet). */
  setQuality(quality: Quality): void;
  /** The stadium theme changed (stored only until the themes phase re-bakes the sky). */
  setTheme(theme: ThemeId): void;
  /** Remove the sky and free the environment (the scene's environment is cleared). */
  dispose(): void;
}

/**
 * Build the world into `scene`: clear colour and fog at the horizon colour, the sky dome (added to
 * the scene, drawn last among opaques) and the PMREM environment (scene.environment).
 */
export function createWorld(gpu: THREE.WebGPURenderer, scene: THREE.Scene, quality: Quality, theme: ThemeId): World {
  const horizon = new THREE.Color(HORIZON.r, HORIZON.g, HORIZON.b);
  gpu.setClearColor(horizon, 1);
  scene.fog = new THREE.Fog(horizon, FOG_NEAR, FOG_FAR);
  scene.background = null;

  const sky = buildSkyDome();
  scene.add(sky);
  const envTarget = buildEnvironment(gpu, scene);
  void quality; // the same sky and environment on every tier and theme for now
  void theme;

  return {
    ready: Promise.resolve(),
    setQuality() {
      // Nothing depends on the tier yet (the baked sky will use its skyCubeSize / envSize).
    },
    setTheme() {
      // One theme so far: nothing to re-bake.
    },
    dispose() {
      scene.remove(sky);
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
      envTarget.dispose();
      scene.environment = null;
    },
  };
}

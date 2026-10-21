/**
 * The pitch: one mesh on the sim's exact floor geometry with the turf material (turfMaterial.ts).
 * ArenaView builds it first and disposes it; the turf phase of docs/visuals/REWORK.md grows it
 * (blade texture baked at load, grass blades near the camera on ultra) behind this same view.
 *
 * Draw calls: 1. Shadows: receives (the cars and the ball cast), never casts.
 */
import * as THREE from 'three/webgpu';
import type { FloatUniform } from '../materials';
import type { Quality } from '../quality';
import type { ThemeId } from '../theme';
import { buildFloorMaterial } from './turfMaterial';

export class TurfView {
  readonly mesh: THREE.Mesh;

  /**
   * `geometry`: the floor (three coords, owned and disposed by this view); `timeU`: the arena's
   * clock uniform (s), shared with the pads. The mesh is added to `parent`.
   */
  constructor(parent: THREE.Object3D, geometry: THREE.BufferGeometry, timeU: FloatUniform, quality: Quality, theme: ThemeId) {
    void quality; // one turf on every tier and theme for now
    void theme;
    this.mesh = new THREE.Mesh(geometry, buildFloorMaterial(timeU));
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.matrixAutoUpdate = false;
    parent.add(this.mesh);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

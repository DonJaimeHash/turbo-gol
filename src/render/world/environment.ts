/**
 * The image-based lighting environment (moved from Renderer.ts; the world phase of
 * docs/visuals/REWORK.md bakes it from the theme's sky and backdrop instead).
 */
import * as THREE from 'three/webgpu';
import { length, mix, normalize, oneMinus, positionWorld, smoothstep, vec3 } from 'three/tsl';

interface Disposable {
  dispose(): void;
}

/** Intensity of the environment on every lit material (scene.environmentIntensity). */
const ENV_INTENSITY = 0.55;

/**
 * Procedural stadium environment map (PMREM, built once): turf below, a stands band at the
 * horizon, a bright rail ring, floodlight banks high up. Paint, glass, rims and the ball reflect
 * it; without it PBR speculars have only the single key light to reflect. Sets
 * `scene.environment` / `environmentIntensity` and returns the PMREM target to dispose.
 */
export function buildEnvironment(gpu: THREE.WebGPURenderer, scene: THREE.Scene): Disposable {
  const env = new THREE.Scene();
  const trash: Disposable[] = [];

  const domeGeo = new THREE.SphereGeometry(50, 32, 16);
  const domeMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  const up = normalize(positionWorld).y;
  const turf = vec3(0.05, 0.13, 0.08);
  const stands = vec3(0.16, 0.2, 0.31);
  const sky = vec3(0.027, 0.047, 0.1);
  const rail = oneMinus(smoothstep(0.0, 0.012, length(up.sub(0.05))));
  domeMat.colorNode = mix(mix(turf, stands, smoothstep(-0.35, 0.0, up)), sky, smoothstep(0.05, 0.3, up)).add(vec3(1.4, 1.8, 2.2).mul(rail));
  env.add(new THREE.Mesh(domeGeo, domeMat));
  trash.push(domeGeo, domeMat);

  const lampMat = new THREE.MeshBasicNodeMaterial();
  lampMat.colorNode = vec3(1.0, 0.95, 0.86).mul(12);
  const lampGeo = new THREE.PlaneGeometry(1, 1);
  trash.push(lampGeo, lampMat);
  const addLamp = (az: number, elev: number, w: number, h: number): void => {
    const m = new THREE.Mesh(lampGeo, lampMat);
    const r = 40;
    m.position.set(Math.cos(az) * Math.cos(elev) * r, Math.sin(elev) * r, Math.sin(az) * Math.cos(elev) * r);
    m.scale.set(w, h, 1);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  for (let i = 0; i < 16; i++) addLamp((i / 16) * Math.PI * 2, (60 + (i % 2) * 12) * (Math.PI / 180), 4, 2);
  for (let i = 0; i < 4; i++) addLamp((i + 0.5) * (Math.PI / 2), 48 * (Math.PI / 180), 9, 5);

  const pmrem = new THREE.PMREMGenerator(gpu);
  const target = pmrem.fromScene(env, 0.04);
  pmrem.dispose();
  for (const d of trash) d.dispose();
  scene.environment = target.texture;
  scene.environmentIntensity = ENV_INTENSITY;
  return target;
}

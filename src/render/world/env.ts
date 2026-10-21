/**
 * Image-based lighting: scene.environment is a PMREM of the real world round the pitch, so paint,
 * glass, the ball and the wet turf reflect the backdrop. Its scene, rendered from the bake origin:
 *
 *   the baked cube   on a big back-faced sphere (sky, clouds, moon or sun, far harbour or canyon)
 *   the live layer   the live layer's geometry (harbour or city) with the 'env' structure material
 *   the pitch        a flat disc under the probe in the theme's lit-turf colour
 *   the floodlights  the theme's lamp heads (theme.ts floodlights) as hot panels, so glossy paint
 *                    shows the stadium's lamps; they are NOT in the visible sky (the stadium draws
 *                    its own heads)
 *
 * The PMREM target is allocated up front (the same layout PMREMGenerator uses) and every later
 * bake re-renders it in place, so scene.environment keeps ONE texture object per size: no
 * material ever sees a new environment node (which would rebuild every lit material). A cached
 * load decodes the stored atlas straight into it (World.ts), so the probe's scene, its materials
 * and the PMREM generator are only built by a real bake.
 */
import * as THREE from 'three/webgpu';
import type { UniformNode } from 'three/webgpu';
import { cameraPosition, cubeTexture, float, length, max, positionWorld, uniform, vec4 } from 'three/tsl';
import type { Floodlight } from '../theme';

/** Floodlight panel size in the environment (uu; a bit larger than the head for a stable highlight). */
const LAMP_W = 760;
const LAMP_H = 440;
/** Number of floodlight slots (theme.ts has eight heads in every theme). */
const LAMP_SLOTS = 8;

export interface EnvParams {
  readonly cube: THREE.CubeTexture;
  readonly turf: readonly [number, number, number];
  readonly lamps: readonly Floodlight[];
  readonly lampRadiance: number;
}

export interface EnvProbe {
  /** The PMREM target (scene.environment = its texture); fixed for the probe's lifetime. */
  readonly target: THREE.RenderTarget;
  /** Re-render the PMREM from the world (a bake or a theme switch). */
  update(params: EnvParams): void;
  dispose(): void;
}

/** Width and height of PMREMGenerator's cube-UV atlas for faces of `size`. */
export function pmremAtlasSize(size: number): [number, number] {
  const cubeSize = 2 ** Math.floor(Math.log2(size));
  return [3 * Math.max(cubeSize, 16 * 7), 4 * cubeSize];
}

/** A render target laid out like PMREMGenerator's own (cube-UV atlas of `size` faces + mips). */
function createPmremTarget(size: number): THREE.RenderTarget {
  const [w, h] = pmremAtlasSize(size);
  const rt = new THREE.RenderTarget(w, h, {
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
    generateMipmaps: false,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: true,
  });
  rt.texture.mapping = THREE.CubeUVReflectionMapping;
  rt.texture.name = 'PMREM.cubeUv';
  (rt.texture as THREE.Texture & { isPMREMTexture?: boolean }).isPMREMTexture = true;
  return rt;
}

interface ProbeScene {
  readonly scene: THREE.Scene;
  /** The live layer's copy (its geometry follows `live.geometry`: the theme's skyline). */
  readonly live: THREE.Mesh | null;
  readonly cube: ReturnType<typeof cubeTexture>;
  readonly turf: UniformNode<'vec3', THREE.Vector3>;
  readonly lamps: readonly { mesh: THREE.Mesh; color: UniformNode<'vec3', THREE.Vector3> }[];
  readonly pmrem: THREE.PMREMGenerator;
  readonly trash: { dispose(): void }[];
}

/**
 * The probe at `origin` with a PMREM of `size`; `live` draws the live layer into it (its geometry is
 * read at every update: World.ts points it at the theme's skyline). The
 * probe's materials carry no glow tag: the PMREM target is a plain colour target.
 */
export function createEnvProbe(gpu: THREE.WebGPURenderer, origin: THREE.Vector3, size: number, live: { geometry: THREE.BufferGeometry; material: THREE.Material } | null): EnvProbe {
  const target = createPmremTarget(size);
  let probe: ProbeScene | null = null;

  function build(): ProbeScene {
    const scene = new THREE.Scene();
    const trash: { dispose(): void }[] = [];
    // the baked world on a sphere (sampled by direction from the probe)
    const skyGeo = new THREE.SphereGeometry(40000, 48, 24);
    const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const blank = new THREE.CubeTexture();
    const cube = cubeTexture(blank);
    const d = positionWorld.sub(cameraPosition);
    skyMat.outputNode = vec4(cube.sample(d.div(max(length(d), 1e-3))).rgb.max(0.0).min(60000.0), float(1.0));
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.position.copy(origin);
    sky.renderOrder = 1000;
    sky.frustumCulled = false;
    scene.add(sky);
    trash.push(skyGeo, skyMat, blank);
    // the live layer (the harbour's or the city's)
    let copy: THREE.Mesh | null = null;
    if (live !== null) {
      copy = new THREE.Mesh(live.geometry, live.material);
      copy.frustumCulled = false;
      scene.add(copy);
    }
    // the pitch under the probe
    const turf: UniformNode<'vec3', THREE.Vector3> = uniform(new THREE.Vector3());
    const turfGeo = new THREE.CircleGeometry(6400, 48).rotateX(-Math.PI / 2);
    const turfMat = new THREE.MeshBasicNodeMaterial({ fog: false });
    turfMat.colorNode = turf;
    const turfMesh = new THREE.Mesh(turfGeo, turfMat);
    turfMesh.frustumCulled = false;
    scene.add(turfMesh);
    trash.push(turfGeo, turfMat);
    // floodlight heads (one material each: colour and strength per lamp)
    const lampGeo = new THREE.PlaneGeometry(LAMP_W, LAMP_H);
    trash.push(lampGeo);
    const lamps: { mesh: THREE.Mesh; color: UniformNode<'vec3', THREE.Vector3> }[] = [];
    for (let i = 0; i < LAMP_SLOTS; i++) {
      const color: UniformNode<'vec3', THREE.Vector3> = uniform(new THREE.Vector3());
      const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, fog: false });
      mat.colorNode = color;
      const mesh = new THREE.Mesh(lampGeo, mat);
      mesh.frustumCulled = false;
      scene.add(mesh);
      lamps.push({ mesh, color });
      trash.push(mat);
    }
    return { scene, live: copy, cube, turf, lamps, pmrem: new THREE.PMREMGenerator(gpu), trash };
  }

  return {
    target,
    update({ cube, turf, lamps, lampRadiance }) {
      if (probe === null) probe = build();
      const p = probe;
      if (p.live !== null && live !== null) p.live.geometry = live.geometry;
      p.cube.value = cube;
      p.turf.value.set(turf[0], turf[1], turf[2]);
      for (let i = 0; i < LAMP_SLOTS; i++) {
        const slot = p.lamps[i];
        const h = lamps[i];
        slot.mesh.visible = h !== undefined && h.strength > 0;
        if (h === undefined) continue;
        slot.mesh.position.set(h.position[0], h.position[1], h.position[2]);
        slot.mesh.lookAt(h.target[0], h.target[1], h.target[2]);
        slot.mesh.updateMatrixWorld(true);
        const k = h.strength * lampRadiance;
        slot.color.value.set(h.color[0] * k, h.color[1] * k, h.color[2] * k);
      }
      p.pmrem.fromScene(p.scene, 0, 10, 80000, { size, position: origin, renderTarget: target });
    },
    dispose() {
      target.dispose();
      if (probe !== null) {
        probe.pmrem.dispose();
        for (const t of probe.trash) t.dispose();
        probe = null;
      }
    },
  };
}

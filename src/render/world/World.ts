/**
 * The world around the stadium, behind one small API the Renderer calls: the sky and backdrop
 * (baked), the live harbour layer, the image-based lighting environment, and the fog and clear
 * colour that blend the stadium into the backdrop's haze.
 *
 * What is drawn per frame (at most 3 draws):
 *
 *   live layer  the near harbour (harbour.ts buildHarbourLive): quay ground, the container yards
 *               just beyond both ends of the field, STS cranes with lattice booms, RMG gantries,
 *               light masts, the cruise ship and the lighthouse, ONE merged mesh with the live
 *               structure material (bakeMaterials.ts), drawn before the dome. Themes without the
 *               harbour collapse it with a uniform (no recompile, the pipeline stays warm).
 *   dome        one back-faced sphere showing the baked cube with parallax correction (dome.ts).
 *   beam        the lighthouse beam (tiers with geometry detail; collapsed when unused).
 *
 * What is baked at load (behind the boot overlay through `ready`) and on every theme or cube-size
 * change, never per frame:
 *
 *   1. mirror cube   from the bake origin mirrored below the sea, sea hidden, live layer shown:
 *                    the sea's reflection source
 *   2. final cube    from the bake origin, tier.skyCubeSize faces, 2x2 supersampled: sky, moon,
 *                    stars, two cloud layers, the far harbour or canyon, the sea; alpha keeps
 *                    1000 / distance
 *   3. proxy         a 32^2 box-filtered depth cube reduced to the dome's per-azimuth lookup
 *   4. environment   PMREM (tier.envSize) of the cube + the live layer + the pitch + the theme's
 *                    floodlight heads (env.ts) = scene.environment
 *
 * Cache (cache.ts, IndexedDB): the cube faces, the proxy, the environment atlas and the lamp light
 * map, keyed by theme, sizes, bake parameters, backend, a hash of the theme's data and a version.
 * The read starts first thing in createWorld (it overlaps building the live layer); a cached load
 * only uploads and decodes (one small shader), no bake shader, CPU skyline or PMREM. Theme
 * switches re-bake (or read the cache) and rewrite uniforms; the materials, the light count and the
 * environment texture object never change, so a theme switch never recompiles a pipeline.
 *
 * Fog: exponential, 1 - exp(-density * distance), colour and density from themeWorld(theme).fog,
 * through ONE fog node created here (scene.fogNode, uniforms only); the clear colour matches it.
 * The backdrop materials apply their own aerial perspective toward the sky's horizon haze.
 *
 * Debug: `#worldnocache` in the URL ignores cached bakes (still writes them); `stats` holds the
 * timings of the bakes so far.
 */
import * as THREE from 'three/webgpu';
import { exp, fog, length, oneMinus, positionView, uniform } from 'three/tsl';
import { tier, type Quality, type TierSpec } from '../quality';
import { themeWorld, type ThemeId, type ThemeWorld } from '../theme';
import { createAtmosphere, type Atmosphere } from './atmosphere';
import { CubeBaker, PROXY_WIDTH, advanceFrame, bakeProxyLUT, createCubeTarget, createProxyLUT, proxyLUTFromData } from './bake';
import { makeSeaMaterial, makeSkyMaterial, makeStructMaterial, type StructMaterial } from './bakeMaterials';
import { cacheKey, copyRows, openCache, readBake, writeBake, type BakeShape, type CachedBake } from './cache';
import { buildCanyon } from './canyon';
import { buildBeam, buildDome, type Beam, type Dome } from './dome';
import { createEnvProbe, pmremAtlasSize, type EnvProbe } from './env';
import type { Lamp } from './geo';
import { LIGHTHOUSE_LANTERN, QUAY, SEA_LEVEL, buildHarbourFar, buildHarbourLive, type HarbourLive } from './harbour';
import { buildLightMap, lightMapFromData, type LightMap } from './lightmap';
import { dirFromAzEl, worldPreset, type SkylineId, type WorldPreset } from './presets';
import { createLatestQueue } from './queue';

/** Where the cube is rendered from: mid-pitch, at chase / broadcast camera height. */
export const BAKE_ORIGIN = new THREE.Vector3(0, 250, 0);
/** Supersampling per axis of the final cube faces. */
const SSAA = 2;
/** Face size of the small depth cube the parallax proxy is reduced from. */
const PROXY_FACE = 32;
/** Bytes of a cached proxy lookup (PROXY_WIDTH x RGBA half floats). */
const LUT_BYTES = PROXY_WIDTH * 4 * 2;

export interface WorldBakeStats {
  readonly theme: ThemeId;
  readonly face: number;
  readonly source: 'bake' | 'cache';
  /** Wall time of the whole step (ms), and its parts for a bake. */
  readonly totalMs: number;
  /** CPU skyline geometry + light map (runs while the bake pipelines compile). */
  readonly geometryMs: number;
  /** From the compile request to its end (includes the overlapped geometry). */
  readonly compileMs: number;
  /** GPU submission of the bake + environment (and the quads' first compiles). */
  readonly renderMs: number;
  /** From createWorld to the end of this step (the first entry: the boot cost of the world). */
  readonly sinceCreateMs: number;
}

export interface World {
  /**
   * The first bake (or cache read) is done: Renderer.create awaits it behind the boot overlay.
   * Never rejects (a failed bake logs and leaves the sky dark).
   */
  readonly ready: Promise<void>;
  /** The quality tier changed: cube / environment sizes, parallax iterations, the beam. */
  setQuality(quality: Quality): void;
  /** The stadium theme changed: re-bake (or read the cache) and rewrite uniforms (no recompile). */
  setTheme(theme: ThemeId): void;
  /** Remove everything from the scene and free every GPU resource. */
  dispose(): void;
  /** Timings of the bakes so far (diagnostics). */
  readonly stats: readonly WorldBakeStats[];
}

/** Bake-only resources, created by the first real bake (a cached load never needs them). */
interface BakeKit {
  readonly scene: THREE.Scene;
  readonly sea: THREE.Mesh;
  readonly struct: StructMaterial;
  readonly mirror: THREE.CubeRenderTarget;
  readonly depth: THREE.CubeRenderTarget;
  /** The live layer drawn with the bake material (mirror pass only: its reflection in the sea). */
  readonly liveBake: THREE.Mesh;
  /** The far skyline of the bake in progress (freed after each bake). */
  readonly far: Map<SkylineId, THREE.Mesh>;
  readonly trash: { dispose(): void }[];
}

/** What a bake / cache read wants: a theme at a tier's sizes. */
interface Want {
  readonly theme: ThemeId;
  readonly spec: TierSpec;
}

type SceneWithFogNode = THREE.Scene & { fogNode: unknown };

const _c = new THREE.Color();

function parallaxIterations(s: TierSpec): number {
  return s.detail === 'high' ? 2 : 1;
}

function proxySsaaOf(s: TierSpec): number {
  return s.detail === 'high' ? 8 : 4;
}

export function createWorld(gpu: THREE.WebGPURenderer, scene: THREE.Scene, quality: Quality, theme: ThemeId): World {
  const created = performance.now();
  const isWebGPU = (gpu.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  const backendName = isWebGPU ? 'webgpu' : 'webgl2';
  const noCache = typeof location !== 'undefined' && location.hash.includes('worldnocache');
  const stats: WorldBakeStats[] = [];
  let spec = tier(quality);
  let disposed = false;

  const keyOf = (w: Want): string => {
    const tw = themeWorld(w.theme);
    const data = JSON.stringify([worldPreset(w.theme), tw.floodlights, tw.fog]);
    return cacheKey(w.theme, w.spec.skyCubeSize, w.spec.envSize, SSAA, proxySsaaOf(w.spec), backendName, data);
  };
  const shapeOf = (w: Want): BakeShape => {
    const [envW, envH] = pmremAtlasSize(w.spec.envSize);
    return { face: w.spec.skyCubeSize, lutBytes: LUT_BYTES, envW, envH };
  };
  // The cache read goes first. Building the live layer (CPU) waits for the database to be open,
  // so that the read's I/O runs while the geometry is built (see realise).
  const first: Want = { theme, spec };
  let early: { key: string; opened: Promise<boolean>; read: Promise<CachedBake | null> } | null = null;
  if (!noCache) {
    const key = keyOf(first);
    early = { key, opened: openCache(), read: readBake(key, shapeOf(first)) };
  }

  // ---- fog: one node for the scene's lifetime (its cache key never changes), uniforms only
  const fogColor = uniform(new THREE.Color());
  const fogDensity = uniform(0);
  (scene as SceneWithFogNode).fogNode = fog(fogColor, oneMinus(exp(length(positionView).mul(fogDensity).negate())));
  scene.fog = null;
  scene.background = null;

  // ---- live layer, dome, beam, environment
  const A: Atmosphere = createAtmosphere();
  // the live layer's geometry is built by the first realise() (placeholder until then)
  let live: HarbourLive | null = null;
  const placeholder = new THREE.BufferGeometry();
  const liveMat = makeStructMaterial(A, 'live');
  const liveOn = liveMat.on as NonNullable<StructMaterial['on']>;
  const liveEnv = { geometry: placeholder, material: makeStructMaterial(A, 'env', liveOn).material };
  const liveMesh = new THREE.Mesh(placeholder, liveMat.material);
  liveMesh.name = 'world-live';
  liveMesh.renderOrder = 999; // before the dome: its depth spares the dome those pixels
  liveMesh.frustumCulled = false;
  liveMesh.castShadow = false;
  liveMesh.receiveShadow = false;
  liveMesh.matrixAutoUpdate = false;
  scene.add(liveMesh);

  let cube = createCubeTarget(spec.skyCubeSize);
  const lutRT = createProxyLUT();
  let lutData: THREE.DataTexture | null = null;
  const baker = new CubeBaker(gpu);
  let dome: Dome = buildDome(cube.texture, lutRT.texture, BAKE_ORIGIN, QUAY, parallaxIterations(spec));
  scene.add(dome.mesh);
  let beam: Beam | null = null;
  // the environment texture exists from the start, so no lit material ever sees it change
  let env: EnvProbe = createEnvProbe(gpu, BAKE_ORIGIN, spec.envSize, liveEnv);
  scene.environment = env.target.texture;
  let kit: BakeKit | null = null;
  const lightMaps = new Map<SkylineId, LightMap | null>();
  /** The theme the cube and uniforms currently show (null before the first bake). */
  let shown: ThemeId | null = null;

  /** The beam exists on tiers with geometry detail; it shows when the theme has a lit harbour. */
  function syncBeam(): void {
    const want = spec.detail === 'high';
    if (want && beam === null) {
      beam = buildBeam();
      const p = LIGHTHOUSE_LANTERN;
      beam.mesh.position.set(p[0], p[1], p[2]);
      beam.mesh.updateMatrix();
      scene.add(beam.mesh);
    } else if (!want && beam !== null) {
      scene.remove(beam.mesh);
      beam.dispose();
      beam = null;
    }
    if (beam !== null) {
      const preset = worldPreset(shown ?? theme);
      beam.on.value = shown !== null && preset.skyline === 'harbour' && preset.lights > 0.05 ? 1 : 0;
      beam.intensity.value = preset.lights;
    }
  }
  syncBeam();

  // ---- per-skyline CPU data
  /** Build the live harbour layer (once) and hand its geometry to every mesh that draws it. */
  function liveLayer(): HarbourLive {
    if (live !== null) return live;
    const l = buildHarbourLive();
    live = l;
    liveMesh.geometry = l.geometry;
    liveEnv.geometry = l.geometry;
    placeholder.dispose();
    return l;
  }
  function lampsOf(skyline: SkylineId): Lamp[] {
    if (skyline === 'harbour') return [...liveLayer().lamps, ...buildHarbourFar(true).lamps];
    return [];
  }
  function lightMapOf(skyline: SkylineId): LightMap | null {
    if (!lightMaps.has(skyline)) {
      const lamps = lampsOf(skyline);
      lightMaps.set(skyline, lamps.length > 0 ? buildLightMap(lamps) : null);
    }
    return lightMaps.get(skyline) ?? null;
  }

  function buildKit(): BakeKit {
    const trash: { dispose(): void }[] = [];
    const bakeScene = new THREE.Scene();
    const skyGeo = new THREE.SphereGeometry(150000, 64, 32);
    const skyMat = makeSkyMaterial(A);
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.position.copy(BAKE_ORIGIN);
    sky.renderOrder = 1000; // last: only fills what the skyline leaves uncovered
    sky.frustumCulled = false;
    bakeScene.add(sky);
    const mirror = createCubeTarget(Math.max(64, spec.skyCubeSize / 2));
    const seaMat = makeSeaMaterial(A, mirror.texture);
    const seaGeo = new THREE.PlaneGeometry(500000, 500000, 1, 1).rotateX(-Math.PI / 2);
    const sea = new THREE.Mesh(seaGeo, seaMat);
    sea.position.y = SEA_LEVEL;
    sea.frustumCulled = false;
    bakeScene.add(sea);
    const struct = makeStructMaterial(A, 'bake');
    const liveBake = new THREE.Mesh(liveLayer().geometry, struct.material);
    liveBake.frustumCulled = false;
    bakeScene.add(liveBake);
    const depth = createCubeTarget(PROXY_FACE);
    trash.push(skyGeo, skyMat, seaGeo, seaMat, struct.material, mirror, depth);
    return { scene: bakeScene, sea, struct, mirror, depth, liveBake, far: new Map(), trash };
  }

  function farMesh(k: BakeKit, preset: WorldPreset): THREE.Mesh {
    let m = k.far.get(preset.skyline);
    if (m !== undefined) return m;
    const geometry = preset.skyline === 'harbour' ? buildHarbourFar(false).geometry : buildCanyon(dirFromAzEl(preset.key.az, Math.max(preset.key.el, 2)), false).geometry;
    m = new THREE.Mesh(geometry as THREE.BufferGeometry, k.struct.material);
    m.frustumCulled = false;
    k.scene.add(m);
    k.far.set(preset.skyline, m);
    return m;
  }

  /** Theme uniforms of every backdrop material, the fog, the clear colour, the layer switches. */
  function applyUniforms(t: ThemeId, preset: WorldPreset, tw: ThemeWorld, face: number): void {
    const texelAngle = Math.PI / 2 / face;
    A.applyPreset(preset, { origin: BAKE_ORIGIN, seaLevel: SEA_LEVEL, starSigma: texelAngle * 0.65 * 520, fogDensity: tw.fog.density });
    A.setLightMap(lightMapOf(preset.skyline));
    liveOn.value = preset.skyline === 'harbour' ? 1 : 0;
    fogColor.value.setRGB(tw.fog.color[0], tw.fog.color[1], tw.fog.color[2]);
    fogDensity.value = tw.fog.density;
    gpu.setClearColor(_c.setRGB(tw.fog.color[0], tw.fog.color[1], tw.fog.color[2]), 1);
    scene.environmentIntensity = tw.fill.env;
    shown = t;
    syncBeam();
  }

  /** Re-render the environment from the current cube (after a bake or a resize). */
  function updateEnv(): void {
    if (shown === null) return;
    const preset = worldPreset(shown);
    const tw = themeWorld(shown);
    advanceFrame(gpu);
    env.update({ cube: cube.texture, turf: preset.envTurf, lamps: tw.floodlights, lampRadiance: preset.envLamp });
  }

  /**
   * The current cube and environment targets have `want`'s sizes. A tier switch that lands while a
   * bake compiles or a cache read is in flight swaps them for other sizes: drawing or decoding the
   * old sizes into them would show garbage (and cache a record that no key can use), so that work
   * is dropped and the queue goes on with the newer wish.
   */
  function fits(want: Want): boolean {
    const [envW, envH] = pmremAtlasSize(want.spec.envSize);
    return cube.width === want.spec.skyCubeSize && env.target.width === envW && env.target.height === envH;
  }

  /** Free a skyline's bake geometry (13 MB for the harbour; rebuilt in ~50 ms by a later bake). */
  function dropFar(k: BakeKit, skyline: SkylineId): void {
    const m = k.far.get(skyline);
    if (m === undefined) return;
    k.scene.remove(m);
    m.geometry.dispose();
    k.far.delete(skyline);
  }

  /**
   * Bake `want` into the current targets (GPU); the cache write runs afterwards. Null when the
   * targets changed size meanwhile (see `fits`).
   */
  async function bake(want: Want, key: string): Promise<WorldBakeStats | null> {
    const t0 = performance.now();
    const preset = worldPreset(want.theme);
    const tw = themeWorld(want.theme);
    const face = want.spec.skyCubeSize;
    if (kit === null) kit = buildKit();
    const k = kit;
    // Start compiling every bake pipeline (sky, sea, structures: the live layer's bake mesh carries
    // the structure material, so the far skyline need not exist yet), then build the CPU data while
    // the GPU process compiles in parallel.
    for (const m of k.far.values()) m.visible = false;
    k.sea.visible = true;
    k.liveBake.visible = true;
    const tc = performance.now();
    const compiling = baker.compile(k.scene, face * SSAA);
    const far = farMesh(k, preset);
    for (const m of k.far.values()) m.visible = m === far;
    const hasSea = preset.skyline === 'harbour';
    k.liveBake.visible = hasSea;
    k.sea.visible = hasSea;
    const lm = lightMapOf(preset.skyline);
    const geometryMs = performance.now() - tc;
    await compiling;
    const compileMs = performance.now() - tc;
    if (disposed) throw new Error('world disposed during a bake');
    if (!fits(want)) {
      dropFar(k, preset.skyline);
      return null;
    }

    // ---- synchronous from here: no frame renders between the new uniforms and the new cube
    const tr = performance.now();
    applyUniforms(want.theme, preset, tw, face);
    // 1. reflection source, from the mirrored origin, without the sea
    if (hasSea) {
      const mf = Math.max(64, face / 2);
      if (k.mirror.width !== mf) k.mirror.setSize(mf, mf);
      k.sea.visible = false;
      k.liveBake.visible = true;
      baker.render(k.scene, k.mirror, new THREE.Vector3(BAKE_ORIGIN.x, 2 * SEA_LEVEL - BAKE_ORIGIN.y, BAKE_ORIGIN.z), 1);
      k.sea.visible = true;
    }
    // 2. the backdrop itself (the live layer is drawn live, not baked), RGBE-encoded for the cache
    k.liveBake.visible = false;
    const enc = new THREE.RenderTarget(face, face, { type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false });
    enc.texture.minFilter = THREE.NearestFilter;
    enc.texture.magFilter = THREE.NearestFilter;
    const reads = baker.render(k.scene, cube, BAKE_ORIGIN, SSAA, enc);
    // 3. the parallax proxy (only its alpha = inverse distance is used)
    baker.render(k.scene, k.depth, BAKE_ORIGIN, proxySsaaOf(want.spec));
    bakeProxyLUT(gpu, k.depth.texture, lutRT);
    dome.lut.value = lutRT.texture;
    if (lutData !== null) {
      lutData.dispose();
      lutData = null;
    }
    const lutRead = gpu.readRenderTargetPixelsAsync(lutRT, 0, 0, PROXY_WIDTH, 1);
    // 4. image-based lighting
    updateEnv();
    const envW = env.target.width;
    const envH = env.target.height;
    const envRead = baker.encode2D(env.target.texture, envW, envH);
    // bake-only memory: the SSAA scratch target, the mirror cube (re-allocated next bake) and the
    // far skyline (usually a later visit is a cache hit)
    baker.releaseScratch();
    k.mirror.dispose();
    dropFar(k, preset.skyline);
    const renderMs = performance.now() - tr;

    void storeBake(key, face, reads, lutRead, envRead, envW, envH, lm, enc);
    return { theme: want.theme, face, source: 'bake', totalMs: performance.now() - t0, geometryMs, compileMs, renderMs, sinceCreateMs: performance.now() - created };
  }

  /** Read the encoded results back and store them (best effort, after `ready`). */
  async function storeBake(
    key: string,
    face: number,
    reads: Promise<THREE.TypedArray>[],
    lutRead: Promise<THREE.TypedArray>,
    envRead: Promise<THREE.TypedArray>,
    envW: number,
    envH: number,
    lm: LightMap | null,
    enc: THREE.RenderTarget,
  ): Promise<void> {
    try {
      const faces = await Promise.all(reads);
      const lut = await lutRead;
      const envData = await envRead;
      if (disposed) return;
      const all = new Uint8Array(6 * face * face * 4);
      // WebGL2 reads rows bottom-up: store every image top-down (what the decode quad expects)
      const flip = !isWebGPU;
      for (let i = 0; i < 6; i++) copyRows(faces[i] as Uint8Array, face, face, 4, all, i * face * face * 4, flip);
      const lutOut = new Uint16Array(PROXY_WIDTH * 4);
      lutOut.set((lut as Uint16Array).subarray(0, PROXY_WIDTH * 4));
      const envOut = new Uint8Array(envW * envH * 4);
      copyRows(envData as Uint8Array, envW, envH, 4, envOut, 0, flip);
      await writeBake({
        key,
        savedAt: Date.now(),
        face,
        faces: all.buffer,
        lut: lutOut.buffer,
        env: envOut.buffer,
        envW,
        envH,
        lm: lm !== null ? lm.data.slice().buffer : null,
        lmRes: lm !== null ? lm.res : 0,
        lmRect: lm !== null ? lm.rect : [0, 0, 0, 0],
        lmLayers: lm !== null ? lm.layers : [0, 0],
      });
    } catch (err) {
      console.warn('[world] bake not cached', err);
    } finally {
      enc.dispose();
    }
  }

  /** Show a cached bake: light map, uniforms, decode the faces and the environment, the proxy. */
  function showCached(want: Want, rec: CachedBake): void {
    const preset = worldPreset(want.theme);
    const tw = themeWorld(want.theme);
    const face = want.spec.skyCubeSize;
    if (!lightMaps.has(preset.skyline)) {
      lightMaps.set(preset.skyline, rec.lm !== null ? lightMapFromData(new Uint16Array(rec.lm), rec.lmRes, rec.lmRect, rec.lmLayers) : null);
    }
    applyUniforms(want.theme, preset, tw, face);
    advanceFrame(gpu);
    const bytes = face * face * 4;
    const faces: Uint8Array[] = [];
    for (let i = 0; i < 6; i++) faces.push(new Uint8Array(rec.faces, i * bytes, bytes));
    baker.decodeFaces(cube, faces);
    baker.decode2D(env.target, new Uint8Array(rec.env));
    const next = proxyLUTFromData(new Uint16Array(rec.lut));
    dome.lut.value = next;
    if (lutData !== null) lutData.dispose();
    lutData = next;
  }

  /** Bring the world to `want` (cache or bake). */
  async function realise(want: Want): Promise<void> {
    const t0 = performance.now();
    const face = want.spec.skyCubeSize;
    const key = keyOf(want);
    let rec: CachedBake | null = null;
    if (live === null) {
      // the read's I/O runs while the geometry is built
      if (early !== null) await early.opened;
      liveLayer();
    }
    if (early !== null && early.key === key) rec = await early.read;
    else if (!noCache) rec = await readBake(key, shapeOf(want));
    early = null;
    if (disposed || !fits(want)) return;
    if (rec !== null) {
      showCached(want, rec);
      stats.push({ theme: want.theme, face, source: 'cache', totalMs: performance.now() - t0, geometryMs: 0, compileMs: 0, renderMs: 0, sinceCreateMs: performance.now() - created });
      return;
    }
    const baked = await bake(want, key);
    if (baked !== null) stats.push(baked);
  }

  // ---- serialised work: the latest wanted theme / sizes win (queue.ts)
  const queue = createLatestQueue<Want>(first, (a, b) => keyOf(a) === keyOf(b), realise, {
    alive: () => !disposed,
    onError: (err) => console.error('[world] bake failed', err),
  });
  const ready = queue.request(first);

  return {
    ready,
    stats,
    setQuality(q) {
      const next = tier(q);
      const old = spec;
      spec = next;
      if (disposed) return;
      // cube size: copy the current sky into the new cube now (shown until the re-bake lands)
      if (next.skyCubeSize !== cube.width) {
        const nc = createCubeTarget(next.skyCubeSize);
        baker.copyCube(cube.texture, nc);
        dome.cube.value = nc.texture;
        cube.dispose();
        cube = nc;
      }
      if (parallaxIterations(next) !== parallaxIterations(old)) {
        const nd = buildDome(cube.texture, dome.lut.value as THREE.Texture, BAKE_ORIGIN, QUAY, parallaxIterations(next));
        scene.remove(dome.mesh);
        dome.dispose();
        dome = nd;
        scene.add(dome.mesh);
      }
      syncBeam();
      // environment size: a new probe now (scene.environment changes here, while the views rebuild)
      if (next.envSize !== old.envSize) {
        env.dispose();
        env = createEnvProbe(gpu, BAKE_ORIGIN, next.envSize, liveEnv);
        scene.environment = env.target.texture;
        updateEnv();
      }
      void queue.request({ theme: queue.wanted.theme, spec: next });
    },
    setTheme(t) {
      if (disposed) return;
      void queue.request({ theme: t, spec });
    },
    dispose() {
      disposed = true;
      scene.remove(liveMesh, dome.mesh);
      if (live !== null) live.geometry.dispose();
      placeholder.dispose();
      liveMat.material.dispose();
      liveEnv.material.dispose();
      dome.dispose();
      if (beam !== null) {
        scene.remove(beam.mesh);
        beam.dispose();
        beam = null;
      }
      env.dispose();
      cube.dispose();
      lutRT.dispose();
      if (lutData !== null) lutData.dispose();
      baker.dispose();
      if (kit !== null) {
        for (const m of kit.far.values()) m.geometry.dispose();
        for (const d of kit.trash) d.dispose();
        kit = null;
      }
      for (const lm of lightMaps.values()) lm?.texture.dispose();
      lightMaps.clear();
      A.dispose();
      (scene as SceneWithFogNode).fogNode = null;
      scene.environment = null;
    },
  };
}

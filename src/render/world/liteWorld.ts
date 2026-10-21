/**
 * The world of the tiers with `world: 'lite'` (super low, quality.ts): the same `World` API as
 * World.ts with nothing baked, cached or rendered off screen. One draw: a gradient dome from the
 * theme's sky colours (world/presets.ts zenith, mid, horizon, the horizon glow toward its azimuth,
 * the moon or sun disc with a short halo) over a flat silhouette of the place along the horizon
 * (a blocky skyline for the harbour, mesas for the canyon, peaks for the valley: a few hashes of
 * the dome's azimuth, no geometry) and the ground below it.
 *
 * What it leaves out, and why (docs/visuals/REWORK.md "Super low"): the HalfFloat sky cube, its
 * 2x supersampled scratch target, the mirror cube, the proxy lookup and the PMREM environment
 * (about 15 MB of half-float targets, a bake or a decode on every load, and a format a WebGL2
 * device may not render at all), the live near layer (35-52k triangles never culled), the
 * IndexedDB cache, the environment map (scene.environment stays null: the super low materials
 * are Lambert and unlit) and the fog (an exp per fragment of every material). So the boot builds
 * one small material and the frame pays one dome draw.
 *
 * Per pixel: about forty ALU operations from the dome's uv (elevation and azimuth: no atan, no
 * texture). A theme switch writes uniforms only.
 */
import * as THREE from 'three/webgpu';
import { abs, dot, floor, fract, hash, max, mix, normalize, positionGeometry, saturate, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import type { Vec3Node } from '../materials';
import type { Quality } from '../quality';
import { themeWorld, type Rgb, type ThemeId } from '../theme';
import { DOME_RADIUS } from './dome';
import { dirFromAzEl, worldPreset, type SkylineId } from './presets';
import type { World } from './World';

/** Dome centre: the baked world's bake origin (mid-pitch, chase-camera height). */
const ORIGIN = new THREE.Vector3(0, 250, 0);

/** The silhouette of each place: base and peak height (radians above the horizon), blockiness, columns round the dome. */
const SKYLINES: Readonly<Record<SkylineId, { readonly base: number; readonly amp: number; readonly block: number; readonly cols: number }>> = {
  harbour: { base: 0.004, amp: 0.03, block: 1, cols: 140 },
  canyon: { base: 0.012, amp: 0.055, block: 0.55, cols: 46 },
  alpine: { base: 0.02, amp: 0.15, block: 0, cols: 18 },
};

const v = (c: Rgb): THREE.Vector3 => new THREE.Vector3(c[0], c[1], c[2]);

export function createLiteWorld(gpu: THREE.WebGPURenderer, scene: THREE.Scene, quality: Quality, theme: ThemeId): World {
  void quality;
  const sceneWithFog = scene as THREE.Scene & { fogNode: unknown };
  sceneWithFog.fogNode = null;
  scene.fog = null;
  scene.background = null;
  scene.environment = null;

  const U = {
    zenith: uniform(new THREE.Vector3()),
    mid: uniform(new THREE.Vector3()),
    horizon: uniform(new THREE.Vector3()),
    glow: uniform(new THREE.Vector3()),
    glowDir: uniform(new THREE.Vector3(0, 0, 1)),
    glowSpread: uniform(0.6),
    glowHeight: uniform(0.08),
    keyDir: uniform(new THREE.Vector3(0, 1, 0)),
    keyColor: uniform(new THREE.Vector3()),
    keyCos: uniform(0.9999),
    haloColor: uniform(new THREE.Vector3()),
    ground: uniform(new THREE.Vector3()),
    far: uniform(new THREE.Vector3()),
    base: uniform(0),
    amp: uniform(0),
    block: uniform(0),
    cols: uniform(64),
  };

  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  material.name = 'world-lite-sky';
  const t = uv();
  // Elevation in radians from the sphere's v (0 at the bottom pole, 1 at the top), azimuth 0..1.
  const el = t.y.sub(0.5).mul(Math.PI);
  const az = t.x;
  const dir = normalize(positionGeometry);
  // The gradient: horizon -> mid in the first ~15 degrees, mid -> zenith above.
  const up = el.max(0.0);
  let sky: Vec3Node = mix(U.horizon, U.mid, smoothstep(0.0, 0.26, up));
  sky = mix(sky, U.zenith, smoothstep(0.2, 1.1, up));
  // The horizon glow (city light or sunset) toward its azimuth, hugging the horizon.
  const toward = saturate(dot(normalize(vec3(dir.x, 0.0, dir.z).add(vec3(0.0, 0.0, 1e-4))), U.glowDir).mul(0.5).add(0.5));
  const lobe = toward.mul(toward).mul(U.glowSpread).add(U.glowSpread.oneMinus());
  sky = sky.add(U.glow.mul(lobe).mul(saturate(up.div(U.glowHeight).oneMinus())));
  // The moon or the sun: a disc and a short halo (about 8 degrees, falling off as t^4).
  const k = dot(dir, U.keyDir);
  const disc = smoothstep(U.keyCos.sub(0.00015), U.keyCos, k);
  const ht = saturate(k.sub(0.99).div(0.01));
  const h2 = ht.mul(ht);
  sky = sky.add(U.keyColor.mul(disc)).add(U.haloColor.mul(h2.mul(h2)));
  // The place's silhouette along the horizon: blocks (a skyline) or peaks, from the azimuth.
  const col = az.mul(U.cols);
  const blocky = hash(floor(col));
  const tri = abs(fract(col).sub(0.5)).mul(2.0).oneMinus();
  const peaks = tri.mul(hash(floor(col).add(17.0)).mul(0.6).add(0.4));
  const h = U.base.add(U.amp.mul(mix(peaks, blocky, U.block)));
  const aa = 0.004;
  const inLand = smoothstep(h.add(aa), h.sub(aa), el);
  // The silhouette fades toward the horizon colour at its top (distance haze).
  const land = mix(U.ground, U.far, saturate(el.div(h.max(1e-3))));
  const below = smoothstep(0.0, -0.05, el);
  let colOut: Vec3Node = mix(sky, land, inLand);
  colOut = mix(colOut, U.ground, below);
  material.colorNode = max(colOut, vec3(0, 0, 0));

  const geometry = new THREE.SphereGeometry(DOME_RADIUS, 48, 24);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'world-lite-sky';
  mesh.position.copy(ORIGIN);
  // Last among the opaque objects: every pixel the stadium covers is spared by the depth test.
  mesh.renderOrder = 1000;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  scene.add(mesh);

  const clear = new THREE.Color();
  function apply(id: ThemeId): void {
    const p = worldPreset(id);
    const tw = themeWorld(id);
    U.zenith.value.copy(v(p.zenith));
    U.mid.value.copy(v(p.mid));
    U.horizon.value.copy(v(p.horizon));
    U.glow.value.copy(v(p.glow.color));
    const g = dirFromAzEl(p.glow.az, 0);
    U.glowDir.value.set(g[0], 0, g[2]).normalize();
    U.glowSpread.value = p.glow.spread;
    U.glowHeight.value = p.glow.height * 2.2;
    const kd = dirFromAzEl(p.key.az, p.key.el);
    U.keyDir.value.set(kd[0], kd[1], kd[2]);
    // The disc's own brightness is far above 1 (the baked sky holds HDR radiance): a soft cap keeps
    // a bright, small disc after the tone curve without a white blob.
    const discGain = Math.min(p.key.disc, 6);
    U.keyColor.value.copy(v(p.key.color)).multiplyScalar(discGain);
    U.keyCos.value = Math.cos(((p.key.sizeDeg * 0.5) * Math.PI) / 180);
    U.haloColor.value.copy(v(p.key.color)).multiplyScalar(Math.min(1, p.key.halo + p.key.halo2));
    // The ground and the silhouette: the backdrop's shadowed colour (ambient on the ground, a
    // little of the horizon haze), lit windows by night lifting the harbour a touch.
    const amb = v(p.ambGround).multiplyScalar(2.2).add(v(p.horizon).multiplyScalar(0.22));
    U.ground.value.copy(amb);
    U.far.value.copy(amb).lerp(v(p.horizon), 0.55);
    const sk = SKYLINES[p.skyline];
    U.base.value = sk.base;
    U.amp.value = sk.amp;
    U.block.value = sk.block;
    U.cols.value = sk.cols;
    const f = tw.fog.color;
    gpu.setClearColor(clear.setRGB(f[0], f[1], f[2]), 1);
  }
  apply(theme);

  return {
    ready: Promise.resolve(),
    stats: [],
    settled: () => Promise.resolve(),
    setQuality() {
      /* one look on every tier that uses it */
    },
    setTheme(id) {
      apply(id);
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}


/**
 * Atmosphere: the theme uniforms and the TSL functions shared by the backdrop materials (the bake
 * materials and the live harbour layer, bakeMaterials.ts).
 *
 *   skyRadiance(dir)   the sky: gradient, horizon glow (light pollution or sunset), the moon or the
 *                      sun with its halo, a star field, a high thin cloud layer and a low layer of
 *                      domain-warped fbm cumulus, both lit from above by the key body and from
 *                      below by the horizon glow (the city).
 *   hazeColor(dir)     the colour the sky has AT the horizon in that azimuth: aerial perspective
 *                      fades distant geometry into exactly this colour, so the skyline melts into
 *                      the sky with no seam.
 *   aerialFog(col, wp, eye)  height-dependent exponential haze along the segment eye -> wp.
 *   shade(alb, n, wp, vis)   cheap lighting of backdrop surfaces: key light (moon / sun),
 *                      hemispheric ambient, a horizontal "city glow" bounce, and the yard lamps from
 *                      the CPU light map (lightmap.ts).
 *
 * Compile time matters more than ALU here (the sky only runs while baking): every helper is a real
 * WGSL / GLSL function (`setLayout`) so call sites do not inline copies, and the noise is a compact
 * value-noise fbm in a loop instead of unrolled Perlin octaves.
 *
 * NaN hygiene: every pow() base is clamped to >= 0, every division has a floor, every normalize
 * of a possibly-zero vector is a safe division.
 */
import * as THREE from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import { Fn, Loop, abs, dot, exp, float, floor, fract, length, max, min, mix, normalize, oneMinus, pow, saturate, smoothstep, step, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import type { LightMap } from './lightmap';
import { dirFromAzEl, type CloudPreset, type WorldPreset } from './presets';

type F = Node<'float'>;
type V2 = Node<'vec2'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

interface LayoutInput {
  readonly name: string;
  readonly type: string;
}

/** A TSL function compiled as a real shader function (one copy per shader, not one per call site). */
function layoutFn<A extends readonly Node[], R extends Node>(name: string, type: string, inputs: readonly (readonly [string, string])[], body: (args: A) => R): (...args: A) => R {
  const layoutInputs: LayoutInput[] = inputs.map(([n, t]) => ({ name: n, type: t }));
  const f = Fn((args: A) => body(args)).setLayout({ name, type, inputs: layoutInputs });
  return f as unknown as (...args: A) => R;
}

// ------------------------------------------------------------------------------------------ noise
// Hashes ("hash without sine", D. Hoskins): stable in float32 for coordinates up to ~1e5. They read
// no uniforms, so one instance serves every material.

export const hash13 = layoutFn<[V3], F>('wHash13', 'float', [['p', 'vec3']], ([p]) => {
  const p3 = fract(p.mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

export const hash33 = layoutFn<[V3], V3>('wHash33', 'vec3', [['p', 'vec3']], ([p]) => {
  const p3 = fract(p.mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yxz.add(33.33)));
  return fract(p3.xxy.add(p3.yxx).mul(p3.zyx));
});

export const hash12 = layoutFn<[V2], F>('wHash12', 'float', [['p', 'vec2']], ([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

/** 3D value noise in [0, 1], C1-smooth. */
export const vnoise = layoutFn<[V3], F>('wVnoise', 'float', [['p', 'vec3']], ([p]) => {
  const i = floor(p).toVar();
  const f = fract(p);
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0)).toVar();
  const a = mix(hash13(i), hash13(i.add(vec3(1, 0, 0))), u.x);
  const b = mix(hash13(i.add(vec3(0, 1, 0))), hash13(i.add(vec3(1, 1, 0))), u.x);
  const c = mix(hash13(i.add(vec3(0, 0, 1))), hash13(i.add(vec3(1, 0, 1))), u.x);
  const d = mix(hash13(i.add(vec3(0, 1, 1))), hash13(i.add(vec3(1, 1, 1))), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
});

/** fbm in [0, ~1]: `octaves` value-noise layers, each rotated and offset to hide the grid. */
function makeFbm(octaves: number): (p: V3) => F {
  return layoutFn<[V3], F>('wFbm' + octaves, 'float', [['p', 'vec3']], ([p]) => {
    const q = p.toVar();
    const s = float(0.0).toVar();
    const a = float(0.5).toVar();
    Loop(octaves, () => {
      s.addAssign(vnoise(q).mul(a));
      // rotate ~37 deg about y, scale 2.03, offset
      q.assign(vec3(q.x.mul(0.8).sub(q.z.mul(0.6)), q.y, q.x.mul(0.6).add(q.z.mul(0.8))).mul(2.03).add(vec3(1.7, 9.2, 3.1)));
      a.mulAssign(0.5);
    });
    return s.div(1.0 - Math.pow(0.5, octaves));
  });
}
export const fbm3 = makeFbm(3);
export const fbm5 = makeFbm(5);
export const fbm6 = makeFbm(6);

// -------------------------------------------------------------------------------------- uniforms

type U3 = UniformNode<'vec3', THREE.Vector3>;
type U1 = UniformNode<'float', number>;
type U2 = UniformNode<'vec2', THREE.Vector2>;
type U4 = UniformNode<'vec4', THREE.Vector4>;

function v3(): U3 {
  return uniform(new THREE.Vector3());
}

/** One cloud layer's uniforms. */
interface CloudUniforms {
  readonly cover: U1;
  readonly scale: U1;
  readonly height: U1;
  readonly stretch: U1;
  readonly lit: U3;
  readonly shadow: U3;
  readonly under: U3;
  readonly alpha: U1;
}

function cloudUniforms(): CloudUniforms {
  return { cover: uniform(0.5), scale: uniform(0.5), height: uniform(0.085), stretch: uniform(1), lit: v3(), shadow: v3(), under: v3(), alpha: uniform(0.9) };
}

export interface AtmosphereUniforms {
  /** Bake origin (aerial perspective of the bake; the live layer uses the camera). */
  readonly origin: U3;
  readonly seaLevel: U1;
  readonly zenith: U3;
  readonly mid: U3;
  readonly horizon: U3;
  readonly glowColor: U3;
  readonly glowDir: U3;
  readonly glowSpread: U1;
  readonly glowHeight: U1;
  readonly keyDir: U3;
  readonly keyXZ: U2;
  readonly keyT1: U3;
  readonly keyT2: U3;
  readonly keySin: U1;
  readonly keyColor: U3;
  readonly keyDisc: U1;
  readonly keyHalo: U1;
  readonly keyHalo2: U1;
  readonly isMoon: U1;
  readonly keyLight: U3;
  readonly ambSky: U3;
  readonly ambGround: U3;
  readonly stars: U1;
  readonly starSigma: U1;
  readonly low: CloudUniforms;
  readonly high: CloudUniforms;
  readonly fogDensity: U1;
  readonly fogHeight: U1;
  readonly lightsOn: U1;
  readonly windows: U1;
  readonly seaColor: U3;
  readonly seaRough: U1;
  /** Light map: xz rectangle covered (x0, z0, w, d) and the two layer heights. */
  readonly lmRect: U4;
  readonly lmY: U2;
}

export interface AtmosphereFunctions {
  readonly azWeight: (dir: V3) => F;
  readonly hazeColor: (dir: V3) => V3;
  readonly skyRadiance: (dir: V3) => V3;
  readonly aerialFog: (col: V3, wp: V3, eye: V3) => V3;
  readonly shade: (alb: V3, n: V3, wp: V3, vis: F) => V3;
}

export interface Atmosphere {
  readonly U: AtmosphereUniforms;
  /** Build the uniform-reading helpers for ONE material (see the note in `functions`). */
  functions(): AtmosphereFunctions;
  /** Write a world preset into the uniforms. */
  applyPreset(p: WorldPreset, opts: { origin: THREE.Vector3; seaLevel: number; starSigma: number; fogDensity: number }): void;
  /** Point the shaders at a skyline's light map (or the empty one). */
  setLightMap(lm: LightMap | null): void;
  dispose(): void;
}

const _kd = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _yUp = new THREE.Vector3(0, 1, 0);

export function createAtmosphere(): Atmosphere {
  const U: AtmosphereUniforms = {
    origin: v3(),
    seaLevel: uniform(-400),
    zenith: v3(),
    mid: v3(),
    horizon: v3(),
    glowColor: v3(),
    glowDir: v3(),
    glowSpread: uniform(0.5),
    glowHeight: uniform(0.1),
    keyDir: v3(),
    keyXZ: uniform(new THREE.Vector2(1, 0)),
    keyT1: v3(),
    keyT2: v3(),
    keySin: uniform(0.02),
    keyColor: v3(),
    keyDisc: uniform(1),
    keyHalo: uniform(0),
    keyHalo2: uniform(0),
    isMoon: uniform(1),
    keyLight: v3(),
    ambSky: v3(),
    ambGround: v3(),
    stars: uniform(1),
    starSigma: uniform(0.5),
    low: cloudUniforms(),
    high: cloudUniforms(),
    fogDensity: uniform(1e-5),
    fogHeight: uniform(3000),
    lightsOn: uniform(1),
    windows: uniform(0.5),
    seaColor: v3(),
    seaRough: uniform(1),
    lmRect: uniform(new THREE.Vector4(-1, -1, 2, 2)),
    lmY: uniform(new THREE.Vector2(0, 3000)),
  };
  const empty = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  empty.needsUpdate = true;
  const lightMap = texture(empty);

  // The uniform-reading helpers are plain (inlined) TSL, not setLayout functions: a layout
  // function keeps the uniform and texture binding names of the first shader build that generates
  // it, and these materials build in several contexts (scene pass, environment, bake targets).
  // Only the uniform-free noise above is shared as real shader functions, and it is the heavy part.
  function functions(): AtmosphereFunctions {
    // glow weight by azimuth: (1 - spread) everywhere + a lobe toward glowDir
    const azWeight = (dir: V3): F => {
      const h = dir.xz.div(max(length(dir.xz), 1e-4));
      const g = saturate(dot(h, U.glowDir.xz).mul(0.5).add(0.5));
      return oneMinus(U.glowSpread).add(U.glowSpread.mul(pow(g, 4.0)).mul(2.2));
    };

    const hazeColor = (dir: V3): V3 => U.horizon.add(U.glowColor.mul(azWeight(dir)));

    // stars: one candidate per cell of a 3D grid around the unit sphere
    const starField = (dir: V3): V3 => {
      const S = 520.0;
      const cell = floor(dir.mul(S).add(4096.0)).toVar();
      const present = step(0.9975, hash13(cell));
      const jitter = hash33(cell.add(19.19)).mul(0.5).add(0.25);
      const sdir = normalize(cell.add(jitter).sub(4096.0));
      const d = length(dir.sub(sdir)).mul(S);
      const bright = pow(hash13(cell.add(71.3)), 9.0).mul(5.0).add(0.12);
      const sig = max(U.starSigma, 1e-3);
      const g = exp(d.mul(d).div(sig.mul(sig)).mul(-0.5));
      const tint = mix(vec3(0.72, 0.8, 1.0), vec3(1.0, 0.85, 0.66), hash13(cell.add(5.1)));
      return tint.mul(present.mul(bright).mul(g).mul(0.11).mul(U.stars));
    };

    // A cloud layer: planar projection, domain-warped fbm, 2-tap "toward the light" shading. The
    // thin high layer skips the warp and the light tap (streaks are lit evenly): it costs one fbm,
    // which keeps the bake's sky shader (its compile time) close to a single layer's.
    const layer = (dir: V3, c: CloudUniforms, seed: number, thin: boolean): V4 => {
      const e = dir.y;
      const q = dir.xz.div(max(e, 0.0).add(max(c.height, 1e-3))).mul(c.scale).mul(vec2(float(1.0).div(max(c.stretch, 0.1)), 1.0)).toVar();
      let n: F;
      let lit01: F;
      if (thin) {
        n = fbm5(vec3(q, seed + 0.37)).toVar();
        lit01 = float(0.6);
      } else {
        const w1 = fbm3(vec3(q.mul(0.33), seed + 3.7));
        const w2 = fbm3(vec3(q.mul(0.33).add(5.2), seed + 8.1));
        const pq = q.add(vec2(w1, w2).sub(0.5).mul(2.3)).toVar();
        n = fbm6(vec3(pq, seed + 0.37)).toVar();
        const nL = fbm5(vec3(pq.add(U.keyXZ.mul(0.2)), seed + 0.37));
        // the side facing the key body is where the density drops toward it
        lit01 = saturate(n.sub(nL).mul(3.6).add(0.45));
      }
      const c0 = oneMinus(c.cover);
      const dens = smoothstep(c0, c0.add(0.13), n).toVar();
      const glowW = azWeight(dir).mul(exp(max(e, 0.0).div(0.2).negate()));
      const top = mix(c.shadow, c.lit, lit01);
      const below = c.under.mul(glowW).mul(mix(float(1.0), float(0.5), lit01));
      const cosK = max(dot(dir, U.keyDir), 0.0);
      const silver = U.keyColor.mul(pow(cosK, 10.0).mul(U.keyHalo2).mul(1.6).add(pow(cosK, 3.0).mul(U.keyHalo).mul(1.5))).mul(oneMinus(dens).mul(0.7).add(0.3));
      const thick = mix(float(1.0), float(0.62), dens.mul(dens));
      const col = top.add(below).mul(thick).add(silver.mul(dens));
      const a = dens.mul(c.alpha).mul(smoothstep(0.0, 0.07, e));
      return vec4(col, a);
    };

    const skyRadiance = (dir: V3): V3 => {
      const e = dir.y;
      const eP = max(e, 0.0);
      const t = oneMinus(exp(eP.mul(-5.0)));
      const grad = mix(mix(U.horizon, U.mid, smoothstep(0.0, 0.6, t)), U.zenith, smoothstep(0.45, 1.0, t));
      const glow = U.glowColor.mul(azWeight(dir)).mul(exp(eP.div(max(U.glowHeight, 1e-3)).negate())).toVar();

      // key body: halo + disc (limb darkening; maria for the moon)
      const cosA = dot(dir, U.keyDir);
      const cP = max(cosA, 0.0);
      const halo = U.keyColor.mul(pow(cP, 6.0).mul(U.keyHalo).add(pow(cP, 160.0).mul(U.keyHalo2))).toVar();
      const lp = vec2(dot(dir, U.keyT1), dot(dir, U.keyT2)).div(max(U.keySin, 1e-4));
      const r = length(lp);
      // (GLSL leaves smoothstep undefined for edge0 >= edge1: always 1 - smoothstep(lo, hi, x))
      const inDisc = oneMinus(smoothstep(0.88, 1.0, r)).mul(step(0.0, cosA));
      const limb = pow(max(oneMinus(min(r.mul(r), 1.0)), 0.0), 0.35);
      const maria = fbm3(vec3(lp.mul(1.9), 2.3));
      const moonTex = mix(float(1.0), smoothstep(0.35, 0.65, maria).mul(0.42).add(0.58), U.isMoon);
      const disc = U.keyColor.mul(U.keyDisc).mul(inDisc).mul(limb.mul(0.55).add(0.45)).mul(moonTex);

      const stars = starField(dir).mul(smoothstep(0.03, 0.3, e));
      const clear = grad.add(glow.mul(0.55)).add(stars).add(disc).add(halo.mul(0.6));
      // high thin layer first (behind), then the low cumulus over it
      const hi = layer(dir, U.high, 41.0, true).toVar();
      const withHigh = mix(clear, hi.rgb, hi.a);
      const lo = layer(dir, U.low, 0.0, false).toVar();
      const col = mix(withHigh, lo.rgb, lo.a).add(glow.mul(0.45)).add(halo.mul(0.4));
      // below the horizon the sky shows the haze (the sea / land normally cover it)
      return mix(col, hazeColor(dir), oneMinus(smoothstep(-0.01, 0.003, e)));
    };

    const aerialFog = (col: V3, wp: V3, eye: V3): V3 => {
      const v = wp.sub(eye);
      const d = length(v);
      const dir = v.div(max(d, 1.0));
      const hAvg = max(wp.y.add(eye.y).mul(0.5).sub(U.seaLevel), 0.0);
      const k = U.fogDensity.mul(exp(hAvg.div(max(U.fogHeight, 1.0)).negate()));
      const f = oneMinus(exp(d.mul(k).negate()));
      return mix(col, hazeColor(dir), f);
    };

    // lamp light from the CPU light map: 4 tiles stacked in v (see lightmap.ts)
    const lampLight = (n: V3, wp: V3): V3 => {
      const uv0 = saturate(wp.xz.sub(U.lmRect.xy).div(U.lmRect.zw)).mul(0.998).add(0.001).toVar();
      const tile = (k: number): V4 => lightMap.sample(vec2(uv0.x, uv0.y.add(k).mul(0.25))) as unknown as V4;
      const t = saturate(wp.y.sub(U.lmY.x).div(max(U.lmY.y.sub(U.lmY.x), 1.0)));
      const up = mix(tile(0), tile(2), t).toVar();
      const side = mix(tile(1), tile(3), t).toVar();
      // dh: mean horizontal direction toward the lamps (length 1 = all from one side, 0 = all round)
      const dh = vec2(up.w, side.w);
      const facing = saturate(dot(n.xz, dh).mul(0.65).add(0.5));
      return max(up.rgb, vec3(0.0)).mul(max(n.y, 0.0)).add(max(side.rgb, vec3(0.0)).mul(oneMinus(abs(n.y))).mul(facing));
    };

    // vis: 0..1 visibility of the key light (baked terrain shadows; 1 for everything else)
    const shade = (alb: V3, n: V3, wp: V3, vis: F): V3 => {
      const key = U.keyLight.mul(max(dot(n, U.keyDir), 0.0)).mul(vis);
      const amb = mix(U.ambGround, U.ambSky, n.y.mul(0.5).add(0.5));
      // vertical faces turned toward the glowing horizon catch a little of it
      const side = U.glowColor.mul(azWeight(n)).mul(oneMinus(abs(n.y))).mul(0.12);
      return alb.mul(key.add(amb).add(side).add(lampLight(n, wp).mul(U.lightsOn)));
    };

    return { azWeight, hazeColor, skyRadiance, aerialFog, shade };
  }

  const set3 = (u: U3, a: readonly [number, number, number]): void => {
    u.value.set(a[0], a[1], a[2]);
  };
  const setCloud = (u: CloudUniforms, c: CloudPreset): void => {
    u.cover.value = c.cover;
    u.scale.value = c.scale;
    u.height.value = c.height;
    u.stretch.value = c.stretch;
    set3(u.lit, c.lit);
    set3(u.shadow, c.shadow);
    set3(u.under, c.under);
    u.alpha.value = c.alpha;
  };

  return {
    U,
    functions,
    applyPreset(p, { origin, seaLevel, starSigma, fogDensity }) {
      U.origin.value.copy(origin);
      U.seaLevel.value = seaLevel;
      set3(U.zenith, p.zenith);
      set3(U.mid, p.mid);
      set3(U.horizon, p.horizon);
      set3(U.glowColor, p.glow.color);
      set3(U.glowDir, dirFromAzEl(p.glow.az, 0));
      U.glowSpread.value = p.glow.spread;
      U.glowHeight.value = p.glow.height;
      _kd.set(...dirFromAzEl(p.key.az, p.key.el));
      U.keyDir.value.copy(_kd);
      U.keyXZ.value.set(_kd.x, _kd.z).normalize();
      _t1.crossVectors(_kd, _yUp).normalize();
      _t2.crossVectors(_t1, _kd).normalize();
      U.keyT1.value.copy(_t1);
      U.keyT2.value.copy(_t2);
      U.keySin.value = Math.sin((p.key.sizeDeg * Math.PI) / 180);
      set3(U.keyColor, p.key.color);
      U.keyDisc.value = p.key.disc;
      U.keyHalo.value = p.key.halo;
      U.keyHalo2.value = p.key.halo2;
      U.isMoon.value = p.key.moon ? 1 : 0;
      set3(U.keyLight, p.key.light);
      set3(U.ambSky, p.ambSky);
      set3(U.ambGround, p.ambGround);
      U.stars.value = p.stars;
      U.starSigma.value = starSigma;
      setCloud(U.low, p.clouds);
      setCloud(U.high, p.cirrus);
      U.fogDensity.value = fogDensity * p.hazeGain;
      U.fogHeight.value = p.hazeHeight;
      U.lightsOn.value = p.lights;
      U.windows.value = p.windows;
      set3(U.seaColor, p.sea.color);
      U.seaRough.value = p.sea.rough;
    },
    setLightMap(lm) {
      lightMap.value = lm !== null ? lm.texture : empty;
      if (lm !== null) {
        U.lmRect.value.set(lm.rect[0], lm.rect[1], lm.rect[2], lm.rect[3]);
        U.lmY.value.set(lm.layers[0], lm.layers[1]);
      } else {
        U.lmRect.value.set(-1, -1, 2, 2);
      }
    },
    dispose() {
      empty.dispose();
    },
  };
}

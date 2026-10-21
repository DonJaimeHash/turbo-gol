/**
 * Backdrop materials. Three run ONLY while baking (structures, sea, sky); the LIVE variant of the
 * structure material draws the near harbour layer every frame (World.ts).
 *
 * Every bake material writes vec4(radiance, 1000 / distance from the bake origin): the cube map
 * keeps an inverse-distance "depth" in alpha (0 = the sky at infinity), read by the parallax proxy
 * bake (bake.ts). Every baked texel goes through `clean` (max 0 / min 60000: WGSL / HLSL / MSL
 * min and max return the non-NaN operand), so a NaN can never enter the cube or the environment.
 */
import * as THREE from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import {
  Fn,
  If,
  abs,
  attribute,
  cameraPosition,
  cos,
  cubeTexture,
  dot,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  min,
  mix,
  normalWorld,
  normalize,
  oneMinus,
  positionLocal,
  positionWorld,
  pow,
  reflect,
  saturate,
  sin,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { glowMrt } from '../materials';
import { alpinePatterns } from './alpineShade';
import { fbm3, hash12, hash13, vnoise, type Atmosphere } from './atmosphere';
import { BAY_W, BAY_X, CROWN_K, CROWN_MIN, ROWS, ROW_HALF, ROW_PITCH, ROW_Z0 } from './city';
import { KIND } from './geo';

type F = Node<'float'>;
type V3 = Node<'vec3'>;

/** NaN / Inf guard for every texel (min / max return the non-NaN operand). */
const clean = (c: V3): V3 => c.max(0.0).min(60000.0);
/**
 * Fade of a pattern of period `period` (uu) once a pixel covers a good part of it (no shimmer).
 * `fw` is fwidth() of the pattern coordinate, taken BEFORE any branch: WGSL only allows
 * derivatives in uniform control flow, and the kind branches below are not uniform.
 */
const aa = (fw: F, period: number): F => saturate(oneMinus(fw.mul(2.0 / period)));
/** Radiance of a lit city window (TOWER pattern) at lightsOn 1, before its per-window spread. */
const TOWER_WINDOW_GAIN = 1.15;

export interface StructMaterial {
  readonly material: THREE.MeshBasicNodeMaterial;
  /** LIVE variant only: 1 draws the layer, 0 collapses every vertex to a point (no fragments). */
  readonly on: UniformNode<'float', number> | null;
}

/**
 * One material for every backdrop solid; the per-vertex `kind` picks a procedural pattern.
 *
 *   'bake'  the bake variant: aerial perspective from the bake origin, alpha = inverse distance,
 *           every pattern.
 *   'live'  drawn per frame: aerial perspective from the camera, cheaper noise, only the live layers'
 *           kinds (harbour, city, alpine valley), glow of the lamps into the bloom target, and the `on`
 *           switch so a theme without a live layer hides it with a uniform instead of a recompile.
 *   'env'   the live variant for the environment probe: no glow tag (the probe's target has no
 *           `output` / `emissive` members), sharing the live layer's `on` switch (`sharedOn`).
 */
export function makeStructMaterial(A: Atmosphere, mode: 'bake' | 'live' | 'env', sharedOn: UniformNode<'float', number> | null = null): StructMaterial {
  const live = mode !== 'bake';
  const m = new THREE.MeshBasicNodeMaterial({ fog: false });
  const kcol = attribute<'vec4'>('kcol', 'vec4');
  const kloc = attribute<'vec3'>('kloc', 'vec3');
  const kdat = attribute<'vec4'>('kdat', 'vec4');
  const { U } = A;
  const Fx = A.functions();
  const on = live ? (sharedOn ?? uniform(1)) : null;
  /** Large-scale variation: fbm in the bake, one value-noise tap live. */
  const grime = (p: V3): F => (live ? vnoise(p) : fbm3(p));

  const shaded = Fn(() => {
    const wp = positionWorld;
    // safe normalize: a degenerate triangle's zero normal must not become NaN
    const n = normalWorld.div(max(length(normalWorld), 1e-5)).toVar();
    const kind = kcol.w;
    // .toVar(): these are shared by several If branches below. Without it TSL emits each at its
    // first use, i.e. INSIDE the first branch that needs it, and later branches read garbage.
    const hs = max(kdat.xyz, vec3(1.0)).toVar();
    const seed = kdat.w.toVar();
    const ax = abs(kloc).div(hs).toVar();
    // which face of the part's box this fragment is on
    const onX = step(max(ax.y, ax.z), ax.x).toVar();
    const onY = step(max(ax.x, ax.z), ax.y).mul(oneMinus(onX)).toVar();
    const onZ = oneMinus(onX).mul(oneMinus(onY)).toVar();
    const u = mix(kloc.x.add(hs.x), kloc.z.add(hs.z), onX).toVar(); // along the face, from its edge
    const v = kloc.y.add(hs.y).toVar(); // height above the part's bottom
    const alb = kcol.rgb.toVar();
    const emi = vec3(0.0).toVar();
    const vis = float(1.0).toVar(); // key-light visibility (terrain shadows)
    const fwU = fwidth(u).toVar();
    const fwZ = fwidth(wp.z).toVar();

    If(kind.lessThan(KIND.STEEL + 0.5), () => {
      // painted steel: large-scale grime
      alb.mulAssign(vnoise(wp.mul(0.0011)).mul(0.3).add(0.82));
    })
      .ElseIf(kind.lessThan(KIND.CONTAINER + 0.5), () => {
        const L = hs.x.mul(2.0);
        const H = hs.y.mul(2.0);
        // corrugation on the long sides, door bars + frame on the ends (faded once sub-pixel)
        const corr = sin(u.mul(6.2832 / 26.0)).mul(0.5).add(0.5);
        const sides = mix(float(1.0), mix(float(0.97), corr.mul(0.26).add(0.84), aa(fwU, 26)), onZ);
        const bars = step(abs(fract(u.div(hs.z.mul(2.0)).mul(4.0)).sub(0.5)), 0.05).mul(onX).mul(aa(fwU, 120));
        const frame = step(min(min(u, v), min(mix(L, hs.z.mul(2.0), onX).sub(u), H.sub(v))), 14.0).mul(oneMinus(onY)).mul(aa(fwU, 60));
        // rust streaks running down from the top rail
        const streak = smoothstep(0.78, 1.0, hash12(vec2(floor(u.div(23.0)), seed.mul(97.0)))).mul(smoothstep(0.2, 1.0, v.div(H))).mul(aa(fwU, 46));
        const tone = fract(seed.mul(13.71)).mul(0.42).add(0.78);
        alb.mulAssign(sides.mul(tone).mul(oneMinus(bars.mul(0.5))).mul(oneMinus(frame.mul(0.35))).mul(oneMinus(streak.mul(0.35))));
        alb.assign(mix(alb, alb.mul(vec3(1.25, 0.8, 0.55)), streak.mul(0.6)));
        // stencilled block marks (pseudo-glyphs) near the top right of the long sides
        const gx = u.sub(L.mul(0.6));
        const gy = v.sub(H.mul(0.58));
        const inBox = step(0.0, gx).mul(step(gx, L.mul(0.3))).mul(step(0.0, gy)).mul(step(gy, H.mul(0.22))).mul(onZ);
        const gcell = floor(vec2(gx.div(L.mul(0.3 / 9.0)), gy.div(H.mul(0.22 / 3.0))));
        const bit = mix(float(0.5), step(0.45, hash12(gcell.add(seed.mul(31.0)))), aa(fwU, 80));
        alb.assign(mix(alb, alb.mul(1.7).add(0.04), inBox.mul(bit).mul(step(0.6, fract(seed.mul(7.3)))).mul(0.8)));
        // the dark gap line between stacked boxes and a darker roof
        alb.mulAssign(mix(float(1.0), float(0.65), onY));
        alb.mulAssign(oneMinus(oneMinus(smoothstep(0.0, 9.0, v)).mul(0.45).mul(oneMinus(onY))));
      })
      .ElseIf(kind.lessThan(KIND.WINDOWS + 0.5), () => {
        // lit window grid (ship superstructure)
        const g = vec2(u.div(170.0), v.div(290.0));
        const cell = floor(g);
        const f = fract(g);
        const win = step(0.16, f.x).mul(step(f.x, 0.84)).mul(step(0.28, f.y)).mul(step(f.y, 0.82)).mul(oneMinus(onY));
        const h = hash13(vec3(cell, seed.mul(131.0)));
        const bias = fract(seed.mul(3.17)).mul(0.8).add(0.6);
        const lit = step(h, U.windows.mul(bias));
        const hue = hash13(vec3(cell.yx, seed.mul(17.0).add(3.0)));
        const wc = mix(mix(vec3(1.0, 0.56, 0.24), vec3(1.0, 0.82, 0.55), hue), vec3(0.62, 0.75, 1.0), step(0.9, hue));
        // far away a window cell is sub-pixel: its mean (lit fraction x coverage) replaces the grid
        const k = aa(fwU, 170);
        const winA = mix(float(0.29), win, k);
        const litA = mix(U.windows.mul(bias).min(1.0), lit, k);
        emi.assign(wc.mul(winA.mul(litA).mul(hash13(vec3(cell, 7.0)).mul(1.6).add(1.1))).mul(U.lightsOn));
        alb.assign(mix(alb, vec3(0.06, 0.075, 0.1), winA));
      })
      .ElseIf(kind.lessThan(KIND.LIGHTHOUSE + 0.5), () => {
        const band = step(0.5, fract(kloc.y.div(520.0)));
        alb.assign(mix(vec3(0.72, 0.72, 0.68), vec3(0.52, 0.04, 0.035), band));
      })
      .ElseIf(kind.lessThan(KIND.LAMP + 0.5), () => {
        emi.assign(kcol.rgb.mul(U.lightsOn));
        alb.assign(vec3(0.12));
      })
      .ElseIf(kind.lessThan(KIND.HULL + 0.5), () => {
        // hull: navy, white sheer line, a lit porthole row, red boot-top at the waterline
        const top = hs.y.mul(2.0);
        const y = kloc.y.add(hs.y);
        alb.assign(mix(alb, vec3(0.34, 0.05, 0.04), step(y, 70.0)));
        alb.assign(mix(alb, vec3(0.72, 0.72, 0.7), step(top.sub(150.0), y).mul(step(y, top.sub(95.0)))));
        const pz = fract(kloc.z.div(150.0)).sub(0.5).mul(150.0);
        const py = y.sub(top.sub(360.0));
        const hole = step(length(vec2(pz, py)), 30.0).mul(oneMinus(onY));
        const plit = step(hash12(vec2(floor(kloc.z.div(150.0)), seed.mul(9.0))), U.windows);
        emi.assign(vec3(1.0, 0.7, 0.4).mul(hole.mul(plit).mul(1.6)).mul(U.lightsOn));
      })
      .ElseIf(kind.lessThan(KIND.GROUND + 0.5), () => {
        const g = grime(vec3(wp.xz.mul(0.0011), 1.0));
        alb.mulAssign(g.mul(0.7).add(0.55));
        // painted lanes across the quay (only on up-facing ground)
        const lane = step(abs(fract(wp.z.div(3100.0)).sub(0.5)).mul(3100.0), 16.0).mul(step(0.5, n.y)).mul(aa(fwZ, 64));
        alb.assign(mix(alb, vec3(0.42, 0.32, 0.05), lane.mul(0.8)));
      })
      .ElseIf(kind.lessThan(KIND.ROCK + 0.5), () => {
        const g = grime(wp.mul(0.0045));
        alb.mulAssign(g.mul(1.3).add(0.2));
      })
      .ElseIf(kind.lessThan(KIND.FARCITY + 0.5), () => {
        if (live) return;
        // far city: small dim windows, many dark
        const g = vec2(u.div(160.0), v.div(300.0));
        const cell = floor(g);
        const f = fract(g);
        const win = step(0.22, f.x).mul(step(f.x, 0.78)).mul(step(0.32, f.y)).mul(step(f.y, 0.72)).mul(oneMinus(onY));
        const h = hash13(vec3(cell, seed.mul(53.0)));
        // per building occupancy; seed < 0.2 = office block, nearly dark
        const occ = mix(float(0.06), fract(seed.mul(5.3)).mul(0.5).add(0.12), step(0.2, seed));
        const lit = step(h, U.windows.mul(occ).mul(1.6));
        // a few whole floors lit together (cleaners, offices), the rest scattered
        const floorLit = step(0.93, hash13(vec3(cell.y, seed.mul(91.0), 4.0)));
        const wc = mix(vec3(1.0, 0.6, 0.28), vec3(0.8, 0.88, 1.0), step(0.7, hash13(vec3(cell.yx, 2.0))));
        emi.assign(wc.mul(win.mul(max(lit, floorLit)).mul(hash13(vec3(cell, 9.0)).mul(0.8).add(0.6))).mul(U.lightsOn));
      })
      .ElseIf(kind.greaterThan(KIND.FOLIAGE - 0.5).and(kind.lessThan(KIND.ALPINE + 0.5)), () => {
        // the alpine valley's kinds (pines, meadow, baked mountains): alpineShade.ts. An exact
        // range, ahead of the city's open-ended DECK / TOWER tests below
        alpinePatterns({ kind, wp, n, kcol, kdat, alb, vis, live });
      })
      .ElseIf(kind.greaterThan(KIND.DECK - 0.5), () => {
        // city ground (city.ts): the car park's wet concrete deck (seed >= 0.5: slab joints, the
        // parking rows' bay lines) or wet asphalt (the streets); puddles; the sky's haze mirrored
        const deck = step(0.5, seed);
        alb.mulAssign(grime(vec3(wp.xz.mul(0.0013), 3.0)).mul(0.5).add(0.75));
        const jd = min(float(0.5).sub(abs(fract(wp.x.div(900.0)).sub(0.5))), float(0.5).sub(abs(fract(wp.z.div(900.0)).sub(0.5)))).mul(900.0);
        alb.mulAssign(oneMinus(step(jd, 7.0).mul(aa(fwZ, 60)).mul(deck).mul(0.45)));
        // bay lines: double rows centred on |z| = ROW_Z0 + k ROW_PITCH, bays BAY_W wide, |x| < BAY_X
        const t = abs(wp.z).sub(ROW_Z0).div(ROW_PITCH);
        const k = floor(t.add(0.5));
        const dz = abs(t.sub(k).mul(ROW_PITCH));
        const inRow = step(dz, ROW_HALF).mul(step(-0.5, k)).mul(step(k, ROWS - 0.5)).mul(step(abs(wp.x), BAY_X)).mul(deck);
        const bx = float(0.5).sub(abs(fract(wp.x.div(BAY_W)).sub(0.5))).mul(BAY_W);
        const paint = step(min(min(bx, dz), abs(dz.sub(ROW_HALF))), 7.0).mul(inRow).mul(aa(fwZ, 90));
        alb.assign(mix(alb, vec3(0.62, 0.62, 0.58), paint.mul(0.85)));
        // wet: darker everywhere, puddles darker still and glossier
        const puddle = smoothstep(0.58, 0.68, vnoise(vec3(wp.xz.mul(0.0028), 7.0)));
        alb.mulAssign(mix(float(0.62), float(0.42), puddle));
        const vd = wp.sub(live ? cameraPosition : U.origin);
        const V = vd.div(max(length(vd), 1.0));
        const R = vec3(V.x, abs(V.y), V.z);
        const fres = pow(oneMinus(saturate(abs(V.y))), 5.0).mul(0.96).add(0.04);
        const sky = mix(Fx.hazeColor(R), U.mid.mul(1.4), smoothstep(0.0, 0.5, R.y));
        emi.addAssign(sky.mul(fres).mul(mix(float(0.4), float(0.9), puddle)).mul(deck.mul(0.6).add(0.4)).mul(step(0.5, n.y)));
      })
      .ElseIf(kind.greaterThan(KIND.TOWER - 0.5), () => {
        // city facades (city.ts): style floor(seed * 3) = 0 office curtain wall, 1 residential
        // punched windows, 2 dark glass with few lights; fract(seed * 3) varies the occupancy
        const st = floor(seed.mul(3.0));
        const sub = fract(seed.mul(3.0));
        const s1 = step(0.5, st);
        const s2 = step(1.5, st);
        const sel = (a: number, b: number, c: number): F => mix(mix(float(a), float(b), s1), float(c), s2);
        const cw = sel(150, 270, 170); // window cell width
        const fh = sel(390, 300, 410); // floor height
        const wx = sel(0.3, 0.2, 0.36); // half width of the opening (cell fraction)
        const wy0 = sel(0.2, 0.3, 0.14);
        const wy1 = sel(0.8, 0.74, 0.86);
        // faces from the normal, not the box test above: on a round tower the box test calls the
        // top of the curved wall a roof (TOWER parts are unrotated boxes and cylinders)
        const side = step(abs(n.y), 0.5);
        const ut = mix(kloc.x.add(hs.x), kloc.z.add(hs.z), step(abs(n.z), abs(n.x)));
        const g = vec2(ut.div(cw), v.div(fh));
        const cell = floor(g);
        const f = fract(g);
        const win = step(abs(f.x.sub(0.5)), wx).mul(step(wy0, f.y)).mul(step(f.y, wy1)).mul(side);
        const occ = sel(0.42, 0.38, 0.12).mul(sub.mul(0.6).add(0.7)).mul(U.windows).min(1.0);
        const lit = step(hash13(vec3(cell, seed.mul(173.0))), occ);
        // a few whole floors lit together
        const floorLit = step(0.94, hash13(vec3(cell.y, seed.mul(59.0), 2.0)));
        const hue = hash13(vec3(cell.yx, seed.mul(31.0).add(5.0)));
        const warm = mix(vec3(1.0, 0.58, 0.26), vec3(1.0, 0.78, 0.5), hue);
        const cool = mix(vec3(0.8, 0.87, 1.0), vec3(0.94, 0.91, 0.86), hue);
        // residential windows are warm; office and dark-glass ones mostly cool white (40% warm)
        const wc = mix(cool, warm, max(s1.mul(oneMinus(s2)), step(0.6, hash13(vec3(cell.xy, seed.mul(7.0).add(1.0))))));
        // far away a cell is sub-pixel: its mean (opening x lit share) replaces the grid
        const kk = saturate(oneMinus(fwU.mul(2.0).div(cw)));
        const winA = mix(wx.mul(2.0).mul(wy1.sub(wy0)).mul(side), win, kk);
        const litA = mix(occ, max(lit, floorLit), kk);
        const bright = mix(float(1.0), pow(hash13(vec3(cell, 11.0)), 1.5).mul(1.3).add(0.4), kk);
        emi.assign(wc.mul(winA.mul(litA).mul(bright).mul(TOWER_WINDOW_GAIN)).mul(U.lightsOn));
        alb.assign(mix(alb, vec3(0.02, 0.024, 0.032), winA));
        alb.mulAssign(mix(float(0.7), float(1.0), side));
        // the glass mirrors the dusk sky (the haze low, the sky's mid colour higher), mostly at
        // grazing angles; reflections pointing down (the dark city) fade out
        const vd = wp.sub(live ? cameraPosition : U.origin);
        const V = vd.div(max(length(vd), 1.0));
        const R = reflect(V, n);
        const fres = pow(oneMinus(saturate(dot(V.negate(), n))), 5.0).mul(0.96).add(0.04);
        const sky = mix(Fx.hazeColor(R), U.mid.mul(1.4), smoothstep(0.0, 0.5, R.y)).mul(smoothstep(-0.25, 0.02, R.y));
        emi.addAssign(sky.mul(fres).mul(sel(0.5, 0.12, 0.6)).mul(side).mul(oneMinus(winA.mul(litA))));
        // ...and at any angle a little of the sky above, a greyed blue: the walls read navy between
        // the windows (target-five-themes.webp, panel 03), not only the warm haze in front of them
        const skyFill = mix(U.mid, vec3(dot(U.mid, vec3(0.2126, 0.7152, 0.0722))), 0.45);
        emi.addAssign(skyFill.mul(sel(0.85, 0.3, 1.05)).mul(side).mul(oneMinus(winA)));
        // lit crown band just under the top of the part (city.ts crownOf)
        const H = hs.y.mul(2.0);
        const band = step(H.sub(150.0), v).mul(step(v, H.sub(45.0))).mul(side).mul(step(CROWN_MIN, fract(seed.mul(CROWN_K))));
        const ccol = mix(vec3(0.7, 0.85, 1.4), vec3(1.4, 0.75, 0.35), step(0.5, fract(seed.mul(11.3))));
        emi.addAssign(ccol.mul(band.mul(1.6)).mul(U.lightsOn));
      })
      .Else(() => {
        if (live) return;
        // sedimentary rock: strata bands by height, warped so they wander, plus varnish streaks.
        // kdat.x = baked sun visibility, kdat.y = ambient occlusion (canyon.ts)
        const warp = fbm3(wp.mul(0.00028)).sub(0.5).mul(2.6);
        const t = wp.y.div(380.0).add(warp);
        const band = hash12(vec2(floor(t), 7.0));
        const c1 = mix(vec3(0.36, 0.1, 0.05), vec3(0.5, 0.2, 0.08), smoothstep(0.2, 0.6, band));
        const c2 = mix(c1, vec3(0.6, 0.45, 0.3), step(0.86, band));
        const c3 = mix(c2, vec3(0.2, 0.08, 0.05), step(band, 0.1));
        const streak = smoothstep(0.55, 0.9, vnoise(vec3(wp.x.mul(0.004), wp.y.mul(0.0004), wp.z.mul(0.004))));
        const grain = fbm3(wp.mul(0.0035)).mul(0.5).add(0.75);
        alb.assign(c3.mul(kcol.rgb).mul(grain).mul(oneMinus(streak.mul(0.35))).mul(kdat.y));
        vis.assign(kdat.x);
      });

    const col = Fx.shade(alb, n, wp, vis).add(emi);
    const eye = live ? cameraPosition : U.origin;
    return clean(Fx.aerialFog(col, wp, eye));
  })().toVar('structColor');

  if (live && on !== null) {
    m.colorNode = shaded;
    // glow of the lamps and lit windows (the dome uses the same threshold for the baked ones)
    if (mode === 'live') m.mrtNode = glowMrt(max(shaded.sub(1.0), vec3(0.0)).mul(0.5), 'none');
    m.positionNode = positionLocal.mul(on);
  } else {
    const invDist = float(1000.0).div(max(length(positionWorld.sub(U.origin)), 1.0));
    m.outputNode = vec4(shaded, invDist);
  }
  return { material: m, on };
}

/**
 * Sea (bake only): the reflection comes from a cube rendered from the MIRRORED bake origin (below
 * the water), so for a flat sea reflect(view, up) hits exactly the right texel at any distance;
 * waves tilt the normal. Far away the slopes shrink and the taps spread vertically: glossy,
 * streaky water.
 */
export function makeSeaMaterial(A: Atmosphere, mirrorTex: THREE.CubeTexture): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ fog: false });
  const { U } = A;
  const Fx = A.functions();
  // [dirX, dirZ, wavelength uu, slope amplitude, phase]
  const WAVES: readonly (readonly [number, number, number, number, number])[] = [
    [0.8, 0.6, 1300, 0.045, 0.0],
    [-0.35, 0.94, 760, 0.04, 1.7],
    [0.96, -0.28, 470, 0.035, 4.1],
    [-0.7, -0.71, 290, 0.03, 2.3],
    [0.2, 0.98, 180, 0.026, 5.5],
    [0.99, 0.1, 120, 0.022, 0.9],
  ];
  m.outputNode = Fn(() => {
    const wp = positionWorld;
    const q = wp.xz;
    const toP = wp.sub(U.origin);
    const dist = max(length(toP), 1.0);
    const V = toP.div(dist);
    const sl = vec2(0.0).toVar();
    for (const [dx, dz, lambda, amp, ph] of WAVES) {
      const k = (2 * Math.PI) / lambda;
      const c = cos(q.x.mul(dx * k).add(q.y.mul(dz * k)).add(ph));
      sl.addAssign(vec2(dx, dz).mul(c.mul(amp)));
    }
    const nq = q.mul(vec2(1 / 70, 1 / 38));
    sl.addAssign(vec2(vnoise(vec3(nq, 0.5)).sub(0.5).mul(0.07), vnoise(vec3(nq.add(17.3), 2.1)).sub(0.5).mul(0.1)));
    const far = smoothstep(4000.0, 70000.0, dist);
    const slope = sl.mul(U.seaRough).mul(mix(float(1.0), float(0.35), far));
    const N = normalize(vec3(slope.x.negate(), 1.0, slope.y.negate()));
    const R0 = reflect(V, N);
    const R = vec3(R0.x, abs(R0.y), R0.z);
    const spread = mix(float(0.004), float(0.03), far);
    const acc = vec3(0.0).toVar();
    for (const o of [-1.5, -0.5, 0.5, 1.5]) {
      acc.addAssign(cubeTexture(mirrorTex, normalize(R.add(vec3(o * 0.25, o, o * -0.2).mul(spread)))).rgb);
    }
    const refl = acc.mul(0.25);
    const cosT = saturate(dot(V.negate(), N));
    const fres = float(0.02).add(pow(oneMinus(cosT), 5.0).mul(0.98));
    const body = U.seaColor.mul(U.ambSky.mul(20.0).add(U.keyLight.mul(0.4)).add(0.15));
    const col = mix(body, refl, fres);
    const invDist = float(1000.0).div(dist);
    return vec4(clean(Fx.aerialFog(col, wp, U.origin)), invDist);
  })();
  return m;
}

/** The analytic sky on a huge back-faced sphere (bake only). Alpha 0 = at infinity. */
export function makeSkyMaterial(A: Atmosphere): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  const Fx = A.functions();
  m.outputNode = Fn(() => {
    const d = positionWorld.sub(cameraPosition);
    const dir = d.div(max(length(d), 1e-3));
    return vec4(clean(Fx.skyRadiance(dir)), 0.0);
  })();
  return m;
}

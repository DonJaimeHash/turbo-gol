/**
 * The railyard's surface patterns for the backdrop structure material (bakeMaterials.ts): one
 * branch of its per-kind chain draws KIND.BRICK and KIND.RAILBED (railyard.ts), in the bake and in
 * the live layer alike. Only uniforms, attributes and hashes: a theme switch never recompiles.
 *
 *   BRICK    brick walls of a part's box. The integer part of kdat.w is the facade style: 0 plain
 *            brick (chimneys, viaduct, parapets: soot bands every few metres), 1..4 storeys of
 *            arched windows in bays between corner piers. A window is a rectangle under a
 *            semicircle (an exact distance, so its edge is filtered by the pixel footprint), with
 *            glazing bars, lit warm from inside (a hashed share follows the preset's `windows`,
 *            brighter at the sill) or dark glass. Piers, a string course per storey, a cornice,
 *            a sooty plinth, vertical soot streaks. Up-facing faces are tar roofs.
 *   RAILBED  ballast. A bed narrower than RAILBED_TRACK_HALF draws sleepers and two rails along its
 *            local x on its top face; wider parts (the yard ground) are plain gravel.
 *
 * Every pattern fades into its mean once a pixel covers a good part of a period (`fw` is a
 * derivative taken by the caller BEFORE the kind branches: WGSL only allows derivatives in uniform
 * control flow). NaN hygiene: every division has a floor, every smoothstep has edge0 < edge1.
 */
import type { Node } from 'three/webgpu';
import { If, abs, floor, float, fract, length, max, min, mix, oneMinus, saturate, smoothstep, step, vec2, vec3 } from 'three/tsl';
import { hash12, hash13, vnoise } from './atmosphere';
import { KIND } from './geo';
import { RAIL_GAUGE, RAILBED_TRACK_HALF } from './railyard';

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type V3Var = ReturnType<V3['toVar']>;

export interface RailyardPatternInput {
  readonly kind: F;
  /** Part-local position (centred), the part's half size (>= 1) and the raw kdat.w (style + seed). */
  readonly kloc: V3;
  readonly hs: V3;
  readonly seedRaw: F;
  /** Coordinate along the face from its edge, height above the part's bottom, and which face. */
  readonly u: F;
  readonly v: F;
  readonly onX: F;
  readonly onY: F;
  /** World position, and the pixel footprint (uu) of the face coordinates. */
  readonly wp: V3;
  readonly fw: F;
  /** Lit share of the windows (preset) and the master switch of lamps and windows. */
  readonly windows: F;
  readonly lightsOn: F;
  /** Large-scale variation (fbm in the bake, one noise tap live). */
  readonly grime: (p: V3) => F;
  /** The per-frame variant: hashes instead of the extra noise taps (the bake keeps them). */
  readonly live: boolean;
  /** Albedo (in: the part's colour) and emission, written in place. */
  readonly alb: V3Var;
  readonly emi: V3Var;
}

/** True for the kinds this file draws (an exact range, so its place in the caller's chain does not matter). */
export function isRailyardKind(kind: F): Node<'bool'> {
  return kind.greaterThan(KIND.BRICK - 0.5).and(kind.lessThan(KIND.RAILBED + 0.5));
}

/** 0 when a pattern of period `period` (uu) is under about half a pixel, 1 when it is resolved. */
const detail = (fw: F, period: number | F): F => saturate(oneMinus(fw.mul(2.0).div(period)));

/** Draw the railyard kinds into `alb` / `emi` (call inside the caller's kind branch). */
export function railyardPattern(p: RailyardPatternInput): void {
  const { kind, kloc, hs, u, v, onX, onY, wp, alb, emi } = p;
  const fw = max(p.fw, 0.5);

  If(kind.lessThan(KIND.BRICK + 0.5), () => {
    const style = floor(p.seedRaw);
    const sd = fract(p.seedRaw);
    const H = hs.y.mul(2.0);
    const W = mix(hs.x.mul(2.0), hs.z.mul(2.0), onX);
    const vert = oneMinus(onY);

    // ---- facade grid: bays between 180-uu corner piers, `rows` storeys over a plinth
    const PIER = 180.0;
    const PLINTH = 140.0;
    const PARAPET = 230.0;
    const bayWant = fract(sd.mul(7.31)).mul(160.0).add(520.0);
    const span = max(W.sub(PIER * 2), 1.0);
    const nb = max(floor(span.div(bayWant)), 1.0);
    const bw = span.div(nb);
    const uu = u.sub(PIER);
    const bi = floor(uu.div(bw));
    const bx = fract(uu.div(bw)).sub(0.5).mul(bw);
    const inFacade = step(0.0, uu).mul(step(uu, span));
    const rows = max(style, 1.0);
    const floorH = max(H.sub(PLINTH + PARAPET).div(rows), 100.0);
    const fy = v.sub(PLINTH).div(floorH);
    const fi = floor(fy);
    const fz = fract(fy).mul(floorH);

    // ---- one arched window per bay and storey (distance d < 0 inside)
    const r = min(bw.mul(0.24), floorH.mul(0.3));
    const sill = floorH.mul(0.16);
    const spring = floorH.mul(0.86).sub(r);
    const dRect = max(abs(bx).sub(r), sill.sub(fz));
    const dArch = length(vec2(bx, fz.sub(spring))).sub(r);
    const d = mix(dRect, dArch, step(spring, fz));
    const has = step(0.5, style).mul(inFacade).mul(step(0.0, fi)).mul(step(fi, rows.sub(0.5))).mul(vert);
    const k = detail(fw, bw.mul(0.5));
    const sharp = oneMinus(smoothstep(fw.negate(), fw, d));
    // seen from far away a window is sub-pixel: its share of the window band replaces it
    const winA = mix(float(0.3), sharp, k).mul(has).toVar();
    // glazing bars: three lights across, panes every ~110 uu up
    const gx = abs(fract(bx.div(max(r.mul(0.667), 1.0)).add(0.5)).sub(0.5)).mul(r.mul(0.667));
    const gy = abs(fract(fz.div(110.0)).sub(0.5)).mul(110.0);
    const bars = max(oneMinus(smoothstep(4.0, fw.add(4.0), gx)), oneMinus(smoothstep(3.0, fw.add(3.0), gy))).mul(detail(fw, 70.0));

    // ---- brick: piers, string courses, cornice, plinth, soot
    // brick tone and soot streaks: noise in the bake, a hash per pier-to-pier column live
    const col = hash12(vec2(floor(u.div(90.0)), sd.mul(41.0)));
    const tone = p.live ? col.mul(0.16).add(0.92) : vnoise(vec3(wp.x.add(wp.z).mul(0.0042), wp.y.mul(0.0042), sd.mul(31.0))).mul(0.24).add(0.88);
    const pierEdge = smoothstep(bw.mul(0.5).sub(60.0), bw.mul(0.5).sub(30.0), abs(bx)).mul(detail(fw, 120.0)).mul(step(0.5, style));
    const course = oneMinus(smoothstep(30.0, fw.add(30.0), fz)).mul(step(0.5, style)).mul(step(0.0, fi)).mul(detail(fw, 90.0));
    // plain walls (chimneys, viaducts): a darker band every 900 uu
    const band = oneMinus(step(0.5, style)).mul(step(fract(v.div(900.0)), 0.07)).mul(detail(fw, 120.0));
    const cornice = step(H.sub(150.0), v).mul(step(v, H.sub(70.0))).mul(step(0.5, style));
    const plinth = oneMinus(step(PLINTH, v));
    const streak = p.live
      ? smoothstep(0.62, 1.0, col).mul(smoothstep(H.mul(0.2), H, v).mul(0.6).add(0.4)).mul(0.3)
      : smoothstep(0.55, 0.95, vnoise(vec3(u.mul(0.011), v.mul(0.0011), sd.mul(17.0)))).mul(0.32);
    const big = p.grime(wp.mul(0.0011)).mul(0.3).add(0.82);
    const brick = alb.mul(tone).mul(big).mul(oneMinus(streak)).toVar();
    brick.mulAssign(mix(float(1.0), float(0.8), pierEdge));
    brick.assign(mix(brick, brick.mul(1.45).add(vec3(0.03, 0.025, 0.02)), max(course, cornice).mul(0.7)));
    brick.mulAssign(mix(float(1.0), float(0.62), max(band, plinth)));
    // soot toward the top of tall plain shafts (chimneys)
    brick.mulAssign(mix(float(1.0), float(0.55), oneMinus(step(0.5, style)).mul(smoothstep(H.mul(0.75), H, v)).mul(step(2400.0, H))));

    // ---- windows: lit warm (hashed per window, brighter toward the sill) or dark glass
    const h = hash13(vec3(bi, fi, sd.mul(137.0)));
    const occ = fract(sd.mul(5.37)).mul(0.5).add(0.6);
    const share = saturate(p.windows.mul(occ).mul(1.35));
    const lit = mix(share, step(h, share), k);
    const hue = hash13(vec3(fi, bi, sd.mul(29.0).add(3.0)));
    const warm = mix(vec3(1.0, 0.5, 0.19), vec3(1.0, 0.72, 0.4), hue);
    const wc = mix(warm, vec3(0.78, 0.86, 1.0), step(0.93, hue));
    const grad = saturate(oneMinus(fz.sub(sill).div(max(floorH.mul(0.7), 1.0)))).mul(0.6).add(0.75);
    const inten = hash13(vec3(bi, fi, 5.0)).mul(0.9).add(1.05).mul(grad);
    emi.assign(wc.mul(winA.mul(lit).mul(inten).mul(oneMinus(bars.mul(0.85)))).mul(p.lightsOn));
    const glass = vec3(0.025, 0.024, 0.03);
    alb.assign(mix(mix(brick, vec3(0.02, 0.018, 0.016), bars.mul(winA)), glass, winA.mul(oneMinus(bars))));
    // tar roofs
    alb.assign(mix(alb, vec3(0.04, 0.038, 0.04).mul(big), onY));
  }).Else(() => {
    // ---- RAILBED: ballast, and sleepers + rails on single-track beds (along local x, top face)
    const g1 = p.grime(vec3(wp.xz.mul(0.0013), 2.0));
    const g2 = p.live ? float(0.5) : mix(float(0.5), vnoise(vec3(wp.xz.mul(0.021), 5.0)), detail(fw, 48.0));
    alb.mulAssign(g1.mul(0.6).add(0.62).mul(g2.mul(0.36).add(0.82)));
    const isTrack = step(hs.z, RAILBED_TRACK_HALF).mul(onY);
    const az = abs(kloc.z);
    const sleeperZone = step(az, 132.0);
    const sl = mix(float(0.36), step(fract(kloc.x.div(62.0)), 0.36), detail(fw, 62.0));
    alb.assign(mix(alb, vec3(0.07, 0.052, 0.04), sleeperZone.mul(sl).mul(isTrack).mul(0.9)));
    const railD = abs(az.sub(RAIL_GAUGE / 2));
    const rail = mix(float(0.06), oneMinus(smoothstep(3.5, fw.add(3.5), railD)), detail(fw, 40.0)).mul(step(az, 140.0));
    alb.assign(mix(alb, vec3(0.5, 0.48, 0.46), rail.mul(isTrack)));
  });
}

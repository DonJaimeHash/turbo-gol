/**
 * The cage netting: the material of the shell above the board band and of the flat roof (one mesh,
 * see geometry.ts splitShell). A hexagonal wire mesh computed per pixel from the surface
 * coordinates in `uv` (uu):
 *
 *  - cells of NET_CELL uu (flat to flat, a little taller than wide), wires NET_WIRE uu thick;
 *  - each wire's coverage of the pixel is box-filtered exactly (a sub-pixel wire comes out as a
 *    faint line of the right average density, never as dashes);
 *  - where a cell spans fewer than a few pixels the lattice fades into its average coverage (no
 *    moire, no shimmer), which also grows at grazing angles like a real fence's;
 *  - a square grid of thicker support cables (CABLE_STEP) the mesh is tied to, filtered the same
 *    way: the structure that still reads at gameplay distance, where the cells have averaged out;
 *  - lighting is analytic (no light sources): a night-sky ambient, the floodlight beams catching
 *    the wires near the towers, and a forward-scatter glint where the camera looks toward a lamp
 *    through the net. On tiers without `netDetail` the hex lattice is only its average coverage
 *    (no fine wires; the cables stay) and four heads light it.
 *
 * Seams: the coordinate jumps only under the steel (arches, corner ribs, the roof ring), see
 * layout.ts netAcross. Unlit and transparent: the glow goes through glowMrt (additive, a little
 * near the lamps only), NaN-safe (every pow base saturated, every divisor clamped).
 */
import * as THREE from 'three/webgpu';
import { abs, cameraPosition, dot, float, fract, fwidth, max, min, mix, mod, normalWorld, normalize, oneMinus, positionWorld, pow, saturate, select, smoothstep, uv, vec2, vec3 } from 'three/tsl';
import { glowMrt, type FloatNode, type Vec2Node, type Vec3Node } from '../materials';
import type { TierSpec } from '../quality';
import { towerHeads } from './layout';
import type { StadiumUniforms } from './palette';

/** Flat-to-flat hex cell size and wire thickness (uu). */
export const NET_CELL = 20;
export const NET_WIRE = 1.5;
/** Cells are this much taller than wide (chicken wire). */
const NET_STRETCH = 1.15;
/** Support-cable grid spacing and cable thickness (uu). */
const CABLE_STEP = 400;
const CABLE_WIRE = 3;

/**
 * Exact 1D box-filtered coverage of a wire of half width `w` by a pixel whose footprint is `fp`,
 * at distance `d` (>= 0) from the wire's centre line (all uu).
 */
function wireCoverage(d: FloatNode, fp: FloatNode, w: number): FloatNode {
  const half = fp.mul(0.5);
  return min(d.add(half), float(w)).sub(max(d.sub(half), float(-w))).max(0).div(fp);
}

/** Distance (uu) from p to the nearest edge of a hexagonal lattice with flat-to-flat size `cell`. */
function hexEdgeDistance(p: Vec2Node, cell: number): FloatNode {
  const q = p.div(cell);
  const r = vec2(1, 1.7320508);
  const h = vec2(0.5, 0.8660254);
  const a = mod(q, r).sub(h);
  const b = mod(q.sub(h), r).sub(h);
  const g = abs(select(dot(a, a).lessThan(dot(b, b)), a, b));
  const hd = max(dot(g, h), g.x); // 0 at the centre, 0.5 on the edges
  return float(0.5).sub(hd).max(0).mul(cell);
}

export function buildNetMaterial(spec: TierSpec, u: StadiumUniforms): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  // Seen from inside every face is a front face; DoubleSide only matters for a camera outside the
  // cage, and forceSinglePass keeps it one draw (no back-then-front pair for a transparent mesh).
  m.forceSinglePass = true;

  const view = normalize(positionWorld.sub(cameraPosition));
  const ndv = abs(dot(normalWorld, view)).max(0.15);
  // Average coverage of the lattice (wire length per cell area x thickness), denser at grazing
  // angles because round wires keep their width while the openings foreshorten.
  const avg = min(float((2 * NET_WIRE) / NET_CELL).div(ndv), float(0.4));
  let coverage: FloatNode = avg;
  if (spec.netDetail) {
    const p = uv().mul(vec2(1, 1 / NET_STRETCH));
    const d = hexEdgeDistance(p, NET_CELL);
    const fp = fwidth(d).max(0.02);
    const sharp = wireCoverage(d, fp, NET_WIRE * 0.5);
    // Lattice -> average once a cell spans fewer than ~4 pixels (uu per pixel vs the cell).
    const fw = fwidth(p);
    const uuPerPx = max(fw.x, fw.y);
    const k = smoothstep(NET_CELL * 0.12, NET_CELL * 0.3, uuPerPx);
    coverage = mix(sharp, avg, k);
  }
  // Support cables: a square grid of thicker wires the mesh is tied to (every CABLE_STEP uu), the
  // structure that still reads where the hex cells have averaged out. Box-filtered like the wires
  // and faded into their own average once two cables share a few pixels.
  const c2 = uv().div(CABLE_STEP);
  const cd = abs(fract(c2).sub(0.5)).mul(-CABLE_STEP).add(CABLE_STEP / 2); // uu to the nearest cable (per axis)
  const cfp = fwidth(uv()).max(vec2(0.02, 0.02));
  const cableK = smoothstep(CABLE_STEP * 0.08, CABLE_STEP * 0.25, max(cfp.x, cfp.y));
  const cableAvg = float((2 * CABLE_WIRE) / CABLE_STEP).div(ndv);
  const cx = wireCoverage(cd.x, cfp.x, CABLE_WIRE * 0.5);
  const cy = wireCoverage(cd.y, cfp.y, CABLE_WIRE * 0.5);
  const cable = mix(float(1).sub(oneMinus(cx).mul(oneMinus(cy))), cableAvg, cableK).saturate();
  coverage = float(1).sub(oneMinus(coverage).mul(oneMinus(cable))).mul(u.netOpacity);

  // Light: ambient + the floodlights, all analytic.
  const heads = towerHeads();
  const step = spec.netDetail ? 1 : 2; // four heads (one per tower pair) without netDetail
  let light: Vec3Node = u.netAmbient;
  for (let i = 0; i < heads.length; i += step) {
    const H = heads[i];
    const lp = vec3(H.position[0], H.position[1], H.position[2]);
    const toL = lp.sub(positionWorld);
    const d2 = dot(toL, toL).max(1);
    const ldir = toL.mul(d2.inverseSqrt());
    // Wires inside the beam catch it (faintly: thin wire, mostly seen against the dark).
    const spot = smoothstep(0.6, 0.92, dot(ldir.negate(), vec3(H.dir[0], H.dir[1], H.dir[2])));
    const fall = float(2200 * 2200).div(d2.add(2200 * 2200));
    // Forward scatter: the wires glint where you look toward the lamp through them (tight lobe).
    const fwd = pow(saturate(dot(view, ldir)), 48).mul(3.0);
    const strength = u.head[i].mul(step);
    light = light.add(vec3(1.0, 0.94, 0.84).mul(spot.mul(0.18).add(fwd).mul(fall).mul(strength).mul(u.netLight)));
  }
  const col = u.netColor.mul(light);
  m.colorNode = col;
  m.opacityNode = coverage.saturate();
  // Only wires right by a lamp feed the bloom, a little (no veil over the roof).
  m.mrtNode = glowMrt(col.mul(coverage).mul(max(light.x.sub(1.0), 0).mul(0.05)));
  return m;
}

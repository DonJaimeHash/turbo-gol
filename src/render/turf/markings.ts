/**
 * Field markings as signed distances in TSL (all from constants.ts, the layout of the old floor):
 * a touchline LINE_INSET inside the ramp feet following the rounded corners, the halfway line, a
 * 1300 uu centre circle with a 280 uu inner ring, a ring on every kickoff spot, and per goal a
 * 2100 uu arc around the goal centre, a goal box 2600 x 900 and the goal line across the mouth with
 * short lines up to it along the posts.
 *
 * The layout is symmetric in x and in z, so everything is evaluated at |p| (one goal arc and one goal
 * box instead of two each, three kickoff rings instead of ten).
 *
 * `markingsCoverage` returns the paint coverage 0..1. The pitch feathers every line by one shared
 * pixel-footprint estimate (fwidth of the position: the distance fields all have unit gradient,
 * so 2 derivative ops serve every line); the grass blades call it from the vertex stage with a
 * fixed feather. `jitter` (uu) offsets every distance: the turf passes the blade heights so the
 * paint edges are ragged by the grass near the camera instead of decal-sharp.
 */
import { abs, float, length, max, min, oneMinus, smoothstep, step, vec2 } from 'three/tsl';
import { ARENA } from '../../sim/constants';
import { boxSdf, type FloatNode, type Vec2Node } from '../materials';
import { KICKOFF_RINGS_QUADRANT } from './bake';

/** Half width of the main lines (uu): 24 uu wide paint. */
export const LINE_HALF_WIDTH = 12;
/** The touchline runs this far inside the ramp feet. */
export const LINE_INSET = 60;

/** Signed distance to the outline of a rounded rectangle centred on the origin (half extents hx, hy, corner radius r). */
export function roundedRectSdf(p: Vec2Node, hx: number, hy: number, r: number): FloatNode {
  const q = abs(p).sub(vec2(hx - r, hy - r));
  return length(max(q, vec2(0, 0))).add(min(max(q.x, q.y), float(0))).sub(r);
}

/** Band mask: 1 where |d| < hw, feathered over `aa` uu on each side (aa > 0). */
function band(d: FloatNode, hw: number, aa: FloatNode): FloatNode {
  return oneMinus(smoothstep(float(hw).sub(aa), float(hw).add(aa), abs(d)));
}

/**
 * Paint coverage 0..1 at floor point `p` (three x, z in uu). `aa` is the feather (uu, > 0),
 * `jitter` an offset (uu) added to every distance.
 */
export function markingsCoverage(p: Vec2Node, jitter: FloatNode, aa: FloatNode): FloatNode {
  const hw = LINE_HALF_WIDTH;
  const bx = ARENA.extentX - ARENA.sideRampRadius - LINE_INSET;
  const bz = ARENA.extentY - ARENA.backRampRadius - LINE_INSET;
  const rr = ARENA.cornerRadius - ARENA.sideRampRadius - LINE_INSET;
  const gw = ARENA.goalHalfWidth;
  const q = abs(p); // the layout is symmetric in x and in z
  const ax = q.x;
  const az = q.y;
  const inMouthX = step(ax, float(gw)); // 1 where |x| <= goal half width
  const notMouth = oneMinus(inMouthX.mul(step(float(bz - 40), az)));
  const inField = step(az, float(bz));
  const inMouthStrip = step(float(bz), az).mul(step(az, float(ARENA.extentY)));
  const L = (d: FloatNode, w: number = hw): FloatNode => band(d.add(jitter), w, aa);

  // The flat floor ends where the ramps start; the touchline runs LINE_INSET inside the ramp feet
  // (its corner arcs follow the rounded walls); the goal line sits on the mouth plane, joined to
  // the touchline by short lines along the posts.
  let c = L(roundedRectSdf(p, bx, bz, rr)).mul(notMouth);
  c = max(c, L(az.sub(ARENA.extentY)).mul(inMouthX));
  c = max(c, L(ax.sub(gw)).mul(inMouthStrip));
  c = max(c, L(p.y).mul(step(ax, float(bx))));
  // Centre: a wide circle and a small inner ring around the kickoff spot.
  c = max(c, L(length(p).sub(1300)));
  c = max(c, L(length(p).sub(280), hw * 0.75));
  // A small ring on every kickoff spot (both teams; sim (x, y) = three (x, z)), folded into |p|.
  for (const [kx, kz] of KICKOFF_RINGS_QUADRANT) c = max(c, L(length(q.sub(vec2(kx, kz))).sub(70), 7));
  // Goal areas (the nearer goal): an arc around the goal centre and a goal box in front of the mouth.
  c = max(c, L(length(vec2(ax, az.sub(ARENA.extentY))).sub(2100)).mul(inField));
  c = max(c, L(boxSdf(q, 0, bz - 450, gw + 300, 450)).mul(inField));
  return c;
}

/**
 * The pitch material (moved from Arena.ts; the turf phase of docs/visuals/REWORK.md replaces it with
 * a baked blade texture, wetness, puddles, floodlight pools and streaks, keyed by tier and theme).
 *
 * Field markings (all from constants.ts): a touchline 60 uu inside the ramp feet following the
 * rounded corners, the halfway line, a 1300 uu centre circle with a 280 uu inner ring, a ring on
 * every kickoff spot, and per goal a 2100 uu arc around the goal centre, a goal box 2600 x 900 and
 * the goal line across the mouth with short lines up to it along the posts.
 *
 * Bloom: see materials.ts. Only the goal-mouth glow is tagged with `glowMrt()` (not the white lines).
 */
import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { Fn, abs, float, fract, length, max, min, mix, mx_noise_float, negate, oneMinus, positionWorld, sin, smoothstep, step, vec2, vec3 } from 'three/tsl';
import { ARENA, KICKOFF_SPAWNS } from '../../sim/constants';
import {
  TEAM_BLUE,
  TEAM_RED,
  boxSdf,
  cameraDistance,
  cellHash,
  glowMrt,
  lineMask,
  linearVec3,
  type FloatNode,
  type FloatUniform,
  type Vec2Node,
  type Vec3Node,
} from '../materials';

/** Signed distance to the outline of a rounded rectangle centred on the origin (half extents hx, hy, corner radius r). */
function roundedRectSdf(p: Vec2Node, hx: number, hy: number, r: number): FloatNode {
  const q = abs(p).sub(vec2(hx - r, hy - r));
  return length(max(q, vec2(0, 0))).add(min(max(q.x, q.y), float(0))).sub(r);
}

/**
 * Turf: blade noise (faded with distance to avoid shimmer), mowing bands across the length of the
 * field (14 bands, 800 uu each) with a faint lengthwise split, crisp 12 uu markings (see the file
 * header), faint team halves, team-coloured goal floors and a pulsing goal-mouth glow (`timeU`,
 * seconds). Shadows are tinted cool green-grey instead of black (floodlit from many lamps).
 */
export function buildFloorMaterial(timeU: FloatUniform): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0 });
  const p = positionWorld.xz; // (x, sim y)
  const ax = abs(p.x);
  const az = abs(p.y);

  const nearK = oneMinus(smoothstep(float(1500), float(3200), cameraDistance()));
  const n1 = mx_noise_float(p.mul(1 / 22)).mul(0.5).add(0.5);
  const n2 = cellHash(p, 5);
  const band = (ARENA.extentY * 2) / 14;
  const stripeY = step(0.5, fract(p.y.div(band * 2)));
  const stripeX = step(float(0), p.x);
  const mow = mix(float(0.93), float(1.07), stripeY).mul(mix(float(0.985), float(1.015), stripeX));
  const turf = vec3(0.075, 0.27, 0.11);
  let base = turf.mul(float(0.88).add(n1.mul(0.16)).add(n2.mul(0.1).mul(nearK))).mul(mow);

  const toBlue = smoothstep(float(0.22 * ARENA.extentY), float(0.9 * ARENA.extentY), negate(p.y));
  const toRed = smoothstep(float(0.22 * ARENA.extentY), float(0.9 * ARENA.extentY), p.y);
  const tint = linearVec3(TEAM_BLUE).mul(toBlue).add(linearVec3(TEAM_RED).mul(toRed));
  base = base.add(tint.mul(0.07));

  const glowCol = mix(linearVec3(TEAM_BLUE), linearVec3(TEAM_RED), step(float(0), p.y));
  const inGoal = step(float(ARENA.extentY), az);
  base = mix(base, glowCol.mul(0.12), inGoal);

  // Markings. The flat floor ends where the ramps start; the touchline runs LINE_INSET inside the
  // ramp feet (a rounded rectangle whose corner arcs follow the rounded walls); the goal line sits
  // on the mouth plane, joined to the touchline by short lines along the posts.
  const hw = 12;
  const LINE_INSET = 60;
  const bx = ARENA.extentX - ARENA.sideRampRadius - LINE_INSET;
  const bz = ARENA.extentY - ARENA.backRampRadius - LINE_INSET;
  const rr = ARENA.cornerRadius - ARENA.sideRampRadius - LINE_INSET;
  const gw = ARENA.goalHalfWidth;
  const inMouthX = step(ax, float(gw)); // 1 where |x| <= goal half width
  const nearBack = step(float(bz - 40), az);
  const notMouth = oneMinus(inMouthX.mul(nearBack));
  const inField = step(az, float(bz));
  const inMouthStrip = step(float(bz), az).mul(step(az, float(ARENA.extentY)));

  let lines = lineMask(roundedRectSdf(p, bx, bz, rr), hw).mul(notMouth);
  lines = max(lines, lineMask(az.sub(ARENA.extentY), hw).mul(inMouthX));
  lines = max(lines, lineMask(ax.sub(gw), hw).mul(inMouthStrip));
  lines = max(lines, lineMask(p.y, hw).mul(step(ax, float(bx))));
  // Centre: a wide circle and a small inner ring around the kickoff spot.
  lines = max(lines, lineMask(length(p).sub(1300), hw));
  lines = max(lines, lineMask(length(p).sub(280), hw * 0.75));
  // A small ring on every kickoff spot (both teams).
  for (const [kx, ky] of KICKOFF_SPAWNS) {
    for (const s of [-1, 1] as const) lines = max(lines, lineMask(length(p.sub(vec2(s * kx, s * ky))).sub(70), 7));
  }
  // Goal areas: an arc around the goal centre and a goal box in front of the mouth.
  for (const s of [-1, 1] as const) {
    const goalCentre = vec2(0, s * ARENA.extentY);
    lines = max(lines, lineMask(length(p.sub(goalCentre)).sub(2100), hw).mul(inField));
    lines = max(lines, lineMask(boxSdf(p, 0, s * (bz - 450), gw + 300, 450), hw).mul(inField));
  }

  // Goal-mouth glow: fades in over the last metres before the line, pulses gently.
  const inMouth = step(ax, float(gw + 40)).mul(smoothstep(float(bz - 700), float(bz + 100), az));
  const pulse = float(0.16).add(sin(timeU.mul(1.5)).mul(0.04));
  const goalGlow = glowCol.mul(inMouth).mul(pulse);

  const lineCol = vec3(0.92, 0.95, 1.0);
  m.colorNode = mix(base, lineCol, lines.mul(0.9));
  // A touch of self-illumination keeps the lines readable at distance; only the goal glow blooms.
  m.emissiveNode = lineCol.mul(lines.mul(0.14)).add(goalGlow);
  m.mrtNode = glowMrt(goalGlow.mul(0.6), 'none');
  m.roughnessNode = float(0.82).sub(lines.mul(0.3));
  const shadowTint = vec3(0.52, 0.66, 0.6);
  const tintShadow = Fn(([shadow]: [Node]) => mix(shadowTint, vec3(1.0, 1.0, 1.0), shadow as Vec3Node));
  m.receivedShadowNode = tintShadow as unknown as () => Node;
  return m;
}

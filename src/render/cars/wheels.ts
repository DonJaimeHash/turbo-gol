/**
 * Wheel styles: the unit wheel every car instances 4 times (radius 1 in xy, the axle along z in
 * uu, width WHEEL_WIDTH), as data. The tyre is what the shared shader knows (kit.ts RIM_R,
 * TREAD_R, CROWN_R, WHEEL_WIDTH and the knob count per detail are compiled into its tyre detail),
 * so a style picks the tyre ('knobby' or 'slick') and leaves those numbers alone; the rim, the
 * spokes, the dish and the hub are plain vertex data and free (any count, colour or depth, within
 * WHEEL_TRIS_CAP).
 *
 * KNOBBY is the dune runner's wheel, byte for byte the geometry it always had (pinned by
 * tests/car-bodies.test.mjs).
 */
import * as THREE from 'three/webgpu';
import type { Team } from '../../sim/types';
import { BEAD, BOLT, CAR_KIND, DISC, KNOBS_HIGH, KNOBS_LOW, KNOB_WIDTH, RIM_DARK, RIM_R, TEAM_PAINT, TREAD_R, TWO_PI, TYRE, WHEEL_WIDTH, mergeParts, tag } from './kit';
import type { CarDetail, Surface, WheelStyle } from './types';

/**
 * A slick's tread radius (tyre-radius units): below kit.ts CROWN_R, so the shader paints no knob
 * sipes on it (they would sit on a smooth tread), close enough to 1 that the tyre keeps its size.
 */
export const SLICK_R = 0.975;
/** Width (uu) of a slick's chamfered shoulder, from the sidewall's edge up to the tread. */
const SLICK_SHOULDER = 1.5;

/** Knobby off-road tyre on a dark six-spoke rim over a dish, beadlock bolts, a team hub cap. */
export const KNOBBY: WheelStyle = { id: 'knobby', tyre: 'knobby', spokes: 6, spokeWidth: 0.17, dish: 0.4, rim: 0x2a2f37, bolts: 8, hub: 'team' };
/** Smooth road tyre on a light five-spoke alloy, no bolts: a style for the bodies to come. */
export const SLICK: WheelStyle = { id: 'slick-5', tyre: 'slick', spokes: 5, spokeWidth: 0.22, dish: 0.25, rim: 0xb8bec8, bolts: 0, hub: 'team' };
/** Every style (the tests build each one at both details). */
export const WHEEL_STYLES: readonly WheelStyle[] = [KNOBBY, SLICK];

/** The style's outer tyre radius in tyre-radius units: CarView keeps this on the floor. */
export function tyreRadius(style: WheelStyle): number {
  return style.tyre === 'slick' ? SLICK_R : 1;
}

/**
 * The unit wheel of `style` at geometry `detail` for `team` (the hub cap's paint); instances scale
 * (radius, radius, 1). Tyre (carcass, sidewalls, knobs or a slick tread), a light beadlock ring
 * with bolts on both faces, the rim barrel, the dish, the spokes and the hub cap.
 */
export function buildWheel(style: WheelStyle, detail: CarDetail, team: Team): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const width = WHEEL_WIDTH;
  const hi = detail === 'high';
  const seg = hi ? 24 : 14;
  const seg2 = hi ? 18 : 10;
  const hw = width * 0.5;
  const hub: Surface = { color: style.hub === 'team' ? TEAM_PAINT[team] : style.hub, metal: 0.4, rough: 0.36, emissive: 0.15, kind: CAR_KIND.HUB };
  const rim: Surface = { ...RIM_DARK, color: style.rim };

  if (style.tyre === 'knobby') {
    const tread = new THREE.CylinderGeometry(TREAD_R, TREAD_R, width, seg, 1, true);
    tread.rotateX(Math.PI / 2);
    parts.push(tag(tread, TYRE));
    // The shader's sipes are laid out for exactly this many knobs (CarMaterialVariant.knobs).
    const knobs = hi ? KNOBS_HIGH : KNOBS_LOW;
    const knobH = 1 - TREAD_R + 0.01;
    for (let i = 0; i < knobs; i++) {
      const knob = new THREE.BoxGeometry(KNOB_WIDTH, knobH, width * 0.46);
      knob.translate(0, 1 - knobH * 0.5, ((i & 1) === 0 ? -1 : 1) * width * 0.25);
      knob.rotateZ((i * TWO_PI) / knobs);
      parts.push(tag(knob, TYRE));
    }
  } else {
    // Slick: a smooth tread at SLICK_R and a chamfered shoulder down to each sidewall's edge.
    const tread = new THREE.CylinderGeometry(SLICK_R, SLICK_R, width - 2 * SLICK_SHOULDER, seg, 1, true);
    tread.rotateX(Math.PI / 2);
    parts.push(tag(tread, TYRE));
    for (const side of [-1, 1]) {
      // A cone with its top (radius SLICK_R, +y) turned towards the centre of the tread.
      const shoulder = new THREE.CylinderGeometry(SLICK_R, TREAD_R, SLICK_SHOULDER, seg, 1, true);
      shoulder.rotateX(-side * (Math.PI / 2));
      shoulder.translate(0, 0, side * (hw - SLICK_SHOULDER * 0.5));
      parts.push(tag(shoulder, TYRE));
    }
  }
  for (const side of [-1, 1]) {
    const wall = new THREE.RingGeometry(RIM_R, TREAD_R, seg, 1);
    if (side < 0) wall.rotateY(Math.PI);
    wall.translate(0, 0, side * hw);
    parts.push(tag(wall, TYRE));
    const bead = new THREE.RingGeometry(0.54, 0.7, seg2, 1);
    if (side < 0) bead.rotateY(Math.PI);
    bead.translate(0, 0, side * (hw + 0.35));
    parts.push(tag(bead, BEAD));
    if (hi) {
      for (let i = 0; i < style.bolts; i++) {
        const bolt = new THREE.BoxGeometry(0.07, 0.07, 0.3);
        bolt.translate(0, 0.62, side * (hw + 0.45));
        bolt.rotateZ((i * TWO_PI) / style.bolts + 0.3);
        parts.push(tag(bolt, BOLT));
      }
    }
  }
  const barrel = new THREE.CylinderGeometry(RIM_R, RIM_R, width + 0.6, seg2, 1, true);
  barrel.rotateX(Math.PI / 2);
  parts.push(tag(barrel, rim));
  const dish = new THREE.CylinderGeometry(0.6, 0.6, width * style.dish, seg2, 1, false);
  dish.rotateX(Math.PI / 2);
  parts.push(tag(dish, DISC));
  for (let i = 0; i < style.spokes; i++) {
    const spoke = new THREE.BoxGeometry(style.spokeWidth, 0.42, width + 0.9);
    spoke.translate(0, 0.36, 0);
    spoke.rotateZ((i * TWO_PI) / style.spokes);
    parts.push(tag(spoke, rim));
  }
  const cap = new THREE.CylinderGeometry(0.2, 0.22, width + 1.6, 10, 1, false);
  cap.rotateX(Math.PI / 2);
  parts.push(tag(cap, hub));
  const merged = mergeParts(parts);
  merged.computeBoundingSphere();
  return merged;
}

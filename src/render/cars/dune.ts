/**
 * The dune runner ('dune', the default car): a low lofted pod with a bubble canopy, a white roll
 * hoop carrying a four-lamp light bar, wide pontoon arches over all four wheels joined by side
 * pods with a team light strip, a nerf-bar bumper with two fog lamps, and twin round thrusters at
 * the tail (the boost leaves as two plasma jets). Paint is two-tone: team colour above a lime
 * pinstripe, gloss carbon below it, and forward chevrons on the nose. Wheels are knobby off-road
 * tyres on dark six-spoke rims with a light beadlock ring and a team-coloured hub cap.
 *
 * Designed on the default hitbox (about 120 x 39 x 87 uu, kit.hl / hh / hw 58.75 / 17.83 / 41.85).
 * Its geometry is pinned byte for byte (tests/car-bodies.test.mjs): any change here, even the
 * order of two parts, needs new pins and a look at the car on every tier.
 */
import * as THREE from 'three/webgpu';
import { BRAND_LIME } from '../materials';
import { BOOST_NOZZLE_X, CAGE, CARBON, DISC, EXHAUST, HEADLIGHT, TAILLIGHT, TRIM, TWO_PI, section, tube, loft } from './kit';
import type { BodyKit, CarBodySpec } from './types';
import { KNOBBY } from './wheels';

/** Visual tyre radius over the physics radius: the arches are swept round the visual wheels. */
const WHEEL_VISUAL = 1.1;

function build(k: BodyKit): void {
  const { hi, cfg, hl, hh, paint, glass, strip } = k;

  // Main pod, tail to nose: a rounded, slightly boxy tub that rises to the rear deck and dips
  // into a blunt rounded nose.
  const podSeg = hi ? 20 : 14;
  k.push(
    loft(
      [
        section(-56.5, 6, -6, 0),
        section(-55, 12, -10, 3),
        section(-50, 16, -14, 5),
        section(-38, 18, -16, 5.5),
        section(-24, 19, -16.5, 4.5),
        section(-6, 19, -16.5, 3.5),
        section(12, 19, -16.5, 3),
        section(24, 18.5, -16.5, 1.5),
        section(38, 17, -16.5, -1),
        section(50, 15, -16.5, -3.5),
        section(56, 11, -15.5, -6),
        section(58.5, 6, -13, -9),
      ],
      podSeg,
      3,
    ),
    paint,
  );

  // Bubble canopy (the upper ~105 degrees of an ellipsoid; the rest is inside the pod).
  const canopy = new THREE.SphereGeometry(1, hi ? 22 : 14, hi ? 12 : 8, 0, TWO_PI, 0, Math.PI * 0.58);
  canopy.scale(22, 12.5, 14.5);
  canopy.translate(-4, 2.5, 0);
  k.push(canopy, glass);

  // Side pods between the arches, each with a team light strip along its flank.
  for (const side of [-1, 1]) {
    const zc = side * 30.5;
    k.push(
      loft(
        [
          section(-29, 4, -13, -8, zc),
          section(-26, 9.5, -15.5, -4.5, zc),
          section(-18, 10.8, -16, -3.5, zc),
          section(10, 10.8, -16, -3.5, zc),
          section(17, 9.5, -15.5, -4.5, zc),
          section(20.5, 4, -14, -9, zc),
        ],
        hi ? 14 : 10,
        3,
      ),
      paint,
    );
    k.box(strip, 38, 1.4, 0.8, -4, -9.5, side * 41.3);
  }

  // Wide pontoon arches over the wheels: a rounded band swept around each wheel's rest position,
  // its ends cut where they would leave the hitbox (floor, tail).
  k.arch(cfg.frontWheelOffset[0] - k.ox, cfg.frontWheelRadius * WHEEL_VISUAL);
  k.arch(cfg.backWheelOffset[0] - k.ox, cfg.backWheelRadius * WHEEL_VISUAL);

  // Roll hoop behind the canopy (a half torus across the car) carrying a four-lamp light bar,
  // with two braces back to the rear deck.
  const hoopX = -24;
  const hoopR = Math.min(16, hh - 1.8);
  const hoop = new THREE.TorusGeometry(hoopR, 1.5, hi ? 8 : 5, hi ? 16 : 10, Math.PI);
  hoop.rotateY(Math.PI / 2);
  const hoopY = -1.5; // the open tube ends sink into the pod
  hoop.translate(hoopX, hoopY, 0);
  k.push(hoop, CAGE);
  const braceY = hoopY + Math.sqrt(hoopR * hoopR - 7.7 * 7.7);
  for (const side of [-1, 1]) k.push(tube(hoopX, braceY, side * 7.7, -46, 4, side * 10, 1.1, hi ? 8 : 5), CAGE);
  const barY = hoopY + hoopR - 0.7;
  k.box(TRIM, 3, 2.4, 17, hoopX + 2.4, barY, 0);
  for (const z of [-7.2, -2.4, 2.4, 7.2]) k.box(HEADLIGHT, 0.8, 1.8, 2.8, hoopX + 4.1, barY, z);

  // Carbon engine cover on the rear deck.
  k.box(CARBON, 11, 4.5, 13, -38, 6.5, 0);
  k.box(CARBON, 9, 0.8, 14, -38.5, 9.2, 0);

  // Twin thrusters: housing, dark throat and a tail-light ring each, exiting at the boost nozzles.
  const { x: nx, y: ny } = k.nozzle; // the exit plane and the nozzles' height
  for (const side of [-1, 1]) {
    const z = side * k.nozzle.z;
    const housing = new THREE.CylinderGeometry(4.2, 4.6, 7, hi ? 16 : 10, 1, false);
    housing.rotateZ(Math.PI / 2);
    housing.translate(nx + 3.5, ny, z);
    k.push(housing, EXHAUST);
    const throat = new THREE.CircleGeometry(3.3, hi ? 16 : 10);
    throat.rotateY(-Math.PI / 2);
    throat.translate(nx - 0.05, ny, z);
    k.push(throat, DISC);
    const ring = new THREE.TorusGeometry(4.5, 0.55, 5, hi ? 18 : 12);
    ring.rotateY(Math.PI / 2);
    ring.translate(nx + 0.1, ny, z);
    k.push(ring, TAILLIGHT);
  }

  // Nerf-bar bumper across the nose with a fog lamp at each end.
  const bumperX = hl - 1.75;
  k.push(tube(bumperX, -12.5, -24, bumperX, -12.5, 24, 1.4, hi ? 10 : 6), CAGE);
  for (const side of [-1, 1]) {
    const lamp = new THREE.CylinderGeometry(2.2, 2.2, 2, hi ? 14 : 8, 1, false);
    lamp.rotateZ(Math.PI / 2);
    lamp.translate(hl - 1.0, -12.5, side * 20.5);
    k.push(lamp, HEADLIGHT);
  }
}

export const DUNE: CarBodySpec = {
  id: 'dune',
  build,
  wheels: { style: KNOBBY, visual: WHEEL_VISUAL, outer: 39 },
  // The livery the shared material always painted on this body (car-local uu: the build frame
  // + (13.88, 20.76, 0), so the two-tone line is at -12.0 in build(), the chevrons at 24.1..54.1).
  livery: {
    twoToneY: 8.75,
    pinstripe: 0.45,
    chevrons: { x0: 38, x1: 68, halfWidth: 12, period: 11 },
    // The bonnet and the rear deck lid, across the top of the pod (not the side pods).
    seams: { x: [29, -31], maxZ: 18.5 },
    accent: BRAND_LIME,
    chevronTint: 0,
    grime: { y0: 10, y1: 3, amount: 0.55 },
    ao: { y0: 2, y1: 14 },
    // The thruster housings run 7 uu forward of the exit plane (the tint fades along them).
    heat: { x: BOOST_NOZZLE_X, length: 7 },
  },
  budget: { low: 2000, high: 3500 },
};

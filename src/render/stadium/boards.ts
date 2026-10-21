/**
 * The board band: the shell below BOARD_SPLIT_Y (and the flat goal-module panels round each goal
 * mouth), opaque and lit. Drawn from its surface coordinates (uv = distance round the outline,
 * profile distance up the wall; geometry.ts splitShell):
 *
 *  - the floor ramp's foot is a turf-coloured pad that darkens toward the boards (their shadow);
 *  - the LED boards (LED_LO..LED_HI, on the upper ramp and the foot of the wall, so they stay under
 *    y ~ 340 and the backdrop shows above them) are cards from the canvas atlas (textures.ts), one
 *    card per panel of PANEL_LEN uu, changing every 8 s with a slide that travels round the
 *    stadium; dim (ledIntensity ~0.4), with dark seams between panels and, on tiers with
 *    `netDetail`, an LED dot grid that only shows up close;
 *  - a thin white LED rail on top;
 *  - round each goal mouth the panel stays a dark padded surround (no boards, no rail), so the
 *    goal frames read against it.
 *
 * The texture is sampled with explicit gradients from a continuous coordinate, so there are no mip
 * seams at the panel and card edges. Bloom: the LEDs feed it softly (they are large), the rail more.
 */
import * as THREE from 'three/webgpu';
import { abs, dFdx, dFdy, float, floor, fract, fwidth, hash, length, max, mix, mod, oneMinus, positionWorld, smoothstep, step, texture, time, uv, vec2, vec3 } from 'three/tsl';
import { glowMrt } from '../materials';
import type { TierSpec } from '../quality';
import { FIELD, LED_FRAME, LED_HI, LED_LO, PANEL_LEN, RAIL_HI, RAIL_LO } from './layout';
import type { StadiumUniforms } from './palette';
import { BOARD_CARDS, BOARD_COLS, BOARD_ROWS } from './textures';

/** Seconds per card and the travel of the card change round the stadium (s per uu). */
const CARD_SECONDS = 8;
const CARD_WAVE = 0.00028;

export function buildBoardMaterial(spec: TierSpec, u: StadiumUniforms, atlas: THREE.Texture): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  const s = uv().x;
  const h = uv().y;
  const p = positionWorld;
  // The goal-module surround (the flat panel round each mouth): no boards there.
  const surround = step(abs(p.x), float(FIELD.moduleHalfW + 20)).mul(step(float(FIELD.halfZ - 200), abs(p.z)));
  const boardsOn = oneMinus(surround);

  const inBand = step(float(LED_LO), h).mul(step(h, float(LED_HI)));
  const inLed = step(float(LED_LO + LED_FRAME), h).mul(step(h, float(LED_HI - LED_FRAME))).mul(boardsOn);
  const ly = h.sub(LED_LO + LED_FRAME).div(LED_HI - LED_LO - 2 * LED_FRAME).saturate();
  const panel = floor(s.div(PANEL_LEN));
  const lx = fract(s.div(PANEL_LEN));
  // Cards change every CARD_SECONDS; the change runs round the stadium as a wave.
  const tt = time.add(s.mul(CARD_WAVE)).div(CARD_SECONDS);
  const slot = floor(tt);
  const f = fract(tt);
  const slide = smoothstep(0.0, 0.045, f); // the new card slides down from the top
  const group = mod(panel, 4);
  const cardOf = (sl: typeof slot): typeof slot => floor(hash(sl.mul(3.17).add(group.mul(11.3)).add(1.7)).mul(BOARD_CARDS - 0.001));
  const useNew = step(oneMinus(slide), ly);
  const card = mix(cardOf(slot.sub(1)), cardOf(slot), useNew);
  const cy = mix(ly.add(slide), ly.sub(oneMinus(slide)), useNew).saturate();
  const col = mod(card, BOARD_COLS);
  const row = floor(card.div(BOARD_COLS));
  const auv = vec2(
    col.add(lx.mul(0.996).add(0.002)).div(BOARD_COLS),
    float(1).sub(row.add(1).div(BOARD_ROWS)).add(cy.mul(0.98).add(0.01).div(BOARD_ROWS)),
  ).saturate();
  const cont = vec2(s.div(PANEL_LEN * BOARD_COLS), h.div((LED_HI - LED_LO - 2 * LED_FRAME) * BOARD_ROWS));
  const tex = texture(atlas, auv).grad(dFdx(cont), dFdy(cont)).rgb;

  let led = tex;
  if (spec.netDetail) {
    // LED dot grid (pitch 6 uu), only up close; it fades out before it could alias.
    const PITCH = 6;
    const fpx = max(fwidth(s), fwidth(h));
    const cell = fract(vec2(s, h).div(PITCH)).sub(0.5);
    const dots = oneMinus(smoothstep(0.28, 0.5, length(cell)));
    const near = oneMinus(smoothstep(PITCH * 0.25, PITCH * 0.7, fpx));
    led = tex.mul(mix(float(1), dots.mul(1.5).add(0.15), near));
  }
  const gap = smoothstep(0, 0.004, lx).mul(oneMinus(smoothstep(0.996, 1, lx)));
  const ledOn = led.mul(inLed).mul(gap).mul(u.ledIntensity);
  const rail = step(float(RAIL_LO), h).mul(step(h, float(RAIL_HI))).mul(boardsOn);
  const railCol = vec3(0.85, 0.92, 1.0).mul(rail).mul(u.railIntensity);

  // The ramp pad under the boards: turf-coloured, darkening toward them. The frames and the cap
  // above the rail are near-black; the surround is a dark padded panel with faint vertical seams.
  const pad = u.rampColor.mul(mix(float(1), float(0.35), smoothstep(float(-180), float(LED_LO), h)));
  const frameCol = vec3(0.012, 0.013, 0.017);
  const seams = smoothstep(0.0, 0.02, fract(p.x.div(290))).mul(0.25).add(0.75);
  const surroundCol = vec3(0.022, 0.024, 0.03).mul(seams);
  const base = mix(pad, frameCol, max(inBand, step(float(LED_HI), h)).mul(boardsOn));
  m.colorNode = mix(mix(base, vec3(0, 0, 0), inLed), surroundCol, surround.mul(step(float(LED_LO), h)));
  m.roughnessNode = mix(float(0.7), float(0.25), inLed);
  m.emissiveNode = ledOn.add(railCol);
  m.mrtNode = glowMrt(ledOn.mul(0.15).add(railCol.mul(0.5)), 'none');
  return m;
}

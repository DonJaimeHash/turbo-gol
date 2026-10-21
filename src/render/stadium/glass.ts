/**
 * The glass of the shell (walls) and the ceiling (moved from Arena.ts; the stadium phase of
 * docs/visuals/REWORK.md puts the cage's hex wire netting here).
 */
import * as THREE from 'three/webgpu';
import { abs, float, max, normalWorld, oneMinus, positionWorld, smoothstep, vec3 } from 'three/tsl';
import { ARENA } from '../../sim/constants';
import { cameraDistance, fresnel, glowMrt, hexEdgeMask, lineMask, type FloatNode, type Vec3Node } from '../materials';

/**
 * Dark glass for the shell (walls) and the ceiling: almost transparent, the stadium shows through;
 * fresnel brightens grazing views; a faint hex panel mesh only reads near the camera (tiers with
 * `netDetail`) and at grazing angles (walls only); bright white-cyan frames run where the glass
 * meets the floor ramp and where it meets the ceiling arc (HDR, they bloom). Rough glass reflects
 * the env map.
 */
export function buildGlassMaterial(netDetail: boolean, ceiling: boolean): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({
    roughness: 0.12,
    metalness: 0,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
  });
  const p = positionWorld;
  const fres2 = fresnel(2.0);
  let opacity: FloatNode = float(ceiling ? 0.12 : 0.16).add(fres2.mul(0.45));
  let glow: Vec3Node = vec3(0, 0, 0);
  let bloomGlow: Vec3Node = vec3(0, 0, 0);
  if (!ceiling) {
    const n = abs(normalWorld);
    const w = n.div(n.x.add(n.y).add(n.z));
    const cell = 320;
    const lw = 3;
    const hex = hexEdgeMask(p.zy, cell, lw)
      .mul(w.x)
      .add(hexEdgeMask(p.xy, cell, lw).mul(w.z))
      .add(hexEdgeMask(p.xz, cell, lw).mul(w.y));
    const grazing = fresnel(1.5).mul(0.6);
    let vis: FloatNode = grazing;
    if (netDetail) {
      const near = oneMinus(smoothstep(float(700), float(2400), cameraDistance()));
      vis = max(near.mul(0.9), grazing);
    }
    const hexVis = hex.mul(vis);
    const frame = lineMask(p.y.sub(ARENA.sideRampRadius + 8), 7).add(lineMask(p.y.sub(ARENA.height - ARENA.ceilingRadius - 8), 7));
    const frameColor = vec3(1.1, 1.6, 2.0);
    const hexGlow = vec3(0.3, 0.65, 1.0).mul(hexVis).mul(0.55);
    const frameGlow = frameColor.mul(frame);
    opacity = opacity.add(hexVis.mul(0.6)).add(frame);
    glow = hexGlow.add(frameGlow);
    bloomGlow = frameGlow.add(hexGlow.mul(0.25));
  }
  m.opacityNode = opacity.saturate();
  m.colorNode = vec3(0.02, 0.03, 0.05);
  m.emissiveNode = glow;
  m.mrtNode = glowMrt(bloomGlow);
  return m;
}

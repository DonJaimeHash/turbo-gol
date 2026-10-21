/**
 * What is visible of the floodlights (the pitch lighting itself is the lighting module's keys and
 * the turf's baked pools; nothing here is a light source):
 *
 *  - lamp panels: one quad per tower head, a grid of LAMP_COLS x LAMP_ROWS round lamps drawn as
 *    SDFs (an HDR core, a reflector ring, the dark frame). Directional: a lamp aimed at the camera
 *    is blinding, seen from the side it is a dim disc. HOT: the core is far above 1 and goes into
 *    the emissive target, so on tiers with bloom the bloom makes the halo. 1 draw.
 *  - glare: one camera-facing quad per head (corners offset in view space in the vertex shader,
 *    so 1 draw and no CPU work per frame). A TIGHT exponential falloff round the lamp, never 1/r
 *    (the 1/r halos of the prototype laid a grey veil over the roof): on tiers with bloom a small
 *    core only, on tiers without bloom a wider (still exponential) sprite halo stands in for it.
 *  - beams (tiers with `beamCones`): one open cone per head drawn from the inside, additive. Per
 *    pixel the closest point of the view ray to the beam's axis gives the beam radius there, the
 *    chord through the beam and the distance to the lamp; a Henyey-Greenstein phase term (haze
 *    scatters forward) makes them read as light in the air. 1 draw.
 *
 * Each head's brightness is its theme floodlight's strength (0 = off by day), carried per vertex in
 * `aStrength` (rewritten by setStrengths on a theme change: a buffer upload, never a recompile).
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  clamp,
  dot,
  exp,
  float,
  fract,
  length,
  max,
  mix,
  modelViewMatrix,
  normalize,
  oneMinus,
  positionLocal,
  positionWorld,
  pow,
  saturate,
  smoothstep,
  sqrt,
  step,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { glowMrt, noGlowMrt } from '../materials';
import type { TierSpec } from '../quality';
import { HEAD_H, HEAD_W, LAMP_COLS, LAMP_ROWS, towerHeads, type TowerHead } from './layout';
import type { StadiumUniforms } from './palette';

const WARM = [1.0, 0.93, 0.84] as const;
const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
];

/** A mesh whose vertices carry their head's strength (`aStrength`), rewritten on a theme change. */
export interface HeadMesh {
  readonly mesh: THREE.Mesh;
  /** Write each head's strength (layout.towerHeads order) into the vertex attribute. */
  setStrengths(strengths: readonly number[]): void;
}

function strengthAttribute(g: THREE.BufferGeometry, headOfVertex: Uint8Array): (strengths: readonly number[]) => void {
  const arr = new Float32Array(headOfVertex.length);
  const attr = new THREE.BufferAttribute(arr, 1);
  g.setAttribute('aStrength', attr);
  return (strengths) => {
    for (let i = 0; i < arr.length; i++) arr[i] = strengths[headOfVertex[i]] ?? 0;
    attr.needsUpdate = true;
  };
}

function quadIndex(n: number): number[] {
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    const b = i * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return index;
}

/** Lamp panels (one quad per head, facing its aim point, 2 uu in front of the head frame). */
export function buildLampPanels(u: StadiumUniforms, heads: readonly TowerHead[] = towerHeads()): HeadMesh {
  const n = heads.length;
  const pos = new Float32Array(n * 12);
  const uvs = new Float32Array(n * 8);
  const dirs = new Float32Array(n * 12);
  const headOf = new Uint8Array(n * 4);
  heads.forEach((H, i) => {
    CORNERS.forEach(([cx, cy], k) => {
      const v = i * 4 + k;
      for (let a = 0; a < 3; a++) pos[v * 3 + a] = H.position[a] + H.right[a] * cx * HEAD_W + H.up[a] * cy * HEAD_H + H.dir[a] * 2;
      uvs.set([cx + 0.5, cy + 0.5], v * 2);
      dirs.set(H.dir, v * 3);
      headOf[v] = i;
    });
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
  g.setIndex(quadIndex(n));
  g.computeBoundingSphere();
  const setStrengths = strengthAttribute(g, headOf);

  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const cell = uv().saturate().mul(vec2(LAMP_COLS, LAMP_ROWS));
  const local = fract(cell).sub(0.5).mul(vec2(HEAD_W / LAMP_COLS, HEAD_H / LAMP_ROWS));
  const r = length(local);
  const R = Math.min(HEAD_W / LAMP_COLS, HEAD_H / LAMP_ROWS) * 0.5;
  const core = oneMinus(smoothstep(R * 0.4, R * 0.6, r));
  const reflector = oneMinus(smoothstep(R * 0.6, R * 0.9, r));
  const dirN = attribute('aDir', 'vec3');
  const strength = attribute('aStrength', 'float');
  const toCam = normalize(cameraPosition.sub(positionWorld));
  // Luminous intensity vs viewing angle: 1 on the beam axis, ~0.03 at 90 degrees.
  const beam = pow(saturate(dot(dirN, toCam).mul(0.5).add(0.5)), 6).mul(0.97).add(0.03);
  const warm = vec3(...WARM);
  const hot = core.mul(u.lampIntensity).mul(beam).mul(strength);
  // Off by day: the lamps are grey discs in their reflectors.
  const lampCol = warm.mul(hot.add(reflector.mul(mix(float(0.06), float(0.3), saturate(strength)))));
  const frameCol = vec3(0.02, 0.022, 0.026);
  m.colorNode = mix(frameCol, lampCol, reflector);
  m.mrtNode = glowMrt(warm.mul(hot).mul(0.5), 'none');
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'stadium-lamp-panels';
  return { mesh, setStrengths };
}

/** Glare sprites (see the file header): tight on tiers with bloom, a sprite halo without. */
export function buildGlare(spec: TierSpec, u: StadiumUniforms, heads: readonly TowerHead[] = towerHeads()): HeadMesh {
  const size = spec.bloom ? 1500 : 2600; // full quad side (uu)
  const n = heads.length;
  const pos = new Float32Array(n * 12);
  const corner = new Float32Array(n * 8);
  const dirs = new Float32Array(n * 12);
  const headOf = new Uint8Array(n * 4);
  heads.forEach((H, i) => {
    CORNERS.forEach(([cx, cy], k) => {
      const v = i * 4 + k;
      pos.set(H.position, v * 3);
      corner.set([cx, cy], v * 2);
      dirs.set(H.dir, v * 3);
      headOf[v] = i;
    });
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  g.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
  g.setIndex(quadIndex(n));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const setStrengths = strengthAttribute(g, headOf);

  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  m.forceSinglePass = true; // one draw (a transparent DoubleSide material otherwise draws back then front)
  const c = attribute('aCorner', 'vec2');
  const centreView = modelViewMatrix.mul(vec4(positionLocal, 1.0));
  // Pulled 300 uu toward the camera so the tower's own head frame never clips the sprite.
  const toward = normalize(centreView.xyz).mul(-300);
  m.vertexNode = cameraProjectionMatrix.mul(vec4(centreView.xyz.add(toward).add(vec3(c.mul(size), 0)), 1.0));
  const dirN = attribute('aDir', 'vec3');
  const toCam = normalize(cameraPosition.sub(positionLocal)); // the mesh has an identity transform
  const facing = varying(pow(saturate(dot(dirN, toCam).mul(0.5).add(0.5)), 5).mul(attribute('aStrength', 'float')), 'vGlareFacing');
  const pv = c.mul(size); // uu from the lamp centre, in the view plane
  const rr = length(pv);
  // Exponential falloffs only (no 1/r tail): a hot core about the panel's size; without bloom a
  // wider soft halo and a faint horizontal streak stand in for it.
  const core = exp(rr.mul(-1 / 150));
  let shape = core.mul(1.1);
  // The quad's fade to zero before its border: square with bloom (the tight core is gone long
  // before it); round without, where the wide halo still shows there and the direct path's
  // display-space blending would draw a square's outline round every lamp.
  let edge = oneMinus(smoothstep(size * 0.32, size * 0.5, max(abs(pv.x), abs(pv.y))));
  if (!spec.bloom) {
    const halo = exp(rr.mul(-1 / 420));
    const streak = exp(abs(pv.y).mul(-1 / 30)).mul(exp(abs(pv.x).mul(-1 / 700)));
    shape = shape.add(halo.mul(0.35)).add(streak.mul(0.4));
    edge = oneMinus(smoothstep(size * 0.25, size * 0.5, rr));
  }
  m.colorNode = vec3(1.0, 0.9, 0.78).mul(shape.mul(edge)).mul(facing).mul(u.glare);
  m.mrtNode = noGlowMrt();
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'stadium-glare';
  return { mesh, setStrengths };
}

/** Beam half angle (rad) of the visible core of each beam, and how far it reaches toward its aim. */
const BEAM_TAN = Math.tan(0.2);
const BEAM_REACH = 0.82;

/** Fake volumetric beams (tiers with `beamCones`; see the file header). */
export function buildBeams(u: StadiumUniforms, heads: readonly TowerHead[] = towerHeads()): HeadMesh {
  const radialSegs = 18;
  const parts: THREE.BufferGeometry[] = [];
  const headOfParts: number[] = [];
  heads.forEach((H, hi) => {
    const p = new THREE.Vector3(...H.position);
    const t = new THREE.Vector3(...H.target);
    const d = new THREE.Vector3(...H.dir);
    const len = t.distanceTo(p) * BEAM_REACH;
    const geo = new THREE.ConeGeometry(len * BEAM_TAN * 1.25, len, radialSegs, 1, true);
    // ConeGeometry: apex at +len/2 on y. Move the apex to the origin pointing down -y, then aim.
    geo.translate(0, -len / 2, 0);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), d));
    geo.translate(p.x, p.y, p.z);
    const nv = geo.getAttribute('position').count;
    const apex = new Float32Array(nv * 4);
    const axis = new Float32Array(nv * 4);
    for (let i = 0; i < nv; i++) {
      apex.set([p.x, p.y, p.z, len], i * 4);
      axis.set([d.x, d.y, d.z, BEAM_TAN], i * 4);
      headOfParts.push(hi);
    }
    geo.setAttribute('aApex', new THREE.BufferAttribute(apex, 4));
    geo.setAttribute('aAxis', new THREE.BufferAttribute(axis, 4));
    geo.deleteAttribute('uv');
    geo.deleteAttribute('normal');
    parts.push(geo);
  });
  const g = mergeIndexed(parts);
  for (const p of parts) p.dispose();
  const setStrengths = strengthAttribute(g, Uint8Array.from(headOfParts));

  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide, fog: false });
  const A = attribute('aApex', 'vec4');
  const X = attribute('aAxis', 'vec4');
  const D = X.xyz;
  const tanA = X.w;
  const len = A.w;
  const O = cameraPosition;
  const toP = positionWorld.sub(O);
  const tEnd = length(toP).max(1);
  const V = toP.div(tEnd);
  // Closest point of the view ray (O + V t, 0 <= t <= tEnd) to the beam axis (A + D s).
  const w0 = O.sub(A.xyz);
  const b = dot(V, D);
  const dd = dot(V, w0);
  const e = dot(D, w0);
  const denom = max(float(1).sub(b.mul(b)), 1e-3);
  const t = clamp(b.mul(e).sub(dd).div(denom), 0, tEnd);
  const Q = O.add(V.mul(t));
  const s = dot(Q.sub(A.xyz), D);
  const radial = length(Q.sub(A.xyz).sub(D.mul(s)));
  const R = max(s.mul(tanA), 1);
  const inBeam = saturate(float(1).sub(radial.div(R).mul(radial.div(R))));
  const chord = sqrt(max(R.mul(R).sub(radial.mul(radial)), 0)).mul(2).div(max(sqrt(denom), 0.3));
  const atten = float(1).div(float(1).add(s.mul(s).div(1800 * 1800))).mul(oneMinus(smoothstep(len.mul(0.55), len, s))).mul(step(0, s));
  // Henyey-Greenstein, g = 0.55: light along D seen by a camera looking along V.
  const g2 = 0.55;
  const cosT = dot(D, V.negate());
  const phase = float(1 - g2 * g2).div(pow(max(float(1 + g2 * g2).sub(cosT.mul(2 * g2)), 0.02), 1.5)).mul(0.25);
  const density = chord.mul(inBeam.mul(inBeam)).mul(atten).mul(phase).mul(1 / 2400);
  const col = vec3(...WARM).mul(density.min(3)).mul(u.beam).mul(attribute('aStrength', 'float'));
  m.colorNode = col;
  m.mrtNode = glowMrt(col.mul(0.05));
  const mesh = new THREE.Mesh(g, m);
  mesh.name = 'stadium-beams';
  return { mesh, setStrengths };
}

/** Merge indexed geometries with the same attribute set (cones: position, aApex, aAxis). */
function mergeIndexed(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const names = Object.keys(parts[0].attributes);
  const g = new THREE.BufferGeometry();
  let nv = 0;
  for (const p of parts) nv += p.getAttribute('position').count;
  for (const name of names) {
    const size = parts[0].getAttribute(name).itemSize;
    const arr = new Float32Array(nv * size);
    let o = 0;
    for (const p of parts) {
      const src = p.getAttribute(name).array as Float32Array;
      arr.set(src, o);
      o += src.length;
    }
    g.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  const idx: number[] = [];
  let base = 0;
  for (const p of parts) {
    const index = p.getIndex();
    if (index !== null) for (let i = 0; i < index.count; i++) idx.push(index.getX(i) + base);
    base += p.getAttribute('position').count;
  }
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * Banners with procedural emblems (textures.ts) hung on the cage, waving in the wind.
 *
 * One instanced, subdivided plane hung from the top ring just OUTSIDE the netting (behind the
 * arches' tubes), so it never pokes into the playable volume. The vertex shader displaces each
 * vertex along the banner's outward normal only (0 <= d <= 78 uu): a steady
 * billow plus two travelling waves whose amplitude grows from the hem at the top to the free
 * swallow-tail at the bottom; the bottom also sways sideways. The normal is rebuilt analytically
 * from the derivatives of the same function, so the folds catch the light. Lit, opaque with an
 * alpha cut (the swallow-tail). 1 draw; 12 banners, 24 with `detail` high (the corners too).
 */
import * as THREE from 'three/webgpu';
import { attribute, cameraViewMatrix, cos, faceDirection, float, mix, normalize, positionLocal, pow, sin, step, texture, time, uv, varying, vec2, vec3, vec4 } from 'three/tsl';
import type { TierSpec } from '../quality';
import { BANNER_DESIGNS, BANNER_H, BANNER_TOP, BANNER_W, bannerPlaces } from './layout';

export interface BannerBuild {
  readonly mesh: THREE.InstancedMesh;
  readonly count: number;
}

export function buildBanners(spec: TierSpec, atlas: THREE.Texture): BannerBuild {
  const high = spec.detail === 'high';
  const place = bannerPlaces(high);
  const geo = new THREE.PlaneGeometry(BANNER_W, BANNER_H, high ? 6 : 3, high ? 20 : 10);
  geo.translate(0, -BANNER_H / 2, 0); // hang from the top edge (local y = 0)
  const out = new Float32Array(place.length * 4);
  const side = new Float32Array(place.length * 4);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardNodeMaterial(), place.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  const zAxis = new THREE.Vector3(0, 0, 1);
  const inward = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const sv = new THREE.Vector3();
  place.forEach((p, i) => {
    // Local +z (the printed face) faces the field: the inward normal (-nx, -nz).
    q.setFromUnitVectors(zAxis, inward.set(-p.nx, 0, -p.nz));
    m4.compose(pos.set(p.x, BANNER_TOP, p.z), q, one);
    mesh.setMatrixAt(i, m4);
    out.set([p.nx, 0, p.nz, p.design], i * 4);
    sv.set(1, 0, 0).applyQuaternion(q); // the banner's local +x in world space (along the wall)
    side.set([sv.x, sv.y, sv.z, i * 1.618], i * 4);
  });
  mesh.instanceMatrix.needsUpdate = true;
  // Per-banner data as instanced geometry attributes (freed with the geometry): outward normal +
  // design index, and the banner's along-wall axis + wind phase.
  geo.setAttribute('aOut', new THREE.InstancedBufferAttribute(out, 4));
  geo.setAttribute('aSide', new THREE.InstancedBufferAttribute(side, 4));
  const O = attribute<'vec4'>('aOut', 'vec4');
  const Sd = attribute<'vec4'>('aSide', 'vec4');

  (mesh.material as THREE.Material).dispose();
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
  const U = uv().x.saturate();
  const V = float(1).sub(uv().y).saturate(); // 0 at the top hem, 1 at the bottom
  const t = time;
  const ph = Sd.w;
  // Displacement along the outward normal (uu) and its slopes (per uu across / down).
  const kV = 7.0;
  const kU = 4.0;
  const amp = pow(V, 1.3);
  const w1 = sin(V.mul(kV).sub(t.mul(2.3)).add(ph));
  const w2 = sin(U.mul(kU).add(t.mul(3.1)).add(ph.mul(1.7)));
  const base = float(40).add(w1.mul(26)).add(w2.mul(12)); // 2..78 uu: always outward
  const d = amp.mul(base);
  const dV = pow(V.max(0.001), 0.3).mul(1.3).mul(base).add(amp.mul(cos(V.mul(kV).sub(t.mul(2.3)).add(ph)).mul(26 * kV))).div(BANNER_H);
  const dU = amp.mul(cos(U.mul(kU).add(t.mul(3.1)).add(ph.mul(1.7))).mul(12 * kU)).div(BANNER_W);
  const sway = V.mul(V).mul(sin(t.mul(1.1).add(ph)).mul(20));
  const outN = O.xyz;
  const sideN = Sd.xyz;
  m.positionNode = positionLocal.add(outN.mul(d)).add(sideN.mul(sway));
  // Front normal = -out, tilted by the slopes (V grows downward, so d/dy = -dV).
  const nW = normalize(outN.negate().add(sideN.mul(dU)).sub(vec3(0, 1, 0).mul(dV)));
  const nV = varying(cameraViewMatrix.mul(vec4(nW, 0)).xyz, 'vBannerN');
  m.normalNode = normalize(nV).mul(faceDirection);
  // The printed face; the back shows the print through the cloth, darker.
  const col = O.w.add(U.mul(0.996).add(0.002)).div(BANNER_DESIGNS);
  const tex = texture(atlas, vec2(col, uv().y.saturate()));
  m.colorNode = tex.rgb.mul(mix(float(0.5), float(1), step(0, faceDirection)));
  m.opacityNode = tex.a;
  m.alphaTest = 0.5;
  mesh.material = m;
  mesh.name = 'stadium-banners';
  return { mesh, count: place.length };
}

/**
 * The stadium around the field (moved from Arena.ts): the shell and ceiling glass (glass.ts), a
 * steel truss with spotlight lamp heads and haze cones above the glass roof, the stands (tiered
 * crowd with camera flashes following the rounded field outline, roof ring) and four floodlight
 * masts with their heads and halos. ArenaView builds it and disposes it; the stadium phase of
 * docs/visuals/REWORK.md (cage, LED boards, banners, towers, beams) grows it behind this view.
 *
 * Draw calls: shell 1, ceiling 1, emissive bars 1, truss 1, cones 1, stands 1, masts 1, halos 1
 * = 8. Nothing changes per frame (the crowd flashes and cone fades run on the GPU clock).
 *
 * Bloom: see materials.ts. Every unlit material here that should glow tags its glow with
 * `glowMrt()`.
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  cameraProjectionMatrix,
  diffuseColor,
  float,
  floor,
  hash,
  length,
  mix,
  modelViewMatrix,
  normalView,
  normalWorld,
  oneMinus,
  positionGeometry,
  positionLocal,
  positionViewDirection,
  positionWorld,
  smoothstep,
  step,
  time,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { ARENA } from '../../sim/constants';
import { cameraDistance, glowMrt, hdrColor, lineMask, linearVec3 } from '../materials';
import { tier, type Quality } from '../quality';
import type { ThemeId } from '../theme';
import { buildGlassMaterial } from './glass';

/** Stands: tiers of unit boxes ring the rounded field outline; the end walls start beyond the goal backs. */
const STAND_TIERS = 14;
const ROOF_TIERS = 2;
const TIER_HEIGHT = 170;
const TIER_DEPTH = 260;
const STAND_OFFSET_SIDE = 900;
const STAND_OFFSET_END = ARENA.goalDepth + 240;
/** Chords per rounded stand corner. */
const STAND_CORNER_SEGS = 5;
const STAND_BASE_Y = 260;
const ROOF_Y = STAND_BASE_Y + STAND_TIERS * TIER_HEIGHT;
const MAST_X = ARENA.extentX + 2600;
const MAST_Z = ARENA.extentY + 2200;
const MAST_HEIGHT = 3400;
const HALO_SIZE = 1400;
/** Truss above the glass ceiling (outside the playable volume): 3 girders, 11 cross beams. */
const TRUSS_Y = ARENA.height + 140;
const TRUSS_GIRDERS: readonly number[] = [-0.6 * ARENA.extentX, 0, 0.6 * ARENA.extentX];
const TRUSS_BEAMS = 11;
const TRUSS_BEAM_STEP = (ARENA.extentY * 2) / (TRUSS_BEAMS - 1);
/** Lamp rows halfway between the cross beams, 4 per half (8 of the 10 gaps, the end gaps stay dark). */
const LAMP_ROWS: readonly number[] = [-3.5, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5].map((k) => k * TRUSS_BEAM_STEP);
const LAMP_Y = TRUSS_Y - 50;
const CONE_HEIGHT = 900;
const CONE_RADIUS = 380;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _e = new THREE.Euler();

interface Disposable {
  dispose(): void;
}

/** The sim's glass surfaces in three coords (owned and disposed by the view). */
export interface StadiumGlass {
  readonly shell: THREE.BufferGeometry;
  readonly ceiling: THREE.BufferGeometry;
}

export class StadiumView {
  readonly shell: THREE.Mesh;
  readonly ceiling: THREE.Mesh;

  private readonly disposables: Disposable[] = [];

  /** Build the stadium for a tier (`netDetail` on the glass) and a theme (not read yet) into `parent`. */
  constructor(parent: THREE.Object3D, glass: StadiumGlass, quality: Quality, theme: ThemeId) {
    const spec = tier(quality);
    void theme;

    // ---- Shell + ceiling: dark glass (transparent, drawn first among transparents) --------------
    this.shell = new THREE.Mesh(glass.shell, buildGlassMaterial(spec.netDetail, false));
    this.shell.castShadow = false;
    this.shell.receiveShadow = false;
    this.shell.matrixAutoUpdate = false;
    this.shell.frustumCulled = false;
    this.shell.renderOrder = -5;
    this.track(glass.shell, this.shell.material as THREE.Material);
    parent.add(this.shell);

    this.ceiling = new THREE.Mesh(glass.ceiling, buildGlassMaterial(spec.netDetail, true));
    this.ceiling.castShadow = false;
    this.ceiling.receiveShadow = false;
    this.ceiling.matrixAutoUpdate = false;
    this.ceiling.frustumCulled = false;
    this.ceiling.renderOrder = -5;
    this.track(glass.ceiling, this.ceiling.material as THREE.Material);
    parent.add(this.ceiling);

    // ---- Emissive bars: truss lamp heads, floodlight heads (1 draw call) ------------------------
    parent.add(this.buildEmissiveBars());

    // ---- Roof: truss lattice + spotlight haze cones (2 draw calls) -----------------------------
    parent.add(this.buildTruss());
    parent.add(this.buildCones());

    // ---- Stadium backdrop: crowd tiers + roof ring, masts, floodlight halos (3 draw calls) -----
    parent.add(this.buildStands());
    parent.add(this.buildMasts());
    parent.add(this.buildHalos());
  }

  /** Free every geometry and material (the parent removes the meshes from the scene). */
  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private track(...items: Disposable[]): void {
    for (const d of items) this.disposables.push(d);
  }

  /** 24 lamp heads under the truss (hot white) and 4 floodlight heads. */
  private buildEmissiveBars(): THREE.InstancedMesh {
    const count = TRUSS_GIRDERS.length * LAMP_ROWS.length + 4;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicNodeMaterial();
    material.mrtNode = glowMrt(diffuseColor.rgb, 'none');
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    let i = 0;
    const put = (x: number, y: number, z: number, sx: number, sy: number, sz: number, hex: number, intensity: number, yaw = 0): void => {
      _e.set(0, yaw, 0);
      _q.setFromEuler(_e);
      _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
      mesh.setMatrixAt(i, _m);
      mesh.setColorAt(i, hdrColor(hex, intensity, _c));
      i++;
    };
    // Spotlight lamp heads at the girder / beam crossings, just under the truss.
    for (const x of TRUSS_GIRDERS) for (const z of LAMP_ROWS) put(x, LAMP_Y, z, 180, 40, 180, 0xfff4e0, 3.5);
    // Floodlight heads on the four masts, angled at the centre spot.
    for (const sx of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        const x = sx * MAST_X;
        const z = sz * MAST_Z;
        put(x, MAST_HEIGHT - 120, z, 760, 320, 40, 0xfff6e6, 3.2, Math.atan2(-x, -z));
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.track(geometry, material);
    return mesh;
  }

  /** Steel lattice above the glass ceiling: 3 girders, 11 cross beams, a zig-zag web between them. */
  private buildTruss(): THREE.InstancedMesh {
    const beams = TRUSS_BEAMS;
    const gaps = TRUSS_GIRDERS.length - 1;
    const count = TRUSS_GIRDERS.length + beams + (beams - 1) * gaps;
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardNodeMaterial({ color: 0x2b313c, roughness: 0.55, metalness: 0.6 });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    let i = 0;
    for (const x of TRUSS_GIRDERS) {
      _m.compose(_p.set(x, TRUSS_Y, 0), _q.identity(), _s.set(60, 60, ARENA.extentY * 2 + 1600));
      mesh.setMatrixAt(i++, _m);
    }
    for (let b = 0; b < beams; b++) {
      const z = -ARENA.extentY + b * TRUSS_BEAM_STEP;
      _m.compose(_p.set(0, TRUSS_Y, z), _q.identity(), _s.set(ARENA.extentX * 2 + 1200, 60, 60));
      mesh.setMatrixAt(i++, _m);
    }
    for (let b = 0; b < beams - 1; b++) {
      for (let g = 0; g < gaps; g++) {
        let z0 = -ARENA.extentY + b * TRUSS_BEAM_STEP;
        let z1 = z0 + TRUSS_BEAM_STEP;
        if ((b + g) % 2 === 1) [z0, z1] = [z1, z0];
        const x0 = TRUSS_GIRDERS[g];
        const x1 = TRUSS_GIRDERS[g + 1];
        const len = Math.hypot(x1 - x0, z1 - z0);
        _e.set(0, Math.atan2(-(z1 - z0), x1 - x0), 0);
        _q.setFromEuler(_e);
        _m.compose(_p.set((x0 + x1) / 2, TRUSS_Y - 40, (z0 + z1) / 2), _q, _s.set(len, 40, 40));
        mesh.setMatrixAt(i++, _m);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.track(geometry, material);
    return mesh;
  }

  /** Fake volumetric spotlight cones hanging from the lamp heads (additive haze, tip at the lamp). */
  private buildCones(): THREE.InstancedMesh {
    const count = TRUSS_GIRDERS.length * LAMP_ROWS.length;
    const geometry = new THREE.ConeGeometry(1, 1, 12, 1, true);
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    // ConeGeometry's uv.y is 1 at the tip: bright at the lamp, fading to the base; the silhouette
    // fades out so the cone reads as haze, not a shape. The bloom tag deliberately uses only the
    // tip fade (no pow(), no view-dependent term): three clamps the colour target but writes the
    // MRT glow member raw, so a NaN there blooms into a black rectangle (see materials.ts).
    const fade = uv().y.mul(uv().y);
    const facing = abs(normalView.dot(positionViewDirection));
    const warm = vec3(1.0, 0.95, 0.85);
    const col = warm.mul(0.1).mul(fade).mul(facing).toVar();
    material.colorNode = col;
    material.mrtNode = glowMrt(warm.mul(0.05).mul(fade));
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    let i = 0;
    for (const x of TRUSS_GIRDERS) {
      for (const z of LAMP_ROWS) {
        _m.compose(_p.set(x, LAMP_Y - 20 - CONE_HEIGHT / 2, z), _q.identity(), _s.set(CONE_RADIUS, CONE_HEIGHT, CONE_RADIUS));
        mesh.setMatrixAt(i++, _m);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.track(geometry, material);
    return mesh;
  }

  /**
   * Seat tiers: stepped rings around the arena following its rounded outline, offset outward so
   * they sit behind the glass (the end walls start beyond the goal backs). 14 crowd tiers plus a
   * dark 2-tier roof ring; each ring is 2 sides, 2 ends and 4 corner arcs of STAND_CORNER_SEGS
   * chords, one draw call. Every instance is a unit box whose local +z points away from the arena,
   * which the crowd shader relies on.
   */
  private buildStands(): THREE.InstancedMesh {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = buildSeatMaterial();
    const rings = STAND_TIERS + 1;
    const perRing = 4 + 4 * STAND_CORNER_SEGS;
    const mesh = new THREE.InstancedMesh(geometry, material, rings * perRing);
    let i = 0;
    const seg = (x0: number, z0: number, x1: number, z1: number, y: number, h: number, nx: number, nz: number, stretch = 1): void => {
      _e.set(0, Math.atan2(nx, nz), 0);
      _q.setFromEuler(_e);
      _m.compose(_p.set((x0 + x1) / 2, y, (z0 + z1) / 2), _q, _s.set(Math.hypot(x1 - x0, z1 - z0) * stretch, h, TIER_DEPTH));
      mesh.setMatrixAt(i, _m);
      i++;
    };
    for (let t = 0; t < rings; t++) {
      const roof = t === STAND_TIERS;
      const offSide = STAND_OFFSET_SIDE + t * TIER_DEPTH;
      const offEnd = STAND_OFFSET_END + t * TIER_DEPTH;
      const h = roof ? TIER_HEIGHT * ROOF_TIERS : TIER_HEIGHT;
      const y = STAND_BASE_Y + t * TIER_HEIGHT + h / 2;
      // The ring is the field outline grown by offSide (same corner centres, radius + offSide),
      // with the straight ends pushed out further to offEnd.
      const sideX = ARENA.extentX + offSide;
      const endZ = ARENA.extentY + offEnd;
      const cx = ARENA.cornerCentreX;
      const cz = endZ - (ARENA.cornerRadius + offSide);
      const rr = ARENA.cornerRadius + offSide;
      seg(sideX, -cz, sideX, cz, y, h, 1, 0);
      seg(-sideX, -cz, -sideX, cz, y, h, -1, 0);
      seg(-cx, endZ, cx, endZ, y, h, 0, 1);
      seg(-cx, -endZ, cx, -endZ, y, h, 0, -1);
      // Corner chords, stretched so the outer faces of neighbouring boxes meet.
      const stretch = (rr + TIER_DEPTH / 2) / (rr * Math.cos(Math.PI / 4 / STAND_CORNER_SEGS));
      for (const sx of [-1, 1] as const) {
        for (const sz of [-1, 1] as const) {
          for (let k = 0; k < STAND_CORNER_SEGS; k++) {
            const a0 = ((Math.PI / 2) * k) / STAND_CORNER_SEGS;
            const a1 = ((Math.PI / 2) * (k + 1)) / STAND_CORNER_SEGS;
            const am = (a0 + a1) / 2;
            seg(
              sx * (cx + rr * Math.cos(a0)),
              sz * (cz + rr * Math.sin(a0)),
              sx * (cx + rr * Math.cos(a1)),
              sz * (cz + rr * Math.sin(a1)),
              y,
              h,
              sx * Math.cos(am),
              sz * Math.sin(am),
              stretch,
            );
          }
        }
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.track(geometry, material);
    return mesh;
  }

  /** Four floodlight masts with a crossarm each (the lamp heads live in the emissive mesh). */
  private buildMasts(): THREE.InstancedMesh {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardNodeMaterial({ color: 0x1b1f28, roughness: 0.7, metalness: 0.4 });
    const mesh = new THREE.InstancedMesh(geometry, material, 8);
    let i = 0;
    for (const sx of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        const x = sx * MAST_X;
        const z = sz * MAST_Z;
        _m.compose(_p.set(x, MAST_HEIGHT / 2, z), _q.identity(), _s.set(90, MAST_HEIGHT, 90));
        mesh.setMatrixAt(i++, _m);
        _e.set(0, Math.atan2(-x, -z), 0);
        _q.setFromEuler(_e);
        _m.compose(_p.set(x, MAST_HEIGHT - 320, z), _q, _s.set(900, 50, 50));
        mesh.setMatrixAt(i++, _m);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.track(geometry, material);
    return mesh;
  }

  /**
   * Floodlight halos: one mesh of four camera-facing quads (billboarded in the vertex shader from a
   * per-vertex corner attribute, so a single draw call and no per-frame CPU work).
   */
  private buildHalos(): THREE.Mesh {
    const n = 4;
    const pos = new Float32Array(n * 4 * 3);
    const corner = new Float32Array(n * 4 * 2);
    const uvs = new Float32Array(n * 4 * 2);
    const index = new Uint16Array(n * 6);
    let v = 0;
    let k = 0;
    const corners: ReadonlyArray<readonly [number, number]> = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ];
    for (const sx of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        const base = v;
        for (const [cx, cy] of corners) {
          pos[v * 3] = sx * MAST_X;
          pos[v * 3 + 1] = MAST_HEIGHT - 120;
          pos[v * 3 + 2] = sz * MAST_Z;
          corner[v * 2] = cx;
          corner[v * 2 + 1] = cy;
          uvs[v * 2] = cx + 0.5;
          uvs[v * 2 + 1] = cy + 0.5;
          v++;
        }
        index[k++] = base;
        index[k++] = base + 1;
        index[k++] = base + 2;
        index[k++] = base;
        index[k++] = base + 2;
        index[k++] = base + 3;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));

    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const cornerN = attribute('aCorner', 'vec2');
    const centreView = modelViewMatrix.mul(vec4(positionLocal, 1.0));
    material.vertexNode = cameraProjectionMatrix.mul(centreView.add(vec4(cornerN.mul(HALO_SIZE), 0.0, 0.0)));
    const falloff = oneMinus(smoothstep(0.15, 0.5, length(uv().sub(0.5))));
    const col = vec3(1.0, 0.92, 0.78).mul(falloff).mul(1.2);
    material.colorNode = col;
    material.mrtNode = glowMrt(col.mul(0.8));

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.track(geometry, material);
    return mesh;
  }
}

/**
 * Crowd tiers (unlit; the stands are floodlit so a flat look is right): the arena-facing faces are
 * a hashed palette of dim multicolour dots with a team tint per end, sparse HDR camera flashes
 * and a distance dim; the walkway tops are concrete with a lit rail; the roof ring is dark.
 */
function buildSeatMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  const pw = positionWorld;
  const isTop = smoothstep(float(0.3), float(0.7), normalWorld.y);
  const isRoof = step(float(ROOF_Y), pw.y);

  // Cells along each tier (the mix of x and z keeps the curved corner segments from striping).
  const cell = floor(vec2(pw.x.mul(0.8).add(pw.z.mul(1.25)), pw.y).div(34));
  const h = hash(cell.x.add(cell.y.mul(57.17)).add(11.3));
  const h2 = hash(cell.x.mul(3.1).add(cell.y.mul(29.3)).add(5.7));
  const navy = linearVec3(0x151c2e);
  const grey = linearVec3(0x3a4152);
  const light = linearVec3(0x6b6a62);
  const teamSide = smoothstep(float(-1500), float(1500), pw.z);
  const teamCol = mix(linearVec3(0x1d3f8a), linearVec3(0x7a1424), teamSide);
  let crowd = mix(mix(navy, grey, step(float(0.45), h)), light, step(float(0.82), h));
  crowd = mix(crowd, teamCol, step(float(0.5), h2).mul(0.35));
  const flashOn = step(float(0.985), hash(cell.x.add(cell.y.mul(57.17)).add(floor(time.mul(6)).mul(13.7))));
  const flash = vec3(2.5, 2.5, 2.5).mul(flashOn);
  const dim = mix(float(1), float(0.55), smoothstep(float(3000), float(9000), cameraDistance()));

  // Walkway: concrete with a bright rail 18 uu from the front edge (local z = -0.5 faces the arena).
  const rail = lineMask(positionGeometry.z.add(0.5).mul(TIER_DEPTH).sub(18), 6);
  const railCol = vec3(0.9, 0.95, 1.0).mul(rail).mul(0.6);
  const topCol = linearVec3(0x20242c).add(railCol);

  let col = mix(crowd.add(flash), topCol, isTop).mul(dim);
  col = mix(col, linearVec3(0x0a0d14), isRoof);
  m.colorNode = col;
  const notRoof = oneMinus(isRoof);
  m.mrtNode = glowMrt(flash.mul(oneMinus(isTop)).mul(notRoof).add(railCol.mul(isTop).mul(0.5)), 'none');
  return m;
}

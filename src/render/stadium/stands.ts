/**
 * The stands along both side walls (the ends behind the goals stay open for the backdrop) and the
 * crowd in them.
 *
 *  - Structure: stepped concrete rows (tread + riser, team-coloured seats), the front wall, aisles,
 *    end walls, a back wall, a roof canopy with a row of downlights, and the concourse apron (the
 *    floor round the cage out to the stands' footprint, see buildApron). One merged mesh, one lit
 *    material (colour procedural from the position and a per-vertex part kind: no textures).
 *  - Crowd: one instanced quad per seat block (thousands), opaque with an alpha cut (alpha to
 *    coverage under MSAA). Each person is drawn in the fragment shader from a few SDFs (torso,
 *    head, hair; raised arms and a scarf on tiers with `netDetail`), shirts from a team-dominant
 *    palette (the blue half of each stand mostly blue, the red half mostly red, the rest dark
 *    casual colours), hashed per-person shading noise, darker by row depth (the back rows sit under
 *    the canopy, out of the floodlights) with a pool of light under the canopy's downlights. The
 *    vertex shader computes the animation per seat (a travelling wave, idle bobbing) and passes it
 *    on as varyings; standing up moves the body inside the quad, the seat stays put.
 *    `crowdDensity` < 1 draws 1 / crowdDensity people per quad (fewer instances, same crowd).
 *
 * Unlit crowd (its light is `crowdLight`, a theme uniform): its glow (rare phone flashes) goes
 * through glowMrt. Nothing here is inside the playable volume (the stands at x >= STAND.x0 = 5150,
 * the apron below the pitch, outside the field outline).
 */
import * as THREE from 'three/webgpu';
import {
  abs,
  attribute,
  dot,
  float,
  floor,
  fract,
  fwidth,
  hash,
  length,
  max,
  min,
  mix,
  oneMinus,
  positionWorld,
  saturate,
  select,
  sin,
  smoothstep,
  step,
  time,
  uv,
  varying,
  vec2,
  vec3,
} from 'three/tsl';
import { TEAM_BLUE, TEAM_RED, glowMrt, linearVec3, type FloatNode, type Vec2Node, type Vec3Node } from '../materials';
import type { TierSpec } from '../quality';
import { rng } from './geometry';
import { FIELD, STAND, standRowX, standRowY } from './layout';
import type { StadiumUniforms } from './palette';

const S = STAND;
const TOP_X = standRowX(S.rows);
const TOP_Y = standRowY(S.rows);
/** Canopy downlights: their |x| (a row under the canopy's front edge) and spacing along z. */
const DOWNLIGHT_X = standRowX(S.roofRow) + 120;
const DOWNLIGHT_STEP = 420;

// Part kinds (aKind) for the structure shader.
const K_TREAD = 0;
const K_RISER = 1;
const K_FRONT = 2;
const K_WALL = 3;
const K_ROOF = 4;
const K_FASCIA = 5;
const K_APRON = 6;

type Pt = readonly [number, number, number];

/** Quads (a, b, c, d round the edge) -> one non-indexed geometry with normals and a part kind. */
class QuadBuilder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly kind: number[] = [];

  quad(a: Pt, b: Pt, c: Pt, d: Pt, n: Pt, k: number): void {
    // Wind the triangles so their front face is the side the normal points to (the material is
    // DoubleSide and flips the normal on back faces, so a mismatch would light the wrong side).
    this.emit(QuadBuilder.facing(a, b, c, n) ? [a, b, c, a, c, d] : [a, c, b, a, d, c], n, k);
  }

  tri(a: Pt, b: Pt, c: Pt, n: Pt, k: number): void {
    this.emit(QuadBuilder.facing(a, b, c, n) ? [a, b, c] : [a, c, b], n, k);
  }

  /** True when (a, b, c) winds counter-clockwise seen from the side `n` points to. */
  private static facing(a: Pt, b: Pt, c: Pt, n: Pt): boolean {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    return cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] >= 0;
  }

  private emit(order: readonly Pt[], n: Pt, k: number): void {
    for (const v of order) {
      this.pos.push(v[0], v[1], v[2]);
      this.nor.push(n[0], n[1], n[2]);
      this.kind.push(k);
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(this.kind, 1));
    g.computeBoundingSphere();
    return g;
  }
}

export function buildStandGeometry(): THREE.BufferGeometry {
  const qb = new QuadBuilder();
  const Z = S.halfLen;
  for (const sx of [-1, 1]) {
    // Built for the +x stand (x grows away from the field) and mirrored (QuadBuilder fixes the winding).
    const X = (p: Pt): Pt => [sx * p[0], p[1], p[2]];
    const quad = (a: Pt, b: Pt, c: Pt, d: Pt, n: Pt, k: number): void => qb.quad(X(a), X(b), X(c), X(d), [sx * n[0], n[1], n[2]], k);
    quad([S.x0, 0, Z], [S.x0, 0, -Z], [S.x0, S.y0, -Z], [S.x0, S.y0, Z], [-1, 0, 0], K_FRONT);
    for (let r = 0; r < S.rows; r++) {
      const x0 = standRowX(r);
      const x1 = standRowX(r + 1);
      const y = standRowY(r);
      const y1 = standRowY(r + 1);
      quad([x0, y, Z], [x0, y, -Z], [x1, y, -Z], [x1, y, Z], [0, 1, 0], K_TREAD);
      quad([x1, y, Z], [x1, y, -Z], [x1, y1, -Z], [x1, y1, Z], [-1, 0, 0], K_RISER);
    }
    quad([TOP_X, TOP_Y, Z], [TOP_X, TOP_Y, -Z], [TOP_X, S.roofY, -Z], [TOP_X, S.roofY, Z], [-1, 0, 0], K_WALL);
    for (const sz of [-1, 1]) {
      const z = sz * Z;
      for (let r = 0; r <= S.rows; r++) {
        const xa = r === 0 ? S.x0 : standRowX(r);
        const xb = r === S.rows ? TOP_X + 40 : standRowX(r + 1);
        const yt = r === 0 ? S.y0 : standRowY(r);
        if (sz > 0) quad([xa, 0, z], [xb, 0, z], [xb, yt, z], [xa, yt, z], [0, 0, 1], K_WALL);
        else quad([xb, 0, z], [xa, 0, z], [xa, yt, z], [xb, yt, z], [0, 0, -1], K_WALL);
      }
      if (sz > 0) quad([TOP_X - 600, TOP_Y, z], [TOP_X + 40, TOP_Y, z], [TOP_X + 40, S.roofY, z], [TOP_X - 600, S.roofY, z], [0, 0, 1], K_WALL);
      else quad([TOP_X + 40, TOP_Y, z], [TOP_X - 600, TOP_Y, z], [TOP_X - 600, S.roofY, z], [TOP_X + 40, S.roofY, z], [0, 0, -1], K_WALL);
    }
    // Canopy: underside (faces down), front fascia, top.
    const rx0 = standRowX(S.roofRow);
    const rz = Z + 200;
    quad([rx0, S.roofY, -rz], [rx0, S.roofY, rz], [TOP_X + 60, S.roofY, rz], [TOP_X + 60, S.roofY, -rz], [0, -1, 0], K_ROOF);
    quad([rx0, S.roofY, rz], [rx0, S.roofY, -rz], [rx0, S.roofY + 120, -rz], [rx0, S.roofY + 120, rz], [-1, 0, 0], K_FASCIA);
    quad([rx0, S.roofY + 120, rz], [rx0, S.roofY + 120, -rz], [TOP_X + 60, S.roofY + 160, -rz], [TOP_X + 60, S.roofY + 160, rz], [0, 1, 0], K_WALL);
  }
  buildApron(qb);
  return qb.geometry();
}

/** The concourse floor's height (just under the pitch: never z-fights the turf or the goal floors). */
export const APRON_Y = -6;
/** Its outer edge: the back of the stands' canopies and the stands' ends (+ the canopy overhang). */
export const APRON_X = TOP_X + 60;
export const APRON_Z = S.halfLen + 200;
/** Chords of each corner arc of the apron's inner edge (the field outline, under the shell). */
const APRON_CORNER_SEGS = 12;

/**
 * The concourse floor round the cage: from the field outline out to the stands' footprint
 * (|x| <= APRON_X, |z| <= APRON_Z), dark concrete at APRON_Y. Without it nothing lies outside the
 * shell, so a camera on a wall or in the air looked down through the netting (transparent from
 * y = 360) between the cage and the stands into the sky dome's pale lower half: a bright band
 * along the board line. Per quadrant: a side strip, an end strip and a fan round the corner arc
 * (the chords sit inside the outline, under the floor ramp, by at most 4 uu).
 */
function buildApron(qb: QuadBuilder): void {
  const up: Pt = [0, 1, 0];
  const y = APRON_Y;
  const R = FIELD.cornerR;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const P = (x: number, z: number): Pt => [sx * x, y, sz * z];
      qb.quad(P(FIELD.halfX, 0), P(APRON_X, 0), P(APRON_X, FIELD.cz), P(FIELD.halfX, FIELD.cz), up, K_APRON);
      qb.quad(P(0, FIELD.halfZ), P(FIELD.cx, FIELD.halfZ), P(FIELD.cx, APRON_Z), P(0, APRON_Z), up, K_APRON);
      // Corner: a fan from the apron's corner (it sees the whole arc) plus the two edge triangles.
      const far = P(APRON_X, APRON_Z);
      let prev = P(FIELD.cx + R, FIELD.cz);
      qb.tri(far, P(APRON_X, FIELD.cz), prev, up, K_APRON);
      for (let i = 1; i <= APRON_CORNER_SEGS; i++) {
        const a = (i / APRON_CORNER_SEGS) * (Math.PI / 2);
        const next = P(FIELD.cx + R * Math.cos(a), FIELD.cz + R * Math.sin(a));
        qb.tri(far, prev, next, up, K_APRON);
        prev = next;
      }
      qb.tri(far, prev, P(FIELD.cx, APRON_Z), up, K_APRON);
    }
  }
}

/** Seat-block colour of a stand point: team seats per half (blue toward -z, red toward +z). */
function teamHalf(z: FloatNode): FloatNode {
  return smoothstep(float(-900), float(900), z);
}

export function buildStandMaterial(u: StadiumUniforms): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  const kind = attribute('aKind', 'float');
  const p = positionWorld;
  const isK = (k: number): FloatNode => step(float(k - 0.5), kind).mul(step(kind, float(k + 0.5)));
  const stone = vec3(0.065, 0.068, 0.072).mul(hash(floor(p.z.div(300)).add(floor(p.y.div(46)).mul(7.1))).mul(0.12).add(0.88));
  // Timber stands (a theme's standWood): planks along z with a per-board tone, shingles on the canopy.
  const board = hash(floor(p.y.div(30)).add(floor(p.z.div(470)).mul(3.7)).add(floor(p.x.div(470)).mul(1.3)));
  const timber = vec3(0.17, 0.088, 0.042).mul(board.mul(0.4).add(0.7));
  const shingle = vec3(0.06, 0.034, 0.02).mul(hash(floor(p.z.div(80)).add(floor(p.x.div(60)).mul(5.3))).mul(0.45).add(0.75));
  const concrete = mix(stone, timber, u.standWood);
  // Aisles: lighter stair concrete every aisleEvery seats.
  const period = S.aisleEvery * S.seatW + S.aisleW;
  const az = fract(p.z.add(S.halfLen).div(period)).mul(period);
  const inAisle = step(az, float(S.aisleW));
  const seatCol = mix(linearVec3(0x0a1a3a), linearVec3(0x3a0912), teamHalf(p.z));
  const tread = mix(concrete.mul(0.6), concrete.mul(0.9), inAisle);
  const riser = mix(seatCol, concrete, inAisle);
  const front = mix(vec3(0.018, 0.02, 0.026), timber.mul(0.45), u.standWood);
  const roof = mix(vec3(0.022, 0.022, 0.026), shingle, u.standWood);
  // Downlights: a row of lamps under the canopy's front.
  const lampRow = step(abs(abs(p.x).sub(DOWNLIGHT_X)), float(26)).mul(step(abs(fract(p.z.div(DOWNLIGHT_STEP)).sub(0.5)), float(0.09)));
  const down = vec3(1.0, 0.95, 0.85).mul(lampRow).mul(isK(K_ROOF)).mul(u.canopyLight.mul(14));
  let col: Vec3Node = concrete;
  col = mix(col, tread, isK(K_TREAD));
  col = mix(col, riser, isK(K_RISER));
  col = mix(col, concrete.mul(0.55), isK(K_WALL));
  col = mix(col, front, isK(K_FRONT));
  col = mix(col, roof, isK(K_ROOF).add(isK(K_FASCIA)));
  // The concourse apron: dark concrete slabs (it is only ever seen through the netting).
  const slab = hash(floor(p.x.div(500)).add(floor(p.z.div(500)).mul(13.7))).mul(0.3).add(0.7);
  col = mix(col, vec3(0.03, 0.032, 0.036).mul(slab), isK(K_APRON));
  m.colorNode = col;
  m.emissiveNode = down;
  m.mrtNode = glowMrt(down.mul(0.4), 'none');
  return m;
}

interface Seat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly sx: number;
  readonly r: number;
  readonly seed: number;
}

/** Seat-block positions (both stands, `perQuad` seats each), skipping the aisles; front rows first. */
function seatLayout(perQuad: number, seed: number): Seat[] {
  const rand = rng(seed);
  const period = S.aisleEvery * S.seatW + S.aisleW;
  const seats: Seat[] = [];
  for (let r = 0; r < S.rows; r++) {
    for (const sx of [-1, 1]) {
      let z = -S.halfLen + S.aisleW;
      while (z + S.seatW * perQuad <= S.halfLen) {
        const into = (z + S.halfLen) % period;
        if (into < S.aisleW) {
          z += S.aisleW - into;
          continue;
        }
        if (into + S.seatW * perQuad > period) {
          z += period - into;
          continue;
        }
        seats.push({ x: sx * (standRowX(r) + 30), y: standRowY(r), z: z + (S.seatW * perQuad) / 2, sx, r, seed: rand() });
        z += S.seatW * perQuad;
      }
    }
  }
  return seats;
}

/** Quad height (uu): room for a person standing up with raised arms above the seat. */
const CROWD_H = 140;

export interface CrowdBuild {
  readonly mesh: THREE.InstancedMesh;
  readonly people: number;
}

export function buildCrowd(spec: TierSpec, u: StadiumUniforms): CrowdBuild {
  const full = spec.netDetail; // arms, scarves, hands: the detailed figure
  const P = Math.max(1, Math.round(1 / Math.max(0.05, spec.crowdDensity)));
  const W = S.seatW * P;
  const seats = seatLayout(P, 7);
  const geo = new THREE.PlaneGeometry(W, CROWD_H);
  geo.translate(0, CROWD_H / 2, 0);
  geo.deleteAttribute('normal');
  const info = new Float32Array(seats.length * 4);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicNodeMaterial(), seats.length);
  seats.forEach((s, i) => {
    // The quad faces the field: local +z -> world -sx * x.
    q.setFromAxisAngle(up, s.sx > 0 ? -Math.PI / 2 : Math.PI / 2);
    m4.compose(pos.set(s.x, s.y, s.z), q, one);
    mesh.setMatrixAt(i, m4);
    // seed, team half (0 blue .. 1 red, by z), row fraction (0 front .. 1 back), z (for the wave)
    info.set([s.seed, s.z < 0 ? 0 : 1, s.r / (S.rows - 1), s.z], i * 4);
  });
  mesh.instanceMatrix.needsUpdate = true;
  // Per-seat-block data as an instanced geometry attribute (freed with the geometry).
  geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
  const I = attribute<'vec4'>('aInfo', 'vec4');

  (mesh.material as THREE.Material).dispose();
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.FrontSide });
  // ---- Vertex stage: the animation state per seat block ----
  const seed = I.x;
  const t = time;
  // A travelling wave round each stand (one lap ~ 14 s) and an idle bob.
  const wave = smoothstep(0.86, 0.98, sin(I.w.mul(1 / 1500).sub(t.mul(0.45)).add(I.y.mul(3.0))));
  const bob = sin(t.mul(float(1.3).add(seed.mul(1.7))).add(seed.mul(30))).mul(1.5);
  const lift = varying(wave.mul(30).add(bob), 'vLift');
  const arms = varying(wave, 'vArms');
  const info4 = varying(I, 'vInfo');

  // ---- Fragment stage: the people ----
  const uq = uv().saturate();
  const px = uq.x.mul(P);
  const cellI = floor(px);
  const seedP = hash(info4.x.mul(173.1).add(cellI.mul(13.37)));
  const seedQ = hash(seedP.mul(51.3).add(2.1));
  const seedR = hash(seedQ.mul(37.9).add(5.3));
  // uu inside this person's seat cell: x in [-seatW/2, seatW/2], y in [0, CROWD_H].
  const q2: Vec2Node = vec2(fract(px).sub(0.5).mul(S.seatW), uq.y.mul(CROWD_H));
  const sc = seedQ.mul(0.22).add(0.88);
  const dx = seedR.sub(0.5).mul(9);
  const y0 = lift;
  const occ = step(0.075, fract(seedP.mul(7.31))); // ~7% empty seats
  // Torso: a rounded box, wider at the shoulders.
  const tc = q2.sub(vec2(dx, y0.add(sc.mul(42))));
  const taper = saturate(tc.y.div(sc.mul(40)).add(0.5));
  const tb = abs(tc).sub(vec2(sc.mul(mix(float(12), float(16), taper)), sc.mul(19)));
  const torso = length(max(tb, vec2(0, 0))).add(min(max(tb.x, tb.y), float(0))).sub(sc.mul(9));
  // Head (a slightly tall ellipse) above a short neck gap.
  const hc = vec2(dx.add(seedP.sub(0.5).mul(3)), y0.add(sc.mul(84)));
  const head = length(q2.sub(hc).mul(vec2(1, 0.9))).sub(sc.mul(11));
  let body: FloatNode = min(torso, head);
  const armUp = arms.mul(step(0.25, seedQ)).saturate();
  const shoulderY = y0.add(sc.mul(62));
  const handY = shoulderY.add(sc.mul(46).mul(armUp));
  if (full) {
    const capsule = (a: Vec2Node, b: Vec2Node, r: FloatNode): FloatNode => {
      const pa = q2.sub(a);
      const ba = b.sub(a);
      const h = saturate(dot(pa, ba).div(dot(ba, ba).max(1e-3)));
      return length(pa.sub(ba.mul(h))).sub(r);
    };
    const armL = capsule(vec2(dx.sub(sc.mul(15)), shoulderY), vec2(dx.sub(sc.mul(15).add(sc.mul(9).mul(armUp))), handY), sc.mul(5));
    const armR = capsule(vec2(dx.add(sc.mul(15)), shoulderY), vec2(dx.add(sc.mul(15).add(sc.mul(9).mul(armUp))), handY), sc.mul(5));
    body = min(body, mix(float(1e3), min(armL, armR), step(0.05, armUp)));
  }
  const aa = fwidth(body).max(0.5);
  const person = oneMinus(smoothstep(aa.negate(), aa, body)).mul(occ);
  const scarf = full
    ? step(abs(q2.y.sub(handY.sub(4))), float(5)).mul(step(abs(q2.x.sub(dx)), sc.mul(26))).mul(step(0.5, armUp)).mul(step(seedR, float(0.18))).mul(occ)
    : float(0);

  // Colours: a team-dominant palette. Each stand's blue half (z < 0) is mostly blue shirts, the
  // red half mostly red; the rest wear dark casual colours, a few bright. Kits are a little
  // desaturated (fabric under warm floodlight, not the HUD's pure team colours).
  const teamPure = mix(linearVec3(TEAM_BLUE), linearVec3(TEAM_RED), info4.y);
  const team = mix(teamPure, vec3(dot(teamPure, vec3(0.2126, 0.7152, 0.0722))), 0.25).mul(0.3);
  const pal = (k: FloatNode): Vec3Node => {
    let c: Vec3Node = vec3(0.5, 0.5, 0.48); // white
    c = select(k.greaterThan(0.12), vec3(0.016, 0.016, 0.018), c); // black
    c = select(k.greaterThan(0.4), vec3(0.09, 0.095, 0.105), c); // grey
    c = select(k.greaterThan(0.62), vec3(0.02, 0.03, 0.08), c); // navy
    c = select(k.greaterThan(0.8), vec3(0.4, 0.28, 0.04), c); // yellow
    c = select(k.greaterThan(0.9), vec3(0.045, 0.11, 0.05), c); // green
    return c;
  };
  const isTeam = step(seedP, float(0.42));
  // Team shirts vary in shade (kits, scarves, jackets over them).
  const shirt = mix(pal(seedQ), team.mul(seedR.mul(0.7).add(0.45)), isTeam);
  const skin = mix(vec3(0.5, 0.34, 0.24), vec3(0.13, 0.075, 0.045), seedR.mul(seedR));
  const hair = mix(vec3(0.02, 0.015, 0.01), vec3(0.3, 0.21, 0.1), step(0.85, seedQ));
  const inHead = oneMinus(smoothstep(aa.negate(), aa, head));
  const hairMask = inHead.mul(step(hc.y.add(sc.mul(2.5)).sub(seedR.mul(4)), q2.y)).mul(step(0.25, seedP));
  // Cheap volume: the torso a cylinder (darker at its sides), the head a sphere lit from above,
  // a soft shadow of the head on the chest.
  const nx = q2.x.sub(dx).div(sc.mul(18)).saturate();
  const torsoShade = oneMinus(nx.mul(nx).mul(0.45)).mul(smoothstep(y0.add(sc.mul(10)), y0.add(sc.mul(62)), q2.y).mul(0.35).add(0.7));
  const neck = oneMinus(oneMinus(smoothstep(float(0), sc.mul(14), length(q2.sub(hc.sub(vec2(0, sc.mul(14))))))).mul(0.35));
  const hq2 = q2.sub(hc).div(sc.mul(11));
  const headShade = saturate(hq2.y.mul(0.35).add(0.85).sub(dot(hq2, hq2).mul(0.25)));
  let colP: Vec3Node = mix(shirt.mul(torsoShade).mul(neck), skin.mul(headShade), inHead);
  colP = mix(colP, hair.mul(headShade), hairMask);
  if (full) {
    const hand = step(handY.sub(sc.mul(6)), q2.y).mul(step(0.05, armUp)).mul(oneMinus(inHead));
    colP = mix(colP, skin, hand.mul(step(sc.mul(10), abs(q2.x.sub(dx)))));
  }
  colP = mix(colP, team.mul(1.4), scarf);
  // Seat back behind the lower body; everything above the figure is cut away.
  const seatMask = step(q2.y, float(36));
  const seatCol = mix(linearVec3(0x0a1a3a), linearVec3(0x3a0912), info4.y).mul(0.5);
  const coverage = max(person, scarf);
  // Light: floodlit from above (brighter at the top of each figure), hashed per-person noise,
  // darker by row depth (the back rows sit under the canopy) with a pool under the downlights.
  const shade = smoothstep(float(0), float(110), q2.y).mul(0.5).add(0.5).mul(seedR.mul(0.35).add(0.75));
  const depth = info4.z;
  const depthLight = mix(float(1), oneMinus(u.crowdDepthDim), smoothstep(0.25, 1.0, depth));
  const pool = smoothstep(0.32, 0.5, depth).mul(oneMinus(smoothstep(0.62, 0.85, depth))).mul(u.canopyLight);
  const light = u.crowdLight.mul(depthLight.add(pool));
  let col: Vec3Node = mix(seatCol, colP, coverage).mul(shade).mul(light);
  // Phone flashes / camera lights: rare HDR sparkles near the hands.
  const flashOn = step(0.9965, hash(seedP.mul(97.1).add(floor(t.mul(6)).mul(0.731)))).mul(occ);
  const flash = flashOn.mul(oneMinus(smoothstep(1.5, 3.5, length(q2.sub(vec2(dx.add(8), y0.add(70))))))).mul(12);
  col = col.add(vec3(1, 1, 1).mul(flash));
  m.colorNode = col;
  m.opacityNode = max(coverage, seatMask);
  m.alphaTest = 0.5;
  if (spec.msaa > 0) m.alphaToCoverage = true;
  m.mrtNode = glowMrt(vec3(1, 1, 1).mul(flash).mul(0.4), 'none');
  mesh.material = m;
  mesh.name = 'stadium-crowd';
  return { mesh, people: seats.length * P };
}

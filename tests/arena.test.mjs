// Validity tests for the analytic arena mesh (node --test tests/arena.test.mjs).
// Node strips the types of .ts files natively; src imports are extensionless (what tsc/Vite want),
// so a resolve hook maps them to the .ts file before the module is loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('.') || /\.[cm]?ts$/.test(specifier)) throw err;
      return nextResolve(specifier.replace(/\.js$/, '') + '.ts', context);
    }
  },
});

const { buildArenaMesh, computeNormals, isInsideArena, indicesAsUint32, cornerRampRadius } = await import('../src/sim/arenaMesh.ts');
const { ARENA, BALL, GOAL_PROFILE } = await import('../src/sim/constants.ts');

const W = ARENA.extentX;
const L = ARENA.extentY;
const H = ARENA.height;
const GW = ARENA.goalHalfWidth;
const GH = ARENA.goalHeight;
const GD = ARENA.goalDepth;
const RC = ARENA.cornerRadius;
const CX = ARENA.cornerCentreX;
const CY = ARENA.cornerCentreY;
const TOL = 1;
const EPS = 1e-3;

// ---- helpers ------------------------------------------------------------------------------

function vert(m, i) {
  return [m.vertices[i * 3], m.vertices[i * 3 + 1], m.vertices[i * 3 + 2]];
}

function* triangles(m) {
  const idx = m.indices;
  for (let t = 0; t < idx.length; t += 3) {
    yield { t: t / 3, a: vert(m, idx[t]), b: vert(m, idx[t + 1]), c: vert(m, idx[t + 2]), ia: idx[t], ib: idx[t + 1], ic: idx[t + 2] };
  }
}

function faceNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/**
 * The triangle faces into the playable volume: a few uu along its normal is inside the arena
 * (isInsideArena, tested against the geometry below); the floor faces up and the ceiling down.
 */
function facesInward(region, n, cx, cy, cz) {
  if (region === 'floor') return n[2] > 0;
  if (region === 'ceiling') return n[2] < 0;
  const k = 6 / Math.hypot(n[0], n[1], n[2]);
  return isInsideArena(cx + n[0] * k, cy + n[1] * k, cz + n[2] * k);
}

function validateMesh(m, region) {
  const nv = m.vertices.length / 3;
  const nt = m.indices.length / 3;
  assert.ok(nv > 0, `${region}: has vertices`);
  assert.ok(nt > 0, `${region}: has triangles`);
  assert.equal(m.vertices.length % 3, 0, `${region}: vertices are xyz triples`);
  assert.equal(m.indices.length % 3, 0, `${region}: indices are triangles`);
  assert.ok(m.vertices instanceof Float32Array, `${region}: vertices Float32Array`);
  assert.ok(m.indices instanceof Int32Array, `${region}: indices Int32Array`);
  for (let i = 0; i < m.vertices.length; i++) assert.ok(Number.isFinite(m.vertices[i]), `${region}: vertex ${i} finite`);
  for (let i = 0; i < m.indices.length; i++) {
    const k = m.indices[i];
    assert.ok(Number.isInteger(k) && k >= 0 && k < nv, `${region}: index ${i} (${k}) in range`);
  }
  for (const tri of triangles(m)) {
    assert.ok(tri.ia !== tri.ib && tri.ib !== tri.ic && tri.ia !== tri.ic, `${region}: tri ${tri.t} repeats a vertex`);
    const n = faceNormal(tri.a, tri.b, tri.c);
    const area = Math.hypot(n[0], n[1], n[2]) / 2;
    assert.ok(area > 1e-2, `${region}: tri ${tri.t} degenerate (area ${area})`);
    const cx = (tri.a[0] + tri.b[0] + tri.c[0]) / 3;
    const cy = (tri.a[1] + tri.b[1] + tri.c[1]) / 3;
    const cz = (tri.a[2] + tri.b[2] + tri.c[2]) / 3;
    assert.ok(facesInward(region, n, cx, cy, cz), `${region}: tri ${tri.t} at (${cx.toFixed(0)}, ${cy.toFixed(0)}, ${cz.toFixed(0)}) faces outward`);
  }
}

function aabb(m) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], m.vertices[i + k]);
      hi[k] = Math.max(hi[k], m.vertices[i + k]);
    }
  }
  return { lo, hi };
}

function assertBounds(m, region) {
  const { lo, hi } = aabb(m);
  assert.ok(lo[0] >= -W - TOL && hi[0] <= W + TOL, `${region}: x within +-${W} (${lo[0]}..${hi[0]})`);
  assert.ok(lo[1] >= -(L + GD) - TOL && hi[1] <= L + GD + TOL, `${region}: y within +-${L + GD} (${lo[1]}..${hi[1]})`);
  assert.ok(lo[2] >= -TOL && hi[2] <= H + TOL, `${region}: z within 0..${H} (${lo[2]}..${hi[2]})`);
}

/**
 * True if the triangle touches the plane |y| = L and overlaps the mouth's clear rectangle there
 * (|x| < GW - edgeRadius: outside it the floor curves of the netting rise from the floor).
 */
function crossesMouth(tri) {
  const ys = [tri.a[1], tri.b[1], tri.c[1]].map(Math.abs);
  const touchesPlane = Math.max(...ys) >= L - EPS && Math.min(...ys) <= L + EPS;
  if (!touchesPlane) return false;
  const xs = [tri.a[0], tri.b[0], tri.c[0]];
  const zs = [tri.a[2], tri.b[2], tri.c[2]];
  const clear = GW - GOAL_PROFILE.edgeRadius;
  const overlapX = Math.min(...xs) < clear - EPS && Math.max(...xs) > -clear + EPS;
  const overlapZ = Math.min(...zs) < GH - EPS && Math.max(...zs) > EPS;
  return overlapX && overlapZ;
}

/**
 * Every edge used by exactly one triangle must lie on an open boundary that something else closes:
 * the floor plane or the ceiling plane (the goals are part of the closed mesh). Edges keyed by
 * quantised position so coincident vertices of different sub-meshes match.
 */
function assertBoundaryEdges(m, region) {
  const key = (v) => `${Math.round(v[0] * 100)},${Math.round(v[1] * 100)},${Math.round(v[2] * 100)}`;
  const uses = new Map();
  const add = (p, q) => {
    const kp = key(p);
    const kq = key(q);
    const k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
    const e = uses.get(k);
    if (e) e.n++;
    else uses.set(k, { n: 1, p, q });
  };
  for (const tri of triangles(m)) {
    add(tri.a, tri.b);
    add(tri.b, tri.c);
    add(tri.c, tri.a);
  }
  const onFloor = (v) => Math.abs(v[2]) < EPS;
  const onCeiling = (v) => Math.abs(v[2] - H) < EPS;
  let open = 0;
  for (const [k, e] of uses) {
    assert.ok(e.n <= 2, `${region}: edge ${k} shared by ${e.n} triangles`);
    if (e.n === 2) continue;
    open++;
    const ok = (onFloor(e.p) && onFloor(e.q)) || (onCeiling(e.p) && onCeiling(e.q));
    assert.ok(ok, `${region}: open edge ${k} is not on the floor or the ceiling`);
  }
  assert.ok(open > 0, `${region}: has the expected open boundaries`);
}

/**
 * Boundary loop of a centre fan (triangles whose first index is the centre). The fan is valid iff
 * the loop is star-shaped from the centre; additionally no turn may be concave by more than
 * `maxConcaveDeg` (the floor ring bulges slightly where the ramp radius eases from the side to the back value).
 */
function assertStarFan(m, region, centreIndex, maxConcaveDeg) {
  const loop = [];
  for (const tri of triangles(m)) if (tri.ia === centreIndex) loop.push(tri.ib);
  assert.ok(loop.length > 8, `${region}: fan has a boundary loop`);
  const c0 = vert(m, centreIndex);
  for (let j = 0; j < loop.length; j++) {
    const a = vert(m, loop[j]);
    const b = vert(m, loop[(j + 1) % loop.length]);
    const c = vert(m, loop[(j + 2) % loop.length]);
    const star = (a[0] - c0[0]) * (b[1] - c0[1]) - (a[1] - c0[1]) * (b[0] - c0[0]);
    assert.ok(star > 1e3, `${region}: loop edge ${j} is not seen CCW from the fan centre`);
    const ux = b[0] - a[0], uy = b[1] - a[1];
    const vx = c[0] - b[0], vy = c[1] - b[1];
    const turn = (Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * 180) / Math.PI;
    assert.ok(turn > -maxConcaveDeg, `${region}: loop vertex ${j + 1} turns ${turn.toFixed(2)} deg (concave)`);
  }
}

// ---- tests --------------------------------------------------------------------------------

const configs = [
  { name: 'default', opts: undefined },
  { name: 'low', opts: { rampSegments: 6, ceilingSegments: 4, cornerSegments: 6 } },
  { name: 'high', opts: { rampSegments: 16, ceilingSegments: 10, cornerSegments: 20 } },
];

for (const { name, opts } of configs) {
  const arena = buildArenaMesh(opts);
  const regions = ['physics', 'shell', 'goals', 'floor', 'ceiling'];

  test(`[${name}] meshes are well formed and face inward`, () => {
    for (const r of regions) validateMesh(arena[r], r);
  });

  test(`[${name}] bounding boxes stay inside the arena`, () => {
    for (const r of regions) assertBounds(arena[r], r);
    const g = aabb(arena.goals);
    assert.ok(g.hi[1] > L + GD - 5 && g.lo[1] < -(L + GD) + 5, 'goals reach the back of the net');
    assert.ok(Math.abs(g.hi[2] - (GH + GOAL_PROFILE.postRadius)) < EPS, "the crossbar's rounded edge meets the wall postRadius above the mouth");
    const s = aabb(arena.shell);
    assert.ok(Math.abs(s.hi[0] - W) < EPS && Math.abs(s.lo[0] + W) < EPS, 'shell reaches the side walls');
    assert.ok(Math.abs(s.hi[1] - L) < EPS && Math.abs(s.lo[1] + L) < EPS, 'shell reaches the back walls');
    assert.ok(Math.abs(s.lo[2]) < EPS && Math.abs(s.hi[2] - H) < EPS, 'shell spans floor to ceiling');
  });

  test(`[${name}] vertex budget is a few thousand`, () => {
    const total = (arena.shell.vertices.length + arena.goals.vertices.length + arena.floor.vertices.length + arena.ceiling.vertices.length) / 3;
    assert.ok(total < 12000, `total visual vertices ${total}`);
    assert.ok(arena.physics.vertices.length / 3 < 12000, 'physics vertices');
    assert.ok(arena.physics.indices.length / 3 < 16000, 'physics triangles');
  });

  test(`[${name}] goal mouths are open`, () => {
    for (const tri of triangles(arena.shell)) assert.ok(!crossesMouth(tri), `shell tri ${tri.t} crosses a goal mouth`);
    for (const tri of triangles(arena.physics)) assert.ok(!crossesMouth(tri), `physics tri ${tri.t} crosses a goal mouth`);
  });

  test(`[${name}] physics mesh excludes the floor/ceiling planes but keeps back walls and goals`, () => {
    let backWall = 0;
    let goal = 0;
    for (const tri of triangles(arena.physics)) {
      const zs = [tri.a[2], tri.b[2], tri.c[2]];
      assert.ok(!zs.every((z) => Math.abs(z) < EPS), `physics tri ${tri.t} lies in the floor plane`);
      assert.ok(!zs.every((z) => Math.abs(z - H) < EPS), `physics tri ${tri.t} lies in the ceiling plane`);
      const ys = [tri.a[1], tri.b[1], tri.c[1]];
      if (ys.every((y) => Math.abs(Math.abs(y) - L) < EPS) && Math.min(...zs) >= GH - EPS) backWall++;
      if (ys.every((y) => Math.abs(y) > L + EPS)) goal++;
    }
    assert.ok(backWall >= 4, `back wall triangles above the mouth (${backWall})`);
    assert.ok(goal >= 20, `goal chamber triangles (${goal})`);
    assert.equal(arena.physics.vertices.length, arena.shell.vertices.length + arena.goals.vertices.length);
    assert.equal(arena.physics.indices.length, arena.shell.indices.length + arena.goals.indices.length);
  });

  test(`[${name}] physics mesh is closed except where RocketSim planes / junction lines close it`, () => {
    assertBoundaryEdges(arena.physics, 'physics');
  });

  test(`[${name}] no right angles anywhere: every crease between neighbouring triangles is one chord of an arc`, () => {
    // The goals' posts, crossbar and chamber edges are rounded like the rest of the field: the
    // sharpest crease is a facet of the coarsest arc (ramps, corners, the goals' edges).
    const segs = Math.min(opts?.rampSegments ?? 12, opts?.cornerSegments ?? 12, Math.max(4, Math.round(((opts?.rampSegments ?? 12) * 2) / 3)));
    const limit = 90 / segs + 2;
    const m = arena.physics;
    const key = (v) => `${Math.round(v[0] * 100)},${Math.round(v[1] * 100)},${Math.round(v[2] * 100)}`;
    const edges = new Map();
    const normals = [];
    for (const tri of triangles(m)) {
      const n = faceNormal(tri.a, tri.b, tri.c);
      const l = Math.hypot(n[0], n[1], n[2]);
      normals.push([n[0] / l, n[1] / l, n[2] / l]);
      for (const [p, q] of [[tri.a, tri.b], [tri.b, tri.c], [tri.c, tri.a]]) {
        const kp = key(p);
        const kq = key(q);
        const k = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
        const e = edges.get(k);
        if (e) e.push(tri.t);
        else edges.set(k, [tri.t]);
      }
    }
    let worst = 0;
    let at = '';
    for (const [k, ts] of edges) {
      if (ts.length !== 2) continue;
      const a = normals[ts[0]];
      const b = normals[ts[1]];
      const deg = (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
      if (deg > worst) {
        worst = deg;
        at = k;
      }
    }
    assert.ok(worst < limit, `sharpest crease ${worst.toFixed(1)} deg at ${at} (limit ${limit.toFixed(1)})`);
  });

  test(`[${name}] floor and ceiling fans are star-shaped (ceiling convex)`, () => {
    // The floor ring turns concave round each post (the ramp feet wrap into the goal), one goal-arc chord at a time.
    const goalArcs = Math.max(4, Math.round(((opts?.rampSegments ?? 12) * 2) / 3));
    assertStarFan(arena.floor, 'floor', 0, Math.max(12, 90 / goalArcs + 0.5));
    assertStarFan(arena.ceiling, 'ceiling', 0, 1e-6);
    const f = aabb(arena.floor);
    assert.ok(Math.abs(f.hi[1] - (L + GD)) < EPS, 'floor covers the goal floors');
    assert.ok(f.hi[2] < EPS && f.lo[2] > -EPS, 'floor is flat at z = 0');
    const c = aabb(arena.ceiling);
    assert.ok(Math.abs(c.lo[2] - H) < EPS && Math.abs(c.hi[2] - H) < EPS, 'ceiling is flat at z = H');
    assert.ok(c.hi[0] < W - ARENA.ceilingRadius + EPS, 'ceiling is inset by the ceiling arc');
  });

  test(`[${name}] ramps and arcs sit where constants.ts puts them`, () => {
    // Side-wall ramp foot at x = W - sideRampRadius on the floor (the side wall is one straight edge
    // whose ring vertices sit at the corner tangent points |y| ~ CY), back-wall ramp foot at
    // y = L - backRampRadius, ceiling arc top inset ceilingRadius from the side wall.
    const s = arena.shell;
    let sideFoot = false;
    let backFoot = false;
    let ceilTop = false;
    for (let i = 0; i < s.vertices.length; i += 3) {
      const x = s.vertices[i], y = s.vertices[i + 1], z = s.vertices[i + 2];
      // (the miter offset at the tangent point adds a small y component: tan(half chord angle) * inset)
      if (Math.abs(z) < EPS && Math.abs(x - (W - ARENA.sideRampRadius)) < EPS && Math.abs(y - CY) < 60) sideFoot = true;
      if (Math.abs(z) < EPS && Math.abs(y - (L - ARENA.backRampRadius)) < EPS && Math.abs(x) < 2000) backFoot = true;
      if (Math.abs(z - H) < EPS && Math.abs(x - (W - ARENA.ceilingRadius)) < EPS && Math.abs(y - CY) < 60) ceilTop = true;
    }
    assert.ok(sideFoot, 'side ramp foot at x = W - r');
    assert.ok(backFoot, 'back ramp foot at y = L - r');
    assert.ok(ceilTop, 'ceiling arc top at x = W - r');
  });

  test(`[${name}] corners are rounded: quarter circles of radius cornerRadius around (CX, CY), no chamfer`, () => {
    // Every shell vertex in a corner region (|x| > CX and |y| > CY) lies on a circle around the
    // corner centre whose radius is the corner radius minus the ramp / ceiling inset at that height
    // (chord vertices: the polygon is offset parallel, so they sit inset / cos(half chord) inside).
    const s = arena.shell;
    const segs = opts?.cornerSegments ?? 12;
    const chord = 1 / Math.cos(Math.PI / 4 / segs);
    let checked = 0;
    let atFloor = 0;
    for (let i = 0; i < s.vertices.length; i += 3) {
      const ax = Math.abs(s.vertices[i]);
      const ay = Math.abs(s.vertices[i + 1]);
      const z = s.vertices[i + 2];
      const dx = ax - CX;
      const dy = ay - CY;
      if (dx < 1 || dy < 1) continue;
      const d = Math.hypot(dx, dy);
      assert.ok(d <= RC + EPS, `corner vertex (${ax.toFixed(0)}, ${ay.toFixed(0)}, ${z.toFixed(0)}) outside the corner circle (${d.toFixed(1)})`);
      if (Math.abs(z) < EPS) {
        const want = RC - cornerRampRadius(Math.atan2(dy, dx)) * chord;
        assert.ok(Math.abs(d - want) < 3, `floor corner vertex at radius ${d.toFixed(1)}, want ~${want.toFixed(1)}`);
        atFloor++;
      }
      if (Math.abs(z - H) < EPS) assert.ok(Math.abs(d - (RC - ARENA.ceilingRadius * chord)) < 3, `ceiling corner vertex at radius ${d.toFixed(1)}`);
      checked++;
    }
    assert.ok(atFloor >= 4 * (segs - 1), `floor ring has the arc vertices (${atFloor})`);
    assert.ok(checked > 40, `corner vertices checked (${checked})`);
    // The old style 45-degree chamfer would put the floor point (CX + 0.75 RC, CY + 0.75 RC) inside;
    // the rounded corner leaves it outside, and the point on the 45-degree radius just inside the
    // ramp foot is inside.
    const k = Math.SQRT1_2;
    assert.ok(!isInsideArena(CX + RC * 0.75, CY + RC * 0.75, 400), 'beyond the rounded corner');
    assert.ok(isInsideArena(CX + (RC - 30) * k, CY + (RC - 30) * k, 400), 'inside the rounded corner wall');
  });

  test(`[${name}] computeNormals yields unit normals, floor up / ceiling down`, () => {
    for (const r of regions) {
      const n = computeNormals(arena[r]);
      assert.equal(n.length, arena[r].vertices.length);
      for (let i = 0; i < n.length; i += 3) {
        const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
        assert.ok(Math.abs(len - 1) < 1e-4, `${r}: normal ${i / 3} is unit`);
      }
    }
    const nf = computeNormals(arena.floor);
    for (let i = 0; i < nf.length; i += 3) assert.ok(nf[i + 2] > 0.999, 'floor normals point up');
    const nc = computeNormals(arena.ceiling);
    for (let i = 0; i < nc.length; i += 3) assert.ok(nc[i + 2] < -0.999, 'ceiling normals point down');
  });

  test(`[${name}] uvs and uint32 view`, () => {
    assert.ok(arena.uvs, 'uvs present');
    assert.equal(arena.uvs.shell.length, (arena.shell.vertices.length / 3) * 2);
    assert.equal(arena.uvs.goals.length, (arena.goals.vertices.length / 3) * 2);
    const u32 = indicesAsUint32(arena.physics);
    assert.equal(u32.length, arena.physics.indices.length);
    assert.equal(u32[7], arena.physics.indices[7]);
  });
}

test('build is deterministic', () => {
  const a = buildArenaMesh();
  const b = buildArenaMesh();
  assert.deepEqual(Array.from(a.physics.indices), Array.from(b.physics.indices));
  assert.deepEqual(Array.from(a.physics.vertices), Array.from(b.physics.vertices));
});

test('the goal edges are rounded: posts, crossbar, the ramp round the posts, the chamber edges', () => {
  const P = GOAL_PROFILE.postRadius;
  const R = GOAL_PROFILE.edgeRadius;
  for (const sy of [-1, 1]) {
    // Where the old square post and crossbar edges were, there is air now; a little further in, the rounded solid.
    assert.ok(isInsideArena(GW + 5, sy * (L + 5), 400), 'the old post edge is air');
    assert.ok(!isInsideArena(GW + 100, sy * (L + 100), 400), 'inside the rounded post');
    assert.ok(isInsideArena(0, sy * (L + 20), GH + 20), 'the old crossbar edge is air');
    assert.ok(!isInsideArena(0, sy * (L + 100), GH + 100), 'inside the rounded crossbar');
    // The back-wall ramp wraps round the post into the netting's floor curve (no end cap).
    assert.ok(!isInsideArena(GW + P + 50, sy * (L - 20), 20), 'the back-wall ramp beside the post');
    assert.ok(!isInsideArena(GW - 20, sy * (L + 400), 20), "the netting's floor curve");
    assert.ok(isInsideArena(GW - R - 10, sy * (L + 400), 20), 'the chamber floor inside the curve');
    // Rounded chamber edges: the netting into the roof and the back corners.
    assert.ok(!isInsideArena(GW - 20, sy * (L + 400), GH - 20), 'the netting-to-roof curve');
    assert.ok(!isInsideArena(GW - 30, sy * (L + GD - 30), 400), 'the rounded back corner');
    assert.ok(isInsideArena(GW - 30, sy * (L + 400), 400), 'against the side netting');
  }
  assert.ok(BALL.radius > 0);
});

test('isInsideArena agrees with the geometry', () => {
  assert.ok(isInsideArena(0, 0, 100), 'centre');
  assert.ok(isInsideArena(0, 0, BALL.restZ), 'ball at rest');
  assert.ok(!isInsideArena(0, 0, -10), 'below the floor');
  assert.ok(!isInsideArena(0, 0, H + 10), 'above the ceiling');
  assert.ok(!isInsideArena(W + 10, 0, 100), 'past the side wall');
  assert.ok(!isInsideArena(W - 10, 0, 5), 'inside the side ramp solid');
  assert.ok(isInsideArena(W - 10, 0, 400), 'against the side wall above the ramp');
  assert.ok(!isInsideArena(W - 10, 0, H - 10), 'inside the ceiling arc solid');
  assert.ok(!isInsideArena(CX + RC * 0.75, CY + RC * 0.75, 100), 'outside the rounded corner');
  assert.ok(isInsideArena(CX + RC * 0.6, CY + RC * 0.6, 100), 'inside near the corner wall');
  assert.ok(!isInsideArena(CX + (RC - 40) * Math.SQRT1_2, CY + (RC - 40) * Math.SQRT1_2, 5), 'inside the corner ramp solid');
  assert.ok(isInsideArena(0, L - 50, 100), 'in front of the goal mouth (no back ramp there)');
  assert.ok(!isInsideArena(2000, L - 50, 5), 'inside the back ramp solid');
  assert.ok(isInsideArena(0, L + 400, 300), 'inside the goal chamber');
  assert.ok(isInsideArena(0, -(L + 400), 300), 'inside the blue goal chamber');
  assert.ok(!isInsideArena(GW + 10, L + 400, 300), 'outside the goal width');
  assert.ok(!isInsideArena(0, L + 400, GH + 10), 'above the goal roof');
  assert.ok(!isInsideArena(0, L + 200, GH + 5), 'above the roof behind the crossbar');
  assert.ok(isInsideArena(0, L + GD - 50, 400), 'against the back of the net');
  assert.ok(!isInsideArena(0, L + GD - 30, GH - 30), 'inside the rounded top-back edge solid');
  assert.ok(!isInsideArena(0, L + GD - 20, 20), 'inside the rounded bottom-back edge solid');
  assert.ok(!isInsideArena(0, L + GD + 10, 100), 'behind the net');
});

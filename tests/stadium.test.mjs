// The stadium's layout and geometry (node --test tests/stadium.test.mjs): everything stands on the
// shell or outside the playable volume, the towers are the theme's floodlights, the board band is
// low, the shell split keeps every triangle and its surface coordinates are continuous, and a
// theme writes every uniform. Node strips the types of .ts files; extensionless src imports are
// mapped to the .ts file by the resolve hook below.
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

const THREE = await import('three/webgpu');
const { buildArenaMesh, isInsideArena } = await import('../src/sim/arenaMesh.ts');
const { ARENA } = await import('../src/sim/constants.ts');
const { themeWorld, DEFAULT_THEME, TOWER_X, TOWER_Z, HEAD_Y } = await import('../src/render/theme.ts');
const { TIERS } = await import('../src/render/quality.ts');
const L = await import('../src/render/stadium/layout.ts');
const { splitShell } = await import('../src/render/stadium/geometry.ts');
const { buildSteelGeometry } = await import('../src/render/stadium/steel.ts');
const { buildStandGeometry, APRON_X, APRON_Y, APRON_Z } = await import('../src/render/stadium/stands.ts');
const { createStadiumUniforms, applyStadiumTheme, stadiumTheme } = await import('../src/render/stadium/palette.ts');

/** three.js world point -> isInsideArena (sim coords: x, y = three z, z = three y). */
const inside = (x, y, z) => isInsideArena(x, z, y);

/** Sim mesh -> indexed three geometry with vertex normals (the axis swap of Arena.ts toGeometry). */
function toGeometry(md) {
  const n = md.vertices.length / 3;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = md.vertices[i * 3];
    pos[i * 3 + 1] = md.vertices[i * 3 + 2];
    pos[i * 3 + 2] = md.vertices[i * 3 + 1];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(md.indices), 1));
  g.computeVertexNormals();
  return g;
}

function area(g) {
  const p = g.getAttribute('position');
  const idx = g.getIndex();
  const n = idx ? idx.count : p.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let s = 0;
  for (let t = 0; t < n; t += 3) {
    const i = idx ? idx.getX(t) : t;
    const j = idx ? idx.getX(t + 1) : t + 1;
    const k = idx ? idx.getX(t + 2) : t + 2;
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, j).sub(a);
    c.fromBufferAttribute(p, k).sub(a);
    s += b.cross(c).length() / 2;
  }
  return s;
}

test('the tower heads are the theme floodlights, in order, at TOWER_X / TOWER_Z / HEAD_Y', () => {
  const heads = L.towerHeads();
  const lights = themeWorld(DEFAULT_THEME).floodlights;
  assert.equal(heads.length, lights.length);
  heads.forEach((h, i) => {
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(h.position[k] - lights[i].position[k]) < 1e-6, `head ${i} position`);
      assert.ok(Math.abs(h.target[k] - lights[i].target[k]) < 1e-6, `head ${i} target`);
    }
    assert.equal(Math.abs(h.base[0]), TOWER_X);
    assert.ok(TOWER_Z.includes(h.base[2]));
    assert.equal(h.position[1], HEAD_Y);
    // Orthonormal panel axes, dir toward the target.
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    assert.ok(Math.abs(dot(h.dir, h.right)) < 1e-9 && Math.abs(dot(h.dir, h.up)) < 1e-9 && Math.abs(dot(h.right, h.up)) < 1e-9);
    assert.ok(h.up[1] > 0, 'panels upright');
  });
});

test('the steel (cage, rings, beams, towers) never enters the playable volume', () => {
  for (const q of ['low', 'high']) {
    const { geometry } = buildSteelGeometry(TIERS[q]);
    const p = geometry.getAttribute('position');
    let bad = 0;
    for (let i = 0; i < p.count; i++) if (inside(p.getX(i), p.getY(i), p.getZ(i))) bad++;
    assert.equal(bad, 0, `${q}: ${bad} steel vertices inside the arena`);
    // The roof is flat: no steel between the ceiling and the floor away from the walls.
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      if (Math.abs(x) < 3000 && Math.abs(z) < 3500) assert.ok(y > ARENA.height, `steel over the field below the ceiling at ${x},${y},${z}`);
    }
    geometry.dispose();
  }
});

test('the stands, banners and lamp heads stand outside the playable volume', () => {
  const g = buildStandGeometry();
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) assert.ok(!inside(p.getX(i), p.getY(i), p.getZ(i)), 'stand vertex inside');
  // Above the floor only the stands themselves (the apron lies under the pitch level).
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) >= 0) assert.ok(Math.abs(p.getX(i)) >= L.STAND.x0 - 1e-3, 'stands start at STAND.x0');
    else assert.equal(p.getY(i), APRON_Y, 'only the apron below the floor');
  }
  // The apron covers the ground round the cage out to the stands' footprint (what a camera on a
  // wall sees through the netting) and never the field.
  const apron = [];
  for (let t = 0; t < p.count; t += 3) {
    if (p.getY(t) < 0) apron.push([0, 1, 2].map((k) => [p.getX(t + k), p.getZ(t + k)]));
  }
  const cross2 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inTri = (q, [a, b, c]) => {
    const d1 = cross2(a, b, q);
    const d2 = cross2(b, c, q);
    const d3 = cross2(c, a, q);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  // Signed distance outside the field outline (the rounded rectangle at the foot of the walls).
  const outside = (x, z) => {
    const ax = Math.abs(x);
    const az = Math.abs(z);
    if (ax > L.FIELD.cx && az > L.FIELD.cz) return Math.hypot(ax - L.FIELD.cx, az - L.FIELD.cz) - L.FIELD.cornerR;
    return Math.max(ax - L.FIELD.halfX, az - L.FIELD.halfZ);
  };
  let sampled = 0;
  for (let x = -APRON_X + 25; x < APRON_X; x += 97) {
    for (let z = -APRON_Z + 25; z < APRON_Z; z += 97) {
      const covered = apron.some((t) => inTri([x, z], t));
      // 12 uu margins round the outline: the corner arcs' chords run up to 4 uu inside it.
      if (outside(x, z) > 12) {
        sampled++;
        assert.ok(covered, `apron hole at ${x},${z}`);
      } else if (outside(x, z) < -12) assert.ok(!covered, `apron under the field at ${x},${z}`);
    }
  }
  assert.ok(sampled > 1000, `${sampled} samples round the cage`);
  // Every triangle's winding agrees with its normal (the DoubleSide material flips back faces).
  const n = g.getAttribute('normal');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < p.count; t += 3) {
    a.fromBufferAttribute(p, t);
    b.fromBufferAttribute(p, t + 1).sub(a);
    c.fromBufferAttribute(p, t + 2).sub(a);
    const w = b.cross(c);
    assert.ok(w.x * n.getX(t) + w.y * n.getY(t) + w.z * n.getZ(t) > 0, `stand triangle ${t / 3} wound against its normal`);
  }
  g.dispose();
  for (const corners of [false, true]) {
    const places = L.bannerPlaces(corners);
    assert.equal(places.length, corners ? 24 : 12);
    for (const b of places) {
      assert.ok(b.design >= 0 && b.design < L.BANNER_DESIGNS);
      // The cloth only moves outward; check its four corners at rest (the plane is BANNER_W wide).
      const sx = -b.nz;
      const sz = b.nx;
      for (const [u, v] of [[-0.5, 0], [0.5, 0], [-0.5, -1], [0.5, -1]]) {
        const x = b.x + sx * u * L.BANNER_W;
        const z = b.z + sz * u * L.BANNER_W;
        assert.ok(!inside(x, L.BANNER_TOP + v * L.BANNER_H, z), `banner corner inside at ${x},${z}`);
      }
    }
  }
  for (const h of L.towerHeads()) {
    assert.ok(!inside(...h.position), 'lamp head inside');
    assert.ok(h.position[1] - L.HEAD_H > ARENA.height, 'lamp panel above the roof');
  }
});

test('the LED board band stays low', () => {
  assert.ok(L.LED_HI <= 340 && L.RAIL_HI <= 350, 'boards under y ~ 350');
  assert.ok(L.BOARD_SPLIT_Y <= 360 && L.BOARD_SPLIT_Y > L.RAIL_HI);
  assert.ok(L.LED_LO < L.LED_HI && L.PANEL_LEN > 500);
  const t = stadiumTheme(DEFAULT_THEME);
  assert.ok(t.ledIntensity > 0.2 && t.ledIntensity <= 0.5, 'dim boards (ledIntensity ~0.4)');
});

test('profile distance: height on the wall, arc length on the ramp and the ceiling arc', () => {
  const top = L.FIELD.wallTop;
  assert.equal(L.profileDistance(1000, 0), 1000);
  assert.equal(L.profileDistance(top, 0), top);
  assert.ok(Math.abs(L.profileDistance(ARENA.height, -1) - (top + (ARENA.ceilingRadius * Math.PI) / 2)) < 1e-6);
  // On the side ramp (r = 320): continuous at the ramp top, arc length below it.
  const r = ARENA.sideRampRadius;
  for (const th of [0.3, 0.8, 1.2, 1.5]) {
    const y = r * (1 - Math.cos(th));
    const v = L.profileDistance(y, Math.cos(th));
    assert.ok(Math.abs(v - r * (1 - Math.PI / 2 + th)) < 1, `ramp at ${th}`);
  }
  assert.ok(Math.abs(L.profileDistance(r - 0.01, 0.0001) - r) < 1);
});

test('outline distance runs once round the outline, continuous except behind the red goal', () => {
  const pts = [];
  const segs = 4000;
  // Walk the outline the way a viewer inside sees it left to right... sample the rounded rectangle.
  const R = ARENA.cornerRadius;
  const cx = ARENA.cornerCentreX;
  const cz = ARENA.cornerCentreY;
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    // A parametric walk of the rounded rectangle by angle round the centre (dense enough).
    const a = t * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    // Intersect the ray from the centre with the outline.
    let lo = 0;
    let hi = 8000;
    for (let k = 0; k < 60; k++) {
      const m = (lo + hi) / 2;
      const x = dx * m;
      const z = dz * m;
      const ax = Math.abs(x);
      const az = Math.abs(z);
      const inOut = ax > cx && az > cz ? Math.hypot(ax - cx, az - cz) <= R : ax <= ARENA.extentX && az <= ARENA.extentY;
      if (inOut) lo = m;
      else hi = m;
    }
    pts.push([dx * lo, dz * lo]);
  }
  let jumps = 0;
  let total = 0;
  for (let i = 0; i < segs; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % segs];
    let d = L.outlineDistance(x1, z1) - L.outlineDistance(x0, z0);
    if (Math.abs(d) > L.OUTLINE_LENGTH / 2) {
      jumps++;
      assert.ok(z0 > 0 && Math.abs(x0) < 50, 'the seam is behind the red goal');
      d -= Math.sign(d) * L.OUTLINE_LENGTH;
    }
    // The outline distance changes like the true distance between neighbouring outline points.
    assert.ok(Math.abs(Math.abs(d) - Math.hypot(x1 - x0, z1 - z0)) < 0.5, `step at ${x0},${z0}`);
    total += d;
  }
  assert.equal(jumps, 1);
  assert.ok(Math.abs(Math.abs(total) - L.OUTLINE_LENGTH) < 1);
});

test('netting coordinate: true distances across every panel, at the foot and at the top of the wall arc', () => {
  const R = ARENA.cornerRadius;
  for (const inset of [0, 300, 600]) {
    const r = R - inset;
    // Corner (+x, +z), inside one panel: a step of da along the arc at radius r is r * da uu.
    for (const deg of [5, 20, 40, 50, 70, 85]) {
      const a = (deg * Math.PI) / 180;
      const da = 0.002;
      const p0 = [ARENA.cornerCentreX + r * Math.cos(a), ARENA.cornerCentreY + r * Math.sin(a)];
      const p1 = [ARENA.cornerCentreX + r * Math.cos(a + da), ARENA.cornerCentreY + r * Math.sin(a + da)];
      const s0 = L.netAcross(p0[0], p0[1], p0[0], p0[1]);
      const s1 = L.netAcross(p1[0], p1[1], p0[0], p0[1]);
      assert.ok(Math.abs(Math.abs(s1 - s0) - r * da) < 1e-3, `corner ${deg} deg inset ${inset}`);
    }
    // A corner triangle's vertex on the arc's end (z = cz: a side point on its own) still takes
    // the corner coordinate: the triangle's centroid picks the part, not each vertex.
    const ref = [ARENA.cornerCentreX + r * Math.cos(0.06), ARENA.cornerCentreY + r * Math.sin(0.06)];
    const atEnd = L.netAcross(ARENA.cornerCentreX + r, ARENA.cornerCentreY, ref[0], ref[1]);
    const inside = L.netAcross(ref[0], ref[1], ref[0], ref[1]);
    assert.ok(Math.abs(Math.abs(inside - atEnd) - r * 0.06) < 1e-6, `corner end inset ${inset}`);
  }
  assert.equal(L.netAcross(ARENA.extentX, 1234, ARENA.extentX, 1234), 1234);
  assert.equal(L.netAcross(567, ARENA.extentY, 567, ARENA.extentY), 567);
});

test('the shell split keeps every triangle: boards below the cut (and the goal panels), netting above', () => {
  const mesh = buildArenaMesh();
  const shell = toGeometry(mesh.shell);
  const ceiling = toGeometry(mesh.ceiling);
  const total = area(shell) + area(ceiling);
  const { boards, net } = splitShell(shell, ceiling);
  assert.ok(Math.abs(area(boards) + area(net) - total) / total < 1e-4, 'area preserved');
  const bp = boards.getAttribute('position');
  for (let i = 0; i < bp.count; i++) {
    const y = bp.getY(i);
    const goalPanel = Math.abs(bp.getX(i)) <= L.FIELD.moduleHalfW + 1 && Math.abs(bp.getZ(i)) > ARENA.extentY - 31;
    assert.ok(y <= L.BOARD_SPLIT_Y + 1e-3 || goalPanel, `board vertex at y ${y}`);
  }
  const np = net.getAttribute('position');
  const nuv = net.getAttribute('uv');
  for (let i = 0; i < np.count; i++) {
    assert.ok(np.getY(i) >= L.BOARD_SPLIT_Y - 1e-3, 'net vertex below the cut');
    assert.ok(Number.isFinite(nuv.getX(i)) && Number.isFinite(nuv.getY(i)));
  }
  // Netting coordinates are true distances inside every triangle (the hex cells keep their size;
  // only the corners' wall arc shears them a little): no triangle mixes two coordinate systems,
  // so the coordinate jumps only between triangles, under the steel.
  for (let t = 0; t < np.count; t += 3) {
    for (let a = 0; a < 3; a++) {
      const i = t + a;
      const j = t + ((a + 1) % 3);
      const d3 = Math.hypot(np.getX(i) - np.getX(j), np.getY(i) - np.getY(j), np.getZ(i) - np.getZ(j));
      if (d3 < 1) continue;
      const d2 = Math.hypot(nuv.getX(i) - nuv.getX(j), nuv.getY(i) - nuv.getY(j));
      assert.ok(d2 / d3 > 0.75 && d2 / d3 < 1.3, `net triangle ${t / 3}: uv edge ${d2.toFixed(0)} for ${d3.toFixed(0)} uu`);
    }
  }
  // Board coordinates: finite, and no triangle's outline distance spans more than its own size
  // (x 1.6 for the corners' inset arcs): the seam behind the red goal is unwrapped.
  const buv = boards.getAttribute('uv');
  for (let t = 0; t < buv.count; t += 3) {
    const us = [buv.getX(t), buv.getX(t + 1), buv.getX(t + 2)];
    assert.ok(us.every(Number.isFinite));
    let size = 0;
    for (let a = 0; a < 3; a++) {
      for (let b = a + 1; b < 3; b++) size = Math.max(size, Math.hypot(bp.getX(t + a) - bp.getX(t + b), bp.getZ(t + a) - bp.getZ(t + b)));
    }
    assert.ok(Math.max(...us) - Math.min(...us) <= size * 1.6 + 1, 'board triangle spans the seam');
  }
  for (const g of [shell, ceiling, boards, net]) g.dispose();
});

test('a theme writes every stadium uniform; the heads take the floodlights strengths', () => {
  const u = createStadiumUniforms();
  const strengths = applyStadiumTheme(u, DEFAULT_THEME);
  const lights = themeWorld(DEFAULT_THEME).floodlights;
  assert.equal(strengths.length, L.towerHeads().length);
  strengths.forEach((s, i) => {
    assert.equal(s, lights[i].strength);
    assert.equal(u.head[i].value, s);
  });
  const t = stadiumTheme(DEFAULT_THEME);
  assert.equal(u.ledIntensity.value, t.ledIntensity);
  assert.equal(u.lampIntensity.value, t.lampIntensity);
  assert.deepEqual([u.crowdLight.value.x, u.crowdLight.value.y, u.crowdLight.value.z], [...t.crowdLight]);
  // Unknown or unbuilt themes fall back to the default look.
  assert.equal(stadiumTheme('no-such-theme'), stadiumTheme(DEFAULT_THEME));
  // Timber stands are optional: absent = concrete (0); the alpine valley builds them of wood.
  assert.equal(u.standWood.value, 0);
  applyStadiumTheme(u, 'alpine-day');
  assert.equal(u.standWood.value, 1);
  assert.notEqual(stadiumTheme('alpine-day'), stadiumTheme(DEFAULT_THEME));
  // by day the floodlights are off and the boards brighter than at night
  assert.ok(u.head.every((h) => h.value === 0));
  assert.ok(stadiumTheme('alpine-day').ledIntensity > stadiumTheme(DEFAULT_THEME).ledIntensity);
  applyStadiumTheme(u, DEFAULT_THEME);
  assert.equal(u.standWood.value, 0);
});

test('each head drives its own lamp panel and glare (theme strengths per vertex), beams included', async () => {
  const { buildLampPanels, buildGlare, buildBeams } = await import('../src/render/stadium/floodlights.ts');
  const u = createStadiumUniforms();
  const heads = L.towerHeads();
  const strengths = heads.map((_, i) => (i % 3) / 2); // 0, 0.5, 1, 0, ...
  for (const h of [buildLampPanels(u), buildGlare(TIERS.low, u), buildGlare(TIERS.high, u), buildBeams(u)]) {
    h.setStrengths(strengths);
    const g = h.mesh.geometry;
    const s = g.getAttribute('aStrength');
    const p = g.getAttribute('position');
    assert.equal(s.count, p.count);
    // The parts are merged head by head in towerHeads order, the same number of vertices each:
    // every vertex of part k takes head k's strength, and part k sits at head k (panel and sprite
    // corners round its centre, the beam cone's apex on it).
    const per = p.count / heads.length;
    assert.ok(Number.isInteger(per));
    for (let i = 0; i < p.count; i++) {
      const k = Math.floor(i / per);
      assert.equal(s.getX(i), strengths[k], `${h.mesh.name} vertex ${i}`);
    }
    heads.forEach((H, k) => {
      let near = Infinity;
      for (let i = k * per; i < (k + 1) * per; i++) near = Math.min(near, Math.hypot(p.getX(i) - H.position[0], p.getY(i) - H.position[1], p.getZ(i) - H.position[2]));
      assert.ok(near < 400, `${h.mesh.name} part ${k} is not at head ${k}`);
    });
    assert.ok(h.mesh.material.mrtNode !== null, `${h.mesh.name}: glow tagged`);
    g.dispose();
    h.mesh.material.dispose();
  }
});

test('the crowd: crowdDensity sets people per quad, the same crowd on every tier', async () => {
  const { buildCrowd } = await import('../src/render/stadium/stands.ts');
  const u = createStadiumUniforms();
  const low = buildCrowd(TIERS.low, u);
  const high = buildCrowd(TIERS.high, u);
  assert.ok(high.people > 8000, `${high.people} people on high`);
  assert.ok(Math.abs(low.people - high.people) / high.people < 0.05, `low ${low.people} vs high ${high.people}`);
  assert.ok(low.mesh.count < high.mesh.count * 0.55, 'fewer instances on low');
  // Every seat block stands in a stand (outside the field, on its row) and never in an aisle.
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const period = L.STAND.aisleEvery * L.STAND.seatW + L.STAND.aisleW;
  for (const c of [low, high]) {
    for (let i = 0; i < c.mesh.count; i++) {
      c.mesh.getMatrixAt(i, m);
      v.setFromMatrixPosition(m);
      assert.ok(Math.abs(v.x) >= L.STAND.x0 && !inside(v.x, v.y, v.z), 'seat outside the stands');
      assert.ok(((v.z + L.STAND.halfLen) % period) >= L.STAND.aisleW, `seat block in an aisle at z ${v.z}`);
    }
    c.mesh.geometry.dispose();
    c.mesh.material.dispose();
  }
});

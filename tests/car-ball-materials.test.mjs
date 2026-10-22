// Car and ball material data (node --test tests/car-ball-materials.test.mjs): the match ball's
// panel layout (a truncated icosahedron: the shader's 32 face normals and the pentagon weight),
// its colourway contract, and the car's surface kinds and team paint. The materials themselves
// are TSL node graphs that only a GPU can run; these tests pin the numbers they are built from.
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

const { ballPanelCentres, ballFoldedPanels, BALL_PENT_WEIGHT, BALL_COLORS } = await import('../src/render/Ball.ts');
const { CAR_KIND, TEAM_PAINT, TEAM_GLOW, acquireCarMaterial, releaseCarMaterial } = await import('../src/render/Car.ts');
const { BRAND_LIME } = await import('../src/render/materials.ts');
const { tier } = await import('../src/render/quality.ts');

const PHI = (1 + Math.sqrt(5)) / 2;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The 60 vertices of the truncated icosahedron: every icosahedron edge cut at a third. */
function truncatedIcosahedron() {
  const ico = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) ico.push([0, a, b * PHI], [a, b * PHI, 0], [b * PHI, 0, a]);
  const verts = [];
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 12; j++) {
      if (i === j) continue;
      const d = Math.hypot(ico[i][0] - ico[j][0], ico[i][1] - ico[j][1], ico[i][2] - ico[j][2]);
      if (Math.abs(d - 2) < 1e-9) verts.push(ico[i].map((x, k) => x + (ico[j][k] - x) / 3));
    }
  }
  return verts;
}

/** The shader's panel scores for a direction: [score, isPent] for all 32 faces, best first. */
function scores(n) {
  const { pent, hex } = ballPanelCentres();
  const s = [...pent.map((c) => [dot(n, c) * BALL_PENT_WEIGHT, 1]), ...hex.map((c) => [dot(n, c), 0])];
  return s.sort((a, b) => b[0] - a[0]);
}

const lum = (hex) => {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const r = lin(((hex >> 16) & 255) / 255);
  const g = lin(((hex >> 8) & 255) / 255);
  const b = lin((hex & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test('ball: 12 pentagon and 20 hexagon unit face normals', () => {
  const { pent, hex } = ballPanelCentres();
  assert.equal(pent.length, 12);
  assert.equal(hex.length, 20);
  for (const c of [...pent, ...hex]) assert.ok(Math.abs(Math.hypot(...c) - 1) < 1e-12);
});

test('ball: every face normal is a real face of the truncated icosahedron', () => {
  // A face's plane holds exactly its 5 (pentagon) or 6 (hexagon) vertices: the wrong chirality
  // of the (0, phi, 1/phi) hexagons (the visual prototype's bug) touches only one vertex each.
  const verts = truncatedIcosahedron();
  assert.equal(verts.length, 60);
  const { pent, hex } = ballPanelCentres();
  for (const [faces, count] of [[pent, 5], [hex, 6]]) {
    for (const c of faces) {
      const top = Math.max(...verts.map((v) => dot(v, c)));
      assert.equal(verts.filter((v) => Math.abs(dot(v, c) - top) < 1e-9).length, count);
    }
  }
});

test('ball: the pentagon weight is the hexagon / pentagon plane distance ratio', () => {
  const verts = truncatedIcosahedron();
  const { pent, hex } = ballPanelCentres();
  const hp = Math.max(...verts.map((v) => dot(v, pent[0])));
  const hh = Math.max(...verts.map((v) => dot(v, hex[0])));
  assert.ok(Math.abs(BALL_PENT_WEIGHT - hh / hp) < 1e-6, `${BALL_PENT_WEIGHT} vs ${hh / hp}`);
});

test('ball: seams fall on the polyhedron edges (1 pentagon + 2 hexagons tie at each vertex)', () => {
  for (const v of truncatedIcosahedron()) {
    const l = Math.hypot(...v);
    const s = scores(v.map((x) => x / l));
    assert.ok(s[0][0] - s[2][0] < 1e-6, 'three faces tie at a vertex');
    assert.ok(s[2][0] - s[3][0] > 1e-3, 'and only three');
    assert.equal(s[0][1] + s[1][1] + s[2][1], 1, 'one pentagon, two hexagons');
  }
  // Every face centre belongs to its own face.
  const { pent, hex } = ballPanelCentres();
  for (const c of pent) assert.equal(scores(c)[0][1], 1);
  for (const c of hex) assert.equal(scores(c)[0][1], 0);
});

test('ball: the folded 10-face search finds the same face and runner-up as the full 32-face one', () => {
  const folded = ballFoldedPanels();
  assert.equal(folded.length, 10);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  let nearSeams = 0;
  for (let i = 0; i < 20000; i++) {
    const z = rnd() * 2 - 1;
    const t = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - z * z);
    const n = [r * Math.cos(t), r * Math.sin(t), z];
    const f = n.map(Math.abs);
    const full = scores(n);
    const fold = folded.map(({ c, pent }) => [dot(f, c) * (pent ? BALL_PENT_WEIGHT : 1), pent ? 1 : 0]).sort((a, b) => b[0] - a[0]);
    assert.ok(Math.abs(full[0][0] - fold[0][0]) < 1e-9, 'same best score');
    assert.equal(full[0][1], fold[0][1], 'same panel type');
    // Near a seam (where groove, stitches and pillow live) the runner-up must match too.
    if (full[0][0] - full[1][0] < 0.2) {
      nearSeams++;
      assert.ok(Math.abs(full[1][0] - fold[1][0]) < 1e-9, 'same runner-up near a seam');
    }
  }
  assert.ok(nearSeams > 5000, `sampled ${nearSeams} near-seam directions`);
});

test('ball: colourway keeps the brand lime and a pentagon contrast that shows the spin', () => {
  assert.equal(BALL_COLORS.glow, BRAND_LIME);
  assert.ok(lum(BALL_COLORS.hexagon) / lum(BALL_COLORS.pentagon) > 6, 'pearl hexagons vs graphite pentagons');
  assert.ok(lum(BALL_COLORS.seam) < lum(BALL_COLORS.pentagon), 'seams darker than every panel');
});

test('car: surface kinds are distinct small integers (the shader decodes them with isKind)', () => {
  const ids = Object.values(CAR_KIND);
  assert.equal(new Set(ids).size, ids.length);
  for (const k of ids) assert.ok(Number.isInteger(k) && k >= 0 && k < 32);
});

test('car: team paint unchanged, the blue clearly lighter than the red (colour-blind separation)', () => {
  assert.deepEqual([...TEAM_PAINT], [0x2a86f0, 0xc8152f]);
  assert.deepEqual([...TEAM_GLOW], [0x56b0ff, 0xff3d55]);
  assert.ok(lum(TEAM_PAINT[0]) / lum(TEAM_PAINT[1]) > 1.6, 'blue paint lighter than red');
});

test('car: one shared material per tier variant (high and ultra share it), disposed with its last view', () => {
  const high = acquireCarMaterial(tier('high'));
  const ultra = acquireCarMaterial(tier('ultra'));
  const low = acquireCarMaterial(tier('low'));
  assert.equal(ultra.key, high.key, 'ultra reads the same switches as high');
  assert.equal(ultra.material, high.material);
  assert.notEqual(low.key, high.key, 'low builds the flat variant');
  assert.notEqual(low.material, high.material);
  let disposed = 0;
  high.material.addEventListener('dispose', () => disposed++);
  releaseCarMaterial(high.key);
  assert.equal(disposed, 0, 'still held by the ultra view');
  releaseCarMaterial(ultra.key);
  assert.equal(disposed, 1, 'the last release disposes it');
  releaseCarMaterial(ultra.key); // a stray release of a freed key is a no-op
  assert.equal(disposed, 1);
  const again = acquireCarMaterial(tier('high'));
  assert.notEqual(again.material, high.material, 'a disposed material is never handed out again');
  releaseCarMaterial(again.key);
  releaseCarMaterial(low.key);
});

test('car: super low shares one Lambert material (no clearcoat, no environment)', () => {
  const sl = acquireCarMaterial(tier('superlow'));
  const low = acquireCarMaterial(tier('low'));
  assert.notEqual(sl.key, low.key);
  assert.equal(sl.material.type, 'MeshLambertNodeMaterial');
  assert.equal(low.material.type, 'MeshPhysicalNodeMaterial', 'low keeps the physical model');
  const again = acquireCarMaterial(tier('superlow'));
  assert.equal(again.material, sl.material, 'every car of the tier shares it');
  releaseCarMaterial(again.key);
  releaseCarMaterial(sl.key);
  releaseCarMaterial(low.key);
});

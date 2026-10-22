// Car bodies (node --test tests/car-bodies.test.mjs): the contract every body of src/render/cars
// keeps so it costs no draw call, pipeline or compile (docs/cars.md), the wheel styles, the livery
// packing, the shared geometry cache and CarView's in-place body swap. The dune runner's geometry
// is pinned byte for byte to what it was before the body kit existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const kit = await import('../src/render/cars/kit.ts');
const { KNOBBY, SLICK, WHEEL_STYLES, SLICK_R, buildWheel, tyreRadius } = await import('../src/render/cars/wheels.ts');
const { DEFAULT_BODY, carBodies, carBody, hasCarBody, registerCarBody } = await import('../src/render/cars/index.ts');
const { DUNE } = await import('../src/render/cars/dune.ts');
const cache = await import('../src/render/cars/cache.ts');
const { CarView, packLivery } = await import('../src/render/Car.ts');
const { CAR_STANDARD } = await import('../src/sim/constants.ts');

const { CAR_KIND, BOOST_NOZZLE_X, BOOST_NOZZLE_Y, BOOST_NOZZLE_Z, HITBOX_MARGIN, BODY_TRIS_CAP, BODY_TRIS_TARGET, WHEEL_TRIS_CAP, CROWN_R, RIM_R, WHEEL_WIDTH } = kit;

// The Standard preset as the wasm reports it (rs_get_car_config: float32 values; fround of the
// constants is exactly what RocketSim.getCarConfig(CarPreset.Standard) returns).
const f = Math.fround;
const CFG = {
  hitboxSize: CAR_STANDARD.hitboxSize.map(f),
  hitboxOffset: CAR_STANDARD.hitboxOffset.map(f),
  frontWheelRadius: f(CAR_STANDARD.frontWheelRadius),
  backWheelRadius: f(CAR_STANDARD.backWheelRadius),
  frontSuspensionRest: f(38.755),
  backSuspensionRest: f(37.055),
  frontWheelOffset: CAR_STANDARD.frontWheelOffset.map(f),
  backWheelOffset: CAR_STANDARD.backWheelOffset.map(f),
  dodgeDeadzone: 0.5,
};
const DETAILS = ['low', 'high'];
const TEAMS = [0, 1];
const KINDS = new Set(Object.values(CAR_KIND));
// The shipped bodies, before any test registers a stand-in.
const SHIPPED = carBodies();

/**
 * SHA-256 of the dune runner's geometry: every attribute's name, item size, normalized flag and
 * array type, then its bytes, in attribute order, then whether it is indexed. Computed from
 * origin/main ab8d97d's Car.ts buildBodyGeometry(cfg, team, detail) and
 * buildWheelGeometry(18, detail, team), before the body kit existed: the kit must build exactly
 * the same arrays in the same order (same draw, same look, same memory).
 */
const DUNE_PINS = {
  'body|0|high': 'ee5815984eb4d50db9eb9a057345ea07da3fd49da5a7e727bef7236793ab2d95',
  'body|0|low': '6320f19cafe528e21c6fa9313862b201a1d218740ff8d4c12b669a2637eb03c5',
  'body|1|high': '0ba65565017a3be8a4b6330101a1d8e6c2b2271f975f8d620ff340c2d12807e8',
  'body|1|low': '685606d93544a7bf38ed27067605e6dd8536b38744fb40725843fcf4cec54e0a',
  'wheel|0|high': 'e075b41e32c537d2808936cef991333a1dbea822ff0b766668b6176aa67ce23a',
  'wheel|0|low': 'e8735ab428f22b6a457b05490b0863f224c15fd88f934b4fd011653d4faa8e3e',
  'wheel|1|high': '558570a503fc4ccfbdba4823e460373ce8930d8f8e3f70ab521687d1245ec06e',
  'wheel|1|low': '05f73285eb2367484af8e0afd97de3c4eddaf994179570a8d02ec4c2eb080984',
};

function digest(g) {
  const h = createHash('sha256');
  for (const [name, a] of Object.entries(g.attributes)) {
    h.update(`${name}:${a.itemSize}:${a.normalized}:${a.array.constructor.name};`);
    h.update(new Uint8Array(a.array.buffer, a.array.byteOffset, a.array.byteLength));
  }
  h.update(g.index === null ? 'noindex' : 'index');
  return h.digest('hex');
}

/** The vertex layout three keys pipelines on: exactly these attributes, float32, not normalized, no index. */
function assertLayout(g, label) {
  assert.deepEqual(Object.keys(g.attributes).sort(), ['aMat', 'color', 'normal', 'position'], `${label}: attribute set`);
  for (const [name, size] of [['position', 3], ['normal', 3], ['color', 3], ['aMat', 4]]) {
    const a = g.getAttribute(name);
    assert.equal(a.itemSize, size, `${label}: ${name} item size`);
    assert.equal(a.normalized, false, `${label}: ${name} normalized`);
    assert.ok(a.array instanceof Float32Array, `${label}: ${name} float32`);
  }
  assert.equal(g.index, null, `${label}: non-indexed`);
  assert.equal(g.attributes.position.count % 3, 0, `${label}: whole triangles`);
}

/** Finite positions / colours / surfaces, unit normals, every surface kind a CAR_KIND. */
function assertClean(g, label) {
  const p = g.attributes.position.array;
  const n = g.attributes.normal.array;
  const c = g.attributes.color.array;
  const m = g.attributes.aMat.array;
  for (let i = 0; i < p.length; i++) assert.ok(Number.isFinite(p[i]), `${label}: position ${i} finite`);
  for (let i = 0; i < c.length; i++) assert.ok(Number.isFinite(c[i]) && c[i] >= 0, `${label}: colour ${i}`);
  for (let i = 0; i < n.length; i += 3) {
    const l2 = n[i] * n[i] + n[i + 1] * n[i + 1] + n[i + 2] * n[i + 2];
    assert.ok(l2 > 0.98 && l2 < 1.02, `${label}: unit normal at vertex ${i / 3} (|n|^2 ${l2})`);
  }
  for (let i = 0; i < m.length; i += 4) {
    assert.ok(Number.isFinite(m[i]) && Number.isFinite(m[i + 1]) && Number.isFinite(m[i + 2]), `${label}: surface ${i / 4} finite`);
    assert.ok(KINDS.has(m[i + 3]), `${label}: kind ${m[i + 3]} at vertex ${i / 4} is a CAR_KIND`);
  }
}

/** Vertices of surface `kind`: [x, y, z][] (car-local for bodies, unit-wheel space for wheels). */
function verticesOf(g, kind) {
  const p = g.attributes.position.array;
  const m = g.attributes.aMat.array;
  const out = [];
  for (let v = 0; v < p.length / 3; v++) if (m[v * 4 + 3] === kind) out.push([p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]);
  return out;
}

test('dune: body and wheel geometry byte-identical to the original dune runner (every team and detail)', () => {
  for (const team of TEAMS) {
    for (const detail of DETAILS) {
      assert.equal(digest(kit.buildBody(DUNE, CFG, team, detail)), DUNE_PINS[`body|${team}|${detail}`], `body team ${team} ${detail}`);
      assert.equal(digest(buildWheel(DUNE.wheels.style, detail, team)), DUNE_PINS[`wheel|${team}|${detail}`], `wheel team ${team} ${detail}`);
    }
  }
});

test('registry: dune is the default body, every shipped body has a unique id, unknown ids draw the default', () => {
  assert.equal(DEFAULT_BODY, DUNE);
  assert.equal(SHIPPED[0], DUNE);
  assert.equal(new Set(SHIPPED.map((b) => b.id)).size, SHIPPED.length);
  assert.equal(carBody('dune'), DUNE);
  assert.equal(carBody('no-such-car'), DEFAULT_BODY);
  assert.equal(hasCarBody('no-such-car'), false);
  assert.throws(() => registerCarBody({ ...DUNE }), /already registered/);
});

for (const spec of SHIPPED) {
  for (const detail of DETAILS) {
    test(`body ${spec.id} (${detail}): layout, clean attributes, inside the hitbox unsqueezed, within budget, thrusters at the nozzles`, () => {
      assert.ok(spec.budget[detail] <= BODY_TRIS_CAP[detail], `declared budget ${spec.budget[detail]} within the hard cap ${BODY_TRIS_CAP[detail]}`);
      for (const team of TEAMS) {
        const label = `${spec.id} team ${team} ${detail}`;
        const g = kit.buildBody(spec, CFG, team, detail);
        assertLayout(g, label);
        assertClean(g, label);
        const tris = g.attributes.position.count / 3;
        assert.ok(tris <= spec.budget[detail], `${label}: ${tris} triangles within its budget ${spec.budget[detail]} (target ${BODY_TRIS_TARGET[detail]})`);
        // Inside the hitbox minus the margin with no squeeze (the guard would distort the design).
        assert.equal(g.userData.squeeze, undefined, `${label}: needed the containment squeeze`);
        g.computeBoundingBox();
        const bb = g.boundingBox;
        const [L, W, H] = CFG.hitboxSize;
        const [ox, oz, oy] = CFG.hitboxOffset; // sim (x, y, z) -> three (x, z, y)
        const eps = 1e-3;
        assert.ok(bb.min.x >= ox - L / 2 + HITBOX_MARGIN - eps && bb.max.x <= ox + L / 2 - HITBOX_MARGIN + eps, `${label}: x ${bb.min.x}..${bb.max.x}`);
        assert.ok(bb.min.y >= oy - H / 2 + HITBOX_MARGIN - eps && bb.max.y <= oy + H / 2 - HITBOX_MARGIN + eps, `${label}: y ${bb.min.y}..${bb.max.y}`);
        assert.ok(bb.min.z >= oz - W / 2 + HITBOX_MARGIN - eps && bb.max.z <= oz + W / 2 - HITBOX_MARGIN + eps, `${label}: z ${bb.min.z}..${bb.max.z}`);
        // Twin thrusters (EXHAUST housings) centred on the boost nozzles, their exit plane where the
        // flame starts (CarView puts it 0.2 uu behind the exit; Effects emits at BOOST_NOZZLE_*).
        for (const side of [-1, 1]) {
          const ex = verticesOf(g, CAR_KIND.EXHAUST).filter((v) => Math.sign(v[2]) === side);
          assert.ok(ex.length > 0, `${label}: an exhaust on side ${side}`);
          const mean = (i) => ex.reduce((s, v) => s + v[i], 0) / ex.length;
          assert.ok(Math.abs(mean(1) - BOOST_NOZZLE_Y) < 0.5, `${label}: exhaust y ${mean(1)}`);
          assert.ok(Math.abs(mean(2) - side * BOOST_NOZZLE_Z) < 0.5, `${label}: exhaust z ${mean(2)}`);
          const exit = Math.min(...ex.map((v) => v[0]));
          assert.ok(Math.abs(exit - BOOST_NOZZLE_X) < 0.5, `${label}: exhaust exit plane x ${exit}`);
        }
      }
    });
  }

  test(`body ${spec.id}: livery and wheel placement are sane`, () => {
    const l = spec.livery;
    assert.ok(l.pinstripe >= 0);
    if (l.chevrons !== null) assert.ok(l.chevrons.x0 < l.chevrons.x1 && l.chevrons.period > 0 && l.chevrons.halfWidth > 0);
    if (l.seams !== null) assert.ok(l.seams.maxZ > 0);
    assert.ok(l.grime.y1 < l.grime.y0 && l.grime.amount >= 0 && l.grime.amount <= 1, 'grime: dirty below y1 < clean above y0');
    assert.ok(l.ao.y0 < l.ao.y1, 'ao: y0 < y1');
    assert.ok(l.heat.length > 0 && Math.abs(l.heat.x - BOOST_NOZZLE_X) < 1, 'heat tint from the nozzle exit plane');
    assert.ok(spec.wheels.visual > 0.8 && spec.wheels.visual < 1.3);
    assert.ok(spec.wheels.outer > WHEEL_WIDTH && spec.wheels.outer <= CFG.hitboxSize[1] / 2);
    assert.ok(WHEEL_STYLES.includes(spec.wheels.style), 'a listed wheel style (one id, one geometry)');
  });
}

for (const style of WHEEL_STYLES) {
  for (const detail of DETAILS) {
    test(`wheel ${style.id} (${detail}): layout, within budget, the tyre the shader expects`, () => {
      const g = buildWheel(style, detail, 0);
      assertLayout(g, style.id);
      assertClean(g, style.id);
      const tris = g.attributes.position.count / 3;
      assert.ok(tris <= WHEEL_TRIS_CAP[detail], `${tris} triangles within ${WHEEL_TRIS_CAP[detail]}`);
      const radius = (v) => Math.hypot(v[0], v[1]);
      const all = [];
      for (const k of KINDS) all.push(...verticesOf(g, k));
      // Unit radius (a knob's flat top reaches its corners at hypot(1, KNOB_WIDTH / 2)).
      assert.ok(Math.max(...all.map(radius)) <= Math.hypot(1, kit.KNOB_WIDTH / 2) + 1e-6, 'unit radius');
      assert.ok(Math.max(...all.map((v) => Math.abs(v[2]))) <= WHEEL_WIDTH / 2 + 1, 'within the tyre width (the hub cap stands 0.8 proud)');
      const tyre = verticesOf(g, CAR_KIND.TYRE);
      assert.ok(Math.min(...tyre.map(radius)) >= RIM_R - 1e-6, 'rubber from the rim out');
      const top = Math.max(...tyre.map(radius));
      if (style.tyre === 'knobby') assert.ok(top > CROWN_R, 'knob tops on the shader crown');
      else assert.ok(top < CROWN_R && Math.abs(top - SLICK_R) < 1e-6, `slick tread ${top} below the crown (no sipes)`);
      assert.equal(tyreRadius(style), style.tyre === 'knobby' ? 1 : SLICK_R);
    });
  }
}

test('wheel styles: one geometry per id, the dune keeps the knobby', () => {
  assert.equal(new Set(WHEEL_STYLES.map((s) => s.id)).size, WHEEL_STYLES.length);
  assert.equal(DUNE.wheels.style, KNOBBY);
  assert.notEqual(digest(buildWheel(SLICK, 'high', 0)), digest(buildWheel(KNOBBY, 'high', 0)));
});

test('livery: the dune packs to the numbers the shader had compiled in; features switch off', () => {
  const p = packLivery(DUNE.livery).map((v) => v.toArray());
  assert.deepEqual(p, [
    [8.75, 0.45, 29, -31],
    [38, 68, 12, 11],
    [18.5, 10, 3, 0.55],
    [2, 14, BOOST_NOZZLE_X, 7],
  ]);
  const off = packLivery({ ...DUNE.livery, twoToneY: null, pinstripe: 0, chevrons: null, seams: null }).map((v) => v.toArray());
  assert.ok(off[0][0] < -1000, 'no two-tone line: paint all over');
  assert.equal(off[0][1], 0, 'no pinstripe');
  assert.ok(off[1][0] > off[1][1], 'no chevrons: empty x range');
  assert.ok(off[1][3] > 0, 'never a division by zero');
  assert.ok(off[2][0] < 0, 'no seams: negative |z| limit');
});

test('geometry cache: same (body, team, detail) shares one geometry, the last release disposes it', () => {
  const a = cache.acquireBodyGeometry(DUNE, CFG, 0, 'low');
  const b = cache.acquireBodyGeometry(DUNE, CFG, 0, 'low');
  const red = cache.acquireBodyGeometry(DUNE, CFG, 1, 'low');
  const hi = cache.acquireBodyGeometry(DUNE, CFG, 0, 'high');
  assert.equal(a.geometry, b.geometry);
  assert.equal(a.key, b.key);
  assert.notEqual(red.geometry, a.geometry, 'team paint is baked: one geometry per team');
  assert.notEqual(hi.geometry, a.geometry);
  let disposed = 0;
  a.geometry.addEventListener('dispose', () => disposed++);
  cache.releaseBodyGeometry(a.key);
  assert.equal(disposed, 0, 'still held');
  cache.releaseBodyGeometry(b.key);
  assert.equal(disposed, 1, 'the last release disposes it');
  cache.releaseBodyGeometry(b.key); // a stray release is a no-op
  assert.notEqual(cache.acquireBodyGeometry(DUNE, CFG, 0, 'low').geometry, a.geometry, 'a disposed geometry is never handed out again');
  cache.releaseBodyGeometry(a.key);
  cache.releaseBodyGeometry(red.key);
  cache.releaseBodyGeometry(hi.key);
  const w1 = cache.acquireWheelGeometry(KNOBBY, 0, 'high');
  const w2 = cache.acquireWheelGeometry(KNOBBY, 0, 'high');
  assert.equal(w1.geometry, w2.geometry);
  assert.notEqual(cache.acquireWheelGeometry(KNOBBY, 1, 'high').geometry, w1.geometry, 'the hub is team paint');
  cache.releaseWheelGeometry(w1.key);
  cache.releaseWheelGeometry(w2.key);
  cache.releaseWheelGeometry(`${KNOBBY.id}|1|high`);
  assert.deepEqual(cache.geometryCacheStats(), { bodies: 0, wheels: 0, refs: 0 });
});

test('CarView: cars of the same body, team and detail share geometry; setBody swaps it in place on the same meshes and material', () => {
  // A stand-in second body (never drawn, so it skips the contract: no thrusters, one loft).
  const WEDGE = {
    id: 'test-wedge',
    build(k) {
      k.push(kit.loft([kit.section(-50, 14, -14, 2), kit.section(0, 18, -15, 4), kit.section(50, 10, -14, -6)], k.hi ? 12 : 8, 3), k.paint);
    },
    wheels: { style: SLICK, visual: 1.05, outer: 38 },
    livery: { ...DUNE.livery, chevrons: null },
    budget: { low: 2000, high: 3500 },
  };
  registerCarBody(WEDGE);
  const scene = new THREE.Scene();
  const a = new CarView(scene, CFG, 0, 'low');
  const b = new CarView(scene, CFG, 0, 'low', 'dune');
  const red = new CarView(scene, CFG, 1, 'low');
  assert.equal(a.bodyId, 'dune');
  assert.equal(a.body.geometry, b.body.geometry, 'one body geometry for both blue cars');
  assert.equal(a.wheels.geometry, b.wheels.geometry, 'one wheel geometry');
  assert.notEqual(red.body.geometry, a.body.geometry);
  assert.deepEqual(cache.geometryCacheStats(), { bodies: 2, wheels: 2, refs: 6 });

  const { body, wheels } = a;
  const material = body.material;
  const duneBody = body.geometry;
  assert.equal(a.setBody('test-wedge'), true);
  assert.equal(a.bodyId, 'test-wedge');
  assert.equal(a.body, body, 'same body mesh');
  assert.equal(a.wheels, wheels, 'same wheel InstancedMesh (a new one is a new program)');
  assert.equal(a.body.material, material, 'same shared material');
  assert.equal(a.wheels.material, material);
  assert.notEqual(a.body.geometry, duneBody);
  assert.equal(b.body.geometry, duneBody, 'the other car keeps the dune geometry alive');
  assert.ok(a.body.userData.carLivery[1].x > a.body.userData.carLivery[1].y, "the wedge's livery (no chevrons) travels with its mesh");
  assert.equal(a.setBody('test-wedge'), false, 'no-op when unchanged');
  assert.deepEqual(cache.geometryCacheStats(), { bodies: 3, wheels: 3, refs: 6 });

  // An id without a body draws the default one.
  assert.equal(a.setBody('pampero'), true);
  assert.equal(a.bodyId, 'dune');
  assert.equal(a.body.geometry, duneBody, 'back on the shared dune geometry');
  assert.deepEqual(cache.geometryCacheStats(), { bodies: 2, wheels: 2, refs: 6 }, 'the wedge geometry was released');

  for (const v of [a, b, red]) v.dispose();
  assert.deepEqual(cache.geometryCacheStats(), { bodies: 0, wheels: 0, refs: 0 });
});

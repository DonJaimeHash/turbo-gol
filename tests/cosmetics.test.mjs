// Cosmetic cars (node --test tests/cosmetics.test.mjs): the catalog (src/game/cosmetics.ts), its
// names in English and Spanish, the player's car pick (src/game/carSelection.ts: only a car the
// player is entitled to), the preview flags (#car, #showroom) and the rule that keeps the catalog
// out of the community nodes' bundle: adding a car must never need a node release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

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

const { CAR_IDS, CARS, CAR_PRICES, DEFAULT_CAR, carCosmetic, isCarId } = await import('../src/game/cosmetics.ts');
const { CAR_PICK_KEY, CarSelection, entitledCars, previewCarsAllowed } = await import('../src/game/carSelection.ts');
const { parseHashFlags, parseShowroom } = await import('../src/render/hashFlags.ts');
const { carBody, hasCarBody } = await import('../src/render/cars/index.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

const ROOT = resolve(import.meta.dirname, '..');

test('catalog: the default car and the four to come, in menu order, one price table', () => {
  assert.deepEqual(CAR_IDS, ['dune', 'pampero', 'carpincho', 'condor', 'tero']);
  assert.equal(DEFAULT_CAR, 'dune');
  assert.deepEqual(CARS.map((c) => c.id), CAR_IDS);
  for (const c of CARS) {
    assert.equal(c.nameKey, `car.${c.id}`);
    assert.equal(c.descKey, `car.${c.id}Desc`);
    assert.equal(c.price, CAR_PRICES[c.id]);
    assert.equal(carCosmetic(c.id), c);
  }
  assert.deepEqual(carCosmetic('dune'), { id: 'dune', nameKey: 'car.dune', descKey: 'car.duneDesc', price: 0, status: 'available' });
  for (const id of ['pampero', 'carpincho', 'condor', 'tero']) {
    assert.equal(carCosmetic(id).price, 1500, `${id} price`);
    assert.equal(carCosmetic(id).status, 'soon', `${id} waits for its body`);
  }
  for (const id of CAR_IDS) assert.ok(isCarId(id));
  for (const bad of ['', 'Dune', 'car-next-1', 'dune ', 0, null, undefined, {}]) assert.equal(isCarId(bad), false, String(bad));
});

test('catalog: an available car has a body; a car still to come draws the default body', () => {
  for (const c of CARS) {
    if (c.status === 'available') assert.ok(hasCarBody(c.id), `${c.id} has a body`);
    else assert.equal(carBody(c.id), carBody(DEFAULT_CAR), `${c.id} falls back to the default body`);
  }
});

test('every car has a name and a one-line description in English and Spanish', () => {
  const names = {
    dune: ['Dune', 'Dune'],
    pampero: ['Pampero', 'Pampero'],
    carpincho: ['Carpincho', 'Carpincho'],
    condor: ['Cóndor', 'Cóndor'],
    tero: ['Tero', 'Tero'],
  };
  assert.deepEqual(Object.keys(names), [...CAR_IDS]);
  for (const id of CAR_IDS) {
    assert.equal(en[`car.${id}`], names[id][0], `${id} (en)`);
    assert.equal(es[`car.${id}`], names[id][1], `${id} (es)`);
    for (const lang of [en, es]) {
      const desc = lang[`car.${id}Desc`];
      assert.ok(typeof desc === 'string' && desc.length > 10 && desc.length <= 64, `${id} description fits a menu line: ${desc}`);
    }
  }
});

/** A Storage stand-in. */
function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

test('car pick: only a car the player is entitled to (today the default car alone), kept under the brand prefix', () => {
  assert.equal(CAR_PICK_KEY, 'turbogol.car');
  assert.deepEqual(entitledCars(), ['dune']);
  const store = memoryStorage();
  const sel = new CarSelection({ storage: store });
  assert.equal(sel.current, 'dune');
  assert.equal(sel.select('pampero'), false, 'not owned: refused');
  assert.equal(sel.current, 'dune');
  assert.equal(store.map.has(CAR_PICK_KEY), false);
  assert.equal(sel.select('dune'), true);
  assert.equal(store.map.get(CAR_PICK_KEY), 'dune');
  // A saved pick the player is not entitled to (edited by hand, an expired grant) reads as the default.
  assert.equal(new CarSelection({ storage: memoryStorage({ [CAR_PICK_KEY]: 'tero' }) }).current, 'dune');
  assert.equal(new CarSelection({ storage: memoryStorage({ [CAR_PICK_KEY]: 'not-a-car' }) }).current, 'dune');
});

test('car pick: a wider entitlement (the inventory to come) keeps the pick while it lasts', () => {
  let owned = ['dune', 'tero'];
  const store = memoryStorage();
  const sel = new CarSelection({ storage: store, entitled: () => owned });
  assert.equal(sel.select('tero'), true);
  assert.equal(sel.current, 'tero');
  assert.equal(new CarSelection({ storage: store, entitled: () => owned }).current, 'tero', 'the next visit');
  owned = ['dune']; // signed out, or the grant revoked
  assert.equal(sel.current, 'dune');
  // No storage at all (private mode): the pick holds for the page.
  const bare = new CarSelection({ storage: null, entitled: () => ['dune', 'tero'] });
  assert.equal(bare.select('tero'), true);
  assert.equal(bare.current, 'tero');
  // Throwing storage (a sandboxed frame).
  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(new CarSelection({ storage: throwing }).current, 'dune');
  assert.equal(new CarSelection({ storage: throwing }).select('dune'), true);
});

test('preview flags: #car and #showroom parse anywhere, apply only on a dev server or a VITE_PREVIEW_CARS=1 build', () => {
  assert.equal(previewCarsAllowed(undefined), false, 'node (no import.meta.env)');
  assert.equal(previewCarsAllowed({ DEV: false }), false, 'a production build');
  assert.equal(previewCarsAllowed({ DEV: false, VITE_PREVIEW_CARS: '0' }), false);
  assert.equal(previewCarsAllowed({ DEV: true }), true, 'the dev server');
  assert.equal(previewCarsAllowed({ DEV: false, VITE_PREVIEW_CARS: '1' }), true, 'a preview build');
  assert.equal(parseHashFlags('').car, null);
  assert.equal(parseHashFlags('').showroom, null);
  assert.equal(parseHashFlags('#car=tero&diag').car, 'tero');
  assert.equal(parseHashFlags('#car=').car, null);
  assert.equal(parseHashFlags('#carousel').car, null, 'whole words only');
  assert.deepEqual(parseHashFlags('#showroom=35&high').showroom, { yawDeg: 35, pitchDeg: null });
  assert.deepEqual(parseHashFlags('#superlow&showroom=145,20').showroom, { yawDeg: 145, pitchDeg: 20 });
  assert.deepEqual(parseHashFlags('#showroom').showroom, { yawDeg: null, pitchDeg: null }, 'bare: the slow orbit');
  assert.deepEqual(parseShowroom(',80'), { yawDeg: null, pitchDeg: 80 });
  assert.deepEqual(parseShowroom('side,x'), { yawDeg: null, pitchDeg: null });
  assert.equal(parseShowroom(null), null);
});

// ---- the community nodes' bundle never imports the catalog ------------------------------------

/** The node program's entry points (nodes/scripts/build-node.mjs: node.mjs and launcher.mjs). */
const NODE_ENTRIES = ['nodes/node/main.ts', 'nodes/node/launcherMain.ts'];

/** A repo-relative path with forward slashes. */
const rel = (abs) => relative(ROOT, abs).split('\\').join('/');

/** The file a relative import resolves to (esbuild's rules for this repo: .ts beside .js / bare). */
function resolveImport(from, spec) {
  const base = resolve(dirname(from), spec);
  for (const c of [base, base.replace(/\.js$/, '.ts'), base + '.ts', join(base, 'index.ts'), base + '.mjs']) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  throw new Error(`${rel(from)}: cannot resolve '${spec}'`);
}

/**
 * Relative runtime imports of a TypeScript file: import / export ... from, bare imports and
 * dynamic import(). `import type` and `export type` are skipped (erased); anything else is kept,
 * so the closure is a superset of what esbuild bundles.
 */
function runtimeImports(file) {
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specs = [];
  for (const m of src.matchAll(/\bimport\s+(type\s+)?[\w$*{}\s,]+?\s+from\s+['"]([^'"]+)['"]/g)) if (!m[1]) specs.push(m[2]);
  for (const m of src.matchAll(/\bexport\s+(type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[\w$\s,]*\})\s+from\s+['"]([^'"]+)['"]/g)) if (!m[1]) specs.push(m[2]);
  for (const m of src.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs.filter((s) => s.startsWith('.')).map((s) => resolveImport(file, s));
}

function bundleClosure() {
  const seen = new Set();
  const todo = NODE_ENTRIES.map((p) => join(ROOT, p));
  while (todo.length > 0) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (/\.[cm]?tsx?$/.test(f)) todo.push(...runtimeImports(f));
  }
  return new Set([...seen].map(rel));
}

test('the community nodes bundle never imports the car catalog or the car pick', () => {
  const closure = bundleClosure();
  // The walk reaches the game code nodes run (node-release-gate.mjs's inputs), so it is a real one.
  for (const input of ['nodes/node/matchRoom.ts', 'nodes/shared/nodeArena.ts', 'server/src/roomHost.ts', 'src/net/protocol.ts', 'src/game/Match.ts', 'src/sim/RocketSimBridge.ts', 'src/ai/Bot.ts']) {
    assert.ok(closure.has(input), `the walk reaches ${input}`);
  }
  for (const file of ['src/game/cosmetics.ts', 'src/game/carSelection.ts']) {
    assert.equal(closure.has(file), false, `${file} is in the node bundle: adding a car would need a node release`);
  }
  for (const file of closure) assert.ok(!file.startsWith('src/render/'), `${file}: render code in the node bundle`);
  // And the catalog stays pure data: no import of its own, so nothing reaches it through it.
  assert.deepEqual(runtimeImports(join(ROOT, 'src/game/cosmetics.ts')), []);
});

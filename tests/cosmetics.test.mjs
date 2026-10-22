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
  for (const id of ['pampero', 'carpincho', 'condor', 'tero']) assert.equal(carCosmetic(id).price, 1500, `${id} price`);
  for (const id of CAR_IDS) assert.ok(isCarId(id));
  for (const bad of ['', 'Dune', 'car-next-1', 'dune ', 0, null, undefined, {}]) assert.equal(isCarId(bad), false, String(bad));
});

test('catalog: a car is available exactly when its body module has a body; a car still to come draws the default body', () => {
  // Adding a car (docs/cars.md) fills src/render/cars/<id>.ts and flips its status: this follows.
  for (const c of CARS) {
    assert.equal(c.status === 'available', hasCarBody(c.id), `${c.id}: status '${c.status}', body ${hasCarBody(c.id) ? 'built' : 'to come'}`);
    if (c.status === 'soon') assert.equal(carBody(c.id), carBody(DEFAULT_CAR), `${c.id} falls back to the default body`);
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

test('the hosts’ shop names each car as the locales do (its proper name, the same in every language)', async () => {
  const { CAR_NAMES, CATALOG } = await import('../nodes/control-plane/shop.ts');
  for (const id of CAR_IDS) {
    assert.equal(CAR_NAMES[id], en[`car.${id}`], `${id} (en)`);
    assert.equal(CAR_NAMES[id], es[`car.${id}`], `${id} (es)`);
  }
  for (const it of CATALOG.filter((i) => i.kind === 'car')) assert.equal(it.name, es[it.nameKey], it.id);
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
  assert.deepEqual(parseHashFlags('').cars, []);
  assert.equal(parseHashFlags('').showroom, null);
  assert.deepEqual(parseHashFlags('#car=tero&diag').cars, ['tero'], 'the player only');
  assert.deepEqual(parseHashFlags('#car=tero,tero').cars, ['tero', 'tero'], 'the player and the first bot (a 1v1: the red one)');
  assert.deepEqual(parseHashFlags('#car=,condor').cars, ['', 'condor'], 'the player keeps their own pick');
  assert.deepEqual(parseHashFlags('#car=').cars, []);
  assert.deepEqual(parseHashFlags('#carousel').cars, [], 'whole words only');
  assert.deepEqual(parseHashFlags('#showroom=35&high').showroom, { yawDeg: 35, pitchDeg: null, slot: null });
  assert.deepEqual(parseHashFlags('#superlow&showroom=145,20').showroom, { yawDeg: 145, pitchDeg: 20, slot: null });
  assert.deepEqual(parseHashFlags('#car=tero,tero&showroom=35,12,1').showroom, { yawDeg: 35, pitchDeg: 12, slot: 1 }, 'the red car of a 1v1');
  assert.deepEqual(parseHashFlags('#showroom').showroom, { yawDeg: null, pitchDeg: null, slot: null }, 'bare: the slow orbit');
  assert.deepEqual(parseShowroom(',80'), { yawDeg: null, pitchDeg: 80, slot: null });
  assert.deepEqual(parseShowroom('90,,3'), { yawDeg: 90, pitchDeg: null, slot: 3 });
  assert.deepEqual(parseShowroom('side,x,-1'), { yawDeg: null, pitchDeg: null, slot: null });
  assert.deepEqual(parseShowroom('0,0,1.5'), { yawDeg: 0, pitchDeg: 0, slot: null }, 'a slot is a whole roster index');
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

test('the community nodes bundle never imports the car catalog, the car pick or the online cars', () => {
  const closure = bundleClosure();
  // The walk reaches the game code nodes run (node-release-gate.mjs's inputs), so it is a real one.
  for (const input of ['nodes/node/matchRoom.ts', 'nodes/shared/nodeArena.ts', 'server/src/roomHost.ts', 'src/net/protocol.ts', 'src/game/Match.ts', 'src/sim/RocketSimBridge.ts', 'src/ai/Bot.ts']) {
    assert.ok(closure.has(input), `the walk reaches ${input}`);
  }
  // The online cars too: their wire types and helpers, and the shop that lists the catalog (server side).
  for (const file of ['src/game/cosmetics.ts', 'src/game/carSelection.ts', 'src/net/cosmetics.ts', 'nodes/control-plane/shop.ts']) {
    assert.equal(closure.has(file), false, `${file} is in the node bundle: adding a car would need a node release`);
  }
  for (const file of closure) assert.ok(!file.startsWith('src/render/'), `${file}: render code in the node bundle`);
  // And the catalog stays pure data: no import of its own, so nothing reaches it through it.
  assert.deepEqual(runtimeImports(join(ROOT, 'src/game/cosmetics.ts')), []);
});

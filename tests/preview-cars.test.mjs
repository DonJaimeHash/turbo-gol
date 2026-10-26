// A VITE_PREVIEW_CARS=1 build (node --test tests/preview-cars.test.mjs): the owner tries every car on
// devices from a static preview site with no API. Without an account the player is entitled to
// every catalog car offline (src/game/carSelection.ts PREVIEW_ALL_CARS, src/game/garage.ts): the
// garage shows each one owned, an equip picks it on this page alone and nothing reaches a server;
// the garage says it is a preview (previewNotice). Signed in, the account's cars are the server's
// as in any build. A production build drops all of it (the gate is read from import.meta.env as
// is, so Vite folds it to false): tests/garage.test.mjs runs the same modules without the flag.
//
// The build flag comes in the way Vite gives it to the page: carSelection.ts's import.meta.env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
  load(url, context, nextLoad) {
    const r = nextLoad(url, context);
    if (!url.endsWith('/src/game/carSelection.ts')) return r;
    // What a `VITE_PREVIEW_CARS=1 vite build` page reads (node has no import.meta.env of its own).
    return { ...r, source: "import.meta.env = { DEV: false, PROD: true, VITE_PREVIEW_CARS: '1' };\n" + String(r.source) };
  },
});

const { CAR_IDS, CARS, DEFAULT_CAR } = await import('../src/game/cosmetics.ts');
const { CAR_PICK_KEY, CarSelection, PREVIEW_ALL_CARS, entitledCars, previewCarsAllowed, setEntitledCars } = await import('../src/game/carSelection.ts');
const { Garage, garageView, previewNotice } = await import('../src/game/garage.ts');

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const wallet = (balance) => ({ earned: balance, spent: 0, balance, frozen: null });

/** A fake AccountClient: every account route is recorded in `calls` (a guest must record none). */
function fakeAccounts() {
  const listeners = new Set();
  const calls = [];
  const accounts = {
    account: null,
    calls,
    items: ['pampero'],
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    tell() {
      for (const fn of [...listeners]) fn();
    },
    signIn(playerId, car) {
      accounts.account = { kind: 'account', playerId, name: 'Ana', session: 's-' + playerId, expiresAt: 1e15, car };
      accounts.tell();
    },
    signOut() {
      accounts.account = null;
      accounts.tell();
    },
    async fetchItems() {
      calls.push('items');
      return { items: accounts.items.slice(), car: accounts.account?.car ?? DEFAULT_CAR, cars: [DEFAULT_CAR, ...accounts.items] };
    },
    async fetchShop() {
      calls.push('shop');
      return { items: [], wallet: wallet(0) };
    },
    async selectCar(car) {
      calls.push('car:' + car);
      if (car !== DEFAULT_CAR && !accounts.items.includes(car)) throw Object.assign(new Error('That car is not yours yet'), { code: 'not_owned' });
      accounts.account = { ...accounts.account, car };
      accounts.tell();
      return accounts.account;
    },
    async renewSession() {
      calls.push('renew');
      return accounts.account;
    },
    async claimItem(item) {
      calls.push('claim:' + item);
      throw new Error('no claims here');
    },
  };
  return accounts;
}

function makeGarage(storage = memoryStorage()) {
  setEntitledCars([]);
  const accounts = fakeAccounts();
  const pick = new CarSelection({ storage });
  let dressed = 0;
  const garage = new Garage(accounts, pick, () => dressed++);
  return { accounts, pick, garage, dressed: () => dressed };
}

test('a VITE_PREVIEW_CARS=1 build: the gate is on (the #car / #showroom flags too)', () => {
  assert.equal(PREVIEW_ALL_CARS, true);
  assert.equal(previewCarsAllowed(), true);
});

test('preview build, a guest: every catalog car is entitled offline; a saved pick of any car is driven', () => {
  const store = memoryStorage({ [CAR_PICK_KEY]: 'tero' });
  const { accounts, pick, garage } = makeGarage(store);
  assert.equal(garage.signedIn, false);
  assert.deepEqual(entitledCars(), CAR_IDS, 'every catalog car, menu order');
  assert.equal(pick.current, 'tero', 'Friendly vs AI and Training drive the saved pick (Game.localCar)');
  assert.equal(garage.equipped, 'tero');
  assert.deepEqual(accounts.calls, [], 'a guest asks the server nothing');
});

test('preview build, a guest: the garage shows every car owned, equip picks on this page alone, nothing goes to a server', async () => {
  const store = memoryStorage();
  const { accounts, pick, garage, dressed } = makeGarage(store);
  const v = garage.view(null);
  assert.equal(v.preview, true);
  assert.equal(v.explain, null, 'no invitation to sign in, no host points to explain: the screen says it is a preview');
  assert.equal(v.wallet, null);
  assert.deepEqual(
    v.cars.map((c) => [c.id, c.state, c.lock, c.action]),
    CARS.map((c) => [c.id, c.id === DEFAULT_CAR ? 'equipped' : 'owned', null, c.id === DEFAULT_CAR ? null : 'equip']),
  );

  for (const id of CAR_IDS) {
    assert.equal(await garage.equip(id), true, id);
    assert.equal(pick.current, id);
    assert.equal(store.map.get(CAR_PICK_KEY), id, 'kept in this browser for the next visits');
    assert.equal(garage.view(null).selected.id, id);
    assert.equal(garage.view(null).selected.state, 'equipped');
  }
  assert.equal(dressed(), CAR_IDS.length - 1, 'the Game dresses the player car at each change (dune was already on)');
  await garage.refresh();
  await settle();
  assert.deepEqual(accounts.calls, [], 'no items, no shop, no car pick, no claim: not one request');
});

test('preview build, signed in: the account\'s cars are the server\'s as in any build; a sign-out gives every car back', async () => {
  const store = memoryStorage({ [CAR_PICK_KEY]: 'condor' });
  const { accounts, pick, garage } = makeGarage(store);
  assert.equal(pick.current, 'condor');
  accounts.items = ['pampero'];
  accounts.signIn('a1', 'pampero');
  await settle();
  assert.deepEqual(entitledCars(), ['dune', 'pampero'], 'the default car and what the account owns, no more');
  assert.equal(pick.current, 'pampero', 'the session\'s car');
  const v = garage.view(null);
  assert.equal(v.preview, false);
  assert.equal(v.cars.find((c) => c.id === 'condor').state, 'locked');
  assert.equal(v.cars.find((c) => c.id === 'condor').action, null);
  await assert.rejects(garage.equip('condor'), /not yours/, 'an account equips through the server, which refuses a car it does not own');
  assert.equal(pick.current, 'pampero');

  accounts.signOut();
  assert.deepEqual(entitledCars(), CAR_IDS);
  assert.equal(garage.view(null).preview, true);
});

test('garageView: preview applies to a guest only; previewNotice in both languages, kept out of the locales', () => {
  const guest = garageView({ signedIn: false, equipped: 'condor', owned: [], shop: null, selected: null, preview: true });
  assert.equal(guest.selected.id, 'condor', 'a guest on a preview build drives any car');
  assert.equal(guest.selected.state, 'equipped');
  const account = garageView({ signedIn: true, equipped: 'condor', owned: [], shop: null, selected: null, preview: true });
  assert.equal(account.preview, false);
  assert.equal(account.selected.id, 'dune', 'an account that does not own the car drives the default car');
  assert.equal(garageView({ signedIn: false, equipped: 'dune', owned: [], shop: null, selected: null }).preview, false, 'not a preview unless told');

  assert.equal(previewNotice('es'), 'Vista previa: todos los autos desbloqueados');
  assert.equal(previewNotice('en'), 'Preview: every car unlocked');
  // In src/locales the text would ship in every production bundle (a locale is bundled whole).
  const dir = new URL('../src/locales/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.equal(src.includes(previewNotice('es')) || src.includes(previewNotice('en')), false, f);
  }
  // The gate is read from import.meta.env as is (a parameter or a helper would keep it in a production build).
  assert.match(readFileSync(new URL('../src/game/carSelection.ts', import.meta.url), 'utf8'), /export const PREVIEW_ALL_CARS: boolean = import\.meta\.env\?\.VITE_PREVIEW_CARS === '1';/);
});

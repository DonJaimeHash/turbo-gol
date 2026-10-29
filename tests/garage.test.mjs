// The cars online, client side (node --test tests/garage.test.mjs): which cars the player may
// drive (src/game/carSelection.ts setEntitledCars, kept by src/game/garage.ts from the account:
// its session's car, its items, its shop), each seat's car in an online roster
// (src/net/cosmetics.ts seatCars: the Welcome's, a room slot's, a node match's `cars`, the default
// car) and the garage's view model (garageView: each car's state and action, the wallet, what the
// screen explains). The server is the authority online; the client only follows it.
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

const { CARS, DEFAULT_CAR } = await import('../src/game/cosmetics.ts');
const { CAR_PICK_KEY, CarSelection, PREVIEW_ALL_CARS, entitledCars, setEntitledCars } = await import('../src/game/carSelection.ts');
const { Garage, garageView } = await import('../src/game/garage.ts');
const { carsOf, carsBySlot, nodeCarsOf, seatCars, itemsAnswerOf, shopAnswerOf, claimAnswerOf, walletOf } = await import('../src/net/cosmetics.ts');

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * The catalog with the default car and the `available` cars available, every other car still to
 * come, whatever src/game/cosmetics.ts says today (the bodies land on other branches: the model
 * must not care).
 */
function catalogWith(...available) {
  return CARS.map((c) => ({ ...c, status: c.id === DEFAULT_CAR || available.includes(c.id) ? 'available' : 'soon' }));
}

const wallet = (balance, extra = {}) => ({ earned: balance, spent: 0, balance, frozen: null, ...extra });

function shopItem(id, extra = {}) {
  return { id, kind: 'car', name: id, description: '', cost: 1500, status: 'available', owned: false, claimable: false, ...extra };
}

/**
 * A fake AccountClient for the Garage: `signIn` / `signOut` / `adopt` change the session and tell
 * the listeners; the account routes answer from `server` (a car pick is refused unless owned).
 */
function fakeAccounts() {
  const listeners = new Set();
  const calls = [];
  const server = { items: [], car: DEFAULT_CAR, shop: { items: [], wallet: wallet(0) }, failItems: false, refuse: null };
  const accounts = {
    account: null,
    server,
    calls,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    tell() {
      for (const fn of [...listeners]) fn();
    },
    signIn(playerId, car) {
      accounts.account = { kind: 'account', playerId, name: 'Ana', session: 's-' + playerId, expiresAt: 1e15, ...(car !== undefined ? { car } : {}) };
      accounts.tell();
    },
    signOut() {
      accounts.account = null;
      accounts.tell();
    },
    async fetchItems() {
      calls.push('items');
      if (server.failItems) throw new Error('offline');
      return { items: server.items.slice(), car: server.car, cars: [DEFAULT_CAR, ...server.items.filter((i) => CARS.some((c) => c.id === i))] };
    },
    async fetchShop() {
      calls.push('shop');
      const shop = structuredClone(server.shop);
      for (const it of shop.items) if (server.items.includes(it.id)) Object.assign(it, { owned: true, claimable: false });
      return shop;
    },
    async selectCar(car) {
      calls.push('car:' + car);
      if (server.refuse !== null) throw Object.assign(new Error(server.refuse), { code: server.refuse });
      if (car !== DEFAULT_CAR && !server.items.includes(car)) throw Object.assign(new Error('That car is not yours yet'), { code: 'not_owned' });
      server.car = car;
      accounts.account = { ...accounts.account, car };
      accounts.tell();
      return accounts.account;
    },
    /** The refresh cookie re-signs the session with the car the server has now (AccountsDO refOf). */
    async renewSession() {
      calls.push('renew');
      accounts.account = { ...accounts.account, session: accounts.account.session + "'", car: server.car };
      accounts.tell();
      return accounts.account;
    },
    async claimItem(item) {
      calls.push('claim:' + item);
      server.items = [...server.items, item].sort();
      server.shop.wallet = wallet(500, { earned: 2000, spent: 1500 });
      return { item, claimed: true, wallet: server.shop.wallet, items: server.items.slice() };
    },
  };
  return accounts;
}

function makeGarage(opts = {}) {
  setEntitledCars([]);
  const accounts = fakeAccounts();
  const pick = new CarSelection({ storage: opts.storage ?? memoryStorage() });
  let dressed = 0;
  const garage = new Garage(accounts, pick, () => dressed++);
  return { accounts, pick, garage, dressed: () => dressed };
}

// ---- entitlement -------------------------------------------------------------------------------

test('setEntitledCars: the default car always, catalog ids only, menu order; says whether the set changed', () => {
  setEntitledCars([]);
  assert.deepEqual(entitledCars(), ['dune']);
  assert.equal(setEntitledCars(['tero', 'not-a-car', 7, null, 'pampero', 'tero']), true);
  assert.deepEqual(entitledCars(), ['dune', 'pampero', 'tero'], 'menu order, junk dropped, no repeats');
  assert.equal(setEntitledCars(['pampero', 'tero', 'dune']), false, 'the same set');
  assert.equal(setEntitledCars([]), true);
  assert.deepEqual(entitledCars(), ['dune'], 'a guest: the default car alone');
});

test('Garage entitlement: a guest drives the default car; a sign-in widens it to the session car at once, then to the items', async () => {
  const store = memoryStorage({ [CAR_PICK_KEY]: 'tero' });
  const { accounts, pick, garage, dressed } = makeGarage({ storage: store });
  assert.equal(PREVIEW_ALL_CARS, false, 'not a VITE_PREVIEW_CARS=1 build (tests/preview-cars.test.mjs is one)');
  assert.equal(garage.signedIn, false);
  assert.deepEqual(entitledCars(), ['dune']);
  assert.equal(pick.current, 'dune', 'a saved pick a guest is not entitled to reads as the default car');
  assert.equal(garage.equipped, 'dune');
  assert.equal(garage.view(null).preview, false);
  assert.equal(await garage.equip('tero'), false, 'a guest cannot equip a car it does not own');
  assert.equal(pick.current, 'dune');

  accounts.server.items = ['host-badge', 'pampero', 'tero'];
  accounts.server.car = 'tero';
  accounts.signIn('a1', 'tero');
  // The session's car counts before any answer: the pick follows it (the saved one, here).
  assert.deepEqual(entitledCars(), ['dune', 'tero']);
  assert.equal(pick.current, 'tero');
  assert.equal(dressed(), 1, 'the Game dresses the player car once');
  await settle();
  assert.deepEqual(accounts.calls, ['items']);
  assert.deepEqual(entitledCars(), ['dune', 'pampero', 'tero'], 'every car the account owns, menu order (the badge is no car)');
  assert.deepEqual(garage.owned, ['host-badge', 'pampero', 'tero']);
  assert.equal(pick.current, 'tero');

  // A session refresh of the same account reads nothing again.
  accounts.tell();
  await settle();
  assert.deepEqual(accounts.calls, ['items']);

  // Sign-out: the default car alone again; the saved pick stays for that account's return.
  accounts.signOut();
  assert.deepEqual(entitledCars(), ['dune']);
  assert.equal(pick.current, 'dune');
  assert.equal(store.map.get(CAR_PICK_KEY), 'tero');
  assert.equal(dressed(), 2);
});

test('Garage entitlement: the server is the authority: an account drives the car its session carries, not the page pick', async () => {
  const store = memoryStorage({ [CAR_PICK_KEY]: 'pampero' });
  const { accounts, pick } = makeGarage({ storage: store });
  accounts.server.items = ['pampero'];
  accounts.server.car = 'dune';
  accounts.signIn('a1', 'dune');
  await settle();
  assert.deepEqual(entitledCars(), ['dune', 'pampero'], 'owned');
  assert.equal(pick.current, 'dune', 'the session says dune: the page follows');
  assert.equal(store.map.get(CAR_PICK_KEY), 'dune');
  // An older server (no car in the session or the items answer): the pick stays as entitled.
  const b = makeGarage({ storage: memoryStorage({ [CAR_PICK_KEY]: 'dune' }) });
  b.accounts.server.items = ['pampero'];
  b.accounts.fetchItems = async () => ({ items: ['pampero'], car: undefined, cars: ['dune', 'pampero'] });
  b.accounts.signIn('a2');
  await settle();
  assert.equal(b.pick.current, 'dune');
  assert.deepEqual(entitledCars(), ['dune', 'pampero']);
});

test('Garage entitlement: an answer for an account no longer signed in is dropped; items failing keeps the session car', async () => {
  const { accounts, pick } = makeGarage();
  let release;
  accounts.server.items = ['condor'];
  accounts.fetchItems = () => new Promise((r) => (release = () => r({ items: ['condor'], car: 'condor', cars: ['dune', 'condor'] })));
  accounts.signIn('a1');
  accounts.signOut();
  release();
  await settle();
  assert.deepEqual(entitledCars(), ['dune'], 'a1 left before its items came');
  assert.equal(pick.current, 'dune');

  const b = makeGarage();
  b.accounts.server.failItems = true;
  b.accounts.signIn('a3', 'tero');
  await settle();
  assert.deepEqual(entitledCars(), ['dune', 'tero'], 'offline: the session car still counts');
  assert.equal(b.pick.current, 'tero');
});

test('Garage after a revoke: an answer without the session\'s car entitles only what is owned, renews the session once, and the pick and the seat agree on the default car', async () => {
  // The items answer at sign-in already says the car went (revoked between the session and the answer).
  const store = memoryStorage({ [CAR_PICK_KEY]: 'pampero' });
  const { accounts, pick, garage } = makeGarage({ storage: store });
  accounts.server.items = [];
  accounts.server.car = DEFAULT_CAR;
  accounts.signIn('a1', 'pampero');
  assert.equal(pick.current, 'pampero', 'before any answer the session\'s car counts');
  await settle();
  assert.deepEqual(accounts.calls, ['items', 'renew']);
  assert.equal(accounts.account.car, DEFAULT_CAR, 'the re-signed session seats the default car online');
  assert.deepEqual(entitledCars(), ['dune']);
  assert.equal(pick.current, 'dune');
  assert.equal(garage.view(null).cars.find((c) => c.id === 'dune').state, 'equipped');

  // The revoke lands after the items answered: the shop answer no longer lists it as owned.
  const b = makeGarage({ storage: memoryStorage() });
  b.accounts.server.items = ['pampero'];
  b.accounts.server.car = 'pampero';
  b.accounts.server.shop = { items: [shopItem('pampero')], wallet: wallet(0) };
  b.accounts.signIn('a2', 'pampero');
  await settle();
  assert.deepEqual(b.accounts.calls, ['items'], 'nothing stale: no renewal');
  assert.equal(b.pick.current, 'pampero');
  b.accounts.server.items = [];
  b.accounts.server.car = DEFAULT_CAR;
  await b.garage.refresh();
  await settle();
  assert.deepEqual(b.accounts.calls, ['items', 'shop', 'renew']);
  assert.equal(b.pick.current, 'dune');
  assert.equal(b.accounts.account.car, DEFAULT_CAR);
  const v = b.garage.view(null);
  assert.deepEqual(v.cars.filter((c) => c.state === 'equipped').map((c) => c.id), ['dune'], 'one card is Equipped');
  // A renewal the server does not answer (offline): asked once per session, the pick still the default car.
  const c = makeGarage({ storage: memoryStorage() });
  c.accounts.server.items = [];
  c.accounts.renewSession = async () => (c.accounts.calls.push('renew'), Promise.reject(new Error('offline')));
  c.accounts.signIn('a3', 'tero');
  await settle();
  await c.garage.refresh();
  await settle();
  assert.deepEqual(c.accounts.calls, ['items', 'renew', 'shop']);
  assert.equal(c.pick.current, 'dune');
});

test('garageView: an equipped car that is not owned shows as the default car Equipped', () => {
  const v = garageView({ signedIn: true, equipped: 'pampero', owned: [], shop: null, selected: null });
  assert.deepEqual(v.cars.filter((c) => c.state === 'equipped').map((c) => c.id), ['dune']);
  assert.equal(v.selected.id, 'dune');
});

test('Garage.equip: an account goes through the server (its session moves the pick); a refusal changes nothing; a guest only the default car', async () => {
  const { accounts, pick, garage, dressed } = makeGarage();
  accounts.server.items = ['pampero'];
  accounts.signIn('a1', 'dune');
  await settle();
  assert.equal(await garage.equip('pampero'), true);
  assert.deepEqual(accounts.calls.filter((c) => c.startsWith('car:')), ['car:pampero']);
  assert.equal(accounts.account.car, 'pampero');
  assert.equal(pick.current, 'pampero');
  assert.equal(garage.equipped, 'pampero');
  const before = dressed();
  await assert.rejects(garage.equip('tero'), (err) => err.code === 'not_owned');
  assert.equal(pick.current, 'pampero', 'refused: nothing moved');
  assert.equal(dressed(), before);
  assert.equal(await garage.equip('not-a-car'), false);

  accounts.signOut();
  assert.equal(await garage.equip('pampero'), false, 'a guest is not entitled');
  assert.equal(await garage.equip('dune'), true);
  assert.deepEqual(accounts.calls.filter((c) => c.startsWith('car:')), ['car:pampero', 'car:tero'], 'a guest never calls the server');
});

test('Garage.refresh and claim: the shop and the wallet; a claimed car is owned at once and the shop is read again', async () => {
  const { accounts, garage } = makeGarage();
  await garage.refresh();
  assert.deepEqual(accounts.calls, [], 'a guest reads nothing');
  await assert.rejects(garage.claim('pampero'));

  accounts.server.shop = { items: [shopItem('pampero', { claimable: true }), shopItem('tero', { blocked: 'insufficient' })], wallet: wallet(1600) };
  accounts.signIn('a1');
  await settle();
  const changes = [];
  garage.subscribe(() => changes.push(garage.loading));
  await garage.refresh();
  assert.deepEqual(changes, [true, false], 'loading, then the answer');
  assert.equal(garage.shop.wallet.balance, 1600);
  assert.equal(garage.error, null);
  const r = await garage.claim('pampero');
  assert.equal(r.claimed, true);
  assert.deepEqual(garage.owned, ['pampero']);
  assert.deepEqual(entitledCars(), ['dune', 'pampero']);
  const p = garage.shop.items.find((i) => i.id === 'pampero');
  assert.equal(p.owned, true);
  assert.equal(p.claimable, false);
  assert.equal(garage.shop.wallet.balance, 500);
  await settle();
  assert.equal(accounts.calls.filter((c) => c === 'shop').length, 2, 'read again behind the claim');

  // A failed read keeps the player's text, and the next good one clears it.
  accounts.fetchShop = async () => {
    throw new Error('Server error (503)');
  };
  const b = makeGarage();
  b.accounts.fetchShop = accounts.fetchShop;
  b.accounts.signIn('a2');
  await b.garage.refresh();
  assert.equal(b.garage.error, 'Server error (503)');
  assert.equal(b.garage.loading, false);
});

// ---- each seat's car online --------------------------------------------------------------------

test('seatCars: a node match\'s cars from the Worker only, else the seat\'s own car (Welcome / room slot), else the default car; slot order', () => {
  // A MatchDO Welcome (roster entries in any order) and a P2P room's slots carry their own.
  const roster = [
    { slot: 1, kind: 'bot', name: 'Bot' },
    { slot: 0, kind: 'player', name: 'Ana', car: 'pampero' },
  ];
  assert.deepEqual(seatCars(roster), ['pampero', 'dune'], 'by slot; a bot drives the default car');
  // A community node's match: the Welcome has no cars, the assignment's `cars` does.
  const nodeRoster = [{ slot: 0 }, { slot: 1 }, { slot: 2 }, { slot: 3 }];
  assert.deepEqual(seatCars(nodeRoster, ['tero', null, 'condor', null]), ['tero', 'dune', 'condor', 'dune']);
  // A node's Welcome is its operator's: a car in it never counts, the Worker's list alone does
  // (an empty list: a node match where every seat drives the default car).
  assert.deepEqual(seatCars([{ slot: 0, car: 'carpincho' }, { slot: 1, car: 'tero' }], ['pampero', null]), ['pampero', 'dune']);
  assert.deepEqual(seatCars([{ slot: 0, car: 'tero' }, { slot: 1, car: 'condor' }], []), ['dune', 'dune']);
  // Not a node match (null / absent): every seat's own, else the default (an old server, an old page's answer).
  assert.deepEqual(seatCars(nodeRoster, null), ['dune', 'dune', 'dune', 'dune']);
  assert.deepEqual(seatCars(nodeRoster), ['dune', 'dune', 'dune', 'dune']);
  // An id this page does not know, or a field of another shape, reads as the default car.
  assert.deepEqual(seatCars([{ slot: 0, car: 'batmobile' }, { slot: 1, car: 42 }, { slot: 2, car: { id: 'tero' } }]), ['dune', 'dune', 'dune']);
  assert.deepEqual(seatCars([{ slot: 0 }, { slot: 1 }, { slot: 2 }], ['batmobile', 7, 'tero']), ['dune', 'dune', 'tero']);
  assert.deepEqual(seatCars([{ slot: 0, car: 'batmobile' }]), ['dune']);
  assert.deepEqual(seatCars([{ slot: 0 }, { slot: 1 }], ['tero']), ['tero', 'dune'], 'a short answer: the rest default');
});

test('nodeCarsOf: a node match always has a list (the Worker\'s `cars`, else []), any other match none', () => {
  assert.deepEqual(nodeCarsOf({ node: true, cars: ['tero', null] }), ['tero', null]);
  assert.deepEqual(nodeCarsOf({ node: true }), [], 'every seat on the default car: the Worker leaves the field out');
  assert.deepEqual(nodeCarsOf({ node: true, cars: ['tero', 'batmobile'] }), [], 'a field of another shape: the default for all, never the node\'s Welcome');
  assert.equal(nodeCarsOf({ matchId: 'm', cars: ['tero'] }), undefined, 'a MatchDO match: its Welcome has them');
  assert.equal(nodeCarsOf({ node: 'yes', cars: ['tero'] }), undefined);
  assert.equal(nodeCarsOf(null), undefined);
});

test('carsOf / carsBySlot: a node answer\'s `cars` is up to six car ids or nulls, else dropped; absent when every seat drives the default', () => {
  assert.deepEqual(carsOf(['tero', null]), ['tero', null]);
  assert.equal(carsOf(undefined), undefined);
  assert.equal(carsOf('tero'), undefined);
  assert.equal(carsOf(['tero', 'ferrari']), undefined, 'one unknown id: the whole field is dropped');
  assert.equal(carsOf([null, null, null, null, null, null, null]), undefined, 'more seats than a 3v3');
  assert.equal(carsOf([1]), undefined);
  assert.equal(carsBySlot(2, [{ slot: 0 }, { slot: 1 }]), undefined);
  assert.deepEqual(carsBySlot(4, [{ slot: 2, car: 'condor' }, { slot: 9, car: 'tero' }]), [null, null, 'condor', null]);
});

test('the account answers are read leniently: a field of another shape is dropped, never trusted', () => {
  assert.deepEqual(walletOf({ earned: 10, spent: -5, balance: 'x', frozen: '' }), { earned: 10, spent: 0, balance: 0, frozen: null });
  assert.deepEqual(walletOf(null), { earned: 0, spent: 0, balance: 0, frozen: null });
  assert.deepEqual(itemsAnswerOf({ items: ['pampero', 3, 'host-badge'], car: 'ferrari', cars: ['tero'] }), { items: ['pampero', 'host-badge'], car: 'dune', cars: ['dune', 'pampero', 'tero'] });
  const shop = shopAnswerOf({
    items: [shopItem('pampero', { blocked: 'insufficient', nameKey: 'car.pampero' }), { id: 'x', kind: 'spaceship', status: 'available' }, { kind: 'car', status: 'soon' }, shopItem('tero', { blocked: 'whatever', cost: 'free' })],
    wallet: { earned: 3, spent: 1, balance: 2, frozen: null },
  });
  assert.deepEqual(shop.items.map((i) => i.id), ['pampero', 'tero']);
  assert.equal(shop.items[0].blocked, 'insufficient');
  assert.equal('blocked' in shop.items[1], false, 'an unknown refusal is dropped');
  assert.equal(shop.items[1].cost, 0);
  assert.deepEqual(claimAnswerOf({ item: 'tero', claimed: 'yes', items: ['tero'] }), { item: 'tero', claimed: false, wallet: { earned: 0, spent: 0, balance: 0, frozen: null }, items: ['tero'] });
});

// ---- the garage's view model -------------------------------------------------------------------

test('garageView: a guest sees the default car equipped, the others locked (sign in) or still to come, and is asked to sign in', () => {
  const v = garageView({ signedIn: false, equipped: 'dune', owned: [], shop: null, selected: null, catalog: catalogWith('pampero') });
  assert.deepEqual(v.cars.map((c) => [c.id, c.state, c.lock, c.action]), [
    ['dune', 'equipped', null, null],
    ['pampero', 'locked', 'guest', null],
    ['carpincho', 'soon', null, null],
    ['condor', 'soon', null, null],
    ['tero', 'soon', null, null],
  ]);
  assert.equal(v.selected.id, 'dune', 'the equipped car on screen first');
  assert.equal(v.wallet, null);
  assert.equal(v.explain, 'signIn');
  assert.equal(v.cars[1].price, 1500);
  assert.equal(v.cars[0].price, 0);
  // Without a catalog the game's own (src/game/cosmetics.ts): a built car locked for a guest, one still to come shown so.
  const today = garageView({ signedIn: false, equipped: 'dune', owned: [], shop: null, selected: null });
  assert.deepEqual(
    today.cars.map((c) => c.state),
    CARS.map((c) => (c.id === DEFAULT_CAR ? 'equipped' : c.status === 'available' ? 'locked' : 'soon')),
  );
});

test('garageView: an account\'s cars by the shop: owned (equip), claimable (claim), locked with the shop\'s reason, coming soon; the points explained at 0', () => {
  const shop = {
    items: [
      shopItem('pampero', { owned: true }),
      shopItem('carpincho', { claimable: true }),
      shopItem('condor', { blocked: 'insufficient' }),
      shopItem('tero', { status: 'soon', blocked: 'not_available' }),
      { id: 'host-badge', kind: 'badge', name: 'Host', description: '', cost: 0, status: 'available', owned: false, claimable: false, blocked: 'requires_matches' },
    ],
    wallet: wallet(0),
  };
  const catalog = catalogWith('pampero', 'carpincho', 'condor', 'tero');
  const v = garageView({ signedIn: true, equipped: 'dune', owned: [], shop, selected: 'carpincho', catalog });
  assert.deepEqual(v.cars.map((c) => [c.id, c.state, c.lock, c.action]), [
    ['dune', 'equipped', null, null],
    ['pampero', 'owned', null, 'equip'],
    ['carpincho', 'claimable', null, 'claim'],
    ['condor', 'locked', 'insufficient', null],
    ['tero', 'soon', null, null],
  ], 'a server that has not the body yet keeps it to come, whatever this page has');
  assert.equal(v.selected.id, 'carpincho');
  assert.equal(v.cars.filter((c) => c.selected).length, 1);
  assert.deepEqual(v.wallet, wallet(0));
  assert.equal(v.explain, 'host', 'no points to spend: how they are earned');
  assert.equal(garageView({ signedIn: true, equipped: 'pampero', owned: ['pampero'], shop: { ...shop, wallet: wallet(2300) }, selected: null, catalog }).explain, null);

  // The equipped car is the pick (an owned car); an owned car whose body is not built is still owned.
  const w = garageView({ signedIn: true, equipped: 'pampero', owned: ['pampero'], shop: null, selected: 'ferrari', catalog: catalogWith() });
  assert.deepEqual(w.cars.slice(0, 2).map((c) => [c.id, c.state, c.action, c.bodyReady]), [
    ['dune', 'owned', 'equip', true],
    ['pampero', 'equipped', null, false],
  ]);
  assert.equal(w.selected.id, 'pampero', 'an unknown card picks the equipped car');
  assert.equal(w.wallet, null, 'the shop has not answered');
  assert.equal(w.explain, null);
  // Before the shop answers a car out of reach says it is loading; a refusal the garage does not name is 'not_available'.
  const x = garageView({ signedIn: true, equipped: 'dune', owned: [], shop: null, selected: null, catalog });
  assert.deepEqual(x.cars.map((c) => c.lock), [null, 'unknown', 'unknown', 'unknown', 'unknown']);
  const y = garageView({ signedIn: true, equipped: 'dune', owned: [], shop: { items: [shopItem('pampero', { blocked: 'unknown_item' }), shopItem('tero', { blocked: 'frozen', cost: 1800 })], wallet: wallet(0, { frozen: 'verification_failed:abc' }) }, selected: 'tero', catalog });
  assert.equal(y.cars[1].lock, 'not_available');
  assert.equal(y.cars[2].lock, 'not_available', 'not listed by the server');
  assert.equal(y.selected.lock, 'frozen');
  assert.equal(y.selected.price, 1800, "the server's price when it answered");
  assert.equal(y.wallet.frozen, 'verification_failed:abc');
});

test('Garage.view: the view model for the account as the garage knows it', async () => {
  const { accounts, garage } = makeGarage();
  accounts.server.items = ['pampero'];
  accounts.server.car = 'pampero';
  accounts.server.shop = { items: [shopItem('pampero', { status: 'soon' })], wallet: wallet(0) };
  accounts.signIn('a1', 'pampero');
  await garage.refresh();
  const v = garage.view(null);
  assert.equal(v.selected.id, 'pampero');
  assert.equal(v.selected.state, 'equipped');
  assert.equal(v.selected.bodyReady, CARS.find((c) => c.id === 'pampero').status === 'available');
  assert.equal(v.explain, 'host');
  assert.equal(garage.view('dune').cars[0].action, 'equip');
});

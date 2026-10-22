// The hosts' shop: only points from verified hosting buy items; frozen wallets cannot claim.
import '../dev/ts-resolve.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Ledger } = await import('../control-plane/ledger.ts');
const { Shop, CATALOG, catalogItem, claimBlock } = await import('../control-plane/shop.ts');
const { CARS, DEFAULT_CAR } = await import('../../src/game/cosmetics.ts');

/** A car of the catalog, pinned to 'soon' whatever its body's state (cosmetics.ts flips them as the bodies land). */
function shopWithSoonCar(L) {
  const S = new Shop(L);
  S.setItemStatus('pampero', 'soon');
  return S;
}

function earn(L, operatorId, minutes, at = 1_000) {
  return L.record(
    { matchId: 'm' + at, nodeId: 'n', operatorId, region: 'SA', mode: '1v1', ranked: false, verified: true, endReason: 'rules', tickLagP99Ms: 8, underrunRate: 0.02, at, players: [{ playerId: 'p' + at, connectedMs: minutes * 60_000, account: true, accountAgeDays: 30 }] },
    1,
  );
}

test('the free host badge needs one verified hosted match', () => {
  const L = new Ledger();
  const S = new Shop(L);
  assert.equal(S.claim('op', 'badge-host', 1).code, 'requires_matches');
  earn(L, 'op', 5);
  const r = S.claim('op', 'badge-host', 2);
  assert.equal(r.ok, true);
  assert.equal(r.wallet.spent, 0);
  assert.deepEqual(S.inventory('op'), ['badge-host']);
  assert.equal(S.claim('op', 'badge-host', 3).code, 'owned');
});

test('items cost points; announced items are not claimable until the game has them', () => {
  const L = new Ledger();
  const S = shopWithSoonCar(L);
  earn(L, 'op', 1000, 1);
  earn(L, 'op', 900, 2);
  assert.equal(S.wallet('op').balance, 1900);
  assert.equal(S.claim('op', 'pampero', 3).code, 'not_available');
  // The game ships the car: the catalog entry flips to available.
  assert.ok(S.setItemStatus('pampero', 'available'));
  assert.equal(S.claim('op', 'pampero', 4).ok, true);
  assert.equal(S.wallet('op').balance, 400);
  assert.ok(S.owns('op', 'pampero'));
  S.setItemStatus('boost-next-1', 'available');
  assert.equal(S.claim('op', 'boost-next-1', 5).code, 'insufficient');
  assert.equal(S.claim('op', 'nope', 6).code, 'unknown_item');
  // Retired: owners keep it and still see it; others do not.
  S.setItemStatus('pampero', 'retired');
  assert.ok(S.view('op').some((i) => i.id === 'pampero' && i.owned));
  assert.ok(!S.view('other').some((i) => i.id === 'pampero'));
});

test('a frozen wallet (failed verification under review) cannot claim; points are not transferable', () => {
  const L = new Ledger();
  const S = shopWithSoonCar(L);
  earn(L, 'op', 3000);
  S.setItemStatus('pampero', 'available');
  S.freeze('op', 'verification_failed:abc');
  assert.equal(S.claim('op', 'pampero', 1).code, 'frozen');
  assert.equal(S.wallet('op').frozen, 'verification_failed:abc');
  S.unfreeze('op');
  assert.equal(S.claim('op', 'pampero', 2).ok, true);
  // Somebody who never hosted has nothing, whatever they do.
  assert.equal(S.wallet('player').balance, 0);
  assert.equal(S.claim('player', 'pampero', 3).code, 'insufficient');
});

test('catalog view: claimable flags and reasons', () => {
  const L = new Ledger();
  const S = shopWithSoonCar(L);
  earn(L, 'op', 10);
  const v = S.view('op');
  assert.equal(v.length, CATALOG.length);
  const badge = v.find((i) => i.id === 'badge-host');
  assert.equal(badge.claimable, true);
  const car = v.find((i) => i.id === 'pampero');
  assert.equal(car.claimable, false);
  assert.equal(car.blocked, 'not_available');
  assert.throws(() => S.upsertItem({ id: 'BAD ID', kind: 'car', name: 'x', description: '', cost: 1, status: 'soon' }));
});

test('the cars of the catalog are those of src/game/cosmetics.ts: one table of ids, prices and statuses; the default car is never listed', () => {
  const cars = CATALOG.filter((i) => i.kind === 'car');
  assert.deepEqual(cars.map((i) => i.id), CARS.filter((c) => c.id !== DEFAULT_CAR).map((c) => c.id));
  for (const it of cars) {
    const c = CARS.find((x) => x.id === it.id);
    assert.equal(it.cost, c.price, it.id);
    assert.equal(it.status, c.status, it.id);
    assert.equal(it.nameKey, c.nameKey);
    assert.equal(it.descKey, c.descKey);
    assert.ok(it.name.length > 0 && it.description.length > 0, 'the shop has its own texts too');
  }
  assert.equal(catalogItem(DEFAULT_CAR), undefined, 'everyone drives the default car: nothing to claim');
  assert.equal(catalogItem('car-next-1'), undefined, 'the placeholder is gone');
  assert.equal(new Set(CATALOG.map((i) => i.id)).size, CATALOG.length, 'unique ids');
});

test('claimBlock: the one claim rule (unknown, owned, not available, frozen, matches, balance, in that order)', () => {
  const st = (o = {}) => ({ owns: () => false, frozen: null, verifiedMatches: 0, balance: 0, ...o });
  const car = { id: 'x-car', kind: 'car', name: 'X', description: '', cost: 100, status: 'available' };
  assert.equal(claimBlock(undefined, st()), 'unknown_item');
  assert.equal(claimBlock(car, st({ owns: () => true, frozen: 'f' })), 'owned');
  assert.equal(claimBlock({ ...car, status: 'soon' }, st({ frozen: 'f' })), 'not_available');
  assert.equal(claimBlock(car, st({ frozen: 'f', balance: 1000 })), 'frozen');
  assert.equal(claimBlock({ ...car, minVerifiedMatches: 1 }, st({ balance: 1000 })), 'requires_matches');
  assert.equal(claimBlock(car, st({ balance: 99.99 })), 'insufficient');
  assert.equal(claimBlock(car, st({ balance: 100 })), null);
});

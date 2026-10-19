// The hosts' shop: only points from verified hosting buy items; frozen wallets cannot claim.
import '../dev/ts-resolve.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Ledger } = await import('../control-plane/ledger.ts');
const { Shop, CATALOG } = await import('../control-plane/shop.ts');

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
  const S = new Shop(L);
  earn(L, 'op', 1000, 1);
  earn(L, 'op', 900, 2);
  assert.equal(S.wallet('op').balance, 1900);
  assert.equal(S.claim('op', 'car-next-1', 3).code, 'not_available');
  // The game ships the car: the catalog entry flips to available.
  assert.ok(S.setItemStatus('car-next-1', 'available'));
  assert.equal(S.claim('op', 'car-next-1', 4).ok, true);
  assert.equal(S.wallet('op').balance, 400);
  assert.ok(S.owns('op', 'car-next-1'));
  S.setItemStatus('boost-next-1', 'available');
  assert.equal(S.claim('op', 'boost-next-1', 5).code, 'insufficient');
  assert.equal(S.claim('op', 'nope', 6).code, 'unknown_item');
  // Retired: owners keep it and still see it; others do not.
  S.setItemStatus('car-next-1', 'retired');
  assert.ok(S.view('op').some((i) => i.id === 'car-next-1' && i.owned));
  assert.ok(!S.view('other').some((i) => i.id === 'car-next-1'));
});

test('a frozen wallet (failed verification under review) cannot claim; points are not transferable', () => {
  const L = new Ledger();
  const S = new Shop(L);
  earn(L, 'op', 3000);
  S.setItemStatus('car-next-1', 'available');
  S.freeze('op', 'verification_failed:abc');
  assert.equal(S.claim('op', 'car-next-1', 1).code, 'frozen');
  assert.equal(S.wallet('op').frozen, 'verification_failed:abc');
  S.unfreeze('op');
  assert.equal(S.claim('op', 'car-next-1', 2).ok, true);
  // Somebody who never hosted has nothing, whatever they do.
  assert.equal(S.wallet('player').balance, 0);
  assert.equal(S.claim('player', 'car-next-1', 3).code, 'insufficient');
});

test('catalog view: claimable flags and reasons', () => {
  const L = new Ledger();
  const S = new Shop(L);
  earn(L, 'op', 10);
  const v = S.view('op');
  assert.equal(v.length, CATALOG.length);
  const badge = v.find((i) => i.id === 'badge-host');
  assert.equal(badge.claimable, true);
  const car = v.find((i) => i.id === 'car-next-1');
  assert.equal(car.claimable, false);
  assert.equal(car.blocked, 'not_available');
  assert.throws(() => S.upsertItem({ id: 'BAD ID', kind: 'car', name: 'x', description: '', cost: 1, status: 'soon' }));
});

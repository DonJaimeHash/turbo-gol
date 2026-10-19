// Training records per player (src/game/trainingRecords.ts merge rules, src/game/trainingStore.ts):
// a guest's stay in this browser, an account's sync with the server through a fake remote, the
// guest records move into the first account, offline runs go up with the next sync; plus
// AccountClient.pushTraining against a fake fetch.
// Run: node --test tests/training-store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND' && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
      throw err;
    }
  },
});

const R = await import('../src/game/trainingRecords.ts');
const { TrainingStore } = await import('../src/game/trainingStore.ts');
const { AccountClient } = await import('../src/net/AccountClient.ts');

class FakeStorage {
  constructor(init = {}) {
    this.map = new Map(Object.entries(init));
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

/** A server that keeps one account's records and merges like the real one. */
function fakeRemote(id = 'aaaaaaaaaaaaaaaa') {
  const remote = {
    id,
    server: {},
    calls: 0,
    fail: false,
    accountId: () => remote.id,
    async push(records) {
      remote.calls++;
      if (remote.fail) throw new Error('offline');
      remote.server = R.mergeTrainingRecords(remote.server, records);
      return { ...remote.server };
    },
  };
  return remote;
}

const rec = (best, shots, completedAt) => ({ best, shots, completedAt });

test('merge: the higher best for the same length (a tie keeps the first), the newer run when the length changed', () => {
  const a = { p1: rec(5, 8, 10), p2: rec(3, 8, 10), p3: rec(2, 8, 50) };
  const b = { p1: rec(6, 8, 20), p2: rec(3, 8, 30), p3: rec(4, 10, 40), p4: rec(1, 5, 1) };
  const m = R.mergeTrainingRecords(a, b);
  assert.deepEqual(m.p1, rec(6, 8, 20));
  assert.deepEqual(m.p2, rec(3, 8, 10), 'a tie keeps the older record');
  assert.deepEqual(m.p3, rec(2, 8, 50), 'different lengths: the more recent run');
  assert.deepEqual(m.p4, rec(1, 5, 1));
  assert.deepEqual(a.p1, rec(5, 8, 10), 'inputs untouched');
  assert.ok(R.sameTrainingRecords(m, R.mergeTrainingRecords(m, a)), 'merging again changes nothing');
});

test('parse keeps at most MAX_TRAINING_RECORDS packs', () => {
  const many = {};
  for (let i = 0; i < 60; i++) many['pack-' + i] = rec(1, 2, i);
  assert.equal(Object.keys(R.parseTrainingRecords(many)).length, R.MAX_TRAINING_RECORDS);
});

test('a guest: records stay in this browser, no request', async () => {
  const storage = new FakeStorage();
  const store = new TrainingStore({ accountId: () => null, push: () => assert.fail('no request for a guest') }, storage);
  const u = store.recordResult('shooting-easy', 5, 8, 100);
  assert.equal(u.newBest, true);
  assert.deepEqual(store.records(), { 'shooting-easy': rec(5, 8, 100) });
  assert.deepEqual(await store.sync(), store.records());
  assert.ok(storage.getItem(R.TRAINING_RECORDS_KEY) !== null);
});

test('an account: the guest records move in once, the server merge comes back, the guest key is cleared', async () => {
  const storage = new FakeStorage({ [R.TRAINING_RECORDS_KEY]: JSON.stringify({ 'shooting-easy': rec(7, 8, 50), 'aerial-easy': rec(2, 6, 50) }) });
  const remote = fakeRemote();
  remote.server = { 'shooting-easy': rec(5, 8, 10), 'saving-hard': rec(9, 10, 10) };
  const store = new TrainingStore(remote, storage);
  const after = await store.sync();
  assert.deepEqual(after, { 'shooting-easy': rec(7, 8, 50), 'aerial-easy': rec(2, 6, 50), 'saving-hard': rec(9, 10, 10) });
  assert.deepEqual(remote.server, after, 'the server got the guest records');
  assert.equal(storage.getItem(R.TRAINING_RECORDS_KEY), null, 'the guest copy is cleared');
  assert.deepEqual(R.loadTrainingRecords(storage, R.accountRecordsKey(remote.id)), after, 'the account copy');
  assert.deepEqual(store.records(), after, 'the menu reads the account copy');
  // Signed out: the guest starts empty (the records belong to the account now).
  remote.id = null;
  assert.deepEqual(store.records(), {});
});

test('an account: a run finished offline stays in the local copy and goes up with the next sync', async () => {
  const storage = new FakeStorage();
  const remote = fakeRemote();
  remote.fail = true;
  const store = new TrainingStore(remote, storage);
  const u = store.recordResult('saving-easy', 4, 8, 100);
  assert.equal(u.newBest, true);
  await assert.rejects(store.sync(), /offline/);
  assert.deepEqual(store.records(), { 'saving-easy': rec(4, 8, 100) }, 'kept locally');
  remote.fail = false;
  await store.sync();
  assert.deepEqual(remote.server, { 'saving-easy': rec(4, 8, 100) }, 'uploaded at the next sync');
});

test('an account: a new best triggers a sync on its own; a worse run does not', async () => {
  const storage = new FakeStorage();
  const remote = fakeRemote();
  const store = new TrainingStore(remote, storage);
  store.recordResult('aerial-hard', 3, 10, 100);
  await store.sync(); // queued after the automatic one
  const calls = remote.calls;
  assert.ok(calls >= 2 && remote.server['aerial-hard'].best === 3);
  const u = store.recordResult('aerial-hard', 1, 10, 200);
  assert.equal(u.newBest, false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(remote.calls, calls, 'no request for a run that is not a new best');
});

test('signing out during a sync leaves the copies alone', async () => {
  const storage = new FakeStorage();
  const remote = fakeRemote();
  let release;
  remote.push = (records) =>
    new Promise((resolve) => {
      release = () => resolve({ 'shooting-hard': rec(1, 8, 1), ...records });
    });
  const store = new TrainingStore(remote, storage);
  const p = store.sync();
  await new Promise((r) => setTimeout(r, 0));
  remote.id = null;
  release();
  await p;
  assert.equal(storage.getItem(R.accountRecordsKey('aaaaaaaaaaaaaaaa')), null, 'nothing written for the old account');
});

test('AccountClient.pushTraining: POST with the Bearer, parsed answer; a guest is refused before any request', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ records: { 'shooting-easy': rec(5, 8, 1), 'bad id': rec(1, 1, 1) } }) };
  };
  const ac = new AccountClient({ fetchFn, storage: null, now: () => 1000 });
  await assert.rejects(ac.pushTraining({}), (e) => e.code === 'unauthorized');
  assert.equal(calls.length, 0);
  ac.account = { kind: 'account', playerId: 'aaaaaaaaaaaaaaaa', name: 'A', session: 'S', expiresAt: 1000 + 3_600_000 };
  const out = await ac.pushTraining({ 'shooting-easy': rec(5, 8, 1) });
  assert.deepEqual(out, { 'shooting-easy': rec(5, 8, 1) }, 'invalid entries of the answer are dropped');
  assert.equal(calls[0].url, '/api/me/training');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer S');
  assert.deepEqual(JSON.parse(calls[0].init.body), { records: { 'shooting-easy': rec(5, 8, 1) } });
});

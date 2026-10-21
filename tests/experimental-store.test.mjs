// The account's experimental state on the client (src/game/experimentalStore.ts): the switch and
// the physics presets, the local copy per account, the boot unlock from the { name, id } hint, the
// debounced pushes, offline edits, the 10-preset cap, deletes that need the server, corrupt storage.
// A fake remote and fake timers; nothing touches the network.
// Run: node --test tests/experimental-store.test.mjs
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

const X = await import('../src/game/experimentalStore.ts');
const R = await import('../src/game/physicsRules.ts');
const { ACCOUNT_HINT_KEY } = await import('../src/net/AccountClient.ts');

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

/** The account side in memory (what AccountStore does, simplified), with a switchable network. */
function fakeServer() {
  const accounts = new Map();
  const state = (id) => {
    if (!accounts.has(id)) accounts.set(id, { enabled: false, presets: [] });
    return accounts.get(id);
  };
  let clock = 1000;
  const srv = {
    online: true,
    who: A,
    calls: [],
    accounts,
    state,
    remote: {
      accountId: () => srv.who,
      fetch: async () => srv.answer('fetch'),
      setEnabled: async (on) => {
        srv.gate('setEnabled');
        state(srv.who).enabled = on;
        return srv.answer(null);
      },
      upsert: async (p) => {
        srv.gate('upsert');
        const s = state(srv.who);
        const i = s.presets.findIndex((q) => q.id === p.id);
        if (i < 0 && s.presets.length >= R.MAX_PRESETS) throw Object.assign(new Error('too_many'), { code: 'too_many', status: 409 });
        const row = { id: p.id, name: p.name, values: p.values, updatedAt: ++clock };
        if (i < 0) s.presets.push(row);
        else s.presets[i] = row;
        return srv.answer(null);
      },
      remove: async (id) => {
        srv.gate('remove');
        const s = state(srv.who);
        s.presets = s.presets.filter((p) => p.id !== id);
        return srv.answer(null);
      },
    },
    gate(what) {
      srv.calls.push(what);
      if (!srv.online) throw Object.assign(new Error('offline'), { code: 'network', status: 0 });
    },
    answer(what) {
      if (what !== null) srv.gate(what);
      const s = state(srv.who);
      return { enabled: s.enabled, presets: s.presets.map((p) => ({ ...p, values: { ...p.values } })) };
    },
  };
  return srv;
}

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimer: (fn, ms) => {
      const h = next++;
      pending.set(h, { fn, ms });
      return h;
    },
    clearTimer: (h) => pending.delete(h),
    pending,
    /** Run every pending timer (they may schedule more). */
    fire() {
      const all = [...pending.values()];
      pending.clear();
      for (const t of all) t.fn();
    },
  };
}

let idCount = 0;
function makeStore(srv, storage = memStorage(), extra = {}) {
  const timers = fakeTimers();
  const problems = [];
  const store = new X.ExperimentalStore(srv === null ? null : srv.remote, {
    storage,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    newId: () => (++idCount).toString(16).padStart(12, '0'),
    ...extra,
  });
  store.onProblem = (p) => problems.push(p);
  return { store, storage, timers, problems };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('a guest has nothing: off, the built-ins only, every write refused', async () => {
  const { store, storage } = makeStore(null);
  assert.equal(store.enabled(), false);
  assert.equal(store.accountId(), null);
  assert.deepEqual(store.list().map((p) => p.id), ['standard', 'lowGravity', 'fastBall', 'bouncy', 'arcade']);
  assert.ok(store.list().every((p) => p.builtIn && p.synced));
  store.setEnabled(true);
  assert.equal(store.enabled(), false);
  assert.equal(store.create('Mine'), 'guest');
  assert.equal(await store.remove('0123456789ab'), false);
  assert.equal(store.lastUsed(), 'standard');
  await store.sync();
  assert.equal(storage.map.size, 0, 'nothing written');
  const srv = fakeServer();
  srv.who = null;
  const s2 = makeStore(srv).store;
  await s2.sync();
  assert.deepEqual(srv.calls, [], 'no request for a guest');
});

test('the switch: saved at once and pushed; offline it stays dirty, says so once, and goes up with the next sync', async () => {
  const srv = fakeServer();
  const { store, storage, problems } = makeStore(srv);
  let changes = 0;
  store.subscribe(() => changes++);
  store.setEnabled(true);
  assert.equal(store.enabled(), true, 'local at once');
  assert.ok(changes >= 1);
  await settle();
  assert.equal(srv.state(A).enabled, true, 'sent to the account');
  assert.equal(JSON.parse(storage.getItem(X.experimentalKey(A))).enabledDirty, false);
  srv.online = false;
  store.setEnabled(false);
  await settle();
  assert.equal(store.enabled(), false);
  assert.equal(srv.state(A).enabled, true);
  assert.deepEqual(problems, ['offline']);
  await store.sync();
  assert.deepEqual(problems, ['offline'], 'once per offline streak');
  assert.equal(store.enabled(), false, 'the local change wins over the server answer it could not send');
  srv.online = true;
  await store.sync();
  assert.equal(srv.state(A).enabled, false, 'pushed with the next sync');
  assert.equal(JSON.parse(storage.getItem(X.experimentalKey(A))).enabledDirty, false);
});

test('MeInfo.experimental: taken when nothing changed here lately; ignored while a local change is pending or fresh', async () => {
  let now = 1_000_000;
  const srv = fakeServer();
  const { store } = makeStore(srv, memStorage(), { now: () => now });
  store.noteServerEnabled(true);
  assert.equal(store.enabled(), true);
  store.setEnabled(false);
  await settle();
  store.noteServerEnabled(true); // an /api/me answer that may predate the change
  assert.equal(store.enabled(), false);
  now += X.NOTE_GRACE_MS + 1;
  store.noteServerEnabled(true);
  assert.equal(store.enabled(), true, 'switched on another device');
});

test('the copy is per account; sign-out keeps it; the boot unlock reads the { name, id } hint, an id-less hint is locked', async () => {
  const srv = fakeServer();
  const storage = memStorage();
  const { store } = makeStore(srv, storage);
  store.setEnabled(true);
  store.create('Low gravity', { gravity: 50 });
  await store.flush();
  srv.who = B;
  assert.equal(store.enabled(), false, 'another account: its own copy');
  assert.equal(store.presets().length, 0);
  srv.who = null;
  assert.equal(store.enabled(), false);
  srv.who = A;
  assert.equal(store.enabled(), true, 'the copy outlived the sign-out');
  assert.equal(store.presets()[0].name, 'Low gravity');
  assert.equal(X.ExperimentalStore.unlockedAtBoot(storage), false, 'no hint: a guest');
  storage.setItem(ACCOUNT_HINT_KEY, JSON.stringify({ name: 'Tomi', id: A }));
  assert.equal(X.ExperimentalStore.unlockedAtBoot(storage), true);
  storage.setItem(ACCOUNT_HINT_KEY, JSON.stringify({ name: 'Tomi' }));
  assert.equal(X.ExperimentalStore.unlockedAtBoot(storage), false, 'a hint from before the id');
  storage.setItem(ACCOUNT_HINT_KEY, JSON.stringify({ name: 'Other', id: B }));
  assert.equal(X.ExperimentalStore.unlockedAtBoot(storage), false, 'that account has it off');
  assert.equal(X.ExperimentalStore.unlockedAtBoot(null), false);
  const throwing = { getItem: () => { throw new Error('SecurityError'); } };
  assert.equal(X.ExperimentalStore.unlockedAtBoot(throwing), false);
});

test('edits are local at once and pushed debounced (or on flush / another pick); an edit during the request stays dirty', async () => {
  const srv = fakeServer();
  const { store, timers } = makeStore(srv);
  const p = store.create('My rules 1', { gravity: 50, nope: 3 });
  assert.equal(typeof p, 'object');
  assert.deepEqual(p.values, { gravity: 50 });
  assert.equal(store.list().at(-1).synced, false);
  assert.equal(srv.calls.length, 0, 'nothing sent yet');
  assert.equal(timers.pending.size, 1);
  assert.equal([...timers.pending.values()][0].ms, X.PUSH_DELAY_MS);
  assert.equal(store.rename(p.id, 'Moon  ball'), true);
  assert.equal(store.update(p.id, { gravity: 40, ballBounce: 120 }), true);
  assert.equal(store.update(p.id, { ballBounce: 120, gravity: 40 }), false, 'the same values: no edit');
  assert.equal(timers.pending.size, 1, 'one debounce for every edit');
  timers.fire();
  await settle();
  await store.flush();
  assert.deepEqual(srv.state(A).presets.map((q) => [q.id, q.name, q.values]), [[p.id, 'Moon ball', { gravity: 40, ballBounce: 120 }]]);
  const listed = store.get(p.id);
  assert.equal(listed.synced, true);
  assert.ok(store.presets()[0].updatedAt > 0, 'the server stamp');
  // An edit while the upload is out: it is not marked clean by the answer of the older version.
  const realUpsert = srv.remote.upsert;
  srv.remote.upsert = async (q) => {
    store.update(p.id, { gravity: 30 });
    return realUpsert(q);
  };
  store.update(p.id, { gravity: 60 });
  await store.flush();
  srv.remote.upsert = realUpsert;
  assert.equal(store.get(p.id).synced, false);
  assert.deepEqual(store.get(p.id).values, { gravity: 30 });
  await store.flush();
  assert.deepEqual(srv.state(A).presets[0].values, { gravity: 30 });
  assert.equal(store.get(p.id).synced, true);
  // Another pick flushes.
  store.update(p.id, { gravity: 50 });
  store.setLastUsed('lowGravity');
  await settle();
  await store.flush();
  assert.deepEqual(srv.state(A).presets[0].values, { gravity: 50 });
  assert.equal(store.lastUsed(), 'lowGravity');
  store.setLastUsed('nonexistent0');
  assert.equal(store.lastUsed(), 'lowGravity', 'an unknown pick is ignored');
  assert.equal(store.rename('lowGravity', 'Mine'), false, 'built-ins are read-only');
  assert.equal(store.update('standard', { gravity: 50 }), false);
});

test('offline edits stay here, say so once, and go up at the next sync; a pull keeps them and takes the rest from the server', async () => {
  const srv = fakeServer();
  const { store, problems } = makeStore(srv);
  const a = store.create('Kept', { gravity: 50 });
  await store.flush();
  srv.online = false;
  store.update(a.id, { gravity: 60 });
  const b = store.create('Offline one');
  await store.flush();
  assert.deepEqual(problems, ['offline']);
  assert.deepEqual(store.presets().map((p) => p.name), ['Kept', 'Offline one']);
  // Meanwhile another device adds one and edits Kept.
  srv.state(A).presets.push({ id: 'ffffffffffff', name: 'From the phone', values: { ballDrag: 0 }, updatedAt: 99 });
  srv.state(A).presets[0] = { ...srv.state(A).presets[0], values: { gravity: 200 }, updatedAt: 100 };
  srv.online = true;
  await store.sync();
  assert.deepEqual(srv.state(A).presets.map((p) => [p.name, p.values]), [['Kept', { gravity: 60 }], ['From the phone', { ballDrag: 0 }], ['Offline one', {}]], 'the last write wins');
  assert.deepEqual(store.presets().map((p) => p.name), ['Kept', 'From the phone', 'Offline one']);
  assert.ok(store.list().every((p) => p.synced));
  // Deleted on another device: gone here at the next pull (it was not dirty).
  srv.state(A).presets = srv.state(A).presets.filter((p) => p.id !== b.id);
  await store.sync();
  assert.deepEqual(store.presets().map((p) => p.name), ['Kept', 'From the phone']);
});

test('the 10-preset cap: a local create past it is refused; a 409 from the account keeps the preset here and tells the UI', async () => {
  const srv = fakeServer();
  const { store, problems } = makeStore(srv);
  for (let i = 1; i <= R.MAX_PRESETS; i++) assert.equal(typeof store.create(`Rules ${i}`), 'object');
  assert.equal(store.create('One too many'), 'full');
  assert.equal(store.duplicate('lowGravity', 'Low gravity #2'), 'full');
  assert.deepEqual(problems, ['full', 'full']);
  await store.flush();
  assert.equal(srv.state(A).presets.length, R.MAX_PRESETS);
  // Another device filled the account while this one created its own.
  const other = makeStore(srv, memStorage());
  other.store.create('Here only');
  await other.store.flush();
  assert.deepEqual(other.problems, ['too_many']);
  assert.equal(other.store.presets().length, 1, 'kept here (dirty) until one is deleted');
  assert.equal(other.store.get(other.store.presets()[0].id).synced, false);
  assert.equal(store.create('Bad (name)'.slice(0, 2)), 'bad_name');
});

test('a preset the server refuses (bad_preset: a client and a server of different versions) stays here, dirty, and goes up once accepted', async () => {
  const srv = fakeServer();
  const { store, problems } = makeStore(srv);
  const kept = store.create('Kept here', { gravity: 50 });
  const fine = store.create('Fine one');
  const realUpsert = srv.remote.upsert;
  srv.remote.upsert = async (p) => {
    if (p.id === kept.id) {
      srv.calls.push('upsert');
      throw Object.assign(new Error('bad_preset'), { code: 'bad_preset', status: 400 });
    }
    return realUpsert(p);
  };
  await store.sync();
  assert.deepEqual(srv.state(A).presets.map((p) => p.name), ['Fine one'], 'the other one still goes up');
  assert.deepEqual(store.presets().map((p) => p.name), ['Fine one', 'Kept here'], 'the pull does not delete the refused one (the account\'s first, then the ones only here)');
  assert.equal(store.get(kept.id).synced, false);
  assert.equal(store.get(fine.id).synced, true);
  assert.deepEqual(problems, []);
  srv.remote.upsert = realUpsert;
  await store.sync();
  assert.deepEqual(srv.state(A).presets.map((p) => p.name).sort(), ['Fine one', 'Kept here']);
  assert.ok(store.list().every((p) => p.synced));
});

test('duplicate copies any preset (a built-in too); delete needs the server, offline it is refused and nothing changes', async () => {
  const srv = fakeServer();
  const { store, problems } = makeStore(srv);
  const copy = store.duplicate('arcade', 'Arcade #2');
  assert.deepEqual(copy.values, R.BUILT_IN_PRESETS.find((p) => p.id === 'arcade').values);
  assert.equal(store.duplicate('nothing', 'x y z'), 'unknown');
  await store.flush();
  store.setLastUsed(copy.id);
  srv.online = false;
  assert.equal(await store.remove(copy.id), false);
  assert.deepEqual(problems, ['delete_offline']);
  assert.equal(store.presets().length, 1);
  srv.online = true;
  assert.equal(await store.remove(copy.id), true);
  assert.equal(store.presets().length, 0);
  assert.equal(srv.state(A).presets.length, 0);
  assert.equal(store.lastUsed(), 'standard', 'the deleted pick goes too');
  assert.equal(await store.remove('arcade'), false, 'a built-in cannot be deleted');
});

test('corrupt or unavailable storage: ignored on read, the copy lives in memory, the UI never sees garbage', async () => {
  const srv = fakeServer();
  const storage = memStorage();
  storage.setItem(X.experimentalKey(A), '{not json');
  const { store } = makeStore(srv, storage);
  assert.equal(store.enabled(), false);
  assert.deepEqual(store.presets(), []);
  storage.setItem(X.experimentalKey(A), JSON.stringify({ enabled: 'yes', presets: [{ id: 'nope', name: 'x' }, { id: '0123456789ab', name: 'Fine', values: { gravity: 1e9 } }], dirty: ['gone', 5], lastUsed: '__proto__' }));
  assert.equal(store.enabled(), false);
  assert.deepEqual(store.presets(), [{ id: '0123456789ab', name: 'Fine', values: { gravity: 200 }, updatedAt: 0 }]);
  assert.equal(store.lastUsed(), 'standard');
  // A storage that refuses writes (a full quota): the page keeps working from memory.
  const full = { getItem: storage.getItem, setItem: () => { throw new Error('QuotaExceededError'); } };
  const mem = makeStore(srv, full).store;
  mem.setEnabled(true);
  assert.equal(mem.enabled(), true);
  const p = mem.create('In memory');
  assert.equal(mem.get(p.id).name, 'In memory');
  const parsed = X.parseExperimentalCache({ enabled: true, enabledDirty: 1, presets: 'x', dirty: {}, lastUsed: 7 });
  assert.deepEqual(parsed, { enabled: true, enabledDirty: false, presets: [], dirty: [], lastUsed: null });
});

test('two tabs of one account share the copy through storage, and the account through sync', async () => {
  const srv = fakeServer();
  const storage = memStorage();
  const tab1 = makeStore(srv, storage).store;
  const tab2 = makeStore(srv, storage).store;
  tab1.create('From tab 1', { gravity: 50 });
  assert.equal(tab2.presets()[0].name, 'From tab 1', 'the same browser: the same copy');
  await tab1.flush();
  const device2 = makeStore(srv, memStorage()).store;
  assert.equal(device2.presets().length, 0);
  await device2.sync();
  assert.deepEqual(device2.presets().map((p) => [p.name, p.values]), [['From tab 1', { gravity: 50 }]]);
});

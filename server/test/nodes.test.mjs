// Community nodes on the Worker's side, without workerd: the nodes config helpers of
// server/src/env.ts on a fake KV, and the NodeRegistryDO's address and internal contract
// (server/src/nodeApi.ts). Nothing in the Worker calls this code yet.
// Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const DO_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: DO_STUB, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND') {
        if (!/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
        if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
});

const E = await import('../src/env.ts');
const API = await import('../src/nodeApi.ts');
const { PROTOCOL_VERSION } = await import('../../src/net/protocol.ts');
const { ROCKETSIM_WASM_SHA256 } = await import('../../src/sim/wasm/rocketsim.sha256.ts');

const A = 'a1b2c3d4e5f60718';
const B = '0123456789abcdef';
const C = 'fedcba9876543210';

// ---- env.ts: flags and nodes config --------------------------------------------------------------

/** A FLAGS namespace holding `values` (an Error value makes its read throw); `reads` records each get(). */
function kv(values) {
  const reads = [];
  return {
    reads,
    FLAGS: {
      async get(name, opts) {
        reads.push({ name, opts });
        const v = values[name];
        if (v instanceof Error) throw v;
        return v ?? null;
      },
    },
  };
}

test('flag: 1, true and on turn a flag on; any other value, a missing key or a KV failure is off', async () => {
  for (const v of ['1', 'true', 'on']) assert.equal(await E.flag(kv({ f: v }), 'f'), true, v);
  for (const v of ['0', 'false', 'off', 'yes', '']) assert.equal(await E.flag(kv({ f: v }), 'f'), false, JSON.stringify(v));
  assert.equal(await E.flag(kv({}), 'f'), false);
  assert.equal(await E.flag(kv({ f: new Error('kv down') }), 'f'), false);
});

test('nodesMode: nodes_on absent or 0 is off, 1 is all, a list of account ids is a canary', async () => {
  assert.equal(await E.nodesMode(kv({})), 'off');
  assert.equal(await E.nodesMode(kv({ nodes_on: '0' })), 'off');
  assert.equal(await E.nodesMode(kv({ nodes_on: '1' })), 'all');
  assert.equal(await E.nodesMode(kv({ nodes_on: ' 1\n' })), 'all', 'blanks around the value do not matter');
  assert.deepEqual(await E.nodesMode(kv({ nodes_on: A })), new Set([A]));
  assert.deepEqual(await E.nodesMode(kv({ nodes_on: ` ${A}, ${B} ,${A},` })), new Set([A, B]));
  const flags = kv({ nodes_on: '1' });
  await E.nodesMode(flags);
  assert.deepEqual(flags.reads.map((r) => [r.name, r.opts.cacheTtl]).sort(), [['nodes_on', 60], ['vm_disabled', 60]]);
});

test('nodesMode fails closed: anything but 1 or a list holding an account id is off', async () => {
  const bad = ['', ' ', ',', 'true', 'on', 'yes', 'all', '2', A.toUpperCase(), A.slice(1), A + '0', `${A};${B}`];
  for (const v of bad) assert.equal(await E.nodesMode(kv({ nodes_on: v })), 'off', JSON.stringify(v));
  assert.deepEqual(await E.nodesMode(kv({ nodes_on: `${A},nope,${B.toUpperCase()},${C}` })), new Set([A, C]), 'a malformed entry is dropped, the valid ones stay');
  assert.equal(await E.nodesMode(kv({ nodes_on: new Error('kv down') })), 'off');
});

test('nodesMode: vm_disabled turns the nodes off whatever nodes_on says', async () => {
  for (const on of ['1', `${A},${B}`]) {
    for (const v of ['1', 'true', 'on']) assert.equal(await E.nodesMode(kv({ nodes_on: on, vm_disabled: v })), 'off', `${on} / ${v}`);
  }
  assert.equal(await E.nodesMode(kv({ nodes_on: '1', vm_disabled: '0' })), 'all');
});

test('nodesAllowed: everybody, nobody, or a canary that must hold every human of the match', () => {
  assert.equal(E.nodesAllowed('all', [A, C]), true);
  assert.equal(E.nodesAllowed('off', [A]), false);
  const canary = new Set([A, B]);
  assert.equal(E.nodesAllowed(canary, [A]), true);
  assert.equal(E.nodesAllowed(canary, [B, A]), true);
  assert.equal(E.nodesAllowed(canary, [A, C]), false, 'one player outside the canary keeps the match off the nodes');
  assert.equal(E.nodesAllowed(canary, []), false);
});

test('trustedOperatorIds: the account ids in NODE_TRUSTED_OPERATORS; an entry that is not one trusts nobody', () => {
  assert.deepEqual(E.trustedOperatorIds({}), new Set());
  assert.deepEqual(E.trustedOperatorIds({ NODE_TRUSTED_OPERATORS: '' }), new Set());
  assert.deepEqual(E.trustedOperatorIds({ NODE_TRUSTED_OPERATORS: ` ${A} ,${B},${A}\n` }), new Set([A, B]));
  assert.deepEqual(E.trustedOperatorIds({ NODE_TRUSTED_OPERATORS: `${A.toUpperCase()},${A}0,${A.slice(1)},Proyecto,*,${C}` }), new Set([C]));
});

test('nodesConfigured: the NodeRegistryDO, both buckets and both halves of the control key', () => {
  const full = { NODES: {}, NODE_REPLAYS: {}, NODE_RELEASES: {}, NODE_CONTROL_PRIVATE_KEY: 'priv', NODE_CONTROL_PUBLIC_KEY: 'pub' };
  assert.equal(E.nodesConfigured(full), true);
  for (const k of Object.keys(full)) {
    const rest = { ...full };
    delete rest[k];
    assert.equal(E.nodesConfigured(rest), false, 'without ' + k);
  }
  assert.equal(E.nodesConfigured({ ...full, NODE_CONTROL_PRIVATE_KEY: '' }), false, 'an empty secret is no key');
  assert.equal(E.nodesConfigured({}), false, 'a fork or a test env without any of them');
});

// ---- nodeApi.ts ------------------------------------------------------------------------------------

test('nodesStub: the one NodeRegistryDO, nodes-v1, created near São Paulo', () => {
  const seen = [];
  const NODES = { idFromName: (name) => ({ name }), get: (id, opts) => (seen.push({ id, opts }), { stub: true }) };
  assert.deepEqual(API.nodesStub({ NODES }), { stub: true });
  assert.deepEqual(seen, [{ id: { name: 'nodes-v1' }, opts: { locationHint: 'sam' } }]);
});

test('CLIENT_BUILD: the protocol and the committed wasm hash of the web client', () => {
  assert.deepEqual(API.CLIENT_BUILD, { version: E.SERVER_VERSION, protocol: PROTOCOL_VERSION, wasmSha256: ROCKETSIM_WASM_SHA256 });
  assert.match(API.CLIENT_BUILD.wasmSha256, /^[0-9a-f]{64}$/);
});

test('internal contract: refusals answer 404, 410 or 503; a node lock holds while its match is played or reported and the player stays', () => {
  assert.deepEqual(API.NODE_ROUTES, { place: '/internal/place', rejoin: '/internal/rejoin', leave: '/internal/leave', status: '/internal/status' });
  assert.deepEqual(API.REJOIN_STATUS, { no_match: 404, not_in_match: 404, left: 410, match_over: 410, offline: 503 });
  assert.deepEqual(API.LEAVE_STATUS, { no_match: 404, not_in_match: 404, match_over: 410, offline: 503 });
  for (const state of ['assigned', 'reporting']) {
    assert.equal(API.nodeLockHeld({ state, left: false }), true, state);
    assert.equal(API.nodeLockHeld({ state, left: true }), false, state + ', left');
  }
  for (const state of ['verifying', 'done']) assert.equal(API.nodeLockHeld({ state, left: false }), false, state);
});

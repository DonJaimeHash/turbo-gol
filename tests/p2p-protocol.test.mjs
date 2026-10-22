// Round trips of every P2P mesh packet (src/net/p2p/protocol.ts): Input, Hash, StateRequest,
// StateResponse, plus the malformed-frame rejections the receivers rely on.
//   node --test tests/p2p-protocol.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
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

const P = await import('../src/net/p2p/protocol.ts');
const { PACKED_INPUT_BYTES } = await import('../src/sim/types.ts');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPacked(count, seed) {
  const r = rng(seed);
  const out = new Int8Array(count * PACKED_INPUT_BYTES);
  for (let i = 0; i < out.length; i++) out[i] = Math.floor(r() * 256) - 128;
  return out;
}

test('constants: header sizes and message ids match the layouts', () => {
  assert.equal(P.P2P_PROTOCOL_VERSION, 5, 'v5: experimental rules (RoomWelcome.physics, the ready physicsFp) and the mutator wasm (v4: the bots; v3: the rounded goals; v2: signal_dropped, RoomSlot.left, no-show peerLeft, start waits for absent slots, p2pProtocol in the queue)');
  assert.equal(P.ROOM_ERROR_PHYSICS_MISMATCH, 'physics_mismatch');
  assert.equal(P.P2P_ERROR_BAD_PHYSICS, 'bad_physics');
  assert.equal(P.P2P_ERROR_RELOAD, 'reload_required');
  assert.equal(P.P2P_ERROR_NO_SHOW, 'no_show');
  assert.equal(P.ROOM_ERROR_SIGNAL_DROPPED, 'signal_dropped');
  assert.equal(P.P2P_NO_SHOW_MS, 6000);
  assert.equal(P.INPUT_HDR, 14);
  assert.equal(P.HASH_LEN, 9);
  assert.equal(P.STATE_RESP_HDR, 11);
  assert.deepEqual([P.P2pMsg.Input, P.P2pMsg.Hash, P.P2pMsg.StateRequest, P.P2pMsg.StateResponse], [1, 2, 3, 4]);
  assert.equal(P.P2P_INPUT_MAX_BATCH, 16);
  assert.equal(P.P2P_HASH_EVERY, 30);
  assert.ok(P.P2P_INPUT_DELAY_DEFAULT >= 0 && P.P2P_WINDOW_DEFAULT > P.P2P_INPUT_DELAY_DEFAULT);
});

test('Input: round trip of 1..16 ticks with negative bytes, u32 ticks and an offset source', () => {
  const buf = new Uint8Array(P.INPUT_HDR + P.P2P_INPUT_MAX_BATCH * PACKED_INPUT_BYTES);
  const pkt = { firstTick: 0, count: 0, ackTick: 0, myTick: 0, packed: new Int8Array(P.P2P_INPUT_MAX_BATCH * PACKED_INPUT_BYTES) };
  for (let count = 1; count <= P.P2P_INPUT_MAX_BATCH; count++) {
    const src = randomPacked(count + 2, count);
    const off = 2 * PACKED_INPUT_BYTES;
    const firstTick = 0xfffffff0 - count;
    const n = P.encodeP2pInput(buf, firstTick, count, 123456, 0x80000001, src, off);
    assert.equal(n, P.INPUT_HDR + count * PACKED_INPUT_BYTES);
    assert.equal(buf[0], P.P2pMsg.Input);
    assert.equal(P.p2pMsgType(buf), P.P2pMsg.Input);
    pkt.packed.fill(0);
    assert.ok(P.decodeP2pInput(buf.subarray(0, n), pkt), `count ${count} decodes`);
    assert.equal(pkt.firstTick, firstTick);
    assert.equal(pkt.count, count);
    assert.equal(pkt.ackTick, 123456);
    assert.equal(pkt.myTick, 0x80000001);
    for (let i = 0; i < count * PACKED_INPUT_BYTES; i++) assert.equal(pkt.packed[i], src[off + i], `byte ${i} of count ${count}`);
  }
});

test('Input: a frame with extra trailing bytes decodes; count 0 / 17, a short frame and a wrong type are rejected', () => {
  const buf = new Uint8Array(P.INPUT_HDR + P.P2P_INPUT_MAX_BATCH * PACKED_INPUT_BYTES + 8);
  const pkt = { firstTick: 0, count: 0, ackTick: 0, myTick: 0, packed: new Int8Array(P.P2P_INPUT_MAX_BATCH * PACKED_INPUT_BYTES) };
  const src = randomPacked(4, 9);
  const n = P.encodeP2pInput(buf, 10, 4, 8, 12, src, 0);
  assert.ok(P.decodeP2pInput(buf, pkt), 'trailing bytes are ignored');
  assert.equal(pkt.count, 4);
  assert.equal(P.decodeP2pInput(buf.subarray(0, n - 1), pkt), false, 'one byte short');
  assert.equal(P.decodeP2pInput(buf.subarray(0, P.INPUT_HDR - 1), pkt), false, 'header short');
  buf[5] = 0;
  assert.equal(P.decodeP2pInput(buf, pkt), false, 'count 0');
  buf[5] = P.P2P_INPUT_MAX_BATCH + 1;
  assert.equal(P.decodeP2pInput(buf, pkt), false, 'count above the cap');
  buf[5] = 4;
  buf[0] = P.P2pMsg.Hash;
  assert.equal(P.decodeP2pInput(buf, pkt), false, 'wrong message type');
});

test('Hash: round trip incl. 0 and 0xffffffff; short / wrong type rejected', () => {
  const buf = new Uint8Array(P.HASH_LEN + 3);
  const out = { tick: -1, hash: -1 };
  for (const [tick, hash] of [
    [30, 0],
    [60, 0xffffffff],
    [0x7fffffff, 0x811c9dc5],
    [4294967295, 1],
  ]) {
    const n = P.encodeHash(buf, tick, hash);
    assert.equal(n, P.HASH_LEN);
    assert.equal(P.p2pMsgType(buf), P.P2pMsg.Hash);
    assert.ok(P.decodeHash(buf, out));
    assert.equal(out.tick, tick);
    assert.equal(out.hash, hash);
  }
  assert.equal(P.decodeHash(buf.subarray(0, P.HASH_LEN - 1), out), false);
  buf[0] = P.P2pMsg.Input;
  assert.equal(P.decodeHash(buf, out), false);
});

test('StateRequest: 5 bytes, type 3, little-endian u32 tick', () => {
  const buf = new Uint8Array(8);
  const n = P.encodeStateRequest(buf, 0x01020304);
  assert.equal(n, 5);
  assert.equal(P.p2pMsgType(buf), P.P2pMsg.StateRequest);
  assert.deepEqual([...buf.subarray(0, 5)], [3, 0x04, 0x03, 0x02, 0x01]);
  assert.equal(new DataView(buf.buffer).getUint32(1, true), 0x01020304);
});

test('StateResponse: round trip of a 3321-byte blob (view into the frame), truncated / wrong type rejected', () => {
  const blob = new Uint8Array(4096);
  const r = rng(5);
  for (let i = 0; i < blob.length; i++) blob[i] = Math.floor(r() * 256);
  const len = 3321;
  const buf = new Uint8Array(P.STATE_RESP_HDR + 4096);
  const n = P.encodeStateResponse(buf, 900, 0xdeadbeef, blob, len);
  assert.equal(n, P.STATE_RESP_HDR + len);
  assert.equal(P.p2pMsgType(buf), P.P2pMsg.StateResponse);
  const out = { tick: 0, len: 0, hash: 0, blob: new Uint8Array(0) };
  assert.ok(P.decodeStateResponse(buf.subarray(0, n), out));
  assert.equal(out.tick, 900);
  assert.equal(out.len, len);
  assert.equal(out.hash, 0xdeadbeef);
  assert.equal(out.blob.length, len);
  for (let i = 0; i < len; i++) if (out.blob[i] !== blob[i]) assert.fail(`blob byte ${i}`);
  assert.equal(out.blob.buffer, buf.buffer, 'the blob is a view into the frame');
  assert.equal(P.decodeStateResponse(buf.subarray(0, n - 1), out), false, 'truncated blob');
  assert.equal(P.decodeStateResponse(buf.subarray(0, P.STATE_RESP_HDR - 1), out), false, 'short header');
  buf[0] = P.P2pMsg.Hash;
  assert.equal(P.decodeStateResponse(buf.subarray(0, n), out), false, 'wrong type');
});

test('StateRequest decode and the confirmed-timeline trailer of a StateResponse: round trip, absent, truncated, oversized', () => {
  const req = new Uint8Array(P.STATE_REQ_LEN);
  P.encodeStateRequest(req, 777);
  const q = { tick: 0 };
  assert.ok(P.decodeStateRequest(req, q));
  assert.equal(q.tick, 777);
  assert.equal(P.decodeStateRequest(req.subarray(0, 4), q), false);

  const r = rng(11);
  const sim = new Uint8Array(3321);
  for (let i = 0; i < sim.length; i++) sim[i] = Math.floor(r() * 256);
  const floats = Float64Array.from({ length: 300 }, (_, i) => (i % 7 === 0 ? -1e9 + i : i % 5 === 0 ? Infinity : i * 1.25 - 3));
  const buf = new Uint8Array(P.STATE_RESP_HDR + sim.length + P.stateTrailerBytes(300));
  let len = P.encodeStateResponse(buf, 900, 0xdeadbeef, sim, sim.length);
  len = P.encodeStateTrailer(buf, len, floats, 0, 300);
  P.setStateResponseLen(buf, len - P.STATE_RESP_HDR);
  assert.equal(len, P.STATE_RESP_HDR + sim.length + 300 * 8 + P.STATE_TRAILER_FOOTER);
  const out = { tick: 0, len: 0, hash: 0, blob: new Uint8Array(0) };
  assert.ok(P.decodeStateResponse(buf.subarray(0, len), out));
  assert.equal(out.len, sim.length + P.stateTrailerBytes(300));
  const got = new Float64Array(400);
  const split = { simLen: 0, count: 0 };
  P.splitStateTrailer(out.blob, out.len, got, split);
  assert.deepEqual(split, { simLen: sim.length, count: 300 });
  for (let i = 0; i < 300; i++) assert.equal(got[i], floats[i], `float ${i}`);
  for (let i = 0; i < sim.length; i++) if (out.blob[i] !== sim[i]) assert.fail(`sim byte ${i}`);
  // Offset source: floats 100.. of the same array.
  let len2 = P.encodeStateResponse(buf, 900, 1, sim, 10);
  len2 = P.encodeStateTrailer(buf, len2, floats, 100, 3);
  P.setStateResponseLen(buf, len2 - P.STATE_RESP_HDR);
  assert.ok(P.decodeStateResponse(buf.subarray(0, len2), out));
  P.splitStateTrailer(out.blob, out.len, got, split);
  assert.deepEqual([split.simLen, split.count, got[0], got[1], got[2]], [10, 3, floats[100], floats[101], floats[102]]);
  // No trailer: the whole blob is the sim part.
  const plain = P.encodeStateResponse(buf, 1, 2, sim, 50);
  assert.ok(P.decodeStateResponse(buf.subarray(0, plain), out));
  P.splitStateTrailer(out.blob, out.len, got, split);
  assert.deepEqual(split, { simLen: 50, count: 0 });
  // A count larger than the receiver's capacity, or than the blob, is treated as no trailer.
  const tiny = new Float64Array(2);
  let len3 = P.encodeStateResponse(buf, 1, 2, sim, 10);
  len3 = P.encodeStateTrailer(buf, len3, floats, 0, 3);
  P.setStateResponseLen(buf, len3 - P.STATE_RESP_HDR);
  assert.ok(P.decodeStateResponse(buf.subarray(0, len3), out));
  P.splitStateTrailer(out.blob, out.len, tiny, split);
  assert.deepEqual(split, { simLen: out.len, count: 0 }, 'capacity exceeded');
  const forged = Uint8Array.from(out.blob);
  forged[forged.length - 4] = 200; // claims 200 floats in a 10 + 28 byte blob
  P.splitStateTrailer(forged, forged.length, got, split);
  assert.deepEqual(split, { simLen: forged.length, count: 0 }, 'oversized count');
});

test('an empty-length StateResponse and a zero-length frame', () => {
  const buf = new Uint8Array(P.STATE_RESP_HDR);
  const n = P.encodeStateResponse(buf, 1, 2, new Uint8Array(0), 0);
  assert.equal(n, P.STATE_RESP_HDR);
  const out = { tick: 0, len: 0, hash: 0, blob: new Uint8Array(0) };
  assert.ok(P.decodeStateResponse(buf, out));
  assert.equal(out.len, 0);
  assert.equal(out.blob.length, 0);
  const empty = new Uint8Array(0);
  const pkt = { firstTick: 0, count: 0, ackTick: 0, myTick: 0, packed: new Int8Array(P.P2P_INPUT_MAX_BATCH * PACKED_INPUT_BYTES) };
  assert.equal(P.decodeP2pInput(empty, pkt), false);
  assert.equal(P.decodeHash(empty, { tick: 0, hash: 0 }), false);
  assert.equal(P.decodeStateResponse(empty, out), false);
});

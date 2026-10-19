// The dependency-free WebSocket server against Node's built-in (WHATWG / undici) WebSocket client.
import '../dev/ts-resolve.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';

const { startHttp } = await import('../node/http.ts');
const { acceptUpgrade, offeredProtocols, rejectUpgrade } = await import('../node/wsServer.ts');

async function echoServer(opts = {}) {
  const conns = [];
  const srv = await startHttp(0, '127.0.0.1', {
    onRequest(_req, res) {
      res.writeHead(200);
      res.end('ok');
    },
    onUpgrade(req, socket, head) {
      if (req.url === '/reject') return rejectUpgrade(socket, 403, 'nope');
      const offered = offeredProtocols(req);
      const ws = acceptUpgrade(req, socket, head, { protocol: offered.includes('tg1') ? 'tg1' : null, maxMessageBytes: opts.max ?? 1024 });
      if (!ws) return;
      conns.push(ws);
      ws.onmessage = (data, text) => {
        if (text && new TextDecoder().decode(data) === 'close-me') return ws.close(4001, 'asked');
        ws.send(text ? new TextDecoder().decode(data) : data);
      };
    },
  });
  return { srv, conns, url: `ws://127.0.0.1:${srv.port}` };
}

function open(url, protocols) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('ws error ' + (e?.message ?? '')));
  });
}

function next(ws) {
  return new Promise((resolve) => {
    ws.onmessage = (ev) => resolve(ev.data);
  });
}

function closed(ws) {
  return new Promise((resolve) => {
    ws.onclose = (ev) => resolve({ code: ev.code, reason: ev.reason });
  });
}

test('handshake, subprotocol, text and binary echo, large frames', async () => {
  const { srv, url } = await echoServer({ max: 200_000 });
  try {
    const ws = await open(url, ['tg1', 'ticket.abc']);
    assert.equal(ws.protocol, 'tg1');
    ws.send('hola');
    assert.equal(await next(ws), 'hola');
    const bin = new Uint8Array([1, 2, 3, 250]);
    ws.send(bin);
    assert.deepEqual([...new Uint8Array(await next(ws))], [1, 2, 3, 250]);
    const big = new Uint8Array(70_000).map((_, i) => i & 0xff); // 64-bit length path
    ws.send(big);
    const back = new Uint8Array(await next(ws));
    assert.equal(back.length, big.length);
    assert.equal(back[69_999], 69_999 & 0xff);
    const mid = 'x'.repeat(300); // 16-bit length path
    ws.send(mid);
    assert.equal(await next(ws), mid);
    const c = closed(ws);
    ws.close(1000, 'bye');
    assert.equal((await c).code, 1000);
  } finally {
    await srv.close();
  }
});

test('server-initiated close carries code and reason', async () => {
  const { srv, url } = await echoServer();
  try {
    const ws = await open(url);
    const c = closed(ws);
    ws.send('close-me');
    const r = await c;
    assert.equal(r.code, 4001);
    assert.equal(r.reason, 'asked');
  } finally {
    await srv.close();
  }
});

test('oversized message closes with 1009, rejected upgrade fails to open', async () => {
  const { srv, url } = await echoServer({ max: 100 });
  try {
    const ws = await open(url);
    const c = closed(ws);
    ws.send(new Uint8Array(500));
    assert.equal((await c).code, 1009);
    await assert.rejects(open(url + '/reject'));
  } finally {
    await srv.close();
  }
});

test('an unmasked client frame is a protocol error', async () => {
  const { srv } = await echoServer();
  try {
    const sock = connect(srv.port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    sock.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
    let got = Buffer.alloc(0);
    sock.on('data', (d) => (got = Buffer.concat([got, d])));
    await new Promise((r) => setTimeout(r, 100));
    assert.match(got.toString('latin1'), /101 Switching Protocols/);
    assert.match(got.toString('latin1'), /s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/); // RFC 6455 sample accept key
    sock.write(Buffer.from([0x82, 0x01, 0x07])); // binary, NOT masked
    await new Promise((r) => sock.once('close', r));
    const tail = got.subarray(got.indexOf('\r\n\r\n') + 4);
    assert.equal(tail[0], 0x88); // close frame
    assert.equal((tail[2] << 8) | tail[3], 1002);
  } finally {
    await srv.close();
  }
});

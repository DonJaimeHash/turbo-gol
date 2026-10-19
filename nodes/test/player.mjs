// A scripted player that speaks the real client <-> host protocol (src/net/protocol.ts) over Node's
// built-in WebSocket: Welcome -> Ready, inputs a few ticks ahead of every snapshot, events kept.
import { T, P } from './helpers.mjs';

export function connectPlayer({ wsUrl, ticket, steerPhase = 0 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, [P.WS_SUBPROTOCOL, P.WS_TICKET_PREFIX + ticket]);
    ws.binaryType = 'arraybuffer';
    const snap = { tick: 0, lastInputTick: 0, bufferHint: 0, numCars: 0, inputs: new Int8Array(64), stateLen: 0, state: new Uint8Array(0), stateHash: 0 };
    const st = {
      ws,
      welcome: null,
      events: [],
      snapshots: 0,
      lastTick: 0,
      closed: null,
      ended: null,
      cancelled: null,
      protocol: ws.protocol,
      close: () => ws.close(1000, 'bye'),
    };
    const out = new Uint8Array(P.INPUT_HEADER + 6 * T.PACKED_INPUT_BYTES);
    const packed = new Int8Array(6 * T.PACKED_INPUT_BYTES);
    const c = T.emptyControls();
    ws.onopen = () => {
      st.protocol = ws.protocol;
    };
    ws.onmessage = (ev) => {
      const buf = new Uint8Array(ev.data);
      switch (buf[0]) {
        case P.MsgType.Welcome:
          st.welcome = P.decodeJson(buf);
          ws.send(P.encodeJson(P.MsgType.Ready, {}));
          resolve(st);
          return;
        case P.MsgType.Snapshot: {
          if (!P.decodeSnapshot(buf, snap)) return;
          st.snapshots++;
          st.lastTick = snap.tick;
          const first = snap.tick + 1;
          for (let i = 0; i < 6; i++) {
            const tick = first + i;
            c.throttle = 1;
            c.steer = Math.sin((tick + steerPhase) / 45);
            c.boost = tick % 200 < 60;
            c.jump = tick % 300 < 6;
            T.packControls(c, packed, i * T.PACKED_INPUT_BYTES);
          }
          const len = P.encodeInput(out, first, 6, snap.tick, packed, 0);
          if (ws.readyState === WebSocket.OPEN) ws.send(out.subarray(0, len));
          return;
        }
        case P.MsgType.Event: {
          const e = P.decodeJson(buf);
          st.events.push(e);
          if (e.type === 'ended') st.ended = e;
          if (e.type === 'cancelled') st.cancelled = e;
          return;
        }
        default:
          return;
      }
    };
    ws.onclose = (ev) => {
      st.closed = { code: ev.code, reason: ev.reason };
      if (!st.welcome) reject(new Error(`closed before welcome: ${ev.code} ${ev.reason}`));
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  });
}

export async function waitFor(fn, timeoutMs = 20_000, stepMs = 50) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function freePort() {
  return import('node:net').then(
    ({ createServer }) =>
      new Promise((resolve) => {
        const s = createServer();
        s.listen(0, '127.0.0.1', () => {
          const p = s.address().port;
          s.close(() => resolve(p));
        });
      }),
  );
}

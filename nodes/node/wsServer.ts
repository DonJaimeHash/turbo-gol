/**
 * Minimal WebSocket server (RFC 6455) on top of node:http's 'upgrade' event. No dependencies: the
 * node program ships as one bundle + rocketsim.wasm, which keeps the operator's install small and
 * the supply chain short (nothing from npm runs on a community machine).
 *
 * Scope: what browsers and Node's built-in WebSocket client send. No extensions (permessage-deflate
 * is offered by clients and simply not accepted), text and binary messages, fragmentation, ping /
 * pong, the closing handshake, size limits and a slow-consumer guard. Server frames are unmasked,
 * client frames must be masked (else close 1002).
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CLOSE_TIMEOUT_MS = 2_000;
const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  410: 'Gone',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export interface WsOptions {
  /** Subprotocol to answer with (it must be among the offered ones); null / undefined = none. */
  protocol?: string | null;
  /** Largest accepted message after reassembly (bytes); larger closes with 1009. */
  maxMessageBytes?: number;
  /** Close a peer whose unsent backlog exceeds this (bytes) with 1008 'slow'. */
  maxBufferedBytes?: number;
  /** Client IP (already resolved by the caller, see clientIp()). */
  remoteAddress?: string;
}

export interface WsConn {
  readonly remoteAddress: string;
  readonly protocol: string;
  readonly open: boolean;
  /** Bytes written to the socket but not flushed yet. */
  readonly bufferedAmount: number;
  /** Total payload bytes sent (egress accounting). */
  readonly bytesSent: number;
  onmessage: ((data: Uint8Array, text: boolean) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
}

/** The subprotocols the client offered, in order. */
export function offeredProtocols(req: IncomingMessage): string[] {
  const raw = req.headers['sec-websocket-protocol'];
  const s = Array.isArray(raw) ? raw.join(',') : raw ?? '';
  return s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * The client's address. Behind the local reverse proxy (Caddy on the same machine) the TCP peer is
 * loopback and the real address is the last hop of X-Forwarded-For; from anywhere else the header
 * is ignored (it would be spoofable).
 */
export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? '';
  const loop = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (loop) {
    const xff = req.headers['x-forwarded-for'];
    const s = Array.isArray(xff) ? xff[xff.length - 1] : xff;
    if (s) {
      const parts = s.split(',');
      const last = parts[parts.length - 1].trim();
      if (last) return last;
    }
  }
  return peer;
}

/** Answer an upgrade with a plain HTTP error (JSON body) and drop the socket. */
export function rejectUpgrade(socket: Socket, status: number, code: string, message?: string): void {
  const body = JSON.stringify({ error: code, ...(message ? { message } : {}) });
  try {
    socket.write(
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nContent-Type: application/json\r\nContent-Length: ${new TextEncoder().encode(body).length}\r\nConnection: close\r\n\r\n${body}`,
    );
  } catch {
    /* already gone */
  }
  socket.destroy();
}

/** Validate the handshake headers; null when they are fine, else the reason. */
export function handshakeError(req: IncomingMessage): string | null {
  if (req.method !== 'GET') return 'method';
  const up = req.headers.upgrade;
  if (typeof up !== 'string' || up.toLowerCase() !== 'websocket') return 'upgrade header';
  if (req.headers['sec-websocket-version'] !== '13') return 'version';
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key.trim())) return 'key';
  return null;
}

/**
 * Complete the handshake on `socket` (the caller already decided to accept: auth done) and return
 * the connection. `head` is the first chunk of frames that arrived with the request, if any.
 */
export function acceptUpgrade(req: IncomingMessage, socket: Socket, head: Uint8Array, opts: WsOptions = {}): WsConn | null {
  const bad = handshakeError(req);
  if (bad) {
    rejectUpgrade(socket, 400, 'bad_handshake', bad);
    return null;
  }
  const key = String(req.headers['sec-websocket-key']).trim();
  const accept = createHash('sha1')
    .update(key + GUID)
    .digest('base64');
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`];
  if (opts.protocol) lines.push(`Sec-WebSocket-Protocol: ${opts.protocol}`);
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  socket.setNoDelay(true);
  const conn = new Connection(socket, opts);
  if (head && head.length > 0) conn.feed(head);
  return conn;
}

const textDecoder = new TextDecoder('utf-8', { fatal: true });
const textEncoder = new TextEncoder();

class Connection implements WsConn {
  readonly remoteAddress: string;
  readonly protocol: string;
  onmessage: ((data: Uint8Array, text: boolean) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  bytesSent = 0;

  private readonly socket: Socket;
  private readonly maxMessage: number;
  private readonly maxBuffered: number;
  private buf = new Uint8Array(0);
  private fragments: Uint8Array[] = [];
  private fragmentBytes = 0;
  private fragmentText = false;
  private isOpen = true;
  private closeSent = false;
  private finalized = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(socket: Socket, opts: WsOptions) {
    this.socket = socket;
    this.protocol = opts.protocol ?? '';
    this.remoteAddress = opts.remoteAddress ?? socket.remoteAddress ?? '';
    this.maxMessage = opts.maxMessageBytes ?? 64 * 1024;
    this.maxBuffered = opts.maxBufferedBytes ?? 4 * 1024 * 1024;
    socket.on('data', (chunk: Uint8Array) => this.feed(chunk));
    socket.on('close', () => this.finalize(1006, ''));
    socket.on('end', () => this.finalize(1006, ''));
    socket.on('error', () => {
      /* 'close' follows */
    });
  }

  get open(): boolean {
    return this.isOpen;
  }

  get bufferedAmount(): number {
    return this.socket.writableLength;
  }

  send(data: Uint8Array | string): void {
    if (!this.isOpen || this.closeSent) return;
    if (this.socket.writableLength > this.maxBuffered) {
      this.fail(1008, 'slow');
      return;
    }
    const text = typeof data === 'string';
    const payload = text ? textEncoder.encode(data) : data;
    this.writeFrame(text ? 0x1 : 0x2, payload);
    this.bytesSent += payload.length;
  }

  close(code = 1000, reason = ''): void {
    if (this.finalized || this.closeSent) return;
    this.sendClose(code, reason);
    this.isOpen = false;
    this.closeTimer = setTimeout(() => this.finalize(code, reason), CLOSE_TIMEOUT_MS);
  }

  /** Bytes from the socket (and the upgrade's `head`). */
  feed(chunk: Uint8Array): void {
    if (this.finalized) return;
    if (this.buf.length === 0) this.buf = new Uint8Array(chunk);
    else {
      const next = new Uint8Array(this.buf.length + chunk.length);
      next.set(this.buf);
      next.set(chunk, this.buf.length);
      this.buf = next;
    }
    let off = 0;
    for (;;) {
      const used = this.parseFrame(off);
      if (used <= 0) break;
      off += used;
      if (this.finalized) return;
    }
    this.buf = off === 0 ? this.buf : this.buf.slice(off);
  }

  /** Parse one frame at `off`; returns the bytes consumed, 0 when incomplete, -1 after a failure. */
  private parseFrame(off: number): number {
    const b = this.buf;
    const avail = b.length - off;
    if (avail < 2) return 0;
    const b0 = b[off];
    const b1 = b[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    if ((b0 & 0x70) !== 0) return this.fail(1002, 'rsv');
    if ((b1 & 0x80) === 0) return this.fail(1002, 'unmasked');
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (avail < 4) return 0;
      len = (b[p] << 8) | b[p + 1];
      p += 2;
    } else if (len === 127) {
      if (avail < 10) return 0;
      const hi = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
      const lo = ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]) >>> 0;
      if (hi !== 0 || lo > this.maxMessage) return this.fail(1009, 'too big');
      len = lo;
      p += 8;
    }
    if (opcode >= 0x8 && (!fin || len > 125)) return this.fail(1002, 'bad control frame');
    if (len > this.maxMessage) return this.fail(1009, 'too big');
    if (b.length < p + 4 + len) return 0;
    const mask0 = b[p];
    const mask1 = b[p + 1];
    const mask2 = b[p + 2];
    const mask3 = b[p + 3];
    p += 4;
    const payload = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      const m = (i & 3) === 0 ? mask0 : (i & 3) === 1 ? mask1 : (i & 3) === 2 ? mask2 : mask3;
      payload[i] = b[p + i] ^ m;
    }
    const used = p + len - off;
    switch (opcode) {
      case 0x0: {
        if (this.fragments.length === 0) return this.fail(1002, 'stray continuation');
        this.fragmentBytes += len;
        if (this.fragmentBytes > this.maxMessage) return this.fail(1009, 'too big');
        this.fragments.push(payload);
        if (fin) {
          const all = new Uint8Array(this.fragmentBytes);
          let q = 0;
          for (const f of this.fragments) {
            all.set(f, q);
            q += f.length;
          }
          const text = this.fragmentText;
          this.fragments = [];
          this.fragmentBytes = 0;
          if (!this.deliver(all, text)) return -1;
        }
        return used;
      }
      case 0x1:
      case 0x2: {
        if (this.fragments.length > 0) return this.fail(1002, 'interleaved message');
        if (fin) {
          if (!this.deliver(payload, opcode === 0x1)) return -1;
        } else {
          this.fragments.push(payload);
          this.fragmentBytes = len;
          this.fragmentText = opcode === 0x1;
        }
        return used;
      }
      case 0x8: {
        let code = 1005;
        let reason = '';
        if (len >= 2) {
          code = (payload[0] << 8) | payload[1];
          try {
            reason = textDecoder.decode(payload.subarray(2));
          } catch {
            reason = '';
          }
        }
        if (!this.closeSent) this.sendClose(code === 1005 ? 1000 : code, '');
        this.finalize(code, reason);
        return -1;
      }
      case 0x9:
        if (this.isOpen && !this.closeSent) this.writeFrame(0xa, payload);
        return used;
      case 0xa:
        return used;
      default:
        return this.fail(1002, 'opcode');
    }
  }

  private deliver(payload: Uint8Array, text: boolean): boolean {
    if (text) {
      try {
        textDecoder.decode(payload);
      } catch {
        this.fail(1007, 'utf-8');
        return false;
      }
    }
    if (!this.isOpen) return true;
    try {
      this.onmessage?.(payload, text);
    } catch (e) {
      console.error('ws onmessage threw', e);
    }
    return !this.finalized;
  }

  private writeFrame(opcode: number, payload: Uint8Array): void {
    const len = payload.length;
    const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
    const frame = new Uint8Array(head + len);
    frame[0] = 0x80 | opcode;
    if (len < 126) frame[1] = len;
    else if (len < 65536) {
      frame[1] = 126;
      frame[2] = len >>> 8;
      frame[3] = len & 0xff;
    } else {
      frame[1] = 127;
      // lengths < 2^32 only (messages are capped far below that)
      frame[6] = (len >>> 24) & 0xff;
      frame[7] = (len >>> 16) & 0xff;
      frame[8] = (len >>> 8) & 0xff;
      frame[9] = len & 0xff;
    }
    frame.set(payload, head);
    try {
      this.socket.write(frame);
    } catch {
      this.finalize(1006, '');
    }
  }

  private sendClose(code: number, reason: string): void {
    if (this.closeSent) return;
    this.closeSent = true;
    const r = textEncoder.encode(reason).subarray(0, 123);
    const p = new Uint8Array(2 + r.length);
    p[0] = (code >>> 8) & 0xff;
    p[1] = code & 0xff;
    p.set(r, 2);
    this.writeFrame(0x8, p);
  }

  private fail(code: number, reason: string): number {
    if (!this.finalized) {
      this.sendClose(code, reason);
      this.finalize(code, reason);
    }
    return -1;
  }

  private finalize(code: number, reason: string): void {
    if (this.finalized) return;
    this.finalized = true;
    this.isOpen = false;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    try {
      this.socket.end();
    } catch {
      /* gone */
    }
    // Make sure a peer that never answers the close does not keep the descriptor.
    setTimeout(() => {
      try {
        this.socket.destroy();
      } catch {
        /* gone */
      }
    }, 500);
    const cb = this.onclose;
    this.onclose = null;
    this.onmessage = null;
    try {
      cb?.(code, reason);
    } catch (e) {
      console.error('ws onclose threw', e);
    }
  }
}

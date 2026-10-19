/**
 * Small node:http helpers shared by the node program and the reference control plane: JSON
 * answers, bounded body reading and a server with an upgrade hook.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export type { IncomingMessage, ServerResponse };

export interface HttpHandlers {
  onRequest(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
  onUpgrade?(req: IncomingMessage, socket: Socket, head: Uint8Array): void | Promise<void>;
}

export interface RunningServer {
  port: number;
  host: string;
  server: Server;
  close(): Promise<void>;
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

export function errorJson(res: ServerResponse, status: number, code: string, message?: string): void {
  json(res, status, { error: code, ...(message ? { message } : {}) });
}

/** Read the whole body, or null when it exceeds `limit` bytes (the request is then drained). */
export function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Uint8Array) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return resolve(null);
      const out = new Uint8Array(size);
      let p = 0;
      for (const c of chunks) {
        out.set(c, p);
        p += c.length;
      }
      resolve(out);
    });
    req.on('error', () => resolve(null));
  });
}

export async function readJson<T>(req: IncomingMessage, limit = 64 * 1024): Promise<T | null> {
  const b = await readBody(req, limit);
  if (!b) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b)) as T;
  } catch {
    return null;
  }
}

export function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === 'string' ? v : null;
}

/** Start listening; resolves once bound (port 0 = any free port). */
export function startHttp(port: number, host: string, h: HttpHandlers): Promise<RunningServer> {
  const server = createServer((req, res) => {
    Promise.resolve(h.onRequest(req, res)).catch((e) => {
      console.error('http handler failed', e);
      if (!res.headersSent) errorJson(res, 500, 'internal');
      else res.end();
    });
  });
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Uint8Array) => {
    socket.on('error', () => {
      /* client vanished mid-handshake */
    });
    if (!h.onUpgrade) {
      socket.destroy();
      return;
    }
    Promise.resolve(h.onUpgrade(req, socket, head)).catch((e) => {
      console.error('upgrade handler failed', e);
      socket.destroy();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const bound = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: bound,
        host,
        server,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

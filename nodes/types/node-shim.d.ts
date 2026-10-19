// Minimal declarations of the Node.js built-ins this package uses, so `npm run typecheck` works
// without adding @types/node (the package has no dependencies at all). Only what the code calls,
// with Node 24's signatures. If a new built-in is used, declare it here.

interface Buffer extends Uint8Array {}
declare const Buffer: {
  from(data: Uint8Array | ArrayBuffer | string | readonly number[]): Buffer;
  alloc(size: number, fill?: number): Buffer;
};

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  execPath: string;
  versions: { node: string; [k: string]: string | undefined };
  exit(code?: number): never;
  exitCode?: number;
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  cpuUsage(previous?: { user: number; system: number }): { user: number; system: number };
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number; external: number };
};

declare module 'node:net' {
  export interface Socket {
    readonly remoteAddress?: string;
    readonly destroyed: boolean;
    readonly writableLength: number;
    write(data: Uint8Array | string, cb?: (err?: Error) => void): boolean;
    end(): void;
    destroy(): void;
    setNoDelay(noDelay?: boolean): void;
    on(event: 'data', listener: (chunk: Uint8Array) => void): this;
    on(event: 'close' | 'end' | 'drain', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }
}

declare module 'node:http' {
  import type { Socket } from 'node:net';
  export interface IncomingMessage {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    socket: Socket;
    on(event: 'data', listener: (chunk: Uint8Array) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }
  export interface ServerResponse {
    readonly headersSent: boolean;
    writeHead(status: number, headers?: Record<string, string>): this;
    setHeader(name: string, value: string): void;
    end(body?: string | Uint8Array): void;
  }
  export interface Server {
    listen(port: number, host: string, cb: () => void): this;
    address(): { port: number; address: string } | string | null;
    close(cb?: () => void): void;
    closeAllConnections?(): void;
    on(event: 'upgrade', listener: (req: IncomingMessage, socket: Socket, head: Uint8Array) => void): this;
    once(event: 'error', listener: (err: Error) => void): this;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: 'base64' | 'hex'): string;
  }
  export function createHash(algorithm: 'sha1' | 'sha256'): Hash;
}

declare module 'node:fs/promises' {
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string | Uint8Array): Promise<void>;
  export function mkdir(path: string, opts?: { recursive?: boolean }): Promise<string | undefined>;
  export function readdir(path: string): Promise<string[]>;
  export function rename(from: string, to: string): Promise<void>;
  export function rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function chmod(path: string, mode: number): Promise<void>;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function normalize(p: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module 'node:os' {
  export function cpus(): Array<{ model: string; speed: number }>;
  export function freemem(): number;
  export function totalmem(): number;
  export function arch(): string;
  export function platform(): string;
}

declare module 'node:child_process' {
  export interface ChildProcess {
    kill(signal?: 'SIGTERM' | 'SIGINT'): boolean;
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this;
  }
  export function spawn(cmd: string, args: string[], opts?: { stdio?: 'inherit' | 'pipe' | 'ignore'; env?: Record<string, string | undefined> }): ChildProcess;
}

/**
 * Reference control plane on node:http: local development, the demo (scripts/demo.mjs) and the
 * end-to-end tests. Production runs the same ControlPlane class inside a Durable Object behind the
 * Worker (docs/INTEGRACION.md); only this HTTP glue and the dev-only routes are specific to here.
 *
 * Node API (what production serves too)
 *   POST /nodes/register                 { token, publicKey, ... } -> RegisterAnswer
 *   GET  /nodes/connect                  WebSocket, the node's control connection
 *   PUT  /nodes/replays/<matchId>        replay upload (x-node-id / x-node-ts / x-node-sig / x-replay-sha256)
 *   GET  /nodes/replays/<matchId>        replay download for the assigned verifier (same headers)
 *   GET  /nodes/releases/channel         { stable, minimum }
 *   GET  /nodes/releases/<v>/<file>      release files (launcher, installers)
 *   GET  /nodes/whoami                   { ip } as seen by the server (the installer's public IP)
 *   GET  /nodes/status                   public list of nodes (the "Anfitriones" page)
 * Player API for WebRTC nodes (production: same paths on the game's domain)
 *   POST /nodes/rtc/<node>/<match>/ice   { ticket } -> { iceServers }
 *   POST /nodes/rtc/<node>/<match>/offer { ticket, sdp } -> { sdp }
 * Operator API (production: the player's account session; here: x-dev-operator from /dev/login)
 *   POST /dev/login { name }             -> { operatorId, name }
 *   POST /nodes/tokens { region, name? } -> { token, expiresAt, install: { linux, windows, desktop, cloudInit, dev } }
 *   GET  /nodes/mine                     -> the operator's nodes, rewards and wallet
 *   GET  /nodes/shop                     -> wallet + catalog as this operator sees it
 *   POST /nodes/shop/claim { itemId }    -> claim an item with host points
 *   GET  /nodes/inventory                -> item ids the operator owns (what the game unlocks)
 * Dev matchmaker (production: MatchmakerDO.formMatch calls ControlPlane.place)
 *   POST /dev/match { mode, region, ranked, humans, matchLengthSeconds, transports?, ... } -> Placement
 *   POST /dev/leave { matchId, playerId }
 *   GET  /dev/outcome/<matchId>          -> state, outcome, verdict, points
 *   GET  /host                           the "Poner un servidor" page prototype (web/host.html)
 *   GET  /web/<file>                     static files of web/ (the browser WebRTC harness)
 */
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import type { Socket } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REGIONS } from '../../src/net/account';
import { PROTOCOL_VERSION } from '../../src/net/protocol';
import { RTC_PATH } from '../shared/controlProtocol';
import type { BuildId, IceServer, NodeTransport, RegisterAnswer, RegisterRequest, ReleaseChannel } from '../shared/controlProtocol';
import { generateEd25519, randomHexId } from '../shared/edcrypto';
import type { KeyPairB64 } from '../shared/edcrypto';
import { loadWasm, nodeSimFactory } from '../shared/nodeArena';
import { verifyReplay } from '../shared/verify';
import { errorJson, header, json, readBody, readJson, startHttp } from '../node/http';
import type { IncomingMessage, RunningServer, ServerResponse } from '../node/http';
import { acceptUpgrade, clientIp, rejectUpgrade } from '../node/wsServer';
import { ControlPlane, NodeRefused } from './controlPlane';
import type { MatchOutcome, PlaceRequest } from './controlPlane';
import { Ledger } from './ledger';
import { Registry, TOKEN_TTL_MS } from './registry';
import { Shop } from './shop';

export interface DevServerOptions {
  port?: number;
  host?: string;
  /** Ticket-signing key pair (generated per run when absent). */
  keys?: KeyPairB64;
  /** Share of an active node's casual matches that are verified. Default 1 here (the reference server shows every verification); production: CASUAL_VERIFY_RATE. */
  casualVerifyRate?: number;
  /** The build clients run; default: this checkout's wasm + PROTOCOL_VERSION. */
  build?: BuildId;
  channel?: ReleaseChannel;
  /** Directory with releases/<version>/... and launcher files for the launcher. */
  releasesDir?: string;
  /** Operator ids whose nodes are trusted (the project's machines). */
  trustedOperators?: string[];
  /** Dev logins with these names are the project (their nodes are trusted). */
  trustedOperatorNames?: string[];
  /** ICE servers handed to nodes and players (default none: host candidates, fine on one machine). */
  iceServers?: IceServer[];
  /** Verify in this process when no trusted verifier node is online (default true). */
  inlineVerify?: boolean;
  /** Public base URL (default http://<host>:<port>). */
  publicBase?: string;
  /** Sweep period (ms). */
  sweepMs?: number;
  log?: (msg: string) => void;
  onOutcome?: (o: MatchOutcome) => void;
}

export interface DevControlPlane {
  cp: ControlPlane;
  shop: Shop;
  port: number;
  url: string;
  keys: KeyPairB64;
  operators: Map<string, string>;
  close(): Promise<void>;
}

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const INSTALL_DIR = fileURLToPath(new URL('../install/', import.meta.url));
const REPLAY_ROUTE = /^\/nodes\/replays\/([0-9A-Za-z_-]{8,64})$/;
const RTC_ROUTE = /^(\/nodes\/rtc\/[0-9a-f]{16}\/[0-9A-Za-z_-]{8,64})\/(ice|offer)$/;
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

export const DEFAULT_VERSION = '0.1.0';

export async function startControlPlane(opts: DevServerOptions = {}): Promise<DevControlPlane> {
  const log = opts.log ?? ((m: string) => console.log(`[control] ${m}`));
  const keys = opts.keys ?? (await generateEd25519());
  const wasm = await loadWasm();
  const build: BuildId = opts.build ?? { version: DEFAULT_VERSION, protocol: PROTOCOL_VERSION, wasmSha256: wasm.sha256 };
  const channel: ReleaseChannel = opts.channel ?? { stable: build.version, minimum: '0.0.0' };
  const registry = new Registry({ allowInsecure: true, trustedOperators: opts.trustedOperators ?? [], regions: REGIONS.map((r) => r.id) });
  const ledger = new Ledger();
  const shop = new Shop(ledger);
  const replays = new Map<string, Uint8Array>();
  const operators = new Map<string, string>(); // id -> name
  const host = opts.host ?? '127.0.0.1';
  const iceServers = opts.iceServers ?? [];
  let base = opts.publicBase ?? '';

  const cp = new ControlPlane({
    controlPrivateKey: keys.privateKey,
    controlPublicKey: keys.publicKey,
    get controlUrl() {
      return base.replace(/^http/, 'ws') + '/nodes/connect';
    },
    get httpBase() {
      return base;
    },
    build: () => build,
    channel: () => channel,
    registry,
    ledger,
    shop,
    iceServers: async () => iceServers,
    // Without TURN (this reference server, local tests) a plain WebRTC self-test is accepted.
    requireRelay: iceServers.some((s) => [s.urls].flat().some((u) => /^turns?:/.test(u))),
    casualVerifyRate: opts.casualVerifyRate ?? 1,
    replays: {
      put: async (id, bytes) => {
        replays.set(id, bytes);
      },
      get: async (id) => replays.get(id) ?? null,
    },
    inlineVerify:
      opts.inlineVerify === false
        ? undefined
        : (bytes, job) => verifyReplay(bytes, { makeSim: nodeSimFactory, wasmSha256: build.wasmSha256, protocol: build.protocol, expect: job.expect, expectNodeId: job.hostNodeId, leaves: job.leaves }),
    onOutcome: (o) => opts.onOutcome?.(o),
    log,
  });

  const operatorOf = (req: IncomingMessage): { id: string; name: string } | null => {
    const id = header(req, 'x-dev-operator');
    if (!id) return null;
    const name = operators.get(id);
    return name ? { id, name } : null;
  };

  async function serveFile(res: ServerResponse, dir: string, rel: string): Promise<void> {
    const clean = normalize(decodeURIComponent(rel));
    if (clean.startsWith('..') || clean.includes(':') || clean.startsWith('/') || clean.startsWith('\\')) return errorJson(res, 400, 'bad_path');
    try {
      const bytes = await readFile(join(dir, clean));
      const ext = clean.slice(clean.lastIndexOf('.'));
      res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(bytes);
    } catch {
      errorJson(res, 404, 'not_found');
    }
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://cp');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    res.setHeader('access-control-allow-origin', '*');
    if (method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-headers': 'content-type, x-dev-operator', 'access-control-allow-methods': 'GET, POST, PUT' });
      return void res.end();
    }

    if (method === 'GET' && (path === '/' || path === '/host')) return serveFile(res, WEB_DIR, 'host.html');
    if (method === 'GET' && path.startsWith('/web/')) return serveFile(res, WEB_DIR, path.slice('/web/'.length));
    if (method === 'GET' && path === '/healthz') return json(res, 200, { ok: true, build, channel });
    if (method === 'GET' && path === '/nodes/whoami') return json(res, 200, { ip: clientIp(req) });

    // ---- node API ----
    if (method === 'POST' && path === '/nodes/register') {
      const body = await readJson<RegisterRequest>(req);
      if (!body) return errorJson(res, 400, 'bad_request');
      const r = await registry.register(body, Date.now());
      if (!r.ok) return errorJson(res, 403, r.code, r.message);
      const answer: RegisterAnswer = {
        nodeId: r.node.nodeId,
        operatorId: r.node.operatorId,
        region: r.node.region,
        name: r.node.name,
        status: r.node.status,
        controlPublicKey: keys.publicKey,
        controlUrl: base.replace(/^http/, 'ws') + '/nodes/connect',
      };
      log(`registered node ${r.node.name} (${r.node.nodeId}) for ${r.node.operatorName}, roles ${r.node.roles.join('+')}, transports ${r.node.transports.join('+') || '-'}${r.node.trusted ? ', trusted' : ''}`);
      return json(res, 200, answer);
    }
    const rm = REPLAY_ROUTE.exec(path);
    if (rm && (method === 'PUT' || method === 'GET')) {
      const nodeId = header(req, 'x-node-id') ?? '';
      const ts = Number(header(req, 'x-node-ts'));
      const sig = header(req, 'x-node-sig') ?? '';
      const sha = header(req, 'x-replay-sha256') ?? '';
      if (method === 'PUT') {
        const bytes = await readBody(req, 16 * 1024 * 1024);
        if (!bytes) return errorJson(res, 413, 'too_large');
        const r = await cp.storeReplay(rm[1], nodeId, ts, sig, sha, bytes);
        return r.ok ? json(res, 200, { ok: true }) : errorJson(res, r.status, r.code);
      }
      const bytes = await cp.loadReplayFor(rm[1], nodeId, ts, sig, sha);
      if (!bytes) return errorJson(res, 404, 'no_replay');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) });
      return void res.end(bytes);
    }
    if (method === 'GET' && path === '/nodes/releases/channel') return json(res, 200, channel);
    if (method === 'GET' && path.startsWith('/nodes/releases/') && opts.releasesDir) return serveFile(res, opts.releasesDir, path.slice('/nodes/releases/'.length));
    if (method === 'GET' && path === '/nodes/status') {
      const now = Date.now();
      return json(res, 200, {
        build,
        nodes: registry.list().map((n) => ({
          name: n.name,
          operator: n.operatorName,
          region: n.region,
          status: n.status,
          online: n.online,
          roles: n.roles,
          transports: n.transports,
          active: n.active,
          capacity: n.capacity.matches,
          tickLagP99Ms: n.tickLagP99Ms,
          version: n.build.version,
          compatible: cp.sameBuildAs(n.build),
          trusted: n.trusted,
        })),
        hosts: ledger.leaderboard(now).map((e) => ({ ...e, name: operators.get(e.operatorId) ?? e.operatorId.slice(0, 6) })),
      });
    }

    // ---- WebRTC signaling for players ----
    const rtc = RTC_ROUTE.exec(path);
    if (rtc && method === 'POST') {
      const m = RTC_PATH.exec(rtc[1]);
      if (!m) return errorJson(res, 404, 'not_found');
      const b = await readJson<{ ticket?: unknown; sdp?: unknown }>(req, 64 * 1024);
      if (!b || typeof b.ticket !== 'string') return errorJson(res, 400, 'bad_request');
      try {
        if (rtc[2] === 'ice') return json(res, 200, await cp.rtcIce(m[1], m[2], b.ticket));
        if (typeof b.sdp !== 'string') return errorJson(res, 400, 'bad_request');
        return json(res, 200, await cp.rtcOffer(m[1], m[2], b.ticket, b.sdp));
      } catch (e) {
        const code = e instanceof NodeRefused ? e.code : 'failed';
        return errorJson(res, code === 'bad_ticket' ? 403 : code === 'no_match' ? 404 : code === 'match_over' ? 410 : 409, code);
      }
    }

    // ---- operator API (dev auth) ----
    if (method === 'POST' && path === '/dev/login') {
      const b = await readJson<{ name?: unknown }>(req);
      const name = typeof b?.name === 'string' ? b.name.trim().slice(0, 24) : '';
      if (name.length < 2) return errorJson(res, 400, 'bad_name');
      let id: string | null = null;
      for (const [k, n] of operators) if (n === name) id = k;
      if (!id) {
        id = randomHexId(8);
        operators.set(id, name);
      }
      if ((opts.trustedOperatorNames ?? []).includes(name)) registry.addTrustedOperator(id);
      return json(res, 200, { operatorId: id, name, trusted: registry.isTrusted(id) });
    }
    if (method === 'POST' && path === '/nodes/tokens') {
      const op = operatorOf(req);
      if (!op) return errorJson(res, 401, 'login');
      const b = await readJson<{ region?: unknown; name?: unknown }>(req);
      const region = typeof b?.region === 'string' ? b.region : '';
      if (!REGIONS.some((r) => r.id === region)) return errorJson(res, 400, 'bad_region');
      const t = await registry.createToken(op, region, Date.now(), typeof b?.name === 'string' ? b.name : undefined);
      const c = base;
      const cloudInit = (await readFile(INSTALL_DIR + 'cloud-init.yaml', 'utf8')).replace(/__CONTROL__/g, c).replace(/__TOKEN__/g, t.token);
      const install = {
        linux: `curl -fsSL ${c}/nodes/releases/install.sh | sudo bash -s -- --control ${c} --token ${t.token}`,
        windows: `powershell -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm ${c}/nodes/releases/install-windows.ps1))) -Control ${c} -Token ${t.token}"`,
        desktop: `curl -fsSL ${c}/nodes/releases/install-desktop.sh | bash -s -- --control ${c} --token ${t.token}`,
        cloudInit,
        dev: `npm run node -- register --control ${c} --token ${t.token} --data ./data/${region.toLowerCase()} --transport rtc && npm run node -- run --data ./data/${region.toLowerCase()}`,
      };
      return json(res, 200, { token: t.token, expiresAt: t.expiresAt, ttlMinutes: TOKEN_TTL_MS / 60_000, install });
    }
    if (method === 'GET' && path === '/nodes/mine') {
      const op = operatorOf(req);
      if (!op) return errorJson(res, 401, 'login');
      const now = Date.now();
      return json(res, 200, {
        operator: { ...op, trusted: registry.isTrusted(op.id) },
        rewards: ledger.summary(op.id, now),
        wallet: shop.wallet(op.id),
        nodes: registry.byOperator(op.id).map((n) => ({
          nodeId: n.nodeId,
          name: n.name,
          region: n.region,
          status: n.status,
          statusReason: n.statusReason,
          suspendedUntil: n.suspendedUntil,
          online: n.online,
          roles: n.roles,
          transports: n.transports,
          rtcReady: n.rtcReady,
          trusted: n.trusted,
          publicUrl: n.publicUrl,
          active: n.active,
          capacity: n.capacity,
          tickLagP99Ms: n.tickLagP99Ms,
          egressGB: Math.round(n.egressGB * 100) / 100,
          counters: n.counters,
          version: n.build.version,
          compatible: cp.sameBuildAs(n.build),
        })),
      });
    }
    if (method === 'GET' && path === '/nodes/shop') {
      const op = operatorOf(req);
      if (!op) return errorJson(res, 401, 'login');
      return json(res, 200, { wallet: shop.wallet(op.id), items: shop.view(op.id) });
    }
    if (method === 'POST' && path === '/nodes/shop/claim') {
      const op = operatorOf(req);
      if (!op) return errorJson(res, 401, 'login');
      const b = await readJson<{ itemId?: unknown }>(req);
      if (typeof b?.itemId !== 'string') return errorJson(res, 400, 'bad_request');
      const r = shop.claim(op.id, b.itemId, Date.now());
      return r.ok ? json(res, 200, r) : errorJson(res, r.code === 'unknown_item' ? 404 : 409, r.code);
    }
    if (method === 'GET' && path === '/nodes/inventory') {
      const op = operatorOf(req);
      if (!op) return errorJson(res, 401, 'login');
      return json(res, 200, { items: shop.inventory(op.id) });
    }

    // ---- dev matchmaker ----
    if (method === 'POST' && path === '/dev/match') {
      const b = await readJson<PlaceRequest & { transports?: NodeTransport[] }>(req);
      if (!b || !Array.isArray(b.humans)) return errorJson(res, 400, 'bad_request');
      try {
        const p = await cp.place(b);
        return p ? json(res, 200, p) : errorJson(res, 503, 'no_node', 'no eligible community node (the matchmaker would create a MatchDO)');
      } catch (e) {
        return errorJson(res, 400, 'bad_request', String(e));
      }
    }
    if (method === 'POST' && path === '/dev/leave') {
      const b = await readJson<{ matchId?: string; playerId?: string }>(req);
      try {
        return json(res, 200, await cp.leave(String(b?.matchId), String(b?.playerId)));
      } catch (e) {
        return errorJson(res, 409, e instanceof NodeRefused ? e.code : 'failed');
      }
    }
    if (method === 'GET' && path.startsWith('/dev/outcome/')) {
      const m = cp.matches.get(path.slice('/dev/outcome/'.length));
      if (!m) return errorJson(res, 404, 'no_match');
      return json(res, 200, { state: m.state, transport: m.transport, outcome: m.outcome, verdict: m.verdict, verifiedBy: m.verifiedBy, ledger: m.ledger, left: [...m.left] });
    }
    errorJson(res, 404, 'not_found');
  }

  function onUpgrade(req: IncomingMessage, socket: Socket, head: Uint8Array): void {
    const path = new URL(req.url ?? '/', 'http://cp').pathname;
    if (path !== '/nodes/connect') return rejectUpgrade(socket, 404, 'not_found');
    const ws = acceptUpgrade(req, socket, head, { maxMessageBytes: 256 * 1024 });
    if (!ws) return;
    const session = cp.open({ send: (m) => ws.send(JSON.stringify(m)), close: (code, reason) => ws.close(code, reason) });
    ws.onmessage = (data, text) => {
      if (!text) return ws.close(1003, 'text only');
      cp.onMessage(session, new TextDecoder().decode(data)).catch((e: unknown) => log(`node message failed: ${String(e)}`));
    };
    ws.onclose = () => cp.onClose(session);
  }

  const server: RunningServer = await startHttp(opts.port ?? 8790, host, { onRequest, onUpgrade });
  if (!base) base = `http://${host}:${server.port}`;
  const sweep = setInterval(() => cp.sweep(), opts.sweepMs ?? 2_000);
  log(`control plane on ${base} (build ${build.version} / wasm ${build.wasmSha256.slice(0, 12)})`);
  return {
    cp,
    shop,
    port: server.port,
    url: base,
    keys,
    operators,
    close: async () => {
      clearInterval(sweep);
      await server.close();
    },
  };
}

// `node --import ./dev/ts-resolve.mjs control-plane/devServer.ts [--port 8790]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 8790;
  void startControlPlane({ port, trustedOperatorNames: ['Proyecto'] }).then((d) => console.log(`open ${d.url}/host`));
}

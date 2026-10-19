/**
 * Browser harness for WebRTC home nodes (web/rtc-harness.html, bundled by scripts/build-web.mjs).
 *
 * Plays one short casual match against a home node with the game's REAL NetClient on the WebRTC
 * socket adapter (client/rtcSocket.ts), the same flow test/rtc.test.mjs runs under Node with
 * werift, but with the browser's own RTCPeerConnection and fetch. It proves browser <-> node
 * interop end to end:
 *
 *   1. POST /dev/match (1v1, SA, casual, transports wss+rtc)  -> Placement (rtc url + ticket)
 *   2. NetClient.connect over nodeAwareSocketFactory()        -> Welcome -> sendReady()
 *   3. every snapshot: 6 ticks of inputs (full throttle, slow sine steer), ack = snapshot tick
 *   4. after ~8 s of play (tick >= 1000 or 8 s wall time after the Welcome): POST /dev/leave
 *   5. the node closes the channel (1000 'left'), then GET /dev/outcome/<id> until 'done'
 *   6. checks: rtc transport, Welcome, snapshots, clean close, verdict ok, unrated, points > 0
 *
 * Machine-readable summary for automated browsers: window.__harness (mutated in place) and
 * document.body.dataset.state ('idle' | 'placing' | 'connecting' | 'playing' | 'leaving' |
 * 'done' | 'error'). 'done' means the flow finished AND every check passed; anything else ends in
 * 'error' with window.__harness.error set. ?auto=1 starts on load; window.__harnessStart() too.
 *
 * The page is served by the dev control plane (control-plane/devServer.ts, GET /web/<file>), so
 * every /dev/* call is same-origin.
 */
import { NetClient } from '../../src/net/NetClient';
import type { MatchEvent, SnapshotPacket, Welcome } from '../../src/net/protocol';
import { PACKED_INPUT_BYTES, emptyControls, packControls } from '../../src/sim/types';
import { nodeAwareSocketFactory } from './rtcSocket';
import type { PeerLike } from './rtcSocket';

// ---- tuning ---------------------------------------------------------------------------------

/** Leave once a snapshot reaches this tick (120 Hz: ~8 s)... */
const PLAY_UNTIL_TICK = 1_000;
/** ...or this long after the Welcome, whichever comes first. */
const PLAY_MS = 8_000;
/** From connect() to the Welcome (the adapter itself gives up after 15 s). */
const WELCOME_TIMEOUT_MS = 20_000;
/** From POST /dev/leave to the node closing the channel. */
const CLOSE_TIMEOUT_MS = 5_000;
const OUTCOME_TIMEOUT_MS = 30_000;
const OUTCOME_POLL_MS = 500;
/** Ticks of input per batch (one batch per snapshot). */
const BATCH = 6;
/** The Node test asks for more than 40 snapshots in ~4 s; 8 s of play gives plenty of margin. */
const MIN_SNAPSHOTS = 40;
const MAX_EVENTS = 200;
const MAX_LOG = 200;

// ---- shapes of the dev routes (control-plane/devServer.ts) ----------------------------------

interface Placement {
  matchId: string;
  nodeId: string;
  nodeName: string;
  transport: string;
  wsUrl: string;
  tickets: Array<{ playerId: string; slot: number; team: 0 | 1; ticket: string }>;
}

interface OutcomeAnswer {
  state: 'assigned' | 'verifying' | 'done';
  transport: string;
  outcome: { kind: string; blue?: number; red?: number; reason?: string } | null;
  verdict: { ok: boolean; code: string; message?: string; ticks?: number; score?: { blue: number; red: number } } | null;
  verifiedBy: string | null;
  ledger: { points: number; playerMinutes?: number } | null;
  left: string[];
}

type HarnessState = 'idle' | 'placing' | 'connecting' | 'playing' | 'leaving' | 'done' | 'error';

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

interface HarnessSummary {
  state: HarnessState;
  transport: string | null;
  matchId: string | null;
  nodeName: string | null;
  playerId: string | null;
  welcome: Welcome | null;
  snapshots: number;
  lastTick: number;
  inputBatches: number;
  events: MatchEvent[];
  /** The last onClose (a reconnect attempt shows up as reconnecting: true first). */
  closed: { code: number; reason: string; reconnecting: boolean } | null;
  reconnects: number;
  /** Error / Kick messages from the host. */
  hostErrors: Array<{ code: string; message: string }>;
  /** The selected ICE candidate pair once connected, e.g. 'host/udp <-> host/udp'. */
  iceRoute: string | null;
  rttMs: number | null;
  outcome: OutcomeAnswer | null;
  checks: Check[];
  ok: boolean;
  error: string | null;
  startedAt: number;
  log: string[];
}

declare global {
  interface Window {
    __harness: HarnessSummary;
    __harnessStart: () => Promise<void>;
  }
}

class HarnessError extends Error {}

// ---- summary and rendering ------------------------------------------------------------------

function freshSummary(): HarnessSummary {
  return {
    state: 'idle',
    transport: null,
    matchId: null,
    nodeName: null,
    playerId: null,
    welcome: null,
    snapshots: 0,
    lastTick: 0,
    inputBatches: 0,
    events: [],
    closed: null,
    reconnects: 0,
    hostErrors: [],
    iceRoute: null,
    rttMs: null,
    outcome: null,
    checks: [],
    ok: false,
    error: null,
    startedAt: 0,
    log: [],
  };
}

let S: HarnessSummary = freshSummary();
window.__harness = S;
/** A run is in progress (the button is disabled, a second start is ignored). */
let running = false;

const STATE_LABEL: Record<HarnessState, string> = {
  idle: 'Listo para empezar',
  placing: 'Pidiendo partida…',
  connecting: 'Conectando por WebRTC…',
  playing: 'Jugando…',
  leaving: 'Saliendo y esperando la verificación…',
  done: 'Todo bien: el navegador y el nodo se entienden',
  error: 'Falló',
};

const $ = (id: string): HTMLElement | null => document.getElementById(id);

function setText(id: string, text: string): void {
  const el = $(id);
  if (el && el.textContent !== text) el.textContent = text;
}

function setState(state: HarnessState): void {
  S.state = state;
  document.body.dataset.state = state;
  render();
}

function elapsed(): string {
  return S.startedAt ? `+${((performance.now() - S.startedAt) / 1000).toFixed(1)} s` : '';
}

function log(line: string): void {
  const entry = `${elapsed()}  ${line}`;
  S.log.push(entry);
  if (S.log.length > MAX_LOG) S.log.shift();
  const ol = $('log');
  if (ol) {
    const li = document.createElement('li');
    li.textContent = entry;
    ol.appendChild(li);
    while (ol.childElementCount > MAX_LOG) ol.firstElementChild?.remove();
    ol.scrollTop = ol.scrollHeight;
  }
}

function describeEvent(e: MatchEvent): string {
  switch (e.type) {
    case 'countdown':
      return `cuenta ${e.n}`;
    case 'goal':
      return `gol ${e.blue}-${e.red}`;
    case 'ended':
      return `fin ${e.blue}-${e.red}`;
    case 'cancelled':
      return `cancelada (${e.reason})`;
    default:
      return e.type;
  }
}

function render(): void {
  setText('status', STATE_LABEL[S.state]);
  setText('c-state', S.state);
  setText('c-transport', S.transport ?? '–');
  setText('c-match', S.matchId ?? '–');
  setText('c-node', S.nodeName ?? '–');
  setText('c-colo', S.welcome ? (S.welcome.hostColo ?? '(sin dato)') : '–');
  setText('c-snaps', String(S.snapshots));
  setText('c-tick', String(S.lastTick));
  setText('c-inputs', String(S.inputBatches));
  setText('c-rtt', S.rttMs === null ? '–' : `${Math.round(S.rttMs)} ms`);
  setText('c-ice', S.iceRoute ?? '–');
  const last = S.events.slice(-3).map(describeEvent).join(' · ');
  setText('c-events', S.events.length ? `${S.events.length} (${last})` : '0');
  setText('c-close', S.closed ? `${S.closed.code}${S.closed.reason ? ` '${S.closed.reason}'` : ''}${S.closed.reconnecting ? ' (reconectando)' : ''}` : '–');

  const o = S.outcome;
  setText('r-state', o ? o.state : '–');
  setText('r-verdict', o?.verdict ? `${o.verdict.code}${o.verdict.message ? `: ${o.verdict.message}` : ''}` : '–');
  setText('r-kind', o?.outcome ? o.outcome.kind : '–');
  setText('r-points', o?.ledger ? String(o.ledger.points) : '–');
  setText('r-by', o?.verifiedBy ?? '–');

  const checks = $('checks');
  if (checks) {
    const key = JSON.stringify(S.checks);
    if (checks.dataset.key !== key) {
      checks.dataset.key = key;
      checks.replaceChildren(
        ...S.checks.map((c) => {
          const li = document.createElement('li');
          li.className = c.ok ? 'pass' : 'fail';
          const mark = document.createElement('b');
          mark.textContent = c.ok ? 'OK' : 'FALLA';
          li.append(mark, ` ${c.label}: ${c.detail}`);
          return li;
        }),
      );
    }
  }

  const err = $('error');
  if (err) {
    err.hidden = !S.error;
    setText('error', S.error ? `Error: ${S.error}` : '');
  }
  const btn = $('start') as HTMLButtonElement | null;
  if (btn) {
    const busy = running;
    btn.disabled = busy;
    btn.textContent = busy ? 'Jugando…' : S.state === 'idle' ? 'Jugar partida de prueba' : 'Jugar de nuevo';
  }
}

// ---- helpers --------------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A rejection nobody awaits any more (the flow already failed elsewhere) is not an error.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function withTimeout<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new HarnessError(why)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function randomHex(chars: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(chars / 2)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, chars);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface HttpAnswer {
  status: number;
  ok: boolean;
  body: unknown;
}

/** Same-origin JSON call; a network failure becomes a HarnessError, an HTTP error is returned. */
async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HttpAnswer> {
  let res: Response;
  try {
    res = await fetch(location.origin + path, {
      method,
      cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new HarnessError(`${method} ${path}: sin respuesta del plano de control (${messageOf(e)})`);
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

/** 'HTTP 503 no_node: no eligible community node' from an error body ({ error, message? }). */
function httpProblem(method: string, path: string, a: HttpAnswer): string {
  const b = (a.body ?? {}) as { error?: unknown; message?: unknown };
  const code = typeof b.error === 'string' ? ` ${b.error}` : '';
  const msg = typeof b.message === 'string' ? `: ${b.message}` : '';
  return `${method} ${path} -> HTTP ${a.status}${code}${msg}`;
}

// ---- WebRTC diagnostics ---------------------------------------------------------------------

/** Native RTCPeerConnection, plus a log line per connection state and the selected ICE route. */
function createPeer(config: { iceServers: unknown[] }): PeerLike {
  const pc = new RTCPeerConnection(config as RTCConfiguration);
  log(`WebRTC: RTCPeerConnection con ${config.iceServers.length} servidor(es) ICE`);
  pc.addEventListener('connectionstatechange', () => {
    log(`WebRTC: connectionState = ${pc.connectionState}`);
    if (pc.connectionState === 'connected') void describeRoute(pc);
  });
  return pc as unknown as PeerLike;
}

async function describeRoute(pc: RTCPeerConnection): Promise<void> {
  try {
    const stats = await pc.getStats();
    let pairId: string | undefined;
    stats.forEach((r: { type: string; selectedCandidatePairId?: string }) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    let pair: { localCandidateId?: string; remoteCandidateId?: string } | undefined;
    stats.forEach((r: { type: string; id: string; nominated?: boolean; state?: string; localCandidateId?: string; remoteCandidateId?: string }) => {
      if (r.type !== 'candidate-pair') return;
      if (pairId ? r.id === pairId : r.nominated && r.state === 'succeeded') pair = r;
    });
    if (!pair) return;
    const side = (id: string | undefined): string => {
      const c = id ? (stats.get(id) as { candidateType?: string; protocol?: string } | undefined) : undefined;
      return c ? `${c.candidateType ?? '?'}/${c.protocol ?? '?'}` : '?';
    };
    S.iceRoute = `${side(pair.localCandidateId)} <-> ${side(pair.remoteCandidateId)}`;
    log(`WebRTC: ruta ICE ${S.iceRoute} (navegador <-> nodo)`);
    render();
  } catch {
    /* stats are diagnostics only */
  }
}

/** Native fetch, plus a log line per signaling call (POST .../ice and .../offer). */
const signalingFetch = async (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<Response> => {
  const path = new URL(url).pathname.split('/').pop() ?? url;
  const res = await fetch(url, init);
  log(`señalización: POST …/${path} -> HTTP ${res.status}`);
  return res;
};

// ---- the run --------------------------------------------------------------------------------

async function run(): Promise<void> {
  if (running) return;
  running = true;
  S = freshSummary();
  window.__harness = S;
  S.startedAt = performance.now();
  const ol = $('log');
  if (ol) ol.replaceChildren();
  const ticker = setInterval(render, 200);
  let net: NetClient | null = null;
  let placement: Placement | null = null;
  let left = false;
  try {
    // 1. Placement.
    setState('placing');
    const playerId = randomHex(16);
    S.playerId = playerId;
    const req = {
      mode: '1v1',
      region: 'SA',
      ranked: false,
      humans: [{ playerId, name: 'Navegador', account: true, accountAgeDays: 30 }],
      matchLengthSeconds: 60,
      kickoffCountdownSeconds: 1,
      goalPauseSeconds: 1,
      transports: ['wss', 'rtc'],
    };
    const placed = await call('POST', '/dev/match', req);
    if (!placed.ok) {
      const hint = placed.status === 503 ? ' (no hay un nodo listo en SA: ¿está corriendo el nodo casero y ya pasó la prueba de WebRTC?)' : '';
      throw new HarnessError(httpProblem('POST', '/dev/match', placed) + hint);
    }
    placement = placed.body as Placement;
    if (!placement || typeof placement.wsUrl !== 'string' || !Array.isArray(placement.tickets) || !placement.tickets[0]) {
      throw new HarnessError('POST /dev/match: respuesta sin wsUrl o sin ticket');
    }
    S.transport = placement.transport;
    S.matchId = placement.matchId;
    S.nodeName = placement.nodeName;
    log(`POST /dev/match -> 200: partida ${placement.matchId} en el nodo ${placement.nodeName} (${placement.transport})`);
    log(`URL de la partida: ${placement.wsUrl}`);

    // 2. Connect with the real NetClient on the WebRTC-aware socket factory.
    setState('connecting');
    const welcome = deferred<void>();
    const played = deferred<void>();
    const closed = deferred<void>();
    net = new NetClient({
      apiBase: location.origin,
      storage: null,
      webSocketFactory: nodeAwareSocketFactory(undefined, { createPeer, fetchFn: signalingFetch }),
    });
    const packed = new Int8Array(BATCH * PACKED_INPUT_BYTES);
    const controls = emptyControls();
    let playTimer: ReturnType<typeof setTimeout> | null = null;
    const n = net;

    n.onOpen = () => log('canal de datos abierto: el NetClient está conectado');
    n.onWelcome = (w: Welcome) => {
      const first = S.welcome === null;
      S.welcome = w;
      log(`Welcome: partida ${w.matchId}, auto ${w.carId} (slot ${w.slot}), tick ${w.tick}, ${w.tickRate} Hz, hostColo ${w.hostColo ?? '(sin dato)'}`);
      n.sendReady();
      log('Ready enviado');
      if (first) {
        setState('playing');
        welcome.resolve();
        playTimer = setTimeout(() => played.resolve(), PLAY_MS);
      }
    };
    n.onSnapshot = (pkt: SnapshotPacket) => {
      S.snapshots++;
      S.lastTick = pkt.tick;
      for (let i = 0; i < BATCH; i++) {
        controls.throttle = 1;
        controls.steer = Math.sin((pkt.tick + 1 + i) / 40);
        packControls(controls, packed, i * PACKED_INPUT_BYTES);
      }
      if (n.sendInputs(pkt.tick + 1, BATCH, packed, pkt.tick)) S.inputBatches++;
      S.rttMs = n.rtt > 0 ? n.rtt : S.rttMs;
      if (pkt.tick >= PLAY_UNTIL_TICK) played.resolve();
    };
    n.onEvent = (e: MatchEvent) => {
      S.events.push(e);
      if (S.events.length > MAX_EVENTS) S.events.shift();
      log(`evento: ${describeEvent(e)}`);
    };
    n.onError = (code: string, message: string) => {
      S.hostErrors.push({ code, message });
      log(`error del host: ${code} ${message}`);
    };
    n.onClose = (code: number, reason: string, reconnecting: boolean) => {
      S.closed = { code, reason, reconnecting };
      log(`canal cerrado: código ${code}${reason ? ` '${reason}'` : ''}${reconnecting ? ', el NetClient intenta reconectar' : ''}`);
      if (reconnecting) {
        S.reconnects++;
        return;
      }
      closed.resolve();
      if (!left) {
        const hostErr = S.hostErrors.length ? `; el host dijo: ${S.hostErrors.map((h) => `${h.code} ${h.message}`).join(', ')}` : '';
        const what = S.welcome ? 'el canal se cerró en medio de la partida' : 'no se pudo abrir el canal WebRTC con el nodo';
        const err = new HarnessError(`${what} (código ${code}${reason ? ` '${reason}'` : ''})${hostErr}`);
        welcome.reject(err);
        played.reject(err);
      }
      render();
    };

    log('conectando el NetClient…');
    n.connect(placement.wsUrl, placement.tickets[0].ticket);
    await withTimeout(welcome.promise, WELCOME_TIMEOUT_MS, `el nodo no mandó el Welcome en ${WELCOME_TIMEOUT_MS / 1000} s`);

    // 3. Play until tick PLAY_UNTIL_TICK or PLAY_MS after the Welcome (inputs go out per snapshot).
    try {
      await played.promise;
    } finally {
      if (playTimer) clearTimeout(playTimer);
    }
    log(`fin del juego de prueba: ${S.snapshots} snapshots, último tick ${S.lastTick}`);

    // 4. Leave: the node ends the match and closes the channel with 1000 'left'.
    setState('leaving');
    left = true;
    const lv = await call('POST', '/dev/leave', { matchId: placement.matchId, playerId });
    if (!lv.ok) throw new HarnessError(httpProblem('POST', '/dev/leave', lv));
    log(`POST /dev/leave -> 200 ${JSON.stringify(lv.body)}`);
    try {
      await withTimeout(closed.promise, CLOSE_TIMEOUT_MS, 'x');
    } catch {
      log(`el nodo no cerró el canal en ${CLOSE_TIMEOUT_MS / 1000} s`);
    }

    // 5. Outcome: verified by re-simulation, then credited.
    const deadline = performance.now() + OUTCOME_TIMEOUT_MS;
    let lastSeen = '';
    for (;;) {
      const a = await call('GET', `/dev/outcome/${placement.matchId}`);
      const seen = a.ok ? `estado ${(a.body as OutcomeAnswer).state}` : `HTTP ${a.status}`;
      if (seen !== lastSeen) log(`GET /dev/outcome -> ${seen}`);
      lastSeen = seen;
      if (a.ok) {
        S.outcome = a.body as OutcomeAnswer;
        render();
        if (S.outcome.state === 'done') break;
      }
      if (performance.now() > deadline) {
        throw new HarnessError(`la verificación no terminó en ${OUTCOME_TIMEOUT_MS / 1000} s (GET /dev/outcome: ${lastSeen})`);
      }
      await sleep(OUTCOME_POLL_MS);
    }

    // 6. Checks (the same assertions as test/rtc.test.mjs).
    const o = S.outcome as OutcomeAnswer;
    const c = S.closed;
    S.checks = [
      { label: 'Transporte WebRTC', ok: S.transport === 'rtc' && o.transport === 'rtc', detail: `placement ${S.transport}, partida ${o.transport}` },
      { label: 'Welcome del nodo', ok: S.welcome?.matchId === placement.matchId, detail: S.welcome ? `partida ${S.welcome.matchId}, hostColo ${S.welcome.hostColo ?? '(sin dato)'}` : 'no llegó' },
      { label: 'Snapshots', ok: S.snapshots > MIN_SNAPSHOTS, detail: `${S.snapshots} recibidos (mínimo ${MIN_SNAPSHOTS + 1}), último tick ${S.lastTick}` },
      { label: 'Inputs enviados', ok: S.inputBatches > 0, detail: `${S.inputBatches} lotes de ${BATCH} ticks` },
      { label: 'Cierre limpio', ok: !!c && c.code === 1000 && !c.reconnecting, detail: c ? `código ${c.code}${c.reason ? ` '${c.reason}'` : ''}` : 'el canal no se cerró' },
      { label: 'Verificación', ok: o.verdict?.code === 'ok', detail: o.verdict ? `${o.verdict.code}${o.verdict.message ? `: ${o.verdict.message}` : ''}` : 'sin veredicto' },
      { label: 'Partida casual', ok: o.outcome?.kind === 'unrated', detail: o.outcome ? o.outcome.kind : 'sin resultado' },
      { label: 'Puntos para el nodo', ok: (o.ledger?.points ?? 0) > 0, detail: o.ledger ? String(o.ledger.points) : 'sin registro' },
    ];
    S.ok = S.checks.every((k) => k.ok);
    if (!S.ok) {
      S.error = `fallaron chequeos: ${S.checks
        .filter((k) => !k.ok)
        .map((k) => `${k.label} (${k.detail})`)
        .join('; ')}`;
      log(S.error);
      setState('error');
    } else {
      log(`listo: veredicto ${o.verdict?.code}, ${o.outcome?.kind}, ${o.ledger?.points} puntos`);
      setState('done');
    }
  } catch (e) {
    S.error = messageOf(e);
    log(`ERROR: ${S.error}`);
    // Best effort: free the seat so a failed run does not hold the node.
    if (placement && !left && S.playerId) {
      left = true;
      void call('POST', '/dev/leave', { matchId: placement.matchId, playerId: S.playerId }).catch(() => undefined);
    }
    setState('error');
  } finally {
    clearInterval(ticker);
    net?.dispose();
    running = false;
    render();
  }
}

// ---- wiring ---------------------------------------------------------------------------------

window.__harnessStart = run;
document.body.dataset.state = 'idle';
$('start')?.addEventListener('click', () => void run());
render();
if (new URLSearchParams(location.search).get('auto') === '1') void run();

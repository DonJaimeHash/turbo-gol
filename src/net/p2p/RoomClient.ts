/**
 * RoomClient: the WebSocket to the P2P signaling room (server/src/RoomDO.ts, docs/online/PHASE2.md).
 *
 *   connect(wsUrl, ticket)   new WebSocket(wsUrl, ['tg1', 'ticket.<jwt>']); JSON text frames in both
 *                            directions (RoomServerMessage in, RoomClientMessage out)
 *   callbacks                onWelcome / onPeerJoined / onPeerLeft / onSignal / onStart / onDrop /
 *                            onError / onClose, one per message type; an 'error' with code
 *                            ROOM_ERROR_SIGNAL_DROPPED (the target slot had no socket) goes to
 *                            onSignalDropped(to) instead of onError (the mesh re-offers); a
 *                            welcome of another P2P_PROTOCOL_VERSION fails with code
 *                            P2P_ERROR_RELOAD (the page is stale: the session says "reload")
 *   senders                  signal(to, data), ready(), unreachable(slot, atTick), hashReport(...)
 *   log                      every message in / out but ping / pong (signals: type only) goes to
 *                            the P2PLogSink of the options (P2PSession.log)
 *   clock                    a ping every ROOM_PING_INTERVAL_MS (setPingIntervalMs slows it down once
 *                            the match runs: the offset only matters for the start); each pong
 *                            { t0, now } gives one sample of rtt = t3 - t0 and offset = now - (t0 + t3) / 2
 *                            (server clock minus local clock, ms); both are medians over the last
 *                            ROOM_CLOCK_WINDOW samples. The Welcome's `now` seeds the offset (biased by
 *                            the whole one-way latency) so a `start` that arrives before the first pong
 *                            can still be placed on the local clock; the first pong discards it, so the
 *                            median never mixes the coarse sample with the real ones.
 *                            serverToLocal(startAt) = startAt - offset, in performance.now() units.
 *
 * The WebSocket and the clock are injectable (node tests). No allocations after construction on
 * the message path beyond JSON.parse of each (rare) signaling frame.
 */
import { resolveWsUrl, type WebSocketFactory, type WebSocketLike } from '../NetClient';
import { median } from '../ClockSync';
import { WS_SUBPROTOCOL, WS_TICKET_PREFIX } from '../protocol';
import type { P2PLogSink } from './DebugLog';
import { signalKind } from './Mesh';
import { P2P_ERROR_RELOAD, P2P_PROTOCOL_VERSION, ROOM_ERROR_SIGNAL_DROPPED, type RoomClientMessage, type RoomServerMessage, type RoomSlot, type RoomWelcome, type SignalData } from './protocol';

export const ROOM_PING_INTERVAL_MS = 2000;
/** Ping cadence once the match runs (keeps the room socket alive; the offset is no longer used). */
export const ROOM_PING_INTERVAL_MATCH_MS = 15_000;
/** Pongs kept for the rtt / offset medians. */
export const ROOM_CLOCK_WINDOW = 8;

const WS_OPEN = 1;

export interface RoomClientOptions {
  webSocketFactory?: WebSocketFactory;
  /** Local clock (performance.now by default): the t0 of the pings and the unit of serverToLocal. */
  now?: () => number;
  pingIntervalMs?: number;
  /** Debug ring (P2PSession.log); absent = silent. */
  log?: P2PLogSink;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

const NO_LOG: P2PLogSink = { push: () => undefined };

/** One line per slot for the log: `0:peer*` (connected), `1:peer` (absent), `1:peer-` (left), `2:bot`. */
export function describeSlots(slots: readonly RoomSlot[]): string {
  let s = '';
  for (let i = 0; i < slots.length; i++) {
    const e = slots[i];
    s += `${i > 0 ? ' ' : ''}${e.slot}:${e.kind}${e.connected ? '*' : e.left === true ? '-' : ''}`;
  }
  return s;
}

/** Structural check of a server frame: an object with a string `type` (the fields are checked per case). */
function isServerMessage(v: unknown): v is RoomServerMessage {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}

export class RoomClient {
  welcome: RoomWelcome | null = null;

  /** Median round trip to the room (ms) and median server clock - local clock (ms). */
  rttMs = 0;
  offsetMs = 0;
  /** Clock samples in the window (the Welcome counts as the first, coarse one). */
  samples = 0;
  messagesIn = 0;
  messagesOut = 0;

  onWelcome: ((w: RoomWelcome) => void) | null = null;
  onPeerJoined: ((slot: RoomSlot) => void) | null = null;
  onPeerLeft: ((slot: number, peerId: string) => void) | null = null;
  onSignal: ((from: number, data: SignalData) => void) | null = null;
  /** `startAt` on the server clock; use serverToLocal(startAt) for the local tick-0 time. */
  onStart: ((startAt: number, now: number) => void) | null = null;
  onDrop: ((slot: number, atTick: number) => void) | null = null;
  onError: ((code: string, message: string) => void) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  /** The room could not relay our signal to `to` (no socket there yet): not fatal. */
  onSignalDropped: ((to: number) => void) | null = null;

  private readonly makeWs: WebSocketFactory;
  private readonly now: () => number;
  private readonly pingIntervalMs: number;
  private readonly log: P2PLogSink;
  private ws: WebSocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingEveryMs: number;
  /** The window holds only the Welcome's coarse sample (dropped by the first pong). */
  private coarseOnly = false;

  private readonly rtts = new Float64Array(ROOM_CLOCK_WINDOW);
  private readonly offsets = new Float64Array(ROOM_CLOCK_WINDOW);
  private readonly scratch = new Float64Array(ROOM_CLOCK_WINDOW);
  private head = 0;

  constructor(opts: RoomClientOptions = {}) {
    this.makeWs = opts.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
    this.now = opts.now ?? defaultNow;
    this.pingIntervalMs = opts.pingIntervalMs ?? ROOM_PING_INTERVAL_MS;
    this.pingEveryMs = this.pingIntervalMs;
    this.log = opts.log ?? NO_LOG;
  }

  /** Open the room socket; the ticket (role 'peer') travels in the subprotocol list. */
  connect(wsUrl: string, ticket: string): void {
    this.closeSocket(1000, 'reconnect');
    this.welcome = null;
    this.resetClock();
    const url = resolveWsUrl(wsUrl);
    this.log.push('room.connect', url);
    const ws = this.makeWs(url, [WS_SUBPROTOCOL, WS_TICKET_PREFIX + ticket]);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.log.push('room.open');
      this.startPing();
    };
    ws.onmessage = (ev) => {
      if (ws === this.ws) this.handleMessage(ev.data);
    };
    ws.onclose = (ev) => this.handleClose(ws, ev.code, ev.reason);
    ws.onerror = () => {
      /* a close event follows */
    };
    this.ws = ws;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  /** Send one client message; false when the socket is not open. */
  send(msg: RoomClientMessage): boolean {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WS_OPEN) return false;
    ws.send(JSON.stringify(msg));
    this.messagesOut++;
    return true;
  }

  /** Relay a WebRTC offer / answer / ICE candidate to `to` through the room. */
  signal(to: number, data: SignalData): boolean {
    const ok = this.send({ type: 'signal', to, data });
    if (!ok) this.log.push('room.sig.unsent', `${to} ${signalKind(data)} (socket not open)`);
    return ok;
  }

  /** Mesh complete on my side and the game loaded: the room starts once every peer said so. */
  ready(): boolean {
    const ok = this.send({ type: 'ready' });
    this.log.push('room.ready>', ok ? 'sent' : 'NOT sent (socket not open)');
    return ok;
  }

  unreachable(slot: number, atTick: number): boolean {
    const ok = this.send({ type: 'unreachable', slot, atTick });
    this.log.push('room.unreachable>', `slot ${slot} atTick ${atTick}${ok ? '' : ' NOT sent'}`);
    return ok;
  }

  hashReport(tick: number, hash: number, agree: number, disagree: number): boolean {
    return this.send({ type: 'hashReport', tick, hash, agree, disagree });
  }

  /** Public for tests / manual probes; the interval calls it. */
  sendPing(): boolean {
    return this.send({ type: 'ping', t0: this.now() });
  }

  /** Change the ping cadence (e.g. ROOM_PING_INTERVAL_MATCH_MS once the match runs); restarts the timer when it runs. */
  setPingIntervalMs(ms: number): void {
    const v = ms > 0 ? ms : this.pingIntervalMs;
    if (v === this.pingEveryMs) return;
    this.pingEveryMs = v;
    if (this.pingTimer !== null) this.startTimer();
  }

  /** A server-clock timestamp (ms since the epoch) on the local clock (the `now` option's units). */
  serverToLocal(serverMs: number): number {
    return serverMs - this.offsetMs;
  }

  /** Close on purpose (1000 = leaving); onClose still fires when the socket reports it. */
  close(code = 1000, reason = ''): void {
    this.closeSocket(code, reason);
  }

  dispose(): void {
    this.close(1000, 'dispose');
    this.onWelcome = null;
    this.onPeerJoined = null;
    this.onPeerLeft = null;
    this.onSignal = null;
    this.onStart = null;
    this.onDrop = null;
    this.onError = null;
    this.onClose = null;
    this.onSignalDropped = null;
  }

  /** Feed one clock sample (t3 = local receive time of a pong carrying `serverNow`). Public for tests. */
  addClockSample(t0: number, serverNow: number, t3: number): void {
    const rtt = t3 - t0;
    const offset = serverNow - (t0 + t3) / 2;
    const i = this.head;
    this.rtts[i] = rtt < 0 ? 0 : rtt;
    this.offsets[i] = offset;
    this.head = (i + 1) % ROOM_CLOCK_WINDOW;
    if (this.samples < ROOM_CLOCK_WINDOW) this.samples++;
    this.rttMs = median(this.rtts, this.samples, this.scratch);
    this.offsetMs = median(this.offsets, this.samples, this.scratch);
  }

  // ---- internals -------------------------------------------------------------------------

  private resetClock(): void {
    this.samples = 0;
    this.head = 0;
    this.rttMs = 0;
    this.offsetMs = 0;
    this.coarseOnly = false;
  }

  private startPing(): void {
    this.pingEveryMs = this.pingIntervalMs;
    this.startTimer();
    this.sendPing();
  }

  private startTimer(): void {
    this.stopPing();
    const timer: unknown = setInterval(() => this.sendPing(), this.pingEveryMs);
    // Under node (tests) a live interval would keep the process alive after the test ends.
    if (typeof timer === 'object' && timer !== null && typeof (timer as { unref?: unknown }).unref === 'function') {
      (timer as { unref(): void }).unref();
    }
    this.pingTimer = timer as ReturnType<typeof setInterval>;
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      this.fail('protocol', 'malformed room message');
      return;
    }
    if (!isServerMessage(msg)) {
      this.fail('protocol', 'malformed room message');
      return;
    }
    this.messagesIn++;
    switch (msg.type) {
      case 'room': {
        if (msg.protocol !== P2P_PROTOCOL_VERSION) {
          // This page is older (or newer) than the room server: the session tells the player to reload.
          this.fail(P2P_ERROR_RELOAD, `room protocol ${msg.protocol} (client ${P2P_PROTOCOL_VERSION})`);
          return;
        }
        this.welcome = msg;
        this.log.push('room.welcome', `${msg.roomId.slice(0, 8)} ${msg.mode} seed ${msg.seed} you ${msg.you.slot} slots [${describeSlots(msg.slots)}] ice ${msg.iceServers.length}`);
        // A coarse first offset (biased by the one-way latency): only until the first pong.
        if (typeof msg.now === 'number' && this.samples === 0) {
          const t = this.now();
          this.addClockSample(t, msg.now, t);
          this.coarseOnly = true;
        }
        if (this.onWelcome) this.onWelcome(msg);
        return;
      }
      case 'peerJoined':
        this.log.push('room.peerJoined', `slot ${msg.slot.slot} ${msg.slot.kind}${msg.slot.connected ? '*' : ''} ${msg.slot.name}`);
        if (this.onPeerJoined) this.onPeerJoined(msg.slot);
        return;
      case 'peerLeft':
        this.log.push('room.peerLeft', `slot ${msg.slot}`);
        if (this.onPeerLeft) this.onPeerLeft(msg.slot, msg.peerId);
        return;
      case 'signal':
        if (this.onSignal) this.onSignal(msg.from, msg.data);
        return;
      case 'start':
        this.log.push('room.start', `startAt ${msg.startAt} (server now ${msg.now}, +${msg.startAt - msg.now} ms) offset ${this.offsetMs.toFixed(1)} rtt ${this.rttMs.toFixed(1)} samples ${this.samples}`);
        if (this.onStart) this.onStart(msg.startAt, msg.now);
        return;
      case 'drop':
        this.log.push('room.drop', `slot ${msg.slot} atTick ${msg.atTick}`);
        if (this.onDrop) this.onDrop(msg.slot, msg.atTick);
        return;
      case 'pong':
        if (this.coarseOnly) this.resetClock();
        this.addClockSample(msg.t0, msg.now, this.now());
        return;
      case 'error':
        if (msg.code === ROOM_ERROR_SIGNAL_DROPPED) {
          const to = typeof msg.to === 'number' ? msg.to : -1;
          this.log.push('room.sig.dropped', `to ${to}`);
          if (this.onSignalDropped) this.onSignalDropped(to);
          return;
        }
        this.log.push('room.error', `${msg.code} ${msg.message ?? ''}`);
        if (this.onError) this.onError(msg.code, msg.message ?? 'room error');
        return;
      default:
        return;
    }
  }

  private fail(code: string, message: string): void {
    this.log.push('room.fail', `${code} ${message}`);
    if (this.onError) this.onError(code, message);
    this.close(1002, message);
  }

  private handleClose(ws: WebSocketLike, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.stopPing();
    this.log.push('room.close', `${code} ${reason}`);
    if (this.onClose) this.onClose(code, reason);
  }

  private closeSocket(code: number, reason: string): void {
    const ws = this.ws;
    this.stopPing();
    if (ws === null) return;
    this.ws = null;
    this.log.push('room.closing', `${code} ${reason}`);
    try {
      ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}

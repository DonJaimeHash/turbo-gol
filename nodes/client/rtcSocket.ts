/**
 * The player's side of a WebRTC node: a WebSocketLike over one DataChannel, so NetClient plays on a
 * home PC exactly as it plays on a Durable Object or a VPS. The integration is one line where the
 * game creates its NetClient:
 *
 *   new NetClient({ ..., webSocketFactory: nodeAwareSocketFactory() })
 *
 * The factory recognises the URL the matchmaker hands out for an rtc node,
 * wss://<site>/nodes/rtc/<nodeId>/<matchId> (shared/controlProtocol.ts rtcMatchUrl), and every
 * other URL still opens a normal WebSocket. The ticket is the one NetClient already puts in the
 * subprotocol list, so nothing else in the client changes.
 *
 *   1. POST <url as https>/ice   { ticket } -> { iceServers }  (STUN + TURN credentials for this seat)
 *   2. RTCPeerConnection, DataChannel 'tg' (reliable, ordered), offer, gather candidates (<= 2.5 s)
 *   3. POST <url as https>/offer { ticket, sdp } -> { sdp }    (the node's answer, relayed)
 *   4. the channel opens -> onopen, then frames flow both ways exactly as over the WebSocket
 *
 * Close codes: the first byte 0xFE marks a close frame [0xFE, code, reason] in both directions
 * (a DataChannel has no close codes; NetClient's reconnect logic needs them). Whoever receives a
 * close frame closes the channel at once; that close is the acknowledgement the sender waits for
 * (at most CLOSE_TIMEOUT_MS) before tearing the peer connection down, so a frame SCTP still has to
 * retransmit is not aborted. A connection that fails before opening ends with onerror + onclose
 * 1006, like a refused WebSocket.
 *
 * No DOM types are required: RTCPeerConnection and fetch are injectable (Node tests use werift).
 */
import { WS_SUBPROTOCOL, WS_TICKET_PREFIX } from '../../src/net/protocol';
import type { WebSocketFactory, WebSocketLike } from '../../src/net/NetClient';
import { RTC_CHANNEL, RTC_PATH, decodeRtcClose, encodeRtcClose } from '../shared/controlProtocol';
import type { IceServer } from '../shared/controlProtocol';

export const GATHER_TIMEOUT_MS = 2_500;
export const CONNECT_TIMEOUT_MS = 15_000;
/** After our close frame, how long the node gets to close the channel (its acknowledgement). */
export const CLOSE_TIMEOUT_MS = 2_500;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** The parts of RTCDataChannel this adapter uses (browser or werift). */
export interface DataChannelLike {
  readonly readyState: string;
  binaryType?: string;
  onopen: (() => void) | null | undefined;
  onclose: (() => void) | null | undefined;
  onmessage: ((ev: { data: unknown }) => void) | null | undefined;
  send(data: Uint8Array): void;
  close(): void;
}

/** The parts of RTCPeerConnection this adapter uses (browser or werift). */
export interface PeerLike {
  readonly iceGatheringState: string;
  readonly connectionState: string;
  readonly localDescription: { sdp: string } | null;
  onicegatheringstatechange: (() => void) | null | undefined;
  onconnectionstatechange: (() => void) | null | undefined;
  createDataChannel(label: string, init: { ordered: boolean }): DataChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(desc: { type: string; sdp?: string }): Promise<unknown>;
  setRemoteDescription(desc: { type: 'answer'; sdp: string }): Promise<unknown>;
  close(): unknown;
}

export interface RtcSocketDeps {
  fetchFn?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  createPeer?: (config: { iceServers: IceServer[] }) => PeerLike;
  gatherTimeoutMs?: number;
  connectTimeoutMs?: number;
}

/** True for URLs the matchmaker gives out for matches on WebRTC nodes. */
export function isRtcNodeUrl(url: string): boolean {
  try {
    return RTC_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** NetClient's webSocketFactory: WebRTC for rtc nodes, the given (default: native) WebSocket otherwise. */
export function nodeAwareSocketFactory(fallback?: WebSocketFactory, deps: RtcSocketDeps = {}): WebSocketFactory {
  return (url, protocols) => {
    if (isRtcNodeUrl(url)) return new RtcSocket(url, protocols, deps);
    if (fallback) return fallback(url, protocols);
    return new WebSocket(url, protocols) as unknown as WebSocketLike;
  };
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export class RtcSocket implements WebSocketLike {
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  protocol = '';
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private state = CONNECTING;
  private pc: PeerLike | null = null;
  private dc: DataChannelLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The close frame we sent, while the node has not closed the channel yet. */
  private closing: { code: number; reason: string } | null = null;
  private readonly url: string;
  private readonly deps: RtcSocketDeps;

  constructor(url: string, protocols: string[], deps: RtcSocketDeps = {}) {
    this.url = url;
    this.deps = deps;
    const ticket = protocols.find((p) => p.startsWith(WS_TICKET_PREFIX))?.slice(WS_TICKET_PREFIX.length) ?? '';
    this.timer = setTimeout(() => this.fail('timeout'), deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    // Like the WebSocket constructor: the handshake starts at once, events come later.
    void this.start(ticket).catch((e: unknown) => this.fail(e instanceof Error ? e.message : String(e)));
  }

  get readyState(): number {
    return this.state;
  }

  private base(): string {
    return this.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  }

  private async post<T>(path: string, body: object): Promise<T> {
    const f = this.deps.fetchFn ?? ((u, init) => fetch(u, init));
    const res = await f(this.base() + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`signaling ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  private async start(ticket: string): Promise<void> {
    if (!ticket) throw new Error('no ticket');
    const { iceServers } = await this.post<{ iceServers: IceServer[] }>('/ice', { ticket });
    if (this.state !== CONNECTING) return;
    const create = this.deps.createPeer ?? ((cfg) => new RTCPeerConnection(cfg as RTCConfiguration) as unknown as PeerLike);
    const pc = create({ iceServers: Array.isArray(iceServers) ? iceServers : [] });
    this.pc = pc;
    const dc = pc.createDataChannel(RTC_CHANNEL, { ordered: true });
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => this.opened();
    dc.onmessage = (ev) => {
      // RFC 8832: data on a channel whose ACK has not arrived yet is an implicit ACK.
      if (this.state === CONNECTING) this.opened();
      this.receive(ev.data);
    };
    dc.onclose = () => this.channelClosed();
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.fail('ice failed');
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.gathered(pc);
    if (this.state !== CONNECTING) return;
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('no offer');
    const answer = await this.post<{ sdp: string }>('/offer', { ticket, sdp });
    if (this.state !== CONNECTING) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  }

  private opened(): void {
    if (this.state !== CONNECTING || !this.dc) return;
    this.state = OPEN;
    this.protocol = WS_SUBPROTOCOL;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.onopen?.({ type: 'open' } as unknown as Event);
  }

  private gathered(pc: PeerLike): Promise<void> {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const t = setTimeout(resolve, this.deps.gatherTimeoutMs ?? GATHER_TIMEOUT_MS);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(t);
          resolve();
        }
      };
    });
  }

  private receive(data: unknown): void {
    if (this.state !== OPEN && this.state !== CLOSING) return;
    const bytes = toBytes(data);
    if (!bytes) {
      if (typeof data === 'string' && this.state === OPEN) this.onmessage?.({ data } as MessageEvent);
      return;
    }
    const c = decodeRtcClose(bytes);
    if (c) {
      // The node's close frame (or its own close crossing ours): close the channel right away,
      // which is the acknowledgement the node waits for. The code is the node's, like a WebSocket.
      this.finish(c.code, c.reason, true);
      return;
    }
    if (this.state !== OPEN) return;
    // NetClient sets binaryType 'arraybuffer' and reads ev.data as an ArrayBuffer.
    const out = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    this.onmessage?.({ data: out } as MessageEvent);
  }

  send(data: Uint8Array | string): void {
    if (this.state !== OPEN || !this.dc) return;
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    try {
      this.dc.send(bytes);
    } catch {
      this.finish(1006, '', false);
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.state === CLOSING || this.state === CLOSED) return;
    if (this.state === CONNECTING) {
      this.finish(code, reason, false);
      return;
    }
    this.state = CLOSING;
    this.closing = { code, reason };
    try {
      this.dc?.send(encodeRtcClose(code, reason));
    } catch {
      this.finish(code, reason, false);
      return;
    }
    // The node closes the channel as soon as it decodes the frame (channelClosed below). Closing
    // the peer connection first would abort SCTP, and a frame it still had to retransmit is lost.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.finish(code, reason, false), CLOSE_TIMEOUT_MS);
  }

  /** The channel closed under us: the node's acknowledgement of our close frame, or the node gone. */
  private channelClosed(): void {
    if (this.state === CLOSING && this.closing) this.finish(this.closing.code, this.closing.reason, true);
    else if (this.state === CONNECTING) this.fail('channel closed');
    else this.finish(1006, '', false);
  }

  /** A connection that never opened: error then close 1006, like a refused WebSocket. */
  private fail(why: string): void {
    if (this.state === CLOSED) return;
    if (this.state === CLOSING && this.closing) {
      // Our close frame is out: report our code, but not as a clean close.
      this.finish(this.closing.code, this.closing.reason, false);
      return;
    }
    const wasConnecting = this.state === CONNECTING;
    if (wasConnecting) this.onerror?.({ type: 'error', message: why } as unknown as Event);
    this.finish(1006, wasConnecting ? '' : why, false);
  }

  private finish(code: number, reason: string, clean: boolean): void {
    if (this.state === CLOSED) return;
    this.state = CLOSED;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const dc = this.dc;
    const pc = this.pc;
    this.dc = null;
    this.pc = null;
    try {
      if (dc) {
        dc.onopen = null;
        dc.onmessage = null;
        dc.onclose = null;
        dc.close();
      }
    } catch {
      /* gone */
    }
    try {
      pc?.close();
    } catch {
      /* gone */
    }
    this.onclose?.({ type: 'close', code, reason, wasClean: clean } as unknown as CloseEvent);
  }
}

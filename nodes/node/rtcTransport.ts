/**
 * WebRTC transport: how a home PC behind NAT or CGNAT hosts matches without opening ports.
 *
 * A player's browser opens ONE DataChannel ('tg', reliable and ordered) to the node and sends the
 * very same frames it would send over the WebSocket; the node answers with the very same frames.
 * RtcConn implements the WsConn interface of wsServer.ts, so MatchRoom cannot tell the two
 * transports apart. Reliable + ordered on purpose: NetClient expects WebSocket ordering (a stale
 * snapshot after a newer one would roll the prediction back). Unordered game channels are a later
 * optimisation that needs client changes.
 *
 * Signaling is a single offer / answer relayed by the control plane (no trickle: both sides
 * gather their candidates first, a few hundred ms with healthy STUN / TURN servers). The answer
 * goes out within GATHER_TIMEOUT_MS whatever the servers do: werift's setLocalDescription() waits
 * for the whole gathering, so it is raced against that budget and, past it, the answer carries the
 * candidates found so far and the ICE checks start at once (werift alone would start them only
 * when its gathering gives up on the dead server, 6 to 13 s later). ICE then finds the best path:
 * host (same LAN), srflx (NAT hole punching) or relay (TURN, always works).
 *
 * Close codes: a DataChannel has none, so a close frame [0xFE, code, reason] goes first
 * (shared/controlProtocol.ts encodeRtcClose). NetClient keys its reconnect logic on them. The
 * side that receives a close frame closes the channel at once; that close is the
 * acknowledgement the sender waits for before it tears the connection down.
 *
 * Uses werift (pure TypeScript WebRTC): one bundle for Windows, macOS and Linux, no native binaries.
 */
import { RTCPeerConnection } from 'werift';
import { RTC_CHANNEL, decodeRtcClose, encodeRtcClose } from '../shared/controlProtocol';
import type { IceServer } from '../shared/controlProtocol';
import type { WsConn } from './wsServer';

/** Candidate gathering budget: the answer goes out by then with the candidates found so far. */
export const GATHER_TIMEOUT_MS = 4_000;
/** The player's DataChannel must open this long after the answer, or the attempt is dropped. */
export const CHANNEL_TIMEOUT_MS = 20_000;
/**
 * After a close frame, wait this long for the peer to close the channel (its acknowledgement)
 * before tearing down. Tearing down at once aborts SCTP without a flush (pc.close() sends ABORT),
 * so a close frame lost on the way (SCTP retransmits after >= 1 s) would reach nobody.
 */
export const CLOSE_ACK_TIMEOUT_MS = 2_500;
/**
 * werift's own gathering limits, in seconds: how long it waits for a STUN answer, and for a TCP /
 * TLS connection to the TURN server once its UDP allocation attempt gave up. Both fit in
 * GATHER_TIMEOUT_MS, so a dead STUN server never delays the answer. The UDP TURN allocation itself
 * follows werift's fixed STUN retry schedule (about 6.4 s, then the TCP attempt): a dead TURN
 * server keeps werift gathering past GATHER_TIMEOUT_MS, which is why the answer is raced against
 * it and the ICE checks are started at the deadline (shareIceStart). Timeline with a dead TURN
 * server: answer at GATHER_TIMEOUT_MS, channel open one or two round trips later, well inside the
 * control plane's RTC_OFFER_TIMEOUT_MS (10 s, answer only) and the client's CONNECT_TIMEOUT_MS
 * (15 s, from /ice to open). A relay candidate allocated after the deadline is not used: it is
 * not in the answer either.
 */
const STUN_GATHER_TIMEOUT_S = 3;
const TURN_CONNECT_TIMEOUT_S = 3;
/** A peer whose unsent backlog exceeds this is too slow to play: closed 1008 'slow'. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
/** A transient 'disconnected' ICE state is given this long to recover before the socket closes. */
const DISCONNECTED_GRACE_MS = 4_000;

export interface RtcConfig {
  iceServers: IceServer[];
  /** Host-candidate UDP port range (for operators who want a firewall rule), e.g. [50000, 50200]. */
  portRange?: [number, number];
  /** Extra host addresses to offer (tests: '127.0.0.1'). */
  extraHostAddresses?: string[];
}

type Pc = InstanceType<typeof RTCPeerConnection>;
type Dc = ReturnType<Pc['createDataChannel']>;
/** A local candidate as werift reports it ('candidate:...' line without the 'a='). */
interface FoundCandidate {
  candidate: string;
  sdpMLineIndex?: number;
}

/** werift's pending gathering (its setLocalDescription()) per peer connection; never rejects. */
const gatherings = new WeakMap<Pc, Promise<void>>();

/**
 * Close `pc`. werift adds a TURN allocation (or a host socket) that completes after close() to the
 * ICE connection close() already emptied, and nothing ever closes its socket or stops its refresh
 * loop: while werift is still gathering, close the ICE connections again once it is over.
 */
function shut(pc: Pc): Promise<void> {
  const gathering = gatherings.get(pc);
  if (gathering && pc.iceGatheringState !== 'complete') {
    const ice = pc.iceTransports.map((t) => t.connection);
    void gathering.then(() => Promise.all(ice.map((c) => c.close()))).catch(() => undefined);
  }
  return pc.close().catch(() => undefined);
}

/**
 * Let ICE start before werift's gathering is over. An answerer's werift starts the checks
 * (RTCPeerConnection.connect(), private in its typings) only once the gathering ends, and running
 * them a second time on a live connection leaves ICE stuck in 'checking'. So every call shares one
 * run: werift's own later call joins the run started here. Install before setRemoteDescription();
 * returns the starter, a no-op once the gathering is over (werift has started ICE itself) and on a
 * werift without that method (then ICE starts when its gathering ends, as before).
 */
function shareIceStart(pc: Pc): () => void {
  const self = pc as unknown as { connect?: () => Promise<void> };
  const own = self.connect;
  if (typeof own !== 'function') return () => undefined;
  let run: Promise<void> | null = null;
  const once = (): Promise<void> => (run ??= own.call(pc));
  self.connect = once;
  return () => {
    if (pc.iceGatheringState === 'gathering') void once().catch(() => undefined);
  };
}

function peer(cfg: RtcConfig, relayOnly = false): Pc {
  return new RTCPeerConnection({
    iceServers: cfg.iceServers,
    iceTransportPolicy: relayOnly ? 'relay' : 'all',
    iceStunGatherTimeout: STUN_GATHER_TIMEOUT_S,
    iceTurnConnectTimeout: TURN_CONNECT_TIMEOUT_S,
    ...(cfg.portRange ? { icePortRange: cfg.portRange } : {}),
    ...(cfg.extraHostAddresses ? { iceAdditionalHostAddresses: cfg.extraHostAddresses } : {}),
    iceUseIpv6: false,
  });
}

/**
 * `sdp` with `found` added as a=candidate lines to their m-sections (before the section's first
 * attribute, after its c= line, where werift writes them). werift's description from before the
 * gathering ended has none.
 */
export function withCandidates(sdp: string, found: readonly FoundCandidate[]): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const out: string[] = [];
  let section = -1;
  let placed = true;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      section++;
      placed = false;
    } else if (!placed && line.startsWith('a=')) {
      placed = true;
      const seen = new Set(lines);
      for (const c of found) {
        const add = `a=${c.candidate}`;
        if ((c.sdpMLineIndex ?? 0) !== section || seen.has(add)) continue;
        seen.add(add);
        out.push(add);
      }
    }
    out.push(line);
  }
  return out.join(eol);
}

/**
 * Create and set the local offer / answer, and return its SDP by `deadline` (performance.now()
 * time) at the latest. werift's setLocalDescription() awaits the whole candidate gathering (a STUN
 * or TURN server that never answers holds it for seconds), but the description itself is set
 * before that: past the deadline it goes out with the candidates found so far. Candidates found
 * later go to `onLate` (in-process peers can trickle them); a real answer just goes without them.
 */
async function describe(pc: Pc, kind: 'offer' | 'answer', deadline: number, onLate?: (c: FoundCandidate) => void): Promise<string> {
  const found: FoundCandidate[] = [];
  let sent = false;
  const sub = pc.onIceCandidate.subscribe((c) => {
    if (!c || typeof c.candidate !== 'string' || c.candidate === '') return;
    const fc: FoundCandidate = { candidate: c.candidate, ...(typeof c.sdpMLineIndex === 'number' ? { sdpMLineIndex: c.sdpMLineIndex } : {}) };
    if (!sent) found.push(fc);
    else onLate?.(fc);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete = false;
  try {
    const desc = kind === 'offer' ? await pc.createOffer() : await pc.createAnswer();
    const set = pc.setLocalDescription(desc).then(() => true);
    // Past the deadline nobody awaits it: a late failure (or a close() mid-gathering) ends here.
    gatherings.set(
      pc,
      set.then(
        () => undefined,
        () => undefined,
      ),
    );
    const budget = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now()));
    });
    complete = await Promise.race([set, budget]);
  } finally {
    if (timer) clearTimeout(timer);
    sent = true;
    if (!onLate) sub.unSubscribe();
  }
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error('no local description');
  return complete ? sdp : withCandidates(sdp, found);
}

/** The selected candidate pair goes through a TURN relay (a relay candidate on either end). */
function relayed(pc: Pc): boolean {
  for (const t of pc.iceTransports) {
    const pair = t.getSelectedCandidatePair();
    if (pair && [pair.local, pair.remote].some((c) => / typ relay(?: |$)/.test(c?.candidate ?? ''))) return true;
  }
  return false;
}

/** One player's DataChannel as a WsConn. */
export class RtcConn implements WsConn {
  readonly protocol: string;
  readonly remoteAddress = 'webrtc';
  onmessage: ((data: Uint8Array, text: boolean) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  bytesSent = 0;
  private readonly pc: Pc;
  private readonly dc: Dc;
  private isOpen = true;
  private finalized = false;
  /** The code / reason of the close frame we sent, while we wait for the peer to close. */
  private closing: { code: number; reason: string } | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private discTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(pc: Pc, dc: Dc, protocol: string) {
    this.pc = pc;
    this.dc = dc;
    this.protocol = protocol;
    dc.onMessage.subscribe((data) => this.receive(data));
    dc.stateChanged.subscribe((s) => {
      if (s === 'closed') this.gone();
    });
    pc.connectionStateChange.subscribe((s) => {
      if (s === 'failed' || s === 'closed') this.gone();
      else if (s === 'disconnected') {
        if (!this.discTimer) this.discTimer = setTimeout(() => this.gone(), DISCONNECTED_GRACE_MS);
      } else if (s === 'connected' && this.discTimer) {
        clearTimeout(this.discTimer);
        this.discTimer = null;
      }
    });
  }

  get open(): boolean {
    return this.isOpen;
  }

  get bufferedAmount(): number {
    return this.dc.bufferedAmount;
  }

  send(data: Uint8Array | string): void {
    if (!this.isOpen) return;
    if (this.dc.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.close(1008, 'slow');
      return;
    }
    // Copy: callers reuse their output buffers (snapshots) and werift sends asynchronously.
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    try {
      this.dc.send(Buffer.from(bytes));
      this.bytesSent += bytes.length;
    } catch {
      this.finalize(1006, '');
    }
  }

  /**
   * Send the close frame, then wait for the peer to close the channel (it does so as soon as it
   * decodes the frame) or CLOSE_ACK_TIMEOUT_MS, whichever comes first. onclose reports our code.
   */
  close(code = 1000, reason = ''): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.closing = { code, reason };
    try {
      this.dc.send(Buffer.from(encodeRtcClose(code, reason)));
    } catch {
      this.finalize(code, reason);
      return;
    }
    this.closeTimer = setTimeout(() => this.finalize(code, reason), CLOSE_ACK_TIMEOUT_MS);
  }

  /** The channel or the peer connection went away: the acknowledgement of our close frame, if we sent one. */
  private gone(): void {
    if (this.closing) this.finalize(this.closing.code, this.closing.reason);
    else this.finalize(1006, '');
  }

  private receive(data: string | Uint8Array): void {
    if (this.finalized) return;
    if (typeof data === 'string') {
      if (this.isOpen) this.onmessage?.(new TextEncoder().encode(data), true);
      return;
    }
    const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const c = decodeRtcClose(u8);
    if (c) {
      // The peer's own close (or both closed at once): closing the channel at once acknowledges it.
      this.finalize(this.closing?.code ?? c.code, this.closing?.reason ?? c.reason);
      return;
    }
    if (!this.isOpen) return;
    try {
      this.onmessage?.(u8, false);
    } catch (e) {
      console.error('rtc onmessage threw', e);
    }
  }

  private finalize(code: number, reason: string): void {
    if (this.finalized) return;
    this.finalized = true;
    this.isOpen = false;
    if (this.discTimer) clearTimeout(this.discTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.discTimer = null;
    this.closeTimer = null;
    try {
      this.dc.close();
    } catch {
      /* gone */
    }
    void shut(this.pc);
    const cb = this.onclose;
    this.onclose = null;
    this.onmessage = null;
    try {
      cb?.(code, reason);
    } catch (e) {
      console.error('rtc onclose threw', e);
    }
  }
}

/**
 * Answer a player's offer. Resolves with the answer SDP within GATHER_TIMEOUT_MS (with the
 * candidates gathered by then). `onConn` fires later with an open connection, once the player's
 * 'tg' DataChannel is open. `onDrop` runs instead (the caller frees the seat it reserved) when the
 * channel never opens within CHANNEL_TIMEOUT_MS, ICE fails first, or the channel dies before it
 * could be handed over. Exactly one of the two runs, unless this function throws (then neither).
 */
export async function answerOffer(offerSdp: string, cfg: RtcConfig, protocol: string, onConn: (c: RtcConn) => void, onDrop: () => void): Promise<string> {
  if (typeof offerSdp !== 'string' || offerSdp.length > 32 * 1024 || !offerSdp.startsWith('v=0')) throw new Error('bad offer');
  const deadline = performance.now() + GATHER_TIMEOUT_MS;
  const pc = peer(cfg);
  const startIce = shareIceStart(pc);
  let done = false;
  const drop = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    void shut(pc);
    onDrop();
  };
  const timer = setTimeout(drop, CHANNEL_TIMEOUT_MS);
  pc.onDataChannel.subscribe((dc) => {
    if (dc.label !== RTC_CHANNEL || done) {
      dc.close();
      return;
    }
    const ready = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const conn = new RtcConn(pc, dc, protocol);
      // Attach on the next turn: werift queues the DCEP ACK right after this callback, and the
      // Welcome must not overtake it (browsers would take it as an implicit ACK, other stacks drop it).
      // The channel can die in between (a close frame in the same packet, the peer gone): a dead
      // connection is never handed over, its seat is freed like one that never opened.
      setTimeout(() => {
        if (conn.open) onConn(conn);
        else onDrop();
      }, 0);
    };
    if (dc.readyState === 'open') ready();
    else dc.stateChanged.subscribe((s) => s === 'open' && ready());
  });
  let answer: string;
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    answer = await describe(pc, 'answer', deadline);
  } catch (e) {
    // The caller frees the seat when this throws: no onDrop on top of that.
    done = true;
    clearTimeout(timer);
    void shut(pc);
    throw e;
  }
  // Past the deadline werift is still gathering (a dead TURN server): check the paths we have now.
  startIce();
  // ICE or DTLS giving up before the channel opens frees the seat now rather than at the timeout.
  const failed = (s: string): void => {
    if (s === 'failed' || s === 'closed') drop();
  };
  pc.connectionStateChange.subscribe(failed);
  failed(pc.connectionState);
  return answer;
}

export interface SelfTest {
  ok: boolean;
  /** The channel opened over a TURN relay (the selected candidate pair is a relay pair). */
  relay: boolean;
  ms: number;
  error?: string;
}

/** The entry werift takes its TURN server from: the first turn: / turns: url, if any. */
function turnEntry(servers: readonly IceServer[]): IceServer | null {
  for (const s of servers) {
    for (const u of Array.isArray(s.urls) ? s.urls : [s.urls]) if (typeof u === 'string' && /^turns?:/i.test(u.trim())) return s;
  }
  return null;
}

/**
 * Can players reach this machine? Two peers in this process connect through the configured ICE
 * servers; with a TURN server one side is relay-only, which proves the worst case (a player
 * behind any NAT can always reach us through the relay). Without TURN (local development) the
 * host candidates are enough: ok, but relay is false, and a control plane that hands out TURN
 * does not take that as proof. A TURN server without username and credential is an error
 * (ok false): werift would skip it silently and the relay-only side would gather host candidates.
 *
 * Signaling is bounded like a real answer (GATHER_TIMEOUT_MS per side, late candidates trickled
 * between the two in-process peers, the answerer's ICE started at its deadline like answerOffer's);
 * `timeoutMs` for the channel to open starts after it.
 */
export async function rtcSelfTest(cfg: RtcConfig, timeoutMs = 12_000): Promise<SelfTest> {
  const t0 = performance.now();
  const turn = turnEntry(cfg.iceServers);
  if (turn && !(turn.username && turn.credential)) return { ok: false, relay: false, ms: 0, error: 'TURN server without username / credential' };
  const a = peer(cfg, turn !== null);
  const b = peer(cfg);
  const startIceB = shareIceStart(b);
  let relay = false;
  const finish = async (ok: boolean, error?: string): Promise<SelfTest> => {
    await Promise.all([shut(a), shut(b)]);
    return { ok, relay, ms: Math.round(performance.now() - t0), ...(error ? { error } : {}) };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const dc = a.createDataChannel(RTC_CHANNEL, { ordered: true });
    let markOpen: () => void = () => undefined;
    const opened = new Promise<boolean>((resolve) => {
      markOpen = () => resolve(true);
    });
    dc.stateChanged.subscribe((s) => {
      if (s === 'open') markOpen();
    });
    const trickle = (to: Pc) => (c: FoundCandidate) => void to.addIceCandidate(c).catch(() => undefined);
    const offer = await describe(a, 'offer', performance.now() + GATHER_TIMEOUT_MS, trickle(b));
    await b.setRemoteDescription({ type: 'offer', sdp: offer });
    const answer = await describe(b, 'answer', performance.now() + GATHER_TIMEOUT_MS, trickle(a));
    startIceB();
    await a.setRemoteDescription({ type: 'answer', sdp: answer });
    const ok = await Promise.race([
      opened,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (ok) relay = relayed(a);
    return await finish(ok, undefined);
  } catch (e) {
    return await finish(false, e instanceof Error ? e.message : String(e));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

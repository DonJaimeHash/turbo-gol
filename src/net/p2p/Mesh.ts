/**
 * Mesh: one RTCPeerConnection per other human peer of a P2P room (docs/online/PHASE2.md).
 *
 *   negotiation   "perfect negotiation" (WebRTC spec / MDN): the peer with the HIGHER slot is polite
 *                 (it rolls back on an offer collision), the lower slot is impolite and also the one
 *                 that creates both DataChannels, which triggers its offer; the higher slot gets the
 *                 channels through ondatachannel. Offers / answers / ICE candidates travel through
 *                 the room socket (`signal` option -> RoomClient.signal) and come back via
 *                 handleSignal(from, data). Trickle ICE.
 *   channels      'game' { ordered: false, maxRetransmits: 0 } for input batches,
 *                 'ctl' { ordered: true } for hashes / state resync; binaryType 'arraybuffer'. A
 *                 peer is connected once both channels are open; allConnected() is the mesh-complete
 *                 test (dropped peers do not count).
 *   receive       onGame(slot, bytes) / onCtl(slot, bytes) with a Uint8Array view over the frame
 *                 (no copy; valid during the callback).
 *   send          sendGame / sendCtl to one peer, broadcastGame / broadcastCtl to every connected one.
 *   stats         update(now) polls getStats() once per second per peer: selected candidate pair
 *                 type (host / srflx / relay), currentRoundTripTime, bytes (parsePeerStats, pure).
 *   liveness      update(now) marks a peer dead after GAME_DEAD_MS without a game packet (once
 *                 armLiveness() was called, i.e. the match started) or after ICE_DEAD_MS in
 *                 iceConnectionState failed / disconnected; one ICE restart is tried first. A dead
 *                 peer fires onPeerDead(slot) once; the room decides the drop (removePeer).
 *   TURN          on demand (no TURN in the room's welcome): the first peer still not connected
 *                 TURN_ASK_AFTER_MS after it was added, or whose ICE goes bad, fires
 *                 onIceTrouble(slot) once; the session asks the room for TURN and hands the answer
 *                 to setIceServers(list), which (when it has a TURN entry) reconfigures every
 *                 connection and restarts ICE on the ones not connected yet, with a fresh
 *                 ICE_DEAD_MS window.
 *   re-offer      the room relays a signal only to a slot that has a socket: an offer sent to a
 *                 peer that has not joined yet (staggered joins) is dropped, and so are its trickle
 *                 candidates. The offering (lower) side keeps its last offer and the candidates
 *                 sent since, and re-sends them when the session says the peer joined
 *                 (reoffer(slot)) or when OFFER_RETRY_MS pass without an answer, OFFER_MAX_TRIES
 *                 times per joined target. A duplicate offer on the polite side is harmless: it
 *                 re-applies it and answers again (the extra answer is refused by the stable
 *                 connection and logged). An answer or a connected link stops the retries and
 *                 drops the kept offer and its candidates (later candidates are not buffered).
 *   log           every signal in / out (type only), ICE / connection state changes, channel
 *                 open / close, re-offers and deaths go to the P2PLogSink of the options.
 *
 * The connection factory and the clock are injectable (node tests with a fake RTCPeerConnection).
 * Per-peer state lives in fixed arrays sized MAX_CARS; nothing is allocated per packet beyond the
 * Uint8Array view each DataChannel message needs (the re-offer buffers are filled at negotiation).
 */
import { MAX_CARS } from '../../sim/types';
import type { P2PLogSink } from './DebugLog';
import {
  PEER_CAND_HOST,
  PEER_CAND_NONE,
  PEER_CAND_RELAY,
  PEER_CAND_SRFLX,
  PEER_STATE_CONNECTED,
  PEER_STATE_CONNECTING,
  PEER_STATE_DROPPED,
  PEER_STATE_FAILED,
} from '../NetStats';
import { P2P_INPUT_MAX_BATCH, encodeP2pInput, type IceServer, type SignalData } from './protocol';

/** No game packet from a peer for this long (ms) once the match runs: dead. */
export const GAME_DEAD_MS = 2000;
/** iceConnectionState failed / disconnected for this long (ms): dead. */
export const ICE_DEAD_MS = 5000;
/** 'disconnected' (often transient) gets an ICE restart only after this long; 'failed' at once. */
export const ICE_RESTART_DISCONNECTED_MS = 2000;
export const STATS_INTERVAL_MS = 1000;
/** An offer without an answer for this long is re-sent (with its candidates). */
export const OFFER_RETRY_MS = 2000;
/** A peer not connected this long after it was added makes the mesh ask for TURN (onIceTrouble); direct links take ~1-2 s. */
export const TURN_ASK_AFTER_MS = 3000;
/** Offers (first + re-sends) per joined target before giving up on the timer (reoffer() starts over). */
export const OFFER_MAX_TRIES = 3;

export const GAME_CHANNEL = 'game';
export const CTL_CHANNEL = 'ctl';

// ---- The subset of WebRTC the mesh uses (structurally satisfied by the browser objects) --------

export interface DataChannelLike {
  readonly label: string;
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

export interface SessionDescriptionLike {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

export interface IceCandidateLike {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** One entry of an RTCStatsReport (the fields parsePeerStats reads; everything else is ignored). */
export interface StatsEntryLike {
  type?: string;
  id?: string;
  state?: string;
  nominated?: boolean;
  selected?: boolean;
  selectedCandidatePairId?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  candidateType?: string;
  currentRoundTripTime?: number;
  bytesSent?: number;
  bytesReceived?: number;
}

export interface StatsReportLike {
  forEach(callback: (value: StatsEntryLike) => void): void;
}

export interface PeerConnectionLike {
  readonly signalingState: string;
  readonly iceConnectionState: string;
  readonly connectionState: string;
  readonly localDescription: SessionDescriptionLike | null;
  onnegotiationneeded: ((ev: unknown) => void) | null;
  onicecandidate: ((ev: { candidate: IceCandidateLike | null }) => void) | null;
  ondatachannel: ((ev: { channel: DataChannelLike }) => void) | null;
  oniceconnectionstatechange: ((ev: unknown) => void) | null;
  onconnectionstatechange: ((ev: unknown) => void) | null;
  createDataChannel(label: string, init?: { ordered?: boolean; maxRetransmits?: number }): DataChannelLike;
  setLocalDescription(desc?: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(desc: SessionDescriptionLike): Promise<void>;
  addIceCandidate(candidate?: IceCandidateLike): Promise<void>;
  restartIce(): void;
  /** New ICE servers (TURN on demand); absent in fakes that do not need it. */
  setConfiguration?(config: { iceServers: IceServer[] }): void;
  getStats(): Promise<StatsReportLike>;
  close(): void;
}

export type PeerConnectionFactory = (config: { iceServers: IceServer[] }) => PeerConnectionLike;

export interface MeshOptions {
  mySlot: number;
  iceServers: readonly IceServer[];
  /** Deliver a signal to `to` through the room (RoomClient.signal). */
  signal: (to: number, data: SignalData) => void;
  connectionFactory?: PeerConnectionFactory;
  now?: () => number;
  /** Debug ring (P2PSession.log); absent = silent. */
  log?: P2PLogSink;
}

/** A buffered local ICE candidate (null = end of candidates), re-sent with a re-offer. */
type BufferedCandidate = { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null;

const NO_LOG: P2PLogSink = { push: () => undefined };

/** What parsePeerStats fills from one getStats() report. */
export interface PeerStats {
  /** PEER_CAND_* */
  cand: number;
  rttMs: number;
  bytesSent: number;
  bytesReceived: number;
}

function defaultFactory(config: { iceServers: IceServer[] }): PeerConnectionLike {
  // The browser object satisfies the interface at runtime (the handlers read the same fields);
  // the DOM typings declare them with `this` parameters that the structural check rejects.
  return new RTCPeerConnection(config as RTCConfiguration) as unknown as PeerConnectionLike;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 'offer' / 'answer' / 'candidate' / 'end-of-candidates' (for the log: never the SDP itself). */
export function signalKind(data: SignalData): string {
  if ('sdp' in data) return data.sdp.type;
  return data.candidate === null ? 'end-of-candidates' : 'candidate';
}

function candCode(type: string | undefined): number {
  switch (type) {
    case 'host':
      return PEER_CAND_HOST;
    case 'srflx':
    case 'prflx':
      return PEER_CAND_SRFLX;
    case 'relay':
      return PEER_CAND_RELAY;
    default:
      return PEER_CAND_NONE;
  }
}

/**
 * Selected candidate pair of a getStats() report: the transport's selectedCandidatePairId, or
 * (Firefox) the nominated succeeded pair flagged `selected`, or the first nominated succeeded pair.
 * The pair type is 'relay' when either side relays, else 'srflx' when either side is reflexive,
 * else 'host'. `rttMs` is currentRoundTripTime * 1000 (0 when the pair does not report it). Pure.
 */
export function parsePeerStats(report: StatsReportLike, out: PeerStats): void {
  let pairId: string | undefined;
  let fallbackId: string | undefined;
  report.forEach((e) => {
    if (e.type === 'transport' && typeof e.selectedCandidatePairId === 'string') pairId = e.selectedCandidatePairId;
    else if (e.type === 'candidate-pair' && e.state === 'succeeded' && e.nominated === true) {
      if (e.selected === true) pairId = pairId ?? e.id;
      else fallbackId = fallbackId ?? e.id;
    }
  });
  const want = pairId ?? fallbackId;
  if (want === undefined) {
    out.cand = PEER_CAND_NONE;
    out.rttMs = 0;
    return;
  }
  let localId: string | undefined;
  let remoteId: string | undefined;
  let rtt = 0;
  let sent = out.bytesSent;
  let received = out.bytesReceived;
  report.forEach((e) => {
    if (e.type === 'candidate-pair' && e.id === want) {
      localId = e.localCandidateId;
      remoteId = e.remoteCandidateId;
      if (typeof e.currentRoundTripTime === 'number') rtt = e.currentRoundTripTime * 1000;
      if (typeof e.bytesSent === 'number') sent = e.bytesSent;
      if (typeof e.bytesReceived === 'number') received = e.bytesReceived;
    }
  });
  let local = PEER_CAND_NONE;
  let remote = PEER_CAND_NONE;
  report.forEach((e) => {
    if (e.type === 'local-candidate' && e.id === localId) local = candCode(e.candidateType);
    else if (e.type === 'remote-candidate' && e.id === remoteId) remote = candCode(e.candidateType);
  });
  out.cand = local > remote ? local : remote;
  out.rttMs = rtt;
  out.bytesSent = sent;
  out.bytesReceived = received;
}

/** Where the local inputs come from (RollbackEngine: assembleLocalInputs / newestLocalTick). */
export interface LocalInputSource {
  /** Newest local input tick registered (the batch ends there). */
  readonly newestLocalTick: number;
  /** Up to `cap` ticks newer than `ackTick` ending at newestLocalTick, oldest first into `out`; returns the count. */
  assembleLocalInputs(ackTick: number, out: Int8Array, cap?: number): number;
}

/**
 * One 'game' packet for a peer: our local inputs newer than `ackedTick` (what that peer reported
 * receiving from us; redundancy against loss), at most P2P_INPUT_MAX_BATCH, ending at the newest
 * one, with `ackTick` = the newest tick we received from that peer and `myTick` = our predicted
 * tick. Returns the frame length in `out` (0 when there is nothing yet). Allocation-free.
 */
export function assembleGamePacket(src: LocalInputSource, ackedTick: number, newestFromPeer: number, myTick: number, out: Uint8Array, scratch: Int8Array): number {
  const count = src.assembleLocalInputs(ackedTick, scratch, P2P_INPUT_MAX_BATCH);
  if (count <= 0) return 0;
  const first = src.newestLocalTick - count + 1;
  return encodeP2pInput(out, first, count, newestFromPeer, myTick, scratch, 0);
}

export class Mesh {
  readonly mySlot: number;
  onGame: ((slot: number, bytes: Uint8Array) => void) | null = null;
  onCtl: ((slot: number, bytes: Uint8Array) => void) | null = null;
  /** Both channels of a peer just opened. */
  onPeerConnected: ((slot: number) => void) | null = null;
  /** Fired once per peer when its link is given up (liveness / ICE). */
  onPeerDead: ((slot: number) => void) | null = null;
  /** Fired once per peer that is not connecting well (TURN_ASK_AFTER_MS, or ICE gone bad): time to ask for TURN. */
  onIceTrouble: ((slot: number) => void) | null = null;

  bytesIn = 0;
  bytesOut = 0;
  packetsIn = 0;
  packetsOut = 0;

  private iceServers: IceServer[];
  /** When each peer was added (the TURN_ASK_AFTER_MS check) and whether its trouble was told already. */
  private readonly addedAt = new Float64Array(MAX_CARS);
  private readonly troubled = new Uint8Array(MAX_CARS);
  private readonly signalOut: (to: number, data: SignalData) => void;
  private readonly factory: PeerConnectionFactory;
  private readonly now: () => number;
  private readonly log: P2PLogSink;

  private n = 0;
  private readonly slots = new Int32Array(MAX_CARS).fill(-1);
  private readonly indexOfSlot = new Int32Array(MAX_CARS).fill(-1);
  private readonly pcs: (PeerConnectionLike | null)[] = [];
  private readonly game: (DataChannelLike | null)[] = [];
  private readonly ctl: (DataChannelLike | null)[] = [];
  private readonly state = new Uint8Array(MAX_CARS);
  private readonly makingOffer = new Uint8Array(MAX_CARS);
  private readonly ignoreOffer = new Uint8Array(MAX_CARS);
  private readonly settingRemoteAnswer = new Uint8Array(MAX_CARS);
  private readonly restarted = new Uint8Array(MAX_CARS);
  private readonly iceBadSince = new Float64Array(MAX_CARS).fill(-1);
  private readonly lastGameAt = new Float64Array(MAX_CARS);
  private readonly rtt = new Float32Array(MAX_CARS);
  private readonly cand = new Uint8Array(MAX_CARS);
  private readonly peerBytesIn = new Float64Array(MAX_CARS);
  private readonly peerBytesOut = new Float64Array(MAX_CARS);
  private readonly stats: PeerStats = { cand: PEER_CAND_NONE, rttMs: 0, bytesSent: 0, bytesReceived: 0 };
  // Re-offer state of the offering (impolite) side, per peer index.
  /** The last offer sent (null = none / we are the polite side). */
  private readonly offers: (SignalData | null)[] = [];
  /** Local candidates signalled since that offer (trickle), re-sent with it. */
  private readonly cands: BufferedCandidate[][] = [];
  /** When the offer (or its last re-send) went out; -1 = no retry pending. */
  private readonly offerAt = new Float64Array(MAX_CARS).fill(-1);
  private readonly offerTries = new Uint8Array(MAX_CARS);
  private readonly answered = new Uint8Array(MAX_CARS);
  private readonly lastIce: string[] = [];
  private readonly lastConn: string[] = [];
  private livenessArmed = false;
  private statsAt = -1e9;
  private closed = false;
  /** Offers re-sent (timer + reoffer()), for the stats / tests. */
  reoffers = 0;

  constructor(opts: MeshOptions) {
    this.mySlot = opts.mySlot;
    this.iceServers = opts.iceServers.slice();
    this.signalOut = opts.signal;
    this.factory = opts.connectionFactory ?? defaultFactory;
    this.now = opts.now ?? defaultNow;
    this.log = opts.log ?? NO_LOG;
    for (let i = 0; i < MAX_CARS; i++) {
      this.pcs.push(null);
      this.game.push(null);
      this.ctl.push(null);
      this.offers.push(null);
      this.cands.push([]);
      this.lastIce.push('');
      this.lastConn.push('');
    }
  }

  /** Peers added (including dead / dropped ones). */
  get peerCount(): number {
    return this.n;
  }

  slotAt(i: number): number {
    return this.slots[i];
  }

  indexOf(slot: number): number {
    return slot >= 0 && slot < MAX_CARS ? this.indexOfSlot[slot] : -1;
  }

  /** The impolite side (lower slot) creates the channels and wins offer collisions. */
  polite(theirSlot: number): boolean {
    return this.mySlot > theirSlot;
  }

  /** PEER_STATE_* of a slot (PEER_STATE_DROPPED for unknown slots). */
  peerState(slot: number): number {
    const i = this.indexOf(slot);
    return i < 0 ? PEER_STATE_DROPPED : this.state[i];
  }

  peerRttMs(slot: number): number {
    const i = this.indexOf(slot);
    return i < 0 ? 0 : this.rtt[i];
  }

  /** PEER_CAND_* from the last stats poll. */
  peerCand(slot: number): number {
    const i = this.indexOf(slot);
    return i < 0 ? PEER_CAND_NONE : this.cand[i];
  }

  peerBytesReceived(slot: number): number {
    const i = this.indexOf(slot);
    return i < 0 ? 0 : this.peerBytesIn[i];
  }

  peerBytesSent(slot: number): number {
    const i = this.indexOf(slot);
    return i < 0 ? 0 : this.peerBytesOut[i];
  }

  /** Peers whose both channels are open. */
  connectedCount(): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.state[i] === PEER_STATE_CONNECTED) c++;
    return c;
  }

  /** Peers still expected (not dropped). */
  expectedCount(): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.state[i] !== PEER_STATE_DROPPED) c++;
    return c;
  }

  /** Every expected peer has both channels open. */
  allConnected(): boolean {
    for (let i = 0; i < this.n; i++) {
      const s = this.state[i];
      if (s !== PEER_STATE_CONNECTED && s !== PEER_STATE_DROPPED) return false;
    }
    return true;
  }

  /** Start connecting to `slot` (idempotent). The lower slot creates the channels and so offers. */
  addPeer(slot: number): void {
    if (this.closed || slot === this.mySlot || slot < 0 || slot >= MAX_CARS) return;
    let i = this.indexOfSlot[slot];
    if (i >= 0 && this.state[i] !== PEER_STATE_DROPPED) return;
    if (i < 0) {
      if (this.n >= MAX_CARS) return;
      i = this.n++;
      this.slots[i] = slot;
      this.indexOfSlot[slot] = i;
    }
    this.state[i] = PEER_STATE_CONNECTING;
    this.makingOffer[i] = 0;
    this.ignoreOffer[i] = 0;
    this.settingRemoteAnswer[i] = 0;
    this.restarted[i] = 0;
    this.iceBadSince[i] = -1;
    this.lastGameAt[i] = this.now();
    this.addedAt[i] = this.lastGameAt[i];
    this.troubled[i] = 0;
    this.rtt[i] = 0;
    this.cand[i] = PEER_CAND_NONE;
    this.offers[i] = null;
    this.cands[i].length = 0;
    this.offerAt[i] = -1;
    this.offerTries[i] = 0;
    this.answered[i] = 0;
    this.lastIce[i] = '';
    this.lastConn[i] = '';
    const pc = this.factory({ iceServers: this.iceServers });
    this.pcs[i] = pc;
    this.game[i] = null;
    this.ctl[i] = null;
    this.log.push('mesh.addPeer', `slot ${slot} ${this.polite(slot) ? 'polite (waits for the offer)' : 'impolite (offers)'}`);
    pc.onnegotiationneeded = () => {
      this.negotiate(i, pc).catch((err: unknown) => this.warn(slot, 'negotiation', err));
    };
    pc.onicecandidate = (ev) => {
      if (pc !== this.pcs[i]) return;
      const c = ev.candidate;
      const data: BufferedCandidate = c === null ? null : { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex };
      // The offering side keeps them: a re-offer must carry the candidates the room dropped with the offer.
      if (this.offers[i] !== null) this.cands[i].push(data);
      this.log.push('sig>', `${slot} ${data === null ? 'end-of-candidates' : 'candidate'}`);
      this.signalOut(slot, { candidate: data });
    };
    pc.ondatachannel = (ev) => {
      if (pc === this.pcs[i]) this.attachChannel(i, ev.channel);
    };
    pc.oniceconnectionstatechange = () => {
      if (pc !== this.pcs[i]) return;
      const s = pc.iceConnectionState;
      if (s !== this.lastIce[i]) {
        this.lastIce[i] = s;
        this.log.push('ice', `${slot} ${s}`);
      }
      this.checkIce(i, pc, this.now());
    };
    pc.onconnectionstatechange = () => {
      if (pc !== this.pcs[i]) return;
      const s = pc.connectionState;
      if (s !== this.lastConn[i]) {
        this.lastConn[i] = s;
        this.log.push('conn', `${slot} ${s}`);
      }
      this.checkIce(i, pc, this.now());
    };
    if (!this.polite(slot)) {
      // Impolite (lower slot): the channels trigger negotiationneeded -> our offer.
      this.attachChannel(i, pc.createDataChannel(GAME_CHANNEL, { ordered: false, maxRetransmits: 0 }));
      this.attachChannel(i, pc.createDataChannel(CTL_CHANNEL, { ordered: true }));
    }
  }

  /** The room dropped `slot` (or it left before the start): close and stop expecting it. */
  removePeer(slot: number): void {
    const i = this.indexOf(slot);
    if (i < 0) return;
    this.log.push('mesh.removePeer', `slot ${slot}`);
    this.closePeer(i);
    this.state[i] = PEER_STATE_DROPPED;
  }

  /**
   * The peer just (re)joined the room: if we are its offering side and the offer is still
   * unanswered, re-send it now with the candidates gathered since (the room dropped the ones
   * sent before the peer had a socket) and start the retry budget over for this target.
   * No-op for the polite side, for a connected link, or before the offer exists (addPeer's
   * negotiation then sends it to the present peer anyway).
   */
  reoffer(slot: number): void {
    const i = this.indexOf(slot);
    if (i < 0 || this.closed || this.state[i] !== PEER_STATE_CONNECTING) return;
    if (this.offers[i] === null || this.answered[i] === 1) return;
    this.offerTries[i] = 0;
    this.resendOffer(i, this.now(), 'peer joined');
  }

  /** An offer to `slot` is kept for a re-send (sent, not answered, link not connected yet). */
  offerPending(slot: number): boolean {
    const i = this.indexOf(slot);
    return i >= 0 && this.offers[i] !== null;
  }

  /** Local candidates buffered for a re-send of the offer to `slot` (0 once answered / connected). */
  bufferedCandidates(slot: number): number {
    const i = this.indexOf(slot);
    return i < 0 ? 0 : this.cands[i].length;
  }

  /** The room could not relay our last signal to `slot` (no socket there yet): the retry timer / reoffer() handle it. */
  signalDropped(slot: number): void {
    const i = this.indexOf(slot);
    this.log.push('sig.dropped', `${slot} (no socket there yet)${i >= 0 && this.offers[i] !== null ? ', offer kept for re-send' : ''}`);
  }

  /** A signal relayed by the room from `from` (perfect negotiation, polite = my slot > from). */
  handleSignal(from: number, data: SignalData): void {
    const i = this.indexOf(from);
    if (i < 0 || this.state[i] === PEER_STATE_DROPPED) {
      this.log.push('sig<', `${from} ${signalKind(data)} ignored (unknown / dropped slot)`);
      return;
    }
    const pc = this.pcs[i];
    if (pc === null) return;
    this.log.push('sig<', `${from} ${signalKind(data)}`);
    this.applySignal(i, pc, from, data).catch((err: unknown) => this.warn(from, 'signal', err));
  }

  sendGame(slot: number, buf: Uint8Array, len: number): boolean {
    const i = this.indexOf(slot);
    if (i < 0) return false;
    return this.sendOn(i, this.game[i], buf, len);
  }

  sendCtl(slot: number, buf: Uint8Array, len: number): boolean {
    const i = this.indexOf(slot);
    if (i < 0) return false;
    return this.sendOn(i, this.ctl[i], buf, len);
  }

  /** Send to every connected peer; returns how many got it. */
  broadcastGame(buf: Uint8Array, len: number): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.sendOn(i, this.game[i], buf, len)) c++;
    return c;
  }

  broadcastCtl(buf: Uint8Array, len: number): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.sendOn(i, this.ctl[i], buf, len)) c++;
    return c;
  }

  /** The match started: from now on a silent peer (GAME_DEAD_MS without game packets) is dead. */
  armLiveness(now = this.now()): void {
    this.livenessArmed = true;
    for (let i = 0; i < this.n; i++) this.lastGameAt[i] = now;
  }

  /** Per frame: liveness checks and the 1 Hz stats poll. */
  update(now = this.now()): void {
    if (this.closed) return;
    const poll = now - this.statsAt >= STATS_INTERVAL_MS;
    if (poll) this.statsAt = now;
    for (let i = 0; i < this.n; i++) {
      const s = this.state[i];
      if (s === PEER_STATE_DROPPED || s === PEER_STATE_FAILED) continue;
      const pc = this.pcs[i];
      if (pc === null) continue;
      this.checkIce(i, pc, now);
      if (this.state[i] === PEER_STATE_FAILED) continue;
      if (this.livenessArmed && s === PEER_STATE_CONNECTED && now - this.lastGameAt[i] > GAME_DEAD_MS) {
        this.log.push('mesh.dead', `slot ${this.slots[i]} silent ${GAME_DEAD_MS} ms`);
        this.markDead(i);
        continue;
      }
      if (s === PEER_STATE_CONNECTING && now - this.addedAt[i] >= TURN_ASK_AFTER_MS) this.trouble(i);
      if (s === PEER_STATE_CONNECTING && this.offerAt[i] >= 0 && this.answered[i] === 0 && now - this.offerAt[i] >= OFFER_RETRY_MS) {
        this.resendOffer(i, now, 'no answer');
      }
      if (poll) this.pollStats(i, pc);
    }
  }

  /**
   * The room's TURN answer: with a TURN entry in it (a credential), every connection takes the new
   * servers and the ones not connected yet restart ICE with a fresh ICE_DEAD_MS window. A list
   * without one (no TURN on this server, or refused) changes nothing. True when it was applied.
   */
  setIceServers(list: readonly IceServer[]): boolean {
    if (this.closed || !list.some((s) => typeof s.credential === 'string' && s.credential.length > 0)) return false;
    this.iceServers = list.slice();
    const now = this.now();
    for (let i = 0; i < this.n; i++) {
      const pc = this.pcs[i];
      const s = this.state[i];
      if (pc === null || s === PEER_STATE_DROPPED || s === PEER_STATE_FAILED) continue;
      try {
        if (typeof pc.setConfiguration === 'function') pc.setConfiguration({ iceServers: this.iceServers });
        if (s === PEER_STATE_CONNECTING) {
          this.restarted[i] = 1;
          this.iceBadSince[i] = -1;
          this.addedAt[i] = now;
          this.log.push('ice.turn', `${this.slots[i]} restart with TURN`);
          pc.restartIce();
        }
      } catch (err) {
        this.warn(this.slots[i], 'setConfiguration', err);
      }
    }
    return true;
  }

  /** Close every connection (leaving the room). */
  close(): void {
    this.closed = true;
    for (let i = 0; i < this.n; i++) this.closePeer(i);
  }

  // ---- internals -------------------------------------------------------------------------

  private warn(slot: number, what: string, err: unknown): void {
    this.log.push('mesh.warn', `${what} with slot ${slot}: ${err instanceof Error ? err.message : String(err)}`);
    if (typeof console !== 'undefined') console.warn(`Mesh: ${what} with slot ${slot} failed`, err);
  }

  private async negotiate(i: number, pc: PeerConnectionLike): Promise<void> {
    const slot = this.slots[i];
    this.makingOffer[i] = 1;
    try {
      await pc.setLocalDescription();
      const d = pc.localDescription;
      if (d !== null && (d.type === 'offer' || d.type === 'answer') && pc === this.pcs[i]) {
        const data: SignalData = { sdp: { type: d.type, sdp: d.sdp ?? '' } };
        if (d.type === 'offer') {
          // Kept for re-sends; the candidates of this offer accumulate from here on.
          this.offers[i] = data;
          this.cands[i].length = 0;
          this.offerAt[i] = this.now();
          this.offerTries[i] = 1;
          this.answered[i] = 0;
        }
        this.log.push('sig>', `${slot} ${d.type}`);
        this.signalOut(slot, data);
      }
    } finally {
      this.makingOffer[i] = 0;
    }
  }

  /** Forget the kept offer of peer `i` and its buffered candidates (onicecandidate stops buffering: offers[i] is null). */
  private dropOffer(i: number): void {
    this.offers[i] = null;
    this.cands[i].length = 0;
    this.offerAt[i] = -1;
  }

  /** Re-send the kept offer and its candidates to peer `i` (the room dropped them, or no answer came). */
  private resendOffer(i: number, now: number, why: string): void {
    const offer = this.offers[i];
    if (offer === null || this.closed) return;
    if (this.offerTries[i] >= OFFER_MAX_TRIES) {
      this.offerAt[i] = -1; // give up on the timer (reoffer() on a join starts over)
      this.log.push('offer.giveup', `${this.slots[i]} after ${OFFER_MAX_TRIES} tries`);
      return;
    }
    const slot = this.slots[i];
    const cands = this.cands[i];
    this.offerTries[i]++;
    this.offerAt[i] = now;
    this.reoffers++;
    this.log.push('reoffer', `${slot} try ${this.offerTries[i]} (${why}), ${cands.length} candidates`);
    this.signalOut(slot, offer);
    for (let k = 0; k < cands.length; k++) this.signalOut(slot, { candidate: cands[k] });
  }

  private async applySignal(i: number, pc: PeerConnectionLike, from: number, data: SignalData): Promise<void> {
    if ('sdp' in data) {
      const desc = data.sdp;
      const readyForOffer = this.makingOffer[i] === 0 && (pc.signalingState === 'stable' || this.settingRemoteAnswer[i] === 1);
      const offerCollision = desc.type === 'offer' && !readyForOffer;
      this.ignoreOffer[i] = !this.polite(from) && offerCollision ? 1 : 0;
      if (this.ignoreOffer[i] === 1) {
        this.log.push('sig.collision', `${from} offer ignored (impolite, mid-offer)`);
        return;
      }
      if (desc.type === 'answer') {
        if (pc.signalingState === 'stable' && this.answered[i] === 1) {
          // A second answer to a re-sent offer the peer had already answered: nothing to apply.
          this.log.push('sig.dup', `${from} answer to a re-sent offer ignored`);
          return;
        }
        this.answered[i] = 1;
        // Answered: the offer is never re-sent, so neither it nor new candidates are kept.
        this.dropOffer(i);
      } else {
        // Applying THEIR offer (we answer, or we are the polite side being rolled back): an offer
        // of ours still pending is moot and must not be re-sent.
        this.offers[i] = null;
        this.offerAt[i] = -1;
      }
      this.settingRemoteAnswer[i] = desc.type === 'answer' ? 1 : 0;
      try {
        await pc.setRemoteDescription(desc);
      } finally {
        this.settingRemoteAnswer[i] = 0;
      }
      if (desc.type === 'offer' && pc === this.pcs[i]) {
        await pc.setLocalDescription();
        const d = pc.localDescription;
        if (d !== null && (d.type === 'offer' || d.type === 'answer')) {
          this.log.push('sig>', `${from} ${d.type}`);
          this.signalOut(from, { sdp: { type: d.type, sdp: d.sdp ?? '' } });
        }
      }
      return;
    }
    const c = data.candidate;
    try {
      if (c === null) await pc.addIceCandidate();
      else await pc.addIceCandidate(c);
    } catch (err) {
      // Candidates of an ignored offer are expected to fail.
      if (this.ignoreOffer[i] === 0) throw err;
    }
  }

  private attachChannel(i: number, ch: DataChannelLike): void {
    const slot = this.slots[i];
    const isGame = ch.label === GAME_CHANNEL;
    if (!isGame && ch.label !== CTL_CHANNEL) return;
    ch.binaryType = 'arraybuffer';
    if (isGame) this.game[i] = ch;
    else this.ctl[i] = ch;
    ch.onopen = () => {
      this.log.push('chan.open', `${slot} ${ch.label}`);
      this.checkOpen(i);
    };
    ch.onclose = () => {
      if ((isGame ? this.game[i] : this.ctl[i]) !== ch) return;
      this.log.push('chan.close', `${slot} ${ch.label}`);
      if (this.state[i] === PEER_STATE_CONNECTED) this.markDead(i);
    };
    ch.onmessage = (ev) => {
      const data = ev.data;
      if (!(data instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(data);
      this.bytesIn += bytes.length;
      this.packetsIn++;
      this.peerBytesIn[i] += bytes.length;
      if (isGame) {
        this.lastGameAt[i] = this.now();
        if (this.onGame) this.onGame(slot, bytes);
      } else if (this.onCtl) this.onCtl(slot, bytes);
    };
    if (ch.readyState === 'open') this.checkOpen(i);
  }

  private checkOpen(i: number): void {
    if (this.state[i] !== PEER_STATE_CONNECTING) return;
    const g = this.game[i];
    const c = this.ctl[i];
    if (g === null || c === null || g.readyState !== 'open' || c.readyState !== 'open') return;
    this.state[i] = PEER_STATE_CONNECTED;
    this.iceBadSince[i] = -1;
    this.lastGameAt[i] = this.now();
    this.dropOffer(i); // connected: no more re-offers, nothing to buffer for one
    this.log.push('mesh.connected', `slot ${this.slots[i]}`);
    if (this.onPeerConnected) this.onPeerConnected(this.slots[i]);
  }

  /** Tell the session once that peer `i` is not connecting well (it asks the room for TURN). */
  private trouble(i: number): void {
    if (this.troubled[i] === 1) return;
    this.troubled[i] = 1;
    this.log.push('ice.trouble', `slot ${this.slots[i]}`);
    if (this.onIceTrouble) this.onIceTrouble(this.slots[i]);
  }

  private checkIce(i: number, pc: PeerConnectionLike, now: number): void {
    const s = this.state[i];
    if (s === PEER_STATE_DROPPED || s === PEER_STATE_FAILED) return;
    const ice = pc.iceConnectionState;
    const bad = ice === 'failed' || ice === 'disconnected' || pc.connectionState === 'failed';
    if (!bad) {
      this.iceBadSince[i] = -1;
      return;
    }
    this.trouble(i);
    if (this.iceBadSince[i] < 0) this.iceBadSince[i] = now;
    const since = now - this.iceBadSince[i];
    if (since > ICE_DEAD_MS) {
      this.log.push('mesh.dead', `slot ${this.slots[i]} ice ${ice} / conn ${pc.connectionState} for ${ICE_DEAD_MS} ms`);
      this.markDead(i);
      return;
    }
    if (this.restarted[i] === 0 && (ice === 'failed' || pc.connectionState === 'failed' || since >= ICE_RESTART_DISCONNECTED_MS)) {
      this.restarted[i] = 1;
      this.log.push('ice.restart', `${this.slots[i]} (${ice})`);
      try {
        pc.restartIce();
      } catch (err) {
        this.warn(this.slots[i], 'restartIce', err);
      }
    }
  }

  private markDead(i: number): void {
    if (this.state[i] === PEER_STATE_FAILED || this.state[i] === PEER_STATE_DROPPED) return;
    this.state[i] = PEER_STATE_FAILED;
    this.offerAt[i] = -1;
    this.closePeer(i);
    if (this.onPeerDead) this.onPeerDead(this.slots[i]);
  }

  private closePeer(i: number): void {
    const pc = this.pcs[i];
    const g = this.game[i];
    const c = this.ctl[i];
    this.pcs[i] = null;
    this.game[i] = null;
    this.ctl[i] = null;
    try {
      if (g !== null) g.close();
      if (c !== null) c.close();
      if (pc !== null) pc.close();
    } catch {
      /* already closed */
    }
  }

  private sendOn(i: number, ch: DataChannelLike | null, buf: Uint8Array, len: number): boolean {
    if (ch === null || ch.readyState !== 'open' || len <= 0 || len > buf.length) return false;
    try {
      ch.send(len === buf.length ? buf : buf.subarray(0, len));
    } catch {
      return false;
    }
    this.bytesOut += len;
    this.packetsOut++;
    this.peerBytesOut[i] += len;
    return true;
  }

  private pollStats(i: number, pc: PeerConnectionLike): void {
    pc.getStats().then(
      (report) => {
        if (pc !== this.pcs[i]) return;
        const s = this.stats;
        s.bytesSent = this.peerBytesOut[i];
        s.bytesReceived = this.peerBytesIn[i];
        parsePeerStats(report, s);
        this.rtt[i] = s.rttMs;
        this.cand[i] = s.cand;
      },
      () => undefined,
    );
  }
}

/**
 * Synthesized game audio (Web Audio only, no sample files).
 *
 * Graph: the continuous layers → sfx bus → master gain → DynamicsCompressor → destination. One-shots
 * → their own dry bus → master, plus a send into one shared short room (a ConvolverNode over a
 * synthetic stereo impulse) → master (no room with `{ room: false }`: super low's CPU trim, dry
 * one-shots and no convolution on the audio thread); sub / body voices can go through a shared soft saturator
 * first. The whole graph is created lazily on the first `resume()` (which must come from a user
 * gesture because of the autoplay policy); every method is a no-op while the context is not
 * running, so stale events never pile up and burst out on resume.
 *
 * Continuous layers (driven by `update()`, no allocations):
 *   engine      a virtual V8 (engine.ts: rpm through three gears, load). One oscillator at the
 *               crankshaft frequency whose wave holds the engine orders (4th = firing, plus the
 *               2nd and odd orders that make the burble) + exhaust pulses (noise band-passed near
 *               the firing frequency, amplitude-modulated at it) → soft saturation (drive grows
 *               with load) → lowpass opened by rpm and load. A short dip on each upshift and a
 *               few exhaust pops when the throttle is released at high rpm.
 *   boost       a deep roar (noise through two cascaded lowpasses, 24 dB/oct, 300-700 Hz) + a body
 *               band around 150 Hz + a soft low hum (two saws a fifth apart, 58 / 87 Hz, rising a
 *               little with speed, lowpassed) → gain while boosting
 *   supersonic  noise through a wide band around 0.7-1.1 kHz and a lowpass (a full whoosh, no
 *               hiss), slowly gusting, fades in near max speed
 * One-shots: a voice plus layers from the toolkit at the end of the class (a contact click, pitched
 * bodies with several partials, additive and FM notes, filtered noise), so every sound is a full
 * spectrum rather than one tone; 10-30 nodes each, event-driven, a handful per second at most.
 */
import type { Team } from '../sim/types';
import { EngineModel, IDLE_RPM, REDLINE_RPM } from './engine';

export interface AudioState {
  /** Car speed in uu/s (0..2300). */
  speed: number;
  /** Speed along the car's nose, uu/s: negative when rolling backwards (the engine tells the brake from the throttle). */
  forwardSpeed: number;
  boosting: boolean;
  supersonic: boolean;
  grounded: boolean;
  /** Throttle input -1..1. */
  throttle: number;
}

const CAR_MAX_SPEED = 2300;
/** Engine-order amplitudes 1..24 of the crankshaft wave (cross-plane V8: the 4th, firing, leads). */
const ENGINE_ORDERS = [0.16, 0.42, 0.2, 1, 0.12, 0.3, 0.1, 0.6, 0.06, 0.2, 0.05, 0.34, 0.04, 0.1, 0.03, 0.2, 0.02, 0.05, 0.02, 0.1, 0.02, 0.04, 0.02, 0.08];
/** Exhaust pops after a throttle release: at most once per this many seconds. */
const POPS_MIN_INTERVAL = 1.2;
const MIN_GAIN = 0.0001; // exponential ramps cannot reach 0
const BALL_HIT_MIN_INTERVAL = 0.04;
const CAR_HIT_MIN_INTERVAL = 0.06;
const BOOST_START_MIN_INTERVAL = 0.05;
const DEMOLITION_MIN_INTERVAL = 0.08;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Dead-band for AudioParam targets: 1% relative plus a tiny absolute term (targets are often exactly 0). */
function changed(v: number, lastSent: number): boolean {
  const a = v < 0 ? -v : v;
  const b = lastSent < 0 ? -lastSent : lastSent;
  const d = v - lastSent;
  return (d < 0 ? -d : d) > 0.01 * (a > b ? a : b) + 1e-4;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  // One-shot bus: a dry gain plus a send into one shared short room (convolver), a shared soft
  // saturator and timbres made once (see buildGraph). The continuous layers stay on the sfx bus.
  private oneShot: GainNode | null = null;
  private roomIn: GainNode | null = null;
  private room: ConvolverNode | null = null;
  private sat: WaveShaperNode | null = null;
  private warmWave: PeriodicWave | null = null;
  private hornWave: PeriodicWave | null = null;
  private clickBuf: AudioBuffer | null = null;
  /** Partial ratios for body() / note(): the harmonic series (tones, horns, warm bodies). */
  private static readonly HARMONIC: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];
  /** Circular membrane modes: a struck skin, the ball's inflated shell. */
  private static readonly MEMBRANE: readonly number[] = [1, 1.593, 2.136, 2.296, 2.653, 2.918];
  /** Dense inharmonic set: a car body panel (rough, clanky). */
  private static readonly PANEL: readonly number[] = [1, 1.29, 1.71, 2.37, 3.12, 4.1];
  /** Free-bar modes: mallet or bell-like notes (the upper modes are far apart: use a low fundamental). */
  private static readonly BAR: readonly number[] = [1, 2.756, 5.404, 8.933];
  /** Goal crowd texture (blastMakeCrowd, made once in buildGraph). */
  private blastCrowd: AudioBuffer | null = null;

  // Engine
  private readonly engine = new EngineModel();
  private engOsc: OscillatorNode | null = null;
  private engAm: OscillatorNode | null = null;
  private engNoise: AudioBufferSourceNode | null = null;
  private engBand: BiquadFilterNode | null = null;
  private engNoiseGain: GainNode | null = null;
  private engDrive: GainNode | null = null;
  private engFilter: BiquadFilterNode | null = null;
  private engGain: GainNode | null = null;
  private prevThrottle = 0;
  private lastPops = -1;
  // Boost roar
  private boostSrc: AudioBufferSourceNode | null = null;
  private boostFilter: BiquadFilterNode | null = null;
  private boostFilter2: BiquadFilterNode | null = null;
  private boostHumA: OscillatorNode | null = null;
  private boostHumB: OscillatorNode | null = null;
  private boostGain: GainNode | null = null;
  // Supersonic wind
  private windSrc: AudioBufferSourceNode | null = null;
  private windBand: BiquadFilterNode | null = null;
  private windLfo: OscillatorNode | null = null;
  private windGain: GainNode | null = null;

  private volume = 0.7;
  private smoothSpeed = 0;
  private prevBoosting = false;
  // Last target sent to each continuous AudioParam (dead-band: skip resends that would not be
  // audible, so a steady state issues no automation events at all).
  private sentEngF = -1;
  private sentEngBand = -1;
  private sentEngNoise = -1;
  private sentEngDrive = -1;
  private sentEngFilter = -1;
  private sentEngGain = -1;
  private sentBoostGain = -1;
  private sentBoostFilter = -1;
  private sentBoostHum = -1;
  private sentWindBand = -1;
  private sentWind = -1;
  private lastBallHit = -1;
  private lastCarHit = -1;
  private lastBoostStart = -1;
  private lastDemolition = -1;
  private disposed = false;

  /** The shared room (a ConvolverNode) for the one-shots; false: dry only (super low's CPU trim). */
  private readonly withRoom: boolean;

  constructor(opts: { room?: boolean } = {}) {
    // Nothing is created here: an AudioContext may only start from a user gesture.
    this.withRoom = opts.room ?? true;
  }

  /** True when sound can actually be produced right now. */
  get running(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /**
   * The context exists but is held: not unlocked yet, or taken away by the system after it ran
   * (iOS: a call, an app switch or a locked screen leave it 'interrupted' or 'suspended' until a
   * resume() from a gesture). False before the first resume() and once closed (dispose).
   */
  get suspended(): boolean {
    const state = this.ctx !== null ? this.ctx.state : 'closed';
    return state === 'suspended' || state === 'interrupted';
  }

  /**
   * Create the graph (first call) and resume the context. Call from a user gesture. Idempotent and
   * cheap when already running; callers must RETRY it on later gestures until `running` is true:
   * the first attempt legitimately fails when the gesture carried no user activation (Escape, a
   * bare modifier key, a touch pointerdown, gamepad input) and Chrome keeps the context suspended
   * with the resume promise pending forever, so there is no rejection to react to.
   */
  resume(): void {
    if (this.disposed) return;
    if (typeof AudioContext === 'undefined') return;
    if (this.ctx === null) this.buildGraph();
    const ctx = this.ctx;
    if (ctx !== null && ctx.state !== 'running') {
      void ctx.resume().catch(() => undefined);
    }
  }

  /** Master volume 0..1. */
  setVolume(v: number): void {
    this.volume = clamp01(v);
    if (this.ctx !== null && this.master !== null) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }

  getVolume(): number {
    return this.volume;
  }

  /** Drive the continuous layers. Call once per rendered frame with the player's car state. */
  update(dt: number, state: AudioState): void {
    const boosting = state.boosting;
    const ctx = this.ctx;
    if (ctx === null || ctx.state !== 'running') {
      this.prevBoosting = boosting;
      return;
    }
    const t = ctx.currentTime;
    // Smooth the speed a little so the pitch does not jitter with contact noise.
    const k = dt > 0 ? Math.min(1, dt * 14) : 1;
    this.smoothSpeed += (state.speed - this.smoothSpeed) * k;
    const ratio = clamp01(this.smoothSpeed / CAR_MAX_SPEED);
    const thr = clamp01(Math.abs(state.throttle));

    // Engine: rpm and load from the model (engine.ts), turned into pitch, brightness and level.
    const eng = this.engine;
    eng.step(dt, state.forwardSpeed, state.throttle, state.grounded, boosting);
    const crank = eng.rpm / 60;
    const rn = clamp01((eng.rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM));
    const load = eng.load;
    if (changed(crank, this.sentEngF)) {
      this.sentEngF = crank;
      this.engOsc!.frequency.setTargetAtTime(crank, t, 0.02);
      this.engAm!.frequency.setTargetAtTime(crank * 4, t, 0.02);
    }
    const band = crank * 4 * 2.2 + 250;
    if (changed(band, this.sentEngBand)) {
      this.sentEngBand = band;
      this.engBand!.frequency.setTargetAtTime(band, t, 0.03);
    }
    const noiseLevel = 0.25 + 0.55 * load;
    if (changed(noiseLevel, this.sentEngNoise)) {
      this.sentEngNoise = noiseLevel;
      this.engNoiseGain!.gain.setTargetAtTime(noiseLevel, t, 0.05);
    }
    const drive = 1.2 + 2.3 * load;
    if (changed(drive, this.sentEngDrive)) {
      this.sentEngDrive = drive;
      this.engDrive!.gain.setTargetAtTime(drive, t, 0.05);
    }
    const engCut = 260 + 1100 * rn + 1500 * load;
    if (changed(engCut, this.sentEngFilter)) {
      this.sentEngFilter = engCut;
      this.engFilter!.frequency.setTargetAtTime(engCut, t, 0.05);
    }
    const engLevel = (0.022 + 0.05 * load + 0.022 * rn) * (state.grounded ? 1 : 0.85);
    if (eng.shifted) {
      // Upshift: the power cuts for a moment, then comes back.
      this.engGain!.gain.setTargetAtTime(engLevel * 0.45, t, 0.012);
      this.engGain!.gain.setTargetAtTime(engLevel, t + 0.07, 0.03);
      this.sentEngGain = engLevel;
    } else if (changed(engLevel, this.sentEngGain)) {
      this.sentEngGain = engLevel;
      this.engGain!.gain.setTargetAtTime(engLevel, t, 0.05);
    }
    // Throttle released at high rpm on the ground: a few exhaust pops.
    if (this.prevThrottle > 0.6 && thr < 0.15 && eng.rpm > 3600 && state.grounded && t - this.lastPops > POPS_MIN_INTERVAL) {
      this.lastPops = t;
      const pops = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < pops; i++) {
        this.noiseBurst(ctx, 'bandpass', 1400 + Math.random() * 1600, 2.2, 0.02 + Math.random() * 0.02, 0.06 + Math.random() * 0.08, 0, 0.05 + Math.random() * 0.6);
      }
    }
    this.prevThrottle = thr;

    // Boost roar + ignition / release one-shots on the edges (always sent on an edge frame).
    const edge = boosting !== this.prevBoosting;
    if (edge) {
      if (boosting) this.playBoostStart();
      else this.playBoostStop();
    }
    const boostLevel = boosting ? 0.24 : 0;
    if (edge || changed(boostLevel, this.sentBoostGain)) {
      this.sentBoostGain = boostLevel;
      this.boostGain!.gain.setTargetAtTime(boostLevel, t, boosting ? 0.04 : 0.03);
    }
    const boostCut = 320 + 380 * ratio;
    if (changed(boostCut, this.sentBoostFilter)) {
      this.sentBoostFilter = boostCut;
      this.boostFilter!.frequency.setTargetAtTime(boostCut, t, 0.1);
      this.boostFilter2!.frequency.setTargetAtTime(boostCut, t, 0.1);
    }
    const hum = 58 * (1 + 0.25 * ratio);
    if (changed(hum, this.sentBoostHum)) {
      this.sentBoostHum = hum;
      this.boostHumA!.frequency.setTargetAtTime(hum, t, 0.12);
      this.boostHumB!.frequency.setTargetAtTime(hum * 1.5, t, 0.12);
    }

    // Supersonic wind: a full, low whoosh, with a hint of it from ~85% speed.
    let wind = 0;
    if (state.supersonic) wind = 0.09;
    else if (ratio > 0.85) wind = (0.035 * (ratio - 0.85)) / 0.15;
    if (changed(wind, this.sentWind)) {
      this.sentWind = wind;
      this.windGain!.gain.setTargetAtTime(wind, t, 0.15);
    }
    const windCentre = 700 + 400 * ratio;
    if (changed(windCentre, this.sentWindBand)) {
      this.sentWindBand = windCentre;
      this.windBand!.frequency.setTargetAtTime(windCentre, t, 0.2);
    }

    this.prevBoosting = boosting;
  }

  /**
   * Fade every continuous layer (engine, boost, wind) to silence right now. Used when the game
   * pauses or the tab is hidden: requestAnimationFrame stops in a hidden tab, so update() would
   * never run again and the AudioParams would hold their last (possibly roaring) targets.
   * The next update() restores whatever the game state asks for.
   */
  silence(): void {
    this.prevBoosting = false;
    this.smoothSpeed = 0;
    this.prevThrottle = 0;
    this.engine.reset();
    const ctx = this.ctx;
    if (ctx === null || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    this.sentEngGain = 0;
    this.sentBoostGain = 0;
    this.sentWind = 0;
    this.engGain!.gain.setTargetAtTime(0, t, 0.05);
    this.boostGain!.gain.setTargetAtTime(0, t, 0.05);
    this.windGain!.gain.setTargetAtTime(0, t, 0.05);
  }

  // ---- One-shots ----------------------------------------------------------------------------

  /**
   * Car hits the ball. `strength` 0..1 (e.g. relative speed / 3000). A rubber shell full of air:
   * a contact tick, a wide band of air noise around 850 → 640 Hz (the slap of the shell and the
   * air inside it) and the shell itself, its first three membrane modes on a warm fundamental of
   * 180 → 125 Hz that fall onto pitch within a few ms and die in ~0.1 s. Harder hits are lower,
   * heavier and drop further; each call is detuned by up to ±5% so a dribble never repeats.
   * 13 nodes.
   */
  playBallHit(strength: number): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    if (t - this.lastBallHit < BALL_HIT_MIN_INTERVAL) return;
    this.lastBallHit = t;
    const s = clamp01(strength);
    const vary = 0.95 + Math.random() * 0.1;
    const v = this.voice(ctx, 1, 0.05 + 0.01 * s);
    // Contact: a short tick, duller (lower, so longer) for harder hits.
    this.click(ctx, v, t, (2200 - 800 * s) * vary, 0.055 + 0.155 * s);
    // Air: about 2 octaves of noise, long enough to be heard as part of the body.
    this.noiseLayer(ctx, v, t, 0.19 + 0.42 * s, { type: 'bandpass', freq: (850 - 210 * s) * vary, q: 0.7, decay: 0.08 + 0.015 * s });
    // Shell: inharmonic modes (the first three of MEMBRANE), the lowest one warm for small speakers.
    this.body(ctx, v, t, (180 - 55 * s) * vary, 0.09 + 0.37 * s, {
      ratios: Audio.MEMBRANE,
      amps: [0.55, 0.65, 0.55],
      decays: [0.1 + 0.02 * s, 0.09, 0.07],
      drop: 1.3 + 0.25 * s,
      glide: 0.03,
      warm: true,
    });
  }

  /**
   * Car-car bump or demo. `strength` 0..1 (0.6 a bump, 1 the bump of a demolition, whose explosion
   * playDemolition adds). Two steel bodies meeting: the panels' thud (a warm 135 → 110 Hz plus an
   * inharmonic mode at 1.71×), a crunch of noise whose band closes from 2 kHz to 600 Hz, and the
   * ring, an inharmonic FM clank on 560 Hz (ratio 1.42-1.5) whose partials spread over 0.2-3.5 kHz
   * and mellow as its index falls. The ring leads (it is the clank, and it sits where the ear is
   * most sensitive); the thud gives it weight. Stronger is louder, lower and crunchier. 13 nodes.
   */
  playCarHit(strength: number): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    if (t - this.lastCarHit < CAR_HIT_MIN_INTERVAL) return;
    this.lastCarHit = t;
    const s = clamp01(strength);
    const vary = 0.94 + Math.random() * 0.12;
    const v = this.voice(ctx, 0.3 + 0.7 * s, 0.06 + 0.04 * s);
    // Weight: the panels' low thud.
    this.body(ctx, v, t, (135 - 25 * s) * vary, 0.42, { ratios: [1, 1.71], amps: [0.7, 0.8], decays: [0.15, 0.12], drop: 1.3, glide: 0.03, warm: true });
    // Crunch: bending sheet metal.
    this.noiseLayer(ctx, v, t, 0.4 + 0.25 * s, { type: 'bandpass', freq: 2000, q: 0.7, sweepTo: 600, decay: 0.1 + 0.04 * s });
    // Ring: the shell's metal partials, bright then dull (a slightly different cluster each time).
    this.fm(ctx, v, t, 560 * vary, 0.25, { ratio: 1.42 + Math.random() * 0.08, index: 2 + 1.2 * s, indexEnd: 0.5, indexDecay: 0.07, decay: 0.17 + 0.03 * s, bend: 1.04 });
  }

  /**
   * A car blown up: a sharp crack; a saturated low boom (a warm sub falling onto ~50 Hz plus two
   * rumble partials, so its harmonics at 100-400 Hz carry it on small speakers); a broadband roar
   * whose lowpass sweeps down over a low-mid body band; the car's shell ringing (inharmonic FM);
   * and a short tail of debris crackles, all into the room. `strength` 0..1 (the game lowers it
   * with the distance from the camera): it scales the level and the brightness, and a distant
   * blast comes back a little wetter.
   */
  playDemolition(strength: number): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    if (t - this.lastDemolition < DEMOLITION_MIN_INTERVAL) return;
    this.lastDemolition = t;
    const s = clamp01(strength);
    if (s <= 0) return;
    const far = 1 - s; // 0 next to the camera, 0.8 at the far end
    // Boom: saturated, so a close blast is also grittier.
    const boom = this.voice(ctx, 0.8 * s, 0.3, true);
    this.body(ctx, boom, t, 50, 0.55, { ratios: [1, 2.1, 3.3], amps: [0.65, 0.8, 0.6], decays: [0.6, 0.5, 0.36], drop: 2, glide: 0.1, warm: true });
    const v = this.voice(ctx, 0.8 * s, 0.35 + 0.3 * far);
    this.click(ctx, v, t, 2400 - 1000 * far, 0.3 * (1 - 0.5 * far));
    this.noiseLayer(ctx, v, t, 0.5, { type: 'lowpass', freq: 3000 - 1600 * far, sweepTo: 260, sweepTime: 0.6, decay: 0.8 });
    this.noiseLayer(ctx, v, t, 0.7, { type: 'bandpass', freq: 450, q: 0.7, sweepTo: 220, decay: 0.5 });
    this.fm(ctx, v, t, 190, 0.14, { ratio: 1.41, index: 3, indexEnd: 0.6, decay: 0.42, bend: 1.3, bendTime: 0.04 });
    // Debris: four crackles over the first 0.4 s, each softer and duller than the last.
    for (let i = 0; i < 4; i++) {
      const at = t + 0.08 + i * 0.09 + Math.random() * 0.06;
      this.click(ctx, v, at, (1500 + Math.random() * 900) * (1 - 0.15 * i) * (1 - 0.35 * far), 0.1 * (1 - 0.2 * i));
    }
  }

  /**
   * The car leaving the ground (also the second jump): a short suspension thunk (a soft click and
   * three close inharmonic partials around 120 Hz, the lowest warm, settling a little in pitch)
   * under a push of air (a noise band rising 380 → 1200 Hz and settling to 550 Hz). ~0.13 s.
   */
  playJump(): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const v = this.voice(ctx, 1, 0.08);
    this.click(ctx, v, t, 1100, 0.03);
    this.body(ctx, v, t, 120, 0.067, { ratios: [1, 1.29, 1.71], amps: [0.55, 0.7, 0.6], decays: [0.11, 0.09, 0.08], drop: 1.35, glide: 0.03, warm: true });
    this.noiseLayer(ctx, v, t, 0.22, { type: 'bandpass', freq: 380, q: 1, sweepTo: 1200, sweepTime: 0.06, sweepBack: 550, attack: 0.01, decay: 0.12 });
  }

  /**
   * The flip: a rotating whoosh. Two noise bands cross (one rising 350 → 1400 Hz and settling to
   * 550 Hz, one falling 1 kHz → 300 Hz from 50 ms later) over a low swoosh (a band 200 → 380 →
   * 200 Hz) and a warm 135 Hz tone that scoops up into pitch, so the air has weight. ~0.3 s.
   */
  playDodge(): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const v = this.voice(ctx, 1, 0.15);
    this.noiseLayer(ctx, v, t, 0.19, { type: 'bandpass', freq: 350, q: 1.2, sweepTo: 1400, sweepTime: 0.11, sweepBack: 550, attack: 0.03, decay: 0.2 });
    this.noiseLayer(ctx, v, t + 0.05, 0.115, { type: 'bandpass', freq: 1000, q: 1.1, sweepTo: 300, attack: 0.04, decay: 0.2 });
    this.noiseLayer(ctx, v, t, 0.21, { type: 'bandpass', freq: 200, q: 0.9, sweepTo: 380, sweepTime: 0.09, sweepBack: 200, attack: 0.03, decay: 0.22 });
    this.note(ctx, v, t, 135, 0.038, { ratios: [1], amps: [1], decays: [0.2], attack: 0.03, bend: 0.85, bendTime: 0.08, wave: 'warm' });
  }

  /**
   * The player's car lands. Soft: a muffled tyre thud (a warm 105 Hz and two rubbery partials
   * above it, heavily damped) and the squish of the tread, noise under a lowpass closing from
   * 900 Hz to 300 Hz. Hard: the suspension bottoming out, a slam of three partials on a warm 78 Hz
   * through the shared saturator (grit, and harmonics that small speakers render), a lowpassed
   * noise thump under it and a short metal rattle right after. 13 / 14 nodes.
   */
  playLand(hard: boolean): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const vary = 0.95 + Math.random() * 0.1;
    if (hard) {
      const slam = this.voice(ctx, 1, 0.08, true);
      this.body(ctx, slam, t, 78 * vary, 0.27, { ratios: [1, 2.2, 3.4], amps: [0.5, 0.7, 0.55], decays: [0.16, 0.13, 0.1], drop: 1.6, glide: 0.035, warm: true });
      const v = this.voice(ctx, 1, 0);
      this.noiseLayer(ctx, v, t, 0.3, { type: 'lowpass', freq: 1400, sweepTo: 300, decay: 0.12 });
      this.impactRattle(ctx, v, t + 0.012, 2400 * vary, 0.13, 0.11);
    } else {
      const v = this.voice(ctx, 1, 0.06);
      this.body(ctx, v, t, 105 * vary, 0.07, { ratios: [1, 1.6, 2.3], amps: [0.6, 0.5, 0.5], decays: [0.1, 0.09, 0.07], drop: 1.25, glide: 0.02, warm: true });
      this.noiseLayer(ctx, v, t, 0.18, { type: 'lowpass', freq: 900, q: 1, sweepTo: 300, attack: 0.004, decay: 0.08 });
      this.click(ctx, v, t, 900 * vary, 0.019);
    }
  }

  /**
   * Goal celebration: the stadium horn chord (the team's root, G3 for blue and A3 for red, over
   * its octave below, then the fifth 0.12 s later; detuned pairs through a lowpass that darkens
   * as it fades), a crowd that swells and cheers (the crowd texture made once in buildGraph, read
   * through three vowel-like bands that open and settle) and the explosion boom (a saturated warm
   * sub plus a roar whose lowpass sweeps down).
   */
  playGoal(team: Team): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const base = team === 0 ? 196 : 220; // G3 for blue, A3 for red
    const horn = this.voice(ctx, 1, 0.6);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = 0.7;
    tone.frequency.setValueAtTime(2400, t);
    tone.frequency.exponentialRampToValueAtTime(800, t + 1.6);
    tone.connect(horn);
    this.note(ctx, tone, t, base, 0.22, { ratios: [0.5, 1], amps: [0.6, 1], decays: [1, 0.95], attack: 0.04, hold: 0.56, bend: 0.97, bendTime: 0.06, unison: 12, wave: 'horn' });
    this.note(ctx, tone, t + 0.12, base * 1.5, 0.22, { ratios: [1], amps: [0.42], decays: [0.9], attack: 0.04, hold: 0.44, unison: 10, wave: 'horn' });

    // Crowd: one source, three bands [start, swell, end centre (Hz), Q, peak, swell time (s)]; the
    // lower bands swell first, every band rises then settles ("oh" opening to "ah"). Exponential
    // swell from silence, held to 1.2 s, then a 2 s fade.
    const crowd = this.voice(ctx, 1, 0.5);
    const src = ctx.createBufferSource();
    src.buffer = this.blastCrowd!;
    src.loop = true;
    const end = t + 3.2;
    const vowels = [
      [260, 380, 300, 1.2, 0.2, 0.36],
      [620, 900, 650, 1.5, 0.16, 0.44],
      [1050, 1450, 1100, 1.8, 0.1, 0.5],
    ];
    for (const [f0, f1, f2, q, peak, swell] of vowels) {
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = q;
      band.frequency.setValueAtTime(f0, t);
      band.frequency.exponentialRampToValueAtTime(f1, t + swell + 0.15);
      band.frequency.exponentialRampToValueAtTime(f2, end);
      const g = ctx.createGain();
      g.gain.setValueAtTime(MIN_GAIN, t);
      g.gain.exponentialRampToValueAtTime(peak, t + swell);
      g.gain.setValueAtTime(peak, t + 1.2);
      g.gain.exponentialRampToValueAtTime(Math.max(MIN_GAIN, peak * 0.001), end);
      src.connect(band).connect(g).connect(crowd);
    }
    src.start(t, Math.random() * 1.9);
    src.stop(end);

    // Boom: the sub is saturated (harmonics at 90-400 Hz), the roar goes with the crowd.
    const boom = this.voice(ctx, 0.9, 0.25, true);
    this.body(ctx, boom, t, 44, 0.5, { ratios: [1, 2.1], amps: [0.8, 0.65], decays: [0.6, 0.45], drop: 2, glide: 0.1, warm: true });
    this.noiseLayer(ctx, crowd, t, 0.45, { type: 'lowpass', freq: 700, sweepTo: 90, decay: 0.8 });
  }

  /**
   * Countdown tick (3-2-1, also a training timeout): a warm, rounded bell tone on A4 with its
   * octave A5 leading (the old beep's pitch), held 60 ms and then ringing out with the upper
   * harmonics dying first, a short warm knock an octave below for body and a soft felt tick on
   * the attack.
   */
  playCountdownTick(): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const v = this.voice(ctx, 0.54, 0.12);
    this.note(ctx, v, t, 440, 0.14, { ratios: [1, 2, 3, 4, 5, 6], amps: [0.7, 1, 0.4, 0.3, 0.2, 0.22], decays: [0.2, 0.18, 0.13, 0.1, 0.08, 0.07], attack: 0.002, hold: 0.06 });
    this.body(ctx, v, t, 220, 0.25, { ratios: [1], amps: [1], decays: [0.16], drop: 1.1, glide: 0.015, warm: true });
    this.click(ctx, v, t, 2200, 0.05);
  }

  /**
   * Start signal (also a training save): a short pickup on the tick's A, then, 80 ms later, a
   * ringing A major chord a fifth higher on top (A5, C#6, E6 with soft harmonics, A6), rolled over
   * 10 ms and scooping up into pitch, over a warm A4, a soft A3 thump and a rush of air. The third
   * is pure (5:4), so once settled every partial sits on A3's harmonic series and nothing beats.
   */
  playGo(): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const t2 = t + 0.08;
    const v = this.voice(ctx, 1.2, 0.25);
    // Pickup: the tick's A over its lower octave.
    this.click(ctx, v, t, 2400, 0.05);
    this.note(ctx, v, t, 880, 0.09, { ratios: [0.5, 1], amps: [0.5, 1], decays: [0.14, 0.12], attack: 0.003, hold: 0.035, wave: 'warm' });
    // The chord, rolled (root, then third and fifth, then the octave): richer, and a lower crest.
    this.click(ctx, v, t2, 2800, 0.05);
    this.note(ctx, v, t2, 880, 0.08, { ratios: [1], amps: [0.8], decays: [0.55], attack: 0.004, hold: 0.16, bend: 0.97, bendTime: 0.03, wave: 'warm' });
    this.note(ctx, v, t2 + 0.005, 880, 0.08, { ratios: [1.25, 1.5], amps: [0.45, 1], decays: [0.45, 0.6], attack: 0.004, hold: 0.155, bend: 0.97, bendTime: 0.03, wave: 'warm' });
    this.note(ctx, v, t2 + 0.01, 1760, 0.028, { ratios: [1], amps: [1], decays: [0.35], attack: 0.004, hold: 0.15, bend: 0.97, bendTime: 0.03 });
    // Body under it and a rush of low-mid air as it opens (kept under 1.4 kHz: no hiss).
    this.note(ctx, v, t2, 440, 0.08, { ratios: [1], amps: [1], decays: [0.45], attack: 0.004, hold: 0.12, wave: 'warm' });
    this.body(ctx, v, t2, 220, 0.07, { ratios: [1], amps: [1], decays: [0.2], drop: 1.25, glide: 0.03, warm: true });
    this.noiseLayer(ctx, v, t2, 0.11, { type: 'bandpass', freq: 400, q: 0.7, sweepTo: 1400, sweepTime: 0.12, sweepBack: 700, attack: 0.01, decay: 0.3 });
  }

  /**
   * MATCH FOUND (src/ui/screens/match/found.ts): the countdown's warm A rising to its E a fifth
   * up, 90 ms apart, short and bright (it may sound over the menus or a free practice).
   */
  playMatchFound(): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const v = this.voice(ctx, 0.6, 0.12);
    this.click(ctx, v, t, 2200, 0.04);
    this.note(ctx, v, t, 880, 0.1, { ratios: [1, 2], amps: [1, 0.35], decays: [0.18, 0.12], attack: 0.003, hold: 0.05, wave: 'warm' });
    this.note(ctx, v, t + 0.09, 1320, 0.1, { ratios: [1, 2], amps: [1, 0.3], decays: [0.3, 0.16], attack: 0.003, hold: 0.08, wave: 'warm' });
  }

  /**
   * Boost pad pickup. Small: a light blip rising onto D6, a glassy FM sparkle (sidebands on the D5
   * series) fading into the tone, over a hollow D5 and a touch of warm D4; short and soft, since it
   * can repeat several times a second, and a hair of random pitch so a row of pads does not sound
   * stamped. Big: a power-up, a G major arpeggio (G5, B5, D6, each over its lower octave) on a
   * warm low note gliding up to G3 and a low-mid whoosh that opens and settles.
   */
  playPadPickup(big: boolean): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    if (big) {
      const v = this.voice(ctx, 0.82, 0.1);
      this.noiseLayer(ctx, v, t, 0.12, { type: 'bandpass', freq: 300, q: 1, sweepTo: 1500, sweepTime: 0.12, sweepBack: 700, attack: 0.02, decay: 0.22 });
      this.body(ctx, v, t, 196, 0.04, { ratios: [1], amps: [1], decays: [0.22], drop: 0.75, glide: 0.08, warm: true });
      this.click(ctx, v, t, 2600, 0.03);
      this.note(ctx, v, t, 783.99, 0.025, { ratios: [0.5, 1, 2], amps: [0.8, 1, 0.45], decays: [0.14, 0.15, 0.08], attack: 0.002 });
      this.note(ctx, v, t + 0.045, 987.77, 0.025, { ratios: [0.5, 1, 2], amps: [0.8, 1, 0.45], decays: [0.14, 0.15, 0.08], attack: 0.002 });
      this.note(ctx, v, t + 0.09, 1174.66, 0.03, { ratios: [0.5, 1, 2, 3], amps: [0.8, 1, 0.45, 0.2], decays: [0.2, 0.24, 0.12, 0.08], attack: 0.002 });
    } else {
      const f = 1174.66 * (0.994 + Math.random() * 0.012);
      const v = this.voice(ctx, 0.45, 0.1);
      this.fm(ctx, v, t, f, 0.06, { ratio: 1.5, index: 1.3, indexEnd: 0.55, indexDecay: 0.1, attack: 0.002, decay: 0.15, bend: 0.88, bendTime: 0.02 });
      this.note(ctx, v, t, f * 0.5, 0.065, { ratios: [1, 3], amps: [1, 0.3], decays: [0.15, 0.1], attack: 0.002, bend: 0.88, bendTime: 0.02 });
      this.note(ctx, v, t, f * 0.25, 0.035, { ratios: [1], amps: [1], decays: [0.12], attack: 0.002, wave: 'warm' });
      this.click(ctx, v, t, 2400, 0.025);
    }
  }

  /**
   * Boost ignition: a whump of flame that settles into the roar loop. Lowpassed noise opening
   * 180 → 1100 Hz in 50 ms and closing to 420 Hz over a warm body on the hum's harmonic series
   * (1-4 × the frequency the loop's hum is at, so it blends), dropping into pitch. (Also fired by
   * update() on the edge.)
   */
  playBoostStart(): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    if (t - this.lastBoostStart < BOOST_START_MIN_INTERVAL) return;
    this.lastBoostStart = t;
    const hum = this.sentBoostHum > 0 ? this.sentBoostHum : 58; // 58-73 Hz with the speed
    const v = this.voice(ctx, 1, 0.1);
    this.noiseLayer(ctx, v, t, 0.105, { type: 'lowpass', freq: 180, q: 1, sweepTo: 1100, sweepTime: 0.05, sweepBack: 420, attack: 0.004, decay: 0.3 });
    this.body(ctx, v, t, hum, 0.041, { ratios: [1, 2, 3, 4], amps: [0.4, 0.6, 0.55, 0.4], decays: [0.26, 0.22, 0.18, 0.15], drop: 1.6, glide: 0.06, warm: true });
  }

  /**
   * Boost release: a short low puff that flutters out. Lowpassed noise closing 1 kHz → 260 Hz and
   * a band at 340 Hz over a warm 110 Hz body with its fifth, decaying about as fast as the roar's
   * own fade (a faster puff hides under it), through a voice whose gain a 30 → 14 Hz flutter
   * swings, fading out with the puff. ~0.2 s. (Also fired by update() on the edge.)
   */
  playBoostStop(): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const v = this.voice(ctx, 1, 0.06);
    this.noiseLayer(ctx, v, t, 0.072, { type: 'lowpass', freq: 1000, sweepTo: 260, attack: 0.003, decay: 0.22 });
    this.noiseLayer(ctx, v, t, 0.06, { type: 'bandpass', freq: 340, q: 1, attack: 0.003, decay: 0.2 });
    this.body(ctx, v, t, 110, 0.024, { ratios: [1, 1.5], amps: [0.7, 0.6], decays: [0.165, 0.155], drop: 1.25, glide: 0.04, warm: true });
    this.moveFlutter(ctx, v, t, t + 0.223, 30, 14, 0.6);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const ctx = this.ctx;
    if (ctx === null) return;
    try {
      this.engOsc?.stop();
      this.engAm?.stop();
      this.engNoise?.stop();
      this.boostSrc?.stop();
      this.boostHumA?.stop();
      this.boostHumB?.stop();
      this.windSrc?.stop();
      this.windLfo?.stop();
    } catch {
      /* already stopped */
    }
    void ctx.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
    this.sfx = null;
    this.noise = null;
    this.oneShot = null;
    this.roomIn = null;
    this.room = null;
    this.sat = null;
    this.warmWave = null;
    this.hornWave = null;
    this.clickBuf = null;
    this.blastCrowd = null;
    this.engOsc = null;
    this.engAm = null;
    this.engNoise = null;
    this.engBand = null;
    this.engNoiseGain = null;
    this.engDrive = null;
    this.engFilter = null;
    this.engGain = null;
    this.boostSrc = null;
    this.boostFilter = null;
    this.boostFilter2 = null;
    this.boostHumA = null;
    this.boostHumB = null;
    this.boostGain = null;
    this.windSrc = null;
    this.windBand = null;
    this.windLfo = null;
    this.windGain = null;
  }

  // ---- Internals ----------------------------------------------------------------------------

  /** The context when sound can be produced, else null. */
  private ready(): AudioContext | null {
    const ctx = this.ctx;
    return ctx !== null && ctx.state === 'running' && this.sfx !== null ? ctx : null;
  }

  private buildGraph(): void {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.sentEngF = this.sentEngBand = this.sentEngNoise = this.sentEngDrive = this.sentEngFilter = this.sentEngGain = -1;
    this.sentBoostGain = this.sentBoostFilter = this.sentBoostHum = this.sentWind = this.sentWindBand = -1;
    this.engine.reset();

    // Output chain: sfx → master → compressor (gentle limiter so stacked impacts do not clip).
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    comp.connect(ctx.destination);
    const master = ctx.createGain();
    master.gain.value = this.volume;
    master.connect(comp);
    this.master = master;
    const sfx = ctx.createGain();
    sfx.gain.value = 1;
    sfx.connect(master);
    this.sfx = sfx;

    // One-shots: their own dry bus plus a send into one shared short room (a convolver over a
    // synthetic stereo impulse made here, 0.55 s). The continuous layers stay on sfx, unchanged.
    const oneShot = ctx.createGain();
    oneShot.gain.value = 1;
    oneShot.connect(master);
    this.oneShot = oneShot;
    // Without the room (super low) the one-shots stay dry: no convolver on the audio thread.
    if (this.withRoom) {
      const room = ctx.createConvolver();
      room.normalize = false; // makeRoomImpulse scales the impulse itself (unity over 125 Hz-4 kHz)
      room.buffer = this.makeRoomImpulse(ctx);
      room.connect(master);
      this.room = room;
      const roomIn = ctx.createGain();
      roomIn.gain.value = 0.5; // return level: a voice sent at 1 comes back 6 dB below its own energy
      roomIn.connect(room);
      this.roomIn = roomIn;
    }
    // Shared soft saturator for sub / body voices: tanh(2.5x) / 2.5, unity gain for small signals,
    // so the level fed in sets the drive. Low-frequency material only, hence no oversampling.
    const satCurve = new Float32Array(1025); // odd length: an input of 0 maps exactly to 0 (no DC)
    for (let i = 0; i < satCurve.length; i++) {
      const x = (i / (satCurve.length - 1)) * 2 - 1;
      satCurve[i] = Math.tanh(2.5 * x) / 2.5;
    }
    const sat = ctx.createWaveShaper();
    sat.curve = satCurve;
    sat.oversample = 'none';
    sat.connect(oneShot);
    this.sat = sat;
    // Timbres made once: a warm sine (soft harmonics 2-8, so a sub is heard on small speakers), a
    // brass-like horn (16 harmonics, strongest at the 2nd-3rd) and four short click variants.
    this.warmWave = this.makeWave(ctx, [1, 0.45, 0.28, 0.16, 0.1, 0.06, 0.035, 0.02], false);
    this.hornWave = this.makeWave(ctx, [0.75, 1, 0.9, 0.7, 0.52, 0.38, 0.28, 0.2, 0.14, 0.1, 0.07, 0.05, 0.035, 0.025, 0.017, 0.012], true);
    this.clickBuf = this.makeClickBuffer(ctx);
    // Goal crowd: 2 s of fluttering noise with claps, made once (playGoal reads it through bands).
    this.blastCrowd = this.blastMakeCrowd(ctx);

    // 2 s of white noise shared by every noise layer.
    const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = noise;

    // Engine: (crank tone + exhaust pulses) → drive → saturator → lowpass → gain.
    const idleCrank = IDLE_RPM / 60;
    const engFilter = ctx.createBiquadFilter();
    engFilter.type = 'lowpass';
    engFilter.frequency.value = 400;
    engFilter.Q.value = 0.8;
    const engGain = ctx.createGain();
    engGain.gain.value = 0;
    engFilter.connect(engGain).connect(sfx);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    shaper.connect(engFilter);
    const engDrive = ctx.createGain();
    engDrive.gain.value = 1.2;
    engDrive.connect(shaper);
    // Crank tone: the engine orders as one periodic wave (fixed phases, so it never changes).
    const real = new Float32Array(ENGINE_ORDERS.length + 1);
    const imag = new Float32Array(ENGINE_ORDERS.length + 1);
    for (let k = 1; k <= ENGINE_ORDERS.length; k++) {
      const phase = (k * k * 0.7) % (Math.PI * 2);
      real[k] = ENGINE_ORDERS[k - 1] * Math.cos(phase);
      imag[k] = ENGINE_ORDERS[k - 1] * Math.sin(phase);
    }
    const engOsc = ctx.createOscillator();
    engOsc.setPeriodicWave(ctx.createPeriodicWave(real, imag));
    engOsc.frequency.value = idleCrank;
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0.5;
    engOsc.connect(toneGain).connect(engDrive);
    // Exhaust pulses: looped noise → bandpass → pulse gain (0.6 ± 0.6 at the firing frequency) → level.
    const engNoise = ctx.createBufferSource();
    engNoise.buffer = noise;
    engNoise.loop = true;
    engNoise.loopStart = 0.9; // offset from the boost / wind layers
    engNoise.loopEnd = 2;
    const engBand = ctx.createBiquadFilter();
    engBand.type = 'bandpass';
    engBand.frequency.value = idleCrank * 4 * 2.2 + 250;
    engBand.Q.value = 1.1;
    const pulse = ctx.createGain();
    pulse.gain.value = 0.6;
    const engAm = ctx.createOscillator();
    engAm.type = 'sine';
    engAm.frequency.value = idleCrank * 4;
    const amDepth = ctx.createGain();
    amDepth.gain.value = 0.6;
    engAm.connect(amDepth).connect(pulse.gain);
    const engNoiseGain = ctx.createGain();
    engNoiseGain.gain.value = 0.25;
    engNoise.connect(engBand).connect(pulse).connect(engNoiseGain).connect(engDrive);
    engOsc.start();
    engAm.start();
    engNoise.start(0, 0.9);
    this.engOsc = engOsc;
    this.engAm = engAm;
    this.engNoise = engNoise;
    this.engBand = engBand;
    this.engNoiseGain = engNoiseGain;
    this.engDrive = engDrive;
    this.engFilter = engFilter;
    this.engGain = engGain;

    // Boost: (deep roar + body band + low hum) → gain.
    const boostGain = ctx.createGain();
    boostGain.gain.value = 0;
    boostGain.connect(sfx);
    const boostSrc = ctx.createBufferSource();
    boostSrc.buffer = noise;
    boostSrc.loop = true;
    const boostFilter = ctx.createBiquadFilter();
    boostFilter.type = 'lowpass';
    boostFilter.frequency.value = 320;
    boostFilter.Q.value = 0.6;
    const boostFilter2 = ctx.createBiquadFilter();
    boostFilter2.type = 'lowpass';
    boostFilter2.frequency.value = 320;
    boostFilter2.Q.value = 0.6;
    const roar = ctx.createGain();
    roar.gain.value = 1.4;
    boostSrc.connect(boostFilter).connect(boostFilter2).connect(roar).connect(boostGain);
    const body = ctx.createBiquadFilter();
    body.type = 'bandpass';
    body.frequency.value = 150;
    body.Q.value = 1.3;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 1.6;
    boostSrc.connect(body).connect(bodyGain).connect(boostGain);
    const humFilter = ctx.createBiquadFilter();
    humFilter.type = 'lowpass';
    humFilter.frequency.value = 260;
    humFilter.Q.value = 0.7;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.3;
    humFilter.connect(humGain).connect(boostGain);
    const humA = ctx.createOscillator();
    humA.type = 'sawtooth';
    humA.frequency.value = 58;
    const humB = ctx.createOscillator();
    humB.type = 'sawtooth';
    humB.frequency.value = 87;
    humB.detune.value = 4;
    const humBGain = ctx.createGain();
    humBGain.gain.value = 0.6;
    humA.connect(humFilter);
    humB.connect(humBGain).connect(humFilter);
    boostSrc.start();
    humA.start();
    humB.start();
    this.boostSrc = boostSrc;
    this.boostFilter = boostFilter;
    this.boostFilter2 = boostFilter2;
    this.boostHumA = humA;
    this.boostHumB = humB;
    this.boostGain = boostGain;

    // Supersonic wind: looped noise → wide band → lowpass → gust (0.75 ± 0.25 at 0.7 Hz) → gain.
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = noise;
    windSrc.loop = true;
    windSrc.loopStart = 0.5; // offset so it does not phase-lock with the boost layer
    windSrc.loopEnd = 2;
    const windBand = ctx.createBiquadFilter();
    windBand.type = 'bandpass';
    windBand.frequency.value = 700;
    windBand.Q.value = 0.45;
    const windLow = ctx.createBiquadFilter();
    windLow.type = 'lowpass';
    windLow.frequency.value = 1800;
    windLow.Q.value = 0.5;
    const gust = ctx.createGain();
    gust.gain.value = 0.75;
    const windLfo = ctx.createOscillator();
    windLfo.type = 'sine';
    windLfo.frequency.value = 0.7;
    const gustDepth = ctx.createGain();
    gustDepth.gain.value = 0.25;
    windLfo.connect(gustDepth).connect(gust.gain);
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    windSrc.connect(windBand).connect(windLow).connect(gust).connect(windGain).connect(sfx);
    windSrc.start(0, 0.5);
    windLfo.start();
    this.windSrc = windSrc;
    this.windBand = windBand;
    this.windLfo = windLfo;
    this.windGain = windGain;
  }

  /** Filtered noise with an exponential decay, `delay` seconds from now, on the sfx bus (the engine pops). `sweepTo` optionally sweeps the filter down. */
  private noiseBurst(ctx: AudioContext, type: BiquadFilterType, freq: number, q: number, dur: number, gain: number, sweepTo = 0, delay = 0): void {
    if (gain <= MIN_GAIN) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, t);
    if (sweepTo > 0) filter.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + dur);
    src.connect(filter).connect(g).connect(this.sfx!);
    // Random offset into the buffer so repeated bursts do not sound identical.
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur);
  }

  // ---- One-shot toolkit ---------------------------------------------------------------------
  // A one-shot is `const v = this.voice(ctx, level, send)` plus layers connected into `v`, each
  // at an absolute context time (`ctx.currentTime + offset`, so layers can be sequenced). Every
  // layer stops its own sources the moment its envelope ends. Decays are 60 dB falls (T60).

  /**
   * Routing of one one-shot: a gain at `level` into the dry one-shot bus (into the shared soft
   * saturator instead with `saturate`) plus, when `send` > 0, `send` (0..1) of it into the room
   * (taken before the saturator, so the room stays clean). Connect the layers into the returned
   * node. 1 node, 2 with a send; it is released with its last source.
   */
  private voice(ctx: AudioContext, level: number, send: number, saturate = false): GainNode {
    const out = ctx.createGain();
    out.gain.value = level;
    out.connect(saturate ? this.sat! : this.oneShot!);
    const roomIn = this.roomIn;
    if (send > 0 && roomIn !== null) {
      const s = ctx.createGain();
      s.gain.value = send;
      out.connect(s).connect(roomIn);
    }
    return out;
  }

  /**
   * Envelope on a gain param: 0 → `peak` in `attack` s (linear; 0 = instant), held `hold` s, then
   * an exponential fall of 60 dB in `decay` s (never below MIN_GAIN, never to 0). Returns the end time.
   */
  private envelope(p: AudioParam, at: number, peak: number, attack: number, hold: number, decay: number): number {
    const top = at + attack;
    if (attack > 0) {
      p.setValueAtTime(0, at);
      p.linearRampToValueAtTime(peak, top);
    } else {
      p.setValueAtTime(peak, at);
    }
    if (hold > 0) p.setValueAtTime(peak, top + hold);
    const end = top + hold + Math.max(0.005, decay);
    p.exponentialRampToValueAtTime(Math.max(MIN_GAIN, peak * 0.001), end);
    return end;
  }

  /** An oscillator's wave: a built-in type or one of the shared periodic waves (made in buildGraph). */
  private setWave(osc: OscillatorNode, wave: Exclude<OscillatorType, 'custom'> | 'warm' | 'horn'): void {
    if (wave === 'warm') osc.setPeriodicWave(this.warmWave!);
    else if (wave === 'horn') osc.setPeriodicWave(this.hornWave!);
    else osc.type = wave;
  }

  /**
   * Pitched impact body: a sine partial per ratio at `freq × ratio`, all starting `drop` times
   * higher and settling on pitch in about `glide` s (fast at first, like a struck skin or panel),
   * each with its own peak (`amps` × `gain`) and 60 dB decay (`decays`). `warm` gives partial 0
   * the warm wave (soft harmonics 2-8): use it for anything under ~150 Hz so small speakers
   * render it. 2 nodes per partial.
   */
  private body(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    freq: number,
    gain: number,
    spec: {
      /** Frequency ratios to `freq`: harmonic for tones, inharmonic (MEMBRANE, PANEL) for shells and metal. */
      ratios: readonly number[];
      /** Peak of each partial relative to `gain`. */
      amps: readonly number[];
      /** 60 dB decay of each partial, s (a shorter list repeats its last entry). */
      decays: readonly number[];
      /** Start pitch as a multiple of the final one, default 1.5 (1 = no drop). */
      drop?: number;
      /** Time to settle on pitch, s, default 0.04. */
      glide?: number;
      /** Linear attack, s, default 0.001 (partials start at zero phase, so 0 does not click either). */
      attack?: number;
      /** Partial 0 uses the warm wave (soft harmonics 2-8). */
      warm?: boolean;
    },
  ): void {
    if (gain <= MIN_GAIN) return;
    const drop = spec.drop ?? 1.5;
    const glide = spec.glide ?? 0.04;
    const attack = spec.attack ?? 0.001;
    const decays = spec.decays;
    for (let i = 0; i < spec.ratios.length; i++) {
      const peak = gain * (i < spec.amps.length ? spec.amps[i] : 0);
      const f = freq * spec.ratios[i];
      if (peak <= MIN_GAIN || f * drop > 16000) continue;
      const osc = ctx.createOscillator();
      if (i === 0 && spec.warm === true) osc.setPeriodicWave(this.warmWave!);
      osc.frequency.setValueAtTime(f * drop, at);
      if (drop !== 1) osc.frequency.setTargetAtTime(f, at, glide / 3);
      const g = ctx.createGain();
      const end = this.envelope(g.gain, at, peak, attack, 0, decays[Math.min(i, decays.length - 1)]);
      osc.connect(g).connect(out);
      osc.start(at);
      osc.stop(end);
    }
  }

  /**
   * Additive note: a partial per ratio at `freq × ratio`, each with its own peak (`amps` ×
   * `gain`) and 60 dB decay (`decays`, after the shared attack and hold), so the upper partials
   * can die first like a real mallet, pluck or bell. `bend` starts the pitch that many times off
   * and settles in about `bendTime` s (a horn scoop below 1, a pluck drop above). `unison` (cents)
   * doubles every partial with a copy detuned that far (each copy at half level: same peak). 2
   * nodes per partial, 3 with unison.
   */
  private note(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    freq: number,
    gain: number,
    spec: {
      /** Frequency ratios to `freq` (HARMONIC for tones and horns, BAR or custom for bells). */
      ratios: readonly number[];
      /** Peak of each partial relative to `gain`. */
      amps: readonly number[];
      /** 60 dB decay of each partial after attack + hold, s (a shorter list repeats its last entry). */
      decays: readonly number[];
      /** Linear attack, s, default 0.004. */
      attack?: number;
      /** Time held at the peak before the decay, s, default 0. */
      hold?: number;
      /** Start pitch as a multiple of the final one, default 1. */
      bend?: number;
      /** Time to settle on pitch, s, default 0.05. */
      bendTime?: number;
      /** Detune between the two copies of each partial, cents; default 0 (one copy). */
      unison?: number;
      /** Wave of every partial, default 'sine'. 'horn' already holds 16 harmonics: use one or two partials. */
      wave?: Exclude<OscillatorType, 'custom'> | 'warm' | 'horn';
    },
  ): void {
    if (gain <= MIN_GAIN) return;
    const attack = spec.attack ?? 0.004;
    const hold = spec.hold ?? 0;
    const bend = spec.bend ?? 1;
    const bendTime = spec.bendTime ?? 0.05;
    const unison = spec.unison ?? 0;
    const copies = unison > 0 ? 2 : 1;
    const decays = spec.decays;
    for (let i = 0; i < spec.ratios.length; i++) {
      const peak = (gain * (i < spec.amps.length ? spec.amps[i] : 0)) / copies;
      const f = freq * spec.ratios[i];
      if (peak <= MIN_GAIN || f * bend > 16000) continue;
      const g = ctx.createGain();
      const end = this.envelope(g.gain, at, peak, attack, hold, decays[Math.min(i, decays.length - 1)]);
      g.connect(out);
      for (let c = 0; c < copies; c++) {
        const osc = ctx.createOscillator();
        this.setWave(osc, spec.wave ?? 'sine');
        if (copies === 2) osc.detune.value = c === 0 ? -unison / 2 : unison / 2;
        osc.frequency.setValueAtTime(f * bend, at);
        if (bend !== 1) osc.frequency.setTargetAtTime(f, at, bendTime / 3);
        osc.connect(g);
        osc.start(at);
        osc.stop(end);
      }
    }
  }

  /**
   * Two-operator FM note: a sine carrier at `freq` whose frequency a sine modulator at `freq ×
   * ratio` swings by `index` × the modulator frequency. The index falls from `index` to
   * `indexEnd` in `indexDecay` s, so the note starts bright and mellows like a struck bar or bell.
   * Integer ratios give harmonic spectra (1 brassy, 2 hollow: odd harmonics), others inharmonic (1.4
   * bell, 3.5 metallic). Index 1-3 is warm, above 5 it gets harsh. 4 nodes.
   */
  private fm(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    freq: number,
    gain: number,
    spec: {
      /** Modulator frequency / carrier frequency. */
      ratio: number;
      /** Peak modulation index (audible sidebands: about index + 1 on each side of the carrier). */
      index: number;
      /** Index at the end of `indexDecay`, default index × 0.2. */
      indexEnd?: number;
      /** Time for the index to fall, s, default half of `decay`. */
      indexDecay?: number;
      /** Linear attack, s, default 0.002. */
      attack?: number;
      /** Time held at the peak before the decay, s, default 0. */
      hold?: number;
      /** 60 dB amplitude decay after attack + hold, s. */
      decay: number;
      /** Start pitch as a multiple of the final one, default 1. */
      bend?: number;
      /** Time to settle on pitch, s, default 0.05. */
      bendTime?: number;
    },
  ): void {
    if (gain <= MIN_GAIN) return;
    const bend = spec.bend ?? 1;
    const bendTime = spec.bendTime ?? 0.05;
    const fMod = freq * spec.ratio;
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    car.frequency.setValueAtTime(freq * bend, at);
    mod.frequency.setValueAtTime(fMod * bend, at);
    if (bend !== 1) {
      car.frequency.setTargetAtTime(freq, at, bendTime / 3);
      mod.frequency.setTargetAtTime(fMod, at, bendTime / 3);
    }
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(Math.max(MIN_GAIN, spec.index * fMod), at);
    const indexEnd = spec.indexEnd ?? spec.index * 0.2;
    depth.gain.exponentialRampToValueAtTime(Math.max(MIN_GAIN, indexEnd * fMod), at + (spec.indexDecay ?? spec.decay * 0.5));
    const amp = ctx.createGain();
    const end = this.envelope(amp.gain, at, gain, spec.attack ?? 0.002, spec.hold ?? 0, spec.decay);
    mod.connect(depth).connect(car.frequency);
    car.connect(amp).connect(out);
    car.start(at);
    mod.start(at);
    car.stop(end);
    mod.stop(end);
  }

  /**
   * Filtered noise from a random point of the shared noise buffer: a `type` filter at `freq`,
   * optionally swept to `sweepTo` by `sweepTime` and on to `sweepBack` by the end, under an
   * attack / hold / 60 dB decay envelope peaking at `gain`. Q is linear for 'bandpass' (0.8 ≈
   * 1.7 octaves wide, 2 ≈ 0.7 octave; narrower passes less energy) and a resonance in dB for
   * 'lowpass' / 'highpass' (-3 flat, 0 a 1 dB bump, keep it ≤ 6). 3 nodes.
   */
  private noiseLayer(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    gain: number,
    spec: {
      type: 'lowpass' | 'highpass' | 'bandpass';
      /** Filter frequency at `at`, Hz. */
      freq: number;
      /** Default 0.8 for 'bandpass', 0 (dB) for 'lowpass' / 'highpass'. */
      q?: number;
      /** Filter frequency reached at `sweepTime` (exponential glide). */
      sweepTo?: number;
      /** When `sweepTo` is reached, s after `at`; default the end of the envelope. */
      sweepTime?: number;
      /** Filter frequency at the end of the envelope, from `sweepTo` (a whoosh that rises then settles). */
      sweepBack?: number;
      /** Linear attack, s, default 0.001. */
      attack?: number;
      /** Time held at the peak before the decay, s, default 0. */
      hold?: number;
      /** 60 dB decay after attack + hold, s. */
      decay: number;
    },
  ): void {
    if (gain <= MIN_GAIN) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    src.loop = true; // so a layer longer than what is left after the random offset never runs dry
    const filter = ctx.createBiquadFilter();
    filter.type = spec.type;
    filter.Q.value = spec.q ?? (spec.type === 'bandpass' ? 0.8 : 0);
    filter.frequency.setValueAtTime(spec.freq, at);
    const g = ctx.createGain();
    const end = this.envelope(g.gain, at, gain, spec.attack ?? 0.001, spec.hold ?? 0, spec.decay);
    if (spec.sweepTo !== undefined) {
      const ts = Math.min(end, at + (spec.sweepTime ?? end - at));
      filter.frequency.exponentialRampToValueAtTime(spec.sweepTo, ts);
      if (spec.sweepBack !== undefined && ts < end) filter.frequency.exponentialRampToValueAtTime(spec.sweepBack, end);
    }
    src.connect(filter).connect(g).connect(out);
    src.start(at, Math.random() * 1.9);
    src.stop(end);
  }

  /**
   * Transient: one of four band-limited noise ticks (made once) centred near `freq`, peak `gain`.
   * It is played at freq / 3 kHz, so lower is also longer: 3 kHz lasts ~6 ms, 1.5 kHz ~12 ms,
   * 750 Hz ~25 ms (`freq` is kept within 600-4500 Hz). 2 nodes.
   */
  private click(ctx: AudioContext, out: AudioNode, at: number, freq: number, gain: number): void {
    if (gain <= MIN_GAIN) return;
    const buf = this.clickBuf!;
    const seg = buf.duration / 4;
    const rate = Math.min(1.5, Math.max(0.2, freq / 3000)) * (0.96 + Math.random() * 0.08);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(out);
    src.start(at, Math.floor(Math.random() * 4) * seg);
    src.stop(at + seg / rate);
  }

  /**
   * Stereo impulse of a short, warm room (made once). Early reflections at 7-43 ms (different on
   * each side, a fifth of the energy, softened by a 1.5 / 5 kHz lowpass pair) and a diffuse tail
   * that fades in over 30 ms and falls 60 dB in 0.44 s (left) / 0.49 s (right) through a lowpass
   * pair gliding 900 → 400 Hz and 4.5 → 2.2 kHz (darker as it decays); a 110 Hz highpass pair keeps
   * the subs out. Each channel has its own noise (width). Scaled so a sound in the 125 Hz-4 kHz
   * range comes back with about its own energy, for a convolver with normalize = false.
   */
  private makeRoomImpulse(ctx: BaseAudioContext): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 0.55);
    const fade = Math.floor(sr * 0.04);
    const ir = ctx.createBuffer(2, len, sr);
    const early = new Float32Array(Math.floor(sr * 0.05));
    // Early reflections per channel: time (s), gain, alternating sign.
    const taps = [
      [0.0071, 0.55, 0.0119, -0.42, 0.0173, 0.36, 0.0236, -0.3, 0.0312, 0.24, 0.0398, -0.19],
      [0.0083, -0.5, 0.0134, 0.4, 0.0191, -0.34, 0.026, 0.28, 0.0345, -0.22, 0.0431, 0.17],
    ];
    const rt60 = [0.44, 0.49];
    const onePole = (hz: number): number => 1 - Math.exp((-2 * Math.PI * hz) / sr);
    const aHp = onePole(110);
    const aE1 = onePole(1500);
    const aE2 = onePole(5000);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      // Diffuse tail: noise, fade-in from 12 ms, -60 dB at rt60, gliding lowpass pair (its
      // coefficients refreshed every 64 samples).
      const step = Math.exp(-6.91 / rt60[c] / sr);
      let env = 1;
      let a1 = 0;
      let a2 = 0;
      let l1 = 0;
      let l2 = 0;
      let eTail = 0;
      for (let i = 0; i < len; i++) {
        if ((i & 63) === 0) {
          const u = i / len;
          a1 = onePole(900 * Math.pow(400 / 900, u));
          a2 = onePole(4500 * Math.pow(2200 / 4500, u));
        }
        const t = i / sr;
        const onset = t < 0.012 ? 0 : Math.min(1, (t - 0.012) / 0.03);
        l1 += a1 * ((Math.random() * 2 - 1) * onset * env - l1);
        l2 += a2 * (l1 - l2);
        env *= step;
        d[i] = l2;
        eTail += l2 * l2;
      }
      // Early reflections through their own, brighter lowpass pair.
      early.fill(0);
      const tc = taps[c];
      for (let j = 0; j < tc.length; j += 2) early[Math.floor(tc[j] * sr)] = tc[j + 1];
      let e1 = 0;
      let e2 = 0;
      let eEarly = 0;
      for (let i = 0; i < early.length; i++) {
        e1 += aE1 * (early[i] - e1);
        e2 += aE2 * (e1 - e2);
        early[i] = e2;
        eEarly += e2 * e2;
      }
      // Mix (reflections a fifth of the energy), highpass pair, end fade, then scale.
      const gTail = Math.sqrt(0.8 / eTail);
      const gEarly = Math.sqrt(0.2 / eEarly);
      let h1 = 0;
      let h2 = 0;
      let energy = 0;
      for (let i = 0; i < len; i++) {
        const x = d[i] * gTail + (i < early.length ? early[i] * gEarly : 0);
        h1 += aHp * (x - h1);
        const h = x - h1;
        h2 += aHp * (h - h2);
        const left = len - i;
        const y = (h - h2) * (left < fade ? 0.5 - 0.5 * Math.cos((Math.PI * left) / fade) : 1);
        d[i] = y;
        energy += y * y;
      }
      // At unit energy the 125 Hz-4 kHz bands average +10 dB (the energy sits there): -10 dB.
      const norm = 0.32 / Math.sqrt(energy);
      for (let i = 0; i < len; i++) d[i] *= norm;
    }
    return ir;
  }

  /**
   * Periodic wave from harmonic amplitudes (index 0 = the fundamental), normalized to a peak of 1.
   * `spread` gives the harmonics Schroeder phases for this spectrum (a low crest factor: about 3 dB
   * louder for the same peak, but the wave no longer starts at zero, so it needs an attack);
   * without it every harmonic is in sine phase and the wave starts at zero.
   */
  private makeWave(ctx: BaseAudioContext, amps: readonly number[], spread: boolean): PeriodicWave {
    const n = amps.length + 1;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    let power = 0;
    for (const a of amps) power += a * a;
    for (let k = 1; k < n; k++) {
      // Schroeder: phase_k = -2π Σ (k - l) p_l over the lower harmonics l (p = power share).
      let phase = 0;
      if (spread) for (let l = 1; l < k; l++) phase -= (2 * Math.PI * (k - l) * amps[l - 1] * amps[l - 1]) / power;
      real[k] = amps[k - 1] * Math.sin(phase);
      imag[k] = amps[k - 1] * Math.cos(phase);
    }
    return ctx.createPeriodicWave(real, imag);
  }

  /**
   * Four 12 ms click variants back to back (made once): white noise with a 0.3 ms attack and a
   * 1.5 ms exponential decay through a band-pass at 3 kHz (Q 0.9), each normalized to a peak of 1.
   */
  private makeClickBuffer(ctx: BaseAudioContext): AudioBuffer {
    const sr = ctx.sampleRate;
    const seg = Math.floor(sr * 0.012);
    const buf = ctx.createBuffer(1, seg * 4, sr);
    const d = buf.getChannelData(0);
    const w = (2 * Math.PI * 3000) / sr;
    const alpha = Math.sin(w) / (2 * 0.9);
    const a0 = 1 + alpha;
    const b0 = alpha / a0;
    const a1 = (-2 * Math.cos(w)) / a0;
    const a2 = (1 - alpha) / a0;
    for (let v = 0; v < 4; v++) {
      const o = v * seg;
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;
      let peak = 0;
      for (let i = 0; i < seg; i++) {
        const t = i / sr;
        const x = (Math.random() * 2 - 1) * Math.min(1, t / 0.0003) * Math.exp(-t / 0.0015);
        const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        d[o + i] = y;
        if (Math.abs(y) > peak) peak = Math.abs(y);
      }
      for (let i = 0; i < seg; i++) d[o + i] /= peak;
    }
    return buf;
  }

  /**
   * Metal rattle (impacts): the four click variants looped back to back, so a tick near `freq`
   * comes every 12 ms × 3 kHz / `freq` (15 ms at 2.4 kHz), at `gain` and fading 60 dB in `decay`
   * s while the rate falls by a third, so the ticks spread apart and dull like a loose part
   * settling. 2 nodes.
   */
  private impactRattle(ctx: AudioContext, out: AudioNode, at: number, freq: number, gain: number, decay: number): void {
    if (gain <= MIN_GAIN) return;
    const buf = this.clickBuf!;
    const rate = Math.min(1.5, Math.max(0.2, freq / 3000));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true; // loopStart = loopEnd = 0: the whole buffer, the four variants in turn
    src.playbackRate.setValueAtTime(rate, at);
    const g = ctx.createGain();
    const end = this.envelope(g.gain, at, gain, 0, 0, decay);
    src.playbackRate.exponentialRampToValueAtTime(rate * 0.65, end);
    src.connect(g).connect(out);
    src.start(at, Math.floor(Math.random() * 4) * (buf.duration / 4));
    src.stop(end);
  }

  /**
   * Crowd texture for the goal (made once, 2 s, loops seamlessly): white noise whose level
   * flutters like many voices (a smooth random contour, about 9 changes a second, ±30%) with
   * about 40 hand claps a second on top (short ticks of their own noise, random strength), then
   * darkened by a 4 kHz lowpass pair. Below 4 kHz it has the level of plain white noise, so the
   * bands that read it take the same gains as a noise layer, and there is no hiss on top.
   */
  private blastMakeCrowd(ctx: BaseAudioContext): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 2);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    // Flutter: random levels at 18 points, smoothstep-interpolated, wrapping around.
    const pts = 18;
    const lv = new Float32Array(pts);
    for (let i = 0; i < pts; i++) lv[i] = 0.7 + Math.random() * 0.6;
    for (let i = 0; i < len; i++) {
      const u = (i / len) * pts;
      const k = Math.floor(u);
      const x = u - k;
      d[i] = (Math.random() * 2 - 1) * (lv[k] + (lv[(k + 1) % pts] - lv[k]) * x * x * (3 - 2 * x));
    }
    // Claps: 10 ms ticks, 0.3 ms attack then a 2.2 ms exponential decay, at random places
    // (wrapping too).
    const clap = Math.floor(sr * 0.01);
    const rise = sr * 0.0003;
    const fall = Math.exp(-1 / (sr * 0.0022));
    for (let c = 0; c < 80; c++) {
      const o = Math.floor(Math.random() * len);
      let env = 1.5 + Math.random() * 2;
      for (let i = 0; i < clap; i++) {
        d[(o + i) % len] += (Math.random() * 2 - 1) * env * Math.min(1, i / rise);
        env *= fall;
      }
    }
    let energy = 0;
    for (let i = 0; i < len; i++) energy += d[i] * d[i];
    const norm = Math.sqrt(len / 3 / energy); // white noise in [-1, 1] has an RMS of 1/√3
    // Lowpass pair, run over the buffer twice: the first pass only settles it, so the second
    // starts from the state the end leaves and the loop point stays seamless.
    const a = 1 - Math.exp((-2 * Math.PI * 4000) / sr);
    let l1 = 0;
    let l2 = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < len; i++) {
        l1 += a * (d[i] * norm - l1);
        l2 += a * (l1 - l2);
        if (pass === 1) d[i] = l2;
      }
    }
    return buf;
  }

  /**
   * Flutter on a voice: a sine LFO gliding `fromHz` → `toHz` until `end` (the end of the voice's
   * longest layer), added to the gain of `v` with a depth falling linearly from `depth` to 0, so
   * stopping it at `end` leaves no step. The gain swings level ∓ depth (keep depth below the
   * voice's level) and dips first, so the onset is not pushed up. 2 nodes.
   */
  private moveFlutter(ctx: AudioContext, v: GainNode, at: number, end: number, fromHz: number, toHz: number, depth: number): void {
    const lfo = ctx.createOscillator();
    lfo.frequency.setValueAtTime(fromHz, at);
    lfo.frequency.exponentialRampToValueAtTime(toHz, end);
    const d = ctx.createGain();
    d.gain.setValueAtTime(-depth, at);
    d.gain.linearRampToValueAtTime(0, end);
    lfo.connect(d).connect(v.gain);
    lfo.start(at);
    lfo.stop(end);
  }
}

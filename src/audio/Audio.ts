/**
 * Synthesized game audio (Web Audio only, no sample files).
 *
 * Graph: one-shots and the continuous layers → sfx bus → master gain → DynamicsCompressor →
 * destination. The whole graph is created lazily on the first `resume()` (which must come from a
 * user gesture because of the autoplay policy); every method is a no-op while the context is not
 * running, so stale events never pile up and burst out on resume.
 *
 * Continuous layers (driven by `update()`, no allocations):
 *   engine      a virtual V8 (engine.ts: rpm through five gears, load). One oscillator at the
 *               crankshaft frequency whose wave holds the engine orders (4th = firing, plus the
 *               2nd and odd orders that make the burble) + exhaust pulses (noise band-passed near
 *               the firing frequency, amplitude-modulated at it) → soft saturation (drive grows
 *               with load) → lowpass opened by rpm and load. A short dip on each upshift and a
 *               few exhaust pops when the throttle is released at high rpm.
 *   boost       looped noise → lowpass (opened by speed) → gain while boosting
 *   supersonic  looped noise → highpass, airy, fades in near max speed
 * One-shots allocate a few nodes each (event-driven, a handful per second at most).
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
  private boostGain: GainNode | null = null;
  // Supersonic wind
  private windSrc: AudioBufferSourceNode | null = null;
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
  private sentWind = -1;
  private lastBallHit = -1;
  private lastCarHit = -1;
  private lastBoostStart = -1;
  private lastDemolition = -1;
  private disposed = false;

  constructor() {
    // Nothing is created here: an AudioContext may only start from a user gesture.
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
    const boostLevel = boosting ? 0.26 : 0;
    if (edge || changed(boostLevel, this.sentBoostGain)) {
      this.sentBoostGain = boostLevel;
      this.boostGain!.gain.setTargetAtTime(boostLevel, t, boosting ? 0.03 : 0.025);
    }
    const boostCut = 650 + 1400 * ratio;
    if (changed(boostCut, this.sentBoostFilter)) {
      this.sentBoostFilter = boostCut;
      this.boostFilter!.frequency.setTargetAtTime(boostCut, t, 0.1);
    }

    // Supersonic wind: airy highpassed noise, with a hint of it from ~85% speed.
    let wind = 0;
    if (state.supersonic) wind = 0.11;
    else if (ratio > 0.85) wind = (0.04 * (ratio - 0.85)) / 0.15;
    if (changed(wind, this.sentWind)) {
      this.sentWind = wind;
      this.windGain!.gain.setTargetAtTime(wind, t, 0.15);
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

  /** Car hits the ball. `strength` 0..1 (e.g. relative speed / 3000). */
  playBallHit(strength: number): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    if (t - this.lastBallHit < BALL_HIT_MIN_INTERVAL) return;
    this.lastBallHit = t;
    const s = clamp01(strength);
    // Body: sine thump dropping in pitch.
    this.thump(ctx, 150 - 50 * s, 0.1 + 0.08 * s, 0.14 + 0.5 * s);
    // Click: short band-passed noise, brighter for softer touches.
    this.noiseBurst(ctx, 'bandpass', 2600 - 900 * s, 0.9, 0.035 + 0.02 * s, 0.08 + 0.3 * s);
  }

  /** Car-car bump or demo. `strength` 0..1. */
  playCarHit(strength: number): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    if (t - this.lastCarHit < CAR_HIT_MIN_INTERVAL) return;
    this.lastCarHit = t;
    const s = clamp01(strength);
    const dur = 0.16 + 0.1 * s;
    // Metallic clank: a triangle ring-modulated by an inharmonic sine, short exponential decay.
    const carrier = ctx.createOscillator();
    carrier.type = 'triangle';
    carrier.frequency.setValueAtTime(420 + 80 * s, t);
    carrier.frequency.exponentialRampToValueAtTime(260, t + dur);
    const modulator = ctx.createOscillator();
    modulator.type = 'sine';
    modulator.frequency.value = 1290;
    const ring = ctx.createGain();
    ring.gain.value = 0;
    modulator.connect(ring.gain);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.22 + 0.35 * s, t);
    env.gain.exponentialRampToValueAtTime(MIN_GAIN, t + dur);
    carrier.connect(ring).connect(env).connect(this.sfx!);
    carrier.start(t);
    modulator.start(t);
    carrier.stop(t + dur);
    modulator.stop(t + dur);
    // Impact body.
    this.noiseBurst(ctx, 'lowpass', 900, 0.7, 0.07 + 0.05 * s, 0.15 + 0.3 * s);
    this.thump(ctx, 75, 0.12, 0.1 + 0.25 * s);
  }

  /**
   * A car blown up: a low boom, a roar whose lowpass sweeps down, a sharp crack and a mid body.
   * `strength` 0..1 (the game lowers it with the distance from the camera).
   */
  playDemolition(strength: number): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    if (t - this.lastDemolition < DEMOLITION_MIN_INTERVAL) return;
    this.lastDemolition = t;
    const s = clamp01(strength);
    this.thump(ctx, 46, 0.7, 0.55 * s);
    this.noiseBurst(ctx, 'lowpass', 1400, 0.7, 0.9, 0.5 * s, 90);
    this.noiseBurst(ctx, 'bandpass', 3200, 1.1, 0.12, 0.22 * s);
    this.noiseBurst(ctx, 'bandpass', 900, 0.9, 0.35, 0.18 * s);
  }

  playJump(): void {
    const ctx = this.ready();
    if (ctx === null) return;
    this.whoosh(ctx, 420, 1500, 0.16, 0.22);
    this.thump(ctx, 130, 0.08, 0.12);
  }

  playDodge(): void {
    const ctx = this.ready();
    if (ctx === null) return;
    this.whoosh(ctx, 300, 1900, 0.3, 0.22);
    this.thump(ctx, 115, 0.08, 0.1);
  }

  playLand(hard: boolean): void {
    const ctx = this.ready();
    if (ctx === null) return;
    if (hard) {
      this.thump(ctx, 65, 0.16, 0.38);
      this.noiseBurst(ctx, 'lowpass', 520, 0.6, 0.12, 0.3);
    } else {
      this.thump(ctx, 80, 0.1, 0.12);
      this.noiseBurst(ctx, 'lowpass', 600, 0.6, 0.06, 0.08);
    }
  }

  /** Goal horn (3 detuned saws, 1 s decay) + crowd-ish noise swell + low boom. */
  playGoal(team: Team): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    const sfx = this.sfx!;
    const base = team === 0 ? 196 : 220; // G3 for blue, A3 for red
    const horn = ctx.createBiquadFilter();
    horn.type = 'lowpass';
    horn.frequency.setValueAtTime(1800, t);
    horn.frequency.exponentialRampToValueAtTime(700, t + 1.6);
    horn.Q.value = 0.8;
    const hornEnv = ctx.createGain();
    hornEnv.gain.setValueAtTime(MIN_GAIN, t);
    hornEnv.gain.exponentialRampToValueAtTime(0.16, t + 0.04);
    hornEnv.gain.setValueAtTime(0.16, t + 0.6);
    hornEnv.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 1.6); // ~1 s decay
    horn.connect(hornEnv).connect(sfx);
    const detune = [0, 7, -7];
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = base;
      osc.detune.value = detune[i];
      osc.connect(horn);
      osc.start(t);
      osc.stop(t + 1.65);
    }
    // Fifth above, quieter, gives the "stadium horn" chord.
    const fifth = ctx.createOscillator();
    fifth.type = 'sawtooth';
    fifth.frequency.value = base * 1.5;
    const fifthGain = ctx.createGain();
    fifthGain.gain.value = 0.45;
    fifth.connect(fifthGain).connect(horn);
    fifth.start(t + 0.12);
    fifth.stop(t + 1.65);

    // Crowd: wide band-passed noise swelling in and slowly fading.
    const crowd = ctx.createBufferSource();
    crowd.buffer = this.noise!;
    crowd.loop = true;
    const crowdFilter = ctx.createBiquadFilter();
    crowdFilter.type = 'bandpass';
    crowdFilter.frequency.setValueAtTime(700, t);
    crowdFilter.frequency.linearRampToValueAtTime(1100, t + 0.6);
    crowdFilter.frequency.linearRampToValueAtTime(600, t + 3);
    crowdFilter.Q.value = 0.5;
    const crowdEnv = ctx.createGain();
    crowdEnv.gain.setValueAtTime(MIN_GAIN, t);
    crowdEnv.gain.exponentialRampToValueAtTime(0.17, t + 0.45);
    crowdEnv.gain.setValueAtTime(0.17, t + 1.2);
    crowdEnv.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 3.2);
    crowd.connect(crowdFilter).connect(crowdEnv).connect(sfx);
    crowd.start(t);
    crowd.stop(t + 3.25);

    // Explosion boom.
    this.noiseBurst(ctx, 'lowpass', 500, 0.5, 0.7, 0.45, 70);
    this.thump(ctx, 42, 0.55, 0.4);
  }

  playCountdownTick(): void {
    const ctx = this.ready();
    if (ctx === null) return;
    this.beep(ctx, 880, 0.09, 0.14);
  }

  playGo(): void {
    const ctx = this.ready();
    if (ctx === null) return;
    this.beep(ctx, 1320, 0.28, 0.17);
  }

  playPadPickup(big: boolean): void {
    const ctx = this.ready();
    if (ctx === null) return;
    if (big) {
      this.chime(ctx, 784, 0, 0.11, 0.06);
      this.chime(ctx, 1047, 0.05, 0.12, 0.06);
      this.noiseBurst(ctx, 'bandpass', 3000, 1.2, 0.05, 0.05);
    } else {
      this.chime(ctx, 1175, 0, 0.08, 0.035);
    }
  }

  /** Boost ignition: noise burst with a rising lowpass sweep. (Also fired by update() on the edge.) */
  playBoostStart(): void {
    const ctx = this.ready();
    if (ctx === null) return;
    const t = ctx.currentTime;
    if (t - this.lastBoostStart < BOOST_START_MIN_INTERVAL) return;
    this.lastBoostStart = t;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    src.loopStart = 0.37;
    src.loopEnd = 1.9;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(260, t);
    filter.frequency.exponentialRampToValueAtTime(3200, t + 0.14);
    filter.frequency.exponentialRampToValueAtTime(900, t + 0.32);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.3, t);
    env.gain.exponentialRampToValueAtTime(MIN_GAIN, t + 0.32);
    src.connect(filter).connect(env).connect(this.sfx!);
    src.start(t, 0.37);
    src.stop(t + 0.33);
    this.thump(ctx, 90, 0.08, 0.08);
  }

  /** Boost release: a short low puff. (Also fired by update() on the edge.) */
  playBoostStop(): void {
    const ctx = this.ready();
    if (ctx === null) return;
    this.noiseBurst(ctx, 'lowpass', 700, 0.8, 0.09, 0.07);
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
      this.windSrc?.stop();
    } catch {
      /* already stopped */
    }
    void ctx.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
    this.sfx = null;
    this.noise = null;
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
    this.boostGain = null;
    this.windSrc = null;
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
    this.sentBoostGain = this.sentBoostFilter = this.sentWind = -1;
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

    // Boost roar: looped noise → lowpass → gain.
    const boostSrc = ctx.createBufferSource();
    boostSrc.buffer = noise;
    boostSrc.loop = true;
    const boostFilter = ctx.createBiquadFilter();
    boostFilter.type = 'lowpass';
    boostFilter.frequency.value = 800;
    boostFilter.Q.value = 0.9;
    const boostGain = ctx.createGain();
    boostGain.gain.value = 0;
    boostSrc.connect(boostFilter).connect(boostGain).connect(sfx);
    boostSrc.start();
    this.boostSrc = boostSrc;
    this.boostFilter = boostFilter;
    this.boostGain = boostGain;

    // Supersonic wind: looped noise → highpass → gain.
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = noise;
    windSrc.loop = true;
    windSrc.loopStart = 0.5; // offset so it does not phase-lock with the boost layer
    windSrc.loopEnd = 2;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'highpass';
    windFilter.frequency.value = 2800;
    windFilter.Q.value = 0.5;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    windSrc.connect(windFilter).connect(windGain).connect(sfx);
    windSrc.start(0, 0.5);
    this.windSrc = windSrc;
    this.windGain = windGain;
  }

  /** Sine thump: starts at 2× `freq` and falls to `freq` while decaying. */
  private thump(ctx: AudioContext, freq: number, dur: number, gain: number): void {
    if (gain <= MIN_GAIN) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 2, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + dur);
    osc.connect(g).connect(this.sfx!);
    osc.start(t);
    osc.stop(t + dur);
  }

  /** Filtered noise with an exponential decay, `delay` seconds from now. `sweepTo` optionally sweeps the filter down. */
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

  /** Air whoosh: band-passed noise whose centre sweeps up then settles while fading. */
  private whoosh(ctx: AudioContext, fromHz: number, toHz: number, dur: number, gain: number): void {
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.4;
    filter.frequency.setValueAtTime(fromHz, t);
    filter.frequency.exponentialRampToValueAtTime(toHz, t + dur * 0.55);
    filter.frequency.exponentialRampToValueAtTime(fromHz * 0.8, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(MIN_GAIN, t);
    g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.25);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + dur);
    src.connect(filter).connect(g).connect(this.sfx!);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur);
  }

  /** Short square beep through a lowpass (countdown). */
  private beep(ctx: AudioContext, freq: number, dur: number, gain: number): void {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = freq * 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(MIN_GAIN, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.setValueAtTime(gain, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + dur);
    osc.connect(filter).connect(g).connect(this.sfx!);
    osc.start(t);
    osc.stop(t + dur);
  }

  /** Sine chime note starting `delay` seconds from now. */
  private chime(ctx: AudioContext, freq: number, delay: number, dur: number, gain: number): void {
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(MIN_GAIN, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + dur);
    osc.connect(g).connect(this.sfx!);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }
}

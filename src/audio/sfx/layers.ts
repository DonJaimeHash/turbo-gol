/**
 * Continuous layers: sounds that run all the time and follow the player's car every frame,
 * instead of being triggered (sounds.ts). Each one is built once with the graph, started, and
 * from then on only moves its AudioParams in update(); silence() fades it out (pause, hidden tab).
 *
 *   engine      a virtual V8 (../engine.ts: rpm through three gears, load). One oscillator at the
 *               crankshaft frequency whose wave holds the engine orders (4th = firing, plus the
 *               2nd and odd orders that make the burble) + exhaust pulses (noise band-passed near
 *               the firing frequency, amplitude-modulated at it) → soft saturation (drive grows
 *               with load) → lowpass opened by rpm and load. A short dip on each upshift and a
 *               few exhaust pops when the throttle is released at high rpm.
 *   boost       a deep roar (noise through two cascaded lowpasses, 24 dB/oct, 300-700 Hz) + a body
 *               band around 150 Hz + a soft low hum (two saws a fifth apart, 58 / 87 Hz, rising a
 *               little with speed, lowpassed) → gain while boosting
 *   wind        supersonic: noise through a wide band around 0.7-1.1 kHz and a lowpass (a full
 *               whoosh, no hiss), slowly gusting, fades in near max speed
 *
 * To add a layer: a class implementing Layer, built in Audio.buildGraph and pushed to its list.
 * Allocation-free per frame: targets only go out when they move (Target's dead-band).
 */
import { EngineModel, IDLE_RPM, REDLINE_RPM } from '../engine';
import { makeSoftClip } from './assets';
import type { SfxKit } from './kit';

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

/** What every layer gets each frame. */
export interface LayerFrame {
  /** Context time, s. */
  t: number;
  /** Seconds since the last frame. */
  dt: number;
  state: AudioState;
  /** Smoothed speed / max speed, 0..1. */
  speedRatio: number;
  /** |throttle|, 0..1. */
  throttle: number;
  /** The boost started or stopped on this frame. */
  boostEdge: boolean;
}

export interface Layer {
  update(f: LayerFrame): void;
  /** Fade to silence now (`t` = context time); the next update() brings back what the state asks for. */
  silence(t: number): void;
  /** Forget the per-car state (the engine's rpm, the last throttle): also while the context is not running. */
  reset(): void;
  /** Stop the sources (dispose). */
  stop(): void;
}

const CAR_MAX_SPEED = 2300;
/** Engine-order amplitudes 1..24 of the crankshaft wave (cross-plane V8: the 4th, firing, leads). */
const ENGINE_ORDERS = [0.16, 0.42, 0.2, 1, 0.12, 0.3, 0.1, 0.6, 0.06, 0.2, 0.05, 0.34, 0.04, 0.1, 0.03, 0.2, 0.02, 0.05, 0.02, 0.1, 0.02, 0.04, 0.02, 0.08];
/** Exhaust pops after a throttle release: at most once per this many seconds. */
const POPS_MIN_INTERVAL = 1.2;

export function speedRatio(speed: number): number {
  return clamp01(speed / CAR_MAX_SPEED);
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * An AudioParam driven by setTargetAtTime with a dead-band: a new target is only sent when it
 * moves by more than 1% (plus a tiny absolute term, since targets are often exactly 0), so a
 * steady state issues no automation events at all.
 */
export class Target {
  /** The last value sent (-1: none yet). */
  sent = -1;
  constructor(readonly param: AudioParam) {}

  /** Send `v` unless it is within the dead-band of the last one; true when it was sent. */
  set(v: number, t: number, tau: number): boolean {
    if (!changed(v, this.sent)) return false;
    this.force(v, t, tau);
    return true;
  }

  /** Send `v` regardless of the dead-band. */
  force(v: number, t: number, tau: number): void {
    this.sent = v;
    this.param.setTargetAtTime(v, t, tau);
  }
}

function changed(v: number, lastSent: number): boolean {
  const a = v < 0 ? -v : v;
  const b = lastSent < 0 ? -lastSent : lastSent;
  const d = v - lastSent;
  return (d < 0 ? -d : d) > 0.01 * (a > b ? a : b) + 1e-4;
}

/** The engine: crank tone + exhaust pulses → drive → saturator → lowpass → gain → `out`. */
export class EngineLayer implements Layer {
  private readonly model = new EngineModel();
  private readonly osc: OscillatorNode;
  private readonly am: OscillatorNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly crank: Target;
  private readonly band: Target;
  private readonly noiseLevel: Target;
  private readonly drive: Target;
  private readonly cutoff: Target;
  private readonly level: Target;
  private prevThrottle = 0;
  private lastPops = -1;

  constructor(
    private readonly kit: SfxKit,
    private readonly out: AudioNode,
  ) {
    const ctx = kit.ctx;
    const idleCrank = IDLE_RPM / 60;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    filter.connect(gain).connect(out);
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeSoftClip(2.2, Math.tanh(2.2), 1024);
    shaper.oversample = '2x';
    shaper.connect(filter);
    const drive = ctx.createGain();
    drive.gain.value = 1.2;
    drive.connect(shaper);
    // Crank tone: the engine orders as one periodic wave (fixed phases, so it never changes).
    const real = new Float32Array(ENGINE_ORDERS.length + 1);
    const imag = new Float32Array(ENGINE_ORDERS.length + 1);
    for (let k = 1; k <= ENGINE_ORDERS.length; k++) {
      const phase = (k * k * 0.7) % (Math.PI * 2);
      real[k] = ENGINE_ORDERS[k - 1] * Math.cos(phase);
      imag[k] = ENGINE_ORDERS[k - 1] * Math.sin(phase);
    }
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(ctx.createPeriodicWave(real, imag));
    osc.frequency.value = idleCrank;
    const toneGain = ctx.createGain();
    toneGain.gain.value = 0.5;
    osc.connect(toneGain).connect(drive);
    // Exhaust pulses: looped noise → bandpass → pulse gain (0.6 ± 0.6 at the firing frequency) → level.
    const noise = ctx.createBufferSource();
    noise.buffer = kit.noise;
    noise.loop = true;
    noise.loopStart = 0.9; // offset from the boost / wind layers
    noise.loopEnd = 2;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = idleCrank * 4 * 2.2 + 250;
    band.Q.value = 1.1;
    const pulse = ctx.createGain();
    pulse.gain.value = 0.6;
    const am = ctx.createOscillator();
    am.type = 'sine';
    am.frequency.value = idleCrank * 4;
    const amDepth = ctx.createGain();
    amDepth.gain.value = 0.6;
    am.connect(amDepth).connect(pulse.gain);
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.25;
    noise.connect(band).connect(pulse).connect(noiseGain).connect(drive);
    osc.start();
    am.start();
    noise.start(0, 0.9);
    this.osc = osc;
    this.am = am;
    this.noise = noise;
    this.crank = new Target(osc.frequency);
    this.band = new Target(band.frequency);
    this.noiseLevel = new Target(noiseGain.gain);
    this.drive = new Target(drive.gain);
    this.cutoff = new Target(filter.frequency);
    this.level = new Target(gain.gain);
  }

  update(f: LayerFrame): void {
    const { t, state } = f;
    // rpm and load from the model (engine.ts), turned into pitch, brightness and level.
    const eng = this.model;
    eng.step(f.dt, state.forwardSpeed, state.throttle, state.grounded, state.boosting);
    const crank = eng.rpm / 60;
    const rn = clamp01((eng.rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM));
    const load = eng.load;
    if (this.crank.set(crank, t, 0.02)) this.am.frequency.setTargetAtTime(crank * 4, t, 0.02);
    this.band.set(crank * 4 * 2.2 + 250, t, 0.03);
    this.noiseLevel.set(0.25 + 0.55 * load, t, 0.05);
    this.drive.set(1.2 + 2.3 * load, t, 0.05);
    this.cutoff.set(260 + 1100 * rn + 1500 * load, t, 0.05);
    const level = (0.022 + 0.05 * load + 0.022 * rn) * (state.grounded ? 1 : 0.85);
    if (eng.shifted) {
      // Upshift: the power cuts for a moment, then comes back.
      this.level.force(level * 0.45, t, 0.012);
      this.level.force(level, t + 0.07, 0.03);
    } else {
      this.level.set(level, t, 0.05);
    }
    // Throttle released at high rpm on the ground: a few exhaust pops.
    const thr = f.throttle;
    if (this.prevThrottle > 0.6 && thr < 0.15 && eng.rpm > 3600 && state.grounded && t - this.lastPops > POPS_MIN_INTERVAL) {
      this.lastPops = t;
      const pops = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < pops; i++) {
        this.kit.noiseBurst(this.out, 'bandpass', 1400 + Math.random() * 1600, 2.2, 0.02 + Math.random() * 0.02, 0.06 + Math.random() * 0.08, 0, 0.05 + Math.random() * 0.6);
      }
    }
    this.prevThrottle = thr;
  }

  silence(t: number): void {
    this.level.force(0, t, 0.05);
  }

  reset(): void {
    this.prevThrottle = 0;
    this.model.reset();
  }

  stop(): void {
    this.osc.stop();
    this.am.stop();
    this.noise.stop();
  }
}

/** The boost roar: (deep roar + body band + low hum) → gain → `out`. */
export class BoostLayer implements Layer {
  private readonly src: AudioBufferSourceNode;
  private readonly humA: OscillatorNode;
  private readonly humB: OscillatorNode;
  private readonly filter2: BiquadFilterNode;
  private readonly level: Target;
  private readonly cutoff: Target;
  private readonly humFreq: Target;

  constructor(kit: SfxKit, out: AudioNode) {
    const ctx = kit.ctx;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(out);
    const src = ctx.createBufferSource();
    src.buffer = kit.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    filter.Q.value = 0.6;
    const filter2 = ctx.createBiquadFilter();
    filter2.type = 'lowpass';
    filter2.frequency.value = 320;
    filter2.Q.value = 0.6;
    const roar = ctx.createGain();
    roar.gain.value = 1.4;
    src.connect(filter).connect(filter2).connect(roar).connect(gain);
    const body = ctx.createBiquadFilter();
    body.type = 'bandpass';
    body.frequency.value = 150;
    body.Q.value = 1.3;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = 1.6;
    src.connect(body).connect(bodyGain).connect(gain);
    const humFilter = ctx.createBiquadFilter();
    humFilter.type = 'lowpass';
    humFilter.frequency.value = 260;
    humFilter.Q.value = 0.7;
    const humGain = ctx.createGain();
    humGain.gain.value = 0.3;
    humFilter.connect(humGain).connect(gain);
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
    src.start();
    humA.start();
    humB.start();
    this.src = src;
    this.humA = humA;
    this.humB = humB;
    this.filter2 = filter2;
    this.level = new Target(gain.gain);
    this.cutoff = new Target(filter.frequency);
    this.humFreq = new Target(humA.frequency);
  }

  /** The hum's current frequency, Hz (58-73 with the speed): the ignition sound is tuned to it. */
  get hum(): number {
    return this.humFreq.sent > 0 ? this.humFreq.sent : 58;
  }

  update(f: LayerFrame): void {
    const { t, speedRatio: ratio } = f;
    const boosting = f.state.boosting;
    const level = boosting ? 0.24 : 0;
    // Always sent on an edge frame.
    if (f.boostEdge) this.level.force(level, t, boosting ? 0.04 : 0.03);
    else this.level.set(level, t, boosting ? 0.04 : 0.03);
    const cut = 320 + 380 * ratio;
    if (this.cutoff.set(cut, t, 0.1)) this.filter2.frequency.setTargetAtTime(cut, t, 0.1);
    const hum = 58 * (1 + 0.25 * ratio);
    if (this.humFreq.set(hum, t, 0.12)) this.humB.frequency.setTargetAtTime(hum * 1.5, t, 0.12);
  }

  silence(t: number): void {
    this.level.force(0, t, 0.05);
  }

  reset(): void {}

  stop(): void {
    this.src.stop();
    this.humA.stop();
    this.humB.stop();
  }
}

/** Supersonic wind: looped noise → wide band → lowpass → gust (0.75 ± 0.25 at 0.7 Hz) → gain → `out`. */
export class WindLayer implements Layer {
  private readonly src: AudioBufferSourceNode;
  private readonly lfo: OscillatorNode;
  private readonly level: Target;
  private readonly centre: Target;

  constructor(kit: SfxKit, out: AudioNode) {
    const ctx = kit.ctx;
    const src = ctx.createBufferSource();
    src.buffer = kit.noise;
    src.loop = true;
    src.loopStart = 0.5; // offset so it does not phase-lock with the boost layer
    src.loopEnd = 2;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 700;
    band.Q.value = 0.45;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 1800;
    low.Q.value = 0.5;
    const gust = ctx.createGain();
    gust.gain.value = 0.75;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.7;
    const gustDepth = ctx.createGain();
    gustDepth.gain.value = 0.25;
    lfo.connect(gustDepth).connect(gust.gain);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(band).connect(low).connect(gust).connect(gain).connect(out);
    src.start(0, 0.5);
    lfo.start();
    this.src = src;
    this.lfo = lfo;
    this.level = new Target(gain.gain);
    this.centre = new Target(band.frequency);
  }

  update(f: LayerFrame): void {
    const { t, speedRatio: ratio } = f;
    // A full, low whoosh, with a hint of it from ~85% speed.
    let wind = 0;
    if (f.state.supersonic) wind = 0.09;
    else if (ratio > 0.85) wind = (0.035 * (ratio - 0.85)) / 0.15;
    this.level.set(wind, t, 0.15);
    this.centre.set(700 + 400 * ratio, t, 0.2);
  }

  silence(t: number): void {
    this.level.force(0, t, 0.05);
  }

  reset(): void {}

  stop(): void {
    this.src.stop();
    this.lfo.stop();
  }
}

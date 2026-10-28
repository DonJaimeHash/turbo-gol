/**
 * The sound-effect toolkit: the one-shot buses (dry, saturated, the shared room) and the layers a
 * sound is built from. Every sound in sounds.ts is written with it:
 *
 *   const v = k.voice(level, roomSend);            // routing of this one-shot
 *   k.click(v, t, 2200, 0.05);                     // a transient
 *   k.body(v, t, 180, 0.3, { ratios: MEMBRANE, ... }); // a pitched impact
 *   k.noiseLayer(v, t, 0.2, { type: 'bandpass', freq: 850, decay: 0.08 });
 *
 * Each layer is scheduled at an absolute context time (`t + offset` sequences them) and stops its
 * own sources the moment its envelope ends. Decays are 60 dB falls (T60). Layers cost 2-4 nodes
 * each; a sound of 10-30 nodes a handful of times a second is cheap.
 */
import { makeClickBuffer, makeCrowd, makeNoise, makeRoomImpulse, makeSoftClip, makeWave } from './assets';

/** Exponential ramps cannot reach 0: the floor of every envelope. */
export const MIN_GAIN = 0.0001;

/** Partial ratios for body() / note(): the harmonic series (tones, horns, warm bodies). */
export const HARMONIC: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];
/** Circular membrane modes: a struck skin, the ball's inflated shell. */
export const MEMBRANE: readonly number[] = [1, 1.593, 2.136, 2.296, 2.653, 2.918];
/** Dense inharmonic set: a car body panel (rough, clanky). */
export const PANEL: readonly number[] = [1, 1.29, 1.71, 2.37, 3.12, 4.1];
/** Free-bar modes: mallet or bell-like notes (the upper modes are far apart: use a low fundamental). */
export const BAR: readonly number[] = [1, 2.756, 5.404, 8.933];

/** An oscillator's wave: a built-in type or one of the kit's periodic waves. */
export type Wave = Exclude<OscillatorType, 'custom'> | 'warm' | 'horn';

export interface BodySpec {
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
}

export interface NoteSpec {
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
  wave?: Wave;
}

export interface FmSpec {
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
}

export interface NoiseSpec {
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
}

export class SfxKit {
  readonly ctx: BaseAudioContext;
  /** 2 s of white noise (also read by the continuous layers). */
  readonly noise: AudioBuffer;
  /** Goal crowd texture (assets.makeCrowd), read through bands by the goal sound. */
  readonly crowd: AudioBuffer;
  private readonly dry: GainNode;
  private readonly sat: WaveShaperNode;
  private readonly roomIn: GainNode | null;
  private readonly warmWave: PeriodicWave;
  private readonly hornWave: PeriodicWave;
  private readonly clickBuf: AudioBuffer;

  /**
   * The one-shot buses into `master`: a dry bus, a shared soft saturator into it and, with
   * `room`, a send into one shared short room (a convolver over a synthetic stereo impulse, 0.55
   * s; without it, super low's CPU trim, the one-shots stay dry), plus the shared timbres.
   */
  constructor(ctx: BaseAudioContext, master: AudioNode, room: boolean) {
    this.ctx = ctx;
    const dry = ctx.createGain();
    dry.gain.value = 1;
    dry.connect(master);
    this.dry = dry;
    this.roomIn = null;
    if (room) {
      const conv = ctx.createConvolver();
      conv.normalize = false; // makeRoomImpulse scales the impulse itself (unity over 125 Hz-4 kHz)
      conv.buffer = makeRoomImpulse(ctx);
      conv.connect(master);
      const roomIn = ctx.createGain();
      roomIn.gain.value = 0.5; // return level: a voice sent at 1 comes back 6 dB below its own energy
      roomIn.connect(conv);
      this.roomIn = roomIn;
    }
    // Shared soft saturator for sub / body voices: tanh(2.5x) / 2.5, unity gain for small signals,
    // so the level fed in sets the drive. Low-frequency material only, hence no oversampling.
    const sat = ctx.createWaveShaper();
    sat.curve = makeSoftClip(2.5, 2.5);
    sat.oversample = 'none';
    sat.connect(dry);
    this.sat = sat;
    // A warm sine (soft harmonics 2-8, so a sub is heard on small speakers), a brass-like horn (16
    // harmonics, strongest at the 2nd-3rd) and four short click variants.
    this.warmWave = makeWave(ctx, [1, 0.45, 0.28, 0.16, 0.1, 0.06, 0.035, 0.02], false);
    this.hornWave = makeWave(ctx, [0.75, 1, 0.9, 0.7, 0.52, 0.38, 0.28, 0.2, 0.14, 0.1, 0.07, 0.05, 0.035, 0.025, 0.017, 0.012], true);
    this.clickBuf = makeClickBuffer(ctx);
    this.crowd = makeCrowd(ctx);
    this.noise = makeNoise(ctx);
  }

  /**
   * Routing of one one-shot: a gain at `level` into the dry bus (into the shared soft saturator
   * instead with `saturate`) plus, when `send` > 0, `send` (0..1) of it into the room (taken
   * before the saturator, so the room stays clean). Connect the layers into the returned node.
   * 1 node, 2 with a send; it is released with its last source.
   */
  voice(level: number, send: number, saturate = false): GainNode {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = level;
    out.connect(saturate ? this.sat : this.dry);
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
  envelope(p: AudioParam, at: number, peak: number, attack: number, hold: number, decay: number): number {
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

  /** Set an oscillator's wave: a built-in type or one of the kit's periodic waves. */
  setWave(osc: OscillatorNode, wave: Wave): void {
    if (wave === 'warm') osc.setPeriodicWave(this.warmWave);
    else if (wave === 'horn') osc.setPeriodicWave(this.hornWave);
    else osc.type = wave;
  }

  /**
   * Pitched impact body: a sine partial per ratio at `freq × ratio`, all starting `drop` times
   * higher and settling on pitch in about `glide` s (fast at first, like a struck skin or panel),
   * each with its own peak (`amps` × `gain`) and 60 dB decay (`decays`). `warm` gives partial 0
   * the warm wave (soft harmonics 2-8): use it for anything under ~150 Hz so small speakers
   * render it. 2 nodes per partial.
   */
  body(out: AudioNode, at: number, freq: number, gain: number, spec: BodySpec): void {
    if (gain <= MIN_GAIN) return;
    const ctx = this.ctx;
    const drop = spec.drop ?? 1.5;
    const glide = spec.glide ?? 0.04;
    const attack = spec.attack ?? 0.001;
    const decays = spec.decays;
    for (let i = 0; i < spec.ratios.length; i++) {
      const peak = gain * (i < spec.amps.length ? spec.amps[i] : 0);
      const f = freq * spec.ratios[i];
      if (peak <= MIN_GAIN || f * drop > 16000) continue;
      const osc = ctx.createOscillator();
      if (i === 0 && spec.warm === true) osc.setPeriodicWave(this.warmWave);
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
  note(out: AudioNode, at: number, freq: number, gain: number, spec: NoteSpec): void {
    if (gain <= MIN_GAIN) return;
    const ctx = this.ctx;
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
  fm(out: AudioNode, at: number, freq: number, gain: number, spec: FmSpec): void {
    if (gain <= MIN_GAIN) return;
    const ctx = this.ctx;
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
  noiseLayer(out: AudioNode, at: number, gain: number, spec: NoiseSpec): void {
    if (gain <= MIN_GAIN) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
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
   * A plain filtered noise burst `delay` s from now into `out`, with an exponential fall over
   * `dur` (the engine's exhaust pops); `sweepTo` optionally sweeps the filter down. 3 nodes.
   */
  noiseBurst(out: AudioNode, type: BiquadFilterType, freq: number, q: number, dur: number, gain: number, sweepTo = 0, delay = 0): void {
    if (gain <= MIN_GAIN) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, t);
    if (sweepTo > 0) filter.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, t + dur);
    src.connect(filter).connect(g).connect(out);
    // Random offset into the buffer so repeated bursts do not sound identical.
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur);
  }

  /**
   * Transient: one of four band-limited noise ticks (made once) centred near `freq`, peak `gain`.
   * It is played at freq / 3 kHz, so lower is also longer: 3 kHz lasts ~6 ms, 1.5 kHz ~12 ms,
   * 750 Hz ~25 ms (`freq` is kept within 600-4500 Hz). 2 nodes.
   */
  click(out: AudioNode, at: number, freq: number, gain: number): void {
    if (gain <= MIN_GAIN) return;
    const ctx = this.ctx;
    const buf = this.clickBuf;
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
   * Metal rattle (impacts): the four click variants looped back to back, so a tick near `freq`
   * comes every 12 ms × 3 kHz / `freq` (15 ms at 2.4 kHz), at `gain` and fading 60 dB in `decay`
   * s while the rate falls by a third, so the ticks spread apart and dull like a loose part
   * settling. 2 nodes.
   */
  rattle(out: AudioNode, at: number, freq: number, gain: number, decay: number): void {
    if (gain <= MIN_GAIN) return;
    const ctx = this.ctx;
    const buf = this.clickBuf;
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
   * Flutter on a voice: a sine LFO gliding `fromHz` → `toHz` until `end` (the end of the voice's
   * longest layer), added to the gain of `v` with a depth falling linearly from `depth` to 0, so
   * stopping it at `end` leaves no step. The gain swings level ∓ depth (keep depth below the
   * voice's level) and dips first, so the onset is not pushed up. 2 nodes.
   */
  flutter(v: GainNode, at: number, end: number, fromHz: number, toHz: number, depth: number): void {
    const ctx = this.ctx;
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

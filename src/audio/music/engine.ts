/**
 * The music engine: a fixed band of instruments that plays a track (track.ts, the songs in
 * tracks/), all synthesized per sample in plain TypeScript (no Web Audio), so the same code runs
 * in the AudioWorklet (worklet.ts) and offline in Node (scripts/render-music.mjs writes a WAV to
 * listen to). It imports only modules of the same kind (dsp.ts, track.ts).
 *
 * A step sequencer on 16ths drives eight instruments:
 *   kick   sine with a falling pitch + a click, saturated; every kick ducks bass / pad / arp (sidechain)
 *   clap   three noise bursts and a tail through a band-pass; snare (rolls) = noise + a 190 Hz body
 *   hats   high-passed noise, closed and open
 *   bass   two detuned polyBLEP saws + a sine sub through a resonant low-pass with an envelope, saturated
 *   pad    one to three detuned saws per chord note, spread left / right, low-passed
 *   lead   saw + square pluck, mono, into a ping-pong delay and the reverb
 *   arp    soft triangle plucks on 16ths over the chord
 *   fx     noise riser into a drop, crash and a sub boom on the drop
 * Sends: a ping-pong delay (dotted eighth) and a small Schroeder reverb; master: a stereo low-pass
 * (pause / goal sweeps), gain and a soft clip.
 *
 * Form: each mode loops its track's sections (Track.forms); mode changes land on the next bar;
 * goal() cuts the drums at the next 16th, plays the track's goal break for the rest of the bar
 * and its bars, then its afterGoal section. The lead melody is generated per 8-bar phrase from a
 * seed (a motif, its sequence and a cadence on the chord), so the music never loops identically.
 *
 * Allocation-free while rendering: every voice and buffer is made in the constructor.
 */
import { Allpass, Comb, Rng, Svf, blepSaw, mtof } from './dsp';
import type { Chord, MusicMode, Section, Track } from './track';

export type { MusicMode } from './track';

export interface MusicState {
  mode: MusicMode;
  /** Game paused: the music stays, filtered and quieter. */
  paused: boolean;
}

const STEPS_PER_BAR = 16;
const MIN_LEVEL = 1e-5;

export class MusicEngine {
  private readonly track: Track;
  private readonly sr: number;
  private readonly lite: boolean;
  private readonly seed: number;
  private readonly rng: Rng;
  private readonly noiseRng: Rng;
  private readonly samplesPerStep: number;

  // Transport
  private stepClock = 0; // samples left until the next 16th
  private step = 0; // 0..15 within the bar
  private bar = 0; // bar within the section
  private formIndex = 0;
  private phrase = 0; // phrases played: the melody seed
  private mode: MusicMode = 'off';
  private targetMode: MusicMode = 'off';
  private paused = false;
  private goalPending = false;
  private section: Section;

  // Master
  private level = 0;
  private levelTarget = 0;
  private cutoff = 20000;
  private cutoffTarget = 20000;
  private readonly masterL = new Svf();
  private readonly masterR = new Svf();
  private ctrl = 0; // samples until the next control-rate update

  // Sidechain: 1 right after a kick, back to 0
  private duck = 0;
  private duckMul = 0;

  // Kick
  private kickAmp = 0;
  private kickAmpMul = 0;
  private kickPitch = 0;
  private kickPitchMul = 0;
  private kickPhase = 0;
  private kickClick = 0;
  private kickClickMul = 0;

  // Clap / snare
  private clapT = -1;
  private clapVel = 0;
  private readonly clapBp = new Svf();
  private snareAmp = 0;
  private snareMul = 0;
  private snareTone = 0;
  private snarePhase = 0;
  private readonly snareBp = new Svf();

  // Hats
  private hatAmp = 0;
  private hatMul = 0;
  private hatPan = 0;
  private readonly hatHp = new Svf();

  // Bass
  private bassFreq = 0;
  private bassTarget = 0;
  private bassGate = false;
  private bassAmp = 0;
  private bassSteps = 0;
  private bassEnv = 0;
  private bassEnvMul = 0;
  private bassPA = 0;
  private bassPB = 0;
  private bassPS = 0;
  private readonly bassLp = new Svf();

  // Pad
  private readonly padFreq = new Float64Array(9);
  private readonly padPhase = new Float64Array(9);
  private padVoices = 0;
  private padAmp = 0;
  private padTarget = 0;
  private readonly padLpL = new Svf();
  private readonly padLpR = new Svf();
  private padCut = 900;
  private padCutTarget = 900;

  // Lead
  private readonly melody = new Int8Array(128); // MIDI note starting at each step of the phrase, -1 none
  private readonly melodyLen = new Int8Array(128);
  private leadFreq = 0;
  private leadTarget = 0;
  private leadAmp = 0;
  private leadGate = 0; // steps left
  private leadEnv = 0;
  private leadEnvMul = 0;
  private leadPA = 0;
  private leadPB = 0;
  private leadVel = 0;
  private readonly leadLp = new Svf();

  // Arp
  private arpFreq = 0;
  private arpPhase = 0;
  private arpAmp = 0;
  private arpMul = 0;
  private arpIndex = 0;

  // FX
  private riserT = -1;
  private riserLen = 0;
  private readonly riserBpL = new Svf();
  private readonly riserBpR = new Svf();
  private crashAmp = 0;
  private crashMul = 0;
  private readonly crashHpL = new Svf();
  private readonly crashHpR = new Svf();
  private boomAmp = 0;
  private boomMul = 0;
  private boomFreq = 0;
  private boomPhase = 0;

  // Sends
  private readonly delayL: Float32Array;
  private readonly delayR: Float32Array;
  private delayI = 0;
  private readonly delayLen: number;
  private delayLpL = 0;
  private delayLpR = 0;
  private readonly combsL: Comb[];
  private readonly combsR: Comb[];
  private readonly apL: Allpass[];
  private readonly apR: Allpass[];

  constructor(sampleRate: number, track: Track, opts: { lite?: boolean; seed?: number } = {}) {
    this.track = track;
    this.section = track.forms.menu[0];
    this.sr = sampleRate;
    this.lite = opts.lite ?? false;
    this.seed = opts.seed ?? 0x7a3b;
    this.rng = new Rng(this.seed);
    this.noiseRng = new Rng(0x51ed);
    this.samplesPerStep = (sampleRate * 60) / track.bpm / 4;
    this.delayLen = Math.round(this.samplesPerStep * 3); // dotted eighth
    this.delayL = new Float32Array(this.delayLen);
    this.delayR = new Float32Array(this.delayLen);
    const scale = sampleRate / 44100;
    const combs = [1116, 1188, 1277, 1356];
    this.combsL = combs.map((n) => new Comb(Math.round(n * scale)));
    this.combsR = combs.map((n) => new Comb(Math.round((n + 23) * scale)));
    this.apL = [556, 441].map((n) => new Allpass(Math.round(n * scale)));
    this.apR = [579, 464].map((n) => new Allpass(Math.round(n * scale)));
    this.duckMul = this.decay(0.22);
    this.clapBp.set(1600, 0.9, sampleRate);
    this.snareBp.set(2500, 0.8, sampleRate);
    this.hatHp.set(5200, 0.7, sampleRate);
    this.crashHpL.set(4500, 0.7, sampleRate);
    this.crashHpR.set(4800, 0.7, sampleRate);
    this.masterL.set(20000, 0.7, sampleRate);
    this.masterR.set(20000, 0.7, sampleRate);
    this.melody.fill(-1);
  }

  /** Multiplier per sample for a 60 dB fall in `seconds`. */
  private decay(seconds: number): number {
    return Math.pow(0.001, 1 / (seconds * this.sr));
  }

  setState(s: MusicState): void {
    this.targetMode = s.mode;
    this.paused = s.paused;
    if (s.mode !== 'off' && this.mode === 'off') this.start(s.mode);
  }

  /** A goal was scored: drums out from the next 16th, a sweep down, a riser and a drop. */
  goal(): void {
    if (this.mode === 'play' || this.mode === 'tension') this.goalPending = true;
  }

  /** True while the engine produces sound (the worklet can skip work otherwise). */
  get active(): boolean {
    return this.mode !== 'off' || this.level > MIN_LEVEL;
  }

  private start(mode: MusicMode): void {
    this.mode = mode;
    this.formIndex = 0;
    this.stepClock = 0;
    this.step = 0;
    this.enterSection(this.track.forms[mode as Exclude<MusicMode, 'off'>][0]);
    this.bar = -1; // the first step's nextBar() starts bar 0
  }

  private enterSection(sec: Section): void {
    this.section = sec;
    this.bar = 0;
    this.phrase++;
    this.makeMelody(this.track.progressions[sec.prog]);
    if (sec.crash) {
      this.crashAmp = 0.3;
      this.crashMul = this.decay(2.2);
      this.boomAmp = 0.55;
      this.boomMul = this.decay(1.1);
      this.boomFreq = 62;
      this.boomPhase = 0;
    }
    this.padTarget = sec.pad;
  }

  /** Bar boundary: mode changes, the goal break, the form. */
  private nextBar(): void {
    const sec = this.section;
    if (this.targetMode !== this.mode) {
      if (this.targetMode === 'off') {
        this.mode = 'off';
        return;
      }
      this.mode = this.targetMode;
      this.formIndex = 0;
      this.enterSection(this.track.forms[this.mode as Exclude<MusicMode, 'off'>][0]);
      return;
    }
    if (++this.bar < sec.bars) return;
    if (sec === this.track.goal) {
      this.enterSection(this.track.afterGoal[this.mode === 'tension' ? 'tension' : 'play']);
      return;
    }
    const form = this.track.forms[this.mode as Exclude<MusicMode, 'off'>];
    this.formIndex = (this.formIndex + 1) % form.length;
    this.enterSection(form[this.formIndex]);
  }

  /** One 16th: trigger the instruments. */
  private onStep(): void {
    if (this.step === 0) this.nextBar();
    if (this.mode === 'off') return;
    if (this.goalPending) {
      this.goalPending = false;
      // The rest of this bar plus the section's bars: count the current bar as -1.
      this.section = this.track.goal;
      this.bar = -1;
      this.padTarget = this.track.goal.pad;
      this.phrase++;
    }
    const sec = this.section;
    const st = this.step;
    const bar = this.bar < 0 ? 0 : this.bar;
    const track = this.track;
    const chord = track.progressions[sec.prog][bar % 4];
    const r = this.rng;
    const lastBar = this.bar === sec.bars - 1;

    // Kick
    if (sec.kick === 2 ? st % 4 === 0 : sec.kick === 1 && track.brokenKick[bar % 4].indexOf(st) >= 0) {
      if (!(sec.roll && lastBar && st >= 12)) this.trigKick(1);
    }
    // Clap on 2 and 4
    if (sec.clap && (st === 4 || st === 12) && !(sec.roll && lastBar && st === 12)) this.trigClap(0.9 + 0.1 * r.next());
    // Snare roll over the last bar: eighths, then sixteenths, louder
    if (sec.roll && lastBar && (st >= 8 || st % 2 === 0)) this.trigSnare(0.25 + 0.6 * (st / 15));
    // Hats
    if (sec.hats === 1 && st % 4 === 2) this.trigHat(0.6 + 0.15 * r.next(), false);
    else if (sec.hats === 2) {
      if (st === 14 && bar % 2 === 1) this.trigHat(0.7, true);
      else if (st % 4 === 2) this.trigHat(0.8 + 0.1 * r.next(), false);
      else this.trigHat(st % 2 === 0 ? 0.35 : 0.18 + 0.1 * r.next(), false);
    }
    // Bass
    if (sec.bass === 1 && st === 0) this.trigBass(chord.bass, 15, 0.7);
    else if (sec.bass === 2) {
      // [step, semitones over the root, length]
      const p = track.bassPattern;
      for (let i = 0; i < p.length; i += 3) {
        if (p[i] === st) this.trigBass(chord.bass + p[i + 1], p[i + 2], p[i + 1] === 0 ? 1 : 0.85);
      }
    }
    // Pad: the chord on each bar
    if (st === 0) this.setPad(chord);
    // Lead
    if (sec.lead > 0) {
      const idx = (bar % 8) * 16 + st;
      const n = this.melody[idx];
      if (n >= 0) this.trigLead(n, this.melodyLen[idx], sec.lead);
    }
    // Arp: chord tones climbing over two octaves
    if (sec.arp) this.trigArp(chord, st);
    // Riser over the section's last bars
    if (sec.riser > 0 && st === 0 && this.bar === sec.bars - sec.riser) this.trigRiser(sec.riser * STEPS_PER_BAR * this.samplesPerStep);
  }

  private trigKick(vel: number): void {
    this.kickAmp = vel;
    this.kickAmpMul = this.decay(0.42);
    this.kickPitch = 1;
    this.kickPitchMul = this.decay(0.09);
    this.kickPhase = 0;
    this.kickClick = 0.5 * vel;
    this.kickClickMul = this.decay(0.006);
    this.duck = 1;
  }

  private trigClap(vel: number): void {
    this.clapT = 0;
    this.clapVel = vel;
  }

  private trigSnare(vel: number): void {
    this.snareAmp = vel;
    this.snareMul = this.decay(0.16);
    this.snareTone = vel;
    this.snarePhase = 0;
  }

  private trigHat(vel: number, open: boolean): void {
    this.hatAmp = vel;
    this.hatMul = this.decay(open ? 0.4 : 0.07);
    this.hatPan = this.rng.next() * 0.5 - 0.25;
  }

  private trigBass(note: number, steps: number, vel: number): void {
    this.bassTarget = mtof(note);
    if (!this.bassGate || this.bassFreq === 0) this.bassFreq = this.bassTarget;
    this.bassGate = true;
    this.bassSteps = steps;
    this.bassEnv = vel;
    this.bassEnvMul = this.decay(0.28);
  }

  private setPad(chord: Chord): void {
    const per = this.lite ? 1 : 3;
    const det = [1, 0.9935, 1.0066];
    let v = 0;
    for (const n of chord.pad) {
      const f = mtof(n);
      for (let d = 0; d < per; d++) this.padFreq[v++] = f * det[d];
    }
    this.padVoices = v;
  }

  private trigLead(note: number, steps: number, vel: number): void {
    this.leadTarget = mtof(note);
    if (this.leadGate <= 0 || this.leadFreq === 0) this.leadFreq = this.leadTarget;
    this.leadGate = steps;
    this.leadEnv = 1;
    this.leadEnvMul = this.decay(0.35);
    this.leadVel = vel;
  }

  private trigArp(chord: Chord, st: number): void {
    // Chord tones from the track's arpFrom up, in its arpOrder.
    const order = this.track.arpOrder[st];
    const pcs = chord.pcs;
    const pc = pcs[order % 3];
    const from = this.track.arpFrom;
    let n = from + ((((pc - from) % 12) + 12) % 12);
    n += 12 * Math.floor(order / 3);
    this.arpFreq = mtof(n);
    this.arpPhase = 0;
    this.arpAmp = st % 4 === 0 ? 1 : 0.7;
    this.arpMul = this.decay(0.18);
    this.arpIndex++;
  }

  private trigRiser(samples: number): void {
    this.riserT = 0;
    this.riserLen = samples;
  }

  /**
   * The lead for an 8-bar phrase over `prog` (one chord per bar, the progression twice): bars 1
   * and 3 share a motif, bar 2 another, bar 4 a cadence landing on the chord's root; bars 5-8 repeat
   * 1-3 and end on a different cadence. Pitches walk the scale and land on chord tones on the beat.
   */
  private makeMelody(prog: readonly Chord[]): void {
    const r = new Rng(this.seed + this.phrase * 7919);
    const { motifs, cadences, leadScale: scale } = this.track;
    const mel = this.melody;
    const len = this.melodyLen;
    mel.fill(-1);
    len.fill(0);
    const mA = motifs[Math.floor(r.next() * motifs.length)];
    const mB = motifs[Math.floor(r.next() * motifs.length)];
    let pos = 3 + Math.floor(r.next() * 4); // index into the scale
    const writeBar = (bar: number, motif: readonly number[], chord: Chord, cadence: boolean): void => {
      for (let i = 0; i < motif.length; i += 2) {
        const st = motif[i];
        const last = i + 2 >= motif.length;
        const strong = st % 8 === 0 || i === 0;
        if (cadence && last) pos = nearestTone(scale, pos, chord.pcs[0]);
        else if (strong) pos = nearestChordTone(scale, pos, chord);
        else {
          const x = r.next();
          if (x < 0.6) pos += r.next() < 0.5 ? -1 : 1;
          else if (x < 0.85) pos = nearestChordTone(scale, pos + (r.next() < 0.5 ? -2 : 2), chord);
        }
        // Keep it in range, drift back towards the middle.
        if (pos < 1) pos = 2;
        if (pos > scale.length - 2) pos = scale.length - 3;
        let note = scale[pos];
        const alter = chord.alter;
        if (alter !== undefined && note % 12 === alter[0]) note += ((alter[1] - alter[0] + 18) % 12) - 6;
        mel[bar * 16 + st] = note;
        len[bar * 16 + st] = motif[i + 1];
      }
    };
    const cad1 = cadences[Math.floor(r.next() * cadences.length)];
    const cad2 = cadences[Math.floor(r.next() * cadences.length)];
    const start = pos;
    writeBar(0, mA, prog[0], false);
    writeBar(1, mB, prog[1], false);
    writeBar(2, mA, prog[2], false);
    writeBar(3, cad1, prog[3], true);
    pos = start;
    writeBar(4, mA, prog[0], false);
    writeBar(5, mB, prog[1], false);
    writeBar(6, mA, prog[2], false);
    writeBar(7, cad2, prog[3], true);
  }

  /**
   * Render `frames` samples into `outL` / `outR` (overwrites them).
   */
  render(outL: Float32Array, outR: Float32Array, frames: number): void {
    const sr = this.sr;
    // Master level and filter targets from the mode and the pause.
    this.levelTarget = this.mode === 'off' ? 0 : this.paused ? 0.45 : this.mode === 'menu' ? 0.8 : 1;
    this.cutoffTarget = this.paused ? 650 : this.section.cutoff;
    if (this.mode === 'off' && this.level <= MIN_LEVEL) {
      outL.fill(0, 0, frames);
      outR.fill(0, 0, frames);
      if (this.targetMode !== 'off') this.start(this.targetMode);
      return;
    }
    const levelK = 1 - Math.exp(-1 / (0.4 * sr));
    const lite = this.lite;
    const nr = this.noiseRng;
    const clapLen = 0.32 * sr;
    const burst = 0.011 * sr;
    for (let i = 0; i < frames; i++) {
      // Transport
      if (this.stepClock <= 0) {
        this.stepClock += this.samplesPerStep;
        this.stepEnds();
        this.onStep();
        this.step = (this.step + 1) % STEPS_PER_BAR;
      }
      this.stepClock--;

      // Control rate (every 32 samples): filters and glides.
      if (--this.ctrl <= 0) {
        this.ctrl = 32;
        this.control();
      }

      this.level += (this.levelTarget - this.level) * levelK;
      const duck = 1 - 0.75 * this.duck;
      this.duck *= this.duckMul;

      let l = 0;
      let r = 0;
      let revIn = 0;
      let dlyIn = 0;

      // Kick
      if (this.kickAmp > MIN_LEVEL) {
        const f = 55 + 125 * this.kickPitch;
        this.kickPitch *= this.kickPitchMul;
        this.kickPhase += f / sr;
        if (this.kickPhase >= 1) this.kickPhase -= 1;
        let k = Math.sin(2 * Math.PI * this.kickPhase) * this.kickAmp + nr.noise() * this.kickClick;
        this.kickAmp *= this.kickAmpMul;
        this.kickClick *= this.kickClickMul;
        k = Math.tanh(1.6 * k) * 0.48;
        l += k;
        r += k;
      }

      // Clap
      if (this.clapT >= 0) {
        const t = this.clapT;
        let a: number;
        if (t < burst * 3) a = Math.exp(-(t % burst) / (0.0025 * sr));
        else a = 0.7 * Math.exp(-(t - burst * 3) / (0.05 * sr));
        this.clapBp.run(nr.noise());
        const c = this.clapBp.band * a * this.clapVel * 1.0;
        l += c;
        r += c;
        revIn += c * 0.6;
        if (++this.clapT > clapLen) this.clapT = -1;
      }

      // Snare (rolls)
      if (this.snareAmp > MIN_LEVEL) {
        this.snarePhase += 190 / sr;
        if (this.snarePhase >= 1) this.snarePhase -= 1;
        this.snareBp.run(nr.noise());
        const s = (this.snareBp.band * 0.9 + Math.sin(2 * Math.PI * this.snarePhase) * this.snareTone * 0.6) * this.snareAmp * 0.6;
        this.snareAmp *= this.snareMul;
        this.snareTone *= this.snareMul;
        l += s;
        r += s;
        revIn += s * 0.4;
      }

      // Hats
      if (this.hatAmp > MIN_LEVEL) {
        this.hatHp.run(nr.noise());
        const h = this.hatHp.high * this.hatAmp * 0.85;
        this.hatAmp *= this.hatMul;
        l += h * (1 - this.hatPan);
        r += h * (1 + this.hatPan);
      }

      // Bass
      if (this.bassAmp > MIN_LEVEL || this.bassGate) {
        const target = this.bassGate ? 1 : 0;
        this.bassAmp += (target - this.bassAmp) * (this.bassGate ? 0.01 : 0.002);
        const f = this.bassFreq;
        const dA = f / sr;
        const dB = (f * 1.007) / sr;
        this.bassPA += dA;
        if (this.bassPA >= 1) this.bassPA -= 1;
        this.bassPB += dB;
        if (this.bassPB >= 1) this.bassPB -= 1;
        this.bassPS += dA;
        if (this.bassPS >= 1) this.bassPS -= 1;
        const saw = blepSaw(this.bassPA, dA) + blepSaw(this.bassPB, dB);
        this.bassLp.run(saw * 0.5);
        this.bassEnv *= this.bassEnvMul;
        const b = Math.tanh(1.8 * (this.bassLp.low * 1.0 + Math.sin(2 * Math.PI * this.bassPS) * 0.55)) * this.bassAmp * 0.24 * duck;
        l += b;
        r += b;
      }

      // Pad
      if (this.padAmp > MIN_LEVEL || this.padTarget > 0) {
        this.padAmp += (this.padTarget - this.padAmp) * 0.0002;
        let pl = 0;
        let pr = 0;
        const n = this.padVoices;
        for (let v = 0; v < n; v++) {
          const d = this.padFreq[v] / sr;
          let p = this.padPhase[v] + d;
          if (p >= 1) p -= 1;
          this.padPhase[v] = p;
          const s = blepSaw(p, d);
          const side = lite ? 0 : (v % 3) - 1; // detuned voices to the sides
          pl += s * (1 - 0.6 * side);
          pr += s * (1 + 0.6 * side);
        }
        this.padLpL.run(pl);
        this.padLpR.run(pr);
        const g = this.padAmp * (lite ? 0.09 : 0.045) * duck;
        const ol = this.padLpL.low * g;
        const or = this.padLpR.low * g;
        l += ol;
        r += or;
        revIn += (ol + or) * 0.5;
      }

      // Lead
      if (this.leadAmp > MIN_LEVEL || this.leadGate > 0) {
        this.leadAmp += ((this.leadGate > 0 ? this.leadVel : 0) - this.leadAmp) * (this.leadGate > 0 ? 0.02 : 0.003);
        const f = this.leadFreq;
        const dA = f / sr;
        const dB = (f * 1.004) / sr;
        this.leadPA += dA;
        if (this.leadPA >= 1) this.leadPA -= 1;
        this.leadPB += dB;
        if (this.leadPB >= 1) this.leadPB -= 1;
        const pb2 = this.leadPB + 0.5 >= 1 ? this.leadPB - 0.5 : this.leadPB + 0.5;
        const sq = blepSaw(this.leadPB, dB) - blepSaw(pb2, dB);
        this.leadLp.run(blepSaw(this.leadPA, dA) * 0.6 + sq * 0.4);
        this.leadEnv *= this.leadEnvMul;
        const o = this.leadLp.low * this.leadAmp * 0.17;
        l += o;
        r += o;
        dlyIn += o * 0.55;
        revIn += o * 0.5;
      }

      // Arp
      if (this.arpAmp > MIN_LEVEL) {
        this.arpPhase += this.arpFreq / sr;
        if (this.arpPhase >= 1) this.arpPhase -= 1;
        const tri = 1 - 4 * Math.abs(this.arpPhase - 0.5);
        const a = tri * this.arpAmp * 0.1 * duck;
        this.arpAmp *= this.arpMul;
        const pan = this.arpIndex % 2 === 0 ? 0.3 : -0.3;
        l += a * (1 - pan);
        r += a * (1 + pan);
        dlyIn += a * 0.8;
      }

      // Riser
      if (this.riserT >= 0) {
        const x = this.riserT / this.riserLen;
        const a = x * x * 0.22;
        this.riserBpL.run(nr.noise());
        this.riserBpR.run(nr.noise());
        l += this.riserBpL.band * a;
        r += this.riserBpR.band * a;
        revIn += (this.riserBpL.band + this.riserBpR.band) * a * 0.3;
        if (++this.riserT >= this.riserLen) this.riserT = -1;
      }

      // Crash and boom
      if (this.crashAmp > MIN_LEVEL) {
        this.crashHpL.run(nr.noise());
        this.crashHpR.run(nr.noise());
        l += this.crashHpL.high * this.crashAmp;
        r += this.crashHpR.high * this.crashAmp;
        revIn += (this.crashHpL.high + this.crashHpR.high) * this.crashAmp * 0.3;
        this.crashAmp *= this.crashMul;
      }
      if (this.boomAmp > MIN_LEVEL) {
        this.boomPhase += this.boomFreq / sr;
        if (this.boomPhase >= 1) this.boomPhase -= 1;
        this.boomFreq += (36 - this.boomFreq) * 0.00006;
        const b = Math.tanh(2 * Math.sin(2 * Math.PI * this.boomPhase)) * this.boomAmp * 0.25;
        this.boomAmp *= this.boomMul;
        l += b;
        r += b;
      }

      // Ping-pong delay (dotted eighth), damped feedback.
      const di = this.delayI;
      const dl = this.delayL[di];
      const dr = this.delayR[di];
      this.delayLpL += (dr - this.delayLpL) * 0.35;
      this.delayLpR += (dl - this.delayLpR) * 0.35;
      this.delayL[di] = dlyIn + this.delayLpL * 0.38;
      this.delayR[di] = this.delayLpR * 0.38;
      if (++this.delayI >= this.delayLen) this.delayI = 0;
      l += dl * 0.5;
      r += dr * 0.5;

      // Reverb (skipped on lite)
      if (!lite) {
        const x = revIn * 0.2;
        let rl = 0;
        let rr = 0;
        for (let c = 0; c < 4; c++) {
          rl += this.combsL[c].run(x, 0.8, 0.35);
          rr += this.combsR[c].run(x, 0.8, 0.35);
        }
        rl = this.apL[1].run(this.apL[0].run(rl));
        rr = this.apR[1].run(this.apR[0].run(rr));
        l += rl * 0.25;
        r += rr * 0.25;
      }

      // Master: low-pass, level, soft clip.
      this.masterL.run(l);
      this.masterR.run(r);
      const lv = this.level;
      outL[i] = Math.tanh(this.masterL.low * lv);
      outR[i] = Math.tanh(this.masterR.low * lv);
    }
  }

  /** Before each step: gates count down. */
  private stepEnds(): void {
    if (this.bassGate && --this.bassSteps <= 0) this.bassGate = false;
    if (this.leadGate > 0) this.leadGate--;
  }

  /** Control-rate updates: glides, filter cutoffs. */
  private control(): void {
    const sr = this.sr;
    this.bassFreq += (this.bassTarget - this.bassFreq) * 0.3;
    this.leadFreq += (this.leadTarget - this.leadFreq) * 0.35;
    this.bassLp.set(160 + 1400 * this.bassEnv, 1.4, sr);
    this.leadLp.set(2200 + 5500 * this.leadEnv, 1.3, sr);
    // Pad: opens with the section (menu darker), slowly.
    this.padCutTarget = this.section.kick === 2 ? 5200 : this.section.kick === 1 ? 3000 : 1600;
    this.padCut += (this.padCutTarget - this.padCut) * 0.002;
    this.padLpL.set(this.padCut, 0.9, sr);
    this.padLpR.set(this.padCut * 1.05, 0.9, sr);
    if (this.riserT >= 0) {
      const x = this.riserT / this.riserLen;
      const f = 300 * Math.pow(30, x);
      this.riserBpL.set(f, 1.4, sr);
      this.riserBpR.set(f * 1.1, 1.4, sr);
    }
    // Master filter: exponential glide; above ~16 kHz it is effectively open.
    this.cutoff *= Math.pow(this.cutoffTarget / this.cutoff, this.cutoffTarget < this.cutoff ? 0.03 : 0.012);
    this.masterL.set(this.cutoff, 0.75, sr);
    this.masterR.set(this.cutoff, 0.75, sr);
  }
}

/** Index of the scale note nearest to `pos` that is a chord tone (or a note the chord alters into one). */
function nearestChordTone(scale: readonly number[], pos: number, chord: Chord): number {
  const pcs = chord.pcs;
  const alter = chord.alter;
  let best = pos;
  let bestD = 99;
  for (let i = 0; i < scale.length; i++) {
    const pc = scale[i] % 12;
    const isTone = pcs.indexOf(pc) >= 0 || (alter !== undefined && pc === alter[0] && pcs.indexOf(alter[1]) >= 0);
    if (!isTone) continue;
    const d = Math.abs(i - pos);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Index of the scale note of pitch class `pc` nearest to `pos`. */
function nearestTone(scale: readonly number[], pos: number, pc: number): number {
  let best = pos;
  let bestD = 99;
  for (let i = 0; i < scale.length; i++) {
    if (scale[i] % 12 !== pc) continue;
    const d = Math.abs(i - pos);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

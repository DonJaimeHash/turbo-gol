/**
 * Game audio: everything is synthesized (Web Audio and an AudioWorklet, no sample files). This
 * class owns the AudioContext and the mix; what things sound like lives next to it:
 *
 *   sfx/sounds.ts    the sound-effect catalog: one entry per one-shot (ball hit, goal, jump...)
 *   sfx/kit.ts       the toolkit those sounds are built with (voices, bodies, notes, FM, noise)
 *   sfx/layers.ts    the continuous layers that follow the car (engine, boost roar, wind)
 *   sfx/assets.ts    buffers and waves made once (noise, the room's impulse, clicks, crowd)
 *   music/           the procedural music: the player (engine.ts) and the songs (tracks/)
 *   README.md        how to add or replace a sound or a song
 *
 * Mix: continuous layers → sfx bus → master; one-shots → their dry bus (or a shared soft
 * saturator) → master, plus a send into one shared short room (no room with `{ room: false }`:
 * super low's CPU trim); music worklet → music gain → master; master → DynamicsCompressor (a
 * gentle limiter, so stacked impacts do not clip) → destination.
 *
 * The graph is created lazily on the first `resume()` (which must come from a user gesture
 * because of the autoplay policy); every method is a no-op while the context is not running, so
 * stale events never pile up and burst out on resume.
 */
import type { MusicMode } from './music/engine';
import musicWorkletUrl from './music/worklet.ts?worker&url';
import { SfxKit } from './sfx/kit';
import { BoostLayer, EngineLayer, WindLayer, clamp01, speedRatio, type AudioState, type Layer, type LayerFrame } from './sfx/layers';
import { SOUNDS, type SoundArgs, type SoundDef, type SoundName } from './sfx/sounds';

export type { AudioState } from './sfx/layers';
export type { SoundName } from './sfx/sounds';

/** Music bus gain at a music volume of 1 (the score renders near -14 dBFS RMS; it sits under the SFX). */
const MUSIC_LEVEL = 0.4;

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private kit: SfxKit | null = null;

  // Continuous layers (sfx/layers.ts), in update order, and the frame they all read (reused).
  private boost: BoostLayer | null = null;
  private layers: Layer[] = [];
  private readonly frame: LayerFrame = { t: 0, dt: 0, state: { speed: 0, forwardSpeed: 0, boosting: false, supersonic: false, grounded: true, throttle: 0 }, speedRatio: 0, throttle: 0, boostEdge: false };
  private smoothSpeed = 0;
  private prevBoosting = false;
  /** Context time each rate-limited sound last played (SoundDef.minInterval). */
  private readonly lastPlayed = new Map<SoundName, number>();

  // Music
  private musicNode: AudioWorkletNode | null = null;
  private musicGain: GainNode | null = null;
  private musicVolume = 0.5;
  private musicMode: MusicMode = 'off';
  private musicPaused = false;

  private volume = 0.7;
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

  /** Music volume 0..1 (under the master volume). */
  setMusicVolume(v: number): void {
    this.musicVolume = clamp01(v);
    if (this.ctx !== null && this.musicGain !== null) {
      this.musicGain.gain.setTargetAtTime(this.musicVolume * MUSIC_LEVEL, this.ctx.currentTime, 0.05);
    }
  }

  /**
   * What the music plays: 'menu', 'play', 'tension' (the end of a match, overtime) or 'off', and
   * whether the game is paused (filtered and quieter). Cheap to call every frame: only a change is
   * sent to the audio thread, where mode changes land on the next bar.
   */
  setMusic(mode: MusicMode, paused: boolean): void {
    if (mode === this.musicMode && paused === this.musicPaused) return;
    this.musicMode = mode;
    this.musicPaused = paused;
    this.musicNode?.port.postMessage({ type: 'state', mode, paused });
  }

  /**
   * Play a sound from the catalog (sfx/sounds.ts) now, e.g. `play('ballHit', 0.4)`. The arguments
   * are the sound's own and are type-checked. Returns false when nothing played: the context is
   * not running, or the sound's minInterval has not passed since it last played.
   */
  play<N extends SoundName>(name: N, ...args: SoundArgs<N>): boolean {
    const ctx = this.ready();
    if (ctx === null) return false;
    // TS cannot correlate SOUNDS[N] with SoundArgs<N> for a generic N; the signature checks the call.
    const def = SOUNDS[name] as unknown as SoundDef<SoundArgs<N>>;
    const t = ctx.currentTime;
    const min = def.minInterval ?? 0;
    if (min > 0) {
      if (t - (this.lastPlayed.get(name) ?? -1) < min) return false;
      this.lastPlayed.set(name, t);
    }
    def.play(this.kit!, t, ...args);
    return true;
  }

  /** Drive the continuous layers. Call once per rendered frame with the player's car state. */
  update(dt: number, state: AudioState): void {
    const boosting = state.boosting;
    const ctx = this.ctx;
    if (ctx === null || ctx.state !== 'running') {
      this.prevBoosting = boosting;
      return;
    }
    // Smooth the speed a little so the pitch does not jitter with contact noise.
    const k = dt > 0 ? Math.min(1, dt * 14) : 1;
    this.smoothSpeed += (state.speed - this.smoothSpeed) * k;
    const f = this.frame;
    f.t = ctx.currentTime;
    f.dt = dt;
    f.state = state;
    f.speedRatio = speedRatio(this.smoothSpeed);
    f.throttle = clamp01(Math.abs(state.throttle));
    f.boostEdge = boosting !== this.prevBoosting;
    // Ignition / release one-shots on the edges, tuned to the hum before this frame moves it.
    if (f.boostEdge) {
      if (boosting) this.play('boostStart', this.boost!.hum);
      else this.play('boostStop');
    }
    for (const layer of this.layers) layer.update(f);
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
    for (const layer of this.layers) layer.reset();
    // The music stays, held down like a pause (the next setMusic() restores it).
    this.setMusic(this.musicMode, true);
    const ctx = this.ctx;
    if (ctx === null || ctx.state !== 'running') return;
    for (const layer of this.layers) layer.silence(ctx.currentTime);
  }

  /**
   * A goal was scored: the music breaks down under the celebration (play('goal', team)), rises and
   * drops into the next kickoff. Only in a match's modes, and only while sound plays.
   */
  musicGoal(): void {
    if (this.running) this.musicNode?.port.postMessage({ type: 'goal' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const ctx = this.ctx;
    if (ctx === null) return;
    try {
      for (const layer of this.layers) layer.stop();
      this.musicNode?.disconnect();
    } catch {
      /* already stopped */
    }
    void ctx.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
    this.kit = null;
    this.boost = null;
    this.layers = [];
    this.musicNode = null;
    this.musicGain = null;
  }

  // ---- Internals ----------------------------------------------------------------------------

  /** The context when sound can be produced, else null. */
  private ready(): AudioContext | null {
    const ctx = this.ctx;
    return ctx !== null && ctx.state === 'running' && this.kit !== null ? ctx : null;
  }

  private buildGraph(): void {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
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
    this.buildMusic(ctx, master);
    const kit = new SfxKit(ctx, master, this.withRoom);
    this.kit = kit;
    this.boost = new BoostLayer(kit, sfx);
    this.layers = [new EngineLayer(kit, sfx), this.boost, new WindLayer(kit, sfx)];
  }

  /**
   * Music bus (gain → master) and its worklet. addModule is asynchronous: the node joins when the
   * module is ready and gets the current state then. Lite (no room) runs the score's lite voicing.
   */
  private buildMusic(ctx: AudioContext, master: GainNode): void {
    const gain = ctx.createGain();
    gain.gain.value = this.musicVolume * MUSIC_LEVEL;
    gain.connect(master);
    this.musicGain = gain;
    if (typeof AudioWorkletNode === 'undefined' || ctx.audioWorklet === undefined) return;
    ctx.audioWorklet
      .addModule(musicWorkletUrl)
      .then(() => {
        if (this.ctx !== ctx || this.disposed) return;
        const node = new AudioWorkletNode(ctx, 'turbogol-music', {
          numberOfInputs: 0,
          outputChannelCount: [2],
          processorOptions: { lite: !this.withRoom },
        });
        node.connect(gain);
        node.port.postMessage({ type: 'state', mode: this.musicMode, paused: this.musicPaused });
        this.musicNode = node;
      })
      .catch(() => undefined);
  }
}

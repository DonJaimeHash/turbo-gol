/**
 * AudioWorklet processor 'turbogol-music': runs the MusicEngine (engine.ts) on the audio thread,
 * stereo out, playing processorOptions.track (an id from tracks/index.ts; default DEFAULT_TRACK).
 * Messages from the main thread (Audio.ts): { type: 'state', mode, paused } and { type: 'goal' }.
 * Bundled by Vite through `?worker&url` and loaded with audioWorklet.addModule.
 */
import { MusicEngine, type MusicState } from './engine';
import { trackById } from './tracks';

// The AudioWorkletGlobalScope is not in TypeScript's DOM lib.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options?: { processorOptions?: unknown }) => AudioWorkletProcessor): void;

type MusicMessage = ({ type: 'state' } & MusicState) | { type: 'goal' };

class MusicProcessor extends AudioWorkletProcessor {
  private readonly engine: MusicEngine;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const opts = (options?.processorOptions ?? {}) as { lite?: boolean; track?: string };
    this.engine = new MusicEngine(sampleRate, trackById(opts.track), { lite: opts.lite === true, seed: (Math.random() * 0x7fffffff) | 0 });
    this.port.onmessage = (e: MessageEvent<MusicMessage>): void => {
      const m = e.data;
      if (m.type === 'goal') this.engine.goal();
      else this.engine.setState(m);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const l = out[0];
    const r = out.length > 1 ? out[1] : out[0];
    this.engine.render(l, r, l.length);
    return true;
  }
}

registerProcessor('turbogol-music', MusicProcessor);

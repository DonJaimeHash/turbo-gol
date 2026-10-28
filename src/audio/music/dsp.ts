/**
 * DSP building blocks for the music engine: per-sample filters, delays, a saw and a PRNG. Plain
 * TypeScript with no imports and no Web Audio, so it runs in the AudioWorklet and in Node.
 */

export function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** PolyBLEP-corrected saw, -1..1, at `phase` (0..1) with phase increment `dt`. */
export function blepSaw(phase: number, dt: number): number {
  let v = 2 * phase - 1;
  if (phase < dt) {
    const t = phase / dt;
    v -= t + t - t * t - 1;
  } else if (phase > 1 - dt) {
    const t = (phase - 1) / dt;
    v -= t * t + t + t + 1;
  }
  return v;
}

/** Topology-preserving state-variable filter (stable under fast cutoff changes). */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = 1;
  low = 0;
  band = 0;
  high = 0;

  set(fc: number, q: number, sr: number): void {
    const f = fc < 20 ? 20 : fc > sr * 0.45 ? sr * 0.45 : fc;
    const g = Math.tan((Math.PI * f) / sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  run(x: number): void {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2;
    this.band = v1;
    this.high = x - this.k * v1 - v2;
  }

  reset(): void {
    this.ic1 = this.ic2 = this.low = this.band = this.high = 0;
  }
}

/** Schroeder comb with a damped feedback path. */
export class Comb {
  private readonly buf: Float32Array;
  private i = 0;
  private store = 0;
  constructor(len: number) {
    this.buf = new Float32Array(len);
  }
  run(x: number, fb: number, damp: number): number {
    const y = this.buf[this.i];
    this.store = y * (1 - damp) + this.store * damp;
    this.buf[this.i] = x + this.store * fb;
    if (++this.i >= this.buf.length) this.i = 0;
    return y;
  }
}

/** Schroeder allpass (gain 0.5). */
export class Allpass {
  private readonly buf: Float32Array;
  private i = 0;
  constructor(len: number) {
    this.buf = new Float32Array(len);
  }
  run(x: number): number {
    const b = this.buf[this.i];
    this.buf[this.i] = x + b * 0.5;
    if (++this.i >= this.buf.length) this.i = 0;
    return b - x;
  }
}

/** Small deterministic PRNG (mulberry32). */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** White noise sample, -1..1. */
  noise(): number {
    return this.next() * 2 - 1;
  }
}

/**
 * Buffers and waves the sound effects share, synthesized once when the audio graph is built (no
 * files): white noise, the room's impulse, the click ticks, the goal crowd and periodic waves.
 */

/** 2 s of white noise shared by every noise layer and the continuous layers. */
export function makeNoise(ctx: BaseAudioContext): AudioBuffer {
  const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return noise;
}

/**
 * Soft saturation curve tanh(`drive` x) / `norm`: with norm = drive it is unity gain for small
 * signals (the level fed in sets the drive), with norm = tanh(drive) a full-scale input stays at
 * full scale. Odd length: an input of 0 maps exactly to 0 (no DC).
 */
export function makeSoftClip(drive: number, norm: number, length = 1025): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const x = (i / (length - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}

/**
 * Stereo impulse of a short, warm room. Early reflections at 7-43 ms (different on each side, a
 * fifth of the energy, softened by a 1.5 / 5 kHz lowpass pair) and a diffuse tail that fades in
 * over 30 ms and falls 60 dB in 0.44 s (left) / 0.49 s (right) through a lowpass pair gliding
 * 900 → 400 Hz and 4.5 → 2.2 kHz (darker as it decays); a 110 Hz highpass pair keeps the subs out.
 * Each channel has its own noise (width). Scaled so a sound in the 125 Hz-4 kHz range comes back
 * with about its own energy, for a convolver with normalize = false.
 */
export function makeRoomImpulse(ctx: BaseAudioContext): AudioBuffer {
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
export function makeWave(ctx: BaseAudioContext, amps: readonly number[], spread: boolean): PeriodicWave {
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
 * Four 12 ms click variants back to back: white noise with a 0.3 ms attack and a 1.5 ms
 * exponential decay through a band-pass at 3 kHz (Q 0.9), each normalized to a peak of 1.
 */
export function makeClickBuffer(ctx: BaseAudioContext): AudioBuffer {
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
 * Crowd texture for the goal (2 s, loops seamlessly): white noise whose level flutters like many
 * voices (a smooth random contour, about 9 changes a second, ±30%) with about 40 hand claps a
 * second on top (short ticks of their own noise, random strength), then darkened by a 4 kHz
 * lowpass pair. Below 4 kHz it has the level of plain white noise, so the bands that read it take
 * the same gains as a noise layer, and there is no hiss on top.
 */
export function makeCrowd(ctx: BaseAudioContext): AudioBuffer {
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

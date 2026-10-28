/**
 * The sound-effect catalog: every one-shot the game plays, one entry each. To change how
 * something sounds, edit its `play`; to add a sound, add an entry here and play it with
 * `audio.play('name', ...args)` (Audio.ts). The arguments after `t` are the sound's own (a hit's
 * strength, the scoring team) and are type-checked at the call.
 *
 * `play(k, t, ...)` builds the sound with the kit (kit.ts) at context time `t` (now): one or more
 * voices (`k.voice(level, roomSend, saturate?)`) and layers connected into them, each starting at
 * `t` or a little later. `minInterval` drops calls that come too close (stacked collisions).
 * Random detuning per call keeps repeated sounds from sounding stamped.
 */
import type { Team } from '../../sim/types';
import { MEMBRANE, MIN_GAIN, type SfxKit } from './kit';

export interface SoundDef<A extends unknown[]> {
  /** Calls within this many seconds of the last one played are dropped. Default 0: never. */
  minInterval?: number;
  /** Build the sound at context time `t`. */
  play(k: SfxKit, t: number, ...args: A): void;
}

/** Identity helper: infers each sound's argument list from its `play`. */
function sound<A extends unknown[]>(def: SoundDef<A>): SoundDef<A> {
  return def;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export const SOUNDS = {
  /**
   * Car hits the ball. `strength` 0..1 (e.g. relative speed / 3000). A rubber shell full of air:
   * a contact tick, a wide band of air noise around 850 → 640 Hz (the slap of the shell and the
   * air inside it) and the shell itself, its first three membrane modes on a warm fundamental of
   * 180 → 125 Hz that fall onto pitch within a few ms and die in ~0.1 s. Harder hits are lower,
   * heavier and drop further; each call is detuned by up to ±5% so a dribble never repeats.
   * 13 nodes.
   */
  ballHit: sound({
    minInterval: 0.04,
    play(k, t, strength: number) {
      const s = clamp01(strength);
      const vary = 0.95 + Math.random() * 0.1;
      const v = k.voice(1, 0.05 + 0.01 * s);
      // Contact: a short tick, duller (lower, so longer) for harder hits.
      k.click(v, t, (2200 - 800 * s) * vary, 0.055 + 0.155 * s);
      // Air: about 2 octaves of noise, long enough to be heard as part of the body.
      k.noiseLayer(v, t, 0.19 + 0.42 * s, { type: 'bandpass', freq: (850 - 210 * s) * vary, q: 0.7, decay: 0.08 + 0.015 * s });
      // Shell: inharmonic modes (the first three of MEMBRANE), the lowest one warm for small speakers.
      k.body(v, t, (180 - 55 * s) * vary, 0.09 + 0.37 * s, {
        ratios: MEMBRANE,
        amps: [0.55, 0.65, 0.55],
        decays: [0.1 + 0.02 * s, 0.09, 0.07],
        drop: 1.3 + 0.25 * s,
        glide: 0.03,
        warm: true,
      });
    },
  }),

  /**
   * Car-car bump or demo. `strength` 0..1 (0.6 a bump, 1 the bump of a demolition, whose explosion
   * `demolition` adds). Two steel bodies meeting: the panels' thud (a warm 135 → 110 Hz plus an
   * inharmonic mode at 1.71×), a crunch of noise whose band closes from 2 kHz to 600 Hz, and the
   * ring, an inharmonic FM clank on 560 Hz (ratio 1.42-1.5) whose partials spread over 0.2-3.5 kHz
   * and mellow as its index falls. The ring leads (it is the clank, and it sits where the ear is
   * most sensitive); the thud gives it weight. Stronger is louder, lower and crunchier. 13 nodes.
   */
  carHit: sound({
    minInterval: 0.06,
    play(k, t, strength: number) {
      const s = clamp01(strength);
      const vary = 0.94 + Math.random() * 0.12;
      const v = k.voice(0.3 + 0.7 * s, 0.06 + 0.04 * s);
      // Weight: the panels' low thud.
      k.body(v, t, (135 - 25 * s) * vary, 0.42, { ratios: [1, 1.71], amps: [0.7, 0.8], decays: [0.15, 0.12], drop: 1.3, glide: 0.03, warm: true });
      // Crunch: bending sheet metal.
      k.noiseLayer(v, t, 0.4 + 0.25 * s, { type: 'bandpass', freq: 2000, q: 0.7, sweepTo: 600, decay: 0.1 + 0.04 * s });
      // Ring: the shell's metal partials, bright then dull (a slightly different cluster each time).
      k.fm(v, t, 560 * vary, 0.25, { ratio: 1.42 + Math.random() * 0.08, index: 2 + 1.2 * s, indexEnd: 0.5, indexDecay: 0.07, decay: 0.17 + 0.03 * s, bend: 1.04 });
    },
  }),

  /**
   * A car blown up: a sharp crack; a saturated low boom (a warm sub falling onto ~50 Hz plus two
   * rumble partials, so its harmonics at 100-400 Hz carry it on small speakers); a broadband roar
   * whose lowpass sweeps down over a low-mid body band; the car's shell ringing (inharmonic FM);
   * and a short tail of debris crackles, all into the room. `strength` 0..1 (the game lowers it
   * with the distance from the camera): it scales the level and the brightness, and a distant
   * blast comes back a little wetter.
   */
  demolition: sound({
    minInterval: 0.08,
    play(k, t, strength: number) {
      const s = clamp01(strength);
      if (s <= 0) return;
      const far = 1 - s; // 0 next to the camera, 0.8 at the far end
      // Boom: saturated, so a close blast is also grittier.
      const boom = k.voice(0.8 * s, 0.3, true);
      k.body(boom, t, 50, 0.55, { ratios: [1, 2.1, 3.3], amps: [0.65, 0.8, 0.6], decays: [0.6, 0.5, 0.36], drop: 2, glide: 0.1, warm: true });
      const v = k.voice(0.8 * s, 0.35 + 0.3 * far);
      k.click(v, t, 2400 - 1000 * far, 0.3 * (1 - 0.5 * far));
      k.noiseLayer(v, t, 0.5, { type: 'lowpass', freq: 3000 - 1600 * far, sweepTo: 260, sweepTime: 0.6, decay: 0.8 });
      k.noiseLayer(v, t, 0.7, { type: 'bandpass', freq: 450, q: 0.7, sweepTo: 220, decay: 0.5 });
      k.fm(v, t, 190, 0.14, { ratio: 1.41, index: 3, indexEnd: 0.6, decay: 0.42, bend: 1.3, bendTime: 0.04 });
      // Debris: four crackles over the first 0.4 s, each softer and duller than the last.
      for (let i = 0; i < 4; i++) {
        const at = t + 0.08 + i * 0.09 + Math.random() * 0.06;
        k.click(v, at, (1500 + Math.random() * 900) * (1 - 0.15 * i) * (1 - 0.35 * far), 0.1 * (1 - 0.2 * i));
      }
    },
  }),

  /**
   * The car leaving the ground (also the second jump): a short suspension thunk (a soft click and
   * three close inharmonic partials around 120 Hz, the lowest warm, settling a little in pitch)
   * under a push of air (a noise band rising 380 → 1200 Hz and settling to 550 Hz). ~0.13 s.
   */
  jump: sound({
    play(k, t) {
      const v = k.voice(1, 0.08);
      k.click(v, t, 1100, 0.03);
      k.body(v, t, 120, 0.067, { ratios: [1, 1.29, 1.71], amps: [0.55, 0.7, 0.6], decays: [0.11, 0.09, 0.08], drop: 1.35, glide: 0.03, warm: true });
      k.noiseLayer(v, t, 0.22, { type: 'bandpass', freq: 380, q: 1, sweepTo: 1200, sweepTime: 0.06, sweepBack: 550, attack: 0.01, decay: 0.12 });
    },
  }),

  /**
   * The flip: a rotating whoosh. Two noise bands cross (one rising 350 → 1400 Hz and settling to
   * 550 Hz, one falling 1 kHz → 300 Hz from 50 ms later) over a low swoosh (a band 200 → 380 →
   * 200 Hz) and a warm 135 Hz tone that scoops up into pitch, so the air has weight. ~0.3 s.
   */
  dodge: sound({
    play(k, t) {
      const v = k.voice(1, 0.15);
      k.noiseLayer(v, t, 0.19, { type: 'bandpass', freq: 350, q: 1.2, sweepTo: 1400, sweepTime: 0.11, sweepBack: 550, attack: 0.03, decay: 0.2 });
      k.noiseLayer(v, t + 0.05, 0.115, { type: 'bandpass', freq: 1000, q: 1.1, sweepTo: 300, attack: 0.04, decay: 0.2 });
      k.noiseLayer(v, t, 0.21, { type: 'bandpass', freq: 200, q: 0.9, sweepTo: 380, sweepTime: 0.09, sweepBack: 200, attack: 0.03, decay: 0.22 });
      k.note(v, t, 135, 0.038, { ratios: [1], amps: [1], decays: [0.2], attack: 0.03, bend: 0.85, bendTime: 0.08, wave: 'warm' });
    },
  }),

  /**
   * The player's car lands. Soft: a muffled tyre thud (a warm 105 Hz and two rubbery partials
   * above it, heavily damped) and the squish of the tread, noise under a lowpass closing from
   * 900 Hz to 300 Hz. Hard: the suspension bottoming out, a slam of three partials on a warm 78 Hz
   * through the shared saturator (grit, and harmonics that small speakers render), a lowpassed
   * noise thump under it and a short metal rattle right after. 13 / 14 nodes.
   */
  land: sound({
    play(k, t, hard: boolean) {
      const vary = 0.95 + Math.random() * 0.1;
      if (hard) {
        const slam = k.voice(1, 0.08, true);
        k.body(slam, t, 78 * vary, 0.27, { ratios: [1, 2.2, 3.4], amps: [0.5, 0.7, 0.55], decays: [0.16, 0.13, 0.1], drop: 1.6, glide: 0.035, warm: true });
        const v = k.voice(1, 0);
        k.noiseLayer(v, t, 0.3, { type: 'lowpass', freq: 1400, sweepTo: 300, decay: 0.12 });
        k.rattle(v, t + 0.012, 2400 * vary, 0.13, 0.11);
      } else {
        const v = k.voice(1, 0.06);
        k.body(v, t, 105 * vary, 0.07, { ratios: [1, 1.6, 2.3], amps: [0.6, 0.5, 0.5], decays: [0.1, 0.09, 0.07], drop: 1.25, glide: 0.02, warm: true });
        k.noiseLayer(v, t, 0.18, { type: 'lowpass', freq: 900, q: 1, sweepTo: 300, attack: 0.004, decay: 0.08 });
        k.click(v, t, 900 * vary, 0.019);
      }
    },
  }),

  /**
   * Goal celebration: the stadium horn chord (the team's root, G3 for blue and A3 for red, over
   * its octave below, then the fifth 0.12 s later; detuned pairs through a lowpass that darkens
   * as it fades), a crowd that swells and cheers (the kit's crowd texture read through three
   * vowel-like bands that open and settle) and the explosion boom (a saturated warm sub plus a
   * roar whose lowpass sweeps down).
   */
  goal: sound({
    play(k, t, team: Team) {
      const ctx = k.ctx;
      const base = team === 0 ? 196 : 220; // G3 for blue, A3 for red
      const horn = k.voice(1, 0.6);
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.Q.value = 0.7;
      tone.frequency.setValueAtTime(2400, t);
      tone.frequency.exponentialRampToValueAtTime(800, t + 1.6);
      tone.connect(horn);
      k.note(tone, t, base, 0.22, { ratios: [0.5, 1], amps: [0.6, 1], decays: [1, 0.95], attack: 0.04, hold: 0.56, bend: 0.97, bendTime: 0.06, unison: 12, wave: 'horn' });
      k.note(tone, t + 0.12, base * 1.5, 0.22, { ratios: [1], amps: [0.42], decays: [0.9], attack: 0.04, hold: 0.44, unison: 10, wave: 'horn' });

      // Crowd: one source, three bands [start, swell, end centre (Hz), Q, peak, swell time (s)]; the
      // lower bands swell first, every band rises then settles ("oh" opening to "ah"). Exponential
      // swell from silence, held to 1.2 s, then a 2 s fade.
      const crowd = k.voice(1, 0.5);
      const src = ctx.createBufferSource();
      src.buffer = k.crowd;
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
      const boom = k.voice(0.9, 0.25, true);
      k.body(boom, t, 44, 0.5, { ratios: [1, 2.1], amps: [0.8, 0.65], decays: [0.6, 0.45], drop: 2, glide: 0.1, warm: true });
      k.noiseLayer(crowd, t, 0.45, { type: 'lowpass', freq: 700, sweepTo: 90, decay: 0.8 });
    },
  }),

  /**
   * Countdown tick (3-2-1, also a training timeout): a warm, rounded bell tone on A4 with its
   * octave A5 leading, held 60 ms and then ringing out with the upper harmonics dying first, a
   * short warm knock an octave below for body and a soft felt tick on the attack.
   */
  countdownTick: sound({
    play(k, t) {
      const v = k.voice(0.54, 0.12);
      k.note(v, t, 440, 0.14, { ratios: [1, 2, 3, 4, 5, 6], amps: [0.7, 1, 0.4, 0.3, 0.2, 0.22], decays: [0.2, 0.18, 0.13, 0.1, 0.08, 0.07], attack: 0.002, hold: 0.06 });
      k.body(v, t, 220, 0.25, { ratios: [1], amps: [1], decays: [0.16], drop: 1.1, glide: 0.015, warm: true });
      k.click(v, t, 2200, 0.05);
    },
  }),

  /**
   * Start signal (also a training save): a short pickup on the tick's A, then, 80 ms later, a
   * ringing A major chord a fifth higher on top (A5, C#6, E6 with soft harmonics, A6), rolled over
   * 10 ms and scooping up into pitch, over a warm A4, a soft A3 thump and a rush of air. The third
   * is pure (5:4), so once settled every partial sits on A3's harmonic series and nothing beats.
   */
  go: sound({
    play(k, t) {
      const t2 = t + 0.08;
      const v = k.voice(1.2, 0.25);
      // Pickup: the tick's A over its lower octave.
      k.click(v, t, 2400, 0.05);
      k.note(v, t, 880, 0.09, { ratios: [0.5, 1], amps: [0.5, 1], decays: [0.14, 0.12], attack: 0.003, hold: 0.035, wave: 'warm' });
      // The chord, rolled (root, then third and fifth, then the octave): richer, and a lower crest.
      k.click(v, t2, 2800, 0.05);
      k.note(v, t2, 880, 0.08, { ratios: [1], amps: [0.8], decays: [0.55], attack: 0.004, hold: 0.16, bend: 0.97, bendTime: 0.03, wave: 'warm' });
      k.note(v, t2 + 0.005, 880, 0.08, { ratios: [1.25, 1.5], amps: [0.45, 1], decays: [0.45, 0.6], attack: 0.004, hold: 0.155, bend: 0.97, bendTime: 0.03, wave: 'warm' });
      k.note(v, t2 + 0.01, 1760, 0.028, { ratios: [1], amps: [1], decays: [0.35], attack: 0.004, hold: 0.15, bend: 0.97, bendTime: 0.03 });
      // Body under it and a rush of low-mid air as it opens (kept under 1.4 kHz: no hiss).
      k.note(v, t2, 440, 0.08, { ratios: [1], amps: [1], decays: [0.45], attack: 0.004, hold: 0.12, wave: 'warm' });
      k.body(v, t2, 220, 0.07, { ratios: [1], amps: [1], decays: [0.2], drop: 1.25, glide: 0.03, warm: true });
      k.noiseLayer(v, t2, 0.11, { type: 'bandpass', freq: 400, q: 0.7, sweepTo: 1400, sweepTime: 0.12, sweepBack: 700, attack: 0.01, decay: 0.3 });
    },
  }),

  /**
   * MATCH FOUND (src/ui/screens/match/found.ts): the countdown's warm A rising to its E a fifth
   * up, 90 ms apart, short and bright (it may sound over the menus or a free practice).
   */
  matchFound: sound({
    play(k, t) {
      const v = k.voice(0.6, 0.12);
      k.click(v, t, 2200, 0.04);
      k.note(v, t, 880, 0.1, { ratios: [1, 2], amps: [1, 0.35], decays: [0.18, 0.12], attack: 0.003, hold: 0.05, wave: 'warm' });
      k.note(v, t + 0.09, 1320, 0.1, { ratios: [1, 2], amps: [1, 0.3], decays: [0.3, 0.16], attack: 0.003, hold: 0.08, wave: 'warm' });
    },
  }),

  /**
   * Boost pad pickup. Small: a light blip rising onto D6, a glassy FM sparkle (sidebands on the D5
   * series) fading into the tone, over a hollow D5 and a touch of warm D4; short and soft, since it
   * can repeat several times a second, and a hair of random pitch so a row of pads does not sound
   * stamped. Big: a power-up, a G major arpeggio (G5, B5, D6, each over its lower octave) on a
   * warm low note gliding up to G3 and a low-mid whoosh that opens and settles.
   */
  padPickup: sound({
    play(k, t, big: boolean) {
      if (big) {
        const v = k.voice(0.82, 0.1);
        k.noiseLayer(v, t, 0.12, { type: 'bandpass', freq: 300, q: 1, sweepTo: 1500, sweepTime: 0.12, sweepBack: 700, attack: 0.02, decay: 0.22 });
        k.body(v, t, 196, 0.04, { ratios: [1], amps: [1], decays: [0.22], drop: 0.75, glide: 0.08, warm: true });
        k.click(v, t, 2600, 0.03);
        k.note(v, t, 783.99, 0.025, { ratios: [0.5, 1, 2], amps: [0.8, 1, 0.45], decays: [0.14, 0.15, 0.08], attack: 0.002 });
        k.note(v, t + 0.045, 987.77, 0.025, { ratios: [0.5, 1, 2], amps: [0.8, 1, 0.45], decays: [0.14, 0.15, 0.08], attack: 0.002 });
        k.note(v, t + 0.09, 1174.66, 0.03, { ratios: [0.5, 1, 2, 3], amps: [0.8, 1, 0.45, 0.2], decays: [0.2, 0.24, 0.12, 0.08], attack: 0.002 });
      } else {
        const f = 1174.66 * (0.994 + Math.random() * 0.012);
        const v = k.voice(0.45, 0.1);
        k.fm(v, t, f, 0.06, { ratio: 1.5, index: 1.3, indexEnd: 0.55, indexDecay: 0.1, attack: 0.002, decay: 0.15, bend: 0.88, bendTime: 0.02 });
        k.note(v, t, f * 0.5, 0.065, { ratios: [1, 3], amps: [1, 0.3], decays: [0.15, 0.1], attack: 0.002, bend: 0.88, bendTime: 0.02 });
        k.note(v, t, f * 0.25, 0.035, { ratios: [1], amps: [1], decays: [0.12], attack: 0.002, wave: 'warm' });
        k.click(v, t, 2400, 0.025);
      }
    },
  }),

  /**
   * Boost ignition: a whump of flame that settles into the roar loop. Lowpassed noise opening
   * 180 → 1100 Hz in 50 ms and closing to 420 Hz over a warm body on the hum's harmonic series
   * (1-4 × `hum`, the frequency the boost layer's hum is at, so it blends), dropping into pitch.
   * (Played by Audio.update() on the boost's rising edge.)
   */
  boostStart: sound({
    minInterval: 0.05,
    play(k, t, hum: number) {
      const v = k.voice(1, 0.1);
      k.noiseLayer(v, t, 0.105, { type: 'lowpass', freq: 180, q: 1, sweepTo: 1100, sweepTime: 0.05, sweepBack: 420, attack: 0.004, decay: 0.3 });
      k.body(v, t, hum, 0.041, { ratios: [1, 2, 3, 4], amps: [0.4, 0.6, 0.55, 0.4], decays: [0.26, 0.22, 0.18, 0.15], drop: 1.6, glide: 0.06, warm: true });
    },
  }),

  /**
   * Boost release: a short low puff that flutters out. Lowpassed noise closing 1 kHz → 260 Hz and
   * a band at 340 Hz over a warm 110 Hz body with its fifth, decaying about as fast as the roar's
   * own fade (a faster puff hides under it), through a voice whose gain a 30 → 14 Hz flutter
   * swings, fading out with the puff. ~0.2 s. (Played by Audio.update() on the falling edge.)
   */
  boostStop: sound({
    play(k, t) {
      const v = k.voice(1, 0.06);
      k.noiseLayer(v, t, 0.072, { type: 'lowpass', freq: 1000, sweepTo: 260, attack: 0.003, decay: 0.22 });
      k.noiseLayer(v, t, 0.06, { type: 'bandpass', freq: 340, q: 1, attack: 0.003, decay: 0.2 });
      k.body(v, t, 110, 0.024, { ratios: [1, 1.5], amps: [0.7, 0.6], decays: [0.165, 0.155], drop: 1.25, glide: 0.04, warm: true });
      k.flutter(v, t, t + 0.223, 30, 14, 0.6);
    },
  }),
};

export type SoundName = keyof typeof SOUNDS;
/** The arguments a sound takes after the kit and the time (e.g. [strength: number]). */
export type SoundArgs<N extends SoundName> = (typeof SOUNDS)[N] extends SoundDef<infer A> ? A : never;

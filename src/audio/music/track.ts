/**
 * What a song is: plain data the music engine (engine.ts) plays with its fixed band of
 * instruments (kick, clap / snare, hats, bass, pad, lead, arp, fx). A track gives the tempo, the
 * harmony, the patterns and the arrangement for each game mode; the engine generates the lead
 * melody from the track's scale, motifs and cadences, one 8-bar phrase at a time.
 *
 * Bars are 16 steps (16ths). Notes are MIDI numbers (60 = middle C, 69 = A4); pitch classes are
 * 0-11 (0 = C, 2 = D, 9 = A). New tracks go in tracks/ and in the list in tracks/index.ts.
 */

/** What the game asks the music for (Audio.setMusic). */
export type MusicMode = 'off' | 'menu' | 'play' | 'tension';

export interface Chord {
  /** Bass root, MIDI (octave 1-2). */
  bass: number;
  /** Pad voicing, MIDI (around middle C), three notes. */
  pad: readonly number[];
  /** Chord tones for the lead and the arp, three pitch classes (root first: the cadences land on it). */
  pcs: readonly number[];
  /** A lead scale note altered over this chord, [from, to] pitch classes (e.g. C → C# over A major). */
  alter?: readonly [from: number, to: number];
}

export interface Section {
  bars: number;
  /** 0 none, 1 the broken groove (Track.brokenKick), 2 four on the floor. */
  kick: number;
  /** Claps on 2 and 4. */
  clap: boolean;
  /** 0 none, 1 off-beat eighths, 2 sixteenths with accents and open hats. */
  hats: number;
  /** 0 none, 1 one long note per bar, 2 the syncopated pattern (Track.bassPattern). */
  bass: number;
  /** Pad level, 0..1. */
  pad: number;
  /** Lead level, 0..1 (0: no lead). */
  lead: number;
  /** Arpeggio on 16ths over the chord (Track.arpOrder). */
  arp: boolean;
  /** Progression index into Track.progressions. */
  prog: number;
  /** Bars of noise riser at the end. */
  riser: number;
  /** A snare roll over the last bar. */
  roll: boolean;
  /** Crash (and a sub boom) on the first beat. */
  crash: boolean;
  /** Master low-pass target, Hz (20000: open). */
  cutoff: number;
}

/** A section with defaults for what `o` leaves out: 8 bars of pad only, filter open. */
export function section(o: Partial<Section>): Section {
  return { bars: 8, kick: 0, clap: false, hats: 0, bass: 0, pad: 1, lead: 0, arp: false, prog: 0, riser: 0, roll: false, crash: false, cutoff: 20000, ...o };
}

export interface Track {
  /** Stable id (the worklet and the render script pick a track by it). */
  id: string;
  title: string;
  bpm: number;
  /** Chord progressions, four chords each (one per bar), picked by Section.prog. */
  progressions: readonly (readonly Chord[])[];
  /** The notes the lead may use, MIDI, ascending (about an octave and a half). */
  leadScale: readonly number[];
  /** Rhythm motifs for the lead: [step, length in steps] pairs within one bar. */
  motifs: readonly (readonly number[])[];
  /** Like motifs, for the bar that ends a phrase: its last note lands on the chord's root. */
  cadences: readonly (readonly number[])[];
  /** Kick steps per bar for Section.kick = 1, four bars (bar % 4). */
  brokenKick: readonly (readonly number[])[];
  /** [step, semitones over the root, length in steps] triples for Section.bass = 2. */
  bassPattern: readonly number[];
  /** Arp: index into the chord tones (0-2, +3 per octave) for each of the 16 steps. */
  arpOrder: readonly number[];
  /** Lowest note the arp climbs from, MIDI. */
  arpFrom: number;
  /** The sections each mode loops through, in order. */
  forms: Readonly<Record<Exclude<MusicMode, 'off'>, readonly Section[]>>;
  /** The break after a goal (drums out, the filter closes, a riser), then `afterGoal[mode]`. */
  goal: Section;
  afterGoal: Readonly<Record<'play' | 'tension', Section>>;
}

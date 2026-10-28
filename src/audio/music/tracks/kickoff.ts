/**
 * Kickoff: electronic, 126 BPM, D minor (the relative of F major). The menu is an intro (pad,
 * bass, soft hats, a quiet lead now and then); a match loops groove 8 → lead 8 → break 4 → drop 8;
 * the last 30 s and overtime alternate two drop-like sections with the arp.
 */
import { section, type Chord, type Track } from '../track';

const DM: Chord = { bass: 38, pad: [62, 65, 69], pcs: [2, 5, 9] };
const BB: Chord = { bass: 34, pad: [62, 65, 70], pcs: [10, 2, 5] };
const F: Chord = { bass: 41, pad: [60, 65, 69], pcs: [5, 9, 0] };
const C: Chord = { bass: 36, pad: [60, 64, 67], pcs: [0, 4, 7] };
const GM: Chord = { bass: 43, pad: [62, 67, 70], pcs: [7, 10, 2] };
/** A major: the lead's C becomes C# over it (the leading tone back to D). */
const A: Chord = { bass: 33, pad: [61, 64, 69], pcs: [9, 1, 4], alter: [0, 1] };

const INTRO = section({ hats: 1, bass: 1, pad: 1, cutoff: 2200 });
const INTRO_LEAD = section({ hats: 1, bass: 1, pad: 1, lead: 0.6, cutoff: 2800 });
const GROOVE = section({ kick: 1, clap: true, hats: 1, bass: 2, pad: 0.6, crash: true });
const LEAD = section({ kick: 1, clap: true, hats: 2, bass: 2, pad: 0.6, lead: 1, roll: true });
const BREAK = section({ bars: 4, bass: 1, pad: 1, lead: 0.8, prog: 1, riser: 2, roll: true, cutoff: 2600 });
const DROP = section({ kick: 2, clap: true, hats: 2, bass: 2, pad: 0.8, lead: 1, arp: true, prog: 1, crash: true });
const TENSION_A = section({ kick: 2, clap: true, hats: 2, bass: 2, pad: 0.8, lead: 1, arp: true, prog: 2, crash: true, roll: true });
const TENSION_B = section({ kick: 2, clap: true, hats: 2, bass: 2, pad: 0.8, lead: 1, arp: true, prog: 1, crash: true, roll: true });

export const kickoff: Track = {
  id: 'kickoff',
  title: 'Kickoff',
  bpm: 126,
  // 0: the main loop; 1: the lift into the drops (A major leads back to D); 2: the tension's.
  progressions: [
    [DM, BB, F, C],
    [BB, C, DM, A],
    [GM, BB, C, A],
  ],
  // D natural minor A4..D6 (C# over the A chord comes from its `alter`).
  leadScale: [69, 70, 72, 74, 76, 77, 79, 81, 82, 84, 86],
  motifs: [
    [0, 2, 3, 2, 6, 2, 8, 1, 10, 2, 14, 2],
    [0, 3, 3, 3, 6, 4, 12, 2, 14, 2],
    [2, 2, 4, 2, 6, 2, 10, 3, 13, 3],
    [0, 1, 2, 1, 3, 2, 6, 2, 8, 4, 14, 2],
    [0, 3, 3, 3, 6, 2, 8, 3, 11, 5],
  ],
  cadences: [
    [0, 3, 3, 3, 6, 10],
    [0, 2, 2, 2, 4, 12],
    [0, 6, 6, 10],
  ],
  // 1, the "and" of 2, 3, plus a pickup on the fourth bar.
  brokenKick: [
    [0, 6, 10],
    [0, 6, 10],
    [0, 6, 10],
    [0, 6, 10, 14],
  ],
  // Syncopated, root-heavy, octave and fifth.
  bassPattern: [0, 0, 3, 3, 0, 2, 6, 12, 2, 8, 0, 3, 11, 0, 2, 14, 7, 2],
  // Chord tones climbing 1-2-3-4-2-3-4-5... from D4.
  arpOrder: [0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 5, 3, 4, 5, 6],
  arpFrom: 62,
  forms: {
    menu: [INTRO, INTRO, INTRO_LEAD, INTRO],
    play: [GROOVE, LEAD, BREAK, DROP],
    tension: [TENSION_A, TENSION_B],
  },
  goal: section({ bars: 2, bass: 1, pad: 1, prog: 1, riser: 1, cutoff: 500 }),
  afterGoal: { play: DROP, tension: TENSION_A },
};

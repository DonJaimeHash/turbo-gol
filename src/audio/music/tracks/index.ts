/**
 * The music tracks the game can play. To add one: write it in this folder (copy kickoff.ts as a
 * start) and list it here; DEFAULT_TRACK is the one the game plays.
 */
import type { Track } from '../track';
import { kickoff } from './kickoff';

export const TRACKS: readonly Track[] = [kickoff];

export const DEFAULT_TRACK: Track = kickoff;

/** The track with this id, or DEFAULT_TRACK. */
export function trackById(id: string | undefined): Track {
  return TRACKS.find((t) => t.id === id) ?? DEFAULT_TRACK;
}

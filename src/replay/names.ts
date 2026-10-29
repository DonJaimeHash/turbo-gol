/**
 * The replay pages' player names and notices: what the list (list.ts) and the player (player.ts,
 * main.ts) show, kept apart from the DOM so tests/replay-privacy.test.mjs runs them in node.
 */
import { t } from '../i18n';
import type { Key } from '../i18n';
import { hiddenNumber } from '../net/replays';
import { playerName } from '../ui/names';

/**
 * A human's name as the replay pages show it: an account that hides its name ('Jugador 3' on the
 * wire, src/net/replays.ts) and a guest ('Invitado 4821') in this page's language, any other name
 * as it is. A bot's name is its own (the caller adds the bot mark).
 */
export function replayName(raw: string): string {
  const n = hiddenNumber(raw);
  return n === null ? playerName(raw) : t('replay.hiddenName', { n });
}

/** A notice: its text, green or not, and when it goes (null: it stays: the replay may not be the match). */
export interface ReplayNoticeText {
  key: Key;
  params?: Record<string, string>;
  ok: boolean;
  hideMs: number | null;
}

/** How long the unverified and local-file notices stay: long enough to read, then out of the way. */
const NOTE_MS = 10_000;

/** Where the bytes the player plays came from. */
export type ReplaySource = { kind: 'server'; verified: boolean } | { kind: 'file' };

/**
 * The notice after the scan: the recording disagreeing with itself or another build first, then
 * whether anyone but the node checked it. The green 'Checked against the recording' only for a
 * match a verifier re-simulated (the index's `verified`, the view's x-replay-verified): without
 * one, the node wrote the inputs and the checkpoints alike, and they always agree. A local file
 * says it is one. Null: nothing to say (a replay with no checkpoint, say).
 */
export function replayNotice(o: { divergedAt: number; otherBuild: boolean; checked: number; endTick: number; source: ReplaySource; time: string }): ReplayNoticeText | null {
  if (o.divergedAt >= 0) return { key: 'replay.diverged', params: { time: o.time }, ok: false, hideMs: null };
  if (o.otherBuild) return { key: 'replay.buildWarning', ok: false, hideMs: null };
  if (o.source.kind === 'file') return { key: 'replay.localNotice', ok: false, hideMs: NOTE_MS };
  if (!o.source.verified) return { key: 'replay.unverifiedNotice', ok: false, hideMs: NOTE_MS };
  if (o.checked > 0 && o.endTick > 0) return { key: 'replay.checked', ok: true, hideMs: 4000 };
  return null;
}

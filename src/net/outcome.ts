/**
 * What a failed online step leaves the player to do (plan §6.13, PR 12): every failure a player can
 * hit maps to one of five outcomes, each with its one action (Menu.failure shows the text and it in
 * a sheet; a requeue, which needs nothing of the player, is a toast):
 *   retry    REINTENTAR             no answer, a server error, something unexpected
 *   wait     REINTENTA EN 1 MIN     too many tries, the servers full, matchmaking paused
 *   requeue  DE VUELTA EN LA COLA   the match never started (a no-show, a dodge): searching again
 *   reload   RECARGAR               this page is older than the server (426), the engine failed
 *   gone     CERRAR                 the thing is over or closed to this player (no lobby, kicked,
 *                                   full, the match ended): trying again would not help
 * The codes themselves (HTTP status, server code, close code) go to the console and F4's panel,
 * never into the text. Pure (tests/lobby-model.test.mjs).
 */
import type { Key } from '../i18n';

export type Outcome = 'retry' | 'wait' | 'requeue' | 'reload' | 'gone';

/** The server codes that say "wait" whatever their status. */
const WAIT_CODES = new Set(['rate_limited', 'throttled', 'capacity', 'matchmaking_off', 'do_disabled', 'no_show', 'ranked_ban', 'active_match']);
/** The codes that say "this page is stale". */
const RELOAD_CODES = new Set(['reload_required', 'p2p_protocol', 'bad_physics_build']);
/** The codes that say "over, or not for you". */
const GONE_CODES = new Set(['no_lobby', 'closed', 'kicked', 'full', 'match_over', 'match_reset', 'left', 'no_match', 'p2p_room', 'account_required', 'guests_present', 'experimental_p2p_only']);

/** A failure as the clients describe it: NetError (code / status / serverCode) or AccountError (code / status). */
export interface FailureLike {
  /** NetError.code ('network', 'http', 'protocol', 'turnstile'...) or a lobby code. */
  readonly code?: string;
  readonly status?: number;
  /** NetError.serverCode. */
  readonly serverCode?: string;
}

/** The outcome of failure `f`. Pure. */
export function outcomeOf(f: FailureLike | null | undefined): Outcome {
  if (f === null || f === undefined) return 'retry';
  const server = f.serverCode !== undefined && f.serverCode !== '' ? f.serverCode : (f.code ?? '');
  const status = f.status ?? 0;
  if (RELOAD_CODES.has(server) || status === 426 || f.code === 'protocol') return 'reload';
  if (server === 'cancelled_match') return 'requeue';
  if (GONE_CODES.has(server)) return 'gone';
  if (WAIT_CODES.has(server) || status === 429 || status === 503) return 'wait';
  return 'retry';
}

/** The action's label of outcome `o`. */
export const OUTCOME_ACTION: Record<Outcome, Key> = {
  retry: 'outcome.retry',
  wait: 'outcome.wait',
  requeue: 'outcome.requeue',
  reload: 'outcome.reload',
  gone: 'outcome.close',
};

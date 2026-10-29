/**
 * The replay pages' player names: what the list (list.ts) and the player (player.ts) show, kept
 * apart from the DOM so tests/replay-privacy.test.mjs runs them in node.
 */
import { t } from '../i18n';
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

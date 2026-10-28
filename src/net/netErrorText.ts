/**
 * The player's line for a failed matchmaking request (NetClient's NetError), shared by
 * OnlineSession and P2PSession: the anti-bot check by its status, a server error code by its
 * error.queue.* text (serverText, src/i18n.ts; {time} = what is left of the server's retryAfterMs),
 * else a generic text for the kind of failure. The NetError's own message is developer text for
 * the logs and is never shown; so is the server's message for a code without an error.queue.* text
 * (the queue routes write those in English for developers: bad_mode, p2p_room, left...).
 */
import type { NetError } from './NetClient';
import { duration, hasServerText, serverText, t } from '../i18n';

export function netErrorText(err: NetError): string {
  // 503 turnstile_unconfigured; 403 turnstile_failed or a widget that failed in the page (status 0).
  if (err.code === 'turnstile') return t(err.status === 503 ? 'error.queue.turnstile_unconfigured' : 'error.queue.turnstile_failed');
  if (err.serverCode.length > 0 && hasServerText('queue', err.serverCode)) {
    const message = err.serverMessage !== err.serverCode ? err.serverMessage : '';
    return serverText('queue', err.serverCode, message, { time: duration(err.retryAfterMs) });
  }
  switch (err.code) {
    case 'network':
      return t('error.network');
    case 'http':
      return t('error.server'); // the status is in err.message (the console's)
    case 'protocol':
      return t('error.protocol');
    default:
      return t('error.unexpected');
  }
}

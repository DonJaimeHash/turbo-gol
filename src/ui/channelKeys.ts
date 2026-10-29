/**
 * A TV remote's CH+ / CH− and a keyboard's PgUp / PgDn: the pad's LT / RT in the menus and in
 * Ajustes over the pause (a screen's own tabs step; Menu.onKey, screens/settings/overlay.ts). Remotes
 * send them in several ways: `code` PageUp / PageDown (most TV browsers), `key` PageUp / PageDown
 * with an empty `code` (others), `key` ChannelUp / ChannelDown, Tizen's XF86RaiseChannel /
 * XF86LowerChannel, or nothing but Tizen's keyCode 427 / 428. Pure (tests/channel-keys.test.mjs).
 */

const UP: ReadonlySet<string> = new Set(['PageUp', 'ChannelUp', 'XF86RaiseChannel']);
const DOWN: ReadonlySet<string> = new Set(['PageDown', 'ChannelDown', 'XF86LowerChannel']);

/** -1 for CH+ / PgUp (the tab before), 1 for CH− / PgDn (the tab after), 0 for any other key. */
export function channelStep(e: Pick<KeyboardEvent, 'key' | 'code' | 'keyCode'>): -1 | 0 | 1 {
  if (UP.has(e.key) || e.code === 'PageUp' || e.keyCode === 427) return -1;
  if (DOWN.has(e.key) || e.code === 'PageDown' || e.keyCode === 428) return 1;
  return 0;
}

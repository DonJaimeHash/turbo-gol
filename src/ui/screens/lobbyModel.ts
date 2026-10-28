/**
 * The Salas' decisions, pure (no DOM, no texts: tests/lobby-model.test.mjs): the code as players
 * see and type it (the server's alphabet, "ABC 234"), the join link (`#sala=ABC234`) and its
 * parsing, the format a new lobby takes, a list row's state, the code cells' editing, and how a
 * device shares. src/ui/screens/lobby.ts, custom.ts and components/codecells.ts put them on the page.
 */
import { PLAYLISTS } from '../../net/account';
import type { LobbySummary, Playlist } from '../../net/account';
import type { MenuPrefs } from '../prefs';

/** LobbyDirectoryDO's code alphabet (server/src/LobbyDirectoryDO.ts CODE_ALPHABET: no I, O, 0 or 1) and length. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
/** The hash key of a join link: https://turbo-gol.com/#sala=ABC234. */
export const LINK_KEY = 'sala';

/** Typed or pasted text -> the code's characters so far: capitals, the alphabet only, at most CODE_LENGTH. */
export function cleanCode(text: string): string {
  let out = '';
  for (const ch of text.toUpperCase()) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
    if (out.length === CODE_LENGTH) break;
  }
  return out;
}

/** A full code, or null. */
export function fullCode(text: string): string | null {
  const c = cleanCode(text);
  return c.length === CODE_LENGTH ? c : null;
}

/** "ABC234" -> "ABC 234" (the giant code, the pill keeps it whole). */
export function spacedCode(code: string): string {
  return code.length === CODE_LENGTH ? code.slice(0, 3) + ' ' + code.slice(3) : code;
}

/**
 * The remote's ▲ ▼ on code cell `at` (0-based) of `value`: the next / previous character of the
 * alphabet there (round); on the cell after the last one typed, a new one starts at the alphabet's
 * first (▲) or last (▼). Returns the new value. Pure.
 */
export function cycleCell(value: string, at: number, d: -1 | 1): string {
  const v = cleanCode(value);
  const i = Math.max(0, Math.min(at, v.length, CODE_LENGTH - 1));
  const n = CODE_ALPHABET.length;
  const cur = i < v.length ? CODE_ALPHABET.indexOf(v[i]) : -1;
  const next = cur < 0 ? (d > 0 ? 0 : n - 1) : (cur + d + n) % n;
  return v.slice(0, i) + CODE_ALPHABET[next] + v.slice(i + 1);
}

/** The join link of `code` on `origin` ('https://turbo-gol.com'). */
export function joinLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/#${LINK_KEY}=${code}`;
}

/** The link without its scheme, as a TV writes it big ("turbo-gol.com/#sala=ABC234"). */
export function shortLink(link: string): string {
  return link.replace(/^[a-z]+:\/\//i, '');
}

/** The hash has a join link's key (`#sala=…`), whether or not its code parses. */
export function hasLink(hash: string): boolean {
  return hash
    .replace(/^#/, '')
    .split('&')
    .some((p) => p.split('=')[0] === LINK_KEY);
}

/**
 * The code a hash carries (`#sala=abc-234`, among other flags: `#tv&sala=ABC234`), or null; a
 * broken escape (a link a chat app cut short: `#sala=AB%E0`) is no code, never a throw.
 */
export function linkCode(hash: string): string | null {
  for (const part of hash.replace(/^#/, '').split('&')) {
    const [k, v] = part.split('=');
    if (k !== LINK_KEY || v === undefined) continue;
    try {
      return fullCode(decodeURIComponent(v));
    } catch {
      return null;
    }
  }
  return null;
}

/** `hash` without its join link (the other flags stay): '' when nothing is left. */
export function withoutLink(hash: string): string {
  const rest = hash
    .replace(/^#/, '')
    .split('&')
    .filter((p) => p !== '' && p.split('=')[0] !== LINK_KEY);
  return rest.length > 0 ? '#' + rest.join('&') : '';
}

/**
 * The format CREATE LOBBY AND SHARE gives a new lobby: the last one a lobby of this player had
 * (MenuPrefs.lobbyMode), else Casual's when it picked one format, else 2v2. Pure.
 */
export function lobbyFormat(p: Pick<MenuPrefs, 'lobbyMode' | 'casualModes'>): Playlist {
  if (p.lobbyMode !== null) return p.lobbyMode;
  return p.casualModes.length === 1 && PLAYLISTS.includes(p.casualModes[0]) ? p.casualModes[0] : '2v2';
}

export type RowState = 'open' | 'inMatch' | 'full';

/** A list row's state slot: EN PARTIDO first (it says when it can be joined), then LLENA, else ABIERTA. */
export function rowState(l: Pick<LobbySummary, 'inGame' | 'players' | 'max'>): RowState {
  if (l.inGame) return 'inMatch';
  return l.players >= l.max ? 'full' : 'open';
}

export type ShareWay = 'share' | 'copy' | 'qr';

/**
 * How COMPARTIR shares (plan §6.4): a TV draws the QR (no share sheet there), a touch phone or
 * tablet with navigator.share opens the system's share sheet, anything else copies the link. Pure.
 */
export function shareWay(d: { tv: boolean; touch: boolean; canShare: boolean }): ShareWay {
  if (d.tv) return 'qr';
  return d.touch && d.canShare ? 'share' : 'copy';
}

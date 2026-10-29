/**
 * A guest's name is the server's, never the player's: 'Invitado 4821', the number from the first 32
 * bits of the 16-hex player id, so every holder of the session (the Worker's POST /api/guest and
 * verifySession, which has no storage, the Durable Objects, the browser) derives the same one, and
 * it needs no secret. A new guest session is a new player id, so a new number.
 *
 * It travels as that exact string (rosters, tickets and replays carry `name: string`); each client
 * shows it in its own language (src/ui/names.ts playerName: 'Guest 4821'). Nothing else can produce
 * it: usernames have no space and cannot start with 'invitado' (src/net/account.ts usernameIssue),
 * guests choose no name, lobby titles refuse it (lobbyNameIssue).
 *
 * Imports nothing: shared by the Worker (server/src/index.ts, auth.ts, LobbyDO.ts) and the client.
 */

/** The wire form of a guest's name; the number is 1000-9999. */
export const GUEST_NAME_RE = /^Invitado ([1-9]\d{3})$/;

/** 'Invitado 4821': 1000-9999 from the first 32 bits of the 16-hex player id (deterministic). */
export function guestNameOf(playerId: string): string {
  const n = parseInt(playerId.slice(0, 8), 16);
  return `Invitado ${1000 + ((Number.isFinite(n) ? n : 0) % 9000)}`;
}

/** The number of a guest's wire name ('4821'), null for any other name. */
export function guestNumber(name: string): string | null {
  const m = GUEST_NAME_RE.exec(name);
  return m === null ? null : m[1];
}

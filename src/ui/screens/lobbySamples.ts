/**
 * The Salas' samples for the layout check (scripts/ui-fit.mjs, plan PR 12): window.__sala, in
 * development and in a VITE_UI_FIT=1 build only (the Game installs it; lobby.ts stays free of
 * import.meta for the node tests that import custom.ts).
 */
import { t } from '../../i18n';
import type { LobbyMember } from '../../net/account';
import { DEFAULT_MATCH_SECONDS } from '../../game/Match';
import type { Menu } from '../Menu';
import { joinSheet, openCodeEntry, openQr } from './lobby';
import { openLostSheet } from './match/lost';

const UI_FIT = import.meta.env.DEV || import.meta.env.VITE_UI_FIT === '1';

export type SalaSample = 'members' | 'reconnecting' | 'qr' | 'codecells' | 'join' | 'pill' | 'lost';

/**
 * window.__sala(kind | null, members?): the Salas' states with sample data for the layout check
 * (scripts/ui-fit.mjs), set on the LobbyClient's own fields (no server): the Sala with 1 to 6
 * members (long names, every tag, a guest's server name read in the page's language: 'Guest 4821'; 5 and 6 a
 * 3v3), the title the server's default (the host's name), reconnecting, a TV's QR sheet, the code entry with four cells
 * typed, a join link's sheet as long as it gets (the swap line), the lobby pill on
 * Inicio, the lost connection's sheet. null puts it all back. Nothing in a release build.
 */
export function installSalaSamples(menu: Menu): void {
  if (!UI_FIT) return;
  const lobby = menu.host.lobby;
  // The third is a guest: its wire name, the server's (src/net/guestName.ts).
  const names = ['Constantinopla_9', 'Ana', 'Invitado 4821', 'Leo', 'MaximilianoGomez', 'Bea'];
  const sample = (n: number, reconnecting = false): void => {
    const members: LobbyMember[] = names.slice(0, Math.max(1, Math.min(6, n))).map((name, i) => ({ id: 'm' + (i + 1), name, team: (i % 2) as 0 | 1, host: i === 0, guest: i === 2, inGame: false, away: i === 3, ready: i === 1 }));
    lobby.state = {
      code: 'ABC234',
      settings: { name: names[0], mode: n > 4 ? '3v3' : '2v2', visibility: 'private', net: 'p2p', matchLengthSeconds: DEFAULT_MATCH_SECONDS, physics: null },
      hasPassword: n === 6,
      region: 'SA',
      members,
      you: 'm1',
      status: 'open',
    };
    lobby.code = 'ABC234';
    lobby.status = reconnecting ? 'reconnecting' : 'open';
  };
  (window as unknown as { __sala: (kind: SalaSample | null, n?: number) => void }).__sala = (kind, n = 4) => {
    if (menu.modalOpen) menu.back(); // the last sample's sheet
    switch (kind) {
      case null:
        lobby.state = null;
        lobby.code = null;
        lobby.status = 'idle';
        menu.open('home', true);
        return;
      case 'members':
      case 'reconnecting':
        sample(n, kind === 'reconnecting');
        menu.open('lobby', true);
        return;
      case 'qr':
        sample(n);
        menu.open('lobby', true);
        openQr(menu, 'ABC234');
        return;
      case 'codecells': {
        menu.open('modes', true, 'lobbies');
        openCodeEntry(menu);
        const input = document.querySelector<HTMLInputElement>('.mn-codecells-input');
        if (input !== null) {
          input.value = 'ABC2';
          input.dispatchEvent(new Event('focus'));
        }
        return;
      }
      case 'join':
        sample(n);
        menu.open('home', true);
        joinSheet(menu, 'XYZ789', t('lobby.joinAsk', { code: 'XYZ789', mode: '3v3', count: 5, max: 6 }), false);
        return;
      case 'pill':
        sample(n);
        menu.open('home', true);
        return;
      case 'lost':
        menu.open('home', true);
        openLostSheet(menu, true);
        return;
    }
  };
}

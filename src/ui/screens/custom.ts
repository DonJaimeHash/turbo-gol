/**
 * Custom matches: the public lobby browser (a list per region: name, playlist, players, host,
 * lock), joining by code (private lobbies), creating a lobby, and
 * the lobby itself: the code to share, the two teams, the host's settings, kick and start. When the
 * host starts, every member gets its match through the lobby socket (LobbyClient.onMatch) and the
 * Game plays it; back in the menu the member reports `back` and the lobby opens again.
 */
import { h, setChildren, copyText, navButton } from '../dom';
import { LOBBY_LENGTHS, PLAYLISTS, PLAYLIST_NAMES } from '../../net/account';
import type { LobbyMember, LobbySettings, LobbyState, LobbySummary, Playlist } from '../../net/account';
import { AccountError } from '../../net/AccountClient';
import { lobbyCloseText } from '../../net/LobbyClient';
import { MODES } from '../../sim/constants';
import type { Menu, Screen } from '../Menu';
import { cycler, field, primary, screenHead, secondary, section } from './common';

const REFRESH_MS = 5_000;

function lengthLabel(s: number): string {
  return s === 0 ? 'Sin límite' : `${s / 60} min`;
}

function netLabel(n: 'p2p' | 'server'): string {
  return n === 'p2p' ? 'P2P' : 'Servidor';
}

function errText(e: unknown): string {
  return e instanceof AccountError ? e.message : e instanceof Error ? e.message : String(e);
}

/** Join a lobby (asking for the password when it is locked) and open the lobby screen. */
async function joinFlow(menu: Menu, code: string, locked: boolean): Promise<void> {
  const lobby = menu.host.lobby;
  const attempt = async (pw: string | null): Promise<boolean> => {
    try {
      await lobby.join(code, pw);
      menu.open('lobby');
      return true;
    } catch (e) {
      if (e instanceof AccountError && e.code === 'bad_password') {
        menu.toast('Contraseña incorrecta', 'error');
        return false;
      }
      menu.toast(errText(e), 'error');
      return true;
    }
  };
  if (!locked) {
    await attempt(null);
    return;
  }
  const pw = field('Contraseña de la sala', { type: 'password', maxLength: 32, autocomplete: 'off' });
  pw.input.setAttribute('data-autofocus', '');
  const close = menu.modal({
    title: `Sala ${code}`,
    body: [h('p', null, 'Esta sala tiene contraseña.'), pw.el],
    actions: [
      { label: 'UNIRSE', primary: true, onClick: () => attempt(pw.input.value) },
      { label: 'CANCELAR', onClick: () => true },
    ],
  });
  pw.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void attempt(pw.input.value).then((ok) => ok && close());
  });
}

export function customScreen(menu: Menu): Screen {
  const list = h('div.mn-lobbies');
  const status = h('div.mn-lobbies-status');
  const code = field('Código', { placeholder: 'ABC234', maxLength: 7 });
  code.input.classList.add('mn-code-input');
  const join = (): void => {
    const c = code.input.value.trim();
    if (c.length < 6) {
      code.error('El código tiene 6 letras o números');
      return;
    }
    code.error(null);
    void joinFlow(menu, c, false).catch(() => undefined);
  };
  code.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join();
  });
  let refreshAt = 0;
  let loading = false;
  const row = (l: LobbySummary): HTMLElement =>
    navButton('mn-lobby-row', [
      h('span.mn-lobby-name', null, l.locked ? '🔒 ' : '', l.name),
      h('span.mn-lobby-mode', null, `${PLAYLIST_NAMES[l.mode]} ${l.mode}`),
      h('span.mn-lobby-players', null, `${l.players}/${l.max}`),
      h('span.mn-lobby-host', null, l.host),
      h('span.mn-lobby-net', null, netLabel(l.net)),
      h('span.mn-lobby-state', null, l.inGame ? 'En juego' : l.players >= l.max ? 'Llena' : 'Abierta'),
    ], () => void joinFlow(menu, l.code, l.locked), { 'data-code': l.code, disabled: l.players >= l.max });
  const load = async (): Promise<void> => {
    if (loading) return;
    loading = true;
    try {
      const lobbies = await menu.host.lobby.list(menu.prefs.region);
      const focusedCode = (document.activeElement as HTMLElement | null)?.getAttribute?.('data-code') ?? null;
      setChildren(list, ...(lobbies.length > 0 ? lobbies.map(row) : [h('div.mn-empty', null, `No hay salas públicas en ${menu.regionLabel}. ¡Creá una!`)]));
      status.textContent = `${lobbies.length} salas · ${menu.regionLabel}`;
      if (focusedCode) (list.querySelector(`[data-code="${focusedCode}"]`) as HTMLElement | null)?.focus();
    } catch (e) {
      status.textContent = errText(e);
    } finally {
      loading = false;
    }
  };
  const el = h(
    'div.mn-custom',
    null,
    screenHead('PARTIDAS PERSONALIZADAS', 'Salas públicas de tu región o privadas por código. No suman ni restan rango.'),
    h(
      'div.mn-custom-bar',
      null,
      primary('CREAR SALA', () => menu.open('lobby-create'), { 'data-autofocus': true }),
      h('div.mn-join', null, code.el, secondary('UNIRSE', join)),
      secondary('ACTUALIZAR', () => void load()),
    ),
    h('div.mn-lobby-head', null, h('span', null, 'Nombre'), h('span', null, 'Modo'), h('span', null, 'Jugadores'), h('span', null, 'Anfitrión'), h('span', null, 'Red'), h('span', null, 'Estado')),
    list,
    status,
  );
  return {
    id: 'custom',
    title: 'Personalizadas',
    el,
    show: () => {
      refreshAt = 0;
      setChildren(list, h('div.mn-empty', null, 'Cargando salas…'));
    },
    tick: (now) => {
      if (now < refreshAt) return;
      refreshAt = now + REFRESH_MS;
      void load();
    },
  };
}

/** The settings controls shared by "create" and the host's "configure" dialog. */
function settingsControls(s: LobbySettings): HTMLElement[] {
  return [
    cycler<Playlist>('Modo', PLAYLISTS.map((p) => ({ value: p, label: `${PLAYLIST_NAMES[p]} (${p})` })), () => s.mode, (v) => (s.mode = v)).el,
    cycler<'public' | 'private'>('Visibilidad', [{ value: 'public', label: 'Pública (en la lista)' }, { value: 'private', label: 'Privada (solo con código)' }], () => s.visibility, (v) => (s.visibility = v)).el,
    cycler<'p2p' | 'server'>('Conexión', [{ value: 'p2p', label: 'P2P (recomendada)' }, { value: 'server', label: 'Servidor' }], () => s.net, (v) => (s.net = v)).el,
    cycler<number>('Duración', LOBBY_LENGTHS.map((l) => ({ value: l, label: lengthLabel(l) })), () => s.matchLengthSeconds, (v) => (s.matchLengthSeconds = v)).el,
  ];
}

export function lobbyCreateScreen(menu: Menu): Screen {
  const s: LobbySettings = { name: '', mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: 300 };
  const name = field('Nombre de la sala', { maxLength: 24 });
  const pw = field('Contraseña (opcional)', { type: 'password', maxLength: 32, placeholder: 'Sin contraseña' });
  const controls = h('div');
  const create = primary('CREAR', async () => {
    const n = name.input.value.trim();
    if (n.length < 3) {
      name.error('Entre 3 y 24 caracteres');
      return;
    }
    name.error(null);
    s.name = n;
    create.disabled = true;
    try {
      await menu.host.lobby.create({ settings: { ...s }, password: pw.input.value.length > 0 ? pw.input.value : null, region: menu.prefs.region });
      menu.replace('lobby');
    } catch (e) {
      menu.toast(errText(e), 'error');
    } finally {
      create.disabled = false;
    }
  });
  const el = h('div.mn-queue', null, screenHead('CREAR SALA', 'Vos sos el anfitrión: elegís equipos, modo y cuándo empieza. Los lugares libres los ocupan bots.'), section('SALA', name.el, controls, pw.el), h('div.mn-actions', null, create));
  return {
    id: 'lobby-create',
    title: 'Crear sala',
    el,
    show: () => {
      const who = menu.host.accounts.account?.name ?? menu.host.guestName();
      if (name.input.value.length === 0) name.input.value = `Sala de ${who}`.slice(0, 24);
      setChildren(controls, ...settingsControls(s));
    },
  };
}

export function lobbyScreen(menu: Menu): Screen {
  const lobby = menu.host.lobby;
  const codeEl = h('div.mn-lobby-code');
  const info = h('div.mn-lobby-info');
  const teams = h('div.mn-teams');
  const actions = h('div.mn-actions');
  const statusLine = h('div.mn-lobby-status');
  const el = h('div.mn-lobby', null, h('div.mn-lobby-top', null, h('div', null, h('div.mn-lobby-title'), info), codeEl), statusLine, teams, actions);
  let shown = false;

  const memberRow = (m: LobbyMember, s: LobbyState): HTMLElement => {
    const meHost = s.members.find((x) => x.id === s.you)?.host === true;
    return h(
      `div.mn-member${m.id === s.you ? '.mn-member-you' : ''}` as 'div',
      null,
      h('span.mn-member-name', null, m.host ? '♛ ' : '', m.name),
      m.guest ? h('span.mn-tag', null, 'INVITADO') : null,
      m.inGame ? h('span.mn-tag.mn-tag-live', null, 'EN PARTIDA') : null,
      meHost && m.id !== s.you ? navButton('mn-kick', 'Sacar', () => lobby.kick(m.id)) : null,
    );
  };

  const configure = (s: LobbyState): void => {
    const draft: LobbySettings = { ...s.settings };
    const name = field('Nombre de la sala', { maxLength: 24, value: draft.name });
    const pw = field(s.hasPassword ? 'Nueva contraseña (vacío = sin contraseña)' : 'Contraseña (opcional)', { type: 'password', maxLength: 32 });
    menu.modal({
      title: 'Configurar sala',
      body: [name.el, ...settingsControls(draft), pw.el],
      actions: [
        {
          label: 'GUARDAR',
          primary: true,
          onClick: () => {
            const n = name.input.value.trim();
            if (n.length < 3) {
              name.error('Entre 3 y 24 caracteres');
              return false;
            }
            draft.name = n;
            lobby.updateSettings(draft, pw.input.value.length > 0 ? pw.input.value : s.hasPassword ? null : undefined);
            return true;
          },
        },
        { label: 'CANCELAR', onClick: () => true },
      ],
    });
  };

  const render = (): void => {
    const s = lobby.state;
    if (!s) {
      setChildren(teams, h('div.mn-empty', null, lobby.status === 'connecting' ? 'Entrando a la sala…' : 'No estás en ninguna sala'));
      setChildren(actions, secondary('VOLVER', () => menu.open('custom')));
      return;
    }
    (el.querySelector('.mn-lobby-title') as HTMLElement).textContent = s.settings.name;
    info.textContent = `${PLAYLIST_NAMES[s.settings.mode]} ${s.settings.mode} · ${netLabel(s.settings.net)} · ${lengthLabel(s.settings.matchLengthSeconds)} · ${s.settings.visibility === 'public' ? 'Pública' : 'Privada'}${s.hasPassword ? ' · 🔒' : ''}`;
    setChildren(codeEl, h('span.mn-lobby-code-label', null, 'CÓDIGO'), h('span.mn-lobby-code-value', null, s.code), navButton('mn-btn mn-btn-small', 'COPIAR', () => void copyText(s.code).then((ok) => menu.toast(ok ? 'Código copiado' : 'No se pudo copiar', ok ? 'ok' : 'error'))));
    const per = MODES[s.settings.mode];
    const col = (team: 0 | 1): HTMLElement => {
      const ms = s.members.filter((m) => m.team === team);
      const slots: HTMLElement[] = ms.map((m) => memberRow(m, s));
      for (let i = ms.length; i < per; i++) slots.push(h('div.mn-member.mn-member-bot', null, h('span.mn-member-name', null, 'Bot (lugar libre)')));
      return h(`div.mn-team.mn-team-${team === 0 ? 'blue' : 'red'}` as 'div', null, h('div.mn-team-title', null, team === 0 ? 'AZUL' : 'ROJO'), ...slots);
    };
    setChildren(teams, col(0), col(1));
    const me = s.members.find((m) => m.id === s.you);
    const isHost = me?.host === true;
    statusLine.textContent =
      s.status === 'in_game' ? 'Partida en curso: la sala se abre cuando vuelvan todos' : s.status === 'starting' ? 'Iniciando partida…' : isHost ? 'Sos el anfitrión. Cuando estén todos, iniciá la partida.' : 'Esperando que el anfitrión inicie la partida…';
    const other = me ? (me.team === 0 ? 1 : 0) : 0;
    const otherFull = s.members.filter((m) => m.team === other).length >= per;
    const focused = (document.activeElement as HTMLElement | null)?.textContent ?? '';
    setChildren(
      actions,
      isHost ? primary('INICIAR PARTIDA', () => lobby.start(), { disabled: s.status !== 'open' }) : null,
      secondary(otherFull ? 'EL OTRO EQUIPO ESTÁ LLENO' : 'CAMBIAR DE EQUIPO', () => lobby.setTeam(other), { disabled: otherFull || s.status !== 'open' }),
      isHost ? secondary('CONFIGURAR', () => configure(s), { disabled: s.status !== 'open' }) : null,
      secondary('SALIR DE LA SALA', () => {
        lobby.leave();
        menu.open('custom');
      }),
    );
    // Keep the controller's place across re-renders.
    const again = Array.from(el.querySelectorAll<HTMLElement>('[data-nav]')).find((b) => b.textContent === focused);
    if (again) again.focus({ preventScroll: true });
    else menu.refocus();
  };

  lobby.onState = () => {
    if (shown) render();
  };
  lobby.onMatch = (r) => menu.host.playLobbyMatch(r);
  lobby.onError = (_code, message) => menu.toast(message, 'error');
  lobby.onClosed = (reason) => {
    menu.toast(lobbyCloseText(reason), reason === 'kicked' ? 'error' : 'info');
    if (menu.top()?.id === 'lobby') menu.open('custom');
  };

  return {
    id: 'lobby',
    title: 'Sala',
    el,
    show: () => {
      shown = true;
      if (lobby.me?.inGame) lobby.back(); // back from the lobby's match
      render();
    },
    hide: () => {
      shown = false;
    },
    back: () => {
      if (!lobby.inLobby) return false;
      menu.modal({
        title: '¿Salir de la sala?',
        body: h('p', null, lobby.isHost ? 'Sos el anfitrión: la sala pasa al jugador que más tiempo lleva.' : 'Podés volver a entrar con el código mientras la sala exista.'),
        actions: [
          {
            label: 'SALIR',
            primary: true,
            onClick: () => {
              lobby.leave();
              menu.open('custom');
            },
          },
          { label: 'QUEDARME', onClick: () => true },
        ],
      });
      return true;
    },
  };
}

/**
 * Custom matches: the public lobby browser (a list per region: name, playlist, players, host,
 * lock), joining by code (private lobbies), creating a lobby, and
 * the lobby itself: the code to share, the two teams, the host's settings, kick and start. When the
 * host starts, every member gets its match through the lobby socket (LobbyClient.onMatch) and the
 * Game plays it; back in the menu the member reports `back` and the lobby opens again.
 */
import { h, setChildren, copyText, navButton } from '../dom';
import { LOBBY_LENGTHS, PLAYLISTS } from '../../net/account';
import type { LobbyMember, LobbySettings, LobbyState, LobbySummary, Playlist } from '../../net/account';
import { AccountError } from '../../net/AccountClient';
import { lobbyCloseText } from '../../net/LobbyClient';
import { MODES } from '../../sim/constants';
import { t } from '../../i18n';
import { playlistName } from '../names';
import type { Menu, Screen } from '../Menu';
import { cycler, field, primary, screenHead, secondary, section } from './common';

const REFRESH_MS = 5_000;

function lengthLabel(s: number): string {
  return s === 0 ? t('custom.noLimit') : t('custom.minutes', { count: s / 60 });
}

function netLabel(n: 'p2p' | 'server'): string {
  return n === 'p2p' ? t('custom.netP2p') : t('custom.netServer');
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
        menu.toast(t('custom.wrongPassword'), 'error');
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
  const pw = field(t('custom.joinPassword'), { type: 'password', maxLength: 32, autocomplete: 'off' });
  pw.input.setAttribute('data-autofocus', '');
  const close = menu.modal({
    title: t('custom.joinTitle', { code }),
    body: [h('p', null, t('custom.joinLocked')), pw.el],
    actions: [
      { label: t('custom.join'), primary: true, onClick: () => attempt(pw.input.value) },
      { label: t('custom.cancel'), onClick: () => true },
    ],
  });
  pw.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void attempt(pw.input.value).then((ok) => ok && close());
  });
}

export function customScreen(menu: Menu): Screen {
  const list = h('div.mn-lobbies');
  const status = h('div.mn-lobbies-status');
  const code = field(t('custom.codeField'), { placeholder: 'ABC234', maxLength: 7 });
  code.input.classList.add('mn-code-input');
  const join = (): void => {
    const c = code.input.value.trim();
    if (c.length < 6) {
      code.error(t('custom.codeInvalid'));
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
      h('span.mn-lobby-mode', null, `${playlistName(l.mode)} ${l.mode}`),
      h('span.mn-lobby-players', null, `${l.players}/${l.max}`),
      h('span.mn-lobby-host', null, l.host),
      h('span.mn-lobby-net', null, netLabel(l.net)),
      h('span.mn-lobby-state', null, l.inGame ? t('custom.rowInGame') : l.players >= l.max ? t('custom.rowFull') : t('custom.rowOpen')),
    ], () => void joinFlow(menu, l.code, l.locked), { 'data-code': l.code, disabled: l.players >= l.max });
  const load = async (): Promise<void> => {
    if (loading) return;
    loading = true;
    try {
      const lobbies = await menu.host.lobby.list(menu.prefs.region);
      const focusedCode = (document.activeElement as HTMLElement | null)?.getAttribute?.('data-code') ?? null;
      setChildren(list, ...(lobbies.length > 0 ? lobbies.map(row) : [h('div.mn-empty', null, t('custom.noLobbies', { region: menu.regionLabel }))]));
      status.textContent = t('custom.lobbyCount', { count: lobbies.length, region: menu.regionLabel });
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
    screenHead(t('custom.heading'), t('custom.subtitle')),
    h(
      'div.mn-custom-bar',
      null,
      primary(t('custom.createLobby'), () => menu.open('lobby-create'), { 'data-autofocus': true }),
      h('div.mn-join', null, code.el, secondary(t('custom.join'), join)),
      secondary(t('custom.refresh'), () => void load()),
    ),
    h(
      'div.mn-lobby-head',
      null,
      h('span', null, t('custom.colName')),
      h('span', null, t('custom.colMode')),
      h('span', null, t('custom.colPlayers')),
      h('span', null, t('custom.colHost')),
      h('span', null, t('custom.colNet')),
      h('span', null, t('custom.colState')),
    ),
    list,
    status,
  );
  return {
    id: 'custom',
    title: t('custom.screenTitle'),
    el,
    show: () => {
      refreshAt = 0;
      setChildren(list, h('div.mn-empty', null, t('custom.loading')));
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
    cycler<Playlist>(t('custom.settingMode'), PLAYLISTS.map((p) => ({ value: p, label: `${playlistName(p)} (${p})` })), () => s.mode, (v) => (s.mode = v)).el,
    cycler<'public' | 'private'>(t('custom.settingVisibility'), [{ value: 'public', label: t('custom.visibilityPublicListed') }, { value: 'private', label: t('custom.visibilityPrivateCode') }], () => s.visibility, (v) => (s.visibility = v)).el,
    cycler<'p2p' | 'server'>(t('custom.settingNet'), [{ value: 'p2p', label: t('custom.netP2pRecommended') }, { value: 'server', label: t('custom.netServer') }], () => s.net, (v) => (s.net = v)).el,
    cycler<number>(t('custom.settingLength'), LOBBY_LENGTHS.map((l) => ({ value: l, label: lengthLabel(l) })), () => s.matchLengthSeconds, (v) => (s.matchLengthSeconds = v)).el,
  ];
}

export function lobbyCreateScreen(menu: Menu): Screen {
  const s: LobbySettings = { name: '', mode: '2v2', visibility: 'public', net: 'p2p', matchLengthSeconds: 300 };
  const name = field(t('custom.nameField'), { maxLength: 24 });
  const pw = field(t('custom.passwordOptional'), { type: 'password', maxLength: 32, placeholder: t('custom.noPassword') });
  const controls = h('div');
  const create = primary(t('custom.create'), async () => {
    const n = name.input.value.trim();
    if (n.length < 3) {
      name.error(t('custom.nameLength'));
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
  const el = h('div.mn-queue', null, screenHead(t('custom.createLobby'), t('custom.createSubtitle')), section(t('custom.lobbySection'), name.el, controls, pw.el), h('div.mn-actions', null, create));
  return {
    id: 'lobby-create',
    title: t('custom.createTitle'),
    el,
    show: () => {
      const who = menu.host.accounts.account?.name ?? menu.host.guestName();
      // Every translation must survive the server's name sanitizer (tests/i18n-lobby-name.test.mjs).
      if (name.input.value.length === 0) name.input.value = t('custom.defaultName', { name: who }).slice(0, 24);
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
      m.guest ? h('span.mn-tag', null, t('custom.tagGuest')) : null,
      m.inGame ? h('span.mn-tag.mn-tag-live', null, t('custom.tagInMatch')) : null,
      meHost && m.id !== s.you ? navButton('mn-kick', t('custom.kick'), () => lobby.kick(m.id)) : null,
    );
  };

  const configure = (s: LobbyState): void => {
    const draft: LobbySettings = { ...s.settings };
    const name = field(t('custom.nameField'), { maxLength: 24, value: draft.name });
    const pw = field(s.hasPassword ? t('custom.newPassword') : t('custom.passwordOptional'), { type: 'password', maxLength: 32 });
    menu.modal({
      title: t('custom.configureTitle'),
      body: [name.el, ...settingsControls(draft), pw.el],
      actions: [
        {
          label: t('custom.save'),
          primary: true,
          onClick: () => {
            const n = name.input.value.trim();
            if (n.length < 3) {
              name.error(t('custom.nameLength'));
              return false;
            }
            draft.name = n;
            lobby.updateSettings(draft, pw.input.value.length > 0 ? pw.input.value : s.hasPassword ? null : undefined);
            return true;
          },
        },
        { label: t('custom.cancel'), onClick: () => true },
      ],
    });
  };

  const render = (): void => {
    const s = lobby.state;
    if (!s) {
      setChildren(teams, h('div.mn-empty', null, lobby.status === 'connecting' ? t('custom.joining') : t('custom.notInLobby')));
      setChildren(actions, secondary(t('custom.back'), () => menu.open('custom')));
      return;
    }
    (el.querySelector('.mn-lobby-title') as HTMLElement).textContent = s.settings.name;
    info.textContent = t('custom.info', {
      playlist: playlistName(s.settings.mode),
      mode: s.settings.mode,
      net: netLabel(s.settings.net),
      length: lengthLabel(s.settings.matchLengthSeconds),
      visibility: s.settings.visibility === 'public' ? t('custom.public') : t('custom.private'),
      lock: s.hasPassword ? ' · 🔒' : '',
    });
    setChildren(codeEl, h('span.mn-lobby-code-label', null, t('custom.codeLabel')), h('span.mn-lobby-code-value', null, s.code), navButton('mn-btn mn-btn-small', t('custom.copy'), () => void copyText(s.code).then((ok) => menu.toast(ok ? t('custom.copied') : t('custom.copyFailed'), ok ? 'ok' : 'error'))));
    const per = MODES[s.settings.mode];
    const col = (team: 0 | 1): HTMLElement => {
      const ms = s.members.filter((m) => m.team === team);
      const slots: HTMLElement[] = ms.map((m) => memberRow(m, s));
      for (let i = ms.length; i < per; i++) slots.push(h('div.mn-member.mn-member-bot', null, h('span.mn-member-name', null, t('custom.botSlot'))));
      return h(`div.mn-team.mn-team-${team === 0 ? 'blue' : 'red'}` as 'div', null, h('div.mn-team-title', null, team === 0 ? t('custom.teamBlue') : t('custom.teamRed')), ...slots);
    };
    setChildren(teams, col(0), col(1));
    const me = s.members.find((m) => m.id === s.you);
    const isHost = me?.host === true;
    statusLine.textContent =
      s.status === 'in_game' ? t('custom.statusInGame') : s.status === 'starting' ? t('custom.statusStarting') : isHost ? t('custom.statusHost') : t('custom.statusWaiting');
    const other = me ? (me.team === 0 ? 1 : 0) : 0;
    const otherFull = s.members.filter((m) => m.team === other).length >= per;
    const focused = (document.activeElement as HTMLElement | null)?.textContent ?? '';
    setChildren(
      actions,
      isHost ? primary(t('custom.start'), () => lobby.start(), { disabled: s.status !== 'open' }) : null,
      secondary(otherFull ? t('custom.otherTeamFull') : t('custom.switchTeam'), () => lobby.setTeam(other), { disabled: otherFull || s.status !== 'open' }),
      isHost ? secondary(t('custom.configure'), () => configure(s), { disabled: s.status !== 'open' }) : null,
      secondary(t('custom.leaveLobby'), () => {
        lobby.leave();
        menu.open('custom');
      }),
    );
    // Keep the controller's place across re-renders (by the button's text: the language is fixed for the page).
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
    title: t('custom.lobbyTitle'),
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
        title: t('custom.leaveTitle'),
        body: h('p', null, lobby.isHost ? t('custom.leaveHost') : t('custom.leaveMember')),
        actions: [
          {
            label: t('custom.leave'),
            primary: true,
            onClick: () => {
              lobby.leave();
              menu.open('custom');
            },
          },
          { label: t('custom.stay'), onClick: () => true },
        ],
      });
      return true;
    },
  };
}

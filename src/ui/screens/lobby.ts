/**
 * The Sala (plan §6.4, PR 12) and the ways into it: CREATE LOBBY AND SHARE (a private lobby with
 * the last format, MODOS › SALAS and the empty list), JOIN WITH CODE (mn-codecells in a sheet), a
 * list row, and a join link (`#sala=ABC234`, on a cold load or a hashchange: "Join lobby ABC234 ·
 * 2v2 · 2/4?" with JOIN, and "Your name" the first time a guest goes online).
 *
 * The screen: the lobby's name and settings line, the code giant ("ABC 234": a press copies it,
 * which on a phone is its tap), SHARE (screens/lobbyModel.ts shareWay: the system's share sheet on
 * a touch screen, the link copied on a PC, a sheet with the QR, the code and the short link on a
 * TV), the two teams side by side in 56 px rows (a row opens Move · Make host · Kick for the host,
 * Move for one's own; a kick asks first), and the action bar fixed at the bottom: START (the host)
 * or READY, and "…" with SETTINGS (the host) and LEAVE LOBBY. While the lobby socket is away
 * (LobbyClient 'reconnecting') the status line says "Reconnecting to the lobby…" and the actions
 * wait.
 *
 * Leaving it any other way than LEAVE LOBBY (Back, a crumb, a section, the chip, the search pill:
 * Screen.leaveGuard) asks "Leave lobby ABC 234?" with LEAVE LOBBY, KEEP THE LOBBY (go on, still in
 * it: the lobby pill brings it back, shell/pills.ts) and CANCEL, so nobody holds a lobby without
 * knowing (A24).
 *
 * A refused create or join is a failed online step (Menu.failure, src/net/outcome.ts): its text and
 * its one action. Built per screen; the lobby callbacks are set when the screen is first made.
 */
import { h, setChildren, copyText, navButton } from '../dom';
import { sanitizeLobbyName } from '../../net/account';
import type { LobbyMember, LobbySettings, LobbyState } from '../../net/account';
import { AccountError } from '../../net/AccountClient';
import { lobbyCloseText } from '../../net/LobbyClient';
import { outcomeOf } from '../../net/outcome';
import { MODES } from '../../sim/constants';
import { DEFAULT_MATCH_SECONDS } from '../../game/Match';
import { GAME_NAME } from '../../brand';
import { t } from '../../i18n';
import { lobbyRulesLine } from '../../render/rulesText';
import type { Menu, Screen } from '../Menu';
import { icon } from '../components/icons';
import { qrSvg } from '../components/qr';
import { codeCells } from '../components/codecells';
import { field } from './common';
import { configureLobby, lengthLabel, lobbyRules, netLabel } from './custom';
import { joinLink, linkCode, lobbyFormat, shareWay, shortLink, spacedCode, withoutLink } from './lobbyModel';


/** The lobby list again: MODOS on its SALAS tab (back from a lobby, a lobby closed or left). */
export const toList = (menu: Menu): void => menu.open('modes', false, 'lobbies');

const touch = (): boolean => document.documentElement.classList.contains('tg-touch');
const tv = (): boolean => document.documentElement.classList.contains('tg-tv');

function errText(e: unknown): string {
  return e instanceof AccountError ? e.message : e instanceof Error ? e.message : String(e);
}

/** A refused lobby request as a failed online step: its text and its one action (`retry` for REINTENTAR). */
function failed(menu: Menu, e: unknown, retry?: () => void): void {
  const f = e instanceof AccountError ? { code: e.code, status: e.status } : { code: 'network', status: 0 };
  menu.failure(errText(e), outcomeOf(f), retry);
}

let creating = false;

/**
 * CREATE LOBBY AND SHARE: a private lobby with the last format (lobbyModel.ts lobbyFormat), P2P and
 * the default length, then its screen with SHARE focused. Already in a lobby: its screen.
 */
export async function createAndShare(menu: Menu): Promise<void> {
  const lobby = menu.host.lobby;
  if (lobby.inLobby) {
    menu.open('lobby');
    return;
  }
  if (creating) return;
  creating = true;
  const who = menu.host.accounts.account?.name ?? menu.host.guestName();
  // Every translation survives the server's name rules (tests/i18n-lobby-name.test.mjs); a name that
  // would not (a guest name the sanitizer drops) falls back to the plain word.
  const name = sanitizeLobbyName(t('custom.defaultName', { name: who }).slice(0, 24)) ?? t('custom.lobbyTitle');
  const settings: LobbySettings = { name, mode: lobbyFormat(menu.prefs), visibility: 'private', net: 'p2p', matchLengthSeconds: DEFAULT_MATCH_SECONDS, physics: null };
  try {
    await lobby.create({ settings, password: null, region: menu.prefs.region });
    freshLobby = true;
    menu.open('lobby');
  } catch (e) {
    failed(menu, e, () => void createAndShare(menu));
  } finally {
    creating = false;
  }
}

/** The next mount of the Sala is the one CREATE LOBBY AND SHARE opened: SHARE takes the focus. */
let freshLobby = false;

/** Join `code` (asking for the password when it is locked) and open the Sala. */
export async function joinFlow(menu: Menu, code: string, locked: boolean): Promise<void> {
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
      failed(menu, e, () => void joinFlow(menu, code, locked));
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
  // An Enter the menus took (OK on a field in navigation mode starts editing: Menu.onFieldKey) is no submit.
  pw.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.defaultPrevented) void attempt(pw.input.value).then((ok) => ok && close());
  });
}

/** JOIN WITH CODE: the six cells and JOIN in a sheet; typing or pasting the sixth character joins. */
export function openCodeEntry(menu: Menu): void {
  let close = (): void => undefined;
  const go = (code: string): void => {
    close();
    void joinFlow(menu, code, false);
  };
  const cells = codeCells(t('lobby.codeLabel'), go);
  close = menu.modal({
    title: t('lobby.codeTitle'),
    body: cells.el,
    actions: [
      {
        label: t('lobby.join'),
        primary: true,
        onClick: () => {
          const v = cells.value();
          if (v.length < 6) {
            menu.toast(t('custom.codeInvalid'), 'error');
            return false;
          }
          queueMicrotask(() => void joinFlow(menu, v, false));
          return true;
        },
      },
      { label: t('lobby.cancel'), onClick: () => true },
    ],
  });
}

/** How long a join link's sheet waits for the lobby's summary before it asks with the code alone. */
const PEEK_WAIT_MS = 1_500;

/**
 * A join link's sheet: "Join lobby ABC234 · 2v2 · 2/4?" (the code alone when the summary is late),
 * JOIN focused; a guest's first time online adds "Your name", prefilled; in another lobby already,
 * it says that one is left. A lobby that is gone says so (a failed step: CLOSE).
 */
export async function askJoin(menu: Menu, code: string): Promise<void> {
  const lobby = menu.host.lobby;
  if (lobby.inLobby && lobby.code === code) {
    menu.open('lobby');
    return;
  }
  let title = t('lobby.joinAskCode', { code });
  let locked = false;
  try {
    const s = await Promise.race([lobby.peek(code), new Promise<null>((r) => setTimeout(() => r(null), PEEK_WAIT_MS))]);
    if (s !== null) {
      title = t('lobby.joinAsk', { code, mode: s.mode, count: s.players, max: s.max });
      locked = s.locked;
    }
  } catch (e) {
    const f = e instanceof AccountError ? { code: e.code, status: e.status } : { code: 'network', status: 0 };
    if (outcomeOf(f) === 'gone') {
      menu.failure(errText(e), 'gone');
      return;
    }
    // The summary failed for another reason (an older Worker without it, the network): ask with the code.
  }
  joinSheet(menu, code, title, locked);
}

/** The join link's sheet itself (askJoin; the layout check's sample, lobbySamples.ts). */
export function joinSheet(menu: Menu, code: string, title: string, locked: boolean): void {
  const lobby = menu.host.lobby;
  const name = menu.host.firstOnline() ? field(t('lobby.yourName'), { maxLength: 16, value: menu.host.guestName() }) : null;
  const swap = lobby.inLobby && lobby.code !== null ? h('p', null, t('lobby.swap', { code: spacedCode(lobby.code) })) : null;
  menu.modal({
    title,
    body: [name?.el ?? null, swap],
    actions: [
      {
        label: t('lobby.join'),
        primary: true,
        autofocus: true,
        onClick: () => {
          const n = name?.input.value.trim() ?? '';
          if (name !== null && n.length > 0 && n !== menu.host.guestName()) menu.host.setGuestName(n);
          queueMicrotask(() => void joinFlow(menu, code, locked));
          return true;
        },
      },
      { label: t('lobby.cancel'), onClick: () => true },
    ],
  });
}

/**
 * Join links (`#sala=ABC234`): the one the page loaded with, and any later hashchange. The entry
 * leaves the address (replaceState: a reload does not ask again; the other hash flags stay), and
 * the sheet waits for the menus (the loading screen, a match) and for no other sheet to be up.
 */
export function installJoinLink(menu: Menu): void {
  let pending: string | null = null;
  let timer = 0;
  const take = (): void => {
    const code = linkCode(location.hash);
    if (code === null) return;
    history.replaceState(history.state, '', location.pathname + location.search + withoutLink(location.hash));
    pending = code;
    tryOpen();
  };
  const tryOpen = (): void => {
    window.clearTimeout(timer);
    if (pending === null) return;
    if (!menu.visible || menu.modalOpen) {
      timer = window.setTimeout(tryOpen, 400);
      return;
    }
    const code = pending;
    pending = null;
    void askJoin(menu, code);
  };
  window.addEventListener('hashchange', take);
  take();
}

/** The Sala's settings line: "2v2 · P2P · 5 min · Private". */
function infoLine(s: LobbyState): string {
  return t('custom.info', {
    mode: s.settings.mode,
    net: netLabel(s.settings.net),
    length: lengthLabel(s.settings.matchLengthSeconds),
    visibility: s.settings.visibility === 'public' ? t('custom.public') : t('custom.private'),
    lock: '',
  });
}

const TEAM_KEY = { 0: 'custom.teamBlue', 1: 'custom.teamRed' } as const;

/** A TV's SHARE: the join link's QR, the code and the short link, big (a TV has no share sheet). */
export function openQr(menu: Menu, code: string): void {
  const url = joinLink(location.origin, code);
  menu.modal({
    title: t('lobby.qrTitle'),
    body: h('div.mn-sala-qr', null, qrSvg(url, t('lobby.qrTitle')), h('div.mn-sala-qr-text', null, h('b.mn-sala-qr-code', null, spacedCode(code)), h('span.mn-sala-qr-link', null, shortLink(url)))),
    actions: [{ label: t('outcome.close'), primary: true, onClick: () => true }],
  });
}

export function lobbyScreen(menu: Menu): Screen {
  const lobby = menu.host.lobby;
  const name = h('h1.mn-sala-name'); // a player's own name: cut with an ellipsis when long
  const info = h('p.mn-sala-info');
  const rulesLine = h('p.mn-sala-rules', { hidden: true });
  const codeValue = h('span.mn-sala-code-value');
  const code = h(
    'button.mn-sala-code',
    { type: 'button', 'data-nav': true, 'data-key': 'sala-code', onclick: () => copyCode() },
    h('span.mn-sala-code-label', null, t('custom.codeLabel')),
    codeValue,
    icon('copy'),
  );
  const share = h('button.mn-btn.mn-sala-share', { type: 'button', 'data-nav': true, 'data-key': 'sala-share', onclick: () => doShare() }, icon('share'), h('span', null, t('lobby.share')));
  const status = h('p.mn-sala-status', { role: 'status', hidden: true });
  const teams = h('div.mn-sala-teams');
  const go = h('button.mn-btn.mn-btn-primary.mn-sala-go', { type: 'button', 'data-nav': true, 'data-key': 'sala-go', 'data-autofocus': true, onclick: () => primaryPress() });
  const more = h('button.mn-btn.mn-sala-more', { type: 'button', 'data-nav': true, 'data-key': 'sala-more', 'aria-label': t('lobby.more'), title: t('lobby.more'), onclick: () => openMore() }, '…');
  const bar = h('div.mn-sala-bar', { 'data-nav-row': true }, go, more);
  const el = h(
    'section.mn-sala',
    { 'data-tablero': true },
    h('div.mn-sala-head', null, h('div.mn-sala-title', null, name, info, rulesLine), h('div.mn-sala-codebox', { 'data-nav-row': true }, code, share)),
    status,
    teams,
    bar,
  );
  let shown = false;

  const state = (): LobbyState | null => lobby.state;
  const me = (): LobbyMember | null => lobby.me;
  const link = (s: LobbyState): string => joinLink(location.origin, s.code);
  const busy = (): boolean => lobby.reconnecting || state()?.status !== 'open';

  const copyCode = (): void => {
    const s = state();
    if (s === null) return;
    void copyText(s.code).then((ok) => menu.toast(ok ? t('lobby.codeCopied') : t('custom.copyFailed'), ok ? 'ok' : 'error'));
  };

  const doShare = (): void => {
    const s = state();
    if (s === null) return;
    const url = link(s);
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    const way = shareWay({ tv: tv(), touch: touch() || matchMedia('(pointer: coarse)').matches, canShare: typeof nav.share === 'function' });
    if (way === 'share' && nav.share) {
      nav.share({ title: GAME_NAME, text: t('lobby.shareText', { game: GAME_NAME, code: spacedCode(s.code) }), url }).catch((e: unknown) => {
        // Cancelled by the player: nothing. Refused (no activation, a policy): the link is copied instead.
        if (!(e instanceof DOMException && e.name === 'AbortError')) void copyLink(url);
      });
      return;
    }
    if (way === 'qr') {
      openQr(menu, s.code);
      return;
    }
    void copyLink(url);
  };
  const copyLink = async (url: string): Promise<void> => {
    const ok = await copyText(url);
    menu.toast(ok ? t('lobby.linkCopied') : t('custom.copyFailed'), ok ? 'ok' : 'error');
  };

  const primaryPress = (): void => {
    if (busy()) return;
    if (lobby.isHost) lobby.start();
    else lobby.setReady(me()?.ready !== true);
  };

  /** "…": SETTINGS (the host) and LEAVE LOBBY. */
  const openMore = (): void => {
    const s = state();
    menu.modal({
      title: s !== null ? s.settings.name : t('custom.lobbyTitle'),
      body: [],
      actions: [
        ...(lobby.isHost && s !== null && !busy()
          ? [
              {
                label: t('lobby.settings'),
                onClick: () => {
                  queueMicrotask(() => configureLobby(menu, s));
                  return true;
                },
              },
            ]
          : []),
        {
          label: t('lobby.leave'),
          danger: true,
          onClick: () => {
            lobby.leave();
            queueMicrotask(() => toList(menu));
            return true;
          },
        },
        { label: t('lobby.cancel'), autofocus: true, onClick: () => true },
      ],
    });
  };

  /** A member's sheet: Move (the host for anyone, a member for itself), Make host and Kick (the host, another member). */
  const openMember = (m: LobbyMember): void => {
    const s = state();
    if (s === null) return;
    const mine = m.id === s.you;
    const host = lobby.isHost;
    const other = m.team === 0 ? 1 : 0;
    const otherFull = s.members.filter((x) => x.team === other).length >= MODES[s.settings.mode];
    const actions = [];
    if ((host || mine) && !otherFull && s.status === 'open') {
      actions.push({ label: t('lobby.moveTo', { team: t(TEAM_KEY[other]) }), primary: true, onClick: () => (mine ? lobby.setTeam(other) : lobby.move(m.id, other)) });
    }
    if (host && !mine) {
      actions.push({ label: t('lobby.makeHost'), onClick: () => lobby.makeHost(m.id) });
      actions.push({
        label: t('lobby.kick'),
        danger: true,
        onClick: () => {
          queueMicrotask(() => askKick(m));
          return true;
        },
      });
    }
    if (actions.length === 0) return;
    actions.push({ label: t('lobby.cancel'), onClick: () => undefined });
    menu.modal({ title: m.name, body: [], actions });
  };

  const askKick = (m: LobbyMember): void => {
    menu.modal({
      title: t('lobby.kickTitle', { name: m.name }),
      body: h('p', null, t('lobby.kickBody')),
      actions: [
        { label: t('lobby.kick'), danger: true, onClick: () => lobby.kick(m.id) },
        { label: t('lobby.cancel'), autofocus: true, onClick: () => true },
      ],
    });
  };

  const memberRow = (m: LobbyMember, s: LobbyState): HTMLElement => {
    const mine = m.id === s.you;
    const tags = [
      m.host ? h('span.mn-tag.mn-tag-host', null, t('lobby.tagHost')) : null,
      mine ? h('span.mn-tag', null, t('lobby.tagYou')) : null,
      m.away === true ? h('span.mn-tag.mn-tag-away', null, t('lobby.tagAway')) : m.inGame ? h('span.mn-tag.mn-tag-live', null, t('lobby.tagInMatch')) : m.ready === true ? h('span.mn-tag.mn-tag-ready', null, t('lobby.tagReady')) : null,
      m.guest ? h('span.mn-tag', null, t('custom.tagGuest')) : null,
    ];
    const kids = [h('span.mn-member-name', null, m.name), h('span.mn-member-tags', null, ...tags)];
    const cls = `mn-member${mine ? ' mn-member-you' : ''}${m.away === true ? ' mn-member-away' : ''}`;
    // Only a row with something to do is a button (the host's, one's own).
    if (lobby.isHost || mine) return navButton(cls, kids, () => openMember(m), { 'data-key': 'member-' + m.id });
    return h(`div.${cls.replace(/ /g, '.')}` as 'div', null, ...kids);
  };

  const render = (): void => {
    const s = state();
    if (s === null) {
      setChildren(teams, h('p.mn-empty', null, lobby.status === 'connecting' || lobby.reconnecting ? t('custom.joining') : t('custom.notInLobby')));
      go.hidden = true;
      return;
    }
    go.hidden = false;
    const focusedKey = (document.activeElement as HTMLElement | null)?.dataset?.key ?? null;
    const rules = lobbyRules(s.settings.physics ?? null);
    setChildren(name, s.settings.name, rules !== null ? ' ' : null, rules !== null ? h('span.mn-tag.mn-tag-exp', null, t('custom.tagExperimental')) : null);
    info.textContent = infoLine(s) + (s.hasPassword ? ' · ' : '');
    if (s.hasPassword) info.append(icon('lock'));
    rulesLine.hidden = rules === null;
    rulesLine.textContent = rules !== null ? t('custom.rulesInfo', { summary: lobbyRulesLine(rules) }) : '';
    codeValue.textContent = spacedCode(s.code);
    const statusText = lobby.reconnecting ? t('lobby.reconnecting') : s.status === 'in_game' ? t('custom.statusInGame') : s.status === 'starting' ? t('custom.statusStarting') : '';
    status.hidden = statusText === '';
    status.textContent = statusText;
    status.classList.toggle('mn-sala-status-warn', lobby.reconnecting);
    const per = MODES[s.settings.mode];
    const col = (team: 0 | 1): HTMLElement => {
      const ms = s.members.filter((m) => m.team === team);
      const rows: HTMLElement[] = ms.map((m) => memberRow(m, s));
      for (let i = ms.length; i < per; i++) rows.push(h('div.mn-member.mn-member-open', null, h('span.mn-member-name', null, t('lobby.openSlot'))));
      return h(`div.mn-sala-team.mn-sala-team-${team === 0 ? 'blue' : 'red'}` as 'div', null, h('div.mn-sala-team-title', null, t(TEAM_KEY[team]), h('span.mn-sala-team-count', null, `${ms.length}/${per}`)), ...rows);
    };
    setChildren(teams, col(0), col(1));
    const host = lobby.isHost;
    const ready = me()?.ready === true;
    setChildren(go, host ? icon('play') : ready ? icon('check') : null, h('span', null, host ? t('lobby.start') : t('lobby.ready')));
    go.classList.toggle('mn-btn-primary', host || !ready);
    go.setAttribute('aria-pressed', host ? 'false' : String(ready));
    go.disabled = busy();
    // The controller's place across re-renders (by data-key), else the screen's own.
    const again = focusedKey !== null ? el.querySelector<HTMLElement>(`[data-key="${focusedKey}"]`) : null;
    if (again !== null && document.activeElement !== again && !touch()) again.focus({ preventScroll: true });
    else if (focusedKey !== null && again === null) menu.refocus();
    menu.refit();
  };

  lobby.onState = (s) => {
    menu.prefs.lobbyMode = s.settings.mode; // the next CREATE LOBBY AND SHARE takes it
    if (shown) render();
  };
  lobby.onStatus = () => {
    if (shown) render();
  };
  lobby.onMatch = (r) => menu.host.playLobbyMatch(r);
  lobby.onError = (code, message) => {
    // A start the matchmaker refused is a failed step (REINTENTAR starts again); any other refusal says why.
    if (code === 'capacity' || code === 'matchmaking_off' || code === 'start_failed' || code === 'unavailable') menu.failure(message, outcomeOf({ code, status: code === 'capacity' ? 503 : 0 }), () => lobby.start());
    else menu.toast(message, 'error');
  };
  lobby.onClosed = (reason) => {
    menu.toast(lobbyCloseText(reason), reason === 'kicked' ? 'error' : 'info');
    if (menu.top()?.id === 'lobby') toList(menu);
    else menu.refreshChrome();
  };

  /** KEEP THE LOBBY is taking the player on: the guard lets that one move through (it would ask again). */
  let passing = false;

  /** "Leave lobby ABC 234?": LEAVE LOBBY leaves, KEEP THE LOBBY goes on still in it, CANCEL stays (focused). */
  const askLeave = (goOn: () => void): void => {
    let next: (() => void) | null = null;
    const c = lobby.code;
    menu.modal({
      title: t('lobby.leaveTitle', { code: c !== null ? spacedCode(c) : '' }),
      body: lobby.isHost ? h('p', null, t('lobby.leaveHost')) : [],
      actions: [
        {
          label: t('lobby.leave'),
          danger: true,
          onClick: () => {
            lobby.leave();
            next = goOn;
          },
        },
        {
          label: t('lobby.keep'),
          onClick: () => {
            next = () => {
              passing = true;
              try {
                goOn();
              } finally {
                passing = false;
              }
            };
          },
        },
        { label: t('lobby.cancel'), autofocus: true, onClick: () => true },
      ],
      onClose: () => next?.(),
    });
  };

  return {
    id: 'lobby',
    title: t('custom.lobbyTitle'),
    el,
    show: () => {
      shown = true;
      if (lobby.me?.inGame) lobby.back(); // back from the lobby's match
      render();
      if (freshLobby) {
        freshLobby = false;
        if (!touch()) share.focus({ preventScroll: true });
      }
    },
    hide: () => {
      shown = false;
    },
    back: () => {
      if (!lobby.inLobby) return false;
      askLeave(() => toList(menu));
      return true;
    },
    leaveGuard: () => (lobby.inLobby && !passing ? askLeave : null),
  };
}

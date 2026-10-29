/**
 * PERFIL (plan PR 13, dir-hub §6.8), the section's root.
 *
 * An account: the identity tile (badge of your best rank, name, since when and how you sign in,
 * abandons), TEMPORADA (a tile per playlist: rank in words, MMR or the placement left, the record),
 * MI SERVIDOR for a community node operator (GET /nodes/mine: each node, its state in words, its
 * region, the matches it hosted, its version), CUENTA Y SEGURIDAD folded (a disclosure: rename,
 * password, recovery codes, link a provider, sign out), COMUNIDAD (Discord, host a server, the
 * source), ACERCA DE (version, licences, the technical line).
 *
 * A guest, one column for the arrows: on a TV first INICIAR SESIÓN CON EL TELÉFONO (focused: the
 * code and its QR in a sheet, screens/tvSignIn.ts), then CREAR CUENTA GRATIS (the hero) and INICIAR SESIÓN, the screen's
 * two tabs (`.mn-tabs`, a nav row: Q / E step them, the hint bar says so), then the tab's form
 * ("Forgot your password?" under the sign-in form is a link to the recovery form), the guest name. Fields say what a
 * phone keyboard's Enter does (enterkeyhint: next, then go / done) and Enter does it (onEnter); the
 * Menu keeps the focused field above a phone's keyboard (keyboard.ts). A sign-in here from
 * Competitive's SIGN IN goes back there (modes.ts: the return with intent). Passwords go through
 * AccountClient (hashed in the browser before they leave). Usernames and passwords are checked here
 * first (usernameIssue / passwordIssue, the same rules AccountClient and the server apply) so the
 * form shows the reason in the player's language. Both views end with ACERCA DE (the language is
 * Settings › Game's Idioma, PR 11).
 * In development (or a VITE_UI_FIT=1 build) window.__profile(kind | null) shows an account's or an
 * operator's sample (scripts/ui-fit.mjs).
 */
import { h, setChildren, copyText, navButton } from '../dom';
import { AccountError } from '../../net/AccountClient';
import { PASSWORD_MIN, REGIONS, USERNAME_MAX, USERNAME_MIN, passwordIssue, usernameIssue } from '../../net/account';
import type { AccountIssue, MeInfo, MyNode, OAuthProvider, PlaylistRating } from '../../net/account';
import { PROTOCOL_VERSION } from '../../net/protocol';
import { PROBATION_MATCHES } from '../../../nodes/control-plane/registry';
import { ratingCard, rankBadge, tierById } from '../badges';
import { regionName } from '../names';
import type { Menu, Screen } from '../Menu';
import { field, primary, screenHead, secondary, section } from './common';
import { finePointer } from '../device';
import { icon } from '../components/icons';
import type { IconName } from '../components/icons';
import { slot } from '../components/tile';
import { language, t } from '../../i18n';
import type { Key } from '../../i18n';
import { DISCORD_URL, GAME_NAME, SOURCE_URL } from '../../brand';
import { version } from '../../../package.json';
import { openTvSignIn } from './tvSignIn';

/** A node's state in words (nodes/shared/controlProtocol.ts NodeStatus). */
const NODE_STATE: Readonly<Record<MyNode['status'], Key>> = {
  pending: 'profile.nodePending',
  probation: 'profile.nodeProbation',
  active: 'profile.nodeActive',
  suspended: 'profile.nodeSuspended',
  banned: 'profile.nodeBanned',
};
/** A node's region by its name when it is one of the game's (a node's own label as it is otherwise). */
const nodeRegion = (id: string): string => {
  const r = REGIONS.find((x) => x.id === id);
  return r !== undefined ? regionName(r.id) : id;
};
/** The community guide to host a node (its Spanish README in Spanish). */
const HOST_GUIDE = (): string => `${SOURCE_URL}/blob/main/nodes/${language() === 'es' ? 'README.es.md' : 'README.md'}`;

const PROVIDER_NAMES: Readonly<Record<OAuthProvider, string>> = { google: 'Google', discord: 'Discord' };

/** An account error in the player's words (a throttle with its seconds). */
export function errText(e: unknown): string {
  if (e instanceof AccountError) {
    if (e.code === 'throttled' && e.retryAfterMs > 0) return t('profile.retryAfter', { message: e.message, seconds: Math.ceil(e.retryAfterMs / 1000) });
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** What is wrong with a username or password (src/net/account.ts), in the player's language; null when nothing. */
function issueText(issue: AccountIssue | null): string | null {
  return issue === null ? null : t(`account.issue.${issue.code}`, issue.params);
}

/** 'password, Google': how the account signs in (translated). */
function providerList(me: MeInfo): string {
  return me.providers.map((p) => (p === 'password' ? t('profile.providerPassword') : PROVIDER_NAMES[p])).join(', ');
}

/**
 * A date in the browser's own variant of the page language: en-GB and en-AU read 04/03/2026 as
 * 4 March, where a bare 'en' gives the US 3/4/2026. Spanish keeps 'es' (d/m/yyyy), the dates the
 * rioplatense text has always shown, whatever the player's region.
 */
function shortDate(ms: number): string {
  const lang = language();
  const regional = lang === 'es' || typeof window === 'undefined' ? undefined : window.navigator.languages?.find((tag) => tag.toLowerCase().split('-')[0] === lang);
  try {
    return new Date(ms).toLocaleDateString(regional ?? lang);
  } catch {
    return new Date(ms).toLocaleDateString(lang); // a malformed browser tag
  }
}

/** Show recovery codes once, with a copy button; resolves when the player confirms. */
export function showRecoveryCodes(menu: Menu, codes: string[], intro: string): void {
  menu.modal({
    title: t('profile.codesTitle'),
    dismissable: false,
    body: [h('p', null, intro), h('div.mn-codes', null, ...codes.map((c) => h('code', null, c))), h('p.mn-note', null, t('profile.codesNote'))],
    actions: [
      { label: t('profile.copy'), onClick: async () => (menu.toast((await copyText(codes.join('\n'))) ? t('profile.codesCopied') : t('profile.copyFailed'), 'ok'), false) },
      { label: t('profile.codesSaved'), primary: true, onClick: () => true },
    ],
  });
}


/**
 * Enter on a form's fields: the next field, the last one submits (`go`). Not the Enter / OK that
 * starts editing a field reached with the arrows (Menu.onFieldKey cancels it).
 */
function onEnter(inputs: HTMLInputElement[], go: () => void): void {
  inputs.forEach((input, i) =>
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.defaultPrevented) return;
      const next = inputs[i + 1];
      if (next === undefined) go();
      else {
        e.preventDefault();
        next.focus();
      }
    }),
  );
}

type GuestTab = 'login' | 'register' | 'recover';

/** What the account view shows: the session's, or window.__profile's sample. */
interface AccountData {
  name: string;
  me: MeInfo | null;
  nodes: readonly MyNode[];
}

export function profileScreen(menu: Menu): Screen {
  const acc = menu.host.accounts;
  const body = h('div.mn-profile-body');
  const touch = (): boolean => document.documentElement.classList.contains('tg-touch');
  const tv = (): boolean => document.documentElement.classList.contains('tg-tv');
  let tab: GuestTab = 'login';
  /** The signed-in account's community nodes (GET /nodes/mine), by account. */
  let nodes: { who: string; list: MyNode[] } | null = null;
  /** CUENTA Y SEGURIDAD unfolded. */
  let accountOpen = false;
  let sample: AccountData | null = null;

  const oauthButtons = (): HTMLElement | null => {
    const list = (menu.cfg?.oauth ?? []) as OAuthProvider[];
    if (list.length === 0) return null;
    return h(
      'div.mn-oauth',
      null,
      h('div.mn-or', null, t('profile.or')),
      ...list.map((p) => navButton(`mn-btn mn-oauth-${p}`, t('profile.signInWith', { provider: PROVIDER_NAMES[p] }), () => (window.location.href = acc.oauthUrl(p)))),
    );
  };

  const loginForm = (): HTMLElement => {
    const user = field(t('profile.username'), { autocomplete: 'username', maxLength: 64, value: acc.hintName ?? '', enterkeyhint: 'next' });
    const pass = field(t('profile.password'), { type: 'password', autocomplete: 'current-password', maxLength: 128, enterkeyhint: 'go' });
    const go = async (): Promise<void> => {
      pass.error(null);
      try {
        await acc.login(user.input.value, pass.input.value);
        menu.toast(t('profile.hello', { name: acc.account?.name ?? '' }), 'ok');
        void acc.fetchMe();
        render();
      } catch (e) {
        pass.error(errText(e));
      }
    };
    onEnter([user.input, pass.input], () => void go());
    const forgot = navButton('mn-link mn-prof-forgot', t('profile.forgot'), () => pickTab('recover'), { 'data-key': 'profile-forgot' });
    return h('form.mn-form', { onsubmit: (e: Event) => e.preventDefault() }, user.el, pass.el, primary(t('profile.signIn'), () => void go(), { 'data-key': 'profile-go' }), forgot, oauthButtons());
  };

  const registerForm = (): HTMLElement => {
    const user = field(t('profile.username'), { autocomplete: 'username', maxLength: USERNAME_MAX, placeholder: t('profile.usernameHint', { min: USERNAME_MIN, max: USERNAME_MAX }), enterkeyhint: 'next' });
    const pass = field(t('profile.password'), { type: 'password', autocomplete: 'new-password', maxLength: 128, placeholder: t('profile.passwordHint', { count: PASSWORD_MIN }), enterkeyhint: 'next' });
    const pass2 = field(t('profile.repeatPassword'), { type: 'password', autocomplete: 'new-password', maxLength: 128, enterkeyhint: 'go' });
    const go = async (): Promise<void> => {
      user.error(null);
      pass.error(null);
      pass2.error(null);
      if (pass.input.value !== pass2.input.value) {
        pass2.error(t('profile.passwordsDiffer'));
        return;
      }
      const username = user.input.value.trim();
      const userIssue = issueText(usernameIssue(username));
      if (userIssue !== null) {
        user.error(userIssue);
        return;
      }
      const passIssue = issueText(passwordIssue(pass.input.value, username));
      if (passIssue !== null) {
        pass.error(passIssue);
        return;
      }
      try {
        const r = await acc.register(username, pass.input.value);
        render();
        showRecoveryCodes(menu, r.recoveryCodes, t('profile.registered', { name: r.name }));
        void acc.fetchMe();
      } catch (e) {
        if (e instanceof AccountError && (e.code === 'bad_username' || e.code === 'username_taken')) user.error(errText(e));
        else pass.error(errText(e));
      }
    };
    onEnter([user.input, pass.input, pass2.input], () => void go());
    return h('form.mn-form', { onsubmit: (e: Event) => e.preventDefault() }, user.el, pass.el, pass2.el, primary(t('profile.createAccount'), () => void go(), { 'data-key': 'profile-go' }), oauthButtons());
  };

  const recoverForm = (): HTMLElement => {
    const user = field(t('profile.username'), { autocomplete: 'username', maxLength: 64, value: acc.hintName ?? '', enterkeyhint: 'next' });
    const code = field(t('profile.recoveryCode'), { placeholder: 'XXXX-XXXX', maxLength: 16, enterkeyhint: 'next' });
    const pass = field(t('profile.newPassword'), { type: 'password', autocomplete: 'new-password', maxLength: 128, enterkeyhint: 'go' });
    const go = async (): Promise<void> => {
      pass.error(null);
      const passIssue = issueText(passwordIssue(pass.input.value, user.input.value)); // the arguments AccountClient.recover checks
      if (passIssue !== null) {
        pass.error(passIssue);
        return;
      }
      try {
        const r = await acc.recover(user.input.value, code.input.value, pass.input.value);
        menu.toast(t('profile.passwordReset', { count: r.codesLeft }), 'ok');
        void acc.fetchMe();
        render();
      } catch (e) {
        pass.error(errText(e));
      }
    };
    onEnter([user.input, code.input, pass.input], () => void go());
    return h('form.mn-form', { onsubmit: (e: Event) => e.preventDefault() }, h('p.mn-prof-form-title', null, t('profile.tabRecover')), user.el, code.el, pass.el, primary(t('profile.resetPassword'), () => void go(), { 'data-key': 'profile-go' }));
  };

  /**
   * A guest's form: the tab's, its first field focused for typing where there is a fine pointer (a
   * touch screen's tap shows the keyboard; a TV's OK on the field, reached with ▼, opens mn-keypad).
   */
  const pickTab = (id: GuestTab): void => {
    tab = id;
    render();
    if (!touch() && finePointer()) body.querySelector<HTMLElement>('.mn-form .mn-input')?.focus();
  };

  const guestView = (): HTMLElement => {
    const hero = h(
      `button.mn-tab.mn-prof-hero${tab === 'register' ? '.mn-tab-on' : ''}` as 'button',
      { type: 'button', role: 'tab', 'aria-selected': String(tab === 'register'), 'data-nav': true, 'data-key': 'profile-tab-register', 'data-autofocus': !tv(), onclick: () => pickTab('register') },
      h('span.mn-tile-top', null, icon('profile', 'mn-mtile-icon'), slot(t('profile.registerSlot'), { ink: true })),
      h('span.mn-prof-hero-title', { 'data-fit': '20' }, t('profile.registerFree')),
      h('span.mn-mtab-mark', { 'aria-hidden': 'true' }),
    );
    const signIn = h(
      `button.mn-tab.mn-prof-signin${tab === 'login' ? '.mn-tab-on' : ''}` as 'button',
      { type: 'button', role: 'tab', 'aria-selected': String(tab === 'login'), 'data-nav': true, 'data-key': 'profile-tab-login', onclick: () => pickTab('login') },
      icon('profile', 'mn-mtile-icon'),
      h('span.mn-prof-signin-title', { 'data-fit': '16' }, t('profile.tabSignIn')),
      h('span.mn-mtab-mark', { 'aria-hidden': 'true' }),
    );
    // A TV: no typing at all, the phone signs it in (the keypad still serves the forms below).
    const phone = tv()
      ? h(
          'button.mn-prof-phone',
          { type: 'button', 'data-nav': true, 'data-key': 'profile-phone', 'data-autofocus': true, onclick: () => openTvSignIn(menu) },
          icon('touch', 'mn-mtile-icon'),
          h('span.mn-prof-phone-text', null, h('span.mn-prof-phone-title', { 'data-fit': '16' }, t('tvsign.tile')), h('span.mn-prof-phone-sub', null, t('tvsign.tileSub'))),
        )
      : null;
    const form = tab === 'login' ? loginForm() : tab === 'register' ? registerForm() : recoverForm();
    const name = field(t('profile.guestName'), { maxLength: 16, value: menu.host.guestName(), enterkeyhint: 'done' });
    const saveName = (): void => {
      menu.host.setGuestName(name.input.value);
      name.input.value = menu.host.guestName();
      menu.refreshChrome();
      menu.toast(t('profile.guestNameSaved'), 'ok');
    };
    onEnter([name.input], saveName);
    return h(
      'div.mn-prof-guest',
      null,
      phone,
      h('div.mn-tabs.mn-prof-tabs', { role: 'tablist', 'aria-label': t('profile.heading'), 'data-nav-row': true }, hero, signIn),
      h('div.mn-prof-form', null, form),
      // A row for the arrows: ▶ from the name is SAVE NAME, not the wide button of the form above (a TV's remote).
      h('div.mn-prof-guestname', { 'data-nav-row': true }, name.el, secondary(t('profile.saveName'), saveName, { 'data-key': 'profile-save-name' })),
    );
  };

  /** A season tile per playlist (badges.ts ratingCard), in the order the server lists them. */
  const ranks = (me: MeInfo | null): HTMLElement => h('div.mn-prof-ranks', null, ...(me ? me.ratings.map((r) => ratingCard(r)) : [h('p.mn-lb-note', null, t('profile.loading'))]));

  /** Your best placed rank (its badge on the identity tile), null in placement everywhere. */
  const best = (me: MeInfo | null): PlaylistRating | null => (me?.ratings ?? []).filter((r) => r.placementLeft === 0 && r.tier !== null).sort((a, b) => b.mmr - a.mmr)[0] ?? null;

  /** MI SERVIDOR: each of the operator's nodes, its state in words. */
  const nodeView = (n: MyNode): HTMLElement => {
    const live = n.online && (n.status === 'active' || n.status === 'probation');
    const state = h('span.mn-prof-node-state', { 'data-ok': live ? 'true' : 'false' }, h('span.mn-dot'), t(NODE_STATE[n.status], { count: n.counters.probationVerified, total: PROBATION_MATCHES }), n.online ? '' : ` · ${t('profile.nodeOffline')}`);
    return h(
      'div.mn-prof-node',
      null,
      h('div.mn-prof-node-head', null, icon('server', 'mn-mtile-icon'), h('b.mn-prof-node-name', null, n.name ?? n.nodeId.slice(0, 8)), h('span.mn-prof-node-region', null, nodeRegion(n.region))),
      state,
      n.statusReason !== null && (n.status === 'suspended' || n.status === 'banned') ? h('p.mn-prof-node-reason', null, n.statusReason) : null,
      h('dl.mn-prof-node-facts', null, h('dt', null, t('profile.nodeMatches')), h('dd', null, String(n.counters.verified)), h('dt', null, t('profile.nodeVersion')), h('dd', null, n.compatible ? n.version : t('profile.nodeUpdate', { version: n.version }))),
    );
  };

  const link = (href: string, glyph: IconName, text: string, key: string): HTMLAnchorElement =>
    h('a.mn-btn.mn-prof-link', { href, target: '_blank', rel: 'noopener', 'data-nav': true, 'data-key': key }, icon(glyph), h('span', null, text));

  const accountView = (v: AccountData): HTMLElement => {
    const me = v.me;
    const banLeft = me ? me.rankedBanUntil - Date.now() : 0;
    const providers = (menu.cfg?.oauth ?? []) as OAuthProvider[];
    const linkable = providers.filter((p) => me && !me.providers.includes(p));
    const abandons = (m: MeInfo): string =>
      banLeft > 0 ? t('profile.abandonsBanned', { count: m.abandons24h, minutes: Math.ceil(banLeft / 60000) }) : t('profile.abandons', { count: m.abandons24h });
    const top = best(me);
    const id = h(
      'div.mn-prof-id',
      null,
      top !== null ? rankBadge(tierById(top.tier), 56) : h('div.mn-avatar', null, v.name.slice(0, 1).toUpperCase()),
      h(
        'div.mn-prof-id-text',
        null,
        h('div.mn-profile-name', { 'data-fit': '20' }, v.name),
        h('div.mn-note', null, me ? t('profile.since', { date: shortDate(me.createdAt), providers: providerList(me) }) : ''),
        me && me.abandons24h > 0 ? h('div.mn-ban', null, abandons(me)) : null,
      ),
    );
    const fold = h('div.mn-prof-acct', { id: 'mn-prof-acct', hidden: !accountOpen });
    setChildren(
      fold,
      secondary(t('profile.rename'), () => renameDialog(), { 'data-key': 'profile-rename' }),
      me?.hasPassword !== false ? secondary(t('profile.changePassword'), () => passwordDialog(), { 'data-key': 'profile-password' }) : secondary(t('profile.setPassword'), () => passwordDialog(), { 'data-key': 'profile-password' }),
      secondary(t('profile.newCodes'), () => codesDialog(), { 'data-key': 'profile-codes' }),
      ...linkable.map((p) => secondary(t('profile.link', { provider: PROVIDER_NAMES[p].toUpperCase() }), () => (window.location.href = acc.oauthUrl(p, true)), { 'data-key': 'profile-link-' + p })),
      secondary(
        t('profile.signOut'),
        () => {
          void acc.logout().then(() => {
            menu.toast(t('profile.signedOut'), 'info');
            render();
          });
        },
        { 'data-key': 'profile-signout' },
      ),
    );
    const toggle = h(
      'button.mn-picker.mn-prof-fold',
      {
        type: 'button',
        'data-nav': true,
        'data-key': 'profile-account',
        'aria-expanded': String(accountOpen),
        'aria-controls': 'mn-prof-acct',
        onclick: () => {
          accountOpen = !accountOpen;
          fold.hidden = !accountOpen;
          toggle.setAttribute('aria-expanded', String(accountOpen));
          menu.refit();
        },
      },
      icon('lock'),
      h('span.mn-picker-label', null, t('profile.accountSecurity')),
      icon('next', 'mn-prof-fold-chev'),
    );
    const server = v.nodes.length > 0 ? section(t('profile.myServer'), h('div.mn-prof-nodes', null, ...v.nodes.map(nodeView))) : null;
    return h(
      'div.mn-prof-account',
      null,
      h('div.mn-prof-col', null, id, section(t('profile.season', { season: me?.season ?? 1 }), ranks(me)), server),
      h(
        'div.mn-prof-col',
        null,
        h('section.mn-section.mn-prof-security', null, toggle, fold),
        section(
          t('profile.community'),
          h('div.mn-prof-links', null, link(DISCORD_URL, 'friends', t('profile.discord'), 'profile-discord'), link(HOST_GUIDE(), 'server', t('profile.hostServer'), 'profile-host'), link(SOURCE_URL, 'code', t('profile.source'), 'profile-source')),
        ),
      ),
    );
  };

  /** ACERCA DE, under either view. */
  const about = section(
    t('profile.about'),
    h('p.mn-prof-about', null, t('profile.version', { game: GAME_NAME, version, protocol: PROTOCOL_VERSION })),
    h('p.mn-note.mn-prof-about', null, menu.host.info),
    h(
      'div.mn-prof-links',
      null,
      // Same tab: the viewer is its own page (replay.html), with a way back. Not on a TV: that page has
      // no remote or controller navigation yet.
      tv() ? null : h('a.mn-btn.mn-prof-link', { href: './replay.html', 'data-nav': true, 'data-key': 'profile-replays' }, icon('play'), h('span', null, t('profile.replays'))),
      h('a.mn-btn.mn-prof-link', { href: './third-party-licenses.txt', target: '_blank', rel: 'noopener', 'data-nav': true, 'data-key': 'profile-licenses' }, icon('info'), h('span', null, t('menu.licenses'))),
    ),
  );

  const renameDialog = (): void => {
    const hasPw = acc.me?.hasPassword !== false;
    const user = field(t('profile.newName'), { maxLength: USERNAME_MAX, value: acc.account?.name ?? '' });
    const pass = field(t('profile.yourPassword'), { type: 'password', autocomplete: 'current-password' });
    menu.modal({
      title: t('profile.renameTitle'),
      body: [h('p.mn-note', null, t('profile.renameNote')), user.el, hasPw ? pass.el : null],
      actions: [
        {
          label: t('profile.renameConfirm'),
          primary: true,
          onClick: async () => {
            user.error(null);
            pass.error(null);
            const username = user.input.value.trim();
            const userIssue = issueText(usernameIssue(username));
            if (userIssue !== null) {
              user.error(userIssue);
              return false;
            }
            try {
              await acc.rename(username, hasPw ? pass.input.value : null);
              menu.toast(t('profile.renamed'), 'ok');
              render();
              return true;
            } catch (e) {
              (hasPw ? pass : user).error(errText(e));
              return false;
            }
          },
        },
        { label: t('profile.cancel'), onClick: () => true },
      ],
    });
  };

  const passwordDialog = (): void => {
    const hasPw = acc.me?.hasPassword !== false;
    const old = field(t('profile.currentPassword'), { type: 'password', autocomplete: 'current-password' });
    const next = field(t('profile.newPassword'), { type: 'password', autocomplete: 'new-password' });
    const again = field(t('profile.repeatNewPassword'), { type: 'password', autocomplete: 'new-password' });
    menu.modal({
      title: hasPw ? t('profile.changePasswordTitle') : t('profile.setPasswordTitle'),
      body: [hasPw ? old.el : h('p.mn-note', null, t('profile.setPasswordNote')), next.el, again.el, h('p.mn-note', null, t('profile.othersSignedOut'))],
      actions: [
        {
          label: t('profile.save'),
          primary: true,
          onClick: async () => {
            old.error(null);
            next.error(null);
            again.error(null);
            if (next.input.value !== again.input.value) {
              again.error(t('profile.noMatch'));
              return false;
            }
            const passIssue = issueText(passwordIssue(next.input.value, acc.account?.name ?? '')); // the arguments AccountClient.changePassword checks
            if (passIssue !== null) {
              next.error(passIssue);
              return false;
            }
            try {
              await acc.changePassword(hasPw ? old.input.value : null, next.input.value);
              menu.toast(t('profile.passwordUpdated'), 'ok');
              void acc.fetchMe().then(() => render());
              return true;
            } catch (e) {
              (e instanceof AccountError && e.code === 'bad_credentials' ? old : next).error(errText(e));
              return false;
            }
          },
        },
        { label: t('profile.cancel'), onClick: () => true },
      ],
    });
  };

  const codesDialog = (): void => {
    const hasPw = acc.me?.hasPassword !== false;
    const pass = field(t('profile.yourPassword'), { type: 'password', autocomplete: 'current-password' });
    menu.modal({
      title: t('profile.newCodesTitle'),
      body: [h('p.mn-note', null, t('profile.newCodesNote')), hasPw ? pass.el : null],
      actions: [
        {
          label: t('profile.generate'),
          primary: true,
          onClick: async () => {
            try {
              const codes = await acc.newRecoveryCodes(hasPw ? pass.input.value : null);
              showRecoveryCodes(menu, codes, t('profile.newCodesIntro'));
              return false; // the codes dialog replaced this one
            } catch (e) {
              pass.error(errText(e));
              return false;
            }
          },
        },
        { label: t('profile.cancel'), onClick: () => true },
      ],
    });
  };


  const render = (): void => {
    const who = acc.account?.playerId ?? null;
    shownFor = who;
    shownMe = acc.me;
    const view =
      sample !== null
        ? accountView(sample)
        : acc.signedIn
          ? accountView({ name: acc.account?.name ?? '', me: acc.me, nodes: nodes !== null && nodes.who === who ? nodes.list : [] })
          : guestView();
    setChildren(body, view);
    menu.refit(); // a new view's name and titles (data-fit)
    menu.refocus();
  };

  /** The operator's nodes, once per visit (a fork or local dev answers none: AccountClient.myNodes). */
  const loadNodes = (): void => {
    const who = acc.account?.playerId ?? null;
    if (who === null) return;
    void acc.myNodes().then(
      (list) => {
        nodes = { who, list };
        if (el.isConnected && list.length > 0) render();
      },
      () => undefined, // offline: MI SERVIDOR waits for the next visit
    );
  };

  // The samples exist in development and in a VITE_UI_FIT=1 build only (read here: node tests import this module).
  if (import.meta.env.DEV || import.meta.env.VITE_UI_FIT === '1') {
    (window as unknown as { __profile: (kind: 'account' | 'operator' | null) => void }).__profile = (kind) => {
      sample = kind === null ? null : sampleAccount(kind === 'operator');
      render();
    };
  }

  // After `body`, so it stays through the guest / account swap (render).
  const el = h('div.mn-profile', { 'data-tablero': true }, screenHead(t('profile.heading')), body, about);
  // A session that comes or goes while PERFIL is up (restored at boot, signed out elsewhere): the
  // other view; an account's /api/me as it comes in (after a sign-up, a rename). A guest's view
  // stays as it is through every other change (a half-typed form).
  let shownFor = acc.account?.playerId ?? null;
  let shownMe = acc.me;
  acc.subscribe(() => {
    const who = acc.account?.playerId ?? null;
    if (who === shownFor && (who === null || acc.me === shownMe)) return;
    const signedIn = who !== shownFor && who !== null;
    if (el.isConnected) {
      render();
      if (signedIn) loadNodes();
    }
  });
  return {
    id: 'profile',
    title: t('profile.title'),
    el,
    show: () => {
      render();
      if (acc.signedIn) {
        void acc.fetchMe().then(render, () => undefined);
        loadNodes();
      }
    },
  };
}

/** Sample data for the layout check (window.__profile): a long name, three playlists, two nodes for an operator. */
function sampleAccount(operator: boolean): AccountData {
  const r = (playlist: PlaylistRating['playlist'], tier: string | null, placementLeft: number): PlaylistRating => ({ playlist, mmr: 1480, tier, games: 52, wins: 30, losses: 22, placementLeft, peakMmr: 1520 });
  const me: MeInfo = {
    playerId: 'sample',
    name: 'MaximilianoGomez',
    createdAt: Date.UTC(2026, 3, 4),
    providers: ['password', 'google'],
    hasPassword: true,
    renameAt: 0,
    ratings: [r('1v1', 'diamond-3', 0), r('2v2', 'platinum-1', 0), r('3v3', null, 3)],
    rankedBanUntil: 0,
    abandons24h: 1,
    season: 1,
    experimental: false,
  };
  const node = (name: string, status: MyNode['status'], online: boolean): MyNode => ({ nodeId: 'n-' + name, name, region: 'SA', status, statusReason: status === 'suspended' ? 'Too many lost matches this week' : null, suspendedUntil: null, online, counters: { verified: 318, probationVerified: 12 }, version: '1.4.2', compatible: status !== 'suspended' });
  return { name: me.name, me, nodes: operator ? [node('Buenos-Aires-VPS-largo', 'active', true), node('Casa-PC', 'suspended', false)] : [] };
}

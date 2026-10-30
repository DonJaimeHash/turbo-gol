/**
 * The sheets that come back from Google or Discord (the sign-in design's §3.8), opened by the
 * Game's arbiter (Game.ts restoreAccount) on `#auth=confirm`: an identity no Turbogol account owns.
 * Nothing exists yet, and nothing is made without the player's word (I3).
 *
 *   loading  "Un momento…" while POST /api/auth/pending answers (no restore() first: a new person
 *            has no account to restore)
 *   confirm  no match: "¿Ya tienes cuenta en Turbogol?", the provider's account (and its address
 *            when it gave a verified one), the in-game name (Jugador4821: the guest's digits, never
 *            the provider's name or the address; no autofocus, so a stray A opens no keypad) and
 *            the news switch at NO; NO, CREAR MI CUENTA (first, focused: a solved check, then
 *            POST /api/auth/pending/create) and SÍ, YA TENGO UNA
 *   match    the address is an account's (claimed or as a hint): "Este correo ya tiene una cuenta",
 *            one button per way into that account (its password: the sign-in below, prefilled with
 *            its name; its providers: start?pend=1), CANCELAR; creating is refused (one email,
 *            one account)
 *   have one the username sign-in with linkPending (the identity goes on the account it signs in
 *            to, the match only when there is one) and ENTRAR CON {the other provider} (pend=1)
 *
 * After a create the game never opens PERFIL: the arbiter's next step (the phone's /tv) comes. The
 * flow resolves 'created', 'signedIn' or 'closed' (a provider button leaves the page instead).
 */
import { h } from '../dom';
import { AccountError, oauthErrorText } from '../../net/AccountClient';
import type { PendingInfo } from '../../net/AccountClient';
import { USERNAME_MAX, usernameIssue } from '../../net/account';
import type { OAuthProvider } from '../../net/account';
import { guestNumber } from '../../net/guestName';
import type { Menu } from '../Menu';
import type { SheetAction } from '../components/sheet';
import { setRow, toggleSwitch } from '../components/rows';
import { field } from './common';
import { errText } from './profile';
import { namePrefill } from './accountLinksModel';
import { language, t } from '../../i18n';

/** How the flow ended. */
export type PendingOutcome = 'created' | 'signedIn' | 'closed';

const PROVIDER_NAMES: Readonly<Record<OAuthProvider, string>> = { google: 'Google', discord: 'Discord' };

/** A provider's name as the sheets write it. */
export function providerName(p: OAuthProvider): string {
  return PROVIDER_NAMES[p];
}

/** The providers this server has (GET /api/config `oauth`). */
function configured(menu: Menu): OAuthProvider[] {
  return ((menu.cfg?.oauth ?? []) as string[]).filter((p): p is OAuthProvider => p === 'google' || p === 'discord');
}

/** The player's IANA time zone for the dates of its mail ('' when the browser says none). */
function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/** The menus up and no other sheet, as the other URL sheets wait. */
async function sheetsReady(menu: Menu): Promise<void> {
  while (!menu.visible || menu.modalOpen) await new Promise((r) => setTimeout(r, 200));
}

/** A paragraph that describes its sheet (aria-describedby once it is up). */
function describe(text: string): HTMLElement {
  return h('p.mn-note.mn-confirm-desc', { id: 'mn-confirm-desc' }, text);
}

function linkDescription(): void {
  const d = document.getElementById('mn-confirm-desc');
  d?.closest('[role="dialog"]')?.setAttribute('aria-describedby', d.id);
}

/**
 * `#auth=confirm` came back (or `#auth=error:no_account`, the pending identity kept): the loading
 * sheet, then the confirm or the match sheet. Resolves once the flow is over.
 */
export async function confirmPending(menu: Menu): Promise<PendingOutcome> {
  await sheetsReady(menu);
  return new Promise<PendingOutcome>((resolve) => {
    let over = false;
    const end = (o: PendingOutcome): void => {
      if (over) return;
      over = true;
      resolve(o);
    };
    let loaded = false;
    const closeLoading = menu.modal({
      title: t('auth.confirmLoading'),
      body: h('p.mn-note', null, t('auth.confirmLoadingText')),
      actions: [{ label: t('auth.cancel'), onClick: () => (void menu.host.accounts.cancelPending(), true) }],
      onClose: () => {
        if (!loaded) end('closed');
      },
    });
    void load(menu, end, () => {
      loaded = true;
      return closeLoading;
    });
  });
}

/**
 * POST /api/auth/pending, then the sheet for its answer, which replaces the one up. `took`: that
 * sheet is done with (its closer, for an answer that opens no other).
 */
async function load(menu: Menu, end: (o: PendingOutcome) => void, took: () => () => void): Promise<void> {
  let info: PendingInfo | null = null;
  let failed: unknown = null;
  try {
    info = await menu.host.accounts.pending();
  } catch (e) {
    failed = e;
  }
  const close = took();
  if (info === null) {
    close();
    menu.toast(failed !== null ? errText(failed) : t('auth.pendingExpired'), 'error');
    end('closed');
    return;
  }
  if (info.match !== null) matchSheet(menu, info, end);
  else confirmSheet(menu, info, end);
}

/** No account uses this identity, and its address leads to none: create one, or sign in to one and link. */
function confirmSheet(menu: Menu, info: PendingInfo, end: (o: PendingOutcome) => void): void {
  const acc = menu.host.accounts;
  const p = providerName(info.provider);
  let handed = false;
  const name = field(t('auth.gameName'), { autocomplete: 'nickname', maxLength: USERNAME_MAX, value: namePrefill(t('auth.nameWord'), guestNumber(menu.host.guestName())), enterkeyhint: 'done' });
  let news = false;
  const sw = toggleSwitch('auth-news', t('auth.news'), () => news, (v) => (news = v));
  const create: SheetAction = {
    label: t('auth.create'),
    primary: true,
    // The first focus, before the name field: a stray A or Enter opens no keypad and types nothing.
    autofocus: true,
    onClick: async () => {
      name.error(null);
      const username = name.input.value.trim();
      const issue = usernameIssue(username);
      if (issue !== null) {
        name.error(t(`account.issue.${issue.code}`, issue.params));
        return false;
      }
      try {
        const s = await acc.createAccount(username, { news, lang: language(), tz: timeZone() });
        handed = true;
        menu.toast(t('game.welcomeNew', { name: s.name }), 'ok');
        void acc.fetchMe().catch(() => undefined);
        end('created');
        return true;
      } catch (e) {
        if (e instanceof AccountError && e.code === 'username_taken' && e.suggest !== null) {
          name.input.value = e.suggest;
          name.error(e.message);
          return false;
        }
        if (e instanceof AccountError && e.code === 'email_has_account') {
          // A race: the address got an account meanwhile. The match sheet says what to do.
          handed = true;
          void load(menu, end, () => close);
          return false;
        }
        if (e instanceof AccountError && (e.code === 'no_pending' || e.code === 'already_linked')) {
          menu.toast(e.code === 'no_pending' ? t('auth.pendingExpired') : errText(e), 'error');
          return true;
        }
        name.error(errText(e));
        return false;
      }
    },
  };
  const haveOne: SheetAction = {
    label: t('auth.haveOne'),
    onClick: () => {
      handed = true;
      haveOneSheet(menu, info, null, end, () => confirmSheet(menu, info, end));
      return false;
    },
  };
  const close = menu.modal({
    title: t('auth.confirmTitle'),
    body: [
      describe(info.email !== null ? t('auth.confirmNone', { provider: p, email: info.email }) : t('auth.confirmNoneNoEmail', { provider: p })),
      info.second !== null ? h('p.mn-note', null, t('auth.confirmSecond', { provider: providerName(info.second) })) : null,
      info.trust === 'none' ? h('p.mn-note', null, t('auth.confirmNoEmail', { provider: p })) : null,
      name.el,
      h('p.mn-note', null, t('auth.gameNameHint')),
      setRow(t('auth.news'), sw.el),
    ],
    actions: [create, haveOne],
    onClose: () => {
      if (handed) return;
      void acc.cancelPending();
      end('closed');
    },
  });
  linkDescription();
}

/** The address is an account's: that account signs in and links; no second account. */
function matchSheet(menu: Menu, info: PendingInfo, end: (o: PendingOutcome) => void): void {
  const acc = menu.host.accounts;
  const m = info.match;
  if (m === null) return confirmSheet(menu, info, end);
  const p = providerName(info.provider);
  let handed = false;
  const ways: SheetAction[] = [];
  if (m.methods.includes('password')) {
    ways.push({
      label: t('auth.matchPassword'),
      onClick: () => {
        handed = true;
        haveOneSheet(menu, info, m.name, end, () => matchSheet(menu, info, end));
        return false;
      },
    });
  }
  for (const w of m.methods) {
    if (w === 'password' || !configured(menu).includes(w)) continue;
    ways.push({
      label: t('tvlink.signInWith', { provider: providerName(w).toUpperCase() }),
      onClick: () => {
        handed = true;
        window.location.href = acc.oauthUrl(w, 'pend');
        return false;
      },
    });
  }
  if (ways.length > 0) ways[0].primary = true;
  menu.modal({
    title: t('auth.matchTitle'),
    body: [describe(t('auth.matchBody', { email: m.email, name: m.name, provider: p })), info.trust === 'asserted' ? h('p.mn-note', null, t('auth.matchNotYours', { provider: p })) : null],
    actions: [...ways, { label: t('auth.cancel'), onClick: () => true }],
    onClose: () => {
      if (handed) return;
      void acc.cancelPending();
      end('closed');
    },
  });
  linkDescription();
}

/**
 * "I already have one": sign in to that account here (the username sign-in, sent with linkPending)
 * or with the other provider (start?pend=1), and the identity is linked to it. `user`: the match's
 * name, prefilled. VOLVER: `back` (the sheet before).
 */
function haveOneSheet(menu: Menu, info: PendingInfo, user: string | null, end: (o: PendingOutcome) => void, back: () => void): void {
  const acc = menu.host.accounts;
  const p = providerName(info.provider);
  let handed = false;
  const userField = field(t('profile.username'), { autocomplete: 'username', maxLength: 64, value: user ?? acc.hintName ?? '', enterkeyhint: 'next' });
  const pass = field(t('profile.password'), { type: 'password', autocomplete: 'current-password', maxLength: 128, enterkeyhint: 'go' });
  const others = configured(menu).filter((o) => o !== info.provider && o !== info.second);
  menu.modal({
    title: t('auth.haveOneTitle'),
    body: [describe(t('auth.haveOneLine', { provider: p })), userField.el, pass.el],
    actions: [
      {
        label: t('profile.signIn'),
        primary: true,
        onClick: async () => {
          pass.error(null);
          try {
            const r = await acc.loginAndLink(userField.input.value, pass.input.value);
            handed = true;
            menu.toast(r.linked.length > 0 ? t('auth.linkedProvider', { provider: r.linked.map(providerName).join(' · ') }) : `${t('profile.hello', { name: r.session.name })}. ${oauthErrorText(r.linkError ?? 'no_pending')}`, r.linked.length > 0 ? 'ok' : 'error');
            void acc.fetchMe().catch(() => undefined);
            end('signedIn');
            return true;
          } catch (e) {
            pass.error(errText(e));
            return false;
          }
        },
      },
      ...others.map(
        (o): SheetAction => ({
          label: t('tvlink.signInWith', { provider: providerName(o).toUpperCase() }),
          onClick: () => {
            handed = true;
            window.location.href = acc.oauthUrl(o, 'pend');
            return false;
          },
        }),
      ),
      {
        label: t('auth.back'),
        onClick: () => {
          handed = true;
          back();
          return false;
        },
      },
    ],
    onClose: () => {
      if (handed) return;
      void acc.cancelPending();
      end('closed');
    },
  });
  linkDescription();
}

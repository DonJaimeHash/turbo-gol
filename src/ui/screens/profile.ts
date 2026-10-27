/**
 * Profile: for a guest, sign in / create an account / recover with a recovery code (plus Google /
 * Discord when the server enables them) and the guest name; for an account, the ranks of the
 * season, abandons, and the account actions (rename, password, recovery codes, link a provider,
 * sign out). Passwords go through AccountClient (hashed in the browser before they leave).
 * Usernames and passwords are checked here first (usernameIssue / passwordIssue, the same rules
 * AccountClient and the server apply) so the form shows the reason in the player's language.
 */
import { h, setChildren, copyText, navButton } from '../dom';
import { AccountError } from '../../net/AccountClient';
import { PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN, passwordIssue, usernameIssue } from '../../net/account';
import type { AccountIssue, MeInfo, OAuthProvider } from '../../net/account';
import { ratingCard } from '../badges';
import type { Menu, Screen } from '../Menu';
import { field, primary, screenHead, secondary, section } from './common';
import { language, t } from '../../i18n';

const PROVIDER_NAMES: Readonly<Record<OAuthProvider, string>> = { google: 'Google', discord: 'Discord' };

function errText(e: unknown): string {
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

function onEnter(inputs: HTMLInputElement[], go: () => void): void {
  // Not the Enter / OK that starts editing a field reached with the arrows (Menu.onFieldKey cancels it).
  for (const i of inputs) i.addEventListener('keydown', (e) => e.key === 'Enter' && !e.defaultPrevented && go());
}

export function profileScreen(menu: Menu): Screen {
  const acc = menu.host.accounts;
  const body = h('div.mn-profile-body');
  let tab: 'login' | 'register' | 'recover' = 'login';

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
    const user = field(t('profile.username'), { autocomplete: 'username', maxLength: 64, value: acc.hintName ?? '' });
    const pass = field(t('profile.password'), { type: 'password', autocomplete: 'current-password', maxLength: 128 });
    user.input.setAttribute('data-autofocus', '');
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
    return h('form.mn-form', { onsubmit: (e: Event) => e.preventDefault() }, user.el, pass.el, primary(t('profile.signIn'), () => void go()), oauthButtons());
  };

  const registerForm = (): HTMLElement => {
    const user = field(t('profile.username'), { autocomplete: 'username', maxLength: USERNAME_MAX, placeholder: t('profile.usernameHint', { min: USERNAME_MIN, max: USERNAME_MAX }) });
    const pass = field(t('profile.password'), { type: 'password', autocomplete: 'new-password', maxLength: 128, placeholder: t('profile.passwordHint', { count: PASSWORD_MIN }) });
    const pass2 = field(t('profile.repeatPassword'), { type: 'password', autocomplete: 'new-password', maxLength: 128 });
    user.input.setAttribute('data-autofocus', '');
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
    return h('form.mn-form', { onsubmit: (e: Event) => e.preventDefault() }, user.el, pass.el, pass2.el, primary(t('profile.createAccount'), () => void go()), oauthButtons());
  };

  const recoverForm = (): HTMLElement => {
    const user = field(t('profile.username'), { autocomplete: 'username', maxLength: 64, value: acc.hintName ?? '' });
    const code = field(t('profile.recoveryCode'), { placeholder: 'XXXX-XXXX', maxLength: 16 });
    const pass = field(t('profile.newPassword'), { type: 'password', autocomplete: 'new-password', maxLength: 128 });
    user.input.setAttribute('data-autofocus', '');
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
    return h('form.mn-form', { onsubmit: (e: Event) => e.preventDefault() }, user.el, code.el, pass.el, primary(t('profile.resetPassword'), () => void go()));
  };

  const guestView = (): HTMLElement => {
    const tabs = h(
      'div.mn-tabs',
      null,
      ...(
        [
          ['login', t('profile.tabSignIn')],
          ['register', t('profile.tabRegister')],
          ['recover', t('profile.tabRecover')],
        ] as const
      ).map(([id, label]) =>
        navButton(`mn-tab${tab === id ? ' mn-tab-on' : ''}`, label, () => {
          tab = id;
          render();
        }, { 'data-key': 'profile-tab-' + id }),
      ),
    );
    const form = tab === 'login' ? loginForm() : tab === 'register' ? registerForm() : recoverForm();
    const name = field(t('profile.guestName'), { maxLength: 16, value: menu.host.guestName() });
    const saveName = (): void => {
      menu.host.setGuestName(name.input.value);
      name.input.value = menu.host.guestName();
      menu.refreshChrome();
      menu.toast(t('profile.guestNameSaved'), 'ok');
    };
    onEnter([name.input], saveName);
    return h(
      'div.mn-profile-guest',
      null,
      h('div.mn-auth', null, tabs, form),
      h('aside.mn-auth-side', null, section(t('profile.playAsGuest'), h('p.mn-note', null, t('profile.guestNote')), name.el, secondary(t('profile.saveName'), saveName))),
    );
  };

  const accountView = (): HTMLElement => {
    const me = acc.me;
    const name = acc.account?.name ?? '';
    const ratings = h('div.mn-profile-ratings', null, ...(me ? me.ratings.map((r) => ratingCard(r)) : [h('div.mn-empty', null, t('profile.loading'))]));
    const banLeft = me ? me.rankedBanUntil - Date.now() : 0;
    const providers = (menu.cfg?.oauth ?? []) as OAuthProvider[];
    const linkable = providers.filter((p) => me && !me.providers.includes(p));
    const abandons = (m: MeInfo): string =>
      banLeft > 0 ? t('profile.abandonsBanned', { count: m.abandons24h, minutes: Math.ceil(banLeft / 60000) }) : t('profile.abandons', { count: m.abandons24h });
    return h(
      'div.mn-profile-account',
      null,
      h(
        'div.mn-profile-id',
        null,
        h('div.mn-avatar', null, name.slice(0, 1).toUpperCase()),
        h(
          'div',
          null,
          h('div.mn-profile-name', null, name),
          h('div.mn-note', null, me ? t('profile.since', { date: shortDate(me.createdAt), providers: providerList(me) }) : ''),
          me && me.abandons24h > 0 ? h('div.mn-ban', null, abandons(me)) : null,
        ),
      ),
      section(t('profile.season', { season: me?.season ?? 1 }), ratings),
      section(
        t('profile.account'),
        h(
          'div.mn-actions.mn-actions-wrap',
          null,
          secondary(t('profile.rename'), () => renameDialog()),
          me?.hasPassword !== false ? secondary(t('profile.changePassword'), () => passwordDialog()) : secondary(t('profile.setPassword'), () => passwordDialog()),
          secondary(t('profile.newCodes'), () => codesDialog()),
          ...linkable.map((p) => secondary(t('profile.link', { provider: PROVIDER_NAMES[p].toUpperCase() }), () => (window.location.href = acc.oauthUrl(p, true)))),
          secondary(t('profile.signOut'), () => {
            void acc.logout().then(() => {
              menu.toast(t('profile.signedOut'), 'info');
              render();
            });
          }),
        ),
      ),
    );
  };

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
    setChildren(body, acc.signedIn ? accountView() : guestView());
    menu.refocus();
  };

  const el = h('div.mn-profile', null, screenHead(t('profile.heading')), body);
  return {
    id: 'profile',
    title: t('profile.title'),
    el,
    show: () => {
      render();
      if (acc.signedIn) void acc.fetchMe().then(render, () => undefined);
    },
  };
}

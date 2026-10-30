/**
 * PERFIL (plan PR 13, dir-hub §6.8), the section's root.
 *
 * An account: the identity tile (badge of your best rank, name, since when and how you sign in,
 * abandons), TEMPORADA (a tile per playlist: rank in words, MMR or the placement left, the record),
 * MI SERVIDOR for a community node operator (GET /nodes/mine: each node, its state in words, its
 * region, the matches it hosted, its version), CUENTA Y SEGURIDAD folded (a disclosure: rename,
 * the password (CAMBIAR with the current one; CREAR by a link to the account's own mailbox, or "add
 * an email first"), link a provider, the signed-in devices (each with where it signed in and a
 * sign-out of its own), sign out, sign out on every device), COMUNIDAD (Discord, host a server, the
 * source), ACERCA DE (version, licences, the technical line).
 *
 * A guest (email accounts, sign-in PR 8: the sign-in design's §3.0 to §3.7), one column for the
 * arrows: CREAR CUENTA GRATIS (the hero) and INICIAR SESIÓN, the screen's two tabs (`.mn-tabs`, a nav
 * row: Q / E step them, the hint bar says so), then the tab's form, then the line with the guest's
 * name (the server's, temporary: a guest never chooses or changes it).
 * - CREAR CUENTA: the address and CONTINUAR (a mailed 6-digit code, the attempt kept in
 *   sessionStorage), then on one screen the code (it checks itself at the sixth digit), the in-game
 *   name, the password with MOSTRAR, the news switch and CREAR CUENTA, with REENVIAR after a minute,
 *   "use another email" and YA TENGO CUENTA. Back, B or Esc goes back a step; PERFIL brings the code
 *   step back after a reload. The provider buttons and, while usernames still sign in, the way to
 *   sign in with one and add an email.
 * - INICIAR SESIÓN: "continue as" the last way this device signed in, one field for an address or a
 *   username of before (an '@' signs in by email; without one the legacy sign-in, until its cutoff:
 *   then no request), the password with MOSTRAR, ENTRAR, ¿Olvidaste tu contraseña? (an address: the
 *   forgot sheet; a username: the recovery code form of before), the providers.
 * On a TV only INICIAR SESIÓN CON EL TELÉFONO (focused: the code and its QR in a sheet,
 * screens/tvSignIn.ts): accounts are made and email sign-ins typed on the phone (§3.11). Fields say
 * what a phone keyboard's Enter does (enterkeyhint: next, then go / done) and Enter does it
 * (onEnter); the Menu keeps the focused field above a phone's keyboard (keyboard.ts). A sign-in here
 * from Competitive's SIGN IN goes back there (modes.ts: the return with intent). Passwords go through
 * AccountClient (hashed in the browser before they leave). Names and passwords are checked here first
 * (usernameIssue / passwordIssue, the same rules AccountClient and the server apply) so the form
 * shows the reason in the player's language. The forms that send mail follow GET /api/config's
 * auth.email (AccountClient.authConfig). Both views end with ACERCA DE (the language is Settings ›
 * Game's Idioma, PR 11). The mailed links' sheets are accountLinks.ts.
 * In development (or a VITE_UI_FIT=1 build) window.__profile(kind | null) shows an account's or an
 * operator's sample (scripts/ui-fit.mjs).
 */
import { h, setChildren, navButton } from '../dom';
import { AccountError } from '../../net/AccountClient';
import type { AuthConfig } from '../../net/AccountClient';
import { REGIONS, USERNAME_MAX, emailTypo, normalizeEmail, passwordIssue, usernameIssue } from '../../net/account';
import type { AccountIssue, DeviceSession, MeInfo, MyNode, OAuthProvider, PlaylistRating } from '../../net/account';
import { emailNudge, signInRoute } from '../../net/emailAuth';
import type { StoredAttempt } from '../../net/emailAuth';
import { authErrText, cutoffDay, emailProviders, emailSheet, googleHidden, graceSheet, graceText, keypadTyping, mailOffText, newPasswordFields, openForgotSheet, openReauthCodeSheet, passwordManagerUser, providersLine, sheetEnter, signupFinishFields, startEmailCode, welcome } from './accountLinks';
import type { EmailHooks } from './accountLinks';
import { PROTOCOL_VERSION } from '../../net/protocol';
import { PROBATION_MATCHES } from '../../../nodes/control-plane/registry';
import { ratingCard, rankBadge, tierById } from '../badges';
import { playerName, regionName } from '../names';
import type { Menu, Screen } from '../Menu';
import { codeField, field, primary, screenHead, secondary, section } from './common';
import { finePointer } from '../device';
import { icon } from '../components/icons';
import type { IconName } from '../components/icons';
import { slot } from '../components/tile';
import { setRow, toggleSwitch } from '../components/rows';
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

/** A dev sign-in name (server/src/accountStore.ts DEV_NAME_RE, the same rule: a test pins it). */
const DEV_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** A page served from this machine (Vite or wrangler dev): only there does PERFIL ask whether the dev sign-in is open. */
function loopbackPage(): boolean {
  const host = typeof location === 'undefined' ? '' : location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

/**
 * The longest lock of a (username, network) pair and the pause of a network (AccountsDO
 * LOGIN_LOCK_MAX_MS, LOGIN_NET_PAUSE_MS): a longer wait is the pause of a username's failures from
 * new browsers (30 minutes to an hour), which a browser that signed in there before skips.
 */
const PAIR_LOCK_MAX_MS = 15 * 60_000;

/** An account error in the player's words (a throttle with its seconds; a username's pause says what to do). */
export function errText(e: unknown): string {
  if (e instanceof AccountError) {
    if (e.code === 'throttled' && e.retryAfterMs > PAIR_LOCK_MAX_MS) return t('profile.retryNewDevice', { minutes: Math.ceil(e.retryAfterMs / 60_000) });
    if (e.code === 'throttled' && e.retryAfterMs > 0) return t('profile.retryAfter', { message: e.message, seconds: Math.ceil(e.retryAfterMs / 1000) });
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * A form's button while its request runs (two key derivations and an anti-bot check can take a
 * second on a phone): a second press is ignored and aria-busy says so. Not `disabled`, which would
 * drop the focus a remote or a pad stands on.
 */
async function busyWhile(btn: HTMLElement, fn: () => Promise<void>): Promise<void> {
  if (btn.getAttribute('aria-busy') === 'true') return;
  btn.setAttribute('aria-busy', 'true');
  try {
    await fn();
  } finally {
    btn.removeAttribute('aria-busy');
  }
}

/** What is wrong with a username or password (src/net/account.ts), in the player's language; null when nothing. */
function issueText(issue: AccountIssue | null): string | null {
  return issue === null ? null : t(`account.issue.${issue.code}`, issue.params);
}

/**
 * CUENTA DEL PROYECTO's lines (the sign-in design's §3.12 step 5), from /api/me's `maintainer`, which
 * the server sends to the project's maintainer accounts (NODE_TRUSTED_OPERATORS) only: a password, a
 * verified email and at least two ways in, each in words and whether it is done.
 */
export function maintainerChecks(m: NonNullable<MeInfo['maintainer']>): Array<{ text: string; ok: boolean }> {
  return [
    { ok: m.password, text: t(m.password ? 'profile.maintainerPassword' : 'profile.maintainerNoPassword') },
    { ok: m.verifiedEmail, text: t(m.verifiedEmail ? 'profile.maintainerEmail' : 'profile.maintainerNoEmail') },
    { ok: m.waysIn >= 2, text: t('profile.maintainerWays', { count: m.waysIn }) },
  ];
}

/**
 * An unlink the server takes (accountStore.ts unlink): any account's, or the project account's while
 * it keeps its password and two ways in after it (409 maintainer_two_ways otherwise: PERFIL says so
 * without asking for the password first).
 */
export function unlinkKeepsMaintainer(me: MeInfo): boolean {
  return me.maintainer === undefined || (me.maintainer.password && me.maintainer.waysIn - 1 >= 2);
}

/** 'email, Google': how the account signs in (translated): its password by its address, or by its username of before. */
function providerList(me: MeInfo): string {
  return me.providers.map((p) => (p === 'password' ? t(me.emailVerified === true ? 'profile.providerEmail' : 'profile.providerUsername') : PROVIDER_NAMES[p])).join(', ');
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

/** A guest's tab: the sign-in, the sign-up, the recovery code form of before (until the cutoff). */
type GuestTab = 'login' | 'register' | 'recover';

/** Where the next PERFIL visit starts (openProfileTab): a tab, and the address for its field. */
let profileIntent: { tab: 'login' | 'register'; email: string | null } | null = null;

/**
 * Open PERFIL on a guest's tab (a mailed link's sheet: "your account exists, sign in", "ask for
 * another code"), the sign-in field prefilled with `email`.
 */
export function openProfileTab(menu: Menu, tab: 'login' | 'register', email: string | null): void {
  profileIntent = { tab, email };
  menu.open('profile');
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
  /**
   * A field focused by script after a press (CONTINUAR, "continue as") arrives in editing mode: a
   * pad's A then opens no keypad, and without a fine pointer a system keyboard could pop up. Only a
   * fine pointer, untouched, gets that focus (pickTab's rule); a pad or a remote reaches the field
   * with the arrows (navigation mode), where A opens mn-keypad.
   */
  const typesHere = (): boolean => !touch() && finePointer();
  let tab: GuestTab = 'login';
  /** The signed-in account's community nodes (GET /nodes/mine), by account. */
  let nodes: { who: string; list: MyNode[] } | null = null;
  /** PRIVACIDAD's switch (GET /api/me/replay-name), by account: null until it is read; the switch on screen. */
  let replayHidden: { who: string; hidden: boolean } | null = null;
  let replaySwitch: { refresh(): void } | null = null;
  /** CUENTA Y SEGURIDAD unfolded. */
  let accountOpen = false;
  let sample: AccountData | null = null;

  // ---- a guest: the email accounts' forms (sign-in PR 8) ------------------------------------------

  /** GET /api/config's auth (AccountClient.authConfig), null until it comes: meanwhile the forms assume mail goes and usernames sign in. */
  let authCfg: AuthConfig | null = null;
  /** A guest's field was typed in: the config's answer never redraws a form under the player's fingers. */
  let typed = false;
  /** CREAR CUENTA's step: the address, then (with an attempt kept) the code and the finish on one screen. */
  let step: 'email' | 'code' = 'email';
  /** What CREAR CUENTA's field shows (kept across a Back from the code step, and "use another email"). */
  let signupEmail = '';
  /** What the sign-in field starts with once (YA TENGO CUENTA, an account that exists already). */
  let loginPrefill: string | null = null;
  /** The username the recovery form starts with ("Forgot your password?" with a username typed). */
  let recoverPrefill: string | null = null;
  /** The code step's REENVIAR countdown (the screen's tick runs it). */
  let resendTick: (() => void) | null = null;
  /** The first visit of this page: a sign-up that waits for its code comes back to its step. */
  let firstShow = true;

  const mailOn = (): boolean => authCfg?.email !== false;
  const legacyPhase = (): AuthConfig['legacy'] => authCfg?.legacy ?? 'none';
  const loadAuthConfig = (): void => {
    if (authCfg !== null) return;
    void acc.authConfig().then((c) => {
      const changed = c.email !== mailOn() || c.legacy !== legacyPhase() || c.legacyUntil !== null;
      authCfg = c;
      // A guest's half-typed form is never redrawn; an account's view has nothing typed (its banner, its rows).
      if (changed && el.isConnected && sample === null && (acc.signedIn || !typed)) render();
    });
  };

  /** A provider's round trip: this device remembers it for "continue as" once it comes back signed in. */
  const goProvider = (p: OAuthProvider): void => {
    acc.providerStarted(p);
    window.location.href = acc.oauthUrl(p);
  };

  /** "o" and Entrar con {provider} for each configured one (Google hidden inside another app's browser, which says why). */
  const oauthButtons = (): HTMLElement | null => {
    const list = emailProviders(menu);
    const note = googleHidden(menu) ? h('p.mn-note', null, t('auth.inAppGoogle', { site: location.hostname })) : null;
    if (list.length === 0 && note === null) return null;
    return h(
      'div.mn-oauth',
      null,
      h('div.mn-or', null, t('profile.or')),
      ...list.map((p) => navButton(`mn-btn mn-oauth-${p}`, t('profile.signInWith', { provider: PROVIDER_NAMES[p] }), () => goProvider(p))),
      note,
    );
  };

  /** "Continuar como {name} · {method}": the last way this device signed in (a provider's button; for email it focuses the field). */
  const lastButton = (identity: HTMLInputElement): HTMLElement | null => {
    const last = acc.lastSignIn();
    if (last === null) return null;
    const provider = last.method === 'email' ? null : last.method;
    if (provider !== null && !emailProviders(menu).includes(provider)) return null;
    const method = provider !== null ? PROVIDER_NAMES[provider] : t('auth.methodEmail');
    // Email: the field, to type in (a finger's tap or a fine pointer), or its keypad (a pad's A, a remote's OK).
    const typeIdentity = (): void => {
      if (touch() || finePointer()) identity.focus();
      else menu.openKeypad(identity);
    };
    return secondary(t('auth.continueAs', { name: last.name, method }), () => (provider !== null ? goProvider(provider) : typeIdentity()), { 'data-key': 'profile-continue' });
  };

  /** Usernames no longer sign in (the cutoff, sign-in PR 9): what to do instead, and the providers when there are some. */
  const legacyClosedText = (): string => {
    const providers = providersLine(menu);
    return providers.length > 0 ? `${t('error.account.legacy_closed')} ${t('auth.legacyClosedProviders', { providers })}` : t('error.account.legacy_closed');
  };

  /**
   * INICIAR SESIÓN (§3.3): one field for an address or a username of before. An '@' signs in by
   * email; without one, the legacy sign-in while it lasts, and after the cutoff legacy_closed with
   * no request and CREAR CUENTA NUEVA. bad_credentials says which, with its hint under it.
   */
  const loginForm = (): HTMLElement => {
    const closed = legacyPhase() === 'closed';
    const user = field(closed ? t('auth.email') : t('auth.identity'), { autocomplete: 'username', maxLength: 254, value: loginPrefill ?? '', enterkeyhint: 'next', inputmode: 'email', keypad: 'email' });
    loginPrefill = null;
    const pass = field(t('profile.password'), { type: 'password', autocomplete: 'current-password', maxLength: 128, enterkeyhint: 'go', reveal: true });
    const hint = h('p.mn-note.mn-prof-hint', { hidden: true });
    const newAccount = secondary(t('auth.newAccount'), () => pickTab('register'), { 'data-key': 'profile-new-account', hidden: true });
    const go = async (): Promise<void> => {
      user.error(null);
      pass.error(null);
      hint.hidden = true;
      newAccount.hidden = true;
      const route = signInRoute(user.input.value, legacyPhase());
      if (route.kind === 'empty') return user.error(t('auth.emptyIdentity'));
      if (route.kind === 'bad_email') return user.error(t('error.account.bad_email'));
      if (route.kind === 'closed') {
        user.error(legacyClosedText());
        newAccount.hidden = false;
        return;
      }
      try {
        if (route.kind === 'email') await acc.signIn(route.email, pass.input.value);
        else await acc.legacySignIn(route.username, pass.input.value);
        acc.dropSignupAttempt();
        menu.toast(t('profile.hello', { name: acc.account?.name ?? '' }), 'ok');
        // A username's sign-in (§3.10 step 3): the sheet that asks for an email, not only the banner.
        void acc.fetchMe().then((me) => {
          if (route.kind === 'legacy' && me !== null && emailNudge(me, acc.account?.tv === true) !== null) openGrace(me);
        }, () => undefined);
        render();
      } catch (e) {
        pass.error(authErrText(menu, e));
        if (e instanceof AccountError && e.code === 'bad_credentials') {
          const providers = providersLine(menu);
          const text = route.kind === 'legacy' ? t('auth.badLegacyHint') : providers.length > 0 ? t('auth.badCredentialsHint', { providers }) : null;
          if (text !== null) {
            hint.textContent = text;
            hint.hidden = false;
          }
        }
      }
    };
    const btn = primary(t('profile.signIn'), () => void busyWhile(btn, go), { 'data-key': 'profile-go' });
    onEnter([user.input, pass.input], () => void busyWhile(btn, go));
    // An address (or nothing): the forgot sheet, prefilled. A username of before: its recovery code form.
    const forgot = navButton(
      'mn-link mn-prof-forgot',
      t('profile.forgot'),
      () => {
        const v = user.input.value.trim();
        if (v.length > 0 && !v.includes('@') && legacyPhase() !== 'closed') {
          recoverPrefill = v;
          pickTab('recover');
        } else openForgotSheet(menu, v.includes('@') ? v : '', mailOn());
      },
      { 'data-key': 'profile-forgot' },
    );
    return h('form.mn-form', { onsubmit: (e: Event) => e.preventDefault() }, lastButton(user.input), user.el, pass.el, btn, hint, newAccount, forgot, oauthButtons());
  };

  /**
   * CREAR CUENTA, its first step (§3.1 steps 1 to 3): the address ("Did you mean …?" for a common
   * typo), CONTINUAR (the anti-bot check, POST signup/start), the providers, and while usernames
   * sign in the way to sign in with one. With the mail off it says so instead.
   */
  const signupEmailForm = (): HTMLElement => {
    const providers = providersLine(menu);
    const legacyLine = legacyPhase() !== 'closed' ? navButton('mn-link mn-prof-legacy', t('auth.legacyHint'), () => pickTab('login'), { 'data-key': 'profile-legacy' }) : null;
    const providersHint = providers.length > 0 ? h('p.mn-note', null, t('auth.providersHint', { providers })) : null;
    if (!mailOn()) return h('form.mn-form', { onsubmit: (e: Event) => e.preventDefault() }, h('p.mn-note', null, mailOffText(menu)), oauthButtons(), legacyLine);
    const email = field(t('auth.email'), { type: 'email', autocomplete: 'email', maxLength: 254, value: signupEmail, enterkeyhint: 'go', inputmode: 'email', keypad: 'email', hint: t('auth.signupNote') });
    const typo = h('div.mn-prof-typo');
    const showTypo = (): void => {
      const fix = emailTypo(email.input.value);
      setChildren(typo, fix === null ? null : navButton('mn-link', t('auth.typo', { email: fix }), () => ((email.input.value = fix), showTypo()), { 'data-key': 'profile-typo' }));
    };
    email.input.addEventListener('input', showTypo);
    showTypo();
    const go = async (): Promise<void> => {
      email.error(null);
      const address = normalizeEmail(email.input.value);
      if (address === null) return email.error(t('error.account.bad_email'));
      signupEmail = address;
      // Back from the code step, then CONTINUAR with the same address: the same code, no new mail.
      const kept = acc.signupAttempt();
      if (kept === null || kept.email !== address) {
        try {
          await acc.signupStart(address);
        } catch (e) {
          return email.error(authErrText(menu, e));
        }
      }
      step = 'code';
      typed = false;
      render();
      // A pad or a remote: render's refocus (the tab above, ▼ to the code in navigation mode).
      if (typesHere()) body.querySelector<HTMLElement>('.mn-code-input')?.focus();
    };
    const btn = primary(t('auth.continue'), () => void busyWhile(btn, go), { 'data-key': 'profile-go' });
    onEnter([email.input], () => void busyWhile(btn, go));
    return h('form.mn-form', { onsubmit: (e: Event) => e.preventDefault() }, email.el, typo, btn, oauthButtons(), providersHint, legacyLine);
  };

  /** Its account exists (already_created, email_taken): the sign-in tab with the address, and why. */
  const accountExists = (email: string, message: string): void => {
    acc.dropSignupAttempt();
    step = 'email';
    loginPrefill = email;
    menu.toast(message, 'info');
    pickTab('login');
  };

  /**
   * CREAR CUENTA's code step and its finish on one screen (§3.1 step 4, §3.2, §3.7): the code (it
   * checks itself at the sixth digit; a dead one offers PEDIR OTRO), the in-game name, the password
   * with MOSTRAR, the news switch, CREAR CUENTA (once the code is accepted; the name and the
   * password can be typed while the mail comes), REENVIAR after its minute (3 per attempt; the live
   * region says once when it is back), "use another email", YA TENGO CUENTA.
   */
  const signupCodeForm = (a: StoredAttempt): HTMLElement => {
    let proved: string | null = null;
    const createErr = h('p.mn-field-error', { hidden: true, 'aria-live': 'polite' });
    const live = h('p.mn-prof-live', { 'aria-live': 'polite' });
    const restart = async (): Promise<void> => {
      try {
        await acc.signupStart(a.email);
        typed = false;
        render();
      } catch (e) {
        code.error(authErrText(menu, e));
      }
    };
    const again = secondary(t('auth.askAgain'), () => void busyWhile(again, restart), { 'data-key': 'profile-ask-again', hidden: true });
    const code = codeField((c) => {
      code.error(null);
      void acc.signupCheck({ attempt: a.attempt, code: c }).then(
        () => {
          proved = c;
          code.note(t('auth.codeOk'));
          create.removeAttribute('aria-disabled');
        },
        (e: unknown) => {
          proved = null;
          if (e instanceof AccountError && e.code === 'already_created') return accountExists(e.detail.email ?? a.email, e.message);
          code.error(authErrText(menu, e));
          if (e instanceof AccountError && e.code === 'code_expired') again.hidden = false;
          else code.input.select();
        },
      );
    });
    const fields = signupFinishFields(menu, a.email, {
      proof: () => (proved !== null ? { attempt: a.attempt, code: proved } : null),
      codeFirst: () => code.error(t('auth.codeFirst')),
      done: (s) => {
        step = 'email';
        signupEmail = '';
        welcome(menu, s);
        render();
      },
      dead: (e) => {
        if (e.code === 'already_created' || e.code === 'email_taken') return accountExists(e.detail.email ?? a.email, e.message);
        proved = null;
        create.setAttribute('aria-disabled', 'true');
        code.error(e.message);
        again.hidden = false;
      },
      error: (msg) => {
        createErr.hidden = msg === null;
        createErr.textContent = msg ?? '';
      },
    });
    const submit = (): void => void busyWhile(create, async () => void (await fields.create()));
    const create = primary(t('profile.createAccount'), submit, { 'data-key': 'profile-create', 'aria-disabled': 'true' });
    // Enter (a phone keyboard's Siguiente / Ir): the name, the password (its repeat), then CREAR CUENTA.
    onEnter(fields.inputs, submit);
    // REENVIAR: disabled (the arrows skip it) until its minute is over, then once more per press.
    let readyAt = a.resendAt;
    let resendsLeft = 3;
    let waited = Date.now() < readyAt;
    const resendErr = h('p.mn-field-error', { hidden: true, 'aria-live': 'polite' });
    const resend = secondary('', () => void busyWhile(resend, doResend), { 'data-key': 'profile-resend' });
    const paint = (): void => {
      const left = readyAt - Date.now();
      const label = left > 0 ? t('auth.resendIn', { seconds: Math.ceil(left / 1000) }) : t('auth.resend');
      if (resend.textContent !== label) resend.textContent = label;
      const wasFocused = document.activeElement === resend;
      resend.disabled = left > 0;
      resend.hidden = resendsLeft <= 0;
      // A press that started the next minute: the focus goes to the code (a pad or a remote: the
      // menus' own refocus, no field), never to nothing.
      if (wasFocused && (resend.disabled || resend.hidden) && !touch()) {
        if (typesHere()) code.input.focus();
        else menu.refocus();
      }
      if (waited && left <= 0) live.textContent = t('auth.resendReady');
      waited = left > 0;
    };
    const doResend = async (): Promise<void> => {
      resendErr.hidden = true;
      try {
        const r = await acc.codeResend(a.attempt);
        readyAt = r.resendAt;
        resendsLeft = r.resendsLeft;
        live.textContent = '';
        menu.toast(t('auth.resent'), 'ok');
      } catch (e) {
        resendErr.textContent = authErrText(menu, e);
        resendErr.hidden = false;
        if (e instanceof AccountError && e.code === 'code_expired') again.hidden = false;
      }
      paint();
    };
    paint();
    resendTick = paint;
    const other = navButton(
      'mn-link',
      t('auth.otherEmail'),
      () => {
        acc.dropSignupAttempt();
        step = 'email';
        typed = false;
        render();
      },
      { 'data-key': 'profile-other-email' },
    );
    const have = secondary(t('auth.haveAccount'), () => ((loginPrefill = a.email), pickTab('login')), { 'data-key': 'profile-have-account' });
    return h(
      'form.mn-form.mn-prof-code',
      { onsubmit: (e: Event) => e.preventDefault() },
      h('p.mn-prof-sent', null, t('auth.codeSent', { email: a.email })),
      code.el,
      again,
      ...fields.nodes,
      create,
      createErr,
      h('div.mn-prof-code-links', null, resend, other),
      resendErr,
      have,
      h('p.mn-note', null, t('auth.notThere')),
      live,
    );
  };

  /** The recovery code form of before (a username and its code, until the cutoff). */
  const recoverForm = (): HTMLElement => {
    const user = field(t('profile.username'), { autocomplete: 'username', maxLength: 64, value: recoverPrefill ?? acc.hintName ?? '', enterkeyhint: 'next' });
    recoverPrefill = null;
    const code = field(t('profile.recoveryCode'), { placeholder: 'XXXX-XXXX', maxLength: 16, enterkeyhint: 'next' });
    const pass = field(t('profile.newPassword'), { type: 'password', autocomplete: 'new-password', maxLength: 128, enterkeyhint: 'go', reveal: true });
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
        pass.error(authErrText(menu, e));
      }
    };
    const btn = primary(t('profile.resetPassword'), () => void busyWhile(btn, go), { 'data-key': 'profile-go' });
    onEnter([user.input, code.input, pass.input], () => void busyWhile(btn, go));
    return h('form.mn-form', { onsubmit: (e: Event) => e.preventDefault() }, h('p.mn-prof-form-title', null, t('profile.tabRecover')), user.el, code.el, pass.el, btn);
  };

  /**
   * ENTRAR (DEV) (the sign-in design's §3.15): a name and the dev-only sign-in, shown where GET
   * /api/config says its gate is open (DEV_AUTH=1 on a loopback Worker), which only a page served
   * from this machine asks. Its labels are dev-only, outside the locales. Filled in place when the
   * answer comes, so a half-typed form above it stays as it is; hidden until then (no grid gap).
   */
  const devBox = (): HTMLElement | null => {
    if (!loopbackPage()) return null;
    const box = h('div.mn-prof-dev', { hidden: true });
    void acc.devSignInOffered().then(
      (open) => {
        if (!open || !box.isConnected) return;
        const name = field('DEV', { maxLength: 32, placeholder: 'ana', enterkeyhint: 'go' });
        const go = async (): Promise<void> => {
          name.error(null);
          if (!DEV_NAME.test(name.input.value.trim())) {
            name.error('1-32: A-Z a-z 0-9 _ -');
            return;
          }
          try {
            await acc.devSignIn(name.input.value);
            menu.toast(t('profile.hello', { name: acc.account?.name ?? '' }), 'ok');
            void acc.fetchMe();
            render();
          } catch (e) {
            name.error(errText(e));
          }
        };
        onEnter([name.input], () => void go());
        setChildren(box, h('form.mn-form', { onsubmit: (e: Event) => e.preventDefault() }, name.el, secondary('ENTRAR (DEV)', () => void go(), { 'data-key': 'profile-dev' })));
        box.hidden = false;
      },
      () => undefined,
    );
    return box;
  };

  /**
   * A guest's form: the tab's, its first field focused for typing where there is a fine pointer (a
   * touch screen's tap shows the keyboard; a remote's OK on the field, reached with ▼, opens mn-keypad).
   */
  const pickTab = (id: GuestTab): void => {
    tab = id;
    typed = false;
    render();
    if (typesHere()) body.querySelector<HTMLElement>('.mn-form .mn-input:not([readonly])')?.focus();
  };

  /** The server's name for this guest, temporary (a new guest session brings a new one). */
  const guestLine = (): HTMLElement => h('p.mn-note.mn-prof-guestline', null, t('profile.guestLine', { name: playerName(menu.host.guestName()) }));

  const guestView = (): HTMLElement => {
    resendTick = null;
    // A TV: no typing at all, the phone signs it in and makes its account (§3.11).
    if (tv())
      return h(
        'div.mn-prof-guest',
        null,
        h(
          'button.mn-prof-phone',
          { type: 'button', 'data-nav': true, 'data-key': 'profile-phone', 'data-autofocus': true, onclick: () => openTvSignIn(menu) },
          icon('touch', 'mn-mtile-icon'),
          h('span.mn-prof-phone-text', null, h('span.mn-prof-phone-title', { 'data-fit': '16' }, t('tvsign.tile')), h('span.mn-prof-phone-sub', null, t('tvsign.tileSub'))),
        ),
        h('p.mn-note', null, t('profile.tvNoAccount')),
        devBox(),
        guestLine(),
      );
    loadAuthConfig();
    const kept = tab === 'register' && step === 'code' ? acc.signupAttempt() : null;
    if (kept === null) step = 'email';
    const hero = h(
      `button.mn-tab.mn-prof-hero${tab === 'register' ? '.mn-tab-on' : ''}` as 'button',
      { type: 'button', role: 'tab', 'aria-selected': String(tab === 'register'), 'data-nav': true, 'data-key': 'profile-tab-register', 'data-autofocus': true, onclick: () => pickTab('register') },
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
    const form = tab === 'login' ? loginForm() : tab === 'register' ? (kept !== null ? signupCodeForm(kept) : signupEmailForm()) : recoverForm();
    return h(
      'div.mn-prof-guest',
      { oninput: () => (typed = true) },
      h('div.mn-tabs.mn-prof-tabs', { role: 'tablist', 'aria-label': t('profile.heading'), 'data-nav-row': true }, hero, signIn),
      h('div.mn-prof-form', null, form),
      devBox(),
      guestLine(),
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
    const linked = (me?.providers ?? []).filter((p): p is OAuthProvider => p !== 'password');
    // An unlink never takes the last way in (the server refuses it too: last_method).
    const ways = me?.providers.length ?? 0;
    const linkedRow = (p: OAuthProvider): HTMLElement => {
      const at = me?.linkedAt?.[p];
      return h(
        'div.mn-prof-device',
        null,
        h('p', null, typeof at === 'number' ? t('profile.linkedOn', { provider: PROVIDER_NAMES[p], date: shortDate(at) }) : t('profile.linkedWith', { provider: PROVIDER_NAMES[p] })),
        ways > 1 ? secondary(t('profile.unlink', { provider: PROVIDER_NAMES[p].toUpperCase() }), () => (me === null || unlinkKeepsMaintainer(me) ? unlinkDialog(p) : menu.toast(t('error.account.maintainer_two_ways'), 'error')), { 'data-key': 'profile-unlink-' + p }) : null,
      );
    };
    // CUENTA DEL PROYECTO (§3.12): the project account's checklist, a dot per line (green when done). Not on a TV (its changes are the phone's).
    // With its password, CONFIRMAR CON LA CONTRASEÑA: the level 2 the node token and maintenance routes ask for (nodes/docs/VPS-SAO-PAULO.md's console line).
    const project = me?.maintainer;
    const confirm = project?.password === true ? h('div.mn-prof-device', null, h('p.mn-prof-node-reason', null, t('profile.maintainerConfirmNote')), secondary(t('profile.maintainerConfirm'), () => fresh(() => menu.toast(t('profile.maintainerConfirmed'), 'ok'), 2, true), { 'data-key': 'profile-maintainer-confirm' })) : null;
    const projectChecks =
      project !== undefined && !(sample === null && acc.account?.tv === true)
        ? section(t('profile.maintainerTitle'), h('div.mn-prof-node', null, h('p.mn-prof-node-reason', null, t('profile.maintainerNote')), ...maintainerChecks(project).map((c) => h('span.mn-prof-node-state', { 'data-ok': c.ok ? 'true' : 'false' }, h('span.mn-dot'), c.text)), confirm))
        : null;
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
    const usernameUntil = me !== null && me.hasPassword && me.emailVerified !== true && legacyPhase() === 'grace' && (authCfg?.legacyUntil ?? null) !== null ? h('p.mn-note', null, t('profile.usernameUntil', { date: cutoffDay(authCfg?.legacyUntil as number) })) : null;
    // A TV signed in with the phone has a limited scope (server/src/accountRoutes.ts requirePrimary):
    // it plays with the account, the account's changes are the phone's. Only its own sign-out here.
    const tvScope = sample === null && acc.account?.tv === true;
    if (tvScope)
      setChildren(
        fold,
        h('p.mn-note', null, t('profile.tvScopeNote')),
        secondary(t('profile.signOut'), () => void acc.logout().then(() => (menu.toast(t('profile.signedOut'), 'info'), render())), { 'data-key': 'profile-signout' }),
      );
    else setChildren(
      fold,
      secondary(t('profile.rename'), () => renameDialog(), { 'data-key': 'profile-rename' }),
      emailRow(me),
      passwordRow(me),
      usernameUntil,
      ...linked.map(linkedRow),
      // A link needs a credential proved on this browser in the last minutes: confirm it is you first.
      ...linkable.map((p) => secondary(t('profile.link', { provider: PROVIDER_NAMES[p].toUpperCase() }), () => fresh(() => (window.location.href = acc.oauthUrl(p, true))), { 'data-key': 'profile-link-' + p })),
      secondary(t('profile.devices'), () => devicesDialog(), { 'data-key': 'profile-devices' }),
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
      secondary(t('profile.signOutAll'), () => signOutAllDialog(), { 'data-key': 'profile-signout-all' }),
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
    // PRIVACIDAD: the public replays show 'Jugador N' for this account (src/net/replays.ts), the
    // matches already listed too. Off by default; a TV signed in with the phone may change it too.
    const who = sample !== null ? 'sample' : (acc.account?.playerId ?? '');
    const hideSwitch = toggleSwitch(
      'profile-replay-name',
      t('profile.hideReplayName'),
      () => replayHidden !== null && replayHidden.who === who && replayHidden.hidden,
      (on) => {
        const was = replayHidden !== null && replayHidden.who === who && replayHidden.hidden;
        replayHidden = { who, hidden: on };
        if (sample !== null) return;
        void acc.setReplayNameHidden(on).then(
          (hidden) => {
            if (replayHidden?.who === who) replayHidden = { who, hidden };
            hideSwitch.refresh();
          },
          (e: unknown) => {
            if (replayHidden?.who === who) replayHidden = { who, hidden: was };
            hideSwitch.refresh();
            menu.toast(errText(e), 'error');
          },
        );
      },
    );
    replaySwitch = hideSwitch;
    const privacy = section(t('profile.privacy'), setRow(t('profile.hideReplayName'), hideSwitch.el, t('profile.hideReplayNameHelp')));
    return h(
      'div.mn-prof-account',
      null,
      h('div.mn-prof-col', null, graceBanner(me), id, section(t('profile.season', { season: me?.season ?? 1 }), ranks(me)), server),
      h(
        'div.mn-prof-col',
        null,
        projectChecks,
        h('section.mn-section.mn-prof-security', null, toggle, fold),
        privacy,
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

  // ---- the email of an account (sign-in PR 9: the design's §3.6, §3.9, §3.10) ------------------------

  /** The banner folded (it can be folded, never dismissed: it stays until the account has a verified email). */
  let graceOpen = true;

  /** The configured providers the account has not linked (VINCULAR on the banner and the grace sheet). */
  const unlinked = (me: MeInfo): OAuthProvider[] => emailProviders(menu).filter((p) => !me.providers.includes(p));

  /** VINCULAR {provider}: once this browser is fresh(1) (a link adds a way in), the provider's page. */
  const linkProvider = (p: OAuthProvider): void => fresh(() => (window.location.href = acc.oauthUrl(p, true)), 1);

  /**
   * The Correo row (§3.9): "{email}" with CAMBIAR CORREO, "Sin correo" with AGREGAR CORREO, or
   * "{hint} · sin confirmar" with CONFIRMAR CORREO; with the mail off, why not.
   */
  const emailRow = (me: MeInfo | null): HTMLElement | null => {
    if (me === null || me.email === undefined) return null;
    const email = me.emailVerified === true && typeof me.email === 'string' ? me.email : null;
    const hint = email === null && typeof me.emailHint === 'string' && me.emailHint.length > 0 ? me.emailHint : null;
    const mode = email !== null ? 'change' : hint !== null ? 'confirm' : 'add';
    const label = mode === 'change' ? t('profile.emailChangeBtn') : mode === 'confirm' ? t('profile.emailConfirmBtn') : t('profile.emailAddBtn');
    return h(
      'div.mn-prof-device',
      null,
      h('p', null, email ?? (hint !== null ? t('profile.emailHintRow', { email: hint }) : t('profile.emailNone'))),
      mailOn() ? secondary(label, () => emailDialog(mode), { 'data-key': 'profile-email' }) : h('p.mn-note', null, mailOffText(menu)),
    );
  };

  /**
   * AGREGAR, CAMBIAR or CONFIRMAR (§3.6 steps 2 to 4): "confirm it's you" first when this browser is
   * not fresh enough (1 to add or confirm, 2 to change; a password of before is re-keyed by itself
   * first, level 2), then the address and its code. `direct`: the banner's ENVIAR CÓDIGO for a hint,
   * the code straight away. A provider's round trip comes back to it (the marker keepResume).
   */
  const emailDialog = (mode: 'add' | 'change' | 'confirm', direct = false): void => {
    const me = acc.me;
    const change = mode === 'change';
    const legacy = me?.legacy === true;
    const hooks: EmailHooks = { change, reauth: (level) => fresh(() => emailDialog(mode, direct), level, true, 'email:' + mode) };
    const hint = typeof me?.emailHint === 'string' ? me.emailHint : '';
    const open = (): void => {
      if (legacy) void acc.fetchMe().catch(() => undefined); // re-keyed by "confirm it's you": the row knows it
      if (direct && hint.length > 0) {
        void startEmailCode(menu, hint, hooks).then((err) => (err !== null ? menu.toast(err, 'error') : undefined));
        return;
      }
      emailSheet(menu, change ? t('auth.emailChangeTitle') : mode === 'confirm' ? t('auth.emailConfirmTitle') : t('auth.emailAddTitle'), mode === 'confirm' ? hint : '', hooks);
    };
    fresh(open, change || legacy ? 2 : 1, legacy, 'email:' + mode);
  };

  /** Right after a username's sign-in (§3.10 step 3): "Agrega tu correo", its date while there is one. */
  const openGrace = (me: MeInfo): void => {
    graceSheet(menu, {
      until: authCfg?.legacyUntil ?? null,
      closed: legacyPhase() === 'closed',
      prefill: typeof me.emailHint === 'string' ? me.emailHint : '',
      link: unlinked(me),
      hooks: { change: false, reauth: (level) => fresh(() => openGrace(me), level, true, 'email:add') },
      goLink: linkProvider,
    });
  };

  /**
   * PERFIL's banner (§3.10 step 4, §3.8 step 5): until the account has a verified email. A password
   * that signs in by its username: "Agrega tu correo" with its date (or none), AGREGAR CORREO and
   * VINCULAR for each configured provider not linked; a provider's hint: "Confirma tu correo {email}"
   * with ENVIAR CÓDIGO. Its first button takes PERFIL's first focus. Folded by its title, never gone.
   * A TV shows its scope note instead (accountView's tvScope).
   */
  const graceBanner = (me: MeInfo | null): HTMLElement | null => {
    if (sample !== null && sample.me?.emailVerified !== false) return null;
    const nudge = emailNudge(me, acc.account?.tv === true && sample === null);
    if (me === null || nudge === null) return null;
    const title = nudge === 'confirm' ? t('auth.confirmEmailBanner', { email: me.emailHint ?? '' }) : t('auth.graceTitle');
    const text = me.hasPassword ? h('p.mn-note', null, graceText(authCfg?.legacyUntil ?? null, legacyPhase() === 'closed')) : null;
    const buttons = mailOn()
      ? [nudge === 'confirm' ? secondary(t('auth.sendCode'), () => emailDialog('confirm', true), { 'data-key': 'profile-grace-email', 'data-autofocus': true }) : secondary(t('profile.emailAddBtn'), () => emailDialog('add'), { 'data-key': 'profile-grace-email', 'data-autofocus': true })]
      : [h('p.mn-note', null, mailOffText(menu))];
    const links = nudge === 'add' ? unlinked(me).map((p) => secondary(t('profile.link', { provider: PROVIDER_NAMES[p].toUpperCase() }), () => linkProvider(p), { 'data-key': 'profile-grace-link-' + p })) : [];
    const body = h('div.mn-prof-acct.mn-prof-grace-body', { id: 'mn-prof-grace', hidden: !graceOpen }, text, ...buttons, ...links);
    const head = h(
      'button.mn-picker.mn-prof-fold',
      {
        type: 'button',
        'data-nav': true,
        'data-key': 'profile-grace',
        'aria-expanded': String(graceOpen),
        'aria-controls': 'mn-prof-grace',
        onclick: () => {
          graceOpen = !graceOpen;
          body.hidden = !graceOpen;
          head.setAttribute('aria-expanded', String(graceOpen));
          menu.refit();
        },
      },
      icon('info'),
      h('span.mn-picker-label', null, title),
      icon('next', 'mn-prof-fold-chev'),
    );
    return h('section.mn-section.mn-prof-security.mn-prof-grace', null, head, body);
  };

  /** A rename that went through: the toast and the account's view. */
  const renamed = (): void => {
    menu.toast(t('profile.renamed'), 'ok');
    render();
  };

  /**
   * CAMBIAR NOMBRE (sign-in PR 7: the Bearer, no password). An account whose password is still the
   * legacy key, or that signs in by its username and proved nothing lately, is answered 403
   * reauth_required { level: 2 }: "confirm it's you" (its password, which re-keys a legacy one), then
   * the same name once more. A taken name or a look-alike puts the server's free one in the field.
   */
  const renameDialog = (): void => {
    const user = field(t('profile.newName'), { maxLength: USERNAME_MAX, value: acc.account?.name ?? '', autocomplete: 'nickname' });
    menu.modal({
      title: t('profile.renameTitle'),
      body: [h('p.mn-note', null, t('profile.renameNote')), user.el],
      actions: [
        {
          label: t('profile.renameConfirm'),
          primary: true,
          onClick: async () => {
            user.error(null);
            const username = user.input.value.trim();
            const userIssue = issueText(usernameIssue(username));
            if (userIssue !== null) {
              user.error(userIssue);
              return false;
            }
            try {
              await acc.rename(username);
              renamed();
              return true;
            } catch (e) {
              if (e instanceof AccountError && e.code === 'reauth_required') {
                // The server just refused: ask, whatever this browser's own clock says (a legacy key needs the password itself).
                queueMicrotask(() => fresh(() => void acc.rename(username).then(renamed, (err: unknown) => menu.toast(errText(err), 'error')), e.level === 2 ? 2 : 1, true));
                return true;
              }
              if (e instanceof AccountError && e.detail.suggest !== undefined) user.input.value = e.detail.suggest;
              user.error(errText(e));
              return false;
            }
          },
        },
        { label: t('profile.cancel'), onClick: () => true },
      ],
    });
  };

  /**
   * The Contraseña row (§3.5): CAMBIAR CONTRASEÑA with one; without one, CREAR CONTRASEÑA mails a
   * link to the account's own verified address (a Bearer alone never sets a first password, I4),
   * and an account without that address is told to add one first (PR 9 adds the email).
   */
  const passwordRow = (me: MeInfo | null): HTMLElement => {
    if (me?.hasPassword !== false) return secondary(t('profile.changePassword'), () => passwordDialog(), { 'data-key': 'profile-password' });
    if (me.emailVerified !== true || typeof me.email !== 'string' || me.email.length === 0) return h('p.mn-note.mn-prof-pwnote', null, t('auth.addEmailFirst'));
    // (the Correo row above it has AGREGAR CORREO)
    const btn = secondary(
      t('profile.createPassword'),
      () =>
        void busyWhile(btn, async () => {
          try {
            const to = await acc.passwordLink();
            menu.modal({ title: t('auth.checkMail'), body: h('p', null, t('auth.passwordLinkSent', { email: to })), actions: [{ label: t('outcome.close'), primary: true, onClick: () => true }] });
          } catch (e) {
            menu.toast(authErrText(menu, e), 'error');
          }
        }),
      { 'data-key': 'profile-password' },
    );
    return btn;
  };

  /**
   * CAMBIAR CONTRASEÑA (§3.5 step 2, POST /api/me/password): the account's address as the
   * read-only username a password manager saves, the current password, the new one with MOSTRAR
   * (its repeat where the keypad shows dots). The other devices are signed out.
   */
  const passwordDialog = (): void => {
    const who = acc.me?.email ?? acc.account?.name ?? '';
    const reveal = !keypadTyping();
    const old = field(t('profile.currentPassword'), { type: 'password', autocomplete: 'current-password', maxLength: 128, enterkeyhint: 'next', reveal });
    const pw = newPasswordFields(who, t('profile.newPassword'), false);
    menu.modal({
      title: t('profile.changePasswordTitle'),
      body: [passwordManagerUser(who), old.el, ...pw.nodes, h('p.mn-note', null, t('profile.othersSignedOut'))],
      actions: [
        {
          label: t('profile.save'),
          primary: true,
          onClick: async () => {
            old.error(null);
            pw.pass.error(null);
            const next = pw.check();
            if (next === null) return false;
            const passIssue = issueText(passwordIssue(next, { username: acc.account?.name ?? '', email: acc.me?.email ?? undefined })); // the arguments AccountClient.changePassword checks
            if (passIssue !== null) {
              pw.pass.error(passIssue);
              return false;
            }
            try {
              await acc.changePassword(old.input.value, next);
              menu.toast(t('profile.passwordUpdated'), 'ok');
              void acc.fetchMe().then(() => render());
              return true;
            } catch (e) {
              (e instanceof AccountError && e.code === 'bad_credentials' ? old : pw.pass).error(authErrText(menu, e));
              return false;
            }
          },
        },
        { label: t('profile.cancel'), onClick: () => true },
      ],
    });
    sheetEnter([old.input, ...pw.inputs]);
  };

  /**
   * Run `go` once this browser proved a credential at `level` in the last minutes (AccountClient.fresh,
   * the server's R6): at once when it did (unless `force`: the server just asked), else after
   * "confirm it is you" with what reaches that level. Level 1: a provider already on the account (a
   * round trip that comes back to PERFIL, then the player taps again) or the password here. Level 2
   * (the server's reauth_required { level: 2 }): the password, or a code to the account's verified
   * address (POST /api/auth/reauth/code); a press on a provider's page is level 1, and the sheet says
   * so. A password of before (me.legacy) is only re-keyed by itself: no code then.
   */
  const fresh = (go: () => void, level: 1 | 2 = 1, force = false, resume: string | null = null): void => {
    if (!force && acc.fresh(level)) {
      go();
      return;
    }
    const me = acc.me;
    const own = (me?.providers ?? []).filter((p): p is OAuthProvider => p !== 'password' && ((menu.cfg?.oauth ?? []) as string[]).includes(p));
    const offered = level === 1 ? own : [];
    const pass = field(t('profile.yourPassword'), { type: 'password', autocomplete: 'current-password', maxLength: 128 });
    const withPassword = me?.hasPassword === true;
    // No code for the project's account: it confirms with its password (the server refuses it the code: 403 password_required).
    const mailbox = me?.emailVerified === true && typeof me.email === 'string' && me.email.length > 0 && me.legacy !== true && me.maintainer === undefined ? me.email : null;
    const ownNames = own.map((p) => PROVIDER_NAMES[p]).join(` ${t('profile.or')} `);
    const notEnough = level === 2 && own.length > 0 ? h('p.mn-note', null, mailbox !== null ? t('profile.reauthPasswordOrCode', { providers: ownNames }) : t('profile.reauthPasswordOnly', { providers: ownNames })) : null;
    const byCode: HTMLButtonElement | null = mailbox !== null ? secondary(t('auth.reauthCode', { email: mailbox }), () => byCode !== null && void busyWhile(byCode, () => openReauthCodeSheet(menu, go)), { 'data-key': 'profile-reauth-code' }) : null;
    menu.modal({
      title: t('profile.reauthTitle'),
      body: [h('p.mn-note', null, t('profile.reauthNote')), notEnough, ...offered.map((p) => secondary(t('profile.reauthWith', { provider: PROVIDER_NAMES[p] }), () => (acc.keepResume(resume), (window.location.href = acc.oauthUrl(p, 'reauth'))), { 'data-key': 'profile-reauth-' + p })), byCode, withPassword ? pass.el : null],
      actions: [
        ...(withPassword
          ? [
              {
                label: t('profile.reauthConfirm'),
                primary: true,
                onClick: async (): Promise<boolean> => {
                  pass.error(null);
                  try {
                    await acc.reauth(pass.input.value);
                    queueMicrotask(go);
                    return true;
                  } catch (e) {
                    pass.error(errText(e));
                    return false;
                  }
                },
              },
            ]
          : []),
        { label: t('profile.cancel'), onClick: () => true },
      ],
    });
  };


  /**
   * Take `p` off the account after "confirm it is you" at `level`: 1 first, and 2 when the server
   * says only one way in would be left (403 reauth_required { level: 2 }), once.
   */
  const unlinkNow = (p: OAuthProvider, level: 1 | 2 = 1): void =>
    fresh(() => {
      void acc.unlink(p).then(
        () => {
          menu.toast(t('profile.unlinked', { provider: PROVIDER_NAMES[p] }), 'ok');
          render();
        },
        (e: unknown) => (e instanceof AccountError && e.code === 'reauth_required' && e.level > level ? unlinkNow(p, 2) : menu.toast(errText(e), 'error')),
      );
    }, level);

  /** DESVINCULAR: one provider off the account (never the last way in), after "confirm it is you". */
  const unlinkDialog = (p: OAuthProvider): void => {
    menu.modal({
      title: t('profile.unlinkTitle', { provider: PROVIDER_NAMES[p] }),
      body: h('p.mn-note', null, t('profile.unlinkNote', { provider: PROVIDER_NAMES[p] })),
      actions: [
        {
          label: t('profile.unlinkConfirm'),
          danger: true,
          onClick: () => {
            queueMicrotask(() => unlinkNow(p));
            return true;
          },
        },
        { label: t('profile.cancel'), autofocus: true, onClick: () => true },
      ],
    });
  };

  /** One device in words: a browser or a TV, where it signed in, since when and its last use. */
  const deviceRow = (d: DeviceSession): HTMLElement => {
    const place = [d.city, d.country].filter((x): x is string => typeof x === 'string' && x.length > 0).join(', ');
    const what = d.kind === 'tv' ? t('profile.deviceTv') : t('profile.deviceBrowser');
    return h(
      'div.mn-prof-device',
      null,
      h('p', null, h('b', null, what), place ? ` · ${place}` : '', d.current ? ` · ${t('profile.deviceThis')}` : ''),
      h('p.mn-note', null, t('profile.deviceWhen', { date: shortDate(d.signedInAt), last: shortDate(d.lastUsedAt) })),
      d.current
        ? null
        : secondary(t('profile.deviceSignOut'), () => {
            void acc.revokeSession(d.id).then(
              () => {
                menu.toast(t('profile.deviceSignedOut'), 'ok');
                devicesDialog();
              },
              (e: unknown) => menu.toast(errText(e), 'error'),
            );
          }),
    );
  };

  /** DISPOSITIVOS: every device signed in to the account, each one's sign-out (not this one's: SIGN OUT is). */
  const devicesDialog = (): void => {
    void acc.sessions().then(
      (list) =>
        menu.modal({
          title: t('profile.devicesTitle'),
          body: [h('p.mn-note', null, t('profile.devicesNote')), ...list.map(deviceRow)],
          actions: [{ label: t('outcome.close'), primary: true, onClick: () => true }],
        }),
      (e: unknown) => menu.toast(errText(e), 'error'),
    );
  };

  /** Sign out on every device, this one too: the way out of a stolen session for any account (no password needed). */
  const signOutAllDialog = (): void => {
    menu.modal({
      title: t('profile.signOutAllTitle'),
      body: h('p.mn-note', null, t('profile.signOutAllNote')),
      actions: [
        {
          label: t('profile.signOutAllConfirm'),
          danger: true,
          onClick: async () => {
            try {
              await acc.signOutEverywhere();
              menu.toast(t('profile.signedOutAll'), 'info');
              render();
              return true;
            } catch (e) {
              menu.toast(errText(e), 'error');
              return false;
            }
          },
        },
        { label: t('profile.cancel'), autofocus: true, onClick: () => true },
      ],
    });
  };

  const render = (): void => {
    const who = acc.account?.playerId ?? null;
    shownFor = who;
    shownMe = acc.me;
    resendTick = null; // the code step's own, when it is drawn again below
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

  /** PRIVACIDAD's switch as the server has it, once per visit (offline: it reads NO until the next one). */
  const loadReplayName = (): void => {
    const who = acc.account?.playerId ?? null;
    if (who === null) return;
    void acc.replayNameHidden().then(
      (hidden) => {
        replayHidden = { who, hidden };
        replaySwitch?.refresh();
      },
      () => undefined,
    );
  };

  // The samples exist in development and in a VITE_UI_FIT=1 build only (read here: node tests import this module).
  if (import.meta.env.DEV || import.meta.env.VITE_UI_FIT === '1') {
    (window as unknown as { __profile: (kind: 'account' | 'operator' | 'grace' | null) => void }).__profile = (kind) => {
      sample = kind === null ? null : sampleAccount(kind);
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
      if (signedIn) {
        loadNodes();
        loadReplayName();
      }
    }
  });
  return {
    id: 'profile',
    title: t('profile.title'),
    el,
    show: () => {
      // A mailed link's sheet sent the player here (openProfileTab), or this page's first visit
      // finds a sign-up waiting for its code (a phone tab the browser reloaded): that step.
      const intent = profileIntent;
      profileIntent = null;
      if (!acc.signedIn && intent !== null) {
        tab = intent.tab;
        loginPrefill = intent.email;
        step = intent.tab === 'register' && acc.signupAttempt() !== null ? 'code' : 'email';
        typed = false;
      } else if (!acc.signedIn && firstShow && acc.signupAttempt() !== null) {
        tab = 'register';
        step = 'code';
      }
      firstShow = false;
      render();
      if (acc.signedIn) {
        loadAuthConfig();
        // Back from a provider's "confirm it's you" that an email change asked for (§3.6 step 2).
        const resume = acc.takeResume();
        void acc.fetchMe().then(() => {
          render();
          if (resume !== null && acc.signedIn) emailDialog(resume.slice('email:'.length) as 'add' | 'change' | 'confirm');
        }, () => undefined);
        loadNodes();
        loadReplayName();
      }
    },
    tick: () => resendTick?.(),
    // Back, B or Esc on the code step goes to the address, and from the recovery form to the sign-in
    // (§3.0); the attempt stays kept, so CONTINUAR with the same address comes back to its code.
    back: () => {
      if (acc.signedIn || sample !== null || tv()) return false;
      if (tab === 'register' && step === 'code') {
        step = 'email';
        signupEmail = acc.signupAttempt()?.email ?? signupEmail;
        typed = false;
        render();
        return true;
      }
      if (tab === 'recover') {
        tab = 'login';
        typed = false;
        render();
        return true;
      }
      return false;
    },
  };
}

/**
 * Sample data for the layout check (window.__profile): a long name, three playlists, two nodes for an
 * operator; 'grace' (sign-in PR 9): a password of before with no email, PERFIL's banner up.
 */
function sampleAccount(kind: 'account' | 'operator' | 'grace'): AccountData {
  const operator = kind === 'operator';
  const r = (playlist: PlaylistRating['playlist'], tier: string | null, placementLeft: number): PlaylistRating => ({ playlist, mmr: 1480, tier, games: 52, wins: 30, losses: 22, placementLeft, peakMmr: 1520 });
  const me: MeInfo = {
    playerId: 'sample',
    name: 'MaximilianoGomez',
    createdAt: Date.UTC(2026, 3, 4),
    providers: ['password', 'google'],
    hasPassword: true,
    email: 'maximiliano.gomez@example.com',
    emailVerified: true,
    renameAt: 0,
    ratings: [r('1v1', 'diamond-3', 0), r('2v2', 'platinum-1', 0), r('3v3', null, 3)],
    rankedBanUntil: 0,
    abandons24h: 1,
    season: 1,
    experimental: false,
    ...(kind === 'grace' ? { providers: ['password'] as MeInfo['providers'], email: null, emailHint: null, emailVerified: false, legacy: true } : {}),
    // The operator's sample is the project's account too: CUENTA DEL PROYECTO with a line still to do.
    ...(operator ? { maintainer: { password: true, verifiedEmail: true, waysIn: 1 } } : {}),
  };
  const node = (name: string, status: MyNode['status'], online: boolean): MyNode => ({ nodeId: 'n-' + name, name, region: 'SA', status, statusReason: status === 'suspended' ? 'Too many lost matches this week' : null, suspendedUntil: null, online, counters: { verified: 318, probationVerified: 12 }, version: '1.4.2', compatible: status !== 'suspended' });
  return { name: me.name, me, nodes: operator ? [node('Buenos-Aires-VPS-largo', 'active', true), node('Casa-PC', 'suspended', false)] : [] };
}

/**
 * Email accounts' sheets and the pages their mails link to (sign-in PR 8: the sign-in design's §3.1
 * to §3.4, §3.7 and §4.3; the routes are PR 7's). PERFIL (profile.ts) builds its guest forms with
 * these parts; a mailed link opens its sheet here.
 *
 *   /account#verify=<token>  the sign-up's link, opened anywhere: POST signup/check { token } (it
 *                            consumes nothing), then the finish sheet ("Correo confirmado: {email}",
 *                            the in-game name, the password with MOSTRAR, the news switch at NO,
 *                            CREAR CUENTA)
 *   /account#reset=<token>   forgot's link: POST reset/peek, then the password sheet (GUARDAR Y
 *                            ENTRAR: every other device signed out, this one signed in)
 *   /account#forgot          the forgot sheet
 *   email, undo, keep, unsub sign-in PR 9, 12 and 13: this page says the link is not valid here
 *
 * On load (installAccountLinks, after the restore) the link is read from the path and the fragment,
 * its token kept in sessionStorage (AccountClient.keepPendingLink, until its POST settles: a slow
 * first load can try again), the URL cleared with history.replaceState, and the sheet waits until
 * the menus are up with no other sheet. Nothing is consumed until the sheet's button. A tab the
 * browser reloaded while its sign-up waited for the code comes back to PERFIL's code step.
 */
import { h } from '../dom';
import { AccountError } from '../../net/AccountClient';
import type { CodeProof } from '../../net/AccountClient';
import { USERNAME_MAX, normalizeEmail, usernameIssue } from '../../net/account';
import type { AccountSession, OAuthProvider, ResetPeekAnswer } from '../../net/account';
import { guestNumber } from '../../net/guestName';
import { inAppBrowser, isAccountPath, parseAccountLink, providersText, signupNamePrefill } from '../../net/emailAuth';
import type { AccountLink } from '../../net/emailAuth';
import type { Menu } from '../Menu';
import { setRow, toggleSwitch } from '../components/rows';
import { finePointer } from '../device';
import { codeField, field } from './common';
import type { Field } from './common';
import { errText, openProfileTab } from './profile';
import { t } from '../../i18n';

// ---- shared by PERFIL's forms and the sheets -------------------------------------------------------

/** The providers this server signs in with (GET /api/config `oauth`), Google left out inside another app's browser (§3.0). */
export function emailProviders(menu: Menu): OAuthProvider[] {
  const list = ((menu.cfg?.oauth ?? []) as string[]).filter((p): p is OAuthProvider => p === 'google' || p === 'discord');
  return inApp() ? list.filter((p) => p !== 'google') : list;
}

/** Google is configured but hidden here: the page runs inside another app's browser. */
export function googleHidden(menu: Menu): boolean {
  return inApp() && ((menu.cfg?.oauth ?? []) as string[]).includes('google');
}

function inApp(): boolean {
  return typeof navigator !== 'undefined' && inAppBrowser(navigator.userAgent ?? '');
}

/** "Discord" / "Google o Discord" for the copy ('' without a provider: each text then has its variant without it). */
export function providersLine(menu: Menu): string {
  return providersText(emailProviders(menu), t('profile.or'));
}

/** This page's host for the copy ("allow turbo-gol.com in your blocker"). */
function site(): string {
  return typeof location !== 'undefined' && location.hostname.length > 0 ? location.hostname : 'turbo-gol.com';
}

/**
 * An email form's error in the player's words (profile.ts errText), with what the design's §3.0,
 * §3.7 and §4.7 add: the anti-bot check that never ran here (a blocker) says to allow the site or
 * use a provider; mail that cannot go now says to try later or use a provider.
 */
export function authErrText(menu: Menu, e: unknown): string {
  if (e instanceof AccountError) {
    const providers = providersLine(menu);
    if (e.code === 'turnstile_failed' && e.status === 0) return providers.length > 0 ? t('auth.antiBotBlocked', { site: site(), providers }) : t('auth.antiBotBlockedNoProviders', { site: site() });
    if ((e.code === 'email_paused' || e.code === 'email_unconfigured') && providers.length > 0) return t('auth.emailPausedProviders', { providers });
    if (e.code === 'email_rate_limited') return mailCapText(menu, providers);
  }
  return errText(e);
}

/**
 * email_rate_limited (§4.7): one answer, the same for every address, whether this address had its
 * mails or the day's sign-up lane is full (a first-time player then). So it claims no earlier
 * mail and, to a guest, names the providers that still sign in; a signed-in account (its own code)
 * only waits.
 */
function mailCapText(menu: Menu, providers: string): string {
  return providers.length > 0 && !menu.host.accounts.signedIn ? t('auth.mailCapProviders', { providers }) : t('auth.mailCap');
}

/** The mail is off (GET /api/config auth.email false): what the forms that send mail say instead. */
export function mailOffText(menu: Menu): string {
  const providers = providersLine(menu);
  return providers.length > 0 ? t('auth.emailPausedProviders', { providers }) : t('error.account.email_paused');
}

/**
 * The keypad types here, and it shows a password as dots (no fine pointer and no finger: a TV, a
 * phone with a controller): a new password gets its repeat field there (§3.0), MOSTRAR elsewhere.
 */
export function keypadTyping(): boolean {
  return typeof document !== 'undefined' && !finePointer() && !document.documentElement.classList.contains('tg-touch');
}

/** The in-game name a new account starts with: 'Jugador' and the guest's digits (emailAuth.ts signupNamePrefill). */
function namePrefill(menu: Menu): string {
  return signupNamePrefill(t('auth.signupNameWord'), guestNumber(menu.host.guestName()), (n) => usernameIssue(n) === null);
}

/**
 * A new password for `email`'s account: before it, the address as a read-only username for a
 * password manager (it saves the address, not the in-game name), then the password with MOSTRAR,
 * and its repeat where the keypad shows dots. `check` resolves the password or null after showing
 * what is wrong.
 */
export function newPasswordFields(email: string, label: string, withUser = true): { nodes: HTMLElement[]; pass: Field; check: () => string | null } {
  const user = withUser ? passwordManagerUser(email) : null;
  const repeat = keypadTyping();
  const pass = field(label, { type: 'password', autocomplete: 'new-password', maxLength: 128, enterkeyhint: repeat ? 'next' : 'go', reveal: !repeat });
  const again = repeat ? field(t('profile.repeatPassword'), { type: 'password', autocomplete: 'new-password', maxLength: 128, enterkeyhint: 'go' }) : null;
  const check = (): string | null => {
    again?.error(null);
    if (again !== null && again.input.value !== pass.input.value) {
      again.error(t('profile.passwordsDiffer'));
      return null;
    }
    return pass.input.value;
  };
  return { nodes: [...(user !== null ? [user] : []), pass.el, ...(again !== null ? [again.el] : [])], pass, check };
}

/**
 * The account's address (or its name) as a read-only username a password manager saves with the
 * password beside it (§3.0), out of sight and out of the arrows' and Tab's way.
 */
export function passwordManagerUser(value: string): HTMLInputElement {
  return h('input.mn-pm-user', { type: value.includes('@') ? 'email' : 'text', autocomplete: 'username', readOnly: true, value, tabindex: '-1', 'aria-hidden': 'true' });
}

/** What signupFinishFields needs from its screen. */
export interface FinishHooks {
  /** The proof to send, null while the code is not accepted yet. */
  proof: () => CodeProof | null;
  /** CREAR CUENTA before the code was accepted. */
  codeFirst: () => void;
  /** The account exists and this browser is signed in to it. */
  done: (s: AccountSession) => void;
  /** The proof is dead (code_expired, link_invalid) or its account exists already (already_created, email_taken). */
  dead: (e: AccountError) => void;
  /** Any other refusal, under CREAR CUENTA. */
  error: (msg: string | null) => void;
}

/**
 * The finish of a sign-up (§3.1 step 4 and 6), shared by PERFIL's code step and the link's sheet:
 * the in-game name (Jugador4821, never from the address; `nickname`), the address for a password
 * manager, the password, the news switch at NO. `create` sends signup/finish: a refused name puts
 * the server's free `suggest` in the field. Resolves true once signed in.
 */
export function signupFinishFields(menu: Menu, email: string, hooks: FinishHooks): { nodes: HTMLElement[]; name: Field; create: () => Promise<boolean> } {
  const acc = menu.host.accounts;
  const name = field(t('auth.signupName'), { autocomplete: 'nickname', maxLength: USERNAME_MAX, value: namePrefill(menu), hint: t('auth.signupNameHint'), enterkeyhint: 'next' });
  const pw = newPasswordFields(email, t('profile.password'));
  let news = false;
  const newsSwitch = toggleSwitch('auth-news', t('auth.signupNews'), () => news, (v) => (news = v));
  const create = async (): Promise<boolean> => {
    name.error(null);
    pw.pass.error(null);
    hooks.error(null);
    const proof = hooks.proof();
    if (proof === null) {
      hooks.codeFirst();
      return false;
    }
    const username = name.input.value.trim();
    const issue = usernameIssue(username);
    if (issue !== null) {
      name.error(t(`account.issue.${issue.code}`, issue.params));
      return false;
    }
    const password = pw.check();
    if (password === null) return false;
    try {
      const s = await acc.signupFinish(proof, { username, password, news, email });
      hooks.done(s);
      return true;
    } catch (e) {
      if (!(e instanceof AccountError)) {
        hooks.error(errText(e));
        return false;
      }
      if (e.detail.suggest !== undefined) name.input.value = e.detail.suggest;
      if (e.code === 'bad_username' || e.code === 'username_taken' || e.code === 'name_lookalike' || e.code === 'name_reserved') name.error(e.message);
      else if (e.code === 'bad_password') pw.pass.error(e.message);
      else if (e.code === 'code_expired' || e.code === 'link_invalid' || e.code === 'already_created' || e.code === 'email_taken') hooks.dead(e);
      else hooks.error(authErrText(menu, e));
      return false;
    }
  };
  return { nodes: [name.el, ...pw.nodes, setRow(t('auth.signupNews'), newsSwitch.el)], name, create };
}

/** Welcome, signed in (§3.1 step 6): the toast and the account's profile; PERFIL itself is never opened for it. */
export function welcome(menu: Menu, s: AccountSession): void {
  menu.toast(t('game.welcomeNew', { name: s.name }), 'ok');
  void menu.host.accounts.fetchMe().catch(() => undefined);
}

// ---- the forgot sheet (§3.4) ---------------------------------------------------------------------------

/**
 * ¿Olvidaste tu contraseña?: the address (prefilled from the sign-in field), ENVIAR ENLACE, then the
 * same answer for any address (I6). With the mail off, it says so (and names the providers).
 */
export function openForgotSheet(menu: Menu, prefill: string, mailOn: boolean): void {
  if (!mailOn) {
    menu.modal({ title: t('profile.forgot'), body: h('p.mn-note', null, mailOffText(menu)), actions: [{ label: t('outcome.close'), primary: true, onClick: () => true }] });
    return;
  }
  const email = field(t('auth.email'), { type: 'email', autocomplete: 'email', maxLength: 254, value: normalizeEmail(prefill) ?? prefill.trim(), inputmode: 'email', keypad: 'email', enterkeyhint: 'go' });
  email.input.setAttribute('data-autofocus', '');
  const send = async (): Promise<boolean> => {
    email.error(null);
    const address = normalizeEmail(email.input.value);
    if (address === null) {
      email.error(t('error.account.bad_email'));
      return false;
    }
    try {
      await menu.host.accounts.forgot(address);
    } catch (e) {
      email.error(authErrText(menu, e));
      return false;
    }
    // The answer's sheet replaces this one (an Enter in the field, or ENVIAR ENLACE).
    queueMicrotask(() => menu.modal({ title: t('auth.checkMail'), body: h('p', null, t('auth.forgotSent', { email: address })), actions: [{ label: t('outcome.close'), primary: true, onClick: () => true }] }));
    return true;
  };
  // Busy once: a second press (or Enter) while the first is on its way would cost a mail.
  let sending = false;
  const sendOnce = async (): Promise<boolean> => {
    if (sending) return false;
    sending = true;
    try {
      return await send();
    } finally {
      sending = false;
    }
  };
  menu.modal({
    title: t('profile.forgot'),
    body: [h('p.mn-note', null, t('auth.forgotNote')), email.el],
    actions: [
      { label: t('auth.sendLink'), primary: true, onClick: sendOnce },
      { label: t('profile.cancel'), onClick: () => true },
    ],
  });
  // An Enter the menus took (OK on a field in navigation mode starts editing) is no submit.
  email.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.defaultPrevented) void sendOnce();
  });
}

// ---- the reset link (§3.4 steps 3 to 5) ------------------------------------------------------------------

/**
 * "Cargando…" while a link's first POST answers. `cancelled`: the player closed it meanwhile (no
 * sheet follows then); `close` before an error's toast or sheet; `settle` before the sheet that
 * replaces it.
 */
function loadingSheet(menu: Menu): { cancelled: () => boolean; close: () => void; settle: () => void } {
  let settled = false;
  let cancelled = false;
  const close = menu.modal({
    title: t('profile.loading'),
    body: [],
    actions: [{ label: t('profile.cancel'), onClick: () => true }],
    onClose: () => {
      if (!settled) cancelled = true;
    },
  });
  return {
    cancelled: () => cancelled,
    close: () => {
      settled = true;
      close();
    },
    settle: () => {
      settled = true;
    },
  };
}

/** The link is dead (expired, used, superseded): what to do, and PEDIR OTRO for forgot's sheet. */
function deadResetSheet(menu: Menu, mailOn: boolean): void {
  menu.modal({
    title: t('auth.resetDeadLink'),
    body: [],
    actions: [
      { label: t('auth.askAgain'), primary: true, onClick: () => (queueMicrotask(() => openForgotSheet(menu, '', mailOn)), true) },
      { label: t('outcome.close'), onClick: () => true },
    ],
  });
}

/** /account#reset=<token>: who it is for (reset/peek), the new password, GUARDAR Y ENTRAR. */
export async function openResetSheet(menu: Menu, token: string): Promise<void> {
  const acc = menu.host.accounts;
  const loading = loadingSheet(menu);
  let who: ResetPeekAnswer;
  try {
    who = await acc.resetPeek(token);
  } catch (e) {
    if (loading.cancelled()) return;
    loading.close();
    if (e instanceof AccountError && e.code === 'link_invalid') deadResetSheet(menu, (await acc.authConfig()).email);
    else menu.toast(errText(e), 'error');
    return;
  }
  if (loading.cancelled()) return;
  loading.settle();
  resetSheet(menu, token, who);
}

/** The reset link's password sheet for the account in `who` (reset/peek's answer; ui-fit's sample too). */
export function resetSheet(menu: Menu, token: string, who: ResetPeekAnswer): void {
  const acc = menu.host.accounts;
  const pw = newPasswordFields(who.email, t('profile.newPassword'));
  pw.pass.input.setAttribute('data-autofocus', '');
  const save = async (): Promise<boolean> => {
    pw.pass.error(null);
    const password = pw.check();
    if (password === null) return false;
    try {
      await acc.resetPassword(token, password, who);
    } catch (e) {
      if (e instanceof AccountError && e.code === 'link_invalid') {
        queueMicrotask(() => deadResetSheet(menu, true));
        return true;
      }
      pw.pass.error(authErrText(menu, e));
      return false;
    }
    queueMicrotask(() => {
      menu.modal({ title: t('auth.resetDone'), body: h('p', null, t('auth.resetElsewhere')), actions: [{ label: t('outcome.close'), primary: true, onClick: () => true }] });
      void acc.fetchMe().catch(() => undefined);
    });
    return true;
  };
  menu.modal({
    title: who.hasPassword ? t('auth.resetTitle') : t('auth.resetCreateTitle'),
    body: [h('p.mn-note', null, t('auth.resetFor', { name: who.name, email: who.email })), ...pw.nodes],
    actions: [
      { label: t('auth.resetSave'), primary: true, onClick: save },
      { label: t('profile.cancel'), onClick: () => true },
    ],
    // Closed (CANCELAR, Back, a sheet over it): the next page load does not bring it back; the mail's link still works.
    onClose: () => acc.keepPendingLink(null),
  });
}

// ---- the sign-up's link (§3.1 step 5) ------------------------------------------------------------------

/** The proof is dead or its account exists: the sheet that says so, and where to go. */
function deadSignupSheet(menu: Menu, e: AccountError): void {
  const exists = e.code === 'already_created' || e.code === 'email_taken';
  menu.modal({
    title: e.message,
    body: [],
    actions: [
      exists
        ? { label: t('profile.tabSignIn'), primary: true, onClick: () => (queueMicrotask(() => openProfileTab(menu, 'login', e.detail.email ?? null)), true) }
        : { label: t('profile.registerFree'), primary: true, onClick: () => (queueMicrotask(() => openProfileTab(menu, 'register', null)), true) },
      { label: t('outcome.close'), onClick: () => true },
    ],
  });
}

/** /account#verify=<token>: the address it proves (signup/check), then the finish in a sheet. */
export async function openVerifySheet(menu: Menu, token: string): Promise<void> {
  const acc = menu.host.accounts;
  const loading = loadingSheet(menu);
  let email: string;
  try {
    email = await acc.signupCheck({ token });
  } catch (e) {
    if (loading.cancelled()) return;
    loading.close();
    if (e instanceof AccountError && (e.code === 'link_invalid' || e.code === 'code_expired' || e.code === 'already_created')) deadSignupSheet(menu, e);
    else menu.toast(errText(e), 'error');
    return;
  }
  if (loading.cancelled()) return;
  loading.settle();
  verifySheet(menu, token, email);
}

/** The sign-up's finish for the address a link proved, `email` (signup/check's answer; ui-fit's sample too). */
export function verifySheet(menu: Menu, token: string, email: string): void {
  const acc = menu.host.accounts;
  const err = h('p.mn-field-error', { hidden: true, 'aria-live': 'polite' });
  const fields = signupFinishFields(menu, email, {
    proof: () => ({ token }),
    codeFirst: () => undefined,
    done: (s) => welcome(menu, s),
    dead: (e) => queueMicrotask(() => deadSignupSheet(menu, e)),
    error: (msg) => {
      err.hidden = msg === null;
      err.textContent = msg ?? '';
    },
  });
  const other = acc.account !== null ? h('p.mn-note', null, t('auth.signOutNote', { name: acc.account.name })) : null;
  menu.modal({
    title: t('profile.registerFree'),
    body: [h('p.mn-prof-ok', null, t('auth.linkOk', { email })), other, ...fields.nodes, err],
    actions: [
      { label: t('profile.createAccount'), primary: true, onClick: () => fields.create() },
      { label: t('profile.cancel'), onClick: () => true },
    ],
    // Closed (CANCELAR, Back, a sheet over it): the next page load does not bring it back; the mail's link still works.
    onClose: () => acc.keepPendingLink(null),
  });
}

// ---- "confirm it's you" by a code to the account's mailbox (§3.9, PR 7's reauth/code) ------------------------

/** ENVIAR CÓDIGO A {email}: the code to the account's own address, then its field; `then` once this browser is at level 2. */
export async function openReauthCodeSheet(menu: Menu, then: () => void): Promise<void> {
  const acc = menu.host.accounts;
  let start: { attempt: string; to: string };
  try {
    start = await acc.reauthCodeStart();
  } catch (e) {
    menu.toast(authErrText(menu, e), 'error');
    return;
  }
  let close = (): void => undefined;
  const code = codeField((c) => {
    code.error(null);
    void acc.reauthCodeVerify(start.attempt, c).then(
      () => {
        close();
        queueMicrotask(then);
      },
      (e: unknown) => {
        code.error(errText(e));
        code.input.select();
      },
    );
  });
  code.input.setAttribute('data-autofocus', '');
  close = menu.modal({
    title: t('auth.reauthCodeTitle'),
    body: [h('p.mn-note', null, t('auth.codeSent', { email: start.to })), code.el],
    actions: [{ label: t('profile.cancel'), onClick: () => true }],
  });
}

// ---- the page's link, on load ----------------------------------------------------------------------------

/** The menus up and no other sheet (a join link's, the TV's), as the other URL sheets wait. */
async function sheetsReady(menu: Menu): Promise<void> {
  while (!menu.visible || menu.modalOpen) await new Promise((r) => setTimeout(r, 300));
}

/** Open the sheet of `link` (the menus up, no other sheet). */
export async function openAccountLink(menu: Menu, link: AccountLink): Promise<void> {
  await sheetsReady(menu);
  if (link.kind === 'forgot') return openForgotSheet(menu, '', (await menu.host.accounts.authConfig()).email);
  if (link.token === null) return;
  if (link.kind === 'verify') return openVerifySheet(menu, link.token);
  if (link.kind === 'reset') return openResetSheet(menu, link.token);
  // email, undo, keep, unsub: sign-in PR 9, 12 and 13 bring their sheets.
  menu.host.accounts.keepPendingLink(null);
  menu.toast(t('error.account.link_invalid'), 'error');
}

/**
 * On page load (Game.ts, once): a mailed link in the URL (or one a slow first load kept in
 * sessionStorage) opens its sheet once the menus are up, after the account's restore; the URL is
 * cleared at once (the token never stays in the address bar or the history). Without a link, a
 * sign-up that waits for its code (sessionStorage, 30 minutes) brings PERFIL's code step back.
 * Resolves once the link's sheet is open (or there was nothing to do).
 */
export async function installAccountLinks(menu: Menu): Promise<void> {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const acc = menu.host.accounts;
  const fromUrl = parseAccountLink(location.pathname, location.hash);
  if (isAccountPath(location.pathname)) history.replaceState(history.state, '', '/' + location.search);
  if (fromUrl !== null) acc.keepPendingLink(fromUrl);
  const link = fromUrl ?? acc.pendingLink();
  // The Game's restore starts later in its constructor: once it has, it settles first (the sheets
  // know who is signed in).
  await Promise.resolve();
  await acc.sessionForQueue().catch(() => null);
  if (link !== null) return openAccountLink(menu, link);
  if (acc.signupAttempt() !== null && !acc.signedIn) {
    await sheetsReady(menu);
    if (!acc.signedIn && acc.signupAttempt() !== null) openProfileTab(menu, 'register', null);
  }
}

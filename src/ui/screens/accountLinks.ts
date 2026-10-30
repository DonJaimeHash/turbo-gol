/**
 * The account sheets that come from the URL, and the parts PERFIL's email forms share (the sign-in
 * design's §3.1 to §3.4, §3.7, §3.8 and §4.3). Each URL sheet takes its turn through the Game's one
 * arbiter (Game.ts urlSheets: `#auth=…`, then `/account#…`, then the phone's `/tv`), so two of them
 * never open over each other.
 *
 * Email accounts (sign-in PR 8; the routes are PR 7's). PERFIL (profile.ts) builds its guest forms
 * with these parts; a mailed link opens its sheet here:
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
 * On load (installAccountLinks, the arbiter's 'account' step) the link is read from the path and
 * the fragment, its token kept in sessionStorage (AccountClient.keepPendingLink, until its POST
 * settles: a slow first load can try again) and the URL cleared with history.replaceState, at once;
 * the sheet then waits for its turn (after the OAuth result and its confirm sheet, which settle the
 * account's restore) and for the menus up with no other sheet. Nothing is consumed until the
 * sheet's button. A tab the browser reloaded while its sign-up waited for the code comes back to
 * PERFIL's code step.
 *
 * Back from Google or Discord (sign-in PR 6), opened by the arbiter's 'auth' step (Game.ts
 * restoreAccount) on `#auth=confirm`: an identity no Turbogol account owns. Nothing exists yet, and
 * nothing is made without the player's word (I3).
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
 *            its address, or its name; its providers: start?pend=1), CANCELAR; creating is refused
 *            (one email, one account)
 *   have one "Entra con tu cuenta": PERFIL's one field, "Correo o usuario", routed on '@' (an
 *            address: POST /api/auth/signin; a username of before: POST /api/auth/login), both
 *            with linkPending (the identity goes on the account it signs in to, the match only
 *            when there is one), and ENTRAR CON {the other provider} (pend=1)
 *
 * After a create the game never opens PERFIL: the arbiter's next step comes. The flow resolves
 * 'created', 'signedIn' or 'closed' (a provider button leaves the page instead).
 */
import { h, navButton } from '../dom';
import { AccountError, oauthErrorText } from '../../net/AccountClient';
import type { CodeProof, PendingInfo } from '../../net/AccountClient';
import { USERNAME_MAX, normalizeEmail, usernameIssue } from '../../net/account';
import type { AccountSession, MeInfo, OAuthProvider, ResetPeekAnswer, UndoPeekAnswer } from '../../net/account';
import { guestNumber } from '../../net/guestName';
import { inAppBrowser, isAccountPath, parseAccountLink, providersText, signInRoute, signupNamePrefill } from '../../net/emailAuth';
import type { AccountLink, LegacyPhase } from '../../net/emailAuth';
import type { Menu } from '../Menu';
import type { SheetAction } from '../components/sheet';
import { setRow, toggleSwitch } from '../components/rows';
import { finePointer } from '../device';
import { codeField, field } from './common';
import type { Field } from './common';
import { errText, openProfileTab } from './profile';
import { namePrefill } from './accountLinksModel';
import { language, t } from '../../i18n';

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
function signupName(menu: Menu): string {
  return signupNamePrefill(t('auth.signupNameWord'), guestNumber(menu.host.guestName()), (n) => usernameIssue(n) === null);
}

/**
 * A new password for `email`'s account: before it, the address as a read-only username for a
 * password manager (it saves the address, not the in-game name), then the password with MOSTRAR,
 * and its repeat where the keypad shows dots. `check` resolves the password or null after showing
 * what is wrong.
 */
export function newPasswordFields(email: string, label: string, withUser = true): { nodes: HTMLElement[]; pass: Field; inputs: HTMLInputElement[]; check: () => string | null } {
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
  return { nodes: [...(user !== null ? [user] : []), pass.el, ...(again !== null ? [again.el] : [])], pass, inputs: [pass.input, ...(again !== null ? [again.input] : [])], check };
}

/**
 * Enter on a sheet's fields (a keyboard's Enter, a phone keyboard's Siguiente / Ir, as each one's
 * enterkeyhint says): the next field, and on the last one the sheet's primary action, pressed as
 * its own button (busy once: the sheet disables it while it runs, and closes on its answer). Not
 * the Enter / OK that starts editing a field reached with the arrows (Menu.onFieldKey cancels it).
 */
export function sheetEnter(inputs: readonly HTMLInputElement[]): void {
  inputs.forEach((input, i) =>
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.defaultPrevented) return;
      e.preventDefault();
      const next = inputs[i + 1];
      if (next !== undefined) next.focus();
      else input.closest('.mn-sheet')?.querySelector<HTMLButtonElement>('.mn-sheet-actions .mn-btn-primary')?.click();
    }),
  );
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
export function signupFinishFields(menu: Menu, email: string, hooks: FinishHooks): { nodes: HTMLElement[]; name: Field; inputs: HTMLInputElement[]; create: () => Promise<boolean> } {
  const acc = menu.host.accounts;
  const name = field(t('auth.signupName'), { autocomplete: 'nickname', maxLength: USERNAME_MAX, value: signupName(menu), hint: t('auth.signupNameHint'), enterkeyhint: 'next' });
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
  // `inputs`: the name, then the password (and its repeat), for Enter's next field and its submit.
  return { nodes: [name.el, ...pw.nodes, setRow(t('auth.signupNews'), newsSwitch.el)], name, inputs: [name.input, ...pw.inputs], create };
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
 * `after`: a line for where the player goes once the password is saved (the confirm step's sheets:
 * sign in with the provider again, then with the new password, which links it).
 */
export function openForgotSheet(menu: Menu, prefill: string, mailOn: boolean, after: string | null = null): void {
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
    queueMicrotask(() => menu.modal({ title: t('auth.checkMail'), body: [h('p', null, t('auth.forgotSent', { email: address })), after !== null ? h('p.mn-note', null, after) : null], actions: [{ label: t('outcome.close'), primary: true, onClick: () => true }] }));
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
    body: [h('p.mn-note', null, t('auth.forgotNote')), email.el, after !== null ? h('p.mn-note', null, after) : null],
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
  sheetEnter(pw.inputs);
}

// ---- the sign-up's link (§3.1 step 5)------------------------------------------------------------------

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
  sheetEnter(fields.inputs);
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


// ---- adding and changing the email (sign-in PR 9: the design's §3.6, §3.10) ---------------------------------

/** What an email sheet needs from where it was opened (PERFIL's rows and banner, the grace sheet). */
export interface EmailHooks {
  /** The account had a verified address: a change (its toast says the other devices were signed out). */
  change: boolean;
  /** The server asks this browser to confirm it is them at `level` first (PERFIL's fresh), then the sheet again. */
  reauth: (level: 1 | 2) => void;
}

/** The day of the cutoff in the page's language ("15 de enero de 2027", "15 January 2027"): it falls at 12:00 UTC, the same day in the Americas and Spain. */
export function cutoffDay(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(language(), { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * ENVIAR CÓDIGO for the address in `email` (POST /api/me/email), as a sheet's primary action: the
 * code sheet next. A refusal that needs "confirm it's you" hands over to `hooks.reauth`; any other
 * shows under the field. Busy once: the sheet disables its button while it runs.
 */
function sendCodeAction(menu: Menu, email: Field, hooks: EmailHooks): () => Promise<boolean> {
  return async () => {
    email.error(null);
    const address = normalizeEmail(email.input.value);
    if (address === null) {
      email.error(t('error.account.bad_email'));
      return false;
    }
    const err = await startEmailCode(menu, address, hooks);
    if (err === null) return true;
    email.error(err);
    return false;
  };
}

/**
 * POST /api/me/email for `address`, then its code sheet: null once it went (or handed over to
 * "confirm it's you"), else the refusal's text. PERFIL's banner sends a hint's address with no sheet
 * before it (its ENVIAR CÓDIGO).
 */
export async function startEmailCode(menu: Menu, address: string, hooks: EmailHooks): Promise<string | null> {
  try {
    const start = await menu.host.accounts.emailStart(address);
    queueMicrotask(() => emailCodeSheet(menu, start, hooks));
    return null;
  } catch (e) {
    if (e instanceof AccountError && e.code === 'reauth_required') {
      queueMicrotask(() => hooks.reauth(e.level === 2 ? 2 : 1));
      return null;
    }
    return authErrText(menu, e);
  }
}

/**
 * AGREGAR, CAMBIAR or CONFIRMAR on PERFIL's Correo row (§3.6 step 3): the new address (`prefill`: the
 * hint for CONFIRMAR), what is mailed, ENVIAR CÓDIGO; then the code sheet. The session is already
 * fresh enough (PERFIL's fresh), or the server says which level it wants (`hooks.reauth`).
 */
export function emailSheet(menu: Menu, title: string, prefill: string, hooks: EmailHooks): void {
  const email = field(t('auth.emailNew'), { type: 'email', autocomplete: 'email', maxLength: 254, value: prefill, inputmode: 'email', keypad: 'email', enterkeyhint: 'go' });
  email.input.setAttribute('data-autofocus', '');
  menu.modal({
    title,
    body: [h('p.mn-note', null, hooks.change ? t('auth.emailChangeNote') : t('auth.emailAddNote')), email.el],
    actions: [
      { label: t('auth.sendCode'), primary: true, onClick: sendCodeAction(menu, email, hooks) },
      { label: t('profile.cancel'), onClick: () => true },
    ],
  });
  sheetEnter([email.input]);
}

/**
 * The code of an add or a change (§3.6 step 4, §3.7): "We sent a code to {email}", the code field (it
 * checks itself at the sixth digit), PEDIR OTRO when it is dead, REENVIAR after its minute (3 per
 * attempt), "use another email", and the note that a mail to an address another account holds says
 * what to do. Done: the toast (a change says the other devices were signed out; an add, how the
 * account signs in now) and the account's profile again.
 */
export function emailCodeSheet(menu: Menu, start: { attempt: string; resendAt: number; to: string }, hooks: EmailHooks): void {
  const acc = menu.host.accounts;
  let attempt = start.attempt;
  let readyAt = start.resendAt;
  let resendsLeft = 3;
  let close = (): void => undefined;
  let timer: ReturnType<typeof setInterval> | null = null;
  const live = h('p.mn-prof-live', { 'aria-live': 'polite' });
  const done = (me: MeInfo): void => {
    const email = typeof me.email === 'string' ? me.email : start.to;
    menu.toast(hooks.change ? t('auth.emailChanged') : me.hasPassword ? t('auth.emailAddedPassword', { email }) : t('auth.emailAdded', { email }), 'ok');
  };
  const again = navButton(
    'mn-btn mn-btn-secondary',
    t('auth.askAgain'),
    () =>
      void acc.emailStart(start.to).then(
        (s) => {
          attempt = s.attempt;
          readyAt = s.resendAt;
          resendsLeft = 3;
          again.hidden = true;
          code.error(null);
          code.input.value = '';
          paint();
        },
        (e: unknown) => code.error(authErrText(menu, e)),
      ),
    { 'data-key': 'auth-email-again', hidden: true },
  );
  const code = codeField((c) => {
    code.error(null);
    void acc.emailVerify(attempt, c).then(
      (me) => {
        close();
        done(me);
      },
      (e: unknown) => {
        code.error(authErrText(menu, e));
        if (e instanceof AccountError && (e.code === 'code_expired' || e.code === 'email_taken' || e.code === 'move_refused')) again.hidden = e.code !== 'code_expired';
        else code.input.select();
      },
    );
  });
  code.input.setAttribute('data-autofocus', '');
  const resend = navButton('mn-btn mn-btn-secondary', '', () => void doResend(), { 'data-key': 'auth-email-resend' });
  const paint = (): void => {
    const left = readyAt - Date.now();
    const label = left > 0 ? t('auth.resendIn', { seconds: Math.ceil(left / 1000) }) : t('auth.resend');
    if (resend.textContent !== label) resend.textContent = label;
    const wasWaiting = resend.disabled;
    resend.disabled = left > 0;
    resend.hidden = resendsLeft <= 0;
    if (wasWaiting && left <= 0) live.textContent = t('auth.resendReady');
  };
  const doResend = async (): Promise<void> => {
    if (resend.disabled) return;
    try {
      const r = await acc.emailResend(attempt);
      readyAt = r.resendAt;
      resendsLeft = r.resendsLeft;
      live.textContent = '';
      menu.toast(t('auth.resent'), 'ok');
    } catch (e) {
      code.error(authErrText(menu, e));
      if (e instanceof AccountError && e.code === 'code_expired') again.hidden = false;
    }
    paint();
  };
  const other = navButton('mn-link', t('auth.otherEmail'), () => {
    close();
    queueMicrotask(() => emailSheet(menu, hooks.change ? t('auth.emailChangeTitle') : t('auth.emailAddTitle'), start.to, hooks));
  }, { 'data-key': 'auth-email-other' });
  paint();
  close = menu.modal({
    title: t('auth.reauthCodeTitle'),
    body: [h('p.mn-note', null, t('auth.codeSent', { email: start.to })), code.el, again, h('div.mn-prof-code-links', null, resend, other), h('p.mn-note', null, t('auth.emailCodeNote')), live],
    actions: [{ label: t('profile.cancel'), onClick: () => true }],
    onClose: () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  });
  if (typeof setInterval === 'function') timer = setInterval(paint, 1000);
}

/**
 * Right after a sign-in with a username (§3.10 step 3), and PERFIL's banner's AGREGAR CORREO: "Agrega
 * tu correo", the date while there is one, the address (prefilled with a provider's hint), ENVIAR
 * CÓDIGO, VINCULAR for each configured provider the account has not linked, MÁS TARDE. The session is
 * level 2 there (the password was just typed), so nothing more is asked.
 */
export function graceSheet(menu: Menu, o: { until: number | null; closed: boolean; prefill: string; link: OAuthProvider[]; hooks: EmailHooks; goLink: (p: OAuthProvider) => void }): void {
  const email = field(t('auth.email'), { type: 'email', autocomplete: 'email', maxLength: 254, value: o.prefill, inputmode: 'email', keypad: 'email', enterkeyhint: 'go' });
  email.input.setAttribute('data-autofocus', '');
  menu.modal({
    title: t('auth.graceTitle'),
    body: [h('p.mn-note', null, graceText(o.until, o.closed)), email.el],
    actions: [
      { label: t('auth.sendCode'), primary: true, onClick: sendCodeAction(menu, email, o.hooks) },
      ...o.link.map((p): SheetAction => ({ label: t('profile.link', { provider: providerName(p).toUpperCase() }), onClick: () => (o.goLink(p), false) })),
      { label: t('auth.graceLater'), onClick: () => true },
    ],
  });
  sheetEnter([email.input]);
}

/** The grace's sentence: after the cutoff, with its date, or without one (LEGACY_PASSWORD_UNTIL unset). */
export function graceText(until: number | null, closed: boolean): string {
  if (closed) return t('auth.graceClosed');
  return until !== null ? t('auth.graceDate', { date: cutoffDay(until) }) : t('auth.graceNoDate');
}

/**
 * /account#email=<token> (§3.6 step 4): the mailed link of an add or a change, from any device.
 * Nothing is consumed until CONFIRMAR CORREO (a mail scanner's visit does nothing); then "Done: {email}
 * is now the email of the account {name}". A dead link says so.
 */
export function openEmailLinkSheet(menu: Menu, token: string): void {
  const acc = menu.host.accounts;
  const err = h('p.mn-field-error', { hidden: true, 'aria-live': 'polite' });
  menu.modal({
    title: t('auth.emailLinkTitle'),
    body: [h('p.mn-note', null, t('auth.emailLinkNote')), err],
    actions: [
      {
        label: t('auth.emailLinkConfirm'),
        primary: true,
        onClick: async () => {
          err.hidden = true;
          try {
            const r = await acc.emailConfirm(token);
            queueMicrotask(() => menu.modal({ title: t('auth.emailLinkDoneTitle'), body: h('p', null, t('auth.emailLinkDone', { email: r.email, name: r.name })), actions: [{ label: t('outcome.close'), primary: true, onClick: () => true }] }));
            return true;
          } catch (e) {
            err.textContent = authErrText(menu, e);
            err.hidden = false;
            return false;
          }
        },
      },
      { label: t('profile.cancel'), onClick: () => true },
    ],
    // Closed (CANCELAR, Back, a sheet over it): the next page load does not bring it back; the mail's link still works.
    onClose: () => acc.keepPendingLink(null),
  });
}

/** /account#undo=<token> (§3.6 step 6): whom it is for (undo/peek), then "Recupera tu cuenta". */
export async function openUndoSheet(menu: Menu, token: string): Promise<void> {
  const acc = menu.host.accounts;
  const loading = loadingSheet(menu);
  let who: UndoPeekAnswer;
  try {
    who = await acc.undoPeek(token);
  } catch (e) {
    if (loading.cancelled()) return;
    loading.close();
    menu.toast(e instanceof AccountError && e.code === 'link_invalid' ? t('error.account.link_invalid') : errText(e), 'error');
    return;
  }
  if (loading.cancelled()) return;
  loading.settle();
  undoSheet(menu, token, who);
}

/**
 * M6's undo (§3.6 step 6): "Tu cuenta vuelve a {email}. Elige una contraseña nueva: se cierra la sesión
 * en todos los dispositivos.", the new password (the address before it for a password manager),
 * GUARDAR Y ENTRAR. Done: this browser is signed in, every other device is out.
 */
export function undoSheet(menu: Menu, token: string, who: UndoPeekAnswer): void {
  const acc = menu.host.accounts;
  const pw = newPasswordFields(who.email, t('profile.newPassword'));
  pw.pass.input.setAttribute('data-autofocus', '');
  const save = async (): Promise<boolean> => {
    pw.pass.error(null);
    const password = pw.check();
    if (password === null) return false;
    try {
      await acc.emailUndo(token, password, who);
    } catch (e) {
      pw.pass.error(authErrText(menu, e));
      return false;
    }
    queueMicrotask(() => {
      menu.modal({ title: t('auth.undoDoneTitle'), body: h('p', null, t('auth.undoDone', { email: who.email })), actions: [{ label: t('outcome.close'), primary: true, onClick: () => true }] });
      void acc.fetchMe().catch(() => undefined);
    });
    return true;
  };
  menu.modal({
    title: t('auth.undoTitle'),
    body: [h('p.mn-note', null, t('auth.undoNote', { email: who.email })), ...pw.nodes],
    actions: [
      { label: t('auth.resetSave'), primary: true, onClick: save },
      { label: t('profile.cancel'), onClick: () => true },
    ],
    onClose: () => acc.keepPendingLink(null),
  });
  sheetEnter(pw.inputs);
}

// ---- the page's link, on load ----------------------------------------------------------------------------

/** The menus up and no other sheet (a join link's, the TV's), as the other URL sheets wait. */
async function sheetsReady(menu: Menu): Promise<void> {
  while (!menu.visible || menu.modalOpen) await new Promise((r) => setTimeout(r, 200));
}

/** No sheet is up any more: the ones a link opened, and those they opened in turn, are over. */
async function sheetsClosed(menu: Menu): Promise<void> {
  while (menu.modalOpen) await new Promise((r) => setTimeout(r, 200));
}

/** Open the sheet of `link` (the menus up, no other sheet). */
export async function openAccountLink(menu: Menu, link: AccountLink): Promise<void> {
  await sheetsReady(menu);
  if (link.kind === 'forgot') return openForgotSheet(menu, '', (await menu.host.accounts.authConfig()).email);
  if (link.token === null) return;
  if (link.kind === 'verify') return openVerifySheet(menu, link.token);
  if (link.kind === 'reset') return openResetSheet(menu, link.token);
  if (link.kind === 'email') return openEmailLinkSheet(menu, link.token);
  if (link.kind === 'undo') return openUndoSheet(menu, link.token);
  // keep, unsub: sign-in PR 12 and 13 bring their sheets.
  menu.host.accounts.keepPendingLink(null);
  menu.toast(t('error.account.link_invalid'), 'error');
}

/**
 * On page load (Game.ts, once: the arbiter's 'account' step, `turn`): a mailed link in the URL (or
 * one a slow first load kept in sessionStorage) opens its sheet once the steps before it are done
 * (the OAuth result and its confirm sheet, and with them the account's restore) and the menus are
 * up; the URL is cleared at once (the token never stays in the address bar or the history).
 * Without a link, a sign-up that waits for its code (sessionStorage, 30 minutes) brings PERFIL's
 * code step back. Resolves once the link's sheets are over (or there was nothing to do), so the
 * next step (the phone's /tv) never opens over them.
 */
export async function installAccountLinks(menu: Menu, turn: () => Promise<void> = () => Promise.resolve()): Promise<void> {
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  const acc = menu.host.accounts;
  const fromUrl = parseAccountLink(location.pathname, location.hash);
  if (isAccountPath(location.pathname)) history.replaceState(history.state, '', '/' + location.search);
  if (fromUrl !== null) acc.keepPendingLink(fromUrl);
  const link = fromUrl ?? acc.pendingLink();
  // Its turn: after #auth=… (an /account#reset link kept while the confirm sheet asks waits for it).
  await turn();
  // The Game's restore, if one is still on its way, settles first (the sheets know who is signed in).
  await acc.sessionForQueue().catch(() => null);
  if (link !== null) {
    await openAccountLink(menu, link);
    return sheetsClosed(menu);
  }
  if (acc.signupAttempt() !== null && !acc.signedIn) {
    await sheetsReady(menu);
    if (!acc.signedIn && acc.signupAttempt() !== null) openProfileTab(menu, 'register', null);
  }
}

// ---- back from Google or Discord: the confirm step (§3.8, sign-in PR 6) -------------------------------

/** How the flow ended. */
export type PendingOutcome = 'created' | 'signedIn' | 'closed';

const PROVIDER_NAMES: Readonly<Record<OAuthProvider, string>> = { google: 'Google', discord: 'Discord' };

/** A provider's name as the sheets write it. */
export function providerName(p: OAuthProvider): string {
  return PROVIDER_NAMES[p];
}

/**
 * ¿Olvidaste tu contraseña? on the confirm step's sheets (§3.8): the confirm flow ends (its pending
 * identity goes: no reset links it), and the forgot sheet opens for `prefill`, saying what comes
 * after: sign in with the provider again, which finds the account, then with the new password,
 * which links it. `close`: the sheet up, closed first.
 */
function pendingForgot(menu: Menu, provider: string, prefill: string, close: () => void): HTMLButtonElement {
  return navButton(
    'mn-link mn-prof-forgot',
    t('profile.forgot'),
    () => {
      close();
      void menu.host.accounts.authConfig().then((c) => openForgotSheet(menu, prefill, c.email, t('auth.forgotPendingNote', { provider })));
    },
    { 'data-key': 'auth-pending-forgot' },
  );
}

/** A provider's round trip from these sheets (start?pend=1): "continue as" learns it once it signs in. */
function goPend(menu: Menu, p: OAuthProvider): void {
  const acc = menu.host.accounts;
  acc.providerStarted(p);
  window.location.href = acc.oauthUrl(p, 'pend');
}

/** The player's IANA time zone for the dates of its mail ('' when the browser says none). */
function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
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
 * POST /api/auth/pending (and the username sign-in's phase for "I have one": GET /api/config,
 * once per page), then the sheet for its answer, which replaces the one up. `took`: that sheet is
 * done with (its closer, for an answer that opens no other).
 */
async function load(menu: Menu, end: (o: PendingOutcome) => void, took: () => () => void): Promise<void> {
  const acc = menu.host.accounts;
  const cfg = acc.authConfig();
  let info: PendingInfo | null = null;
  let failed: unknown = null;
  try {
    info = await acc.pending();
  } catch (e) {
    failed = e;
  }
  const legacy = (await cfg).legacy;
  const close = took();
  if (info === null) {
    close();
    menu.toast(failed !== null ? errText(failed) : t('auth.pendingExpired'), 'error');
    end('closed');
    return;
  }
  if (info.match !== null) matchSheet(menu, info, legacy, end);
  else confirmSheet(menu, info, legacy, end);
}

/** No account uses this identity, and its address leads to none: create one, or sign in to one and link. */
function confirmSheet(menu: Menu, info: PendingInfo, legacy: LegacyPhase, end: (o: PendingOutcome) => void): void {
  const acc = menu.host.accounts;
  const p = providerName(info.provider);
  let handed = false;
  const name = field(t('auth.gameName'), { autocomplete: 'nickname', maxLength: USERNAME_MAX, value: namePrefill(t('auth.nameWord'), guestNumber(menu.host.guestName())), hint: t('auth.gameNameHint'), enterkeyhint: 'done' });
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
        // A taken name, a look-alike of a protected account or a reserved word: the server's free one goes in the field.
        if (e instanceof AccountError && (e.code === 'username_taken' || e.code === 'name_lookalike' || e.code === 'name_reserved') && e.suggest !== null) {
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
      haveOneSheet(menu, info, null, legacy, end, () => confirmSheet(menu, info, legacy, end));
      return false;
    },
  };
  // Forgot the password of the account they have (§3.8): the forgot sheet for the provider's address.
  const forgot = pendingForgot(menu, p, info.email ?? '', () => close());
  const close = menu.modal({
    title: t('auth.confirmTitle'),
    body: [
      describe(info.email !== null ? t('auth.confirmNone', { provider: p, email: info.email }) : t('auth.confirmNoneNoEmail', { provider: p })),
      info.second !== null ? h('p.mn-note', null, t('auth.confirmSecond', { provider: providerName(info.second) })) : null,
      info.trust === 'none' ? h('p.mn-note', null, t('auth.confirmNoEmail', { provider: p })) : null,
      name.el,
      setRow(t('auth.news'), sw.el),
      forgot,
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
function matchSheet(menu: Menu, info: PendingInfo, legacy: LegacyPhase, end: (o: PendingOutcome) => void): void {
  const acc = menu.host.accounts;
  const m = info.match;
  if (m === null) return confirmSheet(menu, info, legacy, end);
  const p = providerName(info.provider);
  let handed = false;
  const ways: SheetAction[] = [];
  if (m.methods.includes('password')) {
    ways.push({
      label: t('auth.matchPassword'),
      onClick: () => {
        handed = true;
        // The address it claimed signs in by email; a hint (an account of before) by its name.
        haveOneSheet(menu, info, m.via === 'email' ? m.email : m.name, legacy, end, () => matchSheet(menu, info, legacy, end));
        return false;
      },
    });
  }
  for (const w of m.methods) {
    if (w === 'password' || !emailProviders(menu).includes(w)) continue;
    ways.push({
      label: t('tvlink.signInWith', { provider: providerName(w).toUpperCase() }),
      onClick: () => {
        handed = true;
        goPend(menu, w);
        return false;
      },
    });
  }
  if (ways.length > 0) ways[0].primary = true;
  // Only when the match claimed that address (§3.8): its reset goes to it. A hint's account is mailed nothing.
  const forgot = m.via === 'email' ? pendingForgot(menu, p, m.email, () => close()) : null;
  const close = menu.modal({
    title: t('auth.matchTitle'),
    body: [describe(t('auth.matchBody', { email: m.email, name: m.name, provider: p })), info.trust === 'asserted' ? h('p.mn-note', null, t('auth.matchNotYours', { provider: p })) : null, forgot],
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
 * "I already have one" ("Entra con tu cuenta"): sign in to that account here and the identity is
 * linked to it, or with the other provider (start?pend=1). PERFIL's one field for an address or a
 * username of before (§3.3, emailAuth.ts signInRoute): an '@' signs in by email (POST
 * /api/auth/signin), anything else by the legacy sign-in while it lasts (POST /api/auth/login),
 * both with linkPending; after the cutoff (`legacy` 'closed') a username gets legacy_closed with no
 * request. `prefill`: the match's address (or its name); without one, this browser's last name.
 * VOLVER: `back` (the sheet before).
 */
function haveOneSheet(menu: Menu, info: PendingInfo, prefill: string | null, legacy: LegacyPhase, end: (o: PendingOutcome) => void, back: () => void): void {
  const acc = menu.host.accounts;
  const p = providerName(info.provider);
  let handed = false;
  const closed = legacy === 'closed';
  const user = field(closed ? t('auth.email') : t('auth.identity'), { autocomplete: 'username', maxLength: 254, value: prefill ?? acc.hintName ?? '', enterkeyhint: 'next', inputmode: 'email', keypad: 'email' });
  const pass = field(t('profile.password'), { type: 'password', autocomplete: 'current-password', maxLength: 128, enterkeyhint: 'go', reveal: true });
  const hint = h('p.mn-note.mn-prof-hint', { hidden: true });
  const others = emailProviders(menu).filter((o) => o !== info.provider && o !== info.second);
  const othersText = providersText(others, t('profile.or'));
  // The forgot sheet for the address typed (a username: the address is asked there).
  const forgot = navButton(
    'mn-link mn-prof-forgot',
    t('profile.forgot'),
    () => {
      const typed = user.input.value.trim();
      close();
      void acc.authConfig().then((c) => openForgotSheet(menu, typed.includes('@') ? typed : '', c.email, t('auth.forgotPendingNote', { provider: p })));
    },
    { 'data-key': 'auth-pending-forgot' },
  );
  const close = menu.modal({
    title: t('auth.haveOneTitle'),
    body: [describe(t('auth.haveOneLine', { provider: p })), user.el, pass.el, hint, forgot],
    actions: [
      {
        label: t('profile.signIn'),
        primary: true,
        onClick: async () => {
          user.error(null);
          pass.error(null);
          hint.hidden = true;
          const route = signInRoute(user.input.value, legacy);
          if (route.kind === 'empty') return (user.error(t('auth.emptyIdentity')), false);
          if (route.kind === 'bad_email') return (user.error(t('error.account.bad_email')), false);
          if (route.kind === 'closed') return (user.error(othersText.length > 0 ? `${t('error.account.legacy_closed')} ${t('auth.legacyClosedProviders', { providers: othersText })}` : t('error.account.legacy_closed')), false);
          try {
            const r = route.kind === 'email' ? await acc.signInAndLink(route.email, pass.input.value) : await acc.loginAndLink(route.username, pass.input.value);
            handed = true;
            menu.toast(r.linked.length > 0 ? t('auth.linkedProvider', { provider: r.linked.map(providerName).join(' · ') }) : `${t('profile.hello', { name: r.session.name })}. ${oauthErrorText(r.linkError ?? 'no_pending')}`, r.linked.length > 0 ? 'ok' : 'error');
            void acc.fetchMe().catch(() => undefined);
            end('signedIn');
            return true;
          } catch (e) {
            pass.error(authErrText(menu, e));
            // One bad_credentials, a hint per branch (as PERFIL's sign-in).
            if (e instanceof AccountError && e.code === 'bad_credentials') {
              const text = route.kind === 'legacy' ? t('auth.badLegacyHint') : othersText.length > 0 ? t('auth.badCredentialsHint', { providers: othersText }) : null;
              if (text !== null) {
                hint.textContent = text;
                hint.hidden = false;
              }
            }
            return false;
          }
        },
      },
      ...others.map(
        (o): SheetAction => ({
          label: t('tvlink.signInWith', { provider: providerName(o).toUpperCase() }),
          onClick: () => {
            handed = true;
            goPend(menu, o);
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
  // Enter (a phone keyboard's Siguiente / Ir): the password, then ENTRAR, once.
  sheetEnter([user.input, pass.input]);
  linkDescription();
}

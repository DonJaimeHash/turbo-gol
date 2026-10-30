/**
 * The TV sign-in's, the keypad's and the email accounts' samples for the layout check
 * (scripts/ui-fit.mjs, plan PR 14, sign-in PR 8): window.__tvSignIn, in development and in a
 * VITE_UI_FIT=1 build only (the Game installs it).
 */
import { h } from '../dom';
import { t } from '../../i18n';
import { AccountError } from '../../net/AccountClient';
import { ATTEMPT_KEY, keepAttempt } from '../../net/emailAuth';
import type { Menu } from '../Menu';
import { openForgotSheet, resetSheet, verifySheet } from './accountLinks';
import { codeField } from './common';
import { openCodeEntry, joinFlow } from './lobby';
import { openProfileTab } from './profile';
import { askSheet, codeSheet, refusedSheet, signInFirstSheet, tvSheet } from './tvSignIn';

const UI_FIT = import.meta.env.DEV || import.meta.env.VITE_UI_FIT === '1';

export type TvSample = 'keypad-password' | 'keypad-code' | 'keypad-email' | 'keypad-digits' | 'tv' | 'tv-expired' | 'tvlink-signin' | 'tvlink-code' | 'tvlink-ask' | 'tvlink-refused' | 'antibot' | 'signup-code' | 'forgot' | 'reset' | 'verify';

/**
 * window.__tvSignIn(kind | null): mn-keypad over a locked lobby's password (dots), the code cells'
 * sheet, an address (the forgot sheet's field: + and @) and a mailed code's digits (without a fine
 * pointer only: Menu.openKeypad); the TV's sheet with a code and expired; the phone's /tv sheets
 * (sign in first, the code, the question with a long name, a refusal); the anti-bot sheet; the
 * email accounts' code step (PERFIL, a sample attempt), forgot, reset and verify sheets with a
 * long name and address. No server. null puts it all back. Nothing in a release build.
 */
/** A long address for the email samples (what a sheet's line must hold). */
const LONG_EMAIL = 'maximiliano.gomez.rodriguez@example-correo.com.ar';

/** The code step's sample attempt off (its sessionStorage entry is this sample's only). */
function dropSampleAttempt(): void {
  try {
    if ((sessionStorage.getItem(ATTEMPT_KEY) ?? '').includes('sample-attempt-')) keepAttempt(sessionStorage, null);
  } catch {
    /* storage off */
  }
}

export function installTvSamples(menu: Menu): void {
  if (!UI_FIT) return;
  const noop = (): void => undefined;
  /** PERFIL as a guest (an account's or an operator's sample left by ui-fit's profile cases goes). */
  const guestProfile = (): void => {
    menu.open('profile', true);
    (window as unknown as { __profile?: (kind: null) => void }).__profile?.(null);
  };
  const keypadOn = (selector: string): void => {
    const f = document.querySelector<HTMLInputElement>(selector);
    if (f !== null) menu.openKeypad(f);
  };
  (window as unknown as { __tvSignIn: (kind: TvSample | null) => void }).__tvSignIn = (kind) => {
    if (menu.keypadOpen) menu.back();
    if (menu.modalOpen) menu.back(); // the last sample's sheet
    // The code step's sample attempt goes with its sample.
    if (kind !== 'signup-code') dropSampleAttempt();
    switch (kind) {
      case null:
        menu.open('home', true);
        return;
      case 'keypad-password':
        // A locked lobby's password (PERFIL's guest form on a TV has no field: the phone signs in there).
        menu.open('home', true);
        void joinFlow(menu, 'ABC234', true);
        keypadOn('.mn-sheet input[type=password]');
        return;
      case 'keypad-email':
        menu.open('home', true);
        openForgotSheet(menu, '', true);
        keypadOn('.mn-sheet input[type=email]');
        return;
      case 'keypad-digits':
        menu.open('home', true);
        menu.modal({ title: t('auth.reauthCodeTitle'), body: [h('p.mn-note', null, t('auth.codeSent', { email: LONG_EMAIL })), codeField(noop).el], actions: [{ label: t('profile.cancel'), onClick: () => true }] });
        keypadOn('.mn-sheet .mn-code-input');
        return;
      case 'signup-code':
        (window as unknown as { __profile?: (kind: null) => void }).__profile?.(null);
        keepAttempt(sessionStorage, { attempt: 'sample-attempt-0123456789', purpose: 'signup', email: LONG_EMAIL, resendAt: Date.now() + 42_000, at: Date.now() });
        openProfileTab(menu, 'register', null);
        return;
      case 'forgot':
        menu.open('home', true);
        openForgotSheet(menu, LONG_EMAIL, true);
        return;
      case 'reset':
        menu.open('home', true);
        resetSheet(menu, 'sample-token-0123456789', { name: 'MaximilianoGomez', email: LONG_EMAIL, hasPassword: true });
        return;
      case 'verify':
        menu.open('home', true);
        verifySheet(menu, 'sample-token-0123456789', LONG_EMAIL);
        return;
      case 'keypad-code':
        menu.open('modes', true, 'lobbies');
        openCodeEntry(menu);
        keypadOn('.mn-codecells-input');
        return;
      case 'tv':
      case 'tv-expired':
        guestProfile();
        tvSheet(menu, kind === 'tv' ? { kind: 'code', s: { code: 'ABC234', secret: '', expiresAt: Date.now() + 272_000, ttlMs: 272_000, pollMs: 3000 }, until: performance.now() + 272_000 } : { kind: 'expired' }, noop, noop);
        return;
      case 'tvlink-signin':
        menu.open('home', true);
        signInFirstSheet(menu, 'ABC234', noop);
        return;
      case 'tvlink-code':
        menu.open('home', true);
        codeSheet(menu, 'ABC2', noop);
        return;
      case 'tvlink-ask':
        menu.open('home', true);
        askSheet(menu, 'MaximilianoGomez', 'ABC234', { where: { country: 'AR', city: 'San Miguel de Tucumán', asn: 7303, org: 'Telecom Argentina S.A.' }, sameNetwork: false, sameCountry: false, createdAt: 0 }, () => Promise.resolve(), noop);
        return;
      case 'tvlink-refused':
        menu.open('home', true);
        refusedSheet(menu, new AccountError(t('error.account.tv_code_expired'), 410, 'tv_code_expired'), noop);
        return;
      case 'antibot':
        menu.open('home', true);
        menu.antiBotAsk(true, noop);
        return;
    }
  };
}

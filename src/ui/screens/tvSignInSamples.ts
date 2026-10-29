/**
 * The TV sign-in's and the keypad's samples for the layout check (scripts/ui-fit.mjs, plan PR 14):
 * window.__tvSignIn, in development and in a VITE_UI_FIT=1 build only (the Game installs it).
 */
import { t } from '../../i18n';
import { AccountError } from '../../net/AccountClient';
import type { Menu } from '../Menu';
import { openCodeEntry } from './lobby';
import { askSheet, codeSheet, refusedSheet, signInFirstSheet, tvSheet } from './tvSignIn';

const UI_FIT = import.meta.env.DEV || import.meta.env.VITE_UI_FIT === '1';

export type TvSample = 'keypad' | 'keypad-password' | 'keypad-code' | 'tv' | 'tv-expired' | 'tvlink-signin' | 'tvlink-code' | 'tvlink-ask' | 'tvlink-refused' | 'antibot';

/**
 * window.__tvSignIn(kind | null): mn-keypad over PERFIL's guest name, its password (dots) and the
 * code cells' sheet (without a fine pointer only: Menu.openKeypad); the TV's sheet with a code and
 * expired; the phone's /tv sheets (sign in first, the code, the question with a long name, a
 * refusal); the anti-bot sheet. No server. null puts it all back. Nothing in a release build.
 */
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
    switch (kind) {
      case null:
        menu.open('home', true);
        return;
      case 'keypad':
      case 'keypad-password':
        guestProfile();
        keypadOn(kind === 'keypad' ? '.mn-prof-guestname .mn-input' : '.mn-prof-form input[type=password]');
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
        askSheet(menu, 'MaximilianoGomez', 'ABC234', () => Promise.resolve(), noop);
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

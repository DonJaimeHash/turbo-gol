/**
 * Ajustes in the menus: a stacked mn- screen (‹ AJUSTES and the pills in the top bar, the hint bar,
 * backModel's Back) around the Game's SettingsView. Menu.openSettings opens the view first (with what
 * runs when it closes: the Game's, the caller's); a plain Menu.open('settings', …, tab) (scripts/
 * ui-fit.mjs) opens it here. It closes once the screen leaves the stack: Back, a crumb, a section,
 * the menus showing another screen (Menu.mount also when it went from under another one); PERFIL
 * over it (a guest's SIGN IN) keeps it open but held (SettingsView.suspend: no capture, no trial,
 * no timer), as the menus hidden over it do (a match found), and a sign-in there comes back here.
 * The scene holds one frame under it (Screen.holdsScene).
 */
import { t } from '../../../i18n';
import type { Menu, Screen } from '../../Menu';
import { asSettingsTab, type SettingsTab } from './model';
import type { SettingsView } from './view';

export function settingsScreen(menu: Menu, view: SettingsView): Screen {
  /** Menu.open's tab for the next entry (none: CONTROLES). */
  let tab: SettingsTab | null = null;
  menu.host.accounts.subscribe(() => {
    if (!view.waitingSignIn || !menu.host.accounts.signedIn) return;
    view.waitingSignIn = false;
    if (menu.top()?.id === 'profile') menu.back();
  });
  return {
    id: 'settings',
    title: t('nav.settings'),
    el: view.el,
    tabsVerb: 'nav.sections',
    holdsScene: true,
    setTab: (id) => {
      const next = asSettingsTab(id);
      if (next !== null && view.isOpen) view.selectTab(next);
      else tab = next;
    },
    show: () => {
      if (!view.isOpen) view.open(tab);
      else view.resume();
      tab = null;
    },
    // After the Menu changed its stack (hide runs first): closed once it left the stack, held while
    // another screen or the match is over it.
    hide: () =>
      queueMicrotask(() => {
        if (!menu.stacked('settings')) view.close();
        else if (!menu.visible || menu.top()?.id !== 'settings') view.suspend();
      }),
    back: () => view.back(),
    command: (c) => view.command(c),
    keysTaken: () => view.capturing,
    // The rail beside the page: ◀ ▶ cross to it, ▲ ▼ never land on it from the page.
    zones: () => [{ name: 'set-rail', el: view.rail, side: true }],
  };
}

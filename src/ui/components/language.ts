/**
 * The language sheet (PERFIL's IDIOMA row until Settings › Game has it, PR 11): automatic (the
 * system's language) first, then every shipped language by its own name, the saved choice marked
 * and focused, as the region sheet lists its regions. A change reloads the page (src/i18n.ts
 * setLanguage), which the sheet says first; that would drop a search or a lobby, so then it only
 * explains why not. Built on call.
 */
import { h } from '../dom';
import { icon } from './icons';
import { LOCALES, savedLanguage, setLanguage, systemLanguage, t } from '../../i18n';
import type { LanguageCode } from '../../i18n';
import type { Menu } from '../Menu';

export function openLanguagePicker(menu: Menu): void {
  const busy = (): boolean => menu.host.searchView().active || menu.host.lobby.inLobby;
  if (busy()) {
    menu.toast(t('lang.busy'));
    return;
  }
  const saved = savedLanguage();
  let close = (): void => undefined;
  const choose = (code: LanguageCode | null): void => {
    if (code === saved) close();
    else if (busy()) {
      close();
      menu.toast(t('lang.busy'));
    } else setLanguage(code);
  };
  const option = (code: LanguageCode | null, label: string): HTMLButtonElement => {
    const on = code === saved;
    return h(
      `button.mn-btn.mn-sheet-option${on ? '.mn-sheet-option-on' : ''}` as 'button',
      { type: 'button', 'data-nav': true, 'data-autofocus': on, 'aria-current': on ? 'true' : undefined, lang: code ?? undefined, onclick: () => choose(code) },
      on ? icon('check') : null,
      label,
    );
  };
  const codes = Object.keys(LOCALES) as LanguageCode[];
  close = menu.modal({
    title: t('lang.title'),
    body: [h('p', null, t('lang.reloadNote')), h('div.mn-sheet-list', null, option(null, t('lang.auto', { language: LOCALES[systemLanguage()].name })), ...codes.map((c) => option(c, LOCALES[c].name)))],
    actions: [{ label: t('lang.cancel'), onClick: () => true }],
  });
}

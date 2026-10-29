/**
 * The stadium sheet (MODOS › CONTRA LA IA's Stadium row): every stadium theme by its name, the
 * saved one marked and focused, as the region sheet lists its regions. A pick closes it (the focus
 * back on its opener) and switches the theme behind the loading screen (MenuHost.setTheme:
 * Game.switchTheme, saved with the prefs); the current one only closes. The theme is the player's
 * render preference: every match and the menus' stage use it. Built on call.
 *
 * `stadiumOptions` and `chooseStadium` are the pure part (tests/stadium-picker.test.mjs), for PR 8's
 * GARAJE › ESTADIOS too.
 */
import { h } from '../dom';
import { icon } from './icons';
import { t } from '../../i18n';
import { THEME_IDS } from '../../render/theme';
import type { ThemeId } from '../../render/theme';
import { themeName } from '../names';
import type { Menu, MenuHost } from '../Menu';

/** Every stadium in THEME_IDS' order, `on` for the current one. */
export function stadiumOptions(current: ThemeId): { id: ThemeId; on: boolean }[] {
  return THEME_IDS.map((id) => ({ id, on: id === current }));
}

/** Switch to `id` unless it is the current one; true when it switched. */
export function chooseStadium(host: Pick<MenuHost, 'theme' | 'setTheme'>, id: ThemeId): boolean {
  if (id === host.theme) return false;
  host.setTheme(id);
  return true;
}

/** Open the sheet; `picked` runs after a pick that switched (the opener's row shows the new name). */
export function openStadiumPicker(menu: Menu, picked?: () => void): void {
  let close = (): void => undefined;
  const option = ({ id, on }: { id: ThemeId; on: boolean }): HTMLButtonElement =>
    h(
      `button.mn-btn.mn-sheet-option${on ? '.mn-sheet-option-on' : ''}` as 'button',
      {
        type: 'button',
        'data-nav': true,
        'data-key': 'stadium-' + id,
        'data-autofocus': on,
        'aria-current': on ? 'true' : undefined,
        onclick: () => {
          close();
          if (chooseStadium(menu.host, id)) picked?.();
        },
      },
      on ? icon('check') : null,
      themeName(id),
    );
  close = menu.modal({
    title: t('friendly.theme'),
    body: [h('p', null, t('friendly.themeNote')), h('div.mn-sheet-list', null, ...stadiumOptions(menu.host.theme).map(option))],
    actions: [{ label: t('lang.cancel'), onClick: () => true }],
  });
}

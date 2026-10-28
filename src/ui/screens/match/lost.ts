/**
 * A server match whose connection is gone for good (plan §6.13, PR 12: NetClient spent its
 * RECONNECT_TRIES): "Your connection dropped" · "The match goes on without you", with REJOIN (the
 * primary: POST /api/rejoin, MenuHost.rejoinMatch) and MENU; in Competitivo also "You can come back
 * from Competitive" (the lock stays: its next search rejoins too). A sheet over the menus, so the
 * focus, Back (= MENU) and every input work as in any sheet. Inicio's hero offers the same match
 * while it runs (homeModel.ts 'rejoin').
 */
import { h } from '../../dom';
import { t } from '../../../i18n';
import type { Menu } from '../../Menu';

export function openLostSheet(menu: Menu, ranked: boolean): void {
  menu.modal({
    title: t('lost.title'),
    body: [h('p', null, t('lost.body')), ranked ? h('p.mn-sheet-note', null, t('lost.ranked')) : null],
    actions: [
      {
        label: t('lost.rejoin'),
        primary: true,
        autofocus: true,
        onClick: () => {
          queueMicrotask(() => menu.host.rejoinMatch());
          return true;
        },
      },
      { label: t('lost.menu'), onClick: () => true },
    ],
  });
}

/**
 * GARAJE, the section's root (plan §1.4.2): a "coming soon" panel until the cars land (the plan's
 * PR 8 builds the garage on feat/cars: your car, server points, the car list and the stadiums).
 * Nothing to focus: a controller or a remote stays on the section's tab (Menu.restoreFocus).
 */
import { h } from '../dom';
import { t } from '../../i18n';
import { icon } from '../components/icons';
import type { Menu, Screen } from '../Menu';
import { screenHead } from './common';

export function garageScreen(_menu: Menu): Screen {
  const el = h(
    'div.mn-garage',
    null,
    screenHead(t('nav.garage')),
    h('div.mn-soon', null, h('span.mn-soon-icon', { 'aria-hidden': 'true' }, icon('garage')), h('span.mn-soon-slot', null, t('garage.soon')), h('p.mn-soon-text', null, t('garage.soonText'))),
  );
  return { id: 'garage', title: t('nav.garage'), el };
}

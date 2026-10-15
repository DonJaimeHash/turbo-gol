/**
 * Español (rioplatense). Shipped with the game, so it must stay complete: `Required<Translation>`
 * fails the build when a key of en.ts has no Spanish text.
 */
import type { Translation } from '../i18n';

export default {
  'lang.title': 'Idioma',
  'lang.auto': 'Automático ({language})',
  'lang.busy': 'Cancelá la búsqueda o salí de la sala para cambiar el idioma',
} satisfies Required<Translation>;

/**
 * English: the source of truth for every text in the game (src/i18n.ts). To translate, copy this
 * file to src/locales/<code>.ts and follow CONTRIBUTING.md ("Translating"). Keep each key and its
 * {placeholders}; plural texts list the forms of Intl.PluralRules ('one', 'other'...).
 */
import type { Messages } from '../i18n';

export default {
  // Language picker
  'lang.title': 'Language',
  'lang.auto': 'Automatic ({language})',
  'lang.busy': 'Stop searching or leave the lobby to change the language',
} satisfies Messages;

/**
 * The Tablero's five sections (plan §1.3 `mn-sections`, §1.5): JUGAR · ENTRENAMIENTO · GARAJE ·
 * CLASIFICACIÓN · PERFIL, in that order on every device (the top bar on a PC and a TV, the rail on
 * a phone held sideways, the tab bar on an upright one). Each section has a root screen; every
 * other screen is stacked on the root of the section it belongs to (SCREEN_SECTION: today all of
 * them are JUGAR's: MODOS, a lobby and its creation, stacked on Inicio). Pure, no DOM:
 * node tests import it (tests/back-model.test.mjs).
 */
import type { Key } from '../../i18n';
import type { IconName } from '../components/icons';

export type SectionId = 'play' | 'training' | 'garage' | 'leaderboard' | 'profile';

export interface SectionDef {
  readonly id: SectionId;
  /** The screen at the bottom of the section's stack (Menu.register id). */
  readonly root: string;
  readonly icon: IconName;
  /** Its name in the bar and the rail (capitals). */
  readonly label: Key;
  /** Its name in the upright phone's tab bar, where five share 390 px. */
  readonly short: Key;
}

export const SECTIONS: readonly SectionDef[] = [
  { id: 'play', root: 'home', icon: 'play', label: 'nav.play', short: 'nav.play' },
  { id: 'training', root: 'training', icon: 'training', label: 'nav.training', short: 'nav.trainingShort' },
  { id: 'garage', root: 'garage', icon: 'garage', label: 'nav.garage', short: 'nav.garage' },
  { id: 'leaderboard', root: 'leaderboard', icon: 'leaderboard', label: 'nav.leaderboard', short: 'nav.leaderboardShort' },
  { id: 'profile', root: 'profile', icon: 'profile', label: 'nav.profile', short: 'nav.profile' },
];

/** Where Back goes from any other section, and where the menus open. */
export const HOME_SECTION: SectionId = 'play';

export function sectionDef(id: SectionId): SectionDef {
  return SECTIONS.find((s) => s.id === id) ?? SECTIONS[0];
}

/** The section of a root screen, null for a stacked one. */
export function rootSection(screenId: string): SectionId | null {
  return SECTIONS.find((s) => s.root === screenId)?.id ?? null;
}

/** Screens of every section (Ajustes, from the top bar's gear or Start anywhere): stacked on the screen shown (backModel.ts stackAfterOpen). */
export const EVERY_SECTION: readonly string[] = ['settings'];

/** The section a screen belongs to: its own for a root, JUGAR for every stacked screen of today. */
export function sectionOf(screenId: string): SectionId {
  return rootSection(screenId) ?? HOME_SECTION;
}

/** The section `d` places from `id` (LB / RB, Q / E, the bar's ‹ ›): no wrap, null past either end. */
export function stepSection(id: SectionId, d: -1 | 1): SectionId | null {
  const i = SECTIONS.findIndex((s) => s.id === id);
  return SECTIONS[i + d]?.id ?? null;
}

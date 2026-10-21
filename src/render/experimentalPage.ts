/**
 * Settings > Experimental: the account-only switch (docs: the experimental design, section 10.1).
 * Guests see one locked line. A signed-in player sees a note, the switch and, while it is on, what
 * it unlocks, how Super low stands for them and their presets. The preset editor comes with
 * experimental free play; this page already lists the presets the account holds.
 *
 * Turning the switch off while the player's own graphics pick is Super low takes a second press
 * ("Press again: Performance graphics, restarts"): the Game then switches to Performance, which
 * reloads the page (quality.ts needsReload). Super low that a device runs on its own (a weak TV,
 * the URL, the safety net) is not the player's pick: the switch goes off without a reload.
 *
 * The page is built once with the rest of the settings screen (Hud.buildSettings) and only shows
 * or hides its lines afterwards (`refresh`), so nothing here runs per frame. `experimentalView` is
 * its pure part (tests/hud-menu.test.mjs).
 */
import { t, type Key } from '../i18n';

/** A focus stop of the settings screen (the Hud's FocusItem). */
export interface PageItem {
  el: HTMLElement;
  left?: () => void;
  right?: () => void;
  accept?: () => void;
  clear?: () => void;
}

/** How Super low stands for the player: their pick, run by the device on its own, or simply listed. */
export type SuperlowStatus = 'chosen' | 'auto' | 'listed';

/** What the page shows, from the Game (Game.settingsOptions). */
export interface ExperimentalPageState {
  /** A signed-in player (a guest gets the locked line only). */
  readonly available: boolean;
  /** The switch. */
  readonly enabled: boolean;
  /** Turning it off restarts the game: the player's own pick is Super low. */
  readonly offRestarts: boolean;
  readonly superlow: SuperlowStatus;
  /** The names of the player's own presets (the built-ins are not listed). */
  readonly presetNames: readonly string[];
  readonly maxPresets: number;
}

/** Settings > Experimental, in MenuOptions (the Game fills it; absent: the page shows the locked line). */
export interface ExperimentalOptions {
  state(): ExperimentalPageState;
  /** The switch was set (after the second press when turning it off restarts). */
  setEnabled(on: boolean): void;
  /** The page came on screen: a good moment to pull the account's state (experimentalStore.ts sync). */
  onOpen?(): void;
}

/** Which lines are shown. Pure. */
export interface ExperimentalView {
  /** The guest's line (and nothing else). */
  readonly locked: boolean;
  /** The note and the switch. */
  readonly switchRow: boolean;
  /** "Press again: Performance graphics, restarts". */
  readonly confirm: boolean;
  /** What it unlocks, Super low's line and the presets' line (the switch is on). */
  readonly details: boolean;
  readonly superlowKey: Key;
}

const SUPERLOW_KEYS: Readonly<Record<SuperlowStatus, Key>> = {
  chosen: 'settings.experimentalSuperlowChosen',
  auto: 'settings.qualityAuto',
  listed: 'settings.experimentalSuperlowListed',
};

/** The lines for `s`, with the off press waiting for its second press (`armed`). Pure. */
export function experimentalView(s: ExperimentalPageState | null, armed: boolean): ExperimentalView {
  if (s === null || !s.available) return { locked: true, switchRow: false, confirm: false, details: false, superlowKey: SUPERLOW_KEYS.listed };
  return { locked: false, switchRow: true, confirm: s.enabled && armed && s.offRestarts, details: s.enabled, superlowKey: SUPERLOW_KEYS[s.superlow] };
}

/** The presets' line: "Your presets (2/10): A, B" or the empty one. */
export function presetsLine(s: ExperimentalPageState): string {
  if (s.presetNames.length === 0) return t('settings.experimentalNoPresets', { max: s.maxPresets });
  return t('settings.experimentalPresets', { count: s.presetNames.length, max: s.maxPresets, names: s.presetNames.join(', ') });
}

/** What the page takes from the Hud: its elements and its toggle row. */
export interface PageKit {
  line(className: string, text?: string): HTMLElement;
  toggleRow(label: string, get: () => boolean, set: (v: boolean) => void): { row: HTMLElement; item: PageItem; refresh: () => void };
}

export interface ExperimentalPage {
  readonly page: HTMLElement;
  /** The focus stops shown now (none for a guest: the tab strip only). */
  items(): PageItem[];
  /** Show the lines for the current options (an account change, the switch, a sync). */
  refresh(): void;
  /** Forget a pending second press (the tab or the screen was left). */
  disarm(): void;
}

export function buildExperimentalPage(kit: PageKit, options: () => ExperimentalOptions | null): ExperimentalPage {
  const page = kit.line('hud-settings-page hud-exp-page');
  const locked = kit.line('hud-settings-device hud-exp-locked', t('settings.experimentalLocked'));
  const note = kit.line('hud-settings-device', t('settings.experimentalNote'));
  let armed = false;
  const state = (): ExperimentalPageState | null => options()?.state() ?? null;
  const toggle = kit.toggleRow(
    t('settings.experimentalSwitch'),
    () => state()?.enabled === true,
    (on) => {
      const o = options();
      const s = o?.state() ?? null;
      if (o === null || s === null || !s.available) return;
      if (!on && s.offRestarts && !armed) {
        armed = true; // the first press only asks
      } else {
        armed = false;
        o.setEnabled(on);
      }
      refresh();
    },
  );
  const confirm = kit.line('hud-settings-hint hud-exp-confirm', t('settings.experimentalOffRestart'));
  const unlocks = kit.line('hud-settings-hint', t('settings.experimentalUnlocks'));
  const superlow = kit.line('hud-settings-hint');
  const presets = kit.line('hud-settings-hint');
  page.append(locked, note, toggle.row, confirm, unlocks, superlow, presets);

  const refresh = (): void => {
    const s = state();
    const v = experimentalView(s, armed);
    if (!v.confirm) armed = false;
    locked.hidden = !v.locked;
    note.hidden = !v.switchRow;
    toggle.row.hidden = !v.switchRow;
    confirm.hidden = !v.confirm;
    unlocks.hidden = !v.details;
    superlow.hidden = !v.details;
    presets.hidden = !v.details;
    if (s !== null && v.details) {
      superlow.textContent = t(v.superlowKey);
      presets.textContent = presetsLine(s);
    }
    toggle.refresh();
  };
  refresh();
  return {
    page,
    items: () => (experimentalView(state(), armed).switchRow ? [toggle.item] : []),
    refresh,
    disarm: () => {
      armed = false;
      refresh();
    },
  };
}

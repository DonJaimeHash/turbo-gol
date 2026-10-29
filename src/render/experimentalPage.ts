/**
 * Settings > Experimental (docs: the experimental design, section 10.1): the account-only switch
 * and the physics preset editor. Guests see one locked line. A signed-in player sees a note, the
 * switch and, while it is on, what it unlocks and the editor:
 *
 *   Rules    ‹ Low gravity ›          the presets: the built-ins (read-only) first, then the
 *                                      player's own; the pick is the store's lastUsed
 *   New · Duplicate · Rename · Delete   (Delete takes a second press; built-ins can only be
 *                                      duplicated)
 *   Name     [ My rules 1 ]            the player's own presets only (pad A / a tap opens the
 *                                      keyboard; Enter, Esc or leaving the field saves it)
 *   Changes: Gravity 50% · ...         the one-line summary of what differs from standard
 *   WORLD / BALL / CAR / CONTACT       one row per value: a stepper (− value +) for a range, a
 *                                      cycler (‹ value ›) for a choice or a toggle, each on its
 *                                      grid, its standard value shown; built-in rows are inert
 *   [Reset to standard]                the footer (own presets; a second press)
 *
 * Every edit is saved at once (experimentalStore.ts: local first, the account debounced), so BACK
 * never loses anything. Contexts (ExperimentalOptions.context): 'menu' edits; 'training'
 * (experimental free play's pause menu) edits too, and the preset picked is free play's rules once
 * the screen closes (the Game rebuilds the arena then, never per edit); 'match' (an experimental
 * P2P match) shows the room's rules as one read-only line.
 *
 * Super low is not here: it is everyone's, Settings > Graphics' switch (it changes only how the
 * stadium is drawn), so the switch never restarts the game.
 *
 * The page is built once with the rest of Ajustes (src/ui/screens/settings/view.ts) and only shows,
 * hides and rewrites its lines afterwards (`refresh`), so nothing here runs per frame. It makes its
 * elements through a PageKit only (Ajustes': settings/expKit.ts), so node tests drive it with a fake kit;
 * `experimentalView` is its pure part (tests/hud-menu.test.mjs).
 */
import { t, type Key } from '../i18n';
import { LOBBY_NAME_MAX, sanitizeLobbyName } from '../net/account';
import {
  MAX_PRESETS,
  PHYSICS_FIELDS,
  PHYSICS_GROUPS,
  copyPresetName,
  defaultPresetName,
  fieldValues,
  snapToGrid,
  valueOf,
  type PhysicsField,
  type PhysicsGroup,
  type PhysicsValues,
} from '../game/physicsRules';
import type { ExperimentalStore, ListedPreset } from '../game/experimentalStore';
import { fieldLabel, formatRuleValue, presetName, rulesSummary, standardText } from './rulesText';

/** A focus stop of the page (Ajustes makes it a FocusNav target: settings/expKit.ts). */
export interface PageItem {
  el: HTMLElement;
  left?: () => void;
  right?: () => void;
  accept?: () => void;
  clear?: () => void;
  /** left / right follow a held arrow's auto-repeat (a range's stepper; nav.ts onNavRepeat). */
  repeat?: boolean;
}

/** What the page shows, from the Game (Game.settingsOptions). */
export interface ExperimentalPageState {
  /** A signed-in player (a guest gets the locked line only). */
  readonly available: boolean;
  /** The switch. */
  readonly enabled: boolean;
}

/** Where the settings screen was opened (ExperimentalOptions.context). */
export type ExperimentalContext = 'menu' | 'training' | 'match';

/** The player's presets as the editor works on them: the Game's ExperimentalStore. */
export type PresetSource = Pick<ExperimentalStore, 'list' | 'presets' | 'lastUsed' | 'setLastUsed' | 'create' | 'duplicate' | 'rename' | 'update' | 'remove'>;

/** Settings > Experimental, in MenuOptions (the Game fills it; absent: the page shows the locked line). */
export interface ExperimentalOptions {
  state(): ExperimentalPageState;
  /** The switch was set. */
  setEnabled(on: boolean): void;
  /** The page came on screen: a good moment to pull the account's state (experimentalStore.ts sync). */
  onOpen?(): void;
  /** The signed-in player's presets: the editor (absent: no editor). */
  presets?: PresetSource;
  /**
   * 'menu' (default): the editor. 'training' (experimental free play): the editor, and the preset
   * picked is free play's rules from when the screen closes (a line says so). 'match' (an
   * experimental P2P match): `matchRules` only, read-only.
   */
  context?: ExperimentalContext;
  /** 'match': the room's rules as one line (custom.rulesInfo with rulesText.lobbyRulesLine). */
  matchRules?: string;
}

/** Which lines are shown. Pure. */
export interface ExperimentalView {
  /** The guest's line (and nothing else). */
  readonly locked: boolean;
  /** The note and the switch. */
  readonly switchRow: boolean;
  /** What it unlocks (the switch is on). */
  readonly details: boolean;
  /** The preset editor (the switch is on, the player has presets, not in a match). */
  readonly editor: boolean;
  /** The room's rules, read-only ('match'). */
  readonly match: boolean;
}

const GROUP_KEYS: Readonly<Record<PhysicsGroup, Key>> = {
  world: 'rules.groupWorld',
  ball: 'rules.groupBall',
  car: 'rules.groupCar',
  contact: 'rules.groupContact',
};

/**
 * The lines for `s`, `editor` when the options carry the presets, in `context`. Pure. A match's rules show whatever the switch says (a
 * member's switch is never checked: the room decided); the editor needs the switch.
 */
export function experimentalView(s: ExperimentalPageState | null, editor = false, context: ExperimentalContext = 'menu'): ExperimentalView {
  if (s === null || !s.available) return { locked: true, switchRow: false, details: false, editor: false, match: false };
  return {
    locked: false,
    switchRow: true,
    details: s.enabled,
    editor: s.enabled && editor && context !== 'match',
    match: context === 'match',
  };
}

/**
 * The preset `dir` steps from `id` reach in `list` (wrapping both ways; an id not listed counts as
 * the first). Pure.
 */
export function stepPreset(list: readonly { id: string }[], id: string, dir: number): string | null {
  if (list.length === 0) return null;
  const i = Math.max(0, list.findIndex((p) => p.id === id));
  const n = list.length;
  return list[(((i + dir) % n) + n) % n].id;
}

/**
 * The value `dir` steps from `v` reach on the field's grid: left / right (-1 / +1) stop at the ends,
 * 0 (accept) wraps; a value off the grid snaps first. Pure.
 */
export function stepRuleValue(f: PhysicsField, v: number, dir: -1 | 0 | 1): number {
  const grid = fieldValues(f);
  const i = grid.indexOf(grid.includes(v) ? v : snapToGrid(f, v));
  if (dir === 0) return grid[(i + 1) % grid.length];
  return grid[Math.min(grid.length - 1, Math.max(0, i + dir))];
}

/** What the page takes from its host (Ajustes: settings/expKit.ts): its elements, its toggle row and its focus. */
export interface PageKit {
  /** A block element (a div) with `className` and `text`. */
  line(className: string, text?: string): HTMLElement;
  /** A button (never takes the DOM focus); `onClick` on a click, a tap or `.click()`. */
  button(className: string, text: string, onClick: () => void): HTMLButtonElement;
  /** A one-line text field; `onCommit(value)` when it is left changed (Enter, Esc, a tap elsewhere). */
  textInput(className: string, maxLength: number, onCommit: (value: string) => void): HTMLInputElement;
  toggleRow(label: string, get: () => boolean, set: (v: boolean) => void): { row: HTMLElement; item: PageItem; refresh: () => void };
  /** `el` is the focus stop of `item` (a pointer on it focuses it). */
  bindFocus(el: HTMLElement, item: PageItem): void;
  /** Start typing in `input` (RENAME, OK on the name): the host's way (a TV's keypad at once); without one, focused with its text selected. */
  editText?(input: HTMLInputElement): void;
  /** The page's focus stops changed (a row shown or hidden): the host puts the focus back on the screen. */
  relayout?(): void;
}

export interface ExperimentalPage {
  readonly page: HTMLElement;
  /** The page's footer buttons (Reset to standard), shown with the tab. */
  readonly actions: HTMLElement;
  /** The focus stops shown now (none for a guest: the tab strip only). */
  items(): PageItem[];
  /** Show the lines for the current options (an account change, the switch, a sync). */
  refresh(): void;
  /** Forget a pending second press and the last message (the tab or the screen was left). */
  disarm(): void;
}

/** A row of buttons as one focus stop: left / right pick (disabled and hidden ones skipped), accept clicks. */
function buttonGroup(container: HTMLElement, buttons: HTMLButtonElement[], kit: PageKit): { item: PageItem; refresh: () => void; pick: (b: HTMLButtonElement) => void } {
  let index = 0;
  const usable = (i: number): boolean => !buttons[i].disabled && !buttons[i].hidden;
  const highlight = (): void => {
    for (let i = 0; i < buttons.length; i++) buttons[i].classList.toggle('hud-focus', i === index);
  };
  const move = (dir: number): void => {
    const n = buttons.length;
    for (let k = 1; k <= n; k++) {
      const j = (((index + dir * k) % n) + n) % n;
      if (usable(j)) {
        index = j;
        break;
      }
    }
    highlight();
  };
  const refresh = (): void => {
    if (!usable(index)) move(1);
    else highlight();
  };
  const item: PageItem = {
    el: container,
    left: () => move(-1),
    right: () => move(1),
    accept: () => {
      if (usable(index)) buttons[index].click();
    },
  };
  kit.bindFocus(container, item);
  highlight();
  return {
    item,
    refresh,
    pick: (b) => {
      const i = buttons.indexOf(b);
      if (i >= 0) index = i;
      highlight();
    },
  };
}

interface ValueRow {
  readonly field: PhysicsField;
  readonly row: HTMLElement;
  readonly item: PageItem;
  refresh(p: ListedPreset | null, editable: boolean): void;
}

/**
 * One value's row: "Label (Standard X)   − value +" for a range (a stepper), "‹ value ›" for a choice
 * or a toggle (a cycler, accept wraps). Delete (item.clear) puts the standard value back. Inert
 * while `editable` is false (a built-in).
 */
function valueRow(kit: PageKit, f: PhysicsField, set: (v: number) => void, current: () => { value: number; editable: boolean }): ValueRow {
  const stepper = f.kind === 'range';
  const row = kit.line(`hud-settings-row hud-rule-row${stepper ? ' hud-rule-stepper' : ' hud-rule-cycler'}`);
  const head = kit.line('hud-rule-head');
  head.append(kit.line('hud-settings-label', fieldLabel(f)));
  const std = kit.line('hud-rule-std', f.scope === 'training' ? `${standardText(f)} · ${t('rules.trainingOnly')}` : standardText(f));
  head.append(std);
  const step = (dir: -1 | 0 | 1): void => {
    const c = current();
    if (!c.editable) return;
    const v = stepRuleValue(f, c.value, dir);
    if (v !== c.value) set(v);
  };
  const ctl = kit.line('hud-settings-ctl hud-rule-ctl');
  const minus = kit.button('hud-rule-btn', stepper ? '−' : '‹', () => step(-1));
  const value = kit.line('hud-rule-value');
  const plus = kit.button('hud-rule-btn', stepper ? '+' : '›', () => step(1));
  ctl.append(minus, value, plus);
  row.append(head, ctl);
  const item: PageItem = {
    el: row,
    left: () => step(-1),
    right: () => step(1),
    accept: stepper ? undefined : () => step(0),
    repeat: stepper,
    clear: () => {
      const c = current();
      if (c.editable && c.value !== f.default) set(f.default);
    },
  };
  kit.bindFocus(row, item);
  const grid = fieldValues(f);
  return {
    field: f,
    row,
    item,
    refresh: (p, editable) => {
      const v = p === null ? f.default : valueOf(p.values, f.key);
      value.textContent = formatRuleValue(f, v);
      row.classList.toggle('hud-rule-changed', v !== f.default);
      row.classList.toggle('hud-rule-locked', !editable);
      minus.disabled = !editable || (stepper && v <= grid[0]);
      plus.disabled = !editable || (stepper && v >= grid[grid.length - 1]);
    },
  };
}

export function buildExperimentalPage(kit: PageKit, options: () => ExperimentalOptions | null): ExperimentalPage {
  const page = kit.line('hud-settings-page hud-exp-page');
  const actions = kit.line('hud-settings-actions hud-exp-actions');
  const locked = kit.line('hud-settings-device hud-exp-locked', t('settings.experimentalLocked'));
  const note = kit.line('hud-settings-device', t('settings.experimentalNote'));
  const opts = (): ExperimentalOptions | null => options();
  const state = (): ExperimentalPageState | null => opts()?.state() ?? null;
  const source = (): PresetSource | null => opts()?.presets ?? null;
  const toggle = kit.toggleRow(
    t('settings.experimentalSwitch'),
    () => state()?.enabled === true,
    (on) => {
      const o = opts();
      const s = o?.state() ?? null;
      if (o === null || s === null || !s.available) return;
      o.setEnabled(on);
      update();
    },
  );
  const unlocks = kit.line('hud-settings-hint', t('settings.experimentalUnlocks'));
  const matchLine = kit.line('hud-settings-device hud-exp-match');

  // ---- the editor ----------------------------------------------------------------------------

  /** The preset on screen (refreshed with every refresh: one read of the store per refresh). */
  let cur: ListedPreset | null = null;
  /** A press waiting for its second one: Delete of that preset, Reset of that preset. */
  let deleteArmed: string | null = null;
  let resetArmed: string | null = null;
  let deleting = false;
  /** Picks since the page was built (a delete that ends moves to its neighbour only if none came between). */
  let picks = 0;
  /** The last action's line (a full account, a refused name, an offline delete), until the next action. */
  let message: string | null = null;

  const currentPreset = (): ListedPreset | null => {
    const src = source();
    if (src === null) return null;
    const list = src.list();
    const id = src.lastUsed();
    return list.find((p) => p.id === id) ?? list[0] ?? null;
  };
  const own = (p: ListedPreset | null): p is ListedPreset => p !== null && !p.builtIn;
  const ownNames = (src: PresetSource): string[] => src.presets().map((p) => p.name);

  const pickPreset = (id: string): void => {
    const src = source();
    if (src === null) return;
    picks++;
    deleteArmed = null;
    resetArmed = null;
    message = null;
    src.setLastUsed(id);
    update();
  };
  const stepPick = (dir: number): void => {
    const src = source();
    if (src === null) return;
    const id = stepPreset(src.list(), currentPreset()?.id ?? 'standard', dir);
    if (id !== null) pickPreset(id);
  };
  const editorTitle = kit.line('hud-settings-group hud-exp-title', t('rules.groupPresets'));
  const picker = kit.line('hud-settings-row hud-rule-row hud-rule-cycler hud-exp-picker');
  const pickerValue = kit.line('hud-rule-value hud-exp-picker-value');
  {
    const ctl = kit.line('hud-settings-ctl hud-rule-ctl');
    ctl.append(kit.button('hud-rule-btn', '‹', () => stepPick(-1)), pickerValue, kit.button('hud-rule-btn', '›', () => stepPick(1)));
    picker.append(kit.line('hud-settings-label', t('rules.preset')), ctl);
  }
  const pickerItem: PageItem = { el: picker, left: () => stepPick(-1), right: () => stepPick(1), accept: () => stepPick(1) };
  kit.bindFocus(picker, pickerItem);
  const pickerHint = kit.line('hud-settings-hint hud-exp-picker-hint');

  // New · Duplicate · Rename · Delete
  const buttonsBox = kit.line('hud-settings-actions hud-exp-buttons');
  const created = (r: ReturnType<PresetSource['duplicate']>): void => {
    if (typeof r === 'object') pickPreset(r.id);
    else {
      message = r === 'full' ? t('rules.full', { max: MAX_PRESETS }) : r === 'bad_name' ? t('rules.badName') : null;
      update();
    }
  };
  const onNew = (): void => {
    const src = source();
    if (src === null) return;
    group.pick(newBtn);
    created(src.create(defaultPresetName(ownNames(src), (n) => t('rules.defaultName', { n }))));
  };
  const onDuplicate = (): void => {
    const src = source();
    const p = currentPreset();
    if (src === null || p === null) return;
    group.pick(dupBtn);
    const name = copyPresetName(presetName(p), ownNames(src), (base, n) => t('rules.copyName', { name: base, n }));
    created(src.duplicate(p.id, name));
  };
  const onRename = (): void => {
    if (!own(currentPreset())) return;
    group.pick(renameBtn);
    editName();
  };
  const onDelete = (): void => {
    const src = source();
    const p = currentPreset();
    if (src === null || !own(p) || deleting) return;
    group.pick(delBtn);
    resetArmed = null;
    message = null;
    if (deleteArmed !== p.id) {
      deleteArmed = p.id; // the first press only asks
      update();
      return;
    }
    deleteArmed = null;
    deleting = true;
    const list = src.list();
    const i = list.findIndex((q) => q.id === p.id);
    const neighbour = (list[i - 1] ?? list[i + 1] ?? list[0]).id;
    const picksAt = picks;
    update();
    void src.remove(p.id).then(
      (ok) => {
        deleting = false;
        if (ok && picks === picksAt) pickPreset(neighbour);
        else {
          if (!ok) message = t('rules.deleteOffline');
          update();
        }
      },
      () => {
        deleting = false;
        message = t('rules.deleteOffline');
        update();
      },
    );
  };
  const newBtn = kit.button('hud-settings-action', t('rules.new'), onNew);
  const dupBtn = kit.button('hud-settings-action', t('rules.duplicate'), onDuplicate);
  const renameBtn = kit.button('hud-settings-action', t('rules.rename'), onRename);
  const delBtn = kit.button('hud-settings-action hud-exp-delete', t('rules.delete'), onDelete);
  buttonsBox.append(newBtn, dupBtn, renameBtn, delBtn);
  const group = buttonGroup(buttonsBox, [newBtn, dupBtn, renameBtn, delBtn], kit);

  // The name of the player's own preset.
  const nameRow = kit.line('hud-settings-row hud-exp-name-row');
  const nameInput = kit.textInput('hud-menu-name hud-exp-name', LOBBY_NAME_MAX, (value) => {
    const src = source();
    const p = currentPreset();
    if (src === null || !own(p)) return;
    const n = sanitizeLobbyName(value);
    message = null;
    if (n === null) message = t('rules.badName');
    else if (n !== p.name) src.rename(p.id, n);
    nameInput.value = currentPreset()?.name ?? '';
    update();
  });
  nameRow.append(kit.line('hud-settings-label', t('rules.name')), nameInput);
  function editName(): void {
    if (kit.editText) kit.editText(nameInput);
    else {
      nameInput.focus();
      nameInput.select();
    }
  }
  const nameItem: PageItem = { el: nameRow, accept: editName };
  kit.bindFocus(nameRow, nameItem);

  const status = kit.line('hud-settings-hint hud-exp-status');
  const summary = kit.line('hud-settings-hint hud-exp-summary');
  const trainingHint = kit.line('hud-settings-hint hud-exp-live', t('rules.appliesOnClose'));

  const setValue = (key: PhysicsField['key'], v: number): void => {
    const src = source();
    const p = currentPreset();
    if (src === null || !own(p)) return;
    resetArmed = null;
    deleteArmed = null;
    message = null;
    const next: PhysicsValues = { ...p.values, [key]: v };
    src.update(p.id, next);
    update();
  };
  const groups: HTMLElement[] = [];
  const rows: ValueRow[] = [];
  const editorBlock = kit.line('hud-exp-editor');
  editorBlock.append(editorTitle, picker, pickerHint, buttonsBox, nameRow, status, summary, trainingHint);
  for (const g of PHYSICS_GROUPS) {
    const title = kit.line('hud-settings-group', t(GROUP_KEYS[g]));
    groups.push(title);
    editorBlock.append(title);
    for (const f of PHYSICS_FIELDS) {
      if (f.group !== g) continue;
      const r = valueRow(
        kit,
        f,
        (v) => setValue(f.key, v),
        () => {
          const p = currentPreset();
          return { value: p === null ? f.default : valueOf(p.values, f.key), editable: own(p) };
        },
      );
      rows.push(r);
      editorBlock.append(r.row);
    }
  }

  // Reset to standard (the footer).
  const onReset = (): void => {
    const src = source();
    const p = currentPreset();
    if (src === null || !own(p)) return;
    deleteArmed = null;
    message = null;
    if (resetArmed !== p.id) {
      resetArmed = p.id;
      update();
      return;
    }
    resetArmed = null;
    src.update(p.id, {});
    update();
  };
  const resetBtn = kit.button('hud-settings-action', t('rules.reset'), onReset);
  actions.append(resetBtn);
  const reset = buttonGroup(actions, [resetBtn], kit);

  page.append(locked, note, toggle.row, unlocks, matchLine, editorBlock);

  const view = (): ExperimentalView => {
    const o = opts();
    return experimentalView(o?.state() ?? null, o?.presets !== undefined, o?.context ?? 'menu');
  };

  const refresh = (): void => {
    const o = opts();
    const v = view();
    locked.hidden = !v.locked;
    note.hidden = !v.switchRow;
    toggle.row.hidden = !v.switchRow;
    unlocks.hidden = !v.details;
    matchLine.hidden = !v.match;
    if (v.match) matchLine.textContent = o?.matchRules ?? '';
    toggle.refresh();

    editorBlock.hidden = !v.editor;
    cur = v.editor ? currentPreset() : null;
    const mine = own(cur);
    if (cur === null || !mine) {
      deleteArmed = null;
      resetArmed = null;
    }
    // Ajustes shows this tab's actions with the tab (selectTab): the button itself hides, so a guest,
    // a switch that is off or a built-in never shows Reset, whenever the tab is selected.
    resetBtn.hidden = !v.editor || !mine;
    actions.hidden = resetBtn.hidden; // its one button gone: no empty (0×0) focus stop left in the page head
    if (!v.editor) return;
    const src = source() as PresetSource;
    pickerValue.textContent = cur === null ? '' : presetName(cur);
    pickerHint.textContent = mine ? t('rules.yours', { count: src.presets().length, max: MAX_PRESETS }) : t('rules.builtIn');
    renameBtn.disabled = !mine;
    delBtn.disabled = !mine || deleting;
    delBtn.textContent = mine && deleteArmed === cur?.id ? t('rules.deleteConfirm') : t('rules.delete');
    delBtn.classList.toggle('hud-exp-armed', mine && deleteArmed === cur?.id);
    group.refresh();
    nameRow.hidden = !mine;
    // Never under the player's fingers: a sync answer must not rewrite a name being typed.
    if (mine && !nameInput.matches?.(':focus')) nameInput.value = cur?.name ?? '';
    status.hidden = message === null;
    status.textContent = message ?? '';
    summary.textContent = cur === null ? '' : t('rules.changes', { summary: rulesSummary(cur.values, 5) });
    trainingHint.hidden = o?.context !== 'training';
    for (const r of rows) r.refresh(cur, mine);
    resetBtn.textContent = mine && resetArmed === cur?.id ? t('rules.resetConfirm') : t('rules.reset');
    resetBtn.classList.toggle('hud-exp-armed', mine && resetArmed === cur?.id);
    reset.refresh();
  };
  /** After an action: redraw, and let the host know the focus stops changed (rows may have come or gone). */
  const update = (): void => {
    refresh();
    kit.relayout?.();
  };
  refresh();

  return {
    page,
    actions,
    items: () => {
      const v = view();
      if (!v.switchRow) return [];
      const out: PageItem[] = [toggle.item];
      if (!v.editor) return out;
      const mine = own(cur);
      out.push(pickerItem, group.item);
      if (mine) out.push(nameItem);
      for (const r of rows) out.push(r.item);
      if (mine) out.push(reset.item);
      return out;
    },
    refresh,
    disarm: () => {
      deleteArmed = null;
      resetArmed = null;
      message = null;
      refresh();
    },
  };
}

/**
 * ENTRENAMIENTO (plan PR 13, dir-hub §6.5): the section's root, on Inicio's tile grid (home.css
 * `.mn-tiles`, the same areas: hero at the left on a PC and a TV, at the right on a phone held
 * sideways, on top upright; training.css names the tiles' cells).
 *
 * - The hero PRÁCTICA LIBRE (components/tile.ts heroTile, lime, its slot "YOU, THE BALL AND UNLIMITED
 *   BOOST"): free play at once.
 * - TIROS (slot START HERE), ATAJADAS, AÉREOS: each shows its three levels as marks by shape
 *   (trainingModel.ts: filled ✓ every shot in one run, a dot played, hollow never), from this
 *   browser's records for a guest, the account's when signed in (the local copy at once, redrawn
 *   after the server sync). A press opens the pack sheet: Beginner, Intermediate, Expert as big
 *   buttons with the best run and "N shots · 10 s per shot", the focus on the first not passed.
 * - HOW TO PLAY: the full controls card for the device in use (keyboard and mouse, controller, or
 *   the touch controls), from the live bindings.
 * - A signed-in player with Settings > Experimental's switch on gets LAB in its cell instead (the
 *   sheet of their presets: a press plays experimental free play with that one, the store's lastUsed;
 *   EDIT PRESETS opens the settings on its Experimental tab), and HOW TO PLAY moves to a row under
 *   the tiles. Guests and players with the switch off never see it; packs always run standard
 *   physics, and experimental free play records nothing (today's rules).
 * The subtitle names the live reset keys of the device in use (trainDevice: a TV remote's player
 * holds a controller), written again when the input changes (the Menu's tick).
 */
import { h, setChildren } from '../dom';
import { CATEGORY_LABELS, DIFFICULTY_LABELS, FREEPLAY_ID, FREEPLAY_NAME, TRAINING_CATEGORIES, TRAINING_PACKS } from '../../game/trainingPacks';
import type { TrainingCategory } from '../../game/trainingPacks';
import { language, t } from '../../i18n';
import type { Key } from '../../i18n';
import { presetName, rulesSummary } from '../../render/rulesText';
import type { Menu, Screen } from '../Menu';
import type { ActionId } from '../../input/bindings';
import type { InputKind } from '../device';
import { icon } from '../components/icons';
import type { IconName } from '../components/icons';
import { heroTile, modeTile, slot } from '../components/tile';
import { picker } from '../components/picker';
import { screenHead } from './common';
import { categoryMarks, firstOpen, trainDevice } from './trainingModel';
import type { MarkState, PackMark, TrainDevice } from './trainingModel';

const CATEGORY_TEXT: Readonly<Record<TrainingCategory, Key>> = { shooting: 'training.shootingText', saving: 'training.savingText', aerial: 'training.aerialText' };
const CATEGORY_ICON: Readonly<Record<TrainingCategory, IconName>> = { shooting: 'ball', saving: 'stadium', aerial: 'boost' };
const DEVICE_ICON: Readonly<Record<TrainDevice, IconName>> = { kbm: 'keyboard', pad: 'pad', touch: 'touch' };
const DEVICE_NAME: Readonly<Record<TrainDevice, Key>> = { kbm: 'training.howKbm', pad: 'training.howPad', touch: 'training.howTouch' };
const MARK_TEXT: Readonly<Record<MarkState, Key>> = { done: 'training.markDone', tried: 'training.markTried', none: 'training.markNone' };

/** The controls card's rows on a keyboard or a controller: its label and the actions whose keys it shows. */
const KEY_ROWS: ReadonlyArray<readonly [Key, readonly ActionId[]]> = [
  ['controls.drive', ['throttle', 'reverse']],
  ['controls.steer', ['steerLeft', 'steerRight']],
  ['controls.jump', ['jump']],
  ['controls.boost', ['boost']],
  ['action.powerslide', ['powerslide']],
  ['action.airRoll', ['airRoll']],
  ['controls.ballCam', ['ballCam']],
  ['training.howResetShot', ['trainingReset']],
  ['training.howResetCar', ['trainingResetCar']],
  ['action.pause', ['pause']],
];

/** The touch controls (src/input/TouchControls.ts), as they read on screen. */
const TOUCH_ROWS: ReadonlyArray<readonly [Key, Key]> = [
  ['training.howStick', 'training.howStickWhere'],
  ['touch.jump', 'controls.jump'],
  ['touch.boost', 'training.howBoostSlide'],
  ['touch.drift', 'action.powerslide'],
  ['touch.cam', 'controls.ballCam'],
  ['training.howResetTouch', 'training.howResetShot'],
];

/** The last input (device.ts `data-input` on <html>). */
function lastInput(): InputKind {
  const v = document.documentElement.dataset.input;
  return v === 'pad' || v === 'remote' || v === 'keyboard' || v === 'touch' ? v : 'mouse';
}

/** One level's mark: its shape says it (✓ filled, a dot, hollow), the text for a screen reader. */
function mark(state: MarkState): HTMLElement {
  return h(`span.mn-trn-mark.mn-trn-mark-${state}` as 'span', { 'aria-hidden': 'true' }, state === 'done' ? icon('check') : null);
}

export function trainingScreen(menu: Menu): Screen {
  const host = menu.host;
  const html = document.documentElement;
  // Fixed for the page, as Inicio's (device.ts sets tg-tv and the Game tg-superlow before the menus show).
  const tv = html.classList.contains('tg-tv');
  const upper = (s: string): string => s.toLocaleUpperCase(language());
  const exp = (): Menu['host']['experimental'] => host.experimental;
  const keys = (action: ActionId, d: 'kbm' | 'pad'): string => host.keyLabel(action, d);

  /** The subtitle: the reset keys of the device in use (a finger: the ↺ button). */
  const subtitleText = (d: TrainDevice): string => (d === 'touch' ? t('training.subTouch') : t('training.subKeys', { reset: keys('trainingReset', d), car: keys('trainingResetCar', d) }));

  // ---- the hero and the tiles ----
  const hero = heroTile({ lines: !html.classList.contains('tg-superlow'), oneLine: tv, press: () => host.startTraining(FREEPLAY_ID), cancel: () => undefined });
  const heroTitle = upper(FREEPLAY_NAME);
  hero.set({ kind: 'play', icon: 'training', slot: { text: upper(t('training.freePlayText')) }, title: heroTitle, clock: null, sub: t('training.freePlaySub'), needPad: false, label: `${heroTitle}. ${t('training.freePlayText')}` });
  const packs = new Map<TrainingCategory, { el: HTMLButtonElement; marks: HTMLElement }>();
  for (const cat of TRAINING_CATEGORIES) {
    const text = t(CATEGORY_TEXT[cat]);
    const tile = modeTile({
      cls: `mn-trn-${cat}`,
      key: 'cat-' + cat,
      icon: CATEGORY_ICON[cat],
      slot: cat === 'shooting' ? slot(t('training.startHere'), { drop: true }) : null,
      title: upper(CATEGORY_LABELS[cat]),
      sub: text,
      short: text,
      open: () => openPack(cat),
    });
    const marks = h('span.mn-trn-marks');
    tile.el.querySelector('.mn-mtile-text')?.appendChild(marks);
    packs.set(cat, { el: tile.el, marks });
  }
  const how = modeTile({ cls: 'mn-trn-how', key: 'how', icon: 'info', slot: null, title: upper(t('training.howTo')), sub: t('training.howToSub'), short: t('training.howToSub'), open: () => openHow() });
  const lab = modeTile({ cls: 'mn-trn-lab', key: 'lab', icon: 'lab', slot: null, title: t('training.tagLab'), sub: t('training.expFreePlayText'), short: t('training.expFreePlayShort'), open: () => openLab() });
  const howRow = picker('how-row', 'info', t('training.howTo'), () => openHow());
  const tiles = h('div.mn-tiles.mn-trn-tiles', null, hero.el, ...[...packs.values()].map((p) => p.el), how.el);
  const extra = h('div.mn-trn-extra', { hidden: true }, howRow.el);
  const head = screenHead(t('training.title'), subtitleText('kbm'));
  const sub = head.querySelector<HTMLElement>('.mn-subtitle');
  const el = h('section.mn-train', { 'data-tablero': true }, head, tiles, extra);

  const drawMarks = (): void => {
    const records = host.training.records();
    for (const [cat, p] of packs) {
      const marks = categoryMarks(TRAINING_PACKS, records, cat);
      setChildren(p.marks, ...marks.map((m) => mark(m.state)));
      // The tile's name for a screen reader: its title, then each level's state.
      p.marks.setAttribute('role', 'img');
      p.marks.setAttribute('aria-label', marks.map((m) => t(MARK_TEXT[m.state], { level: DIFFICULTY_LABELS[m.pack.difficulty], best: m.best ?? 0, total: m.pack.shots.length })).join(', '));
    }
  };

  /** LAB in HOW TO PLAY's cell (an unlocked player), HOW TO PLAY a row under the tiles; the focus stays on whichever it was. */
  let labShown: boolean | null = null;
  const drawLab = (): void => {
    const on = exp().unlocked;
    if (on === labShown) return;
    labShown = on;
    const had = document.activeElement === how.el || document.activeElement === lab.el || document.activeElement === howRow.el;
    (on ? how.el : lab.el).replaceWith(on ? lab.el : how.el);
    extra.hidden = !on;
    if (el.isConnected) menu.refit(); // the tile that came in (data-fit)
    if (had) menu.refocus();
  };

  let device: TrainDevice | null = null;
  const drawDevice = (): void => {
    const d = trainDevice(lastInput());
    if (d === device) return;
    device = d;
    if (sub !== null) sub.textContent = subtitleText(d);
    howRow.set(t(DEVICE_NAME[d]));
  };

  // ---- the sheets ----
  /** A pack's sheet: its three levels as big buttons, the focus on the first not passed. */
  const openPack = (cat: TrainingCategory): void => {
    const marks = categoryMarks(TRAINING_PACKS, host.training.records(), cat);
    const first = firstOpen(marks);
    let close = (): void => undefined;
    const level = (m: PackMark, i: number): HTMLButtonElement =>
      h(
        `button.mn-btn.mn-sheet-option.mn-trn-level.mn-trn-level-${m.state}` as 'button',
        {
          type: 'button',
          'data-nav': true,
          'data-key': 'level-' + m.pack.id,
          'data-autofocus': i === first,
          onclick: () => {
            close();
            host.startTraining(m.pack.id);
          },
        },
        mark(m.state),
        h('span.mn-trn-level-text', null, h('b', null, DIFFICULTY_LABELS[m.pack.difficulty]), h('small', null, t('training.packLine', { count: m.pack.shots.length, seconds: m.pack.timeLimitSeconds }))),
        h('span.mn-trn-level-best', null, m.best === null ? t('training.notPlayed') : t('training.best', { best: m.best, total: m.pack.shots.length })),
      );
    close = menu.modal({ title: upper(CATEGORY_LABELS[cat]), body: h('div.mn-sheet-list.mn-trn-levels', null, ...marks.map(level)), actions: [{ label: t('lang.cancel'), onClick: () => true }] });
  };

  /** HOW TO PLAY: every control of the device in use, from its live bindings (a finger: the touch controls). */
  const openHow = (): void => {
    const d = trainDevice(lastInput());
    const cap = (text: string): HTMLElement => h('kbd.mn-key', null, text);
    const row = (label: string, caps: HTMLElement[]): HTMLElement => h('div.mn-ctrl-row', null, h('span.mn-ctrl-label', null, label), h('span.mn-ctrl-keys', null, ...caps));
    const rows =
      d === 'touch'
        ? TOUCH_ROWS.map(([control, does]) => row(t(does), [cap(t(control))]))
        : KEY_ROWS.map(([label, actions]) => {
            // A stick's two directions are one cap ('L stick ←' and 'L stick →': 'L stick'), unbound ones are left out.
            const caps: string[] = [];
            for (const a of actions) {
              const k = keys(a, d);
              if (k === '—') continue;
              const stem = k.replace(/ [←→↑↓]$/, '');
              const prev = caps.at(-1);
              if (prev !== undefined && prev !== k && prev.replace(/ [←→↑↓]$/, '') === stem) caps[caps.length - 1] = stem;
              else if (prev !== k) caps.push(k);
            }
            return caps.length > 0 ? row(t(label), caps.map(cap)) : null;
          });
    menu.modal({
      title: t('training.howTo'),
      body: [h('p.mn-ctrl-device', null, icon(DEVICE_ICON[d]), t(DEVICE_NAME[d])), h('div.mn-ctrlcard', null, ...rows)],
      actions: [{ label: t('nav.close'), primary: true, onClick: () => true }],
    });
  };

  /** LAB: the player's presets (each plays experimental free play with it) and EDIT PRESETS. */
  const openLab = (): void => {
    const store = exp().store;
    const current = store.lastUsed();
    let close = (): void => undefined;
    const option = (id: string, name: string, line: string): HTMLButtonElement =>
      h(
        `button.mn-btn.mn-sheet-option.mn-net-option${id === current ? '.mn-sheet-option-on' : ''}` as 'button',
        {
          type: 'button',
          'data-nav': true,
          'data-autofocus': id === current,
          'aria-current': id === current ? 'true' : undefined,
          onclick: () => {
            store.setLastUsed(id);
            close();
            host.startTraining(FREEPLAY_ID, { rules: id });
          },
        },
        id === current ? icon('check') : null,
        h('span.mn-net-text', null, h('b', null, name), line !== '' ? h('small', null, line) : null),
      );
    const list = store.list().map((p) => option(p.id, presetName(p), rulesSummary(p.values, 3)));
    close = menu.modal({
      title: t('training.expFreePlay'),
      body: h('div.mn-sheet-list', null, ...list),
      actions: [
        {
          label: t('training.editPresets'),
          // After the sheet is gone: the settings screen takes the focus.
          onClick: () => (queueMicrotask(() => menu.openSettings(() => menu.refocus(), { tab: 'experimental' })), true),
        },
        { label: t('lang.cancel'), onClick: () => true },
      ],
    });
  };

  const render = (): void => {
    drawDevice();
    drawLab();
    drawMarks();
    void host.training
      .sync()
      .then(() => {
        if (el.isConnected) drawMarks();
      })
      .catch(() => undefined); // offline / server error: the local copy stays on screen
    // The account's presets (a sync point of the experimental store), for the LAB sheet.
    if (exp().unlocked) void exp().store.sync().catch(() => undefined);
  };
  return {
    id: 'training',
    title: t('training.screenTitle'),
    el,
    show: render,
    tick: () => {
      drawDevice();
      drawLab();
    },
  };
}

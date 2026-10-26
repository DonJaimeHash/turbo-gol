/**
 * Training: free practice, and the shot packs by category (shooting, saving, aerials) and
 * difficulty (easy, medium, hard) with the best run of each: this browser's for a guest, the
 * account's when signed in (shown from the local copy at once, redrawn after the server sync).
 *
 * A signed-in player with Settings > Experimental's switch on also gets Experimental free play
 * (tag EXP): free play with the physics of a preset, picked here with the Rules cycler (it remembers
 * the last pick: the store's lastUsed), the preset's changes in one line, and "Edit presets" (the
 * settings screen on its Experimental tab). Guests and players with the switch off never see it.
 * Packs always run standard physics.
 */
import { h, setChildren, navButton } from '../dom';
import { CATEGORY_LABELS, DIFFICULTY_LABELS, FREEPLAY_ID, FREEPLAY_NAME, TRAINING_CATEGORIES, TRAINING_DIFFICULTIES, TRAINING_PACKS } from '../../game/trainingPacks';
import type { TrainingCategory } from '../../game/trainingPacks';
import type { TrainingRecords } from '../../game/trainingRecords';
import { language, t } from '../../i18n';
import { presetName, rulesSummary } from '../../render/rulesText';
import type { Menu, Screen } from '../Menu';
import type { ActionId, Device } from '../../input/bindings';
import { cycler, screenHead, tile } from './common';

const CATEGORY_TEXT: Readonly<Record<TrainingCategory, string>> = {
  shooting: t('training.shootingText'),
  saving: t('training.savingText'),
  aerial: t('training.aerialText'),
};

/** 'a / b' of the bound labels ('—' = unbound, left out); '' when none is. */
function keyPair(a: string, b: string): string {
  return [a, b].filter((k) => k !== '—').join(' / ');
}

/** The heading's key line: reset shot and previous / next shot, keyboard then controller ('PgUp / PgDn (D-pad ← / D-pad →)'). */
function subtitleText(menu: Menu): string {
  const key = (action: ActionId, device: Device): string => menu.host.keyLabel(action, device);
  const kbmShots = keyPair(key('trainingPrev', 'kbm'), key('trainingNext', 'kbm'));
  const padShots = keyPair(key('trainingPrev', 'pad'), key('trainingNext', 'pad'));
  const shots = kbmShots !== '' && padShots !== '' ? `${kbmShots} (${padShots})` : kbmShots + padShots;
  return t('training.subtitle', { reset: keyPair(key('trainingReset', 'kbm'), key('trainingReset', 'pad')), shots });
}

export function trainingScreen(menu: Menu): Screen {
  const grid = h('div.mn-packs');

  // Experimental free play (unlocked players only): the tile, the Rules cycler, a summary, Edit presets.
  const exp = (): Menu['host']['experimental'] => menu.host.experimental;
  const expTile = tile('mn-tile-exp', 'lab', t('training.expFreePlay').toLocaleUpperCase(language()), t('training.expFreePlayText'), () => menu.host.startTraining(FREEPLAY_ID, { rules: exp().store.lastUsed() }), t('training.tagExp'));
  const cyclerSlot = h('div.mn-exp-cycler');
  const summary = h('p.mn-note.mn-exp-summary');
  const edit = navButton('mn-btn mn-exp-edit', t('training.editPresets'), () =>
    menu.host.openSettings(
      () => {
        drawExp();
        menu.refocus();
      },
      { tab: 'experimental' },
    ),
  );
  const expBlock = h('div.mn-exp', { hidden: true }, expTile, h('div.mn-exp-side', null, cyclerSlot, summary, edit));
  const showSummary = (): void => {
    const store = exp().store;
    const p = store.get(store.lastUsed());
    summary.textContent = p === null ? '' : rulesSummary(p.values, 3);
  };
  /** The block for the player as they are now (the presets may have changed in the editor or on another device). */
  const drawExp = (): void => {
    const x = exp();
    expBlock.hidden = !x.unlocked;
    if (!x.unlocked) return;
    const store = x.store;
    const focused = typeof document !== 'undefined' && cyclerSlot.contains(document.activeElement);
    const c = cycler(
      t('training.rules'),
      store.list().map((p) => ({ value: p.id, label: presetName(p) })),
      () => store.lastUsed(),
      (id) => {
        store.setLastUsed(id);
        showSummary();
      },
    );
    setChildren(cyclerSlot, c.el);
    if (focused) c.el.querySelector('button')?.focus();
    showSummary();
  };

  // The subtitle names the live keys (rebound ones too), written again on every show.
  const head = screenHead(t('training.title'), subtitleText(menu));
  const el = h(
    'div.mn-training',
    null,
    head,
    h('div.mn-training-top', null, tile('mn-tile-hero', 'training', FREEPLAY_NAME.toLocaleUpperCase(language()), t('training.freePlayText'), () => menu.host.startTraining(FREEPLAY_ID)), expBlock),
    grid,
  );
  const draw = (records: TrainingRecords): void => {
    const cols = TRAINING_CATEGORIES.map((cat) =>
      h(
        'div.mn-pack-col',
        null,
        h('div.mn-pack-cat', null, h('b', null, CATEGORY_LABELS[cat]), h('small', null, CATEGORY_TEXT[cat])),
        ...TRAINING_DIFFICULTIES.map((d) => {
          const pack = TRAINING_PACKS.find((p) => p.category === cat && p.difficulty === d);
          if (!pack) return null;
          const rec = records[pack.id];
          const done = rec !== undefined && rec.best >= pack.shots.length;
          return navButton(`mn-pack mn-pack-${d}${done ? ' mn-pack-done' : ''}`, [
            h('span.mn-pack-diff', null, DIFFICULTY_LABELS[d]),
            h('span.mn-pack-shots', null, t('training.packShots', { count: pack.shots.length, seconds: pack.timeLimitSeconds })),
            h('span.mn-pack-best', null, rec ? t('training.best', { best: rec.best, total: pack.shots.length }) : t('training.notPlayed')),
          ], () => menu.host.startTraining(pack.id));
        }),
      ),
    );
    setChildren(grid, ...cols);
  };
  const render = (): void => {
    const sub = head.querySelector('.mn-subtitle');
    if (sub !== null) sub.textContent = subtitleText(menu);
    draw(menu.host.training.records());
    void menu.host.training
      .sync()
      .then((records) => {
        if (el.isConnected) draw(records);
      })
      .catch(() => undefined); // offline / server error: the local copy stays on screen
    drawExp();
    // The account's presets (a sync point of the experimental store): redrawn once they are in.
    if (exp().unlocked) {
      void exp()
        .store.sync()
        .then(() => {
          if (el.isConnected) drawExp();
        });
    }
  };
  return { id: 'training', title: t('training.screenTitle'), el, show: render };
}

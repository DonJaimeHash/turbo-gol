/**
 * Training: free practice, and the shot packs by category (shooting, saving, aerials) and
 * difficulty (easy, medium, hard) with the best run of each (localStorage).
 */
import { h, setChildren, navButton } from '../dom';
import { CATEGORY_LABELS, DIFFICULTY_LABELS, FREEPLAY_ID, FREEPLAY_NAME, TRAINING_CATEGORIES, TRAINING_DIFFICULTIES, TRAINING_PACKS } from '../../game/trainingPacks';
import type { TrainingCategory } from '../../game/trainingPacks';
import { loadTrainingRecords } from '../../game/trainingRecords';
import type { Menu, Screen } from '../Menu';
import { screenHead, tile } from './common';

const CATEGORY_TEXT: Readonly<Record<TrainingCategory, string>> = {
  shooting: 'Definí al arco rival',
  saving: 'Atajá los tiros a tu arco',
  aerial: 'Pelotas altas: saltá y volá',
};

export function trainingScreen(menu: Menu): Screen {
  const grid = h('div.mn-packs');
  const el = h(
    'div.mn-training',
    null,
    screenHead('ENTRENAMIENTO', 'El tiro arranca cuando tocás un control. Backspace / D-pad ↓ reinicia el tiro, ← → cambian de tiro.'),
    h('div.mn-training-top', null, tile('mn-tile-hero', '◎', FREEPLAY_NAME.toUpperCase(), 'Vos, la pelota y boost infinito', () => menu.host.startTraining(FREEPLAY_ID))),
    grid,
  );
  const render = (): void => {
    const records = loadTrainingRecords();
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
            h('span.mn-pack-shots', null, `${pack.shots.length} tiros · ${pack.timeLimitSeconds} s`),
            h('span.mn-pack-best', null, rec ? `Mejor: ${rec.best}/${pack.shots.length}` : 'Sin jugar'),
          ], () => menu.host.startTraining(pack.id));
        }),
      ),
    );
    setChildren(grid, ...cols);
  };
  return { id: 'training', title: 'Entrenamiento', el, show: render };
}

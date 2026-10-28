/**
 * The settings rows (plan §1.3): `mn-set-row` (a label and its help on the left, the control on the
 * right: 56 high, 64 on a TV), `mn-slider` (− · a track of 8 with a 28 thumb and the default's mark
 * · + · a value chip) and `mn-switch` (NO │ SÍ). One focus stop per control: the slider's track and
 * the switch take ◀ ▶ (nav.ts onNavSide; a held arrow slides a slider, never flips a switch), A /
 * Enter / a click flip the switch; − and + are the pointer's. A finger changes a slider only with a
 * sideways drag on its track (pan-y: a vertical one scrolls the page). Built on call, nothing at
 * import; nothing here runs per frame.
 */
import { h } from '../dom';
import { onNavRepeat, onNavSide } from '../nav';
import { t } from '../../i18n';
import { formatSettingValue, sliderPercent, stepSettingValue, valueAt } from '../screens/settings/model';

/** A row: `label` (and a line of help under it) beside `control`; a line of its page's list for ▲ ▼ (nav.ts). */
export function setRow(label: string, control: HTMLElement, help?: string): HTMLElement {
  return h('div.mn-set-row', { 'data-nav-line': true }, h('span.mn-set-row-text', null, h('span.mn-set-row-label', null, label), help ? h('span.mn-set-row-help', null, help) : null), control);
}

export interface Slider {
  readonly el: HTMLElement;
  /** Re-read the value (written only when it changed). */
  refresh(): void;
}

/**
 * A slider over `range` ([min, max, step]) showing `suffix` after the value; `def`: the default's
 * mark on the track. `key` names the track for the focus memory.
 */
export function slider(key: string, label: string, range: readonly [number, number, number], suffix: string, get: () => number, set: (v: number) => void, def?: number): Slider {
  const [min, max, step] = range;
  const fill = h('span.mn-slider-fill');
  const thumb = h('span.mn-slider-thumb');
  const mark = def !== undefined ? h('span.mn-slider-mark', { style: `left: ${sliderPercent(def, min, max)}%` }) : null;
  const track = h('div.mn-slider-track.mn-set-row-ctl', { role: 'slider', tabindex: '-1', 'data-nav': true, 'data-key': key, 'aria-label': label, 'aria-valuemin': String(min), 'aria-valuemax': String(max) }, h('span.mn-slider-rail'), fill, mark, thumb);
  const chip = h('span.mn-slider-chip');
  const defText = def !== undefined ? t('settings.defaultValue', { value: formatSettingValue(def, step, suffix) }) : '';
  let shown = NaN;
  const refresh = (): void => {
    const v = get();
    if (v === shown) return;
    shown = v;
    const text = formatSettingValue(v, step, suffix);
    chip.textContent = text;
    const p = `${sliderPercent(v, min, max)}%`;
    fill.style.width = p;
    thumb.style.left = p;
    track.setAttribute('aria-valuenow', String(v));
    track.setAttribute('aria-valuetext', defText ? `${text}, ${defText}` : text);
  };
  const apply = (v: number): void => {
    if (v !== get()) set(v);
    refresh();
  };
  const nudge = (d: number): void => apply(stepSettingValue(get(), d, min, max, step));
  onNavSide(track, () => nudge(-1), () => nudge(1));
  onNavRepeat(track); // a held ◀ ▶ slides (the field of view has 50 steps)
  // A drag along the track (a mouse anywhere, a finger sideways: pan-y leaves it the vertical scroll).
  let dragging = -1;
  const at = (e: PointerEvent): void => {
    const r = track.getBoundingClientRect();
    apply(valueAt(e.clientX, r.left, r.width, min, max, step));
  };
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = e.pointerId;
    track.setPointerCapture?.(e.pointerId);
    at(e);
  });
  track.addEventListener('pointermove', (e) => {
    if (e.pointerId === dragging) at(e);
  });
  const end = (e: PointerEvent): void => {
    if (e.pointerId === dragging) dragging = -1;
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  const stepBtn = (text: string, aria: string, d: number): HTMLButtonElement =>
    h('button.mn-slider-step', { type: 'button', tabIndex: -1, 'aria-label': `${aria} ${label}`, onclick: () => nudge(d) }, text);
  const el = h('div.mn-slider', { role: 'group', 'aria-label': label }, stepBtn('−', t('settings.less'), -1), track, stepBtn('+', t('settings.more'), 1), chip);
  refresh();
  return { el, refresh };
}

export interface Switch {
  readonly el: HTMLButtonElement;
  refresh(): void;
}

/** NO │ SÍ: ◀ NO, ▶ SÍ, A / Enter / a click on the switch flips it, a click on a side picks that side. */
export function toggleSwitch(key: string, label: string, get: () => boolean, set: (v: boolean) => void): Switch {
  const no = h('span.mn-switch-opt', null, t('settings.off'));
  const yes = h('span.mn-switch-opt', null, t('settings.on'));
  const pick = (v: boolean): void => {
    if (v !== get()) set(v);
    refresh();
  };
  const el = h(
    'button.mn-switch.mn-set-row-ctl',
    {
      type: 'button',
      role: 'switch',
      'data-nav': true,
      'data-key': key,
      'aria-label': label,
      onclick: (e: Event) => pick(e.target === no ? false : e.target === yes ? true : !get()),
    },
    no,
    yes,
  );
  const refresh = (): void => {
    const on = get();
    const v = String(on);
    if (el.getAttribute('aria-checked') !== v) el.setAttribute('aria-checked', v);
    no.classList.toggle('mn-switch-on', !on);
    yes.classList.toggle('mn-switch-on', on);
  };
  onNavSide(el, () => pick(false), () => pick(true));
  refresh();
  return { el, refresh };
}

/**
 * The replay list (replay.html without ?id): the matches the community servers played in the
 * last 30 days (src/net/replays.ts), newest first, a page at a time. Every text goes in as
 * textContent: names come from players.
 */
import { t } from '../i18n';
import type { Key } from '../i18n';
import { PROTOCOL_VERSION } from '../net/protocol';
import { fetchReplayList } from '../net/replays';
import type { ReplayBuild, ReplayListItem } from '../net/replays';
import { ROCKETSIM_WASM_SHA256 } from '../sim/wasm/rocketsim.sha256';
import { TICK_RATE } from '../sim/types';

type Child = Node | string | null;

/** A small element builder: `tag.class1.class2`, attributes, children (strings become text). */
export function el(spec: string, attrs: Record<string, string> | null = null, ...children: Child[]): HTMLElement {
  const [tag, ...classes] = spec.split('.');
  const e = document.createElement(tag || 'div');
  if (classes.length > 0) e.className = classes.join(' ');
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  for (const c of children) if (c !== null) e.append(c);
  return e;
}

/** True when the match was played on this client's simulation (the control plane's sameBuild). */
export function sameBuild(b: ReplayBuild): boolean {
  return b.wasmSha256 === ROCKETSIM_WASM_SHA256 && b.protocol === PROTOCOL_VERSION;
}

export function clockText(ticks: number): string {
  const s = Math.max(0, Math.floor(ticks / TICK_RATE));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function regionName(r: string): string {
  const key = `region.${r}` as Key;
  const text = t(key);
  return text === key ? r : text;
}

function row(m: ReplayListItem): HTMLElement {
  const team = (n: 0 | 1): HTMLElement => {
    const names = m.players.filter((p) => p.team === n).map((p) => (p.bot ? `${p.name} (${t('replay.bot')})` : p.name));
    return el('div.rp-team', null, el(`span.rp-dot.${n === 0 ? 'rp-blue' : 'rp-red'}`), el('span', null, names.join(', ') || '-'));
  };
  const chips: HTMLElement[] = [
    el('span.rp-chip', null, m.ranked ? t('replay.ranked') : t('replay.casual')),
    el('span.rp-chip', null, m.mode),
    el('span.rp-chip', null, regionName(m.region)),
    el(`span.rp-chip.${m.verified ? 'rp-ok' : 'rp-warn'}`, null, m.verified ? t('replay.verified') : t('replay.unverified')),
  ];
  if (!sameBuild(m.build)) chips.push(el('span.rp-chip.rp-warn', null, t('replay.otherVersion')));
  const when = new Date(m.at).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const meta = el('div.rp-meta', null, el('span', null, when), m.ticks > 0 ? el('span', null, clockText(m.ticks)) : null, ...chips);
  const score = el('div.rp-score', null, el('span.rp-b', null, String(m.blue)), ' – ', el('span.rp-r', null, String(m.red)));
  const watch = el('a.rp-btn.rp-primary', { href: `?id=${m.matchId}` }, t('replay.watch'));
  return el('div.rp-row', null, el('div', null, el('div.rp-teams', null, team(0), team(1)), meta), score, watch);
}

/** Fill `root` with the list; `openFile` plays a local file (a maintainer's download). */
export function showList(root: HTMLElement, openFile: (f: File) => void): void {
  document.title = `${t('replay.title')} · Turbogol`;
  const rows = el('div.rp-rows');
  const note = el('p.rp-note', null, t('replay.loading'));
  const more = el('button.rp-btn', { type: 'button' }, t('replay.more'));
  const moreLine = el('div.rp-more.rp-hidden', null, more);
  const file = el('input', { type: 'file', accept: '.tgr,application/octet-stream' }) as HTMLInputElement;
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) openFile(f);
  });
  root.replaceChildren(
    el(
      'div.rp-wrap',
      null,
      el('div.rp-top', null, el('h1.rp-h1', null, t('replay.heading')), el('a.rp-btn', { href: './' }, t('replay.back'))),
      el('p.rp-intro', null, t('replay.intro')),
      note,
      rows,
      moreLine,
      el('label.rp-file', null, el('span', null, t('replay.openFile') + ' '), file),
    ),
  );

  let next: number | null = null;
  let busy = false;
  const load = async (before: number | null): Promise<void> => {
    if (busy) return;
    busy = true;
    more.setAttribute('disabled', '');
    try {
      const page = await fetchReplayList(before);
      for (const m of page.matches) rows.append(row(m));
      next = page.next;
      note.classList.toggle('rp-hidden', rows.childElementCount > 0);
      note.textContent = t('replay.empty');
    } catch (e) {
      const unavailable = e instanceof Error && e.message === 'HTTP 404';
      note.classList.remove('rp-hidden');
      note.replaceChildren(unavailable ? t('replay.unavailable') : t('replay.error'));
      if (!unavailable) {
        const retry = el('button.rp-btn', { type: 'button' }, t('replay.retry'));
        retry.addEventListener('click', () => {
          note.textContent = t('replay.loading');
          void load(before);
        });
        note.append(' ', retry);
      }
    } finally {
      busy = false;
      more.removeAttribute('disabled');
      moreLine.classList.toggle('rp-hidden', next === null);
    }
  };
  more.addEventListener('click', () => {
    if (next !== null) void load(next);
  });
  void load(null);
}

/**
 * Replay viewer page (replay.html), reached from PROFILE. Without ?id it lists the matches the
 * community servers played in the last 30 days (list.ts); with ?id=<matchId> it loads that
 * match's public replay (src/net/replays.ts) and plays it (player.ts).
 *
 * Safe before pretty: the replay is decoded and validated (decodeReplay) before anything runs, every
 * name goes in as text, and the viewer says when the match was played on another build (another
 * wasm or protocol than this page's) and, after running the whole match once, from when the
 * re-simulation stops matching the recording's checkpoints. Only the WebGPU renderer and the wasm
 * are created for a replay, never for the list.
 *
 * Under `npm run dev` only, ?file=<path> plays a file the dev server serves (nodes/scripts/make-test-replay.mjs).
 */
import { decodeReplay } from '../../nodes/shared/replay';
import { TTL_AFTER_MATCH_SECONDS, UNLIMITED_CAP_SECONDS } from '../../nodes/shared/verify';
import type { Replay } from '../../nodes/shared/replay';
import { STORAGE_PREFIX } from '../brand';
import { t } from '../i18n';
import { replayUrl } from '../net/replays';
import { parseQuality } from '../render/quality';
import type { Quality } from '../render/quality';
import { Renderer } from '../render/Renderer';
import { buildArenaMesh } from '../sim/arenaMesh';
import { TICK_RATE } from '../sim/types';
import { LoadingOverlay } from '../ui/LoadingOverlay';
import { clockText, el, sameBuild, showList } from './list';
import { endTickOf, scan, startPlayer } from './player';

const $ = (id: string): HTMLElement => {
  const e = document.getElementById(id);
  if (e === null) throw new Error(`replay.html is missing #${id}`);
  return e;
};

const overlay = new LoadingOverlay($('overlay'));
const MATCH_ID = /^[0-9a-f]{64}$/;

/**
 * The game's saved graphics quality (Game.ts loadPrefs, without the Game). `chosen`: the player
 * picked it; otherwise the renderer may still start lower on a weak device or a TV (bootTier.ts,
 * quality.ts startingQuality), as the game does.
 */
function savedQuality(): { quality: Quality; chosen: boolean } {
  const touch = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  try {
    const p = JSON.parse(window.localStorage.getItem(STORAGE_PREFIX + 'prefs') ?? 'null') as { quality?: unknown; qualitySet?: unknown } | null;
    const q = parseQuality(p?.quality);
    const chosen = p?.qualitySet === true;
    if (q !== null && (!touch || chosen)) return { quality: q, chosen };
  } catch {
    /* private mode */
  }
  return { quality: touch ? 'low' : 'high', chosen: false };
}

/**
 * The longest match a verifier accepts (verify.ts maxTicksFor), with the header's length capped as
 * the verifier caps an unlimited one: a hostile file cannot keep the page simulating for hours.
 */
function maxTicks(lengthSeconds: number): number {
  const s = lengthSeconds > 0 ? Math.min(lengthSeconds, UNLIMITED_CAP_SECONDS) + TTL_AFTER_MATCH_SECONDS + 120 : Math.min(UNLIMITED_CAP_SECONDS, TTL_AFTER_MATCH_SECONDS + 120);
  return Math.ceil(s * TICK_RATE);
}

/** The player's stop (startPlayer), once it runs. */
let stopPlayer: (() => void) | null = null;
/** A failure ended the page: a play() still preparing stops at its next step. */
let dead = false;

function fail(message: string, detail?: unknown): void {
  if (detail !== undefined) console.error(message, detail);
  dead = true;
  stopPlayer?.();
  for (const id of ['bar', 'notice', 'tags', 'hud']) $(id).classList.add('rp-hidden');
  const box = $('error');
  box.replaceChildren(el('p', null, message), el('div', null, el('a.rp-btn.rp-primary', { href: './replay.html' }, t('replay.list')), ' ', el('a.rp-btn', { href: './' }, t('replay.back'))));
  box.classList.remove('rp-hidden');
  void overlay.hide();
}

function notice(text: string, ok: boolean): void {
  const n = $('notice');
  n.textContent = text;
  n.classList.toggle('rp-ok', ok);
  n.classList.remove('rp-hidden');
  if (ok) setTimeout(() => n.classList.add('rp-hidden'), 4000);
}

async function play(source: () => Promise<Uint8Array | null>): Promise<void> {
  document.title = `${t('replay.title')} · Turbogol`;
  $('list').classList.add('rp-hidden');
  await overlay.show(t('replay.preparing'));
  let bytes: Uint8Array | null;
  try {
    bytes = await source();
  } catch (e) {
    fail(t('replay.error'), e);
    return;
  }
  if (bytes === null) {
    fail(t('replay.notFound'));
    return;
  }
  let r: Replay;
  try {
    r = decodeReplay(bytes);
  } catch (e) {
    fail(t('replay.bad'), e);
    return;
  }
  if (endTickOf(r) > maxTicks(r.header.matchLengthSeconds)) {
    fail(t('replay.bad'));
    return;
  }
  overlay.progress(0.2);
  const q = savedQuality();
  const renderer = await Renderer.create($('game-canvas') as HTMLCanvasElement, { quality: q.quality, qualityChosen: q.chosen });
  // A lost GPU device ends the page with a way out instead of a frozen frame. Any other GPU error is
  // logged only: the game falls back a tier for those, and most never show (tierGuard.ts).
  renderer.setFailureListener((f) => {
    if (f.kind === 'lost') fail(t('replay.gpuLost'), f.message);
    else console.warn('replay: GPU error', f.message);
  });
  if (dead) return;
  const mesh = buildArenaMesh();
  overlay.progress(0.35);
  const result = await scan(r, mesh, (p) => overlay.progress(0.35 + 0.6 * p, 60));
  if (dead) return;
  stopPlayer = await startPlayer({ replay: r, scan: result, renderer, mesh, hudRoot: $('hud'), tagsRoot: $('tags'), bar: $('bar') });
  if (dead) {
    stopPlayer();
    return;
  }
  await overlay.hide();
  const other = !sameBuild(r.header.build);
  if (result.divergedAt >= 0) notice(t('replay.diverged', { time: clockText(result.divergedAt) }), false);
  else if (other) notice(t('replay.buildWarning'), false);
  else if (result.checked > 0 && endTickOf(r) > 0) notice(t('replay.checked'), true);
}

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function boot(): void {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  const fileParam = import.meta.env.DEV ? params.get('file') : null;
  // Development only, and only a file of this origin (new URL resolves '//host' and '/\host' too).
  let file: string | null = null;
  if (fileParam !== null) {
    try {
      const u = new URL(fileParam, location.href);
      if (u.origin === location.origin) file = u.pathname + u.search;
    } catch {
      /* not a URL */
    }
  }
  if (id !== null && MATCH_ID.test(id)) {
    void play(() => fetchBytes(replayUrl(id))).catch((e: unknown) => fail(t('replay.error'), e));
  } else if (file !== null) {
    const path = file;
    void play(() => fetchBytes(path)).catch((e: unknown) => fail(t('replay.error'), e));
  } else {
    const list = $('list');
    list.classList.remove('rp-hidden');
    showList(list, (f) => void play(async () => new Uint8Array(await f.arrayBuffer())).catch((e: unknown) => fail(t('replay.error'), e)));
    void overlay.hide();
  }
}

boot();

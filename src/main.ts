/**
 * Boot: renderer (WebGPU, WebGL2 fallback) → RocketSim wasm → analytic arena mesh → arena +
 * the cars of the saved game mode (1v1 / 2v2 / 3v3) → Game. Progress is written to #overlay; a
 * readable error page replaces it when the GPU or the wasm cannot be initialised. Both are in the
 * page's language (boot.* texts); the error details (stack) stay as the browser wrote them.
 */
import { Game, addRoster, loadPrefs } from './game/Game';
import { t } from './i18n';
import type { GameMode } from './sim/constants';
import { Renderer } from './render/Renderer';
import { loadSettings } from './settings';
import { buildArenaMesh } from './sim/arenaMesh';
import { RocketSim } from './sim/RocketSimBridge';
import { CarPreset, TICK_RATE, Team } from './sim/types';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`index.html is missing #${id}`);
  return el as T;
}

const overlay = byId<HTMLDivElement>('overlay');

function setProgress(text: string): void {
  overlay.textContent = '';
  const box = document.createElement('div');
  box.className = 'overlay-msg';
  const title = document.createElement('div');
  title.className = 'overlay-title';
  title.textContent = 'TURBOGOL';
  const line = document.createElement('div');
  line.className = 'overlay-line';
  line.textContent = text;
  box.append(title, line);
  overlay.appendChild(box);
}

function clearProgress(): void {
  overlay.textContent = '';
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

function showError(title: string, hint: string, err: unknown): void {
  overlay.textContent = '';
  const box = document.createElement('div');
  box.className = 'overlay-msg overlay-error';
  const h = document.createElement('div');
  h.className = 'overlay-title';
  h.textContent = title;
  const p = document.createElement('div');
  p.className = 'overlay-line';
  p.textContent = hint;
  const pre = document.createElement('pre');
  pre.className = 'overlay-detail';
  pre.textContent = describe(err);
  box.append(h, p, pre);
  overlay.appendChild(box);
  overlay.classList.add('overlay-blocking');
  console.error(title, err);
}

async function boot(): Promise<void> {
  const canvas = byId<HTMLCanvasElement>('game-canvas');
  const hudContainer = byId<HTMLDivElement>('hud');
  const prefs = loadPrefs();
  // Controls / camera / bindings (Settings > Controls & Camera), persisted by the Game on change.
  const settings = loadSettings();

  setProgress(t('boot.renderer'));
  // The wasm fetch + compile starts now, concurrently with the GPU adapter / device request (the
  // two longest async steps of the boot). Its outcome is captured so each failure keeps its own
  // error page and a renderer failure never leaves an unhandled rejection behind.
  const simLoad: Promise<{ sim: RocketSim | null; err: unknown }> = RocketSim.load().then(
    (sim) => ({ sim, err: null }),
    (err: unknown) => ({ sim: null, err }),
  );
  let renderer: Renderer;
  try {
    renderer = await Renderer.create(canvas, { quality: prefs.quality, theme: prefs.theme });
  } catch (err) {
    showError(t('boot.rendererFailed'), t('boot.rendererHint'), err);
    return;
  }

  setProgress(t('boot.physics', { backend: renderer.isWebGPU ? 'WebGPU' : 'WebGL2' }));
  const loaded = await simLoad;
  if (loaded.sim === null) {
    showError(t('boot.physicsFailed'), t('boot.physicsHint'), loaded.err);
    return;
  }
  const sim = loaded.sim;

  setProgress(t('boot.arena'));
  const mesh = buildArenaMesh();
  sim.initArena(mesh.physics);
  sim.createArena(TICK_RATE);
  // The player is added first (slot 0, blue), then the bots of the saved mode: blue teammates,
  // then the red team. A wasm build with a smaller MAX_CARS refuses the bigger rosters: fall
  // back to 1v1 rather than failing the boot.
  const playerCarId = sim.addCar(Team.Blue, CarPreset.Standard);
  let mode: GameMode = prefs.mode;
  let carIds: number[];
  try {
    carIds = addRoster(sim, playerCarId, mode);
  } catch (err) {
    console.warn(`Could not add the ${mode} roster, falling back to 1v1`, err);
    mode = '1v1';
    carIds = addRoster(sim, playerCarId, mode);
  }
  sim.resetKickoff();
  sim.sync();

  setProgress(t('boot.scene'));
  // Let the progress text paint before the (synchronous, ~50 ms) scene build. rAF does not fire
  // in a hidden tab, so a timer fallback keeps the boot going in the background.
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, 50);
    requestAnimationFrame(() => {
      window.clearTimeout(timer);
      resolve();
    });
  });
  const game = new Game({
    sim,
    renderer,
    arenaMesh: mesh,
    hudContainer,
    canvas,
    settings,
    mode,
    playerCarId,
    carIds,
    difficulty: prefs.difficulty,
    qualitySet: prefs.qualitySet,
    info: `${renderer.isWebGPU ? 'WebGPU' : 'WebGL2'} · RocketSim ${sim.version} · 120 Hz`,
  });
  // One synchronous render with every normally hidden mesh visible: compiles all pipelines
  // (scene, shadow, bloom, flames, marker, particles, goal FX) behind the overlay instead of
  // stalling the first menu frame and the first boost / airborne ball / goal.
  game.warmUp();
  clearProgress();
  game.start();
}

boot().catch((err: unknown) => {
  showError(t('boot.failed'), t('boot.failedHint'), err);
});

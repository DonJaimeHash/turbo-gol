/**
 * Boot: renderer (WebGPU, WebGL2 fallback) → RocketSim wasm → analytic arena mesh → arena +
 * the cars of the saved game mode (1v1 / 2v2 / 3v3) → Game → warm-up → menu. The loading screen
 * (#overlay, src/ui/LoadingOverlay.ts: the wordmark, a progress bar, one short line) is in
 * index.html, so it shows from the first paint; each step moves the bar (an eased CSS transition
 * toward the step's end, so it keeps moving through the long steps and the synchronous ones), and
 * it fades into the menu once the menu's first frame is on screen. The Game keeps it for every
 * later load. A readable error page replaces it when the GPU or the wasm cannot be initialised,
 * in the page's language (boot.* texts); the error details (stack) stay as the browser wrote them.
 *
 * Load timing: each step leaves a `performance.mark` ('turbogol:renderer' once the renderer and
 * the world's first bake or cache read are ready, ':physics', ':scene', ':warmup' after the
 * warm-up render compiled every pipeline, ':gpu-ready' once the GPU finished that work on
 * WebGPU, ':menu' once the loading screen is gone), read from the console or a profiler; marks
 * cost nothing measurable.
 */
import { Game, addRoster, loadPrefs } from './game/Game';
import { t } from './i18n';
import { LoadingOverlay, afterPaint, paintedFrames } from './ui/LoadingOverlay';
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
const loading = new LoadingOverlay(overlay);

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
  // The page stops here: the error page stays up and takes the keys back (copying the details).
  loading.dispose();
  overlay.classList.add('ld-on', 'overlay-blocking');
  console.error(title, err);
}

async function boot(): Promise<void> {
  const canvas = byId<HTMLCanvasElement>('game-canvas');
  const hudContainer = byId<HTMLDivElement>('hud');
  const prefs = loadPrefs();
  // Controls / camera / bindings (Settings > Controls & Camera), persisted by the Game on change.
  const settings = loadSettings();

  loading.label(t('loading.stadium'));
  // The GPU adapter / device and the world's first bake or cache read: the longest step (a cached
  // load is well under a second, a first visit's bake a couple of seconds).
  loading.progress(0.42, 2600);
  // The wasm fetch + compile starts now, concurrently with the GPU adapter / device request (the
  // two longest async steps of the boot). Its outcome is captured so each failure keeps its own
  // error page and a renderer failure never leaves an unhandled rejection behind.
  const simLoad: Promise<{ sim: RocketSim | null; err: unknown }> = RocketSim.load().then(
    (sim) => ({ sim, err: null }),
    (err: unknown) => ({ sim: null, err }),
  );
  let renderer: Renderer;
  try {
    // The boot tier (bootTier.ts: #superlow, the tab's recovery, the player's pick, super low on a
    // 1 GB device or a TV on the slow GPU list) picks the backend; then the WebGL2 fallback starts on
    // low unless the player picked a tier (quality.ts startingQuality).
    renderer = await Renderer.create(canvas, { quality: prefs.quality, qualityChosen: prefs.qualitySet, theme: prefs.theme });
  } catch (err) {
    showError(t('boot.rendererFailed'), t('boot.rendererHint'), err);
    return;
  }

  performance.mark('turbogol:renderer');
  loading.label(t('loading.pitch'));
  loading.progress(0.55, 700);
  const loaded = await simLoad;
  if (loaded.sim === null) {
    showError(t('boot.physicsFailed'), t('boot.physicsHint'), loaded.err);
    return;
  }
  const sim = loaded.sim;
  performance.mark('turbogol:physics');

  loading.progress(0.6, 200);
  // The arena, the roster and the scene are built synchronously (~50-150 ms): the bar eases on
  // (the transition runs on the compositor) once this frame has painted.
  await afterPaint();
  loading.progress(0.74, 600);
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
    savedQuality: prefs.quality,
    info: `${renderer.isWebGPU ? 'WebGPU' : 'WebGL2'} · RocketSim ${sim.version} · 120 Hz`,
    loading,
  });
  // Every pipeline (scene, shadow, bloom, flames, marker, particles, goal FX) is compiled behind the
  // overlay instead of stalling the first menu frame and the first boost / airborne ball / goal:
  // one render with every normally hidden mesh visible, after compiling its pipelines in parallel
  // (Renderer.precompile).
  performance.mark('turbogol:scene');
  loading.label(t('loading.ready'));
  loading.progress(0.95, 2400);
  await game.warmUpAsync();
  performance.mark('turbogol:warmup');
  const device = (renderer.gpu.backend as { device?: { queue?: { onSubmittedWorkDone?: () => Promise<void> } } }).device;
  if (device?.queue?.onSubmittedWorkDone) void device.queue.onSubmittedWorkDone().then(() => performance.mark('turbogol:gpu-ready'));
  // The menu and its first frames come up under the loading screen, then it fades into them.
  game.start();
  await paintedFrames(2);
  await loading.hide();
  performance.mark('turbogol:menu');
  // The tier safety net listens from now on (a failure of the warm-up is handled now, behind its
  // own loading screen): render/tierGuard.ts.
  game.bootDone();
}

boot().catch((err: unknown) => {
  showError(t('boot.failed'), t('boot.failedHint'), err);
});

/**
 * Game: the fixed-step loop that wires every module together (see ARCHITECTURE.md "Frame loop").
 *
 *   requestAnimationFrame:
 *     dt = clamp(now - last, 0, MAX_FRAME_DT); acc += dt (x free play's game speed, never above 1)
 *     while acc >= TICK_DT:  input -> controls, bot -> controls, sim.step(1), prev <- cur,
 *                            sim.sync() (fires goal / bump / ball-hit events), cur <- sim.buf,
 *                            match.tick(), pad pickups, player sound edges
 *     alpha = acc / TICK_DT
 *     views interpolate prev -> cur by alpha, camera, HUD, audio, renderer.render()
 *
 * Two state snapshots (`prev`, `cur`, Float32Array(STATE_BUFFER_FLOATS)) are the only thing the
 * views read; the sim's live buffer is touched only inside the tick. No per-frame allocations on
 * the hot path (the only strings built at runtime are the 4 Hz fps readout and HUD banners).
 *
 * Game modes (1v1 / 2v2 / 3v3, src/sim/constants.ts MODES): the roster is `carIds` in creation
 * order, the human's blue car first (slot 0), then its blue teammates, then the red cars
 * (`addRoster`). Every roster entry has a CarView, a preallocated CarControls and an Effects
 * registration; the red cars are driven by one BotTeam and the blue teammates by another, each
 * thinking once per tick for all of its slots (the blue team also ranks the human as a passive
 * member, so its bots take the roles / kickoff duties the human leaves). The chase camera follows
 * roster entry 0. The mode
 * can only change from the menu (`setMode`): the bots are removed from the sim and re-added.
 * A running match reaches the menu through the pause menu's QUIT entry only (`quitToMenu`; online
 * it takes a second press) or the return after the final whistle.
 *
 * Pause menu (Hud.setPaused, entries built by `pauseEntries`): RESUME, the training entries,
 * SETTINGS and QUIT, for every input: mouse and touch click them, Input's menu edges (arrows /
 * WASD / Enter, D-pad / stick / A) move the focus through `Hud.pauseAction`, pad X opens the
 * settings. Esc / Start toggle the pause, and the back keys (pad B, Backspace) resume: on a
 * controller B means "close this", and it is also boost (it used to quit at once, online and in
 * Competitive too). SETTINGS opens the Hud's settings screen over the paused game
 * (`openPauseSettings`; the game stays paused and the chase camera stays put: `menuShown` ignores
 * that screen) and its BACK (button, Esc, B) returns to the pause menu.
 *
 * System Back (src/ui/backGuard.ts: Android's back gesture and button, a TV remote's BACK, the
 * browser's back, Alt + ←, a mouse's back button) never leaves the page by itself: `onSystemBack`
 * closes the settings screen or a modal, goes back one menu screen, pauses a match being played
 * (a paused one stays paused), and on the home screen asks "Leave Turbogol?" (`confirmLeave`).
 * What still walks the history out mid-match meets the browser's "Leave site?" (`updateLeaveGuard`).
 *
 * The controls card (src/render/controlsCard.ts, Hud.setControlsCard): the first matches' kickoff
 * countdown and free play show the live bindings of the device in use, then a slim strip for a
 * minute of play (`controlsCard`, `updateControlsCard`); touch mode shows none.
 *
 * Long loads run behind the loading screen (src/ui/LoadingOverlay.ts, `withLoading`): a quality
 * switch (`switchQuality`: renderer tier, view rebuild, the world's new bake sizes, every pipeline
 * compiled in parallel) and a stadium switch (`switchTheme`: uniforms, then the world's re-bake or
 * cache read). The overlay is painted first, the work runs in steps with a painted frame between
 * them (the bar moves), and the loop neither renders nor reads input meanwhile (`loadingHold`).
 * `setQuality` / `setTheme` stay the synchronous switches (the console and the capture helpers).
 * A tier that breaks on this GPU (validation errors after the boot or a switch, a lost device)
 * falls back one tier by itself through the same switch (`onGpuFailure`, src/render/tierGuard.ts),
 * from `bootDone()` on. A switch into or out of super low (quality.ts needsReload: its own backend
 * and world) saves the prefs and reloads the page behind the loading screen (`restartOn`); a lost
 * device reloads through the tab's counter (tierGuard.ts lossStep: reload, then super low, then a
 * message and no more reloads).
 *
 * UI at rest (`frame`, quality.ts sceneFps): the scene is drawn at the match's frame cap (the
 * tier's maxFps and the player's GamePrefs.fpsCap), at 30 fps under the menus (20 on super low
 * when they let it through, and on a phone whose menus hide more than 70 % of it), and not at all
 * (one held frame, drawn again only when something under it changes: `redraw`) under an opaque
 * layer (a menu sheet, the menus' own opaque page on super low, the settings screen, the
 * rotate-your-phone screen of a match), in an offline pause and, under the menus, with
 * prefers-reduced-motion or GamePrefs.menuSceneAnimated off. The menus say what they leave of the
 * scene (`setMenuCover`, src/ui/Menu.ts). The menus' rates and the player's limit keep their
 * average on any display (quality.ts FramePacer: 30 on 144 / 165 Hz), the tier's own cap counts
 * whole refreshes as it always did (drawsFrame). A match being played keeps its cap for
 * everything; the menus and an offline pause still read the input and run their logic on every
 * animation frame, and an online pause reads the pad on the frames between its cap's, so a short
 * pad press is never lost between two drawn frames. Paced frames give dynamic resolution no
 * interval (Renderer.render), so the menus start at full resolution (resetResolutionScale).
 *
 * Super low (TierSpec.maxFps, cpuLite): a match runs at most 30 frames a second (`drawsFrame`:
 * the skipped animation frames do nothing, the next drawn one carries their time), the HUD runs
 * without blur, shadows and decorative animation (`html.tg-superlow`, src/style.css) and updates
 * its boost and speed at 10 Hz, the audio has no room, the ball prediction refreshes every 8 ticks
 * instead of 4 (BALL_PRED_EVERY_LITE: the bots read the prediction by age; the 720-tick horizon is
 * the wasm's) and going online shows a one-line notice. Physics stays at 120 Hz.
 *
 * Experimental features (Settings > Experimental, `experimental`: src/game/experimentalStore.ts):
 * a signed-in player's switch and physics presets. Super low is a pick only for an unlocked player
 * (`experimentalUnlocked`: signed in, switch on): the Graphics tab lists it for them alone
 * (quality.ts menuQualities), main.ts gates a saved pick at boot (bootTier.ts gateTierPrefs), and
 * every account or switch change re-checks it (`checkTierLock`: a locked player's saved super low
 * becomes Performance from the next start, said in a toast, nothing reloads). Devices that run
 * super low on their own keep it. The same unlocked player gets experimental free play (the
 * training screen's tile: startTraining(FREEPLAY_ID, { rules }), see Training below).
 *
 * `#diag` (src/render/frameStats.ts): the loop feeds the frame times and the CPU of the ball
 * prediction, the bots, the physics step and the render call; nothing is measured without it.
 *
 * Settings (src/settings.ts: controls, camera, bindings, audio) are one live object shared by Input
 * (reads bindings / sensitivities, mutates them from the settings screen), ChaseCamera (reads
 * `camera` by reference) and the Hud (sliders). Every change ends in `applySettings()`: save to
 * localStorage, re-apply the dodge deadzone to the sim, the camera projection and the volume.
 *
 * Day stadiums (themeWorld(theme).night false) give the ball no shadow (`applyBallShadow`): under
 * a low sun it lands far from the ball and reads as a second landing marker. Only the ball mesh's
 * castShadow flips (no recompile); the warm-ups behind the loading screen turn it on so its shadow
 * pipeline is ready for the night stadiums.
 *
 * Mouse look needs the pointer lock: a click on the canvas while a match is being played
 * requests it (that click is masked so it does not boost / jump), opening the menu / pausing / the
 * final whistle / losing focus release it, and losing it from the browser side (Esc) pauses the
 * game like an Esc menu. A click on the paused game resumes it and recaptures in one action.
 *
 * Touch screens (navigator.maxTouchPoints > 0) also get the on-screen controls (`touch`,
 * src/input/TouchControls.ts), Input's touch source: shown while a match is played in touch mode
 * (the last input used was a finger), which also drops the pointer-lock hint; a tap on the paused
 * game resumes it without a phantom boost, and turning a phone to portrait pauses an offline match.
 * On Android a finger tap outside the controls goes fullscreen in landscape (autoFullscreen) and
 * leaving fullscreen mid-match pauses it; an iPhone (no element fullscreen) gets a one-time
 * add-to-home-screen toast in the menus. Without a touch screen none of it exists.
 *
 * Audio unlocks on the first gesture with a user activation (onGesture); the listeners go once the
 * context runs and come back when the system takes it away (iOS after a call or an app switch).
 *
 * Online sessions: the Game hosts one GameSession at a time (`session`): the phase 1 OnlineSession
 * (`online`, a Durable Object host, menu "Partida en servidor") or the phase 2 P2PSession (`p2p`,
 * WebRTC mesh with deterministic rollback, menu "Quick match (P2P)"). While a session is active the
 * frame loop calls session.advance(dt) instead of the offline tick loop, the HUD reads score /
 * clock / frozen / stats from it, and the roster is the room's (applyOnlineRoster /
 * applyP2PRoster: fresh arena in slot order, the player at its slot, no local bot teams). The
 * P2PSession drives the Game through P2PGameHooks (input sampling, per-tick bookkeeping, match
 * events from the confirmed timeline, drops, the fallback hand-over to the OnlineSession).
 *
 * Training (startTraining(FREEPLAY_ID | pack id) / stopTraining): a fresh arena with ONLY the
 * player's car (no bots, no Match, no countdown), driven by a TrainingSession (pure rules,
 * src/game/TrainingSession.ts) through TrainingHooks (place / release a shot, results, summary,
 * free play resets) and shown by the TrainingHud. The loop runs trainingTick() instead of tick():
 * while a shot waits for the first car input (or the pack summary is up) the sim does not step at
 * all, so car and ball stay exactly where the shot put them. Leaving (pause screen quit, the
 * summary's "back to menu", or startMatch / an online session) rebuilds the offline roster of the
 * selected mode (restoreOfflineRoster), so the next friendly match is the same as after boot.
 * Experimental free play (`freePlayRules`, an unlocked player's preset) builds its arena with the
 * preset's physics before the car (src/game/experimentalTraining.ts), runs the clock at its game
 * speed, shows "Rules: name" and a RULES pause entry (the settings screen's Experimental tab; the
 * pick there applies once, when it closes: applyFreePlayRules) and saves no records; packs are
 * always stock, and any training whose physics differ from the arena's rebuilds it.
 * Search practice (MODOS' "While you wait: Free play", startSearchPractice): free play over a menu
 * search that keeps queueing; the frame watches the session (watchSearchPractice): once it leaves
 * its queue the one hand-off, practiceToMatch, ends practice under the PARTIDO ENCONTRADO band and
 * today's found -> match path plays (a failed connect brings the menus back); quitting practice
 * returns to the menus still searching (stopTraining -> showMenu(true)).
 */
import * as THREE from 'three/webgpu';
import type { Difficulty } from '../ai/Bot';
import { BotTeam } from '../ai/Team';
import { Audio, type AudioState } from '../audio/Audio';
import { Input } from '../input/Input';
import { TouchControls, autoFullscreen, hasTouchScreen, installHintDue, noteInstallHintShown } from '../input/TouchControls';
import { t } from '../i18n';
import { sessionValid } from '../net/NetClient';
import type { NetClient, ServerAssignment } from '../net/NetClient';
import { AccountClient, oauthErrorText, parseAuthHash } from '../net/AccountClient';
import { TrainingStore } from './trainingStore';
import { ExperimentalStore, type ExperimentalProblem } from './experimentalStore';
import { MAX_PRESETS, canonicalValues, type PhysicsValues } from './physicsRules';
import { arenaMutators } from '../sim/mutators';
import { STOCK_ARENA_FINGERPRINT, accumulate, buildTrainingArena, needsTrainingArena, planTrainingArena, trainingRules, type TrainingArenaPlan } from './experimentalTraining';
import type { ExperimentalContext, ExperimentalOptions, SuperlowStatus } from '../render/experimentalPage';
import { lobbyRulesLine, presetName } from '../render/rulesText';
import { LobbyClient } from '../net/LobbyClient';
import { REGIONS, isPlaylist } from '../net/account';
import type { RegionId } from '../net/account';
import { isNodeHost, type QueueResult } from '../net/protocol';
import type { QueueResultP2p } from '../net/p2p/protocol';
import { createMenu, RankedResults } from '../ui';
import type { Menu, MenuConfig, MenuHost, SearchRequest, SearchView } from '../ui';
import { finalScreen, installFinalSample, type FinalScreen } from '../ui/screens/match/final';
import { goalScorer, type FinalKind, type FinalPlayer, type FinalView } from '../ui/screens/match/finalModel';
import { MatchFound } from '../ui/screens/match/found';
import { regionName } from '../ui/names';
import type { NetStatsView } from '../net/NetStats';
import { P2PSession, kickoffSeedOf, type P2PGameHooks } from '../net/p2p/P2PSession';
import type { RoomWelcome } from '../net/p2p/protocol';
import { RollbackEngine } from '../net/p2p/Rollback';
import type { MatchEvent as HostEvent, Welcome } from '../net/protocol';
import { ArenaView } from '../render/Arena';
import { BallView } from '../render/Ball';
import { ChaseCamera, SWIVEL_PITCH_MOUSE_DEG, SWIVEL_PITCH_STICK_DEG, type CameraCarState } from '../render/Camera';
import { CarView } from '../render/Car';
import { Effects } from '../render/Effects';
import { Hud, netBars, type ClockMode, type MenuOptions, type OnlineKind, type PauseEntry, type ScoreboardData, type ScoreboardRow, type SettingsTab } from '../render/Hud';
import { TrainingHud, type TrainingHints } from '../render/TrainingHud';
import { Renderer, type GpuFailure } from '../render/Renderer';
import { tierPrefsAfter } from '../render/bootTier';
import { diagSources, diagStats, enableDiagStats } from '../render/frameStats';
import { emulatedDevice, pageFlags, withoutTierFlags } from '../render/hashFlags';
import { FramePacer, HELD_FRAME, drawsScene, frameCap, menuQualities, needsReload, parseFpsCap, parseQuality, pauseHolds, runsLogic, sceneFps, type FpsCap, type Quality, type SceneCover } from '../render/quality';
import {
  BACKGROUND_LOSS_MS,
  FALLBACK_WINDOW_MS,
  LOSS_COUNT_KEY,
  RECOVER_KEY,
  TRY_TIER_KEY,
  TierGuard,
  lossStep,
  parseLossRecord,
  raiseCeiling,
  writeCeiling,
  type Fallback,
} from '../render/tierGuard';
import { DEFAULT_THEME, parseTheme, themeWorld, type ThemeId } from '../render/theme';
import { LoadingOverlay, afterPaint, paintedFrames } from '../ui/LoadingOverlay';
import { loadSettings, saveSettings, type Settings } from '../settings';
import type { ArenaMesh } from '../sim/arenaMesh';
import { BOOST_PADS_BIG, BOOST_PADS_SMALL, MODES, type GameMode } from '../sim/constants';
import type { RocketSim } from '../sim/RocketSimBridge';
import {
  BALL_OFFSET,
  B_POS,
  B_VEL,
  CARS_OFFSET,
  CarPreset,
  C_BOOST,
  C_HAS_DOUBLE_JUMPED,
  C_HAS_JUMPED,
  C_IS_BOOSTING,
  C_IS_DEMOED,
  C_IS_FLIPPING,
  C_IS_ON_GROUND,
  C_IS_SUPERSONIC,
  C_POS,
  C_ROT,
  C_VEL,
  C_WHEEL_SUSPENSION,
  H_TICK_COUNT,
  MAX_CARS,
  NUM_BOOST_PADS,
  PADS_OFFSET,
  PAD_STRIDE,
  P_COOLDOWN,
  P_IS_ACTIVE,
  STATE_BUFFER_FLOATS,
  TICK_DT,
  TICK_RATE,
  Team,
  emptyControls,
  type CarControls,
} from '../sim/types';
import { DEFAULT_MATCH_SECONDS, Match, formatClockSeconds, type MatchEvent } from './Match';
import { GAME_NAME, STORAGE_PREFIX } from '../brand';
import { BackGuard } from '../ui/backGuard';
import { systemBack } from '../ui/backModel';
import { installDevice, type DeviceTracker } from '../ui/device';
import { pauseKeyAction, pauseResumeKeys } from './pauseKeys';
import { CARD_FIRST_MATCHES, ControlsCardPlan, controlsCardRows, localCardSeen, type ControlsCardContent } from '../render/controlsCard';
import type { Device } from '../input/bindings';
import { kbmCustomised, usesMouseButton } from '../input/bindings';
import { OnlineSession } from './OnlineSession';
import { FREEPLAY_BALL, FREEPLAY_CAR_SPAWN, FREEPLAY_ID, FREEPLAY_NAME, packById, type TrainingShot } from './trainingPacks';
import {
  FREEPLAY_GOAL_PAUSE_SECONDS,
  RESULT_SECONDS,
  TrainingSession,
  hasCarInput,
  type ResultReason,
  type TrainingBallSample,
  type TrainingHooks,
  type TrainingSummary,
} from './TrainingSession';

export interface GameOptions {
  sim: RocketSim;
  renderer: Renderer;
  arenaMesh: ArenaMesh;
  /** DOM element that receives the HUD (normally #hud). */
  hudContainer: HTMLElement;
  /** The game canvas: pointer-lock target for mouse look. Defaults to #game-canvas; null disables. */
  canvas?: HTMLCanvasElement | null;
  /** Controls / camera / bindings (src/settings.ts). Loaded from localStorage when omitted. */
  settings?: Settings;
  /** Cars per team: '1v1' | '2v2' | '3v3' (src/sim/constants.ts MODES). Defaults to '1v1'. */
  mode?: GameMode;
  /** The human's car id (sim.addCar on the blue team); it must have been added FIRST (slot 0). */
  playerCarId: number;
  /**
   * Every car id in creation order: the player, then the player's blue teammates, then the red
   * cars, exactly what `addRoster()` returns. Required for 2v2 / 3v3; `[playerCarId, botCarId]`
   * when omitted.
   */
  carIds?: readonly number[];
  /** 1v1 compatibility: the one red car (ignored when `carIds` is given). */
  botCarId?: number;
  difficulty?: Difficulty;
  /** The player picked the quality tier in the menu (GamePrefs.qualitySet); persisted with the prefs. */
  qualitySet?: boolean;
  /**
   * The quality tier read from the prefs: the player's choice (qualitySet) or the saved default.
   * The renderer may run another one (super low from the URL or on a weak TV, low on the WebGL2
   * fallback, a GPU's ceiling, a fallback), which is never saved: the prefs keep this one until
   * the player picks a tier in the menu.
   */
  savedQuality?: Quality;
  /**
   * The saved pick was super low and this player may not pick it (bootTier.ts gateTierPrefs in
   * main.ts): the prefs above already read Performance; the menus say why once they are up.
   */
  superlowLocked?: boolean;
  /** GamePrefs.menuSceneAnimated (true when omitted). */
  menuSceneAnimated?: boolean;
  /** GamePrefs.fpsCap (0 = none when omitted). */
  fpsCap?: FpsCap;
  /** Regulation length in seconds (0 = unlimited). */
  matchLengthSeconds?: number;
  /** Text shown in the menu footer (backend, version...). */
  info?: string;
  /** The boot's loading screen, reused for every later load (one is created over #overlay when omitted). */
  loading?: LoadingOverlay;
}

export interface GamePrefs {
  difficulty: Difficulty;
  /** Saved as the tier name; saves from before the third tier hold 0 / 1 (parseQuality reads both). */
  quality: Quality;
  mode: GameMode;
  /**
   * The player picked the quality in the menu. Phones and tablets (coarse pointer) start on the
   * light tier ('low') and only keep a saved tier the player chose, not one saved under the old default.
   */
  qualitySet: boolean;
  /** Stadium theme (src/render/theme.ts), picked on the Friendly screen's stadium row. */
  theme: ThemeId;
  /**
   * The menus' stadium moves (the orbit camera at the menus' rate); off, it is one held frame
   * (quality.ts sceneFps). No Settings row yet (Graphics, a later page): setMenuSceneAnimated.
   */
  menuSceneAnimated: boolean;
  /** The player's frame limit on top of the tier's (quality.ts FpsCap; 0 = none). No Settings row yet: setFpsCap. */
  fpsCap: FpsCap;
}

/**
 * Bar positions after each step of a quality switch (withLoading): renderer, views, the world's
 * bake or cache read, pipelines; then 1 as it fades.
 */
const QUALITY_STEPS = [0.15, 0.35, 0.6, 0.95, 1] as const;
/** The same for a stadium switch: uniforms, then the world's bake or cache read. */
const THEME_STEPS = [0.2, 0.95, 1] as const;
/** sessionStorage: a tier fallback's line across the reload after a lost device (Game.bootDone). */
const TIER_NOTICE_KEY = STORAGE_PREFIX + 'tierNotice';
/** Delay (ms) between the lost-device line on the loading screen and the reload (it can be read). */
const LOSS_RELOAD_DELAY_MS = 900;

/** "Your device does not support Ultra: using High" (en / es). */
function fallbackText(fb: Fallback): string {
  return t('quality.fallback', { from: t(`quality.${fb.from}`), to: t(`quality.${fb.to}`) });
}

/** The toast of an experimental store problem (experimentalStore.ts). */
function experimentalProblemText(p: ExperimentalProblem): string {
  switch (p) {
    case 'offline':
      return t('rules.offline');
    case 'too_many':
    case 'full':
      return t('rules.full', { max: MAX_PRESETS });
    case 'delete_offline':
      return t('rules.deleteOffline');
    default:
      return t('error.unexpected');
  }
}

/**
 * How long the bar takes to creep from one step's mark toward the next (ms): it eases most of the
 * way there and waits (LOADING_CREEP), so a long step never looks frozen and a short one jumps on.
 */
const LOADING_CREEP_MS = 2600;
const LOADING_CREEP = 0.85;

/**
 * What the Game needs from an online session to host it (OnlineSession and P2PSession both satisfy
 * it): the state machine flags, the match readouts for the HUD, the stats view for the network
 * panel, the per-frame advance and the lifecycle verbs.
 */
export interface GameSession {
  readonly kind: 'server' | 'p2p';
  readonly state: string;
  /** The session owns the loop and the roster (connecting, playing or just ended). */
  readonly active: boolean;
  /** Matchmaking / connecting: the menu shows statusText and Esc / B cancels. */
  readonly busy: boolean;
  /** A match is on screen and taking input. */
  readonly inMatch: boolean;
  /** Cars take no input (countdown, goal pause, after the whistle). */
  readonly frozen: boolean;
  readonly score: { readonly blue: number; readonly red: number };
  readonly overtime: boolean;
  readonly displaySeconds: number;
  readonly clockMode: ClockMode;
  /** Allocates a string: call only when displaySeconds / overtime changed. */
  formatClock(): string;
  readonly stats: NetStatsView;
  readonly statusText: string | null;
  readonly statusIsError: boolean;
  /** In-match hint ('Esperando a <name>…'), null when none. */
  readonly hint: string | null;
  /** Visual error offsets (uu) for the player's car and the ball (phase 1 rollback), null / absent otherwise. */
  readonly errorOffsetCar?: Float32Array | null;
  readonly errorOffsetBall?: Float32Array | null;
  readonly name: string;
  setName(name: string): void;
  /** Run the session's ticks for a frame of `dt` seconds; returns the interpolation alpha. */
  advance(dt: number): number;
  cancel(): void;
  leave(): void;
  dispose(): void;
}

export function isGameMode(v: unknown): v is GameMode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(MODES, v);
}

/**
 * Add the bots of `mode` next to an existing (blue, slot 0) player car: its `n - 1` blue
 * teammates first, then the `n` red cars, and return every id in creation order with the
 * player first — the roster order `GameOptions.carIds` / `Game.carIds` use. When the sim refuses
 * a car the cars added so far are removed again and the error is rethrown, so the arena is left
 * exactly as it was (the caller can fall back to a smaller mode).
 */
export function addRoster(sim: RocketSim, playerCarId: number, mode: GameMode): number[] {
  const n = MODES[mode];
  const ids: number[] = [playerCarId];
  try {
    for (let i = 1; i < n; i++) ids.push(sim.addCar(Team.Blue, CarPreset.Standard));
    for (let i = 0; i < n; i++) ids.push(sim.addCar(Team.Red, CarPreset.Standard));
  } catch (err) {
    for (let i = ids.length - 1; i >= 1; i--) sim.removeCar(ids[i]);
    throw err;
  }
  return ids;
}

const PREFS_KEY = STORAGE_PREFIX + 'prefs';
/** Longest frame the loop will try to catch up on (s); beyond this, time is dropped. */
const MAX_FRAME_DT = 0.1;
/** Ball prediction refresh cadence (ticks); a full re-prediction costs 1–5 ms after a touch. */
const BALL_PRED_EVERY = 4;
/** The same on tiers with `cpuLite` (super low): the bots read the prediction by its age, any cadence works. */
const BALL_PRED_EVERY_LITE = 8;
/** Seconds between two HUD boost / speed updates on tiers with `cpuLite` (10 Hz). */
const HUD_LITE_INTERVAL = 0.1;
/** Ball-hit effects are rate limited per car to this many ticks (dribbles touch every tick). */
const HIT_FX_MIN_TICKS = 6;
/** Minimum relative speed (uu/s) for a ball touch to produce a puff / sound. */
const HIT_FX_MIN_SPEED = 250;
/** Hard landing when the car fell faster than this (uu/s). */
const HARD_LANDING_VZ = 550;
/** Seconds the "GO" caption stays on screen. */
const GO_CAPTION_SECONDS = 0.8;
/** The music switches to its tension mode for the last seconds of regulation (and overtime). */
const MUSIC_TENSION_SECONDS = 30;
/** Seconds after the final whistle before the FINAL comes (plan §1.7: 2 s). */
const FINAL_SECONDS = 2;
const FPS_INTERVAL = 0.25;
/** Menu camera orbit (uu). */
const MENU_ORBIT_RADIUS = 3600;
const MENU_ORBIT_HEIGHT = 1500;
const MENU_ORBIT_RATE = 0.08;
/** Pad pickups within this distance (uu) of the player car play the pickup chime. */
const PAD_SOUND_DIST = 320;
/**
 * After a pause caused by the browser releasing the pointer lock (Esc), a KEYBOARD pause edge
 * arriving within this many seconds is dropped: some browsers deliver that Escape keydown too,
 * which would toggle the pause straight back. Both events come from the same key press, at most
 * one (MAX_FRAME_DT-clamped) frame apart, so the window is just over one such frame; pad Start is
 * never dropped.
 */
const UNLOCK_PAUSE_WINDOW = 0.12;
/** The in-match hint while mouse look is available but the pointer is not captured (built once: shown per frame). */
const POINTER_LOCK_HINT = t('game.pointerLockHint');
/**
 * Online: the wrapper's bump counter is not part of the state blob, so a bump inside a replayed
 * window is counted again on every rollback that covers it; bump sounds are spaced by this many
 * local ticks (longer than any replay window at LEAD_MAX) so one bump makes one sound.
 */
const BUMP_FX_MIN_TICKS_ONLINE = 40;

const ZERO_VEC: readonly [number, number, number] = [0, 0, 0];
/** The off-screen ball glyph is pinned this far inside the screen edge (fraction of NDC). */
const BALL_IND_INSET_X = 0.9;
const BALL_IND_INSET_Y = 0.86;
const RAD_TO_DEG = 180 / Math.PI;

const _ind = new THREE.Vector3();

/** Training result banner titles (the sub line names the shot). */
const TRAINING_RESULT_TITLE: Readonly<Record<ResultReason, string>> = {
  goal: t('game.goal'),
  save: t('game.trainingSave'),
  ownGoal: t('game.trainingOwnGoal'),
  conceded: t('game.trainingConceded'),
  timeout: t('game.trainingTimeUp'),
};

/** Team names for the banners and toasts: upper case in the titles ('BLUE WINS'), as written in the sub lines. */
const TEAM_NAME: readonly [string, string] = [t('game.teamBlueUpper'), t('game.teamRedUpper')];
const TEAM_LABEL: readonly [string, string] = [t('game.teamBlue'), t('game.teamRed')];

/** The scoreboard footer's difficulty value, built once (the scoreboard is refreshed every frame while held). */
const SCOREBOARD_DIFFICULTY: Readonly<Record<Difficulty, string>> = {
  easy: t('game.scoreboardEasy'),
  medium: t('game.scoreboardMedium'),
  hard: t('game.scoreboardHard'),
};
const SCOREBOARD_ONLINE = t('game.scoreboardOnline');
const SCOREBOARD_ONLINE_P2P = t('game.scoreboardOnlineP2p');

/** The client holds a guest session for its name: a queue needs no registration first (NetClient.ensureGuest). */
function guestReady(c: NetClient): boolean {
  return sessionValid(c.guest) && c.guest.name === c.name;
}

/** Read the saved difficulty / quality / mode / theme / scene pace (falls back to defaults when storage is unavailable). */
export function loadPrefs(): GamePrefs {
  const touch = hasCoarsePointer();
  const prefs: GamePrefs = { difficulty: 'medium', quality: touch ? 'low' : 'high', mode: '1v1', qualitySet: false, theme: DEFAULT_THEME, menuSceneAnimated: true, fpsCap: 0 };
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<Record<keyof GamePrefs, unknown>>;
      if (parsed.difficulty === 'easy' || parsed.difficulty === 'medium' || parsed.difficulty === 'hard') {
        prefs.difficulty = parsed.difficulty;
      }
      prefs.qualitySet = parsed.qualitySet === true;
      const quality = parseQuality(parsed.quality);
      if (quality !== null && (!touch || prefs.qualitySet)) prefs.quality = quality;
      if (isGameMode(parsed.mode)) prefs.mode = parsed.mode;
      prefs.theme = parseTheme(parsed.theme) ?? DEFAULT_THEME;
      prefs.menuSceneAnimated = parsed.menuSceneAnimated !== false;
      prefs.fpsCap = parseFpsCap(parsed.fpsCap);
    }
  } catch {
    /* private mode / storage disabled */
  }
  return prefs;
}

export function savePrefs(prefs: GamePrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

/**
 * Optional hook on the views: make the meshes that start hidden renderable (`on`), with ~zero
 * scale / opacity so nothing shows, for the pipeline warm-up (see Game.warmUp). Views without it
 * are skipped (CarView falls back to its public boostFlame).
 */
interface Warmable {
  setWarmUp?(on: boolean): void;
}

function zeroControls(c: CarControls): void {
  c.throttle = 0;
  c.steer = 0;
  c.pitch = 0;
  c.yaw = 0;
  c.roll = 0;
  c.jump = false;
  c.boost = false;
  c.handbrake = false;
}

/** A phone or tablet: the primary pointer is a finger (it starts on the light quality tier). */
function hasCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** The page's #overlay (the loading screen's element), created next to the HUD when the page has none. */
function overlayHost(hudContainer: HTMLElement): HTMLElement {
  const found = document.getElementById('overlay');
  if (found !== null) return found;
  const el = document.createElement('div');
  el.id = 'overlay';
  (hudContainer.parentElement ?? document.body).appendChild(el);
  return el;
}

/** Pointer lock only makes sense with a mouse / trackpad (touch devices never get the hint). */
function hasFinePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  try {
    return window.matchMedia('(pointer: fine)').matches;
  } catch {
    return true;
  }
}

export class Game implements P2PGameHooks {
  readonly sim: RocketSim;
  readonly renderer: Renderer;
  readonly input: Input;
  /** The red team's brain (every red slot). */
  readonly bots: BotTeam;
  /** The player's blue teammates' brain; it has no slots in 1v1 and is then never asked to think. */
  readonly mates: BotTeam;
  readonly match: Match;
  readonly hud: Hud;
  /** On-screen touch controls; null without a touch screen (no DOM, no listeners). Debug: window.__game.touch. */
  readonly touch: TouchControls | null;
  readonly audio: Audio;
  readonly chase: ChaseCamera;
  /** Live settings shared with Input (bindings, controls), ChaseCamera (camera) and the Hud. */
  readonly settings: Settings;
  /** The human's car id. Offline it never changes; an online roster (applyOnlineRoster) replaces it. */
  playerCarId: number;
  /** Cars per team; changes only through setMode() (menu). */
  mode: GameMode;
  /**
   * Roster: car ids in creation order (player, blue teammates, red cars) and the sim slot /
   * buffer offset of each. Mutated in place by setMode() (the arrays keep their identity).
   * Online the roster is the host's (slot order) and the player can be at any index.
   */
  readonly carIds: number[] = [];
  readonly carSlots: number[] = [];
  private readonly carOffsets: number[] = [];
  playerSlot = 0;
  /** Roster index of the player's car (0 offline, the welcome slot online): cars[], controls[]. */
  playerIndex = 0;
  /**
   * Online mode (phase 1, server host). Constructed with the game and idle until the menu's ONLINE:
   * no network traffic at boot. null disables that entry (setOnlineSession). Debug: window.__game.online.
   */
  online: OnlineSession | null = null;
  /** Online mode (phase 2, P2P mesh); shares the guest client with `online`. Debug: window.__game.p2p. */
  p2p: P2PSession | null = null;
  /** The session currently hosted by the loop (setSession); null = offline. */
  session: GameSession | null = null;
  /** Training (free play or a shot pack: startTraining / stopTraining), null otherwise. Debug: window.__game.training. */
  training: TrainingSession | null = null;
  /** Free play: unlimited boost (trainingBoost toggles it; ON at every free play start, OFF in packs). */
  trainingUnlimitedBoost = true;
  /**
   * Experimental free play's rules (the preset picked on the training screen, or later in the pause
   * menu's RULES), null in plain free play and in packs. Debug: window.__game.freePlayRules.
   */
  freePlayRules: { readonly id: string; readonly name: string; readonly values: Readonly<PhysicsValues> } | null = null;
  /** The physics the training arena was built with (experimentalTraining.ts: packs rebuild a non-stock one). */
  private trainingArenaFp = STOCK_ARENA_FINGERPRINT;
  /** Experimental free play's game speed (the accumulator's factor; 1 everywhere else). */
  private trainingSpeed = 1;

  /** Interpolation snapshots (full state buffers). */
  readonly prev = new Float32Array(STATE_BUFFER_FLOATS);
  readonly cur = new Float32Array(STATE_BUFFER_FLOATS);

  /** Debug access to the views (rebuilt on quality change). */
  arena!: ArenaView;
  cars: CarView[] = [];
  ball!: BallView;
  effects!: Effects;

  paused = false;
  /** The loading screen: the boot's, then every long load (withLoading). */
  readonly loading: LoadingOverlay;
  quality: Quality;
  /** Stadium theme (GamePrefs.theme): the views read it when they are built (setTheme). */
  theme: ThemeId;
  /** The player picked the quality in the menu (GamePrefs.qualitySet). */
  private qualitySet: boolean;
  /** The prefs' tier (GameOptions.savedQuality): the player's pick, never the tier the device fell to. */
  private savedQuality: Quality;
  /** The tier's CPU trims (TierSpec.cpuLite), fixed for the session (super low reloads to change). */
  private readonly cpuLite: boolean;
  /** Ticks between ball prediction refreshes (BALL_PRED_EVERY, or _LITE on cpuLite). */
  private readonly predEvery: number;
  /** rAF time (ms) of the last drawn frame (the scene's rate skips the others: frame), -1 = none. */
  private lastDrawAt = -1;
  /** rAF time (ms) of the last frame that ran the game's logic (a match's frames under its cap do nothing), -1 = none. */
  private lastLogicAt = -1;
  /** The deadlines of the player's frame limit in a match (logic) and of the scene's paced rates (quality.ts FramePacer). */
  private readonly logicPace = new FramePacer();
  private readonly scenePace = new FramePacer();
  /** Loop seconds since the last drawn frame (the views' dt when it is drawn); 0 while the frame is held. */
  private drawAcc = 0;
  /** The menus' orbit clock (s): it runs on drawn menu frames only, so a held frame resumes where it stopped. */
  private orbitTime = 0;
  /** The last frame's pace (sceneFps, cover, menus, still): a change draws one frame. */
  private sceneKey = -1;
  /** Something under a held or paced frame changed (the canvas size, rebuilt views, the end of a load, a visible tab): draw the next frame. */
  private redraw = true;
  /** What the menus leave of the scene (setMenuCover) and the share of a touch screen they hide. */
  private menuCover: SceneCover = 'none';
  private menuCovered = 0;
  /** A coarse primary pointer (phones, tablets): menus that hide most of the screen draw the scene at 20 fps (sceneFps). */
  private readonly coarse: boolean;
  /** prefers-reduced-motion, followed live: the menus' stadium holds still (one held frame). */
  private reduceMotion = false;
  /** GamePrefs.menuSceneAnimated and fpsCap (setMenuSceneAnimated / setFpsCap). */
  private menuSceneAnimated: boolean;
  private fpsCap: FpsCap;
  /** Loop time of the last HUD boost / speed update (cpuLite: 10 Hz). */
  private hudAt = -1;
  /** The super low online notice was shown this session. */
  private liteOnlineNoticed = false;
  /**
   * A tier picked in an online match that needs a reload (into or out of super low): the reload
   * would leave the match (an abandon), so it waits for the menus (showMenu); null when none.
   */
  private pendingRestart: Quality | null = null;
  difficulty: Difficulty;
  /** Smoothed drawn frames per second (updated 4x/s). */
  fps = 0;
  /** Sim ticks since start. */
  ticks = 0;

  private readonly arenaMesh: ArenaMesh;
  private readonly info: string;
  private readonly canvas: HTMLCanvasElement | null;
  private readonly canPointerLock: boolean;
  /** One CarControls per roster entry, preallocated for MAX_CARS; entry playerIndex is the player's. */
  private readonly controls: CarControls[] = [];
  private playerControls: CarControls;
  /** Local tick of the last bump sound online (see BUMP_FX_MIN_TICKS_ONLINE). */
  private lastBumpFxTick = -1e9;
  /** The bot slots of each team and, in the same order, the controls they write (views into `controls`). */
  private readonly redSlots: number[] = [];
  private readonly redOuts: CarControls[] = [];
  private readonly blueSlots: number[] = [];
  private readonly blueOuts: CarControls[] = [];
  private playerOff = CARS_OFFSET;
  private readonly lastHitTick = new Float32Array(MAX_CARS).fill(-1e9);
  private readonly hitPos: [number, number, number] = [0, 0, 0];
  private readonly camState: CameraCarState = { grounded: true, speed: 0, supersonic: false };
  private readonly audioState: AudioState = { speed: 0, forwardSpeed: 0, boosting: false, supersonic: false, grounded: true, throttle: 0 };
  /** The match clock is in its last MUSIC_TENSION_SECONDS or in overtime (set with the HUD clock). */
  private musicTension = false;
  private readonly menuLook = new THREE.Vector3(0, 200, 0);
  /** One row per roster entry ('You', 'Bot 1'...), rebuilt by applyRoster(); the Hud diffs them. */
  private readonly sbRows: ScoreboardRow[] = [];
  /** Reused by the Tab scoreboard; `clock` is rebuilt only when the displayed second changes. */
  private readonly scoreboardData: ScoreboardData = { blue: 0, red: 0, clock: formatClockSeconds(DEFAULT_MATCH_SECONDS), difficulty: SCOREBOARD_DIFFICULTY.medium, mode: '1v1', rows: this.sbRows };
  private sbClockSec = -1;
  private sbClockOvertime = false;
  /** Loop time at which losing the pointer lock paused the game (see UNLOCK_PAUSE_WINDOW). */
  private unlockPausedAt = -1e9;

  private raf = 0;
  private running = false;
  private lastTime = -1;
  private acc = 0;
  private alpha = 0;
  private time = 0;
  private snapCamera = true;
  private goCaptionUntil = -1;
  /** When the FINAL comes (performance.now() seconds: the wall clock, so a slow frame never holds it back), -1 none. */
  private menuReturnAt = -1;
  /** The front-end menus (src/ui): home, play, casual / ranked / custom / friendly, training, profile. */
  readonly menu: Menu;
  /** Registered accounts (ranked, profile); the guest flow stays in NetClient. */
  readonly accounts: AccountClient;
  /** Training records: this browser for a guest, the account (server + local copy) when signed in. */
  readonly trainingStore: TrainingStore;
  /** Settings > Experimental: the account's switch and physics presets (server + local copy); nothing for a guest. */
  readonly experimental: ExperimentalStore;
  /** The account whose experimental state was pulled this page (one sync per sign-in), null = none yet. */
  private experimentalSyncedFor: string | null = null;
  /** The boot gated a saved super low pick (GameOptions.superlowLocked): told once the menus are up. */
  private readonly superlowLockedAtBoot: boolean;
  /** Lines for the menus' next toast while a screen covers them (the settings screen, a match). */
  private readonly pendingNotices: string[] = [];
  /** Custom lobbies (the lobby socket lives across the lobby's matches). */
  readonly lobby: LobbyClient;
  /** The rating change of each finished ranked match, held while the menus are away (showMenu). */
  private readonly rankedResults: RankedResults;
  /** The menu search in progress (banner): its kind, playlists and start time. */
  private searchReq: SearchRequest | null = null;
  private searchSince = 0;
  /** Search practice: free play over the search ('practice'), or its match found and on its way ('entering'). */
  private searchPractice: 'off' | 'practice' | 'entering' = 'off';
  /** The last match's result, shown as a toast when the menu comes back (null = none). */
  private lastResult: { winner: 0 | 1 | null; blue: number; red: number } | null = null;
  /** A message for that toast instead of the score (a disconnect reason...), or alone without a result. */
  private menuNotice: string | undefined;
  /** The FINAL (the menus' 'final' screen, registered here) and the match it shows, null before a match ended. */
  private finalUi: FinalScreen | null = null;
  private finalView: FinalView | null = null;
  /** Goals of each car this match (finalModel.ts goalScorer: the scoring team's last toucher of the play). */
  private readonly goals = new Uint8Array(MAX_CARS);
  /** The state buffer's tick at the play's GO: a touch before it scored nothing of this play. */
  private playFrom = 0;
  /** What kind of match is on (what the FINAL's PLAY AGAIN repeats). */
  private matchKind: FinalKind = 'ai';
  /** The player's demolitions this match (the feed's DEMOLISHED · n). */
  private demos = 0;
  /** The session's state on the last frame: 'queue' -> anything but idle is a match found (matchFound). */
  private sessionStateWas = '';
  /** PARTIDO ENCONTRADO (z 45, over the menus and the match alike). */
  private readonly found: MatchFound;
  /** A Competitive match cancelled before its start (a no-show, a dodge): the search starts again, with why. */
  private requeue: { req: SearchRequest; text: string } | null = null;
  private fpsFrames = 0;
  private fpsWindowStart = 0;
  private gestureListening = false;
  /** (orientation: portrait) on a phone; touch screens only (the rotate-screen pause in render). */
  private readonly portraitQuery: MediaQueryList | null;
  /** The iPhone's add-to-home-screen toast is still due (touch screens only, see updateInstallHint). */
  private installHint: boolean;
  /** Frames left that render the normally hidden meshes so their pipelines compile (see warmUp). */
  private warmFrames = 0;
  /**
   * A menu search switched the roster while its guest registers (a new player's first queue: POST
   * /api/guest, then the queue): the scene holds its frame until that answer (heldForGuest). The
   * new cars' first frame compiles their pipelines (seconds on a weak GPU, and over Inicio's live
   * stadium it comes at once): it would hold the answer back, and with it the queue request. It
   * runs during the queue's wait instead.
   */
  private holdForGuest = false;
  /** A warm-up behind the loading screen: the ball casts its shadow whatever the stadium (applyBallShadow). */
  private warmBallShadow = false;
  /** A load runs behind the loading screen (withLoading): the loop neither renders nor reads input. */
  private loadingHold = false;
  /** Loads run one at a time: the next one starts when this settles. */
  private loadingChain: Promise<void> = Promise.resolve();
  /** The quality safety net (tierGuard.ts): a tier that breaks on this GPU falls back one tier. */
  private readonly tierGuard = new TierGuard(() => performance.now());
  /** A tier fallback's line, for the menus' next toast when they are not on screen (null = none). */
  private tierNotice: string | null = null;
  /** Every tier switch counts here: a pending ceiling check (confirmTier) belongs to the latest one only. */
  private tierSwitches = 0;
  private confirmTimer = 0;
  /** performance.now() when the page was last visible after being hidden (Infinity while hidden): a lost device right after is the background's. */
  private visibleSince = Number.NEGATIVE_INFINITY;
  /** The settings screen is open over the pause menu (openPauseSettings). */
  private pauseSettingsOpen = false;
  /** System Back as one step inside the game (onSystemBack); null without a history (a node test). */
  private readonly backGuard: BackGuard | null;
  /** The beforeunload backstop is listening (a match under way: updateLeaveGuard). */
  private leaveGuarded = false;
  /** When the controls card shows (the first matches, free play) and what it lists (built on a change). */
  private readonly controlsCard = new ControlsCardPlan(localCardSeen);
  private controlsContent: ControlsCardContent | null = null;
  private controlsDevice: Device | null = null;
  private controlsMatch = -1;
  /** Input.gamepadPresses last seen: a controller press arms the Back guard (it carries no user activation). */
  private padPressesSeen = 0;
  /** The last input used and the TV class (src/ui/device.ts: html.tg-tv, data-input); null in a node test. */
  private readonly device: DeviceTracker | null;
  /** While true (goal pause / after the final whistle) the ball is held at pinPos.xy each tick. */
  private ballPinned = false;
  private readonly pinPos: [number, number, number] = [0, 0, 0];
  private readonly pinVel: [number, number, number] = [0, 0, 0];
  /** Training overlay, built on the first startTraining. */
  private trainingHud: TrainingHud | null = null;
  /** Ball sample handed to the TrainingSession every training tick (refilled in place). */
  private readonly trainingBall: TrainingBallSample = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  private readonly trainingYpr: [number, number, number] = [0, 0, 0];
  /** Which device the training key hints were built for (null = rebuild). */
  private trainingHintsPad: boolean | null = null;
  /** The TrainingSession's view of the Game (sim placement, banners, summary). */
  private readonly trainingHooks: TrainingHooks = {
    placeShot: (shot) => this.trainingPlaceShot(shot),
    releaseShot: (shot) => this.trainingReleaseShot(shot),
    shotResult: (index, pass, reason) => this.trainingShotResult(index, pass, reason),
    packSummary: (summary) => this.trainingPackSummary(summary),
    freeplayGoal: () => this.trainingFreeplayGoal(),
    freeplayReset: (car, ball) => this.trainingFreeplayReset(car, ball),
  };

  private readonly onVisibility = (): void => {
    this.visibleSince = document.hidden ? Number.POSITIVE_INFINITY : performance.now();
    // A background tab may lose the canvas' last frame: a held one is drawn again.
    if (!document.hidden) this.redraw = true;
    if (document.hidden && !this.menuShown && !this.paused) this.setPaused(true);
  };

  /** Focus lost: the browser drops the pointer lock itself, but make it explicit (and immediate). */
  private readonly onBlur = (): void => {
    this.input.exitPointerLock();
  };

  /**
   * Mouse look: a mouse click on the canvas while a match is being played captures the mouse.
   * A click / tap on the paused game resumes it first (resume and recapture in one action).
   * The HUD overlay is a sibling of the canvas, so clicks on PLAY or the menu never get here.
   */
  private readonly onCanvasPointerDown = (e: PointerEvent): void => {
    // A finger / pen on a touch screen: no compatibility mousedown, which Input would read as a
    // click (a boost tick on resume). Without a touch screen a pen keeps acting as a mouse.
    if (this.touch !== null && e.pointerType !== 'mouse') e.preventDefault();
    if (this.canResumeByPointer) this.setPaused(false);
    if (e.pointerType !== 'mouse' || this.canvas === null || !this.canPointerLock) return;
    if (!this.playing || this.input.pointerLocked) return;
    // The button of this click is masked by Input until released: it is not a boost / jump.
    this.input.requestPointerLock(this.canvas, e.button);
  };

  /**
   * Audio unlock, retried on every gesture until the context actually runs. The first attempt can
   * fail silently: Escape, a bare modifier key (Shift = boost), a touch pointerdown and gamepad
   * input carry no user activation, and Chrome then leaves the context suspended with the resume
   * promise pending forever, so there is nothing to await; the listeners simply stay installed.
   */
  private readonly onGesture = (): void => {
    if (this.audio.running) {
      this.removeGestureListeners();
      return;
    }
    this.audio.resume();
  };

  /**
   * A mouse press on the touch controls (a touch laptop with them up): they cover the canvas, so
   * it is the canvas click that captures the mouse (and masks its button). Touch mode is already
   * off by then (TouchControls listens on window, capture phase). Fingers are not forwarded: one
   * landing in the frame after a PAUSE tap, before the controls hide, would resume the game.
   */
  private readonly onTouchLayerPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') this.onCanvasPointerDown(e);
  };

  /**
   * Fullscreen left (Android's back gesture) while a match is played in touch mode: pause, like a
   * hidden tab (the viewport changes under the thumbs). The RESUME tap goes fullscreen again.
   */
  private readonly onFullscreenChange = (): void => {
    if (document.fullscreenElement != null || this.touch === null || !this.touch.touchMode) return;
    if (this.playing) this.setPaused(true);
  };

  constructor(opts: GameOptions) {
    this.sim = opts.sim;
    this.renderer = opts.renderer;
    this.arenaMesh = opts.arenaMesh;
    this.playerCarId = opts.playerCarId;
    this.mode = opts.mode ?? '1v1';
    this.quality = opts.renderer.quality;
    this.theme = opts.renderer.theme;
    this.difficulty = opts.difficulty ?? 'medium';
    this.qualitySet = opts.qualitySet ?? false;
    this.savedQuality = opts.savedQuality ?? this.quality;
    this.superlowLockedAtBoot = opts.superlowLocked === true;
    this.menuSceneAnimated = opts.menuSceneAnimated !== false;
    this.fpsCap = parseFpsCap(opts.fpsCap);
    this.coarse = hasCoarsePointer();
    this.cpuLite = opts.renderer.spec.cpuLite;
    this.predEvery = this.cpuLite ? BALL_PRED_EVERY_LITE : BALL_PRED_EVERY;
    // Super low: the stylesheet's light HUD (no blur, shadows or decorative animation).
    if (typeof document !== 'undefined') document.documentElement.classList.toggle('tg-superlow', this.cpuLite);
    // `#diag`: the frame and CPU figures (frameStats.ts), and where to read the wasm memory.
    if (pageFlags().diag) {
      enableDiagStats();
      // Read through a cast, not a bridge getter: RocketSimBridge.ts ships in the community nodes'
      // bundle, and any change to it needs a signed node release before a deploy.
      const wasm = this.sim as unknown as { readonly memory: WebAssembly.Memory };
      diagSources.wasmBytes = () => wasm.memory.buffer.byteLength;
    }
    this.info = opts.info ?? '';

    const sim = this.sim;
    for (let i = 0; i < MAX_CARS; i++) this.controls.push(emptyControls());
    this.playerControls = this.controls[0];
    this.bots = new BotTeam({ team: Team.Red, difficulty: this.difficulty });
    this.mates = new BotTeam({ team: Team.Blue, difficulty: this.difficulty, seed: 777 });
    let ids: readonly number[];
    if (opts.carIds !== undefined) ids = opts.carIds;
    else if (opts.botCarId !== undefined) ids = [opts.playerCarId, opts.botCarId];
    else throw new Error('Game: carIds (or botCarId for 1v1) is required');
    if (ids.length !== MODES[this.mode] * 2) throw new Error(`Game: ${this.mode} needs ${MODES[this.mode] * 2} car ids, got ${ids.length}`);
    this.applyRoster(ids);

    const settings = opts.settings ?? loadSettings();
    this.settings = settings;
    this.canvas = opts.canvas !== undefined ? opts.canvas : (document.getElementById('game-canvas') as HTMLCanvasElement | null);
    this.canPointerLock = this.canvas !== null && typeof this.canvas.requestPointerLock === 'function' && hasFinePointer();

    // The chase camera keeps settings.camera BY REFERENCE: the HUD sliders apply on the next frame.
    this.chase = new ChaseCamera(settings.camera);
    // Input mutates settings.bindings / settings.controls in place (settings screen) and reports it.
    this.input = new Input(window, settings, { onChange: () => this.applySettings() });
    this.input.onPointerLockChange = (locked) => this.onPointerLock(locked);
    sim.setCarDodgeDeadzone(this.playerCarId, settings.controls.dodgeDeadzone);
    this.match = new Match({ lengthSeconds: opts.matchLengthSeconds ?? DEFAULT_MATCH_SECONDS });
    this.hud = new Hud(opts.hudContainer);
    this.loading = opts.loading ?? new LoadingOverlay(overlayHost(opts.hudContainer));
    // Touch screens only: the controls layer goes right after the Hud root and drives Input like a keyboard.
    this.touch = hasTouchScreen() ? new TouchControls(this.hud.root, { kbm: () => settings.bindings.kbm }) : null;
    if (this.touch !== null) this.input.setTouchSource(this.touch.state);
    this.portraitQuery = this.touch !== null && typeof window.matchMedia === 'function' ? window.matchMedia('(orientation: portrait) and (pointer: coarse) and (max-width: 599px)') : null;
    this.installHint = this.touch !== null && installHintDue();
    // The menus' stadium holds still under prefers-reduced-motion (sceneFps), followed live; a
    // resize clears the canvas, so a held frame is drawn again.
    const motion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (motion !== null) {
      this.reduceMotion = motion.matches;
      motion.addEventListener('change', () => {
        this.reduceMotion = motion.matches;
      });
    }
    this.renderer.onResize = () => {
      this.redraw = true;
    };
    this.audio = new Audio({ room: !this.cpuLite });
    this.audio.setVolume(settings.audio.volume / 100);
    this.audio.setMusicVolume(settings.audio.music / 100);

    // Initial snapshots so the first frame renders the kickoff state.
    sim.sync();
    this.cur.set(sim.buf);
    this.prev.set(this.cur);

    this.buildViews(this.quality);

    sim.events.onGoal = (team) => this.onSimGoal(team);
    sim.events.onBump = (bumper, victim, isDemo) => this.onSimBump(bumper, victim, isDemo);
    sim.events.onBallHit = (carId, relSpeed) => this.onSimBallHit(carId, relSpeed);

    // Online sessions: only the stored guest name is read now; the network is touched on ONLINE.
    const online = new OnlineSession(this);
    this.online = online;
    this.p2p = new P2PSession(this, {
      client: online.client,
      engineFactory: (p2pSim, numSlots, humanSlots, localSlot, hooks, opts) => new RollbackEngine(p2pSim, numSlots, humanSlots, localSlot, hooks, opts),
    });

    // Accounts: a signed-in player queues / joins lobbies under the account (NetClient asks first).
    const accounts = new AccountClient({ antiBot: () => online.client.antiBotToken() });
    this.accounts = accounts;
    online.client.sessionProvider = (minValidMs) => accounts.sessionForQueue(minValidMs);
    online.client.onSessionRejected = () => accounts.sessionRejected();
    this.trainingStore = new TrainingStore({ accountId: () => accounts.account?.playerId ?? null, push: (r) => accounts.pushTraining(r) });
    this.experimental = new ExperimentalStore({
      accountId: () => accounts.account?.playerId ?? null,
      fetch: () => accounts.fetchExperimental(),
      setEnabled: (on) => accounts.setExperimental(on),
      upsert: (p) => accounts.upsertPreset(p),
      remove: (id) => accounts.deletePreset(id),
    });
    this.lobby = new LobbyClient({ bearer: async () => (await online.client.ensureGuest()).session });
    this.menu = createMenu(this.menuHost(), opts.hudContainer);
    this.menu.register('final', (m) => (this.finalUi = finalScreen(m, { finalView: () => this.finalView })));
    installFinalSample(this.menu);
    this.found = new MatchFound(opts.hudContainer);
    this.backGuard = typeof window !== 'undefined' && typeof history !== 'undefined' ? new BackGuard(window, () => this.onSystemBack()) : null;
    this.device = typeof window !== 'undefined' && typeof document !== 'undefined' ? installDevice({ tvFlag: pageFlags().tv, padConnected: () => this.input.hasGamepad }) : null;
    this.rankedResults = new RankedResults({ accounts, menu: this.menu, onScreen: () => this.menu.visible && !this.hud.menuVisible && !this.onlineActive });
    accounts.subscribe(() => this.onAccountChange());
    this.experimental.subscribe(() => this.onExperimentalChange());
    this.experimental.onProblem = (p) => this.notify(experimentalProblemText(p));
    this.restoreAccount();

    (window as unknown as { __game: Game }).__game = this;
  }

  /**
   * Bring back the signed-in account (refresh cookie) on page load: when this browser was signed in
   * before, or when the URL carries an OAuth result (#auth=...), which is then shown and cleared.
   */
  private restoreAccount(): void {
    const hash = typeof location !== 'undefined' ? location.hash : '';
    const auth = parseAuthHash(hash);
    if (auth !== null) history.replaceState(null, '', location.pathname + location.search);
    if (auth === null && this.accounts.hintName === null) return;
    void this.accounts.restore().then((a) => {
      if (auth === null) return;
      if (auth.kind === 'error') this.menu.toast(oauthErrorText(auth.code), 'error');
      else if (a !== null) {
        this.menu.toast(auth.kind === 'new' ? t('game.welcomeNew', { name: a.name }) : auth.kind === 'linked' ? t('game.accountLinked') : t('profile.hello', { name: a.name }), 'ok');
        if (auth.kind === 'new') this.menu.open('profile');
      }
      void this.accounts.fetchMe().catch(() => undefined);
    });
  }

  // ---- experimental features (Settings > Experimental) -----------------------------------------

  /**
   * A signed-in player with Settings > Experimental's switch on: Super low is listed in Graphics,
   * the preset editor and experimental free play are there (and, later, lobby rules). Guests are
   * never unlocked.
   */
  get experimentalUnlocked(): boolean {
    return this.accounts.signedIn && this.experimental.enabled();
  }

  /**
   * An account change (sign-in / out, a refresh, a profile answer): MeInfo's switch, one pull of
   * the account's experimental state per sign-in, then the same checks as a switch change.
   */
  private onAccountChange(): void {
    const id = this.accounts.account?.playerId ?? null;
    const me = this.accounts.me;
    if (id !== null && me !== null && me.playerId === id && typeof me.experimental === 'boolean') this.experimental.noteServerEnabled(me.experimental);
    if (id !== this.experimentalSyncedFor) {
      this.experimentalSyncedFor = id;
      if (id !== null) void this.experimental.sync();
    }
    this.onExperimentalChange();
  }

  /**
   * The experimental state changed: the Super low lock, experimental free play when the player is
   * no longer unlocked (signed out, the switch off on another device: stock physics at once; while
   * the settings screen is open over it, when that closes), and the settings screen when it is open.
   */
  private onExperimentalChange(): void {
    this.checkTierLock();
    if (this.freePlayRules !== null && !this.experimentalUnlocked && !this.pauseSettingsOpen && this.applyFreePlayRules() && this.hud.pauseMenuVisible) {
      this.hud.setPaused(true, this.pauseEntries(), this.pauseHint(), this.onlineActive); // RULES goes
    }
    this.hud.refreshSettings(this.settingsOptions());
  }

  /**
   * Super low is a pick for unlocked players only. When this player can no longer pick it (signed
   * out, a failed refresh, another account, the switch off here or on another device) a saved
   * super low pick turns into Performance, not chosen (bootTier.ts tierPrefsAfter 'lock'), saved
   * now and used from the next start; nothing reloads, and a pick into super low waiting for the
   * online match to end is dropped. A device that runs super low on its own keeps it.
   */
  private checkTierLock(): void {
    if (this.experimentalUnlocked) return;
    if (this.pendingRestart === 'superlow') {
      this.pendingRestart = null;
      this.hud.setQualityPending(null);
    }
    if (!this.qualitySet || this.savedQuality !== 'superlow') return;
    const prefs = tierPrefsAfter({ quality: this.savedQuality, qualitySet: this.qualitySet }, { kind: 'lock' });
    this.qualitySet = prefs.qualitySet;
    this.savedQuality = prefs.quality;
    this.persistPrefs();
    this.notify(t('quality.superlowLocked'));
  }

  /**
   * The switch from Settings > Experimental (the page asked twice when this restarts). Off while
   * the player's own pick is super low: Performance first (a reload, quality.ts needsReload, or a
   * wait for the end of an online match), so the lock has nothing left to say; a pick into super
   * low still waiting for the online match is simply dropped.
   */
  private setExperimentalEnabled(on: boolean): void {
    if (!this.accounts.signedIn) return;
    if (!on) {
      if (this.pendingRestart === 'superlow') void this.switchQuality(this.quality);
      else if (this.qualitySet && this.savedQuality === 'superlow') void this.switchQuality('low');
    }
    this.experimental.setEnabled(on);
  }

  /** Turning the switch off restarts the game: the player's own pick is super low (not one waiting for an online match). */
  private experimentalOffRestarts(): boolean {
    return this.qualitySet && this.savedQuality === 'superlow' && this.pendingRestart === null;
  }

  private superlowStatus(): SuperlowStatus {
    if ((this.qualitySet && this.savedQuality === 'superlow') || this.pendingRestart === 'superlow') return 'chosen';
    return this.quality === 'superlow' ? 'auto' : 'listed';
  }

  /**
   * Settings > Experimental: the switch and, for a signed-in player, the preset editor. In
   * experimental free play the editor's pick is free play's rules ('training': applied when the
   * screen closes, openPauseSettings). In an experimental P2P room ('match') the page shows the
   * room's rules as one read-only line instead of the editor: they are the room's, fixed for its
   * life, and nothing on this screen can change the arena of a match.
   */
  private experimentalOptions(): ExperimentalOptions {
    const p2p = this.p2p;
    const room = p2p !== null && this.session === p2p && p2p.active ? p2p.rules : null;
    const context: ExperimentalContext = room !== null ? 'match' : this.training !== null && this.freePlayRules !== null ? 'training' : 'menu';
    return {
      state: () => ({
        available: this.accounts.signedIn,
        enabled: this.experimental.enabled(),
        offRestarts: this.experimentalOffRestarts(),
        superlow: this.superlowStatus(),
      }),
      setEnabled: (on) => this.setExperimentalEnabled(on),
      onOpen: () => {
        if (this.accounts.signedIn) void this.experimental.sync();
      },
      presets: this.accounts.signedIn ? this.experimental : undefined,
      context,
      matchRules: room !== null ? t('custom.rulesInfo', { summary: lobbyRulesLine(room) }) : undefined,
    };
  }

  /** A line for the player: a menu toast now, or once the screen covering the menus is gone (flushNotices). */
  private notify(text: string): void {
    if (this.menu.visible && !this.hud.menuVisible) this.menu.toast(text, 'info');
    else if (!this.pendingNotices.includes(text)) this.pendingNotices.push(text);
  }

  private flushNotices(): void {
    if (!this.menu.visible || this.hud.menuVisible) return;
    for (const text of this.pendingNotices.splice(0)) this.menu.toast(text, 'info');
  }

  /** The settings screen was left (its BACK): pending preset edits go up, held lines show. */
  private settingsClosed(): void {
    void this.experimental.flush();
    this.flushNotices();
  }

  // ---- menus (src/ui) --------------------------------------------------------------------

  /**
   * A menu layer replaces the game: the front-end menus or the Hud's settings screen over them. The
   * settings screen opened from the pause menu does not count: the game stays paused under it, on
   * its chase camera.
   */
  get menuShown(): boolean {
    return this.menu.visible || (this.hud.menuVisible && !this.pauseSettingsOpen);
  }

  /**
   * What the menus leave of the scene (src/ui/Menu.ts, through MenuHost): 'partial' while they are
   * up with the stadium showing through (`covered`: the share of a touch screen they hide,
   * src/ui/cover.ts), 'opaque' under a sheet or over their own opaque page (super low), 'none' once
   * hidden. The loop draws the scene at
   * the menus' rate or holds one frame (quality.ts sceneFps, `frame`).
   */
  setMenuCover(level: SceneCover, covered = 0): void {
    this.menuCover = level;
    this.menuCovered = covered;
  }

  /** The player's frame limit on top of the tier's (GamePrefs.fpsCap; its Settings row comes later), saved. */
  setFpsCap(cap: FpsCap): void {
    this.fpsCap = parseFpsCap(cap);
    this.persistPrefs();
  }

  /** Whether the menus' stadium moves (GamePrefs.menuSceneAnimated; its Settings row comes later), saved. */
  setMenuSceneAnimated(on: boolean): void {
    this.menuSceneAnimated = on;
    this.persistPrefs();
  }

  /**
   * The rotate-your-phone screen is up (src/input/touch.css: touch mode, a phone held upright, and
   * no menus: they work upright, only a match asks to turn the phone): it hides everything.
   */
  private get rotateShown(): boolean {
    const q = this.portraitQuery;
    return this.touch !== null && this.touch.touchMode && !this.menu.visible && q !== null && q.matches;
  }

  /**
   * What lies over the scene (quality.ts sceneFps): the settings screen (over the menus or the
   * pause) and the rotate-your-phone screen hide it; else what the menus reported while they are up.
   */
  private sceneCover(): SceneCover {
    if (this.hud.menuVisible || this.rotateShown) return 'opaque';
    return this.menu.visible ? this.menuCover : 'none';
  }

  private hideMenus(): void {
    this.menu.hide();
    this.hud.hideMenu();
    // A Turnstile widget left from the menus (a lobby join, a sign-up) cannot be solved in a match.
    if (this.online !== null) this.online.client.cancelChallenge();
  }

  private menuHost(): MenuHost {
    const game = this;
    const net = this.online !== null ? this.online.client : null;
    return {
      get accounts() {
        return game.accounts;
      },
      get lobby() {
        return game.lobby;
      },
      get training() {
        return game.trainingStore;
      },
      experimental: {
        get unlocked() {
          return game.experimentalUnlocked;
        },
        get store() {
          return game.experimental;
        },
      },
      config: async (): Promise<MenuConfig> => {
        if (net === null) return { regions: REGIONS, autoRegion: '', oauth: [], online: false, botFillMs: null };
        const c = await net.config();
        return { regions: REGIONS, autoRegion: c.autoRegion ?? '', oauth: c.oauth ?? [], online: true, botFillMs: c.botFillMs ?? null };
      },
      guestName: () => (game.online !== null ? game.online.name : t('game.guestName')),
      setGuestName: (name) => {
        if (game.online !== null) game.online.setName(name);
        if (game.p2p !== null) game.p2p.setName(name);
      },
      bearer: async () => {
        if (net === null) throw new Error('offline');
        return (await net.ensureGuest()).session;
      },
      get mode() {
        return game.mode;
      },
      get difficulty() {
        return game.difficulty;
      },
      get theme() {
        return game.theme;
      },
      setTheme: (id) => void game.switchTheme(id),
      playFriendly: (mode, difficulty) => {
        if (game.session !== null && game.session.busy) game.session.cancel();
        game.setDifficulty(difficulty);
        game.setMode(mode);
        game.lastResult = null;
        game.menuNotice = undefined;
        game.startMatch();
      },
      startTraining: (id, opts) => {
        if (game.session !== null && game.session.busy) game.session.cancel();
        game.startTraining(id, opts);
      },
      search: (req) => game.menuSearch(req),
      cancelSearch: () => {
        if (game.session !== null && game.session.busy) game.session.cancel();
        game.searchReq = null;
      },
      searchView: () => game.menuSearchView(),
      practiceWhileSearching: () => game.startSearchPractice(),
      playLobbyMatch: (r) => game.playLobbyMatch(r),
      openSettings: (onClose, opts) => game.openSettingsScreen(onClose, opts?.tab),
      confirmLeave: (systemBack) => game.confirmLeave(systemBack === true),
      keyLabel: (action, device) => game.input.getLabel(action, device),
      setMenuCover: (level, covered) => game.setMenuCover(level, covered),
      get info() {
        return game.info;
      },
      padConnected: () => game.input.hasGamepad,
      // Keyboard only: its preset, saved as Settings › Controls saves it (Input calls applySettings).
      // Only a player with the default bindings is ever asked, so nothing of their own is lost.
      setControlScheme: (s) => {
        if (s === 'keyboard') game.input.applyPreset('kbm', 'keyboardOnly');
      },
      // Polled now: a controller that just connected is in no frame's snapshot yet (beginFrame).
      latchInput: () => {
        game.input.beginFrame();
        game.input.latchEdges();
      },
      controlsCustomised: () => kbmCustomised(game.settings.bindings.kbm),
    };
  }

  /** Menu search: casual (P2P room or server match) or ranked (accounts, server), several playlists at once. */
  private menuSearch(req: SearchRequest): void {
    const online = this.online;
    if (online === null) return;
    if (this.session !== null && this.session.busy) this.session.cancel();
    const client = online.client;
    client.queueModes = req.modes.slice();
    client.region = req.region;
    const mode = req.modes[0];
    this.searchReq = { ...req, modes: req.modes.slice() };
    this.searchSince = performance.now();
    this.holdForGuest = mode !== this.mode && !this.accounts.signedIn && !guestReady(client);
    this.matchKind = req.kind;
    if (req.kind === 'ranked') {
      if (online.state !== 'idle') return;
      this.setMode(mode);
      this.menuReturnAt = -1;
      this.setSession(online);
      online.quickMatch(mode, '', 'ranked');
      return;
    }
    this.startSession(mode, req.net === 'server' ? 'server' : 'p2p');
  }

  private menuSearchView(): SearchView {
    const s = this.session;
    const req = this.searchReq;
    const busy = s !== null && s.busy;
    if (!busy && req !== null && s !== null && !s.inMatch) {
      // The search ended without a match (cancelled or failed): its error stays for the toast.
      this.searchReq = null;
    }
    const error = s !== null && !s.busy && !s.inMatch && s.state === 'idle' ? s.statusText : null;
    return {
      active: busy && req !== null,
      kind: req?.kind ?? null,
      modes: req?.modes ?? [],
      text: busy ? (s?.statusText ?? '') : '',
      since: this.searchSince,
      region: req?.region ?? null,
      net: req?.net ?? null,
      error: error !== null && error.length > 0 ? error : null,
      // 426 reload_required (a stale page: P2PSession STATUS.reload, OnlineSession's netErrorText):
      // the menus' blocking sheet instead of a toast.
      reload: error !== null && error === t('error.queue.reload_required'),
    };
  }

  /**
   * A custom lobby started: play this member's match (a P2P room or a server match). A lobby with
   * experimental rules plays only its P2P room: a server match for it (which the server never
   * forms) is not joined, and the member goes back to the lobby.
   */
  private playLobbyMatch(r: QueueResult | QueueResultP2p): void {
    const st = this.lobby.state;
    const mode: GameMode = st !== null && isPlaylist(st.settings.mode) ? st.settings.mode : this.mode;
    if (this.session !== null && this.session.busy) this.session.cancel();
    this.searchReq = null;
    this.matchKind = 'lobby';
    if ((r as QueueResultP2p).kind !== 'p2p' && st !== null && st.settings.physics !== undefined && st.settings.physics !== null) {
      this.notify(t('p2p.experimentalFailed'));
      this.lobby.back();
      return;
    }
    if ((r as QueueResultP2p).kind === 'p2p') {
      const p2p = this.p2p;
      const q = r as QueueResultP2p;
      if (p2p === null || typeof q.ticket !== 'string' || typeof q.wsUrl !== 'string' || typeof q.roomId !== 'string') return;
      this.setMode(mode);
      this.menuReturnAt = -1;
      this.setSession(p2p);
      p2p.joinAssigned(mode, { kind: 'p2p', roomId: q.roomId, ticket: q.ticket, wsUrl: q.wsUrl });
      return;
    }
    const online = this.online;
    const q = r as QueueResult;
    if (online === null || typeof q.matchId !== 'string' || typeof q.ticket !== 'string' || typeof q.wsUrl !== 'string') return;
    this.setMode(mode);
    this.menuReturnAt = -1;
    this.setSession(online);
    online.joinAssigned(mode, { matchId: q.matchId, ticket: q.ticket, wsUrl: q.wsUrl });
  }

  /** The Hud's settings screen over the menus (on `tab` when given); `onClose` when it is left. */
  private openSettingsScreen(onClose: () => void, tab?: SettingsTab): void {
    this.hud.openSettingsScreen(
      this.settingsOptions(),
      () => {
        this.settingsClosed();
        onClose();
      },
      tab,
    );
  }

  /** What the settings screen works on, from the menus and from the pause menu alike. */
  private settingsOptions(): MenuOptions {
    return {
      // A pick that waits for the online match to end shows as the selected tier (with its line).
      quality: this.pendingRestart ?? this.quality,
      // Super low is listed for unlocked players only; a device running it on its own (or a pick
      // made before the lock) lights no chip and gets its line.
      qualities: menuQualities(this.experimentalUnlocked),
      qualityNote: this.renderer.tierReason === 'chosen' ? t('quality.superlowLocked') : t('settings.qualityAuto'),
      experimental: this.experimentalOptions(),
      settings: this.settings,
      input: this.input,
      onSettingsChanged: () => this.applySettings(),
      onCameraPreset: () => this.chase.applyProjection(this.renderer.camera),
      // Graphics tab: the switch runs behind the loading screen; the screen stays open under it.
      onQualityChange: (q) => void this.switchQuality(q),
    };
  }

  // ---- pause menu ------------------------------------------------------------------------

  /**
   * The pause menu's entries: RESUME, SETTINGS, QUIT (held, or double-clicked: a slip next to
   * RESUME leaves no match; in Competitivo its line says it counts as an abandon); training adds its entries on one row (pack: reset / previous / next shot;
   * free play: reset ball / reset car / unlimited boost) and QUIT leaves training; experimental
   * free play also gets RULES (the settings screen on its Experimental tab). Paused under a pack
   * summary: nothing (the summary's own buttons stay the only ones).
   */
  private pauseEntries(): PauseEntry[] {
    const resume: PauseEntry = { id: 'resume', kind: 'primary', label: () => t('pause.resume'), select: (mouse) => this.resumeFromMenu(mouse) };
    const settings: PauseEntry = { id: 'settings', label: () => t('pause.settings'), select: () => this.openPauseSettings() };
    const tr = this.training;
    if (tr === null) {
      const ranked = this.onlineActive && this.online !== null && this.session === this.online && this.online.ranked;
      return [resume, settings, { id: 'quit', kind: 'quit', hold: true, label: () => t('pause.quit'), sub: () => (ranked ? t('pause.quitRanked') : null), select: () => this.quitToMenu() }];
    }
    if (this.trainingHud !== null && this.trainingHud.summaryVisible) return [];
    // The shot entries also resume (as the training keys do while playing).
    const resumeAnd = (mouse: boolean, fn: (s: TrainingSession) => void): void => {
      this.resumeFromMenu(mouse);
      if (this.training !== null) fn(this.training);
    };
    const extras: PauseEntry[] = tr.isFreeplay
      ? [
          { id: 'reset-ball', kind: 'row', label: () => t('trainingHud.resetBall'), select: (mouse) => resumeAnd(mouse, (s) => s.resetBall()) },
          { id: 'reset-car', kind: 'row', label: () => t('trainingHud.resetCar'), select: (mouse) => resumeAnd(mouse, (s) => s.resetCar()) },
          {
            id: 'boost',
            kind: 'row',
            label: () => t(this.trainingUnlimitedBoost ? 'trainingHud.boostButtonOn' : 'trainingHud.boostButtonOff'),
            select: () => this.toggleTrainingBoost(),
          },
        ]
      : [
          { id: 'reset-shot', kind: 'row', label: () => t('trainingHud.resetShot'), select: (mouse) => resumeAnd(mouse, (s) => s.resetShot()) },
          { id: 'prev-shot', kind: 'row', label: () => t('trainingHud.prevShot'), select: (mouse) => resumeAnd(mouse, (s) => s.prevShot()) },
          { id: 'next-shot', kind: 'row', label: () => t('trainingHud.nextShot'), select: (mouse) => resumeAnd(mouse, (s) => s.nextShot()) },
        ];
    if (tr.isFreeplay && this.freePlayRules !== null) extras.push({ id: 'rules', label: () => t('pause.rules'), select: () => this.openPauseSettings('experimental') });
    return [resume, ...extras, settings, { id: 'quit', kind: 'quit', label: () => t('trainingHud.quit'), select: () => this.stopTraining() }];
  }

  /** The pause menu's key line, from the live pause bindings (rebindable, never unbound) and the back keys that resume too. */
  private pauseHint(): string {
    const input = this.input;
    return t('pause.hint', { resumeKeys: pauseResumeKeys(input.getLabel('pause', 'kbm'), input.getLabel('pause', 'pad')) });
  }

  /**
   * RESUME (and the training entries that resume): Enter / pad A (jump) may still be down on the
   * first tick. A mouse click on it captures the mouse again, as a click on the paused game does
   * (the click is a user gesture; the button is already up, so nothing is masked).
   */
  private resumeFromMenu(mouse = false): void {
    this.setPaused(false);
    this.input.blockJumpUntilRelease();
    this.input.latchEdges();
    if (mouse && this.canPointerLock && this.canvas !== null && this.playing && !this.input.pointerLocked) this.input.requestPointerLock(this.canvas);
  }

  /** Input's menu edges (keyboard and pad) on the pause menu; pad X opens the settings. */
  private pauseMenuActions(): void {
    const hud = this.hud;
    if (!hud.pauseMenuVisible) return;
    // QUIT held with A / Enter: let go before it filled, it empties.
    if (hud.pauseHoldByKey && !this.input.acceptHeld) hud.pauseHoldRelease();
    const a = this.input.actions;
    if (a.accept) hud.pauseAction('accept');
    else if (a.settings) this.openPauseSettings();
    else if (a.menuRepeat) return; // a held arrow does not spin the ring round
    else if (a.menuUp) hud.pauseAction('up');
    else if (a.menuDown) hud.pauseAction('down');
    else if (a.menuLeft) hud.pauseAction('left');
    else if (a.menuRight) hud.pauseAction('right');
  }

  /**
   * SETTINGS on the pause menu (or pad X there), RULES (experimental free play: on the Experimental
   * tab): the settings screen over the paused game, the pause menu hidden under it. Its BACK
   * (button, Esc, pad B) returns to the pause menu, focus on the entry that opened it; the Esc / B
   * that closed it is dropped, so it neither resumes nor quits. In experimental free play the
   * rules picked there apply then, once (applyFreePlayRules), and the pause menu is rebuilt (no
   * RULES entry any more once the player is not unlocked).
   */
  private openPauseSettings(tab?: SettingsTab): void {
    if (!this.paused || this.pauseSettingsOpen || this.menuShown || this.hud.menuVisible) return;
    this.pauseSettingsOpen = true;
    this.input.resetMenuRepeat(); // a direction held into it walks no list: a new press does
    this.hud.setPauseCovered(true);
    const from = tab === 'experimental' ? 'rules' : 'settings';
    this.hud.openSettingsScreen(
      this.settingsOptions(),
      () => {
        this.pauseSettingsOpen = false;
        void this.experimental.flush();
        // Esc is the pause binding too: its tap (still pending in Input) must not reach the next tick.
        this.input.latchEdges();
        if (this.freePlayRules !== null && this.applyFreePlayRules()) {
          // The entries changed with the rules (RULES goes when the player is no longer unlocked).
          this.hud.setPaused(true, this.pauseEntries(), this.pauseHint(), this.onlineActive);
          this.hud.setPauseCovered(false, this.freePlayRules !== null ? from : 'settings');
          return;
        }
        this.hud.setPauseHint(this.pauseHint()); // the pause binding may have been changed there
        this.hud.setPauseCovered(false, from);
      },
      tab,
    );
  }

  /** Leave the pause menu's settings screen without its BACK (the game resumed or the menus took over). */
  private closePauseSettings(): void {
    if (!this.pauseSettingsOpen) return;
    this.pauseSettingsOpen = false;
    if (this.hud.capturing) this.input.cancelRebind();
    this.hud.hideMenu();
  }

  // ---- system Back (src/ui/backGuard.ts) -----------------------------------------------------

  /**
   * One step back inside the game for Android's back gesture / button, a TV remote's BACK, the
   * browser's back, Alt + ← or a mouse's back button (BackGuard), never out of a match: a rebind
   * capture is cancelled; the settings screen goes back (to the pause menu, or to the menus); the
   * menus close their sheet, go back one screen or to JUGAR from another section, and on JUGAR's
   * root ask "Leave Turbogol?" (confirmLeave); a pack summary leaves for the menu (as pad B there);
   * a match being played pauses and a paused one stays paused (Esc / B / RESUME resume it, QUIT
   * leaves). Nothing while a load runs behind the loading screen or after the final whistle (the
   * menus come back by themselves). The order is src/ui/backModel.ts systemBack (tested).
   */
  private onSystemBack(): void {
    const hud = this.hud;
    const step = systemBack({
      loading: this.loadingHold,
      capturing: hud.capturing,
      hudMenu: hud.menuVisible,
      menus: this.menu.visible,
      summary: this.training !== null && this.training.phase === 'summary',
      playing: this.playing,
    });
    if (step === 'cancelCapture') this.input.cancelRebind();
    else if (step === 'hud') hud.menuAction('back');
    else if (step === 'menus') {
      if (!this.menu.back()) this.confirmLeave(true);
    } else if (step === 'leaveSummary') this.stopTraining();
    else if (step === 'pause') this.setPaused(true);
  }

  /**
   * Back on the home screen: "Leave Turbogol?". While it is up the next system Back leaves the
   * page (BackGuard.release: the browser's own Back, to the page before or out of the app); KEEP
   * PLAYING, Esc / B or anything else that closes it arms the guard again. LEAVE (only when there is
   * a page before the game's) goes back there. Its text says so for what opened it: the system Back
   * ("Press Back again"), or Esc, pad B or the menus' ‹, whose next press closes it (choose LEAVE;
   * with no page before, close the tab).
   */
  private confirmLeave(systemBack: boolean): void {
    const guard = this.backGuard;
    if (guard === null) return;
    guard.release();
    const actions: { label: string; primary?: boolean; danger?: boolean; onClick: () => void | boolean }[] = [{ label: t('menu.leaveStay'), primary: true, onClick: () => undefined }];
    if (guard.canLeave) {
      actions.push({
        label: t('menu.leaveGo'),
        danger: true,
        onClick: () => {
          guard.leave();
          return false; // the page goes; the dialog stays until it does
        },
      });
    }
    const body = systemBack ? t('menu.leaveText') : guard.canLeave ? t('menu.leaveTextKey') : t('menu.leaveTextTab');
    this.menu.modal({ title: t('menu.leaveTitle', { game: GAME_NAME }), body, actions, onClose: () => guard.resume() });
  }

  /** A match is under way, paused too (not training, not after the final whistle): leaving the page now loses it, online as an abandon. */
  private get matchUnderway(): boolean {
    if (!this.running || this.loadingHold || this.menuShown || this.training !== null) return false;
    const session = this.session;
    if (session !== null && session.active) return session.inMatch;
    const phase = this.match.phase;
    return phase !== 'menu' && phase !== 'ended';
  }

  /**
   * Per frame: the system Back's backstop. While a match is under way the browser asks before the
   * page goes (beforeunload), for what still walks the history out of it (backGuard.ts header: a
   * second history Back with no click or key between in Chromium / WebKit, a browser without
   * CloseWatcher), a reload, a closed tab. Listened to only meanwhile (a beforeunload listener can
   * cost the page its back/forward cache in some browsers). The browser shows the prompt only after
   * a click, tap or key on the page.
   */
  private updateLeaveGuard(): void {
    const on = this.matchUnderway;
    if (on === this.leaveGuarded) return;
    this.leaveGuarded = on;
    if (on) window.addEventListener('beforeunload', this.onBeforeUnload);
    else window.removeEventListener('beforeunload', this.onBeforeUnload);
  }

  private readonly onBeforeUnload = (e: BeforeUnloadEvent): void => {
    // A reload behind the loading screen (a quality fallback, a lost GPU) sets loadingHold first.
    if (!this.matchUnderway) return;
    e.preventDefault();
    e.returnValue = ''; // browsers that predate preventDefault here
  };

  // ---- loading screen --------------------------------------------------------------------

  /**
   * Run `work` behind the loading screen: it is shown and painted first, then the work runs in
   * steps (`step(i)`: step i is done, the bar moves to marks[i] and creeps on toward marks[i + 1],
   * and a frame paints before the next step), then the loop renders the result under the overlay
   * for two frames before it fades out. While it runs the loop neither renders nor reads input
   * (`loadingHold`; an online session keeps advancing). Loads queue, one at a time; a failure is
   * logged and the overlay still goes.
   */
  private withLoading(label: string, marks: readonly number[], work: (step: (i: number) => Promise<void>) => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      const ov = this.loading;
      await ov.show(label);
      this.loadingHold = true;
      // Toward the first mark while the first step runs; each step's end jumps on and creeps toward the next.
      const creep = (from: number, to: number): void => ov.progress(from + (to - from) * LOADING_CREEP, LOADING_CREEP_MS);
      creep(0, marks[0]);
      try {
        await work(async (i) => {
          const done = marks[i];
          ov.progress(done, 240);
          await afterPaint();
          const next = marks[i + 1];
          if (next !== undefined) creep(done, next);
        });
      } catch (err) {
        console.error('[game] load failed', err);
      } finally {
        this.loadingHold = false;
      }
      await paintedFrames(2);
      // A pad press made during the load is not an edge for the screen under it.
      this.input.latchEdges();
      await ov.hide();
    };
    const p = this.loadingChain.then(run);
    this.loadingChain = p.catch(() => undefined);
    return p;
  }

  /**
   * Settings > Graphics: switch the quality tier behind the loading screen, in steps: the renderer
   * (lights, the world's sizes, the post chain), the views, the world's bake or cache read at the new
   * sizes, then every pipeline compiled in parallel (compilePipelines), so the first frame after it
   * stalls on nothing.
   */
  switchQuality(q: Quality, fallback: Fallback | null = null): Promise<void> {
    // Super low is a pick for unlocked players only (the Graphics tab lists it for them alone): a
    // pick of it from a locked player (a stale or tampered chip) changes nothing. The tier guard's
    // fallbacks are not picks and still reach it.
    if (fallback === null && q === 'superlow' && !this.experimentalUnlocked) return Promise.resolve();
    // A new pick replaces one that waits for the online match to end (back to the running tier:
    // the prefs keep that one again).
    if (fallback === null && this.pendingRestart !== null) {
      this.pendingRestart = null;
      this.hud.setQualityPending(null);
      if (q === this.quality) this.choose(q);
    }
    if (q === this.quality) {
      if (fallback !== null) this.tierGuard.arm(); // nothing to fall back to: the guard listens again
      // The lit chip picked: the running tier becomes the player's pick when the prefs hold another
      // (a Super low pick the lock turned into Performance earlier this session, then unlocked again).
      else if (!this.qualitySet || this.savedQuality !== q) this.choose(q);
      return Promise.resolve();
    }
    // Into or out of super low: its own backend and world, a new page (quality.ts needsReload).
    if (needsReload(this.quality, q)) {
      // In an online match the reload would leave it (an abandon): the pick is saved now and the
      // page restarts once the menus are back (showMenu); the Graphics tab says so.
      if (fallback === null && this.onlineActive) {
        this.choose(q);
        this.pendingRestart = q;
        this.hud.setQualityPending(q);
        return Promise.resolve();
      }
      return this.restartOn(q, fallback);
    }
    const label = fallback !== null ? fallbackText(fallback) : t('loading.quality');
    return this.withLoading(label, QUALITY_STEPS, async (step) => {
      try {
        if (q === this.quality) return;
        // A fallback queued behind a switch the player made meanwhile has nothing left to do.
        if (fallback !== null && this.quality !== fallback.from) return;
        // The new tier's failures count from here (its compile included).
        this.tierGuard.arm();
        this.quality = q;
        const switchId = ++this.tierSwitches;
        if (fallback === null) this.choose(q);
        this.renderer.tierReason = fallback === null ? 'chosen' : 'fallback';
        this.renderer.setQuality(q);
        await step(0);
        this.disposeViews();
        this.buildViews(q);
        this.snapCamera = true;
        await step(1);
        await this.renderer.settled();
        await step(2);
        await this.compilePipelines();
        await step(3);
        // The player's own pick that runs through the fallback window clean lifts a lower
        // remembered ceiling to it (tierGuard.ts raiseCeiling): the next boot starts on it again.
        if (fallback === null) {
          window.clearTimeout(this.confirmTimer);
          this.confirmTimer = window.setTimeout(() => this.confirmTier(q, switchId), FALLBACK_WINDOW_MS + 500);
        }
      } finally {
        // ...and again from its first frames (this also ends a fallback, done or skipped).
        this.tierGuard.arm();
      }
    });
  }

  /**
   * The player picked `q` in the menu: it is their tier from now on (saved with the prefs), and it
   * replaces what the URL or the tab's recovery forced for this page (#superlow, bootTier.ts).
   */
  private choose(q: Quality): void {
    const prefs = tierPrefsAfter({ quality: this.savedQuality, qualitySet: this.qualitySet }, { kind: 'pick', tier: q });
    this.qualitySet = prefs.qualitySet;
    this.savedQuality = prefs.quality;
    this.persistPrefs();
    try {
      window.sessionStorage.removeItem(RECOVER_KEY);
    } catch {
      /* storage unavailable */
    }
    if (typeof location !== 'undefined' && pageFlags().superlow) {
      try {
        history.replaceState(null, '', location.pathname + location.search + withoutTierFlags(location.hash));
      } catch {
        /* sandboxed: the reload keeps the hash */
      }
    }
  }

  /**
   * A switch into or out of super low: the prefs are saved (a player's pick) or the fallback's line
   * kept for the next page (a fallback: its ceiling is already written), then the page reloads
   * behind the loading screen (Renderer.create builds that tier's backend and world).
   */
  private restartOn(q: Quality, fallback: Fallback | null): Promise<void> {
    if (fallback === null) {
      this.choose(q);
      // The next boot tries the pick even above the GPU's ceiling (Renderer.create, bootDone).
      try {
        window.sessionStorage.setItem(TRY_TIER_KEY, q);
      } catch {
        /* the ceiling then still caps it */
      }
    } else {
      try {
        window.sessionStorage.setItem(TIER_NOTICE_KEY, fallbackText(fallback));
      } catch {
        /* the reload still starts on the lower tier (its ceiling) */
      }
    }
    this.loadingHold = true;
    return this.loading.show(fallback !== null ? fallbackText(fallback) : t('loading.restart')).then(() => {
      window.location.reload();
    });
  }

  /** The tier the player picked (switch `switchId`) has run through the fallback window: lift a lower ceiling to it. */
  private confirmTier(q: Quality, switchId: number): void {
    if (switchId !== this.tierSwitches || this.quality !== q || this.tierGuard.fallingBack) return;
    try {
      raiseCeiling(window.localStorage, this.renderer.caps.gpu, q, Date.now());
    } catch {
      /* storage unavailable */
    }
  }

  /**
   * The boot is over (main.ts, once the loading screen is gone): the safety net starts listening to
   * the renderer (a failure of the boot's warm-up is delivered now), and a fallback that reloaded
   * the page says so.
   */
  bootDone(): void {
    this.tierGuard.arm();
    if (diagStats !== null) diagStats.markWarm();
    // A pick across a reload, tried above the GPU's ceiling: lift it once it runs the window clean.
    if (this.renderer.triesAboveCeiling) {
      const q = this.quality;
      const switchId = this.tierSwitches;
      window.clearTimeout(this.confirmTimer);
      this.confirmTimer = window.setTimeout(() => this.confirmTier(q, switchId), FALLBACK_WINDOW_MS + 500);
    }
    this.renderer.setFailureListener((f) => this.onGpuFailure(f));
    let notice: string | null = null;
    try {
      notice = window.sessionStorage.getItem(TIER_NOTICE_KEY);
      if (notice !== null) window.sessionStorage.removeItem(TIER_NOTICE_KEY);
    } catch {
      /* storage unavailable */
    }
    if (notice !== null) this.showTierNotice(notice);
    // The boot read a saved super low pick this player may not make (main.ts gateTierPrefs): the
    // prefs keep Performance from now on, and the player is told, unless the device runs super low
    // by itself anyway (then nothing changed on screen).
    if (this.superlowLockedAtBoot) {
      this.persistPrefs();
      if (this.quality !== 'superlow') this.notify(t('quality.superlowLockedBoot'));
    }
  }

  /**
   * A GPU failure (Renderer.setFailureListener): the tier falls back one step when the guard says
   * so (tierGuard.ts), the device's ceiling is remembered, the player is told. A lost device cannot
   * render again: the page reloads and starts on the lower tier (Renderer.create reads the ceiling).
   */
  private onGpuFailure(f: GpuFailure): void {
    console.warn(`[game] GPU ${f.kind} on ${f.tier}: ${f.message}`);
    const background = document.hidden || performance.now() - this.visibleSince < BACKGROUND_LOSS_MS;
    const fb = this.tierGuard.onFailure(f.kind, f.tier, background);
    if (fb === null) return;
    let store: Storage | null = null;
    try {
      store = window.localStorage;
    } catch {
      /* storage unavailable: this session still falls back */
    }
    // A fall into super low also starts the next boots on it, on its own backend (tierGuard.ts
    // readSuperlowBoot); not from an emulated device, whose record this browser's real GPU would read.
    if (fb.to !== fb.from) writeCeiling(store, this.renderer.caps.gpu, fb.to, Date.now(), !emulatedDevice(pageFlags()));
    if (fb.reload) {
      this.reloadAfterLoss(fb);
      return;
    }
    const text = fallbackText(fb);
    void this.switchQuality(fb.to, fb).then(() => this.showTierNotice(text));
  }

  /**
   * A lost device (or context) cannot draw again: the page reloads, through the tab's counter
   * (tierGuard.ts lossStep): the first loss reloads as the guard planned (the same tier, or the one
   * below with its line kept for the next page), the second reloads on super low for this tab
   * (bootTier.ts 'recover', never saved), the third shows a message and stops. A line on the
   * loading screen says what happens first. Without sessionStorage nothing could count: it stops.
   */
  private reloadAfterLoss(fb: Fallback): void {
    let step: 'reload' | 'recover' | 'stop' = 'stop';
    try {
      const ss = window.sessionStorage;
      const next = lossStep(parseLossRecord(ss.getItem(LOSS_COUNT_KEY)), Date.now());
      ss.setItem(LOSS_COUNT_KEY, JSON.stringify(next.record));
      step = next.step;
      if (step === 'recover') ss.setItem(RECOVER_KEY, '1');
      if (step === 'reload' && fb.to !== fb.from) ss.setItem(TIER_NOTICE_KEY, fallbackText(fb));
    } catch {
      step = 'stop';
    }
    this.loadingHold = true;
    const text = step === 'stop' ? t('gpu.lostStop') : step === 'recover' ? t('gpu.lostRecover') : fb.to !== fb.from ? fallbackText(fb) : t('gpu.lostReload');
    void this.loading.show(text).then(() => {
      if (step !== 'stop') window.setTimeout(() => window.location.reload(), LOSS_RELOAD_DELAY_MS);
    });
  }

  /** A fallback's line as a menu toast now, or the next time the menus are on screen. */
  private showTierNotice(text: string): void {
    if (this.menu.visible && !this.hud.menuVisible) this.menu.toast(text, 'info');
    else this.tierNotice = text;
  }

  /**
   * The Friendly screen's stadium row: switch the theme behind the loading screen (uniforms, then
   * the world's re-bake or cache read). `theme` reads the new one at once (the menu row).
   */
  switchTheme(theme: ThemeId): Promise<void> {
    if (theme === this.theme) return Promise.resolve();
    this.theme = theme;
    return this.withLoading(t('loading.stadium'), THEME_STEPS, async (step) => {
      this.applyTheme(theme);
      await step(0);
      await this.renderer.settled();
      await step(1);
    });
  }

  /** Day stadiums: no ball shadow (see the file header); a warm-up behind the loading screen keeps it on. */
  private applyBallShadow(): void {
    this.ball.root.castShadow = this.warmBallShadow || themeWorld(this.theme).night;
  }

  // ---- online ----------------------------------------------------------------------------

  /** Replace (or disable with null) the phase 1 session. An active match is left first. */
  setOnlineSession(session: OnlineSession | null): void {
    const old = this.online;
    if (old !== null && old !== session) old.leave();
    if (this.session === old) this.session = session;
    this.online = session;
  }

  /** Make `s` the session the loop hosts (null = offline). The previous one is left first. */
  setSession(s: GameSession | null): void {
    // An online match replaces the training roster: leave training first (offline roster back);
    // search practice hands off to its match (a P2P search's lone player handed a server match).
    if (s !== null && this.training !== null) {
      if (this.searchPractice === 'practice') this.practiceToMatch();
      else this.endTraining();
    }
    // Super low still plays online; one line says this device may not keep up (once a session).
    if (s !== null && this.cpuLite && !this.liteOnlineNoticed) {
      this.liteOnlineNoticed = true;
      this.menu.toast(t('quality.superlowOnline'), 'info');
    }
    const old = this.session;
    if (old !== null && old !== s && old.state !== 'idle') old.leave();
    this.session = s;
  }

  /** A session is running the loop (connecting, playing or just ended). */
  get onlineActive(): boolean {
    return this.session !== null && this.session.active;
  }

  /** Menu ONLINE › "Partida en servidor": phase 1 quick match in `mode` (the menu background shows that roster meanwhile). */
  startOnline(mode: GameMode): void {
    const online = this.online;
    if (online === null || online.state !== 'idle') return;
    if (this.session !== null && this.session !== online && this.session.state !== 'idle') return;
    this.setMode(mode);
    this.menuReturnAt = -1; // a pending "back to the menu" of the last match would leave this session
    this.setSession(online);
    online.quickMatch(mode);
  }

  /** Menu ONLINE › "Quick match (P2P)": phase 2 quick match in `mode`. */
  startP2P(mode: GameMode): void {
    const p2p = this.p2p;
    if (p2p === null || p2p.state !== 'idle') return;
    if (this.session !== null && this.session !== p2p && this.session.state !== 'idle') return;
    this.setMode(mode);
    this.menuReturnAt = -1;
    this.setSession(p2p);
    p2p.quickMatch(mode);
  }

  startSession(mode: GameMode, kind: OnlineKind): void {
    if (kind === 'p2p') this.startP2P(mode);
    else this.startOnline(mode);
  }

  /**
   * Rebuild the arena from the host's roster (Welcome): a fresh arena so the car ids restart at 1
   * like the host's, one addCar per roster entry in slot order (the ids must match: rs_load_state
   * refuses a different roster), the player at `welcome.slot`, no local bots (every other car is
   * driven by the host through the echoed inputs). Views / effects / scoreboard are rebuilt.
   */
  applyOnlineRoster(w: Welcome): void {
    this.practiceToMatch(); // search practice still on (the frame's watch had not seen the match found yet)
    const sim = this.sim;
    const roster = w.roster.slice().sort((a, b) => a.slot - b.slot);
    if (roster.length === 0 || roster.length > MAX_CARS) throw new Error(`roster of ${roster.length} cars`);
    sim.createArena(TICK_RATE);
    const ids: number[] = [];
    for (const r of roster) {
      const id = sim.addCar(r.team === 1 ? Team.Red : Team.Blue, CarPreset.Standard);
      ids.push(id);
      if (id !== r.carId) throw new Error(`car id mismatch at slot ${r.slot}: host ${r.carId}, local ${id}`);
    }
    if (w.slot < 0 || w.slot >= ids.length || ids[w.slot] !== w.carId) throw new Error(`player slot ${w.slot} / car ${w.carId} not in the roster`);
    if (isGameMode(w.mode)) this.mode = w.mode;
    const rows = this.sbRows;
    rows.length = 0;
    for (let i = 0; i < roster.length; i++) {
      const r = roster[i];
      rows.push({ name: i === w.slot ? t('game.nameYou', { name: r.name }) : r.name, team: r.team, you: i === w.slot, bot: r.kind === 'bot' });
    }
    this.installSessionRoster(ids, w.slot);
  }

  /**
   * Rebuild the arena from a P2P room's roster (RoomWelcome.slots): one addCar per slot in slot
   * order on a fresh arena (ids 1..n on every peer, so rs_load_state blobs are interchangeable),
   * the player at `you.slot`, no local bot teams (the P2PSession runs the room's seeded ones on the
   * confirmed timeline). Views / effects / scoreboard are rebuilt. The arena is created with the
   * room's physics (an experimental lobby's rules, null = standard) BEFORE any car, so a ball
   * weight change rebuilds the ball before the cars exist on every peer alike; the kickoff boost
   * follows them (resetKickoff after the cars). arenaMutators throws on rules this build does not
   * read: the session then fails instead of playing other physics than the room's.
   */
  applyP2PRoster(w: RoomWelcome): void {
    this.practiceToMatch(); // search practice still on (the frame's watch had not seen the match found yet)
    const sim = this.sim;
    const roster = w.slots.slice().sort((a, b) => a.slot - b.slot);
    if (roster.length === 0 || roster.length > MAX_CARS) throw new Error(`roster of ${roster.length} cars`);
    const me = w.you.slot;
    if (me < 0 || me >= roster.length) throw new Error(`player slot ${me} not in the roster`);
    sim.createArena(TICK_RATE, arenaMutators(w.physics ?? null));
    const ids: number[] = [];
    for (const r of roster) ids.push(sim.addCar(r.team === 1 ? Team.Red : Team.Blue, CarPreset.Standard));
    // The room's kickoff deal, so the first snapshots (menu background, countdown frame) already
    // show it; the session repeats rs_reset_kickoff(seed) as the confirmed timeline's tick 0 state.
    sim.resetKickoff(kickoffSeedOf(w.seed, 0));
    if (isGameMode(w.mode)) this.mode = w.mode;
    const rows = this.sbRows;
    rows.length = 0;
    for (let i = 0; i < roster.length; i++) {
      const r = roster[i];
      rows.push({ name: i === me ? t('game.nameYou', { name: r.name }) : r.name, team: r.team, you: i === me, bot: r.kind === 'bot' });
    }
    this.installSessionRoster(ids, me);
  }

  /** Common tail of the session rosters: slots / offsets / controls, no local bots, views, snapshots. */
  private installSessionRoster(ids: readonly number[], me: number): void {
    const sim = this.sim;
    const carIds = this.carIds;
    const slots = this.carSlots;
    const offs = this.carOffsets;
    carIds.length = 0;
    slots.length = 0;
    offs.length = 0;
    this.redSlots.length = 0;
    this.redOuts.length = 0;
    this.blueSlots.length = 0;
    this.blueOuts.length = 0;
    for (let i = 0; i < ids.length; i++) {
      const slot = sim.slotOf(ids[i]);
      if (slot !== i) throw new Error(`car ${ids[i]} landed in slot ${slot}, expected ${i}`);
      carIds.push(ids[i]);
      slots.push(slot);
      offs.push(sim.carOffset(slot));
    }
    this.playerCarId = ids[me];
    this.playerIndex = me;
    this.playerSlot = slots[me];
    this.playerOff = offs[me];
    this.playerControls = this.controls[me];
    this.bots.setSlots(this.redSlots);
    this.mates.setSlots(this.blueSlots, [this.playerSlot]);
    this.lastHitTick.fill(-1e9);
    this.lastBumpFxTick = -1e9;
    this.rebuildCarViews(this.quality);
    this.ballPinned = false;
    sim.sync();
    this.cur.set(sim.buf);
    this.prev.set(this.cur);
    this.placeViews();
    this.snapCamera = true;
    this.warmUp();
  }

  /** Back from online: a fresh arena with the player car first and the bots of `mode` (as at boot). */
  restoreOfflineRoster(): void {
    const sim = this.sim;
    sim.createArena(TICK_RATE);
    this.playerCarId = sim.addCar(Team.Blue, CarPreset.Standard);
    this.playerIndex = 0;
    let mode = this.mode;
    let roster: number[];
    try {
      roster = addRoster(sim, this.playerCarId, mode);
    } catch (err) {
      console.warn(`Game: could not build the ${mode} roster, falling back to 1v1`, err);
      mode = '1v1';
      roster = addRoster(sim, this.playerCarId, mode);
    }
    this.mode = mode;
    this.applyRoster(roster);
    sim.setCarDodgeDeadzone(this.playerCarId, this.settings.controls.dodgeDeadzone);
    this.rebuildCarViews(this.quality);
    this.ballPinned = false;
    sim.resetKickoff();
    sim.sync();
    this.cur.set(sim.buf);
    this.prev.set(this.cur);
    this.placeViews();
    this.snapCamera = true;
    this.warmUp();
  }

  /** The first snapshot arrived: the online match is on screen (OnlineSession). */
  startOnlineMatch(): void {
    this.sessionMatchOnScreen();
  }

  /** P2PGameHooks: 'start' received, the match is on screen. */
  p2pMatchOnScreen(): void {
    this.sessionMatchOnScreen();
  }

  /** P2PGameHooks: the player's controls for the next predicted tick (the pause overlay owns the input while paused). */
  p2pSampleInput(out: CarControls): void {
    const pc = this.playerControls;
    this.input.sample(pc);
    if (this.paused) zeroControls(pc);
    out.throttle = pc.throttle;
    out.steer = pc.steer;
    out.pitch = pc.pitch;
    out.yaw = pc.yaw;
    out.roll = pc.roll;
    out.jump = pc.jump;
    out.boost = pc.boost;
    out.handbrake = pc.handbrake;
  }

  /** P2PGameHooks: the engine advanced one predicted tick (sim.buf is synced): the same bookkeeping as tick(). */
  p2pAfterTick(): void {
    this.prev.set(this.cur);
    this.cur.set(this.sim.buf);
    this.ticks++;
    const po = this.playerOff;
    if (this.prev[po + C_IS_DEMOED] > 0.5 && this.cur[po + C_IS_DEMOED] < 0.5) this.snapCamera = true;
    this.detectPadPickups();
    this.detectPlayerSounds();
  }

  /** P2PGameHooks: match flow from the confirmed timeline (score / winner given explicitly). */
  p2pMatchEvent(e: MatchEvent, blue: number, red: number): void {
    const hud = this.hud;
    switch (e.type) {
      case 'countdown':
        hud.showCountdown(e.n);
        this.audio.playCountdownTick();
        this.cardCountdown();
        break;
      case 'go':
        hud.showCountdown('GO');
        this.audio.playGo();
        this.goCaptionUntil = this.time + GO_CAPTION_SECONDS;
        this.controlsCard.go();
        this.playFrom = this.cur[H_TICK_COUNT];
        break;
      case 'goal': {
        this.creditGoal(e.team, e.blue, e.red);
        const b = this.cur;
        const p = this.hitPos;
        p[0] = b[BALL_OFFSET + B_POS];
        p[1] = b[BALL_OFFSET + B_POS + 1];
        p[2] = b[BALL_OFFSET + B_POS + 2];
        this.effects.onGoal(e.team, p);
        this.audio.playGoal(e.team);
        this.input.rumble(0.6, 0.6, 350);
        break;
      }
      case 'overtime':
        hud.showOvertime();
        break;
      case 'ended': {
        const title = t('game.teamWins', { team: TEAM_NAME[e.winner] });
        hud.showBanner(title, `${blue} – ${red}`, 0, e.winner);
        this.matchEnded(e.winner, blue, red);
        break;
      }
      default:
        break;
    }
  }

  /** P2PGameHooks: a kickoff reset on the confirmed timeline (the predicted state jumps next advance). */
  p2pKickoffReset(): void {
    this.ballPinned = false;
    this.snapCamera = true;
  }

  /** P2PGameHooks: `slot` is now driven by the team AI on every peer. */
  p2pSlotDropped(slot: number, name: string): void {
    const row = this.sbRows[slot];
    if (row !== undefined) row.bot = true; // the Hud diffs the rows by content: the BOT tag appears
    this.hud.feed(`${t('game.playerDisconnected', { name })} · ${t('game.botTakeover')}`, 'bot');
  }

  /** P2PGameHooks: the P2P queue answered with a server match (or the mesh never closed): phase 1 takes over. */
  p2pHandover(mode: GameMode, assignment: ServerAssignment | null, notice: string): void {
    const online = this.online;
    if (online === null || online.state !== 'idle') {
      this.menuNotice = notice;
      return;
    }
    this.setSession(online);
    if (assignment !== null) online.joinAssigned(mode, assignment, notice);
    else online.quickMatch(mode, notice);
  }

  /** A session's match is on screen: hide the menu, clear banners, block the stale edges, offline match off. */
  private sessionMatchOnScreen(): void {
    if (this.hud.capturing) this.input.cancelRebind();
    this.hideMenus();
    this.hud.hideBanner();
    this.hud.showCountdown(null);
    this.input.blockJumpUntilRelease();
    this.input.latchEdges();
    this.setPaused(false);
    this.menuReturnAt = -1;
    this.goCaptionUntil = -1;
    this.ballPinned = false;
    this.newMatchStats();
    this.match.reset();
    this.acc = 0;
    this.snapCamera = true;
  }

  /**
   * One online tick (OnlineSession.advance): sample the player's input (the pause overlay owns it
   * while paused), let the session pack / send / step, then the same bookkeeping as tick().
   */
  onlineTick(): void {
    const online = this.online;
    if (online === null) return;
    const sim = this.sim;
    const pc = this.playerControls;
    this.input.sample(pc);
    if (this.paused) zeroControls(pc);
    online.stepTick(pc);
    this.prev.set(this.cur);
    sim.sync(); // fires onBump / onBallHit (goals come from the host)
    this.cur.set(sim.buf);
    this.ticks++;
    const po = this.playerOff;
    if (this.prev[po + C_IS_DEMOED] > 0.5 && this.cur[po + C_IS_DEMOED] < 0.5) this.snapCamera = true;
    this.detectPadPickups();
    this.detectPlayerSounds();
  }

  /** A snapshot was applied (load + replay): the current state changed under the views. */
  afterRollback(): void {
    this.cur.set(this.sim.buf);
  }

  /** Match flow from the host (the offline Match is not ticked online). */
  onOnlineEvent(e: HostEvent): void {
    const hud = this.hud;
    switch (e.type) {
      case 'countdown':
        hud.showCountdown(e.n);
        this.audio.playCountdownTick();
        this.cardCountdown();
        break;
      case 'go':
        hud.showCountdown('GO');
        this.audio.playGo();
        this.goCaptionUntil = this.time + GO_CAPTION_SECONDS;
        this.controlsCard.go();
        this.playFrom = this.cur[H_TICK_COUNT];
        break;
      case 'kickoff':
        hud.showCountdown(null);
        break;
      case 'goal': {
        this.creditGoal(e.team, e.blue, e.red);
        const b = this.cur;
        const p = this.hitPos;
        p[0] = b[BALL_OFFSET + B_POS];
        p[1] = b[BALL_OFFSET + B_POS + 1];
        p[2] = b[BALL_OFFSET + B_POS + 2];
        this.effects.onGoal(e.team, p);
        this.audio.playGoal(e.team);
        this.input.rumble(0.6, 0.6, 350);
        break;
      }
      case 'overtime':
        hud.showOvertime();
        break;
      case 'ended': {
        const w = e.winner;
        const team: 0 | 1 | null = w === 0 || w === 1 ? w : null;
        const title = team === null ? t('game.draw') : t('game.teamWins', { team: TEAM_NAME[team] });
        hud.showBanner(title, `${e.blue} – ${e.red}`, 0, team);
        this.matchEnded(team, e.blue, e.red);
        break;
      }
      case 'cancelled':
        // A Competitive match that never started (a no-show, a dodge): back in the queue at once
        // (onSessionDisconnected), never a FINAL.
        if (this.searchReq !== null) this.requeue = { req: this.searchReq, text: t(e.reason === 'dodge' ? 'final.dodge' : 'final.noShow') };
        break;
      case 'playerJoined':
        hud.feed(t('game.playerJoined', { name: e.name }), 'join');
        break;
      case 'playerLeft': {
        const row = this.sbRows[e.slot];
        hud.feed(t('game.playerLeft', { name: row !== undefined ? row.name : t('game.playerSlot', { slot: e.slot }) }), 'leave');
        break;
      }
      case 'botTakeover': {
        // The player quit for good: the host's bot drives that car now (it keeps moving on screen).
        const row = this.sbRows[e.slot];
        if (row !== undefined) row.bot = true; // the Hud diffs the rows by content: the BOT tag appears
        hud.feed(`${t('game.playerLeft', { name: row !== undefined ? row.name : t('game.playerSlot', { slot: e.slot }) })} · ${t('game.botTakeover')}`, 'bot');
        break;
      }
      default:
        break;
    }
  }

  /** The connection is gone for good: back to the menu with the reason as subtitle. */
  onSessionDisconnected(message: string): void {
    const requeue = this.requeue;
    this.requeue = null;
    this.lastResult = null;
    this.finalView = null;
    this.menuNotice = requeue !== null ? requeue.text : message;
    if (!this.menuShown) this.showMenu();
    else if (this.session !== null) this.session.leave();
    // A match that never started: the same search again (the toast says why).
    if (requeue !== null) this.menu.startSearch(requeue.req);
  }

  /**
   * P2PGameHooks: matchmaking / connecting failed (the menu shows why). A custom lobby's member
   * whose match never started goes back to its lobby, so the host can start again (an experimental
   * room has no server fallback: this is where its failures end).
   */
  p2pFailed(_message: string): void {
    if (this.lobby.me?.inGame === true) this.lobby.back();
  }

  /** Phase 1 name of onSessionDisconnected (OnlineSession calls it). */
  onOnlineDisconnected(message: string): void {
    this.onSessionDisconnected(message);
  }

  // ---- training --------------------------------------------------------------------------

  /**
   * Start free play (FREEPLAY_ID) or a shot pack (a TRAINING_PACKS id, src/game/trainingPacks.ts):
   * the menu closes, an online session that is queueing or playing is left, the match is cleared,
   * the arena is rebuilt with ONLY the player's car (kept when switching from one training to
   * another), unlimited boost is ON for free play and OFF for packs (each shot sets its own boost),
   * the TrainingHud opens and the first shot is placed, frozen until the first car input. Unknown
   * ids are ignored with a warning. Reachable from the console as window.__game.startTraining(id).
   *
   * `opts.rules` (a preset id: the training screen's Experimental free play) makes free play
   * experimental for an unlocked player: the preset's physics on a fresh arena before the car
   * (experimentalTraining.ts), its game speed on the loop's clock, "Rules: name" on the
   * TrainingHud, RULES in the pause menu, and no records. Packs always run stock physics: rules
   * given with a pack are ignored (with a warning). The arena is kept from one training to the
   * next only while the wanted physics are the same (a pack after experimental free play is stock).
   */
  startTraining(id: string, opts: { rules?: string | null; keepSession?: boolean } = {}): void {
    const pack = id === FREEPLAY_ID ? null : packById(id);
    if (pack === undefined) {
      console.warn(`Game.startTraining: unknown training id '${id}'`);
      return;
    }
    if (pack !== null && opts.rules != null) console.warn(`Game.startTraining: training packs run stock physics; rules '${opts.rules}' ignored`);
    const session = this.session;
    if (session !== null && session.state !== 'idle' && opts.keepSession !== true) session.leave();
    if (this.hud.capturing) this.input.cancelRebind();
    this.hideMenus();
    this.hud.hideBanner();
    this.hud.showCountdown(null);
    // The press that started training (menu Enter / A / a click) must not release the first shot.
    this.input.blockJumpUntilRelease();
    this.input.latchEdges();
    this.setPaused(false);
    this.menuReturnAt = -1;
    this.goCaptionUntil = -1;
    this.match.reset();
    this.freePlayRules = pack === null && opts.rules != null ? this.freePlayPreset(opts.rules) : null;
    // The pause menu's RULES picks from the remembered preset: it starts on the one playing.
    if (this.freePlayRules !== null) this.experimental.setLastUsed(this.freePlayRules.id);
    const plan = planTrainingArena(trainingRules(id, this.freePlayRules?.values ?? null, this.experimentalUnlocked));
    if (needsTrainingArena(this.training !== null, this.trainingArenaFp, plan)) this.applyTrainingRoster(plan);
    this.trainingSpeed = plan.speed;
    this.trainingUnlimitedBoost = pack === null;
    this.sim.setUnlimitedBoost(this.trainingUnlimitedBoost);
    const th = this.ensureTrainingHud();
    th.show(pack !== null ? pack.name : this.freePlayRules !== null ? t('training.expFreePlay') : FREEPLAY_NAME, pack === null ? 0 : pack.shots.length, pack === null);
    th.setRules(this.freePlayRules !== null ? t('trainingHud.rulesLine', { name: this.freePlayRules.name }) : null);
    this.trainingHintsPad = null;
    // Free play shows the controls card until the car moves; a pack has its own key hints.
    if (pack === null) this.controlsCard.freePlay();
    else this.controlsCard.clear();
    // Experimental free play never saves anything (free play records nothing anyway: packs only).
    this.training = new TrainingSession(pack, this.trainingHooks, this.freePlayRules === null ? { records: this.trainingStore } : { storage: null });
    this.training.start();
    this.acc = 0;
    this.snapCamera = true;
  }

  /** The preset `presetId` as experimental free play's rules (standard when it is gone), null for a player who is not unlocked. */
  private freePlayPreset(presetId: string): Game['freePlayRules'] {
    if (!this.experimentalUnlocked) return null;
    const p = this.experimental.get(presetId) ?? this.experimental.get('standard');
    return p === null ? null : { id: p.id, name: presetName(p), values: canonicalValues(p.values) };
  }

  /**
   * Experimental free play takes the rules of the settings screen ('training' context: the preset
   * picked there, the store's lastUsed) when that screen closes, or stock physics once the player
   * is no longer unlocked (plain free play from then on). A change of physics rebuilds the arena
   * once (car and ball back to their spots, unlimited boost as it was); a change of game speed or
   * name only updates the clock and the TrainingHud. True when anything changed.
   */
  private applyFreePlayRules(): boolean {
    const tr = this.training;
    const was = this.freePlayRules;
    if (tr === null || !tr.isFreeplay || was === null) return false;
    const next = this.freePlayPreset(this.experimental.lastUsed());
    const plan = planTrainingArena(trainingRules(FREEPLAY_ID, next?.values ?? null, this.experimentalUnlocked));
    const sameRules = next !== null && next.id === was.id && next.name === was.name && JSON.stringify(next.values) === JSON.stringify(was.values);
    if (sameRules && plan.fingerprint === this.trainingArenaFp) return false;
    this.freePlayRules = next;
    this.trainingSpeed = plan.speed;
    if (plan.fingerprint !== this.trainingArenaFp) {
      this.applyTrainingRoster(plan);
      this.sim.setUnlimitedBoost(this.trainingUnlimitedBoost);
      tr.start(); // free play: car and ball back to their spots
      this.acc = 0;
    }
    const th = this.trainingHud;
    if (th !== null) {
      th.setTitle(next !== null ? t('training.expFreePlay') : FREEPLAY_NAME);
      th.setRules(next !== null ? t('trainingHud.rulesLine', { name: next.name }) : null);
    }
    return true;
  }

  /**
   * Leave training for the menu (pause screen quit, the summary's "back to menu"): overlay closed,
   * the offline roster of the selected mode rebuilt at kickoff exactly as after boot
   * (restoreOfflineRoster), menu shown. No-op outside training.
   */
  stopTraining(): void {
    if (this.training === null) return;
    // Search practice: back to the menus with the search still queueing.
    const keep = this.searchPractice === 'practice';
    this.searchPractice = 'off';
    this.endTraining();
    this.lastResult = null;
    this.menuNotice = undefined;
    this.showMenu(keep);
  }

  /**
   * MODOS' "While you wait: Free play" (MenuHost.practiceWhileSearching): free play over the running
   * menu search, which goes on queueing under it (startTraining keeps the session). The frame
   * watches it (watchSearchPractice); quitting comes back to the menus still searching.
   */
  private startSearchPractice(): void {
    const s = this.session;
    if (s === null || !s.busy || this.searchReq === null) return;
    this.startTraining(FREEPLAY_ID, { keepSession: true });
    if (this.training === null) return;
    this.searchPractice = 'practice';
    this.trainingHud?.setRules(t('search.practiceLine'));
  }

  /**
   * Every frame of search practice: the session left its queue (a match found: OnlineSession
   * 'connecting', P2PSession 'signaling') -> practiceToMatch; a search that ended without one goes
   * on as plain free play, its reason on the TrainingHud's line (the menus toast it too). Then,
   * entering, until the match is on screen (sessionMatchOnScreen hides the banner), or back to the
   * menus when its connection failed (their toast says why).
   */
  private watchSearchPractice(): void {
    const s = this.session;
    if (this.searchPractice === 'practice') {
      if (this.training === null) this.searchPractice = 'off';
      else if (s === null || s.state === 'idle') {
        this.searchPractice = 'off';
        this.trainingHud?.setRules(s !== null && s.statusText !== null && s.statusText.length > 0 ? s.statusText : null);
      } else if (s.state !== 'queue') this.practiceToMatch();
      return;
    }
    if (s !== null && s.inMatch) this.searchPractice = 'off';
    else if (s === null || s.state === 'idle') {
      this.searchPractice = 'off';
      this.hud.hideBanner();
      this.showMenu();
    }
  }

  /**
   * Search practice found its match: practice ends (the offline roster back, frozen at kickoff
   * under the PARTIDO ENCONTRADO band, which the frame's watch shows: matchFound) and today's
   * found -> match path takes over (the session's roster, its kickoff countdown). The one hand-off
   * from practice to a match (the frame's watch, setSession, the session rosters). No-op unless
   * practising with a search.
   */
  private practiceToMatch(): void {
    if (this.searchPractice !== 'practice') return;
    this.searchPractice = 'entering';
    this.endTraining();
  }

  /** Training off without opening the menu (startMatch / an online session take over from here). */
  private endTraining(): void {
    if (this.training === null) return;
    this.training = null;
    this.freePlayRules = null;
    this.trainingSpeed = 1;
    if (this.trainingHud !== null) this.trainingHud.hide();
    this.hud.hideBanner();
    this.goCaptionUntil = -1;
    this.match.reset();
    // Fresh arena (which also turns unlimited boost off), player + the bots of this.mode, kickoff.
    this.restoreOfflineRoster();
  }

  /**
   * The training roster: a fresh arena with the plan's physics (stock, or experimental free play's
   * preset, applied before the car: experimentalTraining.ts) and only the player's blue car (no
   * bot slots on either team).
   */
  private applyTrainingRoster(plan: TrainingArenaPlan): void {
    const sim = this.sim;
    this.playerCarId = buildTrainingArena(sim, plan, TICK_RATE, Team.Blue, CarPreset.Standard);
    this.trainingArenaFp = plan.fingerprint;
    this.applyRoster([this.playerCarId]);
    sim.setCarDodgeDeadzone(this.playerCarId, this.settings.controls.dodgeDeadzone);
    this.rebuildCarViews(this.quality);
    this.ballPinned = false;
    sim.resetKickoff();
    sim.sync();
    this.cur.set(sim.buf);
    this.prev.set(this.cur);
    this.placeViews();
    this.snapCamera = true;
    this.warmUp();
  }

  private ensureTrainingHud(): TrainingHud {
    if (this.trainingHud !== null) return this.trainingHud;
    // The summary's buttons (the pause entries are the Hud's pause menu: pauseEntries).
    const th = new TrainingHud(this.hud.root.parentElement ?? this.hud.root, {
      onRetryPack: () => this.trainingRetryPack(),
      onQuit: () => this.stopTraining(),
    });
    this.trainingHud = th;
    return th;
  }

  /**
   * One training tick (instead of tick()): sample the player, let the session release a waiting
   * shot on the first car input, then step the sim, unless the shot still waits or the summary is
   * up: a frozen shot does not step at all, so nothing drifts. No bots, no Match. Goals and touches
   * reach the session through the sim events that sync() fires (onSimGoal / onSimBallHit); then the
   * session judges the tick from the ball state.
   */
  private trainingTick(): void {
    const tr = this.training;
    if (tr === null) return;
    const sim = this.sim;
    const pc = this.playerControls;
    this.input.sample(pc);
    tr.input(hasCarInput(pc));
    if (tr.frozen) return;
    if (this.ballPinned) this.pinBall();
    sim.setControls(this.playerCarId, pc);
    sim.step(1);
    this.prev.set(this.cur);
    sim.sync(); // fires onGoal -> training.onGoal, onBallHit -> training.onPlayerTouch
    this.cur.set(sim.buf);
    this.ticks++;
    const b = this.cur;
    const ball = this.trainingBall;
    ball.x = b[BALL_OFFSET + B_POS];
    ball.y = b[BALL_OFFSET + B_POS + 1];
    ball.z = b[BALL_OFFSET + B_POS + 2];
    ball.vx = b[BALL_OFFSET + B_VEL];
    ball.vy = b[BALL_OFFSET + B_VEL + 1];
    ball.vz = b[BALL_OFFSET + B_VEL + 2];
    tr.tick(TICK_DT, ball);
    this.detectPadPickups();
    this.detectPlayerSounds();
  }

  /**
   * Training edges while playing (processActions, not paused). Pack: reset shot (also R, the match
   * "reset to kickoff"), next / previous shot. Free play: reset ball, reset car (R: both), toggle
   * unlimited boost. While paused Backspace / pad B resume, as in a match (QUIT leaves).
   */
  private trainingActions(): void {
    const tr = this.training;
    if (tr === null) return;
    const a = this.input.actions;
    if (tr.isFreeplay) {
      if (a.reset || a.trainingResetCar) tr.resetCar();
      if (a.reset || a.trainingReset) tr.resetBall();
      if (a.trainingBoost) this.toggleTrainingBoost();
    } else if (a.trainingReset || a.reset) tr.resetShot();
    else if (a.trainingNext) tr.nextShot();
    else if (a.trainingPrev) tr.prevShot();
  }

  /**
   * Pack summary edges: accept (Enter / pad A) or the reset key retries the pack, back (Esc /
   * Backspace's menu edge / pad B) leaves for the menu, next / previous reopen a shot to practise
   * (the run's results stay, the summary does not come back for it).
   */
  private trainingSummaryActions(): void {
    const tr = this.training;
    if (tr === null) return;
    const a = this.input.actions;
    if (a.accept || a.trainingReset || a.reset) this.trainingRetryPack();
    else if (a.back) this.stopTraining();
    else if (a.trainingNext || a.trainingPrev) {
      if (this.trainingHud !== null) this.trainingHud.hideSummary();
      this.input.blockJumpUntilRelease();
      if (a.trainingNext) tr.nextShot();
      else tr.prevShot();
    }
  }

  /** "Retry pack": a clean run from shot 1 (pad A is also jump: blocked so it does not release shot 1). */
  private trainingRetryPack(): void {
    const tr = this.training;
    if (tr === null || tr.isFreeplay) return;
    if (this.trainingHud !== null) this.trainingHud.hideSummary();
    this.input.blockJumpUntilRelease();
    this.setPaused(false);
    tr.retryPack();
  }

  /** Free play: unlimited boost on / off (the wrapper refills to 100 every tick while on). */
  private toggleTrainingBoost(): void {
    if (this.training === null || !this.training.isFreeplay) return;
    this.trainingUnlimitedBoost = !this.trainingUnlimitedBoost;
    this.sim.setUnlimitedBoost(this.trainingUnlimitedBoost);
  }

  /** TrainingHooks.placeShot: pads refilled (kickoff reset), car and ball at the shot, at rest, views snapped. */
  private trainingPlaceShot(shot: TrainingShot): void {
    const sim = this.sim;
    const id = this.playerCarId;
    this.ballPinned = false;
    sim.resetKickoff(); // boost pads back to full, the goal de-dup cleared
    const ypr = this.trainingYpr;
    ypr[0] = shot.car.yaw;
    sim.setCarState(id, shot.car.pos, ypr, ZERO_VEC, ZERO_VEC);
    sim.setCarBoost(id, shot.car.boost);
    sim.setBallState(shot.ball.pos, ZERO_VEC, ZERO_VEC);
    if (this.trainingHud !== null) this.trainingHud.hideResult();
    this.trainingSnap(true);
  }

  /** TrainingHooks.releaseShot: the first input; the ball (and a moving car) get their velocities, the tick steps next. */
  private trainingReleaseShot(shot: TrainingShot): void {
    const sim = this.sim;
    const v = shot.car.vel;
    if (v !== undefined) {
      const ypr = this.trainingYpr;
      ypr[0] = shot.car.yaw;
      sim.setCarState(this.playerCarId, shot.car.pos, ypr, v, ZERO_VEC); // boost is preserved
    }
    sim.setBallState(shot.ball.pos, shot.ball.vel, shot.ball.angVel);
  }

  private trainingShotResult(index: number, pass: boolean, reason: ResultReason): void {
    const tr = this.training;
    const th = this.trainingHud;
    if (tr === null || th === null) return;
    const attempts = tr.attempts[index];
    th.showResult(pass, TRAINING_RESULT_TITLE[reason], t('game.trainingShot', { shot: index + 1, total: tr.shotCount, attempt: attempts }), RESULT_SECONDS * 1000);
    // Goals already played the goal sound (onSimGoal); a save / timeout gets a short cue.
    if (reason === 'save') this.audio.playGo();
    else if (reason === 'timeout') this.audio.playCountdownTick();
  }

  private trainingPackSummary(summary: TrainingSummary): void {
    const tr = this.training;
    const th = this.trainingHud;
    if (tr === null || tr.pack === null || th === null) return;
    th.showSummary(tr.pack.name, summary, tr.results);
    this.input.exitPointerLock(); // the summary is clicked
  }

  private trainingFreeplayGoal(): void {
    if (this.trainingHud !== null) this.trainingHud.showResult(true, TRAINING_RESULT_TITLE.goal, '', FREEPLAY_GOAL_PAUSE_SECONDS * 1000);
  }

  /** TrainingHooks.freeplayReset: car to the centre-back spawn and / or ball to the centre spot, at rest. */
  private trainingFreeplayReset(car: boolean, ball: boolean): void {
    const sim = this.sim;
    if (car) {
      const sp = FREEPLAY_CAR_SPAWN;
      const ypr = this.trainingYpr;
      ypr[0] = sp.yaw;
      sim.setCarState(this.playerCarId, sp.pos, ypr, ZERO_VEC, ZERO_VEC);
      sim.setCarBoost(this.playerCarId, sp.boost);
    }
    if (ball) {
      this.ballPinned = false;
      sim.setBallState(FREEPLAY_BALL.pos, ZERO_VEC, ZERO_VEC);
    }
    this.trainingSnap(car);
  }

  /**
   * After a training teleport: the snapshots are synced with no interpolation across the jump. A
   * moved car shows parked wheels (the wheel raycasts only run on the next step, so the buffer
   * still holds the pre-teleport suspension, e.g. hanging wheels after a jump; 0 = "parked" for
   * CarView) and the camera snaps to it.
   */
  private trainingSnap(carMoved: boolean): void {
    const sim = this.sim;
    sim.sync();
    const cur = this.cur;
    cur.set(sim.buf);
    if (carMoved) {
      const o = this.playerOff + C_WHEEL_SUSPENSION;
      cur[o] = 0;
      cur[o + 1] = 0;
      cur[o + 2] = 0;
      cur[o + 3] = 0;
      this.snapCamera = true;
    }
    this.prev.set(cur);
  }

  /** Per-frame training overlay; every TrainingHud setter is cached, strings are built only on a change. */
  private updateTrainingHud(): void {
    const tr = this.training;
    const th = this.trainingHud;
    if (tr === null || th === null) return;
    th.setPaused(this.paused);
    const pad = this.input.hasGamepad;
    if (pad !== this.trainingHintsPad) {
      this.trainingHintsPad = pad;
      th.setHints(this.trainingHints(pad));
    }
    const pack = tr.pack;
    if (pack === null) {
      th.setBoostUnlimited(this.trainingUnlimitedBoost);
      th.setWaiting(false);
      return;
    }
    const i = tr.index;
    th.setShot(i, pack.shots[i].name, tr.attempts[i], tr.results);
    const limit = pack.timeLimitSeconds;
    const waiting = tr.phase === 'waiting';
    th.setTimer(waiting ? 1 : tr.timeLeft / limit, waiting ? limit : tr.timeLeft, true);
    th.setWaiting(waiting && !this.paused);
  }

  /** Key hint labels from the live bindings of the device in use (allocates: only when the device changes). */
  private trainingHints(pad: boolean): TrainingHints {
    const input = this.input;
    const dev = pad ? 'pad' : 'kbm';
    return {
      reset: input.getLabel('trainingReset', dev),
      prev: input.getLabel('trainingPrev', dev),
      next: input.getLabel('trainingNext', dev),
      resetCar: input.getLabel('trainingResetCar', dev),
      boost: input.getLabel('trainingBoost', dev),
      pause: input.getLabel('pause', dev),
      accept: pad ? 'A' : 'Enter',
      back: pad ? 'B' : 'Esc',
    };
  }

  // ---- controls card (src/render/controlsCard.ts) --------------------------------------------

  /**
   * A kickoff countdown step (offline, server or P2P): the first one after the menus may bring the
   * card (not under the menus). Not in touch mode, which shows no card: a phone's first matches
   * would use up the ones a controller connected later should get.
   */
  private cardCountdown(): void {
    if (!this.menuShown && !(this.touch !== null && this.touch.touchMode)) this.controlsCard.countdown();
  }

  /**
   * Per frame: the card's seconds of play (not paused, cars not frozen), free play's first drive,
   * and the Hud's card: nothing in the menus, while no match is played (paused, after the whistle)
   * or in touch mode (the on-screen buttons carry their names). The device is the training hints'
   * (a controller connected: its card). The rows are built again only when the device, a binding
   * (applySettings) or the tag changes.
   */
  private updateControlsCard(dt: number, inMenu: boolean, touchMode: boolean): void {
    const plan = this.controlsCard;
    const hud = this.hud;
    if (plan.view === 'off') {
      hud.setControlsCard('off', null);
      return;
    }
    const playing = this.playing && !this.carsFrozen;
    plan.tick(playing ? dt : 0);
    if (playing && this.training !== null && this.training.isFreeplay && hasCarInput(this.playerControls)) plan.drove();
    // Not playing: paused, after the final whistle, a pack summary (the countdown counts as playing).
    const view = inMenu || !this.playing || touchMode ? 'off' : plan.view;
    if (view === 'off') {
      hud.setControlsCard('off', null);
      return;
    }
    const device: Device = this.input.hasGamepad ? 'pad' : 'kbm';
    const match = plan.match;
    let content = this.controlsContent;
    if (content === null || device !== this.controlsDevice || match !== this.controlsMatch) {
      this.controlsDevice = device;
      this.controlsMatch = match;
      const input = this.input;
      content = {
        rows: controlsCardRows(device, (action, d) => input.getBinding(action, d)),
        tag: match === 0 ? t('training.freePlay') : match === 1 ? t('controls.tagFirst') : t('controls.tagMatch', { n: match, total: CARD_FIRST_MATCHES }),
        foot: t('controls.change', { tab: t(device === 'pad' ? 'settings.tabPad' : 'settings.tabKbm') }),
      };
      this.controlsContent = content;
    }
    hud.setControlsCard(view, content);
  }

  // ---- lifecycle -------------------------------------------------------------------------

  /** Show the start menu and begin the render loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('blur', this.onBlur);
    if (this.canvas !== null) this.canvas.addEventListener('pointerdown', this.onCanvasPointerDown);
    if (this.touch !== null) {
      this.touch.root.addEventListener('pointerdown', this.onTouchLayerPointerDown);
      // Android phones: a finger tap goes fullscreen (in the event itself: it needs its user
      // activation); the click is Firefox's fallback, in the bubble phase so the tapped control
      // uses the activation first. autoFullscreen applies the gate.
      window.addEventListener('pointerup', autoFullscreen, { capture: true, passive: true });
      window.addEventListener('click', autoFullscreen, { passive: true });
      document.addEventListener('fullscreenchange', this.onFullscreenChange);
    }
    this.addGestureListeners();
    if (this.backGuard !== null) this.backGuard.start();
    this.hud.setCameraMode(this.chase.ballCam);
    if (this.touch !== null) this.touch.setBallCam(this.chase.ballCam);
    this.showMenu();
    this.lastTime = -1;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('blur', this.onBlur);
    if (this.canvas !== null) this.canvas.removeEventListener('pointerdown', this.onCanvasPointerDown);
    if (this.touch !== null) {
      this.touch.root.removeEventListener('pointerdown', this.onTouchLayerPointerDown);
      window.removeEventListener('pointerup', autoFullscreen, { capture: true });
      window.removeEventListener('click', autoFullscreen);
      document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    }
    this.removeGestureListeners();
    if (this.backGuard !== null) this.backGuard.dispose();
    if (this.leaveGuarded) {
      this.leaveGuarded = false;
      window.removeEventListener('beforeunload', this.onBeforeUnload);
    }
    this.input.exitPointerLock();
  }

  private addGestureListeners(): void {
    if (this.gestureListening) return;
    this.gestureListening = true;
    window.addEventListener('pointerdown', this.onGesture);
    window.addEventListener('pointerup', this.onGesture); // touch: pointerdown is not activation-triggering
    window.addEventListener('keydown', this.onGesture);
  }

  private removeGestureListeners(): void {
    if (!this.gestureListening) return;
    this.gestureListening = false;
    window.removeEventListener('pointerdown', this.onGesture);
    window.removeEventListener('pointerup', this.onGesture);
    window.removeEventListener('keydown', this.onGesture);
  }

  /**
   * Compile every GPU pipeline a match needs while the boot overlay is still up. Meshes that start
   * hidden (boost flames, ball ground marker, particles, goal ring / flash) are made renderable for
   * one synchronous render so their shaders are built now rather than at the first boost, first
   * airborne ball or first goal (measured: 60-150 ms presentation stalls at exactly those moments).
   * Must run through the real render path: the scene is drawn by the pipeline's scene pass into its
   * own render target (MRT on tiers with bloom), so renderer.gpu.compileAsync(scene, camera) builds
   * the wrong variants.
   * While the loop is running (setQuality, setMode, training) the same happens on the next loop
   * frame via warmFrames; the switches behind the loading screen use compilePipelines instead.
   */
  warmUp(): void {
    if (this.running) {
      this.warmFrames = 1;
      return;
    }
    this.setWarm(true, true);
    this.renderer.render();
    this.setWarm(false);
  }

  /** The scene holds its frame while a search's guest registers after a roster switch (holdForGuest). */
  private heldForGuest(): boolean {
    if (!this.holdForGuest) return false;
    const s = this.session;
    const client = this.online?.client;
    if (s !== null && s.busy && client !== undefined && !guestReady(client)) return true;
    this.holdForGuest = false; // registered (the queue request has left), cancelled or failed
    return false;
  }

  /**
   * The boot's warm-up: the same as warmUp, but every pipeline (hidden meshes included) is first
   * compiled in parallel (Renderer.precompile: on WebGPU one frame whose pipelines are all created
   * asynchronously, on WebGL2 a compileAsync of the scene), so the synchronous warm-up render only
   * builds what is left (nothing on WebGPU, a few shadow and post programs on WebGL2).
   */
  async warmUpAsync(): Promise<void> {
    if (this.running) {
      this.warmUp();
      return;
    }
    await this.compilePipelines();
  }

  /**
   * warmUpAsync's work, also run by a quality switch behind the loading screen (the loop does not
   * render meanwhile: loadingHold): the parallel precompile, then one synchronous warm-up render for
   * what is left. The ball casts its shadow throughout, so its shadow pipeline exists for the night
   * stadiums even when this one is a day stadium.
   */
  private async compilePipelines(): Promise<void> {
    this.setWarm(true, true);
    try {
      await this.renderer.precompile();
    } finally {
      this.setWarm(false);
    }
    this.setWarm(true, true);
    this.renderer.render();
    this.setWarm(false);
  }

  /**
   * Make the normally hidden meshes renderable (`on`) for a warm-up render; `ballShadow`: the ball
   * casts its shadow too (the warm-ups off screen pass it, so a day stadium never leaves the ball's
   * shadow pipeline for the first night one to compile).
   */
  private setWarm(on: boolean, ballShadow = false): void {
    this.warmBallShadow = on && ballShadow;
    this.applyBallShadow();
    this.arena.setWarmUp(on);
    const cars = this.cars;
    for (let i = 0; i < cars.length; i++) {
      const w = cars[i] as unknown as Warmable;
      if (w.setWarmUp) w.setWarmUp(on);
      else cars[i].boostFlame.visible = on; // CarView.update() re-evaluates the flame every frame anyway
    }
    const ball = this.ball as unknown as Warmable;
    if (ball.setWarmUp) ball.setWarmUp(on);
    const fx = this.effects as unknown as Warmable;
    if (fx.setWarmUp) fx.setWarmUp(on);
  }

  dispose(): void {
    this.stop();
    window.clearTimeout(this.confirmTimer);
    if (this.p2p !== null) this.p2p.dispose();
    if (this.online !== null) this.online.dispose();
    this.disposeViews();
    this.input.dispose();
    if (this.touch !== null) {
      this.input.setTouchSource(null);
      this.touch.dispose();
    }
    if (this.trainingHud !== null) this.trainingHud.dispose();
    this.hud.dispose();
    this.audio.dispose();
    this.sim.events.onGoal = undefined;
    this.sim.events.onBump = undefined;
    this.sim.events.onBallHit = undefined;
  }

  // ---- settings --------------------------------------------------------------------------

  setDifficulty(d: Difficulty): void {
    this.difficulty = d;
    this.bots.setDifficulty(d);
    this.mates.setDifficulty(d);
    this.persistPrefs();
  }

  /**
   * Switch quality tier at once: renderer settings plus a rebuild of every view (35-75 ms on a
   * desktop CPU), then the next frame compiles the new tier's pipelines (warmUp). The menus use
   * switchQuality (the same behind the loading screen); this stays for the console and the tools.
   */
  setQuality(q: Quality): void {
    if (q === this.quality) return;
    // Into or out of super low: a reload, as from the menu.
    if (needsReload(this.quality, q)) {
      void this.restartOn(q, null);
      return;
    }
    this.tierGuard.arm();
    this.tierSwitches++;
    this.quality = q;
    this.choose(q);
    this.renderer.tierReason = 'chosen';
    this.renderer.setQuality(q);
    this.disposeViews();
    this.buildViews(q);
    this.snapCamera = true;
    this.warmUp(); // every material was rebuilt: compile the hidden ones on the next frame too
  }

  /**
   * Switch the stadium theme at once: stored, saved with the prefs and handed to the renderer
   * (lights, world: a re-bake or a cached cube, post), the arena (turf, stadium) and the ball's
   * shadow. Uniform writes only: no view is rebuilt and no shader recompiles. The Friendly screen
   * uses switchTheme (the same behind the loading screen, until the world is done).
   */
  setTheme(theme: ThemeId): void {
    if (theme === this.theme) return;
    this.applyTheme(theme);
  }

  private applyTheme(theme: ThemeId): void {
    this.theme = theme;
    this.renderer.setTheme(theme);
    this.arena.setTheme(theme);
    this.applyBallShadow();
    this.persistPrefs();
    this.redraw = true;
  }

  /**
   * Switch the game mode (1v1 / 2v2 / 3v3). Only from the menu: the bots are removed from the sim
   * and the new roster is added (`addRoster`), the car views / effects registrations / bot slots
   * are rebuilt, everything goes back to kickoff and the camera snaps. Ignored during a match.
   * When the sim refuses the roster (an old wasm build with a smaller MAX_CARS) it falls back to
   * 1v1 so the game stays playable. Returns the mode that is now in effect.
   */
  setMode(mode: GameMode): GameMode {
    if (mode === this.mode) return mode;
    if (this.training !== null) return this.mode; // the training roster is only the player's car
    if (!this.menuShown && this.match.phase !== 'menu') return this.mode;
    const sim = this.sim;
    const ids = this.carIds;
    for (let i = ids.length - 1; i >= 1; i--) sim.removeCar(ids[i]);
    let roster: number[];
    try {
      roster = addRoster(sim, this.playerCarId, mode);
    } catch (err) {
      console.warn(`Game: could not build the ${mode} roster, falling back to 1v1`, err);
      mode = '1v1';
      roster = addRoster(sim, this.playerCarId, mode);
    }
    this.mode = mode;
    this.applyRoster(roster);
    this.rebuildCarViews(this.quality);
    this.ballPinned = false;
    sim.resetKickoff();
    sim.sync();
    this.cur.set(sim.buf);
    this.prev.set(this.cur);
    this.placeViews();
    this.snapCamera = true;
    this.warmUp(); // new flames / ribbons: compile their pipelines on the next frame
    this.persistPrefs();
    return mode;
  }

  private persistPrefs(): void {
    // The player's tier (or the saved default), never the one the session runs on its own: super
    // low from the URL or the tab's recovery, low on a weak backend, a GPU's ceiling, a fallback.
    savePrefs({ difficulty: this.difficulty, quality: this.savedQuality, mode: this.mode, qualitySet: this.qualitySet, theme: this.theme, menuSceneAnimated: this.menuSceneAnimated, fpsCap: this.fpsCap });
  }

  setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    if (p) this.hud.setPaused(true, this.pauseEntries(), this.pauseHint(), this.onlineActive);
    else {
      this.closePauseSettings();
      this.hud.setPaused(false);
    }
    if (p) {
      this.acc = 0;
      // A hidden tab stops requestAnimationFrame, so render() (the only driver of the continuous
      // audio layers) would never run again and the engine / boost / wind would keep roaring.
      this.audio.silence();
      // The pause menu gives the mouse back; the lock is re-requested by the next canvas click.
      this.input.exitPointerLock();
      // The stick steering through the pause repeats nothing on its ring (Input.resetMenuRepeat).
      this.input.resetMenuRepeat();
    }
  }

  /**
   * Persist the settings and re-apply what lives outside Input: the sim's dodge deadzone, the
   * camera projection (the camera settings themselves are read live by reference; the vibration
   * flag is read by Input.rumble) and the master volume. Called from Input.onChange and the Hud's
   * settings screen.
   */
  applySettings(): void {
    const s = this.settings;
    saveSettings(s);
    this.controlsContent = null; // a binding may have changed: the controls card's rows
    // Online the host's car config is authoritative (the deadzone is not in the state blob):
    // a different local value would only make the prediction diverge.
    if (!this.onlineActive) this.sim.setCarDodgeDeadzone(this.playerCarId, s.controls.dodgeDeadzone);
    this.chase.applyProjection(this.renderer.camera);
    this.audio.setVolume(s.audio.volume / 100);
    this.audio.setMusicVolume(s.audio.music / 100);
  }

  /** Cars take no input: kickoff countdown, goal pause, after the final whistle, in the menu. */
  get carsFrozen(): boolean {
    if (this.training !== null) return false; // a waiting shot freezes the whole sim instead (trainingTick)
    const session = this.session;
    if (session !== null && session.active) return session.frozen;
    const m = this.match;
    return m.frozen || m.inGoalPause || m.phase === 'ended' || m.phase === 'menu';
  }

  /** A match is on screen and taking input: not in the menu, not paused, not after the whistle. */
  get playing(): boolean {
    if (!this.running || this.paused || this.menuShown) return false;
    // Training: the summary panel is mouse-driven (no capture click, no lock hint).
    if (this.training !== null) return this.training.phase !== 'summary';
    const session = this.session;
    if (session !== null && session.active) return session.inMatch;
    const phase = this.match.phase;
    return phase !== 'menu' && phase !== 'ended';
  }

  /** Paused on a match (not the menu, not its settings screen): a click on the canvas resumes it. */
  private get canResumeByPointer(): boolean {
    return this.running && this.paused && !this.menuShown && !this.hud.menuVisible && (this.match.phase !== 'menu' || this.onlineActive || this.training !== null);
  }

  /** Start a match from the menu (also used by the debug console). */
  startMatch(): void {
    if (this.training !== null) this.endTraining(); // back to the offline roster of the mode first
    if (this.hud.capturing) this.input.cancelRebind();
    this.hideMenus();
    this.hud.hideBanner();
    this.input.blockJumpUntilRelease();
    // The menu closed synchronously inside a key / button handler: that press is still down (or
    // tapped) when the first tick samples and would fire as a fresh edge of whatever it is bound
    // to in game (Space = ball cam, A...). Make it "already held" instead.
    this.input.latchEdges();
    this.setPaused(false);
    this.menuReturnAt = -1;
    this.ballPinned = false;
    this.matchKind = 'ai';
    this.newMatchStats();
    this.bots.reset();
    this.mates.reset();
    this.match.start();
    this.acc = 0;
  }

  /**
   * Leave the match for the menu (the pause menu's QUIT: nothing else quits). The
   * match state is cleared (`Match.reset()`), everything is put back on its kickoff spot and the menu opens over the
   * current roster, so the mode / difficulty / quality can change before the next PLAY. Nothing
   * happens in the menu itself.
   */
  quitToMenu(): void {
    if (this.menuShown) return;
    if (this.training !== null) {
      this.stopTraining();
      return;
    }
    const online = this.onlineActive;
    if (!online && this.match.phase === 'menu') return;
    if (!online) {
      this.match.reset();
      this.resetToKickoff();
    }
    this.goCaptionUntil = -1;
    this.lastResult = null;
    this.menuNotice = undefined;
    this.showMenu();
  }

  /** Teleport everything back to kickoff positions (the `reset` action: R by default, unbound on the pad). */
  resetToKickoff(): void {
    this.ballPinned = false;
    this.sim.resetKickoff();
    this.sim.sync();
    this.cur.set(this.sim.buf);
    this.prev.set(this.cur);
    this.bots.reset();
    this.mates.reset();
    this.snapCamera = true;
  }

  // ---- loop ------------------------------------------------------------------------------

  private readonly frame = (t: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    // Before the session is read: a search found under practice ends it first (practiceToMatch).
    if (this.searchPractice !== 'off') this.watchSearchPractice();
    const inMenu = this.menuShown;
    // Online the host / the peers keep running: the pause overlay only takes the input away, and
    // the menu (still up while a P2P room connects) must not stop the session's ready / fallback
    // bookkeeping either.
    const session = this.session !== null && this.session.active ? this.session : null;
    // A match on screen keeps its frame cap (super low: 30; GamePrefs.fpsCap) for everything: a
    // skipped frame does nothing, the next one carries its time (dt below), so the sim clock stays
    // right. The menus and an offline pause run their logic on every animation frame whatever the
    // scene's rate below, so a short press of a pad never falls between two drawn frames.
    const live = session !== null ? session.inMatch : !inMenu && !this.paused;
    const tierCap = this.renderer.spec.maxFps;
    const cap = frameCap(tierCap, this.fpsCap);
    // The tier's own cap counts whole refreshes as it always did (drawsFrame: super low's 30 is 25
    // on 50 Hz); a lower player limit keeps its average (FramePacer: 60 on 144 Hz, not 48).
    const ownCap = cap === tierCap;
    if (!runsLogic(t, this.lastLogicAt, cap, live, ownCap ? null : this.logicPace)) {
      // An online pause (live: the match goes on at its cap) still reads the pad in between: the
      // edges wait in Input's actions for the next frame of logic, so a tap in its menu is not lost.
      if (this.paused) this.input.readEdges();
      if (diagStats !== null) diagStats.frame(t, false, false);
      return;
    }
    this.lastLogicAt = t;
    const now = t * 0.001;
    let dt = this.lastTime < 0 ? 0 : now - this.lastTime;
    this.lastTime = now;
    if (dt < 0) dt = 0;
    else if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
    this.time += dt;

    // One gamepad poll per frame (navigator.getGamepads() allocates); every tick reuses it.
    this.input.beginFrame();
    if (session !== null) {
      this.alpha = session.advance(dt);
      // The menu is pad-driven while a room connects: keep polling the gamepad.
      if (inMenu) this.input.sample(this.playerControls);
    } else if (!inMenu && !this.paused && !this.loadingHold) {
      // Experimental free play's game speed slows the sim clock (never above 1: fewer ticks, no extra work).
      this.acc = accumulate(this.acc, dt, this.training !== null ? this.trainingSpeed : 1, MAX_FRAME_DT);
      while (this.acc >= TICK_DT) {
        if (this.training !== null) this.trainingTick();
        else this.tick();
        this.acc -= TICK_DT;
      }
      this.alpha = this.acc / TICK_DT;
    } else {
      // Still poll the gamepad so Start / A work in menus and while paused.
      this.input.sample(this.playerControls);
    }
    if (this.loadingHold) {
      // Behind the loading screen: the work in progress owns the renderer, nothing reacts to input.
      this.input.consumeActions();
      this.redraw = true; // what the load changed (tier, stadium, views) shows on the next frame
      if (diagStats !== null) diagStats.frame(t, false, true);
      return;
    }
    this.processActions();

    // "UI at rest": the scene at the match's cap, the menus' rate, or one held frame under an
    // opaque layer, in an offline pause and when the menus' stadium may not move (quality.ts
    // sceneFps). A change of pace draws once (the held frame shows the new state), and so does
    // whatever changed under it (`redraw`) and a pipeline warm-up frame.
    const menus = this.menuShown; // processActions may have opened or left them
    const cover = this.sceneCover();
    const still = pauseHolds(this.paused, menus, session !== null); // online the match goes on, its whistle ('ended') too
    const fps = sceneFps({
      cover,
      cap,
      lite: this.cpuLite,
      still,
      animated: this.menuSceneAnimated && !this.reduceMotion,
      phone: this.coarse,
      covered: this.menuCovered,
    });
    const key = (fps + 2) * 16 + (cover === 'none' ? 0 : cover === 'partial' ? 4 : 8) + (menus ? 2 : 0) + (still ? 1 : 0);
    const changed = key !== this.sceneKey;
    this.sceneKey = key;
    // Into the menus: their paced scene feeds dynamic resolution nothing, so the scale the match
    // left would stay. Full resolution, as the menus reached on their own before (the next match
    // lowers it again under its own load); before the draw, so a resize's redraw is this one.
    if (changed && menus) this.renderer.resetResolutionScale();
    if (fps === HELD_FRAME) this.drawAcc = 0;
    else this.drawAcc += dt;
    // A match being played draws every frame its cap let through (rate 0); the tier's cap over
    // nothing else in whole refreshes (no pacer: drawsFrame); the menus' rates and the player's
    // limit at their average (scenePace).
    const rate = live && fps === cap ? 0 : fps;
    const draw = !this.heldForGuest() && drawsScene(t, this.lastDrawAt, rate, changed || this.redraw || this.warmFrames > 0, cover === 'none' && ownCap ? null : this.scenePace);
    // A paced or held scene's stalls are between animation frames, a match's between drawn ones (frameStats.ts).
    if (diagStats !== null) diagStats.frame(t, draw, fps !== cap);
    if (draw) {
      this.lastDrawAt = t;
      this.redraw = false;
      const drawDt = this.drawAcc > MAX_FRAME_DT ? MAX_FRAME_DT : this.drawAcc;
      this.drawAcc = 0;
      // A paced or held frame's interval says nothing about the load: no rAF time for dynamic
      // resolution. Nor under the player's limit: its frames alternate between two counts of
      // refreshes (FramePacer), which the controller would take for late ones; it holds its scale.
      this.render(drawDt, menus, fps === cap && ownCap ? t : undefined);
    }
    this.frameLogic(dt, menus);
    this.updateFps(now, draw);
  };

  private tick(): void {
    const sim = this.sim;
    const match = this.match;
    const frozen = this.carsFrozen;
    const controls = this.controls;
    const ids = this.carIds;
    const n = ids.length;

    this.input.sample(controls[0]);
    if (frozen) {
      for (let i = 0; i < n; i++) zeroControls(controls[i]);
      if (this.ballPinned) this.pinBall();
    } else {
      // Refresh by age rather than by tick parity so the first tick after a countdown or a kickoff
      // reset always starts from a fresh prediction (the bot adds the age to its entry index).
      const ds = diagStats;
      let t0 = ds !== null ? performance.now() : 0;
      const age = sim.tickCount - sim.predTick;
      if (age >= this.predEvery || age < 0) sim.updateBallPrediction();
      if (ds !== null) {
        const t1 = performance.now();
        ds.add('pred', t1 - t0);
        t0 = t1;
      }
      // One think per team per tick (a team may hold its outputs for several ticks internally).
      this.bots.think(sim, this.redOuts);
      if (this.blueSlots.length > 0) this.mates.think(sim, this.blueOuts);
      if (ds !== null) ds.add('bots', performance.now() - t0);
    }
    for (let i = 0; i < n; i++) sim.setControls(ids[i], controls[i]);

    const dsStep = diagStats;
    const ts = dsStep !== null ? performance.now() : 0;
    sim.step(1);
    if (dsStep !== null) dsStep.add('step', performance.now() - ts);
    this.prev.set(this.cur);
    sim.sync(); // fires onGoal / onBump / onBallHit
    this.cur.set(sim.buf);
    this.ticks++;
    // A demolished player respawns elsewhere, facing the other way: place the camera there at once.
    const po = this.playerOff;
    if (this.prev[po + C_IS_DEMOED] > 0.5 && this.cur[po + C_IS_DEMOED] < 0.5) this.snapCamera = true;

    const events = match.tick(TICK_DT);
    for (let i = 0; i < events.length; i++) this.onMatchEvent(events[i]);

    this.detectPadPickups();
    this.detectPlayerSounds();
  }

  private processActions(): void {
    const input = this.input;
    const a = input.actions;
    const pa = input.padActions;
    const hud = this.hud;

    if (hud.capturing) {
      // A rebind capture owns every device: the press that ends it must not act on anything else.
    } else if (this.menu.visible && !hud.menuVisible) {
      // The front-end menus: keyboard goes to their own listener (Q / E / X / Delete too), gamepad
      // edges come from here. Start before B: Start is also the pause binding, whose edge sets back.
      // An arrow's auto-repeat (pa.menuRepeat) cycles no choice and crosses no zone (nav.ts).
      const m = this.menu;
      const rep = pa.menuRepeat;
      if (pa.accept) m.action('accept');
      else if (pa.menuStart) m.action('menu');
      else if (pa.back) m.action('back');
      else if (pa.settings) m.action('context');
      else if (pa.menuCancel) m.action('cancel');
      else if (pa.menuPrev) m.action('prev');
      else if (pa.menuNext) m.action('next');
      else if (pa.menuTabPrev) m.action('tabPrev');
      else if (pa.menuTabNext) m.action('tabNext');
      else if (pa.menuLeft) m.action('left', rep);
      else if (pa.menuRight) m.action('right', rep);
      else if (pa.menuUp) m.action('up', rep);
      else if (pa.menuDown) m.action('down', rep);
    } else if (hud.menuVisible) {
      // Keyboard goes straight to the Hud's own listener; only gamepad edges are forwarded. A held
      // arrow's repeat (Hud.menuAction): up / down stop at the ends, left / right slide a slider only
      // (Graphics would switch the quality, a reload, on every repeat). LB / RB and LT / RT: the tabs.
      const rep = pa.menuRepeat;
      if (pa.accept) hud.menuAction('accept');
      else if (pa.back) hud.menuAction('back');
      else if (pa.settings) hud.menuAction('settings');
      else if (pa.menuPrev || pa.menuTabPrev) hud.menuAction('tabPrev');
      else if (pa.menuNext || pa.menuTabNext) hud.menuAction('tabNext');
      else if (pa.menuLeft) hud.menuAction('left', rep);
      else if (pa.menuRight) hud.menuAction('right', rep);
      else if (pa.menuUp) hud.menuAction('up', rep);
      else if (pa.menuDown) hud.menuAction('down', rep);
      // Y over the settings screen opened from the menus: cancel the search running behind it.
      else if (pa.menuCancel && this.menu.visible) this.menu.cancelSearch();
    } else if (this.training !== null && this.training.phase === 'summary') {
      // The pack summary owns the edges: retry, back to the menu, or pick a shot.
      this.trainingSummaryActions();
    } else {
      const wasPaused = this.paused;
      // Esc / Start toggle the pause, a bare back edge (Backspace, pad B) resumes, nothing quits
      // (src/game/pauseKeys.ts; only QUIT leaves). A keyboard pause edge right after the
      // pointer-lock release already paused us is that same Escape (dropped); a pad Start
      // (pa.pause) never is. The pause menu's own edges: arrows / WASD / D-pad / stick move the
      // focus, Enter / A activate, pad X opens the settings.
      const dropPause = !pa.pause && this.time - this.unlockPausedAt <= UNLOCK_PAUSE_WINDOW;
      const pk = pauseKeyAction(a.pause, a.back, this.paused, dropPause);
      if (pk === 'toggle') this.setPaused(!this.paused);
      else if (pk === 'resume') {
        // Pad B is boost too: held on past the resume it would boost at once.
        if (hud.pauseMenuVisible) {
          this.input.blockBoostUntilRelease();
          this.resumeFromMenu();
        }
      } else if (pk === 'menu') this.pauseMenuActions();
      if (a.toggleBallCam) {
        this.chase.toggle();
        hud.setCameraMode(this.chase.ballCam);
        if (this.touch !== null) this.touch.setBallCam(this.chase.ballCam);
      }
      // No kickoff reset online: the host owns the state. Training has its own resets. Not on the
      // press that resumed (Backspace is also free play's reset ball).
      if (this.training !== null) {
        if (!wasPaused && !this.paused) this.trainingActions();
      } else if (a.reset && !wasPaused && !this.paused && !this.carsFrozen && !this.onlineActive) this.resetToKickoff();
    }
    input.consumeActions();
  }

  /**
   * Draw the frame: the views (`dt`: seconds since the last drawn frame, 0 after a held one), the
   * camera (the menus' orbit or the chase camera), the HUD and the renderer. `frameTime`: the
   * rAF time for dynamic resolution, undefined for a paced or held frame (Renderer.render).
   */
  private render(dt: number, inMenu: boolean, frameTime: number | undefined): void {
    const prev = this.prev;
    const cur = this.cur;
    const alpha = this.alpha;
    const renderer = this.renderer;
    const camera = renderer.camera;

    // Views get a zero dt while paused so spin, flames and particles freeze with the sim.
    const viewDt = this.paused ? 0 : dt;
    const cars = this.cars;
    const offs = this.carOffsets;
    for (let i = 0; i < cars.length; i++) cars[i].update(prev, cur, offs[i], alpha, viewDt);
    this.ball.update(prev, cur, alpha, viewDt);
    // Online (phase 1): the rollback's visual error offsets (uu) keep the player's car and the
    // ball where they were shown and glide them to the corrected state. three = (sim.x, sim.z, sim.y).
    const session = this.session;
    const sessionActive = session !== null && session.active;
    const ec = sessionActive ? (session.errorOffsetCar ?? null) : null;
    const eb = sessionActive ? (session.errorOffsetBall ?? null) : null;
    if (ec !== null && eb !== null) {
      const cp = cars[this.playerIndex].position;
      cp.x += ec[0];
      cp.y += ec[2];
      cp.z += ec[1];
      const bp = this.ball.position;
      bp.x += eb[0];
      bp.y += eb[2];
      bp.z += eb[1];
    }
    this.effects.update(prev, cur, alpha, viewDt, this.carSlots);

    for (let i = 0; i < NUM_BOOST_PADS; i++) {
      const o = PADS_OFFSET + i * PAD_STRIDE;
      this.arena.setPadState(i, cur[o + P_IS_ACTIVE] > 0.5, cur[o + P_COOLDOWN]);
    }
    this.arena.update(dt, this.time);

    // Camera.
    const po = this.playerOff;
    if (inMenu) {
      // The orbit runs on the drawn frames' time: a held frame resumes it where it stopped.
      this.orbitTime += dt;
      const a = this.orbitTime * MENU_ORBIT_RATE;
      camera.position.set(Math.sin(a) * MENU_ORBIT_RADIUS, MENU_ORBIT_HEIGHT, Math.cos(a) * MENU_ORBIT_RADIUS);
      camera.up.set(0, 1, 0);
      camera.lookAt(this.menuLook);
      this.snapCamera = true;
      this.hud.setBallIndicator(false);
    } else {
      const cs = this.camState;
      const vx = cur[po + C_VEL];
      const vy = cur[po + C_VEL + 1];
      const vz = cur[po + C_VEL + 2];
      cs.speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      cs.grounded = cur[po + C_IS_ON_GROUND] > 0.5;
      cs.supersonic = cur[po + C_IS_SUPERSONIC] > 0.5;
      const player = cars[this.playerIndex];
      // Camera swivel (right stick / mouse virtual stick) + rear view, straight from the input.
      // The wider mouse tilt applies to mouse swivels even with an idle controller plugged in.
      const input = this.input;
      const look = input.look;
      this.chase.swivelPitchDeg = input.lookSource === 'mouse' ? SWIVEL_PITCH_MOUSE_DEG : SWIVEL_PITCH_STICK_DEG;
      if (this.snapCamera) {
        this.snapCamera = false;
        this.chase.snapTo(camera, player.position, player.quaternion, this.ball.position, cs, look);
      } else {
        this.chase.update(camera, player.position, player.quaternion, this.ball.position, cs, this.paused ? 0 : dt, look);
      }
      this.updateBallIndicator(camera, cur);
    }

    // HUD.
    const hud = this.hud;
    const match = this.match;
    if (session !== null && sessionActive) {
      hud.setScore(session.score.blue, session.score.red);
      hud.setClock(session.displaySeconds, session.clockMode);
      this.musicTension = session.clockMode === 'overtime' || (session.clockMode === 'regulation' && session.displaySeconds <= MUSIC_TENSION_SECONDS);
    } else {
      hud.setScore(match.score.blue, match.score.red);
      hud.setClock(match.displaySeconds, match.overtime ? 'overtime' : match.isUnlimited ? 'unlimited' : 'regulation');
      this.musicTension = this.training === null && (match.overtime || (!match.isUnlimited && match.displaySeconds <= MUSIC_TENSION_SECONDS));
    }
    // The notch under the player's team; the network bars by the clock while online.
    hud.setTeam(this.sbRows[this.playerSlot]?.team === 1 ? 1 : 0);
    hud.setNetBars(session !== null && sessionActive ? netBars(session.stats.rttMs, session.stats.lossPct) : 0);
    if (session !== null) {
      // Network panel (F4 / #net, auto while online in debug), the stall hint.
      hud.setNetAuto(sessionActive);
      if (hud.netVisible) hud.setNetStats(session.stats);
      hud.setNetWait(sessionActive && !inMenu ? session.hint : null);
    }
    // Boost and speed change every frame: 10 Hz on cpuLite (each change rewrites DOM text).
    if (!this.cpuLite || this.time - this.hudAt >= HUD_LITE_INTERVAL || this.time < this.hudAt) {
      this.hudAt = this.time;
      hud.setBoost(cur[po + C_BOOST]);
      hud.setSpeed(this.camState.speed, cur[po + C_IS_SUPERSONIC] > 0.5);
    }

    const ds = diagStats;
    const tr = ds !== null ? performance.now() : 0;
    if (this.warmFrames > 0) {
      this.warmFrames--;
      // An on-screen frame: the ball's shadow stays as the stadium wants it (its pipeline was built
      // by the warm-up behind the loading screen; only the console's setQuality skips that).
      this.setWarm(true);
      renderer.render(frameTime);
      this.setWarm(false);
    } else {
      renderer.render(frameTime);
    }
    if (ds !== null) ds.add('render', performance.now() - tr);
  }

  /**
   * The frame's work besides drawing, on every frame that runs the game's logic, drawn or not (a
   * held frame under the pause or the settings screen still lets it move on): the held scoreboard,
   * the touch controls and the upright pause, the pointer-lock hint, the GO caption, the return to
   * the menus after the whistle and the audio layers. `dt`: the loop's seconds since the last such frame.
   */
  private frameLogic(dt: number, inMenu: boolean): void {
    const hud = this.hud;
    const cur = this.cur;
    const po = this.playerOff;
    this.updateScoreboard(inMenu);
    // Training's panel (its setters skip unchanged values): the pause's Unlimited boost shows at once over a held frame.
    if (this.training !== null) this.updateTrainingHud();
    // On-screen controls (touch screens): up while a match is played in touch mode, the HUD in its
    // touch layout while that match is on screen (paused too). The last input used sets the mode; a
    // gamepad press turns it off (Input counts them, hasGamepad only says connected).
    const touch = this.touch;
    let touchMode = false;
    if (touch !== null) {
      touch.notePadPresses(this.input.gamepadPresses);
      touchMode = touch.touchMode;
      // An upright phone in touch mode: the rotate screen covers the match (src/input/touch.css; the
      // menus work upright, a tablet plays either way), so an offline match pauses, whether the
      // phone turned or touch mode came on while upright. Online it goes on (a pause only takes the
      // input away there).
      const q = this.portraitQuery;
      if (touchMode && this.playing && !this.onlineActive && q !== null && q.matches) this.setPaused(true);
      touch.setVisible(this.playing && touchMode, this.training !== null, touchMode && (this.playing || this.canResumeByPointer));
    }
    this.updateControlsCard(dt, inMenu, touchMode);
    this.updateLeaveGuard();
    // A controller press arms the system Back guard too (backGuard.ts: it carries no user activation).
    const presses = this.input.gamepadPresses;
    if (presses !== this.padPressesSeen) {
      this.padPressesSeen = presses;
      if (this.backGuard !== null) this.backGuard.arm();
      if (this.device !== null) this.device.notePadPresses(presses);
    }
    // Mouse look needs the pointer lock; pad players (a controller connected), fingers and keyboard-only
    // players (no action on a mouse button: their live bindings) are not nagged.
    hud.showHint(this.canPointerLock && !this.input.pointerLocked && !this.input.hasGamepad && this.playing && !touchMode && usesMouseButton(this.settings.bindings.kbm) ? POINTER_LOCK_HINT : null);
    if (this.goCaptionUntil >= 0 && this.time >= this.goCaptionUntil) {
      this.goCaptionUntil = -1;
      hud.showCountdown(null);
    }
    // A search that found its match (any session: 'queue' to connecting, signaling...): the band.
    const st = this.session !== null ? this.session.state : '';
    if (st !== this.sessionStateWas) {
      if (this.sessionStateWas === 'queue' && st !== 'idle' && st !== 'queue' && st !== '') this.matchFound();
      this.sessionStateWas = st;
    }
    if (this.menuReturnAt >= 0 && performance.now() * 0.001 >= this.menuReturnAt) {
      this.menuReturnAt = -1;
      // The timer belongs to the match that ended; a session started since (queueing, connecting
      // or already playing the next match) must not be left by it: showMenu() leaves the session.
      const s = this.session;
      if (s === null || !(s.busy || s.inMatch)) this.showMenu();
    }

    // Audio (engine / boost / wind layers follow the player's car).
    const as = this.audioState;
    if (inMenu || this.paused) {
      as.speed = 0;
      as.forwardSpeed = 0;
      as.boosting = false;
      as.supersonic = false;
      as.grounded = true;
      as.throttle = 0;
    } else {
      as.speed = this.camState.speed;
      const v = po + C_VEL;
      const f = po + C_ROT;
      as.forwardSpeed = cur[v] * cur[f] + cur[v + 1] * cur[f + 1] + cur[v + 2] * cur[f + 2];
      as.boosting = cur[po + C_IS_BOOSTING] > 0.5;
      as.supersonic = cur[po + C_IS_SUPERSONIC] > 0.5;
      as.grounded = cur[po + C_IS_ON_GROUND] > 0.5;
      as.throttle = this.playerControls.throttle;
    }
    this.audio.update(dt, as);
    // Music: the menu theme, the match, the tension of the last seconds and overtime.
    this.audio.setMusic(inMenu ? 'menu' : this.musicTension ? 'tension' : 'play', this.paused && !inMenu);
  }

  /** The Tab / Back scoreboard: shown while the binding is held (never over the menu). */
  private updateScoreboard(inMenu: boolean): void {
    const d = this.scoreboardData;
    if (inMenu || !this.input.held.scoreboard) {
      this.hud.showScoreboard(false, d);
      return;
    }
    const session = this.session !== null && this.session.active ? this.session : null;
    if (session !== null) {
      d.blue = session.score.blue;
      d.red = session.score.red;
      d.difficulty = session.kind === 'p2p' ? SCOREBOARD_ONLINE_P2P : SCOREBOARD_ONLINE;
      d.mode = this.mode;
      const sec = session.displaySeconds;
      const overtime = session.overtime;
      if (sec !== this.sbClockSec || overtime !== this.sbClockOvertime) {
        this.sbClockSec = sec;
        this.sbClockOvertime = overtime;
        d.clock = session.formatClock();
      }
      this.hud.showScoreboard(true, d);
      return;
    }
    const match = this.match;
    d.blue = match.score.blue;
    d.red = match.score.red;
    d.difficulty = SCOREBOARD_DIFFICULTY[this.difficulty];
    d.mode = this.mode;
    const sec = match.displaySeconds;
    const overtime = match.overtime;
    if (sec !== this.sbClockSec || overtime !== this.sbClockOvertime) {
      this.sbClockSec = sec;
      this.sbClockOvertime = overtime;
      d.clock = match.formatClock();
    }
    this.hud.showScoreboard(true, d);
  }

  /**
   * The browser released the pointer lock (Esc, alt-tab, a permission prompt): Esc means pause,
   * and Chrome never delivers that Escape keydown to the page, so pause here. When the
   * keydown IS delivered as well, processActions() drops it (UNLOCK_PAUSE_WINDOW). Releases the
   * game itself requested (pause / menu / whistle) find `playing` false and do nothing.
   */
  private onPointerLock(locked: boolean): void {
    if (locked || !this.playing) return;
    this.setPaused(true);
    this.unlockPausedAt = this.time;
  }

  /**
   * Off-screen ball indicator (a ball glyph with an arrow pinned to the screen edge). The ball is
   * projected with the camera pose that renders this frame; behind the camera the projection flips
   * through the eye plane, so the view-space direction is used instead. No allocations.
   */
  private updateBallIndicator(camera: THREE.PerspectiveCamera, cur: Float32Array): void {
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const v = _ind.copy(this.ball.position).applyMatrix4(camera.matrixWorldInverse);
    let nx: number;
    let ny: number;
    if (v.z > -camera.near) {
      // Behind (or within the near plane): point along the view-space direction, default below.
      nx = v.x;
      ny = v.y;
      if (nx * nx + ny * ny < 1e-6) {
        nx = 0;
        ny = -1;
      }
    } else {
      v.applyMatrix4(camera.projectionMatrix); // NDC (perspective divide included)
      nx = v.x;
      ny = v.y;
      if (nx > -1 && nx < 1 && ny > -1 && ny < 1) {
        this.hud.setBallIndicator(false);
        return;
      }
    }
    const k = Math.max(Math.abs(nx), Math.abs(ny));
    nx = (nx / k) * BALL_IND_INSET_X;
    ny = (ny / k) * BALL_IND_INSET_Y;
    const po = this.playerOff;
    const dx = cur[BALL_OFFSET + B_POS] - cur[po + C_POS];
    const dy = cur[BALL_OFFSET + B_POS + 1] - cur[po + C_POS + 1];
    const dz = cur[BALL_OFFSET + B_POS + 2] - cur[po + C_POS + 2];
    this.hud.setBallIndicator(true, nx, ny, Math.atan2(ny, nx) * RAD_TO_DEG, Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.01);
  }

  /** The 4 Hz housekeeping and the drawn frame rate (`fps`, the F3 line): every frame of logic, `drawn` or not. */
  private updateFps(now: number, drawn: boolean): void {
    if (drawn) this.fpsFrames++;
    if (this.fpsWindowStart === 0) this.fpsWindowStart = now;
    const elapsed = now - this.fpsWindowStart;
    if (elapsed < FPS_INTERVAL) return;
    this.fps = this.fpsFrames / elapsed;
    this.fpsFrames = 0;
    this.fpsWindowStart = now;
    // Audio unlock: the gesture listeners go once the context runs and come back when the system
    // takes it away (they only go after it ran, so a held context now was interrupted).
    if (this.gestureListening) {
      if (this.audio.running) this.removeGestureListeners();
    } else if (this.audio.suspended) this.addGestureListeners();
    if (this.installHint) this.updateInstallHint();
    // A ranked result held while the menus were away: out as soon as they are back without a
    // showMenu (the settings screen closed, a connection to a match failed).
    this.rankedResults.showHeld();
    const stats = this.renderer.stats();
    // GPU frame time when the renderer exposes it (timestamp queries); guarded so either renderer works.
    const gpuMs = (this.renderer as unknown as { gpuTimeMs?: number }).gpuTimeMs;
    const gpuInfo = typeof gpuMs === 'number' && gpuMs >= 0 ? ` · gpu ${gpuMs.toFixed(1)} ms` : '';
    // Dynamic-resolution scale of the scene pass (tiers that have it).
    const resInfo = Number.isNaN(stats.resolutionScale) ? '' : ` · res ${stats.resolutionScale.toFixed(2)}`;
    // Gamepad input never unlocks audio (no user activation): tell pad-only players what to press.
    const soundHint = !this.audio.running && this.input.hasGamepad && !this.menuShown ? ' · press a key or click for sound' : '';
    this.hud.setFps(this.fps, `${this.renderer.isWebGPU ? 'WebGPU' : 'WebGL2'} · ${stats.drawCalls} draws${gpuInfo}${resInfo}${soundHint}`);
  }

  /**
   * The iPhone's add-to-home-screen toast (installHintDue), once: as soon as the menus are on
   * screen and not under the settings screen, where it would go unseen (the menus work upright:
   * the rotate screen is the match's only).
   */
  private updateInstallHint(): void {
    const touch = this.touch;
    if (touch === null || !this.menu.visible || this.hud.menuVisible) return;
    this.installHint = false;
    noteInstallHintShown();
    this.menu.toast(t('touch.installHint'), 'info');
  }

  // ---- the match's end, its goals, PARTIDO ENCONTRADO -------------------------------------

  /** A new match: no goals, no demolitions, no FINAL yet, the feed empty. */
  private newMatchStats(): void {
    this.goals.fill(0);
    this.demos = 0;
    this.playFrom = 0;
    this.finalView = null;
    this.hud.clearFeed();
  }

  /**
   * A goal for `team` (any path: the offline match, the host, the P2P timeline): its scorer is the
   * team's last toucher of the play, from the state buffer the client already has (goalScorer);
   * ¡GOOOL! with the scorer's chip, without it when nobody of that team touched the ball.
   */
  private creditGoal(team: 0 | 1, blue: number, red: number): void {
    const slot = goalScorer(this.cur, team, this.playFrom);
    if (slot >= 0) this.goals[slot]++;
    const row = slot >= 0 ? this.sbRows[slot] : undefined;
    this.hud.showGoal(team, row !== undefined ? this.rowName(row) : null, blue, red);
  }

  /** A scoreboard row's name, the player's own without its "(You)" (the FINAL and the goal chip say it their way). */
  private rowName(r: ScoreboardRow): string {
    if (!r.you) return r.name;
    return this.accounts.account?.name ?? (this.online !== null ? this.online.name : t('game.guestName'));
  }

  /**
   * The final whistle (any path): the result, what the FINAL shows, and FINAL_SECONDS later the
   * FINAL (frameLogic: only when no session is busy or in a match by then).
   */
  private matchEnded(winner: 0 | 1 | null, blue: number, red: number): void {
    this.lastResult = { winner, blue, red };
    this.menuReturnAt = performance.now() * 0.001 + FINAL_SECONDS;
    this.input.exitPointerLock();
    const me = this.sbRows[this.playerSlot];
    const players: FinalPlayer[] = this.sbRows.map((r, slot) => ({ name: this.rowName(r), team: r.team, you: r.you, bot: !r.you && r.bot !== false, goals: this.goals[slot] ?? 0 }));
    const online = this.online;
    const onServer = online !== null && this.session === online;
    const host = this.session !== null ? this.session.stats.host : '';
    const req = this.searchReq;
    this.finalView = {
      kind: this.matchKind,
      winner,
      team: me !== undefined ? me.team : 0,
      blue,
      red,
      mode: this.mode,
      region: req !== null ? req.region : null,
      players,
      node: isNodeHost(host) ? host.slice(host.indexOf(':') + 1) : null,
      rankedMatchId: onServer && online.ranked ? online.lastRankedMatchId : null,
    };
  }

  /**
   * A search found its match (the Worker's matched answer, a P2P room): PARTIDO ENCONTRADO over
   * whatever is on screen, a short cue and the tab's title; the match follows by itself. The one
   * entry point for it (plan PR 6: a free practice during the search hands off through here).
   */
  matchFound(): void {
    const req = this.searchReq;
    if (req === null) return;
    const region = req.region ?? this.menu.regionId;
    const line = [t(req.kind === 'ranked' ? 'play.rankedTitle' : 'play.casualTitle'), ...req.modes, region !== null ? regionName(region) : null].filter((x) => x !== null).join(' · ');
    this.found.show(line);
    this.audio.playMatchFound();
  }

  // ---- menu ------------------------------------------------------------------------------

  /** The menus back. `keepSearch`: a session still queueing stays (search practice quit: stopTraining). */
  private showMenu(keepSearch = false): void {
    // An online match (or one being set up) ends here: sockets closed, offline roster back.
    const session = this.session;
    if (session !== null && session.state !== 'idle' && !(keepSearch && session.busy)) session.leave();
    const online = this.online;
    this.setPaused(false);
    this.ballPinned = false;
    // The controls card goes; the next countdown is the next match's first kickoff.
    this.controlsCard.arm();
    this.input.exitPointerLock(); // the menu is mouse-driven
    // The stick still steering at the final whistle walks no focus: the repeat needs a new press.
    this.input.resetMenuRepeat();
    this.hud.hideBanner(); // the "X WINS" banner is sticky and would bleed through the menu backdrop
    this.hud.showCountdown(null);
    // The last match's result: the FINAL (plan PR 7: it absorbs the result dialog); a disconnect's
    // reason as a toast over the menus.
    const result = this.lastResult;
    const final = result !== null ? this.finalView : null;
    if (result !== null && final === null) {
      const detail = this.menuNotice ?? `${result.blue} – ${result.red}`;
      this.menu.toast(result.winner === null ? t('game.resultDraw', { detail }) : t('game.resultWin', { team: TEAM_LABEL[result.winner], detail }), 'info');
    }
    else if (this.menuNotice !== undefined && this.menuNotice.length > 0) this.menu.toast(this.menuNotice, 'info');
    if (this.tierNotice !== null) this.menu.toast(this.tierNotice, 'info');
    this.tierNotice = null;
    this.lastResult = null;
    this.menuNotice = undefined;
    this.hud.hideMenu();
    // Back from a custom lobby's match: the lobby hears it at once (it starts again only once every
    // member is back). Without a FINAL its screen comes back (its show() tells the lobby), wherever
    // the menus were left; with one the lobby is told here, as the FINAL's MENÚ and Back go to Inicio
    // (its PLAY AGAIN opens the lobby).
    if (this.lobby.inLobby && this.lobby.me?.inGame === true) {
      if (final !== null) this.lobby.back();
      else if (this.menu.top()?.id !== 'lobby') this.menu.open('lobby');
    }
    this.menu.show(final !== null ? 'final' : undefined);
    this.flushNotices();
    // What an earlier ranked match's wait got while the menus were away comes first. Then, when a
    // ranked match just ended, its rating change once AccountsDO has it (on a community node only
    // after the replay check: a longer wait, announced once).
    this.rankedResults.showHeld();
    const ranked = online !== null ? online.lastRankedMatchId : null;
    if (online !== null && ranked !== null) {
      online.lastRankedMatchId = null;
      // Into the FINAL's rank card while it is up for this match; else the old way (held, a dialog).
      void this.rankedResults.watch(ranked, online.lastRankedOnNode, final !== null ? (r) => this.finalUi?.setRank(ranked, r) ?? false : undefined);
    }
    // A tier picked during the online match that needs a reload (switchQuality): now.
    const pending = this.pendingRestart;
    if (pending !== null) {
      this.pendingRestart = null;
      this.hud.setQualityPending(null);
      void this.restartOn(pending, null);
    }
  }

  // ---- events ----------------------------------------------------------------------------

  private onMatchEvent(e: MatchEvent): void {
    const hud = this.hud;
    switch (e.type) {
      case 'kickoffReset':
        this.resetToKickoff();
        break;
      case 'freeze':
        break;
      case 'countdown':
        hud.showCountdown(e.n);
        this.audio.playCountdownTick();
        this.cardCountdown();
        break;
      case 'go':
        hud.showCountdown('GO');
        this.audio.playGo();
        this.goCaptionUntil = this.time + GO_CAPTION_SECONDS;
        this.controlsCard.go();
        this.playFrom = this.cur[H_TICK_COUNT];
        break;
      case 'goal':
        this.creditGoal(e.team, e.blue, e.red);
        break;
      case 'overtime':
        hud.showOvertime();
        break;
      case 'ended': {
        const s = this.match.score;
        hud.showBanner(t('game.teamWins', { team: TEAM_NAME[e.winner] }), `${s.blue} – ${s.red}`, 0, e.winner);
        this.matchEnded(e.winner, s.blue, s.red);
        break;
      }
      default:
        break;
    }
  }

  private onSimGoal(team: Team): void {
    // Only a goal the match accepts gets a celebration: the sim reports a new goal whenever the
    // ball re-enters a net after >= 1 tick outside, which also happens when it bounces back out
    // during the goal pause and gets knocked in again, or after the final whistle.
    const counted = this.training !== null ? this.training.onGoal(team) : this.match.onGoal(team);
    if (!counted) return;
    const b = this.sim.buf;
    const p = this.hitPos;
    p[0] = b[BALL_OFFSET + B_POS];
    p[1] = b[BALL_OFFSET + B_POS + 1];
    p[2] = b[BALL_OFFSET + B_POS + 2];
    // Hold the ball where it scored for the rest of the pause (a hard shot would
    // otherwise rebound off the back of the net and roll out under the GOAL banner).
    this.ballPinned = true;
    this.pinPos[0] = p[0];
    this.pinPos[1] = p[1];
    this.effects.onGoal(team, p);
    this.audio.playGoal(team);
    this.input.rumble(0.6, 0.6, 350);
  }

  /** Keep the pinned ball at its scoring x/y; it still falls and settles vertically inside the net. */
  private pinBall(): void {
    const b = this.sim.buf;
    const p = this.pinPos;
    const v = this.pinVel;
    p[2] = b[BALL_OFFSET + B_POS + 2];
    v[2] = b[BALL_OFFSET + B_VEL + 2];
    this.sim.setBallState(p, v, ZERO_VEC);
  }

  private onSimBump(bumperId: number, victimId: number, isDemo: boolean): void {
    if (this.onlineActive) {
      const t = this.sim.tickCount;
      if (t - this.lastBumpFxTick < BUMP_FX_MIN_TICKS_ONLINE) return;
      this.lastBumpFxTick = t;
    }
    this.audio.playCarHit(isDemo ? 1 : 0.6);
    if (isDemo && bumperId === this.playerCarId && victimId !== this.playerCarId && !this.menuShown && this.training === null) this.hud.feed(t('hud.demolished', { count: ++this.demos }), 'demo');
    if (bumperId === this.playerCarId || victimId === this.playerCarId) {
      this.input.rumble(isDemo ? 1 : 0.5, isDemo ? 0.8 : 0.4, isDemo ? 400 : 140);
    }
  }

  /**
   * A car blew up on screen (Effects, three.js coords): the explosion sound, full volume for the
   * player's own car, quieter with the distance from the camera for the others.
   */
  private onDemolition(slot: number, x: number, y: number, z: number): void {
    if (this.menuShown) return;
    let strength = 1;
    if (slot !== this.playerSlot) {
      const c = this.renderer.camera.position;
      const d = Math.hypot(x - c.x, y - c.y, z - c.z);
      strength = Math.min(1, Math.max(0.2, 1.15 - d / 7000));
    }
    this.audio.playDemolition(strength);
  }

  private onSimBallHit(carId: number, relSpeed: number): void {
    // Every touch counts for the goalie save rule, however soft (before the FX filter).
    if (this.training !== null && carId === this.playerCarId) this.training.onPlayerTouch();
    if (relSpeed < HIT_FX_MIN_SPEED || this.ballPinned) return;
    const slot = this.sim.slotOf(carId);
    if (slot < 0) return;
    const tick = this.sim.tickCount;
    if (tick - this.lastHitTick[slot] < HIT_FX_MIN_TICKS) return;
    this.lastHitTick[slot] = tick;
    const b = this.sim.buf;
    const p = this.hitPos;
    p[0] = b[BALL_OFFSET + B_POS];
    p[1] = b[BALL_OFFSET + B_POS + 1];
    p[2] = b[BALL_OFFSET + B_POS + 2];
    this.effects.onBallHit(p, relSpeed);
    this.audio.playBallHit(relSpeed / 3000);
    if (carId === this.playerCarId) this.input.rumble(Math.min(1, relSpeed / 2500), 0.3, 90);
  }

  /** A pad that was active last tick and is not any more was picked up by the nearest car. */
  private detectPadPickups(): void {
    const prev = this.prev;
    const cur = this.cur;
    const po = this.playerOff;
    for (let i = 0; i < NUM_BOOST_PADS; i++) {
      const o = PADS_OFFSET + i * PAD_STRIDE + P_IS_ACTIVE;
      if (prev[o] < 0.5 || cur[o] > 0.5) continue;
      const big = i < BOOST_PADS_BIG.length;
      const pad = big ? BOOST_PADS_BIG[i] : BOOST_PADS_SMALL[i - BOOST_PADS_BIG.length];
      this.effects.onPadPickup(pad, big);
      const dx = cur[po + C_POS] - pad[0];
      const dy = cur[po + C_POS + 1] - pad[1];
      if (dx * dx + dy * dy < PAD_SOUND_DIST * PAD_SOUND_DIST) {
        this.audio.playPadPickup(big);
        this.input.rumble(big ? 0.4 : 0.15, 0.2, big ? 120 : 60);
      }
    }
  }

  /** Jump / dodge / landing one-shots from the player's car state edges. */
  private detectPlayerSounds(): void {
    const prev = this.prev;
    const cur = this.cur;
    const o = this.playerOff;
    if (prev[o + C_HAS_JUMPED] < 0.5 && cur[o + C_HAS_JUMPED] > 0.5) this.audio.playJump();
    if (prev[o + C_IS_FLIPPING] < 0.5 && cur[o + C_IS_FLIPPING] > 0.5) this.audio.playDodge();
    else if (prev[o + C_HAS_DOUBLE_JUMPED] < 0.5 && cur[o + C_HAS_DOUBLE_JUMPED] > 0.5) this.audio.playJump();
    if (prev[o + C_IS_ON_GROUND] < 0.5 && cur[o + C_IS_ON_GROUND] > 0.5 && prev[o + C_HAS_JUMPED] > 0.5) {
      this.audio.playLand(prev[o + C_VEL + 2] < -HARD_LANDING_VZ);
    }
  }

  // ---- views -----------------------------------------------------------------------------

  private buildViews(q: Quality): void {
    const scene = this.renderer.scene;
    this.arena = new ArenaView(scene, this.arenaMesh, q, this.theme);
    this.ball = new BallView(scene, q);
    this.applyBallShadow();
    this.buildCarViews(q);
    this.placeViews();
  }

  /** One CarView per roster entry (team colours from the sim) plus the Effects with every car registered. */
  private buildCarViews(q: Quality): void {
    const scene = this.renderer.scene;
    const sim = this.sim;
    const config = sim.getCarConfig(CarPreset.Standard);
    const slots = this.carSlots;
    const cars: CarView[] = [];
    this.effects = new Effects(scene, q, this.renderer.camera);
    this.effects.onDemolition = (slot, x, y, z) => this.onDemolition(slot, x, y, z);
    for (let i = 0; i < slots.length; i++) {
      const team = sim.teamOf(slots[i]);
      cars.push(new CarView(scene, config, team, q));
      this.effects.registerCar(slots[i], team);
    }
    this.cars = cars;
  }

  /**
   * Roster change: only the cars and the effects are rebuilt (the arena and the ball stay). The
   * new views are built BEFORE the old ones are disposed so the shared car material keeps a
   * reference throughout (Car.ts acquire / release): no GPU material teardown and rebuild, no
   * extra pipeline warm-up for the body.
   */
  private rebuildCarViews(q: Quality): void {
    const oldEffects = this.effects;
    const oldCars = this.cars;
    this.buildCarViews(q);
    oldEffects.dispose();
    for (const c of oldCars) c.dispose();
  }

  /**
   * Place the cars and the ball at the current state right away (no interpolation on the first
   * frame); a held frame (menus, settings) is drawn again with them.
   */
  private placeViews(): void {
    this.redraw = true;
    const cars = this.cars;
    const offs = this.carOffsets;
    for (let i = 0; i < cars.length; i++) cars[i].update(this.cur, this.cur, offs[i], 1, 0);
    this.ball.update(this.cur, this.cur, 1, 0);
  }

  private disposeViews(): void {
    this.effects.dispose();
    this.ball.dispose();
    for (const c of this.cars) c.dispose();
    this.cars = [];
    this.arena.dispose();
  }

  // ---- roster ----------------------------------------------------------------------------

  /**
   * Resolve a roster (car ids in creation order, player first) against the sim: slots and buffer
   * offsets per entry, the bot slots / control objects per team, the scoreboard rows. Every array
   * is refilled in place so the views, the Effects and the Hud keep their references.
   */
  private applyRoster(ids: readonly number[]): void {
    const sim = this.sim;
    if (ids.length === 0 || ids[0] !== this.playerCarId) throw new Error('Game: the roster must start with the player car');
    if (ids.length > MAX_CARS) throw new Error(`Game: roster of ${ids.length} cars exceeds MAX_CARS (${MAX_CARS})`);
    const carIds = this.carIds;
    const slots = this.carSlots;
    const offs = this.carOffsets;
    const rows = this.sbRows;
    carIds.length = 0;
    slots.length = 0;
    offs.length = 0;
    rows.length = 0;
    this.redSlots.length = 0;
    this.redOuts.length = 0;
    this.blueSlots.length = 0;
    this.blueOuts.length = 0;
    let blueBots = 0;
    let redBots = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const slot = sim.slotOf(id);
      if (slot < 0) throw new Error(`Game: car id ${id} is not in the arena`);
      carIds.push(id);
      slots.push(slot);
      offs.push(sim.carOffset(slot));
      const team = i === 0 ? Team.Blue : sim.teamOf(slot);
      if (i === 0) {
        rows.push({ name: t('game.you'), team: Team.Blue, you: true });
      } else if (team === Team.Red) {
        this.redSlots.push(slot);
        this.redOuts.push(this.controls[i]);
        rows.push({ name: t('game.botName', { number: ++redBots }), team, you: false });
      } else {
        this.blueSlots.push(slot);
        this.blueOuts.push(this.controls[i]);
        rows.push({ name: t('game.botName', { number: ++blueBots }), team, you: false });
      }
    }
    this.playerSlot = slots[0];
    this.playerOff = offs[0];
    this.playerIndex = 0;
    this.playerControls = this.controls[0];
    this.bots.setSlots(this.redSlots);
    // The human is a passive member of its bots' team: ranked for roles, kickoff duties, lane and
    // yield rules like any teammate (so the bots rotate around it), never driven.
    this.mates.setSlots(this.blueSlots, [this.playerSlot]);
    this.bots.reset();
    this.mates.reset();
    this.lastHitTick.fill(-1e9);
  }
}

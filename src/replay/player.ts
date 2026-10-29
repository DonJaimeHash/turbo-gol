/**
 * The replay player: re-simulates a community-node replay (nodes/shared/replay.ts) and draws it
 * with the game's own views and HUD.
 *
 * A replay holds only the controls the host applied to the human slots, so the match is played
 * again exactly as the verifiers do it (nodes/shared/verify.ts): a fresh arena with the roster and
 * the kickoff seed, the same RoomHost (rules, bots, kickoffs) fed the recorded inputs and takeovers
 * tick by tick. Before the first frame the whole match is run once (`scan`): it finds the goals and
 * their scorers for the timeline and compares every state-hash checkpoint, so the viewer knows
 * up front whether this build reproduces the recording (a match played on another wasm, protocol
 * or JavaScript drifts away; from the first mismatch on, what is shown is not what was played).
 *
 * Seeking forward fast-forwards the sim; seeking back restarts it from tick 1 (a 3-minute match
 * runs in well under a second on a desktop).
 */
import * as THREE from 'three/webgpu';
import { RoomHost } from '../../server/src/roomHost';
import type { Replay } from '../../nodes/shared/replay';
import { t } from '../i18n';
import type { MatchEvent } from '../net/protocol';
import { ArenaView } from '../render/Arena';
import { BallView } from '../render/Ball';
import { ChaseCamera } from '../render/Camera';
import type { CameraCarState } from '../render/Camera';
import { CarView } from '../render/Car';
import { Effects } from '../render/Effects';
import { Hud } from '../render/Hud';
import type { Renderer } from '../render/Renderer';
import type { ArenaMesh } from '../sim/arenaMesh';
import { RocketSim } from '../sim/RocketSimBridge';
import {
  C_IS_ON_GROUND,
  C_IS_SUPERSONIC,
  C_VEL,
  CarPreset,
  NUM_BOOST_PADS,
  PACKED_INPUT_BYTES,
  PAD_STRIDE,
  PADS_OFFSET,
  P_COOLDOWN,
  P_IS_ACTIVE,
  STATE_BUFFER_FLOATS,
  TICK_DT,
  TICK_RATE,
} from '../sim/types';
import wasmUrl from '../sim/wasm/rocketsim.wasm?url';
import { drawsFrame } from '../render/quality';
import { goalScorer } from '../ui/screens/match/finalModel';
import { clockText, el } from './list';

/** Longest frame the loop catches up on (s). */
const MAX_FRAME_DT = 0.1;
/** Wall-clock budget per frame for a fast-forward or the scan (ms). */
const BUSY_BUDGET_MS = 25;
/** How long the GO caption stays (Game.ts GO_CAPTION_SECONDS). */
const GO_CAPTION_TICKS = Math.round(0.8 * TICK_RATE);
/** Name tags float this far above a car's origin (uu). */
const TAG_HEIGHT = 140;
const TEAM_NAME = [() => t('game.teamBlueUpper'), () => t('game.teamRedUpper')] as const;

/** One run of the match: a fresh sim and RoomHost, fed from tick 1. */
interface Run {
  sim: RocketSim;
  host: RoomHost;
  /** Current applied controls of every slot (the replay stores changes only). */
  cur: Int8Array;
  ii: number;
  ti: number;
  hi: number;
}

export interface Goal {
  tick: number;
  team: 0 | 1;
  /** The scorer's slot, -1 when none of the team touched the ball in that play. */
  slot: number;
}

export interface ScanResult {
  goals: Goal[];
  /** The first checkpoint that did not match (tick), -1 when every one did. */
  divergedAt: number;
  /** Checkpoints compared. */
  checked: number;
}

/**
 * rocketsim.wasm compiled once for the page: the scan and every back-seek instantiate it again (a
 * fresh instance: its own memory and arena) without fetching or compiling it again. Null when
 * streaming compilation is unavailable: RocketSim.load() then finds the file itself.
 */
let wasmModule: Promise<WebAssembly.Module | null> | null = null;
function compiledWasm(): Promise<WebAssembly.Module | null> {
  if (!wasmModule) {
    wasmModule = (typeof WebAssembly.compileStreaming === 'function' ? WebAssembly.compileStreaming(fetch(wasmUrl)) : Promise.reject(new Error('no compileStreaming'))).catch(() => null);
  }
  return wasmModule;
}

async function newRun(r: Replay, mesh: ArenaMesh): Promise<Run> {
  const h = r.header;
  const mod = await compiledWasm();
  const sim = mod ? await RocketSim.load({ wasmModule: mod }) : await RocketSim.load();
  sim.initArena(mesh.physics);
  sim.createArena(TICK_RATE);
  for (const e of h.roster) sim.addCar(e.team, CarPreset.Standard);
  sim.resetKickoff(h.kickoffSeed);
  sim.sync();
  const host = new RoomHost(sim, h.roster, {
    tickRate: TICK_RATE,
    snapshotEvery: 4,
    matchLengthSeconds: h.matchLengthSeconds,
    kickoffSeed: h.kickoffSeed,
    botDifficulty: h.botDifficulty,
    kickoffCountdownSeconds: h.kickoffCountdownSeconds,
    goalPauseSeconds: h.goalPauseSeconds,
  });
  host.start();
  return { sim, host, cur: new Int8Array(h.roster.length * PACKED_INPUT_BYTES), ii: 0, ti: 0, hi: 0 };
}

/** One tick of the re-simulation (verify.ts's loop body). Returns false when a checkpoint did not match. */
function step(rn: Run, r: Replay): boolean {
  const host = rn.host;
  const T = host.currentTick + 1;
  while (rn.ti < r.takeovers.length && r.takeovers[rn.ti].tick <= T) {
    host.convertToBot(r.takeovers[rn.ti].slot);
    rn.ti++;
  }
  while (rn.ii < r.inputCount && r.inputTicks[rn.ii] === T) {
    const s = r.inputSlots[rn.ii];
    for (let k = 0; k < PACKED_INPUT_BYTES; k++) rn.cur[s * PACKED_INPUT_BYTES + k] = r.inputData[rn.ii * PACKED_INPUT_BYTES + k];
    rn.ii++;
  }
  const slots = r.header.roster.length;
  for (let s = 0; s < slots; s++) if (host.isHumanSlot(s)) host.addInputs(s, T, 1, rn.cur, s * PACKED_INPUT_BYTES);
  host.tick();
  if (rn.hi < r.hashCount && r.hashTicks[rn.hi] === T) {
    const ok = rn.sim.stateHash() >>> 0 === r.hashValues[rn.hi];
    rn.hi++;
    return ok;
  }
  return true;
}

/** The last tick to play: END, or the last record of a replay without one. */
export function endTickOf(r: Replay): number {
  if (r.end) return r.end.tick;
  let e = r.inputCount > 0 ? r.inputTicks[r.inputCount - 1] : 0;
  if (r.hashCount > 0) e = Math.max(e, r.hashTicks[r.hashCount - 1]);
  return e;
}

/**
 * Let the page breathe between two chunks of the scan. A message, not setTimeout: a tab in the
 * background throttles timers to one a second (the scan would take minutes), not messages.
 */
function yieldTask(): Promise<void> {
  return new Promise((res) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      res();
    };
    ch.port2.postMessage(0);
  });
}

/** Run the whole match once: the goals (and scorers) and the checkpoints. Yields every BUSY_BUDGET_MS. */
export async function scan(r: Replay, mesh: ArenaMesh, onProgress: (p: number) => void): Promise<ScanResult> {
  const rn = await newRun(r, mesh);
  const end = endTickOf(r);
  const events: MatchEvent[] = [];
  const goals: Goal[] = [];
  let divergedAt = -1;
  let playFrom = 0;
  while (rn.host.currentTick < end) {
    const t0 = performance.now();
    while (rn.host.currentTick < end && performance.now() - t0 < BUSY_BUDGET_MS) {
      if (!step(rn, r) && divergedAt < 0) divergedAt = rn.host.currentTick;
      rn.host.takeEvents(events);
      for (const e of events) {
        if (e.type === 'go') playFrom = e.tick;
        else if (e.type === 'goal') goals.push({ tick: e.tick, team: e.team, slot: goalScorer(rn.sim.buf, e.team, playFrom) });
      }
    }
    onProgress(end > 0 ? rn.host.currentTick / end : 1);
    await yieldTask();
  }
  return { goals, divergedAt, checked: rn.hi };
}

export interface PlayerOptions {
  replay: Replay;
  scan: ScanResult;
  renderer: Renderer;
  mesh: ArenaMesh;
  hudRoot: HTMLElement;
  tagsRoot: HTMLElement;
  bar: HTMLElement;
}

/** Play `replay` on the page: the views, the HUD, the name tags and the control bar. Returns its stop (the loop ends). */
export async function startPlayer(o: PlayerOptions): Promise<() => void> {
  const r = o.replay;
  const renderer = o.renderer;
  const scene = renderer.scene;
  const q = renderer.quality;
  const roster = r.header.roster;
  const endTick = endTickOf(r);

  let run = await newRun(r, o.mesh);
  const prev = new Float32Array(STATE_BUFFER_FLOATS);
  const cur = new Float32Array(STATE_BUFFER_FLOATS);
  const takeState = (): void => {
    prev.set(cur);
    cur.set(run.sim.buf.subarray(0, STATE_BUFFER_FLOATS));
  };
  cur.set(run.sim.buf.subarray(0, STATE_BUFFER_FLOATS));
  prev.set(cur);

  // Views (Game.buildViews).
  const arena = new ArenaView(scene, o.mesh, q, renderer.theme);
  const ball = new BallView(scene, q);
  const config = run.sim.getCarConfig(CarPreset.Standard);
  const effects = new Effects(scene, q, renderer.camera);
  const cars: CarView[] = [];
  const offsets: number[] = [];
  const slots: number[] = [];
  const tags: HTMLElement[] = [];
  for (const e of roster) {
    const team = run.sim.teamOf(e.slot);
    cars.push(new CarView(scene, config, team, q));
    effects.registerCar(e.slot, team);
    slots.push(e.slot);
    offsets.push(run.sim.carOffset(e.slot));
    const tag = el(`div.rp-tag.${e.team === 0 ? 'rp-blue' : 'rp-red'}`, null, e.name);
    o.tagsRoot.append(tag);
    tags.push(tag);
  }

  const hud = new Hud(o.hudRoot);
  // Super low drops the blur, shadows and decorative animation of the page (src/style.css), as the game does.
  document.documentElement.classList.toggle('tg-superlow', renderer.spec.cpuLite);
  const events: MatchEvent[] = [];
  const goalAt = new Map(o.scan.goals.map((g) => [g.tick, g]));

  // ---- the control bar ------------------------------------------------------------------------
  const playBtn = el('button.rp-btn.rp-primary', { type: 'button' }, t('replay.pause')) as HTMLButtonElement;
  const speedSel = el('select.rp-btn', { 'aria-label': t('replay.speed') }) as HTMLSelectElement;
  for (const s of [0.25, 0.5, 1, 2, 4, 8]) speedSel.append(el('option', { value: String(s) }, `${s}×`));
  speedSel.value = '1';
  const camSel = el('select.rp-btn', { 'aria-label': t('replay.camera') }) as HTMLSelectElement;
  camSel.append(el('option', { value: '0' }, `0 · ${t('replay.broadcast')}`));
  roster.forEach((e, i) => camSel.append(el('option', { value: String(i + 1) }, `${i + 1} · ${e.name}`)));
  const seek = el('input', { type: 'range', min: '0', max: String(endTick), step: '1', value: '0', 'aria-label': t('replay.title') }) as HTMLInputElement;
  const marks = el('div.rp-marks');
  for (const g of o.scan.goals) {
    const m = el(`div.rp-mark.${g.team === 0 ? 'rp-blue' : 'rp-red'}`);
    m.style.left = `${(100 * g.tick) / Math.max(1, endTick)}%`;
    marks.append(m);
  }
  const time = el('span.rp-time', null, '');
  const list = el('a.rp-btn', { href: './replay.html' }, t('replay.list'));
  o.bar.replaceChildren(
    el('div.rp-line', null, playBtn, el('div.rp-track', null, marks, seek), time),
    el('div.rp-line', null, speedSel, camSel, el('span.rp-keys.rp-grow', null, t('replay.keys', { max: roster.length })), list),
  );
  o.bar.classList.remove('rp-hidden');

  // ---- state ----------------------------------------------------------------------------------
  let acc = 0;
  let last = -1;
  let playing = true;
  let speed = 1;
  let seekTarget = -1;
  let restarting = false;
  /** The timeline thumb is held: playback does not move it meanwhile. */
  let dragging = false;
  /** The tick the GO caption goes at (-1: none showing). */
  let goHideTick = -1;
  let lastDrawn = -1;
  let camIndex = 0;
  let snapChase = true;
  const chase = new ChaseCamera();
  const camState: CameraCarState = { grounded: true, speed: 0, supersonic: false };
  const lookAt = new THREE.Vector3();
  const v = new THREE.Vector3();

  const setPlaying = (p: boolean): void => {
    playing = p;
    playBtn.textContent = p ? t('replay.pause') : t('replay.play');
  };
  const setCam = (n: number): void => {
    if (n < 0 || n > cars.length) return;
    camIndex = n;
    camSel.value = String(n);
    snapChase = true;
  };
  /** Where the viewer is, or is going: a seek in progress counts as done. */
  const pos = (): number => (seekTarget >= 0 ? seekTarget : run.host.currentTick);
  const seekTo = (tick: number): void => {
    const target = Math.max(0, Math.min(endTick, Math.round(tick)));
    seekTarget = target;
    // While a restart loads, the new run starts at tick 0 and fast-forwards to the latest target.
    if (target < run.host.currentTick && !restarting) {
      restarting = true;
      newRun(r, o.mesh).then(
        (rn) => {
          run = rn;
          cur.set(rn.sim.buf.subarray(0, STATE_BUFFER_FLOATS));
          prev.set(cur);
          restarting = false;
        },
        (e: unknown) => {
          console.error('replay restart failed', e);
          restarting = false;
          seekTarget = -1;
        },
      );
    }
  };
  const togglePlay = (): void => {
    if (!playing && pos() >= endTick) seekTo(0);
    setPlaying(!playing);
  };

  playBtn.addEventListener('click', togglePlay);
  speedSel.addEventListener('change', () => {
    speed = Number(speedSel.value) || 1;
  });
  camSel.addEventListener('change', () => setCam(Number(camSel.value) || 0));
  seek.addEventListener('pointerdown', () => {
    dragging = true;
  });
  const release = (): void => {
    dragging = false;
  };
  seek.addEventListener('pointerup', release);
  seek.addEventListener('pointercancel', release);
  seek.addEventListener('change', () => {
    dragging = false;
    seekTo(Number(seek.value));
  });
  window.addEventListener('keydown', (e) => {
    // Alt + ← is the browser's Back, Ctrl / Cmd + a digit its tabs.
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof HTMLSelectElement || (e.target instanceof HTMLInputElement && e.target.type !== 'range')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      e.preventDefault();
      seekTo(pos() + (e.code === 'ArrowLeft' ? -5 : 5) * TICK_RATE);
    } else if (/^Digit[0-8]$/.test(e.code)) {
      setCam(Number(e.code.slice(5)));
    }
  });

  /** The final whistle's banner (kept until a seek). */
  const showEnd = (winner: number, blue: number, red: number): void => {
    hud.showBanner(winner === 0 || winner === 1 ? t('game.teamWins', { team: TEAM_NAME[winner]() }) : t('game.draw'), `${blue} – ${red}`, 0, winner === 0 || winner === 1 ? winner : null);
  };

  /** The match events of the tick just run, to the HUD; `live` false while seeking (no banners). */
  const onEvents = (live: boolean): void => {
    run.host.takeEvents(events);
    if (!live) return;
    for (const e of events) {
      if (e.type === 'countdown') hud.showCountdown(e.n);
      else if (e.type === 'go') {
        hud.showCountdown('GO');
        goHideTick = e.tick + GO_CAPTION_TICKS;
      } else if (e.type === 'kickoff') {
        hud.showCountdown(null);
        goHideTick = -1;
      } else if (e.type === 'overtime') hud.showOvertime();
      else if (e.type === 'goal') {
        const g = goalAt.get(e.tick);
        const scorer = g && g.slot >= 0 ? (roster[g.slot]?.name ?? null) : null;
        hud.showGoal(e.team, scorer, e.blue, e.red);
      } else if (e.type === 'ended') showEnd(e.winner, e.blue, e.red);
    }
  };

  let hudAt = 0;
  const updateHud = (): void => {
    const m = run.host.match;
    hud.setScore(m.score.blue, m.score.red);
    hud.setClock(m.displaySeconds, m.overtime ? 'overtime' : m.isUnlimited ? 'unlimited' : 'regulation');
    const now = performance.now();
    if (now - hudAt < 100) return;
    hudAt = now;
    // While a seek runs, the thumb and the time show where it goes.
    const T = pos();
    if (!dragging) seek.value = String(T);
    time.textContent = `${clockText(T)} / ${clockText(endTick)}`;
  };

  const placeTags = (): void => {
    const camera = renderer.camera;
    const w = o.tagsRoot.clientWidth;
    const hgt = o.tagsRoot.clientHeight;
    for (let i = 0; i < cars.length; i++) {
      const tag = tags[i];
      if (camIndex === i + 1) {
        tag.style.transform = 'translate(-9999px, 0)';
        continue;
      }
      v.copy(cars[i].position);
      v.y += TAG_HEIGHT;
      v.project(camera);
      if (v.z > 1 || v.z < -1) {
        tag.style.transform = 'translate(-9999px, 0)';
        continue;
      }
      const x = ((v.x + 1) / 2) * w;
      const y = ((1 - v.y) / 2) * hgt;
      tag.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  };

  const draw = (alpha: number, dt: number): void => {
    for (let i = 0; i < cars.length; i++) cars[i].update(prev, cur, offsets[i], alpha, dt);
    ball.update(prev, cur, alpha, dt);
    effects.update(prev, cur, alpha, dt, slots);
    for (let i = 0; i < NUM_BOOST_PADS; i++) {
      const off = PADS_OFFSET + i * PAD_STRIDE;
      arena.setPadState(i, cur[off + P_IS_ACTIVE] > 0.5, cur[off + P_COOLDOWN]);
    }
    arena.update(dt, performance.now() / 1000);

    const camera = renderer.camera;
    const bp = ball.position;
    if (camIndex === 0) {
      // Broadcast: from inside the side wall, high, following the ball along the field (three z = sim y).
      camera.position.set(-3900, 1700, bp.z * 0.75);
      lookAt.set(bp.x * 0.5, Math.min(bp.y, 800) * 0.5, bp.z * 0.9);
      camera.up.set(0, 1, 0);
      camera.lookAt(lookAt);
      if (camera.fov !== 75) {
        camera.fov = 75;
        camera.updateProjectionMatrix();
      }
      snapChase = true;
    } else {
      const i = camIndex - 1;
      const po = offsets[i];
      const vx = cur[po + C_VEL];
      const vy = cur[po + C_VEL + 1];
      const vz = cur[po + C_VEL + 2];
      camState.speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      camState.grounded = cur[po + C_IS_ON_GROUND] > 0.5;
      camState.supersonic = cur[po + C_IS_SUPERSONIC] > 0.5;
      const car = cars[i];
      if (snapChase) {
        snapChase = false;
        chase.snapTo(camera, car.position, car.quaternion, bp, camState);
      } else {
        chase.update(camera, car.position, car.quaternion, bp, camState, dt);
      }
    }
    renderer.render(performance.now());
    placeTags();
  };

  let stopped = false;
  const frame = (now: number): void => {
    if (stopped) return;
    requestAnimationFrame(frame);
    const dt = last < 0 ? 0 : Math.min(MAX_FRAME_DT, (now - last) / 1000);
    last = now;
    if (restarting) return;
    if (seekTarget >= 0) {
      const t0 = performance.now();
      while (run.host.currentTick < seekTarget && performance.now() - t0 < BUSY_BUDGET_MS) {
        step(run, r);
        onEvents(false);
        takeState();
      }
      if (run.host.currentTick >= seekTarget) {
        seekTarget = -1;
        prev.set(cur);
        snapChase = true;
        hud.showCountdown(null);
        hud.hideBanner();
        goHideTick = -1;
        // A seek to the end lands after the whistle: its banner, which the fast-forward did not show.
        const m = run.host.match;
        if (run.host.ended) showEnd(m.winner ?? -1, m.score.blue, m.score.red);
        if (run.host.currentTick >= endTick) setPlaying(false);
      }
      acc = 0;
    } else if (playing) {
      acc += dt * speed;
      while (acc >= TICK_DT && run.host.currentTick < endTick) {
        step(run, r);
        onEvents(true);
        takeState();
        acc -= TICK_DT;
        if (goHideTick >= 0 && run.host.currentTick >= goHideTick) {
          hud.showCountdown(null);
          goHideTick = -1;
        }
      }
      if (run.host.currentTick >= endTick) {
        acc = 0;
        setPlaying(false);
      }
    }
    // The tier's frame cap (super low: 30 fps, as in the game): the sim keeps its time, the drawing skips.
    if (!drawsFrame(now, lastDrawn, renderer.spec.maxFps)) return;
    const drawDt = lastDrawn < 0 ? dt : Math.min(MAX_FRAME_DT, (now - lastDrawn) / 1000);
    lastDrawn = now;
    draw(seekTarget >= 0 || !playing ? 1 : acc / TICK_DT, playing && seekTarget < 0 ? drawDt * speed : 0);
    updateHud();
  };
  requestAnimationFrame(frame);
  return () => {
    stopped = true;
  };
}

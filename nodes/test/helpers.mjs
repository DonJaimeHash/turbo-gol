// Shared test helpers: scripted "human" drivers and a network-free recorded match.
import '../dev/ts-resolve.mjs';

const T = await import('../../src/sim/types.ts');
const { RoomHost } = await import('../../server/src/roomHost.ts');
const { createNodeArena, loadWasm } = await import('../shared/nodeArena.ts');
const { ReplayRecorder, CHECKPOINT_EVERY } = await import('../shared/replay.ts');
const P = await import('../../src/net/protocol.ts');

export { T, RoomHost, createNodeArena, loadWasm, ReplayRecorder, CHECKPOINT_EVERY, P };

/**
 * A deterministic ball chaser: full throttle, steer toward the ball, boost when roughly aligned,
 * a jump now and then. Writes 6 packed bytes into `out` at `off`. Reads the sim state buffer only.
 */
export function chaseInput(sim, slot, tick, out, off = 0) {
  const b = sim.buf;
  const o = T.CARS_OFFSET + slot * T.CAR_STRIDE;
  const px = b[o + T.C_POS];
  const py = b[o + T.C_POS + 1];
  const fx = b[o + T.C_ROT];
  const fy = b[o + T.C_ROT + 1];
  const bx = b[T.BALL_OFFSET + T.B_POS];
  const by = b[T.BALL_OFFSET + T.B_POS + 1];
  const dx = bx - px;
  const dy = by - py;
  const d = Math.hypot(dx, dy) || 1;
  const cross = (fx * dy - fy * dx) / d;
  const dot = (fx * dx + fy * dy) / d;
  const c = T.emptyControls();
  c.throttle = 1;
  c.steer = Math.max(-1, Math.min(1, cross * 3 + (dot < 0 ? Math.sign(cross || 1) : 0)));
  c.boost = dot > 0.9 && tick % 240 < 120;
  c.jump = tick % 480 < 8;
  c.handbrake = dot < -0.2 && tick % 60 < 10;
  T.packControls(c, out, off);
}

/** Packed controls that do nothing (a disconnected slot's applied input). */
export function idleInput(out, off = 0) {
  out.fill(0, off, off + T.PACKED_INPUT_BYTES);
}

export const FAKE_BUILD_VERSION = '0.0.0-test';

export async function testBuild() {
  const w = await loadWasm();
  return { version: FAKE_BUILD_VERSION, protocol: P.PROTOCOL_VERSION, wasmSha256: w.sha256 };
}

/** Roster helper: `spec` like ['p', 'b'] for team blue slot 0 human, red slot 1 bot (teams alternate by position in each half). */
export function roster1v1(humanBlue = true, humanRed = false) {
  return [
    { slot: 0, team: 0, kind: humanBlue ? 'player' : 'bot', name: 'Azul', ...(humanBlue ? { playerId: 'a'.repeat(16) } : {}) },
    { slot: 1, team: 1, kind: humanRed ? 'player' : 'bot', name: 'Rojo', ...(humanRed ? { playerId: 'b'.repeat(16) } : {}) },
  ];
}

export function roster2v2() {
  return [
    { slot: 0, team: 0, kind: 'player', name: 'A1', playerId: '1'.repeat(16) },
    { slot: 1, team: 0, kind: 'player', name: 'A2', playerId: '2'.repeat(16) },
    { slot: 2, team: 1, kind: 'player', name: 'R1', playerId: '3'.repeat(16) },
    { slot: 3, team: 1, kind: 'bot', name: 'Bot' },
  ];
}

/**
 * Play a match straight on a RoomHost (no sockets), recording it exactly like a node does.
 *   opts.roster, opts.lengthSeconds, opts.seed
 *   opts.underrunEvery: skip feeding a human slot on ticks where (tick % n === slot) (held input)
 *   opts.takeovers: [{ tick, slot }] explicit leaves (convertToBot between ticks)
 *   opts.idleSlots: { slot: fromTick } slots that go idle (zero inputs, like a disconnect)
 *   opts.stopAt: stop at this tick (forfeit / ttl / left endings) instead of the rules' whistle
 *   opts.endReason, opts.forfeitTeam: what to write in END when stopping early
 */
export async function playRecordedMatch(opts) {
  const roster = opts.roster;
  const seed = opts.seed ?? 1;
  const lengthSeconds = opts.lengthSeconds ?? 20;
  const build = await testBuild();
  const arena = await createNodeArena(roster, seed);
  const sim = arena.sim;
  const timing = { kickoffCountdownSeconds: opts.countdown ?? 1, goalPauseSeconds: opts.goalPause ?? 1 };
  const host = new RoomHost(sim, roster, {
    tickRate: 120,
    snapshotEvery: 4,
    matchLengthSeconds: lengthSeconds,
    kickoffSeed: seed,
    botDifficulty: opts.botDifficulty ?? 'medium',
    ...timing,
  });
  const header = {
    v: 1,
    matchId: opts.matchId ?? 'm'.repeat(32),
    nodeId: opts.nodeId ?? 'n'.repeat(16),
    build,
    mode: opts.mode ?? '1v1',
    region: opts.region ?? 'SA',
    ranked: opts.ranked ?? false,
    roster,
    matchLengthSeconds: lengthSeconds,
    kickoffSeed: seed,
    botDifficulty: opts.botDifficulty ?? 'medium',
    ...timing,
    tickRate: 120,
    checkpointEvery: opts.checkpointEvery ?? CHECKPOINT_EVERY,
    startedAt: 0,
  };
  const rec = new ReplayRecorder(header);
  const one = new Int8Array(T.PACKED_INPUT_BYTES);
  const takeovers = opts.takeovers ?? [];
  const idle = opts.idleSlots ?? {};
  const maxTicks = opts.stopAt ?? (lengthSeconds + 120) * 120;
  host.start();
  while (!host.ended && host.currentTick < maxTicks) {
    const next = host.currentTick + 1;
    for (const tk of takeovers) {
      if (tk.tick === next && host.isHumanSlot(tk.slot)) {
        host.convertToBot(tk.slot);
        rec.takeover(next, tk.slot);
      }
    }
    for (let s = 0; s < roster.length; s++) {
      if (!host.isHumanSlot(s)) continue;
      if (opts.underrunEvery && next % opts.underrunEvery === s) continue;
      if (idle[s] !== undefined && next >= idle[s]) idleInput(one);
      else chaseInput(sim, s, next, one);
      host.addInputs(s, next, 1, one, 0);
    }
    host.tick();
    rec.afterTick(host, sim);
  }
  const sc = host.score;
  const leader = sc.blue > sc.red ? 0 : sc.red > sc.blue ? 1 : -1;
  let end;
  if (host.ended) {
    const w = host.match.winner;
    end = { tick: host.currentTick, winner: w === 0 || w === 1 ? w : -1, blue: sc.blue, red: sc.red, reason: 'rules', forfeitTeam: -1 };
  } else {
    const reason = opts.endReason ?? 'left';
    const forfeitTeam = opts.forfeitTeam ?? -1;
    const winner = reason === 'forfeit' ? (forfeitTeam === 0 ? 1 : 0) : leader;
    end = { tick: host.currentTick, winner, blue: sc.blue, red: sc.red, reason, forfeitTeam };
  }
  rec.end(end);
  const bytes = rec.finish();
  return { bytes, header, end, host, sim, build };
}

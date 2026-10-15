// RollbackEngine (src/net/p2p/Rollback.ts) on the REAL RocketSim wasm: several engines, each on its
// own RocketSim instance, exchange input packets through simulated links (delay / jitter / loss /
// reordering, redundant resend of the unacked ticks every 2 ticks like the real client) and hash
// reports through a reliable link. The confirmed hashes at every tick multiple of 30 must match on
// every peer: with random human inputs (a), with BotTeam-driven bots and a Match on the confirmed
// timeline (b), after a drop (c), after an injected divergence + resync (d); a silent peer stalls
// the others (e); six humans (f); advance() cost (g).
//   node --test tests/p2p-rollback-wasm.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND') {
        if (!/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
        if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
});

const { RocketSim } = await import('../src/sim/RocketSimBridge.ts');
const { buildArenaMesh } = await import('../src/sim/arenaMesh.ts');
const T = await import('../src/sim/types.ts');
const P = await import('../src/net/p2p/protocol.ts');
const { RollbackEngine } = await import('../src/net/p2p/Rollback.ts');
const { BotTeam } = await import('../src/ai/Team.ts');
const { Match } = await import('../src/game/Match.ts');
const { fnv1a32 } = await import('../src/net/protocol.ts');

const { CarPreset, TICK_RATE, TICK_DT, PACKED_INPUT_BYTES } = T;
const mesh = buildArenaMesh().physics;
const ROOM_SEED = 7;
const HASH_EVERY = P.P2P_HASH_EVERY;
const MAX_BATCH = P.P2P_INPUT_MAX_BATCH;

// ---- helpers ------------------------------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh RocketSim instance with the roster's cars in slot order at the room's kickoff. */
async function arenaFor(teams) {
  const sim = await RocketSim.load();
  sim.initArena(mesh);
  sim.createArena(TICK_RATE);
  for (const team of teams) sim.addCar(team, CarPreset.Standard);
  sim.resetKickoff(ROOM_SEED);
  sim.sync();
  return sim;
}

/**
 * Random human inputs that change every 2-20 ticks (so hold-last is right most of the time and
 * wrong often enough to force rollbacks). `idleFrom`: zeros from that tick on (test c).
 */
function inputSource(seed, idleFrom = Infinity) {
  const r = rng(seed);
  const cur = new Int8Array(PACKED_INPUT_BYTES);
  let left = 0;
  return (tick, out, off) => {
    if (tick >= idleFrom) {
      out.fill(0, off, off + PACKED_INPUT_BYTES);
      return;
    }
    if (left-- <= 0) {
      const k = r();
      cur[0] = k < 0.6 ? 127 : k < 0.8 ? 0 : k < 0.9 ? -127 : Math.round((r() * 2 - 1) * 127);
      cur[1] = Math.round((r() * 2 - 1) * 127);
      cur[2] = r() < 0.3 ? Math.round((r() * 2 - 1) * 127) : 0;
      cur[3] = r() < 0.2 ? Math.round((r() * 2 - 1) * 127) : 0;
      cur[4] = r() < 0.1 ? Math.round((r() * 2 - 1) * 127) : 0;
      cur[5] = (r() < 0.3 ? T.BTN_BOOST : 0) | (r() < 0.06 ? T.BTN_JUMP : 0) | (r() < 0.1 ? T.BTN_HANDBRAKE : 0);
      left = 2 + Math.floor(r() * 19);
    }
    for (let i = 0; i < PACKED_INPUT_BYTES; i++) out[off + i] = cur[i];
  };
}

/** One directed link: random delay in [minDelay, maxDelay] ticks (reorders), loss rate, in-order delivery of what arrives. */
class Link {
  constructor(seed, minDelay, maxDelay, loss) {
    this.r = rng(seed);
    this.minDelay = minDelay;
    this.maxDelay = maxDelay;
    this.loss = loss;
    this.queue = [];
    this.sent = 0;
    this.lost = 0;
    this.delivered = 0;
    this.reordered = 0;
    this.lastArrivalSeq = -1;
    this.seq = 0;
    this.muted = false;
  }

  send(now, bytes) {
    if (this.muted) return;
    this.sent++;
    if (this.r() < this.loss) {
      this.lost++;
      return;
    }
    const delay = this.minDelay + Math.floor(this.r() * (this.maxDelay - this.minDelay + 1));
    this.queue.push({ at: now + delay, seq: this.seq++, bytes: Uint8Array.from(bytes) });
  }

  deliver(now, fn) {
    const q = this.queue;
    if (q.length === 0) return;
    q.sort((a, b) => a.at - b.at || a.seq - b.seq);
    while (q.length > 0 && q[0].at <= now) {
      const p = q.shift();
      if (p.seq < this.lastArrivalSeq) this.reordered++;
      this.lastArrivalSeq = Math.max(this.lastArrivalSeq, p.seq);
      this.delivered++;
      fn(p.bytes);
    }
  }
}

/**
 * A peer: engine + the sender / receiver state of the real client (newest tick received from each
 * remote = my ackTick to it; the ack each remote reported = where my resend starts).
 */
function makePeer({ sim, slot, numSlots, humanSlots, hooks, opts, inputs, name }) {
  const engine = new RollbackEngine(sim, numSlots, humanSlots, slot, hooks, opts);
  return {
    name,
    sim,
    slot,
    engine,
    inputs,
    recvNewest: new Int32Array(numSlots).fill(-1),
    theirAck: new Int32Array(numSlots).fill(-1),
    hashes: new Map(),
    verdicts: { agree: 0, disagree: 0, unknown: 0 },
    skips: 0,
    stallSkips: 0,
    throttleSkips: 0,
    advanceMs: 0,
    advances: 0,
    mine: new Int8Array(PACKED_INPUT_BYTES),
    batch: new Int8Array(MAX_BATCH * PACKED_INPUT_BYTES),
    buf: new Uint8Array(P.INPUT_HDR + MAX_BATCH * PACKED_INPUT_BYTES),
    hashBuf: new Uint8Array(P.HASH_LEN),
    pkt: { firstTick: 0, count: 0, ackTick: 0, myTick: 0, packed: new Int8Array(MAX_BATCH * PACKED_INPUT_BYTES) },
    hashPkt: { tick: 0, hash: 0 },
    alive: true,
    sending: true,
  };
}

/** Full mesh of links between peers: links[from][to]. */
function makeLinks(peers, seed, cfg) {
  const links = new Map();
  let k = 0;
  for (const a of peers) {
    const row = new Map();
    for (const b of peers) if (b !== a) row.set(b, new Link(seed + k++ * 7919, cfg.minDelay, cfg.maxDelay, cfg.loss));
    links.set(a, row);
  }
  return links;
}

/**
 * Run `ticks` iterations of the mesh. Per iteration: deliver packets due now to every peer, then
 * every alive peer that may advance registers its input and advances; every 2 iterations it sends
 * its unacked local inticks to every peer (several packets when the backlog exceeds the batch
 * cap, as the client must); new confirmed hashes go out on the reliable ctl link.
 */
function runMesh(peers, links, ctl, ticks, { onIteration } = {}) {
  for (let i = 1; i <= ticks; i++) {
    for (const p of peers) {
      for (const q of peers) {
        if (q === p) continue;
        // links.get(q).get(p) is the q -> p link: p's incoming traffic from q.
        links
          .get(q)
          .get(p)
          .deliver(i, (bytes) => {
            if (P.p2pMsgType(bytes) !== P.P2pMsg.Input) return;
            if (!P.decodeP2pInput(bytes, p.pkt)) throw new Error('bad input packet');
            const pk = p.pkt;
            p.engine.addRemoteInput(q.slot, pk.firstTick, pk.count, pk.packed);
            p.engine.noteRemoteTick(q.slot, pk.myTick, pk.ackTick);
            const newest = pk.firstTick + pk.count - 1;
            if (newest > p.recvNewest[q.slot]) p.recvNewest[q.slot] = newest;
            if (pk.ackTick > p.theirAck[q.slot]) p.theirAck[q.slot] = pk.ackTick;
          });
        ctl
          .get(q)
          .get(p)
          .deliver(i, (bytes) => {
            if (P.p2pMsgType(bytes) !== P.P2pMsg.Hash) return;
            if (!P.decodeHash(bytes, p.hashPkt)) throw new Error('bad hash packet');
            const v = p.engine.receiveHash(q.slot, p.hashPkt.tick, p.hashPkt.hash);
            p.verdicts[v]++;
          });
      }
    }
    if (onIteration) onIteration(i);
    for (const p of peers) {
      if (!p.alive) continue;
      const e = p.engine;
      if (!e.canAdvance()) {
        p.skips++;
        if (e.blockReason === 'stall') p.stallSkips++;
        else p.throttleSkips++;
      } else {
        p.inputs(e.tick + 1 + e.inputDelay, p.mine, 0);
        e.addLocalInput(p.mine, 0);
        const t0 = performance.now();
        e.advance();
        p.advanceMs += performance.now() - t0;
        p.advances++;
        if (e.tick !== p.sim.tickCount) throw new Error(`${p.name}: engine tick ${e.tick} != sim ${p.sim.tickCount}`);
      }
      for (const h of e.confirmedHashes()) {
        p.hashes.set(h.tick, h.hash);
        const n = P.encodeHash(p.hashBuf, h.tick, h.hash);
        for (const q of peers) if (q !== p) ctl.get(p).get(q).send(i, p.hashBuf.subarray(0, n));
      }
      if (i % 2 === 0 && p.sending) {
        const newest = e.newestLocalTick;
        for (const q of peers) {
          if (q === p) continue;
          let first = Math.max(p.theirAck[q.slot] + 1, 1, newest - 8 * MAX_BATCH + 1);
          if (first > newest) first = newest; // at least the newest tick
          let packets = 0;
          while (first <= newest && packets < 8) {
            const count = Math.min(MAX_BATCH, newest - first + 1);
            if (!e.copyLocalInputs(first, count, p.batch)) throw new Error(`${p.name}: local inputs ${first}..${first + count - 1} unknown`);
            const n = P.encodeP2pInput(p.buf, first, count, p.recvNewest[q.slot], e.tick, p.batch, 0);
            links.get(p).get(q).send(i, p.buf.subarray(0, n));
            first += count;
            packets++;
          }
        }
      }
    }
  }
}

/** Every hash tick recorded by both a and b must agree; returns the common ticks (ascending). */
function commonHashTicks(a, b) {
  const ticks = [...a.hashes.keys()].filter((t) => b.hashes.has(t)).sort((x, y) => x - y);
  return ticks;
}

function assertHashesAgree(peers, minCommon, label) {
  const base = peers[0];
  for (let k = 1; k < peers.length; k++) {
    const other = peers[k];
    const ticks = commonHashTicks(base, other);
    assert.ok(ticks.length >= minCommon, `${label}: ${base.name} / ${other.name} share ${ticks.length} hash ticks (need ${minCommon})`);
    for (const t of ticks) {
      assert.equal(other.hashes.get(t), base.hashes.get(t), `${label}: confirmed hash at tick ${t} differs between ${base.name} and ${other.name}`);
    }
  }
}

function summary(p) {
  const s = p.engine.stats;
  return (
    `${p.name}: tick ${p.engine.tick} F ${p.engine.confirmedTick} rollbacks ${s.rollbacks} resim ${s.resimTicks} mispred ${s.mispredictions} ` +
    `confirmed ${s.confirmedTicks} stalls ${s.stalls} throttles ${s.throttles} desyncs ${s.desyncs} resyncs ${s.resyncs} skips ${p.skips} ` +
    `autofill ${s.localAutoFilled} verdicts a/d/u ${p.verdicts.agree}/${p.verdicts.disagree}/${p.verdicts.unknown} ` +
    `advance ${((p.advanceMs / Math.max(1, p.advances)) * 1000).toFixed(0)} us`
  );
}

const noHooks = { botInputs() {}, onConfirmedTick() {} };

/**
 * Hooks with BotTeam-driven bots (one team per side, seeded from the room seed, the side's humans
 * passive) and, optionally, a Match on the confirmed timeline: Match.tick(TICK_DT) per confirmed
 * tick, goals from the state (rising edge of H_BALL_SCORED, team from the ball's side), kickoff
 * resets with the room seed + count, bots frozen while the Match says so. The ball prediction is
 * refreshed on EVERY confirmed tick (never on predicted ones) so its age is identical on every peer.
 */
function botHooks(sim, teamOfSlot, { match = null, seed = ROOM_SEED } = {}) {
  const h = {
    engine: null,
    events: [],
    kickoffs: 0,
    teams: [new BotTeam({ team: 0, difficulty: 'hard', seed }), new BotTeam({ team: 1, difficulty: 'hard', seed: seed + 1 })],
    slots: [[], []],
    outs: [[], []],
    key: '',
    thinks: 0,
    wasScored: false,
    refresh() {
      const bots = this.engine.botSlots;
      const humans = this.engine.humanSlots;
      const key = bots.join(',') + '|' + humans.join(',');
      if (key === this.key) return;
      this.key = key;
      for (const team of [0, 1]) {
        const mine = bots.filter((s) => teamOfSlot[s] === team);
        const passive = humans.filter((s) => teamOfSlot[s] === team);
        this.slots[team] = mine;
        this.outs[team] = mine.map(() => T.emptyControls());
        this.teams[team].setSlots(mine, passive);
      }
    },
    botInputs(tick, out) {
      this.refresh();
      const frozen = match !== null && (match.frozen || match.inGoalPause || match.phase === 'ended');
      if (frozen) {
        for (const team of [0, 1]) for (const s of this.slots[team]) out.fill(0, s * PACKED_INPUT_BYTES, (s + 1) * PACKED_INPUT_BYTES);
        return;
      }
      if (this.slots[0].length + this.slots[1].length === 0) return;
      sim.updateBallPrediction();
      for (const team of [0, 1]) {
        const slots = this.slots[team];
        if (slots.length === 0) continue;
        this.teams[team].think(sim, this.outs[team]);
        for (let i = 0; i < slots.length; i++) T.packControls(this.outs[team][i], out, slots[i] * PACKED_INPUT_BYTES);
        this.thinks++;
      }
    },
    onConfirmedTick(tick) {
      if (match === null) return;
      const scored = sim.buf[T.H_BALL_SCORED] > 0.5;
      if (scored && !this.wasScored) match.onGoal(sim.buf[T.BALL_OFFSET + T.B_POS + 1] > 0 ? 0 : 1);
      this.wasScored = scored;
      const evs = match.tick(TICK_DT);
      for (const e of evs) {
        this.events.push(e.type === 'countdown' ? `countdown${e.n}` : e.type === 'goal' ? `goal${e.team}` : e.type);
        if (e.type === 'kickoffReset') {
          sim.resetKickoff(seed + this.kickoffs++);
          sim.sync();
          this.teams[0].reset();
          this.teams[1].reset();
          this.wasScored = false;
        }
      }
      void tick;
    },
  };
  return h;
}

// ---- tests ----------------------------------------------------------------------------------------

test('a. 2 humans, random inputs, 2-8 tick jittered links with 5 % loss: identical hashes, rollbacks happen', async () => {
  const teams = [0, 1];
  const sims = [await arenaFor(teams), await arenaFor(teams)];
  const peers = sims.map((sim, i) => makePeer({ sim, slot: i, numSlots: 2, humanSlots: [0, 1], hooks: noHooks, opts: {}, inputs: inputSource(100 + i), name: `A${i}` }));
  const links = makeLinks(peers, 1, { minDelay: 2, maxDelay: 8, loss: 0.05 });
  const ctl = makeLinks(peers, 2, { minDelay: 2, maxDelay: 4, loss: 0 });
  runMesh(peers, links, ctl, 1200);
  for (const p of peers) console.log(summary(p));
  const l = links.get(peers[0]).get(peers[1]);
  console.log(`link A0->A1: sent ${l.sent} lost ${l.lost} delivered ${l.delivered} reordered ${l.reordered}`);
  assert.ok(l.lost > 0 && l.reordered > 0, 'the link lost and reordered packets');
  assertHashesAgree(peers, 34, 'a');
  for (const p of peers) {
    const s = p.engine.stats;
    assert.ok(p.engine.tick >= 1150, `${p.name} reached tick ${p.engine.tick}`);
    assert.ok(p.engine.tick - p.engine.confirmedTick <= p.engine.window, 'confirmed within the window');
    assert.ok(s.rollbacks > 0 && s.resimTicks > 0 && s.mispredictions > 0, `${p.name}: rollbacks ${s.rollbacks} resim ${s.resimTicks}`);
    assert.equal(s.desyncs, 0);
    assert.equal(p.verdicts.disagree, 0);
    // Votes that arrive before I confirm their tick come back 'unknown' and are judged later.
    assert.ok(p.verdicts.agree >= 20 && p.verdicts.agree + p.verdicts.unknown >= 34, `${p.name}: ${p.verdicts.agree} agreeing / ${p.verdicts.unknown} early votes`);
    assert.equal(s.stalls, 0, `${p.name} never stalled (window ${p.engine.window} vs 8-tick delay)`);
    assert.ok(p.skips <= 60, `${p.name}: ${p.skips} timesync skips`);
    assert.equal(s.localAutoFilled, 0);
  }
  // stateAt / hashAt on a hash tick still in the ring: the blob hashes to the reported hash.
  const p = peers[0];
  const last = Math.max(...p.hashes.keys());
  const st = p.engine.stateAt(last);
  assert.ok(st, `stateAt(${last})`);
  assert.equal(st.hash, p.hashes.get(last));
  assert.equal(fnv1a32(st.blob, st.len), st.hash);
  assert.equal(p.engine.hashAt(last), st.hash);
  assert.equal(p.engine.stateAt(last + 1 + 64 * 0 + 100000), null);
});

test('b. 3v3 with 2 humans + 4 BotTeam bots and a Match on the confirmed timeline: identical hashes and events', async () => {
  const teams = [0, 0, 0, 1, 1, 1];
  const humanSlots = [0, 3];
  const sims = [await arenaFor(teams), await arenaFor(teams)];
  const matches = [0, 1].map(() => new Match({ lengthSeconds: 300, kickoffCountdownSeconds: 1, goalPauseSeconds: 1 }));
  const hooks = sims.map((sim, i) => botHooks(sim, teams, { match: matches[i] }));
  const peers = sims.map((sim, i) =>
    makePeer({ sim, slot: humanSlots[i], numSlots: 6, humanSlots, hooks: hooks[i], opts: {}, inputs: inputSource(200 + i), name: `B${i}` }),
  );
  hooks.forEach((h, i) => {
    h.engine = peers[i].engine;
  });
  for (const m of matches) m.start();
  const links = makeLinks(peers, 3, { minDelay: 2, maxDelay: 8, loss: 0.05 });
  const ctl = makeLinks(peers, 4, { minDelay: 2, maxDelay: 4, loss: 0 });
  runMesh(peers, links, ctl, 1200);
  for (const p of peers) console.log(summary(p));
  const count = (evs, type) => evs.filter((e) => e.startsWith(type)).length;
  for (const h of hooks) {
    console.log(
      `${h === hooks[0] ? 'B0' : 'B1'} events: countdown ${count(h.events, 'countdown')} go ${count(h.events, 'go')} goal ${count(h.events, 'goal')} ` +
        `kickoffReset ${count(h.events, 'kickoffReset')} thinks ${h.thinks} seq ${h.events.slice(0, 12).join(',')}...`,
    );
  }
  assertHashesAgree(peers, 34, 'b');
  const F = Math.min(peers[0].engine.confirmedTick, peers[1].engine.confirmedTick);
  assert.ok(F >= 1100, `confirmed to ${F}`);
  // Event sequences are identical up to the common confirmed tick: Match ran once per confirmed
  // tick on both (the later peer may have a few more events pending).
  const n = Math.min(hooks[0].events.length, hooks[1].events.length);
  assert.ok(n >= 4, `${n} events`);
  assert.deepEqual(hooks[0].events.slice(0, n), hooks[1].events.slice(0, n));
  assert.ok(Math.abs(hooks[0].events.length - hooks[1].events.length) <= 2);
  assert.equal(count(hooks[0].events, 'go'), 1 + count(hooks[0].events, 'goal'));
  assert.ok(hooks[0].thinks >= 2 * (F - 130), 'both bot teams thought on every confirmed playing tick');
  for (const p of peers) {
    assert.equal(p.engine.stats.desyncs, 0);
    assert.equal(p.verdicts.disagree, 0);
    assert.ok(p.engine.stats.rollbacks > 0);
  }
  assert.deepEqual([...peers[0].engine.botSlots], [1, 2, 4, 5]);
});

test('c. drop: slot 1 dropped at tick 600 on both peers; hashes stay identical and the bot drives the dropped car', async () => {
  const teams = [0, 1];
  const sims = [await arenaFor(teams), await arenaFor(teams)];
  const hooks = sims.map((sim) => botHooks(sim, teams));
  const peers = sims.map((sim, i) =>
    makePeer({ sim, slot: i, numSlots: 2, humanSlots: [0, 1], hooks: hooks[i], opts: {}, inputs: inputSource(300 + i, i === 1 ? 420 : Infinity), name: `C${i}` }),
  );
  hooks.forEach((h, i) => {
    h.engine = peers[i].engine;
  });
  const links = makeLinks(peers, 5, { minDelay: 2, maxDelay: 8, loss: 0 });
  const ctl = makeLinks(peers, 6, { minDelay: 2, maxDelay: 4, loss: 0 });
  const DROP_AT = 600;
  let posAtDrop = null;
  const car1 = (sim) => {
    const o = sim.carOffset(1);
    return [sim.buf[o + T.C_POS], sim.buf[o + T.C_POS + 1], sim.buf[o + T.C_POS + 2]];
  };
  runMesh(peers, links, ctl, 1200, {
    onIteration(i) {
      if (i === 580) {
        for (const p of peers) p.engine.drop(1, DROP_AT);
        assert.deepEqual([...peers[0].engine.humanSlots], [0]);
        assert.ok(peers[0].engine.confirmedTick < DROP_AT);
      }
      if (i === DROP_AT + 20) {
        // The peer is gone. It stopped sending late enough for every tick below DROP_AT to have
        // reached the other side (so both confirm the same inputs there; from DROP_AT on the bot).
        assert.ok(peers[0].engine.contiguousInputTick(1) >= DROP_AT - 1, 'A has every input of slot 1 below the drop tick');
        peers[1].sending = false;
      }
      if (i === DROP_AT + 40) posAtDrop = car1(peers[0].sim);
    },
  });
  for (const p of peers) console.log(summary(p));
  assertHashesAgree(peers, 34, 'c');
  for (const p of peers) {
    assert.ok(p.engine.confirmedTick >= 1100, `${p.name} confirmed ${p.engine.confirmedTick}`);
    assert.deepEqual([...p.engine.botSlots], [1]);
    assert.equal(p.engine.dropTickOf(1), DROP_AT);
    assert.equal(p.engine.stats.lateDrops, 0);
    assert.equal(p.engine.stats.desyncs, 0);
    assert.equal(p.engine.stats.stalls, 0, `${p.name}: a dropped slot never stalls the others`);
  }
  assert.ok(hooks[0].thinks > 500, `the red bot thought ${hooks[0].thinks} times`);
  const o = peers[0].sim.carOffset(1);
  const v = peers[0].sim.buf;
  const speed = Math.hypot(v[o + T.C_VEL], v[o + T.C_VEL + 1], v[o + T.C_VEL + 2]);
  const end = car1(peers[0].sim);
  const moved = Math.hypot(end[0] - posAtDrop[0], end[1] - posAtDrop[1], end[2] - posAtDrop[2]);
  console.log(`c: car 1 moved ${moved.toFixed(0)} uu since the drop, speed ${speed.toFixed(0)} uu/s`);
  assert.ok(moved > 300 || speed > 300, 'the dropped car is driven by the bot');
  const after = commonHashTicks(peers[0], peers[1]).filter((t) => t > DROP_AT);
  assert.ok(after.length >= 15, `${after.length} hash ticks after the drop`);
});

test('c2. drop at min(contiguousInputTick) + 1: the peer that got more of the dead peer rewinds, hashes stay identical, no late drop', async () => {
  const teams = [0, 0, 1];
  const sims = [await arenaFor(teams), await arenaFor(teams), await arenaFor(teams)];
  const hooks = sims.map((sim) => botHooks(sim, teams));
  const peers = sims.map((sim, i) => makePeer({ sim, slot: i, numSlots: 3, humanSlots: [0, 1, 2], hooks: hooks[i], opts: {}, inputs: inputSource(350 + i), name: `C2-${i}` }));
  hooks.forEach((h, i) => {
    h.engine = peers[i].engine;
  });
  const links = makeLinks(peers, 15, { minDelay: 2, maxDelay: 8, loss: 0.1 });
  const ctl = makeLinks(peers, 16, { minDelay: 2, maxDelay: 4, loss: 0 });
  const [A, B, X] = peers;
  const rewound = [];
  hooks[0].onRewind = (t) => rewound.push(['A', t]);
  hooks[1].onRewind = (t) => rewound.push(['B', t]);
  let at = -1;
  let contigs = null;
  let stallsAtDrop = null;
  runMesh(peers, links, ctl, 1200, {
    onIteration(i) {
      // X's link to B dies first (B stops getting X's packets), then X dies altogether: A holds a
      // few more of X's inputs than B does.
      if (i === 392) links.get(X).get(B).muted = true;
      if (i === 400) {
        X.sending = false;
        X.alive = false;
      }
      if (i === 440) {
        contigs = [A.engine.contiguousInputTick(2), B.engine.contiguousInputTick(2)];
        at = Math.min(contigs[0], contigs[1]) + 1;
        assert.ok(A.engine.confirmedTick === contigs[0] && B.engine.confirmedTick === contigs[1], 'both stalled at their last contiguous input of X');
        stallsAtDrop = [A.engine.stats.stalls, B.engine.stats.stalls];
        A.engine.drop(2, at);
        B.engine.drop(2, at);
      }
    },
  });
  for (const p of [A, B]) console.log(summary(p));
  console.log(`c2: contigs ${contigs.join('/')}, drop at ${at}, rewound ${JSON.stringify(rewound)}`);
  assertHashesAgree([A, B], 30, 'c2');
  const bigger = contigs[0] > contigs[1] ? 0 : contigs[1] > contigs[0] ? 1 : -1;
  for (const [k, p] of [A, B].entries()) {
    assert.equal(p.engine.dropTickOf(2), at);
    assert.equal(p.engine.stats.lateDrops, 0, `${p.name}: no late drop`);
    assert.equal(p.engine.stats.rewinds, k === bigger ? 1 : 0, `${p.name}: rewinds`);
    assert.ok(p.engine.confirmedTick >= 1100, `${p.name} confirmed ${p.engine.confirmedTick}`);
    assert.equal(p.engine.stats.desyncs, 0);
    assert.equal(p.verdicts.disagree, 0);
    assert.ok(p.engine.stats.stalls - stallsAtDrop[k] <= 1, `${p.name}: no stalls after the drop (${p.engine.stats.stalls - stallsAtDrop[k]})`);
  }
  if (bigger >= 0) assert.deepEqual(rewound, [[bigger === 0 ? 'A' : 'B', at - 1]], 'onRewind told the hooks the restart tick');
  else assert.deepEqual(rewound, []);
  const after = commonHashTicks(A, B).filter((t) => t > at);
  assert.ok(after.length >= 20, `${after.length} hash ticks after the drop`);
});

test('d. resync: an injected divergence is detected by the hash vote and repaired from the majority state within 60 ticks', async () => {
  const teams = [0, 1];
  const sims = [await arenaFor(teams), await arenaFor(teams)];
  const peers = sims.map((sim, i) => makePeer({ sim, slot: i, numSlots: 2, humanSlots: [0, 1], hooks: noHooks, opts: {}, inputs: inputSource(400 + i), name: `D${i}` }));
  const links = makeLinks(peers, 7, { minDelay: 3, maxDelay: 3, loss: 0 });
  const ctl = makeLinks(peers, 8, { minDelay: 3, maxDelay: 3, loss: 0 });
  // A foreign state: a third instance driven by other inputs up to B's confirmed tick (the blob
  // must carry that tick: resync refuses any other, see the unit test).
  const other = await arenaFor(teams);
  const frame = new Int8Array(2 * PACKED_INPUT_BYTES);
  const src = inputSource(999);
  const foreign = new Uint8Array(T.MAX_STATE_BYTES);
  let foreignLen = 0;
  let otherTick = 0; // the bridge's tickCount only refreshes on sync()
  const foreignStateAt = (tick) => {
    while (otherTick < tick) {
      otherTick++;
      src(otherTick, frame, 0);
      src(otherTick + 1000, frame, PACKED_INPUT_BYTES);
      other.setControlsPacked(frame, 2);
      other.step(1);
    }
    other.sync();
    assert.equal(other.tickCount, tick);
    foreignLen = other.saveState(foreign);
  };

  const desyncs = [];
  let corruptedAt = -1;
  let repairedAt = -1;
  peers[1].engine.onDesync = (tick, mine, majority, agree, disagree) => {
    desyncs.push({ tick, mine, majority, agree, disagree });
    // The real client sends StateRequest(tick) to the majority peer and resyncs from the response.
    const st = peers[0].engine.stateAt(tick);
    assert.ok(st, `majority peer still has the state of tick ${tick}`);
    assert.equal(st.hash, majority);
    peers[1].engine.resync(tick, st.blob, st.len);
    repairedAt = tick;
  };
  peers[0].engine.onDesync = (tick) => assert.fail(`the majority peer (slot 0) must not see a desync (tick ${tick})`);
  runMesh(peers, links, ctl, 720, {
    onIteration(i) {
      if (i === 300) {
        // Corrupt B's confirmed state: load a foreign blob as "the confirmed state at F".
        const F = peers[1].engine.confirmedTick;
        foreignStateAt(F);
        assert.throws(() => peers[1].engine.resync(F + 1, foreign, foreignLen), /holds tick/, 'a blob of another tick is refused');
        assert.equal(peers[1].sim.tickCount, peers[1].engine.tick, 'the refused resync left the own timeline in place');
        peers[1].engine.resync(F, foreign, foreignLen);
        corruptedAt = F;
      }
    },
  });
  for (const p of peers) console.log(summary(p));
  console.log(`d: corrupted at ${corruptedAt}, desync ${JSON.stringify(desyncs)}, repaired at ${repairedAt}`);
  assert.equal(desyncs.length, 1, 'exactly one desync (one hash tick)');
  assert.equal(peers[1].engine.stats.desyncs, 1);
  assert.equal(peers[0].engine.stats.desyncs, 0);
  const d = desyncs[0];
  assert.ok(d.tick > corruptedAt && d.tick <= corruptedAt + HASH_EVERY, `detected at the first hash tick after the corruption (${d.tick})`);
  assert.equal(d.disagree, 1);
  assert.equal(d.agree, 0);
  assert.notEqual(d.mine, d.majority);
  const ticks = commonHashTicks(peers[0], peers[1]);
  const bad = ticks.filter((t) => peers[0].hashes.get(t) !== peers[1].hashes.get(t));
  assert.deepEqual(bad, [d.tick], 'only the detected tick differs');
  const after = ticks.filter((t) => t > d.tick);
  assert.ok(after.length >= 8, `${after.length} hash ticks after the repair`);
  assert.ok(after[0] <= d.tick + 60, `hashes agree again at ${after[0]} (within 60 ticks of ${d.tick})`);
  assert.equal(peers[1].engine.stats.resyncs, 2, 'the corruption and the repair');
  // Before the corruption everything agreed too.
  for (const t of ticks) if (t <= corruptedAt) assert.equal(peers[1].hashes.get(t), peers[0].hashes.get(t));
});

test('e. stall: when a peer goes silent canAdvance() turns false after `window` ticks and resumes when its inputs arrive', async () => {
  const teams = [0, 1];
  const sims = [await arenaFor(teams), await arenaFor(teams)];
  const peers = sims.map((sim, i) => makePeer({ sim, slot: i, numSlots: 2, humanSlots: [0, 1], hooks: noHooks, opts: {}, inputs: inputSource(500 + i), name: `E${i}` }));
  const links = makeLinks(peers, 9, { minDelay: 3, maxDelay: 3, loss: 0 });
  const ctl = makeLinks(peers, 10, { minDelay: 3, maxDelay: 3, loss: 0 });
  const A = peers[0];
  const B = peers[1];
  const window = A.engine.window;
  let firstStall = -1;
  let stalledTick = -1;
  let resumedAt = -1;
  let maxAhead = 0;
  let skipsAtResume = [0, 0];
  let leadAtResume = 0;
  runMesh(peers, links, ctl, 600, {
    onIteration(i) {
      if (i === 300) B.sending = false;
      if (i === 360) B.sending = true;
      const ahead = A.engine.tick - A.engine.confirmedTick;
      if (ahead > maxAhead) maxAhead = ahead;
      if (i > 300 && firstStall < 0 && !A.engine.canAdvance() && A.engine.blockReason === 'stall') {
        firstStall = i;
        stalledTick = A.engine.tick;
        assert.equal(A.engine.waitingFor(), 1, 'waiting for slot 1');
      }
      if (firstStall > 0 && resumedAt < 0 && i > 360 && A.engine.canAdvance()) {
        resumedAt = i;
        skipsAtResume = [A.skips, B.skips];
        leadAtResume = B.engine.tick - A.engine.tick;
      }
    },
  });
  for (const p of peers) console.log(summary(p));
  console.log(
    `e: silent 300..360, first stall at iteration ${firstStall} (tick ${stalledTick}), resumed at ${resumedAt} with B ${leadAtResume} ticks ahead, ` +
      `max ahead ${maxAhead}, skips after the resume A ${A.skips - skipsAtResume[0]} B ${B.skips - skipsAtResume[1]}`,
  );
  assert.ok(firstStall > 300 && firstStall <= 300 + window + 8, `stalled at ${firstStall}`);
  assert.equal(maxAhead, window, 'the predicted timeline never runs further than the window');
  assert.ok(A.engine.stats.stalls > 0 && A.stallSkips > 0);
  assert.ok(resumedAt > 360 && resumedAt <= 372, `resumed at ${resumedAt}`);
  assert.ok(B.engine.stats.stalls + B.engine.stats.throttles > 0, 'the silent peer ran ahead and had to wait too (window or timesync)');
  assert.equal(A.engine.blockReason, 'none');
  assertHashesAgree(peers, 15, 'e');
  // This harness has no catch-up (one tick per iteration at most), so the ~50 lost iterations stay
  // lost; what matters is that nobody waits again once the inputs flow: A never, B only to burn
  // the lead it built while A was stalled (timesync throttle), then both run in lockstep.
  assert.ok(A.skips - skipsAtResume[0] <= 2, `A skipped ${A.skips - skipsAtResume[0]} times after the resume`);
  assert.ok(B.skips - skipsAtResume[1] <= leadAtResume + 8, `B skipped ${B.skips - skipsAtResume[1]} times to burn a lead of ${leadAtResume}`);
  assert.ok(Math.abs(A.engine.tick - B.engine.tick) <= 2, 'back in lockstep');
  assert.ok(A.engine.confirmedTick >= 600 - 75 && B.engine.confirmedTick >= 600 - 75, 'both confirmed on after the silence');
  for (const p of peers) assert.equal(p.engine.stats.desyncs, 0);
});

test('f. six humans (3v3, no bots), 600 ticks over lossy jittered links: all six confirmed timelines identical', async () => {
  const teams = [0, 0, 0, 1, 1, 1];
  const sims = [];
  for (let i = 0; i < 6; i++) sims.push(await arenaFor(teams));
  const peers = sims.map((sim, i) => makePeer({ sim, slot: i, numSlots: 6, humanSlots: [0, 1, 2, 3, 4, 5], hooks: noHooks, opts: {}, inputs: inputSource(600 + i), name: `F${i}` }));
  const links = makeLinks(peers, 11, { minDelay: 2, maxDelay: 8, loss: 0.05 });
  const ctl = makeLinks(peers, 12, { minDelay: 2, maxDelay: 4, loss: 0 });
  runMesh(peers, links, ctl, 600);
  for (const p of peers) console.log(summary(p));
  assertHashesAgree(peers, 15, 'f');
  for (const p of peers) {
    assert.ok(p.engine.confirmedTick >= 540, `${p.name} confirmed ${p.engine.confirmedTick}`);
    assert.equal(p.engine.stats.desyncs, 0);
    assert.equal(p.verdicts.disagree, 0);
    assert.ok(p.verdicts.agree >= 50, `${p.name}: ${p.verdicts.agree} agreeing votes from 5 peers`);
    assert.ok(p.engine.stats.rollbacks > 0);
  }
});

test('g. perf: 2 humans at 120 Hz over fixed 8-tick links, average advance() under 0.4 ms', async () => {
  const teams = [0, 1];
  const sims = [await arenaFor(teams), await arenaFor(teams)];
  const peers = sims.map((sim, i) => makePeer({ sim, slot: i, numSlots: 2, humanSlots: [0, 1], hooks: noHooks, opts: {}, inputs: inputSource(700 + i), name: `G${i}` }));
  const links = makeLinks(peers, 13, { minDelay: 8, maxDelay: 8, loss: 0 });
  const ctl = makeLinks(peers, 14, { minDelay: 8, maxDelay: 8, loss: 0 });
  runMesh(peers, links, ctl, 240); // warm-up (JIT, first full ball prediction)
  for (const p of peers) {
    p.advanceMs = 0;
    p.advances = 0;
  }
  runMesh(peers, links, ctl, 1200);
  for (const p of peers) console.log(summary(p));
  assertHashesAgree(peers, 30, 'g');
  for (const p of peers) {
    const avg = p.advanceMs / p.advances;
    console.log(`g: ${p.name} advance() avg ${(avg * 1000).toFixed(1)} us over ${p.advances} calls (rollbacks ${p.engine.stats.rollbacks}, resim ${p.engine.stats.resimTicks} ticks)`);
    assert.ok(avg < 0.4, `${p.name}: average advance ${avg.toFixed(3)} ms`);
    assert.equal(p.engine.stats.stalls, 0);
    assert.ok(p.skips <= 10, `${p.name}: ${p.skips} skips with a symmetric 8-tick link`);
  }
});

test('h. unit: input delay, prefilled ticks, drop guards, hash vote tie rule and stateAt bounds', async () => {
  const teams = [0, 1, 1];
  const sim = await arenaFor(teams);
  const seen = [];
  const hooks = { botInputs(t, out) { seen.push(t); out[2 * PACKED_INPUT_BYTES] = 100; }, onConfirmedTick() {} };
  const e = new RollbackEngine(sim, 3, [0, 1], 0, hooks, { inputDelay: 2, window: 8, historyTicks: 16, hashEvery: 4 });
  assert.equal(e.tick, 0);
  assert.equal(e.confirmedTick, 0);
  assert.deepEqual([...e.botSlots], [2]);
  assert.deepEqual([...e.humanSlots], [0, 1]);
  assert.equal(e.newestLocalTick, 2, 'ticks 1..inputDelay prefilled');
  const inp = new Int8Array(PACKED_INPUT_BYTES);
  inp[0] = 127;
  assert.equal(e.addLocalInput(inp, 0), 3);
  assert.equal(e.addLocalInput(inp, 0), 3, 'a second registration of the same tick is ignored');
  assert.equal(e.newestLocalTick, 3);
  assert.ok(e.canAdvance());
  e.advance();
  assert.equal(e.tick, 1);
  assert.equal(e.confirmedTick, 0, 'slot 1 has no input yet');
  assert.equal(e.hashAt(4), -1);
  // Remote inputs for 1..6 arrive: confirm up to the predicted tick + 1 only, then the rest.
  const batch = new Int8Array(6 * PACKED_INPUT_BYTES);
  for (let i = 0; i < 6; i++) batch[i * PACKED_INPUT_BYTES] = -127;
  e.addRemoteInput(1, 1, 6, batch);
  assert.equal(e.stats.mispredictions, 1, 'tick 1 was predicted with hold-last zero, the real input differs');
  e.advance();
  assert.equal(e.tick, 2);
  assert.equal(e.confirmedTick, 2);
  assert.deepEqual(seen, [1, 2], 'botInputs once per confirmed tick, in order');
  assert.equal(e.stats.rollbacks, 1);
  assert.equal(e.stats.resimTicks, 1);
  const got = new Int8Array(PACKED_INPUT_BYTES);
  assert.ok(e.predictedInputFor(2, 2, got, 0), 'the bot input of a confirmed tick is known');
  assert.equal(got[0], 100);
  assert.ok(e.inputKnown(1, 6));
  assert.equal(e.inputKnown(1, 7), false);
  for (let t = 0; t < 6; t++) {
    e.addLocalInput(inp, 0);
    e.advance();
  }
  assert.equal(e.tick, 8);
  assert.equal(e.confirmedTick, 6);
  assert.equal(e.hashAt(4), fnv1a32(e.stateAt(4).blob, e.stateAt(4).len));
  assert.equal(e.confirmedHashes().length, 1, 'tick 4 pending');
  assert.equal(e.confirmedHashes().length, 0, 'drained');
  // Window: 8 ahead of F=6 means stall at tick 14.
  for (let t = 0; t < 6; t++) {
    assert.ok(e.canAdvance(), `tick ${e.tick}`);
    e.addLocalInput(inp, 0);
    e.advance();
  }
  assert.equal(e.tick, 14);
  assert.equal(e.canAdvance(), false);
  assert.equal(e.blockReason, 'stall');
  assert.equal(e.waitingFor(), 1);
  // Timesync: raw lead from myTick alone; the latency-free estimate needs ackTick samples.
  assert.equal(e.framesAhead(), 0, 'no remote tick reported');
  e.noteRemoteTick(1, 10);
  assert.equal(e.framesAhead(), 4, 'raw lead: tick 14 - reported myTick 10');
  assert.equal(e.leadEstimate(), 0, 'no ackTick samples: nothing to throttle on');
  e.noteRemoteTick(1, 12, 17); // it has my tick 17 = (its tick 15 when it received it) + inputDelay 2: ((14 - 12) + (17 - 12 - 2)) / 2 = 2
  assert.equal(e.framesAhead(), 2);
  assert.equal(e.leadEstimate(), 2);
  assert.equal(e.canAdvance(), false, 'still the stall, not a throttle (2 is not > aheadMax 2)');
  assert.equal(e.blockReason, 'stall');
  // Hash vote: slot 1 disagrees at tick 4 -> 1v1 tie -> the lowest slot (me) is the majority: no desync for me.
  let fired = 0;
  e.onDesync = () => fired++;
  assert.equal(e.receiveHash(1, 4, 12345), 'disagree');
  assert.equal(fired, 0);
  assert.equal(e.stats.desyncs, 0);
  assert.equal(e.receiveHash(1, 5, 1), 'unknown', 'not a hash tick');
  assert.equal(e.receiveHash(1, 400, 1), 'unknown', 'not confirmed yet (stored for later)');
  assert.equal(e.receiveHash(0, 4, 1), 'unknown', 'my own slot');
  // Far-future / stale hash ticks never touch the ring (they would reset the live entry).
  assert.equal(e.receiveHash(1, 4 * 1000, 1), 'unknown', 'beyond the future cap');
  assert.equal(e.voteOf(1, 4), 12345, 'the vote of slot 1 at tick 4 is kept');
  assert.equal(e.voteOf(0, 4), e.hashAt(4), 'my own vote');
  assert.equal(e.voteOf(1, 8), -1, 'no vote yet');
  // Drop slot 1 at a tick already confirmed (F = 6): the engine rewinds to the snapshot of tick 1
  // (onRewind tells the hooks) and re-confirms 2..14 with the bot driving slot 1 from tick 2.
  const rewinds = [];
  hooks.onRewind = (t) => rewinds.push(t);
  const decided = [];
  e.onHashDecided = (t, agreed) => decided.push([t, agreed]);
  seen.length = 0;
  e.drop(1, 2);
  assert.equal(e.dropTickOf(1), 2);
  assert.equal(e.stats.rewinds, 1);
  assert.equal(e.stats.lateDrops, 0);
  assert.deepEqual(rewinds, [1]);
  assert.equal(e.confirmedTick, 14, 're-confirmed up to the predicted tick: nothing to wait for any more');
  assert.equal(e.tick, 14);
  assert.deepEqual(seen, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], 'botInputs once per re-confirmed tick, in order');
  assert.deepEqual([...e.humanSlots], [0]);
  assert.deepEqual([...e.botSlots], [1, 2]);
  assert.equal(e.hashAt(4), e.stateAt(4).hash, 'hash tick 4 re-recorded on the rewound timeline');
  assert.deepEqual(decided, [[4, true], [8, true], [12, true]], 'with slot 1 dropped my vote alone decides each hash tick (no desync)');
  assert.equal(fired, 0);
  assert.ok(e.canAdvance(), 'nothing to wait for any more');
  e.addLocalInput(inp, 0);
  e.advance();
  assert.equal(e.confirmedTick, 15);
  assert.deepEqual([...e.botSlots], [1, 2]);
  assert.equal(e.waitingFor(), -1);
  assert.ok(e.stateAt(0), 'the ring of 16 still holds tick 0 at tick 15');
  assert.ok(e.stateAt(15));
  for (let t = 0; t < 6; t++) {
    e.addLocalInput(inp, 0);
    e.advance();
  }
  assert.equal(e.tick, 21);
  assert.equal(e.confirmedTick, 21);
  assert.equal(e.stateAt(0), null, 'tick 16 took its ring cell');
  assert.equal(e.stateAt(5), null, 'tick 21 took its ring cell');
  const h4 = e.stateAt(4);
  assert.ok(h4, 'hash tick 4 survives in the hash ring after tick 20 took its ring cell');
  assert.equal(h4.hash, e.hashAt(4));
  assert.equal(fnv1a32(h4.blob, h4.len), h4.hash);
  assert.equal(e.framesAhead(), 0, 'the dropped slot no longer counts for timesync');
  assert.equal(e.receiveHash(1, 400, 1), 'unknown', 'slot 1 is dropped: its votes do not count');
  assert.throws(() => new RollbackEngine(sim, 3, [1], 0, hooks), /not a human slot/);
  assert.throws(() => new RollbackEngine(sim, 3, [0, 0], 0, hooks), /repeated/);

  // Late drop: the snapshot of atTick - 1 is gone (ring of 4) -> atTick moves to F + 1, counted.
  const e2 = new RollbackEngine(sim, 3, [0, 1], 0, { botInputs() {}, onConfirmedTick() {} }, { inputDelay: 2, window: 8, historyTicks: 4, hashEvery: 4 });
  const base = e2.tick;
  const many = new Int8Array(20 * PACKED_INPUT_BYTES);
  e2.addRemoteInput(1, base + 1, 20, many);
  for (let t = 0; t < 10; t++) {
    e2.addLocalInput(inp, 0);
    e2.advance();
  }
  assert.equal(e2.confirmedTick, base + 10);
  e2.drop(1, base + 4);
  assert.equal(e2.stats.lateDrops, 1);
  assert.equal(e2.stats.rewinds, 0);
  assert.equal(e2.dropTickOf(1), base + 11);
  assert.equal(e2.confirmedTick, base + 10, 'nothing rewound');
});

test('i. a peer that never joined: drop(slot, 0) on every peer before any tick -> bot from the first simulated tick, no late drop / rewind, hashes agree', async () => {
  const teams = [0, 1, 1];
  const sims = [await arenaFor(teams), await arenaFor(teams)];
  const hooks = () => ({ botInputs(t, out) { out[2 * PACKED_INPUT_BYTES] = 50; out[2 * PACKED_INPUT_BYTES + 1] = t % 40; }, onConfirmedTick() {} });
  const es = [0, 1].map((me) => new RollbackEngine(sims[me], 3, [0, 1, 2], me, hooks(), { inputDelay: 2, window: 8, historyTicks: 16, hashEvery: 4 }));
  for (const e of es) {
    assert.equal(e.waitingFor(), -1, 'nothing simulated yet');
    e.drop(2, 0); // the room's drop { slot: 2, atTick: 0 } right after its start
    assert.equal(e.dropTickOf(2), 1, 'tick 0 is the base state: the first simulated tick is the first bot tick');
    assert.equal(e.stats.lateDrops, 0, 'not a late drop');
    assert.equal(e.stats.rewinds, 0, 'nothing to rewind');
    assert.deepEqual([...e.humanSlots], [0, 1]);
    assert.deepEqual([...e.botSlots], [], 'joins the bot list with the first confirmed pass');
  }
  const buf = new Int8Array(P.P2P_INPUT_MAX_BATCH * PACKED_INPUT_BYTES);
  const acked = [0, 0];
  const inp = new Int8Array(PACKED_INPUT_BYTES);
  for (let t = 0; t < 40; t++) {
    for (let k = 0; k < 2; k++) {
      if (!es[k].canAdvance()) continue;
      inp[0] = k === 0 ? 127 : -64;
      inp[1] = (t * 7) % 50;
      es[k].addLocalInput(inp, 0);
      es[k].advance();
    }
    for (let k = 0; k < 2; k++) {
      const n = es[k].assembleLocalInputs(acked[k], buf, P.P2P_INPUT_MAX_BATCH);
      if (n <= 0) continue;
      es[1 - k].addRemoteInput(k, es[k].newestLocalTick - n + 1, n, buf);
      acked[k] = es[k].newestLocalTick;
    }
  }
  for (const e of es) {
    assert.ok(e.confirmedTick >= 36, `confirmed ${e.confirmedTick}: slot 2 never blocks`);
    assert.deepEqual([...e.botSlots], [2]);
  }
  for (let tick = 4; tick <= 36; tick += 4) assert.equal(es[0].hashAt(tick), es[1].hashAt(tick), `hash at ${tick}`);
  // The same drop arriving after the slot's own inputs were confirmed rewinds to the base snapshot.
  const sim3 = await arenaFor(teams);
  const e3 = new RollbackEngine(sim3, 3, [0, 1], 0, hooks(), { inputDelay: 2, window: 8, historyTicks: 16, hashEvery: 4 });
  e3.addRemoteInput(1, 1, 8, new Int8Array(8 * PACKED_INPUT_BYTES));
  for (let t = 0; t < 5; t++) {
    e3.addLocalInput(inp, 0);
    e3.advance();
  }
  assert.equal(e3.confirmedTick, 5);
  e3.drop(1, 0);
  assert.equal(e3.dropTickOf(1), 1);
  assert.equal(e3.stats.rewinds, 1, 'back to the snapshot of tick 0 and re-confirmed with the bot');
  assert.equal(e3.stats.lateDrops, 0);
  assert.equal(e3.confirmedTick, 5);
});

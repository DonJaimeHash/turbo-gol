# Architecture

Turbogol: physics car soccer for the browser. Single player with and against local AI
(1v1, 2v2 or 3v3; see "Game modes"), and two online modes (see "Online"): a peer-to-peer
deterministic rollback mesh (phase 2, casual) and an authoritative host in a Cloudflare Durable
Object running the same physics (phase 1).

## Goals (in priority order)

1. **Speed.** 120 Hz deterministic physics in WebAssembly (RocketSim + Bullet, compiled with
   Emscripten `-O3 -msimd128`), rendering on the GPU through three.js `WebGPURenderer` (automatic
   WebGL2 fallback), zero per-frame allocations on the hot path, < 60 draw calls per frame.
2. **One physics.** The physics IS RocketSim (an open-source rigid-body car and ball simulation on
   Bullet). Car handling, jumps, flips, air control, boost, bumps, demolitions, boost pads,
   kickoffs and goal detection all come from the sim; the JS side never re-implements physics.
3. **Zero assets, all original.** Nothing is downloaded besides the JS bundle and `rocketsim.wasm`.
   Field, car, ball, stadium, sky, textures and sounds are all generated procedurally at startup.
   The field is our own design (rounded corners, own dimensions, goals, boost pad layout, kickoff
   and respawn spots: `src/sim/constants.ts`), handed to the wasm with `rs_set_field_layout`.

## Tech

| Layer      | Choice                                     | Why |
|------------|--------------------------------------------|-----|
| Language   | TypeScript (strict) + C++20 (wrapper only) | types across the sim/render boundary |
| Bundler    | Vite 8 (Rolldown)                          | fast, native wasm/worker support |
| Physics    | RocketSim 2.2.1 → WASM via Emscripten      | deterministic car/ball physics, ~100k ticks/s |
| Rendering  | three.js r186 `three/webgpu` + TSL         | WebGPU with WebGL2 fallback, node materials |
| Audio      | Web Audio synthesis                        | no sample files |
| Input      | Keyboard + mouse (Pointer Lock) + Gamepad API | default keyboard / mouse and controller layouts, rebindable |

## Coordinate systems

* **Sim / AI / input / game logic: sim units** (uu, 1 uu = 1 cm, z up, blue goal at -y,
  red at +y, car local +x forward / +y right / +z up). See `src/sim/types.ts`.
* **Render: three.js** (y up, right-handed). Conversion in ONE place (`src/render/coords.ts`):
  `three = (sim.x, sim.z, sim.y)` for positions/vectors. For a RotMat with columns
  forward/right/up (sim): `Matrix4.makeBasis(map(forward), map(up), map(right))` so that the car
  model's local frame in three is **+x forward, +y up, +z right**. Scale: 1 uu = 1 three unit
  (the renderer sets camera near/far accordingly: near 10, far 30000).

## Module ownership (one owner per directory; others only import)

```
native/
  rs_api.h              C API contract (DONE, do not change signatures without updating types.ts)
  wrapper.cpp           implements rs_api.h on top of RocketSim; fills the state buffer; bump
                        de-dup (a mutual same-tick bump is merged, demo direction wins); goal
                        de-dup reset only when the ball is placed outside a net; deterministic
                        kickoff deal (RocketSim hands spots out in heap-address order, the wrapper
                        uses OUR spots in creation order from the seed, see native/README.md)
  build.ps1             emcc build → src/sim/wasm/rocketsim.{js,wasm} (ES module + wasm, bundled
                        by Vite into dist/assets)
  RocketSim/            git submodule: RocketSim v2.2.1 (MIT), never edited; patch-rocketsim.mjs
                        copies it to native/build/rocketsim with two patches (native/README.md):
                        Bullet broadphase triangle query (speed) and cars hashed by id in
                        Arena.h (deterministic iteration order)
src/sim/
  types.ts              state-buffer layout, CarControls, SimStateView (DONE)
  constants.ts          the field (dimensions, rounded corners, goals, boost pads, kickoff and
                        respawn spots), ball / car constants: the single source for sim and render
  arenaMesh.ts          analytic field → triangle mesh (uu, sim coords) for BOTH physics and visuals
  RocketSimBridge.ts    loads the wasm, implements SimStateView, step(), setControls(), events,
                        ball prediction (entries anchored to predTick so readers add the age)
  wasm/                 build output of native/build.ps1 (rocketsim.js, rocketsim.wasm, .d.ts)
src/render/
  coords.ts             sim→three coordinate mapping helpers (tiny, shared)
  materials.ts          palette, HDR helpers and the bloom contract (glowMrt / noGlowMrt)
  Renderer.ts           WebGPURenderer, scene, lights, sky, PMREM environment, RenderPipeline
                        (HDR scene pass with MRT output+emissive → bloom from emissive → vignette
                        → tone map; FXAA at tier 1), resize / pixel budget, quality tiers, GPU
                        timestamps (`#stats`)
  Arena.ts              visual arena (uses arenaMesh.ts), turf, glass, goals + nets, pads,
                        stadium (stands, truss, lamps, cones, halos)
  Camera.ts             chase camera (ball cam / car cam, camera settings & rules, field clamp,
                        camera swivel from CameraLook, rear view); keeps Settings.camera by reference
  Car.ts                procedural buggy (body with canopy + roll hoop, knobby wheels, twin plasma
                        boost jets, blob), per-team
  Ball.ts               procedural ball (two-tone halves, glowing seam band, T marks), blob
                        shadow, ground marker
  Effects.ts            pooled particles, ribbons (boost / streaks / ball), rings, goal flash
  Hud.ts                DOM HUD: scorebar (score + clock), segmented boost bar, ball indicator,
                        debug line (F3), Tab
                        scoreboard, pointer-lock hint, menu + "Controls & settings" screen
                        (rebinding both devices, camera / gameplay sliders)
src/ai/
  Bot.ts                heuristic bot: produces CarControls from SimStateView + ball prediction;
                        stall / net / wall recovery; scans every car (nearest opponent, bump
                        dodge); TeamContext = role / kickoff duty / teammate info a BotTeam
                        writes before each think (defaults reproduce the 1v1 behaviour)
  Team.ts               BotTeam: ranks its slots by intercept time every tick (hysteresis),
                        assigns attacker / support / defender roles and kickoff duties (go /
                        cheat / stay), lane + yield rules, attacker-stall hand-over, passive
                        members (the human teammate); README.md documents the tunables
src/input/
  bindings.ts           pure data: ActionId, Binding, the default layouts (DEFAULT_KBM /
                        DEFAULT_PAD, KEYBOARD_ONLY_KBM), labels, ACTION_ROWS, CameraLook
  Input.ts              keyboard + mouse + gamepad → CarControls, camera look (+ lookSource), held
                        states and one-shot / menu edges, driven by Settings.bindings; pointer lock
                        (the capturing click is masked), one pad poll per frame (beginFrame),
                        latchEdges for menu hand-off, rebind capture (startRebind: armed on the
                        next macrotask, Esc cancels on both devices, wheel only over the cell),
                        presets, vibration; an optional TouchSource (setTouchSource: read once per
                        sample, clamped to 0..1, summed into the keyboard column, so touch drives
                        the same modifiers and edges, never padActions or the camera look)
  touchState.ts         on-screen touch state, pure (no DOM, no CSS, node tests import it):
                        TouchState = Input's TouchSource (stick + per-button finger count and tap
                        latch, releaseAll), stickVector (radial deadzone + gain, up = +y),
                        hitCircle, the TB buttons → actions mapping (copied from DEFAULT_KBM)
src/settings.ts         Settings { controls, camera, bindings }: defaults, ranges,
                        validation, localStorage load / save. One live object shared by Input,
                        ChaseCamera and the Hud; Game.applySettings() persists and re-applies
src/game/
  Match.ts              match rules state machine (kickoff countdown, goal reset, clock, overtime)
  Game.ts               fixed-step loop: input → controls → bot teams → sim.step → sync →
                        render(alpha); the roster (game modes, setMode / addRoster), per-car views
                        / controls / effects registration, scoreboard rows, prefs (difficulty,
                        quality, mode),
                        pipeline warm-up, goal-pause ball pin, audio / HUD glue, settings glue,
                        pointer lock (canvas click captures, menu / pause / whistle / blur release,
                        a browser-side release pauses like the Esc menu, a click on the paused
                        game resumes and recaptures), pause screen → menu (quitToMenu: Backspace
                        / pad B while paused clears the match and reopens the menu at kickoff);
                        online: one GameSession at a time (session / online / p2p, setSession,
                        startSession(mode, kind)); phase 1: applyOnlineRoster (fresh arena from
                        the Welcome roster, player at its slot, no local bots), onlineTick (input
                        -> OnlineSession.stepTick -> sync), afterRollback, onOnlineEvent (HUD /
                        FX from host events); phase 2 (P2PGameHooks): applyP2PRoster,
                        p2pSampleInput / p2pAfterTick / p2pMatchEvent / p2pKickoffReset /
                        p2pSlotDropped (banner + BOT tag) / p2pHandover (fallback to the phase 1
                        session); restoreOfflineRoster
  OnlineSession.ts      the online match inside the frame loop: quickMatch (guest -> queue ->
                        connect), advance(dt) (staged snapshot -> rollback, lead = f(rtt, jitter)
                        + bufferHint adjust, drift absorbed by a 0.95-1.05 tick-rate scale, hard
                        resync beyond 8 ticks), stepTick (pack own input, step, send every 2nd
                        tick), host match state (score / clock / frozen / overtime) from events,
                        NetStatsView for the HUD panel; quickMatch(mode, notice, 'ranked') for
                        ranked (lastRankedMatchId for the result dialog), 'cancelled' event
  trainingPacks.ts      pure data: the 9 shot packs (shooting / saving / aerial x easy / medium /
                        hard), FREEPLAY_ID, spawn poses
  TrainingSession.ts    pure training state machine: frozen until the first input, per-shot timer
                        + landing grace, judging per category (saving: cleared 1 s after the
                        last touch), attempts,
                        next / previous / reset, pack summary
  trainingRecords.ts    best run per pack in localStorage (validated on load)
  (Game.ts: startTraining / stopTraining run a one-car arena through trainingTick instead of tick)
src/ui/                 the front-end menus, styled by menu.css (mn-)
  Menu.ts               controller: top bar (breadcrumb, region / players online, account chip),
                        screen stack, bottom bar (key hints + the matchmaking banner with timer and
                        cancel), toasts, modals, shared prefs (region, playlists, connection),
                        population polling; MenuHost = what the Game provides (search, friendly,
                        training, lobby matches, settings screen)
  nav.ts                spatial focus navigation (arrows / D-pad pick the nearest target in that
                        direction; Enter / A activate natively; side controls claim left / right)
  dom.ts, badges.ts     h() builder, nav buttons, CSS-drawn rank badges and rating cards
  screens/              home, play hub, casual, competitive, friendly (play.ts), custom lobby
                        browser / create / lobby (custom.ts), training, profile (sign in / up /
                        recover, account actions), leaderboard + ranked result dialog
src/net/
  protocol.ts           wire protocol shared with server/ (DONE): one binary frame per message,
                        Input / Snapshot / Ping / Pong packed, Welcome / Event / Error / Kick as
                        JSON; fnv1a32; the HTTP control-plane types (GuestSession, QueueResult)
  NetClient.ts          guest record (localStorage), queue long-poll (401 re-register, 409 ->
                        rejoin, cancel -> /api/leave), WebSocket with ['tg1', 'ticket.<jwt>'],
                        input / ready / ping senders, message dispatch, one automatic rejoin;
                        fetch / WebSocket / clock / storage injectable (node tests)
  ClockSync.ts          4-timestamp rtt / offset / host-tick estimate (medians over 16 pongs),
                        computeLead, LeadAdjuster (bufferHint -> +-1 tick per second)
  InputRing.ts          256-tick ring of the player's packed inputs, assembleInputs (newest 2 +
                        every unacked tick, cap 16)
  Prediction.ts         RollbackPredictor: stepLocal, applySnapshot (rs_load_state -> hash check
                        -> remote holds from the echo -> replay own ticks -> visual error offsets
                        with decay / snap), counters (rollbacks, desyncs, resyncs, mispredictions)
  NetStats.ts           loss estimate from snapshot tick gaps, rate meters, NetStatsView (phase 1
                        fields + the P2P per-peer rows)
  account.ts            accounts / ranked / lobby JSON contract shared with server/, username and
                        password rules, clientPasswordKey (PBKDF2 in the browser), regions
  rating.ts             Weng-Lin (OpenSkill) Bradley-Terry team rating, abandon rules, tiers,
                        placement, MMR scale, abandon ban ladder (shared with server/)
  AccountClient.ts      sign in / up / recover / OAuth redirects, 1 h Bearer refreshed from the
                        HttpOnly cookie, /api/me, leaderboard, ranked result polling
  LobbyClient.ts        custom lobbies: list / create / join by code, the lobby socket (state,
                        match result per member, back, kick, settings)
  p2p/                  phase 2: peer-to-peer deterministic rollback (docs/online/PHASE2.md)
    protocol.ts         (DONE) signaling JSON (RoomWelcome, signal relay, ready, start, drop,
                        unreachable, hashReport) + binary mesh packets (Input batches with
                        ackTick / myTick, Hash, StateRequest / StateResponse), QueueResultP2p
    InputStore.ts       per-slot 256-tick ring of packed inputs keyed by tick (the "known" map)
    Rollback.ts         RollbackEngine: confirmed + predicted timelines in ONE sim, a snapshot per
                        confirmed tick, hold-last prediction, exact arrival diff, hash vote
                        (majority over humans + me, ties -> lowest slot), stateAt / resync, lead
                        estimate from ackTick (throttle) and stall (window), drops (slot -> bot
                        from atTick), hooks botInputs / onConfirmedTick / onResync
    RoomClient.ts       WebSocket to /room/:id (ticket in the subprotocol), one callback per
                        message, ping / pong clock offset (medians of 8), serverToLocal
    Mesh.ts             one RTCPeerConnection per other human (perfect negotiation: the lower
                        slot is impolite and creates the channels), 'game' unordered / unreliable
                        + 'ctl' reliable, liveness (2 s without game packets or ICE failed 5 s ->
                        dead, one ICE restart first), getStats 1 Hz (host / srflx / relay, RTT),
                        assembleGamePacket; fake connections in node tests
    P2PSession.ts       the P2P match inside the frame loop: quickMatch (or joinAssigned: a
                        custom lobby's room) -> room -> mesh ->
                        ready -> start -> wall-clock ticks (canAdvance: stall hint / timesync
                        skip), engine hooks (seeded BotTeams + Match on the confirmed timeline
                        only, goals from the ball-scored flag, kickoff seeds seed + n), input
                        batches with chunked backlogs and contiguous acks, hashes over 'ctl',
                        resync / abandon, drops, NetStatsView, fallback to OnlineSession
server/                 Cloudflare Workers backend (own package, wrangler; server/README.md)
  src/index.ts          Worker: /api/guest, /api/queue { mode, kind } (long-poll), /api/rejoin,
                        /api/leave, /api/ice (STUN + optional TURN credentials), /ws/:matchId and
                        /room/:roomId (one gate: ticket verified at the edge, role 'player' /
                        'peer', claims forwarded in headers; Origin checked against VITE_ORIGINS,
                        loopback page origins accepted while the Worker runs on a loopback host)
  src/auth.ts           HS256 JWT on WebCrypto: sessions, tickets (jti), internal header
  src/MatchmakerDO.ts   one per region (chosen in the menu or the continent): a waiter sits in
                        the queue of every playlist it searches; 'ranked': MMR window growing
                        with the wait, balanced teams, never bots; /custom forms a lobby's
                        match with fixed teams; /population for the menus;
                        queues per (mode, kind); 'server': bot fill after 10 s;
                        'p2p': a room at once with the mode's humans, after 15 s with >= 2 humans
                        + bots, a lone human -> a server match; rosters, seeds, tickets, locks
  src/RoomDO.ts         one per P2P room (Hibernation API, no simulation): RoomWelcome (seed,
                        slots, ICE), signal relay, ready -> start { startAt: now + 1.5 s }, drop
                        { slot, atTick: max(reported) + 60 } on a majority of 'unreachable'
                        reports or a socket closed > 5 s, hashReport, locks released on close,
                        cleanup 60 s empty / 20 min TTL
  src/MatchDO.ts        one per match: sockets, RoomHost loop (setInterval 8 ms + accumulator),
                        snapshots every 4 ticks, events, TTL / shutdown; ranked: no start until
                        every player is ready (else cancelled at 45 s, no-shows penalised),
                        forfeit when a team quits / stays disconnected 60 s, result -> AccountsDO
  src/AccountsDO.ts     the one SQLite object for every account (accountStore.ts): users,
                        refresh tokens, ratings, ranked results / abandons / bans / locks, login
                        throttle, daily prune
  src/accountRoutes.ts  /api/auth/* (register, login, refresh cookie, logout, recover, password,
                        recovery codes, Google / Discord OAuth with PKCE), /api/me, leaderboard,
                        ranked result; server-side PBKDF2 of the client key
  src/LobbyDO.ts        one per custom lobby (hibernating): members / teams / host / settings,
                        admit (password, kick list), start through the matchmaker's /custom
  src/LobbyDirectoryDO.ts  join codes -> lobby ids and the public list per region
  src/roomHost.ts       RoomHost: per-slot input rings (hold last, bufferHint), BotTeam for bot
                        slots, Match rules, rs_save_state snapshots (env-agnostic; fake-sim tests)
  src/wasm.ts           the shared rocketsim.wasm as a WebAssembly.Module in workerd
  test/                 auth + RoomHost + room / matchmaker unit tests (node), smoke.mjs (phase 1
                        end to end vs wrangler dev), smoke-p2p.mjs (phase 2 signaling end to end)
docs/online/            PHASE1.md, PHASE2.md (the designs), DECISIONS.md (confirmed decisions),
                        MEASUREMENTS.md, ACCOUNTS.md (menus, accounts, ranked, lobbies, OAuth setup)
src/audio/
  Audio.ts              synthesized engine/boost/impact/goal sounds driven by sim events
src/main.ts             boot: wasm load ‖ renderer init, build arena, settings, Game, warm-up
                        render, start
index.html, src/style.css
tests/                  node tests (node --test): sim harness (wasm, incl. the 8-car layout, 2v2 /
                        3v3 kickoffs, slot compaction), arena mesh validity, arena physics, bot
                        (pure + wasm-backed recovery, near-ball rules), bot team (roles,
                        hysteresis, kickoff duties, lane / yield, passive human, attacker stall,
                        one-slot team == standalone Bot), headless 100 s bot matches per mode
                        (bot-match: dead ball / out of arena / own-goal guards via
                        smoke-match.mjs), match rules, chase camera (swivel / rear view), input
                        (bindings, mouse, pad, rebinding), touch (TouchState, stickVector, the
                        TouchSource hook; without a source Input matches a golden recorded before
                        touch support), HUD menu helpers (incl. GAME_MODES == constants.MODES),
                        sim-state (save / load / hash / packed controls, the wasmModule load
                        path), net-prediction + net-client (fake sim / fake fetch + socket),
                        net-rollback-wasm and net-roomhost-wasm (RoomHost host sim + client
                        RollbackPredictor on the real wasm: hash per snapshot, replay of the
                        applied inputs between snapshots)
scripts/                headless node runs: smoke-sim.mjs (one Bot vs an idle car),
                        smoke-match.mjs (BotTeam vs BotTeam in any mode: touches, goals incl.
                        own goals by last-toucher attribution, bumps, stuck time, throughput;
                        fails on a > 10 s dead ball or an own-goal streak)
```

### Bloom / glow contract (src/render/materials.ts)

At tier 0 the scene pass renders two targets, `output` and `emissive`; bloom reads only
`emissive` (threshold 0). Lit node materials write their `emissiveNode` there automatically. Unlit
materials write nothing unless they set `material.mrtNode = glowMrt(<vec3 node>)`; untagged ones
would *overwrite* the target (NoBlending), so every transparent / additive material (flames,
particles, ribbons, rings, glass, blobs, markers) is tagged — with `noGlowMrt()` when it must not
glow. The MRT write has alpha 1, so fading materials fold `diffuseColor.a` into the glow term; the
glow is read back from `diffuseColor` so view-dependent terms are evaluated once (re-evaluating
them inside the output struct produced NaNs).

**NaN contract.** three writes the colour target through `max(output, 0)` (WGSL / HLSL / MSL
`max` return the non-NaN operand), but the MRT `emissive` member is written raw, and a single NaN
texel there blurs through the bloom mips into a black rectangle over most of the screen (the
"black square when boosting at HIGH": under MSAA the flame's `uv.y` is extrapolated past 1 on
silhouette edge pixels and `pow(1 - uv.y, 3)` went NaN). So: every glow write goes through
`glowMrt`'s clamp (`max(0).min(GLOW_MAX)`), the scene pass applies the same clamp to the
`emissive` member of its own MRT (what lit materials without an `mrtNode`, the ball and the car
bodies, write), the composite reads `output`, `emissive` and the
bloom result through `max(0).min(65000)`, and shader terms that can leave the unit range (uv
under MSAA extrapolation, `pow` bases, fades) are saturated first (`Car.ts` flame, `Effects.ts`
ribbons / flash). `#nancheck` in the URL reads the three targets back every 30 frames and logs
NaN / Inf / negative counts (`window.__nancheck`); it costs nothing without the hash.

### Pipeline warm-up

`Game.warmUp()` renders one frame through the real pipeline with every normally hidden mesh made
renderable at zero intensity (`setWarmUp(on)` on CarView / BallView / Effects) before the boot
overlay goes away and on the frame after a tier switch, so no shader compiles on the first boost,
airborne ball or goal.

## Frame loop (src/game/Game.ts)

```
requestAnimationFrame(t):
  dt = clamp(t - last, 0, 0.1); acc += dt
  input.beginFrame()                      // one navigator.getGamepads() per frame
  while acc >= TICK_DT:
     controls[0] = input.sample()         // player (keyboard + mouse + pad, summed); also
                                          // updates input.look / held / action edges
     bots.think(state, redOuts)        // one think per team per tick (a team may hold its
     mates.think(state, blueOuts)         // outputs for a few ticks); outs are views into controls[]
     for every roster car i: sim.setControls(carIds[i], controls[i])
     sim.step(1); sim.sync()              // state buffer now holds tick N
     match.onTick(state)                  // goals, clock
     snapshot prev/cur transforms (cheap copies of pos/rot of ball + cars)
     acc -= TICK_DT
  processActions()                        // pause / ball cam / reset edges, pad edges → menu
  alpha = acc / TICK_DT
  chase.update(..., input.look)           // swivel + rear view
  renderer.render(prev, cur, alpha)      // interpolated transforms, camera, effects, HUD
                                          // (scoreboard while held, pointer-lock hint)
```

Online (`Game.onlineActive`) the same frame calls `OnlineSession.advance(dt)` instead of the
`while` loop: it applies the staged snapshot (rollback + replay), compares the local tick with
`hostTickEstimate + lead` and steps `Game.onlineTick()` at a period of `TICK_DT / rateScale`
(0.95–1.05 of real time to absorb the drift; beyond 8 ticks it catches up or stalls instead).
`onlineTick` samples the input, lets the session pack / send / step, then does the same
bookkeeping as `tick()`. The offline `Match` is not ticked online: score, clock, frozen state and
banners come from host events.

The sim runs on the main thread (a 1v1 tick costs ~10–30 µs in WASM, a 3v3 tick ~42 µs; with
six bots thinking the headless 3v3 match runs at ~100 µs per tick, `npm run smoke:match`). The
bridge is the only
module that touches WASM memory; everything else reads `SimStateView.buf` through the offsets in
`types.ts`.

## Game modes (1v1 / 2v2 / 3v3)

`MODES` in `src/sim/constants.ts` maps a `GameMode` to cars per team; the state buffer is sized
for `MAX_CARS = 8` (`types.ts`), the UI stops at 3v3.

* **Roster** (`Game.carIds`, creation order = sim slot order): the human's blue car first (slot 0),
  then its blue teammates, then the red cars. `addRoster(sim, playerCarId, mode)` adds the
  bots next to an existing player car and rolls back on failure; `main.ts` uses it at boot (from
  `prefs.mode`, falling back to 1v1 when the wasm refuses the line-up) and `Game.setMode()` when
  the menu's Mode row changes. Every roster entry gets a `CarView` (team colour from
  `sim.teamOf(slot)`), a preallocated `CarControls` (`MAX_CARS` of them, entry 0 = the player's),
  an `Effects.registerCar` and a scoreboard row (`You`, `Bot 1`, `Bot 2`... per team). Creation
  order is also the sim's iteration order (Arena.h id hash, Bullet pair order), which was suspected
  of favouring one team; measured with mirrored deterministic (hard) bots it does not: a mirrored
  1v1 kickoff ends with ball.y = 0 for either order (24 seeds), and over 168 five-minute 1v1 /
  2v2 / 3v3 matches the team created first scored 1028 goals to 992 with the sign of the
  difference flipping between batches (182-204, 301-305, 545-483). The human's team stays first.
* **Bots**: two `BotTeam`s (`src/ai/Team.ts`), one for the red slots and one for the blue
  teammates (no slots in 1v1 → never asked to think). Each thinks once per tick for all of its
  slots, writing into the controls objects of those slots. Both get the menu difficulty. The blue
  team also gets the human's slot as a **passive member**: ranked for roles, kickoff duties, the
  lane / yield rules and the attacker-stall hand-over like any teammate, never driven, so the
  teammates rotate around the player instead of double-committing with it.
* **setMode** is only honoured while the menu is up (or before the first match): the non-player
  cars are removed from the sim (slots compact; ids stay), the new roster is added, the car views
  and the Effects are rebuilt (arena and ball stay), everything goes back to kickoff, the camera
  snaps and a warm-up frame compiles the new flames. The mode persists in `GamePrefs` /
  localStorage with difficulty and quality.
* **Frozen** (countdown, goal pause, after the whistle, menu): every roster car gets zero controls.
* **HUD**: the menu has a Mode row (← → on the row, `M`, pad left / right; ↑ ↓ / D-pad move the
  focus across Difficulty / Mode / Quality, `Q` still toggles quality) and shows
  `<mode> · <n> cars` in its info line; the Tab scoreboard diffs a `rows` array by content and
  rebuilds its two columns only when a roster or a name changes.

## Online (phase 1)

Topology: one `MatchDO` per match is the authority; it runs `RoomHost` on the same
`rocketsim.wasm` the browser uses (instantiated from an imported `WebAssembly.Module`, the only
path workerd allows) at 120 Hz from a `setInterval(8 ms)` + `Date.now()` accumulator (≤ 8 ticks
per callback; `Date.now()` only advances between callbacks in workerd). Every client runs the
same sim `lead` ticks ahead with its own inputs and the last known input of every other slot,
and reconciles on each snapshot. The control plane lives in the Worker (`server/src/index.ts`);
rooms are formed by one `MatchmakerDO` per region.

Determinism contract (what makes the rollback bit-exact):

* Inputs are 6 int8 per car (`packControls`); host and client feed them through
  `rs_set_controls_packed`, which converts `v / 127` exactly like the f32 boundary does.
* A snapshot carries `rs_save_state` (Bullet-exact: body anchors, per-wheel physics state,
  pending controls, ball, pads; `native/README.md`) plus `fnv1a32` of it. The client loads it,
  checks `stateHash()` (a mismatch counts as a desync and must never happen with the same wasm),
  then replays `snapshot.tick + 1 .. localTick` from its `InputRing`. `tests/net-roomhost-wasm`
  proves a host tick is reproducible from blob + applied inputs alone.
* Kickoff resets use the seeds `kickoffSeed + n` on the host; the client never resets a kickoff
  itself, the next snapshot carries the new layout (the visual offsets snap beyond 2 m).
* Not in the blob: the wrapper's goal / bump counters (monotonic: a replayed tick re-fires
  `onBump`, so the Game spaces bump FX by 40 ticks online and takes goals from host events), the
  ball predictor (self-heals on the next refresh). The demolition respawn spot no longer depends
  on hidden state: the wrapper picks it from (tick, car id) after RocketSim's respawn.

Timing: `lead = ceil((rtt / 2 + 2 · jitter + 2 ms) / 8.33 ms) + 1` clamped to [2, 24], plus a
±1 tick/s correction driven by the host's `bufferHint` (queued inputs − target 2, clamped ±8);
the host holds the last input on an underrun and reports it. Snapshots are staged on arrival and
applied at the start of the next frame, so a frame never renders a half-applied state.

Wire protocol: `src/net/protocol.ts` (binary, little-endian, one frame per message; JSON only for
Welcome / events / errors). Frames ≤ 512 B, ≤ 2 input packets per host tick per slot, a malformed
frame closes the socket with 1008.

## Online (phase 2: P2P rollback)

Topology: no simulation server. Every human peer runs the same wasm, the same two `BotTeam`s
(seeded `seed` / `seed + 1000003`, difficulty medium) and the same `Match`; peers exchange only
packed inputs over a full WebRTC mesh (`Mesh.ts`), signalled through a hibernating `RoomDO`
(`RoomClient.ts`). `P2PSession` drives the loop from the wall clock: tick 0 is `start.startAt`
(server clock, placed locally through the room's ping / pong offset) and each frame simulates
up to the expected tick while `RollbackEngine.canAdvance()` allows it.

Determinism contract (binding): bots and `Match` run ONLY on the confirmed timeline, once per
confirmed tick, in order, inside the engine hooks (`botInputs(tick)` syncs the confirmed state
with the bridge's FX events muted, refreshes the ball prediction on every confirmed tick and
packs the bot controls; `onConfirmedTick(tick)` reads goals from the ball-scored flag, ticks the
Match and resets kickoffs with `rs_reset_kickoff(seed + n)`). Predicted ticks use hold-last
inputs for every non-local slot and never call bots or Match. A confirmed tick is one whose
input is known for every human slot; the engine keeps a snapshot per confirmed tick and, when a
remote input differs from the prediction, loads the confirmed snapshot, confirms as far as the
inputs allow and re-predicts (~40 us per `advance()` on the real wasm). Hashes of the confirmed
state every 30 ticks are voted peer to peer (majority; ties -> lowest slot, so 1v1 takes slot 0
as the reference); two minority verdicts in a row fetch the majority's `rs_save_state` blob and
`resync`, a third abandons. Drops are agreed by the room (`atTick` in everyone's future) so every
peer switches the slot to its team AI on the same confirmed tick.

Timing: input delay 3 ticks, prediction window 16 (beyond it the loop stalls and the HUD shows
"Esperando a <name>..."), inputs sent every 2 ticks with every unacknowledged tick (acks are the
contiguous tick; a backlog longer than 16 goes out as several packets), a latency-free lead
estimate from each packet's `ackTick` / `myTick` throttles a peer that runs ahead (a timesync
skip moves its tick 0 one tick later). Measured numbers: `docs/online/PHASE2.md`
("Verification").

## Rendering budget (measured)

* Arena + stadium + pads: 12 draw calls (floor, glass shell, glass ceiling, goals, goal bars /
  nets, truss, haze cones, stands, masts, halos, pads ×2), all procedural TSL, no textures.
* Cars: body (1 merged geometry) + 4 wheels (1 instanced) + flame (while boosting) + blob (while
  airborne at tier 0) per car. Ball: sphere + blob + marker (airborne). Effects: particles (1
  instanced), ribbons (1), rings (1 instanced), goal flash (1).
* Shadow pass: only cars and the ball cast (5 draws); the floor receives.
* Full match frame: ~34 draws at tier 1, ~41 at tier 0, up to ~46 with effects; ~40k triangles.
* Post: tier 0 = MSAA x4 scene pass + bloom from the emissive target + vignette; tier 1 = no MSAA,
  no bloom, FXAA. Pixel ratio: tier 0 min(dpr, 6 Mpx budget) and never below 1, tier 1 = 1.
* Measured (desktop-app browser pane, WebGPU): 165 fps display-limited at 491×377, ~82 fps at
  1920×1080×1.37, GPU 0.2–1.1 ms at the small size. Target stays 144+ fps on a mid-range GPU at
  1080p and 60 fps on integrated graphics at tier 1.

## Legal

Turbogol is AGPL-3.0-or-later (`LICENSE`). RocketSim (MIT, ZealanL) is a git submodule; its
license and those of Bullet (zlib), three.js (MIT) and the Emscripten runtime libraries are in
`THIRD_PARTY_NOTICES.md` and ship with every build. Every model, texture, layout and sound of the
game is generated by this repository's code; no third-party game content is used.

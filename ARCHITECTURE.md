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
                        uses OUR spots in creation order from the seed, see native/README.md);
                        physics mutators (rs_set_mutators: a whole preset against hard limits,
                        all or nothing, copied into the ball predictor's arena)
  build.ps1             emcc build → src/sim/wasm/rocketsim.{js,wasm} (ES module + wasm, bundled
                        by Vite into dist/assets)
  RocketSim/            git submodule: RocketSim v2.2.1 (MIT), never edited; patch-rocketsim.mjs
                        copies it to native/build/rocketsim with three patches (native/README.md):
                        Bullet broadphase triangle query (speed), cars hashed by id in Arena.h
                        (deterministic iteration order) and a car top speed mutator (supersonic
                        thresholds scaled; stock runs the original expressions)
src/sim/
  types.ts              state-buffer layout, CarControls, SimStateView (DONE)
  constants.ts          the field (dimensions, rounded corners, goals, boost pads, kickoff and
                        respawn spots), ball / car constants: the single source for sim and render
  arenaMesh.ts          analytic field → triangle mesh (uu, sim coords) for BOTH physics and visuals
  RocketSimBridge.ts    loads the wasm, implements SimStateView, step(), setControls(), events,
                        ball prediction (entries anchored to predTick so readers add the age),
                        createArena(tickRate, mutators?) (stock without a preset), getMutators()
  mutatorLayout.ts      the wasm's mutator layout: slots, float32-exact stock values, the hard
                        limits mirrored, mutatorFingerprint (imported by the bridge: node-bundled)
  mutators.ts           experimental physics presets, the core's half: arenaMutators (src/game/
                        physicsRules.ts PhysicsRules -> createArena's layout, null for stock),
                        toMutators / botPhysicsOf (exact stock for defaults), physicsFingerprint,
                        gameSpeedFactor; the table itself is physicsRules.ts (not node-bundled)
  wasm/                 build output of native/build.ps1 (rocketsim.js, rocketsim.wasm, .d.ts)
src/render/
  coords.ts             sim→three coordinate mapping helpers (tiny, shared)
  materials.ts          palette, HDR helpers, the bloom contract (glowMrt / noGlowMrt: null on
                        tiers without bloom, setGlowTargets / keepGlowTag), cheap value / cell
                        noises, OpaqueAlbedoPhysicalMaterial (albedoNode)
  quality.ts            the four quality tiers (superlow / low / high / ultra) and the one table of
                        switches (TIERS, `tier(q)`) every view reads, incl. the render path
                        (`output`: 'direct' for superlow and low, 'post') and the Performance look
                        (`bakedLight`: unlit turf, stands, steel and boards; `netting`) and super
                        low's (`world` 'lite', `cheapMaterials`, `crowd`, `glare`, `liteTurf`,
                        `maxFps`, `preferWebGL2`, `cpuLite`); pixelRatio (tier, dpr, budget, max
                        texture size; below 1:1 for super low's SUPERLOW_PIXELS); parseQuality
                        reads old 0 / 1 saves; startingQuality (WebGL2, WebGPU compatibility mode
                        and <= 4 GB devices start on low unless the player chose a tier, super low
                        never raised; never above the GPU's ceiling); needsReload (into or out of
                        super low); drawsFrame (the frame cap); lowerQuality; menuQualities (super
                        low listed only for unlocked players) and nextQuality over such a list
  bootTier.ts           the boot tier before the renderer exists (the URL's #superlow, the tab's
                        recovery, a GPU of the device that fell to super low (a ceiling known
                        before the backend), the player's choice, super low on a TV with a slow GPU or on
                        1 GB: autoSuperlow, probeGpu, readBootSignals), the TierReason #diag shows,
                        tierPrefsAfter (the prefs keep the player's pick only; 'lock') and
                        gateTierPrefs (a locked player's saved super low reads as Performance, not chosen)
  experimentalPage.ts   Settings > Experimental: a guest's locked line, the switch (a second press
                        when turning it off restarts on Performance), what it unlocks, Super low's
                        line and the preset editor (picker over the built-ins and the player's
                        presets, New / Duplicate / Rename / Delete, the name field, one stepper or
                        cycler per value on its grid with the standard value, the summary line,
                        Reset to standard); contexts menu / training (experimental free play's
                        live pick) / match (the room's rules, read-only); built once through the
                        Hud's PageKit, lines shown / hidden, edits saved at once
  rulesText.ts          the texts of physics rules: preset names (built-ins from the locale),
                        values (km/h, %, s, on / off, demolitions), standard values, the summary
  hashFlags.ts          the URL hash flags as whole words with optional values (parseHashFlags,
                        pageFlags: diag / audit, stats, debug, net, nancheck, worldnocache,
                        webgl2, webgpu, superlow, tv, lowgpu, compat, nof32filter, nofloatrt,
                        nomsaa, msaa, nopost, norender, pr, hide)
  frameStats.ts         `#diag`'s frame rate (1 s min / mean, 5 s mean, frames over 50 / 100 ms)
                        and CPU per frame (ball prediction, bots, physics step, render), fed by the
                        Game only with the flag
  capabilities.ts       what the device can do (readCapabilities at init: compatibility mode, a
                        multisampled HDR target / canvas, float32 filtering, max texture size,
                        colour targets, the GPU key) and adjustTier: a tier without what the device
                        cannot do (pure; tierChanges for #diag)
  tierGuard.ts          the safety net: TierGuard (a failure within 20 s of a switch, or a lost
                        device, falls back one tier, low to super low too; a device lost in the
                        background or on super low reloads on the same tier; never a loop), the
                        tab's lost-device counter (lossStep: reload, then super low, then stop) and
                        the per-GPU ceiling in localStorage (readCeiling / writeCeiling, 30 days;
                        raiseCeiling when the player's own pick runs the window clean, a pick
                        across a reload tried once above it: TRY_TIER_KEY); a ceiling at super low
                        also leaves a backend-free record (readSuperlowBoot) so the next boots pick
                        super low's own backend and context before the renderer exists
  theme.ts              stadium themes (ThemeId, THEME_IDS) and the world facts views share (key
                        lights, fill, floodlights, wetness, fog, tone mapping, grade, and each
                        theme's brighter `low` look and lights: lookOf / lightsOf); data only
  Renderer.ts           WebGPURenderer, scene, camera, capabilities (`caps`, the adjusted `spec`),
                        resize / pixel budget (tier maxPixelRatio / pixelBudget), GPU timestamps
                        (`#stats`), dynamic resolution (scene pass, or the direct tier's pixel
                        ratio), `#nancheck`, `#webgl2`, `#lowgpu` / `#tv` / `#nofloatrt` /
                        `#compat` / `#nof32filter` / `#nomsaa` / `#msaa` / `#diag` (gpuDiag.ts),
                        `#pr` / `#hide` / `#nopost` / `#norender`, the boot tier (bootTier.ts: super
                        low's WebGL2 backend and context without MSAA, decided before init) and
                        the float-target guard (capabilities.ts canRenderHalfFloat: WebGL2 without
                        any renderable half float runs super low), `tierReason`, precompile (WebGL2:
                        the path's state held until the deferred builds are done), GPU failures
                        (setFailureListener); builds the lighting, the world (or the lite world)
                        and the render path
  gpuDiag.ts            `#diag`: an on-screen panel (backend, GPU, extensions / features, limits,
                        capabilities, the tier as the device runs it, the ceiling, theme, shader
                        and GPU errors with the first ones kept, the passes of a failed command
                        buffer, WebGL programs over the limits) for a phone screenshot; `#lowgpu`:
                        the WebGL2 backend with a Mali-G51-class context (no float-linear /
                        float-target / float-blend extensions, capped limits) installed before
                        three initialises; `#compat` / `#nof32filter`: a WebGPU adapter without
                        'core-features-and-limits' / 'float32-filterable'; `#nomsaa`: no tier
                        multisamples, `#msaa`: the canvas MSAA in compatibility mode too (A/Bs of
                        its cost on a phone); `#lowgpu` keeps EXT_color_buffer_float where the
                        device has no half-float target; `#tv`: the 1 GB Android TV's WebGL2
                        (no half-float target, anisotropy, parallel compile; 'ARM / Mali-G31';
                        installGlEmulation, also for the boot's GPU probe); `#nofloatrt`; the
                        panel also shows the boot signals, the tier's reason, the frame rate and
                        CPU (frameStats.ts), the wasm memory, the pipelines, a lose-context button,
                        a `[diag-json]` console line every 5 s; `#diag=audit` adds getError and the
                        program audit
  dynamicResolution.ts  pure controller: frame intervals (+ GPU ms with `#stats`) → resolution
                        scale between the tier's minResolutionScale and 1 (frames of 100-500 ms:
                        late, clamped; half a window that slow goes to the minimum at once)
  world/                World.ts (createWorld: fog node, clear colour, the baked sky + backdrop
                        cube and PMREM, the theme's live near layer, the lighthouse beam; `ready`,
                        `stats`), presets.ts (per-theme sky / backdrop data, the skyline of each
                        theme), atmosphere.ts (sky, cloud, haze shading), backdrop generators
                        (a live layer + a baked far part each): harbour.ts (SKYLINE_TOP, the
                        stadium box), canyon.ts (baked only, NEAR_WALL), alpine.ts
                        (+ alpineShade.ts, its TSL patterns);
                        geo.ts (GeoBuilder, KIND, rng and the CPU noise), lightmap.ts (lamp light
                        map of the live layer), bakeMaterials.ts (the sky, sea and structure
                        materials; one branch per KIND range), bake.ts (CubeBaker), dome.ts
                        (parallax dome, PROXY_TOP), env.ts (the PMREM probe), cache.ts
                        (IndexedDB, keyed by the backend and its emulation), queue.ts (latest-wins
                        bake / cache queue), liteWorld.ts (createLiteWorld, super low: a gradient
                        dome from the theme's sky preset with the place's silhouette; no bake,
                        environment, live layer, fog or cache)
  post/                 lighting.ts (createLighting: the theme's two keys + shadows, hemisphere
                        fill), pipeline.ts (buildPostChain: 'post' = HDR scene pass with MRT
                        output + emissive → [ultra extras] → bloom from emissive → vignette →
                        exposure, grade and the theme's tone curve → sRGB, FXAA without MSAA;
                        'direct' = three's DirectRenderPipeline, the same look and sRGB at the
                        end of every material, straight into the multisampled canvas),
                        screenSpace.ts (ultra: GTAO, wet-pitch SSR, lens glare), quadPass.ts
                        (generic full-screen pass: the half-resolution depth copy)
  turf/                 TurfView (the floor mesh, the ultra blades), turfMaterial.ts (the pitch
                        material, its lighting model and capped environment, the analytic
                        floodlight streaks), bake.ts (blade field, field map, pool map),
                        markings.ts, grassBlades.ts (ultra), turfTheme.ts (per-theme looks)
  stadium/              StadiumView (cage netting on the shell and roof, LED board band with a
                        big sponsor board on each side wall, steel cage and floodlight towers,
                        lamp panels / glare / ultra beams, stands and crowd); layout.ts (pure
                        positions, the panel grid), geometry.ts (shell split), palette.ts
                        (per-theme uniforms; `standWood` turns the stands to timber),
                        netting.ts, boards.ts, steel.ts, floodlights.ts, stands.ts (stand
                        structure with the concourse apron round the cage, crowd), textures.ts
                        (the board canvas atlas, repainted when the place changes), content.ts
                        (each place's invented sponsors, its main and secondary sponsor),
                        emblems.ts (canvas-path emblems)
  Arena.ts              visual arena (uses arenaMesh.ts): converts the sim's surfaces, builds the
                        TurfView and StadiumView, goals + nets (drawn from both sides), goal
                        frames, pads; forwards setTheme / setWarmUp to the turf and the stadium
  Camera.ts             chase camera (ball cam / car cam, camera settings & rules, field clamp,
                        camera swivel from CameraLook, rear view); keeps Settings.camera by reference
  Car.ts                procedural dune runner (body with canopy + roll hoop, knobby wheels, twin
                        plasma boost jets, blob), one shared surface material for all cars:
                        per-vertex surface kinds (CAR_KIND) for flake paint under clearcoat,
                        carbon, glass, metals, tyres, HDR lamps; the body and wheel pipelines
                        build only their own graph
  Ball.ts               procedural panelled ball (truncated icosahedron: pearl hexagons, graphite
                        pentagons with lime glow rings, stitched seams; BALL_COLORS), blob shadow,
                        ground marker
  Effects.ts            pooled particles, ribbons (boost / streaks / ball), rings, goal flash
  Hud.ts                DOM HUD: scorebar (score + clock), segmented boost bar, ball indicator,
                        debug line (F3), Tab
                        scoreboard, pointer-lock hint, the pause menu (PauseEntry list from the
                        Game: RESUME, training entries on one row, RULES in experimental free
                        play, SETTINGS, QUIT; its own focus
                        ring driven by Input's menu edges), menu + the settings screen (tabs:
                        rebinding both devices, camera / gameplay sliders, Audio: master volume,
                        Graphics: the quality tier among MenuOptions.qualities, Experimental:
                        experimentalPage.ts; refreshSettings redraws it when the account changes;
                        pad A / B leave a text field of the screen instead of acting on it)
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
src/settings.ts         Settings { controls, camera, bindings, audio }: defaults, ranges,
                        validation, localStorage load / save. One live object shared by Input,
                        ChaseCamera and the Hud; Game.applySettings() persists and re-applies
src/game/
  Match.ts              match rules state machine (kickoff countdown, goal reset, clock, overtime)
  Game.ts               fixed-step loop: input → controls → bot teams → sim.step → sync →
                        render(alpha); the roster (game modes, setMode / addRoster), per-car views
                        / controls / effects registration, scoreboard rows, prefs (difficulty,
                        quality tier, mode, theme),
                        pipeline warm-up, goal-pause ball pin, audio / HUD glue, settings glue,
                        pointer lock (canvas click captures, menu / pause / whistle / blur release,
                        a browser-side release pauses like the Esc menu, a click on the paused
                        game resumes and recaptures), pause menu (pauseEntries; SETTINGS opens the
                        settings screen over the paused game, BACK returns; QUIT / Backspace /
                        pad B: quitToMenu clears the match and reopens the menu at kickoff), the
                        loading screen for long loads (withLoading: switchQuality, switchTheme,
                        steps with a painted frame between them, the loop held meanwhile), the
                        ball's shadow off in day stadiums (applyBallShadow);
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
  trainingRecords.ts    best run per pack: validation and merge rules (shared with server/), storage
  trainingStore.ts      guest records in this browser, an account's synced with /api/me/training (local
                        copy, guest records move into the first account)
  physicsRules.ts       experimental physics, the only table: integer values (grid, groups, free-
                        play only keys), strict / lenient parsers, built-in presets, stored presets,
                        the rules snapshot, automatic names (shared with server/; the physics core
                        maps the integers to the wasm and the bots, src/sim/mutators.ts)
  experimentalStore.ts  an account's Settings > Experimental switch and presets: a local copy per
                        account (read at boot: unlockedAtBoot), debounced pushes to /api/me/presets,
                        offline edits kept dirty, a preset the full account refused waits for room
                        (said once), deletes need the server; nothing for a guest
  experimentalTraining.ts experimental free play, pure: rules for free play only (packs always stock,
                        a locked player stock), the arena plan (mutators, fingerprint, game speed),
                        createArena before the car, the rebuild when the physics differ (a pack
                        after it is stock), the game-speed accumulator
  (Game.ts: startTraining / stopTraining run a one-car arena through trainingTick instead of tick;
  startTraining(FREEPLAY_ID, { rules }) is experimental free play: the preset's physics, its game
  speed, the TrainingHud's rules line, the pause menu's RULES applied when the settings close, no
  records)
src/ui/                 the front-end menus, styled by menu.css (mn-)
  LoadingOverlay.ts     the loading screen (#overlay, also in index.html for the first paint):
                        wordmark, a progress bar eased by CSS transitions (it moves while the main
                        thread is busy), one short line; swallows keys while up; boot and Game
  Menu.ts               controller: top bar (breadcrumb, region / players online, account chip),
                        screen stack, bottom bar (key hints + the matchmaking banner with timer and
                        cancel), toasts, modals, shared prefs (region, playlists, connection),
                        population polling; MenuHost = what the Game provides (search, friendly,
                        training (with experimental rules), the experimental view (unlocked,
                        presets), lobby matches, settings screen)
  nav.ts                spatial focus navigation (arrows / D-pad pick the nearest target in that
                        direction; Enter / A activate natively; side controls claim left / right)
  dom.ts, badges.ts     h() builder, nav buttons, CSS-drawn rank badges and rating cards
  screens/              home, play hub, casual, competitive, friendly (play.ts), custom lobby
                        browser / create / lobby (custom.ts), training (with Experimental free
                        play, its rules picker and Edit presets for unlocked players), profile (sign in / up /
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
                        HttpOnly cookie, /api/me, training records, leaderboard, ranked result polling,
                        the experimental switch and presets; a listener list (subscribe) and the
                        { name, id } hint the boot reads (readAccountHint)
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
                        refresh tokens, ratings, ranked results / abandons / bans / locks, training
                        records, the experimental switch and presets, login throttle, daily prune
  src/accountRoutes.ts  /api/auth/* (register, login, refresh cookie, logout, recover, password,
                        recovery codes, Google / Discord OAuth with PKCE), /api/me, /api/me/training,
                        /api/me/experimental, /api/me/presets (account only, 10 presets, 30 writes a
                        minute), leaderboard, ranked result; server-side PBKDF2 of the client key
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
src/main.ts             boot behind the loading screen: wasm load ‖ renderer init + the world's
                        first bake, build arena, settings, Game, warm-up render, start, fade into
                        the menu
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
                        applied inputs between snapshots), stock-trace (the golden stock trace:
                        hashes recorded with the wasm from before the mutators), mutators (the
                        mapping, the hand-over), physics-rules (the table, its parsers, every grid
                        value inside the hard limits), mutators-wasm (every field's effect,
                        refusals, the predictor, determinism, top speed), mutators-extremes (60 s
                        3v3 bots at the corners), experimental-training (free play only, packs
                        stock, createArena before the car, the rebuild, no records, game speed;
                        real arenas with the extreme built-ins), hud-menu (the preset editor over
                        the real store with a fake row kit), experimental-store (incl. a preset
                        the full account refused), menu-accounts (a 401 write sent again once)
scripts/                headless node runs: smoke-sim.mjs (one Bot vs an idle car),
                        smoke-match.mjs (BotTeam vs BotTeam in any mode: touches, goals incl.
                        own goals by last-toucher attribution, bumps, stuck time, throughput;
                        fails on a > 10 s dead ball or an own-goal streak), stock-trace.mjs (the
                        golden stock trace runs; --write re-records them for a deliberate change)
```

### Bloom / glow contract (src/render/materials.ts)

On the tiers with bloom (high, ultra) the scene pass renders two targets, `output` and
`emissive`; bloom reads only `emissive` (threshold 0). Lit node materials write their
`emissiveNode` there automatically. On low there is no bloom and no glow target (it renders
straight to the canvas): `glowMrt` / `noGlowMrt` return null there (`setGlowTargets`, set by the
Renderer before a tier's views are built; the world's dome, beam and live layer, which live across
tier switches, are re-tagged through `keepGlowTag`), so glow comes from geometry and colour. Unlit
materials write nothing unless they set `material.mrtNode = glowMrt(<vec3 node>)`; untagged ones
would *overwrite* the target (NoBlending), so every transparent / additive material (flames,
particles, ribbons, rings, glass, blobs, markers) is tagged — with `noGlowMrt()` when it must not
glow. The MRT write has alpha 1, so fading materials fold `diffuseColor.a` into the glow term; the
glow is read back from `diffuseColor` so view-dependent terms are evaluated once (re-evaluating
them inside the output struct produced NaNs).

**Additive materials on low.** The direct tier runs the theme's look (exposure, grade, tone curve,
sRGB) at the end of every material and blends after it, in display space. An additive material's
black must stay black there: the look's lift is left out of additive materials (post/pipeline.ts
`finish`, decided per material at build time), and an additive quad or cone must fade to zero
before its border in a round shape (the low tier's floodlight halo, stadium/floodlights.ts), or
the sRGB curve turns its faint tail into a visible square.

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

**Shadow pipelines.** three's shadow pass copies `material.colorNode` into every shadow pipeline,
so lit casters with a big procedural albedo (the cars, the ball) set it through
`OpaqueAlbedoPhysicalMaterial.albedoNode` (materials.ts) and their shadow pipelines stay depth-only.
`materials.ts` also has `valueNoise3` / `cellHash3`: a MaterialX gradient-noise call site cost
about 0.15 s of cold compile, `valueNoise3` about 0.03 s.

### Pipeline warm-up

`Game.warmUp()` renders one frame through the real pipeline with every normally hidden mesh made
renderable at zero intensity (`setWarmUp(on)` on CarView / BallView / Effects / ArenaView: the
ultra grass blades draw whatever the camera height) before the loading screen goes away (boot, tier
switch), so no shader compiles on the first boost, airborne ball, goal or
demolition (checked: the pipeline counts stay constant through all four on every tier, and after
every tier switch). At boot `Game.warmUpAsync()` runs it after `Renderer.precompile()`, which
compiles the pipelines in parallel. On WebGPU it renders one warm-up frame with three's
synchronous pipeline creation switched to `createRenderPipelineAsync`: every pipeline of the frame
(the exact variants: scene pass, shadow maps, ultra passes, bloom, output) is requested at once
and the browser's GPU process compiles them on its worker threads, while draws whose pipeline is
not ready are skipped behind the overlay (first frame on the GPU 1.8-2.9 s after the page started
instead of 5.5-6.1 s, high tier, production build, warm world cache; three r186's own
`compileAsync` awaits each object's pipelines in turn, 10 s there). On the WebGL2 fallback it is a
`compileAsync` of the scene through the scene pass's own render target and MRT (the direct low
tier: with the DirectRenderPipeline's output context, so the programs carry the in-material look),
so KHR_parallel_shader_compile builds the programs in parallel (5.7 s → 1.8 s on low here). three
r186 builds each object's shaders after compileAsync's first await, so that state (the output
context, the scene pass's target and MRT) is held until the compile settles (`PostChain.compileAsync`
returns `{ promise, settle }`; past Renderer.precompile's timeout the direct path keeps it, the post
path restores it): restoring it at once, as before, built a second set of programs for the default
context that nothing drew with (68 linked programs instead of 36 on low under `#tv`). A tier
switch from the settings screen (`Game.switchQuality`) compiles the same way behind the loading
screen; `setQuality` (console, capture tools) still compiles on the next frame. The ball casts its
shadow during these warm-ups even in a day stadium, so its shadow pipeline is ready for the night
ones (the stadium only flips the mesh's `castShadow`). A theme switch never compiles
(uniforms, a cached cube or a re-bake); the world compiles a new bake's pipelines with its own
`compileAsync` (world/bake.ts).

Load timing: `main.ts` leaves `performance.mark`s at each boot step (`turbogol:renderer`,
`:physics`, `:scene`, `:warmup`, and `:gpu-ready` once the GPU finished the warm-up frame on
WebGPU).

### Render modules (docs/visuals/REWORK.md)

Every module reads its switches from `tier(q)` and its look from the theme (uniform writes only:
a theme switch never rebuilds a view or recompiles). Costs: GPU ms at 1600x900 CSS on the
reference Turing GPU, chase camera at kickoff, the module's own share (on / off A/B).

* **world/** — the sky (gradient, horizon glow, moon or sun, stars, two cloud layers) and the far
  backdrop of the theme's skyline (harbour, canyon or alpine generator) baked into
  a cube map (2x2 supersampled, a 32² depth cube for the parallax proxy) plus a PMREM probe (the
  cube, the live layer, the lit pitch and the theme's floodlight heads as hot panels); drawn by the
  parallax dome. A live near layer is drawn each frame: one merged mesh per skyline, built on first
  use and kept (`LIVE_BUILDERS` in World.ts): the harbour's quay, container yards, cranes, ship and
  lighthouse (~35k triangles) and the alpine valley floor, walls and ~1650 pines (~96k; on the
  tiers with geometry detail 'low' a lighter variant of the same trees, ~52k: alpine.ts
  `LiveDetail`, the layers keyed by skyline and detail). Every layer has the same vertex layout and
  the same material, so a theme or tier switch swaps the mesh's geometry without a new pipeline;
  the canyon (no live layer) collapses it with a uniform, on the smallest layer built so far. The additive lighthouse beam shows on the harbour only (a uniform). The structure
  material picks a pattern per vertex `kind` (geo.ts KIND: 0-9 the harbour and canyon, 12-14 the
  alpine FOLIAGE / MEADOW / ALPINE, an exact range in bakeMaterials.ts; the city's and the rail
  yard's kinds went with those themes on 2026-10-21). Fog: one
  `scene.fogNode`, exponential, from the theme. Draws: 3 on high / ultra (live layer, dome, beam),
  2 on low, 1 on super low (liteWorld.ts: the gradient dome, nothing baked, no fog). Cost ~0.07 ms (high), the same for every theme. Tiers: cube 512 / PMREM 128 / 1-lookup
  dome on low, 1024 / 256 / 2-lookup + beam on high and ultra. Load: a cached boot 50-130 ms, a
  first bake ~0.9-1.3 s (~1.8 s with the browser's shader cache cold: the bake pipelines compile
  with `compileAsync` while the CPU builds the far geometry; the alpine range is built in slices
  so the compile keeps going, the canyon's ~0.3 s terrain still blocks it), a re-bake with
  compiled pipelines 40-470 ms, a cached theme switch 55-120 ms. The bakes are cached in IndexedDB
  (`turbogol-world`, store `bakes`, at most 6 records, the least recently read or written evicted
  first through the `used` store; keyed by theme, sizes, backend, a hash of the theme data and
  WORLD_CACHE_VERSION, which a generator or bake-material change must bump); `#worldnocache`
  ignores cached bakes (still writes them). Every baked skyline stays under its parallax hand-over
  band: dome.ts PROXY_TOP by default (harbour.ts SKYLINE_TOP under it); the alpine preset's
  `proxyTop` raises it above its mountains.
* **turf/** — the pitch: one MeshStandard graph per tier (an unlit one on low, see below) from
  load-time bakes (a tileable 512²
  blade field, a 192x288 field map of wear / damp / puddle basins / hue, a 176x264 pool map of the
  floodlights' irradiance + the pad mask; ~0.28 s at boot, the pool map cached per floodlight rig).
  View-dependent mowing stripes, paint in the grass, damp sheen, soft puddles (relief tiers), the
  pools and analytic anisotropic GGX floodlight streaks (stretched toward the camera at grazing
  views, compact glints seen from above at a distance, `turfStreaks` heads). Its lighting model
  (`TurfLightingModel`) lets the pool map shape the key lights at night (so the pools sit under
  the keys' shadows) and keeps only 12 % of the keys' direct specular there (their reflections
  are the streaks); its environment radiance is capped at night
  (`CappedEnvironmentNode`: the probe's hot lamp panels read as fog on the damp sheen). Draws: 1
  (+1 blades on ultra). Cost: ~0.5 ms high, blades ~0.13 ms. Tiers: low (`bakedLight`) the unlit
  baked turf (`buildBakedTurfMaterial`: the theme's lit grass colour `TurfLook.baked`, a narrow
  grain from the blade field, stripes, team tint, markings, goal floors and glow, the pools at a
  low contrast around a mean of 1; no field map, sheen, puddles or streaks: about a tenth of the
  lit floor's cost, which was ~30 % of the old low frame at a fill-bound size), high relief (6-step POM within
  600 uu, blade self-shadow) + puddles + 4 streaks (the corner towers), ultra + ~77k instanced grass
  blades in a patch ahead of the camera (skipped above
  380 uu; `setWarmUp` forces them). The goal-mouth glow is the floor's only glow-MRT term.
* **stadium/** — 7 draws (netting, boards, steel, lamp panels, glare, stand structure, crowd), +1
  beams on ultra, 6 on low (no netting: `TierSpec.netting`, the steel draws the cage), 4 on super low
  (no glare, no crowd mesh: the people painted on the rows, stands.ts paintedCrowd); ~89k
  triangles on high and ultra, 52k on low; ~0.4 ms high, ~0.6 ms ultra. On low (`bakedLight`) the
  stands, steel and boards are unlit, their colours x the theme's light baked in (palette.ts
  `stadiumLight`: both keys' n . l and the hemisphere fill from the theme's low lights), and the
  crowd takes a bright, flat palette under the theme's low crowd light (`StadiumTheme.low`). Hex wire netting on the shell above the board band (y 360) and the
  roof (box-filtered wires fading into their average coverage, a 400 uu cable grid; low: average
  coverage only), the goal-module panels included (the goals show their net and the harbour
  behind). LED boards from one canvas atlas under y ~340 (ledIntensity 0.4, a satin face): 36
  panels round the outline, a card each, changing every 30 s panel by panel with a short dip; in
  the middle of each side wall a board three panels wide alternates the place's main and secondary
  sponsor every 30 s, half a period out of step (same material, texture and draw), steel cage + 8
  floodlight towers in one lit mesh, hot lamp panels (HDR core 30, half of it into the bloom) with
  a tight exponential glare (a wider sprite halo only on low, where there is no bloom), stands
  along the side walls only (the ends stay open for the backdrop) with ~11.8k SDF people (team-
  dominant, desaturated kits). Nothing casts shadows; nothing runs on the CPU per frame.
  Per theme (palette.ts, uniforms only): crowd and canopy light, net ambient, steel rim, LED and
  lamp levels, and `standWood` (timber stands on the alpine valley). The board atlas shows the
  place's own content (content.ts: invented local sponsors and canvas-path emblems; the two
  harbour themes share the harbour's anchors, lighthouse, waves and PUERTO SUR, which no other
  place shows): a switch to another place repaints the canvas into the same texture (~1-2 ms, one
  re-upload, no recompile). The hanging banners went on 2026-10-21 (the owner's request).
* **post/** — pipeline.ts: the render path of the tier (`TierSpec.output`). High and ultra:
  the HDR RenderPipeline. Low: three's DirectRenderPipeline draws the scene straight into the
  canvas (no HalfFloat target, no MRT, no composite, no FXAA): the theme's exposure, grade, tone
  curve (`lookOf`: the theme's `low` overrides apply there; the contrast and vignette stages only
  when some theme uses them there, none does) and sRGB at the end of every material's fragment
  shader, output targets only; the canvas multisamples x4 (WebGPU: the
  renderer's samples, set per tier; WebGL2: the context, created multisampled). Blending happens
  after the tone curve there. The device's capabilities (capabilities.ts) take MSAA off the post
  tiers where a multisampled rgba16float target cannot exist (WebGPU compatibility mode: FXAA).
  lighting.ts: both keys and the fill exist on every tier and theme (constant light
  count), at the theme's low intensities on the direct path (theme.ts `lightsOf`);
  `shadowedKeys` keys cast (none on low: the cars and the ball keep their ground blobs;
  2 on high and ultra), maps 2048 (PCF 3) on high, 4096 (PCF 4) on ultra, frustums fitted to the
  arena box. pipeline.ts: see "Rendering
  budget". screenSpace.ts (ultra, together ~+1 ms): half-resolution GTAO from a half-resolution
  single-sample depth copy (quadPass.ts), half-resolution SSR on wet pitch pixels only (mask from
  depth x wetness), and a quarter-resolution lens glare (short streak + three faint ghosts) of the
  white-hot emissive only (keyed on the darkest channel, so team-coloured frames never streak).
  Setting a light's `castShadow` outside a tier switch crashes three r186 (a tier switch rebuilds
  every lit material right after); a mesh's only adds it to the shadow pass or takes it out.
* **Car.ts / Ball.ts** — see the module list; no extra draws; ~+0.05 ms over the old materials.
  On tiers with `grassBlades` the ball's blob and marker and the car blobs float at y 6, above
  the blades.

## Frame loop (src/game/Game.ts)

```
requestAnimationFrame(t):
  if !drawsFrame(t, lastDrawn, tier.maxFps): return   // super low: 30 fps, the time carries over
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
  localStorage with difficulty, the quality tier (saved by name; saves from before the third tier
  hold 0 = high / 1 = low) and the theme.
* **Quality tiers** (`src/render/quality.ts`): superlow / low / high / ultra, one table of
  switches that every view reads through `tier(q)` (render path, MSAA, bloom, pixel ratio and
  budget, dynamic resolution, shadow map, geometry detail, particles, super low's world, materials,
  frame cap and CPU trims...); the Renderer runs them adjusted to the device (capabilities.ts).
  Phones and tablets start on low, desktops on high; WebGL2, WebGPU compatibility mode and <= 4 GB
  devices on low unless the player chose a tier; a TV on a slow GPU or a 1 GB device on super low
  (bootTier.ts, before the renderer: super low runs WebGL2). Settings > Graphics (from the menus or
  the pause menu) picks the tier; super low is a pick only for a signed-in player with Settings >
  Experimental's switch on (guests see Performance / High / Ultra; a device that runs super low on
  its own keeps it, no chip lit; a locked player's saved pick reads as Performance at the next
  start: main.ts gateTierPrefs, and Game.checkTierLock on sign-out / switch off, without a reload); `switchQuality` rebuilds every view and the render path
  (~30 ms), waits for the world's bake at the new sizes and compiles the new pipelines in
  parallel, all behind the loading screen; into or out of super low it saves the prefs and
  reloads the page (`restartOn`: its own backend and world), except in an online match, where the
  reload would leave it: the pick waits for the menus (`pendingRestart`, its line on the Graphics
  tab). The prefs keep the player's pick
  only (`persistPrefs` writes `savedQuality`): a tier the session runs on its own (the URL, auto,
  a ceiling, a fallback) is never saved. Super low's CPU trims (`cpuLite`): `html.tg-superlow`
  (no blur, shadows or decorative animation in the HUD), boost and speed at 10 Hz, no audio room,
  the ball prediction every 8 ticks, a notice when going online.
* **Tier safety net** (`src/render/tierGuard.ts`, `Game.onGpuFailure`, from `Game.bootDone()` on):
  a GPU validation error, a failed pipeline or WebGL program within 20 s of the boot or a tier
  switch, or a lost device, makes the tier fall back one step behind the loading screen (its line
  and a menu toast: "Your device does not support Ultra: using High"); the GPU's ceiling is kept in
  localStorage and caps the starting tier until the player picks a higher tier and it runs the 20 s
  window clean (`raiseCeiling`); a lost device reloads the page onto the lower tier (low falls to
  super low; a ceiling at super low starts the next boots on super low's own backend, WebGL2
  without MSAA, `readSuperlowBoot`). A device lost while the page was hidden or in its first 10 s back (the system
  reclaimed the GPU), or lost on super low, reloads the page on the same tier without touching the
  ceiling. Every reload after a loss goes through the tab's counter (`lossStep`, sessionStorage):
  the second loss reloads on super low for the tab, the third shows a message and stops. Only
  downward, never in a loop.
* **Frozen** (countdown, goal pause, after the whistle, menu): every roster car gets zero controls.
* **HUD**: the menu has a Mode row (← → on the row, `M`, pad left / right; ↑ ↓ / D-pad move the
  focus across Difficulty / Mode / Quality, `Q` steps to the next quality tier) and shows
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

* Arena: turf 1 (+1 grass blades on ultra), stadium 7 (+1 beams on ultra, 6 on low), world 3 (2 on low),
  goals 1, goal frames 2, pads 2; all procedural TSL (textures are baked or drawn by code at load).
* Cars: body (1 merged geometry) + 4 wheels (1 instanced) + flame (while boosting) + blob (while
  airborne at high detail, always at low) per car. Ball: sphere + blob + marker (airborne).
  Effects: particles (1 instanced), ribbons (1), rings (1 instanced), goal flash (1).
* Shadow pass: only cars and the ball cast, once per shadowed key (none on low, 2 on high and
  ultra); the floor and the grass blades receive.
* Post (`post/pipeline.ts`, switches from the tier table): high / ultra = MSAA x4 scene pass (MRT
  output + emissive) + 5-mip bloom from the emissive target (12 small passes) + vignette, exposure,
  HDR grade and the theme's tone curve, dynamic resolution between 0.6 and 1; ultra adds GTAO, SSR
  and the lens glare at half / quarter resolution (FXAA instead of MSAA in WebGPU compatibility
  mode); low = straight into the canvas with its MSAA x4 (none in WebGPU compatibility mode, where
  it is a blit resolve; no HDR target, no bloom, no post pass; the look runs in every material),
  dynamic resolution of the pixel ratio between 0.6 and 1.
  Pixel ratio: high / ultra min(dpr, 6 Mpx budget) and never below 1 (phones at most 2), low
  min(dpr, 1.5, 1 Mpx budget) and never below 1 for the budget (phones 1.5, desktops 1); every
  tier within the device's max texture size.
* Measured (2026-10-21 after the owner's feedback: no shadow maps on low, no banners, the big
  side boards, a calmer night pitch with fewer streak heads; browser pane on a Turing desktop GPU
  shared with other sessions, WebGPU), free play at kickoff, chase camera, 1600x900 CSS, the median
  of three 120-frame means, on the night harbour (every theme is within ~0.1 ms of it; the alpine
  valley has the most triangles):

  | tier | GPU | draws | triangles | buffer | texture memory |
  |---|---|---|---|---|---|
  | low | 0.82 ms | 24 | 85k (alpine 145k) | 1600x901 | 37 MB |
  | high | 1.83 ms | 41 | 130k (alpine 191k) | 2190x1233 | 160 MB |
  | ultra | 3.04 ms (alpine 3.03) | 52 | 366k (alpine 426k) | 2190x1233 | 374 MB |

  The final review before it measured low 0.82 ms / 28 draws / 77 MB, high 1.97 ms / 42 / 175 MB,
  ultra 3.15 ms / 53 / 399 MB.

  Since the direct low tier (docs/visuals/REWORK.md, "Three devices"): low 22 draws and 9.3 MB of
  textures plus the canvas' MSAA x4 colour and depth buffers (~46 MB at 1600x900, three allocates
  them outside its texture count), the GPU time the same as the FXAA path within the shared GPU's
  noise (0.96 / 0.93 ms in an A/B); high 1.81 ms / 41, ultra 3.03 ms / 52 (unchanged).

  Since the Performance look (docs/visuals/REWORK.md, "The Performance look": the baked-light
  turf, stands, steel and boards, no netting, the alpine valley's lighter live layer): low 0.41 ms
  (night harbour), 0.32 (canyon), 0.36 (alpine) at 1600x900 instead of 0.88 / 0.83 / 0.84, 21
  draws, 83k triangles (alpine 100k instead of 145k), 11 textures / 9.5 MB; at a fill-bound
  3200x1802 1.03 ms instead of 2.49; the phone layout (780x360 CSS at dpr 3, 1170x540) 0.22-0.28
  ms instead of 0.43-0.86. A 3v3 match frame on low: 34-41 draws (flames and the ball marker come
  and go), 0.63 ms at 1600x900.

  A 3v3 match frame at kickoff (final review): low 0.85 ms / 51 draws, high 2.01 ms / 72 draws,
  ultra 3.26 ms / 81 draws (each extra car costs 2 draws plus 2 per shadowed key; over the 40 / 60
  draw targets of docs/visuals/REWORK.md, see its status). Since then, by the count: low 37 draws
  (no shadow pass: 13 fewer; no banners: 1), high 71, ultra 80. Texture memory and pipelines are flat over repeated
  theme switches (baking or cached) and tier round trips. Triangles include the shadow passes.
* First load (production build, WebGPU), to the first frame finished on the GPU: high 1.8 s with
  a warm world cache (median of 3; 0.3 s renderer and cached world, 0.3 s views and bakes, ~1.1 s
  of parallel pipeline compile, `Renderer.precompile`), 3.0-4.0 s with an empty cache (the world
  bake ~1 s); low 1.6 s warm, 2.7 s cold. WebGL2 low: 2.0-6.2 s to the warm-up (run to run
  variance of the parallel compile on a shared GPU). Before the parallel compile the high tier
  took 5.5-6.1 s (~50 pipelines compiled one after the other).

## Legal

Turbogol is AGPL-3.0-or-later (`LICENSE`). RocketSim (MIT, ZealanL) is a git submodule; its
license and those of Bullet (zlib), three.js (MIT) and the Emscripten runtime libraries are in
`THIRD_PARTY_NOTICES.md` and ship with every build. Every model, texture, layout and sound of the
game is generated by this repository's code; no third-party game content is used.

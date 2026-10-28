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
                        super low); drawsFrame (the tier's frame cap, in whole refreshes); the
                        scene's pace ("UI at rest": SceneCover, frameCap with the player's FpsCap,
                        sceneFps, FramePacer (a rate's average on any display), runsLogic,
                        drawsScene); lowerQuality; CARD_QUALITIES (Graphics' cards: super low is
                        the switch under them, everyone's) and nextQuality over such a list; the
                        player's resolution scale (parseResolutionScale, 50-125 %, and
                        scaledPixelRatio: never past the device's largest render target)
  bootTier.ts           the boot tier before the renderer exists (the URL's #superlow, the tab's
                        recovery, a GPU of the device that fell to super low (a ceiling known
                        before the backend), the player's choice, super low on a TV with a slow GPU or on
                        1 GB: autoSuperlow, probeGpu, readBootSignals), the TierReason #diag shows,
                        tierPrefsAfter (the prefs keep the player's pick only)
  experimentalPage.ts   Ajustes › EXPERIMENTAL (its host's PageKit: src/ui/screens/settings/expKit.ts): a guest's locked line, the switch, what it
                        unlocks and the preset editor (picker over the built-ins and the player's
                        presets, New / Duplicate / Rename / Delete, the name field, one stepper or
                        cycler per value on its grid with the standard value, the summary line,
                        Reset to standard); contexts menu / training (experimental free play's
                        live pick) / match (the room's rules, read-only); built once through the
                        Hud's PageKit, lines shown / hidden, edits saved at once
  rulesText.ts          the texts of physics rules, shared by every menu (the editor, training,
                        the TrainingHud, the custom lobby screens): preset names (built-ins from the
                        locale), values (km/h, %, s, on / off, demolitions), standard values, the
                        summary, a lobby's (or room's) rules line
  hashFlags.ts          the URL hash flags as whole words with optional values (parseHashFlags,
                        pageFlags: diag / audit, stats, debug, net, nancheck, worldnocache,
                        webgl2, webgpu, superlow, tv, lowgpu, compat, nof32filter, nofloatrt,
                        nomsaa, msaa, nopost, norender, pr, hide, widetext: the UI in plain Arial,
                        html.tg-widetext set by main.ts, a fit test for the fallback fonts)
  frameStats.ts         `#diag`'s drawn frame rate (1 s min / mean, 5 s mean), the animation frames
                        the loop ran, the stalls (frames over 50 / 100 ms: between drawn frames in
                        a match, between animation frames while the scene is paced or held) and CPU
                        per drawn frame (ball prediction, bots, physics step, render), fed by the
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
  Hud.ts                DOM HUD (Tablero plan PR 7): the scorebug (TAG n │ clock │ n TAG, the
                        notch under your team: setTeam, the network bars by the clock: netBars,
                        over the pause's veil: --z-score), the boost plate, the ball indicator
                        (kept off the HUD's plates: avoidRects, measured on a resize and as the
                        controls card comes or goes), debug line (F3), the countdown with the
                        overtime line over it (showOvertime), the centre for the goal (showGoal:
                        the scoring team's slab and the scorer's chip) and the whistle only, the
                        feed (feed: two chips at most at the top), Tab scoreboard, pointer-lock
                        hint, the pause dock (PauseEntry list from the Game: RESUME, training
                        entries on one data-nav-row, RULES in experimental free play, SETTINGS,
                        QUIT held HOLD_MS with A / Enter / a finger or double-clicked: hold,
                        sub; src/ui/nav.ts FocusNav driven by Input's menu edges through
                        pauseAction; online "MATCH IN PROGRESS"; setPauseCovered: Ajustes over it,
                        src/ui/screens/settings/overlay.ts), the controls card (setControlsCard: big
                        card or slim strip, bottom right); its own keys are F3 and F4
  controlsCard.ts       the controls card of the first matches and free play, pure: when it shows
                        (ControlsCardPlan: the first 3 matches' kickoff countdown, free play until
                        the car moves, then a strip for 60 s of play; the count in localStorage)
                        and its rows from the live bindings of the device (controlsCardRows)
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
                        DEFAULT_PAD, KEYBOARD_ONLY_KBM), the arrows as fixed second driving keys
                        (KBM_SECONDARY), labels, ACTION_ROWS, CameraLook
  Input.ts              keyboard + mouse + gamepad → CarControls, camera look (+ lookSource), held
                        states and one-shot / menu edges (the pad's LB / RB, LT / RT past 0.5 with
                        a 0.3 re-arm, Y and Start for the menus only; a held D-pad / stick
                        direction repeats after 400 ms, then every 80 ms, on an injectable clock:
                        menuRepeat; resetMenuRepeat at a hand-off: a held direction needs a new
                        press), driven by Settings.bindings; pointer lock
                        (the capturing click is masked), one pad poll per frame (beginFrame),
                        latchEdges for menu hand-off, rebind capture (startRebind: armed on the
                        next macrotask, Esc cancels on both devices, a pad's B binds on its release
                        and held CAPTURE_CANCEL_HOLD_MS cancels, wheel only over the cell),
                        presets, vibration; an optional TouchSource (setTouchSource: read once per
                        sample, clamped to 0..1, summed into the keyboard column, so touch drives
                        the same modifiers and edges, never padActions or the camera look)
  touchState.ts         on-screen touch state, pure (no DOM, no CSS, node tests import it):
                        TouchState = Input's TouchSource (stick + per-button finger count and tap
                        latch, releaseAll), stickVector (radial deadzone + gain, up = +y),
                        hitCircle, the TB buttons → actions mapping (copied from DEFAULT_KBM)
  touchRouter.ts        TouchRouter, pure: which finger drives the stick, holds JUMP / BOOST /
                        DRIFT (a slide off BOOST keeps it held; off JUMP too with holdJump, the
                        controls.touchHoldJump preference: plan M29), taps PAUSE / CAM / RESET,
                        and taps the scorebug or the open board (scoreTaps); a fixed stick
                        (fixedStick: centred on layout.stickHome) and the player's deadzone
  TouchControls.ts      the touch overlay (.tc-root, touch.css; created only with a touch screen):
                        measures the layout from its CSS, routes every finger through TouchRouter,
                        applies settings.touch (applySettings: --tc-k size, --tc-alpha opacity,
                        tc-lefty mirrors the logical insets and the router's side
                        (mirrored: the buttons' half), the router's stick and deadzone, a
                        press's pulse where navigator.vibrate exists),
                        paint() and setBoost() (BOOST's amount and level at 10 Hz) allocate
                        nothing; the scoreboard tap (scoreboardOpen), the three first-match cards
                        (cardsUp, turbogol.touchCards), the rotate notice (setLive: translucent
                        over a live online match, the scorebug above it), touch mode (tg-touch)
src/settings.ts         Settings { controls, camera, bindings, audio, touch, ui }: defaults, ranges,
                        validation, localStorage load / save. One live object shared by Input,
                        ChaseCamera and Ajustes; Game.applySettings() persists and re-applies
src/game/
  Match.ts              match rules state machine (kickoff countdown, goal reset, clock, overtime)
  Game.ts               fixed-step loop: input → controls → bot teams → sim.step → sync →
                        render(alpha); the roster (game modes, setMode / addRoster), per-car views
                        / controls / effects registration, scoreboard rows, prefs (difficulty,
                        quality tier, mode, theme),
                        pipeline warm-up, goal-pause ball pin, audio / HUD glue, settings glue,
                        pointer lock (canvas click captures, menu / pause / whistle / blur release,
                        a browser-side release pauses like the Esc menu, a click on the paused
                        game resumes and recaptures; a finger's tap there does nothing: the touch
                        pause, laid out for two thumbs by style.css, resumes on RESUME where BOOST
                        was), pause menu (pauseEntries; SETTINGS and pad X open Ajustes over the
                        paused game, z 60: SettingsOverlay, online the match goes on and its
                        scorebug is raised into the overlay's bar; its Back returns; Backspace / pad B
                        resume; QUIT only, held (Input.acceptHeld): quitToMenu clears the match and
                        reopens the menu at kickoff), the match's end (matchEnded on every path:
                        the FINAL's view, goals credited by creditGoal, the FINAL FINAL_SECONDS
                        later through showMenu, never while a session is busy or in a match; a
                        ranked result into the FINAL's rank card; a lobby's match tells the lobby
                        at once, lobby.back, as the FINAL's MENU goes to Inicio), matchFound (PARTIDO
                        ENCONTRADO as a session leaves 'queue'; plan PR 6 calls it too), a
                        Competitive no-show or dodge searched again at once (requeue), system Back (onSystemBack, src/ui/backGuard.ts), the
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
                        ranked (lastRankedMatchId for the FINAL's rank card), 'cancelled' event
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
                        the rules snapshot and parseLobbyRules (what a lobby, the matchmaker, a room
                        and a welcome keep: strict, a snapshot that changes nothing is standard),
                        automatic names (shared with server/; the physics core maps the integers to
                        the wasm and the bots, src/sim/mutators.ts)
  experimentalStore.ts  an account's Settings > Experimental switch and presets: a local copy per
                        account, debounced pushes to /api/me/presets,
                        offline edits kept dirty, a preset the full account refused waits for room
                        (said once), deletes need the server; nothing for a guest
  experimentalTraining.ts experimental free play, pure: rules for free play only (packs always stock,
                        a locked player stock), the arena plan (mutators, fingerprint, game speed),
                        createArena before the car, the rebuild when the physics differ (a pack
                        after it is stock), the game-speed accumulator
  (Game.ts: startTraining / stopTraining run a one-car arena through trainingTick instead of tick;
  startTraining(FREEPLAY_ID, { rules }) is experimental free play: the preset's physics, its game
  speed, the TrainingHud's rules line, the pause menu's RULES applied when the settings close, no
  records; startSearchPractice is free play over a menu search that keeps queueing (MODOS' "While
  you wait: Free play"): the frame's watchSearchPractice sees the session leave its queue and
  hands off through one function, practiceToMatch (training off, "MATCH FOUND · Entering…",
  today's found -> match path; setSession and the session rosters call it too), a failed connect
  shows the menus, and quitting practice keeps the search: stopTraining -> showMenu(true))
src/ui/                 the front-end menus: the Tablero shell (styles/shell.css, components.css)
                        around the screens (Inicio on styles/tiles.css and screens/home.css, MODOS
                        on screens/modes.css; the others on menu.css until their own PRs), all
                        mn-, on the tokens
  styles/tokens.css     every colour, type role and scale, space, radius, shadow, layer, motion
                        and focus value (the Tablero plan §1.2), the display font's @font-face and
                        its calibrated fallbacks; the old names (--panel, --muted, --mn-*) are
                        aliases until the PR that rewrites their last user. "UI tokens" below
  styles/focus.css      the one focus ring of every world (menus .mn-focus / :focus-visible, the
                        Hud's .hud-focus, the pack summary's default button)
  styles/shell.css      the shell's grid and bars per html[data-shell] (bar, rail, tabs, tv) in rem
                        (1 rem = 16 px x --ui-scale; body stays 16 px, so the old screens' px do
                        not move); styles/components.css: pills, glyphs, sheets, toasts, the slot;
                        styles/tiles.css: the hero and mode tiles, the plate, the slot's variants
                        (the lift is --focus-lift alone: 0 on super low and with reduced motion);
                        styles/screens/<screen>.css: a Tablero screen's own layout per class
                        (home.css: Inicio, modes.css: MODOS, final.css: the FINAL; on
                        .mn[data-screen], which Menu.mount writes; found.css: PARTIDO ENCONTRADO;
                        settings.css: Ajustes, in the menus and over the pause)
  screens/settings/     Ajustes (plan PR 10, its new rows PR 11): model.ts (pure: the six tabs, CONTROLES' device
                        sections, the camera preset, the quality trial, the memory tag, a binding's
                        conflict, the sliders' maths; tests/settings-model.test.mjs), view.ts
                        (SettingsView, the one component: the rail of tabs and each tab's page,
                        every setting with its saved key; CONTROLES per device detected, the last
                        input's first, sensitivities then mn-bind rows, TÁCTIL's settings.touch;
                        CÁMARA's presets; JUEGO with INTERFAZ: Idioma (components/language.ts's
                        sheet), the interface size, reduced motion; AUDIO; GRÁFICOS as cards,
                        applied with A and back by themselves in 10 s unless kept, then the
                        resolution scale, the frame limit, the animated stadium, the Super low
                        switch (A only) and RESTABLECER GRÁFICOS; EXPERIMENTAL; "Se guarda solo"
                        under the rail), expKit.ts (experimentalPage.ts's PageKit: its
                        PageItems as FocusNav targets), screen.ts (the Menu screen 'settings', a
                        screen of every section: stacked on the one shown, backModel.ts
                        EVERY_SECTION; its rail a side zone of its own, Screen.zones; the scene
                        holds one frame under it, Screen.holdsScene; a binding's capture takes the
                        keys, Screen.keysTaken), overlay.ts (the same view over the pause on a
                        .mn root: its bar, its FocusNav, its keys; the Game routes the pad).
                        Back inside: a capture cancels, then the page's focus goes to its tab
  components/rows.ts    mn-set-row, mn-slider (− track +, the default's mark, ◀ ▶ with the
                        repeat: nav.ts onNavRepeat, a sideways drag), mn-switch (NO │ SÍ; A
                        only for one that restarts the game)
  components/icons.ts   the SVG icon sprite (~40 icons on a 24 grid, one hidden <svg> of
                        <symbol>s mounted by the first icon(); the menu tiles use it)
  components/           sheet.ts (the one dialog: Menu.modal mounts it), toast.ts (max 3, 4-10 s by
                        length, polite / assertive), glyphs.ts (drawn pad / key / remote buttons),
                        tile.ts (the hero: one button whose parts are rebuilt per state, ✕ CANCEL
                        in its grid cell; a mode tile; the slot), plate.ts (who you are · your
                        car), language.ts (the language sheet, PERFIL's IDIOMA row), seg.ts
                        (mn-seg: two to four options in a row, ◀ ▶ walk, A picks), picker.ts
                        (mn-picker: a 56 px row with its value and ›, opening a sheet)
  shell/                sections.ts (the five sections, their roots, stepSection; pure),
                        hints.ts (the hint bar per last input, root or stacked, a screen's own
                        tabs or not; pure), topbar.ts (wordmark,
                        sections with focus = selection, back + crumbs, chip, Settings), rail.ts
                        (the phone's rail and the upright tab bar), hintbar.ts (hints, source link,
                        About), pills.ts (region / connection, search, update)
  backModel.ts          the order of Back, pure: menuBack (sheet, field being edited, the
                        screen's own, pop, another section to JUGAR, JUGAR's root asks to leave),
                        systemBack (load, key capture, Ajustes over the pause, menus, pack summary,
                        match) and stackAfterOpen (where Menu.open leaves the section and its
                        stack; Ajustes, a screen of every section, stacks on the one shown);
                        tests/back-model.test.mjs
  fit.ts                data-fit: a box shrinks its font 1 px at a time to its minimum (or the
                        --fit-min a stylesheet sets: 16 on a TV, in px of its 960 wide reference
                        view: times --ui-scale) while it overflows (its content box: a bar's
                        overscan stays clear), then takes its short labels (data-fit-alt), then
                        lets the parts that give way go, a level at a time (data-fit-give, in the
                        box or in its data-fit-scope: the strip's and the crumbs' whole top bar,
                        the strip's ‹ › / L R / Q E, then its pills' words; a TV hero's subtitle,
                        ✕ CANCEL's label; a box with a scope fits last); a TV hint bar's
                        controller Settings hint, then its pills' words (what their dot or
                        Inicio's hero says first: pills.ts 2, 3), then the cancel hint; a
                        tablet's or a phone's top bar squeezes its pills to their icons the same
                        way, the chip's name keeping its 9 rem; the
                        Menu fits at once on a mount and a change of the hints, the input, the
                        chip or a pill (before that frame is drawn), on the next frame after a
                        resize or the fonts; a box not laid out (the strip under a stacked screen)
                        keeps its last fit; __uiFit() (dev / VITE_UI_FIT=1; it runs a fit queued
                        for the next frame first) reports overflowing bars, cut labels, a sideways
                        scroll, rings a clipping box or the screen's edge would cut (an edge
                        control draws its ring inside: shell.css --ring-offset), shell text under
                        14 px on a phone or 16 on a TV at its reference view (the shell's bars
                        and a Tablero screen, data-tablero), and on Inicio a title on more lines
                        than data-fit-lines, text out of its tile (data-fit-box) or under ✕, the
                        hero's title as fitted (scripts/ui-fit.mjs, CI's ui-fit job); restoreGiven
                        shows a moved part again (a TV's pills off its hint bar)
  LoadingOverlay.ts     the loading screen (#overlay, also in index.html for the first paint):
                        wordmark, a progress bar eased by CSS transitions (it moves while the main
                        thread is busy), one short line; swallows keys while up; boot and Game
  Menu.ts               the shell's controller: five sections (JUGAR · ENTRENAMIENTO · GARAJE ·
                        CLASIFICACIÓN · PERFIL), each a root screen with stacked screens on it
                        (open: a root switches section, at its root, but from a stacked screen of
                        another section it is a detour stacked on it, as Competitive's SIGN IN
                        opening PERFIL, so Back returns there; a section switch always lands on
                        the root; a screen whose leaveGuard asks, the lobby, asks before a
                        section, a crumb, the wordmark, the chip or the search pill take the
                        player off it), the top bar / rail / tabs / hint bar, the pills (region and
                        connection with RETRY, the running search on every section (Ajustes is one
                        of them), "UPDATE TO PLAY"), sheets (modal), toasts, the blocking
                        new-version sheet (z 65) on a 426 reload_required, About, the region sheet,
                        shared prefs (prefs.ts), population polling, the 4 Hz tick (1 Hz on super
                        low, DOM written only on change); MenuHost = what the Game provides (search,
                        friendly, training, the experimental view, lobby matches, settings
                        screen, confirmLeave with what asked: the system Back or a key,
                        setMenuCover: what the menus leave of the scene, reportCover: 'partial'
                        with the share a touch screen's menus hide, measured on every mount,
                        section switch, sheet or Settings closed, resize and layout change and
                        once a second; 'opaque' under a sheet and over super low's opaque page,
                        which Inicio drops: data-screen on the root, readBackdrop). A match's
                        start goes through beforeMatch (a TV without a controller: openNeedPad, a
                        sheet a connecting controller closes after latching its press; a new PC
                        player: openHowPlay, howPlay.ts), a search through startSearch (lastQueue)
                        and its own screen is MODOS on the search's tab (openSearchScreen);
                        a TV's pills sit in the screen's pillSlot (Inicio's plate row).
                        Focus: zones top bar, stage, footer, tabs
                        and the rail as a side zone (left / right cross it; a sheet alone); up from
                        the stage lands on the active section (data-nav-entry), focus = selection
                        on the section tabs (a pointer's focus is not: its click is; LB / RB, Q / E
                        and Esc to JUGAR from the bar keep the focus on the bar); the last focus
                        per screen (FocusMemory by element or
                        data-key; data-autofocus on a first visit only; never a text field without
                        a fine pointer); sheets with aria-modal and the rest inert. Back:
                        backModel.ts (Esc / B / the back button on JUGAR's root ask to leave too).
                        MenuCommand shortcuts (Q / E, LB / RB, LT / RT, X / Y, Start, pad X /
                        Delete) reach Screen.command first (MODOS takes Q / E, LB / RB and LT / RT
                        for its tabs: no section bar on a stacked screen); LB / RB the sections,
                        LT / RT and Q / E a screen's .mn-tabs (stepTabs) else the sections; X / Y
                        cancel the search,
                        over Settings too. A key's own repeat moves the focus only for a key first
                        pressed in the menus. The 450 ms tap guard (touch): a tap that went down
                        before a mount, or within 450 ms after, presses nothing on it; on the bars
                        only after a stacked screen came or went (the rail's and the top bar's
                        items moved). Menu.hide undoes a pinch zoom of the menus (resetPageZoom).
  cover.ts              the scene behind the menus: the share of a touch screen they hide (a 9 x 5
                        grid of elementFromPoint and computed backgrounds; the shell's backdrop
                        left out), whether that backdrop is an opaque page (opaqueBackground) and
                        the cover the menus report (menuCover); tests/cover.test.mjs
  nav.ts                spatial focus navigation (arrows / D-pad pick the nearest target in that
                        direction; Enter / A activate natively; side controls claim left / right,
                        a slider with a held arrow's repeat too: onNavRepeat; a target is its
                        first zone's, so a zone inside another keeps its own: Ajustes' rail);
                        pickTarget unchanged, plus pure zones (zoneEntryIndex), rows (data-nav-row:
                        rowStep, left vertically from unionBox), a target as tall as the rows
                        beside it (data-nav-span: Inicio's hero, left ▲ ▼ only for what lies
                        wholly that way, beyondEdge, else the next zone), a list's lines
                        (data-nav-line: Ajustes' rows, ▲ ▼ read each target as wide as its
                        line, lineSpan, so a narrow switch between two sliders is next), the way
                        back (NavPath), the focus memory (FocusMemory), fields in navigation or editing
                        mode (data-editing), the edge nudge (mn-bounce-*) and heldOver (a key's
                        repeat held over from the match walks no focus and clicks nothing: the
                        pause's held QUIT); FocusNav puts them
                        on the DOM and measures each target where it sits (layoutBox: a focused
                        tile's lift or a nudge taken off, so a lifted tile has no neighbour
                        "below" on its row)
  device.ts             the last input (pad / remote / keyboard / mouse / touch, data-input on
                        <html>), html.tg-tv (no pointer at all, or #tv), the layout class by height
                        and orientation (layoutClass: pc, short, phone, portrait, tablet, tv;
                        data-layout and data-shell on <html>) and --ui-scale (uiScale times the
                        player's interface size: interfaceSizes per class and screen,
                        interfaceFactor, a TV counting from its usual 125 %; data-ui-factor for
                        fit.ts), reduced motion (html.tg-reduce-motion: the system's or the
                        player's, applyUiSettings, motionReduced), finePointer
                        (a text field may take a first focus), the tap guard (tapGuarded); pure +
                        installDevice
  backGuard.ts          system Back (Android gesture / button, TV remote BACK, browser back, Alt +
                        ←, mouse back, GoBack / BrowserBack keys) as Game.onSystemBack: a
                        CloseWatcher kept alive (Android's Back, no user activation needed) and
                        one sentinel history entry re-armed after each Back (the history Backs;
                        sections are no history entries of their own: backModel.ts walks them);
                        released while JUGAR's "Leave Turbogol?" is up. Mid-match the Game adds a
                        beforeunload backstop (updateLeaveGuard)
  prefs.ts              the menus' prefs (turbogol.menu.v1: region, playlists, Casual's connection
                        (auto, the default, and P2P join the P2P queue; server the server one),
                        the leaderboard's playlist, lastQueue: the kind searched last, which
                        JUGAR AHORA repeats); parsePrefs, pure
  howPlay.ts            "How will you play?": howPlayAsk (a new PC player pressing with the mouse
                        or the keyboard; a controller's press answers it; never a returning
                        player), the answer in turbogol.howPlay.v1; pure + storage
  dom.ts, badges.ts     h() builder, nav buttons, CSS-drawn rank badges and rating cards
  screens/              JUGAR's root, Inicio (home.ts: the plate, the hero and the four mode tiles,
                        rendered on a key's change, a TV's controller slot, window.__homeHero in
                        dev / VITE_UI_FIT; homeModel.ts, pure: the hero's state in priority order,
                        heroQueue (lastQueue, Competitive only signed in and not banned), isOffline
                        (no Worker or two failed population polls), queueParts, twoLines,
                        plateRank; tests/home-hero.test.mjs); MODOS (modes.ts, stacked on Inicio,
                        each tile opening it on its tab: Menu.open's tab, Screen.setTab): vertical
                        tabs CASUAL · COMPETITIVO · SALAS · CONTRA LA IA (Q / E, LB / RB, LT / RT
                        step them: Screen.command; the hint bar names them, Screen.tabsVerb), the
                        2 x 2 formats (a press picks and searches, restarting a running search of
                        that kind), Region and Advanced (connection) rows, VS AI's mn-seg and
                        Stadium row, the lobby list (custom.ts lobbyBrowser), and the action zone:
                        FIND MATCH / SIGN IN (PERFIL as a detour, back on a sign-in) / a ban's
                        reason / PLAY / CREATE LOBBY, or the searching panel with "bots join in"
                        (modesModel.ts, pure: tabs, formats, queueNet, botsCountdown from
                        /api/config's botFillMs or P2P_FILL_WAIT_MS, countShown, actionKind;
                        tests/modes.test.mjs), GARAJE's "coming soon" (garage.ts, until plan PR
                        8), custom lobby create / lobby (custom.ts: the host's experimental rules row for
                        unlocked players, P2P only, EDIT PRESETS; the EXP tag, 🔒 for a guest; the
                        rules line before the match), training (with Experimental free play, its
                        rules picker and Edit presets for unlocked players), profile (sign in / up /
                        recover, account actions), leaderboard + ranked result dialog
                        (RankedResults.watch's `into`: the FINAL's rank card takes the answer
                        while it is up; else the toast or the dialog as before);
                        match/final.ts (the FINAL: a screen stacked on Inicio, the shell's bars
                        aside, PLAY AGAIN focused, Back = MENU; window.__final(kind) samples in
                        dev / VITE_UI_FIT), match/finalModel.ts (pure: FinalView, goalScorer from
                        the state buffer's per-car ball-hit tick, pickMvp, againAction,
                        changeScreen, rankCard; tests/final-model.test.mjs), match/found.ts
                        (PARTIDO ENCONTRADO, z 45, the tab's title)
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
                        the experimental switch and presets (each call for the account that made
                        it: a refresh that hands back another account never gets it); a listener
                        list (subscribe) and the { name, id } hint the boot reads (readAccountHint)
  LobbyClient.ts        custom lobbies: list / create / join by code, the lobby socket (state,
                        match result per member, back, kick, settings)
  p2p/                  phase 2: peer-to-peer deterministic rollback (docs/online/PHASE2.md)
    protocol.ts         signaling JSON (RoomWelcome with the room's physics, signal relay, ready
                        with the arena's physicsFp, start, drop,
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
                        custom lobby's room; with experimental rules the arena and both BotTeams
                        follow RoomWelcome.physics, 'ready' carries the fingerprint the wasm reads
                        back, and there is no server fallback: a failure goes back to the lobby)
                        -> room -> mesh ->
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
                        loopback page origins accepted while the Worker runs on a loopback host);
                        /api/lobbies (experimental rules from an account session only); the queues
                        never take rules (400 experimental_lobby_only)
  src/auth.ts           HS256 JWT on WebCrypto: sessions, tickets (jti), internal header
  src/MatchmakerDO.ts   one per region (chosen in the menu or the continent): a waiter sits in
                        the queue of every playlist it searches; 'ranked': MMR window growing
                        with the wait, balanced teams, never bots; /custom forms a lobby's
                        match with fixed teams (experimental rules: a P2P room with >= 2 humans,
                        every member signed in, its locks marked: no no-show strikes);
                        /population for the menus;
                        queues per (mode, kind); 'server': bot fill after 10 s;
                        'p2p': a room at once with the mode's humans, after 15 s with >= 2 humans
                        + bots, a lone human -> a server match; rosters, seeds, tickets, locks
  src/RoomDO.ts         one per P2P room (Hibernation API, no simulation): RoomWelcome (seed,
                        slots, ICE, physics), signal relay, ready (its physicsFp must be the
                        room rules' fingerprint, else physics_mismatch) -> start { startAt: now +
                        1.5 s }, drop { slot, atTick: max(reported) + 60 } on a majority of
                        'unreachable' reports or a socket closed > 5 s, hashReport, locks released
                        on close, cleanup 60 s empty / 20 min TTL
  src/MatchDO.ts        one per match: sockets, RoomHost loop (setInterval 8 ms + accumulator),
                        snapshots every 4 ticks, events, TTL / shutdown; ranked: no start until
                        every player is ready (else cancelled at 45 s, no-shows penalised),
                        forfeit when a team quits / stays disconnected 60 s, result -> AccountsDO
  src/AccountsDO.ts     the one SQLite object for every account (accountStore.ts): users,
                        refresh tokens, ratings, ranked results / abandons / bans / locks, training
                        records, the experimental switch and presets, login throttle, daily prune;
                        a report or record that carries experimental rules is refused
  src/accountRoutes.ts  /api/auth/* (register, login, refresh cookie, logout, recover, password,
                        recovery codes, Google / Discord OAuth with PKCE), /api/me, /api/me/training,
                        /api/me/experimental, /api/me/presets (account only, 10 presets, 30 writes a
                        minute), leaderboard, ranked result; server-side PBKDF2 of the client key
  src/LobbyDO.ts        one per custom lobby (hibernating): members / teams / host / settings,
                        admit (password, kick list), start through the matchmaker's /custom;
                        experimental rules (P2P only, strict) only while every member is signed
                        in: guests refused at create, admit, upgrade, settings and start
  src/LobbyDirectoryDO.ts  join codes -> lobby ids and the public list per region
  src/roomHost.ts       RoomHost: per-slot input rings (hold last, bufferHint), BotTeam for bot
                        slots, Match rules, rs_save_state snapshots (env-agnostic; fake-sim tests)
  src/wasm.ts           the shared rocketsim.wasm as a WebAssembly.Module in workerd
  test/                 auth + RoomHost + room / matchmaker unit tests (node), experimental-lobby
                        (the lobby gates and every standard-physics-only path), smoke.mjs (phase 1
                        end to end vs wrangler dev), smoke-p2p.mjs (phase 2 signaling end to end),
                        smoke-accounts.mjs (accounts, ranked, lobbies, an experimental lobby)
docs/online/            PHASE1.md, PHASE2.md (the designs), DECISIONS.md (confirmed decisions),
                        MEASUREMENTS.md, ACCOUNTS.md (menus, accounts, ranked, lobbies, OAuth setup)
docs/experimental.md    Settings > Experimental for players (turning it on, presets, every value
                        with its range, lobbies, what never counts) and for developers (the cost
                        bench, where the code is, what deploying it needs)
src/audio/
  Audio.ts              synthesized engine/boost/impact/goal sounds driven by sim events
src/main.ts             boot behind the loading screen: wasm load ‖ renderer init + the world's
                        first bake, build arena, settings, Game, warm-up render, start, fade into
                        the menu
index.html, src/style.css (the entry sheet: imports src/ui/styles/tokens.css and focus.css; the
                        HUD, the loading screen, #widetext and super low)
public/fonts/           tg-display-v1.woff2 (the display font, 5.6 KB) and its OFL.txt
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
                        3v3 bots at the corners), rules-text (the menus' rules lines),
                        experimental-training (free play only, packs
                        stock, createArena before the car, the rebuild, no records, game speed;
                        real arenas with the extreme built-ins), hud-menu (the preset editor over
                        the real store with a fake row kit; the network bars, the ball indicator's way round the
                        plates), final-model (the FINAL's decisions and copy), experimental-store (incl. a preset
                        the full account refused), menu-accounts (a 401 write sent again once,
                        never to another account)
scripts/                headless node runs: smoke-sim.mjs (one Bot vs an idle car),
                        smoke-match.mjs (BotTeam vs BotTeam in any mode: touches, goals incl.
                        own goals by last-toucher attribution, bumps, stuck time, throughput;
                        fails on a > 10 s dead ball or an own-goal streak), stock-trace.mjs (the
                        golden stock trace runs; --write re-records them for a deliberate change),
                        cdp.mjs (a headless Chrome / Edge over DevTools with Node's WebSocket:
                        Page, findBrowser, freePort, waitHttp; for ui-fit and play-timing),
                        play-timing.mjs (one press on JUGAR AHORA to a real match, against a dev
                        server and the local Worker: boot→menus reported, press→match failed over
                        15 s; --net server, --first for "How will you play?", --port / --url),
                        bot-bench.mjs (this tree's bots against a git revision's; --preset plays
                        the same seeded matches on stock and experimental physics and compares the
                        step, think(), ball prediction and whole-tick cost, failing when a preset
                        breaks the state or the predictor), bot-skills.mjs (bot scenarios),
                        ui-fit.mjs (every menu screen at nine sizes with #widetext, in English
                        and Spanish, in a headless Chrome / Edge over CDP: window.__uiFit,
                        src/ui/fit.ts; Inicio in every hero state, ✕ focused, a TV with a
                        controller, Competitive in every format idle and searching with the
                        Menu's own pills (every format in the subtitle, a TV's region by the
                        plate), then a TV's controller sheet closed by a fake controller with
                        A held; last on the touch sizes the touch match (an offline match in
                        touch mode: the controls' edges and overlaps, each first-match card, the
                        board, the touch pause with RESUME over BOOST's centre, free play's,
                        upright the rotate notice); a fresh tab per size and language with its
                        device pinned, a mouse on the desktop sizes; then the hints of every other input on the
                        screens that change the shell; --face for a fallback wider than Arial,
                        --online and --long-name for a pill and a chip this page cannot reach
                        alone, --no-pointer for a runner without one)
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
  live = a match being played (online: the session's match, paused or not)
  if !runsLogic(t, lastLogic, cap, live, pacer): // a match keeps its cap (super low: 30 in whole
     if online pause: input.readEdges()   // refreshes; the player's fpsCap at its average), the
     return                               // time carries over; the menus and an offline pause
                                          // run every animation frame
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
  fps = sceneFps(cover, cap, ...)         // UI at rest, below
  if drawsScene(t, lastDrawn, fps, changed || redraw, pacer):  // a match: every frame of logic
     chase.update(..., input.look)        // swivel + rear view (the menus: the orbit)
     renderer.render(prev, cur, alpha)    // interpolated transforms, camera, effects, HUD
  frameLogic(dt)                          // scoreboard while held (or tapped open), touch controls, pointer-lock
                                          // hint, GO caption, back to the menus, audio
```

**UI at rest** (quality.ts `sceneFps`, Game.ts `frame`): the scene is drawn at the match's cap; at
30 fps under the menus (20 on super low when they let it through, and on a touch screen whose menus
hide more than 70 % of it: src/ui/cover.ts); and not at all, one held frame, under an opaque layer
(a menu sheet, the menus' own opaque page on super low, the settings screen, an offline match's
rotate-your-phone screen: online the match and its scorebug go on under it), in an offline pause,
and under the menus with `prefers-reduced-motion` or
`GamePrefs.menuSceneAnimated` off (the orbit stops). The Tablero shell reports what it leaves of the
scene through `MenuHost.setMenuCover` ('none' / 'partial' / 'opaque', Menu.reportCover): 'partial'
on every section, stacked screen and layout (the bars, the rail or the tabs, the pills and toasts
count in the measured share of a touch screen: a toast lets the pointer through, so its box is
hit-tested first, cover.ts atOverlays; GARAJE's almost empty stage measures low), 'opaque'
under any sheet (region, leave, update once Settings close, the language list, About, a confirm) and while
`.mn` paints an opaque backdrop (super low's `--mn-backdrop` is `--ink`: the stadium is hidden
there, so it holds instead of running at 20 fps), 'none' once hidden; the Game adds its own layers
(the settings screen, the rotate screen of a match: upright menus work, `.mn-open` keeps it away). A
held frame is drawn again when something under it changes (a change of pace, a resize, rebuilt
views, the end of a load, a tab that comes back, a warm-up frame): the canvas keeps its last image
in between. The menus' rates and the player's limit keep their average on any display (`FramePacer`:
the refresh nearest a deadline that advances one period at a time, pulled a tenth toward the frame
drawn: 30 fps on 144 / 165 Hz, 20 on 50 Hz, and locked to a 59.94 / 60.05 Hz display without a
skipped refresh); the tier's own cap counts whole refreshes as it always did (`drawsFrame`: super
low's 30 is 25 on 50 Hz). The input is read on every animation frame outside a match, and an online
pause reads the pad between its cap's frames (`Input.readEdges`: the edges wait for the next frame
of logic), so a pad tap shorter than one drawn frame still moves the focus. Paced and held frames,
and those under the player's limit (two counts of refreshes, which it would take for late frames),
give dynamic resolution no interval; the menus start at full resolution
(`Renderer.resetResolutionScale`), the next match lowers it again under its own load. The menus'
orbit runs on drawn time (it resumes where it stopped); `GamePrefs.fpsCap` (30 / 60 / none) and
`menuSceneAnimated` have no Settings row yet (`Game.setFpsCap`, `Game.setMenuSceneAnimated`).
`#diag` shows the drawn rate "of" the animation frames, and counts a match's stalls between drawn
frames (as before: a frame the cap should have drawn) and a paced scene's between animation frames.

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
  the pause menu) picks the tier: Performance / High / Ultra as cards, and "Super low mode" as a
  switch for everyone, guests included (it only changes how the stadium is drawn; on, no card is
  lit; off is Performance, picked, so a TV's own super low does not come back); its other rows are
  the Game's prefs: the resolution scale (Renderer.setResolutionBase), the frame limit and the
  menus' animated stadium; `switchQuality` rebuilds every view and the render path
  (~30 ms), waits for the world's bake at the new sizes and compiles the new pipelines in
  parallel, all behind the loading screen; into or out of super low it saves the prefs and
  reloads the page (`restartOn`: its own backend and world), except in an online match, where the
  reload would leave it: the pick waits for the menus (`pendingRestart`, its line on the Graphics
  tab), and for the match's FINAL to go when one is up (`finalLeft`: its JUGAR OTRA VEZ then goes
  to Inicio first). The prefs keep the player's pick
  only (`persistPrefs` writes `savedQuality`): a tier the session runs on its own (the URL, auto,
  a ceiling, a fallback) is never saved. Super low's CPU trims (`cpuLite`): `html.tg-superlow`
  (opaque surfaces, a flat lime hero, no box or text shadow but one hard pixel under the HUD's
  text, no decorative transition or animation by class prefix; the focus ring stays: "UI tokens"
  below), boost and speed at 10 Hz, no audio room,
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

Experimental rules (P2P protocol 5): a custom lobby whose signed-in host picked a physics preset
(`LobbySettings.physics`, a copy of it) passes it, checked strictly at every door (LobbyDO, the
matchmaker's `/custom`, RoomDO, RoomClient: `parseLobbyRules`), to its RoomDO, whose welcome
carries it to every socket. Each peer creates its arena with `arenaMutators(physics)` before any
car and plans both BotTeams with `botPhysicsOf`; the integers are the same everywhere, so the f32
config is too. The state hash does not cover that config, so `ready` carries the fingerprint of
the mutators the wasm reads back and the room refuses another one (`physics_mismatch`: the socket
is closed, the others play on with the team AI in that slot). Only signed-in players play such a
room (guests are refused by the Worker and LobbyDO, and again by the matchmaker's `/custom` and
RoomDO's create, which get every member's `guest` flag), it never falls back to a server match, and it
counts for nothing: the casual and ranked queues, MatchDO, community nodes and every report to
AccountsDO refuse a body that carries rules, and the room never names a no-show (its matchmaker
locks are marked too). Every other match runs the standard physics, bit for bit.

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

## UI tokens, focus and the display font

The Tablero redesign (PR 1: base) gives the three UI worlds (the menus `mn-`, the HUD `hud-`, the
training HUD `trn-`, the touch controls `tc-`) one set of tokens, `src/ui/styles/tokens.css`,
imported first by `src/style.css`:

* **Colour.** `--ink`, `--surface-0..3` (opaque) and their alpha twins for a surface over the live
  scene (`--surface-0-94`...), `--edge` / `--edge-hi`, `--text` / `--text-2` / `--text-3` (the 5.6:1
  floor), the lime `--brand*` (one filled lime thing per screen, plus boost and the goal), team
  `--blue*` / `--red*` (teams only), `--danger`, `--warn`, `--ok`, `--info`, `--rank-gold` (ranks
  only), `--lab` (Experimental only), `--focus`, `--veil` (pause, dialogs, the summary: solid, never
  blurred) and `--scrim`. Nothing in `src/` uses `backdrop-filter` (each one re-reads and blurs the
  canvas every frame): `tests/css-budget.test.mjs` fails on one.
* **Type.** Display and Heading roles (titles, buttons, tabs, numerals; always capitals) use
  `--font-display`; Body and Label keep the system stack they always had, `--font-body` (Bahnschrift
  on Windows, Roboto on Android, San Francisco on Apple; no Impact). Weights stop at 700. The scale
  `--t-hero ... --t-label` per class (PC, short screens, phone landscape, phone portrait,
  `html.tg-tv`) is in rem for the shell's root scale: `html { font-size: 16px x --ui-scale }`
  (device.ts uiScale: PC by height, 768 = 1, 0.9 to 1.35; a short laptop by height, 600 = 1, 0.9 to
  1; a phone sideways by height, 390 = 1, up to 1.1, never under 1, so its text keeps 14 px and the
  rail its 123 px at 360 tall; upright by width, the same; a TV by width, 960 = 1, up to 2) times
  Settings › Game's interface size (device.ts interfaceFactor: 150 % on a computer, 130 on a
  tablet, 115 on a phone where its bars have room; a TV's 125 % is its usual look, 100 its only
  smaller step), with
  `body` kept at 16 px so only rem sizes (the shell) follow. No font size or radius literal under
  `src/ui/styles/` outside tokens.css either (the test again).
* **Space, radii, shadows, layers, motion:** `--sp-1..8`, `--r-slot / key / tile / panel / pill`,
  `--shadow-sheet` (static, sheets only), `--z-*` (the order of the HUD, menus, settings, anti-bot,
  rotate screen and loading screen), `--dur-*` / `--ease*` (transform and opacity only).
* **Focus** (`src/ui/styles/focus.css`): a 3 px white outline 3 px out, an `--ink` ring in the gap
  (a spread-only shadow that super low keeps) and a lime heel skewed -20 degrees under the box;
  rows (lists, settings rows, button stacks, one-stop groups, training packs, cyclers) get a lime
  bar on their left inside edge instead. Never on a touch screen; 4 px and a 6 px heel under
  `html.tg-tv`. Every vertical scroller (`.mn-stage`, `.mn-lobbies`, `.mn-board`, `.mn-sheet`,
  `.mn-set-body`, `.mn-set-tabs`) has a scroll padding of 16 px (24 under a heel), since the focus
  is scrolled in with `block: 'nearest'`, flush with the edge; tile grids are 16 px apart, past the
  heel.
* **Hover** only inside `@media (hover: hover)`; one pressed state (`scale(.97)`, a step darker, the
  lime primary to `--brand-deep`) in the menus, the HUD's pause and settings and training; one
  `prefers-reduced-motion` block for every prefix in `src/style.css` (opacity still fades, 120 ms at
  most; the search spinner keeps turning).
* **Super low** is one switch: the alpha twins point at the opaque surfaces, `--brand-grad` at the
  flat lime, the menus' shell is an opaque page (no full-screen translucent layer), every `mn-` /
  `hud-` / `trn-` / `tc-` transition and animation is off except the informative ones (spinner,
  hold, busy stripe, low / overtime clock, key capture, the P2P wait line).

**Display font.** `public/fonts/tg-display-v1.woff2` (5,616 B, 88 glyphs: A-Z, Á É Í Ó Ú Ü Ñ, 0-9,
v and the UI's punctuation; kern and tabular figures kept) is Barlow Condensed Bold 1.408 (SIL OFL
1.1, `public/fonts/OFL.txt`, THIRD_PARTY_NOTICES.md) from google/fonts
`ofl/barlowcondensed/BarlowCondensed-Bold.ttf` (SHA-256 `e476562e...5b65`), cut with fontTools 4.60.1
(+ brotli):

```
pyftsubset BarlowCondensed-Bold.ttf --flavor=woff2 --output-file=tg-display-v1.woff2   --unicodes="U+0020-0023,U+0025-0029,U+002B-003B,U+003F,U+0041-005A,U+0076,U+00A0-00A1,U+00B7,U+00BF,U+00C1,U+00C9,U+00CD,U+00D1,U+00D3,U+00D7,U+00DA,U+00DC,U+2013-2014,U+2019,U+2026,U+2039-203A,U+2212"   --layout-features=kern,tnum --no-hinting --desubroutinize   --name-IDs=0,1,2,3,4,5,6,13,14 --name-languages=0x0409 --drop-tables+=DSIG,gasp
```

Same origin (COEP `require-corp` has nothing to say), preloaded by `index.html`, `font-display:
swap`, one `unicode-range` with those code points; a new cut is a new versioned name (`-v2`). The
face's line metrics are overridden (ascent 90 %, descent 20 %) so capitals sit centred in the line
box. Until it arrives, or if it never does, the stack falls to Windows' Bahnschrift (Bold Condensed
is 1.1x as wide), then to Android's Roboto Condensed / Roboto through local() faces scaled to the
same widths (`size-adjust` 83.5 % / 73.2 %, measured on 21 UI labels), then Apple's DIN Condensed /
Avenir Next Condensed and the condensed system faces.
`#widetext` replaces every family with plain Arial (Roboto's width) to test a layout without it;
`data-fit` (src/ui/fit.ts) shrinks a label that would not fit, down to its minimum, then takes its
short form (ENTRENAR, RANKING), and `node scripts/ui-fit.mjs` checks every menu screen (the FINAL
with each kind's sample, PLAY AGAIN focused) at 780x360,
844x390, 960x540 (TV), 1366x768 (a PC, and a TV), 390x844, 1920x1080, 1366x600 and 820x1180 with
it, in English and Spanish and with the hints of every input (CI job `ui-fit`, information only
for now); `--face Verdana`
(Windows, macOS) or `--face 'DejaVu Sans'` (Linux, CI's second step) runs it with a fallback wider
than Arial, which must fit too.
`scripts/copy-notices.mjs` refuses to build with a font and no license next to it.

## Legal

Turbogol is AGPL-3.0-or-later (`LICENSE`). RocketSim (MIT, ZealanL) is a git submodule; its
license and those of Bullet (zlib), three.js (MIT) and the Emscripten runtime libraries are in
`THIRD_PARTY_NOTICES.md` and ship with every build. Every model, texture, layout and sound of the
game is generated by this repository's code; no third-party game content is used.

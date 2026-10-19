# Bot rework plan

Status: **proposal, open to anyone**. The bots work and ship today; this is the plan to make
them genuinely good, in small steps that each can be measured, reviewed and released on their
own. If you want to take a phase or a single item, say so in its issue (or open one) so two
people do not build the same thing.

Starting point measured on 2026-10-19 (`bf20822`, after "bots fly"), with the tools described
in [Measuring](#measuring).

## 1. Where the bots are today

`src/ai/Bot.ts` (one car, ~2200 lines) and `src/ai/Team.ts` (`BotTeam`, 2v2 / 3v3 roles) are a
heuristic decision tree: every few ticks the bot picks a mode (kickoff, attack, defend, support,
boost, recover, aerial), turns it into a driving target, and a target-chasing controller steers
toward it. [src/ai/README.md](../../src/ai/README.md) documents every rule and tunable.

What the skills suite says (`node scripts/bot-skills.mjs`):

| skill | medium | hard | what it shows |
|-------|--------|------|---------------|
| shots (21 set-ups, keeper on the line) | 17 goals, 1958 uu/s | 18 goals, 2509 uu/s | finishing an open ball is fine |
| aerials (5 balls in the air) | 3 met in the air | 2 | flies since #20, but plans are conservative |
| saves (12 shots at its goal) | **0 saved** | **4** | defending a shot barely works |
| approach (still ball, 16 starts) | 2.24 s, **7/16** first touches forward | 2.27 s, 7/16 | the car gets there, often from the wrong side |
| recovery (8 tumbling drops) | 8/8 upright in 1.33 s | same | fine |

What matches say (`node scripts/bot-bench.mjs`): in bot-vs-bot play only 12-15 % of hard touches
leave the ball moving toward the opponent's goal at speed; most touches are scrambles. One bot
think costs **12-15 µs per bot per tick**.

Root causes, roughly in order of impact:

1. **The car chases points, not (point, heading, time).** `approachTarget` drives through a hit
   point behind the ball and "goes around" when on the wrong side. It does not know when it will
   arrive or from which direction, so it arrives early, late or sideways: the 7/16 above, and the
   scrambles in matches.
2. **No contact model.** The bot assumes the ball leaves along the line from car to ball. It
   cannot choose the touch that sends the ball to a corner, to a teammate or safely out of its
   own half, which is also why crosses failed (see 5).
3. **Defence is positional only.** Shadowing and a goalie spot, but nothing that intercepts a
   shot on its line before it reaches the goal.
4. **Aerials are a single constant-acceleration check** with a safety margin; reachable balls
   higher or further away are skipped.
5. **Team play is roles without plays.** Attacker / support / defender with hysteresis and
   "never double-commit"; no rotation model, no passing. Tried in #20 and rejected by the bench:
   crosses to a waiting support (the touch could not aim the cross and the receiver's role switch
   made it chase it), a boost reserve, a far-post aim, a shorter go-around.

## 2. Goals and non-goals

Goals:

- A **difficulty ladder** where each level is a clear step: easy beatable by a first-time player,
  medium for casual play (it fills online matches), hard a real opponent, and room for an
  "expert" level on top. Measured as an Elo ladder (below).
- **Visible skills by level:** aerials and aerial saves, saves on the line, power shots aimed away
  from the keeper, passes and centres, rotation in 2v2 / 3v3.
- **Team play that works with humans:** the human teammate is a passive member today (ranked,
  never driven); the bots must keep rotating around a human who does not follow plans.
- Keep every constraint in section 3.

Non-goals (for this plan): learned / neural policies in the shipped bot (a research branch can
use the same tools to evaluate one), physics exploits, wall play beyond getting off walls (phase 7
is optional), "personalities" that play badly on purpose beyond what difficulty needs.

## 3. Hard constraints

These are binding: every PR is checked against them.

- **Determinism.** P2P peers each run the room's bots on the confirmed timeline, the server host
  runs them, and community nodes replay matches to verify them. So: randomness only from the
  bot's seeded `Rng`; no `Math.random`, no clock, no iteration order that can differ between
  engines. Everything that survives from one tick to the next goes through `saveState` /
  `loadState` (and `STATE_FLOATS`) so rollback checkpoints restore it exactly
  (`tests/p2p-checkpoint.test.mjs`).
- **Protocol bump.** Any change in bot behaviour bumps `P2P_PROTOCOL_VERSION`
  (src/net/p2p/protocol.ts, mirrored by `ROOM_PROTOCOL` in server/src/RoomDO.ts) and
  `PROTOCOL_VERSION` (src/net/protocol.ts): peers on different builds would desync.
- **No allocation in `think()`.** It runs 120 times a second per bot; garbage-collector pauses
  show as stutter. Preallocate in constructors (the existing code is the model).
- **CPU budget.** Today 12-15 µs per bot per tick. Budget: **60 µs average, 400 µs worst single
  tick** per bot (the bench prints the average). A server match or a community node runs up to
  six bots at 120 Hz.
- **Pure TypeScript,** no DOM, no three.js: the same code runs in the browser, the Worker and
  Node.
- **Stable public API,** used by `src/game/Game.ts` (offline), `server/src/roomHost.ts` (server
  matches, a disconnected human taken over by a bot), `src/net/p2p/P2PSession.ts` (P2P) and
  `nodes/` (through `RoomHost`):
  - `new Bot({ team, difficulty, seed })`, `think(state, mySlot, opponentSlot, out)`,
    `setDifficulty`, `reset`, `saveState` / `loadState`, `Bot.STATE_FLOATS`, `teamCtx`, and the
    read-only `mode` / `target` for debugging;
  - `new BotTeam({ team, difficulty, seed })`, `setSlots(slots, passiveSlots)`,
    `think(state, outs)`, `reset`, `setDifficulty`, `saveState` / `loadState`,
    `BotTeam.stateFloatsMax`, and the `roleAt` / `botAt` / `slotAt` / `dutyAt` / `isPassive`
    accessors.
  Internals may change completely behind these.
- **Brand rule** ([TRADEMARKS.md](../../TRADEMARKS.md)): no names from commercial games in code,
  comments, docs or commits, including the names of their bot frameworks.

## 4. Target architecture

Same facades (`Bot.ts`, `Team.ts`), new layers behind them:

```
src/ai/
  Bot.ts            facade: public API, owns the layers of one car
  Team.ts           BotTeam facade: roles, plays, commitments
  world/            WorldModel: one read of the state per tick (cars, ball, prediction) plus derived
                    facts (who is closest in time, possession, pressure, threat to each goal, boost map);
                    computed once per team, shared by its members
  model/            physics models fitted to RocketSim: time-to-reach (car -> point + heading),
                    car-ball contact (touch -> ball velocity), jump / boost / air rotation
  mech/             mechanics, each a small controller with a feasibility check:
                    drive-to (point, heading, time), powerslide turn, dodge (front, diagonal,
                    cancel, half-flip), speed-flip kickoff, aerial (incl. double-jump / fast aerial),
                    recovery (land aligned), later wall ride
  plays/            intents scored by utility: Shoot, Clear, Challenge, Save, Shadow, GetBoost,
                    Rotate, Pass, Receive, Kickoff (Demo optional); each = { score(world), plan }
  difficulty.ts     levels as explicit knobs (section 4.6)
```

The order matters: each layer is useful on its own and can replace the matching part of today's
code behind a flag.

### 4.1 Time-to-reach model (`model/`)

Given the car (position, velocity, heading, boost) and a goal state (point, heading, maybe a
speed), estimate the earliest arrival time: a turn on the speed-dependent radius (the curvature
table in `math.ts`) plus a straight, with the throttle / boost acceleration profile. Validate it
against the sim: a calibration script drives a real car to a few hundred targets and compares
predicted and actual times (target: within 10 % for 90 % of targets).

### 4.2 Drive-to controller (`mech/`)

Arrive at (point, heading) at a given time: steer along the planned arc, throttle / boost /
brake to match the time, powerslide when the turn needs it, re-plan every decision. This replaces
`approachTarget` + `computeDriving` and is the biggest single fix (root cause 1).

### 4.3 Contact model and shot solver (`model/`, `plays/`)

Fit how a touch sets the ball's velocity (car velocity, the contact point on the hitbox, dodge
impulse) from sim sweeps; then solve for the touch that sends the ball to a target: a corner of
the goal away from the keeper, a teammate's run, a safe clear. Combined with 4.1 this gives the
intercept planner: over the prediction slices, the earliest one where the needed touch is
reachable.

### 4.4 Aerial planner v2 (`mech/`)

Sample take-off time and meeting time; model the jump phases (single, held, double), boost
along the nose and the rotation time; aim the touch with the contact model; abort and re-plan
early; land aligned with the velocity. Also aerial saves.

### 4.5 Plays and team (`plays/`, `Team.ts`)

Each decision scores the candidate plays (expected goal value, possession, risk to our goal),
with hysteresis so the bot commits. The team layer adds:

- a **rotation model**: first man challenges, second supports ~2000 uu behind and to the side,
  third holds the back post; after a challenge the first man rotates out along the far side;
- **commitments**: a bot claims the ball through `TeamContext` with its arrival time; others
  respect the claim unless clearly faster (today's hysteresis, made explicit);
- **passes**: Pass is scored when a teammate (bot or human) can reach a spot before the opponents
  and the shot value is low; the receiver runs a Receive play (and keeps it through role changes,
  the failure seen in #20).

### 4.6 Difficulty as knobs (`difficulty.ts`)

Instead of noise on a strong bot, explicit limits: reaction delay (decision interval and
prediction age), prediction noise, which mechanics are allowed (aerial, double jump, power
dodge, passes), the planning horizon, utility noise (picks a worse play sometimes), boost
greed. Tuned with a round-robin of levels in the bench until the ladder has clear gaps
(for example at least 150 Elo between consecutive levels) and easy loses to a newcomer-style
script often enough.

## 5. Measuring

Three tools exist; every change uses them and pastes the results in its PR.

- `node scripts/bot-skills.mjs [--baseline=origin/main] [--difficulty=medium,hard] [-v]`: fixed
  scenarios (shots, aerials, saves, approach, recovery, kickoffs vs the baseline), A (your tree)
  and B (a git revision) side by side. Fast (under half a minute) and noise-free: the first check.
  Add scenarios for whatever your change is about (a pass and finish, a 50/50, a wall ball).
- `node scripts/bot-bench.mjs [--baseline=origin/main] [--modes=1v1,2v2,3v3] [--matches=40]
  [--tuneA=k=v] [--paramsA=hard.k=v] [--json=out.json]`: 3-minute matches A vs B with goals,
  shots, aerial touches, passes, own goals, forward touches and the think() cost. It prints A's
  score with a 95 % interval and the Elo it implies; with 40 matches equal bots still land
  anywhere in about 35-65 %, so only "A better" / "A worse" means something. `--tuneA` /
  `--paramsA` compare variants without editing code.
- `npm test`: the unit and sim tests (`tests/bot*.test.mjs`, `tests/p2p-checkpoint.test.mjs`),
  including determinism of the saved state. Every bug fixed gets a scenario there.

Acceptance for a bot PR: tests green; skills not worse anywhere (and better where the PR aims);
the bench never "A worse" in any mode at the difficulties touched; CPU within budget; protocol
versions bumped; src/ai/README.md updated.

PR report template:

```
Skills (bot-skills, baseline origin/main):   <paste the table>
Bench (bot-bench --matches=40, hard):        <paste the summary lines per mode>
Bench (medium, if touched):                  <...>
CPU: think() per bot and tick A / B:         <us>
```

## 6. Roadmap

Each phase is one or more PRs, shippable on its own, new code behind a `TUNING` flag until the
numbers say to switch it on.

**Phase 0: foundations (no behaviour change)**
- [x] Bench with confidence interval, Elo and CPU; skills suite; shared loader for a git revision's
  bots (`scripts/bot-lib.mjs`).
- [ ] Golden-output test: record every bot output over a fixed set of seeded scenarios; a refactor
  must reproduce it bit for bit.
- [ ] Split `Bot.ts` into `world/`, `mech/`, `plays/` with the golden test unchanged.
- [ ] Shared `WorldModel` per team (one state read per tick instead of one per member).
- [ ] Calibration scripts and datasets: time-to-reach, contact model.

**Phase 1: driving** (4.1, 4.2)
- [ ] Time-to-reach model + its validation script.
- [ ] Drive-to controller replacing approach / driving behind a flag.
- Target: approach first touches forward 13/16 or more at no slower times; bench not worse.

**Phase 2: shooting and first touches** (4.3)
- [ ] Contact model; shot solver; intercept planner.
- [ ] Aim away from the keeper (once the solver can hit a corner; a plain far-post aim missed in #20).
- [ ] Power shots: dodge timing from the model.
- Target: shots 20/21 hard, more on target with a moving keeper (new scenarios); forward touches
  in matches up; bench "A better" in 1v1.

**Phase 3: defence**
- [ ] Save play: intercept a shot on its line (ground and air), clear toward the side.
- [ ] Back-post rotation, last man back.
- Target: saves 9/12 hard, 6/12 medium; own goals not up.

**Phase 4: aerials v2** (4.4)
- [ ] Planner with jump phases and rotation time; fast aerial; aimed aerial touches; landing.
- Target: aerials 4/5 hard, 3/5 medium; under 20 % of started aerials abandoned.

**Phase 5: team play** (4.5)
- [ ] Rotation model and explicit commitments.
- [ ] Pass and Receive plays (bots and the passive human as receivers).
- [ ] New scenarios: 2v2 centre and finish, 3v3 rotation (never two on the ball, last man back).
- Target: assists in the scenarios, passes in matches up, bench "A better" in 2v2 and 3v3.

**Phase 6: difficulty ladder** (4.6)
- [ ] Knobs; round-robin bench of the levels; Elo gaps; decide the online fill level (medium today).

**Phase 7 (optional):** wall play, dribble and flick, kickoff variants (speed flip), demos.

## 7. Contributing to the bots

- Talk first for anything bigger than a tunable: comment on the phase's issue or open a
  Discussion with the idea and how you will measure it.
- Keep PRs small: one mechanic, one play, one model. Behind a flag is fine.
- Run the three tools and paste the template above in the PR.
- Read [src/ai/README.md](../../src/ai/README.md) for how the current bot decides; update it when
  you change a rule.
- Good first contributions: a new skills scenario (wall ball, 50/50, a moving keeper), a JSON →
  Markdown summary for the bench and skills outputs, better landing heading in recovery, unit tests
  for the `math.ts` helpers, measuring the time-to-reach of today's driving as a baseline.

The general rules (DCO sign-off, checks before a PR) are in [CONTRIBUTING.md](../../CONTRIBUTING.md).

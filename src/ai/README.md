# src/ai — heuristic bot and team coordination

Pure TypeScript (no three, no DOM, runs in node). Reads a `SimStateView` (state buffer + ball
prediction, layout in `src/sim/types.ts`, uu) and writes `CarControls` for one car slot. Field
dimensions come from `src/sim/constants.ts` (`ARENA`, pads, kickoff spots); the numbers quoted below
are for our field (8800 x 11200, goal lines at y = +-5600, rounded corners of radius 1700).
The same brain drives the AI opponent, the player's teammates, or the player's car in a demo mode.

```ts
import { Bot } from './ai/Bot';
const bot = new Bot({ team: Team.Red, difficulty: 'hard', seed: 42 });
// every sim tick, before sim.setControls(aiCarId, controls):
bot.think(state, aiSlot, -1, controls);          // -1 = consider every other car in the state

import { BotTeam } from './ai/Team';
const red = new BotTeam({ team: Team.Red, difficulty: 'hard', seed: 42 });
red.setSlots([1, 3, 5]);                      // state-buffer slots of the team's cars (once)
// every sim tick:
red.think(state, outs);                       // outs[i] = controls for slots[i]
```

## Files

| File        | Contents |
|-------------|----------|
| `Bot.ts`    | `Bot` class (one car), `TeamContext`, difficulty table, tunables, pure helpers (`predictBallAt`, `firstReachable`, `steerToward`, `shotHitPoint`, `aimInAir`) |
| `Team.ts`   | `BotTeam`: ranks the teammates every tick, assigns roles / kickoff duties through `bot.teamCtx`, `TEAM_TUNING` |
| `math.ts`   | allocation-free `Float32Array(3)` vector helpers, the car driving model from RocketSim's constants (turn radius / curvature, ground acceleration, jump numbers), the `BotPhysics` profile (`STOCK_BOT_PHYSICS`), seeded `Rng` |
| `../../tests/bot.test.mjs` | node self-check of one bot with a fake state buffer (no wasm needed): `node --test tests/bot.test.mjs` |
| `../../tests/bot-team.test.mjs` | node self-check of `BotTeam` (roles, hysteresis, kickoff duties, lane / yield rules, 1-slot equivalence) |

## Public API

```ts
export type Difficulty = 'easy' | 'medium' | 'hard';
export type BotMode = 'kickoff' | 'attack' | 'defend' | 'support' | 'boost' | 'recover' | 'aerial';
export type BotRole = 'attacker' | 'support' | 'defender';
export type KickoffDuty = 'go' | 'cheat' | 'stay';

export class Bot {
  constructor(opts: { team: Team; difficulty?: Difficulty; seed?: number; physics?: BotPhysics });
  readonly physics: BotPhysics;  // STOCK_BOT_PHYSICS unless a preset gave another profile
  readonly team: Team;
  readonly difficulty: Difficulty;
  readonly role: BotRole;        // = teamCtx.role ('attacker' for a standalone bot)
  readonly teamCtx: TeamContext; // written by a BotTeam before every think(); defaults = 1v1 behaviour
  mode: BotMode;                 // current behaviour (debug/HUD)
  readonly target: Float32Array; // current driving target [x,y,z] (debug drawing)
  targetT: number;               // seconds until the targeted ball event, -1 if not time-bound
  setDifficulty(d: Difficulty): void;
  reset(): void;                 // forget transient state (optional, e.g. on kickoff reset)
  think(state: SimStateView, mySlot: number, opponentSlot: number, out: CarControls): void;
}

export class TeamContext {       // owned by the Bot, all vectors preallocated
  role: BotRole; kickoff: KickoffDuty;
  hasAttacker: boolean; attackerPos: Vec3; attackerBallDist: number; attackerBeaten: boolean;
  yield: boolean; yieldPos: Vec3;
  interceptFresh: boolean; interceptT: number; interceptPred: Float32Array /*6*/;
  reset(): void;
}

export class BotTeam {
  constructor(opts: { team: Team; difficulty: Difficulty; seed?: number; physics?: BotPhysics });
  readonly physics: BotPhysics;   // handed to every member bot and used for the intercept estimates
  readonly team: Team;
  readonly size: number;          // bots driven
  readonly passiveCount: number;  // passive members (the human teammate): ranked, never driven
  readonly memberCount: number;   // size + passiveCount; member indices: bots first, then passive
  readonly attackerIndex: number; // may be a passive member
  readonly inKickoff: boolean;
  setSlots(slots: readonly number[], passiveSlots?: readonly number[]): void; // allocates the member bots (seed + i * 7919); not per tick
  setDifficulty(d: Difficulty): void;
  reset(): void;
  think(state: SimStateView, outs: CarControls[]): void; // outs[i] for slots[i]; allocation-free
  slotAt(i): number; botAt(i): Bot; roleAt(i): BotRole; dutyAt(i): KickoffDuty; isPassive(i): boolean;
  stallTicksOf(i): number;        // ticks near a low ball without a touch (attacker stall, debug)
}

// pure helpers
predictBallAt(state, tSeconds, out: Float32Array /*6*/): Float32Array   // [x,y,z,vx,vy,vz]
firstReachable(state, carPos, carVel, carFwd, boost, out /*6*/, maxZ = 300, step = 2, phys = STOCK_BOT_PHYSICS): number // seconds or -1
steerToward(fwd, right, from, to, gain = TUNING.steerGain): number       // clamped steer
shotHitPoint(ballPos, goalTarget, outHit, outDir, offset = CONTACT_DIST + hitMargin): Vec3
aimInAir(fwd, right, up, angVel, dir, out: CarControls): void           // PD pitch/yaw/roll
neutralControls(out): void
export const DIFFICULTY_PARAMS, TUNING, CONTACT_DIST, TEAM_TUNING
```

`think` must be called **every tick** (the jump/dodge sequence and the air controller are
tick-level reflexes). Decisions are only refreshed every `thinkEvery` ticks per difficulty (and on
a role change); the driving outputs are held in between. `mySlot` is a state-buffer slot (not a
car id). The team is read from the car's `C_TEAM` field (falls back to the constructor team), so
one `Bot` can drive any car.

**Every car in the state is considered** (`state.numCars`, up to `MAX_CARS` = 8): the live
opponent nearest to the ball drives the decisions (shadowing, aim bias), the live opponent
nearest to us drives the bump avoidance, demolished cars (`C_IS_DEMOED`) are ignored. The
`opponentSlot` argument is kept for backward compatibility and is only used when the state reports
no cars at all (hand-built buffers); pass `-1`.

The bot's own `rng` is seeded (`seed`) so matches are reproducible for a given input sequence.

## Roles (2v2 / 3v3, `Team.ts`)

A `BotTeam` measures every live teammate each tick: `interceptT` = `firstReachable` (ground
intercept of the predicted ball; -1 = unreachable), `ballDist`, position. `score = interceptT`,
or `6 s + ballDist / 2300` when unreachable. The estimate is handed to the bot through
`teamCtx.interceptFresh / interceptT / interceptPred`, so a member does not recompute it on its
decision tick (a team of one produces bit-identical outputs to a standalone `Bot`, see the test).

| Role | Who | Behaviour |
|------|-----|-----------|
| **ATTACKER** | smallest score (hysteresis below) | the 1v1 decision tree unchanged: attack / defend-shadow / boost / aerial, dodges, clears |
| **SUPPORT** (2v2 / 3v3) | next best | mode `support`: sits `depth = clamp(ballToGoalDist * 0.45, 1800, 2400)` behind the ball on our side (never behind our goal line), offset `max(900, |ball.x| * 0.45)` uu to the ball's far side (toward the field centre, so a wall ball does not park it in the corner lane; with the ball on the centre line, away from the attacker), stops and faces the ball within 300 uu (`stopAtTarget` eases the throttle off, brakes on overshoot). With a defender on the team (3v3): when the ball is **deep** (within 2600 of our goal centre or 2200 of our goal line, corners included — the goalie's clearing zone) it waits at the **top of the box** on the far side, `(±1300, goalLine + 2800)`; otherwise its spot keeps 1400 uu from the goalie spot by sliding to the far-post side of it (forward if the wall is in the way). Gathers boost (`boost < 40`, nothing urgent, pad within a 2000 / 900 uu detour of the spot). Plays the ball only as a **rebound** (ball within 1100 uu, closing at > 200 uu/s, farther from the attacker than from us) or when the attacker is beaten and we intercept within 1 s; hard support may aerial only when the attacker is beaten. Mode switches into a rebound attack are immediate. |
| **DEFENDER** (3v3; also every further car) | the rest | mode `defend` in goalie form: `depth = clamp(ballToGoalDist * 0.25, 800, 1500)` in front of our goal line, `x = clamp(ball.x * 0.6, ±1100)`, stops and faces the ball within 250 uu. Comes out (the normal clear geometry) only when the ball is in our third (`ball.y * goalDir > extentY / 3`) **and** the attacker is beaten, or the ball is within 1800 of our goal, or within 900 of us. While the ball is far (> 4500 from our goal and not rolling at it) and `boost < 40` it grabs the back boost (pads scored with a 2800 big-pad bonus and a 6500 uu detour allowance, so a big pad in our side lane wins from the keeper spawn). |

An attacker that shadows (mode `defend` without a clear) with a defender behind it keeps its depth
at least `1500 + 1400` from the goal line, and waits at the top of the box on the ball's side when
the ball is deep, so it never sits on the goalie.

Attacker **hysteresis**: the challenger must be at least **15 % and 0.2 s** faster (both margins:
`score < holder * 0.85 && score < holder - 0.2`), and no switch happens within **30 ticks** of the
previous one. The same rule picks the support among the non-attackers (own timer). A demolished
or missing attacker is replaced immediately (its lockout does not apply); the respawned car then
has to beat the new holder like any challenger. Attacker **beaten** = no ground intercept, or the
nearest live opponent is within 0.85 × the attacker's ball distance.

Attacker **stall**: an attacker that has been within **450 uu** of a low ball (z < 300) for
**90 ticks** without touching it (`C_BALL_HIT_TICK` unchanged) hands the role to the fastest
other member regardless of the hysteresis (its own intercept estimate still looks best, which is
exactly why the hysteresis would keep it forever) and is **locked out** of the attacker role for
240 ticks or until it touches the ball. This is the team-level backstop of the Bot's own
near-ball rules (see "Driving through a slow ball"); without it a 3v3 could sit on a dead ball for
20 s with both attackers dithering beside it and everyone else holding position.

**Passive members** (`setSlots(slots, passiveSlots)`): the human on the bots' team is measured
and ranked like any member (intercept time, kickoff order, attacker stall, lane and yield rules
as a higher-ranked teammate) but no Bot is allocated for it and `think` never writes its
controls. So in 2v2 / 3v3 the bots take the roles and kickoff duties the human leaves: a human
on a wing spot makes the keeper-spot bot `stay`, a human on the ball makes its teammate
`support` (out of the human's lane, yielding next to it), and a human that dithers on the ball is
stalled out like a bot so the teammate goes. The red team has no passive member.

**Never double-commit**:

* a non-attacker's positioning / boost / goalie target is kept out of the attacker's **shot lane**
  (segment attacker → ball, extended 600 uu past the ball, half width 450): a target inside the
  lane is pushed sideways to the lane edge + 200 uu, on the side it (or the car) already is.
  `pickPad` never chooses a pad inside the lane, and a pad that ends up inside it (the lane moved)
  is given up for the role spot;
* if two teammates are within **400 uu**, the lower-ranked one **yields** (`teamCtx.yield`): full
  steer away from the teammate, brake (-0.5 above 300 uu/s, then -0.3 to back off) when it is
  ahead of us, 0.6 when it is behind, no boost. The attacker never yields, and neither does a car
  that is on the ball (a clear, or an attack within 1200 uu of the ball).

**Kickoff** (ball at the centre with zero velocity; duties decided once when it starts and held
until the ball moves, then the kicker keeps the attacker role through the normal hysteresis):

* the car **closest** to the ball goes (duty `go` = the 1v1 kickoff: boost whenever within 30°,
  front flip at `dist < 500 && speed > 1800`); ties within 2 uu (the mirrored wing or inside spawns) → the car
  with the **lower x** goes, for both teams (the "left goes" convention as specified; note that
  for blue, facing +y, the car on its own left is actually the +x wing — flip the comparison
  in `BotTeam.kickoffBefore` if the other convention is wanted);
* the next one **cheats** (`cheat`, role support): drives to `(±700, goalDir * 1300)` on the side
  away from the kicker and stops there facing the ball (normal boost rules, no kickoff flip);
* the farthest car **stays** (`stay`, role defender): holds its spawn facing the ball (throttle 0).
  With 3+ cars the farthest always stays; with 2 cars the second stays only when it is the
  keeper spawn (> `kickoffStayDist` ~4520 uu from the ball), otherwise it cheats. After the kickoff the
  defender's boost rule sends it to the back boost.

Roles / duties are written to `bot.teamCtx` before each `think`; a role or duty change forces a
decision on that tick and is an urgent mode switch (no `modeMinTicks` wait).

## Decision tree (`decide`, every `thinkEvery` ticks or on a role change)

```
read car / ball / every other car from the state buffer
interceptT, bp = teamCtx estimate if fresh, else firstReachable(ball prediction)

mode =
  ball at (0,0) with zero velocity                 -> KICKOFF  (duty go / cheat / stay)
  car airborne                                      -> RECOVER   (AERIAL keeps itself while airborne)
  role SUPPORT                                      -> rebound / step-up ATTACK, AERIAL (beaten attacker), BOOST, else SUPPORT
  role DEFENDER                                     -> AERIAL (save: fast ball at our goal, findAerial), BOOST (ball far, low boost), else DEFEND (goalie / clear)
  -- attacker / standalone --
  aerials & boost >= 25 & findAerial()              -> AERIAL   (medium and hard)
  threat && opponent closer                         -> DEFEND
  no intercept && ball on our half                  -> DEFEND
  ball on their half && opponent much closer (x0.5) -> DEFEND   (shadow, don't double-commit)
  already collecting a pad && boost < 60 && !urgent -> BOOST
  boost < 30 && !urgent && pickPad() found          -> BOOST
  otherwise                                         -> ATTACK

threat  = (ball on our half && ball moving toward our goal) || ball within 2200 of our goal
urgent  = threat || interceptT < 1.2 s || ball within 1500
```

Mode switches need `modeMinTicks` (20) in the current mode unless the switch is urgent
(kickoff / recover / aerial in or out, ball flying at our goal > 800 uu/s, pad gone, role change,
support rebound).

Targets per mode:

* **KICKOFF** – `go`: target = ball; boost whenever within 30° of it (all difficulties); front flip
  when `dist < 500 && speed > 1800` (or `dist < 300`). `cheat` / `stay`: see Roles.
* **ATTACK** – `goalTarget` = point in the opponent goal, x clamped to ±(goalHalfWidth - 200) = ±800, biased away
  from the nearest opponent. `shotDir = normalize(goalTarget - bp)`, `hit = bp - shotDir *
  (CONTACT_DIST + hitMargin)`. `approachTarget()`:
  * if the car is on the goal side of the ball (`along > goAroundEnter` and within
    `goAroundMaxDist`) → **go around**: target = `bp - shotDir*750 ± perp*700`, on the side the car
    already is, clamped to the drivable floor (see below). Hysteresis: leaves when `along <
    goAroundExit`, or when the (clamped) point has been reached (`goAroundReachDist` 200: in a
    corner the clamped point can sit inside the exit threshold, and a car parked on it would never
    leave the go-around). This is what keeps the bot from pushing the ball toward its own net.
  * else, **driving through a slow ball**: within `nearBallDist` (450) of a low ball (z < 300)
    whose ground speed is below `nearBallSpeed` (500) the target is the **ball itself**, `shotOn`
    regardless of alignment, no time bound, and the reverse rule is off (`nearBall`). The hit
    point is deliberately 25 uu short of contact; targeting it from close by with the reverse rule
    live parked the car beside a resting ball (reach the point, overshoot, reverse, line up,
    repeat), which is what the dead-ball deadlock was made of.
  * else target = `hit - shotDir * backoff`, `backoff = clamp(dist*0.4, 0, 800) * (1 - align)`, so a
    misaligned car first lines up behind the ball. `shotOn = align > 0.85`.
  * **near-ball stall** (any attack / clear, independent of the ball speed): `nearBallStallTicks`
    (60) ticks within `nearBallDist` of a low ball without this car touching it
    (`C_BALL_HIT_TICK` unchanged) switch the target to the ball as above until the next touch or
    until the car leaves the radius; the go-around keeps its priority.
  * high ball: `firstReachable` skips prediction entries with z > 300, so the chosen entry is the
    landing approach; `targetT` makes the driver coast instead of arriving early.
* **DEFEND** – `clear` when the ball is within 2600 of our goal, within 900 of us, or we intercept
  in < 1 s while it heads at our goal (defender role: see Roles): same approach geometry with
  `goalTarget` = nearest side wall, 3000 uu toward the opponent half (dodges allowed). A car
  within `clearGoAroundDist` (600) of the ball that is not at least `clearGoAroundAlong` (100 uu)
  behind it on the clear line goes around first (a contact from beside / the far side of the ball
  pushed it at our own net before the normal `goAroundEnter` threshold was crossed). Otherwise
  **shadow**: x = ball.x * 0.5 clamped ±900, y = `depth` in front of our goal line with `depth =
  clamp(ballToGoalDist * shadowFactor, 1000, shadowMax)` and always goal-side of the ball; within
  250 uu of the spot the car turns to face the ball (`holdPosition`). Defender role: goalie spot.
* **SUPPORT** – the support spot (Roles), `stopAtTarget`, `holdPosition` within 300 uu.
* **BOOST** – pad minimising `dCar + 0.7*detour - bigBonus` among active pads within 3500 uu whose
  detour relative to the straight path to the destination (ball intercept for the attacker, the
  role spot otherwise) is below the role's allowance (attacker 1500 big / 900 small). A pad that
  disappears sends the car back to its natural target.
* **RECOVER** – airborne without a plan: PD (`aimInAir`) levels the roof to +z and points the nose
  along the horizontal velocity, throttle 1, no boost.
* **AERIAL** (medium and hard) – `findAerial` scans prediction entries 0.3 s to `aerialMaxT` ahead
  with ball z between 350 and `aerialMaxZ`. The car does not aim at the ball's centre but
  `aerialHitOffset` (~140 uu) behind it on the **push direction**: toward the shot's aim point in the
  goal we attack, or for a save (ball on our half flying at our goal) up-field and out to the
  ball's side, so the nose sends the ball there. It checks the constant acceleration
  `a = 2|p - x - v0 t - ½ g t²| / t²` needed after the take-off (`v0 = v + up * (292 + jump hold)`;
  hard double-jumps for balls above 650 that are more than 0.4 s away: `2 * 292`) is below
  `aerialMaxAccel` (boost gives ~1060 in the air, the plan keeps a margin for the take-off), that
  the point is ahead (`aerialAheadCos`) and that the boost suffices. In flight the push point is
  recomputed every tick from `predictBallAt(tRemaining)` (the jumps not yet applied are still
  counted); jump is held 0.18 s (0.1 s, then a second press with the stick centred, for a double
  jump); boost whenever the nose is within ~37° of the aim; the last 0.15 s the nose turns to the
  push direction. Aborts to RECOVER when, after 0.3 s, the required acceleration exceeds 1250, or
  when the ball is reached (3D distance < 150). Measured (`tests/bot-sim.test.mjs`): a lob
  dropping from 900 uu is met at car z ~320–340 and sent toward the goal at ~1600–1900 uu/s.

Non-attackers run `avoidLane()` on their positioning / boost / goalie targets (Roles). Every raw
target is clamped to the drivable floor (`clampToField`): `|x| <= 4200`, `|y| <= 5430` and, in
the rounded corners, within `cornerClampRadius` (1350) of the corner centre `(±2700, ±3900)` (the
corner walls are a radius 1700 around it; the point is pulled back along the radius, i.e. the
wall normal) — without the corner clamp the go-around point behind a corner ball is inside the
wall. Target smoothing: `target = lerp(target, raw, 0.35)` unless the
mode changed or the raw target jumped more than 800 uu.

## Driving (`computeDriving`)

```
angle   = signed angle (rad) from car forward to the target, + = right    (+ steer noise)
reverse : dist < 600 && |angle| > 120°   -> throttle -1, steer = -k * wrap(angle - π)
          (inside a goal mouth: |angle| > 90° at any distance; never while on a wall)
else    : steer = clamp(k * angle), k = 3.5
          handbrake when |angle| > 60° && speed > 600 (throttle halved)
          coast (throttle 0) when targetT > 0.25 s and speed > 1.25 * dist/targetT (don't arrive early)
          stopAtTarget: throttle *= clamp((dist - 200) / 700, 0, 1), brake -0.4 when speed > 500 + 1.2*dist
          boost when useBoost && on ground && |angle| < 15° && dist > boostMinDist && speed < 2250
                && full throttle && !handbrake   (kickoff 'go': whenever |angle| < 30°)
holdPosition (goalie): steer to face the ball, throttle 0.4 only while > 20° off, brake if moving
yield (teamCtx.yield, every tick): see Roles
```

Inside a goal or at its posts (`|y| > 5380 && ((700 < |x| < 1500) || |y| > 5600)`, latched until
`|y| < 5180`) the target is replaced by the goal-mouth waypoint `(0, ±5180)` for every mode, so
the car drives out before chasing anything that would put the netting in front of it. Further
along the back wall (`|x| >= goalMouthXMax` = 1500) there is no netting: a corner ball used to
loop its attacker between the corner go-around point (behind the wall, see the clamp above) and
the goal-mouth waypoint for minutes (2v2: dead balls of 35-240 s).

## Stall / wall recovery (every tick, independent of `thinkEvery`)

* **Stall** (`detectStall`): throttle held (`|throttle| > 0.3`, or mode RECOVER) with
  `speed < 150` and `z < 80` for 30 consecutive ticks = nose wedged against a wall / the netting
  (full steer cannot yaw a car pressed into a wall). The unstick phase then takes over the outputs
  for 45 ticks: throttle `-sign(held)`, steer `-sign(held)` (reversing with mirrored steer swings the
  nose toward where it wanted to go), no boost / handbrake. The count deliberately ignores
  `isOnGround`, which flickers every few ticks for a car wedged nose-up on a goal post. Cleared on
  `reset()` and on KICKOFF / AERIAL.
* **Wall ride** (`wallRecovery`): RocketSim's `isOnGround` is "3+ wheels in contact" on any surface,
  so a car on a wall (`|up.z| < 0.6`) looks grounded but the 2D steering projections are degenerate
  (nose up/down the wall: `fwd_xy ≈ 0`; nose horizontal: `right_xy ≈ 0`) and the car creeps along
  the wall for 15–20 s. When the ball is not playable from there (3D distance > 700, or the car is
  above z 250 with the ball on the floor) the bot steers toward world down projected on the wall
  plane, `d = (0,0,-1) + up·up.z`, `steer = clamp(k·atan2(d·right, d·fwd))`, full throttle, no
  boost / handbrake / reverse / coasting. A car stalled on the wall (< 300 uu/s for 0.5 s, not
  climbing) hops off instead and RECOVER lands it. Measured: 15–20 s wall rides → 1.8 s, wall time
  in bot-vs-bot play 5.5 % → 1.9 %, stall ticks 17.9 k → 0.1 k over 28 five-minute matches.
* **Air stuck** (`airStuckControl`, the last reflex in `think`, whatever the mode): airborne (no
  wheel contact) but slower than `airStuckSpeed` (80 uu/s) for `airStuckTicks` (60) = balanced on
  the nose or roof against another car or a wall (two cars front-flipping into each other at a
  kickoff ended nose-up, leaning on each other, for 66 s: the jump sequence never ends because the
  car never lands, so no decision runs and the air PD only pushes a constant torque into the
  wedge). Rocks free in `airStuckPhase` (20) tick phases: roll +1, pitch -1 / yaw +1, roll -1,
  pitch +1 / yaw -1, boosting on the roll phases when there is boost (a nose-up car lifts off its
  wedge), throttle 1 so the wheels bite on contact.

## Jump / dodge sequence (`runJumpSeq`, every tick)

RocketSim registers a jump on the rising edge of `jump` (`jump && !lastControls.jump`) and a
dodge needs a second rising edge while airborne, so the sequence is:

```
jump  : jump = true for seqHold ticks (2 for a dodge, 8–20 for a single jump, 3 for a bump hop)
wait  : jump = false until the car is airborne (min 2 ticks, max 8)
flip  : jump = true, pitch = flipPitch (-1 = front flip), yaw = flipYaw (diagonal) for 1 tick
air   : jump = false; once the flip torque ends -> recover controller; back to none on landing
```

Triggers (`checkJumpTriggers`, only on the ground and only when no sequence is running):

* kickoff (`go` only): see above.
* **bump avoidance** (any mode but kickoff): the nearest live opponent within 650 uu, moving
  faster than 2000 uu/s and closing on us at > 1500 uu/s → a short hop (3-tick jump) over the demo.
* dodge into the ball: `shotOn && ball z < 200 && dist < clamp(280 + 0.08*speed, 300, 480) &&
  |angleToBall| < 15° && closing speed > 200`, with probability `dodgeProb` rolled once per approach.
* single jump: ball z in [150, 300], dist < 400, |angle| < 30°, probability `jumpProb`.
* none of the ball triggers in BOOST / SUPPORT modes or while holding a position.

While `C_IS_FLIPPING` the bot outputs zero pitch/yaw/roll (a same-sign pitch would cancel the flip).

## Difficulty table (`DIFFICULTY_PARAMS`)

| param         | easy | medium | hard | meaning |
|---------------|------|--------|------|---------|
| thinkEvery    | 8    | 6      | 2    | ticks between decisions (reaction delay 67 / 50 / 17 ms) |
| throttleMax   | 0.8  | 1      | 1    | |
| useBoost      | no   | yes    | yes  | boost outside kickoff |
| boostMinDist  | 2000 | 1500   | 900  | |
| dodgeProb     | 0.15 | 0.6    | 1    | chance to dodge into the ball when the shot is on |
| jumpProb      | 0.5  | 0.8    | 1    | chance to jump for a bouncing ball |
| aerials       | no   | yes    | yes  | also the defender's saves |
| aerialMaxT    | –    | 1.1    | 1.8  | s, longest flight it plans |
| aerialMaxAccel| –    | 780    | 900  | uu/s², constant acceleration a plan may need |
| aerialMaxZ    | –    | 950    | 2000 | highest ball it goes up for |
| aerialDoubleJump | – | no     | yes  | double jump for balls above 650 |
| aerialAheadCos| –    | 0.85   | 0.75 | how far ahead of the nose the aerial point must be |
| steerNoise    | 0.10 | 0.05   | 0    | rad, slow random walk on the steering angle |
| aimNoise      | 220  | 90     | 0    | uu, slow random walk on the hit point (wider misses) |
| shadowFactor / shadowMax | 0.3 / 2000 | 0.35 / 2000 | 0.5 / 3500 | how far up the field the shadow position sits |

## Tunables (`TUNING`, mutable at runtime)

`steerGain 3.5`, `handbrakeAngle 1.05 rad`, `handbrakeMinSpeed 600`, `reverseAngle 2.1 rad`,
`reverseMaxDist 600`, `boostAlignAngle 0.26 rad`, `boostMaxSpeed 2250`, `boostSeekBelow 30`,
`groundMaxBallZ 300`, `hitMargin 25`, `goalAimClampX 696`, `kickoffDodgeDist 500`,
`kickoffDodgeSpeed 1800`, `dodgeBaseDist 280`, `dodgeSpeedScale 0.08`, `dodgeMaxDist 480`,
`dodgeAlign 0.26`, `dodgeMaxBallZ 200`, `jumpMinBallZ 150`, `jumpMaxBallZ 300`, `jumpDist 400`,
`aerialMinBallZ 350`, `aerialMinT 0.3`, `aerialAbortAccel 1250` (after `aerialAbortAfter 0.3` s),
`aerialHitOffset ~138`, `aerialDoubleZ 650`, `aerialJumpHoldVel 220 / 140` (single / double),
`aerialHoldSingle 0.18`, `aerialHoldDouble 0.1`, `aerialStrikeT 0.15`, `shotAimAway 300`,
`aerialMinBoost 25`, `aerialCooldownTicks 90`, `modeMinTicks 20`,
`targetSmoothing 0.35`, `targetSnapDist 800`, `shadowMinDepth 1000`, `shadowXClamp 900`,
`airKp 3 / airKd 0.5` (pitch & yaw PD), `rollKp 3 / rollKd 0.25`, `dodgeWaitTicks 2`,
`dodgeWaitMax 8`, `goAroundEnter -60`, `goAroundExit -450`, `goAroundMaxDist 1600`,
`goAroundBack 750`, `goAroundSide 700`, `goAroundReachDist 200`, `nearBallDist 450`,
`nearBallSpeed 500`, `nearBallStallTicks 60`, `clearGoAroundAlong -100`, `clearGoAroundDist 600`,
`fieldClampX 4200`, `fieldClampY 5430`, `cornerClampRadius 1350`,
`stallSpeed 150`, `stallTicks 30`, `unstickTicks 45`, `stallMaxZ 80`, `goalMouthY 5380`,
`goalMouthX 700`, `goalMouthXMax 1500`, `goalMouthWaypointY 5180`, `wallUpZ 0.6`, `wallBallDist 700`, `wallHighZ 250`,
`wallBallLowZ 150`, `wallStallSpeed 300`, `wallStallTicks 60`, `wallJumpMaxVz 200`,
`airStuckSpeed 80`, `airStuckTicks 60`, `airStuckPhase 20`.

Team roles: `supportDepthFactor 0.45`, `supportDepthMin 1800`, `supportDepthMax 2400`,
`supportSide 900`, `supportSideFactor 0.45`, `supportHoldDist 300`, `supportReboundDist 1100`,
`supportBoostBelow 40`, `supportDefenderSep 1400`, `boxDeepGoalDist 2600`, `boxDeepY 2200`,
`boxX 1300`, `boxDepth 2800`, `playingBallDist 1200`, `defenderDepthFactor 0.25`,
`defenderDepthMin 800`, `defenderDepthMax 1500`, `defenderXFactor 0.6`, `defenderXClamp 1100`,
`defenderHoldDist 250`, `defenderComeOutY 1707`, `defenderComeOutGoalDist 1800`,
`defenderBoostBelow 40`, `defenderBoostBallDist 4500`, `kickoffCheatX 700`, `kickoffCheatY 1300`,
`kickoffCheatHold 350`, `arriveSlowDist 700`, `arriveStopDist 200`, `laneHalfWidth 450`,
`laneMargin 200`, `laneExtend 600`, `yieldBrakeSpeed 300`, `demoDodgeDist 650`, `demoDodgeSpeed
2000`, `demoDodgeClosing 1500`.

Measured (`BotTeam` vs `BotTeam`, real physics, 3-minute matches): 1v1 identical to before
(same goals / mode mix / stall rate as a standalone `Bot`); 2v2 hard: teammates within 400 uu of
each other 1.3–3.5 % of ticks, attacker role switches 3–8 per minute, stalls 2.2–4.6 % of car-ticks
(1v1: 3.7 %); 3v3 hard: 2–8 % close ticks (transits only, no parked pairs), 6–14 switches per
minute, stalls 2.4–3.4 %; the support and defender together take ~5 % of the touches.

`TEAM_TUNING` (Team.ts): `switchRatio 0.85`, `switchMargin 0.2 s`, `switchMinTicks 30`,
`unreachableBase 6 s`, `beatenRatio 0.85`, `yieldDist 400`, `kickoffTieEps 2`, `kickoffStayDist`
(midway between the keeper spot and the inside spots, 4523 on our field), `seedStride 7919`, `stallBallDist 450`, `stallTicks 90`, `stallLockoutTicks 240`.

Dead-ball check (`scripts/smoke-match.mjs`, run for 1v1 / 2v2 / 3v3 by `tests/bot-match.test.mjs`):
with the near-ball rules, the corner clamp / goal-mouth fix and the air-stuck reflex, 72
five-minute hard matches (12 seeds × 3 modes × both creation orders) have a worst dead ball of
6.1 s and no run above 10 s (before: 10 of 48 2v2 / 3v3 runs, worst 51 s); dead-ball time over
the 48 2v2 / 3v3 runs went from 321 s to 36 s, own goals from 7.3 % to 5.2 % of goals, and the
attacker's time within 450 uu of the ball with no touch in the last second over 100 s from
54 s / 32 s / 26 s (3v3 / 2v2 / 1v1) to about 16 s in every mode.

## Physics model used for estimates (`math.ts`)

* curvature vs speed (1/uu): 0.0069@0, 0.00398@500, 0.00235@1000, 0.001375@1500, 0.0011@1750,
  0.00088@2300 (piecewise linear) → `turnRadius(speed)`.
* throttle acceleration: 1600 uu/s² at rest, linearly down to 160 at 1400, 0 at 1410; boost adds
  991.7 (ground) / 1058.3 (air); 33.3 boost/s; max 2300.
* jump: +291.7 uu/s instantly, +1458 uu/s² while held (≤ 0.2 s); dodge impulse 500 uu/s.
* `firstReachable` integrates the straight-line reachable distance once per call (coarse, 2 ticks)
  and adds a turning penalty `angle * turnRadius(clamp(speed, 400, 1400))` (capped at 2500 uu).

### Physics profile (`BotPhysics`)

The numbers above that an experimental physics preset can change (gravity, first-jump impulse and
hold acceleration, the double-jump impulse, boost acceleration on the ground / in the air, boost
use per second, the top speed) are read from a `BotPhysics` profile instead of module constants:
the reach model (`firstReachable`, `groundAccel`, `straightDistance`), the aerial planner (gravity
term, jump velocities, the boost-needed sum) and the team score (`ballDist / maxBoostSpeed`). Every
`Bot` and `BotTeam` takes `physics` in its options and keeps it for its life. The default is
`STOCK_BOT_PHYSICS`, the old constants themselves, so stock bots compute bit-identical numbers (the
golden trace, `tests/stock-trace.test.mjs`, replays a 2-minute 3v3 hash for hash). A preset's
profile comes from `botPhysicsOf(values)` (`src/sim/mutators.ts`): doubles built from the preset's
integers, identical on every peer; the double jump keeps the constant, as in RocketSim. The ball
needs no profile: its trajectory comes from the wasm's prediction, which shares the preset. Not
adapted (yet): the TUNING heights (`groundMaxBallZ`, `jumpMinBallZ`, the aerial heights) and
`CONTACT_DIST` stay tuned for stock, so bots play worse under extreme presets but stay
deterministic and finite (`tests/mutators-extremes.test.mjs`). Same cost: a field read instead of a
constant.

## Cost

One `think` on a decision tick: ~720 prediction entries scanned twice (360 with `step = 2`), 34
pads, no allocations (all scratch vectors are `Float32Array(3)` fields). Well under 50 µs; the
non-decision ticks cost a few hundred ns (stall / wall checks are a handful of scalar ops).
`BotTeam.think` adds one `firstReachable` per live member per tick (the members reuse it on
their decision ticks), one pass over the other cars and an insertion sort of ≤ 8 indices; no
allocations after `setSlots`.

The prediction buffer is refreshed by the game every 4 ticks and its entries are anchored to the
refresh tick (`SimStateView.predTick`), so every lookup adds `tickCount - predTick` to its entry
index (`predAge`); without that offset 3 of every 4 decisions would read a 1–3 tick stale ball
(up to ~70 uu at shot speed).

## Known gaps

* No wall play (walls are only ever driven *off*), no flip resets, no demo hunting, no power-slide
  recoveries (RECOVER only levels the car). Aerials are planned with a constant acceleration and
  a margin: high, far balls (most of a 700 uu floater 1500 uu away) stay out of reach.
* The intercept model assumes the ball stops where predicted; no shot-power/direction solving
  beyond "aim through the ball toward a goal point".
* The defence shadow never anticipates bounces off the back wall.
* Team play: no passing plays, no explicit back-post rotation after a shot (the attacker only
  rotates when a teammate's intercept is clearly better), the lane rule only moves targets (a car
  already inside the lane just drives out of it). Crosses to a support waiting in front of the
  goal were tried and scored less (the ground touch cannot send a ball square accurately, and
  the receiver's role switch makes it chase the cross); so were a boost reserve for aerials, a
  far-post aim and a shorter go-around in the half we attack (`scripts/bot-bench.mjs`).

The plan to close these gaps (target architecture, constraints, phases with measurable targets) is
in [docs/bots/REWORK.md](../../docs/bots/REWORK.md).

## Measuring (`scripts/bot-skills.mjs`, `scripts/bot-bench.mjs`)

Both load the bots of the working tree (A) and of a git revision (B, `--baseline=origin/main` by
default) side by side (`scripts/bot-lib.mjs`), on the real physics, and accept
`--tuneA=key=value,...` / `--paramsA=hard.key=value,...` to try A variants without editing code.

`node scripts/bot-skills.mjs [--difficulty=medium,hard] [--only=shots,saves] [-v]`: fixed
scenarios per skill (shots, aerials, saves, approach, recovery, kickoffs A vs B), A and B side by
side. Under half a minute and free of match noise: the first check for any change.

`node scripts/bot-bench.mjs [--modes=1v1,2v2,3v3] [--matches=8] [--difficulty=hard]
[--json=out.json]`: headless 3-minute matches A vs B, A blue in even matches and red in odd ones.
Prints A's wins / draws / losses with its score, a 95 % interval and the Elo it implies, and per
match goals, own goals, touches, aerial touches, shots on target, passes, forward touches, how
long the ball is high and the think() cost per bot and tick. With 40 matches a mode equal bots
still land anywhere in about 35-65 %: compare variants on 40+ matches and trust only "A better" /
"A worse"; the scenario tests (`tests/bot-sim.test.mjs`) pin individual skills.

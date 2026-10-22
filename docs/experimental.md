# Experimental features

Experimental features are things we are still testing. They are only for **signed-in players**,
and they may change or go away. Nothing you do with them counts: no rank, no stats, no records.

## Turning them on

1. Sign in with the account button at the top of the menu, or create an account there.
2. Open **Settings > Experimental**. Guests see this tab as "Experimental 🔒" with one line about
   signing in, and nothing else.
3. Turn on **Experimental features**.

The switch is saved on your account, so it follows you to other devices, and on this device for when
you are offline. If you turn it off, sign out, or sign in with an account that has it off, every
feature below goes away at once, and a saved Super low pick becomes Performance from the next start.
If you picked Super low in Settings > Graphics, turning the switch off asks for a second press,
because the game then restarts on Performance.

## What it unlocks

- **Super low graphics** in Settings > Graphics: about 640x360, 30 frames per second, a simpler
  stadium. It is for TVs and very old devices. Guests and players with the switch off see only
  Performance, High and Ultra. A device that needs Super low still starts on it by itself: a TV
  with a slow graphics chip, a 1 GB device, or after a graphics failure.
- **Experimental free play** (Training): free play with the physics of a preset. Pick the preset on
  the training screen, or change it during play with **RULES** in the pause menu (the new rules
  apply when you go back to the pause menu). It saves no records.
- **Experimental rules in custom lobbies**: the host of a P2P lobby picks the lobby's rules in
  **Rules (experimental)**. Details below.

## Presets

A preset is a named set of physics values. You get five built-in presets, which you cannot edit:

| Preset | What it changes |
|---|---|
| Standard | Nothing: the normal game |
| Low gravity | Gravity 50%, air drag on the ball 50% |
| Fast ball | Ball top speed 281 km/h, hit strength 150%, ball weight 80% |
| Bouncy | Gravity 80%, ball bounce 150%, ball weight 70% |
| Arcade | Car top speed 94 km/h, boost power 130%, endless boost, full boost at kickoff, unlimited flips, bump strength 150% |

To make your own, open Settings > Experimental and press **New** (a copy of Standard) or
**Duplicate** (a copy of the preset on screen). You can have up to **10** presets. They are saved on
your account, with a copy on the device: an edit made offline is uploaded when you are back online.
Deleting a preset needs a connection.

Every value has a fixed list of steps. You cannot type a number, so a preset can never hold a value
outside the safe range. Each row shows its standard value under its name. The **Del** key puts the
focused value back to standard, and **Reset to standard** in the footer (it asks for a second press)
puts every value back. Edits save by themselves. The editor works with a mouse, the keyboard, a controller or touch, in
English and Spanish.

## The values

Speeds are in km/h, like the speedometer. Everything else is a percentage of the standard value,
seconds, or an option.

| Value | Range (step) | Standard | What it does |
|---|---|---|---|
| Gravity | 30-200% (10) | 100% | How hard everything falls. Low gravity gives long, floaty jumps and high balls. |
| Game speed | 25-100% (5) | 100% | **Free play only.** Slows the whole game down, to practise a move. |
| Ball top speed | 108-281 km/h (about 11 km/h) | 216 km/h | The fastest the ball can go. |
| Hit strength | 50-200% (10) | 100% | How hard a car's hit sends the ball. The ball top speed still caps it. |
| Ball weight | 50-200% (10) | 100% | A heavy ball moves less when a car hits it. |
| Ball bounce | 50-150% (10) | 100% | How much speed the ball keeps when it bounces off the floor and walls. It never gains speed from a bounce. |
| Air drag (ball) | 0-300% (25) | 100% | How quickly the ball slows down in the air. |
| Car top speed | 72-94 km/h (about 2 km/h) | 83 km/h | The fastest a car can drive or fly. Supersonic starts at the same share of it. |
| Boost power | 50-200% (10) | 100% | How strongly boost pushes the car, on the ground and in the air. |
| Boost use | 0-200% (25) | 100% | How fast boost runs out. 0% is "Endless". |
| Boost at kickoff | 0, 33, 50, 75, 100 | 33 | Boost each car has at kickoff and after a respawn. |
| Jump power | 50-150% (10) | 100% | The first jump's strength. The second jump does not change. |
| Unlimited flips | on / off | off | After a jump, flip as many times as you like until the double-jump window closes (about 1.25 s). |
| Unlimited double jumps | on / off | off | After a jump, jump again in the air as many times as you like in that same window. |
| Bump strength | 0-300% (25) | 100% | How hard cars push each other. The car top speed still caps it. |
| Demolitions | Normal, On contact, Off | Normal | Normal demolishes a car hit at supersonic speed. On contact demolishes on any touch. Off never demolishes. |
| Respawn time | 1-5 s | 3 s | How long a demolished car waits before it comes back. |

The ranges keep the game working. The ball never moves fast enough to pass through a goal or a
wall, a bounce never gains energy, and gravity always pulls down. The game checks every value three
times: the menus offer only the steps, the server checks lobby rules, and the physics engine refuses
any value outside its own limits. The game cannot crash, even when a modified page sends the values.

## Experimental lobbies

- **Who can play.** Only signed-in players can play in a lobby with experimental rules. Guests see
  the lobby in the list as "🔒 EXP" but cannot join it. A host can only pick rules while every
  member of the lobby is signed in. Other members do not need the switch on.
- **Where.** Experimental rules work only with the **P2P** connection. If the host switches the
  lobby to Server, the rules are cleared. A match needs at least two players. If the players cannot
  connect, everyone goes back to the lobby: an experimental match never moves to a game server.
- **What everyone sees.** The lobby list tags the lobby **EXP**. Before the match, every member sees
  the line "Experimental rules: Moon ball · Gravity 40% · …". During the match, Settings >
  Experimental shows the same line instead of the editor.
- **Same rules for everyone.** Every player's game, and the bots, use the same rules. Before the
  kickoff, the server checks that each game really runs those rules. A game that runs other physics
  (an old or modified page) is told to reload, and a bot takes over that car.

## Experimental matches count for nothing

Every ranked or counted match uses the **standard physics**. This includes Casual (P2P and
server), Competitive, server matches, matches on community servers, training packs and offline
matches against the bots. A match or free play with experimental rules gives:

- no rank or rating change, and no placement game;
- no stats and no leaderboard entry;
- no training record;
- no penalty for leaving or for not showing up;
- never a match on a community server.

The server enforces this: the queues, server matches, community servers and every report that
rates or records something refuse anything that carries experimental rules.

## For developers

### What it costs

The physics engine already reads all of these values on every tick, so a preset adds no work per
tick. To compare a preset with the standard physics, run:

```sh
node scripts/bot-bench.mjs --preset=builtins,extremes --modes=3v3 --matches=4 --seconds=120
node scripts/bot-bench.mjs --preset=arcade --predEvery=1   # predicts the ball every tick, like P2P
node scripts/bot-bench.mjs --preset=gravity=50,ballDrag=50 # your own values
```

`builtins` runs the four built-ins that change something, and `extremes` runs every value at its
minimum and then at its maximum. The bench plays the same seeded bot matches with stock physics and
with each preset. For each run it prints the cost of the physics step, the bots, the ball
prediction, and a whole tick. If a preset ever makes the ball prediction as costly as a full
720-tick prediction, the bench prints "!!" and exits with 1, because that means the predictor runs
different physics from the match.

On a 16-thread desktop (node 24, 3v3, hard bots, 4 matches of 120 s per preset), no preset costs
more per tick than stock:

| Preset | Whole tick, prediction every 4 ticks | Whole tick, every tick (P2P) |
|---|---|---|
| stock | 81 µs | 85 µs |
| Low gravity | 71 µs (-13%) | 78 µs (-8%) |
| Fast ball | 75 µs (-8%) | 81 µs (-5%) |
| Bouncy | 71 µs (-13%) | 70 µs (-18%) |
| Arcade | 65 µs (-20%) | 70 µs (-18%) |
| every minimum | 70 µs (-14%) | 72 µs (-16%) |
| every maximum | 72 µs (-12%) | 75 µs (-12%) |

The bots cost a little less under most presets, because they find fewer reachable touches. Run it
on the slowest device you care about, such as a Mali-G31 TV box, for numbers that matter there.

### Where the code is

- The value table, the parsers and the built-ins are in `src/game/physicsRules.ts`.
- The mapping to the physics engine is in `src/sim/mutators.ts`; the engine side is in
  `native/README.md` ("Physics mutators").
- The account store is `src/game/experimentalStore.ts`, the editor is
  `src/render/experimentalPage.ts`, and the texts are in `src/render/rulesText.ts`.
- Free play is `src/game/experimentalTraining.ts`.
- On the server, the lobby, matchmaker and room checks are in `server/src/LobbyDO.ts`,
  `MatchmakerDO.ts` and `RoomDO.ts`.
- `ARCHITECTURE.md` has the details.

### Deploying this feature

The branch changes code that community servers run, so a deploy needs these steps in order:

1. **Merge to main.** Merge `feat/visual-rework` (Super low) into `main` first, then this branch.
   A community-server release must be built from a commit in main's history.
2. **A signed community-server release.** The physics engine (`src/sim/wasm/rocketsim.wasm`), its
   bridge and the bots changed, and community servers bundle all three. Steps:
   - bump the version in `nodes/package.json` and `nodes/node/version.ts` (0.2.0 to 0.3.0);
   - push the tag `node-v0.3.0` from main;
   - the owner approves the two GitHub environments of the release workflow: `releases` (signing)
     and `releases-r2` (upload).

   Without that release, `npm run deploy` stops at its node-release gate
   (`scripts/node-release-gate.mjs`). With it, the gate moves the release channel to 0.3.0 before
   the deploy, and every community server updates. Community servers on an older release get no
   matches from the new build: the engine's hash (`CLIENT_BUILD.wasmSha256` in
   `server/src/nodeApi.ts`) changed.
3. **The owner's approval of the deploy.** `npm run deploy` runs from a clean tree at `origin/main`.
   Nothing else is needed on Cloudflare:
   - the account database creates its two new tables (`experimental`, `presets`) by itself on
     first use;
   - there are no new Durable Object classes, bindings or secrets.
4. **Protocol versions.**
   - The P2P protocol goes from 4 to 5 (`P2P_PROTOCOL_VERSION`, `ROOM_PROTOCOL`).
   - The server-match protocol stays at 3, because a recorded trace shows the standard physics did
     not change by one bit (`tests/stock-trace.test.mjs`).
5. **Stale pages.** A page loaded before the deploy is told to reload when it joins the P2P queue
   (426 `reload_required`) or a P2P room. If an old page joins an experimental lobby, it fails at
   the room's welcome and the others start with a bot in its slot. Server matches, ranked and
   community servers keep working for old pages until they reload.

What only a person can check: a real gamepad and TV keyboard in the editor, a real touch screen, and
`bot-bench --preset` plus `#diag` on the Mali-G31 TV box with the extreme presets.

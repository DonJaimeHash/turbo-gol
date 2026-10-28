# Changelog

All notable changes to Turbogol are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Playing with your fingers: BOOST shows how much boost you have, with a level that fills the
  button, and the boost bar under the score is gone. CAM moved down into your right thumb's reach,
  next to JUMP and DRIFT (RESET sits above it in training), PAUSE is alone in the top right
  corner, and DRIFT is no longer blue. The stick, JUMP and BOOST stay exactly where they were.
- On a touch screen, tap the score to see both teams; tap it again (or the board) to close it.
- Your first match on a phone or tablet starts with three short cards: how to drive, JUMP and
  BOOST, and CAM and PAUSE. A tap on each one moves on; against the AI the match waits for you,
  and the game remembers you have seen them.
- The pause on a touch screen is laid out for two thumbs: RESUME is a big button right where BOOST
  was, so the thumb that paused resumes without moving, and SETTINGS and QUIT are under your left
  thumb. Hold QUIT for a second (the ring fills) to leave; a tap anywhere else does nothing.
- A setting for touch players, in Settings › Gameplay: keep JUMP held when you slide your thumb from
  JUMP to BOOST, for full-height aerials with one thumb (off by default).
- Online, turning your phone upright no longer hides the match: the notice "The match goes on: turn
  your phone" lets you see the game and the score behind it.
- A final screen two seconds after the whistle: VICTORY, DEFEAT or DRAW, the score, every player
  by team with their goals (YOU and the MVP marked), and in Competitive your rank card with the MMR
  you won or lost and what the next tier still takes (it replaces the result window). PLAY AGAIN
  is one press: the same queue again, a new match against the AI, or back to your lobby. CHANGE
  MODE and MENU are next to it, and Back is MENU.
- MATCH FOUND: when a search finds a match, a band says so over whatever screen you are on, with a
  short sound and the browser tab's title, then the match starts.
- When a Competitive match is cancelled because a player did not show up, you go straight back
  into the queue ("A player didn't show up · back in the queue").
- The goal banner says GOOOAL! (¡GOOOL! in Spanish) on the scoring team's colour, with who scored
  and the score under it. Players joining or leaving, a bot taking over and your demolitions
  (DEMOLISHED · 2) are small notes at the top instead of the middle of the screen, and OVERTIME
  shows over the kickoff countdown.
- Online, the scorebug shows the connection's bars next to the clock.
- PLAY opens on a new home screen. Its big PLAY NOW tile plays the queue you searched last in one
  press (Casual 2v2 the first time), and the four modes are one step away: CASUAL, WITH FRIENDS, VS
  AI and COMPETITIVE (a guest sees "Sign in" on its lock). The big tile follows what you are doing:
  RELOAD NOW when a new version is out, BACK TO THE LOBBY, SEARCHING with its clock and ✕ CANCEL,
  and VS AI when the game cannot reach the server. Above it, your name and rank (to PROFILE) and
  your car (to GARAGE). It is laid out for each screen: the big tile on the left on a computer and a
  TV, on the right under your thumb on a phone held sideways, on top on a phone held upright, and
  nothing scrolls but on a small upright phone. On a TV the tile shows the whole queue you search
  (on two lines when it needs them, ✕ CANCEL then keeping just its ✕), and the region stays in its
  pill by your name.
- The home screen's four modes open one MODES screen, with a tab for each: CASUAL, COMPETITIVE,
  LOBBIES and VS AI (Q / E on the keyboard, the bumpers or the triggers on a controller switch them).
  Pick a format, 1v1, 2v2, 3v3 or ANY (whichever fills first), and the search starts; FIND MATCH
  is ready under your thumb, so from the home screen a Casual match of your format is two presses
  away. Picking another format while you search restarts the search. Region and, under Advanced,
  the connection (Auto, P2P or Server) are rows of their own.
- While you search, the panel shows the clock, the queue, where you are looking, and when bots
  will join if nobody comes (only when that is how your search works: Competitive never adds
  bots), with CANCEL SEARCH (X on the keyboard, Y on a controller). "While you wait: Free play"
  drives the ball around with the search still on; when a match is found, free play ends and the
  match starts. Leaving free play brings you back to the search.
- COMPETITIVE for a guest is one SIGN IN button: once you sign in you are back on COMPETITIVE,
  ready to search. A locked Competitive says why and for how long, with PLAY CASUAL next to it.
- VS AI has its mode and difficulty side by side and a Stadium row that takes you to the
  stadiums.
- A TV without a controller says so on the PLAY NOW tile, and starting a match asks you to connect
  one (CONTINUE ANYWAY plays with the remote). The window closes by itself as soon as a controller
  connects, and that first press starts nothing: press A again to play.
- The first time you start a match on a computer, the game asks how you will play: mouse and
  keyboard, keyboard only (Space jumps, Shift boosts) or a controller. It asks once, never if you
  already changed your keys, saw the controls card or pressed with a controller. With the keyboard
  only, the match no longer asks you to click to capture the mouse.
- Hold a direction on a controller (the D-pad or the left stick) to walk through the menus: after a
  short pause the focus keeps moving, and it stops at the end of the list instead of jumping
  somewhere else; press again to go on. Past the top of a screen you reach the region and account
  buttons in the top bar, past the bottom the search's CANCEL and the links at the foot of the
  page, which a controller could not reach before. In Settings, holding ◀ or ▶ on a slider (field
  of view, sensitivity, volume) keeps sliding it, and holding ↑ or ↓ stops at the last row instead
  of starting over at the top. A direction you were already holding when the menus, the pause or
  Settings came up moves nothing until you press it again.
- Controller shortcuts in the menus: Start opens Settings and Y cancels the search you are in (X on
  the keyboard). The bumpers and the triggers switch the tabs of Settings, the triggers (and Q / E
  on the keyboard) those of the leaderboard and of the sign-in screen; during a match none of them
  does anything new.
- `#widetext` (for contributors): the whole interface in plain Arial, about as wide as Android's
  Roboto, to see on a desktop which label would not fit without the condensed font. Labels that
  would not fit shrink a little, then take a shorter name (TRAIN, RANKS), and `node
  scripts/ui-fit.mjs` checks every menu screen at six sizes with it, in English and Spanish and
  with the hints of every controller, keyboard and remote (a CI job, for information); `--face
  Verdana` runs the same check with a face wider than Arial.
- GARAGE has its place in the menus already, with a "coming soon" panel until the cars arrive.
- A controls card for new players: during the kickoff countdown of your first three matches, and
  at the start of free play, a card in the bottom right corner shows how to drive, steer, jump,
  boost and switch to the ball camera, with your own keys or buttons (keyboard and mouse, or the
  controller when one is connected; change a binding and the card follows). When the match starts
  it shrinks to a slim line in the corner for a minute of play. On a touch screen there is no card:
  the buttons on the screen already say what they do (matches played that way do not count, so a
  controller connected later still gets its three).
- Experimental rules in custom lobbies, for signed-in players with Settings > Experimental on: the
  host of a P2P lobby picks Standard, a built-in preset (Low gravity, Fast ball, Bouncy, Arcade)
  or one of their own in "Rules (experimental)", with a button to edit the presets. The lobby list
  tags such a lobby EXP (with a lock for guests, who cannot join it) and every member sees the
  rules before the match ("Experimental rules: Low gravity · Gravity 50% · Air drag (ball) 50%"),
  and during it in Settings > Experimental, in place of the editor.
  Every player's game applies the same rules (the bots too) and the server checks that it did
  before the match starts; a player whose game runs other physics is told to reload and the bots
  take over that car. These matches count for nothing: no rank, no stats, no records, no penalty
  for not showing up, never on a community node and never moved to a server match. Casual,
  Competitive, server and node matches keep the standard physics, bit for bit. Pages from before
  this version are asked to reload (P2P protocol 5).
- The physics core of the experimental presets: the physics library can run a match with other
  gravity, ball speed, hit strength, ball weight, bounce and air drag, car top speed, boost power
  and use, kickoff boost, jump power, unlimited flips or double jumps, bump strength, demolitions
  and respawn time, every value on a fixed grid and checked against hard limits so the game cannot
  break. It costs nothing per tick (`node scripts/bot-bench.mjs --preset=<id>` compares any preset
  with the standard physics), the ball prediction and the bots follow the rules, and a recorded
  trace proves the standard physics did not change by a single bit. Every match, server, community
  node and training pack still runs the standard physics.
- `docs/experimental.md`: what Settings > Experimental unlocks, every physics value with its range,
  why experimental matches count for nothing, how to measure what a preset costs, and what
  deploying it needs.
- A fourth graphics quality, Super low ("Súper bajo"), for TVs, set-top boxes and very old
  devices: about 640x360 upscaled by the screen, 30 frames per second, no edge smoothing, a
  simple sky instead of the harbour, canyon or valley behind the stadium, a painted crowd, simpler
  cars and ball, fewer particles, a lighter menu and HUD, and no reverb. It starts by itself on a
  device with 1 GB of memory or on a TV with a slow graphics chip (a 1 GB Android TV ran the game
  at 1 to 3 frames per second), unless the player picked a quality, and on a device where
  Performance failed. Picking it, or leaving it, restarts the game (during an online match, once
  the player leaves the match); `#superlow` at the end of the address tries it without saving it.
- Settings > Experimental, for signed-in players: one switch for features being tested. While it
  is on, Super low can be picked in Settings > Graphics (guests and players with the switch off see
  Performance, High and Ultra; a device that needs Super low still starts on it by itself, and a
  saved Super low pick of a player who signs out or turns the switch off becomes Performance from
  the next start). The account keeps the switch and up to 10 physics presets (values on a fixed
  grid with safe limits, five read-only built-ins), with a copy on the device that syncs when the
  connection is back. The same tab edits them: pick a preset (built-ins can be duplicated, not
  changed), New, Duplicate, Rename, Delete, and step each value on its grid next to its standard
  value, with a one-line summary of the changes and Reset to standard; it works with mouse,
  keyboard, controller and touch, in English and Spanish, and every edit saves by itself.
- Experimental free play, in Training for signed-in players with experimental features on: free
  play with the physics of a preset (picked on the training screen, or in the pause menu's RULES,
  applied when that screen closes), including a slower game speed. It saves no records; training
  packs, ranked, casual and P2P matches keep the standard physics.
- `#diag` shows why the game runs its quality, the frame rate and the time each part of a frame
  takes, and has a button that loses the graphics device to test the recovery; new address flags
  help measure a slow device (`#pr=`, `#hide=`, `#nopost`, `#norender`, `#diag=audit`, `#tv` for
  testing on a computer).
- Community nodes are on: server, Competitive and lone-player matches in South America can be
  hosted on the project's São Paulo node, `sao-paulo-1`, and fall back to the game's own servers
  whenever it is full, away or unreachable.
- Training records follow the account: a signed-in player's best run per pack is saved on the
  server and shows on every device; a guest's stay in the browser and move into the account at the
  first sign-in.
- Demolished cars explode: a fireball with flames, team-coloured sparks, falling embers, a ground
  shockwave and a flash, with its own explosion sound (quieter far from the camera). Every car,
  in every kind of match.
- Community nodes (`nodes/`, a prototype not wired into the game yet): match servers run by the
  community on a VPS or a home PC (WebSocket or WebRTC), a control plane that places matches on them
  and re-simulates the replays before any rating is written (every ranked match; casual matches by
  sample), host rewards (points for cosmetic items), a signed self-updating launcher and installers.
  Its tests and typecheck run in CI. Design notes in Spanish under `nodes/docs/`.
- Community nodes: the control plane keeps its state through a restart. Registered nodes, tokens
  and running matches are written to a store before anything that depends on them goes out, and
  after a deploy the nodes get 90 seconds to reconnect, so a match played through a deploy is still
  rated. A project node keeps its matches through a control link drop of under a minute; hosts are
  checked again every five minutes and one that stops answering gets no matches; in a ranked match
  on a project node, a player with no connection at the final whistle is rated as a leaver, as on
  the game's own servers. One token registers one node, a forged replay upload is refused before
  its body is read, and every token or node of a trusted operator logs an ALERT line.
- The game is ready for matches hosted on a community node: after a Competitive match there, the
  menu says the result is being verified and waits up to two minutes for it (the node's replay is
  checked first), and a match that fails the check shows as not counted. The network panel names
  the node that hosts the match, and quitting such a match still works when the account's session
  would run out during it (it is renewed as the match starts, and once more if the quit is refused).
  A result that comes in while the player is already in another match shows once the menu is back.
- Community nodes: the control plane runs in the Worker (`NodeRegistryDO`, its state in SQLite) and
  `/nodes/*` serves the nodes and their installers (releases from R2, registration, the control
  socket, replay uploads). Only the project's accounts create node tokens, two nodes each at most.
  A `nodes_on` KV flag (off, `1`, or a canary list of account ids; `vm_disabled` wins) turns the
  nodes on. A deploy now needs the two node R2 buckets; set the node secrets with
  `wrangler versions secret put`. The wasm's SHA-256 is committed next to it
  (`npm run build:wasm` rewrites it, a test checks it).
- Community nodes host matches: with `nodes_on` set for every player of a match, a server or
  Competitive match (and the lone player of a P2P queue) goes to a community node when one is free,
  and to the game's own servers otherwise, never failing because of the nodes. Node matches do not
  count toward the 20-match cap, and rejoining and quitting work for them; a quit the node never
  got keeps the player in that match instead of letting them start another in that region.
  Without the flag nothing changes.
- Community nodes: the control plane's ALERT lines also go to a staff-only Discord channel
  (`NODE_ALERT_WEBHOOK`, each alert at most once in 10 minutes, every account's action each
  time), with new ones for a project node offline for 2 minutes, a node's traffic at 80 % of its
  cap, tick lag, and a verification or an update waiting too long. Maintainers get
  `/nodes/admin/*` (list the nodes, change a status, drain, push the channel, probe again), each
  action an ALERT, and a cron checks the project nodes' `/healthz` every 5 minutes, which catches
  an expired certificate. The KV switches, `vm_disabled` included, stay manual.
- `#diag` at the end of the address shows a small panel with the graphics backend, the GPU, its
  extensions and limits, the quality, the stadium and any shader or GPU error, to send a
  screenshot when the game draws wrongly on a device (nothing is sent anywhere). `#lowgpu` makes a
  desktop browser behave like a low-end phone's GPU, for testing.
- A link to the official Discord server in the menu footer, the READMEs, CONTRIBUTING.md and the
  new-issue page.
- Settings has an Audio tab with a master volume (saved with the other settings), and the pause
  menu opens Settings in the middle of a match or training.

### Fixed
- When a new version of the game is out and yours is too old to play online, a window says so and
  offers RELOAD NOW (selected), instead of a message that vanished after four seconds; if you say
  NOT NOW, an "UPDATE TO PLAY" pill stays in the top bar until you reload.
- Leaving Settings with Esc no longer also goes back a screen in the menus behind it.
- Super low ("Súper bajo"): the focused button of the pause menu, Settings and the training pack
  summary was hard to see from the couch; it has the same ring as everywhere else. The match HUD
  keeps a one-pixel shadow under its text (BOOST, the clock, the countdown read over a bright pitch;
  the BOOST label is white), every panel is opaque, the menus are drawn on a solid dark page instead
  of over the stadium (lighter for the TV), and menu transitions are off.
- The fps / draw-call readout no longer shows in the top right corner of every match: only F3 (or
  `#stats`) turns it on, as intended.
- The BLU tag of the scoreboard is readable: dark text on the team blue (it was white on a light
  blue, under the contrast minimum).
- The menus remember where you were: going back to a screen (Esc, B, Back), or closing a dialog
  such as the language list, puts the focus back on the tile or button you left from instead of
  the first one. A list that refreshes under the focus (lobbies, the leaderboard's tabs, the
  training packs) keeps your place.
- Text fields no longer trap the arrows or a TV remote: a field reached with the arrows lets you
  move on past it (on Custom lobbies, JOIN and REFRESH can now be reached with a remote); press OK,
  Enter or A, or just type, to edit it, and Enter, Esc / B or ↑ / ↓ to stop editing (a field being
  edited shows a lime line under it). Esc while typing no longer also leaves the screen.
- In the menus the arrow back retraces your steps: ↓ then ↑ comes back to the card you came from.
- On a phone, a quick double tap no longer presses a button on the next screen, and a dialog that
  appears under your finger ignores that touch. While a dialog is open nothing behind it can be
  focused or pressed.
- An arrow with nowhere to go nudges the focused button a little that way, so you can tell the
  press arrived (in Super low too, as on a TV; not with reduced motion). The focus outline of the
  last button of a long screen is no longer cut off at the bottom edge.
- In the pause menu, B on a controller and Backspace no longer throw you out of the match (online
  and in Competitive too, where leaving counts as an abandon): like Esc and Start, they go back to
  the match. Only the QUIT button leaves, and online it still asks a second time. Inside the pause
  menu's settings, B and Esc go back to the pause menu.
- Back no longer takes you out of the game: the back gesture or button on Android, BACK on an
  Android TV remote, the browser's back button, Alt + ← and a mouse's back button now go back one
  screen in the menus, close a dialog, or pause a match (never leave it). On the home screen Back
  asks "Leave Turbogol?" first; pressing Back again there leaves. Address flags such as `#diag`
  stay in the address. If something still takes the page away during a match (two quick Backs in
  the browser's toolbar, closing the tab, reloading), the browser asks before leaving.
- On Super low a quick press of a controller button in the menus or the pause menu (shorter than
  one frame) could be lost. They now read the controller on every screen refresh, whatever the
  stadium's frame rate, online matches included.
- In about half of the peer-to-peer matches every player's game dealt its own kickoff positions
  (the room's random seed, read as a negative number, meant "pick at random"): the games went out
  of sync at the start and after every goal, and only caught up by copying another player's state
  a moment later. Every player now deals the same kickoff from the room's seed.
- Browsers on the WebGL2 fallback compile about half as many shaders while loading and after a
  quality change (each shader was compiled twice, once for nothing), so they reach the menu sooner.
- A device that cannot draw into floating-point images on WebGL2 starts on Super low instead of
  drawing a black world; `#lowgpu` no longer turns the 3D scene black on such a device.
- A quality the device fell back to, or one the address forced, is no longer saved over the
  player's own choice.
- When the graphics device is lost again and again (a TV short of memory), the game reloads once,
  then once more on Super low, then stops with a message instead of reloading forever.
- On a device far too slow for its quality (under 10 frames per second) the resolution now goes
  down instead of staying at full size.
- `#hide=stadium-netting` (and any address containing "net") no longer opens the network panel.
- Community nodes: a control link that stalls no longer costs a node its matches. A node without
  heartbeats for 15 seconds still gets no new match, but its link stays open for 30, so heartbeats
  held on the way (24 seconds of them on the São Paulo node on 2026-10-21) bring it straight back.
  Every node, a community one too, keeps a running match through a minute without heartbeats in
  all, as a project node already did: players on a community node that really dies stay in its
  match for up to about a minute instead of 15-20 seconds. A link closed for silence is logged
  with how long the node was silent, and messages that still arrive on a closed link are counted
  in the log.
- Community nodes: the VPS installer keeps the name given with `--name`; it registered nodes under
  the Linux distribution's name, read from `/etc/os-release`.
- The anti-bot check (Turnstile) had no place to render in the new menus, so a first visit could
  not create a guest or an account while the check is on; it now shows above every menu, one
  challenge at a time, and closes when the menus close into a match.
- Browsing the public lobby list no longer registers a guest.
- Third-party notices point to the script that applies the physics-library patches.
- High and Ultra work on Android phones whose browser runs WebGPU on OpenGL ES (they drew nothing
  there); they smooth edges with FXAA on those phones, and Performance there skips the edge
  smoothing, which costs those phones the most.
- A quality the device cannot run falls back to the one below by itself, behind the loading
  screen, and says so ("Your device does not support Ultra: using High"); the game then starts on
  that quality on this device until the player picks the higher one again and it runs. Coming back
  to the game after the phone reclaimed its graphics (another app in front) reloads the page on
  the same quality instead of leaving a frozen picture.
- Performance: no more square patches of light round the floodlights and the other glows on the
  night sky.

### Changed
- The match HUD keeps its scorebug (BLU 1 │ 2:49 │ 0 RED) with a lime notch under your team, and
  the boost meter is bigger, on its own plate. The ball's pointer at the edge of the screen keeps
  off the scorebug, the boost meter and the controls card.
- The pause is a row of big buttons at the bottom: RESUME (focused), SETTINGS and QUIT, with the
  training buttons in between. Online it says MATCH IN PROGRESS (the match goes on) and the scorebug
  stays readable above it. QUIT is held for a second (A, Enter or a finger) or double-clicked, so a
  slip next to RESUME never leaves a match; in Competitive it says it counts as an abandon. Esc,
  Start, B and Backspace resume as before.
- The menus are a board of five sections: PLAY, TRAINING, GARAGE, LEADERBOARD and PROFILE. On a
  computer they sit in the top bar next to the logo, your region and connection, your account and
  Settings; on a TV in the top bar too, with your connection in the bottom bar; on a phone held
  sideways in a rail on the left (with the source code link at its foot), and on a phone held
  upright in tabs at the bottom. Pick one with a click or a tap,
  with the bumpers (LB / RB) or Q / E, or with a TV remote: press up to reach the bar, then left and
  right (the section opens as soon as you land on it). The logo always takes you back to PLAY.
- Back is predictable everywhere: it closes a window first, then goes back one screen, then from
  any section to PLAY, and only on PLAY does it ask "Leave Turbogol?" (KEEP PLAYING is the answer
  already selected). Esc, Backspace and the controller's B now ask that too on PLAY, as Android's
  back gesture and a TV remote's BACK already did. A screen you opened inside a section shows a
  back arrow and the way you came ("PLAY › CASUAL"): click any step to jump back to it. Where the
  way does not fit (a tablet with a wide fallback font), it shows the screen's name alone. SIGN IN on Competitive opens your profile on top of it, so Back returns to Competitive. Leaving a
  custom lobby's screen any other way than its own buttons (another section, the logo, a step of
  the way back) asks "Leave the lobby?" first, as Back does.
- The search you started stays in sight on every section, as a pill in the top bar with its time
  ("CASUAL · 2v2 · 0:42"): open it to go back to the search, press ✕, Y on a controller or X on the
  keyboard to cancel it. It also floats above Settings, where Y, X and ✕ cancel it too. The old
  search banner at the bottom of the menus is gone.
- The region pill shows your region and whether you are online ("● Online", or how many are
  playing once there are five or more; on a TV just whether you are online); open it to change the
  region, or press RETRY when the game cannot reach the server. The hint bar at the bottom speaks only the language of what you are holding: the
  controller's buttons, the keyboard's keys or the TV remote's, and nothing with a mouse. When it
  runs out of room on a TV, its text gets a little smaller, then the Settings hint goes (the gear
  at the top says it), then the pills give up their words, first the ones said next to them (the
  player count, whose dot says you are online; the search's queue), down to their icons (a search
  its clock), and while you search, the cancel hint goes (the pill's ✕ is next to it); the source
  code link always stays on screen. A top bar that runs out of room (a long name and the player
  count on a tablet or a phone, a Competitive search of every format next to a computer's sections)
  does the same with its pills instead of pushing Settings off the screen.
- On a phone held upright the menus now work (profile, leaderboard, training...); only a match
  asks you to turn the phone. A tablet plays either way. You can pinch to zoom the menus; a match
  starts at its normal size, and its controls and pause menu still keep every finger.
- Windows, dialogs and short messages share one look: a solid panel in the middle (it rises from
  the bottom on a phone), and up to three short messages at a time that stay longer when they are
  longer. The source code link stays on screen (the bottom bar, or the foot of the phone's rail);
  the licenses, Discord and the game's version are under About next to it.
- A cleaner interface, the first step of the new menus. Titles, buttons and numbers use one
  condensed typeface on every device (Barlow Condensed, a free font of 6 KB that comes with the
  game), so an Android phone or a TV shows the same proportions as Windows did. Panels are solid
  instead of blurring the stadium behind them (smoother on phones and TVs), the pause, the pack
  summary and dialogs dim the game more, and one focus ring (white, with a lime mark under it, or a
  lime bar for a row) shows where you are with a keyboard, a controller or a TV remote; it is never
  shown to a finger. The menu tiles have drawn icons instead of emoji, and secondary text is a
  little brighter. Hover effects only happen where a mouse can hover; with reduced motion turned on
  in your system nothing slides, pops or blinks.
- The arrow keys drive too (↑ / ↓ accelerate and reverse, ← / → steer, also in the air), next to
  W A S D, unless you bind an arrow to something else. The training keys that used the arrows moved:
  Page Up / Page Down for the previous / next shot, F to put the car back and T for unlimited boost
  in free play (Backspace still resets the shot or the ball). If you had never changed those keys,
  yours move too, unless you already use the new key for something else; the training screen names
  your own keys.
- The menus are lighter on phones, TVs and laptops: the stadium behind them now moves at 30 frames
  per second (20 on a phone whose menus cover most of the screen), and it stops, keeping its last
  picture, behind Settings, a window or dialog, the "turn your phone" screen of a match and a
  paused offline match. On Super low, where the menus are a solid page, the stadium behind them is
  not drawn at all, but behind PLAY's home screen (below). Less heat and battery for the same
  menus; matches run exactly as before. With "reduce motion" on in the system settings, the
  stadium behind the menus holds still.
- A new look: the match is played in a floodlit night harbour, inside a steel cage with wire
  netting, LED boards (a big main-sponsor board in the middle of each side wall; the boards change
  every 30 seconds), stands with a crowd and floodlight towers, with cranes, containers and a ship
  behind the goals. The pitch is damp, freshly mown grass with calm floodlight reflections, cars
  cast real shadows on High and Ultra (ground shadows on Performance), and the cars and the ball
  have new paint and panels. Graphics
  quality has four tiers: Super low, Performance, High and Ultra (grass blades near the camera,
  reflections on the wet pitch, ambient occlusion, lens glare); browsers without WebGPU start on
  Performance. The
  Friendly screen has a Stadium row to pick the setting: the night harbour, a red canyon at
  sunset and an alpine valley. The settings are saved in the browser after their
  first visit, so switching back is quick.
- The bots fly: medium bots now go up for high balls too, hard ones double-jump for higher ones,
  and both meet the ball so that it goes toward the goal (or, for a save, away from their own);
  the defender in 3v3 saves in the air. Two old faults kept aerials from happening at all: the
  flight was abandoned on its first tick (the jump not yet applied made the plan look impossible)
  and, under a high ball, the 2D distance said "reached". Pages from before must reload to play
  online (protocol versions up again).
- The goals have no right angles any more: the posts and the crossbar are rounded into the back
  wall, the back-wall ramp wraps round the posts into the goal, and every inner edge of the
  chamber (netting to floor, netting to roof, the back corners) is rounded like the rest of the
  field. The goal frames glow along the rounded edges. Pages from before the change must reload
  to play online (the client and server protocol versions went up).
- Matches last 3 minutes (was 5): offline, casual, ranked, P2P and server matches. Custom lobbies
  start at 3 minutes and the host can still pick 5, 10 or no limit.
- Spanish is neutral Latin American Spanish (tú) instead of rioplatense, in the game, the server's
  messages and README.es.md.
- The engine sounds like a combustion engine instead of an electric whine: a V8-like rumble with
  three virtual gears (it shifts as the car speeds up), free revs in the air, more growl under load
  and a few exhaust pops when the throttle is released at high rpm. The boost is a deep roar with a
  soft low hum and the supersonic wind a full, low whoosh, instead of high-pitched hiss.
- The sound effects have body instead of sounding like a single tone: ball touches, bumps,
  landings, jumps, flips, the explosion, the goal, the countdown, the kickoff signal and the boost
  pads are each layered from a contact click, a pitched body with several partials and filtered
  noise, and they ring briefly in a short synthetic room.
- The official deployment turns the anti-bot check on; CI runs actions/checkout and
  actions/setup-node v7.
- Community nodes: the VPS installer can be run again (no token: it upgrades the launcher and keeps
  the node's identity and settings) and restores a backed-up identity with `--restore`. Before it
  spends the token it checks that the public address is this machine's (a DNS name's A and AAAA
  records included) and that the Caddy config is its own to replace. It takes `--matches` (`auto`
  goes back to the benchmark) and gives a name a 90-day certificate (the 6-day one only for an IP)
  with live matches kept through a Caddy reload. Replay uploads keep trying for about 75 s, and the
  launcher never starts a release that needs a newer Node.js than the machine has: it logs why, and
  the node does not serve until Node.js is upgraded.
- Community node docs: the São Paulo VPS guide is the runbook of the real machine (a Hostinger KVM
  2 in Campinas: access, hardening, DNS and TLS, measurements, install, backups and operations),
  the stage 1 checklist is split into eight PRs with the maintainer's steps, the pre-beta tests
  and the main risks, and stale facts in the other node docs are corrected. The budget shows the
  VPS's real price.
- `npm run deploy` checks the community-node release first and, when the game code nodes run
  changed, moves their release channel to a signed release built from the same game code; until the
  first node release is published, deploy with `npm run deploy -- --nodes-off`.
- The graphics quality moved from the Friendly screen to Settings > Graphics, where it can also be
  changed in the middle of a match or training from the pause menu. A quality change shows the
  loading screen until the new quality is fully ready, so the first moments after it no longer
  stutter; changing the stadium on the Friendly screen does the same until the new sky is ready.
- The game opens on a clean loading screen (the wordmark, a progress bar, one short line) that
  shows from the very first moment and fades into the menu once it is on screen, instead of the
  old technical progress texts.
- The pause menu works with every input: the mouse, a finger, the keyboard (arrows, Enter) and the
  controller (D-pad, A; X opens the settings) pick RESUME, SETTINGS or QUIT, and training's own
  entries (reset, next / previous shot, unlimited boost) sit in the same menu.
- In the day stadiums the ball casts no shadow: the low sun threw it far from the ball, where it
  looked like a second landing mark. The landing marker under the ball stays.
- Performance has its own bright, clean look and draws each frame in about half the time: an
  evenly lit pitch with clear mowing stripes and crisp lines (no dark patches), a lit crowd in the
  team colours, a brighter picture in every stadium, lighter pine forests in the alpine valley,
  and the cage drawn by its steel frame without the wire netting. High and Ultra are unchanged.
- On Super low the stadium stays live behind PLAY's home screen, at 20 frames per second, with
  solid tiles over it; every other menu keeps the solid page.
- Language moved to PROFILE (until Settings has it), and says before you pick that the game
  reloads for a few seconds.

### Removed
- The Casual, Competitive, Friendly and lobby list screens and their ‹ › pickers (mode, difficulty,
  connection): MODES has them as tabs. Playlists no longer have names like "Pairs": a format is
  just 1v1, 2v2 or 3v3, in every language.
- The result window after a Competitive match (the final screen shows the rank change) and the
  old start menu that was still hidden inside the in-match HUD.
- The old home screen's Language, Settings and Profile tiles (Settings is the gear at the top and
  Start on a controller, your profile the account button next to it), its Training and Leaderboard
  tiles (they are sections) and the guest side panel, and the MODES screen: its four modes are on
  the home screen now.

### Security
- Static files are served with X-Content-Type-Options, Referrer-Policy, X-Frame-Options and
  Permissions-Policy headers; /.well-known/security.txt points to private vulnerability reporting.
- Unexpected server errors (API routes and match sockets) no longer echo the exception text.
- The server reads at most 4 KB of a JSON body, even one sent without its length; on `/nodes/*`
  every per-address limit counts an IPv6 /64 as one address and replay downloads and
  `GET /nodes/mine` are limited too, a target that stops answering no longer holds up the node
  control plane's sweep or the other results, and callers are only told it is unavailable.
- Node releases are signed in a job that installs nothing and uploaded from a separate `releases-r2`
  environment that re-checks them and can be re-run; the deploy gate also checks the channel's
  minimum release and that releases come from main.

## [0.1.0] - 2026-10-15

First public release.

### Added
- Physics car soccer at 120 Hz in the browser: rigid-body physics in WebAssembly, three.js WebGPU
  renderer with a WebGL2 fallback, every model, texture and sound generated by code.
- Original field, cars, ball and HUD; 1v1, 2v2 and 3v3 against bots with three difficulty levels.
- Training: free practice and nine shot packs (shooting, saving, aerials at three difficulties).
- Online: casual play over a peer-to-peer rollback mesh (WebRTC) or server-hosted matches,
  several playlists at once, region choice, custom lobbies (public list, join by code, password).
- Accounts (username + password, optional Google / Discord sign-in) and ranked play with a
  per-playlist rating (Weng-Lin / OpenSkill model), placement games, tiers and abandon penalties.
- Keyboard, mouse and gamepad controls, fully rebindable; camera and gameplay settings.
- Cloudflare Workers + Durable Objects backend with spend caps in code.

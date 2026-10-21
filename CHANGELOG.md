# Changelog

All notable changes to Turbogol are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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
- A new look: the match is played in a floodlit night harbour, inside a steel cage with wire
  netting, LED boards (a big main-sponsor board in the middle of each side wall; the boards change
  every 30 seconds), stands with a crowd and floodlight towers, with cranes, containers and a ship
  behind the goals. The pitch is damp, freshly mown grass with calm floodlight reflections, cars
  cast real shadows on High and Ultra (ground shadows on Performance), and the cars and the ball
  have new paint and panels. Graphics
  quality has three tiers: Performance, High and Ultra (grass blades near the camera, reflections on
  the wet pitch, ambient occlusion, lens glare); browsers without WebGPU start on Performance. The
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

# Changelog

All notable changes to Turbogol are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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
- Community nodes, groundwork in the Worker (nothing calls it yet): the wasm's SHA-256 is committed
  next to it (`npm run build:wasm` rewrites it, a test checks it), the node bindings and secrets are
  optional settings, a `nodes_on` KV flag (off, `1`, or a canary list of account ids; `vm_disabled`
  wins) will turn the nodes on, and a node match's results will reach the accounts as the game
  servers' do, a refused call dropped with an ALERT line and only server errors retried.
- Community nodes: the control plane runs in the Worker, its state kept in SQLite, and `/nodes/*`
  serves the nodes and their installers (releases from R2, registration, the control socket,
  replay uploads). Only the project's accounts create node tokens, two nodes each at most. A deploy
  now needs the two node R2 buckets; set the node secrets with `wrangler versions secret put`.
  Matches do not go to nodes yet.
- A link to the official Discord server in the menu footer, the READMEs, CONTRIBUTING.md and the
  new-issue page.

### Fixed
- The anti-bot check (Turnstile) had no place to render in the new menus, so a first visit could
  not create a guest or an account while the check is on; it now shows above every menu, one
  challenge at a time, and closes when the menus close into a match.
- Browsing the public lobby list no longer registers a guest.
- Third-party notices point to the script that applies the physics-library patches.

### Changed
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

### Security
- Static files are served with X-Content-Type-Options, Referrer-Policy, X-Frame-Options and
  Permissions-Policy headers; /.well-known/security.txt points to private vulnerability reporting.
- Unexpected server errors (API routes and match sockets) no longer echo the exception text.
- The server reads at most 4 KB of a JSON body, even one sent without its length; on `/nodes/*`
  every per-address limit counts an IPv6 /64 as one address and replay downloads and
  `GET /nodes/mine` are limited too, a target that stops answering no longer holds up the node
  control plane's sweep or the other results, and callers are only told it is unavailable.

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

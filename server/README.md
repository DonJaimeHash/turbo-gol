# Turbogol server (Cloudflare Workers backend)

The online backend of Turbogol: guest sessions, regional matchmaking, an
authoritative match host that runs the **same RocketSim `.wasm` as the browser** inside a Durable
Object at 120 Hz, streaming full-state snapshots at 30 Hz over WebSocket (phase 1, "server"
matches), and the signaling rooms of the **peer-to-peer rollback matches** (phase 2, "p2p",
casual): the browsers simulate, the Worker only relays WebRTC signals, agrees the start and
announces drops. Design: `docs/online/PHASE1.md`, `docs/online/PHASE2.md`; decisions:
`docs/online/DECISIONS.md`; wire protocols: `src/net/protocol.ts` (phase 1) and
`src/net/p2p/protocol.ts` (phase 2), both shared with the client.

```
server/
  wrangler.jsonc        Worker + Durable Objects (MATCH -> MatchDO, MATCHMAKER -> MatchmakerDO, ROOM -> RoomDO), KV FLAGS, vars,
                        .wasm rule, assets (../dist = the Vite build, served from the Worker's origin; only /api/*, /ws/* and
                        /room/* run the Worker)
  .dev.vars             local secrets (JWT_SECRET) for wrangler dev
  src/index.ts          HTTP router + WebSocket gates (/ws and /room: ticket verified at the edge), /api/ice, /api/config,
                        /api/where, asset fallback
  src/auth.ts           HS256 JWT on WebCrypto: sessions (24 h), tickets (90 s, jti; role 'player' | 'peer'), internal header
  src/env.ts            Env bindings / vars / secrets, JSON helpers, iceServersFor (STUN + optional Cloudflare TURN credentials)
  src/MatchmakerDO.ts   one per region: queues per (mode, kind), p2p rooms / server matches, bot fill, roster + tickets, locks, capacity
  src/MatchDO.ts        one per server match: sockets, RoomHost loop, snapshots, events, TTL, shutdown
  src/RoomDO.ts         one per p2p match: hibernating signaling room (welcome, signal relay, ready -> start, unreachable -> drop, TTL)
  src/roomHost.ts       RoomHost: input buffers, bots, match rules, snapshot encoding (env-agnostic)
  src/wasm.ts           instantiates ../../src/sim/wasm/rocketsim.wasm in workerd
  test/auth.test.mjs    JWT unit tests            (node, no server needed)
  test/roomHost.test.mjs RoomHost unit tests       (node, fake sim, no wasm needed)
  test/room.test.mjs    phase 2 pure logic: start / drop decisions, roster + slot assignment, p2p formation timing, ICE list
  test/smoke.mjs        phase 1 end-to-end against a running wrangler dev or a deploy (root: `npm run smoke:online` / `npm run smoke:remote`)
  test/smoke-p2p.mjs    phase 2 end-to-end: two guests -> p2p room -> signaling, start, drops (grace alarm, majority) -> lone-human fallback
```

## Run locally

```sh
cd server
npm i
npm run dev            # wrangler dev --port 8787 (workerd + miniflare, no account needed)
npm test               # unit tests on node 24 (no wasm): JWT auth, RoomHost on a fake sim, phase 2 room / matchmaker logic
npm run smoke          # phase 1: guest -> queue -> leave -> WebSocket match vs a bot for 10 s, snapshot / hash checks
npm run smoke -- --duration=20   # longer capture; prints a SUMMARY line (see "Deploy")
node test/smoke-p2p.mjs          # phase 2: two guests -> one room -> signal relay, ready/start, unreachable/drop; lone guest -> server fallback (~25 s)
npm run typecheck      # tsc --noEmit -p .   (also: npx tsc --noEmit -p server from the repo root)
```

From the repository root the same things are `npm run dev:api`, `npm run test:server`,
`npm run smoke:online` and `npm run typecheck:server`; the RoomHost test on the real wasm
(`tests/net-roomhost-wasm.test.mjs`: host and client sims in one process, hash per snapshot and
replay of the applied inputs between snapshots) runs with the root `npm test`. The Vite dev server
proxies `/api`, `/ws` and `/room` to `127.0.0.1:8787` (see `vite.config.ts`); `wsUrl` is absolute
(the Worker's own origin, `ws://127.0.0.1:8787/ws/<id>` or `/room/<id>` in dev), so the browser
opens the socket straight to the Worker. From the Claude desktop app the `api` entry in
`.claude/launch.json` starts this server.

The Worker also serves the game itself from `../dist` (Workers Assets, see "Deploy"): wrangler
needs that directory to exist when it starts, so `npm run dev` creates an empty one if there is no
build yet (`predev`). After a root `npm run build`, `http://127.0.0.1:8787/` serves the production
bundle (index.html, the JS / CSS chunks, `rocketsim-*.wasm` as `application/wasm`) and the game
boots and plays online against the same origin without Vite, which is exactly what a deploy does.

### Environment

| Name | Where | Meaning |
|---|---|---|
| `JWT_SECRET` | secret (`.dev.vars` locally) | signs sessions, tickets and the Worker<->DO internal header |
| `TURNSTILE_SECRET` | secret, required on a deploy | when set, `POST /api/guest` and `POST /api/auth/register` require a valid Turnstile token (outside local dev a missing secret answers 503 `turnstile_unconfigured`) |
| `TURNSTILE_SITEKEY` | var (public), paired with the secret | the widget sitekey, handed to the browser by `GET /api/config`; empty = no widget (local dev) |
| `VITE_ORIGINS` | var, optional | comma-separated allowed browser origins for CORS and WebSocket `Origin`; empty = any (`*`). Under `wrangler dev` (the Worker reached on a loopback host) a loopback page origin such as the Vite dev server on any port is always accepted, so the committed production list does not block local play |
| `MATCH_LENGTH_SECONDS` | var | regulation length (300) |
| `REGION_OVERRIDE` | var | force a matchmaking region (empty = `request.cf.continent`, `dev` locally) |
| `TURN_KEY_ID`, `TURN_KEY_TOKEN` | secrets, optional (both or none) | a Cloudflare Realtime TURN key: `GET /api/ice` and the room welcome then append 10-minute TURN credentials minted per request (`POST .../turn/keys/{id}/credentials/generate-ice-servers`, `{ ttl: 600 }`); unset = STUN only (`stun.cloudflare.com:3478`) |
| `FLAGS` | KV | `matchmaking_off`, `do_disabled` (`1`/`true`/`on`) -> 503 |
| `ASSETS` | Workers Assets binding | the Vite build (`../dist`); the Worker falls back to `env.ASSETS.fetch()` for any path outside `/api`, `/ws` and `/room` it still receives |

## HTTP / WebSocket API

| Route | Body / headers | Result |
|---|---|---|
| `POST /api/guest` | `{ name?, turnstileToken? }` | `GuestSession { playerId, name, session, expiresAt }`; name 3-16 chars (letters, digits, space, `_ - .`) or `Guest-xxxx` |
| `POST /api/queue` | `{ mode: '1v1'|'2v2'|'3v3', kind?: 'p2p'|'server' }` (default `p2p`), `Authorization: Bearer <session>` | long-poll up to 25 s: `QueueResultP2p { status: 'matched', kind: 'p2p', roomId, ticket, wsUrl: ws(s)://host/room/<roomId> }`, the phase 1 `{ status: 'matched', matchId, ticket, wsUrl: .../ws/<matchId> }` (kind `server`, or the p2p fallback of a lone human) or `{ status: 'waiting', waiting }` (call again); `409 { error: 'active_match', matchId, kind }` while a match / room of yours is alive (a room cannot be rejoined: its lock is freed when your room socket closes) |
| `POST /api/rejoin` | `{ matchId }`, Bearer | a fresh ticket for a server match that still has you in its roster (reconnection; p2p rooms have no rejoin: 410 `p2p_room`; a match you quit with `/api/leave { matchId }`: 410 `left`, or 404 when you were its last human: your quit ended it) |
| `POST /api/leave` | `{ matchId? }`, Bearer | `{ ok, left, released }`: drops you from the queue if you are still waiting (the menu's Esc / BACK calls it, so the bot fill does not open a room nobody joins) and frees your P2P room lock. With the `matchId` of your server match (an explicit quit: the client's menu) that lock is freed too and the MatchDO closes your socket (1000 `left`) and hands your car to its bots for good; without a `matchId` a server match is not affected (queueing for a server match again answers `409 active_match` and the client rejoins it) |
| `GET /api/ice` | Bearer | `{ iceServers }` for `RTCPeerConnection`: `[{ urls: ['stun:stun.cloudflare.com:3478'] }]` plus the TURN entry when the TURN secrets are set (minted per call, 30 per player per minute) |
| `GET /ws/:matchId` | `Sec-WebSocket-Protocol: tg1, ticket.<jwt>` (role `player`) | 101 with `Sec-WebSocket-Protocol: tg1`; 400/401/403 before any Durable Object is touched |
| `GET /room/:roomId` | same, with a role `peer` ticket whose `mid` is the room id | 101 to the RoomDO: first message `RoomWelcome` (JSON; see `src/net/p2p/protocol.ts`) |
| `GET /api/health` | | `{ ok, version, protocol }` |
| `GET /api/time` | | `{ now }` |
| `GET /api/config` | | public client configuration: `{ turnstileSiteKey, protocol, version, region, autoRegion, regions, oauth, accounts }` (the sitekey is `null` when Turnstile is off; `oauth` lists the configured sign-in providers) |
| `GET /api/where` | | `{ edgeColo, country, city?, asn?, ip }`: the Cloudflare colo (IATA code) that served the request and the client address masked to /24 (IPv6 /48), from `request.cf`; for the deploy measurements. The colo the *match* runs in is `Welcome.hostColo` (the MatchDO reads it once per isolate from `cloudflare.com/cdn-cgi/trace`, 5 s cap, `unknown` on failure) |
| anything else | `GET` | the game (Workers Assets from `../dist`; unknown paths get `index.html`) |

Rate limit: 20 `POST /api/queue` per playerId per minute (in-memory per isolate, best effort).
One active match per playerId (lock in the matchmaker, released when the MatchDO shuts down or,
for a p2p room, when the player's signaling socket closes / its slot is dropped / the room is
cleaned up; expiring after regulation + 10 min, or the room TTL, as a fallback).

Matchmaking (one queue per mode and kind, in the region's MatchmakerDO):

* `kind: 'server'`: a MatchDO match forms when the mode's humans are present (2 / 4 / 6) or when
  the oldest waiter has waited 10 s (bots fill the rest, at least one human).
* `kind: 'p2p'` (default): a RoomDO room forms at once when the mode's humans are present; after
  15 s (`P2P_FILL_WAIT_MS`) with at least two humans it forms with bots in the free slots; a lone
  human after those 15 s is moved to the server path (a MatchDO match with bots, answered in the
  phase 1 shape, so the client falls back transparently).

Humans alternate teams; slot order is blue humans, blue bots, red humans, red bots; slots
are the sim's car creation order. Capacity: at most 20 live matches + rooms per region (503
`capacity` for new joiners beyond that; waiters keep waiting).

P2P room lifecycle (RoomDO, Hibernation API: no timers, the object sleeps between messages):
roster + random uint32 `seed` registered by the matchmaker -> each peer opens `/room/<id>` with
its ticket (single-use `jti`; a second socket for the same slot replaces the first, close 4000) and
gets `RoomWelcome` (seed, slots with `connected` flags and `peerId`s, `iceServers`, inputDelay 3,
window 16, hashEvery 30, tickRate 120, `now`); the others get `peerJoined`. `signal` is relayed to
the target slot (dropped when it has no socket). When every connected peer sent `ready` and at
least two are connected: `start { startAt: now + 1500, now }` to all, then `drop { slot, atTick: 0 }`
for every peer slot without a socket (its car is the team AI from tick 0 on every peer).
`unreachable { slot, atTick }` -> `drop { slot, atTick: max(reported) + 60 }` once a majority of
the other live peers reported that slot (the only other one in 1v1), or on a single report when
the slot's own socket has been closed for more than 5 s (re-checked by an alarm). `ping { t0 }`
-> `pong { t0, now }`; `hashReport` is kept for `/internal/status` only. A closing socket
broadcasts `peerLeft`; a room with no socket for 60 s (90 s after create) or older than 20 min is
wiped (sockets closed 1000, locks and capacity released). Guards: JSON text frames <= 16 KB,
60 messages/s per socket (burst 120), malformed JSON -> 1008, unknown types ignored.

Match lifecycle (MatchDO): roster registered by the matchmaker -> wasm pre-warmed -> sockets ->
loop starts when every human sent `Ready` or 5 s after the first socket -> countdown 3 s -> 120 Hz
(setInterval 8 ms + accumulator, <= 8 ticks per callback) -> snapshots every 4 ticks to every
client with its own `lastInputTick` / `bufferHint` -> `ended` (clock / overtime) -> sockets closed
with 1000 two seconds later and storage wiped. No socket for 15 s -> shutdown; the last human's
explicit quit (`/api/leave { matchId }`) ends the match at once (locks and capacity released). Safety net: an
alarm at regulation + 10 min. Guards: 8 sockets, frames <= 512 B, 2 input packets per host tick
per slot (extras dropped), malformed frame -> close 1008. A new socket for the same player replaces
the old one (use `/api/rejoin` for a fresh ticket; tickets are single use via their `jti`).
A disconnected human's car gets zero controls until it reconnects (phase 1; handing it to the
team AI is a later improvement).

## Deploy (your account)

One Worker serves everything from one origin: the game (the Vite build in `dist/`, uploaded as
Workers Assets with an SPA fallback), the `/api/*` control plane and the `/ws/*` match sockets.
The browser therefore needs no CORS and `wsUrl` is `wss://<host>/ws/<id>` (the Worker builds it
from the request's own host and scheme). Durable Objects need the Workers Paid plan
(DECISIONS.md: paid from day one, budget cap US$ 50 / month).

The committed values are the official deployment's (https://turbo-gol.com). A fork changes them before
its first deploy (local dev works with any of them):

| Where | What |
|---|---|
| `wrangler.jsonc` -> `name` | the Worker name (a new name = a new Worker: empty Durable Objects, no secrets) |
| `wrangler.jsonc` -> `routes` | your Custom Domain (a zone in the same Cloudflare account); or remove `routes` and set `"workers_dev": true` to serve on `<name>.<account>.workers.dev` |
| `wrangler.jsonc` -> `kv_namespaces[0].id` | the id printed by `npx wrangler kv namespace create FLAGS` |
| `wrangler.jsonc` -> `vars.TURNSTILE_SITEKEY` | the Turnstile **sitekey** (dashboard -> Turnstile -> add a widget for the deployed hostname); public |
| `wrangler.jsonc` -> `vars.VITE_ORIGINS` | `https://<your-host>` (comma-separated if several): the origins allowed for CORS / WebSocket `Origin`; empty = any |
| secrets `GOOGLE_CLIENT_ID` / `_SECRET`, `DISCORD_CLIENT_ID` / `_SECRET` | optional OAuth sign-in (docs/online/ACCOUNTS.md) |
| secret `JWT_SECRET` | a long random string (`openssl rand -hex 32`) |
| secret `TURNSTILE_SECRET` | the Turnstile **secret** of the same widget; required: without it `POST /api/guest` and `POST /api/auth/register` answer 503 outside local dev |
| secrets `TURN_KEY_ID`, `TURN_KEY_TOKEN` | optional (phase 2): a Realtime TURN key (dashboard -> Realtime -> TURN); without them P2P pairs that need a relay cannot connect (STUN only) |

```sh
cd server
npx wrangler login
npx wrangler kv namespace create FLAGS          # -> paste the id into wrangler.jsonc kv_namespaces
npx wrangler secret put JWT_SECRET
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put TURN_KEY_ID             # optional, phase 2 (with TURN_KEY_TOKEN)
npx wrangler secret put TURN_KEY_TOKEN
#   edit wrangler.jsonc: name, routes, kv id, vars TURNSTILE_SITEKEY and VITE_ORIGINS
cd ..
git commit -am "Deploy config" && git push origin main   # the deploy runs only from a clean tree at origin/main
npm run deploy -- --nodes-off   # = npm run build (notices + tsc + vite build -> dist/) && node scripts/deploy.mjs (wrangler deploy); --nodes-off until a node release is published
```

Before `wrangler deploy`, `npm run deploy` checks the community-node release
(`scripts/node-release-gate.mjs`): the whole tree must be clean (nothing uncommitted, nothing
untracked outside `.gitignore`) and at `origin/main`, and the nodes must run this build's game code
(the rules, bots and sim code bundled in a node release, from the channel's minimum release up to its
stable one). When that code changed, it needs a signed node release built from a commit of main
with the same game code and moves the nodes' release channel to it before deploying. It reads the
channel in the R2 bucket `turbogol-node-releases` with the deploy's credentials, every time,
`--nodes-off` included, so the token needs R2 read access (and write, to move the channel) and the
account needs R2 enabled.
Until a node release is published (a fork without nodes, or before the first one), every deploy is
`npm run deploy -- --nodes-off` (from `server/` as well). If a deploy fails after the channel moved,
the gate prints how to check which build serves (`npx wrangler deployments status`) before going back.

The first deploy of a Worker applies the migrations `v1`-`v3` in order (later deploys apply only new
tags); `wrangler dev` does the same locally the first time it starts. Custom Domain deploys need a
token (or `wrangler login`) with Workers Scripts and Workers Routes edit rights and access to the zone.

The Worker answers only on the Custom Domain in `routes` (`workers_dev` and `preview_urls` are off);
the Turnstile widget and `VITE_ORIGINS` must name that host. Turn on "Always Use HTTPS" for the zone:
the game needs a secure context (WebCrypto for sign-in, `wss://` sockets). Open it and press ONLINE: the guest registration goes through the Turnstile widget, the
queue fills with bots after 10 s and the match runs in a MatchDO near the edge that created it.
Then measure, from every location that matters (docs/online/PHASE1.md, "Deploy and
measurements"):

```sh
curl https://<host>/api/where                                   # edge colo / country / asn seen by Cloudflare
API=https://<host> npm run smoke:remote -- --duration=20         # SUMMARY edge=.. host=.. rtt_p50=.. snap_p50=.. desyncs=..
```

With Turnstile on, the smoke cannot create a guest by itself: pass a browser session as
`SESSION=<jwt>` (DevTools console on the deployed page after one ONLINE:
`JSON.parse(localStorage.getItem('turbogol.guest')).session.session`); guest creation and the
second-guest leave test are then skipped. Live logs: `npx wrangler tail` (your account) or the
dashboard's observability (enabled in `wrangler.jsonc`). Redeploys reset running matches (the sim
lives in memory): their players get `410 match_reset` and can queue again.

## Limits and cost notes

* **Durable Object duration** is billed while a MatchDO is alive: the tick loop keeps it awake for
  the whole match (~5-6 min). Each incoming WebSocket message is a request (60 input packets/s +
  4 pings/s per player; outgoing messages are free). A 3v3 is ~400 req/s, below the ~1,000 req/s
  soft limit per object. Keep the DECISIONS.md quota (max 20 concurrent DO matches) in mind: it is
  not enforced in code yet (phase 1 measures first).
* **Messages 20:1**: for every input packet in, the host sends ~0.5 snapshots out (30 Hz vs 60 pps);
  bandwidth per client ~45 KB/s down (1.5 KB snapshots) and ~2 KB/s up. Snapshot quantisation /
  deltas are phase 2.
* `limits.cpu_ms` is 30 s per request; the long-running loop lives in timers (not counted against a
  single request) and a 3v3 tick with six bots costs ~0.1 ms.
* `Date.now()` in workerd only advances between I/O callbacks; the loop uses deltas between
  `setInterval` callbacks, so the average rate is 120 Hz even if a callback is late.
* One wasm instance (16 MB memory) per match; the arena mesh is built once per isolate.

* A **RoomDO** costs almost nothing: it hibernates between messages (no timers, one alarm for the
  cleanup / TTL) and the game traffic never touches it; during a match it only sees pings, hash
  reports (4/s per peer) and the occasional `unreachable`. TURN relay bandwidth is the budget item
  to watch (1,000 GB/month included); `/api/ice` mints credentials per request, 30 per player per
  minute.

## Phases

Phase 1: DO authority over WebSocket, guest accounts, full-state snapshots, bots, measurements
(RTT / jitter from Argentina, `setInterval` jitter inside the DO, hash determinism in the smoke test).
Phase 2 (this, server side): the p2p queue kind, signaling rooms, `/api/ice` with optional
Cloudflare TURN; the client side (rollback engine, WebRTC mesh, room client, P2P session) lives in
`src/net/p2p/`. Later: VPS authority + replay verification for ranked (phase 3), WebRTC transport
for server matches, snapshot quantisation / deltas, D1 for MMR / bans, OAuth, spend-control cron
flipping the KV flags, handing a dropped player's car to the team AI in server matches.

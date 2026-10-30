# Replays: anyone can watch any community-server match

Status: first version (October 2026). The viewer is meant to improve over time; this page records
what was studied, what was decided and why, and what is left.

## What a replay is

Every match a community node hosts is recorded as a `TGR1` replay (`nodes/shared/replay.ts`): the
match setup (roster, kickoff seed, length, build) plus the controls the host applied to each human
car whenever they changed, a state-hash checkpoint every second and the end of the match. Bots are
not recorded: the simulation is deterministic, so running the same RoomHost (rules, bots, kickoffs)
on the same wasm with the same inputs gives the same match. That is how the verifiers check a
ranked result, and it is also how the viewer plays a match: it re-simulates it in the browser.

A 3-minute 1v1 is about 10 KB. The node uploads it to R2 (`NODE_REPLAYS`, key = the 64-hex match id)
before it reports the end. A listed match's object is deleted with its index row after 30 days (the
cron, below); the bucket's lifecycle rule deletes every other object (voided or never listed
matches) after 30 days too. It is set by hand, once, and checked with the second command:

```sh
npx wrangler r2 bucket lifecycle add turbogol-node-replays expire-30d --expire-days 30 --force
npx wrangler r2 bucket lifecycle list turbogol-node-replays
```

## Who can see what

| | Before | Now |
|---|---|---|
| List of matches | nobody | anyone, guests included, from one to two hours after each match (a whole hour's matches at once): `GET /nodes/replays` |
| Replay bytes | the verifier node (signed request) | anyone: `GET /nodes/replays/<matchId>/view` (the signed verifier route is unchanged) |

Only matches the control plane settled **without voiding them** are listed: rated matches (always
verified) and casual ones (`verified` says whether a verifier re-simulated it; casual matches are
verified by sample). A voided match (failed verification, missing report, timeout) is never listed
or served, even though its replay may still be in R2: it may be a tampered recording.

### Privacy

The security audit of #60 (pr60-1 to pr60-7, pr60-m1) and the owner's decisions of 2026-10-29:

- **Names come from the control plane** (`assign.roster`, what the matchmaker placed), never from the
  replay header: a node writes whatever names it likes there and the verifier does not compare them.
- **No account ids.** An account id is stable across renames, so publishing it would link every
  match an account plays. The list carries none and the served header has every `playerId`
  blanked (`""` still decodes). The node id is blanked too (`/nodes/status` never shows it either),
  and so is the header's start time (a node may write its wall clock there).
- **Names show by default; an account can hide its own.** PERFIL > PRIVACIDAD, "Ocultar mi nombre
  en repeticiones públicas" (off by default; `GET`/`POST /api/me/replay-name`, AccountsDO table
  `replay_names`). Then its seat reads `Jugador N` (N = the slot + 1; "Player N" on an English page)
  in the list and in the replay, for the matches listed before it chose too: the index keeps each
  seat's player id beside the row (`replay_players`, never served) and the NodeRegistryDO asks
  AccountsDO (`/replay-hidden`) when it serves a row, keeping each answer a minute. A row listed
  before this table existed is looked up by its names (today's usernames). Guests are already
  `Invitado NNNN`. While AccountsDO cannot answer, the list and the view answer 503 rather than a
  name someone hid. A change reaches the list within about a minute and the copies of a replay
  already watched within 3 hours (their cache life).
- **No "who is playing now", and no exact times.** Matches are released by settle hour, a whole
  hour at a time: every match that settled between H:00 and H:59 is listed, and viewable, from
  H+2:00 on, all together (one to two hours after each ended), and they go together too, at H:00
  thirty days later. The list shows the hour (rounded down), never the minute, and within an hour
  the order is the match id's, not the settle time's. Polling the list (or a view) every few
  seconds tells no more than that: when a row appears or goes is its hour's edge, not its own
  settle time (`server/src/replayIndex.ts` replayServedSpan; a release at each row's own settle +
  1 h gave anyone polling every 30 s every match's exact end, found in review).
- **30 days, enforced in code.** Nothing settled more than 30 days ago is listed or viewed, whether
  or not a prune ran (an hour's matches go when its first minute turns 30 days old); the cron
  (every 5 minutes) deletes those rows and their R2 objects.
- **Delist on request.** `POST /nodes/admin/delist { matchId, reason? }`, a maintainer's route with
  the same gate as the others (a `NODE_TRUSTED_OPERATORS` account, not a TV's session, signed in or
  re-authenticated in the last 15 minutes): the row, its seats and its R2 object go, the view's
  copy in the maintainer's Cloudflare location is deleted (and remembered as gone for a day), and,
  with the `CF_ZONE_ID` var and the `CF_PURGE_TOKEN` secret (a token with only Zone > Cache Purge),
  every location's copy is purged by URL. Without them another location keeps its copy at most 3
  hours. Every delist is an ALERT line naming the maintainer.
- **A switch for the public replays alone.** The KV flag `replays_off` (server/README.md, "Kill
  switches") answers 404 on the list and the view, cached copies included, and stops nothing else.
- **Not for search engines.** The list and the view send `X-Robots-Tag: noindex`; `replay.html`
  has its robots meta tag.
- The scraping of a public list cannot be undone: what a scraper keeps is out of our hands. The
  privacy notice (still to write) must say what is published, to whom, for how long and how to
  hide a name or ask for a delist.

### Integrity

The served bytes are the node's upload: the Worker checks the R2 object's SHA-256 against the one the
control plane recorded at upload (the index keeps it) and answers 404 otherwise. Only the header is
rewritten; the records after it are copied byte for byte, so the re-simulation is the recorded one.

That re-simulation agreeing with the recording's own checkpoints proves nothing about a match no
verifier checked: its node wrote the inputs and the checkpoints alike. So the view says whether a
verifier re-simulated the match (`x-replay-verified: 1` or `0`, the index's `verified`), and the
viewer shows the green "Checked against the recording" only for `1`. An unverified match says "Not
verified: only the community server that hosted this match vouches for it", and a file opened from
the device says it is a local file.

## How it is built

**Index** (`server/src/replayIndex.ts`, `server/src/nodeStore.ts`): a `replay_index` table in the
NodeRegistryDO's SQLite, one row per listed match, written by `NodeStore.finished` right after the
transaction that settles the match (a failure there only leaves the match unlisted; it never blocks
a settlement), with its human seats in `replay_players`, pruned after 30 days by the cron. A match
whose node reports a replay bigger than the public cap (4 MiB) is not listed. Matches settled
before the index existed are not listed (the control plane forgets a finished match after 10
minutes, so there is nothing to backfill from but the node-written headers).

**Routes** (`server/src/nodeRoutes.ts`): the list asks the object once per isolate every 30 s for
the first page (the object also serves every node heartbeat). A later page needs the cursor the
Worker signed (`next`: the last row's hour and match id, an HMAC under a key derived from
`JWT_SECRET`); anything else reads as the first page, so a made-up cursor never reaches the object,
and a page is kept 5 minutes in the location's edge cache. A view is answered from the edge cache
(Cache API, 3 hours) once someone watched that match; a miss asks the object for the indexed row
and reads the bytes from R2 in the Worker, never through the object, at most 4 MiB (a real match is
far smaller; anything bigger is junk a node stored). A view the object does not serve is remembered
5 minutes at the edge (a random id, a match not released yet), a listed one that fails the checks
a day, with an ALERT line in the Worker's log. Limits, counted across the location's isolates
(`server/src/limits.ts`) and only on what reaches the object: 120 list pages and 120 views a minute
per network, 600 per IPv6 /48 together.

**Viewer** (`replay.html`, `src/replay/`): a second page of the Vite build, reached from
PROFILE > ABOUT (same tab; "Back to the game" returns; not shown on a TV yet: the page has no remote
or controller navigation). Without `?id` it lists the matches; with
`?id=<matchId>` it plays one. It decodes and validates the replay (`decodeReplay`), creates the
renderer with the player's saved graphics quality, runs the whole match once (finds the goals and
their scorers for the timeline, compares every checkpoint), then plays it with the game's own views
and HUD: scorebug, countdown, goal banners with the scorer, name tags, a timeline with the goals,
speed 0.25x to 8x, a broadcast camera and each car's chase camera. Seeking back restarts the
simulation from the first tick (a 3-minute match re-simulates in about half a second on a desktop).

### Build warning

A match only replays faithfully on the build that played it. The viewer says so twice:

1. **Before playing**: the replay's `build.wasmSha256` and `build.protocol` against this page's
   (`ROCKETSIM_WASM_SHA256`, `PROTOCOL_VERSION`), the rule the control plane uses (`sameBuild`). The
   list marks such matches "Other version".
2. **From the recording itself**: the checkpoints. JavaScript changes (rules, bots) are not in the
   wasm hash; a checkpoint that does not match says from which second the replay stops being the
   real match.

Either way the replay still plays, with the notice on screen.

## Left for later

- The privacy notice (terms of use and privacy policy): what the replays publish, to whom, for how
  long, how to hide a name and how to ask for a delist.

- TV: remote and controller navigation on the replay page, then the PROFILE link there too.

- Sounds (the game's sfx are reusable: `src/audio`, driven from the sim events).
- Per-player history ("my matches") and links shared from the end-of-match screen.
- Replays of matches hosted by the project's own MatchDO (they are not recorded today).
- Keeping old builds playable (load the release's wasm and JS for an old replay).
- A faster seek (periodic state snapshots instead of re-simulating from the start).

## Trying it locally

`node nodes/scripts/make-test-replay.mjs` writes `replays-dev/test.tgr` (git-ignored); with
`npm run dev`, open `http://localhost:5173/replay.html?file=/replays-dev/test.tgr` (`?file=` exists
only in development). The list needs the Worker with the node settings.

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
before it reports the end; the bucket's lifecycle rule deletes objects after 30 days.

## Who can see what

| | Before | Now |
|---|---|---|
| List of matches | nobody | anyone, guests included: `GET /nodes/replays` |
| Replay bytes | the verifier node (signed request) | anyone: `GET /nodes/replays/<matchId>/view` (the signed verifier route is unchanged) |

Only matches the control plane settled **without voiding them** are listed: rated matches (always
verified) and casual ones (`verified` says whether a verifier re-simulated it; casual matches are
verified by sample). A voided match (failed verification, missing report, timeout) is never listed
or served, even though its replay may still be in R2: it may be a tampered recording.

### Privacy

- **Names come from the control plane** (`assign.roster`, what the matchmaker placed), never from the
  replay header: a node writes whatever names it likes there and the verifier does not compare them.
- **No account ids.** An account id is stable across renames, so publishing it would link every
  match an account plays. The list carries none and the served header has every `playerId`
  blanked (`""` still decodes). The node id is blanked too (`/nodes/status` never shows it either).
- Names are already public on the leaderboard; the list adds which matches a name played.

### Integrity

The served bytes are the node's upload: the Worker checks the R2 object's SHA-256 against the one the
control plane recorded at upload (the index keeps it) and answers 404 otherwise. Only the header is
rewritten; the records after it are copied byte for byte, so the re-simulation is the recorded one.

## How it is built

**Index** (`server/src/replayIndex.ts`, `server/src/nodeStore.ts`): a `replay_index` table in the
NodeRegistryDO's SQLite, one row per listed match, written by `NodeStore.finished` right after the
transaction that settles the match (a failure there only leaves the match unlisted; it never blocks
a settlement), pruned after 30 days like R2. Matches settled before this deploy are not listed (the
control plane forgets a finished match after 10 minutes, so there is nothing to backfill from but
the node-written headers).

**Routes** (`server/src/nodeRoutes.ts`): the list asks the object once per isolate every 30 s for
the first page (the object also serves every node heartbeat); later pages ask it for one page. A
view is answered from the edge cache (Cache API) once someone watched that match; a miss asks the
object for the indexed row and reads the bytes from R2 in the Worker, never through the object, at
most 4 MiB (a real match is far smaller; anything bigger is junk a node stored). Per-address limits:
60 list pages and 30 views a minute.

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

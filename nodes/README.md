# Turbogol community nodes

Match servers run by the community, from a rented VPS to a home PC behind a router, coordinated by
the project's control plane. The control plane registers them, places matches on them, **verifies
results by re-simulating the match** (every ranked match, casual ones by sample) and rewards the
people who run them with points that unlock new items in the game. En español: [README.es.md](README.es.md).

**Status:** a working prototype, not wired into the game yet: the control plane is in the Worker
(`server/`), but the matchmaker does not send it matches. What is missing before real players use
it is listed (in Spanish) in [docs/PRODUCCION.md](docs/PRODUCCION.md).

## Why it is safe to accept anyone's machine

The simulation is deterministic: the same `rocketsim.wasm`, a fixed 120 Hz step, seeded kickoffs,
and bots and match rules without clocks or randomness. A node records a compact replay of every
match (the controls it applied to each human, plus a state hash every second) and never writes a
result itself. A trusted verifier re-runs the match with the same code and compares every hash,
the score and the ending before any rating or reward is written. A node that lies is caught at
the next checkpoint, suspended, and its points are frozen.

Every ranked match is verified: protecting the ranking is the point. Casual matches are verified
by sample: all of a node's while it is on probation, a share once it is active (only verified
matches earn points), none on the project's own nodes.

## How players reach a node

| Transport | For | How |
|---|---|---|
| `wss` | A machine with a public IP (a VPS) | WebSocket over TLS straight to the server, under a DNS name (the control plane runs on Cloudflare Workers, which cannot fetch a bare IP). Caddy gets the Let's Encrypt certificate. The current game client works unchanged. |
| `rtc` | A home PC behind NAT or CGNAT | One reliable, ordered WebRTC DataChannel with ICE (STUN, TURN). Nothing to open. The client wraps it as a WebSocket with a one-line change (`client/rtcSocket.ts`). |

Both speak exactly the protocol of the existing Durable Object host, so a match on a community node
looks the same to the game.

## Try it

Node.js 24 is required. Run `npm install` in the repository root and in `server/` first (the node
uses the game's wasm and code; the typecheck uses the root TypeScript), then, in `nodes/`:

```bash
npm install
```

```bash
npm test
```

```bash
npm run demo
```

The demo starts a control plane on port 8790, the project's trusted verifier, a home PC (WebRTC)
and a server (WebSocket, port 7350), plays a casual match through WebRTC with the game's real
`NetClient` and a ranked match, verifies both, and keeps `http://127.0.0.1:8790/host` open (sign
in as `Demo`).

## Layout

| Folder | Contents |
|---|---|
| `shared/` | Replay format, verifier, node tickets (Ed25519), control protocol |
| `node/` | The node program: runtime, match room (a port of `MatchDO`), WebSocket and WebRTC transports, launcher with signed self-updates |
| `client/` | The WebRTC socket adapter for the game client |
| `control-plane/` | Registry, scheduler, signaling, verification queue, rewards ledger, hosts' shop, reference server |
| `install/` | Installers: Linux servers, Windows, macOS and Linux desktops |
| `web/` | The "host a server" page and the browser WebRTC harness |
| `docs/` | Design documents (Spanish) |

## License

AGPL-3.0-or-later, like the rest of Turbogol.

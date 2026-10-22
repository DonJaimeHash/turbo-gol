# Fase 2: P2P con rollback determinista en malla (casual)

Objetivo: partidos casuales entre 2–6 navegadores **sin servidor de simulación**. Cada par corre la
misma física (RocketSim WASM), los mismos bots (sembrados) y el mismo flujo de partido; sólo se
intercambian inputs. Cloudflare sólo señaliza (RoomDO con WebSockets hibernables) y da STUN
(`stun.cloudflare.com:3478`), con TURN opcional cuando existan credenciales. La fase 1 (autoridad en
Durable Object) queda como fallback cuando no hay un segundo humano o cuando la malla falla.

Contrato: `src/net/p2p/protocol.ts` (DONE). Decisiones: `docs/online/DECISIONS.md`. Mediciones de la
fase 1: `docs/online/MEASUREMENTS.md` (139 ms al DO en Miami; el P2P dentro del Cono Sur debe dar
20–60 ms).

## Layout

```
src/net/p2p/
  protocol.ts        (DONE) señalización JSON + paquetes binarios de la malla + QueueResultP2p
  Rollback.ts        motor de lockstep con rollback (GGPO): timelines confirmada y predicha, hashes, timesync, drops
  Mesh.ts            WebRTC: una RTCPeerConnection por par (perfect negotiation: el slot menor es "impolite"), canales 'game' (unordered, maxRetransmits 0) y 'ctl' (reliable), estadísticas (host/srflx/relay, RTT por par), reconexión ICE
  RoomClient.ts      WebSocket a /room/:id con el ticket en el subprotocolo; mensajes RoomServerMessage/RoomClientMessage; ping/pong para el offset de reloj
  P2PSession.ts      integra todo en el Game loop (como OnlineSession): join → mesh → ready → start → ticks; HUD stats; fallback a OnlineSession (DO) si la malla no cierra en 10 s
server/src/
  RoomDO.ts          sala de señalización (Hibernation API + setWebSocketAutoResponse): roster, relay de 'signal', ready/start, drop por 'unreachable' (mayoría) o cierre de socket, TTL
  MatchmakerDO.ts    cola kind 'p2p' (humanos 2/4/6; a los 15 s con ≥ 2 humanos arma sala con bots; 1 humano → partido en DO como fase 1); tickets role 'peer'
  index.ts           GET /room/:roomId (upgrade con ticket role 'peer' → RoomDO), GET /api/ice (iceServers: STUN de Cloudflare + TURN si hay TURN_KEY_ID/TURN_KEY_TOKEN: credenciales de 10 min vía la API de Realtime TURN)
```

## Motor de rollback (`Rollback.ts`)

```ts
export interface RollbackSim { saveState(out: Uint8Array): number; loadState(blob: Uint8Array, len?: number): void; stateHash(): number; setControlsPacked(packed: Int8Array, n: number): void; step(n?: number): void; sync(): void; readonly tickCount: number }
export interface RollbackHooks {
  /** Inputs de los slots bot para el tick T (estado confirmado en T-1 ya aplicado); sólo se llama en la timeline confirmada, una vez por tick, en orden. */
  botInputs(tick: number, packedOut: Int8Array): void;
  /** Flujo de partido en la timeline confirmada (Match.tick(TICK_DT), goles leídos del estado): una vez por tick confirmado. */
  onConfirmedTick(tick: number): void;
  /** resync(tick) cargó el estado de la mayoría en `tick`: realinear Match / bots (checkpoint) antes de que los hooks vuelvan a correr desde tick+1. */
  onResync?(tick: number): void;
  /** drop(slot, atTick) con atTick ya confirmado: el motor volvió al snapshot de atTick-1; restaurar el checkpoint de ese tick. */
  onRewind?(tick: number): void;
}
export class RollbackEngine {
  constructor(sim: RollbackSim, numSlots: number, humanSlots: readonly number[], localSlot: number, hooks: RollbackHooks, opts?: { inputDelay?: number; window?: number; historyTicks?: number; hashEvery?: number })
  readonly tick: number;            // tick predicho actual (el que se renderiza)
  readonly confirmedTick: number;   // F: último tick con todos los inputs humanos conocidos y simulado en la timeline confirmada
  addLocalInput(packed: Int8Array, off: number): number;   // registra el input local para tick+inputDelay; devuelve ese tick
  addRemoteInput(slot: number, firstTick: number, count: number, packed: Int8Array): void;  // ignora ticks ya confirmados; marca rollback si difiere de la predicción
  canAdvance(): boolean;            // false si tick - confirmedTick >= window (stall: esperar inputs) o si hay que frenar por timesync
  advance(): void;                  // 1) si hay inputs nuevos para ticks ≤ tick: rollback al snapshot confirmado F, re-simular F+1..F' confirmando (botInputs + onConfirmedTick por tick) y guardar snapshot en F'; luego re-simular F'+1..tick con predicción (hold-last por slot); 2) simular el tick+1 predicho; sync()
  predictedInputFor(slot, tick): hold-last del slot (último input conocido)
  framesAhead(): number;            // tick - min(remote myTick reportados) → timesync: si > 2, el session salta un tick
  noteRemoteTick(slot, myTick): void;
  confirmedHashes(): Iterable<{tick, hash}>  // hashes en ticks múltiplos de hashEvery, para enviar por 'ctl'
  receiveHash(slot, tick, hash): 'agree' | 'disagree' | 'unknown';   // votación por mayoría; expone onHashDecided(tick, agreed) por voto decidido y onDesync(tick, mine, majority, agree, disagree) cuando el mío no es la mayoría; ignora ticks > tick + 96 (el ring no se resetea desde el futuro)
  voteOf(slot, tick): number;       // el hash que votó `slot` en ese tick (-1 si no votó): elige el par al que pedir el estado
  stateAt(tick): { blob, len, hash } | null;  // snapshots confirmados guardados (historyTicks)
  resync(tick, blob, len): void;    // carga el estado confirmado de la mayoría; descarta predicción; hooks.onResync
  drop(slot, atTick): void;         // desde atTick el slot pasa a bot; atTick ya confirmado -> rebobina al snapshot de atTick-1 (hooks.onRewind, stats.rewinds) y re-confirma; sin snapshot -> F+1 (stats.lateDrops)
  stats: { rollbacks, resimTicks, stalls, throttles, desyncs, resyncs, rewinds, lateDrops, predictedAhead }
}
```

El motor sincroniza el sim sin eventos (`RollbackSim.syncQuiet`, `RocketSimBridge.syncQuiet`) en cada paso
confirmado y en cada tick re-predicho salvo el último: un rollback nunca vuelve a disparar los `onBallHit` /
`onBump` de ticks ya reportados; sólo el `sync()` final de `advance()` dispara los del tick nuevo.

```ts
// P2PSession: checkpoints de la timeline confirmada (lo que el hash del sim no cubre)
// Por tick confirmado (ring de 64, como los snapshots del motor) y por hash tick (ring de 16): Match.saveState
// (fase, marcador, relojes, countdown, pausa de gol), kickoffs (seed del próximo rs_reset_kickoff), wasScored,
// isBot por slot y BotTeam.saveState de ambos equipos (roles, timers, y Bot.saveState: RNG, filtros de ruido,
// secuencia de salto, outputs retenidos, target suavizado, TeamContext). onResync / onRewind restauran el
// checkpoint del tick antes de que el motor re-corra los hooks; un StateResponse lleva el checkpoint del que
// responde como trailer del blob (protocol.ts splitStateTrailer), así el que resincroniza adopta el Match y los
// bots de la MAYORÍA, no sólo su sim. Los eventos de Match re-emitidos durante ese replay no llegan al Game.
```
```

Reglas:
- Inputs del slot local: 6 int8 (packControls) en el tick `tick + inputDelay`; se envían cada 2 ticks con todos los ticks no confirmados por cada par (tope 16), `ackTick` = el tick más nuevo recibido de ese par.
- Predicción de remotos: hold-last. Al llegar un input distinto para un tick ≤ `tick` → rollback (la re-simulación cuesta ~10 µs/tick; 16 ticks × 30 veces/s ≈ 5 ms/s).
- Los bots y `Match` SOLO corren en la timeline confirmada (sin RNG ni eventos en la predicción). Las vistas renderizan la timeline predicha; el HUD muestra reloj y marcador de la confirmada.
- Hash cada 30 ticks confirmados por el canal fiable; mayoría ≥ 2 pares (1v1: cualquier diferencia → resync desde el slot menor, que se toma como referencia). La racha de minoría la lleva el resultado del voto (`onHashDecided`), no el 'agree' suelto de un par (en un 2-2 el compañero siempre coincide). Minoría dos veces seguidas → `StateRequest` al par cuyo voto es el de la mayoría (`voteOf`); sólo se acepta la respuesta pedida (ese par, ese tick, hash = el de la mayoría y fnv1a32(blob) = hash); una respuesta que no llega en un período de hash se vuelve a pedir; minoría otra vez tras un resync (tercera) → abandonar la sala (la partida se anula, sin MMR); cinco sin respuesta → abandonar.
- Predicción de pelota: `updateBallPrediction()` en cada tick confirmado y, en los ticks acordados (el siguiente a cada hash tick y cada tick de drop), `forceBallPrediction()` (re-predicción completa): el tracker del wasm reutiliza su predicción mientras la pelota real queda dentro de una tolerancia (0,8 uu), así que dos arenas con el mismo estado pero distinta historia de cargas (un par que resincronizó o rebobinó) tendrían predicciones levemente distintas y bots que deciden distinto. Un resync cae en un hash tick y un rebobinado en un tick de drop, donde todos re-predicen completo desde el mismo estado.
- Timesync: cada paquete lleva `myTick` y `ackTick`; si estoy por delante del par más lento (`leadEstimate() > 2`), salto un tick por frame (el loop no simula ese frame; los inputs más nuevos se siguen reenviando cada 50 ms mientras tanto, como en un stall). Si estoy más de `window` por delante de la confirmación → stall (pausa de sim, HUD "esperando a X").
- Caída de un par: la malla lo detecta (sin paquetes 2 s desde mi primer tick local + `iceConnectionState` failed) → `unreachable {slot, atTick = contiguousInputTick(slot)+1}` al RoomDO (sólo en partido: antes del start una malla que falla es el fallback del propio cliente, y el RoomDO ignora esos reportes) → el RoomDO anuncia `drop {slot, atTick = min(ticks reportados)}` → todos aplican `drop` en el mismo tick: su auto pasa a la IA de equipo (BotTeam con el seed de la sala) de forma determinista; un par que ya había confirmado más allá (recibió los últimos paquetes del caído) rebobina al snapshot de atTick-1 y re-confirma con el bot. Sin socket a la sala, un par muerto no se puede coordinar: la sesión termina con aviso.
- Arranque sincronizado: `start.startAt` (reloj del servidor) + offset estimado por ping/pong al RoomDO (la muestra gruesa del welcome se descarta con el primer pong); tick 0 = `startAt`; Match hace el countdown desde el tick 0 (3 s = 360 ticks confirmados). `ready` sólo cuando TODOS los slots humanos que no se fueron están en la malla y conectados (`mesh.expectedCount() === remainingPeers()`, al menos uno); el RoomDO no arranca mientras un slot de par esté ausente sin `left` y lo declara no-show a los `P2P_NO_SHOW_MS` (6 s) de creada la sala (`peerLeft` con peerId vacío → los presentes mandan `ready` → `start` + `drop { slot, 0 }`); si antes del start se van todos los demás pares → partido en servidor de inmediato; si en 10 s desde el welcome no llegó `start` (malla incompleta o la sala no arrancó) → partido en servidor. El RoomDO vuelve a evaluar el start cuando se cierra un socket antes del arranque (un par no listo que se va no deja esperando a los listos).

## Flujo

1. Menú ONLINE: "Quick match" usa `kind: 'p2p'` (casual). "Partido en servidor" usa `kind: 'server'` (fase 1, también ranked en el futuro).
2. POST /api/queue → `QueueResultP2p` (o el `QueueResult` de servidor si hubo fallback).
3. `RoomClient` abre `/room/:id` con el ticket → `RoomWelcome` (seed, slots, iceServers, you) → `Mesh` conecta con cada par con `connected: true` (el slot menor hace la oferta) → cuando la malla está completa y el wasm/arena/roster están listos → `ready` → `start`.
4. `P2PSession.advance(dt)`: acumulador de 8,333 ms; por tick: `engine.canAdvance()`; input local → `engine.addLocalInput` + envío a todos; `engine.advance()`; cada 2 ticks envío; hashes confirmados → 'ctl'; paquetes entrantes → `addRemoteInput` / `receiveHash` / state resync.
5. Fin: `Match` (confirmado) emite `ended` → resultado local (sin MMR en fase 2) → volver al menú; cierre de la sala.

## Pruebas

- `tests/p2p-rollback-wasm.test.mjs`: 2 y 6 motores con el wasm real, inputs aleatorios, entrega con delay/jitter/pérdida simulados (incl. reordenamiento): los hashes confirmados coinciden en todos los pares en todos los ticks múltiplos de 30; con bots (BotTeam sembrado) también; drop de un slot en un tick acordado → siguen coincidiendo; drop en `min(contiguousInputTick)+1` con un par que ya confirmó más allá → rebobina y siguen coincidiendo; resync tras una divergencia inyectada.
- `tests/p2p-session.test.mjs` (motor real + wasm + bots): dos sesiones 2v2, un gol guionado, un par corrompido (estado ajeno + reloj alterado) → minoría dos veces → StateRequest → resync con trailer → hashes, marcador, reloj y kickoffs idénticos después.
- `tests/p2p-checkpoint.test.mjs`: round trip de Match / Bot / BotTeam save-load; un equipo restaurado en el tick k reproduce exactamente sus controles (incl. un cambio de layout posterior).
- `server/test/room.test.mjs`: además de las funciones puras, el RoomDO sobre fakes (storage, sockets, upgrade): un par no listo que cierra completa el start, unreachable pre-start ignorado y drop al mínimo reportado, ráfaga de 200 candidatos sin kick.
- `tests/p2p-protocol.test.mjs`: round-trips de todos los paquetes.
- `server/test/room.test.mjs` + smoke: dos clientes WebSocket falsos se señalizan a través del RoomDO (offer/answer/ice relay, ready → start, unreachable → drop).
- Navegador: dos pestañas del panel en el mismo sitio desplegado (o `wrangler dev`) hacen quick match P2P 1v1 → malla por candidatos host/srflx → partido jugable; `desyncs 0`; una pestaña se cierra → la otra sigue contra la IA.

## Verification (integration, 2026-10-14, Windows 11, Chrome in the Claude desktop browser pane)

Node (`node --test "tests/*.test.mjs"` 260/260, `cd server && npm test` 32/32, `npx tsc --noEmit` and
`npx tsc --noEmit -p server` clean):
- `tests/p2p-rollback-wasm.test.mjs`: 2 humans with 2-8 tick jitter, 5 % loss and reordering → identical
  hashes at every tick multiple of 30, 0 desyncs; 3v3 with 2 humans + 4 seeded bots + Match → identical
  hashes and identical event sequences; drop at tick 600 → identical afterwards; injected divergence →
  desync detected at the next hash tick → `stateAt` / `resync` → agreement 30 ticks later; silent peer →
  stall after 16 ticks and resume; 6 engines × 600 ticks identical; `advance()` 37-40 µs average.
- `tests/p2p-session.test.mjs`: two `P2PSession`s on the real engine, wasm and BotTeams (2v2, 20 ms links,
  60 fps, 6 s): confirmed tick 718 on both, 0 desyncs, 23/23 hash votes agreed, identical events.
- `node server/test/smoke-p2p.mjs` against `wrangler dev --port 8787`: ALL OK in 22.5 s — two guests
  matched into one p2p room 0.04 s after queueing, 409 `active_match` with `kind`, `/api/ice` (STUN),
  welcome checks, reused ticket refused, signal relay both ways, pong 4 ms, ready → `start` with the
  same `startAt` (now + 1500 ms) 1 ms after the last ready, `unreachable` → `drop { 1, 160 }` on both,
  re-queue right after closing the room socket, 2v2 with 4 humans (start, grace-alarm drop 5.1 s after a
  single report with the socket closed, majority drop), lone guest → server match after 15.4 s.

Browser, two tabs on one machine (`localhost:5174` and `127.0.0.1:5174`, Vite → `wrangler dev`):
- Matchmaking: both tabs matched into the same room 136 / 178 ms after queueing (same seed, slots 0 / 1);
  mesh complete over **host** candidates; `start` 1.54 s after the welcome; the two tabs placed tick 0
  within **2 ms** of each other on the wall clock.
- Play (A driving with throttle + boost, B idle): both at 120 ticks/s with tick − confirmedTick **0-1**
  (`ahead` 2 raw), per-peer RTT **0-1 ms**, rollbacks 1-8 /s (B re-simulates A's inputs, resim 8-28
  ticks/s), stall frames 0 and timesync skips 0 during normal play, ~1.8-2.5 KB/s each way,
  **desyncs 0** over ~110 s: 1660 hash votes agreed, 0 disagreed, resyncs 0; identical clock and score
  on both HUDs; frame cost 0.3-0.5 ms (sim + rollback, 1×1 canvas while the pane was hidden).
- Drop: B called `leave()` (room socket + mesh closed) → A's mesh marked the link dead **2 ms** later
  (channel close) and reported `unreachable`; the room's `drop { slot 1, atTick 12966 }` (reported tick
  12906 + 60) reached A **29 ms** after the leave; banner "Guest468 se desconectó / Su auto pasa a la IA",
  scoreboard row tagged BOT, panel row `dropped`; A kept running at 120 ticks/s (360 ticks in 3 s, ahead
  0, no new stalls) with desyncs 0 while the team AI drove the dropped car, until the whistle (0:01).

Found and fixed by the integration:
- The Worker's Origin gate refused every browser upgrade under `wrangler dev` (the committed
  `VITE_ORIGINS` names the deploy; the matchmaker returns the absolute `ws://127.0.0.1:8787/room/<id>`,
  so the page does not go through the Vite proxy): 403 `bad_origin` → "Sala cerrada (1006)". Loopback
  page origins are now accepted while the Worker itself runs on a loopback host (never on a deploy).
- A backlog longer than one batch (16 ticks, after a stall) was sent as one packet holding only the
  newest 16 ticks, and acks carried the newest received tick: a hole could never be refilled and both
  peers would wait for each other for good. The session now sends the backlog as several packets
  (oldest first) and acknowledges the tick up to which it holds *all* of a peer's inputs.
- The per-match HUD counters (stalls, hashes, skips) were cumulative across rooms.

Harness notes (the browser pane): the pane fronts one tab at a time and Chrome clamps a background
tab's main-thread timers to 1 Hz (and to 1/min after 5 minutes hidden), so a `requestAnimationFrame`
→ `setTimeout` shim is not enough: the background tab ran 1-2 frames/s and, because the two peers run
in lockstep (each may only predict 16 ticks past the inputs it holds), the pair fell up to 46 s behind
the wall clock and caught up at 320-600 ticks/s once both ran again. Driving the frame loop from a
Web Worker (`setInterval` in the worker, `postMessage` to the page) keeps both tabs at ~60 fps while
hidden; the numbers above are from that setup. Replacing the worker's `onmessage` while a frame was
pending orphaned the loop once (the peer was dropped after 2 s, as designed).

## Review fixes (2026-10-14, after the integration)

Applied from the reviewer's list (node: `tests/p2p-*.test.mjs` incl. the new `p2p-checkpoint`, `server/test/room.test.mjs`
with a RoomDO harness on fakes, `server/test/smoke-p2p.mjs` vs `wrangler dev`):
- Pre-start: `ready` needs a non-empty complete mesh; every other peer gone → immediate server fallback; 10 s
  without `start` → fallback on both branches. RoomDO re-runs `maybeStart` on every pre-start socket loss
  (and after `reconcileSockets` on a wake-up), ignores `unreachable` before the start, burst 400 messages.
- Resync realigns everything: checkpoint ring (Match / kickoffs / scored flag / bot layout / BotTeams) per
  confirmed tick + per hash tick, restored in `onResync` / `onRewind`; the StateResponse carries the answering
  peer's checkpoint as a trailer so the majority's Match / bots are adopted too; forced full ball re-prediction
  at agreed ticks (the wasm got `rs_ball_pred_force`) so the prediction tracker's history cannot differ.
- Minority streak driven by the decided vote (`onHashDecided`), resync source by `voteOf`, StateResponse
  verified (requested peer / tick, majority hash, blob hash), lost answers re-requested.
- Drop tick = min over the peers of `contiguousInputTick + 1` (no lead); `RollbackEngine.drop` rewinds to
  atTick-1 when already confirmed (`stats.rewinds`); `lateDrops` only when the snapshot is gone.
- Throttle: one skip per frame, inputs keep going out (`throttleFrames`). Liveness armed on the first local
  step. Room parameters clamped, engine construction failure → menu with the offline roster back. Room socket
  lost with a dead peer / pending drop → the session ends with a notice. Hash reports every 10 s or on a
  disagreement; room pings every 15 s once the match runs. Welcome's coarse clock sample dropped by the
  first pong. No per-packet DataView / subarray on the send / receive path. Engine syncs quietly during
  re-simulation (no re-fired FX). Matchmaker: p2p rooms have their own cap (200) apart from the 20 DO matches.

## Lock release, staggered joins, debug log (2026-10-14, after the first deploy runs)

Observed on the deploy (two tabs, both humans, the signaling DO ~140 ms away): both tabs reached one room
but one left within ~2 s (state idle, error null), the other fell back ('Los demás jugadores se fueron');
afterwards every `POST /api/queue` of both answered 409 `active_match`, `/api/rejoin` with the room id
answered 400, and each ended up alone in the P2P queue. Root causes found and fixed:

- **Stale locks**: the RoomDO releases a peer's lock only from its socket-close path (`ctx.waitUntil` →
  matchmaker `/release`), and the client re-queued (the fallback's own server queue included) BEFORE that
  close was processed, so the matchmaker still held the lock → 409. The phase 1 `NetClient` then called
  `/api/rejoin` with the ROOM id → `MATCH.idFromString` threw → 400 → the session failed; and a peer
  whose `/room` upgrade never happened kept its lock up to the room TTL. Now:
  - `MatchmakerDO /join` answers 409 only while the player is REALLY held: a lock younger than
    `LOCK_VERIFY_AFTER_MS` (2 s) is trusted; an older one is verified against the object (`RoomDO
    GET /internal/presence?playerId=`: a live socket holds, a slot that had a socket and lost it / left /
    was dropped does not, a slot that never connected holds only `JOIN_GRACE_MS` = 10 s after issue;
    `MatchDO GET /internal/status`: `ended` / `reset` / no record frees) and released when stale
    (`roomHoldsPlayer`, pure). An unreachable object keeps the lock (fail safe; `/leave` frees it).
  - `POST /api/leave { matchId? }` (matchmaker `/leave`) also frees the player's p2p room lock: the lock is
    deleted FIRST (a join right after sees it gone), then the RoomDO is told (`POST /internal/leave
    { playerId }`: a live socket is closed 1000 'left' → the close path: `peerLeft`, release, start
    re-evaluation; a slot that never connected is marked `left` and announced with `peerLeft { peerId: '' }`).
    A MatchDO lock is not released here without its `matchId` (phase 1 rejoins it); with it, it is (the
    explicit quit, docs/online/PHASE1.md flow 6). Answer `{ ok, left, released }`.
  - `POST /api/rejoin` with a RoomDO id answers 410 `p2p_room` (never 400 / a MatchDO lookup).
  - `NetClient.queue`: 409 `active_match` of kind `p2p` → `/api/leave { matchId }` once, then the queue is
    retried; kind `server` → rejoin as before on a server queue (a P2P queue leaves it instead and retries,
    PHASE1.md flow 6), and a rejoin that answers 404 / 410 (lock freed by the
    Worker; `p2p_room` leaves first) retries the queue once. A second 409 rejects with the server's
    `message` (the menu shows the real reason; every `queue failed (...)` message now carries it).
    `NetClient.leaveMatch()` (`POST /api/leave`) is called by `P2PSession.teardown()` whenever a room was
    assigned (fallback, leave, cancel, failure, the final whistle) and the next `queue()` waits for it, so
    the fallback's server queue can never be refused by our own stale lock.
  - The RoomDO marks a slot `left` for good when its socket closes (single-use ticket) or after
    `/internal/leave`; the welcome's `RoomSlot.left` tells a later joiner not to wait for it
    (`P2PSession` counts it as gone, like a `peerLeft`). A wake-up that finds sockets vanished
    (`reconcileSockets`) now broadcasts `peerLeft` and releases those locks too.
- **The 2 s leave**: `Game` returns to the menu `MENU_RETURN_SECONDS` after a whistle (`menuReturnAt`), and
  `showMenu()` leaves the current session — a P2P session started from the console / menu while that
  timer of the previous match was still pending was left by it (state idle, error null, nothing in the
  session's own log). `startP2P` / `startOnline` clear the timer and the auto-return is skipped while a
  session is busy or in a match.
- **Staggered joins**: the room relays a signal only to a slot that has a socket; an offer sent before the
  target joined was silently dropped, and so were its trickle candidates. The RoomDO now answers the sender
  `error { code: 'signal_dropped', to }` (routed by `RoomClient.onSignalDropped` to the mesh, never fatal),
  and the offering (lower) side keeps its last offer plus the candidates sent since and re-sends them on
  `peerJoined` (`Mesh.reoffer`, the session calls it for every joined peer) or after `OFFER_RETRY_MS` = 2 s
  without an answer, `OFFER_MAX_TRIES` = 3 per joined target; an answer / a connected link / applying the
  peer's own offer stops the retries, and a duplicate answer to a re-sent offer is ignored. The session's
  `FALLBACK_MS` window restarts on every `peerJoined`; 'nobody left' only when every other human slot
  actually left (`peerLeft` / `left`), never for a slot that has not joined yet.
- **Debug log**: `P2PSession.log` (`src/net/p2p/DebugLog.ts`, a 256-entry ring, `window.__game.p2p.log`)
  gets one line per event from the session, the RoomClient and the Mesh: state changes, the queue result
  (kind, room id), the welcome summary (`slots [0:peer* 1:peer]`: `*` connected, `-` left), every signal in /
  out (type only), ICE / connection state changes and channel open / close per peer, re-offers, ready /
  start (startAt, local tick-0 time, clock offset), drops, unreachable reports, hash disagreements, resyncs,
  fallback / failure reasons, the lock release. Nothing per tick. Read it with one call:
  `__game.p2p.log.text()` (or `JSON.stringify(__game.p2p.log)`).

Verified (same setup as above: `node --test "tests/*.test.mjs"` 287/287, `cd server && npm test` 42/42, both
`tsc` clean; `node server/test/smoke-p2p.mjs` vs `wrangler dev` ALL OK, 77 checks in 27 s, including:
signal to an absent slot → `signal_dropped`, `/api/rejoin` with a room id → 410 `p2p_room`, a pre-start
socket close → queue 0.6 s later without 409, `/api/leave` of a never-connected peer → queue at once,
`/api/leave` during a live room → the peer's socket closed by the room, `peerLeft` to the other in 15 ms,
immediate re-queue without 409, the peer still in the room → 409 with the reason; browser, two tabs on
`localhost:5173` / `127.0.0.1:5173` with B's room socket delayed 2 s to force a real staggered join:
A's welcome `[0:peer* 1:peer]`, `peerJoined` 2 s later → window restarted → offer → connected → `start`,
both 'playing' with desyncs 0 (176 / 66 hash votes agreed), B `leave()` mid-match → A got the drop
(`chan.close` → `unreachable 5380` → `peerLeft` → `drop 5380`, no rewind) and kept playing against the AI
(desyncs 0, stalls 0) while B re-queued at once (no 409) and fell back to a server match after 15.5 s; A
then left mid-match, re-queued at once (no 409) and fell back the same way. Note: the matchmaker's kick
sends the close frame (the node client goes CLOSING at once) but under `wrangler dev` the proxied TCP
connection is not torn down by the server, so node's `close` event may never fire (a browser closes the
connection itself after its closing-handshake timeout); the smoke test accepts CLOSING.

Open issues:
- Without a room socket mid-match a dead peer ends the match (no coordination possible); a room rejoin with a
  fresh ticket would let it continue (there is still no room equivalent of /api/rejoin: 410 `p2p_room`).
- Two tabs of the SAME browser profile share the guest record (one playerId): the second tab's queue is a
  double join of the same player. Distinct origins (localhost / 127.0.0.1) or browsers are needed to test
  two humans on one PC; the deploy runs above may have mixed this in.
- The lock verification costs one DO fetch per 409 candidate (only when a lock older than 2 s exists); a
  room that cannot be reached keeps the lock until `/api/leave` or expiry.
- TURN credentials are minted without a monthly-GB quota (DECISIONS.md asks for the 900 GB flag before TURN
  secrets go to production).
- The RoomClient's ping interval is a main-thread timer: hidden > 5 min it stops (stale rttMs / offsetMs;
  harmless after the start). TURN is not exercised locally (no secrets).

## Review fixes 2 (2026-10-14): staggered 2v2/3v3 start, single-use seats, no-show backoff, protocol 2

1. **Staggered 2v2 / 3v3 start (high)**: the room started as soon as two joiners were ready and dropped a
   late human at tick 0. Now `decideStart` refuses while any peer slot is absent without being `left`;
   the RoomDO's no-show pass (`P2P_NO_SHOW_MS` = 6 s after create, alarm; also run by a late `ready`)
   marks never-connected slots `left` (`peerLeft { slot, peerId: '' }`), then the start drops them at
   tick 0. Client gate (`P2PSession.advanceConnecting`): `ready` only when `mesh.expectedCount() ===
   remainingPeers()` and the mesh is all connected (a `ready` cannot be taken back); the status line
   counts the absent peers. A pre-start `peerLeft` that leaves others restarts the `FALLBACK_MS` window
   (10 s; `FALLBACK_MARGIN_MS` = 4 s over the no-show grace, checked by a test). `RollbackEngine.drop`
   maps an `atTick` at or before its base tick to base + 1 (the first simulated tick): the room's
   `drop { slot, 0 }` is neither a late drop nor a rewind, and every peer applies it at the same tick
   (none can confirm a tick without that slot's input or its drop).
2. **Single-use seats (medium)**: `RoomDO.upgrade` answers 403 `left` for a slot flagged left (closed,
   `/internal/leave`, no-show). `MatchmakerDO /join`'s stale-lock release tells the room
   (`/internal/leave`) exactly like `/leave`.
3. **No-show backoff (medium)**: a room ticket that reached the player (`ActiveMatch.delivered`, set when a
   response carried it; a result still waiting for its poll is not the player's fault) and was never
   used is a strike: `/leave` or the stale-lock verification (`/internal/leave` answers
   `everConnected: false`), the start's drop at tick 0 (`/release { noShow }` from `dropSlot`), or the
   cleanup; once per lock. `NO_SHOW_LIMIT` (3) strikes within `NO_SHOW_WINDOW_MS` (10 min) -> p2p
   queues answer 429 `no_show { retryAfterMs }` for `NO_SHOW_BLOCK_MS` (5 min); server queues still
   work. The client shows `noShowStatus(retryAfterMs)` ("Partidas P2P bloqueadas 5 min: ...").
4. **Mesh buffers (low)**: an answer or a connected link drops the kept offer and its candidates
   (`Mesh.dropOffer`); later candidates are not buffered (`offerPending` / `bufferedCandidates` for tests).
5. **Protocol 2 (low)**: `P2P_PROTOCOL_VERSION` 2. A p2p queue carries `p2pProtocol`; the Worker answers
   426 `reload_required` to a p2p queue without it (a version 1 page shows "queue failed (426
   reload_required)" before taking a seat) or with another version. A welcome of another protocol fails
   the RoomClient with `reload_required`; both paths show `STATUS.reload` ("Hay una versión nueva del
   juego: recargá la página").
6. **NetError.serverCode (low)**: every failed API call carries the body's `error` code (`serverCode`) and
   `retryAfterMs`; the 410 `p2p_room` recovery branches on the code (no regex on the message). This also
   fixed `turnstile_unconfigured` with a message being reported as a plain http error.

Verified: `node --test "tests/*.test.mjs"` 295/295, `cd server && npm test` 49/49, both `tsc` clean;
`node server/test/smoke-p2p.mjs` vs `wrangler dev` ALL OK, 100 checks in 39 s, including: p2p queue
without / with another `p2pProtocol` -> 426 `reload_required`; 2v2 staggered join (A and B ready at once,
D and F join 2.1 s later: no start / drop for 2 s, none with 3 of 4 ready, start to all four 2 ms after the
fourth ready, no drop); 2v2 with one ticket never used (`peerLeft { slot, '' }` 6.0 s after the match, then
ready -> start to the three + `drop { slot, 0 }`, the dead ticket refused, its owner queues again without
409); three unused tickets -> 429 `no_show` (retryAfterMs 299 s) while a server queue still works.

Open issues (in addition to the list above):
- ~~A client whose room upgrade is refused (403 `left`) only sees "Sala cerrada (1006)" and does not
  re-queue~~: fixed in review fixes 3 (one automatic re-queue).
- No-show strikes live in the region matchmaker's memory (lost on eviction; per region).
- The no-show pass depends on the room's alarm; a late alarm delays the start (the client's window restarts
  on the resulting `peerLeft`, so it does not fall back meanwhile unless the alarm is > ~4 s late).

## Review fixes 3 (2026-10-14): the TURN await in the room upgrade, slow joiners are not no-shows

1. **Upgrade race (medium)**: `RoomDO.upgrade` checked `left` before `await iceServersFor(env)` (the TURN
   credential fetch, up to `TURN_TIMEOUT_MS` = 3 s, input gate open) and not after it. Meanwhile the
   no-show alarm, `/internal/leave` or the start could give the slot up, and the socket was accepted anyway
   (welcome + its own `drop { slot, 0 }`, or connected with `left: true`: presence then said free and a lock
   verification freed the lock of a player sitting in the room). Now: a slot that is `left` OR dropped is
   refused before and again after the await (403 `left`); while the fetch is in flight the slot is
   `joining` (an in-memory counter per slot): `markNoShows` skips it, so a player that reached the room
   inside the grace is waited for (`decideStart` keeps waiting: absent, not left) and then admitted; an
   upgrade that is not admitted after waiting through the grace (`afterFailedJoin`) is declared a no-show
   at once and the start re-evaluated. The accept path is `admit()`.
2. **No-show backoff vs slow honest joiners (medium)**: the strike counted any slot that never opened its
   socket, even one whose verified ticket reached the room late (a 3G join past the 6 s grace, refused 403
   `left`). Now the room keeps `arrived[slot]` (persisted): a verified ticket of the slot reached it (admitted,
   waiting for TURN, or refused because the slot was given up). `isNoShow` = no socket ever AND not
   arrived; the start drop, the cleanup and `/internal/leave` (new answer field `noShow`, read by the
   matchmaker instead of `everConnected`) use it. A late ticket of a slot that was still a no-show also
   POSTs the matchmaker `/forgive { matchId, playerId }` (once per slot, background): `NoShowEntry` keeps
   the room ids of its strikes (`rooms`, newest `NO_SHOW_ROOMS_KEPT` = 8; a room counts once), and
   `forgiveNoShow` takes back only that room's strike; a forgive that overtakes its strike (the start
   drop's release still in flight) is remembered for the window and cancels it. Not fixed: a griefer that
   opens the socket and never says `ready` still costs its partners the `FALLBACK_MS` wait without a
   strike (a peer that never says ready cannot be told apart from an honest one with a hidden tab or a
   failed link from the room's side).
3. **Client re-queue (optional part of 2)**: a room socket that closes before the welcome (browsers show
   only 1006 for a refused upgrade) releases the lock and queues again by itself, once per `quickMatch`
   (`STATUS.requeue` "No se pudo entrar a la sala: buscando otra…"); a second one fails to the menu as
   before ("Sala cerrada (1006)"). A close after the welcome still fails at once.

Verified: `node --test "tests/*.test.mjs"` 296/296, `cd server && npm test` 57/57, both `tsc` clean;
new tests: an upgrade waiting for TURN through the grace is admitted and plays (no peerLeft, no drop, no
release); `/internal/leave` during the await -> 403 `left`, `noShow: false`, the start drop without
`noShow`; a failed upgrade after the grace -> declared then, the ready ones start; a late ticket after the
start -> 403 + one `/forgive`, the cleanup names nobody; a late ticket before the start -> the start drop
without `noShow`; `recordNoShow` / `forgiveNoShow`; `/forgive` scoped and idempotent, a forgive before its
strike cancels it; a real RoomDO + MatchmakerDO pair (ticket verified as the Worker does): three 2v2 rooms
in a row where A's ticket arrives after the grace -> strike then forgiven each time, A never blocked; the
session re-queues once after a pre-welcome close. Mutations (no `joining` skip, no re-check after the await,
no forgive, `arrived` ignored, no `afterFailedJoin`, no forgive memo) each fail at least one test.
`node server/test/smoke-p2p.mjs` vs `wrangler dev` ALL OK, 102 checks in 41 s (8g's late ticket is
refused and forgiven: 8h now needs three fresh strikes, and two do not block).

## Verificación en el deploy real (2026-10-15)

el Worker de desarrollo del mantenedor, commit `204beae`. Cliente: dos pestañas del panel
del navegador de la app en la misma PC (Argentina), cada una con su propio invitado, frames
manejados por un Web Worker (las pestañas en segundo plano del panel no disparan rAF).

| Etapa | Resultado |
|---|---|
| Cola → sala | ambas en la misma sala P2P 1v1 en < 1 s |
| Señalización (RoomDO en ENAM) | oferta/respuesta/ICE relayados; RTT del ping a la sala 138 ms |
| Malla WebRTC | candidato `host` (misma máquina), canales `game` y `ctl` abiertos ~1,3 s después del welcome |
| Arranque | `ready` → `start` (+1500 ms en el reloj del servidor); tick 0 en ambas, countdown, juego |
| 15 s de juego con A manejando | ticks 4335/4340, confirmado = predicho (+0), 0 stalls, 0 throttles, rollbacks 2 (A) / 2 (B), mispredictions 16 en B, **0 desyncs**, 123 votos de hash coincidentes y 0 en contra |
| Tráfico por par | ~1,6 KB/s en cada sentido (sólo inputs) |
| Caída de B (`leave`) | A detecta el cierre del canal al instante → `unreachable` → la sala decide `drop {slot 0, atTick 5644}` en 170 ms → el auto pasa a la IA (692 uu/s), A sigue a 120 Hz con 0 desyncs |

Smokes contra el deploy en la misma versión: `server/test/smoke.mjs` PASSED (host ATL, RTT p50 155 ms,
0 desyncs) y `server/test/smoke-p2p.mjs` ALL OK (102 chequeos, tres corridas).

Pendiente de medir: dos máquinas en redes distintas (candidatos `srflx`/`relay`, RTT real entre
ISPs argentinos, tasa de TURN). Con una sola PC sólo se ejercita el candidato `host`.

## Experimental rules (protocol 5, 2026-10-21)

A custom lobby whose signed-in host picked a physics preset (Settings > Experimental, design PR 4)
plays a P2P room with those rules. What changed on the P2P path:

- **Protocol 5** (`P2P_PROTOCOL_VERSION`, `ROOM_PROTOCOL`): `RoomWelcome.physics` (always present,
  null = standard) and `{ type: 'ready', physicsFp }`. `PROTOCOL_VERSION` (phase 1) stays 3: the
  golden stock trace is unchanged.
- **The rules travel once** (lobby settings, `/custom`, RoomDO `/internal/create`, every welcome)
  and are checked strictly at each step (`parseLobbyRules`); RoomClient refuses a welcome without
  them or with rules it cannot read (`bad_physics`: the menu says reload).
- **Applied before the cars**: `Game.applyP2PRoster` calls `createArena(TICK_RATE,
  arenaMutators(physics))`, then `addCar` per slot, then `resetKickoff(seed)`. Both BotTeams plan
  with `botPhysicsOf(physics.values)`. The same integers give the same f32 config on every peer.
- **The ready fingerprint**: the state hash does not cover the config, so `ready` carries
  `mutatorFingerprint(sim.getMutators())` and the room compares it with `physicsFingerprint(rules)`.
  A mismatch (or no fingerprint with rules) gets `error physics_mismatch` and the socket closed with
  4005: the slot is left (never a no-show), the others start with its car the team AI. A standard
  room refuses a preset fingerprint too, and lets a ready without one through (headless tools).
- **No fallback, no strikes**: a room with rules never hands over to a casual server match (the
  mesh timing out, or everybody else gone before the start, fails back to the lobby), never names a
  no-show, and the matchmaker marks its locks so a strike cannot be counted for it either.

Verified (2026-10-21, wrangler dev + Vite on this machine, two built-in browser tabs on different
loopback origins, so two accounts, frames driven by a timer because the pane was hidden):

| Step | Result |
|---|---|
| Host (switch on) | the rules row lists Standard, the built-ins and a user preset; Server hides and clears it; EDIT PRESETS opens Settings > Experimental and comes back with the draft |
| Lobby list | `EXP` for a signed-in player, `🔒 EXP` for a guest, the rules in the tooltip; a guest's click says "Experimental lobby: sign in to join" |
| Members | the line "Experimental rules: Moon ball · Gravity 40% · Ball weight 70% · Ball bounce 130% · Jump power 120%" before the start |
| A stale page (served the protocol-4 RoomClient by mistake) | its ready had no fingerprint: `physics_mismatch`, it went back to its lobby |
| Match, 2v2 with two bots, 3 min | both arenas `88e70a4e` (gravity -260, bounce 0.78), bots planning with gravity -260, both readies with that fingerprint, 533 / 722 hash votes agreed and 0 disagreed, 0 resyncs, final whistle 1-0 on both |
| Afterwards | both back in the lobby (open), arenas stock again (`7318f74a`), no rating, no ban, no abandons, leaderboard empty |
| The same lobby back on Standard | welcome without rules, readies with the stock fingerprint, hashes agree, the match plays as before |

Tests: `server/test/room.test.mjs` (the room and the matchmaker), `server/test/nodeMatchmaker.test.mjs`,
`server/test/experimental-lobby.test.mjs` (LobbyDO, the Worker, every standard-physics-only path),
`tests/p2p-session.test.mjs` (the client, and two sessions on the real engine + wasm + bots under a
preset), `server/test/smoke-accounts.mjs` (an experimental lobby against wrangler dev).

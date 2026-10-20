# Fase 1 online: autoridad en Durable Object + WebSocket

Objetivo: jugar partidos reales entre navegadores contra un host autoritativo que corre en un
Durable Object de Cloudflare, con predicción y rollback en el cliente, cuentas invitado, tickets
firmados, y un panel de métricas de red. Todo corre localmente con `wrangler dev` (workerd) + `vite`;
el deploy a Cloudflare lo hace el usuario con su cuenta (documentar `wrangler deploy` + secrets).

## Layout

```
server/                         Cloudflare Workers project (wrangler, TypeScript)
  wrangler.jsonc                 main = src/index.ts; durable_objects: MatchDO, MatchmakerDO; d1 (optional in phase 1), kv for flags; rules for .wasm;
                                 assets: ../dist (el build de Vite servido desde el mismo origen; run_worker_first: /api/*, /ws/*)
  package.json                   wrangler + @cloudflare/workers-types (devDeps); scripts: dev (crea ../dist si falta), deploy, test, smoke
  tsconfig.json                  extends ../tsconfig for shared code; types: @cloudflare/workers-types
  src/index.ts                   Worker: POST /api/guest, POST /api/queue, GET /ws/:matchId (ticket check → MatchDO), GET /api/health, GET /api/time,
                                 GET /api/config (sitekey de Turnstile), GET /api/where (colo del edge, ip enmascarada), fallback a env.ASSETS para el resto
  src/auth.ts                    HS256 JWT (WebCrypto): sessions (24 h) and match tickets (90 s, jti single-use via DO storage); Turnstile verify when TURNSTILE_SECRET is set
  src/MatchmakerDO.ts            one per region ('mm:'+region): queue per mode, pairs players (fills missing slots with bots after a wait), creates matchId, issues tickets
  src/MatchDO.ts                 one per match: accepts WebSockets (standard API, NOT hibernation: the tick loop needs timers), runs RoomHost at 120 Hz, broadcasts snapshots at 30 Hz, match flow (countdown/goal/clock/end), hard TTL 10 min after the match ends or when empty
  src/roomHost.ts                RoomHost: wraps RocketSim (shared src/sim), applies per-slot input queues with a small input buffer (target 1–2 ticks, cap 8, bufferHint), runs BotTeam for bot slots, exposes save_state/hash for snapshots; environment-agnostic (also usable from Node later)
  src/wasm.ts                    loads the shared wasm in workerd: `import mod from '../../src/sim/wasm/rocketsim.wasm'` + RocketSim.load({ wasmModule: mod })
  test/                          node tests against `wrangler dev` o un deploy (smoke: guest → queue → ws → snapshots, imprime SUMMARY) and unit tests of auth/queue logic
src/net/                        client netcode (browser)
  protocol.ts                    (DONE) binary codec shared with the server
  NetClient.ts                   WebSocket client: connect with subprotocol ['tg1','ticket.<jwt>'], clock sync (ping 4×/s, median of 8–16 samples), input send 60 pps × 2 ticks with redundancy of unacked ticks (cap 16), snapshot receive, events, reconnection (one retry)
  Prediction.ts                  rollback: on snapshot → rs_load_state(blob) → apply echoed remote inputs (hold last known) → replay own inputs from snapshot.tick+1 to localTick → compute visual error offsets (own car + ball) and decay them 0.95/tick (0.85 if ≥ 1 m, snap > 2 m); hash check vs snapshot.stateHash after loading (desync counter)
  OnlineGame.ts (or Game.ts online mode)  the fixed-step loop in online mode: localTick = hostTick + lead; lead = ceil((RTT/2 + jitterMargin)/8.33 ms) + 1, adjusted by bufferHint (±1 tick per second, slew via tick-rate scaling ±5%)
  NetStats.ts                    ping / jitter / loss / lead / rollbacks / snapshot age / bytes in-out for the HUD
src/game + src/render           menu: 'ONLINE' entry → quick match (mode, auto region) → connecting → match; HUD net panel (F4 or #net)
vite.config.ts                  dev proxy: /api and /ws → http://127.0.0.1:8787 (wrangler dev), ws: true
```

## Flujos

1. **Guest**: cliente POST /api/guest {name} → {playerId, session}. Guardado en localStorage. Turnstile sólo si hay secret configurado (dev: off).
2. **Queue**: POST /api/queue {mode} (Bearer session) → el Worker decide región por `request.cf.country`/`continent` (dev: 'dev') → `MatchmakerDO.idFromName('mm:'+region)` → long-poll ≤ 25 s → {status, matchId, ticket, wsUrl}. El matchmaker arma la sala cuando hay suficientes humanos para el modo o cuando el primero esperó ≥ 10 s (completa con bots).
3. **WS**: cliente abre `new WebSocket(wsUrl, ['tg1', 'ticket.'+ticket])`. El Worker lee `Sec-WebSocket-Protocol`, verifica el ticket (HS256, exp, mid == matchId, jti no usado), y hace `stub.fetch` al MatchDO con los claims en headers (`x-player-id`, `x-slot`, `x-team`, `x-name`). Respuesta 101 con `Sec-WebSocket-Protocol: tg1`. Tickets inválidos → 401 sin tocar el DO.
4. **MatchDO**: al aceptar el primer socket crea el RoomHost (wasm + arena + roster del matchmaker, bots en slots vacíos), envía Welcome, arranca el loop cuando todos los humanos mandaron Ready o pasaron 5 s; countdown 3 s; 120 Hz; snapshots a 30 Hz a cada cliente (con su lastInputTick y bufferHint); eventos JSON; al terminar (clock 0 / overtime / todos se fueron) cierra sockets y se autodestruye (TTL por alarma).
5. **Cliente online**: al Welcome carga el roster en las vistas; clock sync; corre la sim local adelantada; manda inputs; al recibir snapshot hace rollback+replay; render con suavizado; HUD de red.
6. **Salida explícita** (menú → `OnlineSession.leave`, o Esc mientras conecta): el cliente manda `POST /api/leave { matchId }` (con la sesión) y cierra el socket con 1000. El matchmaker libera el lock del partido en servidor sólo si `matchId` es ese partido (sin `matchId` — Esc en la cola, el teardown de P2P — o con otro id, el lock queda) y avisa al MatchDO (`POST /internal/leave`, header interno): cierra el socket del slot (1000 `left`), lo marca `left` (persistido: `/api/rejoin` → 410 `left`, upgrades → 410), y el BotTeam del host maneja ese auto desde el tick siguiente (`RoomHost.convertToBot`, entre dos ticks: determinista); los demás reciben `botTakeover { slot, tick }` (etiqueta BOT) y ven el auto seguir moviéndose. Si el que sale era el último humano (todos los slots `player` en `left`, conectados o no), el MatchDO termina el partido en el acto, antes de responder (`shutdown('left')`: sockets cerrados, `/release` acotado al matchId que borra también la entrada de capacidad, storage borrado; `/api/rejoin` → 404): no espera el chequeo de sala vacía (15 s, sólo con el loop corriendo) ni la alarma de sala sin usar (90 s), que con el lock ya libre dejaban a un guest abrir una partida nueva cada 10 s y ocupar varios de los 20 cupos (`MAX_ACTIVE_ROOMS`). Una desconexión accidental (reload, red, el rejoin automático que falla) no manda nada: el lock queda y la próxima cola de servidor reengancha (409 → `/api/rejoin`). Una cola **P2P** que recibe 409 kind `server` no reengancha: `POST /api/leave { matchId }` una vez y reintenta la cola P2P (antes volvía a meter al jugador en el partido que acababa de dejar).

## Netcode (fase 1, WebSocket)

- Tick 120 Hz. Inputs: 60 paquetes/s con 2 ticks nuevos + todos los no confirmados (cap 16 ticks por paquete). El host aplica cada input en SU tick (cola por slot); si un tick no tiene input usa el último (y marca underrun → bufferHint negativo); si la cola supera 8 descarta los más viejos (bufferHint positivo).
- Snapshots 30 Hz: blob completo (`rs_save_state`, ~1–2 KB) + eco de inputs + hash. (Cuantización/deltas quedan para fase 2.)
- Cliente: lead inicial 4 ticks; clock sync con mediana; ajuste suave con bufferHint; re-sync duro si |lead drift| > 8 ticks o snapshot más viejo que la historia (64 ticks de inputs propios).
- Bots en el host: BotTeam por equipo para los slots sin humano (misma IA que offline).
- Determinismo: el cliente compara `fnv1a32(rs_save_state())` tras cargar con `snapshot.stateHash` (debe coincidir siempre; si no, contar y loguear). Además, en dev, tras el replay compara el hash de su predicción para el tick del snapshot con el del snapshot siguiente (mide mispredicciones reales).

## Seguridad y costos (mínimos de fase 1)

- Secrets: `JWT_SECRET` (wrangler secret / `.dev.vars`); `TURNSTILE_SECRET` opcional.
- Rate limit simple en el Worker (por playerId, en memoria/DO) para /api/queue; máximo 1 partida activa por playerId.
- MatchDO: tope de 8 sockets; TTL 10 min; `limits.cpu_ms` por defecto; inputs: máx 2 paquetes por tick de host (los demás se descartan), frames ≤ 256 B.
- Flags en KV (`matchmaking_off`, `do_disabled`) leídos por el Worker (default: todo on).

## Verificación

- `npm run build:wasm` (nuevas exports) + tests node de save/load/hash/packed (determinismo: save→load→step N == step N sin interrupción; hash igual).
- `node --test tests/*.test.mjs` para protocol (round-trips), prediction (rollback converge; replay de inputs reproduce el estado), roomHost (buffer de inputs, bufferHint).
- `server`: `wrangler dev --local` + `node server/test/smoke.mjs` (guest → queue → match con bots → 600 ticks de snapshots → hash del cliente == hash del host → salida explícita: `/api/leave { matchId }` 200 `released`, socket cerrado 1000 `left`, cola P2P sin 409, `/api/rejoin` 410 `left`, o 404 `no_match` cuando era el único humano: el partido terminó con la salida).
- Browser: vite + wrangler dev; menú ONLINE → partido contra bots vía DO; HUD de red muestra ping/lead/rollbacks; sin errores de consola.
- Deploy: `npm run smoke:remote` contra la URL real (sección siguiente).

## Deploy and measurements

Un solo Worker sirve todo desde el mismo origen: el juego (el build de Vite en `dist/`, subido como
Workers Assets con fallback SPA), `/api/*` y los sockets `/ws/*`; no hace falta CORS y `wsUrl` sale
`wss://<host>/ws/<id>`. Detalle de variables y placeholders en `server/README.md` ("Deploy").

Comandos exactos (cuenta propia, plan Workers Paid por los Durable Objects):

```sh
cd server
npx wrangler login
npx wrangler kv namespace create FLAGS      # pegar el id en wrangler.jsonc (kv_namespaces)
npx wrangler secret put JWT_SECRET          # string aleatorio largo
npx wrangler secret put TURNSTILE_SECRET    # secret del widget Turnstile (dashboard → Turnstile → widget con el hostname del deploy)
#   wrangler.jsonc vars: "TURNSTILE_SITEKEY": "<sitekey>", "VITE_ORIGINS": "https://<host>"
cd ..
npm run deploy -- --nodes-off               # npm run build (tsc + vite build → dist/) && node scripts/deploy.mjs (wrangler deploy)
#   --nodes-off: sin nodos comunitarios propios. Antes de desplegar, el deploy lee el canal
#   de releases de los nodos en R2 (R2 habilitado en la cuenta, con permiso de lectura) y
#   exige un árbol limpio en origin/main: server/README.md
```

Qué medir y registrar, desde cada ubicación que importe (Argentina primero; el objetivo de la fase
es tener números reales de Cloudflare):

1. `curl https://<host>/api/where` → `edgeColo`, `country`, `city`, `asn`, `ip` (/24): el PoP que
   atiende al cliente.
2. `API=https://<host> npm run smoke:remote -- --duration=20` (node 24). Con Turnstile activo el
   script no puede crear invitados: abrir el juego, pulsar ONLINE una vez y pasar
   `SESSION=<jwt>` con `JSON.parse(localStorage.getItem('turbogol.guest')).session.session`
   (consola de DevTools). La última línea es la que se anota:
   `SUMMARY edge=<colo> host=<colo> rtt_p50=.. rtt_p90=.. jitter=.. snap_p50=.. snap_p90=.. snap_max=.. hint_mode=.. desyncs=..`
   - `edge` vs `host`: `host` es `Welcome.hostColo` (el MatchDO lee `cloudflare.com/cdn-cgi/trace`
     una vez por isolate). Un DO nace cerca del request que lo crea, pero no en todos los PoPs: si
     difieren, la latencia extra es edge ↔ host y conviene anotarla por par.
   - `rtt_p50 / rtt_p90 / jitter` (ms): ping-pong de 4 timestamps a 4 Hz por el WebSocket (jitter =
     desviación media absoluta respecto a la mediana, como `ClockSync`). Lead esperado en el cliente:
     `ceil((rtt/2 + 2·jitter + 2) / 8.33) + 1` ticks.
   - `snap_p50 / p90 / max` (ms): intervalo entre snapshots visto por el cliente (nominal 33.3):
     jitter del `setInterval` del DO + transporte. Referencia local (wrangler dev, Windows): 31 / 43 / 48.
   - `hint_mode`: bufferHint más frecuente (ideal 0–2; negativo = el host se quedó sin inputs y el
     lead debería subir).
   - `desyncs`: debe ser 0 (mismo wasm en los dos extremos); cualquier otro valor es un bug.
3. En el navegador (la URL del deploy): ONLINE → panel de red (F4): ping, jitter, lead estable,
   rollbacks/s, ticks replayed/s, desyncs (0), mispredicciones, corrección máxima del auto (uu),
   bytes in/out. Anotar también si el juego se siente jugable (input → pantalla).
4. Costo: dashboard → Workers & Pages → turbogol → Durable Objects (duration GB-s, requests)
   tras unos partidos; comparar con el presupuesto de DECISIONS.md (20 partidos concurrentes).
5. Logs: `npx wrangler tail` (cuenta) o la observabilidad del dashboard (`observability.enabled`).

Registro (completar con cada medición):

| Fecha | Desde (ciudad / ISP) | edge | host | rtt p50 / p90 | jitter | snap p50 / p90 / max | hint_mode | desyncs | Notas |
|---|---|---|---|---|---|---|---|---|---|
| 2026-10-14 | local: wrangler dev en Windows (referencia, no es un PoP) | <AR>* | <AR>* | 0.8 / 1.3 | 0.3 | 31.3 / 43.0 / 48.2 | 2 | 0 | *en local `request.cf` y el trace describen la conexión del dev |

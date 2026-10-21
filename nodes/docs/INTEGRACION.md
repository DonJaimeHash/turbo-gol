# Integración con el juego (aplicada en parte)

Lo que hay que cambiar fuera de esta carpeta para que los nodos comunitarios reciban partidas de
verdad. La etapa 1 lo reparte en ocho PR, con su orden y los ajustes a este diseño, en
`PRODUCCION.md`: donde los dos no coinciden, manda esa lista. El plano de control en el Worker
(§1, §2 y §4) lo aplica [6] (#28). Falta el gancho del matchmaker (§3), que es [7]: hasta
entonces ninguna partida va a un nodo. Las líneas citadas se revisaron contra el commit `dead8ec`.
El plano de control va en el dominio del juego: `https://turbo-gol.com/nodes/…`.

## 0. Dónde va el código

Ya está en `nodes/` (decisión 3: se publica con AGPL). Sus imports relativos apuntan a `../../src`
y `../../server/src`. `node_modules/`, `dist/`, `.keys/` y `data/` están en `nodes/.gitignore`, y el
CI corre su chequeo de tipos y sus pruebas en cada PR.

## 1. Worker: `NodeRegistryDO`

Aplicado en [6] (#28): `server/src/NodeRegistryDO.ts`, un Durable Object con una sola instancia
(`nodes-v1`, creada cerca de São Paulo) que envuelve `ControlPlane`, `Registry` y `Ledger` de
`control-plane/`. `Shop` llega con la tienda, en la etapa 2.

- **Persistencia:** nodos, tokens y partidas (las sin terminar, las que esperan su verificación y
  las terminadas con su resultado) van a su SQLite (`server/src/nodeStore.ts`), con escrituras
  síncronas como en `AccountsDO`, más la bandeja de salida de esos resultados hasta entregarlos,
  escrita en la misma transacción que la partida terminada. Con filas de otra `STATE_VERSION`, el
  objeto no arranca: deja un `ALERT` y no las toca. Los asientos del ledger, los canjes y los
  inventarios se suman en la etapa 2, cuando haya nodos que ganan puntos: hasta entonces el ledger
  vive en memoria.
- **Conexiones de nodos:** con la Hibernation API (`ctx.acceptWebSocket`), como `RoomDO`. Las
  sesiones de `ControlPlane` viven en memoria (`control-plane/controlPlane.ts:320`), así que cada
  socket guarda su nodo (`{ nodeId }`) como adjunto al entrar. Un DO que despierta de una
  hibernación conserva los sockets y los vuelve a asociar con `ControlPlane.adopt()`, sin un
  desafío nuevo; un arranque sin sockets es un deploy, y las partidas sin terminar tienen 90 s de
  gracia.
- **Barrido:** `ControlPlane.sweep()` desde una alarma cada 5 s, que sigue mientras haya sockets,
  partidas sin terminar, filas en la bandeja o una gracia. No alcanza con correrla mientras haya
  nodos conectados: el barrido es lo único que anula las partidas de un nodo caído
  (`control-plane/controlPlane.ts:1185-1200`). La misma alarma entrega la bandeja y relee
  `channel.json` de R2 cada minuto. Con heartbeats y alarma cada 5 s, el DO nunca hiberna: ver el
  costo en `PRODUCCION.md`.
- **La clave de control:** si `NODE_CONTROL_PUBLIC_KEY` no es la mitad pública de
  `NODE_CONTROL_PRIVATE_KEY`, los nodos rechazarían cada ticket. El DO lo comprueba al arrancar y,
  si no coinciden, deja un `ALERT` y no pone partidas, no registra nodos ni da tickets de rejoin.
- **Verificación:** solo por nodos de confianza (el VPS de São Paulo). `inlineVerify` es del
  servidor de referencia; en el DO no conviene por el tope de CPU que fija el presupuesto.
- **ICE, desde la etapa 2** (el DO de [6] no da TURN): `iceServers('node' | 'player')`
  reutiliza la lógica de `GET /api/ice`: STUN de Cloudflare siempre y credenciales TURN con
  `TURN_KEY_ID` y `TURN_KEY_TOKEN`. **No de 10 minutos:** Cloudflare corta la conexión cuando
  vencen, y una partida vive hasta su largo más 600 s desde que se crea. Pedirlas con esa duración
  y revocarlas al terminar. Antes de poner los secretos, el tope de 900 GB por mes
  (`PRODUCCION.md`, etapa 2).
  **TURN es obligatorio para las PCs hogareñas:** con `requireRelay` (por defecto en
  `ControlPlane`), una PC solo recibe partidas si su autotest pasó por el relay. Sin TURN, o si
  la API de TURN falla, ninguna PC hogareña queda habilitada; los VPS no se ven afectados.
- **Mensajes de los nodos:** `onMessage` valida todo lo que manda un nodo y nunca lanza por
  datos del nodo. Solo rechaza la promesa si falla el almacenamiento al procesar un reporte; en
  ese caso no manda el ack y el nodo lo reenvía. El DO envuelve la llamada con `.catch` y lo
  registra en el log.
- **Replays:** en `PUT /nodes/replays/<id>`, el DO llama a `ControlPlane.replayPutCheck` antes de
  leer el cuerpo (hasta 16 MiB) y responde su error si lo hay; solo después lee el cuerpo y lo
  pasa a `storeReplay`. Cualquier jugador de una partida de nodo conoce su id y el del nodo: una
  subida falsa no debe costar ni la lectura ni el hash en el único DO por el que pasan los
  heartbeats.
- **Rutas internas, para el matchmaker:** `POST /internal/place`, `/internal/rejoin` y
  `/internal/leave`, y `GET /internal/status`, con los códigos de `server/src/nodeApi.ts`. Son
  para el gancho de §3 ([7]): todavía nadie las llama.

Bindings, secretos y variables nuevos (los secretos, con `wrangler versions secret put`: ver M7 en
`PRODUCCION.md`):

| Nombre | Tipo | Contenido |
|---|---|---|
| `NODES` | Durable Object | `NodeRegistryDO` (migración `v4`) |
| `NODE_REPLAYS` | R2 | replays, 30 días (una regla de ciclo de vida del bucket `turbogol-node-replays`) |
| `NODE_RELEASES` | R2 | releases firmadas, instaladores y `channel.json` (bucket `turbogol-node-releases`) |
| `NODE_CONTROL_PRIVATE_KEY` | secreto | PKCS#8 de la clave de control (`npm run keys`) |
| `NODE_CONTROL_PUBLIC_KEY` | var | su mitad pública |
| `NODE_TRUSTED_OPERATORS` | secreto (D13 de `PRODUCCION.md`) | ids de cuenta del proyecto, separados por coma: sus nodos son de confianza, como mucho 2 por cuenta, y solo esas cuentas crean tokens |
| `NODES_PUBLIC_BASE` | var | `https://turbo-gol.com`: la base de las URL que el plano de control da a los nodos y de la línea de instalación (P19, P20 de `PRODUCCION.md`) |
| `NODE_ALERT_WEBHOOK` | secreto | el webhook del canal de alertas del equipo, adonde van las líneas `ALERT` (P24 y M13 de `PRODUCCION.md`). [6] solo lo declara: hasta P24, las `ALERT` van solo al log |

## 2. Worker: rutas `/nodes/*` en `server/src/nodeRoutes.ts`

`/nodes/*` está en `run_worker_first`, y `server/src/index.ts` pasa esas rutas a `nodeRoute()`
antes de mandar al sitio. `whoami` y las releases se responden en el Worker; el resto va al
`NodeRegistryDO`, que confía en lo que el Worker le pasa: solo los encabezados de un nodo, y
`x-client-ip`, `x-operator-id` y `x-operator-name` siempre puestos por el Worker.

| Ruta | Destino |
|---|---|
| `GET /nodes/whoami` | `{ ip: CF-Connecting-IP }` directo en el Worker |
| `GET`/`HEAD /nodes/releases/channel` | `channel.json` de R2 `NODE_RELEASES`, el mismo objeto que el plano de control lee para `minimum`: solo `{ stable, minimum }` cuando los dos son `X.Y.Z`, sin caché; 404 si no existe y 503 si está roto. Ruta propia (también responde a `channel.json`): el lanzador pide `channel` sin extensión |
| `GET`/`HEAD /nodes/releases/<archivo>` | R2 `NODE_RELEASES`: `<versión>/<archivo>` o un archivo de la raíz, con un patrón de nombres que se comprueba después de decodificar (un `X.Y.Z/` opcional y un nombre de hasta 64 caracteres `A-Za-z0-9._-`), sin `..` ni listados: todo lo del bucket que encaja en el patrón es público. Los de una versión, inmutables en caché; los de la raíz (`launcher.mjs`, los instaladores), revalidados con ETag. Un tipo desconocido sale como bytes |
| `POST /nodes/register` | `NodeRegistryDO`, con la dirección de quien llama en `x-client-ip`. 413 si declara más de 4 KB |
| `GET /nodes/connect` | `NodeRegistryDO`: el WebSocket de control del nodo. 426 sin `Upgrade`; el 101 pasa tal cual |
| `PUT /nodes/replays/<id>`, `GET /nodes/replays/<id>` | `NodeRegistryDO`, con los encabezados firmados del nodo; el id, de 64 hex. La subida: 413 si declara más de 16 MiB |
| `POST /nodes/tokens` | `NodeRegistryDO`, con la sesión de **cuenta**: 401 sin sesión, 403 `account_required` para un invitado y 403 `not_trusted` para una cuenta que no está en `NODE_TRUSTED_OPERATORS`. Responde el token, de un solo uso y una hora, y la línea de instalación de Linux. 413 si declara más de 4 KB |
| `GET /nodes/mine` | `NodeRegistryDO`, con la sesión de cuenta: los nodos propios |
| `GET /nodes/status` | `NodeRegistryDO`: la lista pública de nodos, sin direcciones, 10 s en caché |

Cualquier otra ruta bajo `/nodes/` responde 404, y sin la configuración de los nodos
(`nodesConfigured`: un fork, el desarrollo local) también todas las que van al DO. Después de la
etapa 1 se suman la señalización WebRTC (`POST /nodes/rtc/<nodo>/<partida>/ice` y `.../offer`, a
`rtcIce` y `rtcOffer`, con un límite de 10 por IP por minuto), la tienda (`GET /nodes/shop` y
`POST /nodes/shop/claim`, con la sesión de cuenta: los invitados no canjean) y `GET /api/me/items`,
el inventario de la cuenta para que el juego desbloquee ítems. Las rutas `/dev/*` del servidor de
referencia no existen en el Worker. CORS, solo en `tokens`, `mine` y `status`.

Límites, con una IPv6 contada por su /64: `register`, 5 por dirección por hora, y `tokens`, 10 por
cuenta por día, los lleva el DO, en memoria (un deploy los pone en cero); el Worker los repite por
isolate para que la basura no llegue al DO. Los demás son solo del Worker, por isolate
(`rateLimited` en `server/src/index.ts`): `connect`, 30 por dirección por minuto; las subidas y
las bajadas de replays, 60 cada una; `status`, 60; `mine`, 30 por cuenta.

## 3. Matchmaker: el gancho de juego

**Antes, en la cola:** `HumanEntry` (línea ~373) y `Waiter` (línea ~131) hoy solo tienen
`playerId` y `name`. Hay que agregarles, al encolar en `POST /api/queue`:

| Campo | De dónde sale | Para qué |
|---|---|---|
| `transports` | El cuerpo de la cola: el cliente nuevo manda `['wss', 'rtc']`; uno viejo no manda nada y queda en `['wss']` | Un cliente viejo nunca va a una PC hogareña |
| `account` | La sesión: cuenta o invitado | El peso del jugador en los puntos del anfitrión |
| `accountAgeDays` | La fecha de alta de la cuenta en `AccountsDO` (o un claim en el JWT de sesión) | Las cuentas de menos de 7 días pesan 0,25 |

Sin `account` ni `accountAgeDays`, todos los jugadores pesan como invitados y los operadores
ganan la cuarta parte de lo previsto.

En la etapa 1 no hace falta nada de esto: el único nodo es el VPS del proyecto, que usa wss (el
transporte que `place()` toma cuando la cola no manda ninguno,
`control-plane/controlPlane.ts:624`) y no gana puntos. Los tres campos llegan con la etapa 2.

**En `MatchmakerDO.formMatch`** (línea ~1057), después de calcular `length` y `until` y antes de
`env.MATCH.newUniqueId()`. El roster lo arma el plano de control con los mismos equipos que hoy
(balanceados en ranked, elegidos en una sala privada):

```ts
const length = opts.matchLengthSeconds ?? matchLengthSeconds(env);
const until = now + (length > 0 ? length : 20 * 60) * 1000 + ACTIVE_GRACE_MS;
const placed = await nodesStub(env).place({
  mode,
  region: this.region,
  ranked: opts.ranked === true,
  matchLengthSeconds: length,
  humans: humans.map((h) => ({ playerId: h.playerId, name: h.name, account: h.account, accountAgeDays: h.accountAgeDays })),
  // Los transportes que soportan TODOS los jugadores de la partida.
  transports: (['wss', 'rtc'] as const).filter((t) => humans.every((h) => (h.transports ?? ['wss']).includes(t))),
  ...(opts.teams ? { teams: { blue: opts.teams[0].map((h) => h.playerId), red: opts.teams[1].map((h) => h.playerId) } } : {}),
});
if (placed) {
  if (opts.ranked) await this.rankedLock(placed.matchId, humans, until); // el bloque de hoy (líneas ~1072-1083), extraído
  await this.issueNode(humans, placed, until, now, opts.ranked === true);
  return placed.matchId;
}
// ...sigue igual: MatchDO.
```

- `rankedLock` es el bloque actual que llama a `ranked-lock` de `AccountsDO`, movido a un método
  para usarlo en los dos caminos. Sin él, un jugador ranked en un nodo podría encolar ranked en
  otra región al mismo tiempo.
- `issueNode` es una copia de `issue()` (línea ~1123) que usa `placed.tickets`, guarda la
  `placed.wsUrl` absoluta y marca el lock con `kind: 'node'`.
- **`queue()` en `index.ts` (línea ~392)** reescribe la `wsUrl` de toda partida de servidor
  con `/ws/<matchId>`. Tiene que respetar la del nodo: reescribir solo cuando el resultado no
  traiga `node: true`.
- **Verificación de locks** (`LOCK_VERIFY_AFTER_MS`): para un lock `node`, preguntar al registro
  (`GET /internal/status`, y `nodeLockHeld` de `server/src/nodeApi.ts`) si la partida sigue en
  estado `assigned` o `reporting`. Si el nodo se cae, el registro anula sus partidas a los 60-65 s
  (60 s sin heartbeat del nodo, `NODE_OFFLINE_MS`, más el intervalo del barrido; antes si la
  partida ya pasó por otro corte), así que el lock se libera solo.
- **`POST /api/rejoin`**: si la partida es de un nodo, `POST /internal/rejoin` al
  `NodeRegistryDO` (`ControlPlane.rejoin()`, P5 de `PRODUCCION.md`). Responde un ticket nuevo y la
  URL del nodo, o un código con el estado de `REJOIN_STATUS` (`server/src/nodeApi.ts`): 404
  (`no_match`, `not_in_match`) y 410 `match_over` liberan el lock; 410 `left` ya lo liberó la
  salida; 503 `offline` (el nodo está caído un momento) lo mantiene.
- **`POST /api/leave { matchId }`**: si la partida es de un nodo, `POST /internal/leave`
  (`ControlPlane.leave(matchId, playerId)`, con los códigos de `LEAVE_STATUS`). Es la única forma
  de que un jugador deje una partida de nodo: el verificador rechaza cualquier toma de control por
  un bot que no haya pasado por aquí. `ControlPlane.leave` rechaza con `match_over` después del
  final (`control-plane/controlPlane.ts:743`), pero `/api/leave` siempre responde
  `200 { ok, left, released }` (`server/src/MatchmakerDO.ts:680`): el matchmaker traduce. El
  cliente manda `{ matchId, region? }` (`src/net/NetClient.ts:881`). El campo `connected`
  (`false` cuando el cliente nunca recibió el `Welcome`) solo cambia algo en un nodo comunitario:
  en uno de confianza, una cancelación toma los `noShows` del nodo tal cual
  (`control-plane/controlPlane.ts:859-861`). Llega con la etapa 2.

## 4. Resultados a `AccountsDO`

| Outcome | Llamada |
|---|---|
| `rated` | `POST /ranked-result { matchId, playlist, region, winner, blue, red, players }`, el mismo cuerpo que `MatchDO.reportRanked` |
| `void` de una ranked | `POST /ranked-cancel { matchId, playlist, region, players, noShows, reason }`. Un outcome `void` no trae `playlist` ni `region` (`control-plane/controlPlane.ts:162`): salen de la asignación de la partida |
| `unrated`, o `void` de una casual | nada; los puntos de una `unrated` ya quedaron en el ledger |
| cualquiera | `POST /release` al matchmaker de la región, como `MatchDO.shutdown` |

Aplicado en [6] (#28), en `server/src/nodeOutcome.ts`. El DO escribe estas llamadas en su bandeja
de salida en la misma transacción que la partida terminada, y las entrega apenas las escribe y
después en cada alarma. Un 5xx, un error de red o 10 s sin respuesta se reintentan, cada vez más
espaciados (hasta 5 minutos); cualquier otra respuesta que no sea 2xx se descarta con un `ALERT`
que lleva el cuerpo. Entregar dos veces no hace daño: `AccountsDO` anota cada partida una sola
vez, y `/release` solo libera los locks que todavía apuntan a esa partida.

## 5. Cliente

- **Etapa 1 (VPS por wss):** el socket del cliente no cambia. `resolveWsUrl` deja pasar una URL
  absoluta (`src/net/NetClient.ts:334-336`) y, sin fábrica, `NetClient` abre un WebSocket común
  (`:527`).
- **Etapa 2, una línea** donde se crea el `NetClient`:

```ts
new NetClient({ ...opciones, webSocketFactory: nodeAwareSocketFactory() })
```

  `nodeAwareSocketFactory` está en `client/rtcSocket.ts`. Para las URL normales abre el WebSocket
  de siempre; para las de una PC hogareña, el adaptador WebRTC. El resto del cliente no cambia.
  `npm run typecheck` de `nodes/` no revisa `client/`: `nodes/tsconfig.json` solo incluye
  `shared`, `node`, `control-plane` y `types`.
- **`POST /api/queue`** manda `transports: ['wss', 'rtc']`.
- **Selector de autos e ítems:** lee `GET /api/me/items` y solo ofrece lo que la cuenta tiene. El
  servidor valida el ítem elegido cuando entre en el roster de la partida.
- Opcional: mostrar "Servidor: casa-1 · por Juan". `Welcome.hostColo` ya trae `node:<nombre>`.
- Llevar `web/host.html` a `src/ui` como pantalla "Poner un servidor".
- v2: comparar el eco de inputs de los snapshots con lo enviado y reportar discrepancias.

## 6. Operación

- Alertas cuando una verificación falla: hoy queda en el log como `ALERT`. Conviene un webhook.
- Endpoint de administración para `setStatus`, `drain`, `shop.unfreeze` y el catálogo. Un
  drenaje no tiene vuelta atrás (`node/runtime.ts:570-575`): el nodo solo vuelve a tomar
  partidas cuando se reinicia.
- Releases: `.github/workflows/node-release.yml`, con un tag `node-vX.Y.Z` en un commit de
  `main`: arma la release sin firmar, la firma en el entorno `releases` y la sube a R2 desde el
  entorno `releases-r2`; la firma y la subida esperan la aprobación del mantenedor (P14 y M6 de
  `PRODUCCION.md`). Publicar no mueve el canal: lo mueve `npm run deploy` antes de desplegar
  (`scripts/node-release-gate.mjs`), para que una release llegue a los nodos junto con el build
  del Worker que le corresponde; `nodes/scripts/channel.mjs` lo mueve a mano y lo devuelve con
  `--rollback`. `stable` llega a cada nodo cuando reinicia, `minimum` obliga a los que están
  corriendo a drenar y actualizarse. Un nodo se compara con `minimum` cuando saluda; además, en el
  Worker, el `NodeRegistryDO` relee `channel.json` cada minuto mientras corre su alarma y, si
  cambió, manda `update` a los nodos conectados por debajo del `minimum` nuevo
  (`ControlPlane.channelChanged()`). Un verificador de confianza con partidas de su build por
  verificar espera, como cuando saluda, y el barrido lo vuelve a probar hasta que se vacía esa
  cola. El campo `canary` del protocolo no se usa todavía.
- Copiar `github/CODEOWNERS` a `.github/`. Activar en `main` la regla que exige la revisión de
  los dueños del código solo cuando haya un segundo mantenedor: GitHub no deja aprobar un PR
  propio, así que con un solo dueño bloquearía sus propios PR.
- El VPS de São Paulo: `VPS-SAO-PAULO.md`.
- Presupuesto: cada partida en un nodo es una partida menos simulada en un DO. Lo nuevo es el DO
  de registro, que con heartbeats cada 5 s no hiberna nunca; R2 para los replays, que en partidas
  de 3 minutos medidas el 19/10/2026 ocupan unos 2,5 KB si solo juegan bots (no se graban) y de 60
  a 403 KB con jugadores simulados por las pruebas; y el TURN de las PCs hogareñas, dentro de los
  1.000 GB mensuales gratis mientras no se fuerce el relay de los jugadores. Los números están en
  `PRODUCCION.md`.

# Integración con el juego (no aplicada)

Lo que hay que cambiar fuera de esta carpeta para que los nodos comunitarios reciban partidas de
verdad. Nada de esto está aplicado todavía. Está ordenado para hacerlo en un
solo PR. Las líneas citadas se revisaron contra el commit `cb157df` del repo público. El plano de
control va en el dominio del juego: `https://turbo-gol.com/nodes/…`.

## 0. Dónde va el código

Ya está en `nodes/` (decisión 3: se publica con AGPL). Sus imports relativos apuntan a `../../src`
y `../../server/src`. `node_modules/`, `dist/`, `.keys/` y `data/` están en `nodes/.gitignore`, y el
CI corre su chequeo de tipos y sus pruebas en cada PR.

## 1. Worker: `NodeRegistryDO`

Un Durable Object nuevo, una sola instancia (`nodes-v1`), que envuelve `ControlPlane`, `Registry`,
`Ledger` y `Shop` de `control-plane/`:

- **Persistencia:** nodos, tokens, partidas, cola de verificación, asientos del ledger, canjes e
  inventarios van a su SQLite, con el mismo patrón que `AccountsDO`. Las clases separan lógica y
  almacenamiento: hace falta cargar al arrancar y guardar en cada cambio.
- **Conexiones de nodos:** con la Hibernation API (`ctx.acceptWebSocket`), como `RoomDO`.
- **Barrido:** `ControlPlane.sweep()` desde una alarma cada 5 s mientras haya nodos conectados.
  Con heartbeats y alarma cada 5 s, el DO nunca hiberna: ver el costo en `PRODUCCION.md`.
- **Verificación:** solo por nodos de confianza (el VPS de São Paulo). `inlineVerify` es del
  servidor de referencia; en el DO no conviene por el tope de CPU que fija el presupuesto.
- **ICE:** `iceServers('node' | 'player')` reutiliza la lógica de `GET /api/ice`: STUN de
  Cloudflare siempre y credenciales TURN con `TURN_KEY_ID` y `TURN_KEY_TOKEN`. **No de 10
  minutos:** Cloudflare corta la conexión cuando vencen, y una partida vive hasta su largo más
  600 s desde que se crea. Pedirlas con esa duración y revocarlas al terminar. Antes de poner los
  secretos, el tope de 900 GB por mes (`PRODUCCION.md`, etapa 2).
  **TURN es obligatorio para las PCs hogareñas:** con `requireRelay` (por defecto en
  `ControlPlane`), una PC solo recibe partidas si su autotest pasó por el relay. Sin TURN, o si
  la API de TURN falla, ninguna PC hogareña queda habilitada; los VPS no se ven afectados.
- **Mensajes de los nodos:** `onMessage` valida todo lo que manda un nodo y nunca lanza por
  datos del nodo. Solo rechaza la promesa si falla el almacenamiento al procesar un reporte; en
  ese caso no manda el ack y el nodo lo reenvía. Envolver la llamada con `.catch` y registrar.

Bindings, secretos y variables nuevos:

| Nombre | Tipo | Contenido |
|---|---|---|
| `NODES` | Durable Object | `NodeRegistryDO` |
| `NODE_REPLAYS` | R2 | replays, de 7 a 30 días |
| `NODE_RELEASES` | R2 | releases firmadas, instaladores y `channel.json` |
| `NODE_CONTROL_PRIVATE_KEY` | secreto | PKCS#8 de la clave de control (`npm run keys`) |
| `NODE_CONTROL_PUBLIC_KEY` | var | su mitad pública |
| `NODE_TRUSTED_OPERATORS` | var | ids de cuenta del proyecto, separados por coma: sus nodos son de confianza |

## 2. Worker: rutas `/nodes/*` en `server/src/index.ts`

| Ruta | Destino |
|---|---|
| `POST /nodes/register`, `GET /nodes/connect` (WebSocket), `PUT/GET /nodes/replays/<id>` | `NodeRegistryDO`, con la lógica de `control-plane/devServer.ts` |
| `POST /nodes/rtc/<nodo>/<partida>/ice`, `POST /nodes/rtc/<nodo>/<partida>/offer` | `NodeRegistryDO`: `rtcIce` y `rtcOffer`. Límite: 10 por IP por minuto |
| `GET /nodes/whoami` | `{ ip: CF-Connecting-IP }` directo en el Worker |
| `GET /nodes/releases/channel` | `channel.json` de R2 `NODE_RELEASES`, el mismo objeto que el plano de control lee para `minimum`. Ruta propia: el lanzador pide `channel` sin extensión |
| `GET /nodes/releases/*` | R2 `NODE_RELEASES` |
| `POST /nodes/tokens`, `GET /nodes/mine`, `GET /nodes/shop`, `POST /nodes/shop/claim` | `NodeRegistryDO`, con la sesión de **cuenta** en lugar de `x-dev-operator`. Los invitados no operan nodos ni canjean. |
| `GET /api/me/items` | el inventario de la cuenta, para que el juego desbloquee ítems |
| `GET /nodes/status` | página pública de anfitriones |

Límites: `/nodes/register` 5 por IP por hora, `/nodes/tokens` 10 por cuenta por día.

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
  si la partida sigue en estado `assigned` o `reporting`. Si el nodo se cae, el registro anula
  sus partidas a los 15 s, así que el lock se libera solo.
- **`POST /api/rejoin`**: si la partida es de un nodo, `ControlPlane.rejoinTicket()`.
- **`POST /api/leave { matchId, connected }`**: si la partida es de un nodo,
  `ControlPlane.leave(matchId, playerId, { connected })`. `connected` lo manda el cliente: `false`
  cuando nunca recibió el `Welcome` (cancelar mientras conecta, en `OnlineSession.cancel`). Así un
  nodo que no deja entrar a un jugador no puede convertir su cancelación en un dodge. Como
  `MatchDO`, responde `410 match_over` después del final y no marca a nadie. Es la única forma
  de que un jugador deje una partida de nodo: el verificador rechaza cualquier toma de control
  por un bot que no haya pasado por aquí.

## 4. Resultados a `AccountsDO`

| Outcome | Llamada |
|---|---|
| `rated` | `POST /ranked-result { matchId, playlist, region, winner, blue, red, players }`, el mismo cuerpo que `MatchDO.reportRanked` |
| `void` de una ranked | `POST /ranked-cancel { matchId, playlist, region, players, noShows, reason }` |
| `unrated` | nada; los puntos ya quedaron en el ledger |
| cualquiera | `POST /release` al matchmaker de la región, como `MatchDO.shutdown` |

## 5. Cliente

- **Una línea** donde se crea el `NetClient`:

```ts
new NetClient({ ...opciones, webSocketFactory: nodeAwareSocketFactory() })
```

  `nodeAwareSocketFactory` está en `client/rtcSocket.ts`. Para las URL normales abre el WebSocket
  de siempre; para las de una PC hogareña, el adaptador WebRTC. El resto del cliente no cambia.
- **`POST /api/queue`** manda `transports: ['wss', 'rtc']`.
- **Selector de autos e ítems:** lee `GET /api/me/items` y solo ofrece lo que la cuenta tiene. El
  servidor valida el ítem elegido cuando entre en el roster de la partida.
- Opcional: mostrar "Servidor: casa-1 · por Juan". `Welcome.hostColo` ya trae `node:<nombre>`.
- Llevar `web/host.html` a `src/ui` como pantalla "Poner un servidor".
- v2: comparar el eco de inputs de los snapshots con lo enviado y reportar discrepancias.

## 6. Operación

- Alertas cuando una verificación falla: hoy queda en el log como `ALERT`. Conviene un webhook.
- Endpoint de administración para `setStatus`, `drain`, `shop.unfreeze` y el catálogo.
- Releases: `github/workflows/node-release.yml`. El canal se mueve a mano: `stable` llega a cada
  nodo cuando reinicia, `minimum` obliga a los que están corriendo a drenar y actualizarse. El
  campo `canary` del protocolo no se usa todavía.
- Copiar `github/CODEOWNERS` a `.github/`. Activar en `main` la regla que exige la revisión de
  los dueños del código solo cuando haya un segundo mantenedor: GitHub no deja aprobar un PR
  propio, así que con un solo dueño bloquearía sus propios PR.
- El VPS de São Paulo: `VPS-SAO-PAULO.md`.
- Presupuesto: cada partida en un nodo es una partida menos simulada en un DO. Lo nuevo es el DO
  de registro, que con heartbeats cada 5 s no hiberna nunca, R2 para replays de 10 a 50 KB, y el
  TURN de las PCs hogareñas, dentro de los 1.000 GB mensuales gratis mientras no se fuerce el
  relay de los jugadores. Los números están en `PRODUCCION.md`.

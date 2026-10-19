# Camino a producción

> Estado al 19/10/2026. El prototipo vive en `nodes/` del repo y funciona como demo local: las pruebas
> automáticas pasan y corren en el CI de cada PR, y la demo de
> punta a punta anda (`node --import ./dev/ts-resolve.mjs scripts/demo.mjs --once`). **No está
> listo para jugadores reales.** Este documento lista todo lo que falta, en orden, para cada etapa.
> Las rutas de archivos son del repo (`server/`, `src/`, `docs/online/`) o de `nodes/`
> (`control-plane/`, `node/`, `shared/`, `client/`, `install/`). Los esfuerzos son estimaciones
> para una persona. Lo revisaron dos agentes independientes contra el código y las fuentes.

## Resumen

| Etapa | Qué habilita | Esfuerzo estimado |
|---|---|---|
| 0. Resguardo | Que el trabajo no dependa de un solo disco | 1 a 2 días |
| 1. Beta con el VPS de São Paulo | Ranked y casual por servidor en el VPS del proyecto, con jugadores reales | 3 a 4 semanas |
| 2. PCs de amigos | Partidas en PCs hogareñas de gente de confianza, por WebRTC | 3 a 4 semanas más |
| 3. Abierto a cualquiera | Cualquier persona pone su VPS o su PC | Varias semanas más, y revisión legal |

Cada etapa necesita todo lo de la anterior.

## Etapa 0: resguardo

- [x] **Poner el paquete bajo control de versiones.** Hecho el 19/10/2026: vive en `nodes/` del
  repo, con su propio `.gitignore` y un trabajo de CI que corre su chequeo de tipos y sus pruebas.
- [x] **Elegir qué documentos se publican.** Se publican todos: ninguno tiene secretos, y el
  presupuesto ya era público en `docs/online/DECISIONS.md`.
- [ ] **Respaldar `.keys/` fuera de esta PC.** Las claves de control y de releases siguen solo en
  la carpeta privada de la PC del mantenedor, fuera del repo. Guardar una copia en un gestor de
  contraseñas.
- [ ] **Tratar la clave de releases actual como clave de desarrollo.** La release 0.1.0 se firmó
  en esta PC (`npm run build` usa `--sign .keys/release.json`), y `ARQUITECTURA.md` promete que
  la clave vive en CI con aprobación manual o en una máquina sin conexión. Antes de la primera
  release real: generar una clave nueva ahí y armar los instaladores con su mitad pública.

## Etapa 1: beta con el VPS de São Paulo

Objetivo: el VPS del proyecto hostea partidas por WebSocket (el cliente actual ya sabe
conectarse) y verifica. Sin PCs hogareñas todavía, así que no hacen falta TURN ni el adaptador
WebRTC. El VPS es de confianza y no gana puntos, así que el ledger y la tienda esperan a la
etapa 2.

### Plano de control en el Worker

- [ ] **`NodeRegistryDO` con persistencia.** Hoy todo el estado vive en memoria: nodos, tokens,
  partidas, cola de verificación, ledger y tienda (`control-plane/registry.ts`, `ledger.ts`,
  `shop.ts`, `controlPlane.ts`). Un deploy o un desalojo del DO lo borra todo, y las clases no
  tienen funciones de guardar y cargar: hay que diseñarlas. Para esta etapa alcanza con guardar,
  después de cada cambio, el registro con la clave pública de cada nodo y todas las partidas que
  no terminaron: estados `assigned`, `reporting` y `verifying` (`MatchState` en
  `control-plane/controlPlane.ts`).
  Si se pierde una en `verifying`, su ranked nunca se califica. Esfuerzo: grande.
- [ ] **Período de gracia después de un reinicio del DO.** Cada deploy del Worker corta la
  conexión de todos los nodos. Al volver, `sweep()` anularía sus partidas y les daría un strike
  si su último heartbeat guardado tiene más de 15 s. El DO tiene que esperar a que los nodos
  se reconecten antes de barrer.
- [ ] **Configuración de Wrangler.** Binding `NODES` con su migración `new_sqlite_classes`,
  buckets R2 `NODE_REPLAYS` y `NODE_RELEASES`, el secreto `NODE_CONTROL_PRIVATE_KEY` y las
  variables `NODE_CONTROL_PUBLIC_KEY` y `NODE_TRUSTED_OPERATORS`. Agregar `/nodes/*` a
  `run_worker_first` (`server/wrangler.jsonc:49`): sin eso, esas rutas devuelven el `index.html`
  del juego. Una regla de ciclo de vida en `NODE_REPLAYS` que borre los replays a los 30 días.
  Esfuerzo: chico.
- [ ] **El build de la partida.** `ControlPlane` necesita el SHA-256 de `rocketsim.wasm` y
  `PROTOCOL_VERSION` para elegir nodos y verificadores. El Worker importa el wasm ya compilado y
  no puede calcular su hash: el deploy tiene que dejarlo como constante o variable. Esfuerzo:
  chico.
- [ ] **Rutas `/nodes/*`** (`INTEGRACION.md` §2), con la sesión de cuenta real en lugar de
  `x-dev-operator`, los límites documentados (registro 5 por IP por hora, tokens 10 por cuenta por
  día, señalización 10 por IP por minuto) y sin invitados. Nada de `/dev/*`: en el servidor de
  referencia cualquiera puede entrar como "Proyecto" (`control-plane/devServer.ts`). Incluye
  `GET /nodes/releases/channel` como ruta propia. Sin la tienda en esta etapa: `/nodes/shop`,
  `/nodes/shop/claim` y `/api/me/items` llegan en la etapa 2, con el ledger guardado. Esfuerzo:
  medio.
- [ ] **Solo el proyecto crea tokens.** `POST /nodes/tokens` responde 403 a toda cuenta que no
  esté en `NODE_TRUSTED_OPERATORS`. Hoy `Registry.createToken` solo valida la región
  (`control-plane/registry.ts:173`): con la ruta abierta, cualquier cuenta pondría un VPS a prueba
  y hostearía casuales, con la IP de los jugadores a la vista y sin términos. Con este filtro no
  hace falta otra ruta para el token del VPS de São Paulo.
- [ ] **Un interruptor sin deploy.** Un flag de KV, `vm_disabled` como pide
  `docs/online/DECISIONS.md`, que saltea el gancho de los nodos y manda todo a `MatchDO`. Si el VPS
  o el plano de control fallan en la beta, se apaga en un minuto. Esfuerzo: chico.
- [ ] **Costo del DO: decidir el intervalo de heartbeat.** Las solicitudes cuestan poco: la alarma
  de 5 s suma unas 518.000 por mes, y los mensajes de WebSocket entrantes cuentan 1 de cada 20.
  Pasado el millón incluido, menos de US$ 0,10 por mes. Lo que sí pesa es la duración: un DO
  solo hiberna tras 10 s sin eventos, así que con heartbeats o alarma cada 5 s nunca hiberna. Son
  unos 324.000 GB-s por mes, el 81 % de los 400.000 incluidos en Workers Paid, compartidos con las
  partidas en `MatchDO` (developers.cloudflare.com/durable-objects, páginas de precios y ciclo de
  vida, 2026). Opciones: heartbeats cada 30 s con 90 s de tope, que tardan más en detectar un nodo
  caído y en liberar los locks; o pagar esa duración.

### Matchmaker y resultados

- [ ] **El gancho en `MatchmakerDO.formMatch`** (`server/src/MatchmakerDO.ts:1057`), como
  describe `INTEGRACION.md` §3: equipos, `rankedLock` extraído, `issueNode`, un tipo de lock
  `node` con su propia verificación (estados `assigned` o `reporting`). Esfuerzo: medio.
- [ ] **El tope de salas no tiene que frenar a los nodos.** `MAX_ACTIVE_ROOMS = 20`
  (`MatchmakerDO.ts:88`) se chequea en tres lugares: al entrar a la cola (línea 598, responde
  `503`), al arrancar una sala privada (874) y antes de `formMatch` (1034). Al llegar al tope
  nunca se intenta un nodo. El intento de nodo va primero, y las partidas en nodos no cuentan para
  ese tope. Lo mismo con el flag `do_disabled`: hoy rechaza toda cola
  (`server/src/index.ts:346`); con nodos, solo tiene que saltear el `MatchDO`.
- [ ] **No reescribir la URL de una partida de nodo.** `queue()` cambia toda `wsUrl` por
  `/ws/<id>` (`server/src/index.ts:392`).
- [x] **IDs de partida de 64 caracteres.** Hecho: `randomHexId(32)` en `place()`. Las rutas del
  Worker solo aceptan 64: el resultado ranked responde `400 bad_match_id`
  (`server/src/accountRoutes.ts:394`), `/api/rejoin` también, y `/api/leave` ignora el id.
- [ ] **`/api/rejoin` y `/api/leave` para partidas de nodo.** Aun con 64 caracteres, `/api/rejoin`
  usa `env.MATCH.idFromString`, que rechaza un id que no es de un `MatchDO`: necesita su propio
  camino hacia `ControlPlane.rejoinTicket()`. `/api/leave` lleva `{ matchId, connected }` a
  `ControlPlane.leave()`.
- [ ] **Resultados a `AccountsDO`**: `rated` a `/ranked-result`, `void` de una ranked a
  `/ranked-cancel`, y `/release` al matchmaker de la región (`INTEGRACION.md` §4).

### Cliente: cambios chicos que igual hacen falta

- [ ] **Esperar el resultado ranked más tiempo.** `waitRankedResult` prueba 15 veces, una por
  segundo (`waitRankedResult` en `src/net/AccountClient.ts`). Un resultado de nodo llega recién después de subir el
  replay y verificarlo. Mostrar "verificando" y seguir preguntando.
- [ ] **Mandar `connected` en `/api/leave`.** Hoy el cliente manda solo `{ matchId }`
  (el `post('/api/leave')` de `src/net/NetClient.ts`) y el Worker no pasa otro campo
  (`server/src/index.ts:587`). Sin
  `connected: false`, cancelar mientras conecta a un nodo cuenta como dodge en una ranked, aunque
  el jugador nunca haya entrado. Esfuerzo: chico.
- [ ] **Cerrar la pestaña en una ranked.** En `MatchDO`, un jugador desconectado al pitazo cuenta
  como abandono. En un nodo solo cuentan las salidas que pasan por el plano de control, y el
  cliente no avisa al cerrar la pestaña: cerrarla evita la sanción. Opciones: en nodos de
  confianza, aceptar la regla de `MatchDO` con el dato del nodo; o que el cliente mande la salida
  al cerrar, con `pagehide` y `fetch` con `keepalive: true`. `sendBeacon` no sirve: no puede
  mandar el encabezado `Authorization` que pide `/api/leave`.

### Releases: antes de instalar el VPS

- [ ] **Publicar la primera release.** `install.sh` baja `launcher.mjs` y su firma de
  `/nodes/releases/` antes de hacer nada (`install/install.sh:108`). Hoy la única forma de subirla
  es `github/workflows/node-release.yml`. Si la clave nueva de la etapa 0 vive en CI, ese workflow
  se instala en esta etapa. Si vive en una máquina sin conexión: firmar ahí y subir con
  `wrangler r2 object put`. `channel.json` se sube aparte, siempre a mano.
- [ ] **Bucket `NODE_RELEASES` y las rutas `/nodes/releases/*`.**
- [ ] **Cada deploy del juego que cambie el wasm o el protocolo necesita una release del nodo.**
  Sin ella, ningún nodo recibe partidas: elegir nodo y verificar exigen el mismo hash de wasm y la
  misma versión de protocolo. La release se arma desde el mismo commit que se despliega, y el
  canal se mueve en el mismo paso. Esto va a la lista de pasos de cada deploy.
- [x] **Las pruebas de `nodes/` en CI.** Hecho: el trabajo "Community nodes (typecheck, tests)" de
  `.github/workflows/ci.yml` corre en cada PR, así que un cambio en `MatchDO`, el protocolo o el
  wasm que rompa los nodos frena el PR. CONTRIBUTING.md tiene el comando para correrlo local.
- [ ] **`MatchRoom` es un port a mano de `MatchDO`.** Cada arreglo en `MatchDO` hay que llevarlo
  también a `node/matchRoom.ts`.

### El VPS de São Paulo

- [ ] **Darle un nombre DNS.** El chequeo de alcance hace `fetch` a `https://<publicUrl>/healthz`
  desde el plano de control (`control-plane/controlPlane.ts`, `probe`), y un Worker no puede
  hacer `fetch` a una IP: solo a nombres. Lo confirma la documentación de Cloudflare (Workers,
  "Known issues", "Fetch to IP addresses", 28/09/2026). Con una IP, el VPS nunca pasa de pendiente
  y nunca hostea. Lo más simple: un nombre como `sp1.turbo-gol.com`. El registro DNS tiene que
  existir antes de correr el instalador.
- [ ] **Con o sin el proxy de Cloudflare.** `docs/online/DECISIONS.md` (decisión 3, confirmada)
  pone el servidor detrás del proxy. Sin proxy, la IP del VPS que verifica todo queda a la vista.
  Probar las dos formas el primer día: que el chequeo de `/healthz` pase desde el Worker y cuánta
  latencia suma el proxy desde Argentina.
- [ ] **El instalador ya acepta un nombre:** `--public-host sp1.turbo-gol.com`
  (`install/install.sh:50`) arma el Caddyfile para ese nombre. El perfil `shortlived` de Let's
  Encrypt también sirve para nombres, con certificados de 6 días; sin ese bloque, salen los de
  90 días.
- [ ] **Instalarlo con `--roles host,verify --public-host sp1.turbo-gol.com --egress-cap-gb <GB del
  plan>`** y respaldar `/var/lib/turbogol-node/node.json`. Sin `--public-host`, el instalador usa
  la IP de `/nodes/whoami`. Sin `--egress-cap-gb`, nada frena al VPS antes de pasarse de la
  transferencia incluida, como pide `docs/online/DECISIONS.md`.
- [ ] **El plan del VPS dentro del presupuesto.** `docs/online/DECISIONS.md` le asigna US$ 7 por
  mes, y `VPS-SAO-PAULO.md` recomienda 2 vCPU y 4 GB. Confirmar el precio en São Paulo antes de
  alquilarlo, o corregir la línea del presupuesto. Anotar cuántas partidas da el benchmark del
  instalador: es una medición pendiente de ese documento.
- [ ] **Probar con un navegador real**, desde turbo-gol.com: una casual, una ranked, una salida y
  un forfeit, y ver el resultado en la pantalla de fin de partida. Jugar con dos cuentas que no
  sean la que registró el VPS: si juega el operador, el scheduler no usa su nodo
  (`control-plane/scheduler.ts:57`) y la ranked cae en un `MatchDO` sin aviso. La casual, con la
  conexión en "Servidor". Confirmar en el `Welcome` que `hostColo` dice `node:sao-paulo-1`.

### Ya resuelto en el código (19/10/2026)

- [x] **Qué se verifica:** todas las ranked; las casuales por muestreo (decisión 7). Baja la carga
  del verificador a la de las ranked más una parte de las casuales.
- [x] **El verificador corre la misma versión del nodo que el host.** Antes solo se comparaban el
  wasm y el protocolo: una release que cambiara las reglas o los bots en JavaScript habría hecho
  fallar verificaciones honestas y suspendido hosts inocentes.
- [x] **El rol "verificador" queda reservado a los nodos del proyecto.** Un nodo de la comunidad
  no podía recibir trabajos de verificación, y el veredicto actual se puede armar leyendo el
  replay sin simular. Volver a abrirlo pide los ticks de desafío de la verificación comunitaria.
- [x] **El verificador se elige al azar** entre los menos ocupados, y de preferencia uno cuyo
  operador no jugó la partida.
- [x] **Una partida que se tiene que verificar solo va a un nodo que alguien puede re-simular:** una
  ranked, o cualquiera de un nodo a prueba, necesita un verificador de confianza en la misma
  versión del nodo. Así una actualización no deja ranked sin verificar.
- [x] **Un verificador del proyecto con la actualización pendiente no toma partidas nuevas,** para
  que las suyas terminen y pueda actualizarse.
- [x] **Una casual no muestreada igual tiene que tener su replay subido,** y cuenta para la
  repetición del grupo: así los puntos por muestreo dan en promedio lo mismo que verificar todo.

### Operación mínima

- [ ] **Rutas de mantenedor:** cambiar el estado de un nodo y drenarlo. El VPS es de confianza:
  una verificación fallida no lo suspende ni congela nada (`onVerified` en `control-plane/registry.ts`), solo
  anula la partida y deja un `ALERT`.
- [ ] **Alertas por webhook,** por ejemplo al Discord del proyecto. Hoy los `ALERT` solo van al
  log.

### Pruebas antes de abrir la beta

- [ ] Un deploy del Worker en medio de una partida.
- [ ] Un reinicio del VPS en medio de una partida: se anula sin penalizar a los jugadores.
- [ ] Una actualización del nodo con partidas en curso: drena y vuelve.
- [ ] Un cambio de wasm en el juego: los nodos dejan de recibir partidas hasta la release nueva,
  y la cola de verificación del build viejo se vacía antes de que el verificador se actualice.
- [ ] Cancelar mientras conecta a una ranked: no cuenta como dodge.

## Etapa 2: PCs de amigos

### Quién participa

- [ ] **Solo amigos crean tokens.** La lista de `POST /nodes/tokens` suma las cuentas de los
  amigos. No van en `NODE_TRUSTED_OPERATORS`: esos nodos entran activos sin prueba y se pueden
  verificar a sí mismos.
- [ ] **Solo cuentas de la beta juegan en sus PCs.** Con el cliente nuevo, cualquier desconocido
  podría caer en la PC de un amigo y ver su IP, y el scheduler no puede restringirlo. Lo más
  barato: el Worker agrega `rtc` a los transportes de la cola solo para cuentas de una lista.

### Cliente

- [ ] **El adaptador WebRTC** en `src/game/OnlineSession.ts`, donde se crea el `NetClient`:
  `webSocketFactory: nodeAwareSocketFactory()`. Mover `client/rtcSocket.ts` a `src/`: hoy
  `npm run typecheck` no lo revisa, porque `tsconfig.json` no incluye `client/`.
- [ ] **`POST /api/queue` manda `transports`**, y la cola guarda `account` y `accountAgeDays` de
  cada jugador. Sin esos dos datos, todos pesan como invitados y los anfitriones ganan la cuarta
  parte.
- [ ] **La pantalla "Poner un servidor"** en `src/ui`, a partir de `web/host.html`.

### TURN

- [ ] **Primero el tope de 900 GB, después las credenciales** (`TURN_KEY_ID` y `TURN_KEY_TOKEN`).
  Así lo pide `docs/online/PHASE2.md`, y los mismos secretos prenden el TURN del P2P casual en
  `GET /api/ice`. Cloudflare no tiene tope de gasto: al llegar al tope, dejar de mandar partidas a
  PCs (van a los servidores del proyecto) y nunca pasar a conexión directa en silencio. Sin
  credenciales ninguna PC recibe partidas: el autotest tiene que pasar por el relay.
- [ ] **Credenciales que duren lo que la partida.** Hoy duran 600 s (`TURN_TTL_SECONDS` en `server/src/env.ts`), y
  Cloudflare corta la conexión poco después de que vencen. Una partida vive su largo más 600 s de
  tope, contados desde que se crea: la espera de ingreso entra ahí, y las pausas de gol lo estiran
  un poco. Son unos 13 minutos en una partida de 3 y unos 20 en una sala privada de 10, la más
  larga. Pedir la duración según la partida y revocarlas al terminar.
- [ ] **Relay en el nodo,** si se adopta la recomendación 1 de la sección "Forzar TURN": oculta
  la IP del anfitrión casi sin costo.

### Pruebas en redes y máquinas reales

- [ ] **Un navegador real contra un nodo real**, por redes distintas: CGNAT, NAT simétrico, datos
  móviles. Las pruebas de hoy usan `werift` en los dos extremos y la misma máquina.
- [ ] **Medir la latencia directa contra la latencia por relay** desde Argentina y Brasil.
- [ ] **Los instaladores en máquinas reales:** Windows 10 y 11 sin administrador, macOS Intel y
  Apple Silicon, Linux de escritorio. Probar instalar, apagar con `-Stop`, actualizar y
  desinstalar. Mientras tanto, a los amigos les sirven `npm run node -- register` y `run`: las
  pruebas cubren `registerNode` y `NodeRuntime`, que esos comandos usan.

### Puntos

- [ ] **Guardar el ledger, los canjes y los inventarios antes de dar puntos.** Si no, cada deploy
  borra lo ganado. Recién ahí se abren las rutas de la tienda.
- [ ] **Rutas de mantenedor para la tienda:** descongelar los canjes de un operador, levantar la
  suspensión de su nodo y editar el catálogo. Desde esta etapa, una verificación fallida suspende
  la PC de un amigo y congela sus canjes.
- [ ] **La insignia de Anfitrión.** Está disponible en el catálogo (`RECOMPENSAS.md`), así que los
  amigos la van a canjear en esta etapa. El juego tiene que mostrarla en el perfil, y el nombre del
  anfitrión en la pantalla de carga, con `GET /api/me/items`. Si no, dejarla como "próximamente".
- [ ] **Recalibrar con datos reales.** Entre pocos amigos que juegan siempre juntos, el factor de
  repetición, el peso de las cuentas nuevas y "los minutos del propio operador no cuentan" van a
  dar mucho menos que los 90 puntos por noche de `RECOMPENSAS.md`.

### Decisiones de producto

- [ ] **El casual por defecto es P2P** (las preferencias por defecto en `src/ui/Menu.ts`, y "P2P
  (recomendada)" en `src/locales/es.ts`). Las salas P2P nunca pasan por `formMatch`, así que nunca llegan
  a un nodo. Las PCs en prueba solo hostean casuales y necesitan 20 verificadas para el ranked:
  sin casuales por servidor, tardarían mucho. Hay que decidir si los nodos comunitarios toman
  casuales, por ejemplo con una opción "servidores de la comunidad".
- [ ] **La latencia no entra en la elección del nodo.** Las regiones son continentes y el
  scheduler elige al azar entre los menos cargados. Para la beta, preferir el VPS de São Paulo;
  después, que el cliente mida el ping a los nodos de su región.

## Etapa 3: abierto a cualquiera

### Legal y términos

- [ ] **Términos para operadores** y un **aviso de privacidad para jugadores:** qué datos ve un
  operador (nombre, id de jugador, inputs y, sin relay, la IP), uso de ancho de banda, reglas de
  los proveedores de internet sobre servidores hogareños, suspensiones y apelaciones. Hoy no hay
  términos ni política de privacidad en el repo.
- [ ] **Revisión de un abogado.** Esto no es asesoramiento legal. Puntos a mirar:
  - **La IP como dato personal:** el GDPR la nombra (considerando 30). En Argentina, la Ley 25.326
    no la nombra y hay fallos en contra; en Brasil, la LGPD protege datos de personas
    identificables.
  - **Cederla a operadores:** el art. 11 de la Ley 25.326 pide el consentimiento previo e informar
    para qué y a quién se ceden los datos, con excepciones. El art. 25 permite tratar a los
    operadores como prestadores, con un contrato.
  - **Transferencias:** Brasil, Chile y Estados Unidos no figuran en la lista de países adecuados
    de la AAIP. En Brasil, las transferencias por cláusulas usan las de la ANPD.
  - **Menores:** el ECA Digital de Brasil (Lei 15.211/2025) rige desde el 17/03/2026 y pide la
    configuración más privada por defecto en servicios dirigidos a menores o de acceso probable por
    ellos, juegos incluidos.
  - **Jugadores europeos:** el GDPR, incluida la obligación de informar a quién se entregan los
    datos.

### TURN y presupuesto

- [ ] **Forzar el relay de los jugadores** según lo decidido, con el tope de GB funcionando antes.
  Con los jugadores por relay, el tope de 900 GB alcanza para unas 900 horas de 2v2 por mes en
  PCs, menos lo que use el P2P casual. Pasar de ahí pide subir el presupuesto de US$ 50.

### Confianza y disponibilidad

- [ ] **Un nombre para cada VPS comunitario.** El chequeo de alcance corre en el Worker, que no
  puede pedir una IP, y el instalador hoy usa la IP por defecto (el `/nodes/whoami` de `install/install.sh`). Un
  VPS registrado por IP nunca pasa de pendiente. Opciones: que el operador traiga su dominio
  (`--public-host`), que el plano de control le dé un subdominio del proyecto con la API de DNS de
  Cloudflare, o hacer el chequeo desde una máquina fuera de Workers, como el verificador.
  Esfuerzo: medio.
- [ ] **Un segundo verificador de confianza.** Con uno solo, si el VPS de São Paulo se cae, los
  resultados esperan hasta 6 horas y después se anulan. `docs/online/DECISIONS.md` ya lo pone en
  Hetzner (Ashburn o Falkenstein), con su presupuesto.
- [ ] **Verificar en un worker thread,** para que un VPS que hostea y verifica use sus dos
  núcleos.
- [ ] **Un canal canary que funcione.** El campo existe en el protocolo, pero el lanzador no lo
  lee: una versión estable llega a todos los nodos cuando reinician.
- [ ] **Confirmación de inputs desde el cliente** (v2). Hoy un nodo podría ignorar los inputs de
  un jugador o fabricar 60 s de controles nulos para un forfeit; los jugadores lo notan, pero la
  re-simulación no lo ve. Con desconocidos hosteando ranked, esto importa. La misma medición
  devuelve la bonificación de calidad de 1,2 (`RECOMPENSAS.md`).
- [ ] **Un canal sin orden para inputs y snapshots.** `docs/online/DECISIONS.md` (decisión 3)
  pide `{ ordered: false, maxRetransmits: 0 }`. Los nodos usan un solo canal confiable y ordenado
  (decisión 4 de `DECISIONES.md`): en datos móviles, una pérdida frena todo lo que viene atrás.
  Necesita cambios en `NetClient`.
- [ ] **Rotar la clave de control.** Cada nodo guarda la mitad pública al registrarse
  (`node/register.ts:56`) y no hay forma de cambiarla. Si la clave se filtra, hay que registrar
  todos los nodos de nuevo. Hace falta un camino para mandar la nueva, por ejemplo en una release.

### El primer auto de la tienda

- [ ] **El auto:** un segundo modelo, solo estético, con el mismo hitbox, para que el wasm y el
  verificador no cambien. Precio decidido: 1.500 puntos.
- [ ] **El inventario:** `GET /api/me/items` con una tabla en `AccountsDO` (hoy no existe). Si la
  insignia ya lo trajo en la etapa 2, se reutiliza.
- [ ] **El protocolo:** un campo estético en el roster, que sube `PROTOCOL_VERSION` y por lo tanto
  exige una release nueva del nodo. El mismo campo va en el roster de las salas P2P, que sube
  `P2P_PROTOCOL_VERSION` (`src/net/p2p/protocol.ts:30`): si no, el auto no se ve en el casual por
  defecto.
- [ ] **El servidor valida que la cuenta tenga el ítem,** y el selector de autos lo ofrece.

### Operación

- [ ] **Página pública de estado, tableros de salud** y un procedimiento para reportes de
  ataques a IPs hogareñas.
- [ ] **Una herramienta para revisar nodos suspendidos.**
- [ ] **Soporte de instaladores:** SmartScreen y antivirus con la línea de PowerShell, instalación
  de Node con winget, avisos del firewall y una guía de problemas comunes.

### Automatización de GitHub

- [ ] **Instalar las plantillas** de `github/` en `.github/`: `CODEOWNERS` y los workflows del bot.
  `node-release.yml` ya entró en la etapa 1. Alinear las versiones de las acciones con
  `.github/workflows/ci.yml`, fijar la versión de `wrangler` y configurar `CLOUDFLARE_ACCOUNT_ID`.
- [ ] **Hoy `main` pide 0 aprobaciones** (regla leída el 15/10/2026): CI en verde sí, revisión no.
  Un PR del bot entraría con un solo clic. Con un solo mantenedor, la revisión humana es que él lo
  lea antes de mergear.
- [ ] **Cuidado con CODEOWNERS:** con un solo dueño, exigir la revisión de los dueños del código
  bloquea sus propios PR, porque GitHub no deja aprobar un PR propio. Hace falta un segundo
  mantenedor, o no activar esa regla.
- [ ] **Permitir `anthropics/claude-code-action`.** Según las notas del proyecto, desde el
  15/10/2026 el repo solo permite acciones de GitHub, así que el bot hoy quedaría bloqueado.
  Agregarla a la lista de permitidas, fijada por SHA.

## Forzar TURN: costos y decisión

Cloudflare cobra solo lo que sale de su red hacia quien usa el TURN. Los primeros 1.000 GB por
mes son gratis, compartidos con el TURN del P2P casual, y después cuesta US$ 0,05 por GB
(developers.cloudflare.com/realtime, páginas de precios y de TURN, 2026).

| Qué se oculta | Qué se cobra | Costo |
|---|---|---|
| La IP del anfitrión (relay en el nodo) | Solo los inputs de los jugadores hacia el nodo | Casi nada; medirlo en staging |
| La IP de los jugadores (relay en el navegador) | Todo el tráfico de la partida hacia los jugadores | Ver la tabla siguiente |
| Las dos | Lo mismo que la anterior, más los inputs | Casi igual que la anterior |

| Partida | GB por hora | Costo por hora pasado lo gratis |
|---|---|---|
| 1v1 | 0,32 | US$ 0,016 |
| 2v2 | 0,97 | US$ 0,049 |
| 3v3 | 1,95 | US$ 0,098 |

| Uso mensual en PCs, en 2v2 | Costo aproximado |
|---|---|
| 1.000 horas | 0, entra en lo gratis |
| 3.000 horas | US$ 96, más que todo el presupuesto mensual de US$ 50 |
| 10.000 horas | US$ 435 |

Los GB medidos no incluyen el encabezado de TURN: el costo real puede ser algo mayor. Que el
relay en los dos lados se cobre una sola vez es una deducción de la documentación, no una
afirmación de Cloudflare.

**Recomendación:**
1. **Ocultar la IP del anfitrión desde la etapa 2.** Cuesta casi nada y cierra un truco real:
   tirar abajo la conexión del anfitrión para anular una ranked perdida.
2. **Jugadores con relay por defecto al abrir al público,** con una opción "conexión directa,
   menos ping" que avise que el anfitrión verá su IP. Con el tope de 900 GB, alcanza para unas 900
   horas de 2v2 por mes en PCs.
3. **Medir antes de decidir:** una partida de prueba por modo, con identificadores propios en las
   credenciales para ver los bytes en las analíticas de TURN de Cloudflare.

**Lo que hay que cambiar en el código.** En el nodo, para la etapa 2:
- [ ] `answerOffer` con un parámetro `relayOnly`. Hoy no lo tiene: en `node/rtcTransport.ts`
  solo la función interna `peer()` lo acepta, y solo el autotest lo usa, en un lado.
- [ ] `werift` solo se limita al relay si tiene un TURN con usuario y clave: sin TURN juntaría
  igual candidatos directos. Hay que rechazar la oferta en ese caso.
- [ ] Con solo relay, la respuesta tiene que esperar al menos un candidato relay. Hoy el límite es
  de 4 s, y en una red que bloquea UDP `werift` tarda unos 6,4 s en pasar a TCP.
- [ ] El autotest tiene que probar relay contra relay, igual que en producción. Hoy solo un lado
  usa relay.
- [ ] El plano de control borra los candidatos que no son relay de la respuesta del nodo.

En el navegador, para la etapa 3:
- [ ] `iceTransportPolicy: 'relay'` en `client/rtcSocket.ts`; mejor si el plano de control lo
  manda en la respuesta de `/ice`, para cambiarlo sin publicar un cliente.
- [ ] El plano de control borra los candidatos que no son relay de la oferta y rechaza los
  clientes viejos que no piden relay.
- [ ] Si TURN falla, no hay partidas en PCs. Nunca conexión directa en silencio.

**Lo que forzar TURN no cubre:** los VPS comunitarios por WebSocket ven la IP de los jugadores, y
el P2P casual expone las IPs entre jugadores. Si la promesa es "nadie ve tu IP", esos dos caminos
también tienen que cambiar.

## Decisiones pendientes del mantenedor

1. **Modo de relay:** la recomendación es ocultar al anfitrión desde la etapa 2 y a los jugadores
   por defecto al abrir. Pasar de unas 900 horas de 2v2 por mes con relay pide subir el
   presupuesto.
2. **Casuales en nodos comunitarios:** sí o no, y cómo se elige.
3. **Cerrar la pestaña en una ranked de nodo:** cómo se sanciona.
4. **El nombre del VPS de São Paulo:** con o sin el proxy de Cloudflare.
5. **Intervalo de heartbeat:** 5 s, con el DO siempre despierto, o 30 s, que tarda más en
   detectar un nodo caído.
6. **Segundo verificador:** cuándo se levanta el de Hetzner.
7. **El primer auto:** cuál es. El precio ya está decidido en 1.500 puntos.

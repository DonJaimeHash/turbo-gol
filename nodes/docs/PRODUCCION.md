# Camino a producción

> Estado al 19/10/2026. El prototipo vive en `nodes/` del repo y funciona como demo local: las pruebas
> automáticas pasan y corren en el CI de cada PR, y la demo de
> punta a punta funciona (`node --import ./dev/ts-resolve.mjs scripts/demo.mjs --once`). **No está
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
- [ ] **Respaldar `.keys/` fuera de la PC del mantenedor.** Las claves de control y de releases
  siguen solo en su carpeta privada, fuera del repo. Guardar una copia en un gestor de
  contraseñas.
- [ ] **Tratar la clave de releases actual como clave de desarrollo.** La release 0.1.0 se firmó
  en la PC del mantenedor (`npm run build` usa `--sign .keys/release.json`). Antes de la primera
  release real: una clave nueva (M5) que viva en un entorno de CI con aprobación manual (M6), y
  los instaladores armados con su mitad pública (P12). Ver la etapa 1.

## Etapa 1: beta con el VPS de São Paulo

Objetivo: el VPS del proyecto hostea partidas por WebSocket (el cliente actual ya sabe
conectarse) y verifica. Sin PCs hogareñas todavía, así que no hacen falta TURN ni el adaptador
WebRTC. El VPS es de confianza y no gana puntos, así que el ledger y la tienda esperan a la
etapa 2. Ningún jugador nota un cambio hasta que un flag de KV prende los nodos, salvo lo que ya
pasa con cualquier deploy del Worker: reinicia las partidas en curso de `MatchDO`, y sus jugadores
reciben `410 match_reset` (`server/README.md:195`, `server/src/MatchDO.ts:223-230`). Por eso cada
deploy de esta etapa va a una hora tranquila.

El trabajo está partido en ocho PR, [1] a [8]. Cada PR agrupa piezas, de P1 a P30. Las acciones
M1 a M16, que solo puede hacer el mantenedor, están en la tabla "Acciones del mantenedor"; las
propuestas D, en "Decisiones pendientes del mantenedor", al final. Las líneas citadas son del
commit `dead8ec` (19/10/2026).

### El VPS

- [x] **Comprado** el 19/10/2026 por 24 meses: Hostinger KVM 2 en Campinas, Brasil (2 vCPU, 8 GB,
  100 GB, 8 TB de transferencia por mes, Ubuntu 26.04). El precio real está en
  `docs/online/DECISIONS.md`.
- [x] **Endurecido** (M1, M2): acceso solo con clave, firewall con 22, 80 y 443, fail2ban,
  actualizaciones de seguridad sin reinicios automáticos.
- [x] **Con nombre y certificado** (M3): `sp1.turbo-gol.com`, registros A y AAAA solo DNS, y un
  certificado de Let's Encrypt en Caddy.
- [x] **Medido:** las pruebas de `nodes/` pasan en el VPS; el benchmark da de 52 a 77 partidas
  con el 60 % de un núcleo; 12 partidas de 3 minutos grabadas en la PC del mantenedor y en el VPS
  verifican igual en las dos máquinas, en los dos sentidos (`nodes/scripts/xmachine.mjs`).
- [ ] **(Opcional) medir el camino por el proxy de Cloudflare** antes de confirmar D4.
- [ ] **La CPU bajo carga sostenida,** antes de instalar el nodo: los créditos de CPU de Hostinger
  pueden frenarla, y el resultado decide el `--matches` de la instalación (D20).
- [x] **Nodo instalado** el 20/10/2026: `sao-paulo-1`, release 0.2.0, activo, con `--matches 15`
  (D20 con el benchmark de 52; se sube con la prueba de CPU bajo carga) y `node.json` respaldado
  (M11, M12). El instalador de la 0.2.0 lo registró como "Ubuntu" por un bug con
  `/etc/os-release`, ya corregido; ver `VPS-SAO-PAULO.md`.

Todo el detalle, el procedimiento de instalación y la operación: `VPS-SAO-PAULO.md`.

### Por qué este orden

- **Hasta el deploy de [6] (#28), el VPS no puede recibir jugadores.** El instalador baja primero
  `launcher.mjs` de `/nodes/releases/` (`install/install.sh:108`), y en producción esa URL
  devuelve el `index.html` del juego: `/nodes/*` no está en `run_worker_first`
  (`server/wrangler.jsonc:49`) y el Worker manda al sitio todo lo que no empieza con `/api/`
  (`server/src/index.ts:649`). Y no hay plano de control en el Worker hasta ese deploy.
- **El estado se guarda antes de instalar.** Un VPS registrado contra un plano de control que no
  guarda nada queda huérfano en el próximo deploy. [1] ya escribe todo en un almacén; [6] lo pone
  en el SQLite del `NodeRegistryDO`.
- **Camino crítico:** [1] → [6] → la release 0.2.0 ([2], [5] y M5 a M10) → instalar el VPS →
  [7] → [8] → canary → `nodes_on`. Unas 3 a 4 semanas para una persona. [2], [3] y [4] pueden ir
  en paralelo desde ya, y [5] apenas existan las claves (M5). [3] tiene que estar desplegado antes
  del canary.

### Los PR

#### [1] nodes: persistencia y API del plano de control (P2-P7): hecho, #23

- [x] **P2. `control-plane/persist.ts`:** filas para nodos, tokens y partidas, con
  `STATE_VERSION`. No guarda lo que solo cambian los heartbeats, recalcula `trusted` al cargar y
  una partida en `reporting` vuelve como `assigned` (el nodo reenvía su reporte).
- [x] **P3. `Registry`:** guarda en cada cambio que importa, nunca en un heartbeat, y carga al
  arrancar. Un token registra un solo nodo aunque dos registros compitan. Cada token y cada nodo de
  un operador de confianza deja un `ALERT`.
- [x] **P4. `ControlPlane`:** guarda cada partida antes del mensaje que depende de ella; el
  resultado se guarda junto con la partida terminada; 90 s de gracia después de un arranque en frío
  con partidas sin terminar; `adopt()` para los sockets que sobreviven a una hibernación. Si una
  escritura falla, la partida queda como estaba y el reporte del nodo se toma de nuevo.
- [x] **P5. La API para el Worker:** `rejoin` con códigos (`no_match`, `not_in_match`, `left`,
  `match_over`, `offline`), `matchStatus`, `hostsOnline` y `channelChanged()`. `leave`
  responde `recorded: true` apenas guarda la salida, aunque no llegue al nodo.
- [x] **P6. Volver a comprobar el alcance:** cada 5 minutos; después de 3 fallas seguidas el nodo no
  recibe partidas por `wss` y deja un `ALERT`, hasta que vuelve a responder.
- [x] **P7. El abandono en nodos de confianza (`connectedAtEnd`):** en una ranked de un nodo de
  confianza, quien no tiene conexión al pitazo cuenta como abandono, igual que en `MatchDO` (D6).
  Llega a producción con el nodo 0.2.0, que manda el dato.
- [x] **Un corte corto del enlace de control:** un nodo de confianza que se reconecta en menos de
  60 s conserva sus partidas.
- [x] **Del lado del plano de control, contra el abuso:** la firma de una subida de replay se
  comprueba antes de leer el cuerpo, y los sockets sin autenticar tienen un tope de 64. Los límites
  por IP en el Worker son de [6].

#### [2] nodes 0.2.0: arreglos del nodo y del instalador (P8-P11): hecho, #24

Sale con la release 0.2.0: el instalador se publica junto con ella.

- [x] **P8.** La subida del replay prueba 12 veces, unos 75 s: aguanta un deploy del Worker.
- [x] **P9.** El lanzador no arranca una release que pide un Node más nuevo que el de la máquina, y
  explica por qué en el log.
- [x] **P10. Caddy para un nombre DNS:** certificado de 90 días para un nombre (el perfil de 6 días
  solo para una IP), `stream_close_delay 30m`, sin HTTP/3, y Caddy validado antes de gastar el
  token.
- [x] **P11. Volver a correr el instalador:** con `node.json` es una actualización, sin token;
  `--restore <node.json>`; `--matches <n>|auto`; antes de gastar el token comprueba que cada
  dirección A y AAAA del nombre lleva a esta máquina (con `curl -4` para `whoami`) y que el
  Caddyfile es suyo.
- [x] **El script de determinismo entre máquinas** (`nodes/scripts/xmachine.mjs`,
  `npm run xmachine`): graba 12 partidas completas y verifica las de otra máquina. `record`
  compara con la referencia del 19/10/2026 (`scripts/xmachine-reference.json`). Probado en el VPS
  real: las 12 coinciden con la referencia grabada en Windows.

#### [3] cliente: partidas en nodos (P27-P30): hecho, #25

Nada cambia mientras el anfitrión no sea un nodo. Tiene que estar desplegado antes del canary.

- [x] **P27.** Después de una ranked en un nodo, el menú avisa que el resultado se está verificando
  y lo espera hasta 2 minutos; una partida que no pasó la verificación aparece como que no contó.
- [x] **P28.** El panel de red muestra `host node:<nombre>` cuando el anfitrión es un nodo.
- [x] **P29.** La sesión se renueva al empezar una partida de nodo, y una salida rechazada se
  reintenta una vez con una sesión fresca del mismo jugador.
- [x] **P30.** `connected: false` en `/api/leave` cuando no llegó el `Welcome` (lo usa la
  etapa 2).

#### [4] docs

Objetivo: que los documentos digan lo que hace el código hoy, y que la prueba de determinismo del
VPS quede en el repo. Los cambios de diseño se documentan con el PR que los construye.

- [x] **P1.** Este plan, el manual del VPS real (`VPS-SAO-PAULO.md`), las correcciones de
  `INTEGRACION.md`, `ARQUITECTURA.md` y `BOT.md`, y el precio real del VPS en
  `docs/online/DECISIONS.md`.

#### [5] releases: clave, firma, workflow y compuerta de deploy (P12-P16, P21): #27

Desde el merge, `npm run deploy` lee el canal en R2 antes de cada deploy (el token necesita R2,
M8), y hasta M10 cada deploy va con `npm run deploy -- --nodes-off`.

- [x] **P12. La clave pública de releases en el repo** (`nodes/release-key.pub`, de M5).
  `node scripts/build-node.mjs` arma la release sin firmar y llena los tres instaladores con esa
  clave. Solo arma un commit: rechaza un árbol con cambios, y no corre con la clave privada en su
  entorno. El manifiesto anota el `commit` y `inputsSha256`, el hash de `inputs.json`: los
  archivos del repo que entran al bundle (las dependencias, por su lockfile), los `tsconfig.json`
  y `package.json` que los configuran, y el wasm. Nunca escribe `channel.json`. `npm run build`
  sigue firmando con `.keys/release.json` y avisa que esa release nunca se sube; los dos modos
  rechazan una clave de desarrollo igual a `release-key.pub`.
- [x] **P13. `nodes/scripts/sign-release.mjs`** (`npm run sign`): firma solo con `node:crypto`,
  con la clave de `TGN_RELEASE_PRIVATE_KEY` o de `--key`. No firma si la clave no es la de
  `release-key.pub`, ni si la release no pasa sus comprobaciones: el commit del manifiesto es el de
  la corrida (`GITHUB_SHA`); cada archivo, contra el manifiesto, e `inputs.json`, contra su hash en
  el manifiesto; el wasm y los instaladores, byte a byte contra el checkout, y el protocolo, contra
  `src/net/protocol.ts`. `node.mjs`, `launcher.mjs` y la lista de `inputs.json`, que después lee
  la compuerta (P21), no se vuelven a armar: firma lo que armó el trabajo de build, que corre sin
  secretos en una máquina nueva.
- [x] **P14. `.github/workflows/node-release.yml`,** con un tag `node-vX.Y.Z` igual a la versión
  de `nodes/package.json`, en un commit de `main`. Cuatro trabajos, cada uno en una máquina nueva:
  las pruebas; el build sin firmar, sin secretos ni scripts de instalación; la firma, en el entorno
  `releases`, sin instalar nada; y la subida, en el entorno `releases-r2` (los dos, de M6), con el
  wrangler del lockfile de `server/`. `nodes/scripts/publish-release.mjs` revisa la release otra
  vez, sube `manifest.json` al final de su versión y lee de vuelta cada objeto. Una versión se
  publica una sola vez, pero "Re-run failed jobs" termina una subida que quedó a medias: con el
  mismo artefacto firmado, que dura 7 días, y con otra aprobación de `releases-r2`. "Re-run all
  jobs" arma otro `manifest.json`: si el anterior ya llegó a R2, la subida lo rechaza y esa versión
  ya no se puede publicar.
  `launcher.mjs` y los instaladores son los de la release más nueva (`latest.json`): una versión
  vieja publicada después no los pisa. Nunca sube `channel.json`.
- [x] **P15.** El trabajo de `nodes/` en CI arma la release sin firmar en cada PR y falla si un
  instalador quedó sin la clave.
- [x] **P16. Versión 0.2.0** en `package.json`, `node/version.ts` y el lockfile. Desde ahora,
  `X.Y.Z` sin sufijos: el build y la compuerta lo exigen.
- [x] **P21. La compuerta de deploy** (`scripts/node-release-gate.mjs`), que `npm run deploy`
  corre antes de `wrangler deploy`:
  - Exige el árbol entero limpio (sin cambios ni archivos nuevos fuera de `.gitignore`) y `HEAD`
    igual a `origin/main`, en cada deploy.
  - Lee de R2 el canal y las releases de su `stable` y su `minimum`, con la firma verificada, y
    compara su código del juego con el de este build: el wasm, el protocolo y los archivos de su
    `inputs.json` (la lista del trabajo de build) fuera del programa del nodo (`nodes/node/` y su
    lockfile). Todo lo demás de `inputs.json` es código del juego: lo que el nodo usa de `src/`
    (`sim/`, `ai/`, `game/Match.ts` y `net/protocol.ts`), `server/src/roomHost.ts`,
    `nodes/shared/**` y la configuración del build (los `tsconfig.json` enteros; de los
    `package.json`, los campos que lee esbuild). Un cambio en `src/ui/` no pide release. Una
    release de un commit que no está en `main` nunca coincide.
  - Si cambió, exige la release de la versión de `nodes/package.json`, publicada desde este mismo
    código del juego, y mueve el canal a `stable` = `minimum` = esa versión **antes** del deploy.
    Sin esa release, frena, y pide subir la versión si no supera la del canal. Un cambio solo en el
    programa del nodo no pide release; si la de la versión nueva ya está publicada, sube solo
    `stable`. Un `minimum` que corre otro código del juego (un canal movido a mano) sube a
    `stable`.
  - `--nodes-off` despliega sin la release solo si ningún extremo del canal puede recibir partidas
    de este build (otro wasm u otro protocolo); nunca si las hostearía con las reglas viejas. Sin
    canal todavía (o sin bucket), la release de este código del juego pasa a ser el primer canal
    (M10); sin ella, cada deploy necesita `--nodes-off`. `--nodes-off` no deja el canal quieto: con
    la release de este código del juego publicada, el deploy la pone en el canal igual (después de
    M9, el próximo deploy es M10). Cualquier otro error al leer R2 frena el deploy, también con
    `--nodes-off`.
  - Guarda el canal anterior en R2 como `channel.prev.json` y lee el nuevo de vuelta:
    `node nodes/scripts/channel.mjs --rollback` lo restaura desde cualquier máquina, y `--show` y
    `--stable` hacen lo demás a mano.
  - Si el deploy falla con el canal ya movido, imprime cómo ver qué build sirve
    (`npx wrangler deployments status`) y cómo volver: `--rollback` (o, si era el primer canal, en
    M10, borrar `channel.json` con
    `npx wrangler r2 object delete turbogol-node-releases/channel.json --remote`, desde `server/`),
    y después drenar o reiniciar el nodo.
  - Nunca crea tags, ni hace commit ni push.

#### [6] servidor: NodeRegistryDO y rutas /nodes (P17-P20): #28

No cambia nada del matchmaking: nada llama todavía a las rutas internas del DO, así que ninguna
partida va a un nodo hasta [7]. Su deploy reinicia las partidas en curso de `MatchDO`, como
cualquier deploy: a una hora tranquila. M7 antes de mergear: con [6] en `main`, cada deploy falla
sin los dos buckets; sin `NODE_CONTROL_PRIVATE_KEY`, todo `/nodes/*` responde 404 salvo `whoami` y
las releases; sin `NODE_TRUSTED_OPERATORS`, nadie crea tokens (403 `not_trusted`).

- [x] **P17. El build del cliente, sin calcular nada en el Worker:** el hash del wasm es una
  constante (`src/sim/wasm/rocketsim.sha256.ts`) que `native/build.ps1` (`npm run build:wasm`)
  reescribe en cada build, y `tests/wasm-hash.test.mjs` falla si no coincide con el archivo. Con
  `PROTOCOL_VERSION` forma `CLIENT_BUILD` (`server/src/nodeApi.ts`), el build contra el que se
  comparan los nodos, igual en un deploy, en `wrangler dev` y en un fork. Más la configuración de
  `server/src/env.ts`: `nodesMode` (lee `nodes_on`, D8; `vm_disabled` gana y un valor mal escrito
  cuenta como apagado; lo usa [7]), los ids del secreto `NODE_TRUSTED_OPERATORS` (D13) y
  `nodesConfigured`; los tipos y los códigos de la API interna están en `server/src/nodeApi.ts`.
- [x] **P18. `server/src/nodeOutcome.ts`:** las llamadas de `MatchDO` para cada resultado. `rated`
  va a `/ranked-result`; el `void` de una ranked, a `/ranked-cancel`, con `playlist` y `region` de
  la asignación; una casual no anota nada; y toda partida termina con un `/release` al matchmaker
  de su región. Un 5xx, un error de red o 10 s sin respuesta se reintentan; cualquier otra
  respuesta que no sea 2xx se descarta con un `ALERT` que lleva el cuerpo, para aplicarlo a mano.
- [x] **P19. `NodeRegistryDO`** (`server/src/NodeRegistryDO.ts`, sus tablas en
  `server/src/nodeStore.ts`):
  - El binding `NODES` (un solo objeto, `nodes-v1`, creado cerca de São Paulo), la migración `v4`
    con `new_sqlite_classes`, los buckets R2 `NODE_REPLAYS` (`turbogol-node-replays`) y
    `NODE_RELEASES` (`turbogol-node-releases`) y las variables `NODE_CONTROL_PUBLIC_KEY` y
    `NODES_PUBLIC_BASE`. `NODE_CONTROL_PRIVATE_KEY` y `NODE_TRUSTED_OPERATORS` son secretos.
  - En SQLite, con las filas de P2: `meta` (la `STATE_VERSION` de las filas), `node_tokens` (solo
    el hash de cada token), `nodes`, `node_matches` y `outbox`, la bandeja de salida. Escribe en
    forma síncrona; un registro va en una transacción, y una partida terminada también, junto con
    sus filas de la bandeja. Con filas de otra `STATE_VERSION` no arranca: deja un `ALERT`,
    responde 503 y no las toca.
  - Sin sockets, el arranque es en frío (un deploy los corta todos): las partidas sin terminar
    tienen la gracia de 90 s de P4. Al despertar de una hibernación adopta cada socket con el
    `{ nodeId }` que guardó al entrar, sin un desafío nuevo, y el nodo puede recibir una partida
    antes de su próximo heartbeat. Un socket que todavía no había entrado se cierra con 4401.
  - Al arrancar comprueba que `NODE_CONTROL_PUBLIC_KEY` sea la mitad pública de
    `NODE_CONTROL_PRIVATE_KEY`. Si no, deja un `ALERT` y no pone partidas: `place` responde
    `{ placement: null, hosts: 0 }`, y el matchmaker deja de preguntar un rato. El registro
    responde 503 `nodes_unavailable`, como cuando el estado no se puede leer, antes de gastar el
    token, que sigue sirviendo; el rejoin, 503 `offline`, que mantiene el lock. Los nodos ya
    registrados siguen reportando. Ninguna respuesta nombra la clave: la causa queda solo en el
    `ALERT`.
  - La alarma, cada 5 s mientras haya un socket, una partida sin terminar, una fila en la bandeja
    o una gracia; si no hay nada, se borra. Corre el barrido (si falla, deja un `ALERT` y sigue),
    se vuelve a programar antes de esperar a nadie, arranca la entrega de la bandeja sin esperarla
    y relee `channel.json` cada minuto: si cambió, los nodos conectados por debajo del `minimum`
    nuevo reciben su `update` en ese momento (un verificador de confianza con partidas de su build
    por verificar espera, como al saludar). Si falta o está roto, el plano de control usa el último
    bueno y avisa.
  - La bandeja se entrega apenas se escribe y después en cada alarma. Cada entrega tiene 10 s de
    tope y un destino que falló no se vuelve a probar en la misma pasada, así que un objeto trabado
    no frena a los demás ni al barrido. Los reintentos se espacian (2, 4, 8… s, hasta 5 minutos), y
    una fila sin entregar después de un día deja un `ALERT`.
  - Los sockets, con la Hibernation API: un frame binario cierra con 1003, y uno de más de 256 KB,
    con 1009. La firma de una subida de replay se comprueba antes de leer el cuerpo, que se lee por
    partes hasta 16 MiB; un cuerpo JSON se lee hasta 4 KB, aunque llegue sin `Content-Length`.
  - Sin `inlineVerify`, sin `/dev/*`, sin TURN y con el ledger solo en memoria: en la etapa 1 solo
    hostean nodos de confianza, que no ganan puntos. Las rutas internas para [7]
    (`/internal/place`, `/internal/rejoin`, `/internal/leave` y `/internal/status`) ya responden.
- [x] **P20. Las rutas `/nodes/*`** (`server/src/nodeRoutes.ts`):
  - `/nodes/*` en `run_worker_first`, atendidas antes de que el Worker mande al sitio.
  - `whoami`; `releases/channel` (también `channel.json`), que devuelve solo `{ stable, minimum }`
    cuando los dos son `X.Y.Z`, sin caché (404 si no existe y 503 si está roto); y
    `releases/<archivo>`, con un patrón de nombres que se comprueba después de decodificar (un
    `X.Y.Z/` opcional y un nombre de hasta 64 caracteres `A-Za-z0-9._-`), sin `..` ni listados:
    todo lo del bucket que encaja en el patrón es público. Los archivos de una versión se cachean
    como inmutables, los de la raíz se revalidan con ETag, y un tipo desconocido (un `.html`, por
    ejemplo) sale como bytes.
  - `register`, `connect` (426 sin `Upgrade`; el 101 pasa tal cual), `replays/<id>` (un id de 64
    hex), `mine` y `status` (pública, 10 s en caché). El Worker solo pasa al DO los encabezados de
    un nodo, y siempre pisa `x-client-ip`, `x-operator-id` y `x-operator-name`.
  - `tokens`, con la sesión de cuenta: 401 sin sesión, 403 `account_required` para un invitado y
    403 `not_trusted` para una cuenta que no está en `NODE_TRUSTED_OPERATORS`; el DO lo vuelve a
    comprobar. La respuesta trae la línea de instalación de Linux.
  - Una cuenta de confianza tiene como mucho 2 nodos (`MAX_TRUSTED_NODES_PER_OPERATOR`,
    `control-plane/registry.ts`): el VPS y uno de reemplazo. El tope va en el registro, así que
    también vale para tokens creados antes; un registro rechazado (403 `too_many_nodes`) deja el
    token sin gastar y un `ALERT`. Un operador que ya tenía más nodos al entrar a la lista los
    conserva.
  - Topes por dirección en el Worker, con una IPv6 contada por su /64: `connect`, 30 por minuto;
    subidas y bajadas de replays, 60 por minuto cada una; `status`, 60; y `mine`, 30 por minuto
    por cuenta. Un `register` o un `tokens` que declara más de 4 KB recibe 413, y una subida de
    más de 16 MiB también, antes de llegar al DO. Los topes de 5 registros por dirección por hora y
    10 tokens por cuenta por día los lleva el DO, en memoria: un deploy los pone en cero. El
    Worker los repite por isolate, para que la basura no llegue al DO.
  - Las rutas de la tienda y de WebRTC, y cualquier otra bajo `/nodes/`, responden 404.

#### [7] servidor: gancho del matchmaker y rejoin/leave (P22-P23): #29

Con el flag `nodes_on` apagado, todo sigue exactamente igual (lo fijan pruebas, y sin nodos
configurados ni siquiera se lee KV).

- [x] **P22. El gancho en `MatchmakerDO.formMatch`:** prueba un nodo primero cuando `nodes_on`
  lo permite para todos los humanos de la partida (`1` para todos, o una lista de cuentas para el
  canary; `vm_disabled` siempre gana). El canary se decide por jugador en `queue()`, `join()` y
  `tryForm()`: quien no está en la lista sigue como hoy, con el 503 de capacidad y `do_disabled`.
  Un error, 8 s sin respuesta o una respuesta que no es una ubicación válida para esos jugadores
  vuelven a `MatchDO`, y frenan los intentos 60 s. Las partidas en nodos no cuentan para
  `MAX_ACTIVE_ROOMS`; una ranked en un nodo toma el lock ranked con el id del nodo; las salas
  privadas nunca van a nodos (D10); el humano solo de una cola p2p puede caer en un nodo (D11).
- [x] **P23. `/api/rejoin` y `/api/leave` para partidas de nodo:** `rejoin` libera el lock si
  la partida no existe, terminó o el jugador no estaba, y lo mantiene si salió (`left`) o el nodo
  no responde; un id de 64 hex que no es nada responde 404 y libera el lock. `leave` le pregunta
  primero al nodo, con 8 s de espera (más que los 5 s del RPC), y mantiene el lock si no
  responde: una salida que el nodo no registró no deja al jugador entrar a otra partida (D12).
- **Regla desde este PR:** nunca volver el Worker a una versión anterior a él. Los jugadores con un
  lock de nodo recibirían 409 hasta que venza, unos 13 minutos. Para apagar los nodos,
  `vm_disabled`.

#### [8] operación: alertas, rutas de mantenedor y chequeo de salud (P24-P26): #30

Antes del deploy: el webhook y su secreto `NODE_ALERT_WEBHOOK` (M13). Sin él, los `ALERT` solo
quedan en el log.

- [x] **P24. Los `ALERT` a Discord:** cada línea `ALERT` del `NodeRegistryDO` (las suyas, las
  del plano de control, del registro y de la bandeja de salida) también va al webhook, como un
  bloque de código sin menciones ni vistas previas, cortado a 1.900 caracteres, la misma alerta
  como mucho una vez cada 10 minutos. Alertas nuevas: un nodo de confianza en servicio fuera de
  línea más de 2 minutos; el tráfico al 80 % del tope; `tickLagP99Ms` arriba de 8 en 3 heartbeats;
  una verificación esperando más de 30 minutos; un nodo por debajo del `minimum` del canal más de
  2 horas. Cada token creado y cada nodo registrado ya dejaban un `ALERT` ([1]).
- [x] **P25. Rutas de mantenedor** `/nodes/admin/*` para una cuenta de confianza: ver los nodos,
  cambiar el estado de uno, drenarlo, avisar un cambio de canal y volver a comprobar su alcance.
  Cada llamada, la lista incluida, deja un `ALERT` con la cuenta que la hizo: una sesión robada se
  ve en el canal. Un drenaje no tiene vuelta atrás: volver pide `systemctl restart turbogol-node`
  en la máquina.
- [x] **P26. Chequeo de salud por cron:** cada 5 minutos, el `/healthz` de los nodos de confianza
  en servicio, con su propio TLS: avisa si no responde, si hay un error de TLS (un certificado
  vencido, aunque los heartbeats se vean bien), si la respuesta no está firmada por el nodo o si
  aparece `draining` sin que nadie lo pidiera. Una llamada al DO por corrida, y ninguna sin nodos
  configurados. `vm_disabled`, `do_disabled` y `matchmaking_off` siguen siendo manuales: ningún
  cron de gasto los prende.

### Acciones del mantenedor

| # | Qué | Cuándo | Destraba |
|---|---|---|---|
| M1 | **Hecho (19/10/2026).** El VPS: sistema revisado (Ubuntu 26.04.1), clave SSH de root, huella de la clave del host | — | Todo lo del VPS |
| M2 | **Hecho.** Aprobar los cambios de sshd y ufw | — | El endurecimiento |
| M3 | **Hecho.** DNS de `sp1.turbo-gol.com`: A y AAAA, solo DNS | — | El certificado y la instalación |
| M16 | Confirmar las propuestas de "Decisiones pendientes del mantenedor" (D1 a D20). El precio real del VPS ya está en `docs/online/DECISIONS.md` ([4]) | Antes del deploy de [6] | [5], [6] |
| M4 | **Hecho (19/10/2026)**: la cuenta del proyecto existe y entra con Discord, así que su seguridad es la de esa cuenta de Discord (verificación en dos pasos). Su id va al secreto `NODE_TRUSTED_OPERATORS` (M7), no al repo. **Falta:** dos cuentas de prueba que nunca registren nodos | Antes del canary | M7, las pruebas de [6], el canary |
| M5 | **Hecho (19/10/2026)**: las claves de control y de releases de producción, generadas fuera de `nodes/.keys/` (que sigue siendo de desarrollo) y respaldadas en el gestor de contraseñas. La pública de releases va a P12 (`nodes/release-key.pub`) y la de control a `NODE_CONTROL_PUBLIC_KEY` (P19); las privadas, a M6 y M7, y después se borran del disco | — | P12, el deploy de [6] |
| M6 | **Hecho (20/10/2026)**: los entornos `releases` (secreto `TGN_RELEASE_PRIVATE_KEY`) y `releases-r2` (secreto `CLOUDFLARE_R2_TOKEN`, un token solo de R2, y la variable `CLOUDFLARE_ACCOUNT_ID`), los dos solo desde tags `node-v*`, sin bypass de administrador y con DonJaimeHash como revisor | — | P14, las releases |
| M7 | **Hecho (20/10/2026)**: los buckets `turbogol-node-replays` (sus objetos vencen a los 30 días) y `turbogol-node-releases`, y los secretos `NODE_CONTROL_PRIVATE_KEY` y `NODE_TRUSTED_OPERATORS`, cargados con `wrangler versions secret put` | — | P19, P20 |
| M8 | **Hecho (20/10/2026)**: el token de `server/.env` tiene R2 de lectura y escritura; [3] a [8] se desplegaron juntos con `npm run deploy -- --nodes-off` (versión `6cde682b`) | — | La instalación |
| M9 | **Hecho (20/10/2026)**: el tag `node-v0.2.0` en `138bca9`, con las dos aprobaciones (firma y subida) | — | M10 | **Hecho (20/10/2026)**: `npm run deploy` escribió el canal en 0.2.0/0.2.0 (versión `588ad3a3`) | — | M11 | **Hecho (20/10/2026)**: el token, desde una sesión de la cuenta del proyecto | — | La instalación |
| M10 | El primer deploy que escribe el canal (P21): `npm run deploy` (`--nodes-off` ya no hace falta, y tampoco lo frena) escribe el canal en 0.2.0/0.2.0 y despliega. Comprobar con los comandos del paso 4 de "Antes de instalar el nodo", en `VPS-SAO-PAULO.md` | Después de M9, a una hora tranquila | M11 |
| M11 | El token de registro, con la línea de consola de "Instalar el nodo" en `VPS-SAO-PAULO.md`, desde una pestaña de turbo-gol.com con la sesión de la cuenta del proyecto: refresca la sesión y hace `POST /nodes/tokens` con `{ "region": "SA", "name": "sao-paulo-1" }` y el Bearer. Pegarlo en la línea de instalación: vale una hora y una sola vez | Justo antes de instalar | La instalación |
| M12 | **Hecho (20/10/2026)**: `node.json` copiado a la carpeta privada de la PC del mantenedor, para pasarlo al gestor de contraseñas. Falta, si se quiere, una instantánea del VPS en el panel de Hostinger | — | — |
| M13 | **Hecho (20/10/2026)**: el canal `#node-alerts` de Discord, solo del equipo (creado desde `private/discord`), y su webhook en el secreto `NODE_ALERT_WEBHOOK` | — | El canary |
| M14 | **Hecho (20/10/2026)**: [7] y [8] desplegados con el flag apagado | — | El canary |
| M15 | **Hecho (21/10/2026)**: canary con la cuenta del proyecto (una casual contra bots) y con dos invitados (una casual contra bots y una 1v1 entre los dos), todas en `node:sao-paulo-1`, sin cortes ni strikes; a las 00:32 UTC, `nodes_on` en `1`. `vm_disabled` queda como interruptor. **Falta** una ranked de verdad en el nodo, con dos cuentas que no sean la del proyecto (ver abajo) | — | La apertura |

### Pruebas antes de abrir la beta

Con las dos cuentas de prueba en el canary, nunca con la del proyecto: si juega el operador, el
scheduler no usa su nodo (`control-plane/scheduler.ts:57`) y la ranked cae en un `MatchDO` sin
aviso.

- [x] **Una casual desde un navegador** (21/10/2026), con la conexión en "Servidor": contra bots
  con la cuenta del proyecto y con un invitado, y una 1v1 entre dos invitados. El panel de red
  dice `host node:sao-paulo-1`. Latencia desde Córdoba: 41 ms, jitter de 0,8 ms, ninguna
  desincronización.
- [ ] **Una ranked desde un navegador,** con dos cuentas que no sean la del proyecto, viendo el
  resultado en la pantalla de fin de partida (la verificación la hace el mismo VPS).
- [ ] Una salida y un forfeit. La salida de una casual ya se probó (21/10/2026): el nodo cierra la
  partida y libera el lock, también si el jugador sale antes de conectarse.
- [ ] Cerrar la pestaña en una ranked: cuenta como abandono, como en `MatchDO` (P7).
- [ ] Un deploy del Worker en medio de una partida: no se anula, y se califica después de la
  gracia.
- [ ] Un reinicio duro del VPS desde el panel de Hostinger en medio de una partida: se anula como
  `node_restarted` o `node_offline`, sin penalizar a los jugadores y sin no-shows. Un `reboot`
  normal no sirve para esta prueba: primero drena las partidas.
- [ ] Una actualización del nodo con partidas en curso: drenan y el nodo vuelve.
- [ ] Un cambio de wasm en el juego: los nodos no reciben partidas hasta la release nueva, y la
  cola de verificación del build viejo se vacía antes de que el verificador se actualice.
- [ ] Cancelar mientras conecta a una ranked: cuenta como dodge, igual que en `MatchDO`
  (`server/src/MatchDO.ts:350-356`).
- [ ] Un corte corto del enlace de control con una partida en curso: la partida sigue si el mismo
  proceso vuelve en 60 s (`NODE_OFFLINE_MS`), y un enlace trabado menos de 30 s se recupera sin
  cerrarse.

### Riesgos principales

- **El orden de escritura.** Guardar antes de cada mensaje (P4), o después de una caída partidas
  honestas fallan como `bad_takeover` o `no_replay`.
- **Un agujero negro silencioso.** Un nodo que deja de ser alcanzable sigue recibiendo partidas
  hasta P6 y P26.
- **Un solo verificador.** Si el VPS se cae, las ranked vuelven a `MatchDO`
  (`control-plane/controlPlane.ts:637`) y las terminadas esperan hasta 6 horas (`:81`).
- **Instaladores sin firma.** El token de R2 puede cambiar los scripts que las instalaciones nuevas
  corren como root: va en su propio entorno (`releases-r2`), con la misma aprobación que la clave
  de firma, y la subida solo acepta los instaladores de `nodes/install/` con la clave del repo.
- **La cuenta del proyecto.** Con su contraseña se crea un nodo de confianza: entra activo
  (`control-plane/registry.ts:371-372`), verifica sus propias ranked
  (`control-plane/scheduler.ts:96`) y sus cancelaciones cuentan como las informa
  (`control-plane/controlPlane.ts:859-861`). Contraseña fuerte y única, un `ALERT` por cada
  token y cada registro (P24) y un tope de 2 nodos para esa cuenta (P20).
- **Un solo DO para todo.** Quien juega en un nodo conoce el id de la partida y el del nodo. Sin
  topes, subidas de replays o conexiones sin autenticar pueden trabar el DO, y con 60 s sin
  heartbeats se anulan partidas en curso (P19, P20).
- **Secretos que despliegan.** `wrangler secret put` reinicia las partidas en curso (M7, M13).

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
- [x] **Una casual no muestreada también tiene que tener su replay subido,** y cuenta para la
  repetición del grupo: así los puntos por muestreo dan en promedio lo mismo que verificar todo.
- [x] **IDs de partida de 64 caracteres:** `randomHexId(32)` en `place()`
  (`control-plane/controlPlane.ts:648`). Las rutas del Worker solo aceptan 64: el resultado ranked
  responde `400 bad_match_id` (`server/src/accountRoutes.ts:411`), `/api/rejoin` también
  (`server/src/index.ts:527`), y `/api/leave` descarta un id de otro largo (`:587`).
- [x] **Las pruebas de `nodes/` en CI.** El trabajo "Community nodes (typecheck, tests)" de
  `.github/workflows/ci.yml` corre en cada PR, así que un cambio en `MatchDO`, el protocolo o el
  wasm que rompa los nodos frena el PR. CONTRIBUTING.md tiene el comando para correrlo local.

### Reglas que siguen

- **`MatchRoom` es un port a mano de `MatchDO`.** Cada arreglo en `MatchDO` hay que llevarlo
  también a `node/matchRoom.ts`.
- **Cada deploy del juego que cambie el wasm, el protocolo o el JavaScript del juego que va en el
  nodo (también `nodes/shared/`) necesita una release del nodo.** Sin ella, ningún nodo recibe
  partidas, o un nodo sigue con las reglas viejas. La compuerta de P21 lo exige en cada deploy.

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
- [ ] **Respetar `connected: false` en `/api/leave`** (el cliente lo manda desde P30) solo cuando
  el nodo confirma que ese jugador nunca se conectó. Hoy `ControlPlane.leave` le cree al cliente
  (`control-plane/controlPlane.ts:748`), y en un nodo comunitario eso decide si cancelar es un
  dodge (`:878`).
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

- [x] **Guardar el ledger, los canjes y los inventarios antes de dar puntos.** El ledger en el
  SQLite del `NodeRegistryDO` (`server/src/nodeStore.ts`: asientos, totales y notas, leídos al
  arrancar); los créditos, canjes, congelamientos e inventarios en `AccountsDO`
  (`server/src/accountStore.ts`), que recibe los puntos por la bandeja (`/host-credit`). Nada de
  eso se poda.
- [x] **Decidir dónde viven los inventarios.** En `AccountsDO` (la opción A del plan de autos): la
  cuenta del operador ya es la del jugador, un canje es una transacción en un solo objeto y los
  forks sin nodos tienen inventario igual.
- [x] **Rutas de mantenedor para la tienda:** `POST /nodes/admin/unfreeze { account }`, y
  `grant` / `revoke { account, item }` para dar o sacar un ítem (un `ALERT` cada una). La
  suspensión del nodo se levanta con `/nodes/admin/status`; el catálogo es código. Desde esta
  etapa, una verificación fallida suspende la PC de un amigo y congela sus canjes.
- [ ] **La insignia de Anfitrión.** Está disponible en el catálogo (`RECOMPENSAS.md`), así que los
  amigos la van a canjear en esta etapa. El juego tiene que mostrarla en el perfil, y el nombre del
  anfitrión en la pantalla de carga, con `GET /api/me/items`. Si no, dejarla como "próximamente".
- [ ] **Recalibrar con datos reales.** Entre pocos amigos que juegan siempre juntos, el factor de
  repetición, el peso de las cuentas nuevas y "los minutos del propio operador no cuentan" van a
  dar mucho menos que los 90 puntos por noche de `RECOMPENSAS.md`.

### Decisiones de producto

- [ ] **El casual por defecto es P2P** (las preferencias por defecto en `src/ui/Menu.ts`, y "P2P
  (recomendada)" en `src/locales/es.ts`). Las salas P2P nunca pasan por `formMatch`, así que nunca
  llegan a un nodo; solo un jugador que espera solo en la cola P2P termina en el servidor contra
  bots (`server/src/MatchmakerDO.ts:1028-1041`). Las PCs en prueba solo hostean casuales y
  necesitan 20 verificadas para el ranked: sin casuales por servidor, tardarían mucho. Hay que
  decidir si los nodos comunitarios toman casuales, por ejemplo con una opción "servidores de la
  comunidad".
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
- [x] **El inventario:** `GET /api/me/items`, con las tablas de `AccountsDO`.
- [x] **El protocolo:** no hace falta subir `PROTOCOL_VERSION` ni `P2P_PROTOCOL_VERSION`. El auto
  viaja con el asiento, como el nombre (`src/net/cosmetics.ts`, fuera del bundle de los nodos): en
  el roster del Welcome de `MatchDO`, en los slots de las salas P2P y, para un nodo, en `cars` del
  resultado de la cola y del rejoin. La asignación que recibe el nodo no cambia ni un byte.
- [x] **El servidor valida que la cuenta tenga el ítem:** `AccountsDO` firma en la sesión solo un
  auto que la cuenta todavía tiene, y el matchmaker toma el auto de la sesión, nunca del cuerpo.
- [x] **El garaje en el juego** (`src/ui/screens/garage.ts`, Inicio > GARAJE): los autos sobre la
  cámara de exhibición, equipar (`POST /api/me/car`), canjear con confirmación
  (`POST /api/me/shop/claim`), el saldo y, sin puntos o como invitado, cómo se ganan. Cada auto
  de la partida se dibuja con el auto de su asiento (`src/net/cosmetics.ts` `seatCars`).

### Operación

- [ ] **Página pública de estado, tableros de salud** y un procedimiento para reportes de
  ataques a IPs hogareñas.
- [ ] **Una herramienta para revisar nodos suspendidos.**
- [ ] **Soporte de instaladores:** SmartScreen y antivirus con la línea de PowerShell, instalación
  de Node con winget, avisos del firewall y una guía de problemas comunes.

### Automatización de GitHub

- [ ] **Instalar las plantillas** de `github/` en `.github/`: `CODEOWNERS` y los workflows del bot,
  con las versiones de las acciones de `.github/workflows/ci.yml`. `node-release.yml` ya corre
  desde `.github/workflows/` (P14).
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
   forzar la caída de la conexión del anfitrión para anular una ranked perdida.
2. **Jugadores con relay por defecto al abrir al público,** con una opción "conexión directa,
   menos ping" que avise que el anfitrión verá su IP. Con el tope de 900 GB, alcanza para unas 900
   horas de 2v2 por mes en PCs.
3. **Medir antes de decidir:** una partida de prueba por modo, con identificadores propios en las
   credenciales para ver los bytes en las analíticas de TURN de Cloudflare.

**Lo que hay que cambiar en el código.** En el nodo, para la etapa 2:
- [ ] `answerOffer` con un parámetro `relayOnly`. Hoy no lo tiene: en `node/rtcTransport.ts`
  solo la función interna `peer()` lo acepta, y solo el autotest lo usa, en un lado.
- [ ] `werift` solo se limita al relay si tiene un TURN con usuario y clave: sin TURN juntaría
  de todos modos candidatos directos. Hay que rechazar la oferta en ese caso.
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

### Propuestas de la etapa 1

Cada propuesta lleva el número D con que la citan los PR de arriba. El trabajo avanza con ellas,
pero ninguna está confirmada: esperan el visto bueno del mantenedor (M16). Los números que faltan
(D2, D3, D5 y los demás) son valores por defecto que ya quedaron escritos en las piezas de los PR,
como la gracia de 90 s de P4 o los 12 intentos de P8, y se revisan con cada PR.

- **D1. Intervalo de heartbeat.** **Propuesta:** 5 s, con 15 s de tope
  (`shared/controlProtocol.ts:38-40`) y la alarma cada 5 s. Así el DO nunca hiberna: un DO solo
  hiberna tras 10 s sin eventos. Son unos 324.000 GB-s por mes (0,125 GB durante todo el mes), el
  81 % de los 400.000 incluidos en Workers Paid, compartidos con las partidas en `MatchDO`; aun
  si todo fuera excedente, US$ 4,05 por mes (US$ 12,50 por millón de GB-s). Las solicitudes (la
  alarma suma unas 518.000 por mes) cuestan menos de US$ 0,10 por mes pasado el millón incluido
  (developers.cloudflare.com/durable-objects, páginas de precios y ciclo de vida, 2026). Es un
  costo fijo que no crece con los nodos. Pasar a 30 s pide una release del nodo (`HEARTBEAT_MS`
  se usa en el nodo, `node/agent.ts:131`) y una alarma de 30 s, y detectar un nodo caído pasaría
  de 15-20 s a unos 90 s.
- **D4. El nombre del VPS de São Paulo: con o sin el proxy de Cloudflare.** **Propuesta:** solo
  DNS durante la beta. Pasarlo por el proxy más adelante solo si el chequeo del Worker y los
  WebSocket funcionan por ahí y la latencia extra desde Argentina queda por debajo de unos 10 ms;
  entonces, con SSL "Full (strict)" y un certificado de origen. Para la beta se aparta de la
  decisión 3 de `docs/online/DECISIONS.md`: sin proxy, la IP del VPS que verifica todo queda a la
  vista.
- **D6. Cerrar la pestaña en una ranked de nodo: cómo se sanciona.** **Propuesta:** en los nodos
  de confianza, la regla de `MatchDO`: quien no tiene conexión al pitazo cuenta como abandono, con
  el dato del nodo (`connectedAtEnd`, P7). Sin una salida al cerrar la pestaña (`pagehide`):
  convertiría cada recarga en un abandono, y hoy recargar y volver a entrar funciona. Tampoco
  `VerifyVerdict.goneTicks`: cuenta el último tramo de controles en cero
  (`shared/verify.ts:153-163`), así que un jugador conectado que no toca nada al final saldría
  como abandono.
- **D8. Cómo se prenden los nodos.** **Propuesta:** una clave nueva de KV, `nodes_on`. Sin ella,
  apagados; con `1`, para todos; con una lista de ids de cuenta separados por coma, para un
  canary. `vm_disabled` queda como interruptor de emergencia. Ningún jugador nota un cambio
  hasta que se prende.
- **D13. Dónde vive `NODE_TRUSTED_OPERATORS`.** **Propuesta:** un secreto del Worker, no una
  variable en el repo. Sobrevive a los deploys, el id de la cuenta no queda público y un fork sin
  el secreto no confía en nadie.
- **D15. La clave de releases.** **Propuesta:** en el entorno `releases` de GitHub, con un
  revisor obligatorio, solo desde tags y sin bypass de administrador, más una copia sin conexión
  en el gestor de contraseñas. La firma corre en un trabajo propio que no instala nada y solo usa
  `node:crypto` (P13), y el token de R2 va en otro entorno, `releases-r2` (M6). Nunca la clave de
  desarrollo que firmó la 0.1.0.
- **D19. El tope de tráfico del VPS.** **Propuesta:** `--egress-cap-gb 3800`. El contador del
  nodo solo cuenta lo que mandan las partidas que terminan (`node/runtime.ts:514-519`), por mes
  calendario UTC (`:617-620`); con 3800, dos meses UTC parciales siguen entrando en los 8 TB del
  plan. Subirlo cuando el panel de Hostinger confirme qué día se reinicia la transferencia.
- **D20. La capacidad declarada del VPS.** **Propuesta:** `floor(cpu × 0,6 / 2)`, con el `cpu`
  más conservador del benchmark: hoy, 15 partidas. Ese `cpu` ya cuenta con el 60 % de un núcleo
  (600 ms de CPU por segundo de reloj, `node/bench.ts:77`), para dejar margen. El 0,6 extra es
  por los créditos de CPU: si se acaban, Hostinger deja cada vCPU en su base del 60 %, y con el
  0,6 las partidas siguen usando el 60 % de lo que queda (un 36 % del núcleo). El 2, porque la
  verificación corre en el mismo hilo que las partidas (`node/runtime.ts:540-567`) y cuesta otra
  simulación por ranked. Si la prueba de CPU bajo carga no muestra freno, el 0,6 sobra:
  `floor(cpu / 2)`, 26 con las mediciones de hoy. Se revisa cuando una semana de heartbeats
  muestre margen.

### Para las etapas siguientes

Sin número D: no frenan la etapa 1.

- **Modo de relay:** la recomendación es ocultar al anfitrión desde la etapa 2 y a los jugadores
  por defecto al abrir. Pasar de unas 900 horas de 2v2 por mes con relay pide subir el
  presupuesto.
- **Casuales en nodos comunitarios:** sí o no, y cómo se elige.
- **Segundo verificador:** cuándo se levanta el de Hetzner.
- **El primer auto:** cuál es. El precio ya está decidido en 1.500 puntos.

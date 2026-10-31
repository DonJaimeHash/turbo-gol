# Turbogol · nodos comunitarios

Servidores de partida que pone la comunidad, sea un VPS alquilado o una PC hogareña, con un plano
de control propio que los registra, les asigna partidas, **verifica los resultados
re-simulándolos** (todas las ranked, las casuales por muestreo) y recompensa a quien los pone con
puntos para canjear cosas nuevas del juego.
Hoy es un prototipo en `nodes/`: el plano de control ya está en el Worker (`server/`), pero el
matchmaker todavía no le manda partidas. Qué falta para usarlo con jugadores reales está en
[docs/PRODUCCION.md](docs/PRODUCCION.md).

**Qué se verifica:** todas las partidas ranked, porque proteger el ranking es el objetivo. Las
casuales, por muestreo: todas mientras un servidor está a prueba, una parte cuando ya es activo, y
ninguna en los servidores del proyecto.

| Documento | Para qué |
|---|---|
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Las piezas, los flujos, el modelo de confianza y los costos medidos |
| [docs/DECISIONES.md](docs/DECISIONES.md) | Lo que decidió el mantenedor, lo decidido por defecto y lo que queda abierto |
| [docs/RECOMPENSAS.md](docs/RECOMPENSAS.md) | Puntos, tienda de anfitriones y defensas contra el farmeo |
| [docs/VPS-SAO-PAULO.md](docs/VPS-SAO-PAULO.md) | Cómo levantar el verificador de confianza, que también es el primer servidor ranked |
| [docs/INTEGRACION.md](docs/INTEGRACION.md) | Los cambios exactos en el Worker y en el cliente para activarlo, aplicados en parte: el plano de control ([6], #28); falta el gancho del matchmaker ([7]) |
| [docs/PRODUCCION.md](docs/PRODUCCION.md) | Todo lo que falta para usarlo con jugadores reales, por etapas, y el costo de forzar TURN |
| [docs/BOT.md](docs/BOT.md) | Propuestas, votos y el bot que las implementa |
| [docs/paper/](docs/paper/README.md) | El paper para la comunidad (borrador): modelo matemático, arquitectura y hoja de ruta; la versión en inglés es la canónica y la española, su traducción |

## Correrlo

Desde `nodes/`, con Node 24. Primero `npm install` en la raíz del repo y en `server/`: el nodo usa
el wasm y el código del juego, el chequeo de tipos usa el TypeScript de la raíz y el build de
releases usa el esbuild de `server/`. La única dependencia propia es `werift`, el WebRTC del nodo:

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run demo
```

La demo levanta el plano de control en el puerto 8790, el verificador del proyecto, una PC
hogareña por WebRTC y un servidor por WebSocket en el 7350. Juega una casual con el `NetClient`
real por WebRTC y una ranked, las verifica en el verificador, y canjea la insignia gratis. Después
queda abierta `http://127.0.0.1:8790/host`: entra como `Demo` o como `Proyecto`.

Otros comandos:

| Comando | Qué hace |
|---|---|
| `npm run control` | Solo el plano de control de referencia |
| `npm run node -- rtc-test --stun stun:stun.cloudflare.com:3478` | Prueba que WebRTC funciona en esta máquina. Solo con un servidor TURN (`--turn`) prueba que los jugadores pueden llegar: sin TURN pasa en cualquier máquina |
| `npm run bench` | Mide cuántas partidas aguanta esta máquina |
| `npm run keys` | Genera las claves de control y de releases en `.keys/`. Si ya existen, las deja y avisa que no son nuevas |
| `npm run build` | Arma una release de desarrollo en `dist/releases/` con los tres instaladores, firmada con `.keys/release.json`. Nunca se sube |
| `node scripts/build-node.mjs` | La release de producción: sin firmar, desde un commit, con los instaladores armados con `release-key.pub`. La arma el workflow de releases |
| `npm run sign` | Revisa esa release (cada archivo contra su manifiesto; el wasm y los instaladores byte a byte, y el protocolo, contra el checkout; `node.mjs` no se vuelve a armar) y la firma con la clave de releases del proyecto. Solo lo corre el workflow de releases (`.github/workflows/node-release.yml`), en un job que no instala nada |
| `node scripts/publish-release.mjs` | Revisa otra vez la release firmada y la sube a R2. Una versión se publica una sola vez, pero retoma una subida que quedó a medias; `launcher.mjs` y los instaladores son siempre los de la release más nueva. Solo lo corre el workflow de releases |
| `node scripts/channel.mjs --show` | Muestra el canal de releases publicado. `--stable` lo mueve (con el mínimo en esa misma versión, salvo que pases `--minimum`) y `--rollback` lo devuelve a `channel.prev.json` (normalmente lo mueve `npm run deploy` en la raíz) |
| `npm run build:web` | Arma el arnés de prueba del navegador, servido en `/web/rtc-harness.html` |
| `npm run xmachine -- record <carpeta>` y `verify <carpeta>` | Graba 12 partidas completas y verifica las que grabó otra máquina: comprueba que dos máquinas simulan igual. `record` también compara con una referencia grabada en la PC del proyecto |

`.keys/`, `dist/`, `data/` y `node_modules/` están en `nodes/.gitignore`. **Nunca subas `.keys/` a
ningún lado**: guarda una copia en un gestor de contraseñas.

## Qué hay

```
shared/         lo que comparten nodo, plano de control y cliente
  replay.ts       formato y grabador del replay
  verify.ts       re-simulación y comprobaciones del final
  nodeTickets.ts  tickets Ed25519 atados a un nodo
  controlProtocol.ts  mensajes, transportes, señalización WebRTC
node/           el programa del nodo
  main.ts         CLI: register, run, bench, verify, status, rtc-test
  runtime.ts      salas, transportes, agente, verificador
  matchRoom.ts    una partida, port fiel de MatchDO
  wsServer.ts     WebSocket sin dependencias (nodos con IP pública)
  rtcTransport.ts WebRTC para PCs detrás de NAT, sin abrir puertos
  launcher.ts     versiones firmadas, autoactualización, rollback
client/         lo que va al juego
  rtcSocket.ts    el adaptador WebRTC con interfaz de WebSocket para NetClient
control-plane/  el plano de control
  controlPlane.ts sesiones, ubicación, señalización, cola de verificación, resultados
  registry.ts     tokens, nodos, estados, strikes
  scheduler.ts    a qué nodo va cada partida y quién la verifica
  ledger.ts       puntos de anfitrión
  shop.ts         saldo, catálogo, canjes, inventario
  devServer.ts    servidor de referencia y de desarrollo
install/        VPS (install.sh), Windows, macOS y Linux de escritorio, cloud-init
web/            la página "Pon un servidor" y el arnés WebRTC del navegador
github/         plantillas: bot, ranking de propuestas, formulario (el de releases ya corre en .github/)
scripts/        demo, build, firma y canal de releases, arnés, claves, determinismo entre máquinas
release-key.pub la clave pública de releases del proyecto
test/           pruebas automáticas con el wasm real
```

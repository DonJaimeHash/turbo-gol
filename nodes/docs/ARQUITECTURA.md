# Nodos comunitarios: arquitectura (v0.2)

> Estado al 19/10/2026: prototipo funcional en `nodes/` del repo, con las decisiones del
> mantenedor aplicadas (`DECISIONES.md`) y dos rondas de revisión adversarial corregidas: 39
> hallazgos en la primera y 31 en la revisión de esos arreglos (14 del plano de control, 17 del
> nodo), cada uno con su prueba. Las pruebas automáticas
> pasan, incluidas partidas de punta a punta por WebSocket y por WebRTC con el `NetClient` real del
> juego. Todavía no está conectado al juego: la integración con el Worker está en
> `INTEGRACION.md` y no se aplicó.

## La idea en una frase

La comunidad pone máquinas, sean servidores alquilados o PCs hogareñas; el proyecto pone el
dominio, las cuentas, el ranking y la verificación. **Un nodo nunca escribe un resultado: lo
propone, y un verificador de confianza re-simula la partida antes de aceptarlo.** Eso permite
aceptar máquinas de cualquiera sin confiar en nadie.

## Qué tomamos de cada referente

| Referente | Qué tomamos | Qué dejamos afuera |
|---|---|---|
| **DDNet** | Ranking único y global con servidores de la comunidad en muchos países. Lista pública de servidores y de quién los aporta. | Que los servidores escriban directo en la base de rankings. |
| **Beyond All Reason** | Proyecto abierto que crece con la comunidad y conserva marca, dominio y servidor central. | — |
| **Lichess fishnet** | Cliente chico y abierto que solo hace conexiones salientes y pide trabajo. La verificación también es trabajo. | Confiar en resultados sin verificarlos. |
| **GitHub self-hosted runners** | Token de registro de un solo uso que vence en una hora. La máquina genera su propia credencial. Se actualiza sola. | Ejecutar código arbitrario en la máquina. |
| **GameLift Anywhere** | Orquestador central separado del cómputo, que puede ser de cualquiera. Cada nodo informa capacidad y ubicación. | Atarse a un proveedor y a su SDK. |
| **Railway y los referidos** | El botón. El operador le paga directo al proveedor. | Que el proyecto revenda hosting. |
| **claude-code-action** | Un bot implementa propuestas aprobadas y abre un PR. Una persona revisa y mergea. | El merge automático. |
| **Cierres de Hathora y Unity Multiplay (2026)** | Todo corre en una máquina común con Node. Ningún orquestador externo es imprescindible. | — |
| **El P2P de Turbogol** | WebRTC con STUN y TURN, que ya funciona entre navegadores, ahora también entre navegador y una PC anfitriona. | La malla: acá la autoridad es el nodo. |

## Las piezas

```
  Jugadores (cliente web; para PCs hogareñas, con el adaptador WebRTC de una línea)
     |  1. POST /api/queue (declara transportes)          ^  6. rating y puntos
     v                                                     |
  +------------------ Plano de control (Cloudflare) ------------------------+
  |  MatchmakerDO --> NodeRegistry: registro, scheduler, tickets Ed25519,    |
  |                   señalización WebRTC, cola de verificación, tienda      |
  +---^------------------------^---------------------------+---------------+
      | WS saliente             | WS saliente               | 2. assign
  +---+--------------+   +------+----------------+   +-----v-----------------+
  | Verificador de   |   | Nodo VPS (wss)        |   | Nodo PC hogareña (rtc) |
  | confianza        |   | Caddy + certificado   |   | sin puertos abiertos   |
  | (VPS São Paulo)  |   | de IP, :443           |   | ICE: STUN / TURN       |
  +------------------+   +------^----------------+   +-----^-----------------+
   5. re-simula               3. wss://<IP>/m/<id>        3. DataChannel 'tg'
                             Jugadores                  Jugadores
                     4. el nodo sube el replay firmado y reporta el resultado
```

| Pieza | Qué hace | Archivos |
|---|---|---|
| Replay | Graba la configuración y los controles aplicados a cada humano cuando cambian, más un hash del estado por segundo. Una partida de 34 s ocupa 6,5 KB. | `shared/replay.ts` |
| Verificador | Re-simula con el mismo wasm y el mismo `RoomHost`. Compara cada hash, el marcador y el final. Los bots se recalculan, nunca se leen del replay. | `shared/verify.ts` |
| Tickets de nodo | Los mismos campos que los tickets actuales más `aud = node:<id>`, firmados con Ed25519. El nodo los verifica con la clave **pública**. | `shared/nodeTickets.ts`, `shared/edcrypto.ts` |
| MatchRoom | Port fiel de `MatchDO` a Node: mismo protocolo, límites, reglas de ranked y códigos de cierre. | `node/matchRoom.ts` |
| Transporte WebSocket | Servidor RFC 6455 propio, sin dependencias, para nodos con IP pública. | `node/wsServer.ts`, `node/http.ts` |
| Transporte WebRTC | Un DataChannel confiable y ordenado, que presenta la misma interfaz que el WebSocket. Autotest de alcance a través de TURN. | `node/rtcTransport.ts` |
| Adaptador del jugador | Un objeto con interfaz de WebSocket que viaja por WebRTC. `NetClient` lo recibe con una fábrica y no nota la diferencia. | `client/rtcSocket.ts` |
| Runtime y agente | Salas, temporizador único, medición de lag y tráfico, conexión saliente al plano de control. | `node/runtime.ts`, `node/agent.ts`, `node/ticker.ts` |
| Lanzador | Baja versiones firmadas, las verifica, drena antes de actualizar y vuelve atrás si una versión se cae tres veces. | `node/launcher.ts`, `node/launcherMain.ts` |
| Plano de control | Registro, scheduler, señalización, cola de verificación, recompensas, tienda. Lógica independiente del transporte. | `control-plane/*.ts` |
| Instaladores | VPS con root, Windows sin admin, macOS y Linux de escritorio sin root. | `install/` |
| Página del operador | El botón "Poner un servidor", "Mis servidores" y la tienda. | `web/host.html` |

## Flujos

### Alta de un servidor (el botón)

1. El operador entra con su cuenta, elige región y nombre, y recibe un token de un solo uso que
   vence en una hora.
2. Elige dónde corre:
   - **Mi PC**, en Windows, macOS o Linux: una línea en PowerShell o en la terminal, sin
     permisos de administrador. En Windows instala Node con winget si falta; en macOS y Linux
     tiene que estar Node 24 y, si no está, el instalador explica cómo ponerlo. Verifica la firma,
     registra y deja el nodo arrancando solo al iniciar sesión.
   - **VPS alquilado**: pega el cloud-init al crearlo.
   - **Servidor Linux propio**: una línea como root.
3. La máquina genera su clave Ed25519 ahí mismo y se registra.
4. El nodo se conecta al plano de control y firma un desafío. Queda **pendiente**.
5. Se prueba que los jugadores lo alcanzan:
   - Un VPS: el plano de control pide `https://<nombre>/healthz?nonce=…` y el nodo firma el
     nonce. Tiene que ser un nombre DNS: un Worker de Cloudflare no puede pedir una IP pura.
   - Una PC hogareña: corre un autotest WebRTC que tiene que pasar por el relay TURN. Si pasa,
     cualquier jugador puede llegar, en el peor caso a través del relay. Sin TURN no se habilita
     (salvo en desarrollo local). Si falla, el nodo lo reintenta solo: a los 30 s, 1 min, 2 min,
     hasta cada 10 min; y lo repite cada media hora aunque pase, porque las credenciales de TURN
     vencen.
6. Pasa a **a prueba**: solo casuales. Con 20 partidas verificadas sin fallas pasa a **activo** y
   entra al ranked. Un nodo del proyecto pasa a activo de inmediato.

### Una partida

1. El matchmaker arma la partida como hoy. El cliente declara si tiene el adaptador WebRTC.
2. El scheduler elige un nodo elegible: región, mismo build, lugar libre, sin drenar, bajo su tope
   de tráfico, activo si es ranked, cuyo operador no juegue esa ranked, y alcanzable por un
   transporte que el cliente soporte. Entre los menos cargados elige al azar.
3. El nodo recibe `assign` y precalienta la arena. El matchmaker devuelve la URL y un ticket
   Ed25519 por jugador.
   - **VPS:** la URL es `wss://<IP>/m/<id>`. El cliente actual se conecta sin cambios.
   - **PC hogareña:** la URL es `wss://turbo-gol.com/nodes/rtc/<nodo>/<id>`. El adaptador la
     reconoce, pide los servidores ICE, manda su oferta WebRTC, el plano de control la reenvía al
     nodo por su conexión saliente, y el nodo responde. El canal se abre por la mejor ruta que
     encuentre ICE.
4. El nodo juega la partida igual que `MatchDO` y graba el replay.
5. Al terminar sube el replay firmado y reporta. El resultado entra a la **cola de
   verificación**. Un verificador con el mismo build con el que se jugó la partida, al principio
   el VPS de São Paulo, la re-simula. Cada final necesita su prueba en el replay, y el reporte
   tiene que coincidir con lo que el replay prueba: motivo del final, marcador, ganador y tick.
   - Si coincide: rating a `AccountsDO`, puntos al anfitrión. El rating, los abandonos y los
     minutos que dan puntos salen del replay verificado, nunca del reporte del nodo.
   - **Qué se verifica:** todas las ranked, porque proteger el ranking es el objetivo. Las
     casuales, por muestreo: todas las de un nodo a prueba (son su camino al ranked), el 20 % de
     las de un nodo activo y ninguna en los nodos del proyecto. Una casual sin verificar se cierra
     con el marcador que informa el nodo y no da puntos: no tiene rating, así que no decide nada.
     Una casual verificada por muestreo da sus puntos multiplicados por 1 / 0,2, así que el
     operador gana lo mismo en promedio.
   - Si no coincide: partida anulada sin penalizar a nadie, nodo suspendido hasta que un
     mantenedor revise, canjes congelados, alerta.
   - Si el problema es del verificador (otro build, un error suyo): se reintenta, sin culpar al
     nodo.
   - Si el verificador está caído: la partida espera hasta 6 horas y después se anula sin
     penalizar a nadie.
6. Si ningún nodo es elegible, la partida va a un `MatchDO` como hoy.

### Actualizaciones

- Cada release es un manifiesto firmado con el hash y el tamaño de cada archivo: `node.mjs`, de
  1,99 MB con `werift` adentro, y `rocketsim.wasm`, de 578 KB.
- Un nodo más viejo que el mínimo del canal recibe `update`, deja de tomar partidas, termina las
  que tiene y sale con código 75. El lanzador baja la nueva versión, la verifica y la arranca.
  Subir solo `stable` llega a cada nodo cuando reinicia. No hay canal canary todavía.
- Un pedido de apagado siempre gana sobre una actualización pendiente: el nodo drena y sale con
  0, y el lanzador no arranca otra versión.
- **Apagar sin cortar partidas** funciona igual en los tres sistemas: el lanzador recibe el pedido
  (SIGTERM en Linux y macOS; en Windows, que no tiene señales, el archivo `stop.request` en la
  carpeta de datos, que escribe `install-windows.ps1 -Stop`) y se lo pasa al nodo por el canal IPC.
  El nodo deja de tomar partidas, termina las que tiene, reporta y sale. Un segundo pedido corta ya.
- Si una versión anterior a la mínima es lo único que queda, el lanzador no la usa: reintenta la
  estable con esperas de 5 s a 5 min. Las marcas de versión mala vencen a las 24 horas.
- Si una versión se cae tres veces en diez minutos, el lanzador vuelve a la última buena.
- **Compatibilidad:** una partida solo va a un nodo con el mismo hash de wasm y la misma versión
  de protocolo que el cliente.

### Caídas y PCs que se apagan

Un nodo sin heartbeat por 15 s, o cuya conexión se cortó hace más de 15 s, queda fuera de línea.
Sus partidas se anulan sin penalizar a los jugadores y el nodo suma **un** strike por corte,
aunque tuviera varias partidas: los strikes a menos de un minuto del anterior cuentan como uno.
Si vuelve con un proceso nuevo, sus partidas viejas se anulan igual, porque se perdieron con el
proceso. Los strikes vencen a los 7 días. Tres en una semana pausan el nodo 24 horas; después
vuelve solo a su estado anterior, pero los strikes siguen contando hasta que venzan. Una segunda
pausa en 30 días lo devuelve a prueba. Los nodos del proyecto no se pausan.

## Modelo de confianza

| Lo que podría intentar un operador | Qué pasa | ¿Probado? |
|---|---|---|
| Inventar goles, mover la pelota o cambiar el marcador | La re-simulación diverge en el siguiente checkpoint, cada segundo. | Sí |
| Reportar un resultado distinto del replay | Reporte contra verificación, incluido el motivo del final: nodo suspendido, canjes congelados. El resultado se toma del replay, nunca del reporte. | Sí |
| Cortar una partida cuando le conviene | Cada final necesita su prueba: `left`, que salieron todos; `empty`, que no quedaba nadie jugando; `ttl`, que era tiempo extra y el reloj del plano de control dice que venció el plazo. Un `empty` en ranked suma strike. | Sí |
| Cancelar una ranked que va perdiendo | Un nodo comunitario solo puede cancelar antes del inicio y por un motivo que el plano de control comprueba: un dodge que el jugador pidió acá, o un no-show cuando cierra la ventana de ingreso. Cualquier otra cancelación es una partida perdida, con strike. | Sí |
| Inflar los minutos para ganar puntos | Los minutos salen del replay verificado. El lag que mide el nodo solo puede restar. | Sí |
| Hacer que un bot juegue a favor de un equipo | Los bots no se graban: el verificador los recalcula. | Sí |
| Inventar un abandono para perjudicar a alguien | Solo cuentan los abandonos explícitos, que pasan por el plano de control: el verificador rechaza que un bot tome el lugar de un jugador que no pidió salir, y el tick de esa salida tiene que coincidir con cuándo la pidió. Así, un nodo que retiene su reporte no convierte en abandono una salida automática posterior. Un no-show de una PC hogareña solo cuenta para quien ni siquiera mandó su oferta WebRTC, y nunca antes de que cierre la ventana de ingreso; en un VPS comunitario no cuenta. | Sí |
| Inventar un forfeit por desconexión | Exige 60 s de controles nulos en el replay, medidos en ticks. Un nodo que ignore los inputs de un jugador podría fabricarlos: los jugadores lo ven, y es la misma limitación que la fila siguiente. | Parcial |
| Meter lag o ignorar inputs de un equipo | La re-simulación no lo ve. En v1 se mitiga: el operador nunca hostea ranked donde juega, asignación al azar, período de prueba. En v2 el cliente compara el eco de sus inputs y reporta. | Parcial |
| Reusar o robar tickets | Ed25519, 90 s, un solo uso, atados a un nodo, una partida y un slot. También por WebRTC: el ticket se reserva en la oferta. | Sí |
| Correr código modificado | El nodo no tiene secretos del proyecto; cualquier efecto sobre la física lo detecta la verificación. | Sí |
| Mandar basura por la señalización | El plano de control verifica el ticket antes de reenviar la oferta; el nodo lo verifica otra vez. | Sí |
| Mandar mensajes rotos al plano de control | Se valida cada mensaje antes de usarlo. Un sobre, un hello o un heartbeat rotos cierran la conexión del nodo; un reporte roto de una de sus partidas la da por perdida, con strike; lo demás se ignora. | Sí |
| Anular partidas a voluntad con cortes | Cada corte cuesta un strike. Una segunda pausa por strikes en 30 días devuelve el nodo a prueba: pierde el ranked hasta sumar otras 20 partidas verificadas. | Sí |
| Ver las IP de los jugadores | Pasa, como en el P2P actual y en cualquier servidor comunitario. Se puede forzar TURN para ocultarlas. | — |
| Robar la clave de releases | No está en ningún servidor: vive en CI con aprobación manual. | — |

| Clave | Firma | Dónde vive |
|---|---|---|
| De control | Tickets de partida | Secreto del Worker |
| De releases | Versiones del nodo e instaladores | CI con aprobación manual, o una máquina sin conexión |
| De cada nodo | Su login y sus subidas | En la máquina del operador |

## Capacidad y costos (medidos)

| Modo | Ancho de banda | Tráfico por hora |
|---|---|---|
| 1v1 | 0,70 Mbit/s | 0,32 GB |
| 2v2 | 2,15 Mbit/s | 0,97 GB |
| 3v3 | 4,33 Mbit/s | 1,95 GB |

| Medición | Valor |
|---|---|
| CPU de simulación, 3v3 con seis bots | 41,7 ms por segundo de partida en un Ryzen 7 2700 |
| CPU de WebRTC, 3v3 | cerca del 12 % de un núcleo contando ambos extremos |
| Latencia WebRTC local | 2,9 ms p50, 6,1 ms p99 |
| Memoria por partida | unos 8 MB |
| CPU de verificación | Unos 10 ms por segundo de partida en un 3v3 con bots (medido el 19/10/2026): unos 2 s para una partida de 3 minutos. Un 1v1 de 3 minutos, menos de medio segundo |
| Abrir el canal WebRTC | unos 360 ms en la misma máquina |

En una PC hogareña el límite suele ser la subida: con 10 Mbit/s entra un 3v3 o varios 1v1. El
instalador pregunta la subida y el benchmark la tiene en cuenta.

## Qué está hecho y qué falta

| Hecho y probado | Falta |
|---|---|
| Replay y verificador con el wasm real | Integrarlo al Worker (`INTEGRACION.md`) |
| `MatchRoom` con el protocolo de `MatchDO`, por WebSocket y por WebRTC | Probar los instaladores en máquinas reales: VPS con nombre DNS, Windows, macOS. La lista completa está en `PRODUCCION.md` |
| Adaptador WebRTC del jugador con el `NetClient` real | TURN real en producción para nodos detrás de NAT simétrico |
| Verificador de confianza con cola y reintentos | Atestación de inputs desde el cliente (v2) |
| Tienda, saldo, inventario y congelamiento | Los autos nuevos en el juego y el selector que consulta el inventario |
| Strikes que vencen y pausas de 24 horas | Registro, puntos y replays persistentes (SQLite del DO y R2) |
| Lanzador, releases firmadas, build con `werift` adentro | Canal sin orden para inputs y snapshots, con cambios en el cliente |
| Apagado sin cortar partidas en Linux, macOS y Windows (`stop.request`) | Verificación en un worker thread, para que un VPS que hostea y verifica use sus dos núcleos |
| Validación de cada mensaje de los nodos; resultados, abandonos y puntos tomados del replay | Calidad medida por los clientes (vuelve la bonificación de 1,2) |

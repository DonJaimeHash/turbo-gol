# Decisiones

## Confirmadas por el mantenedor (15/10/2026)

| # | Pregunta | Decisión | Cómo quedó implementado |
|---|---|---|---|
| 1 | ¿Las PCs hogareñas hostean desde la primera versión? | **Sí.** | Transporte WebRTC: la PC no abre puertos ni necesita IP pública. Un DataChannel confiable y ordenado lleva los mismos mensajes que el WebSocket. Instaladores para Windows, macOS y Linux de escritorio. |
| 2 | ¿Recompensas con dinero? | **Sin dinero.** Puntos para canjear autos nuevos y otras cosas que se agreguen después. **Solo quien comparte recursos puede tener las cosas nuevas.** | Saldo de puntos canjeable en una tienda de anfitriones. Los ítems no se compran, no se ganan jugando y no se intercambian. Ver `RECOMPENSAS.md`. |
| 3 | ¿El código del nodo va al repo público con AGPL? | **Sí.** | Vive en `nodes/` del repo público desde el 19/10/2026, con su propio CI. |
| 4 | ¿Quién verifica al principio? | **Un VPS en São Paulo que levanta el mantenedor**, que además es **el primer servidor ranked**. | Nodos "de confianza" del proyecto: entran directo como activos, verifican todas las partidas y no cobran puntos. La cola de verificación espera al VPS hasta 6 horas si está caído. Ver `VPS-SAO-PAULO.md`. |
| 5 | ¿Cuántas partidas de prueba antes del ranked? | **20 partidas casuales verificadas.** | Ya era el valor por defecto. |
| 6 | ¿Cuánto cuesta el primer auto de la tienda? | **1.500 puntos** (decidido el 15/10/2026). | Ya era el precio del catálogo (`car-next-1` en `control-plane/shop.ts`). Hoy es el precio de cada auto de `src/game/cosmetics.ts` (pampero, carpincho, cóndor, tero), "próximamente" hasta que su carrocería exista. |
| 7 | ¿Qué partidas se verifican? | **Todas las ranked: el objetivo es proteger el ranking. Las casuales, no todas** (decidido el 19/10/2026). | Ranked: siempre. Casuales: todas las de un nodo a prueba, porque sus 20 casuales verificadas son el camino al ranked (decisión 5); el 20 % de las de un nodo activo, elegidas al azar al llegar el reporte; ninguna en los nodos del proyecto. Una casual sin verificar no da puntos; una verificada por muestreo los da multiplicados por 1 / 0,2. `casualVerifyRate` en `control-plane/controlPlane.ts`. |
| 8 | ¿Cuánto duran las ranked? | **3 minutos** (decidido el 19/10/2026). | Aplicado en el juego para todas las partidas (PR #13: `DEFAULT_MATCH_SECONDS = 180`). El nodo y el verificador no tienen el largo fijo: lo reciben del matchmaker. |

## Tomadas por defecto en el prototipo

Todas se pueden cambiar.

| # | Decisión | Elegido | Por qué |
|---|---|---|---|
| 1 | Dónde vive | `nodes/` en el repo, con licencia AGPL (decisión 3). Se armó en una carpeta privada y se trajo al repo el 19/10/2026 | Las claves (`.keys/`) nunca entran al repo: `nodes/.gitignore` las excluye. |
| 2 | Programa del nodo | Node 24, el mismo `rocketsim.wasm` y el mismo `RoomHost` que el Worker. Una sola dependencia, `werift`, empaquetada adentro | El operador baja un único archivo firmado, igual para Windows, macOS y Linux. |
| 3 | WebRTC en el nodo | `werift`, TypeScript puro | `node-datachannel` es más rápido pero nativo: obligaría a publicar un binario por plataforma. Un 3v3 por WebRTC consume cerca del 12 % de un núcleo contando ambos extremos. |
| 4 | Canal WebRTC | Uno solo, confiable y ordenado | `NetClient` asume el orden del WebSocket. Un canal sin orden es una optimización que necesita cambios en el cliente. |
| 5 | Transporte de un VPS | WebSocket con TLS directo al VPS, con certificado de Let's Encrypt vía Caddy. **El VPS necesita un nombre DNS**: el chequeo de alcance corre en un Worker, y un Worker no puede pedir una IP pura (documentación de Cloudflare, 28/09/2026). El certificado de IP queda solo para pruebas | No hace falta tocar el cliente para esos nodos. |
| 6 | Qué nodo ve cada cliente | Un cliente sin el adaptador WebRTC nunca va a una PC hogareña | El cliente declara qué transportes soporta en la cola. |
| 7 | Alcance de una PC hogareña | Un autotest WebRTC que tiene que pasar **por el relay TURN**: si pasa, cualquier jugador puede llegar, al peor caso por el relay. Sin TURN no se habilita ninguna PC (salvo en desarrollo local). Si falla, el nodo lo reintenta solo, cada vez más espaciado | Es la prueba equivalente al chequeo `/healthz` de un VPS. Un autotest sin relay pasa en cualquier máquina y no prueba nada. |
| 8 | PCs que se apagan | Un corte es un strike, aunque el nodo tuviera varias partidas. Un nodo que se reinicia también pierde sus partidas. Los strikes vencen a los 7 días. Tres en una semana pausan el nodo 24 horas y después vuelve solo; una segunda pausa en 30 días lo devuelve a prueba (otras 20 partidas verificadas para volver al ranked). Una verificación fallida, en cambio, lo suspende hasta que un mantenedor revise, aunque ya estuviera pausado | Un apagón no puede dejar a alguien afuera para siempre, pero un nodo inestable no recibe partidas. |
| 9 | Operadores en ranked | Nunca hostean una partida ranked en la que juegan | Meter lag en tu propio servidor es la trampa más barata que existe. |
| 10 | Abandonos en nodos comunitarios | Solo los explícitos, que pasan por el plano de control, en el tick que corresponde a cuándo se pidieron. Un dodge cuenta si el jugador pidió salir antes del inicio, salvo que su cliente diga que nunca llegó a entrar. Un no-show solo al cerrar la ventana de ingreso y con evidencia del plano de control: en una PC hogareña, quien ni siquiera mandó su oferta WebRTC (y nadie, si no llegó ningún jugador); en un VPS comunitario, nadie. Los nodos del proyecto sí informan no-shows. Cualquier otra cancelación de una ranked cuenta como partida perdida | Un nodo no puede perjudicar a un jugador inventándole un abandono, ni anular una ranked que va perdiendo. |
| 11 | Claves | Tres separadas: control para tickets, releases para versiones, una por nodo | Quien robe el plano de control no puede publicar código en los nodos. |
| 12 | Actualizaciones | Canal `stable` y `minimum`, drenaje y salida con código 75, vuelta atrás tras tres caídas en diez minutos | El modelo de los runners de GitHub, sin cortar partidas en curso. |
| 13 | Capacidad | Benchmark en el peor caso, un 3v3 con seis bots, al 60 % de un núcleo, más el ancho de subida declarado | En una PC hogareña el límite real suele ser la subida: el instalador la pregunta. |

## Preguntas abiertas

1. **IP de los jugadores en PCs hogareñas.** Con WebRTC, el anfitrión ve la IP pública de los
   jugadores y los jugadores ven la del anfitrión, igual que en el P2P actual. Se puede forzar que
   todo pase por TURN para ocultarlas. Ocultar al anfitrión cuesta casi nada; ocultar a los
   jugadores cuesta todo el tráfico de la partida, pasados los 1.000 GB gratis por mes. La
   recomendación actualizada, con números, está en `PRODUCCION.md`: ocultar al anfitrión desde la
   beta con PCs de amigos y a los jugadores por defecto al abrir al público.
2. **Cuál es el primer auto.** El precio quedó en 1.500 puntos. El juego todavía no tiene un
   segundo auto: hace falta diseñarlo, y hasta entonces la tienda lo muestra como "próximamente".
3. **Precios de los demás ítems.** Con la fórmula actual y partidas de 3 minutos, una PC con lugar
   para una partida que hostea diez 1v1 por noche gana unos 90 puntos, y hasta 180 en una región que
   no da abasto. El auto de 1.500 cuesta entre 8 y 17 noches de aporte. La estela (600) y la
   explosión de gol (1.000) siguen siendo precios por defecto; se ajustan con tráfico real.
4. **Calidad medida por los clientes.** La bonificación de 1,2 por máquinas excelentes está
   apagada: hoy el lag lo mide el propio servidor y podría mentirlo. Vuelve cuando los clientes
   informen su propia medición.

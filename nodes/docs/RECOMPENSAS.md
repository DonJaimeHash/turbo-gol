# Recompensas para quien pone un servidor

## La regla

**Las cosas nuevas del juego son solo para quien comparte su máquina.** Un auto nuevo, una estela
de boost o una explosión de gol se consiguen únicamente canjeando puntos de anfitrión. No se
compran con dinero, no se ganan jugando y no se intercambian entre cuentas.

Así lo decidió el mantenedor el 15/10/2026: sin dinero, con puntos para reclamar autos nuevos y
otras cosas que se van a agregar después.

## Qué tiene que lograr

1. **Que valga la pena para una persona común.** Pone su PC o paga un VPS.
2. **Que premie lo útil.** Partidas reales, bien servidas, en las regiones donde faltan servidores.
3. **Que no se pueda farmear.** Si fabricar partidas diera puntos, alguien las fabricaría.
4. **Que no convierta al proyecto en un negocio de hosting** ni choque con lo decidido sobre
   monetización.
5. **Que trate igual a una PC hogareña y a un VPS.** Se premia el trabajo, no el gasto.

## Cómo se ganan puntos: minutos-jugador verificados

Un punto por cada minuto que un jugador real jugó en tu servidor, contado solo si la partida pasó
la verificación. Una partida 3v3 de 3 minutos con seis personas vale 18 minutos-jugador; un 1v1
de 3 minutos vale 6. Eso sigue el costo real del operador: más jugadores, más ancho de banda.

**Qué partidas se verifican.** Todas las ranked. Las casuales de un servidor a prueba, todas. Las
de un servidor activo, el 20 % elegido al azar: solo esas dan puntos, multiplicados por 5 (1 / 0,2),
así que en promedio el operador gana lo mismo que si se verificaran todas, con la quinta parte del
trabajo de verificación.

**Los minutos los cuenta el verificador, no el servidor.** Al re-simular la partida, el
verificador mide cuánto estuvo presente cada jugador: desde el inicio hasta el final o hasta que
pidió salir, sin los tramos de 10 segundos o más con los controles en cero, que es lo que recibe
un jugador desconectado. Lo que el servidor diga de sus propios jugadores solo puede bajar ese
número, nunca subirlo.

```
puntos = minutos-jugador ponderados x factor de región x calidad x repetición
```

| Factor | Valores | Para qué |
|---|---|---|
| Peso del jugador | 1 para cuentas con 7 días o más; 0,25 para invitados y cuentas nuevas | Que crear cuentas descartables no rinda |
| Factor de región | De 0,5 a 3. Se fija al asignar la partida: 0,5 + (partidas corriendo en los servidores de la región, contando esta, más las que la región no pudo tomar en los últimos 15 minutos) / lugares que ofrecen los servidores de la región | Llevar servidores a donde faltan |
| Calidad | 1,0 con lag p99 de hasta 12 ms y hasta 5 % de inputs tardíos; si no, 0,5. Hoy esos números los mide el propio servidor, así que solo pueden restar. El 1,2 para máquinas excelentes vuelve cuando los midan los clientes de los jugadores | Premiar máquinas sanas |
| Repetición | 1 / (1 + veces que el mismo grupo jugó en tus servidores en las últimas 24 h) | Que diez amigos jugando entre ellos no farmeen |

Implementado en `control-plane/ledger.ts`, probado en `test/logic.test.mjs`.

## Cómo se gastan: la tienda de anfitriones

| Concepto | Cómo funciona |
|---|---|
| **Saldo** | Puntos ganados desde el principio menos los canjeados. No vencen. |
| **Catálogo** | Cada ítem tiene un precio y un estado: disponible, próximamente o retirado. "Próximamente" se ve pero no se puede canjear, porque el juego todavía no lo tiene. "Retirado" lo conservan quienes lo tienen. |
| **Inventario** | Lo que tiene cada cuenta. El juego lo consulta para desbloquear los ítems. |
| **Congelamiento** | Si una partida de tus servidores falla la verificación, tus canjes quedan en pausa hasta que un mantenedor revise. |

Todo eso vive en la cuenta (`AccountsDO`, `server/src/accountStore.ts`): los puntos llegan desde el
plano de control una vez por partida verificada, un canje es una sola transacción y canjear dos
veces lo mismo no gasta dos veces. Un mantenedor puede dar un ítem sin costo (`/nodes/admin/grant`,
para probar o para devolver lo que un error quitó), sacarlo (`revoke`, que devuelve lo gastado) y
levantar un congelamiento (`unfreeze`); cada acción queda en el canal del equipo.

Catálogo, en `control-plane/shop.ts`; los autos salen de `src/game/cosmetics.ts`, la misma tabla
que lee el juego:

| Ítem | Tipo | Precio | Estado |
|---|---|---|---|
| Anfitrión | Insignia en el perfil y tu nombre en la pantalla de carga de tus partidas | Gratis, con una partida verificada que sirvió a otro jugador (una que jugaste solo en tu servidor no cuenta) | Disponible |
| Pampero, Carpincho, Cóndor, Tero | Auto (solo la carrocería: el mismo hitbox y la misma física que el Dune, que es de todos) | 1.500 cada uno, decidido por el mantenedor | Próximamente, hasta que su carrocería esté hecha |
| Próxima estela de boost | Estela | 600 | Próximamente |
| Próxima explosión de gol | Explosión | 1.000 | Próximamente |

Agregar un auto nuevo es agregarlo a `src/game/cosmetics.ts` con su carrocería: la tienda lo lista
sola. Todo el arte del juego es procedural, así que producir variantes cuesta poco.

### Ejemplos de ritmo

- **Una PC hogareña con lugar para una partida, una noche:** diez partidas 1v1 de 3 minutos, una
  a la vez, entre cuentas establecidas y con rivales distintos. Cada partida vale 6 minutos-jugador.
  El factor de región es 0,5 + 1/1 = 1,5 y la calidad 1,0: 9 puntos por partida, 90 por noche. Si
  el servidor ya es activo, son en promedio dos partidas verificadas de 45 puntos. El auto de 1.500
  se canjea en unas 17 noches de aporte.
- **La misma PC en una región que no da abasto:** si en los últimos 15 minutos hubo partidas que
  la región no pudo tomar y se fueron a los servidores del proyecto, el factor sube hasta 3: hasta
  180 puntos por noche.
- **Un VPS con lugar para cuatro partidas, en una región con muchos servidores:** con una sola
  partida corriendo, el factor es 0,5 + 1/4 = 0,75. Sigue sumando, pero rinde más abrir un
  servidor donde falta.
- **Los nodos del proyecto**, como el VPS de São Paulo, no ganan puntos.

## Defensas contra el farmeo

- **El nodo no puede crear partidas.** Solo juega las que le asigna el matchmaker, que elige al
  azar entre los nodos elegibles.
- **Sin verificación no hay puntos.** Una verificación fallida vale cero, suspende el nodo hasta
  que un mantenedor revise y congela los canjes del operador.
- **Los minutos salen del replay verificado.** Inflar la duración, repetir jugadores o declarar
  un lag perfecto en el reporte no suma nada.
- **Los minutos del propio operador no cuentan**, y nunca hostea una ranked en la que juega.
- **Invitados y cuentas nuevas pesan un cuarto.**
- **El mismo grupo de jugadores rinde cada vez menos** dentro de 24 horas.
- **Los puntos no se transfieren y los ítems no se intercambian**, así que no hay mercado que
  alimente el fraude.

## Lo que no hacemos

- Vender puntos o ítems por dinero.
- Dar ventajas dentro de la cancha. Los ítems son estéticos.
- Rankear por "quién tiene más hardware". El ranking del mes es de partidas bien servidas.

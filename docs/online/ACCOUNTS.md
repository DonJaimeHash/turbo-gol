# Menús, cuentas, ranked y salas (2026-10-15)

Las fórmulas de rating están en `src/net/rating.ts` (con la referencia al paper) y los vectores de
prueba en `tests/rating.test.mjs`.

## Menú (src/ui)

Estructura:

```
Inicio ── JUGAR ── Casual            (playlists Mano a mano / Parejas / Tríos, varias a la vez,
      │        │                       región, conexión P2P o servidor)
      │        ├─ Competitivo         (solo cuentas: rango por playlist, clasificación, bloqueo)
      │        ├─ Partidas personalizadas ── lista pública por región, unirse por código,
      │        │                             crear sala ── Sala (equipos, anfitrión, iniciar)
      │        └─ Amistoso            (offline contra la IA)
      ├─ ENTRENAMIENTO  (Práctica libre + 9 packs: Definición / Atajadas / Aéreos × Principiante / Intermedio / Experto)
      ├─ CLASIFICACIÓN  (top 100 por playlist + tu posición)
      ├─ PERFIL         (invitado: entrar / crear cuenta / recuperar; cuenta: rangos y acciones)
      └─ CONFIGURACIÓN  (la pantalla de controles y cámara de siempre)
```

- **Barra superior:** el camino recorrido, la región con los jugadores conectados y el chip de cuenta
  (insignia del mejor rango). Al hacer clic en el chip se abre el Perfil.
- **Barra inferior:** las teclas y el banner de búsqueda, con el tipo, las playlists, el
  cronómetro y el botón CANCELAR. El banner sigue visible mientras navegás otras pantallas.
- **Controles:** teclado (flechas, Enter, Esc / Backspace), mando (D-pad / stick, A, B) y mouse.
  La navegación es espacial: se mueve al elemento más cercano en la dirección que elegís. Los
  selectores `‹ valor ›` cambian con ← →.
- **Fin de partido:** volvés a la pantalla desde la que buscaste: Casual, Competitivo o la Sala.
  - Después de un ranked aparece el resultado: victoria o derrota, MMR antes y después, cambio de
    rango y progreso de clasificación.

## Cuentas

| Tema | Decisión |
|---|---|
| Métodos | Usuario + contraseña (siempre) y Google / Discord (cuando estén sus secretos) |
| Contraseña | Nunca sale del navegador: se manda PBKDF2-SHA256 (200.000 iteraciones, sal = usuario). El servidor guarda PBKDF2 de eso con sal aleatoria (100.000, el máximo de Workers) |
| Sesión | JWT de 1 h para las llamadas; refresh token de 30 días en cookie `__Host-` HttpOnly, Secure, SameSite=Strict, que rota en cada uso |
| Recuperación | 8 códigos `XXXX-XXXX` al registrarse; cada uno sirve una vez. No hay email |
| Fuerza bruta | 5 fallos por usuario → espera de 30 s que se duplica hasta 15 min; 30 por IP; 5 registros por minuto por IP; Turnstile en el registro (activo en el despliegue oficial) |
| Almacenamiento | Un Durable Object con SQLite (`AccountsDO`): 25.000 cuentas ocupan pocos MB |
| Invitados | Siguen igual: Casual, salas y entrenamiento. No tienen rango ni aparecen en la clasificación |

### Activar Google y Discord

El código está listo. Cada proveedor se activa cuando cargás sus dos secretos, y si no están, el
botón no aparece.

**Google** (console.cloud.google.com → APIs & Services):
1. En *OAuth consent screen*, tipo External, completá nombre y email de soporte. El scope es
   `openid profile`: no se pide el email.
2. En *Credentials → Create credentials → OAuth client ID*, tipo Web application.
3. Authorized redirect URI: `https://turbo-gol.com/api/auth/oauth/google/callback`.
4. Copiá el Client ID y el Client secret.

**Discord** (discord.com/developers/applications):
1. *New Application* → OAuth2.
2. Redirect: `https://turbo-gol.com/api/auth/oauth/discord/callback`.
3. Copiá el Client ID y el Client Secret (con *Reset Secret*). El scope es `identify`.

Después cargalos como secretos del Worker (cada comando pide el valor):

```
cd server
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
```

Para probarlo en local, crea un cliente OAuth de desarrollo aparte, con la URL de retorno
`http://localhost:5173/api/auth/oauth/<proveedor>/callback`, y pon su Client ID y su Client Secret
en `server/.dev.vars` junto con `PUBLIC_ORIGIN=http://localhost:5173`. Nunca pongas ahí los valores
de producción: `.dev.vars` es texto plano en la PC. Una cuenta nueva por OAuth
toma el nombre del proveedor (por ejemplo `Ana` o `Ana42` si ya existe) y se puede renombrar una
vez desde el Perfil.

### Entrada de desarrollo (local y forks)

Para trabajar sin secretos de proveedores hay una entrada solo de desarrollo. Agrega la línea
`DEV_AUTH=1` a tu propio `server/.dev.vars` (nunca a `wrangler.jsonc` ni a otro archivo del repo: una
prueba falla si alguno la tiene) y reinicia `wrangler dev`. El Perfil muestra **ENTRAR (DEV)** con un
campo de nombre: cada nombre entra a su propia cuenta local, que se crea la primera vez, con el
correo `<nombre>@dev.invalid` ya confirmado y sin contraseña. `POST /api/dev/signin { "name" }` hace
lo mismo desde un script, y `GET /api/dev/mail` lista lo que el simulador de correo "mandó", con sus
códigos y enlaces.

Las dos rutas responden 404, como una ruta que no existe, salvo con `DEV_AUTH=1`, el Worker en un host
local (127.0.0.1, localhost) y una petición sin Origin o desde una página local. En producción el host
es `turbo-gol.com`, así que no funcionan aunque alguien cargara la variable. Un fork publicado en su
propio dominio no puede crear cuentas hasta tener Email Service en ese dominio o una aplicación de
Discord o Google propia.

## Ranked

| Tema | Decisión |
|---|---|
| Dónde | Siempre en servidor con autoridad (`MatchDO`). Hoy es el DO de Miami/Atlanta; con el VPS de la fase 3 pasa a São Paulo |
| Rating | Weng-Lin Bradley-Terry (el de OpenSkill, licencia MIT), de la familia de TrueSkill. Hay un `mu` y un `sigma` por playlist. MMR mostrado = `mu × 40` (empieza en 1000) |
| Cuánto se mueve | ~±100 MMR por partida al principio y ~±10 cuando ya está asentado (tau 0,125) |
| Clasificación | 5 partidas por playlist antes de mostrar rango |
| Rangos | Bronce, Plata, Oro, Platino, Diamante, Élite y Maestro (I–III cada uno), y Leyenda. El MMR inicial cae en Oro II |
| Emparejamiento | Ventana de MMR de ±100 que crece 50 cada 10 s hasta ±600, y desde los 150 s cualquiera. Los dos jugadores tienen que aceptarse mutuamente. Los equipos se balancean probando todas las divisiones. Nunca se completa con bots |
| Una partida a la vez | Lock en `AccountsDO` válido en todas las regiones; reconectar usa el rejoin de siempre |
| No se presenta | Si alguien no se conecta en 45 s, la partida se cancela: nadie pierde MMR y el ausente suma un abandono |
| Abandonar | Salir o estar desconectado al final cuenta como derrota más un abandono. Los compañeros del que se fue pierden la mitad |
| Forfeit | Si un equipo entero sale, o queda desconectado 60 s, pierde en el acto |
| Bloqueos | Abandonos en 24 h: 5 min, 15 min, 1 h y 24 h |
| Temporada | 1 (el campo `season` ya existe para reinicios futuros) |

## Salas personalizadas

- Cada sala es un `LobbyDO` con hibernación. El código es de 6 caracteres, sin I/O/0/1.
  - Opciones: contraseña opcional, pública (en la lista) o privada (solo por código), modo,
    conexión P2P o servidor, y duración de 3, 5 o 10 min o sin límite.
- **Lista pública:** se ordena con tu región primero, después las abiertas, y por cantidad de
  jugadores.
- **Equipos:** cada jugador entra al equipo con menos gente y se cambia si hay lugar. El anfitrión
  configura, saca jugadores e inicia la partida, y si se va, pasa al que más tiempo lleva.
- **Inicio:** el matchmaker de la región arma la partida con esos equipos exactos y completa con
  bots. P2P necesita 2 humanos o más; uno solo juega en servidor. No suman ni restan rango.
- **Vuelta:** al terminar el partido volvés a la sala. Se reabre cuando vuelven todos, o a los
  40 min.
- **Reglas experimentales** (Ajustes > Experimental, solo cuentas con el interruptor activado):
  el anfitrión de una sala P2P elige Estándar, un preset incluido o uno propio. Es una copia del
  preset (`LobbySettings.physics`), validada estrictamente en el Worker, `LobbyDO`, el matchmaker,
  `RoomDO` y el cliente.
  - Solo entran jugadores con cuenta: un invitado no puede crearla ni unirse (403
    `account_required`), y no se pueden activar reglas con un invitado en la sala
    (`guests_present`). La lista la marca EXP (con candado para los invitados). `LobbyDO` manda
    la marca `guest` de cada miembro al matchmaker, y el matchmaker y `RoomDO` rechazan otra vez
    las reglas con un invitado (403 `account_required`).
  - Solo P2P con al menos 2 humanos (`experimental_p2p_only`): nunca un `MatchDO`, nunca un nodo y
    sin pasar a un partido en servidor si la malla falla (se vuelve a la sala).
  - No cuenta para nada: sin rango, sin estadísticas, sin récords y sin castigos por no
    presentarse. Las colas casual y ranked, `MatchDO`, los nodos y los reportes a `AccountsDO`
    rechazan cualquier cuerpo con reglas (`experimental_lobby_only`).
  - Cada cliente arma la arena con las reglas antes de los autos y manda en `ready` la huella de lo
    que el wasm aplicó; la sala rechaza otra (`physics_mismatch`) y ese auto pasa a la IA.

## Costo

- **Durable Objects nuevos:** un `AccountsDO`, un `LobbyDirectoryDO` y un `LobbyDO` por sala que
  hiberna. Las llamadas son pocas: login, refresh cada hora, `/api/me` al abrir pantallas, y
  población y lista de salas cada 5–10 s mientras el menú está abierto.
- **Cachés:** la población y la lista de salas se cachean por región en el Worker (5 s / 3 s) y la
  clasificación 30 s.
- Nada de esto cambia el presupuesto de `DECISIONS.md`. Lo que cuesta es simular partidas
  (`MatchDO`), y el ranked usa los mismos `MAX_ACTIVE_ROOMS`.

## Pruebas

| Qué | Resultado |
|---|---|
| `tests/rating.test.mjs` | Reproduce el vector de referencia de openskill.js; reglas de abandono; rangos |
| `server/test/accounts.test.mjs` | `AccountStore` sobre node:sqlite (registro, refresh, recuperación, OAuth, renombre, ranked idempotente, bloqueos, clasificación), crypto, throttle, OAuth con fetch falso, matchmaking ranked, helpers de salas |
| `tests/menu-accounts.test.mjs` | Navegación espacial, AccountClient y LobbyClient con red falsa |
| `server/test/dev-signin.test.mjs` | La entrada de desarrollo: 404 igual que una ruta desconocida sin `DEV_AUTH` o fuera de un host local, 200 en local, la cuenta con `<nombre>@dev.invalid` confirmado, `auth.devSignIn` en `/api/config`, y que ningún archivo del repo fije `DEV_AUTH` |
| `server/test/smoke-accounts.mjs` | Contra `wrangler dev` con `DEV_AUTH=1`: entrada de desarrollo, refresh rotativo, ranked con forfeit y MMR, bloqueo, población, salas con contraseña e inicio P2P, renombre y logout. Solo en local: crea cuentas descartables |
| Navegador (pane, `wrangler dev` + Vite) | Casual con banner y caída a servidor, vuelta al menú, registro con códigos, Competitivo con rangos, sala creada e iniciada con vuelta a la sala, entrenamiento desde el menú, y ranked completo contra un rival de prueba que abandona: el modal mostró VICTORIA y la clasificación 1/5 |

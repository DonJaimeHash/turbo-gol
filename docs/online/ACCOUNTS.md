# Menús, cuentas, ranked y salas (2026-10-30)

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
      ├─ PERFIL         (invitado: entrar / crear cuenta con correo; cuenta: rangos, correo y acciones)
      └─ CONFIGURACIÓN  (la pantalla de controles y cámara de siempre)
```

- **Barra superior:** el camino recorrido, la región con los jugadores conectados y el chip de cuenta
  (insignia del mejor rango). Al hacer clic en el chip se abre el Perfil.
- **Barra inferior:** las teclas y el banner de búsqueda, con el tipo, las playlists, el
  cronómetro y el botón CANCELAR. El banner sigue visible mientras navegas otras pantallas.
- **Controles:** teclado (flechas, Enter, Esc / Backspace), mando (D-pad / stick, A, B) y mouse.
  La navegación es espacial: se mueve al elemento más cercano en la dirección que eliges. Los
  selectores `‹ valor ›` cambian con ← →.
- **Fin de partido:** vuelves a la pantalla desde la que buscaste: Casual, Competitivo o la Sala.
  - Después de un ranked aparece el resultado: victoria o derrota, MMR antes y después, cambio de
    rango y progreso de clasificación.

## Cuentas

| Tema | Decisión |
|---|---|
| Formas de entrar | Un correo confirmado y una contraseña, Google o Discord (cuando estén sus secretos). Las cuentas viejas con usuario y contraseña siguen entrando con su usuario hasta la fecha de corte (abajo) |
| Cuentas nuevas | Con un correo: te enviamos un código de 6 dígitos y la cuenta existe solo después de escribirlo. Con Google o Discord, el juego pregunta primero «¿Ya tienes cuenta en Turbogol?» |
| Un correo, una cuenta | `ana+tg@gmail.com` y `a.na@gmail.com` cuentan como `ana@gmail.com`. Si un proveedor trae un correo que ya es de una cuenta, entras con esa cuenta y lo vinculas |
| Contraseña | Nunca sale del navegador: se manda PBKDF2-SHA256 (200.000 iteraciones). El servidor guarda PBKDF2 de eso con sal aleatoria (100.000, el máximo de Workers), con una pimienta (`PASSWORD_PEPPER`) cuando está |
| Sesión | JWT de 1 h para las llamadas; refresh token de 30 días en cookie `__Host-` HttpOnly, Secure, SameSite=Strict, que rota en cada uso |
| Recuperación | «¿Olvidaste tu contraseña?» manda un enlace a tu correo (30 minutos, un uso). Los códigos de recuperación viejos sirven hasta la fecha de corte |
| Fuerza bruta | Turnstile en cada entrada y registro; límites durables en `AccountsDO` por correo y red, por correo y por red, más altos para una dirección IPv4 (escuelas, redes móviles) |
| Almacenamiento | Un Durable Object con SQLite (`AccountsDO`): 25.000 cuentas ocupan pocos MB |
| Invitados | Siguen igual: Casual, salas y entrenamiento. No tienen rango ni aparecen en la clasificación |

### Agregar o cambiar el correo

En **PERFIL › Cuenta y seguridad**, la fila **Correo** muestra tu correo con **CAMBIAR CORREO**,
**AGREGAR CORREO** si no tienes uno, o el correo de Discord o Google con **CONFIRMAR CORREO** si
todavía no lo confirmaste.

1. Si hace rato que no confirmas que eres tú, el juego te lo pide primero: con tu contraseña, un
   código a tu correo o el botón de tu proveedor. Para cambiar un correo que ya tienes no alcanza
   con Discord: usa tu contraseña o un código.
2. Escribe el correo nuevo y toca **ENVIAR CÓDIGO**. Te llega un código de 6 dígitos (y un enlace)
   a ese correo. Escríbelo en el juego o abre el enlace en cualquier dispositivo.
3. Al cambiarlo:
   - tu correo anterior recibe un aviso con un enlace para deshacer el cambio durante 7 días;
   - ese correo queda reservado para tu cuenta esos 7 días;
   - se cierra la sesión en tus otros dispositivos.
4. **Si no fuiste tú:** abre el enlace del aviso. Tu cuenta vuelve al correo anterior, eliges una
   contraseña nueva, se cierra la sesión en todos los dispositivos y se desvinculan Google o Discord
   si se vincularon en esos 7 días. Después el correo no se puede cambiar por 7 días. Si alguien lo
   cambió más de una vez, el enlace que llegó a tu correo sigue sirviendo aunque se haya usado otro
   después: deshace también los cambios posteriores.

Si el correo nuevo ya es de otra cuenta, ese buzón recibe un mensaje en vez del código. Si esa otra
cuenta también es tuya y entra con Discord o Google, el mensaje trae un código para pasar el correo
a esta cuenta; la otra sigue entrando con su proveedor. Si el correo es la única forma de entrar a
la otra cuenta, no se puede pasar.

### Si perdiste el acceso a tu correo

El correo es la llave de la cuenta: de ahí salen los enlaces para elegir otra contraseña.

- **Si todavía entras** (con tu contraseña, Google o Discord), cambia el correo en PERFIL antes de
  perder también esa forma de entrar.
- **Si no entras de ninguna forma** y el correo ya no es tuyo, la cuenta no se puede recuperar.
  Crea una cuenta nueva. Por eso conviene tener dos formas de entrar: tu correo con contraseña y
  Google o Discord.

### Cuentas viejas con usuario y contraseña

Las cuentas creadas antes de los correos entran con su usuario y su contraseña de siempre.

- Al entrar con el usuario, el juego te pide agregar un correo o vincular Google o Discord. Tu
  contraseña sigue siendo la misma: con el correo confirmado, entras con el correo y esa contraseña.
- PERFIL muestra un aviso hasta que la cuenta tiene un correo confirmado, y PERFIL lleva un punto
  en el menú.
- **La fecha de corte:** desde ese día una contraseña sin correo confirmado ya no sirve para entrar.
  La cuenta todavía se salva mientras tenga una sesión abierta: confirma que eres tú con la
  contraseña y agrega el correo.

**Para el dueño (cómo fijar la fecha).** La fecha es la variable `LEGACY_PASSWORD_UNTIL` del Worker,
una fecha ISO (por ejemplo `"2027-01-15"`). Mientras no está, no hay corte y el juego dice «pronto»,
sin fecha. Para fijarla:

1. Agrega `"LEGACY_PASSWORD_UNTIL": "2027-01-15"` en `vars` de `server/wrangler.jsonc` (es pública:
   no es un secreto) y despliega como siempre (`npm run deploy`).
2. El corte cae a las 12:00 UTC de ese día, el mismo día en América y en España. Nunca es antes de
   30 días después de que el servidor vio la variable por primera vez (`meta.legacy_seen`): una fecha
   más cercana se corre a ese piso, y una fecha posterior alarga el plazo.
3. `GET /api/config` muestra el corte en `auth.legacy` (`phase` `grace` y `until`). Siete días antes,
   las cuentas con la contraseña vieja y un correo confirmado reciben un recordatorio.
4. Si quitas la variable, el corte desaparece y el piso empieza de nuevo la próxima vez.

### Activar Google y Discord

El código está listo. Cada proveedor se activa cuando cargas sus dos secretos, y si no están, el
botón no aparece.

**Google** (console.cloud.google.com → APIs & Services):
1. En *OAuth consent screen*, tipo External, completa nombre y email de soporte. El scope es
   `openid email`: se pide el correo, nunca el nombre.
2. En *Credentials → Create credentials → OAuth client ID*, tipo Web application.
3. Authorized redirect URI: `https://turbo-gol.com/api/auth/oauth/google/callback`.
4. Copia el Client ID y el Client secret.

**Discord** (discord.com/developers/applications):
1. *New Application* → OAuth2.
2. Redirect: `https://turbo-gol.com/api/auth/oauth/discord/callback`.
3. Copia el Client ID y el Client Secret (con *Reset Secret*). El scope es `identify email`.

Después cárgalos como secretos del Worker (cada comando pide el valor):

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
de producción: `.dev.vars` es texto plano en la PC. El retorno de OAuth no crea ninguna cuenta: el
juego pregunta primero «¿Ya tienes cuenta en Turbogol?», y la cuenta nueva usa el nombre que escribe
el jugador, nunca el del proveedor (con las reglas de nombres del registro por correo). Un correo
confirmado que ya es de una cuenta lleva a entrar con ella y vincular el proveedor: un correo, una
cuenta.

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

Una excepción, en tu propia red: con `TG_LAN=1` (Vite abierto a la red para probar en un teléfono o
una TV), Vite reenvía al Worker en 127.0.0.1 las peticiones que llegan de la red, así que con
`DEV_AUTH=1` el Worker no las distingue de las tuyas. Una página abierta en otro dispositivo sigue
rechazada por su Origin, pero cualquier script en la red (un curl, que no manda Origin, o uno que
falsifica un Origin local) puede usar `POST /api/dev/signin` con cualquier nombre y leer
`GET /api/dev/mail`, con sus códigos y enlaces. Solo llega a tu base de datos local. No combines
`TG_LAN=1` con `DEV_AUTH=1` en una red en la que no confíes.

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
- **Vuelta:** al terminar el partido vuelves a la sala. Se reabre cuando vuelven todos, o a los
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
| `server/test/accounts-email.test.mjs` | Las cuentas con correo: registro con código, entrada, «¿Olvidaste tu contraseña?», los límites de correo y la confirmación por código |
| `server/test/accounts-email-manage.test.mjs` | Agregar y cambiar el correo: el código al correo nuevo, el aviso y el deshacer al anterior, la reserva de 7 días, el paso a esta cuenta del correo de otra, las preferencias, y la fecha de corte de las cuentas viejas |
| `tests/account-client.test.mjs`, `tests/menu-accounts.test.mjs` | AccountClient con red falsa, las hojas de PERFIL y de los enlaces del correo |
| `server/test/dev-signin.test.mjs` | La entrada de desarrollo: 404 igual que una ruta desconocida sin `DEV_AUTH` o fuera de un host local, 200 en local, la cuenta con `<nombre>@dev.invalid` confirmado, `auth.devSignIn` en `/api/config`, y que ningún archivo del repo fije `DEV_AUTH` |
| `server/test/smoke-accounts.mjs` | Contra `wrangler dev` con `DEV_AUTH=1`: entrada de desarrollo, refresh rotativo, ranked con forfeit y MMR, bloqueo, población, salas con contraseña e inicio P2P, renombre y logout. Solo en local: crea cuentas descartables |
| Navegador (pane, `wrangler dev` + Vite) | Casual con banner y caída a servidor, vuelta al menú, registro con códigos, Competitivo con rangos, sala creada e iniciada con vuelta a la sala, entrenamiento desde el menú, y ranked completo contra un rival de prueba que abandona: el modal mostró VICTORIA y la clasificación 1/5 |

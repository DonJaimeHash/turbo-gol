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
| Fuerza bruta | 5 fallos por usuario → espera de 30 s que se duplica hasta 15 min; 30 por IP; 5 registros por minuto por IP; Turnstile en el registro cuando se reactive |
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

Para probarlo en local, poné los mismos valores en `server/.dev.vars` junto con
`PUBLIC_ORIGIN=http://localhost:5173`, y registrá esa URL de retorno en un cliente OAuth de desarrollo. Una cuenta nueva por OAuth
toma el nombre del proveedor (por ejemplo `Ana` o `Ana42` si ya existe) y se puede renombrar una
vez desde el Perfil.

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
| `server/test/smoke-accounts.mjs` | Contra `wrangler dev`: registro, login, refresh rotativo, ranked con forfeit y MMR, bloqueo, población, salas con contraseña e inicio P2P, recuperación, renombre y logout. Solo en local: crea cuentas descartables |
| Navegador (pane, `wrangler dev` + Vite) | Casual con banner y caída a servidor, vuelta al menú, registro con códigos, Competitivo con rangos, sala creada e iniciada con vuelta a la sala, entrenamiento desde el menú, y ranked completo contra un rival de prueba que abandona: el modal mostró VICTORIA y la clasificación 1/5 |

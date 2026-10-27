# Paper glossary: terminology, notation, and style

This is the binding term map between the two editions of the paper. The English edition (`en/paper.md`) is canonical; the Spanish edition (`es/paper.md`) is its translation. The map was first written when the English edition was translated from a Spanish draft, so its tables read Spanish → English and “the source” in the notes means that draft. Now that changes flow the other way, read the tables right to left: an English term on the right is always rendered with the Spanish term on the left.

When a recurring term is not listed here, choose a rendering consistent with the patterns below, use it in both editions, and add it to the right table.

## Spanish edition conventions

These were settled when the Spanish edition was re-synced with the final English edition (October 2026):

- **Register:** neutral Spanish, impersonal or first-person plural; no voseo.
- **Retired terms:** “ventana de conexión”, never “ventana de ingreso” (“ingreso” also reads as income); points are “recibidos” or “acumulados”, never “ganados”; “franja de ocupación”, never “franja de carga”; “no se obtienen jugando”. `build/harmonize_es.py` rewrites the retired forms.
- **Numbers:** decimal point, as in English. A no-break space (U+00A0) before the percent sign (“95 %”), and a narrow no-break space (U+202F) as the thousands separator in prose and tables (“108 000”), for numbers of five or more digits. Math keeps `\,`. `build/harmonize_es.py` applies both; `build/numsep.py` lists the numbers it would miss.

---

## A. Term map

### A.1 System, actors, and components

| Spanish | English (binding) | Notes |
|---|---|---|
| nodo | node | A process of the Turbogol node software on an operator's machine that hosts and/or verifies matches. |
| nodo comunitario | community node | |
| nodo del proyecto | project node | Operated by the project; always trusted. |
| nodo de confianza / de confianza | trusted node / trusted | “(del proyecto)” → “(project)”. |
| nodos no confiables | untrusted nodes | |
| nodo solo verificador | verifier-only node | |
| operador | operator | The account responsible for one or more nodes. |
| operador de confianza | trusted operator | |
| anfitrión (rol `host`) | host (role `host`) | “nodo anfitrión” → “host node”. |
| verificador (rol `verify`) | verifier (role `verify`) | Never “validator”. |
| plano de control | control plane | Define in italics at first use (Section 1.3). Adjectival: “control-plane checks”. |
| emparejador (regional) | (regional) matchmaker | |
| objeto durable | Durable Object | Capitalized product term of the edge platform; never name the platform vendor. First use in 1.1: “a *Durable Object* on the edge computing platform the project uses”. |
| plataforma de cómputo en el borde | edge computing platform | |
| Worker / Workers | Worker / Workers | Capitalized; “the project's server-side functions on the edge computing platform”. |
| objeto de partida | match object | The matchmaker's own Durable Object for a match. |
| objeto de cuentas | accounts object | |
| almacenamiento de objetos | object storage | |
| contenedor (de versiones) | (release) bucket | “Regla del contenedor” → “bucket lifecycle rule”. |
| programa del nodo | node software | |
| lanzador | launcher | |
| proxy TLS | TLS proxy | |
| servidor virtual | VPS | Expand once as “virtual private server (VPS)” at first prose use (Section 4.6); “VPS” in tables. |
| computadoras domésticas | home computers | |
| cliente web | web client | |
| servidores propios (del juego) | the game's own servers | |
| servidor autoritativo | authoritative server | |
| red de distribución | content delivery network (CDN) | |
| persona mantenedora | the maintainer | Gender-neutral; “la PC de la persona mantenedora” → “the maintainer's PC”. |
| personas allegadas al proyecto | people close to the project | |
| canal interno del equipo | the team's internal channel | |
| rutas `/nodes/*` | `/nodes/*` routes | |

### A.2 Matches, players, and outcomes

| Spanish | English (binding) | Notes |
|---|---|---|
| partida | match | |
| clasificatoria (adj./noun) | ranked (match) | “las clasificatorias” → “ranked matches”. |
| casual | casual (match) | |
| calificación | rating | |
| clasificación (la tabla de los jugadores) | the ranking | Only in 6.7 (“what matters most to players, the ranking”). |
| puntuada / sin puntuar / anulada | rated / unrated / void | Outcome names. Bold list items: **Rated**, **Unrated**, **Void**. |
| anular / anulación | void (verb) / voiding, void outcome | “se anula como `no_report`” → “is voided as `no_report`”. |
| cerrar una partida / cierre | close a match / closing | Never “settle”. “Una partida se cierra exactamente una vez” → “A match is closed exactly once”. |
| resultado (de la partida) | outcome; result | “outcome” for rated/unrated/void; “result” for score/winner and for “result delivery”. |
| plantel | roster | |
| asiento / asientos humanos | seat / human seats | |
| humano | human (player) | |
| equipo azul / rojo | blue / red team | Keep the source colors. |
| marcador | score | Exception: “Próximo auto (marcador)” in Table 13 → “Next car (placeholder)”. |
| ganador / empate | winner / tie | Never “draw” for a tie (see “sorteo”). |
| saque / saque inicial | kickoff | “reinicio de saque” → “kickoff reset”; “semilla de saque” → “kickoff seed”. |
| cuenta regresiva | countdown | |
| pausa tras gol | post-goal pause | Distinct from the strike cooldown. |
| fases congeladas | frozen phases | “antes del inicio, cuenta regresiva, pausa tras gol, final” → “pre-start, countdown, post-goal pause, end”. |
| tiempo extra | overtime | “máximo de tiempo extra” → “maximum overtime”. |
| duración reglamentaria | regulation length | “final reglamentario” → “regulation ending”. |
| sin límite (de tiempo), $L = 0$ | untimed | “partida sin límite” → “untimed match”. |
| motivo de fin | end reason | |
| equipo que abandona | forfeiting team | |
| abandono (motivo `forfeit`) | forfeit | “abandono de un equipo” → “a team forfeits”. |
| abandono (penalización en cuentas) | abandon penalty | “registran un abandono” → “record an abandon penalty”. |
| desertor | leaver | “figura como desertor” → “is recorded as a leaver”. |
| esquiva (`dodge`) | dodge | |
| incomparecencia (`no_show`) | no-show | Noun “no-show”, plural “no-shows”. |
| salida (de un jugador) | leave | “salida explícita” → “explicit leave”; “salida retransmitida” → “relayed leave”. |
| relevo / relevado por un bot | takeover / taken over by a bot | “tick de relevo” → “takeover tick”. |
| ventana de conexión | join window | Formerly “ventana de ingreso”; retired in the Spanish edition. |
| bloqueo de clasificatorias / liberación de bloqueos | ranked lock / lock release | |
| cola casual de servidor | server casual queue | |
| cola entre navegadores / de navegador a navegador | browser-to-browser queue / browser-to-browser | |
| relleno con bots | bot fill | |
| vestíbulos personalizados | custom lobbies | |
| formación (de partidas) | match formation | |
| invitado | guest | |
| antigüedad (de la cuenta) | (account) age | |
| desincronización | desync | |

### A.3 Simulation and replay

| Spanish | English (binding) | Notes |
|---|---|---|
| motor de física | physics engine | “una biblioteca de C++ de código abierto construida sobre el motor Bullet” → “an open-source C++ library built on Bullet”. Never name the library. |
| binario (único) | (single) binary | The WebAssembly physics module. |
| módulo puente | bridge module | |
| compilación (identidad) | build | `build_mismatch`; “compilación del cliente” → “client build”. |
| terna de simulación | simulation triple | |
| misma simulación | same simulation | Binary SHA-256, game protocol version, and node version all match. |
| tick / tasa de ticks | tick / tick rate | |
| acumulador | accumulator | |
| temporizador compartido | shared timer | “invocación” → “invocation”. |
| una pausa de 250 ms (del temporizador) | a stall of 250 ms | Section 3.2: a timer gap, not the strike cooldown. |
| sala | room | Define in italics at 3.2. Code `RoomHost`. |
| arena | arena | Define in italics at 3.1. |
| transición por tick | per-tick transition | |
| paso (del motor) | (engine) step | |
| estado físico / estado de las reglas | physical state / rules state | |
| máquina de estados de las reglas | rules state machine | |
| predicción de la pelota | ball prediction | |
| política de los bots | bot policy | |
| controles / controles aplicados | controls / applied controls | |
| controles nulos / tramo nulo | zero controls / zero-control run | “rachas maximales” → “maximal runs”. |
| ejes: acelerador, dirección, cabeceo, guiñada, alabeo | throttle, steer, pitch, yaw, roll | |
| botones: salto, turbo, freno de mano | jump, boost, handbrake | |
| turbo / plataformas de turbo | boost / boost pads | |
| campo, autos, pelota | field, cars, ball | |
| tick sin entrada nueva (*underrun*) | tick without fresh input, an *underrun* | Define once in 3.4 (“which we call an *underrun*”), then “underrun”. “tasa de ticks sin entrada” → “underrun rate”. |
| retraso de tick | tick lag | |
| repetición (TGR1) | replay (TGR1) | |
| registro (de la repetición) | record | “registro final” → “end record”; “registros de entrada” → “input records”. |
| encabezado | header | |
| identificador mágico | magic identifier | |
| resumen (FNV-1a) | (state) hash | Checkpoint values and `HASH` records. Verb “resumir” → “hash”. |
| resumen (SHA-256) | SHA-256 digest, or simply “its SHA-256” | “solo se almacena su SHA-256” → “only its SHA-256 is stored”. |
| punto de control (checkpoint) | checkpoint | |
| cadencia de puntos de control $\gamma$ | checkpoint interval $\gamma$ | |
| resimular / resimulación | re-simulate / re-simulation | Always hyphenated. |
| instantánea | snapshot | |
| humanos simulados por guion | scripted humans | “guion” → “script”. |
| banco de pruebas | benchmark | “el banco mide” → “the benchmark measures”. |
| generador estándar del entorno | the environment's standard random number generator | |
| fuente de aleatoriedad segura | secure random source | Never “cryptographically secure”. |
| semilla | seed | |

### A.4 Verification

| Spanish | English (binding) | Notes |
|---|---|---|
| verificar / verificación | verify / verification | |
| veredicto | verdict | |
| veredicto correcto | passing verdict (code `ok`) | |
| verificación fallida / falla de verificación | failed verification / verification failure | |
| verificaciones correctas ($V_n$) / fallidas ($F_n$) | passed verifications / failed verifications | |
| muestreo / muestreada / no muestreada | sampling / sampled / unsampled | “tasa de muestreo” → “sampling rate”. |
| sorteo / sortear | draw / draw (at random) | “sorteo de verificación” → “verification draw”; “sorteo de nodo” → “random node choice”. |
| comprometer antes de sortear | commit before drawing | The replay's SHA-256 is “committed” (fixed) before the draw. |
| cola de verificación | verification queue | “trabajo de verificación” → “verification job”. |
| verificador designado | designated verifier | |
| ceder el bucle de eventos / cesión | hand control back to the event loop / event-loop handoff | Never “yield”. |
| porción (entre cesiones) | slice | $C_{\mathrm{slice}}$. |
| prueba (que exige un motivo de fin) | proof | “prueba exigida” → “required proof”; “prueba del motivo de fin” → “end-reason proof”. |
| ticks de presencia | presence ticks | |
| desaparición simultánea | simultaneous disappearance | |
| falsificar / falsificación / falsificador | forge / forgery, forged match / forger | |
| pasar inadvertida | go undetected | |
| probabilidad de no detección | non-detection probability | |
| atribución de responsabilidad | attribution of fault | “Responsable” column → “At fault”. |
| verificador perezoso | lazy verifier | |
| ticks de desafío | challenge ticks | Avoid any “proof-of-…” phrasing. |
| atestación de entradas (del cliente) | (client) input attestation | |
| espera máxima | maximum wait | |

### A.5 Reputation

| Spanish | English (binding) | Notes |
|---|---|---|
| reputación / máquina de estados de reputación | reputation / reputation state machine | |
| estado de un nodo ($\sigma_n$) | (node) status | The tuple in 7.1 is the “reputation state”; the FSM's nodes are “states”. Table 9 clause “Estado” → “Status”. |
| no registrado | unregistered | |
| pendiente (`pending`) | pending | Drop the Spanish gloss “`pending` (pendiente)”. |
| período de prueba (`probation`) / en prueba | probation / on probation | “régimen de prueba” → “probation regime”; “superar la prueba” → “pass probation”; “vuelve a prueba” → “returns to probation”. |
| activo (`active`) | active | |
| suspensión / suspendido (`suspended`) | suspension / suspended | |
| suspendido con plazo | suspended (timed) | |
| suspendido para revisión (manual) | suspended (review), suspended for manual review | |
| pausa (24 h por faltas) / pausar | cooldown / put on cooldown | “3 faltas en 7 días para una pausa de 24 h” → “3 strikes in 7 days trigger a 24 h cooldown”. |
| degradación | demotion | |
| promoción | promotion | |
| vetado (`banned`) | banned | |
| falta | strike | Expires after 7 days. |
| faltas vigentes | active strikes | |
| caída | outage (node or link); crash (a process) | “Una caída, una falta” → “One outage, one strike”; launcher “tres caídas” → “three crashes”. |
| deduplicación | deduplication | |
| decisión de mantenimiento / ruta de mantenimiento / vista de mantenimiento | maintenance decision / maintenance route / maintenance view | |
| disparador / guarda | trigger / guard | Table 7 headers. |
| alta | enrollment | “dar de alta” → “enroll”; “altas” → “enrollments”. |
| código de alta de un solo uso | one-time enrollment code | Then “enrollment code”. |

### A.6 Placement, capacity, and regions

| Spanish | English (binding) | Notes |
|---|---|---|
| colocación / colocar | placement / place | “fuera de colocación” → “out of placement”. |
| asignación / asignar | assignment / assign | “hora de asignación” → “assignment time”. |
| planificación / planificador | scheduling / scheduler | |
| predicado de elegibilidad | eligibility predicate | “nodos aptos” → “eligible nodes”; “cláusula” → “clause”; “código de rechazo” → “rejection code”; “(prefiltro)” → “(prefilter)”. |
| estados admitidos $\mathcal{S}(\omega)$ | admitted statuses | |
| franja de ocupación (cuartos de la capacidad) | load band (quarters of capacity) | “la franja de ocupación más baja” → “the lowest load band”. |
| carga | load | |
| capacidad declarada | declared capacity | |
| plazas | slots | |
| tráfico / tope de tráfico | egress (traffic) / egress cap | |
| drenar / drena / drenaje | drain / is draining / draining | |
| verificador con actualización diferida | verifier with a deferred update | |
| interruptor (de nodos) / interruptor de emergencia | (nodes) switch / kill switch | “interruptores de configuración” → “configuration switches”. |
| espera (del emparejador, 60 s) | back-off | “deja de preguntar durante 60 s” → “stops asking for 60 s”. |
| respaldo | fallback | |
| regiones (SA, NA, EU, AS, OC, AF) | regions (SA, NA, EU, AS, OC, AF) | “Sudamérica” → “South America”. |
| factor regional | regional factor | |
| demanda insatisfecha / anotaciones | unmet demand / entries | |
| núcleo / hilo / hilo de trabajo | core / thread / worker thread | Lowercase “worker thread”; never confuse with “Worker”. |
| créditos de CPU del proveedor | the provider's CPU credits | |
| mes calendario UTC | UTC calendar month | |

### A.7 Control link, liveness, and delivery

| Spanish | English (binding) | Notes |
|---|---|---|
| enlace de control | control link | |
| sesión (de control) | (control) session | |
| iniciar sesión / inicio de sesión rechazado | log in / login refused | T11 trigger: “login refused (4403)”. |
| valor aleatorio de un solo uso | single-use random challenge | “un valor aleatorio de un solo uso de 24 bytes” → “a 24-byte single-use random challenge”. |
| bienvenida / saludo | welcome (message) / hello (message) | |
| latido | heartbeat | |
| identificador de proceso (`bootId`) | process identifier (`bootId`) | |
| código de cierre | close code | |
| alcanzabilidad / comprobación de alcanzabilidad | reachability / reachability check | “alcanzabilidad demostrada” → “demonstrated reachability”; “alcanzable” → “reachable”. |
| sonda / sondear | probe / probe | |
| autoprueba WebRTC | WebRTC self-test | |
| retransmisión TURN / servidor de retransmisión | TURN relay / relay server | |
| retransmitir (una salida, una oferta) | relay | |
| canal de datos fiable y ordenado | reliable, ordered data channel | |
| servidores ICE / oferta | ICE servers / offer | |
| subprotocolo | (WebSocket) subprotocol | |
| WebSocket seguro | secure WebSocket | |
| vida del enlace / umbrales de vida | link liveness / liveness thresholds | |
| silencio / silencio acumulado | silence / accumulated silence | |
| atasco de transporte | transport stall | |
| corte | outage; “cortar una partida” → “cut a match short” | |
| gracia (de reinicio) | (restart) grace period | |
| arranque en frío | cold start | |
| barrido | sweep | |
| alarma | alarm | Platform alarm that drives the sweep. |
| interfaz de hibernación | hibernation API | |
| informe / informar | report (noun and verb) | |
| acuse | acknowledgment | US spelling. |
| margen de informe | report grace period | |
| holguras (App. A) | tolerances | |
| bandeja de salida | outbox | |
| entrega de resultados | result delivery | |
| llamadas pendientes | pending calls | |
| tiempo límite / tiempo agotado | timeout / timed out | |
| vencer / vencimiento | expire, time out / expiry, deadline | Ticket “vencimiento” → “expiry” (field `exp`). |
| desfase (del reloj) | clock offset | |
| marca de tiempo | timestamp | |
| petición firmada | signed request | |
| subida / descarga | upload / download | |
| tarea programada | scheduled task | |
| simulacros | drills | |
| caso de estudio | case study | |

### A.8 Releases and distribution

| Spanish | English (binding) | Notes |
|---|---|---|
| versión (publicada) / versiones firmadas | release / signed releases | “versión” as a number stays “version” (“version 0.3.0”, “version 2”). |
| clave de versiones / canal de versiones | release key / release channel | |
| canal | channel | Release channel file with `stable` and `minimum`. |
| versión mínima | minimum version | |
| compuerta de despliegue | deploy gate | |
| despliegue / desplegar | deployment / deploy | |
| canal de despliegue gradual (canario) | canary channel | |
| etiqueta de versión | release tag | |
| integración continua / ejecutores | continuous integration (CI) / runners | |
| manifiesto | manifest | |
| defectuosa / última buena | bad / last known good | |
| instaladores | installers | |
| bifurcación del código | a fork of the code | Plain open-source sense only. |
| clave de control / clave de nodo | control key / node key | |
| rotación de la clave | key rotation | |

### A.9 Server points

| Spanish | English (binding) | Notes |
|---|---|---|
| puntos de servidor (o puntos de anfitrión) | server points (also called host points) | |
| minuto-jugador (verificado servido) | (verified) player-minute (served) | “un punto por minuto-jugador verificado servido” → “one point per verified player-minute served”. |
| registro de puntos | points record | |
| otorgar / otorgados | grant / granted | Never award, reward, earn, pay. |
| ganar / recibir / acumular puntos | receive / accumulate points | “nadie gana puntos todavía” → “no one receives points yet”. |
| minutos ponderados / peso | weighted minutes / weight | |
| factor de calidad | quality factor | “escalón” → “tier” (“the 1.2 tier”). |
| factor de reiteración / decaimiento por reiteración | repeat factor / repeat decay | |
| total histórico | lifetime total | |
| puntos disponibles | available points | Never “balance”. |
| desbloqueo / desbloquear | unlock (noun and verb) | |
| puntos necesarios | points required | Never “cost” or “price”. |
| congelamiento / congelar / descongelar | freeze / freeze / unfreeze | |
| catálogo (de cosméticos) | (cosmetic) catalog | |
| objeto cosmético | cosmetic item | |
| inventario | inventory | |
| garaje | garage | |
| insignia / Insignia de Anfitrión | badge / Host badge | |
| Próximo auto (marcador) | Next car (placeholder) | |
| Estela de turbo / Explosión de gol | Boost trail / Goal explosion | |
| Autos Pampero, Carpincho, Cóndor y Tero | the Pampero, Carpincho, Cóndor, and Tero cars | Proper names, keep the accent in Cóndor. |
| próximamente / disponible / retirado | coming soon / available / retired | |
| carrocería / caja de colisión / ruedas | car body / hitbox / wheels | |
| tabla (pública) de anfitriones | (public) host leaderboard | |
| insesgado / insesgadez | unbiased / unbiasedness | |
| esperanza / desviación típica / coeficiente de variación | expected value / standard deviation / coefficient of variation | |
| número armónico | harmonic number | |
| redondeo a centésimos | rounding to hundredths | “se acotan inferiormente en 0” → “are floored at 0”. |
| “a saltos” (los puntos llegan a saltos) | in lumps | “points are granted in lumps” (never “arrive”). |

### A.10 Security and privacy

| Spanish | English (binding) | Notes |
|---|---|---|
| modelo de amenazas / mitigaciones / límites conocidos | threat model / mitigations / known limitations | |
| actores / supuestos de confianza | actors / trust assumptions | |
| operador deshonesto / jugador deshonesto / atacante externo / componente del proyecto comprometido | dishonest operator / dishonest player / external attacker / compromised project component | |
| verificación en dos pasos | two-factor authentication | |
| tráfico basura | junk traffic | |
| límites por dirección | per-address limits | |
| sanción | penalty | |
| identidades desechables creadas en masa | mass-created throwaway identities | |
| nombres visibles | display names | |
| página pública de estado | public status page | “en caché 10 s” → “cached for 10 s”. |
| auditadas | audit-logged | |
| aviso de privacidad / términos para operadores / revisión legal | privacy notice / operator terms / legal review | |
| conexión directa | direct connection | |

### A.11 Status labels (Section 1.5) and roadmap

| Spanish | English label | Definition to use in 1.5 |
|---|---|---|
| en funcionamiento | *in production* | deployed and in real use |
| implementado | *implemented* | on the main branch and tested, but with no real effect in production |
| en curso | *in progress* | implemented on a branch not yet merged |
| planificado | *planned* | decided, not implemented |
| idea | *idea* | no design yet |

In Table 17's Status column capitalize the first letter: “In production”, “Implemented”, “In progress”, “Planned”, “Idea”; the mixed row reads “In production (ranked); implemented (sampling and points)”.

| Spanish | English | Notes |
|---|---|---|
| hoja de ruta | roadmap | |
| etapa 0/1/2/3 | stage 0/1/2/3 | Lowercase in prose (“stage 1”), bold where the source is bold (“**Stage 1**” only at sentence start). |
| rama principal | the main branch | Plain text, no monospace. |
| rama no fusionada | an unmerged branch (first use, 1.5: “a branch not yet merged”), then “the unmerged branch” | |
| solicitud de cambios n.º 34 | pull request #34 | All three occurrences. |
| commit `ab8d97d` | commit `ab8d97d` | |
| versión 0.3.0 del nodo | node version 0.3.0 | |
| Ítem / Estado (Table 17) | Item / Status | |

### A.12 Ambiguous Spanish words (check every occurrence)

| Spanish | Possible English renderings |
|---|---|
| prueba | probation (período de prueba, en prueba); proof (prueba exigida, $\mathrm{proof}_i$, “Demostración” is also “Proof.”); test (pruebas automáticas → automated tests); self-test (autoprueba); benchmark (banco de pruebas) |
| registro | record (replay record, end record); registry (registro de nodos → node registry); registration (“Tope del registro” → registration cap); log (“se cuentan y registran” → “are counted and logged”); points record |
| resumen | Abstract (the heading); hash (FNV-1a); digest/SHA-256 (files) |
| marcador | score; placeholder (Table 13 only) |
| abandono | forfeit (end reason); abandon penalty (accounts) |
| salida | leave (player); exit code (código de salida); outbound (conexiones salientes); outbox (bandeja de salida) |
| pausa | cooldown (24 h strike suspension); post-goal pause; stall (3.2 timer gap) |
| caída | outage; crash |
| falla / falta / fallo | failure (verification, infrastructure, probe); strike (falta); fault only in “fault tolerance” and “at fault” |
| versión | release; version |
| sesión | control session; login; the player's signed session (10.1, Table 17) |
| cuenta | account; countdown (cuenta regresiva); “cuenta para” → counts toward |
| estado | status (node); state (physical, rules, FSM); public status page |
| sorteo | draw (verification draw, kickoff seed draw); never use “draw” for a tied score |
| tráfico | egress (node's outbound bytes); traffic (generic) |
| canal | release channel; data channel; canary channel; internal team channel |
| vencer | expire (strikes, tickets); time out (a match without report) |

### A.13 Canonical sentences (use verbatim wherever the idea recurs)

- Points disclaimer (Abstract, P9, 10.1, Conclusion): “Points are not money: they cannot be bought, sold, or transferred, and they only unlock cosmetic items.” Section 10.1 adds its own extra clauses around this core.
- Core limitation (Abstract, 11.3, Conclusion): “verification proves consistency, not the authenticity of the inputs” (adapt only the surrounding syntax).
- P1 motto: “Nodes host; the project decides.” Conclusion: “Community nodes host; the project decides, by re-simulating.”
- P8 and 7.4: “One outage, one strike.”
- Abstract opening idea: “a node only *reports* a result; a project verifier *decides* whether it counts”.

### A.14 Forbidden-word traps (source phrases that tempt a forbidden rendering)

The paper's vocabulary rules apply to every word of the text and the figures, in both editions; `build/forbidden.py` scans for them. These are the traps actually present in this source:

| Spanish source | Never write | Write |
|---|---|---|
| valor aleatorio de un solo uso | nonce | single-use random challenge |
| identificador de un solo uso (`jti`) | nonce, token id | single-use identifier (`jti`) |
| código de alta | token, registration token | one-time enrollment code |
| boleto (de partida) | token, JWT, pass | match ticket, signed ticket |
| registro de puntos | ledger | points record |
| verificador | validator | verifier |
| fuente de aleatoriedad segura, firma, resumen seguro | cryptographic(ally), crypto | secure random source; Ed25519 signature; secure hash |
| cede el bucle de eventos; “de donde se obtiene” | yield(s) | hands control back to the event loop; gives, which gives |
| cerrar / finalizar una partida | settle, settlement | close, finalize |
| ganar / otorgar puntos | earn, reward, pay, payout, income | receive, accumulate; grant |
| puntos disponibles; puntos necesarios | balance; cost, price | available points; points required |
| identidades desechables en masa | Sybil | mass-created throwaway identities |
| este documento | whitepaper, white paper | this paper |
| lo que está en juego; partes interesadas | at stake, stakeholders | what is at risk; the people involved |
| sanción | slashing | penalty |
| comunitaria, de terceros, abierta | decentralized, trustless | community, third-party, open |
| coincidencia / acuerdo entre nodo y verificador | consensus | agreement, match |
| veredicto | oracle | verdict |
| transacción (5.7, App. C) | (any non-database sense) | database transaction |
| ticks de desafío | proof-of-… | challenge ticks |

Also: never write “chain”, “mint”, “mining”, “wallet”, “coin”, “gas”, “Merkle”, “on-chain”, “off-chain”, or “hard fork” in any sense; never use “token” for anything (including the lexer sense); avoid “validate” (use “check”).

**Names and files never to cite:** the commercial game that inspired Turbogol, its publisher, the physics library (always “an open-source C++ library built on Bullet” and “the physics binary” or “the WebAssembly module”), the edge platform's vendor, the repository's directory name, and these repository files whose names contain forbidden words: the points-record module, the catalog module, the signature module, the server-points design document, and the control plane's request-checking module. The Spanish source already paraphrases them; keep the paraphrases: “the points-record and catalog modules in `nodes/control-plane/`”, “the signature module in `nodes/shared/`”, “the server-points document”, “the catalog test”. Every other path in Appendix D stays verbatim (including `native/rs_api.h`).

**Appendix E:** cite the FNV specification only as “IETF Internet-Draft draft-eastlake-fnv, which specifies the FNV family of hash functions”; never quote its title (it contains a forbidden word). Reference titles in italics stay verbatim in English (they already are): *WebAssembly Core Specification*, *Edwards-Curve Digital Signature Algorithm (EdDSA)*, *Secure Hash Standard (SHS)*, *JSON Web Signature (JWS)*, *CFRG Elliptic Curve Diffie-Hellman (ECDH) and Signatures in JSON Object Signing and Encryption (JOSE)*, *Interactive Connectivity Establishment (ICE)*, *Traversal Using Relays around NAT (TURN)*, *Bullet Physics SDK*, *Emscripten*. Author lists: “and” instead of “y/e”; “E. Coumans and contributors”, “A. Zakai and contributors”; “versión 2.0” → “version 2.0”.

---

## B. Notation map

### B.1 Rule

Single-letter symbols and Greek letters never change ($T$, $E$, $L$, $J$, $p$, $k$, $K$, $f$, $M$, $\gamma$, $\kappa$, $\sigma_n$, $\theta_n$, $\omega$, $\ell_n$, $c_n$, $e_n$, $o_n$, $w_i$, $\tau_i$, $\Pi_i$, $\rho$, $\Sigma_m$, $\xi$, $\lambda$, $\varepsilon$, $\eta_m$, $\nu_m$, and so on), nor do calligraphic sets, operators, or units. Only the multi-letter identifiers built from Spanish words change, exactly as listed in B.2, everywhere they occur: display math, inline math, tables (including Tables 3, 7, 9, A.1), and the Appendix B table, whose rows keep their order with the new symbols.

### B.2 Identifiers that change

| Spanish LaTeX | English LaTeX | Meaning |
|---|---|---|
| `N_{\mathrm{ej}}(t)` | `N_{\mathrm{exec}}(t)` | ticks executed up to $t$ (Lemma 1) |
| `\mathrm{congelado}(g_{T-1})` | `\mathrm{frozen}(g_{T-1})` | frozen phase, Eq. (2) |
| `\mathrm{goles}(s'_T)` | `\mathrm{goals}(s'_T)` | goals the engine detects |
| `n_{\mathrm{saq}}` | `n_{\mathrm{ko}}` | kickoffs already executed |
| `n_{\mathrm{autos}}` | `n_{\mathrm{cars}}` | number of cars (Section 3.5) |
| `T^{\mathrm{rv}}_i` | `T^{\mathrm{take}}_i` | takeover tick of seat $i$ |
| `N_{\mathrm{rv}}` | `N_{\mathrm{take}}` | number of takeover records, Eq. (5) |
| `T^{\mathrm{ido}}_i` | `T^{\mathrm{gone}}_i` | tick at which seat $i$ disappeared |
| `\text{último}_i(E)` | `\mathrm{last}_i(E)` | last recorded controls of seat $i$ at or before $E$ |
| `t^{\mathrm{ult}}_i` | `t^{\mathrm{last}}_i` | tick of those controls |
| `\mathrm{cero}_i(Z)` | `\mathrm{zero}_i(Z)` | final $Z$ ticks of zero controls |
| `\mathrm{prueba}_i(Z)` | `\mathrm{proof}_i(Z)` | leave or $\mathrm{zero}_i(Z)$ |
| `\mathrm{seg}_i` | `\mathrm{runs}_i` | maximal runs of seat $i$ |
| `\mathrm{nula}(\rho)` | `\mathrm{null}(\rho)` | run $\rho$ consists of zero controls |
| `\text{válido}(\mathit{bol})` | `\mathrm{valid}(\mathit{tkt})` | ticket validity predicate, Section 4.7 |
| `\mathit{bol}` | `\mathit{tkt}` | match ticket |
| `t^{\mathrm{rep}}` | `t^{\mathrm{rpt}}` | report time (avoids reading “rep” as replay) |
| `t^{\mathrm{venc}}_m` | `t^{\mathrm{due}}_m` | deadline of a match without a report (not `exp`, which is the ticket field) |
| `d^{\mathrm{nodo}}_i` | `d^{\mathrm{node}}_i` | connected time reported by the node |
| `C_{\text{porción}}` | `C_{\mathrm{slice}}` | cost between two event-loop handoffs (note `\text` → `\mathrm`) |
| `N_{\mathrm{red}}` | `N_{\mathrm{net}}` | network term of the capacity formula |
| `\text{en línea}(n, t)` | `\mathrm{online}(n, t)` | Eq. (31) |
| `\text{sesión}(n)` | `\mathrm{session}(n)` | open control session of the node |
| `t^{\mathrm{lat}}_n` | `t^{\mathrm{hb}}_n` | last heartbeat or hello (“lat” would read as latency) |
| `\ell^{\mathrm{lat}}_n` | `\ell^{\mathrm{hb}}_n` | load reported in the heartbeat |
| `\ell^{\mathrm{pc}}_n` | `\ell^{\mathrm{cp}}_n` | matches the control plane has on the node |
| `t^{\mathrm{ses}}_s` | `t^{\mathrm{sess}}_s` | last signal received by session $s$ |
| `\mathrm{dren}(n)` | `\mathrm{drain}(n)` | node is draining |
| `\mathrm{dif}(n)` | `\mathrm{defer}(n)` | verifier with a deferred update |
| `N^{\mathrm{curso}}_r` | `N^{\mathrm{live}}_r` | in-progress matches in region $r$ |
| `N^{\mathrm{sin}}_r` | `N^{\mathrm{unmet}}_r` | unplaced requests in the last 15 min (“sin” would read as sine) |
| `\mathrm{puede}(n)` | `\mathrm{avail}(n)` | node able to host |
| `P_{\mathrm{nodet}}` | `P_{\mathrm{undet}}` | non-detection probability, Eqs. (14) and (17) |
| `P_{\mathrm{supera}}(f)` | `P_{\mathrm{pass}}(f)` | probability of passing probation, Eq. (19) |
| `N^{\mathrm{f}}_n(t)` | `N^{\mathrm{stk}}_n(t)` | active strikes, Eq. (21), Eq. (23), Table 7 |
| `t^{\mathrm{falta}}_n` | `t^{\mathrm{stk}}_n` | last counted strike, Eq. (22) |
| `t^{\mathrm{desde}}` | `t^{\mathrm{since}}` | start of the current failure (the code's `since`) |
| `\mathrm{cuenta}(i)` | `\mathrm{acct}(i)` | account of the player in seat $i$, Eq. (35) |
| `n^{\mathrm{se}}_i` | `n^{\mathrm{ur}}_i` | underrun ticks of seat $i$, Eq. (37) |

### B.3 Identifiers that stay (already English or neutral)

`\Delta_{\mathrm{ms}}`, `\mathrm{seed}`, `\mathrm{ser}`, `N_z`, `h_k`, `N_{\mathrm{hash}}`, `N_{\mathrm{in}}`, `\lvert\mathrm{hdr}\rvert`, `\mathcal{R}`, `E_{\max}(L)`, `\pi_{\mathrm{bot}}`, `\operatorname{f32}`, `\operatorname{clamp}`, `K^{\mathrm{pub}}_{\mathrm{ctl}}`, `t_{\mathrm{srv}}`, `\mathrm{Ed25519.verify}`, `\mathcal{U}_m`, `\mathit{id}`, `t^{\mathrm{asg}}` (assignment), `t^{\mathrm{rel}}_i` (relay of the leave), `t^{\mathrm{ttl}}`, `\mathrm{rnd}`, `C_{\mathrm{verif}}`, `U_{\mathrm{verif}}`, `t^{\mathrm{susp}}_n`, `\sigma^{\mathrm{prev}}_n`, `\mathrm{rank}(\omega)`, `\mathrm{reg}(\cdot)` (region), `\mathrm{host}(n)`, `\mathrm{build}(\cdot)`, `\mathrm{build}_W`, `C^{\mathrm{eg}}_n` (egress), `c^{\max}_n`, `N_{\mathrm{cpu}}`, `N_{\mathrm{mem}}`, `N_{\mathrm{decl}}`, `A_{\mathrm{RAM}}`, `B_{\mathrm{up}}`, `T_{\mathrm{det}}`, `\mathrm{on}_n`, `t_R`, `\delta^{\mathrm{sil}}`, `\mathrm{round}_2`, `\mathrm{req}_c`, `\mathbb{E}`, `\Pr`, `\mathrm{Var}`, `\mathrm{Bin}`, `\mathcal{U}[0,1)`, and the units `\mathrm{ms}`, `\mathrm{s}`, `\mathrm{d}`, `\mathrm{KiB}`, `\mathrm{MiB}`, `\mathrm{Mbit/s}`, `\mathrm{GB/h}`.

Ticket field names stay: `\mathrm{exp}`, `\mathrm{aud}`, `\mathrm{mid}`, `\mathrm{jti}`, and `\texttt{node:}`.

### B.4 Collision check

Every new identifier in B.2 was checked against all symbols of Appendix B (Table B.1), the ticket fields (`exp`, `aud`, `mid`, `jti`), and the units. None collides: `rpt` replaces `rep` precisely so that it cannot be read as “replay”; `due` avoids the ticket field `exp`; `hb` avoids reading `lat` as latency; `unmet` avoids `sin` (sine); `stk` avoids reusing the superscript `f` next to the forging fraction $f$; `last`/`t^{last}` and `session`/`t^{sess}` are deliberate pairs; `zero_i(Z)` (seat predicate) and `null(ρ)` (run indicator) are deliberately distinct words. Pre-existing overloads in the source ($q$ for the decoded byte, the quality case function, and a group's number of matches; $B_o$ versus $\mathcal{B}(\omega)$ versus $B_{\mathrm{up}}$; $P_m$ versus $\mathcal{P}_n$) are kept unchanged, as in the source.

### B.5 `\text{…}` strings inside math

| Spanish | English |
|---|---|
| `\text{si }` | `\text{if }` |
| `\text{en otro caso}` | `\text{otherwise}` |
| `\text{si } \Gamma \text{ emitió un reinicio de saque en } T` | `\text{if } \Gamma \text{ requested a kickoff reset at } T` |
| `\ \text{sobre}\ ` (Eq. 3) | `\ \text{over}\ ` |
| `\text{ resúmenes, en los ticks }` (Eq. 4) | `\text{ hashes, at ticks }` |
| Eq. (6) cases: `clasificatoria, o anfitrión desconocido` / `casual en un nodo de confianza (del proyecto)` / `casual en un nodo comunitario activo` / `en cualquier otro caso (nodo en período de prueba)` | `ranked, or unknown host` / `casual on a trusted (project) node` / `casual on an active community node` / `otherwise (node on probation)` |
| `\mathbb{E}[\text{partidas totales hasta detección}]` (Eq. 17) | `\mathbb{E}[\text{total matches until detection}]` |
| `p\cdot(-\text{sanción})` (6.9) | `p\cdot(-\text{penalty})` |
| `(\text{con } V_n \leftarrow 0)` | `(\text{with } V_n \leftarrow 0)` |
| `(\text{por defecto } \texttt{probation})` (Eq. 24) | `(\text{default } \texttt{probation})` |
| `\text{y en ese caso }` (Eq. 22) | `\text{and then }` |
| `\text{alerta: }` / `\text{sin colocación: }` / `\text{el nodo rechaza asignaciones: }` (8.5) | `\text{alert: }` / `\text{no placement: }` / `\text{node rejects assignments: }` |
| `\text{cuenta registrada con antigüedad } a_i \ge 7 \text{ días}` (Eq. 36) | `\text{registered account aged } a_i \ge 7 \text{ days}` |
| `\text{invitado, o cuenta con } a_i < 7 \text{ días}` | `\text{guest, or account with } a_i < 7 \text{ days}` |
| `\text{si no hay jugadores contados}` (Eq. 38) | `\text{if no players are counted}` |
| `240\ \text{ticks}\ (2\ \mathrm{s})` | unchanged |

### B.6 Code identifiers in monospace

Everything inside backticks is a code identifier or literal and stays byte-identical: statuses (`pending`, `probation`, `active`, `suspended`, `banned`, `verifying`), report kinds (`ended`, `cancelled`, `lost`), outcome and verdict codes (`lost:late_cancel`, `lost:unproven_cancel`, `lost:early_cancel`, `no_replay`, `no_report`, `node_offline`, `node_restarted`, `unverified`, `unused`, `dodge`, `no_show`, `bad_replay`, `build_mismatch`, `header_mismatch`, `too_long`, `bad_takeover`, `bad_takeover_time`, `hash_mismatch`, `end_mismatch`, `score_mismatch`, `forfeit_unproven`, `report_mismatch`, `impossible_length`, `early_ttl`, `error`, `busy`), end reasons (`rules`, `forfeit`, `ttl`, `left`, `empty`), rejection codes (`offline`, `not_a_host`, `unreachable`, `transport`, `status`, `build`, `draining`, `full`, `egress_cap`, `region`, `operator_plays`), roles and transports (`host`, `verify`, `wss`, `rtc`), records (`TGR1`, `INPUT`, `TAKEOVER`, `HASH`, `END`), and `bootId`, `jti`, `RoomHost`, `getRandomValues`, `Math.round`, `stable`, `minimum`, `stable = minimum`, `/nodes/*`, `/nodes/admin/status`, compiler flags, hashes, the commit, and file paths. Note the code spells `cancelled` with two l's; in prose use US “canceled”, “cancellation”.

The only change allowed inside backticks is translating the Spanish metavariable placeholders in angle brackets:

| Spanish | English |
|---|---|
| `tgn-auth.v1.<nodo>.<valor>` | `tgn-auth.v1.<node>.<challenge>` |
| `tgn-reach.v1.<nodo>.<valor>` | `tgn-reach.v1.<node>.<challenge>` |
| `<URL pública>/healthz` | `<public URL>/healthz` |
| `wss://<URL pública>/m/<partida>` | `wss://<public URL>/m/<match>` |
| `tgn-replay.v1.PUT.<partida>.<sha256>.<marca de tiempo>` | `tgn-replay.v1.PUT.<match>.<sha256>.<timestamp>` |
| `node:<nodo>` | `node:<node>` |
| `lost:<motivo>` / `verification_failed:<motivo>` | `lost:<reason>` / `verification_failed:<reason>` |

The Spanish italic “*stale*” in 5.4 is the code's refusal value; write it as `stale` in monospace (“a clock-skew refusal (`stale`)”). Do not introduce any other code identifier that the Spanish paper does not already cite.

---

## C. Style decisions

1. **Language:** US English spelling (behavior, catalog, license, modeling, labeled, signaling, acknowledgment, canceled, gray, analyze). Formal register, no contractions, first-person plural “we” where the Spanish uses it (“Formalizamos” → “We formalize”). Present tense for system behavior. Singular “they” for players and operators. Avoid “etc.”; prefer “for example” over “e.g.”.
2. **Headings:** sentence case for all section, subsection, and appendix headings (only the first word, proper nouns, acronyms, and code names capitalized). The paper title (H1) is in title case, matching `build.json`. Bold run-in paragraph heads are sentence case and end with a period (“**Localizing a divergence.**”).
3. **Serial comma** always (“roles, transports, and capacity”). Lists that end in “; y” become “; and”.
4. **Quotation marks:** «…» → curly double quotes “…”; nested quotes ‘…’. Put periods and commas inside closing quotes only when they belong to the quoted text; otherwise outside (logical punctuation is acceptable in a technical paper because many quotes are literal strings). Literal code never goes in quotes, only in backticks.
5. **Theorem-like labels:** “**Lemma 1 (Title in sentence case).**”, “**Proposition 2.**”, “**Corollary.**”, “**Corollary (Title).**”; proofs start with “*Proof.*” in italics and end with `$\square$` exactly where the source has it.
6. **Cross-references:** capitalize the element type when it carries a number: “Section 6.5”, “Sections 6.3–6.5”, “Table 7”, “Figure 3”, “Appendix B”, “Equation (22)”, “Equations (9) and (13)”, “Lemma 1”, “Proposition 2”. Lowercase when generic (“this section”, “the next table”). Ranges of labels use an en dash: “Sections 6.3–6.5”, “T1–T11”, “S1–S3”. “la sección 14” → “Section 14”; “(ecuación (7), más adelante)” → “(Equation (7), below)”.
7. **Captions:** tables keep the source pattern, an italic paragraph after the table: `*Table 7. Transitions of the reputation state machine.*` When the caption contains code, close and reopen the italics around the backticks exactly as the source does. Figures: `Figure 1. …` inside `<figcaption>`, with `<em>` and `<sup>` markup preserved.
8. **Pull request:** “solicitud de cambios n.º 34” → “pull request #34” everywhere (prose, Table 10 caption, Table 17).
9. **Numbers:** decimal point (as in the source). Thousands separator only for numbers of five or more digits; four-digit numbers are written solid (2887, 3800, 8192). In math keep the source's `\,` exactly (`108\,000`, `604\,800\,000`). In prose and tables the source uses a space (“593 938 bytes”, “108 000 ticks”, “86 400”, “10 000”); use the same separator, preferably the narrow no-break space U+202F so that the number never breaks across lines (`build/numsep.py` lists the numbers that lack it). Appendix B's convention sentence becomes: “We use a decimal point, and a thin space as the thousands separator for numbers of five or more digits; four-digit numbers are written without a separator. Clock times are in milliseconds unless stated otherwise; ticks are integers.”
10. **Number words:** keep the source's choice between digits and words for counts (“three keys”, “12 matches”); always digits with units. Ordinals in words in prose (“the fifteenth concurrent match”), “5th” in figures.
11. **Percent:** no space in English: “95%”, “2.5%”, “±25%”, “~2.5%”. In display math keep whatever the source has.
12. **Units:** space between number and unit symbol: “120 Hz”, “8 s”, “24 h”, “4 ms”, “16 MiB”, “64 KiB”, “2.3 KB” (decimal kilobytes, as in the source), “188 MB”, “3800 GB”, “4.8 Mbit/s”, “400 kbit/s”, “0.45 GB/h”. Never “Mbps”. Prose may spell out minutes, hours, and days (“5 minutes”, “7 days”); tables and Appendix A may use “min”, “h”, “d”. Attributive number + symbol has no hyphen (“a 24 h cooldown”, “a 60 s window”); attributive number + spelled unit is hyphenated (“a three-minute match”, “a 24-byte single-use random challenge”, “a 32-bit hash”, “a 31-bit integer”). Money: “US$0.05 per GB”.
13. **Dates:** “21 October 2026” everywhere, prose and tables alike; title page “October 2026”; “el atasco del 21-10” → “the 21 October stall”.
14. **Match formats:** “1v1”, “2v2”, “3v3” everywhere in prose and tables (“uno contra uno”, “1 contra 1”, “tres contra tres”, “3 contra 3” all map here). “un tres contra tres con bots” → “a 3v3 with bots”; “uno contra uno contra bot” → “1v1 vs. bot”; “entre personas” → “between people”; “de uno contra uno a tres contra tres” → “from 1v1 to 3v3”.
15. **Ranges in prose:** “from 1 to 200”, “between 7.7 and 11.4 ms”; en dash allowed in tables (“1–200”) and for label ranges.
16. **Symbols:** keep ≈, ~, ±, ≤, ⇒, —, and the minus sign “−” exactly as the source uses them.
17. **Branches:** “the main branch” (plain text); “an unmerged branch” at first use, then “the unmerged branch”.
18. **Hyphenation:** re-simulate, re-simulation, single-use, one-time, open-source (adjective), control-plane (adjective), player-minute, least-loaded, worst-case (adjective), cross-machine (adjective), self-test, kill switch, worker thread, life cycle.

# Online: decisiones confirmadas (2026-10-14)

Registro de las decisiones de arquitectura para el modo online, tomadas a partir de dos informes de
investigación del mantenedor (hosting en Cloudflare y presupuesto de US$ 50 por mes; no forman parte
del repo). Las filas marcadas **(confirmada)** las eligió el mantenedor; el resto son los defaults
propuestos en los informes, que quedan vigentes salvo cambio explícito.

## Restricciones

| Restricción | Valor |
|---|---|
| Presupuesto total | **US$ 50 / mes**, tope duro (confirmada) |
| Escala | **25.000 cuentas registradas en total** (confirmada). Pico realista 1–5 % concurrentes = 250–1.250 jugadores, 33–167 partidas 3v3 simultáneas, 9.600–48.000 partidas-hora/mes |
| Jugadores iniciales | Argentina / Cono Sur / Brasil; NA y EU después |
| Fidelidad | Mismo RocketSim `.wasm` determinista a 120 Hz en cliente y en cualquier autoridad |

## Decisiones principales

| # | Decisión | Elegido |
|---|---|---|
| 1 | Topología casual (unranked, salas privadas) | **P2P con rollback determinista en malla de inputs** entre los 2–6 navegadores (estilo GGPO). Cero costo de servidor por partida. (confirmada) |
| 2 | Topología ranked | **Autoridad en servidor**: VPS en **São Paulo** (~~unos US$ 7/mes: Hostinger / Linode / Vultr~~ → **actualizada 2026-10-19**: comprado, con el precio real en el presupuesto de abajo; el proveedor y el plan, en las notas del mantenedor) para SAM; **Hetzner** (Ashburn o Falkenstein, ~US$ 6–12/mes) para NA/EU. Hetzner además corre el coturn de respaldo y el verificador de replays. (confirmada) |
| 3 | Transporte | **WebRTC DataChannel** `{ordered:false, maxRetransmits:0}` para inputs/estado + canal confiable para eventos; **fallback WebSocket** al mismo endpoint (DO o servidor vía proxy de Cloudflare). (confirmada) |
| 4 | Fases | **Fase 1**: autoridad en Durable Object + WebSocket para tener online en días y medir (RTT/jitter desde Argentina, jitter de `setInterval` en DO, determinismo por hash). **Fase 2**: P2P rollback en malla. **Fase 3**: VPS São Paulo + Hetzner (ranked, coturn, verificador). **Fase 4**: NA/EU, WebTransport, espectadores vía SFU. (confirmada) |
| 5 | Cuentas | ~~Solo invitados~~ → **actualizada 2026-10-15**: invitados para casual / salas / entrenamiento; **cuentas registradas** (usuario + contraseña, y Google / Discord cuando estén sus secretos) obligatorias para ranked y con MMR por playlist. Guardadas en un Durable Object con SQLite (`AccountsDO`) en vez de D1 (sin permisos ni recursos extra). Detalle: `ACCOUNTS.md`. (confirmada) |
| 6 | Plan Cloudflare | **Workers Paid desde el día uno** (US$ 5/mes). Como no hay tope de gasto nativo, las cuotas viven en el código (ver abajo). (confirmada) |
| 7 | Capa Cloudflare | Workers (API, señalización, tickets), Durable Objects (matchmaking por región, lobbies con Hibernation API, autoridad fase 1 y plan B), D1 (cuentas, MMR, resultados), R2 (replays ranked por inputs, 7–30 días), Turnstile, Cloudflare TURN (1.000 GB/mes gratis), hosting estático del cliente |

## Presupuesto mensual estimado

| Rubro | US$ / mes |
|---|---|
| Workers Paid (base) | 5 |
| Hetzner (NA/EU ranked + coturn + verificador) | 6–12 |
| VPS São Paulo (ranked SAM): 24 meses pagados por adelantado (US$ 210,96); renueva a US$ 14,99 / mes | 8,79 + impuestos (con tarjeta argentina, 21 % de IVA: ≈ 10,64) |
| Reserva para uso de Durable Objects (fase 1 y plan B) y TURN sobre los 1.000 GB gratis: lo que queda hasta el tope (con Hetzner en 12, 22; en 6, 28) | 22–28 |
| **Total** | **≤ 50** |

## Netcode (defaults de los informes)

- 120 Hz fijos, un input por jugador por tick; cliente y servidor con el mismo `.wasm` (`-msimd128` sí, `-mrelaxed-simd` no; sin `Math.random`/`Date.now` dentro del sim; RNG sembrado en el estado).
- **P2P (malla)**: delay de input fijo de 3 ticks (25 ms) en Cono Sur/Brasil, ventana de predicción 16 ticks (133 ms), 60 paquetes/s con 2 ticks por paquete y redundancia de todos los ticks no confirmados (~40 KB/s por jugador), timesync que frena al adelantado, hash de estado cada 30 ticks con NaN canonicalizado y voto por mayoría (minoría dos veces → resync, tercera → kick; 1v1 → partida anulada). Si se cae un peer, su auto pasa a la IA de equipo; reconexión con el estado de la mayoría en ≤ 15 s.
- **Servidor (ranked y fase 1)**: inputs cada tick con redundancia (120 pps en DataChannel, 30–60 pps batcheados sobre WebSocket), cliente adelantado RTT/2 + margen adaptativo + 1 tick, "predict everything" con rollback total, snapshots cuantizados ~180–200 B a 60 Hz (30 Hz hacia DO) + anchor float a 15 Hz, buffer de inputs en servidor objetivo 1–2 ticks (tope 8) con pedidos de acelerar/frenar ±2–5 %, suavizado visual 0,95/tick (0,85 si ≥ 1 m, snap > 2 m), clock sync de 4 timestamps.
- **Anti-trampas**: solo inputs viajan; rango y cadencia validados; en ranked, log de inputs + hashes a R2 y re-simulación en Hetzner (0,4–1,8 s de CPU por partido) antes de escribir el MMR.

## Matchmaking y región

- Bucket por `request.cf` + sondeo de RTT desde el cliente a cada autoridad candidata; salas P2P solo dentro del bucket con RTT máximo ≤ 60 ms; cross-bucket con advertencia y delay ≥ 5 ticks.
- Un Durable Object de matchmaking por región; tickets de partido HMAC `{sub, mid, team, slot, role, iat, exp 60–120 s, jti}` verificados en el Worker antes de tocar un DO o un servidor; viajan en `Sec-WebSocket-Protocol` / señalización, nunca en query string.

## Control de gasto (obligatorio: Cloudflare no tiene tope)

- Cuotas en el DO de matchmaking: TURN de Cloudflare 900 GB/mes (credenciales de 10 min emitidas solo con sesión + ticket y cuota disponible) → coturn propio en Hetzner → solo STUN; Durable Objects ≈ 1.900 partidas-hora/mes y **máximo 20 partidas concurrentes** en DO; VPS dentro de su egreso incluido.
- Cron Worker cada 5–15 min proyecta el gasto y flipea flags en KV (`p2p_only`, `turn_cf_disabled`, `turn_self_disabled`, `do_disabled`, `vm_disabled`, `matchmaking_off`).
- DOs de partida con TTL duro de 10 min, lobbies hibernables sin timers, `limits.cpu_ms` bajo, nada sin ticket crea un DO.
- Alertas de presupuesto de Cloudflare a US$ 15 / 30 / 45 + Usage Report a webhook + mails de tráfico de Hetzner, como respaldo (son informativas y llegan al día siguiente).
- Estado (oct 2026): el cron que proyecta el gasto todavía no existe; los interruptores son manuales (`matchmaking_off`, `do_disabled`, `vm_disabled` y `nodes_off`, que corta las rutas del plano de control de los nodos). Qué corta cada uno y qué sigue andando: `server/README.md`, «Kill switches». Los límites de pedidos por sesión, cuenta o red están en `server/src/limits.ts`.

## Mediciones pendientes (se obtienen en las fases 1 y 2)

1. RTT y jitter de WebSocket desde ISPs argentinos a un DO (MIA/EWR) y jitter de `setInterval` dentro del DO.
2. Hash de estado idéntico entre Chrome, Firefox y Safari tras 5 minutos de partida (define si la malla es el default o si el host-en-navegador pasa a serlo).
3. Fracción de enlaces WebRTC entre ISPs argentinos/brasileños que terminan en TURN (define si el nivel gratis alcanza).
4. Partidas por vCPU de Node + WebRTC en el VPS de São Paulo (define cuánto ranked entra).

## Para cuando haya más presupuesto

Latitude.sh Buenos Aires o GameLift sa-east-1 para ranked con egreso gratis; cuota de DO ampliada; OAuth; SFU de Cloudflare Realtime para espectadores; WebTransport; aplicar a Cloudflare for Startups (US$ 10.000) o Project Alexandria si el proyecto es OSS sin fines de lucro.

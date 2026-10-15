# Mediciones reales (fase 1, 2026-10-14)

Deploy: el Worker de desarrollo del mantenedor (Worker + Durable Objects + assets del
cliente, plan Workers Free al momento de medir). Cliente de medición: `server/test/smoke.mjs` corrido
desde una conexión residencial de fibra en Argentina con un token de
sesión firmado localmente (Turnstile está activo en el deploy, así que el guest no se crea desde node).

## Dónde cae cada cosa

| Qué | Dónde | Fuente |
|---|---|---|
| Edge (Worker, tickets, matchmaking) | colo argentino de Cloudflare | `GET /api/where` → `edgeColo` |
| Durable Object del partido | **MIA** (Miami) | `Welcome.hostColo` (trace desde adentro del DO) |

Confirma lo que decía la investigación: Workers corre local, el estado autoritativo vive en Norteamérica
(`sam` → ENAM). Un partido con autoridad en DO desde Argentina tiene el RTT de Argentina ↔ Miami.

## Netcode contra el DO en Miami (20 s de captura, 1v1 contra bot)

| Métrica | Valor |
|---|---|
| RTT WebSocket (81 pongs) | min 136,5 · **p50 139,0** · p90 145,2 · max 273,2 ms · jitter 5,6 ms |
| Tick rate del host | **120,0 Hz** (ticks 104 → 2508 en 20,0 s) |
| Snapshots | 602 en 20 s (30 Hz), 1422–1490 B cada uno |
| Intervalo entre snapshots (jitter de `setInterval` en el DO + transporte) | p50 32,1 · p90 40,2 · p99 69,4 · max 128,2 ms (nominal 33,3) |
| Inputs aplicados por el host | gap 0 (lastInputTick == tick) con lead final de 22 ticks |
| `bufferHint` (ticks de más que el cliente lleva) | moda +2; distribución: −8:20 −7:1 −6:2 −5:2 −4:1 −3:5 −2:16 −1:42 0:90 1:141 2:157 3:99 4:46 5:5 |
| Determinismo | **0 desyncs / 628 snapshots**: `stateHash()` del WASM local == `stateHash` del DO en todos |
| Ancho de banda | ~44 KB/s de bajada por cliente (snapshots completos sin cuantizar), ~2 KB/s de subida |

Línea resumen del smoke:

```
SUMMARY edge=<AR> host=MIA rtt_p50=139.0 rtt_p90=145.2 jitter=5.6 snap_p50=32.1 snap_p90=40.2 snap_max=128.2 hint_mode=2 desyncs=0
```

Comparación con las predicciones del informe: RTT estimado 135–150 ms → medido 139; el `setInterval`
del DO sostiene 120 Hz de promedio con picos de hasta 128 ms entre snapshots (3–4 snapshots juntos);
determinismo WASM entre V8 local y workerd confirmado.

## Referencia local (mismo código, `wrangler dev` en esta PC)

RTT p50 0,7 ms, snapshots p50 31,8 / p90 45,3 / max 48,1 ms, 303 snapshots en 10 s, 0 desyncs.

## Conclusiones para la fase 2

1. Con 139 ms de RTT el cliente necesita ~20 ticks de adelanto: jugable para casual, pero lejos de los
   ~30 ms que daría un servidor en São Paulo o el P2P dentro del Cono Sur. Confirma la decisión de
   P2P rollback para casual y servidor regional para ranked.
2. El `bufferHint` muestra ráfagas de −8 cuando el RTT pica (273 ms): el cliente queda corto de inputs
   y el host repite el último. Hay que suavizar el ajuste del lead ante picos aislados.
3. Los snapshots sin cuantizar cuestan 44 KB/s; con la cuantización de ~190 B bajan 7×.
4. Turnstile en modo "managed" mostró un desafío interactivo al navegador automatizado del panel; en un
   navegador normal pasa en modo "interaction-only" (a confirmar por el usuario).

## Camino de usuario real en el navegador (panel de la app, Argentina → DO en MIA, rAF forzado a 60 Hz)

Medido con el cliente completo (menú ONLINE → quick match 1v1 → bot) contra el deploy, Turnstile
desactivado (`TURNSTILE_DISABLED=1`, pre-producción):

| Métrica (panel F4 / `window.__game.online.stats`) | Valor |
|---|---|
| Ping / jitter / pérdida | **138,5 ms** / 1–9 ms / 0 % |
| Lead del cliente | 10–12 ticks (adj +0), rate 1,01–1,02× |
| Rollbacks / ticks re-simulados | ~30 por s (uno por snapshot) / 500–610 ticks por s |
| Desyncs / resyncs duros | **0** / 1 (el inicial) |
| `bufferHint` | 0 / +1 (el host recibe los inputs a tiempo) |
| Edad del snapshot al renderizar | 2–28 ms |
| Ancho de banda | 45 KB/s de bajada, 6,4 KB/s de subida |
| Respuesta del auto | acelera y se mueve con W + boost; 59 fps con el shim de rAF |

La re-simulación de 10–12 ticks por snapshot cuesta < 0,2 ms de CPU (RocketSim ~10 µs/tick), así que
el rollback a 139 ms de RTT es gratis en CPU; lo que se nota es la latencia de confirmación de los
golpes a la pelota, no el costo de cómputo.

## Fase 2 (P2P) en el deploy, 2026-10-15

Dos pestañas en la misma PC: 0 desyncs en 4300+ ticks, tráfico ~1,6 KB/s por sentido por par (25× menos
que los snapshots de la fase 1), señalización contra el RoomDO a 138 ms. Detalle en `PHASE2.md`.
El Durable Object de la fase 1 cayó esta vez en **ATL** (Atlanta): RTT p50 155 ms, p90 308 ms, jitter 42 ms.

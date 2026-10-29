# El VPS de São Paulo

> Estado al 21/10/2026: el nodo `sao-paulo-1` está instalado y activo, con los roles de host y
> verificador, y recibe partidas de todos los jugadores (`nodes_on` en `1`, después del canary de
> M15 en `PRODUCCION.md`). Este documento es el manual de la máquina. El orden del trabajo que
> falta está en `PRODUCCION.md`, etapa 1; los números de PR ([1] a [8]) y de acción (M1 a M16) son
> los de esa lista.
>
> Es un documento público: no lleva las direcciones de la máquina, su proveedor ni su plan, los
> nombres de las claves, los usuarios, los topes de tráfico y de partidas que tiene puestos ni los
> horarios de mantenimiento. Esos datos viven fuera del repo, con el mantenedor. Donde un comando
> los necesita, dice `<host>` (el nombre público del nodo), `<clave>`, `<tope-gb>` o `<n>`.

## Qué hace

- **Verificador de confianza.** Re-simula las partidas que se verifican antes de que se escriba
  un rating: todas las ranked y una muestra de las casuales de los nodos comunitarios. Sus propias
  casuales nunca se verifican (`control-plane/controlPlane.ts:1011`). En la etapa 1 es el único
  verificador, así que verifica sus propias ranked (`control-plane/scheduler.ts:96`). La
  re-simulación cede el control cada medio segundo de juego (`shared/verify.ts:52`), así que las
  partidas que hostea al mismo tiempo siguen fluidas; comparten la CPU.
- **Primer servidor ranked de Sudamérica.** Al ser del proyecto, pasa a activo apenas el plano de
  control comprueba que llega a él, sin las 20 partidas de prueba
  (`control-plane/registry.ts:371-372`).

Los nodos del proyecto no ganan puntos de anfitrión y una verificación fallida no los pausa: solo
anula la partida y deja un `ALERT` en el log.

## La máquina

Un VPS Linux (Ubuntu LTS) cerca de São Paulo, con 2 vCPU x86_64. El proveedor, el plan, las
direcciones, la transferencia que incluye y el contrato están en las notas privadas del
mantenedor. Lo que importa para operarlo:

- **El panel del proveedor es root.** Puede agregar claves SSH y abrir una terminal en el
  navegador. La cuenta del proveedor (y su correo) tiene que llevar verificación en dos pasos y
  aviso de inicio de sesión.
- **Si la CPU del plan tiene créditos** (una base por vCPU cuando se acaban), la capacidad
  declarada tiene que contar con esa base: ver `--matches` más abajo.
- **La transferencia del plan** decide `--egress-cap-gb` (D19).

## Acceso

- SSH como `root`, solo con clave Ed25519; el acceso por contraseña está apagado. La clave vive
  en la PC del mantenedor. Si no tiene frase de paso, ponle una y cárgala en el agente de SSH: con
  root en esta máquina se controla el verificador de confianza.
- **Pendiente:** limitar SSH a la IP del mantenedor o a una VPN (WireGuard o Tailscale). Hoy el
  puerto de SSH acepta conexiones de cualquier dirección, con fail2ban delante.

```bash
ssh -i <clave> root@<host>
```

- Si la clave se pierde: el panel del proveedor puede agregar otra.
- En Windows, con la ruta completa: Windows PowerShell no expande `~` en los argumentos, y
  `ssh-keygen` tampoco (`ssh -i` sí). El servicio `ssh-agent` viene desactivado: la primera línea
  va en un PowerShell de administrador.

```powershell
Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent
ssh-keygen -p -f "$env:USERPROFILE\.ssh\<clave>"
ssh-add "$env:USERPROFILE\.ssh\<clave>"
```

- Un usuario sin privilegios tiene una copia del repo para pruebas y benchmarks. No es parte de la
  instalación ni corre servicios. La usan la prueba de CPU bajo carga (ver "Antes de instalar el
  nodo") y la prueba de determinismo de la ventana de mantenimiento: si se borra, esa prueba pide
  clonar el repo de nuevo.

## Endurecimiento aplicado

| Qué | Dónde | Configuración |
|---|---|---|
| Sistema al día | — | `apt-get full-upgrade` y un reinicio para el kernel nuevo |
| Actualizaciones automáticas | `/etc/apt/apt.conf.d/52turbogol-unattended` | Las de Ubuntu por defecto (seguridad y actualizaciones de la distribución), con `Unattended-Upgrade::Automatic-Reboot "false"`, `Remove-Unused-Kernel-Packages "true"` y `Remove-Unused-Dependencies "true"`. La máquina nunca se reinicia sola: un reinicio corta partidas |
| needrestart | `/etc/needrestart/conf.d/turbogol.conf` | `$nrconf{override_rc}{qr(^caddy)} = 0;` y lo mismo con `^turbogol-node`: reiniciar Caddy corta el WebSocket de todos los jugadores, y parar el nodo espera a que terminen sus partidas |
| Swap | `/swapfile` en `/etc/fstab`, `/etc/sysctl.d/60-turbogol.conf` | `vm.swappiness=10`. Es una red de seguridad, no capacidad |
| Logs | `/etc/systemd/journald.conf.d/turbogol.conf` | Un tope de tamaño (`SystemMaxUse`) |
| fail2ban | `/etc/fail2ban/jail.d/turbogol.local` | Jaula `sshd` sobre el journal (`backend = systemd`) |
| Firewall (ufw) | — | Entrada denegada por defecto; abiertos solo SSH, HTTP (el desafío ACME y la redirección) y HTTPS (jugadores, wss y el chequeo de alcance del plano de control), en IPv4 e IPv6. Ningún puerto UDP: el transporte wss no lo usa |
| SSH | `/etc/ssh/sshd_config.d/00-turbogol.conf` | `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`, `MaxAuthTries 3`, `X11Forwarding no` |
| Node.js | NodeSource | Node 24, el mismo camino que usa `install/install.sh` |
| Caddy | Repositorio oficial | Retenido con `apt-mark hold`, como Node (ver "Después de instalar") |

Dos detalles del SSH:
- El archivo se llama `00-` a propósito: sshd se queda con el primer valor que lee, y la imagen trae
  `50-cloud-init.conf` con `PasswordAuthentication yes`.
- En Ubuntu 26.04, `sshd -t` falla con "Missing privilege separation directory: /run/sshd" hasta
  que ese directorio existe (el servicio arranca por socket). Créalo antes de probar la
  configuración: `install -d -m 0755 /run/sshd`.

## DNS y TLS

- `<host>`: un registro A y uno AAAA en la zona del juego, los dos **solo DNS**, sin el proxy de
  Cloudflare. Hace falta un nombre porque el chequeo de alcance corre en el Worker, y un Worker no
  puede hacer `fetch` a una IP. Pasarlo por el proxy es una decisión pendiente (D4 en
  `PRODUCCION.md`).
- Caddy sirve `<host>` con un certificado de Let's Encrypt del perfil por defecto, de 90 días, que
  renueva solo, y lo pasa al puerto local del nodo (`127.0.0.1:7350`, el de `install/install.sh`).
  HTTP/3 está apagado con la opción global `servers { protocols h1 h2 }`, porque UDP 443 está
  cerrado.

## Mediciones (19/10/2026)

| Qué | Resultado |
|---|---|
| Pruebas de `nodes/` | Todas pasan en el VPS |
| Determinismo entre máquinas (`nodes/scripts/xmachine.mjs`) | 12 partidas completas de 3 minutos (1v1, 2v2 y 3v3; humanos simulados por las pruebas, bots fáciles, medios y difíciles, una toma de control por un bot y un lugar inactivo), grabadas en la PC del mantenedor (Windows 11) y en el VPS (Linux), las dos con el mismo V8. El mismo hash de estado final, el mismo marcador y el mismo tick final en las dos; cada máquina verifica los 12 replays de la otra |
| Verificación | Un 3v3 de 3 minutos con bots, alrededor de 1 s en el VPS |
| Tamaño de los replays | De 2,3 a 2,8 KB si solo juegan bots (no se graban: se recalculan); de 60 a 403 KB con humanos simulados |
| Capacidad | El benchmark (`node/main.ts bench`) y las partidas reales del 21/10/2026 decidieron `--matches` con la fórmula de más abajo. Las cifras de la máquina quedan en las notas del mantenedor |

## Antes de instalar el nodo

1. **El plano de control en el Worker, con su estado guardado:** los PR [1] (#23) y [6] (#28)
   desplegados. Antes del deploy de #28, `https://turbo-gol.com/nodes/releases/launcher.mjs`, lo
   primero que baja el instalador (`install/install.sh:108`), devuelve el `index.html` del juego:
   `/nodes/*` no está en `run_worker_first` (`server/wrangler.jsonc:49`) y el Worker manda al sitio
   todo lo que no empieza con `/api/` (`server/src/index.ts:649`). Y el estado tiene que vivir en
   el SQLite del `NodeRegistryDO` ([6], #28): si no, el próximo deploy olvidaría el VPS registrado.
2. **La release 0.2.0,** firmada con la clave de producción, y el canal en 0.2.0: los PR [2] (#24)
   y [5] (#27), y las acciones M5 a M10.
3. **La cuenta del proyecto en `NODE_TRUSTED_OPERATORS`** (M4 y M7). Sin eso, el
   `POST /nodes/tokens` de M11 responde 403 `not_trusted` (P20), y el registro tampoco aceptaría
   `--roles host,verify`: falla con `verify_reserved` (`control-plane/registry.ts:205-207`). No
   juegues ranked con esa cuenta: el scheduler nunca pone una ranked en el nodo de un operador que
   la juega (`control-plane/scheduler.ts:57`), y la partida cae en un `MatchDO` sin aviso.
4. **Comprobar lo publicado.** En el VPS por SSH, o en cualquier Linux:

```bash
curl -fsS https://turbo-gol.com/nodes/releases/channel                                     # {"stable":"0.2.0","minimum":"0.2.0"}
curl -fsS https://turbo-gol.com/nodes/releases/install.sh | grep -c __RELEASE_PUBLIC_KEY_  # 0
curl -sI https://turbo-gol.com/nodes/releases/0.2.0/rocketsim.wasm                         # content-type: application/wasm
getent ahosts <host>                                                                        # las dos direcciones del VPS
```

   En la PC del mantenedor, con PowerShell: `curl.exe`, porque en Windows PowerShell `curl` es
   otro comando, y sin `grep` ni `getent`.

```powershell
curl.exe -fsS https://turbo-gol.com/nodes/releases/channel
(curl.exe -fsS https://turbo-gol.com/nodes/releases/install.sh | Select-String -SimpleMatch __RELEASE_PUBLIC_KEY_).Count   # 0
curl.exe -sI https://turbo-gol.com/nodes/releases/0.2.0/rocketsim.wasm
Resolve-DnsName <host>
```

   En la segunda línea, un instalador armado sin la clave da 2: sus marcadores
   (`RELEASE_KEY_B64URL` y `RELEASE_KEY_PEM`). Buscar solo `__RELEASE_` no sirve: las líneas que
   rechazan esos marcadores quedan en el instalador armado y dan 2 aunque esté bien.
5. **La CPU bajo carga sostenida,** antes de instalar, porque el resultado decide `--matches`:
   con `stress-ng --cpu 1 --cpu-load 100 --timeout 40m` corriendo (`apt-get install stress-ng`),
   repite el benchmark cada pocos minutos y mira la columna `st` de `vmstat 5`. Si los
   milisegundos por segundo de partida suben, los créditos de CPU del plan frenan la máquina:
   declara menos partidas. Si no suben, el 0,6 de D20 sobra (ver `--matches` más abajo).

```bash
su - <usuario de pruebas> -c 'cd ~/turbo-gol/nodes && node --expose-gc --import ./dev/ts-resolve.mjs node/main.ts bench --seconds 30'
```

## Instalar el nodo

El token lo genera el mantenedor justo antes (M11), en la consola de una pestaña de turbo-gol.com
con la sesión de la cuenta del proyecto iniciada. La línea refresca la sesión, que trae el Bearer
en `session` (`server/src/accountRoutes.ts:182`); tiene que correr en esa pestaña porque la cookie
es SameSite=Strict (`:263-272`). Después pide el token:

```js
const s = await (await fetch('/api/auth/refresh', { method: 'POST' })).json(); await (await fetch('/nodes/tokens', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.session }, body: JSON.stringify({ region: 'SA', name: 'sao-paulo-1' }) })).json()
```

El token vence en una hora y sirve una sola vez (`control-plane/registry.ts:28`). Después, como
root en el VPS:

```bash
curl -fsSL https://turbo-gol.com/nodes/releases/install.sh -o /tmp/turbogol-install.sh
grep -E '^RELEASE_KEY_B64URL=' /tmp/turbogol-install.sh   # la misma clave que nodes/release-key.pub
mv /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-turbogol   # el de hoy, escrito a mano
bash /tmp/turbogol-install.sh --control https://turbo-gol.com --token '<tgn1_...>' --name sao-paulo-1 \
  --roles host,verify --transport wss --public-host <host> --egress-cap-gb <tope-gb> --matches <n>
```

- **`--roles host,verify`:** hostea y verifica. Los roles se fijan al registrar: cambiarlos pide
  un token nuevo.
- **`--public-host <host>`:** sin esto, el instalador registra la IPv4 que ve `/nodes/whoami`, y
  el chequeo de alcance nunca pasa: un Worker no puede pedir una IP. Nunca le pongas un puerto:
  todo lo que tiene `:` se toma como IPv6.
- **`--egress-cap-gb <tope-gb>`:** el nodo cuenta lo que mandan las partidas que terminan
  (`node/runtime.ts:514-519`), por mes calendario UTC (`:617-620`), y el scheduler deja de
  mandarle partidas al 95 % del tope (`control-plane/scheduler.ts:55`). El tope tiene que dejar
  que dos meses UTC parciales entren en la transferencia mensual del plan, aunque el mes del
  proveedor empiece otro día (D19).
- **`--matches <n>`:** la capacidad declarada (D20): `floor(cpu × 0,6 / 2)`, con el `cpu` más
  conservador del benchmark. Ese `cpu` ya cuenta con el 60 % de un núcleo (600 ms de CPU por
  segundo, `node/bench.ts:77`), para dejar margen. El 0,6 extra es por los créditos de CPU: si se
  acaban, el plan deja cada vCPU en su base, y con el 0,6 las partidas siguen entrando en lo que
  queda. El 2, porque la verificación corre en el mismo hilo que las partidas
  (`node/runtime.ts:540-567`) y cuesta otra simulación por ranked. Si la prueba de CPU bajo carga
  no muestra freno, `floor(cpu / 2)`. Las partidas reales cuestan más que el benchmark (la red no
  entra en él): compáralo con una partida de verdad antes de subirla. Para cambiarla después, ver
  "Cambiar la capacidad declarada".
- **El `mv` del Caddyfile:** Node 24 y Caddy ya están y el instalador no los vuelve a instalar,
  pero Caddy pasa a ser del nodo: el instalador escribe su propio `/etc/caddy/Caddyfile` en cada
  corrida (sin HTTP/3, con un certificado de 90 días para el nombre y `stream_close_delay`, para
  que recargar Caddy no corte partidas). Antes de gastar el token se detiene si encuentra un
  Caddyfile que no escribió él, como el que se escribió a mano el 19/10/2026: por eso el `mv`.

### Lo que pasó en la instalación del 20/10/2026

El instalador de la release 0.2.0 registró el nodo con el nombre "Ubuntu": después de leer
`--name`, cargaba `/etc/os-release`, que define su propia variable `NAME` (el nombre de la
distribución). El instalador del repo ya lo corrige; el publicado en R2 lo trae la próxima
release. Como no había partidas, el VPS se registró de nuevo con otro token, llamando al lanzador
a mano (el nodo detenido y su primer `node.json` apartado):

```bash
runuser -u turbogol -- node /opt/turbogol-node/launcher.mjs register --control https://turbo-gol.com \
  --data /var/lib/turbogol-node --token '<tgn1_...>' --roles host,verify --transport wss \
  --public-url wss://<host> --name sao-paulo-1 --matches <n>
```

El registro "Ubuntu" quedó `banned` con `/nodes/admin/status`: no recibe partidas ni alertas, pero
cuenta para el tope de 2 nodos de la cuenta del proyecto.

## Después de instalar

```bash
systemctl status turbogol-node caddy
journalctl -u turbogol-node -n 50
curl -s 'https://<host>/healthz?nonce=abcdefghijklmnop1234' | jq
apt-mark hold nodejs caddy
```

- En el log tienen que aparecer `listening on 127.0.0.1:7350`, después
  `connected to the control plane: pending, region SA, stable 0.2.0` y después `status active`,
  cuando el plano de control comprueba que llega al nombre. Si el primer chequeo falla, lo repite
  cada 30 s mientras el nodo siga conectado (`control-plane/controlPlane.ts:77`, `:1192-1196`).
- `/healthz` con `nonce` responde `ok`, `nodeId`, `version`, `active`, `capacity`, `draining` y
  la firma del nonce (`node/runtime.ts:366-377`).
- Con la sesión de la cuenta del proyecto, `GET /nodes/mine` muestra `sao-paulo-1` activo.
- `apt-mark hold`: Node y Caddy cambian solo cuando lo decides tú, en la ventana de mantenimiento.
  Una actualización de Caddy lo reinicia y corta todas las partidas. Retenidos, no reciben los
  parches de seguridad solos: la ventana de mantenimiento los revisa.

## Respaldos

- **`/var/lib/turbogol-node/node.json`:** la identidad del nodo, con su clave privada. Cópiala tú
  al gestor de contraseñas apenas termine la instalación (por ejemplo, con `cat` por SSH y pegar),
  sin dejar una copia en el disco de la PC, y toma una instantánea del VPS en el panel del
  proveedor.
- **Si se pierde la máquina:** en la nueva (o en la misma reinstalada), con `<host>` ya apuntando
  a ella, el comando de "Instalar el nodo" con `--restore node.json` en lugar de `--token` instala
  la identidad respaldada sin registrar nada. Sin la copia, hay que registrar la máquina de nuevo
  con otro token, y vuelve como un nodo nuevo.
- **`/var/lib/turbogol-node/egress.json`:** el contador de tráfico del mes. Una copia vieja
  restaurada cuenta de menos.
- El respaldo periódico del proveedor cubre el resto del disco.

## Operación

### Mirar

- `journalctl -u turbogol-node -f`
- `curl -s https://<host>/healthz | jq '{ok,version,active,capacity,draining}'`
- Las líneas `ALERT` del plano de control: van solo al log (en el Worker, desde el PR [6]); el
  webhook a Discord llega con el PR [8].

### Drenar y apagar

- **Apagar sin cortar partidas:** `systemctl stop --no-block turbogol-node`. El nodo deja de tomar
  partidas, termina las que tiene, las reporta y sale. Puede tardar hasta 30 minutos
  (`TimeoutStopSec=1800`, `install/install.sh:182`). Cuando termina, el log dice
  `drained: stopping`. Queda parado hasta un `systemctl start turbogol-node` o un reinicio.
- **Cortar ya, mientras ese `stop` espera:** `systemctl kill turbogol-node`. Es el segundo pedido
  de apagado: el lanzador le pide al nodo que pare en el acto (`node/launcher.ts:366-371`). El
  servicio no vuelve a arrancar: el lanzador sale con 0 y la unidad tiene `Restart=on-failure`
  (`install/install.sh:169-171`). No hace falta `-s SIGKILL`.
- **Un drenaje pedido por el plano de control no tiene vuelta atrás** (`node/runtime.ts:570-575`):
  para que el nodo vuelva a tomar partidas, `systemctl restart turbogol-node`. La ruta de
  mantenedor para drenar llega con el PR [8].

### Ventana de mantenimiento

Las actualizaciones automáticas instalan los parches de seguridad pero nunca reinician, y
needrestart no reinicia ni Caddy ni el nodo: los cambios de kernel y de bibliotecas llegan en esta
ventana, a una hora tranquila:

1. `systemctl stop --no-block turbogol-node` y esperar `drained: stopping`.
2. `apt-get update && apt-get full-upgrade`. Node y Caddy siguen retenidos; para actualizarlos a
   propósito, `apt-mark unhold nodejs caddy`. Después de cambiar Node, repetir la prueba de
   determinismo entre máquinas antes del paso 3. Pide una copia del repo al día en el VPS: la del
   usuario de pruebas después de un `git pull`, o una nueva si se borró. Desde su `nodes/`,
   `npm run xmachine -- record <carpeta>` compara con la referencia del 19/10/2026; si el juego
   cambió desde entonces, esa comparación no sirve: grabar también en la PC del mantenedor y
   verificar cada carpeta en la otra máquina (`verify <carpeta>`).
3. `reboot`. El servicio arranca solo.
4. `journalctl -u turbogol-node -n 20`: tiene que volver a `status active`.

### Cambiar la capacidad declarada

Volver a correr el comando de "Instalar el nodo" con otro `--matches` (o `--matches auto`, para
volver al benchmark), sin token y sin el `mv`. Con `node.json` presente es una actualización:
reescribe la unidad y reinicia el servicio, que primero drena sus partidas (hasta 30 minutos): a
una hora tranquila.

### Interruptor de emergencia

Con el gancho del matchmaker desplegado (PR [7]), el flag `vm_disabled` de KV manda todas las
partidas nuevas a `MatchDO` sin tocar el VPS. Desde `server/`:

```bash
npx wrangler kv key put vm_disabled 1 --binding FLAGS --remote
npx wrangler kv key delete vm_disabled --binding FLAGS --remote   # para volver
```

Tarda unos 2 minutos: la propagación de KV más los 60 s de `cacheTtl` con que el Worker lee los
flags (`server/src/index.ts:176`). Las partidas que ya corren en el VPS siguen. Hoy ningún código
lee ese flag, y el cron de gasto que lo prendería (`docs/online/DECISIONS.md`) no existe: es un
interruptor manual. Para salir de un problema, usa este flag y no un rollback del Worker por debajo
del PR [7]: los jugadores con un lock de partida de nodo quedarían atascados hasta que venza, unos
13 minutos.

### Si se cae

- Sus partidas en curso se anulan sin penalizar a los jugadores si no vuelve en unos 60 s: todo
  nodo, del proyecto o comunitario, tiene 60 s sin heartbeat para reconectarse y conservarlas
  (`NODE_OFFLINE_MS` en `control-plane/controlPlane.ts`), más el intervalo del barrido. A los 15 s
  sin heartbeat deja de recibir partidas. A los 30 s el plano de control cierra su conexión (4408)
  y anota en el log cuántos segundos estuvo callado: desde ahí le quedan de 25 a 30 s para
  reconectarse. Los 60 s se cuentan por partida y en total, así que un corte anterior en la misma
  partida se descuenta. El nodo suma un strike, pero un nodo del proyecto no se pausa.
- Las ranked de Sudamérica vuelven a `MatchDO`, como hoy, mientras no haya otro verificador: una
  ranked solo va a un nodo si alguien puede re-simularla (`control-plane/controlPlane.ts:637`).
- Las partidas terminadas esperan su verificación hasta 6 horas
  (`control-plane/controlPlane.ts:81`) y después se anulan sin penalizar a nadie. Eso vale solo
  cuando el plano de control guarde su estado (PR [1]): hoy un deploy del Worker las borraría.
- Más adelante conviene un segundo verificador de confianza. `docs/online/DECISIONS.md` lo pone
  en Hetzner, Ashburn o Falkenstein.

## Probarlo con jugadores

Las pruebas antes de abrir la beta están en `PRODUCCION.md`. Para todas:
- Juega con dos cuentas que no sean la del proyecto (ver "Antes de instalar el nodo", paso 3).
- La casual, con la conexión en "Servidor". Una sala P2P nunca llega a un nodo, pero un jugador
  solo en la cola P2P, pasada la espera, juega en el servidor contra bots
  (`server/src/MatchmakerDO.ts:1028-1041`) y puede caer en el VPS.
- En la partida, `hostColo` tiene que decir `node:sao-paulo-1`. Hoy no aparece en ninguna
  pantalla: míralo en la consola del navegador con `window.__game.online.welcome.hostColo`
  (`src/game/Game.ts:672`). El PR [3] lo suma al panel de red.

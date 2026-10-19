# Levantar el VPS de São Paulo

Este VPS cumple dos funciones:

- **Verificador de confianza.** Re-simula las partidas de la comunidad que se verifican (todas
  las ranked y una muestra de las casuales) antes de que se escriba un rating o se den puntos. El tiempo crece con el largo de la partida y con los bots: menos de
  medio segundo de CPU para un 1v1 de 3 minutos y unos 2 segundos para un 3v3 de 3 minutos con
  bots. Verifica todas las ranked y solo una muestra de las casuales.
  La re-simulación cede el control cada medio segundo de juego, así que las partidas que el VPS
  hostea al mismo tiempo siguen fluidas; comparten la CPU.
- **Primer servidor ranked de Sudamérica.** Al ser del proyecto, entra directo como activo, sin
  las 20 partidas de prueba.

Los nodos del proyecto no ganan puntos de anfitrión.

## Antes de empezar

1. **La integración tiene que estar desplegada.** Hoy el plano de control solo corre como
   servidor de referencia (`nodes/control-plane/devServer.ts`). Hasta aplicar `INTEGRACION.md`, el
   VPS no tiene a qué conectarse.
2. **Marcar la cuenta del proyecto como de confianza.** En el Worker, la variable
   `NODE_TRUSTED_OPERATORS` lleva el id de la cuenta con la que vas a registrar el VPS. Todo nodo
   de esa cuenta es de confianza. En la primera beta, solo esas cuentas pueden crear tokens.
3. **Publicar la release del nodo.** El instalador baja el programa de
   `turbo-gol.com/nodes/releases/`. Ver `PRODUCCION.md`, etapa 1.
4. **Darle un nombre.** Un Worker de Cloudflare no puede pedir una IP pura, así que el chequeo de
   alcance necesita un nombre, por ejemplo `sp1.turbo-gol.com`. Creá el registro DNS apuntando a
   la IP del VPS antes de instalar. Con o sin el proxy de Cloudflare: ver `PRODUCCION.md`.

## Elegir el servidor

| Qué | Recomendación |
|---|---|
| Proveedor | Uno con región São Paulo, por ejemplo Vultr o Akamai / Linode |
| Plan | 2 vCPU y 4 GB para empezar. `docs/online/DECISIONS.md` le asigna US$ 7 por mes: confirmá el precio en São Paulo. Si la comunidad crece, conviene separar: un VPS que hostea y otro que solo verifica |
| Sistema | Debian 12 o Ubuntu 24.04, con IPv4 pública |
| Transferencia | Mirá lo incluido por mes. Un 1v1 usa 0,32 GB por hora y un 3v3 1,95 GB por hora |
| Firewall del proveedor | TCP 80 y 443 abiertos, para el certificado y los jugadores |

## Instalarlo

1. Con la cuenta del proyecto, generá un token para la región **Sudamérica** y el nombre
   `sao-paulo-1`: en la página "Poner un servidor" cuando exista, y mientras tanto con
   `POST /nodes/tokens` y la sesión de esa cuenta. Vence en una hora y sirve una sola vez.
2. Conectate al VPS por SSH y corré la línea de instalación **con estas opciones**:
   - `--roles host,verify`, para que además de hostear verifique. Los roles se fijan al
     registrar: no se pueden agregar después sin un token nuevo.
   - `--public-host sp1.turbo-gol.com`, el nombre del paso 4 de "Antes de empezar". Sin esto, el
     instalador registra la IP y el chequeo de alcance nunca pasa.
   - `--egress-cap-gb` con la transferencia mensual incluida en el plan, para no pasarse.

   Si preferís el cloud-init, esas opciones van **adentro** de la línea de `runcmd`, antes de la
   comilla que la cierra; agregadas al final del archivo no hacen nada.

```bash
curl -fsSL https://turbo-gol.com/nodes/releases/install.sh | sudo bash -s -- --control https://turbo-gol.com --token <token> --name sao-paulo-1 --roles host,verify --public-host sp1.turbo-gol.com --egress-cap-gb <GB>
```

3. El instalador pone Node 24 y Caddy, verifica la firma del programa, registra la máquina y la
   deja como servicio. Caddy saca solo el certificado de Let's Encrypt para el nombre.

## Comprobar que anda

```bash
journalctl -u turbogol-node -f
```

A los pocos segundos tiene que aparecer `status active`, cuando el plano de control comprueba que
llega al nombre. Con la sesión de la cuenta del proyecto, `GET /nodes/mine` (o la página "Mis
servidores", cuando exista) muestra `sao-paulo-1` activo y con la etiqueta "proyecto".

```bash
curl -s https://sp1.turbo-gol.com/healthz
```

Tiene que responder un JSON con `"ok": true`.

## Cuidarlo

- **Copia de seguridad de `/var/lib/turbogol-node/node.json`.** Tiene la clave del nodo. Si se
  pierde, hay que registrar la máquina de nuevo con otro token.
- **Actualizaciones:** son automáticas. El nodo termina las partidas en curso, se actualiza y
  vuelve solo.
- **Apagarlo:** `systemctl stop turbogol-node` deja de aceptar partidas, espera a que terminen las
  que están en curso (hasta 30 minutos) y no vuelve a arrancar solo. Para cortar ya, mientras ese
  `stop` espera: `systemctl kill -s SIGKILL turbogol-node`. Ojo: `systemctl kill` sin
  `-s SIGKILL` solo pide drenar, y como no es un `stop`, systemd vuelve a arrancar el servicio.
- **Si una verificación de sus propias partidas falla:** el VPS es del proyecto y no se pausa. El
  log del plano de control muestra un `ALERT`: es un error de determinismo que hay que revisar.

## Probarlo con jugadores

Jugá con dos cuentas que no sean la que registró el VPS: si juega el operador, el scheduler no usa
su nodo y la ranked cae en un servidor de Cloudflare sin aviso. La casual, con la conexión en
"Servidor": el P2P nunca llega a un nodo. En el `Welcome`, `hostColo` tiene que decir
`node:sao-paulo-1`.

## Si se cae

- Las partidas de la comunidad terminadas quedan en cola de verificación hasta 6 horas. Si vuelve
  antes, se verifican y se califican normalmente. Si no, se anulan sin penalizar a nadie.
- Las partidas ranked de Sudamérica vuelven a jugarse en Cloudflare, como hoy, mientras no haya
  otro nodo activo.
- Conviene un segundo verificador de confianza más adelante. `docs/online/DECISIONS.md` ya lo
  pone en Hetzner, Ashburn o Falkenstein.

#!/usr/bin/env bash
# Turbogol community node installer for desktops and laptops: macOS or Linux, run as your own user
# (never root). The machine hosts matches over WebRTC: no open ports, no TLS, no Caddy, nothing to
# forward on the router.
#
#   curl -fsSL <control>/nodes/releases/install-desktop.sh | bash -s -- --control <url> --token <tgn1_...>
#        [--name <name>] [--uplink-mbps <n>] [--rtc-ports <from>-<to>] [--insecure]
#   curl -fsSL <control>/nodes/releases/install-desktop.sh | bash -s -- --uninstall
#
# What it does (and nothing else):
#   1. checks that Node.js >= 24 is already installed (it never installs system packages)
#   2. one folder in your home, with app/ (the launcher) and data/ (keys, releases, state, node.log):
#        macOS  ~/Library/Application Support/TurbogolNode
#        Linux  ${XDG_DATA_HOME:-~/.local/share}/turbogol-node
#   3. downloads the launcher and checks its Ed25519 signature, with Node itself, against the release
#      key baked into this file by scripts/build-node.mjs (never fetched from the network)
#   4. registers the machine with the one-time token (the node key is generated here and stays here)
#   5. auto-start as your user, running the launcher (auto-update, drain on stop, rollback):
#        Linux  systemd user unit ~/.config/systemd/user/turbogol-node.service
#        macOS  LaunchAgent ~/Library/LaunchAgents/com.turbogol.node.plist
#
# Portable to macOS's bash 3.2: no associative arrays, no mapfile, no ${var,,}, and arrays that can be
# empty are expanded as ${a[@]+"${a[@]}"} (bash < 4.4 treats an empty "${a[@]}" as unset under -u).
# Everything runs inside main(), called on the last line, so a truncated download runs nothing, and
# curl and node get stdin from /dev/null so they cannot eat the rest of a piped script.
set -euo pipefail

# Filled in by scripts/build-node.mjs from the release key (never fetched from the network).
RELEASE_KEY_B64URL="__RELEASE_PUBLIC_KEY_B64URL__"
RELEASE_KEY_PEM="__RELEASE_PUBLIC_KEY_PEM__"

LABEL=com.turbogol.node
UNIT_NAME=turbogol-node.service
# How long a stop may take. Stopping sends SIGTERM to the launcher (systemd: to the node as well);
# it asks the node over IPC to drain (no new matches, exit when the last one ends: a match length
# plus its 10 min TTL at most), then exits 0 and starts nothing else, so the service stays
# stopped. A second SIGTERM to the launcher stops the node at once; after this long systemd /
# launchd SIGKILL what is left.
STOP_TIMEOUT=1800

TOKEN_RE='^tgn1_[A-Za-z0-9_-]{20,64}$'
KEY_RE='^[A-Za-z0-9_-]{43}$'
CONTROL_RE='^https?://(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*$'
UPLINK_RE='^[0-9]{1,6}([.][0-9]{1,3})?$'
PORTS_RE='^([0-9]{4,5})-([0-9]{4,5})$'

# Options.
CONTROL=""; TOKEN=""; NAME=""; UPLINK=""; RTC_PORTS=""; INSECURE=0; UNINSTALL=0
# Set by detect_platform / find_node.
OS=""; BASE=""; APP=""; DATA=""; LOG=""; UNIT=""; PLIST=""; IS_WSL=0
NODE_BIN=""; NODE_VERSION=""; NODE_MANAGED=0
# on = the service is running (or will at next login); manual = the user has to start it.
AUTOSTART=on
CURL_PROTO="=https"
TMP_DIR=""
RUN_CMD=()

# Checks the launcher's signature. Inputs come only from the environment (never interpolated into
# the code). Exit codes: 0 valid, 1 signature does not verify, 2 could not read a file, 3 bad key.
VERIFY_JS='
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
const env = process.env;
let key;
try {
  key = createPublicKey(env.TGI_KEY_PEM);
} catch {
  process.exit(3);
}
const spki = key.export({ format: "der", type: "spki" });
if (key.asymmetricKeyType !== "ed25519" || spki.subarray(spki.length - 32).toString("base64url") !== env.TGI_KEY_RAW) process.exit(3);
let launcher, sigText;
try {
  launcher = readFileSync(env.TGI_LAUNCHER);
  sigText = readFileSync(env.TGI_SIG, "utf8").trim();
} catch {
  process.exit(2);
}
const sig = /^[A-Za-z0-9_-]+$/.test(sigText) ? Buffer.from(sigText, "base64url") : Buffer.alloc(0);
if (sig.length !== 64) process.exit(1);
process.exit(verify(null, launcher, key, sig) ? 0 : 1);
'

die() { printf 'turbogol-node: %s\n' "$*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf 'Atención: %s\n' "$*" >&2; }

cleanup() {
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}

usage() {
  cat <<'EOF'
Instalador de nodo comunitario de Turbogol para PCs y laptops (macOS o Linux).
Tu computadora hostea partidas por WebRTC: no abres puertos ni tocas el router.

Uso (copia el comando completo que te da la web en "Pon un servidor"):
  curl -fsSL <control>/nodes/releases/install-desktop.sh | bash -s -- --control <url> --token <tgn1_...>

Opciones:
  --control <url>       dirección del plano de control (https://...)
  --token <tgn1_...>    token de un solo uso que te da la web (vence a la hora)
  --name <nombre>       nombre del servidor (opcional)
  --uplink-mbps <n>     tu velocidad de subida en Mbps (opcional)
  --rtc-ports <a>-<b>   rango fijo de puertos UDP para WebRTC, por ejemplo 50000-50199 (opcional)
  --insecure            acepta un --control http:// (solo para pruebas locales)
  --uninstall           detiene el nodo y borra todo lo que instaló este script
  -h, --help            esta ayuda

No hace falta root: no lo corras con sudo. Para un servidor (VPS) está install.sh.
EOF
}

parse_args() {
  local opt val inline
  while [ $# -gt 0 ]; do
    opt=$1
    val=""
    inline=0
    case "$opt" in
      --*=*) val=${opt#*=}; opt=${opt%%=*}; inline=1 ;;
    esac
    case "$opt" in
      --control|--token|--name|--uplink-mbps|--rtc-ports)
        if [ "$inline" = 0 ]; then
          [ $# -ge 2 ] || die "falta el valor de $opt"
          val=$2
          shift
        fi
        ;;
      --insecure|--uninstall|-h|--help)
        [ "$inline" = 0 ] || die "$opt no lleva valor"
        ;;
    esac
    case "$opt" in
      --control) CONTROL=${val%/} ;;
      --token) TOKEN=$val ;;
      --name) NAME=$val ;;
      --uplink-mbps) UPLINK=$val ;;
      --rtc-ports) RTC_PORTS=$val ;;
      --insecure) INSECURE=1 ;;
      --uninstall) UNINSTALL=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "opción desconocida: $opt (mira --help)" ;;
    esac
    shift
  done
}

detect_platform() {
  if [ -z "${HOME:-}" ] || [ "$HOME" = / ]; then die "no encuentro tu carpeta personal (HOME)"; fi
  local xdg
  case "$(uname -s)" in
    Darwin)
      OS=macos
      BASE="$HOME/Library/Application Support/TurbogolNode"
      PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
      ;;
    Linux)
      OS=linux
      xdg=${XDG_DATA_HOME:-}
      case "$xdg" in /*) ;; *) xdg="$HOME/.local/share" ;; esac
      BASE="${xdg%/}/turbogol-node"
      UNIT="$HOME/.config/systemd/user/$UNIT_NAME"
      if grep -qi microsoft /proc/version 2>/dev/null; then IS_WSL=1; fi
      ;;
    *)
      die "este instalador es para macOS o Linux. En Windows usa install-windows.ps1; en un servidor Linux, install.sh."
      ;;
  esac
  # These paths end up in a systemd unit or a plist: refuse the characters that would need tricks.
  case "$BASE" in
    *[[:cntrl:]]*|*'"'*|*'\'*) die "tu carpeta de datos tiene caracteres que no puedo usar: $BASE" ;;
  esac
  APP="$BASE/app"
  DATA="$BASE/data"
  LOG="$DATA/node.log"
}

check_release_key() {
  # Only the prefix: base64url keys may contain "__", and the build replaces the full placeholders.
  case "$RELEASE_KEY_B64URL" in
    __RELEASE_*) die "este instalador no tiene la clave de releases (se arma con scripts/build-node.mjs --sign): no lo uses así." ;;
  esac
  case "$RELEASE_KEY_PEM" in
    __RELEASE_*) die "este instalador no tiene la clave de releases (se arma con scripts/build-node.mjs --sign): no lo uses así." ;;
  esac
  [[ "$RELEASE_KEY_B64URL" =~ $KEY_RE ]] || die "la clave de releases de este instalador está dañada: bájalo de nuevo desde la web."
  case "$RELEASE_KEY_PEM" in
    "-----BEGIN PUBLIC KEY-----"*"-----END PUBLIC KEY-----") ;;
    *) die "la clave de releases de este instalador está dañada: bájalo de nuevo desde la web." ;;
  esac
}

validate_args() {
  local from to
  [ -n "$CONTROL" ] || die "falta --control <url> (copia el comando completo de la web, o mira --help)"
  [[ "$CONTROL" =~ $CONTROL_RE ]] || die "--control no parece una dirección válida: $CONTROL"
  case "$CONTROL" in
    https://*) ;;
    *)
      [ "$INSECURE" = 1 ] || die "--control tiene que ser https:// (para pruebas locales con http://, agrega --insecure)"
      warn "modo inseguro: el plano de control va por http://. Úsalo solo para pruebas locales."
      CURL_PROTO="=http,https"
      ;;
  esac
  if [ -n "$TOKEN" ] && ! [[ "$TOKEN" =~ $TOKEN_RE ]]; then
    die "--token tiene que ser el token de un solo uso que te da la web (empieza con tgn1_)"
  fi
  if [ -n "$NAME" ]; then
    case "$NAME" in
      *[[:cntrl:]]*) die "--name no puede tener caracteres de control" ;;
    esac
    if [ "${#NAME}" -gt 64 ]; then die "--name es demasiado largo (la web usa hasta 32 caracteres)"; fi
  fi
  if [ -n "$UPLINK" ]; then
    [[ "$UPLINK" =~ $UPLINK_RE ]] || die "--uplink-mbps tiene que ser un número de Mbps, por ejemplo 20"
    case "$UPLINK" in
      *[1-9]*) ;;
      *) die "--uplink-mbps tiene que ser mayor que 0" ;;
    esac
  fi
  if [ -n "$RTC_PORTS" ]; then
    [[ "$RTC_PORTS" =~ $PORTS_RE ]] || die "--rtc-ports va como <desde>-<hasta>, por ejemplo 50000-50199"
    from=$((10#${BASH_REMATCH[1]}))
    to=$((10#${BASH_REMATCH[2]}))
    if [ "$from" -lt 1024 ] || [ "$to" -gt 65535 ] || [ "$to" -le "$from" ]; then
      die "--rtc-ports: tiene que cumplir 1024 <= desde < hasta <= 65535"
    fi
    RTC_PORTS="$from-$to"
  fi
}

node_missing() {
  if [ -n "$NODE_VERSION" ]; then
    printf 'turbogol-node: tienes Node.js %s y hace falta la versión 24 o más nueva.\n' "$NODE_VERSION" >&2
  else
    printf 'turbogol-node: falta Node.js (versión 24 o más nueva).\n' >&2
  fi
  if [ "$OS" = macos ]; then
    if [ -n "$NODE_VERSION" ]; then
      printf '  Con Homebrew:  brew upgrade node   (o bájalo de https://nodejs.org)\n' >&2
    else
      printf '  Con Homebrew:  brew install node   (o bájalo de https://nodejs.org)\n' >&2
    fi
  else
    cat >&2 <<'EOF'
  Instálalo de alguna de estas formas:
    - el paquete de tu distribución, si trae la 24 o más nueva (apt, dnf, pacman, zypper...)
    - NodeSource: https://github.com/nodesource/distributions
    - nvm: https://github.com/nvm-sh/nvm  y después  nvm install 24
EOF
  fi
  printf '  Después vuelve a ejecutar el mismo comando.\n' >&2
  exit 1
}

find_node() {
  local major real
  NODE_BIN=$(type -P node 2>/dev/null || true)
  [ -n "$NODE_BIN" ] || node_missing
  NODE_VERSION=$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null </dev/null || true)
  major=${NODE_VERSION%%.*}
  case "$major" in
    ''|*[!0-9]*) NODE_VERSION=""; node_missing ;;
  esac
  if [ "$major" -lt 24 ]; then node_missing; fi
  case "$NODE_BIN" in
    /*) ;;
    *) NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")" ;;
  esac
  # Keep the PATH entry (e.g. Homebrew's symlink survives 'brew upgrade'), except for per-shell paths
  # that vanish after a reboot (fnm), where the real executable is the stable one.
  case "$NODE_BIN" in
    *fnm_multishells*)
      real=$("$NODE_BIN" -p 'process.execPath' 2>/dev/null </dev/null || true)
      case "$real" in /*) NODE_BIN=$real ;; esac
      ;;
  esac
  case "$NODE_BIN" in
    *[[:cntrl:]]*|*'"'*|*'\'*) die "la ruta de Node.js tiene caracteres que no puedo usar: $NODE_BIN" ;;
  esac
  case "$NODE_BIN" in
    */.nvm/*|*/fnm/*|*/.volta/*|*/.asdf/*|*/mise/*|*/n/versions/*) NODE_MANAGED=1 ;;
  esac
}

# Node and the launcher read TGN_* variables as defaults for their options: a stray one in this
# shell (say TGN_PUBLIC_URL or TGN_RELEASE_KEY) would make registration differ from what the
# service runs later with a clean environment.
scrub_env() {
  local v
  for v in $(env | sed -n 's/^\(TGN_[A-Za-z0-9_]*\)=.*/\1/p'); do
    unset "$v" 2>/dev/null || true
  done
}

fetch() {
  curl -fsSL --proto "$CURL_PROTO" --proto-redir "$CURL_PROTO" --retry 2 --connect-timeout 20 \
    --max-time 300 --max-filesize 33554432 -o "$2" "$1" </dev/null
}

install_launcher() {
  local url rc
  say "lanzador (con chequeo de firma)"
  # Inside BASE so the final mv is a rename on the same filesystem.
  TMP_DIR=$(mktemp -d "$BASE/.download.XXXXXX")
  url="$CONTROL/nodes/releases/launcher.mjs"
  fetch "$url" "$TMP_DIR/launcher.mjs" || die "no pude bajar $url"
  fetch "$url.sig" "$TMP_DIR/launcher.mjs.sig" || die "no pude bajar $url.sig"
  rc=0
  TGI_KEY_RAW=$RELEASE_KEY_B64URL TGI_KEY_PEM=$RELEASE_KEY_PEM \
    TGI_LAUNCHER="$TMP_DIR/launcher.mjs" TGI_SIG="$TMP_DIR/launcher.mjs.sig" \
    "$NODE_BIN" --input-type=module -e "$VERIFY_JS" </dev/null || rc=$?
  case "$rc" in
    0) ;;
    1) die "la firma del lanzador no verifica: no instalo nada. Avísanos en la web." ;;
    3) die "la clave de releases de este instalador no sirve: bájalo de nuevo desde la web." ;;
    *) die "no pude chequear la firma del lanzador (código $rc): no instalo nada." ;;
  esac
  mv -f "$TMP_DIR/launcher.mjs" "$APP/launcher.mjs"
  chmod 644 "$APP/launcher.mjs"
  rm -rf "$TMP_DIR"
  TMP_DIR=""
  printf '%s' "$RELEASE_KEY_B64URL" > "$DATA/release-key.pub"
  chmod 644 "$DATA/release-key.pub"
  note "firma verificada"
}

register_node() {
  local -a args
  args=(--control "$CONTROL" --data "$DATA" --token "$TOKEN" --roles host --transport rtc)
  if [ -n "$NAME" ]; then args+=(--name "$NAME"); fi
  if [ -n "$UPLINK" ]; then args+=(--uplink-mbps "$UPLINK"); fi
  say "registro: bajo la versión actual del nodo y mido cuántas partidas aguanta esta computadora (tarda unos segundos)"
  if ! "$NODE_BIN" "$APP/launcher.mjs" register "${args[@]}" </dev/null; then
    die "el registro falló. Los tokens sirven una sola vez y vencen a la hora: genera uno nuevo en la web y vuelve a ejecutar el comando."
  fi
  [ -f "$DATA/node.json" ] || die "el registro terminó sin dejar $DATA/node.json"
}

build_run_cmd() {
  RUN_CMD=("$NODE_BIN" "$APP/launcher.mjs" run --control "$CONTROL" --data "$DATA" --)
  if [ -n "$UPLINK" ]; then RUN_CMD+=(--uplink-mbps "$UPLINK"); fi
  if [ -n "$RTC_PORTS" ]; then RUN_CMD+=(--rtc-ports "$RTC_PORTS"); fi
}

# One argument for a systemd ExecStart line: double-quoted, with \ " escaped, % and $ doubled.
systemd_quote() {
  local s
  s=$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/\$/$$/g')
  printf '"%s"' "$s"
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

print_manual_start() {
  local line="" a q
  for a in "${RUN_CMD[@]}"; do
    q=$(printf '%q' "$a")
    line="$line $q"
  done
  note "${1:-Para arrancarlo a mano:}"
  note "  nohup$line >> $(printf '%q' "$LOG") 2>&1 &"
  note "Y agrégalo a las aplicaciones de inicio de tu escritorio para que arranque solo."
}

install_systemd() {
  local restart_ok=$1 exec_line="" a version log_lines out linger user
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "esta computadora no usa systemd: el nodo no va a arrancar solo."
    print_manual_start
    AUTOSTART=manual
    return 0
  fi
  for a in "${RUN_CMD[@]}"; do exec_line="$exec_line $(systemd_quote "$a")"; done
  version=$(systemctl --version 2>/dev/null | sed -n '1s/^systemd \([0-9][0-9]*\).*/\1/p' || true)
  if [ -n "$version" ] && [ "$version" -ge 240 ]; then
    log_lines="StandardOutput=append:$(printf '%s' "$LOG" | sed -e 's/%/%%/g')
StandardError=inherit"
  else
    log_lines="# systemd < 240 cannot append to a file: logs go to the journal (journalctl --user -u $UNIT_NAME)."
    LOG=""
  fi
  say "arranque automático: systemd de tu usuario ($UNIT)"
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT.tmp" <<EOF
# Generated by the Turbogol desktop installer (install-desktop.sh --uninstall removes it).
[Unit]
Description=Turbogol community node (hosts matches over WebRTC)
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${exec_line# }
# The launcher exits 0 only when it was asked to stop and the node has finished: that is not
# restarted (a 'systemctl --user kill' or a stop.request stays a stop); a crash is.
Restart=on-failure
RestartSec=5
# SIGTERM drains: no new matches, exit when the last one ends (up to a match length plus its TTL).
# It goes to the launcher, which asks the node over IPC, and to the node itself (harmless twice;
# control-group, not mixed, so an orphaned node whose launcher died still drains instead of being
# SIGKILLed). A second SIGTERM (systemctl --user kill $UNIT_NAME) stops the node at once.
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=$STOP_TIMEOUT
$log_lines
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
  chmod 644 "$UNIT.tmp"
  mv -f "$UNIT.tmp" "$UNIT"

  if ! systemctl --user show-environment >/dev/null 2>&1; then
    warn "no pude hablar con el systemd de tu usuario (pasa con su, sudo -u o algunas sesiones remotas)."
    note "Desde una sesión normal de tu usuario ejecuta:"
    note "  systemctl --user daemon-reload && systemctl --user enable --now $UNIT_NAME"
    print_manual_start "O arráncalo a mano:"
    AUTOSTART=manual
    return 0
  fi
  systemctl --user daemon-reload
  if systemctl --user is-active --quiet "$UNIT_NAME"; then
    systemctl --user enable "$UNIT_NAME" >/dev/null 2>&1 || warn "no pude habilitar $UNIT_NAME"
    if [ "$restart_ok" = 1 ]; then
      # It was running without an identity, so it had no matches: restarting cuts nothing.
      systemctl --user restart "$UNIT_NAME" || die "systemd no pudo reiniciar el nodo: mira  systemctl --user status $UNIT_NAME"
    else
      note "el nodo ya estaba corriendo: lo dejo así para no cortar partidas."
      note "Para aplicar cambios: systemctl --user restart $UNIT_NAME (espera a que terminen las partidas en curso)"
    fi
  else
    if ! out=$(systemctl --user enable --now "$UNIT_NAME" 2>&1); then
      printf '%s\n' "$out" >&2
      die "systemd no pudo arrancar el nodo: mira  systemctl --user status $UNIT_NAME"
    fi
  fi
  sleep 3
  if ! systemctl --user is-active --quiet "$UNIT_NAME"; then
    warn "el nodo no quedó corriendo. Mira  systemctl --user status $UNIT_NAME${LOG:+  y  $LOG}"
  fi
  user=$(id -un 2>/dev/null || true)
  linger=$(loginctl show-user "$user" --property=Linger 2>/dev/null || true)
  if [ -n "$user" ] && [ "$linger" != "Linger=yes" ]; then
    note "El nodo corre mientras tengas la sesión abierta. Para que siga con la sesión cerrada:"
    note "  loginctl enable-linger $(printf '%q' "$user")"
  fi
}

agent_loaded() {
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || launchctl list "$LABEL" >/dev/null 2>&1
}

agent_load() {
  # An old 'unload -w' leaves the label disabled, and bootstrap then refuses it.
  launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null
}

agent_unload() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null
}

install_launchagent() {
  local restart_ok=$1 args="" a uid info
  uid=$(id -u)
  for a in "${RUN_CMD[@]}"; do
    args="$args
		<string>$(xml_escape "$a")</string>"
  done
  say "arranque automático: LaunchAgent de tu usuario ($PLIST)"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST.tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by the Turbogol desktop installer; its uninstall option removes it. -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>$args
	</array>
	<key>RunAtLoad</key>
	<true/>
	<!-- Restarted after a crash, not after the launcher exits 0: it does that only when asked to
	     stop (bootout, kill, stop.request) once the node has finished its matches. -->
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<!-- SIGTERM drains: the launcher asks the node over IPC to take no new matches and exit when
	     the last one ends (up to a match length plus its TTL); then launchd SIGKILLs. -->
	<key>ExitTimeOut</key>
	<integer>$STOP_TIMEOUT</integer>
	<!-- Matches run in real time: no background CPU or I/O throttling. -->
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>StandardOutPath</key>
	<string>$(xml_escape "$LOG")</string>
	<key>StandardErrorPath</key>
	<string>$(xml_escape "$LOG")</string>
</dict>
</plist>
EOF
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint -s "$PLIST.tmp" >/dev/null || die "el plist generado no es válido: $PLIST.tmp"
  fi
  chmod 644 "$PLIST.tmp"
  mv -f "$PLIST.tmp" "$PLIST"

  if agent_loaded; then
    if [ "$restart_ok" = 1 ]; then
      # It was running without an identity, so it had no matches: reloading cuts nothing.
      agent_unload || true
    else
      note "el nodo ya estaba cargado: lo dejo así para no cortar partidas."
      note "Para aplicar cambios: launchctl bootout gui/$uid/$LABEL && launchctl bootstrap gui/$uid $(printf '%q' "$PLIST")"
      return 0
    fi
  fi
  if ! agent_load; then
    warn "no pude cargar el servicio ahora (pasa por SSH, sin sesión gráfica). Arranca solo la próxima vez que entres a tu usuario."
    return 0
  fi
  sleep 3
  info=$(launchctl list "$LABEL" 2>/dev/null || true)
  case "$info" in
    *'"PID"'*) ;;
    *) warn "el nodo no quedó corriendo. Mira  launchctl print gui/$uid/$LABEL  y  $LOG" ;;
  esac
}

print_summary() {
  local uid
  uid=$(id -u)
  if [ "$AUTOSTART" = on ]; then
    say "listo: esta computadora ya es un servidor comunitario de Turbogol."
  else
    say "registrado: falta arrancar el nodo (mira las instrucciones de arriba)."
  fi
  note "Estado en la web: 'Mis servidores'."
  if [ -n "$LOG" ]; then
    note "Log:      tail -f $(printf '%q' "$LOG")"
  else
    note "Log:      journalctl --user -u $UNIT_NAME -f"
  fi
  if [ "$OS" = linux ]; then
    if [ "$AUTOSTART" = on ]; then note "Servicio: systemctl --user status $UNIT_NAME"; fi
  else
    note "Servicio: launchctl print gui/$uid/$LABEL"
    note "Si macOS pregunta si \"node\" puede aceptar conexiones entrantes, acepta: es el WebRTC de las partidas."
  fi
  if [ "$NODE_MANAGED" = 1 ]; then
    note "Usa el Node.js de $NODE_BIN: si borras o cambias esa versión, vuelve a ejecutar el instalador."
  fi
  note "Mientras la computadora esté suspendida o apagada no recibe partidas; al volver se reconecta sola."
  note "Para desinstalar: curl -fsSL $CONTROL/nodes/releases/install-desktop.sh | bash -s -- --uninstall"
}

# A literal string as a POSIX extended regex (for pgrep -f).
ere_escape() {
  printf '%s' "$1" | sed -e 's/[][\.*^$+?(){}|]/\\&/g'
}

# PIDs (space-separated) of this user's processes whose command line matches the regex $1. Empty
# without pgrep.
find_pids() {
  command -v pgrep >/dev/null 2>&1 || return 0
  pgrep -u "$(id -u)" -f "$1" 2>/dev/null | tr '\n' ' ' | sed -e 's/  */ /g' -e 's/^ //' -e 's/ $//' || true
}

# Launchers of this installation ("<app>/launcher.mjs run ...": the service's, or one started by
# hand) and the nodes they run ("<data>/releases/<version>/<entry> run ..."). An editor or a
# 'tail -f' on one of these files does not match.
launcher_pids() { find_pids "$(ere_escape "$APP")/launcher\\.mjs run( |\$)"; }
node_pids() { find_pids "$(ere_escape "$DATA")/releases/[^ ]+ run( |\$)"; }

# What of this installation still runs: launchers and nodes (pgrep), the service's main PID $1
# (watched even without pgrep) and, with $2 = 1, the systemd unit while it is still stopping.
still_running() {
  local list
  list="$(launcher_pids) $(node_pids)"
  if [ -n "$1" ] && kill -0 "$1" 2>/dev/null; then
    case " $list " in *" $1 "*) ;; *) list="$list $1" ;; esac
  fi
  list=$(printf '%s' "$list" | sed -e 's/  */ /g' -e 's/^ //' -e 's/ $//')
  if [ -z "$list" ] && [ "$2" = 1 ]; then
    case "$(systemctl --user show -p ActiveState "$UNIT_NAME" 2>/dev/null | sed -n 's/^ActiveState=//p' || true)" in
      active|activating|deactivating|reloading) list=$UNIT_NAME ;;
    esac
  fi
  printf '%s' "$list"
}

uninstall() {
  local -a removed
  local p busy waited item count=0 svc_pid="" svc_state="" watch_unit=0 manual=""
  removed=()

  # 1. The service: stopped without waiting here (the loop below shows the progress) and kept from
  #    starting again. systemd / launchd send the SIGTERM themselves: the launcher asks the node to
  #    finish its matches, then exits 0.
  if [ "$OS" = linux ]; then
    if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
      svc_state=$(systemctl --user show -p ActiveState "$UNIT_NAME" 2>/dev/null | sed -n 's/^ActiveState=//p' || true)
      case "$svc_state" in
        active|activating|deactivating|reloading)
          svc_pid=$(systemctl --user show -p MainPID "$UNIT_NAME" 2>/dev/null | sed -n 's/^MainPID=\([1-9][0-9]*\)$/\1/p' || true)
          say "detengo el nodo: si hay partidas en curso, espera a que terminen (hasta $((STOP_TIMEOUT / 60)) minutos; no se corta a nadie)"
          # A unit that is already stopping gets no second SIGTERM from this (that one would cut
          # its matches): systemd merges the two stop jobs.
          if systemctl --user stop --no-block "$UNIT_NAME" >/dev/null 2>&1; then
            watch_unit=1
          else
            warn "systemd no pudo detener $UNIT_NAME: se lo pido directamente al lanzador"
            svc_pid=""
          fi
          count=$((count + 1)); removed+=("servicio $UNIT_NAME (detenido)")
          ;;
      esac
      if systemctl --user is-enabled --quiet "$UNIT_NAME" 2>/dev/null; then
        systemctl --user disable "$UNIT_NAME" >/dev/null 2>&1 || warn "systemd no pudo deshabilitar $UNIT_NAME"
        count=$((count + 1)); removed+=("arranque automático de $UNIT_NAME (deshabilitado)")
      fi
    elif [ -f "$UNIT" ]; then
      warn "no pude hablar con el systemd de tu usuario: si el nodo sigue corriendo, se detiene al cerrar la sesión."
    fi
  else
    if agent_loaded; then
      svc_pid=$(launchctl list "$LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*"PID" = \([0-9][0-9]*\);$/\1/p' || true)
      if [ -z "$svc_pid" ]; then
        svc_pid=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -n 1 || true)
      fi
      say "detengo el nodo: si hay partidas en curso, espera a que terminen (hasta $((STOP_TIMEOUT / 60)) minutos; no se corta a nadie)"
      # bootout sends the SIGTERM and may return before the node is done: the loop below waits.
      agent_unload || warn "launchctl no pudo sacar $LABEL (si se estaba deteniendo, termina solo)"
      count=$((count + 1)); removed+=("servicio $LABEL (detenido)")
    fi
  fi

  # 2. A launcher started by hand (the nohup command, or after a 'systemctl --user stop') gets the
  #    same SIGTERM, and so does a node whose launcher is gone (for a node it only ever means
  #    "finish your matches", however many times). Never a second one to the service's launcher,
  #    which already has its stop request: a second one would mean "stop now".
  for p in $(launcher_pids); do
    if [ "$p" != "$svc_pid" ]; then manual="$manual $p"; fi
  done
  manual=${manual# }
  if [ -n "$manual" ]; then
    say "le pido al lanzador del nodo que se detenga (PID $manual): no toma partidas nuevas y se cierra cuando terminan las que están en curso"
  fi
  for p in $manual $(node_pids); do kill -TERM "$p" 2>/dev/null || true; done

  # 3. Wait, with progress, until nothing of this installation runs.
  waited=0
  busy=$(still_running "$svc_pid" "$watch_unit")
  while [ -n "$busy" ] && [ "$waited" -lt $((STOP_TIMEOUT + 60)) ]; do
    if [ "$waited" = 0 ]; then note "espero a que el nodo termine las partidas en curso (hasta $((STOP_TIMEOUT / 60)) minutos)..."; fi
    sleep 2
    waited=$((waited + 2))
    if [ $((waited % 60)) = 0 ]; then note "sigo esperando ($((waited / 60)) min)..."; fi
    busy=$(still_running "$svc_pid" "$watch_unit")
  done

  # 4. The service files, only now: removed (and daemon-reload) while systemd was still stopping
  #    the unit, it would lose its TimeoutStopSec and KillMode in the middle of the drain.
  if [ "$OS" = linux ]; then
    rm -f "$HOME/.config/systemd/user/default.target.wants/$UNIT_NAME"
    if [ -f "$UNIT" ]; then
      rm -f "$UNIT"
      count=$((count + 1)); removed+=("$UNIT")
      if command -v systemctl >/dev/null 2>&1; then
        systemctl --user daemon-reload >/dev/null 2>&1 || true
        systemctl --user reset-failed "$UNIT_NAME" >/dev/null 2>&1 || true
      fi
    fi
  elif [ -f "$PLIST" ]; then
    rm -f "$PLIST"
    count=$((count + 1)); removed+=("$PLIST")
  fi

  if [ -n "$busy" ]; then
    warn "sigue corriendo un nodo de esta instalación ($busy) después de $(((STOP_TIMEOUT + 60) / 60)) minutos."
    if [ "$busy" = "$UNIT_NAME" ]; then
      note "Para cortarlo ya: systemctl --user kill $UNIT_NAME   (corta las partidas en curso)"
    else
      note "Para cortarlo ya: kill $busy   (un segundo pedido de detención corta las partidas en curso)"
    fi
    note "Después vuelve a ejecutar este comando con --uninstall para borrar $BASE"
    exit 1
  fi

  if [ -e "$BASE" ]; then
    case "$BASE" in
      */TurbogolNode|*/turbogol-node) ;;
      *) die "ruta inesperada, no borro nada: $BASE" ;;
    esac
    case "$BASE" in
      /TurbogolNode|/turbogol-node) die "ruta inesperada, no borro nada: $BASE" ;;
    esac
    rm -rf "$BASE"
    count=$((count + 1)); removed+=("$BASE (lanzador, versiones del nodo, clave del nodo, estado y log)")
  fi

  if [ "$count" = 0 ]; then
    say "no había nada de Turbogol instalado para tu usuario."
    return 0
  fi
  say "desinstalado. Saqué:"
  for item in ${removed[@]+"${removed[@]}"}; do note "- $item"; done
  note "Node.js queda instalado. Si quieres, borra también este servidor en la web ('Mis servidores')."
}

main() {
  local registered=0
  parse_args ${1+"$@"}
  if [ "$(id -u)" = 0 ]; then
    die "no lo corras como root ni con sudo: este instalador es para tu usuario. Para un servidor (VPS) usa install.sh."
  fi
  detect_platform
  if [ "$UNINSTALL" = 1 ]; then
    uninstall
    return 0
  fi
  check_release_key
  validate_args
  command -v curl >/dev/null 2>&1 || die "falta curl"
  find_node
  scrub_env
  if [ "$IS_WSL" = 1 ]; then
    warn "parece WSL: para hostear desde Windows conviene install-windows.ps1 (WSL suele quedar detrás de otra NAT)."
  fi
  if [ -f "$DATA/node.json" ]; then registered=1; fi
  if [ "$registered" = 0 ] && [ -z "$TOKEN" ]; then
    die "falta --token (copia el comando completo de la web)"
  fi

  say "Node.js $NODE_VERSION ($NODE_BIN)"
  umask 077
  mkdir -p "$APP" "$DATA"
  chmod 700 "$BASE" "$DATA"
  trap cleanup EXIT
  install_launcher

  if [ "$registered" = 1 ]; then
    say "esta computadora ya está registrada ($DATA/node.json): no uso el token, solo reinstalo el lanzador y el arranque automático."
    note "Para registrarla de nuevo desde cero: ejecuta con --uninstall y después el comando de la web."
  else
    register_node
  fi

  build_run_cmd
  : >> "$LOG"
  # A service already loaded before this registration ran without an identity: safe to restart it.
  if [ "$OS" = macos ]; then
    install_launchagent "$((1 - registered))"
  else
    install_systemd "$((1 - registered))"
  fi
  print_summary
}

# ${1+"$@"}: old shells treat a bare "$@" with no arguments as unset under -u.
main ${1+"$@"}

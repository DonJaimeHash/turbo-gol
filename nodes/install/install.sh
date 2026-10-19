#!/usr/bin/env bash
# Turbogol community node installer: Debian 12+ / Ubuntu 22.04+, x86_64 or arm64, run as root.
#
#   curl -fsSL <control>/nodes/releases/install.sh | sudo bash -s -- --control <url> --token <tgn1_...>
#        [--name <name>] [--roles host|verify|host,verify] [--transport wss|rtc]
#   (verify: only the project's own nodes may verify matches for now; a community token is refused)
#        [--public-host <ip or name>] [--uplink-mbps <n>] [--egress-cap-gb <n>]
#
#   --transport wss (default): players connect to this machine's public IP over HTTPS (ports 80/443).
#   --transport rtc: a server that cannot open ports; players connect over WebRTC (outbound UDP and
#                    TURN), no Caddy, no firewall changes. Home PCs use install-windows.ps1 or
#                    install-desktop.sh instead.
#
# What it does (and nothing else):
#   1. Node.js 24 (NodeSource) and Caddy (official repo) if missing
#   2. user 'turbogol', /opt/turbogol-node (launcher), /var/lib/turbogol-node (keys, releases, state)
#   3. downloads the launcher and checks its Ed25519 signature against the release key below
#   4. registers the machine with the one-time token (the node key is generated here and stays here)
#   5. Caddy: HTTPS on this machine's public IP with a Let's Encrypt IP certificate (6-day profile,
#      renewed by itself), reverse proxy to the node on 127.0.0.1:7350
#   6. systemd service 'turbogol-node' (the launcher: auto-update, drain, rollback), firewall 80/443
#
# Stop:      systemctl stop turbogol-node   the node takes no new matches and stops when the running
#            ones end (up to 30 min; nobody is cut). To cut them, while it waits: systemctl kill
#            turbogol-node (a second stop request). The service stays stopped until started again
#            (Restart=on-failure: the launcher exits 0 after a stop).
# Uninstall: systemctl disable --now turbogol-node (the same wait); rm -rf /opt/turbogol-node
#            /var/lib/turbogol-node; userdel turbogol; (and Caddy if you do not use it for anything else)
set -euo pipefail

# Filled in by scripts/build-node.mjs from the release key (never fetched from the network).
RELEASE_KEY_B64URL="__RELEASE_PUBLIC_KEY_B64URL__"
RELEASE_KEY_PEM="__RELEASE_PUBLIC_KEY_PEM__"

CONTROL=""; TOKEN=""; NAME=""; ROLES="host"; TRANSPORT="wss"; PUBLIC_HOST=""; UPLINK=""; EGRESS=""
PORT=7350
APP=/opt/turbogol-node
DATA=/var/lib/turbogol-node

die() { echo "turbogol-node install: $*" >&2; exit 1; }
say() { echo "==> $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --control) CONTROL="${2%/}"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --roles) ROLES="$2"; shift 2 ;;
    --transport) TRANSPORT="$2"; shift 2 ;;
    --public-host) PUBLIC_HOST="$2"; shift 2 ;;
    --uplink-mbps) UPLINK="$2"; shift 2 ;;
    --egress-cap-gb) EGRESS="$2"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -n "$CONTROL" ] || die "--control is required"
case "$CONTROL" in https://*) ;; *) die "--control must be https://" ;; esac
[[ "$TOKEN" =~ ^tgn1_[A-Za-z0-9_-]{20,64}$ ]] || die "--token must be the one-time token from the website (tgn1_...)"
[[ "$ROLES" =~ ^(host|verify|host,verify|verify,host)$ ]] || die "--roles: host, verify or host,verify"
[[ "$TRANSPORT" =~ ^(wss|rtc)$ ]] || die "--transport: wss or rtc"
# Only the placeholder's own prefix: a real base64url key may well start with "__".
case "$RELEASE_KEY_B64URL" in __RELEASE_*) die "this install.sh has no release key (build it with scripts/build-node.mjs --sign)" ;; esac
case "$RELEASE_KEY_PEM" in __RELEASE_*) die "this install.sh has no release key (build it with scripts/build-node.mjs --sign)" ;; esac
[[ "$RELEASE_KEY_B64URL" =~ ^[A-Za-z0-9_-]{43}$ ]] || die "the release key in this install.sh is damaged: download it again"
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) die "only Debian / Ubuntu for now (found ${ID:-unknown})" ;; esac
command -v systemctl >/dev/null || die "systemd is required"

export DEBIAN_FRONTEND=noninteractive
say "packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg openssl >/dev/null

NODE_MAJOR=0
if command -v node >/dev/null; then NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]'); fi
if [ "$NODE_MAJOR" -lt 24 ]; then
  say "Node.js 24 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

HOSTING=0
case "$ROLES" in *host*) HOSTING=1 ;; esac
# Caddy, the public address and the firewall only matter for a host reached over wss.
WSS=0
if [ "$HOSTING" = 1 ] && [ "$TRANSPORT" = wss ]; then WSS=1; fi
if [ "$WSS" = 1 ] && ! command -v caddy >/dev/null; then
  say "Caddy (official repository)"
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

say "user and directories"
id turbogol >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin turbogol
mkdir -p "$APP" "$DATA"
chown turbogol:turbogol "$DATA"
chmod 700 "$DATA"
printf '%s' "$RELEASE_KEY_B64URL" > "$DATA/release-key.pub"
printf '%s\n' "$RELEASE_KEY_PEM" > "$APP/release-key.pem"
chown turbogol:turbogol "$DATA/release-key.pub"

say "launcher (signature check)"
curl -fsSL "$CONTROL/nodes/releases/launcher.mjs" -o "$APP/launcher.mjs.new"
SIG=$(curl -fsSL "$CONTROL/nodes/releases/launcher.mjs.sig" | tr '_-' '/+')
while [ $(( ${#SIG} % 4 )) -ne 0 ]; do SIG="$SIG="; done
printf '%s' "$SIG" | base64 -d > "$APP/launcher.sig.bin"
openssl pkeyutl -verify -pubin -inkey "$APP/release-key.pem" -rawin -in "$APP/launcher.mjs.new" -sigfile "$APP/launcher.sig.bin" >/dev/null \
  || die "the launcher's signature does not verify: refusing to install"
mv "$APP/launcher.mjs.new" "$APP/launcher.mjs"
rm -f "$APP/launcher.sig.bin"

PUBLIC_URL_ARGS=()
if [ "$HOSTING" = 1 ]; then PUBLIC_URL_ARGS=(--transport "$TRANSPORT"); fi
if [ "$WSS" = 1 ]; then
  if [ -z "$PUBLIC_HOST" ]; then
    PUBLIC_HOST=$(curl -fsS "$CONTROL/nodes/whoami" | sed -n 's/.*"ip":"\([^"]*\)".*/\1/p')
    [ -n "$PUBLIC_HOST" ] || die "could not detect the public IP: pass --public-host"
  fi
  case "$PUBLIC_HOST" in *:*) URL_HOST="[$PUBLIC_HOST]" ;; *) URL_HOST="$PUBLIC_HOST" ;; esac
  PUBLIC_URL_ARGS+=(--public-url "wss://$URL_HOST")
fi

say "registration"
REG_ARGS=(--control "$CONTROL" --data "$DATA" --token "$TOKEN" --roles "$ROLES" "${PUBLIC_URL_ARGS[@]}")
[ -n "$NAME" ] && REG_ARGS+=(--name "$NAME")
[ -n "$UPLINK" ] && REG_ARGS+=(--uplink-mbps "$UPLINK")
runuser -u turbogol -- node "$APP/launcher.mjs" register "${REG_ARGS[@]}" || die "registration failed (tokens are single use and expire after an hour: create a new one on the website)"

if [ "$WSS" = 1 ]; then
  say "Caddy: HTTPS on $PUBLIC_HOST -> 127.0.0.1:$PORT"
  cat > /etc/caddy/Caddyfile <<EOF
# Generated by the Turbogol node installer.
{
	# Let's Encrypt issues IP-address certificates only with the short-lived profile (about 6 days,
	# renewed automatically). With a domain name instead of an IP, this block can go.
	cert_issuer acme {
		profile shortlived
	}
}

$PUBLIC_HOST {
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl restart caddy
  if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
fi

RUN_ARGS="--port $PORT --listen 127.0.0.1"
[ -n "$EGRESS" ] && RUN_ARGS="$RUN_ARGS --egress-cap-gb $EGRESS"
[ -n "$UPLINK" ] && RUN_ARGS="$RUN_ARGS --uplink-mbps $UPLINK"
say "service"
cat > /etc/systemd/system/turbogol-node.service <<EOF
[Unit]
Description=Turbogol community node
After=network-online.target
Wants=network-online.target

[Service]
User=turbogol
Group=turbogol
ExecStart=/usr/bin/node $APP/launcher.mjs run --control $CONTROL --data $DATA -- $RUN_ARGS
# The launcher exits 0 only when it was asked to stop and the node has finished: no restart then
# (a 'systemctl kill' or a stop.request stays a stop). A crash or a failure restarts it.
Restart=on-failure
RestartSec=5
# Stop: SIGTERM to every process of the unit. The node drains (no new matches, exit when the last
# one ends: a match length plus its 10 min TTL at most); the launcher asks it the same over IPC
# (harmless twice), waits for it and exits 0 without starting another version, even if an update
# was pending. A second SIGTERM (systemctl kill turbogol-node) makes the launcher ask the node to
# stop at once. control-group, not mixed: if the launcher died on its own (OOM, kill -9), the
# orphaned node still gets the SIGTERM and finishes its matches instead of being SIGKILLed, and so
# does a node release older than the IPC request. After TimeoutStopSec, systemd SIGKILLs the rest.
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=1800
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now turbogol-node >/dev/null

say "done. Logs: journalctl -u turbogol-node -f    Status on the website: 'Mis servidores'."

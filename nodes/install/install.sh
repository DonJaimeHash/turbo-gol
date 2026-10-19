#!/usr/bin/env bash
# Turbogol community node installer: Debian 12+ / Ubuntu 22.04+, x86_64 or arm64, run as root.
#
#   curl -fsSL <control>/nodes/releases/install.sh | sudo bash -s -- --control <url> --token <tgn1_...>
#        [--name <name>] [--roles host|verify|host,verify] [--transport wss|rtc]
#   (verify: only the project's own nodes may verify matches for now; a community token is refused)
#        [--public-host <ip or name>] [--allow-proxied] [--uplink-mbps <n>] [--egress-cap-gb <n>]
#        [--matches <n>]
#
#   --transport wss (default): players connect to this machine over HTTPS (ports 80/443), on its
#                    public IP or on the name given with --public-host.
#   --transport rtc: a server that cannot open ports; players connect over WebRTC (outbound UDP and
#                    TURN), no Caddy, no firewall changes. Home PCs use install-windows.ps1 or
#                    install-desktop.sh instead.
#   --public-host <name>: a DNS name for this machine. Before the token is spent, its A record must
#                    lead to this machine's public IPv4; --allow-proxied also accepts Cloudflare's
#                    proxy in front of it (SSL mode "Full (strict)").
#   --matches <n>:   how many matches at a time, instead of the CPU benchmark's estimate.
#
# Running it again is safe: with /var/lib/turbogol-node/node.json in place it needs no token and
# registers nothing. It upgrades the launcher and rewrites the service and the Caddy config; when
# that changed anything, the node restarts once its running matches end. --matches,
# --egress-cap-gb and --uplink-mbps change their values; left out, they keep the installed ones.
# The roles, the transport and the public address were fixed at registration and come from
# node.json.
#   --restore <node.json>: install a backed-up identity (a new machine, or a reinstalled one)
#                    instead of registering. No token; a DNS name must point to the new machine.
#
# What it does (and nothing else):
#   1. Node.js 24 (NodeSource) and Caddy (official repo) if missing
#   2. user 'turbogol', /opt/turbogol-node (launcher), /var/lib/turbogol-node (keys, releases, state)
#   3. downloads the launcher and checks its Ed25519 signature against the release key below
#   4. Caddy: HTTPS on this machine's public IP or name, reverse proxy to the node on 127.0.0.1:7350,
#      with a Let's Encrypt certificate it renews by itself (90 days for a name; an IP gets the
#      6-day profile). The config and ports 80/443 are checked before the token is spent
#   5. registers the machine with the one-time token (the node key is generated here and stays
#      here), or installs the --restore identity, or keeps the one it has
#   6. systemd service 'turbogol-node' (the launcher: auto-update, drain, rollback), firewall 80/443
#
# Stop:      systemctl stop turbogol-node   the node takes no new matches and stops when the running
#            ones end (up to 30 min; nobody is cut). To cut them, while it waits: systemctl kill
#            turbogol-node (a second stop request). The service stays stopped until started again
#            (Restart=on-failure: the launcher exits 0 after a stop).
# Back up:   /var/lib/turbogol-node/node.json (the node's key) somewhere safe, for --restore.
# Uninstall: systemctl disable --now turbogol-node (the same wait); rm -rf /opt/turbogol-node
#            /var/lib/turbogol-node /etc/systemd/system/turbogol-node.service; userdel turbogol;
#            (and Caddy if you do not use it for anything else)
set -euo pipefail

# Filled in by scripts/build-node.mjs from the release key (never fetched from the network).
RELEASE_KEY_B64URL="__RELEASE_PUBLIC_KEY_B64URL__"
RELEASE_KEY_PEM="__RELEASE_PUBLIC_KEY_PEM__"

CONTROL=""; TOKEN=""; NAME=""; ROLES=""; TRANSPORT=""; PUBLIC_HOST=""; UPLINK=""; EGRESS=""; MATCHES=""
RESTORE=""; ALLOW_PROXIED=0
PORT=7350
APP=/opt/turbogol-node
DATA=/var/lib/turbogol-node
UNIT=/etc/systemd/system/turbogol-node.service

die() { echo "turbogol-node install: $*" >&2; exit 1; }
say() { echo "==> $*"; }

# Every apt-get waits for the dpkg lock: a fresh cloud machine is often still running its first
# unattended upgrade.
apt_get() { apt-get -o DPkg::Lock::Timeout=600 "$@"; }

# The package lists have a lock of their own that the timeout does not cover: retry while the
# system's daily update holds it.
apt_update() {
  local i out
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if out=$(LC_ALL=C apt_get update -qq 2>&1); then return 0; fi
    case "$out" in
      *"Could not get lock"*) sleep 30 ;;
      *) printf '%s\n' "$out" >&2; die "apt-get update failed" ;;
    esac
  done
  die "apt-get update: the package lists stayed locked for 5 minutes (another update is running)"
}

is_ipv4() {
  local IFS=. o
  [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  for o in $1; do [ "$o" -le 255 ] || return 1; done
}
is_ipv6() { [[ "$1" == *:*:* && "$1" =~ ^[0-9A-Fa-f:.]+$ ]]; }
is_ip() { is_ipv4 "$1" || is_ipv6 "$1"; }
# A DNS name with at least one dot; no port, no scheme, nothing Caddy would read as syntax.
is_dns_name() { [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]]; }

ipv4_int() {
  local IFS=.
  # shellcheck disable=SC2086
  set -- $1
  echo $(( ($1 << 24) | ($2 << 16) | ($3 << 8) | $4 ))
}

# Cloudflare's proxy addresses (https://www.cloudflare.com/ips-v4/): a proxied DNS record answers
# with these instead of this machine's address.
CLOUDFLARE_V4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18
108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15
104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
is_cloudflare_v4() {
  local n net mask
  n=$(ipv4_int "$1")
  for net in $CLOUDFLARE_V4; do
    mask=$(( (0xFFFFFFFF << (32 - ${net#*/})) & 0xFFFFFFFF ))
    [ $(( n & mask )) -eq $(( $(ipv4_int "${net%/*}") & mask )) ] && return 0
  done
  return 1
}

# Does a name whose DNS answers are $1 (IPv4 addresses, whitespace-separated) lead to this machine,
# whose public IPv4 is $2? Prints why not and fails. $3 = 1 (--allow-proxied) accepts Cloudflare's
# proxy addresses too.
dns_leads_here() {
  local a other="" proxied=""
  [ -n "$1" ] || { echo "it has no IPv4 address (A record) in DNS"; return 1; }
  for a in $1; do
    if [ "$a" = "$2" ]; then continue; fi
    if is_ipv4 "$a" && is_cloudflare_v4 "$a"; then proxied="$proxied $a"; else other="$other $a"; fi
  done
  if [ -n "$other" ]; then echo "it resolves to ${other# }, not to this machine ($2)"; return 1; fi
  if [ -n "$proxied" ] && [ "$3" != 1 ]; then
    echo "it resolves to Cloudflare's proxy (${proxied# }), not to this machine ($2): set the record to 'DNS only', or pass --allow-proxied if the proxy is meant to stay (SSL mode 'Full (strict)')"
    return 1
  fi
}

# The IPv4 addresses DNS gives for $1. Not /etc/hosts first: it may map this machine's own name to
# 127.0.1.1. (Falls back to the system's usual lookup if the dns-only one is not available.)
dns_ipv4() {
  { getent -s dns ahostsv4 "$1" 2>/dev/null || getent ahostsv4 "$1" 2>/dev/null || true; } | awk '{ print $1 }' | sort -u
}

# 0 when the version in $1 (the output of `caddy version`, "v2.10.2 h1:...") is at least $2.$3.
# An unreadable one (a custom build) passes: `caddy validate` judges the config anyway.
version_at_least() {
  [[ "$1" =~ ^v?([0-9]+)\.([0-9]+) ]] || return 0
  local major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]}
  [ "$major" -gt "$2" ] || { [ "$major" -eq "$2" ] && [ "$minor" -ge "$3" ]; }
}

# The Caddyfile for a wss host: HTTPS on $1 (an IP address or a DNS name) to the node on
# 127.0.0.1:$2. Printed: the caller validates it before it replaces /etc/caddy/Caddyfile.
caddyfile() {
  local site=$1
  if is_ipv6 "$1"; then site="[$1]"; fi
  cat <<EOF
# Generated by the Turbogol node installer, which rewrites it on every run.
{
	# No HTTP/3: it runs over UDP, which the installer does not open in the firewall, and Caddy
	# would still offer it to every browser.
	servers {
		protocols h1 h2
	}
EOF
  if is_ip "$1"; then
    cat <<EOF
	# Let's Encrypt issues IP-address certificates only with the short-lived profile (about 6 days,
	# renewed automatically; Caddy 2.10 or newer). A DNS name gets the default 90-day certificate.
	cert_issuer acme {
		profile shortlived
	}
EOF
  fi
  cat <<EOF
}

$site {
	reverse_proxy 127.0.0.1:$2 {
		# A config reload (a re-run of the installer, a Caddy upgrade) leaves the players' WebSockets
		# open this long instead of cutting their matches: as long as the node's own drain.
		stream_close_delay 30m
	}
}
EOF
}

# What a node.json holds, on one line: "nodeId roles transports publicUrl" (lists comma-separated,
# "-" for none). Nothing when it is not a node identity. Needs Node.js.
identity_of() {
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const list = (a) => (Array.isArray(a) && a.length > 0 ? a.join(",") : "-");
    const ok = typeof j.nodeId === "string" && /^[A-Za-z0-9_-]+$/.test(j.nodeId) && typeof j.privateKey === "string" && Array.isArray(j.roles);
    if (ok) console.log([j.nodeId, list(j.roles), list(j.transports), j.publicUrl || "-"].join(" "));
  ' "$1" 2>/dev/null || true
}

# "verify,host" and "host,verify" are the same roles.
sorted_list() { tr ',' '\n' <<<"$1" | sort | paste -s -d , -; }

# The value the installed service runs with for a node run option ($1, e.g. egress-cap-gb), or
# nothing.
unit_run_arg() {
  [ -f "$UNIT" ] || return 0
  sed -n "s/^ExecStart=.* -- .*--$1 \([^ ]*\).*/\1/p" "$UNIT" | head -n 1
}

# Install $1 as $2 (mode $3, owner $4, root by default) when it differs from what is there; true
# when it did. $1 is consumed either way.
put_file() {
  if cmp -s "$1" "$2"; then rm -f "$1"; return 1; fi
  install -m "$3" -o "${4:-root}" -g "${4:-root}" "$1" "$2"
  rm -f "$1"
}

# test/install-sh.test.mjs sources this file with TGN_INSTALL_LIB=1 for the functions above.
if [ "${TGN_INSTALL_LIB:-}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

while [ $# -gt 0 ]; do
  case "$1" in
    --control) CONTROL="${2%/}"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --roles) ROLES="$2"; shift 2 ;;
    --transport) TRANSPORT="$2"; shift 2 ;;
    --public-host) PUBLIC_HOST="$2"; shift 2 ;;
    --allow-proxied) ALLOW_PROXIED=1; shift ;;
    --uplink-mbps) UPLINK="$2"; shift 2 ;;
    --egress-cap-gb) EGRESS="$2"; shift 2 ;;
    --matches) MATCHES="$2"; shift 2 ;;
    --restore) RESTORE="$2"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root (sudo)"
[ -n "$CONTROL" ] || die "--control is required"
[[ "$CONTROL" =~ ^https://[A-Za-z0-9._~:/-]+$ ]] || die "--control must be an https:// URL"
# A re-run (node.json in place) or a restore keeps an identity; only a new registration spends a token.
REGISTER=1
if [ -n "$RESTORE" ]; then
  [ -f "$RESTORE" ] && [ -r "$RESTORE" ] || die "--restore: cannot read $RESTORE"
  if [ -f "$DATA/node.json" ] && ! cmp -s "$RESTORE" "$DATA/node.json"; then
    die "$DATA/node.json exists and is a different identity: move it away first if you mean to replace it"
  fi
  REGISTER=0
elif [ -f "$DATA/node.json" ]; then
  REGISTER=0
fi
if [ "$REGISTER" = 1 ]; then
  [[ "$TOKEN" =~ ^tgn1_[A-Za-z0-9_-]{20,64}$ ]] || die "--token must be the one-time token from the website (tgn1_...)"
else
  [ -z "$TOKEN" ] || say "this machine keeps the identity in ${RESTORE:-$DATA/node.json}: the token is not used (it stays valid until it expires)"
  [ -z "$NAME" ] || say "--name was fixed at registration: ignored"
fi
[ -z "$ROLES" ] || [[ "$ROLES" =~ ^(host|verify|host,verify|verify,host)$ ]] || die "--roles: host, verify or host,verify"
[ -z "$TRANSPORT" ] || [[ "$TRANSPORT" =~ ^(wss|rtc)$ ]] || die "--transport: wss or rtc"
[ -z "$MATCHES" ] || { [[ "$MATCHES" =~ ^[0-9]{1,3}$ ]] && [ "$MATCHES" -ge 1 ] && [ "$MATCHES" -le 200 ]; } || die "--matches: a whole number from 1 to 200"
[ -z "$UPLINK" ] || [[ "$UPLINK" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--uplink-mbps: a number"
[ -z "$EGRESS" ] || [[ "$EGRESS" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--egress-cap-gb: a number"
PUBLIC_HOST=${PUBLIC_HOST#\[}; PUBLIC_HOST=${PUBLIC_HOST%\]}
[ -z "$PUBLIC_HOST" ] || is_ip "$PUBLIC_HOST" || is_dns_name "$PUBLIC_HOST" || die "--public-host: an IP address or a DNS name, with no port or scheme"
# Only the placeholder's own prefix: a real base64url key may well start with "__".
case "$RELEASE_KEY_B64URL" in __RELEASE_*) die "this install.sh has no release key (build it with scripts/build-node.mjs --sign)" ;; esac
case "$RELEASE_KEY_PEM" in __RELEASE_*) die "this install.sh has no release key (build it with scripts/build-node.mjs --sign)" ;; esac
[[ "$RELEASE_KEY_B64URL" =~ ^[A-Za-z0-9_-]{43}$ ]] || die "the release key in this install.sh is damaged: download it again"
. /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) die "only Debian / Ubuntu for now (found ${ID:-unknown})" ;; esac
command -v systemctl >/dev/null || die "systemd is required"

export DEBIAN_FRONTEND=noninteractive
say "packages"
apt_update
apt_get install -y -qq curl ca-certificates gnupg openssl >/dev/null

NODE_MAJOR=0
if command -v node >/dev/null; then NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]'); fi
if [ "$NODE_MAJOR" -lt 24 ]; then
  say "Node.js 24 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt_get install -y -qq nodejs >/dev/null
fi

if [ "$REGISTER" = 1 ]; then
  ROLES=${ROLES:-host}
  TRANSPORT=${TRANSPORT:-wss}
else
  # The roles, the transport and the public address were fixed at registration: take them from
  # the identity, so a re-run cannot point Caddy at another address than the one players are given.
  IDFILE=${RESTORE:-$DATA/node.json}
  read -r ID_NODE ID_ROLES ID_TRANSPORTS ID_URL <<<"$(identity_of "$IDFILE")"
  [ -n "${ID_NODE:-}" ] || die "$IDFILE is not a node identity (node.json)"
  fixed() { die "$1 was fixed at registration: $IDFILE says $2. Leave $3 out (to change it, register this machine again with a new token, after moving node.json away)"; }
  [ -z "$ROLES" ] || [ "$(sorted_list "$ROLES")" = "$(sorted_list "$ID_ROLES")" ] || fixed "the role list" "$ID_ROLES" --roles
  ROLES=$ID_ROLES
  case ",$ID_TRANSPORTS," in *,wss,*) ID_TRANSPORT=wss ;; *) ID_TRANSPORT=rtc ;; esac
  # A verifier that does not host registered no transport: whatever --transport says is moot.
  case ",$ROLES," in
    *,host,*) [ -z "$TRANSPORT" ] || [ "$TRANSPORT" = "$ID_TRANSPORT" ] || fixed "the transport" "$ID_TRANSPORTS" --transport ;;
  esac
  TRANSPORT=$ID_TRANSPORT
  if [ "$ID_URL" != - ]; then
    ID_HOST=${ID_URL#wss://}; ID_HOST=${ID_HOST%%/*}; ID_HOST=${ID_HOST#\[}; ID_HOST=${ID_HOST%\]}
    [ -z "$PUBLIC_HOST" ] || [ "$PUBLIC_HOST" = "$ID_HOST" ] || fixed "the public address" "$ID_URL" --public-host
    PUBLIC_HOST=$ID_HOST
  fi
  say "keeping the identity of node $ID_NODE (roles $ROLES${PUBLIC_HOST:+, $PUBLIC_HOST})"
  # Options not given again keep the values the service runs with.
  for opt in egress-cap-gb:EGRESS uplink-mbps:UPLINK matches:MATCHES; do
    var=${opt#*:}
    if [ -z "${!var}" ]; then
      prev=$(unit_run_arg "${opt%%:*}")
      if [ -n "$prev" ]; then printf -v "$var" '%s' "$prev"; say "keeping --${opt%%:*} $prev"; fi
    fi
  done
fi

HOSTING=0
case "$ROLES" in *host*) HOSTING=1 ;; esac
# Caddy, the public address and the firewall only matter for a host reached over wss.
WSS=0
if [ "$HOSTING" = 1 ] && [ "$TRANSPORT" = wss ]; then WSS=1; fi

if [ "$WSS" = 1 ]; then
  # -4: a dual-stack machine would reach the (proxied) control plane over IPv6 and get that address
  # back, while players and the A record use IPv4.
  MY_IPV4=$(curl -4 -fsS --max-time 20 "$CONTROL/nodes/whoami" 2>/dev/null | sed -n 's/.*"ip" *: *"\([^"]*\)".*/\1/p' || true)
  if [ -z "$PUBLIC_HOST" ]; then
    is_ipv4 "$MY_IPV4" || die "could not detect the public IPv4 ($CONTROL/nodes/whoami): pass --public-host"
    PUBLIC_HOST=$MY_IPV4
  fi
  is_ip "$PUBLIC_HOST" || is_dns_name "$PUBLIC_HOST" || die "the public address $PUBLIC_HOST is not an IP address or a DNS name"
  if ! is_ip "$PUBLIC_HOST"; then
    say "DNS: $PUBLIC_HOST"
    is_ipv4 "$MY_IPV4" || die "could not get this machine's public IPv4 from $CONTROL/nodes/whoami to check $PUBLIC_HOST"
    WHY=$(dns_leads_here "$(dns_ipv4 "$PUBLIC_HOST")" "$MY_IPV4" "$ALLOW_PROXIED") || die "$PUBLIC_HOST does not lead here: $WHY"
  fi
  case "$PUBLIC_HOST" in *:*) URL_HOST="[$PUBLIC_HOST]" ;; *) URL_HOST="$PUBLIC_HOST" ;; esac
  # Ports 80/443 must be free, or Caddy's own (a re-run): Caddy needs them for the certificate and
  # the players. Checked before Caddy is installed (its package starts it) and before the token is spent.
  BUSY=$(ss -Hltnp '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v '"caddy"' || true)
  [ -z "$BUSY" ] || { printf '%s\n' "$BUSY" >&2; die "ports 80/443 are in use by another program (above): stop it, then run this again"; }
fi

if [ "$WSS" = 1 ] && ! command -v caddy >/dev/null; then
  say "Caddy (official repository)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt_update
  apt_get install -y -qq caddy >/dev/null
fi
if [ "$WSS" = 1 ]; then
  CADDY_VERSION=$(caddy version 2>/dev/null | head -n 1 || true)
  # An IP certificate needs the ACME profile support of Caddy 2.10; stream_close_delay, 2.7.
  # Distribution packages are often older than the official repository's.
  if is_ip "$PUBLIC_HOST"; then
    version_at_least "$CADDY_VERSION" 2 10 || die "Caddy ${CADDY_VERSION%% *} is too old for an IP-address certificate (2.10 or newer): remove it (apt-get remove caddy) and run this again to get the official package, or use a DNS name in --public-host"
  else
    version_at_least "$CADDY_VERSION" 2 7 || die "Caddy ${CADDY_VERSION%% *} is too old (2.7 or newer): remove it (apt-get remove caddy) and run this again to get the official package"
  fi
fi

say "user and directories"
id turbogol >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin turbogol
mkdir -p "$APP" "$DATA"
chown turbogol:turbogol "$DATA"
chmod 700 "$DATA"
# CHANGED: something the running service uses was replaced, so a re-run restarts it.
CHANGED=0
printf '%s' "$RELEASE_KEY_B64URL" > "$DATA/release-key.pub.new"
if put_file "$DATA/release-key.pub.new" "$DATA/release-key.pub" 644 turbogol; then CHANGED=1; fi
printf '%s\n' "$RELEASE_KEY_PEM" > "$APP/release-key.pem"

say "launcher (signature check)"
curl -fsSL "$CONTROL/nodes/releases/launcher.mjs" -o "$APP/launcher.mjs.new"
SIG=$(curl -fsSL "$CONTROL/nodes/releases/launcher.mjs.sig" | tr '_-' '/+')
while [ $(( ${#SIG} % 4 )) -ne 0 ]; do SIG="$SIG="; done
printf '%s' "$SIG" | base64 -d > "$APP/launcher.sig.bin"
openssl pkeyutl -verify -pubin -inkey "$APP/release-key.pem" -rawin -in "$APP/launcher.mjs.new" -sigfile "$APP/launcher.sig.bin" >/dev/null \
  || die "the launcher's signature does not verify: refusing to install"
if put_file "$APP/launcher.mjs.new" "$APP/launcher.mjs" 644; then CHANGED=1; fi
rm -f "$APP/launcher.sig.bin"

if [ -n "$RESTORE" ] && [ ! -f "$DATA/node.json" ]; then
  say "identity: restoring $RESTORE"
  install -m 600 -o turbogol -g turbogol "$RESTORE" "$DATA/node.json"
fi

if [ "$WSS" = 1 ]; then
  say "Caddy: HTTPS on $PUBLIC_HOST -> 127.0.0.1:$PORT"
  # Validated before it replaces the running config, and before the token is spent.
  NEW_CADDYFILE=$(mktemp)
  caddyfile "$PUBLIC_HOST" "$PORT" > "$NEW_CADDYFILE"
  if ! OUT=$(caddy validate --config "$NEW_CADDYFILE" --adapter caddyfile 2>&1); then
    rm -f "$NEW_CADDYFILE"
    printf '%s\n' "$OUT" >&2
    die "Caddy does not accept the generated configuration (see above)"
  fi
  systemctl enable caddy >/dev/null 2>&1 || true
  # A reload keeps the players' connections open (stream_close_delay); a stopped Caddy is started.
  if put_file "$NEW_CADDYFILE" /etc/caddy/Caddyfile 644 || ! systemctl is-active --quiet caddy; then
    systemctl reload-or-restart caddy || systemctl restart caddy || die "Caddy did not start: journalctl -u caddy"
  fi
  if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
fi

if [ "$REGISTER" = 1 ]; then
  say "registration"
  PUBLIC_URL_ARGS=()
  if [ "$HOSTING" = 1 ]; then PUBLIC_URL_ARGS=(--transport "$TRANSPORT"); fi
  if [ "$WSS" = 1 ]; then PUBLIC_URL_ARGS+=(--public-url "wss://$URL_HOST"); fi
  REG_ARGS=(--control "$CONTROL" --data "$DATA" --token "$TOKEN" --roles "$ROLES" "${PUBLIC_URL_ARGS[@]}")
  [ -n "$NAME" ] && REG_ARGS+=(--name "$NAME")
  [ -n "$UPLINK" ] && REG_ARGS+=(--uplink-mbps "$UPLINK")
  [ -n "$MATCHES" ] && REG_ARGS+=(--matches "$MATCHES")
  runuser -u turbogol -- node "$APP/launcher.mjs" register "${REG_ARGS[@]}" || die "registration failed (tokens are single use and expire after an hour: create a new one on the website)"
fi

RUN_ARGS="--port $PORT --listen 127.0.0.1"
[ -n "$EGRESS" ] && RUN_ARGS="$RUN_ARGS --egress-cap-gb $EGRESS"
[ -n "$UPLINK" ] && RUN_ARGS="$RUN_ARGS --uplink-mbps $UPLINK"
[ -n "$MATCHES" ] && RUN_ARGS="$RUN_ARGS --matches $MATCHES"
say "service"
NEW_UNIT=$(mktemp)
cat > "$NEW_UNIT" <<EOF
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
if put_file "$NEW_UNIT" "$UNIT" 644; then CHANGED=1; fi
systemctl daemon-reload
systemctl enable turbogol-node >/dev/null 2>&1
if ! systemctl is-active --quiet turbogol-node; then
  systemctl start turbogol-node
elif [ "$CHANGED" = 1 ]; then
  # A restart is a stop first: the node finishes its running matches (no new ones meanwhile), so
  # do not wait for it here.
  systemctl restart --no-block turbogol-node
  say "the node restarts with the new launcher and settings once its running matches end (up to 30 min)"
else
  say "the node is running and nothing changed: not restarted"
fi

say "done. Logs: journalctl -u turbogol-node -f    Status on the website: 'Mis servidores'."

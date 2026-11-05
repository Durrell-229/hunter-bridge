#!/usr/bin/env bash
#===============================================================================
# Hunter Tunnel — chisel durci + proxychains + receiver Colab durci
#
# Remplace les fonctions chisel/proxychains/colab de hunter-wrapper.sh avec :
#   - chisel server bind 127.0.0.1 + --auth obligatoire (secret 600 persisté)
#   - client local SOCKS5 bind 127.0.0.1 explicite
#   - attente de démarrage qui marche (ss : *:PORT ou 127.0.0.1:PORT)
#   - proxychains.conf : loopback seule en localnet (les cibles 10/172/192
#     passent par le tunnel au lieu de sortir en direct)
#   - receiver Colab : bind loopback, traversée de chemin et écriture
#     arbitraire bloquées (realpath + confinement)
#   - remotes chisel corrects : le trafic sort par NOTRE VPN, pas côté IA
#   - mode serveur distant réellement implémenté (HUNTER_CHISEL_SERVER)
#
# Commandes :
#   hunter-tunnel start|stop|restart|status
#   hunter-tunnel proxy-check [url]     egress direct vs tunnel (anonymat)
#   hunter-tunnel proxychains-check     témoin à travers proxychains4
#   hunter-tunnel colab-start|colab-stop|colab-status|colab-cmd
#   hunter-tunnel cmd-ia                commande prête pour une IA externe
#
# Variables :
#   HUNTER_CHISEL_SERVER=host:port      mode client vers un serveur distant
#   HUNTER_CHISEL_KEY=user:pass         auth du serveur distant
#   CHISEL_SERVER_PORT / CHISEL_SOCKS_PORT / CHISEL_BIND_HOST
#   HUNTER_PROXYCHAINS_LOCALNET=10.8.0.0/8,192.168.5.0/24   exceptions directes
#   HUNTER_CHISEL_NO_PUBLIC=1           ne pas démarrer le tunnel Cloudflare
#===============================================================================
set -euo pipefail

HUNTER_TOOLS="${HUNTER_TOOLS:-$HOME/.local/share/hunter}"
CHISEL_BIN="${CHISEL_BIN:-$HUNTER_TOOLS/bin/chisel}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$(command -v cloudflared 2>/dev/null || echo "$HUNTER_TOOLS/bin/cloudflared")}"
PROXYCHAINS_CONF="${PROXYCHAINS_CONF:-$HUNTER_TOOLS/etc/proxychains.conf}"
ETC_DIR="$HUNTER_TOOLS/etc"
mkdir -p "$ETC_DIR" 2>/dev/null || true

CHISEL_SERVER_PORT="${CHISEL_SERVER_PORT:-8080}"
CHISEL_SOCKS_PORT="${CHISEL_SOCKS_PORT:-1080}"
CHISEL_BIND_HOST="${CHISEL_BIND_HOST:-127.0.0.1}"

CHISEL_AUTH_USER="${CHISEL_AUTH_USER:-hunter}"
CHISEL_AUTH_FILE="${CHISEL_AUTH_FILE:-$HOME/.config/hunter/chisel-auth}"
CHISEL_FINGERPRINT_FILE="$ETC_DIR/chisel-fingerprint"

CHISEL_PID_FILE="${CHISEL_PID_FILE:-/tmp/hunter-chisel-server.pid}"
CHISEL_LOG_FILE="${CHISEL_LOG_FILE:-/tmp/hunter-chisel-server.log}"
CHISEL_CLIENT_PID_FILE="${CHISEL_CLIENT_PID_FILE:-/tmp/hunter-chisel-client.pid}"
CHISEL_CLIENT_LOG_FILE="${CHISEL_CLIENT_LOG_FILE:-/tmp/hunter-chisel-client.log}"
CLOUDFLARED_PID_FILE="${CLOUDFLARED_PID_FILE:-/tmp/hunter-cloudflared.pid}"
CLOUDFLARED_LOG_FILE="${CLOUDFLARED_LOG_FILE:-/tmp/hunter-cloudflared.log}"
CHISEL_PUBLIC_URL_FILE="${CHISEL_PUBLIC_URL_FILE:-/tmp/hunter-chisel-public-url.txt}"

COLAB_RECEIVER_PORT="${COLAB_RECEIVER_PORT:-8888}"
COLAB_BIND_HOST="${COLAB_BIND_HOST:-127.0.0.1}"
COLAB_ARTIFACTS_DIR="${COLAB_ARTIFACTS_DIR:-$HOME/hunter-colab-artifacts}"
COLAB_RECEIVER_PID_FILE="${COLAB_RECEIVER_PID_FILE:-/tmp/hunter-colab-receiver.pid}"
COLAB_RECEIVER_LOG_FILE="${COLAB_RECEIVER_LOG_FILE:-/tmp/hunter-colab-receiver.log}"
COLAB_RECEIVER_PY="$ETC_DIR/colab-receiver.py"
COLAB_CMD_FILE="$ETC_DIR/colab-chisel-cmd.txt"
IA_CMD_FILE="$ETC_DIR/ia-chisel-cmd.txt"

CHISEL_REMOTE_SERVER="${HUNTER_CHISEL_SERVER:-}"
CHISEL_REMOTE_KEY="${HUNTER_CHISEL_KEY:-}"

# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

chisel_ok() { [[ -x "$CHISEL_BIN" ]] || have "$CHISEL_BIN"; }

# Vrai si un port écoute, quel que soit le bind (ss affiche *:P ou 127.0.0.1:P).
port_listening() {
  local port="$1"
  ss -tln 2>/dev/null | awk -v p="$port" '
    NR > 1 {
      n = split($4, a, ":")
      if (a[n] == p) { found = 1; exit }
    }
    END { exit(found ? 0 : 1) }
  '
}

pid_alive() {
  local f="$1"
  [[ -f "$f" ]] || return 1
  local pid
  pid="$(cat "$f" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

kill_pid_file() {
  local f="$1" label="$2"
  if pid_alive "$f"; then
    local pid
    pid="$(cat "$f")"
    echo "🛑 Arrêt $label (pid $pid)..."
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$f"
}

# ---------------------------------------------------------------------------
# Auth chisel : user:pass généré une fois, stocké 600 hors du dépôt
# ---------------------------------------------------------------------------

ensure_chisel_auth() {
  if [[ -n "${CHISEL_AUTH_VALUE:-}" ]]; then return 0; fi
  if [[ -r "$CHISEL_AUTH_FILE" ]]; then
    CHISEL_AUTH_VALUE="$(head -n 1 "$CHISEL_AUTH_FILE" | tr -d '\r\n')"
    [[ -n "$CHISEL_AUTH_VALUE" ]] && return 0
  fi
  local pass
  pass="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24 || true)"
  if [[ -z "$pass" ]]; then
    echo "❌ Impossible de générer le secret chisel." >&2
    return 1
  fi
  mkdir -p "$(dirname "$CHISEL_AUTH_FILE")"
  umask 077
  printf '%s:%s\n' "$CHISEL_AUTH_USER" "$pass" > "$CHISEL_AUTH_FILE"
  chmod 600 "$CHISEL_AUTH_FILE"
  CHISEL_AUTH_VALUE="$CHISEL_AUTH_USER:$pass"
  echo "🔑 Secret chisel généré : $CHISEL_AUTH_FILE (600) — user: $CHISEL_AUTH_USER"
}

# user:pass pour l'affichage (masqué) : hunter:********
masked_auth() {
  local v="${CHISEL_AUTH_VALUE:-}"
  if [[ -z "$v" && -r "$CHISEL_AUTH_FILE" ]]; then
    v="$(head -n 1 "$CHISEL_AUTH_FILE" | tr -d '\r\n')"
  fi
  if [[ -n "$v" ]]; then
    printf '%s:********' "${v%%:*}"
  else
    printf 'absent'
  fi
}

# ---------------------------------------------------------------------------
# proxychains.conf — le point clé : ne PAS exclure les réseaux de cibles
# ---------------------------------------------------------------------------

generate_proxychains_conf() {
  {
    cat <<EOF
# Hunter Bridge — proxychains auto-généré (hunter-tunnel)
# SOCKS5 chisel : 127.0.0.1:$CHISEL_SOCKS_PORT
# ATTENTION : localnet = réseaux qui sortent EN DIRECT, sans le tunnel.
# Les réseaux privés de cibles CTF (10/8, 172.16/12, 192.168/16) ne doivent
# PAS y figurer, sinon nmap/curl les atteignent sans passer par le VPN.
strict_chain
proxy_dns
remote_dns_subnet 224
tcp_read_time_out 15000
tcp_connect_time_out 8000
localnet 127.0.0.0/255.0.0.0
EOF
    if [[ -n "${HUNTER_PROXYCHAINS_LOCALNET:-}" ]]; then
      local net
      for net in ${HUNTER_PROXYCHAINS_LOCALNET//,/ }; do
        echo "localnet $net"
      done
    fi
    printf '\n[ProxyList]\nsocks5 127.0.0.1 %s\n' "$CHISEL_SOCKS_PORT"
  } > "$PROXYCHAINS_CONF"
  chmod 600 "$PROXYCHAINS_CONF" 2>/dev/null || true
  echo "✅ proxychains.conf : $PROXYCHAINS_CONF (SOCKS5 127.0.0.1:$CHISEL_SOCKS_PORT)"
}

# ---------------------------------------------------------------------------
# Démarrage : serveur local durci ou client vers serveur distant
# ---------------------------------------------------------------------------

start_chisel_server_local() {
  ensure_chisel_auth || return 1
  if pid_alive "$CHISEL_PID_FILE" && port_listening "$CHISEL_SERVER_PORT"; then
    echo "✅ Chisel server déjà actif (pid $(cat "$CHISEL_PID_FILE"))."
    return 0
  fi
  rm -f "$CHISEL_PID_FILE" "$CHISEL_FINGERPRINT_FILE"
  : > "$CHISEL_LOG_FILE"
  echo "🚀 Chisel server : $CHISEL_BIND_HOST:$CHISEL_SERVER_PORT (auth $(masked_auth), socks5, reverse)"
  nohup "$CHISEL_BIN" server \
    --host "$CHISEL_BIND_HOST" \
    --port "$CHISEL_SERVER_PORT" \
    --socks5 \
    --reverse \
    --auth "$CHISEL_AUTH_VALUE" \
    >>"$CHISEL_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$CHISEL_PID_FILE"

  local i
  for i in $(seq 1 20); do
    if port_listening "$CHISEL_SERVER_PORT"; then
      echo "✅ Chisel server actif (pid $pid) — bind $CHISEL_BIND_HOST:$CHISEL_SERVER_PORT"
      grep -oE 'Fingerprint [A-Za-z0-9+/=]+' "$CHISEL_LOG_FILE" | head -n 1 \
        | awk '{print $2}' > "$CHISEL_FINGERPRINT_FILE" 2>/dev/null || true
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "❌ Chisel server mort au démarrage :" >&2
      tail -n 5 "$CHISEL_LOG_FILE" >&2
      rm -f "$CHISEL_PID_FILE"
      return 1
    fi
    sleep 0.5
  done
  echo "❌ Chisel server non prêt après 10 s (voir $CHISEL_LOG_FILE)" >&2
  return 1
}

start_chisel_client_local_socks() {
  ensure_chisel_auth || return 1
  if pid_alive "$CHISEL_CLIENT_PID_FILE" && port_listening "$CHISEL_SOCKS_PORT"; then
    echo "✅ SOCKS5 local déjà actif sur 127.0.0.1:$CHISEL_SOCKS_PORT."
    return 0
  fi
  rm -f "$CHISEL_CLIENT_PID_FILE"
  : > "$CHISEL_CLIENT_LOG_FILE"
  # Remote « 127.0.0.1:PORT:socks » : bind loopback explicite côté client,
  # et sortie par le SOCKS5 interne du serveur (donc par notre VPN).
  echo "🔗 Chisel client local : 127.0.0.1:$CHISEL_SOCKS_PORT → socks (via 127.0.0.1:$CHISEL_SERVER_PORT)"
  nohup "$CHISEL_BIN" client \
    --auth "$CHISEL_AUTH_VALUE" \
    "127.0.0.1:$CHISEL_SERVER_PORT" \
    "127.0.0.1:$CHISEL_SOCKS_PORT:socks" \
    >>"$CHISEL_CLIENT_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$CHISEL_CLIENT_PID_FILE"

  local i
  for i in $(seq 1 20); do
    if port_listening "$CHISEL_SOCKS_PORT"; then
      echo "✅ SOCKS5 prêt : 127.0.0.1:$CHISEL_SOCKS_PORT (pid $pid)"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "❌ Chisel client mort au démarrage :" >&2
      tail -n 5 "$CHISEL_CLIENT_LOG_FILE" >&2
      rm -f "$CHISEL_CLIENT_PID_FILE"
      return 1
    fi
    sleep 0.5
  done
  echo "❌ SOCKS5 local non prêt après 10 s (voir $CHISEL_CLIENT_LOG_FILE)" >&2
  return 1
}

start_chisel_client_remote() {
  if [[ -z "$CHISEL_REMOTE_SERVER" ]]; then return 0; fi
  if pid_alive "$CHISEL_CLIENT_PID_FILE" && port_listening "$CHISEL_SOCKS_PORT"; then
    echo "✅ Client distant déjà actif (SOCKS5 127.0.0.1:$CHISEL_SOCKS_PORT)."
    return 0
  fi
  [[ -n "$CHISEL_REMOTE_KEY" ]] || { echo "❌ HUNTER_CHISEL_KEY requis (user:pass)." >&2; return 1; }
  rm -f "$CHISEL_CLIENT_PID_FILE"
  : > "$CHISEL_CLIENT_LOG_FILE"
  echo "🔗 Chisel client → serveur distant $CHISEL_REMOTE_SERVER (SOCKS5 local :$CHISEL_SOCKS_PORT)"
  nohup "$CHISEL_BIN" client \
    --auth "$CHISEL_REMOTE_KEY" \
    "$CHISEL_REMOTE_SERVER" \
    "127.0.0.1:$CHISEL_SOCKS_PORT:socks" \
    >>"$CHISEL_CLIENT_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$CHISEL_CLIENT_PID_FILE"
  local i
  for i in $(seq 1 20); do
    if port_listening "$CHISEL_SOCKS_PORT"; then
      echo "✅ SOCKS5 via serveur distant prêt : 127.0.0.1:$CHISEL_SOCKS_PORT"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "❌ Client distant mort :" >&2; tail -n 5 "$CHISEL_CLIENT_LOG_FILE" >&2
      rm -f "$CHISEL_CLIENT_PID_FILE"
      return 1
    fi
    sleep 0.5
  done
  echo "❌ SOCKS5 distant non prêt après 10 s." >&2
  return 1
}

start_cloudflared() {
  if [[ "${HUNTER_CHISEL_NO_PUBLIC:-0}" == "1" ]]; then
    echo "⏭  Tunnel public ignoré (HUNTER_CHISEL_NO_PUBLIC=1)."
    return 0
  fi
  if ! have "$CLOUDFLARED_BIN"; then
    echo "⚠️  cloudflared absent — pas d'URL publique (les IA externes ne pourront pas se connecter)."
    return 0
  fi
  if pid_alive "$CLOUDFLARED_PID_FILE"; then
    echo "✅ Tunnel Cloudflare déjà actif."
    return 0
  fi
  : > "$CLOUDFLARED_LOG_FILE"
  echo "🌐 Tunnel Cloudflare → 127.0.0.1:$CHISEL_SERVER_PORT..."
  nohup "$CLOUDFLARED_BIN" tunnel \
    --url "http://127.0.0.1:$CHISEL_SERVER_PORT" \
    --no-autoupdate >>"$CLOUDFLARED_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$CLOUDFLARED_PID_FILE"

  local url="" i
  for i in $(seq 1 60); do
    url="$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$CLOUDFLARED_LOG_FILE" 2>/dev/null | tail -n 1 || true)"
    [[ -n "$url" ]] && break
    kill -0 "$pid" 2>/dev/null || { echo "❌ cloudflared mort (voir $CLOUDFLARED_LOG_FILE)"; rm -f "$CLOUDFLARED_PID_FILE"; return 1; }
    sleep 0.5
  done
  if [[ -n "$url" ]]; then
    echo "$url" > "$CHISEL_PUBLIC_URL_FILE"
    chmod 600 "$CHISEL_PUBLIC_URL_FILE" 2>/dev/null || true
    echo "✅ URL publique : $url"
    write_ia_cmd "$url"
  else
    echo "⚠️  URL publique non reçue en 30 s (voir $CLOUDFLARED_LOG_FILE)"
  fi
}

# Commande prête pour une IA externe / Colab : remotes NORMAUX (pas R:)
# pour que le trafic sorte par notre VPN, pas par la machine de l'IA.
write_ia_cmd() {
  local url="$1"
  local fp
  fp="$(cat "$CHISEL_FINGERPRINT_FILE" 2>/dev/null || true)"
  {
    echo "# À exécuter sur la machine distante (IA / VPS) :"
    echo "chisel client --auth '$CHISEL_AUTH_VALUE' ${fp:+--fingerprint '$fp'} '$url' 1080:socks"
    echo "# Puis sur cette machine distante : proxychains4 -f <conf> nmap -sT -Pn 192.168.5.65"
    echo "# (conf : strict_chain, proxy_dns, [ProxyList] socks5 127.0.0.1 1080)"
  } > "$IA_CMD_FILE"
  chmod 600 "$IA_CMD_FILE" 2>/dev/null || true
  echo "📋 Commande IA prête : $IA_CMD_FILE"
}

tunnel_start() {
  chisel_ok || { echo "❌ chisel introuvable : $CHISEL_BIN" >&2; return 1; }
  if [[ -n "$CHISEL_REMOTE_SERVER" ]]; then
    start_chisel_client_remote || return 1
  else
    start_chisel_server_local || return 1
    start_chisel_client_local_socks || return 1
    start_cloudflared
  fi
  generate_proxychains_conf
  tunnel_proxy_check_hint
}

tunnel_proxy_check_hint() {
  echo ""
  echo "Vérifier l'anonymat :   hunter-tunnel proxy-check"
  echo "Témoin proxychains :    hunter-tunnel proxychains-check"
  echo "Atteindre une cible :   proxychains4 -f $PROXYCHAINS_CONF nmap -sT -Pn 192.168.5.65"
  echo "Empilement complet :    hunter-tunnel auto"
}

# ---------------------------------------------------------------------------
# Pré-flight « jamais bloqué » + empilement complet
# ---------------------------------------------------------------------------

have_tun() {
  ip -o link show 2>/dev/null | grep -qE '^[0-9]+: (tun|tap|wg)[0-9]+:'
}

openvpn_count() {
  local n
  n="$(pgrep -x openvpn 2>/dev/null | wc -l || true)"
  echo "${n:-0}"
}

probe_internet() {
  curl -4 -m 8 -s -o /dev/null -w '%{http_code}' https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -qE '^[1-5][0-9][0-9]$'
}

# Répare l'état réseau avant un CTF. Chaque étape ne casse jamais la suivante,
# et Internet reste la priorité absolue (les IA dépendent de ta connexion).
tunnel_pre() {
  echo "═══ Hunter Tunnel — pre-flight ═══"
  local problems=0

  # 1) Internet d'abord : sans lui, rien ne marche (IA, clés API, Cloudflare).
  if probe_internet; then
    echo "✅ Internet direct OK"
  else
    echo "❌ Internet direct INJOIGNABLE — priorité absolue" >&2
    echo "   → Vérifie ta connexion Wi-Fi/ethernet avant de continuer" >&2
    problems=$((problems + 1))
  fi

  # 2) OpenVPN : une instance, pas deux (les doublons coupent tout).
  local n
  n="$(openvpn_count)"
  if (( n > 1 )); then
    echo "⚠️  $n instances OpenVPN détectées — cause de coupures réseau"
    echo "   → Répare avec : hunter vpn-reset  (ou : sudo pkill -x openvpn && relance le VPN)"
    problems=$((problems + 1))
  elif (( n == 1 )) && have_tun; then
    echo "✅ VPN connecté (1 instance, tun actif) — cibles CTF joignables, Internet direct préservé"
  elif (( n == 0 )); then
    echo "ℹ️  Pas de VPN actif — normal si le challenge n'en demande pas"
  else
    echo "⚠️  OpenVPN tourne sans interface tun — état incohérent"
    echo "   → Répare avec : hunter vpn-reset"
    problems=$((problems + 1))
  fi

  # 3) Tunnel chisel : cohérence pidfile ↔ port ↔ process
  if pid_alive "$CHISEL_PID_FILE" && ! port_listening "$CHISEL_SERVER_PORT"; then
    echo "⚠️  Chisel server : pid vivant mais port $CHISEL_SERVER_PORT muet — nettoyage"
    kill_pid_file "$CHISEL_PID_FILE" "chisel server"
  fi
  if port_listening "$CHISEL_SOCKS_PORT" && ! pid_alive "$CHISEL_CLIENT_PID_FILE"; then
    echo "⚠️  SOCKS5 $CHISEL_SOCKS_PORT actif sans pidfile — état zombie"
    echo "   → Répare avec : hunter-tunnel restart"
    problems=$((problems + 1))
  fi
  if pid_alive "$CHISEL_PID_FILE" && port_listening "$CHISEL_SERVER_PORT"; then
    echo "✅ Tunnel chisel déjà actif"
  else
    echo "ℹ️  Tunnel non démarré — sera lancé par hunter-tunnel auto/start"
  fi

  # 4) Outils
  command -v proxychains4 >/dev/null 2>&1 \
    && echo "✅ proxychains4 présent" \
    || { echo "⚠️  proxychains4 absent : sudo pacman -S proxychains-ng"; problems=$((problems + 1)); }
  chisel_ok \
    && echo "✅ chisel présent" \
    || { echo "❌ chisel absent : $CHISEL_BIN"; problems=$((problems + 1)); }
  command -v nmap >/dev/null 2>&1 \
    && echo "✅ nmap présent" \
    || echo "ℹ️  nmap absent (utile pour les scans)"

  # 5) Anonymat de secours si le tunnel tourne déjà
  if pid_alive "$CHISEL_CLIENT_PID_FILE" && port_listening "$CHISEL_SOCKS_PORT"; then
    tunnel_proxy_check 2>/dev/null | tail -n 1 || true
  fi

  echo "═══ Pre-flight terminé ($problems problème(s)) ═══"
  (( problems == 0 )) || return 1
  return 0
}

# Attend qu'un hôte/port devienne joignable À TRAVERS le SOCKS5 (challenge
# qui démarre, VPN qui monte, cible qui s'allume). Sort au premier succès.
tunnel_wait_net() {
  local host="${1:-}"
  local port="${2:-80}"
  local timeout_s="${3:-60}"
  if [[ -z "$host" ]]; then
    echo "Usage : hunter-tunnel wait-net <host> [port] [timeout_s]" >&2
    return 2
  fi
  echo "⏳ Attente de $host:$port via SOCKS5 127.0.0.1:$CHISEL_SOCKS_PORT (max ${timeout_s}s)..."
  local i code
  for i in $(seq 1 "$timeout_s"); do
    code="$(curl -s -m 4 -o /dev/null -w '%{http_code}' \
      --proxy "socks5h://127.0.0.1:$CHISEL_SOCKS_PORT" \
      "http://$host:$port/" 2>/dev/null || true)"
    if [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]; then
      echo "✅ $host:$port répond (HTTP $code) après ${i}s"
      return 0
    fi
    sleep 1
  done
  echo "❌ $host:$port toujours injoignable après ${timeout_s}s via le tunnel" >&2
  return 1
}

# Empilement complet : Internet d'abord, VPN, puis tunnel, puis Colab.
# Aucune étape n'est fatale : les échecs sont signalés, la suite continue.
tunnel_auto() {
  echo "═══ Hunter Tunnel — auto (empilement complet) ═══"
  tunnel_pre || true
  echo ""
  echo "── Tunnel ──"
  tunnel_start || echo "⚠️  Tunnel non démarré — poursuite (Internet reste OK)"
  echo ""
  echo "── Colab receiver ──"
  colab_start || echo "⚠️  Colab receiver non démarré — poursuite"
  echo ""
  echo "═══ Prêt ═══"
  echo "Internet : OK — IA et clés API sur ta connexion locale, jamais via le VPN"
  if have_tun; then
    echo "VPN      : actif — cibles CTF joignables en direct"
  else
    echo "VPN      : inactif (lance 'hunter' si le challenge en demande un)"
  fi
  if port_listening "$CHISEL_SOCKS_PORT"; then
    echo "Tunnel   : SOCKS5 127.0.0.1:$CHISEL_SOCKS_PORT actif"
    echo "IA externe : hunter-tunnel cmd-ia  (leur trafic sort par TON VPN)"
  fi
  if [[ -s "$CHISEL_PUBLIC_URL_FILE" ]]; then
    echo "URL publique : $(cat "$CHISEL_PUBLIC_URL_FILE")"
  fi
  echo "Cibles   : proxychains4 -f $PROXYCHAINS_CONF nmap -sT -Pn <cible>"
  echo "Ou direct : curl --proxy socks5h://127.0.0.1:$CHISEL_SOCKS_PORT http://<cible>/"
}

tunnel_stop() {
  kill_pid_file "$CLOUDFLARED_PID_FILE" "cloudflared"
  pkill -f "cloudflared tunnel --url http://127.0.0.1:$CHISEL_SERVER_PORT" 2>/dev/null || true
  kill_pid_file "$CHISEL_CLIENT_PID_FILE" "chisel client local"
  pkill -f "chisel client --auth .* 127.0.0.1:$CHISEL_SERVER_PORT 127.0.0.1:$CHISEL_SOCKS_PORT:socks" 2>/dev/null || true
  kill_pid_file "$CHISEL_PID_FILE" "chisel server"
  pkill -f "chisel server --host $CHISEL_BIND_HOST --port $CHISEL_SERVER_PORT" 2>/dev/null || true
  rm -f "$CHISEL_PUBLIC_URL_FILE"
  echo "✅ Tunnel arrêté."
}

# ---------------------------------------------------------------------------
# Statut
# ---------------------------------------------------------------------------

tunnel_status() {
  echo "=== Hunter Tunnel ==="
  local chisel_state="ABSENT"
  if [[ -x "$CHISEL_BIN" ]] || have "$CHISEL_BIN"; then chisel_state="OK"; fi
  echo "chisel : $CHISEL_BIN $chisel_state"
  if pid_alive "$CHISEL_PID_FILE"; then
    echo "server : RUNNING (pid $(cat "$CHISEL_PID_FILE")) sur $CHISEL_BIND_HOST:$CHISEL_SERVER_PORT"
    port_listening "$CHISEL_SERVER_PORT" && echo "  port $CHISEL_SERVER_PORT : LISTEN" || echo "  port $CHISEL_SERVER_PORT : PAS DE LISTEN (incohérent)"
  else
    echo "server : STOPPED"
  fi
  if pid_alive "$CHISEL_CLIENT_PID_FILE"; then
    echo "client : RUNNING (pid $(cat "$CHISEL_CLIENT_PID_FILE")) — SOCKS5 127.0.0.1:$CHISEL_SOCKS_PORT"
    port_listening "$CHISEL_SOCKS_PORT" && echo "  port $CHISEL_SOCKS_PORT : LISTEN" || echo "  port $CHISEL_SOCKS_PORT : PAS DE LISTEN (incohérent)"
  else
    echo "client : STOPPED"
  fi
  if pid_alive "$CLOUDFLARED_PID_FILE" && [[ -s "$CHISEL_PUBLIC_URL_FILE" ]]; then
    echo "public : $(cat "$CHISEL_PUBLIC_URL_FILE")"
  else
    echo "public : —"
  fi
  [[ -s "$CHISEL_FINGERPRINT_FILE" ]] && echo "fingerprint : $(cat "$CHISEL_FINGERPRINT_FILE")"
  [[ -r "$CHISEL_AUTH_FILE" ]] && echo "auth   : $(masked_auth) (dans $CHISEL_AUTH_FILE)"
  [[ -f "$PROXYCHAINS_CONF" ]] && echo "proxychains : $PROXYCHAINS_CONF"
  if [[ -n "$CHISEL_REMOTE_SERVER" ]]; then
    echo "mode   : CLIENT distant ($CHISEL_REMOTE_SERVER)"
  else
    echo "mode   : SERVER local"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Vérifications d'anonymat et de routage
# ---------------------------------------------------------------------------

tunnel_proxy_check() {
  local target="${1:-https://www.cloudflare.com/cdn-cgi/trace}"
  echo "=== Egress direct vs tunnel (SOCKS5 127.0.0.1:$CHISEL_SOCKS_PORT) ==="
  local direct tunnel
  direct="$(curl -4 -s -m 8 "$target" 2>/dev/null | grep -E '^(ip|loc)=' | tr '\n' ' ' || true)"
  tunnel="$(curl -4 -s -m 12 --proxy "socks5h://127.0.0.1:$CHISEL_SOCKS_PORT" "$target" 2>/dev/null | grep -E '^(ip|loc)=' | tr '\n' ' ' || true)"
  echo "direct  : ${direct:-injoignable}"
  echo "tunnel  : ${tunnel:-ÉCHEC — le SOCKS5 ne répond pas}"
  if [[ -n "$tunnel" && "$tunnel" != "$direct" ]]; then
    echo "✅ Le trafic tunnel sort d'une IP différente du direct : masquage actif."
  elif [[ -n "$tunnel" ]]; then
    echo "⚠️  Même IP en direct et en tunnel : pas de masquage (VPN off ?)."
  fi
}

tunnel_proxychains_check() {
  if ! have proxychains4; then
    echo "❌ proxychains4 absent : sudo pacman -S proxychains-ng (ou apt install proxychains4)" >&2
    return 1
  fi
  echo "=== Témoin proxychains (doit sortir par le SOCKS5) ==="
  proxychains4 -q -f "$PROXYCHAINS_CONF" \
    curl -4 -s -m 15 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null \
    | grep -E '^(ip|loc)=' || echo "❌ Échec du témoin proxychains"
}

# ---------------------------------------------------------------------------
# Receiver Colab durci
# ---------------------------------------------------------------------------

install_colab_receiver() {
  cat > "$COLAB_RECEIVER_PY" <<'PYEOF'
#!/usr/bin/env python3
"""Receiver d'artefacts Colab — durci (confinement de chemins, bind loopback)."""
import http.server
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

ART = Path(os.environ.get("COLAB_ARTIFACTS_DIR", str(Path.home() / "hunter-colab-artifacts"))).resolve()
BIND = os.environ.get("COLAB_BIND_HOST", "127.0.0.1")
PORT = int(os.environ.get("COLAB_RECEIVER_PORT", "8888"))


def contained(base: Path, rel: str):
    """Résout rel sous base et refuse toute sortie du dossier (traversée)."""
    if "\x00" in rel:
        return None
    p = (base / rel).resolve()
    try:
        p.relative_to(base)
    except ValueError:
        return None
    return p


class Handler(http.server.BaseHTTPRequestHandler):
    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path == "/health":
            return self._json(200, {"status": "ok", "artifacts_dir": str(ART)})
        if path == "/list":
            files = []
            for root, _dirs, names in os.walk(ART):
                for name in names:
                    p = Path(root) / name
                    st = p.stat()
                    files.append({"path": str(p.relative_to(ART)), "size": st.st_size, "mtime": st.st_mtime})
            return self._json(200, {"files": files})
        if path.startswith("/download/"):
            p = contained(ART, path[len("/download/"):])
            if p is None or not p.is_file():
                return self._json(404, {"error": "not found"})
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(p.stat().st_size))
            self.end_headers()
            with open(p, "rb") as f:
                http.server.copyfileobj(f, self.wfile)
            return
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        if path != "/upload":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", 0) or 0)
        data = self.rfile.read(length)
        params = parse_qs(urlparse(self.path).query)
        name = self.headers.get("X-Filename") or params.get("filename", [""])[0] or f"colab-{int(time.time())}.bin"
        name = name.replace("\\", "/").split("/")[-1].strip()
        if not name or name in {".", ".."} or name.startswith("."):
            return self._json(400, {"error": "nom de fichier refusé"})
        target = contained(ART / "raw", name)
        if target is None:
            return self._json(400, {"error": "chemin refusé"})
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        print(f"[Colab] reçu : {name} ({len(data)} o) → {target}", file=sys.stderr)
        return self._json(200, {"status": "ok", "file": str(target), "size": len(data)})

    def log_message(self, fmt, *args):
        print(f"[Colab Receiver] {self.address_string()} - {fmt % args}", file=sys.stderr)


if __name__ == "__main__":
    ART.mkdir(parents=True, exist_ok=True)
    srv = http.server.HTTPServer((BIND, PORT), Handler)
    print(f"[Colab Receiver] écoute {BIND}:{PORT}, artefacts : {ART}", file=sys.stderr)
    srv.serve_forever()
PYEOF
  chmod 700 "$COLAB_RECEIVER_PY"
}

colab_start() {
  if pid_alive "$COLAB_RECEIVER_PID_FILE" && curl -fsS -m 2 "http://127.0.0.1:$COLAB_RECEIVER_PORT/health" >/dev/null 2>&1; then
    echo "✅ Colab Receiver déjà actif (pid $(cat "$COLAB_RECEIVER_PID_FILE"))."
    return 0
  fi
  install_colab_receiver
  mkdir -p "$COLAB_ARTIFACTS_DIR"/{raw,forensic,extracted,reports}
  : > "$COLAB_RECEIVER_LOG_FILE"
  echo "🚀 Colab Receiver : $COLAB_BIND_HOST:$COLAB_RECEIVER_PORT (artefacts → $COLAB_ARTIFACTS_DIR)"
  COLAB_BIND_HOST="$COLAB_BIND_HOST" COLAB_RECEIVER_PORT="$COLAB_RECEIVER_PORT" COLAB_ARTIFACTS_DIR="$COLAB_ARTIFACTS_DIR" \
    nohup python3 "$COLAB_RECEIVER_PY" >>"$COLAB_RECEIVER_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$COLAB_RECEIVER_PID_FILE"
  local i
  for i in $(seq 1 10); do
    curl -fsS -m 2 "http://127.0.0.1:$COLAB_RECEIVER_PORT/health" >/dev/null 2>&1 && {
      echo "✅ Colab Receiver actif (pid $pid)"
      colab_cmd
      return 0
    }
    kill -0 "$pid" 2>/dev/null || { echo "❌ Receiver mort :" >&2; tail -n 5 "$COLAB_RECEIVER_LOG_FILE" >&2; rm -f "$COLAB_RECEIVER_PID_FILE"; return 1; }
    sleep 0.5
  done
  echo "❌ Colab Receiver non prêt (voir $COLAB_RECEIVER_LOG_FILE)" >&2
  return 1
}

colab_stop() {
  kill_pid_file "$COLAB_RECEIVER_PID_FILE" "Colab Receiver"
  pkill -f "colab-receiver.py" 2>/dev/null || true
  echo "✅ Colab Receiver arrêté."
}

colab_cmd() {
  local url=""
  [[ -s "$CHISEL_PUBLIC_URL_FILE" ]] && url="$(cat "$CHISEL_PUBLIC_URL_FILE")"
  if [[ -z "$url" ]]; then
    echo "⚠️  Pas d'URL publique (tunnel Cloudflare inactif) — les remotes Colab attendront le tunnel." >&2
    url="<URL_PUBLIQUE>"
  fi
  ensure_chisel_auth || return 1
  local fp
  fp="$(cat "$CHISEL_FINGERPRINT_FILE" 2>/dev/null || true)"
  {
    echo "# ============================================================"
    echo "# COLLER DANS UNE CELLULE GOOGLE COLAB"
    echo "# Remotes NORMAUX : 1080 sort par NOTRE VPN, 8888 pointe vers"
    echo "# notre receiver (upload artefacts). Jamais de R: ici."
    echo "# ============================================================"
    echo "! wget -q https://github.com/jpillora/chisel/releases/download/v1.12.0/chisel_1.12.0_linux_amd64.gz -O chisel.gz"
    echo "! gunzip -f chisel.gz && chmod +x chisel"
    echo "! ./chisel client --auth '$CHISEL_AUTH_VALUE' ${fp:+--fingerprint '$fp'} \\"
    echo "    '$url' \\"
    echo "    1080:socks \\"
    echo "    8888:127.0.0.1:$COLAB_RECEIVER_PORT \\"
    echo "    --keepalive 10s"
    echo ""
    echo "# Upload d'artefact depuis Colab :"
    echo "# curl -X POST --data-binary @rapport.json 'http://127.0.0.1:$COLAB_RECEIVER_PORT/upload?filename=rapport.json'"
    echo "# Scan via le VPN :"
    echo "# proxychains4 -f <conf> nmap -sT -Pn 192.168.5.65"
  } > "$COLAB_CMD_FILE"
  chmod 600 "$COLAB_CMD_FILE"
  echo "📋 Commande Colab : $COLAB_CMD_FILE (600 — contient le secret chisel)"
}

colab_status() {
  echo "=== Colab Worker ==="
  if pid_alive "$COLAB_RECEIVER_PID_FILE"; then
    echo "receiver : RUNNING (pid $(cat "$COLAB_RECEIVER_PID_FILE")) — $COLAB_BIND_HOST:$COLAB_RECEIVER_PORT"
    echo "artefacts : $COLAB_ARTIFACTS_DIR ($(find "$COLAB_ARTIFACTS_DIR" -type f 2>/dev/null | wc -l) fichiers)"
  else
    echo "receiver : STOPPED"
  fi
  [[ -s "$COLAB_CMD_FILE" ]] && echo "cmd Colab : $COLAB_CMD_FILE"
  [[ -s "$IA_CMD_FILE" ]] && echo "cmd IA   : $IA_CMD_FILE"
  return 0
}

# ---------------------------------------------------------------------------
# Point d'entrée
# ---------------------------------------------------------------------------

usage() {
  cat <<'EOF'
hunter-tunnel — chisel durci + proxychains + receiver Colab

  start              démarre chisel (server local ou client distant) + SOCKS5 + tunnel public
  stop               arrête tout proprement
  restart            stop + start
  auto               pre-flight + tunnel + Colab (empilement complet, jamais bloquant)
  pre                pre-flight réseau : Internet, VPN, doublons OpenVPN, zombies
  wait-net <h> [p] [t]  attend qu'une cible réponde via le SOCKS5 (challenge qui démarre)
  status             état des composants, URL publique, fingerprint
  proxy-check [url]  compare l'IP de sortie directe vs tunnel (anonymat)
  proxychains-check  requête témoin à travers proxychains4
  colab-start        démarre le receiver d'artefacts durci
  colab-stop         arrête le receiver
  colab-status       état du receiver
  colab-cmd          (re)génère la commande à coller dans Google Colab
  cmd-ia             affiche la commande chisel prête pour une IA externe

Variables : HUNTER_CHISEL_SERVER=host:port + HUNTER_CHISEL_KEY=user:pass (mode
distant), CHISEL_BIND_HOST, CHISEL_SERVER_PORT, CHISEL_SOCKS_PORT,
HUNTER_PROXYCHAINS_LOCALNET (exceptions directes), HUNTER_CHISEL_NO_PUBLIC=1.
EOF
}

main() {
  local cmd="${1:-status}"
  shift || true
  case "$cmd" in
    start)    tunnel_start ;;
    stop)     tunnel_stop ;;
    restart)  tunnel_stop; tunnel_start ;;
    auto)     tunnel_auto ;;
    pre)      tunnel_pre ;;
    wait-net) tunnel_wait_net "$@" ;;
    status)   tunnel_status ;;
    proxy-check) tunnel_proxy_check "$@" ;;
    proxychains-check) tunnel_proxychains_check ;;
    colab-start)  colab_start ;;
    colab-stop)   colab_stop ;;
    colab-status) colab_status ;;
    colab-cmd)    colab_cmd ;;
    cmd-ia)
      [[ -s "$IA_CMD_FILE" ]] && cat "$IA_CMD_FILE" || { echo "Pas de commande IA (tunnel public inactif)." >&2; exit 1; }
      ;;
    help|-h|--help) usage ;;
    *) echo "Commande inconnue : $cmd (voir hunter-tunnel help)" >&2; exit 2 ;;
  esac
}

main "$@"

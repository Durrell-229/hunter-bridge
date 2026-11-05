#!/usr/bin/env bash
#===============================================================================
# Hunter Bridge — lance tout en une commande :
#   VPN (split tunnel) → chisel/proxychains → proxy → MCP → plugins → Claude Code
#
# Variables utiles :
#   HUNTER_SKIP_VPN=1            ne pas toucher au VPN
#   HUNTER_VPN_FULL_TUNNEL=1     VPN en tunnel complet (tout le trafic)
#   HUNTER_PROFILE=...           profil de routage (défaut : ctf)
#   PORT=...                     port du proxy pour agy/hermes (défaut : 8787)
#   HUNTER_CHISEL_SERVER=...     serveur chisel distant (ex: user@host:port)
#   HUNTER_CHISEL_KEY=...        clé auth chisel (optionnel)
#   HUNTER_CHISEL_SOCKS_PORT=... port SOCKS local chisel client (défaut : 1080)
#   HUNTER_CHISEL_REMOTE_PORT=... port remote sur serveur chisel (défaut : 8080)
#===============================================================================
set -euo pipefail

ROOT="${HUNTER_ROOT:-__HUNTER_ROOT__}"
NODE_BIN="${HUNTER_NODE:-node}"
ENTRY="$ROOT/bin/hunter.js"
CFG="$ROOT/hunter.config.json"
ENV_FILE="$ROOT/.env"
PROXY_PORT="${PORT:-8787}"

export HUNTER_TOOLS="${HUNTER_TOOLS:-__HUNTER_TOOLS__}"
export PATH="$HUNTER_TOOLS/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
export HUNTER_ENV_FILE="$ENV_FILE"
# Le `sudo` de Hunter utilise le mot de passe local (600) sans invite.
export HUNTER_SUDO_AUTO="${HUNTER_SUDO_AUTO:-1}"

AGY_BIN="${AGY_BIN:-$(command -v agy 2>/dev/null || true)}"
HERMES_BIN="${HERMES_BIN:-$(command -v hermes 2>/dev/null || true)}"
REA_BIN="${REA_BIN:-$(command -v rea 2>/dev/null || true)}"

if [[ ! -f "$ENTRY" ]]; then
  echo "Hunter Bridge introuvable : $ENTRY" >&2
  echo "Définis HUNTER_ROOT=/chemin/vers/hunter-bridge" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# VPN
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
  local code
  code="$(curl -4 -m 6 -s -o /dev/null -w '%{http_code}' \
    https://api.groq.com/openai/v1/models 2>/dev/null || true)"
  [[ "$code" =~ ^[1-5][0-9][0-9]$ ]]
}

reset_vpn() {
  echo "🛑 Arrêt des instances OpenVPN..."
  if ! sudo -v; then
    echo "⚠️  sudo indisponible : impossible de réinitialiser le VPN." >&2
    return 1
  fi
  sudo pkill -x openvpn 2>/dev/null || true
  sleep 2
  if pgrep -x openvpn >/dev/null 2>&1; then
    sudo pkill -9 -x openvpn 2>/dev/null || true
    sleep 1
  fi
  echo "✅ Instances OpenVPN arrêtées."
}

vpn_interface() {
  ip -o link show 2>/dev/null | sed -n 's/^[0-9]*: \(tun[0-9]*\):.*/\1/p' | head -n 1
}

add_vpn_route() {
  local cidr="$1"
  local iface
  local gw="${HUNTER_VPN_GATEWAY:-10.8.0.1}"
  iface="$(vpn_interface)"
  if [[ -z "$iface" ]]; then
    echo "⚠️  Aucune interface tun active : connecte d'abord le VPN." >&2
    return 1
  fi
  if [[ -z "$cidr" ]]; then
    echo "Usage : hunter vpn-route 192.168.5.0/24" >&2
    return 1
  fi
  echo "🛣  Route $cidr via $gw dev $iface..."
  if ! sudo ip route replace "$cidr" via "$gw" dev "$iface"; then
    echo "⚠️  Impossible d'ajouter la route $cidr." >&2
    return 1
  fi
  echo "✅ Route ajoutée : $cidr via $gw ($iface)."
  return 0
}

apply_vpn_routes() {
  [[ -n "${HUNTER_VPN_ROUTES:-}" ]] || return 0
  local cidr
  for cidr in ${HUNTER_VPN_ROUTES//,/ }; do
    add_vpn_route "$cidr" || true
  done
}

# ---------------------------------------------------------------------------
# Chisel Server + Cloudflared Tunnel — accès public auto pour IA distantes
# ---------------------------------------------------------------------------
# Architecture :
#   [IA distante] --(HTTPS/WSS public)--> [cloudflared tunnel] --> [Chisel Server local:8080]
#                                                                      |
#                                                                      +--> SOCKS5 (1080) pour outils locaux
#                                                                      +--> Reverse proxy vers réseau VPN (192.168.5.0/24, etc.)
# L'IA reçoit une URL publique (ex: https://abc123.trycloudflare.com) et l'utilise comme proxy chisel.
# Zéro config, zéro VPS, tout auto au démarrage VPN.

CHISEL_BIN="${CHISEL_BIN:-$HUNTER_TOOLS/bin/chisel}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$(command -v cloudflared 2>/dev/null || echo "$HUNTER_TOOLS/bin/cloudflared")}"
PROXYCHAINS_CONF="${PROXYCHAINS_CONF:-$HUNTER_TOOLS/etc/proxychains.conf}"

CHISEL_SERVER_PORT="${CHISEL_SERVER_PORT:-8080}"      # Port d'écoute chisel server (HTTP/WebSocket)
CHISEL_SOCKS_PORT="${CHISEL_SOCKS_PORT:-1080}"        # Port SOCKS5 local pour outils (proxychains)
CHISEL_REVERSE_PORT="${CHISEL_REVERSE_PORT:-8081}"    # Port reverse pour exposer le réseau VPN

CHISEL_PID_FILE="${CHISEL_PID_FILE:-/tmp/hunter-chisel-server.pid}"
CHISEL_LOG_FILE="${CHISEL_LOG_FILE:-/tmp/hunter-chisel-server.log}"
CLOUDFLARED_PID_FILE="${CLOUDFLARED_PID_FILE:-/tmp/hunter-cloudflared.pid}"
CLOUDFLARED_LOG_FILE="${CLOUDFLARED_LOG_FILE:-/tmp/hunter-cloudflared.log}"
CHISEL_PUBLIC_URL_FILE="${CHISEL_PUBLIC_URL_FILE:-/tmp/hunter-chisel-public-url.txt}"

chisel_server_enabled() {
  command -v "$CHISEL_BIN" >/dev/null 2>&1
}

cloudflared_enabled() {
  command -v "$CLOUDFLARED_BIN" >/dev/null 2>&1
}

generate_proxychains_conf() {
  mkdir -p "$(dirname "$PROXYCHAINS_CONF")"
  cat > "$PROXYCHAINS_CONF" <<EOF
# Hunter Bridge — proxychains config auto-générée (Chisel Server local)
# SOCKS5 via chisel server sur 127.0.0.1:$CHISEL_SOCKS_PORT
strict_chain
proxy_dns
remote_dns_subnet 224
tcp_read_time_out 15000
tcp_connect_time_out 8000
localnet 127.0.0.0/255.0.0.0
localnet 10.0.0.0/255.0.0.0
localnet 172.16.0.0/255.240.0.0
localnet 192.168.0.0/255.255.0.0

[ProxyList]
socks5 127.0.0.1 $CHISEL_SOCKS_PORT
EOF
  echo "✅ proxychains.conf généré : $PROXYCHAINS_CONF (SOCKS5 127.0.0.1:$CHISEL_SOCKS_PORT)"
}

start_chisel_server() {
  if ! chisel_server_enabled; then
    echo "⚠️  chisel introuvable ($CHISEL_BIN)" >&2
    return 1
  fi

  if [[ -f "$CHISEL_PID_FILE" ]] && kill -0 "$(cat "$CHISEL_PID_FILE" 2>/dev/null)" 2>/dev/null; then
    echo "✅ Chisel Server déjà en cours (pid $(cat "$CHISEL_PID_FILE"))."
    generate_proxychains_conf
    return 0
  fi

  echo "🚀 Démarrage Chisel Server (port $CHISEL_SERVER_PORT, reverse enabled)..."

  # Chisel server : HTTP/WebSocket sur CHISEL_SERVER_PORT, SOCKS5 via upgrade sur même port
  local -a chisel_args=(
    "$CHISEL_BIN" server
    --port "$CHISEL_SERVER_PORT"
    --socks5
    --reverse
  )

  generate_proxychains_conf

  nohup "${chisel_args[@]}" >>"$CHISEL_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$CHISEL_PID_FILE"

  local _
  for _ in $(seq 1 15); do
    if ss -tln 2>/dev/null | grep -q "127.0.0.1:$CHISEL_SERVER_PORT "; then
      echo "✅ Chisel Server actif (pid $pid) — HTTP/WebSocket/SOCKS5 sur 127.0.0.1:$CHISEL_SERVER_PORT"
      break
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "⚠️  Chisel Server s'est arrêté. Voir $CHISEL_LOG_FILE" >&2
      return 1
    fi
    sleep 0.5
  done

  # Démarrer un chisel CLIENT local pour exposer un SOCKS5 plain sur 1080 (pour proxychains)
  start_local_chisel_client_for_socks

  # Démarrer cloudflared tunnel automatiquement
  start_cloudflared_tunnel
}

start_local_chisel_client_for_socks() {
  # Client chisel local → serveur local, expose SOCKS5 plain sur CHISEL_SOCKS_PORT
  # Syntaxe: chisel client <server> <local-port>:socks
  if [[ -f "/tmp/hunter-chisel-local-client.pid" ]] && kill -0 "$(cat "/tmp/hunter-chisel-local-client.pid" 2>/dev/null)" 2>/dev/null; then
    echo "✅ Chisel local client (SOCKS5) déjà actif."
    return 0
  fi

  echo "🔗 Démarrage chisel client local → 127.0.0.1:$CHISEL_SERVER_PORT (SOCKS5 plain :$CHISEL_SOCKS_PORT)..."
  nohup "$CHISEL_BIN" client "127.0.0.1:$CHISEL_SERVER_PORT" "${CHISEL_SOCKS_PORT}:socks" >>"/tmp/hunter-chisel-local-client.log" 2>&1 &
  local pid=$!
  echo "$pid" > "/tmp/hunter-chisel-local-client.pid"

  for _ in $(seq 1 10); do
    if ss -tln 2>/dev/null | grep -q "127.0.0.1:$CHISEL_SOCKS_PORT "; then
      echo "✅ SOCKS5 plain (proxychains) prêt sur 127.0.0.1:$CHISEL_SOCKS_PORT"
      return 0
    fi
    sleep 0.3
  done
  echo "⚠️  SOCKS5 local non prêt (voir /tmp/hunter-chisel-local-client.log)"
  return 1
}

start_cloudflared_tunnel() {
  if ! cloudflared_enabled; then
    echo "⚠️  cloudflared introuvable — installe-le pour l'accès public auto :"
    echo "   curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o $HUNTER_TOOLS/bin/cloudflared && chmod +x \$"
    return 0
  fi

  if [[ -f "$CLOUDFLARED_PID_FILE" ]] && kill -0 "$(cat "$CLOUDFLARED_PID_FILE" 2>/dev/null)" 2>/dev/null; then
    echo "✅ Cloudflared tunnel déjà actif (pid $(cat "$CLOUDFLARED_PID_FILE"))."
    return 0
  fi

  echo "🌐 Création tunnel Cloudflare vers Chisel Server (127.0.0.1:$CHISEL_SERVER_PORT)..."

  # cloudflared tunnel --url http://localhost:8080 --no-autoupdate
  nohup "$CLOUDFLARED_BIN" tunnel --url "http://127.0.0.1:$CHISEL_SERVER_PORT" --no-autoupdate >>"$CLOUDFLARED_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$CLOUDFLARED_PID_FILE"

  # Attendre l'URL publique dans les logs
  local url=""
  for _ in $(seq 1 30); do
    if [[ -f "$CLOUDFLARED_LOG_FILE" ]]; then
      url=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$CLOUDFLARED_LOG_FILE" | tail -1 || true)
      if [[ -n "$url" ]]; then
        break
      fi
    fi
    sleep 0.5
  done

  if [[ -n "$url" ]]; then
    echo "$url" > "$CHISEL_PUBLIC_URL_FILE"
    echo "✅ Tunnel Cloudflare ACTIF : $url"
    echo "   📋 Donne cette URL à n'importe quelle IA : $url"
    echo "   L'IA l'utilise comme endpoint chisel (client chisel --fingerprint chrome $url R:8081:socks)"
  else
    echo "⚠️  Tunnel Cloudflare non prêt (voir $CLOUDFLARED_LOG_FILE)"
  fi
}

stop_chisel_server() {
  # Arrêter cloudflared
  if [[ -f "$CLOUDFLARED_PID_FILE" ]]; then
    local pid
    pid="$(cat "$CLOUDFLARED_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "🛑 Arrêt cloudflared tunnel (pid $pid)..."
      kill "$pid" 2>/dev/null || true
      sleep 1
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$CLOUDFLARED_PID_FILE"
  fi
  pkill -f "cloudflared tunnel.*--url.*$CHISEL_SERVER_PORT" 2>/dev/null || true

  # Arrêter chisel local client (SOCKS5)
  if [[ -f "/tmp/hunter-chisel-local-client.pid" ]]; then
    local pid
    pid="$(cat "/tmp/hunter-chisel-local-client.pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "🛑 Arrêt chisel local client (pid $pid)..."
      kill "$pid" 2>/dev/null || true
      sleep 1
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "/tmp/hunter-chisel-local-client.pid"
  fi
  pkill -f "chisel client.*127.0.0.1:$CHISEL_SERVER_PORT.*--socks5" 2>/dev/null || true

  # Arrêter chisel server
  if [[ -f "$CHISEL_PID_FILE" ]]; then
    local pid
    pid="$(cat "$CHISEL_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "🛑 Arrêt Chisel Server (pid $pid)..."
      kill "$pid" 2>/dev/null || true
      sleep 1
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$CHISEL_PID_FILE"
  fi
  pkill -f "chisel server.*--port $CHISEL_SERVER_PORT" 2>/dev/null || true

  rm -f "$CHISEL_PUBLIC_URL_FILE"
  echo "✅ Chisel Server + Cloudflared arrêtés."
}

chisel_server_status() {
  echo "=== Chisel Server + Cloudflare Tunnel ==="
  if chisel_server_enabled; then
    echo "Chisel Server: installé ($CHISEL_BIN)"
    if [[ -f "$CHISEL_PID_FILE" ]] && kill -0 "$(cat "$CHISEL_PID_FILE" 2>/dev/null)" 2>/dev/null; then
      echo "  Status: RUNNING (pid $(cat "$CHISEL_PID_FILE"))"
      ss -tln 2>/dev/null | grep -E "127.0.0.1:($CHISEL_SERVER_PORT|$CHISEL_SOCKS_PORT|$CHISEL_REVERSE_PORT) " || true
    else
      echo "  Status: STOPPED"
    fi
  else
    echo "Chisel Server: NON INSTALLÉ ($CHISEL_BIN)"
  fi

  if cloudflared_enabled; then
    echo "Cloudflared: installé ($CLOUDFLARED_BIN)"
    if [[ -f "$CLOUDFLARED_PID_FILE" ]] && kill -0 "$(cat "$CLOUDFLARED_PID_FILE" 2>/dev/null)" 2>/dev/null; then
      echo "  Tunnel: RUNNING (pid $(cat "$CLOUDFLARED_PID_FILE"))"
      if [[ -f "$CHISEL_PUBLIC_URL_FILE" ]]; then
        local url
        url="$(cat "$CHISEL_PUBLIC_URL_FILE" 2>/dev/null || true)"
        if [[ -n "$url" ]]; then
          echo "  🌐 URL PUBLIQUE POUR IA : $url"
          echo "      → Donne cette URL à l'IA distante"
          echo "      → L'IA fait : chisel client \$URL R:8081:socks"
          echo "      → Puis : proxychains4 -f ~/.local/share/hunter/etc/proxychains.conf nmap ..."
        fi
      fi
    else
      echo "  Tunnel: STOPPED"
    fi
  else
    echo "Cloudflared: NON INSTALLÉ (installe pour tunnel public auto)"
  fi

  [[ -f "$PROXYCHAINS_CONF" ]] && echo "  proxychains.conf: $PROXYCHAINS_CONF"
  return 0
}

# ---------------------------------------------------------------------------
# Colab Worker — Google Colab comme accélérateur download/forensic
# ---------------------------------------------------------------------------
# Architecture :
#   [Colab] --(chisel client)--> [Tunnel Cloudflare] --> [Chisel Server LOCAL]
#                                    |                          |
#                                    |                          +--> SOCKS5 (1080) pour outils
#                                    |                          +--> Reverse port 8888 → HTTP Receiver local
#                                    |                          +--> Reverse port 8889 → Raw TCP pour gros fichiers
#                                    |
#                                    +--> Colab télécharge gros fichiers (Go), analyse, extrait artefacts
#                                    +--> Colab POST artefacts → http://127.0.0.1:8888/upload (via tunnel)
#                                    +--> Artefacts atterrissent sur ton PC dans ~/hunter-colab-artifacts/
#                                    +--> Tes IA locales (Hunter/Claude) traitent immédiatement

COLAB_RECEIVER_PORT="${COLAB_RECEIVER_PORT:-8888}"
COLAB_RAW_PORT="${COLAB_RAW_PORT:-8889}"
COLAB_ARTIFACTS_DIR="${COLAB_ARTIFACTS_DIR:-$HOME/hunter-colab-artifacts}"
COLAB_RECEIVER_PID_FILE="${COLAB_RECEIVER_PID_FILE:-/tmp/hunter-colab-receiver.pid}"
COLAB_RECEIVER_LOG_FILE="${COLAB_RECEIVER_LOG_FILE:-/tmp/hunter-colab-receiver.log}"
COLAB_CHISEL_CMD_FILE="${COLAB_CHISEL_CMD_FILE:-/tmp/hunter-colab-chisel-cmd.txt}"

colab_receiver_enabled() {
  command -v python3 >/dev/null 2>&1
}

start_colab_receiver() {
  if ! colab_receiver_enabled; then
    echo "⚠️  python3 introuvable" >&2
    return 1
  fi

  if [[ -f "$COLAB_RECEIVER_PID_FILE" ]] && kill -0 "$(cat "$COLAB_RECEIVER_PID_FILE" 2>/dev/null)" 2>/dev/null; then
    echo "✅ Colab Receiver déjà actif (pid $(cat "$COLAB_RECEIVER_PID_FILE"))."
    return 0
  fi

  mkdir -p "$COLAB_ARTIFACTS_DIR"/{raw,forensic,extracted,reports}

  echo "🚀 Démarrage Colab HTTP Receiver sur port $COLAB_RECEIVER_PORT (artefacts → $COLAB_ARTIFACTS_DIR)..."

  # Exporter les variables pour le processus Python
  export COLAB_ARTIFACTS_DIR COLAB_RECEIVER_PORT

  # Receiver HTTP simple en Python (upload + status + listing)
  cat > "/tmp/hunter-colab-receiver.py" <<'PYEOF'
#!/usr/bin/env python3
import http.server
import json
import os
import shutil
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ARTIFACTS_DIR = Path(os.environ.get("COLAB_ARTIFACTS_DIR", "/tmp/hunter-colab-artifacts"))
PORT = int(os.environ.get("COLAB_RECEIVER_PORT", "8888"))

class ColabHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "artifacts_dir": str(ARTIFACTS_DIR)}).encode())
            return
        elif self.path == "/list":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            files = []
            for root, dirs, filenames in os.walk(ARTIFACTS_DIR):
                for f in filenames:
                    p = Path(root) / f
                    rel = p.relative_to(ARTIFACTS_DIR)
                    stat = p.stat()
                    files.append({"path": str(rel), "size": stat.st_size, "mtime": stat.st_mtime})
            self.wfile.write(json.dumps({"files": files}).encode())
            return
        elif self.path.startswith("/download/"):
            rel_path = self.path[len("/download/"):]
            file_path = ARTIFACTS_DIR / rel_path
            if file_path.exists() and file_path.is_file():
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(file_path.stat().st_size))
                self.end_headers()
                with open(file_path, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)
            else:
                self.send_error(404)
            return
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == "/upload":
            content_length = int(self.headers.get("Content-Length", 0))
            content_type = self.headers.get("Content-Type", "")

            # Support multipart/form-data (fichier) ou raw body
            if "multipart/form-data" in content_type:
                # Parsing simple multipart
                boundary = content_type.split("boundary=")[-1].encode()
                body = self.rfile.read(content_length)
                parts = body.split(b"--" + boundary)
                for part in parts:
                    if b"filename=" in part:
                        # Extraire nom fichier
                        header_end = part.find(b"\r\n\r\n")
                        if header_end != -1:
                            headers = part[:header_end].decode(errors="ignore")
                            filename = None
                            for line in headers.split("\r\n"):
                                if "filename=" in line:
                                    filename = line.split("filename=")[1].strip().strip('"')
                                    break
                            if filename:
                                file_data = part[header_end+4:-2]  # enlever \r\n\r\n et \r\n final
                                save_path = ARTIFACTS_DIR / "raw" / filename
                                save_path.parent.mkdir(parents=True, exist_ok=True)
                                with open(save_path, "wb") as f:
                                    f.write(file_data)
                                print(f"[Colab] Reçu: {filename} ({len(file_data)} bytes) → {save_path}", file=sys.stderr)
                                self.send_response(200)
                                self.send_header("Content-Type", "application/json")
                                self.end_headers()
                                self.wfile.write(json.dumps({"status": "ok", "file": str(save_path), "size": len(file_data)}).encode())
                                return
            else:
                # Raw body = fichier unique, nom dans header X-Filename ou query
                query = urlparse(self.path).query
                params = parse_qs(query)
                filename = params.get("filename", [f"colab-{int(time.time())}.bin"])[0]
                if "X-Filename" in self.headers:
                    filename = self.headers["X-Filename"]
                file_data = self.rfile.read(content_length)
                save_path = ARTIFACTS_DIR / "raw" / filename
                save_path.parent.mkdir(parents=True, exist_ok=True)
                with open(save_path, "wb") as f:
                    f.write(file_data)
                print(f"[Colab] Reçu raw: {filename} ({len(file_data)} bytes) → {save_path}", file=sys.stderr)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "ok", "file": str(save_path), "size": len(file_data)}).encode())
                return

        self.send_error(404)

    def log_message(self, format, *args):
        print(f"[Colab Receiver] {self.address_string()} - {format % args}", file=sys.stderr)

if __name__ == "__main__":
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    server = http.server.HTTPServer(("0.0.0.0", PORT), ColabHandler)
    print(f"[Colab Receiver] Listening on 0.0.0.0:{PORT}, artifacts dir: {ARTIFACTS_DIR}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Colab Receiver] Shutdown", file=sys.stderr)
PYEOF

  nohup python3 "/tmp/hunter-colab-receiver.py" >>"$COLAB_RECEIVER_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$COLAB_RECEIVER_PID_FILE"

  # Attendre que le receiver soit prêt
  for _ in $(seq 1 10); do
    if curl -fsS -m 2 "http://127.0.0.1:$COLAB_RECEIVER_PORT/health" >/dev/null 2>&1; then
      echo "✅ Colab Receiver actif (pid $pid) — HTTP sur 127.0.0.1:$COLAB_RECEIVER_PORT"
      echo "   Artefacts reçus dans : $COLAB_ARTIFACTS_DIR"
      break
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "⚠️  Colab Receiver s'est arrêté. Voir $COLAB_RECEIVER_LOG_FILE" >&2
      return 1
    fi
    sleep 0.5
  done

  # Générer la commande chisel pour Colab
  generate_colab_chisel_command
}

generate_colab_chisel_command() {
  local url=""
  if [[ -f "$CHISEL_PUBLIC_URL_FILE" ]]; then
    url="$(cat "$CHISEL_PUBLIC_URL_FILE" 2>/dev/null || true)"
  fi
  if [[ -z "$url" ]]; then
    echo "⚠️  Pas d'URL publique (cloudflared non démarré)" >&2
    return 1
  fi

  # Commande chisel pour Colab :
  # - SOCKS5 pour naviguer/scanner via ton VPN (port 1080)
  # - Reverse tunnel 8888 → ton receiver HTTP (upload artefacts)
  # - Reverse tunnel 8889 → raw TCP pour gros fichiers (optionnel)
  cat > "$COLAB_CHISEL_CMD_FILE" <<EOF
# ============================================================
# COPIE-COLLE CE COMMANDE DANS GOOGLE COLAB (cellule de code)
# ============================================================
# 1. Installe chisel (une seule fois)
! wget -q https://github.com/jpillora/chisel/releases/download/v1.12.0/chisel_1.12.0_linux_amd64.gz -O chisel.gz
! gunzip -f chisel.gz && chmod +x chisel

# 2. Lance le client chisel vers TON tunnel (garde la cellule en cours d'exécution)
! ./chisel client $url \\
  1080:socks \\
  R:$COLAB_RECEIVER_PORT:127.0.0.1:$COLAB_RECEIVER_PORT \\
  R:$COLAB_RAW_PORT:127.0.0.1:$COLAB_RAW_PORT \\
  --fingerprint chrome \\
  --keepalive 10s

# ============================================================
# DANS UNE AUTRE CELLULE COLAB : Tes scripts download/forensic
# ============================================================
# Exemple : Télécharge un gros fichier via ton VPN
# import requests, subprocess, os
# 
# # Via SOCKS5 (proxychains ou requests[socks])
# proxies = {"http": "socks5h://127.0.0.1:1080", "https": "socks5h://127.0.0.1:1080"}
# r = requests.get("http://192.168.5.65/gros-fichier.img", proxies=proxies, stream=True)
# 
# # Sauvegarde local dans Colab
# with open("/content/gros-fichier.img", "wb") as f:
#     for chunk in r.iter_content(1024*1024):
#         f.write(chunk)
# 
# # Analyse forensic (ex: binwalk, volatility, strings, etc.)
# # ! binwalk -e /content/gros-fichier.img
# # ! volatility -f /content/gros-fichier.img linux.pslist
# 
# # Envoie les artefacts vers TON PC via le tunnel (POST HTTP sur port 8888 reverse)
# for artefact in ["extracted/file1", "extracted/file2", "report.json"]:
#     with open(artefact, "rb") as f:
#         requests.post("http://127.0.0.1:8888/upload", files={"file": f}, proxies=proxies)
# 
# # Ou en raw (plus rapide pour gros fichiers) :
# # curl -X POST --data-binary @artefact.bin http://127.0.0.1:8888/upload?filename=artefact.bin --socks5 127.0.0.1:1080
EOF

  echo "📋 Commande Colab générée : $COLAB_CHISEL_CMD_FILE"
  echo "   → Copie le contenu dans une cellule Google Colab"
}

stop_colab_receiver() {
  if [[ -f "$COLAB_RECEIVER_PID_FILE" ]]; then
    local pid
    pid="$(cat "$COLAB_RECEIVER_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "🛑 Arrêt Colab Receiver (pid $pid)..."
      kill "$pid" 2>/dev/null || true
      sleep 1
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$COLAB_RECEIVER_PID_FILE"
  fi
  pkill -f "hunter-colab-receiver.py" 2>/dev/null || true
  rm -f "/tmp/hunter-colab-receiver.py" "$COLAB_CHISEL_CMD_FILE"
  echo "✅ Colab Receiver arrêté."
}

colab_status() {
  echo "=== Colab Worker ==="
  if colab_receiver_enabled; then
    echo "Python3: OK"
    if [[ -f "$COLAB_RECEIVER_PID_FILE" ]] && kill -0 "$(cat "$COLAB_RECEIVER_PID_FILE" 2>/dev/null)" 2>/dev/null; then
      echo "  Receiver: RUNNING (pid $(cat "$COLAB_RECEIVER_PID_FILE"))"
      echo "  Port HTTP: $COLAB_RECEIVER_PORT"
      echo "  Artefacts dir: $COLAB_ARTIFACTS_DIR"
      # Lister fichiers reçus
      if [[ -d "$COLAB_ARTIFACTS_DIR" ]]; then
        local count
        count=$(find "$COLAB_ARTIFACTS_DIR" -type f 2>/dev/null | wc -l)
        echo "  Fichiers reçus: $count"
        find "$COLAB_ARTIFACTS_DIR" -type f -printf "    %p (%s bytes)\n" 2>/dev/null | head -20
      fi
      # URL publique
      if [[ -f "$CHISEL_PUBLIC_URL_FILE" ]]; then
        local url
        url="$(cat "$CHISEL_PUBLIC_URL_FILE" 2>/dev/null || true)"
        if [[ -n "$url" ]]; then
          echo "  🌐 URL publique: $url"
        fi
      fi
      # Afficher commande Colab
      if [[ -f "$COLAB_CHISEL_CMD_FILE" ]]; then
        echo ""
        echo "  📋 COMMANDE POUR COLAB (copie-collée) :"
        cat "$COLAB_CHISEL_CMD_FILE"
      fi
    else
      echo "  Receiver: STOPPED"
    fi
  else
    echo "Python3: MANQUANT"
  fi
  return 0
}

find_ovpn_files() {
  local dir
  for dir in \
    "$HOME" \
    "$HOME/Documents" \
    "$HOME/Desktop" \
    "$HOME/Downloads" \
    "$HOME/.local/share/hunter" \
    "$HOME/.config/openvpn" \
    "/etc/openvpn"; do
    [[ -d "$dir" ]] || continue
    find "$dir" -maxdepth 1 -type f -name '*.ovpn' -print0 2>/dev/null
  done | sort -zu
}

setup_vpn() {
  if [[ "${HUNTER_SKIP_VPN:-0}" == "1" ]]; then
    echo "⏭  VPN ignoré (HUNTER_SKIP_VPN=1)."
    return 0
  fi

  local pids
  pids="$(openvpn_count)"

  if (( pids > 0 )); then
    echo "🔎 $pids instance(s) OpenVPN détectée(s)."
    if (( pids > 1 )); then
      echo "⚠️  Plusieurs instances se disputent les routes : c'est ce qui coupe Internet."
      local answer="O"
      if [[ -t 0 ]]; then
        read -r -t 25 -p "   Les arrêter et reconnecter proprement ? [O/n] " answer || answer="O"
      else
        echo "   (non interactif : réinitialisation)"
      fi
      case "$answer" in
        n|N) echo "   → VPN laissé tel quel."; return 0 ;;
      esac
      reset_vpn || return 0
    elif have_tun; then
      echo "✅ VPN déjà connecté (1 instance, interface tun active)."
      apply_vpn_routes
      return 0
    else
      echo "⚠️  Instance OpenVPN sans interface tun : redémarrage."
      reset_vpn || return 0
    fi
  fi

  local -a files=()
  mapfile -d '' files < <(find_ovpn_files)
  if (( ${#files[@]} == 0 )); then
    echo "   Aucun fichier .ovpn trouvé — poursuite sans VPN."
    return 0
  fi

  local selected=""
  if (( ${#files[@]} == 1 )); then
    selected="${files[0]}"
    echo "🔐 VPN : $selected"
  else
    echo "┌─ Fichiers VPN ───────────────────────────────────────────"
    local i=1
    local f
    for f in "${files[@]}"; do
      printf "│ [%d] %s\n" "$i" "$f"
      i=$((i + 1))
    done
    echo "│ [0] Aucun (ignorer)"
    echo "└──────────────────────────────────────────────────────────"
    if [[ ! -t 0 ]]; then
      echo "   (non interactif : VPN ignoré)"
      return 0
    fi
    local choice="0"
    read -r -t 30 -p "  Sélection (1-${#files[@]}, 0 = aucun) : " choice || choice="0"
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#files[@]} )); then
      selected="${files[$((choice - 1))]}"
    fi
  fi

  if [[ -z "$selected" ]]; then
    echo "   → Aucun VPN sélectionné."
    return 0
  fi

  if ! command -v openvpn >/dev/null 2>&1; then
    echo "⚠️  openvpn absent (sudo pacman -S openvpn) — poursuite sans VPN."
    return 0
  fi

  echo "🔑 Autorisation sudo nécessaire pour openvpn..."
  if ! sudo -v; then
    echo "⚠️  sudo refusé — poursuite sans VPN."
    return 0
  fi

  local -a ovpn_args=(openvpn --config "$selected" --daemon)
  if [[ "${HUNTER_VPN_FULL_TUNNEL:-0}" != "1" ]]; then
    # Le VPN sert aux cibles CTF ; on garde Internet sur la connexion locale.
    ovpn_args+=(--pull-filter ignore "redirect-gateway")
    echo "   Mode split-tunnel : Internet reste sur la connexion locale."
  fi

  echo "🚀 Connexion VPN..."
  if ! sudo "${ovpn_args[@]}"; then
    echo "⚠️  Échec du lancement d'openvpn — poursuite sans VPN."
    return 0
  fi

  local ok=0
  local _
  for _ in $(seq 1 30); do
    if pgrep -x openvpn >/dev/null 2>&1 && have_tun; then
      ok=1
      break
    fi
    sleep 1
  done

  if (( ok == 1 )); then
    echo "✅ VPN connecté."
    apply_vpn_routes
    if probe_internet; then
      echo "✅ Internet accessible."
    else
      echo "⚠️  Internet injoignable après connexion."
      echo "    Coupe le VPN puis relance : sudo pkill -x openvpn && hunter"
    fi
  else
    echo "⚠️  Interface VPN non détectée après 30 s."
    echo "    Vérifie : journalctl -xe | tail -30"
  fi
}

# ---------------------------------------------------------------------------
# Proxy pour agy / hermes (Claude Code démarre son propre proxy)
# ---------------------------------------------------------------------------

ensure_proxy() {
  if curl -fsS -m 2 "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then
    echo "✅ Proxy déjà actif sur ${PROXY_PORT}."
    return 0
  fi

  echo "🚀 Démarrage du proxy Hunter Bridge sur ${PROXY_PORT}..."
  nohup "$NODE_BIN" "$ENTRY" start \
    --config "$CFG" --port "$PROXY_PORT" --no-mcp --no-plugins \
    >>/tmp/hunter-proxy.log 2>&1 &
  local pid=$!

  local _
  for _ in $(seq 1 40); do
    if curl -fsS -m 2 "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then
      echo "✅ Proxy actif (pid $pid)."
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "⚠️  Le proxy s'est arrêté. Dernières lignes :" >&2
      tail -n 20 /tmp/hunter-proxy.log 2>/dev/null || true
      return 1
    fi
    sleep 0.5
  done

  echo "⚠️  Proxy non prêt après 20 s. Voir /tmp/hunter-proxy.log" >&2
  return 1
}

install_sudo_helpers() {
  local src="$ROOT/scripts"
  local dst="$HUNTER_TOOLS/bin"
  if [[ ! -f "$src/hunter-sudo-helper.sh" || ! -f "$src/hunter-sudo-askpass.sh" ]]; then
    echo "❌ Scripts sudo Hunter introuvables dans $src" >&2
    return 1
  fi
  mkdir -p "$dst" "$HOME/.config/hunter"
  install -m 700 "$src/hunter-sudo-helper.sh" "$dst/sudo"
  install -m 700 "$src/hunter-sudo-askpass.sh" "$dst/sudo-askpass"
  echo "✅ Helper sudo installé : $dst/sudo"
}

setup_sudo() {
  if [[ ! -t 0 ]]; then
    echo "Commande interactive requise (lance-la dans ton terminal)." >&2
    return 1
  fi
  install_sudo_helpers || return 1

  local p1="" p2=""
  printf 'Mot de passe sudo (non affiché) : '
  IFS= read -r -s p1 || true
  printf '\nConfirme le mot de passe : '
  IFS= read -r -s p2 || true
  printf '\n'

  if [[ -z "$p1" ]]; then
    echo "Mot de passe vide : abandon." >&2
    return 1
  fi
  if [[ "$p1" != "$p2" ]]; then
    echo "Les mots de passe ne correspondent pas : abandon." >&2
    return 1
  fi

  umask 077
  printf '%s\n' "$p1" > "$HOME/.config/hunter/sudo-pass"
  chmod 600 "$HOME/.config/hunter/sudo-pass"
  echo "✅ Mot de passe stocké dans $HOME/.config/hunter/sudo-pass (mode 600, hors dépôt)."
  echo "   Claude Code l'utilisera automatiquement pour les commandes sudo."
}

clear_sudo() {
  rm -f "$HOME/.config/hunter/sudo-pass"
  echo "✅ Mot de passe sudo supprimé."
}

export_anthropic_env() {
  export ANTHROPIC_BASE_URL="http://127.0.0.1:${PROXY_PORT}"
  export ANTHROPIC_AUTH_TOKEN="${HUNTER_PROXY_TOKEN:-${PROXY_API_KEY:-}}"
  export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-claude-sonnet-4-5}"
  export NO_PROXY="127.0.0.1,localhost,::1"
  export no_proxy="127.0.0.1,localhost,::1"
  # Proxychains pour chisel
  if [[ -f "$PROXYCHAINS_CONF" ]]; then
    export PROXYCHAINS_CONF_FILE="$PROXYCHAINS_CONF"
  fi
}

# ---------------------------------------------------------------------------
# Point d'entrée
# ---------------------------------------------------------------------------

main() {
  local cmd="claude"
  if [[ $# -gt 0 ]]; then
    case "$1" in
      claude|start|up|doctor|models|env|init)
        cmd="$1"
        shift
        ;;
      agy|hermes|rea)
        cmd="$1"
        shift
        ;;
      sudo-setup|sudo-clear)
        cmd="$1"
        shift
        ;;
      vpn-route)
        cmd="vpn-route"
        shift
        ;;
      chisel-start|chisel-stop|chisel-status)
        cmd="$1"
        shift
        ;;
      colab-start|colab-stop|colab-status)
        cmd="$1"
        shift
        ;;
      vpn-reset|vpn)
        cmd="vpn-reset"
        shift
        ;;
      help|-h|--help)
        exec "$NODE_BIN" "$ENTRY" --help
        ;;
      version|-v|--version)
        exec "$NODE_BIN" "$ENTRY" --version
        ;;
      --*)
        cmd="claude"
        ;;
      *)
        cmd="$1"
        shift
        ;;
    esac
  fi

  show_colab_info() {
  # Affiche l'URL Cloudflare et la commande Colab si dispo
  if [[ -f "$CHISEL_PUBLIC_URL_FILE" ]]; then
    local url
    url="$(cat "$CHISEL_PUBLIC_URL_FILE" 2>/dev/null || true)"
    if [[ -n "$url" ]]; then
      echo ""
      echo "🌐  Cloudflare Tunnel ACTIF : $url"
      echo "📋  Pour Colab : hunter colab-status  (copie la commande affichée)"
      echo ""
    fi
  fi
}

  case "$cmd" in
    claude|agy|hermes)
      setup_vpn
      start_chisel_server || true
      start_colab_receiver || true
      show_colab_info
      ;;
    vpn-reset)
      reset_vpn || exit 1
      setup_vpn
      start_chisel_server || true
      start_colab_receiver || true
      show_colab_info
      exit 0
      ;;
  esac

  case "$cmd" in
    sudo-setup)
      setup_sudo || exit 1
      exit 0
      ;;
    sudo-clear)
      clear_sudo
      exit 0
      ;;
    vpn-route)
      add_vpn_route "${1:-}" || exit 1
      exit 0
      ;;
    chisel-start)
      start_chisel_server || exit 1
      exit 0
      ;;
    chisel-stop)
      stop_chisel_server
      exit 0
      ;;
    chisel-status)
      chisel_server_status
      exit 0
      ;;
    colab-start)
      start_chisel_server || true
      start_colab_receiver || exit 1
      exit 0
      ;;
    colab-stop)
      stop_colab_receiver
      exit 0
      ;;
    colab-status)
      colab_status
      exit 0
      ;;
    claude)
      exec "$NODE_BIN" "$ENTRY" claude \
        --config "$CFG" \
        --profile "${HUNTER_PROFILE:-ctf}" \
        --allow-dangerously-skip-permissions \
        "$@"
      ;;
    agy)
      ensure_proxy || exit 1
      export_anthropic_env
      if [[ -z "$AGY_BIN" ]]; then
        echo "agy introuvable. Installe-le ou définis AGY_BIN." >&2
        exit 127
      fi
      exec "$AGY_BIN" "$@"
      ;;
    hermes)
      ensure_proxy || exit 1
      export_anthropic_env
      if [[ -z "$HERMES_BIN" ]]; then
        echo "hermes introuvable. Installe-le ou définis HERMES_BIN." >&2
        exit 127
      fi
      exec "$HERMES_BIN" "$@"
      ;;
    rea)
      if [[ -z "$REA_BIN" ]]; then
        echo "rea introuvable. Installe-le : npm i -g rea-agents" >&2
        exit 127
      fi
      exec "$REA_BIN" "$@"
      ;;
    *)
      exec "$NODE_BIN" "$ENTRY" "$cmd" --config "$CFG" "$@"
      ;;
  esac
}

main "$@"

#!/usr/bin/env bash
#===============================================================================
# Hunter Bridge — lance tout en une commande :
#   VPN (split tunnel) → proxychains → proxy → MCP → plugins → Claude Code
#
# Variables utiles :
#   HUNTER_SKIP_VPN=1        ne pas toucher au VPN
#   HUNTER_VPN_FULL_TUNNEL=1 VPN en tunnel complet (tout le trafic)
#   HUNTER_PROFILE=...       profil de routage (défaut : ctf)
#   PORT=...                 port du proxy pour agy/hermes (défaut : 8787)
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

export_anthropic_env() {
  export ANTHROPIC_BASE_URL="http://127.0.0.1:${PROXY_PORT}"
  export ANTHROPIC_AUTH_TOKEN="${HUNTER_PROXY_TOKEN:-local-hunter-bridge}"
  export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-claude-sonnet-4-5}"
  export NO_PROXY="127.0.0.1,localhost,::1"
  export no_proxy="127.0.0.1,localhost,::1"
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

  case "$cmd" in
    claude|agy|hermes)
      setup_vpn
      ;;
    vpn-reset)
      reset_vpn || exit 1
      setup_vpn
      exit 0
      ;;
  esac

  case "$cmd" in
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

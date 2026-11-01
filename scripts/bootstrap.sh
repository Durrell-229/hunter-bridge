#!/usr/bin/env bash
#===============================================================================
# Hunter Bridge — Bootstrap d'installation automatique
# Détecte l'OS, l'architecture et installe tous les composants manquants.
# À exécuter après `git clone` : ./scripts/bootstrap.sh ou `hunter init --install`
#===============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HUNTER_ROOT="$ROOT_DIR"
HUNTER_TOOLS_DIR="${HUNTER_TOOLS_DIR:-$HOME/.local/share/hunter}"
TOOLS_BIN="$HUNTER_TOOLS_DIR/bin"
PY_VENV="$HUNTER_TOOLS_DIR/venv"
MCP_NODE="$HUNTER_TOOLS_DIR/mcp-node"

# --- Détection OS -------------------------------------------------------------
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  linux*)   OS_NAME="linux" ;;
  darwin*)  OS_NAME="macos" ;;
  msys*|cygwin*|mingw*) OS_NAME="windows" ;;
  *)        OS_NAME="unknown" ;;
esac

# --- Détection architecture ---------------------------------------------------
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH_NAME="x86_64" ;;
  aarch64|arm64) ARCH_NAME="arm64" ;;
  armv7l) ARCH_NAME="armhf" ;;
  i386|i686) ARCH_NAME="x86_32" ;;
  *) ARCH_NAME="$ARCH" ;;
esac

echo "============================================================"
echo "Hunter Bridge — Bootstrap d'installation"
echo "OS        : $OS_NAME"
echo "Arch      : $ARCH_NAME"
echo "Répertoire: $HUNTER_ROOT"
echo "Outils    : $HUNTER_TOOLS_DIR"
echo "============================================================"

# --- Vérification des prérequis -----------------------------------------------
need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "❌ $1 manquant (requis)"
    MISSING_REQ=1
  else
    echo "✅ $1 $(command -v "$1")"
  fi
}

MISSING_REQ=0
need_cmd curl || need_cmd wget || true
need_cmd git || true
need_cmd node || true
need_cmd python3 || true

if [[ "$MISSING_REQ" -eq 1 ]]; then
  echo ""
  echo "💡 Installez manuellement : git, node (>=18), python3, curl ou wget"
  echo "   puis relancez ce script."
  exit 1
fi

NODE_VERSION="$(node --version | sed 's/v//')"
echo "Node      : $NODE_VERSION"

# --- Créer l'arborescence ------------------------------------------------------
mkdir -p "$TOOLS_BIN" "$PY_VENV" "$MCP_NODE" "$HOME/.local/bin"

# --- Détection du gestionnaire de paquets ------------------------------------
detect_pkg_mgr() {
  if command -v pacman >/dev/null 2>&1; then echo "pacman"; return; fi
  if command -v apt-get >/dev/null 2>&1; then echo "apt"; return; fi
  if command -v dnf >/dev/null 2>&1; then echo "dnf"; return; fi
  if command -v yum >/dev/null 2>&1; then echo "yum"; return; fi
  if command -v brew >/dev/null 2>&1; then echo "brew"; return; fi
  if command -v apk >/dev/null 2>&1; then echo "apk"; return; fi
  echo "none"
}

PKG_MGR="$(detect_pkg_mgr)"
echo "Gestionnaire paquets : $PKG_MGR"

# --- Installation des outils système ------------------------------------------
install_system_tools() {
  echo ""
  echo "--- Installation des outils système ---"

  local tools=(
    nmap
    tesseract-ocr
    binwalk
    exiftool
    strings
    ffuf
    jq
  )

  case "$PKG_MGR" in
    pacman)
      echo "Utilisation de pacman (Arch/Garuda)..."
      for t in "${tools[@]}"; do
        if ! pacman -Q "$t" >/dev/null 2>&1; then
          echo "📦 Installation de $t..."
          sudo pacman -S --noconfirm "$t" || echo "⚠️  Échec $t (à installer manuellement)"
        else
          echo "✅ $t déjà installé"
        fi
      done
      ;;
    apt)
      echo "Utilisation de apt (Debian/Ubuntu)..."
      sudo apt-get update -qq
      for t in "${tools[@]}"; do
        if ! dpkg -s "$t" >/dev/null 2>&1; then
          echo "📦 Installation de $t..."
          sudo apt-get install -y "$t" || echo "⚠️  Échec $t"
        else
          echo "✅ $t déjà installé"
        fi
      done
      ;;
    dnf)
      echo "Utilisation de dnf (Fedora)..."
      for t in "${tools[@]}"; do
        if ! rpm -q "$t" >/dev/null 2>&1; then
          echo "📦 Installation de $t..."
          sudo dnf install -y "$t" || echo "⚠️  Échec $t"
        else
          echo "✅ $t déjà installé"
        fi
      done
      ;;
    brew)
      echo "Utilisation de brew (macOS)..."
      for t in nmap tesseract binwalk exiftool ffuf jq; do
        if ! brew list "$t" >/dev/null 2>&1; then
          echo "📦 Installation de $t..."
          brew install "$t" || echo "⚠️  Échec $t"
        else
          echo "✅ $t déjà installé"
        fi
      done
      ;;
    *)
      echo "⚠️  Aucun gestionnaire de paquets détecté — installez manuellement : nmap, tesseract, binwalk, exiftool, ffuf, jq"
      ;;
  esac
}

install_system_tools

# --- Installation Python venv ------------------------------------------------
echo ""
echo "--- Installation environnement Python (CTF) ---"

if [[ ! -x "$PY_VENV/bin/python" ]]; then
  echo "Création du venv Python..."
  python3 -m venv "$PY_VENV"
fi

# Mettre à jour pip
"$PY_VENV/bin/pip" install --upgrade pip setuptools wheel >/dev/null 2>&1 || true

# Installer les bibliothèques Python CTF (certaines peuvent échouer, c'est ok)
echo "Installation des bibliothèques Python..."
"$PY_VENV/bin/pip" install \
  pwntools z3-solver capstone unicorn keystone-engine pyelftools \
  ROPgadget yara-python volatility3 scapy pycryptodome requests beautifulsoup4 \
  >/tmp/hunter-pip-install.log 2>&1 || {
    echo "⚠️  Certaines bibliothèques Python n'ont pu s'installer (voir /tmp/hunter-pip-install.log)"
  }

# Vérifier les outils Python critiques
for tool in pwn ROPgadget vol; do
  if [[ -x "$PY_VENV/bin/$tool" ]] || "$PY_VENV/bin/python" -c "import $tool" 2>/dev/null; then
    echo "✅ Python : $tool"
  else
    echo "⚠️  Python : $tool (optionnel, installation manuelle possible)"
  fi
done

# Créer des wrappers PATH pour les outils Python
cat > "$TOOLS_BIN/python" <<EOF
#!/usr/bin/env bash
exec "$PY_VENV/bin/python" "\$@"
EOF
chmod +x "$TOOLS_BIN/python"

cat > "$TOOLS_BIN/pwn" <<EOF
#!/usr/bin/env bash
exec "$PY_VENV/bin/pwn" "\$@"
EOF
chmod +x "$TOOLS_BIN/pwn"

cat > "$TOOLS_BIN/ROPgadget" <<EOF
#!/usr/bin/env bash
exec "$PY_VENV/bin/ROPgadget" "\$@"
EOF
chmod +x "$TOOLS_BIN/ROPgadget"

# --- Installation serveurs MCP Node ------------------------------------------
echo ""
echo "--- Installation serveurs MCP Node ---"

if [[ ! -f "$MCP_NODE/package.json" ]]; then
  cd "$MCP_NODE"
  npm init -y >/dev/null 2>&1
fi

cd "$MCP_NODE"
npm install --no-audit --no-fund \
  @modelcontextprotocol/server-memory \
  @modelcontextprotocol/server-sequential-thinking \
  @modelcontextprotocol/sdk \
  >/tmp/hunter-npm-install.log 2>&1 || {
    echo "⚠️  Échec partiel de l'installation MCP (voir /tmp/hunter-npm-install.log)"
  }

# --- Téléchargement outils CTF binaires --------------------------------------
echo ""
echo "--- Téléchargement outils CTF binaires ---"

download_if_missing() {
  local name="$1" url="$2" dest="$3"
  if [[ -x "$dest" ]]; then
    echo "✅ $name déjà présent"
    return
  fi
  echo "📥 Téléchargement de $name..."
  tmp="$(mktemp)"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 120 -o "$tmp" "$url" || { echo "⚠️  Échec $name"; rm -f "$tmp"; return; }
  else
    wget -q --timeout=120 -O "$tmp" "$url" || { echo "⚠️  Échec $name"; rm -f "$tmp"; return; }
  fi
  case "$tmp" in
    *.tar.gz) tar -xzf "$tmp" -C "$TOOLS_BIN" --strip-components=1 "$name" 2>/dev/null || tar -xzf "$tmp" -C "$TOOLS_BIN" 2>/dev/null || true ;;
    *.zip)    unzip -oq "$tmp" -d "$tmp.dir" 2>/dev/null; find "$tmp.dir" -type f -executable -name "$name" -exec cp {} "$TOOLS_BIN/" \; 2>/dev/null || true ;;
    *)        cp "$tmp" "$TOOLS_BIN/$name" && chmod +x "$TOOLS_BIN/$name" ;;
  esac
  rm -f "$tmp" "$tmp.dir" 2>/dev/null || true
}

# ffuf
FFUF_URL="https://github.com/ffuf/ffuf/releases/download/v2.3.0/ffuf_2.3.0_linux_${ARCH_NAME}.tar.gz"
if [[ "$OS_NAME" == "linux" ]]; then
  download_if_missing ffuf "$FFUF_URL" "$TOOLS_BIN/ffuf" || true
fi

# --- Télécharger wordlists ----------------------------------------------------
echo ""
echo "--- Téléchargement wordlists ---"

WORDLIST_DIR="$HUNTER_TOOLS_DIR/wordlists"
mkdir -p "$WORDLIST_DIR"

download_wordlist() {
  local url="$1" dest="$2"
  if [[ -f "$dest" ]]; then
    echo "✅ $(basename "$dest") déjà présent"
    return
  fi
  echo "📥 $(basename "$dest")..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 180 -o "$dest" "$url" || echo "⚠️  Échec $dest"
  else
    wget -q --timeout=180 -O "$dest" "$url" || echo "⚠️  Échec $dest"
  fi
}

# Wordlists légères
download_wordlist \
  "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/Web-Content/raft-small-words.txt" \
  "$WORDLIST_DIR/raft-small-words.txt" || true

download_wordlist \
  "https://raw.githubusercontent.com/danielmiessler/SecLists/master/Discovery/Web-Content/common.txt" \
  "$WORDLIST_DIR/common.txt" || true

# rockyou (grosse, optionnelle)
if [[ ! -f "$WORDLIST_DIR/rockyou.txt" ]]; then
  echo "📥 rockyou.txt (optionnel, 134 Mo)..."
  if curl -fsSL --max-time 600 -o "$WORDLIST_DIR/rockyou.txt" \
     "https://github.com/brannondorsey/naive-hashcat/releases/download/data/rockyou.txt" 2>/dev/null; then
    echo "✅ rockyou.txt téléchargé"
  else
    echo "⚠️  rockyou.txt non téléchargé (téléchargez-le manuellement si nécessaire)"
  fi
fi

# --- Configurer hunter.config.json -------------------------------------------
echo ""
echo "--- Configuration hunter.config.json ---"

CONFIG_FILE="$HUNTER_ROOT/hunter.config.json"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Création d'un hunter.config.json par défaut..."
  node -e "
    const fs=require('fs');
    const { defaultSettings } = require('./src/settings.js');
    const s = defaultSettings();
    fs.writeFileSync('$CONFIG_FILE', JSON.stringify(s,null,2)+'\n', {mode:0o600});
    console.log('Configuration par défaut créée');
  " || echo "⚠️  Échec création config"
fi

# Activer le profil CTF si présent
if [[ -f "$CONFIG_FILE" ]]; then
  node -e "
    const fs=require('fs');
    let c = JSON.parse(fs.readFileSync('$CONFIG_FILE','utf8'));
    if (!c.routing) c.routing = {};
    c.routing.activeProfile = 'ctf';
    if (!c.mcp) c.mcp = { servers: [] };
    if (!c.plugins) c.plugins = { paths: [] };
    // Ajouter plugin ctf-arsenal si absent
    if (!c.plugins.paths.includes('\$HUNTER_ROOT/plugins/ctf-arsenal')) {
      c.plugins.paths.push('\$HUNTER_ROOT/plugins/ctf-arsenal');
    }
    fs.writeFileSync('$CONFIG_FILE', JSON.stringify(c,null,2)+'\n', {mode:0o600});
    console.log('Profil CTF activé, plugin ctf-arsenal ajouté');
  " || true
fi

# --- Configurer .env -----------------------------------------------------------
echo ""
echo "--- Configuration .env ---"

ENV_FILE="$HUNTER_ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Création du fichier .env..."
  cat > "$ENV_FILE" <<'ENVEOF'
# ── Clés fournisseurs ──
GROQ_API_KEY=
OPENCODE_API_KEY=
NVIDIA_API_KEY=
GEMINI_API_KEY=
OLLAMA_API_KEY=

# ── Permission bypass (autonomie CTF) ──
ANTHROPIC_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS=1

# ── Serveur local ──
HOST=127.0.0.1
PORT=8787
ENVEOF
  chmod 600 "$ENV_FILE"
  echo "✅ .env créé (modifiez les clés API)"
fi

# --- Créer le wrapper hunter global -------------------------------------------
echo ""
echo "--- Wrapper hunter global ---"

WRAPPER="$HOME/.local/bin/hunter"
cat > "$WRAPPER" <<WREOF
#!/usr/bin/env bash
# Hunter Bridge — lance Claude Code dans le dossier courant.
set -euo pipefail

ROOT="${HUNTER_ROOT}"
NODE_BIN="${HUNTER_NODE:-node}"
ENTRY="\$ROOT/bin/hunter.js"

export HUNTER_TOOLS="${HUNTER_TOOLS_DIR}"
export PATH="\$HUNTER_TOOLS/bin:\$HOME/.local/bin:\$PATH"

if [[ ! -f "\$ENTRY" ]]; then
  echo "Hunter Bridge introuvable : \$ENTRY" >&2
  echo "Définis HUNTER_ROOT=/chemin/vers/hunter-bridge"
  exit 1
fi

command_name="claude"
profile_id="auto"

if [[ \$# -gt 0 ]]; then
  case "\$1" in
    start|up|claude|doctor|models|env|init|help|version)
      command_name="\$1"
      shift
      ;;
    --profile)
      profile_id="\${2:-auto}"
      shift 2
      remaining=()
      for a in "\$@"; do
        if [[ "\$a" != "--profile" && "\$a" != "--profile="* ]]; then remaining+=("\$a"); fi
      done
      set -- "${remaining[@]}"
      ;;
  esac
fi

if [[ "\$profile_id" != "auto" ]]; then
  CONFIG="\$ROOT/hunter.config.json"
  if [[ -f "\$CONFIG" ]]; then
    sed -i "s/\"activeProfile\": \"[^\"]*\"/\"activeProfile\": \"\$profile_id\"/" "\$CONFIG"
    echo "Profil '\$profile_id' activé dans \$CONFIG"
  fi
fi

export HUNTER_ENV_FILE="\$ROOT/.env"

args=(
  "claude"
  --config "\$ROOT/hunter.config.json"
  --allow-dangerously-skip-permissions
)

exec "\$NODE_BIN" "\$ENTRY" "\${args[@]}" "\$@"
WREOF
chmod +x "$WRAPPER"
echo "✅ Wrapper créé : $WRAPPER"

# --- Résumé --------------------------------------------------------------------
echo ""
echo "============================================================"
echo "✅ Installation terminée avec succès !"
echo ""
echo "🚀 Pour lancer Claude Code :"
echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
echo "   hunter --profile ctf"
echo ""
echo "🔧 Pour ajouter des clés API :"
echo "   Éditez : $ENV_FILE"
echo ""
echo "📊 Dashboard : http://127.0.0.1:8787/dashboard"
echo "============================================================"
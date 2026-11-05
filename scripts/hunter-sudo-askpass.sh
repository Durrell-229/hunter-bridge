#!/usr/bin/env bash
# Fournit le mot de passe sudo à `sudo -A`.
# Le mot de passe est stocké hors du dépôt, en mode 600.
set -euo pipefail

pass_file="${HUNTER_SUDO_PASS_FILE:-$HOME/.config/hunter/sudo-pass}"

if [[ ! -r "$pass_file" ]]; then
  echo "Hunter: mot de passe sudo introuvable ($pass_file). Lance : hunter sudo-setup" >&2
  exit 1
fi

cat "$pass_file"

#!/usr/bin/env bash
# `sudo` local pour Hunter / Claude Code.
#
# - HUNTER_SUDO_AUTO=1 (défini par `hunter claude`) : utilise le mot de passe
#   stocké dans ~/.config/hunter/sudo-pass via sudo -A, sans bloquer.
# - Sinon : délègue au vrai sudo (invite normale dans le terminal).
#
# Le mot de passe n'est jamais affiché et n'est jamais dans le dépôt Git.
set -euo pipefail

real_sudo="${HUNTER_REAL_SUDO:-/usr/bin/sudo}"
pass_file="${HUNTER_SUDO_PASS_FILE:-$HOME/.config/hunter/sudo-pass}"
askpass="${HUNTER_SUDO_ASKPASS:-$HOME/.local/share/hunter/bin/sudo-askpass}"

if [[ "${HUNTER_SUDO_AUTO:-0}" != "1" || ! -r "$pass_file" ]]; then
  exec "$real_sudo" "$@"
fi

# Si l'appelant gère déjà le mot de passe, ne pas ajouter -A.
for arg in "$@"; do
  case "$arg" in
    -S|--stdin|-A|--askpass)
      exec "$real_sudo" "$@"
      ;;
  esac
done

export SUDO_ASKPASS="$askpass"
exec "$real_sudo" -A "$@"

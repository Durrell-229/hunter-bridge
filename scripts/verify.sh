#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== Syntaxe =="
for file in bin/*.js src/*.js public/app.js test/*.js; do
  node --check "$file"
done

echo "== Configuration =="
node -e "import('./src/settings.js').then(({defaultSettings})=>{const s=defaultSettings(); if(!s.providers.groq||!s.routing.profiles.ctf) process.exit(1); console.log('settings ok')})"

echo "== Tests =="
npm test

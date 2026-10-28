#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== Syntaxe =="
for file in bin/groqcc.js src/*.js test/*.js; do
  node --check "$file"
done

echo "== Tests =="
npm test

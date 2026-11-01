---
description: Résolution crypto/encodage CTF avec CyberChef, Python, z3 et pycryptodome
argument-hint: <données|fichier|description>
---

Cible : **$ARGUMENTS**

## 1. Identifier

- `mcp__ctf__file_triage` si c'est un fichier.
- `mcp__cyberchef__cyberchef_magic` pour détecter les encodages/compressions.
- `mcp__cyberchef__cyberchef_categories`, `mcp__cyberchef__cyberchef_list_operations`, `mcp__cyberchef__cyberchef_describe_operation` pour trouver l'opération.
- `mcp__cyberchef__cyberchef_analyse` pour les outils d'analyse (XOR, RSA, hash, classical cipher, JWT, etc.).

## 2. Transformer

- `mcp__cyberchef__cyberchef_bake` avec une recette construite par `cyberchef_recipe_create` / `recipe_execute`.
- Pour les opérations en chaîne, préfère une recette reproductible à des appels isolés.
- Pour les données binaires, utilise `Bash` + Python (`bytes.fromhex`, `base64`, `zlib`, `gzip`).

## 3. Casser

- Hash : `mcp__cyberchef__cyberchef_hash_identify`, puis `hash_crack` ou wordlist locale (`~/.local/share/hunter/wordlists/rockyou.txt`).
- XOR répété : `cyberchef_xor_key_length`, `cyberchef_crib_drag`.
- RSA : `cyberchef_rsa_attack`, `cyberchef_rsa_multi_key`, Fermat/Wiener/shared factors.
- Classique : `cyberchef_classical_cipher`, `substitution_break`, `vigenere_break`.
- Contraintes : utilise le venv Hunter `~/.local/share/hunter/venv/bin/python` avec `z3`, `pycryptodome`, `sympy` si disponible.
- ECDSA nonce réutilisé : `cyberchef_ecdsa_recover`.

## 4. Vérifier

- Vérifie le plaintext (score, format, flag).
- Donne la recette exacte et le script reproductible.
- Ne prétends pas qu'un texte est le flag sans le format attendu (`flag{...}`, `CTF{...}`, etc.).

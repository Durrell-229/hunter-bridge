---
description: Reverse engineering d'un binaire avec radare2/r2mcp, checksec, strings et décompilation
argument-hint: <binaire> [question précise]
---

Cible : **$ARGUMENTS**

## Outil obligatoire : radare2 (r2mcp)

Pour tout binaire, tu **dois** utiliser radare2 via le MCP `r2mcp` avant de conclure. Ne te contente pas de `strings` ou de `file`.

1. Vérifie les protections et le type :
   - `mcp__ctf__checksec_binary` avec le chemin absolu ;
   - `mcp__ctf__file_triage` pour le type, les hashes, binwalk et les chaînes.
2. Ouvre le binaire dans r2mcp :
   - `mcp__r2mcp__open_file` (`file_path` = chemin absolu) ;
   - `mcp__r2mcp__analyze` (niveau 2 ou 3) ;
   - `mcp__r2mcp__show_info`, `mcp__r2mcp__list_entrypoints`, `mcp__r2mcp__list_functions`, `mcp__r2mcp__list_imports`, `mcp__r2mcp__list_strings`, `mcp__r2mcp__list_symbols`.
3. Analyse `main`, les fonctions appelées par `main`, les fonctions contenant des chaînes intéressantes (`flag`, `win`, `correct`, `password`, `secret`, `Wrong`, `Good`), et les appels système.
4. Décompile les fonctions clés avec `mcp__r2mcp__decompile_function` et désassemble-les avec `mcp__r2mcp__disassemble_function`.
5. Cherche les xrefs avec `mcp__r2mcp__xrefs_to` et les adresses avec `mcp__r2mcp__lookup_address` / `lookup_symbol`.
6. Si r2mcp est indisponible, utilise `Bash` :
   - `r2 -A -q -c 'afl; izz; pdf @ main' <binaire>`
   - `rabin2 -I -z -i -s <binaire>`
   - `objdump -d -M intel <binaire>`
7. Pour le désassemblage brut d'une fonction, `mcp__r2mcp__disassemble` avec l'adresse ou `pdf @ <adresse>`.

## Méthode

- Commence par les imports/chaînes/entrées, puis remonte vers la logique.
- Identifie le format d'entrée, les comparaisons et les transformations.
- Si le binaire vérifie un flag, reconstruis la contrainte et résous-la (z3, Python, CyberChef).
- Si le binaire est un binaire pwn, passe au workflow `ctf-pwn` (checksec, cyclic, gadgets, libc).
- Pour un binaire strippé, utilise les xrefs et les chaînes, pas seulement les noms de fonctions.
- Vérifie chaque hypothèse par une commande ou un calcul.

## Sortie

- Type, architecture, protections (NX/PIE/Canary/RELRO).
- Fonctions et adresses clés.
- Pseudo-code / logique reconstruite.
- Flag ou prochaine expérience minimale reproductible.
- Commandes exactes utilisées.

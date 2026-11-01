---
description: Triage initial d'un challenge CTF (fichier, binaire, URL, APK, pcap, crypto)
argument-hint: <fichier|URL|description>
---

Tu es le lead CTF. Cible / indices : **$ARGUMENTS**

## Règles

- Cible autorisée uniquement : challenge CTF, lab, ou scope de bug bounty explicite. Si le scope est ambigu, demande confirmation avant toute action intrusive.
- Commence par l'observation, pas par l'exploitation.
- Utilise en priorité les MCP disponibles : `mcp__ctf__*` pour les outils locaux, `mcp__r2mcp__*` pour le reverse, `mcp__cyberchef__*` pour les transformations, `mcp__playwright__*` pour le web.
- Si un MCP échoue, utilise `Bash` avec les mêmes outils en ligne de commande.
- Note les hypothèses, les commandes exécutées et les résultats importants.

## Étape 1 — Classer la cible

1. Si c'est un fichier local : `file`, `sha256sum`, `exiftool`, `binwalk`, `strings`, `checksec`.
   - Binaire ELF/PE/Mach-O → passe au workflow `ctf-rev` puis `ctf-pwn` si exploitable.
   - APK/DEX → `jadx` et `apktool`.
   - Image → `ctf-stego`.
   - Archive → liste, extrais dans un dossier de travail, re-triage.
   - PCAP → `ctf-forensics`.
2. Si c'est une URL : `curl -i`, technologies, robots.txt, sitemap, JS, cookies, endpoints. Puis `ctf-web`.
3. Si c'est une description crypto/encodage : `ctf-crypto`.

## Étape 2 — Construire le plan

Produis une courte liste priorisée :
- hypothèse la plus probable ;
- prochaine commande concrète ;
- critère de succès ;
- risque / scope.

## Étape 3 — Déléguer si utile

Utilise les sous-agents `ctf-arsenal:rev-hunter`, `ctf-arsenal:web-hunter`, `ctf-arsenal:pwn-hunter`, `ctf-arsenal:crypto-hunter`, `ctf-arsenal:forensics-hunter` en parallèle seulement si les pistes sont indépendantes.

## Sortie attendue

Un rapport court : cible, type, protections/technologies, pistes classées, commandes exécutées, prochaine action. Ne prétends jamais avoir trouvé un flag sans preuve.

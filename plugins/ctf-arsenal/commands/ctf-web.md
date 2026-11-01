---
description: Audit web CTF/bug bounty avec Playwright, httpx, katana, ffuf, nuclei et sqlmap
argument-hint: <URL ou domaine>
---

Cible : **$ARGUMENTS**

## Scope

Vérifie que la cible est dans le scope autorisé (CTF, lab, programme de bug bounty). En cas de doute, arrête-toi et demande. Pas de scan agressif sur une cible de production sans autorisation.

## 1. Reconnaissance passive

- `mcp__ctf__httpx_probe` sur les URLs/hôtes connus.
- `curl -i`, `robots.txt`, `sitemap.xml`, `/.well-known/`, headers de sécurité.
- Lis le JavaScript : endpoints, clés, commentaires, source maps.
- `mcp__ctf__subfinder_enum` pour les sous-domaines (si domaine autorisé).
- `mcp__ctf__katana_crawl` pour les URLs et formulaires.

## 2. Cartographie

- `mcp__ctf__nmap_scan` sur les ports web si autorisé.
- `mcp__ctf__ffuf_fuzz` avec `FUZZ` dans l'URL et la wordlist par défaut.
- `mcp__playwright__browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill_form`, `browser_network_requests` pour comprendre le flux réel.
- `mcp__playwright__browser_evaluate` pour inspecter le DOM/JS si nécessaire.

## 3. Tests

- Injection : `mcp__ctf__sqlmap_scan` après avoir identifié un paramètre.
- XSS/SSRF/IDOR : teste manuellement avec Playwright et `curl`, compare les réponses.
- Vulnérabilités connues : `mcp__ctf__nuclei_scan` avec `severity` et `tags` ciblés.
- Fichiers exposés : `.git`, `.env`, backups, `Dockerfile`, `package.json`, `/admin`, `/api`.
- Auth : JWT (regarde `alg`, `kid`, expiration), cookies, sessions, reset password.
- Pour décoder/encoder : `mcp__cyberchef__*`.

## 4. Preuve

- Capture la requête/réponse exacte, le payload, le statut HTTP et l'impact.
- Pour un flag : chemin d'exploitation reproductible.
- Pour un bug bounty : titre, sévérité, étapes, preuve, remédiation.

## Sortie

Tableau des endpoints, paramètres, tests effectués, résultats, prochaines hypothèses.

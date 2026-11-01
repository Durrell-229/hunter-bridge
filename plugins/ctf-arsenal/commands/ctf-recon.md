---
description: Reconnaissance réseau et surface d'attaque (nmap, subfinder, httpx, katana)
argument-hint: <domaine|IP|CIDR>
---

Cible : **$ARGUMENTS**

## Scope

Confirme le scope autorisé. Pas de scan de masse sur Internet. Pour un CTF, la cible est le lab/challenge.

## 1. DNS / sous-domaines

- `mcp__ctf__subfinder_enum` (domaine).
- `dig`, `host`, `whois`, certificats (`crt.sh`).
- Résous les hôtes et déduplique.

## 2. HTTP

- `mcp__ctf__httpx_probe` sur les hôtes/URLs.
- `curl -i` sur les racines, `robots.txt`, `sitemap.xml`, `security.txt`.
- `mcp__ctf__katana_crawl` pour les URLs, JS et formulaires.

## 3. Ports

- `mcp__ctf__nmap_scan` avec `ports` adaptés (web: 80,443,8000,8080,8443,3000,5000,9000).
- Pour un scan plus complet : `args: ["-sC", "-sV", "-p-"]` mais attention au temps.
- Service detection, versions, scripts NSE par défaut.

## 4. Vulnérabilités

- `mcp__ctf__nuclei_scan` ciblé sur les URLs découvertes.
- `nikto` pour les serveurs web classiques.
- Analyse manuelle des endpoints et technologies.

## Sortie

Tableau hôtes/ports/services/URLs, technologies, points d'entrée, prochaines actions.

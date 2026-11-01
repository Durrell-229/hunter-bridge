---
description: Forensics CTF (volatilité mémoire, pcap, disque, documents, malware)
argument-hint: <fichier|répertoire>
---

Cible : **$ARGUMENTS**

## 1. Triage

- `mcp__ctf__file_triage` (type, hashes, exiftool, binwalk, strings).
- `Bash` : `file`, `xxd | head`, `foremost`, `binwalk -e`, `7z l`, `unzip -l`.
- Pour un dump mémoire : `vol -f <dump> <plugin>` via le venv Hunter (`~/.local/share/hunter/venv/bin/vol`).
- Pour un pcap : `tshark` si présent, sinon Python/scapy (`~/.local/share/hunter/venv/bin/python`).
- Pour un document : `exiftool`, `strings`, `olevba`, `pdf-parser`, extraction des objets.

## 2. Analyse

- Mémoire : `windows.info`, `windows.pslist`, `windows.cmdline`, `windows.netscan`, `windows.filescan`, `windows.dumpfiles`, `windows.registry.*`, `windows.malfind`.
- Réseau : conversations, HTTP, DNS, credentials, fichiers extraits (`tshark -r x.pcap -Y http.request`).
- Disque : partitions (`mmls`), filesystem (`fls`/`icat`), timeline (`plasо`/`log2timeline` si dispo).
- Malware : hashes, strings, imports, YARA (`yara` via venv), capa si présent.
- Stégano : passe à `ctf-stego`.

## 3. Sortie

- Chronologie, artefacts clés, IOC, flag.
- Chemins exacts des fichiers extraits et commandes utilisées.
- Ne modifie jamais l'original : travaille sur une copie.

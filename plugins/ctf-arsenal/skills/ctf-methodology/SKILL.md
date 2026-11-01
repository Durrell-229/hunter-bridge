---
name: ctf-methodology
description: Méthodologie CTF et bug bounty pour Hunter Bridge. Utiliser dès qu'un challenge, un flag, un binaire, un site, un pcap, un APK ou une cible de bug bounty est mentionné.
---

# Méthodologie CTF

## 0. Scope

Cible autorisée uniquement : challenge CTF, lab, ou programme de bug bounty avec scope explicite. En cas de doute, demander. Ne pas scanner Internet au hasard.

## 1. Triage

| Indice | Première action |
|---|---|
| Fichier inconnu | `mcp__ctf__file_triage` puis `file`, `binwalk`, `strings` |
| Binaire ELF/PE/Mach-O | `mcp__ctf__checksec_binary` + `mcp__r2mcp__*` |
| URL/site | `mcp__ctf__httpx_probe`, `curl -i`, Playwright |
| APK/DEX | `mcp__ctf__file_triage`, `jadx`, `apktool` |
| Image/audio | `ctf-stego` : `exiftool`, `binwalk`, `stegseek`, LSB |
| Pcap | `ctf-forensics` : tshark/scapy |
| Dump mémoire | `ctf-forensics` : volatility3 |
| Crypto/encodage | `mcp__cyberchef__*` puis Python/z3 |

## 2. Règle radare2

Pour **tout binaire**, utiliser radare2 via `mcp__r2mcp__*` :
1. `open_file` (chemin absolu)
2. `analyze`
3. `show_info`, `list_functions`, `list_imports`, `list_strings`, `list_symbols`
4. `decompile_function` / `disassemble_function` sur `main` et les fonctions suspectes
5. `xrefs_to` pour remonter aux validations

Ne pas conclure sur un binaire sans l'avoir ouvert dans r2. Si le MCP est indisponible :
```bash
r2 -A -q -c 'afl; izz; pdf @ main' ./binary
rabin2 -I -z -i -s ./binary
```

## 3. Boucle de travail

1. Observer (pas d'exploitation).
2. Formuler une hypothèse testable.
3. Exécuter la plus petite commande qui la teste.
4. Noter la preuve.
5. Garder/abandonner l'hypothèse.
6. Passer au spécialiste si le problème change de domaine.

## 4. Outils disponibles

- Reverse : `r2`, `rabin2`, `r2mcp`, `objdump`, `gdb`, `checksec`, `ROPgadget`.
- Pwn : `pwntools`, `cyclic`, `ROPgadget`, `patchelf`, `qemu`.
- Web : `curl`, `httpx`, `katana`, `ffuf`, `nuclei`, `nikto`, `sqlmap`, `nmap`, Playwright.
- Crypto : CyberChef MCP, `z3`, `pycryptodome`, `hashcat` si présent.
- Forensics : `binwalk`, `foremost`, `exiftool`, `volatility3`, `scapy`, `yara`, `stegseek`.
- Android : `jadx`, `apktool`.
- Wordlists : `~/.local/share/hunter/wordlists/` (`raft-small-words.txt`, `rockyou.txt`, LFI, DNS).

## 5. Preuves

Toujours fournir : commande exacte, sortie significative, hash/flag, et chemin de reproduction. Ne jamais inventer un flag.

---
description: Exploitation pwn d'un binaire (checksec, offsets, ROP, libc, pwntools)
argument-hint: <binaire> [remote host:port]
---

Cible : **$ARGUMENTS**

## Règles

- Cible autorisée uniquement. Pour un binaire local, travaille dans un dossier de travail dédié.
- Utilise radare2 (`mcp__r2mcp__*`) pour l'analyse statique et pwntools pour l'exploitation.

## 1. Triage

- `mcp__ctf__checksec_binary` (NX, PIE, Canary, RELRO).
- `mcp__ctf__file_triage` (architecture, chaînes, imports).
- `mcp__r2mcp__open_file`, `mcp__r2mcp__analyze`, `mcp__r2mcp__list_functions`, `mcp__r2mcp__list_imports`, `mcp__r2mcp__list_strings`.
- Repère `main`, la fonction vulnérable, les appels `read`/`gets`/`scanf`/`printf`, et les fonctions `win`/`system`.

## 2. Offset

- `mcp__ctf__pwn_cyclic` avec `length` (ex. 512) pour générer le motif.
- Lance le binaire sous gdb ou avec un input fichier, récupère la valeur qui écrase RIP/EIP.
- `mcp__ctf__pwn_cyclic` avec `offset` (ex. `0x6161616c`) pour retrouver l'offset exact.
- Vérifie avec un pattern contrôlé et `gdb -batch -ex run -ex 'info registers rip'`.

## 3. Gadgets et cible

- `mcp__ctf__rop_gadgets` (`grep`: `pop rdi`, `ret`, `syscall`, `leave`).
- `mcp__r2mcp__xrefs_to`, `mcp__r2mcp__decompile_function` pour comprendre la logique.
- `mcp__r2mcp__list_symbols` / `list_imports` pour `system`, `execve`, `puts`, `printf`, `read`, GOT/PLT.
- Si PIE : fuite d'adresse puis base = leak - offset.
- Si libc fournie : `pwninit` ou `patchelf` pour l'utiliser, puis offsets via `libc.symbols`.

## 4. Exploit

Écris un script pwntools dans le dossier de travail (`exploit.py`), avec :
- `context.binary`, `context.log_level`;
- fonction `start()` locale/remote;
- payload commenté (offset, gadgets, adresses);
- test local reproductible avant remote.

Utilise `Bash` avec `python3` ou le Python de Hunter (`~/.local/share/hunter/venv/bin/python`) pour exécuter le script.

## 5. Sortie

- Protections, offset, chaîne ROP, fuites, base libc.
- Script exploit complet et sortie du test.
- Flag si obtenu. Ne prétends pas avoir réussi sans preuve.

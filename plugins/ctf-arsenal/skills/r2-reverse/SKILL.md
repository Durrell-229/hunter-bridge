---
name: r2-reverse
description: Reverse engineering avec radare2 et r2mcp. Utiliser pour tout binaire, analyse de malware, firmware, binaire strippé, challenge pwn/rev, ou quand radare2/r2/Ghidra/IDA est mentionné.
---

# Reverse engineering avec radare2

## Outils MCP

Serveur `r2mcp` (outils préfixés `mcp__r2mcp__`) :
- `open_file` : ouvre un binaire (chemin absolu).
- `analyze` : analyse les fonctions.
- `show_info` : architecture, bits, endianness, canary, nx, pic, relro.
- `list_entrypoints`, `list_functions`, `list_functions_tree`, `list_methods`, `list_classes`.
- `list_imports`, `list_exports`, `list_symbols`, `list_sections`, `list_libraries`.
- `list_strings`, `list_all_strings`.
- `decompile_function` (pdc) et `disassemble_function`.
- `xrefs_to`, `lookup_address`, `lookup_symbol`, `lookup_export`, `calculate`, `hexdump`.
- `get_function_prototype`, `show_function_details`, `list_decompilers`.

## Workflow

1. **Protections** : `mcp__ctf__checksec_binary` + `r2mcp.show_info`.
2. **Entrées** : `list_entrypoints`, `list_imports`, `list_strings`.
3. **Fonctions** : `list_functions`, repérer `main`, `win`, `flag`, `check`, `verify`.
4. **Décompilation** : `decompile_function` sur `main` puis sur les fonctions appelées.
5. **Xrefs** : `xrefs_to` sur les chaînes/imports intéressants.
6. **Désassemblage** : `disassemble_function` si la décompilation est ambiguë.
7. **Reconstruction** : extraire la contrainte, la résoudre avec Python/z3/CyberChef.
8. **Vérification** : relancer le binaire avec l'entrée reconstruite.

## CLI de secours

```bash
r2 -A -q -c 'iI; ie; afl; izz; axt @ str.flag; pdf @ main' ./binary
r2 -A -q -c 's main; pdf' ./binary
rabin2 -I -z -i -s ./binary
objdump -d -M intel ./binary | less
```

## Binaire strippé

- Utiliser les chaînes et les xrefs, pas les noms.
- Repérer les wrappers libc (`read`, `scanf`, `strcmp`, `memcmp`, `puts`).
- Chercher les constantes magiques, les tables, les boucles de transformation.
- Pour un binaire packed/UPX : `upx -d`, `binwalk`, entropie.
- Pour un firmware : `binwalk -e`, `file`, `strings`, architectures.

## Pwn

Après le reverse : checksec, offset via `mcp__ctf__pwn_cyclic`, gadgets via `mcp__ctf__rop_gadgets`, script pwntools. Voir la commande `ctf-pwn`.

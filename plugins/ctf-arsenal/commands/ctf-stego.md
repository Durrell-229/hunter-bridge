---
description: Stéganographie CTF (images, audio, archives, métadonnées)
argument-hint: <fichier>
---

Cible : **$ARGUMENTS**

## 1. Triage

- `mcp__ctf__file_triage`.
- `Bash` : `exiftool`, `pngcheck -v`, `identify -verbose`, `strings`, `binwalk`, `foremost`.
- Vérifie les métadonnées, commentaires, chunks PNG, EXIF, palette, LSB.

## 2. Casser

- `mcp__ctf__stegseek_crack` avec `rockyou.txt` (si steghide).
- `zsteg -a` si installé (Ruby), sinon `python` + Pillow pour LSB.
- `binwalk -e` pour les archives imbriquées.
- Audio : spectrogramme (`sox`, `ffmpeg`), `strings`, `steghide`, `deepsound` si dispo.
- Archives : `7z l`, `unzip -l`, mots de passe (`zip2john` + john si dispo).
- Pour les images, teste les canaux LSB, alpha, palette, et les dimensions.

## 3. Sortie

- Type de stégano, payload extrait, flag.
- Commande exacte et fichier de sortie.
- Ne supprime pas les fichiers intermédiaires avant d'avoir confirmé le flag.

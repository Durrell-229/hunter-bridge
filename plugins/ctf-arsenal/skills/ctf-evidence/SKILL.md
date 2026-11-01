---
name: ctf-evidence
description: Structurer les preuves et le rapport final d'un CTF ou d'un bug bounty. Utiliser avant de rendre un flag, un writeup ou un rapport de vulnérabilité.
---

# Preuves et rapport

## Règles

- Une affirmation = une preuve reproductible.
- Distinguer : confirmé, probable, non testé.
- Ne jamais inventer un flag ou une sortie.
- Ne jamais publier une clé, un token ou un secret réel.
- Conserver les commandes exactes et les chemins de fichiers.

## Bloc de preuve

```text
Cible :
Date :
Scope :
Commande :
Sortie :
Hash / flag :
Fichier :
```

## Rapport

1. Résumé (cible, type, sévérité, statut).
2. Scope et autorisation.
3. Reproduction numérotée.
4. Preuve (requête/réponse, commande, capture, hash).
5. Impact.
6. Cause racine.
7. Remédiation.
8. Annexes (scripts, fichiers, chronologie).

## Flag

Donner le flag seulement s'il correspond au format attendu et qu'il a été obtenu par une commande vérifiable. Sinon, donner la piste la plus proche et la prochaine expérience.

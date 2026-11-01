---
description: Rapport CTF/bug bounty structuré avec preuves et remédiation
argument-hint: [notes ou challenge]
---

Transforme les notes de session en rapport.

## Format

```markdown
# <Titre>

## Résumé
- Cible :
- Type :
- Sévérité :
- Statut : résolu / partiel / bloqué

## Scope et autorisation
- Périmètre :
- Date :
- Limites :

## Reproduction
1. ...
2. ...

## Preuve
- Requête/réponse, commande, hash, capture, flag.
- Ne mets pas de clé secrète réelle dans le rapport.

## Impact
...

## Cause racine
...

## Remédiation
...

## Annexes
- Fichiers, scripts, hashes, chronologie.
```

## Règles

- Chaque affirmation doit être appuyée par une preuve reproductible.
- Distingue clairement confirmé / probable / non testé.
- Pour un flag, donne le format et le chemin d'obtention.
- Pour un bug bounty, reste dans le scope et respecte les règles du programme.

# Hunter Tunnel — chisel durci, proxychains, VPN et IA externes

`hunter-tunnel` est le composant tunnel durci de Hunter Bridge (installé par
`scripts/bootstrap.sh` dans `~/.local/bin/hunter-tunnel`). Il remplace les
fonctions chisel/proxychains/Colab du wrapper d'origine avec une configuration
vérifiée par tests d'intrusion locaux.

## Ce qui a été corrigé (failles prouvées puis fermées)

| # | Défaut d'origine | Correctif |
|---|---|---|
| 1 | chisel server sur `0.0.0.0` **sans auth** → SOCKS5 + reverse tunnel ouverts via l'URL Cloudflare publique | bind `127.0.0.1` (`CHISEL_BIND_HOST`) + `--auth` obligatoire, secret aléatoire persisté en `600` (`~/.config/hunter/chisel-auth`) |
| 2 | Receiver Colab : lecture de fichier arbitraire (`GET /download/../...`) | résolution `realpath` + confinement : tout chemin hors dossier → `404` |
| 3 | Receiver Colab : écriture arbitraire (`X-Filename: ../../...`, handler sur `0.0.0.0` à chaque `hunter claude`) | nom de fichier aseptisé (`basename`), écriture confinée à `<artefacts>/raw/`, bind `127.0.0.1` |
| 4 | `proxychains.conf` avec `localnet 192.168.0.0/16` et `10.0.0.0/8` → **les cibles CTF sortaient en direct, sans le tunnel** | seule la loopback est en `localnet` ; exceptions volontaires via `HUNTER_PROXYCHAINS_LOCALNET` |
| 5 | Boucle d'attente testait `ss | grep "127.0.0.1:$PORT "` alors que chisel affiche `*:PORT` → jamais détecté | helper `port_listening` qui accepte `*:P` et `127.0.0.1:P` |
| 6 | `HUNTER_CHISEL_SERVER/KEY/SOCKS_PORT/REMOTE_PORT` documentés mais jamais lus | mode distant réellement implémenté : `HUNTER_CHISEL_SERVER=host:port HUNTER_CHISEL_KEY=user:pass hunter-tunnel start` |
| 7 | `pkill -f "chisel client.*--socks5"` ne matchait jamais le client réellement lancé → processus orphelins | patterns alignés sur les `argv` réels + kill par pidfile |
| 8 | Remotes Colab/IA inversés (`R:1080:socks`) → le trafic serait sorti **côté IA**, jamais par le VPN | remotes normaux : `1080:socks`, `8888:127.0.0.1:8888` ; `R:` interdit dans les commandes générées |
| 9 | `npm test` (`node --test test/`) cassé sous Node 24 | `node --test test/*.test.js` (74 tests verts) |

## Démarrage

```bash
hunter-tunnel auto          # RECOMMANDÉ : pre-flight + tunnel + Colab d'un coup
hunter-tunnel start         # tunnel seul (server local + SOCKS5 + URL publique)
hunter-tunnel status
hunter-tunnel stop
```

### `auto` — l'empilement « jamais bloqué »

`auto` enchaîne dans cet ordre, **aucune étape n'est fatale** :

1. **pre-flight** (`pre`) : Internet direct vérifié en premier — sans lui,
   les IA, les clés API et Cloudflare ne marchent pas. Détecte aussi les
   doublons OpenVPN (la cause n°1 des coupures pendant un CTF) et les
   processus chisel zombies ;
2. **tunnel** : server durci + SOCKS5 + URL publique (échec signalé, suite OK) ;
3. **Colab receiver** : idem.

Résultat : ta connexion Internet reste **toujours** utilisable pour les IA,
   et le VPN du jeu ne porte que le trafic des cibles.

### `wait-net` — ne plus jamais attendre un challenge qui démarre

```bash
hunter-tunnel wait-net 192.168.5.65 80 120   # attend 2 min max, sort dès que ça répond
```

Teste la cible **à travers le SOCKS5** (donc via le VPN) toutes les secondes.
Utile quand la box du challenge met 1–2 min à démarrer.

Au démarrage :

1. **chisel server** écoute sur `127.0.0.1:8080` et exige une authentification
   (`user:pass` généré une fois, stocké en `600` dans `~/.config/hunter/chisel-auth`) ;
2. un **client local** expose le SOCKS5 interne du serveur sur `127.0.0.1:1080` ;
3. **cloudflared** publie une URL `https://…trycloudflare.com` (fichier
   `/tmp/hunter-chisel-public-url.txt`, mode `600`). Cette URL ne suffit pas :
   sans le secret, la connexion est rejetée (`Authentication failed`) ;
4. `proxychains.conf` est régénéré dans `~/.local/share/hunter/etc/`.

## Vérifier l'anonymat (à faire avant chaque CTF)

```bash
hunter-tunnel proxy-check        # IP de sortie directe vs tunnel
hunter-tunnel proxychains-check  # requête témoin via proxychains4
```

- `proxy-check` doit afficher une **IP différente** en « tunnel » et en « direct » ;
- si le VPN CTF est connecté et que la cible est derrière, le trafic
  `proxychains4` sort par l'IP du VPN, pas la tienne.

## Atteindre les cibles du jeu

```bash
# Le VPN CTF doit être connecté (hunter le lance au démarrage).
proxychains4 -f ~/.local/share/hunter/etc/proxychains.conf nmap -sT -Pn 192.168.5.65

curl --proxy socks5h://127.0.0.1:1080 http://192.168.5.65/
```

Le trafic part : outil → SOCKS5 local (1080) → chisel → **sortie par le VPN de
la machine locale**. Exception ponctuelle (réseau à joindre en direct) :

```bash
HUNTER_PROXYCHAINS_LOCALNET=10.8.0.0/8 hunter-tunnel start
```

## Donner l'accès à une IA externe (pont infra ↔ jeu)

```bash
hunter-tunnel cmd-ia     # commande exacte à copier chez l'IA distante
```

Côté IA/VPS distant :

```bash
chisel client --auth '<secret>' [--fingerprint '<fp>'] 'https://…trycloudflare.com' 1080:socks
proxychains4 -f <conf> nmap -sT -Pn 192.168.5.65   # sort par NOTRE VPN
```

- remote `1080:socks` : le trafic de l'IA ressort par **notre** machine (VPN) ;
- remote `8888:127.0.0.1:8888` : l'IA peut **poster des artefacts** vers le
  receiver local (`POST /upload?filename=rap.json`) ;
- les remotes `R:` sont volontairement absents : ils inverseraient le sens du
  trafic (sortie côté IA).

## Colab

```bash
hunter-tunnel colab-start    # receiver durci + commande à coller dans Colab
hunter-tunnel colab-cmd      # (re)générer la commande
hunter-tunnel colab-status
hunter-tunnel colab-stop
```

Artefacts reçus dans `~/hunter-colab-artifacts/raw/`.

## Mode « mon propre serveur chisel » (VPS)

```bash
HUNTER_CHISEL_SERVER=mon-vps.example:8080 \
HUNTER_CHISEL_KEY='hunter:motdepasse' \
hunter-tunnel start
```

Le SOCKS5 local (`127.0.0.1:1080`) passe alors par ton serveur. Sur le VPS :

```bash
chisel server --socks5 --reverse --auth 'hunter:motdepasse'
```

## Variables

| Variable | Défaut | Rôle |
|---|---|---|
| `CHISEL_BIND_HOST` | `127.0.0.1` | interface d'écoute du server local |
| `CHISEL_SERVER_PORT` | `8080` | port HTTP/WebSocket du server |
| `CHISEL_SOCKS_PORT` | `1080` | port SOCKS5 local |
| `HUNTER_CHISEL_SERVER` | — | `host:port` d'un serveur distant (mode client) |
| `HUNTER_CHISEL_KEY` | — | `user:pass` du serveur distant |
| `HUNTER_PROXYCHAINS_LOCALNET` | — | réseaux ajoutés en `localnet` (sortie directe) |
| `HUNTER_CHISEL_NO_PUBLIC` | `0` | `1` = ne pas démarrer cloudflared |

## Vérifications effectuées (2026-11-05)

- client **sans** auth → `Authentication failed`, requête témoin en échec (`000`) ;
- client avec **mauvais** mot de passe → idem ;
- client authentifié → `200` à travers le SOCKS5 ;
- `GET /download/../secret` → `404` JSON (plus de lecture hors dossier) ;
- `POST /upload` avec `X-Filename: ../../pwned.txt` → écrit confiné dans `raw/`,
  **aucun** fichier créé hors du dossier d'artefacts ;
- binds réels : `127.0.0.1:8080`, `127.0.0.1:1080`, receiver `127.0.0.1:8888` ;
- `start`/`stop` idempotents, mode distant fonctionnel (SOCKS5 `200`) ;
- **pont IA externe prouvé** : un client chisel connecté via l'URL publique
  `trycloudflare.com` a atteint le receiver `127.0.0.1:8888` — service visible
  **uniquement** depuis la machine locale — donc le trafic distant ressort bien
  par la machine qui porte le VPN ;
- `auto` : stack complet démarré, URL publique réelle obtenue, exit 0 même avec
  des avertissements (jamais bloquant) ;
- `pre` : détecte réellement le scénario zombie (port SOCKS actif, pidfile
  perdu) et les doublons OpenVPN ;
- `wait-net 127.0.0.1 8888` : succès en 1 s sur service vivant via le SOCKS5.

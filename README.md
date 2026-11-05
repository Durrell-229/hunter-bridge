# Hunter Bridge

**Hunter Bridge** est un pont local entre l’API Anthropic Messages (utilisée par Claude Code) et plusieurs fournisseurs de modèles OpenAI-compatibles :

- **Groq**
- **OpenCode Zen**
- **NVIDIA NIM**
- **Google Gemini**

Il ajoute un **routeur de modèles**, un **harnais de décision** orienté CTF / bug bounty, un **dashboard d’administration temps réel**, la gestion des **serveurs MCP** et des **plugins Claude Code**, ainsi qu’un lancement unifié.

> Projet autonome, zéro dépendance npm, Node.js ≥ 18.17, modules ESM, tests avec `node:test`.

---

## Pourquoi Hunter Bridge ?

Claude Code parle uniquement l’API Anthropic. Hunter Bridge traduit ses requêtes vers des fournisseurs OpenAI-compatibles, puis traduit les réponses et les tool calls dans l’autre sens.

Au-delà du proxy, Hunter Bridge apporte :

- un **classifieur local** qui détecte une tâche `ctf`, `bugbounty`, `pwn`, `rev`, `web`, `crypto`, `forensics`, `recon`, etc. ;
- des **profils de routage** avec chaînes de repli par fournisseur ;
- des **consignes de harnais** injectées dans le prompt système selon le profil ;
- un **fallback automatique** sur 429, 5xx, timeout, 401/403 ou modèle incompatible ;
- un **dashboard** pour changer les profils, les chaînes, les clés, les modèles MCP et les plugins à chaud ;
- un **lanceur unique** : proxy + dashboard + MCP + plugins + Claude Code.

---

## Démarrage rapide

```bash
cd ~/Bureau/hunter-bridge
npm run init
```

`init` crée `hunter.config.json` (sans secret) et `.env` à partir de `.env.example`.

Renseigne **au moins une clé** dans `.env` :

```dotenv
GROQ_API_KEY=gsk_...
OPENCODE_API_KEY=...
NVIDIA_API_KEY=nvapi-...
GEMINI_API_KEY=...
```

Puis :

```bash
npm run doctor -- --chat
npm run claude -- --profile ctf
```

- `npm run doctor -- --chat` vérifie les clés, les endpoints et fait un vrai petit appel.
- `npm run claude -- --profile ctf` démarre le proxy, le dashboard, génère la config MCP, puis lance Claude Code avec le profil CTF.

> **Ne colle jamais une clé API dans un chat, un ticket ou un fichier versionné.** Si une clé a été exposée, révoque-la et remplace-la.

---

## Deux façons de lancer

### Tout-en-un

```bash
npm run claude -- --profile ctf
```

Cette commande :

1. démarre le proxy Anthropic → fournisseurs ;
2. sert le dashboard sur `http://127.0.0.1:8787/dashboard` ;
3. écrit `.hunter/mcp.json` si des serveurs MCP sont configurés ;
4. passe les dossiers de plugins à Claude Code ;
5. lance `claude` avec les bonnes variables d’environnement.

Les arguments après `--` sont transmis à Claude Code :

```bash
npm run claude -- --profile bugbounty -- --resume
```

### Depuis un autre projet

`npm run claude` s’exécute dans le dossier de Hunter Bridge : Claude Code voit donc les fichiers du pont. Pour travailler dans le dossier courant, lance l’alias `hunter` depuis ton projet :

```bash
cd ~/projets/mon-ctf
hunter --profile ctf
```

`hunter` sans sous-commande lance Claude Code ; `hunter start`, `hunter doctor`, etc. restent disponibles. Le proxy utilise toujours `hunter.config.json` et `.env` du pont, mais le répertoire de travail de Claude Code reste celui depuis lequel tu as lancé la commande.

Le lanceur `hunter` installé par `scripts/bootstrap.sh` ajoute :

- la détection des fichiers `.ovpn` et le lancement d’OpenVPN en **split tunnel** : Internet reste sur la connexion locale, le VPN ne porte que le trafic des cibles ;
- `hunter vpn-reset` pour arrêter les instances OpenVPN en double et repartir proprement ;
- `hunter vpn-route 192.168.5.0/24` pour envoyer un sous-réseau de cibles dans le tunnel sans couper Internet ;
- `HUNTER_VPN_ROUTES=192.168.5.0/24,10.10.0.0/16` pour ajouter ces routes automatiquement au démarrage du VPN ;
- `hunter sudo-setup` / `hunter sudo-clear` pour installer ou oublier le mot de passe sudo local (jamais commité) ;
- **Chisel / Proxychains** : tunnel SOCKS5 via serveur distant — `HUNTER_CHISEL_SERVER=user@host:port` + `hunter chisel-start` ;
- `HUNTER_SKIP_VPN=1` pour ignorer complètement le VPN ;
- `HUNTER_VPN_FULL_TUNNEL=1` pour router tout le trafic via le VPN ;
- `hunter rea …` pour utiliser le CLI REA sans charger ses 207 outils MCP dans Claude Code ;
- `HUNTER_MCP_STRICT=0` pour réautoriser les serveurs MCP du niveau utilisateur (dont `rea`).

Sans alias, la commande équivalente est :

```bash
HUNTER_ENV_FILE=~/Bureau/hunter-bridge/.env \
  node ~/Bureau/hunter-bridge/bin/hunter.js claude \
  --config ~/Bureau/hunter-bridge/hunter.config.json \
  --profile ctf
```

### Proxy seul

```bash
npm start
# dashboard : http://127.0.0.1:8787/dashboard
```

Puis, dans un autre terminal :

```bash
source <(node bin/hunter.js env)
claude
```

### Commandes

| Commande | Rôle |
|---|---|
| `npm run init` | crée la configuration et `.env` si absent |
| `npm start` / `npm run up` | proxy + dashboard |
| `npm run claude -- --profile ctf` | tout lancer puis Claude Code |
| `npm run doctor -- --chat` | diagnostic complet + test réel |
| `npm run models` | modèles locaux/découverts par fournisseur |
| `npm run env` | variables d’environnement Claude Code |
| `npm test` | suite de tests |

Options utiles : `--profile`, `--model` (cible explicite), `--provider`, `--config`, `--dotenv` (ou `HUNTER_ENV_FILE`), `--port`, `--host`, `--no-mcp`, `--no-plugins`, `--json`.

---

## Dashboard

Ouvrir <http://127.0.0.1:8787/dashboard>.

Onglets :

- **Vue d’ensemble** : requêtes, erreurs, tokens, fallbacks, état des fournisseurs, dernière décision du routeur.
- **Fournisseurs** : activer/désactiver, tester, découvrir les modèles, saisir une clé.
- **Routage** : profil actif, **mapping Sonnet/Opus/Haiku**, chaînes de modèles, mots-clés du classifieur, consignes du harnais.
- **MCP** : ajouter/modifier/supprimer des serveurs stdio, HTTP ou SSE, exporter `mcp.json`.
- **Plugins** : ajouter/retirer des dossiers `--plugin-dir`.
- **Journal** : requêtes récentes, modèle réellement utilisé, latence, tokens, erreurs.

Les mises à jour arrivent en **SSE** (`/api/events`). Le dashboard ne renvoie jamais les clés complètes : seulement `clé configurée/absente` et un masque.

Sécurité :

- par défaut, écoute sur `127.0.0.1` ;
- si `HUNTER_ADMIN_TOKEN` est défini, les routes admin exigent `Authorization: Bearer …` ou `x-hunter-admin` ;
- sans jeton, les routes admin ne sont accessibles que depuis la loopback ;
- les clés saisies dans le dashboard sont écrites dans `.env` en mode `600` ;
- `hunter.config.json` et `.hunter/mcp.json` sont en mode `600` et gitignorés ;
- aucun corps de requête n’est journalisé.

---

## Fournisseurs

| ID | Fournisseur | Base URL | Variable de clé |
|---|---|---|---|
| `groq` | Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `opencode` | OpenCode Zen | `https://opencode.ai/inference/openai/v1` | `OPENCODE_API_KEY` |
| `nvidia` | NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` |
| `gemini` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY` |

Alias acceptés : `zen`, `opencodezen`, `nim`, `nvidia-nim`, `google`.

### Syntaxe des modèles

```text
fournisseur/modèle
```

Exemples :

```text
groq/openai/gpt-oss-120b
opencode/claude-sonnet-4-5
nvidia/nvidia/nemotron-3-ultra-550b-a55b
gemini/gemini-2.5-pro
```

Certains IDs de modèles contiennent eux-mêmes un slash (NVIDIA notamment). La cible complète est alors `fournisseur/id-du-modèle`, par exemple `nvidia/nvidia/nemotron-3-ultra-550b-a55b`. La forme courte `nvidia/nemotron-3-ultra-550b-a55b` est aussi reconnue si le modèle existe dans le catalogue.

Un ID Groq brut (`openai/gpt-oss-120b`) reste accepté pour la compatibilité.

### Choisir le modèle dans Claude Code

Claude Code ne connaît que ses propres alias (`sonnet`, `opus`, `haiku`). Hunter Bridge les traduit vers trois **slots** configurables :

1. ouvre le dashboard, onglet **Routage** ;
2. dans **Modèles Claude Code**, choisis une cible pour Sonnet, Opus et Haiku ;
3. clique **Appliquer** — le proxy prend le nouveau mapping en compte dès la requête suivante, sans redémarrer Claude Code.

Ensuite, `/model` dans Claude Code fonctionne réellement :

- `Sonnet` → la cible choisie pour le slot `sonnet` ;
- `Opus` → la cible choisie pour le slot `opus` ;
- `Haiku` → la cible choisie pour le slot `haiku`.

Pour forcer un modèle précis sans passer par `/model` :

```bash
npm run claude -- --model nvidia/nvidia/nemotron-3-ultra-550b-a55b
```

Le dashboard affiche le modèle réellement utilisé dans le journal (`fournisseur/modèle`). Les catalogues locaux sont fournis à titre indicatif : utilise **Découvrir les modèles** ou `npm run models` pour vérifier les IDs accessibles avec ta clé.

---

## Routage et harnais agentique

Profils fournis :

| Profil | Usage |
|---|---|
| `auto` | classifie la demande puis choisit la meilleure chaîne disponible |
| `fast` | faible latence, faible coût |
| `code` | développement, débogage, tests |
| `bugbounty` | scope, recon, web/API, preuves |
| `ctf` | challenges difficiles, multi-étapes |
| `recon` | DNS, sous-domaines, OSINT, surface d’attaque |
| `web` | XSS, SSRF, IDOR, JWT, logique métier |
| `pwn` | binaire, mémoire, ROP, heap |
| `rev` | Ghidra/IDA, firmware, APK, obfuscation |
| `crypto` | RSA, ECC, lattices, PRNG |
| `forensics` | PCAP, mémoire, disque, stégano, malware |
| `general` | assistant technique polyvalent |

Chaque profil contient :

- une **chaîne de cibles** (`fournisseur/modèle`) essayées dans l’ordre ;
- des **mots-clés** pour le classifieur local ;
- une **consigne de harnais** ajoutée au prompt système.

Le routeur filtre automatiquement les cibles :

- fournisseur désactivé ;
- clé absente ;
- modèle sans support des outils alors que Claude Code envoie des tools ;
- contexte insuffisant ;
- fournisseur en cooldown après 429/5xx.

En cas d’échec, il passe à la cible suivante. Les en-têtes de réponse indiquent la décision :

```text
x-hunter-profile: ctf
x-hunter-provider: groq
x-hunter-model: openai/gpt-oss-120b
x-hunter-target: groq/openai/gpt-oss-120b
x-hunter-fallback: 0
```

Pour un challenge difficile :

```bash
npm run claude -- --profile ctf
```

Pour laisser le classifieur choisir :

```bash
npm run claude -- --profile auto
```

---

## MCP

Ajoute un serveur dans le dashboard, ou édite directement `hunter.config.json` :

```json
{
  "mcp": {
    "servers": [
      {
        "name": "github",
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
        "enabled": true
      },
      {
        "name": "remote",
        "type": "http",
        "url": "http://127.0.0.1:3000/mcp",
        "headers": { "Authorization": "Bearer ${MCP_TOKEN}" },
        "enabled": true
      }
    ]
  }
}
```

Les valeurs `${VAR}` sont résolues depuis `.env` au moment de générer `.hunter/mcp.json`. Le fichier est en mode `600`.

`npm run claude` ajoute automatiquement `--mcp-config .hunter/mcp.json`. Utilise `--no-mcp` pour désactiver.

---

## Plugins Claude Code

Ajoute des dossiers de plugins dans le dashboard (onglet **Plugins**) ou dans `hunter.config.json` :

```json
{ "plugins": { "paths": ["~/plugins/mon-plugin"] } }
```

Un plugin valide contient `.claude-plugin/plugin.json`. Les dossiers valides sont passés à Claude Code via `--plugin-dir`. Utilise `--no-plugins` pour désactiver.

---

## Variables Claude Code

`hunter claude` configure notamment :

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
ANTHROPIC_AUTH_TOKEN=local-hunter-bridge
ANTHROPIC_MODEL=claude-sonnet-4-5
ANTHROPIC_SMALL_FAST_MODEL=claude-3-5-haiku-latest
CLAUDE_CODE_MAX_CONTEXT_TOKENS=<min des contextes disponibles>
CLAUDE_CODE_AUTO_COMPACT_WINDOW=<contexte - marge>
CLAUDE_CODE_MAX_OUTPUT_TOKENS=<min des limites>
ENABLE_TOOL_SEARCH=false
```

`ANTHROPIC_API_KEY`, Bedrock, Vertex, Foundry et Mantle sont retirés de l’environnement enfant pour éviter un routage involontaire.

Si Claude Code n’est pas dans le `PATH`, Hunter Bridge cherche aussi :

- `~/.local/bin/claude`
- `~/.claude/local/claude`
- `~/.npm-global/bin/claude`
- `/usr/local/bin/claude`
- `HUNTER_CLAUDE_BIN`

---

## Dépannage

### `413 Request too large` / limite TPM Groq

Le plan gratuit Groq est limité à **8 000 TPM**. Une requête Claude Code complète peut dépasser cette limite (souvent 20k–25k tokens). Hunter Bridge écarte automatiquement Groq quand l’entrée estimée dépasse `maxInputTokens` (6 000 par défaut) et passe à la cible suivante. Solutions :

1. passer au **Dev Tier** Groq ;
2. utiliser un autre fournisseur (OpenCode Zen, Gemini, NVIDIA) ;
3. réduire le nombre d’outils et le prompt système ;
4. utiliser le profil `fast` et un petit modèle ;
5. accepter un mode minimal avec `--tools 'Read,Edit,Write,Bash'`.

Hunter Bridge journalise le fallback et le cooldown dans le dashboard.

### `401` / clé invalide

- Vérifie la variable indiquée par le fournisseur.
- Révoque toute clé exposée et recrée-la.
- Dans le dashboard, la clé n’est jamais réaffichée : saisis-la à nouveau.

### `Aucun modèle disponible`

- Vérifie qu’au moins une clé est configurée.
- Vérifie que le fournisseur est activé.
- Vérifie que le modèle supporte les outils si Claude Code en envoie.
- Regarde `Candidats écartés` dans l’erreur ou la dernière décision du dashboard.

### Contexte trop gros / `410 Model ... has been deprecated`

Claude Code charge aussi les serveurs MCP du niveau utilisateur. Avec `rea` (207 outils), la requête peut dépasser **250k tokens** : trop pour les modèles NVIDIA (128k), le routeur bascule alors vers un modèle OpenCode obsolète. Hunter lance Claude Code avec `--strict-mcp-config` et les 7 serveurs de `hunter.config.json` (≈120 outils, ≈55k tokens). Pour utiliser `rea` en MCP, il faut un modèle à 1M de contexte et `HUNTER_MCP_STRICT=0` ; sinon utilise `hunter rea …`.

### NVIDIA `fetch failed` / Internet coupé après le VPN

Plusieurs instances OpenVPN qui se disputent les routes coupent Internet. `hunter` détecte les doublons et propose de les arrêter. Sinon :

```bash
hunter vpn-reset
# ou
sudo pkill -x openvpn
```

Le lanceur ajoute `--pull-filter ignore redirect-gateway` pour garder Internet direct. Utilise `HUNTER_VPN_FULL_TUNNEL=1` si tu veux au contraire tout router dans le VPN.

### Cible VPN injoignable : tous les ports `filtered`

En split tunnel, seuls `10.8.0.0/24` (le réseau du tunnel) est routé. Une cible comme `192.168.5.65` sort par la passerelle locale et reste filtrée. Vérifie :

```bash
ip route get 192.168.5.65
# si la réponse contient "dev wlo1" au lieu de "dev tun0", la cible ne passe pas par le VPN
```

Ajoute la route du sous-réseau de la cible sans couper Internet :

```bash
hunter vpn-route 192.168.5.0/24
ip route get 192.168.5.65   # doit maintenant indiquer dev tun0
ping -c 2 192.168.5.65
```

Pour rendre la route permanente à chaque connexion VPN, exporte `HUNTER_VPN_ROUTES` avant de lancer Hunter :

```bash
HUNTER_VPN_ROUTES=192.168.5.0/24 hunter
```

Si le serveur VPN ne route pas ce sous-réseau, passe en tunnel complet (tout le trafic, y compris les API IA, passe par le VPN) :

```bash
HUNTER_VPN_FULL_TUNNEL=1 hunter vpn-reset
```

La passerelle utilisée est `10.8.0.1` par défaut ; surcharge-la avec `HUNTER_VPN_GATEWAY=10.8.0.1`. Pour retirer une route : `sudo ip route del 192.168.5.0/24`.

### Sudo sans mot de passe pour `nmap -sS/-sU`

```bash
hunter sudo-setup    # demande le mot de passe une fois, stocke-le en mode 600
hunter sudo-clear    # oublie le mot de passe
```

Le mot de passe est stocké dans `~/.config/hunter/sudo-pass` (hors dépôt, ignoré par git). Le helper `~/.local/share/hunter/bin/sudo` n’est actif que si `HUNTER_SUDO_AUTO=1` ; Hunter l’exporte pour Claude Code et les serveurs MCP. Le MCP `ctf` utilise automatiquement `sudo` pour les options Nmap qui exigent root (`-sS`, `-sU`, `-O`, etc.). Sécurité : tout processus lancé dans ta session peut utiliser ce mot de passe ; `hunter sudo-clear` le supprime.

### Chisel Server + Cloudflare Tunnel — Accès public auto pour IA distantes (Zéro config, zéro VPS)

**But** : Tu es sur le VPN CTF (autorisé). Tu veux donner une **URL publique** à n'importe quelle IA (ChatGPT, Claude Web, Gemini, etc.) pour qu'elle puisse scanner/attaquer le réseau CTF **via ta machine** — sans VPS, sans config manuelle.

**Architecture** :
```
[IA distante] --(HTTPS/WSS public)--> [Cloudflare Tunnel] --> [Chisel Server LOCAL:8080]
                                                                       |
                                                                       +--> SOCKS5 plain (1080) → proxychains4 pour tes outils locaux
                                                                       +--> Reverse tunnels (R:8081:socks) → réseau VPN (192.168.5.0/24, etc.)
```

**Zéro config** : Tout démarre auto avec `hunter` / `hunter claude` / `hunter start` :
1. VPN connecté (split tunnel)
2. **Chisel Server** démarre sur `127.0.0.1:8080` (HTTP/WebSocket + SOCKS5 via upgrade, `--reverse` activé)
3. **Chisel Client local** connecte au serveur local → expose **SOCKS5 plain sur `127.0.0.1:1080`** (pour `proxychains4`)
4. **Cloudflared Tunnel** créé auto → URL publique `https://xxx.trycloudflare.com`
5. URL affichée dans `hunter chisel-status` et sauvée dans `/tmp/hunter-chisel-public-url.txt`

**Commandes** :
```bash
# Tout est auto avec hunter/hunter claude, mais commandes dispo :
hunter chisel-start     # Lance server + client local + tunnel cloudflare
hunter chisel-status    # Affiche l'URL PUBLIQUE à donner à l'IA
hunter chisel-stop      # Arrête tout

# Pour tes outils locaux (nmap, ffuf, curl, sqlmap...) via le VPN :
proxychains4 -f ~/.local/share/hunter/etc/proxychains.conf nmap -sT -Pn 192.168.5.65
```

**Donner l'accès à une IA distante** :
```bash
# L'URL publique (ex: https://abc123.trycloudflare.com)
# L'IA fait simplement :
chisel client https://abc123.trycloudflare.com R:8081:socks
# Puis dans l'IA : proxychains4 -f <config> nmap -sT -Pn 192.168.5.65
```
L'IA n'a **pas besoin de ton VPN**, juste de l'URL. Le trafic passe : IA → Cloudflare → Ton Chisel Server → Ton VPN → Cible CTF.

**Prérequis** (auto-installés par `scripts/bootstrap.sh`) :
- `chisel` (binaire dans `~/.local/share/hunter/bin/`)
- `cloudflared` (binaire dans `~/.local/share/hunter/bin/`)
- `proxychains4` (`sudo pacman -S proxychains-ng` / `apt install proxychains4`)

**Variables d'env** (optionnelles, dans `.env`) :
```bash
CHISEL_SERVER_PORT=8080      # Port HTTP/WebSocket chisel server (défaut 8080)
CHISEL_SOCKS_PORT=1080       # Port SOCKS5 plain pour proxychains (défaut 1080)
CHISEL_REVERSE_PORT=8081     # Port reverse pour l'IA (défaut 8080)
```

**Sécurité** : Le tunnel Cloudflare est éphémère (nouvelle URL à chaque démarrage). L'IA ne voit que l'URL publique, pas ton IP locale ni ton VPN. Tu peux arrêter le tunnel n'importe quand avec `hunter chisel-stop`.

### Colab Worker — Google Colab comme accélérateur download/forensic

**But** : Utiliser la bande passante, le CPU/GPU et le stockage gratuit de Google Colab pour :
1. **Télécharger** de gros artefacts (images disque, dumps mémoire, ISOs, PCAPs) via ton VPN CTF
2. **Analyser** en forensic (binwalk, volatility, strings, foremost, autopsy, etc.)
3. **Renvoyer** uniquement les artefacts pertinents (fichiers extraits, rapports, IOCs) sur ton PC
4. **Traiter** localement avec tes IA (Hunter/Claude Code) sans saturer ta connexion

**Architecture** :
```
[Google Colab] --(chisel client)--> [Cloudflare Tunnel] --> [Chisel Server LOCAL:8080]
                                      |                          |
                                      |                          +--> SOCKS5 (1080) → Colab navigue via ton VPN
                                      |                          +--> Reverse 8888 → HTTP Receiver local (uploads)
                                      |                          +--> Reverse 8889 → Raw TCP (gros fichiers)
                                      |
                                      +--> Colab: requests.get(..., proxies={"http":"socks5h://127.0.0.1:1080"})
                                      +--> Colab: télécharge gros-fichier.img (Go) depuis cible CTF
                                      +--> Colab: binwalk/volatility/strings → extrait artefacts
                                      +--> Colab: POST http://127.0.0.1:8888/upload (via tunnel) → Ton PC
                                      +--> Ton PC: reçoit dans ~/hunter-colab-artifacts/raw/
                                      +--> Tes IA locales: analysent immédiatement
```

**Zéro config** : Tout démarre auto avec `hunter` / `hunter claude` :
```bash
hunter
# ou
hunter colab-start
```

**Récupère la commande pour Colab** :
```bash
hunter colab-status
# Affiche la commande complète à copier-coller dans une cellule Google Colab
```

**Commandes** :
```bash
hunter colab-start     # Lance receiver HTTP + génère commande Colab (auto avec hunter)
hunter colab-status    # Affiche URL publique + commande Colab + artefacts reçus
hunter colab-stop      # Arrête receiver
```

**Dans Google Colab (copie-collé depuis `hunter colab-status`)** :
```python
# Cellule 1 : Installe chisel + lance tunnel (garde la cellule en exécution)
! wget -q https://github.com/jpillora/chisel/releases/download/v1.12.0/chisel_1.12.0_linux_amd64.gz -O chisel.gz
! gunzip -f chisel.gz && chmod +x chisel
! ./chisel client https://xxx.trycloudflare.com \
    1080:socks \
    R:8888:127.0.0.1:8888 \
    R:8889:127.0.0.1:8889 \
    --fingerprint chrome --keepalive 10s

# Cellule 2 : Tes scripts download/forensic (exécute autant de fois que voulu)
import requests, os
proxies = {"http": "socks5h://127.0.0.1:1080", "https": "socks5h://127.0.0.1:1080"}

# 1. Télécharge gros fichier via TON VPN (ex: image disque 10 Go)
r = requests.get("http://192.168.5.65/disk.img", proxies=proxies, stream=True)
with open("/content/disk.img", "wb") as f:
    for chunk in r.iter_content(1024*1024): f.write(chunk)

# 2. Analyse forensic (CPU/GPU Colab gratuit)
! binwalk -e /content/disk.img
! volatility -f /content/disk.img linux.pslist > /content/pslist.txt
! strings /content/disk.img | grep -iE "password|flag|secret|key" > /content/creds.txt

# 3. Envoie artefacts vers TON PC (instantané via tunnel)
for f in ["_disk.img.extracted/file1", "pslist.txt", "creds.txt"]:
    requests.post("http://127.0.0.1:8888/upload", files={"file": open(f, "rb")}, proxies=proxies)

# 4. Gros fichiers en raw (plus rapide) :
# ! curl -X POST --data-binary @gros.fichier http://127.0.0.1:8888/upload?filename=gros.fichier --socks5 127.0.0.1:1080
```

**Sur ton PC** :
```bash
# Les artefacts arrivent dans :
ls ~/hunter-colab-artifacts/raw/
# pslist.txt  creds.txt  file1  ...

# Tes IA locales (Hunter/Claude) les traitent immédiatement
hunter claude --profile ctf -- --print "Analyse ~/hunter-colab-artifacts/raw/creds.txt"
```

**Variables d'env** (optionnelles, dans `.env`) :
```bash
COLAB_RECEIVER_PORT=8888       # Port HTTP receiver local (défaut 8888)
COLAB_RAW_PORT=8889            # Port raw TCP (défaut 8889)
COLAB_ARTIFACTS_DIR=~/hunter-colab-artifacts  # Dossier artefacts (défaut ~/hunter-colab-artifacts)
```

**Sécurité** :
- Tunnel Cloudflare éphémère (nouvelle URL à chaque `hunter`)
- Colab n'a **pas** accès à ton PC hors tunnel (seulement port 8888/8889 reverse)
- Tu contrôles tout : `hunter colab-stop` coupe l'accès instantanément
- Artefacts stockés localement, jamais dans le cloud

### Dashboard inaccessible

- `http://127.0.0.1:8787/dashboard`
- Si `HUNTER_ADMIN_TOKEN` est défini, saisis-le dans la fenêtre d’accès.
- Si `HOST=0.0.0.0`, définis impérativement `HUNTER_ADMIN_TOKEN`.

### MCP ne démarre pas

- Teste la commande manuellement.
- Vérifie les variables `${...}` dans `.env`.
- Regarde `.hunter/mcp.json` (mode 600).
- Utilise `--no-mcp` pour isoler le problème.

### Claude Code introuvable

```bash
npm install -g @anthropic-ai/claude-code
# ou
export HUNTER_CLAUDE_BIN=/chemin/vers/claude
```

---

## Tests et vérification

```bash
npm test
bash scripts/verify.sh
```

La suite couvre : traduction Anthropic ↔ OpenAI, streaming SSE, tool calls, erreurs, auth, dashboard, routage multi-fournisseurs, fallback, MCP, plugins, configuration et permissions de fichiers.

Les tests n’utilisent ni réseau ni clé réelle.

---

## Structure

```text
bin/hunter.js          CLI principale
bin/groqcc.js          alias de compatibilité
src/config.js          variables d’environnement et limites
src/settings.js        configuration Hunter, fournisseurs, profils
src/router.js          classifieur, cibles, sélection des candidats
src/runtime.js         état, métriques, persistance, événements
src/upstream.js        client OpenAI-compatible générique
src/server.js          serveur Anthropic Messages + SSE
src/dashboard.js       API admin et SSE
src/mcp.js             MCP, plugins, génération de config
src/translate.js       traduction Anthropic ↔ OpenAI
src/http.js            helpers HTTP, auth, erreurs
public/                dashboard statique (zéro build)
test/                  tests node:test
scripts/verify.sh      syntaxe + config + tests
hunter.config.json     configuration locale (gitignorée, 600)
.env                   clés API (gitignoré, 600)
.hunter/mcp.json       config MCP générée (gitignorée, 600)
```

---

## Limites connues

- Les catalogues de modèles évoluent : utilise la découverte `/models` du dashboard.
- Les fournisseurs OpenAI-compatibles ont des différences de schéma ; Hunter Bridge applique des variantes de repli, mais certains modèles peuvent refuser les tools ou le streaming.
- Le streaming ne peut pas basculer de fournisseur après l’envoi des premiers octets ; le fallback se fait avant le début du flux.
- Le classifieur est déterministe et local (mots-clés), volontairement rapide et sans coût. Il peut être remplacé plus tard par un petit modèle juge.
- Le plan gratuit Groq reste insuffisant pour Claude Code complet.

---

## Licence

MIT.

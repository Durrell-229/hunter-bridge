# groq-claude-bridge

**Utilise les modèles Groq avec Claude Code**, via un proxy local qui expose l'API Anthropic Messages (`/v1/messages`) et la traduit vers l'API OpenAI-compatible de Groq.

```
Claude Code ──(Anthropic Messages + SSE)──▶ groqcc ──(OpenAI Chat Completions + SSE)──▶ Groq
             127.0.0.1:8787
```

Zéro dépendance npm. Node.js ≥ 18.17. Conçu pour tourner en local, sur `127.0.0.1`.

---

## Ce que fait le pont

- `POST /v1/messages` en **streaming SSE** et en **non-streaming**.
- Traduction des **outils** : `tool_use` Anthropic → `tool_calls` OpenAI, `tool_result` → messages `tool`.
- Traduction des événements SSE Anthropic : `message_start`, `content_block_start`, `content_block_delta` (`text_delta` / `input_json_delta`), `content_block_stop`, `message_delta`, `message_stop`.
- Système, messages user/assistant, images (si le modèle Groq les accepte), `temperature`, `top_p`, `stop_sequences`.
- Mapping des noms de modèles Claude Code :
  - `sonnet` / `opus` / `claude-*` → `GROQ_MODEL`
  - `haiku` → `GROQ_SMALL_MODEL`
  - un ID Groq explicite (`openai/gpt-oss-120b`, `llama-3.3-70b-versatile`, …) est respecté.
- `POST /v1/messages/count_tokens` (estimation), `GET /v1/models`, `GET /health`.
- Retries sur `429` / `5xx`, respect de `retry-after`, repli automatique si un modèle refuse `max_completion_tokens` ou `stream_options`.
- Aucune clé API dans les logs.

---

## Démarrage rapide

### 1. Prérequis

- Node.js **18.17 ou plus récent** (`node -v`).
- Une clé Groq : <https://console.groq.com/keys>.
- Claude Code :

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

### 2. Configurer la clé Groq

```bash
cd ~/Bureau/groq-claude-bridge
cp .env.example .env
chmod 600 .env
```

Ouvre `.env` et renseigne :

```dotenv
GROQ_API_KEY=gsk_...
```

> Ne colle pas ta clé dans un chat. Elle doit rester dans `.env` (ou dans une variable d'environnement).

### 3. Vérifier

```bash
npm run doctor
npm run doctor -- --chat     # test réel : consomme quelques tokens
```

### 4. Lancer Claude Code

La commande la plus simple démarre le proxy sur un port libre, puis lance Claude Code avec les bonnes variables :

```bash
npm run claude
```

Pour passer des arguments à Claude Code, utilise le séparateur `--` :

```bash
./bin/groqcc.js claude -- --resume
```

### Mode deux terminaux

```bash
# Terminal 1
npm start

# Terminal 2
source <(node bin/groqcc.js env)
claude
```

Sous fish :

```fish
node bin/groqcc.js env --shell fish | source
```

---

## Modèles recommandés

| Modèle Groq | Contexte | Sortie max | Outils | Usage |
|---|---:|---:|---|---|
| `openai/gpt-oss-120b` | 131 072 | 65 536 | oui | **Défaut** : bon compromis outils / rapidité / prix |
| `openai/gpt-oss-20b` | 131 072 | 65 536 | oui | Petit modèle pour les tâches « haiku » |
| `llama-3.3-70b-versatile` | 131 072 | 32 768 | oui | Alternative Llama |
| `qwen/qwen3.6-27b` | 131 072 | 16 384 | oui, parallèles | Bon pour les outils parallèles |
| `moonshotai/kimi-k2-instruct-0905` | 262 144 | 16 384 | oui | Grand contexte, plus cher |

Configure-les dans `.env` :

```dotenv
GROQ_MODEL=openai/gpt-oss-120b
GROQ_SMALL_MODEL=openai/gpt-oss-20b
```

> **Important** : Claude Code envoie un gros prompt système et beaucoup d'outils. Le free tier Groq (TPM faible) va très vite renvoyer des `429`. Pour un usage réel, prends un plan Developer.

Liste les modèles réellement disponibles avec ta clé :

```bash
npm run models
```

---

## Variables de configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `GROQ_API_KEY` | — | **Obligatoire**. Clé Groq. |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Modèle principal (sonnet/opus). |
| `GROQ_SMALL_MODEL` | `openai/gpt-oss-20b` | Petit modèle (haiku). |
| `HOST` | `127.0.0.1` | Adresse d'écoute. Ne pas exposer par défaut. |
| `PORT` | `8787` | Port d'écoute (`0` = port libre, utile pour `claude`). |
| `PROXY_API_KEY` | vide | Jeton optionnel exigé par le proxy. |
| `MAX_OUTPUT_TOKENS` | `32768` | Plafond de tokens de sortie. |
| `REQUEST_TIMEOUT_MS` | `300000` | Timeout d'une requête non-streamée. |
| `STREAM_TIMEOUT_MS` | `900000` | Timeout d'un stream complet. |
| `BODY_LIMIT_BYTES` | `26214400` | Taille max du corps JSON (images incluses). |
| `GROQ_RETRIES` | `1` | Retries sur 429 / 5xx / erreur réseau. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `STREAMING` | `1` | `0` désactive le streaming vers Groq (le proxy synthétise le SSE). |
| `ALLOWED_HOSTS` | loopback | Liste d'en-têtes `Host` acceptés, séparés par des virgules. |
| `CLAUDE_MODEL` | `claude-sonnet-4-5` | Nom de modèle envoyé par Claude Code. |
| `CLAUDE_SMALL_MODEL` | `claude-3-5-haiku-latest` | Nom du petit modèle envoyé par Claude Code. |

### Protection par jeton

```dotenv
PROXY_API_KEY=un-jeton-local
```

`npm run claude` transmet automatiquement ce jeton. En mode deux terminaux, remplace le placeholder affiché par `groqcc env` :

```bash
export ANTHROPIC_AUTH_TOKEN='un-jeton-local'
# ou
export ANTHROPIC_API_KEY='un-jeton-local'
```

---

## Ce que Claude Code reçoit

`npm run claude` positionne notamment :

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
ANTHROPIC_AUTH_TOKEN=<jeton local>
ANTHROPIC_API_KEY=<jeton local>
ANTHROPIC_MODEL=claude-sonnet-4-5
ANTHROPIC_SMALL_FAST_MODEL=claude-3-5-haiku-latest
ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-5
ANTHROPIC_DEFAULT_OPUS_MODEL=claude-sonnet-4-5
ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-3-5-haiku-latest
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

Le proxy traduit ensuite ces noms vers `GROQ_MODEL` / `GROQ_SMALL_MODEL`.

---

## Architecture interne

```
bin/groqcc.js       CLI : start, claude, doctor, models, env
src/server.js       serveur HTTP, routes, auth, SSE, erreurs Anthropic
src/translate.js    Anthropic Messages ⇄ OpenAI Chat Completions
src/groq.js         client Groq : fetch, retries, fallback, timeouts
src/sse.js          parseur SSE + writer SSE Anthropic
src/models.js       mapping des modèles, limites de contexte/sortie
src/config.js       configuration et valeurs par défaut
src/env.js          lecture .env sans dépendance
src/errors.js       erreurs normalisées Anthropic
```

### Flux d'une requête

1. Claude Code envoie `POST /v1/messages` (souvent `stream: true`) avec `x-api-key` ou `Authorization: Bearer`.
2. Le proxy vérifie le jeton local éventuel, traduit la requête et appelle Groq.
3. Groq répond en SSE OpenAI (`choices[].delta`, `tool_calls`, `usage`).
4. Le proxy réémet des événements SSE Anthropic, avec les blocs `text` et `tool_use`.
5. Claude Code exécute les outils et renvoie les `tool_result` dans la requête suivante.

---

## Limites connues

- **Comptage de tokens approximatif** : `count_tokens` utilise une heuristique (~3,5 caractères/token), pas un tokenizer exact.
- **Pas de prompt caching** : les blocs `cache_control` sont ignorés.
- **Pas de blocs `thinking` en retour** : le budget de réflexion est traduit en `reasoning_effort` pour les modèles qui le supportent, mais Claude Code ne reçoit pas de blocs de raisonnement signés.
- **Outils serveur Anthropic ignorés** : `web_search`, `computer`, etc. ne sont pas exécutés par Groq. Les outils custom et MCP sont transmis.
- **Images** : envoyées en `image_url` ; seuls les modèles Groq vision les acceptent.
- **PDF / documents** : remplacés par un marqueur texte, pas extraits.
- **Qualité du tool use** : dépend du modèle Groq. `openai/gpt-oss-120b` est le choix par défaut.
- **Contexte et sortie** : `max_tokens` est borné par le modèle et par la place restante estimée dans le contexte.
- **Streaming des tool_calls** : les appels d'outils sont bufferisés puis émis en fin de message. Claude Code les reçoit correctement, mais pas token par token.

---

## Dépannage

### `401` / `Invalid API key`

- Vérifie `GROQ_API_KEY` dans `.env`.
- Si `PROXY_API_KEY` est défini, Claude Code doit envoyer ce jeton, pas la clé Groq.
- Teste : `npm run doctor -- --chat`.

### `404` / modèle inconnu

```bash
npm run models
```

Puis mets un ID présent dans la liste dans `GROQ_MODEL` / `GROQ_SMALL_MODEL`.

### `429` / rate limit

- Le plan Groq est trop limité pour Claude Code (surtout le free tier).
- Le proxy respecte `retry-after` et retente une fois.
- Réduis la taille du contexte, ou passe à un plan supérieur.

### `400` / outil ou schéma refusé

- Essaie `GROQ_MODEL=openai/gpt-oss-120b`.
- Un outil MCP avec un schéma JSON complexe peut être refusé par Groq.
- Lance avec `LOG_LEVEL=debug npm start` pour voir le modèle, le nombre d'outils et les erreurs.

### Claude Code continue d'appeler Anthropic

Vérifie :

```bash
env | grep ANTHROPIC
```

`ANTHROPIC_BASE_URL` doit pointer vers `http://127.0.0.1:<port>`. Le plus simple est `npm run claude`, qui injecte les variables lui-même.

### `claude` introuvable

```bash
npm install -g @anthropic-ai/claude-code
```

### Le stream se bloque

Essaie :

```bash
npm start -- --no-stream
```

ou dans `.env` :

```dotenv
STREAMING=0
```

Le proxy attend alors la réponse complète de Groq et fabrique les événements SSE Anthropic.

### Port déjà utilisé

```bash
npm start -- --port 8788
```

---

## Sécurité

- Par défaut, le proxy écoute uniquement sur `127.0.0.1`.
- Le fichier `.env` doit être en `chmod 600`.
- Les clés ne sont jamais journalisées ; les messages d'erreur sont expurgés (`gsk_***`).
- Un contrôle de l'en-tête `Host` limite les attaques de type DNS rebinding.
- `PROXY_API_KEY` ajoute une authentification locale.
- **Ne pas exposer le proxy sur Internet.** Si tu dois le faire (Docker, réseau local), mets un `PROXY_API_KEY` solide, un pare-feu, et idéalement un reverse proxy TLS.

---

## Développement

```bash
npm test                 # tests unitaires + e2e avec un faux Groq
bash scripts/verify.sh   # syntaxe + tests
```

Structure des tests :

- `test/translate.test.js` : traduction Anthropic ⇄ OpenAI, outils, images.
- `test/sse.test.js` : parseur SSE et writer Anthropic.
- `test/server.test.js` : serveur réel + faux upstream Groq (stream, tools, erreurs, auth).
- `test/config.test.js` : `.env`, configuration, secrets.
- `test/models.test.js` : mapping et limites.

Aucune dépendance npm : uniquement `node:test`, `node:http`, `fetch`.

---

## Licence

MIT. Voir [LICENSE](./LICENSE).

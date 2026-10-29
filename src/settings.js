import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_MODELS } from './models.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

const groqModels = Object.fromEntries(
  Object.entries(KNOWN_MODELS).map(([id, info]) => [
    id,
    {
      label: id,
      context: info.context,
      maxOutput: info.maxOutput,
      tools: Boolean(info.tools),
      reasoning: info.reasoning || [],
      tags: [
        info.tools ? 'tools' : 'no-tools',
        ...(info.reasoning?.length ? ['reasoning'] : []),
        ...(id.includes('coder') ? ['coding'] : []),
      ],
    },
  ]),
);

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  providers: {
    groq: {
      label: 'Groq',
      type: 'openai',
      enabled: true,
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKeyEnv: 'GROQ_API_KEY',
      maxTokensField: 'max_completion_tokens',
      streamUsage: true,
      reasoning: true,
      models: groqModels,
    },
    opencode: {
      label: 'OpenCode Zen',
      type: 'openai',
      enabled: true,
      baseUrl: 'https://opencode.ai/inference/openai/v1',
      modelsUrl: 'https://opencode.ai/inference/v1/models',
      apiKeyEnv: 'OPENCODE_API_KEY',
      apiKeyEnvAliases: ['OPENCODE_ZEN_API_KEY'],
      maxTokensField: 'max_tokens',
      streamUsage: true,
      reasoning: false,
      models: {
        'claude-sonnet-4-5': {
          label: 'Claude Sonnet 4.5',
          context: 200000,
          maxOutput: 64000,
          tools: true,
          reasoning: ['low', 'medium', 'high'],
          tags: ['coding', 'security', 'tools'],
        },
        'claude-opus-4-5': {
          label: 'Claude Opus 4.5',
          context: 200000,
          maxOutput: 64000,
          tools: true,
          reasoning: ['low', 'medium', 'high'],
          tags: ['reasoning', 'security', 'tools'],
        },
        'claude-haiku-4-5': {
          label: 'Claude Haiku 4.5',
          context: 200000,
          maxOutput: 32000,
          tools: true,
          tags: ['fast', 'tools'],
        },
        'gpt-5.4': {
          label: 'GPT 5.4',
          context: 272000,
          maxOutput: 128000,
          tools: true,
          reasoning: ['low', 'medium', 'high'],
          tags: ['reasoning', 'coding', 'tools'],
        },
        'gemini-3.1-pro': {
          label: 'Gemini 3.1 Pro',
          context: 1000000,
          maxOutput: 65536,
          tools: true,
          tags: ['reasoning', 'long-context', 'tools'],
        },
        'deepseek-v4.1-flash-free': {
          label: 'DeepSeek V4.1 Flash Free',
          context: 131072,
          maxOutput: 32768,
          tools: true,
          reasoning: ['low', 'medium'],
          tags: ['free', 'fast', 'tools'],
        },
        'kimi-k2.7-code': {
          label: 'Kimi K2.7 Code',
          context: 262144,
          maxOutput: 32768,
          tools: true,
          tags: ['coding', 'security', 'tools'],
        },
        'qwen3.8-max': {
          label: 'Qwen3.8 Max',
          context: 262144,
          maxOutput: 32768,
          tools: true,
          reasoning: ['low', 'medium', 'high'],
          tags: ['reasoning', 'tools'],
        },
        'glm-5.3': {
          label: 'GLM 5.3',
          context: 200000,
          maxOutput: 32768,
          tools: true,
          tags: ['coding', 'tools'],
        },
        'minimax-m3': {
          label: 'MiniMax M3',
          context: 200000,
          maxOutput: 32768,
          tools: true,
          tags: ['coding', 'tools'],
        },
        'grok-4.7': {
          label: 'Grok 4.7',
          context: 200000,
          maxOutput: 32768,
          tools: true,
          tags: ['reasoning', 'tools'],
        },
      },
    },
    nvidia: {
      label: 'NVIDIA NIM',
      type: 'openai',
      enabled: true,
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKeyEnv: 'NVIDIA_API_KEY',
      apiKeyEnvAliases: ['NVIDIA_NIM_API_KEY'],
      maxTokensField: 'max_tokens',
      streamUsage: false,
      reasoning: false,
      models: {
        'deepseek-ai/deepseek-r1': {
          label: 'DeepSeek R1',
          context: 131072,
          maxOutput: 32768,
          tools: false,
          reasoning: ['low', 'medium', 'high'],
          tags: ['reasoning', 'ctf', 'no-tools'],
        },
        'deepseek-ai/deepseek-v3.1': {
          label: 'DeepSeek V3.1',
          context: 131072,
          maxOutput: 32768,
          tools: true,
          tags: ['reasoning', 'coding', 'tools'],
        },
        'qwen/qwen3-coder-480b-a35b-instruct': {
          label: 'Qwen3 Coder 480B',
          context: 262144,
          maxOutput: 32768,
          tools: true,
          tags: ['coding', 'tools'],
        },
        'qwen/qwen2.5-coder-32b-instruct': {
          label: 'Qwen2.5 Coder 32B',
          context: 131072,
          maxOutput: 32768,
          tools: true,
          tags: ['coding', 'tools'],
        },
        'meta/llama-3.3-70b-instruct': {
          label: 'Llama 3.3 70B',
          context: 131072,
          maxOutput: 32768,
          tools: true,
          tags: ['general', 'tools'],
        },
        'nvidia/llama-3.3-nemotron-super-49b-v1.5': {
          label: 'Nemotron Super 49B',
          context: 131072,
          maxOutput: 32768,
          tools: true,
          tags: ['reasoning', 'tools'],
        },
      },
    },
    gemini: {
      label: 'Google Gemini',
      type: 'openai',
      enabled: true,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKeyEnv: 'GEMINI_API_KEY',
      apiKeyEnvAliases: ['GOOGLE_API_KEY'],
      maxTokensField: 'max_tokens',
      streamUsage: false,
      reasoning: false,
      models: {
        'gemini-2.5-pro': {
          label: 'Gemini 2.5 Pro',
          context: 1048576,
          maxOutput: 65536,
          tools: true,
          reasoning: ['low', 'medium', 'high'],
          tags: ['reasoning', 'long-context', 'tools'],
        },
        'gemini-2.5-flash': {
          label: 'Gemini 2.5 Flash',
          context: 1048576,
          maxOutput: 65536,
          tools: true,
          tags: ['fast', 'long-context', 'tools'],
        },
        'gemini-2.5-flash-lite': {
          label: 'Gemini 2.5 Flash Lite',
          context: 1048576,
          maxOutput: 65536,
          tools: true,
          tags: ['fast', 'long-context', 'tools'],
        },
      },
    },
  },
  routing: {
    activeProfile: 'auto',
    aliases: {
      default: 'auto',
      best: 'auto',
      sonnet: 'auto',
      opus: 'auto',
      haiku: 'fast',
      hunter: 'auto',
    },
    classifier: {
      enabled: true,
      minScore: 1,
    },
    fallback: {
      maxCandidates: 4,
      cooldownMs: 60000,
    },
    profiles: {
      auto: {
        label: 'Auto',
        description: 'Classification locale de la tâche puis meilleure chaîne disponible.',
        keywords: [],
        chain: [
          'opencode/claude-sonnet-4-5',
          'gemini/gemini-2.5-pro',
          'groq/openai/gpt-oss-120b',
          'nvidia/qwen/qwen3-coder-480b-a35b-instruct',
        ],
        suffix:
          'Tu es Hunter Bridge. Analyse la demande, choisis les outils adaptés, vérifie les hypothèses et reste concis. Pour toute cible offensive, rappelle le scope et privilégie une validation autorisée.',
      },
      general: {
        label: 'Général',
        description: 'Assistant technique polyvalent.',
        keywords: [],
        chain: ['groq/openai/gpt-oss-120b', 'gemini/gemini-2.5-flash', 'opencode/gpt-5.4'],
        suffix: 'Réponds de façon concise, précise et vérifiable.',
      },
      fast: {
        label: 'Rapide',
        description: 'Réponses courtes, faible latence, faible coût.',
        keywords: [],
        chain: [
          'groq/openai/gpt-oss-20b',
          'opencode/deepseek-v4.1-flash-free',
          'gemini/gemini-2.5-flash',
        ],
        suffix: 'Va droit au but. Pas de plan inutile.',
      },
      code: {
        label: 'Code',
        description: 'Développement, débogage, refactorisation, tests.',
        keywords: [
          'code',
          'bug',
          'refactor',
          'test',
          'typescript',
          'javascript',
          'python',
          'rust',
          'golang',
          'docker',
          'kubernetes',
          'sql',
          'git',
        ],
        chain: [
          'opencode/claude-sonnet-4-5',
          'gemini/gemini-2.5-pro',
          'groq/openai/gpt-oss-120b',
          'nvidia/qwen/qwen3-coder-480b-a35b-instruct',
        ],
        suffix:
          'Travaille comme un ingénieur senior : lis le code avant de modifier, minimise le diff, lance les tests et explique les risques.',
      },
      bugbounty: {
        label: 'Bug Bounty',
        description: 'Recon, analyse de scope, chasse de vulnérabilités web/API.',
        keywords: [
          'bug bounty',
          'bugbounty',
          'hackerone',
          'bugcrowd',
          'intigriti',
          'yeswehack',
          'scope',
          'in scope',
          'out of scope',
          'recon',
          'subdomain',
          'enumeration',
          'xss',
          'ssrf',
          'idor',
          'csrf',
          'rce',
          'open redirect',
          'api security',
          'pentest',
          'cve-',
        ],
        chain: [
          'opencode/claude-sonnet-4-5',
          'gemini/gemini-2.5-pro',
          'groq/openai/gpt-oss-120b',
          'nvidia/qwen/qwen3-coder-480b-a35b-instruct',
        ],
        suffix:
          'Méthode bug bounty : vérifie le scope et les règles avant toute action, privilégie le recon passif, formule des hypothèses testables, collecte des preuves minimales, évite les actions destructrices et ne teste que les cibles autorisées.',
      },
      ctf: {
        label: 'CTF',
        description: 'Challenge difficile, raisonnement multi-étapes et exploitation.',
        keywords: [
          'ctf',
          'capture the flag',
          'flag{',
          'pwn',
          'exploit',
          'shellcode',
          'rop',
          'heap',
          'format string',
          'buffer overflow',
          'reverse engineering',
          'decompile',
          'ghidra',
          'ida',
          'radare',
          'crypto',
          'rsa',
          'aes',
          'ecc',
          'lattice',
          'forensics',
          'stego',
          'pcap',
          'jail',
          'sandbox escape',
          'vm escape',
          'web3',
          'smart contract',
        ],
        chain: [
          'opencode/claude-opus-4-5',
          'gemini/gemini-2.5-pro',
          'groq/openai/gpt-oss-120b',
          'nvidia/deepseek-ai/deepseek-v3.1',
        ],
        suffix:
          'Méthode CTF : identifie la catégorie, énumère les indices, propose plusieurs hypothèses, garde une trace des commandes et vérifie le flag. Pour les challenges difficiles, décompose en sous-problèmes et utilise les outils de façon itérative.',
      },
      recon: {
        label: 'Recon',
        description: 'OSINT, DNS, sous-domaines, surfaces d’attaque.',
        keywords: [
          'recon',
          'subdomain',
          'dns',
          'port scan',
          'nmap',
          'amass',
          'httpx',
          'wayback',
          'osint',
          'shodan',
          'censys',
          'ffuf',
          'gobuster',
        ],
        chain: [
          'groq/openai/gpt-oss-20b',
          'gemini/gemini-2.5-flash',
          'opencode/claude-haiku-4-5',
        ],
        suffix:
          'Méthode recon : reste passif d’abord, note les sources, déduplique les résultats et respecte le scope.',
      },
      web: {
        label: 'Web / API',
        description: 'Vulnérabilités web, API, authentification, logique métier.',
        keywords: [
          'xss',
          'ssrf',
          'sqli',
          'sql injection',
          'idor',
          'csrf',
          'graphql',
          'jwt',
          'oauth',
          'deserialization',
          'ssti',
          'lfi',
          'rfi',
          'path traversal',
          'open redirect',
          'cors',
          'request smuggling',
        ],
        chain: [
          'opencode/claude-sonnet-4-5',
          'gemini/gemini-2.5-pro',
          'groq/openai/gpt-oss-120b',
        ],
        suffix:
          'Méthode web/API : cartographie les endpoints, teste les contrôles d’accès, les entrées et la logique métier, puis fournis des requêtes reproductibles et des preuves.',
      },
      pwn: {
        label: 'Pwn',
        description: 'Exploitation binaire, mémoire, ROP, heap.',
        keywords: [
          'pwn',
          'binary exploitation',
          'shellcode',
          'rop',
          'ret2libc',
          'heap',
          'use after free',
          'buffer overflow',
          'format string',
          'canary',
          'aslr',
          'pwntools',
        ],
        chain: [
          'opencode/claude-sonnet-4-5',
          'gemini/gemini-2.5-pro',
          'groq/openai/gpt-oss-120b',
          'nvidia/deepseek-ai/deepseek-v3.1',
        ],
        suffix:
          'Méthode pwn : protège les artefacts, identifie les mitigations, écris un script pwntools reproductible et explique chaque primitive.',
      },
      rev: {
        label: 'Reverse',
        description: 'Analyse binaire, firmware, APK, obfuscation.',
        keywords: [
          'reverse',
          'decompile',
          'ghidra',
          'ida',
          'radare',
          'objdump',
          'disassembly',
          'firmware',
          'apk',
          'dotnet',
          'wasm',
          'packer',
          'anti-debug',
        ],
        chain: [
          'opencode/claude-sonnet-4-5',
          'gemini/gemini-2.5-pro',
          'groq/openai/gpt-oss-120b',
          'nvidia/deepseek-ai/deepseek-r1',
        ],
        suffix:
          'Méthode reverse : commence par les métadonnées, les chaînes et les points d’entrée, puis reconstruis la logique par blocs et valide chaque hypothèse.',
      },
      crypto: {
        label: 'Crypto',
        description: 'Cryptanalyse, RSA, courbes elliptiques, PRNG.',
        keywords: [
          'crypto',
          'cryptography',
          'rsa',
          'aes',
          'ecc',
          'elliptic',
          'lattice',
          'lll',
          'discrete log',
          'diffie',
          'padding oracle',
          'hash length extension',
          'prng',
          'nonce reuse',
        ],
        chain: [
          'opencode/claude-sonnet-4-5',
          'gemini/gemini-2.5-pro',
          'groq/openai/gpt-oss-120b',
          'nvidia/deepseek-ai/deepseek-r1',
        ],
        suffix:
          'Méthode crypto : formalise les inconnues, vérifie les paramètres, construis un script de résolution et valide le résultat sur les données fournies.',
      },
      forensics: {
        label: 'Forensics',
        description: 'PCAP, mémoire, disque, stéganographie, malware.',
        keywords: [
          'forensics',
          'pcap',
          'wireshark',
          'memory dump',
          'volatility',
          'stego',
          'steganography',
          'disk image',
          'registry',
          'evtx',
          'malware',
          'yara',
          'sigma',
        ],
        chain: [
          'gemini/gemini-2.5-pro',
          'opencode/claude-sonnet-4-5',
          'groq/openai/gpt-oss-120b',
        ],
        suffix:
          'Méthode forensics : préserve les preuves, documente la chaîne de custody, corrèle les artefacts et distingue faits et hypothèses.',
      },
    },
  },
  mcp: {
    servers: [],
  },
  plugins: {
    paths: [],
  },
  ui: {
    title: 'Hunter Bridge',
    accent: '#38bdf8',
  },
});

export function defaultSettings() {
  return clone(DEFAULT_SETTINGS);
}

export function loadSettings(file) {
  if (!file || !fs.existsSync(file)) return defaultSettings();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Configuration Hunter invalide (${file}) : ${error.message}`);
  }
  return normalizeSettings(deepMerge(defaultSettings(), parsed));
}

export function saveSettings(file, settings) {
  if (!file) throw new Error('Chemin de configuration Hunter manquant');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

export function ensureSettings(file) {
  if (!file) return defaultSettings();
  if (!fs.existsSync(file)) {
    const settings = defaultSettings();
    saveSettings(file, settings);
    return settings;
  }
  return loadSettings(file);
}

export function normalizeSettings(settings) {
  const next = settings && typeof settings === 'object' ? settings : defaultSettings();
  next.providers = next.providers && typeof next.providers === 'object' ? next.providers : {};
  next.routing = next.routing && typeof next.routing === 'object' ? next.routing : {};
  next.routing.activeProfile = String(next.routing.activeProfile || 'auto');
  next.routing.aliases =
    next.routing.aliases && typeof next.routing.aliases === 'object' ? next.routing.aliases : {};
  next.routing.classifier =
    next.routing.classifier && typeof next.routing.classifier === 'object'
      ? next.routing.classifier
      : { enabled: true, minScore: 1 };
  next.routing.fallback =
    next.routing.fallback && typeof next.routing.fallback === 'object'
      ? next.routing.fallback
      : { maxCandidates: 4, cooldownMs: 60000 };
  next.routing.profiles =
    next.routing.profiles && typeof next.routing.profiles === 'object'
      ? next.routing.profiles
      : defaultSettings().routing.profiles;
  if (!next.routing.profiles[next.routing.activeProfile]) next.routing.activeProfile = 'auto';
  next.mcp = next.mcp && typeof next.mcp === 'object' ? next.mcp : { servers: [] };
  if (!Array.isArray(next.mcp.servers)) next.mcp.servers = [];
  next.plugins = next.plugins && typeof next.plugins === 'object' ? next.plugins : { paths: [] };
  if (!Array.isArray(next.plugins.paths)) next.plugins.paths = [];
  next.ui = next.ui && typeof next.ui === 'object' ? next.ui : { title: 'Hunter Bridge' };
  for (const [id, provider] of Object.entries(next.providers)) {
    if (!provider || typeof provider !== 'object') {
      delete next.providers[id];
      continue;
    }
    provider.label = String(provider.label || id);
    provider.type = 'openai';
    provider.enabled = provider.enabled !== false;
    provider.baseUrl = String(provider.baseUrl || '').replace(/\/+$/, '');
    provider.apiKeyEnv = String(provider.apiKeyEnv || '').trim();
    provider.models =
      provider.models && typeof provider.models === 'object' ? provider.models : {};
  }
  return next;
}

export function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? clone(base) : clone(override);
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? clone(base) : clone(override);
  }
  const out = clone(base);
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in out ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

import crypto from 'node:crypto';

/** Identifiant Anthropic-like : msg_ + 32 hex. */
export function newId(prefix = 'msg_') {
  return prefix + crypto.randomUUID().replace(/-/g, '');
}

/** Identifiant d'outil Anthropic-like : toolu_ + 32 hex. */
export function newToolId() {
  return newId('toolu_');
}

/**
 * Estimation volontairement conservatrice (~3,5 caractères/token).
 * Sert uniquement au comptage approximatif et à l'ajustement de max_tokens.
 */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : safeStringify(value);
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3.5));
}

/**
 * Estime les tokens d'entrée d'une requête Anthropic.
 * Les images base64 sont remplacées par un marqueur : leur poids en
 * caractères n'a rien à voir avec leur coût réel en tokens.
 */
export function estimateRequestTokens(body) {
  if (!body || typeof body !== 'object') return 0;
  let chars = 0;
  if (body.system) chars += tokenizableJson(body.system).length;
  if (Array.isArray(body.messages)) chars += tokenizableJson(body.messages).length;
  if (Array.isArray(body.tools)) chars += tokenizableJson(body.tools).length;
  const overhead = 8 * (1 + (body.messages?.length || 0) + (body.tools?.length || 0));
  return Math.max(1, Math.ceil(chars / 3.5) + overhead);
}

function tokenizableJson(value) {
  try {
    return JSON.stringify(value, (key, val) => {
      if (key === 'data' && typeof val === 'string' && val.length > 512) return '[image]';
      if (key === 'source' && val && typeof val === 'object' && val.type === 'base64') return '[image]';
      return val;
    }) || '';
  } catch {
    return '';
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) || '';
  } catch {
    return String(value ?? '');
  }
}

/** Masque une clé sans jamais révéler sa valeur complète. */
export function maskKey(key) {
  const value = String(key || '');
  if (!value) return '(absente)';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} car.)`;
}

/** Retire les secrets connus des messages d'erreur / logs. */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/gsk_[A-Za-z0-9_-]{8,}/g, 'gsk_***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}/gi, 'Bearer ***');
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalise l'URL de base Groq.
 * - https://api.groq.com            -> https://api.groq.com/openai/v1
 * - .../openai/v1/                   -> .../openai/v1
 * - .../openai/v1/chat/completions   -> .../openai/v1
 */
export function normalizeGroqBaseUrl(raw) {
  let url = String(raw || '').trim().replace(/\/+$/, '');
  if (!url) return 'https://api.groq.com/openai/v1';
  if (url.endsWith('/chat/completions')) {
    url = url.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  }
  if (url === 'https://api.groq.com' || url === 'http://api.groq.com') {
    url += '/openai/v1';
  }
  return url;
}

/** Extrait le nom d'hôte d'un en-tête Host (gère l'IPv6 entre crochets). */
export function hostnameOf(hostHeader) {
  const value = String(hostHeader || '').trim();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : value;
  }
  return value.split(':')[0];
}

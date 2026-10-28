import { normalizeGroqBaseUrl } from './util.js';

export const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 8787,
  groqBaseUrl: 'https://api.groq.com/openai/v1',
  model: 'openai/gpt-oss-120b',
  smallModel: 'openai/gpt-oss-20b',
  maxOutputTokens: 32768,
  requestTimeoutMs: 300000,
  streamTimeoutMs: 900000,
  bodyLimitBytes: 25 * 1024 * 1024,
  retries: 1,
  logLevel: 'info',
  streaming: true,
  claudeModel: 'claude-sonnet-4-5',
  claudeSmallModel: 'claude-3-5-haiku-latest',
});

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export function buildConfig(env = process.env, overrides = {}) {
  const host = String(overrides.host ?? env.HOST ?? DEFAULTS.host).trim() || DEFAULTS.host;
  const port = intValue(overrides.port ?? env.PORT, DEFAULTS.port, 0, 65535, 'PORT');
  const model = String(overrides.model ?? env.GROQ_MODEL ?? DEFAULTS.model).trim() || DEFAULTS.model;
  const smallModel = String(
    overrides.smallModel ?? env.GROQ_SMALL_MODEL ?? env.GROQ_MODEL_SMALL ?? DEFAULTS.smallModel,
  ).trim() || model;
  const maxOutputTokens = intValue(
    overrides.maxOutputTokens ?? env.MAX_OUTPUT_TOKENS,
    DEFAULTS.maxOutputTokens,
    1,
    1_000_000,
    'MAX_OUTPUT_TOKENS',
  );
  const requestTimeoutMs = intValue(
    overrides.requestTimeoutMs ?? env.REQUEST_TIMEOUT_MS,
    DEFAULTS.requestTimeoutMs,
    1000,
    3_600_000,
    'REQUEST_TIMEOUT_MS',
  );
  const streamTimeoutMs = intValue(
    overrides.streamTimeoutMs ?? env.STREAM_TIMEOUT_MS,
    DEFAULTS.streamTimeoutMs,
    1000,
    3_600_000,
    'STREAM_TIMEOUT_MS',
  );
  const bodyLimitBytes = intValue(
    overrides.bodyLimitBytes ?? env.BODY_LIMIT_BYTES,
    DEFAULTS.bodyLimitBytes,
    1024,
    200 * 1024 * 1024,
    'BODY_LIMIT_BYTES',
  );
  const retries = intValue(
    overrides.retries ?? env.GROQ_RETRIES,
    DEFAULTS.retries,
    0,
    5,
    'GROQ_RETRIES',
  );
  const rawLogLevel = String(overrides.logLevel ?? env.LOG_LEVEL ?? DEFAULTS.logLevel).trim().toLowerCase();
  const logLevel = LOG_LEVELS.has(rawLogLevel) ? rawLogLevel : DEFAULTS.logLevel;
  const streaming = boolValue(overrides.streaming ?? env.STREAMING, DEFAULTS.streaming);

  const apiKey = normalizeApiKey(overrides.apiKey ?? env.GROQ_API_KEY);
  const proxyApiKey = String(overrides.proxyApiKey ?? env.PROXY_API_KEY ?? '').trim();
  const groqBaseUrl = normalizeGroqBaseUrl(overrides.groqBaseUrl ?? env.GROQ_BASE_URL ?? DEFAULTS.groqBaseUrl);

  const allowedHosts = parseAllowedHosts(env.ALLOWED_HOSTS, host);

  return {
    host,
    port,
    groqBaseUrl,
    apiKey,
    proxyApiKey,
    model,
    smallModel,
    maxOutputTokens,
    requestTimeoutMs,
    streamTimeoutMs,
    bodyLimitBytes,
    retries,
    logLevel,
    streaming,
    allowedHosts,
    claudeModel: String(
      overrides.claudeModel ?? env.CLAUDE_MODEL ?? env.ANTHROPIC_MODEL ?? DEFAULTS.claudeModel,
    ).trim() || DEFAULTS.claudeModel,
    claudeSmallModel: String(
      overrides.claudeSmallModel ??
        env.CLAUDE_SMALL_MODEL ??
        env.ANTHROPIC_SMALL_FAST_MODEL ??
        DEFAULTS.claudeSmallModel,
    ).trim() || DEFAULTS.claudeSmallModel,
  };
}

/** Vue publique : jamais de clé API, jamais de jeton proxy. */
export function publicConfig(config) {
  return {
    service: 'groq-claude-bridge',
    upstream: config.groqBaseUrl,
    models: {
      big: config.model,
      small: config.smallModel,
    },
    streaming: config.streaming,
    keyConfigured: Boolean(config.apiKey),
    proxyAuth: Boolean(config.proxyApiKey),
  };
}

export function parseAllowedHosts(raw, host) {
  const explicit = String(raw || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (explicit.length) return explicit;
  if (host === '0.0.0.0' || host === '::' || host === '') return [];
  const defaults = ['127.0.0.1', 'localhost', '::1'];
  if (!defaults.includes(host.toLowerCase())) defaults.push(host.toLowerCase());
  return defaults;
}

function normalizeApiKey(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  // Évite de faire croire à une clé configurée quand .env.example n'a pas
  // été édité (gsk_...) ou quand la valeur est un placeholder <...>.
  if (value === 'gsk_...' || value.endsWith('...') || /^<.*>$/.test(value)) return '';
  return value;
}

function intValue(raw, fallback, min, max, name) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} doit être un entier (reçu: ${raw})`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} doit être entre ${min} et ${max} (reçu: ${value})`);
  }
  return value;
}

function boolValue(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'oui'].includes(value)) return true;
  if (['0', 'false', 'no', 'off', 'non'].includes(value)) return false;
  return fallback;
}

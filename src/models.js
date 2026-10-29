/**
 * Catalogue local des modèles Groq utiles à Claude Code.
 * Les limites sont celles publiées par Groq (console.groq.com/docs/models).
 * Elles servent à borner max_tokens et à éviter des 400 inutiles.
 */
export const KNOWN_MODELS = Object.freeze({
  'openai/gpt-oss-120b': {
    context: 131072,
    maxOutput: 65536,
    tools: true,
    parallelTools: false,
    reasoning: ['low', 'medium', 'high'],
  },
  'openai/gpt-oss-20b': {
    context: 131072,
    maxOutput: 65536,
    tools: true,
    parallelTools: false,
    reasoning: ['low', 'medium', 'high'],
  },
  'openai/gpt-oss-safeguard-20b': {
    context: 131072,
    maxOutput: 65536,
    tools: true,
    parallelTools: false,
    reasoning: ['low', 'medium', 'high'],
  },
  'llama-3.3-70b-versatile': {
    context: 131072,
    maxOutput: 32768,
    tools: true,
    parallelTools: false,
  },
  'llama-3.1-8b-instant': {
    context: 131072,
    maxOutput: 32768,
    tools: true,
    parallelTools: false,
  },
  'qwen/qwen3-32b': {
    context: 131072,
    maxOutput: 40960,
    tools: true,
    parallelTools: true,
    reasoning: ['none', 'default'],
  },
  'qwen/qwen3.6-27b': {
    context: 131072,
    maxOutput: 16384,
    tools: true,
    parallelTools: true,
    reasoning: ['none', 'low', 'medium', 'high'],
  },
  'qwen/qwen3.8-27b': {
    context: 131072,
    maxOutput: 16384,
    tools: true,
    parallelTools: true,
    reasoning: ['none', 'low', 'medium', 'high'],
  },
  'minimaxai/minimax-m2.7': {
    context: 131072,
    maxOutput: 16384,
    tools: true,
    parallelTools: true,
  },
  'meta-models/muse-spark-open': {
    context: 131072,
    maxOutput: 16384,
    tools: true,
    parallelTools: true,
  },
  'moonshotai/kimi-k2-instruct-0905': {
    context: 262144,
    maxOutput: 16384,
    tools: true,
    parallelTools: true,
  },
  'moonshotai/kimi-k2-instruct': {
    context: 131072,
    maxOutput: 16384,
    tools: true,
    parallelTools: true,
  },
});

/**
 * Traduit un nom de modèle Anthropic/Claude Code vers un modèle Groq.
 * - un ID Groq explicite (avec "/") est respecté ;
 * - "haiku" -> petit modèle ;
 * - "sonnet"/"opus"/"claude" -> modèle principal ;
 * - tout le reste -> modèle principal.
 */
export function resolveModel(requested, config) {
  const raw = String(requested || '').trim();
  if (!raw) return config.model;
  const withoutPrefix = raw.startsWith('groq/') ? raw.slice('groq/'.length) : raw;
  if (KNOWN_MODELS[withoutPrefix] || withoutPrefix === config.model || withoutPrefix === config.smallModel) {
    return withoutPrefix;
  }
  if (withoutPrefix.includes('/')) return withoutPrefix;

  const lower = withoutPrefix.toLowerCase();
  if (lower.includes('haiku')) return config.smallModel;
  if (lower.includes('sonnet') || lower.includes('opus') || lower.includes('claude')) {
    return config.model;
  }
  return config.model;
}

export function contextFor(model) {
  return KNOWN_MODELS[model]?.context || 131072;
}

export function maxOutputFor(model, config) {
  const known = KNOWN_MODELS[model]?.maxOutput;
  return Math.min(config.maxOutputTokens, known || config.maxOutputTokens);
}

/**
 * Borne max_tokens :
 * - jamais au-dessus de la limite du modèle ni du plafond configuré ;
 * - jamais au-dessus de la place restante dans le contexte (approximation).
 */
export function clampMaxTokens(requested, model, config, estimatedInputTokens = 0, modelMeta = null) {
  const hardLimit = Math.min(
    config.maxOutputTokens,
    Number(modelMeta?.maxOutput) || maxOutputFor(model, config),
  );
  const contextLimit = Number(modelMeta?.context) || contextFor(model);
  const available = Math.max(256, contextLimit - Math.max(0, estimatedInputTokens) - 1024);
  const limit = Math.min(hardLimit, available);
  const value = Number.parseInt(String(requested ?? ''), 10);
  if (!Number.isFinite(value) || value <= 0) return Math.min(8192, limit);
  return Math.max(1, Math.min(value, limit));
}

export function modelInfo(model) {
  return KNOWN_MODELS[model] || null;
}

export function isKnownToolModel(model) {
  return Boolean(KNOWN_MODELS[model]?.tools);
}

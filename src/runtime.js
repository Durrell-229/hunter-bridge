import { EventEmitter } from 'node:events';
import { BridgeError } from './errors.js';
import { loadEnvFile, updateEnvValue } from './env.js';
import { listUpstreamModels } from './upstream.js';
import { decideRoute, describeMissingProviders, modelTarget, providerList } from './router.js';
import {
  DEFAULT_SETTINGS,
  deepMerge,
  defaultSettings,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from './settings.js';
import {
  normalizePluginPaths,
  removeMcpServer,
  scanPlugins,
  redactMcpServers,
  upsertMcpServer,
} from './mcp.js';
import { estimateRequestTokens, maskKey, newId } from './util.js';
import { VERSION } from './version.js';

const DEFAULT_CONTEXT = 131072;
const DEFAULT_MAX_OUTPUT = 32768;

export function createRuntime(config, options = {}) {
  const env = options.env || process.env;
  const settingsPath = options.settingsPath || null;
  const envPath = options.envPath || null;
  const legacy = !options.settings && !settingsPath;
  let settings;
  if (options.settings) {
    settings = normalizeSettings(deepMerge(defaultSettings(), options.settings));
  } else if (settingsPath) {
    settings = loadSettings(settingsPath);
  } else {
    settings = legacySettings(config);
  }

  const runtime = {
    config,
    env,
    settings,
    settingsPath,
    envPath,
    legacy,
    providers: new Map(),
    providerStats: new Map(),
    totals: {
      requests: 0,
      completed: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      fallbacks: 0,
      active: 0,
      startedAt: Date.now(),
    },
    recent: [],
    lastDecision: null,
    events: new EventEmitter(),
    closed: false,
    logger: options.logger || null,
  };
  runtime.events.setMaxListeners(100);
  refreshProviders(runtime);
  runtime.scheduleUpdate = scheduleUpdate(runtime);
  return runtime;
}

function legacySettings(config) {
  const settings = defaultSettings();
  const model = String(config.model || 'openai/gpt-oss-120b');
  const small = String(config.smallModel || model);
  const groq = settings.providers.groq;
  groq.baseUrl = config.groqBaseUrl || groq.baseUrl;
  const baseModel = groq.models[model] || {
    label: model,
    context: DEFAULT_CONTEXT,
    maxOutput: DEFAULT_MAX_OUTPUT,
    tools: true,
    reasoning: [],
    tags: [],
  };
  const smallModel = groq.models[small] || {
    ...baseModel,
    label: small,
    maxOutput: Math.min(baseModel.maxOutput, 32768),
  };
  groq.models = { [model]: baseModel, [small]: smallModel };
  settings.providers = { groq };
  for (const profile of Object.values(settings.routing.profiles)) {
    profile.chain = [modelTarget('groq', model), modelTarget('groq', small)];
  }
  settings.routing.activeProfile = 'auto';
  return settings;
}

function providerApiKey(provider, env, config, legacy) {
  const names = [provider.apiKeyEnv, ...(provider.apiKeyEnvAliases || [])].filter(Boolean);
  for (const name of names) {
    const value = normalizeSecret(env[name]);
    if (value) return value;
  }
  if (legacy) return normalizeSecret(config.apiKey);
  if (provider.id === 'groq') return normalizeSecret(config.apiKey);
  return '';
}

function normalizeSecret(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value === 'gsk_...' || value.endsWith('...') || /^<.*>$/.test(value)) return '';
  return value;
}

function buildModels(providerSettings, providerId, config) {
  const models = new Map();
  for (const [id, info] of Object.entries(providerSettings.models || {})) {
    const model = {
      id,
      label: String(info.label || id),
      context: Math.max(2048, Number(info.context) || DEFAULT_CONTEXT),
      maxOutput: Math.max(256, Number(info.maxOutput) || DEFAULT_MAX_OUTPUT),
      tools: info.tools !== false,
      reasoning: Array.isArray(info.reasoning) ? info.reasoning : [],
      tags: Array.isArray(info.tags) ? info.tags : [],
      discovered: Boolean(info.discovered),
    };
    models.set(id, model);
  }
  return models;
}

export function refreshProviders(runtime) {
  const previous = runtime.providers;
  const providers = new Map();
  for (const [id, providerSettings] of Object.entries(runtime.settings.providers || {})) {
    if (!providerSettings || providerSettings.enabled === false) {
      // On garde quand même l'entrée pour que le dashboard puisse l'activer.
    }
    const old = previous.get(id);
    const apiKey = providerApiKey(
      { ...providerSettings, id },
      runtime.env,
      runtime.config,
      runtime.legacy,
    );
    let baseUrl = String(providerSettings.baseUrl || '').replace(/\/+$/, '');
    if (runtime.env.GROQ_BASE_URL && id === 'groq') {
      baseUrl = String(runtime.env.GROQ_BASE_URL).replace(/\/+$/, '');
    } else if (runtime.legacy && id === 'groq' && runtime.config.groqBaseUrl) {
      baseUrl = runtime.config.groqBaseUrl;
    }
    const models = buildModels(providerSettings, id, runtime.config);
    const provider = {
      id,
      label: String(providerSettings.label || id),
      type: 'openai',
      enabled: providerSettings.enabled !== false,
      baseUrl,
      modelsUrl: String(providerSettings.modelsUrl || '').replace(/\/+$/, ''),
      apiKey,
      apiKeyEnv: providerSettings.apiKeyEnv || '',
      apiKeyEnvAliases: providerSettings.apiKeyEnvAliases || [],
      headers: providerSettings.headers || {},
      maxTokensField: providerSettings.maxTokensField || 'max_completion_tokens',
      streamUsage: providerSettings.streamUsage !== false,
      reasoning: providerSettings.reasoning !== false,
      tools: providerSettings.tools !== false,
      maxInputTokens: Number(providerSettings.maxInputTokens) || 0,
      models,
      retries: Number.isInteger(providerSettings.retries)
        ? providerSettings.retries
        : Number(runtime.config.retries ?? 1),
      requestTimeoutMs: Number(providerSettings.requestTimeoutMs || runtime.config.requestTimeoutMs),
      streamTimeoutMs: Number(providerSettings.streamTimeoutMs || runtime.config.streamTimeoutMs),
      cooldownUntil: old?.cooldownUntil || 0,
      lastStatus: old?.lastStatus || 'unknown',
      lastError: old?.lastError || '',
      lastChecked: old?.lastChecked || null,
      latencyMs: old?.latencyMs || null,
      stats: runtime.providerStats.get(id) || {
        attempts: 0,
        successes: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyTotal: 0,
        latencyCount: 0,
        lastUsed: null,
      },
    };
    runtime.providerStats.set(id, provider.stats);
    providers.set(id, provider);
  }
  runtime.providers = providers;
  runtime.lastRefresh = Date.now();
  return providers;
}

function scheduleUpdate(runtime) {
  let timer = null;
  return () => {
    if (runtime.closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (runtime.closed) return;
      runtime.events.emit('update', snapshot(runtime));
    }, 250);
    timer.unref?.();
  };
}

export function snapshot(runtime) {
  const providers = providerList(runtime.providers).map((provider) => ({
    id: provider.id,
    label: provider.label,
    type: provider.type,
    enabled: provider.enabled,
    baseUrl: provider.baseUrl,
    modelsUrl: provider.modelsUrl,
    apiKeyEnv: provider.apiKeyEnv,
    apiKeyEnvAliases: provider.apiKeyEnvAliases,
    keyConfigured: Boolean(provider.apiKey),
    keyHint: provider.apiKey ? maskKey(provider.apiKey) : '',
    maxTokensField: provider.maxTokensField,
    streamUsage: provider.streamUsage,
    reasoning: provider.reasoning,
    tools: provider.tools,
    status: {
      state: !provider.enabled
        ? 'disabled'
        : provider.cooldownUntil > Date.now()
          ? 'cooldown'
          : provider.lastStatus,
      lastError: provider.lastError,
      lastChecked: provider.lastChecked,
      latencyMs: provider.latencyMs,
      cooldownUntil: provider.cooldownUntil > Date.now() ? provider.cooldownUntil : null,
    },
    stats: { ...provider.stats },
    models: [...provider.models.values()].sort((a, b) => a.id.localeCompare(b.id)),
  }));
  const plugins = scanPlugins(runtime.settings.plugins?.paths || []);
  return {
    service: 'Hunter Bridge',
    version: runtimeVersion(),
    startedAt: runtime.totals.startedAt,
    uptimeSeconds: Math.round((Date.now() - runtime.totals.startedAt) / 1000),
    activeProfile: runtime.settings.routing.activeProfile,
    profileInfo:
      runtime.settings.routing.profiles?.[runtime.settings.routing.activeProfile] || null,
    providers,
    routing: runtime.settings.routing,
    mcp: { servers: redactMcpServers(runtime.settings.mcp?.servers || []) },
    plugins: {
      paths: runtime.settings.plugins?.paths || [],
      scanned: plugins,
    },
    metrics: {
      ...runtime.totals,
      uptimeSeconds: Math.round((Date.now() - runtime.totals.startedAt) / 1000),
    },
    recent: runtime.recent.slice(-60).reverse(),
    lastDecision: runtime.lastDecision,
    paths: {
      config: runtime.settingsPath,
      env: runtime.envPath,
      mcpConfig: runtime.mcpConfigPath || null,
    },
    adminAuthRequired: Boolean(runtime.config.adminToken),
  };
}

function runtimeVersion() {
  return VERSION;
}

export function decide(runtime, body, options = {}) {
  const decision = decideRoute(body, runtime.providers, runtime.settings, {
    profile: options.profile,
  });
  runtime.lastDecision = {
    at: Date.now(),
    profile: decision.profileId,
    activeProfile: decision.activeProfile,
    reason: decision.reason,
    matches: decision.matches,
    requestedModel: decision.requestedModel,
    candidates: decision.candidates.map((candidate) => candidate.target),
    skipped: decision.skipped.slice(0, 12),
    inputTokens: decision.inputTokens,
  };
  runtime.scheduleUpdate?.();
  return decision;
}

export function routeError(runtime, decision) {
  const now = Date.now();
  const cooling = providerList(runtime.providers)
    .filter((provider) => provider.enabled && provider.apiKey && provider.cooldownUntil > now)
    .sort((a, b) => a.cooldownUntil - b.cooldownUntil);
  const cooldownWasTheBlocker = (decision.skipped || []).some((entry) =>
    entry.includes('cooldown'),
  );
  if (cooling.length && cooldownWasTheBlocker) {
    const retryAfter = Math.max(1, Math.ceil((cooling[0].cooldownUntil - now) / 1000));
    return new BridgeError(
      `Tous les fournisseurs disponibles sont temporairement limités (TPM/rate limit). Réessaie dans ${retryAfter} s ou ajoute une clé OpenCode Zen, NVIDIA NIM ou Gemini dans .env.`,
      { status: 429, type: 'rate_limit_error', retryAfter },
    );
  }

  const missing = describeMissingProviders(runtime.providers);
  const hints = missing.length
    ? ` Clés manquantes : ${missing.join(', ')}.`
    : '';
  const skipped = decision.skipped?.length
    ? ` Candidats écartés : ${decision.skipped.slice(0, 4).join(' ; ')}.`
    : '';
  return new BridgeError(
    `Aucun modèle disponible pour le profil « ${decision.profileId} ».${hints}${skipped} Vérifie .env et le dashboard Hunter.`,
    { status: 500, type: 'configuration_error' },
  );
}

export function beginRequest(runtime, { body, decision, requestId }) {
  const id = requestId || newId('req_');
  const record = {
    id,
    startedAt: Date.now(),
    profile: decision.profileId,
    activeProfile: decision.activeProfile,
    requestedModel: decision.requestedModel,
    inputTokens: decision.inputTokens,
    status: 'pending',
    providerId: null,
    modelId: null,
    outputTokens: 0,
    latencyMs: null,
    attempts: [],
    error: '',
  };
  runtime.totals.requests += 1;
  runtime.totals.active += 1;
  runtime.recent.push(record);
  if (runtime.recent.length > 120) runtime.recent.splice(0, runtime.recent.length - 120);
  runtime.scheduleUpdate?.();
  return record;
}

export function noteAttempt(runtime, record, candidate) {
  if (!record || !candidate) return;
  record.attempts.push({
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    at: Date.now(),
  });
  if (record.attempts.length > 1) runtime.totals.fallbacks += 1;
  const provider = runtime.providers.get(candidate.providerId);
  if (provider) {
    provider.stats.attempts += 1;
    provider.stats.lastUsed = Date.now();
  }
  runtime.scheduleUpdate?.();
}

export function noteFailure(runtime, candidate, error) {
  if (!candidate?.provider) return;
  const provider = candidate.provider;
  provider.stats.errors += 1;
  provider.lastStatus = 'error';
  provider.lastError = String(error?.message || error || 'erreur upstream').slice(0, 500);
  provider.lastChecked = Date.now();
  const status = Number(error?.status || error?.upstreamStatus || 500);
  if (status === 429 || status === 408 || status >= 500) {
    const cooldown = Math.max(
      Number(runtime.settings.routing.fallback?.cooldownMs || 60000),
      Number(error?.retryAfter || 0) * 1000,
    );
    provider.cooldownUntil = Date.now() + Math.min(cooldown, 10 * 60 * 1000);
  }
  runtime.scheduleUpdate?.();
}

export function finishRequest(runtime, record, result = {}) {
  if (!record || record.finished) return;
  record.finished = true;
  record.latencyMs = Date.now() - record.startedAt;
  record.status = result.ok ? 'ok' : 'error';
  record.providerId = result.providerId || record.providerId;
  record.modelId = result.modelId || record.modelId;
  record.outputTokens = Number(result.outputTokens || 0);
  record.error = result.error ? String(result.error).slice(0, 500) : '';
  runtime.totals.active = Math.max(0, runtime.totals.active - 1);
  if (result.ok) {
    runtime.totals.completed += 1;
    runtime.totals.inputTokens += Number(result.inputTokens || record.inputTokens || 0);
    runtime.totals.outputTokens += record.outputTokens;
  } else {
    runtime.totals.errors += 1;
  }

  const provider = result.skipProviderStats
    ? null
    : record.providerId
      ? runtime.providers.get(record.providerId)
      : null;
  if (provider) {
    const stats = provider.stats;
    stats.latencyTotal += record.latencyMs;
    stats.latencyCount += 1;
    if (result.ok) {
      stats.successes += 1;
      stats.inputTokens += Number(result.inputTokens || record.inputTokens || 0);
      stats.outputTokens += record.outputTokens;
      provider.lastStatus = 'ready';
      provider.lastError = '';
      provider.cooldownUntil = 0;
      provider.lastChecked = Date.now();
      provider.latencyMs = record.latencyMs;
    } else {
      stats.errors += 1;
      provider.lastStatus = 'error';
      provider.lastError = record.error;
      provider.lastChecked = Date.now();
      const status = Number(result.status || 500);
      if (status === 429 || status === 408 || status >= 500) {
        const cooldown = Math.max(
          Number(runtime.settings.routing.fallback?.cooldownMs || 60000),
          Number(result.retryAfter || 0) * 1000,
        );
        provider.cooldownUntil = Date.now() + Math.min(cooldown, 10 * 60 * 1000);
      }
    }
  }
  record.attempts = record.attempts.map((attempt) => ({ ...attempt }));
  runtime.scheduleUpdate?.();
  return record;
}

export function recordProviderTest(runtime, providerId, result) {
  const provider = runtime.providers.get(providerId);
  if (!provider) return;
  provider.lastChecked = Date.now();
  provider.latencyMs = result.latencyMs ?? null;
  if (result.ok) {
    provider.lastStatus = 'ready';
    provider.lastError = '';
    provider.cooldownUntil = 0;
  } else {
    provider.lastStatus = 'error';
    provider.lastError = String(result.error || 'test échoué').slice(0, 500);
  }
  runtime.scheduleUpdate?.();
}

export function setProviderKey(runtime, providerId, key) {
  const providerSettings = runtime.settings.providers?.[providerId];
  if (!providerSettings) throw new Error(`Fournisseur inconnu : ${providerId}`);
  const envName = providerSettings.apiKeyEnv;
  if (!envName) throw new Error(`apiKeyEnv manquant pour ${providerId}`);
  const value = String(key || '').trim();
  if (value) {
    if (runtime.envPath) updateEnvValue(runtime.envPath, envName, value);
    runtime.env[envName] = value;
    process.env[envName] = value;
  } else {
    if (runtime.envPath) updateEnvValue(runtime.envPath, envName, '');
    delete runtime.env[envName];
    if (process.env[envName]) process.env[envName] = '';
  }
  refreshProviders(runtime);
  runtime.scheduleUpdate?.();
  return { providerId, keyConfigured: Boolean(value) };
}

export function updateProvider(runtime, providerId, patch) {
  const providerSettings = runtime.settings.providers?.[providerId];
  if (!providerSettings) throw new Error(`Fournisseur inconnu : ${providerId}`);
  const allowed = [
    'label',
    'enabled',
    'baseUrl',
    'modelsUrl',
    'apiKeyEnv',
    'maxTokensField',
    'streamUsage',
    'reasoning',
    'tools',
    'headers',
    'retries',
  ];
  for (const key of allowed) {
    if (patch?.[key] === undefined) continue;
    providerSettings[key] = patch[key];
  }
  if (patch?.models && typeof patch.models === 'object') {
    providerSettings.models = deepMerge(providerSettings.models || {}, patch.models);
  }
  persist(runtime);
  refreshProviders(runtime);
  runtime.scheduleUpdate?.();
  return runtime.snapshot?.() || snapshot(runtime);
}

export function updateRouting(runtime, patch) {
  const routing = runtime.settings.routing;
  for (const key of ['claudeModels', 'aliases', 'classifier', 'fallback', 'profiles']) {
    if (patch?.[key] !== undefined) {
      routing[key] = deepMerge(routing[key] || {}, patch[key]);
    }
  }
  if (patch?.activeProfile !== undefined) {
    const profile = String(patch.activeProfile);
    if (!routing.profiles?.[profile]) throw new Error(`Profil inconnu : ${profile}`);
    routing.activeProfile = profile;
  }
  if (!routing.profiles?.[routing.activeProfile]) routing.activeProfile = 'auto';
  persist(runtime);
  runtime.scheduleUpdate?.();
  return snapshot(runtime);
}

export function setActiveProfile(runtime, profileId) {
  return updateRouting(runtime, { activeProfile: profileId });
}

export function updateMcp(runtime, input) {
  runtime.settings.mcp.servers = upsertMcpServer(runtime.settings.mcp.servers || [], input);
  persist(runtime);
  runtime.scheduleUpdate?.();
  return snapshot(runtime);
}

export function deleteMcp(runtime, name) {
  runtime.settings.mcp.servers = removeMcpServer(runtime.settings.mcp.servers || [], name);
  persist(runtime);
  runtime.scheduleUpdate?.();
  return snapshot(runtime);
}

export function updatePluginPaths(runtime, paths) {
  runtime.settings.plugins.paths = normalizePluginPaths(paths);
  persist(runtime);
  runtime.scheduleUpdate?.();
  return snapshot(runtime);
}

export function persist(runtime) {
  if (runtime.settingsPath) saveSettings(runtime.settingsPath, runtime.settings);
}

export function reload(runtime) {
  if (runtime.envPath) loadEnvFile(runtime.envPath, { override: true });
  if (runtime.settingsPath) runtime.settings = loadSettings(runtime.settingsPath);
  refreshProviders(runtime);
  runtime.scheduleUpdate?.();
  return snapshot(runtime);
}

export async function testProvider(runtime, providerId) {
  const provider = runtime.providers.get(providerId);
  if (!provider) throw new Error(`Fournisseur inconnu : ${providerId}`);
  const started = Date.now();
  try {
    const models = await listUpstreamModels(provider, { timeoutMs: 20000 });
    const latencyMs = Date.now() - started;
    recordProviderTest(runtime, providerId, { ok: true, latencyMs });
    return { ok: true, latencyMs, models: models.length };
  } catch (error) {
    const latencyMs = Date.now() - started;
    recordProviderTest(runtime, providerId, {
      ok: false,
      latencyMs,
      error: error?.message || String(error),
    });
    return { ok: false, latencyMs, error: error?.message || String(error) };
  }
}

export async function refreshProviderModels(runtime, providerId) {
  const provider = runtime.providers.get(providerId);
  if (!provider) throw new Error(`Fournisseur inconnu : ${providerId}`);
  const list = await listUpstreamModels(provider, { timeoutMs: 30000 });
  const settingsProvider = runtime.settings.providers[providerId];
  let added = 0;
  for (const entry of list) {
    const id = String(entry?.id || entry?.name || '').trim();
    if (!id) continue;
    if (!settingsProvider.models[id]) {
      settingsProvider.models[id] = {
        label: id,
        context: Number(entry?.context_window || entry?.context_length) || DEFAULT_CONTEXT,
        maxOutput: Number(entry?.max_output_tokens) || DEFAULT_MAX_OUTPUT,
        tools: true,
        reasoning: [],
        tags: ['discovered'],
        discovered: true,
      };
      added += 1;
    }
  }
  persist(runtime);
  refreshProviders(runtime);
  recordProviderTest(runtime, providerId, { ok: true, latencyMs: null });
  return { added, total: Object.keys(settingsProvider.models).length };
}

export function primaryInfo(runtime) {
  const body = {
    model: runtime.config.claudeModel || 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'ping' }],
    tools: [],
  };
  let decision;
  try {
    decision = decideRoute(body, runtime.providers, runtime.settings, {
      profile: runtime.settings.routing.activeProfile || 'auto',
    });
  } catch {
    decision = null;
  }
  const candidates = decision?.candidates?.length
    ? decision.candidates
    : providerList(runtime.providers)
        .filter((provider) => provider.enabled && provider.apiKey)
        .flatMap((provider) =>
          [...provider.models.values()].map((model) => ({ provider, model })),
        );
  if (!candidates.length) {
    return {
      context: DEFAULT_CONTEXT,
      maxOutput: Number(runtime.config.maxOutputTokens || DEFAULT_MAX_OUTPUT),
      targets: [],
    };
  }
  return {
    context: Math.min(...candidates.map((candidate) => candidate.model.context || DEFAULT_CONTEXT)),
    maxOutput: Math.min(
      ...candidates.map((candidate) => candidate.model.maxOutput || DEFAULT_MAX_OUTPUT),
      Number(runtime.config.maxOutputTokens || DEFAULT_MAX_OUTPUT),
    ),
    targets: candidates.map((candidate) => candidate.target),
  };
}

export function apiModels(runtime) {
  const seen = new Set();
  const out = [];
  const add = (id, label = id) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({
      type: 'model',
      id,
      display_name: label,
      created_at: '2025-01-01T00:00:00Z',
    });
  };
  add(runtime.config.claudeModel);
  add(runtime.config.claudeSmallModel);
  for (const provider of providerList(runtime.providers)) {
    for (const model of provider.models.values()) {
      add(modelTarget(provider.id, model.id), `${provider.label} / ${model.label}`);
    }
  }
  // IDs Groq bruts pour compatibilité avec les anciens scripts.
  const groq = runtime.providers.get('groq');
  if (groq) {
    for (const model of groq.models.values()) add(model.id, model.label);
  }
  return out;
}

export function closeRuntime(runtime) {
  runtime.closed = true;
  runtime.events.removeAllListeners();
}

export { estimateRequestTokens };

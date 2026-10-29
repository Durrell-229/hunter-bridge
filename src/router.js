import { estimateRequestTokens } from './util.js';

const PROVIDER_ALIASES = Object.freeze({
  groq: 'groq',
  opencode: 'opencode',
  opencodezen: 'opencode',
  'opencode-zen': 'opencode',
  zen: 'opencode',
  nvidia: 'nvidia',
  nim: 'nvidia',
  'nvidia-nim': 'nvidia',
  nvidianim: 'nvidia',
  gemini: 'gemini',
  google: 'gemini',
  'google-gemini': 'gemini',
});

const PROFILE_PREFIXES = new Set(['hunter', 'profile', 'route']);

export function providerById(providers, id) {
  if (!providers) return null;
  if (providers instanceof Map) return providers.get(id) || null;
  return providers[id] || null;
}

export function providerList(providers) {
  if (!providers) return [];
  if (providers instanceof Map) return [...providers.values()];
  return Object.values(providers);
}

export function normalizeProviderId(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return PROVIDER_ALIASES[value] || value;
}

export function splitTarget(raw) {
  const value = String(raw || '').trim();
  const slash = value.indexOf('/');
  if (slash <= 0) return { providerId: '', modelId: value, raw: value };
  return {
    providerId: normalizeProviderId(value.slice(0, slash)),
    modelId: value.slice(slash + 1),
    raw: value,
  };
}

export function modelTarget(providerId, modelId) {
  return `${providerId}/${modelId}`;
}

/**
 * Retrouve le slot Claude Code (sonnet/opus/haiku) à partir de l'alias ou
 * de l'identifiant natif envoyé par Claude Code.
 */
export function claudeSlotFor(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '';
  if (value === 'haiku' || /(^|[-_/])haiku([-_.]|$)/.test(value)) return 'haiku';
  if (value === 'opus' || /(^|[-_/])opus([-_.]|$)/.test(value)) return 'opus';
  if (value === 'sonnet' || /(^|[-_/])sonnet([-_.]|$)/.test(value)) return 'sonnet';
  if (value === 'claude' || /^claude([-_.]|$)/.test(value)) return 'sonnet';
  return '';
}

function canonicalModelId(provider, modelId) {
  const value = String(modelId || '');
  if (!provider || !value) return value;
  if (provider.models?.has?.(value)) return value;
  const qualified = `${provider.id}/${value}`;
  if (provider.models?.has?.(qualified)) return qualified;
  if (provider.models && !(provider.models instanceof Map) && provider.models[qualified]) {
    return qualified;
  }
  return value;
}

function parsedClaudeModel(value, slot, providers, settings) {
  const mapped = String(settings?.routing?.claudeModels?.[slot] || '').trim();
  if (!mapped) return null;
  if (mapped === 'auto' || PROFILE_PREFIXES.has(mapped.toLowerCase().split('/')[0])) {
    const profileId = mapped.includes('/')
      ? mapped.slice(mapped.indexOf('/') + 1)
      : mapped;
    return { kind: 'profile', profileId, raw: value, slot };
  }
  const target = splitTarget(mapped);
  const provider = target.providerId ? providerById(providers, target.providerId) : null;
  if (provider && target.modelId) {
    return {
      kind: 'target',
      providerId: target.providerId,
      modelId: canonicalModelId(provider, target.modelId),
      raw: value,
      slot,
      mappedFrom: mapped,
    };
  }
  return null;
}

export function extractRequestText(body, limit = 24000) {
  const parts = [];
  parts.push(systemText(body?.system));
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    parts.push(contentText(message?.content));
  }
  if (Array.isArray(body?.tools)) {
    for (const tool of body.tools) {
      if (tool?.name) parts.push(String(tool.name));
      if (tool?.description) parts.push(String(tool.description).slice(0, 500));
    }
  }
  return parts.join('\n').slice(-limit).toLowerCase();
}

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  if (system && typeof system === 'object' && typeof system.text === 'string') return system.text;
  return '';
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

export function classifyProfile(text, settings) {
  const routing = settings?.routing || {};
  const minScore = Number(routing.classifier?.minScore ?? 1);
  if (routing.classifier?.enabled === false) {
    return { profileId: 'auto', score: 0, matches: [], reason: 'classifier désactivé' };
  }
  const entries = Object.entries(routing.profiles || {});
  let best = null;
  for (const [id, profile] of entries) {
    if (id === 'auto' || id === 'fast' || id === 'general') continue;
    const keywords = Array.isArray(profile.keywords) ? profile.keywords : [];
    let score = 0;
    const matches = [];
    for (const keyword of keywords) {
      const needle = String(keyword || '').trim().toLowerCase();
      if (!needle) continue;
      if (text.includes(needle)) {
        score += needle.includes(' ') ? 3 : /^[a-z0-9]{1,3}$/.test(needle) ? 1 : 2;
        matches.push(keyword);
      }
    }
    if (!best || score > best.score) best = { profileId: id, score, matches };
  }
  if (!best || best.score < minScore) {
    return {
      profileId: 'auto',
      score: best?.score || 0,
      matches: best?.matches || [],
      reason: 'aucun signal fort',
    };
  }
  return {
    profileId: best.profileId,
    score: best.score,
    matches: best.matches.slice(0, 8),
    reason: `signaux: ${best.matches.slice(0, 6).join(', ')}`,
  };
}

/**
 * Détermine si le modèle demandé est un alias, un profil explicite ou une
 * cible fournisseur explicite. Les IDs Groq historiques restent acceptés.
 */
export function parseRequestedModel(raw, providers, settings) {
  const value = String(raw || '').trim();
  if (!value) return { kind: 'none', raw: value };
  const lower = value.toLowerCase();

  // Les alias natifs de Claude Code (`claude-sonnet-4-5`, `sonnet`, etc.)
  // sont mappés vers les trois slots configurés dans le dashboard. Cela
  // permet à `/model` de choisir réellement le fournisseur sous-jacent.
  const claudeSlot = claudeSlotFor(lower);
  if (claudeSlot) {
    const mapped = parsedClaudeModel(value, claudeSlot, providers, settings);
    if (mapped) return mapped;
    const aliases = settings?.routing?.aliases || {};
    const profileId =
      aliases[lower] ||
      aliases[claudeSlot] ||
      (claudeSlot === 'haiku' ? 'fast' : settings?.routing?.activeProfile || 'auto');
    return { kind: 'alias', profileId, raw: value, slot: claudeSlot };
  }

  const profileAlias = (settings?.routing?.aliases || {})[lower];
  if (profileAlias) return { kind: 'alias', profileId: profileAlias, raw: value };

  const first = lower.split('/')[0];
  if (PROFILE_PREFIXES.has(first) && lower.includes('/')) {
    return { kind: 'profile', profileId: lower.slice(first.length + 1), raw: value };
  }

  const target = splitTarget(value);
  const targetProvider = target.providerId ? providerById(providers, target.providerId) : null;
  if (targetProvider && target.modelId) {
    return {
      kind: 'target',
      providerId: target.providerId,
      modelId: canonicalModelId(targetProvider, target.modelId),
      raw: value,
    };
  }

  // ID sans préfixe fournisseur : on le cherche dans les catalogues.
  for (const provider of providerList(providers)) {
    if (provider.models?.has?.(value)) {
      return { kind: 'target', providerId: provider.id, modelId: value, raw: value };
    }
    if (provider.models && !(provider.models instanceof Map) && provider.models[value]) {
      return { kind: 'target', providerId: provider.id, modelId: value, raw: value };
    }
  }

  // Compatibilité Groq : un ID avec slash non préfixé reste un modèle Groq.
  if (value.includes('/')) {
    return { kind: 'target', providerId: 'groq', modelId: value, raw: value };
  }

  // Alias Claude Code ou nom inconnu : on laisse le routeur choisir.
  return { kind: 'alias', profileId: settings?.routing?.activeProfile || 'auto', raw: value };
}

export function modelInfoFor(provider, modelId) {
  if (!provider) return null;
  if (provider.models instanceof Map) return provider.models.get(modelId) || null;
  return provider.models?.[modelId] || null;
}

export function chooseProfile(body, providers, settings, options = {}) {
  const requested = String(body?.model || '').trim();
  const parsed = parseRequestedModel(requested, providers, settings);
  const activeProfile = String(options.profile || settings?.routing?.activeProfile || 'auto');
  const text = extractRequestText(body);

  if (parsed.kind === 'profile') {
    return {
      profileId: parsed.profileId,
      reason: `profil explicite ${parsed.raw}`,
      score: 0,
      matches: [],
      parsed,
      activeProfile,
    };
  }
  if (parsed.kind === 'target') {
    const classification =
      activeProfile === 'auto'
        ? classifyProfile(text, settings)
        : { profileId: activeProfile, score: 0, matches: [], reason: 'profil actif' };
    return { ...classification, parsed, activeProfile };
  }
  if (parsed.kind === 'alias' && parsed.profileId !== activeProfile) {
    const profileId = parsed.profileId || activeProfile;
    if (profileId !== 'auto') {
      return {
        profileId,
        reason: `alias ${requested} → ${profileId}`,
        score: 0,
        matches: [],
        parsed,
        activeProfile,
      };
    }
  }
  if (activeProfile !== 'auto') {
    return {
      profileId: activeProfile,
      reason: 'profil actif',
      score: 0,
      matches: [],
      parsed,
      activeProfile,
    };
  }
  return { ...classifyProfile(text, settings), parsed, activeProfile };
}

function candidateFromTarget(provider, modelId, { explicit = false } = {}) {
  const canonicalId = canonicalModelId(provider, modelId);
  const info = modelInfoFor(provider, canonicalId) || {
    label: canonicalId,
    context: 131072,
    maxOutput: 32768,
    tools: true,
    reasoning: [],
    tags: ['provisional'],
  };
  return {
    providerId: provider.id,
    provider,
    modelId: canonicalId,
    model: info,
    target: modelTarget(provider.id, canonicalId),
    explicit,
    provisional: !modelInfoFor(provider, canonicalId),
  };
}

function requirementsMet(candidate, { needsTools, inputTokens }) {
  if (!candidate.provider.enabled) return 'fournisseur désactivé';
  if (!candidate.provider.apiKey) return `${candidate.provider.apiKeyEnv || 'clé'} absente`;
  if (needsTools && candidate.provider.tools === false) return 'fournisseur sans support des outils';
  if (candidate.provider.cooldownUntil && candidate.provider.cooldownUntil > Date.now()) {
    return 'fournisseur en cooldown';
  }
  if (candidate.provider.maxInputTokens && inputTokens > candidate.provider.maxInputTokens) {
    return `quota d'entrée dépassé (${inputTokens} > ${candidate.provider.maxInputTokens} tokens)`;
  }
  if (needsTools && candidate.model.tools === false) return 'modèle sans support des outils';
  const context = Number(candidate.model.context || 131072);
  if (inputTokens > context - 2048) return `contexte insuffisant (${inputTokens} > ${context})`;
  return '';
}

export function selectCandidates(profileId, parsed, body, providers, settings, options = {}) {
  const routing = settings?.routing || {};
  const profile = routing.profiles?.[profileId] || routing.profiles?.auto || {};
  const inputTokens = estimateRequestTokens(body);
  const needsTools = Array.isArray(body?.tools) && body.tools.length > 0;
  const skipped = [];
  const seen = new Set();
  const chain = [];

  if (parsed?.kind === 'target') {
    chain.push({
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      explicit: true,
    });
  }
  for (const entry of Array.isArray(profile.chain) ? profile.chain : []) {
    if (typeof entry === 'string') {
      const target = splitTarget(entry);
      if (target.providerId && target.modelId) chain.push(target);
    } else if (entry && entry.provider && entry.model) {
      chain.push({
        providerId: normalizeProviderId(entry.provider),
        modelId: String(entry.model),
      });
    }
  }

  const candidates = [];
  for (const target of chain) {
    const provider = providerById(providers, target.providerId);
    if (!provider) {
      skipped.push(`${target.providerId}/${target.modelId}: fournisseur inconnu`);
      continue;
    }
    const key = `${target.providerId}/${target.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate = candidateFromTarget(provider, target.modelId, {
      explicit: Boolean(target.explicit),
    });
    const reason = requirementsMet(candidate, { needsTools, inputTokens });
    if (reason) {
      skipped.push(`${key}: ${reason}`);
      continue;
    }
    candidates.push(candidate);
  }

  // Si la chaîne est vide ou entièrement filtrée, on tente les autres
  // fournisseurs configurés en gardant les mêmes contraintes.
  if (candidates.length === 0) {
    for (const provider of providerList(providers)) {
      if (!provider.enabled || !provider.apiKey) continue;
      const models =
        provider.models instanceof Map
          ? [...provider.models.keys()]
          : Object.keys(provider.models || {});
      for (const modelId of models) {
        const key = `${provider.id}/${modelId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const candidate = candidateFromTarget(provider, modelId);
        const reason = requirementsMet(candidate, { needsTools, inputTokens });
        if (reason) {
          skipped.push(`${key}: ${reason}`);
          continue;
        }
        candidates.push(candidate);
      }
    }
  }

  const requestedMax = Number(routing.fallback?.maxCandidates);
  const maxCandidates = Number.isFinite(requestedMax)
    ? Math.max(1, Math.min(12, requestedMax))
    : 4;
  return {
    profileId,
    profile,
    inputTokens,
    needsTools,
    candidates: candidates.slice(0, maxCandidates),
    skipped,
    chain,
  };
}

export function decideRoute(body, providers, settings, options = {}) {
  const chosen = chooseProfile(body, providers, settings, options);
  const profileId = chosen.profileId || 'auto';
  const selection = selectCandidates(profileId, chosen.parsed, body, providers, settings, options);
  const suffix =
    selection.profile?.suffix ||
    settings?.routing?.profiles?.auto?.suffix ||
    '';
  return {
    ...selection,
    profileId: selection.profileId || profileId,
    activeProfile: chosen.activeProfile,
    requestedModel: String(body?.model || ''),
    reason: chosen.reason,
    score: chosen.score,
    matches: chosen.matches,
    parsed: chosen.parsed,
    systemSuffix: suffix,
    selected: selection.candidates[0] || null,
  };
}

export function describeMissingProviders(providers) {
  const list = providerList(providers)
    .filter((provider) => provider.enabled && !provider.apiKey)
    .map((provider) => provider.apiKeyEnv || `${provider.id}_API_KEY`);
  return list;
}

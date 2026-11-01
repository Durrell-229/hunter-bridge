import { BridgeError, errorTypeForStatus } from './errors.js';
import { redactSecrets, sleep } from './util.js';
import { VERSION } from './version.js';

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function authHeaders(provider, accept) {
  const headers = {
    authorization: `Bearer ${provider.apiKey}`,
    'content-type': 'application/json',
    accept,
    'user-agent': `hunter-bridge/${VERSION}`,
  };
  for (const [name, value] of Object.entries(provider.headers || {})) {
    if (value === undefined || value === null || value === '') continue;
    headers[name.toLowerCase()] = String(value);
  }
  return headers;
}

function createTimeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1, ms));
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

function combineSignals(signals) {
  const controller = new AbortController();
  const cleanups = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const cleanup of cleanups) cleanup();
    },
  };
}

async function fetchUpstream(provider, url, init, { signal, timeoutMs }) {
  const timeout = createTimeoutSignal(timeoutMs);
  const combined = combineSignals([signal, timeout.signal]);
  const cleanup = () => {
    timeout.cleanup();
    combined.cleanup();
  };

  try {
    const res = await fetch(url, { ...init, signal: combined.signal });
    return { res, cleanup };
  } catch (error) {
    cleanup();
    if (signal?.aborted) {
      throw new BridgeError('Requête cliente annulée', {
        status: 499,
        type: 'api_error',
        clientAborted: true,
      });
    }
    if (timeout.signal.aborted) {
      throw new BridgeError(
        `${provider.label} n'a pas répondu en ${Math.round(timeoutMs / 1000)} s`,
        { status: 504, type: 'api_error' },
      );
    }
    throw new BridgeError(
      `Impossible de joindre ${provider.label} (${provider.baseUrl}) : ${error?.message || error}`,
      { status: 502, type: 'api_error', cause: error },
    );
  }
}

/**
 * Adapte le corps Anthropic traduit aux particularités du fournisseur.
 * Les variantes de secours prennent ensuite le relais sur les 400 de schéma.
 */
export function adaptBody(provider, body) {
  const next = { ...body };
  if (provider.maxTokensField === 'max_tokens' && next.max_completion_tokens !== undefined) {
    next.max_tokens = next.max_completion_tokens;
    delete next.max_completion_tokens;
  } else if (
    provider.maxTokensField === 'max_completion_tokens' &&
    next.max_tokens !== undefined
  ) {
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
  }
  if (provider.streamUsage === false) delete next.stream_options;
  if (provider.reasoning === false) delete next.reasoning_effort;
  if (provider.tools === false) {
    delete next.tools;
    delete next.tool_choice;
    delete next.parallel_tool_calls;
  }
  return next;
}

/** Variantes de repli, essayées uniquement sur un 400 de paramètre. */
export function buildVariants(body) {
  const variants = [body];
  const add = (patch) => {
    const variant = { ...body, ...patch };
    for (const key of Object.keys(variant)) {
      if (variant[key] === undefined) delete variant[key];
    }
    if (!variants.some((candidate) => JSON.stringify(candidate) === JSON.stringify(variant))) {
      variants.push(variant);
    }
  };

  const hasMaxCompletion = Object.prototype.hasOwnProperty.call(body, 'max_completion_tokens');
  const hasMaxTokens = Object.prototype.hasOwnProperty.call(body, 'max_tokens');
  const hasStreamOptions = Object.prototype.hasOwnProperty.call(body, 'stream_options');

  if (hasMaxCompletion) {
    add({ max_tokens: body.max_completion_tokens, max_completion_tokens: undefined });
  }
  if (hasMaxTokens) {
    add({ max_completion_tokens: body.max_tokens, max_tokens: undefined });
  }
  if (hasStreamOptions) add({ stream_options: undefined });
  if (hasMaxCompletion && hasStreamOptions) {
    add({
      max_tokens: body.max_completion_tokens,
      max_completion_tokens: undefined,
      stream_options: undefined,
    });
  }
  if (hasMaxTokens && hasStreamOptions) {
    add({
      max_completion_tokens: body.max_tokens,
      max_tokens: undefined,
      stream_options: undefined,
    });
  }
  if (body.tool_choice === 'required') add({ tool_choice: 'auto' });
  if (body.reasoning_effort) add({ reasoning_effort: undefined });
  if (body.temperature !== undefined) add({ temperature: undefined });
  if (body.top_p !== undefined) add({ top_p: undefined });
  return variants;
}

function isFallbackable400(message) {
  return /max_completion_tokens|max_tokens|stream_options|include_usage|tool_choice|reasoning_effort|temperature|top_p|unsupported|unknown|unrecognized|not supported|invalid parameter|invalid value/i.test(
    String(message || ''),
  );
}

function parseRetryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, (date - Date.now()) / 1000);
  return undefined;
}

function makeUpstreamError(provider, res, text) {
  let message = '';
  try {
    const parsed = JSON.parse(text);
    message = parsed?.error?.message || parsed?.error?.type || parsed?.message || text;
  } catch {
    message = text;
  }
  message = redactSecrets(String(message || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
  if (!message) message = `${provider.label} a renvoyé HTTP ${res.status}`;
  if (res.status === 401) {
    message = `${message} — vérifie ${provider.apiKeyEnv || 'la clé API'}.`;
  }
  if (res.status === 403) {
    message = `${message} — la clé n'a pas accès à ce modèle ou à cette ressource.`;
  }

  const status = res.status === 422 ? 400 : res.status;
  return new BridgeError(message, {
    status,
    type: errorTypeForStatus(status),
    upstreamStatus: res.status,
    retryAfter: parseRetryAfter(res.headers.get('retry-after')),
  });
}

function retryDelay(attempt, retryAfter) {
  if (Number.isFinite(retryAfter)) {
    return Math.min(10000, Math.max(0, retryAfter * 1000));
  }
  return Math.min(5000, 400 * 2 ** attempt + Math.floor(Math.random() * 200));
}

/**
 * Envoie une requête chat/completions à un fournisseur OpenAI-compatible.
 * Retourne { res, requestBody, cleanup }. L'appelant DOIT appeler cleanup().
 */
export async function requestUpstream(
  provider,
  body,
  { signal, timeoutMs, stream = false } = {},
) {
  if (!provider?.apiKey && provider.id !== 'ollama') {
    throw new BridgeError(
      `${provider?.apiKeyEnv || 'Clé API'} manquante. Renseigne-la dans .env ou dans l’environnement.`,
      { status: 500, type: 'configuration_error' },
    );
  }
  if (!provider.baseUrl) {
    throw new BridgeError(`URL de base manquante pour ${provider.label}.`, {
      status: 500,
      type: 'configuration_error',
    });
  }

  const urlPath = provider.id === 'ollama' ? '/api/chat' : '/chat/completions';
  const url = `${provider.baseUrl}${urlPath}`;
  const adapted = adaptBody(provider, body);
  const variants = buildVariants(adapted);
  const effectiveTimeout =
    timeoutMs || (stream ? provider.streamTimeoutMs : provider.requestTimeoutMs);
  const retries = Number.isInteger(provider.retries) ? provider.retries : 1;
  let firstError = null;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) {
      throw new BridgeError('Requête cliente annulée', {
        status: 499,
        type: 'api_error',
        clientAborted: true,
      });
    }

    for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
      const variant = variants[variantIndex];
      let fetched;
      try {
        fetched = await fetchUpstream(
          provider,
          url,
          {
            method: 'POST',
            headers: authHeaders(provider, stream ? 'text/event-stream' : 'application/json'),
            body: JSON.stringify(variant),
          },
          { signal, timeoutMs: effectiveTimeout },
        );
      } catch (error) {
        lastError = error;
        if (error?.clientAborted) throw error;
        break;
      }

      const { res, cleanup } = fetched;
      if (res.ok) return { res, requestBody: variant, cleanup };

      let text = '';
      try {
        text = await res.text();
      } catch {
        // corps d'erreur illisible
      }
      cleanup();

      const error = makeUpstreamError(provider, res, text);
      if (!firstError) firstError = error;
      lastError = error;

      if (
        res.status === 400 &&
        variantIndex < variants.length - 1 &&
        isFallbackable400(error.message)
      ) {
        continue;
      }
      if (res.status === 400) throw firstError;
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) break;
      throw error;
    }

    if (attempt < retries) {
      const delay = retryDelay(attempt, lastError?.retryAfter);
      await sleep(delay);
      if (signal?.aborted) {
        throw new BridgeError('Requête cliente annulée', {
          status: 499,
          type: 'api_error',
          clientAborted: true,
        });
      }
    }
  }

  throw lastError ||
    firstError ||
    new BridgeError(`Échec de la requête ${provider.label}`, {
      status: 502,
      type: 'api_error',
    });
}

export async function listUpstreamModels(provider, { signal, timeoutMs = 20000 } = {}) {
  if (!provider?.apiKey) {
    throw new BridgeError(`${provider?.apiKeyEnv || 'Clé API'} manquante pour lister les modèles.`, {
      status: 500,
      type: 'configuration_error',
    });
  }
  const modelsUrl = provider.modelsUrl || `${provider.baseUrl}/models`;
  const { res, cleanup } = await fetchUpstream(
    provider,
    modelsUrl,
    { method: 'GET', headers: authHeaders(provider, 'application/json') },
    { signal, timeoutMs },
  );

  try {
    if (!res.ok) {
      let text = '';
      try {
        text = await res.text();
      } catch {
        // ignore
      }
      throw makeUpstreamError(provider, res, text);
    }
    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(`Réponse /models invalide pour ${provider.label} : ${error?.message || error}`, {
      status: 502,
      type: 'api_error',
      cause: error,
    });
  } finally {
    cleanup();
  }
}

/** Petit appel de test utilisé par `hunter doctor --chat` et le dashboard. */
export async function simpleChat(
  provider,
  { model, prompt, maxTokens = 16, timeoutMs = 30000, reasoningEffort } = {},
) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt || 'Réponds uniquement : OK' }],
    max_completion_tokens: maxTokens,
    temperature: 0,
  };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  const { res, cleanup } = await requestUpstream(provider, body, { timeoutMs, stream: false });

  try {
    return await res.json();
  } catch (error) {
    throw new BridgeError(`Réponse ${provider.label} invalide : ${error?.message || error}`, {
      status: 502,
      type: 'api_error',
      cause: error,
    });
  } finally {
    cleanup();
  }
}

export { RETRYABLE_STATUS };

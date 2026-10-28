import { BridgeError, errorTypeForStatus } from './errors.js';
import { redactSecrets, sleep } from './util.js';
import { VERSION } from './version.js';

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function authHeaders(config, accept) {
  return {
    authorization: `Bearer ${config.apiKey}`,
    'content-type': 'application/json',
    accept,
    'user-agent': `groq-claude-bridge/${VERSION}`,
  };
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

async function fetchGroq(config, url, init, { signal, timeoutMs }) {
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
        `Groq n'a pas répondu en ${Math.round(timeoutMs / 1000)} s`,
        { status: 504, type: 'api_error' },
      );
    }
    throw new BridgeError(
      `Impossible de joindre Groq (${config.groqBaseUrl}) : ${error?.message || error}`,
      { status: 502, type: 'api_error', cause: error },
    );
  }
}

/**
 * Certains modèles Groq refusent max_completion_tokens ou stream_options.
 * On prépare des variantes de repli, essayées uniquement sur un 400.
 */
function buildVariants(body) {
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
  const hasStreamOptions = Object.prototype.hasOwnProperty.call(body, 'stream_options');

  if (hasMaxCompletion) {
    add({ max_tokens: body.max_completion_tokens, max_completion_tokens: undefined });
  }
  if (hasStreamOptions) {
    add({ stream_options: undefined });
  }
  if (hasMaxCompletion && hasStreamOptions) {
    add({
      max_tokens: body.max_completion_tokens,
      max_completion_tokens: undefined,
      stream_options: undefined,
    });
  }
  if (body.tool_choice === 'required') {
    add({ tool_choice: 'auto' });
  }
  if (body.reasoning_effort) {
    add({ reasoning_effort: undefined });
  }
  return variants;
}

/**
 * On ne veut pas retenter quatre fois pour une erreur de contexte ou de
 * schéma d'outil : seules les erreurs de paramètre ont une variante de repli.
 */
function isFallbackable400(message) {
  return /max_completion_tokens|max_tokens|stream_options|include_usage|tool_choice|reasoning_effort|unsupported|unknown|unrecognized|not supported|invalid parameter/i.test(
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

function makeUpstreamError(res, text) {
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
  if (!message) message = `Groq a renvoyé HTTP ${res.status}`;
  if (res.status === 401) message = `${message} — vérifie GROQ_API_KEY.`;
  if (res.status === 403) message = `${message} — la clé n'a pas accès à ce modèle.`;

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
 * Envoie une requête chat/completions à Groq.
 * Retourne { res, requestBody, cleanup }. L'appelant DOIT appeler cleanup()
 * après avoir consommé le corps de la réponse.
 */
export async function requestGroq(config, body, { signal, timeoutMs, stream = false } = {}) {
  if (!config.apiKey) {
    throw new BridgeError(
      'GROQ_API_KEY manquante. Renseigne-la dans .env ou dans l’environnement.',
      { status: 500, type: 'configuration_error' },
    );
  }

  const url = `${config.groqBaseUrl}/chat/completions`;
  const variants = buildVariants(body);
  const effectiveTimeout = timeoutMs || (stream ? config.streamTimeoutMs : config.requestTimeoutMs);
  let firstError = null;
  let lastError = null;

  for (let attempt = 0; attempt <= config.retries; attempt += 1) {
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
        fetched = await fetchGroq(
          config,
          url,
          {
            method: 'POST',
            headers: authHeaders(config, stream ? 'text/event-stream' : 'application/json'),
            body: JSON.stringify(variant),
          },
          { signal, timeoutMs: effectiveTimeout },
        );
      } catch (error) {
        lastError = error;
        if (error?.clientAborted) throw error;
        break; // erreur réseau / timeout : on retente la requête complète
      }

      const { res, cleanup } = fetched;
      if (res.ok) return { res, requestBody: variant, cleanup };

      let text = '';
      try {
        text = await res.text();
      } catch {
        // Le corps d'erreur peut être illisible, on garde le statut.
      }
      cleanup();

      const error = makeUpstreamError(res, text);
      if (!firstError) firstError = error;
      lastError = error;

      if (
        res.status === 400 &&
        variantIndex < variants.length - 1 &&
        isFallbackable400(error.message)
      ) {
        continue; // essaye la variante suivante
      }
      if (res.status === 400) throw firstError;
      if (RETRYABLE_STATUS.has(res.status) && attempt < config.retries) break;
      throw error;
    }

    if (attempt < config.retries) {
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

  throw lastError || firstError || new BridgeError('Échec de la requête Groq', {
    status: 502,
    type: 'api_error',
  });
}

export async function listGroqModels(config, { signal, timeoutMs = 20000 } = {}) {
  if (!config.apiKey) {
    throw new BridgeError('GROQ_API_KEY manquante pour lister les modèles.', {
      status: 500,
      type: 'configuration_error',
    });
  }

  const { res, cleanup } = await fetchGroq(
    config,
    `${config.groqBaseUrl}/models`,
    { method: 'GET', headers: authHeaders(config, 'application/json') },
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
      throw makeUpstreamError(res, text);
    }
    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : [];
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(`Réponse /models invalide : ${error?.message || error}`, {
      status: 502,
      type: 'api_error',
      cause: error,
    });
  } finally {
    cleanup();
  }
}

/** Petit appel de test utilisé par `groqcc doctor --chat`. */
export async function simpleChat(
  config,
  { model, prompt, maxTokens = 16, timeoutMs = 30000, reasoningEffort } = {},
) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt || 'Réponds uniquement : OK' }],
    max_completion_tokens: maxTokens,
    temperature: 0,
  };
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  const { res, cleanup } = await requestGroq(config, body, { timeoutMs, stream: false });

  try {
    return await res.json();
  } catch (error) {
    throw new BridgeError(`Réponse Groq invalide : ${error?.message || error}`, {
      status: 502,
      type: 'api_error',
      cause: error,
    });
  } finally {
    cleanup();
  }
}

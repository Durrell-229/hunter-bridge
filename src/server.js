import http from 'node:http';
import { Readable } from 'node:stream';
import { URL } from 'node:url';
import { asBridgeError, BridgeError } from './errors.js';
import { publicConfig } from './config.js';
import { requestUpstream } from './upstream.js';
import { parseSse, SseWriter } from './sse.js';
import {
  anthropicToGroq,
  estimateRequestTokens,
  groqToAnthropicMessage,
  streamGroqToAnthropic,
  synthesizeAnthropicStream,
} from './translate.js';
import { newId, redactSecrets, redactUrl } from './util.js';
import { SERVICE, VERSION } from './version.js';
import {
  beginRequest,
  closeRuntime,
  createRuntime,
  decide,
  finishRequest,
  noteAttempt,
  noteFailure,
  routeError,
  snapshot,
  apiModels,
} from './runtime.js';
import {
  checkProxyAuth,
  isAllowedHost,
  readJson,
  sendError,
  sendJson,
  sendText,
  SSE_HEADERS,
} from './http.js';
import { handleAdmin, handleDashboardAsset } from './dashboard.js';

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger(level = 'info') {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  const write = (kind, message) => {
    if (LOG_LEVELS[kind] <= threshold) {
      process.stderr.write(`[hunter] ${kind.toUpperCase()} ${message}\n`);
    }
  };
  return {
    error: (message) => write('error', message),
    warn: (message) => write('warn', message),
    info: (message) => write('info', message),
    debug: (message) => write('debug', message),
  };
}

export function createBridgeServer(config, options = {}) {
  const log = options.logger || createLogger(config.logLevel);
  const runtime =
    options.runtime ||
    createRuntime(config, {
      settings: options.settings,
      settingsPath: options.settingsPath,
      envPath: options.envPath,
      env: options.env,
      logger: log,
    });
  const startedAt = runtime.totals.startedAt;

  const server = http.createServer((req, res) => {
    handleRequest(req, res, config, log, startedAt, runtime).catch((error) => {
      const bridgeError = asBridgeError(error);
      if (bridgeError.clientAborted) return;
      if (res.headersSent) {
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.end();
          } catch {
            // ignore
          }
        }
        return;
      }
      sendError(res, bridgeError, res.getHeader('x-request-id'));
      log.warn(`${req.method} ${redactUrl(req.url)} → ${bridgeError.status}: ${redactSecrets(bridgeError.message)}`);
    });
  });

  server.runtime = runtime;
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 65000;
  server.timeout = 0;
  server.on('clientError', (error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });
  server.on('close', () => {
    if (!options.runtime) closeRuntime(runtime);
  });

  return server;
}

async function handleRequest(req, res, config, log, startedAt, runtime) {
  const requestId = newId('req_');
  res.setHeader('x-request-id', requestId);
  res.setHeader('request-id', requestId);
  const begin = Date.now();

  res.once('finish', () => {
    log.info(`${req.method} ${redactUrl(req.url)} → ${res.statusCode} (${Date.now() - begin} ms)`);
  });

  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    throw new BridgeError('URL invalide', { status: 400, type: 'invalid_request_error' });
  }

  if (!isAllowedHost(req, config)) {
    throw new BridgeError('En-tête Host non autorisé', {
      status: 403,
      type: 'permission_error',
    });
  }

  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { allow: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' });
    res.end();
    return;
  }

  if (path === '/api/hello' && req.method === 'HEAD') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end();
    return;
  }

  if (handleDashboardAsset(req, res, path)) return;

  if (path === '/health' && req.method === 'GET') {
    const pub = publicConfig(config);
    const configured = [...runtime.providers.values()].filter((provider) => provider.apiKey);
    sendJson(res, 200, {
      ok: true,
      service: SERVICE,
      version: VERSION,
      ...pub,
      keyConfigured: configured.length > 0,
      activeProfile: runtime.settings.routing.activeProfile,
      providers: [...runtime.providers.values()].map((provider) => ({
        id: provider.id,
        label: provider.label,
        enabled: provider.enabled,
        keyConfigured: Boolean(provider.apiKey),
        status: provider.lastStatus,
        models: provider.models.size,
      })),
      dashboard: '/dashboard',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
    return;
  }

  if (path === '/' && req.method === 'GET') {
    sendJson(res, 200, {
      service: SERVICE,
      version: VERSION,
      description:
        'Hunter Bridge — proxy local Anthropic Messages API vers Groq, OpenCode Zen, NVIDIA NIM et Gemini.',
      dashboard: '/dashboard',
      endpoints: [
        'POST /v1/messages',
        'POST /v1/messages/count_tokens',
        'GET /v1/models',
        'GET /health',
        'GET /dashboard',
        'GET /api/admin/state',
      ],
      ...publicConfig(config),
    });
    return;
  }

  if (path === '/api/admin' || path === '/api/events' || path.startsWith('/api/admin/')) {
    const handled = await handleAdmin(req, res, url, path, runtime, config);
    if (handled) return;
  }

  if (path === '/v1/messages' && req.method === 'POST') {
    await handleMessages(req, res, config, requestId, log, runtime);
    return;
  }

  if (path === '/v1/messages/count_tokens' && req.method === 'POST') {
    checkProxyAuth(req, config);
    const body = await readJson(req, config.bodyLimitBytes);
    const inputTokens = estimateRequestTokens(body);
    sendJson(res, 200, { input_tokens: inputTokens });
    return;
  }

  if (path === '/v1/models' && req.method === 'GET') {
    checkProxyAuth(req, config);
    const models = apiModels(runtime);
    sendJson(res, 200, {
      data: models,
      has_more: false,
      first_id: models[0]?.id || null,
      last_id: models[models.length - 1]?.id || null,
    });
    return;
  }

  if (path.startsWith('/v1/models/') && req.method === 'GET') {
    checkProxyAuth(req, config);
    const id = decodeURIComponent(path.slice('/v1/models/'.length));
    const model = apiModels(runtime).find((entry) => entry.id === id);
    if (!model) {
      throw new BridgeError(`Modèle inconnu : ${id}`, { status: 404, type: 'not_found_error' });
    }
    sendJson(res, 200, model);
    return;
  }

  throw new BridgeError(`Route inconnue : ${req.method} ${path}`, {
    status: 404,
    type: 'not_found_error',
  });
}

async function handleMessages(req, res, config, requestId, log, runtime) {
  checkProxyAuth(req, config);
  const body = await readJson(req, config.bodyLimitBytes);
  const routingBody = config.forceTarget ? { ...body, model: config.forceTarget } : body;
  const decision = decide(runtime, routingBody);
  if (!decision.candidates.length) throw routeError(runtime, decision);

  log.debug(
    `→ ${decision.profileId} ${decision.candidates.map((candidate) => candidate.target).join(' → ')} ` +
      `stream=${Boolean(body.stream)} tools=${body.tools?.length || 0} input≈${decision.inputTokens}`,
  );

  const record = beginRequest(runtime, { body, decision, requestId });
  const controller = new AbortController();
  let clientClosed = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
      controller.abort();
    }
  });

  let fetched = null;
  let selected = null;
  let meta = null;
  let firstError = null;
  for (const candidate of decision.candidates) {
    if (clientClosed) break;
    selected = candidate;
    noteAttempt(runtime, record, candidate);
    record.providerId = candidate.providerId;
    record.modelId = candidate.modelId;
    const routeConfig = {
      ...config,
      model: candidate.modelId,
      smallModel: candidate.modelId,
      maxOutputTokens: Math.min(
        Number(config.maxOutputTokens || 32768),
        Number(candidate.model.maxOutput || 32768),
      ),
    };
    let translated;
    try {
      translated = anthropicToGroq(body, routeConfig, {
        model: candidate.modelId,
        modelInfo: candidate.model,
        systemSuffix: decision.systemSuffix,
        providerId: candidate.providerId,
        profile: decision.profileId,
      });
    } catch (error) {
      if (!firstError) firstError = error;
      noteFailure(runtime, candidate, error);
      continue;
    }

    try {
      fetched = await requestUpstream(candidate.provider, translated.body, {
        signal: controller.signal,
        timeoutMs: translated.meta.upstreamStream
          ? config.streamTimeoutMs
          : config.requestTimeoutMs,
        stream: translated.meta.upstreamStream,
      });
      meta = translated.meta;
      break;
    } catch (error) {
      if (clientClosed) break;
      if (!firstError) firstError = error;
      noteFailure(runtime, candidate, error);
      log.warn(
        `Fallback ${candidate.target} → ${redactSecrets(error?.message || String(error))}`,
      );
    }
  }

  if (!fetched) {
    const error =
      firstError ||
      new BridgeError('Aucun fournisseur disponible', {
        status: 500,
        type: 'configuration_error',
      });
    finishRequest(runtime, record, {
      ok: false,
      providerId: selected?.providerId,
      modelId: selected?.modelId,
      error: error.message,
      status: error.status,
      retryAfter: error.retryAfter,
      skipProviderStats: true,
    });
    if (clientClosed) return;
    throw error;
  }

  record.providerId = selected.providerId;
  record.modelId = selected.modelId;
  res.setHeader('x-hunter-profile', decision.profileId);
  res.setHeader('x-hunter-provider', selected.providerId);
  res.setHeader('x-hunter-model', selected.modelId);
  res.setHeader('x-hunter-target', selected.target);
  res.setHeader('x-hunter-fallback', String(Math.max(0, record.attempts.length - 1)));

  const { res: upstream, cleanup } = fetched;
  try {
    const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
    const upstreamIsSse = meta.upstreamStream && contentType.includes('text/event-stream');

    if (upstreamIsSse) {
      res.writeHead(200, SSE_HEADERS);
      res.flushHeaders?.();
      res.socket?.setNoDelay?.(true);

      const writer = new SseWriter(res);
      const ping = setInterval(() => writer.event('ping', {}), 15000);
      ping.unref?.();

      try {
        const result = await streamGroqToAnthropic(
          parseSse(bodyToAsyncIterable(upstream.body)),
          writer,
          {
            ...meta,
            messageId: newId('msg_'),
          },
        );
        finishRequest(runtime, record, {
          ok: true,
          providerId: selected.providerId,
          modelId: selected.modelId,
          inputTokens: meta.inputTokens,
          outputTokens: result.usage?.output_tokens || 0,
        });
        log.debug(
          `← stream ${result.stopReason} tools=${result.toolCount} tokens_out=${result.usage.output_tokens}`,
        );
      } catch (error) {
        if (!clientClosed) {
          const bridgeError = asBridgeError(error);
          writer.event('error', {
            error: {
              type: bridgeError.type,
              message: redactSecrets(bridgeError.message),
            },
          });
          finishRequest(runtime, record, {
            ok: false,
            providerId: selected.providerId,
            modelId: selected.modelId,
            error: bridgeError.message,
            status: bridgeError.status,
          });
          log.warn(`Stream interrompu : ${redactSecrets(bridgeError.message)}`);
        }
      } finally {
        clearInterval(ping);
        writer.end();
      }
      return;
    }

    let json;
    try {
      json = await upstream.json();
    } catch (error) {
      throw new BridgeError(
        `Réponse ${selected.provider.label} invalide : ${error?.message || error}`,
        {
          status: 502,
          type: 'api_error',
          cause: error,
        },
      );
    }

    const message = groqToAnthropicMessage(json, {
      ...meta,
      messageId: newId('msg_'),
    });
    finishRequest(runtime, record, {
      ok: true,
      providerId: selected.providerId,
      modelId: selected.modelId,
      inputTokens: meta.inputTokens,
      outputTokens: message.usage?.output_tokens || 0,
    });

    if (meta.clientStream) {
      res.writeHead(200, SSE_HEADERS);
      res.flushHeaders?.();
      res.socket?.setNoDelay?.(true);
      const writer = new SseWriter(res);
      synthesizeAnthropicStream(message, writer);
      writer.end();
    } else {
      sendJson(res, 200, message);
    }
  } catch (error) {
    if (!record.finished) {
      const bridgeError = asBridgeError(error);
      finishRequest(runtime, record, {
        ok: false,
        providerId: selected.providerId,
        modelId: selected.modelId,
        error: bridgeError.message,
        status: bridgeError.status,
      });
    }
    throw error;
  } finally {
    cleanup();
  }
}

function bodyToAsyncIterable(body) {
  if (!body) {
    throw new BridgeError('Le fournisseur a renvoyé un corps de stream vide', {
      status: 502,
      type: 'api_error',
    });
  }
  if (typeof body[Symbol.asyncIterator] === 'function') return body;
  return Readable.fromWeb(body);
}

export function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

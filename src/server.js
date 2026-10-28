import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { URL } from 'node:url';
import { anthropicErrorBody, asBridgeError, BridgeError } from './errors.js';
import { publicConfig } from './config.js';
import { requestGroq } from './groq.js';
import { parseSse, SseWriter } from './sse.js';
import {
  anthropicToGroq,
  estimateRequestTokens,
  groqToAnthropicMessage,
  streamGroqToAnthropic,
  synthesizeAnthropicStream,
} from './translate.js';
import { hostnameOf, newId, redactSecrets } from './util.js';
import { SERVICE, VERSION } from './version.js';

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger(level = 'info') {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  const write = (kind, message) => {
    if (LOG_LEVELS[kind] <= threshold) {
      process.stderr.write(`[groqcc] ${kind.toUpperCase()} ${message}\n`);
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
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    handleRequest(req, res, config, log, startedAt).catch((error) => {
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
      log.warn(`${req.method} ${req.url} → ${bridgeError.status}: ${bridgeError.message}`);
    });
  });

  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 65000;
  server.timeout = 0;
  server.on('clientError', (error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });

  return server;
}

async function handleRequest(req, res, config, log, startedAt) {
  const requestId = newId('req_');
  res.setHeader('x-request-id', requestId);
  res.setHeader('request-id', requestId);
  const begin = Date.now();

  res.once('finish', () => {
    log.info(`${req.method} ${req.url} → ${res.statusCode} (${Date.now() - begin} ms)`);
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
    res.writeHead(204, { allow: 'GET, POST, OPTIONS' });
    res.end();
    return;
  }

  if (path === '/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      service: SERVICE,
      version: VERSION,
      ...publicConfig(config),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    });
    return;
  }

  if (path === '/' && req.method === 'GET') {
    sendJson(res, 200, {
      service: SERVICE,
      version: VERSION,
      description: 'Pont local Anthropic Messages API → Groq (OpenAI-compatible)',
      endpoints: ['POST /v1/messages', 'POST /v1/messages/count_tokens', 'GET /v1/models', 'GET /health'],
      ...publicConfig(config),
    });
    return;
  }

  if (path === '/v1/messages' && req.method === 'POST') {
    await handleMessages(req, res, config, requestId, log);
    return;
  }

  if (path === '/v1/messages/count_tokens' && req.method === 'POST') {
    checkAuth(req, config);
    const body = await readJson(req, config.bodyLimitBytes);
    const inputTokens = estimateRequestTokens(body);
    sendJson(res, 200, { input_tokens: inputTokens });
    return;
  }

  if (path === '/v1/models' && req.method === 'GET') {
    checkAuth(req, config);
    const models = listConfiguredModels(config);
    sendJson(res, 200, {
      data: models,
      has_more: false,
      first_id: models[0]?.id || null,
      last_id: models[models.length - 1]?.id || null,
    });
    return;
  }

  if (path.startsWith('/v1/models/') && req.method === 'GET') {
    checkAuth(req, config);
    const id = decodeURIComponent(path.slice('/v1/models/'.length));
    const model = listConfiguredModels(config).find((entry) => entry.id === id);
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

async function handleMessages(req, res, config, requestId, log) {
  checkAuth(req, config);

  if (!config.apiKey) {
    throw new BridgeError(
      'GROQ_API_KEY manquante. Renseigne-la dans .env ou dans l’environnement, puis relance le proxy.',
      { status: 500, type: 'configuration_error' },
    );
  }

  const body = await readJson(req, config.bodyLimitBytes);
  const { body: groqBody, meta } = anthropicToGroq(body, config);

  log.debug(
    `→ Groq ${meta.groqModel} stream=${meta.upstreamStream} messages=${groqBody.messages.length} tools=${groqBody.tools?.length || 0} max=${meta.maxTokens}`,
  );

  const controller = new AbortController();
  let clientClosed = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
      controller.abort();
    }
  });

  let fetched;
  try {
    fetched = await requestGroq(config, groqBody, {
      signal: controller.signal,
      timeoutMs: meta.upstreamStream ? config.streamTimeoutMs : config.requestTimeoutMs,
      stream: meta.upstreamStream,
    });
  } catch (error) {
    if (clientClosed) return;
    throw error;
  }

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
          log.warn(`Stream interrompu : ${bridgeError.message}`);
        }
      } finally {
        clearInterval(ping);
        writer.end();
      }
      return;
    }

    // Réponse complète (streaming désactivé ou provider qui ignore stream:true).
    let json;
    try {
      json = await upstream.json();
    } catch (error) {
      throw new BridgeError(`Réponse Groq invalide : ${error?.message || error}`, {
        status: 502,
        type: 'api_error',
        cause: error,
      });
    }

    const message = groqToAnthropicMessage(json, {
      ...meta,
      messageId: newId('msg_'),
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
  } finally {
    cleanup();
  }
}

function bodyToAsyncIterable(body) {
  if (!body) {
    throw new BridgeError('Groq a renvoyé un corps de stream vide', {
      status: 502,
      type: 'api_error',
    });
  }
  if (typeof body[Symbol.asyncIterator] === 'function') return body;
  return Readable.fromWeb(body);
}

function listConfiguredModels(config) {
  const seen = new Set();
  const models = [];
  // On expose à la fois les alias Claude Code et les vrais IDs Groq :
  // Claude Code peut ainsi valider ANTHROPIC_MODEL, et l'utilisateur peut
  // demander explicitement un modèle Groq.
  const ids = [
    config.claudeModel,
    config.claudeSmallModel,
    config.model,
    config.smallModel,
  ];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      type: 'model',
      id,
      display_name: id,
      created_at: '2025-01-01T00:00:00Z',
    });
  }
  return models;
}

function isAllowedHost(req, config) {
  if (!config.allowedHosts || config.allowedHosts.length === 0) return true;
  const host = hostnameOf(req.headers.host).toLowerCase();
  if (!host) return true;
  return config.allowedHosts.includes('*') || config.allowedHosts.includes(host);
}

function checkAuth(req, config) {
  if (!config.proxyApiKey) return;
  const tokens = extractTokens(req);
  if (!tokens.some((token) => safeEqual(token, config.proxyApiKey))) {
    throw new BridgeError('Jeton proxy invalide ou absent', {
      status: 401,
      type: 'authentication_error',
    });
  }
}

function extractTokens(req) {
  const tokens = [];
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey) tokens.push(apiKey);
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    tokens.push(authorization.slice('bearer '.length).trim());
  }
  return tokens;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        fail(
          new BridgeError(`Corps de requête trop volumineux (max ${limit} octets)`, {
            status: 413,
            type: 'request_too_large',
          }),
        );
        req.resume(); // draine sans mémoriser
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(
          new BridgeError('JSON invalide dans le corps de la requête', {
            status: 400,
            type: 'invalid_request_error',
          }),
        );
      }
    });

    req.on('error', (error) => {
      fail(
        new BridgeError(`Erreur de lecture de la requête : ${error?.message || error}`, {
          status: 400,
          type: 'invalid_request_error',
          cause: error,
        }),
      );
    });

    req.on('aborted', () => {
      fail(
        new BridgeError('Requête interrompue par le client', {
          status: 400,
          type: 'invalid_request_error',
        }),
      );
    });
  });
}

function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, error, requestId) {
  const bridgeError = asBridgeError(error);
  if (bridgeError.clientAborted) return;
  if (res.headersSent || res.writableEnded || res.destroyed) {
    if (!res.writableEnded && !res.destroyed) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    return;
  }

  const body = anthropicErrorBody(bridgeError, requestId);
  body.error.message = redactSecrets(body.error.message);
  if (bridgeError.retryAfter != null) {
    res.setHeader('retry-after', String(Math.max(0, Math.ceil(bridgeError.retryAfter))));
  }
  sendJson(res, bridgeError.status, body);
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

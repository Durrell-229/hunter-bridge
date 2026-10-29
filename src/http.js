import crypto from 'node:crypto';
import { anthropicErrorBody, asBridgeError, BridgeError } from './errors.js';
import { hostnameOf, redactSecrets } from './util.js';

export const SSE_HEADERS = Object.freeze({
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
});

export function extractTokens(req) {
  const tokens = [];
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey) tokens.push(apiKey);
  const admin = req.headers['x-hunter-admin'];
  if (typeof admin === 'string' && admin) tokens.push(admin);
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    tokens.push(authorization.slice('bearer '.length).trim());
  }
  return tokens;
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function checkProxyAuth(req, config) {
  if (!config.proxyApiKey) return;
  const tokens = extractTokens(req);
  if (!tokens.some((token) => safeEqual(token, config.proxyApiKey))) {
    throw new BridgeError('Jeton proxy invalide ou absent', {
      status: 401,
      type: 'authentication_error',
    });
  }
}

export function isAllowedHost(req, config) {
  if (!config.allowedHosts || config.allowedHosts.length === 0) return true;
  const host = hostnameOf(req.headers.host).toLowerCase();
  if (!host) return true;
  return config.allowedHosts.includes('*') || config.allowedHosts.includes(host);
}

export function isLoopback(req) {
  const raw = String(req.socket?.remoteAddress || '').toLowerCase();
  return (
    raw === '127.0.0.1' ||
    raw === '::1' ||
    raw === '::ffff:127.0.0.1' ||
    raw === 'localhost'
  );
}

/**
 * Admin local : jeton explicite si configuré, sinon accès limité à la
 * loopback. Le token peut venir du header ou du query pour EventSource.
 */
export function checkAdminAuth(req, url, config) {
  if (config.adminToken) {
    const tokens = extractTokens(req);
    const query = url?.searchParams?.get('token');
    if (query) tokens.push(query);
    if (tokens.some((token) => safeEqual(token, config.adminToken))) return true;
    throw new BridgeError('Jeton administrateur invalide ou absent', {
      status: 401,
      type: 'authentication_error',
    });
  }
  if (!isLoopback(req)) {
    throw new BridgeError(
      'Dashboard administrateur accessible uniquement en local. Définis HUNTER_ADMIN_TOKEN pour un accès distant.',
      { status: 403, type: 'permission_error' },
    );
  }
  return true;
}

export function adminAuthRequired(config) {
  return Boolean(config.adminToken);
}

export function readJson(req, limit) {
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
        req.resume();
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

export function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(res, error, requestId) {
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

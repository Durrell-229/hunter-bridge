import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeError } from './errors.js';
import {
  checkAdminAuth,
  readJson,
  sendJson,
  sendText,
  SSE_HEADERS,
} from './http.js';
import { buildClaudeMcpConfig } from './mcp.js';
import {
  deleteMcp,
  reload,
  refreshProviderModels,
  setProviderKey,
  snapshot,
  testProvider,
  updateMcp,
  updatePluginPaths,
  updateProvider,
  updateRouting,
} from './runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '..', 'public');
const assets = new Map([
  ['/dashboard', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/dashboard/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/dashboard/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
  ['/dashboard/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);

export function handleDashboardAsset(req, res, pathname) {
  const asset = assets.get(pathname);
  if (!asset || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  try {
    const body = fs.readFileSync(path.join(publicDir, asset.file));
    res.writeHead(200, {
      'content-type': asset.type,
      'cache-control': 'no-cache',
      'content-length': body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    sendText(res, 500, `Dashboard indisponible : ${error.message}`);
  }
  return true;
}

export async function handleAdmin(req, res, url, pathname, runtime, config) {
  if (!pathname.startsWith('/api/admin') && pathname !== '/api/events') return false;
  checkAdminAuth(req, url, config);

  if (pathname === '/api/admin/state' && req.method === 'GET') {
    sendJson(res, 200, snapshot(runtime));
    return true;
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    streamEvents(req, res, runtime);
    return true;
  }

  if (pathname === '/api/admin/reload' && req.method === 'POST') {
    sendJson(res, 200, reload(runtime));
    return true;
  }

  if (pathname === '/api/admin/routing' && req.method === 'PATCH') {
    const body = await readJson(req, config.bodyLimitBytes);
    sendJson(res, 200, updateRouting(runtime, body));
    return true;
  }

  if (pathname === '/api/admin/plugins' && req.method === 'PUT') {
    const body = await readJson(req, config.bodyLimitBytes);
    const paths = Array.isArray(body?.paths) ? body.paths : [];
    sendJson(res, 200, updatePluginPaths(runtime, paths));
    return true;
  }

  if (pathname === '/api/admin/mcp/export' && req.method === 'GET') {
    const configFile = buildClaudeMcpConfig(runtime.settings.mcp?.servers || []);
    const text = `${JSON.stringify(configFile, null, 2)}\n`;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="mcp.json"',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
    return true;
  }

  const providerMatch = pathname.match(/^\/api\/admin\/providers\/([^/]+)(?:\/(key|test|refresh))?$/);
  if (providerMatch) {
    const providerId = decodeURIComponent(providerMatch[1]);
    const action = providerMatch[2] || '';
    if (action === 'key' && req.method === 'PUT') {
      const body = await readJson(req, config.bodyLimitBytes);
      sendJson(res, 200, setProviderKey(runtime, providerId, body?.key || ''));
      return true;
    }
    if (action === 'test' && req.method === 'POST') {
      sendJson(res, 200, await testProvider(runtime, providerId));
      return true;
    }
    if (action === 'refresh' && req.method === 'POST') {
      try {
        const result = await refreshProviderModels(runtime, providerId);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: error?.message || String(error) });
      }
      return true;
    }
    if (!action && req.method === 'PATCH') {
      const body = await readJson(req, config.bodyLimitBytes);
      sendJson(res, 200, updateProvider(runtime, providerId, body));
      return true;
    }
  }

  const mcpMatch = pathname.match(/^\/api\/admin\/mcp\/([^/]+)$/);
  if (mcpMatch) {
    const name = decodeURIComponent(mcpMatch[1]);
    if (req.method === 'PUT') {
      const body = await readJson(req, config.bodyLimitBytes);
      const nextName = String(body?.name || name);
      if (nextName !== name) deleteMcp(runtime, name);
      sendJson(res, 200, updateMcp(runtime, { ...body, name: nextName }));
      return true;
    }
    if (req.method === 'DELETE') {
      sendJson(res, 200, deleteMcp(runtime, name));
      return true;
    }
  }

  throw new BridgeError(`Route admin inconnue : ${req.method} ${pathname}`, {
    status: 404,
    type: 'not_found_error',
  });
}

function streamEvents(req, res, runtime) {
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders?.();
  res.socket?.setNoDelay?.(true);
  const send = (payload) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  send(snapshot(runtime));
  const onUpdate = (payload) => send(payload);
  runtime.events.on('update', onUpdate);
  const ping = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, 15000);
  ping.unref?.();
  const cleanup = () => {
    clearInterval(ping);
    runtime.events.off('update', onUpdate);
  };
  req.once('close', cleanup);
  res.once('close', cleanup);
}

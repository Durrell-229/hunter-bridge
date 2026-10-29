import test from 'node:test';
import assert from 'node:assert/strict';
import { closeServer, createBridgeServer, listen } from '../src/server.js';

const silentLogger = { error() {}, warn() {}, info() {}, debug() {} };

function baseConfig(extra = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    groqBaseUrl: 'http://127.0.0.1:9/openai/v1',
    apiKey: 'test-key',
    proxyApiKey: '',
    model: 'openai/gpt-oss-120b',
    smallModel: 'openai/gpt-oss-20b',
    maxOutputTokens: 32768,
    requestTimeoutMs: 1000,
    streamTimeoutMs: 1000,
    bodyLimitBytes: 1024 * 1024,
    retries: 0,
    logLevel: 'error',
    streaming: true,
    allowedHosts: ['127.0.0.1', 'localhost', '::1'],
    claudeModel: 'claude-sonnet-4-5',
    claudeSmallModel: 'claude-3-5-haiku-latest',
    adminToken: '',
    ...extra,
  };
}

async function harness(t, extra = {}) {
  const server = createBridgeServer(baseConfig(extra), { logger: silentLogger });
  const address = await listen(server, '127.0.0.1', 0);
  t.after(() => closeServer(server));
  return { base: `http://127.0.0.1:${address.port}`, server };
}

test('dashboard : page statique et état admin sans fuite de clé', async (t) => {
  const { base } = await harness(t);
  const page = await fetch(`${base}/dashboard`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Hunter Bridge/);

  const state = await fetch(`${base}/api/admin/state`);
  assert.equal(state.status, 200);
  const json = await state.json();
  assert.equal(json.service, 'Hunter Bridge');
  assert.ok(json.providers.length >= 1);
  assert.equal(JSON.stringify(json).includes('test-key'), false);
});

test('dashboard : une URL de dashboard concaténée est redirigée', async (t) => {
  const { base } = await harness(t);
  const malformed = await fetch(`${base}/dashboard${base}/dashboard`, { redirect: 'manual' });
  assert.equal(malformed.status, 302);
  assert.equal(malformed.headers.get('location'), '/dashboard');
  const page = await fetch(`${base}/dashboard`);
  assert.equal(page.status, 200);
});

test('dashboard : HUNTER_ADMIN_TOKEN protège les routes admin', async (t) => {
  const { base } = await harness(t, { adminToken: 'secret-admin' });
  const denied = await fetch(`${base}/api/admin/state`);
  assert.equal(denied.status, 401);

  const allowed = await fetch(`${base}/api/admin/state`, {
    headers: { authorization: 'Bearer secret-admin' },
  });
  assert.equal(allowed.status, 200);
});

test('dashboard : changement de profil, mapping Claude et CRUD MCP', async (t) => {
  const { base } = await harness(t);
  const routing = await fetch(`${base}/api/admin/routing`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ activeProfile: 'ctf' }),
  });
  assert.equal(routing.status, 200);
  assert.equal((await routing.json()).activeProfile, 'ctf');

  const mapping = await fetch(`${base}/api/admin/routing`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      claudeModels: { sonnet: 'groq/openai/gpt-oss-120b', haiku: '' },
    }),
  });
  assert.equal(mapping.status, 200);
  const mapped = await mapping.json();
  assert.equal(mapped.routing.claudeModels.sonnet, 'groq/openai/gpt-oss-120b');
  assert.equal(mapped.routing.claudeModels.haiku, '');

  const put = await fetch(`${base}/api/admin/mcp/demo`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'demo',
      type: 'stdio',
      command: 'echo',
      args: ['ok'],
      env: { TOKEN: '${DEMO_TOKEN}' },
    }),
  });
  assert.equal(put.status, 200);
  const afterPut = await put.json();
  assert.equal(afterPut.mcp.servers.length, 1);
  assert.equal(afterPut.mcp.servers[0].env.TOKEN, '${DEMO_TOKEN}');

  const del = await fetch(`${base}/api/admin/mcp/demo`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).mcp.servers.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridgeServer, closeServer, listen } from '../src/server.js';
import { createRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { buildConfig } from '../src/config.js';

const silentLogger = { error() {}, warn() {}, info() {}, debug() {} };

function providerServer(handler) {
  const state = { calls: 0, lastBody: null, lastHeaders: null };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      state.calls += 1;
      try {
        state.lastBody = raw ? JSON.parse(raw) : null;
      } catch {
        state.lastBody = raw;
      }
      state.lastHeaders = req.headers;
      handler(req, res, state);
    });
  });
  return { server, state };
}

async function multiProviderHarness(t) {
  const a = providerServer((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
    res.end(JSON.stringify({ error: { message: 'rate limited' } }));
  });
  const b = providerServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          { message: { role: 'assistant', content: 'depuis B' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      }),
    );
  });
  const aAddress = await listen(a.server, '127.0.0.1', 0);
  const bAddress = await listen(b.server, '127.0.0.1', 0);

  const settings = defaultSettings();
  settings.providers = {
    alpha: {
      label: 'Alpha',
      type: 'openai',
      enabled: true,
      baseUrl: `http://127.0.0.1:${aAddress.port}/v1`,
      apiKeyEnv: 'ALPHA_API_KEY',
      maxTokensField: 'max_completion_tokens',
      retries: 0,
      models: {
        'model-a': { label: 'Model A', context: 131072, maxOutput: 8192, tools: true },
      },
    },
    beta: {
      label: 'Beta',
      type: 'openai',
      enabled: true,
      baseUrl: `http://127.0.0.1:${bAddress.port}/v1`,
      apiKeyEnv: 'BETA_API_KEY',
      maxTokensField: 'max_tokens',
      streamUsage: false,
      retries: 0,
      models: {
        'model-b': { label: 'Model B', context: 131072, maxOutput: 8192, tools: true },
      },
    },
  };
  settings.routing.activeProfile = 'fallback';
  settings.routing.profiles = {
    fallback: {
      label: 'Fallback',
      chain: ['alpha/model-a', 'beta/model-b'],
      suffix: 'Test de repli.',
      keywords: [],
    },
    auto: { label: 'Auto', chain: ['beta/model-b'], suffix: '', keywords: [] },
  };
  const config = buildConfig({}, { maxOutputTokens: 4096, requestTimeoutMs: 5000, streamTimeoutMs: 5000 });
  const runtime = createRuntime(config, {
    settings,
    env: { ALPHA_API_KEY: 'alpha-key', BETA_API_KEY: 'beta-key' },
    logger: silentLogger,
  });
  const bridge = createBridgeServer(config, { runtime, logger: silentLogger });
  const bridgeAddress = await listen(bridge, '127.0.0.1', 0);

  t.after(async () => {
    await closeServer(bridge);
    await closeServer(a.server);
    await closeServer(b.server);
  });

  return { base: `http://127.0.0.1:${bridgeAddress.port}`, a, b, runtime };
}

test('routage multi-fournisseurs : 429 sur A puis succès sur B', async (t) => {
  const harness = await multiProviderHarness(t);
  const res = await fetch(`${harness.base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: 'Bonjour' }],
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-hunter-provider'), 'beta');
  assert.equal(res.headers.get('x-hunter-fallback'), '1');
  const json = await res.json();
  assert.deepEqual(json.content, [{ type: 'text', text: 'depuis B' }]);

  assert.equal(harness.a.state.calls, 1);
  assert.equal(harness.b.state.calls, 1);
  assert.equal(harness.a.state.lastHeaders.authorization, 'Bearer alpha-key');
  assert.equal(harness.b.state.lastHeaders.authorization, 'Bearer beta-key');
  // L'adaptateur Beta doit avoir renommé max_completion_tokens en max_tokens.
  assert.equal(harness.b.state.lastBody.max_tokens, 512);
  assert.equal(harness.b.state.lastBody.max_completion_tokens, undefined);
  assert.ok(harness.runtime.providers.get('alpha').cooldownUntil > Date.now());
});

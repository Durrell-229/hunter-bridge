import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { closeServer, createBridgeServer, listen } from '../src/server.js';

const silentLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
};

function createMockGroq() {
  const state = {
    mode: 'text',
    lastRequest: null,
    lastHeaders: null,
    calls: 0,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      state.calls += 1;

      if (req.url === '/openai/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'openai/gpt-oss-120b', object: 'model' },
              { id: 'openai/gpt-oss-20b', object: 'model' },
            ],
          }),
        );
        return;
      }

      if (!req.url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        // ignore
      }
      state.lastRequest = body;
      state.lastHeaders = req.headers;

      if (state.mode === '429') {
        res.writeHead(429, {
          'content-type': 'application/json',
          'retry-after': '1',
        });
        res.end(JSON.stringify({ error: { message: 'Rate limit reached' } }));
        return;
      }

      if (state.mode === 'fallback-max-tokens' && body.max_completion_tokens) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'Unsupported parameter: max_completion_tokens' },
          }),
        );
        return;
      }

      if (state.mode === 'stream-error') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"error":{"message":"boom upstream"}}\n\n');
        res.end();
        return;
      }

      if (state.mode === 'json-when-stream') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Hello JSON' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
        );
        return;
      }

      if (body.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });

        if (state.mode === 'tools') {
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { role: 'assistant', content: 'Je vais lire.' } }],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_1',
                        function: { name: 'Read', arguments: '{"file_path":' },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }],
                  },
                },
              ],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 20, completion_tokens: 10 },
            })}\n\n`,
          );
        } else {
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { role: 'assistant', content: 'Hello' } }],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: ' from Groq' } }],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 12, completion_tokens: 5 },
            })}\n\n`,
          );
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (state.mode === 'tools') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'Read', arguments: '{"file_path":"a.txt"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
          }),
        );
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: 'Hello JSON' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      );
    });
  });

  return { server, state };
}

async function createHarness(t, options = {}) {
  const {
    mode = 'text',
    proxyApiKey = '',
    apiKey = 'test-key',
    streaming = true,
    bodyLimitBytes = 1024 * 1024,
  } = options;

  const mock = createMockGroq();
  mock.state.mode = mode;
  const mockAddress = await listen(mock.server, '127.0.0.1', 0);

  const config = {
    host: '127.0.0.1',
    port: 0,
    groqBaseUrl: `http://127.0.0.1:${mockAddress.port}/openai/v1`,
    apiKey,
    proxyApiKey,
    model: 'openai/gpt-oss-120b',
    smallModel: 'openai/gpt-oss-20b',
    maxOutputTokens: 32768,
    requestTimeoutMs: 5000,
    streamTimeoutMs: 5000,
    bodyLimitBytes,
    retries: 0,
    logLevel: 'error',
    streaming,
    allowedHosts: ['127.0.0.1', 'localhost', '::1'],
    claudeModel: 'claude-sonnet-4-5',
    claudeSmallModel: 'claude-3-5-haiku-latest',
  };

  const bridge = createBridgeServer(config, { logger: silentLogger });
  const bridgeAddress = await listen(bridge, '127.0.0.1', 0);

  t.after(async () => {
    await closeServer(bridge);
    await closeServer(mock.server);
  });

  return {
    base: `http://127.0.0.1:${bridgeAddress.port}`,
    state: mock.state,
    config,
  };
}

function parseSseEvents(text) {
  return text
    .split('\n\n')
    .filter((raw) => raw.trim())
    .map((raw) => {
      const lines = raw.split('\n');
      const event = lines
        .find((line) => line.startsWith('event:'))
        ?.slice('event:'.length)
        .trim();
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n');
      return { event, data: data ? JSON.parse(data) : null };
    });
}

function postMessages(harness, body, headers = {}) {
  return fetch(`${harness.base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'dummy-anthropic-key',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test('stream : traduit la requête et le flux Groq en SSE Anthropic', async (t) => {
  const harness = await createHarness(t, { mode: 'text' });

  const res = await postMessages(harness, {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    stream: true,
    system: [{ type: 'text', text: 'Tu es utile.' }],
    messages: [{ role: 'user', content: 'Bonjour' }],
    tools: [
      {
        name: 'Read',
        description: 'Lit un fichier',
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
      },
    ],
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const events = parseSseEvents(await res.text());
  assert.equal(events[0].event, 'message_start');
  assert.equal(events[0].data.message.model, 'claude-sonnet-4-5');
  assert.equal(events[events.length - 1].event, 'message_stop');

  const text = events
    .filter((event) => event.event === 'content_block_delta')
    .map((event) => event.data.delta.text || '')
    .join('');
  assert.equal(text, 'Hello from Groq');

  const messageDelta = events.find((event) => event.event === 'message_delta');
  assert.equal(messageDelta.data.delta.stop_reason, 'end_turn');
  assert.equal(messageDelta.data.usage.output_tokens, 5);

  assert.equal(harness.state.lastRequest.model, 'openai/gpt-oss-120b');
  assert.equal(harness.state.lastRequest.stream, true);
  assert.deepEqual(harness.state.lastRequest.stream_options, { include_usage: true });
  assert.equal(harness.state.lastRequest.messages[0].role, 'system');
  assert.equal(harness.state.lastRequest.messages[1].content, 'Bonjour');
  assert.equal(harness.state.lastRequest.tools[0].function.name, 'Read');
  assert.equal(harness.state.lastHeaders.authorization, 'Bearer test-key');
});

test('non-stream : renvoie un message Anthropic JSON', async (t) => {
  const harness = await createHarness(t, { mode: 'text' });

  const res = await postMessages(harness, {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    stream: false,
    messages: [{ role: 'user', content: 'Bonjour' }],
  });

  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.type, 'message');
  assert.equal(json.role, 'assistant');
  assert.deepEqual(json.content, [{ type: 'text', text: 'Hello JSON' }]);
  assert.equal(json.stop_reason, 'end_turn');
  assert.equal(json.usage.input_tokens, 3);
  assert.equal(json.usage.output_tokens, 2);
  assert.equal(harness.state.lastRequest.stream, undefined);
});

test('stream : traduit les tool_calls Groq en tool_use Anthropic', async (t) => {
  const harness = await createHarness(t, { mode: 'tools' });

  const res = await postMessages(harness, {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    stream: true,
    messages: [{ role: 'user', content: 'Lis a.txt' }],
  });

  assert.equal(res.status, 200);
  const events = parseSseEvents(await res.text());
  const toolStart = events.find(
    (event) => event.event === 'content_block_start' && event.data.content_block.type === 'tool_use',
  );
  assert.ok(toolStart);
  assert.equal(toolStart.data.content_block.name, 'Read');
  assert.equal(toolStart.data.content_block.id, 'call_1');

  const inputDelta = events.find(
    (event) =>
      event.event === 'content_block_delta' && event.data.delta.type === 'input_json_delta',
  );
  assert.deepEqual(JSON.parse(inputDelta.data.delta.partial_json), { file_path: 'a.txt' });

  const messageDelta = events.find((event) => event.event === 'message_delta');
  assert.equal(messageDelta.data.delta.stop_reason, 'tool_use');
  assert.equal(messageDelta.data.usage.output_tokens, 10);
});

test('STREAMING=0 : synthétise un flux SSE depuis une réponse complète', async (t) => {
  const harness = await createHarness(t, { mode: 'text', streaming: false });

  const res = await postMessages(harness, {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    stream: true,
    messages: [{ role: 'user', content: 'Bonjour' }],
  });

  assert.equal(res.status, 200);
  const events = parseSseEvents(await res.text());
  assert.equal(events[0].event, 'message_start');
  const text = events
    .filter((event) => event.event === 'content_block_delta')
    .map((event) => event.data.delta.text || '')
    .join('');
  assert.equal(text, 'Hello JSON');
  assert.equal(harness.state.lastRequest.stream, undefined);
});

test('un provider qui ignore stream:true est synthétisé en SSE', async (t) => {
  const harness = await createHarness(t, { mode: 'json-when-stream' });

  const res = await postMessages(harness, {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    stream: true,
    messages: [{ role: 'user', content: 'Bonjour' }],
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /Hello JSON/);
  assert.match(text, /event: message_stop/);
});

test('fallback : réessaie avec max_tokens si max_completion_tokens est refusé', async (t) => {
  const harness = await createHarness(t, { mode: 'fallback-max-tokens' });

  const res = await postMessages(harness, {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    stream: true,
    messages: [{ role: 'user', content: 'Bonjour' }],
  });

  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: message_stop/);
  assert.equal(harness.state.calls, 2);
  assert.equal(harness.state.lastRequest.max_tokens, 1024);
  assert.equal(harness.state.lastRequest.max_completion_tokens, undefined);
});

test('erreur Groq 429 : renvoie une erreur Anthropic et retry-after', async (t) => {
  const harness = await createHarness(t, { mode: '429' });

  const res = await postMessages(harness, {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    stream: true,
    messages: [{ role: 'user', content: 'Bonjour' }],
  });

  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '1');
  const json = await res.json();
  assert.equal(json.type, 'error');
  assert.equal(json.error.type, 'rate_limit_error');
  assert.match(json.error.message, /Rate limit/);
});

test('erreur pendant le stream : envoie un événement error SSE', async (t) => {
  const harness = await createHarness(t, { mode: 'stream-error' });

  const res = await postMessages(harness, {
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    stream: true,
    messages: [{ role: 'user', content: 'Bonjour' }],
  });

  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /event: error/);
  assert.match(text, /boom upstream/);
  assert.match(text, /"type":"api_error"/);
});

test('auth proxy : refuse sans jeton et accepte x-api-key / Bearer', async (t) => {
  const harness = await createHarness(t, { proxyApiKey: 'secret-token' });

  const denied = await postMessages(harness, {
    model: 'claude-sonnet-4-5',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Bonjour' }],
  });
  assert.equal(denied.status, 401);
  const deniedJson = await denied.json();
  assert.equal(deniedJson.error.type, 'authentication_error');

  const withApiKey = await postMessages(
    harness,
    {
      model: 'claude-sonnet-4-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Bonjour' }],
    },
    { 'x-api-key': 'secret-token' },
  );
  assert.equal(withApiKey.status, 200);

  const withBearer = await postMessages(
    harness,
    {
      model: 'claude-sonnet-4-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Bonjour' }],
    },
    { authorization: 'Bearer secret-token' },
  );
  assert.equal(withBearer.status, 200);
});

test('clé Groq absente : erreur 500 configuration_error', async (t) => {
  const harness = await createHarness(t, { apiKey: '' });

  const res = await postMessages(harness, {
    model: 'claude-sonnet-4-5',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Bonjour' }],
  });

  assert.equal(res.status, 500);
  const json = await res.json();
  assert.equal(json.error.type, 'configuration_error');
  assert.match(json.error.message, /GROQ_API_KEY/);
});

test('health, models et count_tokens', async (t) => {
  const harness = await createHarness(t);

  const health = await fetch(`${harness.base}/health`);
  assert.equal(health.status, 200);
  const healthJson = await health.json();
  assert.equal(healthJson.ok, true);
  assert.equal(healthJson.keyConfigured, true);
  assert.equal(JSON.stringify(healthJson).includes('test-key'), false);

  const models = await fetch(`${harness.base}/v1/models`);
  assert.equal(models.status, 200);
  const modelsJson = await models.json();
  const modelIds = modelsJson.data.map((entry) => entry.id);
  assert.ok(modelIds.includes('claude-sonnet-4-5'));
  assert.ok(modelIds.includes('claude-3-5-haiku-latest'));
  assert.ok(modelIds.includes('openai/gpt-oss-120b'));
  assert.ok(modelIds.includes('openai/gpt-oss-20b'));

  const model = await fetch(`${harness.base}/v1/models/openai%2Fgpt-oss-20b`);
  assert.equal(model.status, 200);
  assert.equal((await model.json()).id, 'openai/gpt-oss-20b');

  const alias = await fetch(`${harness.base}/v1/models/claude-sonnet-4-5`);
  assert.equal(alias.status, 200);
  assert.equal((await alias.json()).id, 'claude-sonnet-4-5');

  const missing = await fetch(`${harness.base}/v1/models/inconnu`);
  assert.equal(missing.status, 404);

  const count = await fetch(`${harness.base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'dummy' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'Bonjour, ceci est un test.' }],
    }),
  });
  assert.equal(count.status, 200);
  const countJson = await count.json();
  assert.equal(Number.isInteger(countJson.input_tokens), true);
  assert.ok(countJson.input_tokens > 0);
});

test('corps trop volumineux : 413 request_too_large', async (t) => {
  const harness = await createHarness(t, { bodyLimitBytes: 32 });

  const res = await postMessages(harness, {
    model: 'claude-sonnet-4-5',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Ce message dépasse largement la limite.' }],
  });

  assert.equal(res.status, 413);
  const json = await res.json();
  assert.equal(json.error.type, 'request_too_large');
});

test('Host non autorisé : 403', async (t) => {
  const harness = await createHarness(t);
  harness.config.allowedHosts = ['example.test'];

  const res = await fetch(`${harness.base}/health`);
  assert.equal(res.status, 403);
});

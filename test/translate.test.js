import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicToGroq,
  convertMessages,
  convertToolChoice,
  convertTools,
  groqToAnthropicMessage,
  mapStopReason,
  parseToolArguments,
  streamGroqToAnthropic,
  systemToText,
} from '../src/translate.js';

const config = {
  model: 'openai/gpt-oss-120b',
  smallModel: 'openai/gpt-oss-20b',
  maxOutputTokens: 32768,
  streaming: true,
};

test('systemToText accepte une chaîne et un tableau de blocs', () => {
  assert.equal(systemToText('Tu es utile.'), 'Tu es utile.');
  assert.equal(
    systemToText([
      { type: 'text', text: 'Premier' },
      { type: 'text', text: 'Second', cache_control: { type: 'ephemeral' } },
    ]),
    'Premier\n\nSecond',
  );
});

test('convertMessages traduit texte user/assistant', () => {
  const messages = convertMessages([
    { role: 'user', content: 'Bonjour' },
    { role: 'assistant', content: [{ type: 'text', text: 'Salut' }] },
  ]);
  assert.deepEqual(messages, [
    { role: 'user', content: 'Bonjour' },
    { role: 'assistant', content: 'Salut' },
  ]);
});

test('convertMessages fusionne les blocs texte user en une chaîne', () => {
  const messages = convertMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Premier bloc' },
        { type: 'text', text: 'Second bloc' },
      ],
    },
  ]);
  assert.deepEqual(messages, [{ role: 'user', content: 'Premier bloc\n\nSecond bloc' }]);
});

test('convertMessages traduit tool_use puis tool_result en tool_calls/tool', () => {
  const messages = convertMessages([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Je lis le fichier.' },
        {
          type: 'tool_use',
          id: 'toolu_123',
          name: 'Read',
          input: { file_path: 'a.txt' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_123', content: 'contenu du fichier' },
        { type: 'text', text: 'Continue.' },
      ],
    },
  ]);

  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, 'assistant');
  assert.equal(messages[0].content, 'Je lis le fichier.');
  assert.equal(messages[0].tool_calls[0].id, 'toolu_123');
  assert.equal(messages[0].tool_calls[0].function.name, 'Read');
  assert.deepEqual(JSON.parse(messages[0].tool_calls[0].function.arguments), {
    file_path: 'a.txt',
  });
  assert.deepEqual(messages[1], {
    role: 'tool',
    tool_call_id: 'toolu_123',
    content: 'contenu du fichier',
  });
  assert.deepEqual(messages[2], { role: 'user', content: 'Continue.' });
});

test('convertMessages marque les erreurs d’outil et gère plusieurs résultats', () => {
  const messages = convertMessages([
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'false' } },
        { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'x' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'boom', is_error: true },
        { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'ok' }] },
      ],
    },
  ]);

  assert.equal(messages[0].tool_calls.length, 2);
  assert.equal(messages[1].tool_call_id, 'a');
  assert.match(messages[1].content, /^\[tool_error\]/);
  assert.equal(messages[2].tool_call_id, 'b');
  assert.equal(messages[2].content, 'ok');
});

test('convertMessages remplace un tool_result vide par un marqueur', () => {
  const messages = convertMessages([
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'true' } }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'x', content: '' }],
    },
  ]);
  assert.equal(messages[1].role, 'tool');
  assert.equal(messages[1].content, '[empty tool result]');
});

test('convertMessages traduit les images base64 en image_url', () => {
  const messages = convertMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Regarde' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
      ],
    },
  ]);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content[0].text, 'Regarde');
  assert.equal(messages[0].content[1].type, 'image_url');
  assert.equal(messages[0].content[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('convertTools expose les outils custom et ignore les outils serveur', () => {
  const tools = convertTools([
    {
      name: 'Read',
      description: 'Lit un fichier',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
    },
    { type: 'web_search_20250305', name: 'web_search' },
  ]);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'Read');
  assert.equal(tools[0].function.parameters.properties.file_path.type, 'string');
});

test('convertTools normalise les schémas et retire $schema', () => {
  const tools = convertTools([
    {
      name: 'A',
      input_schema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {},
      },
    },
    { name: 'B', input_schema: {} },
  ]);
  assert.equal(tools[0].function.parameters.$schema, undefined);
  assert.deepEqual(tools[1].function.parameters, { type: 'object', properties: {} });
});

test('convertToolChoice traduit auto/any/tool/none', () => {
  assert.equal(convertToolChoice({ type: 'auto' }), 'auto');
  assert.equal(convertToolChoice({ type: 'any' }), 'required');
  assert.equal(convertToolChoice({ type: 'none' }), 'none');
  assert.deepEqual(convertToolChoice({ type: 'tool', name: 'Read' }), {
    type: 'function',
    function: { name: 'Read' },
  });
});

test('anthropicToGroq mappe les modèles Claude vers Groq', () => {
  const base = {
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Bonjour' }],
  };

  const sonnet = anthropicToGroq({ ...base, model: 'claude-sonnet-4-5-20250929' }, config);
  assert.equal(sonnet.body.model, 'openai/gpt-oss-120b');

  const haiku = anthropicToGroq({ ...base, model: 'claude-3-5-haiku-20241022' }, config);
  assert.equal(haiku.body.model, 'openai/gpt-oss-20b');

  const explicit = anthropicToGroq({ ...base, model: 'openai/gpt-oss-20b' }, config);
  assert.equal(explicit.body.model, 'openai/gpt-oss-20b');

  const prefixed = anthropicToGroq({ ...base, model: 'groq/llama-3.3-70b-versatile' }, config);
  assert.equal(prefixed.body.model, 'llama-3.3-70b-versatile');
});

test('anthropicToGroq borne max_tokens et active le stream', () => {
  const result = anthropicToGroq(
    {
      model: 'claude-sonnet-4-5',
      max_tokens: 999999,
      stream: true,
      system: 'Tu es un assistant.',
      messages: [{ role: 'user', content: 'Bonjour' }],
      tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'any' },
      temperature: 3,
      stop_sequences: ['STOP'],
    },
    config,
  );

  assert.equal(result.body.max_completion_tokens, 32768);
  assert.equal(result.body.stream, true);
  assert.deepEqual(result.body.stream_options, { include_usage: true });
  assert.equal(result.body.temperature, 2);
  assert.deepEqual(result.body.stop, ['STOP']);
  assert.equal(result.body.tool_choice, 'required');
  assert.equal(result.body.messages[0].role, 'system');
  assert.equal(result.meta.upstreamStream, true);
  assert.equal(result.meta.inputTokens > 0, true);
});

test('anthropicToGroq n’active pas le stream si STREAMING=0', () => {
  const result = anthropicToGroq(
    {
      model: 'claude-sonnet-4-5',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'Bonjour' }],
    },
    { ...config, streaming: false },
  );
  assert.equal(result.body.stream, undefined);
  assert.equal(result.body.stream_options, undefined);
  assert.equal(result.meta.clientStream, true);
  assert.equal(result.meta.upstreamStream, false);
});

test('anthropicToGroq rejette les corps invalides', () => {
  assert.throws(() => anthropicToGroq({}, config), /messages/);
  assert.throws(() => anthropicToGroq({ messages: [] }, config), /messages/);
});

test('groqToAnthropicMessage traduit texte, usage et stop_reason', () => {
  const message = groqToAnthropicMessage(
    {
      choices: [
        {
          message: { role: 'assistant', content: 'Bonjour depuis Groq' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    },
    { requestedModel: 'claude-sonnet-4-5', messageId: 'msg_test' },
  );

  assert.equal(message.id, 'msg_test');
  assert.equal(message.type, 'message');
  assert.equal(message.role, 'assistant');
  assert.equal(message.model, 'claude-sonnet-4-5');
  assert.deepEqual(message.content, [{ type: 'text', text: 'Bonjour depuis Groq' }]);
  assert.equal(message.stop_reason, 'end_turn');
  assert.equal(message.usage.input_tokens, 12);
  assert.equal(message.usage.output_tokens, 7);
});

test('groqToAnthropicMessage estime l’usage absent', () => {
  const message = groqToAnthropicMessage(
    {
      choices: [
        {
          message: { role: 'assistant', content: 'Bonjour' },
          finish_reason: 'stop',
        },
      ],
    },
    { requestedModel: 'claude-sonnet-4-5', inputTokens: 42 },
  );

  assert.equal(message.usage.input_tokens, 42);
  assert.ok(message.usage.output_tokens > 0);
});

test('groqToAnthropicMessage traduit les tool_calls', () => {
  const message = groqToAnthropicMessage(
    {
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
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
    { requestedModel: 'claude-sonnet-4-5', messageId: 'msg_tool' },
  );

  assert.equal(message.stop_reason, 'tool_use');
  assert.equal(message.content.length, 1);
  assert.deepEqual(message.content[0], {
    type: 'tool_use',
    id: 'call_1',
    name: 'Read',
    input: { file_path: 'a.txt' },
  });
});

test('groqToAnthropicMessage gère les arguments JSON invalides et les réponses vides', () => {
  const invalid = groqToAnthropicMessage(
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'x', function: { name: 'Bash', arguments: '{invalid' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    { requestedModel: 'claude-sonnet-4-5' },
  );
  assert.deepEqual(invalid.content[0].input, {});

  const empty = groqToAnthropicMessage(
    { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] },
    { requestedModel: 'claude-sonnet-4-5' },
  );
  assert.deepEqual(empty.content, [{ type: 'text', text: '' }]);
});

test('mapStopReason et parseToolArguments', () => {
  assert.equal(mapStopReason('length', false), 'max_tokens');
  assert.equal(mapStopReason('tool_calls', true), 'tool_use');
  assert.equal(mapStopReason('tool_calls', false), 'end_turn');
  assert.equal(mapStopReason('stop', true), 'tool_use');
  assert.equal(mapStopReason('stop', false), 'end_turn');
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments('[1,2]'), {});
  assert.deepEqual(parseToolArguments('nope'), {});
});

test('streamGroqToAnthropic produit une séquence Anthropic complète', async () => {
  const events = [];
  const writer = { event: (type, payload) => events.push({ type, payload }) };
  const upstream = (async function* generate() {
    yield { choices: [{ delta: { role: 'assistant', content: 'Bonjour' } }] };
    yield { choices: [{ delta: { content: ' monde' } }] };
    yield {
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
    };
    yield {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }],
          },
        },
      ],
    };
    yield {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 11, completion_tokens: 9 },
    };
  })();

  const result = await streamGroqToAnthropic(upstream, writer, {
    messageId: 'msg_stream',
    requestedModel: 'claude-sonnet-4-5',
    inputTokens: 11,
  });

  assert.equal(result.text, 'Bonjour monde');
  assert.equal(result.toolCount, 1);
  assert.equal(result.usage.output_tokens, 9);
  assert.equal(result.stopReason, 'tool_use');

  const types = events.map((event) => event.type);
  assert.deepEqual(types, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);

  const start = events[0].payload.message;
  assert.equal(start.id, 'msg_stream');
  assert.equal(start.usage.input_tokens, 11);
  assert.deepEqual(start.content, []);

  const toolStart = events[5].payload.content_block;
  assert.equal(toolStart.type, 'tool_use');
  assert.equal(toolStart.name, 'Read');
  assert.equal(toolStart.id, 'call_1');

  const toolDelta = JSON.parse(events[6].payload.delta.partial_json);
  assert.deepEqual(toolDelta, { file_path: 'a.txt' });

  assert.equal(events[8].payload.delta.stop_reason, 'tool_use');
  assert.equal(events[8].payload.usage.output_tokens, 9);
});

test('streamGroqToAnthropic émet un bloc texte vide si le stream est vide', async () => {
  const events = [];
  const writer = { event: (type, payload) => events.push({ type, payload }) };
  const upstream = (async function* generate() {})();
  const result = await streamGroqToAnthropic(upstream, writer, {
    messageId: 'msg_empty',
    requestedModel: 'claude-sonnet-4-5',
    inputTokens: 3,
  });

  assert.equal(result.toolCount, 0);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  );
  assert.equal(events[4].payload.delta.stop_reason, 'end_turn');
});

test('streamGroqToAnthropic propage une erreur Groq', async () => {
  const writer = { event: () => {} };
  const upstream = (async function* generate() {
    yield { error: { message: 'boom' } };
  })();

  await assert.rejects(
    streamGroqToAnthropic(upstream, writer, {
      messageId: 'msg_error',
      requestedModel: 'claude-sonnet-4-5',
    }),
    /boom/,
  );
});

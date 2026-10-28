import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSse, SseWriter } from '../src/sse.js';

async function* chunks(...values) {
  for (const value of values) yield value;
}

test('parseSse gère les events, les coupures de chunks et [DONE]', async () => {
  const input = chunks(
    'event: message\nda',
    'ta: {"choices":[{"delta":{"content":"Bon',
    'jour"}}]}\r\n\r\n',
    ': commentaire\n\n',
    'data: {"choices":[]}\n\n',
    'data: {"usage":{"prompt_tokens":1}}\n\n',
    'data: [DONE]\n\n',
    'data: {"ignored":true}\n\n',
  );

  const events = [];
  for await (const event of parseSse(input)) events.push(event);

  assert.equal(events.length, 3);
  assert.equal(events[0].choices[0].delta.content, 'Bonjour');
  assert.deepEqual(events[1].choices, []);
  assert.equal(events[2].usage.prompt_tokens, 1);
});

test('parseSse accepte les data multi-lignes et les buffers', async () => {
  const input = chunks(
    Buffer.from('data: {"a":\n'),
    Buffer.from('data: 1}\n\n'),
  );
  const events = [];
  for await (const event of parseSse(input)) events.push(event);
  assert.deepEqual(events, [{ a: 1 }]);
});

test('parseSse préserve un caractère UTF-8 coupé entre deux chunks', async () => {
  const frame = Buffer.from('data: {"text":"é😀"}\n\n', 'utf8');
  const split = frame.indexOf(Buffer.from('é', 'utf8')) + 1;
  const input = chunks(frame.subarray(0, split), frame.subarray(split));
  const events = [];
  for await (const event of parseSse(input)) events.push(event);
  assert.deepEqual(events, [{ text: 'é😀' }]);
});

test('parseSse ignore un JSON malformé sans casser le flux', async () => {
  const input = chunks('data: {nope}\n\n', 'data: {"ok":true}\n\n');
  const events = [];
  for await (const event of parseSse(input)) events.push(event);
  assert.deepEqual(events, [{ ok: true }]);
});

test('SseWriter écrit le format Anthropic et ajoute le type', () => {
  const frames = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    write: (frame) => frames.push(frame),
    end: () => {
      res.writableEnded = true;
    },
  };
  const writer = new SseWriter(res);
  writer.event('message_start', { message: { id: 'msg_1' } });
  writer.event('message_stop', {});

  assert.equal(frames.length, 2);
  assert.match(frames[0], /^event: message_start\n/);
  assert.match(frames[0], /"type":"message_start"/);
  assert.match(frames[0], /"id":"msg_1"/);
  assert.match(frames[1], /^event: message_stop\n/);
  assert.match(frames[1], /"type":"message_stop"/);

  writer.end();
  assert.equal(res.writableEnded, true);
});

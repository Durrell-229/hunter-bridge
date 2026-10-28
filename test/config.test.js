import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConfig, parseAllowedHosts, publicConfig } from '../src/config.js';
import { loadEnvFile, parseEnvFile } from '../src/env.js';
import { normalizeGroqBaseUrl } from '../src/util.js';

test('parseEnvFile gère commentaires, export, quotes et échappements', () => {
  const parsed = parseEnvFile(`
# commentaire
GROQ_API_KEY=gsk_test # commentaire inline
export GROQ_MODEL="openai/gpt-oss-120b"
PORT='9000'
MULTI="ligne1\\nligne2"
VIDE=
  `);

  assert.equal(parsed.GROQ_API_KEY, 'gsk_test');
  assert.equal(parsed.GROQ_MODEL, 'openai/gpt-oss-120b');
  assert.equal(parsed.PORT, '9000');
  assert.equal(parsed.MULTI, 'ligne1\nligne2');
  assert.equal(parsed.VIDE, '');
});

test('loadEnvFile remplit une variable présente mais vide', () => {
  const file = path.join(os.tmpdir(), `groqcc-env-${process.pid}-${Date.now()}.env`);
  const key = 'GROQCC_TEST_EMPTY_VALUE';
  fs.writeFileSync(file, `${key}=depuis-le-fichier\n`);
  process.env[key] = '';
  try {
    assert.equal(loadEnvFile(file), true);
    assert.equal(process.env[key], 'depuis-le-fichier');
  } finally {
    delete process.env[key];
    fs.unlinkSync(file);
  }
});

test('buildConfig applique les défauts et les overrides', () => {
  const config = buildConfig({}, {});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8787);
  assert.equal(config.model, 'openai/gpt-oss-120b');
  assert.equal(config.smallModel, 'openai/gpt-oss-20b');
  assert.equal(config.streaming, true);
  assert.deepEqual(config.allowedHosts.sort(), ['127.0.0.1', '::1', 'localhost'].sort());

  const custom = buildConfig(
    {
      PORT: '9000',
      HOST: '0.0.0.0',
      GROQ_API_KEY: ' gsk_test ',
      GROQ_MODEL: 'llama-3.3-70b-versatile',
      GROQ_SMALL_MODEL: 'llama-3.1-8b-instant',
      MAX_OUTPUT_TOKENS: '4096',
      STREAMING: '0',
      PROXY_API_KEY: 'secret',
    },
    {},
  );
  assert.equal(custom.port, 9000);
  assert.equal(custom.host, '0.0.0.0');
  assert.equal(custom.apiKey, 'gsk_test');
  assert.equal(custom.model, 'llama-3.3-70b-versatile');
  assert.equal(custom.smallModel, 'llama-3.1-8b-instant');
  assert.equal(custom.maxOutputTokens, 4096);
  assert.equal(custom.streaming, false);
  assert.equal(custom.proxyApiKey, 'secret');
  assert.deepEqual(custom.allowedHosts, []);
});

test('buildConfig traite les placeholders de clé comme absents', () => {
  assert.equal(buildConfig({ GROQ_API_KEY: 'gsk_...' }).apiKey, '');
  assert.equal(buildConfig({ GROQ_API_KEY: '<ta clé>' }).apiKey, '');
  assert.equal(buildConfig({ GROQ_API_KEY: 'gsk_reelle_123' }).apiKey, 'gsk_reelle_123');
});

test('buildConfig rejette les valeurs invalides', () => {
  assert.throws(() => buildConfig({ PORT: 'abc' }), /PORT/);
  assert.throws(() => buildConfig({ PORT: '70000' }), /PORT/);
  assert.throws(() => buildConfig({ MAX_OUTPUT_TOKENS: '0' }), /MAX_OUTPUT_TOKENS/);
});

test('publicConfig ne divulgue jamais les secrets', () => {
  const config = buildConfig(
    { GROQ_API_KEY: 'gsk_secret', PROXY_API_KEY: 'proxy_secret' },
    {},
  );
  const pub = publicConfig(config);
  assert.equal(pub.keyConfigured, true);
  assert.equal(pub.proxyAuth, true);
  assert.equal(JSON.stringify(pub).includes('gsk_secret'), false);
  assert.equal(JSON.stringify(pub).includes('proxy_secret'), false);
});

test('normalizeGroqBaseUrl normalise les URLs Groq', () => {
  assert.equal(normalizeGroqBaseUrl('https://api.groq.com'), 'https://api.groq.com/openai/v1');
  assert.equal(
    normalizeGroqBaseUrl('https://api.groq.com/openai/v1/'),
    'https://api.groq.com/openai/v1',
  );
  assert.equal(
    normalizeGroqBaseUrl('https://api.groq.com/openai/v1/chat/completions'),
    'https://api.groq.com/openai/v1',
  );
  assert.equal(normalizeGroqBaseUrl('https://api.groq.com/openai'), 'https://api.groq.com/openai/v1');
  assert.equal(normalizeGroqBaseUrl('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1');
});

test('parseAllowedHosts déduit les hôtes loopback', () => {
  assert.deepEqual(parseAllowedHosts('', '127.0.0.1').sort(), [
    '127.0.0.1',
    '::1',
    'localhost',
  ].sort());
  assert.deepEqual(parseAllowedHosts('', '0.0.0.0'), []);
  assert.deepEqual(parseAllowedHosts('example.test, localhost', '127.0.0.1'), [
    'example.test',
    'localhost',
  ]);
});

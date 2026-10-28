import test from 'node:test';
import assert from 'node:assert/strict';
import { clampMaxTokens, contextFor, maxOutputFor, resolveModel } from '../src/models.js';

const config = {
  model: 'openai/gpt-oss-120b',
  smallModel: 'openai/gpt-oss-20b',
  maxOutputTokens: 32768,
};

test('resolveModel route les alias Claude Code', () => {
  assert.equal(resolveModel('claude-sonnet-4-5-20250929', config), 'openai/gpt-oss-120b');
  assert.equal(resolveModel('claude-opus-4-1', config), 'openai/gpt-oss-120b');
  assert.equal(resolveModel('claude-3-5-haiku-20241022', config), 'openai/gpt-oss-20b');
  assert.equal(resolveModel('claude-3-5-haiku-latest', config), 'openai/gpt-oss-20b');
  assert.equal(resolveModel('openai/gpt-oss-20b', config), 'openai/gpt-oss-20b');
  assert.equal(resolveModel('groq/llama-3.3-70b-versatile', config), 'llama-3.3-70b-versatile');
  assert.equal(resolveModel('some/custom-model', config), 'some/custom-model');
  assert.equal(resolveModel('', config), 'openai/gpt-oss-120b');
});

test('maxOutputFor respecte le plafond configuré', () => {
  assert.equal(maxOutputFor('openai/gpt-oss-120b', config), 32768);
  assert.equal(maxOutputFor('openai/gpt-oss-120b', { ...config, maxOutputTokens: 65536 }), 65536);
  assert.equal(maxOutputFor('qwen/qwen3.6-27b', config), 16384);
  assert.equal(maxOutputFor('inconnu/modele', config), 32768);
});

test('clampMaxTokens borne selon le modèle et le contexte', () => {
  assert.equal(clampMaxTokens(100000, 'openai/gpt-oss-120b', config, 1000), 32768);
  assert.equal(clampMaxTokens(100000, 'qwen/qwen3.6-27b', config, 1000), 16384);
  assert.equal(clampMaxTokens(undefined, 'openai/gpt-oss-120b', config, 0), 8192);
  assert.equal(clampMaxTokens(100000, 'openai/gpt-oss-120b', config, 130000), 256);
  assert.equal(contextFor('openai/gpt-oss-120b'), 131072);
});

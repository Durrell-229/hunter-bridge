import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../src/config.js';
import { classifyProfile, decideRoute, parseRequestedModel, splitTarget } from '../src/router.js';
import { createRuntime, decide, routeError } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';

function makeRuntime({ keys = { GROQ_API_KEY: 'gsk_test' } } = {}) {
  const settings = defaultSettings();
  const config = buildConfig({}, { maxOutputTokens: 32768 });
  return createRuntime(config, {
    settings,
    env: keys,
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  });
}

test('splitTarget accepte les IDs de modèles contenant des slashs', () => {
  assert.deepEqual(splitTarget('nvidia/deepseek-ai/deepseek-r1'), {
    providerId: 'nvidia',
    modelId: 'deepseek-ai/deepseek-r1',
    raw: 'nvidia/deepseek-ai/deepseek-r1',
  });
  assert.deepEqual(splitTarget('sonnet'), {
    providerId: '',
    modelId: 'sonnet',
    raw: 'sonnet',
  });
});

test('classifyProfile reconnaît CTF, bug bounty et reverse', () => {
  const settings = defaultSettings();
  assert.equal(
    classifyProfile('ctf pwn heap exploit shellcode flag{', settings).profileId,
    'ctf',
  );
  assert.equal(
    classifyProfile('bug bounty scope hackerone ssrf api security', settings).profileId,
    'bugbounty',
  );
  assert.equal(
    classifyProfile('reverse engineering ghidra anti-debug firmware', settings).profileId,
    'rev',
  );
});

test('parseRequestedModel mappe les alias Claude Code vers les slots du dashboard', () => {
  const runtime = makeRuntime({ keys: { GROQ_API_KEY: 'gsk_test', OPENCODE_API_KEY: 'zen' } });
  const sonnet = parseRequestedModel('claude-sonnet-4-5', runtime.providers, runtime.settings);
  assert.equal(sonnet.kind, 'target');
  assert.equal(sonnet.providerId, 'nvidia');
  assert.equal(sonnet.modelId, 'nvidia/nemotron-3-ultra-550b-a55b');
  assert.equal(sonnet.slot, 'sonnet');

  const opus = parseRequestedModel('claude-opus-4-5', runtime.providers, runtime.settings);
  assert.equal(opus.kind, 'target');
  assert.equal(opus.modelId, 'nvidia/nemotron-3-ultra-550b-a55b');

  const haiku = parseRequestedModel('claude-3-5-haiku-latest', runtime.providers, runtime.settings);
  assert.equal(haiku.kind, 'target');
  assert.equal(haiku.providerId, 'nvidia');
  assert.equal(haiku.modelId, 'nvidia/nemotron-3.5-lightning-30b-a3b');
});

test('decideRoute choisit la chaîne du profil et filtre les clés absentes', () => {
  const runtime = makeRuntime({ keys: { GROQ_API_KEY: 'gsk_test' } });
  const decision = decide(runtime, {
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'CTF pwn buffer overflow, trouve le flag' }],
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
  });
  assert.equal(decision.profileId, 'ctf');
  assert.ok(decision.candidates.length > 0);
  assert.equal(decision.candidates[0].providerId, 'groq');
  assert.match(decision.systemSuffix, /CTF/);
  assert.ok(decision.skipped.some((entry) => entry.includes('nvidia')));
});

test('les slots Claude Code sont configurables vers n’importe quelle cible', () => {
  const runtime = makeRuntime({ keys: { GROQ_API_KEY: 'gsk_test' } });
  runtime.settings.routing.claudeModels.sonnet = 'groq/openai/gpt-oss-120b';
  const parsed = parseRequestedModel('claude-sonnet-4-5', runtime.providers, runtime.settings);
  assert.equal(parsed.kind, 'target');
  assert.equal(parsed.providerId, 'groq');
  assert.equal(parsed.modelId, 'openai/gpt-oss-120b');
});

test('le quota d’entrée Groq évite les requêtes vouées au 429', () => {
  const runtime = makeRuntime({ keys: { GROQ_API_KEY: 'gsk_test' } });
  runtime.settings.routing.claudeModels.sonnet = 'groq/openai/gpt-oss-120b';
  const decision = decide(runtime, {
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'x'.repeat(40000) }],
  });
  assert.equal(decision.candidates.length, 0);
  assert.ok(decision.skipped.some((entry) => entry.includes("quota d'entrée")));
});

test('decideRoute respecte une cible fournisseur explicite', () => {
  const runtime = makeRuntime({
    keys: { GROQ_API_KEY: 'gsk_test', GEMINI_API_KEY: 'gemini_test' },
  });
  const decision = decide(runtime, {
    model: 'gemini/gemini-2.5-pro',
    messages: [{ role: 'user', content: 'Explique un protocole' }],
  });
  assert.equal(decision.candidates[0].providerId, 'gemini');
  assert.equal(decision.candidates[0].modelId, 'gemini-2.5-pro');
});

test('un modèle sans outils est écarté quand la requête contient des outils', () => {
  const runtime = makeRuntime({
    keys: { NVIDIA_API_KEY: 'nvapi_test' },
  });
  const decision = decide(runtime, {
    model: 'nvidia/deepseek-ai/deepseek-r1',
    messages: [{ role: 'user', content: 'Analyse ce binaire' }],
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
  });
  assert.ok(decision.candidates.every((candidate) => candidate.model.tools !== false));
});

test('sans clé, decideRoute renvoie une chaîne vide exploitable par le serveur', () => {
  const runtime = makeRuntime({ keys: {} });
  const decision = decideRoute(
    { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Bonjour' }] },
    runtime.providers,
    runtime.settings,
  );
  assert.equal(decision.candidates.length, 0);
  assert.ok(decision.skipped.length > 0);
});

test('routeError renvoie 429 avec retry-after quand tous les fournisseurs sont en cooldown', () => {
  const runtime = makeRuntime({ keys: { GROQ_API_KEY: 'gsk_test' } });
  const provider = runtime.providers.get('groq');
  provider.cooldownUntil = Date.now() + 30000;
  const error = routeError(runtime, {
    profileId: 'code',
    skipped: ['groq/openai/gpt-oss-120b: fournisseur en cooldown'],
  });
  assert.equal(error.status, 429);
  assert.equal(error.type, 'rate_limit_error');
  assert.ok(error.retryAfter >= 1);
});

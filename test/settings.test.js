import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateEnvValue, parseEnvFile } from '../src/env.js';
import {
  ensureSettings,
  loadSettings,
  saveSettings,
  defaultSettings,
  deepMerge,
} from '../src/settings.js';
import {
  buildClaudeMcpConfig,
  normalizeMcpServer,
  scanPlugins,
  upsertMcpServer,
  writeClaudeMcpConfig,
} from '../src/mcp.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-test-'));
}

test('settings : création, permissions 600 et relecture', () => {
  const dir = tempDir();
  const file = path.join(dir, 'hunter.config.json');
  try {
    const settings = ensureSettings(file);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(settings.providers.groq);
    settings.routing.activeProfile = 'ctf';
    saveSettings(file, settings);
    const loaded = loadSettings(file);
    assert.equal(loaded.routing.activeProfile, 'ctf');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings : deepMerge remplace les tableaux sans muter la base', () => {
  const base = { a: { b: [1, 2], c: 3 } };
  const merged = deepMerge(base, { a: { b: [4], d: 5 } });
  assert.deepEqual(merged, { a: { b: [4], c: 3, d: 5 } });
  assert.deepEqual(base, { a: { b: [1, 2], c: 3 } });
});

test('updateEnvValue remplace une clé, préserve les commentaires et chmod 600', () => {
  const dir = tempDir();
  const file = path.join(dir, '.env');
  try {
    fs.writeFileSync(file, '# commentaire\nGROQ_API_KEY=ancienne\nAUTRE=1\n', { mode: 0o644 });
    updateEnvValue(file, 'GROQ_API_KEY', 'nouvelle-valeur');
    updateEnvValue(file, 'NOUVELLE_CLE', 'x y');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.GROQ_API_KEY, 'nouvelle-valeur');
    assert.equal(parsed.NOUVELLE_CLE, 'x y');
    assert.equal(parsed.AUTRE, '1');
    assert.match(fs.readFileSync(file, 'utf8'), /# commentaire/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP : normalisation, upsert et export Claude avec variables résolues', () => {
  const server = normalizeMcpServer({
    name: 'github',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
  });
  const servers = upsertMcpServer([], server);
  assert.equal(servers.length, 1);
  const exported = buildClaudeMcpConfig(servers, { GITHUB_TOKEN: 'secret-token' });
  assert.equal(exported.mcpServers.github.env.GITHUB_TOKEN, 'secret-token');

  const http = normalizeMcpServer({
    name: 'remote',
    type: 'http',
    url: 'http://127.0.0.1:3000/mcp',
    headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
  });
  const exportedHttp = buildClaudeMcpConfig([http], { MCP_TOKEN: 'abc' });
  assert.equal(exportedHttp.mcpServers.remote.type, 'http');
  assert.equal(exportedHttp.mcpServers.remote.headers.Authorization, 'Bearer abc');
});

test('MCP : fichier généré en 600 et plugins scannés', () => {
  const dir = tempDir();
  try {
    const mcpFile = path.join(dir, '.hunter', 'mcp.json');
    const result = writeClaudeMcpConfig(
      mcpFile,
      [normalizeMcpServer({ name: 'demo', command: 'echo', args: ['ok'] })],
      {},
    );
    assert.equal(result.written, true);
    assert.equal(fs.statSync(mcpFile).mode & 0o777, 0o600);

    const plugin = path.join(dir, 'plugin');
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'demo-plugin', version: '1.2.3' }),
    );
    const scanned = scanPlugins([plugin]);
    assert.equal(scanned[0].valid, true);
    assert.equal(scanned[0].name, 'demo-plugin');
    assert.equal(scanned[0].version, '1.2.3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultSettings contient les quatre fournisseurs et les profils CTF', () => {
  const settings = defaultSettings();
  assert.deepEqual(Object.keys(settings.providers), ['groq', 'opencode', 'nvidia', 'gemini']);
  assert.ok(settings.routing.profiles.ctf.chain.length >= 2);
  assert.ok(settings.routing.profiles.bugbounty.chain.length >= 2);
});

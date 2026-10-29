import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'bin', 'hunter.js');

test('init crée le .env ciblé par HUNTER_ENV_FILE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunter-cli-'));
  const envFile = path.join(dir, '.env');
  const configFile = path.join(dir, 'hunter.config.json');

  try {
    const result = spawnSync(process.execPath, [ENTRY, 'init', '--config', configFile], {
      env: { ...process.env, HUNTER_ENV_FILE: envFile },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(envFile), '.env devrait être créé');
    assert.ok(fs.existsSync(configFile), 'hunter.config.json devrait être créé');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const HTTP_TYPES = new Set(['http', 'sse']);

export function normalizeMcpServer(input, fallbackName = '') {
  const raw = input && typeof input === 'object' ? input : {};
  const name = String(raw.name || fallbackName || '').trim();
  if (!NAME_RE.test(name)) {
    throw new Error('Nom MCP invalide : lettres, chiffres, point, tiret et underscore uniquement.');
  }
  const type = HTTP_TYPES.has(String(raw.type || '').toLowerCase())
    ? String(raw.type).toLowerCase()
    : 'stdio';
  const server = {
    name,
    enabled: raw.enabled !== false,
    type,
    description: String(raw.description || '').slice(0, 500),
  };
  if (type === 'stdio') {
    if (!String(raw.command || '').trim()) {
      throw new Error(`MCP ${name} : commande requise pour un serveur stdio.`);
    }
    server.command = String(raw.command).trim();
    server.args = arrayOfStrings(raw.args);
    server.env = stringMap(raw.env);
    if (raw.cwd) server.cwd = String(raw.cwd);
  } else {
    if (!String(raw.url || '').trim()) {
      throw new Error(`MCP ${name} : URL requise pour un serveur ${type}.`);
    }
    server.url = String(raw.url).trim();
    server.headers = stringMap(raw.headers);
  }
  return server;
}

export function normalizeMcpServers(input) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const server = normalizeMcpServer(item);
    if (seen.has(server.name)) throw new Error(`Nom MCP en double : ${server.name}`);
    seen.add(server.name);
    out.push(server);
  }
  return out;
}

export function mcpServerByName(servers, name) {
  return (Array.isArray(servers) ? servers : []).find((server) => server.name === name) || null;
}

export function upsertMcpServer(servers, input) {
  const server = normalizeMcpServer(input);
  const list = Array.isArray(servers) ? servers.slice() : [];
  const index = list.findIndex((entry) => entry.name === server.name);
  if (index >= 0) list[index] = server;
  else list.push(server);
  return list;
}

export function removeMcpServer(servers, name) {
  return (Array.isArray(servers) ? servers : []).filter((server) => server.name !== name);
}

export function redactMcpServer(server) {
  const copy = JSON.parse(JSON.stringify(server));
  if (copy.env) copy.env = redactMap(copy.env);
  if (copy.headers) copy.headers = redactMap(copy.headers);
  return copy;
}

export function redactMcpServers(servers) {
  return (Array.isArray(servers) ? servers : []).map(redactMcpServer);
}

function redactMap(map) {
  const out = {};
  for (const [key, value] of Object.entries(map || {})) {
    const text = String(value ?? '');
    out[key] = text.includes('${') ? text : '***';
  }
  return out;
}

function stringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (entry === undefined || entry === null) continue;
    out[key] = String(entry);
  }
  return out;
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry)).filter(Boolean);
}

export function resolveEnvTemplate(value, env = process.env) {
  return String(value ?? '').replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    return env[name] === undefined ? match : env[name];
  });
}

function resolveMap(map, env) {
  const out = {};
  for (const [key, value] of Object.entries(map || {})) {
    out[key] = resolveEnvTemplate(value, env);
  }
  return out;
}

export function buildClaudeMcpConfig(servers, env = process.env) {
  const mcpServers = {};
  for (const server of Array.isArray(servers) ? servers : []) {
    if (!server || server.enabled === false) continue;
    if (server.type === 'stdio') {
      const entry = {
        command: server.command,
        args: Array.isArray(server.args) ? server.args : [],
      };
      const envMap = resolveMap(server.env, env);
      if (Object.keys(envMap).length) entry.env = envMap;
      if (server.cwd) entry.cwd = server.cwd;
      mcpServers[server.name] = entry;
    } else {
      const entry = {
        type: server.type,
        url: resolveEnvTemplate(server.url, env),
      };
      const headers = resolveMap(server.headers, env);
      if (Object.keys(headers).length) entry.headers = headers;
      mcpServers[server.name] = entry;
    }
  }
  return { mcpServers };
}

export function writeClaudeMcpConfig(file, servers, env = process.env) {
  const config = buildClaudeMcpConfig(servers, env);
  const count = Object.keys(config.mcpServers).length;
  if (!count) return { path: file, count: 0, written: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { path: file, count, written: true };
}

export function expandHome(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

export function normalizePluginPaths(input) {
  const list = Array.isArray(input) ? input : [];
  return [...new Set(list.map((entry) => expandHome(entry)).filter(Boolean))];
}

export function scanPlugins(paths) {
  return normalizePluginPaths(paths).map((entry) => {
    const resolved = path.resolve(entry);
    const result = { path: resolved, name: path.basename(resolved), version: '', valid: false };
    try {
      if (!fs.statSync(resolved).isDirectory()) {
        result.error = 'ce n’est pas un dossier';
        return result;
      }
      const candidates = [
        path.join(resolved, '.claude-plugin', 'plugin.json'),
        path.join(resolved, 'plugin.json'),
      ];
      const manifest = candidates.find((candidate) => fs.existsSync(candidate));
      if (!manifest) {
        result.error = 'plugin.json absent';
        return result;
      }
      const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      result.name = String(json.name || result.name);
      result.version = String(json.version || '');
      result.valid = true;
      return result;
    } catch (error) {
      result.error = error.message;
      return result;
    }
  });
}

export function pluginArgs(paths) {
  return scanPlugins(paths)
    .filter((plugin) => plugin.valid)
    .flatMap((plugin) => ['--plugin-dir', plugin.path]);
}

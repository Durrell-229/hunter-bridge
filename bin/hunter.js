#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildConfig } from '../src/config.js';
import { checkSecretFilePermissions, findEnvFile, loadEnvFile } from '../src/env.js';
import { listUpstreamModels, simpleChat } from '../src/upstream.js';
import { pluginArgs, scanPlugins, writeClaudeMcpConfig } from '../src/mcp.js';
import {
  apiModels,
  createRuntime,
  decide,
  primaryInfo,
  setActiveProfile,
  snapshot,
  testProvider,
} from '../src/runtime.js';
import { ensureSettings } from '../src/settings.js';
import { closeServer, createBridgeServer, createLogger, listen } from '../src/server.js';
import { maskKey, redactSecrets } from '../src/util.js';
import { SERVICE, VERSION } from '../src/version.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(PROJECT_ROOT, 'hunter.config.json');
const DEFAULT_MCP = path.join(PROJECT_ROOT, '.hunter', 'mcp.json');

const HELP = `
${SERVICE} v${VERSION} — routage multi-fournisseurs pour Claude Code

Usage :
  hunter start [options]            démarre le proxy + le dashboard
  hunter claude [-- args…]          démarre tout puis lance Claude Code
  hunter up [options]               alias de start
  hunter doctor [--chat]            diagnostic fournisseurs, clés, modèles
  hunter models [--provider <id>]   liste les modèles locaux/découverts
  hunter env [--shell <shell>]      variables d'environnement Claude Code
  hunter init                       crée hunter.config.json et .env si absent
  hunter help

Options :
  --env-file <path>       fichier .env (défaut : ./.env puis <projet>/.env)
  --config <path>         configuration Hunter (défaut : ./hunter.config.json)
  --port <n>              port d'écoute (défaut : 8787 ; 0 = aléatoire pour claude)
  --host <host>           adresse d'écoute (défaut : 127.0.0.1)
  --profile <id>          profil de routage (auto, ctf, bugbounty, pwn, rev, web…)
  --provider <id>         filtre doctor/models
  --model <id>            modèle Claude Code principal (ou cible explicite)
  --no-stream             désactive le streaming amont
  --no-mcp                ne génère pas --mcp-config
  --no-plugins            ne passe pas --plugin-dir
  --log-level <level>     debug | info | warn | error
  --json                  sortie JSON (doctor, models)
  --chat                  test réel de génération (doctor)
  --shell <shell>         bash | zsh | fish | powershell (env)
  -h, --help
  -v, --version

Fournisseurs intégrés :
  Groq, OpenCode Zen, NVIDIA NIM, Google Gemini (API OpenAI-compatible).
  Les clés se mettent dans .env : GROQ_API_KEY, OPENCODE_API_KEY,
  NVIDIA_API_KEY, GEMINI_API_KEY. Le dashboard permet de les saisir sans
  les afficher ensuite.

Démarrage rapide :
  npm run init
  # édite les clés dans .env (ne les colle jamais dans le chat)
  npm run doctor -- --chat
  npm run claude -- --profile ctf
`;

async function main() {
  const argv = process.argv.slice(2);
  const command = argv.length > 0 && !argv[0].startsWith('-') ? argv.shift() : 'start';

  let opts;
  try {
    opts = parseArgs(argv, command);
  } catch (error) {
    console.error(`Erreur : ${error.message}`);
    process.exitCode = 2;
    return;
  }

  if (opts.help || command === 'help') {
    console.log(HELP);
    return;
  }
  if (opts.version || command === 'version') {
    console.log(VERSION);
    return;
  }

  let envFile = opts.envFile
    ? path.resolve(opts.envFile)
    : findEnvFile(process.cwd(), PROJECT_ROOT) || path.join(PROJECT_ROOT, '.env');
  if (opts.envFile && !fs.existsSync(envFile)) {
    console.error(`Erreur : fichier .env introuvable : ${opts.envFile}`);
    process.exitCode = 1;
    return;
  }
  if (fs.existsSync(envFile)) loadEnvFile(envFile);

  let config;
  try {
    config = buildConfig(process.env, {
      port: opts.port,
      host: opts.host,
      model: opts.model,
      smallModel: opts.smallModel,
      logLevel: opts.logLevel,
      streaming: opts.streaming,
      adminToken: opts.adminToken,
      configPath: opts.config,
    });
  } catch (error) {
    console.error(`Erreur de configuration : ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const settingsPath = opts.config
    ? path.resolve(opts.config)
    : config.configPath
      ? path.resolve(config.configPath)
      : DEFAULT_CONFIG;

  if (opts.model && command !== 'claude' && !looksLikeClaudeModel(opts.model)) {
    config.forceTarget = opts.model;
  }

  if (command === 'init') {
    init(settingsPath, envFile);
    return;
  }

  let settings;
  try {
    settings = ensureSettings(settingsPath);
  } catch (error) {
    console.error(`Erreur de configuration Hunter : ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const runtime = createRuntime(config, {
    settings,
    settingsPath,
    envPath: fs.existsSync(envFile) ? envFile : null,
    logger: createLogger(config.logLevel),
  });
  if (opts.profile) {
    try {
      if (!runtime.settings.routing.profiles?.[opts.profile]) {
        throw new Error(`Profil inconnu : ${opts.profile}`);
      }
      if (command === 'start' || command === 'up' || command === 'claude') {
        setActiveProfile(runtime, opts.profile);
      } else {
        // doctor/models/env ne doivent pas modifier la configuration persistée.
        runtime.settings.routing.activeProfile = opts.profile;
      }
    } catch (error) {
      console.error(`Erreur : ${error.message}`);
      process.exitCode = 2;
      return;
    }
  }

  switch (command) {
    case 'start':
    case 'up':
      await start(config, runtime);
      break;
    case 'claude':
      await runClaude(config, runtime, opts);
      break;
    case 'doctor':
      await doctor(config, runtime, opts, envFile, settingsPath);
      break;
    case 'models':
      await models(runtime, opts);
      break;
    case 'env':
      printEnv(config, runtime, opts);
      break;
    default:
      console.error(`Commande inconnue : ${command}`);
      console.error(HELP);
      process.exitCode = 2;
  }
}

function parseArgs(argv, command = 'start') {
  const opts = { rest: [] };
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--') {
      opts.rest.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('-')) {
      opts.rest.push(arg);
      index += 1;
      continue;
    }

    const equals = arg.indexOf('=');
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined;

    const takeValue = () => {
      if (inline !== undefined) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`l'option ${name} attend une valeur`);
      return argv[index];
    };

    switch (name) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-v':
      case '--version':
        opts.version = true;
        break;
      case '--env-file':
        opts.envFile = takeValue();
        break;
      case '--config':
        opts.config = takeValue();
        break;
      case '--port':
        opts.port = takeValue();
        break;
      case '--host':
        opts.host = takeValue();
        break;
      case '--profile':
        opts.profile = takeValue();
        break;
      case '--provider':
        opts.provider = takeValue();
        break;
      case '--model': {
        const value = takeValue();
        // `claude --model sonnet` doit passer le flag à Claude Code, pas
        // choisir un modèle Groq nommé "sonnet".
        if (command === 'claude' && looksLikeClaudeModel(value)) {
          opts.rest.push('--model', value);
        } else {
          opts.model = value;
          if (command === 'claude') opts.forceModel = value;
        }
        break;
      }
      case '--small-model':
        opts.smallModel = takeValue();
        break;
      case '--log-level':
        opts.logLevel = takeValue();
        break;
      case '--no-stream':
        opts.streaming = false;
        break;
      case '--no-mcp':
        opts.noMcp = true;
        break;
      case '--no-plugins':
        opts.noPlugins = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--chat':
        opts.chat = true;
        break;
      case '--shell':
        opts.shell = takeValue();
        break;
      case '--api-key':
        throw new Error('utilise les variables dans .env, jamais une clé en argument de commande');
      default:
        if (command === 'claude') {
          opts.rest.push(...argv.slice(index));
          index = argv.length;
          break;
        }
        throw new Error(`option inconnue : ${name}`);
    }
    index += 1;
  }

  return opts;
}

function looksLikeClaudeModel(value) {
  const model = String(value || '').toLowerCase();
  if (!model) return false;
  const provider = model.includes('/') ? model.slice(0, model.indexOf('/')) : '';
  if (['groq', 'opencode', 'opencodezen', 'opencode-zen', 'zen', 'nvidia', 'nim', 'gemini', 'google', 'hunter', 'profile', 'route'].includes(provider)) {
    // `--model opencode/claude-opus-4-5` est une cible Hunter, pas un
    // alias natif à transmettre à Claude Code.
    return false;
  }
  if (['default', 'best', 'fable', 'sonnet', 'opus', 'haiku', 'opusplan'].includes(model)) {
    return true;
  }
  if (model.endsWith('[1m]')) return true;
  return model.startsWith('claude-') || model.includes('claude');
}

function init(settingsPath, envFile) {
  try {
    ensureSettings(settingsPath);
    if (!fs.existsSync(envFile)) {
      const example = path.join(PROJECT_ROOT, '.env.example');
      if (fs.existsSync(example)) {
        fs.copyFileSync(example, envFile);
        fs.chmodSync(envFile, 0o600);
      }
    }
    console.log(`\n  ${SERVICE} initialisé`);
    console.log(`  config  ${settingsPath}`);
    console.log(`  env     ${envFile}`);
    console.log('\n  Renseigne les clés dans .env puis lance :');
    console.log('    npm run doctor -- --chat');
    console.log('    npm run claude -- --profile ctf\n');
  } catch (error) {
    console.error(`Erreur d'initialisation : ${error.message}`);
    process.exitCode = 1;
  }
}

async function start(config, runtime) {
  warnIfNoKeys(runtime);
  warnIfAdminExposed(config);
  const log = createLogger(config.logLevel);
  const server = createBridgeServer(config, { logger: log, runtime });

  let address;
  try {
    address = await listen(server, config.host, config.port);
  } catch (error) {
    console.error(`Impossible d'écouter sur ${config.host}:${config.port} : ${error.message}`);
    process.exitCode = 1;
    return;
  }

  printBanner(config, runtime, address);
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`arrêt (${signal})`);
    await closeServer(server);
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

async function runClaude(config, runtime, opts) {
  const ready = [...runtime.providers.values()].filter((provider) => provider.apiKey);
  if (!ready.length) {
    console.error(
      '\n  Aucune clé fournisseur configurée. Ajoute au moins une clé dans .env :\n' +
        '    GROQ_API_KEY, OPENCODE_API_KEY, NVIDIA_API_KEY ou GEMINI_API_KEY\n' +
        '  puis relance : npm run claude -- --profile ctf\n',
    );
    process.exitCode = 1;
    return;
  }

  const port = opts.port !== undefined ? config.port : 0;
  const childConfig = {
    ...config,
    port,
    forceTarget: opts.forceModel || config.forceTarget,
    // LOG_LEVEL=info dans .env est utile pour `npm start`, mais trop bavard
    // dans le terminal de Claude Code. HUNTER_LOG_LEVEL force le niveau.
    logLevel: process.env.HUNTER_LOG_LEVEL || process.env.GROQCC_LOG_LEVEL || 'warn',
  };
  const server = createBridgeServer(childConfig, {
    logger: createLogger(childConfig.logLevel),
    runtime,
  });

  let address;
  try {
    address = await listen(server, childConfig.host, port);
  } catch (error) {
    console.error(`Impossible de démarrer le proxy : ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const baseUrl = baseUrlFor(childConfig, address);
  const childEnv = claudeEnv(childConfig, baseUrl, runtime);
  const args = [...opts.rest];
  let pluginList = [];

  let mcp = null;
  if (!opts.noMcp) {
    try {
      mcp = writeClaudeMcpConfig(
        DEFAULT_MCP,
        runtime.settings.mcp?.servers || [],
        process.env,
      );
      if (mcp.written) args.unshift('--mcp-config', mcp.path);
    } catch (error) {
      console.error(`⚠ Configuration MCP non générée : ${error.message}`);
    }
  }
  if (!opts.noPlugins) {
    pluginList = pluginArgs(runtime.settings.plugins?.paths || []);
    args.push(...pluginList);
  }

  const command = resolveClaudeCommand();
  if (!command) {
    await closeServer(server);
    console.error(
      '\nClaude Code est introuvable.\nInstalle-le avec :\n  npm install -g @anthropic-ai/claude-code\n' +
        'ou définis HUNTER_CLAUDE_BIN=/chemin/vers/claude.\n',
    );
    process.exitCode = 127;
    return;
  }

  console.error(`\n  ${SERVICE} → Claude Code`);
  console.error(`  proxy     ${baseUrl}`);
  console.error('  dashboard');
  console.error(`  ${baseUrl}/dashboard`);
  console.error(`  profil    ${runtime.settings.routing.activeProfile}`);
  console.error(`  chaîne    ${(runtime.settings.routing.profiles?.[runtime.settings.routing.activeProfile]?.chain || []).join(' → ')}`);
  if (mcp?.written) console.error(`  mcp       ${mcp.path} (${mcp.count} serveur(s))`);
  if (pluginList.length) console.error(`  plugins   ${pluginList.length / 2} dossier(s)`);
  console.error('  lancement de claude…\n');

  const child = spawn(command, args, { stdio: 'inherit', env: childEnv, shell: false });
  let finished = false;

  const shutdown = async (signal) => {
    if (finished) return;
    finished = true;
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
    await closeServer(server);
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  child.on('error', async (error) => {
    if (finished) return;
    finished = true;
    await closeServer(server);
    if (error.code === 'ENOENT') {
      console.error(
        '\nClaude Code est introuvable.\nInstalle-le avec :\n  npm install -g @anthropic-ai/claude-code\n',
      );
      process.exitCode = 127;
    } else {
      console.error(`\nImpossible de lancer Claude Code : ${error.message}\n`);
      process.exitCode = 1;
    }
  });

  child.on('close', async (code, signal) => {
    if (finished) return;
    finished = true;
    await closeServer(server);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

async function doctor(config, runtime, opts, envFile, settingsPath) {
  const providers = [...runtime.providers.values()].filter(
    (provider) => !opts.provider || provider.id === opts.provider,
  );
  const report = {
    node: process.version,
    project: PROJECT_ROOT,
    config: settingsPath,
    envFile: envFile || null,
    listen: `${config.host}:${config.port}`,
    activeProfile: runtime.settings.routing.activeProfile,
    claudeCode: findClaude(),
    providers: [],
    warnings: [],
    chat: null,
    chatModel: null,
    chatError: null,
  };

  if (!fs.existsSync(envFile)) {
    report.warnings.push('Aucun fichier .env trouvé. Lance : npm run init');
  } else {
    const permissionWarning = checkSecretFilePermissions(envFile);
    if (permissionWarning) report.warnings.push(permissionWarning);
  }
  if (!report.claudeCode) {
    report.warnings.push(
      'Claude Code introuvable. Installe-le : npm install -g @anthropic-ai/claude-code',
    );
  }
  if (!providers.some((provider) => provider.apiKey)) {
    report.warnings.push(
      'Aucune clé fournisseur configurée. Renseigne au moins GROQ_API_KEY dans .env.',
    );
  }
  if (
    (config.host === '0.0.0.0' || config.host === '::') &&
    !config.adminToken
  ) {
    report.warnings.push(
      'Dashboard exposé sans HUNTER_ADMIN_TOKEN. Définis un jeton ou écoute sur 127.0.0.1.',
    );
  }

  let exitCode = 0;
  for (const provider of providers) {
    const entry = {
      id: provider.id,
      label: provider.label,
      enabled: provider.enabled,
      keyConfigured: Boolean(provider.apiKey),
      keyMasked: provider.apiKey ? maskKey(provider.apiKey) : '',
      models: provider.models.size,
      test: null,
    };
    if (provider.apiKey && provider.enabled) {
      try {
        const result = await testProvider(runtime, provider.id);
        entry.test = result;
        if (!result.ok) exitCode = 1;
      } catch (error) {
        entry.test = { ok: false, error: redactSecrets(error.message) };
        exitCode = 1;
      }
    }
    report.providers.push(entry);
  }

  if (opts.chat) {
    const candidates = chatCandidates(runtime, opts);
    if (!candidates.length) {
      report.chatError = 'aucun fournisseur disponible pour le chat';
      exitCode = 1;
    } else {
      const failures = [];
      for (const candidate of candidates) {
        try {
          const response = await simpleChat(candidate.provider, {
            model: candidate.modelId,
            prompt: 'Réponds uniquement : OK',
            maxTokens: 64,
            reasoningEffort: candidate.model.reasoning?.includes('low') ? 'low' : undefined,
          });
          report.chat = response?.choices?.[0]?.message?.content ?? response;
          report.chatModel = candidate.target;
          break;
        } catch (error) {
          failures.push(`${candidate.target}: ${redactSecrets(error.message)}`);
        }
      }
      if (!report.chat) {
        report.chatError = failures.join(' | ');
        exitCode = 1;
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = exitCode;
    return;
  }

  console.log(`\n  ${SERVICE} v${VERSION} — diagnostic\n`);
  console.log(`  Node        ${report.node}`);
  console.log(`  Projet      ${report.project}`);
  console.log(`  Config      ${report.config}`);
  console.log(`  .env        ${report.envFile || '(absent)'}`);
  console.log(`  Profil      ${report.activeProfile}`);
  console.log(`  Écoute      ${report.listen}`);
  console.log(`  Claude Code ${report.claudeCode || 'introuvable'}`);
  console.log('\n  Fournisseurs :');
  for (const provider of report.providers) {
    const key = provider.keyConfigured ? provider.keyMasked : 'ABSENTE';
    const test = provider.test
      ? provider.test.ok
        ? `OK ${provider.test.models} modèles`
        : `ERREUR ${provider.test.error}`
      : 'non testé';
    console.log(
      `   ${provider.id.padEnd(10)} ${String(provider.models).padStart(4)} modèles  ${key.padEnd(28)} ${test}`,
    );
  }
  if (report.chat) {
    console.log(`\n  Test chat   ${JSON.stringify(report.chat)}`);
    if (report.chatModel) console.log(`  Modèle testé ${report.chatModel}`);
  }
  if (report.chatError) console.log(`\n  Erreur chat ${report.chatError}`);

  if (report.warnings.length) {
    console.log('\n  Avertissements :');
    for (const warning of report.warnings) console.log(`   ⚠ ${warning}`);
  }
  console.log('');
  process.exitCode = exitCode;
}

function chatCandidates(runtime, opts) {
  const body = {
    model: runtime.config.claudeModel || 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'ping' }],
    tools: [],
  };
  const decision = decide(runtime, body, { profile: opts.profile });
  return decision.candidates.filter(
    (candidate) => !opts.provider || candidate.providerId === opts.provider,
  );
}

async function models(runtime, opts) {
  const providers = [...runtime.providers.values()].filter(
    (provider) => !opts.provider || provider.id === opts.provider,
  );
  const rows = [];
  for (const provider of providers) {
    let remote = [];
    if (provider.apiKey) {
      try {
        remote = await listUpstreamModels(provider, { timeoutMs: 15000 });
      } catch (error) {
        rows.push({
          provider: provider.id,
          id: '(erreur /models)',
          context: '',
          tools: '',
          error: redactSecrets(error.message),
        });
      }
    }
    const remoteIds = new Set(remote.map((entry) => String(entry?.id || entry?.name || '')));
    for (const model of provider.models.values()) {
      rows.push({
        provider: provider.id,
        id: model.id,
        context: model.context,
        maxOutput: model.maxOutput,
        tools: model.tools ? 'tools' : 'sans tools',
        source: remoteIds.has(model.id) ? 'remote' : provider.apiKey ? 'local' : 'local/no-key',
      });
    }
  }
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(`\n  ${rows.length} modèles connus\n`);
  for (const row of rows) {
    console.log(
      `  ${(row.provider + '/' + row.id).padEnd(58)} ${String(row.context).padStart(8)}  ${row.tools || ''} ${row.source || ''}`,
    );
    if (row.error) console.log(`    ⚠ ${row.error}`);
  }
  console.log('');
}

function printEnv(config, runtime, opts) {
  const shell = normalizeShell(opts.shell || detectShell());
  const port = config.port === 0 ? 8787 : config.port;
  const baseUrl = `http://${displayHost(config.host)}:${port}`;
  const vars = claudeEnvVars(config, baseUrl, runtime, { maskSecret: true });

  if (shell === 'fish') {
    for (const [key, value] of Object.entries(vars)) console.log(`set -gx ${key} ${quoteFish(value)}`);
    return;
  }
  if (shell === 'powershell') {
    for (const [key, value] of Object.entries(vars)) console.log(`$env:${key} = ${quotePowerShell(value)}`);
    return;
  }
  for (const [key, value] of Object.entries(vars)) console.log(`export ${key}=${quoteShell(value)}`);
}

function claudeEnv(config, baseUrl, runtime) {
  const env = { ...process.env, ...claudeEnvVars(config, baseUrl, runtime) };
  delete env.ANTHROPIC_API_KEY;
  for (const key of [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'CLAUDE_CODE_USE_MANTLE',
    'ANTHROPIC_BEDROCK_BASE_URL',
    'ANTHROPIC_VERTEX_BASE_URL',
    'ANTHROPIC_FOUNDRY_BASE_URL',
    'ANTHROPIC_AWS_BASE_URL',
  ]) {
    delete env[key];
  }
  env.NO_PROXY = env.NO_PROXY || '127.0.0.1,localhost,::1';
  env.no_proxy = env.NO_PROXY;
  return env;
}

function claudeEnvVars(config, baseUrl, runtime, { maskSecret = false } = {}) {
  const authToken =
    config.proxyApiKey && maskSecret
      ? '<ton PROXY_API_KEY>'
      : config.proxyApiKey || 'local-hunter-bridge';
  const info = primaryInfo(runtime);
  const modelMax = Math.max(256, Number(info.maxOutput || config.maxOutputTokens || 32768));
  const requestedMax = Number.parseInt(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? '', 10);
  const maxOutput =
    Number.isFinite(requestedMax) && requestedMax > 0
      ? Math.min(requestedMax, modelMax, Number(config.maxOutputTokens || modelMax))
      : Math.min(modelMax, Number(config.maxOutputTokens || modelMax));
  const contextWindow = Math.max(16384, Number(info.context || 131072));
  const autoCompact = Math.max(100000, Math.min(contextWindow - 16384, 1000000));
  const noProxy = [
    ...new Set(
      `${process.env.NO_PROXY || process.env.no_proxy || ''},127.0.0.1,localhost,::1`
        .split(/[,\s]+/)
        .filter(Boolean),
    ),
  ].join(',');

  return {
    ANTHROPIC_BASE_URL: baseUrl,
    NO_PROXY: noProxy,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_MODEL: config.claudeModel,
    ANTHROPIC_SMALL_FAST_MODEL: config.claudeSmallModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.claudeModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.claudeOpusModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.claudeSmallModel,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutput),
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(autoCompact),
    API_TIMEOUT_MS: String(config.streamTimeoutMs),
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    ENABLE_TOOL_SEARCH: 'false',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    HUNTER_PROFILE: runtime.settings.routing.activeProfile,
  };
}

function printBanner(config, runtime, address) {
  const baseUrl = baseUrlFor(config, address);
  console.log(`\n  ${SERVICE} v${VERSION}`);
  console.log(`  écoute      ${baseUrl}`);
  console.log('  dashboard');
  console.log(`  ${baseUrl}/dashboard`);
  console.log(`  profil      ${runtime.settings.routing.activeProfile}`);
  console.log(`  chaîne      ${(runtime.settings.routing.profiles?.[runtime.settings.routing.activeProfile]?.chain || []).join(' → ')}`);
  console.log(`  streaming   ${config.streaming ? 'activé' : 'désactivé (synthèse SSE)'}`);
  console.log('\n  Fournisseurs :');
  for (const provider of runtime.providers.values()) {
    const key = provider.apiKey ? `clé ${maskKey(provider.apiKey)}` : 'clé absente';
    console.log(`    ${provider.id.padEnd(10)} ${provider.enabled ? 'actif' : 'off'}  ${key}  ${provider.models.size} modèles`);
  }
  if (config.proxyApiKey) console.log('  auth proxy  activée');
  if (config.host === '0.0.0.0' || config.host === '::') {
    console.log('  ⚠ écoute sur toutes les interfaces : ne l’expose pas à Internet');
  }
  console.log('\n  Claude Code :');
  const vars = claudeEnvVars(config, baseUrl, runtime, { maskSecret: true });
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL']) {
    console.log(`    export ${key}=${quoteShell(vars[key])}`);
  }
  console.log('\n  Puis, dans un autre terminal : claude\n');
}

function warnIfNoKeys(runtime) {
  const ready = [...runtime.providers.values()].filter((provider) => provider.apiKey);
  if (ready.length) return;
  console.error(
    '\n  ⚠ Aucune clé fournisseur : le proxy démarre mais les requêtes renverront une erreur 500.\n' +
      '    Renseigne GROQ_API_KEY, OPENCODE_API_KEY, NVIDIA_API_KEY ou GEMINI_API_KEY dans .env.\n',
  );
}

function warnIfAdminExposed(config) {
  if ((config.host === '0.0.0.0' || config.host === '::') && !config.adminToken) {
    console.error(
      '\n  ⚠ Dashboard exposé sur toutes les interfaces sans HUNTER_ADMIN_TOKEN.\n' +
        '    Définis HUNTER_ADMIN_TOKEN dans .env ou écoute sur 127.0.0.1.\n',
    );
  }
}

function resolveClaudeCommand() {
  const explicit =
    process.env.HUNTER_CLAUDE_BIN || process.env.CLAUDE_BIN || process.env.CLAUDE_CODE_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.cmd' : 'claude'),
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    path.join(os.homedir(), '.npm-global', 'bin', process.platform === 'win32' ? 'claude.cmd' : 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const command = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0) return null;
  return command;
}

function findClaude() {
  const command = resolveClaudeCommand();
  if (!command) return null;
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr || '').trim() || command;
}

function detectShell() {
  if (process.platform === 'win32') return 'powershell';
  const shell = String(process.env.SHELL || '').toLowerCase();
  if (shell.includes('fish')) return 'fish';
  return 'bash';
}

function normalizeShell(value) {
  const shell = String(value || '').toLowerCase();
  if (['bash', 'zsh', 'sh', 'fish', 'powershell', 'pwsh'].includes(shell)) {
    return shell === 'pwsh' ? 'powershell' : shell;
  }
  return 'bash';
}

function displayHost(host) {
  const value = String(host || '127.0.0.1');
  if (value === '0.0.0.0' || value === '::' || value === '') return '127.0.0.1';
  if (value === '::1') return '[::1]';
  return value;
}

function baseUrlFor(config, address) {
  const port = address?.port ?? config.port;
  return `http://${displayHost(config.host)}:${port}`;
}

function quoteShell(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function quoteFish(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `\\'`)}'`;
}

function quotePowerShell(value) {
  return `"${String(value).replace(/"/g, '`"')}"`;
}

main().catch((error) => {
  console.error(`Erreur : ${redactSecrets(error?.message || error)}`);
  if (process.env.DEBUG) console.error(error?.stack || error);
  process.exitCode = 1;
});

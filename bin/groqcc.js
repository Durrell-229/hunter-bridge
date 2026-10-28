#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildConfig } from '../src/config.js';
import { checkSecretFilePermissions, findEnvFile, loadEnvFile } from '../src/env.js';
import { listGroqModels, simpleChat } from '../src/groq.js';
import { KNOWN_MODELS } from '../src/models.js';
import { closeServer, createBridgeServer, createLogger, listen } from '../src/server.js';
import { maskKey, redactSecrets } from '../src/util.js';
import { SERVICE, VERSION } from '../src/version.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `
${SERVICE} v${VERSION} — utiliser Groq avec Claude Code

Usage :
  groqcc start [options]           démarre le proxy local (port 8787)
  groqcc claude [-- args…]         démarre le proxy puis lance Claude Code
  groqcc doctor [--chat]           vérifie la configuration et la clé Groq
  groqcc models                    liste les modèles Groq disponibles
  groqcc env [--shell <shell>]     affiche les variables pour Claude Code
  groqcc help

Options :
  --env-file <path>       fichier .env (défaut : ./.env puis <projet>/.env)
  --port <n>              port d'écoute (défaut : 8787)
  --host <host>           adresse d'écoute (défaut : 127.0.0.1)
  --model <id>            modèle Groq principal
  --small-model <id>      petit modèle Groq (tâches "haiku")
  --no-stream             désactive le streaming vers Groq
  --log-level <level>     debug | info | warn | error
  --json                  sortie JSON (doctor, models)
  --chat                  test réel de génération (doctor)
  --shell <shell>         bash | zsh | fish | powershell (env)
  -h, --help
  -v, --version

Démarrage rapide :
  cp .env.example .env
  # édite GROQ_API_KEY dans .env
  npm run doctor
  npm run claude

Ou en deux terminaux :
  npm start
  source <(node bin/groqcc.js env)
  claude
`;

async function main() {
  const argv = process.argv.slice(2);
  const command = argv.length > 0 && !argv[0].startsWith('-') ? argv.shift() : 'start';

  let opts;
  try {
    opts = parseArgs(argv);
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

  let envFile = opts.envFile ? path.resolve(opts.envFile) : findEnvFile(process.cwd(), PROJECT_ROOT);
  if (opts.envFile && (!envFile || !fs.existsSync(envFile))) {
    console.error(`Erreur : fichier .env introuvable : ${opts.envFile}`);
    process.exitCode = 1;
    return;
  }
  if (envFile) loadEnvFile(envFile);

  let config;
  try {
    config = buildConfig(process.env, {
      port: opts.port,
      host: opts.host,
      model: opts.model,
      smallModel: opts.smallModel,
      logLevel: opts.logLevel,
      streaming: opts.streaming,
    });
  } catch (error) {
    console.error(`Erreur de configuration : ${error.message}`);
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case 'start':
      await start(config);
      break;
    case 'claude':
      await runClaude(config, opts);
      break;
    case 'doctor':
      await doctor(config, opts, envFile);
      break;
    case 'models':
      await models(config, opts);
      break;
    case 'env':
      printEnv(config, opts);
      break;
    default:
      console.error(`Commande inconnue : ${command}`);
      console.error(HELP);
      process.exitCode = 2;
  }
}

function parseArgs(argv) {
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
      case '--port':
        opts.port = takeValue();
        break;
      case '--host':
        opts.host = takeValue();
        break;
      case '--model':
        opts.model = takeValue();
        break;
      case '--small-model':
        opts.smallModel = takeValue();
        break;
      case '--log-level':
        opts.logLevel = takeValue();
        break;
      case '--no-stream':
        opts.streaming = false;
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
        throw new Error('utilise GROQ_API_KEY dans .env, jamais une clé en argument de commande');
      default:
        throw new Error(`option inconnue : ${name}`);
    }
    index += 1;
  }

  return opts;
}

async function start(config) {
  warnIfNoKey(config);
  const log = createLogger(config.logLevel);
  const server = createBridgeServer(config, { logger: log });

  let address;
  try {
    address = await listen(server, config.host, config.port);
  } catch (error) {
    console.error(`Impossible d'écouter sur ${config.host}:${config.port} : ${error.message}`);
    process.exitCode = 1;
    return;
  }

  printBanner(config, address);
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

async function runClaude(config, opts) {
  if (!config.apiKey) {
    console.error(
      'GROQ_API_KEY absente. Copie .env.example vers .env puis renseigne GROQ_API_KEY.',
    );
    process.exitCode = 1;
    return;
  }

  const port = opts.port !== undefined ? config.port : 0;
  const childConfig = {
    ...config,
    port,
    logLevel: process.env.LOG_LEVEL || 'warn',
  };
  const server = createBridgeServer(childConfig, { logger: createLogger(childConfig.logLevel) });

  let address;
  try {
    address = await listen(server, childConfig.host, port);
  } catch (error) {
    console.error(`Impossible de démarrer le proxy : ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const baseUrl = baseUrlFor(childConfig, address);
  const childEnv = claudeEnv(childConfig, baseUrl);
  const command = process.platform === 'win32' ? 'claude.cmd' : 'claude';

  console.error(`\n  ${SERVICE} → Claude Code`);
  console.error(`  proxy    ${baseUrl}`);
  console.error(`  modèle   ${childConfig.model}`);
  console.error(`  petit    ${childConfig.smallModel}`);
  console.error('  lancement de claude…\n');

  const child = spawn(command, opts.rest, { stdio: 'inherit', env: childEnv, shell: false });
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

async function doctor(config, opts, envFile) {
  const report = {
    node: process.version,
    project: PROJECT_ROOT,
    envFile: envFile || null,
    keyConfigured: Boolean(config.apiKey),
    keyMasked: maskKey(config.apiKey),
    upstream: config.groqBaseUrl,
    model: config.model,
    smallModel: config.smallModel,
    maxOutputTokens: config.maxOutputTokens,
    streaming: config.streaming,
    listen: `${config.host}:${config.port}`,
    claudeCode: findClaude(),
    warnings: [],
    models: null,
    chat: null,
  };

  if (!envFile) {
    report.warnings.push('Aucun fichier .env trouvé. Copie .env.example vers .env.');
  } else {
    const permissionWarning = checkSecretFilePermissions(envFile);
    if (permissionWarning) report.warnings.push(permissionWarning);
  }
  if (!config.apiKey) {
    report.warnings.push('GROQ_API_KEY absente : le proxy renverra une erreur 500.');
  }
  if (!report.claudeCode) {
    report.warnings.push(
      'Claude Code introuvable dans le PATH. Installe-le : npm install -g @anthropic-ai/claude-code',
    );
  }

  let exitCode = 0;
  if (config.apiKey) {
    try {
      const list = await listGroqModels(config, { timeoutMs: 15000 });
      report.models = list;
      const ids = new Set(list.map((model) => model.id));
      if (!ids.has(config.model)) {
        report.warnings.push(`Le modèle principal ${config.model} n'apparaît pas dans GET /models.`);
      }
      if (!ids.has(config.smallModel)) {
        report.warnings.push(`Le petit modèle ${config.smallModel} n'apparaît pas dans GET /models.`);
      }
    } catch (error) {
      report.modelsError = redactSecrets(error.message);
      exitCode = 1;
    }
  } else {
    exitCode = 1;
  }

  if (opts.chat && config.apiKey) {
    try {
      const response = await simpleChat(config, {
        model: config.model,
        prompt: 'Réponds uniquement : OK',
        maxTokens: 8,
      });
      report.chat = response?.choices?.[0]?.message?.content ?? response;
    } catch (error) {
      report.chatError = redactSecrets(error.message);
      exitCode = 1;
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
  console.log(`  .env        ${report.envFile || '(absent)'}`);
  console.log(`  Clé Groq    ${report.keyConfigured ? report.keyMasked : 'ABSENTE'}`);
  console.log(`  Endpoint    ${report.upstream}`);
  console.log(`  Modèle      ${report.model}`);
  console.log(`  Petit       ${report.smallModel}`);
  console.log(`  Streaming   ${report.streaming ? 'activé' : 'désactivé'}`);
  console.log(`  Écoute      ${report.listen}`);
  console.log(`  Claude Code ${report.claudeCode || 'introuvable'}`);
  console.log(`  Modèles     ${report.models ? `${report.models.length} disponibles` : 'non vérifiés'}`);
  if (report.chat) console.log(`  Test chat   ${JSON.stringify(report.chat)}`);
  if (report.modelsError) console.log(`  Erreur      ${report.modelsError}`);
  if (report.chatError) console.log(`  Erreur chat ${report.chatError}`);

  if (report.warnings.length) {
    console.log('\n  Avertissements :');
    for (const warning of report.warnings) console.log(`   ⚠ ${warning}`);
  }
  if (!config.apiKey) {
    console.log('\n  Prochaine étape :');
    console.log('    cp .env.example .env');
    console.log('    # édite GROQ_API_KEY dans .env (ne colle pas la clé dans le chat)');
    console.log('    npm run doctor -- --chat');
  }
  console.log('');
  process.exitCode = exitCode;
}

async function models(config, opts) {
  const list = await listGroqModels(config, { timeoutMs: 20000 });
  if (opts.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (!list.length) {
    console.log('Aucun modèle retourné par Groq.');
    return;
  }

  console.log(`\n  ${list.length} modèles Groq\n`);
  const rows = list
    .map((model) => {
      const known = KNOWN_MODELS[model.id];
      return {
        id: model.id,
        context: model.context_window || known?.context || '',
        tools: known ? (known.tools ? 'tools' : 'sans tools') : '—',
      };
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  for (const row of rows) {
    console.log(
      `  ${String(row.id).padEnd(40)} ${String(row.context).padStart(8)}  ${row.tools}`,
    );
  }
  console.log('');
}

function printEnv(config, opts) {
  const shell = normalizeShell(opts.shell || detectShell());
  const port = config.port === 0 ? 8787 : config.port;
  const baseUrl = `http://${displayHost(config.host)}:${port}`;
  const vars = claudeEnvVars(config, baseUrl, { maskSecret: true });

  if (shell === 'fish') {
    for (const [key, value] of Object.entries(vars)) {
      console.log(`set -gx ${key} ${quoteFish(value)}`);
    }
    return;
  }
  if (shell === 'powershell') {
    for (const [key, value] of Object.entries(vars)) {
      console.log(`$env:${key} = ${quotePowerShell(value)}`);
    }
    return;
  }
  for (const [key, value] of Object.entries(vars)) {
    console.log(`export ${key}=${quoteShell(value)}`);
  }
}

function claudeEnv(config, baseUrl) {
  return { ...process.env, ...claudeEnvVars(config, baseUrl) };
}

function claudeEnvVars(config, baseUrl, { maskSecret = false } = {}) {
  const authToken =
    config.proxyApiKey && maskSecret ? '<ton PROXY_API_KEY>' : config.proxyApiKey || 'local-groq-bridge';
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_API_KEY: authToken,
    ANTHROPIC_MODEL: config.claudeModel,
    ANTHROPIC_SMALL_FAST_MODEL: config.claudeSmallModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.claudeModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.claudeModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.claudeSmallModel,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
}

function printBanner(config, address) {
  const baseUrl = baseUrlFor(config, address);
  console.log(`\n  ${SERVICE} v${VERSION}`);
  console.log(`  écoute      ${baseUrl}`);
  console.log(`  modèle      ${config.model}`);
  console.log(`  petit       ${config.smallModel}`);
  console.log(`  clé Groq    ${config.apiKey ? `configurée ${maskKey(config.apiKey)}` : 'ABSENTE'}`);
  console.log(`  streaming   ${config.streaming ? 'activé' : 'désactivé (synthèse SSE)'}`);
  if (config.proxyApiKey) console.log('  auth proxy  activée');
  if (config.host === '0.0.0.0' || config.host === '::') {
    console.log('  ⚠ écoute sur toutes les interfaces : ne l’expose pas à Internet');
  }
  console.log('\n  Claude Code :');
  const vars = claudeEnvVars(config, baseUrl, { maskSecret: true });
  for (const [key, value] of Object.entries(vars)) {
    if (key === 'ANTHROPIC_BASE_URL' || key === 'ANTHROPIC_AUTH_TOKEN' || key === 'ANTHROPIC_MODEL') {
      console.log(`    export ${key}=${quoteShell(value)}`);
    }
  }
  console.log('\n  Puis, dans un autre terminal : claude\n');
}

function warnIfNoKey(config) {
  if (config.apiKey) return;
  console.error(
    '\n  ⚠ GROQ_API_KEY absente : le proxy démarre mais les requêtes renverront une erreur 500.\n' +
      '    cp .env.example .env   puis renseigne GROQ_API_KEY.\n',
  );
}

function findClaude() {
  const command = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr || '').trim() || 'présent';
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

import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse un fichier .env minimaliste (zéro dépendance).
 * Gère : commentaires, export, quotes simples/doubles, échappements de base.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else {
      const comment = value.indexOf(' #');
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Charge un .env sans écraser les variables déjà présentes (sauf override). */
export function loadEnvFile(file, { override = false } = {}) {
  if (!file || !fs.existsSync(file)) return false;
  const parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    // Une variable définie mais vide dans le shell ne doit pas empêcher
    // .env de fournir la valeur (cas fréquent : export GROQ_API_KEY=).
    if (override || process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
  return true;
}

/** Cherche .env dans le cwd puis à la racine du projet. */
export function findEnvFile(cwd = process.cwd(), projectRoot = null) {
  const candidates = [path.join(cwd, '.env')];
  if (projectRoot) candidates.push(path.join(projectRoot, '.env'));
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/**
 * Vérifie les permissions d'un fichier contenant des secrets.
 * Retourne null si tout va bien, sinon un avertissement lisible.
 */
export function checkSecretFilePermissions(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      return `${file} est lisible par d'autres utilisateurs (mode ${mode.toString(8)}). Fais : chmod 600 ${file}`;
    }
  } catch {
    return null;
  }
  return null;
}
